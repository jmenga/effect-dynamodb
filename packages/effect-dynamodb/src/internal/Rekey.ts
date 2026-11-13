/**
 * @internal Rekey — move rows to the key text the schema's `escapeKeys` setting composes (#171,
 * #183, DESIGN.md §7 "`rekey`"). It is the only migration of key text: no other operation looks
 * at a key under other text.
 *
 * This module is the driver: a scan of the table — in parallel segments — that
 * hands each row to the member owning it (an entity, an aggregate or an event
 * stream, by `__edd_e__`), merges what each did into one report, and builds a
 * resume token from each segment's `LastEvaluatedKey`. The members move their
 * own rows (the {@link RekeyHandler} that `Entity.make`, `Aggregate.make` and
 * `EventStore.makeStream` attach), so a row `rekey` moves ends up exactly where
 * a write of it would have put it.
 *
 * A row is moved only when it is stored under the key its values compose under some other text
 * (`KeyText136.forms`: up to 1.36 and `escapeKeys` off, 1.37.0 and 1.38.0, `escapeKeys: true`); a row under
 * its current key is left alone, and one under neither is reported
 * (`unrecognizedKey`). That makes a run idempotent: a rerun finds every moved
 * row current. Conflicts — a row under both keys, a current key another row
 * holds — are reported, never overwritten.
 *
 * What a run decides over a table nothing else writes to doesn't depend on the order its segments,
 * pages and concurrent visits meet the rows (DESIGN.md §7 "`rekey`", "One outcome whatever the
 * order"):
 *
 * - **One verdict per row.** A row (by its stored key), an aggregate partition and an event stream
 *   are each a unit judged once per run ({@link RekeyRowContext.judge}): the first visit judges it
 *   — the scan's, or a move's that needs it out of the way — and a visit meanwhile waits for that
 *   verdict instead of judging it again. A wait that would close a loop (a row in the way of a row
 *   in the way of it) isn't taken: every unit on the loop is told so, and each reports `contended`.
 * - **The run doesn't meet its own writes** ({@link Journal}). The scan passes a row the run put,
 *   and a row the run took that a page read before the take still returned; `scanned` counts each
 *   row stored at the start once, whether the scan returned it or a move took it first.
 * - **A dry run plans the writes a real run sends** ({@link RekeyRowContext.plan}) and reads
 *   through the plan, so a later decision sees what an earlier one would have done.
 * - **Conflicts are reported one per row**, the first by precedence, in a fixed order.
 */

import type { AttributeValue, TransactWriteItem } from "@aws-sdk/client-dynamodb"
import { ValidationError } from "@effect-dynamodb/schema/Errors.js"
import { Context, Deferred, Effect, Option } from "effect"
import { DynamoClient, type DynamoClientError, type DynamoClientService } from "../DynamoClient.js"
import type {
  RekeyAmbiguity,
  RekeyConflict,
  RekeyCountName,
  RekeyCounts,
  RekeyGuardGapRow,
  RekeyGuardGaps,
  RekeyIndexKeys,
  RekeyJournal,
  RekeyMemberReport,
  RekeyOptions,
  RekeyReport,
  RekeyReservation,
  RekeyReservationCounts,
  RekeyRowKind,
  RekeySkipReason,
  TableConfig,
} from "../Table.js"
import * as Capacity from "./Capacity.js"
import {
  fromBase64,
  isWireKey,
  keyFromWire,
  keyToWire,
  toBase64Url,
  type WireValue,
} from "./Cursor.js"
import { digest } from "./Digest.js"
import type { UnprovableRow } from "./ExpressionLimits.js"

type Item = Record<string, AttributeValue>
type Update = NonNullable<TransactWriteItem["Update"]>

/** What a member's handler is told about the run. */
export interface RekeyRowContext {
  readonly tableName: string
  readonly dryRun: boolean
  /** Write the index keys that differ ({@link RekeyOptions.repairIndexKeys}), or only count them. */
  readonly repairIndexKeys: boolean
  /**
   * Judge the unique sentinels no row holds, and report them ({@link RekeyOptions.reservations}):
   * without, such a sentinel is `unrecognizedKey`, as 1.40.0 counted it, and nothing more is read.
   */
  readonly reservations: boolean
  /**
   * Delete the unique sentinels no row holds ({@link RekeyOptions.releaseOrphanedReservations}), or
   * only count them. Implies {@link reservations}.
   */
  readonly releaseOrphanedReservations: boolean
  /** Writes to the table are stopped ({@link RekeyOptions.writesStopped}): see {@link unprovableRow}. */
  readonly writesStopped: boolean
  /**
   * Whether this run has read every page of the table: it started at the beginning and is past the
   * end. A run bounded by `maxPages`, or started from `resume`, hasn't, so what it didn't find says
   * nothing. Only meaningful in {@link RekeyMember.finish}.
   */
  readonly sawWholeTable: () => boolean
  /**
   * `true` the first time the run asks for `unit`: work counted once per run, however reached.
   * Kept within the run's journal capacity ({@link RekeyOptions.journalCapacity}): past it, a unit
   * not kept is `true` again.
   */
  readonly claim: (unit: string) => boolean
  /** Whether the run has {@link claim}ed `unit`, without claiming it. Past capacity, `false`. */
  readonly claimed: (unit: string) => boolean
  /**
   * Room for one more thing a handler keeps for the run (a partition it read the root of): taken
   * from the run's journal capacity, or `false` when there is none, and then not kept.
   */
  readonly keep: () => boolean
  /**
   * `row`, which the scan returned, is left for another unit's move to take after this visit (a
   * sentinel its owner moves, a row its aggregate's root moves): the run keeps it as counted, so
   * that take doesn't count it again. A take while the visit runs needs no telling.
   */
  readonly awaitsMove: (row: Item) => void
  /**
   * Count what `judge` returns under `member` once the scan is over, when every write of the run
   * is known (#240): a count that depends on whether another unit's move takes or rewrites a row,
   * counted at first sight, would depend on the order the run meets the rows in. Kept within the
   * journal's capacity; past it, judged now.
   */
  readonly atEnd: (member: string, judge: () => RekeyTally) => void
  /**
   * Judge `unit` — a stored row, or rows that move together (an aggregate partition, an event
   * stream) — once per run, `work` being its judgment, counted under `member` when it settles. The
   * first call runs `work`; a call while it runs waits for it; a later one finds it settled. What
   * the caller learns is `settled`, or `loop`: the caller is itself in `unit`'s way, through the
   * units each waits on, so neither can move first. Whether the row left its key is
   * {@link vacated}.
   */
  readonly judge: <E, R>(
    member: string,
    unit: string,
    work: Effect.Effect<RekeyTally, E, R>,
  ) => Effect.Effect<Judged, E, R>
  /**
   * A dry run's write, which it doesn't send: whether it would succeed as far as the run knows (no
   * row the plan placed where it asks for none, none the plan took where it asks for one); if so,
   * its puts, deletes and updates are what the run reads, and the scan passes, from then on.
   */
  readonly plan: (items: ReadonlyArray<TransactWriteItem>) => boolean
  /**
   * Whether the row stored at `key` is gone by the run's write (a dry run: its plan). Past the
   * journal's capacity ({@link journalFull}) a take it had no room for reads as `false`.
   */
  readonly vacated: (key: Item) => boolean
  /**
   * Whether the journal has had no room for something ({@link RekeyOptions.journalCapacity}): from
   * then on {@link vacated} and {@link placed} may miss what the run did.
   */
  readonly journalFull: () => boolean
  /** Whether the row at `key` is one the run put there (a dry run: planned to). */
  readonly placed: (key: Item) => boolean
  /**
   * Whether the run has put a row at `key`, or is putting one: its request sent, its answer not yet
   * back, so {@link placed} doesn't say so yet (a dry run: planned to). A read finding nothing at
   * `key` can have been answered between such a put landing and the run hearing of it.
   */
  readonly putting: (key: Item) => boolean
  /**
   * `row`, read with `rows` (as stored), stands where one of the caller's belongs: judge first
   * what it is part of, when another unit holds it ({@link RekeyMember.holder}), as the scan would
   * judge that unit. Its verdict, as {@link judge} gives it; `undefined` when no unit holds it.
   */
  readonly yieldTo: (
    row: Item,
    rows: ReadonlyArray<Item>,
  ) => Effect.Effect<Judged | undefined, DynamoClientError, DynamoClient | TableConfig>
}

/**
 * What a move does with a row it can't prove unchanged ({@link UnprovableRow}): with writes to the
 * table stopped, nothing can change it, so it moves under the strongest guard that fits; otherwise
 * it's left and reported `unguarded`, unless its aggregate or stream is already part-moved.
 */
export const unprovableRow = (ctx: RekeyRowContext): UnprovableRow =>
  ctx.writesStopped ? "strongest" : "report"

/** A row left where it is because nothing proves it unchanged when it moves ({@link unprovableRow}). */
export const UNGUARDED_MESSAGE =
  "It can't be proven unchanged in one condition: guarded whole, it's over DynamoDB's limits on " +
  "one expression, and it has no version or updatedAt the library stamps to stand in. It's left " +
  "where it is: stop writes to the table, then run rekey with writesStopped: true."

/** What {@link RekeyRowContext.judge} found: the unit settled, or it and the caller are a loop. */
export type Judged = "settled" | "loop"

/**
 * One text for a tuple of texts, the same only for tuples equal part by part: each part is quoted
 * as JSON, so nothing a part holds (a NUL, a quote, a comma) can pass for the end of one part and
 * the start of the next. Every unit, claim and key the run tells apart is one of these.
 */
export const identity = (...parts: ReadonlyArray<string>): string => JSON.stringify(parts)

/** A key attribute's value as an {@link identity} part: its type and value. A string is an S value. */
const keyPart = (value: AttributeValue | string | undefined): string =>
  value === undefined ? "" : canonicalValue(typeof value === "string" ? { S: value } : value)

/** The unit a stored row is judged as ({@link RekeyRowContext.judge}): its stored key. */
export const rowUnit = (
  pk: AttributeValue | string | undefined,
  sk: AttributeValue | string | undefined,
): string => identity("row", keyPart(pk), keyPart(sk))

