# Design: Z-order indexes and smarter filtered-query pagination (#171)

**Issue:** [#171](https://github.com/jmenga/effect-dynamodb/issues/171)
**Status:** Designed, revised after an algorithms / DynamoDB / library-fit review. Open questions
answered in §12; those resolutions and every item marked *(confirmed 2026-10-27)* in §19 were
confirmed by the owner on 2026-10-27, exactly as proposed. The review findings C9–C11 and the
pre-existing key bugs E6–E8 fixed in the same PR were confirmed by the owner on 2026-10-28 (§19).
On 2026-10-28 the owner also rejected C12 (E6's two-range split) in favour of escaping sort key
text (F1), and chose to fix the time-series event keys (F2, whose tests also needed `append`'s
compare-and-set fixed, E9) and to keep 1.36 rows working with a rekey helper (F3, F4). The
choices the implementation made within those decisions (§19.1, G1–G32) were confirmed by the
owner on 2026-10-28 as recommended, except G5 and G31, which the owner changed: G31's change
brought projection read models under the fallback and `rekey` (G33–G37), confirmed by the owner
on 2026-11-01 as proposed, with the strongly consistent read after an applied `append`. On
2026-11-05 the owner had three fixes #184 found in this PR's fallback and `rekey` brought in
(G38–G41).
Implemented in the same PR (single-PR workflow: this doc is commit 1).
**Builds on:** #122 (`filterBy`, the accept loop and over-read cursors), #133 (history rows and
geometric growth), #114 / #115 (typed `.where()` operands, delimiter clamping), #111 (composite
key form), #144 (key-condition diagnosis), v1.7.x policy-aware GSI composition (#41 / #43 / #46),
`storage-encoding.md` (#147: `B` attributes already flow through the marshaller).
**Affected packages:** `packages/schema` (new `ZOrder` module, `KeyComposer`, `Entity.make`
validation), `packages/effect-dynamodb` (`Query`, `internal/BoundQuery`, `DynamoClient`, `Entity`,
`Table`, `internal/WriteDiagnosis`), `packages/language-service` (hover for Z-order halves),
`packages/docs`, `packages/doctest` (no code change; new example is discovered).
**Semver impact:** `minor`. Lockstep to **1.37.0** (main is at 1.36.0). Behaviour and type changes that are not
purely additive, all listed in the changeset:
1. **Adaptive request sizing is the default** when `limit` is set, `pageSize` and `maxPages` are
   not, and the query filters (§8). The items `collect` / `count` return, and the items a `fetch`
   chain returns end to end, are unchanged; `Limit` values and request counts change. Three
   things a caller can see change with them (§8.4): a `fetch` cursor's value can differ while
   resuming at the same place; a `fetch` whose limit fills on a sized request's last returned row
   can return a `Some` cursor where 1.36 returned null, so its chain ends with one empty page
   (§19 C9); and `Query.paginate` emits one array per request, so its page boundaries follow the
   sized requests and only the flattened stream is unchanged (§19 C10; a bound query's
   `.paginate()` streams items, so it is unaffected). With `maxPages` set,
   sizing stays exactly 1.36's, because a capped request count with smaller requests would change
   what one call returns (§8.1, §19 C6). `.pageSize("natural")` restores 1.36 behaviour exactly.
2. **`KeyComposer` return types widen** from `string` to `string | Uint8Array` on the
   record-composing functions (`composeIndexKeys`, `tryComposeIndexKeys`, `composeAllKeys`,
   `GsiUpdateResult.sets`). Only a Z-order half ever produces a `Uint8Array`.
3. **`GsiConfig.sk` becomes a union** (`KeyPart | ZOrderKeyPart`, §3.2). Generic code that reads
   `GsiConfig["sk"]["composite"]` now sees `ReadonlyArray<string> | undefined`. `KeyPart` gains
   `zorder?: never` / `prefix?: never`, and `IndexDefinition.sk` becomes `KeyPart | ZOrderSkPart`.
4. **`IndexSkComposites` (exported from both barrels) returns `never` for a Z-order half**, so
   code that maps over an index's SK composites sees none for such an index.
5. **`pageSize` widens** to `number | "natural"` on `Query.pageSize`, `BoundQueryBase.pageSize`
   and `CollectionQuery.pageSize`.
6. **A malformed cursor fails the terminal** with `[EDD-9094]` (`ValidationError`) instead of
   throwing from `.startFrom()` (§10.2, §19 E4).
7. **A key attribute and a vector filter attribute of another type now fail** with `[EDD-9091]`
   at `Table.make` / `Table.definition`, instead of the first type being kept silently (§19 E1).

**Pre-existing key bugs fixed in this PR, and the upgrade path from 1.36** (§19 E6–E9, F1–F4),
also in the changeset:

8. **Numeric key text sorts numerically** (E8, the default in 1.37.0; an opt-in and a major bump
   were rejected). Non-negative integers below 1e16 (1e38 for a bigint) keep their 1.36 bytes.
   Negative, fractional, 1e16-and-up and infinite numbers, negative or 1e38-and-up bigints, and
   epoch dates before 1970 compose different text, so rows written by 1.36 with one keep their
   old keys until they move (items 12, 13). `NaN` and bigints over 1,000 digits are refused
   (`[EDD-9096]`).
9. **A complete sort key matches exactly** (E7): an accessor, `Entity.query.<index>` or
   `Aggregate.list` given every sort key composite sends `sk = key`, not `begins_with(key)`;
   `.where(beginsWith)` on a numeric composite compiles to `eq`; `.history(key).where()` range
   bounds stay inside the item's own events.
10. **Sort key text is escaped** (F1, fixing E6; the default in 1.37.0): a sort key composite's
    text escapes code points U+0000–U+0025 as `%` and two hex digits, so key order is value order,
    every bound is one exact key condition again (1.36's request shapes over the escaped text) and
    values may hold `#`. A string holding such a character composes different sort key text, so rows
    written by 1.36 with one keep their old keys until they move (items 12, 13). A strict `lt` on
    the last composite under pinned ones no longer throws `[EDD-9046]` (retired).
11. **Time-series event keys and appends on a numeric-string `orderBy`** (F2, E9): event keys
    compose a `NumberFromString` / `BigIntFromString` `orderBy` from its key form (the number), so
    those event rows written by 1.36 keep their old keys until they move (items 12, 13); `append`
    on such an `orderBy` reads the current item first (one strongly consistent `GetItem` per
    append) and compares the numbers, where 1.36's `<` compared text and refused `10` after `9`.
    A user condition that rejects an append creating the item fails `ConditionalCheckFailed`,
    for every `orderBy` type, where 1.36 returned `ValidationError` (§19 G5); a cancellation for
    a `TransactionConflict` alone is sent again, up to 8 attempts in all, where 1.36 reported a
    stale append; the reads after the transaction are strongly consistent.
12. **Rows written by 1.36 keep working through 1.37.x, and move** (F3): single-item operations
    read the 1.36 key on a miss and move the item to its current key on its first write; queries
    that pin a key prefix also read the 1.36 key; aggregates are read under both keys and moved
    by `update`; an `EventStore` stream is read and appended where it lives; projections read a
    read-model row and its tombstone under the 1.36 key and move them with their next write, and
    `drain` / `drainPending` deliver a row's outbox effects under both keys in one order (the
    tombstones and outbox items 1.37 writes carry a mark, `__edd_kt__`). Keys whose text did
    not change send 1.36's requests. A key whose text changed costs more while the fallback is
    on: a second read on a miss, a second query pass, an unconditioned `put` sent as a two-item
    `TransactWriteItems` (twice the write units of each item), one failed conditional write more
    for a conditioned write that creates the item, a later `BatchWriteItem` for a batched put's
    1.36 key. Error channels widen: the new `ItemNotMoved` (`[EDD-9097]`) on
    `Transaction.transactWrite`, an `EventStore` append (its `additionalItems`) and
    `Entity.PlanUpdateError` / `PlanDeleteError`; `ConcurrentModification` on a time-series
    `append` and on `restore`. `DynamoSchema` gains `legacyKeys?: false`
    (`DynamoSchema.make({ legacyKeys: false })` turns the fallback off; both go in the next major).
13. **`rekey`** (F4, additive): `db.tables.<Table>.rekey(options?)`, the `Table.RekeyOptions` /
    `RekeyReport` / `RekeyCounts` / `RekeyRowKind` / `RekeyConflict` / `RekeyMemberReport` types
    and `[EDD-9098]`; it moves projection row tombstones and outbox items too (§19 G31). A
    `DynamoClient.make({ tables })` entry with no entities or aggregates (a table of event streams
    or of an outbox) no longer throws: its definition is composed when `create` runs. An
    `EventStore` append to a stream still under its 1.36 key carries one more `ConditionCheck`,
    and fails `VersionConflict` when `rekey` moved the stream meanwhile.

Line numbers are as of `4c3e856` (merge of #170, 1.34.1). The branch has since been rebased onto
`60014d2` (1.36.0: #173 head proof `none`, #174 consumed-capacity reporting), which moved code in
`Query.ts`, `BoundQuery.ts`, `DynamoClient.ts` and `Entity.ts`; locate code by symbol name. The
query sizing this design changes is the same in 1.34 through 1.36. Paths are relative to the repo
root; `Query.ts` etc. without a package mean `packages/effect-dynamodb/src/`.

---

## 1. Executive summary

One PR, five reviewable commits (§18), two commits for pre-existing key bugs found in review
(§19 E6–E8), one version bump:

1. **Adaptive request sizing (§8).** `computeRequestLimit` becomes a per-terminal estimator fed by
   `ScannedCount` and the accept loop. #133's history-row growth becomes its zero-pass case.
2. **A range-jump loop (§9)** around the existing LEK loop in `execute`, `pageStream` and `count`.
   A planner yields key-condition ranges; a jump always starts a **new key condition** and never
   fabricates an `ExclusiveStartKey`. With no planner the loop is today's code, byte-identical.
3. **Cursor v2 (§10)**: a versioned envelope carrying a resume **position** (inside a range at a
   `LastEvaluatedKey`, completed through a key value, or past a finished skip tuple), the skip
   tuple and a plan fingerprint, with `B` values. Resume recomputes the plan and **clips** it at
   that position. Old cursors still decode; plain queries keep emitting the old format.
4. **`.within()` on composite indexes with skip-scan (§7)**: bounds on a non-leading sort-key
   composite probe for each distinct leading tuple instead of filtering the whole partition, up
   to `maxSkips` probes, then fall back to a single filtered read of the remainder.
5. **Z-order sort keys (§3–§6)**: a pure `ZOrder` module in `@effect-dynamodb/schema`, `sk.zorder`
   and `sk.prefix` on `GsiConfig`, binary (`B`) sort-key halves, `naive` / `jump` / `precise`
   strategies, `B` attribute definitions, policy-aware updates and two new canonical fixture
   shapes.

Plus two inspection hooks on every query: `.explain()` (the plan, no I/O) and `.onRequest(f)`
(per-request counts; the second hook was confirmed 2026-10-27, §19 A10).

---

## 2. Context: what the code does today

| Concern | Today | Consequence for #171 |
|---|---|---|
| Key conditions | `QueryState.skConditions` is an array but only `[0]` is read (`Query.ts:858`); `where` replaces it (`:409-419`). | One key condition per terminal. Multi-range needs a planner, not more `skConditions`. |
| Sort-key operand type | `SortKeyCondition` operands are `string` (`Query.ts:39-46`). | Binary bounds need an internal widened condition type. |
| Request sizing | `computeRequestLimit(state, remaining, page)` (`Query.ts:1063-1077`). Under a filter or predicate it returns `pageSize` (a natural 1 MB page when unset). Only history rows grow geometrically (#133, `:1071-1075`). | §8 replaces the blind branch. Every caller (`:922`, `:1403`, `:1520`, `:1609`, `:1631`) changes. |
| Loops | `execute` (`:1372-1448`) and `pageStream` (`:1456-1553`) are separate loops; `collect` = `paginateInternal` + `runCollect` (`:1345`). `pageStream` state lives in `PageState` so streams re-run. | Both loops change in step. Estimator and plan position go into `PageState`. |
| `count` | Three paths: predicate → `collect` (`:1586`); history → projected reads sized by `computeRequestLimit` (`:1593-1619`); `Select: "COUNT"` (`:1621-1642`). | With `.limit()`, `count` does not read everything (contradicts the issue, §20). |
| Accept loop | `examinePage` (`:1261-1321`) returns `{ items, stoppedAt }`; it does not report rows examined. `send` (`:1153-1184`) never reads `Count` / `ScannedCount`. | The estimator needs both. |
| Cursor | `btoa(JSON.stringify(key))` / `JSON.parse(atob(..))` (`Query.ts:397-399`): a bare `AttributeValue` map. `startFrom` decodes eagerly at combinator time (`:524-536`), so a malformed cursor throws there. | `{ B: Uint8Array }` serialises as `{"0":..}` and does not round-trip; `btoa` throws on non-Latin-1 key text. Needs a v2 envelope, decoded in `prepared()` where the planner exists. |
| `examinePage` budget | With `budget = 0` and no predicate, `end = next` and the `while` never advances; with a predicate it accepts one row past the budget (`:1293-1316`). Unreachable today: `execute` returns early on `limit ≤ 0` and breaks on `limitReached`. | A multi-range loop must never call it with nothing remaining (§9.2); a defensive `budget === 0` return is added. |
| Key composition | String end to end: `composeSk`, `composeIndexKeys`, `composeAllKeys`, `GsiUpdateResult.sets` (`schema/src/KeyComposer.ts:239-392`). | A Z-order half needs a byte-valued branch. |
| `normalizeGsiConfig` | Copies only `{ field, composite }` per half and throws a `TypeError` when `sk.composite` is absent (`KeyComposer.ts:147-169`). | Must carry `zorder` / `prefix`. |
| Policy gate | Skip-predicate reads only `.composite` (`KeyComposer.ts:688-695`); `classifyHalf` truncates a partial leading prefix into a legal SET (`:523-568`). | Truncation is meaningless for an address; a Z-order half needs an all-or-nothing classifier. |
| Table | `Table.definition` hard-codes `AttributeType: "S"` (`Table.ts:689-691`). `mergeSecondaryIndexes` (EDD-9069) is keyed by index name, not attribute. | `B` definitions and a per-attribute type check. |
| Non-leading bounds | `.where()` on an SK composite whose leading composites aren't pinned throws EDD-9004 (`DynamoClient.ts:1441-1450`). | Skip-scan is new behaviour, reachable only through `.within()`. |

---

## 3. Public API

### 3.1 `ZOrder` module (`packages/schema/src/ZOrder.ts`)

Pure TypeScript over `bigint` and `Uint8Array`. No `@aws-sdk`, no `node:*`, no `Buffer` (the
AWS-free and Node-free guards cover it automatically). Exported from the schema barrel as a
namespace and re-exported from `effect-dynamodb` (`src/index.ts`, pattern at `:73-86`).

The **public** surface is types only *(A13, owner 2026-11-01)*. A dimension is declared as a plain
entry in `sk.zorder`: a bare field name, or `{ field, ...options }`. The field's type is already in
the model, so the entry never restates it; its options say only how to quantize the values, and
which options it takes follows from the field's type (`DimensionFor`). An entry is a spec: it
knows nothing about the entity it will be bound to.

```ts
export type DimensionKind = "int" | "float" | "dateTime" | "literals" | "string"
export type DateTimeUnit = "milliseconds" | "seconds" | "minutes" | "hours" | "days" | "weeks"
export type LiteralValue = string | number | boolean

export interface NumericDimension<F extends string = string> {       // number | bigint field
  readonly field: F
  readonly min: number
  readonly max: number
  readonly step?: number | undefined                                  // default 1
}
export interface DateTimeDimension<F extends string = string> {      // date field
  readonly field: F
  readonly from: string | Date | DateTime.DateTime
  readonly unit: DateTimeUnit
  readonly bits: number
}
export interface LiteralsDimension<F extends string = string, L = LiteralValue> { // literal union, boolean
  readonly field: F
  readonly values?: ReadonlyArray<L> | undefined                      // reorders; lists every member
  readonly bits?: number | undefined                                  // reserve room for members added later
}
export interface ListedLiteralsDimension<F extends string = string, L = LiteralValue>
  extends LiteralsDimension<F, L> {                                   // plain string field
  readonly values: ReadonlyArray<L>
}
export interface StringDimension<F extends string = string> {        // string field
  readonly field: F
  readonly bytes: number
}
export type AnyDimension = string | NumericDimension | DateTimeDimension | LiteralsDimension | StringDimension

/** The entries a field `F` of model type `V` takes (any entry when `V` is unknown). */
export type DimensionFor<F extends string, V> = /* number → Numeric;
  bigint → Numeric; date → DateTime; string literal union → F | Literals | String;
  number literal union → F | Literals | Numeric; boolean / mixed literal union → F | Literals;
  string → String | ListedLiterals<string>; anything else → never */
/** The entries of a model with fields `TFields` (name → model type), field by field. */
export type Dimension<TFields = Record<string, unknown>> = {
  readonly [F in keyof TFields & string]-?: DimensionFor<F, TFields[F]>
}[keyof TFields & string]

/** A sort-key prefix composite: exact-match, in front of the address. */
export type PrefixPart<F extends string = string> = F | { readonly field: F; readonly hash: number }
```

`Entity.make` types `sk.zorder` as `ReadonlyArray<Dimension<ModelFields<TModel>>>` (and `prefix`
as `PrefixPart<field names>`), so the editor completes the field names and each field's options,
and a misspelled field, a misspelled option, an option of another kind or a bare name on a field
without members is a compile error on that entry. The option check is a guard on `Entity.make`'s
`indexes` parameter (`ZOrderEntriesGuard`): each `zorder` entry's keys outside those its field's
entries take, and each `{ field, hash }` prefix part's other keys, are typed `never`. In the
indexes' constraint the same check cost every index position its editor completions; on the
parameter it doesn't *(owner 2026-11-01)*. At runtime `normalizeGsiConfig` checks each entry without the model
(`declareDimension`: its form, `[EDD-9086]`; its options, an unknown option included,
`[EDD-9087]`), and `Entity.make` resolves it against its field (`resolveDimension`, `[EDD-9088]`):
a range is `int` when `min`, `max` and `step` are all integers and `float` otherwise (a `bigint`
field takes integers only), and a bare literal-union entry takes the schema's members in order.

The first design declared dimensions with constructors (`ZOrder.int(field, options)`,
`ZOrder.float`, `ZOrder.dateTime`, `ZOrder.literals(field, values, options)`, `ZOrder.string`)
returning a `Dimension` value with a `TypeId`, `Pipeable` and `Inspectable`. A13 replaced them:
the constructor named a type the model already declares, and a free function can't complete or
check the field name against the model it will be used with.

**Binding happens at `Entity.make`.** The schema package's `buildEntityDefinition` turns each
declared entry (checked by `declareDimension`, resolved by `resolveDimension`) into an internal
`BoundDimension` for that entity and field:

```ts
// packages/schema/src/internal/ZOrderCurve.ts (internal; not exported from the barrel)
interface BoundDimension {
  readonly spec: DimensionSpec
  readonly field: string                    // model field name
  readonly storage: DimensionStorage        // resolved from the field's schema (§4.1)
  readonly bits: number
  readonly levels: bigint
  readonly quantize: (keyFormValue: unknown) => bigint   // throws EDD-9092
}
type DimensionStorage =
  | { readonly _tag: "Number"; readonly numeric: "number" | "bigint" }   // stored N, key form number/bigint
  | { readonly _tag: "NumericString" }                                   // stored S, key form number/bigint (CompositeCodec case 2)
  | { readonly _tag: "Epoch"; readonly unit: "epochMs" | "epochSeconds" } // stored N
  | { readonly _tag: "UtcIsoString" }                                    // stored S, fixed-format UTC ISO
  | { readonly _tag: "ZonedIsoString" }                                  // stored S, ISO with offset/zone
  | { readonly _tag: "Literal" }                                         // stored S/N/BOOL, compared by equality
  | { readonly _tag: "RawString" }                                       // stored S, raw UTF-8
interface Layout {                          // plain internal record
  readonly dimensions: ReadonlyArray<BoundDimension>
  readonly bits: number                     // B
  readonly bytes: number                    // W = ceil(B / 8)
  // order / posMask / dimMask / lowerOf tables (§4.2)
}
```

The curve algebra lives in the same internal module: `layout`, `interleave`, `deinterleave`,
`inBox`, `bigmin`, `litmax`, `nextInBox`, `prevInBox`, `plan`, `toBytes`, `fromBytes`, prefix
segment encoding, FNV-1a. Tests import it directly from `src/internal/ZOrderCurve.ts`. None of it
is public API, so the planner's signatures and the stored layout aren't frozen by semver; it is
promoted when the geo follow-up (B4) needs it. Because the binding is per entity and field, one
entry (declared `as const`, to keep its field name a literal) can be reused across entities, and
each entity sharing a GSI may bind it to a different storage (§14). The resolved storage is part of the layout spec the cursor
fingerprint hashes (§10.3).

### 3.2 Index declaration

`GsiConfig.sk` becomes a union. The string half is unchanged; the Z-order half has no
`composite`. The **input** `KeyPart` (used by `GsiConfig.pk`, the string branch of `GsiConfig.sk`
and `primaryKey`) forbids `zorder` and `prefix`, so a misplaced `zorder` on a partition-key half or
on the primary key is a type error, not only a runtime `[EDD-9086]`:

```ts
// packages/schema/src/KeyComposer.ts
export interface KeyPart {
  readonly field: string
  readonly composite: ReadonlyArray<string>
  readonly zorder?: never
  readonly prefix?: never
}

export interface ZOrderKeyPart<TFields = Record<string, unknown>> {   // TFields: the model's fields
  readonly field: string                                                // stored as B
  readonly prefix?: ReadonlyArray<ZOrder.PrefixPart<keyof TFields & string>> // exact-match, in front of the address
  readonly zorder: ReadonlyArray<ZOrder.Dimension<TFields>>             // declaration order = interleave priority
  readonly composite?: never
}

export interface GsiConfig {
  // ...name, collection, type, pk, casing, indexPolicy unchanged
  readonly sk: KeyPart | ZOrderKeyPart
}
```

The **normalised** half is a separate type with a distinct property name, so the input property
`zorder` has exactly one shape (`ReadonlyArray<Dimension>`) and the `NormalizedIndexes`
discriminator below is unambiguous. `IndexDefinition.sk` keeps `composite` and **derives it** as
`[...prefixFields, ...dimensionFields]`:

```ts
export interface ZOrderHalf {
  readonly prefix: ReadonlyArray<{ readonly field: string; readonly hash: number | undefined }>
  readonly layout: Layout       // internal, bound per entity (§3.1)
}
/** Normalised Z-order sort-key half. Built only by `normalizeGsiConfig` + `Entity.make`. */
export interface ZOrderSkPart {
  readonly field: string
  readonly composite: ReadonlyArray<string>   // derived
  readonly zorderHalf: ZOrderHalf
}
export interface IndexDefinition {
  // ...index, collection, type, pk: KeyPart, casing, indexPolicy unchanged
  readonly sk: KeyPart | ZOrderSkPart
}
export const isZOrderHalf = (part: KeyPart | ZOrderSkPart): part is ZOrderSkPart =>
  "zorderHalf" in part && part.zorderHalf !== undefined
```

`IndexDefinition` is also the `primaryKey` input type (`PrimaryKeyDef`, `schema/src/Entity.ts:167`);
a hand-written `ZOrderSkPart` there type-checks only by constructing a `ZOrderHalf`, which needs the
internal layout, and is still rejected at runtime by `[EDD-9086]`.

Why derive `composite` rather than leave it empty: about 60 sites read `sk.composite` as "the
fields that feed this key" (EDD-9002 unknown attribute, EDD-9025 nullable, EDD-9072 packed,
EDD-9022 sparse map, the skip-predicate gate, retain CAS inputs, `indexedDefaultFields`,
`derivedFrom`). Deriving it makes all of them correct for free. An empty list would instead be
misread as canonical shape 6 (constant prefix, always written). The sites that **string-compose**
from `composite` must branch on `isZOrderHalf` (§6.1, §16).

Example (generic listings domain):

```ts
const Listings = Entity.make({
  model: Listing,
  entityType: "Listing",
  primaryKey: { pk: { field: "pk", composite: ["listingId"] }, sk: { field: "sk", composite: [] } },
  indexes: {
    search: {
      name: "gsi2",
      pk: { field: "gsi2pk", composite: ["region"] },
      sk: {
        field: "gsi2sk",
        prefix: ["agencyId"],
        zorder: [
          { field: "price", min: 0, max: 5_000_000, step: 1_000 },                 // 13 bits
          { field: "bedrooms", min: 0, max: 15 },                                  //  4 bits
          { field: "listedAt", from: "2024-01-01", unit: "hours", bits: 16 },      // 16 bits
        ],
      },
    },
  },
})
```

**Type level.** Both copies of `NormalizedIndexes` (`schema/src/Entity.ts:154-165`,
`effect-dynamodb/src/Entity.ts:1826-1837`) forward the half's shape:

```ts
sk: T[K]["sk"] extends { readonly zorder: infer Z extends ReadonlyArray<unknown> }
  ? { composite: readonly [...PrefixFieldNames<T[K]["sk"]>, ...DimensionFieldNames<Z>]; zorderHalf: ZOrderHalf; zorder: Z; prefix: PrefixOf<T[K]["sk"]> }
  : { composite: T[K]["sk"]["composite"] }
```

(`zorder` / `prefix` survive on the normalised *type* only, as phantom carriers for the accessor
typing; the runtime value has `zorderHalf`.)

`IndexSkComposites` (`schema/src/internal/EntityTypes.ts:384-388`, exported from both barrels)
returns `never` for a half with `zorder` (a recorded type change, header item 4), so `IndexSkFields` is empty, `ResolveSkFields` resolves to `never`, and `.where()`
disappears from the accessor through the existing gate (`BoundQuery.ts:307-308`). The accessor's
input is the PK composites only; prefix composites go through `.within()`.

### 3.3 `.within()`

`BoundQuery` gains a fourth type parameter, defaulting to `never` so every existing reference
compiles unchanged:

```ts
// packages/effect-dynamodb/src/internal/BoundQuery.ts
export type WithinKind = "composite" | "zorder"
export interface WithinSpec<B, K extends WithinKind> { readonly bounds: B; readonly kind: K }
/** `.within()` consumed on a Z-order accessor: `.zorder()` stays available. */
export type ZOrderApplied = WithinSpec<never, "zorder">

export type BoundQuery<Model, SkRemaining, A, W extends WithinSpec<any, WithinKind> = never> =
  BoundQueryBase<Model, SkRemaining, A, W> &
  ([SkRemaining] extends [never] ? {} : BoundQueryWithWhere<Model, SkRemaining, A>) &
  ([W] extends [never] ? {} : [W["bounds"]] extends [never] ? {} : BoundQueryWithin<Model, A, W>) &
  ([W] extends [never] ? {} : W["kind"] extends "zorder" ? BoundQueryZOrder<Model, SkRemaining, A, W> : {})

export interface BoundQueryWithin<Model, A, W extends WithinSpec<any, WithinKind>> {
  within(
    bounds: W["bounds"],
    options?: WithinOptions,
  ): BoundQuery<Model, never, A, W["kind"] extends "zorder" ? ZOrderApplied : never>
}

export interface WithinOptions {
  /**
   * Skip-scan probe budget per terminal call (§7.4). After this many probes, the rest of the
   * range is read once with the bounds checked per row. `0` never skips. Default 32.
   */
  readonly maxSkips?: number | undefined
}
```

`where()` now returns `BoundQuery<Model, never, A, never>`: `.where()` and `.within()` exclude
each other. Every `BoundQueryBase` combinator preserves `W`.

**Bound types:**

```ts
type LowerBound<V> = { readonly gt: V; readonly gte?: never } | { readonly gte: V; readonly gt?: never }
type UpperBound<V> = { readonly lt: V; readonly lte?: never } | { readonly lte: V; readonly lt?: never }
export type RangeBound<V> =
  | { readonly eq: V }
  | { readonly between: readonly [V, V] }
  | LowerBound<V>
  | UpperBound<V>
  | (LowerBound<V> & UpperBound<V>)

// D: the entry as declared. A literals entry (a bare name, or one with values / bits) bounds by its
// members (its `values`, else the field's members); any other entry by the field's type.
export type DimensionBound<D, V> = [LiteralsEntryMembers<D, V>] extends [never]
  ? RangeBound<V>
  : RangeBound<LiteralsEntryMembers<D, V>> | Only<{ readonly in: ReadonlyArray<LiteralsEntryMembers<D, V>> }>
```

**Per index kind** (`DynamoClient.ts` `EntityIndexAccessors`, `:901-914`, both `TypedClient`
branches `:775-826`):

| Accessor | `W` | Bounds keys | Value type |
|---|---|---|---|
| Composite SK, unpinned composites remain | `WithinSpec<CompositeWithin, "composite">` | each SK composite not given to the accessor (optional) | `RangeBound<SkOperand<V>>`, `V` from `CompositeFields<M, R>` |
| Composite SK, every composite pinned or `composite: []` | `never` | — | — |
| Z-order SK | `WithinSpec<ZOrderWithin, "zorder">` | each dimension field (optional) and each prefix composite (optional) | dimension: `DimensionBound<D, V>`; prefix: `CaseInsensitive<V>` (exact value only) |
| Collections, `scan`, `versions`, `deleted.list`, `history` | `never` | — | — |

`V` is the **model (Type) value**: `number` for `int` / `float`, `DateTime.Utc` (or `Date`,
per the field's schema) for `dateTime`, the literal union for `literals`, `string` for `string`.
At runtime bounds are put into key form through the accessor's `makeCompositeKeyForm` encoder
(the same one accessor composites use, `DynamoClient.ts:1290-1299`, EDD-9050) before they are
quantized or composed.

**Bound failures throw at `.within()`**, synchronously, like the accessor's own EDD-9050 / EDD-9053
key-form failures today: a value that doesn't reach key form is `[EDD-9050]`; a value that reaches
key form but can't be quantized (`NaN`, an unparseable date, a `literals` value outside the
declared list, in `eq` / `in` / a range end) is `[EDD-9092]`; misuse from untyped code is
`[EDD-9093]`. So every query that reaches a terminal (or `explain()`) has a valid box, and
`explain()` keeps the error type `never`.

Semantics:

- A dimension or composite left out means its full range.
- `literals` ranges are by **declaration order** (`{ gte: "b" }` = every member at or after `"b"`
  in the declared list), and compile to a membership set (§11).
- Results come back in sort-key order: Z-order for a Z-order index (not sorted by any dimension),
  leading-tuple order for a skip-scan. For a Z-order `sk.prefix` skip-scan the tuple order is the
  **encoded** order: each un-hashed segment sorts by (UTF-8 byte length after casing, then bytes),
  so `"b"` (`00 01 62`) comes before `"aa"` (`00 02 61 61`); hashed segments sort by hash and have
  no meaningful order. The docs say so.
- `.within({})` on any accessor is a no-op plan (one key condition, same as no call).

### 3.4 `.zorder()`

```ts
export interface ZOrderOptions {
  /** Default "auto" (§5.6). */
  readonly strategy?: "auto" | "naive" | "jump" | "precise" | undefined
  /** Fixed `Limit` for `jump` requests. Unset: jump run sizing (§8.5), starting at 16. */
  readonly pageSize?: number | undefined
  /** Range cap for `precise` and for `auto`'s precise-or-jump decision. Default 16. */
  readonly maxRanges?: number | undefined
  /**
   * Cap on planned ranges in flight at once. Unset: 4 for reads with a `limit` (estimator-sized
   * pages), 1 for drains without a `limit` (natural 1 MB pages). Set: applies to both (§9.3).
   */
  readonly concurrency?: number | undefined
}

export interface BoundQueryZOrder<Model, SkRemaining, A, W> {
  zorder(options: ZOrderOptions): BoundQuery<Model, SkRemaining, A, W>
}
```

Callable before or after `.within()`; later calls merge over earlier ones. Invalid library
options (`strategy`, `maxRanges`, `concurrency`) are `[EDD-9095]`; `pageSize` numbers are passed
to DynamoDB as `Limit` unchecked, like `.pageSize(n)` today. Precedence for a `jump` request's
`Limit`: `.zorder({ pageSize })`, then `.pageSize(n)`, then jump run sizing. `.pageSize(n)` alone
sizes every request including precise ranges.

`.zorder()`, `.within()` and the `maxSkips` option are **BoundQuery-only**: they need the
accessor's index declaration and key-form encoder, which a bare `Query<A>` doesn't have. No `Query`
pipeable is added for them.

### 3.5 `.pageSize("natural")`

```ts
pageSize(size: number | "natural"): BoundQuery<Model, SkRemaining, A, W>   // BoundQueryBase
export const pageSize: { (size: number | "natural"): <A>(self: Query<A>) => Query<A>; <A>(self: Query<A>, size: number | "natural"): Query<A> }
```

Also on `CollectionQuery.pageSize` (`DynamoClient.ts:731`). `QueryState.pageSizeValue` widens to
`number | "natural" | undefined`. A string other than `"natural"` from untyped code is
`[EDD-9095]`; a number is stored unchecked, as today (DynamoDB rejects a bad `Limit`, and the
library doesn't pre-check limits DynamoDB enforces). `"natural"` means **exactly the 1.36 `computeRequestLimit`**
(kept as `legacyRequestLimit`): `undefined` under a filter or predicate, #133 doubling for
history rows, `remaining` otherwise. A number keeps its meaning: used as given, no adaptation.

### 3.6 `.explain()` and `.onRequest()`

On `BoundQueryBase` (every bound query, collections included) and as `Query` pipeables:

```ts
// BoundQueryBase
explain(): Effect.Effect<QueryExplain, never, never>
onRequest(observer: (event: QueryRequestEvent) => Effect.Effect<void>): BoundQuery<Model, SkRemaining, A, W>

// Query.ts, Function.dual
export const explain: <A>(self: Query<A>) => Effect.Effect<QueryExplain, never, never>  // terminal, data-first only
export const onRequest: {
  (observer: (event: QueryRequestEvent) => Effect.Effect<void>): <A>(self: Query<A>) => Query<A>
  <A>(self: Query<A>, observer: (event: QueryRequestEvent) => Effect.Effect<void>): Query<A>
}

/** One vocabulary for explain, the cursor's `s` and the internal PlanMode. */
export type PlanMode = "key" | "skip-scan" | "filter" | "naive" | "jump" | "precise" | "empty"

export interface QueryExplain {
  readonly index: string                                  // physical name, or "primary"
  readonly plan: PlanMode
  /** Why this plan: e.g. "leading composites bounded", "skip tuple: status",
   *  "history rows on the primary index", "maxSkips: 0", "exact plan fits maxRanges",
   *  "exact plan over maxRanges", "explicit strategy", "empty box". */
  readonly reason: string
  readonly keyConditions: ReadonlyArray<{                 // the ranges known up front; B shown as "0x…" hex
    readonly lower: string | undefined
    readonly upper: string | undefined
    readonly exact: boolean
  }>
  readonly filter: string | undefined                     // the FilterExpression the library adds (§11)
  readonly rowChecks: ReadonlyArray<string>               // fields checked per row (§11)
  readonly sizing: "fixed" | "natural" | "budget" | "adaptive"
  readonly zorder?: {
    readonly bits: number
    readonly box: ReadonlyArray<{ readonly field: string; readonly bits: number; readonly levels: ReadonlyArray<readonly [string, string]> }>
    readonly fill: number                                 // box volume / addresses in [zmin, zmax]
    readonly exactRanges: number | "over-cap"
  }
  readonly maxSkips?: number
}

export interface QueryRequestEvent {
  readonly kind: "read" | "probe" | "count"
  readonly request: number                                // 1-based within the terminal call
  readonly lower: string | undefined                      // display form of the key condition
  readonly upper: string | undefined
  readonly limit: number | undefined
  readonly scannedCount: number                           // rows DynamoDB examined
  readonly count: number                                  // rows after the FilterExpression
  readonly accepted: number                               // rows that became items (reads only)
  readonly discarded: boolean                             // read alongside others, then not used (§9.2, §9.3)
}
```

`explain` composes the plan without sending a request (it needs only the resolved table name). It
describes the plan from the start and ignores `.startFrom()` (cursors are decoded only by the
read terminals, §10.2), so its error type stays `never`.
The observer runs after every request, probes included, inside the terminal's fiber; its
failure is a defect. "Addresses visited vs items returned" (open question 3) is
`Σ scannedCount` vs `Σ accepted`. That includes reads that were sent and then not used: a `fetch`
window member after the one that filled the limit or returned a `LastEvaluatedKey`, and a page a
stream read ahead and never emitted (it ends at the limit or `maxPages`). Each is reported in send
order once its window is settled, with `accepted: 0` and `discarded: true`, so summing
`scannedCount` or consumed capacity over the events counts every read paid for.

### 3.7 Not changing

- `Query.SortKeyCondition` stays `string`-typed. Planned ranges use an internal
  `KeyCondition` with `KeyValue = string | Uint8Array` operands.
- `.where()` is unchanged on composite indexes and absent on Z-order ones.
- A cursor still means the same thing: `None` (`null` in 1.36) means genuinely exhausted, now
  across every range. Its type changes: `Page.cursor`, a collection page's `cursor` and an
  aggregate `ListResult.cursor` are `Option<string>`, and so is `RekeyReport.resume` (§19 A15).
  `startFrom(cursor: string)` and `list({ cursor })` keep their string inputs.
- Legacy unbound `Entity.query.<index>` (`Entity.ts:9375-9420`) gets no `.within()` (§19, D6).

---

## 4. Stored form

### 4.1 Quantization (key form → level)

Dimensions see the **key form** of the value (`schema/src/internal/CompositeCodec.ts:69-149`):
encoded side, except numeric Type with string Encoded (`Schema.NumberFromString`,
`BigIntFromString`), which keeps the number / bigint (case 2). So a `DynamoModel.DateString`
arrives as a UTC ISO string, `DynamoModel.DateEpochMs` as epoch milliseconds, `DateEpochSeconds` as epoch seconds.

| Kind | Validation (`[EDD-9087]`) | `levels` | `q(v)` |
|---|---|---|---|
| `int` | `min`, `max`, `step` safe integers; `min < max`; `1 ≤ step ≤ max - min` | `⌊(max-min)/step⌋ + 1` | `v ≤ min → 0`; `v ≥ max → levels-1`; else `⌊(v-min)/step⌋`. A `bigint` key form is computed in `bigint` arithmetic (`min`, `max`, `step` lifted with `BigInt()`), never mixed with `number`. |
| `float` | finite; `min < max`; `0 < step ≤ max-min`; `levels ≤ 2^53` | same | same (float `⌊⌋`; monotone because IEEE subtraction and division by a positive constant are monotone). A `bigint` key form is `[EDD-9088]`. |
| `dateTime` | `from` parses; `unit` known; `1 ≤ bits ≤ 53` | `2^bits` | `clamp(⌊(epochMs(v) - fromMs) / unitMs⌋, 0, 2^bits - 1)` |
| `literals` | non-empty, distinct; `bits ≥ ⌈log2 n⌉` | `n` | index of `v` in the declared list |
| `string` | `1 ≤ bytes ≤ 16` | `2^(8·bytes)` | big-endian integer of the first `bytes` UTF-8 bytes of `v`, zero-padded |

`bits = max(1, bitLength(levels - 1))` unless declared.

**Storage is resolved per entity and field at `Entity.make`** (the `BoundDimension.storage` of
§3.1), from the field's schema: its key-form kind (CompositeCodec), its `DynamoEncoding`
annotation (`DynamoModel.getEncoding`, `DynamoModel.ts:220`) and its Encoded AST. The precedent is
the vector index's `filterStoredTypes` (EDD-9039). The resolved storage decides `epochMs(v)` and,
in §11, whether a bound can be a FilterExpression:

| Kind | Field (key form → stored) | `storage` | Exact bound checked by |
|---|---|---|---|
| `int` / `float` | `number` → N | `Number` | FilterExpression (N comparison) |
| `int` | `bigint` → N | `Number` (bigint) | FilterExpression (N comparison) |
| `int` / `float` | `number` / `bigint` → S (`NumberFromString`, `BigIntFromString`) | `NumericString` | **row check** on the key-form value: S compares lexicographically (`"1000" < "950"`), and N operands against an S attribute are always false |
| `dateTime` | `DateEpochMs` / `DateEpochSeconds` / `DateEpoch(...)` → N | `Epoch` | FilterExpression, bounds converted to the stored unit (§11) |
| `dateTime` | `DynamoModel.DateString`, `Schema.DateTimeUtcFromString` (and `DynamoEncoding` `storage: "string"` with a UTC domain) → fixed-format UTC ISO S | `UtcIsoString` | FilterExpression (fixed-width UTC ISO sorts chronologically) |
| `dateTime` | `DynamoModel.DateTimeZoned` → ISO with offset / zone S | `ZonedIsoString` | **row check** on epoch ms: `"…T10:00+10:00"` doesn't sort chronologically |
| `literals` | members → S / N / BOOL | `Literal` | FilterExpression by equality (§11) |
| `string` | `string` → S | `RawString` | FilterExpression (byte-wise S comparison = the quantized order) |

Anything else is `[EDD-9088]`: `dateTime` on an un-annotated `number` or a plain `Schema.String`
(its format, and so its order, is unknown), `int` / `float` on a non-numeric key form, `literals`
missing a member of the field's literal union or over a plain `number` (it takes a range, *owner
2026-11-01*), `string` on a non-string key form.

**Clamping is safe.** `q` is monotone non-decreasing, so a stored value outside `[min, max]`
lands in the edge level, and any box containing that level's values reads it; the exact check
(§11) then decides. No false negatives.

**No casing on dimensions.** Dimension values are not key text; `string` uses raw UTF-8, which
matches DynamoDB's byte ordering of an S attribute. Whether DynamoDB's comparison of the *stored*
attribute agrees with the quantized order is decided per field by the storage table above, not
assumed.

**Write-time failure** (`NaN`, an unparseable date, a value not in a `literals` list) is
`[EDD-9092]`, surfaced on the write's error channel as a `ValidationError`, the way EDD-9050 key
form failures are. Query-bound failures throw at `.within()` (§3.3).

### 4.2 Interleave layout (unequal widths, MSB-aligned)

Each dimension's **most** significant bit enters the address in the first round, so every
dimension has coarse control near the top and declaration order breaks ties within a round:

```
layout(dims):
  B = Σ bits_i ;  W = ceil(B / 8)
  order = []                                   // address bit j (0 = MSB) → (dim, dimBit from LSB)
  for r in 0 ..< max_i bits_i:
    for i in 0 ..< dims.length:                 // declaration order = priority
      if r < bits_i: order.push({ dim: i, bit: bits_i - 1 - r })
  posMask[j]  = 1n << (B - 1 - j)
  dimMask[i]  = OR of posMask[j] for every j with order[j].dim = i
  lowerOf[j]  = dimMask[order[j].dim] & (posMask[j] - 1n)      // same dim, less significant
```

The listing example (13 / 4 / 16 bits, B = 33, W = 5): rounds 0–3 emit `p b l`, rounds 4–12
emit `p l`, rounds 13–15 emit `l`. LSB alignment would instead give the top three address bits
to `listedAt` alone, against the declared priority.

```
interleave(q[]):   z = 0n; for j in 0 ..< B: z = (z << 1n) | ((q[order[j].dim] >> order[j].bit) & 1n)
deinterleave(z):   q[] = 0n; for j in 0 ..< B: q[order[j].dim] |= ((z >> (B-1-j)) & 1n) << order[j].bit
toBytes(z, W):     W bytes, big-endian, right-aligned (the top 8W - B bits are 0)
```

### 4.3 Prefix segments

Each prefix composite, in declaration order:

| Declared | Segment bytes |
|---|---|
| `"agencyId"` | `u16be(len) ‖ bytes`, where `bytes = utf8(applyCasing(serializeValue(keyForm(v)), casing))` and `len` is the **byte length of `bytes`** (after casing, which can change it: `"ß".toUpperCase()` is `"SS"`) |
| `{ field: "officeId", hash: n }` (`1 ≤ n ≤ 8`) | the first `n` bytes (big-endian) of FNV-1a-64 over the same UTF-8 bytes |

`casing` is the index's effective casing (`effectiveCasing`, `KeyComposer.ts:117`), so prefix
matching is case-insensitive exactly like today's string composites. There is no composite label
and no delimiter: the length prefix makes the encoding prefix-free (`a` = `00 01 61`, `ab` =
`00 02 61 62`; neither is a prefix of the other) and parsing unambiguous. FNV-1a-64 is specified
by its constants (offset `0xcbf29ce484222325`, prime `0x100000001b3`) and pinned by golden
vectors in the tests, since it is a stored format.

**Order.** Un-hashed segments sort by (byte length, then bytes), not lexicographically by value;
hashed segments sort by hash. Both are correct for skip-scan (prefix-free, successor computable)
but the tuple order users see (and reverse queries walk) is this encoded order (§3.3).

### 4.4 The sort-key value

```
gsiNsk (B) = seg(prefix_1) ‖ … ‖ seg(prefix_k) ‖ toBytes(interleave(q(dim_1), …, q(dim_m)), W)
```

No schema prefix, no entity type, no version byte. Entity isolation comes from the partition key,
which already includes the entity type (`composePk`, `KeyComposer.ts:239`). Changing a Z-order
index's declaration (dimension order, `bits`, `min`/`max`/`step`, `from`, prefix list) changes
what stored bytes mean: it requires a new index (or a backfill), and the cursor fingerprint
(§10) rejects old cursors. The docs say so (migration path in §14).

**Size.** The whole `B` value counts against DynamoDB's 1,024-byte sort-key limit:
`Σ (2 + len_i)` per un-hashed prefix segment, `n` per hashed one, plus `W`. `[EDD-9089]` bounds
only the address (`Σ bits ≤ 512`); the prefix length depends on data. Per the diagnose-on-failure
rule there is no client pre-check: DynamoDB rejects the write, and the existing oversize-key
diagnosis (`WriteDiagnosis.ts:76` `SORT_KEY_MAX_BYTES`, `keyBytes` already measures `B`)
attributes it. A `WriteDiagnosis` test pins an oversized `B` key.

### 4.5 Marshalling

`toAttributeMap` / `toAttributeValue` (`Marshaller.ts:16-25`) already turn a `Uint8Array` into
`{ B }` (`@aws-sdk/util-dynamodb` checks binary before the class-instance fallback). Composers
must return a **plain `Uint8Array`** (the SDK matches on `constructor.name`), never a subclass, and
never an empty array (DynamoDB rejects an empty `B` key; impossible here since `W ≥ 1`). Reads
return `Uint8Array`; GSI key attributes are not model fields, so decode ignores them as it
ignores string GSI keys today. `WriteDiagnosis.ts:128` renders non-`S`/`N` key text with
`JSON.stringify`; it renders `B` as `0x…` hex instead (adjacent fix). The `EmptyKeyBound` message
(`:1307`, "with an empty string") becomes "with an empty string or binary value", since
`isEmptyKeyValue` (`:542`) already matches an empty `B`.

---

## 5. Z-order algorithms

### 5.1 Query box

```
quantizeBounds(within, layout):
  for each dimension i:
    normalise the bound to (lower?, upper?) in the dimension's own order:
      numbers / bigints numerically, dates as epoch ms, strings by UTF-8 bytes,
      literals as their DECLARED INDEX (never the raw value)
    raw EMPTY if lower > upper, or lower = upper with either end exclusive
    bound absent              → I_i = [[0, 2^bits_i - 1]]
    eq v                      → [[q(v), q(v)]]
    between [a, b]            → [[q(a), q(b)]]
    gt/gte v (lower)          → lo = q(v)        // safe for gt too: the exact check removes v itself
    lt/lte v (upper)          → hi = q(v)
    literals in [...]         → the member indexes, sorted, grouped into maximal runs: [[0,1],[3,3]]
    literals range            → [[index(lower), index(upper)]] (declaration order)
    level EMPTY if any interval has lo > hi
    an interval ending at levels_i - 1 (the top level) ends at 2^bits_i - 1 instead
  if any dimension is raw or level EMPTY → EMPTY (plan "empty": no request)
  box = (I_1, …, I_m)        // product of per-dimension interval lists
```

An open upper end runs to the top of the dimension's bits, not its top level: `quantize` clamps,
so no stored value lies above `levels_i - 1`, and the addresses between hold no rows. An edge at
`levels_i - 1` would cut cells that can't hold data and leave them partial, inflating the plan:
with `price` at 5,001 levels in 13 bits, `bedrooms: { gte: 3 }` alone has an exact plan of 128
ranges against the bit ceiling, and none within 100,000 ranges against `levels - 1`, so `auto`
fell back to `jump` for no reason.

A `DateEpochSeconds` (`Epoch`, `epochSeconds`) dimension is quantized from the whole stored seconds
its bound holds (§11), not from its key form, which floors a sub-second end:
`{ gte: T, lt: T + 500 ms }` would otherwise be `T ≥ T` and `T < T`, a raw-inverted pair, and plan
`EMPTY` over a stored `T`. Converted, it is `[T, T]`; `{ gt: T, lt: T + 1 s }` is `[T + 1, T]`,
`EMPTY`, and so is every window inside one second.

Normalising first means `{ gte: 10, lte: 5 }` is `EMPTY` (no request) rather than a `BETWEEN`
with `zmin > zmax`, which DynamoDB rejects, and `literals` `between ["pending", "active"]` over a
list declared `["pending", "active", "closed"]` is the non-empty run `[0, 1]`, not a raw-string
inversion. Raw-inverted bounds that quantize to one level are `EMPTY` too, so the exact check never
sees an inverted pair.

A `Box` is a product of per-dimension interval lists, so membership, cell relation and BIGMIN
stay per-dimension (a union of boxes never needs enumerating).

### 5.2 `inBox` and cell relation

```
inBox(z):  q = deinterleave(z);  ∀i: q_i ∈ ⋃ I_i

// A cell is the set of addresses sharing the top d bits: an axis-aligned sub-box.
Cell = { d, zlo, ranges: per dim [lo_i, hi_i] }        // zhi = zlo | (2^(B-d) - 1)
root = { d: 0, zlo: 0n, ranges: [0, 2^bits_i - 1] }
split(cell): j = cell.d; (i, k) = order[j]
  child0: d+1, zlo,               ranges with hi_i = hi_i & ~(1n << k)
  child1: d+1, zlo | posMask[j],  ranges with lo_i = lo_i |  (1n << k)
relate(cell, box):
  DISJOINT   if ∃i: [lo_i, hi_i] meets no interval of I_i
  CONTAINED  if ∀i: [lo_i, hi_i] lies inside one interval of I_i
  PARTIAL    otherwise
```

A PARTIAL cell always contains an in-box address (it meets every dimension's set), which bounds
the search below.

### 5.3 BIGMIN and LITMAX

**Single box (one interval per dimension): Tropf–Herzog over the layout.** `zmin` / `zmax` are
the interleaved low and high corners.

```
load1000(x, j) = (x |  posMask[j]) & ~lowerOf[j]        // dim bit j := 1, lower bits of that dim := 0
load0111(x, j) = (x & ~posMask[j]) |  lowerOf[j]        // dim bit j := 0, lower bits of that dim := 1

bigmin(z, zmin, zmax):                                  // smallest in-box address > z, for z out of box
  result = undefined
  for j in 0 ..< B:
    switch (bit(z,j), bit(zmin,j), bit(zmax,j)):
      (0,0,0), (1,1,1): continue
      (0,0,1): result = load1000(zmin, j); zmax = load0111(zmax, j)
      (0,1,1): return zmin
      (1,0,0): return result
      (1,0,1): zmin = load1000(zmin, j)
      (0,1,0), (1,1,0): unreachable (zmin ≤ zmax per dimension)
  return z                                               // z was in the box

litmax(z, zmin, zmax):                                  // largest in-box address < z, for z out of box
  result = undefined
  for j in 0 ..< B:
    switch (bit(z,j), bit(zmin,j), bit(zmax,j)):
      (0,0,0), (1,1,1): continue
      (0,0,1): zmax = load0111(zmax, j)
      (0,1,1): return result
      (1,0,0): return zmax
      (1,0,1): result = load0111(zmax, j); zmin = load1000(zmin, j)
  return z
```

**Interval lists (`literals in`, declaration-order ranges): cell descent.** Same contract,
works for any `Box`:

```
nextInBox(z):                    // smallest in-box a ≥ z, or undefined
  return descend(root)
  descend(cell):
    if zhi(cell) < z or relate(cell) = DISJOINT: return undefined
    if relate(cell) = CONTAINED: return max(cell.zlo, z)
    for child in split(cell) in address order:
      a = descend(child); if a ≠ undefined: return a
    return undefined
prevInBox(z): mirror image (children in reverse, zlo > z prunes, min(zhi, z))
```

Only the cells straddling `z` can fail, so the descent is `O(B²)` worst case, `O(B)` typically.
The planner uses `bigmin`/`litmax` when every `I_i` has one interval, `nextInBox`/`prevInBox`
otherwise; the property tests check both against brute force (§15.1).

### 5.4 Capped range planner with gap merging

```
plan(box, maxRanges):
  done = []            // CONTAINED cells as exact ranges
  frontier = [root]    // PARTIAL cells, address order
  while frontier not empty:
    next = []
    for cell in frontier, for child in split(cell):
      switch relate(child, box):
        DISJOINT:  drop
        CONTAINED: done.push({ lo: child.zlo, hi: zhi(child), exact: true })
        PARTIAL:   next.push(child)           // d < B is guaranteed: a depth-B cell is a point
    frontier = next
    lowerBound = count(mergeAdjacent(done ∪ frontier-as-ranges))
    if lowerBound > REFINE_FACTOR × maxRanges or |frontier| > MAX_PLANNER_CELLS: break
  exact  = frontier is empty
  ranges = mergeAdjacent(sortByLo(done ∪ frontier.map(c → { lo: c.zlo, hi: zhi(c), exact: false })))
  while ranges.length > maxRanges:
    k = argmin over adjacent pairs of (ranges[k+1].lo - ranges[k].hi - 1)  // ties: lowest address
    ranges[k] = { lo: ranges[k].lo, hi: ranges[k+1].hi, exact: false }; delete ranges[k+1]
  return { ranges, exact: exact and every range is still exact }

mergeAdjacent: join r, s when s.lo = r.hi + 1 (exact = r.exact and s.exact)
```

`REFINE_FACTOR = 4`, `MAX_PLANNER_CELLS = 16_384`. The merged count is monotone
non-decreasing across levels (splitting never joins), so `lowerBound` is a true lower bound on the
exact plan's size: once it passes the cap, the exact plan can't fit. Gap size is measured in
addresses (the only density proxy available before reading). Work is
`O(B × MAX_PLANNER_CELLS)` at most.

**Caching.** Plans are pure functions of `(layout, box, maxRanges)`. Each accessor keeps an LRU of
64 plans keyed by the fingerprint inputs (§10.3) plus `maxRanges`. A miss only recomputes; the
cursor never depends on the cache.

### 5.5 The three strategies

All three run inside each prefix tuple `T` (§7.5); a range `[lo, hi]` is read as
`#sk BETWEEN T ‖ toBytes(lo) AND T ‖ toBytes(hi)` with the exact check (§11).

| Strategy | Ranges | Advance after a page |
|---|---|---|
| `naive` | one: `[zmin, zmax]` (hull corners), not exact | LEK → same range, `ExclusiveStartKey = LEK`; none → done |
| `jump` | one at a time, starting `[nextInBox(zmin), zmax]`; `Limit` from jump run sizing (§8.5) | see below |
| `precise` | `plan(box, maxRanges).ranges`, in address order | LEK → same range with LEK; none → next planned range |

`jump` advance, given the page's `LastEvaluatedKey` (`a` = its address: the bytes of
`LEK[sk]` after `|T|`):

```
if no LEK:                    range done → tuple done
elif inBox(a):                continue the same key condition, ExclusiveStartKey = LEK
                              (rows at the same address may follow: quantization collides)
else:
  n = nextInBox(a)            // > a, since a is out of the box
  if n undefined or n > zmax: tuple done
  else:                       new key condition BETWEEN T‖n AND T‖zmax, no ExclusiveStartKey
```

`LEK` is used, not the last returned row: rows the FilterExpression dropped are not returned,
but `LEK[sk]` is the last row examined. A jump never fabricates a start key; a GSI start key
would need the table key, which a computed address doesn't have. Reverse (`.reverse()`) mirrors
everything: ranges in reverse, `ScanIndexForward: false`, `prevInBox` / `litmax`, starting
`[zmin, prevInBox(zmax)]`.

### 5.6 Strategy selection (`"auto"`, the default)

```
choose(box):
  if EMPTY:                               plan "empty": no request, items [], cursor None
  if no dimension bounded:                one range covering T (begins_with T, or no SK condition when T is empty)
  p = plan(box, maxRanges) with REFINE_FACTOR = 1
  if p.exact:                             "precise" with p.ranges     // the exact plan fits maxRanges
  else:                                   "jump"
```

This is the issue's proposed default ("`precise` while the plan fits under `maxRanges`, otherwise
`jump`"), with "the plan" read as the **exact** plan: a merged plan always fits the cap, so
"fits" would otherwise always be true. An earlier draft added a third branch (`naive` when
`fill(box) ≥ 0.5`); it is dropped because address fill is not data density, and `jump` already
degrades to a single range when the box has few gaps. It is listed as the rejected alternative in
§19 A11 (confirmed 2026-10-27). `explain().zorder.fill` still reports the fill. An explicit `strategy` skips the
choice. `"precise"` always uses the full refine-and-merge plan
(`REFINE_FACTOR = 4`), so its ranges may be inexact after merging; the exact check removes the
extra rows.

---

## 6. Write path

### 6.1 Composition

```ts
// packages/schema/src/KeyComposer.ts
export type KeyValue = string | Uint8Array

/** Bytes of a Z-order half; throws EDD-9092. Record-taking: added to KeyFormInvariant's RECORD_TAKING. */
export const composeZOrderSk: (
  schema: DynamoSchema.DynamoSchema,
  index: IndexDefinition,          // isZOrderHalf(index.sk)
  record: Record<string, unknown>, // key form
) => Uint8Array

/** composeSk for a string half, composeZOrderSk for a Z-order half. */
export const composeSkValue: (
  schema: DynamoSchema.DynamoSchema, entityType: string, entityVersion: number,
  index: IndexDefinition, record: Record<string, unknown>,
) => KeyValue
```

`composeSk` itself stays `string` and throws a defect for a Z-order half, so `GeoSearch.ts`
(`:160-173`) and other string-only callers are untouched. `composeIndexKeys`,
`tryComposeIndexKeys`, `composeAllKeys` and `composeGsiKeysForUpdatePolicyAware` call
`composeSkValue`; their return types widen to `KeyValue` (see the semver note in the header). `composeSkPrefixUpTo`,
`composeSortKeyBeginsWith`, `composeSortKeyPrefix`, vector partitions, unique sentinels, history
and time-series key helpers stay string-only, and each asserts `!isZOrderHalf`.

### 6.2 `put`, batch, transact

`composeAllKeys` (`KeyComposer.ts:359-378`) already skips a GSI when any `composite` is missing.
With the derived `composite`, a Z-order index is skipped when any prefix composite or dimension is
missing: a sparse index, as for string halves. `Entity.put` (`Entity.ts:5347`), transact/batch
put (`internal/TransactableOps.ts:494-500`) and the retain path need no change beyond the widened
type: `Object.assign(item, keys)` then `toAttributeMap` writes `B`.

### 6.3 `update`, `append` and `indexPolicy`

The skip-predicate (`KeyComposer.ts:688-695`) is unchanged and reads the derived `composite`:
a Z-order half is skipped iff no prefix composite or dimension was removed and every one is
absent from both the payload and the key record.

A Z-order half that is **not** skipped is classified all-or-nothing:

```
classifyZOrderHalf(fields = sk.composite, merged, policy, hasRemoved):
  if every field is present (not undefined / null) in merged: SET composeZOrderSk(merged)
  elif policy = "sparse":                                       REMOVE gsiNsk
  elif hasRemoved:                                              REMOVE gsiNsk   // cascade override
  else:                                                         noop            // preserve
```

There is no truncation: a partial address is meaningless. `composeGsiKeysForUpdatePolicyAware`
dispatches on `isZOrderHalf(index.sk)` for the SK half; the PK half is unchanged.

**Hierarchical prefixes differ from string halves on the write side.** For a string half,
`set({ agencyId }).remove(["officeId"])` truncates the key to the parent (canonical shape 3). A
Z-order half with `prefix: ["agencyId", "officeId"]` can't be truncated (the address follows the
last segment), so the same update REMOVEs the half under both policies (`sparse` by rule,
`preserve` by the cascade override) and the item leaves the index. The hierarchy is a *query*
feature (agency-only or agency + office through `.within()`), not a write-side one. Fixture 8c pins
this, and `guides/index-policy.mdx` says so.

- **Standard update** (`Entity.ts:6917-6937`): SETs marshal through `toAttributeValue`; `B` with no
  change.
- **Retain path** (`Entity.ts:6020-6058`): the composer runs against `newItem`, which has every
  field, so the half recomposes. The put-style fallback `tryComposeIndexKeys` uses
  `composeSkValue`. The CAS input set (`:6271-6275`) already adds the derived `composite`.
- **`append`** (`Entity.ts:9056-9064`): `keyForm(encoded)` is payload and key record; a Z-order
  half recomposes iff `appendInput` carries every field. The docs say so; no new validation.
- **Every field is key material.** A change of at least one quantization level (or of a prefix
  composite) moves the entry: delete + put, 2 index writes. A change within a level writes the same
  bytes (an in-place index update). Every move lands on the GSI partition key (`region` in the
  example), which is shared by every item in it and limited to 1,000 WCU/s; GSI write throttling
  back-pressures and throttles **base-table** writes, so frequent level changes can throttle
  unrelated writes to the table. Coarser steps, or a more selective GSI partition key, reduce it
  (§17).
- **Split ownership.** A writer that owns `price` but not `listedAt` cannot recompose: under
  `preserve` the address goes stale, under `sparse` the item leaves the index. The docs repeat the
  existing rule (one writer per half) with the Z-order consequence.

### 6.4 Canonical GSI-composite fixture shapes 7 and 8

Added to CLAUDE.md ("Canonical GSI-composite test-fixture shapes") and DESIGN.md §7 in commit 5,
and exercised in `KeyComposer.test.ts`, `IndexPolicyV3.test.ts` **and** `connected.test.ts`:

7. **Z-order half** — `byFacets: { pk: [region], sk: { zorder: [price, bedrooms, listedAt] } }`,
   every dimension a mutable model field. Full payload → SET bytes; partial payload → `sparse`
   REMOVE / `preserve` noop / `preserve` + `remove([dim])` REMOVE; untouched → skipped; never
   truncated; a value change within one level writes identical bytes.
8. **Z-order half with `sk.prefix`** — `sk: { prefix: [agencyId, { field: officeId, hash: 8 }], zorder: [...] }`.
   A prefix change moves the entry; a prefix composite alone in the payload, dimensions missing →
   policy decides.

Degenerate fixtures (the meta-instruction requires at least one per gate change, and an audit of
how the new half interacts with the existing shapes, notably 3 and 6):

- **7a (layout edge, single bit)** — a single `literals` dimension with 2 members: 1 bit, `B = 1`,
  `W = 1`; the byte is `0x00` or `0x01`.
- **7a′ (layout edge, mixed widths)** — a 2-member `literals` dimension plus a 13-bit `int`:
  `B = 14`, `W = 2`; the top two bits of the first byte are always zero (right-aligned).
- **7b (shape 6 analogue)** — `pk: { composite: [] }` (constant entity-prefix partition key) with
  a Z-order sort key. The empty PK half is always evaluated and SET; under `sparse` a partial
  dimension payload gives **PK SET + SK REMOVE** (the item leaves the index); under `preserve`,
  PK SET + SK noop.
- **8a (#43 analogue)** — every prefix composite and dimension is also a primary-key composite
  (`primaryKey: [region, agencyId, price, …]`): recomposed from `keyRecord` on **every** write,
  including an update that touches none of them.
- **8b (#41 analogue)** — prefix owned by one writer, dimensions by another: writer A's update of
  the prefix alone must not SET (preserve noop); writer B's full-dimension update must SET only if
  the prefix is also present (from `keyRecord` or payload), else policy.
- **8c (shape 3 analogue)** — hierarchical `prefix: [agencyId, officeId]`;
  `set({ agencyId }).remove(["officeId"])` → REMOVE under `sparse` and under `preserve` (cascade
  override), never a truncated SET.

---

## 7. Composite indexes: `.within()` and skip-scan

### 7.1 Plan choice

Given SK composites `c_1 … c_n`, the accessor pins `c_1 … c_p` (`DynamoClient.ts:1341-1354`).
Bounds name composites after `p`:

```
k = p
while c_{k+1} has an eq bound: k++                           // eq on the next composite = a pin
t = first bounded composite after k (if none: plan "key", the pinned begins_with)
if t = k + 1:  plan "key": one key condition, range on c_t composed as .where() does today
else:          skip tuple = c_{k+1} … c_{t-1}  → plan "skip-scan" (§7.2), when eligible (§7.3)
               within a tuple: eq bounds on c_t, c_{t+1}, … (as many as are eq), then at most one
               range bound on the next composite, form the key condition
every bound not in the key condition → a library row check (§11)
```

**`asParams` with a planner** reports the first request the terminal would send from the start:
the single key condition for `key`, the first range for `naive` / `jump` / `precise`, the first
probe for `skip-scan`. It can't show the whole plan (later requests depend on responses);
`explain()` does. Without a planner `asParams` is unchanged.

Range bounds on `c_t` relative to a composed prefix reuse `composeSkCondition`'s bound
construction (`DynamoClient.ts:1463-1509`: `compose`, `subtreeBeginsWith`, `aboveSubtree`,
`upper`, the EDD-9046 rule). That logic is extracted into
`composeRangeUnder(prefixText, field, bound)` in `DynamoClient.ts`, used by both `.where()` and
the skip-scan, so the two can't drift.

### 7.2 Skip-scan over string keys

```
P     = composeSortKeyBeginsWith(pins, eqs up to k)   // ends with "#" (composites remain, #115)
L_j   = applyCasing(c_j, casing) + "_"                // composite labels, as formatCompositeParts writes them
UPPER = P + SK_MAX_SENTINEL                           // "￿", as today (DynamoClient.ts:198)

probe(lower):                                         // forward
  Query #sk BETWEEN lower AND UPPER, Limit 1, ProjectionExpression #sk, no FilterExpression
  → the row's sk text s, or undefined

tupleOf(s):                                           // parse c_{k+1} … c_{t-1} from the key text
  pos = |P|
  for j in k+1 ..< t:
    require s.startsWith(L_j, pos)                    // else: AMBIGUOUS
    e = s.indexOf("#", pos + |L_j|);  require e ≥ 0   // value ends at the next delimiter
    pos = e + 1
  require s.startsWith(L_t, pos)                      // else: AMBIGUOUS
  return T = s.slice(0, pos)                          // ends with "#"

successor(T) = T.slice(0, -1) + "$"                   // "#" (0x23) + 1; no key char lies between them

loop:
  s = probe(P);  if undefined: done
  T = tupleOf(s)  (AMBIGUOUS → filter fallback from s, §7.4)
  read the tuple's key condition composeRangeUnder(T, c_t, bound) with the normal LEK loop
  s = probe(successor(T)); repeat
```

Every key with prefix `T` sorts below `successor(T)`, and `successor(T)` sorts above the probed
key, so each probe strictly advances: the loop terminates. Reverse: `probe(upper)` is
`BETWEEN P AND upper`, `ScanIndexForward: false`, starting at `upper = UPPER`, then
`upper = T` (no live key equals `T`, which ends in the delimiter).

Probes carry no FilterExpression, so `Limit: 1` returns a row whenever one exists. The partition
holds only this entity's rows: non-collection GSI partition keys include the entity type, and
history rows carry no GSI keys.

**Probe cost.** A `ProjectionExpression` doesn't reduce consumed capacity: a probe costs the size of
the row it reads, rounded up to 4 KB (0.5 RCU per 4 KB eventually consistent, 1 RCU strongly
consistent), not a fixed small amount. With 40 KB items in an `ALL`-projected index (`Table.ts`
always projects `ALL`), 32 probes cost about 160 RCU. On a primary-index accessor, probes
**inherit `.consistentRead()`**, so a consistent tuple read never sees a tuple the probe missed
(GSI accessors can't read consistently, `ConsistentReadOnGsi`). The `maxSkips` guidance in the docs
is phrased in item size × distinct leading values, not probe count alone.

### 7.3 Eligibility

Skip-scan runs only when the parse in §7.2 is **sound for every row**, not just the probed one:

- **Any tuple composite.** Sort key text is escaped (§19 F1), so no composite's key text holds
  `#` or `$`: every probed key parses into its tuple, and the successor (`T` with its trailing `#`
  replaced by `$`) sorts above every key in `T`'s subtree and at or below the next tuple's. The
  first design sent a free-form `Schema.String` tuple composite to the filter plan, since an
  unescaped value containing `#` would sort under another tuple's `T` and be jumped over (D3,
  superseded by F1).
- **No history rows on the queried index.** The primary-key accessor of an entity with
  `versioned: { retain: true }`, `softDelete` or `timeSeries` shares its partition with snapshot,
  tombstone and event rows whose keys don't parse. It takes the filter plan.

`explain()` reports which rule decided the plan.

### 7.4 Budget and fallback (`maxSkips`)

Each probe increments `skips` in the position state. When `skips = maxSkips` (default 32) and
another probe would be needed, the planner switches to the **filter plan** for the rest of the
terminal: one range `[current position, UPPER]` read with the normal loop, every bound evaluated
by the row check. `maxSkips: 0` takes the filter plan immediately. An `AMBIGUOUS` parse also
switches, at the probed key.

The cursor records the plan in force (`s: "skip-scan" | "filter"`, §10). A resumed query continues in
that plan, so it never switches back halfway, and gets a fresh probe budget.

### 7.5 Skip-scan over a binary prefix (Z-order `sk.prefix`)

The same loop, with exact byte parsing:

```
P = segments of the given LEADING prefix composites (possibly empty)
succ(x) = drop trailing 0xFF bytes of x, then increment the last byte; undefined if x is all 0xFF
          (x non-empty); succ(empty) = undefined

probeCondition(lower, upper):          // never sends a zero-length operand
  lower empty and upper undefined → no sort-key condition (PK only)
  lower empty                     → #sk < upper          (forward)
  upper undefined                 → #sk >= lower
  otherwise                       → #sk BETWEEN lower AND upper
probe(lower) = Query probeCondition(lower, succ(P)), Limit 1, ProjectionExpression #sk
reverse probe(upper') = Query (P empty ? #sk <= upper' : #sk BETWEEN P AND upper'),
                        ScanIndexForward false, Limit 1; the first reverse probe has no upper
                        bound beyond succ(P) (or none at all when P is empty)
```

With `P` empty (every prefix composite omitted) the first forward probe has **no sort-key
condition**, and `succ(P)` is open; DynamoDB rejects an empty `B` operand in a key condition
(`EmptyKeyBound`). `RangePlanner` asserts that no key-condition operand is ever zero-length (a
defect, caught by the tests). `BETWEEN lower AND succ(P)` equals `< succ(P)`: every stored key is
longer than `succ(P)` (it carries all prefix segments plus `W ≥ 1` address bytes), so none equals
it.

**The skip tuple runs from the first missing segment through the last prefix segment.** Z ranges
need `T` to be the *complete* prefix, because the address follows the last segment. Given
segments after the first missing one are not part of `P`; each is checked while parsing a probed
key:

```
tupleOf(bytes, from = |P|):           // parse every remaining segment in layout order
  pos = from
  for each prefix segment j after P:
    seg_j = hashed ? n bytes : (u16 length, then that many bytes)
    if segment j is given with value v (encoded seg(v)):
      seg_j < seg(v): SEEK  → next probe from bytes[0 .. start of j] ‖ seg(v)
      seg_j > seg(v): SKIP  → next probe from succ(bytes[0 .. end of the last MISSING segment before j])
      equal:          continue
    pos = end of seg_j
  return T = bytes[0 .. pos]
next probe after a tuple: from succ(T)
```

Byte comparison of `seg_j` with `seg(v)` uses the same (length, bytes) order the keys sort in, so
SEEK and SKIP move strictly forward and the loop terminates. A tuple that parses with every given
segment equal is exact for un-hashed segments (no row check needed); hashed given segments still
get the row check for collisions (§11). When every prefix composite is given, `T = P` and there is
no probe.

Inside each `T`, the §5.5 strategy runs with ranges prefixed by `T`. `maxSkips` and the fallback
apply as in §7.4; the binary parse is never ambiguous.

---

## 8. Adaptive request sizing (§9a)

### 8.1 Sizing modes

```
sizingMode(state):
  pageSizeValue is a number        → "fixed"     (as given; no adaptation)
  pageSizeValue = "natural"        → "natural"   (legacyRequestLimit, 1.36 exactly)
  limitValue undefined             → "none"      (undefined: natural pages; collect/paginate read everything)
  maxPagesValue set, no planner    → "natural"   (1.36 exactly; see below)
  filtered(state) or dropsRows     → "adaptive"
  otherwise                        → "budget"    (Limit = remaining, as today)
filtered(state) = exprFilters ≠ [] or predicates ≠ [] or planner.filter or planner.rowCheck
```

`jump` requests are sized separately in every mode except "fixed" (§8.5).

The `__edd_e__` ownership clause alone stays "budget", as today (it only rejects foreign rows; the
loop fetches another page).

**`maxPages` keeps 1.36 sizing.** With a request cap, smaller requests change what one call
returns: `.filter(…).limit(5).maxPages(1).fetch()` reads up to 1 MB in 1.36 and returns 5 items,
but with an adaptive `Limit` of 16 it would return 0–1 items and a different cursor. The issue's
Scope says results and cursors are unchanged, so a query with `maxPages` and no planner keeps
`legacyRequestLimit` (§19 C6, confirmed 2026-10-27; adapting anyway and recording the change in the
changeset was the rejected alternative). Planned queries (`.within()`) are new, so they adapt under `maxPages` too.

### 8.2 The estimator

State per terminal call: `{ examined, accepted, lastLimit, lastExamined, lastAccepted, requests }`.
It lives in the `execute` loop's locals and in `pageStream`'s `PageState`, never in the cursor (a
resumed query starts fresh).

```
INITIAL_FACTOR = 2   MIN_FIRST = 16   SAFETY = 1.25   GROWTH = 2   MAX_GROWN_LIMIT = 100_000

nextLimit(est, remaining, filteredByUser):
  if est.requests = 0:
    L = filteredByUser ? max(MIN_FIRST, ceil(remaining × INITIAL_FACTOR))
                       : remaining                                     // history only: #133's first request
  elif est.accepted = 0:
    L = est.lastLimit × GROWTH                                         // nothing passed yet: #133's growth
  else:
    rate = est.accepted / est.examined
    if est.lastAccepted > 0:
      rate = min(rate, est.lastAccepted / est.lastExamined)            // the recent rate, when lower
    L = ceil(remaining / rate × SAFETY)
    if est.lastAccepted = 0:
      L = max(L, est.lastLimit × GROWTH)                               // a run of misses grows geometrically
  return clamp(L, 1, MAX_GROWN_LIMIT)

observe(est, response, acceptedThisPage, limitSent):
  scanned = response.ScannedCount ?? response.Items.length
  est.examined += scanned; est.lastExamined = scanned
  est.accepted += acceptedThisPage
  est.lastAccepted = acceptedThisPage
  est.lastLimit = limitSent; est.requests += 1
```

- **Examined** is `ScannedCount`: rows read before the FilterExpression. It covers the ownership
  clause, user filters and the Z-order exact-bounds FilterExpression at once (row checks count as
  rejections in `accepted`). When a response lacks it (mocks,
  older local emulators), `Items.length` stands in.
- **Accepted** is rows that became items after history drops, library row checks and `filterBy`
  predicates. `examinePage` returns `{ items, stoppedAt, accepted }`; without a predicate it stops
  at the budget, which only happens on the last page.
- **1 MB pages** report `ScannedCount < Limit`; the rate stays sound.
- **The miss floor.** The cumulative rate alone recovers slowly from an early cluster followed by a
  long run of misses: with `limit(1000)`, 999 early matches and then 1,000,000 non-matching
  100-byte rows, `L ≈ 1.25 × examined × remaining / accepted` grows `examined` by about 0.125% per
  request: a simulation of these constants takes 4,834 requests against 96 natural 1 MB pages. The floor
  (`L ≥ lastLimit × GROWTH` after a request that accepted nothing) makes every run of misses grow
  geometrically until DynamoDB's 1 MB cap takes over (108 requests in the same simulation).
  `QueryAdaptiveSizing.test.ts` pins this "early cluster, then long desert" case.
- **The recent rate** (review of commit 2). The floor covers one run of misses, not a sparse
  trickle after an early cluster: the cumulative rate stays near the cluster's long after the
  matches thin out, so each isolated later match resets `L` to a few dozen rows and the doubling
  starts over, and `k` sparse matches cost about `k × log2(gap)` requests. With `limit(1000)`, 990
  early matches and then 10 matches 1,000 100-byte rows apart, the cumulative rate alone sends 46
  requests against 2 natural pages; 900 early matches then 100 matches 2,000 rows apart, 61 against
  20. Taking the lower of the cumulative rate and the last request's own sizes the request after
  an isolated match for the gap it came from: 9 and 23 requests.
- **The bound.** Let a request examine `L` rows without filling the limit or reaching the 1 MB
  cap, and accept `a` of the `r` items owed. The next `Limit` is at least `2L` when `a = 0` (the
  floor), and at least `1.25 × L × (r − a) / a` otherwise (the recent rate), which is `2L` or more
  unless `a` is over a third of `r`. Each request of that kind cuts what is owed by over a third,
  so there are `O(log limit)` of them, and they shrink `L` by at most the factor they cut the
  debt. So the requests below the 1 MB cap number `O(log rows)` in all, and the rest each read
  about a natural page: `O(log rows)` requests more than natural pages. A simulation of the
  estimator over 36,000 random piecewise-density partitions (1 to 10 segments, densities from 0 to
  1, limits from 1 to past the match count, rows of 100 B to 40 KB) found none past
  `naturalPages + 0.8 × log2(rows)`.
  `QueryAdaptiveSizing.test.ts` pins both shapes above as "early cluster then sparse trickle".
- **Jump pages don't use the estimator** (§8.5): in `jump`, a low pass rate comes from reading into
  out-of-box gaps, and answering it with a larger `Limit` reads further into each gap.

### 8.3 Where it applies

| Caller | Change |
|---|---|
| `execute` (`Query.ts:1403`), `pageStream` (`:1520`) | `nextLimit` in "adaptive"; observe after each `examinePage` |
| `count` path 1 (predicate → `collect`, `:1586`) | inherits through `collect` |
| `count` path 2 (history, `:1609`) | the #133 case, folded into the estimator |
| `count` path 3 (`Select: "COUNT"`, `:1631`) | with a `limit` and a filter: adaptive, `accepted = Count`; with `maxPages` and no planner: unchanged (§8.1) |
| `buildDynamoCommand` default (`:922`) / `asParams` | reports the first request's `Limit` (now adaptive) |
| `Aggregate.list` (`Aggregate.ts:3822-3831`) | **unchanged** (own loop; §19, C4) |
| `EventStore` direct `Limit` (`EventStore.ts:4500`) | unchanged; its `Query.make` paths inherit |

Without `limit`, every path is unchanged. A collection query with a filter and a limit adapts too
(it runs the same loop).

### 8.4 Contracts kept

`limit` counts results; `maxPages` caps requests (and, for unplanned queries, keeps 1.36 sizing
so one call returns what it did, §8.1); a numeric `pageSize` is used as given; the cursor is built
from the last **accepted** item (#122), so over-reading costs read units but is never incorrect.
What adaptive sizing does change, beyond `Limit`s and request counts (§19 C9, C10):

- **A `fetch` cursor's value.** When a sized request fills the limit on its last returned row,
  #122 keeps DynamoDB's `LastEvaluatedKey` (the request's last row, which the filter rejected or
  which is the item itself) instead of rebuilding from the item, where a natural page would have
  filled the limit mid-page. The cursor resumes at the same place: no row between the two
  positions passes the filter.
- **Whether a `fetch` cursor is `None`.** A natural page has usually read to the end of the
  partition by the time it fills the limit on its last match, so 1.36 returned a null cursor. A
  sized request stops at its `Limit`, so DynamoDB returns a `LastEvaluatedKey` (even when no row is
  left), and the cursor is `Some`. The chain then ends with one empty page, which reads the tail (with the
  estimator's doubling, about `log2(tail / 16)` requests). Restoring the null would mean reading on
  past the limit to look for another match: up to a natural 1 MB page on every such `fetch`, which
  is the read the sizing exists to avoid. 1.36 chains could already end with an empty page (a
  natural page that stops at 1 MB with no match after it), so callers loop on the cursor already.
  `QueryAdaptiveSizing.test.ts` pins this forwards and in reverse, and `connected.zorder.test.ts`
  pins it against DynamoDB Local on a partition whose last match has a long tail.
- **`Query.paginate` page boundaries.** It emits one array per request. Under adaptive sizing
  each request is smaller, so `Query.paginate` piped to `Stream.take(1)` holds the matches among
  the first sized request's rows (`max(16, 2 × limit)` under a filter) rather than every match in
  the first 1 MB. The flattened stream is unchanged, and so is a bound query's `.paginate()`,
  which streams items.
The changelog states the trade-off: a low or uneven pass rate can take more round trips than one
1 MB page (a logarithmic number more, §8.2); `.pageSize("natural")` opts out.

### 8.5 Jump run sizing

`jump` requests are sized from the **in-box run length**, not the pass rate, with or without a
`limit`:

```
JUMP_INITIAL = 16   JUMP_MAX_LIMIT = 1_000

jumpLimit(run, remaining):
  L = run.size                                    // starts at JUMP_INITIAL (or .zorder({ pageSize }) fixed)
  if remaining defined: L = min(L, max(JUMP_INITIAL, ceil(remaining × SAFETY)))
  return clamp(L, 1, JUMP_MAX_LIMIT)

after a jump page:
  LEK in the box (same key condition continues) → run.size = min(run.size × 2, JUMP_MAX_LIMIT)
  LEK out of the box (a jump)                    → run.size = JUMP_INITIAL
  no LEK (range done)                            → unchanged
```

A page that ends in the box means the run is longer than the page, so the next page doubles; a
jump resets to the article's 16, so each jump reads at most about 16 rows into a gap. The worked
case from review (runs of 10 in-box rows separated by 5,000-row gaps, `limit(50)`) reads about 6
gap rows per jump, where pass-rate sizing grew to the 1,000 cap and read about 990. `.zorder({
pageSize })` or a numeric `.pageSize(n)` fixes the size. `count` on a jump plan uses the same
sizing (`Select: "COUNT"` with this `Limit`); without it each `COUNT` request would evaluate up to
1 MB into a gap. `naive` and `precise` ranges use §8.1–§8.2 as ordinary ranges.


---

## 9. The range-jump loop

### 9.1 Planner interface (internal, `src/internal/RangePlanner.ts`)

The planner is **pure**: it never sends a request. It turns the plan and each response into the
next *step*, and the terminal's loop sends every request (reads and probes alike), so every
request is counted against `maxPages` and the limit is checked before any request is sent.

```ts
type KeyValue = string | Uint8Array
interface KeyRange {
  readonly lower: KeyValue | undefined   // inclusive; undefined = open
  readonly upper: KeyValue | undefined   // inclusive; undefined = open
  readonly beginsWith?: KeyValue          // alternative single condition, sent only for a whole, unclipped subtree
  readonly exact: boolean                 // false: rows may fall outside the bounds
}
// PlanMode: the public type of §3.6, shared with explain and the cursor

/** Everything at or before `through` (in scan direction) inside `tuple` is delivered or rejected. */
type Boundary =
  | { readonly _tag: "Start" }                                              // nothing delivered yet in `tuple` (or at all)
  | { readonly _tag: "Through"; readonly through: KeyValue }                // completed through this sort-key value
  | { readonly _tag: "At"; readonly startKey: Record<string, AttributeValue> } // inside a range, after this key
  | { readonly _tag: "TupleDone" }                                          // the whole tuple is finished

interface Position {
  readonly mode: PlanMode
  readonly tuple: KeyValue | undefined    // skip-scan T (undefined: no skip tuple)
  readonly boundary: Boundary             // what the cursor for this position encodes
}
type Step =
  | { readonly _tag: "Read"; readonly at: Position; readonly range: KeyRange; readonly startKey: Record<string, AttributeValue> | undefined; readonly planIndex: number | undefined }
  | { readonly _tag: "Probe"; readonly at: Position; readonly lower: KeyValue | undefined; readonly upper: KeyValue | undefined }
  | { readonly _tag: "Done" }

interface RangePlanner {
  readonly fingerprint: string
  readonly filter: Expr | undefined                       // ANDed into buildFilterClauses
  readonly rowCheck: RowCheck | undefined                 // §11
  readonly start: (cursor: CursorV2 | undefined) => Step | ValidationError    // EDD-9094 on a cursor outside the plan
  readonly afterRead: (step: ReadStep, lek: Record<string, AttributeValue> | undefined) => Step
  readonly afterProbe: (step: ProbeStep, key: KeyValue | undefined) => Step
  /** The precise ranges following `step` in the same tuple, for a window (§9.2). */
  readonly following: (step: ReadStep, n: number) => ReadonlyArray<ReadStep>
  readonly cursor: (step: Step) => CursorV2 | null        // null only for Done
  readonly explain: () => QueryExplain
}
```

`cursor(step)` encodes the step's `Position` (§10.1): a `Read` with a start key encodes `At`; a
`Read` that hasn't started encodes the `Through` boundary *before* it (the end of the last
completed range, or the out-of-box `LastEvaluatedKey` a jump left from), or `Start` of its tuple
when it is the tuple's first read; a `Probe` encodes `TupleDone` for the tuple just finished. A step that hasn't been
sent is therefore never confused with a finished range: the cursor always records what has been
**completed**, and resume derives the next step from the recomputed plan (§10.3).

`QueryState` gains `planner: RangePlanner | undefined`, `cursorText: string | undefined` (§10.2),
`zorderOptions`, `maxSkips` and `observers`. **With no planner, the terminals run today's code
unchanged** (requests and cursors byte-identical); the planner path is a separate branch in each
terminal. A request for a `Read` step overrides the state:
`{ ...state, skConditions: [toKeyCondition(step.range)] }` with `ExclusiveStartKey =
step.startKey`; `buildCommandInput`'s fixed `:sk` / `:sk1` / `:sk2` placeholders
(`Query.ts:858-884`) take `KeyValue` operands through an internal widened `KeyCondition`.
`prepared()` (`:1115`) resolves the planner and decodes the cursor once per terminal.

**Two planner factories, one interface** *(as built; recorded 2026-10-28)*. `compositePlanner`
(§7) and `zorderPlanner` (§5, §7.5) both produce a `RangePlanner`, and share its step types, the
position cursor, `readFrom`, the fingerprint and the `[EDD-9094]` refusal. They do not share a
skip-scan driver: the composite planner's `TupleSpace` / `InnerPlan` seams describe a string tuple
and one range per tuple, and Z-order differs at every hook a shared driver would need. Its keys
are bytes (`succ`, not a bumped delimiter; `P` may be empty, and no operand may be); its tuple
parse SEEKs and SKIPs on given later segments (§7.5) where the string parse only reads labels; its
inner plan is a strategy with `jump` transitions, precise windows (`following`) and run sizing;
and its resume clips address ranges under any strategy, where a string range is kept or dropped
whole and a straddling cursor is refused. A driver parameterised over all of that would hold
little shared code and hide each plan's rules behind indirection. The duplicated shape (probe
budget, filter fallback, cursor `start` dispatch) is kept in step by tests rather than structure:
both planners are checked against brute force for every limit, direction and `maxSkips` fallback
(`SkipScan.test.ts`, `ZOrderQuery.test.ts`), and both cursor `start`s refuse the same malformed
positions (`QueryCursor.test.ts`).

### 9.2 `execute` (and `fetch`)

```
step = planner.start(decodedCursor)                  // EDD-9094 fails the terminal here
requests = 0;  items = [];  window = 1                // precise window size, per terminal
loop:
  if step is Done:                                   return { items, cursor: None }
  if limit reached or (maxPages and requests ≥ maxPages):
                                                     return { items, cursor: Some(planner.cursor(step)) }   // never sent
  if step is Probe:
    key = send probe (requests += 1, observe);  step = planner.afterProbe(step, key);  continue
  // Read: step, plus up to window-1 following precise ranges, within the maxPages budget
  batch = [step, ...planner.following(step, min(window, maxPages - requests) - 1)]
  results = send every member concurrently (Limit per §8; jump per §8.5);  requests += batch.length
  for (member, res) in batch, results, in order:
    observe(...)
    { items+, stoppedAt } = examinePage(res.Items, remaining)       // remaining ≥ 1 here, always
    if limit reached:
      if stoppedAt < res.Items.length - 1:           // stopped inside the page
        return { items, cursor: Some(At(key of res.Items[stoppedAt])) }    // as today (#122)
      next = planner.afterRead(member, res.LEK)                       // pure: no probe is sent
      return { items, cursor: next is Done ? None : Some(planner.cursor(next)) }
    step = planner.afterRead(member, res.LEK)
    if res.LEK: window = 1; discard the rest of the batch; break     // later members can't be resumed
  else: window = min(window × 2, concurrencyCap)                    // every member finished in one page
  if no limit:                                       // single-page fetch, as today: one window per call
    return { items, cursor: step is Done ? None : Some(planner.cursor(step)) }
return { items, cursor: None }
```

(`maxPages - requests` is unbounded when `maxPages` is unset. A throttled member after a usable
prefix is handled per §9.5: the batch is cut at that member and the call returns.)

- **The limit is checked after every window member.** `examinePage` is never called with nothing
  remaining; later members' results are discarded once the limit is reached, and the cursor names
  the next member as *not started* (`Through` the end of the member that filled the limit). Each
  discarded member is still reported to `onRequest` (`discarded: true`, §3.6): it was read. As a
  guard, `examinePage` also returns immediately when `budget === 0` (the latent infinite loop in
  §2).
- **Probes are requests.** They are sent by the loop, counted against `maxPages`, observed by
  `onRequest`, and never sent when the call is about to return: `afterRead` returns a pending
  `Probe` step, and `cursor(Probe)` encodes `TupleDone`. When the limit is hit exactly at a tuple's
  end, the cursor is therefore `Some` even if no further tuple exists, and the next call may
  return an empty page, the same contract as DynamoDB's own `LastEvaluatedKey`.
- **Adaptive window for `fetch`.** A window member other than the first starts fresh (no start
  key), so its results are usable only while every earlier member finished its range in one page.
  The window starts at 1 per call, doubles after a window in which every member finished in one
  page (up to the concurrency cap, §3.4), and resets to 1 when any member returns a
  `LastEvaluatedKey`. A dense range therefore never drags parallel reads along with it: waste
  happens only on the first dense range after a run of single-page ranges, and is bounded by the
  window size at that moment. (A fixed window of `concurrency` would discard up to
  `concurrency − 1` reads on almost every call over dense ranges, about 3 × 128 RCU per call at
  natural 1 MB pages.)

### 9.3 `paginate` / `collect`

`pageStream`'s `PageState` becomes `{ step, open, pageCount, emitted, estimator, window }`, all
plain data, so the stream stays re-runnable. Unlike `fetch`, a stream has no single-position
cursor to honour, so it **never discards**: `open` holds up to `concurrency` precise ranges in
plan order, each with its own start key and at most one buffered page. Each `Stream.paginate` step
sends one request for every open range that has no buffered page, then emits the head range's
pages in order (a page still buffered when the stream ends at its limit or `maxPages` is reported
to `onRequest` as `discarded`, §3.6); a later range's first page waits in its buffer until every earlier range is
drained. Memory is bounded by `concurrency − 1` buffered pages.

`collect()`:

- **precise, no `limit`, no `maxPages`**: `Effect.forEach(ranges, drainRange, { concurrency })`,
  each range drained by its own LEK loop, results concatenated in plan order;
- otherwise the stream above, stopping at the limit (in-flight reads interrupted).

**Concurrency and throughput.** `concurrency` bounds requests in flight, not read units per
second, so it is a trade of latency against throttling risk on one partition key, not headroom.
Every range of a search shares one GSI partition key. A 1 MB eventually consistent page is 128
RCU; at about 20 ms per request one in-flight slot drives about 6,400 RCU/s, so 4 slots draining
natural pages would ask for about 25,600 RCU/s against a partition's 3,000 RCU/s (on-demand tables
enforce the per-partition limit too). DynamoDB can split a hot item collection by sort-key range
over time (split for heat), which raises the real ceiling, but not within one query. Hence the
default (§3.4, §12 Q2): drains without a `limit` (natural pages) run one range at a time unless
`.zorder({ concurrency })` says otherwise; reads with a `limit` (estimator-sized pages, usually
far below 1 MB) use up to 4.

### 9.4 `count`

With a planner, `count` runs `Select: "COUNT"` per range with the planner's filter: precise ranges
via `Effect.forEach({ concurrency })` (default 1 without a `limit`, §9.3); jump advances on
`LastEvaluatedKey` (still returned under `COUNT`) with jump run sizing as the `Limit` (§8.5);
naive and precise ranges use natural pages; skip-scan probes as usual, through the same loop. If
the planner has a row check, `count` instead reads only the attributes the check needs (path 2's
projection style) and counts accepted rows.

### 9.5 Failures and throttling

The library adds no retry to queries: every request goes through the client's SDK retry strategy,
as every query does today (`Batch.ts:518-527` retries only transaction cancellation reasons). What
the planner path adds is the behaviour of a request that still fails:

- **`collect`, `count`, `paginate`.** The first failure fails the terminal; sibling fibers are
  interrupted and no partial result is returned, as when the second page of a single-range query
  fails today. Read units already spent are lost.
- **`fetch`.** If a window member after the first fails with a throttling error
  (`ProvisionedThroughputExceededException`, `ThrottlingException`, `RequestLimitExceeded`) and the
  earlier members produced a usable prefix, the call returns that prefix with the cursor naming the
  failed member as not started; the next call retries it and surfaces the error if it persists.
  Any other error, or a failure of the first member, fails the terminal.
- Parallel SDK retries against one hot partition can compound throttling; the docs give the RCU
  arithmetic of §9.3 and recommend `concurrency: 1` for tables near their partition limit.
  DynamoDB Local never throttles, so these rules are pinned by unit tests with a mocked throttle on
  one range (§15.2), not by the connected suite.

### 9.6 Consistency

Every dimension and prefix composite is key material, so an ordinary field update that crosses a
level **moves** the GSI entry (§6.3). During a multi-request plan (jump, precise, skip-scan), or
between `fetch` calls, a concurrently moved item can be returned twice (read in range A, then again
after it moved into unread range B) or missed (moved from unread into already-read). Plain DynamoDB
pagination has the same anomaly only for sort-key changes; Z-order turns ordinary field updates
into sort-key changes. GSIs are also eventually consistent, so a `.within()` right after an
`update` may not see the move yet. The docs say so (callers can dedupe by primary key), and the
connected test "update moves the entry" is written to tolerate lag; DynamoDB Local applies GSI
updates effectively synchronously, so it can't show the lag.

---

## 10. Cursor v2

### 10.1 Format

```ts
type WireValue = { readonly S: string } | { readonly N: string } | { readonly B: string /* base64 */ }
interface CursorV2 {
  readonly v: 2
  readonly f?: string                            // plan fingerprint (§10.3); absent without a planner
  readonly s?: PlanMode                          // plan in force (one vocabulary with explain)
  readonly t?: WireValue                         // skip tuple T in progress
  // At most one of k / a / d. None of them (planner cursors only) = Start: the beginning of
  // tuple t, or of the plan when t is absent. k alone without a planner:
  readonly k?: Record<string, WireValue>         // At: resume with ExclusiveStartKey = k, inside the range holding k[sk]
  readonly a?: WireValue                         // Through: every in-plan row with sk ≤ a (≥ a in reverse) inside t is done
  readonly d?: 1                                 // TupleDone: tuple t is finished; resume past it
}
encode(c) = "v2." + base64url(utf8(JSON.stringify(c)))
```

The cursor carries a **boundary**, never a range: there is no `[lower, upper]` to trust, and a
`begins_with` condition needs no special encoding. A position that has not started (the next
planned range, a jump target, the next skip tuple) is always encoded as the boundary *before* it,
so "not started" and "finished" can't be confused. `Start` is encoded only after a probe has found
a tuple whose first read wasn't sent (`.maxPages()` reached): `{ t: T }` with none of `k` / `a` /
`d` resumes at the beginning of `T`; nothing below `T` exists, because the probe found `T` as the
first key at or after its lower bound.

### 10.2 Compatibility and decoding

- **Decoding moves to the terminal.** `startFrom` stores the raw string (`QueryState.cursorText`);
  `prepared()` decodes and validates it once the planner exists. So `q.startFrom(c).within(…)` and
  `q.within(…).startFrom(c)` behave the same, and a malformed cursor of either format fails the
  terminal with `[EDD-9094]` (`ValidationError`) instead of throwing from `startFrom` (header item
  6, §19 E4).
- **Format detection.** A cursor starting `v2.` is v2 (`.` is outside the base64 alphabet).
  Anything else is legacy: `JSON.parse(atob(c))` as today, which becomes `{ k }`.
- **Encode.** A query **without a planner** emits the legacy format whenever every key value is
  `S`/`N` and the JSON is Latin-1 (exactly today's bytes; the tests that `atob` cursors stay
  valid). It emits v2 `{ v: 2, k }` otherwise: a `B` key, or key text `btoa` would throw on (a
  pre-existing defect, fixed). A query with a planner always emits v2 with `f` and `s`.
- **Accepted pairings.** A query without a planner accepts a legacy cursor or a v2 cursor with only
  `k`; a v2 cursor carrying `f`, `s`, `t`, `a` or `d` is `[EDD-9094]`. A query with a planner
  accepts a v2 cursor whose `f` matches, and a legacy cursor only for a `key` or `naive` plan,
  where it is read as `At` in the plan's range. Anything else is `[EDD-9094]`.
- `Aggregate.list` keeps its own `btoa` cursor (`Aggregate.ts:1886, 1936`); it never sees `B` keys.

### 10.3 Resume (answers open question 1)

```
start(cursor):
  validate: f matches; t (if any) begins with P and parses as a tuple; k[sk] / a begin with t
  recompute the tuple's plan (cache or not) → ranges R in scan direction
  At k:       the range r ∈ R containing k[sk] (compared after T); none → EDD-9094
              → Read r clipped to start at k[sk] (inclusive), ExclusiveStartKey = k
  Through a:  CLIP R at a:
                forward: keep r with r.hi > a, setting r.lo := max(r.lo, a + 1)
                reverse: keep r with r.lo < a, setting r.hi := min(r.hi, a − 1)
              jump: the first range is [nextInBox(a + 1), zmax] (reverse: [zmin, prevInBox(a − 1)])
              → Read the first clipped range; none left → TupleDone
  TupleDone:  → Probe from succ(t) (reverse: below t); no skip tuple → Done
  Start:      t present → Read the first range of t's plan; absent → the plan's first step
  mode s:     skip-scan / filter as recorded: a resumed query never switches plans (§7.4)
```

Comparisons are on the **address** after stripping `T` (fixed width `W`, so `a + 1` is the next
address) for Z-order plans, and on UTF-8 bytes for string plans (DynamoDB's order; JS string
comparison is UTF-16 order and differs above U+FFFF, so it is not used). String plans (composite
skip-scan, filter) produce `a` only at a tuple's upper bound, and their per-tuple condition depends
only on fingerprinted inputs, so a string range is either kept whole or dropped; a straddling
string range can't arise. Clipping a Z range turns `begins_with T` into
`BETWEEN T‖toBytes(a+1) AND T‖toBytes(2^B − 1)`.

Resume is **position-based and clips**, never filters or indexes into a plan, so it survives a
plan-cache miss, a different `maxRanges`, a different `strategy` and a different library release:
a cursor taken after the precise range `[14,15]` of the box `x ∈ [3,4], y ∈ [2,3]` and resumed
under `maxRanges: 1` (plan `[14,37]`) or `strategy: "naive"` reads `[16,37]`, so the rows at 36 and
37 are still returned. A tampered cursor can only move the position inside the recomputed plan;
it can never widen a range, because every condition is rebuilt from the plan and `k` must lie in
it.

The fingerprint is FNV-1a-32 (hex) over canonical JSON of what must not change between calls:
index name, entity type, `reverse`, the pinned and prefix key-form values, the quantized box (or
composed composite bounds) and the layout spec including each dimension's resolved storage
(§3.1). It excludes `maxRanges`, `concurrency`, `strategy`, `pageSize` and `maxSkips`. It is a
mismatch detector (a cursor from another query), not authentication; containment in the plan is
what bounds a tampered cursor.

---

## 11. Bounds the key condition can't express

| Bound | Checked by | Why |
|---|---|---|
| Z-order dimension whose storage is order-compatible (`Number`, `Epoch`, `UtcIsoString`, `RawString`, `Literal`; §4.1) | **FilterExpression** on the stored attribute (renamed fields via the entity's `renameExpr`), built as an `Expr` so it is compatible with `.select()` (EDD-9054 is for predicates only). Range ends compile to `>=` / `>` / `<=` / `<` pairs (never `BETWEEN`); `literals` → `IN (…)` of the selected members when there are at most 100 (else see the `literals` row below). | Quantization, clamping and string truncation admit out-of-box rows. Only for these storages does DynamoDB's comparison of the stored attribute agree with the quantized order. Always added for a bounded dimension: simpler and never wrong; it costs no read capacity. |
| Z-order dimension with `NumericString` or `ZonedIsoString` storage | **Row check** on the key-form value (numeric, or epoch ms) | S comparison of `"950000"` vs `"1000000"`, or of ISO strings with offsets, disagrees with the numeric / chronological order; an N operand against an S attribute is always false. Either would silently drop in-box rows. |
| `literals` dimension with more than 100 selected members | `NOT (attr IN (complement))` when the complement has ≤ 100 members, else **row check** | DynamoDB's `IN` takes at most 100 operands. The complement form is exact: an item missing the attribute isn't in the index (the half needs every dimension). |
| Hashed prefix composite | **Row check** | Hash collisions. Prefix values are cased in the key; a FilterExpression can't apply casing. |
| Composite bounds after the key condition (§7.1), and every bound in the filter plan (§7.4) | **Row check** | Key semantics (casing, number padding) must agree between skip and filter plans. |

**`Epoch` bounds are converted to the stored unit exactly.** A `DateEpochSeconds` value stores
`toEpochSeconds`, which floors (`effect` `internal/dateTime.ts:608`), and the stored second `S`
stands for the instant `S × 1000` ms. For a bound `v` in ms and `u = v / 1000`: `lt v` →
`< ceil(u)`, `lte v` → `<= floor(u)`, `gt v` → `> floor(u)`, `gte v` → `>= ceil(u)`. Plain
encoding of `.within({ listedAt: { lt: 100.5 s } })` would send `< 100` and drop a stored `100`;
`gte: 100.5 s` would send `>= 100` and admit it. The same conversion, made inclusive
(`> s` → `>= s + 1`, `< s` → `<= s - 1`), decides the dimension's levels and whether any stored
second matches (§5.1). Tests pin sub-unit bounds for `epochSeconds`, including windows inside one
second.

The **row check** is a library-owned raw-row predicate evaluated in `examinePage` next to
`isExcludedRow` (`Query.ts:1088`). For composite and prefix bounds it computes each checked
field's key-form value text from the raw row (`serializeValue` + effective casing, the composer's
own path, escaped as sort key text) and compares it, by UTF-8 bytes, with the bound's value text
(`boundHolds`): value semantics, which escaped key text shares (§19 F1), so a row check and a key
condition agree on every value. The check reads the
stored attribute, not the key: under `'preserve'` a GSI key can be composed from a composite's
earlier value (DESIGN.md §7), and a row check judges that row by its current value, where a key
condition judged it by its key. `.where()` checks no rows. For a dimension bound it computes the
field's key-form value from the raw row (the accessor's `makeCompositeKeyForm`, so a stored
`"950000"` becomes `950000`) and compares it in the dimension's own order (numbers / bigints
numerically, dates as epoch ms, literals by membership). Its attributes are borrowed into an active projection and stripped
afterwards, exactly like `cursorProjectionFields` borrows key fields (`Query.ts:1229-1248`). It
counts as filtering for sizing (§8.1). Neither mechanism names the queried index's key attributes
(DynamoDB rejects those in a FilterExpression).

