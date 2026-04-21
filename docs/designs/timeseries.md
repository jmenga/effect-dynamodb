# Design: `timeSeries` entity primitive

**Issue:** [#8](https://github.com/jmenga/effect-dynamodb/issues/8)
**Status:** Proposed — ready for review
**Affected package:** `packages/effect-dynamodb` only
**Semver impact:** `minor`

---

## 1. Executive summary

Add `timeSeries` as a first-class configuration primitive on `Entity.make()` for event-driven, IoT-style workloads that need the split-item pattern: **one "current" item per partition** (latest state, index-visible, mutable-by-convergence) plus **many "event" items per partition** (immutable, TTL-bounded, time-queryable). The glue is a single new operation `.append(input)` that writes both in one `TransactWriteItems` call, and a single new query accessor `.history(key)` that returns a `BoundQuery` scoped to event items with a `.where()` restricted to the configured `orderBy` attribute.

The primitive is deliberately **separate from `versioned: { retain: true }`** because the semantics don't overlap: `versioned` is write-order-sequenced (monotonic integer, server-clock), uses optimistic-lock retry, and does a full `PutItem` on the current that wipes any field not in the input. `timeSeries` is event-time-sequenced (caller's monotonic attribute, wall-clock or domain-clock), uses newer-value-wins without retry (stale writes are silently dropped as an expected outcome), and issues an `UpdateItem` whose `SET` clause is scoped strictly to the configured `appendInput` — fields in the model but outside `appendInput` (the "enrichment" fields) can never be overwritten. Collapsing these into one primitive would force a per-call flag that the user would forget exactly when it mattered most, and would drag two unrelated correctness invariants into one compile-time type.

One-screen example:

```ts
const Telemetry = Entity.make({
  model: TelemetryRecord,
  entityType: "telemetry",
  primaryKey: {
    pk: { field: "pk", composite: ["channel", "deviceId"] },
    sk: { field: "sk", composite: [] },
  },
  indexes: {
    byAccount: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["accountId"] },
      sk: { field: "gsi1sk", composite: ["deviceId"] },
    },
  },
  timestamps: { created: true }, // `updated` auto-disabled by timeSeries
  timeSeries: {
    orderBy: "timestamp",
    ttl: Duration.days(7),
    appendInput: TelemetryAppendInput, // omit -> defaults to full model
  },
})

// Append (CAS on timestamp, event stored with TTL)
const result = yield* db.entities.Telemetry.append({
  channel: "c-1",
  deviceId: "d-7",
  timestamp: DateTime.unsafeNow(),
  location,
  alert,
  gpio,
  diagnostics,
})
if (result.applied) {
  /* current was updated to result.current */
} else {
  /* stale drop — result.reason === "stale"; result.current is the winner */
}

// History range query
const rows = yield* db.entities.Telemetry
  .history({ channel: "c-1", deviceId: "d-7" })
  .where((t, { between }) => between(t.timestamp, fromIso, toIso))
  .reverse()
  .collect()
```

---

## 2. Configuration surface

### 2.1 `TimeSeriesConfig` (new type)

Added to `packages/effect-dynamodb/src/internal/EntityConfig.ts` after `SoftDeleteConfig`:

```ts
/**
 * Time-series configuration. When set, the entity stores one "current" item
 * per partition and many immutable "event" items. See guides/timeseries.mdx.
 */
export type TimeSeriesConfig<TAppendInput extends Schema.Top | undefined = undefined> = {
  /** Model attribute used as the monotonic clock for CAS and event SK decoration. Required. */
  readonly orderBy: string
  /** TTL applied to event items (not current). Omit for retention-forever. */
  readonly ttl?: Duration.Duration | undefined
  /**
   * Optional schema restricting which model fields are allowed in `.append()`
   * input AND which fields are written into the current-item SET clause.
   * When omitted, defaults to the full model (no enrichment preservation).
   * The schema MUST include `orderBy` plus all PK/SK composite fields.
   */
  readonly appendInput?: TAppendInput | undefined
}
```

Rationale for each field:

- `orderBy` is a string (a model attribute name), not a schema — the attribute's runtime type (number, DateTime.Utc, bigint, string) is looked up from `modelFields[orderBy]` at `make()` time and serialised through the existing `KeyComposer.serializeValue` (which already handles zero-padding for numbers, 38-digit padding for bigints, and ISO formatting for DateTime/Date — see `packages/effect-dynamodb/src/KeyComposer.ts:120-132`). This matches the casing-and-padding rules every other composite attribute obeys, and means `between(t.timestamp, …)` works identically whether `timestamp` is a `DateTime.Utc` or a `number`.
- `ttl` is `Duration.Duration`, mirroring `VersionedConfig.ttl` and `SoftDeleteConfig.ttl` in `EntityConfig.ts:51` and `:65` verbatim.
- `appendInput` is a `Schema.Top` so users can write either `Schema.Struct({ … })` or a trimmed `Schema.Class`. It's optional: omit → "full model" (no enrichment preservation, every append overwrites every non-key field).

### 2.2 Integration with `Entity.make()` signature

