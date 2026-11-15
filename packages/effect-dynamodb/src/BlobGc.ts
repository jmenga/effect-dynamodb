/**
 * BlobGc — garbage collection of offloaded values (#179).
 *
 * Every write of an offloaded field (`DynamoModel.Packed({ external })`,
 * `DynamoModel.External()`) uploads a new object version, so superseded
 * versions accumulate until something deletes them. GC is opt-in:
 *
 * ```ts
 * const gc = yield* BlobGc.make({
 *   entities: { Documents }, aggregates: { Orders }, streams: { Ledger },
 *   reaper: { gracePeriod: "15 minutes", confirm: "auto" },
 *   sweep: { gracePeriod: "1 day" },
 * })
 * yield* gc.reap(event.Records)                   // a Lambda / Pipes batch (records name their table)
 * yield* gc.reap(batch.records, { table: batch.streamArn }) // a change feed batch
 * yield* gc.sweep("Documents", { docId: "d-1" })  // one item family
 * yield* gc.sweepPartition("Orders", { orderId: "o-1" })
 * yield* Stream.runDrain(gc.sweepStore())         // the whole store, resumable
 * ```
 *
 * - **Table-local.** A version is a member's own only when its key's
 *   partition and family hashes are the ones the member computes from its own
 *   table name and the row's keys: a restored or copied table never deletes
 *   its source's versions (they are `foreign`), nor the source its copy's.
 * - **The reaper** (`reap`) reads each record as the members on the table it
 *   came from (its `eventSourceARN` or `tableName`, or the call's `table`)
 *   and frees each own pointer its `OldImage` holds that its `NewImage` does
 *   not, after a grace (default 15 minutes):
 *   directly for plain entities, aggregate edges and EventStore snapshots;
 *   for `retain`, `softDelete` and `timeSeries` entities (or every entity,
 *   with `confirm: "always"`) only once a confirm-read of the item family —
 *   its sort-key ranges bracketed by strongly consistent reads of the live
 *   row — finds no row still holding it.
 * - **The sweeps** list a family's own versions and delete one only when a
 *   later pass finds it still unreferenced at least the sweep grace (default
 *   24 hours) after an earlier pass marked it; marks are the store's
 *   unreferenced-since tags. `sweepStore` walks the store's listing and
 *   sweeps each own item family an object's metadata names.
 *
 * `BlobGc.make` resolves the `BlobStore`, `DynamoClient` and each member's
 * `TableConfig` once; the collector's operations have no requirements.
 *
 * See `DESIGN.md §7 "Offloaded Storage"` and `docs/designs/blob-offload.md`
 * §11.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import type { EntityDefinition } from "@effect-dynamodb/schema/Entity.js"
import { type BlobStoreError, ValidationError } from "@effect-dynamodb/schema/Errors.js"
import type { BlobRef } from "@effect-dynamodb/schema/internal/BlobPointer.js"
import { Clock, Context, Duration, Effect, Option, type Schema, Stream } from "effect"
import type { Aggregate } from "./Aggregate.js"
import { BlobStore } from "./BlobStore.js"
import type { DynamoClient, DynamoClientError, DynamoClientService } from "./DynamoClient.js"
import { type Key as EntityKey, fromDefinition as entityFromDefinition } from "./Entity.js"
import { type EventStream, type StreamIdInput, storeRequirementsOf } from "./EventStore.js"
import { attributeValueEquals } from "./internal/AttributeValueEquals.js"
import { type BlobCallContext, call, refKey } from "./internal/BlobCalls.js"
import {
  familyHash,
  type KeyAttributeValue,
  partitionHash,
  STREAM_FAMILY_SK,
} from "./internal/BlobKeys.js"
import * as BlobMetadata from "./internal/BlobMetadata.js"
import type { BlobListing, BlobStoreService } from "./internal/BlobStoreContract.js"
import * as Capacity from "./internal/Capacity.js"
import * as GcSupport from "./internal/GcSupport.js"
import { recordImages, type StreamRecordLike } from "./internal/OffloadChange.js"
import {
  aggregateStoreRequirements,
  entityStoreRequirements,
  missingStoreError,
  type OffloadInfo,
  offloadedAttributes,
  type StoreRequirement,
  unescapedKeysError,
} from "./internal/OffloadWrite.js"
import { imageEntityType, normalizeImageSync } from "./internal/Packed.js"
import { compareUtf8 } from "./internal/Utf8Order.js"
import type { TableConfig } from "./Table.js"

export type { StreamRecordLike }

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Which entity members the reaper confirm-reads before freeing: `"auto"`
 * (default) those whose current config copies pointers between an item
 * family's rows — `retain`, `softDelete`, `timeSeries` — reading only the
 * ranges that config populates; `"always"` every entity member, reading every
 * range. Use `"always"` for an entity whose `retain` or `softDelete` was
 * turned off while its history rows still exist, or whose rows other tooling
 * copies.
 */
export type ConfirmMode = "auto" | "always"

/** Options of the reaper (`gc.reap`). */
export interface ReaperOptions {
  /**
   * How long after a record a version it superseded is freed (default 15
   * minutes, at least 0): it covers GSI and eventually consistent reads,
   * replica reads, lazy handles and presigned URLs of the superseded row. A
   * Lambda reaper sets a shorter one (the grace is spent inside the call).
   */
  readonly gracePeriod?: Duration.Input | undefined
  readonly confirm?: ConfirmMode | undefined
}

/** Options of one `gc.reap` call. */
export interface ReapOptions {
  /**
   * The table the records were read from: its name, or its table or stream
   * ARN (a change feed batch's `streamArn`). A record that names its table
   * itself — `eventSourceARN` (Lambda, EventBridge Pipes), `tableName`
   * (Kinesis Data Streams) — must name this one. Required for records that
   * do not name their table when the collector's members are on more than
   * one table; otherwise such records are taken to come from the members'
   * table — so feed a collector only its own tables' records.
   */
  readonly table?: string | undefined
}

/** Options of the sweeps (`gc.sweep`, `gc.sweepPartition`, `gc.sweepStore`). */
export interface SweepOptions {
  /**
   * How long a version must stay unreferenced, from the pass that marked it,
   * before a later pass deletes it: at least 1 hour and at least the store's
   * `maxUploadAge` + 15 minutes; default the larger of 24 hours and that. For
   * a table whose point-in-time restores must be whole, at least the restore
   * window, with no reaper.
   */
  readonly gracePeriod?: Duration.Input | undefined
}