---

## 12. Resolutions to the open questions (confirmed 2026-10-27)

| # | Question | Resolution |
|---|---|---|
| 1 | Cursor format | Cursor v2 (§10): a completed-through boundary (`k` inside a range, `a` through a key value, or `d` past a finished tuple), the skip tuple, plan mode and fingerprint, `B` as base64. Resume recomputes the plan and **clips** it at the boundary, so it survives cache misses and any change to `maxRanges` / `strategy` / defaults. Mismatched cursors fail with `EDD-9094`. Legacy cursors decode; plain queries keep emitting them. |
| 2 | Default `maxRanges` and `concurrency` | `maxRanges` **16**: each range costs at least 0.5 RCU even when empty, so 16 ranges is an 8 RCU floor. `concurrency` is a latency / throttling trade-off on one partition key, not headroom (§9.3 has the RCU arithmetic): default cap **4** for reads with a `limit` (estimator-sized pages; `fetch` windows start at 1 and grow, §9.2) and **1** for drains without a `limit` (natural 1 MB pages, 128 RCU each). An explicit `concurrency` applies to both. |
| 3 | Debug output | `.explain()` (the plan and the reason it was chosen, no I/O) and `.onRequest(f)` (per-request `scannedCount` / `count` / `accepted`, which is what "addresses visited vs items returned" needs), on every query, not just Z-order (§3.6). No logging by default. `onRequest` is a second public hook beyond the issue's "a plan/explain debug hook": §19 A10, confirmed 2026-10-27. |
| 4 | `.count()` with `.within()` | Yes: `Select: "COUNT"` per planned range with the exact-bounds filter, ranges in parallel up to `concurrency` (default 1 without a `limit`); jump advances on the `LastEvaluatedKey` with jump run sizing as `Limit`; a row check makes it read only the checked attributes (§9.4). |
| 5 | Estimator constants | Internal: `INITIAL_FACTOR 2`, `MIN_FIRST 16`, `SAFETY 1.25`, `GROWTH 2` (also the miss floor), `MAX_GROWN_LIMIT 100_000`; jump: `JUMP_INITIAL 16`, `JUMP_MAX_LIMIT 1_000`. Tuned against the connected suite (§15.3). Users control sizing through `.pageSize(n)`, `.pageSize("natural")` and `.zorder({ pageSize })`. |
| 6 | Prefix encoding | Length-prefixed (u16) cased UTF-8 by default. Hashing is never the default: it makes prefixes opaque in the console and needs a row check. `{ hash: n }` (FNV-1a-64, `1 ≤ n ≤ 8`) is opt-in; the docs suggest `hash: 8` for IDs over about 24 bytes when key size matters. |
| 7 | Skip-scan fallback | The probe budget only (`maxSkips`, default 32; `0` = never skip). "Rows per leading value" is not observable without reading the skipped rows, which is the cost skip-scan avoids. The fallback reads the remainder once with row checks. The cursor records `skip-scan` / `filter` so a resumed query never switches plans; each terminal call gets a fresh budget. Probe cost is the probed row's size (§7.2), so the docs phrase the budget in item size × distinct leading values. |

