# CLAUDE.md — Effect DynamoDB ORM

> **Version:** This project targets **Effect v4** (beta as of 2026-02). Some v4 APIs live under `effect/unstable/*` during beta and may change in minor releases. The v3 codebase is preserved at git tag `effect-dynamodb-v3`.

## Project Overview

Effect TS ORM for DynamoDB providing Schema-driven entity modeling, single-table design as a first-class pattern, composite key composition from entity attributes, type-safe index-aware queries with Stream-based pagination, and DynamoClient as an Effect Service with Layer-based dependency injection.

**Status:** All modules implemented. 852 core tests, 56 geo tests, 61 connected tests, 59 language-service tests, 44 doctest tests, 17 examples.
**Design:** `DESIGN.md` — API specification (source of truth for implementation)

## Architecture

### Client Gateway Pattern

`DynamoClient.make({ entities, aggregates?, tables? })` is the **typed execution gateway** — the central pattern of this library. **There is only one form** — the table-shortcut overload was removed; the entity-centric form is canonical.

1. `Entity.make({ model, primaryKey, indexes })` — entity defines domain model + primary key + GSI indexes (with optional `collection` property)
2. `Table.make({ schema, entities: { Users, Tasks } })` — registers entities on a physical table
3. `yield* DynamoClient.make({ entities: { Users, Tasks }, aggregates: { OrderAggregate }, tables: { MainTable } })` — binds the listed entities/aggregates, auto-discovers collections from entity indexes, and returns a typed client with `R = never`
4. Access via `db.entities.*` (CRUD + query accessors), `db.aggregates.*` (bound aggregates), `db.collections.*` (auto-discovered cross-entity queries), `db.tables.*` (table management)
5. Use the typed client inside `Context.Service` make effects for DI and layer-based testing

```
┌─────────────────────────────────────┐
│  DynamoClient.make({ entities, ... })│ ← typed gateway (binds all members, R = never)
├─────────────────────────────────────┤
│  Aggregate / GeoIndex / EventStore  │  ← orchestration (decompose, assemble, diff)
├─────────────────────────────────────┤
│  Collection / Transaction / Batch   │  ← multi-entity coordination
├─────────────────────────────────────┤
│  Entity                             │  ← domain model + primary key + indexes + CRUD
├─────────────────────────────────────┤
│  Table.make()                       │  ← physical table definition (schema + entities)
├─────────────────────────────────────┤
│  DynamoClient (raw service)         │  ← raw AWS SDK operations
└─────────────────────────────────────┘
```

### Adding New Entities

1. Define model with `Schema.Class` (or `Schema.Struct`) — pure domain fields only. Use `DynamoModel.configure(model, { field: { immutable: true } })` for fields that shouldn't change after creation.
2. Create entity definition with `Entity.make({ model, entityType, primaryKey, indexes?, timestamps?, versioned?, softDelete?, unique? })` — primary key + GSI indexes. Use `collection` property on indexes for cross-entity queries.
3. Register entity on a table: `Table.make({ schema, entities: { ..., MyEntity } })`.
4. Access via typed client: `const db = yield* DynamoClient.make({ entities: { MyEntity }, tables: { MainTable } })` → `db.entities.MyEntity.get(...)`, `db.entities.MyEntity.put(...)`, `db.entities.MyEntity.byIndex({...}).collect()`. Collections auto-discovered: `db.collections.myCollection({...}).collect()`.
5. For services: build the typed client inside `Context.Service` make effects for DI and layer-based testing.
6. Add unit tests in `test/` and update integration test if needed.

### Module Structure