Extend both `make()` and `makeImpl()` in `packages/effect-dynamodb/src/Entity.ts:1007` and `:1052` with one additional generic and config field:

```ts
const TTimeSeries extends TimeSeriesConfig<any> | undefined = undefined,
// …
readonly timeSeries?: TTimeSeries
```

Thread `TTimeSeries` through the `Entity<…>` interface (`packages/effect-dynamodb/src/Entity.ts:220-240`) as a new type parameter (8th positional, before `TUnique` to keep option-shaped params clustered). Add `readonly timeSeries: TTimeSeries` to the `Entity` surface.

### 2.3 Interaction with `primaryKey.sk.composite` (discriminator for co-located streams)

No new config is needed. The issue already supports multi-series co-location via user-controlled SK composites:

```ts
primaryKey: {
  pk: { field: "pk", composite: ["channel", "deviceId"] },
  sk: { field: "sk", composite: ["stream"] }, // ← discriminator, user-supplied
},
timeSeries: { orderBy: "timestamp", … },
```

With this, the current-item SK becomes `$schema#v1#telemetry_1#<stream-value>` and event-item SKs are derived by appending `#e#<orderByValue>` (section 3). Two streams (`"status"`, `"diagnostics"`) under the same PK co-exist cleanly — `.history({ channel, deviceId, stream: "status" })` narrows to one stream because `stream` is a PK composite from the caller's perspective.

**Validation rule:** `orderBy` must NOT appear in any primary-key composite. If it does, raise `[EDD-9011]` at `make()` time — putting the event clock in the SK prefix would shadow the `#e#<value>` infix and break `begins_with` scoping.

### 2.4 Interaction with `timestamps`

Auto-disable the `updated` timestamp when `timeSeries` is set — the `orderBy` value IS the update clock. The `created` timestamp is preserved and set via `if_not_exists(createdAt, :now)` on the first append (section 4.5).

Resolution happens in `resolveSystemFields` (`packages/effect-dynamodb/src/internal/EntitySchemas.ts:54`): if `timeSeries` is truthy, force `updatedAt = null` regardless of user config, and emit a `console.warn` (one-time, at make time) if the user explicitly set `timestamps: { updated: ... }` — their override is being ignored, and silent ignore would surprise them.

### 2.5 Validation rules enforced at `Entity.make()`

Fail fast inside `makeImpl` (`Entity.ts:1096-1125`). New error codes:

| Code | Condition |
|------|-----------|
| `EDD-9010` | `timeSeries.orderBy` does not name a model field |
| `EDD-9011` | `timeSeries.orderBy` is a primary-key composite (PK or SK) |
| `EDD-9012` | `timeSeries` and `versioned` both set — mutually exclusive |
| `EDD-9013` | `timeSeries.appendInput` schema omits `orderBy` or any PK/SK composite |
| `EDD-9014` | `timeSeries.orderBy` names a ref field or ref-derived `${name}Id` field |
| `EDD-9015` | `timeSeries` + `softDelete` both set — pending design resolution (see §12 open questions) |

All fail with `throw new Error("[EDD-90xx] …")`, matching the existing pattern at `Entity.ts:1104` and `KeyComposer.ts:54`.

---

## 3. Item layout on disk

### 3.1 Physical keys — sample strings

Given `DynamoSchema { name: "myApp", version: 1 }`, `entityType: "telemetry"`, `entityVersion: 1`, casing default (lowercase), and input `{ channel: "C-1", deviceId: "D-7", timestamp: <2026-04-22T10:15:03Z> }` with `primaryKey.sk.composite: []`:

**Current item**
```
pk = "$myapp#v1#telemetry#c-1#d-7"
sk = "$myapp#v1#telemetry_1"
```

**Event item** (same partition, decorated SK)
```
pk = "$myapp#v1#telemetry#c-1#d-7"                                  (identical)
sk = "$myapp#v1#telemetry_1#e#2026-04-22t10:15:03.000z"
```

With a stream discriminator (`primaryKey.sk.composite: ["stream"]`, value `"status"`):
```
Current sk = "$myapp#v1#telemetry_1#status"
Event   sk = "$myapp#v1#telemetry_1#status#e#2026-04-22t10:15:03.000z"
```

The event SK format is: `<current-sk>#e#<serialised-orderBy-value>`. Implemented by two new helpers in `KeyComposer.ts`:

```ts
/** Compose an event SK by decorating the current-item SK with `#e#<value>`. */
export const composeEventSk = (currentSk: string, orderByValue: unknown): string =>
  `${currentSk}#e#${serializeValue(orderByValue)}`

