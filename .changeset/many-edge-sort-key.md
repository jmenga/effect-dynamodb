---
"effect-dynamodb": minor
"@effect-dynamodb/schema": minor
"@effect-dynamodb/geo": minor
"@effect-dynamodb/language-service": minor
---

Aggregate: honour `sk.composite` on `many` edges, so one entity can appear more than once in an aggregate (closes #103)

`ManyEdgeConfig.sk.composite` was declared, type-checked and stored on the edge, but never read — the decompose walk composed each element's sort key from the referenced entity's identifier alone. Two elements sharing a ref composed one sort key, and DynamoDB rejected the entire aggregate write with `ValidationException: Transaction request cannot include multiple operations on one item`.

A declared `sk.composite` is now **authoritative**: it replaces the ref-identifier heuristic rather than extending it, so it decides both uniqueness and the order elements sort in. Entries name attributes on the decomposed element and may use a dotted path to reach a hydrated ref (`"umpire.id"` — hydration replaces the id field with the referenced object, so the bare name no longer exists at the top level).

Two related fixes for the same defect — a `many` edge whose sort key is not derived from anything distinguishing:

- **"Element IS the ref" edges now compose a sort key.** `Schema.Array(Player)` hydrates each element to the entity's own flat fields, and the identifier fallback only recognised a field literally named `id`. An entity whose identifier is `playerId` produced *no* composites, so every element collapsed onto one row. The edge entity's declared `DynamoModel.identifier` field is now used.
- **Colliding sort keys fail as `AggregateDecompositionError`.** Decomposition detects two items composing the same sort key and fails with the aggregate, the edge and the colliding key — instead of an opaque `DynamoValidationError` naming nothing. This is checked before any write, so nothing is persisted.

**Migration.** Sort keys change for two shapes, both of which could not previously hold more than one element:

- edges that already declared `sk.composite` (previously ignored)
- "element IS the ref" edges whose entity identifier is not named `id` — a single-element edge stored as `$app#v1#matchplayer` now stores as `$app#v1#matchplayer#p-1`

Existing rows in either shape are orphaned on the next update. Entity-less `many` edges over plain structs now require a declared `sk.composite`; without one, a multi-element edge fails with `AggregateDecompositionError` rather than silently writing one row per aggregate.
