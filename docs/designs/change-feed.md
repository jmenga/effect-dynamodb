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
  and every later lookup uses a full describe instead; a filtered lookup that
  finds no child yet (DynamoDB Local accepts the filter and returns nothing)
  also falls back to a full describe. Either way, the result is filtered by
  `ParentShardId`, so a store that ignores the filter is safe.
- **Shared describes.** A drained shard that falls back does not describe the
  stream itself: it wakes the describer, which runs the next full describe at
  once and at most once per `pollInterval` for such wake-ups, so shards drained
  together (a disabled stream's, say) share one describe instead of one each.
- **Pruning.** A full describe forgets finished shards that have left the
  stream, so a long-running feed does not accumulate them.
- **Parent before child.** A shard starts only when its parent is finished,
  or its parent is not in the describe output (trimmed past retention).
  DynamoDB shards only split, never merge, so each has at most one parent.
- **Gone shards at startup.** A parent missing from the describe output is
  only safe to skip when this consumer owes it nothing, and a describe may be
  inconsistent. So a shard missing at startup — a `Sequence`-checkpointed one,
  or the unfinished parent of a listed shard without a checkpoint — is
  confirmed gone first: the stream is described once more, and a shard still
  missing is probed with `GetShardIterator(TRIM_HORIZON)`. Not found
  (`ResourceNotFoundException`) or trimmed means gone; an iterator means it is
  still there, and it is read like any other shard — a parent before its
  children (from its checkpoint, or its trim horizon). At a **fresh** start, a
  confirmed-gone parent predates the consumer: it is checkpointed `Finished`,
  so a restart can tell it from a lost one. At a restart, the feed fails with `ChangeFeedTrimmed` before reading anything
  when a shard with a `Sequence` checkpoint is no longer listed (downtime past
  retention dropped its unread tail), or a listed shard without a checkpoint
  has a missing parent that is not `Finished`. A shard read to its end whose
  `Finished` write was lost is reported too: once unlisted, it can't be told
  apart.
- **Missing iterators.** A `GetShardIterator` without an iterator refreshes the
  shard list: a closed shard is finished; a shard still open is retried after
  a backoff (it is never checkpointed `Finished` while open); a shard no
  longer listed fails with `ChangeFeedTrimmed`.
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
polling (pull-based backpressure). Shards are read concurrently: each has its
own reader, and `maxConcurrentReads` (default 16) bounds the `GetShardIterator`
/ `GetRecords` calls in flight across them. A permit is held for one call only
(not across a backoff or while a batch awaits its acknowledgement), so a bound
below the number of open shards slows reading but starves no shard.

```ts
interface ChangeFeedBatch {
  readonly streamArn: string
  readonly shardId: string
  readonly records: ReadonlyArray<ChangeFeedRecord> // non-empty, sequence order
  readonly firstSequenceNumber: string
  readonly lastSequenceNumber: string
  readonly commit: () => Effect<void, CheckpointStoreError | ChangeFeedLeaseLost>
  readonly complete: (
    response: BatchItemFailuresResponse,
  ) => Effect<void, CheckpointStoreError | ChangeFeedLeaseLost>
}
```

- `commit()` writes the shard's checkpoint at `lastSequenceNumber`; the reader
  continues.
- `complete(response)` takes a partial batch response whose identifiers are
  `SequenceNumber`s (`source: "lambda"`). No failures: `commit()`. Otherwise
  the checkpoint moves to the record **before** the earliest failed record (it
  stays put when that is the first record), and the shard re-reads from the
  failed record (`AT_SEQUENCE_NUMBER`) after a backoff that grows with each
  consecutive failure. If any identifier names no record of the batch, the
  whole batch fails — Lambda's rule — whatever the other identifiers say.
- The checkpoint is committed only by the acknowledgement, so it follows the
  consumer's effect. A consumer that fails ends the stream, and the records it
  had not acknowledged are read again on restart: delivery is **at least
  once**.
- Acknowledgements of a batch run one at a time, and the first whose
  checkpoint write succeeds settles it; later ones are no-ops. A write that
  fails leaves the batch unsettled and returns `CheckpointStoreError`, so a
  retried acknowledgement writes again; the shard waits meanwhile, and a
  consumer that lets the error fail its effect ends the feed.
- Once the lease is lost (§6), an acknowledgement fails with
  `ChangeFeedLeaseLost` and writes nothing.

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
default). One reader per shard per feed. AWS advises at most two simultaneous readers of a shard, and every reader of the stream counts — each feed `consumer`, Lambda event source mapping or Pipe — so keep the stream to two of them in total; more are throttled (and back off), not refused. An idle shard (an empty `GetRecords` on an open shard) polls again
after `pollInterval` (default 1 s).

## 6. The lease (single consumer per stream)

One lease item per `(consumer, streamArn)` in the checkpoint store keeps two
processes from consuming the same feed by accident:

- acquired at start — conditional on no lease, an expired one, or our own;
- renewed every `renewEvery` (default a third of `duration`, 30 s by default);
  `renewEvery` must be less than half of `duration` — `changeFeed` throws
  `[EDD-9083]` otherwise — so that a renewal the store fails to write has
  `duration − 2 × renewEvery` to be retried in before the deadline below;
- released when the stream ends;
- a second consumer fails with `ChangeFeedLeaseHeld { owner, expiresAt }`, or
  with `lease: { onHeld: "wait" }` retries until the lease is free or expires;
- a renewal the store fails to write (`CheckpointStoreError`) is retried on
  the backoff until `renewEvery` before the lease would lapse (the last
  successful renewal + `duration` − `renewEvery`), then fails the feed with
  that error; a renewal refused because another owner took over fails the feed
  with `ChangeFeedLeaseLost`;
- either way the lease counts as lost from then on: an acknowledgement still
  in flight fails with `ChangeFeedLeaseLost` instead of committing.

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

The store comes from the context (`R` of the feed) rather than a `checkpoints`
option, so it is chosen by layer like every other service — a test swaps in
`layerMemory`, a deployment `layerDynamoDB`.

- **In memory** (`layerMemory`): a map per layer; the lease is process-local.
- **DynamoDB** (`layerDynamoDB({ tableName })`, needs `DynamoClient`): one
  table, `pk` (S, HASH) + `sk` (S, RANGE):

  | Item | `pk` | `sk` | Attributes |
  |---|---|---|---|
  | shard checkpoint | `<consumer>#<streamArn>` | `shard#<shardId>` | `sequenceNumber` (S) or `finished` (BOOL), `updatedAt` (N, epoch ms), `ttl` (N, epoch s — `Finished` only, two days out) |
  | lease | `<consumer>#<streamArn>` | `lease` | `owner` (S), `expiresAt` (N, epoch ms) |

  `load` is a strongly consistent `Query` on the partition. `Finished` items
  carry a `ttl` `finishedTtl` out (default two days). `finishedTtl` must be at
  least 28 hours — `layerDynamoDB` / `makeDynamoDB` throw `[EDD-9084]` below
  it: a closed shard stays listed 24 h after closing, and the children of a
  parent already gone at a fresh start stay listed for up to a shard's
  lifetime (about 4 h) plus those 24 h; a `Finished` checkpoint expired sooner
  would make a restart report lost records that were not lost. A
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
