/**
 * @internal Entity type-level computations — derived types for Entity operations.
 *
 * Extracted from Entity.ts for decomposition. Not part of the public API.
 */

import type { DateTime, Schema } from "effect"
import type { EmbeddingError, RefNotFound } from "../Errors.js"

// ---------------------------------------------------------------------------
// Type-level computations for Entity operation types
// ---------------------------------------------------------------------------

/** Extract the model's Type directly — preserves Schema.Class name (e.g. `User`) */
export type ModelType<TModel extends Schema.Top> = Schema.Schema.Type<TModel>

/** The schemas a `Schema.Struct` or `Schema.Class` model declares, else `never`. */
type DeclaredFields<TModel> = TModel extends {
  readonly fields: infer F extends Schema.Struct.Fields
}
  ? F
  : never

/**
 * The model's fields as a definition names them: field name → model type,
 * methods left out. A `Schema.Struct` or `Schema.Class` model is read from the
 * fields it declares, so the names stay known when a field's schema is a type
 * parameter (a generic entity factory). A model whose type is unknown (one
 * typed as `Schema.Top`) has any field, of unknown type, so generic code still
 * compiles and the runtime checks decide; so does one typed `never` or `any`.
 */
export type ModelFields<TModel extends Schema.Top> =
  IsAny<TModel> extends true
    ? globalThis.Record<string, unknown>
    : [DeclaredFields<TModel>] extends [never]
      ? TypeFields<TModel>
      : {
          readonly [K in keyof DeclaredFields<TModel> & string]: Schema.Schema.Type<
            DeclaredFields<TModel>[K]
          >
        }

type TypeFields<TModel extends Schema.Top> = [ModelType<TModel>] extends [never]
  ? globalThis.Record<string, unknown>
  : unknown extends ModelType<TModel>
    ? globalThis.Record<string, unknown>
    : {
        readonly [K in keyof ModelType<TModel> as K extends string
          ? ModelType<TModel>[K] extends (...args: ReadonlyArray<any>) => unknown
            ? never
            : K
          : never]: ModelType<TModel>[K]
      }

/** The names of {@link ModelFields}: what a definition may name as a model attribute. */
export type ModelFieldName<TModel extends Schema.Top> = keyof ModelFields<TModel> & string

/**
 * The model fields a stored row can be without: those whose stored side is
 * optional (`optional`, `optionalKey`, a decoding default, the
 * `OptionFromOptional` family) or includes a value with no stored form
 * (`UndefinedOr`, a set), but not `NullOr`. It is the type-level
 * {@link rowCanLack}. A model whose fields aren't declared in its type has any
 * field, so generic code still compiles and the runtime decides.
 */
export type ClearableFields<TModel extends Schema.Top> =
  IsAny<TModel> extends true
    ? string
    : [DeclaredFields<TModel>] extends [never]
      ? string
      : {
          [K in keyof DeclaredFields<TModel> & string]: DeclaredFields<TModel>[K] extends {
            readonly "~encoded.optionality": "optional"
          }
            ? K
            : StoredWithoutForm<DeclaredFields<TModel>[K]> extends true
              ? K
              : never
        }[keyof DeclaredFields<TModel> & string]

/**
 * Whether a field's stored side includes a value DynamoDB has no form for:
 * `undefined` or a set. A type can't see a `.check()` that refuses the value, so
 * a field whose set must not be empty compiles and is refused at run time.
 */
type StoredWithoutForm<S> = S extends { readonly Encoded: infer E }
  ? undefined extends E
    ? true
    : [Extract<E, ReadonlySet<any>>] extends [never]
      ? false
      : true
  : false

/**
 * The names `.remove()` takes: model fields a row can lack, less what no update
 * may clear: primary-key composites, refs, library-managed fields, and the
 * fields configured immutable or stored as a sparse map (`TUnremovable`).
 */
export type RemovableFields<
  TModel extends Schema.Top,
  TIndexes,
  TRefs,
  TTimestamps,
  TVersioned,
  TUnremovable extends string,
> =
  string extends ClearableFields<TModel>
    ? string
    : Exclude<
        ClearableFields<TModel>,
        | (string extends PrimaryKeyComposites<TIndexes> ? never : PrimaryKeyComposites<TIndexes>)
        | (keyof TRefs & string)
        | TUnremovable
        | CreatedAtFieldName<TTimestamps>
        | UpdatedAtFieldName<TTimestamps>
        | VersionFieldName<TVersioned>
      >

/**
 * The names `.append().remove()` takes: {@link RemovableFields} the entity's
 * `appendInput` declares, less the `orderBy` clock.
 */
export type AppendRemovableFields<
  TModel extends Schema.Top,
  TIndexes,
  TRefs,
  TTimeSeries,
  TTimestamps,
  TVersioned,
  TUnremovable extends string,
> = TTimeSeries extends {
  readonly orderBy: infer O
  readonly appendInput: infer A extends Schema.Top
}
  ? Exclude<
      RemovableFields<TModel, TIndexes, TRefs, TTimestamps, TVersioned, TUnremovable> &
        ModelFieldName<A>,
      string extends O ? never : O
    >
  : never

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

