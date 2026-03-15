# effect-dynamodb Documentation

An Effect TS ORM for DynamoDB providing Schema-driven entity modeling, single-table design as a first-class pattern, automatic key composition, type-safe pipeable queries, and DynamoDB client as an Effect Service.

## Guides

| Guide | Description |
|-------|-------------|
| [Getting Started](./getting-started.md) | Prerequisites, installation, and a 5-minute single-entity walkthrough |
| [Modeling](./modeling.md) | Schema.Class models, DynamoSchema namespaces, Table definitions, Entity binding, and the 7 derived types |
| [Indexes & Collections](./indexes.md) | Primary and secondary index definition, key generation, isolated vs clustered collections, sub-collections |
| [Queries](./queries.md) | Pipeable Query API, entity query accessors, collection queries, sort key conditions, scan, consistent reads, pagination |
| [Data Integrity](./data-integrity.md) | Unique constraints, versioning, optimistic concurrency, idempotency |
| [Lifecycle](./lifecycle.md) | Soft delete, restore, purge, version retention, TTL |
| [Aggregates & Refs](./aggregates.md) | Entity references (DynamoModel.ref), graph-based aggregates, cascade updates |
| [Advanced](./advanced.md) | Conditional writes, create, rich updates, DynamoDB Streams, testing patterns, multi-table, expressions, batch operations |
| [API Reference](./api-reference.md) | Module-by-module reference for all public exports |
| [Migration from ElectroDB](./migration-from-electrodb.md) | Concept mapping, side-by-side examples, and feature comparison |

## Core Concepts

**Four declarations drive everything:**

```
Schema.Class  →  DynamoSchema  →  Table  →  Entity
(domain)         (namespace)      (physical)  (binding)
```

1. **Model** — A standard `Schema.Class` defining your domain fields. No DynamoDB concepts.
2. **DynamoSchema** — Application namespace and version. Prefixes every generated key.
3. **Table** — Physical DynamoDB table: name, primary key, and secondary indexes.
4. **Entity** — Binds model to table with index definitions, system fields, unique constraints, and collection membership.

**Seven types are derived automatically** from these declarations — no manual type maintenance:

| Type | Description |
|------|-------------|
| `Entity.Model<E>` | Pure domain object |
| `Entity.Record<E>` | Domain + system metadata (version, timestamps) |
| `Entity.Input<E>` | Creation input (no system fields) |
| `Entity.Update<E>` | Mutable fields only (keys and immutable excluded) |
| `Entity.Key<E>` | Primary key attributes |
| `Entity.Item<E>` | Full unmarshalled DynamoDB item |
| `Entity.Marshalled<E>` | DynamoDB AttributeValue format |

## Key Design Principles

- **Domain models are portable.** A `User` schema works with DynamoDB, SQL, or API responses.
- **Entity owns storage concerns.** Key composition, timestamps, versioning, soft delete — configured on Entity, not model.
- **Convention over configuration.** Declare *which* attributes compose keys, not *how*. The system handles format, delimiters, and serialization.
- **Composable queries.** Queries are pipeable data types (`Query<A>`) with combinators, following Effect TS idioms.
- **Type safety from declarations.** All types derived automatically. Change the Entity, types update everywhere.

## Quick Example

```typescript
import { Schema, Effect, Layer } from "effect"
import {
  DynamoSchema, Table, Entity,
  Query, DynamoClient
} from "effect-dynamodb"

// 1. Model
class Task extends Schema.Class<Task>("Task")({
  taskId:    Schema.String,
  projectId: Schema.String,
  title:     Schema.NonEmptyString,
  status:    Schema.Literals(["todo", "active", "done"]),
}) {}

// 2. Schema + Table
const AppSchema = DynamoSchema.make({ name: "myapp", version: 1 })
const MainTable = Table.make({ schema: AppSchema })

// 3. Entity
const TaskEntity = Entity.make({
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
      sk: { field: "gsi1sk", composite: ["status"] },
    },
  },
  timestamps: true,
  versioned: true,
})

// 4. Use
const program = Effect.gen(function* () {
  yield* TaskEntity.put({
    taskId: "t-1", projectId: "p-1",
    title: "Ship it", status: "active",
  })

  const active = yield* TaskEntity.query.byProject({ projectId: "p-1" }).pipe(
    Query.where({ status: "active" }),
    Query.execute,
  )
})

Effect.runPromise(program.pipe(
  Effect.provide(
    Layer.mergeAll(
      DynamoClient.layer({ region: "us-east-1" }),
      MainTable.layer({ name: "Main" }),
    )
  )
))
```
