/**
 * @internal BoundCrud — Fluent builders for bound-entity CRUD operations.
 *
 * These builders wrap the unbound `EntityOp` / `EntityDelete` intermediates with
 * a pre-resolved `provide` function so `yield* builder` returns an Effect with
 * `R = never`. Each chainable call returns a new builder (immutable, mirroring
 * `BoundQuery`).
 *
 * Builders implement `Pipeable.Pipeable` + `[Symbol.iterator]` (via
 * `Utils.SingleShotGen`) — NOT `Effect.Effect`. They are yieldable inside
 * `Effect.gen`; use `.asEffect()` for Effect combinator interop.
 */

import type { Effect } from "effect"
import { Pipeable, Utils } from "effect"
import {
  add as addCombinator,
  append as appendCombinator,
  cascade as cascadeCombinator,
  condition as conditionCombinator,
  deleteFromSet as deleteFromSetCombinator,
  expectedVersion as expectedVersionCombinator,
  pathAdd as pathAddCombinator,
  pathAppend as pathAppendCombinator,
  pathDelete as pathDeleteCombinator,
  pathIfNotExists as pathIfNotExistsCombinator,
  pathPrepend as pathPrependCombinator,
  pathRemove as pathRemoveCombinator,
  pathSet as pathSetCombinator,
  pathSubtract as pathSubtractCombinator,
  remove as removeCombinator,
  returnValues as returnValuesCombinator,
  set as setCombinator,
  subtract as subtractCombinator,
} from "./EntityCombinators.js"
import type {
  CascadeTarget,
  EntityDelete,
  EntityPut,
  EntityUpdate,
  PathAddOp,
  PathAppendOp,
  PathDeleteOp,
  PathIfNotExistsOp,
  PathPrependOp,
  PathSetOp,
  PathSubtractOp,
  ReturnValuesMode,
} from "./EntityOps.js"
import type { ConditionOps, Expr } from "./Expr.js"
import { parseSimpleShorthand } from "./Expr.js"
import type { PathBuilder } from "./PathBuilder.js"

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

/** Condition input accepted by `.condition()` — callback or shorthand record. */
export type ConditionArg<Model> =
  | ((t: PathBuilder<Model, Model, never>, ops: ConditionOps<Model>) => Expr)
  | globalThis.Record<string, unknown>

/** Execution wiring shared by all bound-CRUD builders. */
export interface BoundCrudConfig<Model> {
  readonly pathBuilder: PathBuilder<Model, Model, never>
  readonly conditionOps: ConditionOps<Model>
  readonly provide: <X, E>(eff: Effect.Effect<X, E, any>) => Effect.Effect<X, E, never>
}

/** Build a compiled condition Expr from a callback or simple shorthand record.
 * Simple `{ field: value }` shorthand is parsed via `parseSimpleShorthand`,
 * matching the behaviour of entity-scoped `Entity.condition(...)`.
 */
const buildCondition = <Model>(cfg: BoundCrudConfig<Model>, arg: ConditionArg<Model>): Expr => {
  if (typeof arg === "function") return arg(cfg.pathBuilder, cfg.conditionOps)
  return parseSimpleShorthand(arg as globalThis.Record<string, unknown>)
}

// ---------------------------------------------------------------------------
// BoundPut — put / create / upsert share this shape
// ---------------------------------------------------------------------------

/**
 * Fluent builder for put/create/upsert.
 *
 * ```ts
 * yield* db.entities.Users.put(input)
 * yield* db.entities.Users.put(input).condition({ status: "active" })
 * yield* db.entities.Users.create(input).condition((t, { eq }) => eq(t.status, "active"))
 * ```
 */
export interface BoundPut<Model, A, E> extends Pipeable.Pipeable {
  /** Add a condition expression. Callback or shorthand. */
  readonly condition: (cond: ConditionArg<Model>) => BoundPut<Model, A, E>
  /** Convert to an executable Effect for Effect combinator interop. */
  readonly asEffect: () => Effect.Effect<A, E, never>
  /** Yield support for `Effect.gen`. */
  readonly [Symbol.iterator]: () => Iterator<Effect.Effect<A, E, never>, A>
}

