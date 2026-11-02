---
"effect-dynamodb": minor
"@effect-dynamodb/schema": minor
"@effect-dynamodb/geo": minor
"@effect-dynamodb/language-service": minor
---

Z-order indexes (`sk.zorder`, `sk.prefix`) with binary sort keys and `.within()` queries
(`naive` / `jump` / `precise`), skip-scan for bounds on non-leading sort-key composites,
`.explain()` / `.onRequest()`, and cursor v2. Key text now sorts the way values do, and
`db.tables.<Table>.rekey()` moves the rows 1.36 wrote to their new keys ("Upgrading from 1.36"
below).

A Z-order dimension is a plain entry in `sk.zorder`, typed from the model: a bare field name, or
`{ field, ...options }` whose options follow the field's type (`{ min, max, step? }` for a
`number` or `bigint`, `{ from, unit, bits }` for a date, the bare name or `{ values?, bits? }` for
a literal union or `boolean`, `{ bytes }` or `{ values, bits? }` for a plain `string`; a plain
`number` takes a range only). The editor completes the field names and options. `ZOrder` exports the entry types
only. `Entity.make` checks entries at runtime too, and refuses an unknown option (`EDD-9087`).

Every definition config that names a model attribute is now typed from the model: `Entity.make`
key and index composites, `sk.prefix`, `refs` keys, `unique`, `timeSeries.orderBy` /
`appendInput`, `generatedId.field` and vector index fields; `DynamoModel.configure` keys;
`Aggregate.make` composites, `context`, `edges` keys and `many` edges' `sk.composite`;
`Collections.member` / `Collections.make`; and `GeoIndex.make`'s `index` and `fields`. The editor
completes the names. Physical attribute names (key `field`s, `configure` renames, timestamp,
version and TTL names) stay strings.

**Behaviour change: adaptive request sizing is now the default** for queries with `.limit()`, a
filter, `filterBy` predicate or history rows, and no `.pageSize()` or `.maxPages()`. Each
request's `Limit` is sized from the observed pass rate instead of asking for a 1 MB page. The
items a query returns are unchanged; read units and request counts change, and a low or uneven
pass rate can take more round trips than one natural page (a logarithmic number more in the worst
case). A `fetch` cursor resumes at the same place, but its value can differ, and when the limit
fills on the last row a sized request returned the cursor can be non-null where it was null, so
a `fetch` chain can end with one empty page. `Query.paginate` emits one array per request, so
its page boundaries change; the items it streams are unchanged (a bound query's `.paginate()`
streams items and is unaffected). Queries with `.maxPages()` keep the previous sizing.
`.pageSize("natural")` restores the previous behaviour.

**Behaviour change: sort key text (and numeric partition keys).** 1.37.0 composes some key text
differently, so that keys sort the way their values do. Three kinds of value change; a value of
any other kind keeps its 1.36 key text and requests. A row 1.36 wrote with one keeps its old key
until it moves: through 1.37.x the 1.36 key fallback keeps it working, and `rekey` moves it
("Upgrading from 1.36" below).

- **Numbers, in every key.** `number` and `bigint` key composites (partition, sort and index keys,
  unique-constraint sentinels, a time-series `orderBy`) are written as text that sorts in numeric
  order. Non-negative integers below 1e16 (1e38 for a bigint) keep their exact 1.36 bytes, so a
  row whose numeric key composites all hold such values is unaffected. Negative, fractional,
  1e16-and-up and infinite numbers, `DateEpochMs` and `DateEpochSeconds` dates before 1970, and
  negative or 1e38-and-up bigints compose different text. `NaN` and bigints of more than 1,000
  digits can't be keys (`EDD-9096`): entity operations, `Batch` and `Transaction` fail with a
  `ValidationError` before sending anything, `get` and `delete` included (up to 1.36 they failed
  with `ItemNotFound` and did nothing), and query accessors, `.where()` and `.within()` throw.
- **Strings in sort keys.** A sort key composite's text escapes every character up to `%`
  (control characters, space, `!`, `"`, `#`, `$`, `%`) as `%` and two hex digits: `new york` is
  stored as `new%20york` and `a#b` as `a%23b`, in table and index sort keys, time-series event
  keys, version snapshot and tombstone keys, aggregate sort keys and Z-order prefix segments
  (`KeyComposer.sortKeyText`). Partition keys and unique-constraint sentinels are unchanged. Key
  order is now value order: up to 1.36 a space, `!`, `"` or control character sorted below the
  `#` after a composite, so `lte: "new york"` left out `new` and `gt: "new"` left out
  `new york`, and `#` split a value in two. Every `.where()` and `.within()` bound is one key
  condition again and returns exactly the rows whose value satisfies it, values may hold `#`, and
  skip-scan runs over string composites too. The language service's params escape the same way,
  and its hover for an accessor named after a collection now shows the accessor's sort key
  condition.
