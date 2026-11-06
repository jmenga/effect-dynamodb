/**
 * A truncated row at its own level (#183) — connected tests against DynamoDB Local.
 *
 * A sort key stops at its last present composite (DESIGN.md §7), so `city_sf` is both
 * a row of its own and the parent of `city_sf#block_1`. A pin on a composite that
 * isn't the last means that row and everything under it, and nothing else: a
 * `begins_with` on `city_sf#` missed the row itself, while one on `city_sf` would
 * catch the sibling `city_sfx`. That holds with `escapeKeys: true`: off, a pin reads
 * `begins_with(city_sf#)` as 1.36 did, and the truncated row isn't under it, which is pinned
 * here too. Each read below runs on real writes and a real index.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 */

import { it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Config, Effect, Layer, Option, Schema, Stream } from "effect"
import { afterAll, beforeAll, describe, expect } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Query from "../src/Query.js"
import * as Table from "../src/Table.js"

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

class Place extends Schema.Class<Place>("Place")({
  siteId: Schema.String,
  region: Schema.String,
  country: Schema.optional(Schema.String),
  city: Schema.optional(Schema.String),
  block: Schema.optional(Schema.String),
  note: Schema.optional(Schema.String),
}) {}

const placesOn = (schema: DynamoSchema.DynamoSchema) => {
  const Places = Entity.make({
    model: Place,
    entityType: "Place",
    primaryKey: {
      pk: { field: "pk", composite: ["siteId"] },
      sk: { field: "sk", composite: [] },
    },
    indexes: {
      byPlace: {
        name: "gsi1",
        pk: { field: "gsi1pk", composite: ["region"] },
        sk: { field: "gsi1sk", composite: ["country", "city", "block"] },
      },
    },
  })
  return { Places, MainTable: Table.make({ schema, entities: { Places } }) }
}

const stamp = Date.now()
const ClientLayer = DynamoClient.layer({
  region: "us-east-1",
  endpoint: ENDPOINT,
  credentials: { accessKeyId: "local", secretAccessKey: "local" },
})

const AppSchema = DynamoSchema.make({ name: "truncated", version: 1, escapeKeys: true })
const On = placesOn(AppSchema)
const onTable = `truncated-on-${stamp}`
const provideOn = Effect.provide(Layer.mergeAll(ClientLayer, On.MainTable.layer({ name: onTable })))
const onClient = DynamoClient.make({
  entities: { Places: On.Places },
  tables: { MainTable: On.MainTable },
})

const OffSchema = DynamoSchema.make({ name: "truncated", version: 1, escapeKeys: false })
const Off = placesOn(OffSchema)
const offTable = `truncated-off-${stamp}`
const provideOff = Effect.provide(
  Layer.mergeAll(ClientLayer, Off.MainTable.layer({ name: offTable })),
)
const offClient = DynamoClient.make({
  entities: { Places: Off.Places },
  tables: { MainTable: Off.MainTable },
})

const ids = (rows: ReadonlyArray<{ readonly siteId: string }>) => rows.map((row) => row.siteId)

const REGION = "r"

/**
 * `sf` truncated at its own level; a child, a sibling that extends the text, a
 * sibling that escapes to a byte above `#`, the parent's own row, and another country.
 * In index order: `us`, `us#city_sf`, `us#city_sf#block_1`, `us#city_sf#block_2`,
 * `us#city_sf%20x`, `us#city_sfx`, `usa#city_sf`.
 */
const seedRows: ReadonlyArray<Place> = [
  new Place({ siteId: "own", region: REGION, country: "us", city: "sf" }),
  new Place({ siteId: "child-1", region: REGION, country: "us", city: "sf", block: "1" }),
  new Place({ siteId: "child-2", region: REGION, country: "us", city: "sf", block: "2" }),
  new Place({ siteId: "extends", region: REGION, country: "us", city: "sfx" }),
  new Place({ siteId: "spaced", region: REGION, country: "us", city: "sf x" }),
  new Place({ siteId: "parent", region: REGION, country: "us" }),
  new Place({ siteId: "other", region: REGION, country: "usa", city: "sf" }),
]

/**
 * Write `row`. A put enters an index only with every composite present (a truncated
 * key comes from an update, DESIGN.md §7), so a row missing its trailing composites
 * goes in whole, then an update names its parents and removes the rest.
 */
