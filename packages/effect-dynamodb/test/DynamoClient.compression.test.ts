/**
 * Compressor registration on the DynamoClient layers (packed storage).
 */
import { describe, expect, it } from "@effect/vitest"
import { Compression } from "@effect-dynamodb/schema/Compression.js"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Config, ConfigProvider, Effect, Layer, Option, Schema } from "effect"
import * as ZlibCompression from "../src/compression/zlib.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as EventStore from "../src/EventStore.js"
import * as Table from "../src/Table.js"
import { unregisteredCodecDefect } from "./helpers/MissingCompressor.js"

const clientConfig = {
  region: "us-east-1",
  endpoint: "http://localhost:1",
  credentials: { accessKeyId: "x", secretAccessKey: "y" },
}

describe("DynamoClient.layer({ compressors })", () => {
  it.effect("provides DynamoClient and the Compression registry", () =>
    Effect.gen(function* () {
      const registry = yield* Compression
      expect(registry.codecs).toEqual(["zstd", "gzip"])
      yield* DynamoClient
    }).pipe(
      Effect.provide(
        DynamoClient.layer({
          ...clientConfig,
          compressors: [ZlibCompression.zstd(), ZlibCompression.gzip()],
        }),
      ),
    ),
  )

  it.effect("without compressors provides no Compression (an ambient one stays visible)", () =>
    Effect.gen(function* () {
      expect(Option.isNone(yield* Effect.serviceOption(Compression))).toBe(true)
      yield* DynamoClient
    }).pipe(Effect.provide(DynamoClient.layer(clientConfig))),
  )

  it.effect("an ambient Compression is not shadowed by a layer without compressors", () =>
    Effect.gen(function* () {
      expect((yield* Compression).codecs).toEqual(["brotli"])
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Compression.layer([ZlibCompression.brotli()]),
          DynamoClient.layer(clientConfig),
        ),
      ),
    ),
  )

  it("validates the registry (EDD-9078)", () => {
    expect(() =>
      DynamoClient.layer({
        ...clientConfig,
        compressors: [ZlibCompression.gzip(), ZlibCompression.gzip()],
      }),
    ).toThrow(/\[EDD-9078\]/)
  })
})

describe("DynamoClient.layerConfig({ compressors })", () => {
  it.effect("provides DynamoClient and the Compression registry", () =>
    Effect.gen(function* () {
      expect((yield* Compression).codecs).toEqual(["gzip"])
      yield* DynamoClient
    }).pipe(
      Effect.provide(
        DynamoClient.layerConfig({
          region: Config.String("REGION"),
          compressors: [ZlibCompression.gzip()],
        }),
      ),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ REGION: "us-east-1" }))),
    ),
  )
})

describe("Compression behind a wrapper layer (the guide's pitfall)", () => {
  class Noted extends Schema.TaggedClass<Noted>()("Noted", { note: Schema.String }) {}
  const AppTable = Table.make({
    schema: DynamoSchema.make({ name: "wrap", version: 1 }),
    entities: {},
  })
  const Notes = EventStore.makeStream({
    table: AppTable,
    streamName: "Notes",
    events: [Noted],
    streamId: { composite: ["noteId"] },
    storedAs: { data: DynamoModel.Packed({ format: "json", compression: { codec: "zstd" } }) },
  })
  const TableLayer = AppTable.layer({ name: "wrap-table" })

  /** A client decorated by a wrapper layer: only DynamoClient comes out of it. */
  const traced = <ROut>(inner: Layer.Layer<DynamoClient | ROut>) =>
    Layer.effect(
      DynamoClient,
      Effect.gen(function* () {
        const client = yield* DynamoClient
        return { ...client }
      }),
    ).pipe(Layer.provide(inner))

  it.effect("DynamoClient.layer({ compressors }) behind Layer.provide loses Compression", () =>
    Effect.gen(function* () {
      expect(Option.isNone(yield* Effect.serviceOption(Compression))).toBe(true)
      // Binding a stream that names zstd says so up front.
      const message = unregisteredCodecDefect(yield* Effect.exit(EventStore.bind(Notes)))
      expect(message).toContain("no Compression registry is in scope")
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          traced(DynamoClient.layer({ ...clientConfig, compressors: [ZlibCompression.zstd()] })),
          TableLayer,
        ),
      ),
    ),
  )

  it.effect("Compression.layer merged into the app layer survives any client composition", () =>
    Effect.gen(function* () {
      expect((yield* Compression).codecs).toEqual(["zstd"])
      const bound = yield* EventStore.bind(Notes)
      expect(bound.storedAs.data?.compression?.codec).toBe("zstd")
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          traced(DynamoClient.layer(clientConfig)),
          Compression.layer([ZlibCompression.zstd()]),
          TableLayer,
        ),
      ),
    ),
  )

  it.effect("DynamoClient.layer({ compressors }) used directly still provides it", () =>
    Effect.gen(function* () {
      yield* EventStore.bind(Notes)
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          DynamoClient.layer({ ...clientConfig, compressors: [ZlibCompression.zstd()] }),
          TableLayer,
        ),
      ),
    ),
  )
})