/** @internal */
export class BoundPutImpl<Model, A, E> implements BoundPut<Model, A, E> {
  constructor(
    readonly _op: EntityPut<A, any, E, any>,
    readonly _config: BoundCrudConfig<Model>,
  ) {}

  condition(cond: ConditionArg<Model>): BoundPutImpl<Model, A, E> {
    const compiled = buildCondition(this._config, cond)
    const next = conditionCombinator(this._op, compiled)
    return new BoundPutImpl(next, this._config)
  }

  asEffect(): Effect.Effect<A, E, never> {
    return this._config.provide(
      (this._op as unknown as { _run: (m: string) => Effect.Effect<A, E, any> })._run("record"),
    )
  }

  [Symbol.iterator]() {
    return new Utils.SingleShotGen(this.asEffect()) as any
  }

  pipe() {
    return Pipeable.pipeArguments(this, arguments)
  }
}

// ---------------------------------------------------------------------------
// BoundDelete — delete / deleteIfExists share this shape
// ---------------------------------------------------------------------------

/**
 * Fluent builder for delete/deleteIfExists.
 *
 * ```ts
 * yield* db.entities.Tasks.delete({ taskId })
 * yield* db.entities.Tasks.delete({ taskId }).condition({ status: "archived" })
 * yield* db.entities.Tasks.delete({ taskId }).returnValues("allOld")
 * ```
 */
export interface BoundDelete<Model, E> extends Pipeable.Pipeable {
  /** Add a condition expression. Callback or shorthand. */
  readonly condition: (cond: ConditionArg<Model>) => BoundDelete<Model, E>
  /** Set ReturnValues mode (`"none"` or `"allOld"`). */
  readonly returnValues: (mode: ReturnValuesMode) => BoundDelete<Model, E>
  /** Convert to an executable Effect for Effect combinator interop. */
  readonly asEffect: () => Effect.Effect<void, E, never>
  /** Yield support for `Effect.gen`. */
  readonly [Symbol.iterator]: () => Iterator<Effect.Effect<void, E, never>, void>
}

/** @internal */
export class BoundDeleteImpl<Model, E> implements BoundDelete<Model, E> {
  constructor(
    readonly _op: EntityDelete<E, any>,
    readonly _config: BoundCrudConfig<Model>,
  ) {}

  condition(cond: ConditionArg<Model>): BoundDeleteImpl<Model, E> {
    const compiled = buildCondition(this._config, cond)
    const next = conditionCombinator(this._op, compiled)
    return new BoundDeleteImpl(next, this._config)
  }

  returnValues(mode: ReturnValuesMode): BoundDeleteImpl<Model, E> {
    const next = returnValuesCombinator(this._op, mode)
    return new BoundDeleteImpl(next, this._config)
  }

  asEffect(): Effect.Effect<void, E, never> {
    return this._config.provide(this._op.asEffect())
  }

  [Symbol.iterator]() {
    return new Utils.SingleShotGen(this.asEffect()) as any
  }

  pipe() {
    return Pipeable.pipeArguments(this, arguments)
  }
}

// ---------------------------------------------------------------------------
// BoundUpdate — update / patch share this shape
// ---------------------------------------------------------------------------

/**
 * Fluent builder for update/patch.
 *
 * ```ts
 * yield* db.entities.Tasks.update(key).set({ status: "done" })
 * yield* db.entities.Tasks.update(key).set({ status: "done" }).expectedVersion(3)
 * yield* db.entities.Products.update(key)
 *   .set({ price: 24.99 })
 *   .add({ viewCount: 1 })
 *   .subtract({ stock: 3 })
 *   .append({ tags: ["clearance"] })
 *   .remove(["temporaryFlag"])
 * ```
 */
