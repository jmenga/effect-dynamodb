/**
 * @internal Entity operation combinators — terminal functions and update combinators.
 *
 * Extracted from Entity.ts for decomposition. Not part of the public API.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { type Effect, Function as Fn } from "effect"
import type { CascadePartialFailure } from "../Errors.js"
import type { ConditionInput } from "../Expression.js"
import {
  type CascadeConfig,
  type CascadeTarget,
  type EntityDelete,
  EntityDeleteImpl,
  EntityDeleteTypeId,
  type EntityGet,
  EntityGetImpl,
  type EntityOp,
  EntityOpTypeId,
  type EntityPut,
  EntityPutImpl,
  type EntityUpdate,
  EntityUpdateImpl,
  EntityUpdateTypeId,
  type PathAddOp,
  type PathAppendOp,
  type PathDeleteOp,
  type PathIfNotExistsOp,
  type PathPrependOp,
  type PathSetOp,
  type PathSubtractOp,
  type ReturnValuesMode,
} from "./EntityOps.js"
import type { Expr } from "./Expr.js"

// ---------------------------------------------------------------------------
// Terminal functions — select decode mode for EntityOp intermediates
//
// Cast rationale: _run() returns Effect<unknown, E, R> because the decode mode
// is selected at runtime via a string tag. The return type is narrowed to the
// correct A/Rec/Item/Native via the Self extends EntityOp<infer A, ...> pattern.
// The `as any` bridges from the runtime-polymorphic return to the statically-
// inferred type — type safety is guaranteed by the phantom types on EntityOp.
// ---------------------------------------------------------------------------

/** Helper: extract Rec phantom type */
type ExtractRec<T> = T extends EntityOp<any, infer Rec, any, any> ? Rec : never
/** Helper: extract E type */
type ExtractE<T> = T extends EntityOp<any, any, infer E, any> ? E : never
/** Helper: extract R type */
type ExtractR<T> = T extends EntityOp<any, any, any, infer R> ? R : never

/** Decode through model schema (default for yield*). Returns clean model class instance. */
export const asModel = <Self extends EntityOp<any, any, any, any>>(
  self: Self,
): Effect.Effect<
  Self extends EntityOp<infer A, any, any, any> ? A : never,
  ExtractE<Self>,
  ExtractR<Self>
> => self._run("model") as any

/** Decode through record schema (model + system fields). */
export const asRecord = <Self extends EntityOp<any, any, any, any>>(
  self: Self,
): Effect.Effect<ExtractRec<Self>, ExtractE<Self>, ExtractR<Self>> => self._run("record") as any

/** Decode through item schema (model + system + keys + `__edd_e__`). Returns `Record<string, unknown>`. */
export const asItem = <Self extends EntityOp<any, any, any, any>>(
  self: Self,
): Effect.Effect<globalThis.Record<string, unknown>, ExtractE<Self>, ExtractR<Self>> =>
  self._run("item") as any

/** Return raw marshalled DynamoDB format (`Record<string, AttributeValue>`). No decode. */
export const asNative = <Self extends EntityOp<any, any, any, any>>(
  self: Self,
): Effect.Effect<globalThis.Record<string, AttributeValue>, ExtractE<Self>, ExtractR<Self>> =>
  self._run("native") as any

// ---------------------------------------------------------------------------
// Update combinators — dual functions for pipe composition
//
// Cast rationale: Each combinator creates a new EntityUpdateImpl with updated
// state while preserving the phantom type parameters (A, Rec, U, E, R).
// The `_builder as any` is needed because the builder function's generic
// signature doesn't survive reconstruction — the runtime behavior is identical.
// The `as any` on the return bridges from the impl class to the interface type.
// ---------------------------------------------------------------------------

/**
 * Set the fields to update.
 *
 * When updating GSI composite fields, the consumer is responsible for providing ALL
 * composites for that GSI (fetch-merge pattern). If only some composites are provided,
 * `extractComposites` in KeyComposer will throw during GSI key recomposition.
 *
 * When using `Entity.remove()` on a GSI composite attribute, the corresponding GSI
 * key fields (pk/sk) are automatically removed so the item drops out of the sparse index.
 */
