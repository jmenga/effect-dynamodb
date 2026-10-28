/**
 * Numeric composites in numeric order (#171 E8). Negative, fractional and
 * very large numbers compose key text that DynamoDB's byte order sorts
 * numerically, so `.where()` and `.within()` ranges over them return the rows
 * the bound means, in numeric order; and every key path — put, get, update,
 * delete, unique sentinels — composes the same text for the same value.
 *
 * Index reads are served by `PartitionMock`, which orders sort keys by their
 * UTF-8 bytes as DynamoDB does; the expected rows are computed numerically,
 * not from the keys.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { describe, expect, it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Effect, Layer, Schema } from "effect"
import * as Batch from "../src/Batch.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"
import * as Transaction from "../src/Transaction.js"
import {
  inBound,
  type ListingItem,
  type Listings,
  makeListings,
  type PriceBound,
  random,
  STORE,
} from "./helpers/ListingsFixture.js"
import { mockDynamoClient } from "./helpers/MockDynamoClient.js"

const ids = (items: ReadonlyArray<{ readonly listingId: string }>) =>
  items.map((item) => item.listingId)

/**
 * Prices across the numeric key forms a stored `number` reaches: negatives,
 * fractions, integers up to `MAX_SAFE_INTEGER` (the marshaller refuses a
 * larger `number` attribute; `NumericKey.test.ts` orders the ≥ 1e16 forms).
 */
const PRICES = [
  -(2 ** 53 - 1),
  -1000,
  -100.5,
  -10,
  -5,
  -4,
  -3.14,
  -3.1,
  -3,
  -0.5,
  -1e-7,
  0,
  1e-7,
  0.5,
  3,
  3.1,
  3.14,
  4,
  10,
  10.5,
  19.99,
  100,
  2 ** 53 - 1,
]
/** Bound operands: every price, values between them, and ≥ 1e16 forms beyond them. */
const OPERANDS = [...PRICES, -3.05, -0.25, 0.25, 3.05, 15, -15, -2e16, 2e16, -1e21, 1e21]

/** Two listings per price, under each status, shuffled. */
const listingsOf = (statuses: ReadonlyArray<string>, seed: number): Array<ListingItem> => {
  const items = statuses.flatMap((status, s) =>
    PRICES.flatMap((price, p) =>
      ["a", "b"].map((suffix) => ({
        storeId: STORE,
        listingId: `l-${s}-${String(p).padStart(2, "0")}-${suffix}`,
        status,
        price,
      })),
    ),
  )
  const next = random(seed)
  return items
    .map((item) => ({ item, at: next() }))
    .sort((a, b) => a.at - b.at)
    .map(({ item }) => item)
}

/** Index order computed from the values: by `keys` in turn, numbers numerically. */
const numericOrder =
  (keys: ReadonlyArray<"status" | "price" | "listingId">) => (a: ListingItem, b: ListingItem) => {
    for (const key of keys) {
      const x = a[key]
      const y = b[key]
      if (x < y) return -1
      if (x > y) return 1
    }
    return 0
  }

const run = <X>(
  fixture: Listings,
  items: ReadonlyArray<ListingItem>,
  f: (accessor: (pins: object) => any) => Effect.Effect<X, unknown, any>,
): Effect.Effect<X, unknown> => {
  const { layer } = fixture.serve(items)
  return Effect.gen(function* () {
    const listings = yield* fixture.listings
    return yield* f((pins) => listings[fixture.accessor](pins))
  }).pipe(Effect.provide(layer)) as Effect.Effect<X, unknown>
}

/** A random bound over {@link OPERANDS}. */
const randomBound = (next: () => number): PriceBound => {
  const pick = () => OPERANDS[Math.floor(next() * OPERANDS.length)]!
  const [a, b] = [pick(), pick()].sort((x, y) => x - y) as [number, number]
  switch (Math.floor(next() * 6)) {
    case 0:
      return { eq: PRICES[Math.floor(next() * PRICES.length)]! }
    case 1:
      return { between: [a, b] }
    case 2:
      return { gte: a }
    case 3:
      return { lt: b }
    case 4:
      return { gt: a }
    default:
      return { lte: b }
  }
}

