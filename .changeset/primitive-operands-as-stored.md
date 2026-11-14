---
"effect-dynamodb": patch
"@effect-dynamodb/schema": patch
"@effect-dynamodb/geo": patch
"@effect-dynamodb/language-service": patch
---

A condition or filter now sends a plain value (text, a number, a `bigint`, a boolean) in the form its field stores it only where that form is a plain value of another type, so `eq(t.player.id, 5)` on a ref to a player whose id is a `Schema.NumberFromString` compares the `"5"` the row holds instead of never matching, while text, or a number where a number is stored, is sent as before.
