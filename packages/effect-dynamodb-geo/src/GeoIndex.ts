/**
 * GeoIndex — Geospatial index for effect-dynamodb entities.
 *
 * Binds geospatial configuration to an Entity and provides:
 * - `put` — write with automatic geo field enrichment
 * - `nearby` — radius-based proximity search
 * - `enrich` — lower-level geo field computation (for transactions/batch writes)
 *
 * **Offloaded fields** (#179, design §8.4). A geo entity may offload fields
 * (`DynamoModel.Packed({ external })`, `DynamoModel.External(...)`): `put`
 * uploads them through the entity's own put, and `nearby` reads both kinds
 * eagerly — one `A` types a GeoIndex's inputs and its results, so a binary
 * field is its bytes on both sides (a `Uint8Array` input, never a lazy
 * handle in a result). Both then carry `BlobStoreError`, the entity's
 * table schema must set `escapeKeys: true` (`[EDD-9146]`), and {@link bind}
 * needs a `BlobStore` in its context (`[EDD-9115]`).
 */

import { type Context, Duration, Effect, Option, type Semaphore } from "effect"
import type {
  BlobStoreError,
  ConcurrentModification,
  DynamoClient,
  DynamoClientError,
  DynamoSchema,
  EntityPut,
  KeyComposer,
  Offload,
  OptimisticLockError,
  Table,
  TransactionOverflow,
  UniqueConstraintViolation,
  ValidationError,
} from "effect-dynamodb"
import { ConsumedCapacity, Entity } from "effect-dynamodb"
import * as _GeoSearch from "./GeoSearch.js"
import * as H3 from "./H3.js"
import type { LatLng } from "./Spherical.js"

export type { LatLng } from "./Spherical.js"

/**
 * The width of a time partition (#292): `"hourly"` (one hour, the width every
 * release before 1.47 used) or any `Duration` input — `"1 day"`,
 * `Duration.days(1)`, `{ hours: 6 }`, or a number of milliseconds. It must be a
 * positive whole number of milliseconds (`[EDD-9185]`, thrown by `make`).
 *
 * Partitions are `floor(timestamp / width)`, counted from the Unix epoch, so a
 * daily bucket is a UTC day. The partition value does not record the width:
 * changing the width of an index that holds data leaves its rows under
 * partition values the new width never reads, until each item is written again.
 */
export type TimeBucket = "hourly" | Duration.Input
export type SortOrder = "ASC" | "DESC"

const describeBucket = (bucket: unknown): string => {
  if (typeof bucket === "string") return JSON.stringify(bucket)
  if (typeof bucket === "bigint") return `${bucket}n`
  if (Duration.isDuration(bucket)) return `Duration(${Duration.format(bucket)})`
  try {
    return JSON.stringify(bucket) ?? String(bucket)
  } catch {
    return String(bucket)
  }
}

/**
 * A time bucket's width in milliseconds (#292): `"hourly"` is one hour, and any
 * other value is read as a `Duration` input. Throws `[EDD-9185]` for a value
 * that is not a positive, finite, whole number of milliseconds (zero, negative,
 * fractional, infinite, `NaN`, or not a duration at all).
 */
export const bucketMillis = (bucket: TimeBucket): number => {
  if (bucket === "hourly") return H3.HOURLY_BUCKET_MS
  const fail = (): never => {
    throw new Error(
      `[EDD-9185] GeoIndex: fields.timePartition.bucket must be "hourly" or a Duration of a ` +
        `positive whole number of milliseconds (for example "1 day" or Duration.hours(6)); ` +
        `got ${describeBucket(bucket)}.`,
    )
  }
  // `Duration.fromInput` reads a `NaN` number as zero, which the check below
  // refuses anyway; it is checked first so the message names what was given.
  if (typeof bucket === "number" && Number.isNaN(bucket)) return fail()
  const duration = Duration.fromInput(bucket)
  if (Option.isNone(duration) || !Duration.isFinite(duration.value)) return fail()
  const ms = Duration.toMillis(duration.value)
  return Number.isSafeInteger(ms) && ms > 0 ? ms : fail()
}

