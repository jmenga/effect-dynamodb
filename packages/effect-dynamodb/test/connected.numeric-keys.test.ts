/**
 * #171 E8: numeric composites in numeric order — connected tests against
 * DynamoDB Local. Negative, fractional and ≥ 1e38 bigint composites are
 * written through the entity, read back by key, ranged over with `.where()`
 * and `.within()`, and held unique; every range is compared against the
 * readings filtered and sorted numerically in JavaScript, so DynamoDB's own
 * byte order of the stored keys is what's under test.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 */

import { it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Config, Effect, Layer, Schema } from "effect"
import { afterAll, beforeAll, describe, expect } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"
import { inBound, type PriceBound } from "./helpers/ListingsFixture.js"

// ---------------------------------------------------------------------------
// Skip when DynamoDB Local isn't reachable
// ---------------------------------------------------------------------------

const ENDPOINT = Effect.runSync(
  Config.String("DYNAMODB_ENDPOINT").pipe(Config.withDefault("http://localhost:8000")),
)

let dynamoAvailable = false
try {
  const res = await fetch(ENDPOINT, { method: "POST", signal: AbortSignal.timeout(1000) }).catch(
    () => null,
  )
  dynamoAvailable = res !== null
} catch {
  dynamoAvailable = false
}

const describeConnected = dynamoAvailable ? describe : describe.skip

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

const AppSchema = DynamoSchema.make({ name: "numeric-conn", version: 1 })
const tableName = `numeric-conn-${Date.now()}`

class Reading extends Schema.Class<Reading>("Reading")({
  sensorId: Schema.String,
  level: Schema.BigInt,
  offset: Schema.Number,
  zone: Schema.Literals(["east", "north", "west"]),
  temperature: Schema.Number,
  note: Schema.String,
}) {}

const Readings = Entity.make({
  model: Reading,
  entityType: "Reading",
  primaryKey: {
    pk: { field: "pk", composite: ["sensorId", "level"] },
    sk: { field: "sk", composite: ["offset"] },
  },
  indexes: {
    // A numeric composite first, another after it: `.where()` and a key plan.
    byTemperature: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["sensorId"] },
      sk: { field: "gsi1sk", composite: ["temperature", "offset"] },
    },
    // Behind a literal: `.within()` on temperature skip-scans over the zones.
    byZone: {
      name: "gsi2",
      pk: { field: "gsi2pk", composite: ["sensorId"] },
      sk: { field: "gsi2sk", composite: ["zone", "temperature", "offset"] },
    },
    // A numeric skip tuple: `.within()` on zone probes each temperature.
    byTemperatureZone: {
      name: "gsi3",
      pk: { field: "gsi3pk", composite: ["sensorId"] },
      sk: { field: "gsi3sk", composite: ["temperature", "zone", "offset"] },
    },
  },
})

class Price extends Schema.Class<Price>("Price")({
  priceId: Schema.String,
  amount: Schema.Number,
}) {}

const Prices = Entity.make({
  model: Price,
  entityType: "Price",
  primaryKey: {
    pk: { field: "pk", composite: ["priceId"] },
    sk: { field: "sk", composite: [] },
  },
  unique: { amount: ["amount"] },
})

const MainTable = Table.make({ schema: AppSchema, entities: { Readings, Prices } })

const ClientLayer = DynamoClient.layer({
  region: "us-east-1",
  endpoint: ENDPOINT,
  credentials: { accessKeyId: "local", secretAccessKey: "local" },
})
const TestLayer = Layer.mergeAll(ClientLayer, MainTable.layer({ name: tableName }))
const provide = Effect.provide(TestLayer)

const SENSOR = "s-1"
const TEMPERATURES = [
  -(2 ** 53 - 1),
  -40.5,
  -10,
  -3.14,
  -3.1,
  -3,
  -0.5,
  -1e-7,
  0,
  1e-7,
  0.5,
  3,
  3.14,
  19.99,
  100.25,
  2 ** 53 - 1,
]
const ZONES = ["east", "north", "west"] as const
/** The partition's levels: a negative bigint, zero, and one past 1e38 (the `:` form). */
const LEVELS = [-5n, 0n, 10n ** 40n]

/** 48 readings: every temperature in every zone; offsets distinct, negative and fractional. */
const READINGS = TEMPERATURES.flatMap((temperature, t) =>
  ZONES.map((zone, z) => {
    const i = t * ZONES.length + z
    return new Reading({
      sensorId: SENSOR,
      level: LEVELS[i % LEVELS.length]!,
      offset: (i - 24) * 0.75,
      zone,
      temperature,
      note: `r-${i}`,
    })
  }),
)

