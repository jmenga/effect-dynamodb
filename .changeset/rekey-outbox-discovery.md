---
"effect-dynamodb": patch
"@effect-dynamodb/schema": patch
"@effect-dynamodb/geo": patch
"@effect-dynamodb/language-service": patch
---

`rekey` now moves a projection's outbox on a table of its own when the client knows the read model only as a member of another table it binds (`DynamoClient.make({ tables })`). Before, the read model had to be in `entities` or on the table being rekeyed, and the outbox items were reported `unregistered`.

`rekey` also finds an outbox through another handle on the outbox's table (another `Table.make` the layer gives the same name): tables are the physical tables requests go to. A read model whose projections each have an outbox on a table of their own has every one of them moved; before, only the outbox of the projection defined last was found.

When read models of one entity type in different schemas or primary collections had their outboxes on one table, `rekey` gave every item to the read model listed first, which counted the others `unrecognizedKey` and left them unmoved. Each item now moves by the read model its key names, whatever the order.

Two read models whose outboxes are on one table and whose keys can be the same, for values that hold no `#` and that each composite's type can compose, are refused by `DynamoClient.make` and `EventStore.processBatch` (`EDD-9134`): their items would overwrite each other. That is the same schema name and version, primary collection, entity type and key composites; a number's key text holds no letters but `e` and those of `Infinity`, and a literal union's value is one of its members, so a read model keyed by the number `n` binds beside one keyed by the string `n_x`, as on 1.39.0. Two whose keys meet only through a value holding `#` (one led by `shop`, the other by `shop` then `branch`) bind and run as before.

The outbox table's `rekey` refuses, with a `ValidationError` before it sends anything, two read models whose items it could read as each other's: their leading composites are the same, or the same literal (its reader reads a literal as any text, as it reads a string), or a number followed by the same name. Read models whose keys part after a number, a bigint or a boolean are moved, each item by its own read model. It also refuses a member of the outbox table with a read model's entity type that could read that read model's items as its own and whose primary key isn't the read model's: an entity claims its entity type's outbox items on its table, and moved them by its own key, to a key that wasn't theirs. A member whose primary key is the read model's moves them where the read model would, and isn't refused. The check covers projections defined after the client was made. Tables are compared by the physical name requests go to, so two handles on one table are one table. Read models that never meet at either can't be checked, so their key spaces must be kept apart.

A row several members claim, such as an aggregate's row whose entity type an entity also has, was counted `unrecognizedKey` by a member that couldn't read its key back even when another member moved it or found it unchanged. Each row is now counted once, by the member it belongs to, so a report's totals add up to `scanned`.
