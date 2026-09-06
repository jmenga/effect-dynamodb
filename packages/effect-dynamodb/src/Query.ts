/**
 * Query — Pure description of a DynamoDB query.
 *
 * `Query<A>` is a lazy, immutable data type that describes a query. No DynamoDB
 * calls happen until a terminal (`execute`, `collect`, or `paginate`) is called. All
 * combinators return a new Query — the original is unchanged.
 *
 * Implements Pipeable for ergonomic composition.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import type { ValidationError } from "@effect-dynamodb/schema/Errors.js"
import * as Projection from "@effect-dynamodb/schema/Projection.js"
import { Effect, Function, Option, Pipeable, Stream } from "effect"
import { DynamoClient, type DynamoClientError } from "./DynamoClient.js"
import { compileExpr, type Expr } from "./internal/Expr.js"
import { compilePath } from "./internal/PathBuilder.js"
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
  /** Optional effect to resolve table name at execution time (for deferred resolution) */
  readonly resolveTableName: Effect.Effect<string, never, any> | undefined
  /**
   * Attribute names that make up a resume key for this query — the queried
   * index key plus the table key. Used to rebuild an accurate cursor when a
   * request over-reads and the surplus is discarded (see {@link limit}).
   */
  readonly keyFields: ReadonlyArray<string> | undefined
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
}): Query<A> =>
  new QueryImpl<A>({
    tableName: config.tableName,
    indexName: config.indexName,
    pkField: config.pkField,
    pkValue: config.pkValue,
    skField: config.skField,
    skConditions: [],
    exprFilters: [],
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
}): Query<A> =>
  new QueryImpl<A>({
    tableName: config.tableName,
    indexName: config.indexName,
    pkField: "",
    pkValue: "",
    skField: undefined,
    skConditions: [],
    exprFilters: [],
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
 * Enable consistent reads for this query (or scan).
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

/**
 * Select specific attributes to return (ProjectionExpression).
 * Reduces read capacity and network transfer. When projection is active,
 * items are returned as raw `Record<string, unknown>` instead of decoded
 * schema instances, since projected items may be partial.
 */
export const select: {
  (attributes: ReadonlyArray<string>): <A>(self: Query<A>) => Query<Record<string, unknown>>
  <A>(self: Query<A>, attributes: ReadonlyArray<string>): Query<Record<string, unknown>>
} = Function.dual(
  2,
  <A>(self: Query<A>, attributes: ReadonlyArray<string>): Query<Record<string, unknown>> =>
    new QueryImpl<Record<string, unknown>>({
      ...self._state,
      projection: attributes,
      decoder: (raw) => Effect.succeed(raw),
    }),
)

/**
 * Add an Expr-based filter expression to the query.
 * Multiple filterExpr calls are ANDed together.
 */
export const filterExpr: {
  (expr: Expr): <A>(self: Query<A>) => Query<A>
  <A>(self: Query<A>, expr: Expr): Query<A>
} = Function.dual(
  2,
  <A>(self: Query<A>, expr: Expr): Query<A> =>
    new QueryImpl<A>({
      ...self._state,
      exprFilters: [...self._state.exprFilters, expr],
    }),
)

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
  ): Query<Record<string, unknown>> =>
    new QueryImpl<Record<string, unknown>>({
      ...self._state,
      projectionPaths: paths,
      decoder: (raw) => Effect.succeed(raw),
    }),
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

  // Expr-based filters (compiled from Entity.filter() callback/shorthand API)
  for (const expr of state.exprFilters) {
    const compiled = compileExpr(expr)
    filterClauses.push(compiled.expression)
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
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Internal: limit / pageSize execution helpers
// ---------------------------------------------------------------------------

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
 */
const computeRequestLimit = (
  state: QueryState,
  remaining: number | undefined,
): number | undefined => {
  const pageSize = state.pageSizeValue
  if (remaining === undefined) return pageSize
  if (state.exprFilters.length > 0) return pageSize
  return pageSize === undefined ? remaining : Math.min(pageSize, remaining)
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
const cursorProjectionFields = (state: QueryState): ReadonlyArray<string> => {
  if (state.limitValue === undefined || !state.keyFields) return []
  const projected = new Set<string>([
    ...(state.projection ?? []),
    ...(state.projectionPaths ?? []).map((segments) => String(segments[0])),
  ])
  if (projected.size === 0) return []
  return state.keyFields.filter((field) => !projected.has(field))
}

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
  Effect.gen(function* () {
    const stream = yield* paginateInternal(self)
    const pages = yield* Stream.runCollect(stream)
    return pages.flat()
  })

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
  Effect.gen(function* () {
    const client = yield* DynamoClient
    const state = self._state
    const tableName = state.resolveTableName ? yield* state.resolveTableName : state.tableName
    const limitValue = state.limitValue

    if (limitValue !== undefined && limitValue <= 0) {
      return { items: [], cursor: null } as Page<A>
    }

    // Key attributes borrowed into an active projection so an over-reading
    // request can still rebuild a cursor. Stripped again before decoding.
    const borrowedFields = cursorProjectionFields(state)

    const items: Array<A> = []
    let startKey = state.exclusiveStartKey
    let pageCount = 0
    let cursor: string | null = null

    while (true) {
      pageCount++
      const remaining = limitValue === undefined ? undefined : limitValue - items.length
      const cmd = buildDynamoCommand(
        state,
        tableName,
        { ExclusiveStartKey: startKey, Limit: computeRequestLimit(state, remaining) },
        borrowedFields,
      )
      const result = state.isScan ? yield* client.scan(cmd) : yield* client.query(cmd)

      const returned = (result.Items ?? []) as Array<Record<string, AttributeValue>>
      const lastEvaluatedKey = result.LastEvaluatedKey as Record<string, AttributeValue> | undefined
      const take = remaining === undefined ? returned.length : Math.min(remaining, returned.length)

      for (let i = 0; i < take; i++) {
        const raw = fromAttributeMap(returned[i]!)
        for (const field of borrowedFields) delete raw[field]
        items.push(yield* state.decoder(raw) as Effect.Effect<A, ValidationError>)
      }

      // Over-read: the surplus was discarded, so the cursor has to be rebuilt
      // from the last item handed back rather than from LastEvaluatedKey.
      if (take < returned.length) {
        cursor =
          cursorFromItem(returned[take - 1]!, resumeKeyNames(state, lastEvaluatedKey)) ??
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
> => paginateInternal(self)

const paginateInternal = <A>(
  self: Query<A>,
): Effect.Effect<
  Stream.Stream<Array<A>, DynamoClientError | ValidationError>,
  never,
  DynamoClient
> =>
  Effect.gen(function* () {
    const client = yield* DynamoClient
    const state = self._state
    const tableName = state.resolveTableName ? yield* state.resolveTableName : state.tableName

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
          const cmd = buildDynamoCommand(state, tableName, {
            ExclusiveStartKey: pageState.key,
            Limit: computeRequestLimit(state, remaining),
          })
          const result = state.isScan ? yield* client.scan(cmd) : yield* client.query(cmd)

          const returned = (result.Items ?? []) as Array<Record<string, AttributeValue>>
          const take =
            remaining === undefined ? returned.length : Math.min(remaining, returned.length)
          const decoded = yield* Effect.forEach(
            returned.slice(0, take).map((item) => fromAttributeMap(item)),
            (raw) => state.decoder(raw) as Effect.Effect<A, ValidationError>,
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
  })

/**
 * Execute a count query. Uses `Select: "COUNT"` on DynamoDB — no items are returned.
 * Returns the total count across all requests (respects {@link maxPages}).
 *
 * {@link limit} caps the count, keeping `count()` equal to `collect().length`
 * for the same query: `.limit(n).count()` returns `min(matching, n)` and stops
 * counting once `n` is reached — which makes `.limit(1).count()` a cheap
 * existence check. {@link pageSize} sets the rows examined per request.
 */
export const count = <A>(self: Query<A>): Effect.Effect<number, DynamoClientError, DynamoClient> =>
  Effect.gen(function* () {
    const client = yield* DynamoClient
    const state = self._state
    const tableName = state.resolveTableName ? yield* state.resolveTableName : state.tableName
    const limitValue = state.limitValue

    if (limitValue !== undefined && limitValue <= 0) return 0

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
      const result = state.isScan ? yield* client.scan(cmd) : yield* client.query(cmd)

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
 */
export const asParams = <A>(self: Query<A>): Effect.Effect<Record<string, unknown>, never, any> =>
  Effect.gen(function* () {
    const state = self._state
    const tableName = state.resolveTableName ? yield* state.resolveTableName : state.tableName
    return buildDynamoCommand(state, tableName)
  })

// ---------------------------------------------------------------------------
// Type guard
// ---------------------------------------------------------------------------

export const isQuery = (u: unknown): u is Query<unknown> =>
  typeof u === "object" && u !== null && QueryTypeId in u
