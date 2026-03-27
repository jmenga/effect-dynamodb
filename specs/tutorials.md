# Spec: Tutorial Reviews

All tutorials reviewed against their backing examples. Examples executed against DynamoDB Local.

## starter
**Example**: PASS
**MDX Issues**:
1. Line 60: "Entities define their primary key only. GSI access patterns are declared as Collections" — stale. Code below shows indexes on `Entity.make()` directly.
2. Line 105: "Collections own GSI definitions — entities stay pure (primary key only)" — incorrect. Indexes are entity-level.
3. Line 108: References `Collections.make` — doesn't exist in the example. Collections are auto-discovered.
4. Lines 114, 183, 186: `DynamoClient.make({ entities, collections })` — `collections` parameter doesn't exist. Should be `DynamoClient.make({ entities })`.
5. Line 161: Comment "via collection" should say "via entity index accessor".
**DX Notes**: Clean introduction otherwise.

## crud
**Example**: PASS
**MDX Issues**:
1. Line 58: "Entities define only their primary key. GSI access patterns are owned by Collections" — stale, contradicted by code.
2. Lines 108-110: References "UsersByRole collection" and "TasksByUser collection" as separate Collection constructs — these are entity-level index accessors.
3. Line 116: `DynamoClient.make({ entities, collections })` — stale `collections` parameter.
4. Line 488: Broken GitHub link — points to `tutorials/crud.ts`, should be `examples/crud.ts`.
5. Line 529: References `db.collections.TasksByUser` — doesn't exist; correct is `db.entities.Tasks.byUser(...)`.
**DX Notes**: None

## human-resources
**Example**: PASS
**MDX Issues**:
1. Line 117: "Employee defines only its primary key. All GSI access patterns are declared via Collections" — stale. Code shows 4 GSI indexes on Entity.make().
2. Line 159: "GSI access patterns defined in Collections below" — these are entity-level indexes.
3. Lines 238-240: References `type: "isolated"` property — doesn't exist in actual code.
4. Line 430: Describes `type: "isolated"` on TasksByProject — no such property.
5. Line 454: "The `Roles` collection on GSI4" should be "The `byRole` index on GSI4".
6. Line 573: Broken GitHub link — `tutorials/hr.ts` should be `examples/hr.ts`.
**DX Notes**: None

## task-manager
**Example**: PASS
**MDX Issues**:
1. Line 127-128: "Employee defines only a primary key. All GSI access patterns are defined via Collections" — contradicted by code with 5 inline indexes.
2. Line 242: "The `Teams` collection" should be "The `byTeam` index".
3. Line 244: "The `Statuses` collection" should be "The `byStatus` index".
4. Lines 488, 517-518, 557: Multiple "collection" references should say "index".
5. Line 654: Broken GitHub link — `tutorials/task-manager.ts` should be `examples/task-manager.ts`.
**DX Notes**: None

## shopping-mall
**Example**: PASS
**MDX Issues**:
1. Lines 114-117: Table references "Units (GSI1)" and "Leases (GSI2)" as collection names — actual index names are `byMall` and `byStore`.
2. Line 346: Broken GitHub link — `tutorials/shopping-mall.ts` should be `examples/shopping-mall.ts`.
**DX Notes**: None

## blog
**Example**: PASS
**MDX Issues**:
1. Line 10: "GSI queries for posts by author and comments by post via Collections" — no collections used; these are entity-level indexes.
2. Line 118: Section heading "Comment Entity and Collections" — no collections in this tutorial.
3. Lines 150, 152: Access pattern table shows "PostsByAuthor (GSI1)" / "CommentsByPost (GSI1)" — actual index names are `byAuthor` and `byPost`.
4. Line 291: Broken GitHub link — `tutorials/blog.ts` should be `examples/blog.ts`.
**DX Notes**: None

## library-system
**Example**: PASS
**MDX Issues**:
1. Line 57: Collections table lists "Categories" as a collection — it's a standalone entity index (`byGenre`), not a collection.
2. Line 253: "Categories described as `isolated` collection" — misleading. No `collection` property on the index.
3. Line 582: Broken GitHub link — `tutorials/library-system.ts` should be `examples/library-system.ts`.
**DX Notes**: Well-structured with 8 clear access patterns.

## batch
**Example**: PASS
**MDX Issues**:
1. Line 203: Broken GitHub link — `tutorials/batch.ts` should be `examples/batch.ts`.
**DX Notes**: Example Console.log says "Atomically created..." but batch writes are NOT atomic. MDX correctly notes this (line 197).

## expressions
**Example**: PASS
**MDX Issues**:
1. Line 8: "Products.filter() for narrowing query results" — actual code uses `.filter()` on BoundQuery, not `Products.filter()`.
2. Line 292: Broken GitHub link — `tutorials/expressions.ts` should be `examples/expressions.ts`.
**DX Notes**: Good coverage of callback and shorthand APIs.

## projections
**Example**: PASS
**MDX Issues**:
1. Line 190: Broken GitHub link — `tutorials/projections.ts` should be `examples/projections.ts`.
**DX Notes**: Uses raw `DynamoClient` access (not gateway) — appropriate for the topic. Could note why raw access is needed.

## scan
**Example**: PASS
**MDX Issues**:
1. Line 201: Broken GitHub link — `tutorials/scan.ts` should be `examples/scan.ts`.
**DX Notes**: None

## event-sourcing
**Example**: PASS
**MDX Issues**:
1. Line 307: Broken GitHub link — `tutorials/event-sourcing.ts` should be `examples/event-sourcing.ts`.
**DX Notes**: Uses older `EventStore.bind()` pattern rather than `DynamoClient.make()` gateway. Consistent between MDX and example.

## unique-constraints
**Example**: PASS
**MDX Issues**:
1. Line 240: Broken GitHub link — `tutorials/unique-constraints.ts` should be `examples/unique-constraints.ts`.
**DX Notes**: None

## updates
**Example**: PASS
**MDX Issues**:
1. Line 205: Broken GitHub link — `tutorials/updates.ts` should be `examples/updates.ts`.
**DX Notes**: Composed update math is verified correct.

## version-control
**Example**: FAIL
**MDX Issues**:
1. Repository model missing `username` field for `owned` collection PK composite (FIXED)
2. Seed data missing `username` on repos (FIXED)
3. Collection accessors use capitalized names (`Owned`, `Managed`, `Activity`) but names are lowercase — runtime TypeError (NOT FIXED)
4. Table Design section shows Repository GSI1 PK as `repoOwner` but actual index uses `username`
5. Line 562: Broken GitHub link
**DX Notes**: Collection field name alignment is error-prone — no compile-time validation.

## gamemanager
**Example**: PASS (cricket.ts)
**MDX Issues**: 13 critical fixes applied — see [gamemanager-tutorial.md](gamemanager-tutorial.md)
**DX Notes**: See detailed critique in gamemanager spec.

---

## Cross-Cutting Issues

1. **Stale "Collections" terminology**: ALL tutorials contain remnants of the old `Collections.make()` API. Prose says "GSI access patterns are owned by Collections" but code shows entity-level indexes. Needs a systematic find-and-replace across all tutorials.

2. **`DynamoClient.make({ entities, collections })`**: Multiple tutorials reference a `collections` parameter that doesn't exist. Correct is `DynamoClient.make({ entities })`.

3. **Broken GitHub links**: ALL tutorials (except starter and gamemanager) link to `tutorials/*.ts` instead of `examples/*.ts`.
