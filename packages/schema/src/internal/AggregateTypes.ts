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
 * Extracts the referenced entity from the edge and resolves the type of its
 * primary key's one composite ({@link _EdgeIdValue}), branded or not. Edges
 * without an associated entity (e.g. a `OneEdge` whose member is a pure
 * sub-shape) fall back to `string`.
 *
 * `entity` is required on RefEdge but optional on OneEdge / ManyEdge
 * (`entity?: E | undefined`), so we read it via indexed access and strip
 * `undefined` with `NonNullable` before resolving — otherwise the optional
 * modifier widens `infer E` to `E | undefined`, fails the `extends RefEntity`
 * guard, and silently collapses the brand back to `string`.
 */
type _HasEntity<Edge> =
  RefEntity extends NonNullable<Edge extends { readonly entity?: unknown } ? Edge["entity"] : never>
    ? false
    : true

/** The entity an edge names. */
type _EdgeEntity<Edge> = NonNullable<
  Edge extends { readonly entity?: unknown } ? Edge["entity"] : undefined
>

/** The attributes an entity's primary key is composed from, its partition key's and its sort key's. */
type _KeyComposites<I> =
  | (I extends {
      readonly primary: {
        readonly pk: { readonly composite: infer P extends ReadonlyArray<string> }
      }
    }
      ? P[number]
      : never)
  | (I extends {
      readonly primary: {
        readonly sk: { readonly composite: infer S extends ReadonlyArray<string> }
      }
    }
      ? S[number]
      : never)

type _IsUnion<T, U = T> = T extends unknown ? ([U] extends [T] ? false : true) : never

/**
 * The one attribute an id of entity `E` is a value of, as the runtime finds it (`refKeyComposite`):
 * its primary key's only distinct composite. `never` for a key composed from more than one attribute,
 * or none, where no one id names one item; `string` when its composites aren't known.
 */
type _KeyComposite<E> = E extends { readonly indexes: infer I }
  ? [_KeyComposites<I>] extends [never]
    ? never
    : string extends _KeyComposites<I>
      ? string
      : true extends _IsUnion<_KeyComposites<I>>
        ? never
        : _KeyComposites<I>
  : string

/** Whether an edge's entity is fetched by one id: it has an entity, keyed by one attribute. */
type _Fetchable<Edge> =
  _HasEntity<Edge> extends true
    ? [_KeyComposite<_EdgeEntity<Edge>>] extends [never]
      ? false
      : true
    : false

/** An edge whose input is an id `create` fetches: a `ref`, or a `one` with an entity. */
type _IsIdEdge<Edge> = Edge extends RefEdge<any> | OneEdge<any> ? _Fetchable<Edge> : false

/**
 * A `one` edge with no entity, or a `ref` or `one` edge whose entity no one id names: there's
 * nothing to fetch, so its input is the value itself.
 */
type _IsValueEdge<Edge> = Edge extends RefEdge<any> | OneEdge<any>
  ? _Fetchable<Edge> extends true
    ? false
    : true
  : false

/**
 * The value an id of an edge's entity is: its key composite's type (`refIdInput`), whatever its
 * `DynamoModel.identifier` names, `number` and `bigint` included.
 */
type _EdgeIdValue<Edge> =
  _EdgeEntity<Edge> extends infer E
    ? E extends { readonly model: infer M extends Schema.Top }
      ? _KeyComposite<E> extends infer C extends string
        ? string extends C
          ? string
          : Schema.Schema.Type<M>[C & keyof Schema.Schema.Type<M>]
        : string
      : string
    : string

/**
 * A many edge's input: for an entity one id names, its elements as `create` takes them
 * ({@link _TransformManyEdge}), decided from the edge's field schema (`FS`); otherwise (no entity,
 * or one no one id names) the elements as given, as `create` takes them.
 */
