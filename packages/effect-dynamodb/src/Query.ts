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
// Filter condition types
// ---------------------------------------------------------------------------

/**
 * Filter operator for rich filter expressions.
 * Each operator maps to a DynamoDB FilterExpression function or comparison.
 */
export type FilterOperator =
  | { readonly contains: string }
  | { readonly beginsWith: string }
  | { readonly between: readonly [unknown, unknown] }
  | { readonly gt: unknown }
  | { readonly gte: unknown }
  | { readonly lt: unknown }
  | { readonly lte: unknown }
  | { readonly ne: unknown }
  | { readonly exists: true }
  | { readonly notExists: true }

/**
 * A filter value is either a plain value (equality) or a filter operator.
 * Plain values (string, number, boolean, null) produce `#attr = :val` expressions.
 * Operator objects produce the corresponding DynamoDB expression.
 */
export type FilterValue = string | number | boolean | null | FilterOperator

/**
 * Filter conditions applied as FilterExpression. Each key is an attribute name,
 * each value is either a plain value (equality) or a {@link FilterOperator}.
 * Multiple filters are ANDed together.
 */
export type FilterCondition = Record<string, FilterValue>

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
  readonly filterConditions: ReadonlyArray<FilterCondition>
  readonly entityTypes: ReadonlyArray<string>
  readonly limitValue: number | undefined
  readonly maxPagesValue: number | undefined
  readonly scanForward: boolean
  readonly consistentRead: boolean
  readonly ignoreOwnershipFlag: boolean
  readonly exclusiveStartKey: Record<string, AttributeValue> | undefined
  readonly isScan: boolean
  readonly projection: ReadonlyArray<string> | undefined
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
    filterConditions: [],
    entityTypes: config.entityTypes,
    limitValue: undefined,
    maxPagesValue: undefined,
    scanForward: true,
    consistentRead: false,
    ignoreOwnershipFlag: false,
    exclusiveStartKey: undefined,
    isScan: false,
    projection: undefined,
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
    filterConditions: [],
    entityTypes: config.entityTypes,
    limitValue: undefined,
    maxPagesValue: undefined,
    scanForward: true,
    consistentRead: false,
    ignoreOwnershipFlag: false,
    exclusiveStartKey: undefined,
    isScan: true,
    projection: undefined,
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
 * Add filter expression conditions.
 * Multiple filter calls are ANDed together.
 */
export const filter: {
  (conditions: FilterCondition): <A>(self: Query<A>) => Query<A>
  <A>(self: Query<A>, conditions: FilterCondition): Query<A>
} = Function.dual(
  2,
  <A>(self: Query<A>, conditions: FilterCondition): Query<A> =>
    new QueryImpl<A>({
      ...self._state,
      filterConditions: [...self._state.filterConditions, conditions],
    }),
)

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

  // User filter conditions
  let filterCounter = 0
  for (const fc of state.filterConditions) {
    for (const [attr, val] of Object.entries(fc)) {
      const nameKey = `#f${filterCounter}`
      const valKey = `:f${filterCounter}`
      names[nameKey] = attr

      if (val !== null && typeof val === "object") {
        if ("contains" in val) {
          values[valKey] = toAttributeValue(val.contains)
          filterClauses.push(`contains(${nameKey}, ${valKey})`)
        } else if ("beginsWith" in val) {
          values[valKey] = toAttributeValue(val.beginsWith)
          filterClauses.push(`begins_with(${nameKey}, ${valKey})`)
        } else if ("between" in val) {
          const valKey2 = `:f${filterCounter}b`
          values[valKey] = toAttributeValue(val.between[0])
          values[valKey2] = toAttributeValue(val.between[1])
          filterClauses.push(`${nameKey} BETWEEN ${valKey} AND ${valKey2}`)
        } else if ("gt" in val) {
          values[valKey] = toAttributeValue(val.gt)
          filterClauses.push(`${nameKey} > ${valKey}`)
        } else if ("gte" in val) {
          values[valKey] = toAttributeValue(val.gte)
          filterClauses.push(`${nameKey} >= ${valKey}`)
        } else if ("lt" in val) {
          values[valKey] = toAttributeValue(val.lt)
          filterClauses.push(`${nameKey} < ${valKey}`)
        } else if ("lte" in val) {
          values[valKey] = toAttributeValue(val.lte)
          filterClauses.push(`${nameKey} <= ${valKey}`)
        } else if ("ne" in val) {
          values[valKey] = toAttributeValue(val.ne)
          filterClauses.push(`${nameKey} <> ${valKey}`)
        } else if ("exists" in val) {
          filterClauses.push(`attribute_exists(${nameKey})`)
        } else if ("notExists" in val) {
          filterClauses.push(`attribute_not_exists(${nameKey})`)
        }
      } else {
        values[valKey] = toAttributeValue(val)
        filterClauses.push(`${nameKey} = ${valKey}`)
      }
      filterCounter++
    }
  }

  return { filterClauses, names, values }
}

