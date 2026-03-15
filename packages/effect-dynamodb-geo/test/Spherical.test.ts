import { describe, expect, it } from "vitest"
import * as Spherical from "../src/Spherical.js"

describe("Spherical", () => {
  describe("initialBearing", () => {
    it("London to Paris ≈ 156°", () => {
      const london: Spherical.LatLng = { latitude: 51.5074, longitude: -0.1278 }
      const paris: Spherical.LatLng = { latitude: 48.8566, longitude: 2.3522 }
      const bearing = Spherical.initialBearing(london, paris)
      expect(bearing).toBeGreaterThan(148)
      expect(bearing).toBeLessThan(160)
    })

    it("NYC to LA ≈ 273°", () => {
      const nyc: Spherical.LatLng = { latitude: 40.7128, longitude: -74.006 }
      const la: Spherical.LatLng = { latitude: 34.0522, longitude: -118.2437 }
      const bearing = Spherical.initialBearing(nyc, la)
      expect(bearing).toBeGreaterThan(270)
      expect(bearing).toBeLessThan(280)
    })

    it("same point returns 0", () => {
      const point: Spherical.LatLng = { latitude: 37.7749, longitude: -122.4194 }
      const bearing = Spherical.initialBearing(point, point)
      expect(bearing).toBe(0)
    })

    it("due north returns 0", () => {
      const from: Spherical.LatLng = { latitude: 0, longitude: 0 }
      const to: Spherical.LatLng = { latitude: 10, longitude: 0 }
      const bearing = Spherical.initialBearing(from, to)
      expect(bearing).toBeCloseTo(0, 5)
    })

    it("due east returns 90", () => {
      const from: Spherical.LatLng = { latitude: 0, longitude: 0 }
      const to: Spherical.LatLng = { latitude: 0, longitude: 10 }
      const bearing = Spherical.initialBearing(from, to)
      expect(bearing).toBeCloseTo(90, 5)
    })

    it("due south returns 180", () => {
      const from: Spherical.LatLng = { latitude: 10, longitude: 0 }
      const to: Spherical.LatLng = { latitude: 0, longitude: 0 }
      const bearing = Spherical.initialBearing(from, to)
      expect(bearing).toBeCloseTo(180, 5)
    })

    it("due west returns 270", () => {
      const from: Spherical.LatLng = { latitude: 0, longitude: 10 }
      const to: Spherical.LatLng = { latitude: 0, longitude: 0 }
      const bearing = Spherical.initialBearing(from, to)
      expect(bearing).toBeCloseTo(270, 5)
    })
  })

  describe("intersection", () => {
    it("finds intersection of two known paths", () => {
      // Path 1: from equator/prime meridian heading NE (45°)
      // Path 2: from equator/10°E heading NW (315°)
      const p1: Spherical.LatLng = { latitude: 0, longitude: 0 }
      const p2: Spherical.LatLng = { latitude: 0, longitude: 10 }
      const result = Spherical.intersection(p1, 45, p2, 315)
      expect(result).toBeDefined()
      // Intersection should be north of equator and between 0° and 10° longitude
      expect(result!.latitude).toBeGreaterThan(0)
      expect(result!.longitude).toBeGreaterThan(0)
      expect(result!.longitude).toBeLessThan(10)
    })

    it("northbound paths from different longitudes converge at pole", () => {
      const p1: Spherical.LatLng = { latitude: 0, longitude: 0 }
      const p2: Spherical.LatLng = { latitude: 0, longitude: 10 }
      // Both heading north — converge at the North Pole on a sphere
      const result = Spherical.intersection(p1, 0, p2, 0)
      expect(result).toBeDefined()
      expect(result!.latitude).toBeCloseTo(90, 0)
    })

    it("returns undefined for same point", () => {
      const p: Spherical.LatLng = { latitude: 0, longitude: 0 }
      const result = Spherical.intersection(p, 45, p, 135)
      expect(result).toBeUndefined()
    })
  })

  describe("greatCircleDistance", () => {
    it("returns 0 for same point", () => {
      const point: Spherical.LatLng = { latitude: 37.7749, longitude: -122.4194 }
      expect(Spherical.greatCircleDistance(point, point)).toBeCloseTo(0, 3)
    })

    it("London to Paris ≈ 344 km", () => {
      const london: Spherical.LatLng = { latitude: 51.5074, longitude: -0.1278 }
      const paris: Spherical.LatLng = { latitude: 48.8566, longitude: 2.3522 }
      const distance = Spherical.greatCircleDistance(london, paris)
      expect(distance / 1000).toBeGreaterThan(340)
      expect(distance / 1000).toBeLessThan(350)
    })

    it("equator, 1° longitude ≈ 111 km", () => {
      const a: Spherical.LatLng = { latitude: 0, longitude: 0 }
      const b: Spherical.LatLng = { latitude: 0, longitude: 1 }
      const distance = Spherical.greatCircleDistance(a, b)
      expect(distance / 1000).toBeGreaterThan(110)
      expect(distance / 1000).toBeLessThan(112)
    })
  })
})
