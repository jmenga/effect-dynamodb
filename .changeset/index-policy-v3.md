---
"effect-dynamodb": minor
"@effect-dynamodb/geo": minor
"@effect-dynamodb/language-service": minor
---

**indexPolicy v3 — per-half model, structural composition, EDD-9025 invariant.** Closes #39 and supersedes #38.

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
- **`writerScope` (proposal #38) is superseded.** v3's narrower implicit-drop trigger eliminates the cross-writer leakage that motivated `writerScope`.

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
