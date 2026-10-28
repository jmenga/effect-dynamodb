/**
 * ZOrder — the dimensions of a Z-order sort key (#171).
 *
 * A Z-order index interleaves the bits of several model fields into one binary
 * sort key, so a query can bound any of them (`.within()`) and read a few key
 * ranges instead of a whole partition. Declare it on a secondary index's sort
 * key:
 *
 * ```ts
 * search: {
 *   name: "gsi2",
 *   pk: { field: "gsi2pk", composite: ["region"] },
 *   sk: {
 *     field: "gsi2sk",
 *     prefix: ["agencyId"],
 *     zorder: [
 *       ZOrder.int("price", { min: 0, max: 5_000_000, step: 1_000 }),
 *       ZOrder.int("bedrooms", { min: 0, max: 15 }),
 *       ZOrder.dateTime("listedAt", { from: "2024-01-01", unit: "hours", bits: 16 }),
 *     ],
 *   },
 * }
 * ```
 *
 * A declared {@link Dimension} is a spec: a field name, a kind and the options
 * that map the field's values onto levels. It knows nothing about the entity
 * it will be bound to — `Entity.make` binds it, resolving how the field is
 * stored, so one `Dimension` value can serve several entities. Declaration
 * order is interleave priority. Constructors validate eagerly and throw
 * `[EDD-9087]`.
 *
 * Pure TypeScript over `bigint` and bytes: no Node builtins, no AWS SDK. The
 * curve algebra (interleaving, range planning) is internal.
 */

import { DateTime, Inspectable, Pipeable } from "effect"

export const DimensionTypeId: unique symbol = Symbol.for("@effect-dynamodb/ZOrder/Dimension")
export type DimensionTypeId = typeof DimensionTypeId

/** The ways a field's values map onto levels. */
export type DimensionKind = "int" | "float" | "dateTime" | "literals" | "string"

/** The level width of a `dateTime` dimension. */
export type DateTimeUnit = "milliseconds" | "seconds" | "minutes" | "hours" | "days" | "weeks"

/** A literal member of a `literals` dimension. */
export type LiteralValue = string | number | boolean

/**
 * @internal A dimension's declaration as plain data — what the stored layout
 * depends on, for fingerprints and `explain`.
 */
export type DimensionSpec =
  | {
      readonly kind: "int" | "float"
      readonly field: string
      readonly min: number
      readonly max: number
      readonly step: number
      readonly bits: number
    }
  | {
      readonly kind: "dateTime"
      readonly field: string
      /** `from` as an ISO instant. */
      readonly from: string
      readonly fromMs: number
      readonly unit: DateTimeUnit
      readonly bits: number
    }
  | {
      readonly kind: "literals"
      readonly field: string
      readonly values: ReadonlyArray<LiteralValue>
      readonly bits: number
    }
  | {
      readonly kind: "string"
      readonly field: string
      readonly bytes: number
      readonly bits: number
    }

/**
 * One interleaved facet as declared: a model field name, a kind and its
 * options. `L` carries a `literals` dimension's members (`unknown` for the
 * other kinds), so any dimension is assignable to the bare `Dimension`.
 */
export interface Dimension<
  F extends string = string,
  K extends DimensionKind = DimensionKind,
  L = unknown,
> extends Pipeable.Pipeable,
    Inspectable.Inspectable {
  readonly [DimensionTypeId]: DimensionTypeId
  readonly field: F
  readonly kind: K
  /** Declared or derived bit width (the field's share of the address). */
  readonly bits: number
  /** @internal The declaration, as plain data. */
  readonly spec: DimensionSpec
  /** @internal Phantom: the literal members, for `literals` only. */
  readonly _L?: (_: never) => L
}

/**
 * A sort-key prefix composite: matched exactly, in front of the address. A
 * bare name is stored length-prefixed; `{ field, hash: n }` stores the first
 * `n` bytes (1..8) of its FNV-1a-64 hash, which keeps long values short.
 */
