---
"effect-dynamodb": minor
"@effect-dynamodb/schema": minor
"@effect-dynamodb/geo": minor
"@effect-dynamodb/language-service": minor
---

Aggregate writes are now safe under concurrent writers (#168).

- `aggregate.update` guards every row it writes on the row as it read it, so another writer's change since the read cancels the write, nothing written, and fails with `ConcurrentModification` naming what changed by member path. Its partition read is strongly consistent on a base-table collection; on a collection index it follows `consistentRead`.
- `create` and `update` write in one `TransactWriteItems` when the items fit (100 items, 4 MB), so a change to several sub-aggregates lands whole or not at all. `update` writes only the rows that changed, not whole sub-aggregate groups. Past one transaction, whole groups are packed into several, and the error's `committed` names what landed.
- `Aggregate.make({ versioned: true | { field } })` keeps a version and an incarnation token on the root row. A conflict is an `OptimisticLockError`, and `update(key, fn, { expectedVersion })` applies only at that version (`EDD-9178` on an unversioned aggregate; `EDD-9177` for an option the version can't be kept under).
- `Aggregate.make({ fence: true })` makes every update check the root and `delete` remove the root first, so no update lands on a deleted aggregate; `versioned` implies it (`EDD-9179`). Without it, `delete` reads the partition again and removes the rows a concurrent writer added, unless it finds a root; with the fence, a root found after the root's delete is a `create` that reused the key, and it is left alone.
- `update`'s error type is now `AggregateUpdateError` (`AggregateWriteError | ConcurrentModification | OptimisticLockError`). The library never re-runs the mutation: retry the update, as the aggregates guide shows.
