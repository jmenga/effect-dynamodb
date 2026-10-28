/**
 * Sort key conditions that must stay inside what the caller named (#171 E7,
 * history bounds).
 *
 * - An accessor given every sort key composite matches the complete key with
 *   `=`. A `begins_with` on it also matched every longer value of the last
 *   composite: `name: "a"` returned `"ab"`, and — numeric key text being
 *   variable-width since 1.37 — `seq: 3` returned 3.14 and 3.5, and a bigint
 *   level of 1e38 returned 1.5e38.
 * - `.history(key).where()` keeps every bound inside the item's own
 *   `<currentSk>#e#` events. DynamoDB allows one sort key condition, and a bare
 *   one-sided `<` / `>` replaced the history scope: it ran on to the item's
 *   current row and its siblings' events.
 *
 * Reads are served by `PartitionMock`, which orders sort keys by their UTF-8
 * bytes as DynamoDB does; rows are composed with the library's own composer.
 * The expected rows are computed from the values, never from the keys.
 */

import { describe, expect, it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import * as KeyComposer from "@effect-dynamodb/schema/KeyComposer.js"
import { Effect, Layer, Schema } from "effect"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import { compareUtf8, keyJustBelow } from "../src/internal/RangePlanner.js"
import { toAttributeMap } from "../src/Marshaller.js"
import * as Table from "../src/Table.js"
import { mockDynamoClient } from "./helpers/MockDynamoClient.js"
import { makePartition, type Row } from "./helpers/PartitionMock.js"

const AppSchema = DynamoSchema.make({ name: "pinned", version: 1 })

// ---------------------------------------------------------------------------
// Accessors given every sort key composite
// ---------------------------------------------------------------------------

const Reading = Schema.Struct({
  sensorId: Schema.String,
  seq: Schema.Number,
  tag: Schema.String,
  name: Schema.String,
  level: Schema.BigInt,
})
type Reading = typeof Reading.Type

/** One accessor per index shape the complete-key rule applies to. */
const Readings = Entity.make({
  model: Reading,
  entityType: "Reading",
  primaryKey: {
    pk: { field: "pk", composite: ["sensorId"] },
    sk: { field: "sk", composite: ["seq"] },
  },
  indexes: {
    byTag: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["sensorId"] },
      sk: { field: "gsi1sk", composite: ["tag", "seq"] },
    },
    feed: {
      name: "gsi2",
      collection: "feed",
      pk: { field: "gsi2pk", composite: ["sensorId"] },
      sk: { field: "gsi2sk", composite: ["seq"] },
    },
    site: {
      name: "gsi3",
      collection: ["site", "feed"],
      type: "clustered",
      pk: { field: "gsi3pk", composite: ["sensorId"] },
      sk: { field: "gsi3sk", composite: ["seq"] },
    },
    byLevel: {
      name: "gsi4",
      pk: { field: "gsi4pk", composite: ["sensorId"] },
      sk: { field: "gsi4sk", composite: ["level"] },
    },
    byName: {
      name: "gsi5",
      pk: { field: "gsi5pk", composite: ["sensorId"] },
      sk: { field: "gsi5sk", composite: ["name"] },
    },
  },
})

/** Seqs whose key text extends 3's or -3's, or sorts beside them. */
const SEQS = [-3.5, -3.14, -3, -0.3, 0.3, 3, 3.14, 3.5, 30, 300]
/** Levels whose `:` form text extends 1e38's: 1.2e38, 1.5e38. */
const LEVELS = [-(10n ** 38n), 10n ** 38n - 1n, 10n ** 38n, 12n * 10n ** 37n, 15n * 10n ** 37n]
const NAMES = ["a", "ab", "a b", "aa", "b"]

const readings: ReadonlyArray<Reading> = SEQS.map((seq, i) => ({
  sensorId: "s-1",
  seq,
  tag: "t",
  name: NAMES[i % NAMES.length]!,
  level: LEVELS[i % LEVELS.length]!,
}))

const indexesOf = (entity: unknown) =>
  (entity as { readonly indexes: Record<string, KeyComposer.IndexDefinition> }).indexes

const rowOf = (reading: Reading): Row =>
  toAttributeMap({
    ...reading,
    ...KeyComposer.composeAllKeys(
      AppSchema,
      "Reading",
      1,
      indexesOf(Readings),
      Readings._keyForm({ ...reading }),
    ),
    __edd_e__: "Reading",
  })

