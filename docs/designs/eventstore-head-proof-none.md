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
   version writes past a gap that no later append can fill. The version of any
   event read from the stream meets this, whether the read was consistent or
   not (see below for which reads qualify).
2. **The seal.** The caller must refuse to append when the last event it read is
   sealed (`StreamEvent.sealed`, `LatestState.seal`). A writer that read the
   sealing event appends at `S`, and with no check its put at `S + 1` lands past
   the seal, which reopens the stream for every writer. A writer that read the
   head just before a one-event seal (`expectedVersion = S - 1`) still fails:
   its first event put lands on the sealing event (`ALL_OLD` returns the marked
   item), and it gets `StreamSealed`. A writer further behind, or just before a
   seal of several events (whose earlier events are unmarked), lands on an
   unmarked event and gets `VersionConflict`; it must apply this duty to what it
   reads when it reloads.

The event puts' `attribute_not_exists(pk)` still rejects a stale
`expectedVersion` (`VersionConflict`), so a lost race is caught as before.

### Why it is safe for a version read from the stream

The library has no API that deletes an event: there is no stream delete or
purge, and events have no TTL. The head therefore only grows. The version of an
event read from the stream, consistent or not, was the head at some point. It
can be stale (the event puts reject that) but never ahead (only a gap needs the
check). The check adds nothing for such a caller beyond the seal clause, and
that is duty 2.

Which reads give an event's version: `read`, `readFrom`, `currentVersion`, and
`readLatest` on a stream without a snapshot config. `readLatest` with a snapshot
can return the snapshot's `asOfVersion` (the verified read when no event follows
it, and `verifySnapshot: false`). `writeSnapshot` accepts any `asOfVersion`
above the stored one without checking that its event exists, so that version is
only as sound as the `writeSnapshot` callers: a snapshot written ahead of the
head makes a `"none"` append at its version write past a gap. The tutorial's
example therefore reads the head with `read`.

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
instead of a `TransactWriteItems`. One item commits atomically either way, at
half the cost (1 WCU per KB instead of 2). The item also carries a write token
(below), so that the two requests behave the same under the SDK's retries.

It applies to:

- every one-event append at `expectedVersion` 0 with no other items, which is
  the first event of every stream, including through `commandHandler`;
- every one-event `headProof: "none"` append with no other items.

It does not apply to `appendOp`. A nested append always rides in its outer
append's transaction.

### Retry idempotency: the write token