/** The `.where()` condition for a single-operator bound. */
const whereOf =
  (bound: PriceBound) =>
  (t: any, ops: any): unknown => {
    if ("eq" in bound) return ops.eq(t.price, bound.eq)
    if ("between" in bound) return ops.between(t.price, bound.between[0], bound.between[1])
    if (bound.gt !== undefined) return ops.gt(t.price, bound.gt)
    if (bound.gte !== undefined) return ops.gte(t.price, bound.gte)
    if (bound.lt !== undefined) return ops.lt(t.price, bound.lt)
    return ops.lte(t.price, bound.lte)
  }

describe("numeric key order (#171 E8)", () => {
  it("index order is numeric order", () => {
    const fixture = makeListings({ sk: ["price", "listingId"] })
    const items = listingsOf(["active"], 1)
    expect(ids(fixture.ordered(items))).toEqual(
      ids([...items].sort(numericOrder(["price", "listingId"]))),
    )
  })

  it.effect(".where() ranges over negative, fractional and large prices", () =>
    Effect.gen(function* () {
      for (const casing of ["lowercase", "uppercase", "preserve"] as const) {
        const fixture = makeListings({ sk: ["price", "listingId"], casing })
        const items = listingsOf(["active"], 2)
        const next = random(casing.length * 7919)
        for (let round = 0; round < 40; round++) {
          const bound = randomBound(next)
          const want = ids(
            items
              .filter((item) => inBound(bound, item.price))
              .sort(numericOrder(["price", "listingId"])),
          )
          const context = JSON.stringify({ casing, bound })
          const got = yield* run(fixture, items, (byStore) =>
            Effect.gen(function* () {
              const query = byStore({ storeId: STORE }).where(whereOf(bound))
              return {
                forward: ids(yield* query.collect()),
                reverse: ids(yield* query.reverse().collect()),
              }
            }),
          )
          expect(got.forward, context).toEqual(want)
          expect(got.reverse, context).toEqual([...want].reverse())
        }
      }
    }),
  )

  it.effect(".within() key plan and skip-scan over negative and fractional prices", () =>
    Effect.gen(function* () {
      const statuses = ["active", "pending", "sold"]
      const keyPlan = makeListings({ sk: ["price", "listingId"] })
      const skipScan = makeListings({ statuses })
      const next = random(4242)
      for (let round = 0; round < 40; round++) {
        const bound =
          round % 2 === 0
            ? randomBound(next)
            : (() => {
                const pick = () => OPERANDS[Math.floor(next() * OPERANDS.length)]!
                const [a, b] = [pick(), pick()].sort((x, y) => x - y) as [number, number]
                return { gt: a, lte: b }
              })()
        const reverse = next() < 0.5
        const context = JSON.stringify({ bound, reverse })
        for (const [fixture, items, order] of [
          [keyPlan, listingsOf(["active"], round), ["price", "listingId"]],
          [skipScan, listingsOf(statuses, round), ["status", "price", "listingId"]],
        ] as const) {
          const sorted = items
            .filter((item) => inBound(bound, item.price))
            .sort(numericOrder(order))
          const want = ids(reverse ? sorted.reverse() : sorted)
          const got = yield* run(fixture, items, (byStore) =>
            Effect.gen(function* () {
              const query = byStore({ storeId: STORE }).within({ price: bound })
              return {
                plan: (yield* query.explain()).plan,
                items: ids(yield* (reverse ? query.reverse() : query).collect()),
              }
            }),
          )
          expect(got.plan, context).toBe(fixture === keyPlan ? "key" : "skip-scan")
          expect(got.items, `${context} ${got.plan}`).toEqual(want)
        }
      }
    }),
  )

  it.effect("skip-scan over a numeric skip tuple parses and steps past each price", () =>
    Effect.gen(function* () {
      // `price` leads and is unbounded, so each distinct price is a skip
      // tuple: its text (`-`, `.`, `:` included) is parsed from the probed
      // key, and the next probe starts just past it.
      const statuses = ["active", "pending", "sold"]
      const fixture = makeListings({ statuses, sk: ["price", "status", "listingId"] })
      const items = listingsOf(statuses, 9)
      for (const status of statuses) {
        for (const reverse of [false, true]) {
          const sorted = items
            .filter((item) => item.status === status)
            .sort(numericOrder(["price", "status", "listingId"]))
          const want = ids(reverse ? sorted.reverse() : sorted)
          const got = yield* run(fixture, items, (byStore) =>
            Effect.gen(function* () {
              const query = byStore({ storeId: STORE }).within(
                { status: { eq: status } },
                { maxSkips: 1000 },
              )
              return {
                plan: (yield* query.explain()).plan,
                items: ids(yield* (reverse ? query.reverse() : query).collect()),
              }
            }),
          )
          expect(got.plan).toBe("skip-scan")
          expect(got.items, `${status} ${reverse}`).toEqual(want)
        }
      }
    }),
  )
})

