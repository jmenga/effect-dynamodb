---
"effect-dynamodb": minor
"@effect-dynamodb/schema": minor
"@effect-dynamodb/geo": minor
"@effect-dynamodb/language-service": minor
---

Hold a read to the write it informs on the three paths that did not (#132).

- An update that sets nothing reads its row consistently in every return mode, so a missing row is `ItemNotFound` (`ConditionalCheckFailed` for `patch`) whatever `returnValues` says. A `.condition()` or `.keepRefs()` on it is now checked: the update's own `UpdateItem` is sent with no update expression, which changes nothing and never creates a row. In `Transaction.transactWrite` such an update adds a `ConditionCheck` on its key, so a row deleted before the commit commits nothing. An immutable field it restates with a different value is a `ValidationError`, as for an update with something to set.
- An update of a row a projection removed (its tombstone) is `ItemNotFound` (`ConditionalCheckFailed` for `patch`) on every path, and writes nothing on the tombstone. An update with a payload used to write onto it and succeed, committing the rest of its transaction.
- In `Transaction.transactWrite`, an update restating an immutable value the row doesn't hold fails with `ValidationError` before anything is sent, as standalone; it was retried as a race and failed with `ConcurrentModification`.
- `purge` queries the item's rows consistently, and on a `unique` entity deletes the live row with the sentinels it owns in one transaction guarded on the row as read, retried from a fresh read when the row changes in between. Its error type gains `OptimisticLockError` and `ConcurrentModification`, for a row that changed under every attempt. A failure of its batch deletes counts the live row the transaction already deleted.
- Cascade updates are conditioned on the target still being indexed under the source. A target deleted or pointed at another source after the cascade's query is skipped in eventual mode, and dropped and the rest resent in transactional mode, instead of being re-created as a partial item or overwritten.
