---
"effect-dynamodb": minor
"@effect-dynamodb/schema": minor
---

EventStore command-path extensions: consistent reads, If-Match expected versions, inline projections, inline snapshots with single-request loads, opt-in chunked appends and stream indexes (#136, #137, #138, #139, #140, #141)

Everything is additive. Two defaults of `commandHandler` change, and neither
changes a successful result: it now loads state with strongly consistent reads
(#139), and it folds the new events into state **before** appending them (#137).

- **Consistent reads (#139).** `read`, `readFrom`, `currentVersion` and the new
  `readLatest` take `{ consistentRead?: boolean }`, which sets `ConsistentRead`
  on every `Query` page. `commandHandler` loads strongly consistently by
  default, so `decide` no longer runs against state missing the newest events;
  `commandHandler(decider, stream, { consistentRead: false })` opts out.
- **If-Match expected versions (#136).** `handle(streamId, command, { expectedVersion })`
  fails with `VersionConflict` **before `decide` runs** when the loaded version
  differs, and otherwise conditions the append on it. Neither conflict is
  retried, whatever the handler's `retry` says. `VersionConflict` gains an
  optional `actualVersion`, set by the pre-decide check (the loaded version) for
  a useful `412`. With `idempotency`, a redelivered command that already
  committed is reported as `DuplicateCommand`, not `VersionConflict`. A value
  that is not a non-negative integer fails with `ValidationError`.
- **Inline projections (#137).** A command handler's `additionalItems` may be a
  function of the `Decision` (`{ events, state, previous, version }`) returning
  transact ops, or an `Effect` of them whose error and requirements join the
  handler's. The items commit in the same transaction as the events, and the
  function is re-run on every retry. The state the handler returns, snapshots
  and projects is always the `evolve` fold of the stored and new events. `evolve`
  may mutate state in place; when it does, `previous` and `state` are the same
  object.
- **Inline snapshots and `readLatest` (#138).** `snapshot: { schema, mode: "inline" }`
  writes the snapshot in the append's own transaction (every append, or at an
  `every` cadence), so it is current after every command; `append` also accepts
  `{ snapshot: state }` directly. `stream.readLatest(streamId)` returns the
  snapshot, the events after it and the head version in one `Query` when the
  snapshot is current, and `commandHandler` now loads every snapshot-configured
  stream this way. On an `"after-append"` stream with a large `every`, a load
  reads up to `every + 1` items in exchange for fewer requests.
- **Chunked appends (#141).** `{ chunked: true }` on `append`, per handler call
  or as a handler default splits an append too large for one transaction into
  several, written in order at successive versions. **A chunked append is not
  atomic**: readers can observe a prefix of its events, and a failure after the
  first transaction surfaces as the new `PartialAppend` error
  (`committedVersion`, `intendedVersion`, `cause`), which `commandHandler` never
  retries. The first transaction decides concurrency and, with idempotency,
  claims the command, so a redelivery is never applied twice; the final one
  carries `additionalItems`, the inline snapshot and the completed sentinel. An
  append that fits one transaction is written exactly as before. Without
  `chunked`, an oversized append still fails with `AppendTooLarge`.
- **Stream indexes (#140).** `makeStream({ indexes })` declares sub-streams of a
  stream's events ordered by a key derived from each event, on an LSI (default,
  strongly consistent) or a GSI (`type: "gsi"`, scoped to the same stream).
  `readIndex(name, streamId, { beginsWith | between, reverse, limit, consistentRead })`
  and `query.index(name, streamId)` read them, with index names type-checked.
  `EventStore.indexDefinitions(...streams)` returns the `CreateTable` fragments
  (projection `ALL`). An LSI must be created with the table, and a table with
  any LSI caps every partition key value's item collection at 10 GB. Index
  attributes are written only by `append`, so an index added later, or a
  changed `key`, covers only events appended from then on.

New definition-time errors: `[EDD-9062]` invalid `snapshot.mode`, `[EDD-9063]`
malformed stream index, `[EDD-9064]` index attribute owned by the stream,
`[EDD-9065]` indexes sharing an index or attribute, `[EDD-9066]` undeclared
index name, `[EDD-9067]` conflicting physical index definitions.

Fix: snapshot state is now encoded with the same `decode → encode` fallback as
events. A `Schema.Class` state folded by an immutable `evolve` that spreads
(`({ ...s, balance })`) is a plain object, which the state schema's encoder
alone refused; an after-append snapshot was then silently never written, and
an inline one would have failed every command on the stream.

Whether `decide` may mutate state (#142) is left to the application: the
library adds no read-only types or runtime guard.

Docs: the event-sourcing tutorial gains a step for each feature, backed by the
runnable `examples/event-sourcing.ts`, and the API reference and `DESIGN.md`
cover the new options, types and errors.
