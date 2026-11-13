/**
 * Query — Pure description of a DynamoDB query.
 *
 * `Query<A>` is a lazy, immutable data type that describes a query. No DynamoDB
 * calls happen until a terminal (`execute`, `collect`, or `paginate`) is called. All
 * combinators return a new Query — the original is unchanged.
 *
 * Implements Pipeable for ergonomic composition.
 */

import type {
  AttributeValue,
  QueryCommandOutput,
  ScanCommandOutput,
} from "@aws-sdk/client-dynamodb"
import { ValidationError } from "@effect-dynamodb/schema/Errors.js"
import type { ReadFanOut, ReadPartitions } from "@effect-dynamodb/schema/KeyComposer.js"
import * as Projection from "@effect-dynamodb/schema/Projection.js"
import { Effect, Function, Option, Pipeable, Result, Stream } from "effect"
import { DynamoClient, type DynamoClientError, type DynamoClientService } from "./DynamoClient.js"
import * as Capacity from "./internal/Capacity.js"
import * as Cursor from "./internal/Cursor.js"
import {
  compileExpr,
  type Expr,
  ExprTag,
  emptyPartProblem,
  isEmptyExpr,
  operandsAsStored,
  type StoredFormAt,
} from "./internal/Expr.js"
import { batchGetRaw } from "./internal/Hydrate.js"
import {
  type PackedAttributeGuard,
  packedExprRefusal,
  packedProjectionRefusal,
} from "./internal/Packed.js"
import { compilePath, storedPath } from "./internal/PathBuilder.js"
import {
  canonicalJson,
  compositePlanner,
  cursorRefusal,
  DEFAULT_MAX_SKIPS,
  displayKeyCondition,
  fnv1a32,
  JUMP_INITIAL,
  JUMP_MAX_LIMIT,
  type KeyRange,
  keyConditionHolds,
  type PlannerFactory,
  type ProbeStep,
  type RangePlanner,
  type ReadStep,
  type RowCheck,
  readFrom,
  type Step,
  toKeyCondition,
} from "./internal/RangePlanner.js"
import * as ShardMerge from "./internal/ShardMerge.js"
import { diagnoseFailure, explainDiagnosis, withCause } from "./internal/WriteDiagnosis.js"
import { fromAttributeMap, toAttributeValue } from "./Marshaller.js"

// ---------------------------------------------------------------------------
// Sort key condition types
// ---------------------------------------------------------------------------

/**
 * Sort key condition for narrowing query results within a partition.
 * Exactly one operator should be provided.
 */
export type SortKeyCondition =
  | { readonly eq: string }
  | { readonly lt: string }
  | { readonly lte: string }
  | { readonly gt: string }
  | { readonly gte: string }
  | { readonly between: readonly [string, string] }
  | { readonly beginsWith: string }

/**
 * @internal A sort key operand: `S` text, or the bytes of a binary (`B`) key
 * (#171). Planned ranges carry it; the public {@link SortKeyCondition} stays
 * string-typed.
 */
export type KeyValue = string | Uint8Array

/**
 * @internal A sort key condition as a request sends it: {@link SortKeyCondition}
 * with {@link KeyValue} operands, marshalled to `S` or `B` (#171).
 */
export type KeyCondition =
  | { readonly eq: KeyValue }
  | { readonly lt: KeyValue }
  | { readonly lte: KeyValue }
  | { readonly gt: KeyValue }
  | { readonly gte: KeyValue }
  | { readonly between: readonly [KeyValue, KeyValue] }
  | { readonly beginsWith: KeyValue }

/**
 * How a query reads its index (#171) — one vocabulary for {@link explain} and
 * the cursor:
 *
 * - `key` — one key condition.
 * - `skip-scan` — a probe for each distinct value of the sort key composites
 *   left of a `.within()` bound, then that value's range.
 * - `filter` — one range, every bound checked per row.
 * - `empty` — no value satisfies the bounds: nothing is sent.
 * - `naive` / `jump` / `precise` — Z-order plans (`empty` too).
 */
export type PlanMode = "key" | "skip-scan" | "filter" | "naive" | "jump" | "precise" | "empty"

/** What a query will send, described without sending anything (see {@link explain}). */
export interface QueryExplain {
  /** The physical index queried, or `"primary"`. */
  readonly index: string
  readonly plan: PlanMode
  /**
   * Why this plan: e.g. "leading composites bounded", "skip tuple: status",
   * "history rows on the primary index", "maxSkips: 0".
   */
  readonly reason: string
  /** The key ranges known before anything is read (`exact: false`: rows are also checked). */
  readonly keyConditions: ReadonlyArray<{
    readonly lower: string | undefined
    readonly upper: string | undefined
    readonly exact: boolean
  }>
  /** The `FilterExpression` the plan adds, if any. */
  readonly filter: string | undefined
  /** The fields the library checks on each row, for bounds no key condition expresses. */
  readonly rowChecks: ReadonlyArray<string>
  /** How each request's `Limit` is sized (see {@link limit} and {@link pageSize}). */
  readonly sizing: "fixed" | "natural" | "budget" | "adaptive"
  /** A Z-order plan's address space and box (#171). */
  readonly zorder?: {
    /** The address width in bits. */
    readonly bits: number
    /** Per dimension, the levels the box selects, as inclusive `[lo, hi]` runs. */
    readonly box: ReadonlyArray<{
      readonly field: string
      readonly bits: number
      readonly levels: ReadonlyArray<readonly [string, string]>
    }>
    /** The box's volume over the addresses between its corners: how much of the hull is in it. */
    readonly fill: number
    /** How many ranges the exact plan takes, or `"over-cap"` when it exceeds `maxRanges`. */
    readonly exactRanges: number | "over-cap"
  }
  /** The skip-scan probe budget, for a plan that probes. */
  readonly maxSkips?: number
  /** A sharded index's fan-out (#183): one request per partition, merged. */
  readonly fanOut?: {
    /** The partition key text of each partition read, in merge order. */
    readonly partitions: ReadonlyArray<string>
    /** Every `by` attribute was pinned, so one current shard is read. */
    readonly pruned: boolean
    /** Requests in flight at once. */
    readonly concurrency: number
  }
}

/**
 * How a Z-order query reads its box (#171) — `.zorder()` on a Z-order
 * accessor. Later calls merge over earlier ones.
 */
export interface ZOrderOptions {
  /**
   * `"precise"` reads a capped plan of address ranges; `"jump"` follows each
   * page's last examined key to the next address in the box; `"naive"` reads
   * the box's whole hull. `"auto"` (the default) is `precise` when the exact
   * plan fits `maxRanges`, else `jump`.
   */
  readonly strategy?: "auto" | "naive" | "jump" | "precise" | undefined
  /** A fixed `Limit` for `jump` requests. Unset: sized from the in-box run, starting at 16. */
  readonly pageSize?: number | undefined
  /** Range cap for `precise` and for `auto`'s choice. Default 16. */
  readonly maxRanges?: number | undefined
  /**
   * Planned ranges in flight at once. Unset: 4 for reads with a `limit`, 1
   * for drains without one (natural 1 MB pages against one partition). Set:
   * applies to both.
   */
  readonly concurrency?: number | undefined
}

// ---------------------------------------------------------------------------
// Query internal state
// ---------------------------------------------------------------------------

interface QueryState {
  readonly tableName: string
  readonly indexName: string | undefined
  readonly pkField: string
  readonly pkValue: string
  readonly skField: string | undefined
  readonly skConditions: ReadonlyArray<{
    readonly field: string
    readonly condition: KeyCondition
  }>
  readonly exprFilters: ReadonlyArray<Expr>
  /**
   * Client-side predicates, evaluated on the DECODED item inside the same
   * accumulate loop the server-side filter uses (see {@link filterBy}).
   */
  readonly predicates: ReadonlyArray<(item: never) => boolean>
  readonly entityTypes: ReadonlyArray<string>
  /** Maximum number of items to RETURN (a contract on results). */
  readonly limitValue: number | undefined
  /**
   * DynamoDB `Limit` — rows examined per request (a contract on round trips).
   * `"natural"` sizes requests exactly as 1.36 did (see {@link pageSize}).
   */
  readonly pageSizeValue: number | "natural" | undefined
  readonly maxPagesValue: number | undefined
  /** Called after every request a terminal sends, in order (see {@link onRequest}). */
  readonly observers: ReadonlyArray<(event: QueryRequestEvent) => Effect.Effect<void>>
  readonly scanForward: boolean
  readonly consistentRead: boolean
  readonly ignoreOwnershipFlag: boolean
  /**
   * What every terminal fails with: a value this query was given has no key
   * (see {@link refuse}). Nothing is sent.
   */
  readonly refusal?: ValidationError | undefined
  /**
   * Where an unplanned query resumes: set by internal callers, or by
   * {@link prepared} from a {@link startFrom} cursor.
   */
  readonly exclusiveStartKey: Record<string, AttributeValue> | undefined
  /**
   * The cursor {@link startFrom} was given, decoded by {@link prepared} when a
   * terminal runs — once the plan it must belong to is known (#171).
   */
  readonly cursorText: string | undefined
  /**
   * @internal The plan a `.within()` installed (#171), as a factory: `reverse`
   * and the other combinators may follow `.within()`, so it is resolved from
   * the final state when a terminal runs.
   */
  readonly planner: PlannerFactory | undefined
  /** @internal The skip-scan probe budget `.within()` was given (default 32). */
  readonly maxSkips: number | undefined
  /** @internal `.zorder()` options, merged over each other (#171). */
  readonly zorderOptions: ZOrderOptions | undefined
  /** @internal Set by {@link prepared}: the resolved planner and the step the terminal starts at. */
  readonly plan: PreparedPlan | undefined
  /**
   * @internal Set per request of a planned read (#171): the bounds its key
   * condition can't express, checked on each raw row like {@link liveRows}.
   */
  readonly rowCheck: RowCheck | undefined
  readonly isScan: boolean
  readonly projection: ReadonlyArray<string> | undefined
  readonly projectionPaths: ReadonlyArray<ReadonlyArray<string | number>> | undefined
  readonly decoder: (raw: Record<string, unknown>) => Effect.Effect<unknown, ValidationError>
  /**
   * How a raw row ({@link select} / {@link selectPaths}) is handed back: the
   * identity, unless the query's items store attributes packed — then each
   * packed attribute present is read by its stored form to its parsed JSON
   * (not schema-decoded). See {@link QueryRawRow}.
   */
  readonly rawRow: QueryRawRow | undefined
  /**
   * The packed attributes of the query's items: a filter or projection that
   * looks inside one is refused when it is added (`[EDD-9076]`).
   */
  readonly packed: ReadonlyArray<PackedAttributeGuard>
  /**
   * How the entity whose query this is stores a filter's operand at a path (#242): a filter added
   * with {@link filterExpr} sends each operand that is one of Effect's instances or a `Date` in
   * that form (`operandsAsStored`). `undefined` on a query no one entity's schema types (an event
   * stream's, a collection's, one made by hand): operands are sent as given.
   */
  readonly storedAt: StoredFormAt | undefined
  /** Optional effect to resolve table name at execution time (for deferred resolution) */
  readonly resolveTableName: Effect.Effect<string, never, any> | undefined
  /**
   * Attribute names that make up a resume key for this query — the queried
   * index key plus the table key. Used to rebuild an accurate cursor when a
   * request over-reads and the surplus is discarded (see {@link limit}).
   */
  readonly keyFields: ReadonlyArray<string> | undefined
  /**
   * Which rows are items (#133). An entity's version snapshots, soft-delete
   * tombstones and time-series events keep its `__edd_e__`, so the ownership
   * filter alone admits them to a query of the table's primary key, or a
   * scan. Rows that fail it are dropped as they arrive, before they are
   * decoded or counted — see {@link isExcludedRow}. (Client-side for scans
   * too: a `FilterExpression` saves no read capacity, and no expression
   * tells a live row from history as exactly.)
   */
  readonly liveRows: LiveRows | undefined
  /**
   * Run once at the start of each terminal, against the resolved table: may
   * swap the sort key `begins_with` operand and add a row filter (`keep`)
   * applied, like {@link liveRows}, to rows before they are decoded. An entity's
   * `versions` uses it to read history written by an earlier release alongside
   * its own (#133).
   */
  readonly prepare: QueryPrepare | undefined
  /** @internal Set by {@link prepare}: rows outside it are dropped before decode. */
  readonly keepRow: ((row: Record<string, AttributeValue>) => boolean) | undefined
  /**
   * How a terminal obtains full items when the queried index does not project
   * them — see {@link QueryHydration}. Only a stream index declared
   * `projection: "keys"` sets it.
   */
  readonly hydration: QueryHydration | undefined
  /** See {@link KeyConditionDiagnosis}. */
  readonly keyConditionDiagnosis: KeyConditionDiagnosis | undefined
  /**
   * The consumed-capacity `target` of the query's operations, when it is not
   * its entity types: an event stream's queries report under the stream name,
   * as every `EventStream.*` operation does, not the stream's discriminator.
   */
  readonly operationTarget: string | undefined
  /**
   * @internal A sharded index's layout (#183): the partitions a terminal reads
   * and merges. `pkValue` is the first of them, which is what `asParams` shows.
   */
  readonly fanOut: FanOutSpec | undefined
  /** @internal Set by {@link prepared}: each partition and where it resumes. */
  readonly fanOutStart: FanOutStart | undefined
  /** Requests a fan-out sends at once; unset, one per partition (see {@link concurrency}). */
  readonly concurrencyValue: number | undefined
}

/** @internal A sharded index's layout, as {@link fanOut} installs it. */
interface FanOutSpec extends ReadFanOut {
  readonly partitions: ReadonlyArray<string>
}

/** @internal One physical partition a fan-out reads. */
interface FanOutPartition {
  readonly pkValue: string
  readonly condition: KeyCondition | undefined
}

/** @internal A prepared fan-out: its partitions, and the merge resumed from a cursor. */
interface FanOutStart {
  readonly partitions: ReadonlyArray<FanOutPartition>
  readonly fingerprint: string
  readonly merge: ShardMerge.MergeState
}

/** @internal A planner resolved for one terminal call, and where it starts (see {@link prepared}). */
interface PreparedPlan {
  readonly planner: RangePlanner
  readonly start: Step
}

/**
 * @internal Turns a raw row into the plain row {@link select} returns: each
 * packed attribute it carries read by its stored form (`S` → JSON, `B` →
 * header + payload, native → unchanged), never schema-decoded.
 */
export type QueryRawRow = {
  (raw: Record<string, unknown>): Effect.Effect<Record<string, unknown>, ValidationError>
  /**
   * Attributes the hook reads to decide how to read a row — a collection's
   * `__edd_e__`, which names the member whose packed attributes to read. They
   * are borrowed into an active projection and stripped again once the hook
   * has run, so the caller sees exactly what it selected.
   */
  readonly reads?: ReadonlyArray<string> | undefined
  /**
   * The stored attributes the hook may rewrite. A projection that names none
   * of them drops the hook — nothing is borrowed and no row is examined.
   * Absent: the hook runs on every projection.
   */
  readonly attributes?: ReadonlyArray<string> | undefined
}

/**
 * @internal The raw-row hook a projection of `paths` runs: the query's
 * {@link QueryState.rawRow}, unless it declares the attributes it rewrites
 * ({@link QueryRawRow.attributes}) and the projection names none of them.
 */
const projectedRawRow = (
  hook: QueryRawRow | undefined,
  paths: ReadonlyArray<ReadonlyArray<string | number>>,
): QueryRawRow | undefined => {
  if (hook?.attributes === undefined) return hook
  const rewrites = new Set(hook.attributes)
  return paths.some((path) => rewrites.has(String(path[0]))) ? hook : undefined
}

/** @internal The raw-row hook the projection of `state` runs, if any. */
const activeRawRow = (state: QueryState): QueryRawRow | undefined =>
  projectedRawRow(state.rawRow, [
    ...(state.projection ?? []).map((attribute) => [attribute]),
    ...(state.projectionPaths ?? []),
  ])

/** @internal The attributes the active raw-row hook of `state` reads (see {@link QueryRawRow.reads}). */
const rawRowReads = (state: QueryState): ReadonlyArray<string> => activeRawRow(state)?.reads ?? []

/**
 * @internal How a query names DynamoDB's rejection of its key condition — an
 * empty key value, a `BETWEEN` whose lower bound sorts after its upper — and of
 * its filter (an `isIn()` with no values): a `ValidationError` with
 * `operation` (the filter's is always `"query.filter"`), its message prefixed
 * `label` (#144). Every query diagnoses those rejections; without this, they
 * are named `operation: "query"` and `label` "query of <entity types>".
 */
export interface KeyConditionDiagnosis {
  readonly operation: string
  readonly label: string
}

/**
 * @internal How a terminal obtains full items for an index that does not
 * project them (a stream index declared `projection: "keys"`).
 *
 * - `Fetch` — an LSI: the query sends `Select: "ALL_ATTRIBUTES"` (when it sends
 *   no `ProjectionExpression`), and DynamoDB fetches each item from the table.
 * - `BatchGet` — a GSI: the index query returns keys; each page's rows are
 *   then fetched from the table with `BatchGetItem` on `tableKey` and kept in
 *   index order. A `select` projection moves onto the `BatchGetItem`.
 *
 * `count` never fetches: it counts index rows with `Select: "COUNT"`.
 */
export type QueryHydration =
  | { readonly _tag: "Fetch" }
  | { readonly _tag: "BatchGet"; readonly tableKey: readonly [string, string] }

/** @internal See {@link QueryState.prepare}. */
export type QueryPrepare = (tableName: string) => Effect.Effect<
  {
    /** Replace a `begins_with` sort key condition on `from` with one on `to`. */
    readonly replaceBeginsWith?: { readonly from: string; readonly to: string } | undefined
    readonly keep?: ((row: Record<string, AttributeValue>) => boolean) | undefined
  },
  DynamoClientError,
  DynamoClient
>

/** @internal See {@link QueryState.liveRows}. */
export interface LiveRows {
  /** Whether a raw row is an item, rather than an entity's history. */
  readonly isLive: (row: Record<string, AttributeValue>) => boolean
  /** The attributes `isLive` reads — kept in a request that projects. */
  readonly reads: ReadonlyArray<string>
}

/** @internal Dedupe + drop absent entries from a caller-supplied key field list. */
const normalizeKeyFields = (
  fields: ReadonlyArray<string | undefined> | undefined,
): ReadonlyArray<string> | undefined => {
  if (!fields) return undefined
  const out = [...new Set(fields.filter((f): f is string => typeof f === "string" && f !== ""))]
  return out.length > 0 ? out : undefined
}

