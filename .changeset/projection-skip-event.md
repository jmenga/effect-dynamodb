---
"effect-dynamodb": minor
"@effect-dynamodb/schema": minor
"@effect-dynamodb/geo": minor
"@effect-dynamodb/language-service": minor
---

A projection's `evolve` can now return `EventStore.skipEvent` to leave the row alone (#162), in `EventStore.projection` and in every `multiProjection` source, with no option to enable it.

- A skipped event is reported in a new `skipped` array, on instance results, `ProjectionApplied`, `ProjectionCaughtUp` and `ProjectionRebuiltRow`. It is never in `applied`, and it produces no outbox effects.
- A row whose events are all skipped (or already applied) isn't written, and its revision and checkpoints stay as read. A mixed batch is still one write.
- An instance's checkpoint stops at its last applied or rejected event. A skipped event above it is read and decided again by the next gap-fill, redelivery or `catchUp`.
- In `"latest"` mode, a skip falls back to the next older event, as a rejection does.
- An unowned field-mapped checkpoint is now adopted by the first instance of its source that writes it. Previously the first instance in fold order took it even when every one of its events was skipped, or it failed. In that case the claim wasn't written, but the next instance was still sent to the map, or failed with `ProjectionSourceConflict`.
