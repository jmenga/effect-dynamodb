import { it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { DynamoError, type ValidationError } from "@effect-dynamodb/schema/Errors.js"
import { Effect, Fiber, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { beforeEach, describe, expect, vi } from "vitest"
import * as Batch from "../src/Batch.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import { fromAttributeMap, toAttributeMap } from "../src/Marshaller.js"
import * as Table from "../src/Table.js"
import { mockDynamoClientLayer } from "./helpers/MockDynamoClient.js"

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

// #113 fixtures — entities whose write contract needs more than one item.
class UniqueMember extends Schema.Class<UniqueMember>("UniqueMember")({
  memberId: Schema.String,
  email: Schema.String,
}) {}

const UniqueMembers = Entity.make({
  model: UniqueMember,
  entityType: "UniqueMember",
  primaryKey: { pk: { field: "pk", composite: ["memberId"] }, sk: { field: "sk", composite: [] } },
  unique: { email: ["email"] },
})

class RetainDoc extends Schema.Class<RetainDoc>("RetainDoc")({
  docId: Schema.String,
  title: Schema.String,
}) {}

const RetainDocs = Entity.make({
  model: RetainDoc,
  entityType: "RetainDoc",
  primaryKey: { pk: { field: "pk", composite: ["docId"] }, sk: { field: "sk", composite: [] } },
  versioned: { retain: true },
})

class SoftItem extends Schema.Class<SoftItem>("SoftItem")({
  itemId: Schema.String,
  label: Schema.String,
}) {}

const SoftItems = Entity.make({
  model: SoftItem,
  entityType: "SoftItem",
  primaryKey: { pk: { field: "pk", composite: ["itemId"] }, sk: { field: "sk", composite: [] } },
  softDelete: true,
})

// #133 fixture — a versioned entity: a batch put must never replace an item.
class VersionedNote extends Schema.Class<VersionedNote>("VersionedNote")({
  noteId: Schema.String,
  body: Schema.String,
}) {}

const VersionedNotes = Entity.make({
  model: VersionedNote,
  entityType: "VersionedNote",
  primaryKey: { pk: { field: "pk", composite: ["noteId"] }, sk: { field: "sk", composite: [] } },
  versioned: true,
})

class VersionedBlob extends Schema.Class<VersionedBlob>("VersionedBlob")({
  blobId: Schema.String,
  data: Schema.Uint8Array,
}) {}

const VersionedBlobs = Entity.make({
  model: VersionedBlob,
  entityType: "VersionedBlob",
  primaryKey: { pk: { field: "pk", composite: ["blobId"] }, sk: { field: "sk", composite: [] } },
  versioned: true,
})

// #120 fixture — an entity whose id the framework generates when it is absent.
class GenDoc extends Schema.Class<GenDoc>("GenDoc")({
  docId: Schema.String,
  title: Schema.String,
}) {}

const GenDocs = Entity.make({
  model: GenDoc,
  entityType: "GenDoc",
  primaryKey: { pk: { field: "pk", composite: ["docId"] }, sk: { field: "sk", composite: [] } },
  generatedId: { field: "docId" },
})

const MainTable = Table.make({
  schema: AppSchema,
  entities: {
    UserEntity,
    OrderEntity,
    UniqueMembers,
    RetainDocs,
    SoftItems,
    GenDocs,
    VersionedNotes,
    VersionedBlobs,
  },
})

// --- Mock DynamoClient ---

const mockBatchGetItem = vi.fn()
const mockBatchWriteItem = vi.fn()
const mockTransactWriteItems = vi.fn()
const mockGetItem = vi.fn()

const TestDynamoClient = mockDynamoClientLayer({
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
  transactWriteItems: (input) =>
    Effect.tryPromise({
      try: () => mockTransactWriteItems(input),
      catch: (e) => new DynamoError({ operation: "TransactWriteItems", cause: e }),
    }),
  getItem: (input) =>
    Effect.tryPromise({
      try: () => mockGetItem(input),
      catch: (e) => new DynamoError({ operation: "GetItem", cause: e }),
    }),
})

/** A TransactionCanceledException as the AWS SDK raises it. */
const cancelled = (codes: ReadonlyArray<string>) =>
  Object.assign(new Error("Transaction cancelled"), {
    name: "TransactionCanceledException",
    CancellationReasons: codes.map((Code) => ({ Code })),
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
          pk: "$myapp#v1#user#userid_u-2",
          sk: "$myapp#v1#user",
          __edd_e__: "User",
        })
        const user1Item = toAttributeMap({
          userId: "u-1",
          email: "alice@example.com",
          name: "Alice",
          role: "admin",
          pk: "$myapp#v1#user#userid_u-1",
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
          pk: "$myapp#v1#user#userid_u-1",
          sk: "$myapp#v1#user",
        })
        const userItem = toAttributeMap({
          userId: "u-1",
          email: "alice@example.com",
          name: "Alice",
          role: "admin",
          pk: "$myapp#v1#user#userid_u-1",
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
          pk: "$myapp#v1#user#userid_u-1",
          sk: "$myapp#v1#user",
          __edd_e__: "User",
        })

        mockBatchGetItem.mockResolvedValueOnce({
          Responses: { "test-table": [malformedItem] },
        })

        const error = yield* Batch.get([UserEntity.get({ userId: "u-1" })]).pipe(Effect.flip)

        expect(error._tag).toBe("ValidationError")
        expect((error as ValidationError).entityType).toBe("User")
        expect((error as ValidationError).operation).toBe("decode")
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
        expect(userItem.pk).toBe("$myapp#v1#user#userid_u-1")
        expect(userItem.__edd_e__).toBe("User")

        const orderItem = fromAttributeMap(call.RequestItems["test-table"][1].PutRequest.Item)
        expect(orderItem.pk).toBe("$myapp#v1#order#orderid_ord-1")
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
        expect(deleteKey.pk).toBe("$myapp#v1#user#userid_u-1")
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
          pk: "$myapp#v1#user#userid_u-1",
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
          pk: "$myapp#v1#user#userid_u-1",
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
                  Key: toAttributeMap({ pk: "$myapp#v1#user#userid_u-1", sk: "$myapp#v1#user" }),
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
          pk: "$myapp#v1#user#userid_u-1",
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

        mockBatchWriteItem.mockResolvedValueOnce({})

        yield* Batch.write([SparseEntity.put({ itemId: "i-1", name: "NoTenant" })])

        const call = mockBatchWriteItem.mock.calls[0]![0]
        const item = fromAttributeMap(call.RequestItems["test-table"][0].PutRequest.Item)
        expect(item.pk).toBe("$myapp#v1#sparseitem#itemid_i-1")
        expect(item.__edd_e__).toBe("SparseItem")
        expect(item.gsi1pk).toBeUndefined()
        expect(item.gsi1sk).toBeUndefined()
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  // -------------------------------------------------------------------------
  // #100 — bound-CRUD builders as batch-write ops
  // -------------------------------------------------------------------------

  describe("bound-CRUD builders as write ops (#100)", () => {
    it.effect("accepts a bound put and a bound delete from db.entities.*", () =>
      Effect.gen(function* () {
        mockBatchWriteItem.mockResolvedValueOnce({})
        const db = yield* DynamoClient.make({
          entities: { UserEntity, OrderEntity },
          tables: { MainTable },
        })

        yield* Batch.write([
          db.entities.UserEntity.put({
            userId: "u-1",
            email: "a@x.io",
            name: "Alice",
            role: "admin",
          }),
          db.entities.OrderEntity.delete({ orderId: "ord-1" }),
        ])

        const requests = mockBatchWriteItem.mock.calls[0]![0].RequestItems["test-table"]
        expect(requests).toHaveLength(2)
        const put = fromAttributeMap(requests[0].PutRequest.Item)
        expect(put.pk).toBe("$myapp#v1#user#userid_u-1")
        expect(put.__edd_e__).toBe("User")
        const del = fromAttributeMap(requests[1].DeleteRequest.Key)
        expect(del.pk).toBe("$myapp#v1#order#orderid_ord-1")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("rejects a conditional write instead of silently dropping the condition", () =>
      Effect.gen(function* () {
        const db = yield* DynamoClient.make({
          entities: { UserEntity, OrderEntity },
          tables: { MainTable },
        })

        const error = yield* Batch.write([
          db.entities.UserEntity.put({
            userId: "u-1",
            email: "a@x.io",
            name: "Alice",
            role: "admin",
          }).condition({ role: "admin" }),
        ]).pipe(Effect.flip)

        expect(error._tag).toBe("ValidationError")
        expect((error as ValidationError).operation).toBe("batchWrite")
        expect(mockBatchWriteItem).not.toHaveBeenCalled()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("rejects create() — its attribute_not_exists guard is unexpressible", () =>
      Effect.gen(function* () {
        const error = yield* Batch.write([
          UserEntity.create({ userId: "u-1", email: "a@x.io", name: "Alice", role: "admin" }),
        ]).pipe(Effect.flip)

        expect(error._tag).toBe("ValidationError")
        expect((error as ValidationError).entityType).toBe("User")
        expect(mockBatchWriteItem).not.toHaveBeenCalled()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("rejects create() and deleteIfExists() whatever .condition() is added (#133)", () =>
      Effect.gen(function* () {
        const db = yield* DynamoClient.make({
          entities: { UserEntity, OrderEntity },
          tables: { MainTable },
        })
        const input = { userId: "u-1", email: "a@x.io", name: "Alice", role: "admin" } as const
        for (const op of [
          UserEntity.create(input).pipe(UserEntity.condition({})),
          db.entities.UserEntity.create(input).condition({ name: "a" }).condition({}),
          UserEntity.deleteIfExists({ userId: "u-1" }).pipe(UserEntity.condition({})),
          db.entities.UserEntity.deleteIfExists({ userId: "u-1" }).condition({}),
        ]) {
          const error = yield* Batch.write([op]).pipe(Effect.flip)
          expect(error._tag).toBe("ValidationError")
        }
        expect(mockBatchWriteItem).not.toHaveBeenCalled()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("rejects upsert — BatchWriteItem has no UpdateRequest", () =>
      Effect.gen(function* () {
        const db = yield* DynamoClient.make({
          entities: { UserEntity, OrderEntity },
          tables: { MainTable },
        })

        const error = yield* Batch.write([
          db.entities.UserEntity.upsert({
            userId: "u-1",
            email: "a@x.io",
            name: "Alice",
            role: "admin",
          }),
        ]).pipe(Effect.flip)

        expect(error._tag).toBe("ValidationError")
        expect(String((error as ValidationError).cause)).toContain("upsert")
        expect(mockBatchWriteItem).not.toHaveBeenCalled()
      }).pipe(Effect.provide(TestLayer)),
    )

    // A rejection the caller cannot catch is as bad as a silent success. These
    // two paths used to `throw new Error`, surfacing as an opaque defect.
    it.effect("an update op fails on the error channel, not as a defect", () =>
      Effect.gen(function* () {
        const db = yield* DynamoClient.make({
          entities: { UserEntity, OrderEntity },
          tables: { MainTable },
        })

        const error = yield* Batch.write([
          db.entities.UserEntity.update({ userId: "u-1" }).set({ name: "Bob" }) as never,
        ]).pipe(Effect.flip)

        expect(error._tag).toBe("ValidationError")
        expect(String((error as ValidationError).cause)).toContain("UpdateRequest")
        expect(mockBatchWriteItem).not.toHaveBeenCalled()
      }).pipe(Effect.provide(TestLayer)),
    )

    // -----------------------------------------------------------------------
    // #120 — the generatedId gate reads the INPUT, not the configuration.
    // -----------------------------------------------------------------------
    //
    // `Entity.put` reaches `Crypto` only when the field is absent, so a caller
    // who supplies the id needs nothing `BatchWriteItem` lacks. Gating on the
    // configuration barred the entity from `Batch.write` outright, citing a
    // dependency that did not apply to the call being rejected.

    it.effect("rejects a put whose generated id was OMITTED — that needs Crypto", () =>
      Effect.gen(function* () {
        const error = yield* Batch.write([GenDocs.put({ title: "T" } as never)]).pipe(Effect.flip)

        expect(error._tag).toBe("ValidationError")
        const cause = String((error as ValidationError).cause)
        expect(cause).toContain("omitted generated id")
        expect(cause).toContain("docId")
        expect(mockBatchWriteItem).not.toHaveBeenCalled()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("ALLOWS a put whose generated id the caller supplied", () =>
      Effect.gen(function* () {
        mockBatchWriteItem.mockResolvedValueOnce({})

        yield* Batch.write([GenDocs.put({ docId: "d-1", title: "T" })])

        const requests = mockBatchWriteItem.mock.calls[0]![0].RequestItems["test-table"]
        expect(requests).toHaveLength(1)
        expect(requests[0].PutRequest.Item.docId.S).toBe("d-1")
        expect(requests[0].PutRequest.Item.pk.S).toContain("docid_d-1")
      }).pipe(Effect.provide(TestLayer)),
    )

    // -----------------------------------------------------------------------
    // #113 — BatchWriteItem cannot host the multi-item lifecycle features.
    // -----------------------------------------------------------------------

    it.effect("rejects a put of a unique entity — no ConditionExpression for the sentinel", () =>
      Effect.gen(function* () {
        const error = yield* Batch.write([
          UniqueMembers.put({ memberId: "m-1", email: "a@x.io" }),
        ]).pipe(Effect.flip)

        expect(error._tag).toBe("ValidationError")
        expect(String((error as ValidationError).cause)).toContain("EDD-9049")
        expect(mockBatchWriteItem).not.toHaveBeenCalled()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("rejects a put of a retain entity — the snapshot would not be atomic", () =>
      Effect.gen(function* () {
        const error = yield* Batch.write([RetainDocs.put({ docId: "d-1", title: "T" })]).pipe(
          Effect.flip,
        )

        expect(error._tag).toBe("ValidationError")
        expect(String((error as ValidationError).cause)).toContain("EDD-9049")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("rejects a DELETE of a softDelete entity — a tombstone is not a DeleteRequest", () =>
      Effect.gen(function* () {
        const error = yield* Batch.write([SoftItems.delete({ itemId: "i-1" })]).pipe(Effect.flip)

        expect(error._tag).toBe("ValidationError")
        expect(String((error as ValidationError).cause)).toContain("EDD-9049")
        expect(String((error as ValidationError).cause)).toContain("softDelete")
      }).pipe(Effect.provide(TestLayer)),
    )

    // Direction matters: `softDelete` changes only the delete path, so a put of
    // a soft-deletable entity is an ordinary single-item write. Gating it would
    // have broken writes that were always correct — the connected suite caught
    // exactly this.
    it.effect("ALLOWS a put of a softDelete entity — softDelete only affects deletes", () =>
      Effect.gen(function* () {
        mockBatchWriteItem.mockResolvedValueOnce({})

        yield* Batch.write([SoftItems.put({ itemId: "i-1", label: "L" })])

        const requests = mockBatchWriteItem.mock.calls[0]![0].RequestItems["test-table"]
        expect(requests).toHaveLength(1)
        expect(fromAttributeMap(requests[0].PutRequest.Item).__edd_e__).toBe("SoftItem")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("sends versioned puts as create-only transactions, with no read", () =>
      Effect.gen(function* () {
        mockTransactWriteItems.mockResolvedValueOnce({})
        mockBatchWriteItem.mockResolvedValueOnce({ UnprocessedItems: {} })
        yield* Batch.write([
          VersionedNotes.put({ noteId: "n-1", body: "a" }),
          OrderEntity.put({
            orderId: "o-1",
            userId: "u-1",
            product: "x",
            quantity: 1,
            status: "pending",
          }),
        ])

        expect(mockGetItem).not.toHaveBeenCalled()
        expect(mockTransactWriteItems).toHaveBeenCalledOnce()
        const [put] = mockTransactWriteItems.mock.calls[0]![0].TransactItems
        expect(put.Put.ConditionExpression).toBe("attribute_not_exists(#pk)")
        expect(put.Put.ExpressionAttributeNames).toEqual({ "#pk": "pk" })
        expect(put.Put.Item.version).toEqual({ N: "1" })
        expect(put.Put.Item.__edd_i__).toBeDefined()
        // The non-versioned put is still a plain BatchWriteItem request.
        const requests = mockBatchWriteItem.mock.calls[0]![0].RequestItems["test-table"]
        expect(requests).toHaveLength(1)
        expect(requests[0].PutRequest.Item.orderId).toEqual({ S: "o-1" })
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("refuses a versioned put that would replace an item, before any plain write", () =>
      Effect.gen(function* () {
        mockTransactWriteItems.mockRejectedValueOnce(cancelled(["None", "ConditionalCheckFailed"]))
        const error = yield* Batch.write([
          VersionedNotes.put({ noteId: "n-1", body: "a" }),
          VersionedNotes.put({ noteId: "n-2", body: "b" }),
          OrderEntity.put({
            orderId: "o-1",
            userId: "u-1",
            product: "x",
            quantity: 1,
            status: "pending",
          }),
        ]).pipe(Effect.flip)

        expect(error._tag).toBe("ValidationError")
        expect(String((error as ValidationError).cause)).toContain("would replace an existing")
        expect(mockBatchWriteItem).not.toHaveBeenCalled()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("retries a versioned-put chunk cancelled by contention only", () =>
      Effect.gen(function* () {
        mockTransactWriteItems
          .mockRejectedValueOnce(cancelled(["TransactionConflict"]))
          .mockResolvedValueOnce({})
        const fiber = yield* Batch.write([VersionedNotes.put({ noteId: "n-1", body: "a" })], {
          baseDelayMs: 1,
        }).pipe(Effect.forkChild)
        yield* TestClock.adjust("1 second")
        yield* Fiber.join(fiber)
        expect(mockTransactWriteItems).toHaveBeenCalledTimes(2)

        mockTransactWriteItems.mockReset()
        mockTransactWriteItems.mockRejectedValueOnce(cancelled(["ValidationError"]))
        const error = yield* Batch.write([VersionedNotes.put({ noteId: "n-2", body: "b" })], {
          baseDelayMs: 1,
        }).pipe(Effect.flip)
        expect(error._tag).toBe("DynamoError")
        expect(mockTransactWriteItems).toHaveBeenCalledOnce()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("chunks versioned puts at 100 per transaction", () =>
      Effect.gen(function* () {
        mockTransactWriteItems.mockResolvedValue({})
        yield* Batch.write(
          Array.from({ length: 101 }, (_, i) =>
            VersionedNotes.put({ noteId: `n-${i}`, body: "a" }),
          ),
        )
        expect(mockTransactWriteItems).toHaveBeenCalledTimes(2)
        expect(mockTransactWriteItems.mock.calls[0]![0].TransactItems).toHaveLength(100)
        expect(mockTransactWriteItems.mock.calls[1]![0].TransactItems).toHaveLength(1)
        expect(mockBatchWriteItem).not.toHaveBeenCalled()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("refuses a batch touching a versioned put's item twice, before writing", () =>
      Effect.gen(function* () {
        const reordered = yield* Batch.write([
          VersionedNotes.delete({ noteId: "n-1" }),
          VersionedNotes.put({ noteId: "n-1", body: "a" }),
        ]).pipe(Effect.flip)
        expect(reordered._tag).toBe("ValidationError")
        expect(String((reordered as ValidationError).cause)).toContain("more than once")

        const duplicated = yield* Batch.write([
          VersionedNotes.put({ noteId: "n-2", body: "a" }),
          VersionedNotes.put({ noteId: "n-2", body: "b" }),
        ]).pipe(Effect.flip)
        expect(duplicated._tag).toBe("ValidationError")
        expect(mockTransactWriteItems).not.toHaveBeenCalled()
        expect(mockBatchWriteItem).not.toHaveBeenCalled()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("bounds a versioned-put transaction by DynamoDB's 4 MB payload", () =>
      Effect.gen(function* () {
        mockTransactWriteItems.mockResolvedValue({})
        // ~380 KB each: 12 of them exceed 4 MB in one transaction.
        const body = "x".repeat(380_000)
        yield* Batch.write(
          Array.from({ length: 12 }, (_, i) => VersionedNotes.put({ noteId: `big-${i}`, body })),
        )
        const sizes = mockTransactWriteItems.mock.calls.map(
          (call) => call[0].TransactItems.length as number,
        )
        expect(sizes.length).toBeGreaterThan(1)
        expect(sizes.reduce((a, b) => a + b, 0)).toBe(12)
        for (const call of mockTransactWriteItems.mock.calls) {
          expect(JSON.stringify(call[0].TransactItems).length).toBeLessThan(4_000_000)
        }
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("sizes binary attributes by their bytes, not their JSON", () =>
      Effect.gen(function* () {
        mockTransactWriteItems.mockResolvedValue({})
        // 11 × 300 KB = 3.3 MB fits one transaction; as JSON it would not.
        const data = new Uint8Array(300_000)
        yield* Batch.write(
          Array.from({ length: 11 }, (_, i) => VersionedBlobs.put({ blobId: `b-${i}`, data })),
        )
        expect(mockTransactWriteItems).toHaveBeenCalledOnce()
        expect(mockTransactWriteItems.mock.calls[0]![0].TransactItems).toHaveLength(11)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("names the entity whose item a batch touches twice", () =>
      Effect.gen(function* () {
        const error = yield* Batch.write([
          VersionedNotes.put({ noteId: "x", body: "a" }),
          VersionedBlobs.put({ blobId: "dup", data: new Uint8Array(1) }),
          VersionedBlobs.delete({ blobId: "dup" }),
        ]).pipe(Effect.flip)
        expect(error._tag).toBe("ValidationError")
        expect((error as ValidationError).entityType).toBe("VersionedBlob")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("keeps the cancellation reasons and cause on a non-retryable failure", () =>
      Effect.gen(function* () {
        const exception = Object.assign(cancelled(["ValidationError"]), {
          CancellationReasons: [{ Code: "ValidationError", Message: "Item size has exceeded" }],
        })
        mockTransactWriteItems.mockRejectedValueOnce(exception)
        const error = yield* Batch.write([VersionedNotes.put({ noteId: "n-1", body: "a" })]).pipe(
          Effect.flip,
        )
        expect(error._tag).toBe("DynamoError")
        const cause = (error as DynamoError).cause as Error
        expect(cause.message).toContain("Item size has exceeded")
        expect(cause.cause).toBe(exception)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("an unrecognized op fails on the error channel, not as a defect", () =>
      Effect.gen(function* () {
        const error = yield* Batch.write([{ nonsense: true } as never]).pipe(Effect.flip)

        expect(error._tag).toBe("ValidationError")
        expect((error as ValidationError).entityType).toBe("unknown")
        expect(mockBatchWriteItem).not.toHaveBeenCalled()
      }).pipe(Effect.provide(TestLayer)),
    )
  })
})