```
packages/effect-dynamodb/src/
├── DynamoModel.ts      # Schema annotations (Hidden, identifier, ref) and configure() for field overrides (immutable, field rename, storedAs)
├── DynamoSchema.ts     # Application namespace (name + version) for key prefixing
├── Table.ts            # Table definition: { schema, entities } — registers entities on a physical table
├── Entity.ts           # Entity definition (model + primaryKey + indexes) + typed operations
├── Collections.ts      # Collection auto-discovery from entity indexes + explicit Collections.make() for advanced use
├── KeyComposer.ts      # Composite key composition from index definitions
├── Query.ts            # Query descriptor with combinators (limit, reverse, filter, startFrom, consistentRead)
├── Collection.ts       # Multi-entity query execution with per-entity Schema decode
├── Expression.ts       # Expression types (ConditionInput / UpdateInput / ExpressionResult) + legacy shorthand builders
├── Transaction.ts      # TransactGetItems + TransactWriteItems (atomic multi-item ops)
├── Batch.ts            # BatchGet + BatchWrite with auto-chunking and retry
├── Projection.ts       # ProjectionExpression builder for selecting specific attributes
├── Aggregate.ts        # Graph-based composite domain model (decompose/assemble/diff)
├── EventStore.ts       # Event sourcing with ordered event streams per aggregate
├── DynamoClient.ts     # Context.Service wrapping AWS SDK + DynamoClient.make({ entities, aggregates?, tables? }) typed gateway
├── Marshaller.ts       # Thin wrapper around @aws-sdk/util-dynamodb
├── Errors.ts           # Tagged errors (DynamoError, ItemNotFound, ConditionalCheckFailed, ValidationError, TransactionCancelled, UniqueConstraintViolation)
├── internal/           # Decomposed internals
│   ├── Expr.ts         # Expr ADT — 16 expression node types, ConditionOps, compileExpr, parseShorthand
│   ├── PathBuilder.ts  # PathBuilder — recursive Proxy for type-safe attribute path access
│   ├── BoundQuery.ts   # BoundQuery fluent builder — wraps Query<A> with pre-resolved services
│   ├── EntityOps.ts    # Entity operation intermediates + UpdateState (record + path-based)
│   ├── EntityCombinators.ts # Terminal functions, update combinators (record + path-based)
│   ├── EntityTypes.ts  # Type-level computations for Entity derived types
│   ├── EntitySchemas.ts # Schema derivation (7 derived schemas)
│   ├── TransactableOps.ts # Shared Batch/Transaction helpers (table name resolution, key composition, put-item building)
│   └── ...             # AggregateCursor, AggregateEdges, etc.
└── index.ts            # Public API barrel export
```

### Module Dependencies

```
Aggregate → Entity, Collection, Transaction, Errors (never DynamoClient directly)
Entity → DynamoClient, DynamoSchema, Table, KeyComposer, Marshaller, Expr, Errors
Collections → Entity (type-level for member validation), KeyComposer
Collection → DynamoClient, Entity, Table, Marshaller, Errors
Transaction → DynamoClient, Entity, TransactableOps, Marshaller, Expression, Errors
Batch → DynamoClient, Entity, TransactableOps, Marshaller, Errors
EventStore → DynamoClient, DynamoSchema, Table, KeyComposer, Marshaller, Query, Errors
GeoIndex → Entity, Query (in effect-dynamodb-geo package)
DynamoClient → effect (Context, Layer), @aws-sdk/client-dynamodb, Entity, Collections, Aggregate (for make() binding + collection auto-discovery)
Table → DynamoSchema, Entity (type-level for member registration)
BoundQuery → Query, PathBuilder, Expr (thin typed wrapper over Query<A>)
Expression → Marshaller (types only — shorthand compilation routes through Expr)
TransactableOps → Entity, KeyComposer, Marshaller, Errors (shared Batch/Transaction helpers)
DynamoModel → effect (Schema)
DynamoSchema → (standalone)
KeyComposer → (standalone)
Marshaller → @aws-sdk/util-dynamodb
Projection → (standalone)
Errors → effect (Data)
```

### Data Flow

```
User code → yield* DynamoClient.make({ entities: { Users, Tasks }, aggregates: { OrderAggregate }, tables: { MainTable } })
  → resolves DynamoClient service + TableConfig for each unique table
  → binds the listed entities (CRUD + query accessors from index definitions)
  → binds the listed aggregates (CRUD + list operations)
  → auto-discovers collections from entity index `collection` properties
  → builds table operations for each registered table
  → returns typed client: { entities: { Users, Tasks }, aggregates: { OrderAggregate }, collections: { assignments }, tables: { MainTable } }

db.entities.Users.put(inputData)
  → Schema.decode(Entity.Input) — validate input
  → compose keys (KeyComposer) for primary key + all entity indexes
  → add __edd_e__ + timestamps + version
  → marshall to DynamoDB format (Marshaller)
  → DynamoClient.putItem (or transactWriteItems for unique constraints)
  → Schema.decode(Entity.Record) — decode full item for return

db.entities.Tasks.byProject({ project: "alpha" }).filter(...).limit(10).collect()
  → BoundQuery builder composes Query<A> with combinators (immutable, each returns new BoundQuery)
  → terminal (.collect()) triggers execution:
    → compose PK/SK from composite attributes (KeyComposer)
    → build KeyConditionExpression + __edd_e__ FilterExpression
    → Stream.paginate (automatic DynamoDB pagination)
    → unmarshall → Schema.decode(Entity.Record) per item

db.collections.assignments({ employee: "dfinlay" }).collect()
  → queries each member entity's table (parallel for cross-table collections)
  → groups results by member name: { Employees: [...], Tasks: [...] }
```

### Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| Native build (not wrapping ElectroDB) | Full control over Effect integration, no impedance mismatch |
| Raw AWS SDK (not @effect-aws) | Avoid extra dependency; thin wrapper is simple enough |
| Effect Schema as sole schema system | Native Effect integration, bidirectional transforms, branded types |
| Schema.Class/Struct for models | Pure domain schemas — no DynamoDB concepts in models. Entity derives DynamoDB types |
| DynamoClient.make({ entities, aggregates?, tables? }) as typed gateway | Entity-centric client with namespaced access: `db.entities.*`, `db.aggregates.*`, `db.collections.*`, `db.tables.*`. The table-shortcut overload was removed — entity-centric is the only form. |
| Entities define primary key + GSI indexes | `Entity.make({ primaryKey, indexes })` — entity is self-contained. Collections auto-discovered from `collection` property on indexes |
| Collections auto-discovered from entity indexes | No explicit `Collections.make()` needed. Entities sharing the same `collection` name on the same physical GSI are grouped automatically |
| BoundQuery fluent builder | `.filter().limit().collect()` — reads naturally, type-safe through method chaining, no `asEffect()` needed |
| Aggregates compose entity ops | Never touch DynamoClient. Orchestrate Entity, Collection, Transaction |
| ElectroDB-style composite indexes | `{ index: { name, pk, sk }, composite: [...], sk: [...] }` — GsiConfig with shared PK composites + entity SK composites |
| `__edd_e__` entity type attribute | Ugly name convention avoids collisions with user model fields |
| @aws-sdk/util-dynamodb for marshalling | Proven, maintained; Effect Schema handles validation layer above |

## Repository Structure

pnpm workspace monorepo:

```
├── packages/
│   ├── effect-dynamodb/          # Core library (Entity, Table, Query, etc.)
│   │   ├── src/
│   │   ├── test/
│   │   └── examples/             # Runnable examples — source of truth for doc code snippets
│   ├── effect-dynamodb-geo/      # Geospatial index and search using H3
│   │   ├── src/
│   │   └── test/
│   ├── docs/                     # Documentation site (Astro + Starlight)
│   │   ├── src/content/docs/
│   │   └── e2e/
│   ├── doctest/                  # Doc snippet sync verification (examples ↔ MDX)
│   │   ├── src/                  # MDX extractor, region parser, sync logic
│   │   └── test/                 # Sync, typecheck, and runtime tests
│   └── language-service/         # TS Language Service Plugin (hover tooltips)
│       ├── src/
│       └── test/
├── pnpm-workspace.yaml
├── biome.json
└── package.json                  # Workspace root
```

## Commands

```bash
pnpm build        # Build all packages (tsc)
pnpm test         # Run all tests across workspace
pnpm check        # Type check all packages (tsc --noEmit)
pnpm lint         # Lint + format check (biome check)
pnpm lint:fix     # Auto-fix lint + format issues (biome check --write)
```

All commands run from the repo root.

## Agent Workflow

**All agent work MUST be performed on a Git worktree** — never directly on the user's main checkout.

Use `git worktree add ../effect-dynamodb-<branch-name> -b <branch-name>` (or reuse an existing worktree) so the user's working tree, current branch, and any uncommitted in-flight work remain untouched. This isolation matters because:

- The user routinely has uncommitted WIP on the main checkout for parallel tracks (e.g. `fix/sparse-unique-constraints` alongside an unrelated fix). Agent branch switches on the shared checkout drag that WIP across branches, force repeated `git stash push/pop` juggling, and risk losing changes via stash conflicts or `.DS_Store`-style untracked collisions.
- Worktrees give the agent an independent filesystem path for `pnpm install`, `pnpm test`, and editor state — no contention with whatever the user is running in the main checkout.
- Cleanup is explicit: `git worktree remove <path>` when the PR is merged or abandoned, leaving no orphaned branches on the main checkout.

If the `Agent` tool's `isolation: "worktree"` parameter is available for the task, prefer it. Otherwise, create the worktree explicitly as the first step of any code-modifying task.

## Coding Conventions

### Effect TS Patterns

- **Effect<A, E, R>** — Success, Error, Requirements. Effects are lazy and immutable.
- **Generator style** (`Effect.gen`) for sequential logic; **pipe style** for short transformations.
- **Tagged errors** via `Data.TaggedError` — all errors must be tagged for discrimination. Tagged errors are **yieldable**: prefer `yield* new ErrorClass(...)` over `yield* Effect.fail(new ErrorClass(...))` in generators.
- **Service pattern** — `Context.Service` for all service definitions. Service methods have `R = never`. Tag identifiers use `@package/ServiceName` format.
- **Schema** — `Schema.Class` or `Schema.Struct` for domain models (pure, no DynamoDB concepts). Entity derives DynamoDB-specific types. Use `Schema.decodeUnknownEffect` (not `Sync`) inside effectful code. `Schema.Literals([...])` for literal unions (not `Schema.Literal(...spread)`). `Schema.Union([...])` takes an array. Validation via `.check()` with named check factories.
- **Custom annotations** — Use `Symbol.for()` for identifiers, never string keys. This project uses custom annotations for `DynamoModel.Hidden`, `DynamoModel.identifier`, `DynamoModel.ref`.
- **Dual APIs** — Public library functions transforming a data type must use `Function.dual` for data-first and data-last (pipeable) support.
- **TypeId + Pipeable** — Every data type carries a `TypeId` (unique symbol) and implements `Pipeable` + `Inspectable`. Custom types follow the same triad.
- **Yieldable trait** — `EntityOp`, `EntityDelete`, `BoundPut`, `BoundUpdate`, `BoundDelete` all implement `Pipeable.Pipeable` + `[Symbol.iterator]` (via `Utils.SingleShotGen`) — NOT `Effect.Effect`. They are yieldable in `Effect.gen` (`yield*` works) but cannot be passed to Effect combinators (`Effect.map`, `Effect.flip`, etc.) directly. Use `.asEffect()` to convert to `Effect` when piping to Effect combinators. BoundEntity is the **composition point** — all CRUD methods AND query accessors return fluent builders. CRUD: `db.entities.Users.update(key).set({...}).expectedVersion(3)`, `db.entities.Users.put(input).condition({...})`, `db.entities.Users.delete(key).condition({...})` — every combinator is a method on the builder, no variadic rest-args. Query accessors are injected from collection memberships: `db.entities.Tasks.byProject({...})` returns a `BoundQuery`. `BoundQuery` is a fluent builder: `.filter().select().limit().collect()` / `.fetch()` / `.paginate()` / `.count()`. `scan()` also returns `BoundQuery`.
- **Option over nullable** — `Option<A>` in services and domain logic. Convert at boundaries with `Option.fromNullable`.
- **No tacit style** — always explicit lambdas: `Effect.map((x) => fn(x))`.
- **`run*` at the edge only** — never `runPromise`/`runSync` inside an Effect.
- **Testing** — `@effect/vitest` with `it.effect` / `it.scoped`. Mock `DynamoClient` via `Layer.succeed(DynamoClient, { putItem: mockPutItem, ... })`. Use `Effect.provide(layer, { local: true })` for test isolation.
- **Packages** — Unstable APIs live under `effect/unstable/*`.

### Critical Anti-Patterns