/**
 * The unit a unique sentinel is judged as for its reservation ({@link RekeyRowContext.judge}): is
 * it held, and if not, is it reported or released. Apart from {@link rowUnit}, the unit that moves
 * it, since a sentinel no row holds may still move with the tombstone it names.
 */
export const reservationUnit = (
  pk: AttributeValue | string | undefined,
  sk: AttributeValue | string | undefined,
): string => identity("reservation", keyPart(pk), keyPart(sk))

/** What a row in a loop of rows holding each other's current keys is reported with. */
export const LOOP_MESSAGE =
  "Rows under other key text hold each other's current keys in a loop: none can move first."

/** What a handler did with one scanned row (and the rows that moved with it). */
export interface RekeyTally {
  readonly unchanged?: number | undefined
  readonly moved?: Partial<Record<RekeyRowKind, number>> | undefined
  readonly indexKeysRewritten?: number | undefined
  readonly zonesRewritten?: number | undefined
  readonly sentinelsMoved?: number | undefined
  readonly indexKeys?: Partial<RekeyIndexKeys> | undefined
  /** Unique sentinels no row holds, or that couldn't be judged, each by its outcome. */
  readonly reservations?: ReadonlyArray<RekeyReservation> | undefined
  /** Rows moved under a guard that can miss a write ({@link RekeyGuardGaps}). */
  readonly guardGaps?: Partial<RekeyGuardGaps> | undefined
  /** The rows counted in {@link guardGaps}, named ({@link guardGap}). */
  readonly guardGapRows?: ReadonlyArray<RekeyGuardGapRow> | undefined
  readonly conflicts?: ReadonlyArray<RekeyConflict> | undefined
  readonly skipped?: Partial<Record<RekeySkipReason, number>> | undefined
  /**
   * The handler found work the run did on the row's behalf elsewhere (a sentinel already moved to
   * its current key by this run): the row isn't `unchanged`, though this call wrote nothing.
   */
  readonly worked?: boolean | undefined
  /** The outbox items counted in `skipped.ambiguousOwner`. */
  readonly ambiguous?: ReadonlyArray<RekeyAmbiguity> | undefined
}

/** A tally saying only that the member couldn't read the row's key back. */
const onlyUnrecognized = (tally: RekeyTally): boolean =>
  Object.keys(tally).length === 1 &&
  tally.skipped !== undefined &&
  Object.keys(tally.skipped).length === 1 &&
  (tally.skipped.unrecognizedKey ?? 0) > 0

/** A member's part in a run: the rows it may own, and its handler. */
export interface RekeyMember {
  /** The name it is reported under: an entity type, aggregate or stream name. */
  readonly name: string
  /** `__edd_e__` values of rows that may be the member's. */
  readonly types: ReadonlyArray<string>
  /** `__edd_e__` prefixes of rows that may be the member's (unique sentinels). */
  readonly typePrefixes?: ReadonlyArray<string> | undefined
  /** The table's key attributes, by which the run tells the keys its writes touch apart. */
  readonly key?: { readonly pk: string; readonly sk: string } | undefined
  /**
   * The rows of its `types` are its alone: no other member claiming them is asked. A projection's
   * outbox items, which read models of one entity type share, are judged by one member that asks
   * each of them ({@link ProjectionEngine.rekeyOutboxMember}).
   */
  readonly exclusive?: boolean | undefined
  /** Handle one scanned row; `undefined` when it is not the member's after all. */
  readonly row: (
    row: Item,
    ctx: RekeyRowContext,
  ) => Effect.Effect<RekeyTally | undefined, DynamoClientError, DynamoClient | TableConfig>
  /**
   * Whether `row`, read with `rows`, is part of a unit of this member's whose rows move together
   * (an aggregate's): if so, that unit judged ({@link RekeyRowContext.judge}) and its verdict.
   * Reads nothing: `rows` are what the asker read. See {@link RekeyRowContext.yieldTo}.
   */
  readonly holder?:
    | ((
        row: Item,
        rows: ReadonlyArray<Item>,
        ctx: RekeyRowContext,
      ) => Effect.Effect<Judged | undefined, DynamoClientError, DynamoClient | TableConfig>)
    | undefined
  /** After the scan: rows it could judge only with everything scanned. */
  readonly finish?:
    | ((
        ctx: RekeyRowContext,
      ) => Effect.Effect<RekeyTally, DynamoClientError, DynamoClient | TableConfig>)
    | undefined
}

const CLIENT_ERROR_TAGS: ReadonlySet<string> = new Set([
  "DynamoError",
  "ThrottlingError",
  "DynamoValidationError",
  "InternalServerError",
  "ResourceNotFoundError",
])

/** Whether `error` is a {@link DynamoClientError}: a request failed, and the run with it. */
export const isDynamoClientError = (error: unknown): error is DynamoClientError =>
  typeof error === "object" &&
  error !== null &&
  CLIENT_ERROR_TAGS.has((error as { readonly _tag?: unknown })._tag as string)

/** A member's handler, carried by entities, aggregates and streams. */
export const RekeyHandler: unique symbol = Symbol.for("effect-dynamodb/Rekey/Handler")

/** `target`, carrying `handler` as its {@link RekeyHandler}. */
export const carry = <A extends object>(handler: RekeyMember, target: A): A =>
  Object.assign(target, { [RekeyHandler]: handler })

/** Read the {@link RekeyHandler} a member carries, if any. */
export const handlerOf = (member: unknown): RekeyMember | undefined =>
  typeof member === "object" && member !== null
    ? ((member as Record<symbol, RekeyMember | undefined>)[RekeyHandler] ?? undefined)
    : undefined

// ---------------------------------------------------------------------------
// Tallies
// ---------------------------------------------------------------------------

export const ROW_KINDS: ReadonlyArray<RekeyRowKind> = [
  "item",
  "snapshot",
  "tombstone",
  "outbox",
  "event",
  "aggregate",
  "stream",
]

const SKIP_REASONS: ReadonlyArray<RekeySkipReason> = [
  "notLibrary",
  "unregistered",
  "unrecognizedKey",
  "rootNotSeen",
  "ambiguousOwner",
]

type MutableCounts = { -readonly [K in RekeyRowKind]: number }

const zeroCounts = (): MutableCounts => ({
  item: 0,
  snapshot: 0,
  tombstone: 0,
  outbox: 0,
  event: 0,
  aggregate: 0,
  stream: 0,
})

type MutableIndexKeys = { -readonly [K in keyof RekeyIndexKeys]: number }

const INDEX_KEY_COUNTS: ReadonlyArray<keyof RekeyIndexKeys> = [
  "missing",
  "truncated",
  "lagging",
  "ambiguous",
  "repaired",
  "skipped",
]

const zeroIndexKeys = (): MutableIndexKeys => ({
  missing: 0,
  truncated: 0,
  lagging: 0,
  ambiguous: 0,
  repaired: 0,
  skipped: 0,
})

type MutableGuardGaps = { -readonly [K in keyof RekeyGuardGaps]: number }

const GUARD_GAPS: ReadonlyArray<keyof RekeyGuardGaps> = ["stamp", "sparse", "strongest"]

const zeroGuardGaps = (): MutableGuardGaps => ({ stamp: 0, sparse: 0, strongest: 0 })

/**
 * A row moved under `guard`, with writes going on: counted in {@link RekeyGuardGaps} when the guard
 * can miss a write. Nothing with writes stopped.
 */
export const guardGap = (
  ctx: RekeyRowContext,
  gap: keyof RekeyGuardGaps | undefined,
  /** The row: the report names it ({@link RekeyGuardGapRow}). */
  row: Omit<RekeyGuardGapRow, "gap">,
): RekeyTally =>
  gap === undefined || ctx.writesStopped
    ? {}
    : { guardGaps: { [gap]: 1 }, guardGapRows: [{ ...row, gap }] }

/** How many rows {@link RekeyReport.guardGaps} names: the first by member, kind and key. */
const GUARD_GAP_ROWS = 100

const guardGapRowOrder = (row: RekeyGuardGapRow): ReadonlyArray<string> => [
  row.member,
  row.kind,
  stableText(row.key),
  row.gap,
  stableText(row.target),
]

/** The first {@link GUARD_GAP_ROWS} of `rows` by {@link guardGapRowOrder}. */
const firstGuardGapRows = (
  rows: ReadonlyArray<RekeyGuardGapRow>,
): ReadonlyArray<RekeyGuardGapRow> =>
  rows
    .map((row) => ({ row, order: guardGapRowOrder(row) }))
    .sort((a, b) => compareOrders(a.order, b.order))
    .slice(0, GUARD_GAP_ROWS)
    .map(({ row }) => row)

type MutableReservations = { -readonly [K in keyof RekeyReservationCounts]: number }

const zeroReservations = (): MutableReservations => ({
  orphaned: 0,
  released: 0,
  skipped: 0,
  raced: 0,
  undecided: 0,
})

/**
 * Count a reservation by its outcome: `orphaned` counts every one found and still orphaned when
 * released or left ({@link RekeyReservationCounts}).
 */
const countReservation = (into: MutableReservations, entry: RekeyReservation): void => {
  if (entry.outcome === "undecided") {
    into.undecided += 1
    return
  }
  if (entry.outcome === "raced") {
    into.raced += 1
    return
  }
  into.orphaned += 1
  if (entry.outcome === "released") into.released += 1
  if (entry.outcome === "skipped") into.skipped += 1
}

interface MutableMember {
  unchanged: number
  moved: MutableCounts
  indexKeysRewritten: number
  zonesRewritten: number
  sentinelsMoved: number
  indexKeys: MutableIndexKeys
  reservations: MutableReservations
  guardGaps: MutableGuardGaps
}

/** A value as text whose order is the same whatever order its object's properties were set in. */
const stableText = (value: unknown): string => {
  if (typeof value !== "object" || value === null) return JSON.stringify(value) ?? "undefined"
  if (Array.isArray(value)) return `[${value.map(stableText).join(",")}]`
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableText(v)}`).join(",")}}`
}

