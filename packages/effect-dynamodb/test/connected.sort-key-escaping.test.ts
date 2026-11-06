/**
 * #171 sort key escaping and E7 against DynamoDB Local, where DynamoDB's own
 * byte order of the stored keys — and its acceptance of the key conditions
 * sent — is what's under test.
 *
 * - Escaping: a sort key composite's text escapes every character up to `%`
 *   (`new york` is `new%20york`, `a#b` is `a%23b`, `50%` is `50%25`), so key
 *   order is value order. Up to 1.36 `new york#…` sorted before `new#…`, and
 *   `a#b` split into two segments. Every operator, through `.where()` and
 *   `.within()`, on a non-last and a last composite, clamped under a pinned
 *   one or not, forward and reverse, in lowercase and uppercase keys, returns
 *   exactly the rows whose value satisfies it — and on a time-series primary
 *   key, whose events sort inside each item's subtree — in one key
 *   condition. A strict `lt` on a clamped last composite sends a `BETWEEN`
 *   whose high end ends in U+10FFFF; an empty `.within()` interval sends
 *   nothing. `.history().where()` on a string orderBy returns exactly the
 *   events each operator means, an emoji-leading stamp among them.
 * - E7: a fully pinned primary key is `=` beside version snapshots and
 *   tombstones written by the library; an empty-composite half (canonical
 *   shape 6) keeps sending the partition key alone, returning live rows only.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 */

import { it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Config, Effect, Layer, Option, Schema } from "effect"
import { afterAll, beforeAll, describe, expect } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import { compareUtf8 } from "../src/internal/RangePlanner.js"
import type * as Query from "../src/Query.js"
import * as Table from "../src/Table.js"

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

const AppSchema = DynamoSchema.make({ name: "sk-escape", version: 1, escapeKeys: true })
/** The same places keyed in uppercase, in the same table under their own schema name. */
const UpperSchema = DynamoSchema.make({
  name: "sk-escape-upper",
  version: 1,
  casing: "uppercase",
  escapeKeys: true,
})
const tableName = `sk-escape-${Date.now()}`

class Place extends Schema.Class<Place>("Place")({
  store: Schema.String,
  id: Schema.String,
  region: Schema.String,
  city: Schema.String,
}) {}

/** `city` on every shape a bound can take: non-last / last, clamped or not. */
const placesEntity = () =>
  Entity.make({
    model: Place,
    entityType: "Place",
    primaryKey: {
      pk: { field: "pk", composite: ["store"] },
      sk: { field: "sk", composite: ["id"] },
    },
    indexes: {
      cityId: {
        name: "gsi1",
        pk: { field: "gsi1pk", composite: ["store"] },
        sk: { field: "gsi1sk", composite: ["city", "id"] },
      },
      regionCityId: {
        name: "gsi2",
        pk: { field: "gsi2pk", composite: ["store"] },
        sk: { field: "gsi2sk", composite: ["region", "city", "id"] },
      },
      city: {
        name: "gsi3",
        pk: { field: "gsi3pk", composite: ["store"] },
        sk: { field: "gsi3sk", composite: ["city"] },
      },
      regionCity: {
        name: "gsi4",
        pk: { field: "gsi4pk", composite: ["store"] },
        sk: { field: "gsi4sk", composite: ["region", "city"] },
      },
    },
  })
const Places = placesEntity()
const UpperPlaces = placesEntity()

class Reading extends Schema.Class<Reading>("Reading")({
  site: Schema.String,
  zone: Schema.String,
  device: Schema.String,
  at: Schema.Number,
}) {}

/** A time-series primary key `[zone, device]`: each item's events extend its key. */
const Readings = Entity.make({
  model: Reading,
  entityType: "Reading",
  primaryKey: {
    pk: { field: "pk", composite: ["site"] },
    sk: { field: "sk", composite: ["zone", "device"] },
  },
  timeSeries: {
    orderBy: "at",
    appendInput: Schema.Struct({
      site: Schema.String,
      zone: Schema.String,
      device: Schema.String,
      at: Schema.Number,
    }),
  },
})

