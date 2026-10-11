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
  eventMetadata: ({ events }) =>
    Effect.forEach(events, () => Effect.map(crypto.randomULID, (eventId) => ({ eventId }))),
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
| **D. Allow both, shallow-merging `metadata` into each entry** | Rejected. Merging presumes `M` is a plain object; the schema may be anything, and merging through a transforming schema has no well-defined meaning (merge Type-side, then encode? encode both, then merge wire objects?). A caller who wants shared + per-event fields writes `events.map((_, i) => ({ ...shared, eventId: ids[i] }))`, which is explicit and type-checked. |

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
to this feature: minting ids through Effect's `Crypto` service (`crypto.randomULID`, or
`randomUUIDv7`) keeps them deterministic under `TestClock` and a test `Crypto` layer with
fixed bytes, which a `ulid()` call from a library inside a plain function cannot be.

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
The docs answer redelivery with the library's own mechanism rather than ids derived from
a delivery id (which would not be ULIDs): an idempotent handler called with the delivery
id as `commandId`, so the redelivery fails with `DuplicateCommand` and the first commit's
ULIDs stand (`index-projection.md` §7):

```ts
const handle = EventStore.commandHandler(decider, stream, {
  idempotency: { ttl: Duration.days(1) },
})
yield* handle(streamId, command, {
  commandId: deliveryId,
  eventMetadata: ({ events }) =>
    Effect.forEach(events, () => Effect.map(crypto.randomULID, (eventId) => ({ eventId }))),
})
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
| `Batch.write` — plain requests | `BatchWriteItem` | 5, 8 | `ValidationError`; the message says exactly what the batch had already written — its versioned-put transactions and non-versioned requests — and what was not sent (`Batch.write` was never atomic) |
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
| 100 items per aggregate group | `Aggregate.ts` `writeTransactionGroups` | `AggregateTransactionOverflow` before **any** group is written | removed; shape 6 per group, naming the groups already committed (§6A.4a — supersedes the earlier "kept") |

### 6.7 What stays a pre-check, and why

*Superseded by §6A.8: `refuseRepeatedItems`, `Table.definition`'s vector-index limits,
`readIndex`'s bound validation and the 3.5 MB Batch budget below are converted or changed there.
The rest of this list stands.*

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
  *(Superseded by §6A.3: versioned-put transactions now split at exactly 4,194,304 bytes /
  100 items by the exact size model.)*
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
- **Aggregate groups (superseded by §6A.4a: converted).** *Original text:* `Aggregate` writes a large aggregate as
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

## 6A. Pre-check sweep and exact sizing

*Added after the second review of #145. It applies the §6 standard to the whole library and
supersedes the parts of §6.6–§6.8 and §11 it names (the Aggregate group check, `refuseRepeatedItems`,
`oversizedCondition`, `readIndex` bounds, the vector-index limits, `Batch.write`'s 3.5 MB budget).*

**The standard, restated.** The library does not pre-check a limit or request rule DynamoDB
enforces itself. It sends the request. When DynamoDB rejects it, the library recognises the
rejection, confirms it against the request it sent, and rewrites it into a tagged error that
names the culprit, with DynamoDB's error kept as the cause. Unrecognised or unconfirmed errors
pass through unchanged. "It prevents a partial multi-request write" is **not** a reason to
keep a pre-check: multi-request writes (Aggregate groups, Batch chunks) are not atomic anyway.
The diagnosis says exactly what was already written. A check stays a pre-check only when it
protects something DynamoDB cannot see, or a request DynamoDB would accept with a different
meaning (§6A.8).

All wordings below were observed on **DynamoDB Local 3.1.0** (container `edd-144-ddb`) on
2026-10-10 with throwaway tables, which were deleted afterwards. AWS wording can differ; §6.8's
mitigations apply: short stable fragments, exact confirmation, and pass-through.

### 6A.1 Probed rejection wordings

| # | Rule | Request | DynamoDB Local's response |
|---|---|---|---|
| P1 | 100 items per transaction | `TransactWriteItems` of 101 (Puts, or 60 Puts + 41 Deletes); `TransactGetItems` of 101 | `ValidationException` "Member must have length less than or equal to 100" (request-wide; same for both) |
| P2 | One operation per item | two ops on one key (Put+Put, Put+Delete, Update+Update, keys given in different attribute order); `TransactGetItems` with a repeated key | `ValidationException` "Transaction request cannot include multiple operations on one item" |
| P2a | One operation per item, but **the repeat's condition fails against the earlier op's effect** | Put `x` + ConditionCheck `attribute_not_exists(pk)` on `x`; two guarded puts both expecting `ver = 1` | `TransactionCanceledException` `[None, ConditionalCheckFailed]`. Local applies the ops in order, and a repeated item whose condition then fails is reported as a **conditional failure**. That cannot be told apart from a lost race. When the repeat's condition passes, Local reports P2 |
| P2b | One operation per item (batch) | `BatchWriteItem` with a repeated key (Put+Put or Put+Delete); `BatchGetItem` with a repeated key | `ValidationException` "Provided list of item keys contains duplicates" |
| P3 | Expression size: 4,096 characters | condition, update, key-condition, filter or projection expression of 4,097 characters (4,096 accepted) | `ValidationException` "Invalid ConditionExpression: Expression size has exceeded the maximum allowed size; expression size: 4097". Key condition: the same, with its kind. `UpdateExpression` and `ProjectionExpression`: the same text, but **without** "; expression size: N". The measure is the expression string's length, placeholders unexpanded |
| P4 | 300 operators per expression | 301 operators in a condition, filter or update expression (300 accepted) | `ValidationException` "Invalid ConditionExpression: The expression contains too many operators; operator count: 301" (also `FilterExpression`, `UpdateExpression`). DynamoDB stops counting at 301: 302 also reports 301. Confirmed against `countOperators`: each comparison, `AND`/`OR`/`NOT`, `BETWEEN` (its own `AND` not counted), `IN`, each function (`size`, `attribute_exists`, `if_not_exists`), each update `+`/`-`; `SET`'s `=` is not counted |
| P5 | 100 operands in `IN` | `#a IN (` 101 values `)` (100 accepted) | `ValidationException` "Invalid ConditionExpression: The IN operator is provided with too many operands; number of operands: 101" |
| P6 | Placeholder name length 255 | a 256-character `:placeholder` | `ValidationException` "ExpressionAttributeValues contains invalid key: The expression attribute map contains a key that is too long;" (library placeholders are short; recorded only) |
| P7 | Empty key value in a query | `begins_with(sk, "")`, `BETWEEN "" AND "a"`, `sk = ""` | table key: "One or more parameter values are not valid. The AttributeValue for a key attribute cannot contain an empty string value. Key: sk". GSI/LSI key: "One or more parameter values are not valid. A value specified for a secondary index key is not supported. The AttributeValue for a key attribute cannot contain an empty string value. IndexName: gsi1, IndexKey: g1sk" |
| P8 | `BETWEEN` order | lower bound sorting after the upper (table, GSI, LSI) | "Invalid KeyConditionExpression: The BETWEEN operator requires upper bound to be greater than or equal to lower bound; lower bound operand: AttributeValue: {S:b}, upper bound operand: AttributeValue: {S:a}". The order is **UTF-8 byte order**: `"�" .. "\u{1F600}"` (UTF-8 ascending, UTF-16 descending) is accepted, and its reverse is rejected. `compareUtf8` mirrors this exactly. `BETWEEN "a" AND "a"` is accepted |
| P9 | `Limit` ≥ 1 | `Query`/`Scan` with `Limit: 0` or `-1` | "Limit must be greater than or equal to 1". `Limit: 1.5` is **accepted** |
| P10 | Consistent read of a GSI | `Query` / `Scan` with `IndexName` of a GSI and `ConsistentRead: true` | "Consistent read cannot be true when querying a GSI" / "… when scanning a GSI". An LSI consistent read is accepted |
| P11 | Empty secondary-index key on write | `PutItem` / transaction `Put` with a GSI or LSI key attribute `""` | request-wide `ValidationException`, P7's secondary-index wording, naming `IndexName` and `IndexKey` (also inside a transaction: request-wide, not a cancellation reason) |
| P12 | Key sizes | table hash key 2,049 / range key 1,025 bytes (2,048 / 1,024 accepted) | **"Hash primary key values must be under 2048 bytes, and range primary key values must be under 1024 bytes"**. In a transaction it is a cancellation reason `{ Code: "ValidationError", Message: <same> }`. Index keys (GSI pk 2,049, GSI/LSI sk 1,025): "One or more parameter values were invalid: Size limit exceeded", request-wide even in a transaction |
| P12a | Index sort key grown by an update | `UpdateItem` (single, or in a transaction) setting a GSI sort key of 1,025 bytes | **Accepted by Local.** Local does not enforce an index key's size on `UpdateItem`; AWS does |
| P13 | `ReturnValues` on `DeleteItem` | `ALL_NEW` / `UPDATED_OLD` / `UPDATED_NEW` | "Return values set to invalid value" |
| P14 | Empty `IN ()` / `()` | condition or filter `#a IN ()` | "Invalid ConditionExpression: Syntax error; token: \")\", near: \"()\"" (names nothing) |
| P15 | Vector indexes | `CreateTable` with `VectorIndexes` | **Not supported by Local 3.1.0.** Without the `SearchSchema` attributes in `AttributeDefinitions` the table is created and the vector indexes are **silently dropped** (`DescribeTable` shows none). With them, as `Table.definition` emits, it fails with "The number of attributes in key schema must match the number of attributes defined in attribute definitions." `UpdateTable` with `VectorIndexUpdates` → "Nothing to update". The limit rejections cannot be observed (§6A.5) |