/** Which of a row's conflicts is reported when it is met more than once: the first that applies. */
const REASON_ORDER: ReadonlyArray<RekeyConflict["reason"]> = [
  "failed",
  "unguarded",
  "uncomposable",
  "bothKeys",
  "contended",
  "taken",
]

const reasonRank = (reason: RekeyConflict["reason"]): number => {
  const at = REASON_ORDER.indexOf(reason)
  return at === -1 ? REASON_ORDER.length : at
}

/** The order conflicts are reported in, and the tie-break between two of one row. */
const conflictOrder = (conflict: RekeyConflict): ReadonlyArray<string> => [
  conflict.member,
  conflict.kind,
  stableText(conflict.key),
  String(reasonRank(conflict.reason)).padStart(2, "0"),
  stableText(conflict.target),
  conflict.message,
]

const compareOrders = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): number => {
  for (let i = 0; i < a.length; i++) {
    if (a[i]! < b[i]!) return -1
    if (a[i]! > b[i]!) return 1
  }
  return 0
}

/** The run's counts, merged as units settle. */
class Totals {
  scanned = 0
  unchanged = 0
  moved = zeroCounts()
  indexKeysRewritten = 0
  zonesRewritten = 0
  sentinelsMoved = 0
  indexKeys = zeroIndexKeys()
  reservations = zeroReservations()
  guardGaps = zeroGuardGaps()
  /** One entry per sentinel: a sentinel is its own unit, judged once a run. */
  private readonly reservationEntries: Array<RekeyReservation> = []
  /** The rows counted in `guardGaps`, kept to the first {@link GUARD_GAP_ROWS} as they come. */
  private guardGapRows: ReadonlyArray<RekeyGuardGapRow> = []
  /** One conflict per row (member, kind, key): the first by {@link REASON_ORDER}, then by text. */
  private readonly conflicts = new Map<string, RekeyConflict>()
  skipped: { -readonly [R in RekeySkipReason]: number } = {
    notLibrary: 0,
    unregistered: 0,
    unrecognizedKey: 0,
    rootNotSeen: 0,
    ambiguousOwner: 0,
  }
  ambiguous: Array<RekeyAmbiguity> = []
  byMember = new Map<string, MutableMember>()

  private memberOf(member: string): MutableMember {
    const known = this.byMember.get(member)
    if (known !== undefined) return known
    const fresh: MutableMember = {
      unchanged: 0,
      moved: zeroCounts(),
      indexKeysRewritten: 0,
      zonesRewritten: 0,
      sentinelsMoved: 0,
      indexKeys: zeroIndexKeys(),
      reservations: zeroReservations(),
      guardGaps: zeroGuardGaps(),
    }
    this.byMember.set(member, fresh)
    return fresh
  }

  add(member: string | undefined, tally: RekeyTally): void {
    const into = member === undefined ? undefined : this.memberOf(member)
    const unchanged = tally.unchanged ?? 0
    this.unchanged += unchanged
    if (into !== undefined) into.unchanged += unchanged
    for (const kind of ROW_KINDS) {
      const n = tally.moved?.[kind] ?? 0
      this.moved[kind] += n
      if (into !== undefined) into.moved[kind] += n
    }
    const rewritten = tally.indexKeysRewritten ?? 0
    this.indexKeysRewritten += rewritten
    if (into !== undefined) into.indexKeysRewritten += rewritten
    const zones = tally.zonesRewritten ?? 0
    this.zonesRewritten += zones
    if (into !== undefined) into.zonesRewritten += zones
    const sentinels = tally.sentinelsMoved ?? 0
    this.sentinelsMoved += sentinels
    if (into !== undefined) into.sentinelsMoved += sentinels
    for (const count of INDEX_KEY_COUNTS) {
      const n = tally.indexKeys?.[count] ?? 0
      this.indexKeys[count] += n
      if (into !== undefined) into.indexKeys[count] += n
    }
    for (const gap of GUARD_GAPS) {
      const n = tally.guardGaps?.[gap] ?? 0
      this.guardGaps[gap] += n
      if (into !== undefined) into.guardGaps[gap] += n
    }
    if (tally.guardGapRows !== undefined && tally.guardGapRows.length > 0) {
      const rows = [...this.guardGapRows, ...tally.guardGapRows]
      // Bounded: sorted and cut once twice the list has come in, so memory stays flat.
      this.guardGapRows = rows.length > 2 * GUARD_GAP_ROWS ? firstGuardGapRows(rows) : rows
    }
    for (const entry of tally.reservations ?? []) {
      this.reservationEntries.push(entry)
      countReservation(this.reservations, entry)
      countReservation(this.memberOf(entry.member).reservations, entry)
    }
    for (const conflict of tally.conflicts ?? []) {
      // A row that can't move is met again by what wants its key, and by the scan: whichever
      // reaches it first, it's reported once, and the same way.
      this.memberOf(conflict.member)
      const row = identity(conflict.member, conflict.kind, stableText(conflict.key))
      const known = this.conflicts.get(row)
      if (known === undefined || compareOrders(conflictOrder(conflict), conflictOrder(known)) < 0) {
        this.conflicts.set(row, conflict)
      }
    }
    for (const reason of SKIP_REASONS) this.skipped[reason] += tally.skipped?.[reason] ?? 0
    for (const ambiguity of tally.ambiguous ?? []) this.ambiguous.push(ambiguity)
  }

  report(
    dryRun: boolean,
    capacity: Capacity.CapacityTotals,
    resume: string | undefined,
    budget: Budget,
  ): RekeyReport {
    // By member, kind, key, reason, target and message: the same whatever order the run met them.
    const conflicts = [...this.conflicts.values()]
      .map((conflict) => ({ conflict, order: conflictOrder(conflict) }))
      .sort((a, b) => compareOrders(a.order, b.order))
      .map(({ conflict }) => conflict)
    const byMember: Record<string, RekeyMemberReport> = {}
    for (const [name, m] of [...this.byMember.entries()].sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    )) {
      byMember[name] = {
        unchanged: m.unchanged,
        moved: { ...m.moved },
        indexKeysRewritten: m.indexKeysRewritten,
        zonesRewritten: m.zonesRewritten,
        sentinelsMoved: m.sentinelsMoved,
        indexKeys: { ...m.indexKeys },
        reservations: { ...m.reservations },
        guardGaps: { ...m.guardGaps },
        conflicts: conflicts.filter((conflict) => conflict.member === name).length,
      }
    }
    return {
      dryRun,
      scanned: this.scanned,
      unchanged: this.unchanged,
      moved: { ...this.moved } as RekeyCounts,
      indexKeysRewritten: this.indexKeysRewritten,
      zonesRewritten: this.zonesRewritten,
      sentinelsMoved: this.sentinelsMoved,
      indexKeys: { ...this.indexKeys },
      // By member, then key: the same whatever order the run met them.
      reservations: {
        ...this.reservations,
        entries: this.reservationEntries
          .map((entry) => ({ entry, order: [entry.member, stableText(entry.key)] }))
          .sort((a, b) => compareOrders(a.order, b.order))
          .map(({ entry }) => entry),
      },
      guardGaps: { ...this.guardGaps, rows: firstGuardGapRows(this.guardGapRows) },
      conflicts,
      skipped: { ...this.skipped },
      ambiguous: this.ambiguous
        .map((ambiguity) => ({ ambiguity, order: [ambiguity.member, stableText(ambiguity.key)] }))
        .sort((a, b) => compareOrders(a.order, b.order))
        .map(({ ambiguity }) => ambiguity),
      byMember,
      capacity,
      journal: {
        capacity: budget.capacity,
        used: budget.used,
        full: budget.full,
        inexact: budget.full ? (dryRun ? INEXACT_DRY : INEXACT_REAL) : [],
      },
      resume: Option.fromUndefinedOr(resume),
    }
  }
}

/**
 * What a real run past its journal's capacity may count wrong ({@link RekeyJournal}): a row it put
 * is met by the scan as a row stored there (`scanned`, `unchanged`, `indexKeys`, as 1.40.0 counted
 * them), a unit reached again is judged again (`unchanged`, `reservations`), a row stored under two
 * old key texts may count as two moves (`moved`), a row or sentinel in another's way may be
 * reported where a run with room moves both (`conflicts`, `sentinelsMoved`), and a row with no root
 * found may go unreported and a unique sentinel no row holds may be counted though a move took it
 * (`skipped`).
 */
const INEXACT_REAL: ReadonlyArray<RekeyCountName> = [
  "scanned",
  "unchanged",
  "moved",
  "sentinelsMoved",
  "indexKeys",
  "reservations",
  "conflicts",
  "skipped",
]

/** What a dry run past its journal's capacity may count wrong: anything, as its reads no longer see the whole plan. */
const INEXACT_DRY: ReadonlyArray<RekeyCountName> = [
  "scanned",
  "unchanged",
  "moved",
  "indexKeysRewritten",
  "sentinelsMoved",
  "indexKeys",
  "reservations",
  "guardGaps",
  "conflicts",
  "skipped",
]

// ---------------------------------------------------------------------------
// Resume tokens
// ---------------------------------------------------------------------------

/** A segment's position: `0` not started, `1` finished, or the key to resume after. */
type Position = 0 | 1 | Record<string, WireValue>

const TOKEN_PREFIX = "rk1."
const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: true })

const encodeToken = (tableName: string, positions: ReadonlyArray<Position>): string =>
  TOKEN_PREFIX + toBase64Url(encoder.encode(JSON.stringify({ t: tableName, s: positions })))

/** The positions a token holds, or why it can't be used. */
const decodeToken = (token: string, tableName: string): ReadonlyArray<Position> | string => {
  if (!token.startsWith(TOKEN_PREFIX)) return "it is not a rekey resume token"
  let parsed: unknown
  try {
    parsed = JSON.parse(decoder.decode(fromBase64(token.slice(TOKEN_PREFIX.length), true)))
  } catch {
    return "it is not a rekey resume token"
  }
  const shape = parsed as { readonly t?: unknown; readonly s?: unknown }
  if (typeof shape !== "object" || shape === null || !Array.isArray(shape.s)) {
    return "it is not a rekey resume token"
  }
  if (shape.t !== tableName) {
    return `it belongs to table ${JSON.stringify(shape.t)}, not ${JSON.stringify(tableName)}`
  }
  const positions = shape.s as ReadonlyArray<unknown>
  if (positions.length === 0) return "it names no scan segment"
  for (const position of positions) {
    if (position === 0 || position === 1) continue
    if (!isWireKey(position)) return "a segment position is malformed"
  }
  return positions as ReadonlyArray<Position>
}

