/**
 * The blob resolver (#179, design §8): phase two of the two-phase decode,
 * driven with placeholders over objects in the in-memory store.
 *
 * - Modes: overflow eager / binary lazy by default, both eager, both lazy;
 *   eager fetches at the store's `readConcurrency`; a row without
 *   placeholders costs no I/O.
 * - The upload ledger's read cache: what the operation uploaded is never
 *   fetched; lazy values never pin the ledger.
 * - Verification: the object's size, the content's size and CRC-64/NVME
 *   (after decompression for compressed json) → `ChecksumMismatch`; a missing
 *   object (`NotFound`), no store (`NotProvided`), a missing compressor or a
 *   payload that is not UTF-8 JSON (`ValidationError`).
 * - Lazy values: `read()` per call, ranged reads (unverified), `stream()`
 *   verified as it ends, presigned URLs (default expiry, `Unsupported`,
 *   `Rejected`), and inline values.
 */

import { describe, expect, it } from "@effect/vitest"
import { Compression, type Compressor } from "@effect-dynamodb/schema/Compression.js"
import { BlobStoreError, ValidationError } from "@effect-dynamodb/schema/Errors.js"
import * as BlobPointer from "@effect-dynamodb/schema/internal/BlobPointer.js"
import { crc64nvme } from "@effect-dynamodb/schema/internal/Crc64Nvme.js"
import { Effect, Exit, Layer, Option, Stream } from "effect"
import { BlobStore, type BlobStoreService, type MemoryBlobStore } from "../src/BlobStore.js"
import * as BlobLedger from "../src/internal/BlobLedger.js"
import * as BlobResolver from "../src/internal/BlobResolver.js"
import {
  type BlobHandle,
  isBlobHandle,
  isOffloadedValue,
  type OffloadedValue,
} from "../src/internal/OffloadValues.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text)

/** A reversible stand-in for gzip: the bytes reversed. */
const reversing: Compressor = {
  codec: "gzip",
  compress: (input) => new Uint8Array(input).reverse(),
  decompress: (input) => new Uint8Array(input).reverse(),
}

const pointerOf = (fields: BlobPointer.BlobPointerFields): BlobPointer.BlobPointer => {
  const made = BlobPointer.make(fields)
  if (typeof made === "string") throw new Error(made)
  return made
}

/**
 * Store `object` and return the pointer naming it — `content` is what the
 * pointer's checksum and content size describe (the object, unless
 * compressed); `overrides` corrupt the pointer.
 */
const stored = (
  store: BlobStoreService,
  options: {
    readonly key: string
    readonly kind: BlobPointer.BlobPointerKind
    readonly content: Uint8Array
    readonly object?: Uint8Array
    readonly codec?: "none" | "gzip"
    readonly contentType?: string
    readonly overrides?: Partial<BlobPointer.BlobPointerFields>
  },
) =>
  Effect.gen(function* () {
    const object = options.object ?? options.content
    const { ref } = yield* store.put({
      key: options.key,
      body: object,
      contentLength: object.length,
      checksum: Effect.succeed({ algorithm: "crc64nvme", value: crc64nvme(object) }),
      contentType: options.contentType ?? "application/octet-stream",
      metadata: {},
    })
    return pointerOf({
      kind: options.kind,
      codec: options.codec ?? "none",
      ref,
      objectSize: object.length,
      contentSize: options.content.length,
      checksum: { algorithm: "crc64nvme", value: crc64nvme(options.content) },
      contentType: Option.fromNullishOr(options.contentType),
      ...options.overrides,
    })
  })

const json = (store: BlobStoreService, value: unknown, key = "p/doc/notes") =>
  stored(store, { key, kind: "json", content: bytesOf(JSON.stringify(value)) })

const binary = (store: BlobStoreService, bytes: Uint8Array, key = "p/doc/scan") =>
  stored(store, { key, kind: "bytes", content: bytes, contentType: "application/pdf" })

const overflowPending = (pointer: BlobPointer.BlobPointer, field = "notes") =>
  BlobResolver.makePendingBlob({ pointer, attribute: field, field, kind: "overflow" })

const binaryPending = (pointer: BlobPointer.BlobPointer, field = "scan") =>
  BlobResolver.makePendingBlob({ pointer, attribute: field, field, kind: "binary" })

const options = (
  overrides: Partial<BlobResolver.ResolveOptions> = {},
): BlobResolver.ResolveOptions => ({
  entityType: "Doc",
  operation: "Entity.get",
  modes: BlobResolver.DEFAULT_MODES,
  ...overrides,
})