/** Compose the prefix used to scope `.history()` to event items only. */
export const composeEventSkPrefix = (currentSk: string): string => `${currentSk}#e#`
```

`serializeValue` is already imported (`KeyComposer.ts:120`) and handles all the padding and ISO formatting. Numbers → 16-digit zero-padded; bigints → 38-digit; DateTime/Date → ISO; strings pass through with the casing applied by the caller.

### 3.2 GSI key behaviour

- **Current item:** all GSI keys present, as today.
- **Event item:** all GSI keys stripped.

The existing `gsiKeyFields()` helper in `Entity.ts:1443` enumerates which attributes to delete. `buildSnapshotItem` (`Entity.ts:1456`) is the prior art — event item construction follows the same pattern (stripping + SK replacement + optional `_ttl`), differing only in the SK composer choice.

### 3.3 TTL behaviour

- **Current item:** no `_ttl`. Current is the live projection; it must not expire.
- **Event item:** `_ttl = floor(Date.now()/1000) + Duration.toSeconds(timeSeries.ttl)` when `ttl` is set; omitted when not.

Unix-seconds, `_ttl` field name — identical to version snapshots and soft-deleted items (`Entity.ts:1475`, `:2913`). This consistency is load-bearing: users configure DynamoDB's TimeToLiveSpecification once (AttributeName `_ttl`) and it applies to every lifecycle primitive in the library.

### 3.4 Casing rules

Casing on the `#e#<value>` segment is applied via the same `applyCasing` pipeline used for existing composite SK segments. This matters for string-typed `orderBy` values (e.g. `"MsgId-007"` under default lowercase). For numeric and DateTime values the result is already case-insensitive, so the rule is a no-op in practice.

---

## 4. Append operation semantics

### 4.1 TransactWriteItems shape

Two items. Both target the same table.

**Item 0 — UpdateItem on current**
```
Key = { pk: <composed>, sk: <composed current sk> }
UpdateExpression   = "SET #ob = :newOb, #f1 = :f1, #f2 = :f2, …, #ee = :ee,
                          #ca = if_not_exists(#ca, :ca)"       ← createdAt only when configured
ConditionExpression = "attribute_not_exists(#pk) OR #ob < :newOb"
ExpressionAttributeNames  = { #pk, #ob, #ca?, + one per appendInput field }
ExpressionAttributeValues = { :newOb, :ca?, + one per appendInput field }
```

**Item 1 — Put of event**
```
Key fields embedded in Item (pk, sk)
Item = full decoded append input + __edd_e__ + _ttl (if configured)
       SK replaced with `composeEventSk(currentSk, orderByValue)`
       GSI key fields stripped
No ConditionExpression — events are idempotent only across the strict-< CAS.
```

### 4.2 CAS condition construction — exact expression

The single ConditionExpression on Item 0 is:

```
attribute_not_exists(#pk) OR #ob < :newOb
```

where `#pk` is the primary-key PK field name (e.g. `"pk"`) and `#ob` is the DynamoDB attribute name for `orderBy` (resolved via `resolveDbName` to honour `DynamoModel.configure({ field })` overrides). `:newOb` is the newly-serialised `orderByValue`, marshalled with the same rules `KeyComposer.serializeValue` uses for the SK.

**CRITICAL:** the stored attribute value on the current item is the DOMAIN value (for a `DateTime.Utc`, a DateTime instance → marshalled as an ISO string by `serializeDateFields` + `toAttributeValue`), NOT the padded-SK string. The comparison is on the stored attribute; lexicographic ordering of ISO-8601 strings equals chronological ordering, so this works for DateTimes. For number/bigint `orderBy`, the stored attribute is a DynamoDB Number type, and `<` is numeric — still correct.

### 4.3 SET clause — correctness-critical enrichment preservation

The SET clause enumerates exactly the fields named in `resolvedAppendInput` (the schema-derived field list). Concretely:

```
fields_in_set = fields(appendInputSchema) ∪ {orderBy}   // orderBy implicit
```

(If `appendInput` is omitted, `fields_in_set = fields(model)` — the full model, explicitly NO enrichment preservation, documented as a footgun in the guide.)

**Fields in the model but NOT in `appendInput` are never mentioned in the UpdateExpression.** They are not in `ExpressionAttributeNames`, not in `ExpressionAttributeValues`, and therefore cannot be touched by this operation. DynamoDB's UpdateItem semantics guarantee unnamed attributes are left alone.

This is the foundational invariant. The tests in §10 must verify it against a live DynamoDB Local: write enrichment, append, confirm enrichment still present.

### 4.4 GSI key recomposition on the current

When any `appendInput` field is also a GSI composite, the GSI keys on the current item must be recomposed atomically with the CAS. This uses `KeyComposer.composeGsiKeysForUpdate` (`KeyComposer.ts:265`) — the exact same code path used by `.update()` today (see `Entity.ts:2522-2546`). GSI-key SET clauses are added to the same UpdateExpression, alongside the user-scoped SET clauses.

**Edge case:** the append input is sparse for a GSI — e.g. GSI composites are `[accountId, deviceId]` and the user's appendInput includes only `deviceId`. `composeGsiKeysForUpdate` raises `PartialGsiCompositeError` (`KeyComposer.ts:301`), which we catch and convert to `ValidationError` exactly as the existing update does (`Entity.ts:2532-2538`). This is the right behaviour — enrichment GSIs can only be kept in sync if the appendInput names all their composites, and the user should know.

### 4.5 Interaction with `timestamps: { created }`

