---
"effect-dynamodb": patch
"@effect-dynamodb/schema": patch
"@effect-dynamodb/geo": patch
"@effect-dynamodb/language-service": patch
---

`Aggregate.list` no longer drops a list key value given after a sort key composite left out. On a list keyed `sk: [league, season, name]`, `list({ league: "bbl", name: "Smith" })` returned every `bbl` aggregate, whatever its name; a value after the gap now matches an aggregate as it would in the key, whole and by its key text, so the schema's casing applies to it as to the leading values (`{ league: "BBL", name: "smith" }` finds `Smith` under the default casing). A number, or any value under a casing that doesn't fold text, is compared in the root-item filter; text under a folding casing is matched on the root items read, before any aggregate is assembled. `limit` and `cursor` page over the matches. With a gap, `prefix: true` changes nothing. A key without a gap sends the same requests as before.

A `list` filter operand that is a plain number, bigint or boolean is now sent in the form the root row stores its field, as an entity's filter operand is: `eq(t.caps, 7)` on a `Schema.NumberFromString` root field sends `"7"` and matches, where it was sent as a number and matched nothing. Text compared with a text-stored field is sent as given, as before. A `DateTime` against a `Schema.DateTimeUtcFromString` root field (#124) has been sent as its ISO text since 1.41.0.
