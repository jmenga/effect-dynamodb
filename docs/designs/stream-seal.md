# Design: sealing a stream (#166)

**Issue:** [#166](https://github.com/jmenga/effect-dynamodb/issues/166)
**Status:** Designed, revised after adversarial review (§13), owner decisions recorded (C1,
G4, B3 in §12). Implemented in the same PR (single-PR workflow: this doc is commit 1).
**Builds on:** `eventstore-additional-items.md` (#85), `eventstore-command-path.md`,
`eventstore-snapshots.md` (#138), `eventstore-head-proof.md` (#164), `storage-encoding.md` (#147).
**Affected packages:** `packages/effect-dynamodb` (EventStore, internal/TransactWriteOps),
`packages/schema` (one new tagged error).
**Semver impact:** `minor`. Lockstep to **1.33.0**. Runtime behaviour is additive:
`writeSnapshot` is unchanged (§5.3). The new fields on read results are optional (§3.4). One type-level change is not purely additive: the
`additionalItems` input types widen (§3.2), which breaks code that *reads* those types and
forwards the value to `Transaction.transactWrite`. The changeset records it.

---

## 1. Problem

A table restore makes a stream's version numbers reusable. A writer that loaded version 10
before the restore can append onto a *different* version 10 written after it. The
application closes that hole by keying streams by generation (`{ accountId, generation }`):
after a restore, writers move to the next generation and nobody writes to the old one again.

One gap remains. A stale writer can still *succeed* in appending to the old generation when
the restored head happens to equal its `expectedVersion`. Nobody reads that generation any
more, so the write is silently lost.

**Sealing** closes it. A sealed stream accepts no further events. Closing a generation is
then one transaction: seal generation N at the version the carry-over read, and open
generation N+1. If a stale append landed in between, the seal's `expectedVersion` fails,
nothing is written, and the closer reloads and retries, carrying that append forward.

**The seal's `expectedVersion` is always the version the carried-over state was read at,
never a separate read of N's head.** Re-reading the head between the carry-over read and the
commit seals over an append that the opening event never carried, and that append is lost
(§8.3).

The library owns no notion of generations. It provides:

1. a `seal` option on `append`;
2. a way to put another stream's (sealing) append in an append's transaction;
3. a distinct `StreamSealed` error;
4. read results that say a stream is sealed and return the sealing event.

## 2. Mechanism in one paragraph

The sealing event is the caller's own event. The library adds a marker attribute,
`__edd_sealed__`, to that event's item, and to the inline snapshot when the sealing append
writes one. Every append after version 0 already writes a version-contiguity
`ConditionCheck` on event `expectedVersion`. Its condition becomes
`attribute_exists(pk) AND attribute_not_exists(#sealed)`. A writer that loads after the seal
fails that check. A writer that loaded before it fails as it does today, because its next
version is taken by the sealing event. The check is already in the transaction and already
reads the item, so the extra clause costs no capacity and no additional items. Which error
the writer gets is diagnosed from the cancellation reasons
(`ReturnValuesOnConditionCheckFailure: "ALL_OLD"`). Nothing is pre-read.

---

## 3. Public API

### 3.1 `append(..., { seal })` and `measureAppend`

```ts
interface AppendOptionsBase<TState = never> {
  // ...existing: additionalItems, idempotency, snapshot, eventTimestamps, headProof
  /**
   * Seal the stream with this append: its last event becomes the stream's final
   * event, and no append can land after it (`StreamSealed`).
   */
  readonly seal?: boolean | undefined
}
```

```ts
yield* Ledgers.append(
  { accountId: "a-1", generation: "3" },
  [new LedgerClosed({ continuedIn: "4" })],
  41,
  { seal: true },
)
```

- `seal: true` marks the **last** event of the append. The append writes events
  `expectedVersion + 1 … expectedVersion + n`, so the seal version is `S = expectedVersion + n`.
  `seal: false` and `undefined` do nothing.
- A `seal` that is not a boolean fails with `ValidationError`
  (`operation: "EventStore.append.seal"`) before anything is written.
- `seal: true` with **zero events** fails with `ValidationError`
  (`operation: "EventStore.append.seal"`, "a seal needs at least one event to mark. Nothing
  was written."). This is the same rule as an inline snapshot.
- On a stream whose snapshot config is `mode: "inline"` **without** `every`, `seal: true`
  also requires the `snapshot` option (`ValidationError`, `operation: "EventStore.append.seal"`).
  §5.3 explains why. `commandHandler` always attaches the snapshot on such streams.
- `seal` combines with every other option: `idempotency`, `additionalItems`, `snapshot`,
  `metadata` / `eventMetadata`, `eventTimestamps` and both head proofs.
- `MeasureAppendOptions` is `Omit<AppendOptionsBase, "additionalItems"> & ...`, so
  `measureAppend` accepts `seal` with no change. The marker's bytes and the longer condition
  expressions are counted, because `measureAppend` measures the items `buildAppend` builds.
- `AppendResult` is unchanged.

### 3.2 Another stream's append inside an append: `stream.appendOp`

```ts
interface EventStream<...> {
  /**
   * An append of this stream as a transact item of ANOTHER append's
   * `additionalItems`: it commits if and only if that append does.
   */
  appendOp(
    streamId: StreamIdInput<TStreamIdFields>,
    events: ReadonlyArray<TEvent>,
    expectedVersion: number,
    options?: NestedAppendOptions<TMetadata, TState>,
  ): StreamAppendOp
}

type NestedAppendOptions<TMetadata, TState> =
  Omit<AppendOptionsBase<TState>, "additionalItems" | "idempotency" | "headProof"> &
  AppendMetadataOptions<TMetadata>

/** Accepted by `append`'s `additionalItems` and `commandHandler`'s, nowhere else. */
type AppendWriteOp = TransactWriteOp | StreamAppendOp
```

- `appendOp` is on `EventStream` and on `BoundEventStream`. The bound op resolves its
  **`TableConfig`** (the table name) from the bound stream's captured context, so a stream on
  another table needs no extra layer in the outer append. An unbound op is built in the outer
  append's context, which must then provide the inner stream's `TableConfig`. Without it the
  result is a "service not found" defect, as for an entity op on an unprovided table.
- **One client per append.** The nested items are sent in the outer append's single
  `TransactWriteItems`, through the **outer** append's `DynamoClient`. A bound op's captured
  client is not used: one transaction cannot span clients. Every op in an append must therefore
  target a table that the outer client's account, region and endpoint can reach. A bound stream
  captured with a client for another region or endpoint resolves its table name against the
  outer endpoint, and fails there (`ResourceNotFoundException` / `TransactionCancelled`) or
  writes to a same-named table. This is documented on `appendOp`. There is no client-identity
  check (§13, review note 8).
- `AppendOptionsBase.additionalItems`, `AdditionalItemsInput` (`commandHandler`) and the
  handler's derived items widen from `TransactWriteOp` to `AppendWriteOp`.
  `Transaction.transactWrite` keeps `TransactWriteOp`. Its type rejects a `StreamAppendOp`,
  and at runtime the shared builder refuses one with `ValidationError` ("a stream append op
  rides only in an EventStore append's additionalItems").
- **Type-level impact of the widening.** Passing a value *into* these options is unaffected:
  a `TransactWriteOp[]` is still assignable, which a type test asserts for `append` and
  `commandHandler`. Code that *reads* one of these types and forwards the value to
  `Transaction.transactWrite` (for example `const items: AdditionalItemsInput<S, E> = [...]`
  reused with `transactWrite(items)`, or a helper typed
  `NonNullable<AppendOptions<M>["additionalItems"]>`) stops compiling, because the element type
  now includes `StreamAppendOp`. This is inherent in widening an input that is also a
  readable type. A separate alias would not avoid it, because the option property's own type
  must widen for `append` to accept the op. The fix for affected code is to annotate the value
  as `ReadonlyArray<TransactWriteOp>`. The changeset and the API reference record it.
- **Ordinary Entity ops ride alongside.** These already work in `additionalItems`: a
  conditional put (`.condition()`), a `create()`, a delete, `Transaction.check`, and the
  guarded puts of versioned or unique entities. **Updates are not accepted in
  `additionalItems` on `main`.** PR #129 adds them to `transactWrite` only, and deliberately
  keeps them out of `append`. **Decided (C1):** this PR writes the changeover's chain-index
  item as a whole-item Entity put, read-modify-write under an application `revision`
  condition (§4.5). It does not add Entity updates to `append`'s `additionalItems`; that is a
  follow-up after PR #129.
- The nested append is a full append of the inner stream: the contiguity check, the event
  puts, the seal marker and an optional inline snapshot (`seal`, `snapshot`, `metadata`,
  `eventMetadata` and `eventTimestamps` all apply).
- It may **not** carry `additionalItems`, `idempotency` or `headProof`. Those are excluded at
  the type level, and refused at runtime with `ValidationError`
  (`operation: "EventStore.appendOp"`) for untyped callers.
- **`appendOp` is exposed generally (decision B3).** `seal` is optional: a non-sealing nested
  append is an atomic multi-stream append (several streams' events commit together or not at
  all). This is a documented capability with its own unit and connected tests (§9), not a
  side effect of the seal machinery.
- Zero events fail with `ValidationError` (`operation: "EventStore.appendOp"`), because a
  nested append with no events writes nothing.
- A nested op cannot be a `headProof: { additionalItem: n }` target. It is not in
  `conditioned`, so the existing check refuses it with `ValidationError`, and the message names
  the stream op.

### 3.3 `StreamSealed`

```ts
// packages/schema/src/Errors.ts, next to VersionConflict
export class StreamSealed extends Data.TaggedError("StreamSealed")<{
  readonly streamName: string
  readonly streamId: string
  /** The version of the sealing event: the stream's final version. */
  readonly sealedVersion: number
}> {}
```

- It is terminal: no append to this stream can ever succeed again. `commandHandler` never
  retries it.
- It is exported from `packages/schema/src/index.ts` and `packages/effect-dynamodb/src/index.ts`
  alongside `VersionConflict`.
- It joins `AppendError` and `CommandHandlerErrors` (and so every handler's error channel). An
  embedded op's failure is reported through the outer append, so the outer `AppendError` already
  covers it.
- `sealedVersion` is always known. Every diagnosis reads it from the returned item's `version`
  (an event) or `asOfVersion` (a snapshot), from the loaded seal event, or from
  `LoadedState.sealedVersion`.

### 3.4 Read surface

```ts
interface StreamEvent<A, M> {
  // ...existing
  /** Present, and `true`, only on a sealing event: the stream's final event. */
  readonly sealed?: true
}

interface LatestState<TState, TEvent, M> {
  // ...existing: snapshot, events, version
  /**
   * The sealing event when the read found one, absent otherwise. It is separate
   * from `events` because `events` holds only what follows the snapshot, and a
   * snapshot written by the sealing append already folds it in.
   *
   * `seal.version < version` means events were written past the seal by a writer
   * that does not enforce it (§5.9). Those events are on a closed stream.
   */
  readonly seal?: StreamEvent<TEvent, M>
}
```

The new fields are optional and present only when sealed, so existing `toEqual` tests,
mocks and hand-built values are unaffected.

### 3.5 `commandHandler`

```ts
interface LoadedState<State> {
  readonly state: State
  readonly version: number
  /**
   * The caller's record says the stream is sealed at this version. It may be
   * `version + 1`: a record-proof stream keeps its record one below the seal
   * (§5.4).
   */
  readonly sealedVersion?: number | undefined
}
```

`sealedVersion` is a number rather than a `sealed` flag because the record's `version` and the
seal's version differ on record-proof streams (§5.4). A `sealedVersion` that is not a
non-negative integer, or is below `version`, fails with `ValidationError`
(`operation: "EventStore.commandHandler.loadState"`), as other malformed `loadState` results do.

§8 covers the behaviour. A handler never seals: `decide` cannot seal, and there is no
per-call `seal` (§12, decision D1). A handler on stream B may carry stream A's sealing
`appendOp` in its `additionalItems`.

### 3.6 Diagnostic codes

**No new `EDD-` code.** Every new refusal is a per-call input problem, so each is a
`ValidationError` without a code, following the repo convention for `EventStore.append.<option>`.
The marker name joins `STREAM_OWNED_ATTRIBUTES`, so an index attribute named `__edd_sealed__`
is refused by the existing `[EDD-9064]` at `makeStream`. The DESIGN.md row for EDD-9064 lists
it. The next free code stays **EDD-9086**.

---

## 4. Storage

### 4.1 The marker

- **Attribute:** `__edd_sealed__`, written as a native `BOOL` `true`. It sits in the
  library's `__edd_*__` namespace beside `__edd_e__`, so it cannot collide with a model field:
  event `data` is a nested map or a packed value, never top-level attributes.
- **Constant:** `SEALED_ATTRIBUTE = "__edd_sealed__"`, internal to `EventStore.ts`.
- **Written on:**
  - the **last event item** of a sealing append, added after the typed envelope the same way
    `metadata` is (not part of `EVENT_ITEM_ATTRIBUTES`);
  - the **inline snapshot item** of a sealing append, when it writes one.
- **Never written on:** the idempotency sentinel, or a snapshot written by `writeSnapshot` or
  by the handler's after-append path.
- **Never removed.** There is no unseal (§12).
- **Reserved:** added to `STREAM_OWNED_ATTRIBUTES`, which makes it subject to `[EDD-9064]`.
- **Size:** about 16 bytes per item, counted by `measureAppend` and by the existing limit
  diagnosis.

### 4.2 Packed storage (#147)

The marker is a top-level native attribute. It sits beside `data` (or a snapshot's `state`),
outside them. `storedAs.data` and `snapshot.storedAs` pack only those attributes, so packing
never touches the marker, and every read finds it in the same place in either form. A packed
sealed stream is covered by its own unit and connected tests (§9).

### 4.3 Stream indexes (#140, #149)

The marker is an attribute of the event item, so it reaches index reads according to the
index's projection.

| Projection | Index rows carry the marker? | `readIndex` / `query.index` reports `sealed` |
|---|---|---|
| `"all"` | yes (`ALL`) | yes |
| `"keys"` | no, but the events are fetched from the table (LSI `Select: ALL_ATTRIBUTES`, GSI `BatchGetItem`) | yes |
| `"withoutMetadata"` | no (`INCLUDE` = `EVENT_ITEM_ATTRIBUTES`) | **no** |

`EVENT_ITEM_ATTRIBUTES` is **not** changed. Adding the marker would change the `INCLUDE`
list that `indexDefinitions` emits. That list is immutable on an LSI and requires a GSI
rebuild, so every deployed `"withoutMetadata"` index would drift from its definition. The
`"withoutMetadata"` limitation is documented. A reader that needs the seal reads the stream
(`readLatest`), not a sub-stream index.

The partition rule of a shared derived index (#149) is unaffected: the sealing event's index
entries are written like any other event's.

### 4.4 Example layout: a changeover

```
pk                      sk                                 attributes
$app#v1#ledger#a-1#3    $app#v1#ledger.event_1#0000000041  version=41, ...
$app#v1#ledger#a-1#3    $app#v1#ledger.event_1#0000000042  version=42, eventType=LedgerClosed, __edd_sealed__=true
$app#v1#ledger#a-1#4    $app#v1#ledger.event_1#0000000001  version=1,  eventType=LedgerOpened (continuesFrom 3@42)
$app#v1#chain#a-1       $app#v1#chain                      revision=7, current=4, generations=[..., {3, validThrough: 42}]
```

All four writes on the right (seal 42, open 1, chain-index put, and the contiguity check on
`3@41`) are one `TransactWriteItems`. The `41` is the version at which the closer read
generation 3's state for the opening event; event 42 is the seal, so the stream's final
version is 42.

### 4.5 The chain-index item: read-modify-write as a conditional put

Decided (C1): the application's chain-index item is written as a whole-item Entity put.
Accepting Entity updates in `append`'s `additionalItems` is a follow-up after PR #129, not part
of this PR.

1. The closer reads the chain-index item, including an application-owned `revision` field.
2. It builds the new item from that read (every field, not only the changed generation
   entry) with `revision + 1`.
3. It puts it with `.condition({ eq: { revision: read.revision } })`, or `create()` for the
   first generation.

The `revision` condition makes the put safe against any concurrent writer of the item, because
every writer of the item increments `revision`. A condition on a single field is not enough: a
put replaces the whole item and would silently drop a concurrent edit to any other field. A
chain entity with `timestamps` must re-supply `createdAt` from the read, or its put resets it.
The example's chain entity carries no timestamps. The `changeover` example region shows this
pattern, and the tutorial explains it.

---

## 5. Enforcement on every append path

### 5.1 Contiguity check (`expectedVersion > 0`, events > 0, no head proof)

```
ConditionCheck { Key: event(expectedVersion),
                 ConditionExpression: "attribute_exists(#pk) AND attribute_not_exists(#sealed)",
                 ReturnValuesOnConditionCheckFailure: "ALL_OLD" }
```

`ExpressionAttributeNames` names both attributes, following the repo convention. A writer
whose `expectedVersion` is the seal version `S` fails here. `ALL_OLD` adds no read capacity
and no transaction size (`internal/ItemSize.ts:137`). It adds response bytes only on failure.

### 5.2 `expectedVersion = 0`

No contiguity check is written. The put of event 1 (`attribute_not_exists(pk)`) collides on
any non-empty stream. That is a `VersionConflict`, or a `StreamSealed` when event 1 is itself
the seal (§6.1). A stream cannot be "re-opened" from version 0.

### 5.3 `headProof: "snapshot"`

**Decision: mark, don't forbid.** The sealing append's inline snapshot carries the marker, and
the snapshot-proof condition becomes

```
"#asOfVersion = :expectedVersion AND attribute_not_exists(#sealed)"   (+ ALL_OLD)
```

At version 0 it stays `attribute_not_exists(pk)`, since a stream with no items can't be sealed.

Why marking rather than "a sealing append may not write a snapshot":

- `commandHandler` in `mode: "inline"` without `every` attaches the snapshot to **every**
  append, so forbidding it would make the handler unable to carry any seal on the only streams
  where the proof applies.
- The marker on the snapshot is also what makes the seal visible to `verifySnapshot: false`
  loads (§7), which read nothing else.
- "Don't advance the snapshot" can't be enforced. A later `writeSnapshot` or an after-append
  snapshot at `S` would advance it without the marker.

Why `seal` requires `snapshot` on `mode: "inline"` without `every` (§3.1). That config is the
only one that accepts the snapshot proof, and the requirement guarantees that the snapshot at
`S` carries the marker:

- A seal written **without** a snapshot leaves the snapshot at `K < S`.
- A later `writeSnapshot(id, state, S)` would then put an **unmarked** snapshot at `S`.
- A post-seal writer could prove the head with it and land at `S + 1`.

With the requirement, the snapshot at `S` is the marked one. `writeSnapshot` is monotonic
(`#asOfVersion < :v`), so it can never replace it, and no snapshot beyond `S` can legitimately
exist.

The requirement only binds the definition that performs the seal. A closer often runs in
another process, with its own definition of the stream that has no snapshot config or uses
`every`. Its seal is then accepted without a snapshot, and the snapshot stays unmarked below
`S`.

**`writeSnapshot` is unchanged (decision G4: no transactional `writeSnapshot`).** It stays a
plain conditional `PutItem` (`attribute_not_exists(#pk) OR #asOfVersion < :asOfVersion`), with
no `TransactWriteItems` and no `ConditionCheck` on the head. It does not know whether the
stream is sealed, and it never writes the marker. The rule is documented instead:
**`writeSnapshot` must not target a sealed head with an unmarked snapshot.** A maintenance job
that snapshots streams should skip sealed ones (`readLatest(...).seal` is present), or the
stream should be sealed through a definition that shares the writers' snapshot config, so that
the marked snapshot at `S` already exists and the monotonic condition stops `writeSnapshot`
from replacing it.

**The residual, documented.** All three of these together let an append land past the seal:

1. a closer on a definition **without** the inline-without-`every` snapshot config seals the
   stream at `S`, so no marked snapshot is written and the snapshot stays unmarked below `S`;
2. a manual `writeSnapshot(id, state, S)` (a maintenance job, a third definition) then puts an
   **unmarked** snapshot at the seal version `S`;
3. a writer with `headProof: "snapshot"` appends at `expectedVersion = S` (a raw append, or a
   handler whose unverified load sees only that snapshot). The proof
   `#asOfVersion = :expectedVersion AND attribute_not_exists(#sealed)` holds on the unmarked
   snapshot, no contiguity check is written under a head proof, and event `S + 1` lands and is
   reported as success.

That one write reopens the stream for every writer (§5.9). The read side still reports it
wherever the sealing event is fetched: a verified `readLatest` sets `seal` with
`seal.version < version`, and a handler with a verified load fails `StreamSealed` before
`decide`. Snapshots below `S` are harmless: a snapshot-proof writer at `K < S` passes the proof
but its first event put at `K + 1 ≤ S` collides (`VersionConflict`, or `StreamSealed` at
`K + 1 = S`). A snapshot at a version never written is the pre-existing H4 hole, unrelated to
sealing (§14). The `writeSnapshot` JSDoc, the `headProof` JSDoc and the tutorial state the rule
and the residual. Connected test 10 documents it.

**Unverified reads and a closer on another definition.** When the closer's definition wrote no
snapshot, the snapshot stays at `K < S`, unmarked. An unverified `readLatest` then does not
report the seal (§7.2). An unverified handler load decides on state at `K`, and, unless a
`writeSnapshot` at `S` has since created the residual above, its append still fails: at
`K = S - 1` the first event put hits the sealing event (`StreamSealed`). At
`K < S - 1` it gets a `VersionConflict` on its own stream. Without an If-Match, that sends the
handler to its verified reload, and the reload reports `StreamSealed` before deciding again
(§8.1). With an If-Match of `K`, the handler confirms the head with `headAbove`, finds it moved,
and answers `VersionConflict` as for any stale If-Match. The next load, without the stale
If-Match, reports the seal. For an
unverified read to see the seal, every definition that seals the stream should share the
writers' snapshot config. The tutorial says so.

### 5.4 `headProof: { additionalItem: n }`

**Decision: unenforced by the library, and documented.** Rejecting the combination is not
possible: the library cannot know at append time that the stream is sealed without a pre-read,
and pre-reads are not done (diagnose-on-failure).

A record proof replaces the contiguity check, so the seal's `attribute_not_exists` clause is
never evaluated on that path. What still runs is the **first event put** at
`expectedVersion + 1` (`attribute_not_exists(pk)`, with `ALL_OLD`, §6.1). The recommended
pattern makes every record-proof writer's first put land on the sealing event.

**Recommended: a one-event seal that leaves the record one below it.**

- The seal carries **exactly one event**, so `S = E + 1`, where `E` is the seal's
  `expectedVersion` and the record's version.
- The sealing transaction writes the record **without advancing its version**: it stays at
  `E = S - 1`. It sets the record's sealed flag and `sealedVersion: S`, for `loadState`. The
  record write is conditioned on `version = E`, either as the seal's own
  `headProof: { additionalItem }` or as an ordinary conditioned put next to a plain seal.
- Every record-proof writer, raw or handler, whether or not its `loadState` maps the flag,
  loads `E` and appends at `expectedVersion = E`. Its record condition holds, and its first
  event put at `S` fails on the sealing event, which `ALL_OLD` returns marked. Rule 3 (§6.1)
  reports `StreamSealed`. Nothing relies on the caller's condition.
- A handler whose `loadState` returns `sealedVersion` fails with `StreamSealed` before
  `decide` (§8.1), without spending a transaction.

**Why not advance the record to `S`.** A writer that loads a record at `S` appends at
`expectedVersion = S`. No contiguity check is written, the record condition `version = S`
holds, and event `S + 1` lands after the seal and is reported as success. One such write
reopens the stream for every writer (§5.9). Advancing the record is safe only if every
writer's record condition also tests the sealed flag. The tutorial and the `headProof` JSDoc
present this as the alternative for callers who must advance the record, not as the default.

**A seal of `n > 1` events on a record-proof stream** leaves the record at `E < S - 1`. A
writer at `E` fails its first put at `E + 1`, which is unmarked, with `VersionConflict`. A
handler then reloads the same record and loops until its schedule ends. So on record-proof
streams the seal is one event. This is documented, not enforced. The library can't tell that
a stream has record-proof writers when the seal itself carries no head proof, and the
flag-tested alternative is valid with any `n`.

**A changeover sealing a record-proof or `loadState` stream** (§8.3). A nested `appendOp`
cannot carry `additionalItems` or a `headProof` (§3.2), so A's record goes in the **outer**
append's `additionalItems`, beside A's `appendOp`. It follows the same rules: one event, and
the record kept at `S - 1` with the flag and `sealedVersion`. When A's writers use `loadState`
**without** a head proof, the sealing transaction must still write A's record with
`sealedVersion` (§8.2). Its version may be `S - 1` or `S`, since the contiguity check enforces
the seal on that path. Without that record write, a record left more than one version below
`S` loops a handler on `VersionConflict` instead of reporting the seal. The `appendOp` JSDoc,
the tutorial and the `changeover` example region show it.

### 5.5 Idempotency replay of a sealing command

The sentinel is judged first, so a redelivered sealing command (same `commandId`) is
`DuplicateCommand`, never `StreamSealed`. Its sentinel exists, and its contiguity check (on
`S - n`) and first event put (on `S - n + 1`) would also fail.

`commandHandler`'s pre-decide seal check probes the sentinel first, exactly as `ifMatchMismatch`
does (§8.1), so the handler reports `DuplicateCommand` there too.

### 5.6 Zero-event appends

An append of `additionalItems` and/or idempotency only writes no event, and therefore no
contiguity check. **It still lands on a sealed stream.** It adds nothing to the stream, and
its sentinel sorts before the events. A seal stops events, not side writes.

### 5.7 An embedded sealing op (`appendOp`)

The nested append's items are built by the inner stream's own `buildAppend`, so §5.1 to §5.3
apply to it unchanged: its contiguity check and first event put carry the extended condition
and `ALL_OLD`, its seal marker and its marked snapshot. The outer and nested appends are
enforced independently and commit together.

### 5.8 Mixed library versions

A writer on a library version before 1.33.0 writes the plain `attribute_exists(pk)` check,
and so **can append past a seal**. One such
write does not stay a single stray event: it reopens the stream for every writer (§5.9). Older
readers ignore the marker (`EventEnvelope` is a non-strict `Schema.Struct`). Upgrade every
writer of a stream before sealing it. The tutorial and the changeset say so.

### 5.9 One write past the seal reopens the stream

The seal is enforced on the event **at the writer's `expectedVersion`** (or the first one
after it), not on the stream. If any write bypasses it, by a pre-1.33 writer (§5.8), a
record-proof writer whose record was advanced to `S` (§5.4), or a snapshot-proof writer on an
unmarked snapshot that `writeSnapshot` put at `S` (the residual in §5.3), and lands event
`S + 1`:

1. Event `S + 1` carries no marker. An inline snapshot written with it at `S + 1` carries none
   either.
2. Every 1.33 writer that now loads the head at `S + 1` writes the contiguity check on
   `S + 1`. `attribute_exists(pk) AND attribute_not_exists(#sealed)` holds, so its append lands
   at `S + 2` and later, and is reported as success.
3. Those writes are on a closed generation that nobody reads, so they are lost.

**The write side cannot stop it.** A writer's transaction does not know `S`, and finding it
would need a pre-read. **The read side reports it** wherever the sealing event is among the
items a read already fetches:

- `readLatest` sets `seal` when **any** event item it decodes or fetches carries the marker,
  not only the newest. This includes events at or below the snapshot that the verified query's
  first page returns. No extra request is made. `seal.version < version` then says the stream
  has events past its seal.
- `read` / `readFrom` / `query.events` mark the sealing event wherever it is.
- `commandHandler`'s pre-decide check fails with `StreamSealed` (`sealedVersion` = the seal's
  version) whenever the load found a seal, including when later events follow it. It never
  decides on a stream past its seal. The handler logs a warning naming the post-seal versions
  (`seal.version + 1 … version`), because they are writes the application must recover.

**Where the read side is blind.** A verified `readLatest` with an inline snapshot reads the
snapshot plus `every` events (or one, without `every`). Once more bypass events than that
follow the seal, the sealing event is outside the read and nothing reports it. An unverified
read sees only the snapshot, which a bypass leaves unmarked. Only a full `read` finds the seal
then. Hence the rules: upgrade every writer before sealing (§5.8); on record-proof streams,
never advance the record to `S` (§5.4); never `writeSnapshot` a sealed head with an unmarked
snapshot (§5.3). The tutorial states the cascade in those terms.

---

## 6. Failure attribution

### 6.1 The outer stream

`sendAppendTransaction` keeps the raw `CancellationReasons` (`rawReasons`, which carry
`.Item`). It inspects the `Item` returned at three positions:

- the contiguity check;
- the **first** event put (it gains `ALL_OLD`);
- the snapshot-proof put (it gains `ALL_OLD` only when it is conditioned).

If any of them failed with `ConditionalCheckFailed` and its `Item` carries `__edd_sealed__`,
the append fails with `StreamSealed`. `sealedVersion` comes from the item's `version` (an
event) or `asOfVersion` (a snapshot).

New precedence:

1. `RepeatedItem` diagnosis (unchanged, before the conditional mapping).
2. **Sentinel → `DuplicateCommand`.**
3. **Own stream sealed → `StreamSealed`** (new).
4. Any other failure in `[0, guardCount + eventCount)` → `VersionConflict`.
5. Head proof failed → `VersionConflict`.
6. Additional items, via `judgeCancellation`:
   - a. **nested stream verdicts, in op order** (new, §6.2);
   - b. a guarded put's `fail` (`UniqueConstraintViolation` / `ValidationError`);
   - c. `conditions` → `AdditionalItemConditionFailed`;
   - d. `retry`.
7. `TransactionCancelled`.
8. Limit diagnosis afterwards (unchanged). The keys and targets now include the nested ops'.

Why `ALL_OLD` goes on the **first** event put only. The stale writer that matters is one that
loaded the head just before the seal (`expectedVersion = S - 1`). Its first put is at `S`, so
it is diagnosed as `StreamSealed` with no retry. `ALL_OLD` on every event put would return up
to 100 items of up to 400 KB each in a failure response, and would only help writers that are
already several versions stale. Those conflict as usual and learn of the seal on reload.

### 6.2 An embedded op

`buildTransactWriteItems(ops, operation, { streams: true })` accepts a `StreamAppendOp` only
when `append` asks it to.

- It runs the op's `_build`, which returns the nested items, their naming targets, their key
  attributes and a `verdict(reasonsSlice)`.
- It pushes the items with `provenance.kind: "stream"`.
- It records `streams: [{ opIndex, start, count, verdict }]`.
- It leaves the op **out of `conditioned`**.

`judgeCancellation` skips stream ranges in its generic loop, as it skips guarded ranges, and
returns `{ _tag: "stream", opIndex, error }` ahead of everything else. The nested verdict,
over the nested slice only:

| Nested failure | Verdict |
|---|---|
| contiguity check, first event put or snapshot proof failed and returned a marked item | `StreamSealed(A)` |
| any other failure of its contiguity check or event puts | `VersionConflict(A)` (`expectedVersion` = the op's) |
| a failure only at an unconditioned position (its snapshot put) | none (falls through to `TransactionCancelled`) |

Errors name the **inner** stream (`streamName`, `streamId`). The outer stream's own failures
are judged first (§6.1), so if B and A both fail, B's error is reported.

**Same stream inside and outside** (`B == A`): the two appends either touch one item twice,
which the existing `RepeatedItem` diagnosis reports as a `ValidationError`, or conflict. This
is not pre-checked, per the diagnose-on-failure rule. It is tested.

### 6.3 What a writer sees

| Writer | Fails at | Error | Why |
|---|---|---|---|
| loaded after the seal (`expectedVersion = S`) | contiguity check on `S` | `StreamSealed` | returned item carries the marker |
| loaded just before the seal (`S - 1`) | first event put at `S` | `StreamSealed` | returned item is the sealing event |
| further behind (`K < S - 1`) | first event put at `K + 1` | `VersionConflict` | the item at `K + 1` is unmarked; the handler retries, reloads and gets `StreamSealed` before `decide` |
| ahead (`> S`) | contiguity check | `VersionConflict` | nothing returned (no item) |
| `expectedVersion = 0`, `S = 1` | event put at 1 | `StreamSealed` | |
| `expectedVersion = 0`, `S > 1` | event put at 1 | `VersionConflict` | |
| `headProof: "snapshot"` at `S` | snapshot proof | `StreamSealed` | marked snapshot returned |
| `headProof: "snapshot"` at `K < S` | snapshot proof (marked at `S`) and event put `K + 1` | `StreamSealed` | rule 3 scans all three positions |
| `headProof: "snapshot"` at `S`, snapshot at `S` unmarked (written by `writeSnapshot` after a seal by a non-inline closer) | not enforced | (succeeds, and reopens the stream) | the residual of §5.3, §5.9 |
| `headProof: { additionalItem }`, record kept at `S - 1` (recommended) | first event put at `S` | `StreamSealed` | rule 3; raw or handler alike (§5.4) |
| `headProof: { additionalItem }`, record advanced to `S`, flag not tested | not enforced | (succeeds, and reopens the stream) | §5.4, §5.9 |
| redelivered sealing command | sentinel | `DuplicateCommand` | rule 2 |

---

## 7. Read side

### 7.1 Event decode

`decodeStreamEvent` adds `sealed: true` when the raw item carries the marker. Every event
reader goes through it: `read`, `readFrom`, `query.events`, `currentVersion`'s probe,
`decodeStreamImage` (DynamoDB Streams) and `indexDecoder`.

The sealing event of `read` is therefore its last event, carrying `sealed: true`.

`readFrom` returns it when it reads past `S - 1`. A catch-up reader already past `S` gets `[]`.
It learns of the seal from the sealing event it consumed, or from `readLatest`.

`currentVersion` and the internal `headAbove` probe still return numbers only. A caller
projection that omits the marker (`Query.select`) does not report it, which is documented.

### 7.2 `readLatest`, in every mode

All modes honour `consistentRead`.

| Mode | How `seal` is found | Extra requests |
|---|---|---|
| No snapshot config | an event read has `sealed` (the full stream is read) → `seal` = that event (also in `events`) | none |
| Verified, snapshot before `S` | the sealing event is in the delta → `seal` = it (also in `events`) | none |
| Verified, snapshot at or after `S` | an event item fetched by the query (`eventRaws`, including those at or below `asOfVersion`; the newest is always on page 1, since `Limit ≥ 2`) carries the marker → decode it into `seal`; **not** into `events` | none |
| `verifySnapshot: false`, snapshot marked | `GetItem` of the snapshot finds the marker → one more `GetItem` of `event(asOfVersion)`, decoded into `seal` | 1, only on a sealed stream |
| `verifySnapshot: false`, snapshot unmarked | no `seal` (the read sees only the snapshot; §5.3, §5.9) | none |
| `verifySnapshot: false`, no snapshot item | falls back to the verified read (unchanged) | |

`seal` is set from **any** marked item the read fetched, not only the newest (§5.9). Normally
the sealing event is the newest event. When it is not, `seal.version < version` reports events
written past the seal.

Keeping `seal` out of `events` when the snapshot is at `S` preserves `events`' contract ("the
events after the snapshot"). `commandHandler` folds `events` onto the snapshot, so including
the sealing event would apply it twice.

`verifySnapshot: false` is only accepted on `mode: "inline"` without `every`. On those streams,
§3.1 guarantees that a seal made **through a definition with that config** writes a marked
snapshot at `S`, so an unverified load sees the seal. A seal made through a definition without
it leaves the snapshot unmarked below `S`, and the unverified read does not report it. Writers
still cannot land past the seal unless a `writeSnapshot` puts an unmarked snapshot at `S` (the
documented residual, §5.3), and the handler reaches the seal through its verified reload. If the event `GetItem` finds nothing (impossible unless the data was corrupted),
`readLatest` falls back to the verified read.

### 7.3 Snapshot reads

`Snapshot` is unchanged. `readSnapshot` ignores the marker. `decodeSnapshotItem` reads it only
for `readLatest`'s unverified path, internally.

---

## 8. `commandHandler`

### 8.1 Seal checks

`StreamSealed` is a new class, so the retry predicate (which matches `VersionConflict` only,
§8.4) never retries it. `commit`'s `returnAppendConflict` catches only own-stream
`VersionConflict`s (§8.4), so an append-time `StreamSealed` propagates. The work is making sure
the seal is **reported** rather than looping as a `VersionConflict`.

- **Pre-decide check.** It runs after each load, and after the verified reload in the
  unverified flow (the `load(true)` at the "stale snapshot" branch). The loaded state carries
  `sealedVersion` when one of these holds:
  - `LatestState.seal` is present (every `readLatest` mode, including no snapshot config,
    where `readLatest` reads the whole stream). Any marked event counts, not only the newest
    (§5.9);
  - `loadState` returned `sealedVersion`.

  When sealed, the handler probes the idempotency sentinel when a `commandId` is given, and
  reports `DuplicateCommand` if it exists, exactly as `ifMatchMismatch` does. Otherwise it
  fails with `StreamSealed`. When `seal.version < version`, it also logs a warning naming the
  versions past the seal (§5.9).
- **Ranks above the If-Match check** when the load shows the seal. An If-Match on a sealed
  stream then reports `StreamSealed`, not `VersionConflict`: no retry can succeed, and the
  caller's correct move is to the successor stream. When the load does not show it (an
  unverified load from a snapshot below `S` with an If-Match equal to that snapshot), the
  If-Match answer stands (§5.3).
- **Before `decide`.** A sealed stream accepts no commands, including no-op decisions, whenever
  the load shows the seal.

### 8.2 By load mode

| Load mode | How the seal surfaces |
|---|---|
| Snapshot config, verified (default) | pre-decide from `LatestState.seal` |
| Snapshot config, `verifySnapshot: false` | pre-decide from `LatestState.seal`, via the marked snapshot (§7.2); with a snapshot left unmarked by a closer on another definition, through the append's `StreamSealed` or the verified reload (§5.3) |
| No snapshot config | pre-decide from `LatestState.seal` (any marked event) |
| `loadState`, record has `sealedVersion` | pre-decide, no stream read |
| `loadState`, record at `S` or `S - 1`, `sealedVersion` not mapped | the append's contiguity check or first event put → `StreamSealed` (§6.1) |
| `loadState`, record more than one below `S` | `VersionConflict` → retry → the same stale record, until the schedule ends. **The sealing transaction must write the record** (§5.4), which turns this into the first row |
| `loadState` + `headProof: { additionalItem }`, record kept at `S - 1` | the first event put at `S` → `StreamSealed`, or pre-decide when `sealedVersion` is mapped (§5.4) |

**Unverified flow details.** The cheap confirmations (`headAbove` after a no-op or a decide
failure, and the If-Match confirmation) can't see a seal. A marked snapshot triggers the
pre-decide check before they run. An unmarked snapshot below `S` (a closer on another
definition, §5.3) can never be at the head of a sealed stream, so `headAbove` finds the head
moved. Without an If-Match, the handler takes the verified reload, which reports
`StreamSealed`. With one, it answers `VersionConflict`, as for any stale If-Match.

### 8.3 Changeover: where A's version comes from

**Rule: the seal's `expectedVersion` is the version at which the carried-over state was read.
It travels with that state, in the opening event's back link, and nothing re-reads A's head
to get it.**

Why a fresh head read is wrong. Suppose the carry-over state is read from A at 42, a stale
writer then lands event 43 on A, and the seal is built from a fresh read of A's head (43). The
transaction commits B@1 carrying state through 42 and seals A at 44. Event 43 is in neither
B nor any stream anyone reads, and both the stale writer and the closer were told they
succeeded. Taking the seal's version from the carry-over read makes the seal's contiguity
check on 42 fail instead (event 43 exists, so the first put at 43 collides: `VersionConflict(A)`),
and nothing is written.

**Raw append (the tutorial's `changeover` region):**

```ts
const latest = yield* Ledgers.readLatest(genA, { consistentRead: true })
const opening = new LedgerOpened({
  continuesFrom: { generation: "3", version: latest.version },
  balance: carriedBalance(latest),
})
yield* Ledgers.append(genB, [opening], 0, {
  additionalItems: [
    Ledgers.appendOp(genA, [new LedgerClosed({ continuedIn: "4" })], latest.version, { seal: true }),
    chainIndexPut, // §4.5
  ],
})
```

The state and the version come from the same `readLatest` result. If `latest.seal` is present, A
is already closed and the closer moves on to B as it finds it. On `VersionConflict` naming A,
the closer re-reads A and builds both again, which carries the stale append forward.

**Through a handler on B.** A handler on B can return A's sealing `appendOp` from a
function-form `additionalItems`. That function takes A's version from the **decided opening
event** (for example `decision.events[0].continuesFrom.version`), never from its own read of A.
`decide` has no requirements (`R = never`), so A's state reaches it in one of two ways:

- **In the command.** The closer reads A and passes the state and its version. A retry re-runs
  `decide` on the same command, so a nested `VersionConflict(A)` repeats until the schedule ends.
  The closer then re-reads A and re-issues the command.
- **Read inside `decide`,** through a bound A stream (`R = never`). Each retried attempt reads A
  again, so the opening event and the seal's version move together, and the retry converges.

The `AdditionalItemsInput` JSDoc, the `appendOp` JSDoc and the tutorial state the rule and that
re-reading A's head separately loses appends.

- A nested `StreamSealed(A)` is terminal: another closer already sealed A.

### 8.4 A conflict on another stream

A `VersionConflict` raised by a nested op names A, not the handler's stream B. The handler
tells them apart by comparing `streamName` and `streamId` (formatted as `formatStreamIdOf`
formats B's id) with its own stream. On B's own conflicts nothing changes.

- **`commit`'s `returnAppendConflict` catches only own-stream conflicts.** A foreign
  `VersionConflict(A)` in the unverified flow propagates out of the attempt. It is not taken
  for a lagging snapshot of B, so there is no verified reload of B and no second `decide` or
  `additionalItems` derivation inside the attempt.
- **A foreign conflict is retried by the schedule even under an If-Match on B.** B's If-Match
  was not wrong, so returning the conflict as the If-Match answer would tell the client its B
  version is stale. A REST layer that maps `VersionConflict` to 412 would report that. The
  retried attempt reloads B and checks the If-Match again before `decide`, so B's conditional
  write is still enforced. The retry predicate becomes: retry an own-stream `VersionConflict`
  only without an If-Match; retry a foreign one in both cases. With an If-Match, `Effect.retry`
  wraps the attempt whenever a schedule is configured, and the predicate decides.
- **Without a schedule,** a foreign conflict is returned as-is and names A.
- A nested `StreamSealed(A)` is never retried, as for B.

The `AdditionalItemsInput` JSDoc and the command-handler retry section of DESIGN.md say so.

---

## 9. Test plan

### 9.1 Unit: `test/EventStore.seal.test.ts`

Uses a mocked `DynamoClient` in the style of `EventStore.test.ts`, with
`TransactionCanceledException` built with `CancellationReasons[i].Item`.

**Write shape**
- The marker is on the last event only, with 1 event and with 3 events.
- The marker is on the inline snapshot of a sealing append.
- No marker on the sentinel, on a non-sealing append, or on `writeSnapshot`.
- `writeSnapshot` still sends one plain conditional `PutItem`, unchanged (G4 dropped).
- The contiguity check's `ConditionExpression`, `ExpressionAttributeNames` and `ALL_OLD`.
- `ALL_OLD` on the first event put only.
- The snapshot-proof condition with `ALL_OLD`; an unconditioned snapshot put has no `ALL_OLD`.

**Validation (nothing sent)**
- `seal` with zero events.
- A non-boolean `seal`.
- `seal` without `snapshot` on `mode: "inline"` without `every`. The same call is accepted on
  `every` and after-append streams.

**Attribution**
- Contiguity failure with a marked item → `StreamSealed` with `sealedVersion`.
- With no item → `VersionConflict`.
- First event put with a marked item → `StreamSealed`.
- Unmarked → `VersionConflict`.
- Snapshot proof with a marked item → `StreamSealed`.
- Record proof (`{ additionalItem }`) at `S - 1` whose first event put returns the marked
  item → `StreamSealed`, with the record condition passing.
- Sentinel and seal failing together → `DuplicateCommand`.
- A sealed outer stream together with a failing additional item → `StreamSealed`.

**`appendOp`**
- Layout and provenance `kind: "stream"`.
- A non-sealing nested append (B3, atomic multi-stream append): both streams' events are in
  one transaction, no marker is written, and a nested contiguity failure is
  `VersionConflict(A)`.
- The nested verdicts (`StreamSealed(A)` / `VersionConflict(A)` naming A).
- Outer and nested failing together → the outer error.
- Nested and chain-index condition failing together → the nested error.
- A chain-index condition failing alone → `AdditionalItemConditionFailed { indices: [1] }`.
- Runtime refusal of nested `idempotency`, `headProof` and `additionalItems`.
- Zero events refused.
- Refused as a `headProof: { additionalItem }` target.
- Refused by `Transaction.transactWrite`.
- `B == A` → `ValidationError` via the `RepeatedItem` diagnosis.
- An `AppendTooLarge` count includes the nested items.
- Limit diagnosis names a nested item.
- A bound op builds in its captured context (a different table).

**Reads**
- `decodeStreamEvent` and `decodeStreamImage` set `sealed: true`, and omit it otherwise.
- `readLatest` in all six modes of §7.2: `seal` is present and decoded; when the snapshot is at
  `S`, `events` doesn't contain it; the unverified path makes exactly one extra `GetItem` only
  when sealed; `consistentRead` is passed on every request.
- `readLatest` with a marked event that is not the newest (an unmarked event at `S + 1` after
  it): `seal.version = S`, `version = S + 1`, in the no-snapshot and verified modes.
- `readIndex` for `"all"` and `"keys"` reports `sealed`; `"withoutMetadata"` doesn't.

**`commandHandler`**
- The pre-decide `StreamSealed` in every load mode of §8.2.
- `DuplicateCommand` ahead of `StreamSealed` with a `commandId`.
- `StreamSealed` ahead of an If-Match mismatch.
- An append-time `StreamSealed` is **not retried** (the mock counts exactly one transaction
  with a retry schedule configured).
- Nested `VersionConflict(A)` is retried, with function-form `additionalItems` re-derived from
  the new decision.
- Nested `VersionConflict(A)` **with an If-Match on B** and a schedule: retried, B's If-Match
  rechecked on the reload. Without a schedule: returned as-is, naming A.
- Nested `VersionConflict(A)` with `verifySnapshot: false`: no verified reload of B, `decide`
  runs once per attempt (the mock counts B queries and `decide` calls).
- An own-stream `VersionConflict` under If-Match is still not retried.
- Nested `StreamSealed(A)` is terminal.
- A no-op decision on a sealed stream → `StreamSealed`.
- A load whose seal is followed by later events → `StreamSealed` with `sealedVersion` = the
  seal's, a logged warning naming the later versions, and `decide` not called.
- `loadState` returning a malformed `sealedVersion` → `ValidationError`.

**Packed (`EventStore.packed.test.ts`)**
- A sealing append on a `storedAs.data` stream: marker native, `data` packed.
- A packed snapshot state with the marker.
- Both decode `sealed`.

### 9.2 Types

- `EventStore.types.test.ts`:
  - `seal` on `AppendOptions` and `MeasureAppendOptions`;
  - `appendOp`'s options exclude `additionalItems`, `idempotency` and `headProof`;
  - `AppendWriteOp` is accepted by `append` and `commandHandler` `additionalItems`;
  - a `ReadonlyArray<TransactWriteOp>`-typed value is still accepted by both (the widening
    breaks no caller that passes values in);
  - `StreamSealed` is in `AppendError` and in handler error channels;
  - `StreamEvent.sealed` is `true | undefined`;
  - `LatestState.seal`;
  - `LoadedState.sealedVersion`.
- `ErrorChannels.types.test.ts`: `StreamSealed` in the append and handler unions;
  `Transaction.transactWrite([stream.appendOp(...)])` is a type error.

### 9.3 Connected: `test/connected.eventstore-seal.test.ts`

Against DynamoDB Local, using the probe and setup template of
`connected.eventstore-head-proof.test.ts`.

1. Seal, then append at `S` → `StreamSealed`. The stream is unchanged.
2. Stale writer at `S - 1` → `StreamSealed`. At `S - 2` with one event → `VersionConflict`.
3. `expectedVersion = 0` on a sealed stream → `VersionConflict` (and `StreamSealed` when `S = 1`).
4. **Changeover success.** One append opens B at 0 with an opening event whose back link
   holds the version A's state was read at, carries A's sealing `appendOp` at that version,
   and a revision-conditioned put of a chain-index Entity item (§4.5). All three items are
   present, and A's last event is marked.
5. **Changeover atomic failure, once per failing member, nothing written in each case:**
   - B already opened → `VersionConflict(B)`;
   - **a stale append lands on A between the carry-over `readLatest` and the commit** →
     `VersionConflict(A)`. A's head stays at the stale event, unsealed; B stays empty; the
     chain index is unchanged. After the closer re-reads A and retries, B's opening event
     carries the stale event's version (§8.3);
   - A already sealed by another closer → `StreamSealed(A)`;
   - the chain-index `revision` condition is false → `AdditionalItemConditionFailed`.
6. Changeover across two tables, with a bound A op (same client, §3.2).
6c. **Atomic multi-stream append without a seal (B3).** One append on B carries a
   non-sealing `appendOp` on A: both streams' events land, and neither is marked. With A's
   `expectedVersion` stale, the append fails `VersionConflict(A)` and neither stream changes.
6a. **Changeover through a handler on B** with function-form `additionalItems` taking A's
   version from the decided opening event, and `decide` reading A through a bound stream: a
   stale append on A during the first attempt is retried and converges, with the second
   attempt's opening event carrying it.
6b. **`loadState` handler on A after a changeover** whose outer append also wrote A's record
   with `sealedVersion`: the handler fails `StreamSealed` before `decide`, with exactly one
   transaction counted (the changeover's) and none from the handler.
7. `readLatest` with `consistentRead: true` returns `seal` with the sealing event's data:
   - no snapshot config;
   - verified with a snapshot before `S`;
   - verified with a snapshot at `S`;
   - `verifySnapshot: false`.
8. `commandHandler` with a retry schedule: an append-time seal fails exactly once, with no
   retries (`ConsumedCapacity` / call count). Covered in every load mode, including `loadState`
   with and without `sealedVersion`, and `verifySnapshot: false`.
9. Head proofs:
   - a snapshot proof at `S` after a sealing append with a snapshot → `StreamSealed`;
   - **record left at `S - 1`** (one-event seal, record flagged, version not advanced): a raw
     `append` with `{ additionalItem }` at `S - 1` → `StreamSealed`, and the stream is
     unchanged;
   - record advanced to `S` with the flag untested: a raw record-proof append lands at
     `S + 1` (documents the boundary of §5.4);
   - with the record's `sealedVersion`, the handler reports `StreamSealed` before `decide`.
10. **`writeSnapshot` on a sealed head (the documented residual, §5.3).**
    - A closer definition without a snapshot config seals A at `S`. A `headProof: "snapshot"`
      append at the unmarked snapshot below `S` fails (`VersionConflict`, or `StreamSealed` at
      `S - 1`).
    - Then `writeSnapshot(id, state, S)` through the writers' inline-without-`every`
      definition writes an unmarked snapshot at `S`, and a raw `headProof: "snapshot"` append at
      `S` lands at `S + 1` (asserted, documenting the boundary, like the advanced-record case in
      test 9). A verified `readLatest` then returns `seal.version = S`.
    - Sealing through the writers' definition instead (marked snapshot at `S`) makes the same
      `writeSnapshot` a monotonic no-op, and the snapshot-proof append fails `StreamSealed`.
11. **One bypass reopens the stream (§5.9).** Seal at `S`, then land event `S + 1` with a
    record-proof append whose record was advanced to `S`. Then:
    - an ordinary append at `S + 1` succeeds at `S + 2` (asserted, documenting the cascade);
    - `readLatest` (no snapshot config, and verified inline with the seal within the read)
      returns `seal.version = S` and `version = S + 2`;
    - a `commandHandler` on the stream fails `StreamSealed` with `sealedVersion = S` and does
      not decide.
12. Packed storage: seal, then `read` / `readLatest` on a `storedAs.data` +
    `snapshot.storedAs` stream.
13. Idempotent sealing command redelivered → `DuplicateCommand`.
14. A zero-event side write on a sealed stream succeeds (documents §5.6).

Quality gates: `pnpm lint`, `pnpm check`, `pnpm test`,
`pnpm --filter effect-dynamodb test:connected` (mandatory: touches EventStore and
TransactWriteOps), doctest sync, and `npx tsx examples/event-sourcing.ts`.

---

## 10. Docs, example, release

- **Example** (`packages/effect-dynamodb/examples/event-sourcing.ts`, the source of truth).
  Add a `Ledgers` stream keyed `{ accountId, generation }` and a `LedgerChains` entity (the
  application's chain index), with these regions:
  - `seal-stream`: the stream and chain-entity definitions;
  - `seal-append`: `append(..., { seal: true })`;
  - `sealed-read`: `readLatest` with `consistentRead`, reading `seal`;
  - `changeover`: B's opening append whose back link and A's `appendOp` take A's version from
    the same `readLatest` result (§8.3), plus the revision-conditioned chain-index put (§4.5);
    a variant for a `loadState` stream also writes A's record with `sealedVersion` (§5.4);
  - `sealed-handler`: handling `StreamSealed` via `Effect.catchTag`.
- **Tutorial.** `tutorials/event-sourcing.mdx` gets a new **"Step 24: Sealing a Stream"** before
  "Running the Example", with those regions as code fences (`region=… example="event-sourcing.ts"`).
  It covers:
  - the generation pattern and why;
  - the stale-writer table (§6.3, abridged);
  - the changeover, with the rule that the seal's version is the carry-over read's version
    and that re-reading A's head separately loses appends (§8.3);
  - the chain-index read-modify-write under a `revision` (§4.5);
  - the head-proof rules: a sealing definition shares the writers' snapshot config (§5.3); on
    record-proof streams, a one-event seal that keeps the record at `S - 1` (§5.4);
  - `writeSnapshot` must not target a sealed head with an unmarked snapshot, and the residual
    when it does (§5.3);
  - `appendOp` without `seal` as an atomic multi-stream append (B3);
  - on `loadState` streams, the sealing transaction writes the record's `sealedVersion`, and in
    a changeover that write goes in the outer append's `additionalItems` (§5.4);
  - one client per append (§3.2);
  - the `"withoutMetadata"` limitation;
  - the zero-event side-write behaviour;
  - "upgrade every writer first", and that one write past the seal reopens the stream for
    every writer and hides the seal from `readLatest` (§5.9).

  Also update the failure table in Step 12 (add `StreamSealed`) and the Key Takeaways.
- **API reference** (`reference/api-reference.mdx`):
  - the `append` row (`seal`) and a new `appendOp` row;
  - `readLatest` / `LatestState.seal` and `StreamEvent.sealed`;
  - handler options (`LoadedState.sealedVersion`);
  - `writeSnapshot`'s sealed-head caveat (must not target a sealed head with an unmarked
    snapshot);
  - the `additionalItems` type widening note (§3.2);
  - the error table (`StreamSealed`).
- **DESIGN.md.**
  - §12: a new **"Sealing a Stream (#166)"** subsection after "Head Proof and `loadState`",
    covering the marker, enforcement, attribution precedence, reads, the handler and `appendOp`.
  - §12 "Command Handler Retry": add that `StreamSealed` is never retried, and that a
    `VersionConflict` naming another stream (a nested op's) is retried even under an
    If-Match and is never taken for a lagging snapshot (§8.4).
  - §12 snapshots: `writeSnapshot` must not target a sealed head with an unmarked snapshot,
    and the residual (§5.3).
  - §15: an error taxonomy row for `StreamSealed`, plus the declared-errors rows for `append` and
    `commandHandler`.
  - EDD registry: the `EDD-9064` row lists `__edd_sealed__`. No new row. "Next free" stays EDD-9086.
- **JSDoc.**
  - `AppendOptionsBase.seal`;
  - `appendOp` (usable with or without `seal`, version from the carry-over read, one client
    per append, the outer append carries A's record);
  - `StreamAppendOp`, `AppendWriteOp`, `StreamSealed`;
  - the `headProof` record rules (one-event seal, record kept at `S - 1`, §5.4);
  - `LatestState.seal` (including `seal.version < version`), `StreamEvent.sealed`,
    `LoadedState.sealedVersion`;
  - `writeSnapshot` (must not target a sealed head with an unmarked snapshot; the residual);
  - `AdditionalItemsInput` (A's version comes from the decision; foreign-conflict retry, §8.4).
- **Changeset.** `minor` for all four lockstep packages → **1.33.0**, via `pnpm changeset`, then
  `pnpm changeset version` in this PR. The note says:
  - writers must be upgraded before sealing, because one write past a seal reopens the stream;
  - `writeSnapshot` is unchanged and must not target a sealed head with an unmarked snapshot;
  - `appendOp` gives atomic multi-stream appends, with or without a seal;
  - the `additionalItems` types widen, which breaks code that reads them and forwards the value
    to `Transaction.transactWrite` (annotate it `ReadonlyArray<TransactWriteOp>`);
  - a nested op's `VersionConflict` is now retried under an If-Match.
  After merge, open PR #129 must rebump (1.34.0) and rebase over the `TransactWriteOps` changes
  (`provenance.kind: "stream"`, the `streams` judging).

---

## 11. Implementation map

| File | Change |
|---|---|
| `packages/schema/src/Errors.ts`, both `index.ts` | `StreamSealed`, exported |
| `EventStore.ts` | `seal` on `AppendOptionsBase`, plus its validation in `buildAppend`:<br>- the marker on the last event and on the snapshot;<br>- the extended contiguity and snapshot-proof conditions plus `ALL_OLD`;<br>- `ALL_OLD` on the first event put;<br>- `SEALED_ATTRIBUTE` in `STREAM_OWNED_ATTRIBUTES`;<br>- `StreamSealed` attribution in `sendAppendTransaction`;<br>- `AppendError`;<br>- `appendOp` / `StreamAppendOp` construction (closing over `buildAppend` and a verdict built from the same attribution);<br>- `bind` wraps `appendOp`'s build in `provide`;<br>- `AppendWriteOp` in `additionalItems` / `AdditionalItemsInput`;<br>- `decodeStreamEvent` `sealed`;<br>- `readLatest` `seal` (all modes, from any fetched marked event);<br>- `writeSnapshot` unchanged (JSDoc only);<br>- `LoadedState.sealedVersion` and its validation;<br>- handler pre-decide seal check (with the post-seal warning);<br>- own-stream vs foreign `VersionConflict` in `returnAppendConflict` and the retry predicate (retry wraps If-Match attempts too);<br>- `CommandHandlerErrors` |
| `internal/TransactWriteOps.ts` | `StreamAppendTypeId` / `StreamAppendOp` (the type lives here; `EventStore` builds it, which avoids an import cycle):<br>- the `{ streams }` option;<br>- `provenance.kind: "stream"`;<br>- the `streams` ranges;<br>- exclusion from `conditioned`;<br>- merged keys and targets;<br>- the `judgeCancellation` `"stream"` verdict;<br>- a refusal message for `transactWrite` |
| `Transaction.ts` | none (the builder refuses stream ops by default) |

---

## 12. Scoping decisions

Every item in the issue and its comments, plus the boundaries this design introduces. Rows
marked *(review)* were added or changed in response to the adversarial review (§13). Rows
marked *(owner)* record the owner's decisions, which override earlier drafts.

| # | Item | Decision | Reason |
|---|---|---|---|
| A1 | Seal as an option on `append` (`{ seal: true }`), not `stream.seal(...)` | **in** | The agreed revision. The sealing event is the caller's own event; the library only marks it. |
| A2 | Original `stream.seal(streamId, { expectedVersion })` | **changed** | Replaced by A1, per the owner's correction. |
| A3 | Enforcement by extending the existing contiguity check (`AND attribute_not_exists(marker)`) | **in** | No extra items or capacity (§5.1). |
| A4 | Writers that loaded before the seal fail because their version is taken | **in** | They are attributed `StreamSealed` when their first put hits the sealing event, `VersionConflict` otherwise (§6.3). |
| A5 | `seal` on `measureAppend` | **in** | Free via `MeasureAppendOptions`. |
| B1 | Another stream's sealing append inside an append's transaction (`additionalItems`) | **in** | `stream.appendOp(...)` / `StreamAppendOp` (§3.2). |
| B2 | Changeover mixes the sealing op with ordinary Entity ops in one transaction | **in** | Puts, `create()`, deletes, `Transaction.check` and guarded puts work today. |
| B3 | Nested append without `seal` (atomic multi-stream append) *(owner)* | **in (exposed generally)** | `appendOp` works with or without `seal`. Atomic multi-stream append is a documented capability with its own unit and connected tests (§3.2, §9), not just a side effect of the seal machinery. |
| B4 | Nested op with `idempotency`, `additionalItems` or `headProof` | **out (boundary)** | Refused (type and runtime). Keeps attribution to one sentinel and one proof per transaction. A sealed stream's record therefore rides in the outer append (§5.4). |
| B5 | `StreamAppendOp` in `Transaction.transactWrite` | **out (boundary)** | Append-only union. `transactWrite`'s error channel stays unchanged. |
| B6 | `measureAppend` of a whole changeover | **out** | `measureAppend` refuses `additionalItems`; measure A with `measureAppend` and add it. Documented. |
| B7 | A bound `appendOp`'s captured client *(review)* | **boundary (documented)** | Only its `TableConfig` is used. Every op is sent through the outer append's client, so all tables must be reachable from it (§3.2). No identity check. |
| B8 | Seal's `expectedVersion` source in a changeover *(review)* | **in (rule)** | Always the carry-over read's version, carried in the opening event's back link; never a fresh head read (§1, §8.3). |
| C1 | Entity conditional *update* of the chain-index item in the changeover *(owner)* | **changed (decided)** | The chain-index item is written as a whole-item Entity put, read-modify-write under an application `revision` condition (§4.5). Updates aren't accepted in `additionalItems` on `main`, and open PR #129 deliberately keeps them out of `append`. Entity updates in `append`'s `additionalItems` are **not** added in this PR; they are a follow-up after #129. |
| D1 | `decide()` sealing, or a per-call handler `seal` | **out** | A closer uses `append` / `appendOp` (it needs the cross-stream changeover anyway). Not trivial: it needs no-op and zero-event rules and handler snapshot coupling. |
| D2 | A handler on B carrying A's sealing op | **in** | `additionalItems` widened to `AppendWriteOp` (§8.3). A's version comes from the decision. |
| D3 | A nested op's `VersionConflict` in `commandHandler` *(review)* | **in (changed behaviour)** | Told apart by stream name and id. Never taken for B's lagging snapshot; retried by the schedule even under an If-Match on B, which is rechecked on reload (§8.4). |
| E1 | `StreamSealed` as its own tagged error | **in** | `{ streamName, streamId, sealedVersion }` in `packages/schema/src/Errors.ts` (§3.3). |
| E2 | `StreamSealed` attributed from cancellation reasons, no pre-read | **in** | `ALL_OLD` on the contiguity check, the first event put and the snapshot proof (§6). |
| E3 | `commandHandler` never retries `StreamSealed` | **in** | A new class falls outside the `VersionConflict` predicate. Pre-decide checks stop it looping (§8). |
| E4 | `StreamSealed` ranks below `DuplicateCommand` and above `VersionConflict` (including If-Match when the load shows the seal) | **in (boundary)** | Duplicate is the truer answer for a redelivery. Sealed is terminal and more actionable than a conflict. |
| F1 | `read` / `readFrom` / `query.events` report the seal | **in** | `StreamEvent.sealed?: true` on the sealing event (§7.1). |
| F2 | `readLatest` returns the sealing event's data, consistent reads | **in** | `LatestState.seal`, in every mode (§7.2), from any marked item the read fetched. The unverified mode costs one extra `GetItem` only when sealed. |
| F3 | `"withoutMetadata"` index reads report the seal | **out** | It would change deployed `INCLUDE` projections (§4.3). Documented. |
| F4 | `currentVersion` reports the seal | **out** | A number API. Use `readLatest`. |
| G1 | Head proof `"snapshot"` | **in (decided)** | Mark the sealing append's snapshot; the proof condition gains `attribute_not_exists`; `seal` requires `snapshot` on inline-without-`every` streams (§5.3). |
| G2 | Head proof `{ additionalItem: n }`: document or reject | **document (changed pattern)** *(review)* | Rejection needs a pre-read. Recommended: a one-event seal that keeps the record at `S - 1`, so every record-proof writer's first put hits the seal (§5.4). Advancing the record to `S` is safe only if every writer's condition tests the flag. |
| G3 | `LoadedState.sealedVersion` for `loadState` *(review: was `sealed`)* | **in (boundary)** | The only way a record-loaded handler sees the seal before `decide`. A number, because the record may sit one below the seal (§3.5). |
| G4 | `writeSnapshot` refuses a sealed head *(review, owner)* | **out (dropped), residual documented** | `writeSnapshot` stays a plain conditional `PutItem`: no `TransactWriteItems`, no `ConditionCheck` on the head. Documented instead: `writeSnapshot` must not target a sealed head with an unmarked snapshot. Residual: a non-inline closer, then a manual `writeSnapshot` at the seal version, then a `"snapshot"` head-proof writer can append past the seal (§5.3, §5.9). Connected test 10 documents it. |
| H1 | Zero-event side writes on a sealed stream | **in (documented)** | No event is written, so no seal is broken (§5.6). |
| H2 | Unseal / reopen | **out** | Not asked for. A seal is permanent. |
| H3 | Writers on an older library version | **documented** | They don't enforce the seal; upgrade before sealing (§5.8). |
| H4 | `writeSnapshot` at a version never written *(review)* | **out** | Pre-existing and unrelated to sealing. Refusing it changes `writeSnapshot`'s semantics, including at version 0, and needs its own decision. Follow-up issue (§14). |
| H5 | One write past the seal reopens the stream *(review)* | **documented + read-side detection** | The write side cannot know `S` without a pre-read. Bypass routes: a pre-1.33 writer, a record advanced to `S`, and the `writeSnapshot` residual (G4). Reads report a seal from any fetched marked event; the handler refuses to decide past a seal and logs the post-seal versions (§5.9). |
| I1 | Stream-scoped metadata item (original ask) | **out** | Per the issue. Generations as streams replace it. |
| I2 | Library-level generations, chain reader, cross-chain positions | **out** | Per the issue. Application keying choices. |
| I3 | Application-level chain index on an Entity item | **out (application)** | Supported by B2 / C1; owned by the application. |
| J1 | New `EDD-` codes | **none** | All refusals are per-call `ValidationError`s. `EDD-9064` covers the reserved marker name. |
| J2 | Type-level widening of `additionalItems` types *(review)* | **in (recorded)** | Inherent in accepting the op; breaks only code that reads the types and forwards to `transactWrite`. Recorded in §3.2, the changeset and the API reference (§3.2). |

---

## 13. Review notes

Adversarial review, round 1. Every finding was checked against the code on `main` (1.32.0).

1. **Fresh head read in §8.3 seals a stale append** — accepted. §1, §8.3, the `changeover`
   region and the JSDoc now take A's version from the carry-over read (the decided opening
   event, or the same `readLatest`). Connected test 5 covers a stale append between the read
   and the commit, and 6a the handler path.
2. **Advancing the record to `S` lets record-proof appends land past the seal** — accepted.
   Confirmed: `needsContiguityCheck` is false under any head proof (`EventStore.ts`
   `buildAppend`). §5.4 now recommends a one-event seal that keeps the record at `S - 1`, with
   `LoadedState.sealedVersion` replacing `sealed`. Tests: unit attribution, connected 9.
3. **One write past the seal reopens the stream** — accepted. New §5.9 documents the cascade.
   `readLatest` sets `seal` from any fetched marked event, and the handler refuses to decide
   past a seal. The write side cannot be closed without a pre-read. Connected test 11.
4. **Unmarked snapshot at `S` from a closer on another definition** — accepted as a documented
   residual. The suggested fix (a transactional `writeSnapshot` with an
   `attribute_not_exists(#sealed)` check on `event(asOfVersion)`) was drafted and then
   **dropped by the owner** (G4): `writeSnapshot` stays a plain conditional `PutItem`. §5.3
   documents that `writeSnapshot` must not target a sealed head with an unmarked snapshot and
   describes the residual. The suggested `attribute_exists(pk)` clause is not taken either
   (H4). Connected test 10 documents the boundary.
5. **Nested `VersionConflict(A)` treated as B's** — accepted. Confirmed in `makeCommandHandlerImpl`:
   no `Effect.retry` when `expectedVersion !== undefined`, and `returnAppendConflict` catches
   every `VersionConflict`. New §8.4: own-stream comparison, foreign conflicts retried under
   If-Match, never routed to the stale-snapshot path. Unit tests added.
6. **C1 substitutes a whole-item put for the requested update** — accepted, and decided by
   the owner. Confirmed that `buildTransactWriteItems` rejects updates on `main` and that #129
   keeps them out of `append`. The read-modify-write pattern under a `revision` condition (and
   `createdAt`) is documented (§4.5). Entity updates in `append`'s `additionalItems` are a
   follow-up after #129.
7. **`loadState` stream sealed through `appendOp` loops on a stale record** — accepted. §5.4,
   §8.2, the `appendOp` JSDoc and the `changeover` region say the outer append writes A's
   record with `sealedVersion`. Connected test 6b.
8. **A bound `appendOp`'s captured client is ignored** — accepted as documentation (§3.2,
   B7). The optional client-identity refusal is **rejected**: two equivalent clients built from
   separate layers are distinct instances, so the check would refuse valid same-endpoint
   setups, and the outer client is the only one a single transaction can use anyway.
9. **Widening the `additionalItems` types breaks readers** — accepted as a recorded type-level
   change (§3.2, J2, changeset). The suggested separate alias is **rejected**: the option
   property itself must widen for `append` to accept the op, so a reader of the property type
   breaks either way. A type test asserts that `TransactWriteOp[]` values are still accepted.

---

## 14. Follow-ups

No open questions remain. Two follow-ups sit outside this PR:

- **H4.** Should `writeSnapshot` refuse (or no-op) a version that was never written? Tracked
  as a separate issue.
- **C1.** Accept Entity updates in `append`'s `additionalItems`, after PR #129 lands.
