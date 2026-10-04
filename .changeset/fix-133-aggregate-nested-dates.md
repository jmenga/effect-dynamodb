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
silently ignored: they returned success and wrote nothing. They are now
applied, with the same encoding and validation as on other entities. The
version snapshot holds the item as it was before the update, and
`expectedVersion` still applies. A path whose parent does not exist fails with
a `ValidationError`.

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
