/**
 * @internal RangePlanner — the pure half of a planned query (#171, design §9).
 *
 * A planner never sends a request. It turns a plan and each response into the
 * next *step* — a `Read` of one key range, a `Probe` that locates where to read
 * next, or `Done` — and the terminal's loop (`Query.ts`) sends every request,
 * so every request counts against `maxPages`, is observed by `onRequest` and
 * is never sent once the call is about to return.
 *
 * Plans over a composite sort key (§7):
 *
 * - `key` — the bounds reach the key condition directly: one range.
 * - `skip-scan` — composites left of the first bound have no bound (the
 *   *skip tuple*): a probe (`Limit: 1`) finds each distinct tuple `T`, then
 *   `T`'s own range is read, then a probe from just past `T`, and so on.
 * - `filter` — one range over everything under the pinned prefix, every bound
 *   checked per row: when skip-scan is not sound (§7.3), after the probe budget
 *   is spent (§7.4) or at a key the tuple parse can't read.
 *
 * Plans over a Z-order sort key (§5): inside each prefix tuple, `naive` reads
 * the box's hull, `jump` follows the last examined key to the next in-box
 * address, `precise` reads a capped range plan; a missing prefix composite is
 * walked by a binary skip-scan (§7.5).
 *
 * Positions are what a cursor records (§10): what has been **completed**, never
 * a range to trust. Resume recomputes the plan and places the position in it.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { KEY_DELIMITER } from "@effect-dynamodb/schema/DynamoSchema.js"
import { ValidationError } from "@effect-dynamodb/schema/Errors.js"
import {
  type AddressRange,
  type Box,
  bigmin,
  concatBytes,
  corners,
  fromBytes,
  inBox,
  type Layout,
  litmax,
  nextInBox,
  prevInBox,
  REFINE_FACTOR,
  succ,
  toBytes,
} from "@effect-dynamodb/schema/internal/ZOrderCurve.js"
import { SORT_KEY_MAX } from "@effect-dynamodb/schema/KeyComposer.js"
import type { KeyCondition, KeyValue, PlanMode, QueryExplain, ZOrderOptions } from "../Query.js"
import * as Cursor from "./Cursor.js"
import { compileExpr, type Expr } from "./Expr.js"

// ---------------------------------------------------------------------------
// Steps and positions (§9.1)
// ---------------------------------------------------------------------------

/** A key range, both ends inclusive; `undefined` is open. */
export interface KeyRange {
  readonly lower: KeyValue | undefined
  readonly upper: KeyValue | undefined
  /** Sent instead of the bounds: a whole, unclipped subtree. */
  readonly beginsWith?: KeyValue | undefined
  /** `false`: rows inside the range may still fall outside the bounds (a row check runs). */
  readonly exact: boolean
}

/** What is done inside a position's tuple (or the whole plan without one). */
export type Boundary =
  /** Nothing delivered yet. */
  | { readonly _tag: "Start" }
  /** Every in-plan row up to `through` (in scan direction) is done. */
  | { readonly _tag: "Through"; readonly through: KeyValue }
  /** Inside a range, after this key. */
  | { readonly _tag: "At"; readonly startKey: Record<string, AttributeValue> }
  /** The whole tuple is finished. */
  | { readonly _tag: "TupleDone" }

export interface Position {
  readonly mode: PlanMode
  /** The skip tuple `T` (`undefined`: none). */
  readonly tuple: KeyValue | undefined
  readonly boundary: Boundary
  /** Probes sent by this terminal call (§7.4). Never in a cursor: a resumed query starts afresh. */
  readonly skips: number
}

/** How a read's `Limit` is sized: the pass-rate estimator (§8), or a jump run (§8.5, Z-order). */
export type Sizing =
  | { readonly _tag: "estimator" }
  | { readonly _tag: "jump"; readonly run: number }

export interface ReadStep {
  readonly _tag: "Read"
  /** What a cursor taken before this read's next request records. */
  readonly at: Position
  readonly range: KeyRange
  readonly startKey: Record<string, AttributeValue> | undefined
  /** The range's index in a precomputed plan (Z-order precise plans); `undefined` otherwise. */
  readonly planIndex: number | undefined
  readonly sizing: Sizing
  /** Bounds this read's key condition can't express (§11). */
  readonly rowCheck: RowCheck | undefined
}

export interface ProbeStep {
  readonly _tag: "Probe"
  readonly at: Position
  readonly lower: KeyValue | undefined
  readonly upper: KeyValue | undefined
}

export interface DoneStep {
  readonly _tag: "Done"
}

export type Step = ReadStep | ProbeStep | DoneStep

/**
 * A library-owned raw-row predicate (§11), evaluated before decode beside the
 * history-row exclusion. Its attributes are borrowed into an active projection
 * and stripped again afterwards.
 */
export interface RowCheck {
  /** The fields it checks (`explain().rowChecks`). */
  readonly fields: ReadonlyArray<string>
  /** The stored attributes it reads. */
  readonly reads: ReadonlyArray<string>
  readonly accepts: (row: Record<string, AttributeValue>) => boolean
}

/** What the query around a planner decides: resolved when a terminal runs. */
export interface PlanContext {
  readonly reverse: boolean
  readonly maxSkips: number
  /** `.zorder()` options (Z-order plans only). */
  readonly zorder?: ZOrderOptions | undefined
}

export interface RangePlanner {
  readonly fingerprint: string
  /** The plan a fresh query starts in. */
  readonly mode: PlanMode
  /** ANDed into every read's `FilterExpression` (Z-order dimension bounds; none for composites). */
  readonly filter: Expr | undefined
  /** The row check of the reads a fresh query starts with. */
  readonly rowCheck: RowCheck | undefined
  /** The first step; `[EDD-9094]` for a cursor that doesn't belong to this plan. */
  readonly start: (cursor: Cursor.CursorV2 | undefined) => Step | ValidationError
  readonly afterRead: (
    step: ReadStep,
    lastEvaluatedKey: Record<string, AttributeValue> | undefined,
  ) => Step
  readonly afterProbe: (step: ProbeStep, key: KeyValue | undefined) => Step
  /** The precise ranges following `step` in the same tuple, for a window (§9.2). */
  readonly following: (step: ReadStep, n: number) => ReadonlyArray<ReadStep>
  /** The cursor resuming at `step` (`null` only for `Done`). */
  readonly cursor: (step: Step) => Cursor.CursorV2 | null
  readonly explain: (sizing: QueryExplain["sizing"]) => QueryExplain
}

/** A planner, resolved from the final query state when a terminal runs. */
export type PlannerFactory = (context: PlanContext) => RangePlanner

/** Default skip-scan probe budget per terminal call (§7.4). */
export const DEFAULT_MAX_SKIPS = 32

/** Default range cap of a Z-order `precise` plan and of `auto`'s choice (§3.4). */
export const DEFAULT_MAX_RANGES = 16

/** A jump run's first `Limit`, and what it resets to after a jump (§8.5). */
export const JUMP_INITIAL = 16

/** The largest `Limit` a jump run grows to (§8.5). */
export const JUMP_MAX_LIMIT = 1_000

// ---------------------------------------------------------------------------
// Key values: order, display, conditions
// ---------------------------------------------------------------------------

/**
 * `SK_MAX_SENTINEL` (`DynamoClient.ts`): above every character key
 * composition emits, so `prefix + MAX` bounds every key under `prefix`.
 */
