---
"effect-dynamodb": minor
"@effect-dynamodb/schema": minor
"@effect-dynamodb/geo": minor
"@effect-dynamodb/language-service": minor
---

Store nested dates and other transformed values in wire form, read the maps earlier versions wrote, and support nested sub-aggregates (#133)

Earlier versions stored some `DateTime` values, and other values whose schema
transforms them, as a marshalled copy of the domain object, for example
`{ epochMilliseconds, "~effect/DateTime", _tag: "Utc" }` instead of an ISO
string. On Effect 4.0.0 those rows either failed to read
(`Expected DateTime.Utc`, for rows written under an Effect release candidate) or
read back as plain objects that only looked like `DateTime`s. This release
writes those values in their schema's wire form and reads the old maps back as
real `DateTime`s.

### Before you upgrade

- **Upgrade every reader before any writer, and don't roll back past this
  version once new rows are written.** A self date (`Schema.DateTimeUtc`,
  `Schema.Date`, or one with `storedAs`) inside a `NullOr` or other union, a
  `Record` or a `Tuple` is now stored as a string or number, on entities and
  aggregates alike. 1.22.0 fails to read it (`Expected DateTime.Utc`), or, in a
  union with a string member, reads it back as a plain string. The other shapes
  this release writes differently stay readable by 1.22.0: dates in arrays and
  arrays of classes, transform dates such as `DateTimeUtcFromString` in any
  container, refs in `many` elements declared as plain classes, and optional
  `NumberFromString` fields. An entity whose primary sort key has composites
  now keeps each item's version and soft-delete history under its own keys
  (below), which 1.22.0 doesn't read correctly: its `versions` and
  `deleted.get` mix siblings' rows with the item's, and its `getVersion` misses
  every version written in the new format.
- **Keys are unchanged** for every existing entity and aggregate shape: `pk`,
  `sk`, GSI, unique, version, soft-delete, time-series, collection and
  list-index keys are composed byte-for-byte as before, with one exception:
  the version-snapshot and soft-delete keys of an entity whose primary sort
  key has composites (several items per partition) now carry the item's
  identity, so each item has its own history. History written by earlier
  releases stays readable and restorable. Entities without sort key
  composites keep exactly the keys they had. Rows an earlier release keyed
  differently from today's composer (an unpadded number composite written by
  1.15) are still read by queries and scans as they were. Details under
  "History of items that share a partition".
- **Some attributes change stored type** on their next write, listed under each
  section below. For example, an optional `NumberFromString` holding `5` was
  stored as `{ "N": "5" }` and is now `{ "S": "5" }`, and a nested self date was
  a map (`M`) and is now a string or number. Until old rows are rewritten, a
  filter on such an attribute (a `filter` expression, or a `filterBy` predicate,
  which sees the stored value) can match old and new rows differently, and
  DynamoDB Streams consumers see the attribute change type.
- **Two model shapes are now rejected at `make()`.** A union whose date member
  is stored as an epoch number next to a member also stored as a number
  (`Number`, a number literal, `BigInt`, another epoch date) fails with
  `EDD-9058`, because a stored number could belong to either member. On an
  aggregate this also covers a `NumberFromString` or `BigIntFromString` member:
  `update` re-decodes the aggregate's domain values, where those are numbers.
  Entities accept those two. Store the date as a string (the default for a self
  date) or remove the numeric member. A `DynamoModel.configure` `storedAs`
  override on a union field with more than one date member fails with
  `EDD-9057`; annotate the intended member instead.
- **Update and delete errors changed.** A lost version race is now always an
  `OptimisticLockError` carrying the real `actualVersion`, a failed
  `.condition()` is always a `ConditionalCheckFailed`, and an update of a
  missing item is always an `ItemNotFound` (it used to be
  `OptimisticLockError(-1)` for a versioned update with `expectedVersion`).
  Two new errors exist: `ConcurrentModification` and `UpdateAppliedButUnreadable`.
  Don't retry the second one, because the write was applied. Review your
  `catchTag` handlers; the cases that changed are listed under "Updates and
  deletes".
- **`update()` of a missing item no longer writes a partial row.** It fails
  with `ItemNotFound` and writes nothing, unless it is a plain `.set()` of a
  complete item, which the library creates through `create`. `patch()` still
  fails with `ConditionalCheckFailed` (see below).
- **Good news if you enabled `versioned` on an existing table.** Items written
  before the entity was versioned read as version 0 on every path, and
  `expectedVersion(0)` addresses them. Their first versioned write conditions
  on no version existing, adds the incarnation token and writes version 1, and
  their retain snapshot is `v#0000000`. A race on that first write is an
  `OptimisticLockError`. Soft delete and restore work on them.
- **Items whose version was removed are refused.** An item of a versioned
  entity that has the incarnation token (`__edd_i__`) but no version, because
  its version was removed outside the library, fails with a `ValidationError`
  on reads and on the writes that read or check the version, instead of
  reading as version 0. A query over a partition that holds one such item fails
  as a whole. Restore the version attribute to read it again. Items with
  neither (written before the entity was versioned) still read as version 0.
- **A `put` over an existing item of a versioned or unique-constrained entity
  now reads it first and continues it** instead of resetting it to version 1.
  A concurrent write between the read and the put is retried, so the last
  writer wins as before; only a race lost on every attempt fails, with
  `OptimisticLockError` or `ConcurrentModification`, which the error channel
  gains. `create` doesn't read the item: it must be missing anyway. **A deleted
  retain item can be created again without `purge`**: it continues after the
  version history its key still holds. Details under "Puts, upserts and
  batches".
