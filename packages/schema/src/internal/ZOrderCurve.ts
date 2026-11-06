/**
 * @internal ZOrderCurve — the algebra behind Z-order sort keys (#171).
 *
 * A declared `sk.zorder` entry, resolved against its field (its kind and
 * storage from the field's schema, `internal/ZOrderDimension.ts`), is bound
 * per entity and field into a {@link BoundDimension}; the bound
 * dimensions of one sort key form a {@link Layout}. This module owns:
 *
 * - quantization: a key-form value → its level (`BoundDimension.quantize`);
 * - the MSB-aligned interleave of unequal widths, and its inverse;
 * - the address as bytes (W bytes, big-endian, right-aligned);
 * - boxes, cells and their relation, BIGMIN / LITMAX (Tropf–Herzog over the
 *   layout), the cell-descent `nextInBox` / `prevInBox`, and the capped range
 *   planner with gap merging;
 * - prefix segments (length-prefixed, or a truncated FNV-1a-64), `succ`.
 *
 * Everything is a pure function over `bigint` and plain `Uint8Array`s — no
 * Node builtins. Not part of the public API: the signatures and the stored
 * layout stay free to change until the geo follow-up needs them.
 */

import { Data, DateTime, Predicate } from "effect"
import type { DateTimeUnit, DimensionKind, DimensionSpec, LiteralValue } from "../ZOrder.js"
import { parseZonedIso } from "./ZonedIso.js"

// ---------------------------------------------------------------------------
// Bound dimensions
// ---------------------------------------------------------------------------

/**
 * How a dimension's field is stored, resolved from its schema at
 * `Entity.make`. Decides how a key-form value becomes epoch milliseconds, and
 * whether DynamoDB's comparison of the stored attribute agrees with the
 * quantized order.
 */
export type DimensionStorage =
  /** Stored `N`; key form `number` / `bigint`. */
  | { readonly _tag: "Number"; readonly numeric: "number" | "bigint" }
  /** Stored `S` (`NumberFromString`, `BigIntFromString`); key form `number` / `bigint`. */
  | { readonly _tag: "NumericString"; readonly numeric: "number" | "bigint" }
  /** Stored `N`: epoch milliseconds or seconds. */
  | { readonly _tag: "Epoch"; readonly unit: "epochMs" | "epochSeconds" }
  /** Stored `S`: a fixed-format UTC ISO string. */
  | { readonly _tag: "UtcIsoString" }
  /** Stored `S`: an ISO string with an offset or zone. */
  | { readonly _tag: "ZonedIsoString" }
  /** Stored `S` / `N` / `BOOL`, compared by equality. */
  | { readonly _tag: "Literal" }
  /** Stored `S`, raw UTF-8. */
  | { readonly _tag: "RawString" }

/** A declared dimension bound to an entity's field. */
export interface BoundDimension {
  readonly spec: DimensionSpec
  /** The model field name. */
  readonly field: string
  readonly storage: DimensionStorage
  readonly bits: number
  readonly levels: bigint
  /** The level of a key-form value. Throws {@link ZOrderValueError} (`[EDD-9092]`). */
  readonly quantize: (keyFormValue: unknown) => bigint
}

/**
 * A value a dimension can't quantize: `NaN`, an unparseable date, a value
 * outside a `literals` list. Thrown synchronously by `quantize`; the write
 * paths turn it into a `ValidationError`, `.within()` lets it throw.
 */
export class ZOrderValueError extends Data.TaggedError("ZOrderValueError")<{
  readonly field: string
  readonly value: unknown
  readonly reason: string
  /** Human-readable description, prefixed with `EDD-9092`. */
  readonly message: string
}> {}

/**
 * Is `u` a {@link ZOrderValueError}? By its tag, not `instanceof`: two copies
 * of this package (a consumer's and `effect-dynamodb`'s) still agree.
 */
export const isZOrderValueError = (u: unknown): u is ZOrderValueError =>
  Predicate.isTagged(u, "ZOrderValueError")

const refuseValue = (field: string, value: unknown, reason: string): never => {
  throw new ZOrderValueError({
    field,
    value,
    reason,
    message:
      `[EDD-9092] Z-order dimension "${field}" can't place ${describe(value)}: ${reason}. ` +
      `Every dimension of a Z-order sort key is key material, so the value must map onto ` +
      `one of the dimension's levels.`,
  })
}

