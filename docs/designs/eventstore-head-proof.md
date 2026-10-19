# Design: a head proof in place of the contiguity check, and `commandHandler` `loadState` (#164)

Builds on `eventstore-command-path.md`, `eventstore-additional-items.md` and
`eventstore-snapshots.md`.

## Problem

Every append after version 0 writes a version-contiguity `ConditionCheck` on the
event at `expectedVersion`. Inside `TransactWriteItems`, DynamoDB bills a
`ConditionCheck` at 2 WCU per KB of the checked item. A stream with large
events therefore pays to re-read its previous event on every append, though the
check only tests that the event exists. With a ~13 KB event, that's 26 WCU per
append.

The transaction often already holds an item that proves the head:

- a **state record** the caller keeps for the aggregate, written in every
  append and conditioned on the version the caller loaded;
- the **inline snapshot**, written in every append on a `mode: "inline"` stream
  without `every`. Today its `Put` is unconditional, so it proves nothing.

A second gap is that `commandHandler` loads state only from the stream. An
application whose state lives in its own record has to write the
load–decide–append cycle by hand.

## Why the check exists

The event puts' `attribute_not_exists(pk)` rejects a stale `expectedVersion`:
the slot at `expectedVersion + 1` is taken. An `expectedVersion` that is ahead
of the head would write past a gap. The check rules that out by requiring the
event at `expectedVersion` to exist.

An item whose own condition holds only when the stream is at `expectedVersion`
proves the head is at least `expectedVersion`. The event put at
`expectedVersion + 1` proves it is at most that. Together they prove it is
exactly `expectedVersion`, which is all the check adds.

## Part 1: `append({ headProof })`

```ts
type HeadProof = { readonly additionalItem: number } | "snapshot"

interface AppendOptionsBase<TState> {
  readonly headProof?: HeadProof | undefined
}
```

Without `headProof`, the check is written exactly as before. With it, no
`ConditionCheck` is written.

### `{ additionalItem: n }`

`additionalItems[n]` is the proof.

- It must carry a condition of its own (`.condition()`, `create()` or
  `Transaction.check`). One without a condition fails with `ValidationError`,
  because it proves nothing and would silently remove the gap protection. A
  guarded put's internal read guard doesn't count: it is conditioned on what it
  read at append time, not on the version the caller loaded.
- An `n` that isn't a non-negative integer, or that is out of range, fails with
  `ValidationError` before anything is written.
- When op `n`'s own condition fails, the append fails with `VersionConflict`,
  never `AdditionalItemConditionFailed`. A guarded put (a versioned or unique
  entity) is judged through its plan verdict, so a race it loses is still
  written again.
- **Precedence:** `DuplicateCommand`, then the event puts (`VersionConflict`),
  then the proof (`VersionConflict`), then the other additional items.

**The caller's contract.** The library can't see other writers.

- Every writer of the stream must write the record, conditioned the same way,
  in the same transaction as its events. That includes the handler, imports,
  migrations and a raw `append`.
- A writer that appends without the record leaves the record behind the head.
  Every later append then fails its event put, and the result is a
  `VersionConflict` loop on that stream, not a gap.
- A record written with a version but without its events moves the record
  ahead of the head. That is the one way to open a gap, so never write the
  record's version anywhere but in the append of those events.

### `"snapshot"`

The inline snapshot is the proof.

- Requires the `snapshot` option on the same append (`ValidationError`
  otherwise).
- Accepted only on a stream whose snapshot config is `mode: "inline"` without
  `every`. Any other config dies with `[EDD-9085]`, as `verifySnapshot: false`
  dies with `[EDD-9068]`.
- The snapshot `Put` is conditioned on `asOfVersion = :expected`
  (`attribute_not_exists(pk)` at 0). A failure at its position is a
  `VersionConflict`; without the proof it is a `TransactionCancelled`.
- A snapshot can lag the head (a raw `append`, data written before inline mode).
  A lagging snapshot fails the condition, so the append conflicts rather than
  gaps. The caller should use the proof only when it knows the snapshot is at
  the head; `commandHandler` does this for you.
- The proof relies on a snapshot's `asOfVersion` being a version that was
  written. That is always true of inline snapshots, and true of `writeSnapshot`
  at a real version.

### `measureAppend`

`measureAppend` accepts `headProof`. With a proof, `transactionBytes` leaves the
check out. With `"snapshot"`, it also counts the snapshot's condition. It
doesn't take `additionalItems`, so `n` is checked only for shape.

## Part 2: `commandHandler`

Both new options are handler options.

```ts
interface CommandHandlerOptions<State, EL, RL> {
  readonly loadState?: (
    streamId: StreamIdInput<...>,
  ) => Effect<Option<{ readonly state: State; readonly version: number }>, EL, RL>
  readonly headProof?: HeadProof | undefined
}
```

### `loadState`

It replaces the stream load.

- `None` means a new stream: initial state at version 0.
- A version that isn't a non-negative integer fails with `ValidationError`
  (`operation: "EventStore.commandHandler.loadState"`), not retried.
- The rest of the cycle is unchanged: the If-Match check against the loaded
  version, `decide`, `evolve`, the derived items and the append.
- A `VersionConflict` re-runs `loadState` under the `retry` policy.
- A no-op decision, or a `decide` failure, is answered from the record without
  reading the stream head. The handler trusts the record.
- `EL` and `RL` join the handler's error and requirement channels. On a
  `BoundEventStream` handler, `RL` is the handler's only requirement.
- Without `headProof`, the append still writes the check, so a stale or ahead
  record conflicts instead of opening a gap.
- `loadState` must read strongly consistent. An eventually consistent read can
  return a record behind the head. The append then fails and retries without
  corrupting anything, but it costs retries.
- **Snapshots.** On an inline stream without `every`, the snapshot is still
  written in every append. With `every` (inline or after-append), the handler
  doesn't know the snapshot's version, so a snapshot is written when the
  append crosses a multiple of `every`.

### `headProof`

- `{ additionalItem: n }` is passed to every append the handler makes. A call
  whose decision appends must return `additionalItems` with an index `n`;
  `append`'s checks then apply.
- `"snapshot"` is applied per attempt, only when the load found the snapshot
  at the head (the loaded version equals the snapshot's `asOfVersion`; an
  unverified load counts). Otherwise that attempt writes the check. A conflict
  goes through the existing stale-snapshot re-decision and the retry policy.
- `"snapshot"` on a stream that isn't `mode: "inline"` without `every` throws
  `[EDD-9085]` at construction.

### Refused at construction (`[EDD-9085]`)

- `loadState` with `verifySnapshot: false`: there is no stream load to skip.
- `loadState` with `headProof: "snapshot"`: the handler never reads the
  snapshot, so it can't know the snapshot is at the head.

## Not in scope

- Changing the default. Without `headProof`, every append keeps its check.
- Verifying that a caller's record is written by every writer.
- A per-stream head marker as a smaller check target.
- `every` and after-append snapshots as a proof. Neither keeps the snapshot at
  the head.
