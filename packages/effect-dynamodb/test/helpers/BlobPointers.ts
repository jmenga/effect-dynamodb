/**
 * Sample blob pointers (#179, Packed layout `010`) for the read-path tests:
 * an overflow field's pointer as stored (`B` bytes) and a binary field's as
 * stored (`~edbp:` base64url `S` text), plus the assertion that a read path
 * could not resolve one on an attribute its member does not offload.
 */

import { BlobStoreError, ValidationError } from "@effect-dynamodb/schema/Errors.js"
import * as BlobPointer from "@effect-dynamodb/schema/internal/BlobPointer.js"
import { crc64nvme } from "@effect-dynamodb/schema/internal/Crc64Nvme.js"
import { Effect, Option } from "effect"
import { expect } from "vitest"
import type { BlobStoreService } from "../../src/BlobStore.js"

const pointer = (fields: BlobPointer.BlobPointerFields): BlobPointer.BlobPointer => {
  const made = BlobPointer.make(fields)
  if (typeof made === "string") throw new Error(made)
  return made
}

/** An overflow field's pointer (kind json, zstd object). */
export const jsonPointer: BlobPointer.BlobPointer = pointer({
  kind: "json",
  codec: "zstd",
  ref: { key: "prod/0f1e2d3c4b5a69788796a5b4c3d2e1f0/aa/bb", version: "Vd1pQx7.version" },
  objectSize: 40_000,
  contentSize: 512_000,
  checksum: { algorithm: "crc64nvme", value: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) },
  contentType: Option.none(),
})

/** A binary field's pointer (kind bytes). */
export const bytesPointer: BlobPointer.BlobPointer = pointer({
  kind: "bytes",
  codec: "none",
  ref: { key: "prod/0f1e2d3c4b5a69788796a5b4c3d2e1f0/cc/dd", version: "Xk2bytes.version" },
  objectSize: 12_000_000,
  contentSize: 12_000_000,
  checksum: { algorithm: "crc64nvme", value: new Uint8Array([8, 7, 6, 5, 4, 3, 2, 1]) },
  contentType: Option.some("application/pdf"),
})

/** The `B` value an overflow field holds when offloaded. */
export const jsonPointerBytes = (): Uint8Array => BlobPointer.encode(jsonPointer)

/** The `S` value a binary field holds when offloaded. */
export const bytesPointerText: string = BlobPointer.encodeText(bytesPointer)

/**
 * `error` is the `ValidationError` a read path raises on a pointer stored on
 * an attribute its member does not offload (design §4.7, switching offload
 * off) when the pointer cannot be resolved — here because no blob store is in
 * context: its `cause` is the `BlobStoreError` naming the attribute and the
 * object version, and it never carries the pointer as a value.
 */
export const expectPointerStoreFailure = (
  error: unknown,
  attribute: string,
  expected: {
    readonly entityType?: string
    readonly operation?: string
    readonly pointer?: BlobPointer.BlobPointer
  } = {},
): void => {
  expect(error).toBeInstanceOf(ValidationError)
  const validation = error as ValidationError
  if (expected.entityType !== undefined) expect(validation.entityType).toBe(expected.entityType)
  if (expected.operation !== undefined) expect(validation.operation).toBe(expected.operation)
  const ref = (expected.pointer ?? jsonPointer).ref
  expect(validation.cause).toBeInstanceOf(BlobStoreError)
  const cause = validation.cause as BlobStoreError
  expect(cause).toMatchObject({ attribute, reason: "NotProvided", ref })
  expect(cause.message).toContain(ref.key)
  expect(cause.message).toContain(ref.version)
}

/**
 * `error` is the `ValidationError` a synchronous read (which does no I/O)
 * raises on a pointer — the codec's "cannot resolve" refusal: it names the
 * attribute and the object version, never carries the pointer as a value,
 * and says what resolves it (`hint`, when given).
 */
export const expectUnresolvedPointer = (
  error: unknown,
  attribute: string,
  expected: {
    readonly entityType?: string
    readonly operation?: string
    readonly hint?: ReadonlyArray<string>
  } = {},
): void => {
  expect(error).toBeInstanceOf(ValidationError)
  const validation = error as ValidationError
  if (expected.entityType !== undefined) expect(validation.entityType).toBe(expected.entityType)
  if (expected.operation !== undefined) expect(validation.operation).toBe(expected.operation)
  const message = (validation.cause as Error).message
  expect(message).toContain(`Packed attribute "${attribute}"`)
  expect(message).toContain("blob pointer")
  expect(message).toContain(jsonPointer.ref.key)
  expect(message).toContain(jsonPointer.ref.version)
  expect(message).toContain("cannot resolve")
  for (const text of expected.hint ?? []) expect(message).toContain(text)
}

/**
 * Put `object` (default: `content`) into `store` and return the pointer
 * naming it: `content` is what the pointer's checksum and content size
 * describe (the object, unless it is compressed with `codec`); `overrides`
 * corrupt the pointer.
 */
export const storeObject = (
  store: BlobStoreService,
  options: {
    readonly key: string
    readonly kind: BlobPointer.BlobPointerKind
    readonly content: Uint8Array
    readonly object?: Uint8Array | undefined
    readonly codec?: "none" | "gzip" | "brotli" | "zstd" | undefined
    readonly contentType?: string | undefined
    readonly overrides?: Partial<BlobPointer.BlobPointerFields> | undefined
  },
): Effect.Effect<BlobPointer.BlobPointer> =>
  Effect.gen(function* () {
    const object = options.object ?? options.content
    const { ref } = yield* Effect.orDie(
      store.put({
        key: options.key,
        body: object,
        contentLength: object.length,
        checksum: Effect.succeed({ algorithm: "crc64nvme", value: crc64nvme(object) }),
        contentType: options.contentType ?? "application/octet-stream",
        metadata: {},
      }),
    )
    const made = BlobPointer.make({
      kind: options.kind,
      codec: options.codec ?? "none",
      ref,
      objectSize: object.length,
      contentSize: options.content.length,
      checksum: { algorithm: "crc64nvme", value: crc64nvme(options.content) },
      contentType: Option.fromNullishOr(options.contentType),
      ...options.overrides,
    })
    if (typeof made === "string") return yield* Effect.die(new Error(made))
    return made
  })
