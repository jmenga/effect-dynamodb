/**
 * `GeoIndex.put` as an upload-ledger root (#179, design §6.2): the bound and
 * unbound puts of a geo entity that offloads a field run the entity's put —
 * a ledger root — and a geo entity that offloads nothing opens none.
 *
 * This package sees effect-dynamodb through its public entry point, so the
 * test reads the library's two internal references by their keys: the
 * test-only offload gate (to define an offloading entity before its write
 * paths are wired) and the current ledger (to observe it from inside the
 * request).
 */

import { Context, Effect, Layer, Schema } from "effect"
import { DynamoClient, DynamoModel, DynamoSchema, Entity, Table } from "effect-dynamodb"
import { describe, expect, it } from "vitest"
import * as GeoIndex from "../src/GeoIndex.js"

/** `@effect-dynamodb/schema`'s test-only `internal/OffloadGate.ts`, by its key. */
const OffloadGate = Context.Reference<boolean>("@effect-dynamodb/internal/OffloadGate", {
  defaultValue: () => false,
})

/** effect-dynamodb's `internal/BlobLedger.ts` `CurrentLedger`, by its key. */
const CurrentLedger = Context.Reference<{ readonly closed: boolean } | undefined>(
  "effect-dynamodb/Offload/CurrentLedger",
  { defaultValue: () => undefined },
)

// Offloading requires escaped key text (design §11.10).
const AppSchema = DynamoSchema.make({ name: "geoledger", version: 1, escapeKeys: true })

class Courier extends Schema.Class<Courier>("Courier")({
  courierId: Schema.String,
  latitude: Schema.optional(Schema.Number),
  longitude: Schema.optional(Schema.Number),
  timestamp: Schema.Number,
  photo: Schema.optional(Schema.Uint8Array),
  cell: Schema.optional(Schema.String),
  parentCell: Schema.optional(Schema.String),
  timePartition: Schema.optional(Schema.String),
}) {}

const courierConfig = {
  entityType: "Courier",
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

const OffloadingCouriers = Effect.runSync(
  Effect.sync(() =>
    Entity.make({
      ...courierConfig,
      model: DynamoModel.configure(Courier, {
        photo: { storedAs: DynamoModel.External({ contentType: "image/jpeg" }) },
      }),
    }),
  ).pipe(Effect.provideService(OffloadGate, true)),
)

const PlainCouriers = Entity.make({ ...courierConfig, entityType: "PlainCourier", model: Courier })

const MainTable = Table.make({
  schema: AppSchema,
  entities: { OffloadingCouriers, PlainCouriers },
})

const geoFields = {
  cell: { field: "cell", resolution: 15 },
  parentCell: { field: "parentCell", resolution: 3 },
  timePartition: { field: "timePartition", source: "timestamp", bucket: "hourly" },
} as const

const coordinates = (item: Courier) =>
  item.latitude !== undefined && item.longitude !== undefined
    ? { latitude: item.latitude, longitude: item.longitude }
    : undefined

const OffloadingGeo = GeoIndex.make({
  entity: OffloadingCouriers,
  index: "byCell",
  coordinates,
  fields: geoFields,
})

const PlainGeo = GeoIndex.make({
  entity: PlainCouriers,
  index: "byCell",
  coordinates,
  fields: geoFields,
})

/** A client answering every PutItem, recording whether it ran in an open ledger. */
const makeClient = () => {
  const ledgers: Array<boolean> = []
  const unused = () => Effect.die(new Error("not used by this test"))
  const service = new Proxy(
    {
      putItem: () =>
        Effect.withFiber((fiber) => {
          const ledger = fiber.getRef(CurrentLedger)
          ledgers.push(ledger !== undefined && !ledger.closed)
          return Effect.succeed({} as never)
        }),
    } as Record<string, unknown>,
    { get: (target, key) => (key in target ? target[key as string] : unused) },
  )
  return { layer: Layer.succeed(DynamoClient, service as never), ledgers }
}

const run = <A, E>(
  effect: Effect.Effect<A, E, DynamoClient | Table.TableConfig>,
  client: Layer.Layer<DynamoClient>,
) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(Layer.merge(client, MainTable.layer({ name: "couriers" })))),
  )

const courier = { courierId: "c-1", latitude: 51.5, longitude: -0.12, timestamp: 1_760_000_000_000 }

describe("GeoIndex.put — upload-ledger root", () => {
  it("the bound and unbound puts of an offloading geo entity run in a ledger", async () => {
    const { layer, ledgers } = makeClient()
    await run(
      Effect.gen(function* () {
        const bound = yield* GeoIndex.bind(OffloadingGeo)
        yield* bound.put(courier)
        yield* OffloadingGeo.put(courier)
      }),
      layer,
    )
    expect(ledgers).toEqual([true, true])
  })

  it("a geo entity that offloads nothing opens no ledger", async () => {
    const { layer, ledgers } = makeClient()
    await run(
      Effect.gen(function* () {
        const bound = yield* GeoIndex.bind(PlainGeo)
        yield* bound.put(courier)
      }),
      layer,
    )
    expect(ledgers).toEqual([false])
  })
})
