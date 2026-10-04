---
"effect-dynamodb": patch
"@effect-dynamodb/schema": patch
"@effect-dynamodb/geo": patch
"@effect-dynamodb/language-service": patch
---

Store nested aggregate values in wire form and read the date maps earlier versions wrote (#133)

Aggregates encoded only top-level fields before storing them. A transformed value
nested anywhere else was marshalled as the domain object itself, so a `DateTime`
was stored as a map such as `{ epochMilliseconds, "~effect/DateTime", _tag: "Utc" }`
instead of its ISO string. That affected dates in root arrays
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

**Writes.** Every value an aggregate stores is now in its schema's wire form,
through the same encoders as a root scalar date. Both ways of declaring the ref
in a `many` element round-trip: `player: Player.pipe(DynamoModel.ref)`, and the
plain class `player: Player` matched by name to the edge's entity.

**Reads.** Date maps written by earlier versions are rebuilt into real
`DateTime` values, whichever type-id key they carry. `Zoned` values keep their
named or offset zone. A `Schema.Date` stored as an empty map holds no value to
recover, and reading it fails with a `ValidationError`.

**Ref resolution.** Refs are now resolved by field schema rather than field name.
Before, a nested field that shared a name with a root ref edge (a
`coach: Schema.String` inside an array, next to a root `coach` edge) was decoded
as that edge's entity.

**Keys are unchanged.** `pk`, `sk`, collection and list-index keys are composed
byte-for-byte as before, so existing rows stay addressable.

**Migration.** No backfill is needed or performed. Legacy rows read correctly as
they are, and a row is rewritten in wire form the next time an `update` changes
its group (the root item, or the sub-aggregate it belongs to). An update that
changes nothing writes nothing.

Fixes #133.
