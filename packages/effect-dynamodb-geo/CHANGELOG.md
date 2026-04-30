# @effect-dynamodb/geo

## 1.6.0

### Minor Changes

- indexPolicy v2 — unified-hierarchy attribute model, three-way payload classification, hierarchical SK pruning, hole detection. Plus the SparseMap opt-in is renamed to a typed callable.

  **indexPolicy v2 — behavior changes (closes [#36](https://github.com/jmenga/effect-dynamodb/issues/36))**
  - The runtime now distinguishes three payload states per composite attribute: present-with-value, explicit clear (`null` or `undefined`), and omitted. `null` and `undefined` collapse — both signal "explicit clear, drop this composite from the key now" — and they cascade unconditionally regardless of policy.
  - Omission still defers to `indexPolicy` (`'sparse'` drops the GSI; `'preserve'` is a no-op).
  - Pre-1.6 collapsed omission and explicit `null`/`undefined`, with `'sparse'` firing on every update regardless of whether the caller touched that composite. **Audit any existing `set({ attr: null })` paths** — intent is now unambiguous (always cascades). Switch any `'sparse'` policies that aren't really membership-driving (hybrid-writer GSIs) to `'preserve'`. See the migration table in the [indexPolicy guide](https://github.com/jmenga/effect-dynamodb/blob/main/packages/docs/src/content/docs/guides/index-policy.mdx#migrating-from-150).

  **Hierarchical SK pruning — new opt-in feature**
  - When a _trailing_ SK composite is explicitly cleared with `'preserve'` policy, `gsiNsk` truncates to the leading prefix instead of dropping the GSI entirely. The item stays queryable at the parent (coarser) hierarchy depth — geographic, org, workflow, content classification, permission scope, order grouping. See DESIGN.md §7.6.

  **Hole detection — new write-time validation**
  - An SK composite cleared at position `i` with another SK composite at position `j > i` still present produces a syntactically invalid prefix that no `begins_with` query would match. The library now throws `CompositeKeyHoleError` (EDD-9024) at write time, naming the GSI, the cleared composite, and the offending trailing composite. Pre-existing latent bugs (silent broken keys) become loud failures.

  **SparseMap API rename — breaking change, low blast radius**
  - `storedAs: 'sparse'` (magic string) → `storedAs: DynamoModel.SparseMap()` (typed callable). The `prefix` option moves from a sibling on `ConfigureAttributes` into the `SparseMap({ prefix })` config object — where it semantically belongs.
  - 1.5.0 was the only release that used the magic string; consumer adoption is minimal. No backward-compat shim — mechanical rename.
  - Two motivations: (1) the magic-string `'sparse'` collided with the `indexPolicy` `'sparse'` value (opposite meanings), confusing consumers; (2) the callable form lets options live where they belong rather than as siblings only meaningful when paired with the right `storedAs` value.

  **Type-level changes**
  - `EntityUpdateType` now widens each field to `T | null | undefined` so consumers can express explicit clears through TypeScript without casting. The runtime already accepted them via `Schema.NullishOr` wrap.
  - `ConfigureAttributes.storedAs` becomes `Schema.Schema<A> | SparseMapConfig`. The `| 'sparse'` literal union is dropped.
  - `ConfigureAttributes.prefix` removed from top level.
  - New exports: `DynamoModel.SparseMap`, `DynamoModel.SparseMapConfig`, `DynamoModel.isSparseMapConfig`, `CompositeKeyHoleError`, `makeCompositeKeyHoleError`, `KeyComposer.composeSkPrefixUpTo`.

## 1.5.0

### Minor Changes

- 7a7e72f: Add **SparseMap** storage primitive (`storedAs: 'sparse'`) — flattened storage for logical `Record<K, V>` fields, with each map entry stored as an independently addressable top-level DynamoDB attribute named `<prefix>#<key>`.

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

## 1.4.0

### Minor Changes

- fix(entity): correct codec direction so RedactedFromValue and other transform schemas round-trip ([#29](https://github.com/jmenga/effect-dynamodb/issues/29))

  The write paths (`put`, `create`, `update`, `upsert`, `append`, batch/transaction puts) now run `Schema.encode` end-to-end against the entity's input/update schema so any Effect Schema transform (e.g. `Schema.RedactedFromValue`, `Schema.NumberFromString`, `Schema.DateTimeUtcFromString`, custom `decodeTo` chains) round-trips cleanly. Previously the put path validated against the encoded form, which rejected domain instances like `Redacted.make(...)` with `Invalid data <redacted>`.

  Storage-format substitution: at `Entity.make()` time, self date schemas (`Schema.DateTimeUtc`, `Schema.DateTimeZoned`, `Schema.DateValid`) carrying a `DynamoEncoding` annotation are substituted with bidirectional date transforms whose wire format matches the legacy `serializeDateForDynamo` output byte-for-byte. `Schema.RedactedFromValue(...)` fields are substituted with a tolerant Redacted transform (Effect v4's `RedactedFromValue` forbids encoding by default).

  **Breaking change** (narrow): combining a transform schema with a `DynamoEncoding` storage override now raises a clear error at `Entity.make()` time, e.g.

  ```
  [effect-dynamodb] Field "createdAt": cannot apply DynamoEncoding storage override to a transform schema. Either declare a self schema (Schema.DateTimeUtc) and let the annotation drive storage, OR declare a transform and own the wire format — not both.
  ```

  Migrate by either declaring a self schema (`Schema.DateTimeUtc.pipe(DynamoModel.storedAs(...))`) or dropping the override.

  Closes [#29](https://github.com/jmenga/effect-dynamodb/issues/29).

## 1.3.3

### Patch Changes

- [#28](https://github.com/jmenga/effect-dynamodb/pull/28) [`520035b`](https://github.com/jmenga/effect-dynamodb/commit/520035b844e1c49b06bbaefdeba7d99e522b63b5) Thanks [@jmenga](https://github.com/jmenga)! - Fix: unique-constraint sentinels are now sparse — they are only written when every composing field is present on the record (mirrors GSI sparse semantics). Previously, `Entity.put` / `.create` and the related update / delete / restore / purge paths called `KeyComposer.serializeValue(undefined)`, which coerced missing values to the literal string `"undefined"` and synthesized a sentinel keyed on that string. The first record with the field unset succeeded; every subsequent record collided with a false `UniqueConstraintViolation` (issue [#25](https://github.com/jmenga/effect-dynamodb/issues/25)).

  The sparse rule applies symmetrically across all six sentinel sites: `put`/`create`, `update` rotation, hard-delete cleanup, soft-delete cleanup, `restore` re-establish, and `purge` cleanup. The update path now distinguishes four transition states — `undefined → undefined` (no-op), `undefined → defined` (Put only), `defined → undefined` (Delete only), and `defined → defined, changed` (Delete + Put) — instead of unconditionally rotating both sides.

  Migration: any deployment running 1.3.x with a unique constraint on an optional field may have phantom sentinel rows of the form `<entity>._unique.<name>#undefined`. The new code never reads or writes them, so they are harmless; clean them up with a one-time scan if desired.

## 1.3.2

### Patch Changes

- fix(entity): `decodeMarshalledItem` tolerates missing GSI key attributes on sparse-indexed items. `itemSchema` previously required every GSI pk/sk field as `Schema.String`, so decoding a DynamoDB Stream `NewImage` for an item whose GSI composites haven't been stamped yet (e.g. ingest-before-enrichment patterns) failed with `ValidationError: MissingKey`. GSI key fields are now `Schema.optional(Schema.String)` in `itemSchema`; primary pk/sk remain required. Closes [#16](https://github.com/jmenga/effect-dynamodb/issues/16).

## 1.3.1

### Patch Changes

- Fix: `Entity.update` retain path (`versioned: { retain: true }`) marshalled domain `DateTime.Utc` values as DynamoDB Maps, corrupting writes and breaking subsequent reads.

  **Regression introduced in 1.3.0.** The retain path built `newItem` by spreading `currentRaw` (storage primitives from DynamoDB) with `hydratedUpdates` (decoded via the new `fromSelf` variants, so date fields are domain `DateTime.Utc` instances), then called `toAttributeMap(newItem)` without a `serializeDateFields` pass. AWS SDK's `marshall` with `convertClassInstanceToMap: true` then stored the DateTime class as a Map:

  ```json
  "updatedAt": { "M": { "epochMilliseconds": { "N": "..." }, "~effect/time/DateTime": { "S": "..." }, "_tag": { "S": "Utc" } } }
  ```

  Subsequent reads failed with `deserializeDateFromDynamo: expected string for DateTime.Utc/string, got object`.

  **Fix:** Pre-serialize `hydratedUpdates` to storage primitives before merging into `newItem`, mirroring what the non-retain path already does. The system-field block reads from the serialized map, so user-supplied colliding `updatedAt` values also land as storage primitives (not Maps). Affects any entity with `versioned: { retain: true }` that has model-declared date fields or uses the collision-aware timestamp pattern from 1.3.0.

  Put, upsert, append, and non-retain update paths were already correct — only the retain path was missing the serialization step.

## 1.3.0

### Minor Changes

- Domain-value input decode, timestamp collision handling, and adaptive generation.

  **Fixes [#19](https://github.com/jmenga/effect-dynamodb/issues/19)** — `Entity.put/create/update/upsert` (and `Transaction`/`Batch` put paths) now correctly decode domain values. Previously, TypeScript said "pass me a `DateTime.Utc`" but the runtime decoded via a transform schema that expected an ISO string — callers who followed the TS contract hit a `ValidationError`. The runtime decode now uses `fromSelf` variants for date-annotated fields, matching the TS contract.

  **New: declare system-field-colliding timestamps in your model.** If your domain model declares `createdAt` / `updatedAt` with a date-compatible schema (e.g. `Schema.DateTimeUtcFromString`, `Schema.DateFromString`, `Schema.DateTimeUtc`), and `timestamps: true` is set:
  - The input type marks the colliding fields as optional — caller may omit them (library auto-generates) or supply their own value (user value wins, useful for imports/backfill).
  - The library-generated timestamp respects the model field's storage encoding, so declaring `createdAt: Schema.DateTimeUtcFromString.pipe(DynamoModel.storedAs(DynamoModel.DateEpochSeconds))` yields epoch-seconds storage even though the library is generating the value.
  - `createdAt` is treated as immutable in the update schema (stripped entirely).

  **New: user-owned non-date fields that collide with a system field name.** If your model declares e.g. `createdAt: Schema.String` (as a user-managed composite value, not a timestamp), the library detects the non-date collision and yields the field to the user — library timestamp management applies only to non-colliding fields (e.g. `updatedAt`). Preserves existing patterns that use `createdAt` as a plain string SK composite.

  **Errors:**
  - `EDD-9021` — the `version` field cannot be declared in the model alongside `versioned: true`, because optimistic locking requires library-managed increment.

  **Type ergonomics.** The exposed `inputSchema` / `createSchema` / `updateSchema` codec types (and the corresponding `Entity.put` / `create` / `update` call signatures) now flatten into plain object literals in hover tooltips instead of showing as wrapped generic aliases.

## 1.2.0

## 1.1.0

## 1.0.0

### Minor Changes

- [#4](https://github.com/jmenga/effect-dynamodb/pull/4) [`76654b7`](https://github.com/jmenga/effect-dynamodb/commit/76654b7a6d35a361fe74a2733bdfb1ce837504bf) Thanks [@jmenga](https://github.com/jmenga)! - Add `.primary()` query accessor on the bound client

  Every entity now exposes a `.primary(...)` accessor on `db.entities.*` alongside the existing GSI accessors. The primary index is treated symmetrically with GSIs: pass required PK composites (and optionally one or more SK composites) to get back a `BoundQuery` with the full combinator surface (`.where()`, `.filter()`, `.select()`, `.limit()`, `.reverse()`, `.startFrom()`, `.consistentRead()`, `.collect()`, `.fetch()`, `.paginate()`, `.count()`).

  Previously the primary index was deliberately excluded from accessor generation, so the shared-PK join-table pattern (many items under one partition key, distinguished by SK) had no first-class typed query path — only `.get(fullKey)` or a raw `Query.make` escape hatch.

  ```ts
  // List every membership in an organization — PK only, SK composites omitted
  const allMembers =
    yield *
    db.entities.Memberships.primary({
      orgId: "org-acme",
    }).collect();

  // Narrow by partial SK composite (begins_with prefix match)
  const bobs =
    yield *
    db.entities.Memberships.primary({
      orgId: "org-acme",
      userId: "u-bob",
    }).collect();
  ```

  `.get(fullKey)` remains the dedicated `GetItem` path for single-item strongly-consistent reads. Resolves [#2](https://github.com/jmenga/effect-dynamodb/issues/2).

### Patch Changes

- Updated dependencies [[`76654b7`](https://github.com/jmenga/effect-dynamodb/commit/76654b7a6d35a361fe74a2733bdfb1ce837504bf)]:
  - effect-dynamodb@1.0.0
