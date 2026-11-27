/**
 * Time buckets other than hourly (#292): a geo index's partition width is any
 * `Duration`, resolved once by `GeoIndex.make` and used both to compose each
 * row's partition and to enumerate the partitions a search reads.
 */
import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { Duration, Effect, Layer, Schema } from "effect"
import { DynamoClient, DynamoSchema, Entity, Table } from "effect-dynamodb"
import { beforeEach, describe, expect, it } from "vitest"
import * as GeoIndex from "../src/GeoIndex.js"
import * as H3 from "../src/H3.js"

const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

class Sighting extends Schema.Class<Sighting>("Sighting")({
  sightingId: Schema.String,
  latitude: Schema.Number,
  longitude: Schema.Number,
  timestamp: Schema.Number,
  cell: Schema.optional(Schema.String),
  parentCell: Schema.optional(Schema.String),
  hourPartition: Schema.optional(Schema.String),
  dayPartition: Schema.optional(Schema.String),
}) {}

const Sightings = Entity.make({
  model: Sighting,
  entityType: "Sighting",
  primaryKey: {
    pk: { field: "pk", composite: ["sightingId"] },
    sk: { field: "sk", composite: [] },
  },
  indexes: {
    byHour: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["parentCell", "hourPartition"] },
      sk: { field: "gsi1sk", composite: ["cell"] },
    },
    byDay: {
      name: "gsi2",
      pk: { field: "gsi2pk", composite: ["parentCell", "dayPartition"] },
      sk: { field: "gsi2sk", composite: ["cell"] },
    },
  },
})

const MainTable = Table.make({
  schema: DynamoSchema.make({ name: "geobucket", version: 1 }),
  entities: { Sightings },
})

const coordinates = (item: { readonly latitude: number; readonly longitude: number }) => ({
  latitude: item.latitude,
  longitude: item.longitude,
})

const geoOf = (index: "byHour" | "byDay", bucket: GeoIndex.TimeBucket) =>
  GeoIndex.make({
    entity: Sightings,
    index,
    coordinates,
    fields: {
      cell: { field: "cell", resolution: 15 },
      parentCell: { field: "parentCell", resolution: 3 },
      timePartition: {
        field: index === "byHour" ? "hourPartition" : "dayPartition",
        source: "timestamp",
        bucket,
      },
    },
  })

const HourGeo = geoOf("byHour", "hourly")
const DayGeo = geoOf("byDay", "1 day")

// ---------------------------------------------------------------------------
// An in-memory table with two GSIs, recording every query
// ---------------------------------------------------------------------------

const INDEX_FIELDS: Record<string, { readonly pk: string; readonly sk: string }> = {
  gsi1: { pk: "gsi1pk", sk: "gsi1sk" },
  gsi2: { pk: "gsi2pk", sk: "gsi2sk" },
}

let rows: Map<string, Record<string, AttributeValue>>
let queries: Array<Record<string, any>>

const ClientLayer = Layer.succeed(
  DynamoClient,
  new Proxy(
    {
      putItem: (input: any) =>
        Effect.sync(() => {
          rows.set(`${input.Item.pk.S}|${input.Item.sk.S}`, input.Item)
          return {}
        }),
      query: (input: any) =>
        Effect.sync(() => {
          queries.push(input)
          const index = INDEX_FIELDS[input.IndexName as string]!
          const values = input.ExpressionAttributeValues as Record<string, AttributeValue>
          const items = [...rows.values()].filter((item) => {
            const sk = item[index.sk]?.S
            return (
              item[index.pk]?.S === values[":pk"]?.S &&
              sk !== undefined &&
              sk >= (values[":sk1"]?.S ?? "") &&
              sk <= (values[":sk2"]?.S ?? "")
            )
          })
          return { Items: items, Count: items.length }
        }),
    } as Record<string, unknown>,
    {
      get: (target, key) =>
        key in target
          ? target[key as string]
          : () => Effect.die(new Error(`unused: ${String(key)}`)),
    },
  ) as never,
)

const TestLayer = Layer.merge(ClientLayer, MainTable.layer({ name: "sightings" }))
const run = <A, E>(effect: Effect.Effect<A, E, DynamoClient | Table.TableConfig>) =>
  Effect.runPromise(effect.pipe(Effect.provide(TestLayer)))

