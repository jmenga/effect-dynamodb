/**
 * GeoSearch — Internal geospatial search orchestration for DynamoDB.
 *
 * Composes multiple Query objects from effect-dynamodb core and executes them
 * in parallel to perform radius-based proximity searches using H3 hexagonal grid.
 *
 * @internal Used by GeoIndex — consumers should use `GeoIndex.nearby()`.
 */

import type { DynamoClientError, Table } from "@effect-dynamodb/core"
import { type DynamoClient, KeyComposer, Query, ValidationError } from "@effect-dynamodb/core"
import { Effect, Schema } from "effect"
import * as h3 from "h3-js"
import type { Coordinates, GeoFields, NearbyOptions, NearbyResult } from "./GeoIndex.js"
import * as H3 from "./H3.js"
import * as Spherical from "./Spherical.js"

/** Internal config passed from GeoIndex.make to the search implementation. */
export interface SearchConfig<A> {
  readonly entity: {
    readonly table: Table.Table
    readonly entityType: string
    readonly indexes: Record<string, KeyComposer.IndexDefinition>
    readonly schemas: { readonly recordSchema: Schema.Codec<any> }
  }
  readonly indexDef: KeyComposer.IndexDefinition
  readonly coordinates: (item: A) => Coordinates | undefined
  readonly fields: GeoFields
  readonly bucketMs: number
}

const H3_RESOLUTION_PRECISE = 15

/**
 * Search for items near a geographic point within a given radius.
 *
 * Orchestrates:
 * 1. Compute optimal H3 resolution and ring size for the radius
 * 2. Generate and prune H3 cells within radius
 * 3. Group contiguous cells into BETWEEN range query chunks
 * 4. Generate time partition keys for the time window
 * 5. Build N queries (one per timePartition x chunk combination)
 * 6. Execute all queries in parallel
 * 7. Post-process: compute great-circle distance, filter by radius, sort
 */
export const nearby = <A>(
  config: SearchConfig<A>,
  options: NearbyOptions,
): Effect.Effect<
  Array<NearbyResult<A>>,
  DynamoClientError | ValidationError,
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

    // Step 7: Build queries — one per (timePartition, chunk)
    const { entity, indexDef, fields } = config
    const dynamoIndexName = indexDef.index
    const pkField = indexDef.pk.field
    const skField = indexDef.sk.field

    const resolveTableName = entity.table.Tag.useSync((tc: { name: string }) => tc.name)

    const decoder = (raw: Record<string, unknown>) =>
      Schema.decodeUnknownEffect(entity.schemas.recordSchema as Schema.Codec<any>)(raw).pipe(
        Effect.mapError(
          (cause) =>
            new ValidationError({
              entityType: entity.entityType,
              operation: "GeoSearch.decode",
              cause,
            }),
        ),
      )

    // Group search cells by parent cell — when search resolution is low,
    // multiple search cells may map to the same parent cell at parentResolution
    const parentResolution = fields.parentCell.resolution

    const queryConfigs = timePartitions.flatMap((partition) =>
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

          // Build PK composites: geo fields + any extra filter composites
          const pkComposites: Record<string, unknown> = {
            ...pkFilter,
            [fields.parentCell.field]: parentCell,
            [fields.timePartition.field]: partition,
          }

          const pkValue = KeyComposer.composePk(
            entity.table.schema,
            entity.entityType,
            indexDef,
            pkComposites,
          )

          // Compose full SK values with schema prefix (must match stored SK format)
          const lower = KeyComposer.composeSk(entity.table.schema, entity.entityType, 1, indexDef, {
            [fields.cell.field]: lowerCell,
          })
          const upper = KeyComposer.composeSk(entity.table.schema, entity.entityType, 1, indexDef, {
            [fields.cell.field]: upperCell,
          })

          return { pkValue, lower, upper }
        })
        .filter((q): q is NonNullable<typeof q> => q !== undefined),
    )

    // Step 8: Build and execute all queries in parallel
    const allItems = yield* Effect.forEach(
      queryConfigs,
      (qc) => {
        const query = Query.make<A>({
          tableName: "",
          indexName: dynamoIndexName,
          pkField,
          pkValue: qc.pkValue,
          skField,
          entityTypes: [entity.entityType],
          decoder: decoder as (raw: Record<string, unknown>) => Effect.Effect<A, ValidationError>,
          resolveTableName,
        }).pipe(Query.where({ between: [qc.lower, qc.upper] as const }))

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
