# Design: stream index projection, two index-definition fixes, and ULID event ids

**Issue:** follow-on to [#144](https://github.com/jmenga/effect-dynamodb/issues/144) (item 5 of the #145 review; §11 #21 of `eventstore-event-metadata.md`)
**Status:** Designed → implemented in #145 (single-PR workflow).
**Affected packages:** `packages/effect-dynamodb` (EventStore, Query, Batch, Table, Entity, new
`internal/Hydrate.ts`), docs. `@effect-dynamodb/schema`, geo and the language service are unchanged.
**Semver impact:** `minor` (lockstep). Additive at runtime, except one new definition-time refusal (§6).
Ships in 1.25.0 with #145; the changelog entries are edited by hand under the existing `## 1.25.0`
headings (§10).

> Line numbers are as of 2026-10-10, re-read after the #144 write-limit commits (`9211d62`). Symbols are
> named alongside them, because `EventStore.ts` and `Entity.ts` are still being edited in this worktree.

---

## 1. Executive summary

Every stream index projects `ALL`. `EventStore.indexDefinitions` emits `{ ProjectionType: "ALL" }`
(`EventStore.ts:2938`), and the JSDoc requires it (`:523`, `:2866`). Since #144, an event's `metadata`
can be its largest attribute, and `ALL` copies it into every index the event appears in.

This PR adds three things.

1. **A `projection` option on each stream index** (§2–§5):
   `makeStream({ indexes: { name: { …, projection } } })`, with values `"all" | "withoutMetadata" | "keys"`
   and default `"all"`.
   - **`withoutMetadata`** emits `INCLUDE` of every event attribute except `metadata`. It is read with
     one query, and its type says `metadata` is `undefined`.
   - **`keys`** emits `INCLUDE` of `__edd_e__` only. An LSI is read with `Select: ALL_ATTRIBUTES`, so
     DynamoDB fetches each event from the table. A GSI is read with a query followed by `BatchGetItem`
     hydration. `query.index` hydrates the same way.
   - Two streams that share a physical index with different projections are refused by
     `indexDefinitions`.
   - A decode failure caused by a deployed index projecting less than declared is diagnosed into a
     `ValidationError` naming the index.
2. **Two pre-existing bugs found while designing this** (§6):
   - **C1.** `Table.make` / `Table.definition` silently keep the first of two conflicting declarations of
     one physical secondary index. This PR refuses the conflict with `[EDD-9069]`.
   - **C2.** The entity ref cascade reads `item.pk` / `item.sk` instead of the target entity's primary-key
     fields. This PR reads the configured fields.
3. **ULID event ids in the docs** (§7). Examples mint event ids with Effect's `Crypto` service
   (`crypto.randomULID`) and validate them with `Schema.isULID()`.

**Out of scope:** entity index projection. It becomes its own issue; the body is drafted alongside this
work (§11 #2).

The default stays `ALL`, and the library migrates nothing. The declared projection must match the
deployed index, including tables deployed with CDK or Terraform (§5.3).

```ts
indexes: {
  // LSI: no metadata copy; one query; StreamEvent.metadata is typed undefined
  byInnings: { index: "lsi1", sk: "lsi1sk", key, projection: "withoutMetadata" },
  // GSI: smallest entries; read as a query, then BatchGetItem for the full events
  byRuns: { type: "gsi", index: "gsi1", pk: "gsi1pk", sk: "gsi1sk", key, projection: "keys" },
}
```

---

## 2. Context

### 2.1 What `ALL` costs a stream index

| Cost | `all` | `withoutMetadata` | `keys` |
|---|---|---|---|
| Write units per index | The full event: 1 WCU per KB | The event minus `metadata` | Keys plus `__edd_e__`: 1 WCU |
| Storage per index entry | Duplicates the event | Event minus `metadata` | A few hundred bytes |
| LSI 10 GB item-collection cap (counts table items **and** LSI entries) | An LSI halves each partition's headroom | Less | Negligible |
| Read | One query | One query | LSI: one query, but DynamoDB reads each event from the table. GSI: one query plus `BatchGetItem` (§3.3). Each fetched event costs a table read rounded up to 4 KB. |

Example: an event with 2 KB of data and 6 KB of metadata costs about 8 WCU for the table write.
- `all` adds 8 WCU per index.
- `withoutMetadata` adds 2–3 WCU per index.
- `keys` adds 1 WCU per index.

The sub-stream an index serves, events ordered by a derived key, rarely needs the metadata.

### 2.2 DynamoDB behaviour, measured

Measured on DynamoDB Local 3.1.0 (`localhost:8000`) on 2026-10-10 with throwaway tables. Rows marked
**†** were re-measured for this revision against `INCLUDE ["__edd_e__"]` indexes.

| # | Request | Result |
|---|---|---|
| 1 | Query a `KEYS_ONLY` or `INCLUDE` index (GSI **or LSI**) with a `FilterExpression` on an unprojected attribute, even with `Select: ALL_ATTRIBUTES` on an LSI | `ValidationException`: "Secondary index X does not project one or more filter attributes: [a]" |
| 2 | `Select: COUNT` with such a filter | as #1 |
| 3 † | `INCLUDE ["__edd_e__"]` LSI, `Select: ALL_ATTRIBUTES`, `ConsistentRead`, filter `__edd_e__ IN (:e)` | full items fetched from the table. Consumed: table 3 CU + index 1 CU for 3 items |
| 4 † | The same LSI, default select, same filter | rows carry `pk`, `sk`, the LSI key and `__edd_e__`; 0.5 CU |
| 5 † | The same LSI and GSI, `Select: COUNT` + `__edd_e__` filter | count returned; 0.5 CU |
| 6 † | The same LSI, `ProjectionExpression` naming `data` + `__edd_e__` filter | `data` fetched from the table |
| 7 † | `INCLUDE ["__edd_e__"]` GSI, default select, `__edd_e__` filter | rows carry `pk`, `sk`, the GSI keys and `__edd_e__` |
| 8 † | `withoutMetadata` GSI, default select, `__edd_e__` filter | full envelope without `metadata` |
| 9 † | `withoutMetadata` GSI, `ProjectionExpression` naming `metadata` | "Global secondary index X does not project [metadata]" |
| 10 † | `INCLUDE ["__edd_e__"]` GSI, filter on `data` | as #1, naming `[data]` |
| 11 | Non-`ALL` GSI with `Select: ALL_ATTRIBUTES` | "Select type ALL_ATTRIBUTES is not supported for global secondary index X because its projection type is not ALL" |
| 12 | LSI with `Select: ALL_ATTRIBUTES` and a `ProjectionExpression` | "Cannot specify the ProjectionExpression when choosing to get ALL_ATTRIBUTES" |
| 13 | `CreateTable` with `INCLUDE` and no `NonKeyAttributes`; with `KEYS_ONLY` and `NonKeyAttributes`; with duplicate names | each rejected |
| 14 | 101 `NonKeyAttributes` on one table, summed across indexes | rejected. Local's message ("No more than 20 attributes per table can be projected into Local Secondary Indices") is wrong on both counts. |
| 15 | A key attribute in `NonKeyAttributes` | accepted by Local; AWS behaviour unverified, so the library never emits one |
| 16 | `UpdateTable` changing an existing GSI's projection | Local: `InternalFailure`. AWS: not supported; the GSI must be deleted and created again. |

**Why `keys` is `INCLUDE ["__edd_e__"]`, not `KEYS_ONLY`.** Every library query sends the ownership
filter `#eddE IN (:et0)` (`Query.ts:621`, `buildFilterClauses`). Against a `KEYS_ONLY` index, rows #1–2
reject every read, `count` included.

Projecting `__edd_e__` (rows #3–7) has three effects:
- the read path keeps its ownership filter unchanged;
- no `ignoreOwnership` / ownership-by-key path is needed;
- one code path serves LSI and GSI.

The cost is the discriminator string in each entry, a few dozen bytes. The name `keys` describes intent,
"an index of keys": the docs state the exact `INCLUDE`.

---

## 3. Stream index projection

### 3.1 Option and validation

```ts
export type StreamIndexProjection = "all" | "withoutMetadata" | "keys"

export interface LocalStreamIndexConfig<TEvent> {
  // … existing members (EventStore.ts:525-532)
  /**
   * What the index copies from each event. Default "all". Must match the deployed index — see
   * indexDefinitions for the exact Projection each value emits.
   */
  readonly projection?: StreamIndexProjection | undefined
}
// GlobalStreamIndexConfig (EventStore.ts:552-558) gains the same member.

export interface StreamIndexSettings {
  readonly type: "lsi" | "gsi"
  readonly index: string
  readonly pk: string
  readonly sk: string
  readonly projection: StreamIndexProjection // resolved; "all" when omitted
}
```

- `resolveStreamIndexes` (`EventStore.ts:698`) refuses any other value with `[EDD-9063]`, the code for a
  malformed entry: `index "byRuns": projection must be "all", "withoutMetadata" or "keys"; received …`.
- `ResolvedStreamIndex` carries the resolved value, and so does `indexSettings` (`:1360-1362`).
- `withoutMetadata` on a stream without a metadata schema is allowed. Events can carry untyped metadata
  written outside the typed API, and the option is harmless.

### 3.2 `indexDefinitions`

| `projection` | Emitted `Projection` |
|---|---|
| `"all"` | `{ ProjectionType: "ALL" }` (unchanged) |
| `"withoutMetadata"` | `{ ProjectionType: "INCLUDE", NonKeyAttributes: ["__edd_e__", "data", "eventType", "streamId", "timestamp", "version"] }` |
| `"keys"` | `{ ProjectionType: "INCLUDE", NonKeyAttributes: ["__edd_e__"] }` |

**The `withoutMetadata` list** is every attribute `append` writes on an event item except `metadata`.
The item is built at `EventStore.ts:1906-1928` with `pk`, `sk`, `__edd_e__`, `streamId`, `version`,
`eventType`, `data`, `timestamp`, optional `metadata`, and the index attributes. The list leaves out:
- `pk` and `sk`: table keys are always projected;
- the index's own key attributes: always projected, and Local accepting them is not evidence AWS does
  (§2.2 #15);
- other indexes' attributes.

`__edd_e__` is required by the ownership filter (§2.2).

Both lists are sorted. They derive from one constant, `EVENT_ITEM_ATTRIBUTES` (the envelope, `data` and
`__edd_e__`), which `append` also builds its item from. A unit test asserts that an appended event's
attribute names equal `pk`, `sk`, that constant, `metadata` and the index attributes. A future envelope
attribute then cannot silently fall out of `withoutMetadata` indexes.

**Conflict.** Two streams sharing a physical index with different projections fail with `[EDD-9067]`.
This extends the existing type/key comparison (`EventStore.ts:2912-2923`), and the message names both
projections: `defined as gsi (pk "gsi1pk", sk "gsi1sk", projection "keys") by … and as … projection "all" by …`.
Within one stream, two indexes already cannot share a physical index (`[EDD-9065]`).

**Types.** `StreamIndexDefinitions` (`:2843-2848`) currently reuses `Table.GlobalSecondaryIndex` /
`LocalSecondaryIndex`, whose `Projection` is the literal `ALL`. It gets its own element types instead:

```ts
export type StreamIndexProjectionDefinition =
  | { readonly ProjectionType: "ALL" }
  | { readonly ProjectionType: "INCLUDE"; readonly NonKeyAttributes: Array<string> } // mutable, for SDK assignability
export interface StreamLocalSecondaryIndex { readonly IndexName: string; readonly KeySchema: Array<KeySchemaElement>; readonly Projection: StreamIndexProjectionDefinition }
export interface StreamGlobalSecondaryIndex { /* same shape */ }
```

`Table`'s types keep their `ALL` literal, because entity projection is out (§11 #3).

### 3.3 Read paths

`buildIndexQuery` (`EventStore.ts:2517-2544`) chooses the path from the index's projection.
`readIndex` (`:2546-2580`) and `query.index` keep sharing it.

| Projection | Index | Requests | Ownership | Decode |
|---|---|---|---|---|
| `all` | LSI / GSI | one `Query` (unchanged) | `__edd_e__` filter | unchanged |
| `withoutMetadata` | LSI / GSI | one `Query` | `__edd_e__` filter (projected) | `metadata` forced to `undefined` |
| `keys` | LSI | one `Query` with `Select: ALL_ATTRIBUTES` | `__edd_e__` filter (projected) | the full event, fetched by DynamoDB |
| `keys` | GSI | `Query` (index rows) → `BatchGetItem` on `(pk, sk)` | `__edd_e__` filter on the query; `__edd_e__` re-checked on each fetched item | the full event |

- **`withoutMetadata` ignores `raw.metadata`.** If the deployed index is wider than declared (`ALL`),
  the rows still carry `metadata`. The decoder drops it, so the runtime value always matches the
  `metadata: undefined` type.
- **`keys` on an LSI.** `consistentRead` applies to the fetch too (§2.2 #3). Each event costs a table
  read rounded up to 4 KB. `limit` bounds the rows DynamoDB fetches, as it bounds rows read.
- **`keys` on a GSI.** `consistentRead` stays refused before sending (`Query.ts` `prepared`, unchanged).

#### 3.3.1 GSI hydration (`internal/Hydrate.ts`, new)

Applied once per page, after the index query:

1. Take the rows the page's `take` window keeps (`Query.ts:1051-1054` in `execute`, `:1178-1181` in
   `pageStream`), minus excluded rows. Rows past the window are never fetched. With a client predicate
   (`Query.filterBy`) the window is the whole page, as it is for decoding today.
2. Fetch those rows' `(pk, sk)` with `BatchGetItem` in chunks of 100, eventually consistent.
   `UnprocessedKeys` are retried with `Batch.get`'s backoff (`Batch.ts:46-47`, `MAX_RETRIES = 5`,
   `BASE_DELAY_MS = 100`, doubling). When retries run out, fail with the same `DynamoError`
   (`operation: "BatchGetItem"`, "Unprocessed keys remain after 5 retries").
3. Re-read any key missing from the responses once, with `ConsistentRead: true`. This covers an
   eventually consistent table read lagging an index that already holds the entry. It costs nothing
   unless a key is missing.
4. Reassemble **in index order**, matching by `(pk, sk)` through a `Map`, because `BatchGetItem` does
   not preserve order. A key still missing is dropped as an excluded row. Events are never deleted by
   the library, so this only follows an external delete. `limit` reads on, and the cursor is rebuilt
   from the last kept **index** row (`cursorFromItem(returned[stoppedAt])`). Paging is therefore
   unchanged.
5. Check `__edd_e__ === <stream>.event` on each fetched item. A mismatch is a defect: the index row
   passed the same filter.
6. Decode as today.

Events are immutable, so a fetched event never differs from what its index entry referred to. No
drift check is needed, unlike for mutable entities (entity issue, §11 #2).

**The helper.** It takes `ReadonlyArray<{ tableName, key }>` and returns the raw items in input order
(`undefined` when missing). It accepts an optional `ProjectionExpression` and its names (§3.4). It
sends keys as given and never de-duplicates them: a page of one stream's index never repeats a key,
and a repeated key in `Batch.get` keeps failing with DynamoDB's "Provided list of item keys contains
duplicates" rejection, as it always has.

**`Batch.get` (`Batch.ts:91-226`) is refactored onto the helper.** Today it chunks, retries and matches
the same way, but matches responses with an O(n²) `chunk.find` (`:178-185`). After the refactor:
- it gets the `Map` match;
- its public behaviour (results by position, the same `DynamoError` after retries, `BatchRetryConfig`
  honoured) and its tests are unchanged.

This is adjacent debt (§11 #9).

### 3.4 `query.index` on a `keys` index: hydrate, do not refuse

A `Query` descriptor's `decoder` runs per row with `R = never`, so it cannot issue `BatchGetItem`
itself. But every terminal that reads items holds `DynamoClient` and the resolved table name:
- `execute` (`Query.ts:1009`);
- `pageStream` (`:1134`), behind `paginate` and `collect`.

`QueryState` already carries per-terminal hooks of this kind (`prepare`, `keepRow`, `:101-103`). It
gains one more:

```ts
/** @internal How a terminal obtains full items for an index that does not project them. */
export type QueryHydration =
  | { readonly _tag: "Fetch" }                                      // LSI: Select ALL_ATTRIBUTES
  | { readonly _tag: "BatchGet"; readonly tableKey: readonly [string, string] } // GSI: §3.3.1 per page
```

`Query.make` accepts it as an optional config member (default `undefined`), and every combinator keeps
it.

| Terminal / combinator | `Fetch` (LSI) | `BatchGet` (GSI) |
|---|---|---|
| `execute`, `paginate`, `collect` | `buildDynamoCommand` adds `Select: "ALL_ATTRIBUTES"` when no `ProjectionExpression` is sent | §3.3.1 between `isExcludedRow` and `state.decoder` |
| `count` | `Select: "COUNT"` (the override wins); never fetches | `Select: "COUNT"`; never hydrates |
| `Query.select` | `ProjectionExpression` **instead of** `Select` (both together are rejected, §2.2 #12); the LSI fetches the named attributes (§2.2 #6) | The index query sends no `ProjectionExpression`. The selection, plus `pk` / `sk` for matching (stripped unless selected), moves onto the `BatchGetItem`. |
| `Query.filter` | Reaches DynamoDB. A filter on anything but `__edd_e__` and the keys is rejected (§2.2 #1, #10), and DynamoDB's error passes through. Use `Query.filterBy`. | same |
| `Query.asParams` | Shows the `Query` with `Select` | Shows the index `Query`; the JSDoc notes the follow-up `BatchGetItem` |

`buildIndexQuery` sets `hydration` only for `keys` indexes: `Fetch` for an LSI, and `BatchGet` with
`tableKey: ["pk", "sk"]` for a GSI. Nothing else in the library sets it, so entity queries are
untouched.

### 3.5 Types

`readIndex` and `query.index` type `metadata` as `undefined` for a `withoutMetadata` index, by name.
The `metadata` property stays, so `StreamEvent` keeps one shape.

```ts
type IndexEventMetadata<TMetadata, P extends StreamIndexProjection> =
  [P] extends ["withoutMetadata"] ? undefined : StreamMetadata<TMetadata>

readIndex<const N extends TIndexName>(
  name: N,
  streamId: StreamIdInput<TStreamIdFields>,
  options?: ReadIndexOptions | undefined,
): Effect.Effect<
  ReadonlyArray<StreamEvent<TEvent, IndexEventMetadata<TMetadata, TIndexProjections[N]>>>,
  DynamoClientError | ValidationError,
  DynamoClient | TableConfig
>
```

- **`EventStream` and `BoundEventStream`** (`:940-946`, `:2654-2660`) gain a trailing, defaulted
  parameter: `TIndexProjections extends { readonly [K in TIndexName]: StreamIndexProjection } = { readonly [K in TIndexName]: "all" }`.
- A name typed as a union (`"a" | "b"`) yields the union of the two metadata types.
- **`makeStream` inference.** It currently infers `const TIndexName extends string` from the keys of a
  mapped `indexes` type (`EventStore.ts:1267-1286`). That cannot also carry per-entry projections. It
  becomes:

```ts
const TIndexes extends { readonly [K in keyof TIndexes]: StreamIndexConfig<Schema.Schema.Type<TEvents[number]>> } = {}
// config: readonly indexes?: TIndexes & { readonly [K in keyof TIndexes]: StreamIndexConfig<…> }
// TIndexName        = keyof TIndexes & string
// TIndexProjections = { readonly [K in keyof TIndexes & string]: ProjectionOf<TIndexes[K]> }
type ProjectionOf<C> = C extends { readonly projection: infer P extends StreamIndexProjection } ? P : "all"
```

**Probed** with TypeScript 6.0.3 (the repo's) and `strict` + `exactOptionalPropertyTypes`, with events
supplied as an array of schema-like carriers, as `makeStream` receives them:
- `key`'s `(event, version)` stays contextually typed (an unknown property on `event` is an error);
- `projection` literals are inferred per entry, and an omitted one yields `"all"`;
- an undeclared name is an error, and a stream without `indexes` accepts no name;
- a bad literal (`"include"`) is an error.

Two alternatives failed the probe:
- a bare `const TIndexes extends Record<string, StreamIndexConfig<E>>` lost the contextual type of
  `key`;
- a second mapped parameter inferred beside `TIndexName` did not infer the projections.

The type tests (§8.3) pin the chosen shape.

---

## 4. Read-failure diagnosis (decision E)

The #144 standard applies to reads: no pre-checks; on failure, recognise → confirm → attribute →
rewrite, with the original error kept as the cause; anything unconfirmed passes through. For stream
reads, only the **decode** case is small and self-contained, so only it is implemented.

**In: decode failure through a non-hydrated index.** Under `all` or `withoutMetadata`, the
`buildIndexQuery` decoder wraps `decodeStreamEvent` (`EventStore.ts:1473`). On its `ValidationError`
only:

1. **Recognise:** the decode failed for a row read through index X.
2. **Confirm:** the raw row lacks at least one attribute the *declared* projection guarantees (`streamId`,
   `version`, `eventType`, `data`, `timestamp`). This is measured on the row itself. The `__edd_e__`
   filter already proved the row is this stream's event, so a missing envelope attribute means the
   deployed index projects less than declared (or the item was written outside the library).
3. **Rewrite:** `new ValidationError({ entityType, operation: "EventStore.index.decode", cause: withCause(message, original) })`,
   reusing `withCause` from `internal/WriteDiagnosis.ts:501`. The message reads: *stream index "byRuns"
   (physical "gsi1") is declared `projection: "withoutMetadata"`, but its rows lack data, eventType: the
   deployed index likely projects less than declared. Deploy the `Projection` `EventStore.indexDefinitions`
   emits.*

A failure that does not confirm, such as a corrupt `data` that is present but invalid, passes through
unchanged. Nothing is measured on success. `keys` reads decode items fetched from the table, so a
missing attribute there is not a projection problem, and those failures pass through.

**Out, documented instead** (§11 #12–#14):

- **DynamoDB's filter rejection.** A deployment narrower than `__edd_e__`, for example `KEYS_ONLY` where
  `keys` was declared, makes DynamoDB reject every read with "Secondary index gsi1 does not project one
  or more filter attributes: [__edd_e__]". That message already names the index and the attribute.
  Rewriting it would need an error hook in three `Query` terminals (`execute`, `pageStream`, `count`),
  which is not self-contained. The guide quotes the message and says what it means.
- **`DescribeTable` confirmation.** The row-level confirmation is exact enough, and it needs no
  `dynamodb:DescribeTable` permission.
- **Silent drift no failure reveals:**
  - declared `all` but deployed `withoutMetadata` reads `metadata` as `undefined`, a legal value;
  - a deployment wider than declared works and costs more;
  - declared `keys` over an `ALL` index hydrates needlessly.

---

## 5. Limits, consistency and deployment

### 5.1 `NonKeyAttributes` budget

A table may project at most 100 `NonKeyAttributes`, summed across its indexes (§2.2 #14).
`withoutMetadata` spends 6 and `keys` spends 1, so only 17 or more `withoutMetadata` indexes on one
table reach the limit. `indexDefinitions` sees only the streams it is given, not the table's other
indexes, so it cannot count the table. No check is added: `CreateTable`, or CDK, rejects the table. The
docs state the per-index cost (§11 #15).

### 5.2 Consistency

| Index | `consistentRead: true` |
|---|---|
| LSI, any projection | honoured; under `keys` the table fetch is consistent too |
| GSI, any projection | refused before sending (unchanged) |
| GSI `keys` hydration | eventually consistent `BatchGetItem`, with a consistent re-read of missing keys only (§3.3.1 step 3) |

### 5.3 Deployed tables: no migration

- **LSI:** the projection is fixed when the table is created. Changing it means a new table.
- **GSI:** the projection cannot be updated (§2.2 #16). Changing it means deleting the GSI and creating
  it again; the index is unavailable during the backfill, and the backfill consumes write capacity.
- The library issues neither change. `indexDefinitions` describes a **new** index.
- **The declared projection must match the deployed one.** CDK and Terraform users copy `Projection`
  from `indexDefinitions` output. In particular, `keys` is `INCLUDE ["__edd_e__"]`, **not `KEYS_ONLY`**.
  The JSDoc of `projection` and `indexDefinitions`, and the tutorial, carry this caveat and §4's failure
  table.

---

## 6. Bug fixes

### 6.1 C1: conflicting declarations of one physical secondary index

**Evidence.** `Table.definition` (`Table.ts:479-675`) collects secondary indexes into `gsiMap` /
`lsiMap` (`:502-503`). Every insertion is guarded by `!gsiMap.has(…) && !lsiMap.has(…)`:
- aggregate collection index as LSI, `:531-532`;
- aggregate collection index as GSI, `:535-536`;
- aggregate list index, `:545-546`;
- entity indexes, including the auto-generated `_cascade_<field>` indexes, `:568-569`.

The first declarer of a physical name wins, and a later declarer with different key attributes, or
another LSI/GSI classification, is skipped silently. The table is created keyed on the first
declarer's attributes. The losing declarer still writes its own key attributes, so its items never
appear in that index, and its queries return nothing.

Vector indexes refuse disagreement (`mergeVectorIndexes`, `Table.ts:217-306`, `[EDD-9035]`), and so do
stream indexes (`indexDefinitions`, `[EDD-9067]`). Ordinary secondary indexes do not. `Table.make`
(`:145-197`) validates only vector indexes (`:170`).

**Fix.** A new `mergeSecondaryIndexes(entities, aggregates, primary)`, modelled on `mergeVectorIndexes`,
returns `Map<physicalName, { kind: "gsi" | "lsi"; pk: string; sk: string; owner: string }>`.

- **Declarers** are the same as today:
  - every non-primary entity index (cascade indexes included);
  - an aggregate's `collection.index`, an LSI when `agg.pkField` equals the table's primary PK and a GSI
    otherwise (unchanged rule);
  - an aggregate's `list.index` (a GSI).
- **Refusal** is `[EDD-9069]`, thrown, naming both declarers and both shapes:
  `Secondary index "gsi1" is declared as a GSI keyed (gsi1pk, gsi1sk) by entity "Task" and as a GSI keyed (gsi2pk, gsi2sk) by aggregate "Match" (list index). One physical index has one key schema: every member declaring it must agree.`
- **`Table.make`** runs it beside `validateSharedVectorIndexes` (`:170`). CDK and Terraform users who never
  call `Table.definition` still get the error at definition time. When no entity declares a primary key
  (an aggregates-only table), classification is unknown, so only `pk` / `sk` are compared;
  `Table.definition` refuses such a table anyway (`:493-495`).
- **`Table.definition`** consumes the map in place of the first-wins maps. Its output for agreeing
  declarations is unchanged.
- **`DynamoClient.make`** derives each bound table's definition eagerly (`DynamoClient.ts:1835`), including
  aggregates passed to `make` but not registered on `Table.make` (`:1725-1747`). A conflict that only
  those aggregates introduce therefore surfaces there as a defect, as a vector-index conflict does today.
  This is documented, not changed.
- **Also refused in the same pass:** entities on one table that disagree on the primary key's
  `pk.field` / `sk.field`. `resolvePrimaryKey` (`Table.ts:447-457`) silently takes the first entity's
  primary key, and every other entity's writes then lack the table's key attributes. No fixture declares
  a primary key other than `pk` / `sk`, so nothing existing trips it (§11 #7: confirmed by user).

**Changelog (behaviour change).** A table whose members declare one physical index with different key
attributes or classification, or different primary-key fields, used to construct and failed only at
read time (an empty index) or write time. It now fails at `Table.make` / `Table.definition` with
`[EDD-9069]`.

### 6.2 C2: cascade hard-codes the table key names

**Evidence.** `executeCascade` (`Entity.ts:4747`) queries each target's cascade GSI, then builds each
update's key as `{ pk: item.pk!, sk: item.sk! }` (`:4856`). Its write diagnosis assumes the same names:
`targetsFor(cascadeItems, ["pk", "sk"], …)` and `rangeKeys: () => ["sk"]` in transactional mode
(`:4891`, `:4897`), and the same pair in eventual mode (`:4935`, `:4940`).

A target entity whose primary key uses other fields, such as `PK` / `SK`, gets updates with no value for
its table's key attributes. Measured on Local: `UpdateItem` with
`Key: { pk: undefined, sk: undefined }` on a table keyed `PK` / `SK` fails with `ValidationException`:
"The number of conditions on the keys is invalid".
- In eventual mode, every update fails, giving a `CascadePartialFailure` with `succeeded: 0`.
- In transactional mode, the transaction is rejected whole.
- Write diagnosis also could not attribute an oversized update, because it looked for the wrong
  attributes.

Every existing fixture uses `pk` / `sk`, which is why this was never caught.

**Fix.**
- Each `allUpdateOps` entry records its target's `keyFields = [primary.pk.field, primary.sk.field]`
  (`target.indexes.primary`, available on `CascadeTarget`, `internal/EntityOps.ts:101-112`). The key is
  read from the query row by those names.
- Transactional mode maps each entry through `transactItemTarget` with its own `keyFields`, because one
  cascade can span targets with different key fields. Its `rangeKeys` is the distinct set of the targets'
  `sk` fields.
- Eventual mode uses the op's own `keyFields` and `sk` field.

---

## 7. ULID event ids in the docs (decision D)

The #144 docs mint event ids by hand (`evt-<millis>-<entropy>`, `examples/event-sourcing.ts:959-963`) or
with an undefined `ulid()` (`EventStore.ts:3989`; `eventstore-event-metadata.md` §1, §2.1, §4.1). They
switch to Effect's `Crypto` service:

```ts
const crypto = yield* Crypto.Crypto
yield* handleAudited({ matchId: "m-22" }, command, {
  eventMetadata: ({ events }) =>
    Effect.forEach(events, () =>
      Effect.map(crypto.randomULID, (eventId) => ({ correlationId: "req-5d0e", eventId })),
    ),
})
```

- **Schema.** `AuditMetadata.eventId` becomes `Schema.optionalKey(Schema.String.check(Schema.isULID()))`.
  `sourceId`, an id from a previous store, stays `Schema.String`.
- **Prose.** It says `crypto.randomUUIDv7` works the same when a standard UUID is needed. It also
  explains determinism: a ULID takes its time from `Clock` and its 80 random bits from the `Crypto`
  service, so `TestClock` plus a test `Crypto` layer with fixed bytes make it deterministic. This replaces
  the "Clock and Random" note.
- **A `Crypto` layer.** Effect core provides no default `Crypto` service. `DynamoClient.make` bundles one
  only for its own bound operations (`schema/src/internal/DefaultCrypto.ts`), and it is not exported. The
  example therefore builds one, in a new `crypto-layer` region merged into `AppLayer`:
  `Layer.succeed(Crypto.Crypto, Crypto.make({ randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)), digest }))`.
  `digest` uses `Effect.tryPromise` over `crypto.subtle.digest`, mapped to `PlatformError.badArgument`,
  as `DefaultCrypto.ts` does. No `process` is involved.
- **Redelivery.** The handler region's second half derives ids from a delivery id
  (`` `${deliveryId}:${version + i + 1}` ``). That id is not a ULID, so it would fail the new check. It is
  replaced by the library's own answer to redelivery: an idempotent handler called with
  `commandId: deliveryId`. A redelivered command fails with `DuplicateCommand`, and the first commit's
  ULIDs stand (§11 #18: confirmed by user). `eventstore-event-metadata.md` §4.3 is updated to match.
- **Tests.**
  - One new unit test in `test/EventStore.test.ts` runs the documented handler pattern under `TestClock`
    with a test `Crypto` layer (`randomBytes` returns fixed bytes) and asserts the exact ULIDs written.
    This is the "deterministic" claim, pinned.
  - Existing tests that pass literal ids (`"e-1"`, `"ev-1"`) test pairing, not minting, and stay as
    they are.
- **Not changed:** `ulid()` for *entity* ids in `tutorials/gamemanager.mdx` and `DESIGN.md:415`. They
  are not event ids (§11 #19).

---

## 8. Testing

### 8.1 Unit

- **`indexDefinitions`:**
  - the three projections on an LSI and a GSI;
  - the exact `withoutMetadata` and `keys` lists;
  - an appended event's attribute names equal `pk`, `sk`, `EVENT_ITEM_ATTRIBUTES`, `metadata` and the
    index attributes;
  - `[EDD-9067]` on a projection conflict between two streams;
  - `[EDD-9063]` on a bad literal;
  - a hand-built settings object without `projection` is read as `"all"`.
- **`readIndex` / `query.index`** (mock `DynamoClient`):
  - `withoutMetadata`: one query, the ownership filter is sent, and `metadata` is `undefined` even when
    the mock row carries it.
  - `keys` LSI: `Select: "ALL_ATTRIBUTES"` with the ownership filter; `Query.select` sends
    `ProjectionExpression` and no `Select`; `count` sends `Select: "COUNT"`.
  - `keys` GSI:
    - `BatchGetItem` in chunks of 100 for 250 rows;
    - `UnprocessedKeys` retried, and `DynamoError` after 5 retries;
    - index order kept when the mock answers out of order;
    - a missing key re-read with `ConsistentRead: true`, then dropped;
    - `limit` hydrates only the window, and the cursor resumes after the last kept row;
    - `count` makes no `BatchGetItem` call;
    - `Query.select` moves the projection onto `BatchGetItem` and strips `pk` / `sk`;
    - a fetched item with a foreign `__edd_e__` is a defect.
  - Decode diagnosis:
    - rows lacking `data` under a declared `all` and a declared `withoutMetadata` give
      `operation: "EventStore.index.decode"`, a message naming the index, and the original error as
      `cause`;
    - an invalid but present `data` passes through unchanged;
    - a `keys` read's decode failure passes through.
- **`Batch.get`** refactored onto the helper: its existing tests stay green, plus one out-of-order
  response test.
- **C1 (`test/Table.test.ts`):**
  - entity against entity with different `sk.field`;
  - entity against aggregate list index;
  - entity GSI against aggregate collection LSI of the same name;
  - a cascade index against an entity index;
  - primary-key disagreement;
  - agreeing sharers unchanged;
  - both `Table.make` and `Table.definition` throw `[EDD-9069]`.
- **C2 (`test/Entity.test.ts`):** cascade to a target keyed `PK` / `SK`, in eventual and transactional
  modes, sends updates keyed `PK` / `SK`; a mixed-target transactional cascade attributes each entry
  with its own fields.
- **D:** the deterministic-ULID handler test (§7).
- **Canonical GSI-composite shapes.** The key composer is untouched, and no write path composes keys
  differently, so the shape matrix in CLAUDE.md does not apply. C1 compares only key attribute names,
  and C2 reads names, not composed values.

### 8.2 Connected (`test/connected.test.ts`; mandatory, gate 4)

- **Streams.** Tables created from `indexDefinitions` output, one per index type (LSI, GSI) ×
  projection (`withoutMetadata`, `keys`); `all` is already covered.
  - Append events with `eventMetadata`, then `readIndex` and `query.index`:
    - `withoutMetadata` returns events without metadata;
    - `keys` returns full events, metadata included, in index order;
    - `beginsWith`, `between`, `reverse` and `limit` work in every mode;
    - `count` works.
  - `DescribeTable` shows the emitted `Projection`.
  - A `keys` GSI read across more than 100 events (two `BatchGetItem` chunks).
- **Drift:**
  - declare `withoutMetadata`, create the index `INCLUDE ["__edd_e__"]` by hand: the diagnosed
    `ValidationError`;
  - declare `keys`, create it `KEYS_ONLY`: DynamoDB's filter rejection passes through, pinning Local's
    wording.
- **C2:** a ref cascade to a target entity on a table keyed `PK` / `SK`, in both modes, updates the
  embedded ref.
- **C1** is definition-time only; it needs no connected test.

### 8.3 Types (`test/EventStore.types.test.ts`)

- `readIndex("byInnings", …)` on a `withoutMetadata` index yields `metadata: undefined`; on `all` and
  `keys` it yields `StreamMetadata<M>`; a union name yields the union.
- `query.index` mirrors `readIndex`.
- `key`'s `event` parameter stays contextually typed with `projection` present and absent.
- An omitted `projection` infers `"all"`; a bad literal and an undeclared name are errors.
- A stream without `indexes` accepts no name.
- `BoundEventStream` mirrors all of the above.

### 8.4 Other gates

`pnpm lint`, `pnpm check`, `pnpm test`, doctest sync (`pnpm --filter @effect-dynamodb/doctest test`),
and `npx tsx examples/event-sourcing.ts` against Local.

---

## 9. Semver and compatibility

`minor`. Every projection defaults to `"all"`, so existing streams behave as before. Notes for the
changelog:

- **New definition-time refusal (C1, `[EDD-9069]`).** It covers conflicting declarations of one
  physical secondary index (key attributes or LSI/GSI classification) and conflicting primary-key
  fields. Such tables used to construct and misbehave at runtime.
- **C2** changes no behaviour for `pk` / `sk` tables; it makes cascades work on other key names.
- **Types:**
  - `StreamIndexSettings` gains `projection`. `indexDefinitions` accepts it as optional, so hand-built
    settings objects keep compiling.
  - `EventStream` / `BoundEventStream` gain a trailing, defaulted type parameter.
  - `makeStream`'s index generic changes from `TIndexName` to `TIndexes`. Call sites infer it; only
    explicit type arguments to `makeStream` (unlikely) need updating.
  - `StreamIndexDefinitions`' elements become `StreamLocalSecondaryIndex` / `StreamGlobalSecondaryIndex`,
    whose `Projection` is a union. Code assigning them to `Table.GlobalSecondaryIndex` would need the new
    types.
  - `Table`'s exported index types are unchanged.

---

## 10. Documentation

Examples are written first, with region markers; the MDX follows; then doctest sync.

- **`examples/event-sourcing.ts`:**
  - **New regions:**
    - `index-projection`: an `AuditedScorecards` stream with the `AuditMetadata` schema on its own table,
      a `withoutMetadata` LSI and a `keys` GSI;
    - `index-projection-table`: `indexDefinitions` output, with the emitted `Projection` in comments;
    - `index-projection-read`: `metadata` is absent through the LSI and present through the hydrated GSI.
  - **Changed regions:**
    - `metadata-stream`: `eventId` checked by `isULID`;
    - `handler-event-metadata`: `crypto.randomULID`, plus the idempotent-handler redelivery (§7);
    - `layer-setup`: the third table name and the `Crypto` layer.
  - **New region** `crypto-layer`.
- **`tutorials/event-sourcing.mdx`:**
  - An "Index projection" subsection, placed at the end of Step 20 because its example uses Step 20's
    `AuditMetadata` (Step 19's table text links forward to it): the cost table (§2.1), the read table (§3.3),
    the deployment caveat with "`keys` is `INCLUDE ["__edd_e__"]`, not `KEYS_ONLY`" (§5.3), the
    filter-rejection message and what it means (§4), and the `NonKeyAttributes` cost per index (§5.1).
  - The text at `:1088` and `:1112` ("each projecting `ALL`" / "must be `ALL`") and at `:1372` ("always
    projecting `ALL`") changes.
  - Step 20's handler prose: ULIDs via `Crypto`, the `randomUUIDv7` alternative, determinism, and
    redelivery (§7).
- **`reference/api-reference.mdx`:**
  - the `indexDefinitions` row (`:1127`);
  - `projection` on stream indexes, with the `readIndex` typing note;
  - `[EDD-9069]`;
  - a `ValidationError` row mention of `EventStore.index.decode`.
- **DESIGN.md:**
  - "Stream Indexes (#140)" (`:3291-3296`): the "Projection `ALL`" bullet becomes §3.
  - `Table.definition` merge rules (§6.1).
  - Error registry: `EDD-9069` added, with next free `EDD-9070`.
  - Fixed in passing: the "Index Properties" table (`:448-459`) says `type` defaults to `"clustered"`,
    but the code defaults to `"isolated"` (`schema/src/KeyComposer.ts:163`); and `index` reads "GSI/LSI",
    but entity indexes are always GSIs.
- **`docs/designs/eventstore-event-metadata.md`:** the `ulid()` snippets in §1, §2.1 and §4.1 and the
  redelivery snippet in §4.3 follow §7.
- **JSDoc:**
  - `LocalStreamIndexConfig` (`EventStore.ts:523`) and `indexDefinitions` (`:2866`), "must be/stay `ALL`";
  - `projection` on both configs;
  - `QueryHydration` (internal);
  - `Table.make` / `Table.definition` (`[EDD-9069]`);
  - the `commandHandler` example (`:3989`).
- **Changelogs** (`packages/effect-dynamodb/CHANGELOG.md`, under `## 1.25.0`): stream index projection;
  `[EDD-9069]` with the behaviour-change note; the cascade key-name fix. Other packages need no entry.

---

## 11. Scoping decisions

| # | Item | Decision | Source |
|---|---|---|---|
| 1 | Stream `projection: "all" \| "withoutMetadata" \| "keys"`, a string-literal union, default `"all"` | **In** (§3.1) | user (A) |
| 2 | Entity index projection | **Out**, to become a GitHub issue. Body drafted with this work: motivation, why deferred, findings, and the entity decisions with recommendations. | user (B) |
| 3 | `Table.GlobalSecondaryIndex` / `LocalSecondaryIndex` `Projection` widening | **Not widened.** Stream fragments get their own types (§3.2), because entity projection is out | design: confirmed by user |
| 4 | `keys` emitted as `INCLUDE ["__edd_e__"]`, not `KEYS_ONLY` | **In.** Keeps the ownership filter and one read path; no ownership-by-key mode (§2.2) | user (A); probed |
| 5 | `readIndex` per mode: one query for `withoutMetadata`; LSI `Select: ALL_ATTRIBUTES`; GSI query + `BatchGetItem` with retries and index order | **In** (§3.3) | user (A) |
| 6 | `query.index` on a `keys` index | **Hydrates** through the shared `QueryState.hydration` hook (§3.4) | user (A) |
| 7 | C1: refuse conflicting physical secondary-index declarations (`[EDD-9069]`) at `Table.make` / `Table.definition` | **In** (§6.1); changelog notes the behaviour change | user (C1) |
| 7a | Same pass: refuse entities disagreeing on primary-key fields (`resolvePrimaryKey` first-wins) | **In.** Same bug class, same merge; no fixture trips it | design: **confirmed by user** |
| 8 | C2: cascade uses the target's primary-key fields, including its write-diagnosis targets and range keys | **In** (§6.2) | user (C2) |
| 9 | `Batch.get` refactored onto the hydration helper (removes the O(n²) match) | **In**: adjacent debt | design (golden rule) |
| 10 | Decode-failure diagnosis for stream index reads (`EventStore.index.decode`) | **In** (§4): self-contained in `EventStore.ts`, confirmed on the row | user (E) |
| 11 | `withoutMetadata` decoder drops `metadata` even if the index projects it | **In** (§3.3), so the runtime value matches the type | design |
| 12 | Rewriting DynamoDB's filter rejection (`does not project … [__edd_e__]`) for stream reads | **Out**: needs an error hook in three `Query` terminals, not self-contained; DynamoDB's message already names index and attribute; the guide explains it | user (E): not small |
| 13 | `DescribeTable` confirmation of a decode failure | **Out**: optional per E; the row-level check suffices and needs no extra IAM | user (E): optional |
| 14 | Detecting silent drift (declared `all`, deployed `withoutMetadata`; deployed wider) | **Out**: documented only | design |
| 15 | 100-`NonKeyAttributes` check in `indexDefinitions` | **Out**: it cannot see the whole table; it takes 17 `withoutMetadata` indexes to reach; DynamoDB / CDK rejects; docs state the cost per index | design: confirmed by user |
| 16 | Vector indexes | **Unchanged** (`ALL`; separate API, quota and limits) | user |
| 17 | D: docs examples mint event ids with `crypto.randomULID`, validated with `Schema.isULID()`; `randomUUIDv7` mentioned; example `Crypto` layer from `Crypto.make` over Web Crypto; deterministic test with `TestClock` and a test `Crypto` layer | **In** (§7) | user (D) |
| 18 | The delivery-id-derived event id example (`msg-4471:2`) | **Changed**: replaced by an idempotent handler (`commandId: deliveryId`), because a derived id is not a ULID; `eventstore-event-metadata.md` §4.3 follows | design: **confirmed by user** |
| 19 | `ulid()` for entity ids in `gamemanager.mdx` / `DESIGN.md:415` | **Unchanged**: not event ids | design |
| 20 | Existing unit / connected tests using literal event ids | **Unchanged**: they test pairing, not minting | design |
| 21 | DESIGN.md "Index Properties" inaccuracies (`type` default, "GSI/LSI") | **Fixed in passing** (§10) | design (golden rule) |
| 22 | Aggregate code hard-coding `"sk"` (`Aggregate.ts:1126`, `:1656`, `:2168-2169`, `:3362`) | **Out, reported.** Aggregates write `attrs.sk` by design (`:3145`), so this is a documented limitation (aggregate tables use `sk`), not the C2 bug | finding: your call |
| 23 | `DynamoClient.make` surfacing a C1 conflict from unregistered aggregates as a defect | **Unchanged**, documented (§6.1); matches vector-index conflicts | design |
| 24 | Language-service tooltips | **Unchanged**: they cover entity queries only | design |
| 25 | Canonical GSI-composite shapes | **Not applicable**: the key composer is untouched (§8.1) | design |
