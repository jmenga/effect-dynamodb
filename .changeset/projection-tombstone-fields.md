---
"effect-dynamodb": patch
---

A projection's tombstone on a read-model row that other projections with `removal` also feed now keeps their checkpoints and revisions, not only the remover's. Writes that replace the tombstone keep them too: another projection's row from `initial`, a second tombstone, and the entity's `create`. A redelivered event is no longer applied again after another projection removes the row. A tombstone write is now refused for a checkpoint map stored as a sparse map, as the row write already was. Before, the tombstone was stored and `create` over it lost the checkpoints.
