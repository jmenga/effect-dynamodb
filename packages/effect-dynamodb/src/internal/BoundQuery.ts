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
import { Effect, Stream } from "effect"
import type { DynamoClientError } from "../DynamoClient.js"
import * as Query from "../Query.js"
import type { ConditionOps, ConditionShorthand, Expr } from "./Expr.js"
import { ExprTag, parseSimpleShorthand } from "./Expr.js"
import type { Path, PathBuilder } from "./PathBuilder.js"

/**
 * An expression with every attribute path's top-level field renamed to its
 * stored attribute (#133). Values are left alone.
 */
const renamePaths = (node: unknown, resolve: (name: string) => string): unknown => {
  if (Array.isArray(node)) return node.map((item) => renamePaths(item, resolve))
  if (node === null || typeof node !== "object") return node
  const record = node as { readonly _tag?: unknown; readonly segments?: unknown }
  if (record._tag === "value") return node
  if ((record._tag === "path" || record._tag === "size") && Array.isArray(record.segments)) {
    const [head, ...rest] = record.segments as ReadonlyArray<string | number>
    return { ...record, segments: [typeof head === "string" ? resolve(head) : head, ...rest] }
  }
  // Spread keeps the symbol-keyed Expr brand; string keys are walked.
  const copy: globalThis.Record<string | symbol, unknown> = { ...record }
  for (const [key, value] of Object.entries(record)) copy[key] = renamePaths(value, resolve)
  return copy
}

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
 *   mismatch. Requiring the composite's own type also lets the operand run
 *   through the composite's own codec, which is what makes a transformed
 *   composite (`Schema.BigIntFromString`) compare against the value that was
 *   actually stored.
 */
export type SkOperand<V> = [V] extends [string] ? string : V

/**
 * A `.where()` condition before its operands become key strings.
 *
 * Mirrors `Query.SortKeyCondition` but keeps the operands `unknown`, because
 * the composite's own value (a `bigint`, a `Date`, a `DateTime`) must reach
 * `composeSkCondition` intact: that hook encodes it through the model's field
 * codec — the step `Entity.put` performs before composing keys — and only then
 * serialises. Serialising here first would erase the type the codec needs.
 *
 * `Query.SortKeyCondition` is assignable to this, so a hand-built `{ eq: "x" }`
 * still satisfies the `.where()` callback.
 */
export type RawSortKeyCondition =
  | { readonly eq: unknown }
  | { readonly lt: unknown }
  | { readonly lte: unknown }
  | { readonly gt: unknown }
  | { readonly gte: unknown }
  | { readonly between: readonly [unknown, unknown] }
  | { readonly beginsWith: unknown }

/** Sort key condition operators for `.where()` callback.
 * The `field` parameter accepts values from `t` (e.g. `t.status`); `V` is
 * inferred from it so the operand type follows the composite. */