export const set: {
  <Updates extends globalThis.Record<string, unknown>>(
    updates: Updates,
  ): <A, Rec, U, E, R>(self: EntityUpdate<A, Rec, U, E, R>) => EntityUpdate<A, Rec, U, E, R>
  <A, Rec, U, E, R>(
    self: EntityUpdate<A, Rec, U, E, R>,
    updates: NoInfer<U>,
  ): EntityUpdate<A, Rec, U, E, R>
} = Fn.dual(
  2,
  <A, Rec, U, E, R>(
    self: EntityUpdate<A, Rec, U, E, R>,
    updates: unknown,
  ): EntityUpdate<A, Rec, U, E, R> => {
    return new EntityUpdateImpl<A, Rec, U, E, R>(
      self._builder as any,
      { ...self._updateState, updates },
      self._entity,
      self._key,
    ) as any
  },
)

/** Set the expected version for optimistic locking. */
export const expectedVersion: {
  (
    version: number,
  ): <A, Rec, U, E, R>(self: EntityUpdate<A, Rec, U, E, R>) => EntityUpdate<A, Rec, U, E, R>
  <A, Rec, U, E, R>(
    self: EntityUpdate<A, Rec, U, E, R>,
    version: number,
  ): EntityUpdate<A, Rec, U, E, R>
} = Fn.dual(
  2,
  <A, Rec, U, E, R>(
    self: EntityUpdate<A, Rec, U, E, R>,
    version: number,
  ): EntityUpdate<A, Rec, U, E, R> => {
    return new EntityUpdateImpl(
      self._builder as any,
      { ...self._updateState, expectedVersion: version },
      self._entity,
      self._key,
    )
  },
)

/**
 * Enable consistent reads on an EntityGet operation.
 * Call with no arguments to enable (defaults to true).
 */
export const consistentRead: {
  (): <A, Rec, E, R>(self: EntityGet<A, Rec, E, R>) => EntityGet<A, Rec, E, R>
  <A, Rec, E, R>(self: EntityGet<A, Rec, E, R>): EntityGet<A, Rec, E, R>
} = Fn.dual(
  (args) =>
    args.length >= 1 &&
    typeof args[0] === "object" &&
    args[0] !== null &&
    EntityOpTypeId in (args[0] as object),
  <A, Rec, E, R>(self: EntityGet<A, Rec, E, R>): EntityGet<A, Rec, E, R> => {
    const impl = self as unknown as EntityGetImpl<A, Rec, E, R>
    return new EntityGetImpl<A, Rec, E, R>(
      impl._builder,
      impl._entity,
      impl._key,
      true,
    ) as unknown as EntityGet<A, Rec, E, R>
  },
)

/**
 * Select specific attributes to return (ProjectionExpression) on an EntityGet.
 * When projection is active, the result is a raw `Record<string, unknown>`
 * instead of a decoded schema instance, since projected items may be partial.
 */
export const project: {
  (
    attributes: ReadonlyArray<string>,
  ): <A, Rec, E, R>(
    self: EntityGet<A, Rec, E, R>,
  ) => EntityGet<globalThis.Record<string, unknown>, globalThis.Record<string, unknown>, E, R>
  <A, Rec, E, R>(
    self: EntityGet<A, Rec, E, R>,
    attributes: ReadonlyArray<string>,
  ): EntityGet<globalThis.Record<string, unknown>, globalThis.Record<string, unknown>, E, R>
} = Fn.dual(
  2,
  <A, Rec, E, R>(
    self: EntityGet<A, Rec, E, R>,
    attributes: ReadonlyArray<string>,
  ): EntityGet<globalThis.Record<string, unknown>, globalThis.Record<string, unknown>, E, R> => {
    const impl = self as unknown as EntityGetImpl<A, Rec, E, R>
    return new EntityGetImpl<
      globalThis.Record<string, unknown>,
      globalThis.Record<string, unknown>,
      E,
      R
    >(
      impl._builder as any,
      impl._entity,
      impl._key,
      impl._consistentRead,
      attributes,
    ) as unknown as EntityGet<
      globalThis.Record<string, unknown>,
      globalThis.Record<string, unknown>,
      E,
      R
    >
  },
)

// Cast rationale (condition combinator): The condition combinator returns `T`
// (the same operation type) but internally downcasts to the impl class to access
// private fields, then reconstructs with the condition applied. The `as unknown as T`
// casts bridge from the concrete impl back to the polymorphic interface type.
// This preserves the caller's original type while adding condition behavior.

/** @internal Helper type for condition-compatible operations */
type ConditionTarget =
  | EntityPut<any, any, any, any>
  | EntityUpdate<any, any, any, any, any>
  | EntityDelete<any, any>