class Note extends Schema.Class<Note>("Note")({
  deviceId: Schema.String,
  channel: Schema.String,
  stamp: Schema.String,
}) {}

/** A string orderBy: `.history().where()` bounds the event key's last segment. */
const Notes = Entity.make({
  model: Note,
  entityType: "Note",
  primaryKey: {
    pk: { field: "pk", composite: ["deviceId"] },
    sk: { field: "sk", composite: ["channel"] },
  },
  timeSeries: {
    orderBy: "stamp",
    appendInput: Schema.Struct({
      deviceId: Schema.String,
      channel: Schema.String,
      stamp: Schema.String,
    }),
  },
})

class Doc extends Schema.Class<Doc>("Doc")({
  ownerId: Schema.String,
  name: Schema.String,
  plan: Schema.String,
}) {}

/** Version snapshots and tombstones beside the live rows, and a shape-6 GSI. */
const Docs = Entity.make({
  model: Doc,
  entityType: "Doc",
  primaryKey: {
    pk: { field: "pk", composite: ["ownerId"] },
    sk: { field: "sk", composite: ["name"] },
  },
  indexes: {
    byPlan: {
      name: "gsi5",
      pk: { field: "gsi5pk", composite: ["plan"] },
      sk: { field: "gsi5sk", composite: [] },
    },
  },
  versioned: { retain: true },
  softDelete: true,
})

class Profile extends Schema.Class<Profile>("Profile")({
  ownerId: Schema.String,
  plan: Schema.String,
}) {}

/** An empty-composite primary sort key: its history rows extend the live key. */
const Profiles = Entity.make({
  model: Profile,
  entityType: "Profile",
  primaryKey: {
    pk: { field: "pk", composite: ["ownerId"] },
    sk: { field: "sk", composite: [] },
  },
  versioned: { retain: true },
  softDelete: true,
})

const MainTable = Table.make({
  schema: AppSchema,
  entities: { Places, Docs, Profiles, Readings, Notes },
})
const UpperTable = Table.make({ schema: UpperSchema, entities: { Places: UpperPlaces } })

const ClientLayer = DynamoClient.layer({
  region: "us-east-1",
  endpoint: ENDPOINT,
  credentials: { accessKeyId: "local", secretAccessKey: "local" },
})
const TestLayer = Layer.mergeAll(
  ClientLayer,
  MainTable.layer({ name: tableName }),
  UpperTable.layer({ name: tableName }),
)
const provide = Effect.provide(TestLayer)

const makeDb = DynamoClient.make({
  entities: { Places, Docs, Profiles, Readings, Notes },
  tables: { MainTable },
})
const makeUpperDb = DynamoClient.make({ entities: { Places: UpperPlaces }, tables: { UpperTable } })

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

/**
 * Values that extend `new` with a character a key escapes, and their
 * neighbours; a value holding the delimiter (`a#b`, which extends `a`) and
 * one holding the escape character (`50%`).
 */
const CITIES = [
  "ne",
  "new",
  "new york",
  "new!",
  'new"',
  "new  x",
  "new$",
  "newark",
  "New Haven",
  "nex",
  "a",
  "a#b",
  "50%",
]

const PLACES = CITIES.flatMap((city, n) =>
  (["north", "south"] as const).map(
    (region) => new Place({ store: "s-1", id: `p-${n}-${region}`, region, city }),
  ),
)

/** Readings: each city a zone (device `d-1`), and a device in zones `north` and `south`. */
const READINGS = CITIES.flatMap((city) => [
  { site: "s-1", zone: city, device: "d-1" },
  { site: "s-1", zone: "north", device: city },
  { site: "s-1", zone: "south", device: city },
])

/**
 * Stamps that extend `a` with escaped characters, their neighbours, and emoji
 * — and the empty stamp, whose event key is the events' prefix itself.
 */
const STAMPS = [
  "",
  "a",
  "a b",
  "a!",
  'a"',
  "a#",
  "a#b",
  "a$",
  "a%",
  "aC",
  "ab",
  "a\u{1F600}",
  "b",
  "\u{1F600}",
]