/** The members a collector covers, and its settings. */
export interface MakeOptions<TEntities, TAggregates, TStreams> {
  /** Entities with an offloaded field, by the name the collector's sweeps take. */
  readonly entities?: TEntities | undefined
  /** Aggregates with an offloading edge entity. */
  readonly aggregates?: TAggregates | undefined
  /** EventStore streams whose event `data` or snapshot `state` offloads. */
  readonly streams?: TStreams | undefined
  readonly reaper?: ReaperOptions | undefined
  readonly sweep?: SweepOptions | undefined
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

/** What one `gc.reap` call did. */
export interface ReapReport {
  /** The records of the call. */
  readonly records: number
  /** Distinct own versions the records superseded. */
  readonly candidates: number
  /** Candidates deleted. */
  readonly freed: number
  /**
   * Candidates kept: a row of their item family still holds them, or the
   * family's live row kept changing while it was read ("family busy").
   */
  readonly retained: number
  /** Distinct superseded versions that are not the member's own (another table's). */
  readonly foreign: number
  /**
   * Records that can supersede nothing: of a type no member on their table
   * declares, `INSERT`s, a `retain` entity's live-row `MODIFY` (the same
   * write snapshotted the old value), an EventStore event (immutable).
   */
  readonly skipped: number
}

/** What one sweep of an item family or partition did. */
export interface SweepReport {
  /** Distinct own versions its rows reference. */
  readonly referenced: number
  /** Versions listed under its own prefixes. */
  readonly listed: number
  /** Unreferenced versions marked unreferenced-since now. */
  readonly marked: number
  /** Unreferenced versions marked at least the grace ago, deleted. */
  readonly deleted: number
  /** Unreferenced versions too young to mark: their write may still be in flight. */
  readonly retainedYoung: number
  /** Distinct versions its rows reference that are not its own (another table's). */
  readonly foreign: number
  /**
   * The rows kept changing while they were read (three attempts): nothing was
   * listed, marked or deleted. Sweep again later.
   */
  readonly busy: boolean
}

/** One item family a store-wide sweep met, in listing order. */
export type StoreSweepFamily =
  | {
      readonly _tag: "Swept"
      /** The family's key prefix (`<prefix>P/F/`): `startAfter` resumes after it. */
      readonly familyPrefix: string
      /** The member it belongs to, by its name in `BlobGc.make`. */
      readonly member: string
      readonly report: SweepReport
    }
  | {
      /**
       * Not a member's: another table's (`table`), an entity type no member
       * declares, or objects whose metadata the library did not write
       * (`table` none). Never deleted.
       */
      readonly _tag: "Foreign"
      readonly familyPrefix: string
      readonly table: Option.Option<string>
    }
  | {
      /**
       * Objects whose metadata has no row key (it was too long for it, so
       * only its SHA-256 is recorded): handle by hand.
       */
      readonly _tag: "Unattributable"
      readonly familyPrefix: string
      readonly versions: number
      readonly bytes: number
    }

/** Options of `gc.sweepStore`. */
export interface SweepStoreOptions {
  /** List under this prefix; default the store prefix and every member's `offload.prefix`. */
  readonly prefix?: string | undefined
  /** Resume after this family prefix (a `familyPrefix` an earlier run emitted). */
  readonly startAfter?: string | undefined
  /** Stop after this many families (a positive integer). */
  readonly maxFamilies?: number | undefined
}

/** What the collector's operations fail with. */
export type GcError = DynamoClientError | BlobStoreError | ValidationError

// ---------------------------------------------------------------------------
// The collector
// ---------------------------------------------------------------------------

/** The members `BlobGc.make` takes. */
export type EntityMember = { readonly _tag: "Entity" }
export type AggregateMember = Aggregate<any, any, any, any, any>
export type StreamMember = EventStream<any, any, any, any, any, any, any, any>

/** The key `gc.sweep` takes for an entity member. */
export type SweepKey<E> = E extends { readonly model: Schema.Top; readonly indexes: any }
  ? EntityKey<E>
  : never

/** The key `gc.sweepPartition` takes for an aggregate (its key) or a stream (its id). */
export type PartitionKey<M> =
  M extends Aggregate<any, infer K, any, any, any>
    ? K
    : M extends EventStream<any, infer F, any, any, any, any, any, any>
      ? StreamIdInput<F>
      : never

/** The garbage collector `BlobGc.make` returns: no operation has a requirement. */
export interface Collector<TEntities, TAggregates, TStreams> {
  /**
   * Reap one batch of DynamoDB Streams records (NEW_AND_OLD_IMAGES): every
   * record is checked before any is acted on (`[EDD-9119]`, a defect; and
   * `[EDD-9118]` when its table is unknown or contradicts `options.table`),
   * then each own version a record superseded is freed after the reaper
   * grace by the rule of the member on the record's table. Deletes are
   * idempotent: at-least-once delivery, duplicates and reordering are
   * harmless.
   */
  readonly reap: (
    records: Iterable<StreamRecordLike>,
    options?: ReapOptions,
  ) => Effect.Effect<ReapReport, GcError>
  /** Sweep one entity item family (every row of it, whatever the member's config). */
  readonly sweep: <K extends keyof TEntities & string>(
    member: K,
    key: SweepKey<TEntities[K]>,
  ) => Effect.Effect<SweepReport, GcError>
  /** Sweep an aggregate's partition, or a stream's (every event of it). */
  readonly sweepPartition: <K extends (keyof TAggregates | keyof TStreams) & string>(
    member: K,
    key: PartitionKey<
      K extends keyof TAggregates ? TAggregates[K] : K extends keyof TStreams ? TStreams[K] : never
    >,
  ) => Effect.Effect<SweepReport, GcError>
  /**
   * List the store (default: the store prefix and every member's
   * `offload.prefix`) and sweep each own item family an object's metadata
   * names — the backstop for leaks no row records. Needs `list`, `head` and
   * `marks` (`[EDD-9118]`).
   */
  readonly sweepStore: (options?: SweepStoreOptions) => Stream.Stream<StoreSweepFamily, GcError>
}

// ---------------------------------------------------------------------------
// make
// ---------------------------------------------------------------------------

const DEFAULT_REAPER_GRACE = Duration.minutes(15)
const DEFAULT_SWEEP_GRACE = Duration.hours(24)
const MIN_SWEEP_GRACE = Duration.hours(1)

const OPTION_KEYS: ReadonlySet<string> = new Set([
  "entities",
  "aggregates",
  "streams",
  "reaper",
  "sweep",
])
const REAPER_KEYS: ReadonlySet<string> = new Set(["gracePeriod", "confirm"])
const SWEEP_KEYS: ReadonlySet<string> = new Set(["gracePeriod"])
const SWEEP_STORE_KEYS: ReadonlySet<string> = new Set(["prefix", "startAfter", "maxFamilies"])
const REAP_KEYS: ReadonlySet<string> = new Set(["table"])

const show = (value: unknown): string => {
  try {
    return typeof value === "string" ? JSON.stringify(value) : String(value)
  } catch {
    return typeof value
  }
}

/** A `[EDD-9118]` configuration error. */
const invalid = (where: string, message: string): Error =>
  new Error(`[EDD-9118] ${where}: ${message}`)

const checkKeys = (where: string, what: string, value: unknown, keys: ReadonlySet<string>) => {
  if (value === undefined) return
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid(where, `${what} must be an object, got ${show(value)}.`)
  }
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) {
      throw invalid(where, `unknown option ${what === "options" ? "" : `${what}.`}${key}.`)
    }
  }
}

const durationOf = (value: unknown): Duration.Duration | undefined => {
  try {
    return Option.getOrUndefined(Duration.fromInput(value as Duration.Input))
  } catch {
    return undefined
  }
}

/** A table or stream ARN: `arn:<partition>:dynamodb:<region>:<account>:table/<name>[/…]`. */
const TABLE_ARN = /^arn:[^:]+:dynamodb:[^:]*:[^:]*:table\/([^/]+)(?:\/.*)?$/

/**
 * A table's name from its name, or a DynamoDB table or stream ARN;
 * `undefined` for any other ARN (a Kinesis stream's, say).
 */
const tableNameOf = (value: string): string | undefined =>
  value.startsWith("arn:") ? TABLE_ARN.exec(value)?.[1] : value

