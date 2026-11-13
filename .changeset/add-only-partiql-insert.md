---
"effect-dynamodb": minor
"@effect-dynamodb/schema": minor
"@effect-dynamodb/geo": minor
"@effect-dynamodb/language-service": minor
---

Add `Entity.insert`, which writes through a PartiQL `INSERT` so that a role holding only `dynamodb:PartiQLInsert` can add items and IAM stops it changing them. It stores what `put` would store, in one write with no reads (an entity with `refs` still reads each referenced item, as `put` does), and fails with the new `ItemAlreadyExists` when the key is taken. An entity with `unique` constraints sends one `INSERT`-only transaction. `versioned: { retain: true }` is refused (`EDD-9110`). See the [Add-only writes](https://jmenga.github.io/effect-dynamodb/guides/add-only-writes/) guide.

`DynamoClientService` gains `executeStatement` and `executeTransaction`, which a hand-written full mock of the service must add.
