---
"effect-dynamodb": patch
"@effect-dynamodb/schema": patch
"@effect-dynamodb/geo": patch
"@effect-dynamodb/language-service": patch
---

**An entity whose primary key holds a ref's id works.** With `primaryKey: { pk: ["projectId"] }` and `refs: { project: ... }`, `Entity.make` accepted the entity and `put`, `create` and `insert` stored it, but `get`, `update`, `patch`, `upsert`, `delete`, `deleteIfExists`, a transaction's update, and every path of a `versioned: { retain: true }`, `unique` or `softDelete` entity (`restore` and `purge` among them) died with `Missing composite attribute "projectId" in record`, on 1.40.0 too. A key now takes the ref's id as the caller gives it, as the input does, and a key composed from a row the operation read takes it from the stored ref. `Entity.Key<E>` includes the id, and the update type and `updateSchema` leave it out, since no update changes the key. An error's `key` from a duplicate `insert` (`ItemAlreadyExists`) or from a `put` / `create` of a `versioned` or `unique` entity now holds the id as given, where it held `undefined`. Rows are stored as before.

Also fixed: `restore` of an item whose ref's id is an index composite (a `refs` cascade index, or one of your own) wrote no key for that index, so the restored item was missing from it and a cascade skipped it. It now keys the index from the stored ref, as the `put` did.
