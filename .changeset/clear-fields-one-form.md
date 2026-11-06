---
"effect-dynamodb": minor
"@effect-dynamodb/schema": minor
"@effect-dynamodb/geo": minor
"@effect-dynamodb/language-service": minor
---

Clearing a field has one form and can't leave a row unreadable. `.set({ field: undefined })` is `.remove(["field"])`, so it releases a unique value (it kept the sentinel before) and removes the index keys built from the field. Under `preserve` that is a change: the key goes, where it used to be left behind holding a value the row no longer had.

Clearing a field no row can be without is refused with a `ValidationError` before anything is sent, for `.set`, `.remove`, `pathRemove` and the `.remove` on an `append`. It used to write, after which the row couldn't be read. An update naming what the library stores instead of a model field (another field's stored name, an index key attribute, `__edd_*`, the version, timestamp and TTL attributes) is refused the same way, in every record and path operation. An attribute the model doesn't know stays allowed.

The types follow. `.remove` takes the names of model fields a row can lack, on `BoundUpdate`, `BoundAppend` and `Entity.remove`, and `.set({ required: undefined })` doesn't compile. `updateSchema` refuses `undefined`, and JSON `null`, for such a field. A `string[]` passed to `.remove` no longer compiles; use a narrower type, or `.pathRemove([...])` for an attribute the model no longer declares.

`Entity.make` refuses a `timeSeries.appendInput` carrying a sharded index's `by` attribute without the composites its key needs beside it (`EDD-9113`), which used to fail on every append with `EDD-9100`.