Do NOT:
- Use `Effect.promise` for fallible async — use `Effect.tryPromise`
- Use `Effect.sync` for throwable code — use `Effect.try`
- Use string/generic Error types — use `Data.TaggedError`
- Use `Effect.fail(new TaggedError(...))` in generators — use `yield* new TaggedError(...)` directly
- Have service methods with `R != never` — resolve deps in Layer
- Use `Schema.decodeUnknownSync` in effectful code — use `Schema.decodeUnknownEffect`
- Use `yield* ref` / `yield* deferred` / `yield* fiber` — use `Ref.get`/`Deferred.await`/`Fiber.join` (not Yieldable)
- Use v3 service APIs (`Context.Tag`, `Effect.Service`) — use `Context.Service`
- Use v3 Schema APIs (`Schema.filter`, `Schema.fromKey`, `Schema.Literal`) — use `.check()`, `.withKey()`, `Schema.Literals`
- Put DynamoDB concepts in domain models — keep models pure, Entity handles DynamoDB binding
- Extract `A`/`E`/`R` from entity ops via `Effect.Effect<infer A>` — match against `EntityOp<infer A, ...>` instead

### TypeScript Conventions

- `strict: true`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`
- ESM only (`"type": "module"`, NodeNext module resolution, ES2022 target)
- `type` over `interface` (default). `interface` only for declaration merging.
- Union types over enums. `unknown` over `any`. Named exports only.
- `satisfies` for validation + literal preservation.
- **Branded types** — Effect Schema branded types for domain IDs (e.g., `TeamId`, `PlayerId`).
- **Barrel exports** — `src/index.ts` is the sole public entry point. Namespace exports for modules, direct exports for errors and `DynamoClient`.

### DynamoDB Conventions

**Single-Table Design:**
- All entities share one physical table using structured key values: `$schema#v1#entity_type#attr1_value#attr2_value`
- `$` sentinel prefix, `#` delimiter for ORM/non-ORM coexistence
- Casing (default: `"lowercase"`) applied to the **entire key** including composite attribute values — `"Male"` and `"male"` produce identical keys. Stored attribute values retain original casing.
- `__edd_e__` entity type discriminator on every item, enforced via FilterExpression on all queries
- Index overloading — generic GSI names (gsi1, gsi2) serve different patterns per entity type. Logical names (`byTenant`) map to physical GSI names.
- Item collections group multiple entity types under the same index for cross-entity queries.

**Operations:**
- Always use `ExpressionAttributeNames` + `ExpressionAttributeValues` (many common names are reserved words)
- Pagination handled via `Stream.paginate`. Batch retry handled in `batchGet`/`batchWrite`.
- `ConditionalCheckFailedException` is expected control flow, not exceptional.
- Transactions: up to 100 items, 2x WCU for writes.

**Key Limits:** Max item 400 KB | BatchWrite 25 | BatchGet 100 | Transaction 100 | GSIs 20 | Query/Scan response 1 MB | Per-partition 3,000 RCU / 1,000 WCU

## Documentation Code Examples

**Examples are the source of truth for all documentation code snippets.** Every tutorial and guide MDX page is backed by a runnable example file in `packages/effect-dynamodb/examples/`.

### How it works

1. **Example files** (`examples/*.ts`) contain complete, runnable programs with `// #region name` / `// #endregion` markers around sections that appear in docs.
2. **MDX code blocks** reference their backing example via `region="name" example="filename.ts"` attributes on the code fence.
3. **Sync tests** (`packages/doctest/`) verify that MDX snippet content matches the corresponding example region.

### Adding or updating documentation code

1. Write or update the **example file first** — it must type-check (`tsconfig.examples.json`) and run against DynamoDB Local.
2. Add `// #region name` / `// #endregion` markers around the code section.
3. In the MDX file, add `region="name" example="filename.ts"` to the code fence and paste the region content (minus imports and `Console.log` lines).
4. Run `pnpm --filter @effect-dynamodb/doctest test` to verify sync.

### Example ↔ MDX mapping

| Tutorial/Guide MDX | Example file |
|---|---|
| `tutorials/starter.mdx` | `examples/starter.ts` |
| `tutorials/crud.mdx` | `examples/crud.ts` |
| `tutorials/gamemanager.mdx` | `examples/cricket.ts` |
| `tutorials/human-resources.mdx` | `examples/hr.ts` |
| `guides/modeling.mdx` | `examples/guide-modeling.ts` |
| `guides/indexes.mdx` | `examples/guide-indexes.ts` |
| `guides/index-policy.mdx` | `examples/guide-index-policy.ts` |
| `guides/queries.mdx` | `examples/guide-queries.ts` |
| `guides/expressions.mdx` | `examples/guide-expressions.ts` |
| `guides/timeseries.mdx` | `examples/guide-timeseries.ts` |
| ... (all other tutorials/guides follow the same pattern) | |

