/**
 * @internal BoundQuery — Fluent query builder with pre-resolved services.
 *
 * `BoundQuery<Model, SkRemaining, A>` wraps a `Query<A>` with a pre-resolved
 * `provide` function so all terminals return `Effect` with `R = never`.
 *
 * - Combinators return a new `BoundQuery` (immutable).
 * - `where` consumes `SkRemaining` → `BoundQuery<Model, never, A>`.
 * - `where` is only available when `SkRemaining` is not `never`.
 * - Terminals: `fetch`, `collect`, `paginate`, `count`.
 */

import { type Effect, Stream } from "effect"
import type { DynamoClientError } from "../DynamoClient.js"
import type { ValidationError } from "../Errors.js"
import * as Query from "../Query.js"
import type { ConditionOps, ConditionShorthand, Expr } from "./Expr.js"
import { parseSimpleShorthand } from "./Expr.js"
import type { Path, PathBuilder } from "./PathBuilder.js"

// ---------------------------------------------------------------------------
// Sort key condition ops for the `where` callback
// ---------------------------------------------------------------------------

export interface SkConditionOps {
  readonly eq: (value: string) => Query.SortKeyCondition
  readonly lt: (value: string) => Query.SortKeyCondition
  readonly lte: (value: string) => Query.SortKeyCondition
  readonly gt: (value: string) => Query.SortKeyCondition
  readonly gte: (value: string) => Query.SortKeyCondition
  readonly between: (low: string, high: string) => Query.SortKeyCondition
  readonly beginsWith: (prefix: string) => Query.SortKeyCondition
}

const skConditionOps: SkConditionOps = {
  eq: (value) => ({ eq: value }),
  lt: (value) => ({ lt: value }),
  lte: (value) => ({ lte: value }),
  gt: (value) => ({ gt: value }),
  gte: (value) => ({ gte: value }),
  between: (low, high) => ({ between: [low, high] }),
  beginsWith: (prefix) => ({ beginsWith: prefix }),
}

// ---------------------------------------------------------------------------
// BoundQuery interface — base methods (always available)
// ---------------------------------------------------------------------------

export interface BoundQueryBase<Model, SkRemaining, A> {
  /** Add a filter expression (post-read). Callback or shorthand. */
  readonly filter: {
    (
      fn: (t: PathBuilder<Model, Model, never>, ops: ConditionOps<Model>) => Expr,
    ): BoundQuery<Model, SkRemaining, A>
    (shorthand: ConditionShorthand): BoundQuery<Model, SkRemaining, A>
  }

  /** Select specific attributes (projection). Callback or string array. */
  readonly select: {
    (
      fn: (t: PathBuilder<Model, Model, never>) => ReadonlyArray<Path<Model, any, any>>,
    ): BoundQuery<Model, SkRemaining, Record<string, unknown>>
    (attributes: ReadonlyArray<string>): BoundQuery<Model, SkRemaining, Record<string, unknown>>
  }

  /** Set the maximum number of items per DynamoDB page. */
  readonly limit: (n: number) => BoundQuery<Model, SkRemaining, A>

  /** Set the maximum number of DynamoDB pages to fetch. */
  readonly maxPages: (n: number) => BoundQuery<Model, SkRemaining, A>

  /** Reverse the sort order (ScanIndexForward = false). */
  readonly reverse: () => BoundQuery<Model, SkRemaining, A>

  /** Resume pagination from an opaque cursor. */
  readonly startFrom: (cursor: string) => BoundQuery<Model, SkRemaining, A>

  /** Enable consistent reads. */
  readonly consistentRead: () => BoundQuery<Model, SkRemaining, A>

  /** Skip the __edd_e__ entity type filter. */
  readonly ignoreOwnership: () => BoundQuery<Model, SkRemaining, A>

  /** Execute a single page. Returns items + opaque cursor. */
  readonly fetch: () => Effect.Effect<Query.Page<A>, DynamoClientError | ValidationError, never>

  /** Execute and collect all pages into a single array. */
  readonly collect: () => Effect.Effect<Array<A>, DynamoClientError | ValidationError, never>

  /** Execute and return a lazy Stream of items. Automatically paginates. */
  readonly paginate: () => Stream.Stream<A, DynamoClientError | ValidationError, never>

  /** Execute a count-only query (no items returned). */
  readonly count: () => Effect.Effect<number, DynamoClientError, never>
}

// ---------------------------------------------------------------------------
// Where method — only available when SkRemaining is not never
// ---------------------------------------------------------------------------

export interface BoundQueryWithWhere<Model, SkRemaining, A> {
  /**
   * Sort key condition on remaining SK composites.
   * Consumes SkRemaining — cannot be called twice.
   */
  readonly where: (
    fn: (sk: SkRemaining, ops: SkConditionOps) => Query.SortKeyCondition,
  ) => BoundQuery<Model, never, A>
}

// ---------------------------------------------------------------------------
// BoundQuery — conditional type that includes `where` only when SkRemaining != never
// ---------------------------------------------------------------------------

export type BoundQuery<Model, SkRemaining, A> = BoundQueryBase<Model, SkRemaining, A> &
  ([SkRemaining] extends [never] ? {} : BoundQueryWithWhere<Model, SkRemaining, A>)

