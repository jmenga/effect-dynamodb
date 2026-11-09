---
"effect-dynamodb": patch
"@effect-dynamodb/schema": patch
"@effect-dynamodb/geo": patch
"@effect-dynamodb/language-service": patch
---

An aggregate `create` no longer dies or drops an id hydrating an edge with an `entity`, and a multi-item op finds an item whose key composite is a codec `encode` takes on its own output.

- **A `many` edge whose element is the entity's own model, given whole, is stored as given.** Its key field (`lineId` of a `Line`) was taken for an id to fetch because its name was `${field}Id`, and `create` died with `Missing composite attribute "lineId"`. Only an element whose field of the entity's name can hold the entity's record (an object, a class, a union holding one, optional or not) is hydrated through `${field}Id`, judged per member of a union by its discriminator. A field declared a scalar (`line: Schema.String`) is never taken for one. Union elements hydrate as they did, at the root and in a sub-aggregate.
- **An entity with no `DynamoModel.identifier` is fetched.** `create` fetched each id under the identifier, or under `id` without one, and died composing the entity's key. It now fetches under the entity's primary key's only distinct composite (an attribute in both halves of the key counts once). That covers `one` and `ref` edges, `many` elements given as ids and elements wrapping the entity, and an entity whose identifier names another field.
- **A number, bigint or `Date` id is fetched.** Only a string was collected, so a number or bigint id was dropped: a required edge failed decoding and an optional edge was created without the entity. An id is now a value of the key composite's type, or of its stored or JSON form (`"5"` of a `NumberFromString`, an ISO string of a `Date`), and the input type and schema take that type.
- **An id of no type of the key composite fails `create` with a `ValidationError` (`EDD-9131`), where it failed with `RefNotFound`.** `"5"` for a number key was fetched under `lineid_5`, a key no `put` writes. The error is now a `ValidationError`, on the error channel, and nothing is fetched. Code that catches `RefNotFound` for such an id no longer sees it: catch `ValidationError` instead, or pass an id of the key's type.
- **An entity keyed by more than one composite fails `create` with a `ValidationError` (`EDD-9129`)** naming the edge. No one id names one of its items. It died the same way. Every edge is judged before anything is fetched or written.
- **`Batch.get`, `Batch.write` deletes, `transactGet`, and `transactWrite` deletes and condition checks compose the key `Entity.put` wrote** for a key composite whose codec `encode` takes its own output (a prefix). `put` encodes such a composite twice; these paths encoded it once, so they found, deleted and checked nothing. Aggregate ref fetches go through the same path. Every other key composes exactly as before.

No stored key changes.
