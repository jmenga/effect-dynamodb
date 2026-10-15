---
"effect-dynamodb": minor
"@effect-dynamodb/schema": minor
"@effect-dynamodb/geo": minor
"@effect-dynamodb/language-service": minor
---

Projections accept optional checkpoint, instance, map and revision fields (#158). A read model that adopts a projection over existing rows can declare the projection's fields with `Schema.optional`: `checkpoint` and `revision` on `projection`; `checkpoints.field`, a source's `field` and `instanceField`, and `revision` on `multiProjection`. An absent field reads as no checkpoint, unowned, no entries or no revision. A single-source projection without a `revision` now guards its first write on such a row with `attribute_not_exists` on the checkpoint field; it previously retried until it failed. The checkpoint map is written only when it has entries or the row already had it, so a row gains only the fields the projection set.
