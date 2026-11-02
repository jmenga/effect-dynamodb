/**
 * @internal The read side of offloaded values per member (#179, design §8):
 * the read modes a decode runs under, and phase one of the two-phase decode —
 * the unpack that turns each pointer a row holds into a placeholder, the
 * batched resolution of those placeholders (`BlobResolver`), and the handle
 * schemas a lazily read field decodes through.
 *
 * - **Modes.** A read's effective modes ({@link Modes}: overflow / binary,
 *   each `"eager"` or `"lazy"`) are set per builder (`.offloaded(m)`, parsed
 *   by {@link parseModes}, which throws `[EDD-9117]` for a mode the library
 *   cannot honour) and reach the decoders through {@link CurrentReadModes},
 *   which every operation of an offloading member provides. Default: overflow
 *   eager, binary lazy.
 * - **Load** ({@link loadRows}): for a batch of unmarshalled, stored-name rows
 *   — a page, a batch response, one item — every packed or dispatch-eligible
 *   attribute is read by its stored form, a `B` json pointer becoming a
 *   placeholder; every attribute whose encoded side is bytes (`External` or
 *   not, §4.7) has its `~edbp:` text read as a bytes pointer; in lazy mode an
 *   offloaded value stored inline becomes an inline handle; then every
 *   placeholder of the batch resolves together. A pointer on an attribute the
 *   member no longer offloads (§4.7, switching off) resolves eagerly through
 *   the ambient store, a store failure being the `cause` of a
 *   `ValidationError`, so the member's error types stay honest. Loaded rows
 *   are remembered ({@link isPrepared}), so a decoder handed a row a query
 *   prefetched does not load it again.
 * - **Schemas** ({@link lazyReadSchema}): a read schema with each lazily read
 *   field accepting its handle (`OffloadedValue` / `BlobHandle`).
 *
 * Not part of the public API.
 */

import type { BlobStoreError } from "@effect-dynamodb/schema/Errors.js"
import { ValidationError } from "@effect-dynamodb/schema/Errors.js"
import { type BlobPointer, isBlobPointer } from "@effect-dynamodb/schema/internal/BlobPointer.js"
import { optionalField } from "@effect-dynamodb/schema/internal/EntitySchemas.js"
import { ownValue, setOwn } from "@effect-dynamodb/schema/internal/OwnNames.js"
import {
  isBase64PackedText,
  parseBinaryPointerText,
  unpackStoredSync,
} from "@effect-dynamodb/schema/internal/PackedCodec.js"
import { Context, Effect, Schema, type Semaphore } from "effect"
import { toAttributeValue } from "../Marshaller.js"
import {
  DEFAULT_MODES,
  EAGER_MODES,
  inlineBlobHandle,
  inlineOffloadedValue,
  LAZY_MODES,
  type Modes,
  makePendingBlob,
  type OffloadKind,
  type PendingBlob,
  resolveAll,
} from "./BlobResolver.js"
import { attributeBytes, utf8Bytes } from "./ItemSize.js"
import { isBlobHandle, isOffloadedValue } from "./OffloadValues.js"
import { registryOf, toBytesSync } from "./Packed.js"

export { DEFAULT_MODES, EAGER_MODES, LAZY_MODES, type Modes }

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

/**
 * The read modes the decoders of the running operation use. Every operation
 * of an offloading member provides its own (the builder's, or the defaults),
 * so an operation never inherits another's.
 */
export const CurrentReadModes: Context.Reference<Modes> = Context.Reference<Modes>(
  "effect-dynamodb/Offload/CurrentReadModes",
  { defaultValue: () => DEFAULT_MODES },
)

/** The read modes in scope. */
export const currentModes: Effect.Effect<Modes> = Effect.withFiber((fiber) =>
  Effect.succeed(fiber.getRef(CurrentReadModes)),
)

/** Run `effect` with `modes` as its read modes. */
export const withModes = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  modes: Modes,
): Effect.Effect<A, E, R> => Effect.provideService(effect, CurrentReadModes, modes)

