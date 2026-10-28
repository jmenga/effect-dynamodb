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

// ---------------------------------------------------------------------------
// History rows and the empty-composite half (#171 E7 audit)
// ---------------------------------------------------------------------------

const Doc = Schema.Struct({ ownerId: Schema.String, name: Schema.String, plan: Schema.String })
type Doc = typeof Doc.Type

/** Version snapshots and tombstones beside the live rows, on two index shapes. */
const Docs = Entity.make({
  model: Doc,
  entityType: "Doc",
  primaryKey: {
    pk: { field: "pk", composite: ["ownerId"] },
    sk: { field: "sk", composite: ["name"] },
  },
  indexes: {
    // An empty-composite half (canonical shape 6): the sort key is the
    // entity's prefix alone.
    byPlan: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["plan"] },
      sk: { field: "gsi1sk", composite: [] },
    },
    // A clustered collection member with an empty-composite half.
    shelf: {
      name: "gsi2",
      collection: "shelf",
      type: "clustered",
      pk: { field: "gsi2pk", composite: ["ownerId"] },
      sk: { field: "gsi2sk", composite: [] },
    },
  },
  versioned: { retain: true },
  softDelete: true,
})

const Profile = Schema.Struct({ ownerId: Schema.String, plan: Schema.String })
type Profile = typeof Profile.Type

/** An empty-composite primary sort key, whose history rows extend the live key. */
const Profiles = Entity.make({
  model: Profile,
  entityType: "Profile",
  primaryKey: {
    pk: { field: "pk", composite: ["ownerId"] },
    sk: { field: "sk", composite: [] },
  },
  indexes: {
    shelf: {
      name: "gsi2",
      collection: "shelf",
      type: "clustered",
      pk: { field: "gsi2pk", composite: ["ownerId"] },
      sk: { field: "gsi2sk", composite: ["plan"] },
    },
  },
  versioned: { retain: true },
  softDelete: true,
})

const ShelfTable = Table.make({ schema: AppSchema, entities: { Docs, Profiles } })

/**
 * A live row and its history as the write path stores them: snapshots of
 * versions 1..n-1 and, for a deleted item, a tombstone in place of the live
 * row — each under its own history sort key, without index keys.
 */
const withHistory = (
  entity: { readonly _keyForm: (record: Record<string, unknown>) => Record<string, unknown> },
  entityType: string,
  item: Record<string, unknown>,
  versions: number,
  deleted: boolean,
): ReadonlyArray<Row> => {
  const indexes = indexesOf(entity)
  const keys = KeyComposer.composeAllKeys(
    AppSchema,
    entityType,
    1,
    indexes,
    entity._keyForm({ ...item }),
  )
  const liveSk = keys.sk as string
  const segment = KeyComposer.composeHistoryItemSegment(
    AppSchema,
    entityType,
    1,
    indexes.primary!,
    liveSk,
  )
  const history = segment === undefined ? undefined : { item: segment }
  const base = { ...item, pk: keys.pk, __edd_e__: entityType }
  const snapshots = Array.from({ length: versions - 1 }, (_, v) =>
    toAttributeMap({
      ...base,
      sk: DynamoSchema.composeVersionKey(AppSchema, entityType, v + 1, history),
      version: v + 1,
    }),
  )
  const live = deleted
    ? toAttributeMap({
        ...base,
        sk: DynamoSchema.composeDeletedKey(
          AppSchema,
          entityType,
          "2026-10-28T00:00:00.000Z",
          history,
        ),
        version: versions,
        deletedAt: "2026-10-28T00:00:00.000Z",
      })
    : toAttributeMap({ ...item, ...keys, version: versions, __edd_e__: entityType })
  return [...snapshots, live]
}

const shelfRows: ReadonlyArray<Row> = [
  ...withHistory(Docs, "Doc", { ownerId: "o-1", name: "a", plan: "pro" }, 3, false),
  ...withHistory(Docs, "Doc", { ownerId: "o-1", name: "ab", plan: "pro" }, 2, false),
  ...withHistory(Docs, "Doc", { ownerId: "o-1", name: "a b", plan: "free" }, 1, false),
  ...withHistory(Docs, "Doc", { ownerId: "o-1", name: "ac", plan: "pro" }, 2, true),
  ...withHistory(Profiles, "Profile", { ownerId: "o-1", plan: "pro" }, 3, false),
  ...withHistory(Profiles, "Profile", { ownerId: "o-2", plan: "free" }, 2, true),
]

