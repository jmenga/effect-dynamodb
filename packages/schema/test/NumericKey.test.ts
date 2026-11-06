/**
 * Numeric key text (#171 E8): `KeyComposer.serializeValue` encodes numbers and
 * bigints so that DynamoDB's UTF-8 byte order of the key is numeric order,
 * while a non-negative integer below the pad width keeps its 1.36 bytes.
 */
import { describe, expect, it } from "@effect/vitest"
import { Arbitrary, Schema } from "effect"
import * as DynamoSchema from "../src/DynamoSchema.js"
import { compareBytes, utf8 } from "../src/internal/ZOrderCurve.js"
import * as KeyComposer from "../src/KeyComposer.js"

const Int = (minimum: number, maximum: number) =>
  Schema.Int.check(Schema.isBetween({ minimum, maximum }))

const casings = ["lowercase", "uppercase", "preserve"] as const

/** DynamoDB's sort key order: UTF-8 bytes. */
const byteOrder = (a: string, b: string): number => Math.sign(compareBytes(utf8(a), utf8(b)))
const numericOrder = (a: number | bigint, b: number | bigint): number =>
  a < b ? -1 : a > b ? 1 : 0

// -- arbitraries --

/** Every finite double, by raw bit pattern: all exponents, subnormals, both signs. */
const view = new DataView(new ArrayBuffer(8))
const fromBits = (hi: number, lo: number): number => {
  view.setUint32(0, hi)
  view.setUint32(4, lo)
  return view.getFloat64(0)
}
const U32 = Arbitrary.schema(Int(0, 0xffffffff))
const anyDouble = Arbitrary.all([U32, U32]).pipe(
  Arbitrary.map(([hi, lo]) => fromBits(hi, lo)),
  Arbitrary.filter((x) => Number.isFinite(x)),
)
/** `m / 10^k`: decimals with up to `places` fraction digits. */
const decimal = (bound: number, places: number) =>
  Arbitrary.all([Arbitrary.schema(Int(-bound, bound)), Arbitrary.schema(Int(0, places))]).pipe(
    Arbitrary.map(([m, k]) => m / 10 ** k),
  )
/**
 * Short decimals near zero, drawn from a small pool so that equal integer
 * parts and one value's digits being a prefix of another's (`-3`, `-3.1`,
 * `-3.14`) come up often.
 */
const nearDecimal = decimal(400, 3)
const wideDecimal = decimal(1_000_000_000, 12)

const EDGES: ReadonlyArray<number> = [
  0,
  -0,
  1,
  -1,
  3,
  3.1,
  3.14,
  4,
  -3,
  -3.1,
  -3.14,
  -4,
  0.5,
  -0.5,
  1e-7,
  -1e-7,
  1e-6,
  10,
  10.5,
  19.99,
  100,
  2 ** 53 - 1,
  2 ** 53,
  2 ** 53 + 2,
  -(2 ** 53 - 1),
  -(2 ** 53 + 2),
  1e16 - 2,
  1e16,
  1e16 + 2,
  1.5e16,
  -(1e16 - 2),
  -1e16,
  -1.5e16,
  1e21,
  -1e21,
  Number.MIN_VALUE,
  -Number.MIN_VALUE,
  2.2250738585072014e-308,
  Number.MAX_VALUE,
  -Number.MAX_VALUE,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
]
const edge = Arbitrary.schema(Int(0, EDGES.length - 1)).pipe(Arbitrary.map((i) => EDGES[i]!))

/** A number from one of the sources. */
const number = Arbitrary.schema(Int(0, 3)).pipe(
  Arbitrary.flatMap((k) =>
    k === 0 ? anyDouble : k === 1 ? wideDecimal : k === 2 ? nearDecimal : edge,
  ),
)

const BIG_EDGES: ReadonlyArray<bigint> = [
  0n,
  1n,
  -1n,
  10n ** 38n - 1n,
  10n ** 38n,
  10n ** 38n + 1n,
  -(10n ** 38n - 1n),
  -(10n ** 38n),
  -(10n ** 38n + 1n),
  10n ** 999n,
  -(10n ** 999n),
  10n ** 1000n - 1n,
  -(10n ** 1000n - 1n),
]
/** Up to 45 significant digits followed by up to 12 zeros, either sign. */
const randomBigint = Arbitrary.all([
  Arbitrary.schema(Schema.Array(Int(0, 9)).check(Schema.isBetweenLength(1, 45))),
  Arbitrary.schema(Int(0, 12)),
  Arbitrary.schema(Schema.Boolean),
]).pipe(
  Arbitrary.map(([digits, zeros, negative]) => {
    const n = BigInt(`${digits.join("")}${"0".repeat(zeros)}`)
    return negative ? -n : n
  }),
)
const bigint = Arbitrary.schema(Int(0, 3)).pipe(
  Arbitrary.flatMap((k) =>
    k === 0
      ? Arbitrary.schema(Int(0, BIG_EDGES.length - 1)).pipe(Arbitrary.map((i) => BIG_EDGES[i]!))
      : randomBigint,
  ),
)

