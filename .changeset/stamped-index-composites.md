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
- `upsert` over a secondary index composite that's `createdAt` or `immutable` now keeps the stored value in the key as well as the attribute; before, the key held what the input said, or there was none. It adds no read. It's one `UpdateItem` with a condition, and the rejected write returns the row at no read charge where one write can't get the key right: an input naming another value of an `immutable` composite in a key holding something else, a row with no key, or `[status, createdAt]` with a changed status and no `createdAt` in the input. Those take a second write, and the rejected one is charged write capacity. With a primary key over an unsupplied `createdAt` it creates, where `put` used to die.
- A time-series `append` over a `createdAt` composite now keeps its key, with no read before the write, so the row joins that index. Where the rest of the key changed, a rejected transaction is followed by a second one. With `skipFollowUp` it sends no read at all.
- A `configure` rename of `createdAt` or `updatedAt` is now written under the renamed attribute by `update`, `upsert` and `append`, which used to leave an attribute under the model's name and a stale value under the other.
- A projection's row with an outbox composes its keys from the `createdAt` it keeps.
- An aggregate's list key or collection sort key over `createdAt` or `updatedAt` now holds what the root row holds, where it used to hold the supplied value until the next update, and then the previous stamp.
- **An aggregate row that declares a date `createdAt` or `updatedAt` now works as an entity does**, at the root, a sub-aggregate root, a `one` edge and a `many` element. The input doesn't need it. A supplied value wins, where the stamp used to overwrite it. `create` and `update` return what they stored, where they used to return the supplied value or the one from before the write. A `Schema.optional` date on the root is now stamped, where nothing stamped it. A sub-aggregate or edge that declares a date used to fail every `get` and `update` with `Missing key` and can now be read. `aggregate.update` keeps a stored `createdAt` whatever the mutation did. A field of that name of another type stays the caller's, on that row.
- **An optional composite in an aggregate key with no value no longer dies with a defect.** In a `list` key, sharded or not, the row is left out of that list, as a sparse index on an entity leaves it out. In a collection sort key or the partition key it's a `ValidationError` (`EDD-9123`) before anything is written, since a root outside the collection index can't be read back; `delete` reports it as `AggregateAssemblyError`. A `list` filter that leaves out a composite of the list's partition key is the same `ValidationError`.
- **These aggregate definitions now fail at load** (`EDD-9121`): a partition key or a `many` edge's sort key over a stamped `updatedAt`. Both name the row, so every update wrote a new row and left the old one.
- `put`'s type no longer offers a plain `createdAt: Schema.String` as optional: the runtime always required it. An update may name one, as the runtime always let it.
