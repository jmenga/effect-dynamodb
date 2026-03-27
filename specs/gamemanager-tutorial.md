# Spec: gamemanager.mdx Tutorial Review

**MDX**: `packages/docs/src/content/docs/tutorials/gamemanager.mdx`
**Example**: `packages/effect-dynamodb/examples/cricket.ts`
**Status**: Fixes applied to MDX

## Example Validation

- `npx tsx examples/cricket.ts` — **PASS** (all 3 parts: refs, cascades, aggregate CRUD)

## Issues Found & Fixed

### Critical (code wouldn't compile/run as written)

| # | Location | Issue | Fix |
|---|----------|-------|-----|
| 1 | Phase 1.6 | "Run `pnpm check` — it should succeed" but TS fails with no source files (TS18003) | Removed the claim; deferred check to after first file |
| 2 | Phase 2.3 | Teams entity has no `indexes` — but services reference `Teams.query.byAll()` | Added `byAll` GSI index to entity definition |
| 3 | Phase 2.7 | `TeamService` uses `Query.execute` pipe pattern — doesn't exist on BoundEntity API | Changed to `teams.fetch(query)` pattern |
| 4 | Phase 2.7 | Service destructures `const { Teams: teams } = yield* DynamoClient.make(MainTable)` | Changed to `const db = yield* DynamoClient.make(MainTable); const teams = db.Teams` |
| 5 | Phase 2.7 | `Query` not imported but `Query.execute` referenced | Removed `Query.execute`, replaced with `teams.fetch()` |
| 6 | Phase 2.10 | TeamsHandler list references `query.gender` — Team has no `gender` field | Changed to `query.country` |
| 7 | Phase 2.12 | curl examples use `{"gender": "Male", "league": "ICC"}` — Team model has `{country, ranking}` | Fixed curl payloads to match model |
| 8 | Phase 3.2-3.5 | Entity definitions use `indexes: { primary: {...}, byAll: {...} }` | Separated into `primaryKey: {...}` + `indexes: { byAll: {...} }` |
| 9 | Phase 3.2-3.5 | GSI config uses `index: "gsi1"` | Changed to `name: "gsi1"` |
| 10 | Phase 3.x | All 4 remaining services have same `Query.execute` issue | Applied same `entity.fetch(query)` fix |
| 11 | Phase 4.5 | SquadSelectionService uses `squads.get({ id })` but PK is `{squadId, selectionNumber}` | Changed to composite key methods |
| 12 | Phase 5.5 | MatchService destructures inline from `DynamoClient.make` | Changed to `db.Umpires` / `db.MatchAggregate` pattern |
| 13 | Various | Team creation curls throughout use wrong fields | Fixed all occurrences |

### Remaining (design concerns)

- Tutorial models diverge significantly from cricket.ts backing example (different fields, branded types, gender/league/etc.) — doctest sync impossible for most sections
- SquadSelection REST API design is awkward — composite PK `{squadId, selectionNumber}` doesn't map to `/squads/:id`
- Tutorial is ~2800 lines — could benefit from splitting into multiple pages

### Phase 5 Aggregate Patterns — Verified

All 6 aggregate patterns from Phase 5 tested end-to-end via `examples/cricket-api-test.ts`:

1. **`MatchAggregate.createSchema`** — Decodes input correctly, omits PK composites (`id`), ref fields become ID fields (`venueId`, `teamId`, `coachId`, `playerId`)
2. **`Aggregate.create(input)`** — Hydrates all refs (Team, Player, Coach, Venue), writes atomically via transaction
3. **`Aggregate.get({ id })`** — Queries collection GSI, assembles domain graph with hydrated refs
4. **`Aggregate.update({ id }, cursor.key("name").replace(...))`** — Cursor-based scalar updates work
5. **`Aggregate.update({ id }, cursor.key("team1").key("players").modify(...))`** — Nested mutation with diff-based writes
6. **`Aggregate.delete({ id })`** — Removes all partition items, subsequent get returns `AggregateAssemblyError`

## DX Critique

### Positives

1. `Entity.make()` — clean declarative separation of model from DynamoDB binding
2. `DynamoClient.make(table)` — typed gateway pattern is powerful and productive
3. BoundEntity CRUD — `db.Teams.put()`, `db.Teams.get()` reads naturally
4. Refs/cascades — `DynamoModel.ref` + `Entity.cascade()` work seamlessly
5. Aggregate decomposition/assembly — genuinely novel, impressive feature
6. Derived schemas (`createSchema`, `updateSchema`) — very useful for API payloads

### Friction Points

1. **Two client APIs** — `DynamoClient.make(table)` (flat) vs `DynamoClient.make({ entities })` (namespaced). Tutorial used flat, CLAUDE.md describes namespaced. Pick one for docs.
2. **Query execution split** — Entity defs return `Query<A>` descriptors, BoundEntity has `.fetch(query)` terminals, BoundQuery (v2) has `.collect()` etc. This dual system was the #1 source of tutorial errors.
3. **`Entity.set()` ceremony** — `teams.update({ id }, Entity.set(updates))` — the wrapper feels like boilerplate for the basic case. Developer instinct is `teams.update({ id }, updates)`.
4. **Composite-key entities and REST** — Library provides no guidance for mapping composite PKs to URL params.
5. **`Entity.Create` vs `Entity.Input` naming** — Subtle distinction; could be `CreatePayload` vs `FullInput` for clarity.
6. **Error type proliferation** — 9+ error types to map in HTTP handlers. A convenience combinator for common error→HTTP patterns would reduce boilerplate.
7. **Tutorial/example divergence** — Tutorial introduces models not in backing example, making CI sync validation impossible.
