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

/**
 * Flatten an intersection of object types into a single object literal for
 * cleaner hover/IntelliSense display. Pure identity at the type level —
 * `Simplify<A & B>` is assignable to `A & B` and vice versa.
 */
export type Simplify<T> = { [K in keyof T]: T[K] } & {}

/** Detect the `any` type — needed to short-circuit conditional type computations
 *  that would otherwise distribute over `any` and produce nonsense shapes. */
type IsAny<T> = 0 extends 1 & T ? true : false

// ---------------------------------------------------------------------------
// Type-level resolution of system field names from config
// ---------------------------------------------------------------------------
// These mirror `resolveSystemFields` / `resolveTimestampField`. They cover
// the common config shapes so that type-level collision adjustments match
// the runtime. Custom field names configured via `{ field: "..." }` are
// resolved; schema-only configs (`{ schema: ... }`) fall back to default names.

type TimestampFieldName<C, Default extends string> = [C] extends [undefined]
  ? Default
  : C extends string
    ? C
    : C extends { readonly field: infer F extends string }
      ? F
      : Default

type CreatedAtFieldName<TTimestamps> = [TTimestamps] extends [undefined | false]
  ? never
  : TTimestamps extends true
    ? "createdAt"
    : TTimestamps extends { readonly created?: infer C }
      ? TimestampFieldName<C, "createdAt">
      : "createdAt"

type UpdatedAtFieldName<TTimestamps, TTimeSeries = undefined> = [TTimeSeries] extends [
  undefined | false,
]
  ? [TTimestamps] extends [undefined | false]
    ? never
    : TTimestamps extends true
      ? "updatedAt"
      : TTimestamps extends { readonly updated?: infer U }
        ? TimestampFieldName<U, "updatedAt">
        : "updatedAt"
  : never // time-series entities auto-suppress updatedAt

type VersionFieldName<TVersioned> = [TVersioned] extends [undefined | false]
  ? never
  : TVersioned extends true
    ? "version"
    : TVersioned extends { readonly field: infer F extends string }
      ? F
      : "version"

/**
 * Apply system-field collision adjustments to an input/create type:
 *   - Colliding `createdAt`/`updatedAt` become optional (caller may supply or
 *     let the library auto-generate).
 *   - Colliding `version` is stripped entirely (optimistic locking requires
 *     library-managed increment).
 */
export type WithSystemCollisions<T, TTimestamps, TVersioned, TTimeSeries = undefined> =
  IsAny<T> extends true
    ? T
    : IsAny<TTimestamps> extends true
      ? T
      : IsAny<TVersioned> extends true
        ? T
        : Simplify<
            Omit<
              T,
              | (CreatedAtFieldName<TTimestamps> & keyof T)
              | (UpdatedAtFieldName<TTimestamps, TTimeSeries> & keyof T)
              | (VersionFieldName<TVersioned> & keyof T)
            > &
              Partial<
                Pick<
                  T,
                  | (CreatedAtFieldName<TTimestamps> & keyof T)
                  | (UpdatedAtFieldName<TTimestamps, TTimeSeries> & keyof T)
                >
              >
          >

/**
 * Apply system-field collision adjustments to an update type. `createdAt` is
 * treated as immutable (stripped entirely); `updatedAt` stays optional (it
 * already is, via `Partial`); `version` is stripped.
 */
export type WithSystemCollisionsForUpdate<T, TTimestamps, TVersioned> =
  IsAny<T> extends true
    ? T
    : IsAny<TTimestamps> extends true
      ? T
      : IsAny<TVersioned> extends true
        ? T
        : Simplify<
            Omit<
              T,
              (CreatedAtFieldName<TTimestamps> & keyof T) | (VersionFieldName<TVersioned> & keyof T)
            >
          >

/** Extract primary key composite attribute names as a string union */
export type PrimaryKeyComposites<TIndexes> = TIndexes extends {
  readonly primary: {
    readonly pk: { readonly composite: infer PKC extends ReadonlyArray<string> }
    readonly sk: { readonly composite: infer SKC extends ReadonlyArray<string> }
  }
}
  ? PKC[number] | SKC[number]
  : string

/** Compute system fields added by timestamps and versioned config.
 *
 * Time-series entities auto-suppress `updatedAt` — the `orderBy` attribute IS
 * the update clock. `createdAt` is preserved and set via `if_not_exists`.
 */