- **Time-series event keys of a numeric-string `orderBy`** (`NumberFromString`,
  `BigIntFromString`). Event keys hold the number's key text, so `.history()` returns events in
  numeric order and `.where()` bounds return the events they mean; up to 1.36 they held the
  string, which sorted `10` before `9`.

**Behaviour change: `.append()` on a numeric-string `orderBy`** compares the `orderBy` as a
number. Up to 1.36 DynamoDB compared the strings, so appending `10` after `9` failed with
`StaleAppend`, and `9` after `10` was applied. It now reads the current item first (one strongly
consistent `GetItem` per append, `.skipFollowUp()` included) and guards the write on the stored
value, reading and deciding again when a concurrent append moves it, up to 8 attempts in all.

**Behaviour change: `.append()` cancellations.** A user condition that rejects an append creating
the item now fails with `ConditionalCheckFailed` (no `current`) for every `orderBy` type, where
1.36 failed with a `ValidationError` (`append.followUp`). A transaction DynamoDB cancels for a
`TransactionConflict` alone (another transaction in flight on the item: nothing judged, nothing
written) is sent again, up to 8 attempts in all, then fails with the transaction's error; up to
1.36 it was reported as a `StaleAppend` or `ConditionalCheckFailed` and the event was not written.
The read that tells a cancellation's cause is now strongly consistent, and so is the read after an
applied append that returns `current` (without `.skipFollowUp()`): an eventually consistent read
could miss the item the append had just created, failing it with a `ValidationError`
(`append.followUp`), or return the item as it was before the append. Each such read costs one
read unit per 4 KB, where it cost half of one.

**Behaviour change: exact sort key matches.** An accessor or `Entity.query.<index>` given every
sort key composite sends `sk = key` instead of `begins_with(key)`, so `seq: 3` no longer returns
`3.14` or `3.5` and `name: "a"` no longer returns `"ab"`. `Aggregate.list` applies the same rule to
its list sort key, and its partial `begins_with` now ends on the delimiter (`owner: "alice"` no
longer returns `"alicex"`). `.where(beginsWith)` on a `number` or `bigint` composite compiles to
`eq`. `.history(key).where()` with `lt` / `lte` / `gt` / `gte` stays inside the item's own events;
it used to return the item's current row and other items' rows in the partition.

**Upgrading from 1.36.** Deploy 1.37 to every instance with the 1.36 key fallback on (the
default), dry run `db.tables.<Table>.rekey()`, run it, and once a
rerun moves nothing and reports no conflicts, turn the fallback off with
`DynamoSchema.make({ name, version, legacyKeys: false })`. The fallback and the setting are
removed in the next major release. The new "Upgrading from 1.36" guide walks through it.

- **What the fallback keeps working.** `get`, `getVersion`, `deleted.get`, `Batch.get` and
  `Transaction.transactGet` read the 1.36 key when the current key misses (`transactGet` with a
  second `TransactGetItems`: two snapshots, not one). `put`, `create`, `upsert`, `update`, `patch`,
  `append`, `delete`, `deleteIfExists`, soft delete, `restore`, `purge` and `Batch.write` act on the
  item wherever it is, and an item written once moves to its current key, its index keys recomposed
  under their index policy, its unique-constraint sentinels and (with `retain`) the snapshot of its
  version moved; a unique value held under its 1.36 sentinel stays taken. A query that pins a key
  prefix — an accessor's pins and an `eq` / `beginsWith` bound, `Entity.query.*`, collections,
  `.history()`, `versions()`, `deleted.list()`, `count()` — also reads the 1.36 key for the same
  pins: first (last under `.reverse()`), one key after the other rather than merged, with `limit`,
  pages, cursors and `count()` spanning both. Aggregates are read under both keys: `update` moves
  every row it finds under a 1.36 key in the same transaction (an `update` that changes nothing
  included), `create` refuses an aggregate that exists under its 1.36 key, and `list` lists it. An
  event-store stream whose stream id's text changed (a number passed as an id) is read and appended
  under its 1.36 key until `rekey` moves it, never split; a new one starts under its current key.
  Projections (`projection` and `multiProjection`) read a read-model row, or its tombstone, under
  its 1.36 key when the current key misses, so they fold onto it rather than from `initial`, and a
  tombstone keeps recognising redeliveries; their next write moves it (the write through the
  entity moves it first; a tombstone's or an outbox transaction puts it at the current key and
  deletes the 1.36 row while it is as read, in the same write). `drain(key)` and `drainPending`
  deliver a row's outbox effects under both keys in one order. Keys whose text did not change
  send exactly the requests they did.