### Sync normalization

The sync comparison normalizes content by stripping: `Console.log` lines, blank lines, `assertEq`/`assert` lines, `#region`/`#endregion` markers, leading whitespace, inline output comments (`// →`, `// State:`, etc.), and rewriting import paths. Code blocks without `region`/`example` attributes are illustrative-only and not sync-checked.

### Commands

```bash
pnpm --filter @effect-dynamodb/doctest test           # Sync + typecheck verification
pnpm --filter @effect-dynamodb/doctest test:connected  # Runtime execution (needs DynamoDB Local)
```

## Quality Gates

Before committing:
1. `pnpm lint` — zero lint/format errors (Biome)
2. `pnpm check` — zero type errors
3. `pnpm test` — all tests pass
4. `pnpm --filter @effect-dynamodb/doctest test` — doc snippet sync verification passes
5. `npx tsx examples/<name>.ts` — examples run against DynamoDB Local (`docker run -p 8000:8000 amazon/dynamodb-local`). Run after changes to Entity, Query, Table, DynamoSchema, KeyComposer, Collection, Transaction, or Errors.
6. New modules must have corresponding test files in `test/`
7. New errors must use `Data.TaggedError`
8. New services must follow `Context.Service` pattern
9. New or updated doc pages must have a backing example file with region markers

## PR Conventions

Every PR that resolves a tracked issue **MUST** reference the issue(s) it closes using a GitHub closing keyword (`Closes #N`, `Fixes #N`, or `Resolves #N`) in the PR body. This is non-negotiable — without a closing keyword, the issue stays open after merge and drifts out of sync with reality. A bare `#N` mention (e.g. "relates to #N") does **not** auto-close; use one of the keywords above, one per issue. If a PR only partially addresses an issue, reference it without a closing keyword and say so explicitly in the PR body.

## Release Workflow