export type SystemFieldsType<TTimestamps, TVersioned, TTimeSeries = undefined> = ([
  TTimestamps,
] extends [undefined]
  ? {}
  : [TTimestamps] extends [false]
    ? {}
    : [TTimeSeries] extends [undefined | false]
      ? { readonly createdAt: DateTime.Utc; readonly updatedAt: DateTime.Utc }
      : { readonly createdAt: DateTime.Utc }) &
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
  TTimeSeries = undefined,
> = ModelType<TModel> & SystemFieldsType<TTimestamps, TVersioned, TTimeSeries>

/** Entity input type: model fields with system-colliding fields adjusted. */
export type EntityInputType<
  TModel extends Schema.Top,
  TTimestamps = undefined,
  TVersioned = undefined,
  TTimeSeries = undefined,
> = WithSystemCollisions<ModelType<TModel>, TTimestamps, TVersioned, TTimeSeries>

/** Entity create type: input fields minus identifier (or PK composites as fallback) */
export type EntityCreateType<
  TModel extends Schema.Top,
  TIndexes,
  TIdentifier extends string | undefined,
  TTimestamps = undefined,
  TVersioned = undefined,
  TTimeSeries = undefined,
> = WithSystemCollisions<
  [TIdentifier] extends [string]
    ? Omit<ModelType<TModel>, TIdentifier>
    : Omit<ModelType<TModel>, PrimaryKeyComposites<TIndexes>>,
  TTimestamps,
  TVersioned,
  TTimeSeries
>

/**
 * Entity update type: partial model fields minus primary key composites.
 *
 * Each field's value type is widened to `T | null | undefined` to support
 * indexPolicy v2's three-way payload classification: passing `null` or
 * `undefined` is an explicit clear signal that cascades to the GSI keys
 * (REMOVE the attribute, drop or truncate the GSI per policy). See
 * `DESIGN.md §7 Policy-Aware GSI Composition`.
 */
export type EntityUpdateType<
  TModel extends Schema.Top,
  TIndexes,
  TTimestamps = undefined,
  TVersioned = undefined,
> = WithSystemCollisionsForUpdate<
  {
    [K in keyof Omit<ModelType<TModel>, PrimaryKeyComposites<TIndexes>>]?:
      | Omit<ModelType<TModel>, PrimaryKeyComposites<TIndexes>>[K]
      | null
      | undefined
  },
  TTimestamps,
  TVersioned
>

/**
 * Input type for `.append()` on a time-series entity.
 *
 * Derived from the required `appendInput` schema. Always includes `orderBy`
 * plus all PK/SK composite fields (enforced at `Entity.make()` time).
 */
export type AppendInputType<TAppendInput> = [TAppendInput] extends [Schema.Top]
  ? Schema.Schema.Type<TAppendInput>
  : never

/**
 * Success type of `.append()` (default path) — `{ current: Model }`.
 *
 * Stale outcomes are surfaced on the Effect ERROR channel as
 * `StaleAppend` (CAS rejected) or `ConditionalCheckFailed` (user-supplied
 * `.condition()` rejected while CAS held). `.skipFollowUp()` narrows the
 * success channel to `void` and collapses both error modes into
 * `StaleAppend` (cannot disambiguate without the follow-up GetItem).
 */
export type AppendSuccess<TModel extends Schema.Top> = {
  readonly current: ModelType<TModel>
}

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
export type EntityRefInputType<
  TModel extends Schema.Top,
  TRefs,
  TTimestamps = undefined,
  TVersioned = undefined,
  TTimeSeries = undefined,
> = [TRefs] extends [undefined]
  ? EntityInputType<TModel, TTimestamps, TVersioned, TTimeSeries>
  : WithSystemCollisions<
      Omit<ModelType<TModel>, keyof TRefs & string> & {
        readonly [K in keyof TRefs & string as `${K}Id`]: EntityIdentifierValue<TRefs[K]>
      },
      TTimestamps,
      TVersioned,
      TTimeSeries
    >

/** Entity ref create type: input minus identifier (or PK composites), ref-aware */
export type EntityRefCreateType<
  TModel extends Schema.Top,
  TIndexes,
  TRefs,
  TIdentifier extends string | undefined,
  TTimestamps = undefined,
  TVersioned = undefined,
  TTimeSeries = undefined,
