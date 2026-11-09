/**
 * Entity (pure definition layer) — builds the AWS-free half of an Entity:
 * the domain model binding, primary key + index definitions, system-field
 * configuration, unique constraints, and the derived schemas (`inputSchema`,
 * `updateSchema`, `createSchema`).
 *
 * This module is AWS-SDK-free in BOTH its runtime import graph and its
 * emitted `.d.ts` surface. The full `effect-dynamodb` package extends the
 * {@link EntityDefinition} produced here with the AWS-coupled CRUD/query
 * operations (DynamoClient, Marshaller, expression compilation), reusing
 * {@link buildEntityDefinition} so the derivation has a single source of truth.
 *
 * `Entity.make()` here returns a pure {@link EntityDefinition}. Consumers who
 * only need the derived schemas (e.g. HttpApi payloads, validation) can import
 * it from `@effect-dynamodb/schema` without pulling the AWS SDK into their
 * dependency graph or type surface.
 */

import { Duration, Option, type Schema, SchemaAST } from "effect"
import {
  type ConfiguredModel,
  type DynamoEncoding,
  type ExtractIdentifier,
  type ExtractPackedFields,
  type ExtractUnremovableFields,
  getIdentifierField,
  getPackedFields,
  getSparseFields,
  isConfiguredModel,
  isHidden,
  isRecordAst,
  isRecordSchema,
  isRef,
  isRefField,
  type PackedConfig,
  type SparseConfig,
} from "./DynamoModel.js"
import * as DynamoSchema from "./DynamoSchema.js"
import { makeCompositeNullableError } from "./Errors.js"
import type { RefEntity } from "./internal/AggregateEdges.js"
import { bothKindsKeyRefusal, keyFormValueKind } from "./internal/CompositeCodec.js"
import type {
  CascadeIndexConfig,
  GeneratedIdConfig,
  SoftDeleteConfig,
  TimeSeriesConfig,
  TimestampsConfig,
  UniqueConfig,
  UniqueConstraintDef,
  VersionedConfig,
} from "./internal/EntityConfig.js"
import { packedIndexRefusal, resolvePackedPlan } from "./internal/EntityPacked.js"
import {
  allCompositeAttributes,
  buildDerivedSchemas,
  buildFieldEncodings,
  type DerivedSchemas,
  getFields,
  getSchemaFields,
  optionalField,
  type ResolvedSystemFields,
  resolveFieldEncoding,
  resolveSystemFields,
  resolveUniqueFields,
  validateNoTransformOverride,
} from "./internal/EntitySchemas.js"
import type {
  DimensionFieldNames,
  EntityRefCreateType,
  EntityRefInputType,
  EntityRefUpdateType,
  KeyFields,
  ModelFieldName,
  PrefixFieldNames,
  VersionFieldName,
} from "./internal/EntityTypes.js"
import { refuseUnreadable } from "./internal/SchemaAccessors.js"
import { isShardSourceError } from "./internal/Shards.js"
import {
  refuseRepeatedIndex,
  refuseSharedKeyAttributeOnEverySchema,
  refuseStoredInTableKey,
  refuseStoredUnderLibraryAttribute,
} from "./internal/SharedKeyAttribute.js"
import {
  type BoundDimension,
  bindDimension,
  MAX_ADDRESS_BITS,
  MAX_DIMENSION_BITS,
  makeLayout,
} from "./internal/ZOrderCurve.js"
import { type DimensionField, resolveDimension } from "./internal/ZOrderDimension.js"
import type {
  GsiConfig,
  IndexDefinition,
  IndexShards,
  KeyPart,
  ZOrderKeyPart,
  ZOrderSkPart,
} from "./KeyComposer.js"
import {
  composeGsiKeysForUpdatePolicyAware,
  isZOrderHalf,
  normalizeGsiConfig,
} from "./KeyComposer.js"
import type { VectorIndexConfig, VectorIndexDefinition } from "./VectorIndex.js"
import {
  deriveVectorFilterTypes,
  normalizeVectorIndexConfig,
  validateVectorIndexes,
} from "./VectorIndex.js"
import type { DimensionFor } from "./ZOrder.js"

// ---------------------------------------------------------------------------
// Re-export KeyComposer types for convenience
// ---------------------------------------------------------------------------

export type { IndexDefinition, KeyPart, ZOrderKeyPart }

/**
 * A ref config object: the entity and optional cascade index config.
 *
 * `entity` is typed against the structural {@link RefEntity} carrier — the
 * minimal `{ _tag, entityType, model, indexes, schemas }` shape that BOTH a pure
 * `EntityDefinition` and a runtime `Entity` satisfy. This is what lets a single
 * `AnyRefValue` be shared across the schema and runtime packages (the runtime
 * `Entity` carries `_configure` with a narrower param than the pure definition,
 * so neither full entity type is assignable to the other — but both satisfy
 * `RefEntity`). It also means a ref target may be authored in either package.
 */
export interface AnyRefValue {
  readonly entity: RefEntity
  readonly cascade?: CascadeIndexConfig
}

// ---------------------------------------------------------------------------
// TTL helpers (pure — Duration parsing only)
// ---------------------------------------------------------------------------

/**
 * Normalize a TTL config value to whole seconds.
 *
 * Accepts a `Duration.Duration` or a humanized string (e.g. `"7 days"`,
 * `"24 hours"`), parsed via Effect's `Duration` input grammar. A bare `number`
 * is intentionally NOT accepted at the type level — `Duration.fromInput` treats
 * a number as **milliseconds**, so `3600` would silently mean 3.6 s (a 1000×
 * footgun); callers must pass `Duration.seconds(3600)` or `"3600 seconds"`.
 *
 * Throws `[EDD-9005]` for a non-finite (infinite) duration — an infinite TTL
 * epoch is nonsensical. {@link make} validates every configured TTL eagerly via
 * this helper, so the write path never observes an invalid value.
 */
export const normalizeTtlSeconds = (input: Duration.Duration | string): number => {
  let duration: Duration.Duration
  if (typeof input === "string") {
    const parsed = Duration.fromInput(input as Duration.Input)
    if (Option.isNone(parsed)) {
      throw new Error(
        `[EDD-9005] TTL string "${input}" is not a valid duration (expected e.g. "7 days", "24 hours", "30 minutes").`,
      )
    }
    duration = parsed.value
  } else {
    duration = input
  }
  const seconds = Duration.toSeconds(duration)
  if (!Number.isFinite(seconds)) {
    const shown = typeof input === "string" ? `"${input}"` : "the provided Duration"
    throw new Error(
      `[EDD-9005] TTL must resolve to a finite duration; ${shown} resolves to a non-finite (infinite) TTL, which is not a valid DynamoDB TTL epoch.`,
    )
  }
  return seconds
}

/**
 * Extract the optional TTL from a unique-constraint definition. Only the object
 * form (`{ fields, ttl }`) carries a TTL; the bare-array form never does.
 *
 * @internal
 */
export const resolveUniqueTtl = (
  def: UniqueConstraintDef,
): Duration.Duration | string | undefined =>
  typeof def === "object" && !Array.isArray(def) && "ttl" in def ? def.ttl : undefined

// ---------------------------------------------------------------------------
// Index normalization types
// ---------------------------------------------------------------------------

/**
 * @internal The normalised indexes type from `primaryKey` + optional GSI
 * configs. Shared with the runtime `Entity.make` in `effect-dynamodb`.
 */
export type NormalizedIndexes<
  TPrimaryKey extends PrimaryKeyDef,
  TGsiIndexes extends globalThis.Record<string, GsiConfig<any>>,
> = keyof TGsiIndexes extends never
  ? { readonly primary: TPrimaryKey }
  : { readonly primary: TPrimaryKey } & {
      readonly [K in keyof TGsiIndexes & string]: NormalizedGsi<TGsiIndexes[K]>
    }

/**
 * One normalised GSI. A Z-order sort key (#171) keeps its declaration on the
 * type — `zorder` and `prefix` are phantom carriers for the accessor typing
 * (the runtime value has `zorderHalf`) — beside the derived `composite`.
 */
type NormalizedGsi<G extends GsiConfig<any>> = G["sk"] extends {
  readonly zorder: infer Z extends ReadonlyArray<unknown>
}
  ? IndexDefinition & {
      readonly collection: G["collection"]
      readonly pk: { readonly composite: G["pk"]["composite"] }
      readonly sk: ZOrderSkPart & {
        readonly composite: readonly [...PrefixFieldNames<G["sk"]>, ...DimensionFieldNames<Z>]
        readonly zorder: Z
        readonly prefix: G["sk"] extends { readonly prefix: infer P } ? P : readonly []
      }
    }
  : IndexDefinition & {
      readonly collection: G["collection"]
      readonly pk: { readonly composite: G["pk"]["composite"] }
      readonly sk: {
        readonly composite: G["sk"] extends { readonly composite: infer C } ? C : never
      }
    }

/**
 * @internal Primary key definition — the `primaryKey` config form. `F` is the
 * attribute names a composite may name: on `Entity.make`, the model's fields
 * plus ref-derived ids ({@link KeyFields}). At least one half has a composite.
 */
export type PrimaryKeyDef<F extends string = string> = Omit<
  IndexDefinition,
  "pk" | "sk" | "shards"
> & {
  readonly pk: KeyPart<F>
  readonly sk: KeyPart<F>
  /** A table's primary key can't be sharded: `shards` is an index option. */
  readonly shards?: never
} & (
    | { readonly pk: { readonly composite: readonly [F, ...F[]] } }
    | { readonly sk: { readonly composite: readonly [F, ...F[]] } }
  )

/**
 * @internal The configs of `Entity.make` that name model attributes, typed
 * from the model (`TModel`) and the refs config (`TRefs`). Shared with the
 * runtime `Entity.make` in `effect-dynamodb`, so both reject a misspelled
 * attribute name at compile time and complete the names in an editor.
 */
export type EntityPrimaryKeyConfig<TModel extends Schema.Top, TRefs> = PrimaryKeyDef<
  keyof KeyFields<TModel, TRefs> & string
>

/** @internal See {@link EntityPrimaryKeyConfig}: the secondary indexes. */
export type EntityIndexesConfig<TModel extends Schema.Top, TRefs> = globalThis.Record<
  string,
  GsiConfig<KeyFields<TModel, TRefs>>