const ReadingsTable = Table.make({ schema: AppSchema, entities: { Readings } })

/** A client serving each index's partition, and the requests it received. */
const serveIndexes = (
  rows: ReadonlyArray<Row>,
  indexes: Record<string, KeyComposer.IndexDefinition>,
) => {
  const partitions = new Map(
    Object.values(indexes).map((index) => [
      index.index ?? "primary",
      makePartition({
        rows,
        pkField: index.pk.field,
        skField: index.sk.field,
        keyFields:
          index.index === undefined
            ? [index.pk.field, index.sk.field]
            : [index.pk.field, index.sk.field, "pk", "sk"],
      }),
    ]),
  )
  const requests: Array<{ readonly index: string; readonly keyCondition: string }> = []
  const layer = Layer.succeed(
    DynamoClient,
    mockDynamoClient({
      query: (input) => {
        const index = input.IndexName ?? "primary"
        requests.push({ index, keyCondition: input.KeyConditionExpression ?? "" })
        return partitions.get(index)!.query(input)
      },
    }),
  )
  return { layer, requests }
}

describe("an accessor given every sort key composite matches the key exactly (#171 E7)", () => {
  const { layer, requests } = serveIndexes(readings.map(rowOf), indexesOf(Readings))
  const provided = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provide(Layer.merge(layer, ReadingsTable.layer({ name: "readings" }))),
    ) as Effect.Effect<A, E>

  const collect = (
    accessor: string,
    pins: Record<string, unknown>,
    reverse: boolean,
  ): Effect.Effect<ReadonlyArray<Reading>, unknown> =>
    provided(
      Effect.gen(function* () {
        const db = yield* DynamoClient.make({
          entities: { Readings },
          tables: { ReadingsTable },
        })
        const query = (db.entities.Readings as any)[accessor](pins)
        return (yield* (reverse ? query.reverse() : query).collect()) as ReadonlyArray<Reading>
      }),
    )

  const shapes = [
    ["primary", {}],
    ["byTag", { tag: "t" }],
    ["feed", {}],
    ["site", {}],
  ] as const

  for (const [accessor, extra] of shapes) {
    for (const seq of [3, -3, 0.3, 30]) {
      for (const reverse of [false, true]) {
        it.effect(`${accessor} seq ${seq}${reverse ? ", reversed" : ""}: only seq ${seq}`, () =>
          Effect.gen(function* () {
            requests.length = 0
            const got = yield* collect(accessor, { sensorId: "s-1", ...extra, seq }, reverse)
            expect(got.map((r) => r.seq)).toEqual([seq])
            expect(requests.at(-1)?.keyCondition).toBe("#pk = :pk AND #sk = :sk")
          }),
        )
      }
    }
  }

  it.effect("a bigint level of 1e38 returns neither 1.2e38 nor 1.5e38", () =>
    Effect.gen(function* () {
      for (const reverse of [false, true]) {
        const got = yield* collect("byLevel", { sensorId: "s-1", level: 10n ** 38n }, reverse)
        expect(got.map((r) => r.level)).toEqual(
          readings.filter((r) => r.level === 10n ** 38n).map((r) => r.level),
        )
      }
    }),
  )

  it.effect('a string name "a" returns neither "ab" nor "aa" nor "a b"', () =>
    Effect.gen(function* () {
      for (const reverse of [false, true]) {
        const got = yield* collect("byName", { sensorId: "s-1", name: "a" }, reverse)
        expect(got.length).toBeGreaterThan(0)
        expect(new Set(got.map((r) => r.name))).toEqual(new Set(["a"]))
      }
    }),
  )

  it.effect("a partial pin is a terminated begins_with: tag t, every seq in order", () =>
    Effect.gen(function* () {
      requests.length = 0
      const got = yield* collect("byTag", { sensorId: "s-1", tag: "t" }, false)
      expect(got.map((r) => r.seq)).toEqual([...SEQS].sort((a, b) => a - b))
      expect(requests.at(-1)?.keyCondition).toBe("#pk = :pk AND begins_with(#sk, :sk)")
    }),
  )

  it("Entity.query.<index> sends the same conditions", () => {
    const pinned = Readings.query.byTag({ sensorId: "s-1", tag: "t", seq: 3 } as never)
    const index = indexesOf(Readings).byTag!
    expect(pinned._state.skConditions[0]!.condition).toEqual({
      eq: KeyComposer.composeSk(AppSchema, "Reading", 1, index, { tag: "t", seq: 3 }),
    })
    const partial = Readings.query.byTag({ sensorId: "s-1", tag: "t" } as never)
    expect(partial._state.skConditions[0]!.condition).toEqual({
      beginsWith: KeyComposer.composeSortKeyBeginsWith(AppSchema, "Reading", 1, index, {
        tag: "t",
      }),
    })
  })

  // A number has no text prefix: `.where(beginsWith)` on a numeric composite
  // is `eq` — 3 alone, not 3.14 and 3.5 (whose text extends 3's), and -3 alone.
  for (const [accessor, extra] of [
    ["primary", {}],
    ["byTag", { tag: "t" }],
  ] as const) {
    it.effect(`${accessor}: .where(beginsWith) on a numeric composite is eq`, () =>
      Effect.gen(function* () {
        for (const seq of [3, -3, 0.3]) {
          const got = yield* provided(
            Effect.gen(function* () {
              const db = yield* DynamoClient.make({
                entities: { Readings },
                tables: { ReadingsTable },
              })
              return yield* (db.entities.Readings as any)
                [accessor]({ sensorId: "s-1", ...extra })
                .where((t: any, { beginsWith }: any) => beginsWith(t.seq, seq))
                .collect()
            }),
          )
          expect((got as ReadonlyArray<Reading>).map((r) => r.seq)).toEqual([seq])
        }
      }),
    )
  }

  it.effect(".where(beginsWith) on a string composite is still a prefix match", () =>
    Effect.gen(function* () {
      const got = yield* provided(
        Effect.gen(function* () {
          const db = yield* DynamoClient.make({ entities: { Readings }, tables: { ReadingsTable } })
          return yield* db.entities.Readings.byName({ sensorId: "s-1" })
            .where((t, { beginsWith }) => beginsWith(t.name, "a"))
            .collect()
        }),
      )
      expect(new Set(got.map((r) => r.name))).toEqual(new Set(["a", "ab", "a b", "aa"]))
    }),
  )
})