export interface SkConditionOps<SK = Record<string, unknown>> {
  readonly eq: <V extends SK[keyof SK]>(field: V, value: SkOperand<V>) => RawSortKeyCondition
  readonly lt: <V extends SK[keyof SK]>(field: V, value: SkOperand<V>) => RawSortKeyCondition
  readonly lte: <V extends SK[keyof SK]>(field: V, value: SkOperand<V>) => RawSortKeyCondition
  readonly gt: <V extends SK[keyof SK]>(field: V, value: SkOperand<V>) => RawSortKeyCondition
  readonly gte: <V extends SK[keyof SK]>(field: V, value: SkOperand<V>) => RawSortKeyCondition
  readonly between: <V extends SK[keyof SK]>(
    field: V,
    low: SkOperand<V>,
    high: SkOperand<V>,
  ) => RawSortKeyCondition
  readonly beginsWith: <V extends SK[keyof SK]>(
    field: V,
    prefix: SkOperand<V>,
  ) => RawSortKeyCondition
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
 * Operands are handed on **unserialised**. `composeSkCondition` encodes them
 * through the model's field codec — the step `Entity.put` performs before
 * composing keys — and then composes, so both sides of the comparison come out
 * of one pipeline (issues #114 and the encoded/decoded gap it exposed).
 * Without a hook there is no model to consult, so `KeyComposer.serializeValue`
 * is applied directly: the same zero-padding / ISO formatting the write path
 * uses. Casing is never applied here — it belongs to key composition.
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
  const ops: SkConditionOps<any> = {
    eq: (field, value) => {
      capture(field)
      return { eq: value }
    },
    lt: (field, value) => {
      capture(field)
      return { lt: value }
    },
    lte: (field, value) => {
      capture(field)
      return { lte: value }
    },
    gt: (field, value) => {
      capture(field)
      return { gt: value }
    },
    gte: (field, value) => {
      capture(field)
      return { gte: value }
    },
    between: (field, low, high) => {
      capture(field)
      return { between: [low, high] }
    },
    beginsWith: (field, prefix) => {
      capture(field)
      return { beginsWith: prefix }
    },
  }
  return { ops, targetField: () => target }
}

/**
 * Serialise a raw condition's operands. Used only when no `composeSkCondition`
 * hook is present — with one, encoding + composition happen there instead.
 */
const serializeRawCondition = (condition: RawSortKeyCondition): Query.SortKeyCondition => {
  const s = (value: unknown): string => KeyComposer.serializeValue(value)
  if ("eq" in condition) return { eq: s(condition.eq) }
  if ("lt" in condition) return { lt: s(condition.lt) }
  if ("lte" in condition) return { lte: s(condition.lte) }
  if ("gt" in condition) return { gt: s(condition.gt) }
  if ("gte" in condition) return { gte: s(condition.gte) }
  if ("between" in condition) return { between: [s(condition.between[0]), s(condition.between[1])] }
  return { beginsWith: s(condition.beginsWith) }
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

  /**
   * Add a **client-side** predicate, evaluated on the decoded item inside the
   * same accumulate loop `.limit()` uses — so a page still fills to `n` and its
   * cursor still resumes after the last item kept (#122).
   *
   * Prefer `.filter()` whenever DynamoDB can express the condition: a
   * `FilterExpression` is evaluated before the rows cross the wire, while this
   * runs after, so every examined row is still read and paid for. Reach for it
   * when the comparison is not expressible server-side — case-insensitive
   * matching being the standard case, since DynamoDB has no `lower()`:
   *
   * ```ts
   * db.entities.Venues.byCity({ city: "melbourne" })
   *   .filterBy((v) => v.name.toLowerCase().startsWith("melbourne"))
   *   .limit(25)
   *   .fetch()
   * ```
   *
   * Cannot be combined with `.select()` — see EDD-9054.
   */
  readonly filterBy: (predicate: (item: A) => boolean) => BoundQuery<Model, SkRemaining, A>

  /** Select specific attributes (projection). Callback or string array. */
  readonly select: {
    (
      fn: (t: PathBuilder<Model, Model, never>) => ReadonlyArray<Path<Model, any, any>>,
    ): BoundQuery<Model, SkRemaining, Record<string, unknown>>
    (attributes: ReadonlyArray<string>): BoundQuery<Model, SkRemaining, Record<string, unknown>>
  }

  /**
   * Return at most `n` items — a contract on results. The query accumulates
   * across as many requests as it takes, which is what makes it work under a
   * `.filter()`. Use `.pageSize()` to size the requests themselves.
   */
  readonly limit: (n: number) => BoundQuery<Model, SkRemaining, A>

  /**
   * Fetch in batches of `n` — sets DynamoDB's `Limit` (rows examined per
   * request). A contract on round trips, not on what comes back.
   */
  readonly pageSize: (n: number) => BoundQuery<Model, SkRemaining, A>

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

  /**
   * Execute a count-only query (no items returned).
   *
   * Under `.filterBy()` there is nothing to count server-side — `Select:
   * "COUNT"` returns no items to run the predicate against — so the rows are
   * read and the accepted ones counted. Correct, but it pays for the read;
   * that is why the error channel carries `ValidationError` (decode can fail).
   */
  readonly count: () => Effect.Effect<number, DynamoClientError | ValidationError, never>
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
    fn: (t: SkRemaining, ops: SkConditionOps<SkRemaining>) => RawSortKeyCondition,
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
    condition: RawSortKeyCondition,
    field: string | undefined,
  ) => Query.SortKeyCondition
  /**
   * Optional: how `collect()` shapes the items — a collection groups them by
   * member. Carried through every combinator, so `.filter().collect()` groups
   * as `collect()` does (#133).
   */
  readonly groupCollected?: ((items: ReadonlyArray<unknown>) => unknown) | undefined
  /**
   * Optional: how `paginate()` shapes each streamed item (`undefined` drops
   * it) — a collection tags each with its member (#133).
   */
  readonly tagStreamed?: ((item: unknown) => unknown) | undefined
  /**
   * Optional: how `.filter()` names the stored attributes of renamed fields
   * (#133) — see {@link entityNaming} / {@link collectionNaming}.
   */
  readonly renameExpr?: ((expr: Expr) => Expr) | undefined
  /**
   * Optional: what `.select()` becomes when stored names differ from the
   * domain names asked for (#133). Without it, a plain projection.
   */
  readonly selectAs?:
    | ((
        query: Query.Query<any>,
        paths: ReadonlyArray<ReadonlyArray<string | number>>,
        form: "attributes" | "paths",
      ) => Query.Query<Record<string, unknown>>)
    | undefined
}

