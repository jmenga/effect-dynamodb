import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Schema } from "effect"
import { beforeEach, vi } from "vitest"
import * as Collection from "../src/Collection.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as DynamoSchema from "../src/DynamoSchema.js"
import * as Entity from "../src/Entity.js"
import { DynamoError } from "../src/Errors.js"
import { toAttributeMap } from "../src/Marshaller.js"
import * as Query from "../src/Query.js"
import * as Table from "../src/Table.js"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const AppSchema = DynamoSchema.make({ name: "myapp", version: 1 })
const MainTable = Table.make({ schema: AppSchema })

class User extends Schema.Class<User>("User")({
  tenantId: Schema.String,
  userId: Schema.String,
  email: Schema.String,
}) {}

class Order extends Schema.Class<Order>("Order")({
  tenantId: Schema.String,
  orderId: Schema.String,
  total: Schema.Number,
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
    byTenant: {
      index: "gsi1",
      collection: "TenantItems",
      type: "clustered",
      pk: { field: "gsi1pk", composite: ["tenantId"] },
      sk: { field: "gsi1sk", composite: [] },
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
    byTenant: {
      index: "gsi1",
      collection: "TenantItems",
      type: "clustered",
      pk: { field: "gsi1pk", composite: ["tenantId"] },
      sk: { field: "gsi1sk", composite: [] },
    },
  },
})

// ---------------------------------------------------------------------------
// Mock DynamoClient
// ---------------------------------------------------------------------------

const mockQuery = vi.fn()

const TestDynamoClient = Layer.succeed(DynamoClient, {
  query: (input) =>
    Effect.tryPromise({
      try: () => mockQuery(input),
      catch: (e) => new DynamoError({ operation: "Query", cause: e }),
    }),
  putItem: () => Effect.die("not used"),
  getItem: () => Effect.die("not used"),
  deleteItem: () => Effect.die("not used"),
  updateItem: () => Effect.die("not used"),
  batchGetItem: () => Effect.die("not used"),
  batchWriteItem: () => Effect.die("not used"),
  transactGetItems: () => Effect.die("not used"),
  transactWriteItems: () => Effect.die("not used"),
  createTable: () => Effect.die("not used"),
  deleteTable: () => Effect.die("not used"),
  scan: () => Effect.die("not used"),
})

