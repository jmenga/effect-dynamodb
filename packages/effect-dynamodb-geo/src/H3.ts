/**
 * H3 — Pure H3 hexagonal grid algorithms for geospatial indexing.
 *
 * Ported from midgard's TelemetryRepository. All functions are pure
 * (no Effect dependencies) and operate on H3 cells and coordinates.
 */

import * as h3 from "h3-js"
import * as Spherical from "./Spherical.js"

export type GeoUnit = "m" | "km"

// Pre-compute average edge lengths for each H3 resolution (0-15)
const AVERAGE_EDGE_LENGTHS: Record<number, number> = Object.fromEntries(
  Array.from({ length: 16 }, (_, i) => [i, h3.getHexagonEdgeLengthAvg(i, h3.UNITS.m)]),
)

const HOUR_MS = 1000 * 60 * 60

/**
 * Find the H3 resolution where hexagon edge length best matches the search radius.
 *
 * Starts with an estimate from average edge lengths, then refines using
 * actual edge lengths at the given location (hexagons vary by latitude).
 */
export const optimalResolution = (latitude: number, longitude: number, radius: number): number => {
  let startResolution = 0
  for (let i = 0; i < 15; i++) {
    const current = AVERAGE_EDGE_LENGTHS[i]
    const next = AVERAGE_EDGE_LENGTHS[i + 1]
    if (current !== undefined && next !== undefined && current > radius && radius >= next) {
      startResolution = i
      break
    }
  }

  for (let i = startResolution; i < 15; i++) {
    const cell1 = h3.latLngToCell(latitude, longitude, i)
    const edges1 = h3.originToDirectedEdges(cell1).map((edge) => h3.edgeLength(edge, h3.UNITS.m))
    const minEdge1 = Math.min(...edges1)

    const cell2 = h3.latLngToCell(latitude, longitude, i + 1)
    const edges2 = h3.originToDirectedEdges(cell2).map((edge) => h3.edgeLength(edge, h3.UNITS.m))
    const minEdge2 = Math.min(...edges2)

    if (minEdge1 > radius && radius >= minEdge2) {
      return i
    }
  }

  return startResolution
}

/**
 * Calculate the number of hexagonal rings (k) needed to cover a given radius
 * from a center cell.
 */
export const optimalK = (cell: string, radius: number, unit: GeoUnit): number => {
  const edges = h3
    .originToDirectedEdges(cell)
    .map((edge) => h3.edgeLength(edge, unit === "km" ? h3.UNITS.km : h3.UNITS.m))
  const minEdgeLength = Math.min(...edges)
  const ratio = radius / minEdgeLength

  const hasLinearRatio = Math.ceil(ratio) % 2 !== 0 || ratio < 1
  return hasLinearRatio
    ? Math.ceil((2 / 3) * ratio + 1 / 3)
    : Math.ceil(1 / 3 + (1 / 3) * Math.sqrt(4 * ratio ** 2 - 3))
}

/**
 * Compute the distance from a point to the edge between two neighboring cells.
 *
 * Uses spherical geometry to find the intersection of the bearing from
 * the target cell center toward the search point with the shared edge boundary.
 */
export const edgeDistance = (
  latitude: number,
  longitude: number,
  sourceCell: string,
  targetCell: string,
): number => {
  const targetCenter = h3.cellToLatLng(targetCell)
  const targetCenterPoint: Spherical.LatLng = {
    latitude: targetCenter[0],
    longitude: targetCenter[1],
  }
  const locationPoint: Spherical.LatLng = { latitude, longitude }

  const targetCenterBearing = Spherical.initialBearing(targetCenterPoint, locationPoint)

  const edge = h3.cellsToDirectedEdge(sourceCell, targetCell)
  const edgeLine = h3.directedEdgeToBoundary(edge)

  const edgePointA = edgeLine[0]
  const edgePointB = edgeLine[1]
  if (!edgePointA || !edgePointB) return Infinity

  const edgeA: Spherical.LatLng = { latitude: edgePointA[0], longitude: edgePointA[1] }
  const edgeB: Spherical.LatLng = { latitude: edgePointB[0], longitude: edgePointB[1] }
  const edgeBearing = Spherical.initialBearing(edgeA, edgeB)

  const intersectionPoint = Spherical.intersection(
    targetCenterPoint,
    targetCenterBearing,
    edgeA,
    edgeBearing,
  )

  if (intersectionPoint === undefined) return Infinity

  return h3.greatCircleDistance(
    [latitude, longitude],
    [intersectionPoint.latitude, intersectionPoint.longitude],
    h3.UNITS.m,
  )
}

