/**
 * Aggregate edges with packed fields (#147). An edge's items carry the edge
 * entity's fields (`Aggregate.one("venue", { entity: Venues })` flattens the
 * hydrated venue onto the `MatchVenue` item), so the entity's
 * `storedAs: DynamoModel.Packed` fields are stored packed there too — and read
 * back by stored form, whatever an earlier writer stored.
 */

import type { AttributeValue, TransactWriteItem } from "@aws-sdk/client-dynamodb"
import { describe, expect, it } from "@effect/vitest"
import { Compression } from "@effect-dynamodb/schema/Compression.js"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Effect, Exit, Layer, Schema } from "effect"
import { beforeEach } from "vitest"
import * as Aggregate from "../src/Aggregate.js"
import * as NodeCompression from "../src/compression/node.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import { toAttributeMap } from "../src/Marshaller.js"
import * as Table from "../src/Table.js"
import { unregisteredCodecDefect } from "./helpers/MissingCompressor.js"
import { mockDynamoClientLayer } from "./helpers/MockDynamoClient.js"

class Venue extends Schema.Class<Venue>("Venue")({
  venueId: Schema.String.pipe(DynamoModel.identifier),
  name: Schema.String,
  layout: Schema.Struct({ stands: Schema.Array(Schema.String), capacity: Schema.Number }),
}) {}

class Match extends Schema.Class<Match>("Match")({
  matchId: Schema.String,
  name: Schema.String,
  venue: Venue,
}) {}

const AppSchema = DynamoSchema.make({ name: "agg", version: 1 })

const gzip0 = DynamoModel.Packed({ format: "json", compression: { codec: "gzip", threshold: 0 } })

const Venues = Entity.make({
  model: DynamoModel.configure(Venue, { layout: { storedAs: gzip0 } }),
  entityType: "Venue",
  primaryKey: {
    pk: { field: "pk", composite: ["venueId"] },
    sk: { field: "sk", composite: [] },
  },
})

class Stop extends Schema.Class<Stop>("Stop")({
  stopId: Schema.String.pipe(DynamoModel.identifier),
  plan: Schema.Struct({ steps: Schema.Array(Schema.String) }),
}) {}

const Stops = Entity.make({
  model: DynamoModel.configure(Stop, { plan: { storedAs: gzip0 } }),
  entityType: "Stop",
  primaryKey: {
    pk: { field: "pk", composite: ["stopId"] },
    sk: { field: "sk", composite: [] },
  },
})

const MainTable = Table.make({ schema: AppSchema, entities: { Venues, Stops } })

const Matches = Aggregate.make(Match, {
  table: MainTable,
  schema: AppSchema,
  pk: { field: "pk", composite: ["matchId"] },
  collection: { name: "match" },
  root: { entityType: "MatchItem" },
  edges: {
    venue: Aggregate.one("venue", { entityType: "MatchVenue", entity: Venues }),
  },
})

// ---------------------------------------------------------------------------
// In-memory client
// ---------------------------------------------------------------------------

type Item = Record<string, AttributeValue>
const store = new Map<string, Item>()
const transactions: Array<ReadonlyArray<TransactWriteItem>> = []
const keyOf = (item: Item) => `${item.pk?.S}|${item.sk?.S}`

const InMemoryClient = mockDynamoClientLayer({
  putItem: (input) =>
    Effect.sync(() => {
      store.set(keyOf(input.Item!), input.Item!)
      return {} as never
    }),
  query: (input) =>
    Effect.sync(() => {
      // The partition attribute the key condition names: the table's `pk`, or
      // a list index's partition key.
      const field = input.ExpressionAttributeNames?.["#pk"] ?? "pk"
      const pk = input.ExpressionAttributeValues![":pk"]!.S
      return { Items: [...store.values()].filter((item) => item[field]?.S === pk) } as never
    }),
  batchGetItem: (input) =>
    Effect.sync(() => {
      const Responses: Record<string, Array<Item>> = {}
      for (const [table, request] of Object.entries(input.RequestItems ?? {})) {
        Responses[table] = (request.Keys ?? []).flatMap((key) => {
          const item = store.get(keyOf(key))
          return item === undefined ? [] : [item]
        })
      }
      return { Responses } as never
    }),
  transactWriteItems: (input) =>
    Effect.sync(() => {
      const items = input.TransactItems ?? []
      transactions.push(items)
      for (const entry of items) {
        if (entry.Put?.Item !== undefined) store.set(keyOf(entry.Put.Item), entry.Put.Item)
        if (entry.Delete?.Key !== undefined) store.delete(keyOf(entry.Delete.Key))
      }
      return {} as never
    }),
})