/** The plain projection: the domain names are the stored names. */
const plainSelect = (
  query: Query.Query<any>,
  paths: ReadonlyArray<ReadonlyArray<string | number>>,
  form: "attributes" | "paths",
): Query.Query<Record<string, unknown>> =>
  form === "attributes"
    ? Query.select(
        query,
        paths.map((path) => String(path[0])),
      )
    : Query.selectPaths(query, paths)

/** The top-level field names an expression's paths name. */
const pathHeads = (node: unknown, into: Set<string> = new Set()): Set<string> => {
  if (Array.isArray(node)) {
    for (const item of node) pathHeads(item, into)
    return into
  }
  if (node === null || typeof node !== "object") return into
  const record = node as { readonly _tag?: unknown; readonly segments?: unknown }
  if (record._tag === "value") return into
  if ((record._tag === "path" || record._tag === "size") && Array.isArray(record.segments)) {
    const head = record.segments[0]
    if (typeof head === "string") into.add(head)
    return into
  }
  for (const value of Object.values(record)) pathHeads(value, into)
  return into
}

/**
 * @internal An entity's naming (#133): filters and selects name the stored
 * attribute of each renamed field. A select of no renamed field stays the
 * plain projection, so an entity without renames sends what it always sent.
 */
export const entityNaming = (
  resolve: ((domainName: string) => string) | undefined,
): Pick<BoundQueryConfig<unknown>, "renameExpr" | "selectAs"> =>
  resolve === undefined
    ? {}
    : {
        renameExpr: (expr) => renamePaths(expr, resolve) as Expr,
        selectAs: (query, paths, form) =>
          paths.some((path) => typeof path[0] === "string" && resolve(path[0]) !== path[0])
            ? Query.selectRenamed(query, paths, resolve)
            : plainSelect(query, paths, form),
      }

/**
 * @internal A collection's naming (#133). Its members may store one domain
 * field under different names, so a filter is judged per member — an OR over
 * the members, each naming its own attributes, when they disagree — and a
 * select projects every member's stored names (and `__edd_e__`), handing each
 * item back under the domain names of the member it belongs to, grouped as
 * the collection's `collect` expects.
 */
