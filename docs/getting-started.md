# Getting Started

Get up and running with effect-dynamodb in five minutes. This guide walks you through defining a model, creating a table and entity, and performing basic CRUD operations.

## Prerequisites

- Node.js 18+
- An AWS account with DynamoDB access (or DynamoDB Local for development)
- Basic familiarity with [Effect TS](https://effect.website) and [Effect Schema](https://effect.website/docs/schema/introduction)

## Installation

```bash
pnpm add effect-dynamodb effect @effect/experimental @aws-sdk/client-dynamodb @aws-sdk/util-dynamodb
```

## Quick Start: A Single Entity

### 1. Define a Model

Models are plain Effect Schema definitions — no DynamoDB concepts. Use `Schema.Class` for class instances with `instanceof` support, or `Schema.Struct` for plain objects.

```typescript
import { Schema } from "effect"

class Todo extends Schema.Class<Todo>("Todo")({
  todoId: Schema.String,
  title:  Schema.NonEmptyString,
  done:   Schema.Boolean,
}) {}
```

### 2. Create a Schema and Table

```typescript
import { DynamoSchema, Table } from "effect-dynamodb"

const AppSchema = DynamoSchema.make({
  name: "myapp",
  version: 1,
})

const MainTable = Table.make({ schema: AppSchema })
```

### 3. Bind an Entity

The Entity connects your model to the table with key composition rules and optional features.

```typescript
import { Entity } from "effect-dynamodb"

const TodoEntity = Entity.make({
  model: Todo,
  table: MainTable,
  entityType: "Todo",
  indexes: {
    primary: {
      pk: { field: "pk", composite: ["todoId"] },
      sk: { field: "sk", composite: [] },
    },
  },
  timestamps: true,
})
```

This tells effect-dynamodb:
- The partition key is composed from `todoId`
- The sort key is just the entity type prefix (no additional attributes)
- `createdAt` and `updatedAt` are automatically managed

### 4. Use It

```typescript
import { Effect, Layer } from "effect"
import { DynamoClient } from "effect-dynamodb"

const program = Effect.gen(function* () {
  // Create
  const todo = yield* TodoEntity.put({
    todoId: "t-1",
    title: "Learn effect-dynamodb",
    done: false,
  })
  console.log(todo)
  // { todoId: "t-1", title: "Learn effect-dynamodb", done: false,
  //   version: 1, createdAt: DateTime.Utc, updatedAt: DateTime.Utc }

  // Read
  const found = yield* TodoEntity.get({ todoId: "t-1" })

  // Update
  yield* TodoEntity.update({ todoId: "t-1" }, { done: true })

  // Delete
  yield* TodoEntity.delete({ todoId: "t-1" })
})

// Run with a real DynamoDB client
const main = program.pipe(
  Effect.provide(
    Layer.mergeAll(
      DynamoClient.layer({ region: "us-east-1" }),
      MainTable.layer({ name: "Main" }),
    )
  )
)

Effect.runPromise(main)
```

### What Gets Stored in DynamoDB

For the `put` call above, effect-dynamodb generates:

| Attribute | Value |
|-----------|-------|
| `pk` | `$myapp#v1#todo#t-1` |
| `sk` | `$myapp#v1#todo` |
| `__edd_e__` | `Todo` |
| `todoId` | `t-1` |
| `title` | `Learn effect-dynamodb` |
| `done` | `false` |
| `createdAt` | `2024-01-15T10:30:00.000Z` |
| `updatedAt` | `2024-01-15T10:30:00.000Z` |

The key format (`$myapp#v1#todo#t-1`) is automatically generated from the schema, version, entity type, and composite attributes. You declare *which* attributes compose the key — the system handles *how*.

## What's Next?

- [Modeling](./modeling.md) — Learn about Schema.Class models, DynamoSchema, Table, Entity, and derived types
- [Indexes & Collections](./indexes.md) — Define access patterns with primary and secondary indexes
- [Queries](./queries.md) — Use the pipeable Query API for composable, type-safe queries
- [Data Integrity](./data-integrity.md) — Unique constraints, versioning, and optimistic concurrency
- [Lifecycle](./lifecycle.md) — Soft delete, restore, purge, and version retention
- [Advanced](./advanced.md) — DynamoDB Streams, testing patterns, multi-table setups