export interface BoundUpdate<Model, A, U, E> extends Pipeable.Pipeable {
  /** Set the fields to update (record-based SET). */
  readonly set: (updates: U) => BoundUpdate<Model, A, U, E>
  /** Remove attributes (REMOVE clause). */
  readonly remove: (fields: ReadonlyArray<string>) => BoundUpdate<Model, A, U, E>
  /** Atomic numeric ADD. */
  readonly add: (values: globalThis.Record<string, number>) => BoundUpdate<Model, A, U, E>
  /** Numeric SET subtraction (synthesized as `SET #f = #f - :v`). */
  readonly subtract: (values: globalThis.Record<string, number>) => BoundUpdate<Model, A, U, E>
  /** List append (synthesized as `SET #f = list_append(#f, :v)`). */
  readonly append: (
    values: globalThis.Record<string, ReadonlyArray<unknown>>,
  ) => BoundUpdate<Model, A, U, E>
  /** Delete elements from a set attribute. */
  readonly deleteFromSet: (
    values: globalThis.Record<string, unknown>,
  ) => BoundUpdate<Model, A, U, E>
  /** Optimistic concurrency — expected version. */
  readonly expectedVersion: (version: number) => BoundUpdate<Model, A, U, E>
  /** Add a condition expression. Callback or shorthand. */
  readonly condition: (cond: ConditionArg<Model>) => BoundUpdate<Model, A, U, E>
  /** Set ReturnValues mode. */
  readonly returnValues: (mode: ReturnValuesMode) => BoundUpdate<Model, A, U, E>
  /** Configure cascade updates to denormalized target entities. */
  readonly cascade: (config: {
    readonly targets: ReadonlyArray<CascadeTarget>
    readonly filter?: globalThis.Record<string, unknown> | undefined
    readonly mode?: "eventual" | "transactional" | undefined
  }) => BoundUpdate<Model, A, U, E>
  /** Path-based SET. */
  readonly pathSet: (op: PathSetOp) => BoundUpdate<Model, A, U, E>
  /** Path-based REMOVE. */
  readonly pathRemove: (segments: ReadonlyArray<string | number>) => BoundUpdate<Model, A, U, E>
  /** Path-based ADD. */
  readonly pathAdd: (op: PathAddOp) => BoundUpdate<Model, A, U, E>
  /** Path-based SUBTRACT. */
  readonly pathSubtract: (op: PathSubtractOp) => BoundUpdate<Model, A, U, E>
  /** Path-based APPEND. */
  readonly pathAppend: (op: PathAppendOp) => BoundUpdate<Model, A, U, E>
  /** Path-based PREPEND. */
  readonly pathPrepend: (op: PathPrependOp) => BoundUpdate<Model, A, U, E>
  /** Path-based if_not_exists. */
  readonly pathIfNotExists: (op: PathIfNotExistsOp) => BoundUpdate<Model, A, U, E>
  /** Path-based DELETE (set removal). */
  readonly pathDelete: (op: PathDeleteOp) => BoundUpdate<Model, A, U, E>
  /** Convert to an executable Effect for Effect combinator interop. */
  readonly asEffect: () => Effect.Effect<A, E, never>
  /** Yield support for `Effect.gen`. */
  readonly [Symbol.iterator]: () => Iterator<Effect.Effect<A, E, never>, A>
}

/** @internal */
export class BoundUpdateImpl<Model, A, U, E> implements BoundUpdate<Model, A, U, E> {
  constructor(
    readonly _op: EntityUpdate<A, any, U, E, any>,
    readonly _config: BoundCrudConfig<Model>,
  ) {}

  private _with(next: EntityUpdate<A, any, U, E, any>): BoundUpdateImpl<Model, A, U, E> {
    return new BoundUpdateImpl(next, this._config)
  }

  set(updates: U): BoundUpdateImpl<Model, A, U, E> {
    return this._with(setCombinator(this._op, updates))
  }

  remove(fields: ReadonlyArray<string>): BoundUpdateImpl<Model, A, U, E> {
    return this._with(removeCombinator(this._op, fields))
  }

  add(values: globalThis.Record<string, number>): BoundUpdateImpl<Model, A, U, E> {
    return this._with(addCombinator(this._op, values))
  }

