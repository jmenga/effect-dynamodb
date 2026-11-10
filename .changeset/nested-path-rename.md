---
"effect-dynamodb": patch
"@effect-dynamodb/schema": patch
"@effect-dynamodb/geo": patch
"@effect-dynamodb/language-service": patch
---

A `field:` rename now applies to a path's first segment only, for an update's path operations and a condition as it already did for a filter and a projection. With `count` stored as `renamed`, a path below another field that had a segment spelled `count` was renamed too: `pathSet`, `pathAdd`, `pathAppend` and the other path operations on `["meta", "count"]` wrote a stray `meta.renamed` and left `meta.count`, where `put` stores it, as it was, and a condition on `t.meta.count` tested `meta.renamed`, which no row holds, so the write failed with `ConditionalCheckFailed` whatever the row held. The same went for a path below a `DynamoModel.ref` field. Each now names `meta.count`.

Rows such a path write touched on an earlier release hold the stray property (`meta.renamed`) beside the one it should have changed, and whatever those writes put in it was never applied to `meta.count`. A read of a struct ignores the stray property; a read of a `Schema.Record` returns it as one more entry. A path with no segment below the first spelled as a renamed field sends the same requests as before.

A path does not follow a nested struct's own key encoding (`Schema.encodeKeys`), and never did: below the first segment it names the property as written. One case changes because of that. Where a nested struct encoded a property to the very name a top-level field of the same spelling is renamed to (`meta` encoding `count` as `c`, and a top-level `count` stored as `c`), a path on `["meta", "count"]` reached `meta.c` only because the top-level rename was applied to it; it now names `meta.count`, as a path below any other key-encoded struct always has. Set the whole value (`.set({ meta })`) for such a struct.

`compilePath`, exported from the path builder, returns the new names for a path with segments below the first.
