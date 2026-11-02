/**
 * `nearby`'s error channel is the 1.25.0 one (#147): packed storage never
 * widens it — a missing compressor is a `ValidationError` whose `cause` is a
 * `CompressorNotRegistered`. Offloaded fields (#179, design §9.3) add
 * `BlobStoreError` to `nearby` and the bound `put` of an entity that
 * offloads, and only to theirs; the bound `put` fails as the entity's own
 * `put` does. One item type serves `put`'s input and `nearby`'s results, so
 * a binary field is its bytes on both (§8.4).
 *
 * Compile-time only; checked by `tsc -p tsconfig.test.json` (`pnpm check`).
 */

import { type Effect, Schema } from "effect"
import {
  type BlobStoreError,
  type DynamoClientError,
  DynamoModel,
  Entity,
  type ValidationError,
} from "effect-dynamodb"
import { describe, expect, expectTypeOf, it } from "vitest"
import * as GeoIndex from "../src/GeoIndex.js"
import type * as GeoSearch from "../src/GeoSearch.js"

class Courier extends Schema.Class<Courier>("Courier")({
  courierId: Schema.String,
  latitude: Schema.optional(Schema.Number),
  longitude: Schema.optional(Schema.Number),
  timestamp: Schema.Number,
  notes: Schema.optional(Schema.Struct({ text: Schema.String })),
  photo: Schema.optional(Schema.Uint8Array),
  cell: Schema.optional(Schema.String),
  parentCell: Schema.optional(Schema.String),
  timePartition: Schema.optional(Schema.String),
}) {}

