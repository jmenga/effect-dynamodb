/**
 * @internal Entity operation intermediates — lazy, pipeable, effectable.
 *
 * Extracted from Entity.ts for decomposition. Not part of the public API.
 */

import type { ReturnValue } from "@aws-sdk/client-dynamodb"
import type { Effect } from "effect"
import { Pipeable, Utils } from "effect"
import type * as DynamoSchema from "../DynamoSchema.js"
import type { ConditionInput } from "../Expression.js"
import type { Expr } from "../internal/Expr.js"
import type { IndexDefinition } from "../KeyComposer.js"
import type { TableConfig } from "../Table.js"

// ---------------------------------------------------------------------------
// TypeId symbols
// ---------------------------------------------------------------------------

/** @internal */
export const EntityOpTypeId: unique symbol = Symbol.for("effect-dynamodb/EntityOp")
export type EntityOpTypeId = typeof EntityOpTypeId

/** @internal */
export const EntityUpdateTypeId: unique symbol = Symbol.for("effect-dynamodb/EntityUpdate")
export type EntityUpdateTypeId = typeof EntityUpdateTypeId

/** @internal */
export const EntityDeleteTypeId: unique symbol = Symbol.for("effect-dynamodb/EntityDelete")
export type EntityDeleteTypeId = typeof EntityDeleteTypeId

// ---------------------------------------------------------------------------
// Decode mode and update state types
// ---------------------------------------------------------------------------

export type DecodeMode = "model" | "record" | "item" | "native" | "raw"

/** DynamoDB ReturnValues modes */
export type ReturnValuesMode = "none" | "allOld" | "allNew" | "updatedOld" | "updatedNew"

/** @internal Map from our mode names to DynamoDB ReturnValues strings */
export const returnValuesMap: globalThis.Record<ReturnValuesMode, ReturnValue> = {
  none: "NONE",
  allOld: "ALL_OLD",
  allNew: "ALL_NEW",
  updatedOld: "UPDATED_OLD",
  updatedNew: "UPDATED_NEW",
}

/** @internal Minimal shape needed from cascade target entities */
export interface CascadeTarget {
  readonly entityType: string
  readonly indexes: globalThis.Record<string, IndexDefinition>
  readonly _schema: DynamoSchema.DynamoSchema
  readonly _tableTag: import("effect").Context.Service<TableConfig, TableConfig>
  readonly _resolvedRefs: ReadonlyArray<{
    readonly fieldName: string
    readonly idFieldName: string
    readonly identifierField: string
    readonly refEntityType: string
  }>
}

/** @internal */
export interface CascadeConfig {
  readonly targets: ReadonlyArray<CascadeTarget>
  readonly filter?: globalThis.Record<string, unknown> | undefined
  readonly mode?: "eventual" | "transactional" | undefined
}

/** @internal */
export interface UpdateState {
  readonly updates: unknown
  readonly expectedVersion: number | undefined
  readonly condition: Expr | ConditionInput | undefined
  readonly remove: ReadonlyArray<string> | undefined
  readonly add: globalThis.Record<string, number> | undefined
  readonly subtract: globalThis.Record<string, number> | undefined
  readonly append: globalThis.Record<string, ReadonlyArray<unknown>> | undefined
  readonly deleteFromSet: globalThis.Record<string, unknown> | undefined
  readonly returnValues: ReturnValuesMode | undefined
  readonly cascade: CascadeConfig | undefined
  // Path-based update operations (Phase 3)
  readonly pathSets: ReadonlyArray<PathSetOp> | undefined
  readonly pathRemoves: ReadonlyArray<ReadonlyArray<string | number>> | undefined
  readonly pathAdds: ReadonlyArray<PathAddOp> | undefined
  readonly pathSubtracts: ReadonlyArray<PathSubtractOp> | undefined
  readonly pathAppends: ReadonlyArray<PathAppendOp> | undefined
  readonly pathPrepends: ReadonlyArray<PathPrependOp> | undefined
  readonly pathIfNotExists: ReadonlyArray<PathIfNotExistsOp> | undefined
  readonly pathDeletes: ReadonlyArray<PathDeleteOp> | undefined
}

