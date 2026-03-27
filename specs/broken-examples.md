# Spec: Broken Examples — guide-indexes.ts & version-control.ts

## guide-indexes.ts

**MDX**: `packages/docs/src/content/docs/guides/indexes.mdx`
**Example**: `packages/effect-dynamodb/examples/guide-indexes.ts`
**Status**: FAIL (2 distinct issues)

### Issue 1: Wrong attribute name in SubTasks entity (FIXED)

The `SubTasks` entity's `assignments` index referenced `employeeId` in the composite:
```ts
pk: { field: "gsi2pk", composite: ["employeeId"] }
```
But the `Task` model uses `assigneeId`, not `employeeId`.

**Fix**: Changed to `composite: ["assigneeId"]` in both example and MDX.

### Issue 2: v2 entity-centric table creation missing GSIs (NOT FIXED — library bug)

When using `DynamoClient.make({ entities: { Tasks } })` (v2 entity-centric without explicit `tables`), the `create()` method on `db.tables["name"]` only creates `pk`/`sk` — **no GSIs**. This is because `buildTableOperations()` uses a hardcoded schema, while `buildTableOperationsFromTable()` (used when `tables` are passed explicitly) derives the full schema from entity definitions.

**Root cause**: `DynamoClient.ts:1080` — when tables are auto-discovered from entity tags (no explicit `tables` config), it uses `buildTableOperations(tableConfig.name, client)` which lacks entity context.

**Impact**: Any example using the v2 pattern without explicit `tables` will create tables without GSIs, causing runtime failures on index queries.

**Recommendation**: Either fix `buildTableOperations` to accept entity definitions, or document that v2 entity-centric users must pass `tables` explicitly for `create()` to work correctly.

---

## version-control.ts

**MDX**: `packages/docs/src/content/docs/tutorials/version-control.mdx`
**Example**: `packages/effect-dynamodb/examples/version-control.ts`
**Status**: FAIL (2 distinct issues)

### Issue 1: Repository model missing `username` field for collection PK (FIXED)

The `owned` collection groups Users and Repositories by `username`. Users have `username` as a model field. The Repositories `owned` index used `composite: ["username"]` but Repository model only had `repoOwner`, not `username`.

**Fix**: Added `username: Schema.String` to Repository model, and added `username` values to seed data. Updated both example and MDX.

### Issue 2: Collection accessor case mismatch (NOT FIXED)

The example accesses `db.collections.Owned!({...})` (capitalized) but the collection name in entity definitions is `"owned"` (lowercase). The library stores collection names verbatim — no capitalization.

The correct access would be `db.collections.owned!({...})`. Similarly for `db.collections.Managed!` → `db.collections.managed!` and `db.collections.Activity!` → `db.collections.activity!`.

**Impact**: All collection queries in the example fail at runtime with `TypeError: db.collections.Owned is not a function`.

**Status**: NOT FIXED — requires renaming all collection accesses throughout the example and MDX, and verifying the full flow works end-to-end.