On the UpdateItem, add a SET clause `#ca = if_not_exists(#ca, :ca)` if `systemFields.createdAt` is set. `:ca` is `generateTimestamp(systemFields.createdAtEncoding)` at the moment of append. First append materialises `createdAt`; subsequent appends leave it alone. This matches `upsert` behaviour (`Entity.ts:3186`).

On the event-item Put, DO NOT include `createdAt` — events are point-in-time facts with `orderBy` as their temporal anchor; including `createdAt` would just duplicate `orderBy` for every event.

> **Design decision** (not specified in issue). Justified: the event already carries `orderBy`, and events-with-createdAt bloats items without adding information.

### 4.6 Ref hydration

> **Design decision** (not specified in issue): do NOT hydrate refs inside `.append()`.

Refs are a create-time denormalisation; once frozen on the current by an earlier `create()`/`put()`, they stay put. An append is a partial update; requiring the caller to supply `${ref}Id` on every append would defeat the point of enrichment preservation (the ref object IS enrichment). If the user wants to change a ref, they should `.update()` — not `.append()`.

Concretely: `appendInput` is forbidden from declaring any `${ref}Id` field. Validation `EDD-9014` (§2.5) enforces this at `make()` time.

### 4.7 Return type — why "stale" is a Success

```ts
type AppendResult<Model> =
  | { readonly applied: true;  readonly current: Model }
  | { readonly applied: false; readonly reason: "stale"; readonly current: Model }

readonly append: (input: AppendInput) =>
  Effect.Effect<AppendResult<Model>, DynamoClientError | ValidationError, never>
```

`current` in the stale branch is obtained via a follow-up `GetItem` — when AWS returns `TransactionCancelledException` with `reasons[0].Code === "ConditionalCheckFailed"`, we issue a second `GetItem` on the primary key and decode it with the record schema before returning `{ applied: false, reason: "stale", current: <decoded> }`. If that follow-up read itself fails or the item has vanished (possible during TTL edge cases), return a plain `DynamoClientError` in the Error channel (the stream snapshot disappeared out from under us — not a stale-drop).

**Why not a tagged error?** Stale is an EXPECTED outcome — in a 100-device fleet all publishing every second with some clock skew, you want ~10% of appends to no-op cheaply. Modelling that as an `Effect.fail` forces every caller to `Effect.catchTag("StaleAppend", …)` at every call-site, which is ceremony for a value. The discriminated-union return makes the stale branch impossible to forget (TypeScript exhaustiveness on `applied`) while keeping the Error channel for genuinely broken conditions (network, throttle, malformed input).

This mirrors Effect's own `Queue.offer` pattern (boolean-result, not error).

### 4.8 Duplicate `orderBy` handling — strict `<`

The CAS uses strict `<`, not `<=`. A second append with the same `orderBy` value as what's already on the current returns `{ applied: false, reason: "stale", current }`. The Put of the event is inside the same transaction and is cancelled with the UpdateItem, so no duplicate event is ever written.

**Rationale:** idempotence. An IoT publisher retrying the same message (at-least-once delivery) must not create duplicate events. Duplicates in the event log are a data-quality disaster downstream. The issue explicitly calls for strict `<`; this design confirms it.

### 4.9 Interaction with `versioned` — mutually exclusive

Set both → `[EDD-9012]` at `make()` time. Rationale: as the issue notes, these are orthogonal consistency models (write-order integer CAS vs event-time newer-wins). Both on one entity would mean two ConditionExpressions on one UpdateItem, and users would have to reason about which one fired on cancellation. Not worth it.

### 4.10 Interaction with `softDelete`

> **Open question** — see §12.

Soft-delete works on the current item (stripping GSI keys, replacing SK with `…#deleted#<timestamp>`). This doesn't touch event items. But `.append()` on a soft-deleted current has surprising semantics: the UpdateItem targets a specific SK which differs from the soft-deleted SK, so the soft-deleted item is NOT the target of the update. The update would land on a new empty row. That's effectively un-delete-by-append, which is unexpected.

**Safest default:** reject the combination at `make()` time (`EDD-9015`) unless a future design explicitly addresses resurrection semantics. Flag for reviewer decision.

### 4.11 Interaction with `unique`

**Current item** continues to enforce unique constraints exactly as today — uniqueness sentinels are tied to the current row, not events. If the append modifies a unique field, the transaction must include sentinel rotation (delete old, put new) just like `.update()` does when `touchesUniqueFields` is true (`Entity.ts:2147-2164, 2368-2405`).

**Event items** do NOT participate in uniqueness. Events are historical records; historical records cannot violate a present-tense unique constraint.

Constraint on the 100-item transaction budget: one append = 1 (UpdateItem) + 1 (Put event) + 2 × N_unique_constraints_rotated. For reasonable `unique` counts (≤ 10), comfortably under the 100 limit.

### 4.12 Append is NOT transactable in v1

> **Design decision** (not specified in issue): `.append()` is NOT exposed to user-authored `Transaction.transactWrite` in this initial release.

It would require exposing an `EntityAppend` intermediate and handling the stale-return as a TransactionCancellation reason — a significant expansion of `extractTransactable` (`Entity.ts:4131`). Cut scope: `.append()` is a BoundEntity-only terminal operation that builds and executes its own TransactWriteItems. Revisit in a follow-up if demand emerges.