### 6A.2 Exact DynamoDB size accounting

Measured on Local from the "Payload Size" its 4 MB rejection reports. The boundaries were
confirmed exactly: item 409,600 bytes accepted, 409,601 rejected; transaction 4,194,304
accepted, 4,194,305 rejected.

**Item size** (the 400 KB limit): the sum over attributes of `utf8(name) + size(value)`, with
no per-item or per-attribute overhead.

| Type | Size |
|---|---|
| `S` | UTF-8 bytes |
| `B` | byte length |
| `BOOL`, `NULL` | 1 |
| `N` | `0` → 1. Otherwise `1 +` the number of base-100 digit pairs of the magnitude (pairs aligned to the decimal point, all-zero pairs trimmed at both ends), `+ 1` if negative with fewer than 20 pairs (at most 21 bytes) |
| `SS` / `NS` / `BS` | sum of the elements' sizes (UTF-8 / number / byte length), no overhead |
| `L` | `3 + Σ (size(element) + 1)` |
| `M` | `3 + Σ (utf8(name) + size(value) + 1)` |

Number sizes measured: `1, 9, 10, 12, 99, 100, 1000, 1200, 1000000, 1e10, 0.5, 0.05, 0.001,
0.0012, 1E-10, 9.9E+125` → 2; `101, 120, 123, 1001, 1234, 1.5, 12.34, 10.01` → 3; `12345,
123456, 1.234, -123` → 4; `-1` → 3; `-0.000001` → 3; 37- and 38-digit integers → 20. A
negative number's sign byte is left off at the maximum 20 pairs, so no number exceeds 21
bytes: `-123456789012345678901234567890123456.78` (19 pairs) → 21, and
`-9.9999999999999999999999999999999999999`, `-1.2345678901234567890123456789012345678`,
`-12345678901234567890123456789012345.678` (20 pairs) → 21, not 22. A mixed
item (a negative decimal, a map holding a list of `N`/`BOOL`/`NULL`, `SS` with a 2-byte
character, `NS`, `BS`, `B`) was re-measured in this sweep: the model gave 64 bytes, and so did
Local.

**Transaction payload** (the 4 MB limit). Measured in this sweep by putting the probed action
*first* and padding with large Puts. Each action contributes:

