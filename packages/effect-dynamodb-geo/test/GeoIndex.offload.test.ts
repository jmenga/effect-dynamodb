/**
 * Offloaded fields on geo entities (#179, design §8.4, §9.3, §13).
 *
 * - `nearby` decodes each row through the entity's own two-phase decoder:
 *   overflow and binary fields resolve eagerly (a page's values fetched
 *   together by the query's prefetch), and packed fields, renamed attributes
 *   and sparse maps decode as the entity's own queries decode them — the #147
 *   gap: geo reads ran the record schema over the raw stored row.
 * - `GeoIndex.put` of a binary field uploads it through the entity's put; the
 *   bound put returns its bytes.
 * - `GeoIndex.bind` checks its context as `Entity.bind` does: escaped key
 *   text (`escapeKeys: true`) and a blob store for an entity that offloads
 *   (`[EDD-9146]`, `[EDD-9115]`), a registered codec for a compressed
 *   `Packed` field (`[EDD-9078]`), and it bundles the default `SecureRandom`
 *   a `generatedId` put draws its id from.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { Cause, Effect, Exit, Layer, Schema, Stream } from "effect"
import {
  BlobStore,
  type BlobStoreError,
  DynamoClient,
  DynamoModel,
  DynamoSchema,
  Entity,
  Marshaller,
  type MemoryBlobStore,
  Table,
  type ValidationError,
} from "effect-dynamodb"
import { describe, expect, it } from "vitest"
import * as GeoIndex from "../src/GeoIndex.js"
import { withOffloadGate } from "./helpers/OffloadGate.js"

// ---------------------------------------------------------------------------
// Model and entities
// ---------------------------------------------------------------------------

const AppSchema = DynamoSchema.make({ name: "geooffload", version: 1, escapeKeys: true })

const Notes = Schema.Struct({ text: Schema.String })

class Courier extends Schema.Class<Courier>("Courier")({
  courierId: Schema.String,
  latitude: Schema.optional(Schema.Number),
  longitude: Schema.optional(Schema.Number),
  timestamp: Schema.Number,
  label: Schema.optional(Schema.String),
  notes: Schema.optional(Notes),
  photo: Schema.optional(Schema.Uint8Array),
  cell: Schema.optional(Schema.String),
  parentCell: Schema.optional(Schema.String),
  timePartition: Schema.optional(Schema.String),
}) {}

/** A courier with its stops, a map stored sparse (one attribute per entry). */
class Route extends Schema.Class<Route>("Route")({
  ...Courier.fields,
  stops: Schema.Record(Schema.String, Schema.Number),
}) {}

const courierConfig = {
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
} as const

/** Overflow `notes` offloads from 64 stored bytes; binary `photo` always does. */
const Couriers = withOffloadGate(() =>
  Entity.make({
    ...courierConfig,
    entityType: "Courier",
    model: DynamoModel.configure(Courier, {
      notes: { storedAs: DynamoModel.Packed({ format: "json", external: { threshold: 64 } }) },
      photo: { storedAs: DynamoModel.External({ contentType: "image/jpeg" }) },
    }),
  }),
)

/** Offloads nothing: a packed `notes`, a renamed `label` and a sparse `stops` (the #147 gap). */
const PackedCouriers = Entity.make({
  ...courierConfig,
  entityType: "PackedCourier",
  model: DynamoModel.configure(Route, {
    notes: { storedAs: DynamoModel.Packed({ format: "json" }) },
    label: { field: "lbl" },
    stops: { storedAs: DynamoModel.SparseMap() },
  }),
})

/** A compressed packed field: its codec must be registered where it is bound. */
const ZstdCouriers = Entity.make({
  ...courierConfig,
  entityType: "ZstdCourier",
  model: DynamoModel.configure(Courier, {
    notes: { storedAs: DynamoModel.Packed({ format: "json", compression: { codec: "zstd" } }) },
  }),
})

/** Its id is generated: the bound put draws it from the bundled `SecureRandom`. */
const GeneratedCouriers = Entity.make({
  ...courierConfig,
  entityType: "GeneratedCourier",
  model: Courier,
  generatedId: { field: "courierId" },
})

const MainTable = Table.make({
  schema: AppSchema,
  entities: { Couriers, PackedCouriers, ZstdCouriers, GeneratedCouriers },
})

/** The offloading entity on a table whose schema doesn't escape key text (`[EDD-9146]`). */
const UnescapedCouriers = withOffloadGate(() =>
  Entity.make({
    ...courierConfig,
    entityType: "UnescapedCourier",
    model: DynamoModel.configure(Courier, {
      photo: { storedAs: DynamoModel.External({ contentType: "image/jpeg" }) },
    }),
  }),
)