---

## 13. Build-time validation and new EDD codes (band 9086–9095)

This doc reserves the band. Registry rows are added to `DESIGN.md` ("Diagnostic Code Registry",
`:4414`; "Next free code: `EDD-9086`" at `:4521`, as of `60014d2`) in the commit that first raises each code
(commit 2 for 9095, commit 3 for 9093–9094, commit 4 for 9086–9092), with a band row `9086–9095 | Z-order indexes,
range planning, skip-scan, cursors` and "Next free code: `EDD-9096`". Commit 1 is the design doc
alone. `EDD-9085` is the highest code in use; no other branch claims 9086+ (re-verified
2026-10-27 on the tree rebased onto `60014d2`: no source or doc outside this design uses
9086–9095).

| Code | Raised in | Condition |
|---|---|---|
| `EDD-9086` | `KeyComposer.ts` (`normalizeGsiConfig`), `Entity.ts` (schema) | Malformed Z-order sort key: `zorder` on the primary key; `zorder` empty or holding a non-`Dimension`; `composite` together with `zorder` / `prefix`; `prefix` without `zorder`; `type: "clustered"`; a field listed twice (two dimensions, two prefix composites, or both) |
| `EDD-9087` | `internal/ZOrderDimension.ts` (`declareDimension` via `normalizeGsiConfig`; `resolveDimension` at `Entity.make`), `KeyComposer.ts` (`prefix` `hash`) | Entry or prefix options invalid (§4.1 table): options of two kinds, an option no entry of its kind takes, fractional options over a `bigint` field, `hash` outside 1..8, a prefix part key other than `field` / `hash` |
| `EDD-9088` | `Entity.ts` (schema) | A dimension's codec doesn't fit its field, or the field's storage can't be resolved (§4.1 storage table): `int` / `float` on a non-numeric key form, `float` on a `bigint`, `dateTime` on an un-annotated number or a plain string (unknown format, so unknown order), `literals` missing a member of the field's literal union, `string` on a non-string key form |
| `EDD-9089` | `Entity.ts` (schema) | Bit budget: a dimension over its kind's limit, or `Σ bits > 512` (64 address bytes) |
| `EDD-9090` | `Entity.ts` (schema), `_injectIndex` | A Z-order index declares `collection`, or a collection injects one |
| `EDD-9091` | `Table.ts` (`Table.make`, `Table.definition`) | One physical attribute is declared with two types across table members: a Z-order (`B`) half and a string (`S`) key half, or a key attribute and a vector filter attribute |
| `EDD-9092` | `internal/ZOrderCurve.ts`: via the write paths (`ValidationError`), and thrown synchronously from `.within()` for a query bound (§3.3) | A value can't be quantized: `NaN`, an unparseable date, a value outside a `literals` list |
| `EDD-9093` | `DynamoClient.ts` (accessor), `internal/BoundQuery.ts` | Misuse reachable from untyped code: on a Z-order accessor, a dimension or prefix composite passed as an accessor composite (the accessor branches on `isZOrderHalf` before `composeSortKeyBeginsWith`, so this is a typed error, not the composer's defect); in `.within()`, an unknown or PK field, a pinned composite, a range bound on a prefix composite, `in` on a non-`literals` dimension, `.within()` with `.where()` or a second `.within()`, a bound of the wrong type |
| `EDD-9094` | `Query.ts` (`ValidationError` at the terminal, from `prepared()`) | A cursor that doesn't belong to the query: malformed cursor of either format, fingerprint mismatch, a v2 planner cursor on a query without a planner, a legacy cursor for a multi-range plan, or a position outside the recomputed plan (§10.2, §10.3) |
| `EDD-9095` | `Query.ts`, `internal/BoundQuery.ts` | Invalid library option: unknown `strategy`; `maxRanges` or `concurrency` not a positive integer; `maxSkips` not a non-negative integer; a `.pageSize()` string other than `"natural"`; `.zorder()` on a query without a Z-order accessor. Numeric `pageSize` values are not checked (DynamoDB enforces `Limit`). |

Existing checks that cover Z-order halves through the derived `composite`, unchanged:
`EDD-9002` (field not on the model), `EDD-9025` (nullable), `EDD-9072` (packed), `EDD-9022`
(sparse map). Their registry rows gain "(incl. Z-order prefix composites and dimensions)".

Placement: the schema package's `buildEntityDefinition` (`schema/src/Entity.ts:396+`, beside the
EDD-9001/9002 checks at `:438-462`); `declareDimension` (through `normalizeGsiConfig`) for 9087
and the entry-form 9086 cases; `normalizeGsiConfig` for the other structural 9086 cases it can see.