- **What it doesn't.** Range bounds in `.where()` (`gt`, `gte`, `lt`, `lte`, `between`) and
  `.within()` read the current key only, so they miss rows that haven't moved. Rows from the 1.36
  key come in 1.36's order (a negative number above a smaller one). `.history()` of a
  `NumberFromString` / `BigIntFromString` `orderBy` keeps 1.36's events and the current ones
  apart under their shared prefix, 1.36's first, and holds its bounds on the numbers, reading
  all of the item's events to do so; events of a `Schema.Number` or string `orderBy` under an
  unchanged item key are read in text order. Inside `Transaction.transactWrite` an item can't
  move: an update, patch, conditioned put or delete, guarded put or `Transaction.check` of an
  item still under its 1.36 key fails the transaction with the new `ItemNotMoved` (`EDD-9097`),
  writing nothing; write the item once through the entity, or run `rekey`, first.
- **What it costs.** A conditioned `put`, `upsert`, `update`, `patch` and `append` are sent first
  as for an item at its current key and move it only when no item is there, so creating a new
  item this way costs one failed conditional write more; concurrent first writes of an unmoved
  item all succeed. An unconditioned `put` of an item whose key text changed is always one
  two-item transaction (Put at the current key, Delete at the 1.36 key): twice a plain put's write
  capacity for each item, and a cancellation by a concurrent transaction is sent again, up to 3
  attempts in all; a value whose 1.36 key can be another value's current key (below) is put as a
  conditioned put is. `Batch.write` deletes a put's 1.36 key in a later request, once the put is written. An
  append to a stream still under its 1.36 key carries one more check, that `rekey` hasn't moved
  it (a `ConditionCheck` on its first event, folded into the contiguity check when the head is
  the first event): an append that loses that race fails with `VersionConflict` and, retried,
  finds the stream at its current key.
