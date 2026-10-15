# Design: change-feed projections with gap-filling from the event store (#151)

## 1. Summary

DynamoDB Streams orders records per item only, and the records of one
transaction carry no grouping or order. An `EventStore` stream stores every
event as its own item, so a read model folded from the change feed sees
version `n` before `n − 1` whenever the feed reorders. The usual answer is to
wait for the predecessor's delivery. That answer stalls whenever `n − 1` is
queued behind `n` on the same lane, until the record is dead-lettered.

This adds projections that take their order from the event store, not from
delivery:

| API | Purpose |
|---|---|
| `EventStore.projection({ stream, readModel, key, initial, evolve, checkpoint })` | one source stream → one read-model row per stream instance |
| `projection.applyBatch(events)` / `apply(event)` | order, deduplicate, gap-fill from the store, fold, write once per instance |
| `projection.catchUp(streamId)` / `rebuild(streamId)` | bring a row to the head / re-derive it from version 1 |
| `projection.processBatch(records, { source })` | decode a raw batch → `applyBatch` → `batchItemFailures` |
| `EventStore.bindProjection(projection)` | the same operations with `R = never` |
| `EventStore.decoder(streams)` | one image decoder dispatching across several streams |
| `EventStore.eventFilterPattern(streams)` | the ESM / Pipe filter pattern for those streams' event `INSERT`s |
| `EventStore.batchResponse(failedRecords, { source })` | the partial batch response, keyed by `SequenceNumber` (Lambda) or `eventID` (Pipes) |
| `stream.parseStreamId(id)` / `stream.streamIdFields` | recover the structured stream id from `StreamEvent.streamId` |

Not in this cut (follow-up issues):
- read models fed by several streams (per-source checkpoints);
- row deletion;
- an ordered outbox;
- a polled change-feed `Stream`.

## 2. Why the store can fill every gap

`append` is a single `TransactWriteItems` with a version-contiguity check.
When version `n` has a stream record, the transaction that wrote it has
committed, and so has every version before it. A strongly consistent
`readFrom(c)` therefore returns `c + 1 … n` with no holes. Events are
immutable, so a copy from the batch and a copy read from the store are
interchangeable.

## 3. Definition

```ts
const OrderSummaryProjection = EventStore.projection({
  stream: OrderEvents,                        // an unbound EventStream
  readModel: OrderSummaries,                  // an unbound Entity
  key: (streamId) => ({ orderId: streamId.orderId }),
  initial: (streamId) => ({ orderId: streamId.orderId, status: "new", total: 0, version: 0 }),
  evolve: (state, event) => Effect.succeed(next(state, event)),
  checkpoint: "version",                      // or { field: "version", offset: -1 }
  retry: 5,                                   // optional: lost-race retries (default 5)
})
```

- **`streamId`** in `key` and `initial` is the structured `StreamIdInput`.
  `StreamEvent.streamId` is the composites joined with `#`. The projection
  recovers the fields with `stream.parseStreamId`, which splits on `#` and
  checks the part count. Any `#` inside a value adds a part, so an equal count
  is unambiguous. A mismatch (a value containing `#` on a multi-field id)
  fails with `ValidationError`. A single-field id is the whole string.
- **State** is the read model's model type (`Entity.Model<RM>`). `initial`
  and `evolve` produce it, and the row is written with `put` and read with a
  strongly consistent `get`.
- **`checkpoint`** names a numeric model field. The library sets it after the
  fold; `evolve` never has to. With `{ field, offset }` the field stores
  `version + offset`. Reads subtract the offset, and writes and the condition
  add it, so a read model that numbered versions from 0 (`offset: -1`) keeps
  its stored values.
- **`evolve`** returns `Effect<State, E, R>`. Its typed failure fails that
  instance only. Returning the state unchanged ignores an event, and the
  checkpoint still advances.
- **The projection owns the row:** `put` replaces it whole.
- **Refused read models** (`[EDD-9081]`, defects at construction):
  - `versioned` read models: the checkpoint is the version, and a versioned
    put adds its own lock;
  - `softDelete` read models (there is no deletion in this cut);
  - `timeSeries` read models, whose writes are `append`, not `put`;
  - a `checkpoint` field the model doesn't have;
  - an `offset` that isn't an integer.

## 4. `applyBatch(events, options?)`

Input: one batch's decoded events of this stream, in delivery order.
Instances run concurrently (`options.concurrency`, default 10). Per instance
(`streamId`):

1. **Group** the instance's events, keep their delivery positions, sort them
   by version and deduplicate.
2. **Read the row** (strongly consistent `get`). Its checkpoint is `c`, or 0
   with no row. Events at `version ≤ c` go to `alreadyApplied`. With none
   left, the instance is done (no write).
3. **Fill gaps.** If the remaining versions are exactly `c + 1 … max`, there
   is no read. Otherwise one strongly consistent `readFrom(c)` runs, and its
   events up to `max` are used. A run that still isn't contiguous (impossible
   under §2 unless the stream was written outside `append`) fails with
   `ValidationError`.
4. **Fold** from the row (or `initial(streamId)`) through `evolve`, then set
   the checkpoint to `max + offset`.
5. **Write once:**
   - with a row: `put(state)` conditioned on `checkpoint = c + offset`;
   - without one: `create(state)` (`attribute_not_exists`).
