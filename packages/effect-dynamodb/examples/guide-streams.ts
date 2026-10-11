/**
 * DynamoDB Streams guide example — effect-dynamodb
 *
 * Demonstrates:
 *   - Entity.decodeMarshalledItem() for decoding AttributeValue format
 *   - Entity.itemSchema() for decoding unmarshalled format
 *   - Entity.Marshalled<E> type helper
 *   - Processing multiple entity types via __edd_e__ discriminator
 *
 * The handlers are written for a Lambda consuming DynamoDB Streams. DynamoDB
 * Local has no stream trigger, so the demo writes items through the typed
 * client, reads their stored images back with a raw scan, wraps them in a
 * stream event and feeds that event to the handlers.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *
 * Run:
 *   npx tsx examples/guide-streams.ts
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { Config, Console, Effect, Layer, Schema } from "effect"

// Import from source (use "effect-dynamodb" when published)
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Marshaller from "../src/Marshaller.js"
import * as Table from "../src/Table.js"

// ---------------------------------------------------------------------------
// 1. Domain models
// ---------------------------------------------------------------------------

// #region models
class Employee extends Schema.Class<Employee>("Employee")({
  employeeId: Schema.String,
  email: Schema.String,
  displayName: Schema.NonEmptyString,
  department: Schema.String,
}) {}

const EmployeeModel = DynamoModel.configure(Employee, {
  email: { immutable: true },
})

class Task extends Schema.Class<Task>("Task")({
  taskId: Schema.String,
  employeeId: Schema.String,
  title: Schema.NonEmptyString,
  status: Schema.String,
}) {}
// #endregion

// ---------------------------------------------------------------------------
// 2. Schema + Table + Entities + Collections
// ---------------------------------------------------------------------------

// #region entities
const AppSchema = DynamoSchema.make({ name: "myapp", version: 1 })

const EmployeeEntity = Entity.make({
  model: EmployeeModel,
  entityType: "Employee",
  primaryKey: {
    pk: { field: "pk", composite: ["employeeId"] },
    sk: { field: "sk", composite: [] },
  },
  indexes: {
    byDepartment: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["department"] },
      sk: { field: "gsi1sk", composite: ["displayName"] },
    },
  },
  timestamps: true,
  versioned: true,
})

const TaskEntity = Entity.make({
  model: Task,
  entityType: "Task",
  primaryKey: {
    pk: { field: "pk", composite: ["taskId"] },
    sk: { field: "sk", composite: [] },
  },
  indexes: {
    byEmployee: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["employeeId"] },
      sk: { field: "gsi1sk", composite: ["status"] },
    },
  },
  timestamps: true,
})

const MainTable = Table.make({
  schema: AppSchema,
  entities: { EmployeeEntity, TaskEntity },
})
// #endregion

// ---------------------------------------------------------------------------
// Minimal DynamoDB Stream event type (avoids @types/aws-lambda dependency)
// ---------------------------------------------------------------------------

// #region stream-types
type DynamoDBStreamEvent = {
  Records: Array<{
    eventName?: "INSERT" | "MODIFY" | "REMOVE"
    dynamodb?: {
      NewImage?: Record<string, AttributeValue>
      OldImage?: Record<string, AttributeValue>
    }
  }>
}
// #endregion

// ---------------------------------------------------------------------------
// 3. Decoding from AttributeValue format (marshalled)
// ---------------------------------------------------------------------------

// #region decode-marshalled
const handleEmployeeStream = (event: DynamoDBStreamEvent) =>
  Effect.gen(function* () {
    for (const record of event.Records) {
      if (record.dynamodb?.NewImage) {
        const employee = yield* Entity.decodeMarshalledItem(
          EmployeeEntity,
          record.dynamodb.NewImage,
        )
        yield* Console.log(`Updated: ${(employee as Employee).displayName}`)
      }
    }
  })
// #endregion

// ---------------------------------------------------------------------------
// 4. Decoding from unmarshalled format
// ---------------------------------------------------------------------------

// #region decode-unmarshalled
const employeeFromItem = Entity.itemSchema(EmployeeEntity)

const decodeUnmarshalledEmployee = (marshalledImage: Record<string, AttributeValue>) => {
  const unmarshalled = Marshaller.fromAttributeMap(marshalledImage)
  return Schema.decodeUnknownEffect(employeeFromItem)(unmarshalled)
}
// #endregion

// ---------------------------------------------------------------------------
// 5. Typing the marshalled shape
// ---------------------------------------------------------------------------

// #region marshalled-type
type EmployeeMarshalled = Entity.Marshalled<typeof EmployeeEntity>
// {
//   readonly [x: string]: {
//     readonly S?: string
//     readonly N?: string
//     readonly BOOL?: boolean
//     readonly NULL?: boolean
//     readonly L?: ReadonlyArray<unknown>
//     readonly M?: Record<string, unknown>
//   }
// }
// #endregion

// ---------------------------------------------------------------------------
// 6. Processing multiple entity types
// ---------------------------------------------------------------------------

// #region multi-entity
const handleStreamEvent = (event: DynamoDBStreamEvent) =>
  Effect.gen(function* () {
    for (const record of event.Records) {
      const image = record.dynamodb?.NewImage
      if (!image) continue

      const entityType = image["__edd_e__"]?.S
      switch (entityType) {
        case "Employee": {
          const emp = yield* Entity.decodeMarshalledItem(EmployeeEntity, image)
          yield* handleEmployeeChange(emp as Entity.Record<typeof EmployeeEntity>)
          break
        }
        case "Task": {
          const task = yield* Entity.decodeMarshalledItem(TaskEntity, image)
          yield* handleTaskChange(task as Entity.Record<typeof TaskEntity>)
          break
        }
      }
    }
  })

const handleEmployeeChange = (emp: Entity.Record<typeof EmployeeEntity>) =>
  Console.log(`Employee changed: ${emp.displayName} (${emp.email})`)

const handleTaskChange = (task: Entity.Record<typeof TaskEntity>) =>
  Console.log(`Task changed: ${task.title} (${task.status})`)
// #endregion

// ---------------------------------------------------------------------------
// Demo: feed the handlers a stream event built from real stored images
// ---------------------------------------------------------------------------

const assertEq = <T>(actual: T, expected: T, label: string): void => {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`Assertion failed [${label}]: expected ${e}, got ${a}`)
}

const program = Effect.gen(function* () {
  const db = yield* DynamoClient.make({
    entities: { EmployeeEntity, TaskEntity },
    tables: { MainTable },
  })
  const client = yield* DynamoClient
  const { name: tableName } = yield* MainTable.Tag

  // Start clean: drop the table a failed earlier run may have left behind
  yield* db.tables.MainTable.delete().pipe(
    Effect.catchTag("ResourceNotFoundError", () => Effect.void),
  )
  yield* db.tables.MainTable.create()

  yield* db.entities.EmployeeEntity.put({
    employeeId: "emp-alice",
    email: "alice@acme.com",
    displayName: "Alice",
    department: "Engineering",
  })
  yield* db.entities.TaskEntity.put({
    taskId: "t-1",
    employeeId: "emp-alice",
    title: "Write the stream handler",
    status: "open",
  })

  // The NewImage of an INSERT record is the item exactly as stored
  const { Items: images = [] } = yield* client.scan({ TableName: tableName })
  const toInsert = (NewImage: Record<string, AttributeValue>) => ({
    eventName: "INSERT" as const,
    dynamodb: { NewImage },
  })
  const employeeImages = images.filter((image) => image["__edd_e__"]?.S === "Employee")
  assertEq(employeeImages.length, 1, "one employee image")
  assertEq(images.length, 2, "one employee and one task image")

  yield* handleEmployeeStream({ Records: employeeImages.map(toInsert) })
  yield* handleStreamEvent({ Records: images.map(toInsert) })

  // Unmarshalled path
  const employeeImage = employeeImages[0]!
  const decoded = yield* decodeUnmarshalledEmployee(employeeImage)

  // Type-level usage: a stored image fits Entity.Marshalled
  const _typed: EmployeeMarshalled = employeeImage
  void _typed
  assertEq(decoded.displayName, "Alice", "unmarshalled decode")
  yield* Console.log(`Unmarshalled decode: ${decoded.displayName}`)

  yield* db.tables.MainTable.delete()
})

const AppLayer = Layer.mergeAll(
  DynamoClient.layerConfig({
    region: Config.succeed("us-east-1"),
    endpoint: Config.String("DYNAMODB_ENDPOINT").pipe(Config.withDefault("http://localhost:8000")),
    credentials: Config.succeed({ accessKeyId: "local", secretAccessKey: "local" }),
  }),
  MainTable.layer({ name: "streams-demo-table" }),
)

Effect.runPromise(program.pipe(Effect.provide(AppLayer))).then(() => console.log("\nDone."))
