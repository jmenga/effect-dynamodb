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
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { ValidationError } from "@effect-dynamodb/schema/Errors.js"
import { Deferred, Effect, Option } from "effect"
import type { DynamoClient, DynamoClientError } from "../DynamoClient.js"
import type {
  RekeyConflict,
  RekeyCounts,
  RekeyMemberReport,
  RekeyOptions,
  RekeyReport,
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

type Item = Record<string, AttributeValue>

/** What a member's handler is told about the run. */
export interface RekeyRowContext {
  readonly tableName: string
  readonly dryRun: boolean
  /**
   * Claim a unit of rows that move together — an aggregate, an event stream —
   * for this run: `true` for the first row that claims it, `false` after.
   */
  readonly claim: (unit: string) => boolean
  /**
   * Do the work of a unit of rows that move together, once per run: the first caller runs it and
   * gets its tally. A later caller waits for that run to finish and gets an empty one, so a move
   * that needs another unit out of its way goes on once it is.
   */
  readonly once: <E, R>(
    unit: string,
    work: Effect.Effect<RekeyTally, E, R>,
  ) => Effect.Effect<RekeyTally, E, R>
}

/**
 * How many rows still to move a row's own move goes through first: one chain, `foo%20bar`'s row
 * where `foo bar`'s belongs and so on. Past it the row is reported, and the next run goes on.
 */
export const DISPLACE_DEPTH = 4

/** What a handler did with one scanned row (and the rows that moved with it). */
export interface RekeyTally {
  readonly unchanged?: number | undefined
  readonly moved?: Partial<Record<RekeyRowKind, number>> | undefined
  readonly indexKeysRewritten?: number | undefined
  readonly sentinelsMoved?: number | undefined
  readonly conflicts?: ReadonlyArray<RekeyConflict> | undefined
  readonly skipped?: Partial<Record<RekeySkipReason, number>> | undefined
}

/** A member's part in a run: the rows it may own, and its handler. */
export interface RekeyMember {
  /** The name it is reported under: an entity type, aggregate or stream name. */
  readonly name: string
  /** `__edd_e__` values of rows that may be the member's. */
  readonly types: ReadonlyArray<string>
  /** `__edd_e__` prefixes of rows that may be the member's (unique sentinels). */
  readonly typePrefixes?: ReadonlyArray<string> | undefined
  /** Handle one scanned row; `undefined` when it is not the member's after all. */
  readonly row: (
    row: Item,
    ctx: RekeyRowContext,
  ) => Effect.Effect<RekeyTally | undefined, DynamoClientError, DynamoClient | TableConfig>
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

interface MutableMember {
  unchanged: number
  moved: MutableCounts
  indexKeysRewritten: number
  sentinelsMoved: number
  conflicts: number
}

/** The run's counts, merged as handlers finish. */
class Totals {
  scanned = 0
  unchanged = 0
  moved = zeroCounts()
  indexKeysRewritten = 0
  sentinelsMoved = 0
  conflicts: Array<RekeyConflict> = []
  private readonly conflicted = new Set<string>()
  skipped: { -readonly [R in RekeySkipReason]: number } = {
    notLibrary: 0,
    unregistered: 0,
    unrecognizedKey: 0,
  }
  byMember = new Map<string, MutableMember>()

  add(member: string | undefined, tally: RekeyTally): void {
    const into =
      member === undefined
        ? undefined
        : (this.byMember.get(member) ??
          (() => {
            const fresh: MutableMember = {
              unchanged: 0,
              moved: zeroCounts(),
              indexKeysRewritten: 0,
              sentinelsMoved: 0,
              conflicts: 0,
            }
            this.byMember.set(member, fresh)
            return fresh
          })())
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
    const sentinels = tally.sentinelsMoved ?? 0
    this.sentinelsMoved += sentinels
    if (into !== undefined) into.sentinelsMoved += sentinels
    for (const conflict of tally.conflicts ?? []) {
      // A row that can't move is met again by what wants its key, and by the scan.
      const row = `${conflict.member}\u0000${conflict.kind}\u0000${JSON.stringify(conflict.key)}`
      if (this.conflicted.has(row)) continue
      this.conflicted.add(row)
      this.conflicts.push(conflict)
      if (into !== undefined) into.conflicts += 1
    }
    for (const reason of SKIP_REASONS) this.skipped[reason] += tally.skipped?.[reason] ?? 0
  }

  report(
    dryRun: boolean,
    capacity: Capacity.CapacityTotals,
    resume: string | undefined,
  ): RekeyReport {
    const byMember: Record<string, RekeyMemberReport> = {}
    for (const [name, m] of [...this.byMember.entries()].sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    )) {
      byMember[name] = {
        unchanged: m.unchanged,
        moved: { ...m.moved },
        indexKeysRewritten: m.indexKeysRewritten,
        sentinelsMoved: m.sentinelsMoved,
        conflicts: m.conflicts,
      }
    }
    return {
      dryRun,
      scanned: this.scanned,
      unchanged: this.unchanged,
      moved: { ...this.moved } as RekeyCounts,
      indexKeysRewritten: this.indexKeysRewritten,
      sentinelsMoved: this.sentinelsMoved,
      conflicts: [...this.conflicts],
      skipped: { ...this.skipped },
      byMember,
      capacity,
      resume: Option.fromUndefinedOr(resume),
    }
  }
}

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
        positiveInteger(options.maxPages, "maxPages")
      if (problem !== undefined) return yield* optionError(problem)

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

      const claimed = new Set<string>()
      const running = new Map<string, Deferred.Deferred<void>>()
      const ctx: RekeyRowContext = {
        tableName,
        dryRun,
        claim: (unit) => {
          if (claimed.has(unit)) return false
          claimed.add(unit)
          return true
        },
        once: (unit, work) =>
          Effect.suspend(() => {
            const under = running.get(unit)
            if (under !== undefined) return Effect.as(Deferred.await(under), {})
            const done = Deferred.makeUnsafe<void>()
            running.set(unit, done)
            return Effect.ensuring(work, Deferred.succeed(done, undefined))
          }),
      }
      const totals = new Totals()

      const handle = (row: Item) =>
        Effect.gen(function* () {
          const type = row.__edd_e__?.S
          if (type === undefined) {
            totals.add(undefined, { skipped: { notLibrary: 1 } })
            return
          }
          const candidates = [
            ...(byType.get(type) ?? []),
            ...prefixed.filter((p) => type.startsWith(p.prefix)).map((p) => p.member),
          ]
          for (const member of candidates) {
            const tally = yield* member.row(row, ctx)
            if (tally === undefined) continue
            totals.add(member.name, tally)
            return
          }
          totals.add(undefined, { skipped: { unregistered: 1 } })
        })

      const token = (): string | undefined =>
        positions.every((p) => p === 1) ? undefined : encodeToken(tableName, positions)
      const snapshot = (): RekeyReport => totals.report(dryRun, capacity(), token())

      let pagesLeft = options.maxPages ?? Number.POSITIVE_INFINITY
      const concurrency = options.concurrency ?? 4
      const client = yield* Capacity.client

      const scanSegment = (segment: number) =>
        Effect.gen(function* () {
          while (positions[segment] !== 1) {
            if (pagesLeft <= 0) return
            pagesLeft--
            const at = positions[segment]!
            const page = yield* client.scan({
              TableName: tableName,
              ...(positions.length > 1 && { Segment: segment, TotalSegments: positions.length }),
              ...(options.pageSize !== undefined && { Limit: options.pageSize }),
              ...(at !== 0 && { ExclusiveStartKey: keyFromWire(at) }),
            })
            const rows = page.Items ?? []
            totals.scanned += rows.length
            yield* Effect.forEach(rows, handle, { concurrency, discard: true })
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
      for (const member of members) {
        if (member.finish !== undefined) totals.add(member.name, yield* member.finish(ctx))
      }
      return snapshot()
    }),
  )

/** Tallies added up, field by field. */
/**
 * Get a row out of the way of another row's move, `run` being its own handler under the context
 * given: for real in a real run. In a dry run nothing moves, so the row is only judged, under a
 * context that counts nothing and takes no claim, since the scan counts it when it reaches it:
 * what comes back is what would stop it, the same conflicts the real run gets, and so a dry run
 * agrees with the real run about a chain. A row that's met more than once is reported once
 * ({@link RekeyReport.conflicts}).
 */
export const displace = <E, R>(
  ctx: RekeyRowContext,
  run: (ctx: RekeyRowContext) => Effect.Effect<RekeyTally | undefined, E, R>,
): Effect.Effect<RekeyTally, E, R> =>
  ctx.dryRun
    ? Effect.map(
        run({ ...ctx, claim: () => false, once: (_unit, work) => work }),
        (tally): RekeyTally =>
          (tally?.conflicts ?? []).length > 0 ? { conflicts: tally!.conflicts! } : {},
      )
    : Effect.map(run(ctx), (tally): RekeyTally => tally ?? {})

export const mergeTallies = (...tallies: ReadonlyArray<RekeyTally>): RekeyTally => {
  const moved: Partial<Record<RekeyRowKind, number>> = {}
  const skipped: Partial<Record<RekeySkipReason, number>> = {}
  const conflicts: Array<RekeyConflict> = []
  let unchanged = 0
  let indexKeysRewritten = 0
  let sentinelsMoved = 0
  for (const tally of tallies) {
    unchanged += tally.unchanged ?? 0
    indexKeysRewritten += tally.indexKeysRewritten ?? 0
    sentinelsMoved += tally.sentinelsMoved ?? 0
    for (const kind of ROW_KINDS) {
      const n = tally.moved?.[kind]
      if (n !== undefined) moved[kind] = (moved[kind] ?? 0) + n
    }
    for (const reason of SKIP_REASONS) {
      const n = tally.skipped?.[reason]
      if (n !== undefined) skipped[reason] = (skipped[reason] ?? 0) + n
    }
    for (const conflict of tally.conflicts ?? []) conflicts.push(conflict)
  }
  return {
    ...(unchanged > 0 && { unchanged }),
    ...(Object.keys(moved).length > 0 && { moved }),
    ...(indexKeysRewritten > 0 && { indexKeysRewritten }),
    ...(sentinelsMoved > 0 && { sentinelsMoved }),
    ...(conflicts.length > 0 && { conflicts }),
    ...(Object.keys(skipped).length > 0 && { skipped }),
  }
}