```
contribution(action) =
    (Put ? itemSize(Item) : itemSize(Key))           // Update / Delete / ConditionCheck: the key only
  + Σ over its expressions (ConditionExpression, UpdateExpression):
        utf8(expression)                              // placeholders counted as written
      + Σ over each placeholder OCCURRENCE in it:
            #name  → utf8(ExpressionAttributeNames[#name])
            :value → size(ExpressionAttributeValues[:value])
```

The measured results that fix each part, as bytes over the action's key or item:

| Action | Contribution measured |
|---|---|
| Put, no condition | the item (6 for a 6-byte item; 64 for the mixed item) |
| Put + `attribute_exists(pk)` | +20: the expression |
| Put + `attribute_exists(#pppp)`, `#pppp → "e"` | +24: 23 + 1 |
| Put + `#p` used twice, `#p → "eeeeeeeeee"` | +64: 44 + 2 × 10. A name counts **per occurrence** |
| Put + `e = :v OR f = :v`, `:v` = 10-byte `S` | +36: 16 + 2 × 10. A value counts **per occurrence** |
| Put + `q = :q`, `:q` = `N "123"` | +9: 6 + 3 (number rule) |
| Delete, of an absent item, or of a stored 300 KB item | the key only (6; 11). The stored item does not count |
| ConditionCheck, absent or stored 300 KB item | the key + its expression and substitutions |
| Update `SET a = :v` (100-byte `S`), absent or stored 300 KB item | key + 10 + 100. The stored item and the resulting item do not count |
| Update + condition | key + both expressions + all substitutions (222 = 6 + 10 + 6 + 100 + 100) |
| Update `REMOVE a` | key + 8 |
| `TableName`, `ReturnValuesOnConditionCheckFailure` | nothing |

Two consequences:

- **Expressions count toward the 4 MB but not toward the 400 KB.** A 409,600-byte item with a
  condition (and a 1,000-byte condition value) is accepted, singly and in a transaction. Ten
  Puts whose items and condition total exactly 4,194,304 bytes are accepted; one byte more is
  rejected (`Payload Size: 4194305`).
- **Local's "Payload Size: N" is a running total, not the request's total.** Local sums actions
  in request order and stops at the first one that crosses 4,194,304. For 12 Puts of about
  390 KB it reported the sum of the first 11 (4,290,099), not all 12 (4,680,108). A diagnosis
  therefore reports both numbers: "DynamoDB reported N (its running total when it stopped
  counting); the request measures M".

**One function, used everywhere.** `internal/ItemSize.ts` drops `SizeBound` (`"lower"` /
`"upper"`) and exports exact measures only:

```ts
/** A number's size by DynamoDB's rule (base-100 pairs aligned to the point, +1, +1 if negative). */
export const numberBytes: (n: string) => number
/** An attribute value's size (S, N, B, BOOL, NULL, SS, NS, BS, L, M as tabled above). */
export const attributeBytes: (value: AttributeValue) => number
/** An item's size: Σ utf8(name) + attributeBytes(value). What the 400 KB limit measures. */
export const itemBytes: (item: Record<string, AttributeValue>) => number
/** An expression's contribution: its UTF-8 length plus each placeholder occurrence's substitution. */
export const expressionBytes: (
  expression: string | undefined,
  names: Record<string, string> | undefined,
  values: Record<string, AttributeValue> | undefined,
) => number
/** One transact action's contribution to the 4 MB payload (the formula above). */
export const transactItemBytes: (item: TransactWriteItem) => number
```

These are used by every diagnosis attribution (`ItemTooLarge`, `TransactionTooLarge`) and by
`Batch.write`'s chunking (§6A.3), with nothing else alongside them. Two bugs in today's
estimates go with them:

- The old `"upper"` bound under-counted maps: it added 3 bytes per map but not the `+1` per
  entry. It was meant to never under-count, and it did.
- The old `"lower"` number count (`ceil(significantDigits / 2) + 1`) ignored the alignment of
  pairs to the decimal point (`120` → 2, actually 3; `1.5` → 2, actually 3). Today's
  `transactItemBytes` also left out every expression, name and value, so it under-counted
  every conditioned Put. That includes all of `Batch.write`'s versioned Puts, which carry
  `attribute_not_exists(#pk)` (+25 + `utf8(pkField)` each).

The model was measured on Local. AWS documents only "the aggregate size of the items", so
AWS may count expressions differently. §6A.3 covers a disagreement.

### 6A.3 `Batch.write` versioned-put transactions: split rule and mismatch handling

- **Split rule.** Versioned puts are chunked greedily, in caller order. A new chunk starts when
  the current one holds 100 actions, or when adding the next would take the chunk's
  `Σ transactItemBytes` past **4,194,304** (`TRANSACT_WRITE_MAX_BYTES`). The contribution
  includes the create-only condition and its name. `MAX_TRANSACT_BYTES = 3_500_000` is
  removed. Chunking is a strategy (it picks request boundaries and refuses nothing), so it
  measures. A single put cannot exceed the budget: its item is at most 409,600 bytes, or
  DynamoDB rejects it as `ItemTooLarge`.