const config = {
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

const Offloading = Entity.make({
  ...config,
  model: DynamoModel.configure(Courier, {
    notes: { storedAs: DynamoModel.Packed({ format: "json", external: { threshold: 64 } }) },
    photo: { storedAs: DynamoModel.External() },
  }),
})
const Plain = Entity.make({ ...config, model: Courier })

const geo = {
  index: "byCell",
  coordinates: () => undefined,
  fields: {
    cell: { field: "cell", resolution: 15 },
    parentCell: { field: "parentCell", resolution: 3 },
    timePartition: { field: "timePartition", source: "timestamp", bucket: "hourly" },
  },
} as const

const OffloadingGeo = GeoIndex.make({ ...geo, entity: Offloading })
const PlainGeo = GeoIndex.make({ ...geo, entity: Plain })

/** The `BoundGeoIndex` `GeoIndex.bind` returns for `G`. */
type Bound<G> =
  G extends GeoIndex.GeoIndex<infer A, infer P, infer B>
    ? Effect.Success<ReturnType<typeof GeoIndex.bind<A, P, B>>>
    : never

describe("GeoIndex error channels", () => {
  it("nearby fails with DynamoClientError | ValidationError, bound or not", () => {
    type Unbound = ReturnType<GeoIndex.GeoIndex<unknown, unknown>["nearby"]>
    type Bound = ReturnType<GeoIndex.BoundGeoIndex<unknown>["nearby"]>
    type Search = ReturnType<typeof GeoSearch.nearby<unknown>>
    expectTypeOf<Effect.Error<Unbound>>().toEqualTypeOf<DynamoClientError | ValidationError>()
    expectTypeOf<Effect.Error<Bound>>().toEqualTypeOf<DynamoClientError | ValidationError>()
    expectTypeOf<Effect.Error<Search>>().toEqualTypeOf<DynamoClientError | ValidationError>()
    expect(true).toBe(true)
  })

  it("nearby adds BlobStoreError for an entity that offloads, and only for one", () => {
    expectTypeOf<Effect.Error<ReturnType<typeof OffloadingGeo.nearby>>>().toEqualTypeOf<
      DynamoClientError | ValidationError | BlobStoreError
    >()
    expectTypeOf<Effect.Error<ReturnType<Bound<typeof OffloadingGeo>["nearby"]>>>().toEqualTypeOf<
      DynamoClientError | ValidationError | BlobStoreError
    >()
    expectTypeOf<Effect.Error<ReturnType<typeof PlainGeo.nearby>>>().toEqualTypeOf<
      DynamoClientError | ValidationError
    >()
    expectTypeOf<Effect.Error<ReturnType<Bound<typeof PlainGeo>["nearby"]>>>().toEqualTypeOf<
      DynamoClientError | ValidationError
    >()
    expectTypeOf<GeoIndex.GeoBlobErrors<any>>().toEqualTypeOf<never>()
    expect(true).toBe(true)
  })

  it("the bound put fails as the entity's own put does, BlobStoreError included", () => {
    type BoundPut<G> = Bound<G>["put"]
    type OwnPut<E extends { readonly put: (input: never) => { asEffect: () => unknown } }> =
      ReturnType<ReturnType<E["put"]>["asEffect"]>
    expectTypeOf<Effect.Error<ReturnType<BoundPut<typeof OffloadingGeo>>>>().toEqualTypeOf<
      Effect.Error<OwnPut<typeof Offloading>>
    >()
    expectTypeOf<BlobStoreError>().toExtend<
      Effect.Error<ReturnType<BoundPut<typeof OffloadingGeo>>>
    >()
    expectTypeOf<Effect.Error<ReturnType<BoundPut<typeof PlainGeo>>>>().toEqualTypeOf<
      Effect.Error<OwnPut<typeof Plain>>
    >()
    expectTypeOf<
      Effect.Error<ReturnType<BoundPut<typeof PlainGeo>>>
    >().toEqualTypeOf<GeoIndex.GeoPutError>()
    // An annotated `BoundGeoIndex<A>` keeps the put union it always had.
    expectTypeOf<
      Effect.Error<ReturnType<GeoIndex.BoundGeoIndex<unknown>["put"]>>
    >().toEqualTypeOf<GeoIndex.GeoPutError>()
    expect(true).toBe(true)
  })

  it("a type-erased put builder keeps the put union, not unknown", () => {
    // `any` contributes nothing (design §9.3): binding a `GeoIndex<A, any>`
    // (e.g. over a `GeoEntity<A, any>`) gives the bound put `GeoPutError`.
    expectTypeOf<GeoIndex.GeoPutErrorOf<any>>().toEqualTypeOf<GeoIndex.GeoPutError>()
    expectTypeOf<GeoIndex.GeoPutErrorOf<any, BlobStoreError>>().toEqualTypeOf<
      GeoIndex.GeoPutError | BlobStoreError
    >()
    type AnyBoundPut = ReturnType<
      Effect.Success<ReturnType<typeof GeoIndex.bind<{ readonly id: string }, any, never>>>["put"]
    >
    expectTypeOf<Effect.Error<AnyBoundPut>>().toEqualTypeOf<GeoIndex.GeoPutError>()
    expect(true).toBe(true)
  })
})

describe("GeoIndex item type", () => {
  it("a binary field is its bytes on put's input and on nearby's results", () => {
    type PutInput = Parameters<typeof OffloadingGeo.put>[0]
    type Item = Effect.Success<ReturnType<typeof OffloadingGeo.nearby>>[number]["item"]
    expectTypeOf<PutInput["photo"]>().toEqualTypeOf<Uint8Array | undefined>()
    expectTypeOf<Item["photo"]>().toEqualTypeOf<Uint8Array | undefined>()
    // Overflow fields keep their domain type.
    expectTypeOf<Item["notes"]>().toEqualTypeOf<{ readonly text: string } | undefined>()
    // The entity's own put still takes every binary input.
    expectTypeOf<Uint8Array>().toExtend<Parameters<typeof Offloading.put>[0]["photo"]>()
    expectTypeOf<Parameters<typeof Offloading.put>[0]["photo"]>().not.toEqualTypeOf<
      Uint8Array | undefined
    >()
    expect(true).toBe(true)
  })

  it("an entity without binary fields keeps its put input as the item type", () => {
    expectTypeOf<Parameters<typeof PlainGeo.put>[0]>().toEqualTypeOf<
      Parameters<typeof Plain.put>[0]
    >()
    expect(true).toBe(true)
  })
})
