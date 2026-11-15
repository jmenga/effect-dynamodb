/**
 * @internal Entity operation combinators — terminal functions and update combinators.
 *
 * Extracted from Entity.ts for decomposition. Not part of the public API.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import type {
  CascadePartialFailure,
  ConditionalCheckFailed,
} from "@effect-dynamodb/schema/Errors.js"
import type { OffloadMode } from "@effect-dynamodb/schema/internal/EntityTypes.js"
import { type Effect, Function as Fn } from "effect"
import type { ConditionInput } from "../Expression.js"
import type { OffloadModes, OffloadState, View, ViewOf } from "../Offload.js"
import {
  type AddOperand,
  type CascadeConfig,
  type CascadeTarget,
  carryModes,
  type EntityDelete,
  EntityDeleteImpl,
  EntityDeleteTypeId,
  type EntityGet,
  EntityGetImpl,
  type EntityInsert,
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
  type UpdateReturn,
} from "./EntityOps.js"
import { type Expr, nonEmptyCondition, toExpr } from "./Expr.js"
import { DEFAULT_MODES, parseModes } from "./OffloadRead.js"
import type {
  OpBase,
  OpOffloadedErrors,
  OpWithItem,
  OpWithModes,
  RecordViewOf,
} from "./OffloadTypes.js"
import { type PackedAttributeGuard, packedExprRefusal, packedProjectionRefusal } from "./Packed.js"

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
type ExtractRec<T> = T extends EntityOp<any, infer Rec, any, any, any> ? Rec : never
/** Helper: extract E type */
type ExtractE<T> = T extends EntityOp<any, any, infer E, any, any> ? E : never
/** Helper: extract R type */
type ExtractR<T> = T extends EntityOp<any, any, any, infer R, any> ? R : never

/** `undefined` for an update set to `returnValues("none")`, else `Full`. */
type NoneOr<Self, Full> = 0 extends 1 & ExtractRec<Self>
  ? Full
  : [ExtractRec<Self>] extends [undefined]
    ? undefined
    : Full

/** Decode through model schema (default for yield*). Returns clean model class instance. */
export const asModel = <Self extends EntityOp<any, any, any, any, any>>(
  self: Self,
): Effect.Effect<
  Self extends EntityOp<infer A, any, any, any, any> ? A : never,
  ExtractE<Self>,
  ExtractR<Self>
> => self._exec("model") as any

/** Decode through record schema (model + system fields). */
export const asRecord = <Self extends EntityOp<any, any, any, any, any>>(
  self: Self,
): Effect.Effect<ExtractRec<Self>, ExtractE<Self>, ExtractR<Self>> => self._exec("record") as any

/** Decode through item schema (model + system + keys + `__edd_e__`). Returns `Record<string, unknown>`. */
export const asItem = <Self extends EntityOp<any, any, any, any, any>>(
  self: Self,
): Effect.Effect<
  NoneOr<Self, globalThis.Record<string, unknown>>,
  ExtractE<Self>,
  ExtractR<Self>
> => self._exec("item") as any

/** Return raw marshalled DynamoDB format (`Record<string, AttributeValue>`). No decode. */
export const asNative = <Self extends EntityOp<any, any, any, any, any>>(
  self: Self,
): Effect.Effect<
  NoneOr<Self, globalThis.Record<string, AttributeValue>>,
  ExtractE<Self>,
  ExtractR<Self>
> => self._exec("native") as any

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
 * Any subset of a GSI's composites may be set: GSI keys are recomposed per half
 * (`DESIGN.md` §7). A half whose composites are given is recomposed — truncated
 * to the leading composites given, where that loses nothing; a half the update
 * does not touch is left as stored; a half it touches but cannot compose follows
 * the index's policy (`'sparse'` removes the key, `'preserve'` leaves it).
 *
 * When using `Entity.remove()` on a GSI composite attribute, the key of the half
 * holding it is removed (per half, not the whole GSI) so the item drops out of
 * the sparse index, unless the rest of the update recomposes a prefix.
 */