>

/** @internal See {@link EntityPrimaryKeyConfig}: unique constraints over model fields. */
export type EntityUniqueConfig<TModel extends Schema.Top> = UniqueConfig<ModelFieldName<TModel>>

/**
 * @internal See {@link EntityPrimaryKeyConfig}: refs keyed by the model's
 * (ref) fields. The record half keeps it a `Record<string, AnyRefValue>`; the
 * keyed half gives an editor the field names. A key that is not a model field
 * is refused by {@link RefsKeyGuard} on the config.
 */
export type EntityRefsConfig<TModel extends Schema.Top> = globalThis.Record<string, AnyRefValue> & {
  readonly [K in ModelFieldName<TModel>]?: AnyRefValue
}

/**
 * @internal The keys of the refs as written (`TRefs`) that are not model
 * fields, each typed `never`, so the error lands on the misspelled key. Keyed
 * by remapping (`as`), not `Exclude`: the `Exclude` form, beside the indexes
 * constraint that also reads `TRefs`, made `Parameters<typeof Entity.make>`
 * resolve to `never`.
 */
export type RefsKeyGuard<TModel extends Schema.Top, TRefs> = {
  readonly [K in keyof TRefs as K extends ModelFieldName<TModel> ? never : K]: never
}

/** Every option an entry of some kind takes, for an entry whose field the guard can't look up. */
type AnyEntryKey = "field" | "min" | "max" | "step" | "from" | "unit" | "bits" | "values" | "bytes"

/** The keys the entries over field `F` take (a bare name contributes none). */
type EntryKeysOf<D> = D extends string ? never : keyof D

/** The keys an object entry may carry: those of the entries its field's type takes. */
type AllowedEntryKeys<E, TFields> = E extends { readonly field: infer F extends string }
  ? F extends keyof TFields
    ? EntryKeysOf<DimensionFor<F, TFields[F]>>
    : AnyEntryKey
  : AnyEntryKey

/**
 * @internal Over the indexes as written (`TIndexes`): on each Z-order sort
 * key, every key of a `zorder` entry its field's entries don't take, and every
 * key of a `{ field, hash }` prefix part but those two, typed `never`, so a
 * misspelled option (`stpe`) is an error on that entry. Like
 * {@link RefsKeyGuard}, a guard on the config: in the indexes' constraint it
 * loses the editor's completions.
 */
export type ZOrderEntriesGuard<TIndexes, TFields> = {
  readonly [K in keyof TIndexes]: (TIndexes[K] extends { readonly sk: infer SK }
    ? { readonly sk: ZOrderHalfGuard<SK, TFields> }
    : unknown) &
    ShardsByGuard<TIndexes[K]>
}

/**
 * @internal A `shards.by` names sort key composites of its own index (#183): any
 * other attribute, or any attribute on a Z-order half (no accessor can pin its
 * dimensions), is an error on that entry. The constraint already checks each name
 * against the model; `Entity.make` checks again at runtime (`EDD-9102`).
 */
type ShardsByGuard<TEntry> = TEntry extends { readonly shards: { readonly by: unknown } }
  ? {
      readonly shards: {
        readonly by: ReadonlyArray<
          TEntry extends {
            readonly sk: { readonly composite: infer C extends ReadonlyArray<string> }
          }
            ? C[number]
            : never
        >
      }
    }
  : unknown

/** The attribute a key half is stored in, when the type says which: `Entity.make` checks the rest. */
type FieldOf<H> = H extends { readonly field: infer F extends string }
  ? string extends F
    ? never
    : F
  : never

/** A partition key half that holds a shard marker can't share an attribute with these. */
type AttributesOutsideShardedPks<TIndexes, TPrimaryKey> =
  | (TPrimaryKey extends { readonly pk: infer P; readonly sk: infer S }
      ? FieldOf<P> | FieldOf<S>
      : never)
  | {
      readonly [K in keyof TIndexes]:
        | (TIndexes[K] extends { readonly sk: infer S } ? FieldOf<S> : never)
        | (TIndexes[K] extends { readonly shards: unknown }
            ? never
            : TIndexes[K] extends { readonly pk: infer P }
              ? FieldOf<P>
              : never)
    }[keyof TIndexes]

/**
 * @internal On a sharded index, a `pk.field` that is the table's `pk` or `sk`, a sort
 * key's attribute, or an unsharded index's partition key attribute is an error on
 * that entry: the shard marker would overwrite the other key (#183). `Entity.make`
 * checks every other overlap at runtime (`EDD-9106`), such as two sharded indexes
 * with different counts.
 */
type ShardedPkFieldsGuard<TIndexes, TPrimaryKey> = {
  readonly [K in keyof TIndexes]: TIndexes[K] extends {
    readonly shards: unknown
    readonly pk: infer P
  }
    ? [FieldOf<P>] extends [never]
      ? unknown
      : FieldOf<P> extends AttributesOutsideShardedPks<TIndexes, TPrimaryKey>
        ? { readonly pk: { readonly field: never } }
        : unknown
    : unknown
}

/** The `versioned` attribute, when an index can't be composed from it: only `retain` reads the item. */
type UnknownVersionField<TVersioned> = TVersioned extends { readonly retain: true }
  ? never
  : VersionFieldName<TVersioned>

/** One half's composites without `V`: an error on the half that holds it, nothing on any other. */
type CompositesWithout<THalf, V> = THalf extends {
  readonly composite: infer C extends ReadonlyArray<string>
}
  ? [Extract<C[number], V>] extends [never]
    ? unknown
    : { readonly composite: ReadonlyArray<Exclude<C[number], V>> }
  : unknown

/** A Z-order half's dimensions and prefix without `V`, as {@link CompositesWithout}. */
type ZOrderEntriesWithout<THalf, V> = (THalf extends { readonly zorder: infer Z }
  ? { readonly zorder: { readonly [I in keyof Z]: EntryWithout<Z[I], V> } }
  : unknown) &
  (THalf extends { readonly prefix: infer P }
    ? { readonly prefix: { readonly [I in keyof P]: EntryWithout<P[I], V> } }
    : unknown)

type EntryWithout<TEntry, V> = TEntry extends V
  ? never
  : TEntry extends { readonly field: V }
    ? { readonly field: never }
    : unknown

/**
 * @internal A secondary index over the `versioned` attribute is an error on that composite, unless
 * `retain` makes the value known (`EDD-9121`). `Entity.make` checks again at runtime, and checks the
 * primary key and `shards.by`. A half that doesn't hold it gets `unknown`, so it loses no completions.
 */
type VersionCompositesGuard<TIndexes, TVersioned> = [UnknownVersionField<TVersioned>] extends [
  never,
]
  ? unknown
  : {
      readonly [K in keyof TIndexes]: (TIndexes[K] extends { readonly pk: infer P }
        ? { readonly pk: CompositesWithout<P, UnknownVersionField<TVersioned>> }
        : unknown) &
        (TIndexes[K] extends { readonly sk: infer S }
          ? {
              readonly sk: CompositesWithout<S, UnknownVersionField<TVersioned>> &
                ZOrderEntriesWithout<S, UnknownVersionField<TVersioned>>
            }
          : unknown)
    }

/**
 * @internal {@link ZOrderEntriesGuard} over the fields `Entity.make`'s keys name,
 * {@link ShardedPkFieldsGuard} over its primary key, and {@link VersionCompositesGuard} over its
 * `versioned` config.
 */
export type EntityIndexesGuard<
  TModel extends Schema.Top,
  TRefs,
  TIndexes,
  TPrimaryKey,
  TVersioned = undefined,
> = ZOrderEntriesGuard<TIndexes, KeyFields<TModel, RefsOrNone<TRefs>>> &
  ShardedPkFieldsGuard<TIndexes, TPrimaryKey> &
  VersionCompositesGuard<TIndexes, TVersioned>

type ZOrderHalfGuard<SK, TFields> = (SK extends { readonly zorder: infer Z }
  ? {
      readonly zorder: {
        readonly [I in keyof Z]: Z[I] extends string
          ? unknown
          : { readonly [P in Exclude<keyof Z[I], AllowedEntryKeys<Z[I], TFields>>]: never }
      }
    }
  : unknown) &
  (SK extends { readonly prefix: infer P }
    ? {
        readonly prefix: {
          readonly [I in keyof P]: P[I] extends string
            ? unknown
            : { readonly [Q in Exclude<keyof P[I], "field" | "hash">]: never }
        }
      }
    : unknown)

/**
 * @internal The refs `Entity.make` was given, or `undefined` when it was given
 * none. `TRefs` has no default so that, while an editor completes inside
 * `refs`, it falls back to its constraint (which lists the model's fields)
 * instead of to a default of `undefined` (which lists nothing); left out, it
 * resolves to that constraint, which includes `undefined` and maps here to
 * `undefined`.
 */
export type RefsOrNone<TRefs> = undefined extends TRefs ? undefined : TRefs

/** @internal See {@link EntityPrimaryKeyConfig}: the time-series clock and append input. */
export type EntityTimeSeriesConfig<TModel extends Schema.Top> = TimeSeriesConfig<
  Schema.Top,
  ModelFieldName<TModel>
>

/** @internal See {@link EntityPrimaryKeyConfig}: the auto-generated id field. */
export type EntityGeneratedIdConfig<TModel extends Schema.Top> = GeneratedIdConfig<
  ModelFieldName<TModel>
>

/** @internal See {@link EntityPrimaryKeyConfig}: vector indexes over model fields. */
export type EntityVectorIndexesConfig<TModel extends Schema.Top> = globalThis.Record<
  string,
  VectorIndexConfig<ModelFieldName<TModel>>
>

/**
 * @internal A `timeSeries.appendInput` field that is not a model field: its
 * name, as a type error on `appendInput` (`never` when every field is one).
 */
export type AppendInputFields<TModel extends Schema.Top, TTimeSeries> = TTimeSeries extends {
  readonly appendInput: infer A extends Schema.Top
}
  ? string extends ModelFieldName<A>
    ? unknown
    : [Exclude<ModelFieldName<A>, ModelFieldName<TModel>>] extends [never]
      ? unknown
      : {
          readonly appendInput: `EDD-9013: appendInput field "${Exclude<
            ModelFieldName<A>,
            ModelFieldName<TModel>
          >}" is not a model field`
        }
  : unknown