/** A client serving each request from the rows its index and partition key select. */
const serveShelf = () => {
  const requests: Array<{ readonly index: string; readonly keyCondition: string }> = []
  const fields: Record<string, readonly [string, string]> = {
    primary: ["pk", "sk"],
    gsi1: ["gsi1pk", "gsi1sk"],
    gsi2: ["gsi2pk", "gsi2sk"],
  }
  const layer = Layer.merge(
    Layer.succeed(
      DynamoClient,
      mockDynamoClient({
        query: (input) => {
          const index = input.IndexName ?? "primary"
          requests.push({ index, keyCondition: input.KeyConditionExpression ?? "" })
          const [pkField, skField] = fields[index]!
          const pk = input.ExpressionAttributeValues![":pk"]!.S
          return makePartition({
            rows: shelfRows.filter((row) => row[pkField]?.S === pk && row[skField] !== undefined),
            pkField,
            skField,
            keyFields: index === "primary" ? ["pk", "sk"] : [pkField, skField, "pk", "sk"],
            evaluateFilter: true,
          }).query(input)
        },
      }),
    ),
    ShelfTable.layer({ name: "shelf" }),
  )
  return { layer, requests }
}

describe("history rows and the empty-composite half (#171 E7 audit)", () => {
  const { layer, requests } = serveShelf()
  const db = DynamoClient.make({ entities: { Docs, Profiles }, tables: { ShelfTable } })
  const names = (docs: ReadonlyArray<Doc>) => docs.map((doc) => doc.name)

  it.effect(
    "a fully pinned primary key is `=`: the live row, not its history nor longer names",
    () =>
      Effect.gen(function* () {
        const { entities } = yield* db
        for (const reverse of [false, true]) {
          requests.length = 0
          const query = entities.Docs.primary({ ownerId: "o-1", name: "a" })
          const got = yield* (reverse ? query.reverse() : query).collect()
          expect(names(got)).toEqual(["a"])
          expect(requests).toEqual([{ index: "primary", keyCondition: "#pk = :pk AND #sk = :sk" }])
        }
        // A deleted item's pin finds nothing: its tombstone is history.
        expect(yield* entities.Docs.primary({ ownerId: "o-1", name: "ac" }).collect()).toEqual([])
      }).pipe(Effect.provide(layer)),
  )

  it.effect("an unpinned primary key reads the partition and keeps the live rows", () =>
    Effect.gen(function* () {
      const { entities } = yield* db
      requests.length = 0
      const got = yield* entities.Docs.primary({ ownerId: "o-1" }).collect()
      expect(names(got)).toEqual(["a", "a b", "ab"])
      expect(requests.map((r) => r.keyCondition)).toEqual(["#pk = :pk"])
    }).pipe(Effect.provide(layer)),
  )

  // An empty-composite half pins nothing: the accessor sends the partition
  // key alone, as before. On the primary key the item's history rows extend
  // the live key and are dropped as rows; an index never holds history.
  it.effect("an empty-composite primary sort key: the partition key alone, the live row kept", () =>
    Effect.gen(function* () {
      const { entities } = yield* db
      for (const [ownerId, want] of [
        ["o-1", ["pro"]],
        ["o-2", []],
      ] as const) {
        requests.length = 0
        const got: ReadonlyArray<Profile> = yield* entities.Profiles.primary({ ownerId }).collect()
        expect(got.map((profile) => profile.plan)).toEqual(want)
        expect(requests.map((r) => r.keyCondition)).toEqual(["#pk = :pk"])
      }
    }).pipe(Effect.provide(layer)),
  )

  it.effect("an empty-composite GSI half: the partition key alone, live rows only", () =>
    Effect.gen(function* () {
      const { entities } = yield* db
      requests.length = 0
      const got = yield* entities.Docs.byPlan({ plan: "pro" }).collect()
      expect(new Set(names(got))).toEqual(new Set(["a", "ab"]))
      expect(requests).toEqual([{ index: "gsi1", keyCondition: "#pk = :pk" }])
    }).pipe(Effect.provide(layer)),
  )

  it.effect(
    "a clustered member with an empty-composite half: its own rows, partition key alone",
    () =>
      Effect.gen(function* () {
        const { entities } = yield* db
        requests.length = 0
        const got = yield* entities.Docs.shelf({ ownerId: "o-1" }).collect()
        expect(new Set(names(got))).toEqual(new Set(["a", "ab", "a b"]))
        expect(requests).toEqual([{ index: "gsi2", keyCondition: "#pk = :pk" }])
        // Its sibling member, fully pinned: `=`.
        requests.length = 0
        const profiles = yield* entities.Profiles.shelf({ ownerId: "o-1", plan: "pro" }).collect()
        expect(profiles.map((profile) => profile.plan)).toEqual(["pro"])
        expect(requests).toEqual([{ index: "gsi2", keyCondition: "#pk = :pk AND #sk = :sk" }])
      }).pipe(Effect.provide(layer)),
  )

  it.effect("the collection query keeps its begins_with on the collection prefix", () =>
    Effect.gen(function* () {
      const { collections } = yield* db
      requests.length = 0
      const got = (yield* collections.shelf!({ ownerId: "o-1" }).collect()) as {
        readonly Docs: ReadonlyArray<Doc>
        readonly Profiles: ReadonlyArray<Profile>
      }
      expect(new Set(names(got.Docs))).toEqual(new Set(["a", "ab", "a b"]))
      expect(got.Profiles.map((profile) => profile.plan)).toEqual(["pro"])
      expect(requests).toEqual([
        { index: "gsi2", keyCondition: "#pk = :pk AND begins_with(#sk, :sk)" },
      ])
    }).pipe(Effect.provide(layer)),
  )
})