const describe = (value: unknown): string => {
  if (typeof value === "bigint") return `${value}n`
  if (typeof value === "string") return JSON.stringify(value)
  return String(value)
}

/** The number of levels a declaration maps values onto. */
export const levelsOf = (spec: DimensionSpec): bigint => {
  switch (spec.kind) {
    case "int":
    case "float":
      return BigInt(Math.floor((spec.max - spec.min) / spec.step)) + 1n
    case "dateTime":
      return 1n << BigInt(spec.bits)
    case "literals":
      return BigInt(spec.values.length)
    case "string":
      return 1n << BigInt(8 * spec.bytes)
  }
}

const UNIT_MS: Record<DateTimeUnit, number> = {
  milliseconds: 1,
  seconds: 1_000,
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
  weeks: 604_800_000,
}

const encoder = new TextEncoder()

/** UTF-8 bytes of `text`, as a plain `Uint8Array`. */
export const utf8 = (text: string): Uint8Array => encoder.encode(text)

/**
 * Epoch milliseconds of a date dimension's key-form value, read by its
 * storage. A `DateTime` or `Date` (a domain value) is accepted as well.
 * `NaN` when the value isn't a date.
 */
export const epochMsOf = (storage: DimensionStorage, value: unknown): number => {
  if (DateTime.isDateTime(value)) return DateTime.toEpochMillis(value)
  if (value instanceof Date) return value.getTime()
  const n = typeof value === "bigint" ? Number(value) : value
  if (typeof n === "number") {
    if (storage._tag === "Epoch" && storage.unit === "epochSeconds") return n * 1000
    return storage._tag === "Epoch" ? n : Number.NaN
  }
  if (typeof n === "string") {
    if (storage._tag === "ZonedIsoString") {
      try {
        return DateTime.toEpochMillis(parseZonedIso(n))
      } catch {
        return Number.NaN
      }
    }
    return storage._tag === "UtcIsoString" ? Date.parse(n) : Number.NaN
  }
  return Number.NaN
}

const clampNumber = (raw: number, top: bigint): bigint =>
  raw <= 0 ? 0n : raw >= Number(top) ? top : BigInt(raw)

/** Bind a declaration to a field stored as `storage`. */
export const bindDimension = (spec: DimensionSpec, storage: DimensionStorage): BoundDimension => {
  const levels = levelsOf(spec)
  const top = levels - 1n
  const field = spec.field
  const quantize = ((): ((value: unknown) => bigint) => {
    switch (spec.kind) {
      case "int":
      case "float": {
        const min = BigInt(Math.trunc(spec.min))
        const max = BigInt(Math.trunc(spec.max))
        const step = BigInt(Math.trunc(spec.step))
        return (value) => {
          if (typeof value === "bigint" && spec.kind === "int") {
            // Bigint arithmetic end to end, never mixed with number.
            if (value <= min) return 0n
            if (value >= max) return top
            const q = (value - min) / step
            return q > top ? top : q
          }
          const n = typeof value === "bigint" ? Number(value) : value
          if (typeof n !== "number" || Number.isNaN(n)) {
            return refuseValue(field, value, "it is not a number")
          }
          if (n <= spec.min) return 0n
          if (n >= spec.max) return top
          return clampNumber(Math.floor((n - spec.min) / spec.step), top)
        }
      }
      case "dateTime": {
        const unitMs = UNIT_MS[spec.unit]
        return (value) => {
          const ms = epochMsOf(storage, value)
          if (!Number.isFinite(ms)) return refuseValue(field, value, "it is not a date")
          return clampNumber(Math.floor((ms - spec.fromMs) / unitMs), top)
        }
      }
      case "literals": {
        const values: ReadonlyArray<LiteralValue> = spec.values
        return (value) => {
          const index = values.indexOf(value as LiteralValue)
          if (index === -1) {
            return refuseValue(
              field,
              value,
              `it is not one of the declared values (${values.map((v) => describe(v)).join(", ")})`,
            )
          }
          return BigInt(index)
        }
      }
      case "string": {
        const width = spec.bytes
        return (value) => {
          if (typeof value !== "string") return refuseValue(field, value, "it is not a string")
          const bytes = utf8(value)
          let q = 0n
          for (let i = 0; i < width; i++) q = (q << 8n) | BigInt(bytes[i] ?? 0)
          return q
        }
      }
    }
  })()
  return { spec, field, storage, bits: spec.bits, levels, quantize }
}

