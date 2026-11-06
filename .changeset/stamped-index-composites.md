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

**Values that can't be stored are now a `ValidationError`, on every path, with nothing sent.**

- A `NaN` key composite is refused with `EDD-9096` with `escapeKeys` off, as it is with it on. The stored text of every other value is unchanged. Up to now it composed `0000000000000NaN`, so `get` and `delete` looked for a key nothing holds, `purge`, a query, a batch and a transactional delete reported success having sent it, and a `put` died in the marshaller. A `NumberFromString` row 1.36 stored under that text still decodes on a scan, and `rekey` leaves it (`skipped.unrecognizedKey`). 1.37 and 1.38 refused it too.
- A value with no DynamoDB form, `NaN`, `Infinity` or a number past `Number.MAX_SAFE_INTEGER`, is a `ValidationError` (`EDD-9124`) from any write, condition or filter, where it was a defect. `Expression.condition`, a plain builder, throws the tagged `UnstorableValue`.
- **A query accessor, `.where()` or `.within()` given such a value no longer throws when called.** It returns a builder whose terminal fails with the `ValidationError`, nothing sent, and whose `.explain()` is the `empty` plan with the reason. That includes `versions`, `deleted.list`, `history`, collections, and a Z-order bound a dimension can't place (`EDD-9092`). Code catching the throw should handle the failure instead. A missing composite and other misuse the types catch still throw.
- Aggregates, event stores and `GeoIndex.nearby` return the `ValidationError` too, where they died. A projection's row key with no text is that row's `Failed` outcome, not the batch's.

**`upsert` omitting an optional composite no longer leaves the other half stale.** With `pk: [owner]`, `sk: [note]`, `upsert({ owner: "o2" })` stored `owner: o2` under `owner_o1`. Each half is now judged alone, with no read and, when nothing the input names is in a half it leaves, no condition. A half it names part of holds on those values, a rejected write returns the row free and composes from it, and what neither supplies goes by the half's policy. A new row given one half now has that key attribute, without being in the index.

**An `upsert` clearing a secondary index composite no longer leaves its key behind.** `upsert({ ..., und: undefined })` on a `Schema.UndefinedOr` composite removed the attribute and kept the key that held it. It now reads first, and leaves what `.set(...).remove(["und"])` would: the half gone, or truncated to its parents. An `undefined` on a field that's merely optional still keeps the attribute and the key, in one write, and a clear of what no key holds stays one write.

`.remove()` of a `createdAt` or `updatedAt` that isn't a date now compiles, as it always ran: that field is the caller's. So is `Schema.UndefinedOr` of a date, which nothing stamps, so `put`'s type asks for it as the runtime does. A date under `Schema.optional`, or required, stays a compile error and a `ValidationError`, since the library stamps it.

**Aggregates:**

- `create` stamps a `Schema.Record` `many` edge with a custom `decompose` and `assemble`, and its dates are stored in their own form. It failed with `Missing key` before, or with no `entity` stored a date as a map no read could decode. The input type and `inputSchema` make those dates optional.
- `sk.composite` on a `Schema.Record` `many` edge now compiles, and each name is checked against the record's value. It had been a compile error whatever the name, since the check read only an array's element.
- A `one` edge with no `entity` takes its value in the input, as `create` always did. The type and `inputSchema` asked for an id it can't use.
- `@effect-dynamodb/schema`'s `Aggregate.make` refuses a `many` sort key over a stamped `updatedAt` (`EDD-9121`), as the operational one does.