/** @internal Path-based SET operation */
export interface PathSetOp {
  readonly segments: ReadonlyArray<string | number>
  readonly value: unknown
  readonly isPath: boolean // true if value is a Path (attr-to-attr copy)
  readonly valueSegments?: ReadonlyArray<string | number> // segments when isPath is true
}

/** @internal Path-based ADD operation */
export interface PathAddOp {
  readonly segments: ReadonlyArray<string | number>
  readonly value: unknown
}

/** @internal Path-based SUBTRACT operation */
export interface PathSubtractOp {
  readonly segments: ReadonlyArray<string | number>
  readonly value: unknown
  readonly isPath: boolean
  readonly valueSegments?: ReadonlyArray<string | number>
}

/** @internal Path-based APPEND operation */
export interface PathAppendOp {
  readonly segments: ReadonlyArray<string | number>
  readonly value: unknown
}

/** @internal Path-based PREPEND operation */
export interface PathPrependOp {
  readonly segments: ReadonlyArray<string | number>
  readonly value: unknown
}

/** @internal Path-based if_not_exists operation */
export interface PathIfNotExistsOp {
  readonly segments: ReadonlyArray<string | number>
  readonly value: unknown
}

/** @internal Path-based DELETE (set removal) operation */
export interface PathDeleteOp {
  readonly segments: ReadonlyArray<string | number>
  readonly value: unknown
}

export const emptyUpdateState: UpdateState = {
  updates: undefined,
  expectedVersion: undefined,
  condition: undefined,
  remove: undefined,
  add: undefined,
  subtract: undefined,
  append: undefined,
  deleteFromSet: undefined,
  returnValues: undefined,
  cascade: undefined,
  pathSets: undefined,
  pathRemoves: undefined,
  pathAdds: undefined,
  pathSubtracts: undefined,
  pathAppends: undefined,
  pathPrepends: undefined,
  pathIfNotExists: undefined,
  pathDeletes: undefined,
}

// ---------------------------------------------------------------------------
// Entity operation interfaces
// ---------------------------------------------------------------------------

/**
 * Base interface for lazy Entity operation descriptors.
 * Pipeable (for combinators like `asRecord`, `condition`, etc.) and Yieldable
 * (can be used with `yield*` in `Effect.gen`).
 *
 * @typeParam A - Decoded model type (e.g., `User`)
 * @typeParam Rec - Record type — model fields plus system fields (timestamps, version)
 * @typeParam E - Error channel
 * @typeParam R - Required services
 */
export interface EntityOp<A, Rec, E, R> extends Pipeable.Pipeable {
  readonly [EntityOpTypeId]: EntityOpTypeId
  /** @internal */
  readonly _run: (mode: DecodeMode) => Effect.Effect<any, E, R>
  /** Convert this descriptor to an executable Effect. */
  readonly asEffect: () => Effect.Effect<A, E, R>
  /** Yield support for `Effect.gen`. */
  readonly [Symbol.iterator]: () => Iterator<Effect.Effect<A, E, R>, A>
  /** @internal */ readonly _Rec: (_: never) => Rec
}

/**
 * Lazy intermediate returned by `Entity.get()`.
 * `yield*` returns the model type. Pipe to {@link asRecord}, {@link asItem}, or {@link asNative} for alternate decode modes.
 *
 * @typeParam A - Decoded model type
 * @typeParam Rec - Record type (model + system fields)
 * @typeParam E - Error channel
 * @typeParam R - Required services
 */
export interface EntityGet<A, Rec, E, R> extends EntityOp<A, Rec, E, R> {}

/**
 * Lazy intermediate returned by `Entity.put()`.
 * `yield*` returns the model type. Pipe to {@link asRecord}, {@link asItem}, or {@link asNative} for alternate decode modes.
 *
 * @typeParam A - Decoded model type
 * @typeParam Rec - Record type (model + system fields)
 * @typeParam E - Error channel
 * @typeParam R - Required services
 */
