---
"effect-dynamodb": minor
"@effect-dynamodb/schema": minor
"@effect-dynamodb/geo": minor
"@effect-dynamodb/language-service": minor
---

Accept bound-client CRUD builders in `Batch.write`, `Transaction.transactWrite` and `EventStore.append({ additionalItems })`, and stop silently reinterpreting ops (#100)

`db.entities.X.put(...)` returns a `BoundPut`, which the shared transactable-extraction protocol did
not recognise — every multi-item write path rejected it with `ValidationError { entityType: "unknown" }`.
This blocked entities authored with the pure, AWS-free `@effect-dynamodb/schema` `Entity.make`
entirely: a pure definition carries no CRUD ops, so the bound builder is the only write descriptor
its author can hold, which made "commit a read model atomically with the events that produced it"
impossible. `extractTransactable` now unwraps bound builders to the intermediate they wrap.

**Conditions on transact items are no longer silently dropped.** `.condition(...)`,
`Entity.condition(...)`, and the implicit guards carried by `create()` (`attribute_not_exists`) and
`deleteIfExists()` (`attribute_exists`) are compiled onto the `Put` / `Delete`. Previously
`Transaction.transactWrite([Users.create(x)])` degraded to a blind overwrite.
`ExpressionAttributeValues` is omitted when a condition carries no values, which also fixes
`Transaction.check` with a value-free condition.

**Ops the compile path cannot reproduce faithfully are rejected rather than reinterpreted.**
`upsert` is an `UpdateItem` using `if_not_exists` for `createdAt`, immutable fields and the version
counter — compiling it as a `Put` reset all three, including silently resetting the optimistic-lock
counter. It now fails with a `ValidationError` on all three paths, as do entities configured with
`refs`, `generatedId` or `vectorIndexes`, whose write contracts need a read, `Crypto` or an
`Embedder`. `Batch.write` additionally rejects any conditioned op (`BatchWriteItem` has no
`ConditionExpression`) and now reports unsupported ops on the error channel instead of as an
untyped defect.

Known gap, unchanged and now documented: entities with `unique`, `versioned: { retain: true }` or
`softDelete` still write a single item through these paths, so their sentinel, snapshot or tombstone
is not written. Prefer the entity's own operation for those. Tracked in #113.

`@effect-dynamodb/schema` is unchanged and remains free of any AWS SDK dependency.
