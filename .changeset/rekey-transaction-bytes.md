---
"effect-dynamodb": patch
"@effect-dynamodb/schema": patch
"@effect-dynamodb/geo": patch
"@effect-dynamodb/language-service": patch
---

`rekey` can move an aggregate whose rows together pass 4 MB. It packed each wave of an aggregate's moves into transactions of up to 100 items, counting items only. A move is the row's Put plus a Delete guarded on the row as read, so it sends the row about twice. Fifty moves of rows over about 42 KB each, or six of rows near DynamoDB's 400 KB item limit, passed 4 MB in one transaction. DynamoDB rejected it, and the run failed with a `DynamoValidationError` on every attempt. Each transaction now takes the wave's moves in order while it stays within 100 items and 4 MB, by the same size measure `Batch.write` uses. A move's Put and Delete still go in one transaction, and the root still moves last. A wave that fits in 4 MB is sent in the same requests as before.