export interface EntityPut<A, Rec, E, R> extends EntityOp<A, Rec, E, R> {}

/**
 * Lazy intermediate returned by `Entity.update()`.
 * `yield*` returns the model type. Pipe to {@link asRecord}, {@link asItem}, or {@link asNative} for alternate decode modes.
 * Supports {@link set} and {@link expectedVersion} combinators via pipe.
 *
 * @typeParam A - Decoded model type
 * @typeParam Rec - Record type (model + system fields)
 * @typeParam U - Update payload type (partial model minus keys, with GSI all-or-none constraints)
 * @typeParam E - Error channel
 * @typeParam R - Required services
 */
export interface EntityUpdate<A, Rec, U, E, R> extends EntityOp<A, Rec, E, R> {
  readonly [EntityUpdateTypeId]: EntityUpdateTypeId
  /** @internal phantom */ readonly _U: (_: never) => U
  /** @internal */
  readonly _updateState: UpdateState
  /** @internal */
  readonly _builder: (mode: DecodeMode, state: UpdateState) => Effect.Effect<any, E, R>
  /** @internal */
  readonly _entity: EntityBase
  /** @internal */
  readonly _key: globalThis.Record<string, unknown>
}

/**
 * Lazy descriptor returned by Entity.delete().
 * Carries entity + key for Transaction/Batch extraction.
 * Does NOT extend EntityOp (no decode mode — delete returns void).
 * Yieldable in `Effect.gen`.
 */
export interface EntityDelete<E, R> extends Pipeable.Pipeable {
  readonly [EntityDeleteTypeId]: EntityDeleteTypeId
  /** Convert this descriptor to an executable Effect. */
  readonly asEffect: () => Effect.Effect<void, E, R>
  /** Yield support for `Effect.gen`. */
  readonly [Symbol.iterator]: () => Iterator<Effect.Effect<void, E, R>, void>
  /** @internal */ readonly _opType: "delete"
  /** @internal */ readonly _entity: EntityBase
  /** @internal */ readonly _key: globalThis.Record<string, unknown>
}

/**
 * @internal Minimal entity shape used by operation intermediates.
 * Avoids circular dependency with the full Entity interface.
 */
export interface EntityBase {
  readonly _tag: "Entity"
}

// ---------------------------------------------------------------------------
// Entity operation implementation classes
// ---------------------------------------------------------------------------

export interface EntityGetOpts {
  readonly consistentRead: boolean
  readonly projection: ReadonlyArray<string> | undefined
}

export class EntityGetImpl<A, Rec, E, R> implements Pipeable.Pipeable {
  readonly [EntityOpTypeId]: EntityOpTypeId = EntityOpTypeId as EntityOpTypeId
  readonly _opType = "get" as const
  declare readonly _Rec: (_: never) => Rec
  readonly _entity: EntityBase
  readonly _key: globalThis.Record<string, unknown>
  readonly _consistentRead: boolean
  readonly _projection: ReadonlyArray<string> | undefined
  constructor(
    readonly _builder: (mode: DecodeMode, opts: EntityGetOpts) => Effect.Effect<any, E, R>,
    entity: EntityBase,
    key: globalThis.Record<string, unknown>,
    consistentRead?: boolean,
    projection?: ReadonlyArray<string>,
  ) {
    this._entity = entity
    this._key = key
    this._consistentRead = consistentRead ?? false
    this._projection = projection
  }
  get _run(): (mode: DecodeMode) => Effect.Effect<any, E, R> {
    return (mode) =>
      this._builder(this._projection ? "raw" : mode, {
        consistentRead: this._consistentRead,
        projection: this._projection,
      })
  }
  asEffect(): Effect.Effect<A, E, R> {
    return this._run("model") as Effect.Effect<A, E, R>
  }
  [Symbol.iterator]() {
    return new Utils.SingleShotGen(this.asEffect()) as any
  }

  pipe() {
    return Pipeable.pipeArguments(this, arguments)
  }
}

