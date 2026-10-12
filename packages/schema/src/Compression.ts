/**
 * Compression — pluggable compressors for packed storage
 * (`DynamoModel.Packed({ format: "json", compression: { codec } })`).
 *
 * This module is runtime-neutral: it declares the synchronous
 * {@link Compressor} interface, a registry keyed by codec, and the
 * {@link Compression} service through which a registry reaches the read and
 * write paths. It never imports a compression library. Node implementations
 * (`node:zlib`: gzip, brotli, zstd) ship from `effect-dynamodb/compression/node`;
 * any other runtime can supply its own.
 *
 * Every pack/unpack site reads the service with `Effect.serviceOption`, so no
 * operation gains a requirement. An absent service behaves as an empty
 * registry: uncompressed packed values (`S`) read and write everywhere, and
 * only a value that needs a codec fails — with the operation's existing
 * `ValidationError`, whose `cause` is the tagged `CompressorNotRegistered`.
 *
 * See `DESIGN.md §7 "Packed Storage"`.
 */

import { Context, Layer } from "effect"
import { type CompressionCodec, compressionCodecs } from "./DynamoModel.js"

export type { CompressionCodec } from "./DynamoModel.js"

/**
 * A synchronous compression codec implementation.
 *
 * `compress` and `decompress` may throw (a corrupt payload, an output-size
 * limit); the library turns a throw into a `ValidationError` naming the
 * attribute. Tuning (level, quality, output limits) belongs to the
 * implementation, not to the stored data: readers only need the codec, which
 * the stored header carries.
 */
export interface Compressor {
  readonly codec: CompressionCodec
  readonly compress: (input: Uint8Array) => Uint8Array
  readonly decompress: (input: Uint8Array) => Uint8Array
}

/** Registered compressors, keyed by codec. */
export interface CompressionRegistry {
  readonly get: (codec: CompressionCodec) => Compressor | undefined
  /** The registered codecs, in registration order. */
  readonly codecs: ReadonlyArray<CompressionCodec>
}

/**
 * Build a registry from compressors.
 *
 * @throws `[EDD-9078]` when two compressors share a codec, or a compressor's
 *   `codec` is not `"gzip"`, `"brotli"` or `"zstd"`.
 */
export const make = (compressors: ReadonlyArray<Compressor>): CompressionRegistry => {
  const byCodec = new Map<CompressionCodec, Compressor>()
  for (const compressor of compressors) {
    const codec = (compressor as { readonly codec?: unknown } | null | undefined)?.codec
    if (!compressionCodecs.includes(codec as CompressionCodec)) {
      throw new Error(
        `[EDD-9078] Compression: a compressor has codec ${JSON.stringify(codec)} — expected ` +
          `one of ${compressionCodecs.map((c) => `"${c}"`).join(", ")}`,
      )
    }
    if (typeof compressor.compress !== "function" || typeof compressor.decompress !== "function") {
      throw new Error(
        `[EDD-9078] Compression: the "${codec as string}" compressor must provide ` +
          `compress and decompress functions`,
      )
    }
    if (byCodec.has(codec as CompressionCodec)) {
      throw new Error(
        `[EDD-9078] Compression: two compressors are registered for codec "${codec as string}" — ` +
          `register exactly one per codec`,
      )
    }
    byCodec.set(codec as CompressionCodec, compressor)
  }
  const codecs: ReadonlyArray<CompressionCodec> = Object.freeze([...byCodec.keys()])
  return Object.freeze({ get: (codec: CompressionCodec) => byCodec.get(codec), codecs })
}

/** The registry with no compressors — what an absent `Compression` service means. */
export const empty: CompressionRegistry = make([])

/**
 * Effect `Context.Service` carrying the {@link CompressionRegistry} packed
 * storage reads and writes with.
 *
 * Provide it with {@link Compression.layer} merged into the application layer
 * beside the client (recommended: it reaches every layer and program however
 * the client layer is composed), pass `compressors` to `DynamoClient.make`
 * (bundled into every bound operation), or use `DynamoClient.layer({
 * compressors })` — whose `Compression` output does not survive a wrapper
 * layer that consumes it through `Layer.provide`.
 *
 * @example
 * ```typescript
 * import * as NodeCompression from "effect-dynamodb/compression/node"
 *
 * const AppLayer = Layer.mergeAll(
 *   DynamoClient.layer({ region: "us-east-1" }),
 *   Compression.layer([NodeCompression.zstd(), NodeCompression.gzip()]),
 * )
 * ```
 */
export class Compression extends Context.Service<Compression, CompressionRegistry>()(
  "@effect-dynamodb/Compression",
) {
  /** A layer providing a registry built from `compressors` (see {@link make}). */
  static readonly layer = (compressors: ReadonlyArray<Compressor>): Layer.Layer<Compression> =>
    Layer.succeed(Compression, make(compressors))

  /** Build a registry from compressors (see {@link make}). */
  static readonly make = make

  /** The registry with no compressors. */
  static readonly empty = empty
}
