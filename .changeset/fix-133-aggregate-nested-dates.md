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
  `NumberFromString` fields.
- **Keys are unchanged** for every existing entity and aggregate shape: `pk`,
  `sk`, GSI, unique, version, soft-delete, time-series, collection and
  list-index keys are composed byte-for-byte as before.
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
  complete item, which the library creates through `create`. `patch()` is
  unchanged.
- **Good news if you enabled `versioned` on an existing table.** Items written
  before the entity was versioned read as version 0 on every path, and
  `expectedVersion(0)` addresses them. Their first versioned write conditions
  on no version existing, adds the incarnation token and writes version 1, and
  their retain snapshot is `v#0000000`. A race on that first write is an
  `OptimisticLockError`. Soft delete and restore work on them.
- **More updates are refused with a `ValidationError`**: a `.set()` that changes
  a primary-key composite (silently ignored before), a `.set()` that changes an
  immutable field (restating its current value is fine), and the path
  operations on index composites and unique fields listed under "Updates and
  deletes".
- **`returnValues` is honoured, and typed by its mode.** `"none"` now returns
  `undefined` and `"updatedOld"` / `"updatedNew"` return a partial of the
  attributes written, on every update path. A retain update with `"allOld"`
  now returns the replaced item rather than the new one.
- **Versioned entities get a hidden attribute.** `__edd_i__` is set on create
  and added to existing items on their next guarded write. Decoded models never
  include it, but raw readers, `asNative` and DynamoDB Streams consumers will
  see it.
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
with `OptimisticLockError` on a versioned one. Soft delete and a hard delete
with unique constraints are guarded the same way. `restore` fails with
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
its size.

**Incarnation token.** Versioned entities carry a hidden `__edd_i__` attribute,
set on create and backfilled on the next guarded write. It is never in decoded
models (only in `asNative`). Version-checked writes require it, so an item
deleted and recreated at the same version is never mistaken for the original.

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
first (a unique-field change and the like). `patch()` is unchanged.

**Decoding defaults.** Fields with `Schema.withDecodingDefault` now survive on
read: a `put` that omitted one used to write the item and then fail with a
`ValidationError`. A defaulted `DateTimeUtc` is stored as an ISO string. A
defaulted key composite (primary, index or unique field) that a write omits is
stored with its default, and keys are composed from it. Other defaulted fields
are still not stored, and the default is applied on read.

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
  climbed back to version `n`: versions restart at 1, so it takes `n − 1`
  updates after the recreate.

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
