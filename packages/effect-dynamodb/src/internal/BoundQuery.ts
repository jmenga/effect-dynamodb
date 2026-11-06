/**
 * @internal BoundQuery — Fluent query builder with pre-resolved services.
 *
 * `BoundQuery<Model, SkRemaining, A, W>` wraps a `Query<A>` with a pre-resolved
 * `provide` function so all terminals return `Effect` with `R = never`.
 *
 * - Combinators return a new `BoundQuery` (immutable).
 * - `where` consumes `SkRemaining` → `BoundQuery<Model, never, A, never>`.
 * - `where` is only available when `SkRemaining` is not `never`.
 * - `within` (#171) bounds the sort key composites `W` names; it and `where`
 *   exclude each other. On a Z-order accessor it bounds the dimensions and
 *   prefix composites, and `zorder` chooses how the box is read.
 * - Terminals: `fetch`, `collect`, `paginate`, `count`; `explain` describes
 *   the plan without sending anything.
 */

import type { ValidationError } from "@effect-dynamodb/schema/Errors.js"
import * as KeyComposer from "@effect-dynamodb/schema/KeyComposer.js"
import { Effect, Stream } from "effect"
import type { DynamoClientError } from "../DynamoClient.js"
import * as Query from "../Query.js"
import * as Capacity from "./Capacity.js"
import type { ConditionOps, ConditionShorthand, Expr } from "./Expr.js"
import { ExprTag, parseSimpleShorthand } from "./Expr.js"
import type { PackedPath, Path, PathBuilder } from "./PathBuilder.js"

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
 *   issue #114: `serializeValue` encodes numbers and bigints in numeric order
 *   on the write path (`42` as `"0000000000000042"`), so a stringly-typed
 *   `"42"` compares against that text and sorts *after* every stored value —
 *   a silent mismatch. Requiring the composite's own type also lets the
 *   operand run through the composite's own codec, which is what makes a
 *   transformed composite (`Schema.BigIntFromString`) compare against the
 *   value that was actually stored.
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
 * is applied directly: the same numeric encoding / ISO formatting the write
 * path uses. Casing is never applied here — it belongs to key composition.
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

export interface BoundQueryBase<
  Model,
  SkRemaining,
  A,
  W extends WithinSpec<any, WithinKind> = never,