/** Order by `keys` in turn, numbers numerically and strings by their bytes (ASCII here). */
const by = (keys: ReadonlyArray<"zone" | "temperature" | "offset">) => (a: Reading, b: Reading) => {
  for (const key of keys) {
    if (a[key] < b[key]) return -1
    if (a[key] > b[key]) return 1
  }
  return 0
}

const notes = (readings: ReadonlyArray<Reading>) => readings.map((r) => r.note)

const expected = (
  bound: PriceBound,
  field: "temperature" | "offset",
  order: ReadonlyArray<"zone" | "temperature" | "offset">,
  readings: ReadonlyArray<Reading> = READINGS,
) => notes(readings.filter((r) => inBound(bound, r[field])).sort(by(order)))

/** The bounds every range query is checked over: the 1.36 key order got each one wrong. */
const BOUNDS: ReadonlyArray<PriceBound> = [
  { between: [-3.14, 3] },
  { lt: -3 },
  { lte: -3 },
  { gt: -3.1 },
  { gte: 0 },
  { lt: 1e-7 },
  { gt: -1e-7 },
  { eq: -3.14 },
  { eq: 0.5 },
  { between: [-1e21, -3.05] },
  { between: [-0.5, 0.5] },
  { gte: 2e16 },
  { lte: -2e16 },
]

/** The `.where()` condition for a single-operator bound on `field`. */
const whereOf =
  (bound: PriceBound, field: "temperature" | "offset") =>
  (t: any, ops: any): unknown => {
    if ("eq" in bound) return ops.eq(t[field], bound.eq)
    if ("between" in bound) return ops.between(t[field], bound.between[0], bound.between[1])
    if (bound.gt !== undefined) return ops.gt(t[field], bound.gt)
    if (bound.gte !== undefined) return ops.gte(t[field], bound.gte)
    if (bound.lt !== undefined) return ops.lt(t[field], bound.lt)
    return ops.lte(t[field], bound.lte)
  }