type _ManyEdgeInput<T, Edge, TStamps, FS> =
  _Fetchable<Edge> extends true
    ? _TransformManyEdge<
        T,
        TStamps,
        _ElementSchema<FS>,
        _EdgeModelSchema<Edge>,
        _EdgeIdValue<Edge>,
        _EdgeIdValue139<Edge>,
        _EntityFieldName<_EdgeEntity<Edge>>
      >
    : _TransformManyEdge<T, TStamps, never, never, never, never, never>

/**
 * An id as 1.39.0 typed it: the entity's partition key composite's type. Taken where an element is
 * typed as on 1.39.0: wherever `create` takes an id of the entity's key composite only as 1.39.0
 * did, a string ({@link _TransformManyEdge}).
 */
type _EdgeIdValue139<Edge> =
  _EdgeEntity<Edge> extends infer E
    ? E extends RefEntity
      ? RefEntityIdentifierValue<E>
      : string
    : string

/** The schema of an edge's entity's model, as the entity declares it. */
type _EdgeModelSchema<Edge> = _EdgeEntity<Edge> extends { readonly model: infer M } ? M : never

/**
 * Compute the aggregate input type from the domain model, edges, and PK composites.
 *
 * - RefEdge, and OneEdge with an entity, fields → `${field}Id: <entity key composite>`
 * - OneEdge without one, or with an entity no one id names → the value, under its field name
 *   (`create` has nothing to fetch)
 * - BoundSubAggregate fields → recursed
 * - ManyEdge fields → array elements recursed for ref replacement
 * - PK composites → omitted
 * - A date `timestamps` stamps (`TStamps`, at any level) → optional, as on an entity
 * - Everything else → kept as-is
 *
 * Edge id fields resolve to the type of the referenced entity's primary key's
 * one composite (e.g. `venueId: VenueId`, `lineId: number`) when the edge
 * carries an `entity` that one id names; an `entity` keyed by more than one
 * attribute, or none, is given whole, as `create` takes it.
 */
export type AggregateInputType<
  TModel,
  TEdges extends Record<string, AggregateEdge | BoundSubAggregate<any, any>>,
  TPK extends ReadonlyArray<string>,
  TStamps = never,
  TFields = never,
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
    // Required RefEdge fields, and OneEdge with an entity → ${name}Id: <entity branded id>
    readonly [K in keyof TEdges as _IsIdEdge<TEdges[K]> extends true
      ? _IsOptionalIn<TModel, K> extends true
        ? never
        : `${K & string}Id`
      : never]: _EdgeIdValue<TEdges[K]>
  } & {
    // Optional RefEdge fields, and OneEdge with an entity → ${name}Id?: <entity branded id>
    readonly [K in keyof TEdges as _IsIdEdge<TEdges[K]> extends true
      ? _IsOptionalIn<TModel, K> extends true
        ? `${K & string}Id`
        : never
      : never]?: _EdgeIdValue<TEdges[K]>
  } & {
    // Required OneEdge with no entity → the value
    readonly [K in keyof TEdges as _IsValueEdge<TEdges[K]> extends true
      ? _IsOptionalIn<TModel, K> extends true
        ? never
        : K
      : never]: K extends keyof TModel ? _OptionalStamps<TModel[K], TStamps> : never
  } & {
    // Optional OneEdge with no entity → the value
    readonly [K in keyof TEdges as _IsValueEdge<TEdges[K]> extends true
      ? _IsOptionalIn<TModel, K> extends true
        ? K
        : never
      : never]?: K extends keyof TModel
      ? _OptionalStamps<_StripUndefined<TModel[K]>, TStamps>
      : never
  } & {
    // Required BoundSubAggregate fields → recurse
    readonly [K in keyof TEdges as TEdges[K] extends BoundSubAggregate<any, any>
      ? _IsOptionalIn<TModel, K> extends true
        ? never
        : K
      : never]: TEdges[K] extends BoundSubAggregate<infer S, infer E>
      ? AggregateInputType<Schema.Schema.Type<S>, E, [], TStamps, SchemaFieldsOf<S>>
      : never
  } & {
    // Optional BoundSubAggregate fields → recurse
    readonly [K in keyof TEdges as TEdges[K] extends BoundSubAggregate<any, any>
      ? _IsOptionalIn<TModel, K> extends true
        ? K
        : never
      : never]?: TEdges[K] extends BoundSubAggregate<infer S, infer E>
      ? AggregateInputType<Schema.Schema.Type<S>, E, [], TStamps, SchemaFieldsOf<S>>
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
      ? _ManyEdgeInput<TModel[K], TEdges[K], TStamps, _FieldOf<TFields, K>>
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
      ? _ManyEdgeInput<TModel[K], TEdges[K], TStamps, _FieldOf<TFields, K>>
      : never
  }
