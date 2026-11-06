# Design: repairing index keys in `rekey` (#185 item 1)

**Status:** the design, with what released 1.38.0 measured, written before the code. Stacked on #184.
**Semver impact:** minor, the four packages in lockstep. `rekey` gains an option and report fields; nothing
changes on an ordinary read or write.

## Decisions for the owner

Two calls below are yours. Each is built as recommended and is one condition to change.

**1. A row dropped from a `sparse` index on purpose looks exactly like a damaged one. Leave those rows alone?**

The recommended design repairs any `sparse` half whose composites are all on the row and whose key is missing.
That would put back rows a writer took out deliberately. `DESIGN.md` §7 documents this write, "Telemetry (no
alert)":

```ts
// sk: ["alertState", "timestamp"], indexPolicy: { sk: "sparse" }
.set({ timestamp: "t2" })
// 1.38.0 stored: alertState "active", timestamp "t2", gsi4pk, and no gsi4sk
```

The row keeps `alertState: "active"`, so a repair would list it in a current-alerts query again, showing an alert
the writer said was over.

The state can only be reached one way: the writer names one of the half's composites but not an earlier one. So it
needs **two or more composites outside the primary key**. On a half with at most one, naming it composes the key,
clearing it takes the value off the row, and nothing else evicts the row but the old gate, so a missing key there
is damage for certain. That covers the first row of the issue's table, `sk: [zone, deviceId]`.

**Recommendation:** repair the missing key only on a half with at most one composite outside the primary key.
Otherwise write nothing and count it (`indexKeys.ambiguous`). **This leaves the second-writer row you expected to
repair:** `[a, b]`, one writer naming `a`, another `b`. It's byte for byte the documented drop, same definition
shape, same row, so no rule can repair one and not the other. If you'd rather repair them, a table with no
deliberate drops can do it with a separate opt-in; I haven't added one.

**2. A key lagging its values under `preserve`: repair it under the option?**

`.set({ b: "new" })` on `sk: [a, b]` leaves the key at `b_old`. An application could use that as a frozen position,
since a pin on `old` finds the row and a pin on `new` doesn't (measured, below). The docs don't promise that: they
call it stale "until the next write that can compose" (`KeyComposer.IndexPolicyKey`, `guides/index-policy.mdx` §3),
and a run holding the whole row is such a write.

**Recommendation:** repair it under `repairIndexKeys`, and report it on its own line (`indexKeys.lagging`), so a dry
run shows it before anything is written.

## What was measured

Released `effect-dynamodb@1.38.0` on DynamoDB Local, reading the rows back with the raw client.

| Write | Stored afterwards |
|---|---|
| `put`, `.set({ status })`, `sk: [zone, deviceId]`, `sparse` | `gsi1sk` gone, `zone` still on the row |
| same, `sk: [deviceId, zone]`, `preserve` | `gsi2sk` = `…#deviceid_dmg`, truncated, `zone` still on the row |
| same, `pk: [channel, zone]`, `preserve` | `gsi3pk` = `…#channel_c1`, another partition |
| `sk: [alertState, timestamp]`, `sparse`, `.set({ timestamp })` | `gsi4sk` gone, both values on the row (the documented drop) |
| `.set({ alertState: undefined })` | `gsi4sk` gone, `alertState` gone from the row |
| `sk: [a, b]`, `.set({ a })` then `.set({ b })` | `sparse`: no key, both values on the row. `preserve`: `a_a`, both on the row |
| `sk: [a, b]`, `.set({ b: "new" })` | `preserve`: `a_a#b_old`; a pin on `old` returns the row, a pin on `new` returns nothing |
| `sk: [a, b]`, `.set({ a: "A2" })` | Both policies: `a_a2`, `b` still on the row. Ordinary, and still written by #184 |
| `timestamps: true`, `sk: [createdAt]` and `[updatedAt]` as `DateTimeUtc`, `put` not supplying them | No index keys, both values on the row |
| same, supplied, then `.set({ status })` | `updatedAt` moves, its key stays at the old value, on every update |
| `versioned: true`, `sk: [version]` | `put`: no key, `version: 1` on the row. Each update moves it |
| A ref's id as a composite, `pk: [teamId]` | The key holds `teamid_t1`; the row holds `team: { id: "t1", … }` and **no `teamId`** |
| `.pathRemove(["z"])` | Treated as a removal: the half's key goes too |

## The three questions

**1. Under `sparse`, is there a legitimate way to have every composite on the row and no key?** Yes, three:

- The documented drop above, reachable only with two or more composites outside the primary key (decision 1).
- A second writer with no read: the same state, and it can't be told apart.
- A composite the library stamps (`createdAt`, `updatedAt`, `version`): `put` composes keys from its input *before*
  stamping, so a healthy row has the value and no key. This one is under either policy.

So "what `put` would write" needs narrowing, below.

**2. Under `preserve`, can a lagging key be relied on? Is there a policy form where "what `put` would write" isn't
defined?** A lagging key can be relied on in principle (decision 2), but nothing promises it. A `updatedAt` key lags
on every update by construction, so it's never judged. There's no other policy form: `IndexPolicy` is `{ pk?, sk? }`
of two strings, per index. Function policies were removed in 1.7, there's no per-write policy, and `put` never
consults it. "What `put` would write" still has two gaps for a stored row, both closed below: `put` decides for the
whole index where an update decides per half, and a ref's id isn't stored under its own name.

**3. What does a repair run cost on an undamaged table?** The scan. Judging is composing strings from a row already
read, with no read or write unless a key differs. Measured in §Cost, added once built.

## The rule

A row is judged only when `rekey` already finds it under its current table key: a live entity row. Snapshots,
tombstones and time-series events have their index keys stripped, sentinels have none. Aggregates compose their own
rows and never call the gate (`composeGsiKeysForUpdatePolicyAware` has no caller in `Aggregate.ts`).

Each half of each secondary index, using `put`'s composers through the key form:

| Composites on the row | Stored key | `sparse` | `preserve` |
|---|---|---|---|
| All | Equal | Nothing | Nothing |
| All | Differs | SET | SET |
| All, and the other half's too | None | SET, or `ambiguous` with 2+ composites outside the primary key | SET |
| All, but not the other half's | None | Nothing: `put` wrote no entry, and a key would add nothing | Nothing |
| Trailing ones missing | None, or the truncated text | Nothing (shape 3) | Nothing |
| Trailing ones missing | Anything else | SET the truncated text | Nothing |
| A hole, or none leading | None | Nothing | Nothing |
| A hole, or none leading | Any | REMOVE | Nothing |

Never judged: a half in a table key attribute (no write ever names one, D70); a half with a library-stamped
composite; a half whose values compose no key (`NaN`, a Z-order value a dimension can't place), which `put` would
refuse too; a sharded partition key that can't compute its shard, which `rekey` already reports or leaves. A ref's
id is read from the stored ref, as `.within()` does: without that, a `sparse` half on one would be REMOVEd from every
row.

**Shapes.** 2 and 6: SET when missing, the #43 and #46 rows. 3: truncation with the leaf absent is left. 4: left, or
REMOVE under `sparse`. 7, 8, 8a, 8b: a Z-order half is all or nothing and compares bytes, so a value within one
quantization level writes nothing. 8c: never truncated. Sharded: `rekey` already rewrites a differing sharded key, so
only a missing one is added here.

**The report.** On every run, for no extra read: `indexKeys.missing`, `truncated`, `lagging` (index keys that differ,
by how) and `ambiguous`. With `repairIndexKeys`: `repaired`, and `skipped` for a key lost to a writer twice.

**The write.** Separate from the text rewrite, so a run without the option sends what it sends today. One `UpdateItem`
per row with work, guarded on each key as read (or `attribute_not_exists`), and on each composite as read (or
`attribute_not_exists`, or the ref attribute for a ref's id). A writer changing any of them wins. On a failed
condition: one consistent read, judged again, one more attempt, then `skipped`. A key DynamoDB refuses (over its
length limit) is a `failed` conflict, and the run goes on.

**A move.** A table key move recomposes as an update naming everything would, so it re-admits a dropped row, a row
with stamped composites and no key, whether or not the option is set. That's a bug in the released move, found
measuring this. It keeps those halves absent now; anything else it already catches up, as §9.2 of the sharding design
says.

## Fix 1: a bounded run's rootless edges

An edge at its current key whose root is on a later page at the old key looks rootless, since the root hasn't told the
run where it's going. Only a run over the whole table can say otherwise, so a run with `maxPages` left, or started from
`resume`, counts such a row in a new `skipped.rootNotSeen`, and only a run that saw every page counts
`skipped.unrecognizedKey`. A whole-table run does exactly what it did, reads included. A real orphan found by a bounded
chain stays in `rootNotSeen` until a whole-table run; carrying rows across a token would make it grow without limit,
and `rooted` is the size of the table.