- **Mismatch (decision A: no re-split, no retry).** Suppose DynamoDB rejects a chunk with the
  4 MB message although it measured ≤ 4,194,304. The diagnosis is `TransactionTooLarge` with
  `measured` (≤ 4,194,304) and `reported` (DynamoDB's `N`). The `ValidationError` says the
  library's size model disagrees with DynamoDB for this request, and gives both numbers and
  the largest contributors. The message names how many chunks (and items) were committed. It is returned to the application as is.
- **Application-requested transactions are never split.** `Transaction.transactWrite`,
  `EventStore.append` / `commandHandler` and `Entity`'s transactional writes are sent whole.
  A size rejection comes back diagnosed (§6.3 shape 7), with the same measured / reported pair.

### 6A.4 Conversions (scope 1)

**a. Aggregate group count** (`Aggregate.ts` `writeTransactionGroups`, the up-front loop at
~3267–3288). The up-front loop is removed. Each group's rejection is already diagnosed
(`TooManyItems` → `AggregateTransactionOverflow`; size, sort key, repeated item →
`ValidationError`). The error now states **which groups were already committed**: the
`group.group` names of earlier groups that wrote items, which are known exactly because their
transactions returned. `AggregateTransactionOverflow` gains an optional
`committed?: ReadonlyArray<string>` (additive, like its `cause`). The `ValidationError` text
replaces "earlier requests may already have been written" with "Already committed:
sub-aggregates X, Y." when `groupIndex > 0`, and keeps "Nothing was written." for the first
group. *Consequence to note:* a failed `create` can leave the root (group 0) written. A
retried `create` then fails the root's `attribute_not_exists` guard (`ConditionalCheckFailed`),
so the message tells the caller to `update` or `delete` the partial aggregate.

**b. Repeated items** (`refuseRepeatedItems`, `internal/TransactWriteOps.ts:212`, called at
`:434` and `EventStore.ts:2262`). The pre-check is removed. A new `Diagnosis` variant
`RepeatedItem { first: TransactItemTarget; second: TransactItemTarget }`:

- **Recognise** P2's fragment `cannot include multiple operations on one item` (request-wide,
  `TransactWriteItems` and `TransactGetItems`). Also recognise **any** transaction
  cancellation (`TransactionCanceledException` / `TransactionCancelled`, whatever its codes)
  when the request repeats an item, because of P2a. Recognise P2b's `Provided list of item
  keys contains duplicates` for a `BatchWriteItem` chunk.
- **Confirm** exactly: two targets of the sent request share an `identity`. The targets
  include the derived items: uniqueness sentinels reserved or released, retain snapshots, an
  append's events and its idempotency sentinel.
- **Placement: first, not last.** This is the one diagnosis that runs *before* the site's
  conditional-failure mapping (`judgeCancellation`, `sendAppendTransaction`'s conflict reading,
  `Batch.write`'s `replacedAt`, the Aggregate root guard). Under P2a, Local's reasons for a
  repeat read as a lost race, and a mapping that ran first would retry the request (guarded
  puts, an append's guarded additional puts, `Batch.write`'s contention loop) and finally
  misreport it as `OptimisticLockError` / `VersionConflict`. A request that repeats an item can
  never commit, so whatever DynamoDB reported, it is diagnosed as `RepeatedItem`. The
  diagnosis is terminal, and no retry loop retries it.
- **Cost:** on failure only. The identities are compared after DynamoDB has rejected the
  request; `BuiltTransactWriteItems.targets` becomes a thunk like the others.
- **Errors:** `ValidationError` carrying today's text ("touches one item more than once —
  `<first>` and `<second>` both target the item at `<key>` …"), with DynamoDB's error as its
  cause. `Batch.write`'s says exactly what the batch had already written. `Transaction.transactGet` maps it to `DynamoError`.
- **Unchanged:** Aggregate's #103 collision check stays (§6A.6, K10).

**c. Expression limits** (`Entity.ts` `oversizedCondition` at ~3480, and `deleteGuard`'s
`tooLargeBeside` at ~3608; callers ~4366, ~5973, ~6859, ~6900). The refusal is removed: the
condition is sent as built. A new `Diagnosis` variant
`ExpressionTooLarge { target; expression: "ConditionExpression" | "UpdateExpression"; limit: "size" | "operators" | "inOperands"; measured: number; reported: number | undefined; userPart?: { length; operators } }`:

- **Recognise** P3 (`Expression size has exceeded the maximum allowed size`), P4
  (`contains too many operators`) and P5 (`IN operator is provided with too many operands`).
  Read the expression kind from the `Invalid <Kind>Expression:` prefix, and `N` when present.
- **Confirm** exactly: an entry whose expression of that kind has length > 4,096, operators >
  300 (`countOperators`, verified against P4), or an `IN` with > 100 operands. In a
  transaction, the first such entry is the culprit (the rejection is request-wide).
- **Attribute** as `oversizedCondition` did: the condition's length and operator count, the
  caller's `.condition()` alone, and the room the library's own guard takes.
- **Stays (strategy):** `expressionFits` in the wide-update split (~5949) and in `deleteGuard`'s
  fall back to the strongest guard that fits (~3528). Both pick a request that fits and refuse
  nothing.

**d. `readIndex` key bounds** (`EventStore.ts` `invalidIndexKeyCondition` ~716–742, refused at
~2789). The empty-value and reversed-`between` checks are removed. The read is wrapped
failure-only: P7 (`cannot contain an empty string value`, with `IndexKey: X` / `Key: X`) is
confirmed when the sent `beginsWith` / `between` bound for that attribute is `""`. P8
(`BETWEEN operator requires upper bound to be greater than or equal to lower bound`) is
confirmed by `compareUtf8(low, high) > 0`, which P8 shows is DynamoDB's own order. Both are
rewritten into `ValidationError` (`operation: "EventStore.readIndex"`) naming the index and
the bound. **Kept:** "at most one of `beginsWith` and `between`" and the string-type checks
(our API's input), and the `limit` check. `Query.limit` is a contract on results: `limit ≤ 0`
returns `[]` without sending a request (`Query.ts` ~1204, ~1311), so DynamoDB never sees a
`Limit: 0`. A non-integer is sent and Local *accepts* `Limit: 1.5` (P9). DynamoDB never
rejects either, so the check guards our API's meaning (class ii).

**e. Vector-index limits** (`Table.ts` `mergeVectorIndexes` ~299–315: EDD-9032 after the union,
EDD-9034; run by `Table.make` at ~176 and `Table.definition` at ~755). The refusals are
removed, together with their per-entity twins in `schema/src/VectorIndex.ts` (EDD-9032 count
~379, EDD-9034 ~408). Leaving those would make the table-level conversion moot.
`db.tables.create` (`CreateTable`) and `addVectorIndex` (`UpdateTable`) diagnose the rejection,
naming the index and **every entity sharing it** (`MergedVectorIndex` gains
`sharers: ReadonlyArray<string>`).

- **Local cannot test this** (P15). The recogniser is built from AWS's documented quotas and
  covered by unit tests only. **Gap reported:** no connected test is possible, and the exact
  AWS wording is undocumented.
- AWS's quotas page lists 5 vector indexes per table, **adjustable** via Support, and 18 inline
  filters per vector index, not adjustable. So today's EDD-9034 refuses a valid configuration
  on an account whose quota was raised: a real defect this conversion fixes.
- **Recognise** a `ValidationException` or `LimitExceededException` on `CreateTable` /
  `UpdateTable` whose message mentions `vector` (case-insensitive), together with
  `inline.?filter` (filters) or a vector-index count ("limit" / "exceed" / "maximum" /
  "at most").
- **Confirm:**
  - *Filters:* exactly — an index in the request whose `SearchSchema` has more than 18
    `INLINE_FILTER` elements.
  - *Count:* for `CreateTable`, more than 5 `VectorIndexes`, or more than the limit the message
    states (the quota is adjustable). For `UpdateTable`, the message alone is the evidence,
    because the table's existing count is not in the request. The error names the index being
    added and the declared total.
- Unconfirmed → pass-through (today's `DynamoValidationError`).

### 6A.5 Audit of remaining pre-checks (scope 2)

Searched in `packages/effect-dynamodb/src`, `packages/schema/src` and `packages/effect-dynamodb-geo/src`:

- "Nothing was sent" / "Nothing was written" / "before anything is sent" / `BEFORE`;
- every `new ValidationError(` (102 sites);
- `DynamoError` / `TransactionOverflow` / `AppendTooLarge` / `AggregateTransactionOverflow` /
  `CascadePartialFailure` constructed before a client call;
- every `[EDD-…]` thrown at make time.

Decode failures, failures already mapped from a DynamoDB response, and diagnosis rewrites are
not pre-checks and are left out. Class **(i)**: mirrors a rule DynamoDB enforces → convert.
Class **(ii)**: protects something DynamoDB would accept with another meaning, or cannot see →
keep. Line numbers are approximate (`~`) as of `f6db640`.

| # | File:line | Check | Class | Reason | Action |
|---|---|---|---|---|---|
| C1 | `Aggregate.ts:~3277` | every group ≤ 100 items, checked before the first group | (i) | DynamoDB rejects each group (P1). The cross-group guarantee was rejected by the user | **Convert** (§6A.4a) |
| C2 | `internal/TransactWriteOps.ts:~212` (`:434`, `EventStore.ts:~2262`) | `refuseRepeatedItems` | (i) | P2 / P2a | **Convert** (§6A.4b) |
| C3 | `Entity.ts:~3480`, `~3608` (callers `~4366`, `~5973`, `~6859`, `~6900`) | `oversizedCondition`, `tooLargeBeside` | (i) | P3 / P4 / P5 | **Convert** (§6A.4c) |
| C4 | `EventStore.ts:~721`, `~734`, `~739` | empty `beginsWith`/`between` bound; reversed `between` | (i) | P7 / P8 | **Convert** (§6A.4d) |
| C5 | `Table.ts:~299`, `~309` | EDD-9032 (filters after union), EDD-9034 (per table) | (i) | AWS quotas; 9034's is adjustable | **Convert** (§6A.4e) |
| C6 | `schema/src/VectorIndex.ts:~379`, `~408` | EDD-9032 / EDD-9034 per entity at `Entity.make` | (i) | same limits, checked earlier | **Convert** with C5 |
| C7 | `Query.ts:~988` | `consistentRead` on a GSI (also reached by `readIndex` on a GSI index, `EventStore.ts:~2718`) | (i) | P10 | **Convert** (discovered): recognise `Consistent read cannot be true when (querying\|scanning) a GSI`, confirm `ConsistentRead && IndexName` names a GSI the query knows, rewrite to today's `ValidationError` text |
| C8 | `EventStore.ts:~1722` | stream-index key `""` | (i) for `""` | P11: rejected request-wide, naming `IndexName` / `IndexKey` | **Convert the empty-string half** (discovered): confirm an event put writing `""` to that attribute; name the index and event version. The non-string half stays (K2) |
| C9 | `Batch.ts:45`, `:300` | `MAX_TRANSACT_BYTES = 3_500_000` on the `"upper"` estimate | strategy, wrong measure | DynamoDB's limit is 4,194,304 by §6A.2 | **Change** to exact 4,194,304 (§6A.3) |
| D1 | `schema/src/VectorIndex.ts:~347` | EDD-9030 dimensions an integer in 1..4096 | (i) | AWS: max 4,096, not adjustable; purely a mirror | **Propose convert** — beyond the listed items, needs your call. Local cannot test it |
| D2 | `Aggregate.ts:~1235` | EDD-9042 `consistentRead` with a GSI collection (make time) | (i) | P10 | **Propose convert** with C7 — needs your call: it moves a startup error to every read |
| D3 | `schema/src/VectorIndex.ts:~423` `clampTopK` | silently clamps `TopK` into 1..100 | (i)-mirror, and **silent** | it rewrites the caller's request instead of refusing; AWS max 100, not adjustable | **Propose:** send as given and diagnose the `SearchVectors` rejection — needs your call. Local cannot test it |
| K1 | `EventStore.ts:~716` | at most one of `beginsWith` / `between` | (ii) | our API's input | Keep |
| K2 | `EventStore.ts:~721`, `~734`, `~1722` | non-string bound / non-string index key | (ii) | our API's contract (string keys); a number would be sent as `N` | Keep |
| K3 | `EventStore.ts:~2794` | `readIndex` `limit` a positive integer | (ii) | never reaches DynamoDB as `Limit: 0`; `1.5` is accepted (P9) | Keep |
| K4 | `internal/Expr.ts:~411` `emptyPartProblem` (`Query.ts:~968`, `Aggregate.ts:~3477`, `TransactWriteOps.ts:~118`, `EntityOps.ts:~83`, `Entity.ts:~8195`) | `or()`, `or(x, {})`, `not({})`, `isIn([])` | (ii) | `or(x, {})` / `not({})` compile to conditions DynamoDB accepts with a widened meaning. `isIn([])` alone mirrors P14's syntax error | Keep as one rule; `isIn([])` listed for your call |
| K5 | `TransactWriteOps.ts:~290` | `Transaction.check({})` | (ii) | a check that asserts nothing has no meaning to send | Keep |
| K6 | `Entity.ts:~7169` | delete `returnValues` other than none / allOld | (ii) | P13 mirrors it for a plain `DeleteItem`, but read-first deletes are transactions that never send `ReturnValues`: DynamoDB cannot see it there | Keep |
| K7 | `Batch.ts:~236–283`, `TransactableOps.ts:~123`, `~201` (EDD-9049, EDD-9048) | unrecognised op; a condition on a batch write; multi-item lifecycle features in a batch | (ii) | `BatchWriteItem` has no condition. Sending would drop the meaning | Keep |
| K8 | `Batch.ts:~333` | an item touched again alongside a versioned put | (ii) | an ordering invariant across separate requests | Keep |
| K9 | `Batch.ts:~114`, `Transaction.ts:~131`, `TransactableOps.ts:~78` (EDD-9052) | not a get descriptor | (ii) | our API's input | Keep |
| K10 | `Aggregate.ts:~2743` (#103) | two items of one aggregate composing one sort key | (ii) | items in **different groups** are accepted by DynamoDB and the second overwrites the first: silent loss DynamoDB cannot see | Keep |
| K11 | `Aggregate.ts:~3009`, `~3021`; `~973` (EDD-9056); `~1218`, `~1228` (EDD-9041/9043); `~1696`; `~1758` (EDD-9051) | sk composite missing / non-scalar; nested discriminator; collection config; list config; sharded cursor | (ii) | our model and config | Keep |
| K12 | `EventStore.ts:~1918`, `~1927`, `~1949`, `~1981`, `~3915`, `~3936`, `~4070`, `~4083`, `~4092`, `~4105`, `~4121` | metadata / eventMetadata / eventTimestamps / inline snapshot / commandId / expectedVersion | (ii) | the caller's own invariants | Keep |
| K13 | `EventStore.ts:~2005` | an index attribute equal to the TTL attribute | (ii) | two library-managed attributes collide; the sentinel would write a number into a string key | Keep |
| K14 | `Entity.ts:~5341`, `~5443`, `~5457`, `~8183`, `~8231`, `~8255`, `~8284`, `~9245` (EDD-9047), `~6727`, `~6758`, `~5115`, `~5790`, `~6390`, `~6736`, `~7909` | expectedVersion without versioning; path ops with unique / cascade; append config; purge condition; not a sparse map; sparse key empty or holding `#` | (ii) | our API and storage conventions (`#` is the sparse delimiter) | Keep |
| K15 | `Entity.ts:~2798`, `~3407` | incarnation without version; snapshot already exists | (ii) | invariants read from the stored item | Keep |
| K16 | `Entity.ts:~451` `expressionFits` (`~3528`, `~5949`) | fits the guard / splits a wide update | strategy | refuses nothing | Keep |
| K17 | `Entity.ts:~3094`, `~9822`; `internal/BoundVectorQuery.ts:~265`, `~396` | vector length ≠ declared dimensions | (ii), open | embedder output vs declaration. How DynamoDB treats a wrong-length vector cannot be probed on Local | Keep; open |
| K18 | `Table.ts:~267` (EDD-9035), `~285` (EDD-9040); `schema/src/VectorIndex.ts:~393` (duplicate filter), `~400` (EDD-9033), `~253` (EDD-9039) | sharers disagree; one entity binds a physical index twice; filter type not S/N | (ii) | merge invariants, needed to emit one definition and its `AttributeDefinitions` | Keep |
| K19 | `DynamoClient.ts:~1077` (EDD-9037), `~1508` (EDD-9038), `~1858`, `~1990` (EDD-9036) | embedder vs declared dimensions; accessor name collision; unknown index to add | (ii) | DynamoDB cannot see the embedder or our accessors | Keep |
| K20 | `DynamoClient.ts:~1099`, `~1111`, `~1123`, `~1226`, `~1261`, `~1296`, `~1423` (EDD-9002/9004/9006/9045/9053/9046) | query composition | (ii) | a sort-key condition we cannot express or that would widen the pinned prefix | Keep |
| K21 | `Table.ts:~480`, `~548` (EDD-9069); `EventStore.ts` EDD-9026/9027/9062–9068 | key-schema / index / snapshot config | (ii) | our definitions | Keep |
| K22 | `schema/src` EDD-9001–9025 (`Entity.ts`, `KeyComposer.ts`, `DynamoModel.ts`, `Errors.ts`, `internal/EntitySchemas.ts` EDD-9044/9057/9058) | entity definition | (ii) | none mirrors a DynamoDB limit (TTL finiteness: DynamoDB accepts any number) | Keep |
| K23 | `effect-dynamodb-geo/src/GeoIndex.ts:~130` | unknown index on entity | (ii) | config | Keep. The geo package has no other pre-check |

### 6A.6 Coverage gaps discovered

- **Local's table-key size wording is not recognised.** P12's "Hash primary key values must
  be under 2048 bytes, and range primary key values must be under 1024 bytes" is not matched
  by §6.3 shape 8's `SORT_KEY` fragment, so a table sort key over 1,024 bytes passes through
  today. It arrives request-wide on single writes and batches, and as a cancellation reason in
  transactions. Add the fragment; confirm by measuring the table's sort key (> 1,024), or the
  partition key (> 2,048) once §11 row 17 lands.
- **Index partition keys share the sort keys' wording.** "Size limit exceeded" also covers a
  GSI partition key over 2,048 bytes. Today it passes through, because no range key measures
  over 1,024; it can be diagnosed with §11 row 17.
- **Local accepts an over-long index sort key written by an update** (P12a). Shape 8 for an
  `Update` cannot be exercised on Local: unit tests only.
- **Local supports no vector indexes** (P15). A `Table.definition` with vector indexes fails
  `CreateTable` on Local. That is pre-existing; vector connected tests must stay mocked.
- **Read-side expression and key rejections** (P3–P5, P7, P8, P10 on `Query` / `BoundQuery` /
  collections) have no pre-check today and pass through. The §6A.4c/d/C7 recognisers can serve
  them; candidate.
- **`Batch.get` / hydration duplicate keys** (P2b on `BatchGetItem`) pass through
  (`internal/Hydrate.ts` documents it). Candidate.

### 6A.7 Examples that swallow failures (scope 5, adjacent debt)

32 of the 35 files in `packages/effect-dynamodb/examples/` hide a failure:

- 31 end with `Effect.runPromise(…).then(() => …, (err) => console.error("Failed:", err))`;
- `_walkthrough.ts` ends with `.catch((err) => console.error(…))`.

A failing example therefore exits 0, and doctest's `test:connected` (`runtime.test.ts`
`execSync(npx tsx …)`) cannot catch it. The task brief counted 11; the sweep found 32.
`guide-timeseries.ts` and `guide-vector-search.ts` already let the rejection propagate.
`guide-streams.ts` never runs its program.