const TestTableConfig = MainTable.layer({ name: "test-table" })
const TestLayer = Layer.merge(TestDynamoClient, TestTableConfig)

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Collection", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe("make", () => {
    it("creates a Collection with the correct name", () => {
      const TenantItems = Collection.make("TenantItems", {
        users: UserEntity,
        orders: OrderEntity,
      })

      expect(TenantItems._tag).toBe("Collection")
      expect(TenantItems.name).toBe("TenantItems")
    })

    it("has entity selector functions", () => {
      const TenantItems = Collection.make("TenantItems", {
        users: UserEntity,
        orders: OrderEntity,
      })

      expect(typeof TenantItems.users).toBe("function")
      expect(typeof TenantItems.orders).toBe("function")
    })

    it("has a query function", () => {
      const TenantItems = Collection.make("TenantItems", {
        users: UserEntity,
        orders: OrderEntity,
      })

      expect(typeof TenantItems.query).toBe("function")
    })

    it("throws when no entities have the collection name", () => {
      const UnlinkedEntity = Entity.make({
        model: User,
        table: MainTable,
        entityType: "Unlinked",
        indexes: {
          primary: {
            pk: { field: "pk", composite: ["userId"] },
            sk: { field: "sk", composite: [] },
          },
        },
      })

      expect(() => Collection.make("NonExistent", { unlinked: UnlinkedEntity })).toThrow(
        'No entity in collection "NonExistent" has an index with collection: "NonExistent"',
      )
    })

    it("throws when entities list is empty", () => {
      expect(() => Collection.make("Empty", {})).toThrow("requires at least one entity")
    })
  })

  describe("query", () => {
    it("returns a Query object", () => {
      const TenantItems = Collection.make("TenantItems", {
        users: UserEntity,
        orders: OrderEntity,
      })

      const q = TenantItems.query({ tenantId: "t-1" })
      expect(Query.isQuery(q)).toBe(true)
      expect(q._state.entityTypes).toEqual(["User", "Order"])
    })

    it("uses the shared index", () => {
      const TenantItems = Collection.make("TenantItems", {
        users: UserEntity,
        orders: OrderEntity,
      })

      const q = TenantItems.query({ tenantId: "t-1" })
      expect(q._state.indexName).toBe("gsi1")
      expect(q._state.pkField).toBe("gsi1pk")
    })

    it("composes correct PK value", () => {
      const TenantItems = Collection.make("TenantItems", {
        users: UserEntity,
        orders: OrderEntity,
      })

      const q = TenantItems.query({ tenantId: "t-1" })
      expect(q._state.pkValue).toContain("t-1")
    })

    it.effect("executes and returns decoded items", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValueOnce({
          Items: [
            toAttributeMap({
              tenantId: "t-1",
              userId: "u-1",
              email: "alice@test.com",
              gsi1pk: "$myapp#v1#user#t-1",
              gsi1sk: "$myapp#v1#user",
              pk: "$myapp#v1#user#u-1",
              sk: "$myapp#v1#user",
              __edd_e__: "User",
            }),
            toAttributeMap({
              tenantId: "t-1",
              orderId: "o-1",
              total: 42,
              gsi1pk: "$myapp#v1#order#t-1",
              gsi1sk: "$myapp#v1#order",
              pk: "$myapp#v1#order#o-1",
              sk: "$myapp#v1#order",
              __edd_e__: "Order",
            }),
          ],
          LastEvaluatedKey: undefined,
        })

        const TenantItems = Collection.make("TenantItems", {
          users: UserEntity,
          orders: OrderEntity,
        })

        const q = TenantItems.query({ tenantId: "t-1" })
        const results = yield* Query.collect(q)

        // Results are tagged with entity key for grouping
        expect(results).toHaveLength(2)
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  describe("entity selectors", () => {
    it("returns a Query for a single entity type", () => {
      const TenantItems = Collection.make("TenantItems", {
        users: UserEntity,
        orders: OrderEntity,
      })

      const q = TenantItems.users({ tenantId: "t-1" })
      expect(Query.isQuery(q)).toBe(true)
      expect(q._state.entityTypes).toEqual(["User"])
    })

    it("narrows to just the selected entity type", () => {
      const TenantItems = Collection.make("TenantItems", {
        users: UserEntity,
        orders: OrderEntity,
      })

      const ordersQuery = TenantItems.orders({ tenantId: "t-1" })
      expect(ordersQuery._state.entityTypes).toEqual(["Order"])
    })

    it.effect("executes selector query and returns decoded items", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValueOnce({
          Items: [
            toAttributeMap({
              tenantId: "t-1",
              userId: "u-1",
              email: "alice@test.com",
              gsi1pk: "$myapp#v1#user#t-1",
              gsi1sk: "$myapp#v1#user",
              pk: "$myapp#v1#user#u-1",
              sk: "$myapp#v1#user",
              __edd_e__: "User",
            }),
          ],
          LastEvaluatedKey: undefined,
        })

        const TenantItems = Collection.make("TenantItems", {
          users: UserEntity,
          orders: OrderEntity,
        })

        const q = TenantItems.users({ tenantId: "t-1" })
        const results = yield* Query.collect(q)

        expect(results).toHaveLength(1)
        expect(results[0]!.userId).toBe("u-1")
        expect(results[0]!.email).toBe("alice@test.com")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("passes entity type filter to DynamoDB query", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: undefined })

        const TenantItems = Collection.make("TenantItems", {
          users: UserEntity,
          orders: OrderEntity,
        })

        const q = TenantItems.users({ tenantId: "t-1" })
        yield* Query.collect(q)

        const call = mockQuery.mock.calls[0]![0]
        expect(call.FilterExpression).toContain("#eddE IN (:et0)")
        expect(call.ExpressionAttributeNames["#eddE"]).toBe("__edd_e__")
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  // -------------------------------------------------------------------------
  // Isolated vs Clustered modes
  // -------------------------------------------------------------------------

  describe("clustered mode", () => {
    it("collection query includes begins_with SK condition", () => {
      const TenantItems = Collection.make("TenantItems", {
        users: UserEntity,
        orders: OrderEntity,
      })

      const q = TenantItems.query({ tenantId: "t-1" })
      expect(q._state.skConditions).toHaveLength(1)
      expect(q._state.skConditions[0]?.condition).toHaveProperty("beginsWith")
      // The SK prefix should be the collection prefix: $myapp#v1#tenantitems
      const beginsWith = (q._state.skConditions[0]?.condition as { beginsWith: string }).beginsWith
      expect(beginsWith).toContain("tenantitems")
    })

    it("entity selector includes entity-specific begins_with SK condition", () => {
      const TenantItems = Collection.make("TenantItems", {
        users: UserEntity,
        orders: OrderEntity,
      })

      const q = TenantItems.users({ tenantId: "t-1" })
      expect(q._state.skConditions).toHaveLength(1)
      const beginsWith = (q._state.skConditions[0]?.condition as { beginsWith: string }).beginsWith
      // Entity selector prefix includes collection + entity type: $myapp#v1#tenantitems#user_1
      expect(beginsWith).toContain("tenantitems")
      expect(beginsWith).toContain("user_1")
    })

    it.effect("clustered query passes begins_with to DynamoDB", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: undefined })

        const TenantItems = Collection.make("TenantItems", {
          users: UserEntity,
          orders: OrderEntity,
        })

        yield* Query.collect(TenantItems.query({ tenantId: "t-1" }))

        const call = mockQuery.mock.calls[0]![0]
        expect(call.KeyConditionExpression).toContain("begins_with(#sk, :sk)")
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  describe("isolated mode", () => {
    const IsolatedUser = Entity.make({
      model: User,
      table: MainTable,
      entityType: "User",
      indexes: {
        primary: {
          pk: { field: "pk", composite: ["userId"] },
          sk: { field: "sk", composite: [] },
        },
        byTenant: {
          index: "gsi1",
          collection: "IsolatedTenantItems",
          type: "isolated",
          pk: { field: "gsi1pk", composite: ["tenantId"] },
          sk: { field: "gsi1sk", composite: [] },
        },
      },
    })

    const IsolatedOrder = Entity.make({
      model: Order,
      table: MainTable,
      entityType: "Order",
      indexes: {
        primary: {
          pk: { field: "pk", composite: ["orderId"] },
          sk: { field: "sk", composite: [] },
        },
        byTenant: {
          index: "gsi1",
          collection: "IsolatedTenantItems",
          type: "isolated",
          pk: { field: "gsi1pk", composite: ["tenantId"] },
          sk: { field: "gsi1sk", composite: [] },
        },
      },
    })

    it("collection query uses PK-only (no SK condition)", () => {
      const IsolatedCollection = Collection.make("IsolatedTenantItems", {
        users: IsolatedUser,
        orders: IsolatedOrder,
      })

      const q = IsolatedCollection.query({ tenantId: "t-1" })
      expect(q._state.skConditions).toHaveLength(0)
    })

    it("entity selector uses PK-only (no SK condition)", () => {
      const IsolatedCollection = Collection.make("IsolatedTenantItems", {
        users: IsolatedUser,
        orders: IsolatedOrder,
      })

      const q = IsolatedCollection.users({ tenantId: "t-1" })
      expect(q._state.skConditions).toHaveLength(0)
    })

    it.effect("isolated query does not include begins_with in DynamoDB call", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: undefined })

        const IsolatedCollection = Collection.make("IsolatedTenantItems", {
          users: IsolatedUser,
          orders: IsolatedOrder,
        })

        yield* Query.collect(IsolatedCollection.query({ tenantId: "t-1" }))

        const call = mockQuery.mock.calls[0]![0]
        expect(call.KeyConditionExpression).not.toContain("begins_with")
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  describe("pipeable composition", () => {
    it("supports where/filter/limit/reverse on collection queries", () => {
      const TenantItems = Collection.make("TenantItems", {
        users: UserEntity,
        orders: OrderEntity,
      })

      const q = TenantItems.users({ tenantId: "t-1" }).pipe(Query.limit(10), Query.reverse)

      expect(q._state.limitValue).toBe(10)
      expect(q._state.scanForward).toBe(false)
    })
  })
})
