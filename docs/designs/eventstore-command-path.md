# EventStore — command-path extensions (#136–#140)

Status: accepted · Target: 1.24.0 (minor) · Issues: #136, #137, #138, #139, #140
(#141 — referenced, **not implemented**: large commands are stepped commands,
see §5; #142 — out of scope, see §8)

This document is the specification for five EventStore extensions delivered in
one PR. They converge on `append` and `commandHandler` in
`packages/effect-dynamodb/src/EventStore.ts`, so they are built in dependency
order on one branch:

| Stage | Issues | Theme |
|---|---|---|
| A | #139, #136, #137 | consistent reads, caller expected version, decision-derived items (fold-before-append) |
| B | #138 | inline snapshots + single-request load (and, for #141, the stepped-command guidance in §5) |
| C | #140 | stream indexes (LSI / GSI sub-streams) |

Everything is additive. Every default preserves today's behaviour, except that
`commandHandler` now loads state with strongly consistent reads (#139) and
folds the new events **before** appending (#137). Neither changes a
successful result.

New `EDD-` codes start at **EDD-9062**. EDD-9059–9061 are reserved by PR #129.

---

## 1. Consistent reads (#139)

```ts
interface ReadOptions { readonly consistentRead?: boolean }   // default false

stream.read(streamId, options?)
stream.readFrom(streamId, afterVersion, options?)
stream.currentVersion(streamId, options?)
```

- `consistentRead: true` sets `ConsistentRead` on every `Query` page.
- `BoundEventStream` mirrors the signatures.
- `query.events(streamId)` already composes with `Query.consistentRead`, so it is
  unchanged.
- `commandHandler` loads state with strongly consistent reads **by default**.
  The handler-level `CommandHandlerOptions.consistentRead?: boolean` (default
  `true`) opts out. On a snapshot-configured stream the snapshot is read in the
  same `Query` as its delta (`readLatest`, §4), so the option covers the
  snapshot too: `consistentRead: false` makes both eventually consistent.
  (`readSnapshot`'s own `GetItem` stays strongly consistent.)

## 2. Caller-supplied expected version — If-Match (#136)

```ts
yield* handle(streamId, command, { expectedVersion: 7 })
```

Per-call `CommandOptions.expectedVersion?: number`. When it is supplied:

1. After state is loaded, if the loaded version ≠ `expectedVersion`, the call
   fails with `VersionConflict` **before `decide` runs**. `decide` is never
   called on state the client did not see.
2. Otherwise the append is conditioned on `expectedVersion`, which equals the
   loaded version at that point.
3. A `VersionConflict` (pre-decide or from the append) is **never retried**,
   whatever the handler's `retry` policy says. The caller asked for a
   conditional write.
4. A no-op decision (`decide` returns `[]`) at the matching version succeeds,
   returning the current state and version, exactly as today.
5. **Idempotency precedence.** With `idempotency` configured and a
   `commandId` supplied, a pre-decide mismatch first checks the command's
   sentinel with one strongly consistent `GetItem` (paid on the mismatch path
   only). If the sentinel exists, the call fails with `DuplicateCommand`, not
   `VersionConflict`: a redelivery whose response was lost carries its original
   If-Match, which the stream has since moved past, and it must be reported as
   already applied rather than as a lost race. This is the same precedence
   `append` applies. An append-time conflict
   needs no probe — `append` already ranks the sentinel first.
6. A value that is not a non-negative integer (`NaN` from a failed `If-Match`
   parse, a negative or fractional number) is a caller bug, not a conflict: it
   fails with `ValidationError` before anything is read, and is not retried.

`VersionConflict` gains an **optional** `actualVersion?: number`:

- The pre-decide check sets it to the loaded version, so callers can render a
  useful `412`.
- An append-time conflict leaves it unset, because the actual version is not
  known without another read.

The field is additive, so existing `new VersionConflict({...})` call sites still
compile.

When `expectedVersion` is omitted, behaviour is unchanged.

## 3. Decision-derived `additionalItems` — inline projections (#137)

```ts
interface Decision<State, Event> {
  readonly events: ReadonlyArray<Event>  // what decide returned
  readonly state: State                  // evolve-fold of `previous` with `events`
  readonly previous: State               // the state decide was given
  readonly version: number               // version the events are appended after
}

type AdditionalItemsInput<State, Event, E2, R2> =
  | ReadonlyArray<TransactWriteOp>
  | ((decision: Decision<State, Event>) =>
      | ReadonlyArray<TransactWriteOp>
      | Effect.Effect<ReadonlyArray<TransactWriteOp>, E2, R2>)
```

`CommandOptions.additionalItems` accepts the static array (unchanged) or a
function of the decision. The function may return the array directly (pure
form) or an `Effect` (for projections that need a read). The handler's call
signature is generic over `E2` / `R2`:

- `E2` joins the handler's error channel.
- `R2` joins its requirements. On a `BoundCommandHandler`, `R2` is the only
  requirement.
- Both default to `never`, so the pure and static forms add nothing.

### Fold-before-append

The handler now runs:

```
load → [expectedVersion check] → decide → fold new events → derive items → append → [snapshot]
```

The previous order was `… → decide → append → fold`.

- **Evaluation.** The function runs after `decide` and after the fold. It is
  not called when `decide` returns no events.
- **Retries.** It is re-run on every retry attempt, because the whole cycle is
  the retried unit.
- **Atomicity.** The items it returns commit in the same `TransactWriteItems`
  as the events. They count towards `AppendTooLarge` and the 4 MB check, and a
  failure of an item's own condition still maps to
  `AdditionalItemConditionFailed`, with indices into the returned array.
- **`evolve` may mutate in place.** The library does not require immutable
  state. When `evolve` mutates and returns the same object, `previous` and
  `state` are the same reference, and `previous` already reflects the new
  events. Deciders that need a pristine `previous` must evolve immutably.
- **The fold is the only source of state.** The `state` returned by the
  handler, written as a snapshot (§4) and passed to `additionalItems` is always
  the `evolve` fold of stored and new events. Nothing produced inside `decide`
  ever becomes state.

## 4. Inline snapshots and single-request state load (#138)

### Configuration

```ts
snapshot: { schema: StateSchema, mode: "inline" }             // every append
snapshot: { schema: StateSchema, mode: "inline", every: 10 }  // inline, at a cadence
snapshot: { schema: StateSchema, every: 100 }                 // mode "after-append" (default, today's behaviour)
```

`SnapshotConfig.mode?: "after-append" | "inline"` (exported as `SnapshotMode`)
defaults to `"after-append"`, and `SnapshotSettings` exposes `mode`. Any other
value throws `[EDD-9062]` at `makeStream`.

### Append primitive

`AppendOptions.snapshot?: TState`:

- `append` adds a snapshot `Put` (`{ state, asOfVersion: expectedVersion + events.length, timestamp }`,
  encoded through the state schema) to the **same transaction**. Snapshot
  state is encoded as events are, with a `decode → encode` fallback for a
  value not already in the schema's type shape: a `Schema.Class` state folded
  by an immutable `evolve` that spreads yields a plain object, which a bare
  encode refuses (`Expected <Class>`) and would fail every inline command.
  `writeSnapshot` uses the same encoder.
- The `Put` is unconditional. The event puts already prove this writer owns
  `asOfVersion`, so the snapshot cannot regress.
- It is placed after the idempotency sentinel. Existing positional indices are
  unchanged, and a cancellation reason at the snapshot's position (throttling,
  for example) reports `TransactionCancelled`.
- It counts towards the item and size limits.
- On a stream without a `snapshot` config it dies with `[EDD-9026]`, as
  `writeSnapshot` does. (Its type is `AppendOptions<TMetadata, TState>`'s
  `TState`, which is `never` there, so typed callers cannot supply one.)
- It requires at least one event. With none, nothing proves the writer owns
  `asOfVersion`, so an append with a snapshot and no events fails with
  `ValidationError` before anything is written. `undefined` means no snapshot.

### Handler behaviour

| Mode | When the snapshot is written | How |
|---|---|---|
| `"inline"`, no `every` | Every non-empty append | Through `AppendOptions.snapshot`, in the append transaction |
| `"inline"`, `every: N` | When `newVersion - loadedSnapshotAsOfVersion >= N` | In the append transaction |
| `"after-append"` | As today, at the `every` cadence | Best-effort `writeSnapshot` after the append succeeds |

In every mode the snapshot state is the post-fold `state` (§3).

### `readLatest` — single-request state load

```ts
stream.readLatest(streamId, options?: ReadOptions)
  : Effect<LatestState<TState, TEvent, M>, DynamoClientError | ValidationError, …>
// LatestState = { snapshot: Option<Snapshot<TState>>; events: ReadonlyArray<StreamEvent<…>>; version: number }
```

`events` holds the events after the snapshot (all events when there is none),
ascending. `version` is the stream head. The method is public on `EventStream`
and `BoundEventStream`, and works on snapshot-less streams (it is then just
`read` plus the head).

Implementation:

1. Issue **one** `Query`: reverse order, `ConsistentRead` per option,
   `sk BETWEEN <first event SK> AND <snapshot SK>`, `__edd_e__ IN (event, snapshot)`.
   - The snapshot SK sorts after every event, and command sentinels
     (`.command`) sort before `.event`, so the range holds exactly the events
     plus the snapshot. Verified against `DynamoSchema`'s key formats: the
     three SKs share `<prefix>#<label>.` and first differ at the literal
     suffix (`command#<id>` < `event_1#<version>` < `snapshot`). A stream or
     schema `casing` applies to all three alike (`"uppercase"` gives
     `COMMAND` < `EVENT_1` < `SNAPSHOT`; `"preserve"` keeps the lower-case
     suffixes), so the order holds under every casing. A unit test asserts it
     for every schema × stream casing combination.
   - The lower bound is the event SK prefix (`<label>.event_1#`), which sorts
     before the first event and after every sentinel.
   - First page `Limit`: `(every ?? 1) + 1`.
2. Keep paging until the event at `asOfVersion + 1` has been seen (versions are
   contiguous, so every event the snapshot lacks is then in hand) or the
   partition is exhausted. When there is no snapshot (it would have been the
   first item evaluated), page to the start without a `Limit`. When there is
   one, each further page's `Limit` is the number of events still missing,
   `oldestSeen - asOfVersion - 1`, so a snapshot lagging past the first page
   costs exactly one more request (DynamoDB's 1 MB page cap aside) rather than
   reading the rest of the partition.
3. Decode the snapshot through the state schema. Decode failure is a
   `ValidationError`, as `readSnapshot` reports.
4. Drop events at or below `asOfVersion`, and return the rest ascending.

Request counts:

- A current inline snapshot loads in one request.
- A lagging snapshot (data written before `inline` was enabled, or an
  `after-append` cadence) still loads in one request whenever the lag fits the
  first page — up to and including `every` events — and in two otherwise.

Read cost: the first page is read whatever the actual lag, so a load reads up
to `every + 1` items, including events the snapshot already covers (they are
discarded). For an `after-append` stream with a large `every` this trades read
capacity for requests: with `every: 100` and a snapshot one event behind, a load
reads the snapshot and 100 events in one request, where the previous
`GetItem` + `readFrom` read the snapshot and one event in two. The
`SnapshotConfig.every` JSDoc states this; `mode: "inline"` (no `every`) keeps the
page at two items.

`commandHandler` uses `readLatest` for **every** snapshot-configured stream,
whatever the mode, consistent by default. Streams without a snapshot config
keep `read` (consistent).

## 5. Large commands — stepped commands (#141, not implemented)

#141 asked for an opt-in `chunked` append that split an append too large for
one transaction across several. It was built and then removed in review, and
`append` / `commandHandler` stay strictly atomic.

**Why not.** `append` receives one decision: many events and **one** state —
the state after all of them. Split across transactions, it has no
intermediate states to put at the chunk boundaries: the inline snapshot, the
decision-derived projections and the idempotency sentinel are only true at the
end, so every boundary is either missing them or wrong. Only the
application's decider can produce a valid state for each boundary.

**The pattern.** A large command (an import, a bulk correction, a
compensating undo) is run as stepped commands:

1. The application plans the steps — newest first for an undo — each covering
   at most a configured number of entities. A fixed size is preferable to a
   dynamic size calculation, because event content varies.
2. Each step is an ordinary `commandHandler` call (decide → evolve → one
   atomic append with its own snapshot and projections), with
   `expectedVersion` = the version the previous step returned.
3. A failure partway leaves the stream at a real, consistent intermediate
   state — the last committed step. Re-issuing continues from there.

- **Idempotency.** Each step needs its own `commandId`, e.g.
  `` `${commandId}#step-${n}` ``, so a redelivered step is a
  `DuplicateCommand` without blocking the steps after it.
- **Over the limit.** An over-limit append keeps failing with `AppendTooLarge`
  (or `ValidationError` for 4 MB) before anything is written. Its
  `count` / `limit` tell the caller the configured step size is wrong.
- **No-op redelivery.** The sentinel is consulted only by an append: through
  `commandHandler`, a redelivery whose `decide` returns no events against the
  loaded state never appends, so it succeeds as a no-op instead of failing
  with `DuplicateCommand`. Whether it must be told apart is the application's
  call.

Rule of thumb: **one command → one decision → one atomic append.** The
tutorial (Step 18) and `examples/event-sourcing.ts` (`stepped-command`) run a
150-event import and its compensating undo in fixed 50-entity steps.

## 6. Stream indexes — sub-streams by derived key (#140)

### Configuration

```ts
const Entries = EventStore.makeStream({
  …,
  indexes: {
    byEntry: {
      index: "lsi1",                 // physical index name
      sk: "lsi1sk",                  // attribute carrying the derived key
      key: (event, version) =>
        event._tag === "EntryRecorded"
          ? `ENTRY#${event.section}-${pad(event.item)}-${pad(version)}`
          : undefined,
    },
    byDay: { type: "gsi", index: "gsi1", pk: "gsi1pk", sk: "gsi1sk", key: … },
  },
})
```

- **`type`**: `"lsi"` (default) or `"gsi"`.
  - An LSI uses the table partition key `pk`.
  - A GSI requires a `pk` attribute name. `append` writes the stream's partition
    key value into it, so a GSI is the eventually consistent equivalent scoped
    to the same stream.
- **`key`** receives the domain event (pre-encode, after it validates) and its
  version.
  - It returns a string, which is stored **raw**: no casing and no prefixing.
  - `undefined` leaves the event out of the index (sparse). For a GSI the `pk`
    attribute is then not written either.
  - An empty string is a `ValidationError` at append time, because DynamoDB
    rejects empty key values. So are any other non-string value, a key over
    DynamoDB's 1024-byte sort-key limit, and a `key` that throws. Nothing is
    written.
- **Definition-time validation** (thrown errors, new `EDD-` codes from 9063 — 9062 is `snapshot.mode`, §4):
  - `[EDD-9063]` — a malformed entry: a `type` other than `"lsi"` / `"gsi"`,
    a `gsi` without `pk`, an `lsi` with `pk`, an empty `index` / `sk` / `pk`,
    or a `key` that is not a function. (The config type is a union on `type`,
    so the `pk` rules are compile errors too.)
  - `[EDD-9064]` — an index attribute name collides with a stream-owned
    attribute (`pk`, `sk`, `__edd_e__`, `streamId`, `version`, `eventType`,
    `data`, `metadata`, `timestamp`, `asOfVersion`, `state`, `commandId`,
    and the default TTL attribute `_ttl`).
  - `[EDD-9065]` — two indexes of the stream share a physical index name or
    an attribute name, or a GSI's `pk` and `sk` are the same attribute.
  - A custom `TableConfig.ttlAttributeName` is only known at runtime. An index
    attribute equal to it fails each append with `ValidationError` before
    anything is written (the sentinel's numeric TTL would otherwise land in a
    string-typed index key).
- **Item scope.** Index attributes are written on event items only. Snapshot
  and sentinel items never carry them, so those items are never in an index.
  The attributes are part of the event item, so they count towards the 4 MB
  check.
- **Exposed settings.** `EventStream.indexes` / `BoundEventStream.indexes` map
  each index name to `StreamIndexSettings` (`{ type, index, pk, sk }`, where
  an LSI's `pk` is the table's `pk`). `indexDefinitions` reads them.

### Query

```ts
stream.query.index("byEntry", streamId)            // Query.Query<StreamEvent<…>> — composes with
  .pipe(Query.where({ beginsWith: "ENTRY#3-" }),    //   Query.where / reverse / limit / consistentRead /
        Query.consistentRead, Query.collect)         //   collect / execute / paginate