const optionError = (cause: string) =>
  new ValidationError({ entityType: "Table", operation: "rekey", cause: `[EDD-9098] ${cause}` })

const positiveInteger = (value: number | undefined, name: string): string | undefined =>
  value === undefined || (Number.isInteger(value) && value > 0)
    ? undefined
    : `${name} must be a positive integer; received ${String(value)}.`

// ---------------------------------------------------------------------------
// Units: one verdict each per run
// ---------------------------------------------------------------------------

interface Unit {
  state: "judging" | "settled"
  /** The unit this one's judgment waits on now: one judged in its way, here or by another fiber. */
  waitingOn: Unit | undefined
  /** On a loop of units each waiting on the next ({@link RekeyRowContext.judge}). */
  loop: boolean
  /** Completed when it settles; made only when something waits. */
  done: Deferred.Deferred<void> | undefined
}

/** The unit the current fiber is judging, innermost first. */
const CurrentUnit = Context.Reference<Unit | undefined>("effect-dynamodb/Rekey/CurrentUnit", {
  defaultValue: () => undefined,
})

/**
 * What the run remembers, and how much: at most `capacity` entries, shared by the journal's keys,
 * the settled units and the claims ({@link RekeyOptions.journalCapacity}). Each is a 128-bit
 * {@link digest}, never key text or a row. An entry the budget refuses isn't kept: the run goes on
 * without it, and `full` says the counts it would have kept exact may not be
 * ({@link RekeyJournal}).
 */
class Budget {
  used = 0
  full = false
  constructor(readonly capacity: number) {}
  /** Room for `n` more entries: taken, or, past the capacity, refused and `full` set. */
  admit(n = 1): boolean {
    if (this.used + n > this.capacity) {
      this.full = true
      return false
    }
    this.used += n
    return true
  }
}

/**
 * The run's units ({@link RekeyRowContext.judge}). A visit of a unit being judged waits for its
 * verdict, unless the wait would close a loop — the unit waits, through the units each waits on,
 * on the caller — which can't end: then every unit on it is marked, and each is told `loop`. The
 * waits that are taken never form a loop, so every wait ends.
 *
 * A unit being judged is held as itself, for its waits: as many as the run judges at once. Once
 * settled it is its unit's digest and one bit (on a loop or not), within the {@link Budget}. One the
 * budget has no room for is judged again when reached again: its work reads what's stored, and
 * finds its rows moved.
 */
class Units {
  private readonly judging = new Map<string, Unit>()
  /** Settled units, by digest: whether each was on a loop. */
  private readonly settled = new Map<string, boolean>()

  constructor(
    private readonly totals: Totals,
    private readonly budget: Budget,
  ) {}

  judge<E, R>(
    member: string,
    unitText: string,
    work: Effect.Effect<RekeyTally, E, R>,
  ): Effect.Effect<Judged, E, R> {
    return Effect.withFiber((fiber) => {
      const key = digest(unitText)
      const caller = fiber.getRef(CurrentUnit)
      const verdict = (loop: boolean): Judged => (caller?.loop && loop ? "loop" : "settled")
      const known = this.judging.get(key)
      if (known === undefined) {
        const settled = this.settled.get(key)
        if (settled !== undefined) return Effect.succeed(verdict(settled))
        const unit: Unit = { state: "judging", waitingOn: undefined, loop: false, done: undefined }
        this.judging.set(key, unit)
        if (caller !== undefined) caller.waitingOn = unit
        return work.pipe(
          Effect.provideService(CurrentUnit, unit),
          Effect.tap((tally) => Effect.sync(() => this.totals.add(member, tally))),
          Effect.ensuring(
            Effect.sync(() => {
              unit.state = "settled"
              unit.waitingOn = undefined
              if (caller !== undefined && caller.waitingOn === unit) caller.waitingOn = undefined
              this.judging.delete(key)
              if (this.budget.admit()) this.settled.set(key, unit.loop)
              if (unit.done !== undefined) Deferred.doneUnsafe(unit.done, Effect.void)
              unit.done = undefined
            }),
          ),
          Effect.map(() => verdict(unit.loop)),
        )
      }
      if (known.state === "settled") return Effect.succeed(verdict(known.loop))
      if (caller !== undefined) {
        for (let at: Unit | undefined = known; at !== undefined; at = at.waitingOn) {
          if (at !== caller) continue
          for (let on: Unit | undefined = known; on !== undefined && on !== caller; ) {
            on.loop = true
            on = on.waitingOn
          }
          caller.loop = true
          return Effect.succeed<Judged>("loop")
        }
        caller.waitingOn = known
      }
      known.done ??= Deferred.makeUnsafe<void>()
      return Deferred.await(known.done).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (caller !== undefined && caller.waitingOn === known) caller.waitingOn = undefined
          }),
        ),
        Effect.map(() => verdict(known.loop)),
      )
    })
  }
}

// ---------------------------------------------------------------------------
// Fingerprints: a row's image as a hash
// ---------------------------------------------------------------------------

/**
 * A number as DynamoDB keeps it, from its text, never through `Number`: its significant digits,
 * without leading or trailing zeros, where the point falls, and its sign; zero is `0`.
 */
