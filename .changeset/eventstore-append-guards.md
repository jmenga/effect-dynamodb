---
"effect-dynamodb": minor
"@effect-dynamodb/schema": minor
"@effect-dynamodb/geo": minor
"@effect-dynamodb/language-service": minor
---

EventStore: guard `append` against TransactWriteItems limits and expectedVersion-ahead version gaps (#82)

- New `AppendTooLarge` tagged error and `TRANSACT_WRITE_ITEMS_LIMIT` constant, exported from both `@effect-dynamodb/schema` and `effect-dynamodb`. `append` now pre-validates the transact-item count and fails with `AppendTooLarge` before issuing any request instead of surfacing a raw AWS validation error. The batch is deliberately never chunked — chunking would break append atomicity.
- `append` now enforces version contiguity. When `expectedVersion > 0` the transaction carries a `ConditionCheck` requiring the event at exactly `expectedVersion` to exist, so an *ahead* expected version fails with `VersionConflict` instead of silently writing past the stream head and leaving a permanent gap in the version sequence. The check occupies one transact item, so a single append holds up to 100 events at `expectedVersion === 0` and up to 99 otherwise.