// ---------------------------------------------------------------------------
// Internal: build DynamoDB query input from state
// ---------------------------------------------------------------------------

const buildQueryInput = (state: QueryState) => {
  const names: Record<string, string> = { "#pk": state.pkField }
  const values: Record<string, AttributeValue> = { ":pk": toAttributeValue(state.pkValue) }
  let keyCondition = "#pk = :pk"

  // Sort key condition
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

  // Merge shared filter clauses (entity type + user filters)
  const fc = buildFilterClauses(state)
  Object.assign(names, fc.names)
  Object.assign(values, fc.values)

  // Projection
  let projectionExpression: string | undefined
  if (state.projection && state.projection.length > 0) {
    const proj = Projection.projection(state.projection)
    projectionExpression = proj.expression
    Object.assign(names, proj.names)
  }

  return {
    KeyConditionExpression: keyCondition,
    FilterExpression: fc.filterClauses.length > 0 ? fc.filterClauses.join(" AND ") : undefined,
    ProjectionExpression: projectionExpression,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
    ConsistentRead: state.consistentRead || undefined,
  }
}

// ---------------------------------------------------------------------------
// Internal: build DynamoDB scan input from state
// ---------------------------------------------------------------------------

const buildScanInput = (state: QueryState) => {
  const fc = buildFilterClauses(state)

  // Projection
  let projectionExpression: string | undefined
  const names = { ...fc.names }
  if (state.projection && state.projection.length > 0) {
    const proj = Projection.projection(state.projection)
    projectionExpression = proj.expression
    Object.assign(names, proj.names)
  }

  return {
    FilterExpression: fc.filterClauses.length > 0 ? fc.filterClauses.join(" AND ") : undefined,
    ProjectionExpression: projectionExpression,
    ExpressionAttributeNames: Object.keys(names).length > 0 ? names : undefined,
    ExpressionAttributeValues: Object.keys(fc.values).length > 0 ? fc.values : undefined,
    ConsistentRead: state.consistentRead || undefined,
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

    const result = state.isScan
      ? yield* (() => {
          const scanInput = buildScanInput(state)
          return client.scan({
            TableName: tableName,
            IndexName: state.indexName,
            FilterExpression: scanInput.FilterExpression,
            ProjectionExpression: scanInput.ProjectionExpression,
            ExpressionAttributeNames: scanInput.ExpressionAttributeNames,
            ExpressionAttributeValues: scanInput.ExpressionAttributeValues,
            ExclusiveStartKey: state.exclusiveStartKey,
            Limit: state.limitValue,
            ConsistentRead: scanInput.ConsistentRead,
          })
        })()
      : yield* (() => {
          const queryInput = buildQueryInput(state)
          return client.query({
            TableName: tableName,
            IndexName: state.indexName,
            KeyConditionExpression: queryInput.KeyConditionExpression,
            FilterExpression: queryInput.FilterExpression,
            ProjectionExpression: queryInput.ProjectionExpression,
            ExpressionAttributeNames: queryInput.ExpressionAttributeNames,
            ExpressionAttributeValues: queryInput.ExpressionAttributeValues,
            ExclusiveStartKey: state.exclusiveStartKey,
            Limit: state.limitValue,
            ScanIndexForward: state.scanForward,
            ConsistentRead: queryInput.ConsistentRead,
          })
        })()

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

    // Resolve table name — either from state or via provided effect
    const tableName = state.resolveTableName ? yield* state.resolveTableName : state.tableName

    let pageCount = 0
    return Stream.paginate(
      state.exclusiveStartKey as Record<string, AttributeValue> | undefined,
      (exclusiveStartKey: Record<string, AttributeValue> | undefined) =>
        Effect.gen(function* () {
          pageCount++
          const result = state.isScan
            ? yield* (() => {
                const scanInput = buildScanInput(state)
                return client.scan({
                  TableName: tableName,
                  IndexName: state.indexName,
                  FilterExpression: scanInput.FilterExpression,
                  ProjectionExpression: scanInput.ProjectionExpression,
                  ExpressionAttributeNames: scanInput.ExpressionAttributeNames,
                  ExpressionAttributeValues: scanInput.ExpressionAttributeValues,
                  ExclusiveStartKey: exclusiveStartKey,
                  Limit: state.limitValue,
                  ConsistentRead: scanInput.ConsistentRead,
                })
              })()
            : yield* (() => {
                const queryInput = buildQueryInput(state)
                return client.query({
                  TableName: tableName,
                  IndexName: state.indexName,
                  KeyConditionExpression: queryInput.KeyConditionExpression,
                  FilterExpression: queryInput.FilterExpression,
                  ProjectionExpression: queryInput.ProjectionExpression,
                  ExpressionAttributeNames: queryInput.ExpressionAttributeNames,
                  ExpressionAttributeValues: queryInput.ExpressionAttributeValues,
                  ExclusiveStartKey: exclusiveStartKey,
                  Limit: state.limitValue,
                  ScanIndexForward: state.scanForward,
                  ConsistentRead: queryInput.ConsistentRead,
                })
              })()

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
      const result = state.isScan
        ? yield* (() => {
            const scanInput = buildScanInput(state)
            return client.scan({
              TableName: tableName,
              IndexName: state.indexName,
              FilterExpression: scanInput.FilterExpression,
              ExpressionAttributeNames: scanInput.ExpressionAttributeNames,
              ExpressionAttributeValues: scanInput.ExpressionAttributeValues,
              ExclusiveStartKey: exclusiveStartKey,
              Limit: state.limitValue,
              ConsistentRead: scanInput.ConsistentRead,
              Select: "COUNT",
            })
          })()
        : yield* (() => {
            const queryInput = buildQueryInput(state)
            return client.query({
              TableName: tableName,
              IndexName: state.indexName,
              KeyConditionExpression: queryInput.KeyConditionExpression,
              FilterExpression: queryInput.FilterExpression,
              ExpressionAttributeNames: queryInput.ExpressionAttributeNames,
              ExpressionAttributeValues: queryInput.ExpressionAttributeValues,
              ExclusiveStartKey: exclusiveStartKey,
              Limit: state.limitValue,
              ScanIndexForward: state.scanForward,
              ConsistentRead: queryInput.ConsistentRead,
              Select: "COUNT",
            })
          })()

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

    if (state.isScan) {
      const scanInput = buildScanInput(state)
      return {
        TableName: tableName,
        IndexName: state.indexName,
        FilterExpression: scanInput.FilterExpression,
        ProjectionExpression: scanInput.ProjectionExpression,
        ExpressionAttributeNames: scanInput.ExpressionAttributeNames,
        ExpressionAttributeValues: scanInput.ExpressionAttributeValues,
        Limit: state.limitValue,
        ConsistentRead: scanInput.ConsistentRead,
      }
    }

    const queryInput = buildQueryInput(state)
    return {
      TableName: tableName,
      IndexName: state.indexName,
      KeyConditionExpression: queryInput.KeyConditionExpression,
      FilterExpression: queryInput.FilterExpression,
      ProjectionExpression: queryInput.ProjectionExpression,
      ExpressionAttributeNames: queryInput.ExpressionAttributeNames,
      ExpressionAttributeValues: queryInput.ExpressionAttributeValues,
      Limit: state.limitValue,
      ScanIndexForward: state.scanForward,
      ConsistentRead: queryInput.ConsistentRead,
    }
  })

// ---------------------------------------------------------------------------
// Type guard
// ---------------------------------------------------------------------------

export const isQuery = (u: unknown): u is Query<unknown> =>
  typeof u === "object" && u !== null && QueryTypeId in u