interface EntityEntry {
  readonly name: string
  /** The table name the member's requests and object keys use (`TableConfig.name`). */
  readonly table: string
  /** That table's name as a stream record names it (an ARN's name part). */
  readonly tableName: string
  readonly support: GcSupport.EntityGcSupport
  readonly offload: OffloadInfo
}
interface AggregateEntry {
  readonly name: string
  readonly table: string
  readonly tableName: string
  readonly support: GcSupport.AggregateGcSupport
}
interface StreamEntry {
  readonly name: string
  readonly table: string
  readonly tableName: string
  readonly support: GcSupport.StreamGcSupport
}

/**
 * Make a garbage collector for the members' offloaded values. Resolves the
 * `BlobStore` (`[EDD-9115]` without one), `DynamoClient` and each member's
 * `TableConfig` once. A member on a table whose schema doesn't set
 * `escapeKeys: true` is refused first (`[EDD-9146]`, a defect), as every
 * binding refuses it.
 *
 * @throws `[EDD-9118]` (a defect) when an option is unknown or invalid — a
 *   reaper grace that is not a non-negative duration; a sweep grace under 1
 *   hour or under the store's `maxUploadAge` + 15 minutes; a `confirm` other
 *   than `"auto"` / `"always"` — or a member is not an effect-dynamodb
 *   member, is not registered on a table, has no offloaded field, or shares
 *   its name with a member `sweepPartition` also takes, or no member is given.
 */
export const make = <
  const TEntities extends Record<string, EntityMember> = Record<never, never>,
  const TAggregates extends Record<string, AggregateMember> = Record<never, never>,
  const TStreams extends Record<string, StreamMember> = Record<never, never>,
>(
  options: MakeOptions<TEntities, TAggregates, TStreams>,
): Effect.Effect<Collector<TEntities, TAggregates, TStreams>, never, DynamoClient | TableConfig> =>
  Effect.gen(function* () {
    const where = "BlobGc.make"
    checkKeys(where, "options", options, OPTION_KEYS)
    if (options === undefined || options === null) throw invalid(where, "options are required.")
    checkKeys(where, "reaper", options.reaper, REAPER_KEYS)
    checkKeys(where, "sweep", options.sweep, SWEEP_KEYS)
    const reaperGrace =
      options.reaper?.gracePeriod === undefined
        ? DEFAULT_REAPER_GRACE
        : durationOf(options.reaper.gracePeriod)
    if (
      reaperGrace === undefined ||
      !Duration.isFinite(reaperGrace) ||
      Duration.isLessThan(reaperGrace, Duration.zero)
    ) {
      throw invalid(
        where,
        `reaper.gracePeriod must be a non-negative duration, got ${show(options.reaper?.gracePeriod)}.`,
      )
    }
    const confirm = options.reaper?.confirm ?? "auto"
    if (confirm !== "auto" && confirm !== "always") {
      throw invalid(where, `reaper.confirm must be "auto" or "always", got ${show(confirm)}.`)
    }

    const context = Capacity.detachContext(yield* Effect.context<DynamoClient | TableConfig>())
    const store = Context.getOrUndefined(context, BlobStore)
    const inFlight = store === undefined ? undefined : GcSupport.inFlightAge(store)

    // Members.
    const entities: Array<EntityEntry> = []
    const aggregates: Array<AggregateEntry> = []
    const streams: Array<StreamEntry> = []
    // What each member offloads, and whether its table's key text is escaped.
    const requirements: Array<StoreRequirement> = []
    const tableOf = (
      kind: string,
      name: string,
      tag: Context.Service<TableConfig, TableConfig> | undefined,
    ) =>
      Effect.gen(function* () {
        if (tag === undefined) {
          throw invalid(
            where,
            `${kind} "${name}" is not registered on a table: register it with Table.make first.`,
          )
        }
        return (yield* tag).name
      })
    for (const [name, raw] of Object.entries(options.entities ?? {})) {
      // A pure definition (`@effect-dynamodb/schema`'s `Entity.make`) is
      // promoted, as `DynamoClient.make` promotes it.
      const member =
        typeof (raw as { readonly get?: unknown }).get !== "function" &&
        typeof (raw as { readonly _config?: unknown })._config === "object" &&
        typeof (raw as { readonly _data?: unknown })._data === "object"
          ? entityFromDefinition(raw as unknown as EntityDefinition)
          : raw
      const support = GcSupport.supportOf(member)
      if (support?.kind !== "entity") {
        throw invalid(where, `entities.${name} is not an effect-dynamodb entity.`)
      }
      if (support.offload === undefined) {
        throw invalid(where, `entity "${name}" has no offloaded field: GC has nothing to collect.`)
      }
      const table = yield* tableOf("entity", name, support.tableTag())
      requirements.push(...entityStoreRequirements(`entity "${name}"`, member))
      entities.push({
        name,
        table,
        tableName: tableNameOf(table) ?? table,
        support,
        offload: support.offload,
      })
    }
    for (const [name, member] of Object.entries(options.aggregates ?? {})) {
      const support = GcSupport.supportOf(member)
      if (support?.kind !== "aggregate") {
        throw invalid(where, `aggregates.${name} is not an effect-dynamodb aggregate.`)
      }
      if (support.edges.size === 0) {
        throw invalid(
          where,
          `aggregate "${name}" has no offloading edge entity: GC has nothing to collect.`,
        )
      }
      const table = yield* tableOf("aggregate", name, support.tableTag())
      requirements.push(...aggregateStoreRequirements(`aggregate "${name}"`, member))
      aggregates.push({ name, table, tableName: tableNameOf(table) ?? table, support })
    }
    for (const [name, member] of Object.entries(options.streams ?? {})) {
      const support = GcSupport.supportOf(member)
      if (support?.kind !== "stream") {
        throw invalid(where, `streams.${name} is not an EventStore stream.`)
      }
      if (support.event === undefined && support.snapshot === undefined) {
        throw invalid(
          where,
          `stream "${name}" offloads neither event data nor snapshot state: GC has nothing to collect.`,
        )
      }
      const table = yield* tableOf("stream", name, support.tableTag())
      requirements.push(...storeRequirementsOf(member as never))
      streams.push({ name, table, tableName: tableNameOf(table) ?? table, support })
    }
    for (const { name } of aggregates) {
      if (streams.some((stream) => stream.name === name)) {
        throw invalid(
          where,
          `"${name}" names both an aggregate and a stream: sweepPartition takes one name each.`,
        )
      }
    }
    if (entities.length + aggregates.length + streams.length === 0) {
      throw invalid(where, "no member is given: pass entities, aggregates or streams.")
    }

    // Offloading requires escaped key text (`[EDD-9146]`, design §11.10): GC
    // finds a version's owner from the key text its object is named after, so
    // it collects for members whose rows can be written nowhere else. Checked
    // before the store, as every binding checks it.
    const keysError = unescapedKeysError(where, requirements)
    if (keysError !== undefined) throw keysError
    const storeError = missingStoreError(where, requirements, store)
    if (storeError !== undefined || store === undefined || inFlight === undefined) {
      throw storeError ?? new Error("[EDD-9115] BlobGc.make: no BlobStore is resolvable.")
    }

    const sweepGrace =
      options.sweep?.gracePeriod === undefined
        ? Duration.max(DEFAULT_SWEEP_GRACE, inFlight)
        : durationOf(options.sweep.gracePeriod)
    if (
      sweepGrace === undefined ||
      !Duration.isFinite(sweepGrace) ||
      Duration.isLessThan(sweepGrace, MIN_SWEEP_GRACE) ||
      Duration.isLessThan(sweepGrace, inFlight)
    ) {
      throw invalid(
        where,
        "sweep.gracePeriod must be a duration of at least 1 hour and at least the store's " +
          `maxUploadAge + 15 minutes (${Duration.format(inFlight)}), got ` +
          `${show(options.sweep?.gracePeriod)}.`,
      )
    }

    const gc = makeCollector({
      store,
      entities,
      aggregates,
      streams,
      reaperGrace,
      confirm,
      sweepGrace,
    })
    const provide = <A, E>(effect: Effect.Effect<A, E, DynamoClient>): Effect.Effect<A, E> =>
      Effect.provide(effect, context)
    return {
      reap: (records, reapOptions) =>
        provide(Capacity.operation("BlobGc.reap", undefined, gc.reap(records, reapOptions))),
      sweep: (member, key) =>
        provide(Capacity.operation("BlobGc.sweep", { target: member }, gc.sweep(member, key))),
      sweepPartition: (member, key) =>
        provide(
          Capacity.operation(
            "BlobGc.sweepPartition",
            { target: member },
            gc.sweepPartition(member, key),
          ),
        ),
      sweepStore: (storeOptions) =>
        Stream.unwrap(
          provide(
            Capacity.operationStream("BlobGc.sweepStore", undefined, gc.sweepStore(storeOptions)),
          ),
        ).pipe(Stream.provideContext(context)),
    } satisfies Collector<TEntities, TAggregates, TStreams>
  })