const UnescapedTable = Table.make({
  schema: DynamoSchema.make({ name: "geooffload", version: 1, escapeKeys: false }),
  entities: { UnescapedCouriers },
})

const fields = {
  cell: { field: "cell", resolution: 15 },
  parentCell: { field: "parentCell", resolution: 3 },
  timePartition: { field: "timePartition", source: "timestamp", bucket: "hourly" },
} as const

const coordinates = (item: {
  readonly latitude?: number | undefined
  readonly longitude?: number | undefined
}) =>
  item.latitude !== undefined && item.longitude !== undefined
    ? { latitude: item.latitude, longitude: item.longitude }
    : undefined

const CourierGeo = GeoIndex.make({ entity: Couriers, index: "byCell", coordinates, fields })
const PackedGeo = GeoIndex.make({ entity: PackedCouriers, index: "byCell", coordinates, fields })
const ZstdGeo = GeoIndex.make({ entity: ZstdCouriers, index: "byCell", coordinates, fields })
const UnescapedGeo = GeoIndex.make({
  entity: UnescapedCouriers,
  index: "byCell",
  coordinates,
  fields,
})
const GeneratedGeo = GeoIndex.make({
  entity: GeneratedCouriers,
  index: "byCell",
  coordinates,
  fields,
})

// ---------------------------------------------------------------------------
// In-memory table: PutItem and the geo GSI's BETWEEN queries
// ---------------------------------------------------------------------------

type Row = Record<string, AttributeValue>

const makeTable = () => {
  const rows = new Map<string, Row>()
  const queries: Array<number> = []
  const unused = () => Effect.die(new Error("not used by this test"))
  const service = new Proxy(
    {
      putItem: (input: { readonly Item: Row }) =>
        Effect.sync(() => {
          rows.set(`${input.Item.pk?.S}|${input.Item.sk?.S}`, input.Item)
          return {}
        }),
      query: (input: {
        readonly ExpressionAttributeValues: Record<string, AttributeValue>
        readonly FilterExpression?: string
      }) =>
        Effect.sync(() => {
          const values = input.ExpressionAttributeValues
          const lower = values[":sk1"]?.S ?? ""
          const upper = values[":sk2"]?.S ?? ""
          const entityType = values[":edd_e_0"]?.S
          const items = [...rows.values()].filter(
            (row) =>
              row.gsi1pk?.S === values[":pk"]?.S &&
              (row.gsi1sk?.S ?? "") >= lower &&
              (row.gsi1sk?.S ?? "") <= upper &&
              (entityType === undefined || row.__edd_e__?.S === entityType),
          )
          queries.push(items.length)
          return { Items: items, Count: items.length }
        }),
    } as Record<string, unknown>,
    { get: (target, key) => (key in target ? target[key as string] : unused) },
  )
  return {
    rows,
    queries,
    layer: Layer.merge(
      Layer.succeed(DynamoClient, service as never),
      MainTable.layer({ name: "couriers" }),
    ),
  }
}

/** The stored row of the item `courierId`. */
const rowOf = (table: ReturnType<typeof makeTable>, courierId: string): Row => {
  const row = [...table.rows.values()].find((r) => r.courierId?.S === courierId)
  if (row === undefined) throw new Error(`no row for ${courierId}`)
  return row
}

const run = <A, E>(
  effect: Effect.Effect<A, E, DynamoClient | Table.TableConfig>,
  layer: Layer.Layer<DynamoClient | Table.TableConfig>,
) => Effect.runPromise(effect.pipe(Effect.provide(layer)))

const runExit = <A, E>(
  effect: Effect.Effect<A, E, DynamoClient | Table.TableConfig>,
  layer: Layer.Layer<DynamoClient | Table.TableConfig>,
) => Effect.runPromise(Effect.exit(effect.pipe(Effect.provide(layer))))

const NOW = 1_760_000_000_000
const LONDON = { latitude: 51.5074, longitude: -0.1278 }
const near = (offset: number) => ({
  latitude: LONDON.latitude + offset,
  longitude: LONDON.longitude,
})
const search = { center: LONDON, radius: 1_000, timeWindow: { start: NOW - 1, end: NOW + 1 } }

const longNotes = { text: "x".repeat(200) }
const photoOf = (n: number) => new Uint8Array(48).fill(n)

const storeLayer = (store: MemoryBlobStore) => BlobStore.layer(store)

