---
"effect-dynamodb": patch
"@effect-dynamodb/schema": patch
"@effect-dynamodb/geo": patch
"@effect-dynamodb/language-service": patch
---

Two places where an error printed values beyond the item's key, and from there reached logs: the `key` of a write's error and the stored row on its `cause`. Schema errors (`ValidationError`'s `cause`) quote no value and are unchanged.

**`key` on an error from `put`, `create`, `upsert`, a time-series `append` or a transaction's `put` now holds exactly the entity's primary key composites, by model field name and in their encoded form: the same record that `get`, `update` and `delete` errors carry for that item. It used to hold the whole encoded input. The primary key fields are still there; every other field of the input is not, so a `Schema.RedactedFromValue` field is no longer on the error in plaintext.** Code that read a non-key field off `error.key` needs another source for it.

When a condition fails, AWS returns the stored row on the SDK's error (`Item`, or `CancellationReasons[i].Item` in a transaction). On an error's `cause` that row is still readable, but no longer enumerable, so `JSON.stringify` and structured loggers don't print it.
