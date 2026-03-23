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
  entityType: "User",
  primaryKey: {
    pk: { field: "pk", composite: ["userId"] },
    sk: { field: "sk", composite: [] },
  },
  indexes: {
    byTenant: {
      collection: "TenantItems",
      index: { name: "gsi1", pk: "gsi1pk", sk: "gsi1sk" },
      composite: ["tenantId"],
      sk: [],
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
    byTenant: {
      collection: "TenantItems",
      index: { name: "gsi1", pk: "gsi1pk", sk: "gsi1sk" },
      composite: ["tenantId"],
      sk: [],
    },
  },
})

const MainTable = Table.make({
  schema: AppSchema,
  entities: { UserEntity, OrderEntity },
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
  describeTable: () => Effect.die("not used"),
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
        entityType: "Unlinked",
        primaryKey: {
          pk: { field: "pk", composite: ["userId"] },
          sk: { field: "sk", composite: [] },
        },
      })
      UnlinkedEntity._configure(AppSchema, MainTable.Tag)

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

  describe("isolated mode (entity-level indexes default to isolated)", () => {
    it("collection query uses PK-only (no SK condition) for isolated indexes", () => {
      const TenantItems = Collection.make("TenantItems", {
        users: UserEntity,
        orders: OrderEntity,
      })

      const q = TenantItems.query({ tenantId: "t-1" })
      // Entity-level indexes normalize to type: "isolated" — no SK condition
      expect(q._state.skConditions).toHaveLength(0)
    })

    it("entity selector uses PK-only (no SK condition) for isolated indexes", () => {
      const TenantItems = Collection.make("TenantItems", {
        users: UserEntity,
        orders: OrderEntity,
      })

      const q = TenantItems.users({ tenantId: "t-1" })
      // Isolated mode — entity selector also uses PK-only
      expect(q._state.skConditions).toHaveLength(0)
    })

    it.effect("isolated query uses PK-only KeyConditionExpression", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: undefined })

        const TenantItems = Collection.make("TenantItems", {
          users: UserEntity,
          orders: OrderEntity,
        })

        yield* Query.collect(TenantItems.query({ tenantId: "t-1" }))

        const call = mockQuery.mock.calls[0]![0]
        // Isolated mode — no begins_with on SK
        expect(call.KeyConditionExpression).not.toContain("begins_with")
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  describe("isolated mode", () => {
    const IsolatedUser = Entity.make({
      model: User,
      entityType: "User",
      primaryKey: {
        pk: { field: "pk", composite: ["userId"] },
        sk: { field: "sk", composite: [] },
      },
      indexes: {
        byTenant: {
          collection: "IsolatedTenantItems",
          index: { name: "gsi1", pk: "gsi1pk", sk: "gsi1sk" },
          composite: ["tenantId"],
          sk: [],
        },
      },
    })
    IsolatedUser._configure(AppSchema, MainTable.Tag)

    const IsolatedOrder = Entity.make({
      model: Order,
      entityType: "Order",
      primaryKey: {
        pk: { field: "pk", composite: ["orderId"] },
        sk: { field: "sk", composite: [] },
      },
      indexes: {
        byTenant: {
          collection: "IsolatedTenantItems",
          index: { name: "gsi1", pk: "gsi1pk", sk: "gsi1sk" },
          composite: ["tenantId"],
          sk: [],
        },
      },
    })
    IsolatedOrder._configure(AppSchema, MainTable.Tag)

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
