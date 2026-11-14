---
"effect-dynamodb": patch
"@effect-dynamodb/schema": patch
"@effect-dynamodb/geo": patch
"@effect-dynamodb/language-service": patch
---

`Aggregate.list` no longer drops a list key value given after a sort key composite left out. On a list keyed `sk: [league, season, name]`, `list({ league: "bbl", name: "Smith" })` returned every `bbl` aggregate, whatever its name; the value after the gap is now matched whole against the value the root row stores (in the case given), in the root-item filter, and `limit` and `cursor` page over the matches. With a gap, `prefix: true` changes nothing. A key without a gap sends the same requests as before.

A `list` filter operand that is a plain number, bigint or boolean is now sent in the form the root row stores its field, as an entity's filter operand is: `eq(t.caps, 7)` on a `Schema.NumberFromString` root field sends `"7"` and matches, where it was sent as a number and matched nothing. Text compared with a text-stored field is sent as given, as before. A `DateTime` against a `Schema.DateTimeUtcFromString` root field (#124) has been sent as its ISO text since 1.41.0.
