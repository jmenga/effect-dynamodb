---
"effect-dynamodb": minor
"@effect-dynamodb/schema": minor
"@effect-dynamodb/geo": minor
"@effect-dynamodb/language-service": minor
---

An aggregate `update` deletes a custom `decompose`'s rows by the keys they're stored under. On a `many` edge whose `decompose` encodes its keyed field itself (`f / 10` on a field that multiplies by 10), removing an element left its row, and `get` still returned it. Changing the keyed value left the old row beside the new one. `update` worked out which rows to delete by decomposing the state it read once more, which keys such rows elsewhere. It now reads them off the partition it has already read, so it costs no extra request.

`rekey` moves those rows with the aggregate. Each row's key is composed from its own stored values, and the row is moved as stored. Under `escapeKeys`, such an edge's rows stayed under the old partition key, unreported, and `get` returned no lines. `rekey` now reports any row of an aggregate's entity types that no row of its value places, as a `failed` conflict, and leaves the aggregate as it is, rather than moving the root without it. That includes a second row of a `one` edge. A `failed` conflict for an aggregate that doesn't decompose now names the reason in its `message`.

A `many` edge whose custom `decompose` returns a date field's stored form, such as the ISO text of a `Schema.DateTimeUtcFromString` or the epoch milliseconds of a number decoded to a `Date`, stores it as it is and keys it as 1.39.0 did. On 1.39.0 an array edge failed `create` with a defect, and so did an edge held as a `Schema.Record` with an `entity`. Since keyed edges took their element's encoders in this release, a keyed edge without one failed `create` and every `update` of its 1.39.0 rows too. A value in neither form is refused with a `ValidationError` (`EDD-9127`), and nothing is written.

A `Schema.Record` `many` edge now encodes its fields as an array edge does, where 1.39.0 stored what `decompose` returned. A `Schema.NumberFromString` is stored as its text, not the number, under the same key, and reads the same value. A field that multiplies by 10 on decode, returned by `decompose` as `f / 10`, reads back the value given, where 1.39.0 read ten times it and multiplied it again on every `update`. A row 1.39.0 wrote reads as it did.

Otherwise, an aggregate without a custom `decompose` sends the same requests as before.
