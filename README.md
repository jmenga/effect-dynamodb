# effect-dynamodb

Schema-driven DynamoDB ORM for [Effect TS](https://effect.website). Single-table design as a first-class pattern, with type-safe entity modeling, composite key composition, Stream-based pagination, and Layer-based dependency injection.

[![npm](https://img.shields.io/npm/v/effect-dynamodb)](https://www.npmjs.com/package/effect-dynamodb)
[![license](https://img.shields.io/npm/l/effect-dynamodb)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue)](https://www.typescriptlang.org/)
[![Effect](https://img.shields.io/badge/Effect-4.x-purple)](https://effect.website)

**Documentation:** https://jmenga.github.io/effect-dynamodb

## Packages

| Package | Description |
|---|---|
| [`effect-dynamodb`](./packages/effect-dynamodb) | Core ORM — entities, single-table design, queries, transactions, lifecycle |
| [`@effect-dynamodb/geo`](./packages/effect-dynamodb-geo) | Geospatial index and proximity search using H3 hexagons |
| [`@effect-dynamodb/language-service`](./packages/language-service) | TypeScript language-service plugin — DynamoDB op details on hover |

## Features

- **Schema-driven models** — pure `Schema.Class`/`Schema.Struct` domain types with 7 derived types per entity (`Model`, `Record`, `Input`, `Update`, `Key`, `Item`, `Marshalled`).
- **Single-table design as the default path** — multiple entity types share one physical table; the framework handles entity-type isolation, composite key composition, and index overloading.
- **Entity-centric typed gateway** — `DynamoClient.make({ entities, tables })` returns `db.entities.*`, `db.collections.*`, `db.tables.*` with `R = never`.
- **Fluent BoundQuery builder** — `db.entities.Tasks.byProject({...}).filter(...).limit(10).collect()`. Terminals: `.collect()`, `.fetch()`, `.paginate()` (Stream), `.count()`.
- **Index accessors derived from entity GSI definitions** — every GSI becomes a typed query method on the entity.
- **Cross-entity collections** — entities sharing a `collection` name on the same physical GSI are auto-discovered as `db.collections.<name>(...)` queries.
- **Type-safe expressions** — condition / filter / projection via PathBuilder callbacks (`(t, { eq, gt }) => and(eq(t.status, "active"), gt(t.priority, 3))`) or shorthand records.
- **Rich updates** — `Entity.set()`, `remove()`, `add()`, `subtract()`, `append()`, `deleteFromSet()`, plus path-based variants for nested structures.
- **Lifecycle features (opt-in)** — automatic `createdAt`/`updatedAt`, optimistic locking via auto-incremented version, version snapshot retention, soft delete with optional TTL, restore, purge, unique constraints via sentinel transactions.
- **Aggregates** — graph-based composite domain models that decompose into entity ops (atomic transactions) and assemble from collection queries; never touches `DynamoClient` directly.
- **Event sourcing** — append-only `EventStore` with stream replay and snapshots.
- **Tagged errors** — `ItemNotFound`, `ConditionalCheckFailed`, `ValidationError`, `TransactionCancelled`, `UniqueConstraintViolation`, `OptimisticLockError`, and more — all `catchTag`-discriminable.
- **Stream pagination** — `Stream<A>` from `.paginate()`; the runtime handles DynamoDB's pagination protocol.
- **Layer-based DI** — physical table names and AWS client config injected via Effect Layers, enabling clean test isolation.

## Quick start

```bash
pnpm add effect-dynamodb effect @aws-sdk/client-dynamodb @aws-sdk/util-dynamodb
```

`effect` is a peer dependency — install the version your application uses.

```typescript
import { Console, Effect, Layer, Schema } from "effect"
import { DynamoClient, DynamoSchema, Entity, Table } from "effect-dynamodb"

// 1. Pure domain model — no DynamoDB concepts
class Task extends Schema.Class<Task>("Task")({
  taskId:    Schema.String,
  projectId: Schema.String,
  title:     Schema.NonEmptyString,
  status:    Schema.Literals(["todo", "active", "done"]),
  priority:  Schema.Number,
}) {}

// 2. Entity — primary key + GSI access patterns
const Tasks = Entity.make({
  model: Task,
  entityType: "Task",
  primaryKey: {
    pk: { field: "pk", composite: ["taskId"] },
    sk: { field: "sk", composite: [] },
  },
  indexes: {
    byProject: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["projectId"] },
      sk: { field: "gsi1sk", composite: ["status", "taskId"] },
    },
  },
  timestamps: true,
  versioned: true,
})

// 3. Table — register entities under an app namespace
const AppSchema = DynamoSchema.make({ name: "myapp", version: 1 })
const MainTable = Table.make({ schema: AppSchema, entities: { Tasks } })

// 4. Use the typed gateway
const program = Effect.gen(function* () {
  const db = yield* DynamoClient.make({
    entities: { Tasks },
    tables: { MainTable },
  })

  yield* db.tables.MainTable.describe().pipe(
    Effect.catchTag("ResourceNotFoundError", () => db.tables.MainTable.create()),
  )

  // Create
  yield* db.entities.Tasks.put({
    taskId: "t-1", projectId: "p-1", title: "Ship v1.0",
    status: "active", priority: 1,
  })

  // Read by primary key
  const task = yield* db.entities.Tasks.get({ taskId: "t-1" })

  // Query a GSI — fluent BoundQuery
  const active = yield* db.entities.Tasks
    .byProject({ projectId: "p-1", status: "active" })
    .limit(25)
    .collect()

  // Update (provide all GSI composites that participate in the SK so keys can be recomposed)
  yield* db.entities.Tasks.update(
    { taskId: "t-1" },
    Entity.set({ status: "done", projectId: "p-1" }),
  )

  // Conditional write
  yield* db.entities.Tasks.update(
    { taskId: "t-1" },
    Entity.set({ status: "active", projectId: "p-1" }),
    Tasks.condition((t, { eq }) => eq(t.status, "done")),
  )

  // Delete
  yield* db.entities.Tasks.delete({ taskId: "t-1" })

  yield* Console.log(`Found ${active.length} active tasks`)
})

const AppLayer = Layer.mergeAll(
  DynamoClient.layer({
    region: "us-east-1",
    endpoint: "http://localhost:8000",
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  }),
  MainTable.layer({ name: "my-app-table" }),
)

Effect.runPromise(program.pipe(Effect.provide(AppLayer)))
```

### Cross-entity collections

When two entities share a `collection` name on the same physical GSI, they group automatically:

```typescript
const Employees = Entity.make({ /* ... */
  indexes: {
    workplaces: {
      collection: "workplaces",
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["office"] },
      sk: { field: "gsi1sk", composite: ["team", "title", "employee"] },
    },
  },
})

const Offices = Entity.make({ /* ... */
  indexes: {
    workplaces: {
      collection: "workplaces",
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["office"] },
      sk: { field: "gsi1sk", composite: [] },
    },
  },
})

const db = yield* DynamoClient.make({ entities: { Employees, Offices }, tables: { MainTable } })

const { Employees: staff, Offices: office } = yield* db.collections.workplaces({
  office: "gw-zoo",
}).collect()
```

## Error handling

```typescript
const result = yield* db.entities.Users.get({ userId: "u-1" }).pipe(
  Effect.catchTag("ItemNotFound", () => Effect.succeed(null)),
  Effect.catchTag("ValidationError", (e) => Effect.die(`Schema error: ${e.message}`)),
  Effect.catchTag("DynamoError", (e) => Effect.die(`AWS error in ${e.operation}`)),
)
```

Available errors include `DynamoError`, `ItemNotFound`, `ConditionalCheckFailed`, `ValidationError`, `TransactionCancelled`, `UniqueConstraintViolation`, `OptimisticLockError`, `TransactionOverflow`, `RefNotFound`, `ItemDeleted`, `VersionConflict`, and others — see the [API Reference](https://jmenga.github.io/effect-dynamodb/reference/api-reference) for the complete list.

## Examples

[`packages/effect-dynamodb/examples/`](./packages/effect-dynamodb/examples/) contains 17+ runnable programs that double as the source of truth for documentation snippets:

```bash
docker run -p 8000:8000 amazon/dynamodb-local
npx tsx packages/effect-dynamodb/examples/starter.ts
```

| Example | Topic |
|---|---|
| `starter.ts` | Minimal setup |
| `crud.ts` | Full CRUD with versioning and soft delete |
| `expressions.ts` | Conditional writes, create, filter expressions |
| `updates.ts` | Rich updates: remove, add, subtract, append |
| `batch.ts` | Batch get/write with auto-chunking |
| `unique-constraints.ts` | Sentinel-based uniqueness |
| `hr.ts` | Multi-entity HR system, collections, queries |
| `blog.ts` | Posts and comments with sub-collections |
| `shopping-mall.ts` | Multi-tenant e-commerce, index overloading |
| `cricket.ts` | Aggregate CRUD with ref hydration and cascade updates |
| `event-sourcing.ts` | EventStore with the decider pattern |

## vs ElectroDB

If you're choosing between this and [ElectroDB](https://electrodb.dev):

|  | effect-dynamodb | ElectroDB |
|---|---|---|
| **Native to** | Effect TS ecosystem | TypeScript |
| **Type derivation** | 7 derived types per entity | Inferred input/output |
| **Lifecycle features** | Built-in versioning, snapshots, soft delete, restore, purge, unique constraints | Manual implementation |
| **Concurrency** | Built-in optimistic locking | Manual |
| **Composition** | Effect pipelines, `Stream` pagination, Layer DI | Fluent chaining |
| **Errors** | Tagged errors with `catchTag` | Error codes |
| **Setup overhead** | More upfront (`Schema` + `DynamoSchema` + `Table` + `Entity`) | Less |
| **Pays off when** | Multiple entities, complex composition, Effect-native codebase | Simple cases, non-Effect codebase |

See the [Migration from ElectroDB](https://jmenga.github.io/effect-dynamodb/reference/migration-from-electrodb) guide for concept mapping and side-by-side examples.

## Development

This is a pnpm workspace monorepo:

```bash
pnpm install
pnpm build
pnpm check    # typecheck
pnpm lint     # biome
pnpm test     # all packages
```

See [`PUBLISH.md`](./PUBLISH.md) for the release flow and one-time GitHub setup.

## License

[MIT](./LICENSE)


<!-- Fix #19 -->
