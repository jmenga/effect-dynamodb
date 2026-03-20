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
import { Effect, Function, Option, Pipeable, Stream } from "effect"
import { DynamoClient, type DynamoClientError } from "./DynamoClient.js"
import type { ValidationError } from "./Errors.js"
import { compileExpr, type Expr } from "./internal/Expr.js"
import { compilePath } from "./internal/PathBuilder.js"
import { fromAttributeMap, toAttributeValue } from "./Marshaller.js"
import * as Projection from "./Projection.js"

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
  readonly limitValue: number | undefined
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
 * Set the maximum number of items per DynamoDB page.
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

const buildProjection = (state: QueryState, names: Record<string, string>): string | undefined => {
  if (state.projectionPaths && state.projectionPaths.length > 0) {
    const counter = { value: 0 }
    const projParts: Array<string> = []
    for (const segments of state.projectionPaths) {
      projParts.push(compilePath(segments, names, "proj", counter))
    }
    return projParts.join(", ")
  }
  if (state.projection && state.projection.length > 0) {
    const proj = Projection.projection(state.projection)
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

const buildCommandInput = (state: QueryState): DynamoCommandInput => {
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

  const projectionExpression = buildProjection(state, names)

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
 */
const buildDynamoCommand = (
  state: QueryState,
  tableName: string,
  overrides?: Record<string, unknown>,
) => {
  const input = buildCommandInput(state)
  return {
    TableName: tableName,
    IndexName: state.indexName,
    KeyConditionExpression: input.KeyConditionExpression,
    FilterExpression: input.FilterExpression,
    ProjectionExpression: input.ProjectionExpression,
    ExpressionAttributeNames: input.ExpressionAttributeNames,
    ExpressionAttributeValues: input.ExpressionAttributeValues,
    ConsistentRead: input.ConsistentRead,
    Limit: state.limitValue,
    ScanIndexForward: state.isScan ? undefined : state.scanForward,
    ...overrides,
  }
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
 * Execute the query and collect all pages into a single array.
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
 * Execute a single DynamoDB page and return a {@link Page} with an opaque cursor.
 * Combine with {@link startFrom} to iterate through pages:
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

    const cmd = buildDynamoCommand(state, tableName, {
      ExclusiveStartKey: state.exclusiveStartKey,
    })
    const result = state.isScan ? yield* client.scan(cmd) : yield* client.query(cmd)

    const rawItems = (result.Items ?? []).map((item) => fromAttributeMap(item))
    const items = yield* Effect.forEach(
      rawItems,
      (raw) => state.decoder(raw) as Effect.Effect<A, ValidationError>,
    )

    const cursor =
      result.LastEvaluatedKey != null
        ? encodeCursor(result.LastEvaluatedKey as Record<string, AttributeValue>)
        : null

    return { items, cursor } as Page<A>
  })

/**
 * Execute the query and return a Stream of page arrays.
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

    let pageCount = 0
    return Stream.paginate(
      state.exclusiveStartKey as Record<string, AttributeValue> | undefined,
      (exclusiveStartKey: Record<string, AttributeValue> | undefined) =>
        Effect.gen(function* () {
          pageCount++
          const cmd = buildDynamoCommand(state, tableName, { ExclusiveStartKey: exclusiveStartKey })
          const result = state.isScan ? yield* client.scan(cmd) : yield* client.query(cmd)

          const rawItems = (result.Items ?? []).map((item) => fromAttributeMap(item))
          const decoded = yield* Effect.forEach(
            rawItems,
            (raw) => state.decoder(raw) as Effect.Effect<A, ValidationError>,
          )

          // Stop pagination if maxPages reached or no more pages
          const hasMorePages = result.LastEvaluatedKey != null
          const maxPagesReached = state.maxPagesValue != null && pageCount >= state.maxPagesValue

          const nextKey =
            hasMorePages && !maxPagesReached ? Option.some(result.LastEvaluatedKey!) : Option.none()

          return [[decoded], nextKey] as const
        }),
    )
  })

/**
 * Execute a count query. Uses `Select: "COUNT"` on DynamoDB — no items are returned.
 * Returns the total count across all pages (respects maxPages).
 */
export const count = <A>(self: Query<A>): Effect.Effect<number, DynamoClientError, DynamoClient> =>
  Effect.gen(function* () {
    const client = yield* DynamoClient
    const state = self._state
    const tableName = state.resolveTableName ? yield* state.resolveTableName : state.tableName

    let total = 0
    let pageCount = 0
    let exclusiveStartKey: Record<string, AttributeValue> | undefined

    do {
      pageCount++
      const cmd = buildDynamoCommand(state, tableName, {
        ExclusiveStartKey: exclusiveStartKey,
        Select: "COUNT",
      })
      const result = state.isScan ? yield* client.scan(cmd) : yield* client.query(cmd)

      total += result.Count ?? 0
      exclusiveStartKey = result.LastEvaluatedKey as Record<string, AttributeValue> | undefined

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
