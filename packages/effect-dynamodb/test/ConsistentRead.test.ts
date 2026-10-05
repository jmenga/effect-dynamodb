/**
 * `.consistentRead()` is refused on a GSI — which DynamoDB reads only
 * eventually consistently — and sent on the table (#133). Every place that
 * builds an index query says which kind of index it reads: the bound entity
 * accessors and auto-discovered collections (`DynamoClient.make`), the unbound
 * entity accessors, and explicit `Collection.make` collections.
 */
import { describe, expect, it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { DynamoError } from "@effect-dynamodb/schema/Errors.js"
import { Effect, Layer, Schema } from "effect"
import { beforeEach, vi } from "vitest"
import * as Collection from "../src/Collection.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Query from "../src/Query.js"
import * as Table from "../src/Table.js"
import { mockDynamoClientLayer } from "./helpers/MockDynamoClient.js"

const AppSchema = DynamoSchema.make({ name: "cr", version: 1 })

class Device extends Schema.Class<Device>("Device")({
  deviceId: Schema.String,
  site: Schema.String,
}) {}
class Gateway extends Schema.Class<Gateway>("Gateway")({
  gatewayId: Schema.String,
  site: Schema.String,
}) {}
class Order extends Schema.Class<Order>("Order")({ orderId: Schema.String }) {}
class Line extends Schema.Class<Line>("Line")({ orderId: Schema.String, lineId: Schema.String }) {}

const Devices = Entity.make({
  model: Device,
  entityType: "Device",
  primaryKey: { pk: { field: "pk", composite: ["deviceId"] }, sk: { field: "sk", composite: [] } },
  indexes: {
    bySite: {
      name: "gsi1",
      collection: "Fleet",
      pk: { field: "gsi1pk", composite: ["site"] },
      sk: { field: "gsi1sk", composite: ["deviceId"] },
    },
  },
})
const Gateways = Entity.make({
  model: Gateway,
  entityType: "Gateway",
  primaryKey: { pk: { field: "pk", composite: ["gatewayId"] }, sk: { field: "sk", composite: [] } },
  indexes: {
    bySite: {
      name: "gsi1",
      collection: "Fleet",
      pk: { field: "gsi1pk", composite: ["site"] },
      sk: { field: "gsi1sk", composite: ["gatewayId"] },
    },
  },
})
const Orders = Entity.make({
  model: Order,
  entityType: "Order",
  primaryKey: {
    collection: "OrderAll",
    type: "isolated",
    pk: { field: "pk", composite: ["orderId"] },
    sk: { field: "sk", composite: [] },
  },
})
const Lines = Entity.make({
  model: Line,
  entityType: "Line",
  primaryKey: {
    collection: "OrderAll",
    type: "isolated",
    pk: { field: "pk", composite: ["orderId"] },
    sk: { field: "sk", composite: ["lineId"] },
  },
})

const MainTable = Table.make({ schema: AppSchema, entities: { Devices, Gateways, Orders, Lines } })

const mockQuery = vi.fn()
const TestLayer = Layer.merge(
  mockDynamoClientLayer({
    query: (input) =>
      Effect.tryPromise({
        try: () => mockQuery(input),
        catch: (e) => new DynamoError({ operation: "Query", cause: e }),
      }),
  }),
  MainTable.layer({ name: "cr-table" }),
)

beforeEach(() => {
  mockQuery.mockReset()
  mockQuery.mockResolvedValue({ Items: [] })
})

const refused = <R>(run: Effect.Effect<unknown, unknown, R>) =>
  Effect.gen(function* () {
    const error = (yield* Effect.flip(run)) as { readonly _tag: string }
    expect(error._tag).toBe("ValidationError")
  })

describe("consistentRead on a GSI is refused before sending (#133)", () => {
  it.effect("bound entity accessors: refused on a GSI, sent on the table", () =>
    Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { Devices, Gateways, Orders, Lines },
        tables: { MainTable },
      })
      yield* refused(db.entities.Devices.bySite({ site: "s" }).consistentRead().collect())
      expect(mockQuery).not.toHaveBeenCalled()
      yield* db.entities.Devices.primary({ deviceId: "d" }).consistentRead().collect()
      expect(mockQuery.mock.calls[0]![0].ConsistentRead).toBe(true)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("auto-discovered collections: refused over a GSI, sent over the table", () =>
    Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { Devices, Gateways, Orders, Lines },
        tables: { MainTable },
      })
      yield* refused(db.collections.Fleet!({ site: "s" }).consistentRead().collect())
      expect(mockQuery).not.toHaveBeenCalled()
      yield* db.collections.OrderAll!({ orderId: "o" }).consistentRead().collect()
      expect(mockQuery.mock.calls[0]![0].ConsistentRead).toBe(true)
      expect(mockQuery.mock.calls[0]![0].IndexName).toBeUndefined()
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("unbound entity accessors: refused on a GSI", () =>
    Effect.gen(function* () {
      yield* refused(
        Devices.query.bySite!({ site: "s" }).pipe(Query.consistentRead(), Query.collect),
      )
      expect(mockQuery).not.toHaveBeenCalled()
      yield* Devices.query.bySite!({ site: "s" }).pipe(Query.collect)
      expect(mockQuery).toHaveBeenCalledTimes(1)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("explicit collections: refused over a GSI, for the query and every member", () =>
    Effect.gen(function* () {
      const Fleet = Collection.make("Fleet", { Devices, Gateways })
      yield* refused(Fleet.query({ site: "s" }).pipe(Query.consistentRead(), Query.collect))
      yield* refused(Fleet.Devices({ site: "s" }).pipe(Query.consistentRead(), Query.collect))
      yield* refused(Fleet.Gateways({ site: "s" }).pipe(Query.consistentRead(), Query.collect))
      expect(mockQuery).not.toHaveBeenCalled()
      yield* Fleet.query({ site: "s" }).pipe(Query.collect)
      expect(mockQuery.mock.calls[0]![0].IndexName).toBe("gsi1")
    }).pipe(Effect.provide(TestLayer)),
  )
})