export const KEY_MAX = SORT_KEY_MAX

const encoder = new TextEncoder()

const compareBytes = (a: Uint8Array, b: Uint8Array): number => {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1
}

/**
 * Order two key values as DynamoDB does: by UTF-8 bytes. For text that is
 * code point order, which JS string comparison (UTF-16 code units) is not
 * above U+FFFF — so it is never used for keys.
 */
export const compareUtf8 = (a: KeyValue, b: KeyValue): number => {
  if (typeof a !== "string" || typeof b !== "string") {
    return compareBytes(
      typeof a === "string" ? encoder.encode(a) : a,
      typeof b === "string" ? encoder.encode(b) : b,
    )
  }
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    const x = a.codePointAt(i)!
    const y = b.codePointAt(j)!
    if (x !== y) return x < y ? -1 : 1
    i += x > 0xffff ? 2 : 1
    j += y > 0xffff ? 2 : 1
  }
  return i < a.length ? 1 : j < b.length ? -1 : 0
}

/**
 * The highest code point: above every character a key can hold but itself.
 * Where the text after a prefix is a value's own (no label precedes it),
 * `prefix + KEY_TOP` bounds every key under the prefix; {@link KEY_MAX} does
 * not, since an emoji (UTF-8 `F0 …`) outsorts it.
 */
export const KEY_TOP = String.fromCodePoint(0x10ffff)

/**
 * An inclusive high end for a strict `<` on key text: below `key`, and at or
 * above every key below `key` that does not hold U+10FFFF. Its last code
 * point is stepped down one (past the surrogates) and followed by U+10FFFF: a
 * key below `key` either stops short of it — a prefix, which the bound keeps —
 * or is smaller at some character, and from there sorts under the bound. A
 * last code point of U+0000 has no predecessor; `key` without it is then the
 * bound. (U+10FFFF rather than {@link KEY_MAX}, which an emoji outsorts.)
 */
export const keyJustBelow = (key: string): string => {
  const width = key.length > 1 && key.codePointAt(key.length - 2)! > 0xffff ? 2 : 1
  const head = key.slice(0, key.length - width)
  const last = key.codePointAt(key.length - width)
  if (last === undefined || last === 0) return head
  const previous = last - 1 >= 0xd800 && last - 1 <= 0xdfff ? 0xd7ff : last - 1
  return `${head}${String.fromCodePoint(previous)}${KEY_TOP}`
}

const startsWithKey = (value: KeyValue, prefix: KeyValue): boolean => {
  if (typeof value === "string" && typeof prefix === "string") return value.startsWith(prefix)
  const v = typeof value === "string" ? encoder.encode(value) : value
  const p = typeof prefix === "string" ? encoder.encode(prefix) : prefix
  return p.length <= v.length && compareBytes(v.subarray(0, p.length), p) === 0
}

/** Does `value` satisfy a sort key condition, as DynamoDB evaluates it? */
export const keyConditionHolds = (condition: KeyCondition, value: KeyValue): boolean => {
  if ("eq" in condition) return compareUtf8(value, condition.eq) === 0
  if ("lt" in condition) return compareUtf8(value, condition.lt) < 0
  if ("lte" in condition) return compareUtf8(value, condition.lte) <= 0
  if ("gt" in condition) return compareUtf8(value, condition.gt) > 0
  if ("gte" in condition) return compareUtf8(value, condition.gte) >= 0
  if ("between" in condition) {
    return (
      compareUtf8(value, condition.between[0]) >= 0 && compareUtf8(value, condition.between[1]) <= 0
    )
  }
  return startsWithKey(value, condition.beginsWith)
}

const isEmptyKey = (value: KeyValue): boolean => value.length === 0

/**
 * The key condition a read of `range` sends; `undefined` reads the whole
 * partition. A zero-length operand is a defect: DynamoDB rejects it, and no
 * plan should ever compose one.
 */
export const toKeyCondition = (range: KeyRange): KeyCondition | undefined => {
  const condition: KeyCondition | undefined =
    range.beginsWith !== undefined
      ? { beginsWith: range.beginsWith }
      : range.lower !== undefined && range.upper !== undefined
        ? compareUtf8(range.lower, range.upper) === 0
          ? { eq: range.lower }
          : { between: [range.lower, range.upper] }
        : range.lower !== undefined
          ? { gte: range.lower }
          : range.upper !== undefined
            ? { lte: range.upper }
            : undefined
  const operands =
    condition === undefined
      ? []
      : "between" in condition
        ? condition.between
        : [Object.values(condition)[0] as KeyValue]
  if (operands.some(isEmptyKey)) {
    throw new Error(
      "[internal] A planned key condition has a zero-length operand, which DynamoDB rejects.",
    )
  }
  return condition
}

/** Is `value` inside `range` (as its key condition selects)? */
export const rangeContains = (range: KeyRange, value: KeyValue): boolean => {
  const condition = toKeyCondition(range)
  return condition === undefined || keyConditionHolds(condition, value)
}

/** A key value as `explain` and `onRequest` show it: text as is, bytes as `0x…` hex. */
export const displayKeyValue = (value: KeyValue): string => {
  if (typeof value === "string") return value
  let hex = "0x"
  for (const byte of value) hex += byte.toString(16).padStart(2, "0")
  return hex
}

/**
 * The display bounds of a sort key condition: `eq` as `[v, v]`, `between` as
 * `[a, b]`, one-sided operators open on the other side, `begins_with` as
 * `[prefix, undefined]`, none as `[undefined, undefined]`.
 */
export const displayKeyCondition = (
  condition: KeyCondition | undefined,
): readonly [lower: string | undefined, upper: string | undefined] => {
  if (condition === undefined) return [undefined, undefined]
  const show = displayKeyValue
  if ("eq" in condition) return [show(condition.eq), show(condition.eq)]
  if ("between" in condition) return [show(condition.between[0]), show(condition.between[1])]
  if ("gt" in condition) return [show(condition.gt), undefined]
  if ("gte" in condition) return [show(condition.gte), undefined]
  if ("lt" in condition) return [undefined, show(condition.lt)]
  if ("lte" in condition) return [undefined, show(condition.lte)]
  return [show(condition.beginsWith), undefined]
}

// ---------------------------------------------------------------------------
// Fingerprint (§10.3)
// ---------------------------------------------------------------------------