The AWS SDK fills `TransactWriteItems.ClientRequestToken` itself (the member is
an idempotency token in the service model, and the JSON codec generates it when
the request is serialized, once, so the SDK's retries reuse it). DynamoDB
answers a resend of a committed transaction with the same token with success.
A `PutItem` has no such token. Without one, a conditional `PutItem` that commits
but loses its response (a timeout, a reset connection, a 5xx after the commit)
is resent by the SDK's standard retry, fails its own `attribute_not_exists(pk)`,
and `ALL_OLD` returns the writer's own event. That would be reported as
`VersionConflict` (or `StreamSealed` for a sealing event), and a
`commandHandler({ retry })` would reload, decide again and append a duplicate
event.

So the fast path writes a token of its own: `__edd_wt__`, 128 random bits (32
hex digits) from `globalThis.crypto.getRandomValues`, fresh for each `append`
call. A failed condition whose `ALL_OLD` item carries this call's token is this
call's own commit, and the append succeeds with its normal result. Any other
returned item, including one byte for byte the same apart from its token (two
writers' identical deposits at the same millisecond), is judged as before.
Comparing content instead of a token would treat that case as success and lose
the second deposit.

Costs and visibility: 42 bytes on the item (`__edd_wt__` plus 32 characters),
on fast-path events only (a transaction's events don't need it). It is a
stream-owned attribute (an index attribute may not use the name), readers
ignore it, and the `withoutMetadata` stream-index projection doesn't include it.
`measureAppend` counts it (a placeholder of the same length) when the append
would take the fast path. A caller-level retry (a new `append` call) gets a new
token, so it reports `VersionConflict` as a new transaction would.

### Error mapping

The verdicts are those of the transactional path for the same failure.

| `PutItem` failure | Transactional path, same case | Fast path |
|---|---|---|
| `ConditionalCheckFailedException`, returned item marked sealed | `StreamSealed` (first event put returned a sealed item) | `StreamSealed`, same fields (`sealedVersion` from the item) |
| `ConditionalCheckFailedException`, otherwise | `VersionConflict` | `VersionConflict`, same fields |
| `ValidationException` diagnosed (item over 400 KB, key too long, empty key) | `ValidationError` naming the event (`EventStore.append`, or `EventStore.append.indexes` for a stream-index key) | Same, by the same diagnosis and rewrite |
| `ConditionalCheckFailedException`, returned item carries this call's write token | Success (the SDK's resend reuses the transaction's `ClientRequestToken`) | Success, `{ version: expectedVersion + 1, events }` |
| `ProvisionedThroughputExceededException` (a provisioned table) | `TransactionCancelled` (reason `ProvisionedThroughputExceeded`) | `TransactionCancelled`, `operation: "PutItem"`, reason `ProvisionedThroughputExceeded` |
| `ThrottlingException` | `TransactionCancelled` (reason `ThrottlingError`) | `TransactionCancelled`, `operation: "PutItem"`, reason `ThrottlingError` |
| `ItemCollectionSizeLimitExceededException` (an LSI's 10 GB item collection; stream indexes are LSIs by default) | `TransactionCancelled` (reason `ItemCollectionSizeLimitExceeded`) | `TransactionCancelled`, `operation: "PutItem"`, reason `ItemCollectionSizeLimitExceeded` |
| `TransactionConflictException` (item in another transaction) | `TransactionCancelled` (reason `TransactionConflict`) | `TransactionCancelled`, `operation: "PutItem"`, reason `TransactionConflict` |
| `ValidationException` "Type mismatch" (a key, or an index key, of the wrong type) | `TransactionCancelled` (reason `ValidationError`): an item reason in a transaction | `TransactionCancelled`, `operation: "PutItem"`, reason `ValidationError` |
| Anything else (`InternalServerError`, `ResourceNotFoundError`, another undiagnosed validation error, `DynamoError`) | Passed through (the other validation errors are request errors of a one-item transaction too, as observed on DynamoDB Local) | Passed through |

Both verdicts come from the same `streamAppendVerdict` the transaction uses,
fed with the one reason, so they can't drift. The success value is unchanged:
`{ version: expectedVersion + 1, events }`.

The AWS SDK retries a throttled `PutItem` before it fails, as it doesn't for a
cancelled transaction. Fewer throttling failures reach the caller, and the
fast-path event carries its write token; those are the observable differences.

## Scoping decisions

| Item | Decision |
|---|---|
| An append option that omits the check (issue proposal) | **In**, as `headProof: "none"` (the name proposed) |
| Caller duty "no gap" | **In**, documented on `HeadProof` and `AppendOptionsBase.headProof`. **Changed** from the issue's "a consistent read": any read of an event's version qualifies; a snapshot's `asOfVersion` does not by itself (review) |
| Caller duty "the seal" | **In**, documented. The library doesn't enforce it on a `"none"` append |
| Pre-seal writer fails on its first put | **Changed** from the issue's wording: a writer just before a one-event seal gets `StreamSealed`, not `VersionConflict` (since #166 the first put returns the marked item). One further behind, or before a seal of several events, gets `VersionConflict` (review) |
| Stale `expectedVersion` still rejected | **In**, unchanged (event puts) |
| `"none"` on `measureAppend` | **In**. No check is counted |
| `"none"` on `commandHandler` | **Out (deferred)**. Excluded from the type, `ValidationError` at runtime |
| `"none"` on `appendOp` | **Out**. Nested appends keep refusing every `headProof` |
| Single-item `PutItem` fast path | **Added** (owner decision). Covers one-event appends at version 0 and one-event `"none"` appends |
| Fast path for `appendOp` | **Out**. A nested append is always part of a transaction |
| Fast path telemetry or opt-out | **Out**. Same semantics, same errors and the same retry behaviour, so there is nothing to opt out of |
| Fast-path retry idempotency | **Added** (review). A per-call write token on the `PutItem` event; a resend that finds its own token succeeds, as the transaction's idempotent retry does |
| `AppendMeasurement` reporting which request is sent | **Out**. `transactionBytes` keeps its meaning (the stream's share of a `TransactWriteItems`) |
| New error codes | **None** needed |
| Changing the default | **Out**. Without `headProof` the check is written as before |