/** @internal The attribute `versioned` keeps its version in. */
export type VersionFieldName<TVersioned> = [TVersioned] extends [undefined | false]
  ? never
  : TVersioned extends true
    ? "version"
    : TVersioned extends { readonly field: infer F extends string }
      ? F
      : "version"

/**
 * The fields of `K` the library manages: the dates. Any other model field of that name is the
 * caller's, required or not as the model says (`resolveSystemFields`, rule b).
 */
type ManagedDateField<T, K> = {
  [P in K & keyof T]: [Exclude<T[P], undefined>] extends [DateTime.DateTime | Date] ? P : never
}[K & keyof T]

/**
 * Apply system-field collision adjustments to an input/create type:
 *   - A colliding date `createdAt`/`updatedAt` becomes optional (caller may
 *     supply or let the library auto-generate). One of any other type is the
 *     caller's own, unchanged.
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
              | ManagedDateField<T, CreatedAtFieldName<TTimestamps>>
              | ManagedDateField<T, UpdatedAtFieldName<TTimestamps, TTimeSeries>>
              | (VersionFieldName<TVersioned> & keyof T)
            > &
              Partial<
                Pick<
                  T,
                  | ManagedDateField<T, CreatedAtFieldName<TTimestamps>>
                  | ManagedDateField<T, UpdatedAtFieldName<TTimestamps, TTimeSeries>>
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
              | ManagedDateField<T, CreatedAtFieldName<TTimestamps>>
              | (VersionFieldName<TVersioned> & keyof T)
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

/**
 * Make the auto-generated id field optional on an input type.
 *
 * When an entity declares `generatedId: { field: "id" }`, the `id` field is
 * filled by the library at write time when the caller omits it. The input type
 * therefore marks the field optional (caller MAY supply it to override). The
 * record/return type keeps it required — a decoded record always carries it.
 *
 * `TGeneratedId` is the `generatedId` config (or `undefined`). When absent the
 * input type is returned unchanged.
 */
export type WithGeneratedId<T, TGeneratedId> = [TGeneratedId] extends [undefined]
  ? T
  : TGeneratedId extends { readonly field: infer F extends string }
    ? F extends keyof T
      ? Simplify<Omit<T, F> & Partial<Pick<T, F>>>
      : T
    : T

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
 * Each field's value type matches the model declaration exactly — under v3
 * there is no `null` widening. The v1.6 widening to `T | null | undefined`
 * existed to support the v1.6 three-way payload classification, which is
 * collapsed in v3 to two-way (null = undefined = absent). Combined with the
 * EDD-9025 make-time check (composite attribute schemas must not include
 * `null`), `set({ composite: null })` no longer compiles and the stale-GSI
 * footgun is closed at the type level. See `DESIGN.md §7`.
 */
export type EntityUpdateType<
  TModel extends Schema.Top,
  TIndexes,
  TTimestamps = undefined,
  TVersioned = undefined,
> = WithSystemCollisionsForUpdate<
  UpdateFields<TModel, Omit<ModelType<TModel>, PrimaryKeyComposites<TIndexes>>>,
  TTimestamps,
  TVersioned
>

/**
 * The payload's model fields. Any of them may be left out, and `undefined`
 * clears one, which only a field a row can lack takes: `.set({ note: undefined })`
 * on a required `note` is a compile error (under `exactOptionalPropertyTypes`,
 * and refused at run time either way).
 */
type UpdateFields<TModel extends Schema.Top, T> = {
  [K in keyof T]?: T[K] | (K extends ClearableFields<TModel> ? undefined : never)
}

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

/**
 * Resolve a branded identifier value type directly from an entity-shaped type
 * carrying `{ model, indexes }`. For an entity with `pk: { composite: ["id"] }`
 * and `id: TeamId`, yields `TeamId`; falls back to `string` when the entity
 * type does not expose enough information to recover the brand.
 *
 * This is the shared core used by both the Entity ref path
 * ({@link EntityIdentifierValue}, which unwraps `{ entity }` first) and the
 * Aggregate edge path, where the entity is referenced directly on the edge.
 */
export type RefEntityIdentifierValue<E> = E extends {
  readonly model: infer M extends Schema.Top
  readonly indexes: infer I
}
  ? ModelType<M>[PrimaryPkOnlyComposites<I> & keyof ModelType<M>]
  : string

/** Extract the identifier value type from a ref Entity's PK composites.
 *  For an entity with `pk: { composite: ["id"] }` and `id: TeamId`, yields `TeamId`. */
type EntityIdentifierValue<E> = RefEntityIdentifierValue<ExtractRefEntity<E>>

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
      UpdateFields<
        TModel,
        Omit<ModelType<TModel>, PrimaryKeyComposites<TIndexes> | (keyof TRefs & string)>
      > & {
        readonly [K in keyof TRefs & string as `${K}Id`]?: EntityIdentifierValue<TRefs[K]>
      },
      TTimestamps,
      TVersioned
    >

