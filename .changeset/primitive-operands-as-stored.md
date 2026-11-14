---
"effect-dynamodb": patch
"@effect-dynamodb/schema": patch
"@effect-dynamodb/geo": patch
"@effect-dynamodb/language-service": patch
---

A condition or filter that compares a number or `bigint` with a field stored as text, such as `eq(t.player.id, 5)` on a ref to a player whose id is a `Schema.NumberFromString`, now sends the `"5"` the row holds instead of a number that never matched, and values the row already holds as given are sent as before.