> {
  /** Add a filter expression (post-read). Callback or shorthand. */
  readonly filter: {
    (
      fn: (t: PathBuilder<Model, Model, never>, ops: ConditionOps<Model>) => Expr,
    ): BoundQuery<Model, SkRemaining, A, W>
    (shorthand: ConditionShorthand): BoundQuery<Model, SkRemaining, A, W>
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
  readonly filterBy: (predicate: (item: A) => boolean) => BoundQuery<Model, SkRemaining, A, W>

  /** Select specific attributes (projection). Callback or string array. */
  readonly select: {
    (
      fn: (
        t: PathBuilder<Model, Model, never>,
      ) => ReadonlyArray<Path<Model, any, any> | PackedPath<Model, any, any>>,
    ): BoundQuery<Model, SkRemaining, Record<string, unknown>, W>
    (attributes: ReadonlyArray<string>): BoundQuery<Model, SkRemaining, Record<string, unknown>, W>
  }

  /**
   * Return at most `n` items — a contract on results. The query accumulates
   * across as many requests as it takes, which is what makes it work under a
   * `.filter()`, sizing each request from the pass rate the earlier ones
   * showed. Use `.pageSize()` to size the requests themselves, or
   * `.pageSize("natural")` for 1.36's sizing; a query with `.maxPages()` keeps
   * 1.36's sizing too.
   */
  readonly limit: (n: number) => BoundQuery<Model, SkRemaining, A, W>

  /**
   * Fetch in batches of `n` — sets DynamoDB's `Limit` (rows examined per
   * request). A contract on round trips, not on what comes back. `"natural"`
   * sizes requests exactly as 1.36 did (natural 1 MB pages under a filter);
   * any other string throws `[EDD-9095]`.
   */
  readonly pageSize: (size: number | "natural") => BoundQuery<Model, SkRemaining, A, W>

  /**
   * Run `observer` after every request a terminal sends, with the `Limit` sent
   * and the rows DynamoDB examined, the filter kept and the query accepted
   * (`Query.QueryRequestEvent`). Its failure is a defect; DynamoDB calls it
   * makes are not charged to the query's consumed capacity.
   */
  readonly onRequest: (
    observer: (event: Query.QueryRequestEvent) => Effect.Effect<void>,
  ) => BoundQuery<Model, SkRemaining, A, W>

  /**
   * Set the maximum number of DynamoDB pages to fetch. On a sharded index, the
   * maximum number of rounds: each reads at most one page per partition.
   */
  readonly maxPages: (n: number) => BoundQuery<Model, SkRemaining, A, W>

  /**
   * How many requests a query of a sharded index sends at once (#183). The
   * default is one per partition. Has no effect on an unsharded index. Anything
   * but a positive integer throws `[EDD-9105]`.
   */
  readonly concurrency: (n: number) => BoundQuery<Model, SkRemaining, A, W>

  /** Reverse the sort order (ScanIndexForward = false). */
  readonly reverse: () => BoundQuery<Model, SkRemaining, A, W>

  /**
   * Resume pagination from an opaque cursor. The cursor is decoded when a
   * terminal runs: a malformed one fails it with a `ValidationError`
   * (`[EDD-9094]`), as does a `.within()` cursor on a query without
   * `.within()`. A `.within()` query also refuses one from another plan
   * (other bounds, partition, direction or index declaration) or positioned
   * outside its own. A query without `.within()` can't recognise another
   * query's well-formed cursor: DynamoDB may reject it
   * (`DynamoValidationError`) or the query resumes from it.
   */
  readonly startFrom: (cursor: string) => BoundQuery<Model, SkRemaining, A, W>

  /**
   * Enable consistent reads. DynamoDB rejects them on a GSI, which it reads
   * only eventually consistently: the query then fails with a
   * `ValidationError` naming the index.
   */
  readonly consistentRead: () => BoundQuery<Model, SkRemaining, A, W>

  /** Skip the __edd_e__ entity type filter. */
  readonly ignoreOwnership: () => BoundQuery<Model, SkRemaining, A, W>

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

  /**
   * Describe what the terminals would send — the plan (`key`, `skip-scan`,
   * `filter`, or a Z-order `naive` / `jump` / `precise` / `empty`), why it
   * was chosen, the key ranges known up front, the fields
   * checked per row and how requests are sized — without sending anything.
   * A `startFrom` cursor is not read: the plan is described from its start.
   */
  readonly explain: () => Effect.Effect<Query.QueryExplain, never, never>
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
  ) => BoundQuery<Model, never, A, never>
}

// ---------------------------------------------------------------------------
// Within method — only available when W names bounds (#171)
// ---------------------------------------------------------------------------

/** Which accessor a `.within()` belongs to. */
export type WithinKind = "composite" | "zorder"

/** What `.within()` accepts on an accessor (`bounds`), and the kind of accessor. */
export interface WithinSpec<B, K extends WithinKind> {
  readonly bounds: B
  readonly kind: K
}

/** `.within()` consumed on a Z-order accessor: `.zorder()` stays available. */
export type ZOrderApplied = WithinSpec<never, "zorder">

type BoundOperator = "eq" | "between" | "gt" | "gte" | "lt" | "lte" | "in"

/**
 * `T`, every other operator ruled out — so `{ eq, gte }` or `{ lt, lte }` is
 * a type error rather than a union member that excess property checks pass.
 */
type Only<T> = T & { readonly [K in Exclude<BoundOperator, keyof T>]?: never }

/** A lower bound: `gt` or `gte`, not both. */
export type LowerBound<V> = Only<{ readonly gt: V }> | Only<{ readonly gte: V }>

/** An upper bound: `lt` or `lte`, not both. */
export type UpperBound<V> = Only<{ readonly lt: V }> | Only<{ readonly lte: V }>

/**
 * A `.within()` bound on one field: a value, an inclusive pair, or one or two
 * open ends. Bounds are compared in key form — the value composed into the
 * sort key (numbers padded, dates as stored, strings cased).
 */
export type RangeBound<V> =
  | Only<{ readonly eq: V }>
  | Only<{ readonly between: readonly [V, V] }>
  | LowerBound<V>
  | UpperBound<V>
  | Only<{ readonly gt: V; readonly lt: V }>
  | Only<{ readonly gt: V; readonly lte: V }>
  | Only<{ readonly gte: V; readonly lt: V }>
  | Only<{ readonly gte: V; readonly lte: V }>

/**
 * The members of a literals dimension entry `D` over a field of type `V`: its
 * declared `values`, else the field's members. `never` for any other entry (a
 * range, a date-time window, a byte width).
 */
