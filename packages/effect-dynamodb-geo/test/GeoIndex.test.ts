import * as h3 from "h3-js"
import { describe, expect, it } from "vitest"
import * as GeoIndex from "../src/GeoIndex.js"

// Mock entity with minimal structural interface matching GeoEntity
const mockEntity: GeoIndex.GeoEntity<any, any> = {
  table: {
    schema: { name: "test", version: 1, casing: "lowercase" as const },
    Tag: {} as any,
    layer: {} as any,
    layerConfig: {} as any,
  },
  entityType: "Vehicle",
  indexes: {
    primary: {
      pk: { field: "pk", composite: ["vehicleId"] },
      sk: { field: "sk", composite: [] },
    },
    byCell: {
      index: "gsi1",
      pk: { field: "gsi1pk", composite: ["parentCell", "timePartition"] },
      sk: { field: "gsi1sk", composite: ["cell"] },
    },
  },
  schemas: { recordSchema: {} as any },
  put: () => undefined as any,
}

interface VehicleInput {
  vehicleId: string
  location?: { latitude: number; longitude: number } | undefined
  timestamp: number
  cell?: string | undefined
  parentCell?: string | undefined
  timePartition?: string | undefined
}

const SF_LAT = 37.7749
const SF_LNG = -122.4194

describe("GeoIndex", () => {
  describe("make", () => {
    it("creates a GeoIndex from entity and config", () => {
      const geoIndex = GeoIndex.make<VehicleInput, any>({
        entity: mockEntity,
        index: "byCell",
        coordinates: (item) =>
          item.location
            ? { latitude: item.location.latitude, longitude: item.location.longitude }
            : undefined,
        fields: {
          cell: { field: "cell", resolution: 15 },
          parentCell: { field: "parentCell", resolution: 3 },
          timePartition: { field: "timePartition", source: "timestamp", bucket: "hourly" },
        },
      })

      expect(typeof geoIndex.put).toBe("function")
      expect(typeof geoIndex.nearby).toBe("function")
      expect(typeof geoIndex.enrich).toBe("function")
    })

    it("throws if index not found on entity", () => {
      expect(() =>
        GeoIndex.make<VehicleInput, any>({
          entity: mockEntity,
          index: "nonexistent",
          coordinates: () => undefined,
          fields: {
            cell: { field: "cell", resolution: 15 },
            parentCell: { field: "parentCell", resolution: 3 },
            timePartition: { field: "timePartition", source: "timestamp", bucket: "hourly" },
          },
        }),
      ).toThrow('index "nonexistent" not found')
    })
  })

  describe("enrich", () => {
    const geoIndex = GeoIndex.make<VehicleInput, any>({
      entity: mockEntity,
      index: "byCell",
      coordinates: (item) =>
        item.location
          ? { latitude: item.location.latitude, longitude: item.location.longitude }
          : undefined,
      fields: {
        cell: { field: "cell", resolution: 15 },
        parentCell: { field: "parentCell", resolution: 3 },
        timePartition: { field: "timePartition", source: "timestamp", bucket: "hourly" },
      },
    })

    it("enriches with cell, parentCell, and timePartition", () => {
      const timestamp = 1700000000000
      const input: VehicleInput = {
        vehicleId: "v-1",
        location: { latitude: SF_LAT, longitude: SF_LNG },
        timestamp,
      }

      const enriched = geoIndex.enrich(input)

      expect(enriched.cell).toBeDefined()
      expect(enriched.parentCell).toBeDefined()
      expect(enriched.timePartition).toBeDefined()

      // Verify cell is valid H3 at resolution 15
      expect(h3.isValidCell(enriched.cell!)).toBe(true)
      expect(h3.getResolution(enriched.cell!)).toBe(15)

      // Verify parentCell is valid H3 at resolution 3
      expect(h3.isValidCell(enriched.parentCell!)).toBe(true)
      expect(h3.getResolution(enriched.parentCell!)).toBe(3)

      // Verify timePartition matches manual computation
      const expectedPartition = String(Math.floor(timestamp / (1000 * 60 * 60)))
      expect(enriched.timePartition).toBe(expectedPartition)
    })

    it("preserves all original input fields", () => {
      const input: VehicleInput = {
        vehicleId: "v-1",
        location: { latitude: SF_LAT, longitude: SF_LNG },
        timestamp: 1700000000000,
      }

      const enriched = geoIndex.enrich(input)

      expect(enriched.vehicleId).toBe("v-1")
      expect(enriched.location).toEqual({ latitude: SF_LAT, longitude: SF_LNG })
      expect(enriched.timestamp).toBe(1700000000000)
    })

    it("returns input unchanged when coordinates are undefined", () => {
      const input: VehicleInput = {
        vehicleId: "v-2",
        timestamp: 1700000000000,
      }

      const enriched = geoIndex.enrich(input)

      expect(enriched.cell).toBeUndefined()
      expect(enriched.parentCell).toBeUndefined()
      expect(enriched.timePartition).toBeUndefined()
      expect(enriched).toEqual(input)
    })

    it("returns input unchanged when location is explicitly undefined", () => {
      const input: VehicleInput = {
        vehicleId: "v-3",
        location: undefined,
        timestamp: 1700000000000,
      }

      const enriched = geoIndex.enrich(input)
      expect(enriched.cell).toBeUndefined()
    })

    it("cell is child of parentCell", () => {
      const input: VehicleInput = {
        vehicleId: "v-4",
        location: { latitude: SF_LAT, longitude: SF_LNG },
        timestamp: 1700000000000,
      }

      const enriched = geoIndex.enrich(input)
      expect(h3.cellToParent(enriched.cell!, 3)).toBe(enriched.parentCell)
    })
  })
})