/** `store`, counting the reads in flight (each held open 5 ms). */
const countingStore = (store: MemoryBlobStore) => {
  let inFlight = 0
  let maxInFlight = 0
  const counting: MemoryBlobStore = {
    ...store,
    get: (ref, options) =>
      Stream.unwrap(
        Effect.gen(function* () {
          inFlight++
          maxInFlight = Math.max(maxInFlight, inFlight)
          yield* Effect.sleep("5 millis")
          return store.get(ref, options).pipe(
            Stream.ensuring(
              Effect.sync(() => {
                inFlight--
              }),
            ),
          )
        }),
      ),
  }
  return { store: counting, maxInFlight: () => maxInFlight }
}

const failure = <E>(exit: Exit.Exit<unknown, E>): E => {
  if (!Exit.isFailure(exit)) throw new Error("expected a failure")
  const error = Cause.findErrorOption(exit.cause)
  if (error._tag !== "Some")
    throw new Error(`expected a typed failure: ${Cause.pretty(exit.cause)}`)
  return error.value
}

const defect = (exit: Exit.Exit<unknown, unknown>): string => {
  if (!Exit.isFailure(exit)) throw new Error("expected a defect")
  return String(Cause.squash(exit.cause))
}

// ---------------------------------------------------------------------------
// nearby
// ---------------------------------------------------------------------------

