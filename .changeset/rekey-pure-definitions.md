---
"effect-dynamodb": patch
"@effect-dynamodb/schema": patch
"@effect-dynamodb/geo": patch
"@effect-dynamodb/language-service": patch
---

`db.tables.<Table>.rekey()` judges the rows of an entity made with `@effect-dynamodb/schema`'s `Entity.make` as it judges one made with `effect-dynamodb`'s. `DynamoClient.make` promotes such a definition to bind it, and from 1.37.0 `rekey` looked at the definition as given instead: it found nothing to judge its rows with and counted them `skipped.unregistered`, so it neither moved them, nor counted or repaired their index keys, nor judged their unique sentinels. `rekey` now runs on the entity the client binds, whether the definition is in `DynamoClient.make({ entities })` or only in a bound table's `Table.make({ entities })`.

A table's definition (`Table.definition`, `db.tables.<Table>.create()` and `addVectorIndex`, `VectorSearchEmulation`) names a vector index's filter attribute under the attribute a `field:` rename stores it in for an entity made with `@effect-dynamodb/schema`, as it does for one made with `effect-dynamodb`. It named the domain field, an attribute no write stores. Where entities share a physical vector index, each one's filters are named by the attributes it stores them under before they are merged, made with either package: one entity renaming `category` to `cat` and another storing `category` gives the index both `cat` and `category`. The first sharer's renames named every sharer's filters (`cat` twice), so a filter on the other's `category` was refused.

`DynamoClient.make` checks an entity made with `@effect-dynamodb/schema` as it checks one made with `effect-dynamodb`: a client given one whose packed field names a codec no `Compression` registers (`EDD-9078`), or whose sparse map would read the table's TTL attribute as an entry (`EDD-9140`), is now refused when the client is made. It was made, and failed on the first compressed value or read its rows wrong.
