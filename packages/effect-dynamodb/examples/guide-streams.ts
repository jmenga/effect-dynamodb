/**
 * DynamoDB Streams guide example — effect-dynamodb
 *
 * Demonstrates:
 *   - Entity.decodeMarshalledItem() for decoding AttributeValue format
 *   - Entity.itemSchema() for decoding unmarshalled format
 *   - Entity.Marshalled<E> type helper
 *   - Processing multiple entity types via __edd_e__ discriminator
 *
 * Note: This example is not runnable against DynamoDB Local — it demonstrates
 * the type-safe decoding APIs for use in Lambda functions consuming DynamoDB Streams.
 *
 * Type-check:
 *   npx tsc -p tsconfig.examples.json --noEmit
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { Console, Effect, Schema } from "effect"

// Import from source (use "effect-dynamodb" when published)
import * as DynamoModel from "../src/DynamoModel.js"
import * as DynamoSchema from "../src/DynamoSchema.js"
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
// 2. Schema + Table + Entities
// ---------------------------------------------------------------------------

// #region entities
const AppSchema = DynamoSchema.make({ name: "myapp", version: 1 })

const EmployeeEntity = Entity.make({
  model: EmployeeModel,
  entityType: "Employee",
  indexes: {
    primary: {
      pk: { field: "pk", composite: ["employeeId"] },
      sk: { field: "sk", composite: [] },
    },
    byDepartment: {
      index: "gsi1",
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
  indexes: {
    primary: {
      pk: { field: "pk", composite: ["taskId"] },
      sk: { field: "sk", composite: [] },
    },
    byEmployee: {
      index: "gsi1",
      pk: { field: "gsi1pk", composite: ["employeeId"] },
      sk: { field: "gsi1sk", composite: ["status"] },
    },
  },
  timestamps: true,
})

const _MainTable = Table.make({
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

const decodeUnmarshalledEmployee = (
  marshalledImage: Record<string, AttributeValue>,
) => {
  const unmarshalled = Marshaller.fromAttributeMap(marshalledImage)
  return Schema.decodeUnknownSync(employeeFromItem)(unmarshalled)
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
          const emp = yield* Entity.decodeMarshalledItem(
            EmployeeEntity,
            image,
          )
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
// Demo: exercise the APIs with a synthetic stream event
// ---------------------------------------------------------------------------

const _demo = Effect.gen(function* () {
  // Simulate a marshalled DynamoDB Stream record
  const syntheticEvent: DynamoDBStreamEvent = {
    Records: [
      {
        eventName: "INSERT",
        dynamodb: {
          NewImage: {
            pk: { S: "$myapp#v1#employee#emp-alice" },
            sk: { S: "$myapp#v1#employee" },
            gsi1pk: { S: "$myapp#v1#employee#engineering" },
            gsi1sk: { S: "$myapp#v1#employee#alice" },
            __edd_e__: { S: "Employee" },
            employeeId: { S: "emp-alice" },
            email: { S: "alice@acme.com" },
            displayName: { S: "Alice" },
            department: { S: "Engineering" },
            version: { N: "1" },
            createdAt: { S: "2026-03-22T00:00:00.000Z" },
            updatedAt: { S: "2026-03-22T00:00:00.000Z" },
          },
        },
      },
    ],
  }

  yield* handleEmployeeStream(syntheticEvent)
  yield* handleStreamEvent(syntheticEvent)

  // Demonstrate unmarshalled path
  const image = syntheticEvent.Records[0]!.dynamodb!.NewImage!
  const decoded = decodeUnmarshalledEmployee(image)
  yield* Console.log(`Unmarshalled decode: ${(decoded as Employee).displayName}`)

  // Type-level usage (no runtime effect)
  const _typeCheck: EmployeeMarshalled = image
  void _typeCheck
})
