import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { describe, expect, it } from "@effect/vitest"
import { decimalValue, sameAttributeValue } from "../src/internal/StoredValueEquality.js"

const n = (N: string): AttributeValue => ({ N })

describe("a stored number compares as the exact decimal it is", () => {
  it("spellings of one value are one value", () => {
    for (const [a, b] of [
      ["0.1", "0.100"],
      ["0.1", ".1"],
      ["1", "1.0"],
      ["1", "+1"],
      ["100", "1e2"],
      ["100", "1E+2"],
      ["0.001", "1e-3"],
      ["00012.3400", "12.34"],
      ["0", "-0"],
      ["0", "0.000"],
      ["-1.50", "-1.5"],
    ] as const) {
      expect([a, b, sameAttributeValue(n(a), n(b))]).toEqual([a, b, true])
    }
  })

  it("values one JavaScript number can't tell apart are two values", () => {
    expect(Number("0.10000000000000001")).toBe(0.1)
    for (const [a, b] of [
      ["0.1", "0.10000000000000001"],
      ["0.1", "0.10000000000000002"],
      ["9007199254740993", "9007199254740992"],
      ["12345678901234567890123456789012345678", "12345678901234567890123456789012345679"],
      ["1", "-1"],
      ["10", "1"],
      ["0.1", "0.01"],
    ] as const) {
      expect([a, b, sameAttributeValue(n(a), n(b))]).toEqual([a, b, false])
    }
  })

  it("a value's one spelling: sign, digits without leading or trailing zeros, exponent", () => {
    expect(decimalValue("0.100")).toBe("1e-1")
    expect(decimalValue("1200")).toBe("12e2")
    expect(decimalValue("-0.0")).toBe("0")
    expect(decimalValue("1.5e3")).toBe("15e2")
    expect(decimalValue("abc")).toBeUndefined()
    expect(decimalValue("")).toBeUndefined()
  })

  it("a number set holds the same values, in any order and spelling", () => {
    expect(sameAttributeValue({ NS: ["1", "0.10"] }, { NS: ["0.1", "1.0"] })).toBe(true)
    expect(sameAttributeValue({ NS: ["1", "0.1"] }, { NS: ["1", "0.10000000000000001"] })).toBe(
      false,
    )
    expect(sameAttributeValue({ NS: ["1"] }, { NS: ["1", "2"] })).toBe(false)
  })
})

describe("every other attribute value compares as stored", () => {
  it("one type only equals the same type", () => {
    expect(sameAttributeValue({ S: "1" }, { N: "1" })).toBe(false)
    expect(sameAttributeValue({ N: "1" }, { S: "1" })).toBe(false)
    expect(sameAttributeValue({ SS: ["a"] }, { L: [{ S: "a" }] })).toBe(false)
    expect(sameAttributeValue({ M: {} }, { L: [] })).toBe(false)
    expect(sameAttributeValue({ BOOL: false }, { NULL: true })).toBe(false)
  })

  it("strings, bytes, booleans and nulls", () => {
    expect(sameAttributeValue({ S: "a" }, { S: "a" })).toBe(true)
    expect(sameAttributeValue({ S: "a" }, { S: "A" })).toBe(false)
    expect(sameAttributeValue({ B: new Uint8Array([1, 2]) }, { B: new Uint8Array([1, 2]) })).toBe(
      true,
    )
    expect(sameAttributeValue({ B: new Uint8Array([1, 2]) }, { B: new Uint8Array([2, 1]) })).toBe(
      false,
    )
    expect(sameAttributeValue({ BOOL: true }, { BOOL: true })).toBe(true)
    expect(sameAttributeValue({ BOOL: true }, { BOOL: false })).toBe(false)
    expect(sameAttributeValue({ NULL: true }, { NULL: true })).toBe(true)
  })

  it("sets are unordered; lists are ordered", () => {
    expect(sameAttributeValue({ SS: ["a", "b"] }, { SS: ["b", "a"] })).toBe(true)
    expect(
      sameAttributeValue(
        { BS: [new Uint8Array([1]), new Uint8Array([2])] },
        { BS: [new Uint8Array([2]), new Uint8Array([1])] },
      ),
    ).toBe(true)
    expect(sameAttributeValue({ L: [n("1"), n("2")] }, { L: [n("1.0"), n("2")] })).toBe(true)
    expect(sameAttributeValue({ L: [n("1"), n("2")] }, { L: [n("2"), n("1")] })).toBe(false)
    expect(sameAttributeValue({ L: [n("1")] }, { L: [n("1"), n("1")] })).toBe(false)
  })

  it("maps compare by name, numbers inside them exactly", () => {
    expect(
      sameAttributeValue(
        { M: { a: n("0.1"), b: { S: "x" } } },
        { M: { b: { S: "x" }, a: n("0.10") } },
      ),
    ).toBe(true)
    expect(sameAttributeValue({ M: { a: n("0.1") } }, { M: { a: n("0.10000000000000001") } })).toBe(
      false,
    )
    expect(sameAttributeValue({ M: { a: n("1") } }, { M: { a: n("1"), b: n("1") } })).toBe(false)
    expect(sameAttributeValue({ M: { a: n("1") } }, { M: { b: n("1") } })).toBe(false)
  })

  it("an absent value only equals an absent one", () => {
    expect(sameAttributeValue(undefined, undefined)).toBe(true)
    expect(sameAttributeValue(undefined, { S: "" })).toBe(false)
    expect(sameAttributeValue({ NULL: true }, undefined)).toBe(false)
  })
})