export type PrefixPart = string | { readonly field: string; readonly hash: number }

/** Is `u` a declared {@link Dimension}? */
export const isDimension = (u: unknown): u is Dimension =>
  typeof u === "object" && u !== null && DimensionTypeId in u

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

class DimensionImpl extends Inspectable.Class implements Dimension {
  readonly [DimensionTypeId]: DimensionTypeId = DimensionTypeId
  readonly field: string
  readonly kind: DimensionKind
  readonly bits: number

  constructor(readonly spec: DimensionSpec) {
    super()
    this.field = spec.field
    this.kind = spec.kind
    this.bits = spec.bits
  }

  pipe() {
    // eslint-disable-next-line prefer-rest-params
    return Pipeable.pipeArguments(this, arguments)
  }

  toJSON(): unknown {
    return { _id: "ZOrder.Dimension", ...this.spec }
  }
}

const invalid = (field: unknown, kind: DimensionKind, why: string): never => {
  throw new Error(`[EDD-9087] ZOrder.${kind}(${JSON.stringify(field)}): ${why}`)
}

const checkField = (field: unknown, kind: DimensionKind): void => {
  if (typeof field !== "string" || field.length === 0) {
    invalid(field, kind, "the first argument names the model field, a non-empty string.")
  }
}

/** Bits needed to number `n` levels: at least 1. */
const bitsForLevels = (levels: bigint): number => {
  let bits = 0
  for (let top = levels - 1n; top > 0n; top >>= 1n) bits++
  return Math.max(1, bits)
}

const levelCount = (min: number, max: number, step: number): bigint =>
  BigInt(Math.floor((max - min) / step)) + 1n

const MAX_FLOAT_LEVELS = 2n ** 53n

const UNITS: ReadonlyArray<DateTimeUnit> = [
  "milliseconds",
  "seconds",
  "minutes",
  "hours",
  "days",
  "weeks",
]

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

/**
 * An integer dimension: `min`..`max` in steps of `step` (default 1). Values
 * below `min` or above `max` share the edge levels, and the exact bound check
 * on each read keeps results exact. A `bigint` field is quantized in `bigint`
 * arithmetic.
 */
export const int = <const F extends string>(
  field: F,
  options: { readonly min: number; readonly max: number; readonly step?: number | undefined },
): Dimension<F, "int"> => {
  checkField(field, "int")
  const { min, max } = options ?? ({} as typeof options)
  const step = options?.step ?? 1
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || !Number.isSafeInteger(step)) {
    return invalid(field, "int", "min, max and step must be safe integers.")
  }
  if (min >= max) return invalid(field, "int", `min (${min}) must be less than max (${max}).`)
  if (step < 1 || step > max - min) {
    return invalid(field, "int", `step (${step}) must be between 1 and max - min (${max - min}).`)
  }
  const bits = bitsForLevels(levelCount(min, max, step))
  return new DimensionImpl({ kind: "int", field, min, max, step, bits }) as Dimension<F, "int">
}

/**
 * A floating-point dimension: `min`..`max` in steps of `step`. Like `int`,
 * out-of-range values share the edge levels.
 */
export const float = <const F extends string>(
  field: F,
  options: { readonly min: number; readonly max: number; readonly step: number },
): Dimension<F, "float"> => {
  checkField(field, "float")
  const { min, max, step } = options ?? ({} as typeof options)
  if (![min, max, step].every((n) => typeof n === "number" && Number.isFinite(n))) {
    return invalid(field, "float", "min, max and step must be finite numbers.")
  }
  if (min >= max) return invalid(field, "float", `min (${min}) must be less than max (${max}).`)
  if (!(step > 0) || step > max - min) {
    return invalid(field, "float", `step (${step}) must be above 0 and at most max - min.`)
  }
  const levels = levelCount(min, max, step)
  if (levels > MAX_FLOAT_LEVELS) {
    return invalid(field, "float", `(max - min) / step gives ${levels} levels; at most 2^53.`)
  }
  const bits = bitsForLevels(levels)
  return new DimensionImpl({ kind: "float", field, min, max, step, bits }) as Dimension<F, "float">
}

