# Spec: Guide Reviews

All guides reviewed against their backing examples. Examples executed against DynamoDB Local.

## modeling
**Example**: PASS
**MDX Issues**:
1. Line 240: "GSI access patterns are defined separately using `Collections.make()`" — stale. Now defined via entity-level `indexes`. Contradicted by its own code blocks.
**DX Notes**: None

## indexes
**Example**: FAIL (2 issues)
**MDX Issues**:
1. Line 10: "Entities define only their primary key. GSI access patterns are defined separately via `Collections.make()`" — stale. Code on same page shows indexes on Entity.make().
2. Lines 294-310: SubTasks entity used `employeeId` instead of `assigneeId` (FIXED in both example + MDX).
3. Lines 62-63: Empty code block for `task-collections` region — vestige of old Collections.make() API.
4. Lines 353-371: "Defining Collections" section describes the old `Collections.make()` API with `members`, `sk.composite`, etc. — entire section is stale.
5. Lines 386-393: Access pattern table references old collection names.
**DX Notes**: Guide is in a mixed state — code blocks show new entity-centric pattern but narrative describes old Collections.make() pattern. Confusing for readers.

## queries
**Example**: PASS
**MDX Issues**:
1. Lines 13-27: Illustrative intro uses `DynamoClient.make({ entities, collections })` — `collections` param doesn't exist.
2. Lines 51-52: Accessor table shows `Collections.make(...)` — old API.
3. Lines 86-96: Illustrative code passes `collections: { TenantMembers }` — old API.
4. Lines 244-291: "Complete Example" imports `Collections` and passes `collections:` — old API.
**DX Notes**: All region-tagged (synced) code blocks are correct. Issues are exclusively in illustrative blocks.

## expressions
**Example**: PASS
**MDX Issues**:
1. Lines 292-313: Illustrative "Entity Query Accessors" uses old `indexes: { primary: {...} }` format with `index:` instead of `name:`. Also shows `Tasks.query.byProject(...)` (entity def accessor) instead of `db.entities.Tasks.byProject(...)` (BoundEntity accessor).
2. Lines 20-23: `Entity.filter()` and `Entity.select()` described as namespace functions — they're methods on entity definitions.
**DX Notes**: Region-tagged blocks correct. Issues in illustrative blocks only.

## testing
**Example**: PASS
**MDX Issues**:
1. Lines 331-333: Illustrative Vitest block uses `collections: { EmployeesByEmail, TasksByProject }` — old API.
**DX Notes**: Region-tagged blocks correct.

## streams
**Example**: PASS
**MDX Issues**: None found.
**DX Notes**: None

## lifecycle
**Example**: PASS
**MDX Issues**:
1. Line 309: Illustrative "Complete Example" uses `DynamoClient.make({ entities, collections: { EmployeesByTenant } })` — old API.
2. Lines 82, 312: References `db.collections.EmployeesByTenant(...)` — phantom collection that wouldn't be auto-discovered (no `collection` property on the entity index).
3. Illustrative code omits `EmployeesReserve` entity that exists in the actual example.
**DX Notes**: The `v()` helper for accessing `version` field is a workaround — could note why the cast is needed.

## aggregates
**Example**: PASS
**MDX Issues**: None found.
**DX Notes**: None

## geospatial
**Example**: PASS
**MDX Issues**:
1. Line 98: Configuration table describes `index` field as "Name of the collection" — should be "Name of the entity index".
**DX Notes**: None

## data-integrity
**Example**: PASS
**MDX Issues**: None found.
**DX Notes**: None

## advanced
**Example**: PASS
**MDX Issues**: None found.
**DX Notes**: None

## validations
**Example**: N/A (no backing example file)
**MDX Issues**: None found. All 6 EDD validation codes verified against language service source.
**DX Notes**: None

---

## Cross-Cutting Issues

1. **Stale Collections.make() references**: modeling, indexes, queries, expressions, testing, lifecycle guides all reference the old `Collections.make()` API in narrative text or illustrative code blocks.

2. **Illustrative vs synced code blocks**: All region-tagged (doctest-synced) code blocks are correct. Issues are exclusively in illustrative code blocks (no `region`/`example` attributes) that are not sync-checked and have drifted from the API.

3. **Old Entity.make() format in illustrative blocks**: Some guides show `indexes: { primary: {...} }` with `index:` key — should be `primaryKey:` + `indexes:` with `name:` key.