export const set: {
  <Updates extends globalThis.Record<string, unknown>>(
    updates: Updates,
  ): <A, Rec, U, E, R, O extends OffloadState>(
    self: EntityUpdate<A, Rec, U, E, R, O>,
  ) => EntityUpdate<A, Rec, U, E, R, O>
  <A, Rec, U, E, R, O extends OffloadState>(
    self: EntityUpdate<A, Rec, U, E, R, O>,
    updates: NoInfer<U>,
  ): EntityUpdate<A, Rec, U, E, R, O>
} = Fn.dual(
  2,
  <A, Rec, U, E, R, O extends OffloadState>(
    self: EntityUpdate<A, Rec, U, E, R, O>,
    updates: unknown,
  ): EntityUpdate<A, Rec, U, E, R, O> => {
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
  ): <A, Rec, U, E, R, O extends OffloadState>(
    self: EntityUpdate<A, Rec, U, E, R, O>,
  ) => EntityUpdate<A, Rec, U, E, R, O>
  <A, Rec, U, E, R, O extends OffloadState>(
    self: EntityUpdate<A, Rec, U, E, R, O>,
    version: number,
  ): EntityUpdate<A, Rec, U, E, R, O>
} = Fn.dual(
  2,
  <A, Rec, U, E, R, O extends OffloadState>(
    self: EntityUpdate<A, Rec, U, E, R, O>,
    version: number,
  ): EntityUpdate<A, Rec, U, E, R, O> => {
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
  (): <A, Rec, E, R, O extends OffloadState>(
    self: EntityGet<A, Rec, E, R, O>,
  ) => EntityGet<A, Rec, E, R, O>
  <A, Rec, E, R, O extends OffloadState>(
    self: EntityGet<A, Rec, E, R, O>,
  ): EntityGet<A, Rec, E, R, O>
} = Fn.dual(
  (args) =>
    args.length >= 1 &&
    typeof args[0] === "object" &&
    args[0] !== null &&
    EntityOpTypeId in (args[0] as object),
  <A, Rec, E, R, O extends OffloadState>(
    self: EntityGet<A, Rec, E, R, O>,
  ): EntityGet<A, Rec, E, R, O> => {
    const impl = self as unknown as EntityGetImpl<A, Rec, E, R>
    return carryModes(
      impl,
      new EntityGetImpl<A, Rec, E, R>(impl._builder, impl._entity, impl._key, true),
    ) as unknown as EntityGet<A, Rec, E, R, O>
  },
)

/** The type a projected get returns: raw records, whatever the offload modes. */
type Projected<O extends OffloadState> = OpWithItem<
  O,
  globalThis.Record<string, unknown>,
  globalThis.Record<string, unknown>
>

/**
 * Select specific attributes to return (ProjectionExpression) on an EntityGet.
 * When projection is active, the result is a raw `Record<string, unknown>`
 * instead of a decoded schema instance, since projected items may be partial.
 */
export const project: {
  (
    attributes: ReadonlyArray<string>,
  ): <A, Rec, E, R, O extends OffloadState>(
    self: EntityGet<A, Rec, E, R, O>,
  ) => EntityGet<
    globalThis.Record<string, unknown>,
    globalThis.Record<string, unknown>,
    E,
    R,
    Projected<O>
  >
  <A, Rec, E, R, O extends OffloadState>(
    self: EntityGet<A, Rec, E, R, O>,
    attributes: ReadonlyArray<string>,
  ): EntityGet<
    globalThis.Record<string, unknown>,
    globalThis.Record<string, unknown>,
    E,
    R,
    Projected<O>
  >
} = Fn.dual(
  2,
  <A, Rec, E, R, O extends OffloadState>(
    self: EntityGet<A, Rec, E, R, O>,
    attributes: ReadonlyArray<string>,
  ): EntityGet<
    globalThis.Record<string, unknown>,
    globalThis.Record<string, unknown>,
    E,
    R,
    Projected<O>
  > => {
    const impl = self as unknown as EntityGetImpl<A, Rec, E, R>
    // A packed field may be projected only whole (`[EDD-9076]`, #147).
    const guards = (impl._entity as { readonly _packedGuards?: unknown } | undefined)
      ?._packedGuards as ReadonlyArray<PackedAttributeGuard> | undefined
    const refused = packedProjectionRefusal(
      attributes.map((attribute) => [attribute]),
      guards ?? [],
    )
    if (refused !== undefined) throw new Error(refused)
    return carryModes(
      impl,
      new EntityGetImpl<
        globalThis.Record<string, unknown>,
        globalThis.Record<string, unknown>,
        E,
        R
      >(impl._builder as any, impl._entity, impl._key, impl._consistentRead, attributes),
    ) as unknown as EntityGet<
      globalThis.Record<string, unknown>,
      globalThis.Record<string, unknown>,
      E,
      R,
      Projected<O>
    >
  },
)

// Cast rationale (condition combinator): The condition combinator returns `T`
// (the same operation type) but internally downcasts to the impl class to access
// private fields, then reconstructs with the condition applied. The `as unknown as T`
// casts bridge from the concrete impl back to the polymorphic interface type.
// This preserves the caller's original type while adding condition behavior.

/** @internal Helper type for condition-compatible operations */
export type ConditionTarget =
  | EntityPut<any, any, any, any, any>
  | EntityUpdate<any, any, any, any, any, any>
  | EntityDelete<any, any, any, any, any>

/**
 * Widen a condition-capable operation's error channel with
 * {@link ConditionalCheckFailed}.
 *
 * A rejected condition is precisely the failure `.condition(...)` makes
 * reachable, so the type declares it — `Effect.catchTag("ConditionalCheckFailed", ...)`
 * then type-checks. Operations that already carry `ConditionalCheckFailed`
 * (`create`, `patch`, `upsert`, `deleteIfExists`) are unaffected: the union
 * collapses.
 *
 * `EntityUpdate` is matched first because it is structurally assignable to
 * `EntityPut` — checking the looser shape first would silently drop an
 * update's `U` (update payload) parameter.
 *
 * A single generic call signature rather than an overload set: `Pipeable.pipe`
 * infers from the *last* overload of an overloaded argument, which would pin
 * every piped `.condition(...)` to `EntityDelete`.
 */
export type WithConditionalCheckFailed<T> =
  T extends EntityUpdate<infer A, infer Rec, infer U, infer E, infer R, infer O>
    ? EntityUpdate<A, Rec, U, E | ConditionalCheckFailed, R, O>
    : T extends EntityPut<infer A, infer Rec, infer E, infer R, infer O>
      ? EntityPut<A, Rec, E | ConditionalCheckFailed, R, O>
      : T extends EntityDelete<infer E, infer R, infer A, infer Mo, infer O>
        ? EntityDelete<E | ConditionalCheckFailed, R, A, Mo, O>
        : never

/**
 * The data-last pipeable produced by `condition(cond)` — see
 * {@link WithConditionalCheckFailed}.
 */
export type ConditionPipeable = <T extends ConditionTarget>(
  self: T,
) => WithConditionalCheckFailed<T>

/** @internal Whether a condition compiles to nothing (`{}`, `and()`). */

/**
 * Add a condition expression to a put, update, or delete operation.
 * The condition is evaluated server-side by DynamoDB. If it fails,
 * the operation fails with {@link ConditionalCheckFailed} — which this
 * combinator adds to the operation's error channel, so
 * `Effect.catchTag("ConditionalCheckFailed", ...)` type-checks.
 *
 * Accepts either a `ConditionInput` shorthand or a compiled `Expr` node.
 * For updates, the user condition is ANDed with any optimistic lock condition.
 */
export const condition: {
  (cond: Expr | ConditionInput): ConditionPipeable
  <T extends ConditionTarget>(self: T, cond: Expr | ConditionInput): WithConditionalCheckFailed<T>
} = Fn.dual(2, <T extends ConditionTarget>(self: T, given: Expr | ConditionInput): T => {
  // An empty condition (`{}`, `and()`) is no condition (#133): like any later
  // `.condition()`, it replaces an earlier one — with none.
  const cond = nonEmptyCondition(given)
  // A condition may test a packed field only as a whole (`[EDD-9076]`, #147).
  const guards = (self as unknown as { readonly _entity?: { readonly _packedGuards?: unknown } })
    ._entity?._packedGuards as ReadonlyArray<PackedAttributeGuard> | undefined
  if (cond !== undefined && guards !== undefined && guards.length > 0) {
    const refused = packedExprRefusal(toExpr(cond), guards, "condition")
    if (refused !== undefined) throw new Error(refused)
  }
  if (EntityDeleteTypeId in self) {
    // EntityDelete. `deleteIfExists`'s existence check is the op's own guard
    // (`_mustExist`), never its condition: it stays, ANDed with this one.
    const impl = self as unknown as EntityDeleteImpl<any, any>
    return carryModes(
      impl,
      new EntityDeleteImpl(
        impl._builder,
        impl._entity,
        impl._key,
        cond,
        impl._returnValues,
        impl._mustExist,
      ),
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
  // EntityPut — `_putKind` MUST be carried through: it is what tells the
  // transact/batch compilers that an `upsert` is not a plain `Put` (#100).
  const impl = self as unknown as EntityPutImpl<any, any, any, any>
  return carryModes(
    impl,
    new EntityPutImpl(
      impl._builder,
      impl._entity,
      impl._input,
      cond,
      impl._withVectors,
      impl._putKind,
    ),
  ) as unknown as T
})

/** @internal Operations that accept a pre-computed embedding. */
type WithVectorTarget =
  | EntityPut<any, any, any, any, any>
  | EntityInsert<any, any, any, any, any>
  | EntityUpdate<any, any, any, any, any, any>

/**
 * Supply a pre-computed embedding for a named vector index, skipping the
 * `Embedder` for that index on this write.
 *
 * The escape hatch for callers who already hold a vector — a batch re-embedding
 * job, a model whose output is cached, or a test that wants exact control over
 * ranking. `name` is the LOGICAL vector index name declared on `Entity.make`.
 *
 * See `DESIGN.md §14 Write path`.
 */
export const withVector: {
  (name: string, vector: ReadonlyArray<number>): <T extends WithVectorTarget>(self: T) => T
  <T extends WithVectorTarget>(self: T, name: string, vector: ReadonlyArray<number>): T
} = Fn.dual(
  3,
  <T extends WithVectorTarget>(self: T, name: string, vector: ReadonlyArray<number>): T => {
    if (EntityUpdateTypeId in self) {
      const impl = self as unknown as EntityUpdateImpl<any, any, any, any, any>
      return new EntityUpdateImpl(
        impl._builder,
        {
          ...impl._updateState,
          withVectors: { ...(impl._updateState.withVectors ?? {}), [name]: vector },
        },
        impl._entity,
        impl._key,
      ) as unknown as T
    }
    const impl = self as unknown as EntityPutImpl<any, any, any, any>
    return carryModes(
      impl,
      new EntityPutImpl(
        impl._builder,
        impl._entity,
        impl._input,
        impl._condition,
        { ...(impl._withVectors ?? {}), [name]: vector },
        impl._putKind,
      ),
    ) as unknown as T
  },
)

/** @internal Helper type for returnValues-compatible operations */
type ReturnValuesTarget =
  | EntityUpdate<any, any, any, any, any, any>
  | EntityDelete<any, any, any, any, any>

/**
 * An update's result type under a `returnValues` mode — see {@link UpdateReturn}.
 * A delete returns the item it deleted under `"allOld"` (`undefined` when
 * there was none), and nothing otherwise.
 */
export type ReturnValuesResult<T, M extends ReturnValuesMode> =
  T extends EntityUpdate<infer A, infer Rec, infer U, infer E, infer R, infer O>
    ? typeof UpdateBaseTypeId extends keyof U
      ? U extends UpdateBase<infer BA, infer BR>
        ? EntityUpdate<UpdateReturn<BA, M>, UpdateReturn<BR, M>, U, E, R, ReturnState<O, M>>
        : never
      : EntityUpdate<
          UpdateReturn<A, M>,
          UpdateReturn<Rec, M>,
          U & UpdateBase<A, Rec>,
          E,
          R,
          ReturnState<O, M>
        >
    : T extends EntityDelete<infer E, infer R, any, infer Mo, infer O>
      ? EntityDelete<
          E,
          R,
          M extends "allOld" ? DeletedView<O, Mo> | undefined : void,
          Mo,
          DeleteReturnState<O, M>
        >
      : T

/** The item an `"allOld"` delete returns: its view under the delete's modes (#179). */
type DeletedView<O extends OffloadState, Mo> = [
  O["fields"]["overflow"] | O["fields"]["binary"],
] extends [never]
  ? Mo
  : View<Mo, O["fields"], O["modes"]>

/**
 * An update's offload state under a `returnValues` mode: it reads the mode's
 * share of the model / record it was made over (#179). Unchanged for a
 * member that offloads nothing.
 */
type ReturnState<O extends OffloadState, M extends ReturnValuesMode> = OpWithItem<
  O,
  UpdateReturn<OpBase<O>[0], M>,
  UpdateReturn<OpBase<O>[1], M>
>
/** A delete's offload state under a `returnValues` mode. */
type DeleteReturnState<O extends OffloadState, M extends ReturnValuesMode> = OpWithItem<
  O,
  M extends "allOld" ? OpBase<O>[0] | undefined : undefined,
  M extends "allOld" ? OpBase<O>[0] | undefined : undefined
>

/**
 * @internal The model / record types an update returned before its first
 * `returnValues`, carried on the (phantom) payload type so a later
 * `returnValues` derives from them, not from the previous mode's result.
 */
declare const UpdateBaseTypeId: unique symbol
/** @internal */
export interface UpdateBase<A, Rec> {
  readonly [UpdateBaseTypeId]?: (_: never) => readonly [A, Rec]
}

/**
 * Set the DynamoDB `ReturnValues` mode on an update or delete operation.
 *
 * Modes:
 * - `"none"` — return nothing (default for delete)
 * - `"allOld"` — return the item as it was before the operation
 * - `"allNew"` — return the item as it is after the operation (default for update)
 * - `"updatedOld"` — return only the top-level attributes the update wrote, with
 *   their old values, decoded as a partial
 * - `"updatedNew"` — the same attributes with their new values
 *
 * An update's result type follows the mode (`undefined` for `"none"`, a
 * `Partial` for the `updated*` modes). For deletes, only `"none"` and
 * `"allOld"` are valid DynamoDB modes.
 */
export const returnValues: {
  <M extends ReturnValuesMode>(
    mode: M,
  ): <T extends ReturnValuesTarget>(self: T) => ReturnValuesResult<T, M>
  <T extends ReturnValuesTarget, M extends ReturnValuesMode>(
    self: T,
    mode: M,
  ): ReturnValuesResult<T, M>
} = Fn.dual(2, <T extends ReturnValuesTarget>(self: T, mode: ReturnValuesMode): T => {
  if (EntityDeleteTypeId in self) {
    const impl = self as unknown as EntityDeleteImpl<any, any>
    return carryModes(
      impl,
      new EntityDeleteImpl(
        impl._builder,
        impl._entity,
        impl._key,
        impl._condition,
        mode,
        impl._mustExist,
      ),
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
 * @internal The field names `.remove()` takes, carried on the (phantom) payload
 * type `Entity.update()` returns, as {@link UpdateBase} carries its return types.
 */
declare const RemovableTypeId: unique symbol
/** @internal */
export interface Removable<N extends string> {
  // A method: its parameter is compared both ways, so an update that takes fewer names
  // still fits a type written without them.
  [RemovableTypeId]?(_: N): void
}
/** @internal The names a payload type allows, `string` when it doesn't say. */
export type RemovableOf<U> = typeof RemovableTypeId extends keyof U
  ? U extends Removable<infer N>
    ? N
    : string
  : string

/**
 * Clear model fields a row can lack, by their model names. Produces a DynamoDB
 * `REMOVE` clause; `Entity.set({ field: undefined })` is the same operation.
 *
 * A field the model requires, a typo and a stored attribute name don't compile,
 * and are refused at run time, before anything is sent. To clean up an attribute
 * the model no longer declares, use `Entity.pathRemove(update, ["attribute"])`.
 */
export const remove: {
  <A, Rec, U, E, R, O extends OffloadState>(
    fields: ReadonlyArray<RemovableOf<NoInfer<U>>>,
  ): (self: EntityUpdate<A, Rec, U, E, R, O>) => EntityUpdate<A, Rec, U, E, R, O>
  <A, Rec, U, E, R, O extends OffloadState>(
    self: EntityUpdate<A, Rec, U, E, R, O>,
    fields: ReadonlyArray<RemovableOf<NoInfer<U>>>,
  ): EntityUpdate<A, Rec, U, E, R, O>
} = Fn.dual(
  2,
  <A, Rec, U, E, R, O extends OffloadState>(
    self: EntityUpdate<A, Rec, U, E, R, O>,
    fields: ReadonlyArray<string>,
  ): EntityUpdate<A, Rec, U, E, R, O> => {
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
    values: globalThis.Record<string, AddOperand>,
  ): <A, Rec, U, E, R, O extends OffloadState>(
    self: EntityUpdate<A, Rec, U, E, R, O>,
  ) => EntityUpdate<A, Rec, U, E, R, O>
  <A, Rec, U, E, R, O extends OffloadState>(
    self: EntityUpdate<A, Rec, U, E, R, O>,
    values: globalThis.Record<string, AddOperand>,
  ): EntityUpdate<A, Rec, U, E, R, O>
} = Fn.dual(
  2,
  <A, Rec, U, E, R, O extends OffloadState>(
    self: EntityUpdate<A, Rec, U, E, R, O>,
    values: globalThis.Record<string, AddOperand>,
  ): EntityUpdate<A, Rec, U, E, R, O> => {
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
  ): <A, Rec, U, E, R, O extends OffloadState>(
    self: EntityUpdate<A, Rec, U, E, R, O>,
  ) => EntityUpdate<A, Rec, U, E, R, O>
  <A, Rec, U, E, R, O extends OffloadState>(
    self: EntityUpdate<A, Rec, U, E, R, O>,
    values: globalThis.Record<string, number>,
  ): EntityUpdate<A, Rec, U, E, R, O>
} = Fn.dual(
  2,
  <A, Rec, U, E, R, O extends OffloadState>(
    self: EntityUpdate<A, Rec, U, E, R, O>,
    values: globalThis.Record<string, number>,
  ): EntityUpdate<A, Rec, U, E, R, O> => {
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
  ): <A, Rec, U, E, R, O extends OffloadState>(
    self: EntityUpdate<A, Rec, U, E, R, O>,
  ) => EntityUpdate<A, Rec, U, E, R, O>
  <A, Rec, U, E, R, O extends OffloadState>(
    self: EntityUpdate<A, Rec, U, E, R, O>,
    values: globalThis.Record<string, ReadonlyArray<unknown>>,
  ): EntityUpdate<A, Rec, U, E, R, O>
} = Fn.dual(
  2,
  <A, Rec, U, E, R, O extends OffloadState>(
    self: EntityUpdate<A, Rec, U, E, R, O>,
    values: globalThis.Record<string, ReadonlyArray<unknown>>,
  ): EntityUpdate<A, Rec, U, E, R, O> => {
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
  ): <A, Rec, U, E, R, O extends OffloadState>(
    self: EntityUpdate<A, Rec, U, E, R, O>,
  ) => EntityUpdate<A, Rec, U, E, R, O>
  <A, Rec, U, E, R, O extends OffloadState>(
    self: EntityUpdate<A, Rec, U, E, R, O>,
    values: globalThis.Record<string, unknown>,
  ): EntityUpdate<A, Rec, U, E, R, O>
} = Fn.dual(
  2,
  <A, Rec, U, E, R, O extends OffloadState>(
    self: EntityUpdate<A, Rec, U, E, R, O>,
    values: globalThis.Record<string, unknown>,
  ): EntityUpdate<A, Rec, U, E, R, O> => {
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
  }): <A, Rec, U, E, R, O extends OffloadState>(
    self: EntityUpdate<A, Rec, U, E | CascadePartialFailure, R, O>,
  ) => EntityUpdate<A, Rec, U, E | CascadePartialFailure, R, O>
  <A, Rec, U, E, R, O extends OffloadState>(
    self: EntityUpdate<A, Rec, U, E, R, O>,
    config: {
      readonly targets: ReadonlyArray<CascadeTarget>
      readonly filter?: globalThis.Record<string, unknown> | undefined
      readonly mode?: "eventual" | "transactional" | undefined
    },
  ): EntityUpdate<A, Rec, U, E | CascadePartialFailure, R, O>
} = Fn.dual(
  2,
  <A, Rec, U, E, R, O extends OffloadState>(
    self: EntityUpdate<A, Rec, U, E, R, O>,
    config: CascadeConfig,
  ): EntityUpdate<A, Rec, U, E | CascadePartialFailure, R, O> => {
    return new EntityUpdateImpl<A, Rec, U, E | CascadePartialFailure, R>(
      self._builder as any,
      { ...self._updateState, cascade: config },
      self._entity,
      self._key,
    ) as any
  },
)

/**
 * Name refs an update keeps, by their ids (`{ playerId }`): each id keys the indexes it is a
 * composite of, as `.set({ playerId })` would, but the referenced item is not fetched and the stored
 * ref is not rewritten. The update is conditioned on the row holding that ref, so it fails with
 * {@link ConditionalCheckFailed} where the row holds another (in `Transaction.transactWrite`, the
 * transaction is cancelled). For reassigning one ref of an index half that holds two refs' ids
 * (#263): `.set({ season, series, teamId }).keepRefs({ playerId })`.
 */
export const keepRefs: {
  (
    ids: globalThis.Record<string, unknown>,
  ): <A, Rec, U, E, R>(
    self: EntityUpdate<A, Rec, U, E, R>,
  ) => EntityUpdate<A, Rec, U, E | ConditionalCheckFailed, R>
  <A, Rec, U, E, R>(
    self: EntityUpdate<A, Rec, U, E, R>,
    ids: globalThis.Record<string, unknown>,
  ): EntityUpdate<A, Rec, U, E | ConditionalCheckFailed, R>
} = Fn.dual(
  2,
  <A, Rec, U, E, R>(
    self: EntityUpdate<A, Rec, U, E, R>,
    ids: globalThis.Record<string, unknown>,
  ): EntityUpdate<A, Rec, U, E | ConditionalCheckFailed, R> =>
    new EntityUpdateImpl<A, Rec, U, E | ConditionalCheckFailed, R>(
      self._builder as any,
      { ...self._updateState, keepRefs: { ...self._updateState.keepRefs, ...ids } },
      self._entity,
      self._key,
    ) as any,
)

// ---------------------------------------------------------------------------
// Path-based update combinators (internal — used by entity-level typed combinators)
// ---------------------------------------------------------------------------

/** @internal Append an operation to a path-based update state array field. */
const addPathOp = <A, Rec, U, E, R, O extends OffloadState>(
  self: EntityUpdate<A, Rec, U, E, R, O>,
  key: keyof import("./EntityOps.js").UpdateState,
  op: unknown,
): EntityUpdate<A, Rec, U, E, R, O> => {
  const existing = (self._updateState[key] as ReadonlyArray<unknown> | undefined) ?? []
  return new EntityUpdateImpl<A, Rec, U, E, R>(
    self._builder as any,
    { ...self._updateState, [key]: [...existing, op] },
    self._entity,
    self._key,
  ) as any
}

/** @internal Add a path-based SET operation to the update state */
export const pathSet = <A, Rec, U, E, R, O extends OffloadState>(
  self: EntityUpdate<A, Rec, U, E, R, O>,
  op: PathSetOp,
): EntityUpdate<A, Rec, U, E, R, O> => addPathOp(self, "pathSets", op)

/** @internal Add a path-based REMOVE operation to the update state */
export const pathRemove = <A, Rec, U, E, R, O extends OffloadState>(
  self: EntityUpdate<A, Rec, U, E, R, O>,
  segments: ReadonlyArray<string | number>,
): EntityUpdate<A, Rec, U, E, R, O> => addPathOp(self, "pathRemoves", segments)

/** @internal Add a path-based ADD operation to the update state */
export const pathAdd = <A, Rec, U, E, R, O extends OffloadState>(
  self: EntityUpdate<A, Rec, U, E, R, O>,
  op: PathAddOp,
): EntityUpdate<A, Rec, U, E, R, O> => addPathOp(self, "pathAdds", op)

/** @internal Add a path-based SUBTRACT operation to the update state */
export const pathSubtract = <A, Rec, U, E, R, O extends OffloadState>(
  self: EntityUpdate<A, Rec, U, E, R, O>,
  op: PathSubtractOp,
): EntityUpdate<A, Rec, U, E, R, O> => addPathOp(self, "pathSubtracts", op)

/** @internal Add a path-based APPEND operation to the update state */
export const pathAppend = <A, Rec, U, E, R, O extends OffloadState>(
  self: EntityUpdate<A, Rec, U, E, R, O>,
  op: PathAppendOp,
): EntityUpdate<A, Rec, U, E, R, O> => addPathOp(self, "pathAppends", op)

/** @internal Add a path-based PREPEND operation to the update state */
export const pathPrepend = <A, Rec, U, E, R, O extends OffloadState>(
  self: EntityUpdate<A, Rec, U, E, R, O>,
  op: PathPrependOp,
): EntityUpdate<A, Rec, U, E, R, O> => addPathOp(self, "pathPrepends", op)

/** @internal Add a path-based if_not_exists operation to the update state */
export const pathIfNotExists = <A, Rec, U, E, R, O extends OffloadState>(
  self: EntityUpdate<A, Rec, U, E, R, O>,
  op: PathIfNotExistsOp,
): EntityUpdate<A, Rec, U, E, R, O> => addPathOp(self, "pathIfNotExists", op)

/** @internal Add a path-based DELETE (set removal) operation to the update state */
export const pathDelete = <A, Rec, U, E, R, O extends OffloadState>(
  self: EntityUpdate<A, Rec, U, E, R, O>,
  op: PathDeleteOp,
): EntityUpdate<A, Rec, U, E, R, O> => addPathOp(self, "pathDeletes", op)

// ---------------------------------------------------------------------------
// Sparse-map combinators
// ---------------------------------------------------------------------------

/**
 * Remove specific entries from a sparse-map field. Compiles to
 * `REMOVE <prefix>#k1, <prefix>#k2, ...` clauses appended to the
 * UpdateExpression. Removing an entry that doesn't exist is a no-op
 * (DynamoDB REMOVE semantics).
 *
 * Multiple `removeEntries` calls accumulate.
 */
export const removeEntries: {
  (
    field: string,
    keys: ReadonlyArray<string>,
  ): <A, Rec, U, E, R, O extends OffloadState>(
    self: EntityUpdate<A, Rec, U, E, R, O>,
  ) => EntityUpdate<A, Rec, U, E, R, O>
  <A, Rec, U, E, R, O extends OffloadState>(
    self: EntityUpdate<A, Rec, U, E, R, O>,
    field: string,
    keys: ReadonlyArray<string>,
  ): EntityUpdate<A, Rec, U, E, R, O>
} = Fn.dual(
  3,
  <A, Rec, U, E, R, O extends OffloadState>(
    self: EntityUpdate<A, Rec, U, E, R, O>,
    field: string,
    keys: ReadonlyArray<string>,
  ): EntityUpdate<A, Rec, U, E, R, O> => {
    const existing = self._updateState.sparseRemoveEntries ?? []
    return new EntityUpdateImpl<A, Rec, U, E, R>(
      self._builder as any,
      {
        ...self._updateState,
        sparseRemoveEntries: [...existing, { field, keys }],
      },
      self._entity,
      self._key,
    ) as any
  },
)

/**
 * Clear all entries of a sparse-map field. Two-op helper: the executor reads
 * the current item to discover which `<prefix>#*` attributes exist, then
 * folds REMOVE clauses for those attributes into the same final
 * `UpdateItem` as the rest of the builder's combinators.
 *
 * Atomic via the version CAS for `versioned` entities; best-effort for
 * non-versioned (a concurrent writer may add a new bucket between the read
 * and the update — that bucket survives the clear).
 *
 * Multiple `clearMap(field)` calls dedupe by field.
 */
export const clearMap: {
  (
    field: string,
  ): <A, Rec, U, E, R, O extends OffloadState>(
    self: EntityUpdate<A, Rec, U, E, R, O>,
  ) => EntityUpdate<A, Rec, U, E, R, O>
  <A, Rec, U, E, R, O extends OffloadState>(
    self: EntityUpdate<A, Rec, U, E, R, O>,
    field: string,
  ): EntityUpdate<A, Rec, U, E, R, O>
} = Fn.dual(
  2,
  <A, Rec, U, E, R, O extends OffloadState>(
    self: EntityUpdate<A, Rec, U, E, R, O>,
    field: string,
  ): EntityUpdate<A, Rec, U, E, R, O> => {
    const existing = self._updateState.sparseClearFields ?? []
    if (existing.includes(field)) {
      return self
    }
    return new EntityUpdateImpl<A, Rec, U, E, R>(
      self._builder as any,
      {
        ...self._updateState,
        sparseClearFields: [...existing, field],
      },
      self._entity,
      self._key,
    ) as any
  },
)

// ---------------------------------------------------------------------------
// Offload read modes (#179, design §3.7)
// ---------------------------------------------------------------------------

/** @internal Operations `offloaded` applies to. */
export type OffloadedTarget =
  | EntityGet<any, any, any, any, any>
  | EntityPut<any, any, any, any, any>
  | EntityInsert<any, any, any, any, any>
  | EntityUpdate<any, any, any, any, any, any>
  | EntityDelete<any, any, any, any, any>

/** An operation's type after `offloaded(m)`: its result re-typed for the new modes. */
export type OffloadedResult<T, M extends OffloadMode | OffloadModes> =
  T extends EntityUpdate<infer _A, infer _Rec, infer U, infer E, infer R, infer O>
    ? EntityUpdate<
        OffloadedOpView<_A, O, M>,
        OffloadedOpRecord<_Rec, O, M>,
        U,
        E,
        R,
        OpWithModes<O, M>
      >
    : T extends EntityGet<infer _A, infer _Rec, infer E, infer R, infer O>
      ? EntityGet<
          OffloadedOpView<_A, O, M>,
          OffloadedOpRecord<_Rec, O, M>,
          OpOffloadedErrors<E, O, M>,
          R,
          OpWithModes<O, M>
        >
      : T extends EntityDelete<infer E, infer R, infer _A, infer Mo, infer O>
        ? EntityDelete<E, R, OffloadedOpView<_A, O, M>, Mo, OpWithModes<O, M>>
        : T

/**
 * The model view after `offloaded(m)`; `A` for a member that offloads nothing,
 * and for an op that returns nothing (a delete without `returnValues`).
 */
type OffloadedOpView<A, O extends OffloadState, M extends OffloadMode | OffloadModes> = [
  O["fields"]["overflow"] | O["fields"]["binary"],
] extends [never]
  ? A
  : [O["item"]] extends [undefined]
    ? A
    : ViewOf<OpWithModes<O, M>>

/** The record view after `offloaded(m)`; `Rec` for a member that offloads nothing. */
type OffloadedOpRecord<Rec, O extends OffloadState, M extends OffloadMode | OffloadModes> = [
  O["fields"]["overflow"] | O["fields"]["binary"],
] extends [never]
  ? Rec
  : RecordViewOf<OpWithModes<O, M>>

/**
 * Read the operation's offloaded fields (#179) in `mode`: `"eager"` or
 * `"lazy"` for both kinds, or `{ overflow?, binary? }` to set the kinds it
 * names over the operation's current modes. Defaults: overflow eager, binary
 * lazy.
 *
 * For a get, the result (`asModel` / `asRecord` / `asItem`) is re-typed and
 * its blob errors follow the modes; for a write (`put`, `update`, `delete`
 * with `returnValues`), its result. `asNative` returns the stored pointers
 * whatever the mode. An unknown mode (from untyped code) throws
 * `[EDD-9117]`. A member that offloads nothing is unchanged.
 */
export const offloaded: {
  <const M extends OffloadMode | OffloadModes>(
    mode: M,
  ): <T extends OffloadedTarget>(self: T) => OffloadedResult<T, M>
  <T extends OffloadedTarget, const M extends OffloadMode | OffloadModes>(
    self: T,
    mode: M,
  ): OffloadedResult<T, M>
} = Fn.dual(2, <T extends OffloadedTarget>(self: T, mode: OffloadMode | OffloadModes): T => {
  if (EntityUpdateTypeId in self) {
    const impl = self as unknown as EntityUpdateImpl<any, any, any, any, any>
    const base = impl._updateState.offloadModes ?? DEFAULT_MODES
    return new EntityUpdateImpl(
      impl._builder,
      { ...impl._updateState, offloadModes: parseModes(mode, base, "Entity.offloaded") },
      impl._entity,
      impl._key,
    ) as unknown as T
  }
  const impl = self as unknown as EntityGetImpl<any, any, any, any>
  const base = impl._offloadModes ?? DEFAULT_MODES
  const next =
    EntityDeleteTypeId in self
      ? (() => {
          const d = self as unknown as EntityDeleteImpl<any, any>
          return new EntityDeleteImpl(
            d._builder,
            d._entity,
            d._key,
            d._condition,
            d._returnValues,
            d._mustExist,
          )
        })()
      : (self as unknown as { readonly _opType: string })._opType === "get"
        ? new EntityGetImpl(
            impl._builder,
            impl._entity,
            impl._key,
            impl._consistentRead,
            impl._projection as Array<string> | undefined,
          )
        : (() => {
            const p = self as unknown as EntityPutImpl<any, any, any, any>
            return new EntityPutImpl(
              p._builder,
              p._entity,
              p._input,
              p._condition,
              p._withVectors,
              p._putKind,
            )
          })()
  next._offloadModes = parseModes(mode, base, "Entity.offloaded")
  return next as unknown as T
})