export class EntityPutImpl<A, Rec, E, R> implements Pipeable.Pipeable {
  readonly [EntityOpTypeId]: EntityOpTypeId = EntityOpTypeId as EntityOpTypeId
  readonly _opType = "put" as const
  declare readonly _Rec: (_: never) => Rec
  readonly _entity: EntityBase
  readonly _input: globalThis.Record<string, unknown>
  readonly _condition: Expr | ConditionInput | undefined
  constructor(
    readonly _builder: (
      mode: DecodeMode,
      opts: { readonly condition: Expr | ConditionInput | undefined },
    ) => Effect.Effect<any, E, R>,
    entity: EntityBase,
    input: globalThis.Record<string, unknown>,
    condition?: Expr | ConditionInput | undefined,
  ) {
    this._entity = entity
    this._input = input
    this._condition = condition
  }
  get _run(): (mode: DecodeMode) => Effect.Effect<any, E, R> {
    return (mode) => this._builder(mode, { condition: this._condition })
  }
  asEffect(): Effect.Effect<A, E, R> {
    return this._run("model") as Effect.Effect<A, E, R>
  }
  [Symbol.iterator]() {
    return new Utils.SingleShotGen(this.asEffect()) as any
  }

  pipe() {
    return Pipeable.pipeArguments(this, arguments)
  }
}

export class EntityUpdateImpl<A, Rec, U, E, R> implements Pipeable.Pipeable {
  readonly [EntityOpTypeId]: EntityOpTypeId = EntityOpTypeId as EntityOpTypeId
  readonly [EntityUpdateTypeId]: EntityUpdateTypeId = EntityUpdateTypeId as EntityUpdateTypeId
  readonly _opType = "update" as const
  declare readonly _Rec: (_: never) => Rec
  declare readonly _U: (_: never) => U
  readonly _entity: EntityBase
  readonly _key: globalThis.Record<string, unknown>
  constructor(
    readonly _builder: (mode: DecodeMode, state: UpdateState) => Effect.Effect<any, E, R>,
    readonly _updateState: UpdateState,
    entity: EntityBase,
    key: globalThis.Record<string, unknown>,
  ) {
    this._entity = entity
    this._key = key
  }
  get _run(): (mode: DecodeMode) => Effect.Effect<any, E, R> {
    return (mode) => this._builder(mode, this._updateState)
  }
  asEffect(): Effect.Effect<A, E, R> {
    return this._run("model") as Effect.Effect<A, E, R>
  }
  [Symbol.iterator]() {
    return new Utils.SingleShotGen(this.asEffect()) as any
  }

  pipe() {
    return Pipeable.pipeArguments(this, arguments)
  }
}

export class EntityDeleteImpl<E, R> implements Pipeable.Pipeable {
  readonly [EntityDeleteTypeId]: EntityDeleteTypeId = EntityDeleteTypeId as EntityDeleteTypeId
  readonly _opType = "delete" as const
  readonly _entity: EntityBase
  readonly _key: globalThis.Record<string, unknown>
  readonly _condition: Expr | ConditionInput | undefined
  readonly _returnValues: ReturnValuesMode | undefined
  constructor(
    readonly _builder: (opts: {
      readonly condition: Expr | ConditionInput | undefined
      readonly returnValues: ReturnValuesMode | undefined
    }) => Effect.Effect<void, E, R>,
    entity: EntityBase,
    key: globalThis.Record<string, unknown>,
    condition?: Expr | ConditionInput | undefined,
    returnValues?: ReturnValuesMode | undefined,
  ) {
    this._entity = entity
    this._key = key
    this._condition = condition
    this._returnValues = returnValues
  }
  asEffect(): Effect.Effect<void, E, R> {
    return this._builder({ condition: this._condition, returnValues: this._returnValues })
  }
  [Symbol.iterator]() {
    return new Utils.SingleShotGen(this.asEffect()) as any
  }

  pipe() {
    return Pipeable.pipeArguments(this, arguments)
  }
}