/**
 * The geo attributes `GeoIndex.make` computes and reads. `F` is the entity
 * input's field names: each `field` is a model field the index composes, and
 * `timePartition.source` the model field holding the epoch-ms timestamp.
 */
export interface GeoFields<F extends string = string> {
  readonly cell: { readonly field: F; readonly resolution: number }
  readonly parentCell: { readonly field: F; readonly resolution: number }
  readonly timePartition: {
    readonly field: F
    readonly source: F
    readonly bucket: TimeBucket
  }
}

/** The field names of an entity input `A`: any name when `A` is unknown. */
export type GeoFieldName<A> = unknown extends A ? string : keyof A & string

export interface Coordinates {
  readonly latitude: number
  readonly longitude: number
}

export interface NearbyOptions {
  readonly center: LatLng
  readonly radius: number
  readonly unit?: H3.GeoUnit
  /**
   * Inclusive time range, in epoch milliseconds, compared against each item's
   * `timePartition.source` field. Selects the time partitions to query and
   * then keeps only the items whose source timestamp lies in `[start, end]`;
   * an item without a numeric source timestamp is never returned.
   *
   * Defaults to the past 15 minutes (`{ start: now - 15 min, end: now }`).
   */
  readonly timeWindow?: { readonly start: number; readonly end: number }
  readonly sort?: SortOrder
  readonly pkFilter?: Record<string, unknown>
}

export interface NearbyResult<A> {
  readonly item: A
  readonly distance: number
}

/**
 * Structural type for the entity properties GeoIndex needs — an
 * effect-dynamodb `Entity` provides them all.
 *
 * @typeParam A - The entity's put input
 * @typeParam P - The entity's put builder
 * @typeParam TOffload - The fields the entity offloads (type-only, #179)
 */
export interface GeoEntity<A, P, TOffload extends Offload.OffloadFields = Offload.NoOffload> {
  readonly _schema: DynamoSchema.DynamoSchema
  readonly _tableTag: Context.Service<Table.TableConfig, Table.TableConfig>
  readonly entityType: string
  readonly indexes: Record<string, KeyComposer.IndexDefinition>
  /**
   * The key form of a DOMAIN record — search must compose GSI keys exactly as
   * `put` wrote them (#111), from the key form of the values `put` stores.
   */
  readonly _domainKeyForm: (record: Record<string, unknown>) => Record<string, unknown>
  /** `Entity._givenValues`: how a search's `pkFilter` is read (`GeoSearch.givenValues`). */
  readonly _givenValues?: _GeoSearch.GivesValues["_givenValues"]
  /**
   * The entity's row decoder, as its own queries decode (#147, #179): a
   * stored-name row loaded — packed fields unpacked, blob pointers resolved
   * per `modes` — then sparse fields rebuilt, renames undone and the record
   * schema decoded.
   */
  readonly _decodeRecord: (
    raw: Record<string, unknown>,
    modes?: Offload.ResolvedOffloadModes,
    operation?: string,
  ) => Effect.Effect<unknown, ValidationError | BlobStoreError>
  /**
   * Load a batch of stored-name rows in place (unpack + resolve per `modes`):
   * a query's page prefetch, so a page's offloaded values are fetched
   * together, at the store's read concurrency (design §8.2) — within
   * `permits`, which a search's parallel queries share.
   */
  readonly _loadRows: (
    rows: ReadonlyArray<Record<string, unknown>>,
    options: {
      readonly operation: string
      readonly modes: Offload.ResolvedOffloadModes
      readonly raw?: boolean | undefined
      readonly permits?: Semaphore.Semaphore | undefined
    },
  ) => Effect.Effect<void, ValidationError | BlobStoreError>
  /** The stored attributes `_loadRows` may rewrite (none: a search prefetches nothing). */
  readonly _readAttributes: ReadonlyArray<string>
  /**
   * The context the entity's operations run in when bound in `context`: its
   * configuration checks (`[EDD-9146]` escaped key text, `[EDD-9078]` codecs,
   * `[EDD-9115]` blob store, thrown naming `where`) and a default
   * `SecureRandom` for a `generatedId` put.
   */
  readonly _bindContext: <R>(where: string, context: Context.Context<R>) => Context.Context<R>
  /** @internal Type-only: the fields the entity offloads, by kind (#179). */
  readonly _offloadFields?: TOffload | undefined
  readonly put: (input: A) => P
}

