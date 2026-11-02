/**
 * GeoSearch — Internal geospatial search orchestration for DynamoDB.
 *
 * Composes multiple Query objects from effect-dynamodb core and executes them
 * in parallel to perform radius-based proximity searches using H3 hexagonal grid.
 *
 * @internal Used by GeoIndex — consumers should use `GeoIndex.nearby()`.
 */

import { type Context, Effect, Option, Semaphore } from "effect"
import type {
  BlobStoreError,
  DynamoClientError,
  DynamoSchema,
  Offload,
  Table,
} from "effect-dynamodb"
import { BlobStore, type DynamoClient, KeyComposer, Query, ValidationError } from "effect-dynamodb"
import * as h3 from "h3-js"
import type { Coordinates, GeoFields, NearbyOptions, NearbyResult } from "./GeoIndex.js"
import * as H3 from "./H3.js"
import * as Spherical from "./Spherical.js"

/** Internal config passed from GeoIndex.make to the search implementation. */
export interface SearchConfig<A> {
  readonly entity: {
    readonly _schema: DynamoSchema.DynamoSchema
    readonly _tableTag: Context.Service<Table.TableConfig, Table.TableConfig>
    readonly entityType: string
    readonly indexes: Record<string, KeyComposer.IndexDefinition>
    /**
     * The key form of a DOMAIN record (`Entity._domainKeyForm`). Search composes
     * GSI keys for rows written by `Entity.put`, so it composes the key form of
     * the values `put` stores for its domain values (#111).
     */
    readonly _domainKeyForm: (record: Record<string, unknown>) => Record<string, unknown>
    /** The entity's row decoder (see `GeoEntity._decodeRecord`). */
    readonly _decodeRecord: (
      raw: Record<string, unknown>,
      modes?: Offload.ResolvedOffloadModes,
      operation?: string,
    ) => Effect.Effect<unknown, ValidationError | BlobStoreError>
    /** The entity's batch row loader (see `GeoEntity._loadRows`). */
    readonly _loadRows: (
      rows: ReadonlyArray<Record<string, unknown>>,
      options: {
        readonly operation: string
        readonly modes: Offload.ResolvedOffloadModes
        readonly raw?: boolean | undefined
        readonly permits?: Semaphore.Semaphore | undefined
      },
    ) => Effect.Effect<void, ValidationError | BlobStoreError>
    /** The stored attributes `_loadRows` may rewrite. */
    readonly _readAttributes: ReadonlyArray<string>
  } & GivesValues
  readonly indexDef: KeyComposer.IndexDefinition
  readonly coordinates: (item: A) => Coordinates | undefined
  readonly fields: GeoFields
  readonly bucketMs: number
}

const H3_RESOLUTION_PRECISE = 15

/** @internal What {@link givenValues} needs of an entity. */
export type GivesValues = {
  /**
   * `Entity._givenValues`: a caller's record as a plain object, its own properties, and each of
   * `names` they lack read by name where they lack one. Absent on a hand-made entity, whose records
   * are read by their own properties alone.
   */
  readonly _givenValues?:
    | ((record: object, names: ReadonlyArray<string>) => Record<string, unknown>)
    | undefined
}

/**
 * @internal What a caller's filter gives, as a plain object: a spread of it, as 1.40.0 copied it,
 * and, only where that lacks one of `names` (the composites the search needs of it, where 1.40.0
 * failed: "Missing composite attribute"), each it lacks read by name, from a getter, its prototype
 * or a proxy (`Entity._givenValues`). A name whose read throws, from a getter the filter inherits,
 * is a property of the copy that throws again when read: the search fails with a `ValidationError`
 * naming it. So the copy is added to, never spread. Anything but an object is copied as a spread
 * copies it.
 */
export const givenValues = (
  entity: GivesValues,
  record: object | undefined,
  names: ReadonlyArray<string>,
): Record<string, unknown> => {
  if (record === undefined) return {}
  return entity._givenValues === undefined ? { ...record } : entity._givenValues(record, names)
}

/** @internal Stores `value` under `name` as `record`'s own property, `__proto__` included. */
export const setOwnValue = (
  record: Record<string, unknown>,
  name: string,
  value: unknown,
): void => {
  Object.defineProperty(record, name, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  })
}

/** The operation a search's decode failures and blob reads name. */
const DECODE = "GeoSearch.decode"