const seedPlace = (places: any, row: Place) =>
  Effect.gen(function* () {
    const absent = (["city", "block"] as const).filter((attr) => row[attr] === undefined)
    const filler = Object.fromEntries(absent.map((attr) => [attr, "seed"]))
    const { siteId, ...named } = { ...row }
    yield* places.put({ siteId, ...named, ...filler }).asEffect()
    if (absent.length > 0) yield* places.update({ siteId }).set(named).remove(absent).asEffect()
  })

const ALL_ORDER = ["parent", "own", "child-1", "child-2", "spaced", "extends", "other"]
const CITY_ORDER = ["own", "child-1", "child-2"]

const worlds = [{ client: onClient, provide: provideOn, world: On, table: onTable }] as const

describeConnected("#183 a pin on a truncated row's own level", () => {
  beforeAll(async () => {
    for (const { world, table, client, provide } of worlds) {
      await Effect.runPromise(
        Effect.gen(function* () {
          const raw = yield* DynamoClient
          yield* raw.createTable({
            TableName: table,
            BillingMode: "PAY_PER_REQUEST",
            ...Table.definition(world.MainTable as never),
          })
          const db = yield* client as unknown as Effect.Effect<any, never, any>
          for (const row of seedRows) yield* seedPlace(db.entities.Places, row)
        }).pipe(provide as never) as Effect.Effect<void, unknown>,
      )
    }
  }, 60_000)

  afterAll(async () => {
    for (const { table, provide } of worlds) {
      await Effect.runPromise(
        Effect.gen(function* () {
          const raw = yield* DynamoClient
          yield* raw.deleteTable({ TableName: table })
        }).pipe(provide as never, Effect.ignore) as Effect.Effect<void>,
      )
    }
  }, 30_000)

  for (const { client, provide, table } of worlds) {
    const places = <A, E>(
      body: (places: any, db: any) => Effect.Effect<A, E, any>,
    ): Effect.Effect<void, unknown> =>
      Effect.gen(function* () {
        const db = yield* client as unknown as Effect.Effect<any, never, any>
        yield* body(db.entities.Places, db)
      }).pipe(provide as never) as Effect.Effect<void, unknown>

    describe("with escapeKeys: true", () => {
      it.live(
        "stored keys: truncated at the last present composite",
        () =>
          Effect.gen(function* () {
            const raw = yield* DynamoClient
            const { Items = [] } = yield* raw.scan({ TableName: table })
            const keyOf = (siteId: string) =>
              Items.find((item) => item.siteId?.S === siteId)?.gsi1sk?.S
            expect(keyOf("own")).toBe("$truncated#v1#place#country_us#city_sf")
            expect(keyOf("parent")).toBe("$truncated#v1#place#country_us")
            expect(keyOf("child-1")).toBe("$truncated#v1#place#country_us#city_sf#block_1")
          }).pipe(provide as never) as Effect.Effect<void, unknown>,
      )

      it.live("each level returns its row and its subtree, and no sibling", () =>
        places((devices) =>
          Effect.gen(function* () {
            expect(ids(yield* devices.byPlace({ region: REGION }).collect())).toEqual(ALL_ORDER)
            expect(
              ids(yield* devices.byPlace({ region: REGION, country: "us" }).collect()),
            ).toEqual(ALL_ORDER.slice(0, -1))
            expect(
              ids(yield* devices.byPlace({ region: REGION, country: "us", city: "sf" }).collect()),
            ).toEqual(CITY_ORDER)
            expect(
              ids(yield* devices.byPlace({ region: REGION, country: "us", city: "sfx" }).collect()),
            ).toEqual(["extends"])
            expect(
              ids(
                yield* devices.byPlace({ region: REGION, country: "us", city: "sf x" }).collect(),
              ),
            ).toEqual(["spaced"])
            expect(
              ids(yield* devices.byPlace({ region: REGION, country: "usa" }).collect()),
            ).toEqual(["other"])
          }),
        ),
      )

      it.live("a full pin is the one row", () =>
        places((devices) =>
          Effect.gen(function* () {
            const found = yield* devices
              .byPlace({ region: REGION, country: "us", city: "sf", block: "1" })
              .collect()
            expect(ids(found)).toEqual(["child-1"])
          }),
        ),
      )

      it.live("a pin in another case finds the same rows", () =>
        places((devices) =>
          Effect.gen(function* () {
            const found = yield* devices
              .byPlace({ region: "R", country: "US", city: "SF" })
              .collect()
            expect(ids(found)).toEqual(CITY_ORDER)
          }),
        ),
      )

      it.live("`.where(eq)` on a composite that isn't the last means the same", () =>
        places((devices) =>
          Effect.gen(function* () {
            const found = yield* devices
              .byPlace({ region: REGION, country: "us" })
              .where((t: any, { eq }: any) => eq(t.city, "sf"))
              .collect()
            expect(ids(found)).toEqual(CITY_ORDER)
          }),
        ),
      )

      it.live("`.where(between(sf, sf))` and `.where(eq)` agree", () =>
        places((devices) =>
          Effect.gen(function* () {
            const between = yield* devices
              .byPlace({ region: REGION, country: "us" })
              .where((t: any, { between }: any) => between(t.city, "sf", "sf"))
              .collect()
            expect(ids(between)).toEqual(CITY_ORDER)
          }),
        ),
      )

      it.live("`.within()` on an equal composite means the same", () =>
        places((devices) =>
          Effect.gen(function* () {
            const pinned = devices.byPlace({ region: REGION, country: "us" })
            expect(ids(yield* pinned.within({ city: { eq: "sf" } }).collect())).toEqual(CITY_ORDER)
            const below = yield* devices
              .byPlace({ region: REGION })
              .within({ country: { eq: "us" }, city: { eq: "sf" } })
              .collect()
            expect(ids(below)).toEqual(CITY_ORDER)
          }),
        ),
      )

      it.live("reverse, count, select and a limit", () =>
        places((devices) =>
          Effect.gen(function* () {
            const pin = () => devices.byPlace({ region: REGION, country: "us", city: "sf" })
            expect(ids(yield* pin().reverse().collect())).toEqual([...CITY_ORDER].reverse())
            expect(yield* pin().count()).toBe(CITY_ORDER.length)
            const selected: ReadonlyArray<Record<string, unknown>> = yield* pin()
              .select(["siteId"])
              .collect()
            expect(selected.map((row) => row.siteId)).toEqual(CITY_ORDER)
            expect(
              ids(
                yield* pin()
                  .limit(2)
                  .fetch()
                  .pipe(Effect.map((p: any) => p.items)),
              ),
            ).toEqual(CITY_ORDER.slice(0, 2))
          }),
        ),
      )

      it.live("every limit: a fetch chain and a stream equal one collect, both ways", () =>
        places((devices) =>
          Effect.gen(function* () {
            for (const reverse of [false, true]) {
              const base = () => {
                const pin = devices.byPlace({ region: REGION, country: "us", city: "sf" })
                return reverse ? pin.reverse() : pin
              }
              const want = ids(yield* base().collect())
              for (const limit of [1, 2, 3, 4]) {
                const chained: Array<string> = []
                let cursor: Option.Option<string> = Option.none()
                for (let n = 0; n < 8; n++) {
                  const query = base().limit(limit)
                  const page: Query.Page<Place> = yield* Option.isSome(cursor)
                    ? query.startFrom(cursor.value).fetch()
                    : query.fetch()
                  chained.push(...ids(page.items))
                  cursor = page.cursor
                  if (Option.isNone(cursor)) break
                }
                expect(chained, `limit ${limit}, reverse ${reverse}`).toEqual(want)
              }
              const streamed = yield* Stream.runCollect(base().paginate())
              expect(ids(Array.from(streamed) as Array<Place>)).toEqual(want)
            }
          }),
        ),
      )

      it.live("explain() reports the range the read sends", () =>
        places((devices) =>
          Effect.gen(function* () {
            const explained: Query.QueryExplain = yield* devices
              .byPlace({ region: REGION, country: "us", city: "sf" })
              .explain()
            const own = "$truncated#v1#place#country_us#city_sf"
            expect(explained.keyConditions).toEqual([
              { lower: own, upper: `${own}#\uFFFF`, exact: true },
            ])
          }),
        ),
      )
    })
  }

  it.live(
    "Entity.query.<index> reads the same rows",
    () =>
      Effect.gen(function* () {
        const query = On.Places.query.byPlace({ region: REGION, country: "us", city: "sf" })
        const found = yield* Query.collect(query as never)
        expect(ids(found as Array<Place>)).toEqual(CITY_ORDER)
      }).pipe(provideOn as never) as Effect.Effect<void, unknown>,
  )
})