/** The widest dimension of each kind, in bits (`[EDD-9089]`). */
export const MAX_DIMENSION_BITS: Record<DimensionKind, number> = {
  int: 53,
  float: 53,
  dateTime: 53,
  literals: 53,
  string: 128,
}

/** The widest address, in bits: 64 bytes (`[EDD-9089]`). */
export const MAX_ADDRESS_BITS = 512

// ---------------------------------------------------------------------------
// Layout (§4.2: unequal widths, MSB-aligned)
// ---------------------------------------------------------------------------

/** The interleave of one sort key's bound dimensions. */
export interface Layout {
  readonly dimensions: ReadonlyArray<BoundDimension>
  /** B: the address width in bits. */
  readonly bits: number
  /** W = ceil(B / 8): the address width in bytes. */
  readonly bytes: number
  /** Address bit j (0 = most significant) → its dimension and that dimension's bit (from LSB). */
  readonly order: ReadonlyArray<{ readonly dim: number; readonly bit: number }>
  /** Address bit j as a mask. */
  readonly posMask: ReadonlyArray<bigint>
  /** Every address bit of dimension i. */
  readonly dimMask: ReadonlyArray<bigint>
  /** The address bits of address bit j's dimension below it. */
  readonly lowerOf: ReadonlyArray<bigint>
}

/**
 * Lay out `dimensions`: each one's most significant bit enters in the first
 * round, so every dimension has coarse control near the top of the address,
 * and declaration order breaks ties within a round.
 */
export const makeLayout = (dimensions: ReadonlyArray<BoundDimension>): Layout => {
  const bits = dimensions.reduce((sum, d) => sum + d.bits, 0)
  const order: Array<{ dim: number; bit: number }> = []
  const rounds = Math.max(0, ...dimensions.map((d) => d.bits))
  for (let r = 0; r < rounds; r++) {
    dimensions.forEach((d, i) => {
      if (r < d.bits) order.push({ dim: i, bit: d.bits - 1 - r })
    })
  }
  const posMask = order.map((_, j) => 1n << BigInt(bits - 1 - j))
  const dimMask = dimensions.map((_, i) =>
    order.reduce((mask, o, j) => (o.dim === i ? mask | posMask[j]! : mask), 0n),
  )
  const lowerOf = order.map((o, j) => dimMask[o.dim]! & (posMask[j]! - 1n))
  return { dimensions, bits, bytes: Math.ceil(bits / 8), order, posMask, dimMask, lowerOf }
}

/** The address of one level per dimension. */
export const interleave = (layout: Layout, levels: ReadonlyArray<bigint>): bigint => {
  let z = 0n
  for (const { dim, bit } of layout.order) {
    z = (z << 1n) | ((levels[dim]! >> BigInt(bit)) & 1n)
  }
  return z
}

/** The level per dimension of an address. */
export const deinterleave = (layout: Layout, z: bigint): Array<bigint> => {
  const levels = layout.dimensions.map(() => 0n)
  layout.order.forEach(({ dim, bit }, j) => {
    levels[dim] = levels[dim]! | (((z >> BigInt(layout.bits - 1 - j)) & 1n) << BigInt(bit))
  })
  return levels
}

/** `z` as `width` bytes, big-endian, right-aligned. Always a plain, non-empty `Uint8Array`. */
export const toBytes = (z: bigint, width: number): Uint8Array => {
  const out = new Uint8Array(Math.max(1, width))
  let rest = z
  for (let i = out.length - 1; i >= 0; i--) {
    out[i] = Number(rest & 0xffn)
    rest >>= 8n
  }
  return out
}

/** The big-endian integer of `bytes`. */
export const fromBytes = (bytes: Uint8Array): bigint => {
  let z = 0n
  for (const b of bytes) z = (z << 8n) | BigInt(b)
  return z
}

// ---------------------------------------------------------------------------
// Boxes and cells (§5.1, §5.2)
// ---------------------------------------------------------------------------

/** An inclusive run of levels. */
export type Interval = readonly [bigint, bigint]

/** Per dimension, its sorted, disjoint intervals: a product of interval lists. */
export type Box = ReadonlyArray<ReadonlyArray<Interval>>

/** Every address: each dimension's whole bit range, as {@link quantizeBounds} leaves an unbounded one. */
export const fullBox = (layout: Layout): Box =>
  layout.dimensions.map((d) => [[0n, (1n << BigInt(d.bits)) - 1n] as const])

