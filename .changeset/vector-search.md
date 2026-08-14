---
"effect-dynamodb": minor
"@effect-dynamodb/schema": minor
"@effect-dynamodb/geo": minor
"@effect-dynamodb/language-service": minor
---

Native DynamoDB vector search (closes #78).

Declare vector indexes on an entity and the library handles the rest — embedding
generation on write, partition composition, lifecycle stripping, and a fluent
search builder:

```ts
const Products = Entity.make({
  model: Product,
  entityType: "Product",
  primaryKey: { pk: { field: "pk", composite: ["tenantId", "productId"] }, sk: { field: "sk", composite: [] } },
  vectorIndexes: {
    byDescription: {
      name: "vec1",
      dimensions: 1024,
      distance: "cosine",
      source: { fields: ["name", "description"] },
      partition: ["tenantId"],
      filters: ["category"],
    },
  },
})

const hits = yield* db.entities.Products
  .byDescription("waterproof hiking boots")
  .partition({ tenantId })
  .filter({ category: "footwear" })
  .topK(25)
  .collect()
```

- **Pure models.** The embedding (`__edd_v_<index>__`) and composed HASH
  partition (`__edd_vp_<index>__`) are library-managed and never surface in a
  decoded record.
- **Automatic entity + tenant scoping.** The partition value is composed by
  `KeyComposer` as `$schema#v1#<entityType>[#composites]`, so a search on a
  shared physical index cannot cross entity types or tenants.
- **`Embedder` service** (`@effect-dynamodb/schema`, AWS-free) with an in-library
  `Embedder.layerTest`. Dimension agreement is validated at `DynamoClient.make`.
- **Write gating.** `put`/`create`/`upsert` always embed; `update`/`patch` embed
  only when the write touches a `source.fields` member — by `set()`, `remove()`,
  a null clear, or a path operation. Clearing every source field removes the item
  from the index. `.withVector()` supplies a pre-computed embedding (its name is
  typed and validated); `reembed({ concurrency })` migrates stale vectors.
- **Declared filters only.** Only attributes listed in an index's `filters: [...]`
  are filterable — enforced by the accessor types, at runtime, and by the
  emulation layer. Entities sharing a physical index union their filters.
- **Typed errors.** `EmbeddingError` is in the `put`/`create`/`update`/`patch`/
  `upsert` error channel for entities that declare `vectorIndexes`, and absent
  for those that don't.
- **Lifecycle-aware.** Version snapshots, soft-delete tombstones and time-series
  event items drop out of the index; the tombstone stashes the embedding so
  `restore()` never re-embeds.
- **Table ops.** `create()` emits merged `VectorIndexes`; `addVectorIndex`,
  `removeVectorIndex` and `waitForVectorIndex` manage them on a live table.
- **`VectorSearchEmulation.layer`** stands in for DynamoDB Local, which discards
  `VectorIndexes` and rejects `SearchVectors`.

Requires `@aws-sdk/client-dynamodb` >= 3.1104.0 (bumped). The raw operation needs
the new `dynamodb:SearchVectors` IAM action, which existing read policies do not
cover.

Also fixes an unrelated pre-existing bug found along the way: `upsert` did not
store the model fields that compose the primary key (it skipped them as "already
in the Key", but the Key holds the *composed* `pk`/`sk` strings, not the
composite source values). Upserted items were stored without e.g. `productId`,
so every subsequent read — including `upsert`'s own `ReturnValues: ALL_NEW`
decode — failed with `Missing key`.