  subtract(values: globalThis.Record<string, number>): BoundUpdateImpl<Model, A, U, E> {
    return this._with(subtractCombinator(this._op, values))
  }

  append(
    values: globalThis.Record<string, ReadonlyArray<unknown>>,
  ): BoundUpdateImpl<Model, A, U, E> {
    return this._with(appendCombinator(this._op, values))
  }

  deleteFromSet(values: globalThis.Record<string, unknown>): BoundUpdateImpl<Model, A, U, E> {
    return this._with(deleteFromSetCombinator(this._op, values))
  }

  expectedVersion(version: number): BoundUpdateImpl<Model, A, U, E> {
    return this._with(expectedVersionCombinator(this._op, version))
  }

  condition(cond: ConditionArg<Model>): BoundUpdateImpl<Model, A, U, E> {
    const compiled = buildCondition(this._config, cond)
    return this._with(conditionCombinator(this._op, compiled))
  }

  returnValues(mode: ReturnValuesMode): BoundUpdateImpl<Model, A, U, E> {
    return this._with(returnValuesCombinator(this._op, mode))
  }

  cascade(config: {
    readonly targets: ReadonlyArray<CascadeTarget>
    readonly filter?: globalThis.Record<string, unknown> | undefined
    readonly mode?: "eventual" | "transactional" | undefined
  }): BoundUpdateImpl<Model, A, U, E> {
    return this._with(cascadeCombinator(this._op, config) as EntityUpdate<A, any, U, E, any>)
  }

  pathSet(op: PathSetOp): BoundUpdateImpl<Model, A, U, E> {
    return this._with(pathSetCombinator(this._op, op))
  }

  pathRemove(segments: ReadonlyArray<string | number>): BoundUpdateImpl<Model, A, U, E> {
    return this._with(pathRemoveCombinator(this._op, segments))
  }

  pathAdd(op: PathAddOp): BoundUpdateImpl<Model, A, U, E> {
    return this._with(pathAddCombinator(this._op, op))
  }

  pathSubtract(op: PathSubtractOp): BoundUpdateImpl<Model, A, U, E> {
    return this._with(pathSubtractCombinator(this._op, op))
  }

  pathAppend(op: PathAppendOp): BoundUpdateImpl<Model, A, U, E> {
    return this._with(pathAppendCombinator(this._op, op))
  }

  pathPrepend(op: PathPrependOp): BoundUpdateImpl<Model, A, U, E> {
    return this._with(pathPrependCombinator(this._op, op))
  }

  pathIfNotExists(op: PathIfNotExistsOp): BoundUpdateImpl<Model, A, U, E> {
    return this._with(pathIfNotExistsCombinator(this._op, op))
  }

  pathDelete(op: PathDeleteOp): BoundUpdateImpl<Model, A, U, E> {
    return this._with(pathDeleteCombinator(this._op, op))
  }

  asEffect(): Effect.Effect<A, E, never> {
    return this._config.provide(
      (this._op as unknown as { _run: (m: string) => Effect.Effect<A, E, any> })._run("record"),
    )
  }

  [Symbol.iterator]() {
    return new Utils.SingleShotGen(this.asEffect()) as any
  }

  pipe() {
    return Pipeable.pipeArguments(this, arguments)
  }
}

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

/** @internal */
export const makeBoundPut = <Model, A, E>(
  op: EntityPut<A, any, E, any>,
  config: BoundCrudConfig<Model>,
): BoundPut<Model, A, E> => new BoundPutImpl(op, config)

/** @internal */
export const makeBoundDelete = <Model, E>(
  op: EntityDelete<E, any>,
  config: BoundCrudConfig<Model>,
): BoundDelete<Model, E> => new BoundDeleteImpl(op, config)

/** @internal */
export const makeBoundUpdate = <Model, A, U, E>(
  op: EntityUpdate<A, any, U, E, any>,
  config: BoundCrudConfig<Model>,
): BoundUpdate<Model, A, U, E> => new BoundUpdateImpl(op, config)
