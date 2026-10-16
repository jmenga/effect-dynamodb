# Design: projection rows read through a configured model (#160)

Builds on `eventstore-projections-2.md` (the row engine).

## Problem

The row engine reads a row raw, decodes it through the entity, and keeps only
the model's fields: that is the state `evolve` receives and results carry. The
field list comes from `modelFields(readModel.model)`, which reads
`model.fields`.

A `DynamoModel.configure`d model is a `ConfiguredModel` wrapper: its schema
sits on `.model`, and the wrapper has no `fields`. So `modelFields` returned
`undefined` and the engine kept the whole decoded item, which includes `pk`,
`sk`, `__edd_e__`, GSI keys and timestamps' storage attributes. The state is
typed as the model but carried storage attributes at runtime, and they reached
consumers through results such as the stored row of an already-applied event.

The same lookup backs the `projection` / `multiProjection` check that each
named checkpoint, instance, map and revision field is a model field
(`[EDD-9081]`). For a configured model the check was skipped.

## Fix

`modelFields` unwraps a `ConfiguredModel` to its schema, then reads its
fields through the shared `getSchemaFields` accessor (`Schema.Struct` and
`Schema.Class`). `Hidden` fields stay in the list: they are model fields, and
the engine decodes them (`decodeMarshalledItem`) so a write keeps them.

With that:

- A row read through a configured model holds exactly the model's fields
  (domain names, after `configure`'s renames are decoded back).
- The field-name check applies to configured models too.

## Tests

- **Unit (in-memory), single-source and multi-source:** a configured read model
  (with a renamed field and a `Hidden` field). The state an already-applied
  redelivery returns, and a `catchUp`, have keys equal to the model's fields.
  `Hidden` fields are included, and storage attributes are absent.
- **Make-time check:** a configured model naming a field it doesn't have
  throws `[EDD-9081]`.
- **Connected:** the same row-shape assertion against DynamoDB Local.

## Release

Patch (1.30.1): a fix with no API change.