export const collectionNaming = (
  members: ReadonlyArray<{
    readonly entityType: string
    readonly entityKey: string
    readonly resolve: (domainName: string) => string
    /** The member's domain field names, when known: a filter names only these. */
    readonly fields?: ReadonlySet<string> | undefined
  }>,
): Pick<BoundQueryConfig<unknown>, "renameExpr" | "selectAs"> => ({
  renameExpr: (expr) => {
    const heads = [...pathHeads(expr)]
    // A filter names DOMAIN fields: a member without one of them has no rows
    // it can match — never one whose stored attribute merely bears the name.
    const knows = (m: (typeof members)[number]) =>
      m.fields === undefined || heads.every((head) => m.fields!.has(head))
    const first = members[0]
    if (
      first === undefined ||
      members.every(
        (m) => knows(m) && heads.every((head) => m.resolve(head) === first.resolve(head)),
      )
    ) {
      return first === undefined ? expr : (renamePaths(expr, first.resolve) as Expr)
    }
    const matching = members.filter(knows)
    if (matching.length === 0) {
      // No member has the field: nothing matches.
      return {
        [ExprTag]: ExprTag,
        _tag: "notExists",
        operand: { _tag: "path", segments: ["__edd_e__"] },
      } as unknown as Expr
    }
    return {
      [ExprTag]: ExprTag,
      _tag: "or",
      exprs: matching.map(
        (m): Expr => ({
          [ExprTag]: ExprTag,
          _tag: "and",
          exprs: [
            {
              [ExprTag]: ExprTag,
              _tag: "eq",
              left: { _tag: "path", segments: ["__edd_e__"] },
              right: { _tag: "value", value: m.entityType },
            } as Expr,
            renamePaths(expr, m.resolve) as Expr,
          ],
        }),
      ),
    } as Expr
  },
  selectAs: (query, paths) => {
    const heads = [...new Set(paths.map((path) => String(path[0])))]
    const stored = new Map<string, ReadonlyArray<string | number>>()
    for (const m of members) {
      for (const path of paths) {
        const renamed = [m.resolve(String(path[0])), ...path.slice(1)]
        stored.set(JSON.stringify(renamed), renamed)
      }
    }
    stored.set(JSON.stringify(["__edd_e__"]), ["__edd_e__"])
    const byType = new Map(members.map((m) => [m.entityType, m]))
    return Query.selectProjected(query, [...stored.values()], (raw) => {
      const m = byType.get(raw.__edd_e__ as string)
      if (m === undefined) return { _memberKey: "__unknown__", _decoded: raw }
      const item: Record<string, unknown> = {}
      for (const head of heads) {
        const value = raw[m.resolve(head)]
        if (value !== undefined) item[head] = value
      }
      return { _memberKey: m.entityKey, _decoded: item }
    })
  },
})

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
    fn: (t: SkRemaining, ops: SkConditionOps<SkRemaining>) => RawSortKeyCondition,
  ): BoundQueryImpl<Model, never, A> {
    const skAccessor = (
      this._config.skFields ? buildSkAccessor(this._config.skFields) : {}
    ) as SkRemaining
    const { ops, targetField } = makeSkConditionOps()
    const condition = fn(skAccessor, ops as SkConditionOps<SkRemaining>)
    const finalCondition = this._config.composeSkCondition
      ? this._config.composeSkCondition(condition, targetField())
      : serializeRawCondition(condition)
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
    const expr =
      typeof fnOrShorthand === "function"
        ? fnOrShorthand(this._config.pathBuilder, this._config.conditionOps)
        : // Shorthand object — parse to equality Expr
          parseSimpleShorthand(fnOrShorthand as Record<string, unknown>)
    // Paths name the stored attributes of renamed fields.
    const stored = this._config.renameExpr === undefined ? expr : this._config.renameExpr(expr)
    return new BoundQueryImpl(Query.filterExpr(this._query, stored), this._config)
  }

  // --- filterBy ---
  filterBy(predicate: (item: A) => boolean): BoundQueryImpl<Model, SkRemaining, A> {
    return new BoundQueryImpl(Query.filterBy(this._query, predicate), this._config)
  }

  // --- select ---
  select(
    fnOrAttrs:
      | ((t: PathBuilder<Model, Model, never>) => ReadonlyArray<Path<Model, any, any>>)
      | ReadonlyArray<string>,
  ): BoundQueryImpl<Model, SkRemaining, Record<string, unknown>> {
    const [paths, form] =
      typeof fnOrAttrs === "function"
        ? [
            fnOrAttrs(this._config.pathBuilder).map(
              (p) => (p as unknown as { segments: ReadonlyArray<string | number> }).segments,
            ),
            "paths" as const,
          ]
        : [fnOrAttrs.map((attr) => [attr]), "attributes" as const]
    const select = this._config.selectAs ?? plainSelect
    return new BoundQueryImpl(select(this._query, paths, form), this._config)
  }

  // --- pagination & ordering ---
  limit(n: number): BoundQueryImpl<Model, SkRemaining, A> {
    return new BoundQueryImpl(Query.limit(this._query, n), this._config)
  }

  pageSize(n: number): BoundQueryImpl<Model, SkRemaining, A> {
    return new BoundQueryImpl(Query.pageSize(this._query, n), this._config)
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
    const page = this._config.provide(Query.execute(this._query))
    const group = this._config.groupCollected
    return group === undefined
      ? page
      : (page.pipe(
          Effect.map((p) => ({ ...p, items: group(p.items) })),
        ) as unknown as Effect.Effect<Query.Page<A>, DynamoClientError | ValidationError, never>)
  }

  collect(): Effect.Effect<Array<A>, DynamoClientError | ValidationError, never> {
    const collected = this._config.provide(Query.collect(this._query))
    const group = this._config.groupCollected
    return group === undefined
      ? collected
      : (collected.pipe(Effect.map((items) => group(items))) as unknown as Effect.Effect<
          Array<A>,
          DynamoClientError | ValidationError,
          never
        >)
  }

  paginate(): Stream.Stream<A, DynamoClientError | ValidationError, never> {
    const tag = this._config.tagStreamed
    const items = Stream.unwrap(this._config.provide(Query.paginate(this._query))).pipe(
      Stream.flatMap((page: Array<A>) => Stream.fromIterable(page)),
    )
    return tag === undefined
      ? items
      : (items.pipe(
          Stream.map((item) => tag(item)),
          Stream.filter((item) => item !== undefined),
        ) as unknown as Stream.Stream<A, DynamoClientError | ValidationError, never>)
  }

  count(): Effect.Effect<number, DynamoClientError | ValidationError, never> {
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
