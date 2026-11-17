# Design: per-value shard layouts (#287)

**Issue:** [#287](https://github.com/jmenga/effect-dynamodb/issues/287), with the review comment
posted on it, which records the owner's decisions (D1 to D14 below). Where the two disagree, the
review comment wins: it replaces the issue's function with a **table of values**, and the issue's
`DynamoClient.make({ shards })` override with a **layer**.
**Status:** Design, commit 1 of the feature branch (single-PR workflow). D1 to D14 are the owner's;
D15 onwards are scoping calls made here. Revised after the design review: findings F1 to F11 and
what was done with each are D30 to D40 (§19).
**On top of:** `main` at `9ec9bb63` (1.43.0).
**Builds on:** `gsi-write-sharding.md` (#183): the marker (§2), the shard function (§3), structural
composition (§4), the update gate (§5), reads, merge and cursors (§6), pruning (§7), adoption and
`rekey` (§9), validation (§10). This design changes none of them for an index declared as today.
**Affected packages:** `packages/schema` (`KeyComposer`, `internal/Shards`, `Entity.make`,
`internal/SharedKeyAttribute`, new `ShardLayouts`), `packages/effect-dynamodb` (`Entity`, `Query`,
`Collection`, `DynamoClient`, `Table`, `Aggregate`, `internal/TransactableOps`,
`internal/TransactWriteOps`, `internal/ProjectionEngine`, `internal/BoundQuery`, `index.ts`),
`packages/effect-dynamodb-geo` (no change: its refusal already covers every sharded index),
`packages/language-service`, `packages/docs`.
**Semver impact:** `minor`, in lockstep. Nothing an existing definition composes or sends changes: an
index without `shards`, and an index with `shards: N` or `{ count, by?, previous? }`, send the same
requests as on `9ec9bb63` (§16.1 pins it). `explain()` of a sharded index gains one optional field
(§6.4).

## 1. Summary

```ts
indexes: {
  byTenant: {
    name: "gsi1",
    pk: { field: "gsi1pk", composite: ["tenantId"] },
    sk: { field: "gsi1sk", composite: ["deviceId"] },
    shards: {
      layouts: {
        default: 1,
        values: [{ match: { tenantId: "t-big" }, layout: 20 }],
      },
    },
  },
}
```

A sharded index's layout becomes a **table**: a default layout, and a short list of values with
their own. A value is a partition key value of the index; `match` names every partition key
composite. A layout is a count, or `{ count, previous }` while a value migrates. Count `1` is the
unsharded key, byte for byte. So one hot tenant gets 20 shards and every other tenant keeps one
partition and one request per query.

Where the hot values differ per environment, the entity declares `layouts: "provided"` and the
application supplies the table through a `ShardLayouts` layer, from configuration or from an
Effect run at startup.

The design has four load-bearing parts:

1. **Lookup by key text** (§3). Each entry's match composes the value's *unsharded* partition key
   text, through the key form and the index's effective casing, once, when the table is built. A
   value is looked up by the unsharded text it composes. Every spelling of one key (`T-BIG` and
   `t-big` under `lowercase`) and every path's value form (a `put`'s encoded input, a query's
   domain pins, `rekey`'s stored row) gets one layout by construction.
2. **Count 1 is the unsharded text** (§4), on writes and on reads, never `!1.0`. A value at 1 runs a
   plain query with a legacy cursor. The marker carries the count and an unsharded key can't spell a
   marker (#183 §2.1), so layouts in one index can't collide, and the existing cursor checks refuse
   a cursor across a layout change (§6.5).
3. **The composer resolves; the call sites don't change** (§5, §6). `composePk`, the truncating
   composer and `composeReadPartitions` resolve the layout from the index definition and the
   schema they're given, as they add the marker today. A `"provided"` index's table travels on the
   schema an operation composes under (`DynamoSchema.shardTables`, internal, as `objectKeys` does),
   attached from what `ShardLayouts` supplies; composing under a schema without it throws
   `[EDD-9181]`, so a path that forgets can't fall back to a default. Index definitions never change
   identity (D36).
4. **Rules stay per index** (§7, D4). `.within()`, skip-scan, `.zorder()`, `GeoIndex`, `by`, the
   update gate and `rekey`'s rule follow the index, not the value's count. Byte-identical holds for
   key text and requests; the rule set is the sharded one for every value of an index with a table.

## 2. The declaration

### 2.1 Forms

```ts
type Layout = number | { readonly count: number; readonly previous?: number }

shards?:
  | number                                                    // as today: { default: n }
  | { count: number; by?: [...]; previous?: number }          // as today: { default: { count, previous } }
  | { by?: [...]; layouts: { default: Layout; values?: ReadonlyArray<{ match: Match; layout: Layout }> } }
  | { by?: [...]; layouts: "provided" }
```

- **A table** (`layouts: { default, values? }`): `default` is required (D17). `values` may be empty or
  absent: `{ default: 20 }` means what `shards: 20` means.
- **The static forms stay** and mean a table with only a default. `shards: 20` normalises to
  `{ layouts: { default: 20 } }`, `{ count: 20, by, previous: 1 }` to `{ by, layouts: { default:
  { count: 20, previous: 1 } } }`. They compose and send exactly what they do today.
- **`"provided"`**: the table comes from a `ShardLayouts` layer at run time (§10). No default: there is
  nothing to fall back to (D11).
- **`by`** stays beside `layouts`, one per index, as today. It never varies by value (D4).
- **`previous`** lives only inside a layout, the default's included (D7). `{ layouts, previous }` and
  `{ layouts, count }` are refused (`EDD-9099`), and are compile errors: the static member of the
  union declares `layouts?: never` and the table members `count?: never; previous?: never`, so a
  fresh literal mixing them doesn't pass the union's excess-property check (D37).

A layout is `count` in 1..256, or `{ count, previous? }` with `previous` in 1..256 and not equal to
`count`. Count `1` means unsharded (§4). `{ count: 1, previous: N }` is allowed, as the default or for
one value: it moves that value, or the whole index, back to unsharded (D3).

**Count 1 in the static forms.** `shards: 1` and `{ count: 1 }` stay refused (`EDD-9099`), as today:
they say "sharded" and mean nothing. `{ count: 1, previous: 20 }` is accepted, since it is the step
that un-shards a whole index (D3). A table may resolve every value to 1 (`layouts: { default: 1 }`):
that is the normal state of a provided table in an environment with no hot value, and of a declared
table between migrations (D18).

### 2.2 Types

`match` names exactly the index's partition key composites, typed from the model like every other
definition-time attribute name (owner rule, CLAUDE.md). The guard joins `EntityIndexesGuard`
(`packages/schema/src/Entity.ts:474`) as `ShardTableGuard<TIndexes, TFields>`:

- for each index whose `shards.layouts` has `values`, each entry's `match` is
  `{ readonly [P in PkComposites]: PkValue<P> }` where `PkComposites` is the literal tuple in that
  index's `pk.composite` and `PkValue<P>` is the type the index's accessor takes for that composite
  (`IndexPkInput`, widened through `CaseInsensitive<T>`, so `"T-BIG"` type-checks where the query
  would accept it);
- a key outside the composites is mapped to `never`, so a typo is a compile error on that entry and
  the editor completes the composites (the guard sits on the parameter, with no default, so
  completions survive, as CLAUDE.md's rule requires);
- a missing composite is a compile error on `match`;
- `layout` is `Layout`; `default` is required.

`layouts: "provided"` is a literal type, so `ShardLayouts.of` can find the provided indexes of an
entity from its type (§10.3). That needs the entity's type to keep the declaration: `Entity.make`
returns `NormalizedIndexes<TPrimaryKey, TGsiIndexes>`, and `NormalizedGsi`
(`packages/schema/src/Entity.ts:247`) keeps only `collection` and the composites, so the raw
`shards` is gone by then. `NormalizedGsi` therefore carries the declaration as a phantom, as it
carries `zorder` and `prefix`: `shards: IndexShards & { readonly declared: G["shards"] }` for an
index declaring `shards`. Both the operational `Entity` and the pure definition use
`NormalizedIndexes`, so `of()` reads the provided indexes and each one's partition key composites
from either (D30).

`ShardsConfig` (`KeyComposer.ts:158`) gains the two table forms as a union beside the existing
interface; `GsiConfig.shards` (`KeyComposer.ts:242`) takes the union.

### 2.3 Validation

A malformed table fails before anything runs (D8), at the earliest point that has what the check
needs.

| Check | Code | Where |
|---|---|---|
| A layout's `count` or `previous` out of range, or `previous` equal to `count` | `EDD-9099` | `Entity.make` (`normalizeShards`, `KeyComposer.ts:310`); for a provided table, when the layer is built |
| An unknown key in `shards`, a layout or an entry; `layouts` beside `count` or `previous`; `default` missing | `EDD-9099` | as above |
| `match` missing a composite, or naming an attribute that isn't a partition key composite of the index | `EDD-9099` | `Entity.make` (`bindShards`, `Entity.ts:814`), and the types; for a provided table, the layer build, and the types of `of()` |
| A `match` value the key form refuses (a value of the wrong type, `NaN`, an object composing `[object Object]`) | `EDD-9099`, naming the entry, with the key form's own message | as above |
| `values` on an index whose partition key half has no composites | `EDD-9099` | `Entity.make` / layer build (D19) |
| Two entries composing one key | `EDD-9099`, naming both entries and the text | `Table.make`, under that table's schema (D15); for a provided table, the layer build |
| `shards: 1`, `{ count: 1 }` | `EDD-9099` | `Entity.make`, as today |

**Why two entries are judged at `Table.make`.** Whether `"T-BIG"` and `"t-big"` are one key depends on
the effective casing, and an index without its own `casing` takes the schema's, which an entity first
meets when `Table.make` registers it. Under `preserve` they are two keys and may have two layouts;
under `lowercase` they are one, and two entries for it are refused. This is the stage `EDD-9106`
already uses for a casing left to the schema (#183 D51): `Table.make` runs at module load, before any
operation, so D8 holds. An index with its own `casing` could be judged at `Entity.make`; one stage is
kept for both, so the message and the point of failure don't depend on where casing is declared.

`EDD-9101` (nothing to spread), `EDD-9102` (`by`), `EDD-9106` (shared attributes) and `EDD-9108`
apply to an index with a table exactly as to any sharded index (D4).

### 2.4 The normalised form

`IndexShards` (`KeyComposer.ts:175`) gains the layouts, and keeps `count` and `previous`, which are
public (`KeyComposer` is exported, and the API reference documents them), as the default layout's
(D33):

```ts
interface IndexShards {
  /** The default layout's count (the only one of a static declaration); 0 on a provided index. */
  readonly count: number
  /** The default layout's previous. */
  readonly previous: number | undefined
  readonly by: ReadonlyArray<string> | undefined
  readonly source: ReadonlyArray<string> | undefined
  /** As declared, compiled: a table, or "provided". */
  readonly layouts: ShardTable | "provided"
}

interface ShardTable {
  readonly default: ShardLayout             // { count, previous: number | undefined }
  /** Each entry as declared, with its match in key form (§3.1). */
  readonly values: ReadonlyArray<{ readonly match: Record<string, unknown>; readonly keyRecord: Record<string, unknown>; readonly layout: ShardLayout }>
}
```

The text index (§3.3) is a function of a `ShardTable` and the key text settings, memoised beside the
table, not a field of it.

**Where a provided table lives (D36).** The definition held by the entity never changes, and neither
does its identity: no path composes from a view of it. The supplied tables travel on the schema an
operation composes under, as an internal `DynamoSchema.shardTables` (a map from an index's
`IndexShards` to its `ShardTable`), the way `objectKeys` already travels on a write's own schema
(`ownSchema`, `effect-dynamodb/src/Entity.ts:4699`). Every composer already takes a schema, so one
resolver, `KeyComposer.shardTableOf(schema, index)`, returns the declared table, or the provided
one from `schema.shardTables`, or throws `[EDD-9181]`. Lookups by definition identity
(`objectKeySiteName`, `Entity.ts:4660`, which names the index in `EDD-9162`, and the `ownSchemaFor`
cache keyed by `allIndexes`, `:4708`) keep working, and a schema derived by spreading (rekey's
older-format schemas, `{ ...schema, numericKeyText: true }`) keeps the tables.

Every reader of `count` / `previous` inside the library moves to the resolved layout or to the table:

| Reader | Today | With tables |
|---|---|---|
| `composedShardMarker` (`KeyComposer.ts:793`) | `shards.count` | the value's resolved layout (§4) |
| `composeReadPartitions` (`KeyComposer.ts:964`) | `shards.count`, `shards.previous` | the pinned value's resolved layout (§6.1) |
| `isCurrentShardLayout` (`KeyComposer.ts:891`) | `shards.count` | the row's resolved layout (§9.2) |
| `assertCollectionShardsAgreement` (`KeyComposer.ts:281`) | `count`/`previous` | the tables, by content (§11); same name, its members gain an optional `schema` |
| `shardForm` (`internal/SharedKeyAttribute.ts:47`) | `[count, source]` | `[canonical table, source]`; a provided half has no provable form (§12) |
| Aggregate `exactOf` (`effect-dynamodb/src/Aggregate.ts:9094`) | `shards !== undefined` | `false` when the half has composites; **`undefined` (either) on an empty half**, sharded or not (D35). A table may resolve a value to 1, whose key on an empty half is exactly the head, so "continues after `#`" would miss a writer whose text equals the aggregate's partition head |
| Language service `shardMarkerText`, `shardsInfo` (`language-service/src/core/ParamsBuilder.ts:563`, `:567`) | `count`, `previous` | the table (§13) |

## 3. Lookup by unsharded key text

### 3.1 Building the text index

For each entry, the library composes the **unsharded** partition key text the entry's match values
compose: the match goes through the entity's domain key form (`_domainKeyForm`, the form a query
accessor's pins take; it accepts the domain value or its stored form, as an accessor does), then
`composePkText(schema, entityType, index, composites, names, undefined)` (`KeyComposer.ts:765`) with
the index's effective casing (`effectiveCasing`, `KeyComposer.ts:246`). The text index maps that text
to the entry's layout.

The key form needs the entity and the text needs the schema, so the work is split in two. When a
table is compiled (at `Entity.make` for a declared one, by the definition's own compile function for
a supplied one), each entry's match is checked and put into key form once (`keyRecord`), and a value
with no key text is refused there. The text index is then built from those records per key text
settings (§3.3).

So the key is the text itself: the schema prefix, the entity type or collection name, the composite
labels and values, under the casing and the escaping setting the keys are composed with. Nothing is
compared by value.

### 3.2 Resolving a value

`layoutOf(schema, entityType, index, unsharded)` returns the entry whose text equals `unsharded`, or
the default. Every path computes `unsharded` the way it composes the key: a write from its key-form
record, a query from its key-form pins, `rekey` from the row. Those three already compose the same
text for one logical value (the key form's invariant, #111; `test/KeyFormInvariant.test.ts`), so they
resolve the same layout. Casing and escaping are inside the text, so `T-BIG` and `t-big` resolve one
layout wherever the key treats them as one, and two where it doesn't (`preserve`).

Resolution is a lookup in an immutable map. Nothing caches a value's layout (D6): a query resolves
once when its partitions are computed, and `explain()`, every fan-out round and the cursor use that
one result, as they use the partitions today; a write resolves once per key it composes, from the one
table the operation read (§10.4), so two compositions of one value in one write agree; `rekey`
resolves once per row.

### 3.3 One table, several schemas

An entity registered on two tables meets two schemas (#183 D51), and a write's own schema
(`ownSchema`, `effect-dynamodb/src/Entity.ts:4699`) is a copy with `objectKeys` set. The text index is
therefore built per **key text settings** (schema name and version, effective casing, `escapeKeys`
and the numeric setting it implies), memoised on the `ShardTable`: `ownSchema` copies hit the same
entry, a second table's schema builds its own once. This memoises the compiled table, not any value's
layout. It is primed and checked (two entries composing one key) at `Table.make` for a declared table,
and at the layer build for a provided one, under the entity's configured schema. Escaping and the
numeric text are injective, so a table that passes under one setting of a schema passes under every
setting of it; only casing can merge two entries, and casing is fixed per index and schema. So a
memoised build never fails later (D16).

### 3.4 A partition key that can't be looked up

- **A truncated partition key** (the structural rule's prefix, `composePkPrefixUpTo`,
  `KeyComposer.ts:1300`) composes truncated text, which no entry composes, since an entry names
  every composite. It resolves the default. Writes and `rekey` compose the same truncated text, so
  they agree. No accessor can query a truncated partition key (an accessor requires every partition
  key composite), so no read depends on it. **Named limit:** partition key text is not escaped, so a
  value that spells the composites after it (a `tenantId` of `"hot#region_eu"`, truncated before
  `region`) composes the same text as the full key of another value (`{ tenantId: "hot", region:
  "eu" }`). Its row already shares that value's partition, as on an index without `shards`; with a
  table it takes the default layout where that value's entry may give another, so the row is in no
  partition the value's query reads, and `rekey` reports nothing (it composes the same truncated
  text). Not handled: it needs a key value that spells another composite's name and value.
- **A row whose partition key composites can't compose any text** (a hole, or no leading value) has
  no value to look up. `rekey` leaves it alone when its stored text lies in the layout of the default
  **or of any entry whose match agrees with the composites the row still holds**, and reports it
  `uncomposable` otherwise (§9.2, D34). Judging it against the default alone would report a hot
  value's hole rows (`!20.07#…` under `{ default: 1 }`) on every run, though a read finds them where
  they are, and §15's "a dry run with no conflicts" could never be met for that index. Such a row
  lost a partition key composite under `preserve`, which is already the accepted limit of #183 §9.2.

## 4. Key text per layout

| Resolved layout | Written partition key | Partitions a query reads |
|---|---|---|
| `1` | unsharded text, byte-identical to an index without `shards` | one: the unsharded text. A plain query, no fan-out |
| `N` (2..256) | `!N.s` marker, as today | N shards, or one when pruned |
| `{ count: N, previous: 1 }` | `!N.s` | N shards (or one), then the unsharded text |
| `{ count: 1, previous: N }` | unsharded text | the unsharded text, then N shards |
| `{ count: N, previous: M }` | `!N.s` | N (or one), then M, as today |

**Count 1 is never `!1.0`** (D3). `shardMarker(1, 0)` (`internal/Shards.ts:72`) would give `!1.0`,
a third layout nothing reads. So the marker is composed only for a count above 1:
`composedShardMarker` returns `undefined` for a resolved count of 1, which makes `composePkText` emit
the unsharded text (`KeyComposer.ts:781`); `composeReadPartitions` builds a layout of count 1 as the
single unsharded text, the case `previous: 1` already handles (`KeyComposer.ts:1000`). The golden
vectors pin both (§16.2).

**The shard source is still required at count 1** (D4). `composedShardMarker` checks the source
before it resolves, so a missing `by` throws `[EDD-9100]` at every count. A `put` without its `by`
values writes no entry, whatever the value's count (#183 D26: `tryComposeIndexKeys` requires every
composite, `KeyComposer.ts:1206`). This keeps any value shardable later without leaving rows `rekey`
can't place.

**Pruning** applies within the resolved count: a pinned source reads one of the N current shards. A
count of 1 has nothing to prune. `previous` is never pruned (#183 D16).

## 5. Write paths

Every write path composes a sharded partition key through `composePk` (`KeyComposer.ts:744`), the
truncating composer (`composePkPrefixUpTo`, `KeyComposer.ts:1300`) or the update gate
(`composeGsiKeysForUpdatePolicyAware`, `KeyComposer.ts:1885`, through `shardedPkOutcome`,
`KeyComposer.ts:1739`), all of which reach `composedShardMarker`. Resolution lives there (§4), so for
a **declared** table no call site changes: the definition carries the table.

A **provided** table has to reach the schema the composer is given (D36). Each operation of an entity
with a provided index reads `ShardLayouts` once, at its start, and composes under a copy of its schema
carrying the tables (`_schemaNow`, §10.4). The copy replaces the schema at each composing site below
(and `ownSchema` copies it again, keeping the tables); `allIndexes` is unchanged everywhere. An entity
with no provided index reads nothing and composes under its schema as today, so its code path and its
requests are unchanged. A site that composes a provided index under a schema without its table throws
`[EDD-9181]` from `shardTableOf`, a defect that `composeKeysOrFail` does not turn into a
`ValidationError` (`Capacity.isRefusedValue` doesn't recognise it), so nothing is sent.

**Cascade targets (D31).** An update's `.cascade({ targets })` reads each target's index after the
source row is written (`executeCascade`, `Entity.ts:10381`, run at `:12761` and `:13714`), and the
targets are given per call, so `DynamoClient.make` never checked their tables. The cascading update
therefore resolves the tables of every target with a provided index **before** its own write,
alongside its own `_schemaNow`, and a missing one dies with `[EDD-9181]` with nothing written. The
cascade then reads each target under the schema resolved then.

All `file:line` references are to `9ec9bb63`.

| Path | Composing site | How it gets the table |
|---|---|---|
| `put`, `create` | `composeAllKeys` helper (`effect-dynamodb/src/Entity.ts:6949`, body `:6959`, `KeyComposer.composeAllKeys` at `:6965`), called at `:10861` | the op's schema (`_schemaNow`) |
| Guarded put (unique, retain), carried keys | `:11031` (`composeKeys` of the plan) | the op's schema (`_schemaNow`) |
| `upsert` | pre-check `:15004`, keys `:15264`, and `upsertKeys` → `KeyComposer.composeKnownHalves` (`:7192`, `:7212`; `KeyComposer.ts:1224`) | the op's schema (`_schemaNow`) |
| `update`, `patch` (standard) | `composeGsiKeysForUpdatePolicyAware` at `:13250` | the op's schema (`_schemaNow`) |
| `update` pre-check before the retain / computed branch | `:11606` | the op's schema (`_schemaNow`) |
| Retain and computed branches | `:12074` | the op's schema (`_schemaNow`) |
| `append` (time series) | `composeAppendKeys` → `:16044` | the op's schema (`_schemaNow`) |
| `restore` | `composeAllKeys` at `:17169` | the op's schema (`_schemaNow`) |
| `Batch.write` put | `Batch.ts:441` → `validateAndBuildPutItem` (`internal/TransactableOps.ts:1234`) → `KeyComposer.composeAllKeys` (`:1305`) | `entity._schemaNow` (§10.4), under the op's captured services (`underCaptured`, `TransactableOps.ts:60`) for a bound builder |
| `Transaction.transactWrite` put | `internal/TransactWriteOps.ts:568` → the same `validateAndBuildPutItem` | as `Batch.write` |
| `transactWrite` update / delete (planned) | `TransactWriteOps.ts:519` (`_planUpdate`), `:543` (`_planDelete`): the entity's own op, recorded (`internal/TransactPlan.ts`) | the entity's op schema, under the op's captured services |
| `EventStore.append({ additionalItems })` | `buildTransactWriteItems` → `TransactWriteOps.ts:568` (put) | as `transactWrite`, inside the append's context (a bound stream's is its bind context, `EventStore.ts:7238`) |
| Projection rows (read-model `put`) | `internal/ProjectionEngine.ts:1883`, `:2705` → `validateAndBuildPutItem` | `entity._schemaNow`, in the context the projection runs in |
| `rekey`: a missing index key | `KeyComposer.judgeIndexHalf` (`Entity.ts:18499`; `KeyComposer.ts:1629`) | the run's schema (§9) |
| `rekey`: the sharded partition key | `composeStoredPk` / `isCurrentShardLayout` (`Entity.ts:19011`, `:19014`) | the run's schema |
| `rekey`: a moved row recomposed (`rekeyAfterMove`, dry run's `movedRowOf`) | `composeGsiKeysForUpdatePolicyAware` at `:18690` | the run's schema |

Paths that compose no sharded partition key, unchanged (#183 §4): soft delete, version snapshots and
time-series events strip index keys; unique sentinels hold none; aggregate writes compose only their
own attributes and never read an edge entity's `indexes` (#183 §11); cascade updates write the
denormalised ref fields and no index key (`Entity.ts:10455` onwards reads the cascade index; §6).

**`capturedServices`** (`internal/TransactableOps.ts:37`) gains `ShardLayouts` beside `BlobStore` and
`Compression`, so a bound builder handed to `Batch`, `Transaction` or `EventStore.append` composes with
the table its binding captured, whatever the caller's context holds (#179 §3.6's rule).

**Updates that change a partition key value** resolve the new value's layout: the gate's SET composes
from the merged record, which holds the new value, so the entry moves to that value's partition and
layout, as it moves partitions today.

## 6. Read paths

### 6.1 `composeReadPartitions`

`composeReadPartitions` (`KeyComposer.ts:964`) composes the pinned value's unsharded text (it
already composes the composites, `:977`), resolves its layout, and returns the partitions of §4.
`ReadPartitions` (`:935`) gains the resolved layout:

```ts
interface ReadPartitions {
  readonly partitions: ReadonlyArray<string>
  readonly fanOut: ReadFanOut | undefined        // undefined at count 1 without previous
  readonly layout: { readonly count: number; readonly previous: number | undefined } | undefined // undefined only without shards
}
```

A value at `1` with no `previous` returns one partition and `fanOut: undefined`: the query is a plain
one, sends what an index without `shards` sends for the same pins (D10), and emits the legacy cursor.
`ReadFanOut.count` and `.previous` are the resolved ones, so the fingerprint (`Query.ts:3996`) covers
them as today.

Call sites, all at `9ec9bb63`:

| Site | Path | How it gets the table |
|---|---|---|
| `DynamoClient.ts:2943` | bound entity accessors, `db.entities.X.byIndex(...)` | the schema `DynamoClient.make` resolved at bind, carrying the tables (§10.4); resolved when the query is built |
| `DynamoClient.ts:3387` | bound collection accessors | the schema resolved at bind; resolved when built |
| `Entity.ts:16764` | unbound `Entity.query.<index>` | a provided index defers: resolved at the terminal (§6.2) |
| `Entity.ts:10475` | cascade read of the target's index | the schema the cascading update resolved for its targets before its own write (§5, D31) |
| `Collection.ts:420` | unbound collection query (`Collections.make`) | deferred, if any member's index is provided (§6.2) |
| `Collection.ts:487` | unbound collection entity selectors | deferred, likewise |
| `docs/src/lib/playground-engine.ts:185` | docs playground | a declared table resolves; `"provided"` shows the placeholder marker (§13) |

### 6.2 Queries built before the table is known

Query builders are synchronous, and an unbound query on a provided index has no context until a
terminal runs. Such a query is built with `pkValue` unset and a deferred resolution
(`QueryState.shardRead: (tables) => ReadPartitions`). `prepared` (`Query.ts:2369`), `explain`
(`:3908`) and `asParams` (`:3960`) read `ShardLayouts` with `Effect.serviceOption` first, run the
resolution once, and install the result as `Query.fanOut` (`:808`) does now. Nothing is sent before
it. A missing table dies with `[EDD-9181]`. An unbound `Query.where()` that replaced the pins
(`withoutPruning`, `:751`) is recorded on the state, and the deferred resolution then reads every
current shard, as `withoutPruning` would have.

**A key-text refusal stays a `ValidationError` (D40).** Built eagerly, the composition runs inside
`Query.orRefusal` (`Entity.ts:16739`, `Collection.ts:409`): a composite with no key text
(`EDD-9096`) or an object composing `[object Object]` (`EDD-9162`) makes a refused query, whose
terminals fail with a `ValidationError`. The deferred resolution runs inside the same wrapper
(`Query.refusalOf`), so the same input fails the same way on a provided index: `prepared` and
`asParams` fail with the `ValidationError`, and `explain` (no error channel) reports the refused
query's `empty` plan with the refusal as its reason, as it does for a query refused at build.
`[EDD-9181]` is not a refused value, so it stays a defect.

### 6.3 Rules per index, on reads

`refuseShardedPlan` (`Query.ts:1202`) and `plan` (`:1182`) test `state.fanOut !== undefined` today. A
value at 1 has no fan-out, so they test a new `state.sharded` flag instead (the resolved layout, or
the deferred resolution's marker), set by every builder of a query on an index with `shards`
(static, table or provided), before resolution. So `.within()`, skip-scan and `.zorder()` stay
refused for every value (`EDD-9104`, D4), including on a deferred query. `BoundQuery`'s calls
(`internal/BoundQuery.ts:1397`, `:1421`) are unchanged.

`planEmpty` (`:1212`) installs its empty plan through `plan`, after clearing `fanOut`: nothing is
read, so no partition is. It clears `sharded` too (D32), or every provably empty query on a sharded
index, static ones included, would throw `EDD-9104` instead of returning nothing
(`ShardedMembers.test.ts:329`).

`isFanOutState` (`Query.ts:2111`) keeps meaning "a fan-out": a plain query at 1 sizes requests and
treats `.maxPages()` as an unsharded query does, which is what byte-identical requests need.
`.concurrency(n)` has no effect on it (#183 D23).

### 6.4 `explain()`

`QueryExplain` gains `shards?: { count, previous, partitions }` (D14), set on every query of an index
with `shards`: the resolved count and previous for the pinned value and the partition key text of
each partition read. A plain query at 1 reports `{ count: 1, previous: undefined, partitions:
[unsharded] }` with plan `key`. The existing `fanOut` field is unchanged and present only on a
fan-out. For a static index the field is new and additive: it reports what `fanOut` implied.

### 6.5 Cursors

No new mechanism (D10). The existing checks already separate layouts:

| Step for one value | Cursor from before | Refused by |
|---|---|---|
| `1` → `{ 20, previous: 1 }` | legacy (plain query) | `resumeFanOut` (`Query.ts:4034`): no `z` on a sharded query, `EDD-9094` |
| `{ 20, previous: 1 }` → `20` | v2, fingerprint over 21 partitions and `previous: 1` | fingerprint mismatch, `EDD-9094` |
| `20` → `{ 1, previous: 20 }` | v2, count 20 | fingerprint mismatch (count, partitions), `EDD-9094` |
| `{ 1, previous: 20 }` → `1` | v2 | `resume` (`Query.ts:2443`): a sharded query's cursor on a plain one, `EDD-9094` |
| any step for **another** value | unchanged: a legacy cursor stays legacy; a fingerprint covers the index, entity types, count, source, previous, partitions and direction, none of which another value's entry changes | accepted |

A legacy cursor carries no fingerprint, so between two plain queries at 1 it is accepted as on any
unsharded index (#171's documented limit). §16 tests every row.

## 7. The update gate

Unchanged (D4). The gate (#183 §5) decides each case from four things: whether the PK half's
composites are present, omitted or removed; whether a `by` attribute is touched, cleared or removed;
the half's policy; and whether the sort key half keeps its text. None of them is the count. The count
enters only after the gate has chosen SET, when `composePk` or the truncating composer composes the
text, and that is where the value's layout is resolved (§4).

The alternative, letting the gate follow the resolved count, was rejected for three reasons:

- **An update that works today would fail the day its value turns hot.** A `by`-only update on a cold
  value would be allowed at 1 and refused at 20, so changing a table entry would break callers of that
  value that never changed.
- **A row whose `by` was cleared at 1 could never be sharded.** `rekey` can't compute a shard without
  the source, so a value moved to 20 would leave that row stranded (`uncomposable`).
- **The gate can't know the count it would follow.** The decision is made per index half before any
  text exists; resolving first would need the merged record's partition key, which case 2 (a `by`-only
  update) doesn't have.

So for every value, including those at 1: a `by`-only update without the partition key composites
fails `EDD-9100` (case 2, case 8); a `by` change that leaves the sort key's text behind fails (case 6a);
`.remove(["by"])` drops the entry (case 1); an unrelated update is a noop (case 9). Shapes 9 and 9a-9d
get table variants with a value at 1 and a value at N (§16.3).

## 8. Rules that stay per index

An index with a table, declared or provided, counts as sharded for every rule (D4), whatever any
value resolves to:

| Rule | Code | Test against |
|---|---|---|
| `.within()`, skip-scan, `.zorder()` refused | `EDD-9104` | `state.sharded` (§6.3) |
| `GeoIndex` over the index refused | `EDD-9104` | `indexDef.shards !== undefined` (`effect-dynamodb-geo/src/GeoIndex.ts:250`), unchanged |
| Nothing to spread | `EDD-9101` | `bindShards`, unchanged |
| `by` checks | `EDD-9102` | unchanged |
| Shared key attributes | `EDD-9106` | §12 |
| A `put` without `by` writes no entry | — | §4 |
| Update gate `by` cases | `EDD-9100` | §7 |
| `rekey` judges the partition key by the sharded rule | — | §9 |

Removing `shards` once every value is at 1 and settled restores `.within()`. Rows are already at the
unsharded text, so no `rekey` is needed for that step (the unsharded rule finds nothing to rewrite).

## 9. `rekey`

### 9.1 The rule

`rekey` already judges an index with `shards` by the sharded rule (`Entity.ts:19007`): compose the
partition key the row's values compose now, and rewrite it when it differs from what is stored,
whatever is stored (#183 D24). An index with a table has `shards`, so it takes that branch for every
value (D9), including those at 1. What changes is what "composes now" means: `composeStoredPk`
(`KeyComposer.ts:837`) resolves the row's layout from the row's unsharded text, so a row of a value at
1 composes the unsharded text and a row holding `!20.07#…` for that value is moved to it.

That is the case the review identified: under the unsharded rule (the `else` branch, `Entity.ts:19021`)
an unsharded key is rewritten only when the stored text is exactly an older form's text (#183 §9.2), so
a value moving from 20 to `{ count: 1, previous: 20 }` would keep its `!20.07#…` rows, unreported, and
hide them once `previous` is removed. Under the sharded rule they move.

The move stays an `UpdateItem` on the index key attribute alone, guarded on the old text and on the
composites feeding it (`[...pk composites, ...source]`, `Entity.ts:19018`). The library never sets any
part of the table primary key (D70 of #183); nothing here changes that.

### 9.2 `isCurrentShardLayout`

For a row whose values can't compose its partition key (a `by` cleared under `preserve`),
`isCurrentShardLayout` (`KeyComposer.ts:891`) decides between "already where a read finds it" (left
alone) and the `"uncomposable"` conflict. Today it tests the prefix `<label>#!<shards.count>.`. It
takes the row's **resolved** layout instead:

- count N > 1: the stored text starts with `<label>#!N.`, as today with N resolved;
- count 1: the stored text is the label alone or starts with `<label>#` and its next character is not
  `!`, the unsharded layout.

The row's layout is resolved from its unsharded text, which needs only the partition key composites
(present: it's `by` that's missing). A row with no partition key text (a hole) is left alone when its
stored text lies in the layout of the default or of any entry whose match agrees with the
composites it still holds, compared as key text (D34, §3.4).

So `isCurrentShardLayout` needs the row's key-form record as well as its stored text, which its
signature (`stored` only) doesn't take: it gains an optional `record` parameter. Without one (an
existing caller), it tests the default layout, which for a static declaration is today's test.

### 9.3 Dry run, malformed and missing tables

- **Dry run** is unchanged and reports, per index, the rows not in their resolved layout (moves it
  would make, and `uncomposable` conflicts). It is the check after each migration step settles (§15).
- **A malformed table** can't reach `rekey`: a declared one fails at `Entity.make` / `Table.make`, a
  provided one when its layer is built (D8).
- **A missing provided table** fails the run before the scan (D8, D11): `rekey` reads `ShardLayouts`
  once at the start (`rekeyFor`, `DynamoClient.ts:3592`, runs under the bind context, so the bound
  client's table is the one used), attaches each member's tables, and dies with `[EDD-9181]` naming the
  first member and index without one. The table's members that the client didn't bind are checked here
  too: they were never checked at `DynamoClient.make`.
- **One table per run.** The table is read once per process (D11), so one run judges every row against
  one table.

## 10. `ShardLayouts`

### 10.1 API

A new module, `packages/schema/src/ShardLayouts.ts` (AWS-free, beside `Compression.ts`), re-exported
from `effect-dynamodb` as `ShardLayouts`:

```ts
export type Layout = number | { readonly count: number; readonly previous?: number }

export class ShardLayouts extends Context.Service<ShardLayouts, ShardLayoutsRegistry>()(
  "@effect-dynamodb/ShardLayouts",
) {
  /** The tables for one entity's provided indexes; each a table, or a Config of one. */
  static readonly of: <E extends EntityLike, T extends ProvidedTables<E>>(entity: E, tables: T) => Entry<ConfigErrors<T>>
  /** A layer from entries, resolving any Config in them. */
  static readonly layer: <Es extends ReadonlyArray<Entry<any>>>(entries: Es) => Layer.Layer<ShardLayouts, ErrorsOf<Es>>
  /** A layer from an Effect producing entries: a table loaded at startup. */
  static readonly layerEffect: <Es extends ReadonlyArray<Entry<any>>, E, R>(
    effect: Effect.Effect<Es, E, R>,
  ) => Layer.Layer<ShardLayouts, E | ErrorsOf<Es>, R>
  /** A Schema for one table, for Config.schema with Schema.fromJsonString, or an entity field. */
  static readonly Table: Schema.Codec<ShardLayouts.Table, ShardLayouts.TableEncoded>
}
```

The names follow the review's illustration; the semantics are D11's. Usage:

```ts
const ShardsLayer = ShardLayouts.layer([
  ShardLayouts.of(Devices, {
    byTenant: Config.String("BIG_TENANT_ID").pipe(
      Config.map((id) => ({ default: 1, values: [{ match: { tenantId: id }, layout: 20 }] })),
    ),
  }),
])

// The whole table in one variable:
// byTenant: Config.schema(Schema.fromJsonString(ShardLayouts.Table), "DEVICE_SHARDS")
```

### 10.2 `ShardLayouts.Table`

A `Schema` for `{ default: Layout, values?: Array<{ match: Record<string, string | number | boolean>,
layout: Layout }> }`, with a brand. It checks the shape and the ranges a schema can (count and previous
integers in range, previous not equal to count), so a bad JSON variable is a `ConfigError` naming the
path. What needs the entity (match names, key text, duplicates) is checked by `of` when the layer
builds (§10.5). The brand is what lets `of` accept a decoded table without typing its `match` (a
decoded table's names are known only at run time) while still checking a literal one: a literal isn't
branded, so it must satisfy the typed form.

Match values are JSON primitives. A composite whose domain value isn't one (a `DateTime`, a `bigint`)
is given in its stored form (an ISO string, a digit string), which the domain key form accepts as an
accessor's pin does (§3.1).

### 10.3 `of()`

- The types restrict `tables` to the indexes of `E` declared `layouts: "provided"`, and require each of
  them (D20). Each value is a typed table (`match` typed as in §2.2, keyed by that index's partition
  key composites), a branded `ShardLayouts.Table`, or a `Config` of either.
- At run time (for untyped callers, and for decoded tables): an index that isn't declared
  `"provided"`, an unknown index, or a provided index left out is `[EDD-9182]`; a malformed table is
  `[EDD-9099]` (§2.3).
- **A literal is checked as `Entity.make` checks one (D37).** The branded `ShardLayouts.Table`
  member's `match: Record<string, …>` would make every key known to the union's excess-property
  check, so a literal holding the right composite and a typo (`{ tenantId, tenantID }`) would pass.
  `of()` puts the same `never`-mapping guard on its parameter that §2.2 puts on `Entity.make`'s, so
  an unbranded literal is checked key by key.
- Entries are keyed by the entity's definition identity (the `EntityDefinitionData` a pure definition
  and the runtime entity promoted from it share), so `DynamoClient.make`'s promotion of a pure
  definition (#265) finds the same table.
- Two entries in one layer for the same entity are `[EDD-9182]`. Two `ShardLayouts` layers in one
  application are not detectable: the one provided last is the service, by Effect's rules. The guide
  says to build one layer with every entry.

### 10.4 Where each path reads it

The Compression precedent (`DynamoClient.ts:2704`–`2757`, `TransactableOps.ts:37`, `Entity.ts:22342`),
followed exactly:

| Path | Reads `ShardLayouts` | Missing table |
|---|---|---|
| `DynamoClient.make` | **at bind**, from the bind context (`baseCtx`, `DynamoClient.ts:2704`), added to the captured context of every bound member (as `Compression` at `:2755`), and carried on the schema its accessors and collections compose under (D36) | `[EDD-9181]` defect at bind, naming every bound member and provided index without a table, as `[EDD-9078]` names missing codecs |
| Bound CRUD ops, bound builders | at run, from the captured context: the bind's table | can't happen: checked at bind |
| A cascade's targets (given per call, never bound) | at run, by the cascading update **before its own write** (D31) | `[EDD-9181]` defect, nothing written |
| Bound accessors and collections | at build, from the schema resolved at bind | can't happen |
| Unbound entity ops (`Entity.put(...)` etc. run through `Transaction`, `Batch`, `EventStore.append({ additionalItems })`) | at run, `Effect.serviceOption(ShardLayouts)` once per op (`_schemaNow`), under the op's captured services when it is a bound builder | `[EDD-9181]` defect before anything is sent |
| Projection rows | at run, in the projection's context | as above |
| Unbound queries (`Entity.query.<index>`, `Collections.make`) | at the terminal (§6.2) | as above |
| `rekey` | at the start of the run, from the bind context (§9.3) | the run fails before the scan |

`_schemaNow` (new, on the runtime entity) is `Effect.succeed(schema)` for an entity with no
provided index, so such an entity reads no service and its operations are unchanged. With one, it
reads the service and returns a copy of the schema whose `shardTables` maps each provided index's
`IndexShards` to the supplied `ShardTable` (compiled for this entity and index), and dies with
`[EDD-9181]` when the service or the entry is missing. Every composing site in §5 takes the schema
from one `_schemaNow` at the start of its operation. Index definitions are never copied (D36).

**As built.** `_schemaNow` was not needed: the same effect comes from where a composition runs.
`KeyComposer.shardTableOf` returns the table the schema carries (`DynamoSchema.shardTables`, set by
`withShardTables`: what `DynamoClient.make` hands its accessors and collections), else the table of
the `ShardLayouts` service in the context of the fiber the composition runs in
(`Fiber.getCurrent()`), else throws `[EDD-9181]`. A bound op runs in its binding's captured context,
which `DynamoClient.make` and `capturedServices` give the service, so it composes with the bind's
table whatever the caller holds; an unbound op runs in the caller's. Every entry point without a
bound client checks its entity's provided indexes as it starts (`requireShardTables`, through
`entity._requireShardTables`, `undefined` on an entity with none, which therefore reads nothing), so a
missing table sends nothing even on a write that wouldn't compose that index. The sites of §5
needed no change.

**Missing is always an error, never a fallback** (D11). The message, per the review:

```
[EDD-9181] Devices.byTenant declares shards: { layouts: "provided" }, but no ShardLayouts layer
supplies its table. Add ShardLayouts.layer(...) to the application layer.
```

It is a defect, not a `ValidationError`: it is configuration, raised at bind where it can be, and at
run only on paths that have no bind (D21).

### 10.5 Building the layer

`layer` resolves each `Config` (its `ConfigError` is the layer's error), then validates each table
against its entity and index: the checks of §2.3 that need the entity, then the text index under the
entity's configured schema (`entity._schema`, set by `Table.make`). A table the library refuses is a
defect with `[EDD-9099]` or `[EDD-9182]` (D22), so the application does not start. An entity not yet
registered on any table (no schema) is `[EDD-9182]`; registration happens at module load, so in
practice this is a definition never added to a `Table.make`.

`layerEffect` runs its Effect once, when the layer is built. Its failure is the layer's failure: a
config item that can't be read stops the application from starting, rather than letting it run
unsharded (D8). The review's DynamoDB-config-item example works as written: the Effect builds its own
client for a config entity, reads the item, and returns `[ShardLayouts.of(Devices, { byTenant:
item.layouts })]`, where `item.layouts` is a field of type `ShardLayouts.Table`.

A config entity that itself declares a provided layout can't be read that way: nothing supplies its
table yet, so its first operation dies with `[EDD-9181]`. That is the documented outcome (D11), not a
special case.

### 10.6 One table per process

The service is built once per layer build and never changes. There is no hot reload (D11): a table
that changed while a process ran could let one `rekey` run judge rows against two tables, and nothing
could tell. Hot reload needs its own design.

## 11. Collections

Members of a collection on a sharded index must agree on the partitions a query reads (#183 D9).
`assertCollectionShardsAgreement` (`KeyComposer.ts:281`) compares `count`/`previous` today; it
compares the members' **tables by content** instead (D5): equal defaults, and equal text indexes
(text → layout) under the collection's schema. A collection's partition key is labelled with the
collection name, so two members' entries for one value compose the same text, and two tables spelled
differently but meaning the same (an entry in domain form on one member and stored form on the other,
or `T-BIG` and `t-big` under `lowercase`) are equal. A static member compares as a table with only a
default, so existing collections compare as today. `by` may still differ.

**A member without `shards` never agrees with a member that has them (D39)**, `{ layouts: { default:
1 } }` included. Their reads agree today, but their rules don't (D4: `.within()`, `by`, the update
gate), and the day the table member's value moves, the unsharded member can't follow it. So
`EDD-9103` stays strict: a collection is sharded on every member or on none.

The function keeps its name and its `(collectionName, members)` signature; each member gains an
optional `schema` (the member's configured schema, as `assertCollectionCasingAgreement` already takes
it). Without one, tables are compared under the default casing; both call sites pass it.

Where it runs, after runtime tables are applied:

- `Collections.make` (`Collection.ts:339`): members with declared tables are compared at once. If any
  member's index is provided, the content comparison runs when a query of the collection resolves its
  partitions (§6.2), from the tables in context, and a disagreement dies with `[EDD-9103]` before
  anything is sent.
- `DynamoClient.make` (`DynamoClient.ts:3338`): after the tables are attached at bind, so a
  disagreement fails the bind.

A collection query reads the pinned value's layout from the first member, as it reads the first
member's key form today (`Collection.ts:417`), which the comparison makes equivalent. Collection
queries never prune (#183 D10).

## 12. `EDD-9106` and a shared attribute

`shardForm` (`internal/SharedKeyAttribute.ts:47`) is what two halves sharing an attribute must agree on
to be provably the same (#183 D50). It becomes the canonical declaration of the table (default, then
entries sorted by their key-form match, each with its layout) and the source. A provided half has no
provable form at `Entity.make`, so a provided partition key half sharing its attribute with any other
half is refused (`EDD-9106`, D23). Contrived either way: an entity storing two sharded partition keys
in one attribute is the inverted-index case #183 D68 already discourages. **Named limit:** the form
spells a bigint match value as its digits and `n`, so a field typed as a union of string and bigint
whose tables differ only in `5n` and `"5n"` passes as one form though the two compose different keys.
Not handled: it needs that union type, two indexes sharing a partition key attribute and two tables
differing in exactly that spelling.

## 13. Language service and playground

- **Resolver** (`language-service/src/core/EntityResolver.ts:531`–`573`): `resolveShards` parses the
  table form from the literal (`default`, each `values` entry's `match` and `layout`) and
  `layouts: "provided"`. A table it can't read from the literal (built elsewhere and referenced) is
  shown as "a table" without entries, as a non-literal `count` shows `{count}` now.
- **Hover** (`ParamsBuilder.ts:551`, `:563`, `:567`, `:834`, D13): the marker shows `!{count}.{shard}`
  for an index with a table, and the shards line shows the table and says the layout varies by value:
  `Shards: by value (default 1; tenantId=t-big → 20). A value at 1 reads one unsharded partition.` For
  `"provided"`: `Shards: by value, supplied at run time by a ShardLayouts layer.` The static forms keep
  today's text.
- **Completions** for `match` come from the type guard (§2.2): TypeScript's own completions, checked
  with the language service as for every definition-time name.
- **`KeyParity.test.ts`** gains a table case: the hover's params for a value at 1 equal the runtime's
  plain query; for a value at N, the marker shape.
- **Playground** (`docs/src/lib/playground-engine.ts:185`): composes through `composeReadPartitions`,
  so a declared table renders the pinned value's real key. A provided index renders the placeholder
  marker, as the language service does. The playground's write-key preview composes through
  `KeyComposer.composeIndexKeys` (`playground-engine.ts:38`), which would throw `[EDD-9181]` for a
  provided index: it renders the same placeholder there (D38), on both paths, rather than crash.

## 14. Docs and examples

- **Guide** `packages/docs/src/content/docs/guides/sharding.mdx`: a new section, "Per-value layouts",
  after "Adopting sharding on a populated index": the table form, lookup by key text (one layout for
  `T-BIG` and `t-big` under `lowercase`), count 1 as the unsharded key, the rules that stay per index
  (what switching an index to a table costs: `.within()` for every value, `by`-only updates on cold
  values), `explain()`'s `shards`, `ShardLayouts.layer` from `Config`, `layerEffect` from a config
  item, the missing-table error, and the migration recipe of §15 with its rules. "Error codes" gains
  `EDD-9181` and `EDD-9182`, and the `EDD-9099` / `EDD-9103` rows are reworded.
- **Example** `packages/effect-dynamodb/examples/guide-sharding.ts` gains regions (`layouts-entity`,
  `layouts-explain`, `layouts-provided`, `layouts-layer`, `layouts-config-item`,
  `layouts-layer-effect`, `layouts-missing`, `layouts-provided-use`, `layouts-migrate`),
  run against DynamoDB Local. Configuration comes from `ConfigProvider.fromUnknown` / a map in the
  example, never from `process` (owner rule).
- **API reference** (`reference/api-reference.mdx`): `ShardLayouts`, its `layer`, `layerEffect`,
  `of`, `Table`, and the `shards` union.
- **DESIGN.md**: "Write Sharding (#183)" (line 2114), "Sharded partition key halves" (line 2454, a line that
  the gate is per index), "Fan-out Queries" (line 3786, a value at 1 is a plain query; `explain().shards`),
  "Cursors" (line 3825, the transitions of §6.5), "`rekey`" (line 956, the resolved layout), and the registry
  rows for `EDD-9099`, `EDD-9103`, `EDD-9104`.
- **CLAUDE.md**: the "GSI write sharding" note, and table variants named under canonical shapes 9 and
  9a-9d.
- **Changeset**: minor, lockstep.

## 15. Migration recipe and its rules

A change to a value's entry is a migration for that value (D12), in three steps, whether the entry is
in code or in configuration:

| From → to | Step 1 | Step 2 | Step 3 |
|---|---|---|---|
| unsharded → 20 | `{ count: 20, previous: 1 }` | `rekey` | `20` |
| 20 → unsharded | `{ count: 1, previous: 20 }` | `rekey` | `1` (or remove the entry when the default is 1) |
| 20 → 40 | `{ count: 40, previous: 20 }` | `rekey` | `40` |

Rules, which the guide states:

- **A step is finished only when every running process has it.** For a table in code or bundled
  config, that is when the deploy finishes. For a config item read by `layerEffect`, an edit changes
  nothing until processes restart, so the step is finished once every process has restarted since the
  edit, warm Lambda containers included.
- **Run `rekey`, or start the next step, only after that.** An old process still writing the old layout
  after `rekey` leaves rows that the next step strands once `previous` goes.
- **Check each step with `rekey({ dryRun: true })` once it has settled.** It reports rows not in their
  resolved layout (§9.3); remove `previous` only after a run that moves nothing and reports no
  conflicts.
- **Reads stay complete at every step**: step 1 reads both layouts for that value; step 3 reads one.
- **A cursor taken before a step is refused** (`EDD-9094`) for that value only (§6.5); a listing
  restarts.
- **Other values are untouched.** `rekey` moves only rows whose stored text differs from what they
  compose under their own resolved layout.
- **Switching an index from `shards: 20` to a table** whose default is 20 moves nothing. Switching an
  unsharded index to a table (`default: 1`) moves nothing either, but takes the per-index rules of §8.

## 16. Test plan

Every connected test runs under both `escapeKeys` settings, as the gate scripts do. File names are
indicative.

### 16.1 Byte-identical for indexes without a table

- **Request capture against `9ec9bb63`.** A fixture recorded once from `9ec9bb63` (a script committed
  beside it) of every request every operation sends, for an index without `shards`, with `shards: 20`,
  and with `{ count: 20, by, previous: 1 }`: put, create, upsert, update standard / retain / computed,
  patch, append, restore, delete, `Batch.write`, `transactWrite` put / update / delete,
  `EventStore.append` additional items, a projection row, accessor queries on every terminal, cursors,
  collections, cascade, `rekey` (dry and real). The suite asserts the branch sends exactly those
  requests. Under both `escapeKeys` settings. Never regenerated.
- **No service read.** An entity without a provided index runs every operation with no `ShardLayouts`
  in context and with one holding an unrelated table: identical requests.

### 16.2 KeyComposer (schema, unit)

- **Golden vectors** (`Shards.test.ts`, `KeyComposer.test.ts`): a value at 1 composes exactly the text
  an index without `shards` composes, through `composePk`, the truncating composer,
  `composeKnownHalves`, the update gate's SET and `composeReadPartitions`; never `!1.`. A value at N
  composes `!N.s` with the shard of today's vectors. `{ 1, previous: N }` reads `[unsharded, N shards]`;
  `{ N, previous: 1 }` reads `[N, unsharded]`. Mixed tables: two values, two layouts, one index.
- **Lookup by key text**: `T-BIG` and `t-big` resolve one layout under `lowercase` and `uppercase`, two
  under `preserve` (two entries accepted there, refused as duplicates under `lowercase`); a match in
  domain form and in stored form (`DateTime` / ISO string, `BigIntFromString` / digits, a number
  composite / its text) resolves one entry; a collection label; both `escapeKeys` settings; an entity
  on two tables with different casings (§3.3).
- **Validation**, each refused before anything runs with its code (§2.3): count 0, 1.5, 257, `"20"`;
  previous 0, equal to count, 257; unknown keys; `layouts` beside `count` / `previous`; no `default`;
  a match missing a composite, naming a non-composite, naming another index's composite; a match value
  with no key text (`NaN`); two entries composing one key (at `Table.make`); `values` on an empty
  partition key half; `shards: 1` and `{ count: 1 }` still refused; `{ count: 1, previous: 20 }` and
  `{ layouts: { default: 1 } }` accepted. `EDD-9101`, `EDD-9102`, `EDD-9106` (a provided half sharing
  an attribute), `EDD-9108` on table indexes.
- **Truncated partition key** resolves the default (§3.4).

### 16.3 Canonical shapes (unit, entity level and connected)

Table variants of shapes 9 and 9a-9d, each with one value at 1 and one at N, under `sparse` and
`preserve`, on the standard, retain, computed and `append` paths:

- **9** `pk: [tenantId], sk: [groupId, deviceId], shards: { by: [groupId], layouts: { default: 1,
  values: [{ match: { tenantId: "t-big" }, layout: 20 }] } }`: a touched `by` moves the entry with the
  partition key composites, fails `EDD-9100` without them, at 1 and at 20.
- **9a** an empty partition key half with `by`: `values` refused, so the table variant is
  `{ default: { count: 1, previous: 20 } }` and `{ default: 20 }`; the half is skipped unless `by` is
  touched or known, at both.
- **9b** a `by` attribute that is also a primary-key composite: arrives through `keyRecord`, never a
  touched dependency, at 1 and at 20.
- **9c** a default source with an empty partition key half: the default variants of 9a.
- **9d** `sk: [region, group], by: [group]`: the update naming `tenantId` and `group` but not
  `region` fails `EDD-9100` under `preserve` at 1 too (D4), drops under `sparse`, cascades on
  `.remove(["region"])`, composes from the whole item on the retain and computed paths.
- A partition key value change from a value at 1 to a value at 20, and back: the entry moves to the
  new value's layout.

### 16.4 Write paths (unit with mocks, and connected)

For a value at 1 and a value at 20, each asserting the stored key text: put, create, upsert,
update, patch, retain update, append, restore after soft delete, `Batch.write` put,
`transactWrite` put / update / delete, `EventStore.append({ additionalItems })`, a projection row. Each
with `T-BIG` written and `t-big` queried (and the reverse) under `lowercase`: one partition, found.

### 16.5 Reads

- A value at 1: requests identical to an index without `shards` for the same pins (request capture),
  legacy cursor, `.maxPages()` sizing as unsharded; `.within()`, skip-scan and `.zorder()` refused with
  `EDD-9104` at 1, on bound, unbound and deferred queries.
- A value at 20: fan-out as today, pruning within 20.
- `explain()` reports `shards: { count, previous, partitions }` for 1, 20, `{ 20, previous: 1 }` and
  `{ 1, previous: 20 }`, on bound and deferred queries; `fanOut` only on fan-outs.
- Mixed values in one index: each query returns exactly its value's rows, with the expected request
  counts.

### 16.6 Cursors (decision 10)

For one value through `1 → { 20, previous: 1 } → 20 → { 1, previous: 20 } → 1`: a cursor taken at each
step is refused (`EDD-9094`) at the next, by the check §6.5 names; a cursor of a second value whose
entry doesn't change is accepted at every step, both for a value at 1 (legacy) and for a value at 20
(fingerprinted). Unit and connected.

### 16.7 `rekey`

- **Per-value adoption**: `{ 20, previous: 1 }` for one value, `rekey`: only that value's rows move;
  other values report `unchanged`; reads complete before, during (a run cut short with `maxPages`) and
  after; `20`: a dry run reports nothing.
- **Un-sharding through `rekey`**: `20 → { 1, previous: 20 } → rekey → 1`: the `!20.xx` rows move to the
  unsharded text (the case the unsharded rule would have stranded, §9.1); a dry run before the run
  reports each; after, a dry run reports nothing and every row is found with `previous` gone.
- `isCurrentShardLayout` against the resolved layout: an `uncomposable` row at 1 holding unsharded text
  is left alone; one holding `!20.xx` is the conflict.
- A provided table missing: the run fails before any request (mock client asserts no calls).
- Dry run agrees with the real run (#183 D88) on mixed tables.

### 16.8 `ShardLayouts`

- `layer` from a literal, from `Config` (`ConfigProvider.fromUnknown`), from `Config.schema(Schema.fromJsonString(ShardLayouts.Table))`; `layerEffect` from a config item read through a second client (connected).
- **The layer's table is the one every path uses**: bound CRUD, bound accessors and collections,
  unbound `Transaction`, `Batch` and `EventStore.append` ops, a bound builder passed to them from a
  client bound with another table (its captured table wins, §5), projection rows, unbound
  `Entity.query` and `Collections.make` queries, cascade, `rekey`.
- **A missing layer**: `DynamoClient.make` dies with `EDD-9181` naming every member and index; each
  unbound path dies at its first operation with nothing written (mock client asserts no calls);
  `rekey` fails before the scan; a deferred query dies at its terminal, `explain()` and `asParams`.
- **A failing `layerEffect`**: the layer fails with the Effect's error and the program never runs.
- **Malformed provided tables** die at layer build with `EDD-9099`; `of()` misuse (`EDD-9182`): an
  index not declared `"provided"`, an unknown index, a provided index left out, the same entity twice,
  an entity on no table.
- A `ConfigError` from a bad JSON table names the path.

### 16.9 Types (`*.types.test.ts`) and the language service

- `packages/schema/test/FieldNames.types.test.ts`: `match` with every composite (positive), a typo
  (`@ts-expect-error`), a missing composite, an extra key, another index's composite, a wrong value
  type; `default` required; `layouts: "provided"` accepted.
- `packages/effect-dynamodb/test/ShardLayouts.types.test.ts`: `of()` accepts exactly the provided
  indexes and requires each (`@ts-expect-error` on a non-provided index, an unknown index, a missing
  one); `match` typed per index, with `@ts-expect-error` on an extra key and on a typo beside the
  correct key (D37); a decoded `ShardLayouts.Table` accepted; a `Config` of a typed table accepted.
- `shards: { count: 20, layouts: { … } }` and `{ layouts, previous }` are `@ts-expect-error` (D37).
- Language service: hover text for a table, a provided index and a static one (`tooltip.test.ts`);
  `KeyParity` table case; a completion check on `match` keys.

### 16.10 Collections

Equal tables spelled differently accepted; different tables refused (`EDD-9103`) at `Collections.make`
(declared), at `DynamoClient.make` (provided, after the layer), and at the first query of an unbound
collection with a provided member; a static member and a table member with the same default compare
equal.

### 16.11 Docs

`pnpm --filter @effect-dynamodb/doctest test` (sync), the example run against DynamoDB Local, and the
gate scripts (`gates-fast.sh`, `gates-connected.sh`) with every package's connected suite.

## 17. Scoping

Every item of the issue body and the review comment, as **in**, **out** or **changed**.

### Issue: proposal

| Item | Scope | Note |
|---|---|---|
| `count` as a function of the partition key composites | **changed** | A table of values (D1) |
| Static `shards: N` and `{ count, by?, previous? }` stay | in | A table with only a default (§2.1) |
| Only the partition key composites decide the layout | in | `match` names exactly those (D2) |
| The function receives decoded values, not key text | **changed** | Lookup by unsharded key text (D2, §3) |
| Return `1` = unsharded, byte-identical | in | §4 (D3) |
| Return 2..256 = `!N.s` | in | |
| Return `{ count, previous }` for this value only | in | |
| Anything else refused before anything is sent, new code | **changed** | Refused before anything runs: at `Entity.make` / `Table.make` / layer build, with `EDD-9099` (D8, review) |
| Writes call it where the partition key is composed | in | Resolution in `composedShardMarker` (§5) |
| A sparse half that isn't composed never resolves | in | Resolution happens only when composing |
| Updates changing a partition key value resolve the new value | in | §5 |
| Queries resolve once with the pinned composites; `by` pruning within the count | in | §6.1 (D6) |
| `rekey` per row; only changed values move | in | §9 (D9) |
| Cursor fingerprint holds the resolved count/previous; a change invalidates only that value's cursors | in | Through the existing checks, no new mechanism (D10, §6.5) |
| `explain()` reports count, previous, partitions | in | `QueryExplain.shards` (D14) |
| Collections: same function reference, or document | **changed** | Tables compared by content (D5, §11) |
| Values only known at run time | in | `layouts: "provided"` (D11) |
| `DynamoClient.make({ shards })` override | **changed** | A `ShardLayouts` layer (D11, §10) |
| Client override's types restrict keys and composites | **changed** | `of()`'s types restrict to provided indexes and their composites (§10.3) |
| Contract: pure and deterministic | **changed** | A table is data, validated; what remains is "every process uses the same table" (§15) |
| Migration: `{ new, previous: old }`, `rekey`, `new` | in | §15 (D12) |

### Issue: open questions

| Question | Answer |
|---|---|
| 1. Collections with a function | Compare tables by content (D5) |
| 2. Static `count: 1` | `{ count: 1, previous: N }` allowed; bare `shards: 1` refused (D3) |
| 3. Caching | No caching of a value's layout (D6); the compiled table is memoised per key text setting (D16) |
| 4. `previous` as a function / static `previous` beside a function | `previous` only inside a layout (D7) |

### Issue: testing

| Item | Scope | Note |
|---|---|---|
| Golden vectors: 1 = unsharded, N = `!N.s` | in | §16.2 |
| Mixed layouts in one index | in | §16.2, §16.5 |
| Per-value adoption with `rekey` | in | §16.7 |
| Cursors survive for unchanged values, refused for the changed one | in | §16.6 |
| Client override replaces the entity's resolver; types reject unknowns | **changed** | The layer is the only source for a provided index; §16.8, §16.9 |
| Invalid returns refused with the new code, nothing written | **changed** | Invalid tables refused before anything runs, `EDD-9099` (§16.2, §16.8) |

### Review comment

| Item | Scope | Note |
|---|---|---|
| Review 1: table of values; layout = count or `{ count, previous }`; `match` names every partition key composite, typed; static `shards: 20` is a table with only a default | in | §2 |
| Review 2: rules per index: `EDD-9104`, `EDD-9101`, `EDD-9106`, put without `by`, gate's `by` cases | in | §7, §8 |
| Review 3: `{ count: 1, previous: N }` allowed; bare `shards: 1` refused | in | §2.1 |
| Review 4: collections compare tables by content where `EDD-9103` runs | in | §11 |
| Review 5: no caching | in | §3.2 |
| Review 6: `previous` only in a layout | in | §2.1 |
| Review 7: a malformed table fails before anything runs; `rekey` fails rather than skipping | in | §2.3, §9.3, §10.5 |
| Look layouts up by key text; two entries for one key refused | in | §3 |
| `rekey` judges every row of a table index by the sharded rule; `isCurrentShardLayout` against the resolved layout | in | §9 |
| Count 1 composes the unsharded key, never `!1.0`, on writes and reads | in | §4 |
| Cursors: a value at 1 is plain; existing checks refuse across layouts; test every step | in | §6.5, §16.6 |
| A table change is a migration; recommend `rekey({ dryRun: true })` | in | §15 |
| Language service hover shows the table and that the layout varies by value | in | §13 |
| A malformed table is `EDD-9099`; new codes allocated in the registry | in | `EDD-9181`, `EDD-9182` |
| A table supplied at run time comes from a layer, not `DynamoClient.make` | in | §10 |
| The entity declares `"provided"`, no default | in | §2.1 |
| `DynamoClient.make` reads it at bind; bound ops stay `R = never`; unbound ops, projections and `rekey` read it at run | in | §10.4 |
| A missing table fails at `DynamoClient.make` or the first unbound operation; never a fallback | in | `EDD-9181` (§10.4) |
| An index whose hot values are the same everywhere keeps its table on the entity | in | §2.1 |
| `ShardLayouts.layer` from `Config`; the whole table as one JSON variable | in | §10.1, §10.2 |
| `of()` limited to provided indexes and their composites; malformed refused at layer build | in | §10.3, §10.5 |
| `layerEffect` from a DynamoDB config item; a failed read fails the layer | in | §10.5 |
| A config entity can't use a provided layout itself | in | Named outcome: `EDD-9181` (§10.5) |
| The missing-layer message | in | §10.4 |
| Every process uses the same table; a step is finished when every process has it | in | §15 (guide) |
| `rekey` or the next step only after that; check with a dry run | in | §15 |
| Read once per process, never reloaded | in | §10.6 |
| Hot reload | **out** | Needs its own design (review) |
| Sharding a new hot value is three changes | in | §15 |
| Tests: shapes 9 and 9a-9d, `T-BIG`/`t-big`, un-sharding, malformed tables, `match` typo and completions, cursors, the layer on every path, a missing layer, a failing layer, connected | in | §16 |

### Introduced here

| Item | Scope | Note |
|---|---|---|
| Duplicate entries judged at `Table.make` for a declared table | **changed** from "at `Entity.make`" | Casing may come from the schema (D15) |
| `default` required in a declared table | in | D17 |
| A table resolving every value to 1 allowed | in | D18 |
| `values` refused on an empty partition key half | in | D19 |
| `of()` requires every provided index of the entity | in | D20 |
| Missing table is a defect | in | D21 |
| A table the layer build refuses is a defect | in | D22 |
| A provided half can't share its attribute | in | D23 |
| `explain().shards` on static sharded indexes too | in | D24 |
| `ShardLayouts` in the schema package | in | D25 |
| Bound builders compose with their binding's table in multi-item ops | in | D26 |
| Unbound queries on a provided index resolve at the terminal | in | D27 |
| A row with no partition key text judged against the default | in, named limit | D28 |
| Codes start at `EDD-9181` | in | D29 |

## 18. Codes

| Code | When | Raised by |
|---|---|---|
| `EDD-9099` (extended) | A malformed table or table declaration (§2.3) | `Entity.make`, `Table.make`, the `ShardLayouts` layer build |
| `EDD-9103` (extended) | Collection members' tables differ by content | `Collections.make`, a deferred collection query, `DynamoClient.make` |
| `EDD-9104` (unchanged, per index) | `.within()`, skip-scan, `.zorder()`, `GeoIndex` on any index with `shards` | the call |
| `EDD-9181` (new) | A provided index has no table: no `ShardLayouts` service, or no entry for the entity | `DynamoClient.make` (bind), the first unbound operation, a deferred query's terminal, `rekey` |
| `EDD-9182` (new) | `ShardLayouts.of` misused: an index not declared `"provided"`, an unknown index, a provided index left out, the same entity twice in one layer, an entity on no table | the layer build |

`EDD-9181` and `EDD-9182` are allocated in DESIGN.md's registry. `9173`–`9180` were reserved by #132 and #168
(1.44.0), so allocation starts at `9181`.

## 19. Decisions

D1 to D14 are the owner's (the brief and the review comment). D15 onwards are scoping calls made in this
design, for review.

| # | Decision | Status |
|---|---|---|
| D1 | A table of values, not a function. `layouts: { default, values: [{ match, layout }] }`, layout = count or `{ count, previous }`. The static forms are a table with only a default | owner |
| D2 | Lookup by unsharded key text, composed through the key form and the effective casing; two entries composing one key are refused; `match` names exactly the partition key composites, typed from the model | owner |
| D3 | Count 1 composes the unsharded text, never `!1.0`, on writes and reads. `{ count: 1, previous: N }` allowed as the default or for one value; bare `shards: 1` stays refused (`EDD-9099`) | owner |
| D4 | Rules are per index: `EDD-9104`, `EDD-9101`, `EDD-9106`, a put without `by` writes no entry, the gate's `by` cases fail `EDD-9100`, for every value including those at 1 | owner |
| D5 | Collections compare their members' tables by content (`EDD-9103`), where the check runs now, after runtime tables are applied | owner |
| D6 | No caching: once per query (explain, rounds, cursor share it), once per write, once per row in `rekey` | owner |
| D7 | `previous` only inside a layout | owner |
| D8 | A malformed table fails before anything runs: `Entity.make` or the layer build; `rekey` fails the run | owner |
| D9 | `rekey` judges every row of an index with a table by the sharded rule; `isCurrentShardLayout` tests the resolved layout | owner |
| D10 | Cursors: no new mechanism; every step of `1 → { 20, previous: 1 } → 20 → { 1, previous: 20 } → 1` tested | owner |
| D11 | `layouts: "provided"`, supplied by `ShardLayouts.layer` / `layerEffect` / `of` / `Table`; `DynamoClient.make` reads at bind, unbound paths at run; a missing table is a new code, never a fallback; read once per process, no hot reload; a provided config entity gets the missing-table error | owner |
| D12 | A change to a value's entry is a three-step migration, each finished when every process has it; `rekey({ dryRun: true })` after each | owner |
| D13 | Hover shows the table and that the layout varies by value; `match` keys get completions | owner |
| D14 | `explain()` reports the resolved count, previous and partitions | owner |
| D15 | Two entries composing one key are judged at `Table.make` for a declared table (the `EDD-9106` stage of #183 D51), since casing may come from the schema; everything else at `Entity.make` | proposed |
| D16 | The text index is memoised on the table per key text settings (an entity on two tables, `ownSchema` copies); it is a compiled table, not a cached layout, and a table valid under a schema is valid under every setting of it | proposed |
| D17 | `default` is required in a declared table | proposed |
| D18 | A table may resolve every value to 1 (`{ default: 1 }`); only the static `shards: 1` / `{ count: 1 }` stay refused | proposed |
| D19 | `values` refused on an empty partition key half: every entry would compose the one key | proposed |
| D20 | `of()` must give every provided index of the entity it names (types and `EDD-9182`), so a missing table means a missing `of()` | proposed |
| D21 | A missing table is a defect (`EDD-9181`), at bind and at run, as a missing codec is at bind (`EDD-9078`); not a member of any error union | proposed |
| D22 | A table the layer build refuses is a defect (`EDD-9099` / `EDD-9182`); a `Config` failure stays the layer's `ConfigError`, a `layerEffect` failure its own error | proposed |
| D23 | A provided partition key half sharing its attribute with another half is refused (`EDD-9106`): no provable form | proposed |
| D24 | `explain().shards` is set on every sharded index's query, static included (additive) | proposed |
| D25 | `ShardLayouts` lives in `@effect-dynamodb/schema` beside `Compression`, AWS-free, re-exported | proposed |
| D26 | `capturedServices` carries `ShardLayouts`: a bound builder in `Batch`, `Transaction` or `EventStore.append` composes with its binding's table (#179 §3.6's rule) | proposed |
| D27 | An unbound query on a provided index resolves its partitions at the terminal (`prepared`, `explain`, `asParams`); `state.sharded`, set at build, keeps `EDD-9104` refusals at the call | proposed |
| D28 | A row with no partition key text resolves the default layout, for writes (truncated text matches no entry) and `rekey`; named limit | proposed |
| D29 | New codes start at `EDD-9181`: `9173`–`9180` are reserved by #132 and #168 | proposed |
| D30 | Review F1, **accepted**: `NormalizedGsi` carries the `shards` declaration as a phantom (`shards.declared`), so `of()` can find the provided indexes and type `match` from either entity type (§2.2) | review |
| D31 | Review F2, **accepted**: a cascading update resolves the provided tables of every cascade target before its own write; a missing one dies with `EDD-9181` with nothing written (§5, §10.4) | review |
| D32 | Review F3, **accepted**: `planEmpty` clears `sharded` as it clears `fanOut`, so an empty plan on a sharded index still returns nothing (§6.3) | review |
| D33 | Review F4, **accepted**: `IndexShards` keeps `count` and `previous` as the default layout's (`count` 0 on a provided index, which no existing reader can hold); `assertCollectionShardsAgreement` keeps its name and signature, members gain an optional `schema` (§2.4, §11). No type-level break | review |
| D34 | Review F5, **accepted**: a row with a hole in its partition key is left alone when its stored text is in the layout of the default or of an entry agreeing with the composites it holds; `isCurrentShardLayout` gains an optional key-form `record` (§3.4, §9.2) | review |
| D35 | Review F6, **accepted**: Aggregate `exactOf` returns `undefined` (either) on an empty partition key half, sharded or not (§2.4) | review |
| D36 | Review F7, **accepted, by changing the seam**: no path composes from a view of an index definition. A provided table travels on the schema an operation composes under (`DynamoSchema.shardTables`, internal, keyed by the index's `IndexShards`), read through one resolver, `KeyComposer.shardTableOf`; definition identity and every lookup by it are unchanged (§2.4, §5, §10.4) | review |
| D37 | Review F8, **accepted**: `layouts?: never` / `count?: never; previous?: never` make the mixed forms compile errors; `of()` puts `Entity.make`'s `never`-mapping guard on its parameter, with typo and extra-key `@ts-expect-error` cases (§2.1, §10.3, §16.9) | review |
| D38 | Review F10, **accepted**: the playground renders the placeholder marker for a provided index on its write-key preview too (§13) | review |
| D39 | Review F9, **accepted, strict**: a member without `shards` and a member with a table never agree (`EDD-9103`), `{ default: 1 }` included: their rules differ, and the unsharded one can't follow a value that moves (§11) | review |
| D40 | Review F11, **accepted**: a deferred query's resolution runs inside the `orRefusal` wrapper, so a key-text refusal is a `ValidationError` at the terminal, and `explain` reports the refused `empty` plan; `EDD-9181` stays a defect (§6.2) | review |

## 20. Implementation order

1. This design and the registry rows.
2. Schema: the `shards` union, `normalizeShards`, `bindShards`, the type guard, `ShardTable` and the
   text index, `composedShardMarker` / `composeReadPartitions` / `composeStoredPk` /
   `isCurrentShardLayout`, `assertCollectionShardsAgreement`, `shardForm`, `ShardLayouts`; unit, golden
   and type tests.
3. Runtime: `_schemaNow` and the sites of §5 (cascade targets before the write), `capturedServices`, `DynamoClient.make` at bind, deferred
   queries, `state.sharded`, `explain().shards`, collections, `rekey`; request-capture fixture from
   `9ec9bb63`; unit and connected tests.
4. Language service and playground.
5. Guide, example regions, API reference, DESIGN.md, CLAUDE.md, changeset.
