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
entity's own prepare step. A plain update compiles to a single `Update` item and
reads only where the standalone update does (`clearMap`, ref hydration).

The read is guarded: the op's main item carries a condition on what was read —
that the row still exists, plus the version on a versioned entity, otherwise
every `unique` field — so a row changed or deleted between the read and the
write cancels the transaction instead of orphaning a sentinel, writing a second
tombstone or re-creating the row. A transaction whose updates all resolve to no
write sends nothing, as the standalone no-op update does.

`transactWrite`'s error channel gains the read's outcomes — `ItemNotFound`,
`OptimisticLockError` (a stale `expectedVersion`) and `RefNotFound` — surfaced
before anything is sent. A transaction refuses, with a `ValidationError`, an
update `.cascade(...)` (**EDD-9056**), `.returnValues(...)` on an update or a
delete (**EDD-9057**), and an update of an entity with `vectorIndexes`
(**EDD-9058**). A delete's `.returnValues(...)` used to be dropped silently by
`transactWrite` and `EventStore.append({ additionalItems })`; both now refuse it.

`EventStore.append({ additionalItems })` and `Batch.write` are unchanged: they run
no read, so they keep rejecting these deletes, and neither accepts `update` at the
type level (the new `TransactWriteUpdateOp` is `transactWrite`-only).
