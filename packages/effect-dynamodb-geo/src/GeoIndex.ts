/**
 * GeoIndex — Geospatial index for effect-dynamodb entities.
 *
 * Binds geospatial configuration to an Entity and provides:
 * - `put` — write with automatic geo field enrichment
 * - `nearby` — radius-based proximity search
 * - `enrich` — lower-level geo field computation (for transactions/batch writes)
 */

import type {
  DynamoClient,
  DynamoClientError,
  KeyComposer,
  Table,
  ValidationError,
} from "@effect-dynamodb/core"
import type { Effect, Schema } from "effect"
import * as _GeoSearch from "./GeoSearch.js"
import * as H3 from "./H3.js"
import type { LatLng } from "./Spherical.js"

export type { LatLng } from "./Spherical.js"

export type TimeBucket = "hourly"
export type SortOrder = "ASC" | "DESC"

const BUCKET_MS: Record<TimeBucket, number> = {
  hourly: H3.HOURLY_BUCKET_MS,
}

export interface GeoFields {
  readonly cell: { readonly field: string; readonly resolution: number }
  readonly parentCell: { readonly field: string; readonly resolution: number }
  readonly timePartition: {
    readonly field: string
    readonly source: string
    readonly bucket: TimeBucket
  }
}

export interface Coordinates {
  readonly latitude: number
  readonly longitude: number
}

export interface NearbyOptions {
  readonly center: LatLng
  readonly radius: number
  readonly unit?: H3.GeoUnit | undefined
  readonly timeWindow?: { readonly start: number; readonly end: number } | undefined
  readonly sort?: SortOrder | undefined
  readonly pkFilter?: Record<string, unknown> | undefined
}

export interface NearbyResult<A> {
  readonly item: A
  readonly distance: number
}

/** Structural type for the entity properties GeoIndex needs */
export interface GeoEntity<A, P> {
  readonly table: Table.Table
  readonly entityType: string
  readonly indexes: Record<string, KeyComposer.IndexDefinition>
  readonly schemas: { readonly recordSchema: Schema.Codec<any> }
  readonly put: (input: A) => P
}

export interface GeoIndex<A, P> {
  /** Write an item with automatic geo field enrichment. */
  readonly put: (input: A) => P
  /** Search for items near a geographic point within a given radius. */
  readonly nearby: (
    options: NearbyOptions,
  ) => Effect.Effect<
    Array<NearbyResult<A>>,
    DynamoClientError | ValidationError,
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
export const make = <A, P>(config: {
  readonly entity: GeoEntity<A, P>
  readonly index: string
  readonly coordinates: (item: A) => Coordinates | undefined
  readonly fields: GeoFields
}): GeoIndex<A, P> => {
  const indexDef = config.entity.indexes[config.index] as KeyComposer.IndexDefinition | undefined
  if (!indexDef) {
    throw new Error(`GeoIndex: index "${config.index}" not found on entity`)
  }
  const bucketMs = BUCKET_MS[config.fields.timePartition.bucket]

  const enrich = (input: A): A => {
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

  const searchConfig: _GeoSearch.SearchConfig<A> = {
    entity: config.entity,
    indexDef,
    coordinates: config.coordinates,
    fields: config.fields,
    bucketMs,
  }

  return {
    put: (input: A) => config.entity.put(enrich(input)),
    nearby: (options: NearbyOptions) => _GeoSearch.nearby(searchConfig, options),
    enrich,
  }
}
