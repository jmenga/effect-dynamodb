# @effect-dynamodb/core

Schema-driven DynamoDB ORM for [Effect TS](https://effect.website). Single-table design as a first-class pattern with type-safe entities, composite key composition, Stream-based pagination, and Layer-based dependency injection.

[![npm](https://img.shields.io/npm/v/@effect-dynamodb/core)](https://www.npmjs.com/package/@effect-dynamodb/core)
[![license](https://img.shields.io/npm/l/@effect-dynamodb/core)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-blue)](https://www.typescriptlang.org/)
[![Effect](https://img.shields.io/badge/Effect-4.x-purple)](https://effect.website)

## Features

- **Schema-driven models** — Pure `Schema.Class`/`Schema.Struct` domain models with 7 auto-derived types
- **Single-table design** — Multiple entity types sharing one table with entity type isolation and index overloading
- **Composite key composition** — ElectroDB-style `{ pk: { field, composite }, sk: { field, composite } }` index definitions
- **Pipeable Query API** — `Query<A>` data type with `where`, `filter`, `limit`, `reverse`, `consistentRead` combinators
- **Scan** — `Entity.scan()` with full Query combinator support
- **Conditional writes** — `Entity.condition()` on put, update, and delete operations
- **Create (insert-only)** — `Entity.create()` with automatic `attribute_not_exists` condition
- **Rich update operations** — `Entity.remove()`, `Entity.add()`, `Entity.subtract()`, `Entity.append()`, `Entity.deleteFromSet()`
- **Batch operations** — `Batch.get` and `Batch.write` with auto-chunking and unprocessed item retry
- **Transactions** — `Transaction.transactGet` and `Transaction.transactWrite` for atomic multi-item operations
- **Collections** — Multi-entity queries across entity types with per-entity schema decoding
- **Unique constraints** — Sentinel-based uniqueness enforcement with atomic transactions
- **Optimistic locking** — `Entity.expectedVersion()` with automatic version tracking
- **Versioning** — Auto-increment version with optional snapshot retention
- **Soft delete** — Mark as deleted, restore, purge — with optional TTL
- **Timestamps** — Automatic `createdAt`/`updatedAt` management
- **Stream pagination** — Automatic DynamoDB pagination via Effect `Stream`
- **Layer-based DI** — Table names and DynamoClient injected via Effect Layers
- **Tagged errors** — `DynamoError`, `ItemNotFound`, `ConditionalCheckFailed`, and more — all with `catchTag`
- **Expression builders** — Type-safe condition, filter, update, and projection expressions
- **DynamoDB Streams** — Decode stream records into typed domain objects
- **Dual APIs** — All public functions support data-first and data-last (pipeable) calling conventions

## Installation

```bash
pnpm add @effect-dynamodb/core effect @aws-sdk/client-dynamodb @aws-sdk/util-dynamodb
```

## Quick Start

```typescript
import { Schema, Effect, Layer, Stream } from "effect"
import {
  DynamoModel, DynamoSchema, Table, Entity,
  Query, DynamoClient,
} from "@effect-dynamodb/core"

// 1. Define a model — pure domain schema, no DynamoDB concepts
class Task extends Schema.Class<Task>("Task")({
  taskId:    Schema.String,
  projectId: Schema.String,
  title:     Schema.NonEmptyString,
  status:    Schema.Literals(["todo", "active", "done"]),
  priority:  Schema.Number,
  createdBy: Schema.String.pipe(DynamoModel.Immutable),
}) {}

// 2. Create schema + table
const AppSchema = DynamoSchema.make({ name: "myapp", version: 1 })
const MainTable = Table.make({ schema: AppSchema })

// 3. Bind entity — indexes, timestamps, versioning
const Tasks = Entity.make({
  model: Task,
  table: MainTable,
  entityType: "Task",
  indexes: {
    primary: {
      pk: { field: "pk", composite: ["taskId"] },
      sk: { field: "sk", composite: [] },
    },
    byProject: {
      index: "gsi1",
      pk: { field: "gsi1pk", composite: ["projectId"] },
      sk: { field: "gsi1sk", composite: ["status", "taskId"] },
    },
  },
  timestamps: true,
  versioned: true,
})

// 4. Use it
const program = Effect.gen(function* () {
  // Create
  const task = yield* Tasks.put({
    taskId: "t-1",
    projectId: "p-1",
    title: "Ship v1.0",
    status: "active",
    priority: 1,
    createdBy: "alice",
  })

  // Read
  const found = yield* Tasks.get({ taskId: "t-1" })

  // Query with sort key condition + filter
  const active = yield* Tasks.query.byProject({ projectId: "p-1" }).pipe(
    Query.where({ status: "active" }),
    Query.filter({ priority: { gte: 1 } }),
    Query.limit(25),
    Query.execute,
  )

  // Update with optimistic locking
  yield* Tasks.update({ taskId: "t-1" }).pipe(
    Tasks.set({ status: "done" }),
    Tasks.expectedVersion(1),
    Entity.asRecord,
  )

  // Delete
  yield* Tasks.delete({ taskId: "t-1" })

  // Scan all tasks
  const all = yield* Tasks.scan().pipe(Query.execute)

  // Stream pagination
  const stream = yield* Tasks.query.byProject({ projectId: "p-1" }).pipe(
    Query.paginate,
  )
  yield* Stream.runForEach(stream, (t) =>
    Effect.log(`Task: ${t.title}`)
  )
})

// Provide dependencies via Layers
const main = program.pipe(
  Effect.provide(
    Layer.mergeAll(
      DynamoClient.layer({ region: "us-east-1" }),
      MainTable.layer({ name: "MainTable" }),
    )
  ),
)

Effect.runPromise(main)
```

### What you get from one entity definition

From the `Tasks` entity above, effect-dynamodb derives **7 types automatically**:

| Type | What it is |
|------|------------|
| `Entity.Model<typeof Tasks>` | Pure domain object (`Task`) |
| `Entity.Record<typeof Tasks>` | Domain + system fields (version, timestamps) |
| `Entity.Input<typeof Tasks>` | Creation input (no system fields) |
| `Entity.Update<typeof Tasks>` | Mutable fields only (keys + immutable excluded) |
| `Entity.Key<typeof Tasks>` | Primary key attributes (`{ taskId }`) |
| `Entity.Item<typeof Tasks>` | Full unmarshalled DynamoDB item |
| `Entity.Marshalled<typeof Tasks>` | DynamoDB `AttributeValue` format |

Plus: CRUD operations, index queries, scan, batch, transactions, versioning, and soft delete — all type-safe.

## Key Concepts

**Four declarations drive everything:**

```
Schema.Class  →  DynamoSchema  →  Table  →  Entity
(domain)         (namespace)      (physical)  (binding)
```

1. **Model** — A standard `Schema.Class` defining your domain fields. No DynamoDB concepts.
2. **DynamoSchema** — Application namespace and version. Prefixes every generated key.
3. **Table** — Physical DynamoDB table with Layer-based name injection at runtime.
4. **Entity** — Binds model to table with index definitions, system fields, unique constraints, and collections.

## API at a Glance

| Module | Description |
|--------|-------------|
| [`DynamoModel`](./docs/api-reference.md#dynamomodel) | `Immutable` field annotation |
| [`DynamoSchema`](./docs/api-reference.md#dynamoschema) | Application namespace and key prefixing |
| [`Table`](./docs/api-reference.md#table) | Table definition with Layer-based name injection |
| [`Entity`](./docs/api-reference.md#entity) | Model-to-table binding, CRUD, queries, lifecycle management |
| [`Query`](./docs/api-reference.md#query) | Pipeable `Query<A>` data type with composable combinators |
| [`Collection`](./docs/api-reference.md#collection) | Multi-entity queries across shared indexes |
| [`Transaction`](./docs/api-reference.md#transaction) | Atomic multi-item get and write operations |
| [`Aggregate`](./docs/api-reference.md#aggregate) | Graph-based composite domain models with edges and ref hydration |
| [`Batch`](./docs/api-reference.md#batch) | Batch get/write with auto-chunking and retry |
| [`EventStore`](./docs/api-reference.md#eventstore) | Append-only event store with stream replay and snapshots |
| [`Expression`](./docs/api-reference.md#expression) | Condition, filter, and update expression builders |
| [`Projection`](./docs/api-reference.md#projection) | ProjectionExpression builder |
| [`KeyComposer`](./docs/api-reference.md#keycomposer) | Composite key composition utilities |
| [`Marshaller`](./docs/api-reference.md#marshaller) | DynamoDB marshal/unmarshal wrapper |
| [`DynamoClient`](./docs/api-reference.md#dynamoclient) | Effect Service wrapping AWS SDK DynamoDBClient |
| [Errors](./docs/api-reference.md#errors) | 20 tagged error types for precise `catchTag` handling |

## Error Handling

All errors are tagged for precise discrimination:

```typescript
const user = yield* UserEntity.get({ userId: "u-1" }).pipe(
  Effect.catchTag("ItemNotFound", () => Effect.succeed(null)),
  Effect.catchTag("ValidationError", (e) =>
    Effect.die(`Schema error: ${e.message}`)
  ),
  Effect.catchTag("DynamoError", (e) =>
    Effect.die(`AWS error in ${e.operation}: ${e.cause}`)
  ),
)
```

Available errors: `DynamoError`, `ItemNotFound`, `ConditionalCheckFailed`, `ValidationError`, `TransactionCancelled`, `UniqueConstraintViolation`, `OptimisticLockError`, `TransactionOverflow`, `RefNotFound`, `ItemDeleted`, `ItemNotDeleted`, `VersionConflict`, `AggregateAssemblyError`, `AggregateDecompositionError`, `AggregateTransactionOverflow`, `CascadePartialFailure`, and more.

## Documentation

| Guide | Description |
|-------|-------------|
| [Getting Started](./docs/getting-started.md) | Prerequisites, installation, 5-minute walkthrough |
| [Modeling](./docs/modeling.md) | Models, schemas, tables, entities, derived types |
| [Indexes & Collections](./docs/indexes.md) | Access patterns, composite keys, isolated vs clustered collections |
| [Queries](./docs/queries.md) | Query API, sort key conditions, scan, consistent reads, pagination |
| [Data Integrity](./docs/data-integrity.md) | Unique constraints, versioning, optimistic concurrency |
| [Lifecycle](./docs/lifecycle.md) | Soft delete, restore, purge, version retention |
| [Advanced](./docs/advanced.md) | Conditional writes, create, rich updates, DynamoDB Streams, testing, expressions |
| [API Reference](./docs/api-reference.md) | Module-by-module export reference |
| [FAQ & Troubleshooting](./docs/faq-troubleshooting.md) | Common questions, error solutions, and debugging tips |
| [Migration from ElectroDB](./docs/migration-from-electrodb.md) | Concept mapping and side-by-side examples |

## Examples

17 runnable examples demonstrating all major features. Run against DynamoDB Local:

```bash
docker run -p 8000:8000 amazon/dynamodb-local
npx tsx examples/<name>.ts
```

| Example | Description |
|---------|-------------|
| [`starter.ts`](./examples/starter.ts) | Minimal single-entity setup |
| [`crud.ts`](./examples/crud.ts) | Put, get, update, delete operations |
| [`hr.ts`](./examples/hr.ts) | Multi-entity HR system with collections and queries |
| [`task-manager.ts`](./examples/task-manager.ts) | Task management with indexes and sort key conditions |
| [`blog.ts`](./examples/blog.ts) | Blog with posts and comments, sub-collections |
| [`shopping-mall.ts`](./examples/shopping-mall.ts) | Multi-tenant e-commerce with index overloading |
| [`library-system.ts`](./examples/library-system.ts) | Library with versioning, soft delete, and unique constraints |
| [`version-control.ts`](./examples/version-control.ts) | Version retention and snapshot queries |
| [`batch.ts`](./examples/batch.ts) | Batch get and write with auto-chunking |
| [`scan.ts`](./examples/scan.ts) | Entity scan with filters, limits, and consistent reads |
| [`projections.ts`](./examples/projections.ts) | ProjectionExpression for selective attribute reads |
| [`expressions.ts`](./examples/expressions.ts) | Conditional writes, create, and filter expressions |
| [`unique-constraints.ts`](./examples/unique-constraints.ts) | Unique constraint enforcement and violation handling |
| [`updates.ts`](./examples/updates.ts) | Rich updates: remove, add, subtract, append, deleteFromSet |
| [`cricket.ts`](./examples/cricket.ts) | Aggregate CRUD with entity refs and cascade updates |
| [`event-sourcing.ts`](./examples/event-sourcing.ts) | EventStore with decider pattern and stream replay |
| [`_walkthrough.ts`](./examples/_walkthrough.ts) | Step-by-step walkthrough (STEP=1..5) |

## vs ElectroDB

effect-dynamodb is designed for teams already using [Effect TS](https://effect.website). If you're comparing with [ElectroDB](https://electrodb.dev):

| | effect-dynamodb | ElectroDB |
|---|-----------------|-----------|
| **Type safety** | 7 derived types, branded types, Schema ecosystem | Good inference, fewer derived types |
| **Lifecycle management** | Built-in versioning, soft delete, restore, purge, unique constraints | Manual implementation |
| **Concurrency** | Built-in optimistic locking | Manual |
| **Composability** | Effect pipelines, Stream pagination, Layer DI, dual APIs | Fluent chaining |
| **Error handling** | Tagged errors with `catchTag` | Error codes |
| **DX for simple cases** | More setup (Schema + DynamoSchema + Table + Entity) | Less boilerplate |
| **DX for complex cases** | Effect composition scales better | Callback chains |

See [Migration from ElectroDB](./docs/migration-from-electrodb.md) for detailed concept mapping and side-by-side examples.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for setup, commands, and guidelines.

## License

[MIT](./LICENSE)
