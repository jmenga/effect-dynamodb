---
"effect-dynamodb": patch
---

A read model's `create` over a projection tombstone now carries the checkpoints and revision of the projection that wrote the tombstone. A read model kept one record of what its tombstones hold, so with several projections that remove rows, the last one defined replaced the others': a `create` over another projection's tombstone dropped its checkpoints, and a late redelivery of the removal then applied again and removed the created row. Each projection's layout is now kept, and `create` uses the one whose fields the tombstone holds. A read model with one projection sends and stores exactly what it did before.