>

// ---------------------------------------------------------------------------
// What `create` takes
// ---------------------------------------------------------------------------

/** A model's schema, out of a `DynamoModel.configure` wrapper. */
type _ModelSchema<M> = M extends { readonly model: infer S; readonly attributes: unknown } ? S : M

/** The schema of the field an edge's entity is keyed by: its key composite's. */
type _EdgeIdField<Edge> =
  _EdgeEntity<Edge> extends infer E
    ? E extends { readonly model: infer M }
      ? _KeyComposite<E> extends infer C extends string
        ? _ModelSchema<M> extends { readonly fields: infer F }
          ? C extends keyof F
            ? F[C]
            : never
          : never
        : never
      : never
    : never

/** The stored form of a field's values. */
type _StoredForm<F> = F extends { readonly Encoded: infer X } ? X : never

/** The kind of value `T` is. A form of the same kind adds nothing to `T` but would erase a brand. */
type _Kind<T> = T extends string
  ? string
  : T extends number
    ? number
    : T extends bigint
      ? bigint
      : T extends boolean
        ? boolean
        : T extends Date
          ? Date
          : never

/** The JSON form of a value JSON has no value for: an ISO string of a date, digits of a bigint. */
type _JsonText<T> = T extends Date | bigint | DateTime.DateTime ? string : never

/**
 * Every form `create` takes an id of an edge's entity in (`refIdValue`): a value of its key
 * composite's type, or that value's stored or JSON form where it is another kind of value (`"5"`
 * for a `NumberFromString` key, an ISO string for a `Date` key). A form of the id's own kind is left
 * out: a branded id's stored form is the plain string or number, which would erase the brand, and
 * no run-time check can see a brand.
 */
type _EdgeIdForms<Edge> =
  | _EdgeIdValue<Edge>
  | Exclude<
      _StoredForm<_EdgeIdField<Edge>> | _JsonText<_EdgeIdValue<Edge>>,
      _Kind<_EdgeIdValue<Edge>>
    >

type _UnionToIntersection<U> = (U extends unknown ? (k: U) => void : never) extends (
  k: infer I,
) => void
  ? I
  : never

/**
 * Each of a record's values at once, alternatives kept: `{ a: A1 | A2, b: B1 | B2 }` is
 * `(A1 | A2) & (B1 | B2)`. Each value is boxed first, so its own alternatives aren't intersected.
 */
type _AllOf<A> = [keyof A] extends [never]
  ? unknown
  : _UnionToIntersection<{ [K in keyof A]: { readonly box: A[K] } }[keyof A]> extends infer I
    ? I extends { readonly box: unknown }
      ? I["box"]
      : never
    : never

/**
 * A field holding an edge's entity, as `create` takes it: its id under `${field}Id`, or the entity
 * given whole under its own name. Given both, the id is fetched (`collectRefIdsFromEdges`).
 */
type _IdOrWhole<K extends string, Id, V> =
  | ({ readonly [P in `${K}Id`]: Id } & { readonly [P in K]?: V })
  | ({ readonly [P in K]: V } & { readonly [P in `${K}Id`]?: undefined })

/**
 * {@link _IdOrWhole} of a field that may be left out: either, both, or neither. `V` is the field's
 * value as declared, so it holds `undefined` where the field takes it (`Schema.optional`), and the
 * id then does too.
 */
type _OptionalIdOrWhole<K extends string, Id, V> = {
  readonly [P in `${K}Id`]?: Id | (undefined extends V ? undefined : never)
} & {
  readonly [P in K]?: V
}

