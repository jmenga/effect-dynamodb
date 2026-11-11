---
"effect-dynamodb": patch
"@effect-dynamodb/schema": patch
"@effect-dynamodb/geo": patch
"@effect-dynamodb/language-service": patch
---

An `upsert` that reads the row first (an entity with `unique` or `versioned: { retain: true }`, or an input omitting a defaulted index composite) checks a sparse map's entry keys as 1.39.0 did, with or without a ref to read. It writes a row that isn't there as a `put`, which refuses an empty key, one holding `#` and an attribute name over 255 bytes, and a row that's there as an update of the fields it names, which refuses the same on a `retain` entity or when it changes a unique field, and otherwise an empty key and one holding `#`. So an entry whose attribute name is over 255 bytes is written into a row that's there, as on 1.39.0. A key both writes refuse is refused before the read, in the `put`'s words: over a row that's there, 1.39.0 read the row first and refused an empty key or one holding `#` with `invalid key`.
