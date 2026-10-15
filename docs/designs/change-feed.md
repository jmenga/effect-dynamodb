# Design: a polled change-feed `Stream` for consumers outside Lambda (#156)

## 1. Summary

Outside Lambda and EventBridge Pipes — a long-running service, a container,
an edge device running DynamoDB Local — a consumer polls DynamoDB Streams
itself, and each one hand-rolls shard discovery, lineage, iterators and
checkpointing. This adds an Effect `Stream` over a table's change feed whose
batches feed 1.28.0's projections (`EventStore.processBatch`) unchanged.

It ships as a subpath, `effect-dynamodb/change-feed`, so core consumers pay
nothing:

| API | Purpose |
|---|---|
| `DynamoStreamsClient` | `Context.Service` wrapping `DescribeStream`, `GetShardIterator`, `GetRecords`, `ListStreams`; `layer(config)` / `layerConfig(config)` |
| `CheckpointStore` | `Context.Service` holding per-shard checkpoints and the feed's lease; `CheckpointStore.layerMemory` and `CheckpointStore.layerDynamoDB({ tableName })` |
| `CheckpointStore.tableDefinition(tableName)` | the `CreateTable` input of the checkpoint table |
| `changeFeed({ streamArn, consumer?, startingPosition?, pollInterval?, batchSize?, describeInterval?, backoff?, lease? })` | `Stream<ChangeFeedBatch, ChangeFeedError, DynamoStreamsClient \| CheckpointStore>` |
| `batch.commit()` / `batch.complete(response)` | acknowledge a batch: commit its checkpoint, or the checkpoint before the earliest failure (Lambda's `batchItemFailures` contract) |
| `runChangeFeed(feed, { projections, streams?, ...processBatch options })` | the sink: `EventStore.processBatch(batch.records, { source: "lambda" })`, then `batch.complete(result.response)` |

`@aws-sdk/client-dynamodb-streams` is an optional peer dependency. Only the
subpath imports it; a guard test keeps it out of the main entry's import graph.

Not in this cut (follow-up issues):
- per-shard leases and rebalancing across several consumer processes;
- Kinesis Data Streams for DynamoDB as a source (its records already reach
  `processBatch` through Lambda or a Pipe);
- a retry limit / dead-letter destination for a batch that keeps failing.

## 2. Shards and lineage

DynamoDB Streams splits a table's feed into shards. A shard lives about four
hours, then closes (it gains an `EndingSequenceNumber`), and a child shard —
`ParentShardId` naming it — continues the same partition's records. Records of
one item are ordered within a shard and from a parent into its child.

- **Discovery.** At start, a full `DescribeStream`, paginated by
  `ExclusiveStartShardId`. Every `describeInterval` (default 30 s) the full
  describe runs again to pick up new shards.
- **Children.** When a shard is drained, its children are looked up at once
  with `DescribeStream({ ShardFilter: { Type: "CHILD_SHARDS", ShardId } })`.
  A store that rejects `ShardFilter` (`ValidationException`) is remembered,
  and every later lookup uses a full describe instead. Either way, the result
  is filtered by `ParentShardId`, so a store that ignores the filter is safe.
- **Parent before child.** A shard starts only when its parent is finished,
  or its parent is not in the describe output (trimmed past retention).
  DynamoDB shards only split, never merge, so each has at most one parent.
- **Closed shards.** A `GetRecords` with no `NextShardIterator` means the shard
  is closed and fully read. Once its last batch is acknowledged, the shard is
  checkpointed as `Finished` and dropped, and its children become eligible.
- **The feed ends** when a describe reports the stream `DISABLED` and every
  shard is finished (a disabled stream's shards all close). Otherwise it runs
  until interrupted.

## 3. Iterators and positions

- A shard with a checkpoint resumes `AFTER_SEQUENCE_NUMBER` its sequence
  number. A `Finished` checkpoint skips the shard.
- A shard without one starts at `TRIM_HORIZON`, except at a **fresh** start
  (the consumer has no checkpoints for the stream) with
  `startingPosition: "LATEST"`: then the shards open at that moment start at
  `LATEST`, and the closed ones are checkpointed `Finished` without being read.
  Children found later always start at `TRIM_HORIZON` — their records follow
  the parent's. A shard that started at `LATEST` and never committed reads
  from `TRIM_HORIZON` after a restart (or from `LATEST` again, if the consumer
  committed nothing at all) — as KCL does.
- **Expired iterators** (`ExpiredIteratorException`, after 15 minutes — a slow
  consumer) are re-acquired from the shard's position: after the last
  acknowledged record, or the original starting position before any.
- **Trimmed data** (`TrimmedDataAccessException`: the checkpoint is older than
  the 24-hour retention) fails the feed with `ChangeFeedTrimmed { streamArn,
  shardId, sequenceNumber }` — records were lost, and only the operator can
  decide what to do (rebuild the read models, then clear the checkpoints).

## 4. Batches and checkpoints

A shard's reader fetches up to `batchSize` records (`GetRecords.Limit`, default
100, at most 1000), emits them as one `ChangeFeedBatch`, and **waits for the
batch to be acknowledged** before reading again. So each shard has at most one
batch in flight, its batches are processed in order, and a slow consumer slows
polling (pull-based backpressure). Shards are read concurrently.

```ts
interface ChangeFeedBatch {
  readonly streamArn: string
  readonly shardId: string
  readonly records: ReadonlyArray<ChangeFeedRecord> // non-empty, sequence order
  readonly firstSequenceNumber: string
  readonly lastSequenceNumber: string
  readonly commit: () => Effect<void, CheckpointStoreError>
  readonly complete: (response: BatchItemFailuresResponse) => Effect<void, CheckpointStoreError>
}
```

- `commit()` writes the shard's checkpoint at `lastSequenceNumber`; the reader
  continues.
- `complete(response)` takes a partial batch response whose identifiers are
  `SequenceNumber`s (`source: "lambda"`). No failures: `commit()`. Otherwise
  the checkpoint moves to the record **before** the earliest failed record (it
  stays put when that is the first record), and the shard re-reads from the
  failed record (`AT_SEQUENCE_NUMBER`) after a backoff that grows with each
  consecutive failure. An identifier that names no record of the batch fails
  the whole batch — Lambda's rule.
- The checkpoint is committed only by the acknowledgement, so it follows the
  consumer's effect. A consumer that fails ends the stream, and the records it
  had not acknowledged are read again on restart: delivery is **at least
  once**.
- Only the first acknowledgement of a batch counts.

`ChangeFeedRecord` is the SDK's `GetRecords` record. It has the Lambda record's
shape (`eventID`, `eventName`, `dynamodb.SequenceNumber`, `dynamodb.NewImage`
as DynamoDB JSON with `B` as bytes), which `EventStore.processBatch` and the
stream image decoders already accept.

## 5. Throttling and transient errors

`LimitExceededException` / `ThrottlingException` /
`ProvisionedThroughputExceededException` map to `ThrottlingError`;
`InternalServerError` to `InternalServerError`. Every `DescribeStream`,
`GetShardIterator` and `GetRecords` call retries those two without limit, on a
jittered exponential backoff (`backoff: { initial: 100 ms, max: 10 s }` by
default). One reader per shard keeps within the two-readers-per-shard
guidance. An idle shard (an empty `GetRecords` on an open shard) polls again
after `pollInterval` (default 1 s).

## 6. The lease (single consumer per stream)

One lease item per `(consumer, streamArn)` in the checkpoint store keeps two
processes from consuming the same feed by accident:

- acquired at start — conditional on no lease, an expired one, or our own;
- renewed every `renewEvery` (default a third of `duration`, 30 s by default);
- released when the stream ends;
- a second consumer fails with `ChangeFeedLeaseHeld { owner, expiresAt }`, or
  with `lease: { onHeld: "wait" }` retries until the lease is free or expires;
- a failed renewal (another owner took over) fails the feed with
  `ChangeFeedLeaseLost`.

Expiry compares the holder's clock with the taker's, so hosts need roughly
synchronised clocks. The lease guards against an accidental second consumer;
checkpoint writes are not fenced by it. `lease: false` disables it.

## 7. Checkpoint store

```ts
interface CheckpointStoreService {
  load(feed: FeedId): Effect<ReadonlyMap<string, ShardCheckpoint>, CheckpointStoreError>
  commit(feed: FeedId, shardId: string, checkpoint: ShardCheckpoint): Effect<void, CheckpointStoreError>
  acquireLease(feed, owner, duration): Effect<void, ChangeFeedLeaseHeld | CheckpointStoreError>
  renewLease(feed, owner, duration): Effect<void, ChangeFeedLeaseLost | CheckpointStoreError>
  releaseLease(feed, owner): Effect<void, CheckpointStoreError>
}
type FeedId = { readonly streamArn: string; readonly consumer: string }
type ShardCheckpoint =
  | { readonly _tag: "Sequence"; readonly sequenceNumber: string }
  | { readonly _tag: "Finished" }
```

`consumer` (default `"default"`) names the application consuming the feed, so
two different consumers of one stream can share a checkpoint table.

- **In memory** (`layerMemory`): a map per layer; the lease is process-local.
- **DynamoDB** (`layerDynamoDB({ tableName })`, needs `DynamoClient`): one
  table, `pk` (S, HASH) + `sk` (S, RANGE):

  | Item | `pk` | `sk` | Attributes |
  |---|---|---|---|
  | shard checkpoint | `<consumer>#<streamArn>` | `shard#<shardId>` | `sequenceNumber` (S) or `finished` (BOOL), `updatedAt` (N, epoch ms), `ttl` (N, epoch s — `Finished` only, two days out) |
  | lease | `<consumer>#<streamArn>` | `lease` | `owner` (S), `expiresAt` (N, epoch ms) |

  `load` is a strongly consistent `Query` on the partition. `Finished` items
  carry a `ttl` two days out (a closed shard leaves the stream after 24 h); a
  sequence checkpoint never expires, so a consumer down past retention still
  gets `ChangeFeedTrimmed` instead of silently restarting at the trim horizon.
  Enabling TTL on `ttl` is optional. `CheckpointStore.tableDefinition(name)`
  returns the `CreateTable` input (on-demand billing).

## 8. Errors

All `Data.TaggedError`s, in the subpath (they are only raised there; the
AWS-free schema package is untouched):

| Error | Raised by |
|---|---|
| `ShardIteratorExpired`, `StreamDataTrimmed` | `DynamoStreamsClient` (beside the shared `DynamoError`, `ThrottlingError`, `DynamoValidationError`, `InternalServerError`, `ResourceNotFoundError`) |
| `ChangeFeedTrimmed` | the feed, for a trimmed shard position |
| `ChangeFeedLeaseHeld`, `ChangeFeedLeaseLost` | lease acquisition / renewal |
| `CheckpointStoreError` | a checkpoint store operation |

## 9. Tests

- Unit (mocked `DynamoStreamsClient`, in-memory store, `TestClock`): discovery
  with and without `ShardFilter`, parent before child across a split,
  closed-shard retirement and stream end, resume from a checkpoint
  (`AFTER_SEQUENCE_NUMBER`), `LATEST` at a fresh start, expired-iterator
  re-acquisition, trimmed → `ChangeFeedTrimmed`, partial-failure checkpoint
  placement and re-read, lease held / waited / expired / lost, throttling
  backoff, the DynamoDB store against a mocked `DynamoClient`.
- Connected (DynamoDB Local's Streams API): discovery, end-to-end projection
  through `runChangeFeed`, resume after a restart from the DynamoDB checkpoint
  store, lease contention, and closed-shard retirement by disabling the
  stream. DynamoDB Local never splits a shard (by volume or time), so
  parent-before-child across a split is covered by the unit suite only.
