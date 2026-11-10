/**
 * `attributeValueEquals`: structural equality of marshalled attribute values. The marshaller stores
 * a binary value in the form it is given, so every form compares by its bytes: two `ArrayBuffer`s
 * or `DataView`s holding different bytes compared equal, and one holding a row's bytes compared
 * unequal to the `Uint8Array` DynamoDB returned.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { describe, expect, it } from "vitest"
import { attributeValueEquals } from "../src/internal/AttributeValueEquals.js"
import { toAttributeValue } from "../src/Marshaller.js"

const B = (binary: unknown): AttributeValue => ({ B: binary }) as never
const BS = (...binaries: ReadonlyArray<unknown>): AttributeValue => ({ BS: binaries }) as never

/** The same bytes in every form the marshaller takes that holds them in memory. */
const forms = (bytes: ReadonlyArray<number>): ReadonlyArray<readonly [string, unknown]> => {
  const padded = new Uint8Array([9, ...bytes, 9])
  return [
    ["Uint8Array", new Uint8Array(bytes)],
    ["a Uint8Array over part of a buffer", new Uint8Array(padded.buffer, 1, bytes.length)],
    ["ArrayBuffer", new Uint8Array(bytes).buffer],
    ["DataView", new DataView(new Uint8Array(bytes).buffer)],
    ["a DataView over part of a buffer", new DataView(padded.buffer, 1, bytes.length)],
    ["Uint8ClampedArray", new Uint8ClampedArray(bytes)],
    ["Int8Array", new Int8Array(bytes)],
    ["Buffer", Buffer.from(bytes)],
  ]
}

describe("attributeValueEquals on binary values", () => {
  for (const [a, x] of forms([2, 3])) {
    for (const [b, y] of forms([2, 3])) {
      it(`${a} and ${b} holding the same bytes are equal`, () => {
        expect(attributeValueEquals(B(x), B(y))).toBe(true)
        expect(attributeValueEquals(BS(x), BS(y))).toBe(true)
      })
    }
    for (const [b, y] of forms([2, 4])) {
      it(`${a} and ${b} holding different bytes are not`, () => {
        expect(attributeValueEquals(B(x), B(y))).toBe(false)
        expect(attributeValueEquals(BS(x), BS(y))).toBe(false)
      })
    }
    it(`${a}: empty and not empty differ, and a longer value differs from its start`, () => {
      const [, empty] = forms([]).find(([name]) => name === a)!
      const [, longer] = forms([2, 3, 0]).find(([name]) => name === a)!
      expect(attributeValueEquals(B(x), B(empty))).toBe(false)
      expect(attributeValueEquals(B(x), B(longer))).toBe(false)
      expect(attributeValueEquals(B(empty), B(new Uint8Array(0)))).toBe(true)
    })
    it(`${a} is marshalled as a binary value`, () => {
      expect(Object.keys(toAttributeValue(x))).toEqual(["B"])
    })
  }

  it("a wider typed array compares by the bytes in its buffer", () => {
    const wide = new Uint16Array([0x0302])
    expect(attributeValueEquals(B(wide), B(new Uint8Array(wide.buffer)))).toBe(true)
    expect(attributeValueEquals(B(wide), B(new Uint16Array([0x0303])))).toBe(false)
  })

  it("a binary set compares as a set, whatever each member's form", () => {
    const [two, three, four] = [[2], [3], [4]].map((bytes) => new Uint8Array(bytes))
    expect(attributeValueEquals(BS(two, three!.buffer), BS(new DataView(three!.buffer), two))).toBe(
      true,
    )
    expect(attributeValueEquals(BS(two, three), BS(two, four))).toBe(false)
    expect(attributeValueEquals(BS(two, three), BS(two))).toBe(false)
    expect(
      attributeValueEquals(BS(two!.buffer, three!.buffer), BS(two!.buffer, four!.buffer)),
    ).toBe(false)
  })

  it("a value whose bytes can't be read here equals only itself", () => {
    const blob = new Blob([new Uint8Array([2])])
    expect(attributeValueEquals(B(blob), B(blob))).toBe(true)
    expect(attributeValueEquals(B(blob), B(new Blob([new Uint8Array([2])])))).toBe(false)
    expect(attributeValueEquals(B(blob), B(new Uint8Array([2])))).toBe(false)
  })
})

describe("attributeValueEquals on the other kinds", () => {
  it("scalars, lists, maps and sets", () => {
    expect(attributeValueEquals({ S: "a" }, { S: "a" })).toBe(true)
    expect(attributeValueEquals({ S: "1" }, { N: "1" })).toBe(false)
    expect(attributeValueEquals({ L: [{ N: "1" }] }, { L: [{ N: "1" }] })).toBe(true)
    expect(attributeValueEquals({ L: [{ N: "1" }] }, { L: [{ N: "2" }] })).toBe(false)
    expect(attributeValueEquals({ M: { a: { N: "1" } } }, { M: { a: { N: "1" } } })).toBe(true)
    expect(attributeValueEquals({ M: { a: { N: "1" } } }, { M: { b: { N: "1" } } })).toBe(false)
    expect(attributeValueEquals({ SS: ["a", "b"] }, { SS: ["b", "a"] })).toBe(true)
    expect(attributeValueEquals({ NS: ["1"] }, { NS: ["1", "2"] })).toBe(false)
    expect(attributeValueEquals(undefined, undefined)).toBe(true)
    expect(attributeValueEquals({ S: "a" }, undefined)).toBe(false)
  })
})

describe("attributeValueEquals on numbers", () => {
  // DynamoDB stores a number once, normalised: the text it was sent in doesn't tell two apart.
  for (const [a, b] of [
    ["2", "2.0"],
    ["2", "0.2e1"],
    ["2", "+2"],
    ["0", "-0"],
    ["0", "0.000"],
    ["100", "1e2"],
    ["0.5", ".5"],
    ["-1.50", "-15E-1"],
    ["123456789012345678901234567890.1", "123456789012345678901234567890.10"],
  ] as const) {
    it(`${a} and ${b} are the same number`, () => {
      expect(attributeValueEquals({ N: a }, { N: b })).toBe(true)
      expect(attributeValueEquals({ NS: [a, "7"] }, { NS: ["7.0", b] })).toBe(true)
    })
  }
  for (const [a, b] of [
    ["2", "2.1"],
    ["2", "-2"],
    ["1e2", "1e3"],
    ["0", "0.1"],
    ["123456789012345678901234567890.1", "123456789012345678901234567890.2"],
  ] as const) {
    it(`${a} and ${b} are not`, () => {
      expect(attributeValueEquals({ N: a }, { N: b })).toBe(false)
      expect(attributeValueEquals({ NS: [a] }, { NS: [b] })).toBe(false)
    })
  }
  it("a number and text of the same digits differ", () => {
    expect(attributeValueEquals({ N: "2" }, { S: "2" })).toBe(false)
    expect(attributeValueEquals({ SS: ["2"] }, { SS: ["2.0"] })).toBe(false)
  })
})