- **Transactions and `EventStore` `additionalItems` now replace existing
  versioned and unique-constrained items.** A put there reads the item and
  writes it exactly as the entity's own `put` does, so a versioned read model
  can be kept in step with the events across appends. A taken unique value in
  `additionalItems` is now a `UniqueConstraintViolation`, not an
  `AdditionalItemConditionFailed`: that error is only for a condition you set.
  `Transaction.transactWrite` and `append` (and `commandHandler`) gain
  `OptimisticLockError` and `ConcurrentModification` (a race lost on every
  attempt), and `append` gains `UniqueConstraintViolation`.
- **A unique sentinel is released only by the item that owns it.** An item can
  hold a unique value without owning its sentinel (the constraint was added
  later, or a `ttl`'d reservation expired and another item claimed the value).
  Every write that releases a sentinel (a put, update or upsert that changes
  the value, a delete, a soft delete, `purge`, a transaction put) now reads it
  first and releases it only if it names this item, so it can no longer delete
  another item's reservation and let the value be taken twice. That costs one
  consistent read per sentinel released.
- **A hard delete of a retain entity snapshots the item it deletes.** The
  delete and the snapshot of the final state (`v#N`) are one transaction,
  guarded on the version read, so an item created again at the key continues
  at `N + 1` and a writer still holding version `N` can't overwrite it. That
  makes a retain hard delete a `GetItem` plus a two-item `TransactWriteItems`
  (twice the write capacity of a `DeleteItem`) instead of one `DeleteItem`.
  A delete you set no `.condition()` on is read and written again (up to three
  attempts) when another writer changes or deletes the item in between, as a
  put is; this holds for every delete that reads first (retain, unique and
  soft delete), and a delete that loses the item to a concurrent delete
  reports what a delete of a missing item does (success for retain only,
  `ItemNotFound` with unique constraints or soft delete). `deleteIfExists`
  asserts only that the item exists, which these deletes already check: it
  is retried the same way, and on a missing item it fails with
  `ConditionalCheckFailed` (on unique-constraint and soft-delete entities it
  used to fail with `ItemNotFound`; retain-only entities already gave
  `ConditionalCheckFailed`). A `.condition()` added to `deleteIfExists` is now
  ANDed with its existence check instead of replacing it. With any other
  `.condition()`, such a race fails, as before.
- **`delete().returnValues("allOld")` returns the item it deleted** (the
  model, `undefined` when there was none), on every delete path — it returned
  nothing. The result is typed by the mode (any `ReturnValuesMode` still
  compiles). A mode DeleteItem doesn't support (`"allNew"`, `"updatedOld"`,
  `"updatedNew"`) fails with a `ValidationError` before anything is sent; it
  used to reach DynamoDB, which rejected it (or, through `Entity.returnValues`,
  was dropped). If the deleted item can't be decoded, the new
  `DeleteAppliedButUnreadable` reports it, with the item as stored: the delete
  WAS applied.
- **Chained `.filter()`s no longer collide.** Each filter was compiled on its
  own, numbering its attribute placeholders from zero, so the second
  overwrote the first's name and the query matched the wrong attribute; they
  are now compiled as one expression.
- **Projected names need no particular characters.** `select(["first-name"])`
  built the placeholder `#proj_first-name`, which DynamoDB rejects; a name
  that isn't letters, digits and underscores now gets a numbered placeholder.
- **Collection queries keep their grouping through every combinator.**
  `db.collections.x(...).filter(...).collect()` returned a flat list of
  internal `{ _memberKey, _decoded }` wrappers (it lost the grouping by
  member); it is grouped like `collect()`, and so is `.fetch()`'s page (it
  returned the same wrappers, though typed as grouped). `.paginate()`, which
  streamed the wrappers too, streams each item tagged with its member
  (`{ member, item }`, typed `CollectionStreamItem`), and `CollectionQuery`
  now declares `.select()` (partial records grouped per member), `.count()`,
  `.paginate()`, `.maxPages()`, `.consistentRead()` and `.ignoreOwnership()`;
  `CollectionQuery`, `CollectionStreamItem`, `CollectionSelected` and
  `CollectionAccessors` are exported. A collection
  filter or select names each member's domain fields. A member without the
  field reads it as absent, exactly as before (so `not(...)` and
  `notExists(...)` still match its rows), and an attribute that member
  stores under that name never stands in for it.
- **A filter can no longer widen an entity's ownership check.** A filter
  whose top level was an `OR` was ANDed with the `__edd_e__` check without
  parentheses (`#eddE IN (:et0) AND a OR b`), so another entity's rows in the
  same partition matched `b` — returned by `collect` (or failing to decode),
  counted, selected. The filter is now parenthesised.
- **A `.condition()` no longer replaces an op's own guard.** On 1.22.0
  `create`'s not-exists check and `patch`'s and `deleteIfExists`'s exists
  check were held as the op's condition, so a `.condition()` replaced them:
  `create(item).condition(c)` overwrote an existing item whenever `c` held on
  it (`exists(n)`, say); `patch(key).condition(c)` with a `c` that holds on a
  missing item (`notExists(n)`) wrote a partial item and then failed to decode
  it; and `deleteIfExists(key).condition(c)` of a missing item succeeded,
  deleting nothing, whenever `c` held. They are now the op's own guards, ANDed
  with the caller's condition — bound, unbound, in a transaction and in
  `EventStore` additional items — so each of these fails with
  `ConditionalCheckFailed` (`TransactionCancelled` in a transaction) and writes
  nothing. As on every op, a later `.condition()` replaces an earlier one; the
  guard stays. `patch()` of a missing item now fails with
  `ConditionalCheckFailed` on every entity: one whose update reads first,
  such as a retain entity, failed with `ItemNotFound`.