describe("GeoIndex.nearby — offloaded fields (#179)", () => {
  it("resolves overflow and binary fields eagerly, bound and unbound", async () => {
    const table = makeTable()
    const store = BlobStore.memory()
    const [unbound, bound] = await run(
      Effect.gen(function* () {
        yield* CourierGeo.put({
          courierId: "c-1",
          ...near(0.001),
          timestamp: NOW,
          notes: longNotes,
          photo: photoOf(1),
        }).asEffect()
        yield* CourierGeo.put({
          courierId: "c-2",
          ...near(0.002),
          timestamp: NOW,
          notes: longNotes,
          photo: photoOf(2),
        }).asEffect()
        const unbound = yield* CourierGeo.nearby(search)
        const geo = yield* GeoIndex.bind(CourierGeo)
        const bound = yield* geo.nearby(search)
        return [unbound, bound] as const
      }).pipe(Effect.provide(storeLayer(store))),
      table.layer,
    )
    // Stored as pointers: overflow `B`, binary `S` "~edbp:" text.
    const row = rowOf(table, "c-1")
    expect(row.notes?.B).toBeInstanceOf(Uint8Array)
    expect(row.photo?.S?.startsWith("~edbp:")).toBe(true)
    for (const results of [unbound, bound]) {
      expect(results.map((r) => r.item.courierId)).toEqual(["c-1", "c-2"])
      expect(results.map((r) => r.item.notes)).toEqual([longNotes, longNotes])
      expect(results.map((r) => r.item.photo)).toEqual([photoOf(1), photoOf(2)])
    }
    // Two searches, two pointers per row: every value fetched once per search.
    expect(store.inspect().calls.get).toBe(8)
  })

  it("values stored inline resolve without the store", async () => {
    const table = makeTable()
    const store = BlobStore.memory()
    const results = await run(
      Effect.gen(function* () {
        yield* CourierGeo.put({
          courierId: "c-1",
          ...near(0.001),
          timestamp: NOW,
          notes: { text: "short" },
        }).asEffect()
        return yield* CourierGeo.nearby(search)
      }).pipe(Effect.provide(storeLayer(store))),
      table.layer,
    )
    expect(results.map((r) => r.item.notes)).toEqual([{ text: "short" }])
    expect(store.inspect().calls.get).toBe(0)
    expect(store.inspect().calls.put).toBe(0)
  })

  it("decodes packed, renamed and sparse fields as the entity's queries do (#147 gap)", async () => {
    const table = makeTable()
    const results = await run(
      Effect.gen(function* () {
        const geo = yield* GeoIndex.bind(PackedGeo)
        yield* geo.put({
          courierId: "p-1",
          ...near(0.001),
          timestamp: NOW,
          label: "north",
          notes: { text: "packed" },
          stops: { depot: 1, hub: 2 },
        })
        return yield* geo.nearby(search)
      }),
      table.layer,
    )
    const row = rowOf(table, "p-1")
    // Stored packed (JSON text) under the renamed attribute.
    expect(row.notes?.S).toBe('{"text":"packed"}')
    expect(row.lbl?.S).toBe("north")
    expect(row.stops).toBeUndefined()
    expect(results).toHaveLength(1)
    expect(results[0]!.item).toMatchObject({
      label: "north",
      notes: { text: "packed" },
      stops: { depot: 1, hub: 2 },
    })
    // An instance of the model, as the entity's own queries return.
    expect(results[0]!.item).toBeInstanceOf(Route)
  })

  it("a page's offloaded values resolve together before its rows decode", async () => {
    const table = makeTable()
    const { store: counting, maxInFlight } = countingStore(BlobStore.memory({ readConcurrency: 4 }))
    const results = await run(
      Effect.gen(function* () {
        for (const n of [1, 2, 3, 4]) {
          yield* CourierGeo.put({
            courierId: `c-${n}`,
            // One cell for all four, so one query reads them as one page.
            ...LONDON,
            timestamp: NOW,
            photo: photoOf(n),
          }).asEffect()
        }
        return yield* CourierGeo.nearby(search)
      }).pipe(Effect.provide(storeLayer(counting))),
      table.layer,
    )
    expect(results.map((r) => r.item.photo)).toEqual([1, 2, 3, 4].map(photoOf))
    expect(table.queries.filter((n) => n > 0)).toEqual([4])
    expect(maxInFlight()).toBeGreaterThan(1)
  })

  it("the reads of a search's parallel queries stay within the store's readConcurrency", async () => {
    const table = makeTable()
    const { store: counting, maxInFlight } = countingStore(BlobStore.memory({ readConcurrency: 2 }))
    const HOUR = 60 * 60 * 1000
    const hours = [0, 1, 2, 3, 4, 5]
    const results = await run(
      Effect.gen(function* () {
        // Four rows in each of six hourly partitions: six queries with a page each.
        for (const h of hours) {
          for (const n of [1, 2, 3, 4]) {
            yield* CourierGeo.put({
              courierId: `c-${h}-${n}`,
              ...LONDON,
              timestamp: NOW - h * HOUR,
              photo: photoOf(n),
            }).asEffect()
          }
        }
        return yield* CourierGeo.nearby({
          center: LONDON,
          radius: 1_000,
          timeWindow: { start: NOW - 5 * HOUR - 1, end: NOW + 1 },
        })
      }).pipe(Effect.provide(storeLayer(counting))),
      table.layer,
    )
    expect(results).toHaveLength(24)
    expect(table.queries.filter((n) => n > 0)).toEqual(hours.map(() => 4))
    // One pool for the whole search, not one per query: never more than
    // `readConcurrency` reads in flight, and the pool is used to its size.
    expect(maxInFlight()).toBe(2)
  })

  it("without a store, a stored pointer fails the search with BlobStoreError NotProvided", async () => {
    const table = makeTable()
    await run(
      CourierGeo.put({
        courierId: "c-1",
        ...near(0.001),
        timestamp: NOW,
        photo: photoOf(1),
      })
        .asEffect()
        .pipe(Effect.provide(storeLayer(BlobStore.memory()))),
      table.layer,
    )
    const error = failure(await runExit(CourierGeo.nearby(search), table.layer))
    expect(error._tag).toBe("BlobStoreError")
    expect(error as BlobStoreError).toMatchObject({
      reason: "NotProvided",
      entityType: "Courier",
      attribute: "photo",
      operation: "GeoSearch.decode",
    })
  })

  it("a missing object fails the search with BlobStoreError NotFound", async () => {
    const table = makeTable()
    const store = BlobStore.memory()
    const exit = await runExit(
      Effect.gen(function* () {
        yield* CourierGeo.put({
          courierId: "c-1",
          ...near(0.001),
          timestamp: NOW,
          photo: photoOf(1),
        }).asEffect()
        yield* store.delete(store.inspect().versions.map((v) => v.ref))
        return yield* CourierGeo.nearby(search)
      }).pipe(Effect.provide(storeLayer(store))),
      table.layer,
    )
    expect(failure(exit) as BlobStoreError).toMatchObject({
      _tag: "BlobStoreError",
      reason: "NotFound",
      attribute: "photo",
    })
  })

  it("a row that fails to decode is a ValidationError naming GeoSearch.decode", async () => {
    const table = makeTable()
    await run(
      PackedGeo.put({ courierId: "p-1", ...near(0.001), timestamp: NOW, stops: {} }).asEffect(),
      table.layer,
    )
    // Corrupt the stored row: `timestamp` is required and numeric.
    const [key, row] = [...table.rows].find(([, row]) => row.courierId?.S === "p-1")!
    table.rows.set(key, { ...row, timestamp: { S: "not a number" } })
    // The search's window filter reads the decoded item, so the row is read.
    const error = failure(await runExit(PackedGeo.nearby(search), table.layer))
    expect(error as ValidationError).toMatchObject({
      _tag: "ValidationError",
      entityType: "PackedCourier",
      operation: "GeoSearch.decode",
    })
  })
})