// ---------------------------------------------------------------------------
// The collector's operations
// ---------------------------------------------------------------------------

interface CollectorSettings {
  readonly store: BlobStoreService
  readonly entities: ReadonlyArray<EntityEntry>
  readonly aggregates: ReadonlyArray<AggregateEntry>
  readonly streams: ReadonlyArray<StreamEntry>
  readonly reaperGrace: Duration.Duration
  readonly confirm: ConfirmMode
  readonly sweepGrace: Duration.Duration
}

const BUSY: SweepReport = {
  referenced: 0,
  listed: 0,
  marked: 0,
  deleted: 0,
  retainedYoung: 0,
  foreign: 0,
  busy: true,
}

/** One attribute, or `"(several)"`, for the context of a call covering several. */
const oneOrSeveral = (values: Iterable<string>): string => {
  const distinct = new Set(values)
  return distinct.size === 1 ? [...distinct][0]! : "(several)"
}

const S = (value: string): KeyAttributeValue => ({ S: value })

/** A stored attribute's string value (an unmarshalled image's, or `{ S }`). */
const stringOf = (value: unknown): string | undefined => {
  if (typeof value === "string") return value
  const s = (value as { readonly S?: unknown } | null | undefined)?.S
  return typeof s === "string" ? s : undefined
}

/** A superseded version a record names, and who would free it how. */
interface Candidate {
  readonly ref: BlobRef
  readonly entityType: string
  readonly attribute: string
  /** The confirm-read that must clear it first; `undefined` frees it directly. */
  readonly confirm:
    | {
        readonly member: EntityEntry
        readonly family: GcSupport.EntityFamily
        readonly ranges: ReadonlySet<GcSupport.FamilyRange>
      }
    | undefined
}

/** What one member's reading of one record gives. */
type Reading =
  | { readonly _tag: "skip" }
  | {
      readonly _tag: "act"
      readonly candidates: ReadonlyArray<Candidate>
      readonly foreign: ReadonlyArray<BlobRef>
    }

const SKIP: Reading = { _tag: "skip" }

/** The own and foreign versions `attributes` of `oldImage` hold that `newImage` does not. */
const superseded = (
  oldImage: Readonly<Record<string, unknown>>,
  newImage: Readonly<Record<string, unknown>> | undefined,
  attributes: ReadonlyArray<string>,
  segment: string | undefined,
  candidate: (ref: BlobRef, attribute: string) => Candidate,
): Reading => {
  const candidates: Array<Candidate> = []
  const foreign: Array<BlobRef> = []
  for (const attribute of attributes) {
    const before = GcSupport.pointerOf(oldImage[attribute])
    if (before === undefined) continue
    const after = newImage === undefined ? undefined : GcSupport.pointerOf(newImage[attribute])
    if (after !== undefined && GcSupport.sameRef(before.ref, after.ref)) continue
    const own =
      segment !== undefined &&
      GcSupport.leadingPrefix(before.ref.key, segment, GcSupport.FAMILY_REST) !== undefined
    if (own) candidates.push(candidate(before.ref, attribute))
    else foreign.push(before.ref)
  }
  return { _tag: "act", candidates, foreign }
}

/**
 * When a record was written, in epoch milliseconds: a `Date` (the SDK); a
 * number in the unit `ApproximateCreationDateTimePrecision` names (Kinesis
 * Data Streams: `MILLISECOND` / `MICROSECOND`), else by magnitude — epoch
 * seconds (DynamoDB Streams JSON: Lambda, Pipes) below `1e11`, milliseconds
 * below `1e14`, microseconds above. `now` when it does not say, and never
 * later than `now`: a malformed time can delay a batch by the grace at most.
 */
const recordTime = (record: StreamRecordLike, now: number): number => {
  const at = record.dynamodb?.ApproximateCreationDateTime
  let millis = now
  if (at instanceof Date) {
    millis = at.getTime()
  } else if (typeof at === "number") {
    const precision = record.dynamodb?.ApproximateCreationDateTimePrecision
    millis =
      precision === "MICROSECOND"
        ? at / 1000
        : precision === "MILLISECOND"
          ? at
          : at < 1e11
            ? at * 1000
            : at < 1e14
              ? at
              : at / 1000
  }
  return Number.isFinite(millis) ? Math.min(millis, now) : now
}

/**
 * The table a record names itself: a DynamoDB `eventSourceARN`'s (Lambda,
 * Pipes) or its `tableName` (Kinesis Data Streams); a string saying why
 * when the two disagree.
 */
const namedTable = (
  record: StreamRecordLike,
): { readonly table: string | undefined } | { readonly conflict: string } => {
  const arn = record.eventSourceARN
  const fromArn = typeof arn === "string" ? tableNameOf(arn) : undefined
  const fromName = typeof record.tableName === "string" ? record.tableName : undefined
  if (fromArn !== undefined && fromName !== undefined && fromArn !== fromName) {
    return {
      conflict: `its eventSourceARN names table "${fromArn}" and its tableName "${fromName}"`,
    }
  }
  return { table: fromArn ?? fromName }
}