- **Empty conditions and filters.** On 1.22.0 `.condition({})` (or `and()`)
  sent an empty `ConditionExpression`, or `()` beside the library's guard
  (`… AND ()`), and an empty part under `or()` or `not()` was sent as
  `… OR ()` / `NOT ()`; DynamoDB rejected each with a `DynamoValidationError`,
  as it did an `isIn` with no values (`IN ()`). A condition that asserts
  nothing is now no condition — the op's own guard alone — on put, create,
  upsert, update, patch, delete, `deleteIfExists`, append and transaction ops,
  and an empty part directly under `and()` is left out. Anywhere else — under
  `or()` (it would match everything) or `not()` (nothing), an `or()` with no
  parts, or an `isIn` with no values — it is refused with a `ValidationError`
  before anything is sent, in conditions, entity and collection filters and
  aggregate `list` filters. Two of these are behaviour changes: a filter of
  `or()` with no parts was dropped, so the query matched everything, and an
  aggregate `list` filter of `or()` returned every aggregate; both now fail
  with a `ValidationError`. `.filter({})` is still no filter, and a
  `Transaction.check()` with an empty condition is refused before sending.
- **`.consistentRead()` on a GSI is refused before sending.** DynamoDB reads
  a global secondary index only eventually consistently, and rejected the
  request with a `DynamoValidationError`; an entity index query or a
  collection with `.consistentRead()` now fails with a `ValidationError`
  without sending it. The table is read consistently, as before. An entity's
  indexes are always treated as GSIs (`db.tables.*.create()` creates them as
  GSIs), so one pointed at an LSI of a table created outside the library is
  refused too.
- **`expectedVersion` on an entity that isn't `versioned` is refused
  (behaviour change).** On 1.22.0 it was silently ignored, so the update ran
  with no concurrency check at all. It now fails with a `ValidationError`
  before anything is read or sent. Add `versioned: true`, or use a
  `.condition()`.
- **Bound queries filter and select renamed fields by their stored names.** A
  field renamed with `DynamoModel.configure(..., { field })` was projected and
  filtered under its domain name, so `select(["name"])` returned `{}` and
  `filter({ name })` matched nothing; they now use the stored attribute and
  hand items back under the domain names. On a collection whose members store
  one field under different names, a filter is judged per member and a select
  reads each member's own attribute.
- **A transaction that touches one item twice, or passes DynamoDB's 4 MB, is
  refused before it is sent**, with a `ValidationError` naming the entity, in
  `Transaction.transactWrite` and `EventStore.append`. The items an op adds
  count: two puts that swap unique values touch the same sentinels, and a
  retain put counts twice (its item and its snapshot).
- **Primary-key queries and scans no longer return history rows.** Version
  snapshots, soft-delete tombstones and time-series event items carry their
  entity's type, so a primary-key query with no (or a partial) sort key
  condition, a scan, and a collection on the primary key returned them as if
  they were items (a time-series partition query failed to decode its events).
  They're now left out. A row is left out only when it is positively history:
  its sort key is not the one its own stored composites compose AND it has the
  layout of a snapshot (`#v#…<version>`), a tombstone (`#deleted#…<timestamp>`)
  or an event (`#e#` under the live key). Every other row is read as before —
  including rows an earlier release keyed in a way the current composer
  doesn't reproduce (an unpadded number composite written by 1.15). This runs
  on the rows as they arrive, for queries and scans alike, so a projection
  also reads the sort key and its composites. `limit` is still sent as
  `Limit` on the first request, and each later request asks for twice the
  last, so a run of history rows costs requests logarithmic in its length;
  `maxPages` still bounds requests, so a capped query can return fewer items
  than `limit` when rows are left out. `.history()` still reads
  events. A primary-key `count()` of a retain, soft-delete or time-series
  entity reads the sort key and composites of each row to count them (the
  same read capacity as a server-side count), not whole items.
- **`purge` removes only its own entity's rows.** It deleted every row in the
  partition, so with a collection on the primary key, purging an order also
  deleted its lines. It now deletes only rows of its own entity type.
- **`Batch.write` sends puts of a `versioned` entity as transactions.** They go
  first, as create-only `TransactWriteItems` of up to 100 items (and under
  DynamoDB's 4 MB transaction payload), and each chunk costs twice the write
  capacity of a batch write. A put that would replace an existing item fails
  with a `ValidationError` and writes nothing from its chunk. Earlier chunks
  may already have been written, because `Batch.write` was never atomic across
  chunks. A batch that touches a versioned put's item more than once (a
  delete and a put of it, or two puts) is refused before anything is written,
  since the put runs in its own transaction and the order couldn't be kept.
- **More updates are refused with a `ValidationError`**: a `.set()` that changes
  a primary-key composite (silently ignored before), a `.set()` that changes an
  immutable field (restating its current value is fine), and the path
  operations on index composites and unique fields listed under "Updates and
  deletes".
- **`returnValues` is honoured, and typed by its mode.** `"none"` now returns
  `undefined` and `"updatedOld"` / `"updatedNew"` return a partial of the
  attributes written, on every update path. A retain update with `"allOld"`
  now returns the replaced item rather than the new one.
- **Two new hidden attributes.** Versioned entities get `__edd_i__`, set on
  create and added to existing items on their next guarded write. An item whose
  unique field holds only a decoding default that is also an index composite
  gets `__edd_d__`, a string set naming those fields. Decoded models never
  include either, but raw readers, `asNative` and DynamoDB Streams consumers
  will see them.