stream.readIndex("byEntry", streamId, { beginsWith?, between?, reverse?, limit?, consistentRead? })
  // Effect<ReadonlyArray<StreamEvent<…>>, …>  (convenience)
```

- Index names are type-checked: `EventStream` / `BoundEventStream` gain a
  trailing type parameter `TIndexName extends string = never`, inferred by
  `makeStream` from the `indexes` keys and carried through `bind` and every
  `commandHandler` form. An undeclared name reached at runtime (an untyped
  caller) is a defect, `[EDD-9066]`.
- Results are decoded `StreamEvent`s in index order. The `__edd_e__ = <stream>.event`
  filter still applies.
- `consistentRead` on a GSI is refused by the existing `Query` guard.
- `readIndex` accepts at most one of `beginsWith` / `between` (a union type,
  and a `ValidationError` for untyped callers), and `limit` must be a positive
  integer (`ValidationError` otherwise). Each key bound must be a non-empty
  string, and `between`'s lower bound must not sort after its upper bound
  (compared by UTF-8 bytes, as DynamoDB orders string keys); DynamoDB rejects
  both, so `readIndex` refuses them with `ValidationError`. Omit the condition
  to read the whole sub-stream. Nothing is sent in any of these cases.

### Table creation

Event tables are not derived by `Table.definition`.
`EventStore.indexDefinitions(...streams)` returns CreateTable fragments
(`AttributeDefinitions`, `LocalSecondaryIndexes`, `GlobalSecondaryIndexes`,
projection `ALL`) to merge into the caller's `CreateTable` input. It refuses
conflicting definitions of the same physical index with `[EDD-9067]`, and
emits an identically defined index shared by several streams once. The
table's own `pk` / `sk` are not included, and empty index lists are omitted.

### Documentation notes

- An LSI must be created with the table.
- A table with any LSI caps the item collection of **every** partition key
  value in it at 10 GB — every stream's partitions (indexed or not) and every
  entity partition sharing the table, not only the indexed stream's.
- A GSI can be added to an existing table, but that does not index existing
  events. Index attributes are written only by `append`, and events are never
  rewritten, so declaring an index on a stream that already holds events
  indexes only the events appended from then on, and changing a `key` leaves
  earlier events under their old keys. `readIndex` / `query.index` then return
  only what was indexed, without an error. The library provides no backfill:
  whether and how to re-index existing events is the application's decision.
  The `StreamIndexKey`, `GlobalStreamIndexConfig` and `makeStream` JSDoc say so.
- The projection must be `ALL`, because events are decoded from the index
  item.

## 7. Error and type surface summary

| Change | Where |
|---|---|
| `VersionConflict.actualVersion?: number` | `packages/schema/src/Errors.ts` |
| `ReadOptions`, `Decision`, `readLatest` / `LatestState`, `SnapshotMode`, `readIndex`, `query.index`, `indexDefinitions` | `EventStore.ts` |
| `CommandOptions.expectedVersion`, function form of `additionalItems` | `EventStore.ts` |
| `CommandHandlerOptions.consistentRead` | `EventStore.ts` |
| `AppendOptions.snapshot` (`AppendOptions` gains a `TState` parameter, default `never`), `SnapshotConfig.mode` | `EventStore.ts` |
| `[EDD-9062]` — invalid `snapshot.mode` | `EventStore.ts` (`makeStream`) |
| `StreamIndexConfig` / `StreamIndexKey` / `StreamIndexSettings` / `ReadIndexOptions` / `StreamIndexDefinitions`, `EventStream.indexes`, trailing `TIndexName` type parameter | `EventStore.ts` |
| `[EDD-9063]` malformed index, `[EDD-9064]` index attribute owned by the stream, `[EDD-9065]` indexes sharing an index or attribute | `EventStore.ts` (`makeStream`) |
| `[EDD-9066]` undeclared index name (defect) | `EventStore.ts` (`query.index` / `readIndex`) |
| `[EDD-9067]` conflicting physical index definitions | `EventStore.ts` (`indexDefinitions`) |

## 8. Out of scope — #142 (read-only `decide` state)

The library will not enforce `decide` purity, neither with `DeepReadonly`
types nor with a runtime freeze or verify. Whether state is mutable, and how
`decide` treats it, is the application's design decision. `evolve` mutating in
place is explicitly supported (§3).

The only commitment is the contract in §3: persisted, returned and projected
state is the `evolve` fold, never anything produced inside `decide`.

## 9. Test matrix

Each stage adds:

- **Unit tests** in `test/EventStore.test.ts` (mocked `DynamoClient`), covering
  request shapes, positional error mapping, retry interplay and type-level
  assertions.
- **Connected tests** in `test/connected.test.ts` against DynamoDB Local.

Required connected scenarios:

- **#139**: read-your-writes through `consistentRead`.
- **#136**: stale `expectedVersion` → `VersionConflict` with `actualVersion`.
  `decide` is not invoked, and a `retry` policy is not applied. A redelivered
  idempotent command carrying its original `expectedVersion` →
  `DuplicateCommand`.
- **#137**: the function form commits projection rows atomically with the
  events. A failing projection condition leaves no events behind.
- **#138**:
  - An inline snapshot is current after every command.
  - `readLatest` uses one request in steady state (assert the request count
    with a counting client wrapper).
  - Fallback when the snapshot is missing or lagging.
  - Pre-existing streams switched to inline.
- **Large commands (#141 guidance)**:
  - An append over 100 items → `AppendTooLarge` (`count`, `limit`), over
    4 MB → `ValidationError`; nothing written.
  - A 250-event command as fixed-size stepped commands chained by
    `expectedVersion`: each step one atomic transaction with its own
    snapshot, projection and per-step sentinel; a redelivered step →
    `DuplicateCommand`.
  - A writer between two steps → the next step's `VersionConflict` writes
    nothing, the stream stays at a consistent state, and re-issuing continues.
- **#140**:
  - An LSI table created via `indexDefinitions`.
  - Sparse indexing.
  - `beginsWith` / `between` / `reverse` / `limit` / `consistentRead` on the
    LSI.
  - A GSI variant, and refusal of `consistentRead` on the GSI.
  - Definition-time collision errors.