type Op = "eq" | "lt" | "lte" | "gt" | "gte" | "between" | "beginsWith"
type Bound = { readonly op: Op; readonly a: string; readonly b: string }
type Casing = DynamoSchema.Casing

/** Does `value` satisfy `bound`, comparing the cased values' bytes? */
const oracle = (casing: Casing, bound: Bound, value: string): boolean => {
  const cased = (text: string) => DynamoSchema.applyCasing(text, casing)
  const against = (operand: string) => compareUtf8(cased(value), cased(operand))
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
      return cased(value).startsWith(cased(bound.a))
  }
}

/** Every operator on each of `operands`, `between` low end first under `casing`. */
const boundsOf = (casing: Casing, operands: ReadonlyArray<string>): ReadonlyArray<Bound> => {
  const cased = (text: string) => DynamoSchema.applyCasing(text, casing)
  return operands.flatMap((a) => [
    ...(["eq", "lt", "lte", "gt", "gte", "beginsWith"] as const).map((op) => ({ op, a, b: "" })),
    ...operands
      .filter((b) => compareUtf8(cased(a), cased(b)) <= 0)
      .map((b) => ({ op: "between" as const, a, b })),
  ])
}

const OPERANDS = ["new", "new york", "new!", "new ", "newa", "ne", "a", "a#", "a#b", "50%"]

const SHAPES = [
  { index: "cityId", pins: {} },
  { index: "regionCityId", pins: { region: "north" } },
  { index: "city", pins: {} },
  { index: "regionCity", pins: { region: "north" } },
] as const

const whereOf =
  (field: string, bound: Bound) =>
  (t: any, ops: any): unknown =>
    bound.op === "between"
      ? ops.between(t[field], bound.a, bound.b)
      : ops[bound.op](t[field], bound.a)

const withinOf = (bound: Bound) =>
  bound.op === "between" ? { between: [bound.a, bound.b] } : { [bound.op]: bound.a }