const sku = Arbitrary.schema(Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9]{0,4}$/)))

// -- properties --

describe("NumericKey — order", () => {
  it.prop(
    "number key text sorts like the numbers, under every casing",
    { a: number, b: number },
    ({ a, b }) => {
      const ta = KeyComposer.serializeValue(a)
      const tb = KeyComposer.serializeValue(b)
      expect(byteOrder(ta, tb), `${a} vs ${b}: ${ta} vs ${tb}`).toBe(numericOrder(a, b))
      for (const casing of casings) {
        expect(DynamoSchema.applyCasing(ta, casing)).toBe(ta)
      }
    },
    { arbitrary: { runs: 2000 } },
  )

  it.prop(
    "bigint key text sorts like the bigints, under every casing",
    { a: bigint, b: bigint },
    ({ a, b }) => {
      const ta = KeyComposer.serializeValue(a)
      const tb = KeyComposer.serializeValue(b)
      expect(byteOrder(ta, tb), `${a} vs ${b}`).toBe(numericOrder(a, b))
      for (const casing of casings) {
        expect(DynamoSchema.applyCasing(ta, casing)).toBe(ta)
      }
    },
    { arbitrary: { runs: 2000 } },
  )

  it.prop(
    "every byte is above the delimiter and none is a letter",
    { a: number, b: bigint },
    ({ a, b }) => {
      for (const text of [KeyComposer.serializeValue(a), KeyComposer.serializeValue(b)]) {
        expect(text, text).toMatch(/^[-*.:;)0-9]+$/)
      }
    },
  )

  for (const casing of casings) {
    const schema = DynamoSchema.make({ name: "Shop-App", version: 1, casing })
    const priceFirst: KeyComposer.IndexDefinition = {
      pk: { field: "pk", composite: ["store"] },
      sk: { field: "sk", composite: ["price", "sku"] },
    }
    const priceLast: KeyComposer.IndexDefinition = {
      pk: { field: "pk", composite: ["store"] },
      sk: { field: "sk", composite: ["sku", "price"] },
    }

    it.prop(
      `composed sort keys order by a non-last numeric composite first (${casing})`,
      { a: number, b: number, sa: sku, sb: sku },
      ({ a, b, sa, sb }) => {
        const ka = KeyComposer.composeSk(schema, "Item", 1, priceFirst, { price: a, sku: sa })
        const kb = KeyComposer.composeSk(schema, "Item", 1, priceFirst, { price: b, sku: sb })
        const expected =
          numericOrder(a, b) ||
          byteOrder(DynamoSchema.applyCasing(sa, casing), DynamoSchema.applyCasing(sb, casing))
        expect(byteOrder(ka, kb), `${ka} vs ${kb}`).toBe(expected)
      },
      { arbitrary: { runs: 1000 } },
    )

    it.prop(
      `composed sort keys order by a last numeric composite (${casing})`,
      { a: number, b: bigint, c: number, d: bigint },
      ({ a, b, c, d }) => {
        const key = (price: unknown) =>
          KeyComposer.composeSk(schema, "Item", 1, priceLast, { price, sku: "Mixed-1" })
        expect(byteOrder(key(a), key(c))).toBe(numericOrder(a, c))
        expect(byteOrder(key(b), key(d))).toBe(numericOrder(b, d))
      },
      { arbitrary: { runs: 1000 } },
    )
  }
})

describe("NumericKey — keys built on serializeValue", () => {
  it.prop(
    "time-series event keys (`#e#<orderBy>`) order by the orderBy value",
    { a: number, b: number },
    ({ a, b }) => {
      for (const casing of casings) {
        const current = "$App#v1#Reading#sensorId_S-1"
        const schema = DynamoSchema.make({ name: "App", version: 1, casing })
        const ka = KeyComposer.composeEventSk(schema, current, a, casing)
        const kb = KeyComposer.composeEventSk(schema, current, b, casing)
        expect(byteOrder(ka, kb), `${a} vs ${b}`).toBe(numericOrder(a, b))
      }
    },
  )

  it.prop(
    "unique-constraint sentinels are equal exactly when the values are",
    { a: number, b: bigint },
    ({ a, b }) => {
      const schema = DynamoSchema.make({ name: "app", version: 1 })
      const key = (value: unknown) =>
        DynamoSchema.composeUniqueKey(schema, "Price", "amount", [
          KeyComposer.serializeValue(value),
        ]).pk
      expect(key(a)).toBe(key(a === 0 ? -a : a))
      expect(key(a) === key(a + 1)).toBe(a === a + 1)
      // A neighbour toward zero, which stays within the 1,000-digit limit.
      expect(key(b) === key(b > 0n ? b - 1n : b + 1n)).toBe(false)
    },
  )
})

