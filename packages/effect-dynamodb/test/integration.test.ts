/**
 * Integration test: 2 entities (User + Order) on a single table.
 * Validates CRUD + query + scan + create + rich updates end-to-end
 * using mocked DynamoClient.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { it } from "@effect/vitest"
import { Effect, Layer, Schema } from "effect"
import { beforeEach, describe, expect, vi } from "vitest"
import * as Batch from "../src/Batch.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as DynamoModel from "../src/DynamoModel.js"
import * as DynamoSchema from "../src/DynamoSchema.js"
import * as Entity from "../src/Entity.js"
import { DynamoError } from "../src/Errors.js"
import { fromAttributeMap } from "../src/Marshaller.js"
import * as Query from "../src/Query.js"
import * as Table from "../src/Table.js"

// --- Models ---

const AppSchema = DynamoSchema.make({ name: "myapp", version: 1 })
const MainTable = Table.make({ schema: AppSchema })

class User extends Schema.Class<User>("User")({
  userId: Schema.String,
  email: Schema.String,
  name: Schema.NonEmptyString,
  role: Schema.Literals(["admin", "member"]),
}) {}

class Order extends Schema.Class<Order>("Order")({
  orderId: Schema.String,
  userId: Schema.String,
  product: Schema.NonEmptyString,
  quantity: Schema.Number,
  status: Schema.Literals(["pending", "shipped", "delivered"]),
}) {}

// --- Entities ---

const UserEntity = Entity.make({
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
})

const OrderEntity = Entity.make({
  model: Order,
  table: MainTable,
  entityType: "Order",
  indexes: {
    primary: {
      pk: { field: "pk", composite: ["orderId"] },
      sk: { field: "sk", composite: [] },
    },
    byUser: {
      index: "gsi1",
      pk: { field: "gsi1pk", composite: ["userId"] },
      sk: { field: "gsi1sk", composite: ["orderId"] },
    },
  },
})

// --- In-memory DynamoDB simulation ---

let store: Map<string, Record<string, AttributeValue>>

const storeKey = (pk: string, sk: string): string => `${pk}|${sk}`

const mockPutItem = vi.fn().mockImplementation(async (input: any) => {
  const pk = input.Item.pk?.S ?? ""
  const sk = input.Item.sk?.S ?? ""

  // Simulate ConditionExpression: attribute_not_exists check
  if (input.ConditionExpression?.includes("attribute_not_exists")) {
    const existing = store.get(storeKey(pk, sk))
    if (existing) {
      const err = new Error("ConditionalCheckFailedException")
      ;(err as any).name = "ConditionalCheckFailedException"
      throw err
    }
  }

  store.set(storeKey(pk, sk), input.Item)
  return {}
})

const mockGetItem = vi.fn().mockImplementation(async (input: any) => {
  const pk = input.Key.pk?.S ?? ""
  const sk = input.Key.sk?.S ?? ""
  const item = store.get(storeKey(pk, sk))
  return { Item: item }
})

const mockDeleteItem = vi.fn().mockImplementation(async (input: any) => {
  const pk = input.Key.pk?.S ?? ""
  const sk = input.Key.sk?.S ?? ""
  store.delete(storeKey(pk, sk))
  return {}
})

const mockQuery = vi.fn().mockImplementation(async (input: any) => {
  const items: Array<Record<string, AttributeValue>> = []

  // Extract the PK field name and value from expression attributes
  // Query format: #pk = :pk with ExpressionAttributeNames["#pk"] = actual field name
  const pkFieldName = input.ExpressionAttributeNames["#pk"] as string
  const pkValue = input.ExpressionAttributeValues[":pk"]?.S as string

  // Extract entity type filter values
  const allowedEntityTypes = new Set<string>()
  for (const [key, val] of Object.entries(input.ExpressionAttributeValues)) {
    if (key.startsWith(":et")) {
      allowedEntityTypes.add((val as AttributeValue).S ?? "")
    }
  }

  for (const [, item] of store) {
    // Check partition key match
    if (item[pkFieldName]?.S !== pkValue) continue

    // Check sort key condition if present
    if (input.ExpressionAttributeValues[":sk"]) {
      const skFieldName = input.ExpressionAttributeNames["#sk"] as string
      const skValue = input.ExpressionAttributeValues[":sk"]?.S as string
      const itemSkValue = item[skFieldName]?.S ?? ""

      if (input.KeyConditionExpression.includes("begins_with")) {
        if (!itemSkValue.startsWith(skValue)) continue
      } else {
        if (itemSkValue !== skValue) continue
      }
    }

    // Check entity type filter
    if (allowedEntityTypes.size > 0) {
      const entityType = item.__edd_e__?.S ?? ""
      if (!allowedEntityTypes.has(entityType)) continue
    }

    // Check cascade filter conditions (#cf0 = :cf0, etc.)
    let filterPassed = true
    if (input.ExpressionAttributeNames && input.ExpressionAttributeValues) {
      for (const [nameKey, attrName] of Object.entries(input.ExpressionAttributeNames)) {
        if (!nameKey.startsWith("#cf")) continue
        const valKey = nameKey.replace("#", ":")
        const expectedVal = input.ExpressionAttributeValues[valKey]
        if (expectedVal) {
          const itemVal = item[attrName as string]
          if (itemVal?.S !== expectedVal.S) {
            filterPassed = false
            break
          }
        }
      }
    }
    if (!filterPassed) continue

    items.push(item)
  }

  return { Items: items, LastEvaluatedKey: undefined }
})

const mockScan = vi.fn().mockImplementation(async (input: any) => {
  const items: Array<Record<string, AttributeValue>> = []

  // Extract entity type filter values
  const allowedEntityTypes = new Set<string>()
  if (input.ExpressionAttributeValues) {
    for (const [key, val] of Object.entries(input.ExpressionAttributeValues)) {
      if (key.startsWith(":et")) {
        allowedEntityTypes.add((val as AttributeValue).S ?? "")
      }
    }
  }

  for (const [, item] of store) {
    // Check entity type filter
    if (allowedEntityTypes.size > 0) {
      const entityType = item.__edd_e__?.S ?? ""
      if (!allowedEntityTypes.has(entityType)) continue
    }
    items.push(item)
  }

  return { Items: items, LastEvaluatedKey: undefined }
})

const mockUpdateItem = vi.fn().mockImplementation(async (input: any) => {
  const pk = input.Key.pk?.S ?? ""
  const sk = input.Key.sk?.S ?? ""
  const existing = store.get(storeKey(pk, sk))
  if (!existing) {
    const err = new Error("Item not found")
    throw err
  }

  // Simulate SET updates by parsing UpdateExpression for `#name = :val` pairs
  const updatedItem = { ...existing }

  if (input.UpdateExpression && input.ExpressionAttributeNames && input.ExpressionAttributeValues) {
    // Extract SET clause assignments: "SET #a = :b, #c = :d"
    const setMatch = (input.UpdateExpression as string).match(
      /SET\s+(.+?)(?:\s+(?:REMOVE|ADD|DELETE)|$)/i,
    )
    if (setMatch) {
      const assignments = setMatch[1]!.split(",").map((s: string) => s.trim())
      for (const assignment of assignments) {
        const parts = assignment.match(/(#\w+)\s*=\s*(:[\w]+)/)
        if (parts) {
          const nameKey = parts[1]!
          const valKey = parts[2]!
          const attrName = input.ExpressionAttributeNames[nameKey]
          const attrVal = input.ExpressionAttributeValues[valKey]
          if (attrName && attrVal) {
            updatedItem[attrName as string] = attrVal
          }
        }
      }
    }
  }

  store.set(storeKey(pk, sk), updatedItem)
  return { Attributes: updatedItem }
})

const mockBatchGetItem = vi.fn().mockImplementation(async (input: any) => {
  const responses: Record<string, Array<Record<string, AttributeValue>>> = {}

  for (const [tableName, request] of Object.entries(input.RequestItems) as any) {
    responses[tableName] = []
    for (const key of request.Keys) {
      const pk = key.pk?.S ?? ""
      const sk = key.sk?.S ?? ""
      const item = store.get(storeKey(pk, sk))
      if (item) responses[tableName].push(item)
    }
  }

  return { Responses: responses, UnprocessedKeys: {} }
})

const mockBatchWriteItem = vi.fn().mockImplementation(async (input: any) => {
  for (const [, requests] of Object.entries(input.RequestItems) as any) {
    for (const req of requests) {
      if (req.PutRequest) {
        const pk = req.PutRequest.Item.pk?.S ?? ""
        const sk = req.PutRequest.Item.sk?.S ?? ""
        store.set(storeKey(pk, sk), req.PutRequest.Item)
      } else if (req.DeleteRequest) {
        const pk = req.DeleteRequest.Key.pk?.S ?? ""
        const sk = req.DeleteRequest.Key.sk?.S ?? ""
        store.delete(storeKey(pk, sk))
      }
    }
  }

  return { UnprocessedItems: {} }
})

const mockTransactWriteItems = vi.fn().mockImplementation(async (input: any) => {
  // First pass: check all conditions (atomic — no writes until all conditions pass)
  const cancellationReasons: Array<{ Code: string; Message?: string }> = []
  let hasFailed = false

  for (const item of input.TransactItems) {
    if (item.Put) {
      const pk = item.Put.Item.pk?.S ?? ""
      const sk = item.Put.Item.sk?.S ?? ""

      if (item.Put.ConditionExpression?.includes("attribute_not_exists")) {
        const existing = store.get(storeKey(pk, sk))
        if (existing) {
          cancellationReasons.push({
            Code: "ConditionalCheckFailed",
            Message: "Condition not satisfied",
          })
          hasFailed = true
          continue
        }
      }

      // Check version condition (#ver = :expectedVer)
      if (item.Put.ConditionExpression?.includes("#ver = :expectedVer")) {
        const existing = store.get(storeKey(pk, sk))
        if (existing) {
          const verField = item.Put.ExpressionAttributeNames?.["#ver"]
          const expectedVer = item.Put.ExpressionAttributeValues?.[":expectedVer"]
          if (verField && expectedVer && existing[verField]?.N !== expectedVer.N) {
            cancellationReasons.push({
              Code: "ConditionalCheckFailed",
              Message: "Version mismatch",
            })
            hasFailed = true
            continue
          }
        }
      }
    }
    cancellationReasons.push({ Code: "None" })
  }

  if (hasFailed) {
    const err = new Error("TransactionCanceledException")
    ;(err as any).name = "TransactionCanceledException"
    ;(err as any).CancellationReasons = cancellationReasons
    throw err
  }

  // Second pass: apply all operations
  for (const item of input.TransactItems) {
    if (item.Put) {
      const pk = item.Put.Item.pk?.S ?? ""
      const sk = item.Put.Item.sk?.S ?? ""
      store.set(storeKey(pk, sk), item.Put.Item)
    } else if (item.Delete) {
      const pk = item.Delete.Key.pk?.S ?? ""
      const sk = item.Delete.Key.sk?.S ?? ""
      store.delete(storeKey(pk, sk))
    }
  }
  return {}
})

const TestDynamoClient = Layer.succeed(DynamoClient, {
  putItem: (input) =>
    Effect.tryPromise({
      try: () => mockPutItem(input),
      catch: (e) => new DynamoError({ operation: "PutItem", cause: e }),
    }),
  getItem: (input) =>
    Effect.tryPromise({
      try: () => mockGetItem(input),
      catch: (e) => new DynamoError({ operation: "GetItem", cause: e }),
    }),
  deleteItem: (input) =>
    Effect.tryPromise({
      try: () => mockDeleteItem(input),
      catch: (e) => new DynamoError({ operation: "DeleteItem", cause: e }),
    }),
  updateItem: (input) =>
    Effect.tryPromise({
      try: () => mockUpdateItem(input),
      catch: (e) => new DynamoError({ operation: "UpdateItem", cause: e }),
    }),
  query: (input) =>
    Effect.tryPromise({
      try: () => mockQuery(input),
      catch: (e) => new DynamoError({ operation: "Query", cause: e }),
    }),
  batchGetItem: (input) =>
    Effect.tryPromise({
      try: () => mockBatchGetItem(input),
      catch: (e) => new DynamoError({ operation: "BatchGetItem", cause: e }),
    }),
  batchWriteItem: (input) =>
    Effect.tryPromise({
      try: () => mockBatchWriteItem(input),
      catch: (e) => new DynamoError({ operation: "BatchWriteItem", cause: e }),
    }),
  transactGetItems: () => Effect.die("not used in integration tests"),
  transactWriteItems: (input) =>
    Effect.tryPromise({
      try: () => mockTransactWriteItems(input),
      catch: (e) => new DynamoError({ operation: "TransactWriteItems", cause: e }),
    }),
  createTable: () => Effect.die("not used in integration tests"),
  deleteTable: () => Effect.die("not used in integration tests"),
  scan: (input) =>
    Effect.tryPromise({
      try: () => mockScan(input),
      catch: (e) => new DynamoError({ operation: "Scan", cause: e }),
    }),
})

const TestTableConfig = MainTable.layer({ name: "test-table" })
const TestLayer = Layer.merge(TestDynamoClient, TestTableConfig)

beforeEach(() => {
  store = new Map()
  vi.clearAllMocks()
})

describe("Integration: 2-Entity Single-Table", () => {
  it.effect("full CRUD lifecycle for User entity", () =>
    Effect.gen(function* () {
      // PUT
      const alice = yield* UserEntity.put({
        userId: "u-1",
        email: "alice@example.com",
        name: "Alice",
        role: "admin",
      })
      expect(alice.userId).toBe("u-1")
      expect(alice.email).toBe("alice@example.com")

      // Verify composed keys in store
      const putCall = mockPutItem.mock.calls[0]![0]
      const storedItem = fromAttributeMap(putCall.Item)
      expect(storedItem.pk).toBe("$myapp#v1#user#u-1")
      expect(storedItem.sk).toBe("$myapp#v1#user")
      expect(storedItem.gsi1pk).toBe("$myapp#v1#user#admin")
      expect(storedItem.gsi1sk).toBe("$myapp#v1#user#u-1")
      expect(storedItem.__edd_e__).toBe("User")

      // GET
      const fetched = yield* UserEntity.get({ userId: "u-1" })
      expect(fetched.userId).toBe("u-1")
      expect(fetched.email).toBe("alice@example.com")

      // DELETE
      yield* UserEntity.delete({ userId: "u-1" })

      // GET after delete → ItemNotFound
      const error = yield* UserEntity.get({ userId: "u-1" }).asEffect().pipe(Effect.flip)
      expect(error._tag).toBe("ItemNotFound")
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("full CRUD lifecycle for Order entity", () =>
    Effect.gen(function* () {
      // PUT
      const order = yield* OrderEntity.put({
        orderId: "ord-1",
        userId: "u-1",
        product: "Widget",
        quantity: 3,
        status: "pending",
      })
      expect(order.orderId).toBe("ord-1")
      expect(order.product).toBe("Widget")

      // Verify composed keys
      const putCall = mockPutItem.mock.calls[0]![0]
      const storedItem = fromAttributeMap(putCall.Item)
      expect(storedItem.pk).toBe("$myapp#v1#order#ord-1")
      expect(storedItem.sk).toBe("$myapp#v1#order")
      expect(storedItem.gsi1pk).toBe("$myapp#v1#order#u-1")
      expect(storedItem.gsi1sk).toBe("$myapp#v1#order#ord-1")
      expect(storedItem.__edd_e__).toBe("Order")

      // GET
      const fetched = yield* OrderEntity.get({ orderId: "ord-1" })
      expect(fetched.orderId).toBe("ord-1")
      expect(fetched.product).toBe("Widget")

      // DELETE
      yield* OrderEntity.delete({ orderId: "ord-1" })

      const error = yield* OrderEntity.get({ orderId: "ord-1" }).asEffect().pipe(Effect.flip)
      expect(error._tag).toBe("ItemNotFound")
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("both entities coexist in same table", () =>
    Effect.gen(function* () {
      // Put both entity types
      yield* UserEntity.put({
        userId: "u-1",
        email: "alice@example.com",
        name: "Alice",
        role: "admin",
      })
      yield* OrderEntity.put({
        orderId: "ord-1",
        userId: "u-1",
        product: "Widget",
        quantity: 3,
        status: "pending",
      })

      // Both entities are in the store
      expect(store.size).toBe(2)

      // Get each entity independently
      const user = yield* UserEntity.get({ userId: "u-1" })
      expect(user.userId).toBe("u-1")

      const order = yield* OrderEntity.get({ orderId: "ord-1" })
      expect(order.orderId).toBe("ord-1")
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("query users by role (GSI)", () =>
    Effect.gen(function* () {
      yield* UserEntity.put({ userId: "u-1", email: "a@b.com", name: "Alice", role: "admin" })
      yield* UserEntity.put({ userId: "u-2", email: "b@c.com", name: "Bob", role: "admin" })
      yield* UserEntity.put({ userId: "u-3", email: "c@d.com", name: "Charlie", role: "member" })

      const admins = yield* Query.collect(UserEntity.query.byRole({ role: "admin" }))
      expect(admins).toHaveLength(2)

      const members = yield* Query.collect(UserEntity.query.byRole({ role: "member" }))
      expect(members).toHaveLength(1)
      expect(members[0]!.name).toBe("Charlie")
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("query orders by userId (GSI)", () =>
    Effect.gen(function* () {
      yield* OrderEntity.put({
        orderId: "ord-1",
        userId: "u-1",
        product: "Widget",
        quantity: 3,
        status: "pending",
      })
      yield* OrderEntity.put({
        orderId: "ord-2",
        userId: "u-1",
        product: "Gadget",
        quantity: 1,
        status: "shipped",
      })
      yield* OrderEntity.put({
        orderId: "ord-3",
        userId: "u-2",
        product: "Doohickey",
        quantity: 2,
        status: "pending",
      })

      // Query orders for user u-1
      const u1Orders = yield* Query.collect(OrderEntity.query.byUser({ userId: "u-1" }))
      expect(u1Orders).toHaveLength(2)

      // Query orders for user u-2
      const u2Orders = yield* Query.collect(OrderEntity.query.byUser({ userId: "u-2" }))
      expect(u2Orders).toHaveLength(1)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("cross-entity query independence", () =>
    Effect.gen(function* () {
      // Put data for both entities
      yield* UserEntity.put({ userId: "u-1", email: "a@b.com", name: "Alice", role: "admin" })
      yield* OrderEntity.put({
        orderId: "ord-1",
        userId: "u-1",
        product: "Widget",
        quantity: 3,
        status: "pending",
      })

      // Query users by role returns only users (__edd_e__ filter ensures isolation)
      const admins = yield* Query.collect(UserEntity.query.byRole({ role: "admin" }))
      expect(admins).toHaveLength(1)
      expect(admins[0]!.email).toBe("a@b.com")

      // Query orders by userId returns only orders (__edd_e__ filter ensures isolation)
      const orders = yield* Query.collect(OrderEntity.query.byUser({ userId: "u-1" }))
      expect(orders).toHaveLength(1)
      expect(orders[0]!.product).toBe("Widget")
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("key generation follows $schema#v1#entity#attr pattern", () =>
    Effect.gen(function* () {
      yield* UserEntity.put({
        userId: "u-42",
        email: "test@example.com",
        name: "Test",
        role: "member",
      })

      // Verify all composed keys follow the naming convention
      const putCall = mockPutItem.mock.calls[0]![0]
      const item = fromAttributeMap(putCall.Item)

      // Primary key
      expect(item.pk).toBe("$myapp#v1#user#u-42")
      expect(item.sk).toBe("$myapp#v1#user")

      // GSI key (byRole: pk=role, sk=userId)
      expect(item.gsi1pk).toBe("$myapp#v1#user#member")
      expect(item.gsi1sk).toBe("$myapp#v1#user#u-42")

      // Entity type discriminator
      expect(item.__edd_e__).toBe("User")
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("get verifies composed key is sent to DynamoDB", () =>
    Effect.gen(function* () {
      // Pre-populate the store
      yield* UserEntity.put({
        userId: "u-1",
        email: "alice@example.com",
        name: "Alice",
        role: "admin",
      })

      yield* UserEntity.get({ userId: "u-1" })

      const getCall = mockGetItem.mock.calls[0]![0]
      expect(getCall.TableName).toBe("test-table")
      expect(getCall.Key.pk.S).toBe("$myapp#v1#user#u-1")
      expect(getCall.Key.sk.S).toBe("$myapp#v1#user")
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("delete verifies composed key is sent to DynamoDB", () =>
    Effect.gen(function* () {
      yield* UserEntity.put({
        userId: "u-1",
        email: "alice@example.com",
        name: "Alice",
        role: "admin",
      })

      yield* UserEntity.delete({ userId: "u-1" })

      const deleteCall = mockDeleteItem.mock.calls[0]![0]
      expect(deleteCall.TableName).toBe("test-table")
      expect(deleteCall.Key.pk.S).toBe("$myapp#v1#user#u-1")
      expect(deleteCall.Key.sk.S).toBe("$myapp#v1#user")
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("query passes entity type filter to DynamoDB", () =>
    Effect.gen(function* () {
      yield* UserEntity.put({ userId: "u-1", email: "a@b.com", name: "Alice", role: "admin" })

      yield* Query.collect(UserEntity.query.byRole({ role: "admin" }))

      const queryCall = mockQuery.mock.calls[0]![0]
      expect(queryCall.IndexName).toBe("gsi1")
      expect(queryCall.FilterExpression).toContain("#eddE IN (:et0)")
      expect(queryCall.ExpressionAttributeNames["#eddE"]).toBe("__edd_e__")
      expect(queryCall.ExpressionAttributeValues[":et0"].S).toBe("User")
    }).pipe(Effect.provide(TestLayer)),
  )
})

// ---------------------------------------------------------------------------
// Integration: Scan
// ---------------------------------------------------------------------------

describe("Integration: Scan", () => {
  it.effect("scan returns all items of an entity type", () =>
    Effect.gen(function* () {
      yield* UserEntity.put({ userId: "u-1", email: "a@b.com", name: "Alice", role: "admin" })
      yield* UserEntity.put({ userId: "u-2", email: "b@c.com", name: "Bob", role: "member" })
      yield* OrderEntity.put({
        orderId: "o-1",
        userId: "u-1",
        product: "Widget",
        quantity: 1,
        status: "pending",
      })

      // Scan users — should only return users, not orders
      const users = yield* UserEntity.scan().pipe(Query.collect)
      expect(users).toHaveLength(2)

      // Scan orders — should only return orders
      const orders = yield* OrderEntity.scan().pipe(Query.collect)
      expect(orders).toHaveLength(1)
      expect(orders[0]!.product).toBe("Widget")
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("scan with filter narrows results", () =>
    Effect.gen(function* () {
      yield* UserEntity.put({ userId: "u-1", email: "a@b.com", name: "Alice", role: "admin" })
      yield* UserEntity.put({ userId: "u-2", email: "b@c.com", name: "Bob", role: "member" })

      // mockScan returns all matching entity types;
      // The filter is applied by DynamoDB (mocked here at API level)
      const scanCall = yield* UserEntity.scan().pipe(Query.collect)
      expect(scanCall.length).toBeGreaterThanOrEqual(1)

      // Verify scan was called (not query)
      expect(mockScan).toHaveBeenCalled()
      const call = mockScan.mock.calls[0]![0]
      expect(call.FilterExpression).toContain("#eddE IN")
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("scan on empty table returns empty array", () =>
    Effect.gen(function* () {
      const results = yield* UserEntity.scan().pipe(Query.collect)
      expect(results).toHaveLength(0)
    }).pipe(Effect.provide(TestLayer)),
  )
})

// ---------------------------------------------------------------------------
// Integration: Entity.create
// ---------------------------------------------------------------------------

describe("Integration: Entity.create", () => {
  const TimestampedUser = Entity.make({
    model: User,
    table: MainTable,
    entityType: "User",
    indexes: {
      primary: {
        pk: { field: "pk", composite: ["userId"] },
        sk: { field: "sk", composite: [] },
      },
    },
    timestamps: true,
  })

  it.effect("create succeeds for new item", () =>
    Effect.gen(function* () {
      const user = yield* TimestampedUser.create({
        userId: "u-1",
        email: "alice@example.com",
        name: "Alice",
        role: "admin",
      })
      expect(user.userId).toBe("u-1")

      // Verify ConditionExpression was sent
      const putCall = mockPutItem.mock.calls[0]![0]
      expect(putCall.ConditionExpression).toContain("attribute_not_exists")
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("create fails with ConditionalCheckFailed for duplicate", () =>
    Effect.gen(function* () {
      // First create succeeds
      yield* TimestampedUser.create({
        userId: "u-1",
        email: "alice@example.com",
        name: "Alice",
        role: "admin",
      })

      // Second create with same key fails
      const error = yield* TimestampedUser.create({
        userId: "u-1",
        email: "alice2@example.com",
        name: "Alice2",
        role: "member",
      })
        .asEffect()
        .pipe(Effect.flip)

      expect(error._tag).toBe("ConditionalCheckFailed")
    }).pipe(Effect.provide(TestLayer)),
  )
})

// ---------------------------------------------------------------------------
// Integration: Batch Operations
// ---------------------------------------------------------------------------

describe("Integration: Batch Operations", () => {
  it.effect("batch write creates multiple items, batch get retrieves them", () =>
    Effect.gen(function* () {
      // Batch write
      yield* Batch.write([
        UserEntity.put({ userId: "u-1", email: "a@b.com", name: "Alice", role: "admin" }),
        UserEntity.put({ userId: "u-2", email: "b@c.com", name: "Bob", role: "member" }),
        OrderEntity.put({
          orderId: "o-1",
          userId: "u-1",
          product: "Widget",
          quantity: 2,
          status: "pending",
        }),
      ])

      expect(store.size).toBe(3)

      // Batch get
      const [alice, bob, order] = yield* Batch.get([
        UserEntity.get({ userId: "u-1" }),
        UserEntity.get({ userId: "u-2" }),
        OrderEntity.get({ orderId: "o-1" }),
      ])

      expect(alice?.name).toBe("Alice")
      expect(bob?.name).toBe("Bob")
      expect(order?.product).toBe("Widget")
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("batch get returns undefined for missing items", () =>
    Effect.gen(function* () {
      yield* Batch.write([
        UserEntity.put({ userId: "u-1", email: "a@b.com", name: "Alice", role: "admin" }),
      ])

      const [existing, missing] = yield* Batch.get([
        UserEntity.get({ userId: "u-1" }),
        UserEntity.get({ userId: "u-nonexistent" }),
      ])

      expect(existing?.name).toBe("Alice")
      expect(missing).toBeUndefined()
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("batch write with mixed put and delete", () =>
    Effect.gen(function* () {
      // Create initial items
      yield* Batch.write([
        UserEntity.put({ userId: "u-1", email: "a@b.com", name: "Alice", role: "admin" }),
        UserEntity.put({ userId: "u-2", email: "b@c.com", name: "Bob", role: "member" }),
      ])
      expect(store.size).toBe(2)

      // Mixed: add one, delete one
      yield* Batch.write([
        UserEntity.put({ userId: "u-3", email: "c@d.com", name: "Charlie", role: "member" }),
        UserEntity.delete({ userId: "u-1" }),
      ])

      // u-1 deleted, u-2 remains, u-3 added
      const [u1, u2, u3] = yield* Batch.get([
        UserEntity.get({ userId: "u-1" }),
        UserEntity.get({ userId: "u-2" }),
        UserEntity.get({ userId: "u-3" }),
      ])

      expect(u1).toBeUndefined()
      expect(u2?.name).toBe("Bob")
      expect(u3?.name).toBe("Charlie")
    }).pipe(Effect.provide(TestLayer)),
  )
})

// ---------------------------------------------------------------------------
// Integration: Timestamps and Versioning
// ---------------------------------------------------------------------------

describe("Integration: Timestamps + Versioning", () => {
  class Item extends Schema.Class<Item>("Item")({
    itemId: Schema.String,
    name: Schema.NonEmptyString,
  }) {}

  const VersionedItem = Entity.make({
    model: Item,
    table: MainTable,
    entityType: "VersionedItem",
    indexes: {
      primary: {
        pk: { field: "pk", composite: ["itemId"] },
        sk: { field: "sk", composite: [] },
      },
    },
    timestamps: true,
    versioned: true,
  })

  it.effect("put adds timestamps and version to stored item", () =>
    Effect.gen(function* () {
      const result = yield* VersionedItem.put({ itemId: "i-1", name: "Test" }).pipe(Entity.asRecord)

      // Record includes system fields
      expect(result.version).toBe(1)
      expect(result.createdAt).toBeDefined()
      expect(result.updatedAt).toBeDefined()

      // Verify stored in DynamoDB
      const putCall = mockPutItem.mock.calls[0]![0]
      const stored = fromAttributeMap(putCall.Item)
      expect(stored.version).toBe(1)
      expect(stored.createdAt).toBeDefined()
      expect(stored.updatedAt).toBeDefined()
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("get returns record with system fields decoded", () =>
    Effect.gen(function* () {
      yield* VersionedItem.put({ itemId: "i-1", name: "Test" })

      const record = yield* VersionedItem.get({ itemId: "i-1" }).pipe(Entity.asRecord)
      expect(record.version).toBe(1)
      expect(record.createdAt).toBeDefined()
      expect(record.updatedAt).toBeDefined()
    }).pipe(Effect.provide(TestLayer)),
  )
})

// ---------------------------------------------------------------------------
// Integration: Entity Refs (denormalized references)
// ---------------------------------------------------------------------------

describe("Integration: Entity Refs", () => {
  class Team extends Schema.Class<Team>("Team")({
    teamId: Schema.String.pipe(DynamoModel.identifier),
    name: Schema.String,
    country: Schema.String,
  }) {}

  class Player extends Schema.Class<Player>("Player")({
    playerId: Schema.String.pipe(DynamoModel.identifier),
    displayName: Schema.String,
    position: Schema.String,
  }) {}

  class Selection extends Schema.Class<Selection>("Selection")({
    selectionId: Schema.String,
    team: Team.pipe(DynamoModel.ref),
    player: Player.pipe(DynamoModel.ref),
    role: Schema.String,
  }) {}

  const TeamEntity = Entity.make({
    model: Team,
    table: MainTable,
    entityType: "Team",
    indexes: {
      primary: {
        pk: { field: "pk", composite: ["teamId"] },
        sk: { field: "sk", composite: [] },
      },
    },
  })

  const PlayerEntity = Entity.make({
    model: Player,
    table: MainTable,
    entityType: "Player",
    indexes: {
      primary: {
        pk: { field: "pk", composite: ["playerId"] },
        sk: { field: "sk", composite: [] },
      },
    },
  })

  const SelectionEntity = Entity.make({
    model: Selection,
    table: MainTable,
    entityType: "Selection",
    indexes: {
      primary: {
        pk: { field: "pk", composite: ["selectionId"] },
        sk: { field: "sk", composite: [] },
      },
    },
    refs: {
      team: { entity: TeamEntity },
      player: { entity: PlayerEntity },
    },
  })

  it.effect("put with ref IDs hydrates and stores embedded data, get round-trips", () =>
    Effect.gen(function* () {
      // Create referenced entities first
      yield* TeamEntity.put({ teamId: "t-1", name: "Australia", country: "AU" })
      yield* PlayerEntity.put({
        playerId: "p-1",
        displayName: "Steve Smith",
        position: "Batter",
      })

      // Put selection with ref IDs — hydration fetches Team and Player
      yield* SelectionEntity.put({
        selectionId: "sel-1",
        teamId: "t-1",
        playerId: "p-1",
        role: "Captain",
      })

      // Get the selection — should have full embedded data
      const sel = yield* SelectionEntity.get({ selectionId: "sel-1" })
      expect(sel.selectionId).toBe("sel-1")
      expect(sel.role).toBe("Captain")
      expect(sel.team.teamId).toBe("t-1")
      expect(sel.team.name).toBe("Australia")
      expect(sel.team.country).toBe("AU")
      expect(sel.player.playerId).toBe("p-1")
      expect(sel.player.displayName).toBe("Steve Smith")
      expect(sel.player.position).toBe("Batter")
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("put with invalid ref ID returns RefNotFound", () =>
    Effect.gen(function* () {
      // Player exists but team does not
      yield* PlayerEntity.put({
        playerId: "p-1",
        displayName: "Steve Smith",
        position: "Batter",
      })

      const error = yield* SelectionEntity.put({
        selectionId: "sel-1",
        teamId: "nonexistent",
        playerId: "p-1",
        role: "Captain",
      })
        .asEffect()
        .pipe(Effect.flip)

      expect(error._tag).toBe("RefNotFound")
      if (error._tag === "RefNotFound") {
        expect(error.entity).toBe("Selection")
        expect(error.field).toBe("team")
        expect(error.refEntity).toBe("Team")
        expect(error.refId).toBe("nonexistent")
      }
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("update with changed ref ID re-hydrates", () =>
    Effect.gen(function* () {
      // Create teams and player
      yield* TeamEntity.put({ teamId: "t-1", name: "Australia", country: "AU" })
      yield* TeamEntity.put({ teamId: "t-2", name: "India", country: "IN" })
      yield* PlayerEntity.put({
        playerId: "p-1",
        displayName: "Steve Smith",
        position: "Batter",
      })

      // Create selection
      yield* SelectionEntity.put({
        selectionId: "sel-1",
        teamId: "t-1",
        playerId: "p-1",
        role: "Captain",
      })

      // Update team ref
      yield* SelectionEntity.update({ selectionId: "sel-1" }).pipe(Entity.set({ teamId: "t-2" }))

      // Get should show updated team
      const sel = yield* SelectionEntity.get({ selectionId: "sel-1" })
      expect(sel.team.teamId).toBe("t-2")
      expect(sel.team.name).toBe("India")
      expect(sel.team.country).toBe("IN")
      // Player should be unchanged
      expect(sel.player.playerId).toBe("p-1")
    }).pipe(Effect.provide(TestLayer)),
  )
})

// ---------------------------------------------------------------------------
// Cascade Updates
// ---------------------------------------------------------------------------

describe("Integration: Cascade Updates", () => {
  class CascadeTeam extends Schema.Class<CascadeTeam>("CascadeTeam")({
    teamId: Schema.String.pipe(DynamoModel.identifier),
    name: Schema.String,
    country: Schema.String,
  }) {}

  class CascadePlayer extends Schema.Class<CascadePlayer>("CascadePlayer")({
    playerId: Schema.String.pipe(DynamoModel.identifier),
    displayName: Schema.String,
    position: Schema.String,
  }) {}

  class CascadeSelection extends Schema.Class<CascadeSelection>("CascadeSelection")({
    selectionId: Schema.String,
    player: CascadePlayer.pipe(DynamoModel.ref),
    team: CascadeTeam.pipe(DynamoModel.ref),
    role: Schema.String,
    season: Schema.String,
  }) {}

  const CascadeTeamEntity = Entity.make({
    model: CascadeTeam,
    table: MainTable,
    entityType: "CascadeTeam",
    indexes: {
      primary: {
        pk: { field: "pk", composite: ["teamId"] },
        sk: { field: "sk", composite: [] },
      },
    },
  })

  const CascadePlayerEntity = Entity.make({
    model: CascadePlayer,
    table: MainTable,
    entityType: "CascadePlayer",
    indexes: {
      primary: {
        pk: { field: "pk", composite: ["playerId"] },
        sk: { field: "sk", composite: [] },
      },
    },
  })

  const CascadeSelectionEntity = Entity.make({
    model: CascadeSelection,
    table: MainTable,
    entityType: "CascadeSelection",
    indexes: {
      primary: {
        pk: { field: "pk", composite: ["selectionId"] },
        sk: { field: "sk", composite: [] },
      },
    },
    refs: {
      player: {
        entity: CascadePlayerEntity,
        cascade: { index: "gsi2", pk: { field: "gsi2pk" }, sk: { field: "gsi2sk" } },
      },
      team: {
        entity: CascadeTeamEntity,
        cascade: { index: "gsi3", pk: { field: "gsi3pk" }, sk: { field: "gsi3sk" } },
      },
    },
  })

  it.effect("basic cascade propagation — update source, verify target embedded data updated", () =>
    Effect.gen(function* () {
      // Create source entities
      yield* CascadeTeamEntity.put({ teamId: "t-1", name: "Australia", country: "AU" })
      yield* CascadePlayerEntity.put({
        playerId: "p-1",
        displayName: "Steve Smith",
        position: "Batter",
      })

      // Create selection with refs
      yield* CascadeSelectionEntity.put({
        selectionId: "sel-1",
        playerId: "p-1",
        teamId: "t-1",
        role: "Captain",
        season: "2024-25",
      })

      // Verify initial state
      const before = yield* CascadeSelectionEntity.get({ selectionId: "sel-1" })
      expect(before.player.displayName).toBe("Steve Smith")

      // Update the player with cascade
      yield* CascadePlayerEntity.update({ playerId: "p-1" }).pipe(
        Entity.set({ displayName: "Steven Smith" }),
        Entity.cascade({ targets: [CascadeSelectionEntity] }),
      )

      // Verify cascade propagated the updated name
      const after = yield* CascadeSelectionEntity.get({ selectionId: "sel-1" })
      expect(after.player.displayName).toBe("Steven Smith")
      expect(after.player.position).toBe("Batter")
      expect(after.player.playerId).toBe("p-1")
      // Other fields unchanged
      expect(after.role).toBe("Captain")
      expect(after.team.name).toBe("Australia")
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("cascade with filter limits scope", () =>
    Effect.gen(function* () {
      // Create entities
      yield* CascadeTeamEntity.put({ teamId: "t-1", name: "Australia", country: "AU" })
      yield* CascadePlayerEntity.put({
        playerId: "p-1",
        displayName: "Steve Smith",
        position: "Batter",
      })

      // Create two selections in different seasons
      yield* CascadeSelectionEntity.put({
        selectionId: "sel-1",
        playerId: "p-1",
        teamId: "t-1",
        role: "Captain",
        season: "2024-25",
      })
      yield* CascadeSelectionEntity.put({
        selectionId: "sel-2",
        playerId: "p-1",
        teamId: "t-1",
        role: "Batter",
        season: "2023-24",
      })

      // Update with filter — only 2024-25 season
      yield* CascadePlayerEntity.update({ playerId: "p-1" }).pipe(
        Entity.set({ displayName: "Steven Smith" }),
        Entity.cascade({
          targets: [CascadeSelectionEntity],
          filter: { season: "2024-25" },
        }),
      )

      // Filtered selection should be updated
      const sel1 = yield* CascadeSelectionEntity.get({ selectionId: "sel-1" })
      expect(sel1.player.displayName).toBe("Steven Smith")

      // Non-filtered selection should NOT be updated
      const sel2 = yield* CascadeSelectionEntity.get({ selectionId: "sel-2" })
      expect(sel2.player.displayName).toBe("Steve Smith")
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("cascade to multiple target entity types", () =>
    Effect.gen(function* () {
      // Create a second target entity type
      class CascadeMatchPlayer extends Schema.Class<CascadeMatchPlayer>("CascadeMatchPlayer")({
        matchPlayerId: Schema.String,
        player: CascadePlayer.pipe(DynamoModel.ref),
        score: Schema.Number,
      }) {}

      const CascadeMatchPlayerEntity = Entity.make({
        model: CascadeMatchPlayer,
        table: MainTable,
        entityType: "CascadeMatchPlayer",
        indexes: {
          primary: {
            pk: { field: "pk", composite: ["matchPlayerId"] },
            sk: { field: "sk", composite: [] },
          },
        },
        refs: {
          player: {
            entity: CascadePlayerEntity,
            cascade: { index: "gsi4", pk: { field: "gsi4pk" }, sk: { field: "gsi4sk" } },
          },
        },
      })

      // Create entities
      yield* CascadeTeamEntity.put({ teamId: "t-1", name: "Australia", country: "AU" })
      yield* CascadePlayerEntity.put({
        playerId: "p-1",
        displayName: "Steve Smith",
        position: "Batter",
      })

      yield* CascadeSelectionEntity.put({
        selectionId: "sel-1",
        playerId: "p-1",
        teamId: "t-1",
        role: "Captain",
        season: "2024-25",
      })
      yield* CascadeMatchPlayerEntity.put({
        matchPlayerId: "mp-1",
        playerId: "p-1",
        score: 42,
      })

      // Cascade to both target types
      yield* CascadePlayerEntity.update({ playerId: "p-1" }).pipe(
        Entity.set({ displayName: "Steven Smith" }),
        Entity.cascade({
          targets: [CascadeSelectionEntity, CascadeMatchPlayerEntity],
        }),
      )

      // Both targets should be updated
      const sel = yield* CascadeSelectionEntity.get({ selectionId: "sel-1" })
      expect(sel.player.displayName).toBe("Steven Smith")

      const mp = yield* CascadeMatchPlayerEntity.get({ matchPlayerId: "mp-1" })
      expect(mp.player.displayName).toBe("Steven Smith")
    }).pipe(Effect.provide(TestLayer)),
  )
})

// ---------------------------------------------------------------------------
// Unique constraint rotation on update
// ---------------------------------------------------------------------------

describe("Integration: Unique Constraint Update Rotation", () => {
  class Account extends Schema.Class<Account>("Account")({
    accountId: Schema.String,
    email: Schema.String,
    username: Schema.String,
    displayName: Schema.String,
  }) {}

  const AccountEntity = Entity.make({
    model: Account,
    table: MainTable,
    entityType: "Account",
    indexes: {
      primary: {
        pk: { field: "pk", composite: ["accountId"] },
        sk: { field: "sk", composite: [] },
      },
    },
    unique: { email: ["email"], username: ["username"] },
    versioned: true,
  })

  it.effect("rotates sentinel when unique field changes", () =>
    Effect.gen(function* () {
      // Create account (puts entity + 2 sentinels)
      yield* AccountEntity.put({
        accountId: "acc-1",
        email: "alice@old.com",
        username: "alice",
        displayName: "Alice",
      })

      // Verify 3 items in store: entity + email sentinel + username sentinel
      expect(store.size).toBe(3)

      // Update email — should delete old email sentinel, create new one
      yield* AccountEntity.update({ accountId: "acc-1" }).pipe(
        Entity.set({ email: "alice@new.com" }),
      )

      // Still 3 items: entity + NEW email sentinel + username sentinel
      expect(store.size).toBe(3)

      // Verify entity has new email
      const updated = yield* AccountEntity.get({ accountId: "acc-1" })
      expect(updated.email).toBe("alice@new.com")

      // Verify old email sentinel is gone and new one exists
      let hasOldSentinel = false
      let hasNewSentinel = false
      for (const [key] of store) {
        if (key.includes("alice@old.com")) hasOldSentinel = true
        if (key.includes("alice@new.com")) hasNewSentinel = true
      }
      expect(hasOldSentinel).toBe(false)
      expect(hasNewSentinel).toBe(true)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("allows creating a new entity with the old unique value after rotation", () =>
    Effect.gen(function* () {
      // Create first account
      yield* AccountEntity.put({
        accountId: "acc-1",
        email: "shared@test.com",
        username: "user1",
        displayName: "User 1",
      })

      // Update email — frees the old value
      yield* AccountEntity.update({ accountId: "acc-1" }).pipe(
        Entity.set({ email: "new@test.com" }),
      )

      // A second account can now use the old email
      yield* AccountEntity.put({
        accountId: "acc-2",
        email: "shared@test.com",
        username: "user2",
        displayName: "User 2",
      })

      // Both accounts exist with correct emails
      const acc1 = yield* AccountEntity.get({ accountId: "acc-1" })
      expect(acc1.email).toBe("new@test.com")
      const acc2 = yield* AccountEntity.get({ accountId: "acc-2" })
      expect(acc2.email).toBe("shared@test.com")
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("rejects update when new unique value conflicts with existing entity", () =>
    Effect.gen(function* () {
      // Create two accounts
      yield* AccountEntity.put({
        accountId: "acc-1",
        email: "alice@test.com",
        username: "alice",
        displayName: "Alice",
      })
      yield* AccountEntity.put({
        accountId: "acc-2",
        email: "bob@test.com",
        username: "bob",
        displayName: "Bob",
      })

      // Try to update acc-1's email to bob's email — should fail
      const error = yield* AccountEntity.update({ accountId: "acc-1" })
        .pipe(Entity.set({ email: "bob@test.com" }))
        .asEffect()
        .pipe(Effect.flip)

      expect(error._tag).toBe("UniqueConstraintViolation")
      if (error._tag === "UniqueConstraintViolation") {
        expect(error.constraint).toBe("email")
      }

      // acc-1 should still have old email (transaction rolled back)
      const acc1 = yield* AccountEntity.get({ accountId: "acc-1" })
      expect(acc1.email).toBe("alice@test.com")
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("skips rotation when updating non-unique fields", () =>
    Effect.gen(function* () {
      yield* AccountEntity.put({
        accountId: "acc-1",
        email: "alice@test.com",
        username: "alice",
        displayName: "Alice",
      })

      const callsBefore = mockTransactWriteItems.mock.calls.length

      // Update displayName (not a unique field) — uses standard updateItem path
      yield* AccountEntity.update({ accountId: "acc-1" }).pipe(
        Entity.set({ displayName: "Alice Updated" }),
      )

      // transactWriteItems should NOT have been called again (only put used it)
      expect(mockTransactWriteItems.mock.calls.length).toBe(callsBefore)
      expect(mockUpdateItem).toHaveBeenCalled()
    }).pipe(Effect.provide(TestLayer)),
  )
})
