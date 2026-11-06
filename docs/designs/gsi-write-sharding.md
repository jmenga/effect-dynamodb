# Design: GSI write sharding (#183)

**Issue:** [#183](https://github.com/jmenga/effect-dynamodb/issues/183)
**Status:** Implemented in the same PR (single-PR workflow: this doc is commit 1). The owner has
confirmed §14 as proposed. D64 to D70 and D76 to D80 are the owner's own decisions; D76 to D79 replace the
fallback, row-check and default-on decisions before them. D61 and D63 came after that first confirmation, D71 and D72 and D81 to D87 are scoping calls awaiting review.
**On top of:** #192 (Effect 4.1, merged as `53f5711`, 1.38.0) and #181 (1.37.0, merged as `dc48baa`): cursor v2, `Option` page cursors, model-checked
attribute names, adaptive request sizing and `rekey` all come from it. The PR targets `main`.
**Builds on:** `zorder-indexes.md` §6.3 (the partition limit), §8 (request sizing), §10.3 (byte
order and cursors); v1.7.x policy-aware GSI composition (#41 / #43 / #46); #171's `rekey`, whose
1.36 fallback this PR removes.
**Affected packages:** `packages/schema` (`KeyComposer`, new `internal/Shards`, `Entity.make`),
`packages/effect-dynamodb` (`Query`, new `internal/ShardMerge`, `internal/Cursor`,
`internal/RangePlanner`, `internal/BoundQuery`, `DynamoClient`, `Collection`, `Entity`, `Table`,
`internal/TransactableOps`), `packages/effect-dynamodb-geo` (rejection only),
`packages/language-service`, `packages/docs`, `packages/doctest` (no code change).
**Semver impact:** `minor`, 1.39.0 in lockstep (D80). `escapeKeys` is off by default for all of 1.x, and off
composes exactly the text 1.36 composed, for strings and numbers (§17.17). So upgrading from 1.36 or earlier
needs nothing, and 1.37's key change is reversed by default: rows 1.37.0 and 1.38.0 wrote with an escapable
character in a sort key, or a number whose text they changed, need `rekey`. It also fixes the inverted index
problem 1.37.0 and 1.38.0 have (§17.16). `legacyKeys` and `ItemNotMoved` are gone. Two bug fixes reach
every secondary index (§17): a partial pin finds the row truncated at that level (with `escapeKeys: true`), and an unrelated
update no longer touches a half mixing a primary key composite with a mutable one. A definition
whose key halves share an attribute without the same fields, order and casing now throws `EDD-9106` at
load (D61, §17.8), and one entity using one physical index twice throws `EDD-9108` (D69).The cursor
format and range planning of an index without `shards` don't change.

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
| `casing: "uppercase"` on the schema | `$FLEET-DB#v1#DEVICESTATE#!20.07#TENANTID_T-123` |

This **changes the issue's proposal** of a final segment (§15). Reasoning:

- **A value can hold `#` under `escapeKeys: false`, so no final segment can be safe.** The unsharded
  key for tenant `t-123#07` would be byte-for-byte the "final segment" sharded key for tenant `t-123`,
  shard `07`. During a migration both layouts are read, so that row would be read from both or attributed
  to the wrong layout, and no spelling of a final segment fixes it, because the value is arbitrary text.
  With escaping on, as by default since D64, `#` can't reach a value, but a 1.36 row's text is still
  raw, and the flag can turn it off, so the marker stays before all values either way. Cursors and
  the hash don't change: the hash reads each value's `serializeValue` text, not the key's, so a shard
  doesn't depend on the flag.
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

With escaping on, `a#b` + `c` and `a` + `b#c` no longer collide within one layout (noted by #182).
Under `escapeKeys: false` they still do, as one of its limitations (D66).

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
  when every attribute of the shard source is pinned, §7), then the `previous` layout's partitions,
  never pruned. Every
  read path calls it: `DynamoClient` accessors, `Entity.query.<index>`, `Collections`, the client's
  collection accessors and cascade reads.
- **`KeyText136` stays unsharded** (§9.3): a shard can hold 1.36 sort key text, never 1.36 partition
  key text.
- **A sharded partition key has an attribute of its own,** or shares it only with a partition key provably
  composing the same bytes (§10, `EDD-9106`). Otherwise composing it would overwrite another key.

So the paths the issue's list omits are covered without a per-site change:

| Path | Why it is covered |
|---|---|
| `put`, `create`, `upsert`, `restore`, `Batch.write`, `Transaction.transactWrite` | `composeAllKeys` → `composeIndexKeys` → `composePk` |
| `update`, `patch`, retain path, `append`, the 1.37 move path | `composeGsiKeysForUpdatePolicyAware` (§5) |
| Soft delete, version snapshots, time-series events | They strip GSI keys, never a table key attribute (§17.9); nothing is composed |
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
| 6a | P = set, not A, T, and the sort key half would keep its text (a hole, under `preserve`) | **fail `EDD-9100`** | The shard would follow the new value while the sort key stays at the old one, and no pin could reach the row (§17.4) |
| 6 | P = set, not A, otherwise | SET sharded, truncated included | The normal case |
| 7 | P = set, A, N and `sparse` | REMOVE | The writer explicitly cleared `by` |
| 8 | P = set, A, PT or T | **fail `EDD-9100`** | Moves the tenant without `by` (the issue's "silent fallback" scenario), or changes one `by` attribute without another |
| 9 | P = set, A, otherwise | noop | An unrelated `.set({ status })`, with PK composites from `keyRecord`, must never evict or fail |

A composer option `onMissingShardSource: "keep"` turns the failing cases into a noop for the two
callers that compose from partial knowledge and don't write the result as-is:

- the pre-check at the retain branch point, whose `keyRecord` is the encoded key only (the retain
  and computed branches read the full item and compose again);
- the move path, which recomposes a stored row with `stored` as both payload and key record, where a
  row without `by` keeps what it has.

The SK half's own outcome is not affected: it follows its existing rule, and case 6a only asks what
that rule would do. Under `keep`, case 6a is a noop on both halves, so the retain and computed
branches can compose from the whole item.

The existing skip predicate itself changed as well, on every index: one composite in `keyRecord` no
longer wakes a half (§17.2, shape 10). "Holds" above means the predicate as it is now.

## 6. Reads

### 6.1 Partitions

A query's partitions, in order: current shards by shard number (one when pruned), the `previous`
layout's by shard number, and, with `previous: 1` only, the 1.36 key when its text differs, with each
shard read again under the 1.36 condition when that differs (§9.3). Each is `{ pkValue, condition, rowCheck }`. `Query.fanOut` (internal) installs them, and the
terminals branch on them before any other plan.

### 6.2 Merge

`internal/ShardMerge.ts` is pure: it holds each partition's buffered rows and boundary, and selects
the next rows in merged order. `Query.ts` sends the requests.

**A row is emitted only when every unfinished partition has a buffered row to compare it with.**
That is what makes the order correct and bounds memory at one page per partition. A partition with
an empty buffer and a `LastEvaluatedKey` is read before anything further is emitted.

**Order.** `compareUtf8` for `S` and bytes for `B`, numeric for `N` (composed keys are never `N`, but
the comparator covers it exactly, with no float conversion). `.reverse()` inverts the comparison.

**Ties.** Equal sort keys on different partitions break by partition index, descending under
`.reverse()`. So `.reverse()` reverses the forward order up to DynamoDB's unspecified order among
equal sort keys within one partition, which the merge keeps as read and doesn't assume reverses. The
issue's second tie-break (the table key) can never be reached: a tie is between heads of *different*
partitions, and within one partition the order is DynamoDB's. Recorded as a change in §15.

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

**Rounds and refills.** A round reads every partition with nothing buffered and more to read, at
once, and takes about as long as the slowest of them. The first round is every partition. The merge
then emits until it reaches the budget or the first partition with more to read runs dry, and it
stops there, because nothing further is proven in order until that partition answers. So later
rounds usually read one partition each, one after another. `.fetch()` without `limit` is one round;
`.limit(n).fetch()` is as many as the page takes, which is why it isn't "about the slowest shard"
(§12 has the measurement). Each `Limit` starts near `n / N`, so a partition running dry before the
page is full is the ordinary case, not the exception. Rows read past the page are dropped.

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

A query reads one current shard when the accessor pins every attribute of the shard source, whether
that source is `by` or the primary key. The write hashed those values, and the query hashes its pins
through the same key form and the same fold (§3), so the two agree in any case and for any type.

Accessor pins are the partition key composites and a leading prefix of the sort key (`EDD-9004`
rejects a hole). So:

- **`by`** prunes when the pinned prefix holds every `by` attribute.
- **The default source** prunes when the index's keys hold the whole primary key and the query pins
  all of it: `sk: [groupId, channel, deviceId]` on `primaryKey: [channel, deviceId]`. Where a primary
  key composite is outside the index's keys it never fires, and the query fans out. A query that does
  fire is a lookup of one row, so its cost drops from N requests to one.

Values past a hole and attributes that aren't composites of this index don't count, which also makes
`Entity.query.<index>` sound, as it has no hole check of its own. A pruned query's cursor belongs to
that query: the fingerprint covers the partitions, so pruned and unpruned cursors refuse each other
(`EDD-9094`). In v1:

- `.where()` doesn't prune, even with `eq` (a design boundary: pins only). On a pinned query, the bound
  builder's `.where()` is clamped under the pins, so the chosen shard still holds every row it can
  select. The unbound `Query.where()` replaces the condition, so it **undoes** the pruning and reads
  every partition again (§17.6).
- `previous` partitions are read whole either way: the old source isn't recorded. `fanOut.pruned`
  speaks for the current layout, so with `previous` it can be `true` over 1 + `previous` partitions.
- Collection queries never prune (each member has its own source).

An earlier draft said "the default source never prunes, since the query would have to pin the whole
primary key". The issue has no such exception, and a query can pin it. The narrowing was marked "in"
in §15 without a boundary; it was found on a real table, where such a pin returned the right row but
read all 20 shards. It is implemented now (D34). §15 has the audit it prompted.

## 8. `by`

`by` must name string-half sort key composites of this index. The type system offers exactly those
(`EntityIndexesGuard`), and `Entity.make` checks again for `[EDD-9102]`, including an empty list and
duplicates. A Z-order half can't take `by`, since an accessor can't pin its dimensions. A Z-order
sort key **without** `by` is fine: the merge compares bytes, and `.within()` is what's refused.

Changing `by` at an unchanged `count`: `previous` can't equal `count`, so this is a boundary, and
neither direction is safe for every query. Adding `by`: pruned queries would miss rows that have not
moved. Removing `by`: a query that reads every shard still finds every row, and `rekey` moves rows to
the default source's shards, but a query pinning the whole primary key now prunes to the default
source's shard and misses a row still on its `by` shard until `rekey` has moved it. Change `count`
with `previous` instead (§15).

## 9. Adoption and `previous`

### 9.1 The three steps

1. Deploy with `previous`. Writes compose the new key. Reads also read the old layout.
2. Run `db.tables.<Table>.rekey()`.
3. Remove `previous`, once a `rekey` run reports no conflicts.

An item has one stored index key, so it is returned once, and the layouts are disjoint (§2.1). A
cursor from before a step is refused with `EDD-9094`, since the layout differs; the caller restarts
the listing.

### 9.2 `rekey`

`rekey` compares with what each form composed (`KeyText136.forms`), and never parses (D58). `staleIndexKeys` composes text from the row's
values and compares it with the stored key. Nothing reads a value out of a stored key, so no label, spelling or
model kind decides anything.

**A sharded partition key** is composed and rewritten when it differs from the stored key, whatever that holds
(D24): moving rows into the layout is the feature. That also moves rows between a layout's own shards after `by`
is removed or changed. `EDD-9106` means no half that composes differently
shares its attribute, so there's no other accessor's entry to overwrite. The move is an `UpdateItem` on the index
key attributes alone, guarded on the old key text and the composites feeding it, including `by`. Dry run, segments,
resume token and capacity report stay as they are.

**Every other half** (an unsharded partition key, any sort key, a vector partition) keeps #181's rule, over every
form: it is rewritten only when the stored key is exactly the text a form composed from the row's values, and that
differs from the current text. Each half is judged by itself and by its bytes, with no question of which accessor owns an
attribute two of them share, which a row's values can't answer. So it can't tell a healthy key from another half's
text under a form when the bytes match (§15). Anything else is left with no conflict: a key an index policy kept, one lagging
its values, one cleared of them, or one an old gate truncated on a row holding all its composites (D33).

**A sort key missing a trailing composite** is judged by the composites before the gap (D43). A truncated row
stores exactly what its form composed for those, and is rewritten to their current text; #181's rule required every
composite, so such a row stayed behind. A key kept for a cleared value holds more than that, isn't equal, and stays.

**A partition key missing a composite** composes nothing, and is left with no conflict: a partition key is never
truncated.

**A sharded partition key that can't compose** (a `by` attribute cleared under `preserve`) is the conflict
`"uncomposable"` when it's in another layout, tested by prefix (`isCurrentShardLayout`), since no read of the
current layout would find it. One already in the current layout can't be improved on, and a read finds it, so
it is left alone with no conflict.

**What isn't compared.** A key the row doesn't have isn't written, since under `sparse` its absence can be
deliberate. A Z-order sort key's address is binary, with no text to change: it keeps its bytes, and only a prefix segment's text
is rewritten. Its partition key is text like any other: it's rewritten, compared with what each form composed, or moved
when it's sharded. A review of the first version found it skipped along with the sort half, which left a row with an
unchanged table key invisible through the index after `rekey`, with `indexKeysRewritten: 0` and nothing reported.
A table key attribute is the table's to hold, and DynamoDB
refuses the write.

**The accepted limit (D58).** A key that isn't any form's text stays, whatever it reflects. That covers a row that
clears a composite, and a key lagging its row's values (under `preserve`, an update naming a composite it can't
recompose the half from), when its text changed. The key reflects a value the row no longer holds, and
nothing says what it meant. After `rekey` and removing `previous`:

- **A sort key half:** a broader query finds the row, where its old text sorts. A pin on the old value misses it, and
  so does a pin on the value the row holds now.
- **A partition key half on an unsharded index:** a pin on the old value misses it, and `get` still reads the row.

Writing the composites puts it back. The alternatives, each tried in this PR, were classifying the stored text as
one form's or another's (§17.10), and rewriting any key that differs from what the row composes (§17.15).

**A run that moves a row compares it.** The table key move recomposes index keys as an update would, as it has since
#181, so a half with a hole keeps its text and a lagging key catches up. Halves in one attribute compose the same bytes
(D61), and a half in a table key attribute moves with the row, which is the only way it changes (D70). `rekeyAfterMove` reads the moved row and applies the same comparison in the same run. A dry run has no moved row to read: it judges the one the move would write (`movedRowOf`, which the move
itself uses), and reports what the real run would for that row (§17.11).

The guard is narrower than the issue's "the item is unchanged since it was read": a write to an
attribute that doesn't feed this key can't invalidate the new key, so it shouldn't make `rekey`
retry. Recorded in §15.

### 9.3 Rows under other key text (finding 7)

**A shard can hold a sort key under other text.** `KeyText136.composePk` stays unsharded, so no
partition key in a shard is under another form, but the sort key is a separate half. A write can move
the partition key and leave the sort key.

Every path that can move a row into a shard, under `{ count, previous: 1 }`, over a sort key under
other text:

| Path | Whole sort key | Truncated sort key |
|---|---|---|
| `update` naming the partition key but no sort key composite | Kept: the half isn't touched, and no read is sent | Kept |
| `Transaction.transactWrite` | Kept, likewise | Kept |
| `append` whose `appendInput` omits the sort key's composites | Kept, likewise | Kept |
| Retain path | Current text: it composes from the whole item | Kept: the hole leaves it, under `preserve` |
| `put`, `Batch.write` | Current text | Not applicable: a `put` is whole or absent |
| `rekey` | Current text | Current text (§9.2) |
| `rekey` moving the row from another table key text | Current text | Current text. A hole is rewritten to the leading run in the same run (§9.2) |

**Decision (D76): one text on a read, and `rekey` converts or reports.** A query reads the layouts'
partitions under the one text the setting composes, with no second pass. A row whose sort key is under
other text isn't found by a pin until `rekey` rewrites it (`indexKeysRewritten`). That is the same rule as
for every other key: run `rekey` before serving traffic.

**Leaving `previous: 1` needs a `rekey` that reports no conflicts.** Removing `previous` early hides
rows still in the old layout. The docs say so. A clean run says nothing of a key that isn't any form's
text, as when a composite was cleared or the key lags its values: `rekey` leaves it, and a pin then
misses it, which is the accepted limit of §9.2.

- `rekey` recomposes through the composer, so a moved row lands sharded.
- Recommended order in the docs: `rekey` to the setting's key text first, then adopt sharding. Adopting
  directly works and is tested.

## 10. Validation

| Code | When | Raised by |
|---|---|---|
| `EDD-9099` | Malformed `shards`: `count` not an integer in 2..256, `previous` not a positive integer or equal to `count`, an unknown key, or `shards` on the primary key | `Entity.make` |
| `EDD-9100` | The shard source is missing when the half is composed, or an update changes `by` and the sort key half can't be recomposed (`ValidationError`) | every write path |
| `EDD-9101` | Nothing to spread: every primary key composite is also a PK composite of the index, with or without `by` | `Entity.make` |
| `EDD-9102` | `by`: empty, duplicated, not a sort key composite of this index, or on a Z-order half | types + `Entity.make` |
| `EDD-9103` | Collection members disagree on `count` or `previous` | `DynamoClient.make`, `Collections.make` |
| `EDD-9104` | Unsupported on a sharded index: `.within()`, skip-scan, `.zorder()`, `GeoIndex` | the call |
| `EDD-9105` | `concurrency` not a positive integer | the call |
| `EDD-9106` | Two key halves of one entity stored in one attribute, sharded or not, without the same fields, in the same order and casing, or a sharded partition key with one sharded differently (§17.7, §17.8) | types, for a sharded half, where the literals say so (D39); `Entity.make` for what no schema can reconcile; `Table.make` for what the schema's casing decides |
| `EDD-9108` | One entity uses one physical index twice, even over the same fields (D69). `EDD-9107` was D62's, and is retired | `Entity.make` |
| `EDD-9094` | Cursor mismatch or tamper (existing) | the terminal |

### 10.1 The cap on `count`

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
| `Entity.query.<index>` | Reads what the accessor reads: prunes on the same pins (§7), otherwise fans out |
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
| Latency | one round trip | one per round (§6.3). A round takes about its slowest shard. `.fetch()` without `limit` is one round; `.limit(n).fetch()` is one round of every shard, then refills, usually one shard at a time |
| `.limit(n).fetch()` | reads the page | at least N partial pages, sized from `n / N`, plus the refills |
| Migrating (`previous: 1`) | 1+ requests | N+ requests for the current layout, plus the previous layout's: never pruned (§7) |

**Choosing N:** N ≥ peak WCU/s on the logical key ÷ (1,000 × headroom). Small logical partitions pay
N times the per-request minimum for nothing, so sharding is for keys that need it.

### Measured on a real table

A one-off run against a real on-demand table in us-east-1, at `2fc7bc6`, not a CI check. One logical
key, 20 shards, `ALL` projection, 1.3 KB rows (2 WCU per index write), 50,000 items, written with
`Batch.write` from outside the region (about 265 ms round trip).

| Run | Offered on the logical key | Result |
|---|---|---|
| Sharded | 2,000 WCU/s for 6 minutes | No throttle events, no failed batches |
| Sharded, stepping up | 3,000 WCU/s | For about 2 minutes, partition-limit throttle events on both the GSI and the base table, and 1,272 batches exhausted `Batch.write`'s default retries. Then clean at 3,000 WCU/s for the remaining 2 minutes or so |
| Unsharded control | 2,000 WCU/s for 5 minutes | The GSI stayed at about 1,000 WCU/s throughout: 358,566 write throttle events, 7,255 of 10,762 batches failed. The base table was held to the same 1,000 WCU/s, which confirms the back-pressure the issue describes |

The base table's keys aren't sharded and it throttled at the same moment as the GSI during the step to
3,000 WCU/s. That suggests the table scaling on a fresh table rather than the shard keys, but that
cause is inferred, not proven.

**Spread:** 2,444 to 2,567 items per shard, against an even share of 2,500.

**Reads, against known answers on the sharded table.** `collect`, `count`, a `fetch` chain of 50 pages
and `reverse` were all correct, with no duplicates. 200 pinned lookups with upper-cased inputs all
found the right row. All of these reads fanned out: the run predates default-source pruning (§7), so
pruned reads have not been measured on AWS.

| `.limit(100).fetch()` | Requests per page | p50 |
|---|---|---|
| Unsharded | 1 | 264 ms |
| 20 shards | 26 | 2.1 s |

That is about 7 round trips, which fits 20 parallel requests followed by shards refilling one at a
time (§6.3). Request sizing and refills are unchanged by this. The owner's decision is to leave them as
they are and measure first, and measuring small pages is tracked in [#185](https://github.com/jmenga/effect-dynamodb/issues/185) (D37).

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

The owner has confirmed these as proposed, so each is confirmed unless its row says otherwise. D62 is
superseded. D61 and D63 came after that confirmation and are kept by the owner's brief that replaced D62,
whose decisions are D64 to D70. D71 and D72 are this PR's scoping calls, D73 a fix from review, and D74 and D75 are left for the owner.

| # | Decision | Status |
|---|---|---|
| D1 | `by` ships in v1 | confirmed |
| D2 | Marker `!<count>.<shard>` before all values, not a final segment | confirmed |
| D3 | Keep the name `previous` | confirmed |
| D4 | `count` capped at 256 | confirmed |
| D5 | Hash input fold `toLowerCase().toUpperCase()`, separator `0xFF` | confirmed |
| D6 | `by`-only update without PK composites fails, even under `sparse` (§5 case 2) | confirmed |
| D7 | Explicit `.remove(["by"])` drops the PK half under both policies | confirmed |
| D8 | Unrelated update where `by` is absent is a noop under both policies (§5 case 9) | confirmed |
| D9 | Collection members must agree on `count` and `previous`, not `by` | confirmed |
| D10 | Collections never prune in v1 | confirmed |
| D11 | `.maxPages(n)` means n rounds | confirmed |
| D12 | Any partition's failure fails the terminal | confirmed |
| D13 | Pruned queries keep the fan-out path and v2 cursor | confirmed |
| D14 | Cursor positions omit the index partition key | confirmed |
| D15 | `.where()` doesn't prune in v1 | confirmed |
| D16 | `previous` partitions are never pruned | confirmed |
| D17 | `rekey` guard covers the key's own inputs, not the whole item | confirmed |
| D18 | Rows that can't compose are `rekey` conflicts (`"uncomposable"`) | confirmed |
| D19 | Aggregate edges need no rejection (no interaction, pinned by a test) | confirmed |
| D20 | `onRequest` events fire when a page drains, with exact `accepted` | confirmed |
| D21 | `maxPages` doesn't force natural sizing on a fan-out | confirmed |
| D22 | Z-order sort key allowed on a sharded index without `by`; `.within()` refused | confirmed |
| D23 | `.concurrency()` is ignored on a query with no fan-out | confirmed |
| D24 | `rekey` rewrites whenever stored ≠ composed on a sharded PK half, not only for 1.36 text; an uncomposable row already in the current layout is left alone with no conflict (§9.2) | confirmed |
| D25 | A `by`-only update fails on the standard path but succeeds on the retain and computed paths, which read the whole item (§5) | confirmed |
| D26 | A `put` with no value for a `by` attribute is sparse: no index entry, no unsharded key. `EDD-9100` is for a half being composed (§5) | confirmed |
| D27 | `Query.planEmpty` reads no partition and drops the fan-out, as a query with a known-empty result has nothing to merge | confirmed |
| D28 | The language service renders the shard as a `{shard}` placeholder, because a hover has no item to hash | confirmed |
| D29 | A partial pin on a secondary index selects the row truncated there and its subtree (`BETWEEN <prefix> AND <prefix>#U+FFFF`). Fixed on the read side, so no stored key changes; the primary key stays `begins_with` (§17.1) | confirmed |
| D30 | `.where(eq)` on a composite that isn't the last, and `eq` in `.within()`, mean the same as a pin on a secondary index (§17.1) | confirmed |
| D31 | ~~**Superseded by D76.**~~ While the 1.36 fallback is on, a pin whose text didn't change judges rows by key text (`keepRow`), reading nothing more. `.count()` reads rows at the same RCU; later `Limit`s grow (§17.1) | confirmed |
| D32 | A half wakes through `keyRecord` only when `keyRecord` holds **every** composite (shape 10, §17.2) | confirmed |
| D33 | Rows the old gate already damaged aren't repaired automatically: a write naming the half's composites, or a re-put, repairs them. `rekey` doesn't by default, but for a row truncated under 1.36 whose trailing composites it really lacks (D43). `rekey({ repairIndexKeys: true })` does, and every run counts them (`rekey-repair.md`) (§17.2) | confirmed |
| D34 | A default source prunes when the accessor pins the whole primary key, as the issue says (§7) | confirmed |
| D35 | `fanOut.pruned` speaks for the current layout: it can be `true` while a `previous` layout is read whole (§7) | confirmed |
| D36 | Removing `by` at an unchanged `count` is a boundary now that full pins prune: such a query misses unmoved rows until `rekey` has moved them (§8) | confirmed |
| D37 | Request sizing and refills stay as they are after the AWS measurement (26 requests, 2.1 s p50 for a page of 100 over 20 shards, §12). Measuring small pages is tracked in [#185](https://github.com/jmenga/effect-dynamodb/issues/185) | owner: leave sizing as it is, measure first, see [#185](https://github.com/jmenga/effect-dynamodb/issues/185) |
| D38 | Two key halves in one attribute must compose the same text for every item: `EDD-9106`. Its extension to unsharded halves was reversed by D49, and D61 restores it with D50's proof | confirmed |
| D39 | The type level refuses a sharded `pk.field` equal to the table's `pk` or `sk`, any index's `sk`, or an unsharded index's `pk`. Two sharded indexes that differ, and non-literal `field`s, are caught at runtime only (§17.3). So is every pair with nothing sharded (D61): literals can't prove two halves the same, and a type-level check that disagrees with the runtime would be worse than none | confirmed |
| D40 | An update that changes `by` when the sort key half can't be recomposed fails with `EDD-9100`, on the standard and `append` paths, **even when the value named is the one already stored**, as no read is sent (§5 case 6a, §17.4) | confirmed |
| D41 | An item legitimately lacking a sort key composite can't have its `by` changed until the update includes that composite or `.remove()`s it (§17.4) | confirmed |
| D42 | ~~**Superseded by D76.**~~ Under `previous: 1` with the fallback on, a shard is read under both texts when the pins' text differs, and only then: twice the requests during the migration (§9.3) | confirmed |
| D43 | `rekey` rewrites truncated 1.36 sort keys, on every index, in the same update as the partition key (§9.2) | confirmed |
| D44 | ~~A sort key `rekey` can't rewrite and that can only be 1.36 text is the conflict `"legacySortKey"`~~ **Superseded by D58**, which removes the conflict | superseded |
| D45 | The same `rekey` run compares a row it moved from a 1.36 table key (§9.2) | confirmed |
| D46 | Leaving `previous: 1` requires a `rekey` that reports no conflicts: documented, not enforced, since nothing at `make` can know (§9.3). A clean run doesn't promise a pin on a key that isn't its own 1.36 text, as when a row has cleared a composite or the key lags its values (D58) | confirmed |
| D47 | Unbound `Query.where()` undoes pruning and reads every partition, including `previous`'s. Internal callers whose condition stays under the pins use `Query.whereUnderPins` (§17.6) | confirmed |
| D48 | ~~**Superseded by D76.**~~ With the fallback on, on any index, a row whose key an index policy left stays visible to pins whose text changed: the current read rejects a row only at its own 1.36 text (§17.5) | confirmed |
| D49 | ~~`EDD-9106` judges only pairs with a sharded index among them. Precision is impossible for two unsharded halves: whether two different texts clash depends on data a definition can't show, and two accessors on one index over composites no item holds together is a working pattern. Refusing them would break definitions in a minor release. Every sharded pair is in a new definition, so refusing one breaks nothing~~ **Superseded by D61**: an ordinary update corrupts such a pair, including a row that only ever used one accessor (§17.8) | superseded by D61 |
| D50 | A shared attribute is allowed only when the two halves are provably the same: the text a half composes with a stand-in for each value, from the composers themselves, plus the exact shard count and source, or a Z-order half's full declaration. A probe can't prove it, and the case it let through was destructive (§17.7) | confirmed |
| D51 | `Entity.make` refuses what no schema can reconcile; `Table.make` decides a casing left to the schema, before it binds anything. One entity on two tables is judged by each table's schema, so one can accept it and the other refuse, and a refused table leaves its members bound as they were (§17.7) | confirmed |
| D52 | ~~A casing or an escape reaches a composite unless the model pins it to `number` or `bigint`.~~ **Superseded by D69:** halves compare their effective casing whatever they hold | superseded |
| D53 | An update never writes a table key attribute, and history rows never lose one, whichever index's half is stored there. Every update on an entity with a local or inverted index was refused by DynamoDB until now (§17.9) | confirmed |
| D54 | ~~`"legacySortKey"` judges a composite as a number when the model declares it so~~ **Superseded by D58**: nothing judges a cleared value, by its text or by the model | superseded |
| D55 | A dry run judges the row the move would write, reporting for it what the real run would, a move that would fail included. ~~It doesn't simulate chains, so a row whose destination is held by a row that can't move may be predicted as moved (§17.11)~~ **That limit is superseded by D88** | confirmed, in part |
| D56 | ~~A new conflict reason, `"legacyPartitionKey"`~~ **Superseded by D58**, which removes the conflict | superseded |
| D57 | `rekey` calls a row under both keys only if it's still at the old one when it finds it at the new one (§17.13) | confirmed |
| D58 | `rekey` compares with what 1.36 composed (each form's text, since D79), and never parses. An unsharded partition key, any sort key and a vector partition are rewritten only when the stored key is exactly their own 1.36 text and that isn't the current text; a sort key missing a trailing composite is judged by the composites before the gap (D43). A sharded partition key stays compose-and-compare (D24). Anything else is left with no conflict, and since `rekey-repair.md` counted in `indexKeys` and repaired only under `repairIndexKeys`. **The accepted limit:** a key that isn't its own 1.36 text stays, so a row that cleared a composite, or whose key lags its values, is missed by a pin once the fallback or `previous` goes, when its text changed in 1.37 (§9.2, §17.10, §17.15). It replaces D44, D54 and D56 | confirmed |
| D59 | A retained update leaves an index it skipped as stored, as the standard path does. Its Put-style fallback is gone: an index it reached always lacked a composite, so it only ever deleted, and deleted entries `preserve` had kept (§17.14) | confirmed |
| D60 | ~~A move leaves an attribute two accessors of unsharded indexes share as stored~~ **Rejected:** it regressed ordinary lazy moves, as a plain update on a healthy 1.36 row kept the shared key's 1.36 text beside the other half's current text, and a pin missed the row with the fallback on. It's reverted, so a move behaves as at #181 (§17.15) | rejected |
| D61 | `EDD-9106` judges every pair of key halves in one entity, sharded or not, It reverses D49 and restores D38's intent with D50's proof; the rule's stages (D51) don't change, and D52 isn't widened. **Behaviour change:** a definition whose halves don't have the same fields, order and casing now throws at load, including two accessors over composites no item holds together, which worked for `put` and query until an ordinary update corrupted them (§17.8) | proposed — awaiting owner confirmation |
| D62 | ~~An index half stored in a table key attribute, with the table half's composites, order and casing, **is** that table key: bound on the definition, composing the table half's text, with a sort key in partition key text refused for a range before the last composite (`EDD-9107`).~~ **Superseded by D64 to D68:** with one rule for every key, both roles build the same text, so nothing needs binding. `bindTableKeyHalves`, `IndexDefinition.tableKey`, `EDD-9107`, the `.within()` `keyCondition` branch and its `ineligible` reason are gone (§17.16) | superseded |
| D63 | An update can't remove a primary key composite. `.remove()` and `Entity.remove` fail with the `ValidationError` a `.set()` of it gets, and `.remove()` and the path operations also refuse one by the attribute it's stored in, as each takes any string. On DynamoDB Local the `REMOVE` kept the key and lost the attribute, so the row stopped decoding for every reader, and a transaction reported success. The composer's `removes` filter stays: a row already damaged still reaches it through a move (§17.9) | confirmed by the brief replacing D62 |
| D64 | **Default superseded by D77: off, opt in.** Every key under the setting: partition and sort keys use one `%hh` rule (`KeyComposer.keyText`), for table keys, index keys, collections, aggregates, event streams, unique-constraint sentinels and vector partitions. The structural parts of a key aren't: the prefix, labels, shard marker (§17.17) | owner |
| D65 | **Superseded in part by D77 and D78: numbers follow the flag, and off is the default.** One flag, full on or full off: `DynamoSchema.make({ escapeKeys: false })`, next to `casing` and `legacyKeys`. Off means no string escaping in any key: `escapeKeys: false` stores the 1.36 text for strings; numbers keep the form they have had since 1.37. There's no partition-only mode. Stored only when off, so a schema without it is what it was. It covers strings only: the number encoding from 1.37 stays either way, which measuring confirmed is right, since the byte comparison holds with it (§17.17) | owner |
| D66 | **Off has accepted limitations, with no machinery and no refusal:** a range on a non-last sort key composite can return wrong rows when a value holds a character below `#`; a `#` in a value can imitate a segment; skip-scan over free-form strings can hide rows. Measuring added: `gt` under a pin on the last composite can miss a longer value continuing below `#`, as real 1.36 code does (§17.17). D78 and D82 add the rest | owner, with one found measuring |
| D67 | ~~**Version stays 1.38.0**~~ **Superseded by D80** | superseded |
| D68 | **Inverted indexes are supported but not encouraged.** The library's principle is dedicated GSI attributes, and the docs say so. With one rule, both roles build identical text with the flag on or off, so they need no special case (§17.16) | owner |
| D69 | **One entity can't use one physical index twice**, even over identical fields: `EDD-9108`, at `Entity.make`. An item has one key in an index, so the second accessor can't have its own. Different entities sharing one stays fine. **`EDD-9106` is reworded around fields:** two halves share an attribute only with the same fields, order and casing, and a sharded partition key only with one sharded the same way. The comparison stays composer-based: comparing fields alone would miss a collection's label and an isolated or clustered form, which compose different text over the same fields. D52's exception for numeric composites is gone, as the rule names casing: two number-only or numeric Z-order halves with different casings compose the same bytes, and are refused now, where they passed under D52. Align their casing, or give each an attribute. `EDD-9107` is retired and not reused | owner, proof kept by measuring |
| D70 | **Never set any part of the primary key, on any write path, whatever the index structure.** `rekey`'s table key guard is back, as a concurrent writer could change what a shared half composes, and its retry then sent `SET sk`. Aggregate `rekey`'s `indexFields` exclude the partition field and `sk`. `test/NoTableKeyWrites.test.ts` records every update across inverted, shared `sk`, sharded shared `sk`, local and dedicated definitions, and fails if one names a table key attribute. In `DESIGN.md` and `CLAUDE.md` (§17.18) | owner |
| D71 | **`rekey` recognises 1.37's form, and reads don't (D76: no read looks for any other text).** One comparison, `(schema137 pk, current sk)`, for every row kind, `then137` for an index partition key and vector partition, `oldPosition` for an aggregate and its root's 1.37 partition, `pk137` for a stream. An aggregate root under no key its values have had counts in `skipped.unrecognizedKey`, so no partition is passed over silently. A read would have to query a third key text on every miss for a window of hours, so the upgrade note says to run `rekey` first (§17.17) | scoping call, for review |
| D72 | **A command's sort key stays raw**, under both settings: it holds an id only ever read by its exact key, so nothing depends on its order or segments, and escaping it would lose old sentinels unless each check read two keys, which would let a command apply twice on a miss. Its stream's partition key is escaped | scoping call, for review |
| D73 | ~~Until `rekey`, every operation tells two values sharing a partition's text apart by the row's values~~ **Superseded by D76.** Nothing checks whose row it finds; a review's scenario of `foo bar`'s `delete` destroying `foo%20bar`'s aggregate is what the owner accepts until `rekey` finishes, and the docs say so | superseded |
| D74 | ~~A unique claim of `foo%20bar` while `foo bar` holds its current key stays a false conflict until `legacyKeys: false`~~ **Superseded by D76**: nothing checks another text | superseded |
| D75 | ~~A range on a changed partition reads the current key only~~ **Superseded by D76**: everything does | superseded |
| D76 | **No backwards compatibility for key text.** Every read and write that used or looked for a key's older text in normal operation is gone: the second read in `get`, the second query, history readers' older-text lookups, `update`'s move on first write, `delete`'s second delete, `put`'s transaction and displacement, and the same in `Batch`, transactions, aggregates, streams and sentinels; `legacyKeys` and its types; the row checks that existed only for it (`keyPassesPlanner`, `partitionRows`, `isForeignRoot`, `placeStream`, `aliasGuard`, …); and the cursor mode for a query that read both keys. `ItemNotMoved` and `EDD-9097` are retired, and the number stays unused. Every operation sends the same requests for a changed value as for an unchanged one, pinned by `test/KeyRequests.test.ts` under both settings. Before `rekey` finishes on existing data nothing is promised (§17.17) | owner |
| D77 | **`escapeKeys` is off by default for all of 1.x, and you opt in with `escapeKeys: true`.** On by default is planned for the next major. A schema that doesn't set the flag composes the text 1.36 composed, so upgrading from 1.36 or earlier needs nothing | owner |
| D78 | **Off means exactly 1.36 key text, for strings and numbers.** With no fallback, a 1.36 row with a negative, fractional or large number would otherwise be unfindable under the default. Time-series event keys follow (`KeyComposer.eventOrderByValue`). Pinned against `key-text-1.36.0.json` through the real composers and `rows-1.36.0.json` through every key path | owner |
| D79 | **`rekey` is the only migration, and complete in both directions.** It moves rows to whatever the setting composes: off moves rows 1.37.0, 1.38.0 and on wrote back to 1.36 text; on moves rows 1.36, 1.37.0, 1.38.0 and off wrote to escaped text. Every row is moved or counted, a dry run agrees, a rerun changes nothing, and the chain overwrites and merges nothing either way (§17.17) | owner |
| D80 | **1.39.0, a minor**, on the Effect 4.1 base (#192), which took 1.38.0. Rows 1.38.0 wrote count the same as 1.37.0's, in the docs and in the tests | owner |
| D81 | **`NaN` under off composes `0000000000000NaN` (then cased), as the fixture pins, with no `EDD-9096`,** and a bigint over 1,000 digits its digits. `EDD-9096` stays under on, where a row holding one counts in `skipped.unrecognizedKey`. A `NaN` shard source fails under either: sharding is new, so there's no 1.36 text to keep. A `Schema.Number` `NaN` attribute on a `put` dies in the marshaller, as in 1.36 | scoping call, for review |
| D82 | **Under off, a partial pin, `.where(eq)` and `.within(eq)` on a non-last composite of a secondary index send 1.36's `begins_with(prefix#)`** (`pinCondition`), not the subtree `BETWEEN`. Without escaping the range would return a longer sibling, and only a row check could drop it. So a row truncated at that composite isn't returned under off: §17.1's fix holds with `escapeKeys: true`. The hierarchy demo in `guides/index-policy.mdx` says so | scoping call, for review |
| D83 | **Public `KeyComposer.serializeValue` and `extractComposites` keep their 1.37 numeric meaning,** and `compositeText`, `keyValueText` and `extractKeyComposites` follow the setting. A 1.36 caller of either sees the numeric form it saw in 1.37: recorded in the changelog. `sortKeyText` and `serializeSortKeyValue` stay as deprecated aliases, and `composeEventSk`'s 3-argument form as a deprecated overload | scoping call, for review |
| D84 | **A cursor isn't translated.** A plain cursor from the other setting finds no rows or DynamoDB refuses it; a fingerprinted one is `EDD-9094`; a two-key cursor (field `p`) from 1.37.0 or 1.38.0 is `EDD-9094` on any query (§17.17) | scoping call, for review |
| D85 | **An aggregate's root moves last,** so a run cut short leaves it where the next run finds the aggregate. An aggregate update during the move fails `AggregateAssemblyError` and writes nothing, and a delete deletes the edges already at the current key while the root still arrives: nothing is promised until `rekey` finishes, and a test pins it. The current version's snapshot no longer moves in its item's transaction: the scan moves it | scoping call, for review |
| D86 | **What's found below no root is judged after the scan** (`RekeyMember.finish`, `rekeyRowBelowRoot`, `rekeyFinish`), so a dry run agrees with the real run whichever order the scan met them. What can't be placed is counted on every run: an orphan sentinel (`skipped.unrecognizedKey`, at one or two extra reads per sentinel), orphan aggregate edges, and a 1.37.0 or 1.38.0 crash state (root at the current key, edges at the old partition). A run that hasn't read the whole table (`maxPages`, `resume`) can't say a root isn't there, so it reports such a row in `skipped.rootNotSeen` and a run over the whole table judges it (`rekey-repair.md`) | scoping call, for review |
| D87 | **`RekeyReport.conflicts` lists a row once per run,** and a row whose destination holder can't move stops retrying and reports `taken` (`cantMoveHolder`). With a drainer-held outbox item under off, the other value's item bound for that key stays too. A stream's move filters by `streamId`, so another id's rows in a partition are its own, and a multi-composite id holding `#` written under off that reads two ways under on is a `failed` conflict | scoping call, for review |
| D88 | **A dry run follows the chain,** on every kind of row (`Rekey.displace`), superseding D55's limit: what holds a row's current key is judged by its own handler, counting nothing, and what would stop it stops the row in the dry run too. An item at its current key that a chain reached before the scan counts `unchanged` only on its first visit, so the two runs agree there as well (§17.11) | scoping call, for review |

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
| Pruning when every source attribute is pinned | in | `by` and the default source alike (§7, D34). Pins only: boundaries below |

### Proposal: `by`, adoption, validation

| Issue item | Scope | Note |
|---|---|---|
| `by` replaces the source | in | |
| `by` must be sort key composites, checked by type and `Entity.make` | in | `EDD-9102` |
| `by` required when the half is composed | in | §5, with the policy interactions decided; the cases that write no key are listed under boundaries |
| `by` change moves the entry | in | |
| Docs warning on coarse `by` values | in | Guide |
| `previous` transition: writes new, reads both, merged | in | |
| `rekey` pass | in | §9.2, including truncated sort keys; what it leaves alone is reported, and listed under boundaries |
| `rekey` keeps dry run, segments, resume, conflicts, capacity | in | |
| `rekey` moves only index key attributes, conditional on unchanged item | **changed** | Guard covers the key's inputs, not the whole item (§9.2) |
| Remove `previous` | in | Documented step, after a `rekey` that reports no conflicts (D46) |
| `count` integer ≥ 2 | in | Plus the cap (§10.1) |
| Nothing-to-spread rejection, with or without `by` | in | `EDD-9101` |
| `previous` positive integer ≠ `count` | in | |
| Collections agree on `count` | in | Plus `previous` (§11) |
| v1 rejects `GeoIndex`, `.within()`, skip-scan | in | Plus `.zorder()` (`EDD-9104`) |
| Cost table and N rule in docs | in | Latency row corrected by the AWS measurement (§12) |

### Testing

| Issue item | Scope | Note |
|---|---|---|
| Schema unit: golden vectors, every write path, missing source, definition errors | in | |
| Mocked client: request counts, merge order and ties, `fetch` chains, cursors, pruning, `previous`, `concurrency` | in | Plus a randomised brute-force check |
| Connected: thousands of items over 16 shards | in | |
| Connected: adoption on a populated index | in | |
| **On AWS throughput check** | in, once | A one-off run at `2fc7bc6` on a real on-demand table in us-east-1, not CI: 2,000 WCU/s on one logical key over 20 shards for 6 minutes with no throttling, against about 1,000 WCU/s and heavy throttling unsharded. §12 has the results, including the throttling during the step to 3,000 WCU/s |

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
| `by` in v1? | Yes (D1) |
| Spelling, default and compact | §2; compact recorded, not built (D2) |
| Name of `previous` | Kept (D3) |
| Upper bound on `count` | 256 (D4) |

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
| Collections never prune | Each member has its own source (§7, D10) |
| A default source prunes only where the index's keys hold the whole primary key | Accessor pins are the index's composites, so a composite outside them can't be pinned (§7) |
| Removing `by` at an unchanged `count` can hide rows from a full primary key pin until `rekey` has moved them | §8, D36 |
| "`by` is required" means "when the half is composed": a `put` without it is sparse (D26), `.remove(["by"])` drops the half (D7), an unrelated update is a noop (D8), and clearing it under `sparse` removes the half (§5 case 7) | None of them writes an unsharded key |
| The `rekey` sharding pass covers sharded PK halves; other index keys keep #181's rule, over the composites their values lead with | §9.2 |
| A key half shares an attribute only with a half of its entity with the same fields, order and casing, sharded or not | `EDD-9106`, D50, D61, D69: a row can't show which owns it, so the one written last overwrites the other, and an update corrupts even a row that only used one |
| A definition that worked for `put` and query with exclusive accessors, as two accessors on one index over composites no item holds together, now throws at load | Comparing definitions can't see the data, and an ordinary update broke such a pair anyway (§17.8, §17.15). Give each half its own attribute, which means a new index, and re-put existing rows |
| A row 1.37.0 or 1.38.0 wrote with an overwritten `pk` stays unreachable by `get`, and a re-put leaves the old row beside the new one | §17.16: nothing on the row says what the text meant. The repair pass is tracked in [#185](https://github.com/jmenga/effect-dynamodb/issues/185) |
| A composite counts as unable to hold cased or escaped text only when the model pins `number` or `bigint` | D52: a false refusal has a clear fix, and a false pass overwrites a key |
| `Entity.make` passes a definition that only some schemas can take; `Table.make` refuses it under the others | The schema's casing isn't known until then (D51) |
| A secondary index key `field` equal to a model attribute or a vector index's partition attribute isn't checked | Not part of this fix; not examined further. A model attribute in a table key attribute is refused (`EDD-9109`, §17.18) |
| Type-level refusal stops at what literals show: two sharded indexes that differ, and non-literal `field`s, are runtime only | D39 |
| Naming the stored `by` value in an update with a hole in the sort key is refused | No read is sent to tell it's the same value (D40) |
| An item that legitimately lacks a sort key composite can't change `by` until the update includes or removes it | D41 |
| An `append` with `by` and without the sort key's other composites fails at runtime on every call | Nothing at `make` checks it. A definition check is tracked in [#185](https://github.com/jmenga/effect-dynamodb/issues/185) (§17.4) |
| Reads under `previous: 1` double their requests on pins whose text changed | §9.3, D42 |
| Leaving `previous: 1` needs a `rekey` that reports no conflicts, and nothing enforces it | §9.3, D46 |
| `{ count }` with no `previous`, over a populated index, reads neither the old layout nor its 1.36 text | As before: `previous` is how old rows stay readable (§9.3) |
| Until `rekey`, a row that doesn't hold its partition's composites can't be told apart by its values, and is kept: an index not projecting them, a stream index with `projection: "keys"`, a projection's row tombstone in a purge, an aggregate's edge rows with no root | D73: the check reads what the row holds, and adding a read per row for a window `rekey` closes costs more than it saves |
| Until `rekey`, a write that can't move the other value's rows is a false conflict that writes nothing (`ItemNotMoved`, `ConditionalCheckFailed`, `VersionConflict`, `UniqueConstraintViolation`) | D73, D74, §17.17 |
| A key that isn't any form's text stays, as when a row cleared a composite or the key lags its values. When its text changed, a pin misses it, a broader query finds a sort key half where its old text sorts, and `get` reads a partition key half | §9.2, D58: nothing on the row says what the text meant, and reading it from the text is what §17.10 removed |
| A run that moves a row catches a lagging key up. A run that leaves the row where it is doesn't | §9.2: a move recomposes as an update would, as it has since #181 |
| `.where()` bounds other than `eq` and `beginsWith` have no 1.36 pass, and the unbound `Query.where()` drops the 1.36 read | Existing since #181 (`LegacyKeyQueries`), now on shards too |
| After `rekey`, a row that can't compose a key stays where it is: a conflict when it's in another layout, left alone in the current one | D18, D24. "No stored key stays unsharded" holds for rows that can compose |
| The move path keeps a row's key when `by` is absent | `onMissingShardSource: "keep"` (§5): the row has nothing to hash |

### Audit of the "in" rows

The default-source narrowing (§7) was marked "in" with nothing listing it, so every "in" row above was
read against its design section. What that found:

| Row | The design said | Outcome |
|---|---|---|
| Pruning | The default source never prunes | **Implemented** (§7, D34) |
| Pruning | Collections never prune (D10, §7, §11), not in the boundaries table | Listed above |
| `by` required | D26, D7, D8 and §5 case 7 each write no key where the issue reads as a failure | Listed above. Each writes no unsharded key, which is what the rule protects |
| `rekey` pass | Sharded PK halves only; uncomposable rows stay (D18, D24), so "no stored key stays unsharded" has an exception | Listed above |
| No unsharded fallback | The move path's `onMissingShardSource: "keep"` can keep a row's key when `by` is absent | Listed above |
| `Entity.query.<index>` (§11) | "Fans out", which the fix made wrong | Corrected: it prunes like the accessor |
| Removing `by` (§8) | "Safe", which the fix made wrong | Corrected, and listed above (D36) |
| Cost table (§12) | Latency "about the slowest shard" and "up to N partial pages", which the AWS measurement contradicts | Corrected (§6.3, §12) |

The other "in" rows match their sections: merge, ties, cursors (the integrity boundary was already
listed), `.maxPages`, `.zorder()` and Z-order `by`.

### Audits behind §17.3 to §17.6

| Question | Where | Finding |
|---|---|---|
| Which write paths can leave a 1.36 sort key in a shard? | `update`, `Transaction.transactWrite`, `append`, retain, `put`, `Batch.write`, the 1.37 move, `rekey` | §9.3's table. Each is covered by a test on a recording table and on DynamoDB Local |
| Which key attributes can a half on a sharded index overwrite? | Table `pk` and `sk`; another index's `pk` or `sk`; its own `sk`; a sharded one with another count, source, composites, casing or collection; a Z-order half with another layout | All refused (§17.3, §17.7), and so is the same with nothing sharded (§17.8). The same fields, order and casing stay legal, including an inverted index (§17.16) |
| Which paths write or strip a table key attribute through an index half? | `composeIndexKeys`, the update composer, `gsiKeyFields` (snapshots, tombstones, events), the retain path's dropped entry, `rekey`'s in-place rewrite, aggregate `rekey`, the move | The composer's result is filtered and `gsiKeyFields` lists none (§17.9), the dropped entry is gone (§17.14), `rekey`'s guard and aggregate `rekey`'s filter are in place, and `test/NoTableKeyWrites.test.ts` holds it across them all (D70, §17.18). The move writes the row under its new key, which is how a key changes |
| Which update operations reach a primary key composite? | `.set()`, `.remove()`, `Entity.remove` and the path operations, each by model name and by stored name | `.remove()` by either name and path operations by stored name did, leaving a row that doesn't decode. All refused (D63). `.set()` by stored name writes nothing to it |
| Which definitions reach a client without `Table.make`? | `_configure` is called only by `Table.make` and `carryConfigure`, which copies its result | None (§17.7) |
| Which halves can a row lose the value of and keep the text of? | An unsharded index's sort key and partition key; a sharded index's sort key; a sharded partition key; a vector partition | All left with no conflict, and pinned on both tables (D58, §17.10), but for a sharded partition key in another layout, which is `"uncomposable"` |
| Which paths compose every index from a whole row, where an attribute two accessors share goes to the later one? | The move, the retain path, `put` and its kin | Every definition that could reach them is refused now (D61, §17.8), so halves in one attribute have one definition, compose the same bytes, and the order doesn't matter. `rekey`'s in-place pass doesn't compose a whole row: it judges each half by itself (§9.2) |
| Which `ChangeFeed` tests assert on state a fiber is still on its way to? | All of them, at `MaxOpsBeforeYield` 16 to 2048, five rounds | Two (§16) |
| Which combinators can change the sort key condition after pruning? | `skConditions` is written only by `make`, `scan`, `where` and the planner | Only `where` (§17.6). `.within()` and Z-order plans are refused on a sharded index, `planEmpty` drops the fan-out, and collections compose with `prune: false` |
| Which paths can change `by` with a hole in the sort key? | Standard update, `append`, retain, computed | Standard and `append` refuse. Retain and computed read the item and compose it; a real gap refuses there too (§17.4) |

## 16. Testing

- **Schema unit (`packages/schema/test`):** golden vectors for the hash and marker; the fold's
  properties over all code points; every canonical shape through the composer (§5 table included);
  definition errors; type-level `by` checks.
- **Entity level (`packages/effect-dynamodb/test`):** the sharded key on `put`, `create`, `upsert`,
  `update`, `patch`, retain, `append`, `restore`, `Batch`, `Transaction`, move, `rekey`; missing
  source fails with nothing sent; the six original canonical shapes plus Z-order shapes 7 and 8.
- **Where the shapes live:** unit in `packages/schema/test/Shards.test.ts`, entity level in
  `packages/effect-dynamodb/test/IndexPolicyV3.test.ts`, connected in
  `packages/effect-dynamodb/test/connected.sharding.test.ts`.
- **New degenerate fixtures:** 9a, an empty PK half with `by`; 9b, a `by` attribute in the primary
  key as well, so it arrives through `keyRecord` but is not a touched dependency; 9c, a default source
  with an empty PK half, whose value differs per item though the half has no composites.
- **Mocked client:** per the issue, plus randomised brute force: random partition contents and `by`
  distributions, duplicates across shards, filters and page sizes, with `fetch` chains whose limits
  land anywhere; concatenated pages equal `collect()` equal a brute-force sort, forward and reverse.
- **Connected:** per the issue, and the canonical shapes.
- **Shape 10:** unit in `KeyComposer.test.ts`, entity level in `IndexPolicyV3.test.ts` (standard, retain,
  append), connected in `connected.per-half-gate.test.ts` (with shapes 1 to 6 unsharded) and
  `connected.sharding.test.ts`.
- **Truncated rows:** `connected.truncated-pins.test.ts`, under both settings, alongside `KeyComposer.test.ts`, `KeyText136.test.ts` and the
  language service's `KeyParity.test.ts`.
- **Default-source pruning:** `Shards.test.ts`, `ShardedQuery.test.ts` and `connected.sharding.test.ts`:
  a full pin on every row's shard, a partial pin, inputs in another case, typed composites through real
  puts, a cursor, `.where()` and `previous`.
- **Key attributes (§17.3):** `Shards.test.ts`, with `FieldNames.types.test.ts` in both packages for
  the compile errors.
- **Shape 9d (§17.4):** unit in `Shards.test.ts`, entity level in `IndexPolicyV3.test.ts` (standard,
  sparse, `.remove`, transaction, retain, retain with a gap, computed, `append`), connected in
  `connected.sharding.test.ts`.
- **Shards holding both texts (§9.3, §17.5):** `ShardedLegacyText.test.ts` on a recording table and
  `connected.sharded-legacy-text.test.ts` on DynamoDB Local, from one set of scenarios in
  `test/helpers/ShardedLegacyRows.ts`: every write path over whole and truncated rows, foreign rows,
  each row once, what `rekey` reports, request costs, and a brute-force merge over both texts.
- **`Query.where` (§17.6):** `ShardedQuery.test.ts` and `connected.sharding.test.ts`.
- **Merge order:** comparators against independent byte and fixed point orderings, and filtered `fetch`
  chains across reverse, `maxPages` and projection, in `ShardMerge.test.ts` and `ShardedQuery.test.ts`.
- **Ties:** across shards only, on the mock and on DynamoDB Local. Order among equal sort keys in one
  partition is DynamoDB's, and the mock's stable order is no evidence of it, so no test asserts that
  a reverse read reverses it.
- **`ChangeFeed.test.ts`:** the sleeps that could fail under load now await the signal they were waiting
  for, with the same assertions. Three remain that can't fail from load: a slow consumer, a real lease
  expiry, and a check that a held lease stays waiting. The lease-loss test's first rewrite still raced:
  its signal fired when the store answered, before the feed recorded the loss, so the assertion got
  `undefined` at `MaxOpsBeforeYield` 16. It now commits until the feed refuses, which only happens once
  the loss is recorded, and asserts that attempt never reached the store. It runs at budgets 16, 256 and
  2048. Running every test in the file at budgets 16 to 2048 found one more, written earlier: the feed
  ends once its shards are drained, so the last child lookups can lose that race and the count is at
  most 8, not exactly 8.
- **`EDD-9106` against its own truth:** `Shards.test.ts` takes every pair of 42 half shapes, sharded or
  not, and three schema casings, composes real items (mixed case, characters a sort key escapes, numbers) with the real
  composers, and asserts a pair is refused exactly when their bytes differ. So the rule can't refuse what
  is the same or pass what differs, for those shapes.
- **Key halves sharing an attribute:** `helpers/SharedKeyAttributes.ts` runs on a recording table and on
  DynamoDB Local, which is what refuses `SET sk`. New degenerate fixture **11** (§17.9) in
  `KeyComposer.test.ts`, there and in `connected.sharding.test.ts`.
- **Dry run:** `helpers/ShardedLegacyRows.ts` seeds 17 situations on both tables and asserts the report
  equals the real run's, whole; `Rekey.test.ts` does the same over its seeds of every row kind.
- **What `rekey` compares:** `helpers/RekeyComparison.ts`, on both tables. The composites of the `Kinds` model in each
  half (§17.10 lists them), and the 16 indexes of `SHAPES`, or three of them for `append`, through `put`, `create`, `Batch.write`, `upsert`, updates naming every composite, none or
  one, a removal, a clearing, a transaction's update, a retained update and `append`: after each, `rekey` judges every
  row, skips none, rewrites nothing, and the stored rows are equal to what they were, compared whole. Also a Z-order
  index, a table key attribute, labels that begin alike, and a dry run's chain (D88). On the recording table alone, a
  vector partition, and a write landing between `rekey`'s read and its write.
- **Two accessors sharing attributes:** degenerate fixture **13** (§17.15) is a refusal now, at `Entity.make` and
  `Table.make`, in `SharedKeyAttribute.test.ts`. `rekey`'s rule on such a pair moved to the same accessors with their
  attributes apart (`separatePairScenarios` in `helpers/RekeyComparison.ts`), on both tables. A pair whose shared halves
  compose the same bytes has `sameBytesMoveScenarios`: the row stays found through a move, by an update and by `rekey`,
  which is what D60 regressed.
- **An inverted index:** new degenerate fixture **14** (§17.16). `packages/schema/test/InvertedIndex.test.ts` on the definitions
  and composers: both roles identical on and off for every casing, `EDD-9108`, and a golden that every definition composes the
  bytes it did. `helpers/InvertedIndexes.ts` on a recording table and on DynamoDB Local, under both settings: values with a
  space, `%`, `#`, mixed case and non-ASCII under each casing; numbers and dates; `put`, `get`, an
  inverted query, a pin, `update`, `delete`, batch, transaction, retained versions, soft delete and restore, `upsert` and `append`;
  several composites; a 1.36 row end to end; and a row 1.37.0 or 1.38.0 overwrote. `test/InvertedIndex.test.ts` pins what an inverted query sends.
- **Every key escaped, or none** (§17.17): `packages/schema/test/EscapeKeys.test.ts` at the composers against the 1.36 golden
  vectors, under both settings, with the marker, the hash and shapes 1 to 6 and fixture 15. `helpers/EscapeKeyScenarios.ts` on a
  recording table and on DynamoDB Local: every key path in each casing against `fixtures/rows-1.36.0.json`, reads through each,
  the flag turned either way over stored rows, a sentinel in transition, shapes 1 to 6 and fixture 15 with values a key escapes.
- **New degenerate fixture 15:** both halves of one index over one composite, a value only of what a key escapes (`#`, `%`, `%23`,
  `%25`, a space, `# #`), at unit, entity and connected level, under both settings.
- **Rows 1.37.0 and 1.38.0 wrote** (§17.17): `releaseRowScenarios` and `connected.legacy-rows-1.36.0.test.ts`, what each published package stored; `helpers/Rows137.ts`, literal keys, for the mixes; on a recording table and on DynamoDB Local.
- **Requests** (D76): `test/KeyRequests.test.ts`, both settings. **Completeness:** `test/RekeyCompleteness.test.ts`, both directions.
- **The never-set rule** (§17.18): `test/NoTableKeyWrites.test.ts`.
- **The accepted limit:** in `helpers/ShardedLegacyRows.ts`, on both tables, for a cleared composite on both halves
  and for a key lagging its values: left with no conflict, missed by a pin, and found by a broader query or `get`, until a write puts it back.
- **A false `bothKeys`:** forced with the recording table's request hook (§17.13), since on DynamoDB Local it
  took one run in about eight, then 18 of 18 clean after the fix.
- **Each regression test was seen to fail** with its fix reverted. A mutation check over 20 reverts: the
  old gate predicate, `begins_with` for a subtree, pruning for `by` only, `EDD-9106` absent and ignoring
  the shard source, a `by` update leaving the sort key, `Query.where` keeping its pruning, the three
  callers that stay under their pins undoing it, a shard read under one text, no row check in a shard, a
  shard judged by its partition key, a row in both ranges returned twice, #181's row check, `rekey`
  requiring every sort key composite, a conflict not reported (a reason D58 has since removed), a
  move not judged, and a tie ignoring `reverse`. Its first run found two survivors, both closed: a count
  comparison that was dead code, as the marker spells the count, so it's gone; and a row in both ranges,
  which no test reached, so it has one now. A later check over §17.7 to §17.13 and the "a move isn't judged" revert, on
  the connected suite too for those touching key writes or `rekey`, ran 46 reverts, which all fail a test
  now. It found five survivors, all closed. Stripping a date's `from` was dead code, as it's held normalized,
  so it's gone. A row that was never on the index reaches the retain path's dropped entry, and has scenarios on
  both tables. A dry run reading back shows only on a chain of rows, which has a scenario. A string that makes
  a composed partition key read as 1.36's, and another row taking the old key during a move, have tests.
  A check of the comparison rule and D59 over 20 reverts, 18 of them on the connected suite too, all fail a test
  now: the old gate, a cleared half rewritten, a truncated key left or judged by current text, each kind of half
  left out of the comparison, a table key attribute rewritten, a missing key written, the first accessor sharing an
  attribute winning, a move not compared or its conflict unreported, the retain fallback back, and the composer
  writing a table key attribute. Its first run found two survivors, both holes in the fixtures, both closed: the
  one row moved over values that compose no shard always had another key to rewrite, so a move's conflict never
  had to open the gate alone; and no test dropped a half stored in a table key attribute, so the composer's filter
  on `removes` went unchecked.
  A check of the narrowed rule (§17.15), with D60 reverted, over 24 reverts, 20 of them on the connected suite too, all
  fail a test now, with no survivor. Restoring "rewrite if they differ" fails 27 tests on the recording table and 20 on
  DynamoDB Local, and putting D60 back fails 2 on each. The rest: judging by current text, no D43, a sharded partition key
  held to the 1.36 rule, a Z-order index's partition key compared, each kind of half left out, a table key attribute
  rewritten, a missing key written, each guard, a move not compared, a move's conflict or rewrite unreported, a move
  leaving a sharded partition key for the pass after it, the retain fallback back, and the composer writing or removing a
  table key attribute. A vector partition and three guards run on the recording table alone, and a sharded partition key
  reported as uncomposable in the current layout fails only there. An earlier run, with D60 in, found that a sharded
  partition key moving between layouts had no test on DynamoDB Local, which is closed.
  A check of D61 and D62 (since superseded, §17.16) with what's left of the earlier rounds, over 51 reverts, 47 of them on the connected suite too, all
  fail a test now, with no survivor. For D61: the shard filter back, which fails 20 schema tests, 2 on the recording table
  and 1 on DynamoDB Local, each stage refusing nothing, and a stand-in with nothing to escape. For D62: nothing bound, only
  one attribute bound, a sharded index's sort key bound, a half written through the index, each text form left out of a
  composer, of a key segment or of `.where()` and `.within()`, a half truncating, in `.where()`, in `.within()` and in each
  1.36 condition, a `gt` stopping at the delimiter, no `EDD-9107`, a `.within()` over an earlier composite taking one range,
  and a tupled `.within()` parsing the key. The first run found four survivors, all closed. Comparing composites when
  binding a half was redundant with the proof, which accounted for two of them, so it's gone. `rekey`'s guard on a table key
  attribute was removed then, wrongly (§17.18). A `.within()` treating the half as truncating showed only with the
  fallback off, which now has scenarios. 11 fail on the unit suites only: refusals, bytes that come out the same through
  the index, a needless 1.36 request, and paths a definable row doesn't reach on a real table.
  A check of the rules that replaced D62 (D64 to D70), one pass over 35 reverts, nearly all on the connected suite too: the flag ignored,
  never escaping, dropped by `make` and by `canSpell`; escaping left out of each key path (both halves, the prefix composer, a vector
  partition, a sort key prefix, an event sort key, a unique sentinel, a history range, a stream's partition and its own casing, an aggregate's
  partition, list keys and edge sort keys); no same-index refusal, or only with different fields; no shared attribute refusal at either
  stage, casing or shard form not compared; `rekey`'s guard removed, the composer setting or removing a table key, and the recorder
  blinded (no aliases, no transactions). All but one fail a test now. The first run had four survivors. Three were missing tests, all
  closed: the prefix composer, a vector partition and a bound `.history()` had no value to escape. The fourth is aggregate `rekey`'s filter,
  which no definition can reach (§17.18).
  A check of what's left after D76 to D88, on this base, over 52 reverts: each key form dropped from `rekey`'s judging, the inverted form swapped, a
  valueless mark read as off, marks never written, `pinCondition` and `compositeText` and `eventOrderByValue` forced to one setting, the chain
  (holder not moved first, a holder that can't move not reported, or reported and then cleared), `bothKeys` without rereading the old key, conflict
  dedupe, index key forms, Z-order prefix bytes, the table key guard, each sentinel form, every count of what can't be placed, an aggregate's root
  order, its waves, its 1.37.0 partition and `rekeyFinish`, a stream merging another id, `EDD-9109`, `EDD-9112`, `isTableKeyAttribute`, a second `get`
  for a changed value, and each part of `Rekey.displace`. All fail a test now, 35 of the first 41 on the first run. Its six survivors were all
  closed. Five had no row reaching them, now tested: a history row under a partition its values never composed, a stream row and a valueless row
  likewise, an edge gone by the end of the scan, and a stream with an event another id's write landed on it. The sixth, a holder reported and then
  cleared, showed D55's limit: a dry run predicted a move the real run refused, which D88 closes for every kind of row.
- **On AWS:** a one-off run at `2fc7bc6`, not CI (§12). DynamoDB Local shows keys, merges and cursors,
  never throughput.

## 17. Behaviours fixed in this PR

The first version of this PR reported §17.1 and §17.2 as observed and unchanged. Both reproduce
identically on 1.36.0 (`60014d2`), 1.37.0 (`31ec5da`) and this PR as first pushed (`2fc7bc6`), on unsharded
indexes. Both are bugs. Neither fix changes stored key text.

§17.3 to §17.6 came from an independent review of `c5874c0`, and §17.7 to §17.12 from one of the fixes it
led to; §17.13 and the partition key half of §17.10 came from writing their tests. §17.14, and the current
form of §17.11, came from a review of `230e499`, and §17.15 and the current form of §17.10 from one of `ac79b82`. D60's rejection,
and the correction to §17.10, came from one of `d635f2f`. §17.16 and the current form of §17.8 came from that review
too, and from a reproduction on `main`. Each one reproduced before it was fixed.

### 17.1 A pin on a truncated row's own level

`DESIGN.md` §7's structural rule stops a key at its last present composite, so
`update(key).set({ region, country, city }).remove(["block"])` stores
`gsi1sk = …#country_us#city_sf`.

| Query | Up to `2fc7bc6` | Now |
|---|---|---|
| `{ region }` | found | found |
| `{ region, country }` | found | found |
| `{ region, country, city: "sf" }` (its own level) | **`[]`** | found, with everything under it |
| `{ region, country }.where(eq(city, "sf"))` | **`[]`** | found, with everything under it |
| `{ region, country, city: "sfx" }` | only the sibling | only the sibling |

**Verdict: a bug.** It dates from 1.15.0 (#115), when a partial pin gained its trailing `#` to stop
matching `sfx`. No documented rule asks for it: the guide, connected scenario 9 and `DESIGN.md` all say
a demoted asset is "still queryable at city level via begins_with", but each asserted only at region
level. And `.where(between("sf", "sf"))` always included the row while `eq` didn't.

**Fix: the read side.** `BETWEEN <prefix> AND <prefix>#U+FFFF` selects exactly the row and its subtree.
Rejected: a trailing `#` on truncated keys, which would change stored text and need a migration.

**On unsharded indexes:** a partial pin, `.where(eq)` on a composite that isn't the last, and an `eq`
in `.within()` send `BETWEEN` instead of `begins_with` on a secondary index, and return truncated rows
they used to miss. The primary key is unchanged. **On stored keys:** none change, so rows already
truncated are found as soon as the reader upgrades.

**Under off (D82).** Text isn't escaped, so `city_new york` lies inside the range of a pin on `new`, and only a
row check could drop it. So off sends 1.36's `begins_with(prefix#)`, and a row truncated at that composite isn't
returned. This fix holds with `escapeKeys: true`.

**Cursors.** §17.17 has what a cursor from another release or setting does.
**Limit.** The high operand is four bytes past the prefix where `begins_with` was one, so a prefix
within three bytes of the 1,024-byte sort key limit is refused by DynamoDB. There's no client check.

### 17.2 A half waking through `keyRecord`

On `primaryKey: [channel, deviceId]`, after an unrelated `.set({ status })`, with no composite of these
halves in the payload:

| Half | Up to `2fc7bc6` | Now |
|---|---|---|
| `sk: [zone, deviceId]`, `'sparse'` | key **REMOVED**, item gone from the index | unchanged |
| `sk: [zone, deviceId]`, `'preserve'` | unchanged | unchanged |
| `sk: [deviceId, zone]`, `'preserve'` | key **truncated** | unchanged |
| `pk: [channel, zone]`, `'preserve'` | key **truncated**, item moved to another partition | unchanged |

`.append` does the same, because `appendInput` repeats the primary key.

**Verdict: a bug**, reported narrower than it is: it isn't limited to `sparse` or to sort keys. It dates
from v1.7.2 (#43), whose fix asked "is any composite in `keyRecord`?" The literal predicate and "Why
sparse still works" in `DESIGN.md` describe that, which is why it looked deliberate. But §7's own table
says "noop: no composite of this half is in the payload" and "Stamp → both halves preserved"; "sparse
only fires when the writer touches the half"; #43's title and shape 2 say "entirely"; and the idempotence
rationale holds only for a half whose every composite is immutable. Nothing pinned the overshoot: after
the change, no existing fixture depended on it.

**Fix: the predicate.** A half is skipped iff it has composites, none is removed, none is in the payload,
and at least one is unknown to `keyRecord`. Shape 10 is the new degenerate fixture.

**On unsharded indexes:** an update naming no composite of a mixed half leaves its key alone. An item
lacking the mutable composite no longer joins that index on an unrelated write: it joins when a write
names the composite. **On stored keys:** the text of a composed key doesn't change.

**Existing rows.** A row the old gate already damaged stays as it is, removed or truncated, until a write
names the half's composites or the item is put again (`connected.per-half-gate.test.ts` pins this). `rekey`'s text
rewrite doesn't repair them, in either text: a key truncated on a row holding all its composites isn't what 1.36 composed for
what the row holds, and a key the row doesn't have isn't written. Both tables pin both. A row truncated under 1.36
whose trailing composites it really lacks is the exception, and is rewritten (D43). `rekey` counts them on every run,
and repairs them with `repairIndexKeys` (D33, `rekey-repair.md`).

**Retain path.** Its `keyRecord` holds the whole item, so a mixed half with every composite present
recomposes to the key it has, which is idempotent. When both halves of an index are skipped there, the entry
stays as stored, as on the standard path (§17.14).

### 17.3 Two key halves in one attribute

With `primaryKey.pk: { field: "pk", composite: ["tenant"] }` and an index using
`pk: { field: "pk", composite: ["tenant"] }, shards: 8`, `composeAllKeys` wrote the sharded text over the
table's `pk`. `put` succeeded and `get` returned `ItemNotFound`. The unsharded version works, since both
compose the same text, and both compiled.

**Verdict: a bug.** The siblings were real too: an index's `pk.field` equal to the table's `sk`, its own
`sk`, or another index's `pk` or `sk`, sharded or not, with a different `count`, source, composites or
collection.

**Fix: `EDD-9106`.** Two key halves in one attribute must compose the same bytes for every item. §17.7 has how
that's decided, as this section's first version compared one made-up item, and §17.8 why every pair is judged,
sharded or not.

**At the type level:** a sharded `pk.field` equal to the table's `pk` or `sk`, any index's `sk`, or an
unsharded index's `pk` is a compile error on that entry. Two sharded indexes that differ, and non-literal
`field`s, can't be told apart from a valid case by the types, so they are runtime only, as is every pair with
nothing sharded (D39).

### 17.4 A `by` update that leaves the sort key behind

With `pk: [tenant]`, `sk: [region, group]`, `shards: { count: 8, by: ["group"] }`, storing
`{ tenant, region: "r", group: "a" }` and updating with `{ tenant, group: "b" }` moved the partition key to
group b's shard while `preserve` kept the sort key at `region_r#group_a`. After that no full pin reached
the row: a pin on `group: "a"` searches the wrong shard, and a pin on `group: "b"` has the wrong sort key.

**Verdict: a bug.**

**Fix: `EDD-9100`** (§5 case 6a). The shard and the sort key must never disagree, and only the writer can
supply the missing composite. New canonical fixture **9d**, in the unit, entity-level and connected
suites.

| Path | Outcome |
|---|---|
| Standard update, sort key half can't compose, `preserve` | Refused, nothing sent |
| `sparse` sort key half | The half drops: the item leaves the index, so nothing disagrees |
| `.remove(["region"])` | Cascades: the item leaves the index, under both policies |
| `Transaction.transactWrite`, `append` naming `by` but not the gap | Refused |
| Retain and computed paths | Read the whole item and compose it. A real gap is refused there too |
| `update` with no `by` in the payload | Unaffected |

What the owner should weigh: naming the value already stored is refused on the standard path, since
no read is sent to tell (D40), and an item legitimately lacking the gap composite can't change `by` until
the update includes it or `.remove()`s it (D41).

An update naming the sort key composites and no partition key is a separate refusal, case 2 or 4.

### 17.5 Rows left with sort keys under other text, and what `rekey` said about them

§9.3 has the design: a read looks under one text, and `rekey` rewrites or reports what's left. Over
`{ count: 8, previous: 1 }`, a row with `region_new york`:

| | At #181 | Now |
|---|---|---|
| `rekey` over a truncated sort key under other text | `indexKeysRewritten: 1`, `conflicts: []`, sort key untouched, **unreachable** after `previous` went | Sort key rewritten |
| `rekey` over a sort key an index policy left | `conflicts: []`, left | Left, with no conflict: it isn't what any form composed for what the row holds. That's the accepted limit (D58) |
| `rekey` moving a row from another table key text | Left a sort key for the next run | Compared in the same run |

A sort key truncated under 1.36 was never rewritten by `rekey` on any index (D43). That's fixed too.

### 17.6 `Query.where()` kept its pruning

`E.query.byTenant({ tenant, region, group: "a" }).pipe(Query.where(conditionForGroupB))` searched only
group a's shard, so an existing group b row was silently missed. The bound builder's own rejection didn't
protect the unbound API.

**Verdict: a bug.**

**Fix.** Public `Query.where` restores what the query would read with no pins, including `previous`'s
partitions (`ReadFanOut.everyPartition`), and reports `pruned: false`. A pin composed by an accessor or
`Entity.query`, and a bound `.where()` clamped under those pins, use the internal `Query.whereUnderPins`,
since they select only rows the chosen shard holds. `where` is the only combinator that can change the sort
key condition after pruning (audit in §15).

### 17.7 `EDD-9106` needs a proof, not a probe

The check in §17.3's first version composed one made-up item, lower-cased the result and compared. That
can't establish that two halves always compose the same text, and three destructive overlaps came through:

| Definition | Before | Now |
|---|---|---|
| A sharded index with `casing: "uppercase"` sharing the table's `sk`, the table inheriting lowercase | `put` overwrote `sk`, `get` returned `ItemNotFound` | `Table.make` refuses it. Accepted under an uppercase schema, and every read finds the row |
| Two sharded indexes sharing `gpk` over the attributes `tenant` and `Tenant` | The second overwrote the first | `Entity.make` refuses it |
| Two Z-order sort keys sharing an attribute, one composite, ranges `0..100` and `0..1000` | Passed, composing different bytes | `Entity.make` refuses it |

**The rule:** a shared attribute is allowed only when the two halves are provably the same (D50).

- **A text half** is compared by the text it composes with a stand-in for each value, from `composePk` and
  `composeSk` themselves, so the rule can't drift from them. A stand-in is unique to the exact attribute, so
  `tenant` and `Tenant` differ though they share a label. It's private-use text, so it's held as it is
  wherever it reaches a value. With one rule for every key, the same fields compose the same text in either
  role, so an inverted index passes here with no case of its own. The literals around them (schema prefix,
  entity type or collection, labels, an isolated or clustered sort key's parts) come from the composer, which
  is why this compares text rather than the fields alone: an isolated collection's sort key and a plain one
  over the same fields compose different text. Casing is compared as the half's effective casing (D69).
- **A sharded partition key** also needs the exact `count` and source. `previous` doesn't count: it changes
  what's read, not what's written.
- **A Z-order half** is compared by its prefix (field and hash) and every dimension's options in interleave
  order, with the half's casing compared as any half's is. A date's `from` is held normalized, so two
  spellings of one instant are the same. Text and Z-order are never the same.

**Where it runs (D51).** The schema's casing resolves an index that spells out none, and `Entity.make`
doesn't know the schema. So `Entity.make` refuses a pair only if it differs under every casing a schema can
have, and `Table.make` decides under the real one, as a sibling of `EDD-9069`, before it binds any member.
`Table.make` is the chokepoint: a client gets its schema only from there.

**One entity on two tables.** Each `Table.make` judges by its own schema, so one can accept the entity and
the other refuse it. The refused table throws before binding, so the entity stays bound to the table it had,
and valid members of the refused table aren't bound either.

**The boundary "compares letter case only when both halves declare casing" is gone**, since this destructive
case came through it.

### 17.8 Every pair of halves is judged

§17.3's first version refused any two halves that composed different text (D38). That broke a definition
that worked: two unsharded indexes with their own partition keys and different explicit `casing`, sharing an
identical numeric Z-order sort key, compose the same bytes because casing reaches nothing in them. It passed
on `c5874c0` and threw at `dfaad77`. §17.7's proof fixed that case, and D69 refuses it again, as the rule now names casing. D49 then stopped judging pairs with nothing
sharded, on the view that two accessors over composites no item holds together never clash, and that refusing
them at load was the harm the check was meant to prevent.

That view didn't hold. A row can't show which accessor owns a shared attribute, so no composer can be right, and
fixing writes means patching every path, which is how this kept regressing. A `put` of a pair like that does write
only the accessor whose composites are present, but an ordinary update then replaces one half and leaves a
mismatched pair, including on a row that only ever used one accessor (§17.15 has the cases).

**Decision: `EDD-9106` judges every pair of key halves in one entity, sharded or not (D61).** It restores D38's intent with
D50's proof. The rule and its two stages (D51) don't change, and comparing casing directly dropped D52's exception for
numeric composites (D69). The check runs per entity, so overloading one index
across entity types is unaffected.

**The behaviour change.** A definition whose halves don't have the same fields, order and casing now throws at load, where it worked for
`put` and query while its accessors stayed exclusive. To keep the access pattern, give each half its own attribute,
which means a new index, and re-put existing rows. §17.16 has what was measured.

**At the type level,** the sharded refusals stay as they are, and unsharded pairs are runtime only (D39): literals can't
prove two halves the same, and a type-level check that disagrees with the runtime would be worse than none.

Tests pin both directions: the numeric Z-order pair passes `Entity.make` and `Table.make`, two accessors sharing an
attribute throw at both, and with their attributes apart they work through real writes and queries on DynamoDB Local.

### 17.9 A half in a table key attribute

While checking what §17.7 allows: a sharded index's sort key sharing the table's `sk` with identical text is
legal, and then every update failed. DynamoDB answered `Cannot update attribute sk. This attribute is part of
the key`. **The same held on unsharded indexes, on any entity with a local index (its partition key is the
table's) or an inverted one**. By the code, that dates from 1.7.2's `keyRecord` arm, which started recomposing
halves wholly known from the key; it was run on this branch only, not on an old release. Nothing tested it, as
the only suite that would notice is the connected one.

**Verdict: a bug.** It's fixed here because what §17.7 allows must work (D53), and it's now a rule (D70, §17.18).

- `composeGsiKeysForUpdatePolicyAware` never returns a table key attribute, in `sets` or `removes`. A half
  stored in one holds what the table key does, composed of what an update can't change, so there's nothing to
  write, and dropping an index entry takes the other half, which is enough to leave the index. This is the
  central composer, so every update path has it. No gate logic changed.
- An update can't ask to drop a primary key composite any more (D63), but `removes` can still name such an attribute. Take a row an earlier
  release's `.remove()` left without the first composite of a table half, under a 1.36 key whose text changed,
  with that half `sparse`: its move recomposes from the row and reads the half as dropped. Without the filter
  the move's `Put` has no key, so DynamoDB refuses it, the update fails with `DynamoValidationError` and the
  row stays as it was. With it the row moves and the update writes and then fails to decode, as any update on
  that row at its current key does. `delete`, `put` and `rekey` do the same either way. So the filter isn't
  dead, and its pin moved to this route.
- `gsiKeyFields` no longer lists one, so a snapshot, tombstone or event keeps the attribute it would have lost
  on a shared `pk`.

**New degenerate fixture 11**, on `KeyComposer.test.ts`, on the entity through a recording table (which checks
the expression), and on DynamoDB Local (which refuses it): a sharded and an unsharded index's sort key in the
table's, a local index and an inverted one, each through updates, retained versions, soft delete and restore,
then a query; and a row leaving the index, on the ordinary and retain paths.

### 17.10 A value the row no longer holds

A 1.36 row with an optional numeric `score: -3`, then `.set({ score: undefined })`, which legally removes the
value and keeps the sort key. `rekey` moved the partition key into a shard and reported `conflicts: []`.
Removing `previous` then lost the row to a `score: -3` query: 1 before, 1 during, 0 after.

**The first fix classified the text, and is gone.** It read a stored key's segments by their labels, judged each
against the current number text using the model's kinds, and reported what looked like 1.36's as a conflict
(D44, D54, D56). A review of `230e499` showed the classification wrong in both directions, on every half: the
first label to match decided, so with a composite `score` and another `score_label`, a current key read as a
1.36 number and got a false conflict, and with a string `code` before a number `code_value`, a 1.36 number read
as a string and got none. Those could be patched, but it would still have left a value spelled like an escape
(`50%25` is the bytes 1.36 wrote for `50%25` and 1.37 writes for `50%`), a union of kinds, and a partition key
string holding `#` and a label. A stored key's text can't say what a value was, so nothing should ask it to.

**Decision (D58): compare with what 1.36 composed, and don't parse.** §9.2 has the rule. A half is rewritten only
when the stored key is exactly its own 1.36 text. A cleared value isn't judged at all, by its text or by the model,
and that half stays as it is with no conflict. Neither conflict reason had been released, so removing them breaks
nothing. `KeyText136` keeps composing 1.36 text from values, which the reads need, and no longer reads any. No read
path used the label lookup: `keepRow` and the row checks compare whole keys and prefixes (§9.3, §17.1).

**The accepted limit, pinned on a recording table and on DynamoDB Local.** After `rekey` and removing `previous`:

- **A cleared sort key half** (`clearedSortKeyLimitScenario`): `byTenant({ tenant })` finds the row, where its old
  text sorts: after a row holding `-1`, though it held `-3`. A pin on `-3` misses it.
- **A cleared partition key half on an unsharded index** (`clearedPartitionKeyLimitScenario`): a pin on `-3` misses it,
  and `get` reads it. An earlier version of this section pinned the opposite outcome, a
  conflict, and that test was changed deliberately.
- **A key lagging its values, in 1.36 text** (`laggingLegacySortKeyScenario`, `laggingPartitionKeyScenario`): the same
  outcomes, for a pin on the old value and for one on the value the row holds now.

Writing the composites puts the row back, in each. A positive integer's text is the same in both, so a pin on one keeps
working (`clearedIntegerScenario`).

**What's tested of the rule.** `RekeyComparison.test.ts` compares the stored rows whole before and after a run, on both
tables, for two fixtures:

- **The `Kinds` model:** a string, two numbers, `BigInt`, `BigIntFromString`, `DateTimeUtc`, `DateTimeUtcFromString`,
  `Date`, a `DateTimeUtc` with `storedAs: DateEpochSeconds`, a boolean, a literal, `NumberFromString` and a renamed field,
  each in both halves of an index of its own, through a `put`, an update naming them all and an unrelated update, on an
  ordinary and a retained entity. The other date encodings (`DateString`, `DateEpochMs`, `DateEpoch`, `DateTimeZoned` and
  the `Unsafe` forms) aren't in it.
- **The 16 indexes of `SHAPES`,** through each write path §16 lists but `append`, which has a model of its own and three
  of them (hierarchical, empty sort key, sharded). Shape 13 isn't among them: it has its own scenarios, through `rekey`.

That shows `rekey` leaves what those writes stored. It doesn't show that a write and `rekey` compose the same text for
every value, which the rule no longer depends on: a difference would leave the key alone rather than rewrite it.

### 17.11 What a dry run predicts

For a row needing a table key move whose index sort key can be recomposed, a dry run judged the keys before the
move and reported a conflict, while the real run wrote the right key and reported nothing.

**Verdict: a bug** (D55). What a move writes is now a pure step, `movedRowOf`, used by the move and the dry run.
A dry run judges that row and reports what the real run would for it: a rewrite, what's held back, or `"failed"`
for values that compose no key, with the same `key` and `target`. It doesn't read back: nothing moved, so what
that key holds, if anything, is another row, which the scan reaches itself. The test compares whole reports,
less `dryRun` and `capacity`, which differ by definition.

**A chain (D88).** This section first left a limit here: a dry run assumed a stale row holding a destination could
move. `a b` moves to where `a%20b` holds its 1.36 text, and `a%20b` can't move (its `status` is outside a Z-order
dimension's values), so the dry run reported a move the real run refused. With `rekey` the only migration, a dry run
has to agree, and it needs no state of a run it isn't doing: `Rekey.displace` runs the holder's own handler under a
context that counts nothing and claims nothing, and keeps only the conflicts. So both report the holder's conflict
and `taken` for the row it holds up, on every kind of row: items and history rows (`clearTarget`), sentinels,
projection rows, streams and aggregates. It costs a dry run the reads of each link, once more than the scan does, and
only on a chain. `dryRunChainScenarios` and `RekeyCompleteness.test.ts` pin both outcomes.

### 17.12 The lease-loss test

§16 has it. Production code is fine: `settle` checks the record first, and a failed write leaves the batch
unsettled. Only the test was early.

### 17.13 A false `bothKeys`

A new dry-run scenario, one row's current key holding another's 1.36 key, failed one run in about eight on
DynamoDB Local with `"bothKeys"`: "The row is also stored under its current key." It wasn't. `rekey` handles a
page's rows four at a time, so while one row's move was making room by moving the other, the scan's own fiber
moved that row too. One read the row at its old key, the other moved it, and the first then read it at the new
key and took that for a copy. Any concurrent write moving the row hits the same window, chain or not.

**Verdict: a bug, from #181's `rekey`,** and harmless to data: the row had moved, and a rerun reports nothing.
But a migration is told to stop on a conflict (D57). `clearTarget` now reads the old key again before it reports:
if the row isn't still there, it moved. A test forces the order with the recording table's hook, both with the
old key empty and with another row in it; the existing test keeps a real copy reported.

### 17.14 A kept entry on the retain path

A retained entity with an index partitioned by an optional `note`, sharing the table's `sk`. `.set({ note: undefined })`
removed the index entry, though `preserve` keeps it: an ordinary update did, and so did a retained entity with a sort
key attribute of its own. **A regression from §17.9.** Filtering table key attributes out of the composer's result
also took away the retain path's only sign that the index had been evaluated, and its fallback for an index the
composer said nothing about deleted the entry. It reproduced on a local index, an inverted index, and sharded and
unsharded shared sort keys.

It was also older than that, and wider. A kept half writes nothing, so a retained update clearing `note` on
`pk: [note], sk: [group]`, with `group` already gone, deleted the entry on any release; and even with the fallback told
about evaluated halves, the next `.set({ extra })` would have deleted it, since it evaluates neither.

**Decision (D59): the fallback is gone.** It reached only an index both of whose halves were skipped, so each lacked a
composite and it could never compose: all it ever did was delete. Nothing else needed that: an update that changes a
composite is always evaluated, and a row that never held one has no entry to delete. A retained update now leaves such
an index as stored, as the standard path does. No gate logic changed, and D53 holds, as the composer still returns no
table key attribute.

**New degenerate fixture 12** (`keptEntryScenarios`): each of those index shapes and one of the row's own attributes, on
an update, a retained update and a transaction's update: a new value moves the entry, then clearing a composite, clearing
the other and an unrelated update each leave it. On a recording table, on DynamoDB Local, and on the composer in
`KeyComposer.test.ts`. Shapes 9d, 10 and 11 were checked at the same three levels, and shape 10 gained a retained update
over a kept key.

### 17.15 Accessors sharing an attribute

Two unsharded accessors on one physical index, `byRegion` (`pk: [region], sk: [id]`) and `byGroup`
(`pk: [group], sk: [extra]`). `put({ id, region, group })` with no `extra` correctly skips `byGroup`, and `rekey` at
`ac79b82` then replaced `gpk` with the group partition and kept the region sort key. So did `put` with every composite
followed by `.set({ region })`. Both reported `indexKeysRewritten: 1`, `conflicts: []`, and the row left `byRegion`: one
row before, none after. **A regression from the first form of the comparison rule**, which composed each half and
rewrote it on any difference, with the later accessor winning. That doesn't reproduce who wrote the attribute, and a
row's values can't say.

**Decision (D58, as it stands now): back to #181's rule for everything but a sharded partition key.** At `31ec5da`, a half
was rewritten only when `stored === text136 && text136 !== text`, each judged by itself, which already compares and
already never asks who owns an attribute: a half only touches a key whose bytes are its own 1.36 text. A sharded
partition key stays compose-and-compare, since moving rows into the layout is the feature, and `EDD-9106` rules out
another accessor's entry in its attribute. So a key `preserve` left behind its values is left again, and a truncated key
on a row holding all its composites isn't repaired (D33). On the recording table, narrowing it failed five tests, all of which pinned the wider
rule, and nothing the sharding migration needs.

**D60 was tried here, and is rejected.** A move composes every index from the whole row, so a row can lose an entry, as
the table below shows. D60 left a shared attribute as stored on a move, and that regressed ordinary lazy moves. Two
unsharded indexes share `gpk: [score]` with separate sort keys, on a healthy 1.36 row
`{ id: "a b", score: -3, label: "x y" }`. A plain `.set({ note })` moved the table key, kept the 1.36 `gpk` and escaped
`gsk`, so a pin went from one row to none with the fallback on. It's reverted, so a move behaves as at #181.
`sameBytesMoveScenarios` pins that row staying found, on both tables. Its shared halves compose the same bytes, so it
pins nothing from the table below.

**Closed: these definitions are refused now (D61, §17.8).** Each case below was measured on a recording table, the same at
`31ec5da` and at `0150fe2`, and they're why no fix to the writes could be right. Each of these pairs now stops at `EDD-9106`
at load:

| Case | What happens |
|---|---|
| `.set({ note })` on a row holding every composite of `byRegion` and `byGroup` | `gsk` goes `extra_x` to `id_1` and `gpk` stays `group_team`, as `[id]` composes on every write (#43). A pin on `byGroup` misses the row |
| The same on a row that only ever populated `byGroup` | The same |
| A retained `.set({ note })` on a row in `byRegion` holding `group` with no `extra` | `gpk` goes `region_west` to `group_team` and `gsk` stays `id_1`. A pin on `byRegion` misses the row |
| A table key move of a 1.36 row in `byRegion`, here with `sk: [tenant]`, holding every composite of both | By an update, `gpk` takes `group_team` and `gsk` stays `tenant_t`, a mismatched pair. By `rekey`, the row becomes `byGroup`'s. A pin on `byRegion` misses it either way |
| `rekey` on `byName` (`pk: [name], sk: [id]`) with a sparse `byOther` (`pk: [other], sk: [name]`) storing its sort key in the same `gpk`, and `name: "a b"` | The healthy `gpk` has the bytes of `byOther`'s 1.36 sort key, so it's rewritten: `name_a b` to `name_a%20b`, `indexKeysRewritten: 1`, `conflicts: []`. A pin on `byName` misses the row. With the attributes apart it's left |

**Degenerate fixture 13** is a refusal now, at `Entity.make` and `Table.make`. `rekey`'s rule on such a pair is pinned on
the definitions that can still exist, with the attributes apart (`separatePairScenarios`): a sparse put, an update of one
accessor's composites, a put holding every composite, and a half that really is its own 1.36 text, in each half, which is
rewritten while the other stays. On a recording table and on DynamoDB Local.

### 17.16 An inverted index

An inverted index over strings broke in 1.37.0 and stayed broken in 1.38.0: they escaped sort keys and no partition key, so a half in each role of one
attribute composed different text. 1.39.0 fixes it. At 1.36.0 `put`, `get`, a query and `delete` work for every value (`update` didn't, §17.9).

**What 1.37.0 does to it,** on a recording table with the default schema, `primaryKey: { pk: [userId], sk: [groupId] }` and
an index `pk: { field: "sk", composite: ["groupId"] }, sk: { field: "pk", composite: ["userId"] }`:

| Item | What happens |
|---|---|
| `userId: "u 1", groupId: "plain"` | The index's sort key overwrites `pk` with `userid_u%201`. `get` and `update` fail with `ItemNotFound`, the inverted query finds the row, and `delete` reports success and leaves it |
| `userId: "u1", groupId: "a b"` | The index's partition key overwrites `sk` with the raw text. `put` fails with "the transaction touches one item more than once", as the row it writes is the 1.36 row it deletes |
| `userId: "u1", groupId: "50%"` | Works through their fallback, with `sk` stored unescaped |
| Plain values | Fine |

**D62 was this PR's first fix, and is superseded.** It made the half *be* the table key, with partition key text on a sort key,
and a run of conditional behaviour around that: a sort key that couldn't truncate, `EDD-9107` for a range before the last
composite, and a `.within()` branch that a review found returned `a#` for `eq: "a"`. All of it is gone. The owner's principle is
that index keys go in dedicated GSI attributes, and one rule for every key (D64) makes inverted indexes work with no case of their
own: both roles build identical text, whether the flag is on or off (D68). `packages/schema/test/InvertedIndex.test.ts` holds that
for every casing, with `u 1`, `a b` and `50%` among the values, and `test/helpers/InvertedIndexes.ts` on every write path under both
settings, on a recording table and on DynamoDB Local.

**The rows 1.37.0 and 1.38.0 wrote,** which `rekey` moves, in either direction (`KeyText136.invertedForm137`): each attribute holds the text of the half that wrote it last, so `pk` is escaped and `sk` raw, an escape in each half included. `releaseRowScenarios` runs what the published packages stored, and `overwritten137Scenario` the mixes.

**What stays refused** is what isn't the same definition: shape 13, two GSIs swapping each other's attributes, a half with other
composites, order or casing, and a sharded index's partition key over the table's. `EDD-9106` holds that (§17.7, D69). A sharded
index's sort key in the table's sort key is legal, as before.

**New degenerate fixture 14** (§16), at unit, entity and connected level, under both settings.

### 17.17 One flag, off by default, and `rekey` the only migration

This section was rewritten by D76 to D80. Earlier versions of this PR escaped every key by default,
kept a fallback for rows under older text and told two values sharing a partition's text apart by row
checks. All of that is gone, by the owner's decision: "we don't have complications of trying to make
everything backwards compatible. The feature is either on or off. If it's on and you have existing data,
you need to rekey. That's it." and "NO ADDITIONAL READS/PUTS/FALLBACKS ETC".

**The rule (D77, D78).** `KeyComposer.keyText(schema, text, casing)` composes every composite's text, and
`extractKeyComposites` is what each composer reads. Unique sentinels, aggregate partitions and list keys,
and stream ids go through it too, so a key's text doesn't depend on its role. Off (the default for all of
1.x) composes exactly the text 1.36 composed, for strings and numbers. `escapeKeys: true` escapes every
string and gives numbers numeric text, in every key. On by default is planned for the next major.

**One text, one request (D76).** Every operation composes the one text its setting chooses and looks
nowhere else. `test/KeyRequests.test.ts` captures the requests of every operation for a value whose text
differs under the other setting and for one whose text doesn't, under both settings, and holds them the
same but for the bytes of the values. Its control is a schema with no flag.

**The bytes,** against rows the published packages stored. `fixtures/rows-1.36.0.json`, `rows-1.37.0.json`
and `rows-1.38.0.json` hold what each wrote through every key path, in all three casings, each generated once
from outside the repo by `test/helpers/KeyRows.ts`, which takes the library as a parameter.
`test/EscapeKeys.test.ts` and `connected.escape-keys.test.ts` run the same program on this tree:

| Setting | Values | Must store |
|---|---|---|
| Off | Holding what a key escapes, and not; any number | The published 1.36.0's bytes |
| On | Holding nothing to escape | The published 1.36.0's bytes |
| On | Holding what a key escapes | The same, each value escaped by an independent spelling of the rule, a command's sort key alone left raw (D72) |

`packages/schema/test/EscapeKeys.test.ts` does the same at the composers, and with the flag off the real
composers match every case in `key-text-1.36.0.json`. No non-escaped value's bytes changed under on, and
range planning didn't change for any index.

**Turning it on or off over stored rows.** Until `rekey` a read doesn't find a row whose text changed;
after it, the stored bytes are what a fresh write under the setting stores, and a rerun moves nothing.
Scenarios under `flipScenarios`, in both directions.

**`rekey` over the rows each release stored (D79).** `releaseRowScenarios` seeds the rows the published
1.37.0 and 1.38.0 stored, in every casing, with strings to escape and with the numbers those releases
changed, and runs `rekey` under each setting: a dry run agrees and writes nothing, the run moves every row
with no conflict and nothing unrecognised, the stored keys equal a fresh write's, under off 1.36.0's bytes,
every key path reads them, and a rerun moves nothing. They include the inverted row those releases wrote
(`pk` escaped, `sk` raw). The two releases stored the same keys, which a scenario compares.
`connected.legacy-rows-1.36.0.test.ts` does the same with their projections and retained versions:
`__edd_kt__` marks, a chain of `a b` and `a%20b`, pending effects and tombstones, in both directions.

**What was unrecognised, and is moved now.** Three mixes:

| Row | Now |
|---|---|
| An aggregate partition, silent in the first version | Moved through whichever text its root's values compose (`rekeyCore`'s `from`) and counted; a root under no text, or rows below no root, `skipped.unrecognizedKey` (`rekeyFinish`, D86) |
| A sentinel mixing an escape and a changed number | Moved: a sentinel is judged under every form (`rekeySentinels`, `rekeySentinelRow`) |
| An inverted row with an escape in both halves | Moved: `KeyText136.invertedForm137` |

**The chain, in both directions (D79).** `foo%20bar`'s old row moves to `foo%2520bar` before `foo bar`'s moves
to `foo%20bar`, or the reverse, whichever the scan reached first, nothing overwritten and nothing merged. A dry
run agrees. A row whose destination holder can't move stops retrying, and reports `taken` (`cantMoveHolder`);
a conflict is listed once per run (D87).

**Until `rekey` finishes, nothing is promised.** A read doesn't find rows whose text changed, a write of the same
key lands beside them and `rekey` reports `bothKeys`, a value can land on another value's old row, and a unique
value isn't seen as taken while its sentinel is under other text. The upgrade guide says this plainly.
`test/helpers/AliasKeys.ts` no longer pins false conflicts and row checks: it pins that, after `rekey`, every
operation is correct on `foo bar` and `foo%20bar`, from real rows of every form, and that a fresh table has no alias.

**Limits under off (D66)** are pinned in `multiCompositeOffScenarios`, so the docs stay true. Nothing is added for
them, per the brief. They're the default behaviour now, so the docs put them where key order, `.where`, `.within()`
and skip-scan are documented.

**Cursors (D84).** A plain cursor names a key: from the other setting's text it finds no rows or DynamoDB refuses
it. A sharded or `.within()` query's cursor is `EDD-9094` under the other setting, since the fingerprint covers the
partitions. A 1.37.0 or 1.38.0 cursor from a query that read both keys (field `p`) is `EDD-9094` on any query. None
returns rows of another value, and each refused listing restarts. The hash reads `serializeValue` text, so a row's
shard doesn't change with the flag.

### 17.18 Never set a table key attribute

A review reproduced a retry sending `SET sk`, after `4ddb0a5` had removed `rekey`'s guard on the reasoning that a half in a table key
attribute holds the table's text. That's true of what's stored, not of what a concurrent writer's values compose: `rekey` reads a row,
another writer changes `id` and `status`, the guard's condition fails, and the retry judges the index half against the new values. The
guard is back, as the first line of `staleIndexKeys`' `rewrite`.

**Every `UpdateExpression` the library builds was audited** (D70):

| Builder | How it stays out |
|---|---|
| The update composer (standard, retain, `append`, transactions) | Filters `sets` and `removes` |
| `upsert` | Skips primary fields |
| `rekey`'s in-place rewrite | The restored guard |
| Aggregate `rekey` | `indexFields` excludes the partition field and `sk` |
| The vector backfill | A `partitionField` is its own attribute |
| `EventStore` `#moved`, Entity `_entity_pk` / `_entity_sk`, `#ref`, `ProjectionEngine` `#c` / `#u`, `CheckpointStore` `#expiresAt` | Name no key attribute |
| `TransactPlan` | Passes through what the builders above produced |

A user's own `.pathSet(["pk"])` takes any string, so it's refused at run time, below.

**Puts and definitions.** A review found what recording updates couldn't see: a `Put` whose item key differs from the composed table key,
through a definition that stores something else in the attribute. So the rule reaches the definition:

| Position | Refused |
|---|---|
| A model attribute stored in a table key attribute, by rename (`payload: { field: "pk" }`) or by name, a system timestamp, a version field | `EDD-9109`, at `Entity.make`, operational and pure |
| An aggregate's list key, or its collection sort key, stored in a table key attribute | `EDD-9112`, at `Aggregate.make`, operational and pure, at `Table.make` for `PK` and `SK` |
| `.remove`, `.set`, `.add`, `.subtract`, `.append`, `.deleteFromSet` and the path operations naming a table key attribute by its stored name | `ValidationError` at run time, nothing written |

An attribute named `pk` beside key attributes named `PK` isn't a table key attribute, and stays accepted (`test/connected.table-key-attributes.test.ts`).

Aggregate `rekey`'s filter is a guard no test can make fire, and `EDD-9112` now refuses the definitions it would have seen. It stays
because the owner's rule is to name no table key on any path, and the next aggregate key form shouldn't have to be the one that shows it.

`test/NoTableKeyWrites.test.ts` records every `UpdateItem` and transactional `Update`. It parses each action's target, so a name an
expression only reads doesn't count, and a plain `sk` without an alias does. It runs inverted, shared `sk`, sharded shared `sk`, local and
dedicated definitions, under both settings, through put, update, remove, upsert, delete, batch, transaction, retain, soft delete,
restore, purge, unique constraints, time series and `rekey`; `rekey`'s retry after another writer; an aggregate with a list key and a
local index; and the scenarios of the other suites over these definitions, streams and rows from 1.36, 1.37.0 and 1.38.0 included. It also holds every `Put` to
the key its values compose: a row's partition composed, its sort key composed or history-shaped, a sentinel's owner pointer, `rekey`'s moves,
aggregates and streams. `test/TableKeyAttributes.test.ts` covers each definition position: refused, accepted, run-time check.
