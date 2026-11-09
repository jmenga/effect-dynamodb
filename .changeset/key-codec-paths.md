---
"effect-dynamodb": minor
"@effect-dynamodb/schema": minor
"@effect-dynamodb/geo": minor
"@effect-dynamodb/language-service": minor
---

An entity whose key composite is a codec that `encode` takes on its own output is now keyed by the value it stores, so every path finds its items. **Rows 1.39.0 wrote for such an entity can't be read or written by key until you run `db.tables.<Table>.rekey()`, whatever `escapeKeys` says.**

These codecs are `Schema.StringFromBase64`, `StringFromBase64Url`, `StringFromHex` and `StringFromUriComponent`, and a custom codec whose `encode` takes what it returns, such as one that prepends a prefix (`x:`) and whose `decode` strips it. A codec whose `encode` refuses its own output, such as `Schema.NumberFromString`, `Schema.Trim` or a date codec, keeps every key byte for byte.

`put` stores `"MiX"` under such a prefix codec as `x:MiX`. 1.39.0 keyed that row by the stored text encoded once more (`x:x:mix`), while every path that composed a key from a caller's values encoded the value once (`x:mix`). The entity's own `get`, `update` and `delete` agreed with `put`, and nothing else found the row. Now `put` and every other path key it `x:mix`, once:

- **Queries and collections find the item.** Index accessors (`db.entities.X.byIndex(...)` and `X.query.byIndex(...)`), `.where()`, `.within()` (a key range, a skip-scan, and a Z-order index's prefix and dimension levels), collections (`db.collections.*` and `Collection.make`), a vector index's `.partition()` and a geo search's composites.
- **History finds the item.** `versions`, `deleted.list`, `history` and `history().where()`.
- **`Batch` and `Transaction` find, check and delete the item.** They take the same domain values, and send the same key they sent on 1.39.0. What changed is that `put` now writes there. On 1.39.0, `Batch.get` and `transactGet` returned nothing for the item, a condition check on it was cancelled, and `Batch.write` and `transactWrite` deletes left it in place.
- **A projection whose read model is keyed by such a codec takes every event.** On 1.39.0 the engine read the row at the once-encoded key, found none, and failed every event after the row's first with `ConcurrentModification`, and a removal tombstoned that key and left the row in place. The row, its tombstone and its outbox items now share one key.
- **`reembed` keeps the vector partition `put` wrote.** On 1.39.0 it rewrote the partition out of the one queries read.

**Before serving traffic on 1.40.0, run `rekey`** on every table holding such an entity, whatever `escapeKeys` says. Until it has run, a `get`, `update` or `delete` of a row 1.39.0 wrote finds nothing, and a `put` of the same key writes a second row beside it, which `rekey` then reports as a conflict (`bothKeys`) and leaves. `rekey` moves every row kind 1.39.0 keyed this way, to the key a write gives it now:

- live items' table keys
- index keys, including Z-order prefix segments, and vector and geo partitions, rewritten in place
- version snapshots and soft-delete tombstones
- time-series events
- a projection's read-model rows

Unique sentinels, and a projection's row tombstones and outbox items, already held the stored text, and keep their keys. A projection row whose new key holds the tombstone 1.39.0 wrote for it is left where it is and reported as a conflict (`taken`).

One `rekey` pass also handles turning `escapeKeys` on: it moves each row straight to the escaped text of the value it stores. The bump is minor: nothing else moves, and no other entity's keys change.