describeConnected("#171 sort key escaping and E7 — connected", () => {
  beforeAll(async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* DynamoClient
        yield* client.createTable({
          TableName: tableName,
          BillingMode: "PAY_PER_REQUEST",
          ...Table.definition(MainTable),
        })
        const db = yield* makeDb
        const upper = yield* makeUpperDb
        yield* Effect.forEach(
          PLACES,
          (place) =>
            Effect.andThen(
              db.entities.Places.put(place).asEffect(),
              upper.entities.Places.put(place).asEffect(),
            ),
          { concurrency: 8 },
        )
        // Readings: at 1, 2 and 3 — the item, after two events of its own.
        yield* Effect.forEach(
          READINGS,
          (reading) =>
            Effect.forEach([1, 2, 3], (at) =>
              db.entities.Readings.append({ ...reading, at }).asEffect(),
            ),
          { concurrency: 8 },
        )
        // Notes: every stamp an event of channels "a" and "b", in stored order
        // (an append older than the item's stamp is not applied).
        for (const channel of ["a", "b"]) {
          for (const stamp of [...STAMPS].sort(compareUtf8)) {
            yield* db.entities.Notes.append({ deviceId: "d-1", channel, stamp }).asEffect()
          }
        }
        // Docs: "a" at version 3 (two snapshots), "ab", "a b" and "a#b" live, "ac" deleted.
        for (const name of ["a", "ab", "a b", "a#b", "ac"]) {
          yield* db.entities.Docs.put(new Doc({ ownerId: "o-1", name, plan: "pro" })).asEffect()
        }
        for (const plan of ["free", "pro"]) {
          yield* db.entities.Docs.update({ ownerId: "o-1", name: "a" }).set({ plan }).asEffect()
        }
        yield* db.entities.Docs.delete({ ownerId: "o-1", name: "ac" }).asEffect()
        // Profiles: o-1 at version 3, o-2 deleted.
        for (const ownerId of ["o-1", "o-2"]) {
          yield* db.entities.Profiles.put(new Profile({ ownerId, plan: "free" })).asEffect()
        }
        for (const plan of ["team", "pro"]) {
          yield* db.entities.Profiles.update({ ownerId: "o-1" }).set({ plan }).asEffect()
        }
        yield* db.entities.Profiles.delete({ ownerId: "o-2" }).asEffect()
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

  it.effect('"new", "new york", "new!", "a#b" and "50%": the rows each bound means', () =>
    Effect.gen(function* () {
      const db = yield* makeDb
      const where = (bound: Bound) =>
        db.entities.Places.cityId({ store: "s-1" })
          .where((t, ops) =>
            bound.op === "between"
              ? ops.between(t.city, bound.a, bound.b)
              : ops[bound.op](t.city, bound.a),
          )
          .collect()
      const cities = (places: ReadonlyArray<Place>) => [...new Set(places.map((p) => p.city))]
      // Key order is value order (casing folds `New Haven`): `new#` <
      // `new%20%20x#` < `new%20haven#` < `new%20york#` < `new%21#` < `new%22#`
      // < `new%24#` < `newark#`.
      expect(cities(yield* where({ op: "lte", a: "new york", b: "" }))).toEqual([
        "50%",
        "a",
        "a#b",
        "ne",
        "new",
        "new  x",
        "New Haven",
        "new york",
      ])
      expect(cities(yield* where({ op: "gt", a: "new", b: "" }))).toEqual([
        "new  x",
        "New Haven",
        "new york",
        "new!",
        'new"',
        "new$",
        "newark",
        "nex",
      ])
      expect(cities(yield* where({ op: "between", a: "new", b: "new!" }))).toEqual([
        "new",
        "new  x",
        "New Haven",
        "new york",
        "new!",
      ])
      // A value holding the delimiter is one value, and `a` is not `a#b`.
      expect(cities(yield* where({ op: "eq", a: "a", b: "" }))).toEqual(["a"])
      expect(cities(yield* where({ op: "eq", a: "a#b", b: "" }))).toEqual(["a#b"])
      expect(cities(yield* where({ op: "beginsWith", a: "a#", b: "" }))).toEqual(["a#b"])
      expect(cities(yield* where({ op: "eq", a: "50%", b: "" }))).toEqual(["50%"])
      expect(
        cities(yield* db.entities.Places.cityId({ store: "s-1", city: "a" }).collect()),
      ).toEqual(["a"])
      // The stored keys, escaped; the partition key and the attribute are not.
      const client = yield* DynamoClient
      const stored = yield* client.getItem({
        TableName: tableName,
        Key: {
          pk: { S: "$sk-escape#v1#place#store_s-1" },
          sk: { S: "$sk-escape#v1#place#id_p-11-north" },
        },
      })
      expect(stored.Item?.city).toEqual({ S: "a#b" })
      expect(stored.Item?.gsi1pk).toEqual({ S: "$sk-escape#v1#place#store_s-1" })
      expect(stored.Item?.gsi1sk).toEqual({ S: "$sk-escape#v1#place#city_a%23b#id_p-11-north" })
      expect(stored.Item?.gsi2sk).toEqual({
        S: "$sk-escape#v1#place#region_north#city_a%23b#id_p-11-north",
      })
    }).pipe(provide),
  )

  it.effect(
    "every operator on every shape, .where() and .within(), forward and reverse, both casings",
    () =>
      Effect.gen(function* () {
        for (const [casing, db] of [
          ["lowercase", yield* makeDb],
          ["uppercase", yield* makeUpperDb],
        ] as const) {
          const accessors = db.entities.Places as unknown as Record<string, (pins: object) => any>
          for (const shape of SHAPES) {
            const inPins = (place: Place) =>
              Object.entries(shape.pins).every(([k, v]) => place[k as keyof Place] === v)
            for (const bound of boundsOf(casing, OPERANDS)) {
              const want = PLACES.filter(
                (place) => inPins(place) && oracle(casing, bound, place.city),
              )
                .map((place) => place.id)
                .sort()
              const accessor = () => accessors[shape.index]!({ store: "s-1", ...shape.pins })
              const queries: Array<[string, any]> = [
                [".where()", accessor().where(whereOf("city", bound))],
              ]
              if (bound.op !== "beginsWith") {
                queries.push([".within()", accessor().within({ city: withinOf(bound) })])
              }
              for (const [via, query] of queries) {
                for (const reverse of [false, true]) {
                  const got: ReadonlyArray<Place> = yield* (
                    reverse ? query.reverse() : query
                  ).collect()
                  expect(
                    got.map((place) => place.id).sort(),
                    `${casing} ${shape.index} ${via} ${JSON.stringify(bound)}${reverse ? " reversed" : ""}`,
                  ).toEqual(want)
                }
              }
            }
          }
        }
      }).pipe(provide) as Effect.Effect<void, unknown>,
    240_000,
  )

  it.effect(
    "a time-series primary key: bounds on [zone, device] skip every item's events",
    () =>
      Effect.gen(function* () {
        const db = yield* makeDb
        const casing = AppSchema.casing
        const primary = (pins: object) =>
          (db.entities.Readings as unknown as { primary: (pins: object) => any }).primary({
            site: "s-1",
            ...pins,
          })
        const shapes = [
          // non-last: `.where()` and the key plan
          { field: "zone", pins: {}, where: true },
          // last, clamped under `zone`
          { field: "device", pins: { zone: "north" }, where: true },
          // tupled over `zone` on a primary key with history rows: the filter plan
          { field: "device", pins: {}, where: false },
        ] as const
        for (const shape of shapes) {
          const inPins = (reading: (typeof READINGS)[number]) =>
            Object.entries(shape.pins).every(([k, v]) => reading[k as keyof typeof reading] === v)
          for (const bound of boundsOf(casing, OPERANDS)) {
            const want = READINGS.filter(
              (reading) => inPins(reading) && oracle(casing, bound, reading[shape.field]),
            )
              .map((reading) => `${reading.zone}|${reading.device}|3`)
              .sort()
            const queries: Array<[string, any]> = []
            if (shape.where) {
              queries.push([".where()", primary(shape.pins).where(whereOf(shape.field, bound))])
            }
            if (bound.op !== "beginsWith") {
              queries.push([
                ".within()",
                primary(shape.pins).within({ [shape.field]: withinOf(bound) }),
              ])
            }
            for (const [via, query] of queries) {
              for (const reverse of [false, true]) {
                const got: ReadonlyArray<Reading> = yield* (
                  reverse ? query.reverse() : query
                ).collect()
                expect(
                  got.map((reading) => `${reading.zone}|${reading.device}|${reading.at}`).sort(),
                  `${shape.field} ${JSON.stringify(shape.pins)} ${via} ${JSON.stringify(bound)}${reverse ? " reversed" : ""}`,
                ).toEqual(want)
              }
            }
          }
        }
      }).pipe(provide) as Effect.Effect<void, unknown>,
    240_000,
  )

  it.effect(".history().where() on a string orderBy returns exactly the events it means", () =>
    Effect.gen(function* () {
      const db = yield* makeDb
      const casing = AppSchema.casing
      const cased = (text: string) => DynamoSchema.applyCasing(text, casing)
      const order = (a: string, b: string) => compareUtf8(cased(a), cased(b))
      for (const bound of boundsOf(casing, [...STAMPS, "a ", "c"])) {
        const want = STAMPS.filter((stamp) => oracle(casing, bound, stamp)).sort(order)
        for (const reverse of [false, true]) {
          const query = db.entities.Notes.history({ deviceId: "d-1", channel: "a" }).where(
            whereOf("stamp", bound) as never,
          )
          const got = yield* (reverse ? query.reverse() : query).collect()
          expect(
            got.map((note) => `${note.channel}:${note.stamp}`),
            `${JSON.stringify(bound)}${reverse ? " reversed" : ""}`,
          ).toEqual((reverse ? [...want].reverse() : want).map((stamp) => `a:${stamp}`))
        }
      }
    }).pipe(provide),
  )

  it.effect(
    "an empty .within() interval on a last composite sends nothing",
    () =>
      Effect.gen(function* () {
        const db = yield* makeDb
        const accessors = db.entities.Places as unknown as Record<string, (pins: object) => any>
        for (const [index, pins] of [
          ["city", {}],
          ["regionCity", { region: "north" }],
        ] as const) {
          for (const city of [
            { gt: "new", lte: "new" },
            { gt: "new", lt: "new" },
            { gte: "new!", lte: "new" },
          ]) {
            const query = accessors[index]!({ store: "s-1", ...pins }).within({ city })
            const context = `${index} ${JSON.stringify(city)}`
            expect((yield* query.explain()).plan, context).toBe("empty")
            expect(yield* query.collect(), context).toEqual([])
            expect(yield* query.count(), context).toBe(0)
          }
          // One step wider, the same ends hold the values between them.
          const got: ReadonlyArray<Place> = yield* accessors[index]!({ store: "s-1", ...pins })
            .within({ city: { gt: "new", lte: "new!" } })
            .collect()
          expect(new Set(got.map((place) => place.city))).toEqual(
            new Set(["new  x", "New Haven", "new york", "new!"]),
          )
        }
      }).pipe(provide) as Effect.Effect<void, unknown>,
  )

  it.effect("a bound on escaped values is one key condition: counts and pages", () =>
    Effect.gen(function* () {
      const db = yield* makeDb
      const query = db.entities.Places.regionCityId({ store: "s-1", region: "north" }).where(
        (t, { lte }) => lte(t.city, "new york"),
      )
      const explained = yield* query.explain()
      expect(explained.plan).toBe("key")
      expect(explained.rowChecks).toEqual([])
      expect(explained.keyConditions).toEqual([
        {
          lower: "$sk-escape#v1#place#region_north#",
          upper: "$sk-escape#v1#place#region_north#city_new%20york#\uFFFF",
          exact: true,
        },
      ])
      const all = yield* query.collect()
      expect(all.map((place) => place.city)).toEqual([
        "50%",
        "a",
        "a#b",
        "ne",
        "new",
        "new  x",
        "New Haven",
        "new york",
      ])
      expect(yield* query.count()).toBe(all.length)
      const paged: Array<string> = []
      let cursor = Option.none<string>()
      do {
        const page: Query.Page<Place> = yield* Option.match(cursor, {
          onNone: () => query,
          onSome: (resume) => query.startFrom(resume),
        })
          .limit(1)
          .fetch()
        paged.push(...page.items.map((place) => place.id))
        cursor = page.cursor
      } while (Option.isSome(cursor))
      expect(paged).toEqual(all.map((place) => place.id))
    }).pipe(provide),
  )

  it.effect(
    "a fully pinned primary key returns the live row beside its snapshots and tombstones",
    () =>
      Effect.gen(function* () {
        const db = yield* makeDb
        for (const reverse of [false, true]) {
          const query = db.entities.Docs.primary({ ownerId: "o-1", name: "a" })
          const got = yield* (reverse ? query.reverse() : query).collect()
          expect(got.map((doc) => `${doc.name}:${doc.plan}`)).toEqual(["a:pro"])
        }
        expect(yield* db.entities.Docs.primary({ ownerId: "o-1", name: "ac" }).collect()).toEqual(
          [],
        )
        const all = yield* db.entities.Docs.primary({ ownerId: "o-1" }).collect()
        expect(all.map((doc) => doc.name)).toEqual(["a", "a b", "a#b", "ab"])
        // Pinned to `a`, neither `a b` nor `a#b`: `=` on `name_a`.
        expect(
          (yield* db.entities.Docs.primary({ ownerId: "o-1", name: "a#b" }).collect()).map(
            (doc) => doc.name,
          ),
        ).toEqual(["a#b"])
      }).pipe(provide),
  )

  it.effect("an empty-composite half returns live rows only", () =>
    Effect.gen(function* () {
      const db = yield* makeDb
      const profiles = yield* db.entities.Profiles.primary({ ownerId: "o-1" }).collect()
      expect(profiles.map((profile) => profile.plan)).toEqual(["pro"])
      expect(yield* db.entities.Profiles.primary({ ownerId: "o-2" }).collect()).toEqual([])
      const docs = yield* db.entities.Docs.byPlan({ plan: "pro" }).collect()
      expect(docs.map((doc) => doc.name).sort()).toEqual(["a", "a b", "a#b", "ab"])
    }).pipe(provide),
  )
})