**Fix, without `process`:** drop the rejection handler from all 32 and keep each success
branch, e.g. `Effect.runPromise(main).then(() => console.log("Done"))`. An unhandled rejection makes Node
exit non-zero. These lines sit outside every `#region`, so doctest sync is unaffected.
`_walkthrough.ts` is excluded from the runtime test (leading `_`) but gets the same ending.

### 6A.8 What stays a pre-check, and why

Only these:

- **Things DynamoDB cannot see:**
  - our own invariants (K12, K13, K15);
  - cross-request guarantees DynamoDB has no view of (K8; K10, where items collide across
    groups and DynamoDB *accepts* the overwrite);
  - our configuration and definitions (K11, K18–K23: EDD-90xx, including EDD-9063 and
    EDD-9069).
- **Inputs DynamoDB would accept with another meaning:** `emptyPartProblem` (K4), `readIndex`'s
  `limit` (K3), a condition on a batch write (K7).
- **Our API's input meaning:** K1, K2, K5, K6, K9, K14, K20.
- **Strategies that measure in order to choose, refusing nothing:** `expressionFits` (K16),
  `Batch.write` chunking (§6A.3).

### 6A.9 Scoping decisions

| # | Item | Decision | Source |
|---|---|---|---|
| S1 | Aggregate up-front group count | **Converted**; the error states the committed groups; `AggregateTransactionOverflow.committed?` added (additive) | user (listed); field: design — please confirm |
| S2 | Partial aggregate after a failed `create` (root committed) | **Documented** in the error ("update or delete the partial aggregate"); no compensation | design — please confirm |
| S3 | `refuseRepeatedItems` | **Converted**; `RepeatedItem` diagnosis runs **before** the conditional mapping and is terminal | user (listed); placement: design (P2a) |
| S4 | Any cancellation of a request that repeats an item → `RepeatedItem` | **In**: Local reports some repeats as `ConditionalCheckFailed` (P2a), and such a request can never commit | probe; design — please confirm |
| S5 | `BatchWriteItem` duplicate keys in a chunk (P2b) | **In**: diagnosed as `RepeatedItem`, naming what the batch had already written | discovered |
| S6 | `oversizedCondition` / `tooLargeBeside` | **Converted** (size, operators, `IN` operands) | user (listed) |
| S7 | `expressionFits` strategies (wide update split, strongest-guard fallback) | **Kept**: strategy | design |
| S8 | `readIndex` empty bound / reversed `between` | **Converted** | user (listed) |
| S9 | `readIndex` `limit` check | **Kept**: DynamoDB never sees it (`Query.limit ≤ 0` sends nothing; `1.5` accepted) | probe — please confirm (brief expected a conversion) |
| S10 | Vector limits EDD-9032 / EDD-9034, `Table.ts` and `schema/src/VectorIndex.ts` | **Converted**; recognition from AWS quotas, unit tests only; per-table quota is adjustable, so the pre-check was wrong | user (listed); schema twins: design |
| S11 | Vector recogniser wording | **Unverified**: Local has no vector support and AWS documents no message | gap reported |
| S12 | EDD-9030 dimensions range | **Proposed convert** — pending your call | discovered |
| S13 | `clampTopK` silent clamping | **Proposed:** send as given + diagnose — pending your call | discovered |
| S14 | `Query.consistentRead` on a GSI | **Converted** | discovered (class i) |
| S15 | EDD-9042 aggregate `consistentRead` + GSI (make time) | **Proposed convert** — pending your call | discovered |
| S16 | Stream-index key `""` | **Converted** (empty half); type half kept | discovered |
| S17 | `isIn([])` inside `emptyPartProblem` | **Kept** as one rule — reported for your call | design |
| S18 | Delete `returnValues` mode check | **Kept**: read-first deletes never send it | design |
| S19 | Aggregate #103 sort-key collision | **Kept**: cross-group collisions are accepted by DynamoDB | design |
| S20 | Vector dimension checks on write / query | **Kept, open**: DynamoDB's behaviour unverifiable on Local | design |
| S21 | Exact size model replaces `SizeBound` everywhere | **In** (§6A.2); fixes the map under-count and the number / expression under-counts | user |
| S22 | Transaction payload includes expressions, names, values per occurrence; Update / Delete / ConditionCheck count their key, not the stored item | **In** — measured | probe |
| S23 | "Payload Size: N" is a running total | **In**: reported next to the measured total, never as the total | probe |
| S24 | `Batch.write` split at 4,194,304 / 100; `MAX_TRANSACT_BYTES` removed | **In** | user |
| S25 | A measured-to-fit chunk rejected by DynamoDB | **Decision A**: diagnosed `ValidationError` with both sizes, returned; no re-split, no retry | user |
| S26 | Application-requested transactions | **Never split**; size rejections diagnosed | user |
| S27 | Table-key size wording (P12) not recognised | **In**: add the fragment | discovered |
| S28 | Partition-key size diagnosis (§11 row 17) | **Unchanged — candidate**; P12 gives its Local wording | design |
| S29 | Read-side expression / key diagnosis; `BatchGetItem` duplicates | **Out — candidates** | discovered |
| S30 | Over-long index sort key via `UpdateItem` | **Unit tests only**: Local accepts it (P12a) | probe gap |
| S31 | Examples swallowing failures | **In** — all 32, not 11; drop the rejection handler | user (adjacent debt) |
| S32 | `guide-streams.ts` never runs its program | **Out** — flagged | discovered |