/**
 * The store errors of a geo entity's operations (#179, design §9.3):
 * `BlobStoreError` when the entity offloads any field — its writes upload,
 * and `nearby` resolves both kinds eagerly — `never` otherwise (and for a
 * type-erased entity).
 */
export type GeoBlobErrors<TOffload extends Offload.OffloadFields> =
  Offload.WriteBlobErrors<TOffload>

/**
 * A GeoIndex's item type over the entity's put input `A` (#179, design
 * §8.4): each binary field (`DynamoModel.External`) narrowed from the
 * entity's `Offload.BinaryInput` to its bytes, since the same type is both
 * `put`'s input and `nearby`'s result, which reads binary fields eagerly.
 * Exactly `A` for an entity without binary fields.
 */
export type GeoItem<A, TOffload extends Offload.OffloadFields> = 0 extends 1 & TOffload
  ? A
  : [TOffload["binary"]] extends [never]
    ? A
    : {
        [K in keyof A]: K extends TOffload["binary"]
          ? Exclude<A[K], Exclude<Offload.BinaryInput, Uint8Array>>
          : A[K]
      }

/**
 * @typeParam A - The item type: the entity's put input, binary fields as bytes
 * @typeParam P - The entity's put builder (`put`'s result)
 * @typeParam TBlobErrors - `BlobStoreError` when the entity offloads a field
 */
export interface GeoIndex<A, P, TBlobErrors = never> {
  /** Write an item with automatic geo field enrichment. */
  readonly put: (input: A) => P
  /**
   * Search for items near a geographic point within a given radius. Offloaded
   * fields are read eagerly, both kinds (#179).
   */
  readonly nearby: (
    options: NearbyOptions,
  ) => Effect.Effect<
    Array<NearbyResult<A>>,
    DynamoClientError | ValidationError | TBlobErrors,
    DynamoClient | Table.TableConfig
  >
  /** Compute geo fields for an input (for use with transactions/batch writes). */
  readonly enrich: (input: A) => A
}

/**
 * Create a GeoIndex that binds geospatial configuration to an entity's GSI.
 *
 * Returns an object with `put`, `nearby`, and `enrich` methods.
 *
 * @example
 * ```typescript
 * const VehicleGeo = GeoIndex.make({
 *   entity: Vehicles,
 *   index: "byCell",
 *   coordinates: (item) => item.latitude !== undefined && item.longitude !== undefined
 *     ? { latitude: item.latitude, longitude: item.longitude }
 *     : undefined,
 *   fields: {
 *     cell: { field: "cell", resolution: 15 },
 *     parentCell: { field: "parentCell", resolution: 3 },
 *     timePartition: { field: "timePartition", source: "timestamp", bucket: "hourly" },
 *   },
 * })
 *
 * // Write — geo fields computed automatically
 * yield* VehicleGeo.put({ vehicleId: "v-1", latitude: 37.77, longitude: -122.42, timestamp: now })
 *
 * // Search
 * const results = yield* VehicleGeo.nearby({ center, radius: 2000, unit: "m" })
 * ```
 */
export const make = <
  A,
  P,
  TOffload extends Offload.OffloadFields = Offload.NoOffload,
  TIndexes extends Record<string, KeyComposer.IndexDefinition> = Record<
    string,
    KeyComposer.IndexDefinition
  >,