type LiteralsEntryMembers<D, V> = D extends string
  ? Exclude<V, undefined>
  : D extends
        | { readonly min: unknown }
        | { readonly max: unknown }
        | { readonly from: unknown }
        | { readonly unit: unknown }
        | { readonly bytes: unknown }
    ? never
    : D extends { readonly values: ReadonlyArray<infer L> }
      ? L
      : Exclude<V, undefined>

/**
 * A `.within()` bound on one dimension of a Z-order sort key (#171), declared
 * as entry `D` over a field of type `V`: a {@link RangeBound} in the field's
 * own type — for a literals dimension by its members' order — and, for a
 * literals dimension only, a set of members.
 */
export type DimensionBound<D, V> = [LiteralsEntryMembers<D, V>] extends [never]
  ? RangeBound<V>
  :
      | RangeBound<LiteralsEntryMembers<D, V>>
      | Only<{ readonly in: ReadonlyArray<LiteralsEntryMembers<D, V>> }>

export interface WithinOptions {
  /**
   * Skip-scan probe budget per terminal call. After this many probes, the
   * rest of the range is read once with the bounds checked per row. `0`
   * never skips. Default 32.
   */
  readonly maxSkips?: number | undefined
}

export interface BoundQueryWithin<Model, A, W extends WithinSpec<any, WithinKind>> {
  /**
   * Bound the sort key composites the accessor left open — any of them, not
   * only the leading one:
   *
   * ```ts
   * db.entities.Listings.byCategory({ category: "bikes" })
   *   .within({ price: { gte: 100, lte: 500 } })
   *   .collect()
   * ```
   *
   * The bounds the key condition can reach are read by key. When open
   * composites lie before the first bound, the query *skip-scans*: a one-row
   * probe finds each distinct value of them (a *tuple*), and only that tuple's
   * matching range is read — results come back in sort key order. Bounds the
   * key condition can't express are checked on each row. A free-form string
   * composite before the bound, or an index that also holds history rows,
   * can't be skipped soundly: the range is read once with every bound checked
   * per row (`explain()` says which plan runs, and why).
   *
   * On a Z-order accessor (#171), the dimensions bound a box — any of them, in
   * the fields' own types (`in` for a `literals` dimension) — and the prefix
   * composites take one exact value each. The box is read as address ranges
   * (`.zorder()` picks how); a prefix composite left out is skip-scanned.
   * Every bound is exact: a `FilterExpression` where DynamoDB's comparison
   * agrees with the dimension's order, a per-row check where it doesn't.
   *
   * Excludes `.where()`. Values are the composites' own types.
   */
  readonly within: (
    bounds: W["bounds"],
    options?: WithinOptions,
  ) => BoundQuery<Model, never, A, W["kind"] extends "zorder" ? ZOrderApplied : never>
}

// ---------------------------------------------------------------------------
// ZOrder method — only on a Z-order accessor (#171)
// ---------------------------------------------------------------------------

export interface BoundQueryZOrder<Model, SkRemaining, A, W extends WithinSpec<any, WithinKind>> {
  /**
   * How the box `.within()` bounds is read — before or after `.within()`;
   * later calls merge over earlier ones:
   *
   * ```ts
   * db.entities.Listings.byFacets({ region: "north" })
   *   .within({ price: { lte: 500_000 }, bedrooms: { gte: 3 } })
   *   .zorder({ strategy: "precise", maxRanges: 32 })
   *   .collect()
   * ```
   *
   * An unknown `strategy`, or a `maxRanges` / `concurrency` that isn't a
   * positive integer, throws `[EDD-9095]`.
   */
  readonly zorder: (options: Query.ZOrderOptions) => BoundQuery<Model, SkRemaining, A, W>
}

// ---------------------------------------------------------------------------
// BoundQuery — conditional type that includes `where` only when SkRemaining != never
// ---------------------------------------------------------------------------

export type BoundQuery<
  Model,
  SkRemaining,
  A,
  W extends WithinSpec<any, WithinKind> = never,
