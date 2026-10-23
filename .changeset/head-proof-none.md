---
"effect-dynamodb": minor
"@effect-dynamodb/schema": minor
"@effect-dynamodb/geo": minor
"@effect-dynamodb/language-service": minor
---

EventStore: `append({ headProof: "none" })` lets a caller that already guarantees the stream head skip the version-contiguity `ConditionCheck` and write no proof item. The check is billed at 2 WCU per KB of the previous event, so skipping it can remove most of an append's write cost. The caller takes over both of the check's duties. First, `expectedVersion` must never be ahead of the head; the version of any event read from the stream meets this. Second, the caller must refuse to append when the last event it read is sealed. The event puts still reject a stale `expectedVersion` with `VersionConflict`. `append` and `measureAppend` accept `"none"`. `commandHandler` (excluded from its type, and a `ValidationError` at runtime) and a nested `appendOp` refuse it.

An append whose request is exactly one item, its one event, is now sent as a conditional `PutItem` instead of a `TransactWriteItems`, at half the write cost. That covers the first event of every stream and one-event `"none"` appends. It has the same atomicity, result and errors: `StreamSealed`, `VersionConflict`, a diagnosed `ValidationError`, or `TransactionCancelled` (`operation: "PutItem"`) with the reason a transaction gives its item. The event carries a random write token (`__edd_wt__`, 42 bytes). If the AWS SDK resends a put that committed but lost its response, the resend recognises the event as its own and succeeds, as a transaction's idempotent retry does.