describeConnected("#171 E8 numeric key order — connected", () => {
  beforeAll(async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* DynamoClient
        yield* client.createTable({
          TableName: tableName,
          BillingMode: "PAY_PER_REQUEST",
          ...Table.definition(MainTable),
        })
        const db = yield* DynamoClient.make({ entities: { Readings }, tables: { MainTable } })
        yield* Effect.forEach(READINGS, (reading) => db.entities.Readings.put(reading).asEffect(), {
          concurrency: 8,
        })
      }).pipe(provide),
    )
  }, 60_000)

  afterAll(async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* DynamoClient
        yield* client.deleteTable({ TableName: tableName })
      }).pipe(
        provide,
        Effect.catchTag("ResourceNotFoundError", () => Effect.void),
      ),
    )
  }, 30_000)

  it.effect("the index holds the readings in numeric order", () =>
    Effect.gen(function* () {
      const db = yield* DynamoClient.make({ entities: { Readings }, tables: { MainTable } })
      const all = yield* db.entities.Readings.byTemperature({ sensorId: SENSOR }).collect()
      expect(notes(all)).toEqual(notes([...READINGS].sort(by(["temperature", "offset"]))))
    }).pipe(provide),
  )

  it.effect(".where() over a negative and fractional composite, forward and reverse", () =>
    Effect.gen(function* () {
      const db = yield* DynamoClient.make({ entities: { Readings }, tables: { MainTable } })
      for (const bound of BOUNDS) {
        const want = expected(bound, "temperature", ["temperature", "offset"])
        const query = db.entities.Readings.byTemperature({ sensorId: SENSOR }).where(
          whereOf(bound, "temperature") as never,
        )
        expect(notes(yield* query.collect()), JSON.stringify(bound)).toEqual(want)
        expect(notes(yield* query.reverse().collect()), JSON.stringify(bound)).toEqual(
          [...want].reverse(),
        )
      }
    }).pipe(provide),
  )

  it.effect(".within() — a key plan and a skip-scan — over the same bounds", () =>
    Effect.gen(function* () {
      const db = yield* DynamoClient.make({ entities: { Readings }, tables: { MainTable } })
      for (const bound of BOUNDS) {
        const context = JSON.stringify(bound)
        const keyPlan = db.entities.Readings.byTemperature({ sensorId: SENSOR }).within({
          temperature: bound,
        } as never)
        expect((yield* keyPlan.explain()).plan, context).toBe("key")
        expect(notes(yield* keyPlan.collect()), context).toEqual(
          expected(bound, "temperature", ["temperature", "offset"]),
        )
        const skipScan = db.entities.Readings.byZone({ sensorId: SENSOR }).within({
          temperature: bound,
        } as never)
        expect((yield* skipScan.explain()).plan, context).toBe("skip-scan")
        const want = expected(bound, "temperature", ["zone", "temperature", "offset"])
        expect(notes(yield* skipScan.collect()), context).toEqual(want)
        expect(notes(yield* skipScan.reverse().collect()), context).toEqual([...want].reverse())
      }
    }).pipe(provide),
  )

  it.effect(".within() skip-scans a numeric skip tuple", () =>
    Effect.gen(function* () {
      const db = yield* DynamoClient.make({ entities: { Readings }, tables: { MainTable } })
      for (const zone of ZONES) {
        const query = db.entities.Readings.byTemperatureZone({ sensorId: SENSOR }).within(
          { zone: { eq: zone } },
          { maxSkips: 1000 },
        )
        expect((yield* query.explain()).plan, zone).toBe("skip-scan")
        const want = notes(
          READINGS.filter((r) => r.zone === zone).sort(by(["temperature", "zone", "offset"])),
        )
        expect(notes(yield* query.collect()), zone).toEqual(want)
        expect(notes(yield* query.reverse().collect()), zone).toEqual([...want].reverse())
      }
    }).pipe(provide),
  )

  it.effect(".where() on a primary sort key under a bigint partition composite", () =>
    Effect.gen(function* () {
      const db = yield* DynamoClient.make({ entities: { Readings }, tables: { MainTable } })
      for (const level of LEVELS) {
        const partition = READINGS.filter((r) => r.level === level)
        for (const bound of BOUNDS) {
          const got = yield* db.entities.Readings.primary({ sensorId: SENSOR, level })
            .where(whereOf(bound, "offset") as never)
            .collect()
          expect(notes(got), `${level} ${JSON.stringify(bound)}`).toEqual(
            expected(bound, "offset", ["offset"], partition),
          )
        }
      }
    }).pipe(provide),
  )

  it.effect("get, update and delete address negative, fractional and ≥ 1e38 composites", () =>
    Effect.gen(function* () {
      const db = yield* DynamoClient.make({ entities: { Readings }, tables: { MainTable } })
      const extra = [
        { level: -5n, offset: -3.14 },
        { level: 10n ** 40n, offset: 0.1 },
        { level: -(10n ** 40n), offset: -(2 ** 53 - 1) },
      ]
      for (const { level, offset } of extra) {
        const key = { sensorId: "s-2", level, offset }
        const context = `${level} ${offset}`
        yield* db.entities.Readings.put({
          ...key,
          zone: "east",
          temperature: offset,
          note: "first",
        })
        const got = yield* db.entities.Readings.get(key)
        expect(got.level, context).toBe(level)
        expect(got.offset, context).toBe(offset)
        expect(got.note, context).toBe("first")
        const updated = yield* db.entities.Readings.update(key).set({ note: "second" })
        expect(updated.note, context).toBe("second")
        expect((yield* db.entities.Readings.get(key)).note, context).toBe("second")
        yield* db.entities.Readings.delete(key)
        const error = yield* db.entities.Readings.get(key).asEffect().pipe(Effect.flip)
        expect(error._tag, context).toBe("ItemNotFound")
      }
    }).pipe(provide),
  )

  it.effect("unique constraints hold on decimal and negative values", () =>
    Effect.gen(function* () {
      const db = yield* DynamoClient.make({ entities: { Prices }, tables: { MainTable } })
      const put = (priceId: string, amount: number) =>
        db.entities.Prices.put({ priceId, amount }).asEffect()
      yield* put("p-1", 19.99)
      yield* put("p-2", 19.9)
      yield* put("p-3", -19.99)
      yield* put("p-4", 0.1 + 0.2)
      yield* put("p-5", 0.3)
      for (const [priceId, amount] of [
        ["p-6", 19.99],
        ["p-7", -19.99],
        ["p-8", 0.30000000000000004],
      ] as const) {
        const error = yield* put(priceId, amount).pipe(Effect.flip)
        expect(error._tag, String(amount)).toBe("UniqueConstraintViolation")
      }
      // Moving a value frees its sentinel: 19.99 can be taken again.
      yield* db.entities.Prices.update({ priceId: "p-1" }).set({ amount: 20.5 })
      yield* put("p-9", 19.99)
    }).pipe(provide),
  )
})
