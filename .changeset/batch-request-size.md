---
"effect-dynamodb": patch
"@effect-dynamodb/schema": patch
"@effect-dynamodb/geo": patch
"@effect-dynamodb/language-service": patch
---

`Batch.write` splits its requests at DynamoDB's 16 MB request limit as well as by count. That limit applies to the request body, the JSON text sent, which is larger than the items: a control character takes 1 byte in an item and 6 in JSON, `"` and `\` take 2, and binary values are sent as base64. So 25 items within the 400 KB item limit could pass 16 MB in one `BatchWriteItem`. DynamoDB refused it, and `Batch.write` failed with a `DynamoError` that named no item. `Batch.write` now splits its plain requests at 25 items or 16 MB of request body, whichever comes first, and its versioned-put transactions at 100 items, 4 MB, or 16 MB of request body. An aggregate's `rekey` packs its moves by the same rule. A batch within every limit is sent in the same requests as before.

A request the library doesn't split (`Transaction.transactWrite`, `EventStore.append`, an aggregate's writes) is still sent as you built it. If DynamoDB refuses it for its size (HTTP 413), the error now names the request's three largest items, once the library has measured the body it sent and confirmed it is over 16 MB. Otherwise DynamoDB's error passes through unchanged.

Two planning additions:

- `stream.measureAppend` returns `requestBytes`, the exact request body the append would send. It includes the transaction's client token and, when capacity reporting is on, the `ReturnConsumedCapacity` field.
- `StorageEncoding.limits` has `request: 16_777_216`. AWS documents 16 MB for `BatchWriteItem`, and DynamoDB Local rejects any request body over 16 MiB with HTTP 413.