---

## 5. History operation semantics

### 5.1 Return type

```ts
readonly history: (key: EntityKeyType<Model, Indexes>) =>
  BoundQuery<
    HistoryModelView,   // decoded type — see 5.4
    { readonly [orderBy]: string },  // SkRemaining — enables `.where()` once
    HistoryModelView
  >
```

### 5.2 SK condition — auto-applied prefix

When `.history(key)` is called, the implementation:

1. Decodes `key` against `keySchema`.
2. Composes the current PK via `KeyComposer.composePk`.
3. Composes the current SK via `KeyComposer.composeSk`.
4. Computes the event prefix: `composeEventSkPrefix(currentSk)` → e.g. `"$myapp#v1#telemetry_1#e#"`.
5. Seeds a `Query.make({ … })` with `pkValue = composedPk`, attaches `.pipe(Query.where({ beginsWith: prefix }))`.

This is structurally identical to `versions()` at `Entity.ts:3359-3375` and `deleted.list()` at `Entity.ts:3447-3476`.

### 5.3 `.where()` — typed to `orderBy` only

The BoundQuery config passed to `BoundQueryImpl` uses:

- `skFields: [orderBy]` — the `.where()` callback's `t` parameter exposes exactly one key, the `orderBy` attribute name.
- `composeSkCondition`: a new transform that takes the user's `SortKeyCondition` (e.g. `{ between: [v1, v2] }`), serializes each boundary via `KeyComposer.serializeValue`, and rewrites it to absolute SK values by prepending `<currentSk>#e#` to each — mirroring the pattern at `DynamoClient.ts:754-772` but with `#e#` in place of the entity-type infix.

The typed surface:

```ts
.history({ channel, deviceId })
  .where((t, { between }) => between(t.timestamp, T1, T2))
  .where((t, { gte }) => gte(t.timestamp, T0))   // type error — SkRemaining = never
```

The second `.where()` is a compile-time error (per `BoundQuery.ts:129` conditional type). Users chain via `.filter()` for attribute conditions beyond orderBy.

### 5.4 Decoder behaviour

Event items are full snapshots written by `.append()`: they contain model fields + `__edd_e__` + `_ttl` + pk/sk (no GSI keys). The decoder must accept items lacking GSI key attributes.

> **Design decision** (not specified in issue): use a new derived schema `historyRecordSchema` built in `EntitySchemas.ts:buildDerivedSchemas`, formed as:

```ts
historyRecordSchema = Schema.Struct({
  ...modelFields,
  ...fromSelfFields,
  ...systemSchemaFields(createdAt only), // no updatedAt, no version
})
```

— identical in spirit to `deletedRecordSchema` (`EntitySchemas.ts:342-347`) but omitting `deletedAt` and adding nothing. The model fields already cover everything the event carries.

**Decode mode for `.history()` collect/paginate terminals: `asModel`** (i.e. return the model type, attach the Schema.Class prototype if applicable). Justification: the event IS a model-shaped fact; users who wrote `new TelemetryRecord({ … })` at append time want `TelemetryRecord` instances back at query time, with their methods. This matches every other BoundQuery terminal in the library.

---

## 6. Type-level API

### 6.1 `AppendInputType<Model, AppendInput>`

In `packages/effect-dynamodb/src/internal/EntityTypes.ts`:

```ts
/** Input type for .append(): derived from appendInput schema if provided, else full model.
 *  Always includes orderBy + all PK/SK composites (enforced at Entity.make() time). */
export type AppendInputType<TModel extends Schema.Top, TAppendInput> =
  [TAppendInput] extends [Schema.Top]
    ? Schema.Schema.Type<TAppendInput>
    : ModelType<TModel>
```

### 6.2 Return discriminated union

```ts
export type AppendResult<TModel extends Schema.Top> =
  | { readonly applied: true;  readonly current: ModelType<TModel> }
  | { readonly applied: false; readonly reason: "stale"; readonly current: ModelType<TModel> }
```

Exported from `packages/effect-dynamodb/src/Entity.ts` alongside `Model`, `Record`, etc. (top-level type extractor set at `Entity.ts:4164`).

### 6.3 `.history(key)` parameter

Same `EntityKeyType<TModel, TIndexes>` used by `.get`, `.update`, `.versions`, `.deleted.list` — no new types. Important: the user's mental model of "a key" is one thing across the whole entity.

### 6.4 `.where()` on `.history()` — restricted to `orderBy`

The PathBuilder on `.where()` exposes exactly `{ [orderBy]: string }` — nothing else. Users who want to condition on other model fields use `.filter(…)`. This is the natural consequence of `skFields: [orderBy]` in the BoundQueryConfig (§5.3) and requires no additional type plumbing — the existing `BoundQueryWithWhere<Model, SkRemaining, A>` from `BoundQuery.ts:110` handles it.

---

## 7. Errors

### 7.1 Reused