/** JSON with every object's keys sorted, so equal inputs give equal text. */
export const canonicalJson = (value: unknown): string => {
  if (value instanceof Uint8Array) return JSON.stringify(displayKeyValue(value))
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`
  }
  if (typeof value === "bigint") return JSON.stringify(value.toString())
  return JSON.stringify(value) ?? "null"
}

/**
 * An expression as `explain` shows it: its compiled text with every name and
 * value placeholder replaced by what it stands for.
 */
export const displayExpr = (expr: Expr): string => {
  const compiled = compileExpr(expr)
  const shown = (value: AttributeValue): string =>
    value.S !== undefined
      ? JSON.stringify(value.S)
      : value.N !== undefined
        ? value.N
        : value.BOOL !== undefined
          ? String(value.BOOL)
          : JSON.stringify(value)
  return compiled.expression.replace(/[#:]e\d+/g, (placeholder) =>
    placeholder.startsWith("#")
      ? (compiled.names[placeholder] ?? placeholder)
      : compiled.values[placeholder] === undefined
        ? placeholder
        : shown(compiled.values[placeholder]!),
  )
}

/** FNV-1a (32-bit) of `text`'s UTF-8 bytes, as 8 hex digits. */
export const fnv1a32 = (text: string): string => {
  let hash = 0x811c9dc5
  for (const byte of encoder.encode(text)) {
    hash ^= byte
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, "0")
}

// ---------------------------------------------------------------------------
// Step helpers
// ---------------------------------------------------------------------------

/**
 * `[EDD-9094]`: a cursor that doesn't belong to the query it was given to —
 * malformed, from another query, or a position outside the recomputed plan.
 * Raised by the terminal (cursors are decoded there), never by `startFrom`.
 */
export const cursorRefusal = (entityType: string, why: string): ValidationError =>
  new ValidationError({
    entityType,
    operation: "query.startFrom",
    cause:
      `[EDD-9094] The cursor does not belong to this query: ${why}. A cursor resumes only ` +
      `the query that returned it — the same index, pinned composites, .within() bounds ` +
      `and direction.`,
  })

/**
 * `step` resumed after `startKey`: what a read that returned a
 * `LastEvaluatedKey`, or stopped inside its page, continues with. A filter
 * read's position drops its tuple — `ExclusiveStartKey` alone places it.
 */
export const readFrom = (step: ReadStep, startKey: Record<string, AttributeValue>): ReadStep => ({
  ...step,
  startKey,
  at: {
    ...step.at,
    tuple: step.at.mode === "filter" ? undefined : step.at.tuple,
    boundary: { _tag: "At", startKey },
  },
})

const done: DoneStep = { _tag: "Done" }

const estimator: Sizing = { _tag: "estimator" }

/** The cursor of a plan with this fingerprint at `step` (§10.1): its position, or `null` once done. */
const positionCursor = (fingerprint: string, step: Step): Cursor.CursorV2 | null => {
  if (step._tag === "Done") return null
  const at = step.at
  const boundary = at.boundary
  return {
    v: 2,
    f: fingerprint,
    s: at.mode,
    ...(at.tuple === undefined ? {} : { t: Cursor.keyValueToWire(at.tuple) }),
    ...(boundary._tag === "At"
      ? { k: Cursor.keyToWire(boundary.startKey) ?? {} }
      : boundary._tag === "Through"
        ? { a: Cursor.keyValueToWire(boundary.through) }
        : boundary._tag === "TupleDone"
          ? { d: 1 as const }
          : {}),
  }
}

/** A planned range as `explain` shows it. */
const shownRange = (range: KeyRange) => {
  const [lower, upper] = displayKeyCondition(toKeyCondition(range))
  return { lower, upper, exact: range.exact }
}

// ---------------------------------------------------------------------------
// Composite plans (§7)
// ---------------------------------------------------------------------------

/**
 * The composites a skip-scan walks: none (a `key` plan), or a `string` tuple —
 * the composites between the pinned prefix `P` and the first bounded
 * composite, parsed from the key text (§7.2). A Z-order prefix is walked by {@link zorderPlanner}.
 */
export type TupleSpace =
  | { readonly _tag: "none" }
  | {
      readonly _tag: "string"
      /** `P`: the key text every tuple extends; ends with the delimiter. */
      readonly prefix: string
      /** The tuple composites' labels (`<cased name>_`), in key order. */
      readonly labels: ReadonlyArray<string>
      /** The label of the first composite after the tuple. */
      readonly next: string
      /** The tuple composites' names (`explain`'s reason). */
      readonly fields: ReadonlyArray<string>
    }

/**
 * What is read inside each tuple (or the whole plan, without one): a single
 * range per tuple. (Z-order range plans: {@link zorderPlanner}.)
 */
export type InnerPlan = {
  readonly _tag: "single"
  /** The range under tuple `T` (`undefined`: the `key` plan's one range). */
  readonly conditionFor: (tuple: string | undefined) => KeyRange
  /** The bounds that range can't express: the same for every tuple. */
  readonly rowCheck: RowCheck | undefined
  /** No value satisfies the bounds (`{ gt: 3, lte: 3 }`): the plan is `empty`, and reads nothing. */
  readonly empty: boolean
}

/** A composite sort key plan, as the accessor's `.within()` builds it. */
export interface CompositePlanSpec {
  readonly entityType: string
  /** The physical index, or `"primary"`. */
  readonly index: string
  readonly pkField: string
  readonly pkValue: string
  readonly skField: string
  /** What must not change between calls: the pinned and composed bounds (§10.3). */
  readonly fingerprint: unknown
  readonly space: TupleSpace
  readonly inner: InnerPlan
  /** The filter plan: one range under `P`, every bound in the row check (§7.4). */
  readonly filterPlan: {
    /** `P`: the filter range runs from `P` to `P + MAX`. */
    readonly prefix: string
    readonly rowCheck: RowCheck | undefined
  }
  /** Why skip-scan isn't sound for this tuple (§7.3); the plan is then `filter`. */
  readonly ineligible: string | undefined
}

/**
 * A planner for a composite sort key plan. `start` places a cursor in the
 * recomputed plan (§10.3): string ranges are kept or dropped whole, never cut.
 */
export const compositePlanner =
  (spec: CompositePlanSpec): PlannerFactory =>
  ({ reverse, maxSkips }): RangePlanner => {
    const space = spec.space
    const fingerprint = fnv1a32(canonicalJson({ plan: spec.fingerprint, reverse }))
    const P = spec.filterPlan.prefix
    const UPPER = `${P}${KEY_MAX}`
    const tupled = space._tag === "string"
    const mode: PlanMode = spec.inner.empty
      ? "empty"
      : !tupled
        ? "key"
        : spec.ineligible !== undefined || maxSkips === 0
          ? "filter"
          : "skip-scan"
    const reason = spec.inner.empty
      ? "the bounds admit no value"
      : space._tag === "none"
        ? "leading composites bounded"
        : (spec.ineligible ??
          (maxSkips === 0 ? "maxSkips: 0" : `skip tuple: ${space.fields.join(", ")}`))

    const refuse = (why: string): ValidationError => cursorRefusal(spec.entityType, why)

    // -- tuples (§7.2) --

    const tupleOf = (key: string): string | undefined => {
      if (space._tag !== "string" || !key.startsWith(space.prefix)) return undefined
      let pos = space.prefix.length
      for (const label of space.labels) {
        if (!key.startsWith(label, pos)) return undefined
        const end = key.indexOf(KEY_DELIMITER, pos + label.length)
        if (end < 0) return undefined
        pos = end + 1
      }
      return key.startsWith(space.next, pos) ? key.slice(0, pos) : undefined
    }

    /** Just above every key under `tuple`: its delimiter (`#`) bumped to the next character. */
    const successor = (tuple: string): string =>
      `${tuple.slice(0, -1)}${String.fromCharCode(KEY_DELIMITER.charCodeAt(0) + 1)}`

    // -- steps --

    const read = (
      at: Position,
      range: KeyRange,
      startKey: Record<string, AttributeValue> | undefined,
      rowCheck: RowCheck | undefined,
    ): ReadStep => ({
      _tag: "Read",
      at: startKey === undefined ? at : { ...at, boundary: { _tag: "At", startKey } },
      range,
      startKey,
      planIndex: undefined,
      sizing: estimator,
      rowCheck,
    })

    const keyRead = (boundary: Boundary, startKey?: Record<string, AttributeValue>): ReadStep =>
      read(
        { mode: "key", tuple: undefined, boundary, skips: 0 },
        spec.inner.conditionFor(undefined),
        startKey,
        spec.inner.rowCheck,
      )

    const tupleRead = (
      tuple: string,
      boundary: Boundary,
      skips: number,
      startKey?: Record<string, AttributeValue>,
    ): ReadStep =>
      read(
        { mode: "skip-scan", tuple, boundary, skips },
        spec.inner.conditionFor(tuple),
        startKey,
        spec.inner.rowCheck,
      )

    /** The filter range from a position: past its finished tuple, or all of `P`. */
    const filterRange = (tuple: KeyValue | undefined): KeyRange => {
      const after = typeof tuple === "string" ? tuple : undefined
      return reverse
        ? { lower: P, upper: after ?? UPPER, exact: spec.filterPlan.rowCheck === undefined }
        : {
            lower: after === undefined ? P : successor(after),
            upper: UPPER,
            exact: spec.filterPlan.rowCheck === undefined,
          }
    }

    const filterRead = (from: Position, startKey?: Record<string, AttributeValue>): ReadStep =>
      read(
        { ...from, mode: "filter", tuple: startKey === undefined ? from.tuple : undefined },
        startKey === undefined ? filterRange(from.tuple) : filterRange(undefined),
        startKey,
        spec.filterPlan.rowCheck,
      )

    /** The next probe from `from` — or, once the budget is spent, the filter plan (§7.4). */
    const probeFrom = (from: Position): Step => {
      if (from.skips >= maxSkips) return filterRead(from)
      const tuple = typeof from.tuple === "string" ? from.tuple : undefined
      return {
        _tag: "Probe",
        at: { ...from, mode: "skip-scan", skips: from.skips + 1 },
        lower: reverse ? P : tuple === undefined ? P : successor(tuple),
        upper: reverse ? (tuple ?? UPPER) : UPPER,
      }
    }

    const fresh = (tuple: KeyValue | undefined, boundary: Boundary): Position => ({
      mode,
      tuple,
      boundary,
      skips: 0,
    })

    const initial = (): Step =>
      mode === "empty"
        ? done
        : mode === "key"
          ? keyRead({ _tag: "Start" })
          : mode === "filter"
            ? filterRead(fresh(undefined, { _tag: "Start" }))
            : probeFrom(fresh(undefined, { _tag: "Start" }))

    // -- resume (§10.3) --

    /** `k` as a start key, when it lies in `range` under this partition. */
    const startKeyIn = (
      key: Record<string, Cursor.WireValue>,
      range: KeyRange,
    ): Record<string, AttributeValue> | ValidationError => {
      const pk = key[spec.pkField]
      const sk = key[spec.skField]
      if (pk === undefined || !("S" in pk) || pk.S !== spec.pkValue) {
        return refuse("its key is in another partition")
      }
      const skValue = sk === undefined ? undefined : Cursor.wireToKeyValue(sk)
      if (skValue === undefined || !rangeContains(range, skValue)) {
        return refuse("its key is outside the recomputed plan")
      }
      return Cursor.keyFromWire(key)
    }

    /**
     * Where `through` leaves a string range: entirely before it (`dropped`),
     * entirely after it (`kept`), or across it, which no string plan's cursor
     * can be (§10.3).
     */
    const clip = (range: KeyRange, through: KeyValue): "kept" | "dropped" | "straddle" => {
      const p = range.beginsWith
      const before = (value: KeyValue) => compareUtf8(through, value) < 0
      const after = (value: KeyValue) => compareUtf8(through, value) > 0
      // Every key in the range is past `through` in scan direction?
      const allPast =
        p !== undefined
          ? reverse
            ? after(p) && !startsWithKey(through, p)
            : before(p)
          : reverse
            ? range.upper !== undefined && after(range.upper)
            : range.lower !== undefined && before(range.lower)
      if (allPast) return "kept"
      // …or none of them is?
      const nonePast =
        p !== undefined
          ? reverse
            ? !after(p)
            : after(p) && !startsWithKey(through, p)
          : reverse
            ? range.lower !== undefined && !after(range.lower)
            : range.upper !== undefined && !before(range.upper)
      return nonePast ? "dropped" : "straddle"
    }

    const start = (cursor: Cursor.CursorV2 | undefined): Step | ValidationError => {
      if (cursor === undefined) return initial()
      if (cursor.f === undefined) {
        // A legacy cursor, or a plain query's `{ k }`: a position inside a single range.
        if (mode !== "key") {
          return refuse(`it comes from a query without .within(), and this plan is ${mode}`)
        }
        if (cursor.k === undefined || cursor.s !== undefined || cursor.t !== undefined) {
          return refuse("it carries no position in this plan")
        }
        const startKey = startKeyIn(cursor.k, spec.inner.conditionFor(undefined))
        return startKey instanceof ValidationError
          ? startKey
          : keyRead({ _tag: "At", startKey }, startKey)
      }
      if (cursor.f !== fingerprint) return refuse("its plan fingerprint differs")
      // Nothing to resume: no cursor of an empty plan is ever handed out.
      if (mode === "empty") return done
      const s = cursor.s
      if (
        s === undefined ||
        !(s === "key"
          ? !tupled
          : s === "filter"
            ? tupled
            : s === "skip-scan" && tupled && spec.ineligible === undefined)
      ) {
        return refuse(`its plan (${s ?? "none"}) can't continue as ${mode}`)
      }
      let tuple: string | undefined
      if (cursor.t !== undefined) {
        const t = "S" in cursor.t ? cursor.t.S : undefined
        if (t === undefined || space._tag !== "string" || tupleOf(`${t}${space.next}`) !== t) {
          return refuse("its skip tuple is not one of this plan's")
        }
        tuple = t
      }
      const position = (boundary: Boundary): Position => ({
        mode: s,
        tuple,
        boundary,
        skips: 0,
      })
      if (cursor.k !== undefined) {
        if (s === "filter") {
          if (tuple !== undefined) return refuse("a filter position inside a tuple")
          const startKey = startKeyIn(cursor.k, filterRange(undefined))
          return startKey instanceof ValidationError
            ? startKey
            : filterRead(position({ _tag: "At", startKey }), startKey)
        }
        if (s === "skip-scan" && tuple === undefined) return refuse("a key outside any tuple")
        const range = spec.inner.conditionFor(tuple)
        const startKey = startKeyIn(cursor.k, range)
        if (startKey instanceof ValidationError) return startKey
        return s === "key"
          ? keyRead({ _tag: "At", startKey }, startKey)
          : tupleRead(tuple!, { _tag: "At", startKey }, 0, startKey)
      }
      if (cursor.a !== undefined) {
        const through = Cursor.wireToKeyValue(cursor.a)
        if (through === undefined || s === "filter" || (s === "skip-scan" && tuple === undefined)) {
          return refuse("its 'through' position is not one of this plan's")
        }
        const clipped = clip(spec.inner.conditionFor(tuple), through)
        if (clipped === "straddle") return refuse("its position cuts a range of this plan")
        const boundary: Boundary = { _tag: "Through", through }
        if (s === "key") return clipped === "kept" ? keyRead(boundary) : done
        return clipped === "kept"
          ? tupleRead(tuple!, boundary, 0)
          : probeFrom(position({ _tag: "TupleDone" }))
      }
      if (cursor.d !== undefined) {
        if (tuple === undefined) return refuse("a finished tuple without the tuple")
        return s === "filter"
          ? filterRead(position({ _tag: "TupleDone" }))
          : probeFrom(position({ _tag: "TupleDone" }))
      }
      // Start: of tuple `t`, or of the plan.
      if (tuple !== undefined) {
        return s === "skip-scan"
          ? tupleRead(tuple, { _tag: "Start" }, 0)
          : refuse("a filter position at the start of a tuple")
      }
      return s === "key"
        ? keyRead({ _tag: "Start" })
        : s === "filter"
          ? filterRead(position({ _tag: "Start" }))
          : probeFrom(position({ _tag: "Start" }))
    }

    // -- transitions --

    const afterRead = (
      step: ReadStep,
      lastEvaluatedKey: Record<string, AttributeValue> | undefined,
    ): Step => {
      if (lastEvaluatedKey !== undefined) return readFrom(step, lastEvaluatedKey)
      return step.at.mode === "skip-scan"
        ? probeFrom({ ...step.at, boundary: { _tag: "TupleDone" } })
        : done
    }

    const afterProbe = (step: ProbeStep, key: KeyValue | undefined): Step => {
      if (key === undefined) return done
      const tuple = typeof key === "string" ? tupleOf(key) : undefined
      const previous = typeof step.at.tuple === "string" ? step.at.tuple : undefined
      // A key the parse can't read — or, defensively, a tuple that doesn't
      // advance — leaves the rest to the filter plan, from where the probe began.
      if (
        tuple === undefined ||
        (previous !== undefined &&
          (reverse ? compareUtf8(tuple, previous) >= 0 : compareUtf8(tuple, previous) <= 0))
      ) {
        return filterRead(step.at)
      }
      return tupleRead(tuple, { _tag: "Start" }, step.at.skips)
    }

    // -- cursors and explain --

    const cursor = (step: Step): Cursor.CursorV2 | null => positionCursor(fingerprint, step)

    const rowCheck = mode === "filter" ? spec.filterPlan.rowCheck : spec.inner.rowCheck

    const explain = (sizing: QueryExplain["sizing"]): QueryExplain => ({
      index: spec.index,
      plan: mode,
      reason,
      // The ranges known before anything is read: the key plan's one range,
      // or the span the probes (or the filter read) walk.
      keyConditions:
        mode === "empty"
          ? []
          : mode === "key"
            ? [shownRange(spec.inner.conditionFor(undefined))]
            : [{ lower: P, upper: UPPER, exact: false }],
      filter: undefined,
      rowChecks: rowCheck?.fields ?? [],
      sizing,
      ...(mode === "skip-scan" ? { maxSkips } : {}),
    })

    return {
      fingerprint,
      mode,
      filter: undefined,
      rowCheck,
      start,
      afterRead,
      afterProbe,
      following: () => [],
      cursor,
      explain,
    }
  }

