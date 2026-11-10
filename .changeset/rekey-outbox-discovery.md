---
"effect-dynamodb": patch
"@effect-dynamodb/schema": patch
---

`rekey` now moves a projection's outbox on a table of its own when the client knows the read model only as a member of another table it binds (`DynamoClient.make({ tables })`). Before, the read model had to be in `entities` or on the table being rekeyed, and the outbox items were reported `unregistered`.

`rekey` also finds an outbox through another handle on the outbox's table (another `Table.make` the layer gives the same name): tables are the physical tables requests go to. A read model whose projections each have an outbox on a table of their own has every one of them moved; before, only the outbox of the projection defined last was found.

When read models of one entity type in different schemas or primary collections had their outboxes on one table, `rekey` gave every item to the read model listed first, which counted the others `unrecognizedKey` and left them unmoved. Each item now moves by the read model its key names, whatever the order. Two read models whose outboxes are on one table and whose keys can be the same (the same schema name and version, primary collection, entity type and key composites) are refused by `DynamoClient.make` and `EventStore.processBatch` (`EDD-9134`): their items would overwrite each other. Two whose keys meet only through a value holding `#` (one led by `shop`, the other by `shop` then `branch`) bind and run as before; `rekey` of their outbox table refuses them with a `ValidationError` before it sends anything, because it reads an item's key back by its key space and couldn't tell whose an item is. That check walks past a composite that can't hold `#`, such as a number, so read models whose keys part after one are moved, each item by its own read model. It also covers projections defined after the client was made. Tables are compared by the physical name requests go to, so two handles on one table are one table. Read models that never meet at either can't be checked, so their key spaces must be kept apart.

A row several members claim, such as an aggregate's row whose entity type an entity also has, was counted `unrecognizedKey` by a member that couldn't read its key back even when another member moved it or found it unchanged. Each row is now counted once, by the member it belongs to, so a report's totals add up to `scanned`.
