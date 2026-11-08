---
"effect-dynamodb": patch
"@effect-dynamodb/schema": patch
"@effect-dynamodb/geo": patch
"@effect-dynamodb/language-service": patch
---

An aggregate `create` no longer dies hydrating an edge with an `entity`.

- **A `many` edge whose element is the entity's own model, given whole, is stored as given.** Its key field (`lineId` of a `Line`) was taken for an id to fetch because its name was `${field}Id`, and `create` died with `Missing composite attribute "lineId"`. Only an element that wraps the entity in a field of its own (`{ line, qty }`, given `{ lineId, qty }`) is hydrated through `${field}Id`, as its derived input says.
- **An entity with no `DynamoModel.identifier` is fetched.** `create` fetched each id under the identifier, or under `id` without one, and died composing the entity's key. It now fetches under the entity's primary key's only composite, which is what the id's type already was. That covers `one` and `ref` edges, `many` elements given as ids and elements wrapping the entity, and an entity whose identifier names another field.
- **An entity keyed by more than one composite fails `create` with a `ValidationError` (`EDD-9129`)** naming the edge, before anything is fetched or written. No one id names one of its items. It died the same way.

No stored key changes.