// ---------------------------------------------------------------------------
// Primary-key round trip and unique sentinels
// ---------------------------------------------------------------------------

class Reading extends Schema.Class<Reading>("Reading")({
  sensorId: Schema.String,
  offset: Schema.Number,
  level: Schema.BigInt,
  value: Schema.Number,
}) {}

const AppSchema = DynamoSchema.make({ name: "numeric-keys", version: 1 })
const Readings = Entity.make({
  model: Reading,
  entityType: "Reading",
  primaryKey: {
    pk: { field: "pk", composite: ["sensorId", "level"] },
    sk: { field: "sk", composite: ["offset"] },
  },
  unique: { value: ["value"] },
})
const MainTable = Table.make({ schema: AppSchema, entities: { Readings } })

type Captured = {
  writes: Array<Record<string, AttributeValue>>
  keys: Array<{ readonly op: string; readonly key: Record<string, AttributeValue> }>
}

const captureLayer = (captured: Captured) =>
  Layer.merge(
    Layer.succeed(
      DynamoClient,
      mockDynamoClient({
        putItem: (input) =>
          Effect.sync(() => {
            captured.writes.push(input.Item!)
            return {} as never
          }),
        transactWriteItems: (input) =>
          Effect.sync(() => {
            for (const item of input.TransactItems ?? []) {
              if (item.Put) captured.writes.push(item.Put.Item!)
              if (item.Update) captured.keys.push({ op: "update", key: item.Update.Key! })
              if (item.Delete) captured.keys.push({ op: "delete", key: item.Delete.Key! })
            }
            return {} as never
          }),
        getItem: (input) =>
          Effect.sync(() => {
            captured.keys.push({ op: "get", key: input.Key! })
            const item = captured.writes.find(
              (w) => w.pk?.S === input.Key!.pk?.S && w.sk?.S === input.Key!.sk?.S,
            )
            return (item === undefined ? {} : { Item: item }) as never
          }),
        updateItem: (input) =>
          Effect.sync(() => {
            captured.keys.push({ op: "update", key: input.Key! })
            const item = captured.writes.find(
              (w) => w.pk?.S === input.Key!.pk?.S && w.sk?.S === input.Key!.sk?.S,
            )
            return { Attributes: item } as never
          }),
        deleteItem: (input) =>
          Effect.sync(() => {
            captured.keys.push({ op: "delete", key: input.Key! })
            return {} as never
          }),
      }),
    ),
    MainTable.layer({ name: "readings" }),
  )

