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
  `EDD-9058`, because a stored number could belong to either member. Store the
  date as a string (the default for a self date) or remove the numeric member.
  A `DynamoModel.configure` `storedAs` override on a union field with more than
  one date member fails with `EDD-9057`; annotate the intended member instead.
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

**Path updates.** `pathSet`, `pathAppend`, `pathPrepend`, `pathIfNotExists` and
the record-based `.append()` (including on versioned entities that retain
snapshots) now encode their value through the schema at the path, as `.set()`
does. Before, they wrote the raw value: a `DateTime` became a map even on a
plain date field, and a `NumberFromString` value was stored as a number. Values
are decoded and re-encoded, so a plain object on a class-typed field is encoded
as that class and a `Schema.Trim` field stores its trimmed form. Class, struct,
record, tuple and union values are always encoded, so their `DateTime`, `Date`
and `Redacted` contents keep their wire form. A value already in the wire form
of a leaf transform with a primitive wire form (`StringFromBase64`,
`fromJsonString`), or an array of them, is stored as given rather than
double-encoded. `ADD`, `DELETE` and `SUBTRACT` are unchanged. A path the model
schema cannot follow, such as one into a `DynamoModel.ref` field, still writes
the value as given.

**Legacy values read back.** The raw values earlier path updates left on
transform fields now read: a number on a `NumberFromString` field, a
safe-integer number on a `BigIntFromString` field, a `DateTime` map on a date
transform. A plain `Schema.BigInt`, stored as a number, now reads back as a
`bigint`.

**Zoned dates.** A self `Schema.DateTimeZoned` with an offset zone (`+05:00`)
now reads back with that offset, wherever it sits in the model; earlier versions
read it back as UTC. Named zones and UTC round-trip as before, and the stored
form is unchanged.

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
