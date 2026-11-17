---
"effect-dynamodb": minor
"@effect-dynamodb/schema": minor
"@effect-dynamodb/geo": minor
"@effect-dynamodb/language-service": minor
---

Shard one value of an index without sharding the rest: per-value shard layouts (#287).

- `shards: { by?, layouts: { default, values: [{ match, layout }] } }` gives a sharded secondary index a layout per partition key value, so one busy tenant can take 20 shards while every other tenant keeps one partition and one request per query. A layout is a count or `{ count, previous }`. `match` names every partition key composite of the index, with editor completions and a compile error on a typo. `shards: 20` and `{ count, by, previous }` keep working, as a table with only a default.
- A value is looked up by the partition key text it composes, so every spelling of one key gets one layout: under the default `lowercase` casing, `"T-BIG"` and `"t-big"` share an entry. Two entries composing one key are refused (`EDD-9099`).
- A value whose layout is 1 composes the unsharded key and runs one plain query, with the same requests and cursor as an index without `shards`. `{ count: 1, previous: 20 }` moves a value, or a whole index, back to unsharded. The rules of a sharded index (`.within()` refused, `by` on updates) apply to every value of an index with a table.
- `shards: { layouts: "provided" }` takes the table at run time from a `ShardLayouts` layer: `ShardLayouts.layer([ShardLayouts.of(Devices, { byTenant: table })])`, where the table can be a `Config` (one JSON variable through the `ShardLayouts.Table` schema, for example), or `ShardLayouts.layerEffect(...)` for a table read at startup, such as from a config item. `DynamoClient.make` reads it when it binds, so bound operations keep `R = never`; `Transaction`, `Batch`, `EventStore.append({ additionalItems })`, projections and `rekey` read it where they run. A missing table is `EDD-9181` at `DynamoClient.make` or before the first operation sends anything, never a fallback; a misused `ShardLayouts.of` is `EDD-9182`.
- `explain()` reports `shards: { count, previous, partitions }` for the pinned value. `rekey` judges every row of an index with a table by its own value's layout, so `rekey({ dryRun: true })` reports what a change of one value's entry left to move. A change to an entry is a migration for that value: `{ count: 20, previous: 1 }`, `rekey`, then `20`, each step finished once every process runs it. The [Write Sharding guide](https://jmenga.github.io/effect-dynamodb/guides/sharding/#per-value-layouts) walks through it.
- Collection members compare their tables by content (`EDD-9103`). The language service hover shows an index's table and says the layout varies by value.