describe("numeric primary-key composites round-trip (#171 E8)", () => {
  const cases: ReadonlyArray<{
    readonly offset: number
    readonly level: bigint
    readonly sk: string
    readonly pk: string
  }> = [
    {
      offset: -3.14,
      level: -5n,
      sk: "$numeric-keys#v1#reading#offset_-9999999999999996.85:",
      pk: `$numeric-keys#v1#reading#sensorid_s-1#level_-${"9".repeat(37)}4:`,
    },
    {
      offset: 0.5,
      level: 10n ** 40n,
      sk: "$numeric-keys#v1#reading#offset_0000000000000000.5",
      pk: "$numeric-keys#v1#reading#sensorid_s-1#level_:0401",
    },
    {
      offset: -(2 ** 53 - 1),
      level: 42n,
      sk: "$numeric-keys#v1#reading#offset_-0992800745259008:",
      pk: `$numeric-keys#v1#reading#sensorid_s-1#level_${"0".repeat(36)}42`,
    },
  ]

  for (const { offset, level, sk, pk } of cases) {
    it.effect(`put, get, update and delete address offset ${offset}, level ${level}n`, () =>
      Effect.gen(function* () {
        const captured: Captured = { writes: [], keys: [] }
        const result = yield* Effect.gen(function* () {
          const db = yield* DynamoClient.make({
            entities: { Readings },
            tables: { MainTable },
          })
          const reading = { sensorId: "s-1", offset, level, value: 1 }
          yield* db.entities.Readings.put(reading)
          const got = yield* db.entities.Readings.get({ sensorId: "s-1", offset, level })
          yield* db.entities.Readings.update({ sensorId: "s-1", offset, level }).set({ value: 7 })
          yield* db.entities.Readings.delete({ sensorId: "s-1", offset, level })
          return got
        }).pipe(Effect.provide(captureLayer(captured)))

        const item = captured.writes.find((w) => w.pk?.S?.includes("#reading#sensorid_"))!
        expect(item.pk!.S).toBe(pk)
        expect(item.sk!.S).toBe(sk)
        expect(result.offset).toBe(offset)
        expect(result.level).toBe(level)
        // Every read and write of the item (the unique constraint adds reads
        // of the current item and transactions) addresses the key put wrote.
        const addressed = captured.keys.filter((k) => k.key.pk?.S?.includes("#sensorid_"))
        expect(new Set(addressed.map((k) => k.op))).toEqual(new Set(["get", "update", "delete"]))
        for (const { op, key } of addressed) {
          expect(key.pk!.S, op).toBe(pk)
          expect(key.sk!.S, op).toBe(sk)
        }
      }),
    )
  }

  it.effect("a unique decimal composes its sentinel in numeric key text", () =>
    Effect.gen(function* () {
      const captured: Captured = { writes: [], keys: [] }
      yield* Effect.gen(function* () {
        const db = yield* DynamoClient.make({ entities: { Readings }, tables: { MainTable } })
        yield* db.entities.Readings.put({ sensorId: "s-1", offset: 1, level: 1n, value: -19.99 })
      }).pipe(Effect.provide(captureLayer(captured)))
      const sentinel = captured.writes.find((w) => !w.pk?.S?.includes("#sensorid_"))!
      expect(sentinel.pk!.S).toContain("-9999999999999980.00:")
    }),
  )

  it.effect("[EDD-9096] put of a NaN key composite fails with ValidationError", () =>
    Effect.gen(function* () {
      const captured: Captured = { writes: [], keys: [] }
      const error = yield* Effect.gen(function* () {
        const db = yield* DynamoClient.make({ entities: { Readings }, tables: { MainTable } })
        return yield* Effect.flip(
          db.entities.Readings.put({
            sensorId: "s-1",
            offset: Number.NaN,
            level: 1n,
            value: 1,
          }).asEffect(),
        )
      }).pipe(Effect.provide(captureLayer(captured)))
      expect(error._tag).toBe("ValidationError")
      const cause = (error as { readonly cause: { readonly _tag: string; message: string } }).cause
      expect(cause._tag).toBe("KeyValueError")
      expect(cause.message).toContain("[EDD-9096]")
      expect(captured.writes).toHaveLength(0)
    }),
  )
})

// ---------------------------------------------------------------------------
// NaN has no key text: [EDD-9096] on every path that composes a key from it
// ---------------------------------------------------------------------------

class Gauge extends Schema.Class<Gauge>("Gauge")({
  gaugeId: Schema.String,
  slot: Schema.Number,
  score: Schema.Number,
}) {}
/** An index composite and the soft-delete lifecycle (`restore`, `purge`). */
const Gauges = Entity.make({
  model: Gauge,
  entityType: "Gauge",
  primaryKey: {
    pk: { field: "pk", composite: ["gaugeId"] },
    sk: { field: "sk", composite: ["slot"] },
  },
  indexes: {
    byScore: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["gaugeId"] },
      sk: { field: "gsi1sk", composite: ["score"] },
    },
  },
  softDelete: true,
})
const Badge = Schema.Struct({ badgeId: Schema.String, slot: Schema.Number, code: Schema.Number })
/** A numeric unique field, and the multi-item operations. */
const Badges = Entity.make({
  model: Badge,
  entityType: "Badge",
  primaryKey: {
    pk: { field: "pk", composite: ["badgeId"] },
    sk: { field: "sk", composite: ["slot"] },
  },
  unique: { code: ["code"] },
})
const Slot = Schema.Struct({ slotId: Schema.String, slot: Schema.Number })
/** Neither unique nor lifecycle: `Batch.write` takes it. */
const Slots = Entity.make({
  model: Slot,
  entityType: "Slot",
  primaryKey: {
    pk: { field: "pk", composite: ["slotId"] },
    sk: { field: "sk", composite: ["slot"] },
  },
})
const Meter = Schema.Struct({ meterId: Schema.String, at: Schema.Number, v: Schema.Number })
const Meters = Entity.make({
  model: Meter,
  entityType: "Meter",
  primaryKey: {
    pk: { field: "pk", composite: ["meterId"] },
    sk: { field: "sk", composite: [] },
  },
  timeSeries: { orderBy: "at", appendInput: Meter },
})
const NanTable = Table.make({
  schema: DynamoSchema.make({ name: "nan-keys", version: 1 }),
  entities: { Gauges, Badges, Slots, Meters },
})
/**
 * Every write dies: a NaN must be refused before any write is built. (A
 * guarded put reads the current item before it composes the sentinels.)
 */