/**
 * Search for items near a geographic point within a given radius.
 *
 * Orchestrates:
 * 1. Compute the optimal H3 resolution for the radius
 * 2. Compute the ring size needed to cover it
 * 3. Generate the grid disk (concentric rings)
 * 4. Prune cells outside the radius
 * 5. Group contiguous cells into BETWEEN range query chunks
 * 6. Generate time partition keys for the time window
 * 7. Build N queries (one per timePartition x chunk combination), each keeping
 *    only items whose `timePartition.source` timestamp lies in the window
 * 8. Execute all queries in parallel, each decoding its rows through the
 *    entity's own decoder: packed fields unpacked, offloaded values of a
 *    page fetched together, both kinds eagerly (#147, #179, design §8.4) —
 *    the store reads of all the queries sharing one pool of the store's
 *    `readConcurrency` permits (§8.2)
 * 9. Post-process: compute great-circle distance, filter by radius, sort
 *
 * `EBlob` is `BlobStoreError` when the entity offloads a field, which the
 * eager reads may fail with.
 */
export const nearby = <A, EBlob = never>(
  config: SearchConfig<A>,
  options: NearbyOptions,
): Effect.Effect<
  Array<NearbyResult<A>>,
  DynamoClientError | ValidationError | EBlob,
  DynamoClient | Table.TableConfig