6. **Lost race** (`ConditionalCheckFailed` from that condition): back to
   step 2, under the `retry` policy. Exhausted, it fails with
   `ConcurrentModification` (`attributes: [field]`). After a re-read, the
   events the winner applied move to `alreadyApplied`.

**Output: `ProjectionBatchResult`.**
- `outcomes` lists the instances in first-delivery order:
  - `Applied`: `{ streamId, positions, applied, alreadyApplied, state, version }`;
  - `Failed`: `{ streamId, positions, error }`.
- `failedPositions` holds the earliest delivered position of each failed
  instance.
- The effect itself never fails. Per-instance errors are values, so one
  instance can't hide the others' `applied` (side effects must still run for
  them).

`apply(event)` is `applyBatch([event])`, with the single outcome lifted into
the error channel: `Effect<ProjectionApplied, ProjectionError<E>, R>`.

**Side-effect contracts.**
- `applied` is at most once. Exactly one invocation's conditional write
  includes each event, and a crash after the write loses that invocation's
  publication.
- `alreadyApplied` lets a caller opt into at least once: it republishes them
  on a redelivery, and consumers tolerate the duplicates.
- Ordering holds within one invocation's run, not across invocations.

## 5. `catchUp(streamId)` and `rebuild(streamId)`

- **`catchUp`** is step 2 onward with no batch events: one strongly consistent
  `readFrom(c)` to the head. It returns `ProjectionApplied` (`applied` is what
  it folded, and `alreadyApplied` is empty). It repairs a row whose last event
  was dead-lettered.
- **`rebuild`** reads the row (for its condition only) and the whole stream
  (strongly consistent), then folds from `initial` to the head. It writes
  conditioned as in §4 and retries on a lost race. It returns
  `{ state: Option<State>, version }` and never `applied`, so a rebuild can't
  replay side effects. An empty stream writes nothing (`Option.none()`). A
  stream snapshot is decider state, not read-model state, so neither path
  reads it.

## 6. Decoding, filtering and batch responses

- **`EventStore.decoder(streams)`** builds a map from each stream's
  `__edd_e__` event marker (`<streamname>.event`, lower-cased) to the stream.
  `decode(image)` reads the marker off the raw image:
  - an unknown marker gives `Option.none()`;
  - otherwise it delegates to that stream's `decodeStreamImage` and returns
    `{ stream: name, event }`, typed as a union over the streams.

  Two streams with the same marker are an `[EDD-9082]` defect. A stream
  declares the event marker publicly as `stream.eventMarker`.
- **`EventStore.eventFilterPattern(streams)`** returns
  `{ eventName: ["INSERT"], dynamodb: { NewImage: { __edd_e__: { S: [...markers] } } } }`,
  to `JSON.stringify` into `FilterCriteria.Filters[].Pattern` of an event
  source mapping or a Pipe.
- **`EventStore.batchResponse(failedRecords, { source })`** returns
  `{ batchItemFailures: [{ itemIdentifier }] }`:
  - with `"lambda"`, `itemIdentifier` is `record.dynamodb.SequenceNumber`;
  - with `"pipe"`, it is `record.eventID`.

  A record without its identifier is an `[EDD-9083]` defect (for example, a
  Pipe input template that drops `eventID`). Silently returning an empty
  identifier would fail the whole batch. Records are structural
  (`StreamRecord`), so there is no `aws-lambda` dependency.
- **`projection.processBatch(records, { source, concurrency? })`**:
  1. Skips records that aren't `INSERT`s and images that aren't this stream's
     events.
  2. Decodes the rest; a record that fails to decode fails itself.
  3. Runs `applyBatch`.
  4. Builds `failedRecords`: the earliest-delivered record of each failed
     instance, plus each undecodable record.

  It returns `{ outcomes, failedRecords, response }`. Lambda checkpoints at
  the lowest reported `SequenceNumber` and retries from there, so naming the
  earliest record per failed instance is enough. A caller that fails its own
  side effects adds those records and calls `batchResponse` again.

## 7. Execution and requirements

- An unbound projection's operations need `DynamoClient | TableConfig` (the
  stream's table and the read model's, as with `EventStream`), plus `R` from
  `evolve`.
- `EventStore.bindProjection(projection)` captures that context, including a
  `Compression` registry for packed event data, and returns the same
  operations with `R = never`.
- `processBatch` decodes through the stream's own `decodeStreamImage`.

## 8. Tests

Unit tests (`EventStore.projection.test.ts`, an in-memory mock `DynamoClient`):
- in order, reversed, duplicates, a redelivery (`alreadyApplied`), and a gap
  (one `readFrom`, none when the batch is contiguous);
- an interior hole;
- a lost race (another writer advances the row between the read and the
  write);
- retry exhaustion;
- `evolve` failure isolated to its instance;
- offset;
- the multi-field stream id and its `#` ambiguity;
- `catchUp`, `rebuild`, and an empty-stream `rebuild`;
- `decoder` dispatch and none, `eventFilterPattern`, and `batchResponse` per
  source and missing identifiers;
- `processBatch` positions, the `[EDD-9081]`–`[EDD-9083]` defects, and
  `bindProjection`.

Connected tests (`connected.eventstore-projection.test.ts`, DynamoDB Local):
- a real stream on one table and a read model on another;
- Lambda-shaped records built from scanned items, delivered reversed and split
  across batches;
- concurrent `applyBatch` calls racing on one instance (each event applied
  exactly once);
- offset;
- `catchUp` / `rebuild`;
- `processBatch` with a poison record.
