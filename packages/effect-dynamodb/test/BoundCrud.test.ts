/**
 * Tests for the fluent bound-CRUD builders (BoundPut / BoundCreate / BoundDelete /
 * BoundUpdate / BoundUpsert / BoundPatch).
 *
 * These cover:
 *   - yield* executes the op
 *   - chainable combinators produce new immutable builders
 *   - `.condition()` callback and shorthand forms reach the wire
 *   - `.set() / .remove() / .add() / .subtract() / .append()` compose together
 *   - `.expectedVersion()` injects the optimistic-lock condition
 *   - `.asEffect()` yields an Effect with R = never
 */

import { describe, expect, it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { DynamoError } from "@effect-dynamodb/schema/Errors.js"
import { DateTime, Effect, Layer, Schema } from "effect"
import { beforeEach, vi } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const AppSchema = DynamoSchema.make({ name: "testapp", version: 1 })

class Product extends Schema.Class<Product>("Product")({
  productId: Schema.String,
  name: Schema.String,
  price: Schema.Number,
  stock: Schema.Number,
  viewCount: Schema.Number,
  status: Schema.String,
  tags: Schema.Array(Schema.String),
}) {}

const ProductEntity = Entity.make({
  model: Product,
  entityType: "Product",
  primaryKey: {
    pk: { field: "pk", composite: ["productId"] },
    sk: { field: "sk", composite: [] },
  },
  versioned: true,
})

const MainTable = Table.make({
  schema: AppSchema,
  entities: { Product: ProductEntity },
})

// ---------------------------------------------------------------------------
// Capturing mock DynamoClient — records the last op's input.
// ---------------------------------------------------------------------------

const mockPutItem = vi.fn()
const mockGetItem = vi.fn()
const mockDeleteItem = vi.fn()
const mockUpdateItem = vi.fn()

const TestClient = Layer.succeed(DynamoClient, {
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
  query: () => Effect.die("not used"),
  scan: () => Effect.die("not used"),
  batchGetItem: () => Effect.die("not used"),
  batchWriteItem: () => Effect.die("not used"),
  transactGetItems: () => Effect.die("not used"),
  transactWriteItems: () => Effect.die("not used"),
  createTable: () => Effect.die("not used"),
  deleteTable: () => Effect.die("not used"),
  describeTable: () => Effect.die("not used"),
})

const TableLayer = MainTable.layer({ name: "bound-crud-test-table" })
const TestLayer = Layer.merge(TestClient, TableLayer)

/** Build a marshalled Product record for mock update/upsert return values. */
const buildAttributes = (productId: string) => ({
  pk: { S: `$testapp#v1#product#productid_${productId}` },
  sk: { S: "$testapp#v1#product" },
  __edd_e__: { S: "Product" },
  productId: { S: productId },
  name: { S: "X" },
  price: { N: "0" },
  stock: { N: "0" },
  viewCount: { N: "0" },
  status: { S: "a" },
  tags: { L: [] },
  version: { N: "1" },
})

beforeEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// BoundPut
// ---------------------------------------------------------------------------

describe("BoundPut", () => {
  it.effect("yield* executes putItem with decoded model return", () =>
    Effect.gen(function* () {
      mockPutItem.mockResolvedValueOnce({})
      const db = yield* DynamoClient.make({
        entities: { Product: ProductEntity },
        tables: { MainTable },
      })
      const result = yield* db.entities.Product.put({
        productId: "p-1",
        name: "Widget",
        price: 9.99,
        stock: 10,
        viewCount: 0,
        status: "active",
        tags: [],
      })
      expect(result.productId).toBe("p-1")
      expect(mockPutItem).toHaveBeenCalledOnce()
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect(".condition({...}) shorthand reaches the wire", () =>
    Effect.gen(function* () {
      mockPutItem.mockResolvedValueOnce({})
      const db = yield* DynamoClient.make({
        entities: { Product: ProductEntity },
        tables: { MainTable },
      })
      yield* db.entities.Product.put({
        productId: "p-1",
        name: "Widget",
        price: 9.99,
        stock: 10,
        viewCount: 0,
        status: "active",
        tags: [],
      }).condition({ status: "active" })

      const call = mockPutItem.mock.calls[0]![0]
      expect(call.ConditionExpression).toBeDefined()
      expect(Object.values(call.ExpressionAttributeNames)).toContain("status")
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect(".condition(callback) reaches the wire", () =>
    Effect.gen(function* () {
      mockPutItem.mockResolvedValueOnce({})
      const db = yield* DynamoClient.make({
        entities: { Product: ProductEntity },
        tables: { MainTable },
      })
      yield* db.entities.Product.put({
        productId: "p-1",
        name: "Widget",
        price: 9.99,
        stock: 10,
        viewCount: 0,
        status: "active",
        tags: [],
      }).condition((t, { gt }) => gt(t.price, 5))

      const call = mockPutItem.mock.calls[0]![0]
      expect(call.ConditionExpression).toBeDefined()
      expect(Object.values(call.ExpressionAttributeNames)).toContain("price")
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("create (no user condition) adds attribute_not_exists condition", () =>
    Effect.gen(function* () {
      mockPutItem.mockResolvedValueOnce({})
      const db = yield* DynamoClient.make({
        entities: { Product: ProductEntity },
        tables: { MainTable },
      })
      yield* db.entities.Product.create({
        productId: "p-2",
        name: "Widget 2",
        price: 10,
        stock: 1,
        viewCount: 0,
        status: "active",
        tags: [],
      })

      const call = mockPutItem.mock.calls[0]![0]
      expect(call.ConditionExpression).toContain("attribute_not_exists")
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("combinators are immutable — each returns a new builder", () =>
    Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { Product: ProductEntity },
        tables: { MainTable },
      })
      const base = db.entities.Product.put({
        productId: "p-1",
        name: "Widget",
        price: 9.99,
        stock: 10,
        viewCount: 0,
        status: "active",
        tags: [],
      })
      const withA = base.condition({ status: "active" })
      const withB = base.condition({ status: "archived" })
      expect(withA).not.toBe(base)
      expect(withB).not.toBe(withA)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect(".asEffect() returns an Effect with R = never", () =>
    Effect.gen(function* () {
      mockPutItem.mockResolvedValueOnce({})
      const db = yield* DynamoClient.make({
        entities: { Product: ProductEntity },
        tables: { MainTable },
      })
      const eff = db.entities.Product.put({
        productId: "p-1",
        name: "Widget",
        price: 9.99,
        stock: 10,
        viewCount: 0,
        status: "active",
        tags: [],
      }).asEffect()
      const result = yield* eff
      expect(result.productId).toBe("p-1")
    }).pipe(Effect.provide(TestLayer)),
  )
})

// ---------------------------------------------------------------------------
// BoundUpdate
// ---------------------------------------------------------------------------

describe("BoundUpdate", () => {
  it.effect(".set({...}) builds a SET expression", () =>
    Effect.gen(function* () {
      mockUpdateItem.mockResolvedValueOnce({ Attributes: buildAttributes("p-1") })
      const db = yield* DynamoClient.make({
        entities: { Product: ProductEntity },
        tables: { MainTable },
      })
      yield* db.entities.Product.update({ productId: "p-1" }).set({ name: "Updated" })

      const call = mockUpdateItem.mock.calls[0]![0]
      expect(call.UpdateExpression).toContain("SET")
      expect(Object.values(call.ExpressionAttributeNames)).toContain("name")
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect(".expectedVersion(n) adds the optimistic-lock condition", () =>
    Effect.gen(function* () {
      mockUpdateItem.mockResolvedValueOnce({ Attributes: buildAttributes("p-1") })
      const db = yield* DynamoClient.make({
        entities: { Product: ProductEntity },
        tables: { MainTable },
      })
      yield* db.entities.Product.update({ productId: "p-1" })
        .set({ name: "Updated" })
        .expectedVersion(3)

      const call = mockUpdateItem.mock.calls[0]![0]
      expect(call.ConditionExpression).toBeDefined()
      // The version condition is ANDed — look for a version attribute reference.
      const nameValues = Object.values(call.ExpressionAttributeNames)
      expect(nameValues).toContain("version")
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect(".set + .add + .subtract + .append + .remove compose", () =>
    Effect.gen(function* () {
      mockUpdateItem.mockResolvedValueOnce({ Attributes: buildAttributes("p-1") })
      const db = yield* DynamoClient.make({
        entities: { Product: ProductEntity },
        tables: { MainTable },
      })
      yield* db.entities.Product.update({ productId: "p-1" })
        .set({ name: "Updated", price: 24.99 })
        .add({ viewCount: 1 })
        .subtract({ stock: 3 })
        .append({ tags: ["clearance"] })
        .remove(["status"])

      const call = mockUpdateItem.mock.calls[0]![0]
      const expr = call.UpdateExpression as string
      expect(expr).toContain("SET")
      expect(expr).toContain("ADD")
      expect(expr).toContain("REMOVE")
      expect(expr).toContain("list_append")
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect(".condition(shorthand) ANDs with version condition", () =>
    Effect.gen(function* () {
      mockUpdateItem.mockResolvedValueOnce({ Attributes: buildAttributes("p-1") })
      const db = yield* DynamoClient.make({
        entities: { Product: ProductEntity },
        tables: { MainTable },
      })
      yield* db.entities.Product.update({ productId: "p-1" })
        .set({ name: "Updated" })
        .condition({ status: "active" })
        .expectedVersion(1)

      const call = mockUpdateItem.mock.calls[0]![0]
      expect(call.ConditionExpression).toContain("AND")
      const nameValues = Object.values(call.ExpressionAttributeNames)
      expect(nameValues).toContain("status")
      expect(nameValues).toContain("version")
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("combinators are immutable", () =>
    Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { Product: ProductEntity },
        tables: { MainTable },
      })
      const base = db.entities.Product.update({ productId: "p-1" })
      const withSet = base.set({ name: "A" })
      const withSetAndVersion = withSet.expectedVersion(2)
      expect(withSet).not.toBe(base)
      expect(withSetAndVersion).not.toBe(withSet)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect(".asEffect() returns an Effect with R = never", () =>
    Effect.gen(function* () {
      mockUpdateItem.mockResolvedValueOnce({ Attributes: buildAttributes("p-1") })
      const db = yield* DynamoClient.make({
        entities: { Product: ProductEntity },
        tables: { MainTable },
      })
      const eff = db.entities.Product.update({ productId: "p-1" })
        .set({ name: "Via asEffect" })
        .asEffect()
      yield* eff
      expect(mockUpdateItem).toHaveBeenCalledOnce()
    }).pipe(Effect.provide(TestLayer)),
  )
})

// ---------------------------------------------------------------------------
// BoundDelete
// ---------------------------------------------------------------------------

describe("BoundDelete", () => {
  it.effect("yield* executes deleteItem", () =>
    Effect.gen(function* () {
      mockDeleteItem.mockResolvedValueOnce({})
      const db = yield* DynamoClient.make({
        entities: { Product: ProductEntity },
        tables: { MainTable },
      })
      yield* db.entities.Product.delete({ productId: "p-1" })
      expect(mockDeleteItem).toHaveBeenCalledOnce()
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect(".condition(shorthand) reaches the wire", () =>
    Effect.gen(function* () {
      mockDeleteItem.mockResolvedValueOnce({})
      const db = yield* DynamoClient.make({
        entities: { Product: ProductEntity },
        tables: { MainTable },
      })
      yield* db.entities.Product.delete({ productId: "p-1" }).condition({ status: "archived" })

      const call = mockDeleteItem.mock.calls[0]![0]
      expect(call.ConditionExpression).toBeDefined()
      expect(Object.values(call.ExpressionAttributeNames)).toContain("status")
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect(".returnValues('allOld') sets ReturnValues", () =>
    Effect.gen(function* () {
      mockDeleteItem.mockResolvedValueOnce({})
      const db = yield* DynamoClient.make({
        entities: { Product: ProductEntity },
        tables: { MainTable },
      })
      yield* db.entities.Product.delete({ productId: "p-1" }).returnValues("allOld")

      const call = mockDeleteItem.mock.calls[0]![0]
      expect(call.ReturnValues).toBe("ALL_OLD")
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("combinators are immutable", () =>
    Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { Product: ProductEntity },
        tables: { MainTable },
      })
      const base = db.entities.Product.delete({ productId: "p-1" })
      const withCond = base.condition({ status: "archived" })
      const withRv = withCond.returnValues("allOld")
      expect(withCond).not.toBe(base)
      expect(withRv).not.toBe(withCond)
    }).pipe(Effect.provide(TestLayer)),
  )
})

// ---------------------------------------------------------------------------
// BoundUpsert / BoundPatch — same shape as put / update, smoke-test only
// ---------------------------------------------------------------------------

describe("BoundUpsert", () => {
  it.effect("yield* upsert executes with conditional-put semantics", () =>
    Effect.gen(function* () {
      // upsert routes through updateItem (ReturnValues: ALL_NEW) per Entity.upsert().
      mockUpdateItem.mockResolvedValueOnce({
        Attributes: {
          pk: { S: "$testapp#v1#product#p-1" },
          sk: { S: "$testapp#v1#product" },
          __edd_e__: { S: "Product" },
          productId: { S: "p-1" },
          name: { S: "W" },
          price: { N: "1" },
          stock: { N: "0" },
          viewCount: { N: "0" },
          status: { S: "a" },
          tags: { L: [] },
          version: { N: "1" },
        },
      })
      const db = yield* DynamoClient.make({
        entities: { Product: ProductEntity },
        tables: { MainTable },
      })
      yield* db.entities.Product.upsert({
        productId: "p-1",
        name: "W",
        price: 1,
        stock: 0,
        viewCount: 0,
        status: "a",
        tags: [],
      })
      expect(mockUpdateItem).toHaveBeenCalledOnce()
    }).pipe(Effect.provide(TestLayer)),
  )
})

describe("BoundPatch", () => {
  it.effect(".patch(key).set(...) executes with attribute_exists condition", () =>
    Effect.gen(function* () {
      mockUpdateItem.mockResolvedValueOnce({ Attributes: buildAttributes("p-1") })
      const db = yield* DynamoClient.make({
        entities: { Product: ProductEntity },
        tables: { MainTable },
      })
      yield* db.entities.Product.patch({ productId: "p-1" }).set({ name: "Patched" })

      const call = mockUpdateItem.mock.calls[0]![0]
      expect(call.ConditionExpression).toContain("attribute_exists")
    }).pipe(Effect.provide(TestLayer)),
  )
})

// ---------------------------------------------------------------------------
// BoundAppend — fluent .remove() chain (issue #49)
// ---------------------------------------------------------------------------

class TelemetryFixture extends Schema.Class<TelemetryFixture>("TelemetryFixture")({
  channel: Schema.String,
  deviceId: Schema.String,
  timestamp: Schema.DateTimeUtc,
  location: Schema.optional(Schema.String),
  alert: Schema.optional(Schema.Boolean),
  accountId: Schema.optional(Schema.String),
}) {}

const TelemetryFixtureAppendInput = Schema.Struct({
  channel: Schema.String,
  deviceId: Schema.String,
  timestamp: Schema.DateTimeUtc,
  location: Schema.optional(Schema.String),
  alert: Schema.optional(Schema.Boolean),
})

const TelemetryFixtureEntity = Entity.make({
  model: TelemetryFixture,
  entityType: "TelemetryFixture",
  primaryKey: {
    pk: { field: "pk", composite: ["channel", "deviceId"] },
    sk: { field: "sk", composite: [] },
  },
  timeSeries: {
    orderBy: "timestamp",
    appendInput: TelemetryFixtureAppendInput,
  },
})

const TelemetryFixtureTable = Table.make({
  schema: AppSchema,
  entities: { TelemetryFixture: TelemetryFixtureEntity },
})

const mockTransactWriteItems = vi.fn()
const mockGetItemTs = vi.fn()

const TestClientTs = Layer.succeed(DynamoClient, {
  putItem: () => Effect.die("not used"),
  getItem: (input) =>
    Effect.tryPromise({
      try: () => mockGetItemTs(input),
      catch: (e) => new DynamoError({ operation: "GetItem", cause: e }),
    }),
  deleteItem: () => Effect.die("not used"),
  updateItem: () => Effect.die("not used"),
  query: () => Effect.die("not used"),
  scan: () => Effect.die("not used"),
  batchGetItem: () => Effect.die("not used"),
  batchWriteItem: () => Effect.die("not used"),
  transactGetItems: () => Effect.die("not used"),
  transactWriteItems: (input) =>
    Effect.tryPromise({
      try: () => mockTransactWriteItems(input),
      catch: (e) => new DynamoError({ operation: "TransactWriteItems", cause: e }),
    }),
  createTable: () => Effect.die("not used"),
  deleteTable: () => Effect.die("not used"),
  describeTable: () => Effect.die("not used"),
})

const TableLayerTs = TelemetryFixtureTable.layer({ name: "bound-append-test-table" })
const TestLayerTs = Layer.merge(TestClientTs, TableLayerTs)

const mockHappyPathTs = () => {
  mockTransactWriteItems.mockResolvedValueOnce({})
  mockGetItemTs.mockResolvedValueOnce({
    Item: {
      pk: { S: "$testapp#v1#telemetryfixture#c-1#d-7" },
      sk: { S: "$testapp#v1#telemetryfixture_1" },
      channel: { S: "c-1" },
      deviceId: { S: "d-7" },
      timestamp: { S: "2026-04-22T10:00:00.000Z" },
      __edd_e__: { S: "TelemetryFixture" },
    },
  })
}

describe("BoundAppend", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it.effect(".append(input).remove([...]) chain emits REMOVE clause", () =>
    Effect.gen(function* () {
      mockHappyPathTs()
      const db = yield* DynamoClient.make({
        entities: { TelemetryFixture: TelemetryFixtureEntity },
        tables: { TelemetryFixtureTable },
      })
      yield* db.entities.TelemetryFixture.append({
        channel: "c-1",
        deviceId: "d-7",
        timestamp: DateTime.makeUnsafe("2026-04-22T10:00:00.000Z"),
      }).remove(["alert"])

      const call = mockTransactWriteItems.mock.calls[0]![0]
      const expr = call.TransactItems[0].Update.UpdateExpression as string
      expect(expr).toMatch(/\bREMOVE\b/)
      const ean = call.TransactItems[0].Update.ExpressionAttributeNames
      expect(Object.values(ean)).toContain("alert")
    }).pipe(Effect.provide(TestLayerTs)),
  )

  it.effect(".remove() composes with .condition() and .skipFollowUp() in any order", () =>
    Effect.gen(function* () {
      mockTransactWriteItems.mockResolvedValueOnce({})
      // No mockGetItemTs — skipFollowUp must not call GetItem.

      const db = yield* DynamoClient.make({
        entities: { TelemetryFixture: TelemetryFixtureEntity },
        tables: { TelemetryFixtureTable },
      })
      const result = yield* db.entities.TelemetryFixture.append({
        channel: "c-1",
        deviceId: "d-7",
        timestamp: DateTime.makeUnsafe("2026-04-22T10:00:00.000Z"),
      })
        .condition({ eq: { location: "rack-1" } })
        .remove(["alert"])
        .skipFollowUp()

      expect(result).toBeUndefined()
      expect(mockGetItemTs).not.toHaveBeenCalled()

      const call = mockTransactWriteItems.mock.calls[0]![0]
      const cond = call.TransactItems[0].Update.ConditionExpression as string
      // CAS AND user condition.
      expect(cond).toContain("AND")
      const expr = call.TransactItems[0].Update.UpdateExpression as string
      expect(expr).toMatch(/\bREMOVE\b/)
    }).pipe(Effect.provide(TestLayerTs)),
  )

  it.effect("chained .remove() calls accumulate attribute names", () =>
    Effect.gen(function* () {
      mockHappyPathTs()
      const db = yield* DynamoClient.make({
        entities: { TelemetryFixture: TelemetryFixtureEntity },
        tables: { TelemetryFixtureTable },
      })
      yield* db.entities.TelemetryFixture.append({
        channel: "c-1",
        deviceId: "d-7",
        timestamp: DateTime.makeUnsafe("2026-04-22T10:00:00.000Z"),
      })
        .remove(["alert"])
        .remove(["location"])

      const ean = mockTransactWriteItems.mock.calls[0]![0].TransactItems[0].Update
        .ExpressionAttributeNames as globalThis.Record<string, string>
      const physical = new Set(Object.values(ean))
      expect(physical.has("alert")).toBe(true)
      expect(physical.has("location")).toBe(true)
    }).pipe(Effect.provide(TestLayerTs)),
  )
})
