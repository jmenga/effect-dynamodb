---
"effect-dynamodb": patch
"@effect-dynamodb/schema": patch
"@effect-dynamodb/geo": patch
"@effect-dynamodb/language-service": patch
---

Queries, collections, history, vector and geo searches, `reembed` and projections find an item whose key composite is a codec `encode` takes on its own output, at the key `Entity.put` wrote for it. A prefix codec is one, and so are `Schema.StringFromBase64`, `StringFromHex` and `StringFromUriComponent`.

`put` encodes such a value twice in its key text (`x:x:mix` for `"mix"`). The entity's own `get`, `update` and `delete` compose the same text, but the paths that compose a key from a caller's values applied the encode once and found nothing. They now compose the key through one shared rule, the key form of the value `put` stores, which for every other composite is exactly the key they composed before, so nothing else changes in what is sent or stored.

- **Queries and collections find the item.** Index accessors (`db.entities.X.byIndex(...)` and `X.query.byIndex(...)`), `.where()`, `.within()` (a key range, a skip-scan and a Z-order index's prefix and dimension levels), collections (`db.collections.*` and `Collection.make`), a vector index's `.partition()` and a geo search's composites. A `.within()` row check compares a row's stored value in the same form.
- **History finds the item.** `versions`, `deleted.list`, `history` and `history().where()`.
- **A projection whose read model is keyed by such a codec takes every event.** The engine read the row at the once-encoded key, found none, and failed every event after the row's first with `ConcurrentModification`; a removal wrote its tombstone at that key and left the row in place. It now reads the row, and writes the tombstone, at the key the read model's `put` wrote. Outbox items keep the key text they had.
- **`reembed` keeps the vector partition `put` wrote.** It rewrote it to the once-encoded text, out of the partition queries read. It now writes `put`'s, which also moves back an item an earlier `reembed` moved.

The doubled key text itself is unchanged: rows already stored keep their keys.
