---
"effect-dynamodb": minor
"@effect-dynamodb/schema": minor
"@effect-dynamodb/geo": minor
"@effect-dynamodb/language-service": minor
---

An aggregate write refuses a value its field's schema can't encode when, stored as given, the aggregate wouldn't read back. It fails with a `ValidationError` naming the field (`EDD-9127`), and nothing is written.

Such a value is stored as it was given. A one-way transformation's value reads back that way, and is still stored. A transformation over itself, such as `s.pipe(Schema.decodeTo(s, SchemaTransformation.passthrough()))` where `s` holds a transformation, can't encode or decode any value, so `create` and `update` refuse it at every position: root, `one` edge, `many` element and sub-aggregate. A write that stores nothing as given does no extra work.
