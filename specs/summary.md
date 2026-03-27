# Documentation & Examples Review — Summary

## Overall Health

| Metric | Result |
|--------|--------|
| Examples passing | **25/27** (93%) |
| Doctest sync | **44/44** (100%) after fixes |
| Type-check | **PASS** (core + examples) |
| Tutorials with issues | **16/16** (all have at least stale terminology) |
| Guides with issues | **8/12** (illustrative blocks drifted) |
| Reference pages with issues | **5/6** (old Entity.make format = runtime errors) |

## Critical Issues (Prioritized)

### P0: Runtime errors in reference docs

The **FAQ**, **migration guide**, and **API reference** all use the OLD `Entity.make()` format:
```ts
indexes: { primary: {...}, byEmail: { index: "gsi1", ... } }
```
This is rejected by the current runtime with error `[EDD-9003]`. The correct format is:
```ts
primaryKey: {...},
indexes: { byEmail: { name: "gsi1", ... } }
```
**Impact**: Any user following these pages gets an immediate runtime error.

### P0: v2 entity-centric table creation missing GSIs (Library Bug)

`DynamoClient.make({ entities })` without explicit `tables` creates tables with only pk/sk — no GSIs. Affects `guide-indexes.ts` and any user following the v2 pattern for table creation.

**Root cause**: `DynamoClient.ts:1080` — `buildTableOperations()` hardcodes schema; `buildTableOperationsFromTable()` (only used with explicit `tables`) derives full schema.

### P1: Stale `Collections.make()` terminology (Systematic)

**ALL 16 tutorials** and **6 of 12 guides** contain remnants of the old `Collections.make()` API:
- Prose: "GSI access patterns are owned by Collections"
- Signatures: `DynamoClient.make({ entities, collections })`
- Names: "PostsByAuthor collection" instead of "byAuthor index"

The `collections` parameter doesn't exist on `DynamoClient.make()`. Collections are auto-discovered from entity index `collection` properties. This needs a systematic search-and-replace.

### P1: Broken GitHub links (Systematic)

**13 tutorials** link to `tutorials/*.ts` instead of `examples/*.ts` in their "Running the Example" sections.

### P2: Collection accessor capitalization

`version-control.ts` uses `db.collections.Owned!` but collection names are stored lowercase (`"owned"`). Runtime TypeError. Affects all collection queries in that example.

### P2: ElectroDB comparison outdated

"Nested property updates: Not supported" — now supported via path-based combinators. Error count "18" should be "20".

## Fixes Applied in This Review

### Examples:
1. `guide-indexes.ts`: `employeeId` → `assigneeId` in SubTasks entity
2. `version-control.ts`: Added `username` field to Repository model + seed data

### MDX:
1. `guides/indexes.mdx`: Synced `assigneeId` fix
2. `tutorials/version-control.mdx`: Synced Repository model + seed data
3. `tutorials/gamemanager.mdx`: 13 fixes (entities, services, handlers, curls)

### Verification:
- 44/44 doctest sync tests pass
- Type-check passes for all examples

## Systematic Fixes Needed (Not Done)

| Issue | Files Affected | Effort |
|-------|---------------|--------|
| Old Entity.make format in reference pages | FAQ, migration, API reference | Medium |
| Stale Collections.make terminology | All 16 tutorials, 6 guides | Large (systematic find/replace) |
| `DynamoClient.make({ entities, collections })` | ~10 files | Small (remove `collections`) |
| Broken GitHub links | 13 tutorials | Small |
| Collection accessor capitalization | version-control.ts + MDX | Medium |
| v2 table creation GSI bug | Library source | Medium (code fix) |
| Outdated ElectroDB comparison | electrodb-comparison.mdx | Small |

## DX Critique — Consolidated

### Strengths

1. **Region-synced examples ensure accuracy.** All 44 doctest-synced regions are correct. The sync infrastructure works.
2. **The typed gateway pattern is immediately productive.** `DynamoClient.make(table)` → typed client → CRUD is clean.
3. **Effect Schema integration is seamless.** Schema.Class → Entity.make() → derived schemas is a strong pipeline.
4. **The aggregate system is genuinely novel.** No comparable feature in other DynamoDB ORMs.
5. **25/27 examples run correctly.** High baseline quality for executable documentation.

### Systemic Pain Points

1. **Two parallel APIs (v1 table shortcut vs v2 entity-centric) without clear guidance.** Docs mix both freely. Need a single canonical pattern or explicit "when to use which" guidance.

2. **Illustrative code blocks drift from the API.** The doctest system only checks region-tagged blocks. Non-tagged blocks (illustrative, "Complete Example" sections) have drifted significantly. Consider either: (a) region-tagging more blocks, or (b) adding a lint pass for common patterns.

3. **API name migration incomplete.** `Collections.make()` → entity-level indexes was a major refactor. Code was updated but prose and illustrative blocks were not. A systematic text pass is needed.

4. **Query execution has too many paths.** Entity defs: `Query<A>` descriptors. BoundEntity: `fetch(query)`, `collect(query)`. BoundQuery (v2): `.collect()`, `.fetch()`. `Query.execute`: requires context. This causes confusion — the gamemanager tutorial used `Query.execute` (wrong path).

5. **Collection PK composite field names must match across entities but aren't validated.** The version-control.ts failure shows how easy it is to get this wrong. A compile-time or Entity.make()-time check would prevent this class of bugs.

### Recommendations

1. **Fix P0 issues immediately** — reference page Entity.make format causes runtime errors for any user following those docs.
2. **Systematic Collections.make() → entity indexes terminology pass** across all MDX files.
3. **Fix broken GitHub links** — simple regex replacement `tutorials/` → `examples/`.
4. **Fix v2 table creation** to derive GSIs from entity definitions.
5. **Add illustrative block validation** — even basic pattern matching (e.g., flagging `Collections.make` in MDX) would catch drift.
6. **Standardize on one client pattern** for all docs, with a brief note about the alternative.
