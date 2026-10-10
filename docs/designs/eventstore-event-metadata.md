# Design: per-event metadata and timestamps on `EventStore.append` and `commandHandler`

**Issue:** [#144](https://github.com/jmenga/effect-dynamodb/issues/144)
**Status:** Designed → implemented in the same PR (single-PR workflow — this doc is commit 1).
**Affected packages:** `packages/effect-dynamodb` (EventStore, Entity, Transaction, Batch,
Aggregate, internal/TransactWriteOps, new internal/WriteDiagnosis), `packages/schema` (Errors:
an optional `cause` on three error classes), docs
**Semver impact:** `minor` (lockstep across the four publishable packages). Additive API surface — see §9.

---

## 1. Executive summary

`EventStream.append` takes one `metadata` value per append and writes a copy of it onto
every event item (`EventStore.ts` — encoded once before the event loop, assigned to every
item inside it). Metadata that belongs to the *event* rather than the *command* — a unique
event id used as a publish message id, the original occurrence time of an imported event,
an id carried over from a previous store — has nowhere to go except a list packed into
that single value, with each reader picking its own entry by position. Every item then
carries every entry of its append, so stored metadata grows with the square of the append
size, and a stream index (always `ProjectionType: "ALL"`) copies all of it.

`commandHandler` has the same limit plus a sequencing one: per-call `metadata` is fixed
before `decide` runs, so the caller cannot know how many events it must cover.

This design adds:

1. **`eventMetadata` on `append`** — one entry per event, same order. Item `i` stores
   entry `i`, encoded through the stream's `metadata` schema exactly as `metadata` is.
2. **`eventMetadata` on `commandHandler`** — a function of the `Decision` (the shape
   `additionalItems` already takes, #137), evaluated after `decide` on every attempt and
   passed to `append` as `eventMetadata`.

`metadata` and `eventMetadata` are mutually exclusive. A third option, `eventTimestamps`
(§7), sets each event's `timestamp`; on `commandHandler` it is a function of the `Decision`
that may return an `Effect`, as `eventMetadata` may. When none is given, behaviour is
unchanged. The read side is unchanged: `StreamEvent.metadata` already decodes each item's
own `metadata` attribute.

Large per-event metadata is how a caller meets DynamoDB's size limits, so the PR also sets
a **library-wide standard for write limits** (§6): the library no longer pre-checks limits
DynamoDB enforces itself. It sends the write; when DynamoDB rejects it, the library
recognises the rejection, confirms it by measuring the request it sent, and only then
rewrites it into a tagged error naming the culprit item, keeping DynamoDB's error as the
cause. Anything it cannot recognise or confirm passes through unchanged. The pre-existing
4 MB and 100-item pre-checks are converted to this pattern along with the 400 KB check this
PR first proposed.

```ts
// 1. append — one entry per event
yield* stream.append(streamId, [e1, e2, e3], expectedVersion, {
  eventMetadata: [m1, m2, m3],
})
// item v1: e1 + m1, item v2: e2 + m2, item v3: e3 + m3

// 2. commandHandler — derived after decide
yield* handle(streamId, command, {
  eventMetadata: ({ events }) => events.map(() => ({ eventId: ulid() })),
})
```

---

## 2. Shape of the `append` option

### 2.1 Options considered

| Option | Verdict |
|---|---|
| **A. New `eventMetadata: ReadonlyArray<M \| undefined>`**, exclusive with `metadata` | **Chosen.** Matches the issue; a positional array mirrors `events`, so the pairing is obvious at the call site and trivially validated by length. |
| **B. Let `metadata` also accept an array** | Rejected. Ambiguous whenever the metadata schema is itself an array (or a union containing one): the library cannot tell "one value that is a list" from "one value per event". |
| **C. Let `metadata` accept `(event, index) => M`** | Rejected. One option with two meanings, and it buys nothing over A — the caller can `events.map(...)` themselves. It would also be the only function-valued option on `append`, which is otherwise plain data. |
| **D. Allow both, shallow-merging `metadata` into each entry** | Rejected. Merging presumes `M` is a plain object; the schema may be anything, and merging through a transforming schema has no well-defined meaning (merge Type-side, then encode? encode both, then merge wire objects?). A caller who wants shared + per-event fields writes `events.map(() => ({ ...shared, eventId: ulid() }))`, which is explicit and type-checked. |

### 2.2 Entries may be `undefined`

`eventMetadata[i] === undefined` means event `i` is written **without** a `metadata`
attribute — exactly what an append without `metadata` writes today. The read type is
already `M | undefined` (`StreamMetadata<TMetadata>`), so this adds no new state, and it
lets an import carry an original id only on the events that have one.

### 2.3 Type-level exclusivity

`metadata` and `eventMetadata` become a two-branch union so passing both is a compile
error, with a runtime `ValidationError` behind it for untyped callers and `as` casts:

```ts
type AppendMetadataOptions<TMetadata> =
  | {
      /** Per-append metadata, written onto every event of the append. */
      readonly metadata?: TMetadata
      readonly eventMetadata?: never
    }
  | {
      readonly metadata?: never
      /** Per-event metadata: entry `i` is written onto event `i`. */
      readonly eventMetadata?: ReadonlyArray<TMetadata | undefined>
    }

export type AppendOptions<TMetadata, TState = never> =
  AppendOptionsBase<TState> & AppendMetadataOptions<TMetadata>
```

`AppendOptionsBase` carries the existing `additionalItems` / `idempotency` / `snapshot`
members unchanged. `AppendOptions` moves from `interface` to `type` alias (an interface
cannot extend a union); see §9.

On a stream without a metadata schema `TMetadata` is `undefined`, so `eventMetadata` is
`ReadonlyArray<undefined>` — as useless as `metadata?: undefined` is there today, and
consistent with it. Untyped metadata on a schema-less stream remains a raw-attribute
concern outside the typed API.

---

## 3. `append` semantics

### 3.1 Validation, and where it runs

Two new checks, both failing with `ValidationError` (`operation: "EventStore.append.eventMetadata"`)
and both before anything is read or written:

1. **Both given** — `metadata !== undefined && eventMetadata !== undefined`.
2. **Length mismatch** — `eventMetadata.length !== events.length`.

They run **first**, ahead of the existing zero-event fast path. Today an `append` with no
events and nothing else to write returns `{ version: expectedVersion, events: [] }` without
looking at its options; placed after that early return, `append(id, [], v, { eventMetadata: [m] })`
would succeed silently with a mismatched input. `append(id, [], v, { eventMetadata: [] })`
is consistent and keeps the fast path.

`undefined` is treated as absent for both options (the existing `!== undefined` convention),
so `{ metadata: undefined, eventMetadata: [...] }` is not "both given".

These are the caller's own invariants — DynamoDB never sees an `eventMetadata` array — so
they stay pre-checks under §6's standard.

### 3.2 Encoding

Each defined entry is encoded through `encodeToWire` (the same decode-then-encode fallback
`metadata` uses) with `operation: "EventStore.append.eventMetadata[<i>]"`, so an encode
failure names the offending event. Without a metadata schema, entries are written raw, as
`metadata` is. Entries are encoded inside the existing per-event `Effect.forEach`, next to
the event's own encode, so there is no second pass.

`metadata`'s encode path is unchanged: encoded once, shared by every item.

### 3.3 Item layout

Unchanged except that `item.metadata` is the event's own entry:

```
pk         $cricket#v1#match#m-1
sk         $cricket#v1#match.event#0000004
version    4
eventType  InningsCompleted
data       { ... }
metadata   { eventId: "01J..." }      ← entry 3 of eventMetadata (or absent)
timestamp  2026-10-10T…               ← still the append's `now`
```

### 3.4 Limits

Metadata adds no items and changes no limit; what changes is how a limit is reported (§6).

- **Item count** (`AppendTooLarge`) — the 100-item cap is no longer pre-checked; DynamoDB's
  rejection is confirmed by counting the request and reported as `AppendTooLarge`, with the
  same expanded `count` as before (§6.5).
- **4 MB per transaction** — no longer pre-checked; DynamoDB's rejection is attributed to
  the largest items and reported as `ValidationError` (§6.3). Each item carries its own
  entry, so this is where the quadratic growth stops costing capacity: N entries total
  instead of N².
- **400 KB per item** — diagnosed when DynamoDB rejects an item, naming the event (§6).

---

## 4. `commandHandler`

### 4.1 Option shape

```ts
export type EventMetadataInput<State, Event, TMetadata, E3 = never, R3 = never> = (
  decision: Decision<State, Event>,
) =>
  | ReadonlyArray<TMetadata | undefined>
  | Effect.Effect<ReadonlyArray<TMetadata | undefined>, E3, R3>
```

Function-only. A static array cannot be right before `decide` has chosen the event count,
and a static per-append value is what `metadata` already is.

The `Effect` form exists for the same reason `additionalItems` has one, plus one specific
to this feature: minting ids through Effect's `Clock` / `Random` keeps them deterministic
under `TestClock` / a seeded `Random`, which a `ulid()` call inside a plain function
cannot be.

`CommandOptions` gets the same exclusive pair as `append` (§2.3), with `eventMetadata`
typed as `EventMetadataInput`. Its own error/requirement parameters are **`E3` / `R3`**,
separate from `additionalItems`' `E2` / `R2`: if both functions fed one `E2`, TypeScript
would take the first candidate and reject the other whenever their error types differ,
rather than inferring a union. `eventTimestamps`' `Effect` form gets a third pair,
**`E4` / `R4`**, for the same reason — measured, not assumed (§7.3). The handler types grow
accordingly:

```ts
type CommandHandler<…> = <E2 = never, R2 = never, E3 = never, R3 = never, E4 = never, R4 = never>(
  streamId, command, ...options: CommandOptionsArgs<TMetadata, TConfig, State, TEvent, E2, R2, E3, R3, E4, R4>
) => Effect.Effect<
  CommandHandlerResult<State, TEvent>,
  CommandHandlerErrors<E> | E2 | E3 | E4,
  DynamoClient | TableConfig | R2 | R3 | R4
>
```

`BoundCommandHandler` mirrors it with `R2 | R3 | R4`. `IdempotentCommandOptions` becomes
`CommandOptions & { readonly commandId: string }`.

**Inference risk.** Moving `CommandOptions` to an intersection-with-union could degrade
inference of `E2`/`R2`/`E3`/`R3`/`E4`/`R4` from the call's options object.
`EventStore.types.test.ts` pins it (§8.3). If inference cannot be made to hold, the
fallback is a plain interface with both members optional and runtime-only exclusivity,
documented as such — the runtime check exists either way.

### 4.2 When it runs

Inside `commit`, step 6, next to `additionalItems`:

- after `decide`, after the new events are folded — it receives the same `Decision`
  (`events`, `state`, `previous`, `version`) `additionalItems` does;
- **not** called for a no-op decision (no events, no append);
- evaluated **before** `eventTimestamps` and `additionalItems` (it concerns the events,
  which precede the additional items in the transaction; the order is documented so an
  effectful set is predictable);
- re-run on every attempt: each `VersionConflict` retry, and the re-decision a stale
  unverified snapshot triggers under `verifySnapshot: false`, where `decide` already runs
  twice in one attempt.

A length mismatch is checked by the handler itself before calling `append`, failing with
`ValidationError` (`operation: "EventStore.commandHandler.eventMetadata"`) so the error
names the option the caller wrote, not `append`'s. `ValidationError` is not retried.

Per-call `metadata` keeps its current behaviour (copied onto every event).

### 4.3 Minted ids and redelivery

Ids minted per attempt are safe: a failed attempt writes nothing, so only the committed
attempt's ids ever exist. With `idempotency`, a redelivered command fails with
`DuplicateCommand` and never mints a second committed set.

Without `idempotency`, a redelivery after a lost response re-decides and appends again —
the documented at-least-once default — and random ids differ between the two commits.
The docs show the deterministic alternative for callers who need stable ids across
redeliveries:

```ts
// `commandId` is the caller's delivery id, in scope at the call site
eventMetadata: ({ events, version }) =>
  events.map((_, i) => ({ eventId: `${commandId}:${version + i + 1}` }))
```

---

## 5. Read side

No change. `decodeEvent` already decodes `raw.metadata` per item through the metadata
schema, so `read`, `readFrom`, `readLatest`, stream-index queries and `StreamEvent.metadata`
return each event's own entry. A unit test pins this (§8.1) so the property does not
silently regress.

---

## 6. Write limits: diagnosed at failure time, not pre-checked

*Revised after the first review of #145. The first version proposed a client-side 400 KB
per-item check beside the existing 4 MB one. The user's decision is the opposite, and a
standard for the whole library: no pre-checks of limits DynamoDB enforces itself.*

### 6.1 Rationale

- **DynamoDB enforces every one of these limits.** An oversized item, an over-long sort
  key, a 101-item or 4 MB transaction never commits; the request is rejected whole. A
  pre-check adds no safety.
- **A pre-check costs every write.** Sizing each item of every transaction (and, to be
  complete, every single-item write) is work on the success path, which is nearly every
  path. The size of a passing write is never needed.
- **What a pre-check adds is attribution**, and attribution is only needed when the write
  fails. DynamoDB's own message names neither the item nor, for a transaction, which of its
  items is at fault. The library knows both — it built the request.
- **Pre-checks drift.** They mirror DynamoDB's rules approximately (item size is documented
  as approximate; the library's lower bound already undercounts on purpose), so a pre-check
  is either occasionally wrong or deliberately weaker than DynamoDB. A diagnosis made after
  DynamoDB has ruled cannot refuse a write DynamoDB would accept.

### 6.2 The rule

Every write site wraps its DynamoDB call so that, **on failure only**:

1. **Recognise.** Match the error against the shapes in §6.3, on stable message fragments
   and codes (never the full text): a request-wide `ValidationException` (surfaced as
   `DynamoValidationError`), or a `TransactionCanceledException` whose positional reason
   carries `Code: "ValidationError"` and a recognised message.
2. **Confirm.** Measure the request the site sent, with `internal/ItemSize.ts`:
   - *Exact measures* — item count, a key's UTF-8 bytes. Confirmed only when the
     measurement is over the limit. Otherwise the error passes through.
   - *Approximate measures* — item size, transaction payload. DynamoDB sizes items by rules
     it documents as approximate, and an `UpdateItem`'s resulting item is not in the
     request at all, so a measurement cannot veto DynamoDB. Here the recognised message is
     specific to the limit and is itself the evidence; confirmation checks that the request
     holds something the message can apply to (a `Put`/`Update` for an item-size message,
     a transaction for the 4 MB message) and the measurement is used to **attribute**.
3. **Attribute.** Name the culprit: the entity (or stream) and key of the item, or for
   `EventStore` the event (`the event at version 4`), the inline snapshot, the idempotency
   sentinel or the additional item (`operation 2 (User)`), using the `TransactItemTarget`s
   the transaction builders already produce. When sizes cannot single one out (no `Put`
   measures over 400 KB by the lower bound), name the largest and say it is the *likely*
   culprit and why.
4. **Rewrite, or pass through.** A confirmed diagnosis becomes the site's tagged error
   (§6.5), with DynamoDB's error — the `DynamoClientError` the call would otherwise have
   failed with — kept as its cause. Anything unrecognised or unconfirmed fails exactly as it
   does today.

**Zero cost on success.** Nothing is measured, and no target is computed, until DynamoDB has
rejected the request. Sites that already build targets for their own invariants
(`refuseRepeatedItems`) reuse them; the others build them in the failure branch.

**Ordering with existing failure handling.** The diagnosis is the last step before
pass-through, never the first. Conditional-failure mapping (`DuplicateCommand`,
`VersionConflict`, `AdditionalItemConditionFailed`, guarded-put verdicts and retries,
`ConditionalCheckFailed`) runs first and is unchanged; `sendAppendTransaction` still treats
only `ConditionalCheckFailed` reasons as conflicts. Only a cancellation those mappings
cannot explain — today a `TransactionCancelled` — is offered to the diagnosis. A diagnosed
error is terminal: guarded-write retry loops do not retry it.

### 6.3 DynamoDB error shapes

Observed on DynamoDB Local on 2026-10-10; AWS wording may differ (§6.8). "Fragment" is what
the recogniser matches.

| # | Request | DynamoDB's response | Fragment recognised | Confirm by | Attribute to |
|---|---|---|---|---|---|
| 1 | `PutItem`, item over 400 KB | `ValidationException` "Item size has exceeded the maximum allowed size" | `Item size has exceeded the maximum allowed size` | the request is a `PutItem` (approximate; the message is the evidence) | the one item: entity + key, with its lower-bound size |
| 2 | `UpdateItem` growing the item past 400 KB | `ValidationException` "Item size to update has exceeded the maximum allowed size" | `Item size to update has exceeded` | the request is an `UpdateItem` (the resulting item is not in the request) | the one item: entity + key |
| 3 | `TransactWriteItems` holding an oversized `Put` | request-wide `ValidationException` "Item size has exceeded the maximum allowed size" — no index | as #1 | size every `Put` (lower bound) | the `Put` over 409,600 bytes; if none, the largest `Put`, named as the likely culprit because DynamoDB's sizes are approximate |
| 4 | `TransactWriteItems` whose `Update` grows an item too large | `TransactionCanceledException`, `CancellationReasons[i] = { Code: "ValidationError", Message: "Item size to update has exceeded the maximum allowed size" }` | reason code `ValidationError` + #2's fragment | index `i` is in the request and is an `Update` | target `i` (via provenance for multi-item ops) |
| 5 | `BatchWriteItem` holding an oversized item | request-wide `ValidationException` "Item size has exceeded the maximum allowed size" | as #1 | size every `PutRequest` | as #3 |
| 6 | `TransactWriteItems` with 101+ items | `ValidationException` "… Member must have length less than or equal to 100" | `length less than or equal to 100` | count `TransactItems` > 100 (exact) | the count, and what expanded it (sentinels, snapshots, contiguity check) |
| 7 | `TransactWriteItems` over 4 MB | `ValidationException` "Transaction payload size cannot exceed 4MB. Payload Size: N" | `payload size cannot exceed 4MB` (+ parse `N` when present) | sum the items (lower bound); DynamoDB's `N` is reported alongside | the largest contributors (top three), noting a `retain` put counts twice |
| 8 | A sort key over 1024 bytes (table or index range key) | Local: `ValidationException` "One or more parameter values were invalid: Size limit exceeded". AWS documents: "One or more parameter values were invalid: Aggregated size of all range keys has exceeded the size limit of 1024 bytes" | either `Size limit exceeded` or `Aggregated size of all range keys`, request-wide or as a `ValidationError` cancellation reason | UTF-8 bytes of the range-key attributes the site wrote (summed per key schema) > 1024 — exact; Local's message is generic, so this confirmation is what makes a rewrite safe | the item and the attribute (for `EventStore`, the index name and event version, as today's pre-check reported) |
| 9 | `TransactGetItems` with 101+ keys | as #6 | as #6 | count `TransactItems` > 100 | the count |

Each site supplies the range-key attribute names for #8 from what it already knows: an
entity's primary and index sort-key fields; for `Aggregate`, `sk`, the collection index's SK
and the list index's SK (root items); for `EventStore`, `sk` plus the stream-index
attributes plus the additional items' entities' sort-key fields. An `EventStore` sort-key
diagnosis is reported against the stream index (`operation: "EventStore.append.indexes"`)
only when the culprit is one of the append's event puts; an additional item writing the
same physical attribute (`gsi1sk` shared across entities in a single-table design) is named
as that item.

### 6.4 One module: `internal/WriteDiagnosis.ts`

All recognising, confirming and attributing lives in one internal module, used by every
site; sites only map its verdict to their own error class.

```ts
/**
 * What a site sent, as the diagnosis needs it. A single-item write is given in
 * its transact-entry form (`{ Put }`, `{ Update }`, `{ Delete }`); a batch as
 * its requests flattened to the same form (`batchEntries`).
 */
export type SentWrite =
  | { readonly _tag: "Item"; readonly item: TransactWriteItem; readonly target: () => TransactItemTarget }
  | { readonly _tag: "Transaction"; readonly items: ReadonlyArray<TransactWriteItem>; readonly targets: () => ReadonlyArray<TransactItemTarget> }
  | { readonly _tag: "Batch"; readonly items: ReadonlyArray<TransactWriteItem>; readonly targets: () => ReadonlyArray<TransactItemTarget> }
  | { readonly _tag: "TransactGet"; readonly count: number }

export type Diagnosis =
  | { readonly _tag: "ItemTooLarge"; readonly target: TransactItemTarget; readonly bytes: number | undefined; readonly likely: boolean }
  | { readonly _tag: "TooManyItems"; readonly count: number; readonly limit: number }
  | { readonly _tag: "TransactionTooLarge"; readonly reported: number | undefined; readonly measured: number; readonly largest: ReadonlyArray<{ readonly target: TransactItemTarget; readonly bytes: number }> }
  | { readonly _tag: "SortKeyTooLong"; readonly target: TransactItemTarget; readonly attribute: string; readonly bytes: number }

/**
 * The entry point every site uses: wraps the site's write so that, on failure
 * only, a diagnosable error is read against what was sent and — when
 * confirmed — rewritten by `rewrite`. Placed after the site's conditional
 * mapping; success and everything unconfirmed pass through untouched.
 */
export const diagnoseFailure: <E2>(options: {
  readonly sent: () => SentWrite
  readonly rangeKeys: () => ReadonlyArray<string>
  readonly rewrite: (diagnosis: Diagnosis, original: unknown) => E2
}) => <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A, E | E2, R>

/**
 * The reading `diagnoseFailure` performs. Takes the site's error as `unknown`:
 * it reads a `DynamoError` / `DynamoValidationError` carrying a
 * `ValidationException` or `TransactionCanceledException`, or a
 * `TransactionCancelled`, and returns `undefined` for anything else.
 */
export const diagnoseWriteFailure: (
  error: unknown,
  sent: SentWrite,
  rangeKeys: ReadonlyArray<string>,
) => Diagnosis | undefined

/** The explanation every site puts in its error, so wording is identical library-wide. */
export const explainDiagnosis: (
  diagnosis: Diagnosis,
  operation: string,
  options?: { readonly partial?: boolean | undefined },
) => string

/** The `ValidationError` most sites rewrite to: `explainDiagnosis` text, DynamoDB's error as its cause. */
export const diagnosedValidationError: (
  diagnosis: Diagnosis,
  original: unknown,
  options: { readonly operation: string; readonly entityType: string; readonly partial?: boolean | undefined },
) => ValidationError

/** An `Error` carrying `message`, with DynamoDB's error one step down as its own `cause`. */
export const withCause: (message: string, original: unknown) => Error
```

Targets are thunks so a site that does not already hold them builds them only on failure.
`refuseOversizedTransaction` is deleted; `ITEM_MAX_BYTES`, `TRANSACT_WRITE_MAX_BYTES` and
`transactItemBytes` move to serving the diagnosis (and `Batch.write`'s chunking, unchanged).

**Carrying the cause.** `ValidationError.cause` is today a message string. A diagnosed
`ValidationError` sets `cause` to an `Error` whose message is `explainDiagnosis(...)` and
whose own `cause` is DynamoDB's error (ES2022 cause chaining), so the readable text stays
where callers look for it and the original is one step down. `DynamoError` does the same.
`AppendTooLarge`, `TransactionOverflow` and `AggregateTransactionOverflow` have no `cause`
field: each gains an optional `cause?: unknown` (additive — §9) set to DynamoDB's error.
`CascadePartialFailure` carries it in its existing `errors`.

### 6.5 Per-site coverage

Every write site gets the diagnosis, except `Aggregate` delete (below). No public operation's error union widens: each
diagnosed error below is already in the union of the operation that can produce it.
(Internal helper unions such as `Aggregate`'s `WriteGroupsError` and the cascade helper's
gain `ValidationError`; the public unions above them already include it.)

| Site | Requests | Shapes | Diagnosed error |
|---|---|---|---|
| `Entity` single-item writes — `put` / `create` / `upsert` / `update` / `patch` / `delete` / `deleteIfExists` and lifecycle single-item writes | `PutItem`, `UpdateItem`, `DeleteItem` | 1, 2, 8 | `ValidationError` |
| `Entity` transactional writes — guarded put, retain/unique update, retain/soft delete, `restore` | `TransactWriteItems` | 3, 4, 6, 7, 8 | count → `TransactionOverflow`; others → `ValidationError` |
| `Entity` transactional cascade | `TransactWriteItems` of `Update`s | 4, 6, 7, 8 | `CascadePartialFailure` (`succeeded: 0`, DynamoDB's error in `errors`) |
| `Entity` eventual cascade | `UpdateItem` each | 2 | the diagnosed `ValidationError` lands in `CascadePartialFailure.errors`, as any per-item failure does |
| `Entity.purge` | `BatchWriteItem` / `DeleteItem` of stored keys | — (deletes of keys that were stored cannot hit these limits) | wrapped for uniformity; passes through in practice |
| `Transaction.transactWrite` | `TransactWriteItems` | 3, 6, 7, 8 | count → `DynamoError` (today's tag and message); others → `ValidationError` |
| `Transaction.transactGet` | `TransactGetItems` | 9 | `DynamoError` (today's tag and message) |
| `Batch.write` — versioned puts as transactions | `TransactWriteItems` | 3, 7, 8 | `ValidationError` |
| `Batch.write` — plain requests | `BatchWriteItem` | 5, 8 | `ValidationError`; the message says earlier chunks may already be written (`Batch.write` was never atomic) |
| `Aggregate` create / update | `TransactWriteItems` per group | 3, 6, 7, 8 | count → `AggregateTransactionOverflow`; others → `ValidationError` |
| `Aggregate` delete | `BatchWriteItem` of stored keys | — | **not wrapped**: deletes of keys that were stored cannot meet these limits, and `delete`'s error union has no `ValidationError` to carry a diagnosis (§11) |
| `EventStore.append` / `commandHandler` | `TransactWriteItems` (`sendAppendTransaction`) | 3, 4, 6, 7, 8 | count → `AppendTooLarge` (same expanded `count`); size → `ValidationError` naming the event / snapshot / sentinel / additional item; sort key → `ValidationError` (`operation: "EventStore.append.indexes"`) |
| `EventStore.writeSnapshot` | `PutItem` | 1 | `ValidationError` naming the snapshot |

### 6.6 Converted pre-checks

| Pre-check | Where | Was | Now |
|---|---|---|---|
| 400 KB per item | `refuseOversizedTransaction` (`internal/TransactWriteOps.ts`) — added by this PR | `ValidationError` before send, for `append` and `transactWrite` | removed; shapes 3/4, all sites |
| 4 MB per transaction | `refuseOversizedTransaction` — pre-existing (#133) | `ValidationError` before send | removed; shape 7 |
| 100 items, `transactWrite` | `Transaction.ts` (expanded count) | `DynamoError` before send | removed; shape 6, same tag and message |
| 100 items, `transactGet` | `Transaction.ts` | `DynamoError` before send | removed; shape 9, same tag and message |
| 100 items, entity transactions | `Entity.ts` `checkTransactionLimit` (guarded put, update, delete ×2, restore) | `TransactionOverflow` before send | removed; shape 6 |
| 100 items, transactional cascade | `Entity.ts` cascade | `CascadePartialFailure` before send | removed; shape 6 |
| 100 items, append (lower bound before compiling, and expanded count after) | `EventStore.ts` — both `AppendTooLarge` checks | `AppendTooLarge` before send | removed; shape 6, public `AppendTooLarge` kept |
| 1024-byte stream-index sort key | `EventStore.ts` `MAX_INDEX_SORT_KEY_BYTES` in the append path | `ValidationError` before send | removed; shape 8 — the non-empty-string check on the same `key` result stays (§6.7) |
| 100 items per aggregate group | `Aggregate.ts` `writeTransactionGroups` | `AggregateTransactionOverflow` before **any** group is written | **kept — open, needs your call** (§6.8) |

### 6.7 What stays a pre-check, and why

The standard covers limits DynamoDB enforces itself. These are not that, and stay:

- **The caller's own invariants**, which DynamoDB cannot see: `metadata` + `eventMetadata`
  both given, `eventMetadata` / `eventTimestamps` lengths and entry types, non-function
  handler options, `expectedVersion` shape, the stream-index `key` result being a non-empty
  string (an index key the caller's function got wrong, not a size).
- **Checks that prevent a misdiagnosis.** `refuseRepeatedItems`: DynamoDB rejects a
  transaction touching one item twice, but the reasons it reports for a guarded put can
  read as a lost race, which would drive retries and end as `OptimisticLockError`.
- **Malformed-request validation** with a different meaning if sent: an empty `or()` /
  `isIn()` / `Transaction.check({})`, empty condition parts (#133, #134).
- **Definition-time limits** — `Table.definition`'s vector-index limits.
- **Batch chunking** — the 25 / 100 / 3.5 MB budgets split a batch; they refuse nothing.
- **Strategy choices** that measure a limit to choose a path rather than refuse (`Entity`'s
  wide-update split on `expressionFits`).
- **`readIndex`'s bound validation** (non-empty `beginsWith`, a `between` pair in UTF-8
  order) — left as is. It mirrors DynamoDB's request validation of a read, not a size
  limit; whether the standard reaches it is listed in §11.

### 6.8 Behaviour changes and risks

- **AWS wording may differ from DynamoDB Local.** The shapes in §6.3 were observed on
  Local; AWS's documented sort-key message already differs. Mitigated three ways: matching
  on short stable fragments (and both known sort-key wordings), confirmation by measurement
  — exact where the measure is exact, so a misread message is never rewritten into a wrong
  error — and pass-through, so a missed shape degrades to today's `DynamoValidationError`,
  never to a wrong diagnosis. Connected tests pin Local's wording (§8.2); a mismatch on AWS
  shows up as a pass-through, and is fixed by adding a fragment.
- **A rejected write now costs a round trip** where the pre-check refused it locally.
  A request-wide `ValidationException` is rejected before any item is processed; a
  cancelled transaction (shape 4) may still consume capacity, as any cancellation does. For an append
  whose additional items include guarded puts, their reads now happen before the count is
  known (the lower-bound check skipped them).
- **Same tags, later.** A confirmed diagnosis produces the error the pre-check did
  (`AppendTooLarge`, `TransactionOverflow`, `ValidationError`, `DynamoError`), and "Nothing
  was written" stays true — DynamoDB rejects these requests whole. Only an unrecognised
  shape changes what a caller sees: `DynamoValidationError` instead of the named error.
- **Aggregate groups (not converted — open).** `Aggregate` writes a large aggregate as
  several transactions, one per group, and checks every group's count *before writing the
  first*. That up-front loop exists to stop earlier groups committing when a later one is
  too large — a cross-transaction guarantee DynamoDB cannot see, since it judges one group
  at a time. Converting it would let a create or update commit some groups and then fail.
  This design keeps it (it is our invariant, not a mirror) and gives each group the
  diagnosis for the size and key shapes. The listed scope named it for conversion, so this
  is flagged for a decision.
- **Batch is not atomic.** A rejected `BatchWriteItem` chunk fails the batch after earlier
  chunks have been written — as any failure there does today. The diagnosis says so rather
  than "Nothing was written".

---

## 7. Per-event timestamps

*Added after the first review of #145. The first version of this design left the override
out, on the grounds that it would change what `timestamp` means. That reason does not hold:
the library writes `timestamp` from `DateTime.now` and returns it on `StreamEvent`, and
nothing in it reads the value for ordering, snapshots or expiry. Importers already override
it by pinning the `Clock` per chunk, which stamps every event in a chunk with one time.*

### 7.1 `append`

```ts
yield* stream.append(streamId, [e1, e2, e3], expectedVersion, {
  eventMetadata: [m1, m2, m3],
  eventTimestamps: [t1, undefined, t3], // DateTime; undefined → the append's `now`
})
```

- `eventTimestamps?: ReadonlyArray<DateTime.DateTime | undefined>`, one entry per event, in
  order. Entry `i` is written as event `i`'s `timestamp`, formatted with
  `DateTime.formatIso` (the format `now` is written in, so readers see one format). An
  `undefined` entry keeps the append's `now`.
- Plain data, like every other `append` option; the `Effect` form is the handler's (§7.2).
- Independent of `metadata` / `eventMetadata`: any combination is allowed.
- Checked with the metadata checks, before the zero-event fast path: a length that differs
  from `events.length`, or an entry that is neither a valid `DateTime` (finite epoch) nor
  `undefined`, fails with
  `ValidationError` (`operation: "EventStore.append.eventTimestamps"`) before anything is
  written.
- Only the event items change. The idempotency sentinel, its TTL and the inline snapshot
  keep `now`: they record when the append was written.
- No ordering constraint. `version` orders a stream; timestamps may repeat, run backwards or
  lie in the future, as imported history can.

### 7.2 `commandHandler`

```ts
// plain: the times are in the events
yield* handle(streamId, command, {
  eventTimestamps: ({ events }) => events.map((event) => event.occurredAt),
})

// Effect: the times come from a service (here, the import's source log)
yield* handle(streamId, command, {
  eventTimestamps: ({ events }) =>
    Effect.forEach(events, (event) => SourceLog.originalTime(event.sourceId)),
})
```

```ts
export type EventTimestampsInput<State, Event, E4 = never, R4 = never> = (
  decision: Decision<State, Event>,
) =>
  | ReadonlyArray<DateTime.DateTime | undefined>
  | Effect.Effect<ReadonlyArray<DateTime.DateTime | undefined>, E4, R4>
```

- **Shape.** A function of the `Decision` returning the array directly or as an `Effect`,
  exactly as `eventMetadata` (§4.1). Function-only, for the same reason: the event count is
  known only after `decide`. The first version allowed only the plain return, arguing that
  the `Clock` is already the effectful default; the user's decision is to mirror
  `eventMetadata`, because times can come from a service (a source log, a per-tenant clock)
  and computing them through `Clock` keeps them deterministic under `TestClock`.
- **Generics: a separate `E4` / `R4` pair** (§7.3). The effect's `E4` joins the handler's
  error channel and its `R4` the handler's requirements.
- **Ordering in commit step 6.** `eventMetadata` → `eventTimestamps` → `additionalItems`,
  each run to completion before the next (sequential, never concurrent); a failure in one
  means the later ones are not run. All three receive the same `Decision`.
- **Retry behaviour.** Not called on a no-op. Re-run on every attempt — each
  `VersionConflict` retry and the unverified-snapshot re-decision — as `eventMetadata` is.
- **Failure mapping.**
  - The returned `Effect` failing with `E4` surfaces as is, and is not retried (as
    `eventMetadata`'s `E3`).
  - The result — plain or produced by the `Effect` — is validated identically: a wrong
    length, a non-array, or an entry that is neither a valid `DateTime` nor `undefined`
    fails with `ValidationError` (`operation: "EventStore.commandHandler.eventTimestamps"`),
    not retried.
  - A non-function value is refused before anything is read, unchanged.
- The values reach `append` as plain `eventTimestamps`; §7.1's rules then apply (sentinel,
  TTL and inline snapshot keep the append's `now`; no ordering check).

### 7.3 Types

`append`'s `eventTimestamps` lives on `AppendOptionsBase`, outside the exclusive metadata
union; no new type parameters there.

The handler's `eventTimestamps` lives on `CommandOptionsBase`, typed
`EventTimestampsInput<State, Event, E4, R4>`, so `CommandOptionsBase` gains `E4` / `R4`
(trailing, defaulted to `never`) and `CommandHandler` / `BoundCommandHandler` gain them as
in §4.1.

**Why not share `E3` / `R3` with `eventMetadata`.** Probed before deciding, with the
handler's option shape reproduced against `effect@4.0.0` and TypeScript 6.0.3:

- *Shared `E3` / `R3`*: works when only one of the two returns an `Effect`, or when both
  fail with the same type — but an `eventMetadata` effect failing with `MetaErr` beside an
  `eventTimestamps` effect failing with `TsErr` does not compile (`TS2322: Type
  'Effect<MD, MetaErr, MetaSvc>' is not assignable to type 'MD | Effect<MD, TsErr, TsSvc>'`).
  TypeScript fixes `E3` from one candidate and rejects the other instead of inferring a
  union — the same failure §4.1 records for `E2` / `E3`.
- *Separate `E4` / `R4`*: infers `MetaErr | TsErr` and `MetaSvc | TsSvc` for that call, and
  the single-effect and plain-function combinations infer correctly too.

So the handler carries three independent pairs. The type tests (§8.3) pin the
differing-error case, which is the one sharing would break.

### 7.4 Out of scope

- **Returning metadata or timestamps from `append` / the handler.** `AppendResult.events`
  and `CommandHandlerResult.events` stay domain events; the caller already holds what it
  passed.
- **An `Effect` form on `append`'s `eventTimestamps`.** `append` takes plain data; a caller
  with an effect runs it first.

---

## 8. Testing

### 8.1 Unit (`test/EventStore.test.ts`, plus the sites' own test files for §6)

- `eventMetadata` writes entry `i` onto item `i` (typed stream; inspect the transact items)
- `undefined` entries write no `metadata` attribute
- transforming metadata schema: each entry encoded to wire form; round-trips append → read
  decoded, per event
- encode failure → `ValidationError` with `operation: "EventStore.append.eventMetadata[<i>]"`
- length mismatch → `ValidationError`, no AWS call
- both `metadata` and `eventMetadata` → `ValidationError`, no AWS call
- zero events + `eventMetadata: [m]` → `ValidationError` (fast path does not swallow it)
- zero events + `eventMetadata: []` → fast-path no-op, no AWS call
- `eventMetadata` alongside `additionalItems`, `idempotency`, inline `snapshot`: layout and
  cancellation-index mapping unchanged
- `metadata` behaviour unchanged (existing tests stay green)
- `commandHandler`: plain and `Effect` forms; receives the `Decision`; not called on a
  no-op; re-run on a `VersionConflict` retry (mints again — assert by counter); re-run on
  the unverified-snapshot re-decision; length mismatch → `ValidationError` named for the
  handler; an `E3` failure surfaces and is not retried
- §7 `append`: entry `i` written as item `i`'s `timestamp` (ISO, UTC); `undefined` keeps
  `now`; a zoned `DateTime` is stored as its UTC instant; length mismatch and a non-`DateTime`
  entry → `ValidationError`, no AWS call, also on a zero-event append; combined with
  `eventMetadata`; sentinel and inline snapshot keep `now`; out-of-order timestamps accepted
- §7 `commandHandler`, both forms: receives the `Decision`; order `eventMetadata` →
  `eventTimestamps` → `additionalItems` (recorded by effectful counters); not called on a
  no-op; re-run on retry and on the re-decision; a bad result → `ValidationError` named for
  the handler, not retried, for the plain and the `Effect` form alike; an `E4` failure
  surfaces as is, is not retried, and `additionalItems` is not run; non-function refused
  before read
- §6, `test/WriteDiagnosis.test.ts` (new module, new test file), driven by synthetic
  errors in each §6.3 shape:
  - each shape recognised, confirmed and attributed (key, source, `likely` flag, largest
    contributors, parsed `Payload Size`)
  - both sort-key wordings recognised; a sort-key message with no key over 1024 bytes →
    `undefined` (pass through)
  - a count message on a request of ≤ 100 items → `undefined`
  - an unrelated `ValidationException`, a throttle, a `ConditionalCheckFailed` → `undefined`
  - targets thunk not called on the success path (spy)
- §6, per site (mock `DynamoClient` failing with the shape): `append` → `AppendTooLarge`
  with the expanded `count` and DynamoDB's error as `cause`, and `ValidationError` naming
  the event / sentinel / snapshot / additional item; `sendAppendTransaction` precedence
  unchanged (a `ConditionalCheckFailed` beside a `ValidationError` reason still reports the
  conflict); `transactWrite` / `transactGet` → `DynamoError` with today's message;
  `Entity` put / update / delete / restore → `ValidationError` / `TransactionOverflow`;
  cascade → `CascadePartialFailure`; `Batch.write` → `ValidationError` naming the item;
  `Aggregate` → `ValidationError`; `writeSnapshot` → `ValidationError`; an unrecognised
  error passes through unchanged at every site
- Existing tests that assert the converted pre-checks fire **with no AWS call** (#113 /
  #133 4 MB and 100-item tests, the stream-index 1024-byte test, the 400 KB tests this PR
  added) are rewritten to mock DynamoDB's rejection and assert the diagnosed error. The
  aggregate up-front group check keeps its no-AWS-call test while it stays (§6.8).

### 8.2 Connected (`test/connected.test.ts`, mandatory per CLAUDE.md)

- append three events with three different entries; `read` returns each event's own entry
- a stream index read returns per-event entries
- `commandHandler` with a function-form `eventMetadata` against DynamoDB Local, read back
- an append whose shared-list equivalent would exceed 4 MB succeeds with `eventMetadata`
  (the motivating size scenario, end to end)
- §7: an imported append with `eventTimestamps` reads back each event's own `timestamp`;
  the same through `commandHandler`, in both the plain and the `Effect` form
- §6, one real rejection per shape, against DynamoDB Local (these pin Local's wording):
  - `Entity.put` of an item over 400 KB → `ValidationError` naming entity and key (#1)
  - `Entity.update` growing an item past 400 KB → `ValidationError` (#2)
  - `transactWrite` with one oversized `Put` → `ValidationError` naming that op (#3)
  - an entity transaction whose `Update` grows too large → `ValidationError` by index (#4)
  - `Batch.write` with an oversized item → `ValidationError` naming the item (#5)
  - a 101-item append → `AppendTooLarge` (`count: 101`), nothing written (#6)
  - an append over 4 MB → `ValidationError` naming the largest events (#7)
  - a stream-index `key` over 1024 bytes → `ValidationError` naming index and version (#8)
  - after each, the stream / table is unchanged

### 8.3 Types (`test/EventStore.types.test.ts`)

- passing both `metadata` and `eventMetadata` is a type error, on `append` and the handler
- `eventMetadata` entries are typed `M | undefined` against the stream's schema type
- `E3` / `R3` inferred from an `Effect`-returning `eventMetadata`, alongside an
  `additionalItems` with a *different* error type (`E2`) — both appear in the handler's
  error channel
- idempotent handler still requires `commandId` with `eventMetadata` present
- §7: `eventTimestamps` entries typed `DateTime.DateTime | undefined`; accepted alongside
  either metadata option; the handler's function may return the array or an `Effect` of it
- §7.3: an `Effect`-returning `eventTimestamps` (`TsErr`, requiring `TsSvc`) beside an
  `Effect`-returning `eventMetadata` (`MetaErr`, `MetaSvc`) and an `additionalItems` effect
  (`ItemsErr`) compiles, and the handler's error channel includes `MetaErr | TsErr |
  ItemsErr` and its requirements `MetaSvc | TsSvc` — the case shared parameters break
- §7.3: `eventTimestamps` alone as an `Effect` infers `E4` / `R4`; as a plain function adds
  nothing to either channel
- an `Effect` of the wrong element type (`Effect<ReadonlyArray<string>>`) is a type error

---

## 9. Semver and compatibility

`minor`. Additive at runtime for every option combination that works today; error reporting
for rejected writes changes as §6.8 describes.

Type-level notes for the changeset:

- `AppendOptions`, `CommandOptions` and `IdempotentCommandOptions` move from `interface` to
  `type` alias. Usage as a type is unchanged; an `interface X extends AppendOptions<…>` in
  user code would stop compiling (an interface cannot extend a union). Unlikely, and called
  out.
- `CommandHandler` / `BoundCommandHandler` gain four defaulted type parameters (`E3`, `R3`
  for `eventMetadata`, `E4`, `R4` for `eventTimestamps`); `CommandOptionsBase` gains
  `E4`, `R4`. Call sites infer them; hand-written instantiations with positional arguments
  keep working because the new parameters are trailing and defaulted.
- `AppendTooLarge`, `TransactionOverflow` and `AggregateTransactionOverflow` gain an
  optional `cause` (in `@effect-dynamodb/schema`). Constructing them without it still
  compiles.
- No public error union widens.

Behavioural notes for the changeset (§6):

- Limits DynamoDB enforces are no longer pre-checked; a write over one is sent, rejected by
  DynamoDB, and reported with the same error as before when the rejection is recognised
  and confirmed — now naming the item, with DynamoDB's error as its `cause`.
- Newly diagnosed: oversized items on single-item writes, `Batch.write` and entity /
  aggregate transactions, and over-long sort keys — previously a bare
  `DynamoValidationError`.
- An unrecognised rejection (for example, wording on AWS this release does not know) is the
  bare `DynamoValidationError` it always was, rather than the named error a pre-check gave.

Version: next minor after whatever lands first — `1.25.0` if this merges before #129,
otherwise `1.26.0`.

---

## 10. Documentation

- **Tutorial** (`tutorials/event-sourcing.mdx`): the tutorial never covers metadata today.
  New **Step 20: Event Metadata**, backed by new regions in `examples/event-sourcing.ts` on a
  new `AuditedMatchEvents` stream with a metadata schema:
  - `metadata-stream` — declaring a metadata schema;
  - `append-metadata` — per-append `metadata` (shared by every event);
  - `event-metadata` — per-event `eventMetadata` on `append`, read back per event;
  - `handler-event-metadata` — `commandHandler` minting an id per event, plus the
    deterministic-id note from §4.3.
  The step ends with a short "why not pack a list into `metadata`" note (the N² cost).
  A further region, `event-timestamps`, shows an import carrying each event's original
  time with `eventTimestamps` (§7), in place of pinning the clock per chunk; a sibling
  region, `handler-event-timestamps-effect`, shows the handler's `Effect` form.
- **Tutorial limits text** (`tutorials/event-sourcing.mdx`): the "100 items per
  transaction" and "4 MB … 400 KB" bullets, the `additionalItems` limits paragraph, the
  stepped-commands section and the stream-index `key` bullet say the append "fails upfront
  … before any request is issued" / "before anything is sent". They change to: DynamoDB
  rejects it, nothing is written, and the error names the culprit. The `AppendTooLarge`
  example output (`count 152, limit 100`) is unchanged.
- **Guides**: `guides/data-integrity.mdx` (transaction 4 MB / 400 KB sentence),
  `tutorials/batch.mdx` (unchanged chunking; add that an oversized item is named), and
  `guides/aggregates.mdx` (`AggregateTransactionOverflow` — unchanged while §6.8's open
  item stands).
- **API reference** (`reference/api-reference.mdx`): the `append` row and the
  `commandHandler` per-call options gain `eventMetadata` and the handler's
  `eventTimestamps` `Effect` form; mutual exclusivity stated. The "4 MB and 400 KB, counted
  before sending" section becomes "Write limits", describing §6.2's rule and the error per
  limit. The `ValidationError`, `TransactionOverflow` and `AppendTooLarge` rows drop
  "before sending" and mention the `cause`.
- **JSDoc**: `AppendOptions.metadata` loses "Per-append" as its only description and points
  at `eventMetadata`; `CommandOptions.eventMetadata` documents §4.2's evaluation order and
  re-run rules; `CommandOptionsBase.eventTimestamps` drops "there is no `Effect` form" and
  documents §7.2; `AppendTooLarge` (schema `Errors.ts`), `TransactionOverflow`,
  `Transaction.transactWrite`, `checkTransactionLimit`'s callers and the `EventStore`
  stream-index `key` docs drop "before anything is sent" for the diagnosis wording.
- **CLAUDE.md** — "Coding Conventions" gains the standard as a rule: *do not pre-check
  limits DynamoDB enforces; diagnose its rejection through `internal/WriteDiagnosis.ts`*.

---

## 11. Scoping decisions

| # | Item | Decision | Source |
|---|---|---|---|
| 1 | Handler `eventTimestamps` `Effect` form | **In** — mirrors `eventMetadata` (§7.2) | user |
| 2 | Its generics | **Separate `E4` / `R4`** — shared `E3` / `R3` fails to infer when error types differ (§7.3) | probe; recorded here |
| 3 | `append`'s `eventTimestamps` | **Unchanged** — plain data (§7.4) | design |
| 4 | Sentinel / TTL / inline snapshot time | **Unchanged** — the append's `now` | user |
| 5 | Timestamp ordering check | **None** (unchanged) | user |
| 6 | Library-wide standard: no pre-checks of DynamoDB-enforced limits; recognise → confirm → attribute → rewrite or pass through | **In** (§6) | user |
| 7 | 400 KB per-item check (this PR) | **Converted** — removed, diagnosed | user |
| 8 | 4 MB per-transaction check (#133) | **Converted** — removed, diagnosed | user |
| 9 | 100-item checks: `transactGet` (`Transaction.ts` ~123), entity transactional cascade (`Entity.ts` ~4819), `EventStore` (`AppendTooLarge` ×2) | **Converted**; `AppendTooLarge` kept as the public error | user (listed) |
| 9a | 100-item check: `transactWrite`'s expanded count (`Transaction.ts` ~250, #113) | **Converted** — not in the listed lines, but the same mirror. Changes a documented no-AWS-call behaviour: the expanded-count `DynamoError` (same tag and message) now comes from DynamoDB's rejection, and only when its wording is recognised | design — please confirm |
| 10 | 100-item check: `Entity`'s `checkTransactionLimit` (guarded put, update, delete ×2, restore) | **Converted** — not in the listed lines, but the same mirror; applying the standard library-wide | design — please confirm |
| 11 | 100-item check: `Aggregate` groups, checked up front across all groups | **Kept — open.** It prevents a partial multi-group commit DynamoDB cannot see (§6.8); groups still get the size / key diagnosis | design — **needs your call** (listed for conversion) |
| 12 | `EventStore` 1024-byte stream-index sort-key check (append path) | **Converted**; the non-empty-string check on the same result stays | user |
| 13 | `readIndex` `beginsWith` / `between` validation | **Left as is** — mirrors DynamoDB's request validation of a read (empty value, inverted `BETWEEN`), not a size limit | design — reported for your call |
| 14 | Diagnosis at every single-item, `TransactWriteItems` and `BatchWriteItem` site (§6.5) | **In** | user |
| 15 | No public error union widened; `AppendTooLarge` / `TransactionOverflow` / `AggregateTransactionOverflow` gain an optional `cause` | **In** — additive fields, so DynamoDB's error can be kept as cause | design — please confirm |
| 16 | `Entity` expression limits (4 KB / 300 operators on a condition — `oversizedCondition`) | **Not converted in this PR** — a DynamoDB-enforced limit, so in the standard's reach, but not in the listed conversions and its rejection shape is not yet observed | design — candidate, **pending your call** |
| 17 | Partition key over 2048 bytes | **Not diagnosed in this PR** — no pre-check existed; one more recogniser in the module when wanted | design — candidate |
| 18 | `Table.definition` vector-index limits | **Kept** — definition-time | user |
| 19 | `Batch` chunking (25 / 100 / 3.5 MB) | **Kept** — chunking, not refusal | user |
| 20 | Own invariants and misdiagnosis guards (`refuseRepeatedItems`, empty-part conditions, option-shape checks) | **Kept** (§6.7) | user |
| 21 | Stream-index projection (item 5 of the review) | **Deferred — pending your decision**; `Table.ts` projections untouched | user |
| 22 | Returning metadata / timestamps from `append` / the handler | **Out** (§7.4) | design |
| 23 | `Aggregate` delete's `BatchWriteItem` | **Not diagnosed** — deletes of stored keys cannot meet these limits, and `delete`'s error union has no `ValidationError`; wrapping it would widen a public union | design — please confirm |
