# Design: per-event metadata and timestamps on `EventStore.append` and `commandHandler`

**Issue:** [#144](https://github.com/jmenga/effect-dynamodb/issues/144)
**Status:** Designed → implemented in the same PR (single-PR workflow — this doc is commit 1).
**Affected packages:** `packages/effect-dynamodb` (EventStore, internal/TransactWriteOps), docs
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
(§7), sets each event's `timestamp`. When none is given, behaviour is unchanged. The read side is unchanged: `StreamEvent.metadata` already decodes each item's
own `metadata` attribute.

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

- **Item count** (`AppendTooLarge`) — unchanged; metadata adds no items.
- **4 MB per transaction** (`refuseOversizedTransaction` → `ValidationError`) — measures
  the built items, so each item is counted with its own entry and no change is needed.
  This is where the quadratic growth stops costing capacity: N entries total instead of N².
- **400 KB per item** — see §6.

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
rather than inferring a union. The handler types grow accordingly:

```ts
type CommandHandler<…> = <E2 = never, R2 = never, E3 = never, R3 = never>(
  streamId, command, ...options: CommandOptionsArgs<TMetadata, TConfig, State, TEvent, E2, R2, E3, R3>
) => Effect.Effect<
  CommandHandlerResult<State, TEvent>,
  CommandHandlerErrors<E> | E2 | E3,
  DynamoClient | TableConfig | R2 | R3
>
```

`BoundCommandHandler` mirrors it with `R2 | R3`. `IdempotentCommandOptions` becomes
`CommandOptions & { readonly commandId: string }`.

**Inference risk.** Moving `CommandOptions` to an intersection-with-union could degrade
inference of `E2`/`R2`/`E3`/`R3` from the call's options object. `EventStore.types.test.ts`
pins it (§8.3). If inference cannot be made to hold, the fallback is a plain interface with
both members optional and runtime-only exclusivity, documented as such — the runtime check
exists either way.

### 4.2 When it runs

Inside `commit`, step 6, next to `additionalItems`:

- after `decide`, after the new events are folded — it receives the same `Decision`
  (`events`, `state`, `previous`, `version`) `additionalItems` does;
- **not** called for a no-op decision (no events, no append);
- evaluated **before** `additionalItems` (it concerns the events, which precede the
  additional items in the transaction; the order is documented so an effectful pair is
  predictable);
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

## 6. Adjacent debt: no client-side 400 KB item check

`refuseOversizedTransaction` checks the 4 MB aggregate but not DynamoDB's 400 KB per-item
limit. An oversized item is sent and rejected by DynamoDB with a bare `ValidationException`
naming neither the item nor the cause. The issue's large-metadata scenario is exactly how a
caller hits it, and `transactItemBytes` already computes each item's size in the same loop.

**Proposed (in scope under the fix-adjacent-debt rule):** in the same pass, refuse any item
over 409,600 bytes with `ValidationError` naming the item's `source` and key, before
anything is sent. It is a lower bound by DynamoDB's size rules, so it never refuses an item
DynamoDB would accept. Because the helper is shared, `Transaction.transactWrite` gains the
check too — an error-message improvement only (the same call already failed). If you'd
rather keep this PR to #144, it splits cleanly into its own issue.

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
- Independent of `metadata` / `eventMetadata`: any combination is allowed.
- Checked with the metadata checks, before the zero-event fast path: a length that differs
  from `events.length`, or an entry that is neither a `DateTime` nor `undefined`, fails with
  `ValidationError` (`operation: "EventStore.append.eventTimestamps"`) before anything is
  written.
- Only the event items change. The idempotency sentinel, its TTL and the inline snapshot
  keep `now`: they record when the append was written.
- No ordering constraint. `version` orders a stream; timestamps may repeat, run backwards or
  lie in the future, as imported history can.

### 7.2 `commandHandler`

```ts
yield* handle(streamId, command, {
  eventTimestamps: ({ events }) => events.map((event) => event.occurredAt),
})
```

- A function of the `Decision`, returning the array. **Plain return only** — no `Effect`
  form, so no third pair of handler type parameters. The values come from the command or
  the events; the effectful source of a time, the `Clock`, is already the default.
- Evaluated after `eventMetadata` and before `additionalItems`, with the same rules: not
  called on a no-op, re-run on every attempt and on the unverified-snapshot re-decision.
- A wrong-length or malformed result fails with `ValidationError`
  (`operation: "EventStore.commandHandler.eventTimestamps"`), not retried. A non-function
  value is refused before anything is read.

### 7.3 Types

`eventTimestamps` lives on `AppendOptionsBase` and `CommandOptionsBase`, outside the
exclusive metadata union. No new type parameters; no error union widens.

### 7.4 Out of scope

- **Returning metadata or timestamps from `append` / the handler.** `AppendResult.events`
  and `CommandHandlerResult.events` stay domain events; the caller already holds what it
  passed.

---

## 8. Testing

### 8.1 Unit (`test/EventStore.test.ts`)

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
- §6: an item over 400 KB → `ValidationError` before send, for both `append` and
  `Transaction.transactWrite`
- §7 `append`: entry `i` written as item `i`'s `timestamp` (ISO, UTC); `undefined` keeps
  `now`; a zoned `DateTime` is stored as its UTC instant; length mismatch and a non-`DateTime`
  entry → `ValidationError`, no AWS call, also on a zero-event append; combined with
  `eventMetadata`; sentinel and inline snapshot keep `now`; out-of-order timestamps accepted
- §7 `commandHandler`: receives the `Decision`; runs after `eventMetadata` and before
  `additionalItems`; not called on a no-op; re-run on retry; bad result → `ValidationError`
  named for the handler, not retried; non-function refused before read

### 8.2 Connected (`test/connected.test.ts`, mandatory per CLAUDE.md)

- append three events with three different entries; `read` returns each event's own entry
- a stream index read returns per-event entries
- `commandHandler` with a function-form `eventMetadata` against DynamoDB Local, read back
- an append whose shared-list equivalent would exceed 4 MB succeeds with `eventMetadata`
  (the motivating size scenario, end to end)
- §7: an imported append with `eventTimestamps` reads back each event's own `timestamp`;
  the same through `commandHandler`

### 8.3 Types (`test/EventStore.types.test.ts`)

- passing both `metadata` and `eventMetadata` is a type error, on `append` and the handler
- `eventMetadata` entries are typed `M | undefined` against the stream's schema type
- `E3` / `R3` inferred from an `Effect`-returning `eventMetadata`, alongside an
  `additionalItems` with a *different* error type (`E2`) — both appear in the handler's
  error channel
- idempotent handler still requires `commandId` with `eventMetadata` present
- §7: `eventTimestamps` entries typed `DateTime.DateTime | undefined`; accepted alongside
  either metadata option; the handler function must return an array (an `Effect` is a type
  error)

---

## 9. Semver and compatibility

`minor`. Additive at runtime: no option combination that works today changes behaviour.

Type-level notes for the changeset:

- `AppendOptions`, `CommandOptions` and `IdempotentCommandOptions` move from `interface` to
  `type` alias. Usage as a type is unchanged; an `interface X extends AppendOptions<…>` in
  user code would stop compiling (an interface cannot extend a union). Unlikely, and called
  out.
- `CommandHandler` / `BoundCommandHandler` gain two defaulted type parameters (`E3`, `R3`).
  Call sites infer them; hand-written instantiations with positional arguments keep working
  because the new parameters are trailing and defaulted.
- `ValidationError` was already in both error channels; no error union widens.

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
  time with `eventTimestamps` (§7), in place of pinning the clock per chunk.
- **API reference** (`reference/api-reference.mdx`): the `append` row and the
  `commandHandler` per-call options gain `eventMetadata`; mutual exclusivity stated.
- **JSDoc**: `AppendOptions.metadata` loses "Per-append" as its only description and points
  at `eventMetadata`; `CommandOptions.eventMetadata` documents §4.2's evaluation order and
  re-run rules.