/** The sort key composites an input lacks before one it carries: the hole a composer can't span. */
type SortKeyHole<C, TCarried, TGap extends string = never> = C extends readonly [
  infer H extends string,
  ...infer T,
]
  ? H extends TCarried
    ? TGap | SortKeyHole<T, TCarried>
    : SortKeyHole<T, TCarried, TGap | H>
  : never

/**
 * What an index's key lacks when an input carrying `TCarried` touches its `shards.by`.
 * A sort key hole fails only under `preserve`; `sparse` takes the row out of the index.
 */
type AppendShardGap<TEntry, TCarried> = TEntry extends {
  readonly pk: { readonly composite: infer PC extends ReadonlyArray<string> }
  readonly sk: { readonly composite: infer SC extends ReadonlyArray<string> }
  readonly shards: { readonly by: infer By extends ReadonlyArray<string> }
}
  ? [By[number] & TCarried] extends [never]
    ? never
    :
        | Exclude<PC[number] | By[number], TCarried>
        | (TEntry extends { readonly indexPolicy: infer P }
            ? [P] extends [{ readonly pk?: unknown; readonly sk?: "preserve" }]
              ? SortKeyHole<SC, TCarried>
              : never
            : SortKeyHole<SC, TCarried>)
  : never

/**
 * @internal A `timeSeries.appendInput` carrying a `shards.by` attribute of an index,
 * without what its key needs beside it: every append carrying it would fail with
 * `EDD-9100`, so it's an error on `appendInput`. `Entity.make` checks again at run time
 * (`EDD-9113`), which covers whatever the literals here don't show.
 */
export type AppendShardGuard<TIndexes, TTimeSeries> = TTimeSeries extends {
  readonly appendInput: infer A extends Schema.Top
}
  ? string extends ModelFieldName<A>
    ? unknown
    : [
          {
            readonly [K in keyof TIndexes]: AppendShardGap<TIndexes[K], ModelFieldName<A>>
          }[keyof TIndexes],
        ] extends [never]
      ? unknown
      : {
          readonly appendInput: `EDD-9113: appendInput carries a sharded index's \`by\` attribute but not ${{
            readonly [K in keyof TIndexes]: AppendShardGap<TIndexes[K], ModelFieldName<A>>
          }[keyof TIndexes] &
            string}`
        }
  : unknown

// ---------------------------------------------------------------------------
// EntityDefinition — the pure half of an Entity (no AWS operations)
// ---------------------------------------------------------------------------

interface ResolvedRef {
  readonly fieldName: string
  readonly idFieldName: string
  readonly identifierField: string
  readonly identifierSchema: Schema.Top
  readonly refEntity: EntityDefinition
  readonly refEntityType: string
}

/**
 * @internal The full bundle of pure locals produced by
 * {@link buildEntityDefinition}. The runtime `effect-dynamodb` package consumes
 * this bundle to attach CRUD/query operations without re-running derivation.
 */
export interface EntityDefinitionData {
  readonly configuredAttributes: globalThis.Record<
    string,
    { readonly immutable?: boolean; readonly field?: string }
  >
  readonly rawModel: Schema.Top
  readonly isSchemaClass: boolean
  readonly modelFields: globalThis.Record<string, Schema.Top>
  readonly hasHiddenFields: boolean
  readonly systemFields: ResolvedSystemFields
  readonly validCompositeFields: ReadonlySet<string>
  readonly resolvedRefs: ReadonlyArray<ResolvedRef>
  readonly hasRefs: boolean
  readonly cascadeIndexes: globalThis.Record<string, IndexDefinition>
  readonly initialIndexes: globalThis.Record<string, IndexDefinition>
  readonly immutableFields: ReadonlySet<string>
  readonly resolvedIdentifier: string | undefined
  readonly fieldEncodings: globalThis.Record<string, DynamoEncoding>
  readonly schemas: DerivedSchemas
  readonly entityType: string
  readonly entityVersion: number
  readonly sparseFields: globalThis.Record<string, SparseConfig>
  readonly hasSparseFields: boolean
  /** Domain field name → packed storage config (`storedAs: DynamoModel.Packed`). */
  readonly packedFields: Readonly<globalThis.Record<string, PackedConfig>>
  /** Stored attribute name (after `field` renames) → packed storage config. */
  readonly packedAttributes: Readonly<globalThis.Record<string, PackedConfig>>
  /**
   * Stored attribute names read by their stored form (packed ones plus every
   * object/array-shaped field — see `internal/EntityPacked.ts`).
   */
  readonly dispatchAttributes: ReadonlyArray<string>
  readonly hasPackedFields: boolean
  readonly fieldRenames: globalThis.Record<string, string>
  readonly hasRenames: boolean
  readonly renameToDynamo: (item: globalThis.Record<string, unknown>) => void
  readonly renameFromDynamo: (item: globalThis.Record<string, unknown>) => void
  readonly resolveDbName: (domainName: string) => string
  readonly generatedIdField: string | undefined
  readonly generatedIdVersion: string | undefined
  /** Normalized vector index declarations, keyed by logical name. */
  readonly vectorIndexes: globalThis.Record<string, VectorIndexDefinition>
  readonly hasVectorIndexes: boolean
}

/**
 * @internal The normalized config a definition was built from — model, entity
 * type, indexes (with `primary`), and all lifecycle/ref configuration. Retained
 * on the pure definition so the runtime `effect-dynamodb` package can promote it
 * to a full operational `Entity` (attaching CRUD/query operations) without the
 * caller re-authoring it. Mirrors the input to {@link buildEntityDefinition}.
 */
export interface EntityDefinitionConfig {
  readonly model: Schema.Top | ConfiguredModel<Schema.Top, any>
  readonly entityType: string
  readonly indexes: globalThis.Record<string, IndexDefinition> & {
    readonly primary: IndexDefinition
  }
  readonly timestamps?: TimestampsConfig | undefined
  readonly versioned?: VersionedConfig | undefined
  readonly softDelete?: SoftDeleteConfig | undefined
  readonly unique?: UniqueConfig | undefined
  readonly refs?: globalThis.Record<string, AnyRefValue> | undefined
  readonly timeSeries?: TimeSeriesConfig<any> | undefined
  readonly generatedId?: GeneratedIdConfig | undefined
  readonly vectorIndexes?: globalThis.Record<string, VectorIndexConfig> | undefined
}

/**
 * The pure definition produced by {@link make}. Carries the model binding,
 * index definitions, system-field configuration, derived schemas, and the
 * `_configure` / `_injectIndex` hooks used by the runtime binding layer. Does
 * NOT carry AWS-coupled CRUD/query operations — those live on the runtime
 * `effect-dynamodb` `Entity` type, which extends this.
 */
export interface EntityDefinition<
  TModel extends Schema.Top = Schema.Top,
  TEntityType extends string = string,
  TIndexes extends globalThis.Record<string, IndexDefinition> = globalThis.Record<
    string,
    IndexDefinition
  >,
  TTimestamps extends TimestampsConfig | undefined = TimestampsConfig | undefined,
  TVersioned extends VersionedConfig | undefined = VersionedConfig | undefined,
  TSoftDelete extends SoftDeleteConfig | undefined = SoftDeleteConfig | undefined,
  TUnique extends UniqueConfig | undefined = UniqueConfig | undefined,
  TRefs extends globalThis.Record<string, AnyRefValue> | undefined = undefined,
  TIdentifier extends string | undefined = undefined,
  TTimeSeries extends TimeSeriesConfig<any> | undefined = undefined,
  TGeneratedId extends GeneratedIdConfig | undefined = undefined,
  TVectorIndexes extends globalThis.Record<string, VectorIndexConfig> | undefined = undefined,
  TPackedFields extends string = never,
  TUnremovable extends string = never,
> {
  readonly _tag: "Entity"
  readonly model: TModel
  readonly entityType: TEntityType
  readonly indexes: TIndexes
  readonly timestamps: TTimestamps
  readonly versioned: TVersioned
  readonly softDelete: TSoftDelete
  readonly unique: TUnique
  readonly identifier: TIdentifier
  readonly timeSeries: TTimeSeries
  readonly generatedId: TGeneratedId
  /** Vector index declarations as authored (see `DESIGN.md §14`). */
  readonly vectorIndexes: TVectorIndexes

  /**
   * @internal Normalized vector index definitions keyed by logical name. The
   * runtime package reads these to emit `CreateTable.VectorIndexes`, compose
   * partition attributes on writes, and build search accessors.
   */
  readonly _vectorIndexes: globalThis.Record<string, VectorIndexDefinition>

  /**
   * The domain fields stored packed (`storedAs: DynamoModel.Packed(...)`).
   * Carries the `TPackedFields` type, which narrows expression path builders:
   * a packed field can be tested only with `exists` / `notExists` as a whole.
   */
  readonly _packedFields: ReadonlyArray<TPackedFields>
  /**
   * @internal Phantom — never read at runtime. Carries the fields
   * `.remove()` refuses by configuration (immutable, sparse map).
   */
  _unremovableFields?(field: TUnremovable): void

  /** @internal Resolved ref metadata — used by cascade to inspect target entities */
  readonly _resolvedRefs: ReadonlyArray<{
    readonly fieldName: string
    readonly idFieldName: string
    readonly identifierField: string
    readonly refEntityType: string
  }>

  /** @internal Attach model class prototype to a decoded plain object (no-op for Schema.Struct models). */
  readonly _attachPrototype: (decoded: any) => any

  /**
   * @internal Configure the entity with table schema and tag.
   * Called by DynamoClient.make() when binding entities to a table.
   */
  readonly _configure: (schema: DynamoSchema.DynamoSchema, tableTag: unknown) => void

  /**
   * @internal Inject a GSI index definition into this entity.
   */
  readonly _injectIndex: (name: string, def: IndexDefinition) => void

  /** @internal Injected DynamoSchema — available after _configure(). */
  readonly _schema: DynamoSchema.DynamoSchema
  /** @internal Injected TableConfig tag — available after _configure(). */
  readonly _tableTag: unknown

  /**
   * @internal The normalized config this definition was built from. Used by the
   * runtime `effect-dynamodb` package to promote a pure definition to a full
   * operational Entity (see {@link EntityDefinitionConfig}).
   */
  readonly _config: EntityDefinitionConfig
  /**
   * @internal The derived data bundle (see {@link EntityDefinitionData}). Lets
   * the runtime attach operations without re-running derivation — promotion is a
   * thin op-attach rather than a full re-derive.
   */
  readonly _data: EntityDefinitionData

  /** Resolved system field names */
  readonly systemFields: ResolvedSystemFields

  /** Derived schemas for type extraction */
  readonly schemas: DerivedSchemas

  /**
   * Typed input schema. Ref-aware: ref fields are replaced with branded ID fields.
   * Use in HttpApiEndpoint payloads or for validation.
   */
  readonly inputSchema: Schema.Codec<
    EntityRefInputType<TModel, TRefs, TTimestamps, TVersioned, TTimeSeries>
  >

  /**
   * Typed create schema. Input fields minus primary key composites — the common
   * "create" payload where IDs are auto-generated.
   */
  readonly createSchema: Schema.Codec<
    EntityRefCreateType<TModel, TIndexes, TRefs, TIdentifier, TTimestamps, TVersioned, TTimeSeries>
  >

  /**
   * Typed update schema. Partial fields minus primary key composites and immutable fields.
   * Ref fields are replaced with optional branded ID fields.
   */
  readonly updateSchema: Schema.Codec<
    EntityRefUpdateType<TModel, TIndexes, TRefs, TTimestamps, TVersioned>
  >
}

