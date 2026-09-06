---
"effect-dynamodb": minor
"@effect-dynamodb/schema": minor
"@effect-dynamodb/geo": minor
"@effect-dynamodb/language-service": minor
---

Accept bound-client CRUD builders in `Batch.write`, `Transaction.transactWrite` and `EventStore.append({ additionalItems })`, and stop dropping their conditions (#100)

`db.entities.X.put(...)` / `.create(...)` / `.delete(...)` return `BoundPut` / `BoundDelete` builders, which the shared transactable-extraction protocol did not recognise. Every multi-item write path therefore rejected them with `ValidationError { entityType: "unknown" }`. This hit entities authored with the pure, AWS-free `@effect-dynamodb/schema` `Entity.make` hardest: a pure definition carries no CRUD ops, so the bound builder is the only write descriptor its author can hold — which made "commit a read model atomically with the events that produced it" impossible.

- `Entity.extractTransactable` now unwraps bound-CRUD builders to the `EntityOp` / `EntityDelete` they wrap. `TransactWriteOp` and `Batch.write`'s op union accept them at the type level.
- Conditions attached to a transact op are now compiled onto the `Put` / `Delete` instead of being silently discarded. This covers `.condition(...)`, `Entity.condition(...)`, and the implicit guards carried by `create()` (`attribute_not_exists`) and `deleteIfExists()` (`attribute_exists`) — previously `Transaction.transactWrite([Users.create(x)])` degraded to a blind overwrite.
- `ExpressionAttributeValues` is omitted when a condition carries no values; DynamoDB rejects an empty map, which could break `Transaction.check` with a value-free condition.
- `Batch.write` now fails with a `ValidationError` when given a conditioned op. `BatchWriteItem` has no `ConditionExpression`, so the alternative is writing unconditionally without telling the caller. Use `Transaction.transactWrite` for conditional writes.

`@effect-dynamodb/schema` is unchanged — it stays free of any AWS SDK dependency.