- **Strings holding `%` and two hex digits.** 1.36 didn't escape sort key text, so such a
  string's 1.36 key is another value's current key (`foo%20bar`'s is `foo bar`'s, `x%23y`'s is
  `x#y`'s). Single-item operations, batches, transactions, accessor queries, `.history()`,
  `versions()` and `purge` tell the two apart by the row's values: a read of `foo bar` doesn't
  return `foo%20bar`'s row, a `put` of `foo bar` moves that row to its own current key first, and
  `update` / `delete` leave it alone. A write of `foo%20bar` leaves `foo bar`'s row at its 1.36 key
  alone (`create` and `restore` read that key first), and a retained `foo%20bar` created afresh
  continues its own version count, not `foo bar`'s. `Transaction.transactWrite` fails
  `ItemNotMoved` naming the item whose row holds the key. 1.36 kept `foo%20bar`'s version history
  under the prefix `foo bar`'s is under now: each lists only its own versions, and a write of
  `foo bar` whose version snapshot lands on one of `foo%20bar`'s moves that snapshot to its own
  current key first (inside `Transaction.transactWrite` it fails as before). A projection's row
  tombstone and outbox item hold no values, so 1.37 marks the ones it writes under a key whose text
  changed (`__edd_kt__`): one without the mark is 1.36's, and belongs to the row its key reads back
  as. An effect of `foo bar`'s row never replaces `foo%20bar`'s pending one at the same key (it
  moves that one first), and `drain(key)` of each delivers only its own effects, from both keys, in
  one order. Collection queries don't judge rows this way yet, and a time-series `append` can
  overwrite another value's 1.36 event stored under the same key text.
- **`rekey`** (`db.tables.<Table>.rekey(options?)`) moves every remaining row 1.36 wrote whose key
  text changed to its current key: items (with their index keys and unique-constraint
  sentinels), version snapshots, soft-delete tombstones (with the sentinels `preserveUnique`
  kept, which then name the item's current key), time-series events, aggregates, and the event
  streams passed in `options.streams` (the client doesn't register streams; a stream is copied,
  flipped in one conditional transaction, then deleted, while writers keep appending). Items
  already at their current key whose index keys still hold 1.36 text are rewritten in place. It
  scans the table in `segments` parallel scan segments, `concurrency` rows of a page at once;
  `dryRun` counts what would move and writes nothing; `maxPages` bounds a run and `resume` goes
  on from its token, as from the last one `onProgress` received before an interruption. A row
  moves only when it is stored under the key 1.36 composed for its values, so a rerun moves
  nothing, and it moves rows whatever `legacyKeys` says. Every write is conditioned on what the
  move read — a row lands only where nothing is (a stream's snapshot: over an older one) and is
  deleted only while it is as read — so an application write that lands during the move wins: a
  row under both keys, a current key another row holds, a row writes changed on every attempt and
  one that can't be moved are reported as `conflicts` and left (a version snapshot whose current
  key holds the same snapshot is a copy, and its 1.36 row is deleted); rows no member owns (not the
  library's, a type the client doesn't know) are counted as `skipped`. A projection's row
  tombstones and outbox items move to their row's current key, an outbox item's row key and sparse
  index sort key rewritten (`tombstone` and `outbox` in the report); an outbox on another table
  moves with that table's `rekey`, for a projection defined where it runs, so outboxes need not be
  drained first (an item a drainer is delivering is left, a `contended` conflict). A table holding only event streams or an outbox can now be passed to
  `DynamoClient.make({ tables })` for its `rekey`: its definition is composed when `create` runs.
  The report (`Table.RekeyReport`) counts rows by kind
  and by member and carries the capacity the run consumed, measured whether or not
  consumed-capacity reporting is on. A bad option or resume token fails with a `ValidationError`
  (`EDD-9098`) before anything is read.
- **Rolling deploys.** A 1.36 instance still running reads and writes 1.36 keys only: it misses
  rows a 1.37 instance has moved, and a write it makes puts the row under its 1.36 key again, which
  `rekey` then reports as a row under both keys. Finish the rollout before running `rekey`. A 1.36
  write that lands while a row moves isn't lost: a move deletes the 1.36 row only while it is as
  read (its version, or every attribute) and reads it again otherwise.

**Behaviour change:** `.where()` with a strict `lt` on the last sort key composite, with an earlier
one pinned, no longer throws `EDD-9046` (retired): it is sent as a `BETWEEN` ending just below the
value. `.history(key).where()` with `gt` / `gte` on a string `orderBy` now returns stamps that start
with an emoji.

**Message change:** the `ValidationError` a write fails with when its version snapshot would
overwrite different history now ends "The write was not made." (was "Nothing was written.").

**Behaviour change:** a malformed `.startFrom()` cursor now fails the query with a
`ValidationError` (`EDD-9094`) instead of throwing from `.startFrom()`.

**Behaviour change:** an attribute declared both as a key attribute and as a vector filter
attribute of another type now throws `EDD-9091` at `Table.make` / `Table.definition`, instead of
silently keeping the first type.

**Behaviour change:** `Entity.make` now refuses a `unique` constraint field the model doesn't have
(`EDD-9002`) and a `timeSeries.appendInput` field the model doesn't have (`EDD-9013`); both were
accepted and the field silently ignored.

**Type changes: misspelled attribute names no longer compile.** Each position listed above
accepts only the model's field names (an index composite also takes a ref's `${ref}Id` once
`refs` declares it), so code that named an attribute the model lacks, which ran only if the name
was never used at runtime, is now a compile error on that name. A config declared outside the
call (a shared `primaryKey`, an index or a `zorder` list in a variable) needs `as const`, or a
generic helper, to keep its names literal: widened to `string[]`, they no longer fit the model's
names. `DynamoModel.configure` refuses a key the model doesn't have even beside valid ones.
`Collections.make`'s `composite` accepts only fields every member's model has. `GeoIndex.make`'s
`index` accepts only the entity's index names. `Entity.make`'s `TRefs` type parameter now follows
`TEntityType` and has no default (left out, refs still resolve to `undefined`), and
`Aggregate.make` lists its top-level overload first, so `Parameters<typeof Aggregate.make>` reads
the sub-aggregate form.

**Type changes:** `KeyComposer.composeIndexKeys` / `tryComposeIndexKeys` / `composeAllKeys` and
`GsiUpdateResult.sets` values widen to `string | Uint8Array` (bytes only for Z-order halves).
`GsiConfig.sk` is `KeyPart | ZOrderKeyPart` (`composite` is optional on the union), `KeyPart`
gains `zorder?: never` / `prefix?: never`, and `IndexDefinition.sk` is `KeyPart | ZOrderSkPart`.
`IndexSkComposites` is `never` for a Z-order half. `pageSize` accepts `number | "natural"` on
`Query`, bound queries and collection queries. `DynamoSchema` gains `legacyKeys?: false`
(`DynamoSchema.make` takes `legacyKeys?: boolean`). The new `ItemNotMoved` joins the error
channels of `Transaction.transactWrite`, an `EventStore` append (through `additionalItems`) and
`Entity.PlanUpdateError` / `PlanDeleteError`; a time-series `append` and `restore` add
`ConcurrentModification`. New: `rekey` on the typed client's table operations, and
`Table.RekeyOptions`, `RekeyReport`, `RekeyCounts`, `RekeyRowKind` (`outbox` among its kinds),
`RekeyConflict` and `RekeyMemberReport`.
