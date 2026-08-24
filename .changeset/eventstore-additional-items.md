---
"effect-dynamodb": minor
"@effect-dynamodb/schema": minor
"@effect-dynamodb/geo": minor
"@effect-dynamodb/language-service": minor
---

EventStore: additional transaction items in `append` + command idempotency (closes #85)

**`append(streamId, events, expectedVersion, { additionalItems })`** — commit caller-owned
transact items atomically with the event puts. `additionalItems` accepts the same op union
`Transaction.transactWrite` takes (`Entity.put`, `Entity.delete`, `Transaction.check`),
compiled through a new shared builder so the two APIs cannot drift. `EntityUpdate` remains
unsupported in both; it will land for both at once.

**Position-aware cancellation mapping.** Previously *any* `ConditionalCheckFailed` in
`CancellationReasons` became `VersionConflict` — which, with caller-owned items in the
transaction, would misreport a failed user condition and send callers into a
read-decide-retry loop that could never succeed. Reasons are now matched by transaction
index, with precedence `DuplicateCommand` > `VersionConflict` >
`AdditionalItemConditionFailed` > `TransactionCancelled`.

**Command idempotency.** `commandHandler(decider, stream, { idempotency: { ttl? } })` plus a
per-call `commandId` writes a dedup sentinel guarded by `attribute_not_exists` into the same
transaction, co-located in the stream partition and invisible to `read` / `readFrom` /
`currentVersion`. A replayed `commandId` is rejected with `DuplicateCommand`. Without
`idempotency`, command processing remains **at-least-once** — now documented in the tutorial.
Configuring `idempotency` makes `commandId` required at the type level.

**Transaction size guard.** `events + additionalItems + sentinel + the version-contiguity
ConditionCheck` is checked against the shared `TRANSACT_WRITE_ITEMS_LIMIT` (100) before any
AWS call, failing with `AppendTooLarge`.

New tagged errors: `AdditionalItemConditionFailed`, `DuplicateCommand` (both exported from
`effect-dynamodb` and `@effect-dynamodb/schema`).

Also fixes the data-last (pipeable) form of `EventStore.commandHandler`, which passed the
stream and decider to the implementation in swapped order and could never have worked.

**Type-level note:** `append`'s error channel now unconditionally includes
`DuplicateCommand | AdditionalItemConditionFailed | AppendTooLarge`, rather than varying
with the options passed. `Effect.catchTag` / `catchTags` callers are unaffected; a caller
exhaustively matching on `append`'s error union will need three more cases.