describe("NumericKey — the 1.36 bytes", () => {
  const SafeInt = Arbitrary.schema(Int(0, Number.MAX_SAFE_INTEGER))
  /** Integers past 2^53 and below 1e16, which doubles still hold exactly (as even numbers, …). */
  const largeInt = Arbitrary.all([
    Arbitrary.schema(Int(0, 99_999_999)),
    Arbitrary.schema(Int(0, 99_999_999)),
  ]).pipe(
    Arbitrary.map(([hi, lo]) => hi * 1e8 + lo),
    Arbitrary.filter((n) => n < 1e16),
  )

  it.prop(
    "a non-negative integer below 1e16 keeps String(n).padStart(16)",
    { a: SafeInt, b: largeInt },
    ({ a, b }) => {
      for (const n of [a, b]) {
        expect(Number.isInteger(n)).toBe(true)
        expect(KeyComposer.serializeValue(n)).toBe(String(n).padStart(16, "0"))
      }
    },
  )

  it.prop(
    "a non-negative bigint below 1e38 keeps String(n).padStart(38)",
    { digits: Schema.Array(Int(0, 9)).check(Schema.isBetweenLength(1, 38)) },
    ({ digits }) => {
      const n = BigInt(digits.join(""))
      expect(KeyComposer.serializeValue(n)).toBe(String(n).padStart(38, "0"))
    },
  )

  it("-0 keeps the bytes of 0", () => {
    expect(KeyComposer.serializeValue(-0)).toBe("0000000000000000")
  })
})

describe("NumericKey — golden vectors", () => {
  const numbers: ReadonlyArray<readonly [number, string]> = [
    [0, "0000000000000000"],
    [42, "0000000000000042"],
    [9007199254740991, "9007199254740991"],
    [9999999999999998, "9999999999999998"],
    [3.14, "0000000000000003.14"],
    [0.1, "0000000000000000.1"],
    [1e-7, "0000000000000000.0000001"],
    [10.5, "0000000000000010.5"],
    [19.99, "0000000000000019.99"],
    [1e16, ":0161"],
    [1.5e16, ":01615"],
    [1e16 + 2, ":01610000000000000002"],
    [1e21, ":0211"],
    [Number.MAX_VALUE, ":30817976931348623157"],
    [-3, "-9999999999999996:"],
    [-3.1, "-9999999999999996.8:"],
    [-3.14, "-9999999999999996.85:"],
    [-0.5, "-9999999999999999.4:"],
    [-9999999999999998, "-0000000000000001:"],
    [-1e16, "-*9838:"],
    [-1.5e16, "-*98384:"],
    [-Number.MAX_VALUE, "-*69182023068651376842:"],
    [Number.POSITIVE_INFINITY, ";"],
    [Number.NEGATIVE_INFINITY, "-)"],
  ]
  for (const [n, text] of numbers) {
    it(`${n} → ${text}`, () => {
      expect(KeyComposer.serializeValue(n)).toBe(text)
    })
  }

  it("the smallest subnormal is written out in full", () => {
    expect(KeyComposer.serializeValue(Number.MIN_VALUE)).toBe(
      `0000000000000000.${"0".repeat(323)}5`,
    )
  })

  const bigints: ReadonlyArray<readonly [bigint, string]> = [
    [42n, "00000000000000000000000000000000000042"],
    [10n ** 38n - 1n, "9".repeat(38)],
    [10n ** 38n, ":0381"],
    [10n ** 38n + 1n, ":038100000000000000000000000000000000000001"],
    [-5n, `-${"9".repeat(37)}4:`],
    [-(10n ** 38n), "-*9618:"],
    [10n ** 999n, ":9991"],
  ]
  for (const [n, text] of bigints) {
    it(`${n}n → ${text.length > 50 ? `${text.slice(0, 50)}…` : text}`, () => {
      expect(KeyComposer.serializeValue(n)).toBe(text)
    })
  }

  it("the values 1.36 misordered now sort numerically", () => {
    // 1.36 sorted these by key as -10, -5, 0, 3, 100, 10.5, 1e-7, 3.14, 19.99, 1e21, 1e16.
    const values = [-10, -5, 0, 3, 100, 10.5, 1e-7, 3.14, 19.99, 1e21, 1e16]
    const byKey = [...values].sort((a, b) =>
      byteOrder(KeyComposer.serializeValue(a), KeyComposer.serializeValue(b)),
    )
    expect(byKey).toEqual([-10, -5, 0, 1e-7, 3, 3.14, 10.5, 19.99, 100, 1e16, 1e21])
  })
})

describe("NumericKey — refused values", () => {
  it("NaN has no order: [EDD-9096]", () => {
    expect(() => KeyComposer.serializeValue(Number.NaN)).toThrow(/\[EDD-9096\].*NaN/)
    try {
      KeyComposer.serializeValue(Number.NaN)
    } catch (error) {
      expect((error as { readonly _tag?: string })._tag).toBe("KeyValueError")
    }
  })

  it("a bigint of 1,000 digits encodes; 1,001 digits is refused", () => {
    expect(KeyComposer.serializeValue(10n ** 1000n - 1n)).toBe(`:999${"9".repeat(1000)}`)
    expect(() => KeyComposer.serializeValue(10n ** 1000n)).toThrow(/\[EDD-9096\].*1001-digit/)
    expect(() => KeyComposer.serializeValue(-(10n ** 1000n))).toThrow(/\[EDD-9096\]/)
  })
})
