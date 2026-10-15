---
"effect-dynamodb": minor
"@effect-dynamodb/schema": minor
"@effect-dynamodb/geo": minor
"@effect-dynamodb/language-service": minor
---

EventStore change-feed projections (#151). `EventStore.projection({ stream, readModel, key, initial, evolve, checkpoint })` folds a stream's events from DynamoDB Streams into a read-model entity in version order, taking the order from the event store instead of from delivery. `applyBatch` sorts and deduplicates each stream instance's events, reads only the versions the batch lacks (one strongly consistent `readFrom`), and writes the row once, conditioned on its checkpoint; a lost race re-reads. Each outcome reports `applied` (at most once per event) and `alreadyApplied` (republish for at-least-once). Also: `apply`, `catchUp`, `rebuild`, `processBatch` (decode → apply → partial batch response), `bindProjection` (`R = never`), a checkpoint `offset`, `EventStore.decoder` across several streams, `EventStore.eventFilterPattern` for event source mapping and Pipe filters, and `EventStore.batchResponse` keyed by `dynamodb.SequenceNumber` (Lambda) or `eventID` (Pipes). Streams expose `streamIdFields`, `eventMarker` and `parseStreamId`. New codes `[EDD-9081]`–`[EDD-9083]`.
