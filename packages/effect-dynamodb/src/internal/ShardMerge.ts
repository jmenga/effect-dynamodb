/**
 * @internal The k-way merge of a sharded index's partitions (#183,
 * `docs/designs/gsi-write-sharding.md` §6). Pure: `Query.ts` sends the requests
 * and hands each page here; this says what is proven in order.
 *
 * A row is emitted only when every unfinished partition has a buffered row to
 * compare it with, which is what makes the order correct and holds at most one
 * page per partition. The state is plain data, so a stream of it can be re-run.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { compareUtf8 } from "./RangePlanner.js"

export type Row = Record<string, AttributeValue>

/**
 * Where a partition stands: the next read resumes from it, and a cursor records
 * it. `After` is the last row consumed from a page still buffered; `At` is the
 * `LastEvaluatedKey` of a page fully consumed, or a resumed cursor's key.
 */
export type Boundary =
  | { readonly _tag: "Start" }
  | { readonly _tag: "Done" }
  | { readonly _tag: "At"; readonly key: Row }
  | { readonly _tag: "After"; readonly row: Row }

/** One partition: its boundary, and the page being consumed. */
export interface Partition {
  readonly boundary: Boundary
  readonly rows: ReadonlyArray<Row>
  /** The first buffered row not consumed. */
  readonly next: number
  /** The `LastEvaluatedKey` of the buffered page. */
  readonly lastKey: Row | undefined
}

export type MergeState = ReadonlyArray<Partition>

export interface MergeOrder {
  /** The attribute the partitions are sorted by: the index's sort key. */
  readonly skField: string
  readonly reverse: boolean
}

const START: Boundary = { _tag: "Start" }
const DONE: Boundary = { _tag: "Done" }

const after = (lastKey: Row | undefined): Boundary =>
  lastKey === undefined ? DONE : { _tag: "At", key: lastKey }

/** The merge at its start: each partition at a boundary, with nothing buffered. */
export const initial = (boundaries: ReadonlyArray<Boundary>): MergeState =>
  boundaries.map((boundary) => ({ boundary, rows: [], next: 0, lastKey: undefined }))

/** Every partition from its start. */
export const fromStart = (count: number): MergeState =>
  initial(Array.from({ length: count }, () => START))

/** Is this partition out of rows to read and rows to emit? */
const isDone = (partition: Partition): boolean => partition.boundary._tag === "Done"

/** Has this partition nothing buffered, and more to read? */
const isDry = (partition: Partition): boolean =>
  !isDone(partition) && partition.next >= partition.rows.length

/** The partitions that must be read before anything further is proven in order. */
export const needingRead = (state: MergeState): ReadonlyArray<number> =>
  state.flatMap((partition, i) => (isDry(partition) ? [i] : []))

/** How many partitions are not done. */
export const unfinished = (state: MergeState): number =>
  state.reduce((n, partition) => (isDone(partition) ? n : n + 1), 0)

export const isFinished = (state: MergeState): boolean => unfinished(state) === 0

/** Is a page still buffered on partition `i`? */
export const isBuffered = (state: MergeState, i: number): boolean =>
  state[i]!.next < state[i]!.rows.length

/**
 * Partition `i` after a read: its page buffered, with the rows the query drops
 * already gone. A page left with no rows moves its boundary on at once. Rows in
 * an unconsumed page aren't past the boundary, so a cursor reads them again.
 */
export const absorb = (
  state: MergeState,
  i: number,
  rows: ReadonlyArray<Row>,
  lastKey: Row | undefined,
): MergeState => {
  const partition = state[i]!
  const page: Partition =
    rows.length === 0
      ? { boundary: after(lastKey), rows: [], next: 0, lastKey: undefined }
      : { boundary: partition.boundary, rows, next: 0, lastKey }
  return state.map((existing, at) => (at === i ? page : existing))
}

/** A row selected in merged order, and the partition it came from. */
export interface Selected {
  readonly partition: number
  readonly row: Row
}

export interface Selection {
  readonly state: MergeState
  readonly taken: ReadonlyArray<Selected>
  /** The partitions whose page this selection consumed to its end. */
  readonly drained: ReadonlyArray<number>
}

const textOfKey = (value: AttributeValue): string | Uint8Array =>
  value.S ?? value.B ?? value.N ?? ""

/**
 * Parse a DynamoDB number's text to sign, significant digits and exponent:
 * `0.<digits> × 10^exponent`. Numbers have up to 38 digits, more than a float
 * holds, so they are compared as text.
 */
