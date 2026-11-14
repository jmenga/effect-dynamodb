---
"effect-dynamodb": minor
"@effect-dynamodb/schema": minor
"@effect-dynamodb/geo": minor
"@effect-dynamodb/language-service": minor
---

Add `.keepRefs()` to updates, for reassigning one ref of an index key that holds two refs' IDs. `db.entities.Selections.update(key).set({ season, series, teamId }).keepRefs({ playerId })` keys every index the kept ID is a composite of, as `.set({ playerId })` would, but doesn't fetch the player again or rewrite its stored copy. The update is conditioned on the row holding that player, so it fails with `ConditionalCheckFailed` where the row holds another (in `Transaction.transactWrite`, the transaction is cancelled). It adds no read. Unbound updates take it as `Entity.keepRefs()`. Naming something other than a ref ID is refused with `EDD-9166`, and keeping a ref the same update reassigns or removes with `EDD-9167`.

An update that reads the row first, such as one on a `versioned: { retain: true }` entity or one that changes a unique field, now composes each index key it touches (one holding a field it sets or removes) from the refs the row holds, as a `put` of the row would. Before, it took each ref's ID as missing and truncated a key holding one: `.set({ season })` on a key `[season, series, teamId, playerId]` dropped both IDs. A key the update doesn't touch stays as stored. On an unversioned entity, such an update is conditioned on each of those refs still being the one it read, so a ref reassigned between its read and its write fails it with `ConcurrentModification`, as a changed field does. Run `db.tables.<Table>.rekey({ repairIndexKeys: true })` to rewrite keys left that way.