const TestLayer = Layer.mergeAll(
  InMemoryClient,
  MainTable.layer({ name: "agg-table" }),
  Compression.layer([NodeCompression.gzip()]),
)

beforeEach(() => {
  store.clear()
  transactions.length = 0
})

const layout = {
  stands: Array.from({ length: 40 }, (_, i) => `Stand ${i % 4}`),
  capacity: 100_024,
}

const seedVenue = Venues.put({ venueId: "v-1", name: "MCG", layout }).asEffect()

const venueItems = () => [...store.values()].filter((item) => item.__edd_e__?.S === "MatchVenue")

describe("Aggregate — packed edge fields", () => {
  it.effect("create stores the edge entity's packed field packed; get assembles it", () =>
    Effect.gen(function* () {
      yield* seedVenue
      // The venue entity's own item is packed (it is an entity write).
      const venue = [...store.values()].find((item) => item.__edd_e__?.S === "Venue")!
      expect(venue.layout?.B).toBeInstanceOf(Uint8Array)

      yield* Matches.create({ matchId: "m-1", name: "Final", venueId: "v-1" } as never)
      const [edge] = venueItems()
      expect(edge!.layout?.B).toBeInstanceOf(Uint8Array)
      expect(edge!.layout!.B![0]).toBe(0x21)
      expect(edge!.name?.S).toBe("MCG")

      const match = yield* Matches.get({ matchId: "m-1" })
      expect(match.venue.layout).toEqual(layout)
      expect(match.venue.name).toBe("MCG")
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("reads an edge item written before packing (native map)", () =>
    Effect.gen(function* () {
      yield* seedVenue
      yield* Matches.create({ matchId: "m-2", name: "Semi", venueId: "v-1" } as never)
      const [edge] = venueItems()
      store.set(keyOf(edge!), { ...edge!, ...toAttributeMap({ layout }) })
      expect(venueItems()[0]!.layout?.M).toBeDefined()
      const match = yield* Matches.get({ matchId: "m-2" })
      expect(match.venue.layout).toEqual(layout)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("update re-packs the edge it rewrites", () =>
    Effect.gen(function* () {
      yield* seedVenue
      yield* Matches.create({ matchId: "m-3", name: "Final", venueId: "v-1" } as never)
      const before = venueItems()[0]!.layout!.B!

      // A root change rewrites the root group (a `one` edge lives in it): the
      // edge is re-packed from its decomposed value — the same bytes.
      transactions.length = 0
      yield* Matches.update({ matchId: "m-3" }, ({ state }) => ({ ...state, name: "Grand Final" }))
      const puts = () =>
        transactions
          .flat()
          .flatMap((entry) => (entry.Put?.Item !== undefined ? [entry.Put.Item] : []))
      expect(puts().find((item) => item.__edd_e__?.S === "MatchVenue")!.layout?.B).toEqual(before)

      // Changing the edge's packed value rewrites it, packed.
      transactions.length = 0
      const changed = { ...layout, capacity: 1 }
      yield* Matches.update({ matchId: "m-3" }, ({ state }) => ({
        ...state,
        venue: { ...state.venue, layout: changed },
      }))
      const venuePut = puts().find((item) => item.__edd_e__?.S === "MatchVenue")!
      expect(venuePut.layout?.B).toBeInstanceOf(Uint8Array)
      expect(venuePut.layout?.B).not.toEqual(before)
      expect((yield* Matches.get({ matchId: "m-3" })).venue.layout).toEqual(changed)
    }).pipe(Effect.provide(TestLayer)),
  )

  it("refuses a packed edge field as a discriminator (EDD-9072)", () => {
    expect(() =>
      Aggregate.make(Match, {
        table: MainTable,
        schema: AppSchema,
        pk: { field: "pk", composite: ["matchId"] },
        collection: { name: "match" },
        root: { entityType: "MatchItem" },
        edges: {
          venue: Aggregate.one("venue", {
            entityType: "MatchVenue",
            entity: Venues,
            discriminator: { layout: "x" },
          }),
        },
      }),
    ).toThrow(/\[EDD-9072\].*discriminator "layout"/)
  })

  it("refuses a packed field as a many edge's sort-key composite (EDD-9072)", () => {
    class Tour extends Schema.Class<Tour>("Tour")({
      tourId: Schema.String,
      venues: Schema.Array(Venue),
    }) {}
    expect(() =>
      Aggregate.make(Tour, {
        table: MainTable,
        schema: AppSchema,
        pk: { field: "pk", composite: ["tourId"] },
        collection: { name: "tour" },
        root: { entityType: "TourItem" },
        edges: {
          venues: Aggregate.many("venues", {
            entityType: "TourVenue",
            entity: Venues,
            sk: { composite: ["layout"] },
          }),
        },
      }),
    ).toThrow(/\[EDD-9072\].*sort-key composite "layout"/)
  })
})

// ---------------------------------------------------------------------------
// Packing turned off: edge items written packed still read (stored-form dispatch)
// ---------------------------------------------------------------------------

describe("Aggregate — packed edge fields after packing is turned off", () => {
  const PlainVenues = Entity.make({
    model: Venue,
    entityType: "Venue",
    primaryKey: {
      pk: { field: "pk", composite: ["venueId"] },
      sk: { field: "sk", composite: [] },
    },
  })
  const PlainTable = Table.make({ schema: AppSchema, entities: { PlainVenues } })
  const PlainMatches = Aggregate.make(Match, {
    table: PlainTable,
    schema: AppSchema,
    pk: { field: "pk", composite: ["matchId"] },
    collection: { name: "match" },
    root: { entityType: "MatchItem" },
    edges: {
      venue: Aggregate.one("venue", { entityType: "MatchVenue", entity: PlainVenues }),
    },
  })
  const PlainLayer = Layer.mergeAll(TestLayer, PlainTable.layer({ name: "agg-table" }))

  it.effect("get reads edge items stored packed (S and B) by their stored form", () =>
    Effect.gen(function* () {
      yield* seedVenue
      yield* Matches.create({ matchId: "m-1", name: "Final", venueId: "v-1" } as never)
      expect(venueItems()[0]!.layout?.B).toBeInstanceOf(Uint8Array)
      // Packing is off for this configuration of the same edge entity.
      expect((yield* PlainMatches.get({ matchId: "m-1" })).venue.layout).toEqual(layout)

      // A JSON (S) value written under another config reads too.
      const [edge] = venueItems()
      store.set(keyOf(edge!), { ...edge!, layout: { S: JSON.stringify(layout) } })
      expect((yield* PlainMatches.get({ matchId: "m-1" })).venue.layout).toEqual(layout)
    }).pipe(Effect.provide(PlainLayer)),
  )
})

// ---------------------------------------------------------------------------
// many edges whose element is the packed entity, in sub-aggregate groups
// ---------------------------------------------------------------------------

describe("Aggregate — packed many-edge elements", () => {
  class Leg extends Schema.Class<Leg>("Leg")({
    label: Schema.String,
    stops: Schema.Array(Stop),
  }) {}
  class Tour extends Schema.Class<Tour>("Tour")({
    tourId: Schema.String,
    region: Schema.String,
    name: Schema.String,
    leg1: Leg,
    leg2: Leg,
  }) {}
  const LegAggregate = Aggregate.make(Leg, {
    root: { entityType: "TourLeg" },
    edges: {
      stops: Aggregate.many("stops", {
        entityType: "TourStop",
        entity: Stops,
        sk: { composite: ["stopId"] },
      }),
    },
  })
  const Tours = Aggregate.make(Tour, {
    table: MainTable,
    schema: AppSchema,
    pk: { field: "pk", composite: ["tourId"] },
    collection: { name: "tour" },
    list: {
      index: "gsi1",
      name: "tours",
      pk: { field: "gsi1pk", composite: ["region"] },
      sk: { field: "gsi1sk", composite: ["tourId"] },
    },
    root: { entityType: "TourItem" },
    edges: {
      leg1: LegAggregate.with({ discriminator: { legNo: 1 } }),
      leg2: LegAggregate.with({ discriminator: { legNo: 2 } }),
    },
  })

  const plan = (n: number) => ({ steps: Array.from({ length: 20 }, (_, i) => `step ${n}.${i}`) })
  const tour = {
    tourId: "t-1",
    region: "apac",
    name: "Spring",
    leg1: { label: "North", stops: ["s-1"] },
    leg2: { label: "South", stops: ["s-2", "s-3"] },
  }
  // The many edge's elements ARE the entity: create takes their ids and
  // hydrates each from the (packed) entity item.
  const seedStops = Effect.forEach(
    [1, 2, 3],
    (n) => Stops.put({ stopId: `s-${n}`, plan: plan(n) }).asEffect(),
    { discard: true },
  )
  const stopItems = () => [...store.values()].filter((item) => item.__edd_e__?.S === "TourStop")
  const stopPuts = () =>
    transactions
      .flat()
      .flatMap((entry) =>
        entry.Put?.Item !== undefined && entry.Put.Item.__edd_e__?.S === "TourStop"
          ? [entry.Put.Item]
          : [],
      )

  it.effect("create packs each element; get and list assemble them", () =>
    Effect.gen(function* () {
      yield* seedStops
      yield* Tours.create(tour as never)
      expect(stopItems()).toHaveLength(3)
      for (const item of stopItems()) {
        expect(item.plan?.B).toBeInstanceOf(Uint8Array)
        expect(item.plan!.B![0]).toBe(0x21)
      }
      const read = yield* Tours.get({ tourId: "t-1" })
      expect(read.leg2.stops.map((stop) => stop.plan)).toEqual([plan(2), plan(3)])
      const listed = yield* Tours.list({ region: "apac" })
      expect(listed.data).toHaveLength(1)
      expect(listed.data[0]!.leg1.stops[0]!.plan).toEqual(plan(1))
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("an update rewrites only the changed group's packed elements", () =>
    Effect.gen(function* () {
      yield* seedStops
      yield* Tours.create(tour as never)
      const stored = new Map(stopItems().map((item) => [item.stopId!.S!, item.plan!.B!]))
      // A root-only change: neither leg group is rewritten.
      transactions.length = 0
      yield* Tours.update({ tourId: "t-1" }, ({ state }) => ({ ...state, name: "Autumn" }))
      expect(stopPuts()).toEqual([])

      // A change in leg 1's group: its element is rewritten, packed (the same
      // bytes — it was diffed before packing); leg 2's elements are not.
      transactions.length = 0
      yield* Tours.update({ tourId: "t-1" }, ({ state }) => ({
        ...state,
        leg1: { ...state.leg1, label: "Far North" },
      }))
      const puts = stopPuts()
      expect(puts.map((item) => item.stopId?.S)).toEqual(["s-1"])
      expect(puts[0]!.plan?.B).toEqual(stored.get("s-1"))
      const read = yield* Tours.get({ tourId: "t-1" })
      expect(read.leg1.label).toBe("Far North")
      expect(read.leg1.stops[0]!.plan).toEqual(plan(1))
      expect(read.leg2.stops.map((stop) => stop.plan)).toEqual([plan(2), plan(3)])
    }).pipe(Effect.provide(TestLayer)),
  )
})

// ---------------------------------------------------------------------------
// DynamoClient.make({ compressors }) reaches bound aggregates
// ---------------------------------------------------------------------------

describe("Aggregate — packed edges through DynamoClient.make({ compressors })", () => {
  const Bare = Layer.mergeAll(InMemoryClient, MainTable.layer({ name: "agg-table" }))

  it.effect("explicit compressors reach a bound aggregate with nothing ambient", () =>
    Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { Venues },
        aggregates: { Matches },
        tables: { MainTable },
        compressors: [NodeCompression.gzip()],
      })
      yield* db.entities.Venues.put({ venueId: "v-1", name: "MCG", layout })
      yield* db.aggregates.Matches.create({
        matchId: "m-1",
        name: "Final",
        venueId: "v-1",
      } as never)
      expect(venueItems()[0]!.layout?.B).toBeInstanceOf(Uint8Array)
      expect((yield* db.aggregates.Matches.get({ matchId: "m-1" })).venue.layout).toEqual(layout)
      // The unbound aggregate, with no Compression in scope, cannot read it.
      const exit = yield* Effect.exit(Matches.get({ matchId: "m-1" }))
      expect(Exit.isFailure(exit)).toBe(true)
    }).pipe(Effect.provide(Bare)),
  )

  it.effect("binding an aggregate whose edge names an unregistered codec dies with EDD-9078", () =>
    Effect.gen(function* () {
      // Only the aggregate is bound: its edge entity's codec is still checked.
      const none = unregisteredCodecDefect(
        yield* Effect.exit(
          DynamoClient.make({ entities: {}, aggregates: { Matches }, tables: { MainTable } }),
        ),
      )
      expect(none).toContain("[EDD-9078] DynamoClient.make")
      expect(none).toContain(
        'aggregate "Matches" (edge "MatchVenue") stores "layout" packed with codec "gzip"',
      )
      const brotliOnly = unregisteredCodecDefect(
        yield* Effect.exit(
          DynamoClient.make({
            entities: {},
            aggregates: { Matches },
            tables: { MainTable },
            compressors: [NodeCompression.brotli()],
          }),
        ),
      )
      expect(brotliOnly).toContain('the Compression registry in scope has "brotli"')
      // With the codec ambient at bind, it binds.
      yield* DynamoClient.make({
        entities: {},
        aggregates: { Matches },
        tables: { MainTable },
      }).pipe(Effect.provide(Compression.layer([NodeCompression.gzip()])))
    }).pipe(Effect.provide(Bare)),
  )
})
