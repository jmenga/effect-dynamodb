---
"effect-dynamodb": patch
"@effect-dynamodb/schema": patch
"@effect-dynamodb/geo": patch
"@effect-dynamodb/language-service": patch
---

An aggregate takes and reads back a union element whose members transform to `Unknown` or a declaration as 1.39.0 did. A member's value given a string id its edge fetches is refused with a `ValidationError` and nothing written, not created with the fetched record in place of the caller's field. Another member's row reads back as that member, not in the row's stored attribute order with a sub-aggregate's discriminator in it. A field transformed from a struct or a record to `Unknown` refuses a value its transformation can't store, as 1.39.0 did, instead of storing it as given.