- **Writes are validated more strictly**, so some calls that used to succeed
  now fail with a `ValidationError`. Container `.check()` refinements on an
  array, a struct or a checked-struct class that holds a date or another
  substituted value were silently dropped, and are now enforced on every write
  (entities and aggregates; details below). Entity path updates are now
  validated like `.set()`, so a literal outside its set or a string under its
  `minLength` is rejected instead of stored. Reads don't enforce the container
  checks, so existing rows that break them still read. On an aggregate, though,
  such a row refuses every `update` until that same update makes the value
  valid; an entity `.set()` on other fields still succeeds on it.
- **A canonical ISO string in a string member reads as a date.** In
  `Schema.Union([Schema.DateTimeUtc, Schema.String])`, the exact ISO form the
  library writes for a date (`"2000-01-01T00:00:00.000Z"`) reads back as a
  `DateTime`, even if it was written as a string. Other strings (`"2020"`, `"5"`,
  `"hello"`) stay strings. If a string field may hold ISO instants, use a tagged
  or discriminated shape.
- **No backfill is performed.** Old rows read correctly as they are, and are
  rewritten in wire form when they are next written. For an aggregate that
  means the next `update` that changes the row's group (the root item or its
  sub-aggregate); an update that changes nothing writes nothing.
- **Values that were lost stay lost.** A domain object with no enumerable state
  was stored as a map holding no value: a `Schema.Date` (`{M:{}}`), a `URL`, a
  `Duration`, a `BigDecimal`. These cannot be recovered, and reading them fails
  with a `ValidationError`.
- **Nested sub-aggregates written by earlier versions are not read.** Rows below
  the first sub-aggregate level used different keys, and never read back
  before. Recreate those aggregates.

### Aggregates

**`create` of an existing aggregate fails (behaviour change).** `create`
wrote plain `Put`s, so creating an aggregate whose root item already existed
silently overwrote it — and left the old aggregate's edge and sub-aggregate
rows that the new one didn't rewrite. The root item is now written first, in
the first transaction, conditioned on `attribute_not_exists`. An existing
aggregate cancels that transaction, so nothing is written, and `create` fails
with `ConditionalCheckFailed` (`entityType` is the root's, `key` its `pk` and
`sk`). Edge and sub-aggregate rows carry no guard of their own; they are only
written after the root's transaction commits. As before, each sub-aggregate is
its own transaction: if a later one fails, the earlier ones stay written.
Replace an existing aggregate with `update`, or `delete` it first.

**Writes.** Aggregates now store every value in its wire form wherever it is
nested: in root arrays (`Schema.Array(Schema.DateTimeUtcFromString)`), arrays of
classes (`sessions[].startTime`), `NullOr` and other unions (also inside
arrays), records, tuples, refs hydrated into `one` / `many` items
(`player.dateOfBirth` on a `MatchPlayer` item), and edges declared without an
`entity`. Before, only a field whose own schema was a transform was encoded.

**Reads.** Date maps written by earlier versions are rebuilt into real
`DateTime` values, whichever type-id key they carry; `Zoned` values keep their
named or offset zone. An optional `BigIntFromString` and a plain `Schema.BigInt`
stored as a number, which could not be read back at all, now read as a `bigint`.

**Stored-type changes.** A top-level `Schema.optional(...)` or `Schema.NullOr(...)`
around a non-date transform (such as `NumberFromString` or `BigIntFromString`),
on the root item, an edge item or a `many` element's own fields, is now stored
encoded rather than in its domain form. So is a `NumberFromString` nested inside
a hydrated ref, and a self date inside a union, record or tuple.

**Now working.** None of these worked on 1.22.0:

- A ref in a `many` element, declared as `player: Player.pipe(DynamoModel.ref)`
  (it could not be read back even after a fresh write) or as the element itself,
  `Schema.Array(Player.pipe(DynamoModel.ref))` (`update` failed). The plain
  class `player: Player`, matched by name to the edge's entity, also
  round-trips.
- `update`, even one that changed nothing, on models with unions, records or
  tuples around transforms (it failed with `Expected string`).
- Unions that mix a date with another type, such as
  `Schema.Union([Schema.DateTimeUtcFromString, Schema.Number])` (`create`
  threw). Each value is now stored and read by the member it belongs to.
- `create` input carrying a `DateTime`, an `Option` or another Effect value on
  an aggregate with a ref edge. The input was copied with `structuredClone`,
  which stripped those values, so they were rejected. Cyclic input is handled
  too.
- A nested field that shares a name with a root ref edge (a `coach: Schema.String`
  inside an array, next to a root `coach` edge). Refs are now resolved by field
  schema, so it is no longer decoded as that edge's entity.

**Container checks.** `create` and `update` enforce `.check()` refinements on
arrays, structs and checked-struct classes that hold a date or another
substituted value; earlier versions silently dropped them. A violating value
fails with a `ValidationError`. Reads don't enforce them, so a stored row that
breaks one still assembles. Every `update` of that aggregate fails until the
same update makes the value valid, which repairs the row.

**Known limitation.** A `many` edge with a custom `decompose` that renames
element fields still stores the renamed values in their domain form, so a
`DateTime` there is written as a map. Those values do read back as real
`DateTime`s.

### Entities

**Self dates in containers.** A self date inside a `NullOr` or other union, a
nullable class (`NullOr(Stamp)`), an array of a union (`Array(NullOr(date))`), a
`Record` value, or a `Tuple` / `TupleWithRest` / `StructWithRest` was stored as
a `DateTime` map. It is now stored in its wire form (a number where `storedAs`
says so), and existing map rows read back as real `DateTime`s. A
`DynamoModel.configure` `storedAs` override on a union field now applies to its
date member. Transform schemas such as `DateTimeUtcFromString` already stored
their wire form and are unchanged. A `TupleWithRest` field is also no longer
mis-derived as an array.

