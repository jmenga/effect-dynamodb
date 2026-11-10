---
"effect-dynamodb": patch
"@effect-dynamodb/schema": patch
"@effect-dynamodb/geo": patch
"@effect-dynamodb/language-service": patch
---

A `field:` rename now applies to a path's first segment only, for an update's path operations and a condition as it already did for a filter and a projection. With `count` stored as `renamed`, a path below another field that had a segment spelled `count` was renamed too: `pathSet`, `pathAdd`, `pathAppend` and the other path operations on `["meta", "count"]` wrote a stray `meta.renamed` and left `meta.count`, where `put` stores it, as it was, and a condition on `t.meta.count` tested `meta.renamed`, which no row holds, so the write failed with `ConditionalCheckFailed` whatever the row held. The same went for a path below a `DynamoModel.ref` field. Each now names `meta.count`.

Rows such a path write touched on an earlier release hold the stray property (`meta.renamed`) beside the one it should have changed. A read ignores it. A path with no segment below the first spelled as a renamed field sends the same requests as before.