// ---------------------------------------------------------------------------
// BoundQuery config — passed to impl at construction
// ---------------------------------------------------------------------------

/** @internal */
export interface BoundQueryConfig<Model> {
  readonly pathBuilder: PathBuilder<Model, Model, never>
  readonly conditionOps: ConditionOps<Model>
  readonly provide: <X, E>(eff: Effect.Effect<X, E, any>) => Effect.Effect<X, E, never>
  /** Optional: transform SK condition (e.g., compose prefix for partial composites) */
  readonly composeSkCondition?: (condition: Query.SortKeyCondition) => Query.SortKeyCondition
}

// ---------------------------------------------------------------------------
// BoundQuery implementation
// ---------------------------------------------------------------------------

/** @internal */
export class BoundQueryImpl<Model, SkRemaining, A> {
  constructor(
    readonly _query: Query.Query<A>,
    readonly _config: BoundQueryConfig<Model>,
  ) {}

  // --- where ---
  where(
    fn: (sk: SkRemaining, ops: SkConditionOps) => Query.SortKeyCondition,
  ): BoundQueryImpl<Model, never, A> {
    const condition = fn(undefined as SkRemaining, skConditionOps)
    const finalCondition = this._config.composeSkCondition
      ? this._config.composeSkCondition(condition)
      : condition
    return new BoundQueryImpl<Model, never, A>(
      Query.where(this._query, finalCondition),
      this._config,
    )
  }

  // --- filter ---
  filter(
    fnOrShorthand:
      | ((t: PathBuilder<Model, Model, never>, ops: ConditionOps<Model>) => Expr)
      | ConditionShorthand,
  ): BoundQueryImpl<Model, SkRemaining, A> {
    if (typeof fnOrShorthand === "function") {
      const expr = fnOrShorthand(this._config.pathBuilder, this._config.conditionOps)
      return new BoundQueryImpl(Query.filterExpr(this._query, expr), this._config)
    }
    // Shorthand object — parse to equality Expr then apply
    const expr = parseSimpleShorthand(fnOrShorthand as Record<string, unknown>)
    return new BoundQueryImpl(Query.filterExpr(this._query, expr), this._config)
  }

  // --- select ---
  select(
    fnOrAttrs:
      | ((t: PathBuilder<Model, Model, never>) => ReadonlyArray<Path<Model, any, any>>)
      | ReadonlyArray<string>,
  ): BoundQueryImpl<Model, SkRemaining, Record<string, unknown>> {
    if (typeof fnOrAttrs === "function") {
      const paths = fnOrAttrs(this._config.pathBuilder)
      const segments = paths.map(
        (p) => (p as unknown as { segments: ReadonlyArray<string | number> }).segments,
      )
      return new BoundQueryImpl(Query.selectPaths(this._query, segments), this._config)
    }
    return new BoundQueryImpl(Query.select(this._query, fnOrAttrs), this._config)
  }

  // --- pagination & ordering ---
  limit(n: number): BoundQueryImpl<Model, SkRemaining, A> {
    return new BoundQueryImpl(Query.limit(this._query, n), this._config)
  }

  maxPages(n: number): BoundQueryImpl<Model, SkRemaining, A> {
    return new BoundQueryImpl(Query.maxPages(this._query, n), this._config)
  }

  reverse(): BoundQueryImpl<Model, SkRemaining, A> {
    return new BoundQueryImpl(Query.reverse(this._query), this._config)
  }

  startFrom(cursor: string): BoundQueryImpl<Model, SkRemaining, A> {
    return new BoundQueryImpl(Query.startFrom(this._query, cursor), this._config)
  }

  // --- read options ---
  consistentRead(): BoundQueryImpl<Model, SkRemaining, A> {
    return new BoundQueryImpl(Query.consistentRead(this._query), this._config)
  }

  ignoreOwnership(): BoundQueryImpl<Model, SkRemaining, A> {
    return new BoundQueryImpl(Query.ignoreOwnership(this._query), this._config)
  }

  // --- terminals ---
  fetch(): Effect.Effect<Query.Page<A>, DynamoClientError | ValidationError, never> {
    return this._config.provide(Query.execute(this._query))
  }

  collect(): Effect.Effect<Array<A>, DynamoClientError | ValidationError, never> {
    return this._config.provide(Query.collect(this._query))
  }

  paginate(): Stream.Stream<A, DynamoClientError | ValidationError, never> {
    return Stream.unwrap(this._config.provide(Query.paginate(this._query))).pipe(
      Stream.flatMap((page: Array<A>) => Stream.fromIterable(page)),
    )
  }

  count(): Effect.Effect<number, DynamoClientError, never> {
    return this._config.provide(Query.count(this._query))
  }
}

// ---------------------------------------------------------------------------
// Factory functions
// ---------------------------------------------------------------------------

/**
 * @internal Create a BoundQuery wrapping a Query with pre-resolved config.
 */
export const makeBoundQuery = <Model, SkRemaining, A>(
  query: Query.Query<A>,
  config: BoundQueryConfig<Model>,
): BoundQuery<Model, SkRemaining, A> =>
  new BoundQueryImpl<Model, SkRemaining, A>(query, config) as BoundQuery<Model, SkRemaining, A>