> = BoundQueryBase<Model, SkRemaining, A, W> &
  ([SkRemaining] extends [never] ? {} : BoundQueryWithWhere<Model, SkRemaining, A>) &
  ([W] extends [never] ? {} : [W["bounds"]] extends [never] ? {} : BoundQueryWithin<Model, A, W>) &
  ([W] extends [never]
    ? {}
    : W["kind"] extends "zorder"
      ? BoundQueryZOrder<Model, SkRemaining, A, W>
      : {})

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
   * Optional: the operation its terminals report as (consumed capacity, #174)
   * — `Entity.query` with the accessor name, `Collection.query`, … Without
   * it, `Entity.scan` / `Entity.query` from the descriptor.
   */
  readonly operation?:
    | {
        readonly name: string
        readonly target?: string | undefined
        readonly index?: string | undefined
      }
    | undefined
  /**
   * Optional: transform the raw SK condition produced by `.where()` into one
   * whose operands are composed the same way stored sort keys are.
   *
   * `field` is the SK composite name the caller targeted (`t.status` →
   * `"status"`), or `undefined` when the callback did not go through the sk
   * accessor. `undefined` when no stored key satisfies the condition: the
   * query plans `empty` and sends nothing (#171).
   */
  readonly composeSkCondition?: (
    condition: RawSortKeyCondition,
    field: string | undefined,
  ) => Query.SortKeyCondition | undefined
  /**
   * Optional: plan `.within(bounds)` on the query (#171) — an accessor's own
   * composites and encoders turn the bounds into key ranges and row checks.
   * Throws `[EDD-9093]` / `[EDD-9050]` for bounds it can't use. Without it,
   * `.within()` is refused (collections, scans).
   */
  readonly planWithin?: <X>(
    query: Query.Query<X>,
    bounds: Record<string, unknown>,
    options: WithinOptions | undefined,
  ) => Query.Query<X>
  /** Optional: the accessor reads a Z-order sort key, so `.zorder()` applies (#171). */
  readonly zorder?: boolean | undefined
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
    /** The member's domain field names, when known: filters and selects name only these. */
    readonly fields?: ReadonlySet<string> | undefined
  }>,
): Pick<BoundQueryConfig<unknown>, "renameExpr" | "selectAs"> => {
  /**
   * The attribute a member reads for a domain field: its stored name when it
   * has the field; the field's own name when it hasn't and nothing of its is
   * stored under that name (DynamoDB then evaluates an absent attribute, as
   * it always did); and when another of its fields IS stored under that name,
   * an attribute that never exists — so a stored name never stands in for a
   * domain field.
   */
  const attributeOf = (m: (typeof members)[number], field: string): string => {
    if (m.fields === undefined || m.fields.has(field)) return m.resolve(field)
    for (const own of m.fields) {
      if (m.resolve(own) === field) return ABSENT_ATTRIBUTE
    }
    return field
  }
  return {
    renameExpr: (expr) => {
      const heads = [...pathHeads(expr)]
      const first = members[0]
      if (first === undefined) return expr
      // Every member reads the same attributes: one expression, as before.
      if (
        members.every((m) =>
          heads.every((head) => attributeOf(m, head) === attributeOf(first, head)),
        )
      ) {
        return renamePaths(expr, (head) => attributeOf(first, head)) as Expr
      }
      // They differ: each member's rows judged by its own attributes.
      return {
        [ExprTag]: ExprTag,
        _tag: "or",
        exprs: members.map(
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
              renamePaths(expr, (head) => attributeOf(m, head)) as Expr,
            ],
          }),
        ),
      } as Expr
    },
    selectAs: (query, paths) => {
      const heads = [...new Set(paths.map((path) => String(path[0])))]
      // Only a member's own domain fields are read for it.
      const has = (m: (typeof members)[number], head: string) =>
        m.fields === undefined || m.fields.has(head)
      const stored = new Map<string, ReadonlyArray<string | number>>()
      for (const m of members) {
        for (const path of paths) {
          if (!has(m, String(path[0]))) continue
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
          if (!has(m, head)) continue
          const value = raw[m.resolve(head)]
          if (value !== undefined) item[head] = value
        }
        return { _memberKey: m.entityKey, _decoded: item }
      })
    },
  }
}

/** An attribute no item ever has (#133): see {@link collectionNaming}. */
const ABSENT_ATTRIBUTE = "__edd_absent__"

// ---------------------------------------------------------------------------
// BoundQuery implementation
// ---------------------------------------------------------------------------

/** `[EDD-9093]`: `.where()` and `.within()` exclude each other, and `.within()` applies once. */
const refuseWithin = (what: string): never => {
  throw new Error(
    `[EDD-9093] .${what}: a query takes one sort key constraint — either .where() on the ` +
      `next open composite, or one .within() bounding any of them.`,
  )
}

const ZORDER_STRATEGIES: ReadonlySet<unknown> = new Set(["auto", "naive", "jump", "precise"])

