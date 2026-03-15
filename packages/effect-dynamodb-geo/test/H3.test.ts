import * as h3 from "h3-js"
import { describe, expect, it } from "vitest"
import * as H3 from "../src/H3.js"

// San Francisco coordinates
const SF_LAT = 37.7749
const SF_LNG = -122.4194

describe("H3", () => {
  describe("computeCell / computeParentCell", () => {
    it("returns a valid H3 cell at resolution 15", () => {
      const cell = H3.computeCell(SF_LAT, SF_LNG, 15)
      expect(h3.isValidCell(cell)).toBe(true)
      expect(h3.getResolution(cell)).toBe(15)
    })

    it("returns a valid parent cell at resolution 3", () => {
      const cell = H3.computeCell(SF_LAT, SF_LNG, 15)
      const parent = H3.computeParentCell(cell, 3)
      expect(h3.isValidCell(parent)).toBe(true)
      expect(h3.getResolution(parent)).toBe(3)
    })

    it("child is contained within parent", () => {
      const cell = H3.computeCell(SF_LAT, SF_LNG, 15)
      const parent = H3.computeParentCell(cell, 3)
      // The parent of the cell at res 3 should equal the parent we computed
      expect(h3.cellToParent(cell, 3)).toBe(parent)
    })
  })

  describe("optimalResolution", () => {
    it("small radius (100m) returns high resolution", () => {
      const res = H3.optimalResolution(SF_LAT, SF_LNG, 100)
      expect(res).toBeGreaterThanOrEqual(7)
    })

    it("large radius (50km) returns low resolution", () => {
      const res = H3.optimalResolution(SF_LAT, SF_LNG, 50000)
      expect(res).toBeLessThanOrEqual(3)
    })

    it("medium radius (1km) returns medium resolution", () => {
      const res = H3.optimalResolution(SF_LAT, SF_LNG, 1000)
      expect(res).toBeGreaterThanOrEqual(4)
      expect(res).toBeLessThanOrEqual(8)
    })
  })

  describe("optimalK", () => {
    it("radius smaller than cell edge returns k >= 1", () => {
      const cell = H3.computeCell(SF_LAT, SF_LNG, 5)
      const k = H3.optimalK(cell, 10, "m")
      expect(k).toBeGreaterThanOrEqual(1)
    })

    it("radius much larger than cell edge returns k > 1", () => {
      const cell = H3.computeCell(SF_LAT, SF_LNG, 7)
      const edgeLen = h3.getHexagonEdgeLengthAvg(7, h3.UNITS.m)
      const k = H3.optimalK(cell, edgeLen * 5, "m")
      expect(k).toBeGreaterThan(1)
    })
  })

  describe("pruneCells", () => {
    it("first ring (center) is always kept", () => {
      const cell = H3.computeCell(SF_LAT, SF_LNG, 7)
      const rings = h3.gridDiskDistances(cell, 2)
      const pruned = H3.pruneCells(SF_LAT, SF_LNG, 1000, rings)
      expect(pruned[0]).toEqual(rings[0])
    })

    it("removes cells beyond radius", () => {
      const cell = H3.computeCell(SF_LAT, SF_LNG, 5)
      const rings = h3.gridDiskDistances(cell, 3)
      const totalCellsBefore = rings.flat().length
      // Very small radius should prune outer rings
      const pruned = H3.pruneCells(SF_LAT, SF_LNG, 100, rings)
      const totalCellsAfter = pruned.flat().length
      expect(totalCellsAfter).toBeLessThanOrEqual(totalCellsBefore)
    })

    it("keeps cells within radius", () => {
      const cell = H3.computeCell(SF_LAT, SF_LNG, 7)
      const rings = h3.gridDiskDistances(cell, 2)
      // Large radius keeps most cells
      const pruned = H3.pruneCells(SF_LAT, SF_LNG, 100000, rings)
      expect(pruned.flat().length).toBe(rings.flat().length)
    })

    it("handles empty input", () => {
      const pruned = H3.pruneCells(SF_LAT, SF_LNG, 1000, [])
      expect(pruned).toEqual([])
    })
  })

  describe("sequentialChunk", () => {
    it("groups contiguous cells", () => {
      const cell = H3.computeCell(SF_LAT, SF_LNG, 7)
      const rings = h3.gridDiskDistances(cell, 1)
      const allCells = rings.flat()
      const chunks = H3.sequentialChunk(allCells)
      // All cells should be accounted for
      const totalCells = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
      expect(totalCells).toBe(allCells.length)
    })

    it("non-contiguous cells start new chunks", () => {
      // Take cells from widely separated locations
      const cell1 = H3.computeCell(SF_LAT, SF_LNG, 7)
      const cell2 = H3.computeCell(0, 0, 7)
      const chunks = H3.sequentialChunk([cell1, cell2])
      expect(chunks.length).toBe(2)
    })

    it("handles empty input", () => {
      const chunks = H3.sequentialChunk([])
      expect(chunks).toEqual([])
    })

    it("single cell produces single chunk", () => {
      const cell = H3.computeCell(SF_LAT, SF_LNG, 7)
      const chunks = H3.sequentialChunk([cell])
      expect(chunks).toEqual([[cell]])
    })
  })

  describe("computeTimePartition", () => {
    it("computes hourly partition from timestamp", () => {
      const timestamp = 1700000000000 // some known timestamp
      const partition = H3.computeTimePartition(timestamp, H3.HOURLY_BUCKET_MS)
      const expected = String(Math.floor(timestamp / (1000 * 60 * 60)))
      expect(partition).toBe(expected)
    })

    it("same hour produces same partition", () => {
      const base = 1700000000000
      const p1 = H3.computeTimePartition(base, H3.HOURLY_BUCKET_MS)
      const p2 = H3.computeTimePartition(base + 1000, H3.HOURLY_BUCKET_MS)
      expect(p1).toBe(p2)
    })

    it("different hours produce different partitions", () => {
      const base = 1700000000000
      const p1 = H3.computeTimePartition(base, H3.HOURLY_BUCKET_MS)
      const p2 = H3.computeTimePartition(base + H3.HOURLY_BUCKET_MS, H3.HOURLY_BUCKET_MS)
      expect(p1).not.toBe(p2)
    })
  })

  describe("getTimePartitions", () => {
    it("single hour returns 1 partition", () => {
      const now = Date.now()
      const partitions = H3.getTimePartitions(now, now, H3.HOURLY_BUCKET_MS)
      expect(partitions.length).toBe(1)
    })

    it("3-hour window returns 3-4 partitions", () => {
      const now = Date.now()
      const threeHoursAgo = now - 3 * H3.HOURLY_BUCKET_MS
      const partitions = H3.getTimePartitions(threeHoursAgo, now, H3.HOURLY_BUCKET_MS)
      expect(partitions.length).toBeGreaterThanOrEqual(3)
      expect(partitions.length).toBeLessThanOrEqual(4)
    })

    it("partitions are unique", () => {
      const now = Date.now()
      const twoHoursAgo = now - 2 * H3.HOURLY_BUCKET_MS
      const partitions = H3.getTimePartitions(twoHoursAgo, now, H3.HOURLY_BUCKET_MS)
      const unique = new Set(partitions)
      expect(unique.size).toBe(partitions.length)
    })
  })

  describe("cellToCenterChild / cellToUpperBound", () => {
    it("center child is at resolution 15", () => {
      const cell = H3.computeCell(SF_LAT, SF_LNG, 7)
      const child = H3.cellToCenterChild(cell, 15)
      expect(h3.isValidCell(child)).toBe(true)
      expect(h3.getResolution(child)).toBe(15)
    })

    it("upper bound string has correct resolution digit", () => {
      const cell = H3.computeCell(SF_LAT, SF_LNG, 7)
      const upper = H3.cellToUpperBound(cell, 15)
      // Resolution 15 = 0xf, so second character should be 'f'
      expect(upper[1]).toBe("f")
    })
  })
})
