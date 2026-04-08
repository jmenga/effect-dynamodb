import { it } from "@effect/vitest"
import { Effect, Layer, Schema } from "effect"
import { beforeEach, describe, expect, vi } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import * as DynamoSchema from "../src/DynamoSchema.js"
import * as Entity from "../src/Entity.js"
import { DynamoError, type TransactionCancelled, type ValidationError } from "../src/Errors.js"
import * as Expression from "../src/Expression.js"
import { fromAttributeMap, toAttributeMap } from "../src/Marshaller.js"
import * as Table from "../src/Table.js"
import * as Transaction from "../src/Transaction.js"

// --- Test Models ---

const AppSchema = DynamoSchema.make({ name: "myapp", version: 1 })

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

const UserEntity = Entity.make({
  model: User,
  entityType: "User",
  primaryKey: {
    pk: { field: "pk", composite: ["userId"] },
    sk: { field: "sk", composite: [] },
  },
  indexes: {
    byRole: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["role"] },
      sk: { field: "gsi1sk", composite: ["userId"] },
    },
  },
})

const OrderEntity = Entity.make({
  model: Order,
  entityType: "Order",
  primaryKey: {
    pk: { field: "pk", composite: ["orderId"] },
    sk: { field: "sk", composite: [] },
  },
  indexes: {
    byUser: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["userId"] },
      sk: { field: "gsi1sk", composite: ["orderId"] },
    },
  },
})

const MainTable = Table.make({
  schema: AppSchema,
  entities: { UserEntity, OrderEntity },
})

// --- Mock DynamoClient ---

const mockTransactGetItems = vi.fn()
const mockTransactWriteItems = vi.fn()

const TestDynamoClient = Layer.succeed(DynamoClient, {
  putItem: () => Effect.die("not used"),
  getItem: () => Effect.die("not used"),
  deleteItem: () => Effect.die("not used"),
  updateItem: () => Effect.die("not used"),
  query: () => Effect.die("not used"),
  batchGetItem: () => Effect.die("not used"),
  batchWriteItem: () => Effect.die("not used"),
  transactGetItems: (input) =>
    Effect.tryPromise({
      try: () => mockTransactGetItems(input),
      catch: (e) => new DynamoError({ operation: "TransactGetItems", cause: e }),
    }),
  transactWriteItems: (input) =>
    Effect.tryPromise({
      try: () => mockTransactWriteItems(input),
      catch: (e) => new DynamoError({ operation: "TransactWriteItems", cause: e }),
    }),
  createTable: () => Effect.die("not used"),
  deleteTable: () => Effect.die("not used"),
  describeTable: () => Effect.die("not used"),
  scan: () => Effect.die("not used"),
})

const TestTableConfig = MainTable.layer({ name: "test-table" })
const TestLayer = Layer.merge(TestDynamoClient, TestTableConfig)

beforeEach(() => {
  vi.resetAllMocks()
})