const MODE_HINT =
  'An offload mode is "eager", "lazy", or { overflow?: "eager" | "lazy", binary?: "eager" | "lazy" }.'

/** The `[EDD-9117]` error of an offload mode the library cannot honour. */
export const modeError = (message: string): Error => new Error(`[EDD-9117] ${message}`)

const isMode = (u: unknown): u is "eager" | "lazy" => u === "eager" || u === "lazy"

const describe = (u: unknown): string => {
  try {
    return typeof u === "string" ? JSON.stringify(u) : (JSON.stringify(u) ?? String(u))
  } catch {
    return String(u)
  }
}

/**
 * Resolve `.offloaded(mode)`'s argument over `base`: a string sets both
 * kinds, an object overrides the kinds it names. Throws `[EDD-9117]` for an
 * unknown mode string, key or value (reachable from untyped code only).
 */
export const parseModes = (mode: unknown, base: Modes, where: string): Modes => {
  if (isMode(mode)) return mode === "eager" ? EAGER_MODES : LAZY_MODES
  if (typeof mode === "object" && mode !== null && !Array.isArray(mode)) {
    const record = mode as Record<string, unknown>
    for (const key of Object.keys(record)) {
      if (key !== "overflow" && key !== "binary") {
        throw modeError(`${where}: unknown offload mode key "${key}". ${MODE_HINT}`)
      }
      const value = record[key]
      if (value !== undefined && !isMode(value)) {
        throw modeError(`${where}: unknown ${key} mode ${describe(value)}. ${MODE_HINT}`)
      }
    }
    const overflow = (record.overflow as Modes["overflow"] | undefined) ?? base.overflow
    const binary = (record.binary as Modes["binary"] | undefined) ?? base.binary
    if (overflow === base.overflow && binary === base.binary) return base
    return { overflow, binary }
  }
  throw modeError(`${where}: unknown offload mode ${describe(mode)}. ${MODE_HINT}`)
}

/**
 * {@link parseModes} for an operation that takes `{ offloaded }` as an option
 * (an Effect, which fails rather than throws): `undefined` gives `base`.
 */
export const parseModesOption = (
  mode: unknown,
  base: Modes,
  ctx: { readonly entityType: string; readonly operation: string },
): Modes | ValidationError => {
  if (mode === undefined) return base
  try {
    return parseModes(mode, base, ctx.operation)
  } catch (cause) {
    return new ValidationError({ entityType: ctx.entityType, operation: ctx.operation, cause })
  }
}

/** The `[EDD-9117]` refusal of `.offloaded()` after `.filterBy()` (design §8.5). */
export const offloadedAfterFilterBy = (where: string): Error =>
  modeError(
    `${where}: .offloaded() after .filterBy() is not supported — the predicate was typed on ` +
      "the item before .offloaded() re-typed it, so it would be handed values of another " +
      "type. Call .offloaded() first, then .filterBy().",
  )

// ---------------------------------------------------------------------------
// The member's read plan
// ---------------------------------------------------------------------------

/** How one member's stored rows are read. */
export interface ReadPlan {
  readonly entityType: string
  /** Stored attributes read by their packed stored form (packed ∪ dispatch-eligible). */
  readonly dispatch: ReadonlyArray<string>
  /**
   * Stored attributes whose encoded side is bytes, `External` or not: an `S`
   * value there that starts with `~edbp:` is a bytes pointer (§4.7).
   */
  readonly binary: ReadonlyArray<string>
  /** The member's offloaded attributes: stored name → kind. */
  readonly offloaded: Readonly<Record<string, OffloadKind>>
  /** Stored name → domain field name (the attributes above). */
  readonly fieldOf: Readonly<Record<string, string>>
  /** An `External` attribute's content type (inline handles carry it). */
  readonly contentTypeOf: Readonly<Record<string, string>>
  /**
   * Decode a lazily read overflow value's wire form through its field's
   * schema — when `read()` is called (`operation` is the read's).
   */
  readonly decodeField: (
    field: string,
    wire: unknown,
    operation: string,
  ) => Effect.Effect<unknown, ValidationError>
}