>(config: {
  readonly entity: GeoEntity<A, P, TOffload> & { readonly indexes: TIndexes }
  /** One of the entity's indexes, by name. */
  readonly index: keyof TIndexes & string
  readonly coordinates: (item: GeoItem<A, TOffload>) => Coordinates | undefined
  readonly fields: GeoFields<GeoFieldName<A>>
}): GeoIndex<GeoItem<A, TOffload>, P, GeoBlobErrors<TOffload>> => {
  type Item = GeoItem<A, TOffload>
  const indexDef = config.entity.indexes[config.index] as KeyComposer.IndexDefinition | undefined
  if (!indexDef) {
    throw new Error(`GeoIndex: index "${config.index}" not found on entity`)
  }
  if (indexDef.shards !== undefined) {
    throw new Error(
      `[EDD-9104] GeoIndex: index "${config.index}" is sharded, and a GeoIndex over a sharded ` +
        `index isn't supported: its search plans read one partition per cell and time bucket.`,
    )
  }
  // Resolved once: `enrich` composes each row's partition with it, and `nearby`
  // enumerates the partitions of its window with it (#292).
  const bucketMs = bucketMillis(config.fields.timePartition.bucket)

  const enrich = (input: Item): Item => {
    const coords = config.coordinates(input)
    if (!coords) return input

    const { fields } = config
    const cell = H3.computeCell(coords.latitude, coords.longitude, fields.cell.resolution)
    const parentCell = H3.computeParentCell(cell, fields.parentCell.resolution)

    const record = input as Record<string, unknown>
    const timestampValue = record[fields.timePartition.source]
    if (typeof timestampValue !== "number") return input

    const timePartition = H3.computeTimePartition(timestampValue, bucketMs)

    return {
      ...(input as any),
      [fields.cell.field]: cell,
      [fields.parentCell.field]: parentCell,
      [fields.timePartition.field]: timePartition,
    }
  }

  const searchConfig: _GeoSearch.SearchConfig<Item> = {
    entity: config.entity,
    indexDef,
    coordinates: config.coordinates,
    fields: config.fields,
    bucketMs,
  }

  // Consumed-capacity reports (#174): a search is one `GeoIndex.nearby`
  // operation over all its cell queries. The unbound `put` stays the entity's
  // own put builder (so entity combinators still apply) and reports as
  // `Entity.put`; the bound `put` reports as `GeoIndex.put`.
  const target = { target: config.entity.entityType, index: config.index }
  return {
    // An `Item` is a put input whose binary fields are bytes.
    put: (input: Item) => config.entity.put(enrich(input) as A),
    nearby: (options: NearbyOptions) =>
      ConsumedCapacity.withOperation(
        _GeoSearch.nearby<Item, GeoBlobErrors<TOffload>>(searchConfig, options),
        "GeoIndex.nearby",
        target,
      ),
    enrich,
    _target: target,
    _entity: config.entity,
  } as GeoIndex<Item, P, GeoBlobErrors<TOffload>>
}

// ---------------------------------------------------------------------------
// BoundGeoIndex — dependencies resolved, R = never
// ---------------------------------------------------------------------------

/**
 * The errors of a bound put over an entity whose put builder's type is not
 * known (an annotated `BoundGeoIndex<A>`): the entity put's own, for an
 * entity with no refs, vector indexes or offloaded fields.
 */
export type GeoPutError =
  | DynamoClientError
  | ValidationError
  | UniqueConstraintViolation
  | OptimisticLockError
  | ConcurrentModification
  | TransactionOverflow

/**
 * The errors of the bound put over the put builder `P`: the entity put's
 * own (its refs', vector indexes' and blob store's included), else — for a
 * builder that is not an `EntityPut`, or a type-erased (`any`) one —
 * {@link GeoPutError} and `TBlobErrors`.
 */
export type GeoPutErrorOf<P, TBlobErrors = never> = 0 extends 1 & P
  ? GeoPutError | TBlobErrors
  : P extends EntityPut<any, any, infer E, any, any>
    ? E
    : GeoPutError | TBlobErrors

/**
 * A GeoIndex with `DynamoClient | Table.TableConfig` dependencies resolved.
 * All operations return `Effect<..., ..., never>`.
 *
 * @typeParam A - The item type (see {@link GeoItem})
 * @typeParam TBlobErrors - `BlobStoreError` when the entity offloads a field
 * @typeParam TPutError - The entity put's errors (see {@link GeoPutErrorOf})
 */
