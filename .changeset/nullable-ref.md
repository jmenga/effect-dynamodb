---
"effect-dynamodb": patch
"@effect-dynamodb/schema": patch
"@effect-dynamodb/geo": patch
"@effect-dynamodb/language-service": patch
---

A ref the model declares nullable (`team: Schema.NullOr(Team).pipe(DynamoModel.ref)`, or `team: Schema.NullOr(Team)` configured `{ ref: true }`) can now hold `null`. Up to 1.42.1 it worked with a non-null ID only: its ID took no `null` (`put` failed with `Expected string at ["teamId"]`), and a row holding `null` failed every read with `Expected object`, an aggregate edge copying such a row included. It now behaves as an optional ref, with `null` stored where the optional form stores nothing: `put`, `create` and `upsert` take `teamId: null`, fetch nothing, and write no key of an index keyed by the ID and no unique constraint reservation; `.set({ teamId: null })` detaches the ref as `.remove(["team"])` detaches an optional one, and `.set({ teamId })` attaches it. `Entity.Input`, `Entity.Create` and `Entity.Update` type the ID `string | null`. A `Schema.UndefinedOr` ref's ID takes `undefined`, which stores nothing. Where the primary key is composed from a ref's ID, a non-null ID is written as before, and a `put`, `create` or `upsert` giving `null`, or leaving an optional ref's ID out, fails with a `ValidationError` (`EDD-9169`) and sends nothing; up to 1.42.1 a left-out ID died in key composition. Requests for non-null IDs, and for refs declared without `null`, are unchanged.

A path write of a whole ref below a union on the way (`pathSet(["child", "child", "child"], club)` beneath refs declared `Schema.NullOr`) is now stored in the referenced entity's storage. Up to 1.42.1 it was refused when that entity stores a date in epoch form.
