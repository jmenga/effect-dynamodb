---
"effect-dynamodb": minor
"@effect-dynamodb/schema": minor
"@effect-dynamodb/geo": minor
"@effect-dynamodb/language-service": minor
---

GSI write sharding ([#183](https://github.com/jmenga/effect-dynamodb/issues/183)), one flag for key text, and the fix for inverted indexes. **1.39.0 fixes the inverted index problem 1.37.0 and 1.38.0 have, and reverses 1.37.0's key change by default.**

**Key text is one setting: `DynamoSchema.make({ escapeKeys })`, off by default for all of 1.x.** On by default is planned for the next major release.

- **Off, the default,** composes the key text 1.36 composed, for strings and numbers: a string as it is, a number or bigint zero-padded `String(n)`, a time-series event key the `orderBy` attribute's stored value.
- **`escapeKeys: true`** composes every key, partition and sort, with every character up to `%` as `%` and two hex digits, and numbers in the numeric key text 1.37.0 introduced. Key order is then value order, and a value may hold `#`.
- A value with none of those characters, and a non-negative integer below 1e16 (1e38 for a `bigint`), compose the same text either way.

**What to do about your rows:**

- **From 1.36 or earlier:** nothing. Key text is what 1.36 composed, so every row is where the library looks for it. Upgrade and deploy. The query conditions 1.37.0 changed stay: a full pin sends `sk = key`, and `beginsWith` on a numeric composite sends `eq`.
- **From 1.37.0 or 1.38.0: run `rekey` before serving traffic.** Those releases escaped sort keys, changed the text of some numbers and put an `orderBy`'s key text in event keys, and the default no longer looks there. That concerns a row with a character up to `%` in a sort key; a row with a number whose text 1.37.0 changed in a key (negative, fractional, 1e16 and up, a `bigint` that's negative or 1e38 and up, `Infinity`, or an epoch date before 1970); and a time-series event of a `NumberFromString` or `BigIntFromString` `orderBy`. Either keep the default, and `db.tables.<Table>.rekey()` moves those rows back to the 1.36 text, or set `escapeKeys: true`, and it moves them, and every row with a character to escape in a partition key, to escaped text. Rows 1.38.0 wrote count the same as rows 1.37.0 wrote: the two store identical keys. An instance of either release still running writes their text, so run `rekey` again once the last one has gone.
- **To turn `escapeKeys` on over existing data:** set the flag, and run `rekey` before serving traffic.
- **A new table** needs nothing.

**No fallback.** Every operation composes the one text its setting chooses, and sends the same requests whatever the value is. The second read in `get`, the second query, the move on first write and the rest of the fallback 1.37.0 shipped are gone, with their row checks and the cursor of a query that read both keys. The `legacyKeys` option and `ItemNotMoved` (`EDD-9097`, retired) are gone too: remove `legacyKeys` from `DynamoSchema.make`. `rekey` is the only thing that moves a row between key texts. Until it finishes on a table with rows under other text, nothing is promised: those rows aren't found by any read, a write of the same key lands beside them (`rekey` reports `bothKeys`), a value can land on another value's old row, and a unique value isn't seen as taken while its sentinel is under other text. A cursor from a 1.37.0 or 1.38.0 query that read both keys fails with `EDD-9094`: restart the listing.

**`rekey` moves rows to whatever the setting composes, in either direction.** It covers items, index keys including a Z-order index's partition key and prefix, unique-constraint sentinels, snapshots, tombstones, time-series events, aggregates, event streams and projection rows, from the text of 1.36, of 1.37.0 and 1.38.0, and of `escapeKeys: true`. A row is moved or counted, never silently left: what it can't place is in `conflicts` or `skipped.unrecognizedKey`. When keys spell each other's (`foo bar` under escaping belongs where `foo%20bar` was stored) the holder moves first, and nothing is overwritten or merged. A dry run agrees with the real run, a chain blocked by a row that can't move included, and a second run changes nothing. `guides/upgrading` lists what it moves and what it can't. A partition key mixing an escape and a changed number, an escape in each half of a row, an aggregate's mixed partition and a sentinel mixing an escape and a changed number are all recognised now.

**Limitations of the default,** none of them new against 1.36, and documented in `guides/indexes`:

- Numbers don't sort numerically in a key, and `.history()` on a string-encoded numeric `orderBy` is in text order.
- A range on a sort key composite that isn't the last can return wrong rows when a value holds a character below `#`, and `gt` under a pin on the last composite can miss a longer value continuing below `#`.
- A `#` in a value can imitate a segment: `a#b` + `c` and `a` + `b#c` compose one key.
- Skip-scan over free-form strings can hide rows, and a `#` stops its probing.
- A partial pin and an equal `.where()` or `.within()` on a composite that isn't the last send `begins_with`, so a row truncated at that level isn't returned. With `escapeKeys: true` they find it.
- `NaN` composes 1.36's text rather than failing with `EDD-9096`, which stays under `escapeKeys: true`.

**GSI write sharding.** `shards: n` or `{ count, by?, previous? }` on a secondary index stores one logical partition in N physical ones, for an index key that takes more than a partition's 1,000 WCU/s. Writes hash the item to pick a shard, and every terminal reads the shards and merges them into index order, so no caller names a shard.

- **Key text:** `!<count>.<shard>` right after the entity type or collection name, before all values, so no value can spell it and two layouts can't overlap.
- **`by`:** hash sort key composites instead of the primary key, so a query pinning them reads one shard. An update that changes a `by` attribute moves the entry, and fails with `EDD-9100` when the new key can't be composed, including when the sort key can't follow it under `preserve`. An unsharded key is never written.
- **Reads:** `.concurrency(n)` and `Query.concurrency`, `QueryExplain.fanOut`, cursors with one position per shard, `.maxPages(n)` counted in rounds. `.within()`, skip-scan, `.zorder()` and `GeoIndex` are refused on a sharded index (`EDD-9104`).
- **Adoption:** deploy with `previous`, run `db.tables.<Table>.rekey()`, and remove `previous` once a run reports no conflicts. `RekeyConflict.reason` gains `"uncomposable"`.
- **Pruning:** a query reads one shard when the accessor pins every attribute of the shard source, `by` or the primary key alike. The unbound `Query.where()` replaces what was pinned, so it reads every shard again.
- **New codes:** `EDD-9099` to `EDD-9106`. An index without `shards` keeps its cursor format and range planning.

**Fix: inverted indexes, as 1.37.0 and 1.38.0 left them.** With an index half in a table key attribute, those releases composed the attribute's text differently in its two roles, so a value a sort key escapes overwrote a table key: `userId: "u 1"` stored `pk` as `userid_u%201`, so `get` failed and `delete` reported success and left the row, and `groupId: "a b"` made `put` fail. One rule now composes every key, so both roles build one text under either setting. `rekey` recognises the row those releases left and moves it, an escape in each half included. An inverted index is supported, not encouraged: index keys belong in dedicated attributes.

**Behaviour change: definitions refused at load.**

- **`EDD-9106`:** two key halves of one entity sharing an attribute without the same fields, in the same order and casing, or a sharded partition key sharing one with a half not sharded the same way. Such a definition worked for `put` and query while no item held both accessors' composites, but a row can't show which half owns the attribute: the one written last overwrites the other, and an ordinary update corrupts even a row that only used one. The check runs per entity, so several entities can still overload one index. Two number-only or numeric Z-order halves with different casings are refused too.
- **`EDD-9108`:** one entity using one physical index twice, even over the same fields.
- **`EDD-9109`:** a model attribute, a system timestamp or a version field stored in an attribute of the table's primary key, by a `field` rename or by its own name. A `put` would overwrite the key it composed.
- **`EDD-9112`:** an aggregate's list key or collection sort key stored in an attribute of the table's primary key.

To keep an access pattern one of them refuses, give each key its own attribute, which means a new index, and re-put existing rows.

**Behaviour change: an update refuses to name a table key attribute.** `.remove()`, `.set()` and the other update operations naming an attribute of the table's primary key by its stored name fail with a `ValidationError` and write nothing. No write path sets any part of the primary key: a key changes only by moving the row.

**Public API.**

- `KeyComposer.composeEventSk` takes the schema first. The old three-argument form still works, is deprecated, and doesn't follow `escapeKeys`.
- `KeyComposer.composeSortKeyCondition` can return `{ between }` too: a partial prefix on a secondary index under `escapeKeys: true`. A caller handling only `eq` and `beginsWith` needs a branch for it.
- `KeyComposer.serializeValue` and `extractComposites` keep the numeric text 1.37.0 gave them under either setting, which differs from 1.36 for a number whose text changed. `compositeText`, `keyValueText` and `extractKeyComposites` follow the setting.
- `KeyComposer.sortKeyText` and `serializeSortKeyValue` mean what they did, and are deprecated: use `keyText` and `keyValueText`, which follow the setting, or `escapeKeyText`.

**Fix, every secondary index: a pin finds the row truncated at that level, with `escapeKeys: true`.** A partial sort key pin, `.where(eq)` on a composite that isn't the last, and an `eq` in `.within()` missed a row whose key an update had truncated there, and returned everything under it. Under `escapeKeys: true` they send `BETWEEN <prefix> AND <prefix>#U+FFFF`, which selects that row and its subtree and no longer sibling. The primary key is unchanged (`begins_with`), and the default keeps `begins_with` as 1.36 did.

**Fix, every secondary index: an unrelated update leaves a half mixing a primary key composite with a mutable one.** Since 1.7.2 one composite in the key woke the half, so `.set({ status })` on `primaryKey: [channel, deviceId]` removed `sk: [zone, deviceId]` under `sparse`, taking the item out of the index, and truncated `sk: [deviceId, zone]` or `pk: [channel, zone]` under `preserve`. `.append` did the same. A half now wakes through the key only when the key holds every composite. An item lacking the mutable composite no longer joins that index on an unrelated write; it joins when a write names the composite. Rows already damaged stay as they are until a write names the half's composites or the item is put again.

**Fix, every secondary index: `rekey` and truncated keys.** `rekey` now rewrites a sort key truncated under 1.36, which it used to leave, when the key is exactly what 1.36 composed for the composites before the gap. An index key that isn't any text its row's values composed is left, with no count: a row may have cleared one of its composites, or the key may lag them. A pin misses such a row if its text changed, a broader query or `get` still finds it, and writing the composites puts it back.

**Fix, every secondary index: a retained update keeps an entry `preserve` kept.** An update on a `versioned: { retain: true }` entity deleted an index entry when it could compose neither half, including one `preserve` had just kept for a cleared composite. It now leaves the entry, as an ordinary update does.

**Fix, every secondary index: an update on an entity with an index half in a table key attribute.** A local index's partition key, an inverted index or a sort key shared with the table made every update fail, as DynamoDB refuses one that names a table key attribute. Updates no longer write one, and a version snapshot, tombstone or event keeps it.

**Fix: `.remove()` of a primary key composite.** `update(key).remove(["tenant"])` and `Entity.remove` deleted the attribute and kept the key, so the row stopped decoding for `get`, `scan` and every other reader. The update reported the decode failure after the write, a transaction reported success, and a `versioned: { retain: true }` entity failed with a defect and wrote nothing. They now fail with the `ValidationError` a `.set()` of that attribute gets and write nothing, as do `.remove()` and any path operation naming the composite by its stored attribute. A row already damaged isn't repaired, and `rekey` counts it in `skipped.unrecognizedKey`: put the item again to restore it.

**Fix: `rekey` reporting a false `"bothKeys"`.** A row moved between its two reads, by another row's move in the same run or by a write, read as under both keys. A rerun cleared it.
