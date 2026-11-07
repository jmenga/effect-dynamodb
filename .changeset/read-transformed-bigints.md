---
"effect-dynamodb": minor
"@effect-dynamodb/schema": minor
"@effect-dynamodb/geo": minor
"@effect-dynamodb/language-service": minor
---

A `Schema.BigInt` reads back wherever it's stored, under a declaration, a `Schema.suspend` or a transformation too, and on every owner.

- **`Schema.Option(Schema.BigInt)`, `Schema.Result`, `Schema.ReadonlySet(Schema.BigInt)` and a `Schema.BigInt` under a `Schema.suspend` now read back on an entity and an aggregate, as they do on a stream.** Each was stored as a number and read as `Expected bigint`, unless it was past 2^53. A recursive schema reads back all the way down. What's stored doesn't change, and no row needs rewriting.
- **A transformation over `Schema.BigInt` reads back on every owner.** `Schema.DurationFromNanos`, `Schema.ByteSizeFromBigInt`, `Schema.OptionFromNullOr(Schema.BigInt)` and your own were stored as a number, and every read failed. They aren't refused at load any more, and `aggregate.create` and `update` take them.
- **Fewer unions are refused on a stream, a snapshot and an outbox, judged in the order a read tries the members.** `Schema.Union([Schema.Option(Schema.BigInt), Schema.Struct({ x: Schema.optional(Schema.String) })])` and `Schema.Union([Schema.Struct({ a: Schema.Number, c: Schema.String }), Schema.Struct({ a: Schema.BigInt })])` read back and are taken. `Schema.Union([Schema.Struct({ a: Schema.BigInt }), Schema.Struct({ a: Schema.Number, c: Schema.String })])` is refused (`EDD-9125`), where a value written through the second member read back as the first, without `c`. An entity or an aggregate has the same refusal under a declaration, a `Schema.suspend` or a transformation, where a read lifts the number before the union sees it.