**Container checks.** `.check()` refinements on arrays, structs and
checked-struct classes that hold a date or another substituted value were
silently dropped. They are now enforced on every write: `put`, `create`,
`update` and `.set()`, path operations, `.append()`, Batch and Transaction. A
violating value fails with a `ValidationError`. Reads don't enforce them, so
existing rows that break one still read.

**Path updates.** `pathSet`, `pathAppend`, `pathPrepend`, `pathIfNotExists` and
the record-based `.append()` (including on versioned entities that retain
snapshots) now encode their value through the schema at the path, as `.set()`
does. Before, they wrote the raw value: a `DateTime` became a map even on a
plain date field, and a `NumberFromString` value was stored as a number. Now:

- A plain object on a class-typed field is encoded as that class, and a class
  instance is always encoded whole.
- A plain object or array that mixes wire and domain parts, or holds an
  ambiguous wire part, is encoded part by part, so every `DateTime`, `Date` and
  `Redacted` inside it is stored in wire form.
- A value already in wire form is normalised the way `.set()` normalises it:
  `NumberFromString` `"05"` is stored as `"5"`, `DateTimeUtcFromString`
  `"2000-01-01"` as `"2000-01-01T00:00:00.000Z"`, and a `Schema.Trim` field
  stores its trimmed form. Read-back values are identical; only the stored
  bytes differ, which filters and Streams consumers will see.
- A value passes through as given only if it genuinely decodes as the wire form
  of a leaf transform with a primitive wire form AND is also a valid domain
  value, such as `"aGk="` on a `StringFromBase64` field; encoding it would
  double-encode it. A plain string that isn't valid wire (`"hi"`) is a domain
  value and is encoded.
- Path values into and under a top-level `DynamoModel.ref` field are encoded
  through the ref target's model, like any other path. Only a path no schema
  describes (such as one under a dynamic key of an untyped value) is written as
  given.
- A value set by path into a class that has lost its fields (one built with
  `.check()` or `.annotate()`, or a `DynamoModel.ref` nested inside a ref
  target) is written as given, in the same form `put` stores it, so the item
  stays readable.
- Path values are validated like `.set()`, so an invalid value (a literal not
  in the set, a string under `minLength`, a broken container check) fails with a
  `ValidationError` instead of being stored. A key whose value is `undefined`
  is dropped before validation, as it is when stored. List `append` and
  `prepend` validate each element, but can't enforce list-level checks such as
  `maxLength`, because DynamoDB builds the list server-side. An append can
  therefore take a list past such a check. For a list whose check is enforced
  on read (any array holding no date or other substituted value), the item then
  fails to decode on the update's returned item and on every later read. Guard
  such lists with a condition on their size, e.g.
  `.condition((t, { lt }) => lt(t.tags.size(), 2))`, or use `.set()` with the
  full list. This is not new in this release.

`ADD`, `DELETE` and `SUBTRACT` are unchanged.

**Path updates on retain entities.** Path operations (`pathSet`,
`pathAppend`, `pathPrepend`, `pathIfNotExists`, `pathAdd`, `pathSubtract`,
`pathDelete`, `pathRemove`) on entities with `versioned: { retain: true }` were
silently ignored: they returned success and wrote nothing. They are now sent to
DynamoDB as the same update expression used for other entities, in one
transaction with the version snapshot of the item they replace, so they behave
exactly as DynamoDB defines: list indexes refer to the item before the update,
a copy reads the old value, overlapping paths and appends to a missing list are
rejected, and a rejected update writes no snapshot. `expectedVersion` and
`.condition()` apply. One update cannot combine path operations with a change
to a unique-constraint field or a computed change to an index composite; it
fails with a `ValidationError`, so split it into two updates.

**Legacy values read back.** The raw values earlier path updates left on
transform fields now read: a number on a `NumberFromString` field, a
safe-integer number on a `BigIntFromString` field, a `DateTime` map on a date
transform. A plain `Schema.BigInt`, stored as a number, now reads back as a
`bigint`.

**Known limitation.** Plain dates inside a class that has lost its fields (see
above), including whole-value `put`, `.set()` and `pathSet` of that class, are
still stored as maps, as on 1.22.0, and read back as plain objects.

**Zoned dates.** A zoned date with an offset zone (`+05:00`) now reads back
with that offset, for both `DynamoModel.DateTimeZoned` and a self
`Schema.DateTimeZoned`, on entities and aggregates; earlier versions read it
back as UTC. Named zones and UTC round-trip as before, and the stored form is
unchanged. Known limitation, as in earlier versions: an offset that isn't a
whole minute (a historical local-mean-time offset, a sub-minute
`zoneMakeOffset`) is rounded to the minute by Effect's ISO format, and the
instant read back moves by the same amount.

### Updates and deletes

**Path operations on index composites and unique fields.** A top-level
`pathSet` of a value or `pathRemove`, and a numeric `pathAdd` or
`pathSubtract`, on an index composite or unique field now recompose the keys
and rotate the unique sentinels exactly as `.set()`, `.remove()`, `.add()` and
`.subtract()` do. Operations whose result DynamoDB computes at write time
(copies, `pathIfNotExists`, list and set operations) on such a field, paths
below such a field, any path operation on a primary-key composite or an
immutable field, and two operations on the same such field are rejected with a
`ValidationError` naming the field. An update can't combine path operations
with a change to a unique field or a computed change to an index composite;
split it into two updates. `.add()`, `.subtract()`, `.append()` and
`.deleteFromSet()` on an index composite now recompose the index key on every
entity.