describe("Transaction", () => {
  describe("transactGet", () => {
    it.effect("atomically gets multiple items across entities", () =>
      Effect.gen(function* () {
        const userItem = toAttributeMap({
          userId: "u-1",
          email: "alice@example.com",
          name: "Alice",
          role: "admin",
          pk: "$myapp#v1#user#userid_u-1",
          sk: "$myapp#v1#user",
          __edd_e__: "User",
        })
        const orderItem = toAttributeMap({
          orderId: "ord-1",
          userId: "u-1",
          product: "Widget",
          quantity: 3,
          status: "pending",
          pk: "$myapp#v1#order#orderid_ord-1",
          sk: "$myapp#v1#order",
          __edd_e__: "Order",
        })

        mockTransactGetItems.mockResolvedValueOnce({
          Responses: [{ Item: userItem }, { Item: orderItem }],
        })

        const [user, order] = yield* Transaction.transactGet([
          UserEntity.get({ userId: "u-1" }),
          OrderEntity.get({ orderId: "ord-1" }),
        ])

        expect(user?.userId).toBe("u-1")
        expect(user?.email).toBe("alice@example.com")
        expect(order?.orderId).toBe("ord-1")
        expect(order?.product).toBe("Widget")

        // Verify the composed keys were sent correctly
        expect(mockTransactGetItems).toHaveBeenCalledOnce()
        const call = mockTransactGetItems.mock.calls[0]![0]
        expect(call.TransactItems).toHaveLength(2)

        const userKey = fromAttributeMap(call.TransactItems[0].Get.Key)
        expect(userKey.pk).toBe("$myapp#v1#user#userid_u-1")
        expect(userKey.sk).toBe("$myapp#v1#user")

        const orderKey = fromAttributeMap(call.TransactItems[1].Get.Key)
        expect(orderKey.pk).toBe("$myapp#v1#order#orderid_ord-1")
        expect(orderKey.sk).toBe("$myapp#v1#order")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("returns empty array for empty input", () =>
      Effect.gen(function* () {
        const results = yield* Transaction.transactGet([])
        expect(results).toHaveLength(0)
        expect(mockTransactGetItems).not.toHaveBeenCalled()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("returns undefined for non-existent items", () =>
      Effect.gen(function* () {
        mockTransactGetItems.mockResolvedValueOnce({
          Responses: [{ Item: undefined }],
        })

        const [user] = yield* Transaction.transactGet([UserEntity.get({ userId: "nonexistent" })])

        expect(user).toBeUndefined()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("fails with DynamoError when exceeding 100-item limit", () =>
      Effect.gen(function* () {
        const items = Array.from({ length: 101 }, (_, i) => UserEntity.get({ userId: `u-${i}` }))

        const error = yield* Transaction.transactGet(items).pipe(Effect.flip)
        expect(error._tag).toBe("DynamoError")
        expect((error as DynamoError).operation).toBe("TransactGetItems")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("maps TransactionCanceledException to TransactionCancelled", () =>
      Effect.gen(function* () {
        const txError = new Error("Transaction cancelled")
        ;(txError as any).name = "TransactionCanceledException"
        ;(txError as any).CancellationReasons = [
          { Code: "ConditionalCheckFailed", Message: "Condition not met" },
        ]

        mockTransactGetItems.mockRejectedValueOnce(txError)

        const error = yield* Transaction.transactGet([UserEntity.get({ userId: "u-1" })]).pipe(
          Effect.flip,
        )

        expect(error._tag).toBe("TransactionCancelled")
        const txCancelled = error as TransactionCancelled
        expect(txCancelled.operation).toBe("TransactGetItems")
        expect(txCancelled.reasons).toHaveLength(1)
        expect(txCancelled.reasons[0]?.code).toBe("ConditionalCheckFailed")
        expect(txCancelled.reasons[0]?.message).toBe("Condition not met")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("fails with ValidationError for malformed item data", () =>
      Effect.gen(function* () {
        const malformedItem = toAttributeMap({
          userId: "u-1",
          email: "alice@example.com",
          name: "Alice",
          role: "invalid-role", // not "admin" or "member"
          pk: "$myapp#v1#user#userid_u-1",
          sk: "$myapp#v1#user",
          __edd_e__: "User",
        })

        mockTransactGetItems.mockResolvedValueOnce({
          Responses: [{ Item: malformedItem }],
        })

        const error = yield* Transaction.transactGet([UserEntity.get({ userId: "u-1" })]).pipe(
          Effect.flip,
        )

        expect(error._tag).toBe("ValidationError")
        expect((error as ValidationError).entityType).toBe("User")
        expect((error as ValidationError).operation).toBe("decode")
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  describe("transactWrite", () => {
    it.effect("atomically writes puts across entities", () =>
      Effect.gen(function* () {
        mockTransactWriteItems.mockResolvedValueOnce({})

        yield* Transaction.transactWrite([
          UserEntity.put({
            userId: "u-1",
            email: "alice@example.com",
            name: "Alice",
            role: "admin",
          }),
          OrderEntity.put({
            orderId: "ord-1",
            userId: "u-1",
            product: "Widget",
            quantity: 3,
            status: "pending",
          }),
        ])

        expect(mockTransactWriteItems).toHaveBeenCalledOnce()
        const call = mockTransactWriteItems.mock.calls[0]![0]
        expect(call.TransactItems).toHaveLength(2)
        expect(call.TransactItems[0].Put).toBeDefined()
        expect(call.TransactItems[1].Put).toBeDefined()

        // Verify composed keys and entity type discriminator
        const userItem = fromAttributeMap(call.TransactItems[0].Put.Item)
        expect(userItem.pk).toBe("$myapp#v1#user#userid_u-1")
        expect(userItem.sk).toBe("$myapp#v1#user")
        expect(userItem.__edd_e__).toBe("User")
        expect(userItem.gsi1pk).toBe("$myapp#v1#user#role_admin")
        expect(userItem.gsi1sk).toBe("$myapp#v1#user#userid_u-1")

        const orderItem = fromAttributeMap(call.TransactItems[1].Put.Item)
        expect(orderItem.pk).toBe("$myapp#v1#order#orderid_ord-1")
        expect(orderItem.sk).toBe("$myapp#v1#order")
        expect(orderItem.__edd_e__).toBe("Order")
        expect(orderItem.gsi1pk).toBe("$myapp#v1#order#userid_u-1")
        expect(orderItem.gsi1sk).toBe("$myapp#v1#order#orderid_ord-1")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("supports delete operations", () =>
      Effect.gen(function* () {
        mockTransactWriteItems.mockResolvedValueOnce({})

        yield* Transaction.transactWrite([UserEntity.delete({ userId: "u-1" })])

        expect(mockTransactWriteItems).toHaveBeenCalledOnce()
        const call = mockTransactWriteItems.mock.calls[0]![0]
        expect(call.TransactItems).toHaveLength(1)
        expect(call.TransactItems[0].Delete).toBeDefined()

        const deleteKey = fromAttributeMap(call.TransactItems[0].Delete.Key)
        expect(deleteKey.pk).toBe("$myapp#v1#user#userid_u-1")
        expect(deleteKey.sk).toBe("$myapp#v1#user")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("supports conditionCheck via Transaction.check", () =>
      Effect.gen(function* () {
        mockTransactWriteItems.mockResolvedValueOnce({})

        const cond = Expression.condition({
          attributeExists: "email",
        })

        yield* Transaction.transactWrite([
          UserEntity.get({ userId: "u-1" }).pipe(Transaction.check(cond)),
        ])

        expect(mockTransactWriteItems).toHaveBeenCalledOnce()
        const call = mockTransactWriteItems.mock.calls[0]![0]
        expect(call.TransactItems).toHaveLength(1)
        expect(call.TransactItems[0].ConditionCheck).toBeDefined()
        expect(call.TransactItems[0].ConditionCheck.ConditionExpression).toBe(
          "attribute_exists(#email)",
        )
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("supports mixed put, delete, and conditionCheck operations", () =>
      Effect.gen(function* () {
        mockTransactWriteItems.mockResolvedValueOnce({})

        const cond = Expression.condition({
          attributeExists: "email",
        })

        yield* Transaction.transactWrite([
          OrderEntity.put({
            orderId: "ord-1",
            userId: "u-1",
            product: "Widget",
            quantity: 3,
            status: "pending",
          }),
          OrderEntity.delete({ orderId: "ord-old" }),
          UserEntity.get({ userId: "u-1" }).pipe(Transaction.check(cond)),
        ])

        const call = mockTransactWriteItems.mock.calls[0]![0]
        expect(call.TransactItems).toHaveLength(3)
        expect(call.TransactItems[0].Put).toBeDefined()
        expect(call.TransactItems[1].Delete).toBeDefined()
        expect(call.TransactItems[2].ConditionCheck).toBeDefined()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("Transaction.check works data-first", () =>
      Effect.gen(function* () {
        mockTransactWriteItems.mockResolvedValueOnce({})

        const cond = Expression.condition({
          attributeNotExists: "pk",
        })

        yield* Transaction.transactWrite([
          Transaction.check(UserEntity.get({ userId: "u-1" }), cond),
        ])

        const call = mockTransactWriteItems.mock.calls[0]![0]
        const condCheck = call.TransactItems[0].ConditionCheck
        expect(condCheck.ConditionExpression).toBe("attribute_not_exists(#pk)")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("does nothing for empty operations", () =>
      Effect.gen(function* () {
        yield* Transaction.transactWrite([])
        expect(mockTransactWriteItems).not.toHaveBeenCalled()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("fails with DynamoError when exceeding 100-item limit", () =>
      Effect.gen(function* () {
        const operations = Array.from({ length: 101 }, (_, i) =>
          UserEntity.delete({ userId: `u-${i}` }),
        )

        const error = yield* Transaction.transactWrite(operations).pipe(Effect.flip)
        expect(error._tag).toBe("DynamoError")
        expect((error as DynamoError).operation).toBe("TransactWriteItems")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("maps TransactionCanceledException to TransactionCancelled", () =>
      Effect.gen(function* () {
        const txError = new Error("Transaction cancelled")
        ;(txError as any).name = "TransactionCanceledException"
        ;(txError as any).CancellationReasons = [
          { Code: "ConditionalCheckFailed", Message: "Condition not met" },
          { Code: "None" },
        ]

        mockTransactWriteItems.mockRejectedValueOnce(txError)

        const error = yield* Transaction.transactWrite([
          UserEntity.put({
            userId: "u-1",
            email: "alice@example.com",
            name: "Alice",
            role: "admin",
          }),
        ]).pipe(Effect.flip)

        expect(error._tag).toBe("TransactionCancelled")
        const txCancelled = error as TransactionCancelled
        expect(txCancelled.operation).toBe("TransactWriteItems")
        expect(txCancelled.reasons).toHaveLength(2)
        expect(txCancelled.reasons[0]?.code).toBe("ConditionalCheckFailed")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("fails with ValidationError for invalid put data", () =>
      Effect.gen(function* () {
        const error = yield* Transaction.transactWrite([
          UserEntity.put({
            userId: "u-1",
            email: "alice@example.com",
            name: "",
            role: "admin",
          } as any),
        ]).pipe(Effect.flip)

        expect(error._tag).toBe("ValidationError")
        expect((error as ValidationError).operation).toBe("transactWrite.put")
        expect((error as ValidationError).entityType).toBe("User")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("propagates non-transaction DynamoError as-is", () =>
      Effect.gen(function* () {
        const genericError = new Error("Network timeout")
        mockTransactWriteItems.mockRejectedValueOnce(genericError)

        const error = yield* Transaction.transactWrite([UserEntity.delete({ userId: "u-1" })]).pipe(
          Effect.flip,
        )

        expect(error._tag).toBe("DynamoError")
        expect((error as DynamoError).operation).toBe("TransactWriteItems")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("cancellation with multiple detailed reasons per item", () =>
      Effect.gen(function* () {
        const txError = new Error("Transaction cancelled")
        ;(txError as any).name = "TransactionCanceledException"
        ;(txError as any).CancellationReasons = [
          { Code: "ConditionalCheckFailed", Message: "Item already exists" },
          { Code: "TransactionConflict", Message: "Conflicting operation in progress" },
          { Code: "None" },
          { Code: "ValidationError", Message: "Schema mismatch" },
        ]

        mockTransactWriteItems.mockRejectedValueOnce(txError)

        const error = yield* Transaction.transactWrite([
          UserEntity.put({
            userId: "u-1",
            email: "alice@example.com",
            name: "Alice",
            role: "admin",
          }),
        ]).pipe(Effect.flip)

        expect(error._tag).toBe("TransactionCancelled")
        const txCancelled = error as TransactionCancelled
        expect(txCancelled.reasons).toHaveLength(4)
        expect(txCancelled.reasons[0]?.code).toBe("ConditionalCheckFailed")
        expect(txCancelled.reasons[0]?.message).toBe("Item already exists")
        expect(txCancelled.reasons[1]?.code).toBe("TransactionConflict")
        expect(txCancelled.reasons[1]?.message).toBe("Conflicting operation in progress")
        expect(txCancelled.reasons[2]?.code).toBe("None")
        expect(txCancelled.reasons[3]?.code).toBe("ValidationError")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("cancellation with empty reasons array", () =>
      Effect.gen(function* () {
        const txError = new Error("Transaction cancelled")
        ;(txError as any).name = "TransactionCanceledException"
        ;(txError as any).CancellationReasons = []

        mockTransactWriteItems.mockRejectedValueOnce(txError)

        const error = yield* Transaction.transactWrite([UserEntity.delete({ userId: "u-1" })]).pipe(
          Effect.flip,
        )

        expect(error._tag).toBe("TransactionCancelled")
        const txCancelled = error as TransactionCancelled
        expect(txCancelled.reasons).toHaveLength(0)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("cancellation without CancellationReasons property", () =>
      Effect.gen(function* () {
        const txError = new Error("Transaction cancelled")
        ;(txError as any).name = "TransactionCanceledException"
        // No CancellationReasons property at all

        mockTransactWriteItems.mockRejectedValueOnce(txError)

        const error = yield* Transaction.transactWrite([UserEntity.delete({ userId: "u-1" })]).pipe(
          Effect.flip,
        )

        expect(error._tag).toBe("TransactionCancelled")
        const txCancelled = error as TransactionCancelled
        expect(txCancelled.reasons).toHaveLength(0)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("cancellation with mixed reason codes (ConditionalCheckFailed + None)", () =>
      Effect.gen(function* () {
        const txError = new Error("Transaction cancelled")
        ;(txError as any).name = "TransactionCanceledException"
        ;(txError as any).CancellationReasons = [
          { Code: "ConditionalCheckFailed", Message: "Condition not met" },
          { Code: "None" },
          { Code: "ConditionalCheckFailed", Message: "Already exists" },
        ]

        mockTransactWriteItems.mockRejectedValueOnce(txError)

        const error = yield* Transaction.transactWrite([
          UserEntity.delete({ userId: "u-1" }),
          UserEntity.delete({ userId: "u-2" }),
          UserEntity.delete({ userId: "u-3" }),
        ]).pipe(Effect.flip)

        expect(error._tag).toBe("TransactionCancelled")
        const txCancelled = error as TransactionCancelled
        expect(txCancelled.reasons).toHaveLength(3)
        expect(txCancelled.reasons[0]?.code).toBe("ConditionalCheckFailed")
        expect(txCancelled.reasons[1]?.code).toBe("None")
        expect(txCancelled.reasons[2]?.code).toBe("ConditionalCheckFailed")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("transactGet handles mixed found/not-found items", () =>
      Effect.gen(function* () {
        const userItem = toAttributeMap({
          userId: "u-1",
          email: "alice@example.com",
          name: "Alice",
          role: "admin",
          pk: "$myapp#v1#user#userid_u-1",
          sk: "$myapp#v1#user",
          __edd_e__: "User",
        })

        // Second item not found, third item found
        mockTransactGetItems.mockResolvedValueOnce({
          Responses: [
            { Item: userItem },
            { Item: undefined },
            {
              Item: toAttributeMap({
                orderId: "ord-1",
                userId: "u-1",
                product: "Widget",
                quantity: 3,
                status: "pending",
                pk: "$myapp#v1#order#orderid_ord-1",
                sk: "$myapp#v1#order",
                __edd_e__: "Order",
              }),
            },
          ],
        })

        const [user, missingUser, order] = yield* Transaction.transactGet([
          UserEntity.get({ userId: "u-1" }),
          UserEntity.get({ userId: "u-nonexistent" }),
          OrderEntity.get({ orderId: "ord-1" }),
        ])

        expect(user?.userId).toBe("u-1")
        expect(missingUser).toBeUndefined()
        expect(order?.orderId).toBe("ord-1")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("conditionCheck with multiple expression types", () =>
      Effect.gen(function* () {
        mockTransactWriteItems.mockResolvedValueOnce({})

        const cond = Expression.condition({
          eq: { role: "admin" },
          attributeExists: "email",
          gt: { version: 0 },
        })

        yield* Transaction.transactWrite([
          UserEntity.get({ userId: "u-1" }).pipe(Transaction.check(cond)),
        ])

        const call = mockTransactWriteItems.mock.calls[0]![0]
        const condCheck = call.TransactItems[0].ConditionCheck
        expect(condCheck.ConditionExpression).toContain("=")
        expect(condCheck.ConditionExpression).toContain("attribute_exists")
        expect(condCheck.ConditionExpression).toContain(">")
        expect(condCheck.ExpressionAttributeNames["#role"]).toBe("role")
        expect(condCheck.ExpressionAttributeNames["#email"]).toBe("email")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("transactWrite at exactly 100-item limit succeeds", () =>
      Effect.gen(function* () {
        mockTransactWriteItems.mockResolvedValueOnce({})

        const operations = Array.from({ length: 100 }, (_, i) =>
          UserEntity.delete({ userId: `u-${i}` }),
        )

        yield* Transaction.transactWrite(operations)

        const call = mockTransactWriteItems.mock.calls[0]![0]
        expect(call.TransactItems).toHaveLength(100)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("transactGet at exactly 100-item limit succeeds", () =>
      Effect.gen(function* () {
        const responses = Array.from({ length: 100 }, () => ({ Item: undefined }))
        mockTransactGetItems.mockResolvedValueOnce({ Responses: responses })

        const items = Array.from({ length: 100 }, (_, i) => UserEntity.get({ userId: `u-${i}` }))

        const results = yield* Transaction.transactGet(items)
        expect(results).toHaveLength(100)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("sparse GSI: put omits GSI keys when composites missing", () =>
      Effect.gen(function* () {
        class SparseItem extends Schema.Class<SparseItem>("SparseItem")({
          itemId: Schema.String,
          name: Schema.String,
          tenantId: Schema.optional(Schema.String),
        }) {}

        const SparseEntity = Entity.make({
          model: SparseItem,
          entityType: "SparseItem",
          primaryKey: {
            pk: { field: "pk", composite: ["itemId"] },
            sk: { field: "sk", composite: [] },
          },
          indexes: {
            byTenant: {
              name: "gsi1",
              pk: { field: "gsi1pk", composite: ["tenantId"] },
              sk: { field: "gsi1sk", composite: [] },
            },
          },
        })
        SparseEntity._configure(AppSchema, MainTable.Tag)

        mockTransactWriteItems.mockResolvedValueOnce({})

        yield* Transaction.transactWrite([SparseEntity.put({ itemId: "i-1", name: "NoTenant" })])

        const call = mockTransactWriteItems.mock.calls[0]![0]
        const item = fromAttributeMap(call.TransactItems[0].Put.Item)
        expect(item.pk).toBe("$myapp#v1#sparseitem#itemid_i-1")
        expect(item.__edd_e__).toBe("SparseItem")
        expect(item.gsi1pk).toBeUndefined()
        expect(item.gsi1sk).toBeUndefined()
      }).pipe(Effect.provide(TestLayer)),
    )
  })
})
