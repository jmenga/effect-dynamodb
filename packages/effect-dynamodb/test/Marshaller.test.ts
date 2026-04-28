import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  fromAttributeMap,
  fromAttributeValue,
  toAttributeMap,
  toAttributeValue,
} from "../src/Marshaller.js"

class Point extends Schema.Class<Point>("Point")({
  type: Schema.Literal("Point"),
  coordinates: Schema.Array(Schema.Number),
}) {}

class Location extends Schema.Class<Location>("Location")({
  timestamp: Schema.Number,
  geometry: Point,
}) {}

describe("Marshaller", () => {
  describe("toAttributeMap / fromAttributeMap", () => {
    it("round-trips a simple object", () => {
      const obj = { name: "Alice", age: 30, active: true }
      const attrMap = toAttributeMap(obj)
      expect(attrMap).toEqual({
        name: { S: "Alice" },
        age: { N: "30" },
        active: { BOOL: true },
      })
      const result = fromAttributeMap(attrMap)
      expect(result).toEqual(obj)
    })

    it("removes undefined values", () => {
      const obj = { name: "Alice", email: undefined }
      const attrMap = toAttributeMap(obj)
      expect(attrMap).toEqual({ name: { S: "Alice" } })
    })

    it("handles nested objects", () => {
      const obj = { data: { nested: "value" } }
      const attrMap = toAttributeMap(obj)
      const result = fromAttributeMap(attrMap)
      expect(result).toEqual(obj)
    })
  })

  describe("toAttributeValue / fromAttributeValue", () => {
    it("marshalls a string", () => {
      const av = toAttributeValue("hello")
      expect(av).toEqual({ S: "hello" })
      expect(fromAttributeValue(av)).toBe("hello")
    })

    it("marshalls a number", () => {
      const av = toAttributeValue(42)
      expect(av).toEqual({ N: "42" })
      expect(fromAttributeValue(av)).toBe(42)
    })

    // Regression: toAttributeValue previously did not pass
    // convertClassInstanceToMap, so any Schema.Class-valued field marshalled
    // through update/append SET clauses or condition values threw at runtime.
    // See https://github.com/jmenga/effect-dynamodb/issues/12
    it("marshalls a Schema.Class instance as a map", () => {
      const point = new Point({ type: "Point", coordinates: [-87.6298, 41.8781] })
      const av = toAttributeValue(point)
      expect(av).toEqual({
        M: {
          type: { S: "Point" },
          coordinates: { L: [{ N: "-87.6298" }, { N: "41.8781" }] },
        },
      })
    })

    it("marshalls a nested Schema.Class instance as a map", () => {
      const loc = new Location({
        timestamp: 1704067200000,
        geometry: new Point({ type: "Point", coordinates: [-87.6298, 41.8781] }),
      })
      const av = toAttributeValue(loc)
      expect(av).toEqual({
        M: {
          timestamp: { N: "1704067200000" },
          geometry: {
            M: {
              type: { S: "Point" },
              coordinates: { L: [{ N: "-87.6298" }, { N: "41.8781" }] },
            },
          },
        },
      })
    })

    it("produces the same shape as toAttributeMap for the same class instance", () => {
      const loc = new Location({
        timestamp: 1704067200000,
        geometry: new Point({ type: "Point", coordinates: [-87.6298, 41.8781] }),
      })
      const mapped = toAttributeMap({ location: loc })
      const perField = toAttributeValue(loc)
      expect(mapped.location).toEqual(perField)
    })

    it("removes undefined values inside nested objects", () => {
      const av = toAttributeValue({ a: "x", b: undefined })
      expect(av).toEqual({ M: { a: { S: "x" } } })
    })
  })
})
