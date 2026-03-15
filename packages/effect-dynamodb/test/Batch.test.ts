import { it } from "@effect/vitest"
import { Effect, Fiber, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { beforeEach, describe, expect, vi } from "vitest"
import * as Batch from "../src/Batch.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as DynamoSchema from "../src/DynamoSchema.js"
import * as Entity from "../src/Entity.js"
import { DynamoError, type ValidationError } from "../src/Errors.js"
import { fromAttributeMap, toAttributeMap } from "../src/Marshaller.js"
import * as Table from "../src/Table.js"

// --- Test Models ---

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

const UserEntity = Entity.make({
  model: User,
  table: MainTable,
  entityType: "User",
  indexes: {
    primary: {
      pk: { field: "pk", composite: ["userId"] },
      sk: { field: "sk", composite: [] },
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

// --- Mock DynamoClient ---

const mockBatchGetItem = vi.fn()
const mockBatchWriteItem = vi.fn()

const TestDynamoClient = Layer.succeed(DynamoClient, {
  putItem: () => Effect.die("not used"),
  getItem: () => Effect.die("not used"),
  deleteItem: () => Effect.die("not used"),
  updateItem: () => Effect.die("not used"),
  query: () => Effect.die("not used"),
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
  transactGetItems: () => Effect.die("not used"),
  transactWriteItems: () => Effect.die("not used"),
  createTable: () => Effect.die("not used"),
  deleteTable: () => Effect.die("not used"),
  scan: () => Effect.die("not used"),
})

const TestTableConfig = MainTable.layer({ name: "test-table" })
const TestLayer = Layer.merge(TestDynamoClient, TestTableConfig)

beforeEach(() => {
  vi.resetAllMocks()
})

describe("Batch", () => {
  describe("get", () => {
    it.effect("batch gets multiple items across entities with typed tuple", () =>
      Effect.gen(function* () {
        const userItem = toAttributeMap({
          userId: "u-1",
          email: "alice@example.com",
          name: "Alice",
          role: "admin",
          pk: "$myapp#v1#user#u-1",
          sk: "$myapp#v1#user",
          __edd_e__: "User",
        })
        const orderItem = toAttributeMap({
          orderId: "ord-1",
          userId: "u-1",
          product: "Widget",
          quantity: 3,
          status: "pending",
          pk: "$myapp#v1#order#ord-1",
          sk: "$myapp#v1#order",
          __edd_e__: "Order",
        })

        mockBatchGetItem.mockResolvedValueOnce({
          Responses: {
            "test-table": [userItem, orderItem],
          },
        })

        const [user, order] = yield* Batch.get([
          UserEntity.get({ userId: "u-1" }),
          OrderEntity.get({ orderId: "ord-1" }),
        ])

        expect(user?.userId).toBe("u-1")
        expect(user?.email).toBe("alice@example.com")
        expect(order?.orderId).toBe("ord-1")
        expect(order?.product).toBe("Widget")

        // Verify the batch request
        expect(mockBatchGetItem).toHaveBeenCalledOnce()
        const call = mockBatchGetItem.mock.calls[0]![0]
        expect(call.RequestItems["test-table"].Keys).toHaveLength(2)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("returns empty array for empty input", () =>
      Effect.gen(function* () {
        const results = yield* Batch.get([])
        expect(results).toHaveLength(0)
        expect(mockBatchGetItem).not.toHaveBeenCalled()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("returns undefined for non-existent items", () =>
      Effect.gen(function* () {
        mockBatchGetItem.mockResolvedValueOnce({
          Responses: {
            "test-table": [], // no items returned
          },
        })

        const [user] = yield* Batch.get([UserEntity.get({ userId: "nonexistent" })])

        expect(user).toBeUndefined()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("handles out-of-order DynamoDB responses", () =>
      Effect.gen(function* () {
        // DynamoDB can return items in any order
        const user2Item = toAttributeMap({
          userId: "u-2",
          email: "bob@example.com",
          name: "Bob",
          role: "member",
          pk: "$myapp#v1#user#u-2",
          sk: "$myapp#v1#user",
          __edd_e__: "User",
        })
        const user1Item = toAttributeMap({
          userId: "u-1",
          email: "alice@example.com",
          name: "Alice",
          role: "admin",
          pk: "$myapp#v1#user#u-1",
          sk: "$myapp#v1#user",
          __edd_e__: "User",
        })

        // Respond with user-2 first, then user-1 (reverse of request order)
        mockBatchGetItem.mockResolvedValueOnce({
          Responses: {
            "test-table": [user2Item, user1Item],
          },
        })

        const [alice, bob] = yield* Batch.get([
          UserEntity.get({ userId: "u-1" }),
          UserEntity.get({ userId: "u-2" }),
        ])

        // Results should be in request order, not response order
        expect(alice?.userId).toBe("u-1")
        expect(alice?.name).toBe("Alice")
        expect(bob?.userId).toBe("u-2")
        expect(bob?.name).toBe("Bob")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("retries unprocessed keys", () =>
      Effect.gen(function* () {
        const userKey = toAttributeMap({
          pk: "$myapp#v1#user#u-1",
          sk: "$myapp#v1#user",
        })
        const userItem = toAttributeMap({
          userId: "u-1",
          email: "alice@example.com",
          name: "Alice",
          role: "admin",
          pk: "$myapp#v1#user#u-1",
          sk: "$myapp#v1#user",
          __edd_e__: "User",
        })

        // First call: returns unprocessed keys
        mockBatchGetItem.mockResolvedValueOnce({
          Responses: {
            "test-table": [],
          },
          UnprocessedKeys: {
            "test-table": {
              Keys: [userKey],
            },
          },
        })

        // Second call (retry): returns the item
        mockBatchGetItem.mockResolvedValueOnce({
          Responses: {
            "test-table": [userItem],
          },
        })

        // Fork the batch operation and advance TestClock to unblock sleep
        const fiber = yield* Batch.get([UserEntity.get({ userId: "u-1" })]).pipe(
          Effect.provide(TestLayer),
          Effect.forkChild,
        )

        yield* TestClock.adjust("1 seconds")

        const [user] = yield* Fiber.join(fiber)
        expect(user?.userId).toBe("u-1")
        expect(mockBatchGetItem).toHaveBeenCalledTimes(2)
      }),
    )

    it.effect("auto-chunks at 100 items", () =>
      Effect.gen(function* () {
        // Create 150 items to force 2 chunks (100 + 50)
        const items = Array.from({ length: 150 }, (_, i) => UserEntity.get({ userId: `u-${i}` }))

        // First chunk: 100 items
        mockBatchGetItem.mockResolvedValueOnce({
          Responses: { "test-table": [] },
        })

        // Second chunk: 50 items
        mockBatchGetItem.mockResolvedValueOnce({
          Responses: { "test-table": [] },
        })

        const results = yield* Batch.get(items)
        expect(results).toHaveLength(150)
        expect(mockBatchGetItem).toHaveBeenCalledTimes(2)

        // Verify chunk sizes
        const firstCall = mockBatchGetItem.mock.calls[0]![0]
        expect(firstCall.RequestItems["test-table"].Keys).toHaveLength(100)

        const secondCall = mockBatchGetItem.mock.calls[1]![0]
        expect(secondCall.RequestItems["test-table"].Keys).toHaveLength(50)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("fails with ValidationError for malformed response data", () =>
      Effect.gen(function* () {
        const malformedItem = toAttributeMap({
          userId: "u-1",
          email: "alice@example.com",
          name: "Alice",
          role: "invalid-role", // not "admin" or "member"
          pk: "$myapp#v1#user#u-1",
          sk: "$myapp#v1#user",
          __edd_e__: "User",
        })

        mockBatchGetItem.mockResolvedValueOnce({
          Responses: { "test-table": [malformedItem] },
        })

        const error = yield* Batch.get([UserEntity.get({ userId: "u-1" })]).pipe(Effect.flip)

        expect(error._tag).toBe("ValidationError")
        expect((error as ValidationError).entityType).toBe("User")
        expect((error as ValidationError).operation).toBe("batchGet")
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  describe("write", () => {
    it.effect("batch writes puts across entities", () =>
      Effect.gen(function* () {
        mockBatchWriteItem.mockResolvedValueOnce({})

        yield* Batch.write([
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

        expect(mockBatchWriteItem).toHaveBeenCalledOnce()
        const call = mockBatchWriteItem.mock.calls[0]![0]
        expect(call.RequestItems["test-table"]).toHaveLength(2)

        // Verify items have correct keys and discriminator
        const userItem = fromAttributeMap(call.RequestItems["test-table"][0].PutRequest.Item)
        expect(userItem.pk).toBe("$myapp#v1#user#u-1")
        expect(userItem.__edd_e__).toBe("User")

        const orderItem = fromAttributeMap(call.RequestItems["test-table"][1].PutRequest.Item)
        expect(orderItem.pk).toBe("$myapp#v1#order#ord-1")
        expect(orderItem.__edd_e__).toBe("Order")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("batch writes deletes", () =>
      Effect.gen(function* () {
        mockBatchWriteItem.mockResolvedValueOnce({})

        yield* Batch.write([
          UserEntity.delete({ userId: "u-1" }),
          OrderEntity.delete({ orderId: "ord-1" }),
        ])

        expect(mockBatchWriteItem).toHaveBeenCalledOnce()
        const call = mockBatchWriteItem.mock.calls[0]![0]
        expect(call.RequestItems["test-table"]).toHaveLength(2)
        expect(call.RequestItems["test-table"][0].DeleteRequest).toBeDefined()
        expect(call.RequestItems["test-table"][1].DeleteRequest).toBeDefined()

        const deleteKey = fromAttributeMap(call.RequestItems["test-table"][0].DeleteRequest.Key)
        expect(deleteKey.pk).toBe("$myapp#v1#user#u-1")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("supports mixed puts and deletes", () =>
      Effect.gen(function* () {
        mockBatchWriteItem.mockResolvedValueOnce({})

        yield* Batch.write([
          UserEntity.put({
            userId: "u-new",
            email: "new@example.com",
            name: "New",
            role: "member",
          }),
          OrderEntity.delete({ orderId: "ord-old" }),
        ])

        const call = mockBatchWriteItem.mock.calls[0]![0]
        expect(call.RequestItems["test-table"]).toHaveLength(2)
        expect(call.RequestItems["test-table"][0].PutRequest).toBeDefined()
        expect(call.RequestItems["test-table"][1].DeleteRequest).toBeDefined()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("does nothing for empty operations", () =>
      Effect.gen(function* () {
        yield* Batch.write([])
        expect(mockBatchWriteItem).not.toHaveBeenCalled()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("retries unprocessed items", () =>
      Effect.gen(function* () {
        const putItem = toAttributeMap({
          userId: "u-1",
          email: "alice@example.com",
          name: "Alice",
          role: "admin",
          pk: "$myapp#v1#user#u-1",
          sk: "$myapp#v1#user",
          __edd_e__: "User",
        })

        // First call: returns unprocessed items
        mockBatchWriteItem.mockResolvedValueOnce({
          UnprocessedItems: {
            "test-table": [{ PutRequest: { Item: putItem } }],
          },
        })

        // Second call (retry): success
        mockBatchWriteItem.mockResolvedValueOnce({})

        // Fork and advance TestClock to unblock sleep
        const fiber = yield* Batch.write([
          UserEntity.put({
            userId: "u-1",
            email: "alice@example.com",
            name: "Alice",
            role: "admin",
          }),
        ]).pipe(Effect.provide(TestLayer), Effect.forkChild)

        yield* TestClock.adjust("1 seconds")

        yield* Fiber.join(fiber)
        expect(mockBatchWriteItem).toHaveBeenCalledTimes(2)
      }),
    )

    it.effect("auto-chunks at 25 items", () =>
      Effect.gen(function* () {
        // Create 30 items to force 2 chunks (25 + 5)
        const items = Array.from({ length: 30 }, (_, i) => UserEntity.delete({ userId: `u-${i}` }))

        // First chunk: 25 items
        mockBatchWriteItem.mockResolvedValueOnce({})
        // Second chunk: 5 items
        mockBatchWriteItem.mockResolvedValueOnce({})

        yield* Batch.write(items)
        expect(mockBatchWriteItem).toHaveBeenCalledTimes(2)

        const firstCall = mockBatchWriteItem.mock.calls[0]![0]
        expect(firstCall.RequestItems["test-table"]).toHaveLength(25)

        const secondCall = mockBatchWriteItem.mock.calls[1]![0]
        expect(secondCall.RequestItems["test-table"]).toHaveLength(5)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("fails with ValidationError for invalid put data", () =>
      Effect.gen(function* () {
        const error = yield* Batch.write([
          UserEntity.put({
            userId: "u-1",
            email: "alice@example.com",
            name: "",
            role: "admin",
          } as any),
        ]).pipe(Effect.flip)

        expect(error._tag).toBe("ValidationError")
        expect((error as ValidationError).entityType).toBe("User")
        expect((error as ValidationError).operation).toBe("batchWrite.put")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("propagates DynamoError from SDK", () =>
      Effect.gen(function* () {
        mockBatchWriteItem.mockRejectedValue(new Error("Network failure"))

        const error = yield* Batch.write([UserEntity.delete({ userId: "u-1" })]).pipe(Effect.flip)

        expect(error._tag).toBe("DynamoError")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("fails with DynamoError when unprocessed items persist after max retries", () =>
      Effect.gen(function* () {
        const putItem = toAttributeMap({
          userId: "u-1",
          email: "alice@example.com",
          name: "Alice",
          role: "admin",
          pk: "$myapp#v1#user#u-1",
          sk: "$myapp#v1#user",
          __edd_e__: "User",
        })

        // Always return unprocessed items (6+ calls: exceeds MAX_RETRIES=5)
        for (let i = 0; i < 7; i++) {
          mockBatchWriteItem.mockResolvedValueOnce({
            UnprocessedItems: {
              "test-table": [{ PutRequest: { Item: putItem } }],
            },
          })
        }

        const fiber = yield* Batch.write([
          UserEntity.put({
            userId: "u-1",
            email: "alice@example.com",
            name: "Alice",
            role: "admin",
          }),
        ]).pipe(Effect.provide(TestLayer), Effect.forkChild)

        // Advance clock past all backoff delays
        yield* TestClock.adjust("60 seconds")

        const error = yield* Fiber.join(fiber).pipe(Effect.flip)
        expect(error._tag).toBe("DynamoError")
        expect((error as DynamoError).operation).toBe("BatchWriteItem")
      }),
    )

    it.effect("exact boundary: 25 items in single write chunk", () =>
      Effect.gen(function* () {
        mockBatchWriteItem.mockResolvedValueOnce({})

        const items = Array.from({ length: 25 }, (_, i) => UserEntity.delete({ userId: `u-${i}` }))
        yield* Batch.write(items)
        expect(mockBatchWriteItem).toHaveBeenCalledTimes(1)
        const call = mockBatchWriteItem.mock.calls[0]![0]
        expect(call.RequestItems["test-table"]).toHaveLength(25)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("exact boundary: 26 items splits into two write chunks", () =>
      Effect.gen(function* () {
        mockBatchWriteItem.mockResolvedValueOnce({})
        mockBatchWriteItem.mockResolvedValueOnce({})

        const items = Array.from({ length: 26 }, (_, i) => UserEntity.delete({ userId: `u-${i}` }))
        yield* Batch.write(items)
        expect(mockBatchWriteItem).toHaveBeenCalledTimes(2)
        const first = mockBatchWriteItem.mock.calls[0]![0]
        const second = mockBatchWriteItem.mock.calls[1]![0]
        expect(first.RequestItems["test-table"]).toHaveLength(25)
        expect(second.RequestItems["test-table"]).toHaveLength(1)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("exact boundary: 100 items in single get chunk", () =>
      Effect.gen(function* () {
        mockBatchGetItem.mockResolvedValueOnce({ Responses: { "test-table": [] } })

        const items = Array.from({ length: 100 }, (_, i) => UserEntity.get({ userId: `u-${i}` }))
        yield* Batch.get(items)
        expect(mockBatchGetItem).toHaveBeenCalledTimes(1)
        const call = mockBatchGetItem.mock.calls[0]![0]
        expect(call.RequestItems["test-table"].Keys).toHaveLength(100)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("exact boundary: 101 items splits into two get chunks", () =>
      Effect.gen(function* () {
        mockBatchGetItem.mockResolvedValueOnce({ Responses: { "test-table": [] } })
        mockBatchGetItem.mockResolvedValueOnce({ Responses: { "test-table": [] } })

        const items = Array.from({ length: 101 }, (_, i) => UserEntity.get({ userId: `u-${i}` }))
        yield* Batch.get(items)
        expect(mockBatchGetItem).toHaveBeenCalledTimes(2)
        const first = mockBatchGetItem.mock.calls[0]![0]
        const second = mockBatchGetItem.mock.calls[1]![0]
        expect(first.RequestItems["test-table"].Keys).toHaveLength(100)
        expect(second.RequestItems["test-table"].Keys).toHaveLength(1)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("maxRetries: 0 causes immediate DynamoError on unprocessed items", () =>
      Effect.gen(function* () {
        // First call returns unprocessed items
        mockBatchWriteItem.mockResolvedValueOnce({
          UnprocessedItems: {
            "test-table": [
              {
                DeleteRequest: {
                  Key: toAttributeMap({ pk: "$myapp#v1#user#u-1", sk: "$myapp#v1#user" }),
                },
              },
            ],
          },
        })

        const error = yield* Batch.write([UserEntity.delete({ userId: "u-1" })], {
          maxRetries: 0,
        }).pipe(Effect.flip)

        expect(error._tag).toBe("DynamoError")
        expect((error as DynamoError).operation).toBe("BatchWriteItem")
        // Only 1 call — no retries
        expect(mockBatchWriteItem).toHaveBeenCalledTimes(1)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("custom config { maxRetries: 1, baseDelayMs: 50 } limits retries", () =>
      Effect.gen(function* () {
        const putItem = toAttributeMap({
          userId: "u-1",
          email: "alice@example.com",
          name: "Alice",
          role: "admin",
          pk: "$myapp#v1#user#u-1",
          sk: "$myapp#v1#user",
          __edd_e__: "User",
        })

        // Always return unprocessed items
        for (let i = 0; i < 3; i++) {
          mockBatchWriteItem.mockResolvedValueOnce({
            UnprocessedItems: {
              "test-table": [{ PutRequest: { Item: putItem } }],
            },
          })
        }

        const fiber = yield* Batch.write(
          [
            UserEntity.put({
              userId: "u-1",
              email: "alice@example.com",
              name: "Alice",
              role: "admin",
            }),
          ],
          { maxRetries: 1, baseDelayMs: 50 },
        ).pipe(Effect.provide(TestLayer), Effect.forkChild)

        yield* TestClock.adjust("1 seconds")

        const error = yield* Fiber.join(fiber).pipe(Effect.flip)
        expect(error._tag).toBe("DynamoError")
        // 1 initial + 1 retry = 2 calls
        expect(mockBatchWriteItem).toHaveBeenCalledTimes(2)
      }),
    )

    it.effect("default behavior unchanged when no config passed", () =>
      Effect.gen(function* () {
        mockBatchWriteItem.mockResolvedValueOnce({})

        yield* Batch.write([UserEntity.delete({ userId: "u-1" })])

        expect(mockBatchWriteItem).toHaveBeenCalledTimes(1)
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
          table: MainTable,
          entityType: "SparseItem",
          indexes: {
            primary: {
              pk: { field: "pk", composite: ["itemId"] },
              sk: { field: "sk", composite: [] },
            },
            byTenant: {
              index: "gsi1",
              pk: { field: "gsi1pk", composite: ["tenantId"] },
              sk: { field: "gsi1sk", composite: [] },
            },
          },
        })

        mockBatchWriteItem.mockResolvedValueOnce({})

        yield* Batch.write([SparseEntity.put({ itemId: "i-1", name: "NoTenant" })])

        const call = mockBatchWriteItem.mock.calls[0]![0]
        const item = fromAttributeMap(call.RequestItems["test-table"][0].PutRequest.Item)
        expect(item.pk).toBe("$myapp#v1#sparseitem#i-1")
        expect(item.__edd_e__).toBe("SparseItem")
        expect(item.gsi1pk).toBeUndefined()
        expect(item.gsi1sk).toBeUndefined()
      }).pipe(Effect.provide(TestLayer)),
    )
  })
})
