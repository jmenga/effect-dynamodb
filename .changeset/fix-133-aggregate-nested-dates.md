---
"effect-dynamodb": patch
"@effect-dynamodb/schema": patch
"@effect-dynamodb/geo": patch
"@effect-dynamodb/language-service": patch
---

Store nested aggregate values in wire form and read the date maps earlier versions wrote (#133)

Aggregates encoded a field before storing it only when the field's own schema
was a transform. A transformed value nested anywhere else was marshalled as the
domain object itself, so a `DateTime` was stored as a map such as
`{ epochMilliseconds, "~effect/DateTime", _tag: "Utc" }` instead of its ISO
string. That affected dates in root arrays
(`Schema.Array(Schema.DateTimeUtcFromString)`), in arrays of classes
(`sessions[].startTime`), in refs hydrated into `many` elements
(`player.dateOfBirth` on a `MatchPlayer` item, at the root or inside a
sub-aggregate), and in `one` / `many` edges declared without an `entity`. Other
transforms were affected the same way, and a `Schema.Date` was stored as an
empty map, losing its value.

Those maps then broke on read:

- Rows written under an Effect 4.0.0 release candidate carry the
  `~effect/time/DateTime` type id and failed on Effect 4.0.0 with
  `Expected DateTime.Utc`.
- Rows written under Effect 4.0.0 decoded as plain objects that only looked like
  `DateTime`s. They were not `Equal` to the real instant and did not work with
  the `DateTime` API.
- A ref in a `many` element annotated with `DynamoModel.ref` could not be read back
  at all, even straight after a fresh write (`Expected string`).

**Writes.** Aggregate values are now stored in their schema's wire form, through
the same encoders as a root scalar date, wherever they are nested. Both ways of
declaring the ref in a `many` element round-trip: `player: Player.pipe(DynamoModel.ref)`,
and the plain class `player: Player` matched by name to the edge's entity.

**Reads.** Date maps written by earlier versions are rebuilt into real
`DateTime` values, whichever type-id key they carry. `Zoned` values keep their
named or offset zone. A `Schema.Date` stored as an empty map holds no value to
recover, and reading it fails with a `ValidationError`.

**More shapes now work.** None of these worked on 1.22.0:

- Dates inside containers other than arrays and classes: `NullOr` and other
  unions (also inside arrays, such as `Schema.Array(Schema.NullOr(date))`),
  `Schema.Record(Schema.String, date)`, tuples, and `Schema.Union([SomeClass, Schema.String])`.
  `update`, even one that changed nothing, failed on these with `Expected string`.
- Unions that mix a date with another type, such as
  `Schema.Union([Schema.DateTimeUtcFromString, Schema.Number])`. `create` threw;
  each value is now stored and read by the member it belongs to.
- A `many` edge whose element is itself an annotated ref
  (`Schema.Array(Player.pipe(DynamoModel.ref))`). `update` failed.
- A `DateTime` in `create` input on an aggregate with a ref edge. It was
  rejected, because the input was copied with `structuredClone`, which reduced
  the `DateTime` to `{ epochMilliseconds }`.

**Ref resolution.** Refs are now resolved by field schema rather than field name.
Before, a nested field that shared a name with a root ref edge (a
`coach: Schema.String` inside an array, next to a root `coach` edge) was decoded
as that edge's entity.

**Keys are unchanged.** `pk`, `sk`, collection and list-index keys are composed
byte-for-byte as before, so existing rows stay addressable.

**Some attributes change stored type.** A few values that earlier versions
stored in their domain form are now encoded:

- a top-level `Schema.optional(...)` or `Schema.NullOr(...)` around a non-date
  transform such as `Schema.NumberFromString`, on the root item, edge items or a
  `many` element's own fields;
- a `Schema.NumberFromString` nested inside a hydrated ref.

For example, an optional `NumberFromString` holding `5` was stored as
`{ "N": "5" }` and is now `{ "S": "5" }`. Both forms read back, but a `list`
`filter` or `filterBy` on such an attribute can match old and new rows
differently until the old rows are rewritten, and DynamoDB Streams consumers
will see the type change. An optional `BigIntFromString` was stored the same way
and those rows could never be read back; they still cannot.

**Known limitation.** A `many` edge with a custom `decompose` that renames
element fields still stores the renamed values in their domain form, so a
`DateTime` there is written as a map. Those values do read back as real
`DateTime`s.

**Migration.** No backfill is needed or performed. Legacy rows read correctly as
they are, and a row is rewritten in wire form the next time an `update` changes
its group (the root item, or the sub-aggregate it belongs to). An update that
changes nothing writes nothing.

Fixes #133.
