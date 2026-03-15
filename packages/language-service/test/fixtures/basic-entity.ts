import * as DynamoModel from "@effect-dynamodb/core/DynamoModel"
import * as DynamoSchema from "@effect-dynamodb/core/DynamoSchema"
import * as Entity from "@effect-dynamodb/core/Entity"
import * as Table from "@effect-dynamodb/core/Table"
import { Schema } from "effect"

class User extends Schema.Class<User>("User")({
  userId: Schema.String,
  email: Schema.String,
  displayName: Schema.NonEmptyString,
  role: Schema.Literals(["admin", "member"]),
  createdBy: Schema.String.pipe(DynamoModel.Immutable),
}) {}

class Task extends Schema.Class<Task>("Task")({
  taskId: Schema.String,
  userId: Schema.String,
  title: Schema.NonEmptyString,
  status: Schema.Literals(["todo", "in-progress", "done"]),
  priority: Schema.Number,
}) {}

const AppSchema = DynamoSchema.make({ name: "crud-demo", version: 1 })
const MainTable = Table.make({ schema: AppSchema })

const _Users = Entity.make({
  model: User,
  table: MainTable,
  entityType: "User",
  indexes: {
    primary: {
      pk: { field: "pk", composite: ["userId"] },
      sk: { field: "sk", composite: [] },
    },
    byRole: {
      index: "gsi1",
      pk: { field: "gsi1pk", composite: ["role"] },
      sk: { field: "gsi1sk", composite: ["userId"] },
    },
  },
  timestamps: true,
  versioned: { retain: true },
})

const _Tasks = Entity.make({
  model: Task,
  table: MainTable,
  entityType: "Task",
  indexes: {
    primary: {
      pk: { field: "pk", composite: ["taskId"] },
      sk: { field: "sk", composite: [] },
    },
    byUser: {
      index: "gsi1",
      pk: { field: "gsi1pk", composite: ["userId"] },
      sk: { field: "gsi1sk", composite: ["status", "taskId"] },
    },
  },
  timestamps: true,
  versioned: true,
  softDelete: true,
})