**Error mapping.** On every update path a lost version race is an
`OptimisticLockError` with the real `actualVersion`, a failed `.condition()` is
a `ConditionalCheckFailed`, and a missing item is an `ItemNotFound`. Three cases
used to be the other way round:

- A versioned update with `expectedVersion` and a `.condition()` reported a
  failed condition as `OptimisticLockError(-1)`.
- A retain update with a `.condition()` did the same.
- A retain path update with a `.condition()` reported a lost version race as
  `ConditionalCheckFailed`.

**Guarded read-then-write.** Updates that read the item first (a unique-field
change, a computed change to an index composite, any retain update) write a
guarded update of only what changed. A concurrent change to an unrelated
attribute is preserved. A race on something the update read fails without
writing: with the new `ConcurrentModification` on an unversioned entity, and
with `OptimisticLockError` on a versioned one. Soft delete, and a hard delete
of an entity with unique constraints or `retain`, are guarded the same way;
with no `.condition()` such a delete reads the item again and is retried. `restore` fails with
`ItemNotFound` if a concurrent restore won, and with `ItemNotDeleted` if a live
item exists under the key.

**Wide items.** An unversioned soft delete is never refused for width. When
the full guard can't fit DynamoDB's condition limits (4 KB and 300 operators,
counted on the actual condition including your `.condition()`), it falls back
to the strongest guard that fits: the item exists, `updatedAt` is unchanged
(with timestamps), then as many attributes as fit, unique-constraint fields
first. With timestamps, that detects any concurrent library update except one
in the same millisecond with an identical `updatedAt`. A writer outside the
library that leaves `updatedAt` alone can change unguarded attributes
undetected. Without timestamps, only the guarded attributes are protected. An
update too wide for one expression writes the whole item, under the version
condition (versioned) or the same fallback guard (unversioned). A concurrent
write from outside the library to an attribute the guard doesn't cover is lost,
which is also what 1.22.0 did for every such update. A `.condition()` too large
to fit beside the guard fails before writing with a `ValidationError` stating
its size. Operators are counted as DynamoDB counts them: in a condition, each
comparison, `AND` / `OR` / `NOT`, `IN` and each function, with `BETWEEN`
counted once (its own `AND` is part of it); in an update expression, each `+`,
`-` and function, but not a `SET` clause's `=`.

**Incarnation token.** Versioned entities carry a hidden `__edd_i__` attribute,
set on create and backfilled on the next guarded write. It is never in decoded
models (only in `asNative`). Version-checked writes require it, so an item
deleted and recreated — at the same version on an entity without `retain`, or
by a writer outside the library — is never mistaken for the original. (A
retain item the library creates again continues after its retained history, so
it never repeats a version.)
An item that has the token but no version had its version removed outside the
library. It is refused with a `ValidationError` rather than read as version 0,
which would let the next update rewrite its history: by every read (`get`,
queries, the `deleted` views, `decodeMarshalledItem`), and by every update,
soft delete, hard delete of an entity with unique constraints or `retain`,
`restore`, versioned `put` and `upsert`. A query over a partition holding one
fails as a whole. A plain hard delete (no unique constraints, no `retain`) still
removes it, since it reads nothing and writes no history; `purge` removes it on
any entity.

**Version history is never overwritten.** An update, soft or hard delete,
restore or replacing `put` that would write a `v#N` snapshot holding a different state
from the row already there fails with a `ValidationError` and writes nothing.
Rewriting the same state (the same version, incarnation and, with timestamps,
`updatedAt`) is allowed, which is what the first update after a retain `put`,
and a restore, do. A write from outside the library that changes an item
without bumping its version can still be captured into the next `v#N`
snapshot.

**Retain return values.** A retain update returns exactly the item it wrote,
even if another writer has replaced it since. If that can't be proven, it fails
with the new `UpdateAppliedButUnreadable`: the write WAS applied, so don't
retry. `allOld` returns the replaced item; on record and unique-field retain
updates it used to return the new one.

**`returnValues` on every update path.** `"none"` returns `undefined`,
`"updatedOld"` / `"updatedNew"` return only the top-level attributes written as
a partial, and `"allOld"` / `"allNew"` return the whole item. The result type
follows the mode (`UpdateReturn` is exported), and repeated
`Entity.returnValues` calls are typed by the last one. A cascade with `allOld`
or `updatedOld` cascades exactly what this update wrote; combined with path
operations on an unversioned entity it is refused.

