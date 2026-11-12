---
"effect-dynamodb": patch
"@effect-dynamodb/schema": patch
"@effect-dynamodb/geo": patch
"@effect-dynamodb/language-service": patch
---

Accept a `sessionToken` in `credentials`. `DynamoClient.layer`, `DynamoClient.layerConfig`, `DynamoStreamsClient.layer` and `DynamoStreamsClient.layerConfig` typed credentials as `{ accessKeyId, secretAccessKey }`, so a literal with temporary credentials (an assumed role) needed a cast, although the SDK sent the token. `sessionToken` is now optional: a string, or `undefined` or `null` for none. In `layerConfig` it's read through the same `Config` as the other two, as a plain string. The credentials object still goes to the SDK as given, so nothing is sent differently. As before, an unknown key in an object literal is a compile error. A token that's neither a string nor `undefined` or `null` is now one too; it compiled through a variable before.
