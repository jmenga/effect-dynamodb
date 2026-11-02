/**
 * @internal The lazy forms of offloaded values (#179, design §3.7):
 * {@link OffloadedValue} (an overflow field read lazily) and
 * {@link BlobHandle} (a binary field read lazily), their type ids, guards and
 * constructors. `Offload.ts` re-exports the public parts; the constructors are
 * the read path's (the resolver builds handles that capture the store and
 * compressor registry of the fiber that decoded them).
 *
 * Not part of the public API.
 */

import type { BlobStoreError, ValidationError } from "@effect-dynamodb/schema/Errors.js"
import type { BlobChecksum, BlobRef } from "@effect-dynamodb/schema/internal/BlobPointer.js"
import {
  type Duration,
  type Effect,
  Equal,
  Hash,
  Inspectable,
  Option,
  Pipeable,
  type Stream,
} from "effect"
import type { BlobStoreService, ByteRange } from "./BlobStoreContract.js"

export const OffloadedValueTypeId: unique symbol = Symbol.for("effect-dynamodb/OffloadedValue")
export type OffloadedValueTypeId = typeof OffloadedValueTypeId

export const BlobHandleTypeId: unique symbol = Symbol.for("effect-dynamodb/BlobHandle")
export type BlobHandleTypeId = typeof BlobHandleTypeId

/** Where a lazily read value is: in the item (`inline`) or in the blob store (`external`). */
export type OffloadLocation = "inline" | "external"

/**
 * An overflow field read lazily. An inline value is already resolved, so
 * `read` does no I/O; an external one fetches, verifies, decompresses and
 * schema-decodes on `read`.
 */
export interface OffloadedValue<A> extends Pipeable.Pipeable, Inspectable.Inspectable {
  readonly [OffloadedValueTypeId]: OffloadedValueTypeId
  readonly location: OffloadLocation
  /** The object version (external only). */
  readonly ref: Option.Option<BlobRef>
  /** Stored bytes: the attribute's (inline) or the object's (external). */
  readonly size: number
  /** The content checksum (design §5). */
  readonly checksum: BlobChecksum
  readonly read: () => Effect.Effect<A, BlobStoreError | ValidationError>
}

/**
 * A binary field read lazily. `inline`: a native value stored before the
 * field was `External`. Equal by location and ref (external), or by content
 * checksum and size (inline): `Equal.equals(a, b)` is a cheap "same stored
 * value" test.
 */
export interface BlobHandle extends Pipeable.Pipeable, Inspectable.Inspectable, Equal.Equal {
  readonly [BlobHandleTypeId]: BlobHandleTypeId
  readonly location: OffloadLocation
  readonly ref: Option.Option<BlobRef>
  readonly size: number
  readonly contentType: string
  readonly checksum: BlobChecksum
  readonly read: (options?: {
    readonly range?: ByteRange | undefined
  }) => Effect.Effect<Uint8Array, BlobStoreError>
  readonly stream: (options?: {
    readonly range?: ByteRange | undefined
  }) => Stream.Stream<Uint8Array, BlobStoreError>
  /**
   * A presigned GET URL (default expiry 15 minutes). Fails with
   * `BlobStoreError { reason: "Unsupported" }` on an inline handle or a store
   * without the `presign` capability.
   */
  readonly presignedUrl: (options?: {
    readonly expiresIn?: Duration.Input | undefined
  }) => Effect.Effect<string, BlobStoreError>
}

/** True iff `u` is an {@link OffloadedValue}. */
export const isOffloadedValue = (u: unknown): u is OffloadedValue<unknown> =>
  typeof u === "object" && u !== null && OffloadedValueTypeId in u

/** True iff `u` is a {@link BlobHandle}. */
export const isBlobHandle = (u: unknown): u is BlobHandle =>
  typeof u === "object" && u !== null && BlobHandleTypeId in u

const hexOf = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, i) => byte === b[i])

const copyChecksum = (checksum: BlobChecksum): BlobChecksum =>
  Object.freeze({ algorithm: checksum.algorithm, value: new Uint8Array(checksum.value) })

const copyRef = (ref: Option.Option<BlobRef>): Option.Option<BlobRef> =>
  Option.map(ref, (r) => Object.freeze({ key: r.key, version: r.version }))

const checkLocation = (what: string, location: OffloadLocation, ref: Option.Option<BlobRef>) => {
  if (location !== "inline" && location !== "external") {
    throw new Error(`${what}: location must be "inline" or "external"`)
  }
  if ((location === "external") !== Option.isSome(ref)) {
    throw new Error(`${what}: an external value has a ref, an inline one none`)
  }
}