const withStore = (store: BlobStoreService) => Effect.provide(BlobStore.layer(store))

const gets = (store: MemoryBlobStore) => store.inspect().calls.get

const scanBytes = bytesOf("%PDF-1.7 a scanned document, sixty-odd bytes long ...........")

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

describe("BlobResolver — modes", () => {
  it.effect("by default an overflow field resolves eagerly and a binary one lazily", () =>
    Effect.gen(function* () {
      const store = BlobStore.memory()
      const notes = yield* json(store, { text: "hello" })
      const scan = yield* binary(store, scanBytes)
      const row: Record<string, unknown> = {
        docId: "d-1",
        notes: overflowPending(notes),
        scan: binaryPending(scan),
      }
      yield* BlobResolver.resolveRows([row], options()).pipe(withStore(store))
      expect(row.notes).toEqual({ text: "hello" })
      expect(row.docId).toBe("d-1")
      expect(isBlobHandle(row.scan)).toBe(true)
      expect(gets(store)).toBe(1)

      const handle = row.scan as BlobHandle
      expect(handle.location).toBe("external")
      expect(handle.ref).toEqual(Option.some(scan.ref))
      expect(handle.size).toBe(scanBytes.length)
      expect(handle.contentType).toBe("application/pdf")
      expect(handle.checksum.value).toEqual(crc64nvme(scanBytes))
      // No I/O until read; every read fetches.
      expect(yield* handle.read()).toEqual(scanBytes)
      expect(yield* handle.read()).toEqual(scanBytes)
      expect(gets(store)).toBe(3)
      const chunks = yield* Stream.runCollect(handle.stream())
      expect(Buffer.concat(chunks)).toEqual(Buffer.from(scanBytes))
    }),
  )

  it.effect("eager modes resolve a binary field to its bytes", () =>
    Effect.gen(function* () {
      const store = BlobStore.memory()
      const scan = yield* binary(store, scanBytes)
      const [value] = yield* BlobResolver.resolveAll(
        [binaryPending(scan)],
        options({ modes: BlobResolver.EAGER_MODES }),
      ).pipe(withStore(store))
      expect(value).toEqual(scanBytes)
    }),
  )

  it.effect("lazy modes resolve an overflow field to a value that decodes on read", () =>
    Effect.gen(function* () {
      const store = BlobStore.memory()
      const notes = yield* json(store, { text: "hello" })
      const decoded: Array<string> = []
      const [value] = yield* BlobResolver.resolveAll(
        [overflowPending(notes)],
        options({
          modes: BlobResolver.LAZY_MODES,
          decode: (field, wire) =>
            Effect.sync(() => {
              decoded.push(field)
              return { decoded: wire }
            }),
        }),
      ).pipe(withStore(store))
      expect(isOffloadedValue(value)).toBe(true)
      expect(gets(store)).toBe(0)
      const lazy = value as OffloadedValue<unknown>
      expect(lazy.location).toBe("external")
      expect(lazy.size).toBe(notes.objectSize)
      expect(yield* lazy.read()).toEqual({ decoded: { text: "hello" } })
      expect(decoded).toEqual(["notes"])
      expect(gets(store)).toBe(1)
    }),
  )

  it.effect("eager fetches run at the store's readConcurrency", () =>
    Effect.gen(function* () {
      const memory = BlobStore.memory({ readConcurrency: 2 })
      let inFlight = 0
      let most = 0
      const store: BlobStoreService = {
        ...memory,
        get: (ref, opts) =>
          Stream.unwrap(
            Effect.gen(function* () {
              inFlight++
              most = Math.max(most, inFlight)
              yield* Effect.yieldNow
              yield* Effect.yieldNow
              inFlight--
              return memory.get(ref, opts)
            }),
          ),
      }
      const pointers = yield* Effect.forEach([1, 2, 3, 4, 5], (n) =>
        json(memory, { n }, `p/doc/${n}`),
      )
      const values = yield* BlobResolver.resolveAll(
        pointers.map((pointer) => overflowPending(pointer)),
        options(),
      ).pipe(withStore(store))
      expect(values).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }, { n: 5 }])
      expect(most).toBe(2)
    }),
  )

  it.effect("rows without placeholders resolve with no I/O, and need no store", () =>
    Effect.gen(function* () {
      const row = { docId: "d-1", notes: { text: "inline" } }
      yield* BlobResolver.resolveRows([row], options())
      expect(row).toEqual({ docId: "d-1", notes: { text: "inline" } })
    }),
  )

  it("a placeholder's kind must match its pointer's", () => {
    const pointer = pointerOf({
      kind: "bytes",
      codec: "none",
      ref: { key: "k", version: "v" },
      objectSize: 1,
      contentSize: 1,
      checksum: { algorithm: "crc64nvme", value: new Uint8Array(8) },
      contentType: Option.none(),
    })
    expect(() => overflowPending(pointer)).toThrow(/a bytes pointer cannot stand for the overflow/)
    expect(BlobResolver.isPendingBlob(binaryPending(pointer))).toBe(true)
    expect(BlobResolver.isPendingBlob({ pointer })).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// The read cache
// ---------------------------------------------------------------------------

describe("BlobResolver — the ledger's read cache", () => {
  it.effect("what the operation uploaded resolves without a fetch", () =>
    Effect.gen(function* () {
      const store = BlobStore.memory()
      const text = JSON.stringify({ text: "just written" })
      yield* BlobLedger.root(
        Effect.gen(function* () {
          const notes = yield* BlobLedger.upload({
            store,
            key: "p/doc/notes",
            content: { kind: "json", text },
            codec: "none",
            contentType: "application/json",
            metadata: {},
            target: {
              table: "docs",
              entityType: "Doc",
              attribute: "notes",
              rowKey: { pk: "d-1" },
              operation: "Entity.put",
              copiesPointers: false,
            },
          })
          const scan = yield* BlobLedger.upload({
            store,
            key: "p/doc/scan",
            content: { kind: "bytes", bytes: scanBytes },
            codec: "none",
            contentType: "application/pdf",
            metadata: {},
            target: {
              table: "docs",
              entityType: "Doc",
              attribute: "scan",
              rowKey: { pk: "d-1" },
              operation: "Entity.put",
              copiesPointers: false,
            },
          })
          const [eagerNotes, eagerScan] = yield* BlobResolver.resolveAll(
            [overflowPending(notes), binaryPending(scan)],
            options({ modes: BlobResolver.EAGER_MODES, committed: true }),
          )
          expect(eagerNotes).toEqual({ text: "just written" })
          expect(eagerScan).toEqual(scanBytes)
          // A copy: the cache is never handed out.
          expect(eagerScan).not.toBe(BlobLedger.cached(yield* BlobLedger.current, scan.ref))
          expect(gets(store)).toBe(0)

          // A lazy value never pins the ledger: it fetches.
          const [lazy] = yield* BlobResolver.resolveAll(
            [binaryPending(scan)],
            options({ modes: BlobResolver.LAZY_MODES }),
          )
          expect(yield* (lazy as BlobHandle).read()).toEqual(scanBytes)
          expect(gets(store)).toBe(1)
        }),
      ).pipe(withStore(store))
    }),
  )
})

// ---------------------------------------------------------------------------
// Verification and failures
// ---------------------------------------------------------------------------

describe("BlobResolver — verification", () => {
  const failure = (
    store: BlobStoreService | undefined,
    pending: BlobResolver.PendingBlob,
    modes: BlobResolver.Modes = BlobResolver.EAGER_MODES,
  ) => {
    const resolve = BlobResolver.resolveAll([pending], options({ modes, committed: true }))
    return Effect.flip(store === undefined ? resolve : resolve.pipe(withStore(store)))
  }

  it.effect("a size or checksum that does not match the pointer is ChecksumMismatch", () =>
    Effect.gen(function* () {
      const store = BlobStore.memory()
      const content = bytesOf(JSON.stringify({ text: "hello" }))
      const objectSize = yield* stored(store, {
        key: "p/a",
        kind: "json",
        content,
        overrides: { objectSize: content.length + 1, contentSize: content.length + 1 },
      })
      const sizeError = (yield* failure(store, overflowPending(objectSize))) as BlobStoreError
      expect(sizeError).toBeInstanceOf(BlobStoreError)
      expect(sizeError.reason).toBe("ChecksumMismatch")
      expect(sizeError.action).toBe("get")
      expect(sizeError.entityType).toBe("Doc")
      expect(sizeError.attribute).toBe("notes")
      expect(sizeError.operation).toBe("Entity.get")
      expect(sizeError.committed).toBe(true)
      expect(String(sizeError.cause)).toContain("its pointer says")

      const checksum = yield* stored(store, {
        key: "p/b",
        kind: "bytes",
        content: scanBytes,
        overrides: { checksum: { algorithm: "crc64nvme", value: new Uint8Array(8) } },
      })
      const checksumError = (yield* failure(store, binaryPending(checksum))) as BlobStoreError
      expect(checksumError.reason).toBe("ChecksumMismatch")
      expect(String(checksumError.cause)).toContain("CRC-64/NVME")
    }),
  )

  it.effect("an object that runs past its pointer's size fails as soon as it does", () =>
    Effect.gen(function* () {
      const memory = BlobStore.memory({ readChunkBytes: 8 })
      const pointer = yield* binary(memory, scanBytes)
      // A store that never stops answering: only the size bound ends the read.
      let pulled = 0
      const endless: BlobStoreService = {
        ...memory,
        get: () =>
          Stream.fromEffectRepeat(
            Effect.sync(() => {
              pulled++
              return new Uint8Array(8)
            }),
          ),
      }
      const error = (yield* failure(endless, binaryPending(pointer))) as BlobStoreError
      expect(error).toBeInstanceOf(BlobStoreError)
      expect(error.reason).toBe("ChecksumMismatch")
      expect(String(error.cause)).toContain(
        `runs past the ${scanBytes.length} bytes its pointer says`,
      )
      expect(pulled).toBe(Math.floor(scanBytes.length / 8) + 1)

      // A lazy whole read is bounded the same way.
      const [lazy] = yield* BlobResolver.resolveAll(
        [binaryPending(pointer)],
        options({ modes: BlobResolver.LAZY_MODES }),
      ).pipe(withStore(endless))
      const lazyError = yield* Effect.flip((lazy as BlobHandle).read())
      expect(lazyError.reason).toBe("ChecksumMismatch")

      // Read in chunks, the object resolves whole.
      const [eager] = yield* BlobResolver.resolveAll(
        [binaryPending(pointer)],
        options({ modes: BlobResolver.EAGER_MODES }),
      ).pipe(withStore(memory))
      expect(eager).toEqual(scanBytes)
    }),
  )

  it.effect("a compressed overflow object is verified after decompression", () =>
    Effect.gen(function* () {
      const store = BlobStore.memory()
      const content = bytesOf(JSON.stringify({ text: "compressed" }))
      const object = reversing.compress(content)
      const pointer = yield* stored(store, {
        key: "p/c",
        kind: "json",
        content,
        object,
        codec: "gzip",
      })
      const [value] = yield* BlobResolver.resolveAll([overflowPending(pointer)], options()).pipe(
        withStore(store),
        Effect.provide(Compression.layer([reversing])),
      )
      expect(value).toEqual({ text: "compressed" })

      // A content checksum taken over the object, not the content: refused.
      const wrong = yield* stored(store, {
        key: "p/d",
        kind: "json",
        content,
        object,
        codec: "gzip",
        overrides: { checksum: { algorithm: "crc64nvme", value: crc64nvme(object) } },
      })
      const mismatch = yield* failure(store, overflowPending(wrong)).pipe(
        Effect.provide(Compression.layer([reversing])),
      )
      expect((mismatch as BlobStoreError).reason).toBe("ChecksumMismatch")

      // No compressor registered for its codec: a ValidationError.
      const missing = yield* failure(store, overflowPending(pointer))
      expect(missing).toBeInstanceOf(ValidationError)
      expect(String((missing as ValidationError).cause)).toContain("gzip")

      // A decompressor that throws: a ValidationError.
      const throwing = yield* failure(store, overflowPending(pointer)).pipe(
        Effect.provide(
          Compression.layer([
            {
              ...reversing,
              decompress: () => {
                throw new Error("corrupt stream")
              },
            },
          ]),
        ),
      )
      expect(throwing).toBeInstanceOf(ValidationError)
    }),
  )

  it.effect("verified content that is not UTF-8 JSON is a ValidationError", () =>
    Effect.gen(function* () {
      const store = BlobStore.memory()
      const notUtf8 = yield* stored(store, {
        key: "p/e",
        kind: "json",
        content: new Uint8Array([0xff, 0xfe, 0xfd]),
      })
      const utf8 = yield* failure(store, overflowPending(notUtf8))
      expect(utf8).toBeInstanceOf(ValidationError)
      expect(String((utf8 as ValidationError).cause)).toContain("not valid UTF-8")
      const notJson = yield* stored(store, { key: "p/f", kind: "json", content: bytesOf("{oops") })
      const parse = yield* failure(store, overflowPending(notJson))
      expect(String((parse as ValidationError).cause)).toContain("not valid JSON")
    }),
  )

  it.effect("a missing object is NotFound; no store in context is NotProvided", () =>
    Effect.gen(function* () {
      const store = BlobStore.memory()
      const pointer = yield* json(store, { text: "gone" })
      const elsewhere = BlobStore.memory()
      const notFound = (yield* failure(elsewhere, overflowPending(pointer))) as BlobStoreError
      expect(notFound.reason).toBe("NotFound")
      expect(notFound.ref).toEqual(pointer.ref)

      const notProvided = (yield* failure(undefined, overflowPending(pointer))) as BlobStoreError
      expect(notProvided.reason).toBe("NotProvided")
      expect(String(notProvided.cause)).toContain("no BlobStore is in context")

      // A lazy value resolved without a store fails when read.
      const [lazy] = yield* BlobResolver.resolveAll(
        [binaryPending(yield* binary(store, scanBytes))],
        options(),
      )
      const handle = lazy as BlobHandle
      const readError = yield* Effect.flip(handle.read())
      expect(readError.reason).toBe("NotProvided")
      expect(readError.operation).toBe("Entity.get.read")
      const streamError = yield* Effect.flip(Stream.runCollect(handle.stream()))
      expect(streamError.reason).toBe("NotProvided")
    }),
  )
})

// ---------------------------------------------------------------------------
// Lazy binary handles
// ---------------------------------------------------------------------------

describe("BlobResolver — lazy binary handles", () => {
  const handleOf = (store: BlobStoreService, pointer: BlobPointer.BlobPointer) =>
    Effect.map(
      BlobResolver.resolveAll([binaryPending(pointer)], options()).pipe(withStore(store)),
      ([value]) => value as BlobHandle,
    )

  it.effect("a ranged read and stream return the slice, unverified", () =>
    Effect.gen(function* () {
      const store = BlobStore.memory()
      // The checksum is wrong: a whole read refuses it, a ranged one cannot tell.
      const pointer = yield* stored(store, {
        key: "p/scan",
        kind: "bytes",
        content: scanBytes,
        overrides: { checksum: { algorithm: "crc64nvme", value: new Uint8Array(8) } },
      })
      const handle = yield* handleOf(store, pointer)
      expect(yield* handle.read({ range: { offset: 1, length: 3 } })).toEqual(scanBytes.slice(1, 4))
      const chunks = yield* Stream.runCollect(handle.stream({ range: { offset: 5 } }))
      expect(Buffer.concat(chunks)).toEqual(Buffer.from(scanBytes.slice(5)))
      const whole = yield* Effect.flip(handle.read())
      expect(whole.reason).toBe("ChecksumMismatch")
      expect(whole.operation).toBe("Entity.get.read")
    }),
  )

  it.effect("a whole stream emits its bytes, then fails when they do not verify", () =>
    Effect.gen(function* () {
      const store = BlobStore.memory({ readChunkBytes: 16 })
      const pointer = yield* stored(store, {
        key: "p/scan",
        kind: "bytes",
        content: scanBytes,
        overrides: { checksum: { algorithm: "crc64nvme", value: new Uint8Array(8) } },
      })
      const handle = yield* handleOf(store, pointer)
      const emitted: Array<Uint8Array> = []
      const exit = yield* Effect.exit(
        Stream.runForEach(handle.stream(), (chunk) =>
          Effect.sync(() => {
            emitted.push(chunk)
          }),
        ),
      )
      expect(Buffer.concat(emitted)).toEqual(Buffer.from(scanBytes))
      expect(emitted.length).toBeGreaterThan(1)
      expect(Exit.isFailure(exit)).toBe(true)
      const error = yield* Effect.flip(Stream.runCollect(handle.stream()))
      expect(error.reason).toBe("ChecksumMismatch")

      // A short object: the size check fails it.
      const short = yield* stored(store, {
        key: "p/short",
        kind: "bytes",
        content: scanBytes,
        overrides: { objectSize: scanBytes.length + 10, contentSize: scanBytes.length + 10 },
      })
      const sizeError = yield* Effect.flip(
        Stream.runCollect((yield* handleOf(store, short)).stream()),
      )
      expect(String(sizeError.cause)).toContain("its pointer says")
    }),
  )

  it.effect("presigned URLs: default expiry, a chosen one, Rejected and Unsupported", () =>
    Effect.gen(function* () {
      const signing = BlobStore.memory({ presign: true })
      const pointer = yield* binary(signing, scanBytes)
      const handle = yield* handleOf(signing, pointer)
      const url = yield* handle.presignedUrl()
      expect(url).toContain(`expiresIn=${15 * 60}`)
      expect(url).toContain(`versionId=${pointer.ref.version}`)
      expect(yield* handle.presignedUrl({ expiresIn: "90 seconds" })).toContain("expiresIn=90")
      const rejected = yield* Effect.flip(handle.presignedUrl({ expiresIn: "-1 second" }))
      expect(rejected.reason).toBe("Rejected")

      const plain = BlobStore.memory()
      const unsigned = yield* handleOf(plain, yield* binary(plain, scanBytes))
      const unsupported = yield* Effect.flip(unsigned.presignedUrl())
      expect(unsupported.reason).toBe("Unsupported")
      expect(unsupported.action).toBe("presign")
    }),
  )
})

// ---------------------------------------------------------------------------
// Inline values
// ---------------------------------------------------------------------------

describe("BlobResolver — inline values", () => {
  const ctx = { entityType: "Doc", attribute: "scan", operation: "Entity.get" }

  it.effect("an inline binary handle serves its bytes and ranges, and cannot presign", () =>
    Effect.gen(function* () {
      const source = new Uint8Array(scanBytes)
      const handle = BlobResolver.inlineBlobHandle({
        bytes: source,
        contentType: "application/pdf",
        ctx,
      })
      source[0] = 0
      expect(handle.location).toBe("inline")
      expect(handle.ref).toEqual(Option.none())
      expect(handle.size).toBe(scanBytes.length)
      expect(handle.checksum.value).toEqual(crc64nvme(scanBytes))
      expect(yield* handle.read()).toEqual(scanBytes)
      expect(yield* handle.read({ range: { offset: 2, length: 2 } })).toEqual(scanBytes.slice(2, 4))
      expect(Buffer.concat(yield* Stream.runCollect(handle.stream()))).toEqual(
        Buffer.from(scanBytes),
      )
      const past = yield* Effect.flip(handle.read({ range: { offset: scanBytes.length + 1 } }))
      expect(past.reason).toBe("Rejected")
      const negative = yield* Effect.flip(handle.read({ range: { offset: -1 } }))
      expect(negative.reason).toBe("Rejected")
      const presign = yield* Effect.flip(handle.presignedUrl())
      expect(presign.reason).toBe("Unsupported")
      expect(presign.operation).toBe("Entity.get.read")
    }),
  )

  it.effect("an inline overflow value parses and decodes on read, with no I/O", () =>
    Effect.gen(function* () {
      const text = JSON.stringify({ text: "inline" })
      const value = BlobResolver.inlineOffloadedValue({
        text,
        size: 40,
        decode: (wire) => Effect.succeed({ decoded: wire }),
        ctx: { ...ctx, attribute: "notes" },
      })
      expect(value.location).toBe("inline")
      expect(value.size).toBe(40)
      expect(value.checksum.value).toEqual(crc64nvme(bytesOf(text)))
      expect(yield* value.read()).toEqual({ decoded: { text: "inline" } })
      const broken = BlobResolver.inlineOffloadedValue({
        text: "{",
        size: 1,
        decode: (wire) => Effect.succeed(wire),
        ctx,
      })
      expect(yield* Effect.flip(broken.read())).toBeInstanceOf(ValidationError)
    }),
  )
})

// ---------------------------------------------------------------------------
// Captured environment
// ---------------------------------------------------------------------------

describe("BlobResolver — environment", () => {
  it.effect("a lazy value reads with the store of the fiber that resolved it", () =>
    Effect.gen(function* () {
      const store = BlobStore.memory()
      const pointer = yield* binary(store, scanBytes)
      const [lazy] = yield* BlobResolver.resolveAll([binaryPending(pointer)], options()).pipe(
        withStore(store),
      )
      // Read later, under another store: still the resolving fiber's.
      const other = BlobStore.memory()
      const bytes = yield* (lazy as BlobHandle)
        .read()
        .pipe(Effect.provide(Layer.succeed(BlobStore, other)))
      expect(bytes).toEqual(scanBytes)
      expect(other.inspect().calls.get).toBe(0)
    }),
  )
})
