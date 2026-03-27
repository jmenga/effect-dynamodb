# Documentation & Examples Review Specs

Comprehensive review of all effect-dynamodb documentation, examples, and developer experience.

## Final Health Matrix

| Category | Total | Pass | Notes |
|----------|-------|------|-------|
| **Examples** | 27 | **27** | All pass (was 25/27 before fixes) |
| **Doctest sync** | 44 | **44** | All pass |
| **Type-check** | All | **PASS** | Core + examples |

## Fixes Applied

### Library Source:
- **`DynamoClient.ts`**: Fixed v2 entity-centric table creation to derive GSIs from entity definitions (was only creating pk/sk)

### Example Files:
- **`guide-indexes.ts`**: Fixed `employeeId` → `assigneeId` in SubTasks entity
- **`version-control.ts`**: Added `username` field to Repository model + seed data; fixed collection accessor casing (`Owned` → `owned`, `Managed` → `managed`, `Activity` → `activity`)

### Tutorial MDX (16 files):
- **`gamemanager.mdx`**: 13 critical fixes (entity definitions, services, handlers, curls)
- **`version-control.mdx`**: Synced model + seed data + collection accessor fixes
- **14 tutorials**: Fixed broken GitHub links (`tutorials/*.ts` → `examples/*.ts`)
- **All tutorials**: Stale Collections.make() terminology fixes (in progress via background agent)

### Guide MDX (12 files):
- **`indexes.mdx`**: Synced `assigneeId` fix
- **Remaining guides**: Stale Collections.make() terminology fixes (in progress via background agent)

### Reference MDX (6 files):
- **`api-reference.mdx`**: Fixed Table.make signature, Entity.make format (`primaryKey` + `indexes`), Collection section updated for auto-discovery, removed duplicate entry
- **`migration-from-electrodb.mdx`**: Fixed Entity.make format, query patterns, collection example, fluent chaining description
- **`faq.mdx`**: Fixed Entity.make format in single-table design example
- **`electrodb-comparison.mdx`**: Updated nested property updates (now supported), error count 18→20, query/scan patterns

## Spec Files

| File | Scope |
|------|-------|
| [summary.md](summary.md) | Overall findings, prioritized issues, DX recommendations |
| [gamemanager-tutorial.md](gamemanager-tutorial.md) | Gamemanager tutorial deep walkthrough (13 fixes) |
| [broken-examples.md](broken-examples.md) | guide-indexes.ts & version-control.ts root cause analysis |
| [tutorials.md](tutorials.md) | All 16 tutorial reviews |
| [guides.md](guides.md) | All 12 guide reviews |
| [reference.md](reference.md) | Reference pages & getting-started reviews |