// ---------------------------------------------------------------------------
// buildEntityDefinition — pure validation + derivation
// ---------------------------------------------------------------------------

/**
 * @internal Run all `make()`-time validation and derivation for an entity and
 * return the bundle of pure locals. Shared by the schema-package {@link make}
 * and the runtime `effect-dynamodb` `Entity.make` so derivation has a single
 * source of truth.
 *
 * @throws on invalid configuration (EDD-90xx).
 */
/**
 * Check a declared `shards` against its entity and bind its source (#183). The
 * checks needing no model are `normalizeGsiConfig`'s.
 */
const bindShards = (
  entityType: string,
  indexName: string,
  index: IndexDefinition,
  primary: IndexDefinition,
): IndexShards => {
  const shards = index.shards!
  const primaryComposites = [...primary.pk.composite, ...primary.sk.composite]
  if (primaryComposites.every((attr) => index.pk.composite.includes(attr))) {
    throw new Error(
      `[EDD-9101] Entity "${entityType}": index "${indexName}" has nothing to spread. Every ` +
        `primary key composite is also one of its partition key composites, so each logical ` +
        `partition holds at most one item and every write to it lands on one shard. Its hot ` +
        `spot is the write rate on one item, which sharding an index can't split: remove ` +
        `\`shards\`.`,
    )
  }
  const by = shards.by
  if (by === undefined) return { ...shards, source: primaryComposites }
  const refuseBy = (why: string): Error =>
    new Error(`[EDD-9102] Entity "${entityType}": index "${indexName}" shards.by ${why}`)
  if (!Array.isArray(by) || by.length === 0) {
    throw refuseBy(
      "must name at least one sort key composite of this index. Omit it to hash the primary key.",
    )
  }
  if (new Set(by).size !== by.length) {
    throw refuseBy(`names an attribute twice: ${by.map((attr) => `"${attr}"`).join(", ")}.`)
  }
  if (isZOrderHalf(index.sk)) {
    throw refuseBy(
      "can't be used on a Z-order sort key: an accessor can't pin its dimensions, so no query " +
        "could read fewer shards. Omit it to hash the primary key.",
    )
  }
  const outside = by.filter((attr) => !index.sk.composite.includes(attr))
  if (outside.length > 0) {
    throw refuseBy(
      `${outside.map((attr) => `"${attr}"`).join(", ")} must be a sort key composite of this index ` +
        `(${index.sk.composite.join(", ") || "it has none"}): a query can never pin anything else, ` +
        `so it would give no pruning and a worse spread than the default.`,
    )
  }
  return { ...shards, source: by }
}

/**
 * An `appendInput` carrying a `shards.by` attribute of an index whose key can't be
 * composed from what that input carries (`[EDD-9113]`): every append carrying it would
 * fail with `[EDD-9100]`. Judged by composing one such append, through the composer every
 * append goes through, so the policy decides as it would on the call: a sort key gap
 * under `sparse` takes the row out of the index rather than failing.
 */
const refuseAppendThatCannotShard = (
  entityType: string,
  indexes: globalThis.Record<string, IndexDefinition>,
  timeSeries: { readonly appendInput?: unknown } | undefined,
): void => {
  if (timeSeries?.appendInput === undefined || timeSeries.appendInput === null) return
  const carried = Object.keys(getSchemaFields(timeSeries.appendInput as Schema.Top) ?? {})
  const primary = indexes.primary
  if (primary === undefined) return
  const primaryComposites = [...primary.pk.composite, ...primary.sk.composite]
  const appended = (fields: ReadonlyArray<string>) =>
    Object.fromEntries(fields.map((field) => [field, "x"]))
  for (const [indexName, index] of Object.entries(indexes)) {
    const by = index.shards?.by
    if (by === undefined || !by.some((attr) => carried.includes(attr))) continue
    try {
      composeGsiKeysForUpdatePolicyAware(
        DynamoSchema.make({ name: "definition", version: 1 }),
        entityType,
        1,
        { primary, [indexName]: index },
        appended(carried.filter((field) => !primaryComposites.includes(field))),
        appended(carried),
      )
    } catch (error) {
      if (!isShardSourceError(error)) throw error
      const lastCarried = index.sk.composite.reduce(
        (last, attr, position) => (carried.includes(attr) ? position : last),
        -1,
      )
      const missing = [
        ...new Set([...index.pk.composite, ...by, ...index.sk.composite.slice(0, lastCarried)]),
      ].filter((attr) => !carried.includes(attr))
      const names = (attrs: ReadonlyArray<string>) => attrs.map((attr) => `"${attr}"`).join(", ")
      throw new Error(
        `[EDD-9113] Entity "${entityType}": timeSeries.appendInput carries ` +
          `${names(by.filter((attr) => carried.includes(attr)))}, which index "${indexName}" is ` +
          `sharded by, but not ${names(missing)}. Every append carrying it would fail with ` +
          `EDD-9100, because the index's key can't be composed. Add ${names(missing)} to ` +
          `appendInput, or take the sharded attribute out of it.`,
      )
    }
  }
}