export const canonicalNumber = (text: string): string => {
  const match = /^\s*([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?\s*$/.exec(text)
  if (match === null) return `?${text}`
  const whole = match[2] ?? ""
  let digits = whole + (match[3] ?? "")
  let point = whole.length + Number(match[4] ?? 0)
  let lead = 0
  while (lead < digits.length && digits[lead] === "0") lead++
  digits = digits.slice(lead)
  point -= lead
  digits = digits.replace(/0+$/, "")
  if (digits === "") return "0"
  return `${match[1] === "-" ? "-" : ""}${digits}e${point}`
}

const hexOf = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")

/**
 * An attribute value as one canonical text, type-tagged and recursive: two values DynamoDB stores
 * alike give the same text. A set's elements sorted, a map's entries by name, a list in order.
 */
export const canonicalValue = (value: AttributeValue): string => {
  if (value.S !== undefined) return `S${JSON.stringify(value.S)}`
  if (value.N !== undefined) return `N${canonicalNumber(value.N)}`
  if (value.B !== undefined) return `B${hexOf(value.B)}`
  if (value.BOOL !== undefined) return value.BOOL ? "BOOL1" : "BOOL0"
  if (value.NULL !== undefined) return "NULL"
  if (value.SS !== undefined) {
    return `SS[${value.SS.map((s) => JSON.stringify(s))
      .sort()
      .join(",")}]`
  }
  if (value.NS !== undefined) return `NS[${value.NS.map(canonicalNumber).sort().join(",")}]`
  if (value.BS !== undefined) return `BS[${value.BS.map(hexOf).sort().join(",")}]`
  if (value.L !== undefined) return `L[${value.L.map(canonicalValue).join(",")}]`
  if (value.M !== undefined) return `M${canonicalItem(value.M)}`
  return `?${JSON.stringify(value)}`
}

/** An item as one canonical text: its attributes sorted by name ({@link canonicalValue}). */
export const canonicalItem = (item: Item): string =>
  `{${Object.keys(item)
    .filter((name) => item[name] !== undefined)
    .sort()
    .map((name) => `${JSON.stringify(name)}:${canonicalValue(item[name]!)}`)
    .join(",")}}`

/**
 * A row's image as its {@link canonicalItem} text's {@link digest}: 128 bits of SHA-256, so two
 * different rows share one only by a SHA-256 collision. A row near 400 KB costs a few milliseconds.
 */
export const fingerprint = (item: Item): string => digest(canonicalItem(item))

// ---------------------------------------------------------------------------
// The journal: the run's writes, by key
// ---------------------------------------------------------------------------

/** An update's SET and REMOVE clauses, applied to `image`: `undefined` for any other update. */
export const updated = (image: Item, update: Update): Item | undefined => {
  const names = update.ExpressionAttributeNames ?? {}
  const values = update.ExpressionAttributeValues ?? {}
  const nameOf = (token: string) => (token.startsWith("#") ? names[token] : token)
  const next: Item = { ...image }
  const clauses = (update.UpdateExpression ?? "").split(/\b(?=SET\b|REMOVE\b|ADD\b|DELETE\b)/)
  for (const clause of clauses) {
    const text = clause.trim()
    if (text === "") continue
    if (text.startsWith("SET ")) {
      for (const assignment of text.slice(4).split(",")) {
        const match = /^\s*(#?[\w.-]+)\s*=\s*(:[\w-]+)\s*$/.exec(assignment)
        const name = match === null ? undefined : nameOf(match[1]!)
        const value = match === null ? undefined : values[match[2]!]
        if (name === undefined || value === undefined) return undefined
        next[name] = value
      }
    } else if (text.startsWith("REMOVE ")) {
      for (const token of text.slice(7).split(",")) {
        const name = nameOf(token.trim())
        if (name === undefined) return undefined
        delete next[name]
      }
    } else {
      return undefined
    }
  }
  return next
}

/** A query's key condition, read: the partition it names, and a test of each item's sort key. */
const keyConditionOf = (input: {
  readonly KeyConditionExpression?: string | undefined
  readonly ExpressionAttributeNames?: Record<string, string> | undefined
  readonly ExpressionAttributeValues?: Record<string, AttributeValue> | undefined
}):
  | {
      readonly attribute: string
      readonly sort: string | undefined
      readonly holds: (item: Item) => boolean
    }
  | undefined => {
  const names = input.ExpressionAttributeNames ?? {}
  const values = input.ExpressionAttributeValues ?? {}
  const nameOf = (token: string) => (token.startsWith("#") ? names[token] : token)
  const match = /^\s*\(?\s*(#?\w+)\s*=\s*(:\w+)\s*\)?\s*(?:AND\s+(.*?))?\s*$/i.exec(
    input.KeyConditionExpression ?? "",
  )
  if (match === null) return undefined
  const attribute = nameOf(match[1]!)
  const value = values[match[2]!]
  if (attribute === undefined || value === undefined) return undefined
  // The sort key condition, out of the parentheses around it, if any (not a function's own).
  const raw = match[3]?.trim()
  const rest = raw?.startsWith("(") && raw.endsWith(")") ? raw.slice(1, -1).trim() : raw
  const same = (item: Item) => {
    const at = item[attribute]
    return at !== undefined && canonicalValue(at) === canonicalValue(value)
  }
  if (rest === undefined) return { attribute, sort: undefined, holds: same }
  const text = (v: AttributeValue | undefined) => v?.S ?? undefined
  const begins = /^begins_with\(\s*(#?\w+)\s*,\s*(:\w+)\s*\)$/i.exec(rest)
  if (begins !== null) {
    const sort = nameOf(begins[1]!)
    const prefix = text(values[begins[2]!])
    if (sort === undefined || prefix === undefined) return undefined
    return {
      attribute,
      sort,
      holds: (item) => same(item) && (text(item[sort]) ?? "￿").startsWith(prefix),
    }
  }
  const between = /^(#?\w+)\s+BETWEEN\s+(:\w+)\s+AND\s+(:\w+)$/i.exec(rest)
  if (between !== null) {
    const sort = nameOf(between[1]!)
    const lo = text(values[between[2]!])
    const hi = text(values[between[3]!])
    if (sort === undefined || lo === undefined || hi === undefined) return undefined
    return {
      attribute,
      sort,
      holds: (item) => {
        const at = text(item[sort])
        return same(item) && at !== undefined && at >= lo && at <= hi
      },
    }
  }
  const compare = /^(#?\w+)\s*(<=|>=|<|>|=)\s*(:\w+)$/.exec(rest)
  if (compare !== null) {
    const sort = nameOf(compare[1]!)
    const bound = text(values[compare[3]!])
    if (sort === undefined || bound === undefined) return undefined
    const op = compare[2]!
    return {
      attribute,
      sort,
      holds: (item) => {
        const at = text(item[sort])
        if (!same(item) || at === undefined) return false
        return op === "<"
          ? at < bound
          : op === "<="
            ? at <= bound
            : op === ">"
              ? at > bound
              : op === ">="
                ? at >= bound
                : at === bound
      },
    }
  }
  return undefined
}

/** What the journal holds for a key the run wrote (a dry run: planned) to, by the key's digest. */
interface KeyState {
  /** The row stored here at the start is counted in `scanned`. */
  counted: boolean
  /** When the row stored here was taken by the run (its {@link Journal.seq}), if it was. */
  takenAt: number | undefined
  /**
   * The latest of the run's writes here that took effect: `taken`, or the row it put — a real run
   * keeps `ours` (the image only in {@link Journal.recent}), a dry run the image, unless it had no
   * room for it (`ours`, with `any`).
   */
  last: Item | "ours" | "taken" | undefined
  /**
   * The {@link fingerprint}s of the images the run left here — put, sent to put, or (a dry run)
   * planned — once per time it left each, at most {@link MAX_PRINTS}.
   */
  prints: Array<string> | undefined
  /** The prints of a real run's puts here that are sent and not yet answered. */
  sending: Array<string> | undefined
  /** The run left an image here it can't name: the scan passes whatever it finds. */
  any: boolean
  /** A dry run's updates to the row stored here, which it didn't put. */
  patches: Array<Update> | undefined
  /** A dry run's planned row here: its partition key value's digest ({@link Journal.placedIn}). */
  partition: string | undefined
}

/** Images one key holds, past which the scan passes whatever it finds there ({@link KeyState.any}). */
const MAX_PRINTS = 8

/** Rows a real run keeps the image of, the latest it put, to follow its own updates of them. */
const RECENT_IMAGES = 64

/** How many bytes of a row a dry run plans to put take one more entry of the capacity. */
const IMAGE_ENTRY_BYTES = 256

/** The default {@link RekeyOptions.journalCapacity}. */
export const DEFAULT_JOURNAL_CAPACITY = 1_000_000

/** The largest {@link RekeyOptions.journalCapacity}: a `Map` holds 2^24 entries at most. */
export const MAX_JOURNAL_CAPACITY = 16_000_000

/** A put's condition is on the row it replaces, as read: it writes over a row stored there. */
const overwrites = (condition: string | undefined): boolean =>
  condition !== undefined && condition.trim() !== "" && !condition.includes("attribute_not_exists")

/** A row the scan returned that the run judges, and the key its visit holds while it runs. */
interface Visit {
  readonly row: Item
  readonly key: string | undefined
}

/**
 * The run's writes, by key — sent and answered, or (a dry run) planned — within the run's
 * {@link Budget}. Each key is a 128-bit {@link digest} of its typed values, and a real run keeps no
 * image of a row, only its {@link fingerprint}: an entry is the same size whatever the key or the
 * row. A dry run also keeps each row it plans to put, which its reads see.
 *
 * - `scanned` counts each row stored at the start once: when the scan returns it, or when the run
 *   takes it (moves it away, or writes over it as read) before the scan gets to it. A row the scan
 *   returns costs nothing past its visit: a take while its visit runs ({@link inFlight}) is of a
 *   row already counted. A row left for another unit's move after its visit, the journal is told of
 *   ({@link RekeyRowContext.awaitsMove}).
 * - The scan passes a row the run put (its image is one the run left there), and a row the run took
 *   that a page read before the take still returned. Anything else at such a key — a row written
 *   there since by someone else — is a new row, counted and judged.
 * - A dry run plans its writes ({@link Journal.plan}), and its reads ({@link Journal.view}) see the
 *   plan: a row it would take is gone, one it would put is there.
 *
 * Past the capacity, a key the budget has no room for isn't kept: a row the run put there is met
 * by the scan as a new row, and one it took is counted again if the scan returns it.
 */
class Journal {
  /** How many takes the run has made: a scan page records it when it is read. */
  seq = 0
  private readonly keys = new Map<string, KeyState>()
  /** The keys whose scanned rows are being judged now, each with how many visits hold it. */
  private readonly inFlight = new Map<string, number>()
  /** A real run's latest images of rows it put, by key, oldest first ({@link RECENT_IMAGES}). */
  private readonly recent = new Map<string, Item>()
  /** A dry run's planned rows, by the digest of the partition key value ({@link canonicalValue}). */
  private readonly placedIn = new Map<string, Set<string>>()
  /**
   * A dry run's planned rows by the value of an attribute a secondary index is partitioned on,
   * built on the first query of that index ({@link placedWith}).
   */
  private readonly placedBy = new Map<string, Map<string, Set<string>>>()

  constructor(
    private readonly tableName: string,
    private readonly names: { readonly pk: string; readonly sk: string } | undefined,
    private readonly totals: Totals,
    private readonly budget: Budget,
    private readonly dryRun: boolean,
  ) {}

  /** The digest of an item's table key, its typed values ({@link canonicalValue}). */
  keyOf(item: Item | undefined): string | undefined {
    if (this.names === undefined || item === undefined) return undefined
    const pk = item[this.names.pk]
    if (pk === undefined) return undefined
    const sk = item[this.names.sk]
    return digest(identity(canonicalValue(pk), sk === undefined ? "" : canonicalValue(sk)))
  }

  /** `key`'s state, made if the budget has room: `undefined` when it has none. */
  private state(key: string): KeyState | undefined {
    const known = this.keys.get(key)
    if (known !== undefined) return known
    if (!this.budget.admit()) return undefined
    const fresh: KeyState = {
      counted: false,
      takenAt: undefined,
      last: undefined,
      prints: undefined,
      sending: undefined,
      any: false,
      patches: undefined,
      partition: undefined,
    }
    this.keys.set(key, fresh)
    return fresh
  }

  /** The row stored at `key` at the start is met: counted, once. */
  private count(state: KeyState): void {
    if (state.counted) return
    state.counted = true
    this.totals.scanned++
  }

  /**
   * The row stored at `key` at the start is taken, or written over, by the run: counted unless the
   * scan counted it — its visit is running, or it was left for this ({@link awaitsMove}). A dry run
   * counts it when its scan meets it, since a dry run takes nothing.
   */
  private countTaken(key: string, state: KeyState | undefined): void {
    if (this.dryRun) return
    if (state?.counted === true) return
    if (state !== undefined) state.counted = true
    if (!this.inFlight.has(key)) this.totals.scanned++
  }

  private addPrint(state: KeyState, print: string): void {
    if (state.any) return
    if (state.prints === undefined) state.prints = [print]
    else if (state.prints.length >= MAX_PRINTS) {
      state.any = true
      state.prints = undefined
    } else state.prints.push(print)
  }

  private dropPrint(state: KeyState, print: string): void {
    const at = state.prints?.indexOf(print) ?? -1
    if (at >= 0) state.prints!.splice(at, 1)
  }

  /** A put sent with `print` is answered (or failed): no longer on its way. */
  private answered(state: KeyState, print: string): void {
    const at = state.sending?.indexOf(print) ?? -1
    if (at >= 0) state.sending!.splice(at, 1)
    if (state.sending?.length === 0) state.sending = undefined
  }

  /** Whether the row at `key` is the run's own: one it put, or left by an update of one it put. */
  private ours(state: KeyState): boolean {
    return state.last !== undefined && state.last !== "taken"
  }

  /** A real run's latest image of a row it put at `key`. */
  private remember(key: string, image: Item): void {
    this.recent.delete(key)
    this.recent.set(key, image)
    if (this.recent.size > RECENT_IMAGES) {
      this.recent.delete(this.recent.keys().next().value!)
    }
  }

  /**
   * The scan returned `row`, on a page read when {@link seq} was `pageSeq`: the row to judge (in
   * a dry run, with the plan's updates applied), or `undefined` when the scan passes it. A row
   * judged holds its key until {@link left}.
   */
  visit(row: Item, pageSeq: number): Visit | undefined {
    // A row that isn't the library's is one the run never writes, nor writes over.
    if (row.__edd_e__ === undefined) {
      this.totals.scanned++
      return { row, key: undefined }
    }
    const key = this.keyOf(row)
    if (key === undefined) {
      this.totals.scanned++
      return { row, key: undefined }
    }
    const state = this.keys.get(key)
    if (state === undefined) {
      this.totals.scanned++
    } else {
      // A dry run writes nothing, so what its scan returns where its plan took the row is that row,
      // whatever the plan put there since, however alike.
      if (this.dryRun && state.takenAt !== undefined) {
        this.count(state)
        return undefined
      }
      if (state.any || state.prints?.includes(fingerprint(row)) === true) {
        return undefined
      }
      // The row the run took, returned by a page read before the take.
      if (state.takenAt !== undefined && state.takenAt > pageSeq) {
        this.count(state)
        return undefined
      }
      // Counted already: a row written there since the run took the one stored at the start.
      if (state.counted) this.totals.scanned++
      else this.count(state)
    }
    this.inFlight.set(key, (this.inFlight.get(key) ?? 0) + 1)
    return { row: state?.patches === undefined ? row : this.patched(state, row), key }
  }

  /** The visit is over: its key is no longer held. */
  left(visit: Visit): void {
    if (visit.key === undefined) return
    const n = this.inFlight.get(visit.key) ?? 0
    if (n <= 1) this.inFlight.delete(visit.key)
    else this.inFlight.set(visit.key, n - 1)
  }

  /**
   * `row`, scanned and judged, stays where it is for another unit's move to take it once its visit
   * is over ({@link RekeyRowContext.awaitsMove}): kept as counted, so the take doesn't count it too.
   */
  awaitsMove(row: Item): void {
    const key = this.keyOf(row)
    if (key === undefined) return
    const state = this.state(key)
    if (state !== undefined) state.counted = true
  }

  vacated(key: Item): boolean {
    const digested = this.keys.size === 0 ? undefined : this.keyOf(key)
    return digested !== undefined && this.keys.get(digested)?.last === "taken"
  }

  placed(key: Item): boolean {
    const digested = this.keys.size === 0 ? undefined : this.keyOf(key)
    const state = digested === undefined ? undefined : this.keys.get(digested)
    return state !== undefined && this.ours(state)
  }

  /** A put of the run's at `key` took effect or is on its way: placed, or sent (its print kept). */
  putting(key: Item): boolean {
    const digested = this.keys.size === 0 ? undefined : this.keyOf(key)
    const state = digested === undefined ? undefined : this.keys.get(digested)
    return (
      state !== undefined &&
      (this.ours(state) || state.any || (state.prints !== undefined && state.prints.length > 0))
    )
  }

  /** A take of the row at `key` took effect (or was planned). */
  private take(key: string): void {
    const state = this.state(key)
    // A row the run never put there was stored there at the start.
    if (state === undefined || !this.ours(state)) this.countTaken(key, state)
    this.seq++
    this.recent.delete(key)
    if (state === undefined) return
    state.takenAt = this.seq
    state.last = "taken"
    // A put here still on its way may land after the take (the take's answer came first): its
    // print stays, so the scan passes the row it puts.
    state.prints = state.sending === undefined ? undefined : [...state.sending]
    state.any = false
    state.patches = undefined
    if (state.partition !== undefined) this.placedIn.get(state.partition)?.delete(key)
    state.partition = undefined
    this.indexPlaced(key, undefined)
  }

  /** `key`'s planned image is now `image` (`undefined`: none): the secondary index maps follow. */
  private indexPlaced(key: string, image: Item | undefined): void {
    for (const [attribute, byValue] of this.placedBy) {
      for (const keys of byValue.values()) keys.delete(key)
      const value = image?.[attribute]
      if (value === undefined) continue
      const text = digest(canonicalValue(value))
      const keys = byValue.get(text)
      if (keys === undefined) byValue.set(text, new Set([key]))
      else keys.add(key)
    }
  }

  /** The keys of planned rows whose `attribute` holds `value`. */
  private placedWith(attribute: string, value: AttributeValue): Iterable<string> {
    let byValue = this.placedBy.get(attribute)
    if (byValue === undefined) {
      byValue = new Map()
      this.placedBy.set(attribute, byValue)
      for (const keys of this.placedIn.values()) {
        for (const key of keys) {
          const image = this.keys.get(key)?.last
          const held = typeof image === "object" ? image[attribute] : undefined
          if (held === undefined) continue
          const text = digest(canonicalValue(held))
          const same = byValue.get(text)
          if (same === undefined) byValue.set(text, new Set([key]))
          else same.add(key)
        }
      }
    }
    return byValue.get(digest(canonicalValue(value))) ?? []
  }

  /** A put of `image` took effect (or was planned); `replaced`: over the row there, as read. */
  private put(key: string, image: Item, replaced: boolean): void {
    const state = this.state(key)
    if (replaced && (state === undefined || !this.ours(state))) {
      this.countTaken(key, state)
      this.seq++
      if (state !== undefined) state.takenAt = this.seq
    }
    if (state === undefined) return
    state.patches = undefined
    if (!this.dryRun) {
      state.last = "ours"
      this.remember(key, image)
      return
    }
    // A dry run keeps the image it plans, which its reads see: its size, in entries.
    const text = canonicalItem(image)
    this.addPrint(state, digest(text))
    if (state.partition !== undefined) this.placedIn.get(state.partition)?.delete(key)
    state.partition = undefined
    if (!this.budget.admit(Math.ceil((text.length * 2) / IMAGE_ENTRY_BYTES))) {
      // No room for the image: the plan has a row here, as nothing it can read.
      state.last = "ours"
      state.any = true
      this.indexPlaced(key, undefined)
      return
    }
    state.last = image
    const partition = digest(canonicalValue(image[this.names!.pk]!))
    state.partition = partition
    const set = this.placedIn.get(partition)
    if (set === undefined) this.placedIn.set(partition, new Set([key]))
    else set.add(key)
    this.indexPlaced(key, image)
  }

  /** An update took effect (or was planned) at `key`. */
  private update(key: string, update: Update): void {
    const known = this.keys.get(key)
    if (known !== undefined && this.ours(known)) {
      const image = typeof known.last === "object" ? known.last : this.recent.get(key)
      const next = image === undefined ? undefined : updated(image, update)
      if (next === undefined) {
        known.any = true
        known.prints = undefined
        return
      }
      this.addPrint(known, fingerprint(next))
      if (!this.dryRun) {
        this.remember(key, next)
        return
      }
      known.last = next
      this.indexPlaced(key, next)
      return
    }
    // The row stored at the start, updated in place: the scan meets it as it is. A dry run's
    // reads see the update.
    if (this.dryRun) {
      const state = known ?? this.state(key)
      if (state === undefined || !this.budget.admit()) return
      if (state.patches === undefined) state.patches = []
      state.patches.push(update)
    }
  }

  private patched(state: KeyState, row: Item): Item {
    return state.patches === undefined
      ? row
      : state.patches.reduce<Item>((image, update) => updated(image, update) ?? image, row)
  }

  /** A dry run's write ({@link RekeyRowContext.plan}). */
  plan(items: ReadonlyArray<TransactWriteItem>): boolean {
    // What a condition asks of the row at its key: that there be none, that there be one, or what
    // only DynamoDB can judge (assumed to hold, as the run assumes of every request).
    const asks = (condition: string | undefined): "absent" | "present" | undefined => {
      const text = condition?.trim() ?? ""
      if (text === "") return undefined
      if (/^attribute_not_exists\(\s*#?\w+\s*\)$/.test(text)) return "absent"
      if (text.includes("attribute_not_exists")) return undefined
      return "present"
    }
    const mine = items.filter((item) => {
      const table =
        item.Put?.TableName ??
        item.Delete?.TableName ??
        item.Update?.TableName ??
        item.ConditionCheck?.TableName
      return table === this.tableName
    })
    for (const item of mine) {
      const write =
        item.Put !== undefined
          ? { key: item.Put.Item, condition: item.Put.ConditionExpression }
          : item.Delete !== undefined
            ? { key: item.Delete.Key, condition: item.Delete.ConditionExpression }
            : item.Update !== undefined
              ? { key: item.Update.Key, condition: item.Update.ConditionExpression }
              : {
                  key: item.ConditionCheck?.Key,
                  condition: item.ConditionCheck?.ConditionExpression,
                }
      const key = this.keyOf(write.key)
      if (key === undefined) continue
      const last = this.keys.get(key)?.last
      const there = last === undefined ? undefined : last !== "taken"
      const asked = asks(write.condition)
      if (asked === "absent" && there === true) return false
      if (asked === "present" && there === false) return false
    }
    for (const item of mine) this.applied(item)
    return true
  }

  /** What one write item did, once it took effect (or was planned). */
  private applied(item: TransactWriteItem): void {
    if (item.Put?.Item !== undefined) {
      const key = this.keyOf(item.Put.Item)
      if (key !== undefined) {
        this.put(key, item.Put.Item, overwrites(item.Put.ConditionExpression))
      }
    } else if (item.Delete !== undefined) {
      const key = this.keyOf(item.Delete.Key)
      if (key !== undefined) this.take(key)
    } else if (item.Update !== undefined) {
      const key = this.keyOf(item.Update.Key)
      if (key !== undefined) this.update(key, item.Update)
    }
  }

  /** A row a dry run's read returned, as the plan leaves it: `undefined` if the plan took it. */
  private reconcile(key: string | undefined, item: Item | undefined): Item | undefined {
    const state = key === undefined ? undefined : this.keys.get(key)
    if (state === undefined) return item
    if (state.last === "taken") return undefined
    if (typeof state.last === "object") return state.last
    // A row planned with no room for its image reads as what's stored.
    if (state.last === "ours") return item
    return item === undefined ? undefined : this.patched(state, item)
  }

  /**
   * `send`, a real run's write: the rows it puts are the run's own from when it's sent (the scan
   * may return one before the answer comes), and what it did is noted once it's answered.
   */
  private writing<A, E>(
    puts: ReadonlyArray<Item | undefined>,
    send: Effect.Effect<A, E>,
    done: (output: A) => ReadonlyArray<TransactWriteItem>,
  ): Effect.Effect<A, E> {
    return Effect.suspend(() => {
      const sent: Array<{ readonly state: KeyState; readonly print: string }> = []
      for (const item of puts) {
        const key = this.keyOf(item)
        if (key === undefined || item === undefined) continue
        const state = this.state(key)
        if (state === undefined) continue
        const print = fingerprint(item)
        this.addPrint(state, print)
        if (state.sending === undefined) state.sending = [print]
        else state.sending.push(print)
        sent.push({ state, print })
      }
      return send.pipe(
        Effect.tap((output) =>
          Effect.sync(() => {
            for (const { state, print } of sent) this.answered(state, print)
            for (const item of done(output)) this.applied(item)
          }),
        ),
        Effect.tapError(() =>
          Effect.sync(() => {
            for (const { state, print } of sent) {
              this.answered(state, print)
              this.dropPrint(state, print)
            }
          }),
        ),
      )
    })
  }

  /**
   * The client the handlers use: in a real run, `client` with each write on this table noted as
   * it's answered; in a dry run, `client` with its reads seeing the plan, and every write refused
   * (a dry run writes nothing). Built over the instrumented client, it is itself one, so
   * `Capacity.client` hands it out as is and each request is reported once.
   */
  view(client: DynamoClientService): DynamoClientService {
    const view = Object.create(client) as {
      -readonly [K in keyof DynamoClientService]: DynamoClientService[K]
    }
    const onTable = (name: string | undefined) => name === this.tableName
    if (this.dryRun) {
      const refuse = (operation: string) => () =>
        Effect.die(new Error(`rekey: a dry run sent a write (${operation})`))
      view.putItem = refuse("PutItem")
      view.deleteItem = refuse("DeleteItem")
      view.updateItem = refuse("UpdateItem")
      view.transactWriteItems = refuse("TransactWriteItems")
      view.batchWriteItem = refuse("BatchWriteItem")
      view.getItem = (input) =>
        onTable(input.TableName)
          ? Effect.map(client.getItem(input), (output) => {
              const item = this.reconcile(this.keyOf(input.Key), output.Item)
              return item === output.Item ? output : { ...output, Item: item }
            })
          : client.getItem(input)
      view.query = (input) =>
        onTable(input.TableName)
          ? Effect.map(client.query(input), (output) => this.reconcileQuery(input, output))
          : client.query(input)
      view.batchGetItem = (input) =>
        Effect.map(client.batchGetItem(input), (output) => {
          const responses: Record<string, Array<Item>> = { ...output.Responses }
          const rows = output.Responses?.[this.tableName]
          const asked = input.RequestItems?.[this.tableName]
          if (rows === undefined || asked === undefined) return output
          const answered = new Set<string>()
          const kept: Array<Item> = []
          for (const row of rows) {
            const key = this.keyOf(row)
            if (key !== undefined) answered.add(key)
            const item = this.reconcile(key, row)
            if (item !== undefined) kept.push(item)
          }
          const unprocessed = new Set(
            (output.UnprocessedKeys?.[this.tableName]?.Keys ?? []).map((key) => this.keyOf(key)),
          )
          for (const ask of asked.Keys ?? []) {
            const key = this.keyOf(ask)
            if (key === undefined || answered.has(key) || unprocessed.has(key)) continue
            const item = this.reconcile(key, undefined)
            if (item !== undefined) kept.push(item)
          }
          responses[this.tableName] = kept
          return { ...output, Responses: responses }
        })
      return view
    }
    view.putItem = (input) =>
      onTable(input.TableName)
        ? this.writing([input.Item], client.putItem(input), () => [
            {
              Put: {
                TableName: input.TableName,
                Item: input.Item!,
                ConditionExpression: input.ConditionExpression,
              },
            },
          ])
        : client.putItem(input)
    view.deleteItem = (input) =>
      onTable(input.TableName)
        ? this.writing([], client.deleteItem(input), () => [
            { Delete: { TableName: input.TableName, Key: input.Key! } },
          ])
        : client.deleteItem(input)
    view.updateItem = (input) =>
      onTable(input.TableName)
        ? this.writing([], client.updateItem(input), () => [{ Update: input as Update }])
        : client.updateItem(input)
    view.transactWriteItems = (input) => {
      const items = (input.TransactItems ?? []).filter((item) =>
        onTable(
          item.Put?.TableName ??
            item.Delete?.TableName ??
            item.Update?.TableName ??
            item.ConditionCheck?.TableName,
        ),
      )
      return this.writing(
        items.map((item) => item.Put?.Item),
        client.transactWriteItems(input),
        () => items,
      )
    }
    view.batchWriteItem = (input) => {
      const writes = input.RequestItems?.[this.tableName] ?? []
      return this.writing(
        writes.map((write) => write.PutRequest?.Item),
        client.batchWriteItem(input),
        (output) => {
          const left = new Set(
            (output.UnprocessedItems?.[this.tableName] ?? []).map((write) =>
              this.keyOf(write.PutRequest?.Item ?? write.DeleteRequest?.Key),
            ),
          )
          return writes.flatMap((write): ReadonlyArray<TransactWriteItem> => {
            const key = this.keyOf(write.PutRequest?.Item ?? write.DeleteRequest?.Key)
            if (key === undefined || left.has(key)) return []
            return write.PutRequest?.Item !== undefined
              ? [{ Put: { TableName: this.tableName, Item: write.PutRequest.Item } }]
              : [{ Delete: { TableName: this.tableName, Key: write.DeleteRequest!.Key! } }]
          })
        },
      )
    }
    return view
  }

  /**
   * A dry run's query page, reconciled with the plan: rows it took dropped, rows it put in their
   * place, and rows it put that match the key condition, inside the page's range, added in order.
   */
  private reconcileQuery<
    O extends {
      readonly Items?: Array<Item> | undefined
      readonly LastEvaluatedKey?: Item | undefined
      readonly Count?: number | undefined
    },
  >(
    input: {
      readonly IndexName?: string | undefined
      readonly KeyConditionExpression?: string | undefined
      readonly ExpressionAttributeNames?: Record<string, string> | undefined
      readonly ExpressionAttributeValues?: Record<string, AttributeValue> | undefined
      readonly ExclusiveStartKey?: Item | undefined
      readonly ScanIndexForward?: boolean | undefined
      readonly Select?: string | undefined
    },
    output: O,
  ): O {
    if (output.Items === undefined || input.Select === "COUNT") return output
    const condition = keyConditionOf(input)
    const names = this.names
    const rows: Array<Item> = []
    const answered = new Set<string>()
    let changed = false
    for (const item of output.Items) {
      const key = this.keyOf(item)
      if (key !== undefined) answered.add(key)
      const row = this.reconcile(key, item)
      if (row !== item) changed = true
      // An index holds a row only while its key does: one the plan's update moved off it is gone.
      if (row !== undefined && (row === item || condition === undefined || condition.holds(row))) {
        rows.push(row)
      }
    }
    const added: Array<Item> = []
    if (condition !== undefined && names !== undefined) {
      // The table orders by its sort key, an index by the attribute its condition names: rows of
      // an index queried by partition alone, whose order isn't known here, join its last page.
      const sort = condition.sort ?? (input.IndexName === undefined ? names.sk : undefined)
      const order = (item: Item | undefined) =>
        item === undefined || sort === undefined ? undefined : item[sort]?.S
      const forward = input.ScanIndexForward !== false
      const start = order(input.ExclusiveStartKey)
      const end = order(output.LastEvaluatedKey)
      const value =
        input.ExpressionAttributeValues?.[
          /=\s*(:\w+)/.exec(input.KeyConditionExpression ?? "")?.[1] ?? ""
        ]
      const candidates =
        value === undefined
          ? []
          : condition.attribute === names.pk
            ? (this.placedIn.get(digest(canonicalValue(value))) ?? [])
            : this.placedWith(condition.attribute, value)
      for (const key of candidates) {
        if (answered.has(key)) continue
        const image = this.reconcile(key, undefined)
        if (image === undefined || !condition.holds(image)) continue
        if (sort === undefined) {
          if (output.LastEvaluatedKey === undefined) added.push(image)
          continue
        }
        const at = order(image)
        if (at === undefined) continue
        if (start !== undefined && (forward ? at <= start : at >= start)) continue
        if (end !== undefined && (forward ? at > end : at < end)) continue
        added.push(image)
      }
      if (added.length > 0) {
        const merged =
          sort === undefined
            ? [...rows, ...added]
            : [...rows, ...added].sort((a, b) => {
                const x = order(a) ?? ""
                const y = order(b) ?? ""
                return (x < y ? -1 : x > y ? 1 : 0) * (forward ? 1 : -1)
              })
        return { ...output, Items: merged, Count: merged.length }
      }
    }
    if (!changed) return output
    return { ...output, Items: rows, Count: rows.length }
  }
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/**
 * Scan `tableName` and hand each row to its member. Rows a handler moves are
 * moved by it; the run itself writes nothing.
 */
export const run = (args: {
  readonly tableName: string
  readonly members: ReadonlyArray<RekeyMember>
  readonly options: RekeyOptions | undefined
}): Effect.Effect<RekeyReport, DynamoClientError | ValidationError, DynamoClient | TableConfig> =>
  Capacity.measured("Table.rekey", { target: args.tableName }, (capacity) =>
    Effect.gen(function* () {
      const { tableName, members } = args
      const options = args.options ?? {}
      const dryRun = options.dryRun === true
      const problem =
        positiveInteger(options.segments, "segments") ??
        positiveInteger(options.concurrency, "concurrency") ??
        positiveInteger(options.pageSize, "pageSize") ??
        positiveInteger(options.maxPages, "maxPages") ??
        positiveInteger(options.journalCapacity, "journalCapacity") ??
        ((options.journalCapacity ?? 0) > MAX_JOURNAL_CAPACITY
          ? `journalCapacity must be at most ${MAX_JOURNAL_CAPACITY}; received ${options.journalCapacity}.`
          : undefined)
      if (problem !== undefined) return yield* optionError(problem)
      if (options.releaseOrphanedReservations === true && options.writesStopped !== true) {
        return yield* optionError(
          "releaseOrphanedReservations needs writesStopped: true. Releasing is a maintenance step: " +
            "stop every writer to the table first, another cleanup releasing reservations included.",
        )
      }

      let positions: Array<Position>
      if (options.resume !== undefined) {
        const decoded = decodeToken(options.resume, tableName)
        if (typeof decoded === "string") {
          return yield* optionError(`The resume token can't be used: ${decoded}.`)
        }
        if (options.segments !== undefined && options.segments !== decoded.length) {
          return yield* optionError(
            `The resume token was made with ${decoded.length} scan segment(s), but segments is ` +
              `${options.segments}: resume with the token's segment count.`,
          )
        }
        positions = [...decoded]
      } else {
        positions = Array.from({ length: options.segments ?? 1 }, (): Position => 0)
      }
      const startedAtTheBeginning = positions.every((position) => position === 0)

      // Members by the `__edd_e__` values they claim, in registration order.
      const byType = new Map<string, Array<RekeyMember>>()
      for (const member of members) {
        for (const type of member.types) {
          const list = byType.get(type) ?? []
          list.push(member)
          byType.set(type, list)
        }
      }
      const prefixed = members.flatMap((member) =>
        (member.typePrefixes ?? []).map((prefix) => ({ prefix, member })),
      )

      const totals = new Totals()
      const budget = new Budget(options.journalCapacity ?? DEFAULT_JOURNAL_CAPACITY)
      const journal = new Journal(
        tableName,
        members.find((member) => member.key !== undefined)?.key,
        totals,
        budget,
        dryRun,
      )
      const units = new Units(totals, budget)
      const claimed = new Set<string>()
      const atEnd: Array<{ readonly member: string; readonly judge: () => RekeyTally }> = []
      const ctx: RekeyRowContext = {
        tableName,
        dryRun,
        repairIndexKeys: options.repairIndexKeys === true,
        reservations: options.reservations === true || options.releaseOrphanedReservations === true,
        releaseOrphanedReservations: options.releaseOrphanedReservations === true,
        writesStopped: options.writesStopped === true,
        sawWholeTable: () => startedAtTheBeginning && positions.every((position) => position === 1),
        claim: (unit) => {
          const key = digest(unit)
          if (claimed.has(key)) return false
          if (budget.admit()) claimed.add(key)
          return true
        },
        claimed: (unit) => claimed.has(digest(unit)),
        keep: () => budget.admit(),
        awaitsMove: (row) => journal.awaitsMove(row),
        atEnd: (member, judge) => {
          if (budget.admit()) atEnd.push({ member, judge })
          else totals.add(member, judge())
        },
        judge: (member, unit, work) => units.judge(member, unit, work),
        plan: (items) => journal.plan(items),
        vacated: (key) => journal.vacated(key),
        journalFull: () => budget.full,
        placed: (key) => journal.placed(key),
        putting: (key) => journal.putting(key),
        yieldTo: (row, rows) =>
          Effect.gen(function* () {
            const type = row.__edd_e__?.S
            if (type === undefined) return undefined
            for (const member of byType.get(type) ?? []) {
              if (member.holder === undefined) continue
              const judged = yield* member.holder(row, rows, ctx)
              if (judged !== undefined) return judged
            }
            return undefined
          }),
      }

      const handle = (found: Item, pageSeq: number) =>
        Effect.suspend(() => {
          const visit = journal.visit(found, pageSeq)
          if (visit === undefined) return Effect.void
          return judgeRow(visit.row).pipe(Effect.ensuring(Effect.sync(() => journal.left(visit))))
        })

      const judgeRow = (row: Item) =>
        Effect.gen(function* () {
          const type = row.__edd_e__?.S
          if (type === undefined) {
            totals.add(undefined, { skipped: { notLibrary: 1 } })
            return
          }
          const claiming = [
            ...(byType.get(type) ?? []),
            ...prefixed.filter((p) => type.startsWith(p.prefix)).map((p) => p.member),
          ]
          const exclusive = claiming.filter((member) => member.exclusive === true)
          const candidates = exclusive.length > 0 ? exclusive : claiming
          // A member that can't read the row's key back (`unrecognizedKey`) isn't its owner: the
          // key names another member's key space. The search goes on, so the order members are
          // listed in doesn't choose one, and the row is counted unrecognized only when no member
          // recognises it.
          let unrecognized: { readonly member: RekeyMember; readonly tally: RekeyTally } | undefined
          for (const member of candidates) {
            const tally = yield* member.row(row, ctx)
            if (tally === undefined) continue
            if (onlyUnrecognized(tally)) {
              unrecognized ??= { member, tally }
              continue
            }
            totals.add(member.name, tally)
            return
          }
          if (unrecognized !== undefined) {
            totals.add(unrecognized.member.name, unrecognized.tally)
            return
          }
          totals.add(undefined, { skipped: { unregistered: 1 } })
        })

      const token = (): string | undefined =>
        positions.every((p) => p === 1) ? undefined : encodeToken(tableName, positions)
      const snapshot = (): RekeyReport => totals.report(dryRun, capacity(), token(), budget)

      let pagesLeft = options.maxPages ?? Number.POSITIVE_INFINITY
      const concurrency = options.concurrency ?? 4
      // The scan reads through the instrumented client; handlers read and write through the
      // journal's view of it, which `Capacity.client` hands them as is.
      const client = yield* Capacity.client
      const view = journal.view(client)
      const viaView = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.provideService(effect, DynamoClient, view)

      const scanSegment = (segment: number) =>
        Effect.gen(function* () {
          while (positions[segment] !== 1) {
            if (pagesLeft <= 0) return
            pagesLeft--
            const at = positions[segment]!
            const pageSeq = journal.seq
            const page = yield* client.scan({
              TableName: tableName,
              ...(positions.length > 1 && { Segment: segment, TotalSegments: positions.length }),
              ...(options.pageSize !== undefined && { Limit: options.pageSize }),
              ...(at !== 0 && { ExclusiveStartKey: keyFromWire(at) }),
            })
            yield* viaView(
              Effect.forEach(page.Items ?? [], (row) => handle(row, pageSeq), {
                concurrency,
                discard: true,
              }),
            )
            const last = page.LastEvaluatedKey as Item | undefined
            positions[segment] = last === undefined ? 1 : (keyToWire(last) ?? 1)
            if (options.onProgress !== undefined) yield* options.onProgress(snapshot())
          }
        })

      yield* Effect.forEach(
        positions.map((_, segment) => segment),
        scanSegment,
        { concurrency: "unbounded", discard: true },
      )
      for (const { member, judge } of atEnd) totals.add(member, judge())
      for (const member of members) {
        if (member.finish !== undefined) {
          totals.add(member.name, yield* viaView(member.finish(ctx)))
        }
      }
      return snapshot()
    }),
  )

/** Tallies added up, field by field. */
export const mergeTallies = (...tallies: ReadonlyArray<RekeyTally>): RekeyTally => {
  const moved: Partial<Record<RekeyRowKind, number>> = {}
  const skipped: Partial<Record<RekeySkipReason, number>> = {}
  const conflicts: Array<RekeyConflict> = []
  const reservations: Array<RekeyReservation> = []
  const ambiguous: Array<RekeyAmbiguity> = []
  const indexKeys: Partial<MutableIndexKeys> = {}
  const guardGaps: Partial<MutableGuardGaps> = {}
  const guardGapRows: Array<RekeyGuardGapRow> = []
  let unchanged = 0
  let indexKeysRewritten = 0
  let zonesRewritten = 0
  let sentinelsMoved = 0
  let worked = false
  for (const tally of tallies) {
    worked ||= tally.worked === true
    unchanged += tally.unchanged ?? 0
    indexKeysRewritten += tally.indexKeysRewritten ?? 0
    zonesRewritten += tally.zonesRewritten ?? 0
    sentinelsMoved += tally.sentinelsMoved ?? 0
    for (const count of INDEX_KEY_COUNTS) {
      const n = tally.indexKeys?.[count]
      if (n !== undefined) indexKeys[count] = (indexKeys[count] ?? 0) + n
    }
    for (const kind of ROW_KINDS) {
      const n = tally.moved?.[kind]
      if (n !== undefined) moved[kind] = (moved[kind] ?? 0) + n
    }
    for (const gap of GUARD_GAPS) {
      const n = tally.guardGaps?.[gap]
      if (n !== undefined) guardGaps[gap] = (guardGaps[gap] ?? 0) + n
    }
    for (const reason of SKIP_REASONS) {
      const n = tally.skipped?.[reason]
      if (n !== undefined) skipped[reason] = (skipped[reason] ?? 0) + n
    }
    for (const conflict of tally.conflicts ?? []) conflicts.push(conflict)
    for (const entry of tally.reservations ?? []) reservations.push(entry)
    for (const row of tally.guardGapRows ?? []) guardGapRows.push(row)
    for (const ambiguity of tally.ambiguous ?? []) ambiguous.push(ambiguity)
  }
  return {
    ...(unchanged > 0 && { unchanged }),
    ...(Object.keys(moved).length > 0 && { moved }),
    ...(indexKeysRewritten > 0 && { indexKeysRewritten }),
    ...(zonesRewritten > 0 && { zonesRewritten }),
    ...(sentinelsMoved > 0 && { sentinelsMoved }),
    ...(Object.keys(indexKeys).length > 0 && { indexKeys }),
    ...(reservations.length > 0 && { reservations }),
    ...(Object.keys(guardGaps).length > 0 && { guardGaps }),
    ...(guardGapRows.length > 0 && { guardGapRows }),
    ...(conflicts.length > 0 && { conflicts }),
    ...(Object.keys(skipped).length > 0 && { skipped }),
    ...(worked && { worked }),
    ...(ambiguous.length > 0 && { ambiguous }),
  }
}