/** True iff a plan has nothing to read by stored form: a native row is then final. */
export const isEmptyPlan = (plan: ReadPlan): boolean =>
  plan.dispatch.length === 0 && plan.binary.length === 0

/** The attributes a read of `plan` may rewrite (a projection naming none runs no hook). */
export const readAttributes = (plan: ReadPlan): ReadonlyArray<string> => [
  ...new Set([...plan.dispatch, ...plan.binary]),
]

/** What a load is for. */
export interface LoadOptions {
  /** The operation errors name; a lazy value's reads name `<operation>.read`. */
  readonly operation: string
  readonly modes: Modes
  /**
   * A raw projection or a raw-mode read: values stay their JSON wire form (a
   * lazy overflow value's `read()` returns it, not the field's domain value).
   */
  readonly raw?: boolean | undefined
  /** The rows are a committed write's result (a store failure says so, §6.13). */
  readonly committed?: boolean | undefined
  /** Unmarshalled stream images: a `B` value may be base64 text. */
  readonly image?: boolean | undefined
  /**
   * No store I/O (an error payload, §6.13): offloaded fields read lazily
   * whatever `modes` say, and a pointer on an attribute the member no longer
   * offloads (which would need a fetch) fails the load.
   */
  readonly noFetch?: boolean | undefined
  /**
   * Store-read permits shared with the operation's other loads running at the
   * same time (`BlobResolver.ResolveOptions.permits`): `GeoIndex.nearby`'s
   * parallel cell queries share one pool of the store's `readConcurrency`.
   */
  readonly permits?: Semaphore.Semaphore | undefined
}

// ---------------------------------------------------------------------------
// Prepared rows
// ---------------------------------------------------------------------------

const prepared = new WeakSet<object>()

/** True iff `row` was already loaded (by a query's page prefetch). */
export const isPrepared = (row: object): boolean => prepared.has(row)

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

const encoder = new TextEncoder()

/** The stored bytes of a value as DynamoDB counts them. */
const storedBytes = (stored: unknown): number => {
  if (typeof stored === "string") return utf8Bytes(stored)
  if (stored instanceof Uint8Array) return stored.length
  try {
    return attributeBytes(toAttributeValue(stored))
  } catch {
    return encoder.encode(JSON.stringify(stored) ?? "").length
  }
}

const OCTET_STREAM = "application/octet-stream"

/**
 * A pointer on an attribute the member does not offload (§4.7), in an error
 * payload (`noFetch`, §6.13): only a fetch resolves it, and a payload makes
 * no store I/O.
 */
const unfetchedPointer = (
  ctx: { readonly entityType: string; readonly operation: string },
  attribute: string,
  pointer: BlobPointer,
): ValidationError =>
  new ValidationError({
    entityType: ctx.entityType,
    operation: ctx.operation,
    cause: new Error(
      `Attribute "${attribute}": the stored value is a blob pointer (object ` +
        `"${pointer.ref.key}", version "${pointer.ref.version}") on an attribute this ` +
        "member does not offload, which only a fetch from the blob store resolves. The " +
        "item rides on an error, and an error's item is decoded without store I/O — read " +
        "the item to resolve it.",
    ),
  })

interface Slot {
  readonly row: Record<string, unknown>
  readonly attribute: string
}

/**
 * Unpack and resolve, in place, every row of `rows` per `plan` (see the
 * module header): afterwards each offloaded attribute holds its value — the
 * JSON wire form (overflow), the bytes (binary) — or, in lazy mode, its
 * handle, and every packed attribute its JSON wire form. Rows already loaded
 * are skipped. A row without a stored-form value costs one `typeof` per
 * attribute of the plan.
 */