// ---------------------------------------------------------------------------
// put
// ---------------------------------------------------------------------------

describe("GeoIndex.put — binary fields (#179)", () => {
  it("uploads a binary field through the entity's put; the bound put returns its bytes", async () => {
    const table = makeTable()
    const store = BlobStore.memory()
    const written = await run(
      Effect.gen(function* () {
        const geo = yield* GeoIndex.bind(CourierGeo)
        return yield* geo.put({
          courierId: "c-1",
          ...near(0.001),
          timestamp: NOW,
          photo: photoOf(9),
        })
      }).pipe(Effect.provide(storeLayer(store))),
      table.layer,
    )
    expect(written.photo).toEqual(photoOf(9))
    expect(written.cell).toBeTypeOf("string")
    const [version, ...rest] = store.inspect().versions
    expect(rest).toEqual([])
    expect(version!.bytes).toEqual(photoOf(9))
    expect(version!.contentType).toBe("image/jpeg")
    const row = rowOf(table, "c-1")
    expect(row.photo?.S?.startsWith("~edbp:")).toBe(true)
    // The geo fields are written with it, so the item is in the geo index.
    expect(Marshaller.fromAttributeMap(row).gsi1pk).toBeTypeOf("string")
  })
})

// ---------------------------------------------------------------------------
// bind
// ---------------------------------------------------------------------------

describe("GeoIndex.bind — configuration checks", () => {
  it("an offloading entity bound without a store is the [EDD-9115] defect", async () => {
    const message = defect(await runExit(GeoIndex.bind(CourierGeo), makeTable().layer))
    expect(message).toContain("[EDD-9115] GeoIndex.bind")
    expect(message).toContain('entity "Courier" offloads "notes", "photo"')
  })

  it("an offloading entity on a schema without escapeKeys: true is the [EDD-9146] defect", async () => {
    // Checked before the store: a store doesn't make the key text right.
    const layer = Layer.merge(
      Layer.succeed(DynamoClient, {} as never),
      UnescapedTable.layer({ name: "couriers" }),
    )
    for (const bound of [
      GeoIndex.bind(UnescapedGeo),
      GeoIndex.bind(UnescapedGeo).pipe(Effect.provide(storeLayer(BlobStore.memory()))),
    ]) {
      const message = defect(await runExit(bound, layer))
      expect(message).toContain("[EDD-9146] GeoIndex.bind")
      expect(message).toContain('entity "UnescapedCourier" offloads "photo"')
      expect(message).toContain("escapeKeys: true")
    }
  })

  it("an entity that offloads nothing binds without a store", async () => {
    const exit = await runExit(GeoIndex.bind(PackedGeo), makeTable().layer)
    expect(Exit.isSuccess(exit)).toBe(true)
  })

  it("the store at bind is the one the bound operations use", async () => {
    const table = makeTable()
    const atBind = BlobStore.memory()
    const atRunTime = BlobStore.memory()
    const results = await run(
      Effect.gen(function* () {
        const geo = yield* GeoIndex.bind(CourierGeo).pipe(Effect.provide(storeLayer(atBind)))
        yield* geo.put({ courierId: "c-1", ...near(0.001), timestamp: NOW, photo: photoOf(3) })
        return yield* geo.nearby(search).pipe(Effect.provide(storeLayer(atRunTime)))
      }),
      table.layer,
    )
    expect(results.map((r) => r.item.photo)).toEqual([photoOf(3)])
    expect(atBind.inspect().calls.put).toBe(1)
    expect(atRunTime.inspect().calls).toMatchObject({ put: 0, get: 0 })
  })

  it("a codec no compressor is registered for is the [EDD-9078] defect", async () => {
    const message = defect(await runExit(GeoIndex.bind(ZstdGeo), makeTable().layer))
    expect(message).toContain("[EDD-9078] GeoIndex.bind")
    expect(message).toContain('entity "ZstdCourier"')
  })

  it("a generatedId entity's bound put draws its id from the bundled SecureRandom", async () => {
    const table = makeTable()
    const written = await run(
      Effect.gen(function* () {
        const geo = yield* GeoIndex.bind(GeneratedGeo)
        return yield* geo.put({ ...near(0.001), timestamp: NOW })
      }),
      table.layer,
    )
    expect((written as { readonly courierId: string }).courierId).toMatch(/^[0-9a-f-]{36}$/)
    expect(table.rows.size).toBe(1)
  })
})
