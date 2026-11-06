/**
 * @internal Z-order dimension entries (#171): checking a declared entry and
 * resolving it against the field it names.
 *
 * A dimension is declared as an entry in `sk.zorder` — a bare field name or
 * `{ field, ...options }` — whose options follow the field's type. The entry's
 * options decide its shape ({@link declareDimension}, model-free, at
 * `normalizeGsiConfig`); the field's schema then decides the rest
 * ({@link resolveDimension}, at `Entity.make`): integer or float arithmetic for
 * a range, the members of a literals dimension, and how the field is stored.
 */

import { DateTime, type Schema } from "effect"
import type { DynamoEncoding } from "../DynamoModel.js"
import type { DateTimeUnit, DimensionSpec, LiteralValue } from "../ZOrder.js"
import { keyFormLiterals, keyFormValueKind } from "./CompositeCodec.js"
import { numericTypeWithStringEncoding } from "./SchemaAccessors.js"
import type { DimensionStorage } from "./ZOrderCurve.js"

/** The four kinds of entry, by the options they carry. */
export type DimensionShape = "range" | "dateTime" | "literals" | "string"

/** A dimension entry as declared, its options checked without the model. */
export type DeclaredDimension =
  | {
      readonly shape: "range"
      readonly field: string
      readonly min: number
      readonly max: number
      readonly step: number
    }
  | {
      readonly shape: "dateTime"
      readonly field: string
      readonly from: string
      readonly fromMs: number
      readonly unit: DateTimeUnit
      readonly bits: number
    }
  | {
      readonly shape: "literals"
      readonly field: string
      /** As declared; `undefined` takes the field's members. */
      readonly values: ReadonlyArray<LiteralValue> | undefined
      readonly bits: number | undefined
    }
  | {
      readonly shape: "string"
      readonly field: string
      readonly bytes: number
    }

const SHAPE_OPTIONS: Record<DimensionShape, ReadonlyArray<string>> = {
  range: ["min", "max", "step"],
  dateTime: ["from", "unit", "bits"],
  literals: ["values", "bits"],
  string: ["bytes"],
}

const UNITS: ReadonlyArray<DateTimeUnit> = [
  "milliseconds",
  "seconds",
  "minutes",
  "hours",
  "days",
  "weeks",
]

const MAX_FLOAT_LEVELS = 2n ** 53n

/** Bits needed to number `n` levels: at least 1. */
export const bitsForLevels = (levels: bigint): number => {
  let bits = 0
  for (let top = levels - 1n; top > 0n; top >>= 1n) bits++
  return Math.max(1, bits)
}

const levelCount = (min: number, max: number, step: number): bigint =>
  BigInt(Math.floor((max - min) / step)) + 1n

const describeOptions = (shape: DimensionShape): string =>
  shape === "range"
    ? "{ field, min, max, step? }"
    : shape === "dateTime"
      ? "{ field, from, unit, bits }"
      : shape === "literals"
        ? "a bare name or { field, values?, bits? }"
        : "{ field, bytes }"

/**
 * The shape an entry's options give it. `bits` alone, or no options at all,
 * is a literals entry; `bits` beside `from` / `unit` is a date-time one.
 */
const shapeOf = (
  index: string,
  field: string,
  entry: globalThis.Record<string, unknown>,
): DimensionShape => {
  const present = (key: string): boolean => key in entry && entry[key] !== undefined
  const shapes = (Object.keys(SHAPE_OPTIONS) as ReadonlyArray<DimensionShape>).filter((shape) =>
    SHAPE_OPTIONS[shape].some((key) => key !== "bits" && present(key)),
  )
  if (shapes.length > 1) {
    return invalid(
      index,
      field,
      `it mixes the options of ${shapes.map(describeOptions).join(" and ")}; an entry takes one kind.`,
    )
  }
  return shapes[0] ?? "literals"
}

const invalid = (index: string, field: unknown, why: string): never => {
  throw new Error(`[EDD-9087] Index "${index}" dimension ${JSON.stringify(field)}: ${why}`)
}

/**
 * Check one `sk.zorder` entry without the model: its field name, which kind
 * of entry its options make, that it carries only that kind's options, and the
 * options themselves (`[EDD-9087]`). A value that is neither a name nor an
 * object naming a field is `[EDD-9086]`.
 */
