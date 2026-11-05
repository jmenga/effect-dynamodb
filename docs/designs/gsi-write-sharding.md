# Design: GSI write sharding (#183)

**Issue:** [#183](https://github.com/jmenga/effect-dynamodb/issues/183)
**Status:** Designed and implemented in one run with nobody available to answer questions, so every
decision the owner has not confirmed is marked *proposed — awaiting owner confirmation* (§14).
Implemented in the same PR (single-PR workflow: this doc is commit 1).
**Stacked on:** #181 (1.37.0), which is open and unmerged: cursor v2, `Option` page cursors,
model-checked attribute names, adaptive request sizing and `rekey` all come from it. The PR
targets `feat/171-zorder` and must be retargeted to `main` after #181 merges.
**Builds on:** `zorder-indexes.md` §6.3 (the partition limit), §8 (request sizing), §10.3 (byte
order and cursors); v1.7.x policy-aware GSI composition (#41 / #43 / #46); #171's `rekey` and
1.36 fallback.
**Affected packages:** `packages/schema` (`KeyComposer`, new `internal/Shards`, `Entity.make`),
`packages/effect-dynamodb` (`Query`, new `internal/ShardMerge`, `internal/Cursor`,
`internal/BoundQuery`, `DynamoClient`, `Collection`, `Entity`, `Table`, `internal/Rekey`,
`internal/TransactableOps`), `packages/effect-dynamodb-geo` (rejection only),
`packages/language-service`, `packages/docs`, `packages/doctest` (no code change).
**Semver impact:** `minor`, 1.38.0 in lockstep. Purely additive for an index without `shards`:
no key text, request, cursor or result changes.

## 1. Summary

```ts
indexes: {
  byTenant: {
    name: "gsi5",
    pk: { field: "gsi5pk", composite: ["tenantId"] },
    sk: { field: "gsi5sk", composite: ["groupId", "channel", "deviceId"] },
    shards: 20, // or { count: 20, by: ["groupId"], previous: 1 }
  },
}
```

A write hashes the shard source (the item's primary key composites, or `by`) and stores the index
entry in one of N physical partitions. `byTenant({ tenantId })` reads all N and merges them into
the order one unsharded partition would give. No caller names a shard.

The design has three load-bearing parts:

1. **An unsharded key for a sharded index can't be composed** (§4). `KeyComposer.composePk` and the
   truncating composer add the marker themselves and throw when the source is missing, so every
   write path is covered without touching its call site. Reads use a separate function that
   returns the partitions; a read that still called `composePk` throws rather than reading the
   wrong partition.
2. **The marker sits before any value** (§2), so a layout's keys can never equal another layout's,
   whatever the values hold. The issue's "final segment" can't give that guarantee during migration
   (finding 3).
3. **The hash folds case** (§3), because a query input that differs only in case is the same key
   under the default `lowercase` casing and must reach the same shard (finding 1).

## 2. Key text

### 2.1 Spelling

The marker is `!<count>.<shard>`, immediately after the entity type or collection name, with the
shard zero-padded to the width of `count - 1`:

| Case | `gsi5pk` |
|---|---|
| Unsharded | `$fleet-db#v1#devicestate#tenantid_t-123` |
| Sharded, shard 7 of 20 | `$fleet-db#v1#devicestate#!20.07#tenantid_t-123` |
| Sharded, empty PK half | `$fleet-db#v1#devicestate#!20.07` |
| Sharded collection | `$fleet-db#v1#assignments#!20.07#employee_x` |
| `casing: "uppercase"` | `$FLEET-DB#V1#DEVICESTATE#!20.07#TENANTID_T-123` |

This **changes the issue's proposal** of a final segment (§15). Reasoning:

- **Partition keys aren't escaped, so no final segment can be safe.** The unsharded key for tenant
  `t-123#07` is byte-for-byte the "final segment" sharded key for tenant `t-123`, shard `07`. During
  a migration both layouts are read, so that row would be read from both or attributed to the wrong
  layout, and no spelling of a final segment fixes it, because the value is arbitrary text.
- **The fourth segment is value-free.** `KeyComposer` always passes composite names, so every
  unsharded key is `$s#v<n>#<type>` or `$s#v<n>#<type>#<label>_<value>…`. Its fourth `#`-separated
  segment, when it has one, holds `<label>_`. A marker holds no `_` and no value, so a sharded key
  can never equal an unsharded one, whatever the values spell.
- **The count in the marker separates sharded layouts.** `!20.07` and `!40.07` differ, so `previous`
  reads N + M genuinely distinct partitions and needs no foreign-row filter and no dedupe. Without
  it, a count change would put two layouts' shard 7 in one partition.
- **Casing can't reach it.** Digits, `!` and `.` have no case.

The proof assumes entity types, collection names and attribute names don't hold `#`. Those are
developer-chosen identifiers, not values, and nothing composes them from data.

Pre-existing and unchanged: partition key values stay unescaped, so `a#b` + `c` and `a` + `b#c`
can still collide *within* one layout (noted by #182).

### 2.2 Compact keys (#182): recorded, not built

#182 has no code yet. Its compact partition key would carry the same marker in the same place:

```
$1#e#!20.07#3f2b…
```

Under #182 both halves escape values with `sortKeyText`, which always escapes `!` (U+0021), so a
value can't spell the marker there either. The hash is independent of the key format (§3), so
moving to compact keys does not move an item between shards.

## 3. The shard function

```
bytes(source) = F(text(v1)) ‖ 0xFF ‖ F(text(v2)) ‖ 0xFF ‖ … ‖ F(text(vk))
text(v)       = KeyComposer.serializeValue(v), v in key form
F(s)          = s.toLowerCase().toUpperCase(), as UTF-8
shard         = FNV-1a-32(bytes(source)) mod count
```

Implemented in `packages/schema/src/internal/Shards.ts` with `Math.imul` and `TextEncoder`, so it is
runtime-agnostic. Golden vectors pin it; changing it is a breaking change. Aggregate's `hashToShard`
(djb2 over UTF-16 code units) is untouched.

- **Fixed fold, not `casing` (finding 1).** The issue requires independence from `casing`, but under
  the default `lowercase` casing `"GROUP-A"` and `"group-a"` are one key, and query inputs are
  widened through `CaseInsensitive<T>`. A literal hash would prune `byTenant({ tenantId, groupId:
  "GROUP-A" })` to a different shard from the stored `group-a`, silently missing the row. So one
  fold applies whatever `casing` says. Under `preserve` casing it merges a few values into one hash
  input, which adds a slight bias and nothing else: the marker is still deterministic, and the key
  text still distinguishes the values.
- **`U∘L`, not `L∘U`.** The required property is that every spelling the key text treats as equal
  under either casing hashes equal: `F∘toLowerCase = F` and `F∘toUpperCase = F`. `L∘U` fails it:
  `ß` and `ẞ` lowercase to the same key text `ß`, but `L∘U` maps them to `ss` and `ß`. `U∘L` maps
  both to `SS`. The property is tested over every code point plus context-sensitive cases (`ΑΣ` /
  `ασ`, `ß` / `SS` / `ẞ`, `K` / Kelvin sign, `İ`, `ı`, `ſ`). The fold depends on the runtime's Unicode
  version exactly as the key text's casing does.
- **Separator.** Byte `0xFF` never occurs in UTF-8 (a lone surrogate encodes as `EF BF BD`), so
  `("ab", "c")` and `("a", "bc")` can't share an input.
- **Same value on both sides.** Writes hash the key-form record, queries hash the pins after
  `compositeKeyForm`, the same encoding the key text uses. Dates, numbers, branded and transformed
  values therefore agree (tested).

## 4. Composition is structural (finding 6)

`normalizeGsiConfig` normalises `shards` to `{ count, by?, previous?, source }`; `Entity.make` binds
`source` (the primary key composites, PK then SK, or `by`) the way it binds a Z-order layout.

- **`composePk` and the truncating composer always compose the sharded text**, and throw
  `ShardSourceError` (`[EDD-9100]`) when a source value is absent. `composeKeysOrFail` and the other
  error boundaries turn it into a `ValidationError`, and no write is sent.
- **An index never bound to an entity throws**, as an unbound Z-order half does.
- **`composeReadPartitions`** is the only function reads use. It returns the current shards (pruned
  when every `by` attribute is pinned), then the `previous` layout's partitions, never pruned. Every
  read path calls it: `DynamoClient` accessors, `Entity.query.<index>`, `Collections`, the client's
  collection accessors and cascade reads.
- **`KeyText136` stays unsharded** (§9.3).

So the paths the issue's list omits are covered without a per-site change:

| Path | Why it is covered |
|---|---|
| `put`, `create`, `upsert`, `restore`, `Batch.write`, `Transaction.transactWrite` | `composeAllKeys` → `composeIndexKeys` → `composePk` |
| `update`, `patch`, retain path, `append`, the 1.37 move path | `composeGsiKeysForUpdatePolicyAware` (§5) |
| Soft delete, version snapshots, time-series events | They strip GSI keys; nothing is composed |
| Unique-constraint sentinels | They hold no GSI keys |
| EventStore projection rows | They go through entity operations |
| Aggregate edges | Aggregates compose only their own attributes; they never read `entity.indexes` (§11) |

## 5. The update gate (finding 2)

`by` attributes are sort key composites, and the skip predicate looks only at a half's own
composites. So an update setting only `groupId` would leave the stored shard stale: pruned queries
would then miss the item. **`by` attributes are therefore dependencies of the PK half** — but only
when the writer touches them. `keyRecord` membership doesn't count: the retain path's `keyRecord`
holds the whole item, and a default source is immutable, so neither is evidence of a change.

Definitions, over the `by` attributes only (a default source is immutable and is never a gate
dependency):

- **T**: a `by` attribute has a value in the payload.
- **N**: a `by` attribute is `null` / `undefined` in the payload.
- **R**: a `by` attribute is in `removedSet`.
- **A**: a source attribute is absent from the merged record.
- **PT**: a PK composite has a value in the payload.

**Gate.** The PK half is skipped iff the existing skip predicate holds and not (T or N or R). For an
empty PK half with `by`, the value is no longer constant, so the half is skipped when `by` is absent
from payload and `keyRecord` and not T / N / R. Empty PK half without `by`: never skipped, as before.

**Outcome**, where P = `classifyHalf(pk composites, merged, policy.pk, hasRemoved)`:

| Case | Condition | Outcome | Why |
|---|---|---|---|
| 1 | R | REMOVE, both policies | `.remove(["groupId"])` is the explicit signal; no shard can be composed |
| 2 | P = drop, T, PK composites merely omitted | **fail `EDD-9100`**, both policies | A `by`-only update can't compute the new shard. Under `sparse`, silently evicting the item is not what the writer asked for |
| 3 | P = drop, otherwise | REMOVE | `sparse` can't-compose, or a removed / explicitly nulled PK composite: the legitimate drop, and it writes no unsharded key |
| 4 | P = noop, T | **fail `EDD-9100`** | Otherwise the stored shard goes stale |
| 5 | P = noop, otherwise | noop | `preserve` as today |
| 6 | P = set, not A | SET sharded, truncated included | The normal case |
| 7 | P = set, A, PT, N and `sparse` | REMOVE | The writer explicitly cleared `by` |
| 8 | P = set, A, PT, otherwise | **fail `EDD-9100`** | Moves the tenant without `by`: the issue's "silent fallback" scenario |
| 9 | P = set, A, not PT, N and `sparse` | REMOVE | Explicit clear under `sparse` |
| 10 | P = set, A, not PT, otherwise | noop | An unrelated `.set({ status })`, with PK composites from `keyRecord`, must never evict or fail |

A composer option `onMissingShardSource: "keep"` turns cases 2, 4 and 8 into a noop for the two
callers that compose from partial knowledge and don't write the result as-is:

- the pre-check at the retain branch point, whose `keyRecord` is the encoded key only (the retain
  and computed branches read the full item and compose again);
- the move path, which recomposes a stored row with `stored` as both payload and key record, where a
  row without `by` keeps what it has.

The SK half is not affected: it follows its existing rule, independently.

## 6. Reads

### 6.1 Partitions

A query's partitions, in order: current shards by shard number (one when pruned), the `previous`
layout's by shard number, and, with `previous: 1` only, a 1.36 key when its text differs (§9.3).
Each is `{ pkValue, condition, rowCheck }`. `Query.fanOut` (internal) installs them, and the
terminals branch on them before any other plan.

### 6.2 Merge

`internal/ShardMerge.ts` is pure: it holds each partition's buffered rows and boundary, and selects
the next rows in merged order. `Query.ts` sends the requests.

**A row is emitted only when every unfinished partition has a buffered row to compare it with.**
That is what makes the order correct and bounds memory at one page per partition. A partition with
an empty buffer and a `LastEvaluatedKey` is read before anything further is emitted.

**Order.** `compareUtf8` for `S` and bytes for `B`, numeric for `N` (composed keys are never `N`, but
the comparator covers it exactly, with no float conversion). `.reverse()` inverts the comparison.

**Ties.** Equal sort keys break by partition index, descending under `.reverse()`, so reverse is the
exact reversal of forward. The issue's second tie-break (the table key) can never be reached: a tie
is between heads of *different* partitions, and within one partition DynamoDB's order is already
fixed. Recorded as a change in §15.

### 6.3 Terminals

There is no `.stream()` terminal on this branch (finding 4); the issue's `.stream()` is treated as
`.paginate()`, and none is added. `BoundQuery`'s terminals stay `fetch`, `collect`, `paginate`,
`count`.

| Terminal | Behaviour |
|---|---|
| `.collect()` / `.paginate()` | Streams the merge. Each pull reads every unfinished partition whose buffer is empty, then emits what is proven in order. `Query.paginate` emits one array per pull |
| `.limit(n).fetch()` | `n` merged items and a cursor. Rows read beyond the page are dropped and read again next time |
| `.fetch()` without `limit` | One round of reads: what that round proves in order, and a cursor |
| `.count()` | Each partition counted (`Select: COUNT`, or the rows read where a row check judges them), summed, capped at `limit` |

Pruned queries still take this path, with one partition. That keeps one code path and one cursor
format per index, so a cursor can't change format because of a query's pins.

### 6.4 `.maxPages(n)` (finding 8)

`n` **rounds**: at most one request per unfinished partition per round, so at most `n × partitions`
requests. Rows that can't be proven in order when the rounds run out are dropped; `fetch`'s cursor
re-reads them, and `collect` stops short, as it does on an unsharded index.

### 6.5 Request sizing

One `Estimator` per partition, kept in the terminal's loop and never in a cursor. `active` is the
partitions not finished; `remaining` the items still owed.

| Mode | `Limit` of each request |
|---|---|
| `none` | none: natural pages |
| `fixed` | `pageSize(n)`, as given (`min(n, remaining)` when nothing filters) |
| `natural` | 1.36's sizing with `remaining` |
| `budget` | `min(remaining, max(⌈remaining / active × 1.25⌉, last × 2))` |
| `adaptive` | `nextLimit(estimator, ⌈remaining / active⌉, filtered)` |

`maxPages` does **not** force `natural` here, as it doesn't for planned queries: fan-out is new, so
there is no 1.36 sizing to preserve. `.explain()` reports the mode.

### 6.6 Cursor

Cursor v2 gains `z` (positions, aligned with the partitions) and `c` (a checksum over them):

```jsonc
{ "v": 2, "f": "<fingerprint>", "s": "key", "z": [0, 1, { "gsi5sk": {"S":"…"}, "pk": {"S":"…"}, "sk": {"S":"…"} }], "c": "<fnv>" }
```

- **Position:** `0` not started, `1` done, or the key to resume after. The key omits the index
  partition key, which is recomposed on resume. That shortens the cursor and, more usefully, means a
  tampered cursor can't name another partition.
- **Boundary rules:** a fully consumed page with a `LastEvaluatedKey` → that key. A fully consumed
  page without one → done. A partially consumed page → the key of its last consumed row. A page read
  but not touched → the previous boundary.
- **Fingerprint:** `fnv1a32(canonicalJson({ index, entityTypes, partitions, source, previous,
  conditions, reverse }))`. The partition texts carry the logical partition and the count. It excludes
  `concurrency`, `pageSize` and `limit`, so a resumed query may change them.
- **Refusals (`EDD-9094`):** a fingerprint mismatch, wrong position count or shape, an unexpected
  attribute in a position, a position outside the query's key condition, a checksum mismatch, a plain
  or planned cursor on a sharded query, and a sharded cursor on any other query.
- The page cursor stays `Option<string>`; `None` means every partition is done.

The checksum is an integrity check, not authentication: anyone can recompute FNV. It catches a
corrupted or hand-edited cursor. The security-relevant property is that a cursor can't leave its
partitions, because it doesn't carry them.

Cursor size grows with N, at roughly one key's text per partition still in progress. That is one of
the reasons for the cap (§10.1).

### 6.7 Projections (finding 5)

`.select([...])` would omit what the merge needs, so `cursorProjectionFields` always borrows the
query's `keyFields` on a fan-out, and `examinePage` strips them as it does for an over-read
projection.

### 6.8 `onRequest`, consumed capacity, failures (finding 8)

- **`onRequest`:** one event per request. `request` is the send order. Because a row's acceptance is
  known only when it is emitted, an event fires when its page drains, or at the end of the terminal,
  so events may arrive out of `request` order. `accepted` counts that page's rows that became items,
  so Σ `accepted` is what the terminal returned. A page read and never touched reports `discarded:
  true`.
- **Consumed capacity:** every request runs on `Capacity.client` inside the terminal's one operation
  (`Query.collect`, …), so a report shows one operation with its total, as a multi-page query does.
- **Failure:** any partition's failure fails the terminal. `fetch` and `collect` return no partial
  result and interrupt requests in flight. A `paginate` stream fails at that point, having delivered
  only what was already proven in order. #181's `executePlanned` hands back a prefix on a throttled
  later range, but that is not offered here: the page's order can only be proven with every
  partition's answer.

### 6.9 `concurrency` (finding 8)

`Query.concurrency(n)` (`Function.dual`) and `BoundQuery.concurrency(n)`. Default: every partition
at once. It is not in the fingerprint. A value that isn't a positive integer throws `[EDD-9105]`,
as `.pageSize()` throws `EDD-9095`. On a query with one partition or an unsharded index it has no
effect.

### 6.10 Inspection

`explain()` keeps plan `key`, lists one key condition per partition and adds `fanOut: { partitions,
pruned, concurrency }`. `asParams` reports the first partition's request.

## 7. Pruning

A query reads one current shard when every `by` attribute is pinned by the accessor's composites.
Accessor pins are a leading prefix of the sort key (`EDD-9004` rejects a hole), so this is exactly
"every `by` value is known". In v1:

- `.where()` doesn't prune, even with `eq` (a design boundary: pins only).
- The default source never prunes, since the query would have to pin the whole primary key.
- Collection queries never prune (each member has its own source).

## 8. `by`

`by` must name string-half sort key composites of this index. The type system offers exactly those
(`EntityIndexesGuard`), and `Entity.make` checks again for `[EDD-9102]`, including an empty list and
duplicates. A Z-order half can't take `by`, since an accessor can't pin its dimensions. A Z-order
sort key **without** `by` is fine: the merge compares bytes, and `.within()` is what's refused.

Changing `by` at an unchanged `count`: `previous` can't equal `count`, so this is a boundary.
Removing `by` is safe (all shards are read). Adding `by` at the same count is not, because pruned
queries would miss rows that have not moved. Change `count` with `previous` instead (§15).

## 9. Adoption and `previous`

### 9.1 The three steps

1. Deploy with `previous`. Writes compose the new key. Reads also read the old layout.
2. Run `db.tables.<Table>.rekey()`.
3. Remove `previous`.

An item has one stored index key, so it is returned once, and the layouts are disjoint (§2.1). A
cursor from before a step is refused with `EDD-9094`, since the layout differs; the caller restarts
the listing.

### 9.2 `rekey`

`staleIndexKeys` gains a sharded branch for the PK half. When the stored key differs from what the
values compose now, and the PK composites and source are present, the item moves: `UpdateItem` on
the index key attribute alone, guarded on the old key text and the composites feeding it, including
`by`. Dry run, segments, resume token and capacity report stay as they are.

A stored key whose values can no longer compose (a `by` attribute cleared under `preserve`) is
reported as a conflict with a new reason `"uncomposable"`, never silently left.

The guard is narrower than the issue's "the item is unchanged since it was read": a write to an
attribute that doesn't feed this key can't invalidate the new key, so it shouldn't make `rekey`
retry. Recorded in §15.

### 9.3 Rows under 1.36 key text (finding 7)

- Sharded partitions hold no 1.36 text: the sharded layout is new in 1.38. `KeyText136.composePk`
  stays unsharded.
- With `previous: 1` and the fallback on, the partitions are: N sharded (no row check), the unsharded
  current text (the current pass's row check when a 1.36 pass exists), and the 1.36 text when it
  differs (the 1.36 pass's row check). The checks are `keyPassesPlanner`'s, extracted to be shared,
  and judged against the unsharded view of the index, since that is where these rows live.
- With no `previous`, or `previous ≥ 2`, no 1.36 pass runs.
- The move path recomposes through the composer, so such a row lands sharded.
- Merge across forms uses the stored sort key bytes, the only order those partitions have.
- Recommended order in the docs: `rekey` to 1.37's key text first, then adopt sharding. Adopting
  directly works and is tested.

## 10. Validation

| Code | When | Raised by |
|---|---|---|
| `EDD-9099` | Malformed `shards`: `count` not an integer in 2..256, `previous` not a positive integer or equal to `count`, an unknown key, or `shards` on the primary key | `Entity.make` |
| `EDD-9100` | The shard source is missing when the half is composed (`ValidationError`) | every write path |
| `EDD-9101` | Nothing to spread: every primary key composite is also a PK composite of the index, with or without `by` | `Entity.make` |
| `EDD-9102` | `by`: empty, duplicated, not a sort key composite of this index, or on a Z-order half | types + `Entity.make` |
| `EDD-9103` | Collection members disagree on `count` or `previous` | `DynamoClient.make`, `Collections.make` |
| `EDD-9104` | Unsupported on a sharded index: `.within()`, skip-scan, `.zorder()`, `GeoIndex` | the call |
| `EDD-9105` | `concurrency` not a positive integer | the call |
| `EDD-9094` | Cursor mismatch or tamper (existing) | the terminal |

### 10.1 The cap on `count` *(proposed)*

256. The owner's rule against client-side pre-checks is about limits DynamoDB enforces. DynamoDB
has no notion of this one, so the cap has to justify itself, on these grounds:

- **Fan-out cost.** Every logical query sends at least N requests, each billed the per-request
  minimum. N × 0.5 RCU is real money per list call past a few hundred.
- **Cursor size.** One position per partition: about 50 KB of cursor text at 256 with typical keys,
  and cursors travel in URLs and headers.
- **Typos.** `shards: 2000` or `20000` for `200` would otherwise deploy, and every read would
  be a disaster. Worse, undoing it needs a `previous` + `rekey` migration.
- **No real user is excluded.** 256 × 1,000 WCU/s is 256,000 WCU/s on one logical key, more than six
  times the default per-table quota of 40,000 WCU/s.

Raising the cap later is compatible; lowering it isn't. The marker's width is taken from the count,
so the spelling doesn't depend on the cap.

## 11. Interactions (finding 8)

| Topic | Decision |
|---|---|
| Collections: `count` | Every member must declare the same (`EDD-9103`), as the issue asks |
| Collections: `previous` | Every member must declare the same (`EDD-9103`), and undeclared differs from declared. The partitions read are shared, so a member with its own `previous` would make the collection miss rows or read partitions another member never wrote |
| Collections: `by` | May differ: each member hashes its own source, and the partitions read are the same |
| Collections: pruning | Always fan out in v1 |
| Collections: per-entity selectors | Fan out as the collection does |
| Aggregates and edge entities | No interaction, so nothing to reject: an aggregate's collection config is its own and has no `shards`; aggregate writes compose their own attributes and never read `entity.indexes`, so they write no GSI key of an edge entity's sharded index. A test pins this. A standalone entity's ops on the same entity shard normally |
| EventStore projection rows | Entity operations, so sharded through the composer |
| Cascade reads | Fan out: `Entity.ts`'s cascade query reads every partition of a sharded cascade index |
| `Entity.query.<index>` | Fans out |
| Time-series events | Strip GSI keys, unchanged. `append` composes the current item's keys through the update composer |
| Unique sentinels | Unaffected |
| `GeoIndex`, `.within()`, skip-scan, `.zorder()` | `EDD-9104` |
| `.history()` | Primary index only, unaffected |
| Language service | Hover renders the marker with a shard placeholder |
| Docs playground | Composes through `KeyComposer`, so a `shards` index renders the real marker |

## 12. Cost

| | Unsharded | Sharded (N) |
|---|---|---|
| Write | 1 index write | 1 index write |
| Logical query | 1+ requests | N+ requests, each billed the per-request minimum |
| Latency | one partition | about the slowest shard |
| `fetch` page | reads the page | up to N partial pages, sized from `n / N` |

**Choosing N:** N ≥ peak WCU/s on the logical key ÷ (1,000 × headroom). Small logical partitions pay
N times the per-request minimum for nothing, so sharding is for keys that need it.

## 13. Findings from the pre-implementation review

| # | Finding | Outcome |
|---|---|---|
| 1 | A case-sensitive hash breaks pruning under `lowercase` | **Correct.** Fold `U∘L` regardless of `casing` (§3). `L∘U` would have failed on `ß` / `ẞ` |
| 2 | `by` vs the update gate | **Correct.** `by` is a touched-only dependency of the PK half (§5). A subtlety the finding didn't list: counting `keyRecord` would break unrelated updates on the retain path |
| 3 | Segment collisions during migration | **Correct, and it rules out any final segment.** Marker moved before all values (§2) |
| 4 | `.stream()` doesn't exist | **Correct.** Treated as `.paginate()`, no terminal added |
| 5 | Projections break the merge | **Correct.** Borrowed and stripped (§6.7) |
| 6 | Write paths the issue's list omits | **Correct**, and the cascade read is a read path of the same kind. Structural design (§4) |
| 7 | 1.36 legacy paths | **Resolved** (§9.3) |
| 8 | Open gaps | **Resolved** (§6.4, §6.8, §6.9, §11) |

## 14. Decisions

All are *proposed — awaiting owner confirmation* unless stated. "Task" means the task statement fixed
the direction, and it is still proposed for the owner.

| # | Decision | Status |
|---|---|---|
| D1 | `by` ships in v1 | proposed (task) |
| D2 | Marker `!<count>.<shard>` before all values, not a final segment | proposed — awaiting owner confirmation |
| D3 | Keep the name `previous` | proposed (task) |
| D4 | `count` capped at 256 | proposed — awaiting owner confirmation |
| D5 | Hash input fold `toLowerCase().toUpperCase()`, separator `0xFF` | proposed — awaiting owner confirmation |
| D6 | `by`-only update without PK composites fails, even under `sparse` (§5 case 2) | proposed — awaiting owner confirmation |
| D7 | Explicit `.remove(["by"])` drops the PK half under both policies | proposed — awaiting owner confirmation |
| D8 | Unrelated update where `by` is absent is a noop under both policies (§5 case 10) | proposed — awaiting owner confirmation |
| D9 | Collection members must agree on `count` and `previous`, not `by` | proposed — awaiting owner confirmation |
| D10 | Collections never prune in v1 | proposed (task) |
| D11 | `.maxPages(n)` means n rounds | proposed — awaiting owner confirmation |
| D12 | Any partition's failure fails the terminal | proposed (task) |
| D13 | Pruned queries keep the fan-out path and v2 cursor | proposed — awaiting owner confirmation |
| D14 | Cursor positions omit the index partition key | proposed — awaiting owner confirmation |
| D15 | `.where()` doesn't prune in v1 | proposed — awaiting owner confirmation |
| D16 | `previous` partitions are never pruned | proposed — awaiting owner confirmation |
| D17 | `rekey` guard covers the key's own inputs, not the whole item | proposed — awaiting owner confirmation |
| D18 | Rows that can't compose are `rekey` conflicts (`"uncomposable"`) | proposed — awaiting owner confirmation |
| D19 | Aggregate edges need no rejection (no interaction, pinned by a test) | proposed — awaiting owner confirmation |
| D20 | `onRequest` events fire when a page drains, with exact `accepted` | proposed — awaiting owner confirmation |
| D21 | `maxPages` doesn't force natural sizing on a fan-out | proposed — awaiting owner confirmation |
| D22 | Z-order sort key allowed on a sharded index without `by`; `.within()` refused | proposed — awaiting owner confirmation |
| D23 | `.concurrency()` is ignored on a query with no fan-out | proposed — awaiting owner confirmation |

## 15. Scoping decisions

Every item in the issue, mapped to **in**, **out** or **changed**.

### Proposal: declaration and writes

| Issue item | Scope | Note |
|---|---|---|
| `shards: n` shorthand and `{ count, by?, previous? }` | in | |
| Shard = `hash(source) mod count`, default source the primary key composites | in | |
| FNV-1a-32 over UTF-8 | in | |
| Canonical encoding independent of key format options | **changed** | Independent of `casing` as asked, but applies a fixed fold (finding 1) |
| Golden vectors; changing the hash is breaking | in | |
| Aggregate `hashToShard` stays | in | Untouched |
| Shard number as a **final segment** | **changed** | Moved before all values (§2, finding 3) |
| Segment can't be spelled by a value | in | Proven by position, tested |
| Spelling for compact keys (#182) | **out** (recorded) | §2.2: #182 has no code |
| Every listed write path composes sharded | in | Structural (§4) |
| `restore` and other unlisted paths | in | Added (finding 6) |
| No unsharded fallback: missing source fails | in | `EDD-9100` |
| `preserve` update not composing the half leaves it | in | §5 |
| Time-series events, unique sentinels unaffected | in | |

### Proposal: reads

| Issue item | Scope | Note |
|---|---|---|
| One Query per shard, same condition and filter | in | |
| `concurrency` option, default all shards | in | `Query` combinator + `BoundQuery` method |
| k-way merge: UTF-8 for `S`, numeric for `N`, bytes for `B` | in | |
| `.reverse()` merges descending | in | |
| Ties by shard, then table key | **changed** | By partition; the table key can't be reached (§6.2) |
| Same order as an unsharded index | in | Up to DynamoDB's unspecified order among equal sort keys |
| `.collect()`, `.paginate()` stream the merge, one page per shard | in | |
| `.stream()` | **changed** | Doesn't exist; treated as `.paginate()` (finding 4) |
| `.limit(n).fetch()` with a per-shard cursor | in | |
| Over-read dropped and re-read | in | |
| Adaptive sizing from `n / count` | in | Per partition (§6.5) |
| `.count()` sums | in | |
| Cursor: positions + layout fingerprint, `EDD-9094`, `Option<string>` | in | |
| Pruning when every source attribute is pinned | in | Pins only (§7) |

### Proposal: `by`, adoption, validation

| Issue item | Scope | Note |
|---|---|---|
| `by` replaces the source | in | |
| `by` must be sort key composites, checked by type and `Entity.make` | in | `EDD-9102` |
| `by` required when the half is composed | in | §5, with the policy interactions decided |
| `by` change moves the entry | in | |
| Docs warning on coarse `by` values | in | Guide |
| `previous` transition: writes new, reads both, merged | in | |
| `rekey` pass | in | §9.2 |
| `rekey` keeps dry run, segments, resume, conflicts, capacity | in | |
| `rekey` moves only index key attributes, conditional on unchanged item | **changed** | Guard covers the key's inputs, not the whole item (§9.2) |
| Remove `previous` | in | Documented step |
| `count` integer ≥ 2 | in | Plus the cap (§10.1) |
| Nothing-to-spread rejection, with or without `by` | in | `EDD-9101` |
| `previous` positive integer ≠ `count` | in | |
| Collections agree on `count` | in | Plus `previous` (§11) |
| v1 rejects `GeoIndex`, `.within()`, skip-scan | in | Plus `.zorder()` (`EDD-9104`) |
| Cost table and N rule in docs | in | |

### Testing

| Issue item | Scope | Note |
|---|---|---|
| Schema unit: golden vectors, every write path, missing source, definition errors | in | |
| Mocked client: request counts, merge order and ties, `fetch` chains, cursors, pruning, `previous`, `concurrency` | in | Plus a randomised brute-force check |
| Connected: thousands of items over 16 shards | in | |
| Connected: adoption on a populated index | in | |
| **On AWS throughput check** | **out** | Not part of this run; not done. DynamoDB Local can't show throughput |

### Out of scope in the issue, and staying out

| Item | Note |
|---|---|
| Hot read keys and caching | out |
| A single hot item | out |
| Sharding the primary key | out; `shards` on `primaryKey` is `EDD-9099` |
| Choosing N automatically; resharding without `previous` + `rekey` | out |
| `GeoIndex`, `.within()`, skip-scan on sharded indexes | out; follow-ups, `EDD-9104` until then |
| Cursors for Aggregate's sharded `list` (`EDD-9051`) | out |

### Open questions in the issue

| Question | Answer |
|---|---|
| `by` in v1? | Yes, proposed (D1) |
| Spelling, default and compact | §2; compact recorded, not built (D2) |
| Name of `previous` | Kept, proposed (D3) |
| Upper bound on `count` | 256, proposed (D4) |

### Boundaries this design introduces

Not in the issue; each one is something a caller could otherwise expect:

| Boundary | Reason |
|---|---|
| `count` ≤ 256 | §10.1 |
| Adding `by` at an unchanged `count` isn't a supported migration | `previous` can't equal `count`; change the count (§8) |
| `.where()` never prunes | Pins only in v1 (§7) |
| `previous` partitions never prune | The previous source isn't recorded (§9.3) |
| `by` can't be on a Z-order half | Accessors can't pin dimensions (§8) |
| `.zorder()` is refused along with `.within()` | It only configures a `.within()` read |
| `.maxPages(n)` counts rounds, not requests | §6.4 |
| A resumed cursor is refused across each adoption step | `EDD-9094`; restart the listing (§9.1) |
| The cursor checksum is integrity, not authentication | §6.6 |
| A `paginate` stream may have delivered rows before a failure | §6.8 |
| Cursor size grows with N | §6.6 |

## 16. Testing

- **Schema unit (`packages/schema/test`):** golden vectors for the hash and marker; the fold's
  properties over all code points; every canonical shape through the composer (§5 table included);
  definition errors; type-level `by` checks.
- **Entity level (`packages/effect-dynamodb/test`):** the sharded key on `put`, `create`, `upsert`,
  `update`, `patch`, retain, `append`, `restore`, `Batch`, `Transaction`, move, `rekey`; missing
  source fails with nothing sent; the six original canonical shapes plus Z-order shapes 7 and 8.
- **New degenerate fixtures:** 9a, an empty PK half with `by`; 9b, a `by` attribute in the primary
  key as well, so it arrives through `keyRecord` but is not a touched dependency; 9c, a default source
  with an empty PK half, whose value differs per item though the half has no composites.
- **Mocked client:** per the issue, plus randomised brute force: random partition contents and `by`
  distributions, duplicates across shards, filters and page sizes, with `fetch` chains whose limits
  land anywhere; concatenated pages equal `collect()` equal a brute-force sort, forward and reverse.
- **Connected:** per the issue, and the canonical shapes.
