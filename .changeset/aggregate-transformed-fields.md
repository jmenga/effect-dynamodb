---
"effect-dynamodb": minor
"@effect-dynamodb/schema": minor
"@effect-dynamodb/geo": minor
"@effect-dynamodb/language-service": minor
---

Aggregates round-trip fields with a schema transformation

An aggregate whose model carried a transformed field could not round-trip: the write path stored Type-side values, so a `bigint` landed as `{"N":"5"}` and assembly's `Schema.BigIntFromString` decode rejected a number. Aggregate attributes are now encoded to their wire form before marshalling, at the root, sub-aggregate roots, `one` edges, `many` elements and propagated context values.

Two further causes are fixed with it:

- **`fieldsOf` did not see through `DynamoModel.configure`**, so any edge whose model is configured — which is most, since `identifier: true` requires it — received **no encoders at all**. Dates on those edges were stored as `{"M":{…}}` or `{"M":{}}`, meaning the date handling added in #72 was silently not applying to them.
- **`aggregate.update` recognised only date transforms** when re-decoding mutated state, so a non-date transform was rejected before any item was built — even when the mutation touched only an untransformed field. The tolerance now covers every leaf transform, and remains scoped to the aggregate decode path: entities pass no such option.

Only `BigIntFromString` and `NumberFromString` attributes change on the wire, and both were unreadable before, so **no migration is required**. Composed keys are byte-identical.
