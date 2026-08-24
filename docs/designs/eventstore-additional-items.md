# Design: `EventStore.append` additional transaction items + command idempotency

**Issue:** [#85](https://github.com/jmenga/effect-dynamodb/issues/85) (split from [#80](https://github.com/jmenga/effect-dynamodb/issues/80), items 7 and 4)
**Status:** Designed → implemented in the same PR (single-PR workflow — this doc is commit 1).
**Affected packages:** `packages/effect-dynamodb` (EventStore, Transaction, new internal builder), `packages/schema` (two new tagged errors)
**Semver impact:** `minor` (lockstep across the four publishable packages). Additive API surface; one type-level widening of `append`'s error channel — see §10.

---

## 0. Reconciliation with #82 and #84 (release-train stacking)

This design was written against `main`. It ships stacked on top of
[#82](https://github.com/jmenga/effect-dynamodb/issues/82) (append guards) and
[#84](https://github.com/jmenga/effect-dynamodb/issues/84) (snapshots + retry), which
independently touched the same two surfaces. Three decisions below were superseded when
the branches were reconciled; the rest of this document stands as written.

1. **Oversize appends raise `AppendTooLarge`, not `TransactionOverflow`.** #82 had already
   introduced a dedicated `AppendTooLarge` error for exactly this guard, carrying
   `streamName` / `streamId` / `count` / `limit`. Two errors for one condition is worse
   than either, so the guard raises `AppendTooLarge` and counts
   `events + additionalItems + sentinel + contiguityCheck`. §5, §7 and §10 should be read
   with that substitution.

2. **There is exactly one limit constant: `TRANSACT_WRITE_ITEMS_LIMIT`.** #82 introduced it
   as a public export of `@effect-dynamodb/schema/Errors.js`, referenced by
   `AppendTooLarge`'s own docs. The `MAX_TRANSACT_ITEMS` constant this design proposed for
   `internal/TransactWriteOps.ts` was dropped, and `Transaction.transactWrite` points at
   the schema-package constant instead.

3. **Item layout gains a leading `ConditionCheck`.** #82 prepends a version-contiguity
   `ConditionCheck` when `expectedVersion > 0` and events are being written, so the layout
   is `[contiguityCheck?, events…, additionalItems…, sentinel]`. The positional
   cancellation mapping in §6 is offset by that check, and a failure at its index maps to
   `VersionConflict` — the same verdict as a failed event put. The sentinel remains LAST,
   so caller-visible `additionalItems` indices are unchanged, which is the invariant §6
   actually depends on. A zero-event append (pure side-write) writes no version and so
   carries no contiguity check.

Additionally, `commandHandler`'s data-last dual is #84's hand-rolled dispatch on the
`EventStreamTypeId` brand rather than the `Function.dual` predicate form proposed here.
Both are correct; the brand dispatch was kept because it is the incumbent and because
`Function.dual`'s *numeric-arity* form silently drops the trailing options argument that
both `{ retry }` (#84) and `{ idempotency }` (this design) depend on. `CommandHandlerOptions`
is a single type carrying both.

---

## 1. Executive summary

`EventStore.append` builds the whole `TransactWriteItems` call itself. That makes the
most common "event sourcing plus one side record" patterns — a per-writer watermark,
a stream registry row, a uniqueness guard, a command-dedup sentinel — impossible
without abandoning the EventStore API and hand-rolling the transaction.

This design adds two things:

1. **`options.additionalItems` on `append`** — a list of the library's own
   `Transaction` write ops (`EntityPut`, `EntityDelete`, `Transaction.check(...)`)
   merged into the same `TransactWriteItems` call as the event puts, so the side
   record commits atomically with the events.

2. **Command idempotency built on (1)** — `commandHandler(decider, stream, { idempotency })`
   plus a per-call `commandId`. The handler writes a dedup **sentinel item** guarded by
   `attribute_not_exists(pk)` into the same transaction. A replayed `commandId` fails
   with a typed `DuplicateCommand` error.

The correctness-critical part of (1) is **position-aware cancellation mapping**. Today
*any* `ConditionalCheckFailed` in `CancellationReasons` becomes `VersionConflict`
(`EventStore.ts` ~L333). The moment caller-owned items share the transaction that is
simply wrong: a failed user condition would be reported to the caller as a version
conflict, and the caller's natural response to a version conflict — re-read, re-decide,
retry — would spin forever against a condition that can never pass. The mapping becomes
index-aware: conditional failures at *event-put* positions → `VersionConflict`;
failures at *additional-item* positions → the new `AdditionalItemConditionFailed`;
failures at the *sentinel* position → `DuplicateCommand`.

One-screen example:

```ts
// 1. Additional items — a per-writer watermark committed with the events
yield* matchEvents.append({ matchId: "m-1" }, [new InningsCompleted({ ... })], 3, {
  additionalItems: [
    Watermarks.put({ writerId: "ingest-1", matchId: "m-1", lastSeq: 4021 }),
    Watermarks.get({ writerId: "ingest-1" }).pipe(
      Transaction.check(Expression.condition({ lt: { lastSeq: 4021 } })),
    ),
  ],
})

// 2. Command idempotency — exactly-once command processing
const handleMatch = EventStore.commandHandler(matchDecider, matchEvents, {
  idempotency: { ttl: Duration.days(1) },
})
yield* handleMatch({ matchId: "m-1" }, command, { commandId: "cmd-7f3a" })
yield* handleMatch({ matchId: "m-1" }, command, { commandId: "cmd-7f3a" }) // → DuplicateCommand
```

---

## 2. `additionalItems` — raw transact items vs. library op builders

The issue poses this as the primary design question. **Decision: reuse the library's
`Transaction` write ops.**

| Option | Verdict |
|---|---|
| **A. Raw AWS transact-item shapes** (`{ Put: { TableName, Item, ConditionExpression } }`) | Rejected. Leaks `@aws-sdk` shapes into a typed, schema-driven API; the caller must marshall, compose keys, and name the table by hand — exactly the work the ORM exists to do. It is also unvalidated: a mis-composed key produces a silently-orphaned item. |
| **B. The library's `Transaction` op builders** (`EntityPut`, `EntityDelete`, `ConditionCheckOp`) | **Chosen.** Same union `Transaction.transactWrite` already accepts, so callers reuse knowledge and code. Keys are composed, input is Schema-validated, table names are resolved from the entity's `TableConfig`, and everything stays typed. |

### 2.1 Accepted op union

```ts
type TransactWriteOp = EntityPut<any, any, any, any> | EntityDelete<any, any> | ConditionCheckOp
```

This is **byte-identical to what `Transaction.transactWrite` accepts today**, and that
is deliberate: `additionalItems` and `transactWrite` consume the *same* builder, so the
two APIs can never drift.

### 2.2 `EntityUpdate` is deferred (and why)

The issue lists "Put / Update / Delete / ConditionCheck". `Update` is **out of scope for
v1**, because `Transaction.transactWrite` does not support it either — it explicitly
throws on an update intermediate. The reason is structural, not an oversight:
`Entity.update`'s expression compilation is a ~900-line generator fused to its
`client.updateItem` call site, and it is entangled with policy-aware GSI recomposition,
the optimistic-lock CAS, cascade, `clearMap`'s read-before-write, and sparse-map
serialization. Lifting `UpdateState → transact item` out of that is a real refactor with
regression exposure on the library's hottest write path, and it belongs in its own PR.

Because both APIs consume the same builder, **when `transactWrite` gains `EntityUpdate`
support, `additionalItems` gains it for free** — no EventStore change required. That is
the payoff of choosing option B and is the reason the deferral is cheap.

Callers who need an update-in-transaction today can express most cases as an
`EntityPut` (full-item write) plus a `Transaction.check(...)` guard.

### 2.3 Shared builder extraction

`Transaction.transactWrite` currently inlines op classification, table-name resolution,
put-item construction, and transact-item assembly. That block moves to a new internal
module:

```
packages/effect-dynamodb/src/internal/TransactWriteOps.ts
  MAX_TRANSACT_ITEMS = 100          // named limit constant (see §5)
  ConditionCheckTypeId, ConditionCheckOp, TransactWriteOp
  buildTransactWriteItems(ops, operation)
    : Effect<Array<Record<string, unknown>>, ValidationError, TableConfig>
```

`Transaction.ts` re-exports `ConditionCheckTypeId` / `ConditionCheckOp` so its public
surface is unchanged, and `transactWrite` becomes `build → execute`. `EventStore.append`
calls the same builder. No import cycle: the internal module depends on `Entity`, and
`Entity` does not depend on it.

Note the builder's `R` is `TableConfig` only — no `DynamoClient` — so it stays a pure
compile step that both call sites can run before deciding what to do with the items.

---

## 3. Position-aware cancellation mapping

### 3.1 Transaction item layout

`append` assembles items in a fixed order so positions are derivable without threading
per-item state through the AWS call:

```
index                       role
-----------------------------------------------------------------
[0, E)                      event puts            (E = events.length)
[E, E + A)                  additional items      (A = additionalItems.length)
E + A                       idempotency sentinel  (present only when configured)
```

Additional items keep their caller-visible ordering, so transaction index `E + i` maps
back to `additionalItems[i]` by subtraction — the index reported to the caller is the
index **into `additionalItems`**, not the raw transaction index, because the caller
never sees the event puts.

The sentinel goes **last** precisely so that adding it does not shift additional-item
indices; a caller's index handling is identical with and without idempotency.

### 3.2 Mapping rules

Given `CancellationReasons` (an array positionally aligned with `TransactItems`;
non-failing positions carry `Code: "None"`):

1. **Sentinel position has `ConditionalCheckFailed`** → `DuplicateCommand`.
2. Else **any event position has `ConditionalCheckFailed`** → `VersionConflict` (unchanged behaviour for the no-additional-items case).
3. Else **any additional-item position has `ConditionalCheckFailed`** → `AdditionalItemConditionFailed`, carrying the failing indices *and* the full reason list.
4. Else → `TransactionCancelled` (unchanged: throttling, `TransactionConflict`, `ItemCollectionSizeLimitExceeded`, validation).

Rule 4 is also the fallback when `CancellationReasons` is absent or shorter than the
item list — we never guess a `VersionConflict` we cannot positionally justify.

### 3.3 Why that precedence order

The rules are ordered by *what the caller should do next*, from most terminal to most
retryable:

- **`DuplicateCommand` beats `VersionConflict`.** When a command is replayed *and* the
  stream has advanced, both conditions fail. Reporting `VersionConflict` would invite a
  read-decide-retry loop whose only possible outcome is `DuplicateCommand` on the next
  pass — one wasted round trip and a confusing log line. Duplicate is terminal: report it
  immediately.
- **`VersionConflict` beats `AdditionalItemConditionFailed`.** A version conflict means
  the caller decided against stale state, so the additional item's condition was
  evaluated against a premise that no longer holds. Re-reading and re-deciding is the
  correct response, and it may well produce a different additional item.

Precedence is documented on the errors themselves so callers do not have to reverse-engineer it.

### 3.4 What this fixes

Before, with a caller-supplied `ConditionCheck` in the transaction:

```
condition on Watermarks fails → VersionConflict{ expectedVersion: 3 }   ✗ lie
```

After:

```
condition on Watermarks fails → AdditionalItemConditionFailed{ indices: [1], reasons: [...] }  ✓
stream advanced to v4         → VersionConflict{ expectedVersion: 3 }                          ✓
```

---

## 4. Command idempotency

### 4.1 Default remains at-least-once

Without `idempotency`, a retried command after an acked-but-lost response re-runs
`decide` and appends again. That is a legitimate default — it is what every optimistic
concurrency ES store does — but it was undocumented. The tutorial now states it
explicitly, whether or not the reader opts in to the hook.

### 4.2 Reject, don't replay

The issue offers two v1 semantics for a replayed `commandId`:

| Semantics | Verdict |
|---|---|
| **Reject with a typed error** | **Chosen.** The sentinel needs to carry only the key. Fits DynamoDB's `attribute_not_exists` guard exactly, costs one 100-ish-byte item, and the failure is unambiguous and terminal. |
| **Return the previously recorded result** | Deferred. Requires serializing the `CommandHandlerResult` (state + events) onto the sentinel, which drags the state type into the persistence layer (it must become a `Schema`), risks the 400 KB item cap for large aggregates, and forces a schema-evolution story for stored state. It is a strictly larger feature and can be added later behind the same `idempotency` option without breaking the reject path. |

`DuplicateCommand` carries `streamName`, `streamId`, and `commandId`, so a caller that
wants replay semantics can implement it today: catch the error, re-read the stream, and
fold. That is exactly what the deferred variant would do internally, minus the storage.

### 4.3 Sentinel placement — co-located in the stream partition

| Option | Verdict |
|---|---|
| **A. Own partition** — `pk = $schema#v1#match.command#<commandId>` | Rejected. Gives cross-stream global dedup, but the transaction then spans two partitions, and an orphaned sentinel is invisible to every stream-scoped operation (no purge story without a scan). |
| **B. In the stream's partition** — `pk = <stream pk>`, `sk = $schema#v1#match.command#<commandId>` | **Chosen.** |

Rationale for B:

- **Correct scope.** A command is addressed *to a stream*. `commandId` uniqueness only
  needs to hold within that stream, and stream-scoped dedup is what "did I already apply
  this command to this aggregate?" actually asks.
- **Single-partition transaction.** Cheaper and avoids cross-partition hot-spotting on a
  writer that retries.
- **Discoverable and purgeable.** The sentinel lives with its stream; deleting or
  archiving a stream partition takes its sentinels with it.
- **Invisible to reads by construction.** `read` / `readFrom` / `currentVersion` all
  filter on `__edd_e__ = "<stream>.event"`; the sentinel carries
  `__edd_e__ = "<stream>.command"` and is filtered out. It also sorts *before* the event
  keys (`.command` < `.event`), so it cannot land inside a `readFrom` range scan's
  results either.

### 4.4 Sentinel item layout

```
pk         $cricket#v1#match#m-1                      (stream partition key)
sk         $cricket#v1#match.command#cmd-7f3a         (DynamoSchema.composeKey)
__edd_e__  match.command
streamId   m-1
commandId  cmd-7f3a                                   (raw, un-cased)
version    4                                          (expectedVersion + events.length)
timestamp  2026-08-23T…                               (clock-backed, same instant as the events)
_ttl       1787…                                      (only when idempotency.ttl is set)
```

Guard: `ConditionExpression: "attribute_not_exists(pk)"` — the same guard the event puts use.

**Casing caveat.** `DynamoSchema.composeKey` applies the schema's casing (default
`"lowercase"`) to the whole key, composite values included. Two command ids differing
only in case therefore collide. This is the library-wide key convention, not a special
case here; it is documented, and the raw `commandId` is stored as an attribute so the
original is never lost. Use case-insensitively-unique ids (UUID / ULID) — which is what
command ids are in practice.

### 4.5 TTL

`idempotency.ttl?: Duration.Duration | string`. When set, the sentinel gets an epoch-seconds
TTL attribute whose name comes from `Table.resolveTtlAttributeName(tableConfig)` — so it
honours `TableConfig.ttlAttributeName` (#51) like every other lifecycle feature.

TTL is **opt-in, not defaulted**, because the correct value is a policy decision the
library cannot make: it is the maximum window over which the caller's infrastructure can
replay a command (SQS retention, Lambda retry budget, a human clicking twice). Defaulting
it would silently re-open the dedup window at whatever moment the operator's retry policy
outlived our guess. When unset, sentinels are permanent — the safe direction, and the
partition is already the stream's.

The TTL instant is derived from the same `DateTime.now` the events use, so it is
deterministic under `TestClock`.

### 4.6 No events, no sentinel

If `decide` returns zero events the handler short-circuits — there is no append, so
there is no transaction and no sentinel. A replayed no-op command re-runs `decide` and
again produces nothing. This is documented rather than "fixed": writing a sentinel for a
command that produced no state change would mean paying a write to record a no-op, and
would make a genuinely idempotent no-op command fail on its second delivery.

---

## 5. Transaction size limit

DynamoDB caps `TransactWriteItems` at 100 items. `append` now counts:

```
events.length + additionalItems.length + (idempotency ? 1 : 0)
```

Over the cap → `TransactionOverflow` (the existing tagged error, already used by
`Entity`'s own guard) with `{ entityType, operation: "EventStore.append", itemCount, limit }`.
The check runs **before** any AWS call, so an oversized append costs nothing.

The limit lives as the named constant `MAX_TRANSACT_ITEMS` in
`internal/TransactWriteOps.ts` and is the single source of truth for both
`Transaction.transactWrite` and `EventStore.append`. Sibling PR #82 (append guards) is
expected to add its own count guard; it should import this constant rather than
introduce a second one, and the two guards collapse cleanly because both use
`TransactionOverflow`.

`Transaction.transactWrite`'s existing over-limit error stays `DynamoError` (changing it
to `TransactionOverflow` would alter a public error channel for no benefit inside this
issue's scope); only the magic `100` is replaced by the constant.

---

## 6. API surface

### 6.1 `append`

```ts
readonly append: (
  streamId: StreamIdInput<TStreamIdFields>,
  events: ReadonlyArray<TEvent>,
  expectedVersion: number,
  options?: {
    readonly metadata?: TMetadata
    readonly additionalItems?: ReadonlyArray<TransactWriteOp>
    readonly idempotency?: { readonly commandId: string; readonly ttl?: Duration.Duration | string }
  },
) => Effect.Effect<
  AppendResult<TEvent>,
  | VersionConflict
  | DuplicateCommand
  | AdditionalItemConditionFailed
  | TransactionOverflow
  | DynamoClientError
  | ValidationError
  | TransactionCancelled,
  DynamoClient | TableConfig
>
```

`BoundEventStream.append` mirrors this with `R = never`.

**Empty-events edge case.** `append(streamId, [], v)` returns early today without a
transaction. That early return is now conditional: if `additionalItems` or `idempotency`
is present, the transaction still runs (a caller asking for a side-effect write plus a
dedup guard means it, and silently dropping it would be a data-loss footgun). With no
events *and* no options, the early return is preserved unchanged.

### 6.2 `commandHandler`

```ts
EventStore.commandHandler(decider, stream, {
  idempotency?: { ttl?: Duration.Duration | string }
})
```

The returned handler takes per-call options:

```ts
handler(streamId, command, {
  metadata?: TMetadata
  commandId?: string                            // required when idempotency is configured
  additionalItems?: ReadonlyArray<TransactWriteOp>
})
```

Config splits across the two levels along the axis of *what varies*: `ttl` is a policy
fixed for the handler; `commandId` identifies one delivery and can only be per-call.

When `idempotency` is configured, `commandId` is **required at the type level** — the
handler's options parameter becomes non-optional and `commandId` non-optional, via a
conditional rest-tuple on the handler type. A runtime guard backs it up for JS callers
and `any`-shaped call sites, failing with `ValidationError` rather than silently
degrading to at-least-once. Silent degradation is the one behaviour worth engineering
against here: it would look exactly like success until the day a duplicate mattered.

### 6.3 Pre-existing bug fixed in passing

`commandHandler` is `Function.dual(2, (decider, stream) => …)`. Effect's `dual` passes
`self` **first**, so the documented data-last form `pipe(stream, commandHandler(decider))`
actually invokes the body as `(stream, decider)` — arguments swapped, i.e. broken. It was
never exercised by a test, which is why it survived. (The JSDoc also showed
`stream.pipe(…)`, which cannot work either: `EventStream` is not `Pipeable`.)

Per the repo's fix-adjacent-debt rule this is fixed here rather than deferred, since the
function is being restructured anyway for the options parameter: `dual` moves to its
predicate form (`args[1]` is stream-like → data-first), and the body normalizes argument
order by detecting `EventStreamTypeId`. The predicate form is required regardless — the
arity form drops a third argument on the floor. A unit test now covers the pipeable form.

---

## 7. Errors

### 7.1 Introduced (`packages/schema/src/Errors.ts`, exported through both barrels)

```ts
/** A caller-supplied `additionalItems` condition failed during `EventStore.append`. */
export class AdditionalItemConditionFailed extends Data.TaggedError("AdditionalItemConditionFailed")<{
  readonly streamName: string
  readonly streamId: string
  /** 0-based indices into the caller's `additionalItems` array whose conditions failed. */
  readonly indices: ReadonlyArray<number>
  /** Full positional cancellation reasons, for diagnostics. */
  readonly reasons: ReadonlyArray<{ readonly code?: string | undefined; readonly message?: string | undefined }>
}> {}

/** A command with this `commandId` was already applied to this stream. */
export class DuplicateCommand extends Data.TaggedError("DuplicateCommand")<{
  readonly streamName: string
  readonly streamId: string
  readonly commandId: string
}> {}
```

Both live in the schema package because that is where every other tagged error lives, and
neither needs AWS types (`reasons` is the library's own structural shape, already used by
`TransactionCancelled`).

### 7.2 Reused

`VersionConflict`, `TransactionCancelled`, `TransactionOverflow`, `ValidationError`.

---

## 8. Testing

### 8.1 Unit (`test/EventStore.test.ts`)

- additional items are appended after event puts, in caller order, with correct `TableName` / marshalled `Item`
- `EntityPut`, `EntityDelete`, `Transaction.check` each produce the right transact-item shape
- position-aware mapping: conditional failure at an event position → `VersionConflict`
- position-aware mapping: conditional failure at an additional-item position only → `AdditionalItemConditionFailed` with the right `indices`
- conditional failure at both → `VersionConflict` (precedence)
- non-conditional reasons → `TransactionCancelled`
- absent / short `CancellationReasons` → `TransactionCancelled`
- sentinel item shape: keys, `__edd_e__`, `commandId`, `version`, guard expression
- sentinel TTL present / absent; honours `TableConfig.ttlAttributeName`
- sentinel is last; additional-item indices unaffected by idempotency
- duplicate sentinel → `DuplicateCommand`; duplicate + version conflict → `DuplicateCommand` (precedence)
- over-100 item count → `TransactionOverflow`, no AWS call
- empty events + `additionalItems` → transaction still runs; empty events + no options → no call
- `commandHandler` with idempotency but no `commandId` → `ValidationError`
- `commandHandler` data-last pipeable form works (regression test for §6.3)

### 8.2 Connected (`test/connected.test.ts`, mandatory per CLAUDE.md)

New `EventStore` section on its own `Date.now()`-suffixed table (sibling agents share the
DDB Local instance), with a `Watermarks` entity registered on the same table so real
`EntityPut` / `ConditionCheck` ops are available. Required coverage, per the issue:

1. a **user-item condition failure is NOT reported as `VersionConflict`** (→ `AdditionalItemConditionFailed`)
2. a **duplicate `commandId` is rejected** with `DuplicateCommand`
3. a **version conflict is still mapped correctly when additional items are present**

plus: happy-path atomicity (events and watermark both visible), all-or-nothing rollback
(a failed additional item leaves no events), sentinel invisible to `read`, and the
idempotent-retry happy path.

---

## 9. Documentation

`packages/docs/src/content/docs/tutorials/event-sourcing.mdx` gains two steps, backed by
new regions in `packages/effect-dynamodb/examples/event-sourcing.ts` per the doctest
workflow:

- **Atomic side writes** — `additionalItems`, and the error table distinguishing
  `VersionConflict` from `AdditionalItemConditionFailed`.
- **Command idempotency** — the at-least-once default stated up front, then the
  `commandId` opt-in, the sentinel, TTL, and the reject-not-replay semantics.

---

## 10. Semver

`minor`. Everything is additive except one type-level change: `append`'s error channel
gains `DuplicateCommand | AdditionalItemConditionFailed | TransactionOverflow`
unconditionally, rather than conditionally on which options were passed.

Unconditional widening is the deliberate choice. Threading option-dependent error unions
through `EventStream`, `BoundEventStream`, `bind`, `commandHandler`'s four overloads, and
both handler aliases would multiply the type surface for a payoff only visible to callers
doing exhaustive matches. `Effect.catchTag` / `catchTags` users are unaffected; a caller
exhaustively matching on `append`'s error union sees a compile error and adds three
cases. That is noted in the changeset.