/** Is address `z` inside `box`? */
export const inBox = (layout: Layout, box: Box, z: bigint): boolean =>
  deinterleave(layout, z).every((q, i) => box[i]!.some(([lo, hi]) => q >= lo && q <= hi))

/** The addresses sharing the top `d` bits: an axis-aligned sub-box. */
export interface Cell {
  readonly d: number
  readonly zlo: bigint
  /** Per dimension, the levels the cell spans. */
  readonly ranges: ReadonlyArray<Interval>
}

export const rootCell = (layout: Layout): Cell => ({
  d: 0,
  zlo: 0n,
  ranges: layout.dimensions.map((d) => [0n, (1n << BigInt(d.bits)) - 1n] as const),
})

/** The cell's highest address. */
export const zhi = (layout: Layout, cell: Cell): bigint =>
  cell.zlo | ((1n << BigInt(layout.bits - cell.d)) - 1n)

/** The cell's two halves, in address order. */
export const split = (layout: Layout, cell: Cell): readonly [Cell, Cell] => {
  const j = cell.d
  const { dim, bit } = layout.order[j]!
  const mask = 1n << BigInt(bit)
  const [lo, hi] = cell.ranges[dim]!
  const with_ = (range: Interval) => cell.ranges.map((r, i) => (i === dim ? range : r))
  return [
    { d: j + 1, zlo: cell.zlo, ranges: with_([lo, hi & ~mask]) },
    { d: j + 1, zlo: cell.zlo | layout.posMask[j]!, ranges: with_([lo | mask, hi]) },
  ]
}

export type Relation = "disjoint" | "contained" | "partial"

/** How a cell meets a box. A partial cell always holds an in-box address. */
export const relate = (cell: Cell, box: Box): Relation => {
  let contained = true
  for (let i = 0; i < cell.ranges.length; i++) {
    const [lo, hi] = cell.ranges[i]!
    const intervals = box[i]!
    if (!intervals.some(([a, b]) => a <= hi && b >= lo)) return "disjoint"
    if (!intervals.some(([a, b]) => a <= lo && hi <= b)) contained = false
  }
  return contained ? "contained" : "partial"
}

// ---------------------------------------------------------------------------
// BIGMIN and LITMAX (§5.3)
// ---------------------------------------------------------------------------

const bitAt = (layout: Layout, x: bigint, j: number): bigint =>
  (x >> BigInt(layout.bits - 1 - j)) & 1n

/** Dimension bit j := 1, that dimension's lower bits := 0. */
const load1000 = (layout: Layout, x: bigint, j: number): bigint =>
  (x | layout.posMask[j]!) & ~layout.lowerOf[j]!

/** Dimension bit j := 0, that dimension's lower bits := 1. */
const load0111 = (layout: Layout, x: bigint, j: number): bigint =>
  (x & ~layout.posMask[j]!) | layout.lowerOf[j]!

const unreachable = (): never => {
  throw new Error("ZOrderCurve: zmin exceeds zmax in some dimension")
}

/**
 * The smallest in-box address greater than `z`, for a single-interval box
 * with corners `zmin` / `zmax` (Tropf–Herzog); `z` itself when it is in the
 * box; `undefined` when no in-box address follows it.
 */
export const bigmin = (
  layout: Layout,
  z: bigint,
  zmin: bigint,
  zmax: bigint,
): bigint | undefined => {
  let result: bigint | undefined
  let min = zmin
  let max = zmax
  for (let j = 0; j < layout.bits; j++) {
    switch ((bitAt(layout, z, j) << 2n) | (bitAt(layout, min, j) << 1n) | bitAt(layout, max, j)) {
      case 0b000n:
      case 0b111n:
        continue
      case 0b001n:
        result = load1000(layout, min, j)
        max = load0111(layout, max, j)
        continue
      case 0b011n:
        return min
      case 0b100n:
        return result
      case 0b101n:
        min = load1000(layout, min, j)
        continue
      default:
        return unreachable()
    }
  }
  return z
}

/**
 * The largest in-box address less than `z`, for a single-interval box with
 * corners `zmin` / `zmax`; `z` itself when it is in the box; `undefined` when
 * no in-box address precedes it.
 */
