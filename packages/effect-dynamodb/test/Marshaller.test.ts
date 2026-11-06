import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  fromAttributeMap,
  fromAttributeValue,
  hasNoStoredForm,
  isEmptySet,
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

describe("values with no stored form", () => {
  it("an empty set is an absent attribute, in a map at any depth", () => {
    expect(
      toAttributeMap({
        id: "1",
        tags: new Set(),
        nested: { tags: new Set(), inner: { tags: new Set(), n: 1 } },
        list: [{ tags: new Set(), n: 2 }],
      }),
    ).toEqual({
      id: { S: "1" },
      nested: { M: { inner: { M: { n: { N: "1" } } } } },
      list: { L: [{ M: { n: { N: "2" } } }] },
    })
  })

  it("so is one in a class instance, and in a Map", () => {
    class Holder {
      constructor(
        readonly tags: ReadonlySet<string>,
        readonly n: number,
      ) {}
    }
    expect(toAttributeMap({ holder: new Holder(new Set(), 1) })).toEqual({
      holder: { M: { n: { N: "1" } } },
    })
    expect(
      toAttributeMap({
        byName: new Map<string, unknown>([
          ["a", new Set()],
          ["b", { tags: new Set(), n: 1 }],
          ["c", 2],
        ]),
      }),
    ).toEqual({
      byName: { M: { b: { M: { n: { N: "1" } } }, c: { N: "2" } } },
    })
  })

  it("a Set of nothing but undefined has no stored form either", () => {
    expect(toAttributeMap({ id: "1", tags: new Set([undefined]) })).toEqual({ id: { S: "1" } })
    expect(isEmptySet(new Set([undefined]))).toBe(true)
    expect(isEmptySet(new Set(["a"]))).toBe(false)
    expect(isEmptySet([])).toBe(false)
    expect(hasNoStoredForm(undefined)).toBe(true)
    expect(hasNoStoredForm(null)).toBe(false)
  })

  it("everything else in the item is stored exactly as it would be", () => {
    const rest = {
      id: "1",
      set: new Set(["a"]),
      numbers: new Set([1, 2]),
      bytes: new Uint8Array([1, 2]),
      at: { nested: [1, "x", null, { y: true }] },
      nothing: null,
      gone: undefined,
    }
    expect(toAttributeMap({ ...rest, empty: new Set() })).toEqual(toAttributeMap(rest))
    expect(toAttributeMap(rest).set).toEqual({ SS: ["a"] })
    expect(toAttributeMap(rest).bytes).toEqual({ B: new Uint8Array([1, 2]) })
  })

  it("a list can't leave one out, so marshalling still refuses it", () => {
    expect(() => toAttributeMap({ list: [new Set(["a"]), new Set()] })).toThrow(/non-empty set/)
  })

  it("a failure that isn't an empty set is the failure it always was", () => {
    expect(() => toAttributeMap({ n: Number.NaN })).toThrow(/NaN/)
  })

  it("a value on its own has no attribute to leave out, so it's refused", () => {
    expect(() => toAttributeValue(new Set())).toThrow(/non-empty set/)
    expect(toAttributeValue({ tags: new Set(), n: 1 })).toEqual({ M: { n: { N: "1" } } })
    expect(toAttributeValue(new Set(["a"]))).toEqual({ SS: ["a"] })
  })
})

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