// ---------------------------------------------------------------------------
// Z-order plans (§5, §7.5)
// ---------------------------------------------------------------------------

/** A prefix composite of a binary skip tuple (§7.5). */
export interface BinarySegment {
  readonly field: string
  /** Hash width in bytes; `undefined`: stored length-prefixed. */
  readonly hash: number | undefined
  /** The encoded segment `.within()` gave it, if any. */
  readonly given: Uint8Array | undefined
}

/** A Z-order sort key plan, as the accessor's `.within()` builds it. */
export interface ZOrderPlanSpec {
  readonly entityType: string
  readonly index: string
  readonly pkField: string
  readonly pkValue: string
  readonly skField: string
  /** What must not change between calls: the prefix values, the box and the layout (§10.3). */
  readonly fingerprint: unknown
  readonly layout: Layout
  /** The quantized box (§5.1); `"empty"` when nothing can match. */
  readonly box: Box | "empty"
  /** Whether any dimension is bounded: without one, each tuple is read whole. */
  readonly bounded: boolean
  /** `P`: the given leading prefix segments (possibly none). */
  readonly prefix: Uint8Array
  /** The skip tuple: the prefix segments from the first one not given through the last. */
  readonly tuple: ReadonlyArray<BinarySegment>
  /** The exact dimension bounds DynamoDB can compare on the stored attributes (§11). */
  readonly filter: Expr | undefined
  /** The bounds checked per row inside a tuple: dimensions no filter compares, hashed prefixes. */
  readonly rowCheck: RowCheck | undefined
  /** The filter plan's row check: every given prefix composite as well (§7.4). */
  readonly filterRowCheck: RowCheck | undefined
  /** The capped range plan of the box (§5.4), cached per accessor. */
  readonly ranges: (
    maxRanges: number,
    refineFactor: number,
  ) => { readonly ranges: ReadonlyArray<AddressRange>; readonly exact: boolean }
}