> = [TRefs] extends [undefined]
  ? EntityCreateType<TModel, TIndexes, TIdentifier, TTimestamps, TVersioned, TTimeSeries>
  : WithSystemCollisions<
      [TIdentifier] extends [string]
        ? Omit<
            Omit<ModelType<TModel>, keyof TRefs & string> & {
              readonly [K in keyof TRefs & string as `${K}Id`]: EntityIdentifierValue<TRefs[K]>
            },
            TIdentifier
          >
        : Omit<
            Omit<ModelType<TModel>, keyof TRefs & string> & {
              readonly [K in keyof TRefs & string as `${K}Id`]: EntityIdentifierValue<TRefs[K]>
            },
            PrimaryKeyComposites<TIndexes>
          >,
      TTimestamps,
      TVersioned,
      TTimeSeries
    >

/** Entity ref update type: when refs present, swap ref fields for optional branded ID fields */
export type EntityRefUpdateType<
  TModel extends Schema.Top,
  TIndexes,
  TRefs,
  TTimestamps = undefined,
  TVersioned = undefined,
> = [TRefs] extends [undefined]
  ? EntityUpdateType<TModel, TIndexes, TTimestamps, TVersioned>
  : WithSystemCollisionsForUpdate<
      Partial<Omit<ModelType<TModel>, PrimaryKeyComposites<TIndexes> | (keyof TRefs & string)>> & {
        readonly [K in keyof TRefs & string as `${K}Id`]?: EntityIdentifierValue<TRefs[K]>
      },
      TTimestamps,
      TVersioned
    >

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

/**
 * Map a refs config object to its derived `${ref}Id` field map.
 *
 * For `{ team: { entity: TeamEntity }, player: { entity: PlayerEntity } }` this yields
 * `{ teamId: TeamId, playerId: PlayerId }`, using each referenced entity's identifier
 * value type (branded when available, falling back to `string`).
 */
type RefIdFields<TRefs> = [TRefs] extends [undefined]
  ? {}
  : { readonly [K in keyof TRefs & string as `${K}Id`]: EntityIdentifierValue<TRefs[K]> }

/**
 * Composite-resolvable fields for an entity: model fields plus the derived ref-id
 * fields. This is the canonical lookup table for resolving the value type of a
 * composite key name like `playerId` (which lives on the ref, not on the model).
 */
type CompositeFields<TModel extends Schema.Top, TRefs> = ModelType<TModel> & RefIdFields<TRefs>

/** Pick SK composite fields from the model (or refs) with their actual types. */
export type IndexSkFields<
  TModel extends Schema.Top,
  TIndexes,
  K extends keyof TIndexes,
  TRefs = undefined,
> = Pick<
  CompositeFields<TModel, TRefs>,
  IndexSkComposites<TIndexes, K> & keyof CompositeFields<TModel, TRefs>
>

/**
 * Widen string literal types to include their lowercase variants.
 * Since the key composer applies casing (default: lowercase) to composite values,
 * queries should accept both `"Male"` and `"male"` for indexed attributes.
 * Non-string types pass through unchanged.
 */
type CaseInsensitive<T> = T extends string ? T | Lowercase<T> : T

/** Apply CaseInsensitive to all properties of an object type */
type CaseInsensitiveProps<T> = { [K in keyof T]: CaseInsensitive<T[K]> }

/**
 * Compute the typed query input for a specific index.
 * PK composites are required. SK composites are optional.
 * SK prefix ordering is enforced at runtime.
 * String literal types are widened to include lowercase variants.
 *
 * When `TRefs` is provided, ref-derived composite names (e.g. `teamId` for a
 * `team: Team.pipe(DynamoModel.ref)` field) resolve to the referenced entity's
 * branded identifier type. Without this, an index whose pk composite references
 * a renamed ref field would silently collapse to `Pick<Model, never>`.
 */
export type IndexPkInput<
  TModel extends Schema.Top,
  TIndexes,
  K extends keyof TIndexes,
  TRefs = undefined,
> = Simplify<
  CaseInsensitiveProps<
    Pick<
      CompositeFields<TModel, TRefs>,
      IndexPkComposites<TIndexes, K> & keyof CompositeFields<TModel, TRefs>
    >
  > &
    Partial<
      CaseInsensitiveProps<
        Pick<
          CompositeFields<TModel, TRefs>,
          IndexSkComposites<TIndexes, K> & keyof CompositeFields<TModel, TRefs>
        >
      >
    >
>
