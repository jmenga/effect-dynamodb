---
"effect-dynamodb": patch
"@effect-dynamodb/schema": patch
"@effect-dynamodb/geo": patch
"@effect-dynamodb/language-service": patch
---

Timestamps are stored the way 1.39.0 stored them, in three places this release had changed.

**An aggregate stores a timestamp in the form its row stores any value of that field in**, on `create` and `update`, on the root and on edges. A date a row declares is stored in its own encoding, except under `Schema.optional`, where a value is stored as ISO text, as on 1.39.0. The stamp was written in the date's own encoding instead, so a root declaring `updated: Schema.optional(DynamoModel.DateEpochMs)` kept a value passed to `create` as ISO text and then got an epoch-milliseconds number from `update`, and one attribute held two forms. A row that doesn't declare the field is stamped in the root's form. Rows already stored read back in either form, and nothing needs rewriting.

**An aggregate's `create` stamps a root date declared `Schema.optionalKey` over a value passed for it**, in its own encoding, as 1.39.0 did. Only a date the root declares `Schema.optional` keeps a value passed to `create`. Before, `Schema.optionalKey` kept it too, so a placeholder passed for it became the row's timestamp.

**An entity's `Schema.optional` date over a transform stored as the other kind is the caller's again**, as on 1.39.0, such as `createdAt: Schema.optional(DynamoModel.DateString.pipe(DynamoModel.storedAs(DynamoModel.DateEpochSeconds)))` with `timestamps: true`. Without `Schema.optional`, `Entity.make` refuses such a field as a timestamp, since the transform stores its own form and the stamp can't be read back. This release stamped it anyway, in a form the field can't read back: a row written without a value for it, and any time-series `append`, failed with `Expected DateTime.Utc` once written, and so did every read of it. Now `put`, `create`, `update`, `upsert`, `Transaction.transactWrite`, `Batch.write` and a time-series `append` store a value passed for it in the transform's form and store nothing without one, as 1.39.0 did.
