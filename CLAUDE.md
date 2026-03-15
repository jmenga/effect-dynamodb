# CLAUDE.md — Effect DynamoDB ORM

> **Version:** This project targets **Effect v4** (beta as of 2026-02). Some v4 APIs live under `effect/unstable/*` during beta and may change in minor releases. The v3 codebase is preserved at git tag `effect-dynamodb-v3`.

This file provides guidance to Claude Code when working in the effect-dynamodb project.

## Project Overview

Effect TS ORM for DynamoDB providing Schema-driven entity modeling, single-table design as a first-class pattern, composite key composition from entity attributes, type-safe index-aware queries with Stream-based pagination, and DynamoClient as an Effect Service with Layer-based dependency injection.

**Status:** All modules implemented. 749+ unit tests, 61 connected tests, 18 examples.
**Design:** `DESIGN.md` — API specification (source of truth for implementation)

## Architecture

### Module Structure

```
packages/effect-dynamodb/src/
├── DynamoModel.ts      # DynamoModel.Immutable annotation for Schema.Class/Struct fields
├── DynamoSchema.ts     # Application namespace (name + version) for key prefixing
├── Table.ts            # Minimal table grouping ({ schema }) with Layer-based name injection
├── Entity.ts           # Model-to-table binding, index definitions, CRUD + query operations
├── KeyComposer.ts      # Composite key composition from index definitions
├── Collection.ts       # Multi-entity queries with per-entity Schema decode
├── Expression.ts       # Condition, filter, and update expression builders
├── Transaction.ts      # TransactGetItems + TransactWriteItems (atomic multi-item ops)
├── Projection.ts       # ProjectionExpression builder for selecting specific attributes
├── DynamoClient.ts     # ServiceMap.Service wrapping AWS SDK DynamoDBClient
├── Marshaller.ts       # Thin wrapper around @aws-sdk/util-dynamodb
├── Errors.ts           # Tagged errors (DynamoError, ItemNotFound, ConditionalCheckFailed, ValidationError, TransactionCancelled, UniqueConstraintViolation)
└── index.ts            # Public API barrel export
```

### Data Flow

```
User code → Entity.put(inputData)
  → Schema.decode(Entity.Input) — validate input
  → compose keys (KeyComposer) for all indexes using composite attributes
  → add __edd_e__ + timestamps + version
  → marshall to DynamoDB format (Marshaller)
  → DynamoClient.putItem (or transactWriteItems for unique constraints)
  → Schema.decode(Entity.Record) — decode full item for return

User code → Entity.get(key)
  → compose primary key → DynamoClient.getItem
  → unmarshall → Schema.decode(Entity.Record) — validate & type

User code → Entity.query.indexName({ pk composites }).pipe(Query.collect)
  → compose PK/SK from composite attributes (KeyComposer)
  → build KeyConditionExpression + __edd_e__ FilterExpression
  → Stream.paginate (automatic DynamoDB pagination)
  → unmarshall → Schema.decode(Entity.Record) per item

User code → Collection.query(collectionName, { pk composites })
  → build KeyConditionExpression + __edd_e__ IN FilterExpression
  → Stream.paginate (automatic DynamoDB pagination)
  → unmarshall → discriminate by __edd_e__ → decode through matching entity schema
```

### Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| Native build (not wrapping ElectroDB) | Full control over Effect integration, no impedance mismatch |
| Raw AWS SDK (not @effect-aws) | Avoid extra dependency; thin wrapper is simple enough |
| Effect Schema as sole schema system | Native Effect integration, bidirectional transforms, branded types |
| Schema.Class/Struct for models | Pure domain schemas — no DynamoDB concepts in models. Entity derives DynamoDB types |
| Entity IS the repository | `Entity.make()` returns definition + operations. No separate EntityRepository step |
| ElectroDB-style composite indexes | `{ pk: { field, composite }, sk: { field, composite } }` — attribute lists not templates |
| DynamoSchema for key namespacing | `$schema#v1#entity#attrs` format with `$` sentinel prefix for ORM/non-ORM coexistence |
| Table stripped to `{ schema }` | Key structure derived from entities. Physical table name injected via Layer at runtime |
| `__edd_e__` entity type attribute | Ugly name convention (like ElectroDB's `__edb_e__`) avoids collisions with user model fields |
| Single-table first | Most impactful DynamoDB pattern; multi-table is simpler subset |
| @aws-sdk/util-dynamodb for marshalling | Proven, maintained; Effect Schema handles validation layer above |

### Single-Table Pattern

Entities share a physical table. Each entity declares:
- `entityType` — discriminator string stored as `__edd_e__` on every item
- `indexes` — ElectroDB-style composite key definitions for primary and GSI/LSI keys

Key format: `$schema#v1#entity_type#attr1_value#attr2_value` with configurable casing.

### Module Dependencies

```
Entity → DynamoClient, DynamoSchema, Table, KeyComposer, Marshaller, Expression, Errors
Collection → DynamoClient, Entity, Table, Marshaller, Errors
Transaction → DynamoClient, Entity, KeyComposer, Marshaller, Expression, Errors
Projection → (standalone, no internal deps)
Expression → Marshaller
Table → DynamoSchema
DynamoSchema → (standalone, no internal deps)
DynamoModel → effect (Schema) — provides Immutable annotation
DynamoClient → effect (ServiceMap, Layer), @aws-sdk/client-dynamodb
KeyComposer → (standalone, no internal deps)
Marshaller → @aws-sdk/util-dynamodb
Errors → effect (Data)
```

## Coding Conventions

### TypeScript Conventions

**Type System:**
- **Generics** — Use constraints (`extends`) to narrow type parameters. Use `const` modifier for literal type preservation. Use `NoInfer<T>` to control inference sites. Type parameters should appear in at least two positions to be useful.
- **Conditional types** — Distributive by default over naked type parameters. Wrap in `[T] extends [U]` to prevent distribution. Use `infer` with constraints for precise extraction.
- **Mapped types** — Key remapping (`as` clause) for filtering/transforming. Use `-readonly` and `-?` to remove qualifiers.
- **HKT simulation** — TypeLambda + Kind encoding. Critical for Effect's type system (`Effect<A,E,R>`, `Stream<A,E,R>`).
- **Branded types** — `unique symbol` for nominal distinctions. This project uses Effect Schema branded types for domain IDs.

**Decisions (project-relevant):**
- `type` over `interface` — default. `interface` only for declaration merging or extensible contracts.
- Union types over enums — zero runtime cost, full autocomplete.
- `unknown` over `any` — always. `any` only as temporary migration scaffolding.
- `satisfies` for validation + literal preservation. `as const satisfies Type` for deep readonly + validation.
- Strict mode: `strict: true`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`.

**Anti-Patterns:**
- `any` to escape type errors → `unknown` + narrowing
- Type assertions (`as`) for data boundaries → validate with schemas
- Non-null assertion (`!`) → narrowing or assertion functions
- Default exports → named exports for refactoring support
- Floating promises → always `await` or explicitly `void`
- `catch` without narrowing → `catch` receives `unknown` in strict mode

### Effect TS Conventions

### Effect TS Core Patterns

- **Effect<A, E, R>** — Success, Error, Requirements. Effects are lazy and immutable.
- **Generator style** (`Effect.gen`) for sequential logic; **pipe style** for short transformations.
- **Tagged errors** via `Data.TaggedError` — all errors must be tagged for discrimination. Tagged errors are **yieldable**: prefer `yield* new ErrorClass(...)` over `yield* Effect.fail(new ErrorClass(...))` in generators — both are equivalent but the yieldable form is more concise.
- **Service pattern** — `ServiceMap.Service` for all service definitions (unified API — replaces v3's `Context.Tag`). Co-locate default implementation as `static layer` on the class. Use `ServiceMap.Reference` for services with default values. Service methods have `R = never`. Tag identifiers use `@package/ServiceName` format.
- **Resource management** — `Effect.acquireRelease` with `Effect.scoped`. `Scope.provide` for scope delegation. DynamoClient uses `Layer.scoped` to manage SDK client lifecycle.
- **Schema** — `Schema.Class` or `Schema.Struct` for domain models (pure, no DynamoDB concepts). Entity derives DynamoDB-specific types (Record, Input, Update, Key, Item, Marshalled). `DynamoModel.Immutable` annotation for fields that shouldn't change after creation. Use `Schema.decodeUnknownEffect` (returns Effect) inside effectful code. Validation via `.check()` with named check factories. Struct manipulation via `mapFields` with `Struct.renameKeys`. `Schema.Literals([...])` for literal unions.
- **Custom annotations** — Use `Symbol.for()` for custom annotation identifiers, never string keys. Apply via `.pipe(Schema.annotate({ [SymbolId]: value }))`. Retrieve with `SchemaAST.resolve(schema.ast)?.[symbolId]`. This project uses custom annotations for `DynamoModel.Immutable`.
- **Dual APIs** — Public library functions that transform a data type must use `Function.dual` for data-first and data-last (pipeable) support. Define with TypeScript overloads + `dual(arity, implementation)`. This is how Effect's own APIs work and is expected for ecosystem libraries.
- **TypeId + Pipeable** — Every Effect data type carries a `TypeId` (unique symbol via `Symbol.for("effect/ModuleName")` for nominal typing + runtime type guards) and implements `Pipeable` (`.pipe()` method) + `Inspectable` (`toJSON()`/`toString()`). Custom types in this library should follow the same triad. TypeId is declared as `export const TypeId: unique symbol = Symbol.for("effect-dynamodb/TypeName")`, used in interfaces as `readonly [TypeId]: { readonly _A: Covariant<A> }` for variance, and checked at runtime via `Predicate.hasProperty(input, TypeId)`. Prototype-based construction places TypeId on shared prototypes for memory efficiency.
- **Yieldable trait** — The `Yieldable` trait enables `yield*` in generators for Effect, Option, Result, Config, and ServiceMap.Service. `Ref`, `Deferred`, and `Fiber` are NOT Yieldable — use explicit operations (`Ref.get`, `Deferred.await`, `Fiber.join`). **Yieldable ≠ Effect**: `Effect.gen` extracts types from `Yieldable`, not from `Effect`. This project's entity operations (`EntityOp`, `EntityDelete`) extend `Effect.Yieldable + Pipeable.Pipeable` — NOT `Effect.Effect`. The compiler enforces `.asEffect()` before entity ops can be passed to Effect combinators (`Effect.map`, `Effect.catchTag`, etc.). Do NOT add `declare readonly ["~effect/Effect"]` to entity op impl classes. When extracting `A`/`E`/`R` from entity ops in generic type helpers, match against `EntityOp<infer A, ...>` or `EntityGet<infer A, ...>`, NOT `Effect.Effect<infer A, ...>`.
- **Option over nullable** — Use `Option<A>` instead of `A | undefined`/`A | null` in services, domain logic, and repository return types. Convert at boundaries with `Option.fromNullable`. Compose with `Option.map`, `Option.flatMap`, `Option.match`. This overrides the TypeScript convention of nullable types — `Option` composes in pipes and forces explicit absent-value handling.
- **Pattern matching** — Use the `Match` module for complex branching on discriminated unions and tagged types. `Match.type<T>()` for reusable matchers, `Match.tag` for `_tag` matching, `Match.exhaustive` for compile-time case checking. Prefer over `switch`/`if-else` chains on unions. Use `Option.match`/`Effect.match` for simple two-case matching.
- **No tacit style** — always explicit lambdas: `Effect.map((x) => fn(x))`.
- **`run*` at the edge only** — never `runPromise`/`runSync` inside an Effect.
- **Testing** — `@effect/vitest` with `it.effect` / `it.scoped`. Test through real service Layers with mocked dependencies. Use `vi.fn()` for dependency mocks, `Effect.flip` for error path assertions. Mock functions return Effects: `mockFn.mockReturnValue(Effect.succeed(...))`, never `mockResolvedValue`. Infrastructure boundary services (like `DynamoClient`) are mocked directly via `Layer.succeed(DynamoClient, { putItem: mockPutItem, ... })` — the exception to "test through real service layers" since they're thin SDK wrappers. Use `Effect.provide(layer, { local: true })` for test isolation.
- **Packages** — Core platform, RPC, and cluster functionality merged into `effect`. Platform-specific providers remain separate. All ecosystem packages share unified version numbers. Unstable APIs live under `effect/unstable/*`.

### Creating Effects Table

| Situation | Use |
|-----------|-----|
| Fallible async (AWS SDK calls) | `Effect.tryPromise` |
| Pure synchronous value | `Effect.succeed(value)` |
| Lazy synchronous value | `Effect.sync(() => expr)` |
| Fail with tagged error | `yield* new ErrorClass({ ... })` — yieldable, no `Effect.fail` needed |
| Access a service | `yield* ServiceTag` in generator |
| Stream with pagination | `Stream.paginate` |

### Critical Anti-Patterns

Do NOT:
- Use `Effect.promise` for fallible async — use `Effect.tryPromise`
- Use `Effect.sync` for throwable code — use `Effect.try`
- Use `Effect.catchCause` in business logic — use `catchTag`/`Effect.catch`
- Use string/generic Error types — use `Data.TaggedError` (yieldable, tagged for `catchTag`)
- Use `Effect.fail(new TaggedError(...))` in generators — use `yield* new TaggedError(...)` directly
- Have service methods with `R != never` — resolve deps in Layer
- Call `run*` inside effects — use `yield*` instead
- Use `Effect.succeed(expr)` for lazy values — use `Effect.sync(() => expr)`
- Use `Schema.decodeUnknownSync` in effectful code — use `Schema.decodeUnknownEffect`
- Use `yield* ref` / `yield* deferred` / `yield* fiber` — use `Ref.get`/`Deferred.await`/`Fiber.join` (not Yieldable)
- Use v3 service APIs (`Context.Tag`, `Effect.Service`, `Effect.Tag`) — use `ServiceMap.Service`
- Use v3 Schema APIs (`Schema.filter`, `Schema.fromKey`, `Schema.Literal`) — use `.check()`, `.withKey()`, `Schema.Literals`
- Put DynamoDB concepts (keys, indexes, timestamps) in domain models — keep models pure, Entity handles DynamoDB binding
- Use string keys for custom annotations — use `Symbol.for("namespace/Name")` to avoid collisions
- Define non-dual public library APIs — use `Function.dual` for data-first + data-last support on all public functions that transform data types
- Add `declare readonly ["~effect/Effect"]` to entity op impl classes — this makes entity ops silently pass to Effect combinators that can't process them at runtime. Use `Yieldable + Pipeable` only.
- Extract `A`/`E`/`R` from entity ops via `Effect.Effect<infer A>` — match against `EntityOp<infer A, ...>` or `EntityGet<infer A, ...>` instead (resolves to `never` otherwise)
- Build "smart pipe" auto-conversion at Yieldable/Effect boundary — let the type system enforce `.asEffect()` in both data-first and data-last styles

### Decision Framework

- **Effect vs plain TS** — Effect for side effects, failures, DI, resources. Plain TS for pure data transformations (KeyComposer uses plain TS for template parsing).
- **Layer vs direct** — Layer for shared services with dependencies/lifecycle (DynamoClient). Direct for stateless utilities (Marshaller, KeyComposer).
- **Error granularity** — Fine-grained at domain boundaries: `DynamoError`, `ItemNotFound`, `ConditionalCheckFailed`, `ValidationError`, `TransactionCancelled`.
- **Stream vs Effect.all** — Stream for query results (unbounded pagination). `Effect.all` for finite in-memory collections.

### DynamoDB Conventions

**Data Modeling:**
- **Access-pattern-first design** — List all queries before touching the schema. Every access pattern maps to a key condition on a table or index. If a pattern requires a Scan, the key design is wrong.
- **Single-table design** — This project's primary pattern. Store multiple entity types in one table using structured key values (`$schema#v1#entity#attr_value`).
- **Key composition** — `$` sentinel prefix, `#` delimiter, schema name, version, entity type, then composite attribute values. Configurable casing per structural parts.
- **Item collections** — All items sharing a partition key. The fundamental unit of efficient access. Collections group multiple entity types under the same index for cross-entity queries.
- **Entity type discriminators** — Always include `__edd_e__` attribute (ugly name to avoid collisions). This ORM enforces it via FilterExpression on all queries.
- **Index overloading** — Generic GSI names (gsi1, gsi2) serving different patterns per entity type. Logical names (`byTenant`) map to physical GSI names.

**Operations:**
- **Expression syntax** — Always use `ExpressionAttributeNames` (`#` prefix) and `ExpressionAttributeValues` (`:` prefix). Many common names are reserved words.
- **Pagination** — Always handle `LastEvaluatedKey`. This ORM handles it via `Stream.paginate`.
- **Batch retry** — Always retry `UnprocessedItems`/`UnprocessedKeys` with exponential backoff. This ORM handles it in `batchGet`/`batchWrite`.
- **Conditional writes** — `ConditionExpression` for atomic checks. `ConditionalCheckFailedException` is expected control flow, not exceptional.
- **Transactions** — TransactGetItems/TransactWriteItems for atomic multi-item operations (up to 100 items, 2x WCU for writes). Standalone functions in Transaction module.

**Anti-Patterns:**
- Relational thinking (normalizing, expecting JOINs) → access-pattern-first design
- Hot partitions (low-cardinality PKs) → high-cardinality partition keys
- Scan for regular queries → redesign keys or add GSI
- FilterExpression as key design substitute → does not reduce read capacity
- Not handling pagination → always check `LastEvaluatedKey`
- Not handling unprocessed items → retry with exponential backoff
- Over-indexing → use index overloading (one GSI serves many patterns)

**Key Limits:**
- Max item: 400 KB | Max BatchWrite: 25 items | Max BatchGet: 100 items
- Max transaction: 100 items | Max GSIs: 20 | Max Query/Scan response: 1 MB
- Per-partition: 3,000 RCU, 1,000 WCU

## Repository Structure

This is a pnpm workspace monorepo:

```
├── packages/
│   ├── effect-dynamodb/          # Core library (Entity, Table, Query, etc.)
│   │   ├── src/
│   │   ├── test/
│   │   └── examples/
│   ├── effect-dynamodb-geo/      # Geospatial index and search using H3
│   │   ├── src/
│   │   └── test/
│   └── language-service/         # TS Language Service Plugin (hover tooltips)
│       ├── src/
│       │   ├── index.ts          # Plugin entry point
│       │   ├── core/             # EntityResolver, OperationDetector, ParamsBuilder, Cache
│       │   ├── features/         # quickinfo (hover enhancement)
│       │   └── formatters/       # tooltip formatter
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

## Project Conventions

- **Strict TypeScript** — `strict: true`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`
- **ESM only** — `"type": "module"` in package.json, NodeNext module resolution
- **Target** — ES2022
- **Test structure** — `test/<ModuleName>.test.ts` mirrors `src/<ModuleName>.ts`. Integration test at `test/integration.test.ts`.
- **Test framework** — vitest with `@effect/vitest` for Effect-aware assertions
- **Testing** — DynamoClient mocked with `vi.fn()` in unit tests. Connected tests run against DynamoDB Local (`docker run -p 8000:8000 amazon/dynamodb-local`)
- **Barrel exports** — `src/index.ts` is the sole public entry point. Namespace exports for modules (`DynamoModel`, `DynamoSchema`, `Table`, `Entity`, `KeyComposer`, `Collection`, `Expression`, `Transaction`, `Projection`, `Marshaller`, `Query`), direct exports for errors and `DynamoClient`.

## Working Instructions

### Software Engineering Practices

- **Write tests first or alongside implementation** — not after. Tests drive the design and catch regressions early. Red-green-refactor: failing test → simplest passing implementation → refactor.
- **Eliminate duplication** — if the same logic appears in 3+ places, extract it into a shared function, type, or module. Two instances may be coincidental; three is a pattern. Don't over-abstract — extract when you see a real pattern, not a hypothetical one.
- **Prefer composable designs** — small, focused functions that compose via pipe over large functions with many parameters. If a function needs "and" in its description, it should probably be two functions.
- **Refactor before extending** — when adding features to existing modules, clean up the code you're touching first if it has accumulated debt.
- **Single responsibility** — each module, function, and type should have one clear purpose. This project's module structure (DynamoModel, Table, Entity, KeyComposer, etc.) reflects this — maintain the separation.
- **Readability over cleverness** — prefer clear, obvious implementations. Good names eliminate the need for comments.

### Quality Gates

Before committing:
1. `pnpm lint` — zero lint/format errors (Biome)
2. `pnpm check` — zero type errors
3. `pnpm test` — all tests pass
4. `npx tsx examples/<name>.ts` — all examples run successfully against DynamoDB Local (`docker run -p 8000:8000 amazon/dynamodb-local`). Run every example after changes that touch Entity, Query, Table, DynamoSchema, KeyComposer, Collection, Transaction, or Errors modules.
5. New modules must have corresponding test files in `test/`
6. New errors must use `Data.TaggedError`
7. New services must follow `ServiceMap.Service` + `static layer` pattern

### Behavioral Notes

- **GSI composites trust the consumer.** When updating GSI composite fields, the consumer is responsible for providing ALL composites for that GSI (fetch-merge pattern). Partial composites cause a natural error from `extractComposites` during GSI key recomposition. When `Entity.remove()` targets a GSI composite attribute, the corresponding GSI key fields (pk/sk) are automatically removed so the item drops out of the sparse index. If SET and REMOVE target composites of the same GSI, removal wins — the GSI is removed rather than recomposed.
- **put/get/query return `Entity.Record` instances.** `createdAt`/`updatedAt` are `DateTime.Utc` objects (not ISO strings). `__edd_e__` is stored in DynamoDB but stripped during decode (it's storage metadata, not a model field).
- **Collection items include entityType.** Collection queries discriminate by `__edd_e__` and decode through matching entity schema.
- **Expression builders are stateless.** Placeholder counter resets per `condition()`/`filter()`/`update()` call.
- **Batch operations auto-chunk.** `batchGet` chunks at 100 items, `batchWrite` at 25 items. Both retry unprocessed items.
- **Entity IS the repository.** Operations are called directly on the entity: `Users.put(...)`, `Users.get(...)`, `Users.query.byTenant(...)`.
- **Lifecycle operations are opt-in.** `versioned: { retain: true }` enables version snapshots on put/update/delete. `softDelete: true` (or `{ ttl, preserveUnique }`) enables soft-delete mechanics on delete. Operations like `getVersion`, `versions`, `deleted.get`, `deleted.list`, `restore`, `purge` are always present on the Entity interface but require the corresponding config to be meaningful.
- **Version snapshots strip GSI keys.** Snapshot items share the same PK but use a version SK (`$schema#v1#entity#v#0000001`). GSI key fields are removed so snapshots don't appear in index queries. `__edd_e__` is preserved for entity type filtering.
- **Soft-deleted items strip GSI keys.** The SK is replaced with `$schema#v1#entity#deleted#<timestamp>`. `deletedAt` is added to the item. Optional `_ttl` for DynamoDB TTL auto-expiry.
- **Restore recomposes all keys.** When restoring a soft-deleted item, the original SK and all GSI keys are recomposed from the item's attribute values. Unique constraint sentinels are re-established atomically with `attribute_not_exists` conditions.
- **Purge deletes everything in the partition.** Queries all items (main + versions + deleted), resolves unique sentinels, then batch-deletes in chunks of 25.
- **Retain-aware operations use transactWriteItems.** put (with retain) creates a v1 snapshot atomically. update (with retain) reads current state then transacts the update + snapshot. delete (with soft-delete + retain) transacts the deletion + soft-deleted item + snapshot.
- **Consistent reads via combinator.** `Entity.consistentRead()` on `EntityGet`, `Query.consistentRead()` on `Query<A>` — both pass `ConsistentRead: true` to DynamoDB.
- **Scan via `Entity.scan()`.** Returns `Query<Entity.Record>` with `isScan: true`. Shares all Query combinators (filter, limit, consistentRead) and terminals (execute, paginate). Uses `DynamoClient.scan` internally.
- **Conditional writes via `Entity.condition()`.** Accepts `ConditionInput` (declarative object from Expression module). Works on `EntityPut`, `EntityUpdate`, and `EntityDelete`. For updates, user condition is ANDed with optimistic lock condition. Returns `ConditionalCheckFailed` on failure.
- **`Entity.create()` = put + attribute_not_exists.** Equivalent to `Entity.put(input)` with an automatic `attribute_not_exists` condition on primary key fields. Returns `ConditionalCheckFailed` on duplicate.
- **Rich update operations.** `Entity.remove(fields)` (REMOVE), `Entity.add(values)` (ADD for atomic increment), `Entity.subtract(values)` (synthesized SET subtraction), `Entity.append(values)` (synthesized list_append), `Entity.deleteFromSet(values)` (DELETE from set). All compose with `set()`, `expectedVersion()`, and `condition()`.
- **Aggregate edges are unified.** All entity relationships use edges — there is no separate `refs` config. Four edge types: `OneEdge` (decomposes to separate DynamoDB item, hydrates via `entity`, optional `discriminator` for disambiguation), `ManyEdge` (item per element, hydrates via `entity`), `BoundSubAggregate` (sub-tree with discriminator), `RefEdge` (no decomposition, hydrates inline via `entity`). Use `Aggregate.one()`, `Aggregate.many()`, `Aggregate.ref()` respectively.
- **Discriminator SK format is name#value.** Discriminator values in sort keys use `name#value` pairs (e.g., `{ teamNumber: 1 }` → `#teamNumber#1`, `{ role: "referee" }` → `#role#referee`). This applies to both `BoundSubAggregate` and `OneEdge` discriminators. The format is self-describing and avoids ambiguity when multiple discriminators share an entityType.
- **RefEdge stays inline.** `Aggregate.ref(Entity)` declares a reference that hydrates on create (fetches entity by ID) but does NOT decompose into a separate DynamoDB item. The ref field stays in the root/sub-root item. Input schema transforms `field: Entity` → `fieldId: string`.
- **Entity on edges drives hydration.** `OneEdge` and `ManyEdge` accept an optional `entity` field that enables ref hydration. When present, input schema transforms the entity field to `${field}Id: string` (for one) or element-level IDs (for many). No `DynamoModel.ref` annotation needed on domain models.
- **ManyEdge handles two element shapes.** When the element IS the entity (e.g., `Array<Umpire>`), input becomes `Array<string>` (IDs). When the element wraps the entity (e.g., `Array<{ player: Player, isCaptain: boolean }>`), input becomes `Array<{ playerId: string, isCaptain: boolean }>`. Determined by matching element schema identifier against the edge entity. The optional `inputField` config renames the field in the input schema (e.g., `inputField: "matchUmpireIds"` maps `matchUmpire: Umpire[]` → `matchUmpireIds: string[]`). The `many()` factory uses function overloads to preserve the literal type of `inputField` for the mapped type.
- **Optional sub-aggregates are supported.** When a sub-aggregate field is `Schema.optionalKey`, decomposition skips null/undefined values and assembly omits the key entirely (rather than setting it to undefined), which satisfies `exactOptionalPropertyTypes`.
- **Domain models are pure.** No `DynamoModel.ref` needed — entity association is declared at the edge level in `Aggregate.make()`, not in the Schema.Class model. Models use plain `Schema.Class` fields for references.
- **Aggregate.update mutation context.** The mutation function receives a single `UpdateContext` object with: `state` (plain object for spreads), `cursor` (pre-bound optic for navigating and transforming), `optic` (composable optic for external lenses — pass `state` explicitly), `current` (Schema.Class instance, rarely needed). The `cursor` supports `.key()`, `.optionalKey()`, `.at()` for navigation and `.get()`, `.replace()`, `.modify()` as terminals — all pre-bound to the current state. Use `optic` + `state` when composing externally-defined lenses.

### Adding New Entities

1. Define model with `Schema.Class` (or `Schema.Struct`) — pure domain fields only. Use `DynamoModel.Immutable` for fields that shouldn't change after creation.
2. Reuse existing table (single-table) or create new with `Table.make({ schema })`.
3. Create entity with `Entity.make({ model, table, entityType, indexes, timestamps?, versioned?, softDelete?, unique? })`.
4. Use entity directly: `MyEntity.put(...)`, `MyEntity.get(...)`, `MyEntity.query.byIndex(...)`.
5. Add unit tests in `test/` and update integration test if needed.

## MCP Servers

- **effect-docs** — Effect TS documentation search. Use `effect_docs_search` to search and `get_effect_doc` to retrieve specific docs. **Note:** May serve v3 documentation during v4 beta — cross-reference with migration guides.
- v4 source: https://github.com/Effect-TS/effect-smol — ground truth for v4 APIs
- v4 migration: https://github.com/Effect-TS/effect-smol/blob/main/MIGRATION.md