export const loadRows = (
  plan: ReadPlan,
  rows: ReadonlyArray<Record<string, unknown>>,
  options: LoadOptions,
): Effect.Effect<void, ValidationError | BlobStoreError> => {
  if (isEmptyPlan(plan) || rows.length === 0) return Effect.void
  return Effect.withFiber((fiber) => {
    const ctx = { entityType: plan.entityType, operation: options.operation }
    const modes = options.noFetch === true ? LAZY_MODES : options.modes
    const lazyOverflow = modes.overflow === "lazy"
    const lazyBinary = modes.binary === "lazy"
    let registry: ReturnType<typeof registryOf> | undefined
    const pendings: Array<PendingBlob> = []
    const slots: Array<Slot> = []
    const legacy: Array<PendingBlob> = []
    const legacySlots: Array<Slot> = []
    const readRaw = options.raw === true
    const decode = (field: string, wire: unknown) =>
      readRaw ? Effect.succeed(wire) : plan.decodeField(field, wire, `${options.operation}.read`)

    for (const row of rows) {
      if (prepared.has(row)) continue
      // Packed and dispatch-eligible attributes, by stored form.
      for (const attribute of plan.dispatch) {
        let stored = ownValue(row, attribute)
        if (stored === undefined || stored === null) continue
        const offloaded = plan.offloaded[attribute] === "overflow"
        if (options.image === true && typeof stored === "string" && isBase64PackedText(stored)) {
          const bytes = toBytesSync(stored, ctx, attribute)
          if (bytes instanceof ValidationError) return Effect.fail(bytes)
          stored = bytes
        }
        let wire: unknown = stored
        if (typeof stored === "string" || stored instanceof Uint8Array) {
          registry ??= registryOf(fiber.context as Context.Context<never>)
          wire = unpackStoredSync(stored, registry, ctx, attribute)
          if (wire instanceof ValidationError) return Effect.fail(wire)
          if (isBlobPointer(wire)) {
            const pending = makePendingBlob({
              pointer: wire,
              attribute,
              field: plan.fieldOf[attribute] ?? attribute,
              kind: "overflow",
            })
            setOwn(row, attribute, pending)
            if (offloaded) {
              pendings.push(pending)
              slots.push({ row, attribute })
            } else {
              if (options.noFetch === true) {
                return Effect.fail(unfetchedPointer(ctx, attribute, wire))
              }
              legacy.push(pending)
              legacySlots.push({ row, attribute })
            }
            continue
          }
        }
        setOwn(
          row,
          attribute,
          offloaded && lazyOverflow
            ? inlineOffloadedValue({
                text: typeof stored === "string" ? stored : (JSON.stringify(wire) ?? "null"),
                size: storedBytes(stored),
                decode: (value) => decode(plan.fieldOf[attribute] ?? attribute, value),
                ctx: { entityType: plan.entityType, attribute, operation: options.operation },
              })
            : wire,
        )
      }
      // Bytes attributes: a `~edbp:` text is a bytes pointer.
      for (const attribute of plan.binary) {
        let stored = ownValue(row, attribute)
        if (stored === undefined || stored === null) continue
        const offloaded = plan.offloaded[attribute] === "binary"
        if (typeof stored === "string") {
          const pointer = parseBinaryPointerText(stored, ctx, attribute)
          if (pointer instanceof ValidationError) return Effect.fail(pointer)
          if (pointer !== undefined) {
            const pending = makePendingBlob({
              pointer,
              attribute,
              field: plan.fieldOf[attribute] ?? attribute,
              kind: "binary",
            })
            setOwn(row, attribute, pending)
            if (offloaded) {
              pendings.push(pending)
              slots.push({ row, attribute })
            } else {
              if (options.noFetch === true) {
                return Effect.fail(unfetchedPointer(ctx, attribute, pointer))
              }
              legacy.push(pending)
              legacySlots.push({ row, attribute })
            }
            continue
          }
          // In an unmarshalled stream image a `B` value may be base64 text.
          if (options.image !== true) continue
          const bytes = toBytesSync(stored, ctx, attribute)
          if (bytes instanceof ValidationError) return Effect.fail(bytes)
          stored = bytes
          setOwn(row, attribute, bytes)
        }
        if (offloaded && lazyBinary && stored instanceof Uint8Array) {
          setOwn(
            row,
            attribute,
            inlineBlobHandle({
              bytes: stored,
              contentType: plan.contentTypeOf[attribute] ?? OCTET_STREAM,
              ctx: { entityType: plan.entityType, attribute, operation: options.operation },
            }),
          )
        }
      }
      prepared.add(row)
    }

    const assign = (targets: ReadonlyArray<Slot>, values: ReadonlyArray<unknown>) => {
      for (let i = 0; i < targets.length; i++) {
        const { row, attribute } = targets[i]!
        setOwn(row, attribute, values[i])
      }
    }
    const own =
      pendings.length === 0
        ? Effect.void
        : Effect.map(
            resolveAll(pendings, {
              entityType: plan.entityType,
              operation: options.operation,
              modes,
              committed: options.committed,
              decode,
              permits: options.permits,
            }),
            (values) => assign(slots, values),
          )
    if (legacy.length === 0) return own
    // A pointer on an attribute the member no longer offloads (§4.7): eager,
    // through the ambient store; a store failure is a ValidationError's cause.
    const previous = Effect.map(
      resolveAll(legacy, {
        entityType: plan.entityType,
        operation: options.operation,
        modes: EAGER_MODES,
        committed: options.committed,
        permits: options.permits,
      }).pipe(
        Effect.catchTag("BlobStoreError", (cause) =>
          Effect.fail(
            new ValidationError({
              entityType: plan.entityType,
              operation: options.operation,
              cause,
            }),
          ),
        ),
      ),
      (values) => assign(legacySlots, values),
    )
    return Effect.andThen(own, previous)
  })
}

