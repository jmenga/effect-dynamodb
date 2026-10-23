/**
 * Consumed-capacity reporting for geo operations (#174, design §9.2).
 *
 * - `nearby` fans out one Query per covering cell: one `GeoIndex.nearby`
 *   report summing every one of them.
 * - A bound `put` reports as `GeoIndex.put`, with the inner `Entity.put`
 *   nested; the unbound `put` returns the entity's put builder, so it reports
 *   as `Entity.put`.
 */

import { Effect, Layer, Schema } from "effect"
import { ConsumedCapacity, DynamoClient, DynamoSchema, Entity, Table } from "effect-dynamodb"
import { describe, expect, it } from "vitest"
import * as GeoIndex from "../src/GeoIndex.js"
import * as H3 from "../src/H3.js"

const AppSchema = DynamoSchema.make({ name: "geocap", version: 1 })

class Courier extends Schema.Class<Courier>("Courier")({
  courierId: Schema.String,
  latitude: Schema.optional(Schema.Number),
  longitude: Schema.optional(Schema.Number),
  timestamp: Schema.Number,
  cell: Schema.optional(Schema.String),
  parentCell: Schema.optional(Schema.String),
  timePartition: Schema.optional(Schema.String),
}) {}

const Couriers = Entity.make({
  model: Courier,
  entityType: "Courier",
  primaryKey: {
    pk: { field: "pk", composite: ["courierId"] },
    sk: { field: "sk", composite: [] },
  },
  indexes: {
    byCell: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["parentCell", "timePartition"] },
      sk: { field: "gsi1sk", composite: ["cell"] },
    },
  },
})

const MainTable = Table.make({ schema: AppSchema, entities: { Couriers } })

const CourierGeo = GeoIndex.make({
  entity: Couriers,
  index: "byCell",
  coordinates: (item) =>
    item.latitude !== undefined && item.longitude !== undefined
      ? { latitude: item.latitude, longitude: item.longitude }
      : undefined,
  fields: {
    cell: { field: "cell", resolution: 15 },
    parentCell: { field: "parentCell", resolution: 3 },
    timePartition: { field: "timePartition", source: "timestamp", bucket: "hourly" },
  },
})

const CENTER = { latitude: 51.5074, longitude: -0.1278 }
const NOW = 1_760_000_000_000

/** A client answering every Query empty and every PutItem, with capacity when asked. */
const makeClient = () => {
  const sent: Array<{ readonly command: string; readonly input: any }> = []
  const answer = (command: string, units: number, output: object) => (input: any) =>
    Effect.sync(() => {
      sent.push({ command, input })
      return (
        input.ReturnConsumedCapacity === undefined
          ? output
          : { ...output, ConsumedCapacity: { TableName: input.TableName, CapacityUnits: units } }
      ) as never
    })
  const unused = () => Effect.die(new Error("not used by this test"))
  const service = new Proxy(
    {
      query: answer("Query", 0.5, { Items: [], Count: 0 }),
      putItem: answer("PutItem", 1, {}),
    } as Record<string, unknown>,
    { get: (target, key) => (key in target ? target[key as string] : unused) },
  )
  return { layer: Layer.succeed(DynamoClient, service as never), sent }
}

const run = <A, E>(
  effect: Effect.Effect<A, E, DynamoClient | Table.TableConfig>,
  client: Layer.Layer<DynamoClient>,
) => {
  const reports: Array<ConsumedCapacity.OperationReport> = []
  const layer = Layer.mergeAll(
    client,
    MainTable.layer({ name: "couriers" }),
    ConsumedCapacity.layer({
      onOperation: (report) =>
        Effect.sync(() => {
          reports.push(report)
        }),
    }),
  )
  return Effect.runPromise(effect.pipe(Effect.provide(layer))).then(() => reports)
}

describe("GeoIndex consumed capacity", () => {
  it("nearby reports once, summing a Query per cell", async () => {
    const { layer, sent } = makeClient()
    const reports = await run(
      CourierGeo.nearby({
        center: CENTER,
        radius: 2000,
        unit: "m",
        timeWindow: { start: NOW - H3.HOURLY_BUCKET_MS, end: NOW },
      }),
      layer,
    )
    const queries = sent.filter((s) => s.command === "Query").length
    expect(queries).toBeGreaterThan(1)
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({
      operation: "GeoIndex.nearby",
      target: "Courier",
      requests: queries,
      requestsByCommand: { Query: queries },
      capacityUnits: queries * 0.5,
      unreportedRequests: 0,
      nested: [],
    })
  })

  it("a bound put reports as GeoIndex.put with Entity.put nested", async () => {
    const { layer } = makeClient()
    const reports = await run(
      Effect.gen(function* () {
        const bound = yield* GeoIndex.bind(CourierGeo)
        yield* bound.put({ courierId: "c-1", ...CENTER, timestamp: NOW })
      }),
      layer,
    )
    expect(reports.map((r) => r.operation)).toEqual(["GeoIndex.put"])
    expect(reports[0]).toMatchObject({ requests: 1, capacityUnits: 1 })
    expect(reports[0]!.nested.map((n) => [n.operation, n.calls])).toEqual([["Entity.put", 1]])
  })

  it("an unbound put reports as Entity.put", async () => {
    const { layer } = makeClient()
    const reports = await run(
      CourierGeo.put({ courierId: "c-1", ...CENTER, timestamp: NOW }).asEffect(),
      layer,
    )
    expect(reports.map((r) => r.operation)).toEqual(["Entity.put"])
  })

  it("sends no ReturnConsumedCapacity with reporting off", async () => {
    const { layer, sent } = makeClient()
    await Effect.runPromise(
      CourierGeo.nearby({
        center: CENTER,
        radius: 500,
        unit: "m",
        timeWindow: { start: NOW - H3.HOURLY_BUCKET_MS, end: NOW },
      }).pipe(Effect.provide(Layer.mergeAll(layer, MainTable.layer({ name: "couriers" })))),
    )
    expect(sent.length).toBeGreaterThan(0)
    expect(sent.every((s) => !Object.hasOwn(s.input, "ReturnConsumedCapacity"))).toBe(true)
  })
})