Three codes past the band come with the key-text commits (§18 5a, 5d, 5e), each registered in
`DESIGN.md` with its own band row by the commit that raises it; "Next free code" ends at
`EDD-9099`.

| Code | Raised in | Condition |
|---|---|---|
| `EDD-9096` | `internal/NumericKey.ts` (schema, through `KeyComposer.serializeValue`); 5a | A key composite or bound with no numeric key text: `NaN`, or a bigint of more than 1,000 digits (E8) |
| `EDD-9097` | `Errors.ts` (schema, `ItemNotMoved`), from `internal/TransactWriteOps.ts` and `Entity.ts`; 5d | A `Transaction.transactWrite` op (or an `EventStore` append's `additionalItems`, or a planned transactional update or delete) whose item is still under its 1.36 key, or whose current key holds another value's 1.36 row: a transaction can't move it (F3) |
| `EDD-9098` | `internal/Rekey.ts`; 5e | A `rekey` option that is not a positive integer, a malformed resume token, another table's token, or a `segments` other than the token's (F4) |

---

## 14. Table: `B` attribute definitions and the sharing check

New `resolveKeyAttributeTypes(entities, aggregates, primary)` in `Table.ts`, called from
`Table.make` (after `mergeSecondaryIndexes`, `:171`) and `Table.definition` (`:619-636`), so the
check also runs for the synthetic tables `DynamoClient.make` builds without `tables`
(`DynamoClient.ts:1903-1953`, through `tableDefinition` at `:2012`):

```
types = Map<attribute, { type: "S" | "N" | "B", owner }>
add(primary pk, S), add(primary sk, S)
for entity, for index in entity.indexes:  add(index.pk.field, S); add(index.sk.field, isZOrderHalf(index.sk) ? B : S)
for aggregate: pkField S; collection sk S (when collection.index is set); list index pk/sk S
for vector index: partition S; each filter attribute filterStoredTypes[...] (S | N)
add(name, type): an existing entry with another type → [EDD-9091] naming both owners
```

`Table.definition`'s `AttributeDefinitions` (`:689-691`) read the type from the map; the vector
merge (`:697-712`) no longer silently skips a name whose type differs (it is caught above). The
JSDoc at `:595` changes to "S, or B for a Z-order sort key". `EntityLike` (`:49-61`) already
carries `indexes: Record<string, IndexDefinition>`, which now includes `sk.zorderHalf`.

**Several entities on one Z-order GSI** is allowed: EDD-9069 already forces one `(pk, sk)` field
pair per index name, this check forces `B` on every member, and each entity's partition key keeps
its addresses apart. Dimensions may differ per entity.

`buildTableOperations`'s fallback (`DynamoClient.ts:2093-2107`) hard-codes the primary `pk`/`sk`
as `S`; Z-order on the primary key is out of scope, so it is untouched. `addVectorIndex`'s
partition stays `S`.

**Adding a Z-order index to an existing table.** `db.tables.update` is a raw `UpdateTable`
passthrough (`DynamoClient.ts:2113`), and `AttributeDefinitions` types are table-wide per attribute
name, while a GSI's key types can't be changed in place. The migration path the docs give:

1. Use a **new attribute name** for the `B` sort key and a **new GSI**; never reuse an attribute
   that already holds `S` values (an existing string index being converted, or non-ORM items).
   DynamoDB's backfill silently leaves items whose attribute has the wrong type out of the new
   index (index-key violations), and later writes that carry an `S` value there are rejected.
   `[EDD-9091]` sees only registered entities, not stored data.
2. Take the GSI spec and its `AttributeDefinitions` (with `AttributeType: "B"`) from
   `Table.definition(table)` (public, `Table.ts:607`) and pass them to `db.tables.update` as a
   `GlobalSecondaryIndexUpdates: [{ Create: … }]`.
3. Rewrite existing items (a `put`, or an `update` carrying every prefix composite and dimension,
   composes the new half) so they carry the new `B` attribute; until then they are absent from the
   new index.

---

## 15. Test plan

### 15.1 Schema package

| File | Covers |
|---|---|
| `packages/schema/test/ZOrder.test.ts` (new; `it.prop` from `@effect/vitest`, already a dev dependency; imports the curve algebra from `src/internal/ZOrderCurve.ts`) | **Property:** quantize monotone per kind; `deinterleave ∘ interleave = id` for random layouts (1–4 dimensions, 1–8 bits); `inBox` agrees with per-dimension membership; `bigmin` / `litmax` / `nextInBox` / `prevInBox` equal brute force over every address (`B ≤ 12`) for random boxes and interval lists; `plan`: every in-box address is inside a range, exact ranges hold only in-box addresses, `ranges.length ≤ maxRanges`, `exact` iff no inexact range, and with a large cap the plan equals the brute-force maximal runs; gap merge picks the smallest gap. `quantizeBounds`: inverted pairs (`{ gte: 10, lte: 5 }`) and raw-inverted bounds within one level are `EMPTY`; `literals` ranges by declared index (`between ["pending", "active"]` non-empty). **Unit:** MSB-aligned layout of 13/4/16 bits; the issue's 3-bit example (BIGMIN(16) = 36); `bigint` `int` quantization; EDD-9087 per option; FNV-1a-64 golden vectors; prefix segments are prefix-free and `len` is the cased UTF-8 byte length (`ß` under `uppercase`); (length, bytes) segment order; `succ` with carries, all-`0xFF` and empty input. |
| `packages/schema/test/KeyComposer.test.ts` | `normalizeGsiConfig` carries `zorder` / `prefix`, derives `composite`, EDD-9086 cases; `composeZOrderSk` bytes (golden); `composeAllKeys` / `tryComposeIndexKeys` skip a Z-order GSI with a missing field; `composeSk` refuses a Z-order half; **shapes 7, 7a, 7a′, 7b, 8, 8a, 8b, 8c** under `composeGsiKeysForUpdatePolicyAware` (SET, sparse REMOVE, preserve noop, cascade REMOVE, skip, no truncation; 7b PK SET + SK REMOVE; 8c REMOVE not truncation). |
| `packages/schema/test/EntityZOrder.test.ts` (new) | EDD-9086, 9088, 9089, 9090 at `Entity.make` and `_injectIndex`; EDD-9002 / 9025 / 9072 / 9022 fire for dimensions and prefix composites; storage resolution per §4.1 (`Number`, `NumericString` for `NumberFromString` / `BigIntFromString`, `Epoch`, `UtcIsoString`, `ZonedIsoString`, EDD-9088 for a plain-string `dateTime`); one `Dimension` value bound to two entities with different storages. |
| `aws-free-guard.test.ts`, `node-free-guard.test.ts` | Unchanged; they now cover `ZOrder.ts` and `internal/ZOrderCurve.ts` (no `Buffer`, no `node:crypto`, no `aws-sdk` substring in its doc comments). |

### 15.2 effect-dynamodb unit (mocked client)

| File | Covers |
|---|---|
| `test/QueryAdaptiveSizing.test.ts` (new) | Limits follow the pass rate: high (≈ remaining × 1.25), low, zero then non-zero (doubling, then rate-based); the miss floor ("early cluster then long desert") and the recent rate ("early cluster then sparse trickle", two shapes), each within `naturalPages + log2(rows)` requests; `MIN_FIRST`; cap 100,000; `ScannedCount` missing → `Items.length`; numeric `pageSize` wins; `"natural"` reproduces every 1.36 expectation; `limit` + filter + `maxPages` keeps 1.36 `Limit`s and results (pinned); `maxPages` still caps; cursor after the last accepted item; a limit filled on a sized request's last returned row (non-null cursor, then an empty page; pinned against `"natural"`'s chain), forwards and in reverse, each chain equal to `collect`; collections adapt; `count` paths 1–3 with and without `limit`; estimator state in `PageState` (re-run the stream). |
| `test/PartitionMock.test.ts` (new) | The partition mock the sizing, skip-scan and Z-order tests share: `=`, `<`, `<=`, `>`, `>=`, `BETWEEN` and `begins_with` narrow the rows in both directions, `ExclusiveStartKey` resumes in both directions, and an unrecognised `#sk` condition is a defect (never every row). |
| `test/QueryLimitPageSize.test.ts`, `test/Query.test.ts` | **Updated pins:** "under a filter, limit is never handed to DynamoDB" (`:179`) and "asParams reports the first request's Limit" (`:609-621`) now expect the adaptive first `Limit`, and the same cases under `.pageSize("natural")` keep `undefined`; #133 "limit is sent as Limit" (`[2, 4]` → `[2, 3]`, same request count), logarithmic bounds (`≤ 11`, `≤ 10`) unchanged; `filterBy` "Limit undefined under a predicate" (`:1593-1602`) moves under `"natural"`. "No predicate leaves every existing path byte-identical" stays green as is. |
| `test/QueryCursor.test.ts` (new) | Legacy bytes unchanged for plain queries; v2 round-trip with `B`, with non-Latin-1 text, with every field; legacy decode; decoding deferred to the terminal (`startFrom` before or after `.within()` is the same; a malformed cursor fails the terminal, not `startFrom`); EDD-9094 (malformed, fingerprint, legacy for multi-range, v2 planner cursor on a plain query, `k` outside the recomputed plan, `t` not under `P`). |
| `test/SkipScan.test.ts` (new; `servePartition`-style mock with BETWEEN / `ScanIndexForward` / `Limit`) | Results equal a filtered full read for random partitions; probe count = distinct tuples + 1; casings `lowercase` / `uppercase` / `preserve`; values with characters below `#`; `Schema.String` tuple composite → filter plan; primary accessor with history rows → filter plan; `maxSkips` fallback mid-way and `maxSkips: 0`; resume mid-skip and mid-fallback keeps the plan; reverse; `maxPages` counts probes (`.maxPages(1)` sends only the first probe and returns a `Start` cursor `{ t: T1 }`); no probe is sent when the limit is reached at a tuple's end; probes inherit `.consistentRead()` on a primary accessor; binary prefix skip: missing leading, missing middle (SEEK and SKIP on a given later segment), all given, and **all omitted** against a mock that rejects a zero-length `B` operand; binary request counts, hashed and unhashed: a SEEK costs one probe per given segment instead of one per tuple, a SKIP leaves a passed tuple unread (only the matching tuples are read), and `maxSkips` caps the probes before the filter plan. |
| `test/ZOrderQuery.test.ts` (new; in-memory partition mock comparing `B` as unsigned bytes) | `naive`, `jump`, `precise`, `auto` each return the brute-force filtered set; `auto` choices (exact fits → precise / over cap → jump); empty box (incl. inverted bounds) sends nothing; `limit` / `maxPages` contracts; `fetch` cursor chains equal one `collect`, **including a limit that lands exactly on a range end** for precise, jump (after an out-of-box LEK) and skip-scan (after a tuple); the limit filled exactly by the first window member (later members discarded, never examined, but reported to `onRequest` as `discarded`); **cross-plan resume**: a cursor taken under `maxRanges: 16` resumed under `maxRanges: 1` and under `strategy: "naive"` returns exactly the remaining rows (the `[14,15]` / `[36,37]` example, plus a property test over random plans); adaptive `fetch` window (grows after single-page ranges, resets on LEK); stream buffering never discards; a mocked throttle on one range (`fetch` returns the prefix + cursor; `collect` fails); jump run sizing on gapped data (doubles in-box, resets after a jump) and under `count`; `NumberFromString` and `DateTimeZoned` dimensions use the row check and return in-box rows; `DateEpochSeconds` sub-second bounds, including windows inside one second (`gte: T, lt: T + 500 ms` holds `T`; `gt: T, lt: T + 1 s` sends nothing); a `literals` selection over 100 members (complement `NOT IN`, and row check when both sides exceed 100); `collect` concurrency (`concurrency: 1` vs `4` same order); reverse; `count`; `explain` and `onRequest` payloads; exact filter compiled on renamed fields; `.select()` with a plan. |
| `test/BoundQuery.test.ts` | `within` / `zorder` / `pageSize("natural")` / `explain` / `onRequest` plumbing; `where` and `within` exclude each other; EDD-9093 / 9095 on untyped calls. |
| `test/DynamoClient.test.ts` | Accessor typing at runtime for Z-order and composite `within`; `composeRangeUnder` shared with `.where()` (existing #115 clamping tests unchanged). |
| `test/IndexPolicyV3.test.ts` | Shapes **7, 7a, 7a′, 7b, 8, 8a, 8b, 8c** through `Entity.update`, the retain path and `append`; `B` key values are asserted with `toEqual`, which compares `Uint8Array`s by their bytes. `test/helpers/MockDynamoClient.ts` is unchanged: it records requests and never orders keys. Unsigned byte order lives in the mocks that serve queries, `test/helpers/InMemoryTables.ts` and `test/helpers/PartitionMock.ts`. |
| `test/Table.test.ts` | `B` in `AttributeDefinitions`; two entities sharing one Z-order GSI; EDD-9091 (`B` vs `S`, key vs vector filter); synthetic table path. |
| `test/KeyFormInvariant.test.ts` | `composeZOrderSk`, `composeSkValue` added to `RECORD_TAKING`. |
| `test/WriteDiagnosis.test.ts` | `B` key text rendered as hex; an oversized `B` sort key (long prefix segments) attributed by the existing oversize-key diagnosis; `EmptyKeyBound` wording for a binary operand. |
| Types: `test/Entity.types.test.ts`, `PureAuthoring.types.test.ts`, `Collection.types.test.ts` | `zorder` / `prefix` on a `pk` half or on `primaryKey` is a type error; `.where()` absent on Z-order accessors; `.within()` bound types per kind (number, `DateTime.Utc`, literal union with `in`, prefix exact values); `.zorder()` only on Z-order accessors; `within` hidden when all composites pinned, on collections and on `scan`; `where` / `within` mutual exclusion. |

### 15.3 Connected (gate 4, mandatory)

| File | Covers |
|---|---|
| `test/connected.test.ts` | **Shapes 7, 7a, 7a′, 7b, 8, 8a, 8b, 8c** end to end (the canonical-shape rule requires this file); table create with a `B` sort key; `update` moves the entry when a dimension or prefix changes and leaves it when nothing in the key changes (asserted as eventually consistent; Local hides GSI lag, §9.6). |
| `test/connected.zorder.test.ts` (new) | 2,000 seeded listings: every strategy and `auto` equals a brute-force filtered scan; `fetch` cursor chains (incl. limits landing on range ends); `count`; reverse; a `NumberFromString` dimension returns the same set as a brute-force scan (the stored-type case Local can show); jump `ScannedCount` on gapped data with run sizing vs a page sized to the cap, and on a selective box (about 4% of the partition) vs the pass-rate-sized filtered query over the partition, with explicit ratios (jump ≤ 2 rows examined per row returned, the filter ≥ 10× jump), for `collect` and `count`; `DateEpochSeconds` windows inside one second; adaptive sizing returns identical results with fewer `ScannedCount` than natural pages for a selective filter with `limit(5)` (measured through `onRequest`); an adaptive `fetch` chain returns natural's pages and then one empty page when the last match has a long tail (§8.4); skip-scan over a `literals` status composite equals a filtered read with fewer rows examined; estimator constants sanity-checked here (Q5). |

### 15.4 Other gates

`pnpm lint`, `pnpm check`, `pnpm test`, the doctest sync / typecheck / runtime suites (the new
example runs under the 30 s limit: seed ≤ 300 items with `Batch.write`), language-service tests
(`EntityResolver` parses `zorder` / `prefix` halves, so a Z-order index still appears in hovers
and lists its dimensions; `ParamsBuilder.ts` and `diagnostics.ts` branch on `isZOrderHalf`
instead of string-composing), and `npx tsx examples/guide-zorder.ts` plus
`guide-queries.ts` against DynamoDB Local. Geo tests unchanged (`composeSk` keeps its type).

---

## 16. Files to change

### `packages/schema`

| File | Change |
|---|---|
| `src/ZOrder.ts` (new) | Public, types only (A13): the entry types (`NumericDimension`, `DateTimeDimension`, `LiteralsDimension`, `ListedLiteralsDimension`, `StringDimension`, `AnyDimension`), `DimensionFor`, `Dimension<TFields>`, `DimensionKind`, `DateTimeUnit`, `LiteralValue`, `PrefixPart` |
| `src/internal/ZOrderDimension.ts` (new) | Internal: `declareDimension` (an entry's form and options, model-free) and `resolveDimension` (an entry against its field: kind, members, storage) |
| `src/internal/ZOrderCurve.ts` (new) | Internal: `BoundDimension`, storage resolution, `Layout`, interleave, `inBox`, `bigmin` / `litmax` / descent, planner, prefix segments, FNV-1a, bytes helpers |
| `src/index.ts` | `export type * as ZOrder` |
| `src/KeyComposer.ts` | `KeyPart` gains `zorder?: never` / `prefix?: never`; `ZOrderKeyPart`, `ZOrderSkPart`, `ZOrderHalf`, `isZOrderHalf`, `KeyValue`; `IndexDefinition.sk` union; `normalizeGsiConfig` (EDD-9086, derived `composite`); `composeZOrderSk`, `composeSkValue`; widened returns; `classifyZOrderHalf` in the policy composer; asserts in string-only helpers |
| `src/Entity.ts` | `NormalizedIndexes`; dimension binding and storage resolution (§3.1, §4.1); validation EDD-9086 / 9088 / 9089 / 9090 |
| `src/internal/EntityTypes.ts` | `IndexSkComposites` → `never` for Z-order halves; exported `DimensionFieldNames`, `PrefixFieldNames` helpers |
| `src/internal/CompositeCodec.ts` | `keyFormValueKind` and `keyFormLiterals`: the kind of value a field's key form is, and the literals it is limited to. Planned as no change; built because the EDD-9088 storage checks (`Entity.ts`) and the EDD-9093 bound-type checks (`DynamoClient.ts`) read both from the schema, and the key-form rules live here |

### `packages/effect-dynamodb`

| File | Change |
|---|---|
| `src/index.ts` | re-export `ZOrder`; new types (`ZOrderOptions`, `WithinOptions`, `QueryExplain`, `QueryRequestEvent`, `PlanMode`, `RangeBound`) |
| `src/Query.ts` | estimator + sizing modes; `legacyRequestLimit`; `pageSize("natural")`; `examinePage` returns `accepted`; `send` reports `Count` / `ScannedCount` and notifies observers; `examinePage` `budget === 0` guard; `maxPages` keeps legacy sizing for unplanned queries; planner branch in `execute` / `pageStream` / `count` (window, stream buffering, throttle rule); internal `KeyCondition`; cursors through `internal/Cursor.ts`; `startFrom` stores `cursorText`, decoded in `prepared()`; `explain`, `onRequest` (dual); row check in `isExcludedRow` and `cursorProjectionFields`; `asParams` reports the first planned request |
| `src/internal/RangePlanner.ts` (new) | Pure `RangePlanner`, `Step`, `Position`, `Boundary`; key / skip-scan / filter / naive / jump / precise planners; probe steps; resume clipping; jump run sizing |
| `src/internal/Cursor.ts` (new) | The legacy / v2 cursor codec (§10.2): `CursorV2`, `encodeKeyCursor`, `encodeV2`, `decode`, and the wire form that carries `B` as base64. Planned inside `Query.ts`; built as its own module so `RangePlanner.ts` can read and write cursor positions without a runtime import of `Query.ts` (it imports only types from it) |
| `src/internal/BoundQuery.ts` | fourth type parameter; `within`, `zorder`, `explain`, `onRequest`; `pageSize` widening; `BoundQueryConfig.planWithin` hook |
| `src/DynamoClient.ts` | `EntityIndexAccessors` per-kind typing (both `TypedClient` branches); the accessor's runtime path (`:1301-1341`) branches on `isZOrderHalf` before `hasSkComposites` / `composeSortKeyBeginsWith`, rejects dimension or prefix inputs with EDD-9093, and leaves `BoundQueryConfig.skFields` empty for a Z-order half; `planWithin` per accessor; `composeRangeUnder` extracted from `composeSkCondition`; `CollectionQuery.pageSize` / `explain` / `onRequest`; skip-scan eligibility |
| `src/Entity.ts` | `NormalizedIndexes`; widened key types through put / update / retain / append; Z-order dispatch where `.composite` is string-composed (`:2384`, `:4149`, `:4202`, `:8397`, `:8912`, `:10027` audited) |
| `src/Table.ts` | `resolveKeyAttributeTypes`, EDD-9091, `B` definitions, JSDoc |
| `src/internal/TransactableOps.ts` | widened key types only |
| `src/internal/WriteDiagnosis.ts` | hex rendering of `B` key text (`:128`); `EmptyKeyBound` wording for binary operands (`:1307`) |
| `src/Collection.ts` | `explain` / `onRequest` / `pageSize("natural")` on standalone collection queries |

### Other packages and docs

| File | Change |
|---|---|
| `packages/language-service/src/core/EntityResolver.ts` | `resolveKeyPart` (`:515-535`) parses `zorder` (dimension calls → field names) and `prefix`; today it drops any half without a `composite` array, so a Z-order index would vanish from hovers. Dimensions, lists and prefix parts held in variables are followed (same file, then through the checker), and a dimension built by a helper is read from its type (`Dimension<"price">`); a half it still can't read whole is kept, marked `unresolved`, never dropped |
| `packages/language-service/src/core/ParamsBuilder.ts`, `src/features/diagnostics.ts` | Z-order-aware hover and composite listing |
| `packages/docs/src/content/docs/guides/zorder.mdx` (new) + `astro.config.mjs` sidebar (after "Indexes & Collections") | Z-order guide |
| `guides/queries.mdx`, `guides/indexes.mdx`, `guides/index-policy.mdx`, `reference/api-reference.mdx` | adaptive sizing, `.pageSize("natural")`, `.within()` and skip-scan, `explain` / `onRequest`, Z-order half under `indexPolicy`, API entries |
| `packages/effect-dynamodb/examples/guide-zorder.ts` (new), `examples/guide-queries.ts` (new regions) | backing examples |
| `CLAUDE.md` | example ↔ MDX row; canonical shapes 7 and 8; status counts |
| `DESIGN.md` | registry rows (commits 2–4, §13); §7 shapes and Z-order key format; §10 queries (sizing, `within`, cursor v2) |

---

## 17. Docs, example and changeset

**Guide `guides/zorder.mdx`** (regions from `examples/guide-zorder.ts`): what a Z-address is
(the 3-bit worked example); declaring `sk.zorder` and `sk.prefix`; `.within()` and result order;
strategies and `explain` / `onRequest` for comparing them; cursors; updates move entries, choose
step sizes so values change rarely (no minute-resolution "last seen" timestamps); when Z-order
doesn't pay: unbounded important dimensions (the AWS article's third query), high-cardinality
exact-match IDs (partition key or prefix, not the interleave), dimension order (most selective and
most often bounded first); changing a declaration needs a new index, and the migration path for
adding one to an existing table (§14); the shared-partition throughput note with the RCU
arithmetic of §9.3 (`concurrency` trades latency for throttling risk; 4 slots of natural pages ask
for about 25,600 RCU/s of a 3,000 RCU/s partition); write cost: each level change is 2 GSI WCU on
the shared GSI partition key, and GSI write throttling throttles base-table writes (§6.3); probe
cost is item size, not a constant (§7.2); results under concurrent writes can repeat or omit an
item that moves, and GSI reads lag writes (§9.6); `sk.prefix` tuples come back in encoded
(length, bytes) order (§3.3); a hierarchical prefix is a query feature, not a truncating write
(§6.3).

**Example `guide-zorder.ts`:** a listings entity (`region` PK, `agencyId` prefix, `price` /
`bedrooms` / `listedAt` dimensions), table create, ~300 seeded items, a `within` collect, a
three-page `fetch` chain, an `explain`, an `update` that moves the entry, and a skip-scan on a
second entity's `byStatus` composite index (`status` literals, then `price`). `guide-queries.ts`
gains regions for adaptive sizing and `.pageSize("natural")`.

**Upgrade docs** (F3, F4): the Indexes guide's "Migrating rows written by 1.36" (what the 1.36
key fallback keeps working, what it doesn't, what moving costs), and a new guide, "Upgrading from
1.36" (`guides/upgrading.mdx`, regions from `examples/guide-upgrade.ts`): deploy with the fallback
on, drain projection outboxes, dry run `rekey`, run it (segments, bounded runs, resume), rerun,
turn the fallback off; what moves and how, event streams, conflicts, cost.

**Changeset** `.changeset/zorder-indexes.md`, `minor` for all four packages of the fixed group
(`effect-dynamodb`, `@effect-dynamodb/schema`, `@effect-dynamodb/geo`,
`@effect-dynamodb/language-service`). Commit 5 holds the whole text, 5a–5e's entries included.
Its sections: the feature summary; behaviour changes — adaptive request sizing; sort key text
(numbers in every key, escaped sort key strings, numeric-string event keys, and `EDD-9096`);
`append` on a numeric-string `orderBy` (E9); exact sort key matches; "Upgrading from 1.36" (what
the fallback keeps working and what it doesn't, its costs, strings holding `%` and two hex
digits, `rekey`, rolling deploys, `legacyKeys: false`, `EDD-9097` / `EDD-9098`); the retired
`EDD-9046`; malformed cursors (`EDD-9094`); key and vector attribute types (`EDD-9091`); and the
type changes ("Semver impact" items 2–5, 12, 13). The text itself is in the changeset, not
repeated here.

Then `pnpm changeset version` → **1.37.0** in the same PR (push the changeset commit first; add
the `release-order-override` label at PR creation if other release work is open).

---

## 18. Commit plan

From the issue's Scope; single-line messages, no trailers (CLAUDE.md).

| # | Commit | Content | Gates |
|---|---|---|---|
| 1 | `Add design for Z-order indexes and filtered-query pagination` | this doc only (the EDD band is reserved here; registry rows land with the code, §13) | lint |
| 2 | `Size filtered query requests from the observed pass rate` | §8.1–§8.4; `pageSize("natural")`; `accepted` / `ScannedCount` plumbing; `onRequest`; `examinePage` guard; updated pins (§15.2); EDD-9095 registry row | all, connected |
| 3 | `Add the range-jump loop, cursor v2 and skip-scan for composite indexes` | §7.1–§7.4, §9, §10, §11 (row check); `.within()` on composite indexes; `explain`; `maxSkips`; deferred cursor decoding; EDD-9093–9094 rows | all, connected |
| 4 | `Add Z-order indexes with binary sort keys, sk.prefix and sk.zorder` | §3–§6, §7.5, §8.5, §13 (9086–9092 rows), §14; Z-order planners; shapes 7/7a/7a′/7b/8/8a/8b/8c in all three suites; language-service `EntityResolver` | all, connected |
| 5 | `Document Z-order indexes and adaptive request sizing` | guide, examples, queries / indexes / index-policy / API pages, CLAUDE.md (and its status counts for the whole branch), DESIGN.md §7 / §10, the whole changeset (5a–5e's entries included) | doctest, examples |
| 5a | `Encode numeric key values in numeric sort order` | §19 E8 and E7: numeric key text, the `EDD-9096` refusal, exact matches for complete keys (accessors, `Aggregate.list`), history `.where()` clamped to the item's events, numeric `beginsWith` as `eq`. Its DESIGN.md, guide and API-reference edits stay in this commit, not commit 5: they describe a stored-key change that must not be documented without the code that makes it; the changeset entry is in commit 5 | all, connected, doctest |
| 5b | `Escape sort key characters below the delimiter and match fully pinned keys exactly` | §19 F1 (fixing E6; G1, G2): sort key text escaped (`KeyComposer.sortKeyText`) on every sort key path, aggregates and Z-order prefixes included, one exact key condition per bound, the language service's params; and the E7 audit: history rows, collection-member indexes, the empty-composite half, the language service's accessor params (its collection-member path included). As with 5a, its changeset entry is in commit 5 | all, connected, doctest |
| 5c | `Compose time-series event keys from numeric orderBy values` | §19 F2 and E9 (G3–G6): event sort keys from the `orderBy`'s key form; `append`'s staleness check for a string-encoded numeric `orderBy`. Its changeset entry is in commit 5 | all, connected, doctest |
| 5d | `Read and move rows still under their 1.36 keys` | §19 F3 (G7–G26): `KeyText136` (schema, internal) and its golden vectors from the published 1.36.0; `DynamoSchema.make({ legacyKeys })`; the fallback reads and moves of every single-item operation, `Batch` and `Transaction` (`ItemNotMoved`, `EDD-9097`); the 1.36 key pass of queries that pin a prefix (`keyPassesPlanner`); aggregates; `EventStore` stream location; projection read models (rows, tombstones and outbox items under 1.36 keys, the `__edd_kt__` mark, `KeyText136.readIndexKeys`); aliasing; the `liveRows` bigint debt; DESIGN.md "Rows written by 1.36", the indexes guide, the API reference. Its changeset entry is in commit 5 | all, connected, doctest |
| 5e | `Add rekey to move rows to their 1.37 keys` | §19 F4 (G27–G32): `db.tables.<Table>.rekey`, `internal/Rekey.ts` and the `RekeyHandler` each member's `make` attaches, the `Table.Rekey*` types, `EDD-9098`; projection row tombstones and outbox items (an outbox on its own table registered by its projection), table definitions composed on `create`; the `EventStore` append's location check; DESIGN.md "`rekey`", the "Upgrading from 1.36" guide and `examples/guide-upgrade.ts`. Its changeset entry is in commit 5 | all, connected, doctest, examples |
| 5f | `Match docs e2e locators to the duplicate sidebar label and labelled key segments` | the docs e2e suite (`navigation.test.ts`, `playground.test.ts`), its locators matched to the site as it renders: the sidebar's two "Getting Started" labels (the page and the first tutorial), the "Core Concepts" heading, and the playground's key segments, which carry their attribute's label (`taskid_task-001`) | docs e2e |
| 6 | `Version Packages 1.37.0` | `pnpm changeset version` | CI |

Commits 5a and 5b were added after review, for the pre-existing key bugs the owner chose to fix
in this PR on 2026-10-28 (§19 E6–E8); 5b was reworked, and 5c–5e added, for the owner's decisions
of the same day (§19 F1–F4, E9); 5f repairs the docs e2e suite. The branch's order is 1, 2, 3, 4,
5, 5a, 5b, 5c, 5d, 5e, 5f (on the branch, commits 6–11), then 6 once the changeset is pushed.

---

## 19. Scoping decisions

Every item in the issue, plus the boundaries this design introduces. *(owner)* = decided in the
issue's Scope section; *(confirmed 2026-10-27)* = proposed here and confirmed by the owner on
2026-10-27, exactly as written; *(confirmed 2026-10-28)* = found while reviewing the
implementation, implemented as written here and confirmed by the owner on 2026-10-28 (C9, C10,
C11); *(owner 2026-10-28)* = a pre-existing bug the owner chose on 2026-10-28 to fix in this PR
(E6–E8), or a decision the owner made that day on how (F1–F4). E9 was found while doing F2,
whose tests need it fixed; how it is fixed is G3–G5. The choices the implementation made inside
F1–F4 that no owner decision covered are listed one per row in §19.1 (G1–G32): the owner
confirmed them on 2026-10-28 as recommended, except G5 and G31, which the owner changed (G31's
change brought the projection fix, F3). G33–G37 are choices made doing those changes,
confirmed by the owner on 2026-11-01 as proposed. *(owner 2026-11-01)* = decided by the owner on
2026-11-01, while reviewing the declaration API (A13, A14).

| # | Item | Decision | Reason |
|---|---|---|---|
| A1 | `ZOrder` module, `sk.zorder` on GSIs, `.within()` with three strategies, cursor integration *(owner)* | **in** | The feature. |
| A2 | `update` / `indexPolicy` for Z-order halves, shapes with and without `sk.prefix` *(owner)* | **in** | §6.3, §6.4; plus degenerate shapes 7a / 7a′ / 7b / 8a / 8b / 8c. |
| A3 | Binary sort keys, only through Z-order halves *(owner)* | **in** | §4. |
| A4 | `sk.prefix` *(owner)* | **in** | §4.3, §7.5. Prefix values are given through `.within()` only, not as accessor composites *(confirmed 2026-10-27)*. |
| A5 | Several entities on one Z-order GSI *(owner)* | **in** | §14. |
| A6 | Adaptive sizing as the default *(owner)* | **in** | §8. |
| A7 | Skip-scan sharing the range-jump loop *(owner)* | **in** | §7, §9. |
| A8 | `.within()` on every index kind; explain hook; `maxSkips` *(owner)* | **in** | §3.3, §3.6, §7.4. |
| A9 | One release, five commits *(owner)* | **in** | §18, plus the commits for the pre-existing key bugs and the owner's key-text decisions of 2026-10-28 (5a–5e; E6–E9, F1–F4) and the version commit. |
| A10 | `.onRequest()` as a second public hook beside `.explain()` *(confirmed 2026-10-27)* | **in** | The issue's Scope names "a plan/explain debug hook"; open question 3 asks for "addresses visited vs items returned", which a no-I/O `explain()` can't report. Alternative: drop `onRequest` and let tests read `ScannedCount` through a wrapped `DynamoClient` layer; users then have no per-request view. |
| A11 | `auto` strategy = `precise` when the exact plan fits `maxRanges`, else `jump` *(confirmed 2026-10-27)* | **in** | The issue's proposed default (§5.6). An earlier draft added `naive` when address fill ≥ 0.5 (`NAIVE_FILL`); dropped because address fill isn't data density. |
| A12 | ~~Public `ZOrder` surface = dimension constructors and types only~~ *(confirmed 2026-10-27; superseded by A13)* | **replaced** | The curve algebra (`interleave`, `bigmin`, `plan`, …) stays internal (`internal/ZOrderCurve.ts`) so its signatures and the stored layout aren't semver-bound before the geo follow-up needs them (§3.1). That part stands; the constructors are gone (A13). |
| A13 | Dimensions declared as plain entries in `sk.zorder`, typed from the model; public `ZOrder` = types only *(owner 2026-11-01)* | **in** | A constructor (`ZOrder.int("price", …)`) restated a type the model already declares, and a free function can't complete or check its field name against the model. An entry is a bare field name or `{ field, ...options }`; its options follow the field's model type (`DimensionFor`, §3.1): a range for `number` / `bigint` (int or float by whether the options are integers), a time window for a date, the bare name or `{ values?, bits? }` for a literal union or `boolean`, `{ bytes }` or `{ values, bits? }` for a plain `string` (a plain `number` takes a range only; `values` on it is `[EDD-9088]`, *owner 2026-11-01*). `[EDD-9087]` moves from the constructors to `Entity.make` (`normalizeGsiConfig`), and also refuses an unknown option (as a type error too, through a guard on each entry, `ZOrderEntriesGuard`, which leaves the editor's completions intact). `.within()` bounds are typed from the entry and the field as before. Type change: an entry or key config declared outside `Entity.make` needs `as const`. |
| A14 | Every definition position that names a model attribute is typed from the model *(owner 2026-11-01)* | **in** | The owner's rule: "The field declarations for all fields MUST validate attribute names." The editor completes the names; a misspelled one is a compile error on that entry; the runtime checks stay for untyped callers. Covered: `Entity.make` key and index composites, `sk.prefix` / `sk.zorder`, `refs` keys, `unique`, `timeSeries.orderBy` / `appendInput`, `generatedId.field`, vector index fields; `DynamoModel.configure` keys; `Aggregate.make` `pk` / `collection` / `list` composites, `context`, `edges` keys, `many` edges' `sk.composite`; `Collections.member` / `Collections.make`; `GeoIndex.make` `index` / `fields`. Physical names stay strings (key `field`s, `configure` renames, timestamp / version / TTL names), as do labels that name no attribute (discriminator keys). `one` / `many`'s first argument and `many`'s `edgeAttributes`, never read, are deprecated in favour of `one(config)` / `many(config)` *(owner 2026-11-01)*, removed in the next major. Pre-existing gaps closed with it: a `unique` field or an `appendInput` field the model lacks was accepted at runtime and is now refused (`[EDD-9002]`, `[EDD-9013]`). DESIGN.md §5 lists the positions. |
| A15 | Resume cursors handed to callers are `Option<string>`: `Query.Page.cursor`, a collection page's `cursor`, `Aggregate.ListResult.cursor`, `RekeyReport.resume` *(owner 2026-11-01)* | **in** | Repo convention: Option over nullable in services; the caller's HTTP handler is the boundary, not the library (`Option.getOrNull(page.cursor)` or a `Schema.OptionFromNullOr` field there). The inputs stay strings — `startFrom(cursor: string)`, `list({ cursor?: string })`, `rekey({ resume?: string })` — since an `Option` input would make `None` mean "restart", conflating the first page with no more pages. Out: the aggregate `update` context's `cursor` (an optic), internal cursor state and the wire formats. |
| B1 | General binary keys for composite halves *(owner)* | **out** | Per the issue. |
| B2 | Z-order on the table primary key *(owner)* | **out** | Per the issue; EDD-9086. Follow-up candidate: append-only event items. |
| B3 | Z-order as a collection member *(owner)* | **out** | EDD-9090. |
| B4 | Geo H3 as a dimension *(owner)* | **out** | Follow-up issue. |
| B5 | Hilbert curve *(owner)* | **out** | `Layout` hides the curve. |
| C1 | `count()` with `.limit()` adapts (paths 1–3) *(confirmed 2026-10-27)* | **changed** | The issue says `count` is unchanged because it reads everything; with a limit it doesn't, and paths 1 and 2 share the machinery (§8.3, §20). |
| C2 | `maxPages` counts probes *(confirmed 2026-10-27)* | **in** | It caps requests; probes are requests. |
| C3 | Probes and jumps never fabricate an `ExclusiveStartKey` | **in** | Per the issue. |
| C4 | `Aggregate.list`'s own loop and cursor *(confirmed 2026-10-27)* | **out** | Separate loop and cursor (`Aggregate.ts:3822-3831`, `:1886`); no Z-order indexes there. Follow-up if wanted. |
| C5 | `fetch` windows that start at 1 and grow after single-page ranges; `paginate` / `collect` buffer instead of discarding *(confirmed 2026-10-27)* | **in** | "A few at a time" with a single-position cursor (§9.2) without systematic read amplification on dense ranges; streams have no cursor to honour, so they keep finished later ranges (§9.3). |
| C6 | `maxPages` without a planner keeps 1.36 sizing *(confirmed 2026-10-27)* | **in** | Keeps the Scope's "results and cursors are unchanged" true for `limit` + filter + `maxPages` (§8.1). Alternative: adapt anyway and record the per-call result change in the changeset. |
| C7 | `concurrency` default: 4 with a `limit`, 1 for no-limit drains *(confirmed 2026-10-27)* | **in** | Concurrency is a latency / throttling trade-off on one partition key; 4 parallel natural 1 MB drains ask for about 8× a partition's 3,000 RCU/s (§9.3). |
| C8 | Throttling: no library retry; `fetch` returns a usable prefix when a later window member is throttled; `collect` / `count` / `paginate` fail *(confirmed 2026-10-27)* | **in** | §9.5. The SDK's retry strategy already backs off per request; a library-level back-off or drop-to-sequential is not added. |
| C9 | Under adaptive sizing, a `fetch` whose limit fills on a sized request's last returned row returns DynamoDB's `LastEvaluatedKey`: a different cursor value, and `Some` where 1.36's was null, so the chain ends with one empty page *(proposed in review of commit 2; confirmed 2026-10-28)* | **changed (recorded)** | §8.4. The Scope's "cursors are unchanged" holds for where a cursor resumes, not for its value or null-ness. Alternative: after such a fill, read on (up to a natural page) to find whether another match exists and return null when none does; that costs up to 1 MB on every such `fetch`, the read adaptive sizing exists to avoid, and still returns non-null when the tail passes 1 MB, as 1.36 did. Or `.pageSize("natural")` per query. |
| C10 | `Query.paginate` emits one array per request, so under adaptive sizing its page boundaries follow the sized requests; only the flattened stream is unchanged (a bound query's `.paginate()` streams items, so it is unaffected) *(proposed in review of commit 2; confirmed 2026-10-28)* | **changed (recorded)** | §8.4. Alternative: keep natural sizing for `Query.paginate`; a stream has no cursor to honour, but then a selective filter with a `limit` reads a 1 MB page per pull, which is what adaptive sizing replaces. |
| C11 | DynamoDB calls an `.onRequest()` observer makes run under `Capacity.detached`, so they are not charged to the query's consumed-capacity report *(confirmed 2026-10-28)* | **in** | §3.6. The observer is the caller's code, not the query's reads; charging its calls would make the report depend on what an observer does. Alternative: charge them to the query. |
| C12 | E6's request cost: on a sort key composite that is not the last and is a free-form string, `lte`, `gt` and `between` sent two exact key ranges, one request after the other, where 1.36 sent one condition *(proposed in review of commit 5b, 2026-10-28)* | **rejected; superseded by F1 (owner 2026-10-28)** | A stored value sorted apart as well as a bound (`gt: "new"` must return `new york`, whose unescaped key `new york#…` sat between `new`'s key and `new#…`), so no single range over unescaped text was exact for these operators, and every such query paid a second request and was a planned read. Escaping the key text (F1) makes key order value order, so each bound is one exact range again and the split machinery (`compositeSpans`, the multi-range `key` plan, `keyTextAvoids`) is gone. |
| D1 | `.within()` on collections and `scan` | **out** | Collections have no SK composites to bound; Z-order can't be a member. |
| D2 | `in` / `beginsWith` bounds on composite indexes, `in` on prefix composites | **out** | `in` only on `literals` dimensions; `.where()` keeps `beginsWith`. Follow-up. |
| D3 | Skip-scan only over delimiter-free tuple composites *(confirmed 2026-10-27)* | **superseded by F1 (owner 2026-10-28)** | The key format didn't escape `#`, so a free-form string could hide rows from a skip. Sort key text is escaped now (F1): every tuple composite's text is free of `#` and `$`, and a free-form string tuple skip-scans (§7.3). |
| D4 | Skip-scan on a primary accessor with history rows | **out (filter plan)** | Snapshot, tombstone and event keys don't parse (§7.3). |
| D5 | Literal ranges by declaration order | **in** | Matches the quantization; compiled to `IN` (≤ 100 members), `NOT IN` of the complement (≤ 100), else a row check (§11). |
| D6 | Legacy unbound `Entity.query.<index>` gets `.within()` | **out** | Bound accessors are the canonical API. |
| D7 | Exact check always added for bounded dimensions | **in** | Simpler; costs no read capacity. A FilterExpression where the stored type sorts like the quantized value, a row check otherwise (`NumberFromString`, `DateTimeZoned`, §4.1, §11). |
| D10 | Numeric-string and zoned-date dimensions supported via the row check, not rejected *(confirmed 2026-10-27)* | **in** | Alternative: reject them with EDD-9088. The row check keeps them correct at the cost of reading the attribute. |
| D8 | No layout/version byte in the address *(confirmed 2026-10-27)* | **in** | A declaration change needs a new index anyway; the fingerprint rejects stale cursors (§4.4). |
| D9 | `KeyComposer` return types widen | **in (recorded)** | Changeset type note. `composeSk` stays `string`. |
| E1 | Key-attribute vs vector-filter type conflict raised as EDD-9091 *(confirmed 2026-10-27)* | **in (adjacent debt)** | Today the vector merge silently keeps the first type (`Table.ts:702-706`). Recorded in the changeset. |
| E2 | Cursor `btoa` throwing on non-Latin-1 key text | **fixed** | v2 is emitted instead (§10.2). |
| E3 | `WriteDiagnosis` `B` key text | **fixed** | Hex rendering; `EmptyKeyBound` wording covers binary. |
| E4 | Malformed cursor fails the terminal (`EDD-9094`) instead of throwing from `startFrom` *(confirmed 2026-10-27)* | **changed** | Decoding moves to `prepared()` so the planner can validate the cursor and `startFrom` / `.within()` order doesn't matter (§10.2). Recorded in the changeset. |
| E5 | `examinePage` loops forever on `budget = 0` | **fixed (guard)** | Unreachable today; the multi-range loop never calls it with nothing remaining, and a guard returns immediately (§2, §9.2). |
| E6 | A `.where()` / `.within()` bound on a non-last sort key composite whose value holds a character below `#` (space, `!`, `"`, control characters): key order is not value order there, so `lte: "new york"` excluded `new` *(owner 2026-10-28)* | **fixed in this PR, by F1** | Pre-existing (1.36). The value that sorts apart can be the stored one as well as the bound: `gt: "new"` excluded `new york`, and `lte: "new"` returned it; a value holding `#` split into two segments. Fixed by escaping sort key text (F1), which makes key order value order: each bound composes 1.36's one condition over the escaped operand text, exact, and requests stay byte-identical to 1.36's for values without a character U+0000–U+0025. The first fix (several exact ranges per bound, C12) was rejected. Kept from it: on the last composite clamped under pinned ones, a strict `lt` ends at `keyJustBelow` of the bound — refused up to 1.36 (`EDD-9046`, retired); a well-formed `.within()` interval no value satisfies (`{ gt: 3, lte: 3 }`, judged on the operands' key text) plans `empty` and sends nothing; history `.where()`'s open end is the prefix + U+10FFFF, above an emoji-leading stamp. `gt` is back to `K(v)#U+FFFF` on the last composite and on a history `orderBy` (the U+0000 start the split needed is gone). A brute-force property test over every shape, three casings, low-character and `#` / `%` values, a free-form skip tuple and a time-series primary key `[zone, device]` (`SortKeyBounds.test.ts`) and DynamoDB Local (`connected.sort-key-escaping.test.ts`, lowercase and uppercase) pin it. |
| E7 | An accessor given every sort key composite sent `begins_with(<key>)`, so `name: "a"` returned `ab` and, under E8's variable-width text, `seq: 3` returned `3.14` *(owner 2026-10-28)* | **fixed in this PR** | Pre-existing (1.36). `sk = <key>` for a complete key (`KeyComposer.composeSortKeyCondition`), a delimiter-terminated `begins_with` for a partial one; `Aggregate.list` the same. A collection query pins no sort key composites and keeps its `begins_with` on the collection prefix. History rows: a version snapshot (`#v#[item#]…`) or tombstone (`#deleted#[item#]…`) key never extends a composite-bearing live key, and a time-series event key (`<currentSk>#e#…`) does, so `=` is what leaves events out of a full pin. An empty-composite half (canonical shape 6) pins nothing and keeps sending the partition key alone, as in 1.36: `=` on its constant key would leave out nothing a live row can't (history rows are dropped as rows on the primary key, `liveRows`; an index holds none), so the request is left unchanged. The language service's accessor params match: its collection-member path, which sent the partition key alone whatever was pinned, now takes the entity's own index (sub-collection path and index casing included). Unit, KeyParity and connected tests (`PinnedSortKey.test.ts`, `connected.sort-key-escaping.test.ts`). The core of this fix ships in commit 5a (E8's numeric encoding), not with E6: E8's variable-width numeric text makes `seq: 3` a prefix of `3.14`'s key, so E8 needs it. EventStore audited: it composes its own stream and event keys (fixed-width version padding) and never calls an entity accessor, so neither E6 nor E7 reaches it. |
| E8 | Numeric key text sorted as text: `-3` above `-5`, `10.5` below `3.14`, `1e21` below `1e16` *(owner 2026-10-28)* | **fixed in this PR; the default in 1.37.0** | Pre-existing. Order-preserving key text for numbers and bigints (DESIGN.md "Numeric key text"); non-negative integers below 1e16 (1e38) keep their bytes, other values' stored keys change. The owner chose the default over an opt-in or a major bump; rows 1.36 wrote keep working and move (F3, F4). `NaN` and bigints over 1,000 digits are refused (`EDD-9096`). |
| F1 | Escape sort key text *(owner 2026-10-28, replacing C12)* | **in; the default in 1.37.0** | A composite value's text in a sort key escapes every code point U+0000–U+0025 (control characters, space, `!`, `"`, `#`, `$`, `%`) as `%` and two hex digits, after casing, the digits following the casing (`KeyComposer.sortKeyText`; DESIGN.md "Sort key text"). Every other character sorts above `%`, escapes start with `%` and keep their code points' order, and the map is per character, so a value's key sorts before every greater value's and a value is a prefix of another exactly when its key text is; property tests (`SortKeyText.test.ts`) pin both for every casing. Scope: table and index sort keys (clustered collection members included), every condition and prefix composed from them, the time-series event `orderBy` segment, snapshot and tombstone item segments (taken from the live key), aggregate collection / list / many-edge sort key composites and discriminator values (discriminator names are field names, left as they are), Z-order `sk.prefix` segments (before the length prefix or hash; new in 1.37, so no stored keys change), and the language service's params (`KeyParity.test.ts`). Not escaped: partition keys (table, index, aggregate, EventStore stream), unique-constraint sentinels (the value is in the sentinel's pk; write and lookup share the composer), EventStore event and command sort keys (version digits; a command id is the caller's and kept verbatim). Numbers, bigints, dates and booleans hold no escaped character, so one code path covers them, and a string without one keeps its 1.36 bytes. Consequences: one exact key condition per bound (E6, C12), values holding `#` supported, skip-scan over any tuple composite (D3), row checks compare escaped text. Stored sort keys of rows with a string holding such a character change (F3, F4). Rejected: a new lowest delimiter (U+0000 / U+0001) — rewrites every key, is unreadable, and `#` is woven through every key kind; two exact ranges per bound (C12); one wide range with a row check per row — reads a bound's whole subtree, and `count()` loses `Select: COUNT`; splitting only bounds whose own value holds such a character — stored values still sort apart. |
| F2 | Compose time-series event keys from the `orderBy`'s key form *(owner 2026-10-28)* | **fixed in this PR; the default in 1.37.0** | Pre-existing (1.36). `append` composed the event key's `orderBy` segment from the encoded value, while `.history().where()`, row checks and `liveRows` composed the key form: for a string-encoded numeric `orderBy` (`NumberFromString`, `BigIntFromString`, any `type-numeric` composite) events sorted as text (`"10"` before `"9"`) and bounds missed them. Now the key form everywhere, so such event rows' keys change (F3, F4); for every other `orderBy` the key form is the encoded value and nothing changes. Unit (`TimeSeriesNumericOrderBy.test.ts`, an in-memory table that evaluates conditions as DynamoDB does) and DynamoDB Local (`connected.event-keys.test.ts`) tests append in increasing order (`-1, 2.5, 9, 10, 100`; bigints `-100 … 100`) and pin history order and every `.where()` operator forward and reverse. The spec's sequence `9, 10, 100, -1, 2.5` can't all apply — `-1` and `2.5` after `100` are stale by design — so the older-after-newer case is its own test (`StaleAppend`, no event written). |
| E9 | `append` on a string-encoded numeric `orderBy` compared the stored `S` value as text: the CAS `attribute_not_exists(pk) OR #ob < :new` refused `10` after `9` and took `9` after `10` *(found while doing F2)* | **fixed in this PR; how: G3–G5, confirmed 2026-10-28 (G5 as the owner changed it)** | Pre-existing (1.36). DynamoDB can't cast `S` to a number in a condition, so for such an `orderBy` `append` reads the current item (strongly consistent), decides the CAS on the numbers (not below → `StaleAppend`, nothing written), and sends the transaction guarded on the value it read (`#ob = :observed`; `attribute_not_exists(pk)` for a new item). A cancellation is read again: a moved `orderBy` retries from the decision, at most 8 times (`APPEND_GUARD_ATTEMPTS`), then the transaction's error; an unmoved one is the user's condition (`ConditionalCheckFailed`) or, with none, `StaleAppend`. A cancellation for a `TransactionConflict` alone (another transaction in flight; nothing judged or written) is sent again, within the same 8 attempts, on every `append` path, numeric or not. Cost: one consistent `GetItem` per such append (and per cancellation), `.skipFollowUp()` included, whose contract (`void`; `StaleAppend` without current) is kept. The single-transaction path's follow-up read after a cancellation is strongly consistent too (it was not in 1.36): a read missing an item just created would report the user's condition rejecting its creation. Other `orderBy` types keep the single conditional transaction (`N` compares numerically, ISO-8601 text chronologically). F2's tests need the fix (`10` must apply after `9`); the design, its cost and the alternatives rejected are G3–G5. |
| F3 | Rows written by 1.36 whose key text changes in 1.37.0 (E8 numbers, partition keys included; F1 escaped sort key strings; F2 event keys) keep working through 1.37.x: single-item operations fall back to and move from the 1.36 key, queries that pin a key prefix also read the 1.36 prefix, an item moves to its current key the first time it is written; a documented off switch, on by default; the fallback is removed in the next major *(owner 2026-10-28)* | **in; commit 5d** | Rejected *(owner)*: the rekey helper alone — affected rows would be invisible or duplicated between the deploy and the end of its run. Done (DESIGN.md §7 "Rows written by 1.36"; the Indexes guide's "Migrating rows written by 1.36"): `KeyText136` composes the bytes 1.36 wrote for every key kind, pinned by golden vectors from the published 1.36.0 packages, and only a key whose text differs takes a fallback path; every other key sends the requests it always did. Reads fall back on a miss (`get`, snapshot and tombstone reads, `Batch.get`, `transactGet`). Writes move the item — one transaction: a Put at the current key with every index key recomposed under its policy, a guarded Delete of the 1.36 item, its sentinels moved, and the snapshot of the version it is at moved with it (G17) — and then run as for an item at its current key. `Batch.write` and `Transaction.transactWrite` delete or check the 1.36 key, and a transaction op that would need a move fails `ItemNotMoved` (`EDD-9097`). Queries that pin a prefix read the 1.36 key as a second pass of one plan; aggregates are read under both keys and moved by `update`; an `EventStore` stream is read and appended where it lives, never split; a value whose 1.36 text spells another value's current text (`foo%20bar` / `foo bar`) is told apart by the row's values. Off switch: `DynamoSchema.make({ legacyKeys: false })`. Range bounds and `.within()` read the current key only (as the decision allows; documented). Fallback reads and moves are charged to the operation's capacity report. Projection read models (with G31's change): `projection` and `multiProjection` read a row, or its tombstone, under the 1.36 key and move it with their next write, and `drain` / `drainPending` deliver a row's outbox effects under both keys in one order (G33, G34); an outbox write never replaces another value's pending 1.36 effect (G36), and retained history at a segment another value's 1.36 history shares stays each value's own (G37). The choices made inside this decision are G7–G26 (§19.1), confirmed 2026-10-28, and G33, G34, G36 and G37, confirmed 2026-11-01. Tests: request capture (`LegacyKeys.test.ts`, `LegacyKeyQueries.test.ts`, `LegacyKeyAliasing.test.ts`, `LegacyKeyProjections.test.ts`), the 1.36 composer (`KeyText136.test.ts`, its key read-back included), DynamoDB Local (`connected.legacy-keys.test.ts`, `connected.legacy-key-queries.test.ts`, `connected.legacy-key-projections.test.ts`, and `connected.legacy-rows-1.36.0.test.ts` over rows the published 1.36.0 wrote, `fixtures/legacy-rows-1.36.0.json`); the six canonical GSI shapes in the move path at entity level and connected. |
| F4 | A `rekey` helper that moves every remaining row to its 1.37 keys *(owner 2026-10-28)* | **in; commit 5e** | Run after the deploy (dry run first); then the fallback (F3) can be turned off. Done (DESIGN.md §7 "`rekey`"; the "Upgrading from 1.36" guide, with `examples/guide-upgrade.ts`): `db.tables.<Table>.rekey(options?)` scans the table in parallel segments and hands each row to the member that owns it. Each kind of row moves with the code its 1.37 operations use: items with their index keys and sentinels (an item already at its current key has index keys still in 1.36 text rewritten in place), version snapshots, tombstones and the sentinels they kept, time-series events, aggregates, and event streams (copied, flipped, deleted, while writers keep appending). Every write is conditioned on what the move read, so a concurrent write wins and the row is read again or reported; conflicts are reported and left; a dry run counts and writes nothing; a run can stop at `maxPages` and resume from a token; a rerun moves nothing; the report carries the capacity the run used. Projection row tombstones and outbox items move too, an outbox on a table of its own with that table's `rekey` (G31, as the owner changed it). The choices made inside this decision, and the alternatives they rejected, are G27–G32 (§19.1), confirmed 2026-10-28 (G31 changed), and G35, confirmed 2026-11-01. Tests: `Rekey.test.ts` (an in-memory table with `Scan`), `LegacyKeyProjections.test.ts` (projection rows), `connected.rekey.test.ts` (every row kind and the six canonical GSI shapes seeded under 1.36 keys, some current, some under both; a dry run, a segmented run, a no-op rerun, resume after an interruption, a writer appending during a stream move) `connected.legacy-key-projections.test.ts` (rows, tombstones and outbox items on the read model's table and an outbox table), and `LegacyEdgeRows.test.ts` with `connected.legacy-edge-rows.test.ts` (one set of scenarios on both tables: a key an index policy left, truncated 1.36 sort keys, with and without a move; G38–G40). |

### 19.1 Choices inside F1–F4 — confirmed 2026-10-28 (owner)

Choices the implementation made inside the owner's decisions F1–F4 (and E9's fix), where no
owner decision says how. Status: confirmed 2026-10-28 (owner) — every row "confirm as
recommended", except G5 and G31, which the owner changed (as each row now reads); G33–G37 were
made doing those changes and confirmed by the owner on 2026-11-01 as proposed; G38–G41 are
fixes found in review of #184, confirmed by the owner on 2026-11-05. Commit
numbers are §18's (5b–5e are the branch's commits 7–10). DESIGN.md §7 ("Sort key text", "Rows
written by 1.36", "`rekey`") describes each in full.

| # | Commit | Choice | Status | Reason and alternatives |
|---|---|---|---|---|
| G1 | 5b | Escaping runs after casing: a value is cased, then escaped, and the hex digits follow the casing (`%0A`, or `%0a` under `"lowercase"`) | **confirmed 2026-10-28 (owner)** | The spec escapes with uppercase digits and lets casing apply to the whole key afterwards. The bytes only differ under context-sensitive casing, and there escaping first breaks the order: it puts a letter before the next character, so `"\nΣ"` would lowercase to `%0aς` (final sigma) instead of the value's own `σ`. Cased first, the composer's whole-key casing pass leaves the text as it is. |
| G2 | 5b | Not escaped: unique-constraint sentinels (the value lands in the sentinel's partition key), `EventStore` event and command sort keys (a version's digits; a command id kept as the caller gave it), aggregate discriminator names (field names) | **confirmed 2026-10-28 (owner)** | The spec escapes composite values in sort keys and leaves a sentinel to whichever attribute the value lands in. A command id is matched exactly, never ranged, so escaping it buys no order and would move the idempotency sentinel of every id holding such a character: a replay of a command 1.36 recorded would go undetected. Alternative: escape command ids too. |
| G3 | 5c | E9's fix: for a string-encoded numeric `orderBy`, `append` reads the current item (strongly consistent), decides staleness on the numbers, and sends the transaction guarded on the value it read (`#ob = :observed`, or `attribute_not_exists(pk)` for a new item); a cancellation is read again, up to 8 attempts (`APPEND_GUARD_ATTEMPTS`), then the transaction's error | **confirmed 2026-10-28 (owner)** | DynamoDB can't compare an `S` value as a number. Cost: one consistent `GetItem` per such append, and per cancellation. Rejected: a hidden numeric copy of the `orderBy` on the current item (`put` / `update` / `restore` would not maintain it, and rows 1.36 wrote lack it); refusing such an `orderBy` at `Entity.make` (breaks existing entities). Other `orderBy` types keep the single conditional transaction. |
| G4 | 5c | `.skipFollowUp()` keeps its contract under G3 (`void`; `StaleAppend` without `current`), though the read happens | **confirmed 2026-10-28 (owner)** | Alternative: return what the read found, which changes the combinator's types. |
| G5 | 5c | A user condition that rejects an append creating the item fails `ConditionalCheckFailed` (no `current`), for every `orderBy` type | **changed by the owner 2026-10-28** (behaviour change): every `orderBy` type alike | 1.36 returned `ValidationError("append.followUp")` there. The numeric path reads the item first and knows; the single-transaction path's follow-up read finds no item with a user condition given. `.skipFollowUp()` still returns `StaleAppend` without current. Alternative: keep the `ValidationError`, the same for every `orderBy` type. |
| G6 | 5c | F2's tests append in increasing order (`-1, 2.5, 9, 10, 100`; bigints `-100 … 100`); older-after-newer is its own test (`StaleAppend`, no event written) | **confirmed 2026-10-28 (owner)** (differs from the spec) | The spec's sequence `9, 10, 100, -1, 2.5` can't all apply: `-1` and `2.5` after `100` are stale by design. |
| G7 | 5d | The off switch is on the schema: `DynamoSchema.make({ legacyKeys: false })`, stored only when `false`, so the default schema object is unchanged. `rekey` moves rows whatever it says | **confirmed 2026-10-28 (owner)** | The spec leaves the shape open. On the schema it reaches bound and unbound operations, `Batch`, `Transaction`, aggregates and `EventStore` alike, and a sweep after it is turned off still works. Alternative: a `DynamoClient.make` option, which unbound operations, `Batch` and `Transaction` don't see. |
| G8 | 5d | `KeyText136` is internal to the schema package, pinned by golden vectors generated once from the published 1.36.0 packages outside the repo. "Zero overhead" is asserted as the same requests with the fallback on and off, for keys whose text did not change | **confirmed 2026-10-28 (owner)** (differs from the spec) | The spec compares with "the build without this feature", which the test suite can't run beside itself; the off switch stands in for it, and with it off no request names a 1.36 key. |
| G9 | 5d | A move's Delete of the 1.36 item is guarded by `deleteGuard`: its version and incarnation token when versioned, else every stored attribute | **confirmed 2026-10-28 (owner)** (differs from the spec) | The spec asks for the version, else `updatedAt`, else a move token set first. `deleteGuard` is at least as strict and needs no extra write; a move token costs one more write per move. |
| G10 | 5d | Index keys during a move go through `composeGsiKeysForUpdatePolicyAware` with the stored item as both payload and key record: a half that composes is recomposed, a half whose composites are all absent keeps its stored attribute, a hole is kept under `'preserve'` and removed under `'sparse'` | **confirmed 2026-10-28 (owner)** (differs from the spec) | The spec keeps the stored attribute whenever a half can't compose; under `'sparse'` that would keep an item in an index its policy drops it from. The six canonical shapes are covered at entity level (`LegacyKeys.test.ts`) and connected; the composer itself is unchanged, so `KeyComposer.test.ts` gains no case. |
| G11 | 5d | When a write moves: a conditioned `put`, `upsert`, `update`, `patch` and `append` are sent first with `attribute_exists(pk)` added and `ReturnValuesOnConditionCheckFailure: ALL_OLD`; a failure that returns no item means the item is not at its current key, so it is moved (or found absent) and the write sent again with its own condition. Operations that read first (a guarded put, soft delete, `restore`, G3's `append`) move on a read that misses | **confirmed 2026-10-28 (owner)** | No extra request for an item already at its current key; a new item costs one failed conditional write more. Alternative: a consistent read of the 1.36 key before every such write, moved or not. |
| G12 | 5d | An unconditioned `put` of an item whose key text changed is one `TransactWriteItems` (Put current, Delete 1.36) on every such put while the fallback is on, and a `TransactionConflict` cancellation is sent again, up to 3 attempts in all (`GUARDED_PUT_ATTEMPTS`) | **confirmed 2026-10-28 (owner)** (the retry) | The transaction is the spec's: nothing tells a put whether the 1.36 row is gone. It costs twice a plain put's write units for each item, and meets `TransactionConflict`, which a plain `PutItem` never does, hence the retry. Alternative: read the 1.36 key first and send a plain put when it is empty (a read per put, and a window for a 1.36 writer). |
| G13 | 5d | A move that finds nothing at the 1.36 key reads (or writes) the current key once more before it reports `ItemNotFound`, so concurrent first writes of an unmoved item all succeed | **confirmed 2026-10-28 (owner)** | Without it, the writer that lost the race to move the item failed `ItemNotFound` although the item existed. |
| G14 | 5d | Deletes: `delete` deletes at the current key (`ALL_OLD`), then at the 1.36 key when nothing was there; `deleteIfExists` and a conditioned delete move first, so the condition is judged on the item that exists; `purge` reads both partitions and deletes only rows whose values compose the item's keys | **confirmed 2026-10-28 (owner)** | Under a 1.36 partition `a b`'s rows are a key prefix of `a b#c`'s, so a prefix alone would purge another item's rows. |
| G15 | 5d | Unique values: a value is taken while either sentinel form holds it (reserve checks both, release frees both), and sentinels move with their item. A sentinel collision during a move fails `ConcurrentModification`, a `TransactionOverflow` during a move `ValidationError`; a time-series `append` and `restore` now declare `ConcurrentModification` | **confirmed 2026-10-28 (owner)** (error channels widen) | A collision needs another writer with the fallback off. Alternative: fold it into an error each operation already declares, leaving the error channels as they were. |
| G16 | 5d | `restore` refuses with `ItemNotDeleted` while the live item is still under its 1.36 key | **confirmed 2026-10-28 (owner)** | As for a live item at its current key. |
| G17 | 5d | History rows (version snapshots, tombstones, time-series events) stay where they are when their item moves; point reads, `restore`, `purge`, `versions()`, `deleted.list()` and `.history()` read them under the 1.36 partition too, and `rekey` moves them. The exception is the snapshot of the version the item is at, which moves with the item in the move's transaction (a consistent read of it, a Put at its current key where nothing is or over the same snapshot, a Delete of it as read); a different snapshot of that version at its current key keeps it where it is, and the item moves without it. `restore` of a tombstone under its 1.36 key moves the snapshot of the version it restores the same way, in its own transaction first. `versions()` lists a version held under both keys once, from the current key | **confirmed 2026-10-28 (owner)** (the snapshot that moves with its item: found in validation) | Moving an item's history on its first write would make that write read the history and send a transaction per 100 rows. Alternative: move the history with the item. The one snapshot that moves can't stay: 1.36 snapshotted a version when it wrote it, and the write after the move snapshots that version again under the current key (a retain write snapshots the version it replaces; `restore` the one it restores), so a put-only item ended up with its version 1 snapshot under both keys — listed twice by `versions()`, and a `bothKeys` conflict `rekey` reported on every run. It costs a move on a `retain` entity one strongly consistent read and two transaction items more. Rejected: deleting the 1.36 copy in each retain write's own transaction (every write path, and `restore`'s cancellation reasons, would change); leaving it, with only `versions()` and `rekey` tolerating the copy. `versions()` leaving out a 1.36 snapshot of a version the current key holds (a copy from a backup, or a 1.36 writer during a rolling deploy) costs a `Limit 1` keys-only read of the 1.36 prefix per call while the fallback is on, and a keys-only read of the current prefix when it finds one. |
| G18 | 5d | `Batch.write` sends a put's Delete of its 1.36 key in a later `BatchWriteItem`, once every request of the batch is written (none when another put of the batch writes that key); a versioned put, which is create-only, gets a ConditionCheck on the 1.36 key in its transaction group instead, which a chunk boundary can split from the put | **confirmed 2026-10-28 (owner)** (differs from the spec) | The spec sends the Delete beside the put. A batch is not atomic, so the Delete could land while the put stays unprocessed, and the item would be lost. |
| G19 | 5d | `ItemNotMoved` (`EDD-9097`) carries `entityType`, `key` and `operation`, names the item to write first (the op's own, or another value's whose 1.36 row holds the op's current key), and says to write it through the entity or run `rekey`; the culprit comes from the cancellation reasons; the 100-item limit is not pre-checked | **confirmed 2026-10-28 (owner)** | The spec names the error's purpose, not its fields. |
| G20 | 5d | Queries over both keys: the 1.36 key is a second pass of one plan (`keyPassesPlanner`), read first forward and last under `.reverse()` — a fixed order, not a merge — with `limit`, `maxPages`, pages and `count()` spanning both. The v2 cursor names its pass (`p`), a plain `{ k }` cursor is placed by its key, and a cursor from a pass the query no longer reads is refused (`EDD-9094`) | **confirmed 2026-10-28 (owner)** | The order is the spec's suggestion; the cursor is what it needs. Alternative: merge the passes by sort key (true order, but every page reads both keys). |
| G21 | 5d | Each pass keeps a row by its values (`KeyPass.rows`): the current pass a row stored at the key its values compose now, the 1.36 pass a row stored elsewhere whose current key the query selects, so each row is read once. An unmoved `a#b` row is not returned under pins on `a`, as it was by 1.36 | **confirmed 2026-10-28 (owner)** (behaviour change) | Otherwise a row both key conditions select is read twice, and another value's 1.36 row is returned by the wrong query (G25). |
| G22 | 5d | `.history()` of a string-encoded numeric `orderBy` under an unchanged item key reads its one prefix in two passes split by each event's `orderBy` (1.36's events first), and holds `.where()` bounds on the 1.36 pass's numbers by reading the whole prefix | **confirmed 2026-10-28 (owner)** (differs from the spec) | The spec gives range bounds no 1.36 pass, but here both forms share one prefix, so a key condition alone returns wrong events, not just missing ones. Cost: a bounded history reads all of the item's events until they move. |
| G23 | 5d | Aggregates: `update` moves every row it finds under a 1.36 key inside its own group's transaction, keeping `created`, and rewrites a root whose list or collection index key holds 1.36 text, so an `update` that changes nothing moves the aggregate; `create` checks the 1.36 root; `list` reads the 1.36 list keys as a second pass | **confirmed 2026-10-28 (owner)** | The spec's rule for aggregates; the rewrite on an update that changes nothing is the choice. Alternative: move only the groups an update writes anyway. |
| G24 | 5d | An `EventStore` stream is located by one consistent `GetItem` of its 1.36 first event, only when the stream id's text changed, and is read and appended there (events, snapshot, seal, command sentinels, contiguity check, `headProof`, stream indexes) until `rekey` moves it | **confirmed 2026-10-28 (owner)** | The spec's rule for streams; the locator is the choice. Cost: one consistent read where a stream id's text changed. |
| G25 | 5d | Aliasing: a string whose current text holds an escape has a 1.36 key equal to another value's current key (`foo%20bar`'s 1.36 key is `foo bar`'s). Single-item operations, accessors, `Entity.query.*`, `.history()`, `versions()` and `purge` judge a row by its values (`rowOwner`); writes carry `aliasGuard` (`contains` the value's first character below `%`; `=` for a `%`-only value no casing varies; else a read first) and move another value's row out of the way (`displace`, up to 4 rows, then `ConcurrentModification`); `update`, `patch` and `delete` treat such a row as no item; `Transaction.transactWrite` fails `ItemNotMoved` naming the row's item; `Batch.write` reads first and moves. At a 1.36 key another value's current key can be (a value holding `%` and no character below it, `spells136`), an unconditioned `put` is sent as a conditioned one, `create` (guarded or not) and `restore` read the key first and leave that value's row out of their check (`foreignAt136`), and a retained item created afresh continues from its own 1.36 snapshots only | **confirmed 2026-10-28 (owner)** | Not in the spec, which assumed a changed key never meets another value's key. Alternative: no fallback for such keys (their 1.36 rows stay out of sight until `rekey`). |
| G26 | 5d | Left not transparent until a row moves, and documented (DESIGN.md "Not transparent"): collection queries don't judge aliasing (`deleted.list()` lists the partition's tombstones, every item's, by contract: partition keys never alias); a time-series `append`'s event Put can overwrite another value's 1.36 event under the same key text; a 1.36 writer racing a batch's or transaction's read; a many-edge over unmoved rows assembles in key text order; `versions()` doesn't list pre-#133 unsegmented snapshots under the 1.36 partition; `measureAppend` / `measureSnapshot` measure the current key; events of a `Schema.Number` or string `orderBy` under an unchanged item key are read in text order | **confirmed 2026-10-28 (owner)** (deferral) | Each is rare and goes once `rekey` has run. Follow-ups if any should close while the fallback lives. |
| G27 | 5e | `rekey`'s shape: `db.tables.<Table>.rekey(options?)` returning `Table.RekeyReport`; options `dryRun`, `segments` (default 1), `concurrency` (default 4), `pageSize`, `maxPages`, `resume`, `streams`, `onProgress`; a resume token `rk1.` + base64url `{ t, s }` (each segment's `LastEvaluatedKey`), whose segment count wins; `EDD-9098` for a bad option or token | **confirmed 2026-10-28 (owner)** | The spec leaves the shape open; this matches the other table operations. |
| G28 | 5e | Event streams are passed in `options.streams`; the client registers none | **confirmed 2026-10-28 (owner)** | Alternative: register streams with `DynamoClient.make`, a new kind of member. |
| G29 | 5e | Each row goes by `__edd_e__` to the member owning it (a `RekeyHandler` each `make` attaches), and moves only when stored under the key 1.36 composed for its values and that key differs from its current one. Rows no member owns are `skipped` (`notLibrary`, `unregistered`, `unrecognizedKey`); a row it won't move is a conflict (`bothKeys`, `taken`, `contended`, `failed`) left as it is, and neither copy of a row under both keys is deleted — except a version snapshot whose current key holds the same snapshot (its version, incarnation and `updatedAt`): that is a copy, and the 1.36 one is deleted (in a transaction that checks the copy is still there and the same) and counted as moved | **confirmed 2026-10-28 (owner)** (the snapshot copy: found in validation) | The spec says to report conflicts and never overwrite. Rejected: deleting the 1.36 copy of a row under both keys, since which copy is right is the application's to decide. A snapshot whose two copies are the same state leaves nothing to decide: history is never overwritten (#133), and the copy is the one a write re-put under the current key. Reporting it instead left a conflict on every rerun, which only deleting a row by hand cleared. |
| G30 | 5e | A stream moves by copy, flip and delete; the flip marks event 1 `__edd_moved__` in one transaction conditioned on no event past the copied head and the seal and snapshot as copied (up to 8 attempts, `STREAM_MOVE_ATTEMPTS`). An append or snapshot write located at the 1.36 key carries a location check and fails `VersionConflict` once the stream has flipped | **confirmed 2026-10-28 (owner)** (differs from the spec) | The spec flips "the head" on an unchanged head version; a stream has no head row, and event 1 is what every locator reads (G24). Rejected: appending the events again (renumbers them and reruns projections); one transaction per stream (100-item limit, and a growing stream can't be copied in one). |
| G31 | 5e | Projection row tombstones and outbox items move to their read-model row's current key (`tombstone` / `outbox` in the report); outboxes need not be drained first. An outbox on a table of its own moves with that table's `rekey`, for a projection defined in the program that runs it | **changed by the owner 2026-10-28** (was a deferral) | The proposal left them (`unregistered`) and asked for outboxes to be drained before `rekey`; the owner chose to move them, and to have projections read and move rows under 1.36 keys (F3, G33). Each moves as a row: Put at the row's current key (an outbox item keeping its `#outbox#<revision>#<n>` suffix, its row key and sparse index sort key rewritten), Delete of the 1.36 row as read; another value's 1.36 row in the way moves first. They hold no values, so where they belong is read back from their key (G34). An outbox item a drainer holds (an unexpired claim) is left, a `contended` conflict until it is delivered, and the move's Delete requires that no claim was taken since the read. A current key held by another value's 1.36 row of any kind (the row itself, its tombstone, an outbox item) moves that row first, by its own kind. Rejected: deriving the row key from the events (`rekey` would need the projections, and a single-source tombstone keeps no stream id). |
| G32 | 5e | A run's capacity is always measured (`Capacity.measured`), whatever the `ConsumedCapacity` setting, and returned in `report.capacity` | **confirmed 2026-10-28 (owner)** | Alternative: report it only with consumed-capacity reporting on, as other operations do. |
| G33 | 5d | Projections under the fallback: `readRow` reads a row's 1.36 key on a miss, judged as the entity's reads judge it; a row or tombstone found there is folded onto and moves with the projection's next write — the entity's conditioned `put` (which moves it first), or the outbox transaction with the row's Put at the current key (`attribute_not_exists`) and a Delete of the 1.36 row as read (revision first). A write over a tombstone whose key text changed always takes the projection's own transaction (with or without effects), so the tombstone never moves as an entity row. A write expecting nothing at the current key that fails there clears another value's 1.36 row from it before the retry. `drain(key)` takes the head of both keys' items (lowest revision suffix): at a current key that reads back as another value's 1.36 key, only the items 1.37 marked; at the 1.36 key of a value that `spells136`, only the unmarked ones (a filtered read). `drainPending` groups a row's items the same way, by the mark | **confirmed 2026-11-01 (owner)** | The spec asked for the fallback and the move in the same transaction or a move first; both are used, by path. Clearing the alias only after a failed write keeps keys no alias can hold at 1.36's requests (zero overhead). The mark tells the two values' items apart under one key, so each `drain(key)` delivers its own effects, in one order. |
| G34 | 5d | 1.37 marks a projection row tombstone or outbox item it writes (`__edd_kt__: 1`) when its row's key text changed in 1.37, whether or not the fallback is on; one under a key whose text did not change is written exactly as 1.36 wrote it. An unmarked one under a changed key is 1.36's, and belongs to the values its key reads back as (`KeyText136.readIndexKeys`: the composites' text between the key's fixed parts, by kind, kept only when it composes that key, and only when exactly one reading does) | **confirmed 2026-11-01 (owner)** (new stored attribute) | They hold no values, and `foo bar`'s current key is `foo%20bar`'s 1.36 key: without the mark a tombstone at that key can't be told apart, and `rekey` would report every such row. Marking only changed keys keeps every other request byte-identical to 1.36's; marking every changed key (not only one another value's 1.36 key can be) keeps `rekey` from reading a numeric row's mark-less items back. Alternatives: store the key composites' values in them (needs each composite's stored encoding); events-based derivation (G31). |
| G35 | 5e | An outbox on another table is registered on its read model when the projection is defined (`_projectionOutbox`), and `rekey` of that table hands it the items. A `DynamoClient.make({ tables })` entry with no entities or aggregates composes its table definition only when `create` runs, so such a table's operations, `rekey` among them, exist | **confirmed 2026-11-01 (owner)** (adjacent fix) | Before, `DynamoClient.make` threw for a table of only event streams or an outbox, so neither could be rekeyed. Alternative: a `rekey` option naming outbox members. |
| G36 | 5d | An outbox item Put at a row key that reads back as another value's 1.36 key requires the key empty (`attribute_not_exists`, `ALL_OLD`); refused by that value's pending 1.36 item, it moves the item to its own current key, marked (as G31 moves it; a claimed item stays), and the write is retried (`LostRace`). Only such a key carries the condition | **confirmed 2026-11-01 (owner)** | Found in review: the unconditioned Put replaced `foo%20bar`'s pending effect when `foo bar` wrote one at the same revision. Alternative: read the key before every outbox write (a read per effect on every aliasable row). |
| G37 | 5d | Retained history at a segment another value's 1.36 history shares: `versions()` keeps only the item's own snapshots under its current segment (by their values), so another value's don't hide the item's own 1.36 ones; a snapshot Put replaces a row as "the same snapshot" only when its escaped sort key values match as well; a `put`, `update`, `delete` or `restore` refused by another value's 1.36 snapshot (`historyConflict`) moves that snapshot to its own current key (as `rekey` moves it) and runs again, up to 4 times. Inside a `Transaction.transactWrite` the refusal stands. The refusal's message now ends "The write was not made." | **confirmed 2026-11-01 (owner)** | Found in review: `foo bar`'s writes failed on `foo%20bar`'s 1.36 snapshots, and with no timestamps the snapshot guard (version, incarnation, `updatedAt`) let `foo bar` overwrite one. The old message ("Nothing was written.") was wrong once a move had run. Alternative: no fallback for history at such a segment until `rekey`. |
| G38 | 5d | With the fallback on, a query's current pass keeps a row stored at any key but the one 1.36 composed for its values (`KeyPassRows.composed136`): a sort key an index policy left behind its values, in current text, belongs where it is, as with the fallback off. The 1.36 pass leaves a row both ranges hold in one partition to the current pass, so it is read once | **confirmed 2026-11-05 (owner)** | Found in review of #184: the current pass kept only a row at the key its values compose now, and the 1.36 pass only one stored elsewhere under a key whose text changed, so such a row was in neither, and a pin whose text changed returned 0 rows where `legacyKeys: false` returned 1. Costs nothing: the check reads the attributes the pass already reads. |
| G39 | 5e | `rekey` judges a sort key missing a trailing composite by the composites before the gap, so a sort key truncated under 1.36 is rewritten to their current text; a 1.36 key kept for a value since cleared holds more than that, isn't equal, and stays | **confirmed 2026-11-05 (owner)** | Found in review of #184: the rule required every composite, so a truncated row kept its 1.36 text, and once the fallback was off a range over the escaped text missed it. A key that isn't what 1.36 composed for what the row holds is still left, with no conflict. |
| G40 | 5e | After moving an item, `rekey` rewrites in the same run a half the move left in 1.36 text (a sort key truncated before a gap a later composite fills, which `preserve` keeps), reading the item only when the predicted move (`movedRowOf`) leaves one; a dry run counts it from the prediction, and reports a move whose keys can't be composed as `failed`, as the real run does | **confirmed 2026-11-05 (owner)** | Without it G39's rewrite needed a second run, so a first run's clean report wasn't the end of the migration. A move of a row truncated where its values stop recomposes the key itself, and costs nothing more. |
| G41 | 5e | `rekey` reports an item `bothKeys` only if it is still at its 1.36 key when read again. An aggregate whose rows come back from both partitions is read again, and the attempt starts over while a row read under the 1.36 partition has gone from it; a row placed under both is checked under its 1.36 key the same way | **confirmed 2026-11-05 (owner)** | Found in review of #184, for items (about one run in eight on DynamoDB Local): a move between the two reads (another row's, in this run, or a write) looked like a copy, and a migration is told to stop on a conflict. An aggregate has the same window between its two partition reads, reported as `bothKeys` for its root, or `failed` when doubled edges couldn't be decomposed. Cost: one consistent read before reporting an item; an aggregate with rows in both partitions reads both again on each attempt. |

---

## 20. Where the code differs from the issue

1. **§9b says a non-leading bound "becomes a filter" today.** It doesn't: `.where()` on a
   non-leading composite throws EDD-9004 (`DynamoClient.ts:1441-1450`). The filter is what users
   write by hand. Skip-scan is new behaviour behind `.within()`, not a change to `.where()`.
2. **§9a says `count()` is unchanged because it already reads everything.** With `.limit()` it
   doesn't. Path 1 is `collect`, path 2 carries #133's growth (which §9a folds into the
   estimator), path 3 sends natural pages under a filter. See C1.
3. **§9a folds #133 into the estimator "unchanged in result and no worse in request count".**
   True for results and counts, but #133's growth is keyed off `limitValue`, and a test pins
   `Limit`s `[2, 4]`; the estimator sends `[2, 3]` (same request count). Pins under a filter
   (`QueryLimitPageSize.test.ts:179`, `:609-621`; `Query.test.ts:1593-1602`) also change.
4. **§5 "the cursor encodes the current subrange plus LEK".** Today's cursor is a bare
   `btoa(JSON)` map: it can't carry `B` (a `Uint8Array` serialises as `{"0":…}`), and `btoa`
   already throws on non-Latin-1 key text. A versioned envelope is required (§10).
5. **§3 declares `sk` without `composite`.** `normalizeGsiConfig` copies only `{ field, composite }`
   and throws a `TypeError` on a missing `composite` (`KeyComposer.ts:164-165`); both
   `NormalizedIndexes` copies drop extra keys at the type level.
6. **§6 "otherwise `indexPolicy` decides".** `classifyHalf` would treat a present leading subset
   as a legal truncated SET (`KeyComposer.ts:560-562`); a Z-order half needs its own
   all-or-nothing classifier (§6.3).
7. **§3 / §4 "the exact-match filter" for hashed prefixes, and §9b's filter fallback.** A
   FilterExpression can't reproduce key casing (composites are cased in keys, raw in attributes),
   so those checks are a library row check with key semantics (§11). Dimension bounds can be a
   FilterExpression only where the stored attribute's type and order match the quantized order
   (§4.1): a `NumberFromString` field keeps a number key form (`CompositeCodec.ts:96-115`) but is
   stored as `S`, and a zoned ISO string doesn't sort chronologically.
8. **§9b successor keys "across casings and delimiters in values".** The successor itself is
   sound for any value, but parsing a tuple from key text was not when a value contained `#`, as
   the key format had no escaping (D3). Sort key text is escaped now (F1), so it is.
9. **§1 `Table.ts:691`** is accurate, and the vector-attribute merge beside it silently keeps a
   conflicting type (E1).
10. **§9a "for every query".** `Aggregate.list` (own loop, `listRequestLimit`) and EventStore's
    direct `Limit` don't go through `computeRequestLimit` (C4).
11. **§9a "Results and cursors are unchanged" (and Scope).** Not with `maxPages`: one call reads
    fewer rows under smaller requests and returns fewer items. Hence C6. Without `maxPages`,
    results are unchanged and cursors resume at the same place, but a `fetch` cursor's value and
    null-ness, and `Query.paginate`'s page boundaries, follow the sized requests (C9, C10).
12. **§9a "the article's fixed 16 then becomes the starting value" for `jump`.** Pass-rate sizing
    grows `jump` pages into gaps; jump pages are sized by in-box run length instead (§8.5).
13. **§7 "Bit budget: the dimensions' total bits must fit the sort-key limit."** The prefix
    segments count too and depend on data, so the full limit is enforced by DynamoDB and
    diagnosed, not pre-checked (§4.4).
14. **§5 "Concurrency: bounded by default ... 3,000 RCU/s".** A bound on requests in flight isn't
    a bound on RCU/s; see §9.3 and C7.

---

## 21. Follow-ups

- Z-order on append-only / time-series event items (B2).
- H3 cells as a dimension and a Z-order `GeoSearch` planner (B4).
- `in` bounds on composite indexes and prefix composites (D2).
- Port the estimator to `Aggregate.list` (C4).
- A cheaper jump around address collisions once real data shows the cost (§5.5).
