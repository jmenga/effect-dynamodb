---
"effect-dynamodb": patch
"@effect-dynamodb/schema": patch
"@effect-dynamodb/geo": patch
"@effect-dynamodb/language-service": patch
---

`create` over a projection tombstone carries the checkpoints of the projection that wrote it, with its revision one higher. Before, it carried the fields of the projection with `removal` defined last, so over another projection's tombstone it carried nothing, and a late redelivery of the removal applied again and removed the created row. When a projection's tombstones set the table's TTL attribute, `create` never carries it onto the row. Every projection now records the attributes it keeps on a row, each with its role. On a read model one of whose projections has `removal`, a stored attribute that one projection uses in two roles (checkpoint, checkpoint map, checkpoint owner, revision) is refused by the definition that completes the conflict, whatever order they are defined in (`EDD-9133`). Read models without `removal` are not refused, nor are two projections keeping one attribute in different roles. An attribute a projection keeps that is stored as the table's TTL attribute, while a projection's tombstones set it, refuses the projections' writes with a `ValidationError` before anything is sent. A tombstone write is refused for a checkpoint map key a sparse map can't store, as the row write already was. Everything else on a removal path sends and stores exactly what it did before: a tombstone, a projection's row written over one, `create` over the tombstone of the projection with `removal` defined last, and `drain` and `drainPending`.