// ---------------------------------------------------------------------------
// Off, a pin on a composite that isn't the last reads `begins_with(city_sf#)`, as 1.36 did
// ---------------------------------------------------------------------------

describeConnected("#183 a pin on a truncated row's own level, with escapeKeys: false", () => {
  const places = <A, E>(body: (places: any) => Effect.Effect<A, E, any>) =>
    Effect.gen(function* () {
      const db = yield* offClient as unknown as Effect.Effect<any, never, any>
      yield* body(db.entities.Places)
    }).pipe(provideOff as never) as Effect.Effect<void, unknown>

  beforeAll(async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const raw = yield* DynamoClient
        yield* raw.createTable({
          TableName: offTable,
          BillingMode: "PAY_PER_REQUEST",
          ...Table.definition(Off.MainTable as never),
        })
        const db = yield* offClient as unknown as Effect.Effect<any, never, any>
        for (const row of seedRows) yield* seedPlace(db.entities.Places, row)
      }).pipe(provideOff as never) as Effect.Effect<void, unknown>,
    )
  }, 60_000)

  afterAll(async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const raw = yield* DynamoClient
        yield* raw.deleteTable({ TableName: offTable })
      }).pipe(provideOff as never, Effect.ignore) as Effect.Effect<void>,
    )
  }, 30_000)

  it.live("a value's key text sorts as it is: `sf x` before `sf`'s children", () =>
    places((devices) =>
      Effect.gen(function* () {
        expect(ids(yield* devices.byPlace({ region: REGION }).collect())).toEqual([
          "parent",
          "own",
          "spaced",
          "child-1",
          "child-2",
          "extends",
          "other",
        ])
      }),
    ),
  )

  it.live("a pin returns its subtree, and not a truncated row at its own level", () =>
    places((devices) =>
      Effect.gen(function* () {
        const pinned = (city: string) =>
          devices.byPlace({ region: REGION, country: "us", city }).collect()
        expect(ids(yield* pinned("sf"))).toEqual(["child-1", "child-2"])
        expect(ids(yield* pinned("sfx"))).toEqual([])
        expect(ids(yield* pinned("sf x"))).toEqual([])
      }),
    ),
  )

  it.live("`.where(eq)` and `.within()` on a composite that isn't the last mean the same", () =>
    places((devices) =>
      Effect.gen(function* () {
        const under = () => devices.byPlace({ region: REGION, country: "us" })
        const where = yield* under()
          .where((t: any, { eq }: any) => eq(t.city, "sf"))
          .collect()
        expect(ids(where)).toEqual(["child-1", "child-2"])
        expect(
          ids(
            yield* under()
              .within({ city: { eq: "sf" } })
              .collect(),
          ),
        ).toEqual(["child-1", "child-2"])
      }),
    ),
  )

  it.live("a full pin is the one row", () =>
    places((devices) =>
      Effect.gen(function* () {
        const found = yield* devices
          .byPlace({ region: REGION, country: "us", city: "sf", block: "1" })
          .collect()
        expect(ids(found)).toEqual(["child-1"])
      }),
    ),
  )
})

