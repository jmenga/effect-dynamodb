---
"effect-dynamodb": minor
"@effect-dynamodb/schema": minor
"@effect-dynamodb/geo": minor
"@effect-dynamodb/language-service": minor
---

An aggregate `update` deletes a custom `decompose`'s rows by the keys they're stored under. On a `many` edge whose `decompose` encodes its keyed field itself (`f / 10` on a field that multiplies by 10), removing an element left its row, and `get` still returned it. Changing the keyed value left the old row beside the new one. `update` worked out which rows to delete by decomposing the state it read once more, which keys such rows elsewhere. It now decomposes that state both as it was read and as a write's value is, and deletes the keys either gives that a row it read holds and the new state doesn't, in the transaction of the group that owns the edge. It sends no extra request, and deletes only a row it read whose content is what that reading writes there, every attribute but the keys and timestamps the library manages compared. A key alone isn't enough: decomposing a value as a write's is can give the key of a row another aggregate, or the entity itself, stored in the partition, and that row is left alone, as is any row of the same entity type the aggregate didn't write.

`rekey` moves those rows with the aggregate, as stored. Under `escapeKeys`, such an edge's rows stayed under the old partition key, unreported, and `get` returned no lines. A row is the edge's only on the same terms as for `update`, key and content. Each stored row is placed once, however many edges or aggregates reach it. An aggregate moves whole or not at all: when a row it would move to is held by a row it doesn't move, another aggregate's or one already there, it reports a `bothKeys` conflict and moves none of its rows, its root included, whichever aggregate the scan meets first. A row the aggregate's value doesn't hold stays where it is. A `failed` conflict for an aggregate that doesn't decompose now names the reason in its `message`.

A `many` edge whose custom `decompose` returns a date field's stored form, such as the ISO text of a `Schema.DateTimeUtcFromString` or the epoch milliseconds of a number decoded to a `Date`, stores it as it is and keys it as 1.39.0 did. On 1.39.0 an array edge failed `create` with a defect, and so did an edge held as a `Schema.Record` with an `entity`. Since keyed edges took their element's encoders in this release, a keyed edge without one failed `create` and every `update` of its 1.39.0 rows too. A value in neither form is refused with a `ValidationError` (`EDD-9127`), and nothing is written.

A `Schema.Record` `many` edge now encodes its fields as an array edge does, where 1.39.0 stored what `decompose` returned. A `Schema.NumberFromString` is stored as its text, not the number, under the same key, and reads the same value. A field that multiplies by 10 on decode, returned by `decompose` as `f / 10`, reads back the value given, where 1.39.0 read ten times it and multiplied it again on every `update`. A row 1.39.0 wrote reads as it did.

Otherwise, an aggregate without a custom `decompose` sends the same requests as before.
