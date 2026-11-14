---
"effect-dynamodb": patch
"@effect-dynamodb/schema": patch
"@effect-dynamodb/geo": patch
"@effect-dynamodb/language-service": patch
---

A unique constraint can name a ref's id (`unique: { identity: ["season", "teamId", "playerId"] }` for `refs: { team, player }`), as an index composite does, and the editor completes it. Its sentinel holds the id of the item each record references, and `put`, `upsert`, `insert`, an update reassigning the ref, `delete`, soft delete, `restore`, `transactWrite` and `rekey` all reserve, move or release it. Up to 1.41.0 the id was refused (`EDD-9002`), and naming the ref itself (`"team"`) composed `[object object]` for every record, so the first record took the value for all of them. Naming the ref is now refused at `Entity.make` (`EDD-9172`) and by the type. Sentinels those releases wrote aren't migrated: `rekey({ reservations: true })` reports them as `orphaned`, and `releaseOrphanedReservations` deletes them ([Constraints Over a Ref](https://jmenga.github.io/effect-dynamodb/guides/data-integrity/#constraints-over-a-ref)).
