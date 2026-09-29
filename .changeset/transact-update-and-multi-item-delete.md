---
"effect-dynamodb": minor
---

`Transaction.transactWrite` accepts `update` / `patch`, and deletes of entities with `unique`, `versioned: { retain: true }` or `softDelete`

Both used to be refused with a `ValidationError` (a delete of those entities with
**EDD-9048**), which left no way to commit an update — or a constraint-safe
delete — atomically with anything else. A typical casualty is an audit or outbox
row that must be written if and only if the business change is.

They now write exactly what the same op writes on its own. The extra items a
multi-item delete needs (sentinel releases, the retain snapshot, the soft-delete
tombstone), and the read-merge-`Put` plus sentinel rotation an update touching a
`unique` field needs, derive from the **stored** row, so `transactWrite` reads
each such row first — the same read the standalone op makes — by running the
entity's own op in plan mode. A plain update needs no read and compiles to a
single `Update` item.

The read is guarded: the op's main item carries a condition on what was read
(the version on a versioned entity, otherwise every `unique` field), so a row
changed between the read and the write cancels the transaction instead of
orphaning a sentinel.

`transactWrite`'s error channel gains the read's outcomes — `ItemNotFound`,
`OptimisticLockError` (a stale `expectedVersion`) and `RefNotFound` — surfaced
before anything is sent. Updates with `.cascade(...)` or `.returnValues(...)`, and
updates of entities with `vectorIndexes`, are refused with a `ValidationError`
naming the feature.

`EventStore.append({ additionalItems })` and `Batch.write` are unchanged: they run
no read, so they keep rejecting these deletes, and neither accepts `update` at the
type level (the new `TransactWriteUpdateOp` is `transactWrite`-only).
