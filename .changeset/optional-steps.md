---
"effect-dynamodb": minor
"@effect-dynamodb/schema": minor
"@effect-dynamodb/geo": minor
"@effect-dynamodb/language-service": minor
---

An aggregate takes what `Schema.OptionFromOptional` makes, and `update` no longer refuses the state it was handed.

- **`aggregate.create` takes the `Option` that `Schema.OptionFromOptional` and `Schema.OptionFromOptionalKey` make, at any position.** It refused `Option.some(5n)` with a `ValidationError`, writing nothing, and only took what's stored, `"5"`. Both are taken now, in the root, a `one` edge, a `many` element and a sub-aggregate. `Option.none()` stores nothing, as leaving the field out does.
- **`aggregate.update` works on an aggregate holding one.** A mutation returning `{ ...state, note }` failed with `Expected string`, whatever it changed, so a row with such a field could be created and read but not updated. What it didn't change stays stored as it was, and a value that's neither what the step makes nor what's stored is still refused.
- **A step of your own encoded as optional reads back when it holds a bigint or a date.** A step from an optional key to a `Schema.Array(Schema.BigInt)`, a struct or a list works the same way as `Schema.OptionFromOptional`, on an entity, an aggregate and a stream.

- **`Schema.Redacted` beneath a transformation onto another type is refused when the model loads (`EDD-9125`).** That includes `Schema.OptionFromOptional`, `Schema.OptionFromOptionalKey` and `Schema.OptionFromUndefinedOr`. Its value wasn't stored, and every read died. Use `Schema.RedactedFromValue`, which still works beneath them. A transformation ending in `Schema.Redacted` still reads back.
- **A date or a redacted value decoded to a list of something else is refused when the model loads (`EDD-9125`).** On an entity, a `Schema.Array(Schema.Date)` decoded to a list of numbers or strings stored each date as an empty map, and every read failed. An aggregate already refused it.
- **A transformation between two lists holding the same type loads on an aggregate again.** A `Schema.Array(Schema.Date)` or a list of `Schema.Redacted` over itself was refused on the way to this release, though it read back on 1.39.0 and still does on an entity.

- **A list decoded to or from a list of bigints reads back on an entity.** A `Schema.Array(Schema.String)` decoded to a list of bigints, a list of bigints decoded to strings, a list held as `Schema.fromJsonString` holding a `Schema.BigIntFromString`, and a step from an optional list to a list of lists all wrote the row and then failed, so `put`, `create`, `upsert`, an update and a time-series `append` reported a failure for a write that had landed, and every read failed. They read back now, from what was stored already.

What's stored for these is what 1.39.0 stored, and no row needs rewriting. Three things do change for new writes through an aggregate, and rows already stored read as they did:

- **A `Schema.Unknown` beneath a step, given as an `Option`.** Beneath `Schema.OptionFromOptional`, `Schema.OptionFromOptionalKey`, `Schema.OptionFromNullOr`, `Schema.OptionFromNullishOr` or `Schema.OptionFromUndefinedOr`, it stored Effect's internal form of the `Option` and read back as an `Option` holding an `Option`. It now stores the value, as an entity does, and reads back as the `Option` it was given.
- **A transformation with one type on both sides, inside an `Option` or a `Result`.** It ran an extra time on `create`, so a transformation multiplying by ten stored 500 for 50 and read 5000. It now stores 50 and reads 500.
- **A transformation inside an `Option` or a `Result`, given in its stored form.** It stored the domain form, which its own `get` refused. It now stores what it was given, and that reads.