/**
 * A date-time dimension: `2^bits` levels of one `unit` each, starting at
 * `from`. Instants before `from` or past the last level share the edge levels.
 * The field must have a known storage format (a `DynamoModel` date schema or
 * an Effect date schema), so its order is known.
 */
export const dateTime = <const F extends string>(
  field: F,
  options: {
    readonly from: string | Date | DateTime.DateTime
    readonly unit: DateTimeUnit
    readonly bits: number
  },
): Dimension<F, "dateTime"> => {
  checkField(field, "dateTime")
  const { from, unit, bits } = options ?? ({} as typeof options)
  const fromMs = (() => {
    if (DateTime.isDateTime(from)) return DateTime.toEpochMillis(from)
    if (from instanceof Date) return from.getTime()
    if (typeof from === "string") return Date.parse(from)
    return Number.NaN
  })()
  if (!Number.isFinite(fromMs)) {
    return invalid(field, "dateTime", `from (${String(from)}) is not a date.`)
  }
  if (!UNITS.includes(unit)) {
    return invalid(field, "dateTime", `unit must be one of ${UNITS.join(", ")}.`)
  }
  if (!Number.isInteger(bits) || bits < 1 || bits > 53) {
    return invalid(field, "dateTime", `bits (${bits}) must be an integer from 1 to 53.`)
  }
  return new DimensionImpl({
    kind: "dateTime",
    field,
    from: new Date(fromMs).toISOString(),
    fromMs,
    unit,
    bits,
  }) as Dimension<F, "dateTime">
}

/**
 * A dimension over a fixed list of values. Levels follow the declared order,
 * so ranges (`{ gte: "b" }`) mean "at or after `b` in this list". `bits`
 * reserves room for values appended later; appending keeps stored addresses
 * valid only while it fits the declared width.
 */
export const literals = <const F extends string, const L extends ReadonlyArray<LiteralValue>>(
  field: F,
  values: L,
  options?: { readonly bits?: number | undefined },
): Dimension<F, "literals", L[number]> => {
  checkField(field, "literals")
  if (!Array.isArray(values) || values.length === 0) {
    return invalid(field, "literals", "declare at least one value.")
  }
  for (const value of values) {
    if (!["string", "number", "boolean"].includes(typeof value)) {
      return invalid(field, "literals", `${String(value)} is not a string, number or boolean.`)
    }
  }
  if (new Set(values).size !== values.length) {
    return invalid(field, "literals", "values must be distinct.")
  }
  const needed = bitsForLevels(BigInt(values.length))
  const bits = options?.bits ?? needed
  if (!Number.isInteger(bits) || bits < needed) {
    return invalid(
      field,
      "literals",
      `bits (${bits}) can't number ${values.length} values: at least ${needed}.`,
    )
  }
  return new DimensionImpl({
    kind: "literals",
    field,
    values: [...values],
    bits,
  }) as unknown as Dimension<F, "literals", L[number]>
}

/**
 * A string dimension over the first `bytes` (1..16) UTF-8 bytes of the value,
 * in byte order — the order DynamoDB sorts strings in. Values sharing those
 * bytes share a level.
 */
export const string = <const F extends string>(
  field: F,
  options: { readonly bytes: number },
): Dimension<F, "string"> => {
  checkField(field, "string")
  const bytes = options?.bytes
  if (!Number.isInteger(bytes) || bytes < 1 || bytes > 16) {
    return invalid(field, "string", `bytes (${bytes}) must be an integer from 1 to 16.`)
  }
  return new DimensionImpl({ kind: "string", field, bytes, bits: bytes * 8 }) as Dimension<
    F,
    "string"
  >
}
