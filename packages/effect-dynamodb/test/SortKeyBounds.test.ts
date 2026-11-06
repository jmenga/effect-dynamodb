/**
 * Sort key bounds on composites whose values hold any character — those that
 * sort at or below the key delimiter's neighbourhood (control characters,
 * space, `!`, `"`, `#`, `$`, `%`) included (#171).
 *
 * A composite's key text is followed by `#` unless it is the last. Up to
 * 1.36 a value's text went into the key as it was, and space, `!`, `"` and
 * control characters sort below `#`: `new york#…` sorted before `new#…`, so
 * `lte: "new york"` left out `new` and `gt: "new"` left out `new york`; a
 * value holding `#` itself split into two segments. Sort key text is now
 * escaped (`KeyComposer.keyText`), so key order is value order and every
 * bound is one exact key condition. `.where()` and `.within()` (every plan)
 * must return exactly the rows whose cased value satisfies the bound.
 *
 * Reads are served by `PartitionMock`, which orders sort keys by their UTF-8
 * bytes as DynamoDB does, and refuses a reversed `BETWEEN` as DynamoDB does;
 * rows are composed with the library's own composer. The expected rows come
 * from an independent comparison of the cased values, never from the keys.
 */

import type { QueryCommandInput } from "@aws-sdk/client-dynamodb"
import { describe, expect, it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import * as KeyComposer from "@effect-dynamodb/schema/KeyComposer.js"
import { Arbitrary, Effect, Layer, Option, Schema } from "effect"
import { composeRangeUnder, DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import type { RawSortKeyCondition } from "../src/internal/BoundQuery.js"
import { keyJustBelow } from "../src/internal/RangePlanner.js"
import { toAttributeMap } from "../src/Marshaller.js"
import type * as Query from "../src/Query.js"
import * as Table from "../src/Table.js"
import { mockDynamoClient } from "./helpers/MockDynamoClient.js"
import { compareBytes, makePartition, type Row } from "./helpers/PartitionMock.js"

const casings = ["lowercase", "uppercase", "preserve"] as const
type Casing = (typeof casings)[number]

const encoder = new TextEncoder()
/** DynamoDB's order of key text: UTF-8 bytes. */
const byteOrder = (a: string, b: string): number =>
  Math.sign(compareBytes(encoder.encode(a), encoder.encode(b)))

/**
 * Every character a key escapes — control characters, space, `!`, `"`, the
 * delimiter `#`, `$` and `%` — the first one it doesn't (`&`), digits and
 * letters of both cases (casing folds them), and non-ASCII: a letter casing
 * maps (`É`), and an astral emoji, which sorts above U+FFFF.
 */
const ALPHABET = [
  "\u0000",
  "\u0001",
  "\n",
  " ",
  "!",
  '"',
  "#",
  "$",
  "%",
  "&",
  "0",
  "9",
  "A",
  "B",
  "a",
  "b",
  "É",
  "😀",
]

/**
 * `kind`'s members: some extend another with an escaped character (`a b` of
 * `a`, `new york` of `new`, `a#b` of `a`) — as a bounded composite and as a
 * skip tuple.
 */
const KINDS = [
  "a",
  "a b",
  "a!",
  'a"',
  "a#b",
  "a$",
  "a%",
  "a0",
  "ab",
  "b",
  "B",
  "ne",
  "new",
  "NEW",
  "new york",
  "new!",
  "new#",
  "new0",
  "newer",
  "news",
  "50%",
] as const

/** `level`'s members: no escaped character, so their key text is their own. */
const LEVELS = ["a", "a0", "ab", "b", "B", "ne", "new", "NEW", "new0", "newer", "news"] as const

/** Regions, as a pin and as a free-form string skip tuple: some escaped, some extending `north`. */
const REGIONS = ["north", "north east", "north#2", "nor%th", "south"] as const

// ---------------------------------------------------------------------------
// The entities: one index per shape a bound can take
// ---------------------------------------------------------------------------

const Place = Schema.Struct({
  store: Schema.String,
  id: Schema.String,
  region: Schema.String,
  city: Schema.String,
  kind: Schema.Literals(KINDS),
  level: Schema.Literals(LEVELS),
})
type Place = typeof Place.Type

type Shape = {
  /** The accessor: an index of the entity. */
  readonly index: string
  /** The composite the bound targets. */
  readonly field: string
  /** What the accessor pins (a clamped shape's leading composite). */
  readonly pins: Readonly<Record<string, string>>
  /** Whether `.where()` reaches `field`: it bounds the composite after the pinned ones. */
  readonly where: boolean
}

const indexes = {
  // `city` (free-form): non-last / last, unclamped / clamped
  cityId: { pk: ["store"], sk: ["city", "id"] },
  regionCityId: { pk: ["store"], sk: ["region", "city", "id"] },
  city: { pk: ["store"], sk: ["city"] },
  regionCity: { pk: ["store"], sk: ["region", "city"] },
  // `kind` (literals, some holding a character a key escapes)
  kindId: { pk: ["store"], sk: ["kind", "id"] },
  regionKindId: { pk: ["store"], sk: ["region", "kind", "id"] },
  regionKind: { pk: ["store"], sk: ["region", "kind"] },
  // `level` (literals): its values hold no character a key escapes
  levelId: { pk: ["store"], sk: ["level", "id"] },
  regionLevelId: { pk: ["store"], sk: ["region", "level", "id"] },
  regionLevel: { pk: ["store"], sk: ["region", "level"] },
  // skip-scan: a tuple before the bounded `city` — literals holding escaped
  // characters (`kind`) or not (`level`); `regionCityId` with nothing pinned
  // takes the free-form `region` as its tuple
  kindCityId: { pk: ["store"], sk: ["kind", "city", "id"] },
  levelCityId: { pk: ["store"], sk: ["level", "city", "id"] },
} as const

const north = { region: "north" }
const placeShapes: ReadonlyArray<Shape> = [
  { index: "cityId", field: "city", pins: {}, where: true },
  { index: "regionCityId", field: "city", pins: north, where: true },
  { index: "city", field: "city", pins: {}, where: true },
  { index: "regionCity", field: "city", pins: north, where: true },
  { index: "kindId", field: "kind", pins: {}, where: true },
  { index: "regionKindId", field: "kind", pins: north, where: true },
  { index: "regionKind", field: "kind", pins: north, where: true },
  { index: "levelId", field: "level", pins: {}, where: true },
  { index: "regionLevelId", field: "level", pins: north, where: true },
  { index: "regionLevel", field: "level", pins: north, where: true },
  { index: "kindCityId", field: "city", pins: {}, where: false },
  { index: "levelCityId", field: "city", pins: {}, where: false },
  { index: "regionCityId", field: "city", pins: {}, where: false },
]

/**
 * A time-series entity (canonical primary shape `sk: [zone, device]`): every
 * item's events sort inside its key's subtree (`<currentSk>#e#<at>`), and the
 * query drops them as history rows.
 */
const Reading = Schema.Struct({
  store: Schema.String,
  zone: Schema.String,
  device: Schema.String,
  at: Schema.Number,
})
type Reading = typeof Reading.Type

const readingShapes: ReadonlyArray<Shape> = [
  // non-last, every item's events in its subtree
  { index: "primary", field: "zone", pins: {}, where: true },
  // last, clamped: each item's events right after its key
  { index: "primary", field: "device", pins: { zone: "north" }, where: true },
  // tupled over `zone`: the filter plan (history rows on the primary index)
  { index: "primary", field: "device", pins: {}, where: false },
]

/** A client serving each index's partition of `rows`, and the requests it received. */
const serveIndexes = <L>(
  defs: Record<string, KeyComposer.IndexDefinition>,
  rows: ReadonlyArray<Row>,
  tableLayer: Layer.Layer<L>,
) => {
  const partitions = new Map(
    Object.values(defs).map((index) => [
      index.index ?? "primary",
      makePartition({
        rows: rows.filter((row) => row[index.sk.field] !== undefined),
        pkField: index.pk.field,
        skField: index.sk.field,
        keyFields: [...new Set([index.pk.field, index.sk.field, "pk", "sk"])],
      }),
    ]),
  )
  const requests: Array<QueryCommandInput> = []
  const layer = Layer.merge(
    Layer.succeed(
      DynamoClient,
      mockDynamoClient({
        query: (input) => {
          requests.push(input)
          return partitions.get(input.IndexName ?? "primary")!.query(input)
        },
      }),
    ),
    tableLayer,
  )
  return { layer, requests }
}

const definitionsOf = (entity: unknown) =>
  (entity as { readonly indexes: Record<string, KeyComposer.IndexDefinition> }).indexes

const makePlaces = (casing: Casing) => {
  const schema = DynamoSchema.make({ name: "places", version: 1, casing, escapeKeys: true })
  const gsis = Object.fromEntries(
    Object.entries(indexes).map(([name, def], n) => [
      name,
      {
        name: `gsi${n + 1}`,
        pk: { field: `gsi${n + 1}pk`, composite: [...def.pk] },
        sk: { field: `gsi${n + 1}sk`, composite: [...def.sk] },
      },
    ]),
  )
  const Places = Entity.make({
    model: Place,
    entityType: "Place",
    primaryKey: {
      pk: { field: "pk", composite: ["store"] },
      sk: { field: "sk", composite: ["id"] },
    },
    indexes: gsis as never,
  })
  const PlacesTable = Table.make({ schema, entities: { Places } })
  const defs = definitionsOf(Places)
  const keysOf = (place: Place) =>
    KeyComposer.composeAllKeys(schema, "Place", 1, defs, Places._keyForm({ ...place }))
  const rowOf = (place: Place): Row =>
    toAttributeMap({ ...place, ...keysOf(place), __edd_e__: "Place" })
  const serve = (places: ReadonlyArray<Place>) =>
    serveIndexes(defs, places.map(rowOf), PlacesTable.layer({ name: "places" }))
  const places = Effect.map(
    DynamoClient.make({ entities: { Places }, tables: { PlacesTable } }),
    (db) => db.entities.Places as unknown as Record<string, (pins: object) => any>,
  )
  return { defs, keysOf, serve, places }
}

const makeReadings = (casing: Casing) => {
  const schema = DynamoSchema.make({ name: "places", version: 1, casing, escapeKeys: true })
  const Readings = Entity.make({
    model: Reading,
    entityType: "Reading",
    primaryKey: {
      pk: { field: "pk", composite: ["store"] },
      sk: { field: "sk", composite: ["zone", "device"] },
    },
    timeSeries: { orderBy: "at", appendInput: Reading },
  })
  const ReadingsTable = Table.make({ schema, entities: { Readings } })
  const defs = definitionsOf(Readings)
  const keysOf = (reading: Reading) =>
    KeyComposer.composeAllKeys(schema, "Reading", 1, defs, Readings._keyForm({ ...reading }))
  /** The item at `at` 3, after its events at 1 and 2. */
  const rowsOf = (reading: Reading): Array<Row> => {
    const { pk, sk } = keysOf(reading) as { readonly pk: string; readonly sk: string }
    return [
      toAttributeMap({ ...reading, pk, sk, __edd_e__: "Reading" }),
      ...[1, 2].map((at) =>
        toAttributeMap({
          ...reading,
          at,
          pk,
          sk: KeyComposer.composeEventSk(schema, sk, at, casing),
          __edd_e__: "Reading",
        }),
      ),
    ]
  }
  const serve = (readings: ReadonlyArray<Reading>) =>
    serveIndexes(defs, readings.flatMap(rowsOf), ReadingsTable.layer({ name: "readings" }))
  const readings = Effect.map(
    DynamoClient.make({ entities: { Readings }, tables: { ReadingsTable } }),
    (db) => db.entities.Readings as unknown as Record<string, (pins: object) => any>,
  )
  return { keysOf, serve, readings }
}

// ---------------------------------------------------------------------------
// Bounds and the oracle
// ---------------------------------------------------------------------------

type Op = "eq" | "lt" | "lte" | "gt" | "gte" | "between" | "beginsWith"
type Bound = { readonly op: Op; readonly a: string; readonly b: string }

/** Does `value` satisfy `bound`, comparing the cased values' bytes? */
const oracle = (casing: Casing, bound: Bound, value: string): boolean => {
  const cased = (text: string) => DynamoSchema.applyCasing(text, casing)
  const v = cased(value)
  const against = (operand: string) => byteOrder(v, cased(operand))
  switch (bound.op) {
    case "eq":
      return against(bound.a) === 0
    case "lt":
      return against(bound.a) < 0
    case "lte":
      return against(bound.a) <= 0
    case "gt":
      return against(bound.a) > 0
    case "gte":
      return against(bound.a) >= 0
    case "between":
      return against(bound.a) >= 0 && against(bound.b) <= 0
    case "beginsWith":
      return v.startsWith(cased(bound.a))
  }
}

/** `.within()` takes every operator but `beginsWith`, and pairs of ends. */
const withinBounds = (bound: Bound): ReadonlyArray<Record<string, unknown>> => {
  switch (bound.op) {
    case "beginsWith":
      return []
    case "between":
      return [
        { between: [bound.a, bound.b] },
        { gt: bound.a, lte: bound.b },
        { gte: bound.a, lt: bound.b },
        { gt: bound.a, lt: bound.b },
      ]
    default:
      return [{ [bound.op]: bound.a }]
  }
}

/** The predicate a `.within()` bound means. */
const withinOracle = (casing: Casing, shape: Record<string, unknown>, value: string): boolean =>
  Object.entries(shape).every(([op, operand]) =>
    op === "between"
      ? oracle(
          casing,
          { op, a: (operand as [string, string])[0], b: (operand as [string, string])[1] },
          value,
        )
      : oracle(casing, { op: op as Op, a: operand as string, b: "" }, value),
  )

const whereCall =
  (field: string, bound: Bound) =>
  (t: any, ops: any): RawSortKeyCondition =>
    bound.op === "between"
      ? ops.between(t[field], bound.a, bound.b)
      : ops[bound.op](t[field], bound.a)

/**
 * Collect `query` (or its reverse) and compare it with the items `holds`
 * admits: the same items, in key order, and no request DynamoDB would refuse.
 */
const checkQuery = <T>(args: {
  readonly served: {
    readonly layer: Layer.Layer<DynamoClient>
    readonly requests: Array<QueryCommandInput>
  }
  readonly items: ReadonlyArray<T>
  readonly idOf: (item: T) => string
  readonly skOf: (item: T) => string
  readonly holds: (item: T) => boolean
  readonly context: string
  readonly query: any
  readonly reverse: boolean
}) =>
  Effect.gen(function* () {
    const { served, idOf, skOf, context, reverse } = args
    served.requests.length = 0
    const got = yield* (
      (reverse ? args.query.reverse() : args.query).collect() as Effect.Effect<
        ReadonlyArray<T>,
        unknown,
        DynamoClient
      >
    ).pipe(Effect.provide(served.layer))
    const want = args.items.filter((item) => args.holds(item))
    expect(got.map(idOf).sort(), context).toEqual(want.map(idOf).sort())
    // In key order.
    for (let i = 1; i < got.length; i++) {
      const order = byteOrder(skOf(got[i - 1]!), skOf(got[i]!))
      expect(reverse ? order >= 0 : order <= 0, context).toBe(true)
    }
    // No BETWEEN DynamoDB would refuse — the partition refuses one too.
    for (const input of served.requests) {
      const between = /BETWEEN (:\w+) AND (:\w+)/.exec(input.KeyConditionExpression ?? "")
      if (between === null) continue
      const values = input.ExpressionAttributeValues!
      expect(byteOrder(values[between[1]!]!.S!, values[between[2]!]!.S!) <= 0, context).toBe(true)
    }
  })

/** `.where()` (where the shape takes one) and every `.within()` form of `bound`, both ways. */
const checkShape = <T>(args: {
  readonly casing: Casing
  readonly shape: Shape
  readonly bound: Bound
  readonly accessor: (pins: object) => any
  readonly pins: Readonly<Record<string, string>>
  readonly served: {
    readonly layer: Layer.Layer<DynamoClient>
    readonly requests: Array<QueryCommandInput>
  }
  readonly items: ReadonlyArray<T>
  readonly idOf: (item: T) => string
  readonly skOf: (item: T) => string
}) =>
  Effect.gen(function* () {
    const { casing, shape, bound } = args
    const valueOf = (item: T) => (item as Record<string, string>)[shape.field]!
    const inPins = (item: T) =>
      Object.entries(shape.pins).every(([k, v]) => (item as Record<string, unknown>)[k] === v)
    const base = `${casing} ${shape.index} ${JSON.stringify(shape.pins)} ${shape.field}`
    for (const reverse of [false, true]) {
      const suffix = reverse ? " reversed" : ""
      if (shape.where) {
        yield* checkQuery({
          ...args,
          holds: (item) => inPins(item) && oracle(casing, bound, valueOf(item)),
          context: `${base} .where(${bound.op} ${JSON.stringify([bound.a, bound.b])})${suffix}`,
          query: args.accessor(args.pins).where(whereCall(shape.field, bound)),
          reverse,
        })
      }
      for (const within of withinBounds(bound)) {
        for (const maxSkips of [undefined, 0]) {
          yield* checkQuery({
            ...args,
            holds: (item) => inPins(item) && withinOracle(casing, within, valueOf(item)),
            context: `${base} .within(${JSON.stringify(within)}${maxSkips === 0 ? ", maxSkips 0" : ""})${suffix}`,
            query: args
              .accessor(args.pins)
              .within({ [shape.field]: within }, maxSkips === undefined ? undefined : { maxSkips }),
            reverse,
          })
        }
      }
    }
  })

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const Int = (minimum: number, maximum: number) =>
  Schema.Int.check(Schema.isBetween({ minimum, maximum }))

const word = Arbitrary.schema(
  Schema.Array(Int(0, ALPHABET.length - 1)).check(Schema.isBetweenLength(1, 4)),
).pipe(Arbitrary.map((letters) => letters.map((i) => ALPHABET[i]!).join("")))

/**
 * Words around `w`: its prefixes (whole code points), and `w` extended with
 * each escaped character, the first one that isn't (`&`) and a letter — the
 * values whose keys sorted apart from their values up to 1.36.
 */
const around = (w: string): Array<string> => {
  const chars = Array.from(w)
  return [
    ...chars.map((_, i) => chars.slice(0, i + 1).join("")),
    `${w}\u0000`,
    `${w}\u0001`,
    `${w} `,
    `${w} a`,
    `${w}!`,
    `${w}"`,
    `${w}#`,
    `${w}#a`,
    `${w}$`,
    `${w}%`,
    `${w}%20`,
    `${w}&`,
    `${w}a`,
    `${w}A`,
  ]
}

const OPS: ReadonlyArray<Op> = ["eq", "lt", "lte", "gt", "gte", "between", "beginsWith"]

const sample = Arbitrary.all([
  Arbitrary.schema(Int(0, OPS.length - 1)),
  word,
  word,
  Arbitrary.schema(Schema.Array(Int(0, ALPHABET.length - 1)).check(Schema.isBetweenLength(0, 12))),
  Arbitrary.schema(Schema.Array(Int(0, KINDS.length - 1)).check(Schema.isBetweenLength(1, 12))),
])

/** Values from a sample: around the bound's operands, plus a character before `a`. */
const valuesOf = (a: string, b: string, extra: ReadonlyArray<number>) => [
  ...new Set([...around(a), ...around(b), ...extra.map((i) => ALPHABET[i]! + a)]),
]

/** Places from a sample: cities around the bound's operands, kinds and levels spread, every region. */
const placesOf = (values: ReadonlyArray<string>, kinds: ReadonlyArray<number>) =>
  values.flatMap((city, n) =>
    REGIONS.map((region, r): Place => {
      const pick = kinds[(n + r) % kinds.length]!
      return {
        store: "s",
        id: `p-${String(n).padStart(3, "0")}-${r}`,
        region,
        city,
        kind: KINDS[pick]!,
        level: LEVELS[pick % LEVELS.length]!,
      }
    }),
  )

/**
 * Readings from a sample: one per value as a zone, and one per value as a
 * device in each of two zones; one per key (casing folds some together).
 */
const readingsOf = (values: ReadonlyArray<string>, keyOf: (reading: Reading) => string) => {
  const all = values.flatMap(
    (value, n): Array<Reading> => [
      { store: "s", zone: value, device: `d-${n}`, at: 3 },
      { store: "s", zone: "north", device: value, at: 3 },
      { store: "s", zone: "south", device: value, at: 3 },
    ],
  )
  return [...new Map(all.map((reading) => [keyOf(reading), reading])).values()]
}

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

describe("sort key bounds on values holding escaped characters (#171)", () => {
  for (const casing of casings) {
    const places = makePlaces(casing)
    const readings = makeReadings(casing)

    it.effect.prop(
      `.where() and .within() return exactly the rows the bound means (${casing})`,
      { sample },
      ({ sample: [opIndex, w1, w2, extra, kinds] }) =>
        Effect.gen(function* () {
          const op = OPS[opIndex]!
          // `between` low end first, by the cased values: a reversed one is
          // `.where()`'s caller error, which DynamoDB refuses (#144).
          const [a, b] =
            byteOrder(DynamoSchema.applyCasing(w1, casing), DynamoSchema.applyCasing(w2, casing)) <=
            0
              ? [w1, w2]
              : [w2, w1]
          const bound: Bound = { op, a, b }
          const values = valuesOf(a, b, extra)

          const placeItems = placesOf(values, kinds)
          const placesServed = places.serve(placeItems)
          const placeAccessors = yield* places.places.pipe(Effect.provide(placesServed.layer))
          for (const shape of placeShapes) {
            const skField = places.defs[shape.index]!.sk.field
            yield* checkShape({
              casing,
              shape,
              bound,
              accessor: placeAccessors[shape.index]!,
              pins: { store: "s", ...shape.pins },
              served: placesServed,
              items: placeItems,
              idOf: (place) => place.id,
              skOf: (place) => places.keysOf(place)[skField] as string,
            })
          }

          const skOf = (reading: Reading) => readings.keysOf(reading).sk as string
          const readingItems = readingsOf(values, skOf)
          const readingsServed = readings.serve(readingItems)
          const readingAccessors = yield* readings.readings.pipe(
            Effect.provide(readingsServed.layer),
          )
          for (const shape of readingShapes) {
            yield* checkShape({
              casing,
              shape,
              bound,
              accessor: readingAccessors.primary!,
              pins: { store: "s", ...shape.pins },
              served: readingsServed,
              items: readingItems,
              idOf: (reading) => `${reading.zone}|${reading.device}|${reading.at}`,
              skOf,
            })
          }
        }),
      // Every shape, operator and plan per run: 15 seconds per casing here, and up to a minute on
      // a CI runner, so the limit only has to catch a hang.
      { timeout: 180_000, arbitrary: { runs: 150 } },
    )
  }

  it.effect(
    "the connected scenario: new, new york, new!, a#b and 50% on a non-last composite",
    () => {
      const { serve, places } = makePlaces("lowercase")
      const items: ReadonlyArray<Place> = [
        "new",
        "new york",
        "new!",
        "newark",
        "ne",
        "a#b",
        "a",
        "50%",
      ].map((city, n) => ({
        store: "s",
        id: `p-${n}`,
        region: "north",
        city,
        kind: "a",
        level: "a",
      }))
      const { layer } = serve(items)
      const cities = (got: ReadonlyArray<Place>) => got.map((place) => place.city)
      return Effect.gen(function* () {
        const accessor = yield* places
        const where = (bound: Bound) =>
          accessor.cityId!({ store: "s" }).where(whereCall("city", bound)).collect()
        // Key order is value order: `new#` < `new%20york#` < `new%21#` < `newark#`.
        expect(cities(yield* where({ op: "lte", a: "new york", b: "" }))).toEqual([
          "50%",
          "a",
          "a#b",
          "ne",
          "new",
          "new york",
        ])
        expect(cities(yield* where({ op: "lt", a: "new york", b: "" }))).toEqual([
          "50%",
          "a",
          "a#b",
          "ne",
          "new",
        ])
        expect(cities(yield* where({ op: "gt", a: "new", b: "" }))).toEqual([
          "new york",
          "new!",
          "newark",
        ])
        expect(cities(yield* where({ op: "gte", a: "new!", b: "" }))).toEqual(["new!", "newark"])
        expect(cities(yield* where({ op: "lte", a: "new", b: "" }))).toEqual([
          "50%",
          "a",
          "a#b",
          "ne",
          "new",
        ])
        expect(cities(yield* where({ op: "between", a: "new", b: "new!" }))).toEqual([
          "new",
          "new york",
          "new!",
        ])
        // A value holding the delimiter is one value: `a` doesn't match `a#b`.
        expect(cities(yield* where({ op: "eq", a: "a", b: "" }))).toEqual(["a"])
        expect(cities(yield* where({ op: "eq", a: "a#b", b: "" }))).toEqual(["a#b"])
        expect(cities(yield* where({ op: "beginsWith", a: "a#", b: "" }))).toEqual(["a#b"])
        expect(cities(yield* where({ op: "eq", a: "50%", b: "" }))).toEqual(["50%"])
        expect(cities(yield* accessor.cityId!({ store: "s", city: "a" }).collect())).toEqual(["a"])
      }).pipe(Effect.provide(layer)) as Effect.Effect<void, unknown>
    },
  )

  it.effect("a bound on an escaped value is one exact key condition: counts and pages", () => {
    const { serve, places } = makePlaces("lowercase")
    const cities = ["new", "new york", "new!", "newark", "ne", "new  x", "new\u0001", "new#"]
    const items: ReadonlyArray<Place> = cities.flatMap((city, n) =>
      [0, 1, 2].map((k) => ({
        store: "s",
        id: `p-${n}-${k}`,
        region: "north",
        city,
        kind: "a",
        level: "a",
      })),
    )
    const { layer, requests } = serve(items)
    return Effect.gen(function* () {
      const accessor = yield* places
      const query = accessor.cityId!({ store: "s" }).where((t: any, { lte }: any) =>
        lte(t.city, "new york"),
      )
      const explained = yield* query.explain()
      expect(explained.plan).toBe("key")
      expect(explained.rowChecks).toEqual([])
      const prefix = "$places#v1#place#city_"
      expect(explained.keyConditions).toEqual([
        { lower: undefined, upper: `${prefix}new%20york#￿`, exact: true },
      ])
      requests.length = 0
      const all: ReadonlyArray<Place> = yield* query.collect()
      expect(new Set(all.map((place) => place.city))).toEqual(
        new Set(["new", "new york", "ne", "new  x", "new\u0001"]),
      )
      // One request, reading only the rows it returns.
      expect(requests).toHaveLength(1)
      requests.length = 0
      expect(yield* query.count()).toBe(all.length)
      expect(requests.map((input) => input.Select)).toEqual(["COUNT"])
      // Pages of 2 resume where the last one stopped.
      const paged: Array<string> = []
      let cursor = Option.none<string>()
      do {
        const page: Query.Page<Place> = yield* Option.match(cursor, {
          onNone: () => query,
          onSome: (resume) => query.startFrom(resume),
        })
          .limit(2)
          .fetch()
        paged.push(...page.items.map((place) => place.id))
        cursor = page.cursor
      } while (Option.isSome(cursor))
      expect(paged).toEqual(all.map((place) => place.id))
    }).pipe(Effect.provide(layer)) as Effect.Effect<void, unknown>
  })

  it.effect("an empty .within() interval plans no read", () => {
    const { serve, places } = makePlaces("lowercase")
    const items: ReadonlyArray<Place> = ["new", "new york", "new!", "newark"].map((city, n) => ({
      store: "s",
      id: `p-${n}`,
      region: "north",
      city,
      kind: "a",
      level: "a",
    }))
    const { layer, requests } = serve(items)
    return Effect.gen(function* () {
      const accessor = yield* places
      for (const [index, pins] of [
        ["city", {}],
        ["regionCity", north],
        ["cityId", {}],
        ["regionCityId", north],
      ] as const) {
        for (const interval of [
          { gt: "new", lte: "new" },
          { gt: "new", lt: "new" },
          { gte: "new", lt: "new" },
          { gte: "new!", lte: "new" },
          { between: ["new!", "new"] },
        ]) {
          const context = `${index} ${JSON.stringify(interval)}`
          const query = accessor[index]!({ store: "s", ...pins }).within({ city: interval })
          requests.length = 0
          expect((yield* query.explain()).plan, context).toBe("empty")
          expect(yield* query.collect(), context).toEqual([])
          expect(yield* query.count(), context).toBe(0)
          expect(yield* query.reverse().fetch(), context).toEqual({
            items: [],
            cursor: Option.none(),
          })
          expect(requests, context).toEqual([])
        }
      }
    }).pipe(Effect.provide(layer)) as Effect.Effect<void, unknown>
  })
})

// ---------------------------------------------------------------------------
// Requests: 1.36's single condition, over the escaped key text
// ---------------------------------------------------------------------------

/**
 * `composeRangeUnder` as 1.36 composed every bound, from a composite's
 * segment: escaping changes the segment's text alone, never the condition's
 * shape.
 */
const legacy = (
  isLast: boolean,
  prefixText: string,
  segment: (value: unknown) => string,
  bound: RawSortKeyCondition,
  clamped: boolean,
): unknown => {
  const MAX = "￿"
  const compose = (value: unknown) => `${prefixText}${segment(value)}`
  const aboveSubtree = (value: unknown) => `${compose(value)}#${MAX}`
  const upper = (value: unknown) => (isLast ? compose(value) : aboveSubtree(value))
  if ("beginsWith" in bound) return { beginsWith: compose(bound.beginsWith) }
  if ("eq" in bound)
    return isLast ? { eq: compose(bound.eq) } : { beginsWith: `${compose(bound.eq)}#` }
  if ("between" in bound) return { between: [compose(bound.between[0]), upper(bound.between[1])] }
  if (!clamped) {
    if ("lt" in bound) return { lt: compose(bound.lt) }
    if ("lte" in bound) return { lte: upper(bound.lte) }
    if ("gt" in bound) return { gt: isLast ? compose(bound.gt) : aboveSubtree(bound.gt) }
    return { gte: compose(bound.gte) }
  }
  const prefixMax = `${prefixText}${MAX}`
  if ("gte" in bound) return { between: [compose(bound.gte), prefixMax] }
  if ("gt" in bound) return { between: [aboveSubtree(bound.gt), prefixMax] }
  if ("lte" in bound) return { between: [prefixText, upper(bound.lte)] }
  return { between: [prefixText, compose(bound.lt)] }
}

describe("composeRangeUnder sends 1.36's condition over the escaped key text", () => {
  const prefixText = "$places#v1#place#region_north#"
  const LETTERS = ["$", "0", "9", "A", "a", "b", "-", ".", ":", "&", "É"]
  const textOf = (alphabet: ReadonlyArray<string>) =>
    Arbitrary.schema(
      Schema.Array(Int(0, alphabet.length - 1)).check(Schema.isBetweenLength(1, 5)),
    ).pipe(Arbitrary.map((letters) => letters.map((i) => alphabet[i]!).join("")))
  const conditions = (a: unknown, b: unknown): ReadonlyArray<RawSortKeyCondition> => [
    { eq: a },
    { lt: a },
    { lte: a },
    { gt: a },
    { gte: a },
    { between: [a, b] },
    { beginsWith: a },
  ]

  it.prop(
    "every operator, every casing, last or not, clamped or not",
    {
      a: textOf(ALPHABET),
      b: textOf(ALPHABET),
      plainA: textOf(LETTERS.filter((c) => c !== "$")),
      plainB: textOf(LETTERS.filter((c) => c !== "$")),
      n: Schema.Number.check(Schema.isFinite()),
      m: Schema.Number.check(Schema.isFinite()),
    },
    ({ a, b, plainA, plainB, n, m }) => {
      for (const casing of casings) {
        const schema = DynamoSchema.make({ name: "app", version: 1, casing, escapeKeys: true })
        const escaped = (value: unknown) =>
          `${DynamoSchema.applyCasing("city", casing)}_${KeyComposer.keyValueText(schema, value, casing)}`
        // 1.36's segment: the value as it was, cased.
        const unescaped = (value: unknown) =>
          `${DynamoSchema.applyCasing("city", casing)}_${DynamoSchema.applyCasing(KeyComposer.serializeValue(value), casing)}`
        for (const [x, y, plain] of [
          [a, b, false],
          [plainA, plainB, true],
          [n, m, true],
        ] as const) {
          for (const bound of conditions(x, y)) {
            for (const isLast of [false, true]) {
              for (const clamped of [false, true]) {
                const composed = composeRangeUnder(
                  { schema, casing, isLast, secondary: false },
                  prefixText,
                  "city",
                  bound,
                  { clampToPrefix: clamped },
                )
                // 1.36 refused a strict `lt` on a clamped last composite
                // (EDD-9046): BETWEEN's inclusive high end is now the greatest
                // key text below the value. A number's `beginsWith` is `eq`.
                const shape: RawSortKeyCondition =
                  "beginsWith" in bound && typeof bound.beginsWith === "number"
                    ? { eq: bound.beginsWith }
                    : bound
                const want =
                  isLast && clamped && "lt" in shape
                    ? { between: [prefixText, keyJustBelow(`${prefixText}${escaped(shape.lt)}`)] }
                    : legacy(isLast, prefixText, escaped, shape, clamped)
                const context = JSON.stringify({ casing, bound, isLast, clamped })
                expect(composed, context).toEqual(want)
                // A value without an escaped character keeps its 1.36 bytes.
                if (plain && !(isLast && clamped && "lt" in shape)) {
                  expect(composed, context).toEqual(
                    legacy(isLast, prefixText, unescaped, shape, clamped),
                  )
                }
              }
            }
          }
        }
      }
    },
    { arbitrary: { runs: 300 } },
  )
})
