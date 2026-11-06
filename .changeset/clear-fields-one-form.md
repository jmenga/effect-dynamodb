---
"effect-dynamodb": minor
"@effect-dynamodb/schema": minor
"@effect-dynamodb/geo": minor
"@effect-dynamodb/language-service": minor
---

Clearing a field has one form and can't leave a row unreadable. `.set({ field: undefined })` is `.remove(["field"])`, so it releases a unique value (it kept the sentinel before) and removes the index keys built from the field. Under `preserve` that is a change: the key goes, where it used to be left behind holding a value the row no longer had.

Clearing a field no row can be without is refused with a `ValidationError` before anything is sent, for `.set`, `.remove`, `pathRemove` and the `.remove` on an `append`. It used to write, after which the row couldn't be read. An update naming what the library stores instead of a model field (another field's stored name, an index key attribute, `__edd_*`, the version, timestamp and TTL attributes) is refused the same way, in every record and path operation. An attribute the model doesn't know stays allowed.

The types follow. `.remove` takes the names of model fields a row can lack, on `BoundUpdate`, `BoundAppend` and `Entity.remove`, and `.set({ required: undefined })` doesn't compile. `updateSchema` refuses `undefined`, and JSON `null`, for such a field. A `string[]` passed to `.remove` no longer compiles, and neither does `Entity.remove` in code generic over the update's payload; use a narrower type, or `.pathRemove([...])` for an attribute the model no longer declares.

DynamoDB can't store `undefined` or an empty set, and those values now have one rule: on a field whose stored side includes one, the value is an absent attribute, and an absent attribute reads back as that value. A required `Schema.ReadonlySet` holding nothing is a row without the attribute, and reads back as an empty set; a required `Schema.UndefinedOr` likewise, reading back `undefined`. `put` and `.set` of an empty set used to throw a defect, `deleteFromSet` emptying a set left a row that couldn't be read, and so did a `put` with `undefined`. This holds at any depth and on every path, including `Batch`, `Transaction`, version snapshots, aggregates and event streams; any other value is stored exactly as before, with no extra reads. Such a field can be cleared by name, with `.remove`. `eq` / `ne` with an empty set are existence tests, and other comparisons with one are refused. An empty set can't be a list element and is refused there; a record entry holding one loses its key.

`.add` takes a set in its types, as it always did at run time, and no longer corrupts the row on a path that reads first (a `versioned: { retain: true }` entity, or an index composite): it stored the text `[object Set][object Set]`. An aggregate `update` changing only a set is now written (any two sets compared as equal, so the change was dropped), and a mutation can hand back the plain state, which holds a set as a list (it was refused).

A value DynamoDB can't store is a `ValidationError` naming the field, sent nowhere, where it used to be a defect from the marshaller: an empty set in a tuple, in a list, in an `.append` operand, in event data, metadata, snapshot state or an outbox effect, and likewise `NaN`, `Infinity` and a number past `MAX_SAFE_INTEGER`, anywhere they reach a write or a vector `.filter`, `.withVector` included. `Expression.condition` and the other `Expression` builders are plain functions, so they throw it at the call, as `UnstorableValue`. A tuple position holding `undefined` is refused too, unless no value follows it in an optional position: the list closed up, so the row read back with its values in the wrong positions, or couldn't be read. A `Schema.Array` holding `undefined` still closes up, as it always has: the put and the read both work, so it stays.

A relative update that breaks a `.check()` still lands, since it can't be judged without a read, but the `ValidationError` now says the update WAS applied and that the stored row no longer matches the model, and names the field. Guard such an update with `.condition()`.

`Entity` and `BoundEntity` each gain a type parameter, last and defaulting to `never`. A type written with the old argument count still compiles.

`Entity.make` refuses a `timeSeries.appendInput` carrying a sharded index's `by` attribute without the composites its key needs beside it (`EDD-9113`), which used to fail on every append with `EDD-9100`.
