/**
 * BlobStore — the store offloaded attribute values live in (#179).
 *
 * A field declared `DynamoModel.Packed({ external })` (an overflow field, in
 * the store at or above its threshold) or `DynamoModel.External()` (a binary
 * field, always in the store) keeps a small pointer in the item and its value
 * in a versioned blob store: every write uploads a new version and the
 * pointer names it, so a stored pointer never changes meaning.
 *
 * This module is runtime-neutral. It declares the {@link BlobStoreService}
 * contract, the {@link BlobStoreFailure} a store fails with, the
 * {@link BlobStore} service through which a store reaches the library, and an
 * in-memory store for tests ({@link BlobStore.memory}). The S3 store ships
 * from `effect-dynamodb/blob/s3`; any other store implements the contract.
 *
 * Every site reads the service with `Effect.serviceOption`, so no operation
 * gains a requirement.
 *
 * See `DESIGN.md §7 "Offloaded Storage"`.
 */

import type { BlobChecksum, BlobRef } from "@effect-dynamodb/schema/internal/BlobPointer.js"
import {
  type Crc64Nvme,
  crc64nvme as crc64nvmeDigest,
  make as makeCrc64nvme,
} from "@effect-dynamodb/schema/internal/Crc64Nvme.js"
import { Context, Layer } from "effect"
import { type BlobStoreService, validateService } from "./internal/BlobStoreContract.js"
import {
  type MemoryBlobStore,
  type MemoryBlobStoreOptions,
  make as makeMemory,
} from "./internal/MemoryBlobStore.js"

export type { BlobChecksum, BlobRef }
export type {
  BlobCopyRequest,
  BlobListing,
  BlobPresignOptions,
  BlobPutRequest,
  BlobPutResult,
  BlobSourceFailure,
  BlobStoreLimits,
  BlobStoreMarks,
  BlobStoreService,
  ByteRange,
} from "./internal/BlobStoreContract.js"
export { BlobStoreFailure } from "./internal/BlobStoreContract.js"
export type {
  MemoryBlobCall,
  MemoryBlobFault,
  MemoryBlobSnapshot,
  MemoryBlobStore,
  MemoryBlobStoreOptions,
  MemoryBlobVersion,
} from "./internal/MemoryBlobStore.js"
export type { Crc64Nvme }

/**
 * CRC-64/NVME, for store implementers: `crc64nvme(bytes)` is the 8-byte
 * checksum, most significant byte first (the bytes whose base64 S3 sends as
 * `ChecksumCRC64NVME`); `crc64nvme.make()` is an incremental hasher.
 */
export interface Crc64NvmeFunction {
  (bytes: Uint8Array): Uint8Array
  /** An incremental hasher: `update(bytes)` as often as needed, then `digest()`. */
  readonly make: () => Crc64Nvme
}

const crc64nvme: Crc64NvmeFunction = Object.assign(
  (bytes: Uint8Array): Uint8Array => crc64nvmeDigest(bytes),
  { make: makeCrc64nvme },
)

const layer = (service: BlobStoreService): Layer.Layer<BlobStore> =>
  Layer.succeed(BlobStore, validateService("BlobStore.layer", service))

const memory = (options?: MemoryBlobStoreOptions): MemoryBlobStore =>
  validateService("BlobStore.memory", makeMemory(options)) as MemoryBlobStore

/**
 * Effect `Context.Service` carrying the {@link BlobStoreService} offloaded
 * values are written to and read from.
 *
 * Provide it with {@link BlobStore.layer} (any store), the S3 store's layer,
 * or {@link BlobStore.layerMemory} in tests. A member with an offloaded field
 * needs a store wherever it is first resolvable — `DynamoClient.make`,
 * `EventStore.bind`, … (`[EDD-9115]`).
 *
 * @example
 * ```typescript
 * // tests: an in-memory store whose contents the test can inspect
 * const store = BlobStore.memory()
 * const TestLayer = Layer.mergeAll(MockDynamoClient, BlobStore.layer(store))
 * // … run the program, then:
 * store.inspect().versions
 * ```
 */
export class BlobStore extends Context.Service<BlobStore, BlobStoreService>()(
  "@effect-dynamodb/BlobStore",
) {
  /**
   * A layer providing `service`.
   *
   * @throws `[EDD-9116]` when the store is invalid: `limits` that are not
   *   non-negative integers within the pointer's bounds, a `maxUploadAge`
   *   that is not a positive finite `Duration`, a concurrency that is not a
   *   positive integer, an invalid `prefix`, or a missing operation.
   */
  static readonly layer: (service: BlobStoreService) => Layer.Layer<BlobStore> = layer

  /**
   * An in-memory store for tests: versioned (stable keys, 32-hex version ids)
   * or key-per-write, with every capability, `TestClock`-driven
   * `lastModified`, fault injection (`failures`) and `inspect()`.
   *
   * @throws `[EDD-9116]` for invalid options.
   */
  static readonly memory: (options?: MemoryBlobStoreOptions) => MemoryBlobStore = memory

  /** A layer providing {@link BlobStore.memory}`(options)`. */
  static readonly layerMemory = (options?: MemoryBlobStoreOptions): Layer.Layer<BlobStore> =>
    layer(memory(options))

  /** CRC-64/NVME, for store implementers (see {@link Crc64NvmeFunction}). */
  static readonly crc64nvme: Crc64NvmeFunction = crc64nvme
}
