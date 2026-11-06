/**
 * @internal Aggregate type-level computations — derived types for Aggregate operations.
 *
 * Extracted from Aggregate.ts for decomposition. Not part of the public API.
 */

import type { DateTime, Schema } from "effect"
import type { DiscriminatorConfig, UpdateContext } from "./AggregateCursor.js"
import type { AggregateEdge, ManyEdge, OneEdge, RefEdge, RefEntity } from "./AggregateEdges.js"
import type {
  CreatedAtFieldName,
  ManagedDateField,
  ModelFieldName,
  ModelFields,
  RefEntityIdentifierValue,
  UpdatedAtFieldName,
} from "./EntityTypes.js"

// ---------------------------------------------------------------------------
// Sub-aggregate / Bound sub-aggregate
// ---------------------------------------------------------------------------

/**
 * A composable sub-aggregate definition — a graph shape that can be embedded
 * in a parent aggregate via `.with()`.
 */
export interface SubAggregate<
  TSchema extends Schema.Top,
  TEdges extends Record<string, AggregateEdge | BoundSubAggregate<any, any>> = Record<
    string,
    AggregateEdge | BoundSubAggregate<any, any>
  >,
> {
  readonly _tag: "SubAggregate"
  readonly schema: TSchema
  readonly root: { readonly entityType: string }
  readonly edges: TEdges
  /** Bind with discriminator values to distinguish multiple embeddings */
  readonly with: (config: DiscriminatorConfig) => BoundSubAggregate<TSchema, TEdges>
}

/**
 * A sub-aggregate bound with discriminator values, ready to embed in a parent.
 */
export interface BoundSubAggregate<
  TSchema extends Schema.Top,
  TEdges extends Record<string, AggregateEdge | BoundSubAggregate<any, any>> = Record<
    string,
    AggregateEdge | BoundSubAggregate<any, any>
  >,