export const declareDimension = (
  index: string,
  entry: unknown,
  malformed: (why: string) => Error,
): DeclaredDimension => {
  if (typeof entry === "string") {
    if (entry.length === 0)
      throw malformed("a zorder entry names a model field; got an empty name.")
    return { shape: "literals", field: entry, values: undefined, bits: undefined }
  }
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw malformed(
      'each zorder entry is a model field name or { field, ...options } (e.g. { field: "price", min: 0, max: 100 }).',
    )
  }
  const options = entry as globalThis.Record<string, unknown>
  const field = options.field
  if (typeof field !== "string" || field.length === 0) {
    throw malformed('each zorder entry object names its model field: { field: "price", … }.')
  }
  const shape = shapeOf(index, field, options)
  // The types refuse a misspelled field, not a misspelled option beside valid
  // ones (`{ field, min, max, stpe }` still fits the range entry), so the
  // options are checked here: an unknown one would otherwise be silently
  // ignored, and the dimension sized without it.
  const unknown = Object.keys(options).filter(
    (key) => key !== "field" && !SHAPE_OPTIONS[shape].includes(key),
  )
  if (unknown.length > 0) {
    return invalid(
      index,
      field,
      `${unknown.map((key) => JSON.stringify(key)).join(", ")} ${unknown.length === 1 ? "is not an option" : "are not options"} of this entry, which takes ${describeOptions(shape)}.`,
    )
  }
  switch (shape) {
    case "range": {
      const { min, max } = options as { readonly min?: unknown; readonly max?: unknown }
      const step = options.step ?? 1
      if (![min, max, step].every((n) => typeof n === "number" && Number.isFinite(n))) {
        return invalid(index, field, "min, max and step must be finite numbers.")
      }
      const [lo, hi, by] = [min, max, step] as [number, number, number]
      if (lo >= hi) return invalid(index, field, `min (${lo}) must be less than max (${hi}).`)
      if (!(by > 0) || by > hi - lo) {
        return invalid(
          index,
          field,
          `step (${by}) must be above 0 and at most max - min (${hi - lo}).`,
        )
      }
      return { shape, field, min: lo, max: hi, step: by }
    }
    case "dateTime": {
      const { from, unit, bits } = options as {
        readonly from?: unknown
        readonly unit?: unknown
        readonly bits?: unknown
      }
      const fromMs = (() => {
        if (DateTime.isDateTime(from)) return DateTime.toEpochMillis(from)
        if (from instanceof Date) return from.getTime()
        if (typeof from === "string") return Date.parse(from)
        return Number.NaN
      })()
      if (!Number.isFinite(fromMs)) {
        return invalid(index, field, `from (${String(from)}) is not a date.`)
      }
      if (typeof unit !== "string" || !UNITS.includes(unit as DateTimeUnit)) {
        return invalid(index, field, `unit must be one of ${UNITS.join(", ")}.`)
      }
      if (typeof bits !== "number" || !Number.isInteger(bits) || bits < 1 || bits > 53) {
        return invalid(index, field, `bits (${String(bits)}) must be an integer from 1 to 53.`)
      }
      return {
        shape,
        field,
        from: new Date(fromMs).toISOString(),
        fromMs,
        unit: unit as DateTimeUnit,
        bits,
      }
    }
    case "literals": {
      const { values, bits } = options as { readonly values?: unknown; readonly bits?: unknown }
      if (values !== undefined) {
        if (!Array.isArray(values) || values.length === 0) {
          return invalid(index, field, "values lists at least one member.")
        }
        for (const value of values) {
          if (!["string", "number", "boolean"].includes(typeof value)) {
            return invalid(index, field, `${String(value)} is not a string, number or boolean.`)
          }
        }
        if (new Set(values).size !== values.length) {
          return invalid(index, field, "values must be distinct.")
        }
      }
      if (bits !== undefined && (typeof bits !== "number" || !Number.isInteger(bits) || bits < 1)) {
        return invalid(index, field, `bits (${String(bits)}) must be a positive integer.`)
      }
      return {
        shape,
        field,
        values: values === undefined ? undefined : [...(values as ReadonlyArray<LiteralValue>)],
        bits: bits as number | undefined,
      }
    }
    case "string": {
      const bytes = options.bytes
      if (typeof bytes !== "number" || !Number.isInteger(bytes) || bytes < 1 || bytes > 16) {
        return invalid(index, field, `bytes (${String(bytes)}) must be an integer from 1 to 16.`)
      }
      return { shape, field, bytes }
    }
  }
}

/** The field a dimension names, as `Entity.make` sees it. */
export interface DimensionField {
  /** The field's schema in the entity's input schema; `undefined` when it isn't a model field. */
  readonly schema: Schema.Top | undefined
  /** Its date encoding, when it is a date field. */
  readonly encoding: DynamoEncoding | undefined
}

/**
 * Resolve a declared dimension against its field (design §4.1): integer or
 * float arithmetic for a range, the members of a literals dimension, the bit
 * width, and how the field is stored. `[EDD-9088]` when the entry doesn't fit
 * the field, or the field's order is unknown; `[EDD-9087]` for options the
 * field rules out (a fractional range over a `bigint` field, too few `bits`).
 */
