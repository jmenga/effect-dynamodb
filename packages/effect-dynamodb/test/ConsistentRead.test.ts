/**
 * `.consistentRead()` is sent as asked (#144). DynamoDB rejects it on a GSI —
 * which it reads only eventually consistently — and the rejection is
 * diagnosed against the request into a `ValidationError` naming the index, on
 * every path that builds an index query: the bound entity accessors and
 * auto-discovered collections (`DynamoClient.make`), the unbound entity
 * accessors, and explicit `Collection.make` collections. A consistent read of
 * the table is sent and answered.
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
import {
  awsValidationException,
  DDB_CONSISTENT_READ_GSI,
  mockDynamoClientLayer,
} from "./helpers/MockDynamoClient.js"

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
  // DynamoDB's own rule, with its own message (observed on DynamoDB Local).
  mockQuery.mockImplementation(async (input: any) => {
    if (input.ConsistentRead === true && input.IndexName !== undefined) {
      throw awsValidationException(DDB_CONSISTENT_READ_GSI)
    }
    return { Items: [] }
  })
})

/** DynamoDB rejected the read, and the rejection was named. */
const refused = <R>(run: Effect.Effect<unknown, unknown, R>) =>
  Effect.gen(function* () {
    const error = (yield* Effect.flip(run)) as {
      readonly _tag: string
      readonly operation?: string
      readonly cause?: unknown
    }
    expect(error._tag).toBe("ValidationError")
    expect(error.operation).toBe("query.consistentRead")
    expect(String(error.cause)).toContain('index "gsi1" is a global secondary index')
  })

describe("consistentRead on a GSI is DynamoDB's to reject, and is named (#144)", () => {
  it.effect("bound entity accessors: DynamoDB's rejection on a GSI named; the table answered", () =>
    Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { Devices, Gateways, Orders, Lines },
        tables: { MainTable },
      })
      yield* refused(db.entities.Devices.bySite({ site: "s" }).consistentRead().collect())
      expect(mockQuery).toHaveBeenCalledTimes(1)
      yield* db.entities.Devices.primary({ deviceId: "d" }).consistentRead().collect()
      expect(mockQuery.mock.calls.map((call) => call[0].ConsistentRead)).toEqual([true, true])
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect(
    "auto-discovered collections: DynamoDB's rejection over a GSI named; the table answered",
    () =>
      Effect.gen(function* () {
        const db = yield* DynamoClient.make({
          entities: { Devices, Gateways, Orders, Lines },
          tables: { MainTable },
        })
        yield* refused(db.collections.Fleet!({ site: "s" }).consistentRead().collect())
        const sentToGsi = mockQuery.mock.calls.length
        expect(sentToGsi).toBeGreaterThan(0)
        yield* db.collections.OrderAll!({ orderId: "o" }).consistentRead().collect()
        const table = mockQuery.mock.calls.slice(sentToGsi)
        expect(table.length).toBeGreaterThan(0)
        expect(table.every((call) => call[0].ConsistentRead === true)).toBe(true)
        expect(table.every((call) => call[0].IndexName === undefined)).toBe(true)
      }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("unbound entity accessors: DynamoDB's rejection on a GSI named", () =>
    Effect.gen(function* () {
      yield* refused(
        Devices.query.bySite!({ site: "s" }).pipe(Query.consistentRead(), Query.collect),
      )
      yield* Devices.query.bySite!({ site: "s" }).pipe(Query.collect)
      expect(mockQuery).toHaveBeenCalledTimes(2)
      expect(mockQuery.mock.calls[1]![0].ConsistentRead).toBeUndefined()
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect(
    "explicit collections: DynamoDB's rejection named, for the query and every member",
    () =>
      Effect.gen(function* () {
        const Fleet = Collection.make("Fleet", { Devices, Gateways })
        yield* refused(Fleet.query({ site: "s" }).pipe(Query.consistentRead(), Query.collect))
        yield* refused(Fleet.Devices({ site: "s" }).pipe(Query.consistentRead(), Query.collect))
        yield* refused(Fleet.Gateways({ site: "s" }).pipe(Query.consistentRead(), Query.collect))
        expect(mockQuery).toHaveBeenCalledTimes(3)
        yield* Fleet.query({ site: "s" }).pipe(Query.collect)
        expect(mockQuery.mock.calls[3]![0].IndexName).toBe("gsi1")
      }).pipe(Effect.provide(TestLayer)),
  )
})