**`update()` of a missing item** no longer leaves an undecodable partial row.
A plain update requires the item to exist. If it's missing and the update is a
plain `.set()` of a complete item (every required field and primary-key
composite; a field with a decoding default doesn't count as required) with no
other operations, `expectedVersion`, `.condition()`, cascade, `withVector` or
old-image `returnValues`, the library creates it through `create` with the same
payload, so the item is exactly what `put` writes. If another writer creates it
in between, the update re-runs once on that item. Anything else fails with
`ItemNotFound` and writes nothing, as do retain entities and updates that read
first (a unique-field change and the like). `patch()` of a missing item fails
with `ConditionalCheckFailed` on every path.

**Decoding defaults.** Fields with `Schema.withDecodingDefault` now survive on
read: a `put` that omitted one used to write the item and then fail with a
`ValidationError`. A defaulted `DateTimeUtc` is stored as an ISO string. A
defaulted primary-key or index composite that a write omits is stored with its
default, and keys are composed from it. Other defaulted fields are still not
stored, and the default is applied on read.

A default never creates a unique-constraint sentinel. A defaulted unique field
that is also an index composite is stored and indexed, and is listed in a hidden
string-set attribute, `__edd_d__`, which never appears in decoded models. It
gets its sentinel only when a write supplies its value. A `.remove()` of a
defaulted index composite stores the default again and keeps the item indexed
under it; on a unique field it releases the old value's sentinel and creates
none for the default.

**`.set()` refusals.** A `.set()` of a changed primary-key composite is refused;
it was silently ignored before. An immutable field can be restated with its
current value, so spread records work; a different value is refused.

**Known limitations.** Both are inherent:

- On unversioned entities, nothing can prove an unguarded attribute unchanged.
  So the item a unique-field update returns may show stale values for
  attributes it neither reads nor writes, wide items use the fallback guard
  above, and the whole-item write of a wide update can overwrite writers
  outside the library. Use `versioned` where that matters.
- A plain `.expectedVersion(n)` can't detect a delete-and-recreate that has
  climbed back to version `n` on an entity without `retain`: its versions
  restart at 1, so it takes `n − 1` updates after the recreate.

### Puts, upserts and batches

**Replacing puts.** A `put` of a versioned or unique-constrained entity reads
the item first. Over an existing item it continues that item: it takes the
next version, keeps the same incarnation and `createdAt` (unless the input
supplies one; unique-only entities keep `createdAt` too), writes a retain
snapshot of the item it replaces, and rotates the unique sentinels of changed
values. It never resets the item to version 1 or orphans a sentinel. The write
is guarded by what it read; a put replaces the whole item, so when another
writer creates, changes or deletes it in between, the put reads it again and
retries, and the last writer wins. A race lost on every attempt fails with
`OptimisticLockError` (versioned) or `ConcurrentModification` (unversioned) and
writes nothing. A soft-deleted item counts as missing. `create` no longer reads
the item first; it still fails with `ConditionalCheckFailed` on an existing
item. A retain `create` runs one `Limit 1` query of its version history, and,
when the primary sort key has composites, a second, keys-only `Limit 1` query
for history an earlier release wrote (and reads that history only if it finds
some).

**Re-creating a deleted retain item.** Its version history outlives it, and
the key can be used again without `purge`. Deleting it, hard or soft, snapshots
its final state at its own version in the same transaction (1.22.0 wrote no
snapshot on a hard delete). A `put`, `create`, `upsert` or transaction put of
the missing item reads the highest version retained for its key and continues
after it, with a new incarnation token: an item deleted at version 3 comes back
at version 4 with its own `v#0000004` snapshot, and the earlier history is never
overwritten. A writer still holding version 3 fails with `OptimisticLockError`.
`restore` of the old tombstone while the new item is live fails with
`ItemNotDeleted`. A hard delete of a missing retain item writes nothing, as
before; with a `.condition()` the condition is judged against no item, and the
delete never removes an item created since its read.

**Sentinel ownership.** A sentinel is released only by the item that owns it
(`_entity_pk` / `_entity_sk`): the write reads it first and conditions the
release on that ownership. A release whose reservation changed hands in
between fails an update, or a delete with a `.condition()`, with
`ConcurrentModification` on the unique fields; a put, an `upsert`, a
transaction put and an unconditioned delete plan the write again from a
fresh read (up to three attempts, then `ConcurrentModification`). `purge` releases the sentinels of the live item and of
every tombstone, each only if owned. Each sentinel a write would release costs
one consistent `GetItem`. An update that changes the value of a unique
constraint with a `ttl` now gives the new sentinel that expiry, as a put does
(it was written without one).

**`upsert` that reads first.** One `UpdateItem` can't write, rotate or check a
sentinel, or snapshot the item it replaces, so `upsert` of an entity with
unique constraints or `versioned: { retain: true }` reads the item once first.
(A retain entity's upsert used to write no snapshot at all.) A missing item is
created with its sentinels and snapshot. An existing item is updated from that
same read: sentinels rotate for changed unique values and are left alone for
unchanged ones, the replaced item is snapshotted, under the update's version
and incarnation guards (versioned) or attribute guards (unversioned). The whole
input is validated either way, so an `upsert` missing a required field fails
with a `ValidationError` even when the item exists. A concurrent create or
delete in between is retried the other way, and a sentinel release whose
reservation changed hands is planned again from a fresh read, as a put's is; a
concurrent change of the item itself fails the upsert, as it fails an update.
A race lost on every attempt fails
with `OptimisticLockError` or `ConcurrentModification` (never a
`ConditionalCheckFailed` you didn't ask for), and a value another item holds
with `UniqueConstraintViolation`. Its errors name the `upsert`. An `upsert`
whose input omits a defaulted index composite also reads first: it stores the
default only when it creates the item and keeps the stored value otherwise, on
every entity (a plain upsert used to overwrite the stored value with the
default). Other upserts are a single `UpdateItem`, as before.

**Transactions.** In `Transaction.transactWrite` and `EventStore`
`additionalItems`, a `put` of a versioned or unique-constrained entity is
written exactly as the entity's own `put` writes it: the item is read, a
replaced item continues its version, incarnation and `createdAt` and is
snapshotted, changed sentinels rotate (releasing only owned ones), and a
re-created retain item continues after its history — all in the one
transaction. A race between the read and the transaction cancels it, and it is
built and written again. A taken unique value is a `UniqueConstraintViolation`
from both; only an op's own condition is `TransactionCancelled` from
`transactWrite` and `AdditionalItemConditionFailed` from `append`.

Both are checked before anything is sent. DynamoDB allows one operation per
item in a transaction, and the reasons it gives for a repeated item can read as
a lost race, so the transaction was retried and misreported (as
`OptimisticLockError`, or a `DynamoValidationError`, depending on the backend).
Now any item touched twice, counting the sentinels and snapshots an op adds
(two puts that swap unique values touch the same sentinels), fails with a
`ValidationError` naming the entity and both ops, and nothing is sent. So does
an `additionalItems` op that repeats an event or the idempotency sentinel of the
append. A transaction whose items pass DynamoDB's 4 MB (4,194,304 bytes) fails
with a `ValidationError` naming its largest item, instead of DynamoDB's bare
`ValidationException`. The size is a lower bound by DynamoDB's item-size rules
(numbers count a byte per two significant digits, plus one, and zero one byte;
list and map overheads aren't counted; an update counts only its key; a retain
put counts twice), so a transaction DynamoDB would accept is never refused. Deletes of `unique`, retain and `softDelete` entities
are still refused (`EDD-9048`), and `Batch.write` still sends versioned puts as
create-only transactions (below).

**Error channels.** Compared with 1.22.0, these operations declare new errors.
Review `catchTag` handlers and exhaustive matches on them:

| Operation | New in its error channel |
|-----------|--------------------------|
| `put`, `create` | `OptimisticLockError`, `ConcurrentModification`, `TransactionOverflow` |
| `upsert` | `UniqueConstraintViolation`, `OptimisticLockError`, `ConcurrentModification`, `TransactionOverflow` |
| `update`, `patch` | `ConcurrentModification`, `UpdateAppliedButUnreadable`, `TransactionOverflow` |
| `delete`, `deleteIfExists` | `OptimisticLockError`, `ConcurrentModification`, `ValidationError`, `TransactionOverflow`, `DeleteAppliedButUnreadable` |
| `restore` | `ItemNotDeleted`, `TransactionOverflow` |
| `Transaction.transactWrite` | `OptimisticLockError`, `ConcurrentModification` |
| `EventStore` `append`, `commandHandler` | `UniqueConstraintViolation`, `OptimisticLockError`, `ConcurrentModification` |
| Aggregate `create` | `ConditionalCheckFailed` |

`TransactionOverflow` could already be raised when an item's own transaction
would pass 100 items; it is now declared. `GeoIndex.bind`'s `put` declares the
errors the entity's `put` raises.

**`Batch.write` of a `versioned` entity.** Its puts are sent first, as
create-only `TransactWriteItems` of up to 100 items, each conditioned on
`attribute_not_exists`; a chunk also closes before it would pass DynamoDB's
4 MB transaction payload. There is no read, so there is no race window. A batch
that touches a versioned put's item more than once is refused with a
`ValidationError` before anything is written. A put
that would replace an existing item cancels its whole chunk, so nothing in that
chunk is written, and fails with a `ValidationError`. Earlier chunks may
already have been written, since `Batch.write` was never atomic across chunks,
and the batch's other requests aren't sent. Each chunk costs twice the write
capacity of a batch write. Contention cancellations (`TransactionConflict`,
throttling) are retried with the batch's backoff settings; any other
cancellation is a `DynamoError` that keeps each reason's message and the SDK
exception. Puts of other
entities, and deletes, are still plain `BatchWriteItem` requests.

### History of items that share a partition

An entity whose primary sort key has composites keeps several items in one
partition. Their version snapshots and soft-delete tombstones used to share one
key space (`$app#v1#line#v#0000001`, `$app#v1#line#deleted#<timestamp>`), so
siblings shared one version sequence, a second item's history collided with
the first's, `deleted.get` and `restore` found the partition's latest
tombstone rather than the item's, and `purge` removed every sibling. Each item
now has its own: its history keys carry the composite part of its sort key
after the marker (`$app#v1#line#v#line_a#0000001`,
`$app#v1#line#deleted#line_a#<timestamp>`), and `versions`, `getVersion`,
`deleted.get`, `restore`, the version a re-created item continues from, and
`purge` all key by the item. `deleted.list` still lists the partition's
tombstones, every item's. An entity without sort key composites writes and
reads exactly the keys it did.

History an earlier release wrote for such an entity keeps its old keys and
stays readable. A row under the partition-wide keys belongs to the item whose
key its stored composites compose, and every reader of one item's history
reads those rows too: `versions` and `getVersion`, `deleted.get` and `restore`
(which restores from such a tombstone and consumes it), `deleted.list`, the
version an item created again continues from, and `purge`. A version held both
ways is read from the item's own row; of two tombstones, the later one wins.
Reading it costs one keys-only `Limit 1` query of the partition's unsegmented
range, per `versions`, `deleted.get`, `restore` and `create` (and per
`getVersion` that misses the item's own key: one more `GetItem`); only when that
finds a row is the range read in full. `versions` then reads the partition's
history (and filters it, after one more keys-only query of the item's own
range); otherwise it reads the item's own range.

### Nested sub-aggregates

A sub-aggregate bound inside another sub-aggregate now works end to end
(`create`, `get`, `list`, `update`, `delete`). Before, it was written but failed
to read (`Missing key at ["club"]["squad"]`). The nested level inherits its
parent's discriminator, its sort keys are prefixed with the parent's
discriminator values, and it is its own transaction group, so `update` rewrites
only the inner group that changed. Sub-aggregates bound directly on the root
keep their keys.

A nested binding that reuses a discriminator attribute it inherits from its
parent (`{ clubNo: 9 }` inside `{ clubNo: 1 }`) would overwrite the parent's
value on the inner rows. `Aggregate.make` now rejects it with `EDD-9056`.

Fixes #133.
