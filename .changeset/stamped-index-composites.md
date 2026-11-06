---
"effect-dynamodb": minor
"@effect-dynamodb/schema": minor
"@effect-dynamodb/geo": minor
"@effect-dynamodb/language-service": minor
---

An index key over a value the library stamps now holds that value.

`put` composed its keys before stamping, so with `timestamps: true` and `sk: [createdAt]` or `[updatedAt]`, or under `retain` and `sk: [version]`, a row written without supplying the value was stored with no key for that index and no query could find it. `put`, `create`, `upsert`, `restore`, `Batch.write`, `transactWrite`, `EventStore` additional items and projection rows now stamp first and compose from what they stamped. **Rows that were silently missing from these indexes now appear** when written. Existing rows need `rekey({ repairIndexKeys: true })`, which counts them as `missing` and brings them in.

An update moves a half holding `updatedAt` when it can compose it. If another of the half's composites is on neither the payload nor the primary key, the key is left under either policy and lags until a write can compose it: `sk: [status, updatedAt]` on `.set({ note })` never drops or truncates. `rekey` doesn't count a key that only lags. An update's `updatedAt` never counts as touching a half. `[status, createdAt]` on `.set({ status })` still truncates to `status_b`, the existing partial-payload rule; `rekey({ repairIndexKeys: true })` restores it.

**These definitions now fail at load, and each has never worked:** `version` as an index composite without `retain` (`EDD-9121`: no write knows the next value, and no item ever held the key; it's a compile error too); `updatedAt` or `version` in a primary key or `shards.by` (`EDD-9121`: a primary key never changes, and a shard would go stale on every write); and a `configure` `field:` rename of the version attribute (`EDD-9122`: every write after the first failed; use `versioned: { field }`).

Other behaviour that changes:

- A `Schema.optional` date `createdAt` or `updatedAt` on an entity is now stamped unless supplied, as `Schema.optionalKey` always was.
- `upsert` reads first when `createdAt` or an `immutable` field is a secondary index composite, so the key holds what the item keeps; before, it held what the input said. With a primary key over an unsupplied `createdAt` it creates, where `put` used to die.
- A time-series `append` over a `createdAt` composite reads the row first, so the row joins that index.
- A `configure` rename of `createdAt` or `updatedAt` is now written under the renamed attribute by `update`, `upsert` and `append`, which used to leave an attribute under the model's name and a stale value under the other.
- A projection's row with an outbox composes its keys from the `createdAt` it keeps.
- An aggregate's list key over `createdAt` or `updatedAt` now holds what the root row holds, where it used to hold the supplied value until the next update, and then the previous stamp.
- `put`'s type no longer offers a plain `createdAt: Schema.String` as optional: the runtime always required it. An update may name one, as the runtime always let it.