/**
 * Remove cells from outer rings that are beyond the search radius.
 *
 * Walks outward ring by ring, checking edge distance from the search center
 * to each cell's shared boundary with its inner-ring neighbor.
 */
export const pruneCells = (
  latitude: number,
  longitude: number,
  radius: number,
  cells: string[][],
): string[][] => {
  const firstRing = cells[0]
  if (!firstRing) return []

  const prunedCells: string[][] = [firstRing]

  for (let i = 0; i < cells.length - 1; i++) {
    const sourceCells = cells[i]
    const targetCells = cells[i + 1]
    if (!sourceCells || !targetCells) continue

    const prunedSet = new Set<string>()
    for (const sourceCell of sourceCells) {
      for (const targetCell of targetCells) {
        if (!prunedSet.has(targetCell) && h3.areNeighborCells(sourceCell, targetCell)) {
          const distance = edgeDistance(latitude, longitude, sourceCell, targetCell)
          if (radius > distance) {
            prunedSet.add(targetCell)
          }
        }
      }
    }
    prunedCells.push(Array.from(prunedSet).sort())
  }

  return prunedCells
}

// Compute the difference between two H3 cell indexes, normalized by resolution
const cellDifference = (a: string, b: string): bigint => {
  return (BigInt(`0x${b}`) - BigInt(`0x${a}`)) >> ((BigInt(15) - BigInt(`0x${b[1]}`)) * BigInt(3))
}

// Extended cell difference accounting for parent cell boundaries
const extendedCellDifference = (a: string, b: string): bigint => {
  return (
    cellDifference(a, b) -
    cellDifference(
      h3.cellToParent(a, h3.getResolution(a) - 1),
      h3.cellToParent(b, h3.getResolution(b) - 1),
    )
  )
}

/**
 * Group sorted H3 cells into chunks of contiguous cells.
 *
 * Contiguous cells (adjacent in the H3 index space) can be queried
 * with a single BETWEEN range query on the sort key.
 */
export const sequentialChunk = (cells: string[]): string[][] => {
  const sorted = [...cells].sort()
  const first = sorted[0]
  if (!first) return []

  const chunks: string[][] = [[first]]

  for (let i = 1; i < sorted.length; i++) {
    const cell = sorted[i]
    if (!cell) continue
    const lastChunk = chunks[chunks.length - 1]
    const lastCell = lastChunk?.[lastChunk.length - 1]
    if (lastCell && extendedCellDifference(lastCell, cell) === BigInt(1)) {
      lastChunk.push(cell)
    } else {
      chunks.push([cell])
    }
  }

  return chunks
}

/**
 * Compute H3 cell at the given resolution for coordinates.
 */
export const computeCell = (latitude: number, longitude: number, resolution: number): string =>
  h3.latLngToCell(latitude, longitude, resolution)

/**
 * Compute parent cell at the given resolution.
 */
export const computeParentCell = (cell: string, resolution: number): string =>
  h3.cellToParent(cell, resolution)

/**
 * Compute the hourly time partition string for a timestamp.
 */
export const computeTimePartition = (timestampMs: number, bucketMs: number): string =>
  String(Math.floor(timestampMs / bucketMs))

/**
 * Generate all time partition strings covering a time window.
 */
export const getTimePartitions = (startMs: number, endMs: number, bucketMs: number): string[] => {
  const partitions = new Set<string>()
  let time = startMs
  while (time <= endMs) {
    partitions.add(computeTimePartition(time, bucketMs))
    time += bucketMs
  }
  partitions.add(computeTimePartition(endMs, bucketMs))
  return Array.from(partitions)
}

/**
 * Compute the precise child cell at resolution 15 for range query lower bounds.
 */
export const cellToCenterChild = (cell: string, resolution: number): string =>
  h3.cellToCenterChild(cell, resolution)

/**
 * Compute upper bound cell string for BETWEEN queries.
 * Adjusts the resolution hex digit to the target resolution.
 */
export const cellToUpperBound = (cell: string, targetResolution: number): string =>
  cell.slice(0, 1) + targetResolution.toString(16) + cell.slice(2)

/**
 * The bucket size in milliseconds for hourly partitions.
 */
export const HOURLY_BUCKET_MS = HOUR_MS
