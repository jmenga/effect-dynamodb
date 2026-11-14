---
"effect-dynamodb": patch
"@effect-dynamodb/schema": patch
"@effect-dynamodb/geo": patch
"@effect-dynamodb/language-service": patch
---

A ref the model declares nullable (`team: Schema.NullOr(Team).pipe(DynamoModel.ref)`, or `team: Schema.NullOr(Team)` configured `{ ref: true }`) can now be written and read. Up to 1.42.1 its ID took no `null` (`put` failed with `Expected string at ["teamId"]`), and a row holding `null` failed every read with `Expected object`, an aggregate edge copying such a row included. It now behaves as an optional ref, with `null` stored where the optional form stores nothing: `put`, `create` and `upsert` take `teamId: null`, fetch nothing, and write no key of an index keyed by the ID and no unique constraint reservation; `.set({ teamId: null })` detaches the ref as `.remove(["team"])` detaches an optional one, and `.set({ teamId })` attaches it. `Entity.Input`, `Entity.Create` and `Entity.Update` type the ID `string | null`. A `Schema.UndefinedOr` ref's ID takes `undefined`, which stores nothing. A nullable ref's ID can't be a primary key composite: `Entity.make` refuses it with `EDD-9169`. Requests for refs declared without `null` are unchanged.

A path write of a whole ref below a union on the way (`pathSet(["child", "child", "child"], club)` beneath refs declared `Schema.NullOr`) is now stored in the referenced entity's storage. Up to 1.42.1 it was refused when that entity stores a date in epoch form.
