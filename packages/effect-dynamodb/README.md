# effect-dynamodb

Schema-driven DynamoDB ORM for [Effect TS](https://effect.website). Single-table design as a first-class pattern with type-safe entities, composite key composition, Stream-based pagination, and Layer-based dependency injection.

[![npm](https://img.shields.io/npm/v/effect-dynamodb)](https://www.npmjs.com/package/effect-dynamodb)
[![license](https://img.shields.io/npm/l/effect-dynamodb)](./LICENSE)

**Documentation:** https://jmenga.github.io/effect-dynamodb

## Installation

```bash
pnpm add effect-dynamodb effect @aws-sdk/client-dynamodb @aws-sdk/util-dynamodb
```

`effect` is a peer dependency — install the version your application uses.

## Quick start

```typescript
import { Effect, Schema } from "effect"
import { DynamoSchema, Entity, Table, DynamoClient } from "effect-dynamodb"

class Task extends Schema.Class<Task>("Task")({
  taskId: Schema.String,
  projectId: Schema.String,
  title: Schema.NonEmptyString,
  status: Schema.Literals(["todo", "active", "done"]),
}) {}

const AppSchema = DynamoSchema.make({ name: "myapp", version: 1 })

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
})

const MainTable = Table.make({ schema: AppSchema, entities: { Tasks } })

const program = Effect.gen(function* () {
  const db = yield* DynamoClient.make({ entities: { Tasks }, tables: { MainTable } })

  yield* db.entities.Tasks.put({
    taskId: "t-1", projectId: "p-1", title: "Ship v1", status: "active",
  })

  const active = yield* db.entities.Tasks
    .byProject({ projectId: "p-1" })
    .filter((t, { eq }) => eq(t.status, "active"))
    .collect()
})
```

See the [full documentation](https://jmenga.github.io/effect-dynamodb) for guides, tutorials, and API reference.

## License

[MIT](./LICENSE)
