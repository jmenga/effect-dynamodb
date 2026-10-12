/// <reference types="node" />
/**
 * Node compressors for packed storage — `effect-dynamodb/compression/node`.
 *
 * `node:zlib`-backed {@link Compressor} implementations of the three codecs
 * `DynamoModel.Packed({ format: "json", compression: { codec } })` accepts.
 * This subpath is the only module of `effect-dynamodb` that imports
 * `node:zlib`; the main entry stays runtime-neutral, so other runtimes can
 * register their own implementations of the same interface.
 *
 * @example
 * ```typescript
 * import { DynamoClient } from "effect-dynamodb"
 * import * as NodeCompression from "effect-dynamodb/compression/node"
 *
 * const live = DynamoClient.layer({
 *   region: "us-east-1",
 *   compressors: [NodeCompression.zstd(), NodeCompression.gzip()],
 * })
 * ```
 *
 * Register every codec values were written with for as long as such values
 * exist: a reader needs the codec named in a value's header, whatever the
 * writer's current config.
 */

import * as zlib from "node:zlib"
import type { Compressor } from "@effect-dynamodb/schema/Compression.js"

export type { Compressor } from "@effect-dynamodb/schema/Compression.js"

/** Options shared by every Node compressor. */
export interface DecompressOptions {
  /**
   * Upper bound, in bytes, on one value's decompressed size — a guard against
   * decompression bombs. Decompressing past it throws, which the library
   * reports as a `ValidationError`. Default: Node's own limit.
   */
  readonly maxOutputLength?: number | undefined
}

/** A plain `Uint8Array` view of a Node `Buffer` (zero-copy). */
const view = (buffer: Uint8Array): Uint8Array =>
  new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)

const decompressOptions = (options: DecompressOptions): { maxOutputLength?: number } =>
  options.maxOutputLength === undefined ? {} : { maxOutputLength: options.maxOutputLength }

/** gzip (`zlib.gzipSync` / `zlib.gunzipSync`). */
export const gzip = (
  options: DecompressOptions & {
    /** zlib compression level, 0–9. Default: Node's default (6). */
    readonly level?: number | undefined
  } = {},
): Compressor => {
  const compressOptions: zlib.ZlibOptions =
    options.level === undefined ? {} : { level: options.level }
  const inflateOptions: zlib.ZlibOptions = decompressOptions(options)
  return {
    codec: "gzip",
    compress: (input) => view(zlib.gzipSync(input, compressOptions)),
    decompress: (input) => view(zlib.gunzipSync(input, inflateOptions)),
  }
}

/** brotli (`zlib.brotliCompressSync` / `zlib.brotliDecompressSync`). */
export const brotli = (
  options: DecompressOptions & {
    /** Brotli quality, 0–11. Default: Node's default (11). */
    readonly quality?: number | undefined
  } = {},
): Compressor => {
  const quality = options.quality
  const inflateOptions: zlib.BrotliOptions = decompressOptions(options)
  return {
    codec: "brotli",
    compress: (input) =>
      view(
        zlib.brotliCompressSync(input, {
          params: {
            [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
            [zlib.constants.BROTLI_PARAM_SIZE_HINT]: input.byteLength,
            ...(quality === undefined ? {} : { [zlib.constants.BROTLI_PARAM_QUALITY]: quality }),
          },
        }),
      ),
    decompress: (input) => view(zlib.brotliDecompressSync(input, inflateOptions)),
  }
}

/** True iff this Node runtime has zstd (`zlib.zstdCompressSync`, Node ≥ 22.15). */
export const hasZstd = (): boolean =>
  typeof (zlib as { readonly zstdCompressSync?: unknown }).zstdCompressSync === "function" &&
  typeof (zlib as { readonly zstdDecompressSync?: unknown }).zstdDecompressSync === "function"

/**
 * zstd (`zlib.zstdCompressSync` / `zlib.zstdDecompressSync`).
 *
 * @throws a plain `Error` at construction when this runtime has no zstd
 *   (Node < 22.15) — use {@link available} to register only what exists.
 */
export const zstd = (
  options: DecompressOptions & {
    /** zstd compression level. Default 3. */
    readonly level?: number | undefined
  } = {},
): Compressor => {
  if (!hasZstd()) {
    throw new Error(
      "effect-dynamodb/compression/node: zstd needs Node >= 22.15 (zlib.zstdCompressSync), " +
        "which this runtime does not have. Use gzip() or brotli(), or available() to register " +
        "what this runtime supports.",
    )
  }
  const compressOptions: zlib.ZstdOptions = {
    params: { [zlib.constants.ZSTD_c_compressionLevel]: options.level ?? 3 },
  }
  const inflateOptions: zlib.ZstdOptions = decompressOptions(options)
  return {
    codec: "zstd",
    compress: (input) => view(zlib.zstdCompressSync(input, compressOptions)),
    decompress: (input) => view(zlib.zstdDecompressSync(input, inflateOptions)),
  }
}

/**
 * gzip and brotli, plus zstd when this runtime has it — every codec this
 * runtime can read, with default options.
 */
export const available = (options: DecompressOptions = {}): ReadonlyArray<Compressor> => [
  gzip(options),
  brotli(options),
  ...(hasZstd() ? [zstd(options)] : []),
]
