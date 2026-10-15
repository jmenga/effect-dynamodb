---
"effect-dynamodb": minor
"@effect-dynamodb/schema": minor
"@effect-dynamodb/geo": minor
"@effect-dynamodb/language-service": minor
---

EventStore projection follow-ups ([#153](https://github.com/jmenga/effect-dynamodb/issues/153), [#154](https://github.com/jmenga/effect-dynamodb/issues/154), [#155](https://github.com/jmenga/effect-dynamodb/issues/155), [#156](https://github.com/jmenga/effect-dynamodb/issues/156)).

- **Multi-source projections:** `EventStore.multiProjection` maintains rows fed by several streams.
  - Each row keeps a checkpoint per source instance, in a map keyed `<source>#<streamId>`, or in per-source legacy fields recording their owning instance.
  - A second instance moves to the map, or fails with the new `ProjectionSourceConflict`.
  - Sources run in `fold` mode (gap-filled) or `latest` mode (newest event only, the rest `superseded`).
  - It provides `catchUp`, and `rebuild(rowKey, { instances })` as the repair path. `bindProjection` and `EventStore.processBatch` accept it next to single-source projections.
- **`revision`:** a library-owned write counter. Every write increments it and is conditioned on it, so concurrent writers from different sources serialise and `rebuild` is race-free. It is required by multi-source projections and the outbox, and is optional on `projection`.
- **Tombstones:** with `removal`, `evolve` may return `EventStore.removeRow`.
  - The row becomes a tombstone at its own key that keeps its checkpoints (with an optional TTL).
  - Entity `get`, `Batch.get` and `Transaction.transactGet` report the tombstone as absent.
- **Ordered outbox:**
  - Effects commit with the row in one `TransactWriteItems`, in the row's partition or in a separate table.
  - `drain` / `deliver` / `drainPending` deliver them strictly in order per row, at least once.
- **Polled change feed:** a new `effect-dynamodb/change-feed` subpath for consumers outside Lambda, with `@aws-sdk/client-dynamodb-streams` as an optional peer dependency.
  - `changeFeed` reads with shard lineage, iterator recovery and a fallback to a full `DescribeStream`.
  - `CheckpointStore` (memory or DynamoDB) records checkpoints, with a single-consumer lease.
  - `runChangeFeed` feeds `EventStore.processBatch`.
- **Also:**
  - `readFrom(…, { toVersion })`;
  - a projection read model defined before its table registration now resolves its table lazily.