> =>
  Effect.gen(function* () {
    const { center, radius, unit = "m", sort = "ASC", pkFilter } = options
    const { latitude, longitude } = center

    // Step 1: Optimal H3 resolution for the search radius
    const searchResolution = H3.optimalResolution(latitude, longitude, radius)
    const cell = H3.computeCell(latitude, longitude, searchResolution)

    // Step 2: Number of rings needed
    const k = H3.optimalK(cell, radius, unit)

    // Step 3: Generate grid disk (concentric rings)
    const ringCells: string[][] = h3.gridDiskDistances(cell, k)

    // Step 4: Prune cells outside radius
    const prunedCells = H3.pruneCells(latitude, longitude, radius, ringCells)

    // Step 5: Group into contiguous chunks for BETWEEN queries
    const sortedChunks = H3.sequentialChunk(prunedCells.flat())

    // Step 6: Time partitions
    const now = Date.now()
    const startTime = options.timeWindow?.start ?? now - 15 * 60 * 1000
    const endTime = options.timeWindow?.end ?? now
    const timePartitions = H3.getTimePartitions(startTime, endTime, config.bucketMs)

    // A partition spans a whole bucket, so the first and last ones also hold
    // items from before `start` and after `end`. The window is a contract on
    // the items returned, not just on the buckets read: each one is kept only
    // when its source timestamp lies in `[start, end]` (#169).
    const sourceField = config.fields.timePartition.source
    const inTimeWindow = (item: A): boolean => {
      const timestamp = (item as Record<string, unknown>)[sourceField]
      return typeof timestamp === "number" && timestamp >= startTime && timestamp <= endTime
    }

    // Step 7: Build queries — one per (timePartition, chunk)
    const { entity, indexDef, fields } = config
    const dynamoIndexName = indexDef.index
    const pkField = indexDef.pk.field
    const skField = indexDef.sk.field

    const resolveTableName = entity._tableTag.useSync((tc: { name: string }) => tc.name)

    // Rows decode as the entity's own queries decode them (#147, #179): the
    // entity's decoder unpacks packed fields, undoes renames and rebuilds
    // sparse fields, and resolves offloaded values — eagerly here, both kinds
    // (`Query.offloaded("eager")` below), since a result is typed as the
    // domain model. A page's values are fetched together by the prefetch.
    // The decoder names a schema failure `decode`; a search's has always
    // been `GeoSearch.decode`.
    const decoder = (raw: Record<string, unknown>, modes: Offload.ResolvedOffloadModes) =>
      entity._decodeRecord(raw, modes, DECODE).pipe(
        Effect.mapError((error) =>
          error._tag === "ValidationError" && error.operation === "decode"
            ? new ValidationError({
                entityType: error.entityType,
                operation: DECODE,
                cause: error.cause,
              })
            : error,
        ),
      )
    // The queries run in parallel, so a limit per query would multiply: their
    // store reads share one pool of the store's `readConcurrency` permits for
    // the whole search, as a batch get's groups stay within it (§8.2).
    const store =
      entity._readAttributes.length === 0 ? Option.none() : yield* Effect.serviceOption(BlobStore)
    const permits = Option.isSome(store)
      ? yield* Semaphore.make(store.value.readConcurrency)
      : undefined
    const prefetch: Query.QueryPrefetch | undefined =
      entity._readAttributes.length === 0
        ? undefined
        : (rows, { modes, raw }) =>
            entity._loadRows(rows, { operation: DECODE, modes, raw, permits })

    // Group search cells by parent cell — when search resolution is low,
    // multiple search cells may map to the same parent cell at parentResolution
    const parentResolution = fields.parentCell.resolution

    // `pkFilter` is the caller's: a value no key can hold is a ValidationError.
    const composeQueryConfigs = () =>
      timePartitions.flatMap((partition) =>
        sortedChunks
          .map((chunk) => {
            const firstCell = chunk[0]
            const lastCell = chunk[chunk.length - 1]
            if (!firstCell || !lastCell) return undefined

            // Compute parent cell: if search resolution > parent resolution, use cellToParent.
            // Otherwise, the search cell IS at or below parent resolution — use it directly.
            const parentCell =
              searchResolution > parentResolution
                ? H3.computeParentCell(firstCell, parentResolution)
                : firstCell
            const lowerCell = H3.cellToCenterChild(firstCell, H3_RESOLUTION_PRECISE)
            const upperCell = H3.cellToUpperBound(lastCell, H3_RESOLUTION_PRECISE)

            // Build PK composites: geo fields + any extra filter composites.
            // `pkFilter` is a DOMAIN record supplied by the caller, and geo rows
            // are written through `Entity.put` — so it must go through the same
            // composite key form the write used. Latent while every composite is
            // a string on both sides, but a `timePartition: Schema.NumberFromString`
            // (a natural choice, since `computeTimePartition` returns a decimal
            // string) would compose an unpadded key the write never wrote (#111).
            // The filter gives the composites the search doesn't compute: the parent cell and the
            // time partition are set here, so the filter is never asked for them.
            const pkComposites = givenValues(
              entity,
              pkFilter,
              indexDef.pk.composite.filter(
                (attr) => attr !== fields.parentCell.field && attr !== fields.timePartition.field,
              ),
            )
            setOwnValue(pkComposites, fields.parentCell.field, parentCell)
            setOwnValue(pkComposites, fields.timePartition.field, partition)
            const pkCompositesKeyForm: Record<string, unknown> = entity._domainKeyForm(pkComposites)

            const pkValue = KeyComposer.composePk(
              entity._schema,
              entity.entityType,
              indexDef,
              pkCompositesKeyForm,
            )

            // Compose full SK values with schema prefix (must match stored SK format)
            const lower = KeyComposer.composeSk(
              entity._schema,
              entity.entityType,
              1,
              indexDef,
              entity._domainKeyForm({ [fields.cell.field]: lowerCell }),
            )
            const upper = KeyComposer.composeSk(
              entity._schema,
              entity.entityType,
              1,
              indexDef,
              entity._domainKeyForm({ [fields.cell.field]: upperCell }),
            )

            return { pkValue, lower, upper }
          })
          .filter((q): q is NonNullable<typeof q> => q !== undefined),
      )
    const queryConfigs = yield* Query.orRefusal(
      { name: "GeoIndex.nearby", target: entity.entityType },
      () => Effect.succeed(composeQueryConfigs()),
      (refusal): Effect.Effect<ReturnType<typeof composeQueryConfigs>, ValidationError> =>
        Effect.fail(refusal),
    )

    // Step 8: Build and execute all queries in parallel
    const allItems = yield* Effect.forEach(
      queryConfigs,
      (qc) => {
        const query = Query.make<A, EBlob>({
          tableName: "",
          indexName: dynamoIndexName,
          pkField,
          pkValue: qc.pkValue,
          skField,
          entityTypes: [entity.entityType],
          decoder: decoder as (
            raw: Record<string, unknown>,
            modes: Offload.ResolvedOffloadModes,
          ) => Effect.Effect<A, ValidationError | BlobStoreError>,
          prefetch,
          resolveTableName,
          keyFields: [
            pkField,
            skField,
            entity.indexes.primary?.pk.field,
            entity.indexes.primary?.sk.field,
          ],
        }).pipe(
          Query.where({ between: [qc.lower, qc.upper] as const }),
          // Before `filterBy`, whose predicate is typed on the item (`[EDD-9117]`).
          Query.offloaded("eager"),
          Query.filterBy(inTimeWindow),
        )

        return Query.collect(query)
      },
      { concurrency: "unbounded" },
    )

    const flatItems = allItems.flat()

    // Step 9: Compute distance, filter by radius, sort
    const results: Array<NearbyResult<A>> = []
    for (const item of flatItems) {
      const coords = config.coordinates(item)
      if (!coords) continue

      const distance = Spherical.greatCircleDistance(center, coords)
      if (unit === "km" ? distance / 1000 <= radius : distance <= radius) {
        results.push({ item, distance: unit === "km" ? distance / 1000 : distance })
      }
    }

    results.sort((a, b) => a.distance - b.distance)
    return sort === "ASC" ? results : results.reverse()
  })