// ---------------------------------------------------------------------------
// Query<A> interface
// ---------------------------------------------------------------------------

const QueryTypeId: unique symbol = Symbol.for("effect-dynamodb/Query")
export type QueryTypeId = typeof QueryTypeId

/**
 * A lazy, immutable description of a DynamoDB query. No calls happen until
 * a terminal ({@link execute}, {@link collect}, or {@link paginate}) is invoked.
 *
 * All combinators ({@link where}, {@link filter}, {@link limit}, {@link reverse})
 * return a new Query — the original is unchanged.
 *
 * @typeParam A - Decoded item type returned by the query
 */
export interface Query<A> extends Pipeable.Pipeable {
  readonly [QueryTypeId]: QueryTypeId
  /** @internal */
  readonly _state: QueryState
  /** @internal */
  readonly _A: (_: never) => A
}

// ---------------------------------------------------------------------------
// Internal: Query implementation
// ---------------------------------------------------------------------------

class QueryImpl<A> implements Query<A> {
  readonly [QueryTypeId]: QueryTypeId = QueryTypeId
  declare readonly _A: (_: never) => A

  constructor(readonly _state: QueryState) {}

  pipe() {
    // eslint-disable-next-line prefer-rest-params
    return Pipeable.pipeArguments(this, arguments)
  }
}

// ---------------------------------------------------------------------------
// Constructor (internal — used by Entity and Collection)
// ---------------------------------------------------------------------------

export const make = <A>(config: {
  readonly tableName: string
  readonly indexName: string | undefined
  readonly pkField: string
  readonly pkValue: string
  readonly skField: string | undefined
  readonly entityTypes: ReadonlyArray<string>
  readonly decoder: (raw: Record<string, unknown>) => Effect.Effect<A, ValidationError>
  readonly resolveTableName?: Effect.Effect<string, never, any> | undefined
  /** Index key + table key attribute names (used to rebuild cursors). */
  readonly keyFields?: ReadonlyArray<string | undefined> | undefined
  /** Which rows are items (see {@link QueryState.liveRows}). */
  readonly liveRows?: LiveRows | undefined
  /** See {@link QueryState.prepare}. */
  readonly prepare?: QueryPrepare | undefined
  /** See {@link QueryState.hydration}. */
  readonly hydration?: QueryHydration | undefined
  /** See {@link KeyConditionDiagnosis}. */
  readonly keyConditionDiagnosis?: KeyConditionDiagnosis | undefined
  /** See {@link QueryState.rawRow}. */
  readonly rawRow?: QueryRawRow | undefined
  /** See {@link QueryState.packed}. */
  readonly packed?: ReadonlyArray<PackedAttributeGuard> | undefined
  /** See {@link QueryState.storedAt}. */
  readonly storedAt?: StoredFormAt | undefined
  /** See {@link QueryState.operationTarget}. */
  readonly operationTarget?: string | undefined
}): Query<A> =>
  new QueryImpl<A>({
    rawRow: config.rawRow,
    packed: config.packed ?? [],
    storedAt: config.storedAt,
    liveRows: config.liveRows,
    prepare: config.prepare,
    keepRow: undefined,
    hydration: config.hydration,
    keyConditionDiagnosis: config.keyConditionDiagnosis,
    operationTarget: config.operationTarget,
    fanOut: undefined,
    fanOutStart: undefined,
    concurrencyValue: undefined,
    tableName: config.tableName,
    indexName: config.indexName,
    pkField: config.pkField,
    pkValue: config.pkValue,
    skField: config.skField,
    skConditions: [],
    exprFilters: [],
    predicates: [],
    entityTypes: config.entityTypes,
    limitValue: undefined,
    pageSizeValue: undefined,
    maxPagesValue: undefined,
    observers: [],
    scanForward: true,
    consistentRead: false,
    ignoreOwnershipFlag: false,
    exclusiveStartKey: undefined,
    cursorText: undefined,
    planner: undefined,
    maxSkips: undefined,
    zorderOptions: undefined,
    plan: undefined,
    rowCheck: undefined,
    isScan: false,
    projection: undefined,
    projectionPaths: undefined,
    decoder: config.decoder as (
      raw: Record<string, unknown>,
    ) => Effect.Effect<unknown, ValidationError>,
    resolveTableName: config.resolveTableName,
    keyFields: normalizeKeyFields(config.keyFields),
  })

/**
 * Create a scan-mode Query. Shares all combinators and terminals with Query
 * but uses DynamoDB Scan instead of Query at execution time.
 * No key condition — only filter expressions and entity type filter.
 */
export const makeScan = <A>(config: {
  readonly tableName: string
  readonly indexName: string | undefined
  readonly entityTypes: ReadonlyArray<string>
  readonly decoder: (raw: Record<string, unknown>) => Effect.Effect<A, ValidationError>
  readonly resolveTableName?: Effect.Effect<string, never, any> | undefined
  /** Index key + table key attribute names (used to rebuild cursors). */
  readonly keyFields?: ReadonlyArray<string | undefined> | undefined
  /** Which rows are items (see {@link QueryState.liveRows}). */
  readonly liveRows?: LiveRows | undefined
  /** See {@link QueryState.prepare}. */
  readonly prepare?: QueryPrepare | undefined
  /** See {@link QueryState.rawRow}. */
  readonly rawRow?: QueryRawRow | undefined
  /** See {@link QueryState.packed}. */
  readonly packed?: ReadonlyArray<PackedAttributeGuard> | undefined
  /** See {@link QueryState.storedAt}. */
  readonly storedAt?: StoredFormAt | undefined
}): Query<A> =>
  new QueryImpl<A>({
    rawRow: config.rawRow,
    packed: config.packed ?? [],
    storedAt: config.storedAt,
    liveRows: config.liveRows,
    prepare: config.prepare,
    keepRow: undefined,
    hydration: undefined,
    keyConditionDiagnosis: undefined,
    operationTarget: undefined,
    fanOut: undefined,
    fanOutStart: undefined,
    concurrencyValue: undefined,
    tableName: config.tableName,
    indexName: config.indexName,
    pkField: "",
    pkValue: "",
    skField: undefined,
    skConditions: [],
    exprFilters: [],
    predicates: [],
    entityTypes: config.entityTypes,
    limitValue: undefined,
    pageSizeValue: undefined,
    maxPagesValue: undefined,
    observers: [],
    scanForward: true,
    consistentRead: false,
    ignoreOwnershipFlag: false,
    exclusiveStartKey: undefined,
    cursorText: undefined,
    planner: undefined,
    maxSkips: undefined,
    zorderOptions: undefined,
    plan: undefined,
    rowCheck: undefined,
    isScan: true,
    projection: undefined,
    projectionPaths: undefined,
    decoder: config.decoder as (
      raw: Record<string, unknown>,
    ) => Effect.Effect<unknown, ValidationError>,
    resolveTableName: config.resolveTableName,
    keyFields: normalizeKeyFields(config.keyFields),
  })

// ---------------------------------------------------------------------------
// Cursor encoding (internal) — see `internal/Cursor.ts`
// ---------------------------------------------------------------------------

const encodeCursor = (key: Record<string, AttributeValue>): string => Cursor.encodeKeyCursor(key)

// ---------------------------------------------------------------------------
// Combinators (all dual for data-first and data-last)
// ---------------------------------------------------------------------------

/** @internal Install `condition` as the query's one sort key condition. */
const withSortKeyCondition = <A>(state: QueryState, condition: SortKeyCondition): Query<A> =>
  new QueryImpl<A>({
    ...state,
    skConditions: state.skField === undefined ? [] : [{ field: state.skField, condition }],
    keepRow: undefined,
  })

/**
 * @internal A pruned fan-out (#183) as it reads with no pins: one shard was chosen
 * for values a replaced condition no longer selects.
 */
const withoutPruning = (state: QueryState): QueryState => {
  const spec = state.fanOut
  if (spec?.everyPartition === undefined) return state
  return {
    ...state,
    pkValue: spec.everyPartition[0]!,
    fanOut: { ...spec, partitions: spec.everyPartition, pruned: false, everyPartition: undefined },
  }
}

/**
 * Add a sort key condition to the query.
 * Only one SK condition is supported (last one wins if multiple are added).
 *
 * The condition replaces what the query's accessor pinned, so on a sharded index
 * (#183) the query reads every shard again: a row the new condition selects can
 * be in any of them.
 */
export const where: {
  (condition: SortKeyCondition): <A>(self: Query<A>) => Query<A>
  <A>(self: Query<A>, condition: SortKeyCondition): Query<A>
} = Function.dual(2, <A>(self: Query<A>, condition: SortKeyCondition): Query<A> => {
  const state = self._state
  if (!state.skField) return self
  return withSortKeyCondition(withoutPruning(state), condition)
})

/**
 * @internal {@link where} for a condition composed from the query's own pins, or
 * bounded under them (an accessor's, `.where()` on a bound query): it selects only
 * rows those pins select, so the shard chosen for them (#183) still holds them all.
 */
export const whereUnderPins = <A>(self: Query<A>, condition: SortKeyCondition): Query<A> => {
  const state = self._state
  if (!state.skField) return self
  return withSortKeyCondition(state, condition)
}

/**
 * @internal Read a sharded index's partitions and merge them (#183): what
 * {@link KeyComposer.composeReadPartitions} returned for the query's pins. An
 * unsharded index's query is unchanged.
 */
export const fanOut = <A>(self: Query<A>, read: ReadPartitions): Query<A> =>
  read.fanOut === undefined
    ? self
    : new QueryImpl<A>({
        ...self._state,
        pkValue: read.partitions[0]!,
        fanOut: { ...read.fanOut, partitions: read.partitions },
      })

/**
 * @internal A query whose terminals fail with `refusal`: building one has no error
 * channel to fail into, and a value a key can't hold is the caller's error, not a
 * defect. Nothing is sent.
 */
export const refuse = <A>(self: Query<A>, refusal: ValidationError): Query<A> =>
  new QueryImpl<A>({ ...self._state, refusal })

/** @internal Has {@link refuse} refused this query? Its builders have nothing left to do. */
export const isRefused = (self: Query<unknown>): boolean => self._state.refusal !== undefined

/** @internal A query that could not even be built: a composite it was given has no key. */
export const refused = <A>(indexName: string | undefined, refusal: ValidationError): Query<A> =>
  refuse(
    make<A>({
      tableName: "",
      indexName,
      pkField: "",
      pkValue: "",
      skField: undefined,
      entityTypes: [],
      decoder: () => Effect.die(refusal),
    }),
    refusal,
  )

/**
 * @internal What `build` returns, or `onRefusal` of the `ValidationError` for a value it
 * threw for (`Capacity.isRefusedValue`). Any other throw is a misuse of the API and stays one.
 */
export const orRefusal = <T>(
  operation: { readonly name: string; readonly target?: string | undefined } | undefined,
  build: () => T,
  onRefusal: (refusal: ValidationError) => T,
): T => {
  try {
    return build()
  } catch (cause) {
    if (!Capacity.isRefusedValue(cause)) throw cause
    const name = operation?.name ?? "query"
    return onRefusal(
      new ValidationError({ entityType: operation?.target ?? name, operation: name, cause }),
    )
  }
}

/** @internal Does this query read a sharded index's partitions (#183)? */
export const isFanOut = (self: Query<unknown>): boolean => self._state.fanOut !== undefined

/**
 * How many requests a query of a sharded index sends at once, per round of its
 * fan-out (#183). The default is one per partition. A query with no fan-out sends
 * one request at a time whatever this says. Anything but a positive integer
 * throws `[EDD-9105]`.
 *
 * ```ts
 * query.pipe(Query.concurrency(4), Query.collect)
 * ```
 */
export const concurrency: {
  (n: number): <A>(self: Query<A>) => Query<A>
  <A>(self: Query<A>, n: number): Query<A>
} = Function.dual(2, <A>(self: Query<A>, n: number): Query<A> => {
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(
      `[EDD-9105] concurrency(${JSON.stringify(n)}) is not a number of requests: pass a ` +
        `positive integer.`,
    )
  }
  return new QueryImpl<A>({ ...self._state, concurrencyValue: n })
})

/**
 * Return **at most `n` items** — a contract on results, not on round trips.
 *
 * The query accumulates across as many DynamoDB requests as it takes to reach
 * `n` accepted items (or to exhaust the key range). Under a `FilterExpression`
 * DynamoDB's own `Limit` bounds rows *examined* before the filter runs, so it
 * cannot carry `n` itself. Instead each request's `Limit` is sized from the
 * pass rate the earlier requests observed (rows accepted / rows examined), so
 * a selective filter reads about what it needs rather than a 1 MB page.
 * {@link pageSize} fixes `Limit` instead (`"natural"` restores 1.36's sizing),
 * and {@link maxPages} stays the hard stop on the number of requests — a query
 * with one keeps 1.36's sizing, so one call returns what it did.
 *
 * ```ts
 * query.pipe(Query.limit(3), Query.collect)               // 3 items
 * query.pipe(Query.pageSize(50), Query.limit(120), Query.collect) // 120 items, requests of ≤50
 * ```
 */
export const limit: {
  (n: number): <A>(self: Query<A>) => Query<A>
  <A>(self: Query<A>, n: number): Query<A>
} = Function.dual(
  2,
  <A>(self: Query<A>, n: number): Query<A> =>
    new QueryImpl<A>({
      ...self._state,
      limitValue: n,
    }),
)

/**
 * Fetch in batches of `n` — sets DynamoDB's `Limit` (rows examined per request).
 * A contract on round trips, not on what comes back: a request under a
 * `FilterExpression` may return fewer than `n` items, and pagination continues
 * until the key range is exhausted (or {@link limit} / {@link maxPages} stops it).
 * A number is used as given (DynamoDB rejects one it does not accept).
 *
 * `"natural"` opts out of the request sizing {@link limit} does under a filter,
 * and sizes every request exactly as 1.36 did: a natural 1 MB page under a
 * filter or predicate, `limit` doubling per request over history rows, and the
 * outstanding `limit` otherwise. Any other string throws `[EDD-9095]`.
 */
export const pageSize: {
  (size: number | "natural"): <A>(self: Query<A>) => Query<A>
  <A>(self: Query<A>, size: number | "natural"): Query<A>
} = Function.dual(2, <A>(self: Query<A>, size: number | "natural"): Query<A> => {
  if (typeof size === "string" && size !== "natural") {
    throw new Error(
      `[EDD-9095] pageSize(${JSON.stringify(size)}) is not a page size: pass the number of ` +
        `rows each request examines (DynamoDB's Limit), or "natural" to size requests as ` +
        `1.36 did.`,
    )
  }
  return new QueryImpl<A>({
    ...self._state,
    pageSizeValue: size,
  })
})

/**
 * What a terminal reports after each request it sends (see {@link onRequest}).
 *
 * `lower` / `upper` show the sort key condition sent: `eq` as `[v, v]`,
 * `between` as `[a, b]`, `gt` / `gte` as `[v, undefined]`, `lt` / `lte` as
 * `[undefined, v]`, `begins_with` as `[prefix, undefined]`, and no condition
 * (or a scan) as `[undefined, undefined]`.
 */
export interface QueryRequestEvent {
  /**
   * `read` for a request whose rows become items (a `count` under
   * {@link filterBy} reads its items too); `count` for a request `count` sends
   * to count rows; `probe` for one that only locates where to read next.
   */
  readonly kind: "read" | "probe" | "count"
  /** 1-based within the terminal call. */
  readonly request: number
  /** Display form of the key condition's lower bound. */
  readonly lower: string | undefined
  /** Display form of the key condition's upper bound. */
  readonly upper: string | undefined
  /** The `Limit` sent, if any. */
  readonly limit: number | undefined
  /** Rows DynamoDB examined (`ScannedCount`; the rows returned when it is absent). */
  readonly scannedCount: number
  /** Rows after the FilterExpression (`Count`; the rows returned when it is absent). */
  readonly count: number
  /** Rows that became items: what history rows, predicates and missing items left. */
  readonly accepted: number
  /**
   * A read sent alongside others (#171) and then not used: a window member
   * after the one that filled the `limit` or returned a `LastEvaluatedKey`
   * (`fetch`), or a page still buffered when a stream ends. Its rows were read
   * and are counted, none became items (`accepted` is 0), and a later call
   * reads them again.
   */
  readonly discarded: boolean
}

/**
 * Observe every request a terminal sends: `observer` runs after each one, in
 * the terminal's fiber, with what it examined and kept. Several observers run
 * in the order they were added. A failure of one is a defect. DynamoDB calls
 * an observer makes are not counted in the query's consumed-capacity report.
 *
 * Σ `scannedCount` against Σ `accepted` is what a query read against what it
 * returned:
 *
 * ```ts
 * query.pipe(
 *   Query.onRequest((event) => Console.log(event.request, event.limit, event.scannedCount)),
 *   Query.limit(10),
 *   Query.collect,
 * )
 * ```
 */
export const onRequest: {
  (observer: (event: QueryRequestEvent) => Effect.Effect<void>): <A>(self: Query<A>) => Query<A>
  <A>(self: Query<A>, observer: (event: QueryRequestEvent) => Effect.Effect<void>): Query<A>
} = Function.dual(
  2,
  <A>(self: Query<A>, observer: (event: QueryRequestEvent) => Effect.Effect<void>): Query<A> =>
    new QueryImpl<A>({
      ...self._state,
      observers: [...self._state.observers, observer],
    }),
)

/**
 * Reverse the sort order (sets ScanIndexForward = false).
 */
export const reverse = <A>(self: Query<A>): Query<A> =>
  new QueryImpl<A>({
    ...self._state,
    scanForward: false,
  })

/**
 * Enable consistent reads for this query (or scan). Sent as asked: DynamoDB
 * rejects it on a global secondary index, which it reads only eventually
 * consistently, and the query fails with a `ValidationError`
 * (`operation: "query.consistentRead"`) naming the index (#144).
 */
export const consistentRead: {
  (): <A>(self: Query<A>) => Query<A>
  <A>(self: Query<A>): Query<A>
} = Function.dual(
  (args) => isQuery(args[0]),
  <A>(self: Query<A>): Query<A> =>
    new QueryImpl<A>({
      ...self._state,
      consistentRead: true,
    }),
)

/**
 * Set the maximum number of DynamoDB pages to fetch.
 * Pagination stops after this many pages even if `LastEvaluatedKey` is present.
 */
export const maxPages: {
  (n: number): <A>(self: Query<A>) => Query<A>
  <A>(self: Query<A>, n: number): Query<A>
} = Function.dual(
  2,
  <A>(self: Query<A>, n: number): Query<A> =>
    new QueryImpl<A>({
      ...self._state,
      maxPagesValue: n,
    }),
)

