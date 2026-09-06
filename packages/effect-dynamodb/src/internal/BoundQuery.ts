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

import type { ValidationError } from "@effect-dynamodb/schema/Errors.js"
import * as KeyComposer from "@effect-dynamodb/schema/KeyComposer.js"
import { type Effect, Stream } from "effect"
import type { DynamoClientError } from "../DynamoClient.js"
import * as Query from "../Query.js"
import type { ConditionOps, ConditionShorthand, Expr } from "./Expr.js"
import { parseSimpleShorthand } from "./Expr.js"
import type { Path, PathBuilder } from "./PathBuilder.js"

// ---------------------------------------------------------------------------
// Sort key condition ops for the `where` callback
// ---------------------------------------------------------------------------

/**
 * Operand type accepted by a `.where()` condition on a sort key composite
 * whose value type is `V`.
 *
 * - **String-typed composites** (including literal unions like
 *   `"todo" | "done"`) widen to `string`, so open bounds and `beginsWith`
 *   prefixes that are not themselves valid values still typecheck.
 * - **Every other composite** keeps its own type. That is the point of
 *   issue #114: `serializeValue` zero-pads numbers to 16 digits and bigints
 *   to 38 on the write path, so a stringly-typed `"42"` compares against
 *   `"0000000000000042"` and sorts *after* every stored value — a silent
 *   mismatch. Requiring the composite's own type means the operand goes
 *   through the same serialization the stored key did.
 */
export type SkOperand<V> = [V] extends [string] ? string : V

/** Sort key condition operators for `.where()` callback.
 * The `field` parameter accepts values from `t` (e.g. `t.status`); `V` is
 * inferred from it so the operand type follows the composite. */
export interface SkConditionOps<SK = Record<string, unknown>> {
  readonly eq: <V extends SK[keyof SK]>(field: V, value: SkOperand<V>) => Query.SortKeyCondition
  readonly lt: <V extends SK[keyof SK]>(field: V, value: SkOperand<V>) => Query.SortKeyCondition
  readonly lte: <V extends SK[keyof SK]>(field: V, value: SkOperand<V>) => Query.SortKeyCondition
  readonly gt: <V extends SK[keyof SK]>(field: V, value: SkOperand<V>) => Query.SortKeyCondition
  readonly gte: <V extends SK[keyof SK]>(field: V, value: SkOperand<V>) => Query.SortKeyCondition
  readonly between: <V extends SK[keyof SK]>(
    field: V,
    low: SkOperand<V>,
    high: SkOperand<V>,
  ) => Query.SortKeyCondition
  readonly beginsWith: <V extends SK[keyof SK]>(
    field: V,
    prefix: SkOperand<V>,
  ) => Query.SortKeyCondition
}

/**
 * Build the runtime `SkConditionOps` for one `.where()` invocation.
 *
 * The ops record which SK composite the caller targeted (`t.status` → the
 * string `"status"`, courtesy of `buildSkAccessor`). `composeSkCondition`
 * needs that name so it can compose the operand into the *same* position of
 * the stored sort key — otherwise the raw operand is compared against a fully
 * composed key and the condition silently matches everything or nothing.
 *
 * Operands are run through `KeyComposer.serializeValue` — the SAME function
 * the write path uses — so a numeric composite is zero-padded, a `Date` /
 * `DateTime` becomes its ISO form, and the operand compares like-for-like
 * against the stored key (issue #114). `serializeValue` is idempotent on its
 * own output, so the downstream `composeSkCondition` hooks (which compose
 * through `KeyComposer` again) are unaffected. Casing is NOT applied here —
 * it belongs to key composition, which happens downstream.
 *
 * The callback is invoked synchronously and exactly once, so a closed-over
 * mutable slot is safe here.
 */
const makeSkConditionOps = (): {
  readonly ops: SkConditionOps<any>
  readonly targetField: () => string | undefined
} => {
  let target: string | undefined
  const capture = (field: unknown): void => {
    if (typeof field === "string") target = field
  }
  const s = (value: unknown): string => KeyComposer.serializeValue(value)
  const ops: SkConditionOps<any> = {
    eq: (field, value) => {
      capture(field)
      return { eq: s(value) }
    },
    lt: (field, value) => {
      capture(field)
      return { lt: s(value) }
    },
    lte: (field, value) => {
      capture(field)
      return { lte: s(value) }
    },
    gt: (field, value) => {
      capture(field)
      return { gt: s(value) }
    },
    gte: (field, value) => {
      capture(field)
      return { gte: s(value) }
    },
    between: (field, low, high) => {
      capture(field)
      return { between: [s(low), s(high)] }
    },
    beginsWith: (field, prefix) => {
      capture(field)
      return { beginsWith: s(prefix) }
    },
  }
  return { ops, targetField: () => target }
}

/** Build the runtime sk accessor object — each property returns its field name. */
const buildSkAccessor = (fields: ReadonlyArray<string>): Record<string, string> => {
  const acc: Record<string, string> = {}
  for (const f of fields) acc[f] = f
  return acc
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
   *
   * ```ts
   * .where((t, { beginsWith }) => beginsWith(t.status, "d"))
   * .where((t, { eq }) => eq(t.status, "done"))
   * ```
   */
  readonly where: (
    fn: (t: SkRemaining, ops: SkConditionOps<SkRemaining>) => Query.SortKeyCondition,
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
  /** SK composite field names for building the SkAccessor in `.where()`. */
  readonly skFields?: ReadonlyArray<string> | undefined
  readonly provide: <X, E>(eff: Effect.Effect<X, E, any>) => Effect.Effect<X, E, never>
  /**
   * Optional: transform the raw SK condition produced by `.where()` into one
   * whose operands are composed the same way stored sort keys are.
   *
   * `field` is the SK composite name the caller targeted (`t.status` →
   * `"status"`), or `undefined` when the callback did not go through the sk
   * accessor.
   */
  readonly composeSkCondition?: (
    condition: Query.SortKeyCondition,
    field: string | undefined,
  ) => Query.SortKeyCondition
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
    fn: (t: SkRemaining, ops: SkConditionOps<SkRemaining>) => Query.SortKeyCondition,
  ): BoundQueryImpl<Model, never, A> {
    const skAccessor = (
      this._config.skFields ? buildSkAccessor(this._config.skFields) : {}
    ) as SkRemaining
    const { ops, targetField } = makeSkConditionOps()
    const condition = fn(skAccessor, ops as SkConditionOps<SkRemaining>)
    const finalCondition = this._config.composeSkCondition
      ? this._config.composeSkCondition(condition, targetField())
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