export const resolveDimension = (
  entityType: string,
  indexName: string,
  declared: DeclaredDimension,
  field: DimensionField,
): { readonly spec: DimensionSpec; readonly storage: DimensionStorage } => {
  const refuse = (why: string): never => {
    throw new Error(
      `[EDD-9088] Entity "${entityType}": index "${indexName}" dimension "${declared.field}" ` +
        `doesn't fit its field: ${why}`,
    )
  }
  const schema = field.schema
  if (schema === undefined) {
    return refuse("it isn't a model field, so its stored form is unknown.")
  }
  const kind = keyFormValueKind(schema)
  switch (declared.shape) {
    case "range": {
      if (kind !== "number" && kind !== "bigint") {
        return refuse(
          `a range (${describeOptions("range")}) needs a number or bigint field; this field takes ` +
            `${kind === "string" ? describeOptions("string") : "another kind of entry"}.`,
        )
      }
      const { min, max, step } = declared
      const integral = [min, max, step].every((n) => Number.isSafeInteger(n))
      if (kind === "bigint" && !integral) {
        return invalid(
          indexName,
          declared.field,
          "a bigint field is quantized in integer steps: min, max and step must be safe integers.",
        )
      }
      const levels = levelCount(min, max, step)
      if (!integral && levels > MAX_FLOAT_LEVELS) {
        return invalid(
          indexName,
          declared.field,
          `(max - min) / step gives ${levels} levels; at most 2^53.`,
        )
      }
      const storage: DimensionStorage = numericTypeWithStringEncoding(schema)
        ? { _tag: "NumericString", numeric: kind }
        : { _tag: "Number", numeric: kind }
      return {
        spec: {
          kind: integral ? "int" : "float",
          field: declared.field,
          min,
          max,
          step,
          bits: bitsForLevels(levels),
        },
        storage,
      }
    }
    case "dateTime": {
      const encoding = field.encoding
      const storage: DimensionStorage | undefined =
        encoding?.storage === "epochMs" || encoding?.storage === "epochSeconds"
          ? { _tag: "Epoch", unit: encoding.storage }
          : encoding?.storage === "string"
            ? encoding.domain === "DateTime.Zoned"
              ? { _tag: "ZonedIsoString" }
              : { _tag: "UtcIsoString" }
            : undefined
      if (storage === undefined) {
        return refuse(
          "a date-time window needs a date field with a known storage format " +
            "(a DynamoModel date schema, or an Effect date schema) — a plain number or " +
            "string has no known order.",
        )
      }
      const { from, fromMs, unit, bits } = declared
      return {
        spec: { kind: "dateTime", field: declared.field, from, fromMs, unit, bits },
        storage,
      }
    }
    case "literals": {
      if (kind !== "string" && kind !== "number" && kind !== "boolean") {
        return refuse(
          "a literals dimension needs a literal union, string, number or boolean field.",
        )
      }
      const members = keyFormLiterals(schema) ?? (kind === "boolean" ? [false, true] : undefined)
      if (kind === "number" && members === undefined) {
        return refuse(
          `a plain number field takes a range (${describeOptions("range")}), ordered by value; ` +
            "values and bits belong to a literal union field.",
        )
      }
      const values = declared.values ?? members
      if (values === undefined) {
        return refuse(
          `the field isn't limited to literal members, so a bare name has no levels; ` +
            `declare ${describeOptions("string")}, or list the members in values.`,
        )
      }
      const foreign = values.find((value) => typeof value !== kind)
      if (foreign !== undefined) {
        return refuse(`${JSON.stringify(foreign)} is not a ${kind}, the field's key form.`)
      }
      const missing = members?.filter((member) => !values.includes(member))
      if (missing !== undefined && missing.length > 0) {
        return refuse(
          `the field's values ${missing.map((m) => JSON.stringify(m)).join(", ")} are not ` +
            `declared, so they would have no level.`,
        )
      }
      const needed = bitsForLevels(BigInt(values.length))
      const bits = declared.bits ?? needed
      if (bits < needed) {
        return invalid(
          indexName,
          declared.field,
          `bits (${bits}) can't number ${values.length} values: at least ${needed}.`,
        )
      }
      return {
        spec: { kind: "literals", field: declared.field, values: [...values], bits },
        storage: { _tag: "Literal" },
      }
    }
    case "string": {
      if (kind !== "string") {
        return refuse(`a byte width (${describeOptions("string")}) needs a string field.`)
      }
      return {
        spec: {
          kind: "string",
          field: declared.field,
          bytes: declared.bytes,
          bits: declared.bytes * 8,
        },
        storage: { _tag: "RawString" },
      }
    }
  }
}
