---
"effect-dynamodb": patch
"@effect-dynamodb/schema": patch
"@effect-dynamodb/geo": patch
"@effect-dynamodb/language-service": patch
---

An aggregate's `create` returns what 1.39.0 returned when it's given a value in the form a transformation to `Unknown` stores. A field transformed from a struct or a record to `Unknown`, given its stored form (alone, under `NullOr` or `optional`, or in a union with a tagged struct), comes back decoded, not as given. A `many` element given whole, in a union whose wrapping member transforms to `Unknown` or a declaration, comes back with its entity's class instance, not a plain object. What's stored and read back for these doesn't change.

A union element whose other member renames a field and transforms to `Unknown` (`line` stored, `text` held), given that member's stored form, is stored and returned by `create` as on 1.39.0: the row holds the member's domain field (`text`) unencoded. 1.39.0 couldn't read such a row back. It now reads back, but don't rely on how it does: as the row's attributes, in their stored order, with a sub-aggregate's discriminator among them. Give such a member its domain value instead.
