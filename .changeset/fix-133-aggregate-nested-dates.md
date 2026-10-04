---
"effect-dynamodb": patch
"@effect-dynamodb/schema": patch
"@effect-dynamodb/geo": patch
"@effect-dynamodb/language-service": patch
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

- **Keys are unchanged** for every existing entity and aggregate shape: `pk`,
  `sk`, GSI, unique, version, soft-delete, time-series, collection and
  list-index keys are composed byte-for-byte as before. Existing rows stay
  addressable.
- **Some attributes change stored type** on their next write, listed under each
  section below. For example, an optional `NumberFromString` holding `5` was
  stored as `{ "N": "5" }` and is now `{ "S": "5" }`, and a nested self date was
  a map (`M`) and is now a string or number. Until old rows are rewritten, a
  filter on such an attribute (a `filter` expression, or a `filterBy` predicate,
  which sees the stored value) can match old and new rows differently, and
  DynamoDB Streams consumers see the attribute change type.
- **No backfill is performed.** Old rows read correctly as they are (with the
  exceptions in the next point), and are rewritten in wire form when they are
  next written. For an aggregate that means the next `update` that changes the
  row's group (the root item or its sub-aggregate); an update that changes
  nothing writes nothing.
- **Values that were lost stay lost.** A domain object with no enumerable state
  was stored as a map holding no value: a `Schema.Date` (`{M:{}}`), a `URL`, a
  `Duration`, a `BigDecimal`. These cannot be recovered, and reading them fails
  with a `ValidationError`. So does a raw value an entity path update wrote to a
  transform field (a number on a `NumberFromString` field, a map on a
  `DateTimeUtcFromString` field), which never read back; rewrite it with `set`.
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
named or offset zone. An optional `BigIntFromString` stored as a number by
earlier versions, which could not be read back at all, now reads as a `bigint`.

**Stored-type changes.** A top-level `Schema.optional(...)` or `Schema.NullOr(...)`
around a non-date transform (such as `NumberFromString` or `BigIntFromString`),
on the root item, an edge item or a `many` element's own fields, is now stored
encoded rather than in its domain form. So is a `NumberFromString` nested inside
a hydrated ref.

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

**Self dates in containers.** A self date (`Schema.DateTimeUtc`, `Schema.Date`,
or one with `storedAs`) inside a `NullOr` or other union, a nullable class
(`NullOr(Stamp)`), an array of a union (`Array(NullOr(date))`), a `Record`
value, or a `Tuple` / `TupleWithRest` / `StructWithRest` was stored as a
`DateTime` map. It is now stored in its wire form (a number where `storedAs`
says so), and existing map rows read back as real `DateTime`s. Transform
schemas such as `DateTimeUtcFromString` already stored their wire form and are
unchanged. A `TupleWithRest` field is also no longer mis-derived as an array.

**Path updates.** `pathSet`, `pathAppend`, `pathPrepend`, `pathIfNotExists` and
the record-based `.append()` (including on versioned entities that retain
snapshots) now encode their value through the schema at the path. Before, they
wrote the raw value: a `DateTime` became a map even on a plain date field, and a
`NumberFromString` value was stored as a number. A map written that way on a
self date field reads back as a real `DateTime`. `ADD`, `DELETE` and `SUBTRACT`
are unchanged. A path the model schema cannot follow, such as one into a
`DynamoModel.ref` field, still writes the value as given.

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