// ---------------------------------------------------------------------------
// `.history().where()` on a string orderBy (#171 sort key escaping)
// ---------------------------------------------------------------------------

const Note = Schema.Struct({
  deviceId: Schema.String,
  channel: Schema.String,
  stamp: Schema.String,
})
type Note = typeof Note.Type

const Notes = Entity.make({
  model: Note,
  entityType: "Note",
  primaryKey: {
    pk: { field: "pk", composite: ["deviceId"] },
    sk: { field: "sk", composite: ["channel"] },
  },
  timeSeries: { orderBy: "stamp", appendInput: Note },
})
const NotesTable = Table.make({ schema: AppSchema, entities: { Notes } })

/**
 * Stamps that extend `a` with characters a key escapes, and their
 * neighbours — and ones with an emoji, whose UTF-8 sorts above U+FFFF's. The
 * empty stamp's event key is the events' prefix itself.
 */
const STAMPS = [
  "",
  "a",
  "a b",
  "a!",
  'a"',
  "a\u0001",
  "a$",
  "aB",
  "ab",
  "a\u{1F600}",
  "b",
  "\u{1F600}",
]

describe(".history().where() on a string orderBy (#171 sort key escaping)", () => {
  const primary = indexesOf(Notes).primary!
  const rows = ["a", "b"].flatMap((channel) => {
    const currentSk = KeyComposer.composeSk(AppSchema, "Note", 1, primary, { channel })
    const pk = KeyComposer.composePk(AppSchema, "Note", primary, { deviceId: "d-1" })
    return [
      toAttributeMap({
        deviceId: "d-1",
        channel,
        stamp: "b",
        pk,
        sk: currentSk,
        __edd_e__: "Note",
      }),
      ...STAMPS.map((stamp) =>
        toAttributeMap({
          deviceId: "d-1",
          channel,
          stamp,
          pk,
          sk: KeyComposer.composeEventSk(currentSk, stamp, AppSchema.casing),
          __edd_e__: "Note",
        }),
      ),
    ]
  })
  const partition = makePartition({ rows })
  const layer = Layer.merge(
    Layer.succeed(DynamoClient, mockDynamoClient({ query: partition.query })),
    NotesTable.layer({ name: "notes" }),
  )
  const cased = (text: string) => DynamoSchema.applyCasing(text, AppSchema.casing)
  const order = (a: string, b: string) => compareUtf8(cased(a), cased(b))

  it.effect("every operator returns exactly the events whose stamp satisfies it", () =>
    Effect.gen(function* () {
      const { entities } = yield* DynamoClient.make({
        entities: { Notes },
        tables: { NotesTable },
      })
      const operands = [...STAMPS, "a ", "a\u0000"]
      for (const a of operands) {
        for (const op of ["eq", "lt", "lte", "gt", "gte", "beginsWith"] as const) {
          const want = STAMPS.filter((stamp) => {
            const c = order(stamp, a)
            return op === "eq"
              ? c === 0
              : op === "lt"
                ? c < 0
                : op === "lte"
                  ? c <= 0
                  : op === "gt"
                    ? c > 0
                    : op === "gte"
                      ? c >= 0
                      : cased(stamp).startsWith(cased(a))
          }).sort(order)
          for (const reverse of [false, true]) {
            const query = entities.Notes.history({ deviceId: "d-1", channel: "a" }).where(
              (t, ops) => ops[op](t.stamp, a),
            )
            const got: ReadonlyArray<Note> = yield* (reverse ? query.reverse() : query).collect()
            expect(
              got.map((note) => `${note.channel}:${note.stamp}`),
              `${op} ${JSON.stringify(a)}${reverse ? " reversed" : ""}`,
            ).toEqual((reverse ? [...want].reverse() : want).map((stamp) => `a:${stamp}`))
          }
        }
      }
    }).pipe(Effect.provide(layer)),
  )

  it.effect("lt('') plans empty and sends nothing: no key sorts below the events' prefix", () =>
    Effect.gen(function* () {
      const { entities } = yield* DynamoClient.make({
        entities: { Notes },
        tables: { NotesTable },
      })
      const query = entities.Notes.history({ deviceId: "d-1", channel: "a" }).where((t, { lt }) =>
        lt(t.stamp, ""),
      )
      partition.clear()
      expect((yield* query.explain()).plan).toBe("empty")
      expect(yield* query.collect()).toEqual([])
      expect(yield* query.count()).toBe(0)
      expect(yield* query.reverse().fetch()).toEqual({ items: [], cursor: null })
      expect(partition.inputs).toEqual([])
    }).pipe(Effect.provide(layer)),
  )
})