/**
 * Skip the `__edd_e__` entity type filter on this query.
 * Useful for cross-entity queries or when you know the partition only contains
 * items of the expected type.
 */
export const ignoreOwnership = <A>(self: Query<A>): Query<A> =>
  new QueryImpl<A>({
    ...self._state,
    ignoreOwnershipFlag: true,
  })

/**
 * Set the starting cursor for pagination. The cursor is an opaque string
 * returned by {@link execute} that encodes where the query resumes. Pass an
 * empty string to start from the beginning.
 *
 * The cursor is read when a terminal runs, not here: a malformed one fails
 * the terminal with a `ValidationError` (`[EDD-9094]`,
 * `operation: "query.startFrom"`), as does a `.within()` cursor on a query
 * without `.within()`. A `.within()` query also refuses one from another
 * plan (other bounds, partition, direction or index declaration) or
 * positioned outside its own. A query without `.within()` can't recognise
 * another query's well-formed cursor: DynamoDB may reject it
 * (`DynamoValidationError`) or the query resumes from it.
 */
export const startFrom: {
  (cursor: string): <A>(self: Query<A>) => Query<A>
  <A>(self: Query<A>, cursor: string): Query<A>
} = Function.dual(
  2,
  <A>(self: Query<A>, cursor: string): Query<A> =>
    cursor === ""
      ? self
      : new QueryImpl<A>({
          ...self._state,
          cursorText: cursor,
        }),
)

/**
 * @internal Install a bound query's #171 planning state: the planner its
 * `.within()` built, with the skip-scan probe budget, or the options of its
 * `.zorder()`, merged over earlier ones (validated there). The planner is a
 * factory, resolved from the final state when a terminal runs, so the
 * combinators that follow (`reverse`, `startFrom`, …) still apply. Not a
 * combinator: Z-order and skip-scan are reached through `BoundQuery`.
 */
export const plan = <A>(
  self: Query<A>,
  install:
    | { readonly planner: PlannerFactory; readonly maxSkips: number | undefined }
    | { readonly zorder: ZOrderOptions },
): Query<A> => {
  if (self._state.fanOut !== undefined) throw shardedPlanRefusal(self._state)
  return new QueryImpl<A>(
    "zorder" in install
      ? { ...self._state, zorderOptions: { ...self._state.zorderOptions, ...install.zorder } }
      : { ...self._state, planner: install.planner, maxSkips: install.maxSkips },
  )
}

/**
 * @internal `[EDD-9104]`: `.within()`, skip-scan and `.zorder()` plan one
 * partition's reads, so a sharded index would need a plan per shard. A follow-up.
 */
const shardedPlanRefusal = (state: QueryState): Error =>
  new Error(
    `[EDD-9104] Index "${state.indexName}" of ${state.entityTypes.join(", ") || "this query"} is ` +
      `sharded: .within(), skip-scan and .zorder() aren't supported on a sharded index. Use the ` +
      `accessor's sort key composites or .where(), or .filter() for the rest.`,
  )

/** @internal {@link shardedPlanRefusal}, for an accessor to raise before it plans. */
export const refuseShardedPlan = (self: Query<unknown>): void => {
  if (self._state.fanOut !== undefined) throw shardedPlanRefusal(self._state)
}

/**
 * @internal A query no stored row satisfies (#171) — a `.history()` bound with
 * no key text below it (`lt("")` on a string orderBy) — planned `empty`, as a
 * `.within()` whose bounds admit no value is: nothing is sent, the terminals
 * return no items, and `explain()` reports the `empty` plan.
 */
export const planEmpty = <A>(self: Query<A>): Query<A> =>
  // Nothing is read, so no partition is: a fan-out has nothing left to merge.
  plan(new QueryImpl<A>({ ...self._state, fanOut: undefined }), {
    planner: compositePlanner({
      entityType: self._state.entityTypes.join(", ") || "unknown",
      index: self._state.indexName ?? "primary",
      pkField: self._state.pkField,
      pkValue: self._state.pkValue,
      skField: self._state.skField ?? "",
      fingerprint: "empty",
      space: { _tag: "none" },
      inner: {
        _tag: "single",
        conditionFor: () => {
          throw new Error("[internal] An empty plan has no range.")
        },
        rowCheck: undefined,
        empty: true,
      },
      filterPlan: { prefix: "", rowCheck: undefined },
      ineligible: undefined,
    }),
    maxSkips: undefined,
  })

/** @internal The decoder of a projected (raw) row: the raw-row hook, or the identity. */
const rawRowDecoder = (
  hook: QueryRawRow | undefined,
): ((raw: Record<string, unknown>) => Effect.Effect<unknown, ValidationError>) =>
  hook ?? ((raw) => Effect.succeed(raw))

/** @internal Throw `[EDD-9076]` for a projection inside a packed attribute. */
const refusePackedProjection = (
  state: QueryState,
  paths: ReadonlyArray<ReadonlyArray<string | number>>,
): void => {
  const refused = packedProjectionRefusal(paths, state.packed)
  if (refused !== undefined) throw new Error(refused)
}

/**
 * Select specific attributes to return (ProjectionExpression).
 * Reduces read capacity and network transfer. When projection is active,
 * items are returned as raw `Record<string, unknown>` instead of decoded
 * schema instances, since projected items may be partial.
 *
 * An attribute stored packed (`DynamoModel.Packed` — an EventStore stream's
 * `data`, for one) comes back as its parsed JSON, whatever its stored form
 * (a native map, a JSON string, or compressed bytes), and may only be
 * selected whole: a path inside it throws `[EDD-9076]`.
 */
export const select: {
  (attributes: ReadonlyArray<string>): <A>(self: Query<A>) => Query<Record<string, unknown>>
  <A>(self: Query<A>, attributes: ReadonlyArray<string>): Query<Record<string, unknown>>
} = Function.dual(
  2,
  <A>(self: Query<A>, attributes: ReadonlyArray<string>): Query<Record<string, unknown>> => {
    if (self._state.predicates.length > 0) {
      throw new Error(rejectPredicateWithProjection("select() after filterBy()"))
    }
    const paths = attributes.map((attribute) => [attribute])
    refusePackedProjection(self._state, paths)
    return new QueryImpl<Record<string, unknown>>({
      ...self._state,
      projection: attributes,
      decoder: rawRowDecoder(projectedRawRow(self._state.rawRow, paths)),
    })
  },
)

/**
 * @internal A projection of stored attribute paths, decoded by `decode`: what
 * `select` becomes when the names a caller asks for are not the names stored
 * (#133). Always numbered placeholders (`#proj0`), whatever characters the
 * stored names hold.
 */
export const selectProjected = <A>(
  self: Query<A>,
  storedPaths: ReadonlyArray<ReadonlyArray<string | number>>,
  decode: (raw: Record<string, unknown>) => unknown,
): Query<Record<string, unknown>> => {
  if (self._state.predicates.length > 0) {
    throw new Error(rejectPredicateWithProjection("select() after filterBy()"))
  }
  refusePackedProjection(self._state, storedPaths)
  const rawRow = rawRowDecoder(projectedRawRow(self._state.rawRow, storedPaths))
  return new QueryImpl<Record<string, unknown>>({
    ...self._state,
    projection: undefined,
    projectionPaths: storedPaths,
    decoder: (raw) =>
      Effect.map(
        rawRow(raw),
        (row) => decode(row as Record<string, unknown>) as Record<string, unknown>,
      ),
  })
}

/**
 * @internal `select` / `selectPaths` of DOMAIN field names on an entity that
 * stores some under other names (`DynamoModel.configure(..., { field })`): the
 * projection names the stored attributes, and each item is handed back keyed
 * by the domain names asked for (#133).
 */
export const selectRenamed = <A>(
  self: Query<A>,
  paths: ReadonlyArray<ReadonlyArray<string | number>>,
  resolveDbName: (domainName: string) => string,
): Query<Record<string, unknown>> => {
  const heads = [...new Set(paths.map((path) => String(path[0])))]
  return selectProjected(
    self,
    paths.map((path) => storedPath(path, resolveDbName)),
    (raw) => {
      const item: Record<string, unknown> = {}
      for (const head of heads) {
        const value = raw[resolveDbName(head)]
        if (value !== undefined) item[head] = value
      }
      return item
    },
  )
}

/**
 * Add an Expr-based filter expression to the query.
 * Multiple filterExpr calls are ANDed together.
 *
 * On a query whose items store an attribute packed (`DynamoModel.Packed` — an
 * EventStore stream with `storedAs.data`, for one), a filter that addresses a
 * path inside it, or applies anything but `attribute_exists` /
 * `attribute_not_exists` to it, throws `[EDD-9076]`: DynamoDB sees one opaque
 * value. Use {@link filterBy}, which runs on the decoded item.
 */
export const filterExpr: {
  (expr: Expr): <A>(self: Query<A>) => Query<A>
  <A>(self: Query<A>, expr: Expr): Query<A>
} = Function.dual(
  2,
  <A>(self: Query<A>, expr: Expr): Query<A> =>
    filterExprStored(
      self,
      self._state.storedAt === undefined ? expr : operandsAsStored(expr, self._state.storedAt),
    ),
)

/**
 * @internal {@link filterExpr} for an expression whose operands are already in the form its
 * attributes hold (`operandsAsStored`, #242), with its paths' stored names: added as it is. A bound
 * query's and `Entity.filter`'s, which put them so with the names their own owner resolves.
 */
export const filterExprStored = <A>(self: Query<A>, expr: Expr): Query<A> => {
  // A filter that asserts nothing (`.filter({})`, `and()`) is no filter: it is
  // dropped here, never sent as `FilterExpression: ""`, which DynamoDB
  // rejects (#133). An empty part anywhere else — under `or` or `not`, or an
  // `or()` with no parts — is kept, and refused when the query runs
  // (`emptyPartProblem`).
  if (isEmptyExpr(expr)) return self
  const refused = packedExprRefusal(expr, self._state.packed, "filter")
  if (refused !== undefined) throw new Error(refused)
  return new QueryImpl<A>({
    ...self._state,
    exprFilters: [...self._state.exprFilters, expr],
  })
}

/**
 * Add a **client-side** predicate, evaluated on the decoded item.
 *
 * `limit` is a contract on results, and the request loop fills a page by
 * accumulating until `n` items are accepted, rebuilding the cursor from the
 * last accepted item. Until now only `FilterExpression` could take part in
 * that loop, so a predicate DynamoDB cannot express had to be applied after
 * `execute` — which breaks pagination two ways: the page comes back short, and
 * its cursor resumes after the last item RETURNED rather than the last one
 * KEPT, skipping rows (#122).
 *
 * A predicate registered here runs inside the loop instead, so `limit` still
 * fills the page and the cursor still lands after the last accepted item.
 *
 * **Prefer {@link filter} whenever DynamoDB can express the condition.** A
 * `FilterExpression` is evaluated before the rows cross the wire; this runs
 * after, so every examined row is still read and paid for. Reach for it when
 * the comparison is not expressible server-side — case-insensitive matching is
 * the standard case, since DynamoDB has no `lower()` and a `FilterExpression`
 * compares the stored attribute byte-for-byte:
 *
 * ```ts
 * query.pipe(
 *   Query.filterBy((venue) => venue.name.toLowerCase().startsWith("melbourne")),
 *   Query.limit(25),
 *   Query.execute,
 * )
 * ```
 *
 * Composite KEYS do not have this problem — `DynamoSchema.applyCasing` folds
 * both the stored key and the operand — so take as much as the key prefix can
 * carry and match the rest here.
 *
 * Multiple predicates are ANDed. They cannot be combined with a projection
 * ({@link select} / {@link selectPaths}), which would hand the predicate an
 * item missing the attributes it reads — see EDD-9054.
 */
export const filterBy: {
  <A>(predicate: (item: A) => boolean): (self: Query<A>) => Query<A>
  <A>(self: Query<A>, predicate: (item: A) => boolean): Query<A>
} = Function.dual(2, <A>(self: Query<A>, predicate: (item: A) => boolean): Query<A> => {
  if (self._state.projection !== undefined || self._state.projectionPaths !== undefined) {
    throw new Error(rejectPredicateWithProjection("filterBy() after select()"))
  }
  return new QueryImpl<A>({
    ...self._state,
    predicates: [...self._state.predicates, predicate as (item: never) => boolean],
  })
})

/**
 * @internal A projection and a client-side predicate cannot both be active.
 *
 * The predicate is an opaque closure, so the library cannot know which
 * attributes it reads and cannot borrow them into the ProjectionExpression the
 * way {@link cursorProjectionFields} borrows key attributes. Under a projection
 * the predicate would silently receive an item whose fields are absent and
 * quietly reject (or accept) every row. Refuse instead — the combination has no
 * correct reading the library can pick on the caller's behalf.
 */
const rejectPredicateWithProjection = (what: string): string =>
  `[EDD-9054] ${what} is not supported: a client-side predicate runs on the decoded ` +
  "item, but a projection returns only the attributes it names, and the predicate is a " +
  "closure whose attribute reads the library cannot see — so it would be handed items " +
  "missing the fields it tests. Drop the projection, or express the condition as a " +
  "server-side .filter() which DynamoDB evaluates against the stored item."

/**
 * Apply path-based projections. Compiles path segments to ProjectionExpression.
 * When projection is active, items are returned as raw `Record<string, unknown>`.
 */
export const selectPaths: {
  (
    paths: ReadonlyArray<ReadonlyArray<string | number>>,
  ): <A>(self: Query<A>) => Query<Record<string, unknown>>
  <A>(
    self: Query<A>,
    paths: ReadonlyArray<ReadonlyArray<string | number>>,
  ): Query<Record<string, unknown>>
} = Function.dual(
  2,
  <A>(
    self: Query<A>,
    paths: ReadonlyArray<ReadonlyArray<string | number>>,
  ): Query<Record<string, unknown>> => {
    if (self._state.predicates.length > 0) {
      throw new Error(rejectPredicateWithProjection("select() after filterBy()"))
    }
    refusePackedProjection(self._state, paths)
    return new QueryImpl<Record<string, unknown>>({
      ...self._state,
      projectionPaths: paths,
      decoder: rawRowDecoder(projectedRawRow(self._state.rawRow, paths)),
    })
  },
)

// ---------------------------------------------------------------------------
// Internal: shared filter clause builder (entity type + user filters)
// ---------------------------------------------------------------------------

const buildFilterClauses = (state: QueryState) => {
  const names: Record<string, string> = {}
  const values: Record<string, AttributeValue> = {}
  const filterClauses: Array<string> = []

  // Entity type filter (skipped when ignoreOwnership is set)
  if (!state.ignoreOwnershipFlag && state.entityTypes.length > 0) {
    const etPlaceholders = state.entityTypes.map((_, i) => `:et${i}`)
    filterClauses.push(`#eddE IN (${etPlaceholders.join(", ")})`)
    names["#eddE"] = "__edd_e__"
    state.entityTypes.forEach((et, i) => {
      values[`:et${i}`] = toAttributeValue(et)
    })
  }

  // Expr-based filters (compiled from Entity.filter() callback/shorthand API),
  // and a plan's own (#171). Compiled as ONE expression: each compile numbers
  // its placeholders from zero, so two compiled apart both wrote `#e0` and the
  // second overwrote the first's name (#133).
  const planFilter = state.plan?.planner.filter
  const exprFilters =
    planFilter === undefined ? state.exprFilters : [...state.exprFilters, planFilter]
  if (exprFilters.length > 0) {
    const compiled = compileExpr(
      exprFilters.length === 1
        ? exprFilters[0]!
        : ({ [ExprTag]: ExprTag, _tag: "and", exprs: exprFilters } as Expr),
    )
    // Parenthesised beside the ownership clause: a top-level `OR` would
    // otherwise bind looser than the `AND` and admit other entities' rows
    // (`#eddE IN (:et0) AND a OR b`).
    filterClauses.push(filterClauses.length > 0 ? `(${compiled.expression})` : compiled.expression)
    Object.assign(names, compiled.names)
    Object.assign(values, compiled.values)
  }

  return { filterClauses, names, values }
}

// ---------------------------------------------------------------------------
// Internal: build projection expression from state
// ---------------------------------------------------------------------------

