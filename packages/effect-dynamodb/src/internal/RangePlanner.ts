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
 * Positions are what a cursor records (§10): what has been **completed**, never
 * a range to trust. Resume recomputes the plan and places the position in it.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { KEY_DELIMITER } from "@effect-dynamodb/schema/DynamoSchema.js"
import { ValidationError } from "@effect-dynamodb/schema/Errors.js"
import type { KeyCondition, KeyValue, PlanMode, QueryExplain } from "../Query.js"
import * as Cursor from "./Cursor.js"
import type { Expr } from "./Expr.js"

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

// ---------------------------------------------------------------------------
// Key values: order, display, conditions
// ---------------------------------------------------------------------------

/**
 * `SK_MAX_SENTINEL` (`DynamoClient.ts`): above every character key
 * composition emits, so `prefix + MAX` bounds every key under `prefix`.
 */
export const KEY_MAX = "￿"

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

// ---------------------------------------------------------------------------
// Composite plans (§7)
// ---------------------------------------------------------------------------

/**
 * The composites a skip-scan walks: none (a `key` plan), or a `string` tuple —
 * the composites between the pinned prefix `P` and the first bounded
 * composite, parsed from the key text (§7.2). (Z-order adds a `binary` space.)
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
 * range per tuple. (Z-order adds its range plans.)
 */
export type InnerPlan = {
  readonly _tag: "single"
  /** The range under tuple `T` (`undefined`: the `key` plan's one range). */
  readonly conditionFor: (tuple: string | undefined) => KeyRange
  /** The bounds that range can't express: the same for every tuple. */
  readonly rowCheck: RowCheck | undefined
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
    const mode: PlanMode = !tupled
      ? "key"
      : spec.ineligible !== undefined || maxSkips === 0
        ? "filter"
        : "skip-scan"
    const reason =
      space._tag === "none"
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
      mode === "key"
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

    const cursor = (step: Step): Cursor.CursorV2 | null => {
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

    const shown = (range: KeyRange) => {
      const [lower, upper] = displayKeyCondition(toKeyCondition(range))
      return { lower, upper, exact: range.exact }
    }

    const rowCheck = mode === "filter" ? spec.filterPlan.rowCheck : spec.inner.rowCheck

    const explain = (sizing: QueryExplain["sizing"]): QueryExplain => ({
      index: spec.index,
      plan: mode,
      reason,
      // The ranges known before anything is read: the key plan's one range,
      // or the span the probes (or the filter read) walk.
      keyConditions:
        mode === "key"
          ? [shown(spec.inner.conditionFor(undefined))]
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