/** What each tuple reads: nothing, all of it (`key`), or a §5.5 strategy. */
type Strategy = "empty" | "key" | "naive" | "jump" | "precise"

/** `bytes`, unless empty: DynamoDB rejects a zero-length key operand (`EmptyKeyBound`). */
const nonEmpty = (bytes: Uint8Array | undefined): Uint8Array | undefined =>
  bytes === undefined || bytes.length === 0 ? undefined : bytes

const startsWithBytes = (value: Uint8Array, prefix: Uint8Array): boolean =>
  prefix.length <= value.length && compareBytes(value.subarray(0, prefix.length), prefix) === 0

/**
 * A planner for a Z-order sort key plan. Inside each tuple `T` (the given
 * prefix, or each one a binary skip-scan finds), a range `[lo, hi]` of
 * addresses is read as `BETWEEN T‖lo AND T‖hi`; the strategy decides which
 * ranges (§5.5). `start` places a cursor by clipping the recomputed plan at
 * its address (§10.3), so a cursor resumes under any `maxRanges` or
 * strategy.
 */
export const zorderPlanner =
  (spec: ZOrderPlanSpec): PlannerFactory =>
  ({ reverse, maxSkips, zorder }): RangePlanner => {
    const { layout, box } = spec
    const W = layout.bytes
    const MAXZ = (1n << BigInt(layout.bits)) - 1n
    const P = spec.prefix
    const succP = succ(P)
    const tupled = spec.tuple.length > 0
    const maxRanges = zorder?.maxRanges ?? DEFAULT_MAX_RANGES
    const fingerprint = fnv1a32(canonicalJson({ plan: spec.fingerprint, reverse }))
    const refuse = (why: string): ValidationError => cursorRefusal(spec.entityType, why)

    // -- the strategy (§5.6) --

    const [strategy, why]: readonly [Strategy, string] =
      box === "empty"
        ? ["empty", "empty box"]
        : !spec.bounded
          ? ["key", "no dimension bounded"]
          : zorder?.strategy !== undefined && zorder.strategy !== "auto"
            ? [zorder.strategy, "explicit strategy"]
            : spec.ranges(maxRanges, 1).exact
              ? ["precise", "exact plan fits maxRanges"]
              : ["jump", "exact plan over maxRanges"]
    const mode: PlanMode =
      strategy === "empty" ? "empty" : !tupled ? strategy : maxSkips === 0 ? "filter" : "skip-scan"
    const reason =
      !tupled || strategy === "empty"
        ? why
        : maxSkips === 0
          ? "maxSkips: 0"
          : `skip tuple: ${spec.tuple.map((segment) => segment.field).join(", ")}; ${strategy} ` +
            `inside each tuple (${why})`
    /** The mode a read inside a tuple (or the whole plan) records. */
    const readMode: PlanMode = tupled ? "skip-scan" : strategy

    // -- addresses (§5.2, §5.3) --

    const full = box === "empty" ? undefined : box
    const { zmin, zmax } = full === undefined ? { zmin: 0n, zmax: 0n } : corners(layout, full)
    const single = full?.every((intervals) => intervals.length === 1) === true
    const contains = (z: bigint): boolean => full !== undefined && inBox(layout, full, z)
    /** The first in-box address at or after `z`. */
    const nextIn = (z: bigint): bigint | undefined => {
      if (full === undefined || z > zmax) return undefined
      if (z <= zmin) return zmin
      return single ? bigmin(layout, z, zmin, zmax) : nextInBox(layout, full, z)
    }
    /** The last in-box address at or before `z`. */
    const prevIn = (z: bigint): bigint | undefined => {
      if (full === undefined || z < zmin) return undefined
      if (z >= zmax) return zmax
      return single ? litmax(layout, z, zmin, zmax) : prevInBox(layout, full, z)
    }

    /** The ranges each tuple reads, in scan direction (`jump`: its first). */
    const planned: ReadonlyArray<AddressRange> =
      full === undefined
        ? []
        : strategy === "key"
          ? [{ lo: 0n, hi: MAXZ, exact: true }]
          : strategy === "precise"
            ? spec.ranges(maxRanges, REFINE_FACTOR).ranges
            : [{ lo: zmin, hi: zmax, exact: false }]
    const ordered = reverse ? [...planned].reverse() : planned
    /** Where a range ends, in scan direction. */
    const end = (r: AddressRange): bigint => (reverse ? r.lo : r.hi)

    /** `[lo, hi]` under `T`: a whole subtree as `begins_with T` (no condition when `T` is empty). */
    const keyRange = (T: Uint8Array, r: AddressRange): KeyRange =>
      r.lo === 0n && r.hi === MAXZ
        ? {
            lower: undefined,
            upper: undefined,
            ...(T.length > 0 ? { beginsWith: T } : {}),
            exact: r.exact,
          }
        : {
            lower: concatBytes([T, toBytes(r.lo, W)]),
            upper: concatBytes([T, toBytes(r.hi, W)]),
            exact: r.exact,
          }
    const tupleOf = (at: Position): Uint8Array => (at.tuple instanceof Uint8Array ? at.tuple : P)
    /** The address of a sort key under `T`, or `undefined` when it isn't one. */
    const addressOf = (T: Uint8Array, key: KeyValue | undefined): bigint | undefined =>
      key instanceof Uint8Array && key.length === T.length + W && startsWithBytes(key, T)
        ? fromBytes(key.subarray(T.length))
        : undefined
    /** The addresses a read covers. */
    const spanOf = (step: ReadStep): AddressRange => {
      const T = tupleOf(step.at)
      return {
        lo: addressOf(T, step.range.lower) ?? 0n,
        hi: addressOf(T, step.range.upper) ?? MAXZ,
        exact: step.range.exact,
      }
    }

    // -- steps --

    const position = (
      tuple: Uint8Array | undefined,
      boundary: Boundary,
      skips: number,
    ): Position => ({ mode: readMode, tuple, boundary, skips })

    const read = (
      at: Position,
      T: Uint8Array,
      r: AddressRange,
      planIndex: number | undefined,
      startKey: Record<string, AttributeValue> | undefined,
      run: number = JUMP_INITIAL,
    ): ReadStep => ({
      _tag: "Read",
      at: startKey === undefined ? at : { ...at, boundary: { _tag: "At", startKey } },
      range: keyRange(T, r),
      startKey,
      planIndex,
      sizing: strategy === "jump" ? { _tag: "jump", run } : estimator,
      rowCheck: spec.rowCheck,
    })

    /** Everything up to address `z` of tuple `T` is done. */
    const through = (T: Uint8Array, z: bigint): Boundary => ({
      _tag: "Through",
      through: concatBytes([T, toBytes(z, W)]),
    })

    /** Tuple `at` is finished: the next probe, or the end of the plan. */
    const tupleDone = (at: Position): Step =>
      tupled ? probeFrom({ ...at, boundary: { _tag: "TupleDone" } }) : done

    /** The first read of tuple `T` (or of the plan, `tuple` absent). */
    const firstRead = (T: Uint8Array, tuple: Uint8Array | undefined, skips: number): Step => {
      const at = position(tuple, { _tag: "Start" }, skips)
      const first = ordered[0]
      return first === undefined
        ? tupleDone(at)
        : read(at, T, first, strategy === "precise" ? 0 : undefined, undefined)
    }

    /** The filter range from a position: past its finished tuple, or all of `P` (§7.4). */
    const filterRange = (tuple: Uint8Array | undefined): KeyRange | undefined => {
      const exact = !spec.bounded && spec.filterRowCheck === undefined
      if (reverse) return { lower: nonEmpty(P), upper: tuple ?? succP, exact }
      if (tuple === undefined) return { lower: nonEmpty(P), upper: succP, exact }
      const lower = succ(tuple)
      return lower === undefined ? undefined : { lower, upper: succP, exact }
    }

    const filterRead = (from: Position, startKey?: Record<string, AttributeValue>): Step => {
      const tuple =
        startKey === undefined && from.tuple instanceof Uint8Array ? from.tuple : undefined
      const range = filterRange(tuple)
      if (range === undefined) return done
      return {
        _tag: "Read",
        at: {
          ...from,
          mode: "filter",
          tuple,
          boundary: startKey === undefined ? from.boundary : { _tag: "At", startKey },
        },
        range,
        startKey,
        planIndex: undefined,
        sizing: estimator,
        rowCheck: spec.filterRowCheck,
      }
    }

    // -- the binary skip-scan (§7.5) --

    /** A probe from `at` (lower and upper inclusive; never a zero-length operand). */
    const probe = (
      at: Position,
      lower: Uint8Array | undefined,
      upper: Uint8Array | undefined,
    ): ProbeStep => ({
      _tag: "Probe",
      at: { ...at, mode: "skip-scan", skips: at.skips + 1 },
      lower: nonEmpty(lower),
      upper: nonEmpty(upper),
    })

    /**
     * The next probe from `from` — or, once the budget is spent, the filter
     * plan (§7.4). No stored key equals `succ(P)` or a tuple `T` (each is
     * followed by at least the address), so the inclusive bounds read as the
     * exclusive ones of §7.5.
     */
    const probeFrom = (from: Position): Step => {
      if (from.skips >= maxSkips) return filterRead(from)
      const T = from.tuple instanceof Uint8Array ? from.tuple : undefined
      if (reverse) return probe(from, P, T ?? succP)
      if (T === undefined) return probe(from, P, succP)
      const lower = succ(T)
      return lower === undefined ? done : probe(from, lower, succP)
    }

    type Parsed =
      | { readonly _tag: "tuple"; readonly tuple: Uint8Array }
      | { readonly _tag: "move"; readonly to: Uint8Array | undefined }

    /**
     * A probed key's skip tuple (§7.5): every prefix segment after `P`, each
     * given one compared with its value in the (length, bytes) order keys sort
     * in. A given segment below its value SEEKs to it; one above SKIPs past
     * the missing segments before it (mirrored in reverse: `to` is then the
     * next probe's upper bound). `undefined` for a key the parse can't read.
     */
    const parse = (key: Uint8Array): Parsed | undefined => {
      if (!startsWithBytes(key, P)) return undefined
      let pos = P.length
      let missingEnd = P.length
      for (const segment of spec.tuple) {
        const start = pos
        const stop =
          segment.hash !== undefined
            ? start + segment.hash
            : start + 2 > key.length
              ? -1
              : start + 2 + ((key[start]! << 8) | key[start + 1]!)
        if (stop < 0 || stop > key.length) return undefined
        if (segment.given === undefined) {
          missingEnd = stop
        } else {
          const order = compareBytes(key.subarray(start, stop), segment.given)
          if (order !== 0) {
            const seek = concatBytes([key.subarray(0, start), segment.given])
            const missing = key.slice(0, missingEnd)
            return reverse
              ? { _tag: "move", to: order > 0 ? (succ(seek) ?? succP) : missing }
              : { _tag: "move", to: order < 0 ? seek : succ(missing) }
          }
        }
        pos = stop
      }
      return key.length - pos === W ? { _tag: "tuple", tuple: key.slice(0, pos) } : undefined
    }

    const initial = (): Step => {
      const fresh = position(undefined, { _tag: "Start" }, 0)
      return mode === "empty"
        ? done
        : mode === "filter"
          ? filterRead(fresh)
          : tupled
            ? probeFrom(fresh)
            : firstRead(P, undefined, 0)
    }

    // -- resume (§10.3) --

    /** Everything up to address `a` (in scan direction) is done: clip the plan there. */
    const resumeThrough = (tuple: Uint8Array | undefined, sk: Uint8Array, a: bigint): Step => {
      const T = tuple ?? P
      const at = position(tuple, { _tag: "Through", through: sk }, 0)
      if (strategy === "jump") {
        const n = reverse
          ? a === 0n
            ? undefined
            : prevIn(a - 1n)
          : a === MAXZ
            ? undefined
            : nextIn(a + 1n)
        if (n === undefined) return tupleDone(at)
        return read(
          at,
          T,
          reverse ? { lo: zmin, hi: n, exact: false } : { lo: n, hi: zmax, exact: false },
          undefined,
          undefined,
        )
      }
      for (let i = 0; i < ordered.length; i++) {
        const r = ordered[i]!
        if (reverse ? r.lo < a : r.hi > a) {
          const clipped = reverse
            ? { lo: r.lo, hi: r.hi < a ? r.hi : a - 1n, exact: r.exact }
            : { lo: r.lo > a ? r.lo : a + 1n, hi: r.hi, exact: r.exact }
          return read(at, T, clipped, strategy === "precise" ? i : undefined, undefined)
        }
      }
      return tupleDone(at)
    }

    /** `k` as a start key: in this partition, its sort key an address under `T`. */
    const placeKey = (
      key: Record<string, Cursor.WireValue>,
      T: Uint8Array,
    ):
      | {
          readonly startKey: Record<string, AttributeValue>
          readonly sk: Uint8Array
          readonly address: bigint
        }
      | ValidationError => {
      const pk = key[spec.pkField]
      if (pk === undefined || !("S" in pk) || pk.S !== spec.pkValue) {
        return refuse("its key is in another partition")
      }
      const wire = key[spec.skField]
      const sk = wire === undefined ? undefined : Cursor.wireToKeyValue(wire)
      const address = addressOf(T, sk)
      if (address === undefined || !(sk instanceof Uint8Array)) {
        return refuse("its key is outside the recomputed plan")
      }
      return { startKey: Cursor.keyFromWire(key), sk, address }
    }

    /**
     * Resume inside the range holding `k`'s address, clipped to start there.
     * An address no range holds is out of the box — the rows at it were never
     * results — so the position reads as everything up to it being done.
     */
    const resumeAt = (
      tuple: Uint8Array | undefined,
      key: Record<string, Cursor.WireValue>,
    ): Step | ValidationError => {
      const T = tuple ?? P
      const placed = placeKey(key, T)
      if (placed instanceof ValidationError) return placed
      const { startKey, sk, address: a } = placed
      const at = position(tuple, { _tag: "At", startKey }, 0)
      if (strategy === "jump") {
        if (!contains(a)) return resumeThrough(tuple, sk, a)
        return read(
          at,
          T,
          reverse ? { lo: zmin, hi: a, exact: false } : { lo: a, hi: zmax, exact: false },
          undefined,
          startKey,
        )
      }
      const i = ordered.findIndex((r) => r.lo <= a && a <= r.hi)
      if (i < 0) return resumeThrough(tuple, sk, a)
      const r = ordered[i]!
      return read(
        at,
        T,
        reverse ? { lo: r.lo, hi: a, exact: r.exact } : { lo: a, hi: r.hi, exact: r.exact },
        strategy === "precise" ? i : undefined,
        startKey,
      )
    }

    const start = (cursor: Cursor.CursorV2 | undefined): Step | ValidationError => {
      if (cursor?.f !== undefined && cursor.f !== fingerprint) {
        return refuse("its plan fingerprint differs")
      }
      if (cursor === undefined) return initial()
      if (strategy === "empty") {
        return cursor.f === undefined
          ? refuse("it comes from a query without .within(), and this plan is empty")
          : done
      }
      if (cursor.f === undefined) {
        // A legacy cursor, or a plain query's `{ k }`: a position in a single-range plan.
        if (tupled || !(strategy === "key" || strategy === "naive")) {
          return refuse(`it comes from a query without .within(), and this plan is ${mode}`)
        }
        if (cursor.k === undefined || cursor.s !== undefined || cursor.t !== undefined) {
          return refuse("it carries no position in this plan")
        }
        return resumeAt(undefined, cursor.k)
      }
      // Any strategy continues any other: positions are addresses, never ranges.
      const s = cursor.s
      const fits =
        s !== undefined &&
        (tupled
          ? s === "skip-scan" || s === "filter"
          : s === "key" || s === "naive" || s === "jump" || s === "precise")
      if (!fits) return refuse(`its plan (${s ?? "none"}) can't continue as ${mode}`)
      let tuple: Uint8Array | undefined
      if (cursor.t !== undefined) {
        const t = Cursor.wireToKeyValue(cursor.t)
        const parsed =
          tupled && t instanceof Uint8Array ? parse(concatBytes([t, new Uint8Array(W)])) : undefined
        if (
          parsed?._tag !== "tuple" ||
          !(t instanceof Uint8Array) ||
          compareBytes(parsed.tuple, t) !== 0
        ) {
          return refuse("its skip tuple is not one of this plan's")
        }
        tuple = t
      }
      const at = (boundary: Boundary): Position => ({ mode: s, tuple, boundary, skips: 0 })
      if (cursor.k !== undefined) {
        if (s === "filter") {
          if (tuple !== undefined) return refuse("a filter position inside a tuple")
          const pk = cursor.k[spec.pkField]
          const wire = cursor.k[spec.skField]
          const sk = wire === undefined ? undefined : Cursor.wireToKeyValue(wire)
          if (pk === undefined || !("S" in pk) || pk.S !== spec.pkValue) {
            return refuse("its key is in another partition")
          }
          const range = filterRange(undefined)
          if (!(sk instanceof Uint8Array) || range === undefined || !rangeContains(range, sk)) {
            return refuse("its key is outside the recomputed plan")
          }
          const startKey = Cursor.keyFromWire(cursor.k)
          return filterRead(at({ _tag: "At", startKey }), startKey)
        }
        if (tupled && tuple === undefined) return refuse("a key outside any tuple")
        return resumeAt(tuple, cursor.k)
      }
      if (cursor.a !== undefined) {
        const sk = Cursor.wireToKeyValue(cursor.a)
        const a = addressOf(tuple ?? P, sk)
        if (
          a === undefined ||
          !(sk instanceof Uint8Array) ||
          s === "filter" ||
          (tupled && tuple === undefined)
        ) {
          return refuse("its 'through' position is not one of this plan's")
        }
        return resumeThrough(tuple, sk, a)
      }
      if (cursor.d !== undefined) {
        if (tuple === undefined) return refuse("a finished tuple without the tuple")
        return s === "filter"
          ? filterRead(at({ _tag: "TupleDone" }))
          : probeFrom(at({ _tag: "TupleDone" }))
      }
      // Start: of tuple `t`, or of the plan.
      if (tuple !== undefined) {
        return s === "skip-scan"
          ? firstRead(tuple, tuple, 0)
          : refuse("a filter position at the start of a tuple")
      }
      return s === "filter"
        ? filterRead(at({ _tag: "Start" }))
        : tupled
          ? probeFrom(at({ _tag: "Start" }))
          : initial()
    }

    // -- transitions --

    const afterRead = (
      step: ReadStep,
      lastEvaluatedKey: Record<string, AttributeValue> | undefined,
    ): Step => {
      if (step.at.mode === "filter") {
        return lastEvaluatedKey === undefined ? done : readFrom(step, lastEvaluatedKey)
      }
      const T = tupleOf(step.at)
      if (lastEvaluatedKey !== undefined) {
        if (step.sizing._tag !== "jump") return readFrom(step, lastEvaluatedKey)
        // `jump` (§5.5): the last row examined — not the last returned, which
        // the filter may have dropped — decides whether the run goes on.
        const run = step.sizing.run
        const sk = lastEvaluatedKey[spec.skField]?.B
        const a = addressOf(T, sk)
        if (a === undefined || contains(a)) {
          // In the box: rows may follow at the same address. The next page doubles (§8.5).
          return {
            ...readFrom(step, lastEvaluatedKey),
            sizing: { _tag: "jump", run: Math.min(run * 2, JUMP_MAX_LIMIT) },
          }
        }
        // Out of the box: a new key condition from the next in-box address —
        // never a fabricated start key (a GSI start key needs the table key).
        const span = spanOf(step)
        const n = reverse ? (a === 0n ? undefined : prevIn(a - 1n)) : nextIn(a + 1n)
        if (n === undefined || (reverse ? n < span.lo : n > span.hi)) return tupleDone(step.at)
        return read(
          { ...step.at, boundary: { _tag: "Through", through: sk! } },
          T,
          reverse ? { lo: span.lo, hi: n, exact: false } : { lo: n, hi: span.hi, exact: false },
          undefined,
          undefined,
        )
      }
      // The range is finished: the next planned one, or the tuple is.
      const i = step.planIndex
      if (i !== undefined && i + 1 < ordered.length) {
        return read(
          { ...step.at, boundary: through(T, end(spanOf(step))) },
          T,
          ordered[i + 1]!,
          i + 1,
          undefined,
        )
      }
      return tupleDone(step.at)
    }

    const afterProbe = (step: ProbeStep, key: KeyValue | undefined): Step => {
      if (key === undefined) return done
      const parsed = key instanceof Uint8Array ? parse(key) : undefined
      // A key the parse can't read leaves the rest to the filter plan.
      if (parsed === undefined) return filterRead(step.at)
      if (parsed._tag === "tuple") {
        const previous = step.at.tuple instanceof Uint8Array ? step.at.tuple : undefined
        const order = previous === undefined ? undefined : compareBytes(parsed.tuple, previous)
        // Defensively: a tuple that doesn't advance.
        if (order !== undefined && (reverse ? order >= 0 : order <= 0)) {
          return filterRead(step.at)
        }
        return firstRead(parsed.tuple, parsed.tuple, step.at.skips)
      }
      // SEEK / SKIP: probe again from where the given segment says.
      const to = parsed.to
      if (to === undefined) return reverse ? filterRead(step.at) : done
      const from = reverse ? step.upper : step.lower
      const advances =
        from === undefined || (reverse ? compareUtf8(to, from) < 0 : compareUtf8(to, from) > 0)
      if (!advances || step.at.skips >= maxSkips) return filterRead(step.at)
      return reverse ? probe(step.at, P, to) : probe(step.at, to, succP)
    }

    /** The precise ranges after `step` in its tuple, not started (§9.2). */
    const following = (step: ReadStep, n: number): ReadonlyArray<ReadStep> => {
      const i = step.planIndex
      if (i === undefined || step.at.mode === "filter" || n <= 0) return []
      const T = tupleOf(step.at)
      const out: Array<ReadStep> = []
      let previous = spanOf(step)
      for (let j = i + 1; j < ordered.length && out.length < n; j++) {
        const r = ordered[j]!
        out.push(read({ ...step.at, boundary: through(T, end(previous)) }, T, r, j, undefined))
        previous = r
      }
      return out
    }

    // -- cursors and explain --

    const rowCheck = mode === "filter" ? spec.filterRowCheck : spec.rowCheck

    const explain = (sizing: QueryExplain["sizing"]): QueryExplain => {
      const exactPlan = full === undefined ? undefined : spec.ranges(maxRanges, 1)
      const volume =
        full === undefined
          ? 0n
          : full.reduce(
              (product, intervals) =>
                product * intervals.reduce((n, [lo, hi]) => n + (hi - lo + 1n), 0n),
              1n,
            )
      return {
        index: spec.index,
        plan: mode,
        reason,
        // The ranges known before anything is read: each tuple's plan, or —
        // with a skip tuple — the span the probes (or the filter read) walk.
        keyConditions:
          mode === "empty"
            ? []
            : tupled
              ? [shownRange({ ...filterRange(undefined)!, exact: false })]
              : ordered.map((r) => shownRange(keyRange(P, r))),
        filter: spec.filter === undefined ? undefined : displayExpr(spec.filter),
        rowChecks: rowCheck?.fields ?? [],
        sizing,
        zorder: {
          bits: layout.bits,
          box: layout.dimensions.map((dimension, i) => ({
            field: dimension.field,
            bits: dimension.bits,
            levels:
              full === undefined
                ? []
                : full[i]!.map(([lo, hi]) => [lo.toString(), hi.toString()] as const),
          })),
          fill: full === undefined ? 0 : Number(volume) / Number(zmax - zmin + 1n),
          exactRanges:
            exactPlan === undefined ? 0 : exactPlan.exact ? exactPlan.ranges.length : "over-cap",
        },
        ...(mode === "skip-scan" ? { maxSkips } : {}),
      }
    }

    return {
      fingerprint,
      mode,
      filter: spec.filter,
      rowCheck,
      start,
      afterRead,
      afterProbe,
      following,
      cursor: (step) => positionCursor(fingerprint, step),
      explain,
    }
  }