export const litmax = (
  layout: Layout,
  z: bigint,
  zmin: bigint,
  zmax: bigint,
): bigint | undefined => {
  let result: bigint | undefined
  let min = zmin
  let max = zmax
  for (let j = 0; j < layout.bits; j++) {
    switch ((bitAt(layout, z, j) << 2n) | (bitAt(layout, min, j) << 1n) | bitAt(layout, max, j)) {
      case 0b000n:
      case 0b111n:
        continue
      case 0b001n:
        max = load0111(layout, max, j)
        continue
      case 0b011n:
        return result
      case 0b100n:
        return max
      case 0b101n:
        result = load0111(layout, max, j)
        min = load1000(layout, min, j)
        continue
      default:
        return unreachable()
    }
  }
  return z
}

/** The box's low and high corners as addresses (its first interval per dimension). */
export const corners = (
  layout: Layout,
  box: Box,
): { readonly zmin: bigint; readonly zmax: bigint } => ({
  zmin: interleave(
    layout,
    box.map((intervals) => intervals[0]![0]),
  ),
  zmax: interleave(
    layout,
    box.map((intervals) => intervals[intervals.length - 1]![1]),
  ),
})

/** The smallest in-box address at or after `z` (cell descent; any box). */
export const nextInBox = (layout: Layout, box: Box, z: bigint): bigint | undefined => {
  const descend = (cell: Cell): bigint | undefined => {
    if (zhi(layout, cell) < z) return undefined
    const relation = relate(cell, box)
    if (relation === "disjoint") return undefined
    if (relation === "contained") return cell.zlo > z ? cell.zlo : z
    for (const child of split(layout, cell)) {
      const found = descend(child)
      if (found !== undefined) return found
    }
    return undefined
  }
  return descend(rootCell(layout))
}

/** The largest in-box address at or before `z` (cell descent; any box). */
export const prevInBox = (layout: Layout, box: Box, z: bigint): bigint | undefined => {
  const descend = (cell: Cell): bigint | undefined => {
    if (cell.zlo > z) return undefined
    const relation = relate(cell, box)
    if (relation === "disjoint") return undefined
    if (relation === "contained") {
      const high = zhi(layout, cell)
      return high < z ? high : z
    }
    const [low, high] = split(layout, cell)
    return descend(high) ?? descend(low)
  }
  return descend(rootCell(layout))
}

// ---------------------------------------------------------------------------
// The capped range planner (§5.4)
// ---------------------------------------------------------------------------

/** A run of addresses; `exact` when every address in it is in the box. */
export interface AddressRange {
  readonly lo: bigint
  readonly hi: bigint
  readonly exact: boolean
}

/** How far past `maxRanges` the merged count may grow before refinement stops. */
export const REFINE_FACTOR = 4

/** The most partial cells one refinement level may hold. */
export const MAX_PLANNER_CELLS = 16_384

/** Join ranges that touch (`s.lo = r.hi + 1`); `ranges` sorted by `lo`. */
const mergeAdjacent = (ranges: ReadonlyArray<AddressRange>): Array<AddressRange> => {
  const out: Array<AddressRange> = []
  for (const range of ranges) {
    const last = out[out.length - 1]
    if (last !== undefined && range.lo === last.hi + 1n) {
      out[out.length - 1] = { lo: last.lo, hi: range.hi, exact: last.exact && range.exact }
    } else {
      out.push(range)
    }
  }
  return out
}

const byLo = (a: AddressRange, b: AddressRange): number => (a.lo < b.lo ? -1 : a.lo > b.lo ? 1 : 0)

/**
 * Cover `box` with at most `maxRanges` address ranges. Cells are refined level
 * by level; contained cells become exact ranges, partial ones stay open until
 * the merged count passes `refineFactor × maxRanges` (it can only grow, so
 * the exact plan can't fit any more) or a level exceeds
 * {@link MAX_PLANNER_CELLS}. Then the smallest gaps (in addresses; ties at the
 * lowest address) are merged until the cap holds. `exact` when every range
 * holds only in-box addresses.
 */