const CENTER = { latitude: 48.8566, longitude: 2.3522 }
// 22h13m into its UTC day: a 24-hour window ending now starts in the day before.
const NOW = 1_700_000_000_000
const DAY_START = Math.floor(NOW / DAY_MS) * DAY_MS

/** Written through both indexes: `hourly.put(daily.enrich(input))`. */
const sight = (sightingId: string, timestamp: number, offset = 0) =>
  run(
    HourGeo.put(
      DayGeo.enrich({
        sightingId,
        latitude: CENTER.latitude + 0.0001 * offset,
        longitude: CENTER.longitude,
        timestamp,
      }),
    ).asEffect(),
  )

const ids = (results: ReadonlyArray<{ readonly item: { readonly sightingId: string } }>) =>
  results.map((r) => r.item.sightingId).sort()

/** The partition each query read: the number ending its partition key. */
const partitionsRead = () =>
  [
    ...new Set(queries.map((q) => String(q.ExpressionAttributeValues[":pk"].S).split("_").at(-1))),
  ].sort()

beforeEach(() => {
  rows = new Map()
  queries = []
})

describe("GeoIndex time buckets (#292)", () => {
  it("writes each index's own partition attribute, at its own width", async () => {
    await sight("s-1", NOW)
    const [row] = [...rows.values()]
    const hour = String(Math.floor(NOW / HOUR_MS))
    const day = String(Math.floor(NOW / DAY_MS))
    expect(row?.hourPartition?.S).toBe(hour)
    expect(row?.dayPartition?.S).toBe(day)
    expect(row?.gsi1pk?.S?.endsWith(`#hourpartition_${hour}`)).toBe(true)
    expect(row?.gsi2pk?.S?.endsWith(`#daypartition_${day}`)).toBe(true)
  })

  it("a 24-hour window on a daily index reads the two days it touches", async () => {
    const timeWindow = { start: NOW - DAY_MS, end: NOW }
    await run(DayGeo.nearby({ center: CENTER, radius: 500, timeWindow }))
    const dailyQueries = queries.length
    expect(partitionsRead()).toEqual([
      String(Math.floor((NOW - DAY_MS) / DAY_MS)),
      String(Math.floor(NOW / DAY_MS)),
    ])
    expect(queries.every((q) => q.IndexName === "gsi2")).toBe(true)

    // The same window on the hourly index reads 25 hours: the same cell
    // chunks, once per partition.
    queries = []
    await run(HourGeo.nearby({ center: CENTER, radius: 500, timeWindow }))
    expect(partitionsRead()).toHaveLength(25)
    expect(queries.length * 2).toBe(dailyQueries * 25)
  })

  it("keeps only the items in the window from the days it reads (#169)", async () => {
    // NOW - 30h is in the day before NOW's, which the window also reads.
    expect(Math.floor((NOW - 30 * HOUR_MS) / DAY_MS)).toBe(Math.floor((NOW - DAY_MS) / DAY_MS))
    await sight("s-20h", NOW - 20 * HOUR_MS, 0)
    await sight("s-30h", NOW - 30 * HOUR_MS, 1)
    await sight("s-today-late", DAY_START + DAY_MS - 1, 2)
    await sight("s-now", NOW, 3)

    const timeWindow = { start: NOW - DAY_MS, end: NOW }
    expect(ids(await run(DayGeo.nearby({ center: CENTER, radius: 500, timeWindow })))).toEqual([
      "s-20h",
      "s-now",
    ])
    // The hourly index finds the same items, reading 25 partitions to do it.
    expect(ids(await run(HourGeo.nearby({ center: CENTER, radius: 500, timeWindow })))).toEqual([
      "s-20h",
      "s-now",
    ])
  })

  it('"hourly" and a one-hour Duration send identical queries', async () => {
    const timeWindow = { start: NOW - 3 * HOUR_MS, end: NOW }
    const sent = async (bucket: GeoIndex.TimeBucket) => {
      queries = []
      await run(geoOf("byHour", bucket).nearby({ center: CENTER, radius: 2000, timeWindow }))
      return queries
    }
    const hourly = await sent("hourly")
    expect(hourly.length).toBeGreaterThan(0)
    expect(await sent(Duration.hours(1))).toEqual(hourly)
    expect(await sent("1 hour")).toEqual(hourly)
    expect(await sent(H3.HOURLY_BUCKET_MS)).toEqual(hourly)
  })
})
