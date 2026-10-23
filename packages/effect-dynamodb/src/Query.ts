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
import * as Projection from "@effect-dynamodb/schema/Projection.js"
import { Effect, Function, Option, Pipeable, Stream } from "effect"
import { DynamoClient, type DynamoClientError, type DynamoClientService } from "./DynamoClient.js"
import * as Capacity from "./internal/Capacity.js"
import { compileExpr, type Expr, ExprTag, emptyPartProblem, isEmptyExpr } from "./internal/Expr.js"
import { batchGetRaw } from "./internal/Hydrate.js"
import {
  type PackedAttributeGuard,
  packedExprRefusal,
  packedProjectionRefusal,
} from "./internal/Packed.js"
import { compilePath } from "./internal/PathBuilder.js"
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
    readonly condition: SortKeyCondition
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
  /** DynamoDB `Limit` — rows examined per request (a contract on round trips). */
  readonly pageSizeValue: number | undefined
  readonly maxPagesValue: number | undefined
  readonly scanForward: boolean
  readonly consistentRead: boolean
  readonly ignoreOwnershipFlag: boolean
  readonly exclusiveStartKey: Record<string, AttributeValue> | undefined
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
   * applied, like {@link liveRows}, to rows before they are decoded.
   * An entity's `versions` uses it to read history written by an earlier
   * release alongside its own (#133).
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
  /** See {@link QueryState.operationTarget}. */
  readonly operationTarget?: string | undefined
}): Query<A> =>
  new QueryImpl<A>({
    rawRow: config.rawRow,
    packed: config.packed ?? [],
    liveRows: config.liveRows,
    prepare: config.prepare,
    keepRow: undefined,
    hydration: config.hydration,
    keyConditionDiagnosis: config.keyConditionDiagnosis,
    operationTarget: config.operationTarget,
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
    scanForward: true,
    consistentRead: false,
    ignoreOwnershipFlag: false,
    exclusiveStartKey: undefined,
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
}): Query<A> =>
  new QueryImpl<A>({
    rawRow: config.rawRow,
    packed: config.packed ?? [],
    liveRows: config.liveRows,
    prepare: config.prepare,
    keepRow: undefined,
    hydration: undefined,
    keyConditionDiagnosis: undefined,
    operationTarget: undefined,
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
    scanForward: true,
    consistentRead: false,
    ignoreOwnershipFlag: false,
    exclusiveStartKey: undefined,
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
// Cursor encoding (internal)
// ---------------------------------------------------------------------------

const encodeCursor = (key: Record<string, AttributeValue>): string => btoa(JSON.stringify(key))

const decodeCursor = (cursor: string): Record<string, AttributeValue> => JSON.parse(atob(cursor))

// ---------------------------------------------------------------------------
// Combinators (all dual for data-first and data-last)
// ---------------------------------------------------------------------------

/**
 * Add a sort key condition to the query.
 * Only one SK condition is supported (last one wins if multiple are added).
 */
export const where: {
  (condition: SortKeyCondition): <A>(self: Query<A>) => Query<A>
  <A>(self: Query<A>, condition: SortKeyCondition): Query<A>
} = Function.dual(2, <A>(self: Query<A>, condition: SortKeyCondition): Query<A> => {
  const state = self._state
  if (!state.skField) return self
  return new QueryImpl<A>({
    ...state,
    skConditions: [{ field: state.skField, condition }],
  })
})

/**
 * Return **at most `n` items** — a contract on results, not on round trips.
 *
 * The query accumulates across as many DynamoDB requests as it takes to reach
 * `n` accepted items (or to exhaust the key range). Under a `FilterExpression`
 * DynamoDB's own `Limit` bounds rows *examined* before the filter runs, so it
 * cannot express this — {@link pageSize} is the knob that sets `Limit`, and
 * {@link maxPages} stays the hard stop on the number of requests.
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
 */
export const pageSize: {
  (n: number): <A>(self: Query<A>) => Query<A>
  <A>(self: Query<A>, n: number): Query<A>
} = Function.dual(
  2,
  <A>(self: Query<A>, n: number): Query<A> =>
    new QueryImpl<A>({
      ...self._state,
      pageSizeValue: n,
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
 * returned by {@link execute} that encodes the DynamoDB `ExclusiveStartKey`.
 * Pass an empty string to start from the beginning.
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
          exclusiveStartKey: decodeCursor(cursor),
        }),
)

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
    paths.map((path) => [resolveDbName(String(path[0])), ...path.slice(1)]),
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
} = Function.dual(2, <A>(self: Query<A>, expr: Expr): Query<A> => {
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
})

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

  // Expr-based filters (compiled from Entity.filter() callback/shorthand API).
  // Compiled as ONE expression: each compile numbers its placeholders from
  // zero, so two compiled apart both wrote `#e0` and the second overwrote the
  // first's name (#133).
  if (state.exprFilters.length > 0) {
    const compiled = compileExpr(
      state.exprFilters.length === 1
        ? state.exprFilters[0]!
        : ({ [ExprTag]: ExprTag, _tag: "and", exprs: state.exprFilters } as Expr),
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
 * `Limit` is NOT derived from state here — it is per-request (it shrinks as a
 * `limit` budget is consumed) and is always supplied through `overrides`.
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
    Limit: computeRequestLimit(state, state.limitValue),
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

/**
 * @internal DynamoDB `Limit` for the next request.
 *
 * - `pageSize` always wins as the round-trip budget when it is set.
 * - With a `limit` budget and NO user filter, every examined row is an accepted
 *   row, so the budget can be handed to DynamoDB directly (bounded by pageSize).
 *   The `__edd_e__` ownership filter is not counted here: it only ever rejects
 *   foreign items, which the accumulate loop handles by fetching another page.
 * - With a user filter, `limit` cannot be expressed as `Limit` at all (it bounds
 *   rows examined, and the filter runs after), so the request asks for
 *   `pageSize` — or, unset, a natural (1 MB) page.
 * - A client-side predicate ({@link filterBy}) rejects rows even later, after
 *   decode, so it disqualifies the budget for exactly the same reason.
 * - Rows dropped as history ({@link QueryState.liveRows}, a prepared `keep`)
 *   are not: they can't be skipped server-side, and a run of them (an item's
 *   versions, its tombstones) can far outnumber the items. The first request
 *   asks for `limit`, and each later one twice the last — so a run of `n`
 *   history rows costs about `log2(n / limit)` requests, not `n / limit` — and
 *   the surplus past `limit` is discarded, the cursor rebuilt from the last
 *   item returned (#133). `pageSize`, when set, is used as is.
 *
 * `page` is the request's 1-based number within the terminal.
 */
const computeRequestLimit = (
  state: QueryState,
  remaining: number | undefined,
  page = 1,
): number | undefined => {
  const pageSize = state.pageSizeValue
  if (remaining === undefined) return pageSize
  if (state.exprFilters.length > 0 || state.predicates.length > 0) return pageSize
  if (dropsRows(state)) {
    if (pageSize !== undefined) return pageSize
    const limit = state.limitValue ?? remaining
    return Math.min(limit * 2 ** (page - 1), MAX_GROWN_LIMIT)
  }
  return pageSize === undefined ? remaining : Math.min(pageSize, remaining)
}

/**
 * @internal Whether the query drops rows client-side (#133): like a predicate,
 * it rejects rows after they are read, so the `limit` budget cannot be handed
 * to DynamoDB, and a count has to read the rows.
 */
const dropsRows = (state: QueryState): boolean =>
  state.keepRow !== undefined || state.liveRows !== undefined

/** @internal Is this raw row one the query leaves out (#133)? */
const isExcludedRow = (state: QueryState, row: Record<string, AttributeValue>): boolean =>
  (state.keepRow !== undefined && !state.keepRow(row)) ||
  (state.liveRows !== undefined && !state.liveRows.isLive(row))

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
 * against the resolved table.
 */
const prepared = (
  state: QueryState,
  tableName: string,
): Effect.Effect<QueryState, DynamoClientError | ValidationError, DynamoClient> => {
  // A consistent read of a GSI — which DynamoDB only reads eventually
  // consistently — is DynamoDB's to reject: diagnosed by `send` (#144).
  // A filter with an empty part where none may be is refused before
  // anything is sent (#133).
  const filterRefusal = refuseEmptyFilterParts(state)
  if (filterRefusal !== undefined) return Effect.fail(filterRefusal)
  return state.prepare === undefined
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
  if (!names || names.length === 0) return undefined
  const key: Record<string, AttributeValue> = {}
  for (const name of names) {
    const value = item[name]
    if (value === undefined) return undefined
    key[name] = value
  }
  return encodeCursor(key)
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
  const borrowed = new Set<string>(
    !forCursor || state.limitValue === undefined || !state.keyFields ? [] : state.keyFields,
  )
  // A query that drops rows reads what it judges them by (#133).
  if (state.keepRow !== undefined && state.skField !== undefined) borrowed.add(state.skField)
  for (const attr of state.liveRows?.reads ?? []) borrowed.add(attr)
  // …and a raw-row hook reads what it dispatches on (a collection's `__edd_e__`).
  for (const attr of rawRowReads(state)) borrowed.add(attr)
  return [...borrowed].filter((field) => !projected.has(field))
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
 */
const examinePage = <A>(
  client: DynamoClientService,
  tableName: string,
  state: QueryState,
  returned: ReadonlyArray<Record<string, AttributeValue>>,
  budget: number | undefined,
  borrowedFields: ReadonlyArray<string>,
): Effect.Effect<
  { readonly items: Array<A>; readonly stoppedAt: number },
  DynamoClientError | ValidationError
> =>
  Effect.gen(function* () {
    const hasPredicate = state.predicates.length > 0 || dropsRows(state)
    // Borrowed attributes the raw-row hook reads are stripped after it ran:
    // borrowed into the request's projection, or — on a `BatchGet`-hydrated
    // query — into the hydrating fetch's (see `hydrateRows`).
    const hookReads = new Set(rawRowReads(state))
    const strippedAfterHook = new Set(borrowedFields.filter((field) => hookReads.has(field)))
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
        for (const field of borrowedFields) if (!hookReads.has(field)) delete raw[field]
        const item = yield* state.decoder(raw) as Effect.Effect<A, ValidationError>
        for (const field of strippedAfterHook) delete raw[field]
        if (hasPredicate && !accepts(state, item)) continue
        items.push(item)
        if (budget !== undefined && items.length >= budget) {
          return { items, stoppedAt: positions[k]! }
        }
      }
      next = end
    }
    return { items, stoppedAt: -1 }
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
  /** Opaque cursor for the next page, or `null` if there are no more results. */
  readonly cursor: string | null
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
      const stream = yield* paginateInternal(self)
      const pages = yield* Stream.runCollect(stream)
      return pages.flat()
    }),
  )

/**
 * Execute one page and return a {@link Page} with an opaque cursor.
 *
 * Without {@link limit}, a page is one DynamoDB request (of {@link pageSize}
 * rows, when set). With `limit(n)`, a page is `n` items: the request loop
 * accumulates until `n` items are accepted, the key range is exhausted, or
 * {@link maxPages} requests have been made.
 *
 * The cursor resumes after the last item actually returned — a `null` cursor
 * means genuinely exhausted. Combine with {@link startFrom} to iterate:
 *
 * ```ts
 * const first = yield* query.pipe(Query.limit(25), Query.execute)
 * if (first.cursor) {
 *   const second = yield* query.pipe(Query.limit(25), Query.startFrom(first.cursor), Query.execute)
 * }
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
      return { items: [], cursor: null } as Page<A>
    }

    // Key attributes borrowed into an active projection so an over-reading
    // request can still rebuild a cursor. Stripped again before decoding.
    const borrowedFields = cursorProjectionFields(indexState, true)

    const items: Array<A> = []
    let startKey = state.exclusiveStartKey
    let pageCount = 0
    let cursor: string | null = null

    while (true) {
      pageCount++
      const remaining = limitValue === undefined ? undefined : limitValue - items.length
      const cmd = buildDynamoCommand(
        indexState,
        tableName,
        { ExclusiveStartKey: startKey, Limit: computeRequestLimit(state, remaining, pageCount) },
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

    return { items, cursor } as Page<A>
  })

/**
 * Execute the query and return a Stream of page arrays.
 * A page is one DynamoDB request (of {@link pageSize} rows, when set); the
 * stream ends once {@link limit} items have been emitted in total, the key
 * range is exhausted, or {@link maxPages} requests have been made.
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

  // Cursor state travels through Stream.paginate rather than a closure, so
  // re-running the returned stream restarts from the beginning.
  interface PageState {
    readonly key: Record<string, AttributeValue> | undefined
    readonly pageCount: number
    readonly emitted: number
  }

  return Stream.paginate(
    {
      key: state.exclusiveStartKey as Record<string, AttributeValue> | undefined,
      pageCount: 0,
      emitted: 0,
    } as PageState,
    (pageState: PageState) =>
      Effect.gen(function* () {
        const pageCount = pageState.pageCount + 1
        const remaining = limitValue === undefined ? undefined : limitValue - pageState.emitted
        const indexState = indexQueryState(state)
        const borrowedFields = cursorProjectionFields(indexState, false)
        const cmd = buildDynamoCommand(
          indexState,
          tableName,
          {
            ExclusiveStartKey: pageState.key,
            Limit: computeRequestLimit(state, remaining, pageCount),
          },
          borrowedFields,
        )
        const result = yield* send(client, state, cmd)

        const returned = (result.Items ?? []) as Array<Record<string, AttributeValue>>
        const { items: decoded } = yield* examinePage<A>(
          client,
          tableName,
          state,
          returned,
          remaining,
          borrowedFields,
        )

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
              } as PageState)
            : Option.none()

        return [[decoded], nextState] as const
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
 * existence check. {@link pageSize} sets the rows examined per request.
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

    // Rows that may be history are judged by a few attributes, so only those
    // are read — never whole items (#133).
    if (dropsRows(state)) {
      const judged = [
        ...new Set([
          ...(state.liveRows?.reads ?? []),
          ...(state.keepRow !== undefined && state.skField !== undefined ? [state.skField] : []),
        ]),
      ]
      const judging: QueryState = { ...state, projection: judged, projectionPaths: undefined }
      let counted = 0
      let pages = 0
      let start: Record<string, AttributeValue> | undefined
      do {
        pages++
        const remaining = limitValue === undefined ? undefined : limitValue - counted
        const cmd = buildDynamoCommand(judging, tableName, {
          ExclusiveStartKey: start,
          Limit: computeRequestLimit(state, remaining, pages),
        })
        const result = yield* send(client, state, cmd)
        const rows = (result.Items ?? []) as Array<Record<string, AttributeValue>>
        counted += rows.filter((row) => !isExcludedRow(state, row)).length
        start = result.LastEvaluatedKey as Record<string, AttributeValue> | undefined
        if (limitValue !== undefined && counted >= limitValue) return limitValue
        if (state.maxPagesValue != null && pages >= state.maxPagesValue) break
      } while (start != null)
      return counted
    }

    let total = 0
    let pageCount = 0
    let exclusiveStartKey: Record<string, AttributeValue> | undefined

    do {
      pageCount++
      const remaining = limitValue === undefined ? undefined : limitValue - total
      const cmd = buildDynamoCommand(state, tableName, {
        ExclusiveStartKey: exclusiveStartKey,
        Select: "COUNT",
        Limit: computeRequestLimit(state, remaining),
      })
      const result = yield* send(client, state, cmd)

      total += result.Count ?? 0
      exclusiveStartKey = result.LastEvaluatedKey as Record<string, AttributeValue> | undefined

      if (limitValue !== undefined && total >= limitValue) return limitValue
      if (state.maxPagesValue != null && pageCount >= state.maxPagesValue) break
    } while (exclusiveStartKey != null)

    return total
  })

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
    const refusal = refuseEmptyFilterParts(state)
    if (refusal !== undefined) return yield* refusal
    const tableName = state.resolveTableName ? yield* state.resolveTableName : state.tableName
    // A `BatchGet`-hydrated query shows its index query; the `BatchGetItem`
    // that follows each page is not part of these parameters.
    return buildDynamoCommand(indexQueryState(state), tableName)
  })

// ---------------------------------------------------------------------------
// Type guard
// ---------------------------------------------------------------------------

export const isQuery = (u: unknown): u is Query<unknown> =>
  typeof u === "object" && u !== null && QueryTypeId in u