export const plan = (
  layout: Layout,
  box: Box,
  maxRanges: number,
  refineFactor: number = REFINE_FACTOR,
): { readonly ranges: ReadonlyArray<AddressRange>; readonly exact: boolean } => {
  const root = rootCell(layout)
  const done: Array<AddressRange> = []
  let frontier: Array<Cell> = []
  switch (relate(root, box)) {
    case "disjoint":
      return { ranges: [], exact: true }
    case "contained":
      done.push({ lo: root.zlo, hi: zhi(layout, root), exact: true })
      break
    case "partial":
      frontier = [root]
  }
  const asRanges = (cells: ReadonlyArray<Cell>) =>
    cells.map((cell) => ({ lo: cell.zlo, hi: zhi(layout, cell), exact: false }))
  while (frontier.length > 0) {
    const next: Array<Cell> = []
    for (const cell of frontier) {
      for (const child of split(layout, cell)) {
        switch (relate(child, box)) {
          case "contained":
            done.push({ lo: child.zlo, hi: zhi(layout, child), exact: true })
            break
          case "partial":
            next.push(child)
            break
          case "disjoint":
            break
        }
      }
    }
    frontier = next
    const lowerBound = mergeAdjacent([...done, ...asRanges(frontier)].sort(byLo)).length
    if (lowerBound > refineFactor * maxRanges || frontier.length > MAX_PLANNER_CELLS) break
  }
  const exact = frontier.length === 0
  const ranges = mergeAdjacent([...done, ...asRanges(frontier)].sort(byLo))
  while (ranges.length > Math.max(1, maxRanges)) {
    let k = 0
    for (let i = 1; i < ranges.length - 1; i++) {
      const gap = ranges[i + 1]!.lo - ranges[i]!.hi
      if (gap < ranges[k + 1]!.lo - ranges[k]!.hi) k = i
    }
    ranges.splice(k, 2, { lo: ranges[k]!.lo, hi: ranges[k + 1]!.hi, exact: false })
  }
  return { ranges, exact: exact && ranges.every((r) => r.exact) }
}

// ---------------------------------------------------------------------------
// Query bounds → box (§5.1)
// ---------------------------------------------------------------------------

/** One dimension's bound, in key form. */
export type DimensionBound =
  | { readonly eq: unknown }
  | { readonly between: readonly [unknown, unknown] }
  | { readonly in: ReadonlyArray<unknown> }
  | {
      readonly gt?: unknown
      readonly gte?: unknown
      readonly lt?: unknown
      readonly lte?: unknown
    }

/** A key-form value in its dimension's own order (dates as epoch ms, strings as bytes, literals as their index). */
const ordinal = (dim: BoundDimension, value: unknown): number | bigint | Uint8Array => {
  switch (dim.spec.kind) {
    case "int":
    case "float": {
      if (typeof value === "bigint") return value
      if (typeof value === "number" && !Number.isNaN(value)) return value
      return refuseValue(dim.field, value, "it is not a number")
    }
    case "dateTime": {
      const ms = epochMsOf(dim.storage, value)
      return Number.isFinite(ms) ? ms : refuseValue(dim.field, value, "it is not a date")
    }
    case "literals":
      return dim.quantize(value)
    case "string":
      return typeof value === "string"
        ? utf8(value)
        : refuseValue(dim.field, value, "it is not a string")
  }
}

const compareOrdinals = (
  a: number | bigint | Uint8Array,
  b: number | bigint | Uint8Array,
): number => {
  if (a instanceof Uint8Array && b instanceof Uint8Array) return compareBytes(a, b)
  if (typeof a === "bigint" && typeof b === "bigint") return a < b ? -1 : a > b ? 1 : 0
  const x = Number(a)
  const y = Number(b)
  return x < y ? -1 : x > y ? 1 : 0
}

/**
 * The box a set of bounds selects, or `"empty"` when no address can match.
 * Bounds are first compared in the dimension's own order, so an inverted pair
 * (`{ gte: 10, lte: 5 }`, or a pair inverted within one level) is empty rather
 * than a key condition DynamoDB rejects. `literals` ranges follow the declared
 * order; `in` selects members, grouped into runs.
 *
 * A dimension's open upper end — no bound, or one at its top level — runs to
 * the top of its bits, `2^bits - 1`, not `levels - 1`: no stored value is
 * above the top level (`quantize` clamps), so the levels between hold no rows,
 * and a box edge through them would only split cells the planner then has to
 * refine.
 */
