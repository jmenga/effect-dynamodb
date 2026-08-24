# Design: EventStore snapshots + commandHandler retry

**Issue:** [#84](https://github.com/jmenga/effect-dynamodb/issues/84) (split from #80 item 3)
**Status:** Accepted — commit 1 of the feature branch (single-PR workflow).
**Affected packages:** `packages/effect-dynamodb` (EventStore), `packages/schema` (one additive DynamoSchema helper)
**Semver impact:** `minor` (additive API; lockstep bump across the four publishable packages)

---

## 1. Executive summary

`commandHandler` reads the full stream on every command — O(stream length) per command,
forever. `foldFrom` already exists as the snapshot+delta primitive, but nothing writes or
reads snapshots. This design adds:

1. **Snapshot storage** — one snapshot item per stream, stored in the stream partition
   under a distinct SK, carrying the folded `state` (round-tripped through a
   user-supplied state schema) and the `asOfVersion` it reflects. Primitives:
   `writeSnapshot` / `readSnapshot`.
2. **Snapshot-aware `commandHandler`** — when the stream declares a `snapshot` config the
   handler runs `readSnapshot → readFrom(asOfVersion) → foldFrom → decide → append`, and
   (optionally, `every: N`) writes a fresh snapshot after append once N or more events
   have accumulated since the last one.
3. **`commandHandler` retry option** — `commandHandler(decider, stream, { retry })` where
   `retry` is a max-attempts number or an Effect `Schedule`. On `VersionConflict` the
   **full read–decide–append cycle re-runs** (never a blind re-append of stale events).
   Default remains no retry.

Everything is opt-in and backward compatible: `makeStream` without `snapshot` and
`commandHandler` without options behave exactly as before.

One-screen example:

```ts
const MatchEvents = EventStore.makeStream({
  table: EventsTable,
  streamName: "Match",
  events: [MatchStarted, InningsCompleted, MatchEnded],
  streamId: { composite: ["matchId"] },
  snapshot: { schema: MatchStateSchema, every: 100 },
})

const handleMatch = EventStore.commandHandler(matchDecider, matchEvents, { retry: 3 })
// Each call: readSnapshot → readFrom(asOfVersion) → foldFrom → decide → append,
// auto-snapshots every ≥100 events, and re-runs the whole cycle on VersionConflict
// (up to 3 retries).
```

---

## 2. Snapshot item key design

### 2.1 Where event items live today

For a stream `Match` on schema `cricket` v1, event items are:

```
pk: $cricket#v1#match#<streamId composites>          (composeKey)
sk: $cricket#v1#match.event_1#<10-digit version>     (composeEventVersionKey)
__edd_e__: "match.event"
```

All read paths (`read`, `readFrom`, `currentVersion`, `query.events`) query the partition
with a `FilterExpression` of `__edd_e__ IN ("match.event")`. `readFrom` additionally uses
an SK range (`#sk > :sk`) and `currentVersion` uses `ScanIndexForward: false, Limit: 1`.

### 2.2 Snapshot key scheme

The snapshot lives **in the stream partition** (same `pk` — one cheap
`Query`/`GetItem` locality, participates in the item collection) under a distinct SK:

```
pk: $cricket#v1#match#<streamId composites>          (unchanged — stream partition)
sk: $cricket#v1#match.snapshot                       (composeKey(schema, "match.snapshot", []))
__edd_e__: "match.snapshot"
```

Properties:

- **Collision-impossible.** Event SKs always have the shape
  `…#<stream>.event_1#<10 digits>`; the snapshot SK is `…#<stream>.snapshot` — a
  different entity-type label. No streamId, version, or casing input can make the two
  equal (the delimiter `#` cannot appear inside the label, and `.snapshot` ≠ `.event_1`).
- **Distinct `__edd_e__`.** `<stream>.snapshot` vs `<stream>.event` — the existing
  entity-type FilterExpression on every event query excludes the snapshot item, and the
  snapshot read (`GetItem` by exact key) never sees event items.
- **Deterministic sort position.** Within the partition, `<stream>.snapshot` sorts
  **after** every event SK (`.s` > `.e` at the label position). This matters for range
  semantics — see 2.3.
- **One snapshot per stream, overwritten in place.** Snapshots are a cache of a fold,
  not history; keeping older snapshots has no read-path value and would grow the
  partition. (History is the event stream itself.)

### 2.3 Exclusion from `read` / `readFrom` / `currentVersion` — two independent layers

Correctness must not hinge on the `__edd_e__` filter alone, because DynamoDB applies
`Limit` **before** `FilterExpression`: a filtered-out snapshot inside the scanned range
still consumes `Limit` slots and produces extra empty pages. Two layers:

1. **`__edd_e__` FilterExpression** (already present on all event queries) — the
   semantic guard.
2. **SK range hardening** (new) — the event read paths now bound the key condition to
   the event SK range, so the snapshot item is excluded *at the key-condition level*:
   - `read` / `query.events`: `begins_with(sk, "$cricket#v1#match.event_1#")` — new
     `DynamoSchema.composeEventVersionKeyPrefix` helper (same pattern as the existing
     `composeVersionKeyPrefix` / `composeDeletedKeyPrefix`).
   - `readFrom(after)`: `#sk BETWEEN eventSk(after + 1) AND eventSk(9999999999)` —
     versions are integers, so the inclusive lower bound `after + 1` is exactly the old
     exclusive `#sk > eventSk(after)`, and the upper bound is the padding maximum
     (10 digits ⇒ no event can sort above it).
   - `currentVersion`: `begins_with` prefix + `ScanIndexForward: false, Limit: 1` — the
     single evaluated item is guaranteed to be the newest **event**, never the snapshot.

Adjacent fix (golden rule): `currentVersion` previously executed
`Query.collect` with `Limit: 1`, which pages through the **entire partition one item per
request** (DynamoDB returns `LastEvaluatedKey` whenever `Limit` truncates the range).
It now uses the single-page terminal (`Query.execute`) — exactly one request.

### 2.4 Snapshot item shape

```
pk           <stream partition key>
sk           $<schema>#v<n>#<stream>.snapshot
__edd_e__    "<stream>.snapshot"
streamId     "<composites joined with #>"   (same convention as event items)
asOfVersion  number — the event version the state reflects
state        <encoded state — see §4>
timestamp    ISO timestamp (Clock-backed DateTime.now, TestClock-deterministic)
```

### 2.5 Monotonic writes

`writeSnapshot` issues a `PutItem` with

```
ConditionExpression: attribute_not_exists(#pk) OR #asOfVersion < :asOfVersion
```

A `ConditionalCheckFailedException` means an equal-or-newer snapshot already exists; the
write is treated as a **successful no-op**. Rationale: snapshots are a monotonic cache —
under concurrent handlers (exactly the situation the `retry` option exists for), the
loser of a snapshot race must never regress the cache, and surfacing the condition
failure as an error would fail commands whose events were already durably appended.

---

## 3. API surface

### 3.1 `makeStream` — optional `snapshot` config

```ts
EventStore.makeStream({
  table, streamName, events, streamId, metadata?,
  snapshot?: {
    readonly schema: Schema.Top      // state codec — required
    readonly every?: number          // auto-snapshot cadence for commandHandler — optional
  },
})
```

- `EventStream` (and `BoundEventStream`) gain a 4th type parameter
  `TState = never`, inferred from `snapshot.schema`. Existing 3-parameter references
  keep compiling (default).
- `every`, when present, must be a positive integer — enforced at `makeStream` time
  (throws `[EDD-9027]`, same fail-fast convention as EDD-9012/9016 on `Entity.make`).
- `snapshot` **without** `every`: snapshots are read by `commandHandler` and written only
  manually via `writeSnapshot` — cadence stays under user control.

### 3.2 Stream operations

```ts
interface Snapshot<State> {
  readonly state: State
  readonly asOfVersion: number
  readonly timestamp: string
}

stream.writeSnapshot(streamId, state: TState, asOfVersion: number)
  // Effect<void, ValidationError | DynamoClientError, DynamoClient | TableConfig>

stream.readSnapshot(streamId)
  // Effect<Option<Snapshot<TState>>, ValidationError | DynamoClientError, DynamoClient | TableConfig>

stream.snapshotConfig
  // { readonly every: number | undefined } | undefined — presence signals snapshot support
```

- On a stream without `snapshot` config, `TState = never` makes `writeSnapshot`
  uncallable at the type level; at runtime both primitives **die** with `[EDD-9026]`
  (programming error — misconfiguration, not a recoverable condition).
- `EventStore.bind` carries both primitives onto `BoundEventStream` with `R = never`.

### 3.3 `commandHandler` options

```ts
EventStore.commandHandler(decider, stream)                    // unchanged
EventStore.commandHandler(decider, stream, { retry: 3 })      // max 3 retries
EventStore.commandHandler(decider, stream, {
  retry: Schedule.exponential("50 millis").pipe(Schedule.compose(Schedule.recurs(5))),
})
stream.pipe(EventStore.commandHandler(decider, { retry: 3 })) // data-last
```

- `retry?: number | Schedule.Schedule<unknown, VersionConflict>` — a number `n` is
  shorthand for `Schedule.recurs(n)` (n retries after the initial attempt).
- The decider's `State` and the stream's `TState` are tied with
  `TState extends State` — `never` (no snapshot) always satisfies it; a mismatched
  snapshot schema is a compile error. The relation is one-directional by necessity:
  the read path needs `TState → State` (a snapshot restores a starting state) and the
  auto-snapshot write path needs `State → TState`. Only the first is expressible while
  still letting the no-snapshot default (`never`) satisfy the constraint, so the write
  side is an internal cast. In practice the two are the same type; a snapshot schema
  that is a strict *subtype* of the decider state is accepted by the compiler and would
  lose fields on write — documented, not prevented.

### 3.6 Adjacent fix (golden rule): `commandHandler`'s dual dispatch is broken today

`commandHandler` is declared with `Function.dual(2, (decider, stream) => …)`. `dual`'s
data-last path calls `body(self, ...args)` — i.e. it assumes the **data is the first
parameter**. Here the data (`stream`) is the *second* parameter, so the documented
data-last form

```ts
stream.pipe(EventStore.commandHandler(decider))
```

calls `body(stream, decider)` and blows up (the decider slot receives the stream). No
test covers the data-last form, which is why it has never been noticed.

`Function.dual` cannot express a "self is the second parameter" dual, and it also
cannot carry the new optional third argument (numeric arity 2 silently drops it, and the
predicate form still reorders on the data-last path). `commandHandler` therefore gets a
hand-rolled dual dispatch keyed on the `EventStreamTypeId` brand carried by both
`EventStream` and `BoundEventStream`:

```
commandHandler(decider)                       → data-last, no options
commandHandler(decider, options)              → data-last, with options
commandHandler(decider, stream)               → data-first
commandHandler(decider, stream, options)      → data-first, with options
```

Both data-last forms are now covered by tests.

### 3.4 Snapshot-aware handler flow

Per invocation (one "attempt"):

1. If `stream.snapshotConfig` is set: `readSnapshot(streamId)`.
   - `Some({ state, asOfVersion })` → `readFrom(streamId, asOfVersion)` +
     `foldFrom(decider, state, delta)`; base version = last delta event version, or
     `asOfVersion` when no delta.
   - `None` → full `read` + `fold` (cold start).
2. Without `snapshotConfig`: full `read` + `fold` — the exact pre-existing path.
3. `decide` → empty ⇒ no-op result (unchanged); else `append(events, baseVersion)`.
4. **After** a successful append, if `every` is set and
   `newVersion − (snapshot?.asOfVersion ?? 0) >= every`: `writeSnapshot(streamId,
   newState, newVersion)` — **best-effort**: a snapshot-write failure is logged
   (`Effect.logWarning`) and swallowed. The command's events are already durable; the
   next threshold crossing (or `retry` of a later command) will write the snapshot.

### 3.5 Retry semantics

The **entire attempt** (steps 1–4 above) is the retried unit:

```ts
Effect.retry(attempt, { schedule, while: (e) => e instanceof VersionConflict })
```

- Only `VersionConflict` is retried — decider domain errors, `ValidationError`,
  `DynamoClientError`, `TransactionCancelled` all fail immediately.
- Because the read (snapshot + delta) and `decide` re-run inside the retried unit, every
  retry decides against **fresh state** — a blind re-append of stale events is
  impossible by construction.
- Default (`retry` absent): no retry — identical behavior to today.

---

## 4. Codec handling

Snapshot state round-trips through the user-supplied `snapshot.schema`:

- **Write:** `Schema.encodeUnknownEffect(schema)(state)` → stored under `state`.
  Encode failures → `ValidationError { operation: "EventStore.writeSnapshot" }`.
- **Read:** `Schema.decodeUnknownEffect(schema)(raw.state)` → typed `TState`.
  Decode failures → `ValidationError { operation: "EventStore.readSnapshot" }`.

This matches the post-codec-fix convention for events: symmetric encode-on-write /
decode-on-read, so transforming schemas (`Schema.Class`, branded types, `DateTime`
fields, `Redacted`, …) work as state schemas.

**Snapshot decode failure is surfaced, not masked.** A corrupt or schema-incompatible
snapshot fails the command with `ValidationError` rather than silently falling back to a
full replay. Silent fallback would hide state-schema evolution bugs until the day the
snapshot is deleted. Mitigation for deliberate schema evolution: make the state schema
tolerant (optional fields with defaults), or delete/rewrite snapshots on deploy — the
event stream remains the source of truth, so a snapshot can always be discarded.

---

## 5. Alternatives considered

| Alternative | Why rejected |
|---|---|
| Snapshot SK **inside** the event prefix (`…#match.event_1#snapshot`) | Sits inside every `begins_with`/range scan of events; exclusion would depend solely on the `__edd_e__` filter, and `Limit`-bearing queries would waste slots on it. |
| Snapshot SK sorting **before** events (e.g. `…#match.event!snapshot`) | Requires a `!` hack against `#` byte ordering; unnecessary once event reads are range-hardened (§2.3), and unreadable in the console. |
| Snapshot in a **separate partition** (`pk: …#match.snapshot#<id>`) | Loses item-collection locality; doubles the key surface; no benefit — the single-item snapshot cannot meaningfully skew the partition. |
| **Versioned snapshots** (one item per snapshot version) | Snapshots are a cache, not history; N items grow the partition and complicate reads for zero read-path value. |
| `EventStore.withSnapshots(stream, config)` wrapper | A second stream type to document/bind/type; `makeStream` config keeps one definition site and lets `TState` flow into `EventStream` naturally. |
| Fail the command when the post-append auto-snapshot write fails | The events are already durably appended; failing the command would report failure for an operation that succeeded. Best-effort + `logWarning` (§3.4). |
| Retry via naive `Effect.retry` around `append` only | Re-appends stale events — the exact bug the issue calls out. The retried unit must be the full read–decide–append cycle. |
| Snapshot read via `Query` on the partition | `GetItem` by exact key is cheaper and simpler; the SK is fully deterministic. |
| Keep `Function.dual` for `commandHandler` (§3.6) | `dual`'s data-last path hard-codes "data is the first parameter"; here the stream is second. Numeric arity also swallows the new third argument. A hand-rolled dispatch on `EventStreamTypeId` is the only correct shape. |
| Silently fall back to a full replay when a snapshot fails to decode | Hides state-schema evolution bugs until the snapshot happens to be deleted. Surface the `ValidationError` (§4). |

---

## 6. Backward compatibility

- `makeStream` without `snapshot`: identical behavior; `TState` defaults to `never`.
- `commandHandler(decider, stream)` (2-arg, data-first) and
  `stream.pipe(commandHandler(decider))` (data-last) keep working; the dual dispatch
  switches on "is the second argument an EventStream/BoundEventStream" instead of arity.
- `read`/`readFrom`/`currentVersion` results are unchanged for streams without
  snapshots; the SK-range hardening only narrows the scanned range to items that were
  already the only ones decoded.
- `VersionConflict`, `AppendResult`, `CommandHandlerResult` shapes unchanged.
- §3.6 changes the *runtime* behavior of `stream.pipe(commandHandler(decider))` from
  "throws" to "works". Nothing can depend on the old behavior.

### New error codes

| Code | Where | Meaning |
|---|---|---|
| `EDD-9026` | `writeSnapshot` / `readSnapshot` (defect) | Called on a stream declared without `snapshot`. Unreachable through the public types; a defect, not a recoverable failure. |
| `EDD-9027` | `makeStream` (throws) | `snapshot.every` is not a positive integer. |

## 7. Test plan

- **Unit (`EventStore.test.ts`, stubbed client):** snapshot key/item shape; monotonic
  condition expression; encode-on-write/decode-on-read through a transforming schema;
  read/readFrom/currentVersion SK-range hardening; snapshot-aware handler flow (uses
  `readFrom` + `foldFrom`, cold start, no-op commands); auto-snapshot threshold
  (fires at ≥ every, not below, best-effort failure swallowed); retry re-runs full
  cycle on `VersionConflict` (number + Schedule forms), does not retry domain errors,
  default no-retry; `[EDD-9026]`/`[EDD-9027]` guards; bind parity.
- **Connected (`connected.test.ts`, DynamoDB Local, `Date.now()`-suffixed table):**
  snapshot round-trip with a transforming state schema; snapshot invisible to
  `read`/`readFrom`/`currentVersion` and events invisible to `readSnapshot`;
  snapshot-aware handler correctness vs full replay; auto-snapshot cadence; retry
  resolving a real interleaved `VersionConflict`.
- **Docs:** event-sourcing tutorial + backing example regions (doctest-synced).