/**
 * Add a condition expression to a put, update, or delete operation.
 * The condition is evaluated server-side by DynamoDB. If it fails,
 * the operation returns a `ConditionalCheckFailed` error.
 *
 * Accepts either a `ConditionInput` shorthand or a compiled `Expr` node.
 * For updates, the user condition is ANDed with any optimistic lock condition.
 */
export const condition: {
  (cond: Expr | ConditionInput): <T extends ConditionTarget>(self: T) => T
  <T extends ConditionTarget>(self: T, cond: Expr | ConditionInput): T
} = Fn.dual(2, <T extends ConditionTarget>(self: T, cond: Expr | ConditionInput): T => {
  if (EntityDeleteTypeId in self) {
    // EntityDelete
    const impl = self as unknown as EntityDeleteImpl<any, any>
    return new EntityDeleteImpl(
      impl._builder,
      impl._entity,
      impl._key,
      cond,
      impl._returnValues,
    ) as unknown as T
  }
  if (EntityUpdateTypeId in self) {
    // EntityUpdate
    const impl = self as unknown as EntityUpdateImpl<any, any, any, any, any>
    return new EntityUpdateImpl(
      impl._builder,
      { ...impl._updateState, condition: cond },
      impl._entity,
      impl._key,
    ) as unknown as T
  }
  // EntityPut
  const impl = self as unknown as EntityPutImpl<any, any, any, any>
  return new EntityPutImpl(impl._builder, impl._entity, impl._input, cond) as unknown as T
})

/** @internal Helper type for returnValues-compatible operations */
type ReturnValuesTarget = EntityUpdate<any, any, any, any, any> | EntityDelete<any, any>

/**
 * Set the DynamoDB `ReturnValues` mode on an update or delete operation.
 *
 * Modes:
 * - `"none"` — return nothing (default for delete)
 * - `"allOld"` — return the item as it was before the operation
 * - `"allNew"` — return the item as it is after the operation (default for update)
 * - `"updatedOld"` — return only the updated attributes, with old values
 * - `"updatedNew"` — return only the updated attributes, with new values
 *
 * For deletes, only `"none"` and `"allOld"` are valid DynamoDB modes.
 */
export const returnValues: {
  (mode: ReturnValuesMode): <T extends ReturnValuesTarget>(self: T) => T
  <T extends ReturnValuesTarget>(self: T, mode: ReturnValuesMode): T
} = Fn.dual(2, <T extends ReturnValuesTarget>(self: T, mode: ReturnValuesMode): T => {
  if (EntityDeleteTypeId in self) {
    const impl = self as unknown as EntityDeleteImpl<any, any>
    return new EntityDeleteImpl(
      impl._builder,
      impl._entity,
      impl._key,
      impl._condition,
      mode,
    ) as unknown as T
  }
  // EntityUpdate
  const impl = self as unknown as EntityUpdateImpl<any, any, any, any, any>
  return new EntityUpdateImpl(
    impl._builder,
    { ...impl._updateState, returnValues: mode },
    impl._entity,
    impl._key,
  ) as unknown as T
})

/**
 * Remove one or more attributes from the item.
 * Produces a DynamoDB `REMOVE` clause.
 */
export const remove: {
  (
    fields: ReadonlyArray<string>,
  ): <A, Rec, U, E, R>(self: EntityUpdate<A, Rec, U, E, R>) => EntityUpdate<A, Rec, U, E, R>
  <A, Rec, U, E, R>(
    self: EntityUpdate<A, Rec, U, E, R>,
    fields: ReadonlyArray<string>,
  ): EntityUpdate<A, Rec, U, E, R>
} = Fn.dual(
  2,
  <A, Rec, U, E, R>(
    self: EntityUpdate<A, Rec, U, E, R>,
    fields: ReadonlyArray<string>,
  ): EntityUpdate<A, Rec, U, E, R> => {
    const existing = self._updateState.remove ?? []
    return new EntityUpdateImpl<A, Rec, U, E, R>(
      self._builder as any,
      { ...self._updateState, remove: [...existing, ...fields] },
      self._entity,
      self._key,
    ) as any
  },
)

/**
 * Atomically add numeric values to attributes.
 * Produces a DynamoDB `ADD` clause. If the attribute doesn't exist,
 * it is initialized to the provided value.
 */