const parseDecimal = (
  text: string,
): {
  readonly sign: -1 | 0 | 1
  readonly digits: string
  readonly exponent: number
} => {
  const match = /^([+-]?)(\d*)\.?(\d*)(?:[eE]([+-]?\d+))?$/.exec(text)
  if (match === null) return { sign: 0, digits: "", exponent: 0 }
  const whole = match[2]!
  const all = `${whole}${match[3]!}`
  const leading = all.length - all.replace(/^0+/, "").length
  const digits = all.slice(leading).replace(/0+$/, "")
  if (digits === "") return { sign: 0, digits: "", exponent: 0 }
  return {
    sign: match[1] === "-" ? -1 : 1,
    digits,
    exponent: whole.length - leading + Number(match[4] ?? 0),
  }
}

/** Order two number texts numerically, exactly. */
export const compareDecimal = (a: string, b: string): number => {
  const x = parseDecimal(a)
  const y = parseDecimal(b)
  if (x.sign !== y.sign) return x.sign < y.sign ? -1 : 1
  if (x.sign === 0) return 0
  const magnitude =
    x.exponent !== y.exponent
      ? x.exponent < y.exponent
        ? -1
        : 1
      : x.digits < y.digits
        ? -1
        : x.digits > y.digits
          ? 1
          : 0
  return x.sign * magnitude
}

/** Order two sort key values as DynamoDB does: UTF-8 bytes, bytes, or numerically. */
export const compareKeyAttributes = (a: AttributeValue, b: AttributeValue): number =>
  a.N !== undefined && b.N !== undefined
    ? compareDecimal(a.N, b.N)
    : compareUtf8(textOfKey(a), textOfKey(b))

/**
 * Consume up to `budget` rows in merged order. Stops at the budget, or as soon as
 * a partition with more to read runs dry: nothing further is proven in order
 * until it is read. Equal sort keys order by partition, descending under
 * `reverse`, so reverse is the exact reversal of forward.
 */
export const select = (state: MergeState, budget: number, order: MergeOrder): Selection => {
  if (budget <= 0 || state.some(isDry)) return { state, taken: [], drained: [] }
  const { skField, reverse } = order
  const next = state.map((partition) => partition.next)
  const head = (i: number): AttributeValue => {
    const value = state[i]!.rows[next[i]!]![skField]
    if (value === undefined) {
      throw new Error(
        `[internal] A row read from a sharded index lacks its sort key attribute "${skField}".`,
      )
    }
    return value
  }
  const precedes = (i: number, j: number): boolean => {
    const compared = compareKeyAttributes(head(i), head(j))
    if (compared !== 0) return reverse ? compared > 0 : compared < 0
    return reverse ? i > j : i < j
  }

  // A binary heap of the partitions with a buffered row, by their head.
  const heap: Array<number> = []
  const siftUp = (from: number) => {
    let at = from
    while (at > 0) {
      const parent = (at - 1) >> 1
      if (!precedes(heap[at]!, heap[parent]!)) return
      ;[heap[at], heap[parent]] = [heap[parent]!, heap[at]!]
      at = parent
    }
  }
  const siftDown = () => {
    let at = 0
    while (true) {
      const left = 2 * at + 1
      const right = left + 1
      let first = at
      if (left < heap.length && precedes(heap[left]!, heap[first]!)) first = left
      if (right < heap.length && precedes(heap[right]!, heap[first]!)) first = right
      if (first === at) return
      ;[heap[at], heap[first]] = [heap[first]!, heap[at]!]
      at = first
    }
  }
  for (let i = 0; i < state.length; i++) {
    if (isBuffered(state, i)) {
      heap.push(i)
      siftUp(heap.length - 1)
    }
  }

  const taken: Array<Selected> = []
  const drained: Array<number> = []
  while (taken.length < budget && heap.length > 0) {
    const i = heap[0]!
    const partition = state[i]!
    taken.push({ partition: i, row: partition.rows[next[i]!]! })
    next[i]! += 1
    if (next[i]! < partition.rows.length) {
      siftDown()
      continue
    }
    drained.push(i)
    if (partition.lastKey !== undefined) break
    const last = heap.pop()!
    if (heap.length > 0) {
      heap[0] = last
      siftDown()
    }
  }

  return {
    state: state.map((partition, i) => {
      if (next[i] === partition.next) return partition
      if (next[i]! >= partition.rows.length) {
        return { boundary: after(partition.lastKey), rows: [], next: 0, lastKey: undefined }
      }
      return {
        ...partition,
        boundary: { _tag: "After", row: partition.rows[next[i]! - 1]! },
        next: next[i]!,
      }
    }),
    taken,
    drained,
  }
}