/**
 * `.zorder(options)`'s options (#171), the ones given: library options that
 * can't be honoured throw `[EDD-9095]`; `pageSize` is DynamoDB's `Limit`,
 * passed on unchecked as `pageSize(n)`'s number is.
 */
const zorderOptions = (options: Query.ZOrderOptions): Query.ZOrderOptions => {
  const refuse = (what: string): never => {
    throw new Error(`[EDD-9095] .zorder() ${what}`)
  }
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    return refuse("takes an object of options: { strategy, pageSize, maxRanges, concurrency }.")
  }
  const given = Object.fromEntries(
    Object.entries(options).filter(([, value]) => value !== undefined),
  ) as Query.ZOrderOptions
  const unknown = Object.keys(given).filter(
    (key) => !["strategy", "pageSize", "maxRanges", "concurrency"].includes(key),
  )
  if (unknown.length > 0) {
    return refuse(`has no option ${unknown.map((key) => JSON.stringify(key)).join(", ")}.`)
  }
  if (given.strategy !== undefined && !ZORDER_STRATEGIES.has(given.strategy)) {
    return refuse(
      `strategy ${JSON.stringify(given.strategy)} is not one of "auto", "naive", "jump", "precise".`,
    )
  }
  for (const key of ["maxRanges", "concurrency"] as const) {
    const value = given[key]
    if (value !== undefined && !(Number.isInteger(value) && value > 0)) {
      return refuse(`${key} ${JSON.stringify(value)} is not a positive integer.`)
    }
  }
  return given
}

/** @internal */
export class BoundQueryImpl<Model, SkRemaining, A> {
  constructor(
    readonly _query: Query.Query<A>,
    readonly _config: BoundQueryConfig<Model>,
    /** The sort key constraint already applied: `.where()` and `.within()` exclude each other. */
    readonly _applied?: "where" | "within" | undefined,
  ) {}

  // --- where ---
  where(
    fn: (t: SkRemaining, ops: SkConditionOps<SkRemaining>) => RawSortKeyCondition,
  ): BoundQueryImpl<Model, never, A> {
    if (this._applied === "within") refuseWithin("where() after .within()")
    const skAccessor = (
      this._config.skFields ? buildSkAccessor(this._config.skFields) : {}
    ) as SkRemaining
    const { ops, targetField } = makeSkConditionOps()
    const condition = fn(skAccessor, ops as SkConditionOps<SkRemaining>)
    const finalCondition = this._config.composeSkCondition
      ? this._config.composeSkCondition(condition, targetField())
      : serializeRawCondition(condition)
    if (finalCondition === undefined) {
      return new BoundQueryImpl<Model, never, A>(
        Query.planEmpty(this._query),
        this._config,
        "where",
      )
    }
    return new BoundQueryImpl<Model, never, A>(
      Query.whereUnderPins(this._query, finalCondition),
      this._config,
      "where",
    )
  }

  // --- within ---
  within(
    bounds: Record<string, unknown>,
    options?: WithinOptions,
  ): BoundQueryImpl<Model, never, A> {
    Query.refuseShardedPlan(this._query as Query.Query<unknown>)
    if (this._applied !== undefined) {
      refuseWithin(this._applied === "where" ? "within() after .where()" : "a second .within()")
    }
    const maxSkips = options?.maxSkips
    if (maxSkips !== undefined && !(Number.isInteger(maxSkips) && maxSkips >= 0)) {
      throw new Error(
        `[EDD-9095] .within() maxSkips ${JSON.stringify(maxSkips)} is not a probe budget: ` +
          `pass a non-negative integer (0 never skips; the default is 32).`,
      )
    }
    const plan = this._config.planWithin
    if (plan === undefined) refuseWithin("within() on a query without sort key composites to bound")
    return new BoundQueryImpl<Model, never, A>(
      plan!(this._query, bounds, options),
      this._config,
      "within",
    )
  }