const buildProjection = (
  state: QueryState,
  names: Record<string, string>,
  extraFields: ReadonlyArray<string> = [],
): string | undefined => {
  if (state.projectionPaths && state.projectionPaths.length > 0) {
    const counter = { value: 0 }
    const projParts: Array<string> = []
    for (const segments of state.projectionPaths) {
      // A path inside an attribute borrowed whole is read with it: DynamoDB
      // rejects overlapping projection paths (see `selectedInside`).
      if (segments.length > 1 && extraFields.includes(String(segments[0]))) continue
      projParts.push(compilePath(segments, names, "proj", counter))
    }
    for (const field of extraFields) {
      projParts.push(compilePath([field], names, "proj", counter))
    }
    return projParts.join(", ")
  }
  if (state.projection && state.projection.length > 0) {
    const proj = Projection.projection([...state.projection, ...extraFields])
    Object.assign(names, proj.names)
    return proj.expression
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Internal: build DynamoDB command input from state
// ---------------------------------------------------------------------------

interface DynamoCommandInput {
  readonly KeyConditionExpression?: string | undefined
  readonly FilterExpression?: string | undefined
  readonly ProjectionExpression?: string | undefined
  readonly ExpressionAttributeNames?: Record<string, string> | undefined
  readonly ExpressionAttributeValues?: Record<string, AttributeValue> | undefined
  readonly ConsistentRead?: boolean | undefined
}

const buildCommandInput = (
  state: QueryState,
  extraProjectionFields: ReadonlyArray<string> = [],
): DynamoCommandInput => {
  const fc = buildFilterClauses(state)
  const names = { ...fc.names }
  const values = { ...fc.values }
  let keyCondition: string | undefined

  // Key condition (query mode only)
  if (!state.isScan) {
    names["#pk"] = state.pkField
    values[":pk"] = toAttributeValue(state.pkValue)
    keyCondition = "#pk = :pk"

    if (state.skConditions.length > 0) {
      const skCond = state.skConditions[0]!
      names["#sk"] = skCond.field
      const cond = skCond.condition
      if ("eq" in cond) {
        keyCondition += " AND #sk = :sk"
        values[":sk"] = toAttributeValue(cond.eq)
      } else if ("lt" in cond) {
        keyCondition += " AND #sk < :sk"
        values[":sk"] = toAttributeValue(cond.lt)
      } else if ("lte" in cond) {
        keyCondition += " AND #sk <= :sk"
        values[":sk"] = toAttributeValue(cond.lte)
      } else if ("gt" in cond) {
        keyCondition += " AND #sk > :sk"
        values[":sk"] = toAttributeValue(cond.gt)
      } else if ("gte" in cond) {
        keyCondition += " AND #sk >= :sk"
        values[":sk"] = toAttributeValue(cond.gte)
      } else if ("between" in cond) {
        keyCondition += " AND #sk BETWEEN :sk1 AND :sk2"
        values[":sk1"] = toAttributeValue(cond.between[0])
        values[":sk2"] = toAttributeValue(cond.between[1])
      } else if ("beginsWith" in cond) {
        keyCondition += " AND begins_with(#sk, :sk)"
        values[":sk"] = toAttributeValue(cond.beginsWith)
      }
    }
  }

  const projectionExpression = buildProjection(state, names, extraProjectionFields)

  return {
    KeyConditionExpression: keyCondition,
    FilterExpression: fc.filterClauses.length > 0 ? fc.filterClauses.join(" AND ") : undefined,
    ProjectionExpression: projectionExpression,
    ExpressionAttributeNames: Object.keys(names).length > 0 ? names : undefined,
    ExpressionAttributeValues: Object.keys(values).length > 0 ? values : undefined,
    ConsistentRead: state.consistentRead || undefined,
  }
}

/**
 * @internal Build the full DynamoDB command parameters from state and table name.
 *
 * The default `Limit` is the first request's (what {@link asParams} reports).
 * A terminal supplies each request's own through `overrides`: it shrinks as a
 * `limit` budget is consumed and follows the observed pass rate.
 */
const buildDynamoCommand = (
  state: QueryState,
  tableName: string,
  overrides?: Record<string, unknown>,
  extraProjectionFields: ReadonlyArray<string> = [],
) => {
  const input = buildCommandInput(state, extraProjectionFields)
  return {
    TableName: tableName,
    IndexName: state.indexName,
    KeyConditionExpression: input.KeyConditionExpression,
    FilterExpression: input.FilterExpression,
    ProjectionExpression: input.ProjectionExpression,
    ExpressionAttributeNames: input.ExpressionAttributeNames,
    ExpressionAttributeValues: input.ExpressionAttributeValues,
    ConsistentRead: input.ConsistentRead,
    Limit: requestLimit(state, state.limitValue, emptyEstimator, 1),
    ScanIndexForward: state.isScan ? undefined : state.scanForward,
    // An LSI that does not project the items: DynamoDB fetches them from the
    // table. Not with a ProjectionExpression, which DynamoDB rejects beside
    // `Select: ALL_ATTRIBUTES` (and which fetches the named attributes itself).
    ...(state.hydration?._tag === "Fetch" && input.ProjectionExpression === undefined
      ? { Select: "ALL_ATTRIBUTES" as const }
      : {}),
    ...overrides,
  }
}

/**
 * @internal The state the index request is built from. A `BatchGet`-hydrated
 * query sends its projection on the `BatchGetItem`, not on the index query
 * (whose rows only carry keys).
 */
const indexQueryState = (state: QueryState): QueryState =>
  state.hydration?._tag === "BatchGet"
    ? { ...state, projection: undefined, projectionPaths: undefined }
    : state

/**
 * @internal Replace index rows with the table items they refer to, for a
 * `BatchGet`-hydrated query (see {@link QueryHydration}); any other query's
 * rows are returned as they are. The result is in `rows` order, `undefined`
 * for an item that no longer exists (it is dropped like an excluded row).
 */
const hydrateRows = (
  client: DynamoClientService,
  tableName: string,
  state: QueryState,
  rows: ReadonlyArray<Record<string, AttributeValue>>,
): Effect.Effect<ReadonlyArray<Record<string, AttributeValue> | undefined>, DynamoClientError> => {
  const hydration = state.hydration
  if (hydration?._tag !== "BatchGet" || rows.length === 0) return Effect.succeed(rows)
  return Effect.gen(function* () {
    const [pkName, skName] = hydration.tableKey
    const requests: Array<{ tableName: string; key: Record<string, AttributeValue> }> = []
    for (const row of rows) {
      const pk = row[pkName]
      const sk = row[skName]
      if (pk === undefined || sk === undefined) {
        // Table keys are always projected into a secondary index.
        return yield* Effect.die(
          new Error(
            `Query hydration: an index row of "${state.indexName}" lacks the table key ` +
              `attribute "${pk === undefined ? pkName : skName}".`,
          ),
        )
      }
      requests.push({ tableName, key: { [pkName]: pk, [skName]: sk } })
    }
    const ownership = !state.ignoreOwnershipFlag && state.entityTypes.length > 0
    // A `select` moves here: the projection, plus what matching (the table
    // key) and the ownership check read — stripped again unless selected.
    const names: Record<string, string> = {}
    const projected = new Set<string>([
      ...(state.projection ?? []),
      ...(state.projectionPaths ?? []).map((segments) => String(segments[0])),
    ])
    const borrowed =
      projected.size === 0
        ? []
        : [
            ...new Set([
              pkName,
              skName,
              ...(ownership ? ["__edd_e__"] : []),
              ...rawRowReads(state),
            ]),
          ].filter((field) => !projected.has(field))
    // What the raw-row hook reads survives until it has run (see `examinePage`).
    const keptForRawRow = new Set(rawRowReads(state))
    const expression = buildProjection(state, names, borrowed)
    const fetched = yield* batchGetRaw(client, requests, {
      projection: expression === undefined ? undefined : { expression, names },
      rereadMissing: true,
    })
    const hydrated: Array<Record<string, AttributeValue> | undefined> = []
    for (const item of fetched) {
      if (item === undefined) {
        hydrated.push(undefined)
        continue
      }
      if (ownership) {
        const owner = item.__edd_e__?.S
        if (owner === undefined || !state.entityTypes.includes(owner)) {
          // The index row passed the same `__edd_e__` filter: a defect.
          return yield* Effect.die(
            new Error(
              `Query hydration: an item fetched through index "${state.indexName}" has ` +
                `__edd_e__ ${JSON.stringify(owner)}, not ` +
                `${state.entityTypes.map((t) => JSON.stringify(t)).join(" or ")}, although ` +
                "its index row passed the same filter.",
            ),
          )
        }
      }
      if (borrowed.length === 0) {
        hydrated.push(item)
        continue
      }
      const stripped = { ...item }
      for (const field of borrowed) if (!keptForRawRow.has(field)) delete stripped[field]
      hydrated.push(stripped)
    }
    return hydrated
  })
}

// ---------------------------------------------------------------------------
// Internal: limit / pageSize execution helpers
// ---------------------------------------------------------------------------

/** The largest `Limit` a growing request asks for: DynamoDB stops at 1 MB anyway. */
const MAX_GROWN_LIMIT = 100_000

/** The first filtered request asks for `remaining × INITIAL_FACTOR` rows, at least `MIN_FIRST`. */
const INITIAL_FACTOR = 2
const MIN_FIRST = 16
/** Headroom over the rows the observed pass rate says the outstanding items need. */
const SAFETY = 1.25
/** How much a request grows over the last when nothing passed it. */
const GROWTH = 2

/**
 * @internal How a terminal sizes its requests' `Limit` — one mode per query:
 *
 * - `fixed` — a numeric {@link pageSize}, used as given (and, as in 1.36,
 *   capped at the outstanding `limit` when nothing filters).
 * - `natural` — `pageSize("natural")`, or a {@link maxPages} cap: exactly
 *   1.36's sizing ({@link legacyRequestLimit}). A capped request count keeps
 *   it because smaller requests would change what one call returns.
 * - `none` — no {@link limit}: natural pages (or `pageSize`), as in 1.36.
 * - `adaptive` — a `limit` under a filter, a predicate, a plan's row check
 *   or rows dropped as history: each `Limit` follows the observed pass rate
 *   ({@link nextLimit}).
 * - `budget` — a `limit` nothing filters: every examined row is an accepted
 *   row, so `Limit` is the outstanding budget. The `__edd_e__` ownership
 *   clause alone stays here: it only rejects foreign rows, which the loop
 *   makes up by fetching another page.
 */
type SizingMode = "fixed" | "natural" | "none" | "budget" | "adaptive"

const sizingMode = (state: QueryState): SizingMode => {
  if (typeof state.pageSizeValue === "number") return "fixed"
  if (state.pageSizeValue === "natural") return "natural"
  if (state.limitValue === undefined) return "none"
  // Planned queries (`.within()`) and fan-outs are new, so they adapt under
  // `maxPages` too: there is no 1.36 sizing to keep.
  if (state.maxPagesValue !== undefined && state.planner === undefined && !isFanOutState(state)) {
    return "natural"
  }
  if (filtered(state) || dropsRows(state)) return "adaptive"
  return "budget"
}

/** @internal Does this state read a sharded index's partitions? */
const isFanOutState = (state: QueryState): boolean => state.fanOut !== undefined

/**
 * @internal Whether rows are filtered — server-side (the caller's filter or a
 * plan's own, #171), with a client predicate or by a plan's row check — so a
 * request cannot assume every row it examines passes. (A row check also
 * {@link dropsRows}: it is judged on the raw row.)
 */
const filtered = (state: QueryState): boolean =>
  state.exprFilters.length > 0 ||
  state.predicates.length > 0 ||
  state.plan?.planner.filter !== undefined ||
  state.rowCheck !== undefined

/**
 * @internal What one terminal call's requests have observed: rows examined
 * (`ScannedCount`), rows accepted as items, and the last request's `Limit`,
 * rows examined and acceptances. Plain data, kept in the loop (or
 * `pageStream`'s page state) and never in a cursor: a resumed query starts
 * fresh.
 */
interface Estimator {
  readonly examined: number
  readonly accepted: number
  readonly lastLimit: number
  readonly lastExamined: number
  readonly lastAccepted: number
  readonly requests: number
}

const emptyEstimator: Estimator = {
  examined: 0,
  accepted: 0,
  lastLimit: 0,
  lastExamined: 0,
  lastAccepted: 0,
  requests: 0,
}

/**
 * @internal The adaptive `Limit` of the next request, `remaining` items still
 * owed:
 *
 * - The first asks for twice `remaining` (at least 16) when the caller filters
 *   — nothing is known of the pass rate yet — and for `remaining` when only
 *   history rows are dropped, #133's first request.
 * - While nothing has been accepted, each asks for twice the last, so a run of
 *   `n` rejected rows costs about `log2(n / limit)` requests (#133).
 * - Then `remaining` over the pass rate, with 25% headroom. The rate is the
 *   lower of the cumulative one and the last request's own: after an early
 *   cluster of matches the cumulative rate stays high long after the matches
 *   thin out, and alone it would size the request after each isolated later
 *   match at a few dozen rows. After a request that accepted nothing, the
 *   `Limit` at least doubles (a long run of misses).
 *
 * So a request that neither fills the limit nor reaches DynamoDB's 1 MB cap
 * is followed by one at least twice its size unless it accepted over a third
 * of what was owed, and a query sends a logarithmic number of requests more
 * than natural 1 MB pages. Clamped to 1..100,000 (DynamoDB stops at 1 MB
 * anyway).
 */
const nextLimit = (est: Estimator, remaining: number, filteredByUser: boolean): number => {
  let limit: number
  if (est.requests === 0) {
    limit = filteredByUser ? Math.max(MIN_FIRST, Math.ceil(remaining * INITIAL_FACTOR)) : remaining
  } else if (est.accepted === 0) {
    limit = est.lastLimit * GROWTH
  } else {
    // Never above 1, whatever a response reports as examined.
    const cumulative = est.accepted / Math.max(est.examined, est.accepted)
    const rate =
      est.lastAccepted > 0
        ? Math.min(cumulative, est.lastAccepted / Math.max(est.lastExamined, est.lastAccepted))
        : cumulative
    limit = Math.ceil((remaining / rate) * SAFETY)
    if (est.lastAccepted === 0) limit = Math.max(limit, est.lastLimit * GROWTH)
  }
  return Math.min(Math.max(limit, 1), MAX_GROWN_LIMIT)
}

/**
 * @internal `est` after one more request: sent with `limitSent`, it examined
 * `scanned` rows (`ScannedCount`, or the rows returned when a response lacks
 * it), of which `accepted` became items.
 */
const observeEstimator = (
  est: Estimator,
  observed: {
    readonly scanned: number
    readonly accepted: number
    readonly limitSent: number | undefined
  },
): Estimator => ({
  examined: est.examined + observed.scanned,
  accepted: est.accepted + observed.accepted,
  // A request without `Limit` (only outside adaptive sizing) asked for what it read.
  lastLimit: observed.limitSent ?? observed.scanned,
  lastExamined: observed.scanned,
  lastAccepted: observed.accepted,
  requests: est.requests + 1,
})

/**
 * @internal DynamoDB `Limit` for read number `page` (1-based within the
 * terminal; a skip-scan's probes are not reads), `remaining` items still owed
 * (`undefined` without a {@link limit}) and `est` what the earlier reads
 * observed. Adaptive sizing is {@link nextLimit}; every other mode of
 * {@link sizingMode} is 1.36's {@link legacyRequestLimit}.
 */
const requestLimit = (
  state: QueryState,
  remaining: number | undefined,
  est: Estimator,
  page: number,
): number | undefined =>
  remaining !== undefined && sizingMode(state) === "adaptive"
    ? nextLimit(est, remaining, filtered(state))
    : legacyRequestLimit(state, remaining, page)

/**
 * @internal The `Limit` of a planned read: a `jump` read's follows its in-box
 * run (design §8.5) unless `.zorder({ pageSize })` or a numeric `.pageSize(n)`
 * fixes it, capped near what the outstanding `limit` needs; every other read
 * is sized as {@link requestLimit} sizes any request.
 */
const readLimit = (
  state: QueryState,
  step: ReadStep,
  remaining: number | undefined,
  est: Estimator,
  read: number,
): number | undefined => {
  if (step.sizing._tag !== "jump") return requestLimit(state, remaining, est, read)
  const fixed =
    state.zorderOptions?.pageSize ??
    (typeof state.pageSizeValue === "number" ? state.pageSizeValue : undefined)
  if (fixed !== undefined) return fixed
  const run =
    remaining === undefined
      ? step.sizing.run
      : Math.min(step.sizing.run, Math.max(JUMP_INITIAL, Math.ceil(remaining * SAFETY)))
  return Math.min(Math.max(run, 1), JUMP_MAX_LIMIT)
}

/**
 * @internal How many planned ranges a terminal reads at once (design §9.3):
 * `.zorder({ concurrency })`, else 4 with a `limit` (pages sized to it) and 1
 * without (natural 1 MB pages, which several in flight against one partition
 * key would throttle).
 */
const planConcurrency = (state: QueryState): number =>
  state.zorderOptions?.concurrency ?? (state.limitValue !== undefined ? 4 : 1)

/** @internal AWS error names that mean "throttled" (design §9.5). */
const THROTTLING_NAMES: ReadonlySet<string> = new Set([
  "ProvisionedThroughputExceededException",
  "ThrottlingException",
  "RequestLimitExceeded",
])

/**
 * @internal Was a request refused for its rate? The client classifies the
 * first two names as a `ThrottlingError`; `RequestLimitExceeded` (an
 * account's on-demand request cap) reaches here as a `DynamoError`, so the
 * AWS error's name is read too.
 */
const isThrottled = (error: DynamoClientError | ValidationError): boolean => {
  if (error._tag === "ThrottlingError") return true
  if (error._tag !== "DynamoError") return false
  const cause = error.cause as { readonly name?: unknown } | null | undefined
  return typeof cause?.name === "string" && THROTTLING_NAMES.has(cause.name)
}

/**
 * @internal DynamoDB `Limit` for the next request as 1.36 sized it — what
 * `pageSize("natural")`, a numeric `pageSize`, a `maxPages` cap, an unfiltered
 * `limit` and no `limit` at all still send (see {@link sizingMode}).
 *
 * - A numeric `pageSize` always wins as the round-trip budget.
 * - With a `limit` budget and NO user filter, every examined row is an accepted
 *   row, so the budget can be handed to DynamoDB directly (bounded by pageSize).
 * - With a user filter, a client-side predicate ({@link filterBy}) or a plan's
 *   row check (#171), `limit` cannot be expressed as `Limit` (it bounds rows
 *   examined, and the filter runs after), so the request asks for `pageSize`
 *   — or, unset, a natural (1 MB) page.
 * - Rows dropped as history ({@link QueryState.liveRows}, a prepared `keep`)
 *   can't be skipped server-side, and a run of them can far outnumber the
 *   items: the first request asks for `limit` and each later one twice the
 *   last, the surplus past `limit` discarded and the cursor rebuilt from the
 *   last item returned (#133). `pageSize`, when set, is used as is.
 *
 * `page` is the read's 1-based number within the terminal.
 */
const legacyRequestLimit = (
  state: QueryState,
  remaining: number | undefined,
  page = 1,
): number | undefined => {
  const pageSize = typeof state.pageSizeValue === "number" ? state.pageSizeValue : undefined
  if (remaining === undefined) return pageSize
  if (filtered(state)) return pageSize
  if (dropsRows(state)) {
    if (pageSize !== undefined) return pageSize
    const limit = state.limitValue ?? remaining
    return Math.min(limit * 2 ** (page - 1), MAX_GROWN_LIMIT)
  }
  return pageSize === undefined ? remaining : Math.min(pageSize, remaining)
}

/**
 * @internal Whether the query drops rows client-side (#133) — history rows, or
 * rows a plan's row check rejects (#171): like a predicate, it rejects rows
 * after they are read, so the `limit` budget cannot be handed to DynamoDB, and
 * a count has to read the rows.
 */
const dropsRows = (state: QueryState): boolean =>
  state.keepRow !== undefined || state.liveRows !== undefined || state.rowCheck !== undefined

/** @internal Is this raw row one the query leaves out (#133, #171)? */
const isExcludedRow = (state: QueryState, row: Record<string, AttributeValue>): boolean =>
  (state.keepRow !== undefined && !state.keepRow(row)) ||
  (state.liveRows !== undefined && !state.liveRows.isLive(row)) ||
  (state.rowCheck !== undefined && !state.rowCheck.accepts(row))

/** @internal The attributes a query reads to judge which rows it drops ({@link dropsRows}). */
const judgedAttributes = (state: QueryState): ReadonlyArray<string> => [
  ...new Set([
    ...(state.liveRows?.reads ?? []),
    ...(state.keepRow !== undefined && state.skField !== undefined ? [state.skField] : []),
    ...(state.rowCheck?.reads ?? []),
  ]),
]

/**
 * @internal A filter with an empty part where none may be (`emptyPartProblem`):
 * the `ValidationError` every path that builds a request fails with, before
 * `compileExpr` — which throws on one — ever sees it (#133).
 */
const refuseEmptyFilterParts = (state: QueryState): ValidationError | undefined => {
  for (const filter of state.exprFilters) {
    const problem = emptyPartProblem(filter)
    if (problem !== undefined) {
      return new ValidationError({
        entityType: state.entityTypes.join(", ") || "unknown",
        operation: "query.filter",
        cause: `filter: ${problem} Nothing was sent.`,
      })
    }
  }
  return undefined
}

/**
 * @internal The state a terminal runs: {@link QueryState.prepare} applied
 * against the resolved table, the planner resolved and the
 * {@link startFrom} cursor placed — as `exclusiveStartKey`, or as the plan's
 * first step (#171).
 */
const prepared = (
  state: QueryState,
  tableName: string,
): Effect.Effect<QueryState, DynamoClientError | ValidationError, DynamoClient> => {
  if (state.refusal !== undefined) return Effect.fail(state.refusal)
  // `.within()` is offered only where no prepare step is installed (an
  // entity's `versions` installs one).
  if (state.planner !== undefined && state.prepare !== undefined) {
    return Effect.die(new Error("[internal] A planned query cannot also have a prepare step."))
  }
  // A consistent read of a GSI — which DynamoDB only reads eventually
  // consistently — is DynamoDB's to reject: diagnosed by `send` (#144).
  // A filter with an empty part where none may be is refused before
  // anything is sent (#133).
  const filterRefusal = refuseEmptyFilterParts(state)
  if (filterRefusal !== undefined) return Effect.fail(filterRefusal)
  // A sharded index's query reads its partitions (#183), resumed from its cursor.
  if (state.fanOut !== undefined) {
    return Effect.flatMap(applyPrepare(state, tableName), (ready) => {
      const resumed = resumeFanOut(ready, ready.fanOut!)
      return resumed instanceof ValidationError ? Effect.fail(resumed) : Effect.succeed(resumed)
    })
  }
  const resumed = resume(state)
  if (resumed instanceof ValidationError) return Effect.fail(resumed)
  return applyPrepare(resumed, tableName)
}

/** @internal {@link QueryState.prepare}, run against the resolved table and applied. */
const applyPrepare = (
  state: QueryState,
  tableName: string,
): Effect.Effect<QueryState, DynamoClientError, DynamoClient> =>
  state.prepare === undefined
    ? Effect.succeed(state)
    : Effect.map(state.prepare(tableName), (prep) => {
        const swap = prep.replaceBeginsWith
        return {
          ...state,
          prepare: undefined,
          keepRow: prep.keep,
          skConditions:
            swap === undefined
              ? state.skConditions
              : state.skConditions.map((c) =>
                  "beginsWith" in c.condition && c.condition.beginsWith === swap.from
                    ? { ...c, condition: { beginsWith: swap.to } }
                    : c,
                ),
        }
      })

/** @internal The planner a `.within()` installed, resolved against the final state. */
const resolvePlanner = (state: QueryState, factory: PlannerFactory): RangePlanner =>
  factory({
    reverse: !state.scanForward,
    maxSkips: state.maxSkips ?? DEFAULT_MAX_SKIPS,
    zorder: state.zorderOptions,
  })

/**
 * @internal Decode the {@link startFrom} cursor and place it (design §10.2):
 * a query without a planner takes a legacy cursor or a v2 `{ k }`, unchecked
 * (it carries no fingerprint); with one, the planner places it in the
 * recomputed plan. A malformed cursor, a planned query's cursor here without
 * a planner, or one the planner refuses is `[EDD-9094]`.
 */
const resume = (state: QueryState): QueryState | ValidationError => {
  const entityType = state.entityTypes.join(", ") || "unknown"
  const cursor = state.cursorText === undefined ? undefined : Cursor.decode(state.cursorText)
  if (state.cursorText !== undefined && cursor === undefined) {
    return cursorRefusal(entityType, "it is not a cursor a query returned")
  }
  if (cursor?.z !== undefined) {
    return cursorRefusal(entityType, "it comes from a query of a sharded index, and this isn't one")
  }
  const factory = state.planner
  if (factory === undefined) {
    if (cursor === undefined) return state
    if (
      cursor.k === undefined ||
      cursor.f !== undefined ||
      cursor.s !== undefined ||
      cursor.t !== undefined
    ) {
      return cursorRefusal(
        entityType,
        "it comes from a query with .within(), and this one has none",
      )
    }
    return { ...state, exclusiveStartKey: Cursor.keyFromWire(cursor.k) }
  }
  const planner = resolvePlanner(state, factory)
  const start = planner.start(cursor)
  return start instanceof ValidationError ? start : { ...state, plan: { planner, start } }
}

/** @internal The sort key condition list of a planned request over `range`. */
const plannedConditions = (state: QueryState, range: KeyRange): QueryState["skConditions"] => {
  const condition = toKeyCondition(range)
  return condition === undefined || state.skField === undefined
    ? []
    : [{ field: state.skField, condition }]
}

/** @internal The state one planned read is sent with: its range and its row check. */
const readState = (state: QueryState, step: ReadStep): QueryState => ({
  ...state,
  skConditions: plannedConditions(state, step.range),
  rowCheck: step.rowCheck,
})

/**
 * @internal The state a probe is sent with (design §7.2): its range, no
 * `FilterExpression` (so `Limit: 1` returns a row whenever one exists — the
 * partition holds only this entity's rows), no projection or hydration. It
 * inherits `consistentRead`, so a consistent tuple read never sees a tuple
 * the probe missed.
 */
const probeState = (state: QueryState, step: ProbeStep): QueryState => ({
  ...state,
  skConditions: plannedConditions(state, {
    lower: step.lower,
    upper: step.upper,
    exact: true,
  }),
  exprFilters: [],
  predicates: [],
  ignoreOwnershipFlag: true,
  projection: undefined,
  projectionPaths: undefined,
  hydration: undefined,
  plan: undefined,
  rowCheck: undefined,
})

/**
 * @internal A probe's command: one row, its sort key only. A probe from the
 * start of the partition (a binary skip tuple with no prefix given, #171
 * §7.5) has no sort key condition to declare `#sk`, so it is declared here.
 */
const probeCommand = (state: QueryState, step: ProbeStep, tableName: string) => {
  const command = buildDynamoCommand(probeState(state, step), tableName, {
    Limit: 1,
    ProjectionExpression: "#sk",
  })
  return {
    ...command,
    ExpressionAttributeNames: {
      ...command.ExpressionAttributeNames,
      ...(state.skField === undefined ? {} : { "#sk": state.skField }),
    },
  }
}

/** @internal The cursor of a planned query at `step`: v2, or `None` once done. */
const plannedCursor = (planner: RangePlanner, step: Step): Option.Option<string> => {
  const cursor = planner.cursor(step)
  return cursor === null ? Option.none() : Option.some(Cursor.encodeV2(cursor))
}

/**
 * @internal Send one request of a terminal. DynamoDB's rejection of what the
 * library does not pre-check (#144) is diagnosed against the request sent, on
 * failure only: a consistent read of a GSI, the key condition's rules (an
 * empty key value, a reversed `BETWEEN`) and an `isIn()` with no values in the
 * filter, named as {@link KeyConditionDiagnosis} says. Anything else passes
 * through.
 */
const send = (
  client: DynamoClientService,
  state: QueryState,
  cmd: ReturnType<typeof buildDynamoCommand>,
): Effect.Effect<QueryCommandOutput | ScanCommandOutput, DynamoClientError | ValidationError> => {
  const request: Effect.Effect<QueryCommandOutput | ScanCommandOutput, DynamoClientError> =
    state.isScan ? client.scan(cmd) : client.query(cmd)
  return request.pipe(
    diagnoseFailure({
      sent: () => ({ _tag: "Read", scan: state.isScan, input: cmd }),
      only: ["ConsistentReadOnGsi", "EmptyKeyBound", "BetweenReversed", "EmptyIn"],
      rewrite: (diagnosis, original) => {
        const entityType = state.entityTypes.join(", ") || "unknown"
        const naming = state.keyConditionDiagnosis ?? {
          operation: "query",
          label: `query of ${entityType}`,
        }
        const [operation, label] =
          diagnosis._tag === "ConsistentReadOnGsi"
            ? ["query.consistentRead", "query"]
            : diagnosis._tag === "EmptyIn"
              ? ["query.filter", naming.label]
              : [naming.operation, naming.label]
        return new ValidationError({
          entityType,
          operation,
          cause: withCause(explainDiagnosis(diagnosis, label), original),
        })
      },
    }),
  )
}

/**
 * @internal What a response says it examined and kept: `ScannedCount` and
 * `Count`, each the rows returned when the response lacks it (mocks, older
 * emulators).
 */
const responseCounts = (response: {
  readonly Items?: ReadonlyArray<unknown> | undefined
  readonly Count?: number | undefined
  readonly ScannedCount?: number | undefined
}): { readonly scannedCount: number; readonly count: number } => {
  const returned = response.Items?.length ?? 0
  return {
    scannedCount: response.ScannedCount ?? returned,
    count: response.Count ?? returned,
  }
}

/**
 * @internal Report one request to the query's observers ({@link onRequest}),
 * in order, once its rows have been examined. An observer's failure (or throw)
 * is a defect. They run outside the terminal's consumed-capacity operation, so
 * a DynamoDB call one makes is not charged to the query.
 */
const notify = (
  state: QueryState,
  observed: Omit<QueryRequestEvent, "lower" | "upper" | "discarded"> & {
    readonly discarded?: boolean
  },
): Effect.Effect<void> => {
  if (state.observers.length === 0) return Effect.void
  const [lower, upper] = displayKeyCondition(
    state.isScan ? undefined : state.skConditions[0]?.condition,
  )
  const event: QueryRequestEvent = {
    kind: observed.kind,
    request: observed.request,
    lower,
    upper,
    limit: observed.limit,
    scannedCount: observed.scannedCount,
    count: observed.count,
    accepted: observed.accepted,
    discarded: observed.discarded ?? false,
  }
  return Capacity.detached(
    Effect.forEach(
      state.observers,
      (observer) => Effect.orDie(Effect.suspend(() => observer(event))),
      { discard: true },
    ),
  )
}

/** @internal Does the decoded item pass every client-side predicate? */
const accepts = (state: QueryState, item: unknown): boolean => {
  for (const predicate of state.predicates) {
    if (!(predicate as (i: unknown) => boolean)(item)) return false
  }
  return true
}

/**
 * @internal Attribute names that form a resume key for this response.
 * The `LastEvaluatedKey`, when present, is authoritative about the key shape.
 */
const resumeKeyNames = (
  state: QueryState,
  lastEvaluatedKey: Record<string, AttributeValue> | undefined,
): ReadonlyArray<string> | undefined =>
  lastEvaluatedKey != null ? Object.keys(lastEvaluatedKey) : state.keyFields

/**
 * @internal Rebuild a cursor from the last item actually returned, so the next
 * page resumes after what the caller saw rather than after the last row the
 * request examined. Returns `undefined` when the item does not carry the whole
 * key (e.g. a projection dropped it) — the caller then falls back.
 */
const cursorFromItem = (
  item: Record<string, AttributeValue>,
  names: ReadonlyArray<string> | undefined,
): string | undefined => {
  const key = keyOfItem(item, names)
  return key === undefined ? undefined : encodeCursor(key)
}

/** @internal The resume key `names` pick from `item`, or `undefined` when it lacks one. */
const keyOfItem = (
  item: Record<string, AttributeValue>,
  names: ReadonlyArray<string> | undefined,
): Record<string, AttributeValue> | undefined => {
  if (!names || names.length === 0) return undefined
  const key: Record<string, AttributeValue> = {}
  for (const name of names) {
    const value = item[name]
    if (value === undefined) return undefined
    key[name] = value
  }
  return key
}

/**
 * @internal Key attributes to add to an active ProjectionExpression so an
 * over-reading request can still rebuild an accurate cursor. They are stripped
 * from the items handed back, so the caller sees exactly what it selected.
 */
const cursorProjectionFields = (
  state: QueryState,
  /** Whether the terminal rebuilds a cursor (`execute`); `paginate` doesn't. */
  forCursor: boolean,
): ReadonlyArray<string> => {
  const projected = new Set<string>([
    ...(state.projection ?? []),
    ...(state.projectionPaths ?? []).map((segments) => String(segments[0])),
  ])
  if (projected.size === 0) return []
  // A fan-out always reads them: the merge compares each row's sort key, and a
  // cursor resumes each partition after its last row (#183).
  const borrowed = new Set<string>(
    (!isFanOutState(state) && (!forCursor || state.limitValue === undefined)) || !state.keyFields
      ? []
      : state.keyFields,
  )
  // A query that drops rows reads what it judges them by (#133, #171).
  for (const attr of judgedAttributes(state)) borrowed.add(attr)
  // …and a raw-row hook reads what it dispatches on (a collection's `__edd_e__`).
  for (const attr of rawRowReads(state)) borrowed.add(attr)
  const inside = selectedInside(state)
  return [...borrowed].filter((field) => !projected.has(field) || inside.has(field))
}

/**
 * @internal The attributes a projection selects only paths inside of
 * (`ref.name`), never whole. One a query also borrows — a row check reading a
 * ref-derived composite from its ref (#171) — is read whole, since DynamoDB
 * rejects overlapping projection paths, and handed back whole: stripping it
 * would drop what the caller selected.
 */
const selectedInside = (state: QueryState): ReadonlySet<string> => {
  const paths = state.projectionPaths ?? []
  const whole = new Set<string>([
    ...(state.projection ?? []),
    ...paths.filter((segments) => segments.length === 1).map((segments) => String(segments[0])),
  ])
  return new Set(
    paths
      .filter((segments) => segments.length > 1 && !whole.has(String(segments[0])))
      .map((segments) => String(segments[0])),
  )
}

/**
 * @internal Examine one response's rows in order, as `execute` and `paginate`
 * both do: drop excluded rows, hydrate (see {@link QueryHydration}), decode,
 * apply the client predicates, and stop once `budget` items are accepted.
 *
 * Without a client predicate every row is accepted, so only the rows the
 * budget can still take are hydrated and decoded; a row dropped after
 * hydration (its item gone) widens the window by one. With a predicate,
 * acceptance is only known after decode, so the whole response is examined
 * (#122). `stoppedAt` is the index of the row that filled the budget, or -1.
 * `accepted` counts the rows that became items: an excluded row, a hydration
 * miss and a predicate's rejection are not, and neither is a row past the
 * budget, left unexamined.
 */
const examinePage = <A>(
  client: DynamoClientService,
  tableName: string,
  state: QueryState,
  returned: ReadonlyArray<Record<string, AttributeValue>>,
  budget: number | undefined,
  borrowedFields: ReadonlyArray<string>,
): Effect.Effect<
  {
    readonly items: Array<A>
    readonly stoppedAt: number
    readonly accepted: number
    /** Each item's row in `returned`. */
    readonly rows: ReadonlyArray<number>
  },
  DynamoClientError | ValidationError
> =>
  Effect.gen(function* () {
    // Nothing left to accept. Without this the loop below never advances
    // (`end` stays at `next`) — or, under a predicate, accepts one row past
    // the budget. No terminal asks; a guard all the same (#171).
    if (budget === 0) return { items: [], stoppedAt: -1, accepted: 0, rows: [] }
    const hasPredicate = state.predicates.length > 0 || dropsRows(state)
    // Borrowed attributes the raw-row hook reads are stripped after it ran:
    // borrowed into the request's projection, or — on a `BatchGet`-hydrated
    // query — into the hydrating fetch's (see `hydrateRows`).
    const hookReads = new Set(rawRowReads(state))
    const strippedAfterHook = new Set(borrowedFields.filter((field) => hookReads.has(field)))
    // Borrowed whole, but selected inside: handed back whole.
    const kept = selectedInside(state)
    if (state.hydration?._tag === "BatchGet") {
      const projected = new Set<string>([
        ...(state.projection ?? []),
        ...(state.projectionPaths ?? []).map((segments) => String(segments[0])),
      ])
      if (projected.size > 0) {
        for (const field of hookReads) if (!projected.has(field)) strippedAfterHook.add(field)
      }
    }
    const items: Array<A> = []
    const rows: Array<number> = []
    let next = 0
    while (next < returned.length) {
      const end =
        budget === undefined || hasPredicate
          ? returned.length
          : Math.min(returned.length, next + (budget - items.length))
      const positions: Array<number> = []
      for (let i = next; i < end; i++) {
        if (!isExcludedRow(state, returned[i]!)) positions.push(i)
      }
      const sources = yield* hydrateRows(
        client,
        tableName,
        state,
        positions.map((i) => returned[i]!),
      )
      for (let k = 0; k < positions.length; k++) {
        const source = sources[k]
        if (source === undefined) continue
        const raw = fromAttributeMap(source)
        for (const field of borrowedFields) {
          if (!hookReads.has(field) && !kept.has(field)) delete raw[field]
        }
        const item = yield* state.decoder(raw) as Effect.Effect<A, ValidationError>
        for (const field of strippedAfterHook) delete raw[field]
        if (hasPredicate && !accepts(state, item)) continue
        items.push(item)
        rows.push(positions[k]!)
        if (budget !== undefined && items.length >= budget) {
          return { items, stoppedAt: positions[k]!, accepted: items.length, rows }
        }
      }
      next = end
    }
    return { items, stoppedAt: -1, accepted: items.length, rows }
  })

/**
 * @internal The subject of a query for consumed-capacity reports: its
 * explicit operation target (an event stream's name) or else its entity
 * types, and its physical index, read from the descriptor.
 */
export const operationOptions = (self: Query<unknown>): Capacity.OperationOptions => ({
  target:
    self._state.operationTarget ??
    (self._state.entityTypes.length > 0 ? self._state.entityTypes.join(",") : undefined),
  index: self._state.indexName,
})

// ---------------------------------------------------------------------------
// Page result type
// ---------------------------------------------------------------------------

/**
 * A single page of query results with an opaque cursor for fetching the next page.
 */
export interface Page<A> {
  readonly items: Array<A>
  /**
   * Opaque cursor for the next page — pass it to `.startFrom()` — or `None`
   * when there are no more results.
   */
  readonly cursor: Option.Option<string>
}

// ---------------------------------------------------------------------------
// Terminals
// ---------------------------------------------------------------------------

/**
 * Execute the query and collect the results into a single array.
 * Stops at {@link limit} items when one is set, otherwise reads to the end of
 * the key range (or {@link maxPages} requests).
 */
export const collect = <A>(
  self: Query<A>,
): Effect.Effect<Array<A>, DynamoClientError | ValidationError, DynamoClient> =>
  Capacity.delegate(
    "Query.collect",
    operationOptions(self),
    Effect.gen(function* () {
      const client = yield* Capacity.client
      const tableName = self._state.resolveTableName
        ? yield* self._state.resolveTableName
        : self._state.tableName
      const state = yield* prepared(self._state, tableName).pipe(
        Effect.provideService(DynamoClient, client),
      )
      const ranges = drainedRanges(state)
      if (ranges !== undefined) return yield* collectRanges<A>(client, tableName, state, ranges)
      const pages = yield* Stream.runCollect(pageStream<A>(client, tableName, state))
      return pages.flat()
    }),
  )

/**
 * @internal The ranges a `collect` drains independently (design §9.3): a
 * precise plan read to its end — no `limit`, no `maxPages`, no skip tuple —
 * so every range is read whole and none can be wasted. `undefined` otherwise.
 */
const drainedRanges = (state: QueryState): ReadonlyArray<ReadStep> | undefined => {
  const plan = state.plan
  if (plan === undefined || state.limitValue !== undefined || state.maxPagesValue != null) {
    return undefined
  }
  const start = plan.start
  if (start._tag !== "Read" || start.at.mode !== "precise" || start.planIndex === undefined) {
    return undefined
  }
  return [start, ...plan.planner.following(start, Number.POSITIVE_INFINITY)]
}

/**
 * @internal `collect` over independent ranges: each drained by its own
 * `LastEvaluatedKey` loop, up to {@link planConcurrency} at once, the items
 * concatenated in plan order. The first failure fails the call and interrupts
 * the other reads. Requests are numbered as they are sent.
 */
const collectRanges = <A>(
  client: DynamoClientService,
  tableName: string,
  state: QueryState,
  ranges: ReadonlyArray<ReadStep>,
): Effect.Effect<Array<A>, DynamoClientError | ValidationError> => {
  let requests = 0
  const drain = (first: ReadStep) =>
    Effect.gen(function* () {
      const items: Array<A> = []
      let step = first
      let est = emptyEstimator
      while (true) {
        const request = ++requests
        const response = yield* sendRead(
          client,
          tableName,
          state,
          step,
          undefined,
          est,
          est.requests + 1,
          false,
        )
        const page = yield* examinePage<A>(
          client,
          tableName,
          response.state,
          response.returned,
          undefined,
          response.borrowedFields,
        )
        items.push(...page.items)
        est = observeEstimator(est, {
          scanned: response.counts.scannedCount,
          accepted: page.accepted,
          limitSent: response.limitSent,
        })
        yield* notify(response.state, {
          kind: "read",
          request,
          limit: response.limitSent,
          ...response.counts,
          accepted: page.accepted,
        })
        const lek = response.lastEvaluatedKey
        if (lek === undefined) return items
        step = readFrom(step, lek)
      }
    })
  return Effect.map(
    Effect.forEach(ranges, (range) => drain(range), { concurrency: planConcurrency(state) }),
    (pages) => pages.flat(),
  )
}

/**
 * Execute one page and return a {@link Page} with an opaque cursor.
 *
 * Without {@link limit}, a page is one DynamoDB request (of {@link pageSize}
 * rows, when set). With `limit(n)`, a page is `n` items: the request loop
 * accumulates until `n` items are accepted, the key range is exhausted, or
 * {@link maxPages} requests have been made.
 *
 * The cursor resumes after the last item actually returned — `None` means
 * genuinely exhausted. A `Some` can still lead to an empty page:
 * a request that stops at its `Limit` cannot tell whether another match
 * follows, which is likelier when {@link limit} sizes requests under a
 * filter. Combine with {@link startFrom} to iterate:
 *
 * ```ts
 * const first = yield* query.pipe(Query.limit(25), Query.execute)
 * // Some(page) when there is a next page, None when `first` was the last
 * const second = yield* Effect.transposeOption(
 *   Option.map(first.cursor, (cursor) =>
 *     query.pipe(Query.limit(25), Query.startFrom(cursor), Query.execute),
 *   ),
 * )
 * ```
 */
export const execute = <A>(
  self: Query<A>,
): Effect.Effect<Page<A>, DynamoClientError | ValidationError, DynamoClient> =>
  Capacity.delegate("Query.execute", operationOptions(self), executeCore(self))

const executeCore = <A>(
  self: Query<A>,
): Effect.Effect<Page<A>, DynamoClientError | ValidationError, DynamoClient> =>
  Effect.gen(function* () {
    const client = yield* Capacity.client
    const tableName = self._state.resolveTableName
      ? yield* self._state.resolveTableName
      : self._state.tableName
    const state = yield* prepared(self._state, tableName)
    const indexState = indexQueryState(state)
    const limitValue = state.limitValue

    if (limitValue !== undefined && limitValue <= 0) {
      return { items: [], cursor: Option.none() } as Page<A>
    }
    if (state.fanOutStart !== undefined) {
      return yield* executeFanOut<A>(client, tableName, state, state.fanOutStart)
    }
    if (state.plan !== undefined)
      return yield* executePlanned<A>(client, tableName, state, state.plan)

    // Key attributes borrowed into an active projection so an over-reading
    // request can still rebuild a cursor. Stripped again before decoding.
    const borrowedFields = cursorProjectionFields(indexState, true)

    const items: Array<A> = []
    let startKey = state.exclusiveStartKey
    let pageCount = 0
    let cursor: string | null = null
    let est = emptyEstimator

    while (true) {
      pageCount++
      const remaining = limitValue === undefined ? undefined : limitValue - items.length
      const limitSent = requestLimit(state, remaining, est, pageCount)
      const cmd = buildDynamoCommand(
        indexState,
        tableName,
        { ExclusiveStartKey: startKey, Limit: limitSent },
        borrowedFields,
      )
      const result = yield* send(client, state, cmd)

      const returned = (result.Items ?? []) as Array<Record<string, AttributeValue>>
      const lastEvaluatedKey = result.LastEvaluatedKey as Record<string, AttributeValue> | undefined
      // Index of the last row examined when the limit was reached, else -1.
      const page = yield* examinePage<A>(
        client,
        tableName,
        state,
        returned,
        remaining,
        borrowedFields,
      )
      items.push(...page.items)
      const stoppedAt = page.stoppedAt
      const counts = responseCounts(result)
      est = observeEstimator(est, {
        scanned: counts.scannedCount,
        accepted: page.accepted,
        limitSent,
      })
      yield* notify(state, {
        kind: "read",
        request: pageCount,
        limit: limitSent,
        ...counts,
        accepted: page.accepted,
      })

      // Stopped inside the page: the surplus was discarded, so the cursor has
      // to be rebuilt from the last item handed back rather than from
      // LastEvaluatedKey. `stoppedAt` is the last row ACCEPTED, which is what
      // makes this correct under a predicate — resuming from the last row
      // EXAMINED would skip the rejected rows a later page might still need,
      // and resuming from LastEvaluatedKey would skip the rest of this page.
      if (stoppedAt >= 0 && stoppedAt < returned.length - 1) {
        cursor =
          cursorFromItem(returned[stoppedAt]!, resumeKeyNames(state, lastEvaluatedKey)) ??
          (lastEvaluatedKey != null ? encodeCursor(lastEvaluatedKey) : null)
        break
      }

      const exhausted = lastEvaluatedKey == null
      const limitReached = limitValue !== undefined && items.length >= limitValue
      const maxPagesReached = state.maxPagesValue != null && pageCount >= state.maxPagesValue

      if (limitValue === undefined || exhausted || limitReached || maxPagesReached) {
        cursor = lastEvaluatedKey != null ? encodeCursor(lastEvaluatedKey) : null
        break
      }

      startKey = lastEvaluatedKey
    }

    return { items, cursor: Option.fromNullOr(cursor) } as Page<A>
  })

/** @internal One planned read's response, with the state it was sent with. */
interface SentRead {
  readonly state: QueryState
  readonly borrowedFields: ReadonlyArray<string>
  readonly limitSent: number | undefined
  readonly returned: Array<Record<string, AttributeValue>>
  readonly lastEvaluatedKey: Record<string, AttributeValue> | undefined
  readonly counts: { readonly scannedCount: number; readonly count: number }
}

/**
 * @internal Send one planned read (design §9.2): the step's range and start
 * key over the query's state, its `Limit` sized as any request's — `read` is
 * its number among the terminal's reads.
 */
const sendRead = (
  client: DynamoClientService,
  tableName: string,
  state: QueryState,
  step: ReadStep,
  remaining: number | undefined,
  est: Estimator,
  read: number,
  forCursor: boolean,
): Effect.Effect<SentRead, DynamoClientError | ValidationError> =>
  Effect.gen(function* () {
    const sentState = readState(state, step)
    const indexState = indexQueryState(sentState)
    const borrowedFields = cursorProjectionFields(indexState, forCursor)
    const limitSent = readLimit(sentState, step, remaining, est, read)
    const cmd = buildDynamoCommand(
      indexState,
      tableName,
      { ExclusiveStartKey: step.startKey, Limit: limitSent },
      borrowedFields,
    )
    const result = yield* send(client, sentState, cmd)
    return {
      state: sentState,
      borrowedFields,
      limitSent,
      returned: (result.Items ?? []) as Array<Record<string, AttributeValue>>,
      lastEvaluatedKey: result.LastEvaluatedKey as Record<string, AttributeValue> | undefined,
      counts: responseCounts(result),
    }
  })

/**
 * @internal Send one probe (design §7.2) and report it: the sort key of the
 * first row in its range, or `undefined` when the range is empty.
 */
const sendProbe = (
  client: DynamoClientService,
  tableName: string,
  state: QueryState,
  step: ProbeStep,
  request: number,
): Effect.Effect<KeyValue | undefined, DynamoClientError | ValidationError> =>
  Effect.gen(function* () {
    const sentState = probeState(state, step)
    const result = yield* send(client, sentState, probeCommand(state, step, tableName))
    yield* notify(sentState, {
      kind: "probe",
      request,
      limit: 1,
      ...responseCounts(result),
      accepted: 0,
    })
    const value = state.skField === undefined ? undefined : result.Items?.[0]?.[state.skField]
    return value?.S ?? value?.B
  })

/**
 * @internal `execute` for a planned query (design §9.2): the planner names
 * each step, this loop sends it. The limit and `maxPages` are checked before
 * every request, so a probe is never sent when the call is about to return —
 * the cursor then names the pending step instead.
 *
 * Precise ranges are read in windows: a range and those following it, sent
 * concurrently and examined in plan order. A later member starts fresh (no
 * start key), so its rows are usable only while every earlier member finished
 * its range in one page; the window doubles after a window where all did (up
 * to {@link planConcurrency}) and drops back to one on any
 * `LastEvaluatedKey`. Without a `limit`, a page is one window.
 */
const executePlanned = <A>(
  client: DynamoClientService,
  tableName: string,
  state: QueryState,
  plan: PreparedPlan,
): Effect.Effect<Page<A>, DynamoClientError | ValidationError> =>
  Effect.gen(function* () {
    const { planner } = plan
    const limitValue = state.limitValue
    const maxPages = state.maxPagesValue
    const cap = planConcurrency(state)
    const items: Array<A> = []
    const filled = () => limitValue !== undefined && items.length >= limitValue
    let step = plan.start
    let requests = 0
    let est = emptyEstimator
    let window = 1

    while (true) {
      if (step._tag === "Done") return { items, cursor: Option.none() }
      if (filled() || (maxPages != null && requests >= maxPages)) {
        return { items, cursor: plannedCursor(planner, step) }
      }
      if (step._tag === "Probe") {
        requests++
        step = planner.afterProbe(step, yield* sendProbe(client, tableName, state, step, requests))
        continue
      }
      // The step, plus the ranges following it within the window and the
      // `maxPages` budget (composite and jump plans have none).
      const room = maxPages == null ? window : Math.min(window, maxPages - requests)
      const batch = [step, ...planner.following(step, room - 1)]
      const remainingAtSend = limitValue === undefined ? undefined : limitValue - items.length
      const sent = yield* Effect.forEach(
        batch,
        (member, i) =>
          Effect.result(
            sendRead(
              client,
              tableName,
              state,
              member,
              remainingAtSend,
              est,
              est.requests + i + 1,
              true,
            ),
          ),
        { concurrency: batch.length },
      )
      /** Report the members after `i` that were read and won't be used (§3.6). */
      const discardAfter = (i: number) =>
        Effect.forEach(
          sent.slice(i + 1),
          (outcome, j) =>
            Result.isFailure(outcome)
              ? Effect.void
              : notify(outcome.success.state, {
                  kind: "read",
                  request: requests + i + j + 2,
                  limit: outcome.success.limitSent,
                  ...outcome.success.counts,
                  accepted: 0,
                  discarded: true,
                }),
          { discard: true },
        )
      let next: Step = step
      let continued = false
      for (let i = 0; i < batch.length; i++) {
        const member = batch[i]!
        const outcome = sent[i]!
        if (Result.isFailure(outcome)) {
          yield* discardAfter(i)
          // A member after a usable prefix was throttled: hand back the prefix,
          // the cursor naming that member as not started — the next call
          // retries it and surfaces the error if it persists (§9.5). Anything
          // else, or the first member, fails the call.
          if (i > 0 && isThrottled(outcome.failure)) {
            return { items, cursor: plannedCursor(planner, member) }
          }
          return yield* Effect.fail(outcome.failure)
        }
        const response = outcome.success
        // Never examined with nothing left: the loop returns as soon as the
        // limit is reached, discarding later members' results.
        const remaining = limitValue === undefined ? undefined : limitValue - items.length
        const page = yield* examinePage<A>(
          client,
          tableName,
          response.state,
          response.returned,
          remaining,
          response.borrowedFields,
        )
        items.push(...page.items)
        est = observeEstimator(est, {
          scanned: response.counts.scannedCount,
          accepted: page.accepted,
          limitSent: response.limitSent,
        })
        yield* notify(response.state, {
          kind: "read",
          request: requests + i + 1,
          limit: response.limitSent,
          ...response.counts,
          accepted: page.accepted,
        })
        const lek = response.lastEvaluatedKey
        if (filled()) {
          yield* discardAfter(i)
          // Stopped inside the page: resume after the last row handed back
          // (#122), inside this member's range.
          if (page.stoppedAt >= 0 && page.stoppedAt < response.returned.length - 1) {
            const key =
              keyOfItem(response.returned[page.stoppedAt]!, resumeKeyNames(state, lek)) ?? lek
            return {
              items,
              cursor: plannedCursor(
                planner,
                key === undefined ? planner.afterRead(member, undefined) : readFrom(member, key),
              ),
            }
          }
          // The member's own next step — pure: a pending probe is not sent.
          return { items, cursor: plannedCursor(planner, planner.afterRead(member, lek)) }
        }
        next = planner.afterRead(member, lek)
        // A later member started fresh, so it can't be resumed past this one.
        if (lek !== undefined) {
          yield* discardAfter(i)
          continued = true
          break
        }
      }
      requests += batch.length
      window = continued ? 1 : Math.min(window * 2, cap)
      step = next
      // Without a limit, a page is one window, as one read is without a plan.
      if (limitValue === undefined) return { items, cursor: plannedCursor(planner, step) }
    }
  })

/**
 * Execute the query and return a Stream of page arrays.
 * A page is one DynamoDB request (of {@link pageSize} rows, when set, or as
 * {@link limit} sizes it under a filter); the stream ends once {@link limit}
 * items have been emitted in total, the key range is exhausted, or
 * {@link maxPages} requests have been made.
 */
export const paginate = <A>(
  self: Query<A>,
): Effect.Effect<
  Stream.Stream<Array<A>, DynamoClientError | ValidationError>,
  never,
  DynamoClient
> =>
  Effect.flatMap(paginateInternal(self), (stream) =>
    Capacity.operationStream("Query.paginate", operationOptions(self), stream, "delegate"),
  )

const paginateInternal = <A>(
  self: Query<A>,
): Effect.Effect<
  Stream.Stream<Array<A>, DynamoClientError | ValidationError>,
  never,
  DynamoClient
> =>
  Effect.gen(function* () {
    const client = yield* Capacity.client
    const tableName = self._state.resolveTableName
      ? yield* self._state.resolveTableName
      : self._state.tableName
    // Prepared when the stream runs, so a failure is the stream's.
    return Stream.unwrap(
      prepared(self._state, tableName).pipe(
        Effect.provideService(DynamoClient, client),
        Effect.map((state) => pageStream<A>(client, tableName, state)),
      ),
    )
  })

const pageStream = <A>(
  client: DynamoClientService,
  tableName: string,
  state: QueryState,
): Stream.Stream<Array<A>, DynamoClientError | ValidationError> => {
  const limitValue = state.limitValue
  if (limitValue !== undefined && limitValue <= 0) {
    return Stream.empty as Stream.Stream<Array<A>, DynamoClientError | ValidationError>
  }
  if (state.fanOutStart !== undefined) {
    return fanOutPageStream<A>(client, tableName, state, state.fanOutStart)
  }
  if (state.plan !== undefined) return plannedPageStream<A>(client, tableName, state, state.plan)

  // Cursor and sizing state travel through Stream.paginate rather than a
  // closure, so re-running the returned stream restarts from the beginning —
  // and sends the same `Limit`s.
  interface PageState {
    readonly key: Record<string, AttributeValue> | undefined
    readonly pageCount: number
    readonly emitted: number
    readonly estimator: Estimator
  }

  return Stream.paginate(
    {
      key: state.exclusiveStartKey as Record<string, AttributeValue> | undefined,
      pageCount: 0,
      emitted: 0,
      estimator: emptyEstimator,
    } as PageState,
    (pageState: PageState) =>
      Effect.gen(function* () {
        const pageCount = pageState.pageCount + 1
        const remaining = limitValue === undefined ? undefined : limitValue - pageState.emitted
        const indexState = indexQueryState(state)
        const borrowedFields = cursorProjectionFields(indexState, false)
        const limitSent = requestLimit(state, remaining, pageState.estimator, pageCount)
        const cmd = buildDynamoCommand(
          indexState,
          tableName,
          { ExclusiveStartKey: pageState.key, Limit: limitSent },
          borrowedFields,
        )
        const result = yield* send(client, state, cmd)

        const returned = (result.Items ?? []) as Array<Record<string, AttributeValue>>
        const { items: decoded, accepted } = yield* examinePage<A>(
          client,
          tableName,
          state,
          returned,
          remaining,
          borrowedFields,
        )
        const counts = responseCounts(result)
        const estimator = observeEstimator(pageState.estimator, {
          scanned: counts.scannedCount,
          accepted,
          limitSent,
        })
        yield* notify(state, {
          kind: "read",
          request: pageCount,
          limit: limitSent,
          ...counts,
          accepted,
        })

        const emitted = pageState.emitted + decoded.length
        const hasMorePages = result.LastEvaluatedKey != null
        const maxPagesReached = state.maxPagesValue != null && pageCount >= state.maxPagesValue
        const limitReached = limitValue !== undefined && emitted >= limitValue

        const nextState =
          hasMorePages && !maxPagesReached && !limitReached
            ? Option.some({
                key: result.LastEvaluatedKey as Record<string, AttributeValue>,
                pageCount,
                emitted,
                estimator,
              } as PageState)
            : Option.none()

        return [[decoded], nextState] as const
      }),
  )
}

/**
 * @internal `pageStream` for a planned query (design §9.3). The page state is
 * plain data, so the stream stays re-runnable:
 *
 * - `open` — the ranges being read, in plan order, each with its next read
 *   and at most one page read but not yet emitted. A later range's page waits
 *   until every earlier range is drained, so a stream never discards a read.
 * - `step` — the plan's next step once `open` is drained: read only while
 *   `open` is empty.
 * - `window` — how many ranges may be open: {@link planConcurrency}. Only a
 *   precise plan has ranges `following` a read; composite, naive and jump
 *   plans read one range at a time.
 *
 * Each pull opens ranges when none is open (sending the probes before the
 * next read), sends one read for every open range without a page, within
 * `maxPages`, then emits the head range's pages in order. A pull that reads
 * nothing emits nothing.
 */
const plannedPageStream = <A>(
  client: DynamoClientService,
  tableName: string,
  state: QueryState,
  plan: PreparedPlan,
): Stream.Stream<Array<A>, DynamoClientError | ValidationError> => {
  const { planner } = plan
  const limitValue = state.limitValue
  const maxPages = state.maxPagesValue
  /** A read sent and not yet emitted: its request number and its response. */
  interface PendingPage {
    readonly request: number
    readonly response: SentRead
  }
  interface OpenRange {
    readonly step: ReadStep
    readonly page: PendingPage | undefined
  }
  interface PageState {
    readonly step: Step
    readonly open: ReadonlyArray<OpenRange>
    readonly pageCount: number
    readonly emitted: number
    readonly estimator: Estimator
    readonly window: number
  }
  const initial: PageState = {
    step: plan.start,
    open: [],
    pageCount: 0,
    emitted: 0,
    estimator: emptyEstimator,
    window: planConcurrency(state),
  }
  return Stream.paginate(initial, (pageState: PageState) =>
    Effect.gen(function* () {
      let { step, open, pageCount, emitted, estimator } = pageState
      const { window } = pageState
      const budget = () => maxPages == null || pageCount < maxPages
      const nothing = [[], Option.none<PageState>()] as const

      // Open ranges: the probes up to the next read, then the read and the
      // ranges following it, up to the window.
      if (open.length === 0) {
        while (step._tag === "Probe" && budget()) {
          pageCount++
          step = planner.afterProbe(
            step,
            yield* sendProbe(client, tableName, state, step, pageCount),
          )
        }
        if (step._tag !== "Read" || !budget()) return nothing
        open = [step, ...planner.following(step, window - 1)].map((member) => ({
          step: member,
          page: undefined,
        }))
      }

      // One read for every open range without a page, in plan order.
      const unread = open.flatMap((range, i) => (range.page === undefined ? [i] : []))
      const sending = maxPages == null ? unread : unread.slice(0, maxPages - pageCount)
      const remainingAtSend = limitValue === undefined ? undefined : limitValue - emitted
      // Reads sent before this pull and not yet emitted (#133 numbers reads).
      const pending = open.length - unread.length
      const responses = yield* Effect.forEach(
        sending,
        (i, n) =>
          sendRead(
            client,
            tableName,
            state,
            open[i]!.step,
            remainingAtSend,
            estimator,
            estimator.requests + pending + n + 1,
            false,
          ),
        { concurrency: Math.max(sending.length, 1) },
      )
      const sentAt = pageCount
      open = open.map((range, i) => {
        const n = sending.indexOf(i)
        return n < 0
          ? range
          : { ...range, page: { request: sentAt + n + 1, response: responses[n]! } }
      })
      pageCount += sending.length

      // Emit the head range's pages, in plan order, until one needs a read.
      const pages: Array<Array<A>> = []
      const filled = () => limitValue !== undefined && emitted >= limitValue
      while (open.length > 0 && open[0]!.page !== undefined && !filled()) {
        const [head, ...rest] = open as [OpenRange, ...Array<OpenRange>]
        const { request, response } = head.page!
        const remaining = limitValue === undefined ? undefined : limitValue - emitted
        const page = yield* examinePage<A>(
          client,
          tableName,
          response.state,
          response.returned,
          remaining,
          response.borrowedFields,
        )
        estimator = observeEstimator(estimator, {
          scanned: response.counts.scannedCount,
          accepted: page.accepted,
          limitSent: response.limitSent,
        })
        yield* notify(response.state, {
          kind: "read",
          request,
          limit: response.limitSent,
          ...response.counts,
          accepted: page.accepted,
        })
        pages.push(page.items)
        emitted += page.items.length
        const lek = response.lastEvaluatedKey
        const next = planner.afterRead(head.step, lek)
        if (lek !== undefined && next._tag === "Read") {
          open = [{ step: next, page: undefined }, ...rest]
        } else {
          open = rest
          if (rest.length === 0) step = next
        }
      }
      // Keep the window full: the ranges after the last open one. (When it
      // finishes, its own next step is the first range not yet opened.)
      const last = open[open.length - 1]
      if (last !== undefined && open.length < window && !filled()) {
        open = [
          ...open,
          ...planner.following(last.step, window - open.length).map((member) => ({
            step: member,
            page: undefined,
          })),
        ]
      }

      const more = !filled() && budget() && (open.length > 0 || step._tag !== "Done")
      if (!more) {
        // The stream ends with pages read ahead and not emitted: report them (§3.6).
        const unused = open
          .flatMap((range) => (range.page === undefined ? [] : [range.page]))
          .sort((a, b) => a.request - b.request)
        yield* Effect.forEach(
          unused,
          ({ request, response }) =>
            notify(response.state, {
              kind: "read",
              request,
              limit: response.limitSent,
              ...response.counts,
              accepted: 0,
              discarded: true,
            }),
          { discard: true },
        )
      }
      return [
        pages,
        more
          ? Option.some<PageState>({ step, open, pageCount, emitted, estimator, window })
          : Option.none<PageState>(),
      ] as const
    }),
  )
}

/**
 * Execute a count query. Uses `Select: "COUNT"` on DynamoDB — no items are returned.
 * Returns the total count across all requests (respects {@link maxPages}).
 *
 * {@link limit} caps the count, keeping `count()` equal to `collect().length`
 * for the same query: `.limit(n).count()` returns `min(matching, n)` and stops
 * counting once `n` is reached — which makes `.limit(1).count()` a cheap
 * existence check. Under a filter, each request of a limited count is sized
 * from the pass rate the earlier ones showed, as {@link limit} describes.
 * {@link pageSize} sets the rows examined per request instead.
 */
export const count = <A>(
  self: Query<A>,
): Effect.Effect<number, DynamoClientError | ValidationError, DynamoClient> =>
  Capacity.delegate("Query.count", operationOptions(self), countCore(self))

const countCore = <A>(
  self: Query<A>,
): Effect.Effect<number, DynamoClientError | ValidationError, DynamoClient> =>
  Effect.gen(function* () {
    const client = yield* Capacity.client
    const tableName = self._state.resolveTableName
      ? yield* self._state.resolveTableName
      : self._state.tableName
    // A hydrated query counts index rows: nothing is fetched (and a `select`
    // projection, which hydration would send on the fetch, is not sent).
    const state = indexQueryState(yield* prepared(self._state, tableName))
    const limitValue = state.limitValue

    if (limitValue !== undefined && limitValue <= 0) return 0

    // A client-side predicate runs on the DECODED item, and `Select: "COUNT"`
    // returns no items to decode — so counting server-side would report every
    // row the key condition and FilterExpression matched, silently ignoring the
    // predicate. Count the accepted items instead. This reads the rows rather
    // than counting them in DynamoDB, which costs more; it is the price of a
    // predicate the database cannot evaluate, and the alternative is a wrong
    // number (#122).
    if (state.predicates.length > 0) {
      const items = yield* collect(self)
      return items.length
    }

    if (state.fanOutStart !== undefined) {
      return yield* countFanOut(client, tableName, state, state.fanOutStart)
    }

    if (state.plan !== undefined) return yield* countPlanned(client, tableName, state, state.plan)

    // Rows that may be history are judged by a few attributes, so only those
    // are read — never whole items (#133).
    if (dropsRows(state)) {
      const judging: QueryState = {
        ...state,
        projection: judgedAttributes(state),
        projectionPaths: undefined,
      }
      let counted = 0
      let pages = 0
      let start: Record<string, AttributeValue> | undefined
      let est = emptyEstimator
      do {
        pages++
        const remaining = limitValue === undefined ? undefined : limitValue - counted
        const limitSent = requestLimit(state, remaining, est, pages)
        const cmd = buildDynamoCommand(judging, tableName, {
          ExclusiveStartKey: start,
          Limit: limitSent,
        })
        const result = yield* send(client, state, cmd)
        const rows = (result.Items ?? []) as Array<Record<string, AttributeValue>>
        const accepted = rows.filter((row) => !isExcludedRow(state, row)).length
        counted += accepted
        const counts = responseCounts(result)
        est = observeEstimator(est, { scanned: counts.scannedCount, accepted, limitSent })
        yield* notify(state, {
          kind: "count",
          request: pages,
          limit: limitSent,
          ...counts,
          accepted,
        })
        start = result.LastEvaluatedKey as Record<string, AttributeValue> | undefined
        if (limitValue !== undefined && counted >= limitValue) return limitValue
        if (state.maxPagesValue != null && pages >= state.maxPagesValue) break
      } while (start != null)
      return counted
    }

    let total = 0
    let pageCount = 0
    let exclusiveStartKey: Record<string, AttributeValue> | undefined
    let est = emptyEstimator

    do {
      pageCount++
      const remaining = limitValue === undefined ? undefined : limitValue - total
      // Under a filter and a `limit`, sized from the pass rate `Count` shows.
      const limitSent = requestLimit(state, remaining, est, pageCount)
      const cmd = buildDynamoCommand(state, tableName, {
        ExclusiveStartKey: exclusiveStartKey,
        Select: "COUNT",
        Limit: limitSent,
      })
      const result = yield* send(client, state, cmd)

      const matched = result.Count ?? 0
      total += matched
      const scanned = result.ScannedCount ?? matched
      est = observeEstimator(est, { scanned, accepted: matched, limitSent })
      yield* notify(state, {
        kind: "count",
        request: pageCount,
        limit: limitSent,
        scannedCount: scanned,
        count: matched,
        accepted: matched,
      })
      exclusiveStartKey = result.LastEvaluatedKey as Record<string, AttributeValue> | undefined

      if (limitValue !== undefined && total >= limitValue) return limitValue
      if (state.maxPagesValue != null && pageCount >= state.maxPagesValue) break
    } while (exclusiveStartKey != null)

    return total
  })

/**
 * @internal `count` for a planned query (design §9.4): `Select: "COUNT"` per
 * read, probes through the same loop. A read whose rows a check judges (a row
 * check, history rows) reads only the attributes the check needs and counts
 * the rows it accepts. A jump read is sized from its in-box run, as `execute`
 * sizes it; without that, each `COUNT` would evaluate up to 1 MB into a gap.
 * A precise plan's ranges are counted independently, up to
 * {@link planConcurrency} at once, unless `maxPages` must cap them in order.
 */
const countPlanned = (
  client: DynamoClientService,
  tableName: string,
  state: QueryState,
  plan: PreparedPlan,
): Effect.Effect<number, DynamoClientError | ValidationError> =>
  Effect.gen(function* () {
    const { planner } = plan
    const limitValue = state.limitValue
    let total = 0
    let requests = 0
    const reached = () => limitValue !== undefined && total >= limitValue

    /** Count one read; its `LastEvaluatedKey`. */
    const countRead = (step: ReadStep, est: Estimator, request: number) =>
      Effect.gen(function* () {
        const sentState = readState(state, step)
        const remaining = limitValue === undefined ? undefined : limitValue - total
        const limitSent = readLimit(sentState, step, remaining, est, est.requests + 1)
        const judging = dropsRows(sentState)
        const cmd = judging
          ? buildDynamoCommand(
              { ...sentState, projection: judgedAttributes(sentState), projectionPaths: undefined },
              tableName,
              { ExclusiveStartKey: step.startKey, Limit: limitSent },
            )
          : buildDynamoCommand(sentState, tableName, {
              ExclusiveStartKey: step.startKey,
              Select: "COUNT",
              Limit: limitSent,
            })
        const result = yield* send(client, sentState, cmd)
        const counts = responseCounts(result)
        const matched = judging
          ? ((result.Items ?? []) as Array<Record<string, AttributeValue>>).filter(
              (row) => !isExcludedRow(sentState, row),
            ).length
          : (result.Count ?? 0)
        const scanned = judging ? counts.scannedCount : (result.ScannedCount ?? matched)
        total += matched
        yield* notify(sentState, {
          kind: "count",
          request,
          limit: limitSent,
          scannedCount: scanned,
          count: judging ? counts.count : matched,
          accepted: matched,
        })
        return {
          lastEvaluatedKey: result.LastEvaluatedKey as Record<string, AttributeValue> | undefined,
          est: observeEstimator(est, { scanned, accepted: matched, limitSent }),
        }
      })

    const start = plan.start
    if (
      state.maxPagesValue == null &&
      start._tag === "Read" &&
      start.at.mode === "precise" &&
      start.planIndex !== undefined
    ) {
      const ranges = [start, ...planner.following(start, Number.POSITIVE_INFINITY)]
      yield* Effect.forEach(
        ranges,
        (first) =>
          Effect.gen(function* () {
            let step: ReadStep = first
            let est = emptyEstimator
            while (!reached()) {
              const counted = yield* countRead(step, est, ++requests)
              if (counted.lastEvaluatedKey === undefined) return
              est = counted.est
              step = readFrom(step, counted.lastEvaluatedKey)
            }
          }),
        { concurrency: planConcurrency(state), discard: true },
      )
      return reached() ? limitValue! : total
    }

    let step = start
    let est = emptyEstimator
    while (step._tag !== "Done") {
      if (state.maxPagesValue != null && requests >= state.maxPagesValue) break
      requests++
      if (step._tag === "Probe") {
        step = planner.afterProbe(step, yield* sendProbe(client, tableName, state, step, requests))
        continue
      }
      const counted = yield* countRead(step, est, requests)
      est = counted.est
      if (reached()) return limitValue!
      step = planner.afterRead(step, counted.lastEvaluatedKey)
    }
    return total
  })

/**
 * Describe what a terminal would send — the plan, why it was chosen, the key
 * ranges known up front, the bounds checked per row and how requests are
 * sized — without sending anything (#171). Cursors are not read: the plan is
 * described from its start.
 */
export const explain = <A>(self: Query<A>): Effect.Effect<QueryExplain, never, never> =>
  Effect.sync(() => {
    const state = self._state
    if (state.refusal !== undefined) {
      return {
        index: state.indexName ?? "primary",
        plan: "empty",
        reason: `refused: ${state.refusal.message}`,
        keyConditions: [],
        filter: undefined,
        rowChecks: [],
        sizing: explainedSizing(state),
      } satisfies QueryExplain
    }
    if (state.fanOut !== undefined) return explainFanOut(state, state.fanOut)
    const factory = state.planner
    if (factory === undefined) {
      const [lower, upper] = displayKeyCondition(state.skConditions[0]?.condition)
      return {
        index: state.indexName ?? "primary",
        plan: "key",
        reason: state.isScan ? "scan: no key condition" : "one key condition",
        keyConditions: state.isScan ? [] : [{ lower, upper, exact: true }],
        filter: undefined,
        rowChecks: [],
        sizing: explainedSizing(state),
      } satisfies QueryExplain
    }
    const planner = resolvePlanner(state, factory)
    const start = planner.start(undefined)
    const planned: QueryState = {
      ...state,
      plan: start instanceof ValidationError ? undefined : { planner, start },
      rowCheck: planner.rowCheck,
    }
    return planner.explain(explainedSizing(planned))
  })

/** @internal How `explain` names a query's sizing: no `limit` reads natural pages. */
const explainedSizing = (state: QueryState): QueryExplain["sizing"] => {
  const mode = sizingMode(state)
  return mode === "none" ? "natural" : mode
}

/**
 * Return the built DynamoDB command input without executing.
 * Useful for debugging, logging, or passing to DynamoClient directly.
 * Fails with a `ValidationError` for a filter the query would refuse to send
 * (an empty part under `or` / `not`, an `or()` with no parts).
 */
export const asParams = <A>(
  self: Query<A>,
): Effect.Effect<Record<string, unknown>, ValidationError, any> =>
  Effect.gen(function* () {
    const state = self._state
    const refusal = state.refusal ?? refuseEmptyFilterParts(state)
    if (refusal !== undefined) return yield* refusal
    const tableName = state.resolveTableName ? yield* state.resolveTableName : state.tableName
    // A planned query shows the first request it would send from the start:
    // its first probe, or its first read (#171).
    if (state.planner !== undefined) {
      const planner = resolvePlanner(state, state.planner)
      const start = planner.start(undefined)
      if (!(start instanceof ValidationError) && start._tag !== "Done") {
        const planned: QueryState = { ...state, plan: { planner, start } }
        return start._tag === "Probe"
          ? probeCommand(planned, start, tableName)
          : buildDynamoCommand(indexQueryState(readState(planned, start)), tableName)
      }
    }
    // A `BatchGet`-hydrated query shows its index query; the `BatchGetItem`
    // that follows each page is not part of these parameters.
    return buildDynamoCommand(indexQueryState(state), tableName)
  })

// ---------------------------------------------------------------------------
// Sharded indexes (#183, docs/designs/gsi-write-sharding.md §6)
// ---------------------------------------------------------------------------

/** @internal The partitions a fan-out reads, in merge order: its layouts'. */
const fanOutPartitions = (state: QueryState, spec: FanOutSpec): ReadonlyArray<FanOutPartition> => {
  const condition = state.skConditions[0]?.condition
  return spec.partitions.map((pkValue) => ({ pkValue, condition }))
}

/** @internal What a sharded query's cursor must have come from. */
const fanOutFingerprint = (
  state: QueryState,
  spec: FanOutSpec,
  partitions: ReadonlyArray<FanOutPartition>,
): string =>
  fnv1a32(
    canonicalJson({
      index: state.indexName,
      entityTypes: state.entityTypes,
      count: spec.count,
      source: spec.source,
      previous: spec.previous,
      partitions: partitions.map(({ pkValue, condition }) => ({ pkValue, condition })),
      reverse: !state.scanForward,
    }),
  )

/** @internal The checksum of a cursor's positions. */
const positionsChecksum = (positions: ReadonlyArray<Cursor.ShardPosition>): string =>
  fnv1a32(canonicalJson(positions))

/**
 * @internal A fan-out's partitions, resumed from its {@link startFrom} cursor: a
 * cursor from another layout or query, a position it can't hold or an altered one
 * is `[EDD-9094]`.
 */
const resumeFanOut = (state: QueryState, spec: FanOutSpec): QueryState | ValidationError => {
  const partitions = fanOutPartitions(state, spec)
  const fingerprint = fanOutFingerprint(state, spec, partitions)
  const started = (merge: ShardMerge.MergeState): QueryState => ({
    ...state,
    fanOutStart: { partitions, fingerprint, merge },
  })
  if (state.cursorText === undefined) return started(ShardMerge.fromStart(partitions.length))
  const entityType = state.entityTypes.join(", ") || "unknown"
  const refuse = (why: string) => cursorRefusal(entityType, why)
  const cursor = Cursor.decode(state.cursorText)
  if (cursor === undefined) return refuse("it is not a cursor a query returned")
  if (cursor.z === undefined) {
    return refuse("this index is sharded, and it comes from a query that wasn't")
  }
  if (cursor.f !== fingerprint) {
    return refuse("its shard layout or its query differs from this one's")
  }
  if (cursor.c !== positionsChecksum(cursor.z)) return refuse("its positions were altered")
  if (cursor.z.length !== partitions.length) {
    return refuse("it doesn't hold one position per partition")
  }
  const keyNames = new Set((state.keyFields ?? []).filter((name) => name !== state.pkField))
  const boundaries: Array<ShardMerge.Boundary> = []
  for (let i = 0; i < partitions.length; i++) {
    const at = cursor.z[i]!
    if (at === 0) {
      boundaries.push({ _tag: "Start" })
      continue
    }
    if (at === 1) {
      boundaries.push({ _tag: "Done" })
      continue
    }
    const names = Object.keys(at)
    if (names.length !== keyNames.size || !names.every((name) => keyNames.has(name))) {
      return refuse("a position isn't a key of this index")
    }
    const partition = partitions[i]!
    const sort = state.skField === undefined ? undefined : at[state.skField]
    const value = sort === undefined ? undefined : Cursor.wireToKeyValue(sort)
    if (
      partition.condition !== undefined &&
      (value === undefined || !keyConditionHolds(partition.condition, value))
    ) {
      return refuse("a position is outside the query's key condition")
    }
    boundaries.push({
      _tag: "At",
      key: Cursor.keyFromWire({ ...at, [state.pkField]: { S: partition.pkValue } }),
    })
  }
  return started(ShardMerge.initial(boundaries))
}

/** @internal A boundary as a cursor records it. */
const positionOf = (
  state: QueryState,
  boundary: ShardMerge.Boundary,
): Effect.Effect<Cursor.ShardPosition> => {
  if (boundary._tag === "Start") return Effect.succeed(0)
  if (boundary._tag === "Done") return Effect.succeed(1)
  const key = boundary._tag === "At" ? boundary.key : keyOfItem(boundary.row, state.keyFields)
  const wire = key === undefined ? undefined : Cursor.keyToWire(key)
  if (wire === undefined) {
    return Effect.die(
      new Error(
        `[internal] A row read from sharded index "${state.indexName}" lacks a key attribute ` +
          `of ${JSON.stringify(state.keyFields)}, which the cursor resumes after.`,
      ),
    )
  }
  const { [state.pkField]: _partition, ...position } = wire
  return Effect.succeed(position)
}

/** @internal The cursor of a fan-out at `merge`: v2, or `None` once every partition is done. */
const fanOutCursor = (
  state: QueryState,
  start: FanOutStart,
  merge: ShardMerge.MergeState,
): Effect.Effect<Option.Option<string>> =>
  ShardMerge.isFinished(merge)
    ? Effect.succeed(Option.none())
    : Effect.map(
        Effect.forEach(merge, (partition) => positionOf(state, partition.boundary)),
        (z) =>
          Option.some(
            Cursor.encodeV2({
              v: 2,
              f: start.fingerprint,
              s: "key",
              z,
              c: positionsChecksum(z),
            }),
          ),
      )

/** @internal One partition's request, as `state` sends it. */
const partitionState = (state: QueryState, partition: FanOutPartition): QueryState => ({
  ...state,
  pkValue: partition.pkValue,
  skConditions:
    partition.condition === undefined || state.skField === undefined
      ? []
      : [{ field: state.skField, condition: partition.condition }],
  rowCheck: undefined,
})

/** @internal The `ExclusiveStartKey` a boundary resumes from. */
const fanOutStartKey = (
  state: QueryState,
  boundary: ShardMerge.Boundary,
): Record<string, AttributeValue> | undefined =>
  boundary._tag === "At"
    ? boundary.key
    : boundary._tag === "After"
      ? keyOfItem(boundary.row, state.keyFields)
      : undefined

/**
 * @internal The `Limit` of a partition's next request (design §6.5), `remaining`
 * items still owed and `active` partitions unfinished: the partition's share of
 * what is owed, growing where it keeps running dry.
 */
const fanOutLimit = (
  sent: QueryState,
  remaining: number | undefined,
  active: number,
  est: Estimator,
): number | undefined => {
  const mode = sizingMode(sent)
  if (remaining === undefined || mode === "none") return legacyRequestLimit(sent, remaining)
  const share = Math.ceil(remaining / Math.max(active, 1))
  if (mode === "adaptive") return nextLimit(est, share, filtered(sent))
  if (mode === "budget") {
    return Math.min(remaining, Math.max(Math.ceil(share * SAFETY), est.lastLimit * GROWTH))
  }
  return legacyRequestLimit(sent, remaining, est.requests + 1)
}

/** @internal A page read and not yet reported: its rows may be consumed over several rounds. */
interface FanOutPage {
  readonly sent: QueryState
  readonly request: number
  readonly limitSent: number | undefined
  readonly counts: { readonly scannedCount: number; readonly count: number }
  readonly accepted: number
}

/**
 * @internal A fan-out in progress. Plain data, so a stream restarts from the
 * beginning when re-run, and the estimators stay out of the cursor.
 */
interface FanOutRun {
  readonly merge: ShardMerge.MergeState
  readonly estimators: ReadonlyArray<Estimator>
  readonly pages: ReadonlyArray<FanOutPage | undefined>
  readonly requests: number
  readonly rounds: number
  readonly emitted: number
}

const startFanOut = (start: FanOutStart): FanOutRun => ({
  merge: start.merge,
  estimators: start.partitions.map(() => emptyEstimator),
  pages: start.partitions.map(() => undefined),
  requests: 0,
  rounds: 0,
  emitted: 0,
})

/** @internal How many requests a fan-out's round sends at once. */
const fanOutConcurrency = (state: QueryState, partitions: number): number =>
  state.concurrencyValue ?? Math.max(partitions, 1)

/** @internal Are `maxPages` rounds used up? */
const roundsUsed = (state: QueryState, run: FanOutRun): boolean =>
  state.maxPagesValue != null && run.rounds >= state.maxPagesValue

/**
 * @internal One round of a fan-out: read every partition with nothing buffered
 * and more to read (at most one page each), unless `read` is false, then emit
 * what is proven in order, up to the `limit`. Any request's failure fails the
 * round, with the others interrupted. A page is reported to the observers when
 * its rows are consumed, so `accepted` is exact.
 */
const fanOutRound = <A>(
  client: DynamoClientService,
  tableName: string,
  state: QueryState,
  start: FanOutStart,
  run: FanOutRun,
): Effect.Effect<
  { readonly run: FanOutRun; readonly items: Array<A> },
  DynamoClientError | ValidationError
> =>
  Effect.gen(function* () {
    const limitValue = state.limitValue
    const remainingBefore = limitValue === undefined ? undefined : limitValue - run.emitted
    const needing = ShardMerge.needingRead(run.merge)
    const active = ShardMerge.unfinished(run.merge)
    let merge = run.merge
    const estimators = [...run.estimators]
    const pages = [...run.pages]
    // The same attributes for every partition: a row check on one borrows what it
    // judges, and `examinePage` strips the lot.
    const borrowed = [
      ...new Set(
        start.partitions.flatMap((partition) =>
          cursorProjectionFields(indexQueryState(partitionState(state, partition)), true),
        ),
      ),
    ]

    const report = (i: number): Effect.Effect<void> => {
      const page = pages[i]
      if (page === undefined) return Effect.void
      pages[i] = undefined
      estimators[i] = observeEstimator(estimators[i]!, {
        scanned: page.counts.scannedCount,
        accepted: page.accepted,
        limitSent: page.limitSent,
      })
      return notify(page.sent, {
        kind: "read",
        request: page.request,
        limit: page.limitSent,
        ...page.counts,
        accepted: page.accepted,
      })
    }

    const responses = yield* Effect.forEach(
      needing,
      (i, n) =>
        Effect.gen(function* () {
          const sent = partitionState(state, start.partitions[i]!)
          const limitSent = fanOutLimit(sent, remainingBefore, active, estimators[i]!)
          const cmd = buildDynamoCommand(
            indexQueryState(sent),
            tableName,
            { ExclusiveStartKey: fanOutStartKey(state, run.merge[i]!.boundary), Limit: limitSent },
            borrowed,
          )
          const result = yield* send(client, sent, cmd)
          return {
            i,
            request: run.requests + n + 1,
            sent,
            limitSent,
            result,
          }
        }),
      { concurrency: fanOutConcurrency(state, needing.length) },
    )
    for (const { i, request, sent, limitSent, result } of responses) {
      const returned = (result.Items ?? []) as Array<ShardMerge.Row>
      const kept = returned.filter((row) => !isExcludedRow(sent, row))
      merge = ShardMerge.absorb(
        merge,
        i,
        kept,
        result.LastEvaluatedKey as ShardMerge.Row | undefined,
      )
      pages[i] = { sent, request, limitSent, counts: responseCounts(result), accepted: 0 }
      // Nothing left in the page: nothing will ever be consumed from it.
      if (kept.length === 0) yield* report(i)
    }

    const budget = limitValue === undefined ? Number.POSITIVE_INFINITY : limitValue - run.emitted
    const selection = yield* Effect.try({
      try: () =>
        ShardMerge.select(merge, budget, {
          skField: state.skField ?? "",
          reverse: !state.scanForward,
        }),
      catch: (error) => error,
    }).pipe(Effect.orDie)
    merge = selection.state
    // Rows dropped at the read aren't examined again; the rest are decoded
    // together, which is what lets a `BatchGet`-hydrated query fetch them at once.
    const page = yield* examinePage<A>(
      client,
      tableName,
      { ...state, rowCheck: undefined, keepRow: undefined, liveRows: undefined },
      selection.taken.map((selected) => selected.row),
      undefined,
      borrowed,
    )
    for (const at of page.rows) {
      const i = selection.taken[at]!.partition
      const accepted = pages[i]
      if (accepted !== undefined) pages[i] = { ...accepted, accepted: accepted.accepted + 1 }
    }
    for (const i of selection.drained) yield* report(i)

    return {
      run: {
        merge,
        estimators,
        pages,
        requests: run.requests + needing.length,
        rounds: needing.length > 0 ? run.rounds + 1 : run.rounds,
        emitted: run.emitted + page.items.length,
      },
      items: page.items,
    }
  })

/**
 * @internal Report the pages a fan-out read and never finished consuming: a page
 * with no row consumed is `discarded`, and a later call reads what remains again.
 */
const reportUnfinished = (run: FanOutRun): Effect.Effect<void> =>
  Effect.forEach(
    run.pages.filter((page): page is FanOutPage => page !== undefined),
    (page) =>
      notify(page.sent, {
        kind: "read",
        request: page.request,
        limit: page.limitSent,
        ...page.counts,
        accepted: page.accepted,
        discarded: page.accepted === 0,
      }),
    { discard: true },
  )

/**
 * @internal `execute` for a sharded index. With a `limit`, rounds until `limit`
 * items are out, every partition is done, or `maxPages` rounds were read. Without
 * one, a page is one round, as a page without a plan is one request.
 */
const executeFanOut = <A>(
  client: DynamoClientService,
  tableName: string,
  state: QueryState,
  start: FanOutStart,
): Effect.Effect<Page<A>, DynamoClientError | ValidationError> =>
  Effect.gen(function* () {
    const limitValue = state.limitValue
    const items: Array<A> = []
    let run = startFanOut(start)
    while (!ShardMerge.isFinished(run.merge)) {
      const stepped = yield* fanOutRound<A>(client, tableName, state, start, run)
      run = stepped.run
      items.push(...stepped.items)
      if (limitValue === undefined) break
      if (run.emitted >= limitValue) break
      // A partition must be read, and the rounds are up.
      if (ShardMerge.needingRead(run.merge).length > 0 && roundsUsed(state, run)) break
    }
    yield* reportUnfinished(run)
    return {
      items,
      cursor: yield* fanOutCursor(state, start, run.merge),
    }
  })

/**
 * @internal `pageStream` for a sharded index: one array per round. At most one
 * page per partition is held. The stream ends once `limit` items are out, every
 * partition is done, or `maxPages` rounds were read.
 */
const fanOutPageStream = <A>(
  client: DynamoClientService,
  tableName: string,
  state: QueryState,
  start: FanOutStart,
): Stream.Stream<Array<A>, DynamoClientError | ValidationError> =>
  Stream.paginate(startFanOut(start), (run: FanOutRun) =>
    Effect.gen(function* () {
      if (ShardMerge.isFinished(run.merge)) return [[], Option.none<FanOutRun>()] as const
      const stepped = yield* fanOutRound<A>(client, tableName, state, start, run)
      const next = stepped.run
      const filled = state.limitValue !== undefined && next.emitted >= state.limitValue
      const stuck = ShardMerge.needingRead(next.merge).length > 0 && roundsUsed(state, next)
      const more = !filled && !stuck && !ShardMerge.isFinished(next.merge)
      if (!more) yield* reportUnfinished(next)
      return [[stepped.items], more ? Option.some(next) : Option.none<FanOutRun>()] as const
    }),
  )

/**
 * @internal `count` for a sharded index: each partition counted from where it
 * resumes, `Select: COUNT` or the rows a row check judges, summed and capped at the
 * `limit`. `maxPages` caps each partition's requests. Any failure fails the count.
 */
const countFanOut = (
  client: DynamoClientService,
  tableName: string,
  state: QueryState,
  start: FanOutStart,
): Effect.Effect<number, DynamoClientError | ValidationError> =>
  Effect.gen(function* () {
    const limitValue = state.limitValue
    let total = 0
    let requests = 0
    const reached = () => limitValue !== undefined && total >= limitValue
    const counting = start.partitions.flatMap((partition, i) =>
      start.merge[i]!.boundary._tag === "Done" ? [] : [{ partition, i }],
    )
    yield* Effect.forEach(
      counting,
      ({ partition, i }) =>
        Effect.gen(function* () {
          const sent = partitionState(state, partition)
          const judging = dropsRows(sent)
          let startKey = fanOutStartKey(state, start.merge[i]!.boundary)
          let est = emptyEstimator
          let pages = 0
          do {
            if (reached()) return
            pages++
            const remaining = limitValue === undefined ? undefined : limitValue - total
            const limitSent = fanOutLimit(sent, remaining, counting.length, est)
            const cmd = judging
              ? buildDynamoCommand(
                  { ...sent, projection: judgedAttributes(sent), projectionPaths: undefined },
                  tableName,
                  { ExclusiveStartKey: startKey, Limit: limitSent },
                )
              : buildDynamoCommand(sent, tableName, {
                  ExclusiveStartKey: startKey,
                  Select: "COUNT",
                  Limit: limitSent,
                })
            const request = ++requests
            const result = yield* send(client, sent, cmd)
            const counts = responseCounts(result)
            const matched = judging
              ? ((result.Items ?? []) as Array<ShardMerge.Row>).filter(
                  (row) => !isExcludedRow(sent, row),
                ).length
              : (result.Count ?? 0)
            const scanned = judging ? counts.scannedCount : (result.ScannedCount ?? matched)
            total += matched
            est = observeEstimator(est, { scanned, accepted: matched, limitSent })
            yield* notify(sent, {
              kind: "count",
              request,
              limit: limitSent,
              scannedCount: scanned,
              count: judging ? counts.count : matched,
              accepted: matched,
            })
            startKey = result.LastEvaluatedKey as Record<string, AttributeValue> | undefined
            if (state.maxPagesValue != null && pages >= state.maxPagesValue) return
          } while (startKey != null)
        }),
      { concurrency: fanOutConcurrency(state, counting.length), discard: true },
    )
    return limitValue !== undefined && total >= limitValue ? limitValue : total
  })

/** @internal {@link explain} of a sharded index's query: no cursor is read. */
const explainFanOut = (state: QueryState, spec: FanOutSpec): QueryExplain => {
  const partitions = fanOutPartitions(state, spec)
  return {
    index: state.indexName ?? "primary",
    plan: "key",
    reason:
      spec.pruned && partitions.length === 1
        ? "every shard source attribute pinned: one shard"
        : `one key condition on each of ${partitions.length} partitions, merged`,
    keyConditions: partitions.map(({ condition }) => {
      const [lower, upper] = displayKeyCondition(condition)
      return { lower, upper, exact: true }
    }),
    filter: undefined,
    rowChecks: [],
    sizing: explainedSizing(state),
    fanOut: {
      partitions: partitions.map(({ pkValue }) => pkValue),
      pruned: spec.pruned,
      concurrency: fanOutConcurrency(state, partitions.length),
    },
  }
}

// ---------------------------------------------------------------------------
// Type guard
// ---------------------------------------------------------------------------

export const isQuery = (u: unknown): u is Query<unknown> =>
  typeof u === "object" && u !== null && QueryTypeId in u
