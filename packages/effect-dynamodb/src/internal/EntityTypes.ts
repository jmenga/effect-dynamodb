/**
 * @internal Entity type-level computations — derived types for Entity operations.
 *
 * Extracted from Entity.ts for decomposition. Not part of the public API.
 */

import type { DateTime, Schema } from "effect"
import type { RefNotFound } from "../Errors.js"

// ---------------------------------------------------------------------------
// Type-level computations for Entity operation types
// ---------------------------------------------------------------------------

/** Extract the model's Type directly — preserves Schema.Class name (e.g. `User`) */
export type ModelType<TModel extends Schema.Top> = Schema.Schema.Type<TModel>

/** Extract primary key composite attribute names as a string union */
export type PrimaryKeyComposites<TIndexes> = TIndexes extends {
  readonly primary: {
    readonly pk: { readonly composite: infer PKC extends ReadonlyArray<string> }
    readonly sk: { readonly composite: infer SKC extends ReadonlyArray<string> }
  }
}
  ? PKC[number] | SKC[number]
  : string

/** Compute system fields added by timestamps and versioned config */
export type SystemFieldsType<TTimestamps, TVersioned> = ([TTimestamps] extends [undefined]
  ? {}
  : [TTimestamps] extends [false]
    ? {}
    : { readonly createdAt: DateTime.Utc; readonly updatedAt: DateTime.Utc }) &
  ([TVersioned] extends [undefined]
    ? {}
    : [TVersioned] extends [false]
      ? {}
      : { readonly version: number })

/** Entity key type: Pick model fields by primary key composites */
export type EntityKeyType<TModel extends Schema.Top, TIndexes> = Pick<
  ModelType<TModel>,
  PrimaryKeyComposites<TIndexes> & keyof ModelType<TModel>
>

/** Entity record type: model fields + system fields */
export type EntityRecordType<
  TModel extends Schema.Top,
  TTimestamps,
  TVersioned,
> = ModelType<TModel> & SystemFieldsType<TTimestamps, TVersioned>

/** Entity input type: same as model fields (system fields auto-managed) */
export type EntityInputType<TModel extends Schema.Top> = ModelType<TModel>

/** Entity create type: input fields minus identifier (or PK composites as fallback) */
export type EntityCreateType<
  TModel extends Schema.Top,
  TIndexes,
  TIdentifier extends string | undefined,
> = [TIdentifier] extends [string]
  ? Omit<ModelType<TModel>, TIdentifier>
  : Omit<ModelType<TModel>, PrimaryKeyComposites<TIndexes>>

/** Entity update type: partial model fields minus primary key composites */
export type EntityUpdateType<TModel extends Schema.Top, TIndexes> = Partial<
  Omit<ModelType<TModel>, PrimaryKeyComposites<TIndexes>>
>

// ---------------------------------------------------------------------------
// Ref-aware type computations
// ---------------------------------------------------------------------------

/** Extract PK-only composite attribute names (excludes SK) */
type PrimaryPkOnlyComposites<TIndexes> = TIndexes extends {
  readonly primary: {
    readonly pk: { readonly composite: infer PKC extends ReadonlyArray<string> }
  }
}
  ? PKC[number]
  : never

/** Extract the Entity from a ref value `{ entity: Entity, cascade?: ... }`. */
export type ExtractRefEntity<R> = R extends { readonly entity: infer E } ? E : never

/** Extract the identifier value type from a ref Entity's PK composites.
 *  For an entity with `pk: { composite: ["id"] }` and `id: TeamId`, yields `TeamId`. */
type EntityIdentifierValue<E> =
  ExtractRefEntity<E> extends {
    readonly model: infer M extends Schema.Top
    readonly indexes: infer I
  }
    ? ModelType<M>[PrimaryPkOnlyComposites<I> & keyof ModelType<M>]
    : string

/** Entity ref input type: when refs present, replace ref fields with branded ID fields */
export type EntityRefInputType<TModel extends Schema.Top, TRefs> = [TRefs] extends [undefined]
  ? ModelType<TModel>
  : Omit<ModelType<TModel>, keyof TRefs & string> & {
      readonly [K in keyof TRefs & string as `${K}Id`]: EntityIdentifierValue<TRefs[K]>
    }

/** Entity ref create type: input minus identifier (or PK composites), ref-aware */
export type EntityRefCreateType<
  TModel extends Schema.Top,
  TIndexes,
  TRefs,
  TIdentifier extends string | undefined,
> = [TRefs] extends [undefined]
  ? EntityCreateType<TModel, TIndexes, TIdentifier>
  : [TIdentifier] extends [string]
    ? Omit<EntityRefInputType<TModel, TRefs>, TIdentifier>
    : Omit<EntityRefInputType<TModel, TRefs>, PrimaryKeyComposites<TIndexes>>

/** Entity ref update type: when refs present, swap ref fields for optional branded ID fields */
export type EntityRefUpdateType<TModel extends Schema.Top, TIndexes, TRefs> = [TRefs] extends [
  undefined,
]
  ? EntityUpdateType<TModel, TIndexes>
  : Partial<Omit<ModelType<TModel>, PrimaryKeyComposites<TIndexes> | (keyof TRefs & string)>> & {
      readonly [K in keyof TRefs & string as `${K}Id`]?: EntityIdentifierValue<TRefs[K]>
    }

/** Error type contribution from refs — never when no refs, RefNotFound when refs present */
export type RefErrors<TRefs> = [TRefs] extends [undefined] ? never : RefNotFound

/** Extract pk composite names for a specific index */
export type IndexPkComposites<TIndexes, K extends keyof TIndexes> = TIndexes[K] extends {
  readonly pk: { readonly composite: infer PKC extends ReadonlyArray<string> }
}
  ? PKC[number]
  : never

/** Extract sk composite names (union) for a specific index */
export type IndexSkComposites<TIndexes, K extends keyof TIndexes> = TIndexes[K] extends {
  readonly sk: { readonly composite: infer SKC extends ReadonlyArray<string> }
}
  ? SKC[number]
  : never

/** Pick SK composite fields from the model with their actual types. */
export type IndexSkFields<
  TModel extends Schema.Top,
  TIndexes,
  K extends keyof TIndexes,
> = Pick<ModelType<TModel>, IndexSkComposites<TIndexes, K> & keyof ModelType<TModel>>

/**
 * Widen string literal types to include their lowercase variants.
 * Since the key composer applies casing (default: lowercase) to composite values,
 * queries should accept both `"Male"` and `"male"` for indexed attributes.
 * Non-string types pass through unchanged.
 */
type CaseInsensitive<T> = T extends string ? T | Lowercase<T> : T

/** Apply CaseInsensitive to all properties of an object type */
type CaseInsensitiveProps<T> = { [K in keyof T]: CaseInsensitive<T[K]> }

/** Flatten an intersection into a plain object type for clean IDE hover display */
type Simplify<T> = { [K in keyof T]: T[K] } & {}

/**
 * Compute the typed query input for a specific index.
 * PK composites are required. SK composites are optional.
 * SK prefix ordering is enforced at runtime.
 * String literal types are widened to include lowercase variants.
 */
export type IndexPkInput<
  TModel extends Schema.Top,
  TIndexes,
  K extends keyof TIndexes,
> = Simplify<
  CaseInsensitiveProps<
    Pick<ModelType<TModel>, IndexPkComposites<TIndexes, K> & keyof ModelType<TModel>>
  > &
    Partial<
      CaseInsensitiveProps<
        Pick<ModelType<TModel>, IndexSkComposites<TIndexes, K> & keyof ModelType<TModel>>
      >
    >
>