### 6A.10 Implementation notes

*Added when scopes 1, 2 and 5 were implemented.*

- **One path.** `internal/WriteDiagnosis.ts` now takes any `Sent` — a write (`SentWrite`), a
  read (`SentRead`, the `Query` / `Scan` input as sent) or a table-management request
  (`SentTable`, its vector indexes) — through one `diagnoseRejection` / `diagnoseFailure`.
  `diagnoseFailure` gains `only`: a site whose conditional mapping may retry wraps its
  request twice, `only: ["RepeatedItem"]` before the mapping and the full diagnosis after it
  (`Transaction.transactWrite`, `EventStore.append`, the `Aggregate` root guard).
  `diagnoseWriteFailure` is renamed `diagnoseRejection`. The expression limits and
  `countOperators` move to `internal/ExpressionLimits.ts` (`Entity.countOperators` is
  re-exported for its tests); `expressionFits` also respects the 100-operand `IN` limit.
- **Read diagnosis scope.** Every `Query` / `Scan` diagnoses a consistent read of a GSI
  (C7). The key-bound rules (P7, P8) are diagnosed only for queries that ask
  (`Query.make({ keyConditionDiagnosis })`), which today is the stream-index query behind
  `readIndex` and `query.index`; other queries pass those rejections through, as S29 left
  them. `QueryState.globalIndex` is removed (it fed only the old pre-check), so an entity
  index pointed at an LSI of a table created outside the library now reads consistently,
  as DynamoDB allows.
