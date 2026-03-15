import { DateTime } from "effect"
import { describe, expect, it } from "vitest"
import type { DynamoEncoding } from "../src/DynamoModel.js"
import {
  deserializeDateFromDynamo,
  fromAttributeMap,
  fromAttributeValue,
  serializeDateForDynamo,
  toAttributeMap,
  toAttributeValue,
} from "../src/Marshaller.js"

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
  })

  // ---------------------------------------------------------------------------
  // serializeDateForDynamo
  // ---------------------------------------------------------------------------

  describe("serializeDateForDynamo", () => {
    const utc = DateTime.makeUnsafe(1704067200000) // 2024-01-01T00:00:00.000Z

    it("serializes DateTime.Utc as ISO string", () => {
      const enc: DynamoEncoding = { storage: "string", domain: "DateTime.Utc" }
      expect(serializeDateForDynamo(utc, enc)).toBe("2024-01-01T00:00:00.000Z")
    })

    it("serializes DateTime.Utc as epochMs", () => {
      const enc: DynamoEncoding = { storage: "epochMs", domain: "DateTime.Utc" }
      expect(serializeDateForDynamo(utc, enc)).toBe(1704067200000)
    })

    it("serializes DateTime.Utc as epochSeconds", () => {
      const enc: DynamoEncoding = { storage: "epochSeconds", domain: "DateTime.Utc" }
      expect(serializeDateForDynamo(utc, enc)).toBe(1704067200)
    })

    it("serializes DateTime.Zoned as zoned ISO string", () => {
      const zoned = DateTime.makeZonedUnsafe(utc, { timeZone: "Asia/Tokyo" })
      const enc: DynamoEncoding = { storage: "string", domain: "DateTime.Zoned" }
      const result = serializeDateForDynamo(zoned, enc)
      expect(result).toContain("Asia/Tokyo")
      expect(result).toContain("+09:00")
    })

    it("serializes native Date as ISO string", () => {
      const d = new Date(1704067200000)
      const enc: DynamoEncoding = { storage: "string", domain: "Date" }
      expect(serializeDateForDynamo(d, enc)).toBe("2024-01-01T00:00:00.000Z")
    })

    it("serializes native Date as epochMs", () => {
      const d = new Date(1704067200000)
      const enc: DynamoEncoding = { storage: "epochMs", domain: "Date" }
      expect(serializeDateForDynamo(d, enc)).toBe(1704067200000)
    })

    it("serializes native Date as epochSeconds", () => {
      const d = new Date(1704067200000)
      const enc: DynamoEncoding = { storage: "epochSeconds", domain: "Date" }
      expect(serializeDateForDynamo(d, enc)).toBe(1704067200)
    })
  })

  // ---------------------------------------------------------------------------
  // deserializeDateFromDynamo
  // ---------------------------------------------------------------------------

  describe("deserializeDateFromDynamo", () => {
    it("deserializes ISO string to DateTime.Utc", () => {
      const enc: DynamoEncoding = { storage: "string", domain: "DateTime.Utc" }
      const result = deserializeDateFromDynamo("2024-01-01T00:00:00.000Z", enc)
      expect(DateTime.isDateTime(result)).toBe(true)
      expect(DateTime.toEpochMillis(result as DateTime.Utc)).toBe(1704067200000)
    })

    it("deserializes epochMs to DateTime.Utc", () => {
      const enc: DynamoEncoding = { storage: "epochMs", domain: "DateTime.Utc" }
      const result = deserializeDateFromDynamo(1704067200000, enc)
      expect(DateTime.isDateTime(result)).toBe(true)
      expect(DateTime.toEpochMillis(result as DateTime.Utc)).toBe(1704067200000)
    })

    it("deserializes epochSeconds to DateTime.Utc", () => {
      const enc: DynamoEncoding = { storage: "epochSeconds", domain: "DateTime.Utc" }
      const result = deserializeDateFromDynamo(1704067200, enc)
      expect(DateTime.isDateTime(result)).toBe(true)
      expect(DateTime.toEpochMillis(result as DateTime.Utc)).toBe(1704067200000)
    })

    it("deserializes zoned ISO string to DateTime.Zoned", () => {
      const enc: DynamoEncoding = { storage: "string", domain: "DateTime.Zoned" }
      const result = deserializeDateFromDynamo("2024-01-01T09:00:00.000+09:00[Asia/Tokyo]", enc)
      expect(DateTime.isZoned(result as DateTime.DateTime)).toBe(true)
    })

    it("deserializes ISO string to native Date", () => {
      const enc: DynamoEncoding = { storage: "string", domain: "Date" }
      const result = deserializeDateFromDynamo("2024-01-01T00:00:00.000Z", enc)
      expect(result).toBeInstanceOf(Date)
      expect((result as Date).getTime()).toBe(1704067200000)
    })

    it("deserializes epochMs to native Date", () => {
      const enc: DynamoEncoding = { storage: "epochMs", domain: "Date" }
      const result = deserializeDateFromDynamo(1704067200000, enc)
      expect(result).toBeInstanceOf(Date)
      expect((result as Date).getTime()).toBe(1704067200000)
    })
  })

  // ---------------------------------------------------------------------------
  // deserializeDateFromDynamo — error paths
  // ---------------------------------------------------------------------------

  describe("deserializeDateFromDynamo error paths", () => {
    it("throws on numeric input for DateTime.Zoned (expects string)", () => {
      const enc: DynamoEncoding = { storage: "string", domain: "DateTime.Zoned" }
      expect(() => deserializeDateFromDynamo(12345, enc)).toThrow(
        "expected string for DateTime.Zoned/string",
      )
    })

    it("throws on string input for DateTime.Utc epochMs encoding", () => {
      const enc: DynamoEncoding = { storage: "epochMs", domain: "DateTime.Utc" }
      expect(() => deserializeDateFromDynamo("not-a-number", enc)).toThrow(
        "expected finite number for DateTime.Utc/epochMs",
      )
    })

    it("throws on NaN input for DateTime.Utc epochMs encoding", () => {
      const enc: DynamoEncoding = { storage: "epochMs", domain: "DateTime.Utc" }
      expect(() => deserializeDateFromDynamo(Number.NaN, enc)).toThrow(
        "expected finite number for DateTime.Utc/epochMs",
      )
    })

    it("throws on Infinity for epochSeconds encoding", () => {
      const enc: DynamoEncoding = { storage: "epochSeconds", domain: "DateTime.Utc" }
      expect(() => deserializeDateFromDynamo(Number.POSITIVE_INFINITY, enc)).toThrow(
        "expected finite number",
      )
    })

    it("throws on numeric input for DateTime.Utc string encoding", () => {
      const enc: DynamoEncoding = { storage: "string", domain: "DateTime.Utc" }
      expect(() => deserializeDateFromDynamo(12345, enc)).toThrow(
        "expected string for DateTime.Utc/string",
      )
    })

    it("throws on numeric input for Date string encoding", () => {
      const enc: DynamoEncoding = { storage: "string", domain: "Date" }
      expect(() => deserializeDateFromDynamo(12345, enc)).toThrow("expected string for Date/string")
    })

    it("throws on invalid Date string", () => {
      const enc: DynamoEncoding = { storage: "string", domain: "Date" }
      expect(() => deserializeDateFromDynamo("not-a-date", enc)).toThrow(
        'invalid Date value "not-a-date"',
      )
    })

    it("throws on string input for Date epochMs encoding", () => {
      const enc: DynamoEncoding = { storage: "epochMs", domain: "Date" }
      expect(() => deserializeDateFromDynamo("not-a-number", enc)).toThrow(
        "expected finite number for Date/epochMs",
      )
    })

    it("throws on null input", () => {
      const enc: DynamoEncoding = { storage: "string", domain: "DateTime.Utc" }
      expect(() => deserializeDateFromDynamo(null, enc)).toThrow("expected string")
    })

    it("throws on undefined input", () => {
      const enc: DynamoEncoding = { storage: "string", domain: "DateTime.Utc" }
      expect(() => deserializeDateFromDynamo(undefined, enc)).toThrow("expected string")
    })
  })

  // ---------------------------------------------------------------------------
  // serializeDateForDynamo — error paths
  // ---------------------------------------------------------------------------

  describe("serializeDateForDynamo error paths", () => {
    it("throws on non-date value", () => {
      const enc: DynamoEncoding = { storage: "string", domain: "DateTime.Utc" }
      expect(() => serializeDateForDynamo("not-a-date", enc)).toThrow(
        "unsupported value type: string",
      )
    })

    it("throws on plain object", () => {
      const enc: DynamoEncoding = { storage: "epochMs", domain: "Date" }
      expect(() => serializeDateForDynamo({}, enc)).toThrow("unsupported value type")
    })
  })
})
