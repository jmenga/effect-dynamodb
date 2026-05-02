# @effect-dynamodb/geo

## 1.7.3

### Patch Changes

- **indexPolicy v1.7.3 — reframe per-half evaluation gate as skip-predicate (closes [#46](https://github.com/jmenga/effect-dynamodb/issues/46)).**

  **What broke.** Under v1.7.0 / v1.7.1 / v1.7.2, `Entity.update()` silently skipped composing GSI keys for halves declared with `composite: []` (the standard "bare entity prefix" pattern, common in single-table-design lookup GSIs like `byDeviceBinding: { pk: [deviceBinding], sk: { composite: [] } }`). Items written via `.put()` were correct — but any subsequent `.update()` that touched the OTHER half left the empty-composite half missing → invisible to the GSI. Worse, an `.update()` that bound a previously-sparse GSI for the first time wrote only the PK half, leaving the SK missing.

  **What was wrong.** The per-half evaluation gate was a "touched" predicate — a chain of `||` clauses each enumerating a shape for which to evaluate the half (payload membership in v1.7.0; `removedSet` in v1.7.1; `keyRecord` in v1.7.2). Each missed shape required another tactical patch — `.some(...)` over an empty composite array trivially returns `false`, so empty-composite halves got classified as untouched and skipped.

  **Fix.** Reframe the gate as a **skip-predicate** keyed on the gate's actual purpose (multi-writer protection): skip iff composites exist (otherwise the half value is a constant prefix), no composite was explicitly removed, and every composite is absent from BOTH `updatePayload` AND `keyRecord`. The skip-predicate's negation is observably equivalent to the cumulative `||`-chain plus `composites.length === 0` — same SET/REMOVE outcomes for every existing input. Closes [#46](https://github.com/jmenga/effect-dynamodb/issues/46) directly and the class of degenerate-case bugs that v1.7.0 → v1.7.2 patches were chasing as separate `||` arms.

  **Affected items.** Items written under v1.7.0 / v1.7.1 / v1.7.2 against entities with empty-composite-half GSIs will repair themselves on the next `Entity.update()` against them under v1.7.3. The next write composes the missing half from the constant prefix and the item rejoins the GSI. No data migration is needed; reads via the GSI start returning these items as their next update lands.

  **No API changes.** Purely an internal gate-logic refactor — same observable behavior for every input the previous gate already handled correctly, plus correct behavior for the empty-composite-half shape that was silently broken.

## 1.7.2

### Patch Changes

- **indexPolicy v1.7.2 — fix PK-composites-only GSI regression (closes [#43](https://github.com/jmenga/effect-dynamodb/issues/43)).**

  v1.7.1 introduced a per-half evaluation gate that — by design — skipped GSI evaluation on halves the writer didn't touch. Unfortunately the gate consulted only `updatePayload` and so silently classified entire GSIs as untouched whenever their composites were entirely entity primary-key composites. Those PK composites never appear in `updatePayload` (writers address the row by key, never restate them in `.set({...})`, and `.append()` filtered them out before passing to the composer). The composer never ran, `gsiNpk` and `gsiNsk` were never written, and items were invisible to the GSI for their lifetime.

  Concretely: an entity with `primaryKey: [channel, deviceId]` and a `byChannel: { pk: [channel], sk: [deviceId] }` GSI saw zero items returned from any channel-scoped query under v1.7.0 / v1.7.1, regardless of whether the writes used `.put()`, `.update()`, or `.append()` — the latter two never composed the keys, and `.update()` only re-composed them on calls that explicitly restated `channel` / `deviceId` in the payload (which no realistic writer does).

  **The fix** (two minimal patches working together):
  1. **`KeyComposer.composeGsiKeysForUpdatePolicyAware`** — the per-half gate now also counts `keyRecord` membership (the entity primary-key attributes carried into the composer alongside the payload). PK-composite-only GSI halves are now correctly classified as touched on every write that has a `keyRecord`.
  2. **`Entity.append()`** — no longer filters PK composites out of the payload it passes to the composer. The filter never solved a real problem (the composer doesn't emit redundant SETs for the underlying composite fields, and idempotent recomposition from immutable PK composites is benign) and combined with the v1.7.1 gate to silently break this pattern.

  The change is idempotent for entity-PK composites (re-composing the same value from immutable PK composites produces the same key) and preserves the v1.7.1 multi-writer fix: stamps' GSI composites are not in `updatePayload` AND not in `keyRecord` either (they're enrichment-owned model attrs), so their halves remain untouched as designed.

  **Affected items:** items written to PK-composites-only GSIs under v1.7.0 or v1.7.1 will repair themselves on the next `Entity.update()` against them. The gate now fires correctly, the structural rule composes the immutable PK values, and the missing GSI keys are SET. **No data migration required** — reads via the GSI start returning these items as their next update lands. If you have items that aren't naturally updated, a one-shot bulk `Entity.update(key).set({ otherField: value })` (or even an empty-payload update touching only `updatedAt` + version) is enough to repair them.

  **No API changes** — same `indexPolicy: { pk, sk }` declaration shape, same `Entity.update` / `Entity.append` signatures, same EDD-9025 invariants. Behavior change is strictly more correct than v1.7.1.

  See `DESIGN.md §7` for the updated decision algorithm and `guides/index-policy.mdx` for the updated walkthrough plus the _byChannel GSI returns 0 items_ pitfall.

## 1.7.1

### Patch Changes

- **indexPolicy v1.7.1 — per-half roll-up corrections (closes [#41](https://github.com/jmenga/effect-dynamodb/issues/41)).**

  v1.7.0 shipped the per-key declaration model (`indexPolicy: { pk, sk }`) but had three connected bugs in how outcomes were rolled up. All three were rooted in the same defect: the model was per-half on declaration but not on evaluation, outcome, or cascade. v1.7.1 makes all four uniformly per-half.

  **Bug fixes** (strictly more correct than v1.7.0):
  1. **GSI-wide cascade on can't-compose → per-key REMOVE.** v1.7.0 REMOVE'd both `gsiNpk` AND `gsiNsk` whenever either half couldn't compose. v1.7.1 REMOVEs only the half that couldn't compose; the other half's stored value persists. Closes the multi-writer enrichment-on-pk + telemetry-on-sk scenario that v1.7.0 was designed to enable but didn't actually enable correctly.
  2. **`CompositeKeyHoleError` (EDD-9024) deprecated — no longer thrown.** The v1.7.0 throw under preserve+hole was a defensive runtime safety net for a case the type system already catches (required composites can't be omitted under `exactOptionalPropertyTypes` since v1.7.0 reverted the NullishOr widening). The class export is preserved for back-compat with consumers who type-imported it for `Effect.catchTag` handlers, but no code path raises it anymore. Hole patterns now collapse into the unified per-half can't-compose rule.
  3. **Per-half evaluation gate (NEW in v1.7.1).** v1.7.0 fired the policy on every update of every GSI declaring `indexPolicy`, regardless of whether the writer touched the half. This made stamps and unrelated writers blow away sparse halves they didn't own. v1.7.1 skips untouched halves entirely — a half is touched iff at least one of its composite names appears in the update payload OR in `Entity.remove([...])`.

  **Behavior change:**
  - **`Entity.remove([attr])` is now per-half** (no longer GSI-wide). Removing a composite REMOVEs only the half(s) whose composite list contains it. Other halves follow the per-half evaluation gate (untouched → noop). Combined with the new "cascade override under preserve" rule, the consumer's explicit signal still gets honored — preserve + can't-compose + composite in `removedSet` → REMOVE that half.

  **No API changes:**
  - Same `indexPolicy: { pk, sk }` declaration shape.
  - Same `Entity.remove([...])` API.
  - Same EDD-9025 invariants (composite attributes can't be `Schema.NullOr`).
  - Same `Schema.optional(...)` pattern for sparse composites.

  **v3 model preserved:** the per-key declaration, two-way payload classification, and EDD-9025 footgun gate from v1.7.0 are all preserved unchanged. v1.7.1 only fixes the roll-up.

  See `DESIGN.md §7` for the full v1.7.1 decision algorithm and the `guides/index-policy.mdx` rewrite for the concept-first walkthrough.

## 1.7.0

### Minor Changes

- [`5825d73`](https://github.com/jmenga/effect-dynamodb/commit/5825d73488a255733b965ab2c8e93e1c92c38517) Thanks [@mixja](https://github.com/mixja)! - **indexPolicy v3 — per-half model, structural composition, EDD-9025 invariant.** Closes [#39](https://github.com/jmenga/effect-dynamodb/issues/39) and supersedes [#38](https://github.com/jmenga/effect-dynamodb/issues/38).

  > **Heads up — breaking changes inside a minor bump.** The 1.6.0 → 1.7.0 transition would normally be a major bump on semver grounds, but in-the-wild consumer count is currently ~1 (the author's own consumer migration), so the bump is shipped as minor to accelerate iteration. Future consumers should treat 1.7.0 as if it were 2.0.0 and read this entry before upgrading.

  The v1.6 per-attribute `indexPolicy` callback model proved unwieldy in practice. The standard `update`/`patch` path has only payload-level information (no read-before-write), so per-attribute granularity within a single composed-key half collapsed to per-half outcomes anyway. v3 simplifies to a per-half declaration with a structural composition rule, and closes the `set({composite: null})` footgun at the type level.

  ### What's new in v1.7.0
  - **Per-half `indexPolicy: { pk, sk }`.** Both halves default to `'preserve'` when omitted. Replaces the v1.6 `indexPolicy: (item) => ({ attr: 'sparse' | 'preserve' })` callback API.
  - **Structural composition (longest valid leading prefix).** Symmetric on PK and SK — the v1.6 PK-clear-degrades-to-sparse asymmetry is gone. Hierarchical PK truncation (e.g. `pk.composite = ['accountId', 'fleetId']` → omit `fleetId` → partition key truncates to `account#A`) is **new and additive**.
  - **Two-way payload classification.** `null` = `undefined` = absent. The v1.6 three-way classification (present / explicit-clear / omitted) collapses; `set({attr: null})` no longer separately cascades GSI keys.
  - **Two coherent drop triggers** — both predictable, both tied to clear caller intent:
    - `Entity.remove([attr])` cascade (per-attribute, explicit, per call) — unchanged.
    - `'sparse'` policy + whole-half-empty (per-half, implicit, declared at the index) — narrower than v1.6's per-composite leakage.
  - **Policy-aware hole detection.** Hole pattern (`[A, _, C]`) under `'preserve'` throws `CompositeKeyHoleError` (EDD-9024); under `'sparse'` truncates to the leading prefix (or, if the leading prefix is empty, collapses to whole-half-empty + drop).
  - **EDD-9025 — `CompositeNullableError`.** New `Entity.make()` validation that walks every composite (across `primaryKey`, every entry in `indexes`, every entry in `unique` constraints) and throws if the composite's Schema includes `null` in its type union (`Schema.NullOr`, `Schema.NullishOr`, `Schema.Union` with a Null branch). Composites participate in string composition; null is not a meaningful slot value.
  - **Append unifies with update.** `.append()` now calls the same composer as `.update().set()` — the v1.6 `appendInput`-policy-filter wrapper is gone. Composites outside `appendInput` are simply absent under the structural rule.
  - **`writerScope` (proposal [#38](https://github.com/jmenga/effect-dynamodb/issues/38)) is superseded.** v3's narrower implicit-drop trigger eliminates the cross-writer leakage that motivated `writerScope`.

  ### Breaking changes — migration

  **Per-attribute callback → per-half object literal.** Take the most-restrictive per-attribute policy on each half:

  ```diff
   indexes: {
     byAlert: {
       name: "gsi1",
       pk: { field: "gsi1pk", composite: ["alertState"] },
       sk: { field: "gsi1sk", composite: ["deviceId"] },
  -    indexPolicy: () => ({ alertState: "sparse" }),
  +    indexPolicy: { pk: "sparse", sk: "preserve" },
     },
   }
  ```

  **`set({attr: null})` no longer cascades GSI drop.** Use `Entity.remove([attr])` for atomic remove + GSI cascade:

  ```diff
  - yield* db.entities.Devices.update(key).set({ alertState: null })
  + yield* db.entities.Devices.update(key).remove(["alertState"])
  ```

  **Update-payload type widening reverted.** v1.6 wrapped each update field in `Schema.NullishOr`. v1.7 reverts this; `set({ attr: null })` only compiles when the model declares the attr as nullable. Combined with EDD-9025, this closes the stale-GSI footgun at the type level — `set({composite: null})` no longer compiles.

  **EDD-9025 — composite attribute schemas can't include `null`.** Convert nullable composites to `Schema.optional(...)` (T | undefined; the sparse pattern):

  ```diff
   class Device extends Schema.Class<Device>("Device")({
     channel: Schema.String,
     deviceId: Schema.String,
  -  tenantId: Schema.NullOr(Schema.String),    // ← composite, EDD-9025 rejects
  +  tenantId: Schema.optional(Schema.String),  // ← T | undefined, allowed
   }) {}
  ```

  **Hierarchical PK truncation is now supported (additive).** If you relied on the v1.6 PK-drop behavior on `set({pkComposite: null})`, declare the PK half as `'sparse'` to keep that semantic. Otherwise, the new behavior — truncate to leading prefix — is the right default for multi-tenant fleet / multi-org-project shapes.

  **Hole detection is now policy-aware.** Under `'preserve'`, holes still throw `CompositeKeyHoleError` (EDD-9024). Under `'sparse'`, holes silently truncate (or drop when the leading prefix is empty). If your code relied on the v1.6 strict throw on a sparse half, restructure so holes can't form (e.g. by putting only one composite on each half).

  **Mixed sparse/preserve attrs in same half → not expressible.** Pick one per half. The half is a single concatenated string; per-attribute mixing within a half had no coherent runtime semantic anyway.

  See `DESIGN.md §7 Policy-Aware GSI Composition` and `guides/index-policy.mdx` for the full v3 model + worked examples.

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