- **Not converted, pending a decision:** D1 (EDD-9030), D2 (EDD-9042), D3 (`clampTopK`) and
  `isIn([])` (S12, S13, S15, S17) are unchanged.
- **Examples (S31).** The rejection handler is dropped from all 32 examples, the 16 MDX
  snippets that show it, and `effect-dynamodb-geo/examples/vehicle-tracking.ts`. The lines
  sit inside `#region`s in 27 of them, not outside as §6A.7 assumed, so the MDX moved with
  them. Two examples had been failing unseen: `hr.ts` asserted that a partial GSI update
  fails (it has not since the per-half index policy) and `guide-advanced.ts` expected
  versions one behind. Both are fixed, with their tutorials.
- **Docs.** The converted checks are described as diagnosed in DESIGN.md (§ Write Limits and
  Request Rules, the vector-index limits table, the error taxonomy, the stream-index section)
  and in the guides, tutorials and API reference that described them as pre-checks. The
  measured size model is published as "How DynamoDB Sizes Items" in
  `guides/data-integrity.mdx`, linked from the API reference's Batch and write-limit
  passages and the batch tutorial.

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
  - `handler-event-metadata` — `commandHandler` minting a ULID per event through the
    `Crypto` service, idempotent against redelivery (§4.3).
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
| 11 | 100-item check: `Aggregate` groups, checked up front across all groups | **Converted** (§6A.4a) — the up-front loop is removed; each group's rejection is diagnosed and names the groups already committed. Supersedes "kept — open" | user |
| 12 | `EventStore` 1024-byte stream-index sort-key check (append path) | **Converted**; of the non-empty-string check on the same result, the empty-string half is now converted too (§6A.5 C8, §6A.9 S16) and the type half stays | user |
| 13 | `readIndex` `beginsWith` / `between` validation | **Converted** (§6A.4d) — empty value and reversed `between` diagnosed from DynamoDB's rejection; the one-of, type and `limit` checks stay (§6A.9 S9) | user |
| 14 | Diagnosis at every single-item, `TransactWriteItems` and `BatchWriteItem` site (§6.5) | **In** | user |
| 15 | No public error union widened; `AppendTooLarge` / `TransactionOverflow` / `AggregateTransactionOverflow` gain an optional `cause` | **In** — additive fields, so DynamoDB's error can be kept as cause | design — please confirm |
| 16 | `Entity` expression limits (4 KB / 300 operators on a condition — `oversizedCondition`) | **Converted** (§6A.4c) — wordings observed (§6A.1 P3–P5); `expressionFits` strategies kept | user |
| 17 | Partition key over 2048 bytes | **Not diagnosed in this PR** — no pre-check existed; one more recogniser in the module when wanted | design — candidate |
| 18 | `Table.definition` vector-index limits | **Converted** (§6A.4e), with their `Entity.make` twins — recognised from AWS's quotas, unit tests only (Local has no vector indexes). Supersedes "kept" | user |
| 19 | `Batch` chunking (25 / 100 / 3.5 MB) | **Kept as chunking, budget changed**: versioned-put transactions split at exactly 4,194,304 bytes / 100 items by the exact size model; a mismatch is returned diagnosed, never re-split (§6A.3) | user |
| 20 | Own invariants and misdiagnosis guards (`refuseRepeatedItems`, empty-part conditions, option-shape checks) | **Kept**, except `refuseRepeatedItems`, now **converted** to a failure-time `RepeatedItem` diagnosis placed before the conditional mapping (§6A.4b) | user |
| 21 | Stream-index projection (item 5 of the review) | **Deferred — pending your decision**; `Table.ts` projections untouched | user |
| 22 | Returning metadata / timestamps from `append` / the handler | **Out** (§7.4) | design |
| 23 | `Aggregate` delete's `BatchWriteItem` | **Not diagnosed** — deletes of stored keys cannot meet these limits, and `delete`'s error union has no `ValidationError`; wrapping it would widen a public union | design — please confirm |
| 24 | Library-wide pre-check sweep, exact size model, examples' exit status | See §6A.9 (S1–S32) | user |
