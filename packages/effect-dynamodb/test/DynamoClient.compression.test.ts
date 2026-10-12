/**
 * Compressor registration on the DynamoClient layers (packed storage).
 */
import { describe, expect, it } from "@effect/vitest"
import { Compression } from "@effect-dynamodb/schema/Compression.js"
import { Config, ConfigProvider, Effect, Layer, Option } from "effect"
import * as NodeCompression from "../src/compression/node.js"
import { DynamoClient } from "../src/DynamoClient.js"

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
          compressors: [NodeCompression.zstd(), NodeCompression.gzip()],
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
          Compression.layer([NodeCompression.brotli()]),
          DynamoClient.layer(clientConfig),
        ),
      ),
    ),
  )

  it("validates the registry (EDD-9078)", () => {
    expect(() =>
      DynamoClient.layer({
        ...clientConfig,
        compressors: [NodeCompression.gzip(), NodeCompression.gzip()],
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
          compressors: [NodeCompression.gzip()],
        }),
      ),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ REGION: "us-east-1" }))),
    ),
  )
})