export const buildEntityDefinition = (config: {
  readonly model: Schema.Top | ConfiguredModel<Schema.Top, any>
  readonly entityType: string
  readonly indexes: globalThis.Record<string, IndexDefinition> & {
    readonly primary: IndexDefinition
  }
  readonly timestamps?: TimestampsConfig | undefined
  readonly versioned?: VersionedConfig | undefined
  readonly softDelete?: SoftDeleteConfig | undefined
  readonly unique?: UniqueConfig | undefined
  readonly refs?: globalThis.Record<string, AnyRefValue> | undefined
  readonly timeSeries?: TimeSeriesConfig<any> | undefined
  readonly generatedId?: GeneratedIdConfig | undefined
  readonly vectorIndexes?: globalThis.Record<string, VectorIndexConfig> | undefined
}): EntityDefinitionData => {
  // Unwrap ConfiguredModel to get the raw model and attribute overrides
  const configured = isConfiguredModel(config.model) ? config.model : undefined
  const rawModel = configured ? configured.model : (config.model as Schema.Top)
  refuseUnreadable(`Entity "${config.entityType}"`, "entity", rawModel)
  const configuredAttributes = configured?.attributes ?? {}
  // Schema.Class is a constructable function whose AST is a `Declaration`.
  // The `typeof` check alone is not enough: since Effect 4.0.0-rc,
  // `Schema.Struct(...)` is also a function (callable make), but its AST is
  // `Objects` — treating it as a class would run `new Struct(decoded)` on the
  // decode path and silently produce empty objects.
  const isSchemaClass =
    typeof rawModel === "function" &&
    (rawModel.ast as { readonly _tag?: string })._tag === "Declaration"
  const modelFields = getFields(rawModel)
  const hasHiddenFields = Object.values(modelFields).some(isHidden)
  // `Schema.optional(X)` is a union with `Undefined`, which has no date representation of its own,
  // so the value schema is what's read: an optional date is a date, as `Schema.optionalKey(X)`
  // always was. An aggregate's stamp overwrites what a caller supplied, so its optional dates stay
  // the caller's.
  const systemFields = resolveSystemFields(
    config.timestamps,
    config.versioned,
    config.timeSeries,
    Object.fromEntries(
      Object.entries(modelFields).map(([name, field]) => [
        name,
        optionalField(field as Schema.Top)?.inner ?? field,
      ]),
    ) as typeof modelFields,
    configuredAttributes,
    `Entity "${config.entityType}"`,
  )

  // ---------------------------------------------------------------------------
  // Validate indexes
  // ---------------------------------------------------------------------------

  const primaryIndex = config.indexes.primary
  // Z-order sort keys are secondary-index only (#171): the primary key is
  // string-composed, and a misplaced `zorder` must not reach the composers.
  for (const half of [primaryIndex.pk, primaryIndex.sk] as ReadonlyArray<object>) {
    if ("zorder" in half || "prefix" in half || "zorderHalf" in half) {
      throw new Error(
        `[EDD-9086] Entity "${config.entityType}": the primary key can't be a Z-order key — ` +
          `zorder / prefix belong on a secondary index's sort key.`,
      )
    }
  }
  for (const [indexName, indexDef] of Object.entries(config.indexes)) {
    if (indexDef.collection !== undefined && isZOrderHalf(indexDef.sk)) {
      throw zorderInCollection(config.entityType, indexName)
    }
  }
  if ((primaryIndex as { readonly shards?: unknown }).shards !== undefined) {
    throw new Error(
      `[EDD-9099] Entity "${config.entityType}": the primary key can't be sharded — shards is ` +
        `an option of a secondary index.`,
    )
  }
  if (primaryIndex.pk.composite.length === 0 && primaryIndex.sk.composite.length === 0) {
    throw new Error(
      `[EDD-9001] Entity "${config.entityType}": primary key must have at least one composite attribute in pk or sk`,
    )
  }

  // Build the set of valid composite attribute names: model fields + ref-derived ID fields
  const validCompositeFields = new Set(Object.keys(modelFields))
  for (const fieldName of Object.keys(modelFields)) {
    if (isRefField(fieldName, config.model as Schema.Top)) {
      validCompositeFields.add(`${fieldName}Id`)
    }
  }

  for (const [indexName, indexDef] of Object.entries(config.indexes)) {
    for (const attr of [...indexDef.pk.composite, ...indexDef.sk.composite]) {
      if (!validCompositeFields.has(attr)) {
        throw new Error(
          `[EDD-9002] Entity "${config.entityType}": index "${indexName}" references unknown attribute "${attr}". ` +
            `Valid attributes: ${[...validCompositeFields].sort().join(", ")}`,
        )
      }
    }
  }

  refuseKeysOverMovingValues(config.entityType, config.indexes, systemFields, config.versioned)
  if (
    systemFields.version !== null &&
    (configuredAttributes as globalThis.Record<string, { readonly field?: string } | undefined>)[
      systemFields.version
    ]?.field !== undefined
  ) {
    throw new Error(
      `[EDD-9122] Entity "${config.entityType}": "${systemFields.version}" is where \`versioned\` ` +
        `keeps the version, so \`configure\` can't store it under another name: the write would ` +
        `succeed and every later read and write of the item would find no version. To name the ` +
        `attribute, use \`versioned: { field: "..." }\` and give the model's field that name.`,
    )
  }

  // ---------------------------------------------------------------------------
  // Packed fields (storedAs: DynamoModel.Packed) — EDD-9072..9075, EDD-9073.
  // Checked before the other derivations so a packed composite / filter field
  // reports its own code rather than a downstream derivation failure.
  // ---------------------------------------------------------------------------

  const packedPlan = resolvePackedPlan({
    entityType: config.entityType,
    model: config.model as Schema.Top,
    packedFields: getPackedFields(config.model as Schema.Top),
    sparseFields: getSparseFields(config.model as Schema.Top),
    modelFields,
    indexes: config.indexes,
    unique: config.unique,
    timeSeries: config.timeSeries,
    vectorIndexes: config.vectorIndexes,
    resolveDbName: (name) =>
      (configuredAttributes as globalThis.Record<string, { readonly field?: string }>)[name]
        ?.field ?? name,
  })

  // ---------------------------------------------------------------------------
  // EDD-9025: composite attribute schemas must not include `null`.
  // ---------------------------------------------------------------------------

  const resolveCompositeSchemaForNullCheck = (
    compositeAttr: string,
  ): { readonly schema: Schema.Top; readonly source: string } | undefined => {
    if (compositeAttr in modelFields) {
      return { schema: modelFields[compositeAttr] as Schema.Top, source: `model field` }
    }
    if (config.refs) {
      for (const [refFieldName, refValue] of Object.entries(config.refs)) {
        if (`${refFieldName}Id` !== compositeAttr) continue
        const refEntity = (refValue as { entity: EntityDefinition }).entity
        const idField = getIdentifierField(refEntity.model as Schema.Top)
        if (!idField) return undefined
        return { schema: idField.schema, source: `ref "${refFieldName}" identifier` }
      }
    }
    return undefined
  }

  const findNullInAst = (
    ast: SchemaAST.AST,
    path: string,
    seen: Set<SchemaAST.AST> = new Set(),
  ): string | undefined => {
    if (seen.has(ast)) return undefined
    seen.add(ast)
    if (SchemaAST.isNull(ast)) return `${path}.Null`
    if (SchemaAST.isUnion(ast)) {
      for (let i = 0; i < ast.types.length; i++) {
        const found = findNullInAst(ast.types[i]!, `${path}.Union[${i}]`, seen)
        if (found) return found
      }
    }
    return undefined
  }

  const checkCompositeForNull = (surface: string, compositeAttr: string): void => {
    const resolved = resolveCompositeSchemaForNullCheck(compositeAttr)
    if (!resolved) return
    const found = findNullInAst(resolved.schema.ast, resolved.source)
    if (found) {
      throw makeCompositeNullableError({
        entityType: config.entityType,
        surface,
        compositeAttribute: compositeAttr,
        schemaPath: found,
      })
    }
  }

  for (const attr of [
    ...config.indexes.primary.pk.composite,
    ...config.indexes.primary.sk.composite,
  ]) {
    checkCompositeForNull("primaryKey", attr)
  }
  for (const [indexName, indexDef] of Object.entries(config.indexes)) {
    if (indexName === "primary") continue
    for (const attr of [...indexDef.pk.composite, ...indexDef.sk.composite]) {
      checkCompositeForNull(`index "${indexName}"`, attr)
    }
  }
  if (config.unique) {
    for (const [constraintName, constraintDef] of Object.entries(config.unique)) {
      const fields = resolveUniqueFields(constraintDef)
      for (const f of fields) {
        checkCompositeForNull(`unique:${constraintName}`, f)
      }
    }
  }

  // EDD-9128: no value is composed into key text from a field storing both numeric kinds. A
  // Z-order dimension is quantized, not composed, and its own check refuses a union (EDD-9088).
  // What composes each key composite, in words, for `appendInput`'s check below.
  const composedInto = new Map<string, string>()
  const refuseBothKinds = (where: string, attrs: ReadonlyArray<string>): void => {
    for (const attr of attrs) {
      if (!composedInto.has(attr)) composedInto.set(attr, where)
      const resolved = resolveCompositeSchemaForNullCheck(attr)
      if (resolved === undefined) continue
      const refused = bothKindsKeyRefusal(
        `Entity "${config.entityType}"`,
        where,
        attr,
        resolved.schema,
      )
      if (refused !== undefined) throw refused
    }
  }
  for (const [indexName, indexDef] of Object.entries(config.indexes)) {
    const dimensions = isZOrderHalf(indexDef.sk)
      ? new Set(indexDef.sk.zorderHalf.dimensions.map((dimension) => dimension.field))
      : new Set<string>()
    refuseBothKinds(indexName === "primary" ? "the primary key" : `index "${indexName}"`, [
      ...indexDef.pk.composite,
      ...indexDef.sk.composite.filter((attr) => !dimensions.has(attr)),
    ])
  }
  for (const [constraintName, constraintDef] of Object.entries(config.unique ?? {})) {
    refuseBothKinds(`unique constraint "${constraintName}"`, resolveUniqueFields(constraintDef))
  }
  for (const [logicalName, vectorConfig] of Object.entries(config.vectorIndexes ?? {})) {
    refuseBothKinds(`vector index "${logicalName}"'s partition`, vectorConfig.partition ?? [])
  }
  if (config.timeSeries !== undefined && config.timeSeries !== null) {
    refuseBothKinds("an event's sort key (timeSeries.orderBy)", [config.timeSeries.orderBy])
  }

  // ---------------------------------------------------------------------------
  // Validate timeSeries config (EDD-9010..9016)
  // ---------------------------------------------------------------------------
  if (config.timeSeries !== undefined && config.timeSeries !== null) {
    const ts = config.timeSeries as TimeSeriesConfig<any>
    const orderBy = ts.orderBy

    if (!(orderBy in modelFields)) {
      throw new Error(
        `[EDD-9010] Entity "${config.entityType}": timeSeries.orderBy "${orderBy}" does not name a model field. ` +
          `Valid model fields: ${Object.keys(modelFields).sort().join(", ")}`,
      )
    }

    const primary = config.indexes.primary
    const pkSkComposites = new Set([...primary.pk.composite, ...primary.sk.composite])
    if (pkSkComposites.has(orderBy)) {
      throw new Error(
        `[EDD-9011] Entity "${config.entityType}": timeSeries.orderBy "${orderBy}" must not appear ` +
          `in the primary key pk or sk composite — it shadows the #e# event-SK infix.`,
      )
    }

    if (config.versioned !== undefined && config.versioned !== null && config.versioned !== false) {
      throw new Error(
        `[EDD-9012] Entity "${config.entityType}": timeSeries and versioned are mutually exclusive. ` +
          `Pick one consistency model per entity.`,
      )
    }

    if (
      config.softDelete !== undefined &&
      config.softDelete !== null &&
      config.softDelete !== false
    ) {
      throw new Error(
        `[EDD-9015] Entity "${config.entityType}": timeSeries and softDelete are mutually exclusive. ` +
          `Append on a soft-deleted item would land on a new empty row — not a sound resurrection model.`,
      )
    }

    if (ts.appendInput === undefined || ts.appendInput === null) {
      throw new Error(
        `[EDD-9016] Entity "${config.entityType}": timeSeries.appendInput is required. ` +
          `Define a Schema.Struct whose fields are the subset of the model allowed in .append() input. ` +
          `Fields outside appendInput are preserved on the current item — this is the enrichment-preservation guarantee. ` +
          `To opt out (dangerous), pass the full model schema explicitly.`,
      )
    }

    const appendInputFields = (() => {
      const ai = ts.appendInput as Schema.Top
      const fields = getSchemaFields(ai)
      if (fields) return Object.keys(fields)
      throw new Error(
        `[EDD-9016] Entity "${config.entityType}": timeSeries.appendInput must be a Schema.Struct or Schema.Class (.fields required).`,
      )
    })()
    const appendInputFieldSet = new Set(appendInputFields)

    if (!appendInputFieldSet.has(orderBy)) {
      throw new Error(
        `[EDD-9013] Entity "${config.entityType}": timeSeries.appendInput must include orderBy "${orderBy}". ` +
          `Without it .append() cannot evaluate the CAS condition.`,
      )
    }
    for (const composite of pkSkComposites) {
      if (!appendInputFieldSet.has(composite)) {
        throw new Error(
          `[EDD-9013] Entity "${config.entityType}": timeSeries.appendInput missing primary-key composite "${composite}". ` +
            `Every PK/SK composite must appear in appendInput so the event can be addressed.`,
        )
      }
    }

    // EDD-9128: `.append()` takes its input through `appendInput`, and composes the event's sort key
    // and the current item's keys from it, so `appendInput`'s own fields are refused as the model's
    // are: `orderBy` and every key composite it carries. One composing the other numeric kind's key
    // text than its model field is refused too: the event is keyed by one kind's text and every read
    // composes the other's.
    const appendFields = getSchemaFields(ts.appendInput as Schema.Top) ?? {}
    for (const [attr, where] of composedInto) {
      const field = appendFields[attr]
      if (field === undefined) continue
      const owner = `Entity "${config.entityType}"`
      const at = `${where}, through timeSeries.appendInput,`
      const refused = bothKindsKeyRefusal(owner, at, attr, field)
      if (refused !== undefined) throw refused
      const model = modelFields[attr] as Schema.Top | undefined
      const given = keyFormValueKind(field)
      const read = model === undefined ? undefined : keyFormValueKind(model)
      if (
        (given === "number" || given === "bigint") &&
        (read === "number" || read === "bigint") &&
        given !== read
      ) {
        throw new Error(
          `[EDD-9128] ${owner}: ${at} can't be composed from "${attr}", which timeSeries.appendInput ` +
            `holds as a ${given} and the model as a ${read}. The two compose different key text, so ` +
            `an event appended under one would never be found by a read composing the other. ` +
            `Declare the same kind in both.`,
        )
      }
    }

    for (const fieldName of Object.keys(modelFields)) {
      if (isRefField(fieldName, config.model as Schema.Top)) {
        if (orderBy === fieldName || orderBy === `${fieldName}Id`) {
          throw new Error(
            `[EDD-9014] Entity "${config.entityType}": timeSeries.orderBy "${orderBy}" names a ref ` +
              `or ref-derived id field. Refs are create-time denormalisations and cannot serve as the event clock.`,
          )
        }
      }
    }
    for (const fieldName of Object.keys(modelFields)) {
      if (isRefField(fieldName, config.model as Schema.Top)) {
        if (appendInputFieldSet.has(`${fieldName}Id`)) {
          throw new Error(
            `[EDD-9014] Entity "${config.entityType}": timeSeries.appendInput must not include ref-derived ` +
              `"${fieldName}Id" — refs cannot be reassigned via .append(). Use .update() to change a ref.`,
          )
        }
      }
    }
    for (const field of appendInputFields) {
      if (!(field in modelFields)) {
        throw new Error(
          `[EDD-9013] Entity "${config.entityType}": timeSeries.appendInput field "${field}" is not a ` +
            `model field. .append() writes each appendInput field to the current item. ` +
            `Valid model fields: ${Object.keys(modelFields).sort().join(", ")}`,
        )
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Validate unique constraint fields (EDD-9002)
  // ---------------------------------------------------------------------------
  if (config.unique) {
    for (const [constraintName, constraintDef] of Object.entries(config.unique)) {
      for (const field of resolveUniqueFields(constraintDef)) {
        if (!(field in modelFields)) {
          throw new Error(
            `[EDD-9002] Entity "${config.entityType}": unique constraint "${constraintName}" references ` +
              `unknown attribute "${field}". Valid attributes: ${Object.keys(modelFields).sort().join(", ")}`,
          )
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Validate generatedId config (EDD-9008)
  // ---------------------------------------------------------------------------
  if (config.generatedId !== undefined && config.generatedId !== null) {
    const gid = config.generatedId as GeneratedIdConfig
    const field = gid.field

    if (!(field in modelFields)) {
      throw new Error(
        `[EDD-9008] Entity "${config.entityType}": generatedId.field "${field}" does not name a model field. ` +
          `Valid model fields: ${Object.keys(modelFields).sort().join(", ")}`,
      )
    }

    const primary = config.indexes.primary
    const pkSkComposites = new Set([...primary.pk.composite, ...primary.sk.composite])
    if (!pkSkComposites.has(field)) {
      throw new Error(
        `[EDD-9008] Entity "${config.entityType}": generatedId.field "${field}" must participate in the ` +
          `primary key (pk or sk composite). An auto-generated id that does not compose into the primary ` +
          `key cannot address the item. Primary-key composites: ${[...pkSkComposites].sort().join(", ")}`,
      )
    }
  }

  // ---------------------------------------------------------------------------
  // Validate + normalize vector indexes (EDD-903x, EDD-9070)
  // ---------------------------------------------------------------------------

  const vectorIndexes: globalThis.Record<string, VectorIndexDefinition> = {}
  if (config.vectorIndexes) {
    // Encoded-type tag for a model field, resolving homogeneous literal unions
    // (e.g. Schema.Literals(["a", "b"]) → "String") so they qualify as filters.
    const fieldEncodedTag = (field: string): string | undefined => {
      const fieldSchema = getSchemaFields(rawModel)?.[field] as { ast?: SchemaAST.AST } | undefined
      if (fieldSchema?.ast === undefined) return undefined
      const resolveTag = (ast: SchemaAST.AST): string => {
        const encoded = SchemaAST.toEncoded(ast)
        if (SchemaAST.isUnion(encoded)) {
          const memberTags = new Set(encoded.types.map((member) => resolveTag(member)))
          return (memberTags.size === 1 ? [...memberTags][0] : undefined) ?? "Union"
        }
        if (encoded._tag === "Literal") {
          const literal = (encoded as { literal?: unknown }).literal
          return typeof literal === "number" ? "Number" : "String"
        }
        return encoded._tag
      }
      return resolveTag(fieldSchema.ast)
    }
    for (const [logicalName, vectorConfig] of Object.entries(config.vectorIndexes)) {
      vectorIndexes[logicalName] = normalizeVectorIndexConfig(vectorConfig)
    }
    // Field-existence validation (EDD-9031..9033, EDD-9070) runs before type derivation
    // so an unknown filter field reports EDD-9031, not a derivation failure.
    validateVectorIndexes({
      entityType: config.entityType,
      definitions: vectorIndexes,
      validFields: validCompositeFields,
    })
    for (const [logicalName, definition] of Object.entries(vectorIndexes)) {
      vectorIndexes[logicalName] = {
        ...definition,
        filterTypes: deriveVectorFilterTypes(
          config.entityType,
          logicalName,
          definition.filters,
          fieldEncodedTag,
        ),
      }
    }
  }
  const hasVectorIndexes = Object.keys(vectorIndexes).length > 0

  // ---------------------------------------------------------------------------
  // Resolve refs at make() time
  // ---------------------------------------------------------------------------

  const resolvedRefs: ReadonlyArray<ResolvedRef> = config.refs
    ? Object.entries(config.refs).map(([fieldName, refValue]) => {
        const refEntity = refValue.entity as EntityDefinition

        const fieldSchema = modelFields[fieldName]
        if (!fieldSchema) {
          throw new Error(
            `Entity "${config.entityType}": refs config references field "${fieldName}" which does not exist in the model`,
          )
        }
        if (!isRef(fieldSchema) && !isRefField(fieldName, config.model as Schema.Top)) {
          throw new Error(
            `Entity "${config.entityType}": refs config references field "${fieldName}" which does not have the DynamoModel.ref annotation. Add DynamoModel.ref to the model field or set { ref: true } in DynamoModel.configure.`,
          )
        }

        const idField = getIdentifierField(refEntity.model as Schema.Top)
        if (!idField) {
          throw new Error(
            `Entity "${config.entityType}": ref field "${fieldName}" references entity "${refEntity.entityType}" which has no identifier field. Add DynamoModel.identifier to the model field or set { identifier: true } in DynamoModel.configure.`,
          )
        }

        return {
          fieldName,
          idFieldName: `${fieldName}Id`,
          identifierField: idField.name,
          identifierSchema: idField.schema,
          refEntity,
          refEntityType: refEntity.entityType,
        }
      })
    : []

  const hasRefs = resolvedRefs.length > 0

  // ---------------------------------------------------------------------------
  // Auto-generate cascade indexes from expanded ref configs
  // ---------------------------------------------------------------------------

  const cascadeIndexes: globalThis.Record<string, IndexDefinition> = {}
  if (config.refs) {
    for (const [refFieldName, refValue] of Object.entries(config.refs)) {
      const cascadeConfig = refValue.cascade
      if (!cascadeConfig) continue
      const ref = resolvedRefs.find((r) => r.fieldName === refFieldName)!
      cascadeIndexes[`_cascade_${refFieldName}`] = {
        index: cascadeConfig.index,
        pk: { field: cascadeConfig.pk.field, composite: [ref.idFieldName] },
        sk: { field: cascadeConfig.sk.field, composite: [...config.indexes.primary.pk.composite] },
      }
    }
  }
  const initialIndexes: globalThis.Record<string, IndexDefinition> = {
    ...config.indexes,
    ...cascadeIndexes,
  }

  // Build immutable fields set from ConfiguredModel
  const immutableFields = new Set<string>()
  for (const [fieldName, attrConfig] of Object.entries(configuredAttributes)) {
    if ((attrConfig as { immutable?: boolean }).immutable) immutableFields.add(fieldName)
  }

  // Resolve identifier field name from model annotation
  const resolvedIdentifier = getIdentifierField(config.model as Schema.Top)?.name

  // Validate: no model field combines a transform schema with a ConfiguredModel override.
  validateNoTransformOverride(modelFields, configuredAttributes)

  // Resolve effective field encodings.
  const fieldEncodings = buildFieldEncodings(modelFields, configuredAttributes)

  const generatedIdField =
    config.generatedId !== undefined && config.generatedId !== null
      ? (config.generatedId as GeneratedIdConfig).field
      : undefined
  const generatedIdVersion =
    config.generatedId !== undefined && config.generatedId !== null
      ? ((config.generatedId as GeneratedIdConfig).version ?? "v4")
      : undefined

  const schemas = buildDerivedSchemas(
    modelFields,
    initialIndexes,
    systemFields,
    resolvedRefs,
    immutableFields,
    resolvedIdentifier,
    config.timeSeries,
    fieldEncodings,
    generatedIdField,
  )

  const entityType = config.entityType
  const entityVersion = 1

  // ---------------------------------------------------------------------------
  // Sparse Map fields (storedAs: 'sparse') — validation + resolution
  // ---------------------------------------------------------------------------

  const sparseFields: globalThis.Record<string, SparseConfig> = getSparseFields(
    config.model as Schema.Top,
  )
  const hasSparseFields = Object.keys(sparseFields).length > 0
  if (hasSparseFields) {
    for (const fieldName of Object.keys(sparseFields)) {
      const fieldSchema = modelFields[fieldName]
      if (!fieldSchema) {
        throw new Error(
          `[EDD-9020] Entity "${config.entityType}": sparse field "${fieldName}" does not exist on the model`,
        )
      }
      const recordInfo = isRecordSchema(fieldSchema)
      if (!recordInfo) {
        throw new Error(
          `[EDD-9020] Entity "${config.entityType}": sparse field "${fieldName}" must be a Schema.Record. ` +
            `Got a non-Record schema. Sparse storage flattens Record entries into per-key top-level attributes.`,
        )
      }
      if (isRecordAst(recordInfo.valueAst)) {
        throw new Error(
          `[EDD-9021] Entity "${config.entityType}": sparse field "${fieldName}" has a Record-typed value schema. ` +
            `Nested sparse Records are not supported — use Schema.Struct, Schema.Number, etc. for the inner value.`,
        )
      }
    }

    const allComposites = new Set<string>(allCompositeAttributes(initialIndexes))
    for (const fieldName of Object.keys(sparseFields)) {
      if (allComposites.has(fieldName)) {
        throw new Error(
          `[EDD-9022] Entity "${config.entityType}": sparse field "${fieldName}" cannot be a primary-key or GSI composite. ` +
            `Composite values must be known at make() time; sparse-map keys are not.`,
        )
      }
    }
    if (config.unique) {
      const sparseSet = new Set(Object.keys(sparseFields))
      for (const [constraintName, constraintDef] of Object.entries(config.unique)) {
        const fields = resolveUniqueFields(constraintDef)
        for (const f of fields) {
          if (sparseSet.has(f)) {
            throw new Error(
              `[EDD-9022] Entity "${config.entityType}": unique constraint "${constraintName}" cannot reference sparse field "${f}".`,
            )
          }
        }
      }
    }

    const seenPrefix = new Map<string, string>()
    for (const [fieldName, sparse] of Object.entries(sparseFields)) {
      const existing = seenPrefix.get(sparse.prefix)
      if (existing) {
        throw new Error(
          `[EDD-9023] Entity "${config.entityType}": sparse fields "${existing}" and "${fieldName}" share prefix "${sparse.prefix}". Prefixes must be distinct.`,
        )
      }
      seenPrefix.set(sparse.prefix, fieldName)
      if (sparse.prefix !== fieldName && sparse.prefix in modelFields) {
        throw new Error(
          `[EDD-9023] Entity "${config.entityType}": sparse field "${fieldName}" prefix "${sparse.prefix}" collides with non-sparse field "${sparse.prefix}".`,
        )
      }
    }
  }

  // EDD-9005: validate every configured TTL eagerly at make() time.
  {
    const configuredTtls: Array<Duration.Duration | string> = []
    if (typeof config.versioned === "object" && config.versioned?.ttl !== undefined) {
      configuredTtls.push(config.versioned.ttl)
    }
    if (typeof config.softDelete === "object" && config.softDelete?.ttl !== undefined) {
      configuredTtls.push(config.softDelete.ttl)
    }
    if (config.timeSeries?.ttl !== undefined) configuredTtls.push(config.timeSeries.ttl)
    if (config.unique) {
      for (const def of Object.values(config.unique)) {
        const uTtl = resolveUniqueTtl(def)
        if (uTtl !== undefined) configuredTtls.push(uTtl)
      }
    }
    for (const ttl of configuredTtls) normalizeTtlSeconds(ttl)
  }

  // Bind every Z-order sort key (#171): resolve each dimension's storage from
  // the field's schema (EDD-9088), check the bit budget (EDD-9089) and lay the
  // address out. Unbound halves never reach the composers. Runs after the
  // composite checks above (EDD-9002, 9025, 9072, 9022 — which read the derived
  // `composite`), so a prefix composite or dimension reports those codes first.
  const inputFields = getSchemaFields(schemas.inputSchema as Schema.Top) ?? modelFields
  for (const [indexName, indexDef] of Object.entries(initialIndexes)) {
    if (!isZOrderHalf(indexDef.sk)) continue
    initialIndexes[indexName] = {
      ...indexDef,
      sk: bindZOrderHalf(config.entityType, indexName, indexDef.sk, (field) => ({
        schema: inputFields[field],
        encoding: fieldEncodings[field] ?? optionalFieldEncoding(modelFields[field]),
      })),
    }
  }

  // Bind every sharded index (#183): its source is `by`, or the primary key's
  // composites. Unbound indexes never compose a key.
  for (const [indexName, indexDef] of Object.entries(initialIndexes)) {
    if (indexDef.shards === undefined) continue
    initialIndexes[indexName] = {
      ...indexDef,
      shards: bindShards(config.entityType, indexName, indexDef, primaryIndex),
    }
  }
  refuseAppendThatCannotShard(config.entityType, initialIndexes, config.timeSeries)
  refuseRepeatedIndex(config.entityType, initialIndexes)
  refuseSharedKeyAttributeOnEverySchema(config.entityType, initialIndexes)

  // ---------------------------------------------------------------------------
  // Field renaming: domain name → DynamoDB attribute name (from ConfiguredModel)
  // ---------------------------------------------------------------------------

  const fieldRenames: globalThis.Record<string, string> = {}
  for (const [domainName, attrConfig] of Object.entries(configuredAttributes)) {
    const field = (attrConfig as { field?: string }).field
    if (field) fieldRenames[domainName] = field
  }
  const hasRenames = Object.keys(fieldRenames).length > 0
  const storedAttributes = [
    ...Object.keys(modelFields).map(
      (name) => [name, fieldRenames[name] ?? name] as readonly [string, string],
    ),
    ...[systemFields.createdAt, systemFields.updatedAt, systemFields.version]
      .filter((name) => name !== null)
      .map((name) => [name, name] as readonly [string, string]),
  ]
  refuseStoredInTableKey(config.entityType, primaryIndex, storedAttributes)
  refuseStoredUnderLibraryAttribute(config.entityType, primaryIndex, storedAttributes, sparseFields)

  const renameToDynamo = (item: globalThis.Record<string, unknown>): void => {
    if (!hasRenames) return
    for (const [domain, dynamo] of Object.entries(fieldRenames)) {
      if (domain in item) {
        item[dynamo] = item[domain]
        delete item[domain]
      }
    }
  }

  const renameFromDynamo = (item: globalThis.Record<string, unknown>): void => {
    if (!hasRenames) return
    for (const [domain, dynamo] of Object.entries(fieldRenames)) {
      if (dynamo in item) {
        item[domain] = item[dynamo]
        delete item[dynamo]
      }
    }
  }

  const resolveDbName = (domainName: string): string => fieldRenames[domainName] ?? domainName

  return {
    configuredAttributes: configuredAttributes as globalThis.Record<
      string,
      { readonly immutable?: boolean; readonly field?: string }
    >,
    rawModel,
    isSchemaClass,
    modelFields,
    hasHiddenFields,
    systemFields,
    validCompositeFields,
    resolvedRefs,
    hasRefs,
    cascadeIndexes,
    initialIndexes,
    immutableFields,
    resolvedIdentifier,
    fieldEncodings,
    schemas,
    entityType,
    entityVersion,
    sparseFields,
    hasSparseFields,
    packedFields: packedPlan.packedFields,
    packedAttributes: packedPlan.packedAttributes,
    dispatchAttributes: packedPlan.dispatchAttributes,
    hasPackedFields: packedPlan.hasPackedFields,
    fieldRenames,
    hasRenames,
    renameToDynamo,
    renameFromDynamo,
    resolveDbName,
    generatedIdField,
    generatedIdVersion,
    vectorIndexes,
    hasVectorIndexes,
  }
}

// ---------------------------------------------------------------------------
// Z-order binding (#171)
// ---------------------------------------------------------------------------

/**
 * The date encoding of an optional field's value schema. `buildFieldEncodings`
 * reads the top-level field schema, so `Schema.optional(DynamoModel.DateString)`
 * has no entry there; a dateTime dimension over it still needs its storage.
 */
const optionalFieldEncoding = (schema: Schema.Top | undefined): DynamoEncoding | undefined => {
  const inner = schema === undefined ? undefined : optionalField(schema)?.inner
  return inner === undefined ? undefined : (resolveFieldEncoding(inner, undefined) ?? undefined)
}

/**
 * `[EDD-9121]`: a key over a value the library changes on every write, where the write can't know
 * it or can't move the key (`DESIGN.md` §7, "Composites the library stamps").
 *
 * A plain `versioned` update adds one to the stored version without reading it, so a secondary index
 * over it would never hold a key. `versioned: { retain: true }` reads the item on every write, so
 * the value is known and the key moves with it. A primary key never changes, whatever is known, and
 * a shard follows its source, which a query could then never pin.
 */
const refuseKeysOverMovingValues = (
  entityType: string,
  indexes: globalThis.Record<string, IndexDefinition>,
  systemFields: ResolvedSystemFields,
  versioned: VersionedConfig | undefined,
): void => {
  const { updatedAt, version } = systemFields
  const retained = typeof versioned === "object" && versioned !== null && versioned.retain === true
  const moving = [updatedAt, version].filter((field): field is string => field !== null)
  const primary = indexes.primary
  for (const field of moving) {
    if (
      primary !== undefined &&
      [...primary.pk.composite, ...primary.sk.composite].includes(field)
    ) {
      throw new Error(
        `[EDD-9121] Entity "${entityType}": the primary key can't be composed from "${field}". ` +
          `The library changes it on every write and a primary key never changes, so the key ` +
          `would stop matching the value at the first update. Remove it from the primary key, or ` +
          `use a field the library doesn't manage.`,
      )
    }
  }
  for (const [indexName, index] of Object.entries(indexes)) {
    if (indexName === "primary") continue
    for (const field of moving) {
      if (index.shards?.by?.includes(field) === true) {
        throw new Error(
          `[EDD-9121] Entity "${entityType}": index "${indexName}" shards.by can't name "${field}". ` +
            `The library changes it on every write, so the shard would go stale on each one and ` +
            `no pin could reach the item. Omit it to hash the primary key.`,
        )
      }
    }
    if (
      version !== null &&
      !retained &&
      [...index.pk.composite, ...index.sk.composite].includes(version)
    ) {
      throw new Error(
        `[EDD-9121] Entity "${entityType}": index "${indexName}" can't be composed from "${version}". ` +
          `The library adds one to it on every write without reading the item, so the new value ` +
          `isn't known when the key is written and no item would ever hold this key. Remove it ` +
          `from the index, or use \`versioned: { retain: true }\`, which reads the item on every ` +
          `write.`,
      )
    }
  }
}

/** `[EDD-9090]`: a Z-order index is never a collection member. */
export const zorderInCollection = (entityType: string, indexName: string): Error =>
  new Error(
    `[EDD-9090] Entity "${entityType}": index "${indexName}" has a Z-order sort key and ` +
      `can't belong to a collection — a collection's members share sort-key text, and a ` +
      `Z-order key is a binary address. Query it through its own accessor.`,
  )

/**
 * Bind a normalised Z-order sort key to an entity's fields: resolve each
 * declared dimension against its field (`[EDD-9087]`, `[EDD-9088]`), check the
 * bit budget (`[EDD-9089]`) and lay the address out.
 */
const bindZOrderHalf = (
  entityType: string,
  indexName: string,
  half: ZOrderSkPart,
  fieldOf: (field: string) => DimensionField,
): ZOrderSkPart => {
  const bound: Array<BoundDimension> = []
  for (const declared of half.zorderHalf.dimensions) {
    const { spec, storage } = resolveDimension(
      entityType,
      indexName,
      declared,
      fieldOf(declared.field),
    )
    const limit = MAX_DIMENSION_BITS[spec.kind]
    if (spec.bits > limit) {
      throw new Error(
        `[EDD-9089] Entity "${entityType}": index "${indexName}" dimension ` +
          `"${spec.field}" needs ${spec.bits} bits; a ${dimensionLabel(spec.kind)} dimension ` +
          `takes at most ${limit}. ${
            spec.kind === "int" || spec.kind === "float"
              ? "Widen its step or narrow its range."
              : spec.kind === "string"
                ? "Lower its bytes."
                : "Lower its bits."
          }`,
      )
    }
    bound.push(bindDimension(spec, storage))
  }
  const layout = makeLayout(bound)
  if (layout.bits > MAX_ADDRESS_BITS) {
    throw new Error(
      `[EDD-9089] Entity "${entityType}": index "${indexName}" interleaves ${layout.bits} bits; ` +
        `a Z-order address takes at most ${MAX_ADDRESS_BITS} (${MAX_ADDRESS_BITS / 8} bytes). ` +
        `Coarsen a dimension's step or drop a dimension.`,
    )
  }
  return { ...half, zorderHalf: { ...half.zorderHalf, layout } }
}

const dimensionLabel = (kind: BoundDimension["spec"]["kind"]): string =>
  kind === "int" || kind === "float" ? "range" : kind === "dateTime" ? "date-time" : kind

// ---------------------------------------------------------------------------
// Pure decode helper used by the definition's `_decodeRecord` is AWS-coupled
// (it lives in the runtime package). The pure definition exposes only
// `_attachPrototype`, which is pure.
// ---------------------------------------------------------------------------

const buildAttachPrototype = (data: EntityDefinitionData): ((decoded: any) => any) => {
  // Schema.Class models carry a prototype; Schema.Struct models do not.
  // Mirror the runtime's attachPrototype exactly.
  const rawModel = data.rawModel as any
  return (decoded: any) =>
    data.isSchemaClass ? Object.assign(Object.create(rawModel.prototype), decoded) : decoded
}

// ---------------------------------------------------------------------------
// Entity.make — pure definition constructor
// ---------------------------------------------------------------------------

/**
 * Create a pure Entity definition.
 *
 * Returns an {@link EntityDefinition} carrying the model binding, index
 * definitions, system-field configuration, and the derived `inputSchema` /
 * `updateSchema` / `createSchema`. This pure form is AWS-SDK-free — import it
 * from `@effect-dynamodb/schema` when you only need the derived schemas (e.g.
 * for HttpApi payloads or validation).
 *
 * The full operational `Entity.make` (with CRUD/query operations) is exported
 * from `effect-dynamodb`; its return type extends {@link EntityDefinition}.
 *
 * @example
 * ```typescript
 * const Tasks = Entity.make({
 *   model: Task,
 *   entityType: "Task",
 *   primaryKey: { pk: { field: "pk", composite: ["taskId"] }, sk: { field: "sk", composite: [] } },
 * })
 * // typeof Tasks.inputSchema.Type  → the typed input payload
 * ```
 */
export const make = <
  TModel extends Schema.Top,
  const TEntityType extends string,
  const TRefs extends EntityRefsConfig<TModel> | undefined,
  const TPrimaryKey extends EntityPrimaryKeyConfig<TModel, RefsOrNone<TRefs>>,
  const TGsiIndexes extends EntityIndexesConfig<TModel, RefsOrNone<TRefs>> = {},
  const TTimestamps extends TimestampsConfig | undefined = undefined,
  const TVersioned extends VersionedConfig | undefined = undefined,
  const TSoftDelete extends SoftDeleteConfig | undefined = undefined,
  const TUnique extends EntityUniqueConfig<TModel> | undefined = undefined,
  const TTimeSeries extends EntityTimeSeriesConfig<TModel> | undefined = undefined,
  const TGeneratedId extends EntityGeneratedIdConfig<TModel> | undefined = undefined,
  const TVectorIndexes extends EntityVectorIndexesConfig<TModel> | undefined = undefined,
  const TAttrs extends {} = {},
>(config: {
  readonly model: TModel | ConfiguredModel<TModel, TAttrs>
  readonly entityType: TEntityType
  readonly primaryKey: TPrimaryKey
  readonly indexes?: TGsiIndexes &
    EntityIndexesGuard<TModel, TRefs, TGsiIndexes, TPrimaryKey, TVersioned>
  readonly timestamps?: TTimestamps
  readonly versioned?: TVersioned
  readonly softDelete?: TSoftDelete
  readonly unique?: TUnique
  readonly refs?: TRefs & RefsKeyGuard<TModel, TRefs>
  readonly timeSeries?: TTimeSeries &
    AppendInputFields<TModel, TTimeSeries> &
    AppendShardGuard<TGsiIndexes, TTimeSeries>
  readonly generatedId?: TGeneratedId
  readonly vectorIndexes?: TVectorIndexes
}): EntityDefinition<
  TModel,
  TEntityType,
  NormalizedIndexes<TPrimaryKey, TGsiIndexes>,
  TTimestamps,
  TVersioned,
  TSoftDelete,
  TUnique,
  RefsOrNone<TRefs>,
  ExtractIdentifier<ConfiguredModel<TModel, TAttrs>>,
  TTimeSeries,
  TGeneratedId,
  TVectorIndexes,
  ExtractPackedFields<ConfiguredModel<TModel, TAttrs>>,
  ExtractUnremovableFields<ConfiguredModel<TModel, TAttrs>>
> => {
  const gsiIndexes: globalThis.Record<string, IndexDefinition> = {}
  if (config.indexes) {
    for (const [name, gsi] of Object.entries(config.indexes)) {
      gsiIndexes[name] = normalizeGsiConfig(gsi as unknown as GsiConfig)
    }
  }
  const indexes = { primary: config.primaryKey, ...gsiIndexes } as globalThis.Record<
    string,
    IndexDefinition
  > & { readonly primary: IndexDefinition }

  return makeDefinitionImpl({ ...config, indexes }) as any
}

const makeDefinitionImpl = (config: {
  readonly model: Schema.Top | ConfiguredModel<Schema.Top, any>
  readonly entityType: string
  readonly indexes: globalThis.Record<string, IndexDefinition> & {
    readonly primary: IndexDefinition
  }
  readonly timestamps?: TimestampsConfig | undefined
  readonly versioned?: VersionedConfig | undefined
  readonly softDelete?: SoftDeleteConfig | undefined
  readonly unique?: UniqueConfig | undefined
  readonly refs?: globalThis.Record<string, AnyRefValue> | undefined
  readonly timeSeries?: TimeSeriesConfig<any> | undefined
  readonly generatedId?: GeneratedIdConfig | undefined
  readonly vectorIndexes?: globalThis.Record<string, VectorIndexConfig> | undefined
}): EntityDefinition => {
  const data = buildEntityDefinition(config)

  let allIndexes = data.initialIndexes
  let schema!: DynamoSchema.DynamoSchema
  let tableTag: unknown
  const attachPrototype = buildAttachPrototype(data)

  const definition = {
    _tag: "Entity" as const,
    model: config.model as Schema.Top,
    entityType: config.entityType,
    get indexes() {
      return allIndexes
    },
    timestamps: config.timestamps,
    versioned: config.versioned,
    softDelete: config.softDelete,
    unique: config.unique,
    identifier: data.resolvedIdentifier as any,
    timeSeries: config.timeSeries,
    generatedId: config.generatedId,
    vectorIndexes: config.vectorIndexes,
    _vectorIndexes: data.vectorIndexes,
    _packedFields: Object.keys(data.packedFields),
    _resolvedRefs: data.resolvedRefs.map((r) => ({
      fieldName: r.fieldName,
      idFieldName: r.idFieldName,
      identifierField: r.identifierField,
      refEntityType: r.refEntityType,
    })),
    _attachPrototype: attachPrototype,
    _configure: (injectedSchema: DynamoSchema.DynamoSchema, injectedTableTag: unknown) => {
      schema = injectedSchema
      tableTag = injectedTableTag
    },
    _injectIndex: (name: string, def: IndexDefinition) => {
      if (isZOrderHalf(def.sk)) throw zorderInCollection(data.entityType, name)
      const refused = packedIndexRefusal(data.entityType, data.packedFields, name, def)
      if (refused !== undefined) throw new Error(refused)
      allIndexes = { ...allIndexes, [name]: def }
    },
    get _schema() {
      return schema
    },
    get _tableTag() {
      return tableTag
    },
    systemFields: data.systemFields,
    schemas: data.schemas,
    inputSchema: data.schemas.inputSchema as any,
    createSchema: data.schemas.createSchema as any,
    updateSchema: data.schemas.updateSchema as any,
    // Retain the normalized config + derived data so the runtime package can
    // promote this pure definition into a full operational Entity.
    _config: config,
    _data: data,
  }
  return definition as unknown as EntityDefinition
}