export const add: {
  (
    values: globalThis.Record<string, number>,
  ): <A, Rec, U, E, R>(self: EntityUpdate<A, Rec, U, E, R>) => EntityUpdate<A, Rec, U, E, R>
  <A, Rec, U, E, R>(
    self: EntityUpdate<A, Rec, U, E, R>,
    values: globalThis.Record<string, number>,
  ): EntityUpdate<A, Rec, U, E, R>
} = Fn.dual(
  2,
  <A, Rec, U, E, R>(
    self: EntityUpdate<A, Rec, U, E, R>,
    values: globalThis.Record<string, number>,
  ): EntityUpdate<A, Rec, U, E, R> => {
    const existing = self._updateState.add ?? {}
    return new EntityUpdateImpl<A, Rec, U, E, R>(
      self._builder as any,
      { ...self._updateState, add: { ...existing, ...values } },
      self._entity,
      self._key,
    ) as any
  },
)

/**
 * Subtract numeric values from attributes.
 * Synthesizes `SET #field = #field - :val` (DynamoDB has no native SUBTRACT).
 */
export const subtract: {
  (
    values: globalThis.Record<string, number>,
  ): <A, Rec, U, E, R>(self: EntityUpdate<A, Rec, U, E, R>) => EntityUpdate<A, Rec, U, E, R>
  <A, Rec, U, E, R>(
    self: EntityUpdate<A, Rec, U, E, R>,
    values: globalThis.Record<string, number>,
  ): EntityUpdate<A, Rec, U, E, R>
} = Fn.dual(
  2,
  <A, Rec, U, E, R>(
    self: EntityUpdate<A, Rec, U, E, R>,
    values: globalThis.Record<string, number>,
  ): EntityUpdate<A, Rec, U, E, R> => {
    const existing = self._updateState.subtract ?? {}
    return new EntityUpdateImpl<A, Rec, U, E, R>(
      self._builder as any,
      { ...self._updateState, subtract: { ...existing, ...values } },
      self._entity,
      self._key,
    ) as any
  },
)

/**
 * Append elements to list attributes.
 * Synthesizes `SET #field = list_append(#field, :val)`.
 */
export const append: {
  (
    values: globalThis.Record<string, ReadonlyArray<unknown>>,
  ): <A, Rec, U, E, R>(self: EntityUpdate<A, Rec, U, E, R>) => EntityUpdate<A, Rec, U, E, R>
  <A, Rec, U, E, R>(
    self: EntityUpdate<A, Rec, U, E, R>,
    values: globalThis.Record<string, ReadonlyArray<unknown>>,
  ): EntityUpdate<A, Rec, U, E, R>
} = Fn.dual(
  2,
  <A, Rec, U, E, R>(
    self: EntityUpdate<A, Rec, U, E, R>,
    values: globalThis.Record<string, ReadonlyArray<unknown>>,
  ): EntityUpdate<A, Rec, U, E, R> => {
    const existing = self._updateState.append ?? {}
    return new EntityUpdateImpl<A, Rec, U, E, R>(
      self._builder as any,
      { ...self._updateState, append: { ...existing, ...values } },
      self._entity,
      self._key,
    ) as any
  },
)

/**
 * Delete elements from a set attribute.
 * Produces a DynamoDB `DELETE` clause.
 * The value should be a set (e.g., `{ tags: new Set(["old"]) }`).
 */
export const deleteFromSet: {
  (
    values: globalThis.Record<string, unknown>,
  ): <A, Rec, U, E, R>(self: EntityUpdate<A, Rec, U, E, R>) => EntityUpdate<A, Rec, U, E, R>
  <A, Rec, U, E, R>(
    self: EntityUpdate<A, Rec, U, E, R>,
    values: globalThis.Record<string, unknown>,
  ): EntityUpdate<A, Rec, U, E, R>
} = Fn.dual(
  2,
  <A, Rec, U, E, R>(
    self: EntityUpdate<A, Rec, U, E, R>,
    values: globalThis.Record<string, unknown>,
  ): EntityUpdate<A, Rec, U, E, R> => {
    const existing = self._updateState.deleteFromSet ?? {}
    return new EntityUpdateImpl<A, Rec, U, E, R>(
      self._builder as any,
      { ...self._updateState, deleteFromSet: { ...existing, ...values } },
      self._entity,
      self._key,
    ) as any
  },
)

/**
 * Configure cascade updates to propagate source entity changes to target entities
 * that embed it via `DynamoModel.ref`. After the source update completes, all matching
 * target items are queried via their cascade GSI and updated with the new domain data.
 *
 * Default mode is "eventual" (batch updates, no item limit).
 * Use `mode: "transactional"` for atomic cascade (max 100 items).
 */