export const quantizeBounds = (
  layout: Layout,
  bounds: Readonly<Record<string, DimensionBound | undefined>>,
): Box | "empty" => {
  const box: Array<ReadonlyArray<Interval>> = []
  for (const dim of layout.dimensions) {
    const bound = bounds[dim.field]
    const top = dim.levels - 1n
    const ceiling = (1n << BigInt(dim.bits)) - 1n
    /** `[lo, hi]`, its top level widened to the ceiling. */
    const interval = (lo: bigint, hi: bigint): Interval => [lo, hi === top ? ceiling : hi]
    if (bound === undefined) {
      box.push([[0n, ceiling]])
      continue
    }
    if ("in" in bound) {
      if (dim.spec.kind !== "literals") {
        throw new Error(`[EDD-9093] "in" bounds only a literals dimension, not "${dim.field}".`)
      }
      const members = [...new Set(bound.in.map((v) => dim.quantize(v)))].sort((a, b) =>
        a < b ? -1 : a > b ? 1 : 0,
      )
      if (members.length === 0) return "empty"
      const runs: Array<[bigint, bigint]> = []
      for (const q of members) {
        const last = runs[runs.length - 1]
        if (last !== undefined && q === last[1] + 1n) last[1] = q
        else runs.push([q, q])
      }
      box.push(runs.map(([lo, hi]) => interval(lo, hi)))
      continue
    }
    if ("eq" in bound) {
      const q = dim.quantize(bound.eq)
      box.push([interval(q, q)])
      continue
    }
    const range = bound as {
      readonly between?: readonly [unknown, unknown]
      readonly gt?: unknown
      readonly gte?: unknown
      readonly lt?: unknown
      readonly lte?: unknown
    }
    const lower = range.between !== undefined ? range.between[0] : (range.gt ?? range.gte)
    const upper = range.between !== undefined ? range.between[1] : (range.lt ?? range.lte)
    if (lower !== undefined && upper !== undefined) {
      const order = compareOrdinals(ordinal(dim, lower), ordinal(dim, upper))
      const exclusive = range.gt !== undefined || range.lt !== undefined
      if (order > 0 || (order === 0 && exclusive)) return "empty"
    }
    const lo = lower === undefined ? 0n : dim.quantize(lower)
    const hi = upper === undefined ? top : dim.quantize(upper)
    if (lo > hi) return "empty"
    box.push([interval(lo, hi)])
  }
  return box
}

// ---------------------------------------------------------------------------
// Bytes: prefix segments (§4.3), succ (§7.5)
// ---------------------------------------------------------------------------

const FNV_OFFSET = 0xcbf29ce484222325n
const FNV_PRIME = 0x100000001b3n
const MASK_64 = 0xffffffffffffffffn

/** FNV-1a, 64-bit, over `bytes`. A stored format: pinned by golden vectors. */
export const fnv1a64 = (bytes: Uint8Array): bigint => {
  let h = FNV_OFFSET
  for (const b of bytes) h = ((h ^ BigInt(b)) * FNV_PRIME) & MASK_64
  return h
}

/**
 * One prefix segment from its key text (already serialised and cased):
 * `u16be(len) ‖ utf8(text)`, where `len` is the byte length; or, with `hash`,
 * the first `hash` bytes (big-endian) of FNV-1a-64 over the same bytes.
 */
export const prefixSegment = (text: string, hash: number | undefined): Uint8Array => {
  const bytes = utf8(text)
  if (hash !== undefined) {
    const h = fnv1a64(bytes)
    const out = new Uint8Array(hash)
    for (let i = 0; i < hash; i++) out[i] = Number((h >> BigInt(8 * (7 - i))) & 0xffn)
    return out
  }
  const out = new Uint8Array(2 + bytes.length)
  out[0] = (bytes.length >> 8) & 0xff
  out[1] = bytes.length & 0xff
  out.set(bytes, 2)
  return out
}

/** `parts` end to end, as one plain `Uint8Array`. */
export const concatBytes = (parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

/** Unsigned byte order — DynamoDB's order for `B` keys. */
export const compareBytes = (a: Uint8Array, b: Uint8Array): number => {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i]! - b[i]!
  }
  return a.length - b.length
}

/**
 * The smallest byte string greater than every string starting with `bytes`:
 * trailing `0xFF` bytes dropped, then the last byte incremented. `undefined`
 * when there is none (empty, or all `0xFF`).
 */
export const succ = (bytes: Uint8Array): Uint8Array | undefined => {
  let end = bytes.length
  while (end > 0 && bytes[end - 1] === 0xff) end--
  if (end === 0) return undefined
  const out = bytes.slice(0, end)
  out[end - 1] = out[end - 1]! + 1
  return out
}

/** `bytes` as `0x…` hex — how `B` key values are shown. */
export const toHex = (bytes: Uint8Array): string =>
  `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`
