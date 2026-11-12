---
"effect-dynamodb": patch
"@effect-dynamodb/schema": patch
"@effect-dynamodb/geo": patch
"@effect-dynamodb/language-service": patch
---

Accept a `sessionToken` in `credentials`. `DynamoClient.layer`, `DynamoClient.layerConfig`, `DynamoStreamsClient.layer` and `DynamoStreamsClient.layerConfig` typed credentials as `{ accessKeyId, secretAccessKey }`, so passing temporary credentials (an assumed role) needed a cast, although the SDK sent the token. `sessionToken` is now an optional string. In `layerConfig` it's read through the same `Config` as the other two, as a plain string. A token left `undefined` isn't sent. An unknown key is still a compile error.