- `DynamoClientError` — network / throttle / generic AWS failure on TransactWriteItems or the follow-up GetItem
- `ValidationError` — input decode failure, partial GSI composite on append
- `TransactionOverflow` — if the transaction payload (append + event + sentinel rotations) somehow exceeds 100 items

### 7.2 NOT introduced

- **No `StaleAppendError`.** As argued in §4.7, stale is a value in the return type, not an error.
- **No `HistoryDecodeError`.** `ValidationError` covers it.

### 7.3 Configuration errors at `Entity.make()`

Thrown as plain `Error` with `[EDD-9xxx]` prefix (matches existing convention at `Entity.ts:1104`, `KeyComposer.ts:54`). See §2.5 table.

---

## 8. Internal implementation plan

Ordered by dependency. Each step compiles and passes tests before moving on.

### Step 1 — Config and types (no runtime behaviour yet)

- `packages/effect-dynamodb/src/internal/EntityConfig.ts` — add `TimeSeriesConfig<TAppendInput>` after `SoftDeleteConfig` (around line 67). Mirror field doc style.
- `packages/effect-dynamodb/src/internal/EntityTypes.ts` — add `AppendInputType`, `AppendResultType`. Extend `SystemFieldsType` to recognise `timeSeries` disables `updatedAt` (`EntityTypes.ts:28`).
- `packages/effect-dynamodb/src/Entity.ts` — add `TTimeSeries` generic to `make()`/`makeImpl()` (around `:1007` and `:1052`), thread into `Entity<…>` interface (`:220-240`).
- Update `bind()` generics at `Entity.ts:3968`.
- `packages/effect-dynamodb/src/index.ts` barrel — export `AppendResult` type.

### Step 2 — Schema derivation

- `packages/effect-dynamodb/src/internal/EntitySchemas.ts` — add `appendInputSchema` and `historyRecordSchema` to `DerivedSchemas` interface (around `:173-192`). Thread through `buildDerivedSchemas(…)` signature.
- `resolveSystemFields(…)` — suppress `updatedAt` when `timeSeries` is truthy. Preserve `createdAt`.

### Step 3 — KeyComposer helpers

- `packages/effect-dynamodb/src/KeyComposer.ts` — add `composeEventSk(currentSk, orderByValue)` and `composeEventSkPrefix(currentSk)`. Co-locate with `composeSortKeyPrefix` at `:333` for discoverability.

### Step 4 — Validation at make()

- `Entity.ts:1116-1125` — extend the index-validation loop to check `timeSeries.orderBy` against `validCompositeFields` (for EDD-9010), emit EDD-9011 if it's in `primaryKeyComposites(indexes)`, EDD-9012 if both `versioned` and `timeSeries`, EDD-9013 by inspecting `appendInput.fields`, EDD-9014 by checking `refFieldSet`, EDD-9015 if `softDelete` is also set.

### Step 5 — Append implementation

- `Entity.ts` — add `const append = (input: unknown) => …` near `put` (`:1780`). Reuses `composeAllKeys`, `buildSnapshotItem`-style event-builder, the existing `compileCondition` for optional user conditions via `Entity.condition(...)` if we choose to accept them (default: include — see §12 open question).
- Exports `append` on the entity surface (`Entity.ts:3880-3950` section). Wire into `BoundEntity.append` in `bind()` around `Entity.ts:4053-4093`.

### Step 6 — History implementation

- `Entity.ts` — add `const history = (key: unknown) => …` near `versions` (`:3359`). Build `Query.make(...)`, seed `beginsWith` prefix.
- In `bind()`, wrap with `BoundQueryImpl` using a new `composeSkCondition` that uses `#e#` prefix + `serializeValue` on boundaries.
- Expose `readonly history: (…)` on both `Entity<…>` and `BoundEntity<…>` interface (`Entity.ts:777` and `:810` regions).

### Step 7 — DynamoClient wiring

- `packages/effect-dynamodb/src/DynamoClient.ts:786-834` — the entity-binding loop needs zero changes: `append` and `history` are already on `BoundEntity` from `bind()`. The typed-accessor loop binds whatever `BoundEntity` exposes. Verify this by running unit tests.

### Step 8 — Barrel

- `packages/effect-dynamodb/src/index.ts` — re-export the new `TimeSeriesConfig` type via `Entity.TimeSeriesConfig` or similar.

### Step 9 — Tests

See §10.

### Step 10 — Docs + example

See §11.

---

## 9. Migration / compatibility

### Breaking changes: **none**

Every new field is optional. The `Entity<…>` generic signature gains one parameter; since we default it to `undefined`, existing code infers it correctly. The internal `ModelType`/`SystemFieldsType` behaviour changes only when `timeSeries` is truthy.

### Semver impact: **minor**

New feature on the stable 1.x line. A changeset declaring `effect-dynamodb: minor` is required on the implementation PR.

### Converting a `versioned: { retain: true }` entity to `timeSeries`

Not drop-in. The on-disk formats are incompatible:
- Versioned snapshots SK: `$…#telemetry#v#0000001` (version integer)
- Event items SK:       `$…#telemetry_1#e#<orderBy-value>`

