/**
 * Aggregate assembly against the base table (issue #93).
 *
 * Assembly reads the whole partition with a bare `pk = :pk` condition and
 * discriminates items by `__edd_e__`, so it issues no sort-key condition and
 * depends on no ordering. When the aggregate is keyed on the table's primary
 * partition key, that query needs no secondary index — `collection.index` is
 * optional, and omitting it also stops the collection SK mirror attribute from
 * being written on every item.
 *
 * Because the base table can serve strongly consistent reads (a GSI cannot),
 * omitting the index also unlocks opt-in `consistentRead`.
 */
import { describe, expect, it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { DynamoError } from "@effect-dynamodb/schema/Errors.js"
import { Effect, Layer, Schema } from "effect"
import { beforeEach, vi } from "vitest"
import * as Aggregate from "../src/Aggregate.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import { fromAttributeMap, toAttributeMap } from "../src/Marshaller.js"
import * as Table from "../src/Table.js"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const AppSchema = DynamoSchema.make({ name: "myapp", version: 1 })

class LineItem extends Schema.Class<LineItem>("LineItem")({
  sku: Schema.String.pipe(DynamoModel.identifier),
  qty: Schema.Number,
}) {}

class OrderLine extends Schema.Class<OrderLine>("OrderLine")({
  id: Schema.String,
  sku: Schema.String,
  qty: Schema.Number,
}) {}

class Order extends Schema.Class<Order>("Order")({
  id: Schema.String,
  customer: Schema.String,
  lines: Schema.Array(OrderLine),
}) {}

const LineItemEntity = Entity.make({
  model: LineItem,
  entityType: "LineItem",
  primaryKey: {
    pk: { field: "pk", composite: ["sku"] },
    sk: { field: "sk", composite: [] },
  },
})

const MainTable = Table.make({
  schema: AppSchema,
  entities: { LineItemEntity },
})

/** Table whose primary PK is NOT "pk" — used to exercise the GSI-shaped branch. */
const AltEntity = Entity.make({
  model: LineItem,
  entityType: "AltLineItem",
  primaryKey: {
    pk: { field: "altpk", composite: ["sku"] },
    sk: { field: "altsk", composite: [] },
  },
})

const AltTable = Table.make({ schema: AppSchema, entities: { AltEntity } })

// ---------------------------------------------------------------------------
// Mock client
// ---------------------------------------------------------------------------

const mockQuery = vi.fn()
const mockTransactWrite = vi.fn()

const TestDynamoClient = Layer.succeed(DynamoClient, {
  query: (input) =>
    Effect.tryPromise({
      try: () => mockQuery(input),
      catch: (e) => new DynamoError({ operation: "Query", cause: e }),
    }),
  transactWriteItems: (input) =>
    Effect.tryPromise({
      try: () => mockTransactWrite(input),
      catch: (e) => new DynamoError({ operation: "TransactWriteItems", cause: e }),
    }),
  putItem: () => Effect.die("not used"),
  getItem: () => Effect.die("not used"),
  deleteItem: () => Effect.die("not used"),
  updateItem: () => Effect.die("not used"),
  batchGetItem: () => Effect.die("not used"),
  batchWriteItem: () => Effect.die("not used"),
  transactGetItems: () => Effect.die("not used"),
  createTable: () => Effect.die("not used"),
  deleteTable: () => Effect.die("not used"),
  describeTable: () => Effect.die("not used"),
  scan: () => Effect.die("not used"),
})

const TestLayer = Layer.merge(TestDynamoClient, MainTable.layer({ name: "test-table" }))

const baseAggregateConfig = {
  table: MainTable,
  schema: AppSchema,
  pk: { field: "pk", composite: ["id"] as const },
  root: { entityType: "OrderRoot" },
  edges: {
    lines: Aggregate.many("lines", { entityType: "OrderLine" }),
  },
}

/** Aggregate with no collection index — assembles off the base table. */
const BaseTableOrder = Aggregate.make(Order, {
  ...baseAggregateConfig,
  collection: { name: "order" },
})

/** Same aggregate, but reading strongly consistently. */
const ConsistentOrder = Aggregate.make(Order, {
  ...baseAggregateConfig,
  collection: { name: "order" },
  consistentRead: true,
})

/** Legacy shape — collection served by an LSI. */
const IndexedOrder = Aggregate.make(Order, {
  ...baseAggregateConfig,
  collection: { index: "lsi1", name: "order", sk: { field: "lsi1sk", composite: [] } },
})

const orderPartition = [
  toAttributeMap({
    id: "o-1",
    customer: "acme",
    pk: "$myapp#v1#order#o-1",
    sk: "$myapp#v1#orderroot",
    __edd_e__: "OrderRoot",
  }),
  toAttributeMap({
    id: "l-1",
    sku: "widget",
    qty: 2,
    pk: "$myapp#v1#order#o-1",
    sk: "$myapp#v1#orderline#l-1",
    __edd_e__: "OrderLine",
  }),
]

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Aggregate — base-table assembly", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe("read path", () => {
    it.effect("omits IndexName when no collection index is configured", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValueOnce({ Items: orderPartition, LastEvaluatedKey: undefined })

        const result = yield* BaseTableOrder.get({ id: "o-1" })

        expect(result.customer).toBe("acme")
        expect(result.lines).toHaveLength(1)

        const input = mockQuery.mock.calls[0]![0]
        expect(input.IndexName).toBeUndefined()
        expect(input.TableName).toBe("test-table")
        expect(input.KeyConditionExpression).toBe("#pk = :pk")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("still sets IndexName when a collection index is configured", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValueOnce({ Items: orderPartition, LastEvaluatedKey: undefined })

        yield* IndexedOrder.get({ id: "o-1" })

        expect(mockQuery.mock.calls[0]![0].IndexName).toBe("lsi1")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("assembles identically with and without an index", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValueOnce({ Items: orderPartition, LastEvaluatedKey: undefined })
        const viaBaseTable = yield* BaseTableOrder.get({ id: "o-1" })

        mockQuery.mockResolvedValueOnce({ Items: orderPartition, LastEvaluatedKey: undefined })
        const viaIndex = yield* IndexedOrder.get({ id: "o-1" })

        expect(viaBaseTable).toEqual(viaIndex)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("still paginates the whole partition without an index", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValueOnce({
          Items: [orderPartition[0]!],
          LastEvaluatedKey: toAttributeMap({ pk: "x", sk: "y" }),
        })
        mockQuery.mockResolvedValueOnce({
          Items: [orderPartition[1]!],
          LastEvaluatedKey: undefined,
        })

        const result = yield* BaseTableOrder.get({ id: "o-1" })

        expect(result.lines).toHaveLength(1)
        expect(mockQuery).toHaveBeenCalledTimes(2)
        expect(mockQuery.mock.calls[1]![0].IndexName).toBeUndefined()
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  describe("consistentRead", () => {
    it.effect("is off by default", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValueOnce({ Items: orderPartition, LastEvaluatedKey: undefined })

        yield* BaseTableOrder.get({ id: "o-1" })

        expect(mockQuery.mock.calls[0]![0].ConsistentRead).toBeUndefined()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("is passed through when enabled", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValueOnce({ Items: orderPartition, LastEvaluatedKey: undefined })

        yield* ConsistentOrder.get({ id: "o-1" })

        expect(mockQuery.mock.calls[0]![0].ConsistentRead).toBe(true)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("applies to every page of a paginated assembly", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValueOnce({
          Items: [orderPartition[0]!],
          LastEvaluatedKey: toAttributeMap({ pk: "x", sk: "y" }),
        })
        mockQuery.mockResolvedValueOnce({
          Items: [orderPartition[1]!],
          LastEvaluatedKey: undefined,
        })

        yield* ConsistentOrder.get({ id: "o-1" })

        expect(mockQuery.mock.calls[0]![0].ConsistentRead).toBe(true)
        expect(mockQuery.mock.calls[1]![0].ConsistentRead).toBe(true)
      }).pipe(Effect.provide(TestLayer)),
    )

    it("is allowed alongside an LSI-shaped collection index", () => {
      expect(() =>
        Aggregate.make(Order, {
          ...baseAggregateConfig,
          collection: { index: "lsi1", name: "order", sk: { field: "lsi1sk", composite: [] } },
          consistentRead: true,
        }),
      ).not.toThrow()
    })

    it("throws EDD-9042 when combined with a GSI-shaped collection index", () => {
      expect(() =>
        Aggregate.make(Order, {
          ...baseAggregateConfig,
          table: AltTable,
          collection: { index: "gsi2", name: "order", sk: { field: "gsi2sk", composite: [] } },
          consistentRead: true,
        }),
      ).toThrow(/EDD-9042/)
    })
  })

  describe("make() validation", () => {
    it("throws EDD-9041 when omitting the index on a non-primary partition key", () => {
      expect(() =>
        Aggregate.make(Order, {
          ...baseAggregateConfig,
          table: AltTable,
          collection: { name: "order" },
        }),
      ).toThrow(/EDD-9041/)
    })

    it("permits a GSI-shaped collection index without consistentRead", () => {
      expect(() =>
        Aggregate.make(Order, {
          ...baseAggregateConfig,
          table: AltTable,
          collection: { index: "gsi2", name: "order", sk: { field: "gsi2sk", composite: [] } },
        }),
      ).not.toThrow()
    })
  })

  describe("write path", () => {
    const writtenAttributes = () => {
      const input = mockTransactWrite.mock.calls[0]![0]
      return (input.TransactItems as Array<{ Put?: { Item: Record<string, unknown> } }>)
        .map((t) => t.Put?.Item)
        .filter((i): i is Record<string, unknown> => i !== undefined)
        .map((i) => fromAttributeMap(i as never))
    }

    const newOrder = {
      id: "o-2",
      customer: "globex",
      lines: [{ id: "l-1", sku: "widget", qty: 3 }],
    }

    it.effect("omits the collection SK mirror attribute when there is no index", () =>
      Effect.gen(function* () {
        mockTransactWrite.mockResolvedValueOnce({})

        yield* BaseTableOrder.create(newOrder)

        const items = writtenAttributes()
        expect(items.length).toBeGreaterThan(0)
        for (const item of items) {
          expect(item).not.toHaveProperty("lsi1sk")
          expect(item.pk).toBe("$myapp#v1#order#o-2")
        }
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("still writes the collection SK mirror when an index is configured", () =>
      Effect.gen(function* () {
        mockTransactWrite.mockResolvedValueOnce({})

        yield* IndexedOrder.create(newOrder)

        const items = writtenAttributes()
        for (const item of items) {
          expect(item).toHaveProperty("lsi1sk")
        }
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  describe("Table.definition", () => {
    it("emits no LSI and no collection SK attribute when the index is omitted", () => {
      const table = Table.make({
        schema: AppSchema,
        entities: { LineItemEntity },
        aggregates: { BaseTableOrder },
      })
      const result = Table.definition(table)

      expect(result.LocalSecondaryIndexes).toBeUndefined()
      expect(result.GlobalSecondaryIndexes).toBeUndefined()
      expect(result.AttributeDefinitions.map((a) => a.AttributeName)).toEqual(["pk", "sk"])
    })

    it("still emits the LSI when the index is configured", () => {
      const table = Table.make({
        schema: AppSchema,
        entities: { LineItemEntity },
        aggregates: { IndexedOrder },
      })
      const result = Table.definition(table)

      expect(result.LocalSecondaryIndexes).toHaveLength(1)
      expect(result.LocalSecondaryIndexes![0]!.IndexName).toBe("lsi1")
      expect(result.AttributeDefinitions.map((a) => a.AttributeName).sort()).toEqual([
        "lsi1sk",
        "pk",
        "sk",
      ])
    })
  })
})