// ---------------------------------------------------------------------------
// Rows written with the flag off, moved by `rekey`. Unescaped, `city_new york` sorts between
// `city_new` and `city_new#`, so until it moves it lies inside the subtree's BETWEEN.
// ---------------------------------------------------------------------------

describeConnected("#183 a pin on a truncated row's own level, after rekey", () => {
  const movedTable = `truncated-moved-${stamp}`
  const provide = Effect.provide(
    Layer.mergeAll(
      ClientLayer,
      On.MainTable.layer({ name: movedTable }),
      Off.MainTable.layer({ name: movedTable }),
    ),
  )

  const offRows: ReadonlyArray<Place> = [
    new Place({ siteId: "own", region: REGION, country: "us", city: "new" }),
    new Place({ siteId: "child", region: REGION, country: "us", city: "new", block: "1" }),
    new Place({ siteId: "sibling", region: REGION, country: "us", city: "new york" }),
    new Place({
      siteId: "sibling-child",
      region: REGION,
      country: "us",
      city: "new york",
      block: "1",
    }),
  ]

  beforeAll(async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const raw = yield* DynamoClient
        yield* raw.createTable({
          TableName: movedTable,
          BillingMode: "PAY_PER_REQUEST",
          ...Table.definition(On.MainTable as never),
        })
        const off = yield* offClient as unknown as Effect.Effect<any, never, any>
        for (const row of offRows) yield* seedPlace(off.entities.Places, row)
        const { Items = [] } = yield* raw.scan({ TableName: movedTable })
        expect(Items.find((item) => item.siteId?.S === "sibling")?.gsi1sk?.S).toBe(
          "$truncated#v1#place#country_us#city_new york",
        )
        const db = yield* onClient as unknown as Effect.Effect<any, never, any>
        const report: Table.RekeyReport = yield* db.tables.MainTable.rekey()
        expect(report.conflicts).toEqual([])
        expect(report.indexKeysRewritten).toBe(2)
      }).pipe(provide as never) as Effect.Effect<void, unknown>,
    )
  }, 60_000)

  afterAll(async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const raw = yield* DynamoClient
        yield* raw.deleteTable({ TableName: movedTable })
      }).pipe(provide as never, Effect.ignore) as Effect.Effect<void>,
    )
  }, 30_000)

  const run = <A, E>(body: (places: any) => Effect.Effect<A, E, any>) =>
    Effect.gen(function* () {
      const db = yield* onClient as unknown as Effect.Effect<any, never, any>
      yield* body(db.entities.Places)
    }).pipe(provide as never) as Effect.Effect<void, unknown>

  it.live(
    "the row is under the escaped text",
    () =>
      Effect.gen(function* () {
        const raw = yield* DynamoClient
        const { Items = [] } = yield* raw.scan({ TableName: movedTable })
        const sibling = Items.find((item) => item.siteId?.S === "sibling")
        expect(sibling?.gsi1sk?.S).toBe("$truncated#v1#place#country_us#city_new%20york")
      }).pipe(provide as never) as Effect.Effect<void, unknown>,
  )

  it.live("a pin keeps its row and subtree, and not the sibling", () =>
    run((places) =>
      Effect.gen(function* () {
        const found = yield* places
          .byPlace({ region: REGION, country: "us", city: "new" })
          .collect()
        expect(ids(found).sort()).toEqual(["child", "own"])
      }),
    ),
  )

  it.live("a pin on the escaped value finds its row and subtree", () =>
    run((places) =>
      Effect.gen(function* () {
        const found = yield* places
          .byPlace({ region: REGION, country: "us", city: "new york" })
          .collect()
        expect(ids(found).sort()).toEqual(["sibling", "sibling-child"])
      }),
    ),
  )

  it.live("`.count()` and a `.limit()` agree with the pin", () =>
    run((places) =>
      Effect.gen(function* () {
        const pin = () => places.byPlace({ region: REGION, country: "us", city: "new" })
        expect(yield* pin().count()).toBe(2)
        const chained: Array<string> = []
        let cursor: Option.Option<string> = Option.none()
        for (let n = 0; n < 8; n++) {
          const query = pin().limit(1)
          const page: Query.Page<Place> = yield* Option.isSome(cursor)
            ? query.startFrom(cursor.value).fetch()
            : query.fetch()
          chained.push(...ids(page.items))
          cursor = page.cursor
          if (Option.isNone(cursor)) break
        }
        expect(chained.sort()).toEqual(["child", "own"])
      }),
    ),
  )

  it.live("`.where(eq)` and `.within()` keep out the sibling", () =>
    run((places) =>
      Effect.gen(function* () {
        const under = () => places.byPlace({ region: REGION, country: "us" })
        const where = yield* under()
          .where((t: any, { eq }: any) => eq(t.city, "new"))
          .collect()
        expect(ids(where).sort()).toEqual(["child", "own"])
        const within = yield* under()
          .within({ city: { eq: "new" } })
          .collect()
        expect(ids(within).sort()).toEqual(["child", "own"])
      }),
    ),
  )
})