// ---------------------------------------------------------------------------
// Read schemas
// ---------------------------------------------------------------------------

const OffloadedValueSchema = Schema.declare(isOffloadedValue, {
  identifier: "OffloadedValue",
})
const BlobHandleSchema = Schema.declare(isBlobHandle, { identifier: "BlobHandle" })

type Fields = Readonly<Record<string, Schema.Top>>

const fieldsOf = (schema: Schema.Top): Fields | undefined =>
  (schema as unknown as { readonly fields?: Fields }).fields

const cache = new WeakMap<object, Map<string, Schema.Codec<any>>>()

/**
 * `base` (a read schema: a `Schema.Struct` keyed by domain names) with each
 * field of `lazy` accepting its handle — a lazily read field holds one
 * whenever it holds a value (`null` / `undefined` decode as before). `base`
 * itself when no field is lazy.
 */
export const lazyReadSchema = (
  base: Schema.Codec<any>,
  lazy: ReadonlyArray<readonly [field: string, kind: OffloadKind]>,
): Schema.Codec<any> => {
  if (lazy.length === 0) return base
  const fields = fieldsOf(base)
  if (fields === undefined) return base
  const key = lazy.map(([field, kind]) => `${kind}:${field}`).join("\u0000")
  let byKey = cache.get(base)
  if (byKey === undefined) {
    byKey = new Map()
    cache.set(base, byKey)
  }
  const hit = byKey.get(key)
  if (hit !== undefined) return hit
  const next: Record<string, Schema.Top> = { ...fields }
  for (const [field, kind] of lazy) {
    const schema = fields[field]
    if (schema === undefined) continue
    const handle = kind === "overflow" ? OffloadedValueSchema : BlobHandleSchema
    const optional = optionalField(schema)
    next[field] =
      optional === undefined
        ? Schema.Union([handle, schema as Schema.Codec<any>])
        : optional.rewrap(Schema.Union([handle, optional.inner as Schema.Codec<any>]))
  }
  const built = Schema.Struct(next as Schema.Struct.Fields) as unknown as Schema.Codec<any>
  byKey.set(key, built)
  return built
}

/** The fields of `byKind` read lazily under `modes`. */
export const lazyFields = (
  byKind: { readonly overflow: ReadonlyArray<string>; readonly binary: ReadonlyArray<string> },
  modes: Modes,
): ReadonlyArray<readonly [string, OffloadKind]> => [
  ...(modes.overflow === "lazy"
    ? byKind.overflow.map((field) => [field, "overflow"] as const)
    : []),
  ...(modes.binary === "lazy" ? byKind.binary.map((field) => [field, "binary"] as const) : []),
]
