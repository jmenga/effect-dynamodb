# Design: `headProof: "none"` and the single-item append fast path (#173)

Builds on `eventstore-head-proof.md` (#164) and `stream-seal.md` (#166).

## Problem

Every append after version 0 writes a version-contiguity `ConditionCheck` on the
event at `expectedVersion`:
`attribute_exists(#pk) AND attribute_not_exists(#sealed)`. Inside
`TransactWriteItems`, DynamoDB bills a `ConditionCheck` at 2 WCU per KB of the
checked item, so an append after a large event pays for that event again.

`headProof` (#164) moves the proof to an item the transaction already writes (a
state record, or the inline snapshot). A caller with no such item has no way to
say "there is no proof item: I own the invariant".

Measured on real DynamoDB (us-east-1, `PAY_PER_REQUEST`,
`--return-consumed-capacity TOTAL`), with the items and conditions of 1.33.0's
append, two runs each with identical results:

| Previous (checked) event | New event | Head check | WCU |
|---|---|---|---|
| 293 KB | 1 KB | with | 590 |
| 293 KB | 1 KB | without | 2 |
| 1 KB | 1 KB | with | 4 |
| 1 KB | 1 KB | without | 2 |

For small events the check doubles an append's write cost. After a large event
it is almost all of it.

The remaining 2 WCU for a lone 1 KB event is the transactional rate. A
`TransactWriteItems` of a single `Put` costs 2 WCU per KB, and a plain `PutItem`
with the same condition costs 1. An append that sends one item doesn't need a
transaction.

The use case: one event per append, `expectedVersion` from a consistent read in
the same request, and the stream sealed only by a separate administrative
transaction (`appendOp` with `seal: true`). There is no snapshot and no state
record to carry the proof.

## Part 1: `headProof: "none"`

```ts
type HeadProof = { readonly additionalItem: number } | "snapshot" | "none"
```

With `"none"`, the append writes no contiguity check and no proof. The event
puts are unchanged. Every other option combines with it as it does today
(`additionalItems`, `idempotency`, `snapshot`, which stays unconditional,
`seal`, metadata, timestamps).

### The contract: the caller takes over both duties of the check

1. **No gap.** `expectedVersion` must never be ahead of the head. An ahead
   version writes past a gap that no later append can fill. Any version read
   from the stream meets this, whether the read was consistent or not.
2. **The seal.** The caller must refuse to append when the last event it read is
   sealed (`StreamEvent.sealed`, `LatestState.seal`). A writer that read the
   sealing event appends at `S`, and with no check its put at `S + 1` lands past
   the seal, which reopens the stream for every writer. A writer that loaded
   before the seal still fails: its first event put lands on the sealing event
   (`ALL_OLD` returns the marked item), and it gets `StreamSealed`.

The event puts' `attribute_not_exists(pk)` still rejects a stale
`expectedVersion` (`VersionConflict`), so a lost race is caught as before.

### Why it is safe for a version read from the stream

The library has no API that deletes an event: there is no stream delete or
purge, and events have no TTL. The head therefore only grows. A version read
from the stream, consistent or not, was the head at some point. It can be stale
(the event puts reject that) but never ahead (only a gap needs the check). The
check adds nothing for such a caller beyond the seal clause, and that is duty 2.

A version from anywhere else (a cache, a client's If-Match, arithmetic) isn't
covered. Those callers keep the check.

### Where it is accepted

| Entry point | `"none"` |
|---|---|
| `EventStream.append` / `BoundEventStream.append` | Accepted |
| `measureAppend` (stream and bound) | Accepted. `transactionBytes` leaves the check out, as for any proof |
| `commandHandler({ headProof })` | Deferred. Excluded from the type (`Exclude<HeadProof, "none">`), and an untyped `"none"` fails every call with `ValidationError` (`EventStore.commandHandler.headProof`) before anything is read or written |
| `appendOp` (`NestedAppendOptions`) | Refused, as every `headProof` is today (type, and `ValidationError` `EventStore.appendOp`) |

The handler is deferred because it reads the stream itself and could meet the
contract for the caller. Whether it should check the seal on its load (it already
does) and accept `"none"` with no further opt-in is a separate decision.

## Part 2: the single-item fast path

When an append's request would hold exactly **one item, and that item is its
one event `Put`** (no contiguity check, no sentinel, no snapshot, no additional
items), the append sends a `PutItem` with the same `Item`, `ConditionExpression`
(`attribute_not_exists(pk)`) and `ReturnValuesOnConditionCheckFailure: ALL_OLD`
instead of a `TransactWriteItems`. One item commits atomically either way, so
the semantics are unchanged at half the cost (1 WCU per KB instead of 2).

It applies to:

- every one-event append at `expectedVersion` 0 with no other items, which is
  the first event of every stream, including through `commandHandler`;
- every one-event `headProof: "none"` append with no other items.

It does not apply to `appendOp`. A nested append always rides in its outer
append's transaction.

### Error mapping

The verdicts are those of the transactional path for the same failure.

| `PutItem` failure | Transactional path, same case | Fast path |
|---|---|---|
| `ConditionalCheckFailedException`, returned item marked sealed | `StreamSealed` (first event put returned a sealed item) | `StreamSealed`, same fields (`sealedVersion` from the item) |
| `ConditionalCheckFailedException`, otherwise | `VersionConflict` | `VersionConflict`, same fields |
| `ValidationException` diagnosed (item over 400 KB, key too long, empty key) | `ValidationError` naming the event (`EventStore.append`, or `EventStore.append.indexes` for a stream-index key) | Same, by the same diagnosis and rewrite |
| Throttling (`ProvisionedThroughputExceededException`, `ThrottlingException`) | `TransactionCancelled` (reason `ThrottlingError`) | `TransactionCancelled`, `operation: "PutItem"`, reason `ThrottlingError` |
| `TransactionConflictException` (item in another transaction) | `TransactionCancelled` (reason `TransactionConflict`) | `TransactionCancelled`, `operation: "PutItem"`, reason `TransactionConflict` |
| `ValidationException` "Type mismatch" (a key, or an index key, of the wrong type) | `TransactionCancelled` (reason `ValidationError`): an item reason in a transaction | `TransactionCancelled`, `operation: "PutItem"`, reason `ValidationError` |
| Anything else (`InternalServerError`, `ResourceNotFoundError`, another undiagnosed validation error, `DynamoError`) | Passed through (the other validation errors are request errors of a one-item transaction too, as observed on DynamoDB Local) | Passed through |

Both verdicts come from the same `streamAppendVerdict` the transaction uses,
fed with the one reason, so they can't drift. The success value is unchanged:
`{ version: expectedVersion + 1, events }`.

The AWS SDK retries a throttled `PutItem` before it fails, as it doesn't for a
cancelled transaction. That is the only observable difference: fewer
throttling failures reach the caller.

## Scoping decisions

| Item | Decision |
|---|---|
| An append option that omits the check (issue proposal) | **In**, as `headProof: "none"` (the name proposed) |
| Caller duty "no gap" | **In**, documented on `HeadProof` and `AppendOptionsBase.headProof` |
| Caller duty "the seal" | **In**, documented. The library doesn't enforce it on a `"none"` append |
| Pre-seal writer fails on its first put | **Changed** from the issue's wording: it is `StreamSealed`, not `VersionConflict`. Since #166 the first put returns the marked item |
| Stale `expectedVersion` still rejected | **In**, unchanged (event puts) |
| `"none"` on `measureAppend` | **In**. No check is counted |
| `"none"` on `commandHandler` | **Out (deferred)**. Excluded from the type, `ValidationError` at runtime |
| `"none"` on `appendOp` | **Out**. Nested appends keep refusing every `headProof` |
| Single-item `PutItem` fast path | **Added** (owner decision). Covers one-event appends at version 0 and one-event `"none"` appends |
| Fast path for `appendOp` | **Out**. A nested append is always part of a transaction |
| Fast path telemetry or opt-out | **Out**. Same semantics and same errors, so there is nothing to opt out of |
| `AppendMeasurement` reporting which request is sent | **Out**. `transactionBytes` keeps its meaning (the stream's share of a `TransactWriteItems`) |
| New error codes | **None** needed |
| Changing the default | **Out**. Without `headProof` the check is written as before |