export interface BoundGeoIndex<A, TBlobErrors = never, TPutError = GeoPutError | TBlobErrors> {
  /**
   * Write an item with automatic geo field enrichment. R = never. Fails as the
   * entity's own `put` does. The result is the domain model, its offloaded
   * fields read eagerly (#179).
   */
  readonly put: (input: A) => Effect.Effect<A, TPutError, never>
  /** Search for items near a geographic point. R = never. */
  readonly nearby: (
    options: NearbyOptions,
  ) => Effect.Effect<
    Array<NearbyResult<A>>,
    DynamoClientError | ValidationError | TBlobErrors,
    never
  >
  /** Compute geo fields for an input (pure — same as GeoIndex.enrich). */
  readonly enrich: (input: A) => A
  /** Provide escape hatch for complex pipe chains. */
  readonly provide: <B, E>(
    effect: Effect.Effect<B, E, DynamoClient | Table.TableConfig>,
  ) => Effect.Effect<B, E, never>
}

/**
 * Resolve `DynamoClient | Table.TableConfig` dependencies and return a
 * `BoundGeoIndex` whose operations all have `R = never`.
 *
 * The context is checked as `Entity.bind` checks it: an entity that offloads
 * a field needs a table schema setting `escapeKeys: true` (`[EDD-9146]`), a
 * codec the entity's `Packed` fields name must be registered (`[EDD-9078]`),
 * and an entity that offloads a field needs a `BlobStore` (`[EDD-9115]`) —
 * each a configuration defect at bind, since its writes upload and `nearby`
 * resolves its pointers.
 * A store or compressor in context here wins over one at run time.
 *
 * @example
 * ```typescript
 * const geo = yield* GeoIndex.bind(VehicleGeo)
 * yield* geo.put({ vehicleId: "v-1", latitude: 37.77, longitude: -122.42, timestamp: Date.now() })
 * const results = yield* geo.nearby({ center, radius: 2000, unit: "m" })
 * ```
 */
export const bind = <A, P, TBlobErrors>(
  geoIndex: GeoIndex<A, P, TBlobErrors>,
): Effect.Effect<
  BoundGeoIndex<A, TBlobErrors, GeoPutErrorOf<P, TBlobErrors>>,
  never,
  DynamoClient | Table.TableConfig
> =>
  Effect.gen(function* () {
    // Detached: no current operation or parent span is pinned for later calls.
    // The entity's own binding context: its configuration checks, and a
    // default `SecureRandom` for a `generatedId` put, as `Entity.bind` bundles.
    const detached = ConsumedCapacity.detachContext(
      yield* Effect.context<DynamoClient | Table.TableConfig>(),
    )
    const entity = (geoIndex as { readonly _entity?: GeoEntity<unknown, unknown, any> })._entity
    const ctx = entity === undefined ? detached : entity._bindContext("GeoIndex.bind", detached)
    const provide = <B, E>(
      effect: Effect.Effect<B, E, DynamoClient | Table.TableConfig>,
    ): Effect.Effect<B, E, never> => Effect.provide(effect, ctx) as Effect.Effect<B, E, never>

    return {
      put: (input: A) =>
        provide(
          ConsumedCapacity.withOperation(
            // The result is typed `A`, the domain model: an offloaded field
            // reads eagerly, never as a lazy handle (#179, design §8.4).
            Entity.offloaded(geoIndex.put(input) as any, "eager").asEffect() as Effect.Effect<
              A,
              any,
              any
            >,
            "GeoIndex.put",
            (geoIndex as { readonly _target?: ConsumedCapacity.OperationOptions })._target,
          ),
        ),
      nearby: (options: NearbyOptions) => provide(geoIndex.nearby(options)),
      enrich: geoIndex.enrich,
      provide,
    } as BoundGeoIndex<A, TBlobErrors, GeoPutErrorOf<P, TBlobErrors>>
  })