/**
 * An element whose definition names the field holding the entity (`N`), as `create` takes it: that
 * field's id under `${N}Id`, or the entity whole under `N`, the other fields as they are.
 */
type _ElementIdOrWhole<E, Id, N extends string, TStamps> = N extends keyof E
  ? _OptionalStamps<Omit<E, N>, TStamps> &
      (undefined extends E[N] ? _OptionalIdOrWhole<N, Id, E[N]> : _IdOrWhole<N, Id, E[N]>)
  : _OptionalStamps<E, TStamps>

/**
 * A many edge's elements as `create` takes them, for an edge whose entity (model schema `MS`) one id
 * names, decided from the element's schema (`ES`) by the rule {@link _TransformManyEdge} follows:
 * - an element that is the entity ({@link _IsEntityElement}) is its id or the entity whole, in any
 *   mix;
 * - an element naming the field holding the entity ({@link _NamesEntityField}) takes, in that field
 *   (`N`), the id or the entity whole;
 * - any other element is `unknown`, as 1.39.0's `create` took it (`Record<string, unknown>`): it is
 *   judged as 1.39.0 judged it, and no narrower type names every element `create` takes.
 */
type _CreateManyEdge<T, Id, TStamps, ES, MS, N extends string> =
  T extends ReadonlyArray<infer E>
    ? _IsEntityElement<ES, MS> extends true
      ? ReadonlyArray<Id | _OptionalStamps<E, TStamps>>
      : _NamesEntityField<ES, MS, N> extends true
        ? ReadonlyArray<_ElementIdOrWhole<E, Id, N, TStamps>>
        : ReadonlyArray<unknown>
    : _TransformManyEdge<T, TStamps, never, never, never, never, never>

/**
 * A many edge's input to `create`: {@link _CreateManyEdge} for an entity one id names, decided from
 * the edge's field schema (`FS`).
 */
type _ManyEdgeCreateInput<T, Edge, TStamps, FS> =
  _Fetchable<Edge> extends true
    ? _CreateManyEdge<
        T,
        _EdgeIdForms<Edge>,
        TStamps,
        _ElementSchema<FS>,
        _EdgeModelSchema<Edge>,
        _EntityFieldName<_EdgeEntity<Edge>>
      >
    : _TransformManyEdge<T, TStamps, never, never, never, never, never>

/** The input fields {@link AggregateCreateInputType} replaces: id, many and sub-aggregate edges'. */
type _CreateReplacedKeys<TEdges> = {
  [K in keyof TEdges]: _IsIdEdge<TEdges[K]> extends true
    ? `${K & string}Id`
    : TEdges[K] extends BoundSubAggregate<any, any>
      ? K
      : TEdges[K] extends ManyEdge<any>
        ? TEdges[K] extends { readonly inputField: infer IF extends string }
          ? IF
          : K
        : never
}[keyof TEdges]

/**
 * What an aggregate's `create` takes: its {@link AggregateInputType}, plus what the input schema
 * leaves to the caller, as `create` takes it at run time.
 *
 * - The aggregate's own key composites, which `create` doesn't generate.
 * - A `ref` or `one` edge whose entity one id names: `${field}Id`, or the entity whole under the
 *   field's name.
 * - A many edge over such an entity, decided from the element's schema ({@link _CreateManyEdge}):
 *   an element that is the entity, its id or the entity whole; an element naming the field holding
 *   the entity, that field's id or the entity whole. Any other element (a union, a transformation,
 *   a field of another name or another schema, or one the type can't see the name of, under a
 *   `Schema.Class` model) is `unknown`, as 1.39.0's `create` took it.
 * - An id in its key composite's type, or its stored or JSON form where that is another kind of
 *   value ({@link _EdgeIdForms}).
 * - Sub-aggregates likewise.
 *
 * A field otherwise takes its domain value, as `Entity.put` does: neither checks the stored form
 * of a field's value at the type level, though both decode one at run time. `TFields` is the
 * aggregate schema's field schemas ({@link SchemaFieldsOf}), which a many edge's element is read
 * from.
 */
