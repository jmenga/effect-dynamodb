---
"effect-dynamodb": patch
"@effect-dynamodb/schema": patch
"@effect-dynamodb/geo": patch
"@effect-dynamodb/language-service": patch
---

A `Schema.ObjectKeyword` field is now checked as an untyped one, so a write whose value holds a part DynamoDB doesn't store (a `Date` written as an empty map, say) is refused with `EDD-9161` instead of stored as less than it is, as a packed field of that kind already refused it.