const makeCollector = (settings: CollectorSettings) => {
  const { store } = settings

  const requireCapabilities = (
    operation: string,
    needs: ReadonlyArray<"list" | "head" | "marks">,
  ): Effect.Effect<void> => {
    const missing = needs.filter((capability) => store[capability] === undefined)
    return missing.length === 0
      ? Effect.void
      : Effect.die(
          invalid(
            operation,
            `the store ${store.name} lacks ${missing.join(", ")}, which ${operation} needs ` +
              `(${needs.join(", ")}).`,
          ),
        )
  }

  // -------------------------------------------------------------------------
  // reap (§11.3)
  // -------------------------------------------------------------------------

  const entitiesByType = new Map<string, Array<EntityEntry>>()
  for (const m of settings.entities) {
    const list = entitiesByType.get(m.support.entityType) ?? []
    list.push(m)
    entitiesByType.set(m.support.entityType, list)
  }

  const readEntity = (
    m: EntityEntry,
    eventName: "INSERT" | "MODIFY" | "REMOVE",
    oldImage: Readonly<Record<string, unknown>>,
    newImage: Readonly<Record<string, unknown>> | undefined,
  ): Reading => {
    const { support } = m
    const pk = stringOf(oldImage[support.pkField])
    const sk = stringOf(oldImage[support.skField])
    const liveSk = support.liveSkOfRow(oldImage)
    // A retain update or delete snapshotted the old value in the same write.
    if (support.lifecycle.retain && eventName === "MODIFY" && sk !== undefined && sk === liveSk) {
      return SKIP
    }
    const family = pk === undefined || liveSk === undefined ? undefined : { pk, liveSk }
    const confirms =
      settings.confirm === "always" ||
      support.lifecycle.retain ||
      support.lifecycle.softDelete ||
      support.lifecycle.timeSeries
    const ranges =
      settings.confirm === "always" ? GcSupport.ALL_RANGES : GcSupport.autoRanges(support.lifecycle)
    return superseded(
      oldImage,
      newImage,
      offloadedAttributes(m.offload),
      family === undefined
        ? undefined
        : GcSupport.familySegment(m.table, S(family.pk), S(family.liveSk)),
      (ref, attribute) => ({
        ref,
        entityType: support.entityType,
        attribute,
        confirm: confirms && family !== undefined ? { member: m, family, ranges } : undefined,
      }),
    )
  }

  const readAggregate = (
    m: AggregateEntry,
    info: OffloadInfo,
    oldImage: Readonly<Record<string, unknown>>,
    newImage: Readonly<Record<string, unknown>> | undefined,
  ): Reading => {
    const pk = stringOf(oldImage[m.support.pkField])
    const sk = stringOf(oldImage[m.support.skField])
    return superseded(
      oldImage,
      newImage,
      offloadedAttributes(info),
      pk === undefined || sk === undefined
        ? undefined
        : GcSupport.familySegment(m.table, S(pk), S(sk)),
      (ref, attribute) => ({ ref, entityType: info.entityType, attribute, confirm: undefined }),
    )
  }

  const readStream = (
    m: StreamEntry,
    type: string,
    oldImage: Readonly<Record<string, unknown>>,
    newImage: Readonly<Record<string, unknown>> | undefined,
  ): Reading | undefined => {
    if (type === m.support.eventType) return m.support.event === undefined ? undefined : SKIP
    const info = m.support.snapshot
    if (type !== m.support.snapshotType || info === undefined) return undefined
    const pk = stringOf(oldImage[m.support.pkField])
    return superseded(
      oldImage,
      newImage,
      offloadedAttributes(info),
      pk === undefined ? undefined : GcSupport.familySegment(m.table, S(pk), STREAM_FAMILY_SK),
      (ref, attribute) => ({ ref, entityType: info.entityType, attribute, confirm: undefined }),
    )
  }

  /**
   * The reading of a record's images by every member on its table `table`
   * whose type it carries, `[]` when it is no such member's. Only those: a
   * member computes ownership from its own table and the record's keys, so a
   * copied row read as another table's member would make the copy's pointers
   * look like that member's own (§11.2).
   */
  const readingsOf = (
    type: string,
    table: string,
    eventName: "INSERT" | "MODIFY" | "REMOVE",
    oldImage: Readonly<Record<string, unknown>>,
    newImage: Readonly<Record<string, unknown>> | undefined,
  ): Array<Reading> => {
    const readings: Array<Reading> = []
    for (const m of entitiesByType.get(type) ?? []) {
      if (m.tableName === table) readings.push(readEntity(m, eventName, oldImage, newImage))
    }
    for (const m of settings.aggregates) {
      const info = m.support.edges.get(type)
      const pk = stringOf(oldImage[m.support.pkField])
      // Only a row in the aggregate's own partition: an edge entity used standalone on the same
      // table writes rows of the same type, whose history (snapshots, tombstones) the aggregate
      // reading would never see — read as edge rows, they would be freed directly.
      if (
        info !== undefined &&
        m.tableName === table &&
        pk !== undefined &&
        m.support.ownsPartition(pk)
      ) {
        readings.push(readAggregate(m, info, oldImage, newImage))
      }
    }
    for (const m of settings.streams) {
      if (m.tableName !== table) continue
      const reading = readStream(m, type, oldImage, newImage)
      if (reading !== undefined) readings.push(reading)
    }
    return readings
  }

  /** The probe attribute that tells DynamoDB JSON from an unmarshalled image. */
  const probeOf = (type: string): string =>
    entitiesByType.get(type)?.[0]?.support.pkField ??
    settings.aggregates.find((m) => m.support.edges.has(type))?.support.pkField ??
    "pk"

  /** A member, on any table, declares the type. */
  const isMemberType = (type: string): boolean =>
    entitiesByType.has(type) ||
    settings.aggregates.some((m) => m.support.edges.has(type)) ||
    settings.streams.some(
      (m) =>
        (type === m.support.eventType && m.support.event !== undefined) ||
        (type === m.support.snapshotType && m.support.snapshot !== undefined),
    )

  /** The members' tables, by the name a record gives them. */
  const memberTables = [
    ...new Set(
      [...settings.entities, ...settings.aggregates, ...settings.streams].map((m) => m.tableName),
    ),
  ].sort(compareUtf8)

  const reap = (records: Iterable<StreamRecordLike>, options?: ReapOptions) =>
    Effect.gen(function* () {
      const operation = "BlobGc.reap"
      try {
        checkKeys(operation, "options", options, REAP_KEYS)
      } catch (error) {
        return yield* Effect.die(error)
      }
      const option = options?.table
      const given = typeof option === "string" ? tableNameOf(option) : undefined
      if (option !== undefined && (given === undefined || given.length === 0)) {
        return yield* Effect.die(
          invalid(
            operation,
            `table must be a table name or a DynamoDB table or stream ARN, got ${show(option)}.`,
          ),
        )
      }
      /** The table record `n` came from, or why it cannot be told. */
      const tableOfRecord = (record: StreamRecordLike, n: number): string | Error => {
        const named = namedTable(record)
        if ("conflict" in named) return invalid(operation, `record ${n}: ${named.conflict}.`)
        if (named.table !== undefined && given !== undefined && named.table !== given) {
          return invalid(
            operation,
            `record ${n} comes from table "${named.table}", not the table option's "${given}".`,
          )
        }
        const table =
          named.table ?? given ?? (memberTables.length === 1 ? memberTables[0] : undefined)
        return table !== undefined
          ? table
          : invalid(
              operation,
              `record ${n} does not name its table (no eventSourceARN or tableName) and the ` +
                `collector's members are on several tables (${memberTables.join(", ")}): pass ` +
                "reap(records, { table }).",
            )
      }
      const all = [...records]
      const now = yield* Clock.currentTimeMillis
      // 1. Check every record before acting on any (§11.3 step 1).
      const candidates = new Map<string, Candidate>()
      const foreign = new Map<string, BlobRef>()
      let skipped = 0
      let newest: number | undefined
      for (const [n, record] of all.entries()) {
        const images = recordImages(record, operation)
        if (typeof images === "string") {
          if (images.startsWith("[EDD-9119]")) return yield* Effect.die(new Error(images))
          return yield* new ValidationError({
            entityType: "BlobGc",
            operation,
            cause: new Error(`Malformed stream record: ${images}`),
          })
        }
        const { eventName, oldImage, newImage } = images
        const type = oldImage === undefined ? undefined : imageEntityType(oldImage)
        if (eventName === "INSERT" || oldImage === undefined || type === undefined) {
          skipped++
          continue
        }
        if (!isMemberType(type)) {
          skipped++
          continue
        }
        const table = tableOfRecord(record, n)
        if (table instanceof Error) return yield* Effect.die(table)
        const ctx = { entityType: type, operation }
        const probe = { probe: probeOf(type) }
        const before = normalizeImageSync(oldImage, ctx, probe)
        if (before instanceof ValidationError) return yield* before
        const after = newImage === undefined ? undefined : normalizeImageSync(newImage, ctx, probe)
        if (after instanceof ValidationError) return yield* after
        const readings = readingsOf(type, table, eventName, before, after)
        // A member reading that rules the record out wins: it frees nothing.
        if (readings.length === 0 || readings.some((reading) => reading._tag === "skip")) {
          skipped++
          continue
        }
        const owned = new Set<string>()
        let contributes = false
        for (const reading of readings) {
          if (reading._tag !== "act") continue
          for (const candidate of reading.candidates) {
            const k = refKey(candidate.ref)
            owned.add(k)
            contributes = true
            const known = candidates.get(k)
            // A confirm-read wins over a direct free of the same version.
            if (
              known === undefined ||
              (known.confirm === undefined && candidate.confirm !== undefined)
            ) {
              candidates.set(k, candidate)
            }
          }
        }
        for (const reading of readings) {
          if (reading._tag !== "act") continue
          for (const ref of reading.foreign) {
            if (!owned.has(refKey(ref))) foreign.set(refKey(ref), ref)
          }
        }
        if (contributes) newest = Math.max(newest ?? 0, recordTime(record, now))
      }
      for (const k of candidates.keys()) foreign.delete(k)

      // 2. Grace, from the newest record that superseded something (§11.3 step 3).
      if (newest !== undefined) {
        const due = newest + Duration.toMillis(settings.reaperGrace)
        const current = yield* Clock.currentTimeMillis
        if (due > current) yield* Effect.sleep(Duration.millis(due - current))
      }

      // 3. Free, by member rule (§11.3 step 4).
      const freed: Array<Candidate> = []
      let retained = 0
      const families = new Map<string, Array<Candidate>>()
      for (const candidate of candidates.values()) {
        if (candidate.confirm === undefined) {
          freed.push(candidate)
          continue
        }
        const { member, family } = candidate.confirm
        const k = `${member.name}\u0000${family.pk}\u0000${family.liveSk}`
        const list = families.get(k) ?? []
        list.push(candidate)
        families.set(k, list)
      }
      if (families.size > 0) {
        const client = yield* Capacity.client
        for (const group of families.values()) {
          const { member, family } = group[0]!.confirm!
          const ranges = new Set<GcSupport.FamilyRange>()
          for (const candidate of group)
            for (const range of candidate.confirm!.ranges) ranges.add(range)
          const held = yield* GcSupport.confirmRead({
            client,
            table: member.table,
            liveKey: {
              [member.support.pkField]: { S: family.pk },
              [member.support.skField]: { S: family.liveSk },
            },
            readRows: member.support.readFamily(client, member.table, family, ranges),
          })
          if (Option.isNone(held)) {
            retained += group.length
            yield* Effect.logWarning(
              `effect-dynamodb: BlobGc.reap kept ${group.length} superseded version(s) of a ` +
                `${member.support.entityType} item: its live row changed while the reaper read ` +
                `its family (${GcSupport.CONFIRM_ATTEMPTS} attempts). A later sweep collects them.`,
            ).pipe(Effect.annotateLogs({ table: member.table, pk: family.pk, sk: family.liveSk }))
            continue
          }
          for (const candidate of group) {
            if (held.value.has(refKey(candidate.ref))) retained++
            else freed.push(candidate)
          }
        }
      }

      // 4. One delete for the call (§11.3 step 5).
      yield* GcSupport.deleteRefs(
        store,
        {
          entityType: oneOrSeveral(freed.map((c) => c.entityType)),
          attribute: oneOrSeveral(freed.map((c) => c.attribute)),
          operation,
        },
        freed.map((c) => c.ref),
      )
      return {
        records: all.length,
        candidates: candidates.size,
        freed: freed.length,
        retained,
        foreign: foreign.size,
        skipped,
      } satisfies ReapReport
    })

  // -------------------------------------------------------------------------
  // Sweeps (§11.4)
  // -------------------------------------------------------------------------

  /**
   * Classify the refs the rows hold — own when they lie under `segment` —
   * and the own prefixes to list: each `current` one, and every own family
   * prefix under another leading prefix a held ref names.
   */
  const classify = (
    held: ReadonlyMap<string, BlobRef>,
    segment: string,
    rest: RegExp,
    current: Iterable<string>,
  ) => {
    let own = 0
    let foreign = 0
    const prefixes = new Set<string>()
    for (const leading of current) prefixes.add(`${leading}${segment}`)
    for (const ref of held.values()) {
      const leading = GcSupport.leadingPrefix(ref.key, segment, rest)
      if (leading === undefined) {
        foreign++
        continue
      }
      own++
      prefixes.add(`${leading}${segment}`)
    }
    return { own, foreign, prefixes }
  }

  /** List `prefixes` and decide each version against `held` (§11.4 steps 2–4). */
  const decide = (
    ctx: BlobCallContext,
    held: ReadonlyMap<string, BlobRef>,
    counts: { readonly own: number; readonly foreign: number; readonly prefixes: Iterable<string> },
  ) =>
    Effect.gen(function* () {
      const listed = yield* GcSupport.listAll(store, ctx, counts.prefixes)
      const now = yield* Clock.currentTimeMillis
      const decision = yield* GcSupport.sweepVersions({
        store,
        ctx,
        listed,
        referenced: held,
        grace: settings.sweepGrace,
        now,
      })
      return {
        referenced: counts.own,
        listed: listed.length,
        marked: decision.marked,
        deleted: decision.deleted,
        retainedYoung: decision.retainedYoung,
        foreign: counts.foreign,
        busy: false,
      } satisfies SweepReport
    })

  const busy = (what: string, table: string, pk: string, sk?: string) =>
    Effect.as(
      Effect.logWarning(
        `effect-dynamodb: a sweep of ${what} left it untouched: its rows kept changing while ` +
          `it read them (${GcSupport.CONFIRM_ATTEMPTS} attempts). Sweep it again later.`,
      ).pipe(Effect.annotateLogs({ table, pk, ...(sk === undefined ? {} : { sk }) })),
      BUSY,
    )

  /** Sweep an entity item family (§11.4): every range, bracketed. */
  const sweepEntityFamily = (
    m: EntityEntry,
    family: GcSupport.EntityFamily,
    operation: string,
    listedPrefix?: string | undefined,
  ) =>
    Effect.gen(function* () {
      const client = yield* Capacity.client
      const held = yield* GcSupport.confirmRead({
        client,
        table: m.table,
        liveKey: {
          [m.support.pkField]: { S: family.pk },
          [m.support.skField]: { S: family.liveSk },
        },
        readRows: m.support.readFamily(client, m.table, family, GcSupport.ALL_RANGES),
      })
      if (Option.isNone(held)) {
        return yield* busy(`a ${m.support.entityType} item`, m.table, family.pk, family.liveSk)
      }
      const segment = GcSupport.familySegment(m.table, S(family.pk), S(family.liveSk))
      const counts = classify(held.value, segment, GcSupport.FAMILY_REST, [
        m.offload.prefix ?? store.prefix,
      ])
      if (listedPrefix !== undefined) counts.prefixes.add(listedPrefix)
      return yield* decide(
        {
          entityType: m.support.entityType,
          attribute: oneOrSeveral(offloadedAttributes(m.offload)),
          operation,
        },
        held.value,
        counts,
      )
    })

  /** Every row of a partition, one strongly consistent query (paginated). */
  const readPartition = (
    client: DynamoClientService,
    table: string,
    pkField: string,
    pk: string,
  ): Effect.Effect<Array<Record<string, AttributeValue>>, DynamoClientError> =>
    Effect.gen(function* () {
      const rows: Array<Record<string, AttributeValue>> = []
      let start: Record<string, AttributeValue> | undefined
      do {
        const result = yield* client.query({
          TableName: table,
          KeyConditionExpression: "#pk = :pk",
          ExpressionAttributeNames: { "#pk": pkField },
          ExpressionAttributeValues: { ":pk": { S: pk } },
          ConsistentRead: true,
          ExclusiveStartKey: start,
        })
        rows.push(...((result.Items ?? []) as Array<Record<string, AttributeValue>>))
        start = result.LastEvaluatedKey as Record<string, AttributeValue> | undefined
      } while (start !== undefined)
      return rows
    })

  const sameRows = (
    a: ReadonlyArray<Record<string, AttributeValue>>,
    b: ReadonlyArray<Record<string, AttributeValue>>,
  ): boolean =>
    a.length === b.length &&
    attributeValueEquals({ L: a.map((row) => ({ M: row })) }, { L: b.map((row) => ({ M: row })) })

  /**
   * An aggregate partition's refs, read twice: equal reads saw no
   * transaction land in between, so no holder moved past them (another
   * member's rows may share the partition — an entity whose lifecycle copies
   * pointers between rows). `Option.none()` when they never agree.
   */
  const readPartitionBracketed = (
    client: DynamoClientService,
    table: string,
    pkField: string,
    pk: string,
  ) => {
    const attempt = (
      n: number,
    ): Effect.Effect<Option.Option<ReadonlyMap<string, BlobRef>>, DynamoClientError> =>
      n === GcSupport.CONFIRM_ATTEMPTS
        ? Effect.succeed(Option.none())
        : Effect.gen(function* () {
            const before = yield* readPartition(client, table, pkField, pk)
            const after = yield* readPartition(client, table, pkField, pk)
            if (!sameRows(before, after)) return yield* attempt(n + 1)
            return Option.some(GcSupport.refsOfRows(after))
          })
    return attempt(0)
  }

  /** Sweep an aggregate's partition: every edge family under it, orphans included. */
  const sweepAggregatePartition = (m: AggregateEntry, pk: string, operation: string) =>
    Effect.gen(function* () {
      const client = yield* Capacity.client
      const held = yield* readPartitionBracketed(client, m.table, m.support.pkField, pk)
      if (Option.isNone(held)) return yield* busy(`aggregate "${m.name}"`, m.table, pk)
      const segment = GcSupport.partitionSegment(m.table, S(pk))
      const infos = [...m.support.edges.values()]
      const counts = classify(
        held.value,
        segment,
        GcSupport.PARTITION_REST,
        infos.map((info) => info.prefix ?? store.prefix),
      )
      return yield* decide(
        {
          entityType: oneOrSeveral(infos.map((info) => info.entityType)),
          attribute: oneOrSeveral(infos.flatMap((info) => offloadedAttributes(info))),
          operation,
        },
        held.value,
        counts,
      )
    })

  /**
   * Sweep one aggregate edge item's family (`sweepStore`): its row, one
   * strongly consistent read — edge rows never copy pointers, and no other
   * row is in the family.
   */
  const sweepEdgeFamily = (
    m: AggregateEntry,
    info: OffloadInfo,
    pk: string,
    sk: string,
    listedPrefix: string,
  ) =>
    Effect.gen(function* () {
      const client = yield* Capacity.client
      const result = yield* client.getItem({
        TableName: m.table,
        Key: { [m.support.pkField]: { S: pk }, [m.support.skField]: { S: sk } },
        ConsistentRead: true,
      })
      const held = GcSupport.refsOfRows(result.Item === undefined ? [] : [result.Item])
      const segment = GcSupport.familySegment(m.table, S(pk), S(sk))
      const counts = classify(held, segment, GcSupport.FAMILY_REST, [info.prefix ?? store.prefix])
      counts.prefixes.add(listedPrefix)
      return yield* decide(
        {
          entityType: info.entityType,
          attribute: oneOrSeveral(offloadedAttributes(info)),
          operation: "BlobGc.sweepStore",
        },
        held,
        counts,
      )
    })

  /**
   * Sweep a stream's family: every row of its partition, one strongly
   * consistent query — events are immutable and a snapshot write uploads
   * afresh, so no holder of an existing version can appear.
   */
  const sweepStreamPartition = (
    m: StreamEntry,
    pk: string,
    operation: string,
    listedPrefix?: string | undefined,
  ) =>
    Effect.gen(function* () {
      const client = yield* Capacity.client
      const held = GcSupport.refsOfRows(
        yield* readPartition(client, m.table, m.support.pkField, pk),
      )
      const segment = GcSupport.familySegment(m.table, S(pk), STREAM_FAMILY_SK)
      const counts = classify(held, segment, GcSupport.FAMILY_REST, [
        m.support.prefix ?? store.prefix,
      ])
      if (listedPrefix !== undefined) counts.prefixes.add(listedPrefix)
      return yield* decide(
        {
          entityType: oneOrSeveral(
            [m.support.event, m.support.snapshot].flatMap((info) =>
              info === undefined ? [] : [info.entityType],
            ),
          ),
          attribute: oneOrSeveral([
            ...(m.support.event === undefined ? [] : ["data"]),
            ...(m.support.snapshot === undefined ? [] : ["state"]),
          ]),
          operation,
        },
        held,
        counts,
      )
    })

  const unknownMember = (operation: string, kind: string, member: unknown) =>
    Effect.die(invalid(operation, `${show(member)} is not ${kind} member of this collector.`))

  const sweep = (member: string, key: unknown) =>
    Effect.gen(function* () {
      const operation = "BlobGc.sweep"
      yield* requireCapabilities(operation, ["list", "marks"])
      const m = settings.entities.find((entry) => entry.name === member)
      if (m === undefined) return yield* unknownMember(operation, "an entity", member)
      const family = yield* m.support.familyOfKey(key, operation)
      return yield* sweepEntityFamily(m, family, operation)
    })

  const sweepPartition = (member: string, key: unknown) =>
    Effect.gen(function* () {
      const operation = "BlobGc.sweepPartition"
      yield* requireCapabilities(operation, ["list", "marks"])
      const aggregate = settings.aggregates.find((entry) => entry.name === member)
      if (aggregate !== undefined) {
        const pk = yield* aggregate.support.partitionOfKey(key, operation)
        return yield* sweepAggregatePartition(aggregate, pk, operation)
      }
      const stream = settings.streams.find((entry) => entry.name === member)
      if (stream === undefined) {
        return yield* unknownMember(operation, "an aggregate or stream", member)
      }
      const pk = yield* stream.support.partitionOfKey(key, operation)
      return yield* sweepStreamPartition(stream, pk, operation)
    })

  // -------------------------------------------------------------------------
  // sweepStore (§11.5)
  // -------------------------------------------------------------------------

  /** One family of the listing: its versions, contiguous. */
  interface ListedGroup {
    readonly listed: GcSupport.ListedFamily
    readonly versions: ReadonlyArray<BlobListing>
  }

  /** `startAfter` for the keys after every key of a family prefix (`…P/F/` → `…P/F0`). */
  const afterFamily = (familyPrefix: string): string =>
    familyPrefix.endsWith("/") ? `${familyPrefix.slice(0, -1)}0` : familyPrefix

  /** The store's prefix and every member's `offload.prefix`, in UTF-8 order. */
  const knownPrefixes = (() => {
    const all = new Set<string>([store.prefix])
    for (const m of settings.entities) all.add(m.offload.prefix ?? store.prefix)
    for (const m of settings.aggregates) {
      for (const info of m.support.edges.values()) all.add(info.prefix ?? store.prefix)
    }
    for (const m of settings.streams) all.add(m.support.prefix ?? store.prefix)
    return [...all].sort(compareUtf8)
  })()

  /** The prefixes to list by default: the known ones, none under another. */
  const defaultRoots = (): Array<string> =>
    knownPrefixes.filter(
      (root) => !knownPrefixes.some((other) => other !== root && root.startsWith(other)),
    )

  /** The library families listed under `root`, resuming after `marker`. */
  const familiesUnder = (
    root: string,
    marker: string | undefined,
    ctx: BlobCallContext,
  ): Stream.Stream<ListedGroup, BlobStoreError> => {
    let startAfter: string | undefined
    if (marker !== undefined && compareUtf8(marker, root) >= 0) {
      if (!marker.startsWith(root)) return Stream.empty
      startAfter = marker
    }
    const known = [...knownPrefixes, root]
    const familyOf = (key: string) => GcSupport.listedFamily(key, root.length, known)
    return GcSupport.listing(store, ctx, root, startAfter).pipe(
      Stream.groupAdjacentBy((version) => familyOf(version.ref.key)?.familyPrefix ?? ""),
      Stream.filter(([familyPrefix]) => familyPrefix !== ""),
      Stream.map(([, versions]) => ({ listed: familyOf(versions[0].ref.key)!, versions })),
    )
  }

  /** The metadata of one of the family's versions; `undefined` when every one is gone. */
  const headOf = (versions: ReadonlyArray<BlobListing>, ctx: BlobCallContext) =>
    Effect.gen(function* () {
      const head = store.head!
      for (const version of versions) {
        const metadata = yield* call(store, "head", ctx, { ref: version.ref }, () =>
          head(version.ref),
        ).pipe(
          Effect.map((found): Readonly<Record<string, string>> | undefined => found),
          Effect.catchIf(
            (error) => error.reason === "NotFound",
            () => Effect.succeed(undefined),
          ),
        )
        if (metadata !== undefined) return metadata
      }
      return undefined
    })

  /** Attribute a listed family to a member and sweep it (§11.5 steps 2–3). */
  const sweepListed = (
    group: ListedGroup,
    ctx: BlobCallContext,
  ): Effect.Effect<StoreSweepFamily | undefined, GcError, DynamoClient> =>
    Effect.gen(function* () {
      const { listed, versions } = group
      const familyPrefix = listed.familyPrefix
      const foreign = (table: Option.Option<string>): StoreSweepFamily => ({
        _tag: "Foreign",
        familyPrefix,
        table,
      })
      const metadata = yield* headOf(versions, ctx)
      if (metadata === undefined) return undefined
      const parsed = BlobMetadata.parse(metadata)
      if (typeof parsed === "string") return foreign(Option.none())
      const table = Option.some(parsed.table)
      const entityMembers = settings.entities.filter(
        (m) => m.table === parsed.table && m.support.entityType === parsed.entity,
      )
      const aggregateMembers = settings.aggregates.filter(
        (m) => m.table === parsed.table && m.support.edges.has(parsed.entity),
      )
      const streamMembers = settings.streams.filter(
        (m) =>
          m.table === parsed.table &&
          ((parsed.entity === m.support.eventType && m.support.event !== undefined) ||
            (parsed.entity === m.support.snapshotType && m.support.snapshot !== undefined)),
      )
      if (entityMembers.length + aggregateMembers.length + streamMembers.length === 0) {
        return foreign(table)
      }
      if (parsed.item === undefined) {
        return {
          _tag: "Unattributable",
          familyPrefix,
          versions: versions.length,
          bytes: versions.reduce((sum, version) => sum + version.size, 0),
        } satisfies StoreSweepFamily
      }
      const pk = "S" in parsed.item.pk ? parsed.item.pk.S : undefined
      const rowSk = "S" in parsed.item.sk ? parsed.item.sk.S : undefined
      if (pk === undefined || rowSk === undefined) return foreign(table)
      const partition = partitionHash(parsed.table, S(pk))
      if (partition !== listed.partition) return foreign(table)
      const swept = (member: string, report: SweepReport): StoreSweepFamily => ({
        _tag: "Swept",
        familyPrefix,
        member,
        report,
      })
      for (const m of entityMembers) {
        const liveSk = m.support
          .liveSkCandidates(rowSk)
          .find((candidate) => familyHash(partition, S(candidate)) === listed.family)
        if (liveSk === undefined) continue
        return swept(
          m.name,
          yield* sweepEntityFamily(m, { pk, liveSk }, "BlobGc.sweepStore", familyPrefix),
        )
      }
      if (familyHash(partition, S(rowSk)) === listed.family) {
        for (const m of aggregateMembers) {
          if (!m.support.ownsPartition(pk)) continue
          const info = m.support.edges.get(parsed.entity)!
          return swept(m.name, yield* sweepEdgeFamily(m, info, pk, rowSk, familyPrefix))
        }
      }
      if (familyHash(partition, STREAM_FAMILY_SK) === listed.family) {
        for (const m of streamMembers) {
          return swept(
            m.name,
            yield* sweepStreamPartition(m, pk, "BlobGc.sweepStore", familyPrefix),
          )
        }
      }
      return foreign(table)
    })

  const sweepStore = (
    options?: SweepStoreOptions,
  ): Stream.Stream<StoreSweepFamily, GcError, DynamoClient> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const operation = "BlobGc.sweepStore"
        yield* requireCapabilities(operation, ["list", "head", "marks"])
        try {
          checkKeys(operation, "options", options, SWEEP_STORE_KEYS)
        } catch (error) {
          return yield* Effect.die(error)
        }
        const prefix = options?.prefix
        const startAfter = options?.startAfter
        const maxFamilies = options?.maxFamilies
        if (prefix !== undefined && typeof prefix !== "string") {
          return yield* Effect.die(
            invalid(operation, `prefix must be a string, got ${show(prefix)}.`),
          )
        }
        if (startAfter !== undefined && typeof startAfter !== "string") {
          return yield* Effect.die(
            invalid(operation, `startAfter must be a string, got ${show(startAfter)}.`),
          )
        }
        if (
          maxFamilies !== undefined &&
          (typeof maxFamilies !== "number" || !Number.isSafeInteger(maxFamilies) || maxFamilies < 1)
        ) {
          return yield* Effect.die(
            invalid(operation, `maxFamilies must be a positive integer, got ${show(maxFamilies)}.`),
          )
        }
        const ctx: BlobCallContext = { entityType: "BlobGc", attribute: "(several)", operation }
        const marker = startAfter === undefined ? undefined : afterFamily(startAfter)
        const roots = prefix === undefined ? defaultRoots() : [prefix]
        const families = Stream.fromIterable(roots).pipe(
          Stream.flatMap((root) => familiesUnder(root, marker, ctx)),
          Stream.mapEffect((group) => sweepListed(group, ctx)),
          Stream.filter((family): family is StoreSweepFamily => family !== undefined),
        )
        return maxFamilies === undefined ? families : Stream.take(families, maxFamilies)
      }),
    )

  return { reap, sweep, sweepPartition, sweepStore }
}