describe("keyJustBelow", () => {
  // For every key without U+10FFFF — emoji and NUL included — a key is at most
  // `keyJustBelow(k)` exactly when it is below `k`.
  const alphabet = [
    "#",
    "$",
    "-",
    ".",
    "0",
    "9",
    ":",
    "a",
    "é",
    "\u0000",
    "\ud7ff",
    "\ue000",
    "\uffff",
    "😀",
  ]
  const keys = [""]
  for (const a of alphabet) {
    keys.push(a)
    for (const b of alphabet) {
      keys.push(`${a}${b}`)
      for (const c of ["0", "\u0000", "😀"]) keys.push(`${a}${b}${c}`)
    }
  }
  it("is below the key and above every key below it", () => {
    const wrong: Array<string> = []
    for (const k of keys) {
      if (k === "") continue
      const bound = keyJustBelow(k)
      for (const t of keys) {
        if (compareUtf8(t, bound) <= 0 !== compareUtf8(t, k) < 0) {
          wrong.push(`${JSON.stringify(t)} under ${JSON.stringify(k)}`)
        }
      }
    }
    expect(wrong).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Time series: the primary accessor and `.history().where()`
// ---------------------------------------------------------------------------

const Tick = Schema.Struct({
  deviceId: Schema.String,
  channel: Schema.String,
  at: Schema.Number,
  v: Schema.Number,
})
type Tick = typeof Tick.Type

const Ticks = Entity.make({
  model: Tick,
  entityType: "Tick",
  primaryKey: {
    pk: { field: "pk", composite: ["deviceId"] },
    sk: { field: "sk", composite: ["channel"] },
  },
  timeSeries: { orderBy: "at", appendInput: Tick },
})
const TicksTable = Table.make({ schema: AppSchema, entities: { Ticks } })

/** orderBy values across the numeric key forms: negatives, fractions, integers. */
const ATS = [-100.5, -10, -3.14, -3.1, -3, -0.5, -1e-7, 0, 1e-7, 0.5, 1, 2, 3, 3.1, 3.14, 5, 10, 20]
/** Bound operands: every orderBy, values between them, and values past both ends. */
const OPERANDS = [...ATS, -1000, -3.05, 3.05, 4, 1000]

/** Each channel's current row (its latest event) and every event. */
const tickRows = (): ReadonlyArray<Row> => {
  const primary = indexesOf(Ticks).primary!
  return ["a", "b"].flatMap((channel) => {
    const currentSk = KeyComposer.composeSk(AppSchema, "Tick", 1, primary, { channel })
    const pk = KeyComposer.composePk(AppSchema, "Tick", primary, { deviceId: "d-1" })
    const tick = (at: number): Tick => ({ deviceId: "d-1", channel, at, v: at })
    const events = ATS.map((at) =>
      toAttributeMap({
        ...tick(at),
        pk,
        sk: KeyComposer.composeEventSk(currentSk, at, AppSchema.casing),
        __edd_e__: "Tick",
      }),
    )
    return [toAttributeMap({ ...tick(20), pk, sk: currentSk, __edd_e__: "Tick" }), ...events]
  })
}

type Bound =
  | { readonly op: "eq" | "lt" | "lte" | "gt" | "gte" | "beginsWith"; readonly a: number }
  | { readonly op: "between"; readonly a: number; readonly b: number }

const holds = (bound: Bound, at: number): boolean => {
  switch (bound.op) {
    case "eq":
    case "beginsWith":
      return at === bound.a
    case "lt":
      return at < bound.a
    case "lte":
      return at <= bound.a
    case "gt":
      return at > bound.a
    case "gte":
      return at >= bound.a
    case "between":
      return at >= bound.a && at <= bound.b
  }
}

describe("time-series sort key conditions (#171)", () => {
  const partition = makePartition({ rows: tickRows() })
  const layer = Layer.merge(
    Layer.succeed(DynamoClient, mockDynamoClient({ query: partition.query })),
    TicksTable.layer({ name: "ticks" }),
  )
  const ticks = Effect.map(
    DynamoClient.make({ entities: { Ticks }, tables: { TicksTable } }),
    (db) => db.entities.Ticks,
  )

  it.effect("the primary accessor given the channel returns the current row, not its events", () =>
    Effect.gen(function* () {
      partition.clear()
      const got: ReadonlyArray<Tick> = yield* (yield* ticks)
        .primary({ deviceId: "d-1", channel: "a" })
        .collect()
      expect(got.map((t) => `${t.channel}:${t.at}`)).toEqual(["a:20"])
      expect(partition.inputs.at(-1)).toMatchObject({
        KeyConditionExpression: "#pk = :pk AND #sk = :sk",
      })
    }).pipe(Effect.provide(layer)),
  )

  it.effect(".history().where() keeps every operator inside the item's own events", () =>
    Effect.gen(function* () {
      const accessor = yield* ticks
      const bounds: Array<Bound> = []
      for (const a of OPERANDS) {
        for (const op of ["eq", "lt", "lte", "gt", "gte", "beginsWith"] as const) {
          bounds.push({ op, a })
        }
        for (const b of OPERANDS) if (a <= b) bounds.push({ op: "between", a, b })
      }
      for (const bound of bounds) {
        const want = ATS.filter((at) => holds(bound, at))
        for (const reverse of [false, true]) {
          const query = accessor
            .history({ deviceId: "d-1", channel: "a" })
            .where((t, ops) =>
              bound.op === "between"
                ? ops.between(t.at, bound.a, bound.b)
                : ops[bound.op](t.at, bound.a),
            )
          const got: ReadonlyArray<Tick> = yield* (reverse ? query.reverse() : query).collect()
          expect(
            got.map((t) => `${t.channel}:${t.at}`),
            `${JSON.stringify(bound)}${reverse ? " reversed" : ""}`,
          ).toEqual((reverse ? [...want].reverse() : want).map((at) => `a:${at}`))
        }
      }
    }).pipe(Effect.provide(layer)),
  )

  it.effect(".history() without a bound returns the item's events in orderBy order", () =>
    Effect.gen(function* () {
      const got: ReadonlyArray<Tick> = yield* (yield* ticks)
        .history({ deviceId: "d-1", channel: "b" })
        .collect()
      expect(got.map((t) => t.at)).toEqual(ATS)
      expect(new Set(got.map((t) => t.channel))).toEqual(new Set(["b"]))
    }).pipe(Effect.provide(layer)),
  )
})
