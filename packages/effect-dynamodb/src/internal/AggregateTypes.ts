/**
 * @internal Aggregate type-level computations — derived types for Aggregate operations.
 *
 * Extracted from Aggregate.ts for decomposition. Not part of the public API.
 */

import type { Schema } from "effect"
import type { DiscriminatorConfig, UpdateContext } from "./AggregateCursor.js"
import type { AggregateEdge, ManyEdge, OneEdge, RefEdge } from "./AggregateEdges.js"

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
 * Compute the aggregate input type from the domain model, edges, and PK composites.
 *
 * - OneEdge / RefEdge fields → `${field}Id: string`
 * - BoundSubAggregate fields → recursed
 * - ManyEdge fields → array elements recursed for ref replacement
 * - PK composites → omitted
 * - Everything else → kept as-is
 */
export type AggregateInputType<
  TModel,
  TEdges extends Record<string, AggregateEdge | BoundSubAggregate<any, any>>,
  TPK extends ReadonlyArray<string>,
> = _Simplify<
  // Regular fields: not an edge, not a PK composite
  {
    readonly [K in keyof TModel as K extends keyof TEdges
      ? never
      : K extends TPK[number]
        ? never
        : K]: _StripUndefined<TModel[K]>
  } & {
    // Required OneEdge / RefEdge fields → ${name}Id: string
    readonly [K in keyof TEdges as TEdges[K] extends OneEdge | RefEdge
      ? _IsOptionalIn<TModel, K> extends true
        ? never
        : `${K & string}Id`
      : never]: string
  } & {
    // Optional OneEdge / RefEdge fields → ${name}Id?: string
    readonly [K in keyof TEdges as TEdges[K] extends OneEdge | RefEdge
      ? _IsOptionalIn<TModel, K> extends true
        ? `${K & string}Id`
        : never
      : never]?: string
  } & {
    // Required BoundSubAggregate fields → recurse
    readonly [K in keyof TEdges as TEdges[K] extends BoundSubAggregate<any, any>
      ? _IsOptionalIn<TModel, K> extends true
        ? never
        : K
      : never]: TEdges[K] extends BoundSubAggregate<infer S, infer E>
      ? AggregateInputType<Schema.Schema.Type<S>, E, []>
      : never
  } & {
    // Optional BoundSubAggregate fields → recurse
    readonly [K in keyof TEdges as TEdges[K] extends BoundSubAggregate<any, any>
      ? _IsOptionalIn<TModel, K> extends true
        ? K
        : never
      : never]?: TEdges[K] extends BoundSubAggregate<infer S, infer E>
      ? AggregateInputType<Schema.Schema.Type<S>, E, []>
      : never
  } & {
    // Required ManyEdge fields → transform array elements
    // When inputField is set, use it as the output key name
    readonly [K in keyof TEdges as TEdges[K] extends ManyEdge
      ? _IsOptionalIn<TModel, K> extends true
        ? never
        : TEdges[K] extends { readonly inputField: infer IF extends string }
          ? IF
          : K
      : never]: K extends keyof TModel ? _TransformManyEdge<TModel[K]> : never
  } & {
    // Optional ManyEdge fields → transform array elements
    readonly [K in keyof TEdges as TEdges[K] extends ManyEdge
      ? _IsOptionalIn<TModel, K> extends true
        ? TEdges[K] extends { readonly inputField: infer IF extends string }
          ? IF
          : K
        : never
      : never]?: K extends keyof TModel ? _TransformManyEdge<TModel[K]> : never
  }
>

/** Detect ref-like types: objects with an `id: string` property (Schema.Class entities) */
type _IsRefLike<T> = T extends { readonly id: string }
  ? string extends keyof T
    ? false
    : true
  : false

/** Transform an object's ref-like fields to `${field}Id: string` */
type _RefFieldsToIds<T> = _Simplify<{
  readonly [K in keyof T as _IsRefLike<T[K]> extends true ? `${K & string}Id` : K]: _IsRefLike<
    T[K]
  > extends true
    ? string
    : T[K]
}>

/** Distribute over unions (e.g., ReadonlyArray<T> | undefined) to transform array elements */
type _TransformManyEdge<T> =
  T extends ReadonlyArray<infer E>
    ? _IsRefLike<E> extends true
      ? ReadonlyArray<string>
      : ReadonlyArray<_RefFieldsToIds<E>>
    : T

/** Check if key K is an optional property of T */
type _IsOptionalIn<T, K> = K extends keyof T ? ({} extends Pick<T, K> ? true : false) : false

/** Strip `undefined` from optional field value types — the `?` modifier already expresses optionality */
type _StripUndefined<T> = undefined extends T ? Exclude<T, undefined> : T

/** Flatten intersection types — `extends infer O` breaks the alias chain for eager IDE expansion */
type _Simplify<T> = T extends infer O ? { [K in keyof O]: O[K] } : never