  // --- zorder ---
  zorder(options: Query.ZOrderOptions): BoundQueryImpl<Model, SkRemaining, A> {
    Query.refuseShardedPlan(this._query as Query.Query<unknown>)
    if (this._config.zorder !== true) {
      throw new Error(
        `[EDD-9095] .zorder() applies only to a Z-order index accessor: this query's index ` +
          `has no Z-order sort key.`,
      )
    }
    return new BoundQueryImpl(
      Query.plan(this._query, { zorder: zorderOptions(options) }),
      this._config,
      this._applied,
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
    return new BoundQueryImpl(Query.filterExpr(this._query, stored), this._config, this._applied)
  }

  // --- filterBy ---
  filterBy(predicate: (item: A) => boolean): BoundQueryImpl<Model, SkRemaining, A> {
    return new BoundQueryImpl(Query.filterBy(this._query, predicate), this._config, this._applied)
  }

  // --- select ---
  select(
    fnOrAttrs:
      | ((
          t: PathBuilder<Model, Model, never>,
        ) => ReadonlyArray<Path<Model, any, any> | PackedPath<Model, any, any>>)
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
    return new BoundQueryImpl(select(this._query, paths, form), this._config, this._applied)
  }

  // --- pagination & ordering ---
  limit(n: number): BoundQueryImpl<Model, SkRemaining, A> {
    return new BoundQueryImpl(Query.limit(this._query, n), this._config, this._applied)
  }

  pageSize(size: number | "natural"): BoundQueryImpl<Model, SkRemaining, A> {
    return new BoundQueryImpl(Query.pageSize(this._query, size), this._config, this._applied)
  }

  onRequest(
    observer: (event: Query.QueryRequestEvent) => Effect.Effect<void>,
  ): BoundQueryImpl<Model, SkRemaining, A> {
    return new BoundQueryImpl(Query.onRequest(this._query, observer), this._config, this._applied)
  }

  maxPages(n: number): BoundQueryImpl<Model, SkRemaining, A> {
    return new BoundQueryImpl(Query.maxPages(this._query, n), this._config, this._applied)
  }

  concurrency(n: number): BoundQueryImpl<Model, SkRemaining, A> {
    return new BoundQueryImpl(Query.concurrency(this._query, n), this._config, this._applied)
  }

  reverse(): BoundQueryImpl<Model, SkRemaining, A> {
    return new BoundQueryImpl(Query.reverse(this._query), this._config, this._applied)
  }

  startFrom(cursor: string): BoundQueryImpl<Model, SkRemaining, A> {
    return new BoundQueryImpl(Query.startFrom(this._query, cursor), this._config, this._applied)
  }

  // --- read options ---
  consistentRead(): BoundQueryImpl<Model, SkRemaining, A> {
    return new BoundQueryImpl(Query.consistentRead(this._query), this._config, this._applied)
  }

  ignoreOwnership(): BoundQueryImpl<Model, SkRemaining, A> {
    return new BoundQueryImpl(Query.ignoreOwnership(this._query), this._config, this._applied)
  }

  // --- terminals ---
  /**
   * The terminal's operation, run INSIDE `provide` so the reporting setting a
   * bound client captured is the one read.
   */
  private _operation(): readonly [string, Capacity.OperationOptions] {
    const op = this._config.operation
    if (op !== undefined) return [op.name, { target: op.target, index: op.index }]
    const options = Query.operationOptions(this._query as Query.Query<unknown>)
    return [this._query._state.isScan ? "Entity.scan" : "Entity.query", options]
  }

  private _run<X, E>(effect: Effect.Effect<X, E, any>): Effect.Effect<X, E, never> {
    const [name, options] = this._operation()
    return this._config.provide(Capacity.operation(name, options, effect))
  }

  fetch(): Effect.Effect<Query.Page<A>, DynamoClientError | ValidationError, never> {
    const page = this._run(Query.execute(this._query))
    const group = this._config.groupCollected
    return group === undefined
      ? page
      : (page.pipe(
          Effect.map((p) => ({ ...p, items: group(p.items) })),
        ) as unknown as Effect.Effect<Query.Page<A>, DynamoClientError | ValidationError, never>)
  }

  collect(): Effect.Effect<Array<A>, DynamoClientError | ValidationError, never> {
    const collected = this._run(Query.collect(this._query))
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
    const [name, options] = this._operation()
    const items = Stream.unwrap(
      this._config.provide(
        Effect.flatMap(Query.paginate(this._query), (pages) =>
          Capacity.operationStream(name, options, pages),
        ),
      ),
    ).pipe(Stream.flatMap((page: Array<A>) => Stream.fromIterable(page)))
    return tag === undefined
      ? items
      : (items.pipe(
          Stream.map((item) => tag(item)),
          Stream.filter((item) => item !== undefined),
        ) as unknown as Stream.Stream<A, DynamoClientError | ValidationError, never>)
  }

  count(): Effect.Effect<number, DynamoClientError | ValidationError, never> {
    return this._run(Query.count(this._query))
  }

  /** No I/O, so no operation, span or client: the plan is described from the query alone. */
  explain(): Effect.Effect<Query.QueryExplain, never, never> {
    return Query.explain(this._query)
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
