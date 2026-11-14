---
"effect-dynamodb": patch
"@effect-dynamodb/schema": patch
"@effect-dynamodb/geo": patch
"@effect-dynamodb/language-service": patch
---

A `storedAs` set with `DynamoModel.configure` on an optional date now keeps the field optional and stores the date in the configured form.

For a model field declared `Schema.optionalKey(Schema.DateTimeUtc)`, `Schema.optional(Schema.DateTimeUtc)` or `Schema.optionalKey(Schema.NullOr(Schema.DateTimeUtc))`, or an optional `Schema.Date`, with `configure(Model, { field: { storedAs: DynamoModel.DateEpochSeconds } })`:

- An `optionalKey` date became required: a `put` that left it out failed with a `ValidationError` (`Missing key`). A value given was already stored in the configured form.
- An `optional` date, and the date in `optionalKey(NullOr(...))`, ignored the setting: it was stored, compared in conditions and filters, and written by `update` as ISO text. A TTL attribute declared this way never expired, because DynamoDB's TTL only reads numbers. A model's own `optional` `createdAt` or `updatedAt` configured this way, which the library stamps in the configured form, read back as a date in January 1970.

Each of these now keeps the field as declared and stores the date as configured. A model that doesn't combine `storedAs` with an optional or nullable date sends exactly the same requests as before.

Rows written before this release: a date stored as ISO text keeps reading as the date it holds, since reads accept both forms by whether text or a number is stored. A condition or filter on that field sends the configured form, so it won't match such a row, and a TTL attribute still holding ISO text still won't expire. To store the date in the configured form, write the field again, with `update(key).set({ field })` or a `put`.

Where such a field is part of a key (a primary key or index composite, a unique constraint, a vector index partition or a time-series `orderBy`), it is still stored as ISO text, so the keys of rows already written don't move.

A ref two levels deep (a ref to an entity that itself refs an entity configuring `storedAs`) now reads, compares and path-writes the nested date in that storage too. What hydration stores is unchanged.
