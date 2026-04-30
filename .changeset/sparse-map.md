---
"effect-dynamodb": minor
"@effect-dynamodb/geo": minor
"@effect-dynamodb/language-service": minor
---

Add **SparseMap** storage primitive (`storedAs: 'sparse'`) — flattened storage for logical `Record<K, V>` fields, with each map entry stored as an independently addressable top-level DynamoDB attribute named `<prefix>#<key>`.

The headline win is per-bucket atomic counters on a fresh item without parent-map ceremony — `ADD totals#2026-01 :1` works as a single op on a row that has never been touched before. Concurrent writers to disjoint buckets never race.

**API surface:**

- `DynamoModel.configure(model, { field: { storedAs: 'sparse' } })` — opt in. Optional `prefix` override.
- Reads transparent — `get` / `query` / `scan` / batch / streams rebuild the domain `Record<K, V>` from flattened attributes.
- Record-style writes: `.set({ field: { ... } })` decomposes into one SET per bucket (whole-bucket replace; concurrent disjoint-bucket writes safe).
- Path-style writes: `PathBuilder.entry(key)` plus `.pathAdd` / `.pathSet` for atomic per-leaf updates within a known bucket. Counter case (scalar buckets) needs no bucket ceremony.
- `.removeEntries(field, keys)` — explicit per-key REMOVE (`null` in record-style is **not** REMOVE — too footgunny).
- `.clearMap(field)` — Get-then-Update helper that folds REMOVE clauses into the same final UpdateItem as the rest of the builder's combinators. Atomic for `versioned: { retain: true }` entities; best-effort for non-versioned.
- Conditional ops: `attribute_exists(<prefix>#<key>)` via the path API.

**Lifecycle interactions:**

- `versioned: { retain: true }` — snapshots preserve flattened attrs verbatim.
- `softDelete` — sparse data is preserved across soft-delete and restore.
- `timeSeries` — sparse fields are aggregate state, not event state. They live on the current item only and are **not** carried on event items (`#e#<orderBy>`).

**Validation at `Entity.make()` (EDD-9020..9023):** sparse fields must be `Schema.Record`, must not be nested-sparse, must not participate in primary-key/GSI composites or unique constraints, must have distinct prefixes that don't collide with non-sparse field names. User-supplied keys must not contain `#` (validated at write time; no silent escaping).

See `docs/guides/sparse-maps` for the full guide and `examples/guide-sparse-maps.ts` for a runnable program.