> {
  readonly _tag: "BoundSubAggregate"
  readonly aggregate: SubAggregate<TSchema, TEdges>
  readonly discriminator: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Type extractors
// ---------------------------------------------------------------------------

/** Extract the domain type from an Aggregate */
export type Type<T> = T extends { readonly schema: infer S extends Schema.Top }
  ? Schema.Schema.Type<S>
  : never

/** Extract the key type from an Aggregate */
export type Key<T> = T extends { readonly get: (key: infer K) => any } ? K : never

/** Extract the input type from an Aggregate */
export type Input<T> = T extends { readonly inputSchema: Schema.Codec<infer I> } ? I : never

/** Extract the update mutation function type from an Aggregate */
export type UpdateFn<T> = T extends { readonly schema: infer S extends Schema.Top }
  ? (context: UpdateContext<S["Iso"], Schema.Schema.Type<S>>) => Schema.Schema.Type<S> | S["Iso"]
  : never

// ---------------------------------------------------------------------------
// Type-level input schema derivation
// ---------------------------------------------------------------------------

/**
 * Resolve the `${field}Id` value type for a OneEdge / RefEdge / ManyEdge.
 *
 * Extracts the referenced entity from the edge and resolves its branded
 * primary-key identifier via `RefEntityIdentifierValue`. Edges without an
 * associated entity (e.g. a `OneEdge` whose member is a pure sub-shape) fall
 * back to `string`.
 *
 * `entity` is required on RefEdge but optional on OneEdge / ManyEdge
 * (`entity?: E | undefined`), so we read it via indexed access and strip
 * `undefined` with `NonNullable` before resolving — otherwise the optional
 * modifier widens `infer E` to `E | undefined`, fails the `extends RefEntity`
 * guard, and silently collapses the brand back to `string`.
 */
type _EdgeIdValue<Edge> =
  NonNullable<
    Edge extends { readonly entity?: unknown } ? Edge["entity"] : undefined
  > extends infer E
    ? E extends RefEntity
      ? RefEntityIdentifierValue<E>
      : string
    : string

/**
 * Compute the aggregate input type from the domain model, edges, and PK composites.
 *
 * - OneEdge / RefEdge fields → `${field}Id: <entity branded id | string>`
 * - BoundSubAggregate fields → recursed
 * - ManyEdge fields → array elements recursed for ref replacement
 * - PK composites → omitted
 * - A date `timestamps` stamps (`TStamps`, at any level) → optional, as on an entity
 * - Everything else → kept as-is
 *
 * Edge id fields resolve to the referenced entity's branded primary-key
 * identifier type (e.g. `venueId: VenueId`) when the edge carries an `entity`,
 * mirroring the standalone Entity ref path (`EntityRefInputType`). Without an
 * entity, they fall back to `string`.
 */
export type AggregateInputType<
  TModel,
  TEdges extends Record<string, AggregateEdge | BoundSubAggregate<any, any>>,
  TPK extends ReadonlyArray<string>,
  TStamps = never,
> = _Simplify<
  // Regular fields: not an edge, not a PK composite
  {
    readonly [K in keyof TModel as K extends keyof TEdges
      ? never
      : K extends TPK[number]
        ? never
        : K extends ManagedDateField<TModel, TStamps>
          ? never
          : K]: _StripUndefined<TModel[K]>
  } & {
    // A date the library stamps: never the input's to supply, and a supplied one wins
    readonly [K in keyof TModel as K extends keyof TEdges
      ? never
      : K extends TPK[number]
        ? never
        : K extends ManagedDateField<TModel, TStamps>
          ? K
          : never]?: _StripUndefined<TModel[K]>
  } & {
    // Required OneEdge / RefEdge fields → ${name}Id: <entity branded id>
    readonly [K in keyof TEdges as TEdges[K] extends OneEdge<any> | RefEdge<any>
      ? _IsOptionalIn<TModel, K> extends true
        ? never
        : `${K & string}Id`
      : never]: _EdgeIdValue<TEdges[K]>
  } & {
    // Optional OneEdge / RefEdge fields → ${name}Id?: <entity branded id>
    readonly [K in keyof TEdges as TEdges[K] extends OneEdge<any> | RefEdge<any>
      ? _IsOptionalIn<TModel, K> extends true
        ? `${K & string}Id`
        : never
      : never]?: _EdgeIdValue<TEdges[K]>
  } & {
    // Required BoundSubAggregate fields → recurse
    readonly [K in keyof TEdges as TEdges[K] extends BoundSubAggregate<any, any>
      ? _IsOptionalIn<TModel, K> extends true
        ? never
        : K
      : never]: TEdges[K] extends BoundSubAggregate<infer S, infer E>
      ? AggregateInputType<Schema.Schema.Type<S>, E, [], TStamps>
      : never
  } & {
    // Optional BoundSubAggregate fields → recurse
    readonly [K in keyof TEdges as TEdges[K] extends BoundSubAggregate<any, any>
      ? _IsOptionalIn<TModel, K> extends true
        ? K
        : never
      : never]?: TEdges[K] extends BoundSubAggregate<infer S, infer E>
      ? AggregateInputType<Schema.Schema.Type<S>, E, [], TStamps>
      : never
  } & {
    // Required ManyEdge fields → transform array elements
    // When inputField is set, use it as the output key name
    readonly [K in keyof TEdges as TEdges[K] extends ManyEdge<any>
      ? _IsOptionalIn<TModel, K> extends true
        ? never
        : TEdges[K] extends { readonly inputField: infer IF extends string }
          ? IF
          : K
      : never]: K extends keyof TModel
      ? _TransformManyEdge<TModel[K], _EdgeIdValue<TEdges[K]>, TStamps>
      : never
  } & {
    // Optional ManyEdge fields → transform array elements
    readonly [K in keyof TEdges as TEdges[K] extends ManyEdge<any>
      ? _IsOptionalIn<TModel, K> extends true
        ? TEdges[K] extends { readonly inputField: infer IF extends string }
          ? IF
          : K
        : never
      : never]?: K extends keyof TModel
      ? _TransformManyEdge<TModel[K], _EdgeIdValue<TEdges[K]>, TStamps>
      : never
  }
>

/**
 * The field names an aggregate's `timestamps` stamps. A root field of that name that isn't a date is
 * the caller's, and no row of the aggregate is stamped (`resolveSystemFields`, rule b).
 */
export type AggregateStampNames<TModel, TTimestamps> = _NotCallersOwn<
  TModel,
  CreatedAtFieldName<TTimestamps> | UpdatedAtFieldName<TTimestamps>
>

type _NotCallersOwn<TModel, TNames> = TNames extends keyof TModel
  ? TNames extends ManagedDateField<TModel, TNames>
    ? TNames
    : never
  : TNames

/** Detect ref-like types: objects with an `id: string` property (Schema.Class entities) */
type _IsRefLike<T> = T extends { readonly id: string }
  ? string extends keyof T
    ? false
    : true
  : false

/**
 * Transform an object's ref-like fields to `${field}Id: <Id>`.
 *
 * `Id` is the edge entity's branded identifier type — the ManyEdge associates a
 * single entity, and the runtime decomposition (`deriveEntityFieldName`) maps
 * the element's entity-derived ref field to exactly that entity, so the brand
 * is shared by the element's nested ref field. Falls back to `string` when the
 * edge carries no entity (`Id = string`).
 */
type _RefFieldsToIds<T, Id> = _Simplify<{
  readonly [K in keyof T as _IsRefLike<T[K]> extends true ? `${K & string}Id` : K]: _IsRefLike<
    T[K]
  > extends true
    ? Id
    : T[K]
}>

/**
 * Distribute over unions (e.g., ReadonlyArray<T> | undefined) to transform array elements.
 *
 * `Id` is the ManyEdge entity's branded identifier type:
 * - When the element IS the ref (`Array<Umpire>`), the array becomes `Array<Id>`.
 * - When the element wraps the ref (`Array<{ player: Player, ... }>`), the nested
 *   ref field is rewritten to `${field}Id: Id`.
 */
type _TransformManyEdge<T, Id, TStamps = never> =
  T extends ReadonlyArray<infer E>
    ? _IsRefLike<E> extends true
      ? ReadonlyArray<Id>
      : ReadonlyArray<_OptionalStamps<_RefFieldsToIds<E, Id>, TStamps>>
    : T

/** `T` with the dates the library stamps optional. */
type _OptionalStamps<T, TStamps> = [ManagedDateField<T, TStamps>] extends [never]
  ? T
  : _Simplify<
      Omit<T, ManagedDateField<T, TStamps>> & Partial<Pick<T, ManagedDateField<T, TStamps>>>
    >

/** Check if key K is an optional property of T */
type _IsOptionalIn<T, K> = K extends keyof T ? ({} extends Pick<T, K> ? true : false) : false

/** Strip `undefined` from optional field value types — the `?` modifier already expresses optionality */
type _StripUndefined<T> = undefined extends T ? Exclude<T, undefined> : T

/** Flatten intersection types — `extends infer O` breaks the alias chain for eager IDE expansion */
type _Simplify<T> = T extends infer O ? { [K in keyof O]: O[K] } : never

/**
 * @internal An aggregate's `edges`: keyed by fields of its schema. The record
 * half keeps it an edges record; the keyed half gives an editor the field
 * names. {@link AggregateEdgesGuard} on the config refuses the rest.
 */
export type AggregateEdgesConfig<TSchema extends Schema.Top> = Record<
  string,
  AggregateEdge | BoundSubAggregate<any, any>
> & {
  readonly [K in ModelFieldName<TSchema>]?: AggregateEdge | BoundSubAggregate<any, any>
}

/**
 * @internal Over the edges as written (`TEdges`): a key that is not a schema
 * field is typed `never`, and a many edge whose `sk.composite` names a path its
 * element lacks is typed with the paths it may name, so each error lands on
 * that edge's key. A guard on the config rather than in `TEdges`'s constraint
 * (the constraint naming its own parameter) keeps the editor's completions.
 */
export type AggregateEdgesGuard<TSchema extends Schema.Top, TEdges> = {
  readonly [K in keyof TEdges as K extends ModelFieldName<TSchema> ? never : K]: never
} & {
  readonly [K in keyof TEdges & ModelFieldName<TSchema>]: ManyEdgeSkCheck<
    TEdges[K],
    ModelFields<TSchema>[K]
  >
}

/**
 * The attribute paths of a many edge's element that `sk.composite` may name:
 * its scalar fields, and the scalar fields one level into an object field (a
 * hydrated ref: `"umpire.id"`) — not the object itself, which the runtime
 * refuses as a non-scalar composite. Any name when the element's type is
 * unknown.
 */
export type ManyEdgeSkPaths<TField> = unknown extends TField
  ? string
  : ElementPaths<NonNullable<TField> extends ReadonlyArray<infer El> ? El : never>

/** A value a key composes from as one scalar: a primitive, or a date. */
type IsScalar<V> = V extends string | number | bigint | boolean
  ? true
  : V extends Date | DateTime.DateTime
    ? true
    : false

/** A nested object whose fields a dotted path reaches (not a collection or a date). */
type IsRecordLike<V> =
  IsScalar<V> extends true
    ? false
    : V extends
          | ReadonlyArray<unknown>
          | ReadonlySet<unknown>
          | ReadonlyMap<unknown, unknown>
          | Uint8Array
          | ((...args: ReadonlyArray<any>) => unknown)
      ? false
      : V extends object
        ? true
        : false

type ScalarKeys<O> = {
  readonly [K in keyof O & string]: IsScalar<NonNullable<O[K]>> extends true ? K : never
}[keyof O & string]

type ElementPaths<El> = unknown extends El
  ? string
  : [El] extends [never]
    ? never
    : {
        readonly [K in keyof El & string]: IsScalar<NonNullable<El[K]>> extends true
          ? K
          : IsRecordLike<NonNullable<El[K]>> extends true
            ? `${K}.${ScalarKeys<NonNullable<El[K]>>}`
            : never
      }[keyof El & string]

/** A many edge whose `sk.composite` names something its element lacks: the paths it may name. */
type ManyEdgeSkCheck<TEdge, TField> = TEdge extends {
  readonly _tag: "ManyEdge"
  readonly sk: { readonly composite: infer C extends ReadonlyArray<string> }
}
  ? [Exclude<C[number], ManyEdgeSkPaths<TField>>] extends [never]
    ? unknown
    : { readonly sk: { readonly composite: ReadonlyArray<ManyEdgeSkPaths<TField>> } }
  : unknown