A migration requires (a) backfilling an `orderBy` attribute on every snapshot, (b) re-writing each snapshot under the new SK, (c) deleting the old snapshot. Out of scope for this design — call out in the guide as "design-time decision; no automated migration."

---

## 10. Test plan

### 10.1 Unit (mocked `DynamoClient`, new dedicated file `TimeSeries.test.ts`)

**Config validation:**
- `EDD-9010` raised for unknown `orderBy`
- `EDD-9011` raised when `orderBy` is in PK composite
- `EDD-9011` raised when `orderBy` is in SK composite
- `EDD-9012` raised when `versioned` + `timeSeries` both set
- `EDD-9013` raised when `appendInput` omits `orderBy`
- `EDD-9013` raised when `appendInput` omits a PK composite
- `EDD-9014` raised when `orderBy` is a ref id field
- `EDD-9015` raised when `softDelete` + `timeSeries` both set
- `timestamps.updated` auto-suppressed when `timeSeries` present

**Append — mock client captures `TransactWriteItems` payload:**
- Transaction has exactly 2 items (when no `unique`)
- Item 0 is UpdateItem on current SK (no `#e#` infix)
- Item 0 UpdateExpression includes ONLY `appendInput`-scoped fields (enrichment preservation — snapshot assertion on exact SET clause string)
- Item 0 ConditionExpression is `attribute_not_exists(#pk) OR #ob < :newOb`
- Item 0 ExpressionAttributeValues `:newOb` serialises DateTime to ISO
- Item 1 is Put with SK `<currentSk>#e#<value>`
- Item 1 GSI key fields are absent
- Item 1 `_ttl` present when config has `ttl`; absent when not
- `timestamps: { created: true }` → SET `#createdAt = if_not_exists(#createdAt, :now)` on Item 0

**Append — return value:**
- Success path → `{ applied: true, current: <decoded> }`
- TransactionCancelled with `reasons[0].Code = "ConditionalCheckFailed"` → follow-up GetItem, returns `{ applied: false, reason: "stale", current: <decoded> }`
- Arbitrary DynamoClientError → propagated on Error channel

**Append — GSI recomposition:**
- `appendInput` names a GSI composite → GSI keys recomposed on current
- `appendInput` names some but not all GSI composites → `ValidationError`

**History — query shape:**
- `.history(key)` seeds `beginsWith: "<currentSk>#e#"`
- `.where((t, { between }) => between(t.timestamp, T1, T2))` rewrites to `between: ["<prefix>#<T1>", "<prefix>#<T2>"]` with ISO serialisation
- `.reverse()`, `.limit()`, `.filter()` all compose correctly

### 10.2 Integration (`packages/effect-dynamodb/test/connected.test.ts`)

Requires DynamoDB Local. One `describe("timeSeries", …)` block covering:

- Round-trip: append → get current → assert `orderBy` is newest
- Sequential appends with monotone `orderBy`: each returns `applied: true`, history reflects all events
- Stale append: append T=10, then append T=5; second returns `applied: false, reason: "stale"`, current still shows T=10, history has exactly 1 event (the T=10 one)
- Strict-`<` duplicate: two appends with identical `orderBy` → second is stale, no duplicate event
- Enrichment preservation: `.put({ …, accountId: "acct-1" })`, then `.append({ … })` without `accountId` in appendInput, then `.get()` — assert `accountId` unchanged
- GSI on current: after append, `.byAccount({ accountId }).collect()` returns current; does NOT return events
- History range: append 10 events across an hour, `.history(key).where((t, { between }) => …).collect()` returns only the 5 in the window
- TTL set: assert `_ttl` field present on event item (cannot test actual expiration in a test run, but verify the attribute exists with a sensible epoch value)
- Concurrent appenders (simulated): `Effect.all([append(T=1), append(T=2), append(T=3)], { concurrency: "unbounded" })` — assert final current is T=3 and history has all three (or some subset if two had identical timestamps)

### 10.3 Type-level (`packages/effect-dynamodb/test/Entity.types.test.ts`)

- `BoundEntity.append` input type narrows to `appendInput` schema fields when configured, falls back to full model when not
- Return type is the discriminated union, exhaustive match works
- `.history(key).where(…)` callback `t` has only `orderBy` keys; accessing `t.otherField` is a type error
- Second `.where()` on history is a type error (SkRemaining exhausted)

---

## 11. Documentation plan

### 11.1 New guide page

`packages/docs/src/content/docs/guides/timeseries.mdx` — following the structure of `lifecycle.mdx`. Sections:

1. When to use time-series vs `versioned`
2. Item-on-disk layout (diagram: one current, N events)
3. Configuring an entity (TelemetryRecord example, full config)
4. `.append()` — the stale branch, why it's not an error
5. Enrichment preservation (narrated carefully, with a "what NOT to do" comparison)
6. `.history(key).where(...)` — range queries
7. TTL and retention
8. Multi-stream per partition (discriminator in SK composite)
9. Known limits (no soft-delete, no versioned)

### 11.2 Backing example

`packages/effect-dynamodb/examples/guide-timeseries.ts` — full runnable file exercising every region referenced from the MDX. Regions:

```ts
// #region define
const Telemetry = Entity.make({ …, timeSeries: { orderBy: "timestamp", ttl: Duration.days(7), appendInput: TelemetryAppendInput } })
// #endregion

// #region append
const r = yield* db.entities.Telemetry.append({ … })
if (r.applied) { … } else { /* stale */ }
// #endregion

// #region history
const range = yield* db.entities.Telemetry.history({ channel, deviceId })
  .where((t, { between }) => between(t.timestamp, T1, T2))
  .collect()
// #endregion

// #region enrichment
// Background job enriches:
yield* db.entities.Telemetry.update({ channel, deviceId }, Entity.set({ accountId: "acct-1" }))
// Device appends:
yield* db.entities.Telemetry.append({ channel, deviceId, timestamp, gpio })
// Current still has accountId:
const cur = yield* db.entities.Telemetry.get({ channel, deviceId })
// #endregion
```

### 11.3 CLAUDE.md update

Under `## Behavioral Notes > ### Lifecycle Operations` (line 387 of `CLAUDE.md`), add two bullets:

- **Time-series via `timeSeries: { orderBy, ttl?, appendInput? }`.** Current-item SK unchanged; event items SK is `<currentSk>#e#<orderBy-value>`, GSI keys stripped, `_ttl` set. `.append(input)` is a TransactWriteItems (UpdateItem current + Put event) with CAS `attribute_not_exists(pk) OR #orderBy < :newOb`. Returns `{ applied: true | false, current }` — stale is a value, not an error.
- **Time-series enrichment preservation.** `.append()` SET clause enumerates only fields in `appendInput` (defaults to full model when omitted). Fields outside `appendInput` are never touched.

Under `## Behavioral Notes > ### Entity Operations`, add one bullet in the query-accessor section:
- **`.history(key)` for time-series entities.** Returns a `BoundQuery` auto-scoped to event items via `begins_with("#e#")`. `.where()` restricted to the configured `orderBy` attribute; `.filter()` works on any model attribute.

### 11.4 Doctest sync

Add entry to the sync table in CLAUDE.md (around line 287):
```
| guides/timeseries.mdx | examples/guide-timeseries.ts |
```

Run `pnpm --filter @effect-dynamodb/doctest test` as part of the PR's quality gates.

---

## 12. Open questions — need decisions before implementation

1. **`timeSeries` + `softDelete` combination.** (§4.10.) Three options: (a) forbid at `make()` with `EDD-9015` [safest, proposed default]; (b) allow, with "appending on a soft-deleted entity resurrects it" semantics; (c) allow, with "append on soft-deleted returns ItemNotFound". Recommendation: (a). Confirm with reviewer.

2. **`appendInput` default behaviour.** Issue says "default to full model"; this design honours that. Confirm that a missing `appendInput` is acceptable UX given that it nullifies enrichment preservation entirely. Alternative would be to require `appendInput` and raise `EDD-9016` when omitted, forcing the user to make an explicit call. Recommendation: honour the issue's default, but emit a one-time `console.warn` at `make()` when `appendInput` is absent pointing to the guide.

3. **`.history()` decode mode default.** This design picks `asModel`. Alternative: `asRecord`. (Records include system fields; `createdAt` would be `undefined` on events if we follow §4.5 and don't set it, causing decode failures.) Recommendation: stick with `asModel`. Confirm.

4. **`.append()` inside user-authored `Transaction.transactWrite`.** This design excludes it (§4.12). Confirm that's acceptable for the v1 cut.

5. **User conditions via `Entity.condition(...)` on `.append()`.** Not discussed in the issue. The CAS is already expressing one condition; ANDing a user condition onto the UpdateItem's ConditionExpression is mechanically straightforward. Recommendation: include it (symmetry with `.update()`, `.put()`). Confirm.

6. **Return mode for the stale branch's `current`.** To obtain `current` in the stale branch we must do a follow-up `GetItem`. This adds latency (1 RTT) and costs an extra RCU. Alternative: omit `current` from the stale branch (`{ applied: false, reason: "stale" }` only) and let the caller fetch if they want. Recommendation: include `current` — IoT reconciliation flows almost always want to know what won. The extra RCU is cheap compared to the UpdateItem + Put WCU. Confirm.

---

## Critical files referenced

- `/Users/jmenga/Source/ai/effect-dynamodb/packages/effect-dynamodb/src/Entity.ts`
- `/Users/jmenga/Source/ai/effect-dynamodb/packages/effect-dynamodb/src/internal/EntityConfig.ts`
- `/Users/jmenga/Source/ai/effect-dynamodb/packages/effect-dynamodb/src/internal/EntitySchemas.ts`
- `/Users/jmenga/Source/ai/effect-dynamodb/packages/effect-dynamodb/src/internal/EntityTypes.ts`
- `/Users/jmenga/Source/ai/effect-dynamodb/packages/effect-dynamodb/src/KeyComposer.ts`
- `/Users/jmenga/Source/ai/effect-dynamodb/packages/effect-dynamodb/src/internal/BoundQuery.ts`