/** Error type contribution from refs — never when no refs, RefNotFound when refs present */
export type RefErrors<TRefs> = [TRefs] extends [undefined] ? never : RefNotFound

/**
 * Error type contribution from vector indexes — `never` when the entity
 * declares none, {@link EmbeddingError} when it does.
 *
 * Mirrors {@link RefErrors}: the embedding path is only reachable for entities
 * that declare `vectorIndexes`, so entities without them keep an error channel
 * that is exactly as narrow as it was before vector search existed.
 */
export type VectorErrors<TVectorIndexes> = [TVectorIndexes] extends [undefined]
  ? never
  : EmbeddingError

/** Extract pk composite names for a specific index */
export type IndexPkComposites<TIndexes, K extends keyof TIndexes> = TIndexes[K] extends {
  readonly pk: { readonly composite: infer PKC extends ReadonlyArray<string> }
}
  ? PKC[number]
  : never

/**
 * Extract sk composite names (union) for a specific index — `never` for a
 * Z-order sort key (#171): its derived `composite` lists the fields feeding the
 * address, which are bounded through `.within()`, never pinned or compared as
 * key text. Tested before `composite`, which the normalised Z-order half also
 * carries.
 */
export type IndexSkComposites<TIndexes, K extends keyof TIndexes> = TIndexes[K] extends {
  readonly sk: { readonly zorder: ReadonlyArray<unknown> }
}
  ? never
  : TIndexes[K] extends {
        readonly sk: { readonly composite: infer SKC extends ReadonlyArray<string> }
      }
    ? SKC[number]
    : never

/** The field a Z-order dimension entry names: a bare name, or its `field`. */
export type DimensionEntryField<D> = D extends string
  ? D
  : D extends { readonly field: infer F extends string }
    ? F
    : never

/** The field names of a Z-order key's declared dimensions, in declaration order. */
export type DimensionFieldNames<Z> = Z extends readonly []
  ? readonly []
  : Z extends readonly [infer Head, ...infer Tail]
    ? readonly [DimensionEntryField<Head>, ...DimensionFieldNames<Tail>]
    : Z extends ReadonlyArray<infer D>
      ? ReadonlyArray<DimensionEntryField<D>>
      : readonly []

type PrefixPartField<P> = P extends string
  ? P
  : P extends { readonly field: infer F extends string }
    ? F
    : never

type PrefixPartFields<P> = P extends readonly []
  ? readonly []
  : P extends readonly [infer Head, ...infer Tail]
    ? readonly [PrefixPartField<Head>, ...PrefixPartFields<Tail>]
    : P extends ReadonlyArray<infer Part>
      ? ReadonlyArray<PrefixPartField<Part>>
      : readonly []

/** The field names of a Z-order key's `prefix` composites (`readonly []` without one). */
export type PrefixFieldNames<SK> = SK extends { readonly prefix: infer P }
  ? PrefixPartFields<P>
  : readonly []

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

/**
 * The attributes a key composite may name, with their types: the model's
 * fields ({@link ModelFields}) plus the derived ref-id fields. What
 * `Entity.make` types `composite`, `prefix` and `zorder` from.
 */
export type KeyFields<TModel extends Schema.Top, TRefs> = ModelFields<TModel> & RefIdFields<TRefs>

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
export type CaseInsensitive<T> = T extends string ? T | Lowercase<T> : T

/** Apply CaseInsensitive to all properties of an object type */
type CaseInsensitiveProps<T> = { [K in keyof T]: CaseInsensitive<T[K]> }

/**
 * The dimensions of index `K`'s Z-order sort key (#171), keyed by field: each
 * one's declared entry (a literals entry may carry its members) and the
 * field's model value type. `never` for any other sort key.
 */
export type IndexZOrderDimensions<
  TModel extends Schema.Top,
  TIndexes,
  K extends keyof TIndexes,
  TRefs = undefined,
> = TIndexes[K] extends {
  readonly sk: { readonly zorder: infer Z extends ReadonlyArray<unknown> }
}
  ? {
      readonly [D in Z[number] as DimensionEntryField<D>]: {
        readonly dimension: D
        readonly value: DimensionEntryField<D> extends infer F extends keyof CompositeFields<
          TModel,
          TRefs
        >
          ? CompositeFields<TModel, TRefs>[F]
          : never
      }
    }
  : never

/**
 * The prefix composites of index `K`'s Z-order sort key (#171) with their
 * model value types, case-insensitive like an accessor's composites. `never`
 * for any other sort key.
 */
export type IndexZOrderPrefix<
  TModel extends Schema.Top,
  TIndexes,
  K extends keyof TIndexes,
  TRefs = undefined,
> = TIndexes[K] extends {
  readonly sk: infer SK extends { readonly zorder: ReadonlyArray<unknown> }
}
  ? CaseInsensitiveProps<
      Pick<
        CompositeFields<TModel, TRefs>,
        PrefixFieldNames<SK>[number] & keyof CompositeFields<TModel, TRefs>
      >
    >
  : never

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