export const cascade: {
  (config: {
    readonly targets: ReadonlyArray<CascadeTarget>
    readonly filter?: globalThis.Record<string, unknown> | undefined
    readonly mode?: "eventual" | "transactional" | undefined
  }): <A, Rec, U, E, R>(
    self: EntityUpdate<A, Rec, U, E | CascadePartialFailure, R>,
  ) => EntityUpdate<A, Rec, U, E | CascadePartialFailure, R>
  <A, Rec, U, E, R>(
    self: EntityUpdate<A, Rec, U, E, R>,
    config: {
      readonly targets: ReadonlyArray<CascadeTarget>
      readonly filter?: globalThis.Record<string, unknown> | undefined
      readonly mode?: "eventual" | "transactional" | undefined
    },
  ): EntityUpdate<A, Rec, U, E | CascadePartialFailure, R>
} = Fn.dual(
  2,
  <A, Rec, U, E, R>(
    self: EntityUpdate<A, Rec, U, E, R>,
    config: CascadeConfig,
  ): EntityUpdate<A, Rec, U, E | CascadePartialFailure, R> => {
    return new EntityUpdateImpl<A, Rec, U, E | CascadePartialFailure, R>(
      self._builder as any,
      { ...self._updateState, cascade: config },
      self._entity,
      self._key,
    ) as any
  },
)

// ---------------------------------------------------------------------------
// Path-based update combinators (internal — used by entity-level typed combinators)
// ---------------------------------------------------------------------------

/** @internal Append an operation to a path-based update state array field. */
const addPathOp = <A, Rec, U, E, R>(
  self: EntityUpdate<A, Rec, U, E, R>,
  key: keyof import("./EntityOps.js").UpdateState,
  op: unknown,
): EntityUpdate<A, Rec, U, E, R> => {
  const existing = (self._updateState[key] as ReadonlyArray<unknown> | undefined) ?? []
  return new EntityUpdateImpl<A, Rec, U, E, R>(
    self._builder as any,
    { ...self._updateState, [key]: [...existing, op] },
    self._entity,
    self._key,
  ) as any
}

/** @internal Add a path-based SET operation to the update state */
export const pathSet = <A, Rec, U, E, R>(
  self: EntityUpdate<A, Rec, U, E, R>,
  op: PathSetOp,
): EntityUpdate<A, Rec, U, E, R> => addPathOp(self, "pathSets", op)

/** @internal Add a path-based REMOVE operation to the update state */
export const pathRemove = <A, Rec, U, E, R>(
  self: EntityUpdate<A, Rec, U, E, R>,
  segments: ReadonlyArray<string | number>,
): EntityUpdate<A, Rec, U, E, R> => addPathOp(self, "pathRemoves", segments)

/** @internal Add a path-based ADD operation to the update state */
export const pathAdd = <A, Rec, U, E, R>(
  self: EntityUpdate<A, Rec, U, E, R>,
  op: PathAddOp,
): EntityUpdate<A, Rec, U, E, R> => addPathOp(self, "pathAdds", op)

/** @internal Add a path-based SUBTRACT operation to the update state */
export const pathSubtract = <A, Rec, U, E, R>(
  self: EntityUpdate<A, Rec, U, E, R>,
  op: PathSubtractOp,
): EntityUpdate<A, Rec, U, E, R> => addPathOp(self, "pathSubtracts", op)

/** @internal Add a path-based APPEND operation to the update state */
export const pathAppend = <A, Rec, U, E, R>(
  self: EntityUpdate<A, Rec, U, E, R>,
  op: PathAppendOp,
): EntityUpdate<A, Rec, U, E, R> => addPathOp(self, "pathAppends", op)

/** @internal Add a path-based PREPEND operation to the update state */
export const pathPrepend = <A, Rec, U, E, R>(
  self: EntityUpdate<A, Rec, U, E, R>,
  op: PathPrependOp,
): EntityUpdate<A, Rec, U, E, R> => addPathOp(self, "pathPrepends", op)

/** @internal Add a path-based if_not_exists operation to the update state */
export const pathIfNotExists = <A, Rec, U, E, R>(
  self: EntityUpdate<A, Rec, U, E, R>,
  op: PathIfNotExistsOp,
): EntityUpdate<A, Rec, U, E, R> => addPathOp(self, "pathIfNotExists", op)

/** @internal Add a path-based DELETE (set removal) operation to the update state */
export const pathDelete = <A, Rec, U, E, R>(
  self: EntityUpdate<A, Rec, U, E, R>,
  op: PathDeleteOp,
): EntityUpdate<A, Rec, U, E, R> => addPathOp(self, "pathDeletes", op)