const NanLayer = Layer.merge(
  Layer.succeed(DynamoClient, mockDynamoClient({ getItem: () => Effect.succeed({} as never) })),
  NanTable.layer({ name: "gauges" }),
)

describe("[EDD-9096] a NaN composite is a ValidationError, never a write (#171 E8)", () => {
  const NaN = Number.NaN
  const db = DynamoClient.make({
    entities: { Gauges, Badges, Slots, Meters },
    tables: { NanTable },
  })
  const cases: ReadonlyArray<
    readonly [string, (client: Effect.Success<typeof db>) => Effect.Effect<unknown, unknown, any>]
  > = [
    ["get", (c) => c.entities.Gauges.get({ gaugeId: "g", slot: NaN }).asEffect()],
    ["delete", (c) => c.entities.Gauges.delete({ gaugeId: "g", slot: NaN }).asEffect()],
    [
      "update of a NaN key",
      (c) => c.entities.Gauges.update({ gaugeId: "g", slot: NaN }).set({ score: 1 }).asEffect(),
    ],
    [
      "update setting a NaN index composite",
      (c) => c.entities.Gauges.update({ gaugeId: "g", slot: 1 }).set({ score: NaN }).asEffect(),
    ],
    [
      "upsert of a NaN key",
      (c) => c.entities.Gauges.upsert({ gaugeId: "g", slot: NaN, score: 1 }).asEffect(),
    ],
    [
      "upsert of a NaN index composite",
      (c) => c.entities.Gauges.upsert({ gaugeId: "g", slot: 1, score: NaN }).asEffect(),
    ],
    ["restore", (c) => c.entities.Gauges.restore({ gaugeId: "g", slot: NaN })],
    ["purge", (c) => c.entities.Gauges.purge({ gaugeId: "g", slot: NaN })],
    [
      "append of a NaN orderBy",
      (c) => c.entities.Meters.append({ meterId: "m", at: NaN, v: 1 }).asEffect(),
    ],
    ["Batch.get", () => Batch.get([Slots.get({ slotId: "s", slot: NaN })])],
    ["Batch.write delete", () => Batch.write([Slots.delete({ slotId: "s", slot: NaN })])],
    ["Batch.write put", () => Batch.write([Slots.put({ slotId: "s", slot: NaN })])],
    ["transactGet", () => Transaction.transactGet([Badges.get({ badgeId: "b", slot: NaN })])],
    [
      "transactWrite delete",
      () => Transaction.transactWrite([Badges.delete({ badgeId: "b", slot: NaN })]),
    ],
    [
      "transactWrite put of a NaN unique field",
      () => Transaction.transactWrite([Badges.put({ badgeId: "b", slot: 1, code: NaN })]),
    ],
    [
      "put of a NaN unique field",
      (c) => c.entities.Badges.put({ badgeId: "b", slot: 1, code: NaN }).asEffect(),
    ],
  ]

  for (const [name, run] of cases) {
    it.effect(name, () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(Effect.flatMap(db, (client) => run(client)))
        expect((error as { readonly _tag: string })._tag).toBe("ValidationError")
        const cause = (error as { readonly cause: { readonly _tag: string; message: string } })
          .cause
        expect(cause._tag).toBe("KeyValueError")
        expect(cause.message).toContain("[EDD-9096]")
      }).pipe(Effect.provide(NanLayer)),
    )
  }

  it.effect("a query accessor throws it, as it throws for other unusable composites", () =>
    Effect.gen(function* () {
      const client = yield* db
      expect(() => client.entities.Gauges.primary({ gaugeId: "g", slot: NaN })).toThrow(
        "[EDD-9096]",
      )
      expect(() =>
        client.entities.Gauges.primary({ gaugeId: "g" }).where((t, { gte }) => gte(t.slot, NaN)),
      ).toThrow("[EDD-9096]")
    }).pipe(Effect.provide(NanLayer)),
  )
})
