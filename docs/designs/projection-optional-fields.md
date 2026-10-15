# Design: optional checkpoint, instance, map and revision fields (#158)

Builds on `eventstore-projections.md` (#151) and `eventstore-projections-2.md`
(#153–#155).

## Problem

A read model that adopts a projection usually already has stored rows. The
fields the projection adds (a checkpoint, a per-source `instanceField`, the
checkpoint map, the revision) are absent on every existing row, so the model
declares them optional (`Schema.optional`). The field types reject them:

| Type | Used by | Requires |
|---|---|---|
| `CheckpointField<S>` | `checkpoint`, `checkpoints.sources.*.field`, `revision` | `S[K] extends number` |
| `StringField<S>` | `checkpoints.sources.*.instanceField` | `S[F] extends string` |
| `RecordField<S>` | `checkpoints.field` | `S[F] extends Record<string, number>` |

An optional field's type is `T | undefined`, so none of them is accepted. The
only workaround is a second entity whose fields are required, plus sentinels
written back as absent attributes.

## Types

Each type accepts `T | undefined`: it checks the field's type with `undefined`
removed. A field whose type is only `undefined` is still rejected.

```ts
type Defined<T> = Exclude<T, undefined>
export type CheckpointField<S> = {
  [K in keyof S]-?: [Defined<S[K]>] extends [never] ? never
    : Defined<S[K]> extends number ? K : never
}[keyof S] & string
```

`StringField` and `RecordField` follow the same pattern, and `RecordField`
keeps excluding numeric fields.

## Runtime: an absent field

The engine already reads an absent field as described in the issue:

- **Checkpoint:** absent means version 0, so every event applies.
- **`instanceField`:** absent or `""` means unowned, so the first instance to
  arrive adopts it.
- **Map:** absent means no entries.
- **Revision:** absent means the row has none. The write is conditioned on
  `attribute_not_exists(revision)`, and stores `initial`.

There are two gaps on the write side, and both are fixed:

1. **The scalar checkpoint guard on an existing row with no checkpoint.** A
   single-source projection with no `revision` conditions its write on the
   checkpoint it read: `eq: { [field]: stored }`. When `stored` is absent (a
   pre-adoption row), that compiled an equality against `undefined`. It is now
   `attribute_not_exists(field)`, the same as the revision guard.
2. **An empty checkpoint map was always written.** A row whose instances all
   live in field-mapped slots got `checkpoints.field = {}`. The map is now
   written only when it has entries, or when the row already had the attribute.
   A row that had no map and gained no entries keeps it absent.

## What a projection write contains

The write is still a `put` of the row the projection produces, as before:

- the state `evolve` returned (from the state it was given, which is the
  row's decoded model fields);
- plus the fields the projection sets in that write: the checkpoints of the
  instances it advanced, their `instanceField` owners, the map if it is
  non-empty or already present, and the revision.

A field the row didn't have and the projection didn't set stays absent. Field-
mapped slots of sources that didn't advance are carried over only when the
row had them.

## Tests

- **Type tests:** an optional field is accepted in every position (`checkpoint`,
  `{ field, offset }`, `revision`, `{ field, initial }`, `checkpoints.field`,
  `sources.*.field`, `sources.*.instanceField`). A field of the wrong type is
  still rejected.
- **Unit tests:** the scalar guard for a row without a checkpoint is
  `attribute_not_exists`, and a field-mapped-only row writes no map.
- **Connected tests:** adopt a pre-existing row that has none of the fields,
  for a single-source projection (no `revision`) and a multi-source projection.
  Assert on the raw stored item: which attributes are written, and that the map
  stays absent until an instance lands in it.

## Out of scope

Checkpoint semantics are unchanged.

## Release

Minor (1.30.0). The types accept new input, and an empty map is no longer
written.