const describe = (self: {
  readonly location: OffloadLocation
  readonly ref: Option.Option<BlobRef>
  readonly size: number
  readonly checksum: BlobChecksum
}) => ({
  location: self.location,
  ref: Option.match(self.ref, {
    onNone: () => undefined,
    onSome: (r) => ({ key: r.key, version: r.version }),
  }),
  size: self.size,
  checksum: { algorithm: self.checksum.algorithm, value: hexOf(self.checksum.value) },
})

// ---------------------------------------------------------------------------
// OffloadedValue
// ---------------------------------------------------------------------------

/** The fields of an {@link OffloadedValue}. */
export type OffloadedValueFields<A> = Omit<
  OffloadedValue<A>,
  OffloadedValueTypeId | keyof Pipeable.Pipeable | keyof Inspectable.Inspectable
>

const OffloadedValueProto = Object.assign(
  Object.create(Inspectable.BaseProto) as Inspectable.Inspectable,
  {
    [OffloadedValueTypeId]: OffloadedValueTypeId as OffloadedValueTypeId,
    pipe(this: OffloadedValue<unknown>) {
      return Pipeable.pipeArguments(this, arguments)
    },
    toJSON(this: OffloadedValue<unknown>) {
      return { _id: "OffloadedValue", ...describe(this) }
    },
  },
)

/** An {@link OffloadedValue} from its fields (the read path builds them). */
export const makeOffloadedValue = <A>(fields: OffloadedValueFields<A>): OffloadedValue<A> => {
  checkLocation("OffloadedValue", fields.location, fields.ref)
  return Object.freeze(
    Object.assign(Object.create(OffloadedValueProto) as OffloadedValue<A>, {
      location: fields.location,
      ref: copyRef(fields.ref),
      size: fields.size,
      checksum: copyChecksum(fields.checksum),
      read: fields.read,
    }),
  )
}

// ---------------------------------------------------------------------------
// BlobHandle
// ---------------------------------------------------------------------------

/** The fields of a {@link BlobHandle}. */
export type BlobHandleFields = Omit<
  BlobHandle,
  | BlobHandleTypeId
  | keyof Pipeable.Pipeable
  | keyof Inspectable.Inspectable
  | typeof Equal.symbol
  | typeof Hash.symbol
>

const BlobHandleProto = Object.assign(
  Object.create(Inspectable.BaseProto) as Inspectable.Inspectable,
  {
    [BlobHandleTypeId]: BlobHandleTypeId as BlobHandleTypeId,
    pipe(this: BlobHandle) {
      return Pipeable.pipeArguments(this, arguments)
    },
    toJSON(this: BlobHandle) {
      return { _id: "BlobHandle", ...describe(this), contentType: this.contentType }
    },
    [Equal.symbol](this: BlobHandle, that: Equal.Equal): boolean {
      if (!isBlobHandle(that) || that.location !== this.location) return false
      if (Option.isSome(this.ref) && Option.isSome(that.ref)) {
        return (
          this.ref.value.key === that.ref.value.key &&
          this.ref.value.version === that.ref.value.version
        )
      }
      return (
        this.size === that.size &&
        this.checksum.algorithm === that.checksum.algorithm &&
        sameBytes(this.checksum.value, that.checksum.value)
      )
    },
    [Hash.symbol](this: BlobHandle): number {
      return Option.match(this.ref, {
        onNone: () => Hash.string(`inline:${this.size}:${hexOf(this.checksum.value)}`),
        onSome: (r) => Hash.string(`external:${r.key}\u0000${r.version}`),
      })
    },
  },
)

/** A {@link BlobHandle} from its fields (the read path builds them). */
export const makeBlobHandle = (fields: BlobHandleFields): BlobHandle => {
  checkLocation("BlobHandle", fields.location, fields.ref)
  return Object.freeze(
    Object.assign(Object.create(BlobHandleProto) as BlobHandle, {
      location: fields.location,
      ref: copyRef(fields.ref),
      size: fields.size,
      contentType: fields.contentType,
      checksum: copyChecksum(fields.checksum),
      read: fields.read,
      stream: fields.stream,
      presignedUrl: fields.presignedUrl,
    }),
  )
}

// ---------------------------------------------------------------------------
// The store a handle reads from (a write's copy source, design §3.8)
// ---------------------------------------------------------------------------

const handleStores = new WeakMap<BlobHandle, BlobStoreService>()

/** Record the store an external handle reads from (the resolver, when it builds one). */
export const registerHandleStore = (handle: BlobHandle, store: BlobStoreService): BlobHandle => {
  handleStores.set(handle, store)
  return handle
}

/**
 * The store an external handle reads from, when the library built it with
 * one: a write given the handle copies within that store (`copy`) instead of
 * streaming its content through.
 */
export const handleStoreOf = (handle: BlobHandle): BlobStoreService | undefined =>
  handleStores.get(handle)