This repo uses [Changesets](https://github.com/changesets/changesets) with **fixed lockstep versioning** across the three publishable packages (`effect-dynamodb`, `@effect-dynamodb/geo`, `@effect-dynamodb/language-service`). Publishing is automated: every push to `main` runs `.github/workflows/release.yml`, which detects packages whose `package.json` version is ahead of npm and publishes them via Trusted Publishing (OIDC — no `NPM_TOKEN`).

**There is no "Version Packages" bot PR.** The required process is:

### Bump PRs (Option A — the required workflow)

Any PR that is intended to trigger a release **must run `pnpm changeset version` as part of that PR**. This means the PR includes, in the same commit set:

1. **The feature/fix code change itself.**
2. **A changeset file** (`.changeset/<name>.md`) created with `pnpm changeset` — declares which packages bump and at what semver level.
3. **The result of `pnpm changeset version`**:
   - The changeset file is **deleted** (consumed).
   - Each affected `package.json` has its `version` bumped (lockstep → all three move together).
   - Each affected package's `CHANGELOG.md` is regenerated with the consumed entry.

The typical authoring loop:

```bash
# 1. Make code changes, tests, docs
# 2. Declare the bump
pnpm changeset                          # interactive — pick packages + semver level
git add .changeset/<generated-name>.md
git commit -m "..."

# 3. Apply the bump in this same PR
pnpm changeset version                  # consumes changeset, bumps versions, writes CHANGELOG
git add -A
git commit -m "Version Packages 0.X.0"
git push
```

When the PR merges, `release.yml` detects the version bump, builds, tests, and publishes. No second PR.

### Chore PRs (no release)

CI-only, test-hygiene, or doc-only changes that should **not** trigger a release still need to satisfy CI's "Require changeset or version bump" gate. Add an **empty changeset** (empty frontmatter, no packages listed) as the explicit "no-release" signal:

```markdown
---
---

Chore: <one-line summary>. No version change.
```

### CI enforcement

`ci.yml` runs `pnpm changeset status` on every PR. If it reports any **unconsumed release-declaring changeset** (a file with packages listed in its frontmatter), CI fails with a message telling the author to run `pnpm changeset version` and commit the result. Empty chore changesets pass through.

### Trusted Publishing setup

Each of the three publishable packages must be configured on npmjs.com with this repo + `release.yml` as a trusted publisher. No `NPM_TOKEN` is required. The workflow uses `npm publish --provenance --access public` to emit a signed provenance attestation on each publish — verifiable by consumers.

## Behavioral Notes

### Entity Operations
- **BoundEntity CRUD methods return fluent builders.** `db.entities.Users.put(input)` → `BoundPut`; `db.entities.Users.update(key)` → `BoundUpdate`; `db.entities.Users.delete(key)` → `BoundDelete`. All are Yieldable (yield* to execute) and Pipeable (chain methods). Every combinator is a method: `update(key).set({...}).expectedVersion(3).condition({...})`, `put(input).condition({...})`, `delete(key).condition({...}).returnValues("ALL_OLD")`. Use `.asEffect()` to convert to `Effect` when piping to Effect combinators (`Effect.catchTag`, `Effect.map`, etc.). Queries use the same fluent-builder shape via `BoundQuery`.
- **BoundQuery is a fluent builder.** `db.entities.Tasks.byProject({ project: "alpha" }).filter(...).limit(10).collect()`. Terminals: `.collect()` → `Effect<Array<A>>`, `.fetch()` → `Effect<Page<A>>` (single page + cursor), `.paginate()` → `Stream<A>`, `.count()` → `Effect<number>`. Combinators: `.where()` (SK condition), `.filter()`, `.select()`, `.limit()`, `.maxPages()`, `.reverse()`, `.startFrom()`, `.consistentRead()`, `.ignoreOwnership()`.
- **Query accessors from entity indexes.** Each GSI index on an entity becomes a query accessor: `db.entities.Tasks.byProject({...})` returns a `BoundQuery`. PK composites required, SK composites optional (narrows via auto `begins_with`). `.where()` provides type-safe access to remaining SK composites not already provided.
- **Collection accessors auto-discovered.** Entities sharing the same `collection` name on the same GSI are grouped: `db.collections.assignments({ employee: "dfinlay" }).collect()` → `Effect<{ Employees: Employee[], Tasks: Task[] }>`. Collection queries support the same BoundQuery combinators (`.filter()`, `.limit()`, etc.) but `.where()` is not available.
- **put/get/query return model type from BoundEntity.** Entity definitions return intermediates (`EntityOp`, `EntityDelete`) with `asRecord`/`asNative` terminals for advanced decode modes.
- **`Entity.create()` = put + attribute_not_exists.** Returns `ConditionalCheckFailed` on duplicate.
- **Conditional writes via `.condition()`.** Works on `BoundPut`, `BoundUpdate`, `BoundDelete` (and on unbound `EntityPut`/`EntityUpdate`/`EntityDelete` via `Entity.condition()` pipeable). User condition ANDed with optimistic lock condition on updates. Two APIs: callback `.condition((t, { eq }) => eq(t.status, "active"))` and shorthand `.condition({ eq: { status: "active" } })`.
- **Filter expressions on BoundQuery.** Callback `.filter((t, { gt }) => gt(t.price, 30))` or shorthand `.filter({ status: "active" })`.
- **Projections on BoundQuery.** Callback `.select((t) => [t.name, t.price])` or shorthand `.select(["name", "price"])`. Returns partial records.
- **PathBuilder + Expr ADT.** `PathBuilder<Model>` is a recursive Proxy for type-safe attribute path access (nested: `t.address.city`, array: `t.roster.at(0).name`, size: `t.tags.size()`). `Expr` is a 16-node discriminated union compiled to DynamoDB expression strings via `compileExpr()`. `ConditionOps<Model>` provides typed comparison/logical operators for callbacks.
- **Rich update operations on `BoundUpdate`.** Record-based methods: `.set(updates)`, `.remove(fields)` (REMOVE), `.add(values)` (ADD), `.subtract(values)` (SET subtraction), `.append(values)` (list_append), `.deleteFromSet(values)` (DELETE from set). Path-based: `.pathSet(op)`, `.pathRemove(segments)`, `.pathAdd(op)`, `.pathSubtract(op)`, `.pathAppend(op)`, `.pathPrepend(op)`, `.pathDelete(op)`. All compose with `.expectedVersion()`, `.condition()`, `.cascade()`, `.returnValues()`. Unbound `Entity.update(key).pipe(Entity.set(...), Entity.pathAdd(...))` uses the same combinator names as pipeable functions.
- **GSI composites defined on Entity.** Each entity defines its own GSI indexes via `Entity.make({ indexes })`. Entity writes compose keys for primary key + all entity indexes automatically. `DynamoClient.make()` auto-discovers collections from the `collection` property on indexes.
- **Consistent reads via combinator.** `Entity.consistentRead()` on `EntityGet`, `.consistentRead()` on `BoundQuery`.
- **Scan via `db.entities.Tasks.scan()`.** Returns `BoundQuery` in scan mode (no `.where()` available).
- **Batch operations auto-chunk.** `batchGet` at 100, `batchWrite` at 25. Both retry unprocessed items.
- **Table operations via `db.tables.*`.** `create()`, `delete()`, `describe()`, backup/restore, PITR, TTL, tags, export.
- **`.history(key)` for time-series entities.** Returns a `BoundQuery` auto-scoped to event items via `begins_with("<currentSk>#e#")`. `.where()` restricted to the configured `orderBy` attribute; `.filter()` works on any model attribute.

### Lifecycle Operations
- **Opt-in.** `versioned: { retain: true }` for version snapshots. `softDelete: true` (or `{ ttl, preserveUnique }`) for soft-delete.
- **Version snapshots strip GSI keys.** SK becomes `$schema#v1#entity#v#0000001`.
- **Soft-deleted items strip GSI keys.** SK becomes `$schema#v1#entity#deleted#<timestamp>`. `deletedAt` added, optional `_ttl`.
- **Restore recomposes all keys.** Re-establishes unique constraint sentinels atomically.
- **Purge deletes everything in the partition.** Queries all items, resolves unique sentinels, batch-deletes in chunks of 25.
- **Retain-aware operations use transactWriteItems.** put/update/delete with retain create snapshots atomically.
- **Time-series via `timeSeries: { orderBy, ttl?, appendInput }`.** Current-item SK unchanged; event items SK is `<currentSk>#e#<orderBy-value>`, GSI keys stripped, `_ttl` set. `.append(input)` is a `TransactWriteItems` (UpdateItem current + Put event) with CAS `attribute_not_exists(pk) OR #orderBy < :newOb`. Returns `{ applied: true | false, current }` — stale is a value, not an error. Mutually exclusive with `versioned` (EDD-9012) and `softDelete` (EDD-9015).
- **Time-series enrichment preservation.** `.append()` SET clause enumerates only fields in `appendInput` (required at `make()` time — EDD-9016). Fields outside `appendInput` are never touched on the current item. `appendInput` must include `orderBy` plus all PK/SK composites (EDD-9013).

### Aggregate Operations
- **Edge entities are first-class.** Own models, keys, indexes, and configuration. Composed via `Aggregate.one()`, `Aggregate.many()`, `BoundSubAggregate`.
- **Write-time ref hydration.** Framework fetches referenced entity at create/update time, denormalizes into edge entity. Read path is cheap.
- **Aggregates never touch DynamoClient directly.** Read: Collection query + assembly. Write: decompose into entity ops wrapped in Transaction. Diff-based updates only write changed edges.
- **Discriminator SK format is `name#value`.** `{ teamNumber: 1 }` → `#teamNumber#1`.
- **Domain models are pure.** Entity association declared at edge level in `Aggregate.make()`, not in Schema.Class model.
- **Aggregate.update mutation context.** Receives `UpdateContext` with: `state` (plain object), `cursor` (pre-bound optic), `optic` (composable optic), `current` (Schema.Class instance).
- **Optional sub-aggregates supported.** `Schema.optionalKey` → decomposition skips null/undefined, assembly omits the key entirely.

## MCP Servers

- **effect-docs** — Effect TS documentation search. Use `effect_docs_search` to search and `get_effect_doc` to retrieve specific docs. **Note:** May serve v3 documentation during v4 beta — cross-reference with migration guides.
- v4 source: https://github.com/Effect-TS/effect-smol — ground truth for v4 APIs
- v4 migration: https://github.com/Effect-TS/effect-smol/blob/main/MIGRATION.md