export type AggregateCreateInputType<
  TModel,
  TEdges extends Record<string, AggregateEdge | BoundSubAggregate<any, any>>,
  TPK extends ReadonlyArray<string>,
  TStamps = never,
  TFields = never,
> = _Simplify<
  {
    // The aggregate's key composites
    readonly [K in keyof TModel as K extends TPK[number] ? K : never]: TModel[K]
  } & Omit<AggregateInputType<TModel, TEdges, TPK, TStamps, TFields>, _CreateReplacedKeys<TEdges>> &
    _AllOf<{
      // A ref or one edge whose entity one id names → its id, or the entity whole
      [K in keyof TEdges & keyof TModel & string as _IsIdEdge<TEdges[K]> extends true
        ? K
        : never]: _IsOptionalIn<TModel, K> extends true
        ? _OptionalIdOrWhole<
            K,
            _EdgeIdForms<TEdges[K]>,
            | _OptionalStamps<_StripUndefined<TModel[K]>, TStamps>
            | (undefined extends TModel[K] ? undefined : never)
          >
        : _IdOrWhole<K, _EdgeIdForms<TEdges[K]>, _OptionalStamps<TModel[K], TStamps>>
    }> & {
      // Required BoundSubAggregate fields → recurse
      readonly [K in keyof TEdges as TEdges[K] extends BoundSubAggregate<any, any>
        ? _IsOptionalIn<TModel, K> extends true
          ? never
          : K
        : never]: TEdges[K] extends BoundSubAggregate<infer S, infer E>
        ? AggregateCreateInputType<Schema.Schema.Type<S>, E, [], TStamps, SchemaFieldsOf<S>>
        : never
    } & {
      // Optional BoundSubAggregate fields → recurse
      readonly [K in keyof TEdges as TEdges[K] extends BoundSubAggregate<any, any>
        ? _IsOptionalIn<TModel, K> extends true
          ? K
          : never
        : never]?: TEdges[K] extends BoundSubAggregate<infer S, infer E>
        ? AggregateCreateInputType<Schema.Schema.Type<S>, E, [], TStamps, SchemaFieldsOf<S>>
        : never
    } & {
      // Required ManyEdge fields
      readonly [K in keyof TEdges as TEdges[K] extends ManyEdge<any>
        ? _IsOptionalIn<TModel, K> extends true
          ? never
          : TEdges[K] extends { readonly inputField: infer IF extends string }
            ? IF
            : K
        : never]: K extends keyof TModel
        ? _ManyEdgeCreateInput<TModel[K], TEdges[K], TStamps, _FieldOf<TFields, K>>
        : never
    } & {
      // Optional ManyEdge fields
      readonly [K in keyof TEdges as TEdges[K] extends ManyEdge<any>
        ? _IsOptionalIn<TModel, K> extends true
          ? TEdges[K] extends { readonly inputField: infer IF extends string }
            ? IF
            : K
          : never
        : never]?: K extends keyof TModel
        ? _ManyEdgeCreateInput<TModel[K], TEdges[K], TStamps, _FieldOf<TFields, K>>
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

/**
 * The field of a `many` element `create` takes an edge's entity in (`deriveEntityFieldName`): the
 * entity model's identifier, or its `entityType`, first letter lowercased. The type sees it only for
 * a `Schema.Struct` model, alone or in a `DynamoModel.configure` wrapper, and an `entityType` that
 * is one string literal: `create` takes the `entityType` for both. Otherwise it's `never`, and the
 * element is typed as on 1.39.0 ({@link _TransformManyEdge}):
 * - a model with an identifier (a `Schema.Class`, a brand), which the type sees only as `string`:
 *   `create` takes it, or the `entityType` when the model is in a `DynamoModel.configure` wrapper,
 *   and the type can't tell the two apart;
 * - an `entityType` that isn't one string literal (`string`, a union, a pattern);
 * - any other model.
 */
type _EntityFieldName<E> = E extends {
  readonly entityType: infer T extends string
  readonly model: infer M
}
  ? M extends { readonly identifier: string }
    ? never
    : M extends Schema.Struct<Schema.Struct.Fields>
      ? _IsOneLiteral<T> extends true
        ? Uncapitalize<T>
        : never
      : never
  : never

/** Whether `S` is one string literal: not `string`, a union of literals, or a pattern. */
type _IsOneLiteral<S extends string> = string extends S
  ? false
  : true extends _IsUnion<S>
    ? false
    : {} extends Record<S, 1>
      ? false
      : true

/**
 * @internal The field schemas of a schema that declares them (a `Schema.Struct`, a `Schema.Class`):
 * `never` otherwise.
 */
export type SchemaFieldsOf<S> = S extends { readonly fields: infer F } ? F : never

/** Field `K`'s schema of `TFields`, `never` when it has none. */
type _FieldOf<TFields, K> = [TFields] extends [never]
  ? never
  : K extends keyof TFields
    ? TFields[K]
    : never

type _IsAny<T> = 0 extends 1 & T ? true : false

/**
 * A field's own schema, its `Schema.optional` / `Schema.optionalKey` taken off, as `optionalField`
 * takes them off at run time.
 */
type _UnwrapOptional<S> =
  _IsAny<S> extends true
    ? never
    : S extends Schema.optionalKey<infer I>
      ? I extends Schema.Union<readonly [infer X extends Schema.Top, Schema.Undefined]>
        ? X
        : I
      : S

/** The element schema of a `many` edge's field schema (`extractArrayElement`): `never` without one. */
type _ElementSchema<FS> =
  _UnwrapOptional<FS> extends infer A
    ? A extends Schema.$Array<infer ES>
      ? ES
      : A extends Schema.NonEmptyArray<infer ES>
        ? ES
        : never
    : never

/** Whether `A` and `B` are one schema type. */
type _SameSchema<A, B> = [A] extends [never]
  ? false
  : [B] extends [never]
    ? false
    : _IsAny<A> extends true
      ? false
      : [A] extends [B]
        ? [B] extends [A]
          ? true
          : false
        : false

/**
 * Whether a `many` element's schema (`ES`) is the entity itself (`isEntityElement`): a schema with
 * fields of its own, of the entity's model's schema type (`MS`).
 */
type _IsEntityElement<ES, MS> = [ES] extends [never]
  ? false
  : [ES] extends [{ readonly fields: unknown }]
    ? _SameSchema<ES, MS>
    : false

/**
 * Whether a `many` element's schema (`ES`) names the field holding the entity, as `create` judges
 * it (`entityFieldOf`): a schema with fields of its own (a `Schema.Struct`, a `Schema.Class`; not a
 * union, a transformation or a declaration), whose field of the entity's name (`N`,
 * {@link _EntityFieldName}) is of the entity's model's schema type (`MS`), under
 * `Schema.optional` / `Schema.optionalKey` at most, and which doesn't declare `${N}Id` itself. The
 * schema type is read, not the domain type, so a union whose members have one domain type is still
 * a union.
 */
type _NamesEntityField<ES, MS, N extends string> = [N] extends [never]
  ? false
  : [ES] extends [never]
    ? false
    : [ES] extends [{ readonly fields: infer F }]
      ? N extends keyof F
        ? `${N}Id` extends keyof F
          ? false
          : _SameSchema<_UnwrapOptional<F[N]>, MS>
        : false
      : false

/**
 * An element whose definition names the field holding the entity, given by id: `${N}Id: Id` in
 * place of field `N`, optional when it is.
 */
type _ElementById<E, Id, N extends string> = _Simplify<{
  readonly [K in keyof E as K extends N ? `${N}Id` : K]: K extends N
    ? Id | (undefined extends E[K] ? undefined : never)
    : E[K]
}>

/** An element given whole, `${N}Id` beside it optional: neither refuses the other. */
type _ElementWhole<E, Id, N extends string> = _Simplify<
  E & { readonly [P in `${N}Id`]?: Id | undefined }
>

/**
 * A many element as its input takes it beside 1.39.0's form ({@link _Element139}), for an edge
 * whose entity (model schema `MS`) one id of type `Id` names, decided from the element's schema
 * (`ES`):
 * - an element that is the entity (`Array<Umpire>`, {@link _IsEntityElement}): its id, or the
 *   entity whole;
 * - an element naming the field holding the entity ({@link _NamesEntityField}): the element whole,
 *   `${field}Id` beside it or not, or with `${field}Id: Id` in place of that field. Neither refuses
 *   the other's key: given both, `create` keeps the entity given whole, and fetches a string id as
 *   1.39.0 did.
 * - any other element: 1.39.0's form alone.
 */
type _ElementInput<E, TStamps, ES, MS, Id, N extends string> =
  _IsEntityElement<ES, MS> extends true
    ? Id | _OptionalStamps<E, TStamps>
    : _NamesEntityField<ES, MS, N> extends true
      ?
          | _OptionalStamps<_ElementWhole<E, Id, N>, TStamps>
          | _OptionalStamps<_ElementById<E, Id, N>, TStamps>
      : never

/**
 * A many edge's elements as its input takes them: every element 1.39.0's input took
 * ({@link _Element139}, with `Id139`), and, for an edge whose entity one id names, the forms
 * `create` takes an id of its key composite in ({@link _ElementInput}). Only added to 1.39.0's.
 * With no entity to fetch (`MS = never`), the elements are taken as given.
 */
type _TransformManyEdge<T, TStamps, ES, MS, Id, Id139, N extends string> =
  T extends ReadonlyArray<infer E>
    ? [MS] extends [never]
      ? ReadonlyArray<_OptionalStamps<E, TStamps>>
      : ReadonlyArray<_ElementInput<E, TStamps, ES, MS, Id, N> | _Element139<E, Id139, TStamps>>
    : T extends Readonly<Record<string, infer V>>
      ? string extends keyof T
        ? { readonly [key: string]: _OptionalStamps<V, TStamps> }
        : T
      : T

/** Detect ref-like types: objects with an `id: string` property (Schema.Class entities) */
type _IsRefLike<T> = T extends { readonly id: string }
  ? string extends keyof T
    ? false
    : true
  : false

/**
 * An element's ref-like fields ({@link _IsRefLike}) taken as `${field}Id: Id`, as 1.39.0 took them
 * (`_RefFieldsToIds` there): whatever their name, and not when the field is optional.
 */
type _RefFieldsToIds139<T, Id> = _Simplify<{
  readonly [K in keyof T as _IsRefLike<T[K]> extends true ? `${K & string}Id` : K]: _IsRefLike<
    T[K]
  > extends true
    ? Id
    : T[K]
}>

/**
 * A many element as 1.39.0 typed it (`_TransformManyEdge` there): an element that is ref-like is
 * `Id`; otherwise its ref-like fields are taken as `${field}Id: Id`.
 */
type _Element139<E, Id, TStamps> =
  _IsRefLike<E> extends true ? Id : _OptionalStamps<_RefFieldsToIds139<E, Id>, TStamps>

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
 * What a many edge's rows are: an array's elements, or a record's values (a custom `decompose`).
 * Any other object has rows only its own `decompose` knows the shape of.
 */
type ManyElement<T> =
  T extends ReadonlyArray<infer El>
    ? El
    : T extends object
      ? T extends Readonly<Record<string, infer V>>
        ? string extends keyof T
          ? V
          : unknown
        : unknown
      : never

/**
 * The attribute paths of a many edge's element that `sk.composite` may name:
 * its scalar fields, and the scalar fields one level into an object field (a
 * hydrated ref: `"umpire.id"`) — not the object itself, which the runtime
 * refuses as a non-scalar composite. Any name when the element's type is
 * unknown.
 */
export type ManyEdgeSkPaths<TField> = unknown extends TField
  ? string
  : ElementPaths<ManyElement<NonNullable<TField>>>

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
