/**
 * ZOrder dimensions and the internal curve algebra (#171).
 *
 * Property tests check the algebra against brute force over every address of
 * small layouts (B ≤ 10); unit tests pin the stored format — the MSB-aligned
 * layout, FNV-1a-64, prefix segments — which can't change without a new index.
 */
import { describe, expect, it } from "@effect/vitest"
import { DateTime, Schema } from "effect"
import * as Curve from "../src/internal/ZOrderCurve.js"
import * as ZOrder from "../src/ZOrder.js"

const NUMBER: Curve.DimensionStorage = { _tag: "Number", numeric: "number" }

const bind = (dimension: ZOrder.Dimension, storage: Curve.DimensionStorage = NUMBER) =>
  Curve.bindDimension(dimension.spec, storage)

/** A layout of `literals` dimensions: `widths[i]` bits, `levels[i]` (≤ 2^bits) levels. */
const layoutOf = (widths: ReadonlyArray<number>, levels?: ReadonlyArray<number>): Curve.Layout =>
  Curve.makeLayout(
    widths.map((bits, i) =>
      bind(
        ZOrder.literals(
          `d${i}`,
          Array.from({ length: levels?.[i] ?? 2 ** bits }, (_, v) => v),
          { bits },
        ),
        { _tag: "Literal" },
      ),
    ),
  )

const Int = (minimum: number, maximum: number) =>
  Schema.Int.check(Schema.isBetween({ minimum, maximum }))

/**
 * A random small layout and a random box over it: 1–3 dimensions, 1–4 bits
 * each (at most 10 in all), a level count up to 2^bits, and per dimension one
 * or two disjoint intervals.
 */
const BoxCase = Schema.Struct({
  widths: Schema.Array(Int(1, 4)).check(Schema.isBetweenLength(1, 3)),
  seeds: Schema.Array(Int(0, 1_000_000)).check(Schema.isBetweenLength(15, 15)),
})

const boxCase = (input: typeof BoxCase.Type) => {
  const widths: Array<number> = []
  let total = 0
  for (const w of input.widths) {
    const bits = Math.min(w, 10 - total)
    if (bits < 1) break
    widths.push(bits)
    total += bits
  }
  const seed = (i: number) => input.seeds[i % input.seeds.length]!
  const levels = widths.map((bits, i) => 1 + (seed(i) % 2 ** bits))
  const layout = layoutOf(widths, levels)
  const box: Array<ReadonlyArray<Curve.Interval>> = levels.map((n, i) => {
    const ends = [0, 1, 2, 3]
      .map((k) => BigInt(seed(3 + i * 4 + k) % n))
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    const [a, b, c, d] = ends as [bigint, bigint, bigint, bigint]
    if (seed(i + 7) % 2 === 0) return [[a, d]]
    return b < c
      ? [
          [a, b],
          [c, d],
        ]
      : [[a, d]]
  })
  return { layout, box }
}

/** Every in-box address of a box, in order, by enumerating its level tuples. */
const bruteForce = (layout: Curve.Layout, box: Curve.Box): Array<bigint> => {
  const tuples: Array<Array<bigint>> = [[]]
  for (const intervals of box) {
    const next: Array<Array<bigint>> = []
    for (const tuple of tuples) {
      for (const [lo, hi] of intervals) {
        for (let q = lo; q <= hi; q++) next.push([...tuple, q])
      }
    }
    tuples.splice(0, tuples.length, ...next)
  }
  return tuples.map((q) => Curve.interleave(layout, q)).sort((a, b) => (a < b ? -1 : 1))
}

const allAddresses = (layout: Curve.Layout): Array<bigint> =>
  Array.from({ length: 2 ** layout.bits }, (_, z) => BigInt(z))

describe("ZOrder — dimension constructors", () => {
  it("derives bits from the level count, at least 1", () => {
    expect(ZOrder.int("price", { min: 0, max: 5_000_000, step: 1_000 }).bits).toBe(13)
    expect(ZOrder.int("bedrooms", { min: 0, max: 15 }).bits).toBe(4)
    expect(ZOrder.int("flag", { min: 0, max: 1 }).bits).toBe(1)
    expect(ZOrder.float("rating", { min: 0, max: 5, step: 0.5 }).bits).toBe(4)
    expect(ZOrder.dateTime("listedAt", { from: "2024-01-01", unit: "hours", bits: 16 }).bits).toBe(
      16,
    )
    expect(ZOrder.literals("status", ["pending", "active", "closed"]).bits).toBe(2)
    expect(ZOrder.literals("only", ["one"]).bits).toBe(1)
    expect(ZOrder.literals("status", ["a", "b"], { bits: 5 }).bits).toBe(5)
    expect(ZOrder.string("name", { bytes: 2 }).bits).toBe(16)
  })

  it("is a TypeId'd, pipeable, inspectable value", () => {
    const d = ZOrder.int("price", { min: 0, max: 100 })
    expect(ZOrder.isDimension(d)).toBe(true)
    expect(ZOrder.isDimension({ field: "price" })).toBe(false)
    expect(d.pipe((x) => x.field)).toBe("price")
    expect(d.toJSON()).toEqual({
      _id: "ZOrder.Dimension",
      kind: "int",
      field: "price",
      min: 0,
      max: 100,
      step: 1,
      bits: 7,
    })
    expect(String(d)).toContain("ZOrder.Dimension")
  })

  it("reads an explicit undefined option as unset", () => {
    // Typed code under exactOptionalPropertyTypes can pass a possibly-undefined value.
    const step: number | undefined = undefined
    const bits: number | undefined = undefined
    expect(ZOrder.int("price", { min: 0, max: 100, step }).toJSON()).toEqual(
      ZOrder.int("price", { min: 0, max: 100 }).toJSON(),
    )
    expect(ZOrder.literals("status", ["a", "b", "c"], { bits }).bits).toBe(2)
  })

  it("accepts a Date or DateTime as dateTime's from", () => {
    const iso = ZOrder.dateTime("t", { from: "2024-01-01T00:00:00Z", unit: "days", bits: 8 })
    const date = ZOrder.dateTime("t", {
      from: new Date("2024-01-01T00:00:00Z"),
      unit: "days",
      bits: 8,
    })
    const dt = ZOrder.dateTime("t", {
      from: DateTime.makeUnsafe("2024-01-01T00:00:00Z"),
      unit: "days",
      bits: 8,
    })
    expect(iso.spec).toEqual(date.spec)
    expect(iso.spec).toEqual(dt.spec)
  })

  describe("[EDD-9087] per option", () => {
    const cases: ReadonlyArray<readonly [string, () => unknown]> = [
      ["empty field", () => ZOrder.int("", { min: 0, max: 1 })],
      ["int: non-integer min", () => ZOrder.int("x", { min: 0.5, max: 10 })],
      ["int: unsafe max", () => ZOrder.int("x", { min: 0, max: 2 ** 60 })],
      ["int: min = max", () => ZOrder.int("x", { min: 5, max: 5 })],
      ["int: step 0", () => ZOrder.int("x", { min: 0, max: 10, step: 0 })],
      ["int: step past the range", () => ZOrder.int("x", { min: 0, max: 10, step: 11 })],
      ["float: infinite max", () => ZOrder.float("x", { min: 0, max: Infinity, step: 1 })],
      ["float: min > max", () => ZOrder.float("x", { min: 2, max: 1, step: 0.1 })],
      ["float: negative step", () => ZOrder.float("x", { min: 0, max: 1, step: -0.1 })],
      ["float: over 2^53 levels", () => ZOrder.float("x", { min: 0, max: 1, step: 1e-17 })],
      [
        "dateTime: unparseable from",
        () => ZOrder.dateTime("x", { from: "not a date", unit: "days", bits: 8 }),
      ],
      [
        "dateTime: unknown unit",
        () => ZOrder.dateTime("x", { from: "2024-01-01", unit: "fortnights" as never, bits: 8 }),
      ],
      [
        "dateTime: bits 0",
        () => ZOrder.dateTime("x", { from: "2024-01-01", unit: "days", bits: 0 }),
      ],
      [
        "dateTime: bits 54",
        () => ZOrder.dateTime("x", { from: "2024-01-01", unit: "days", bits: 54 }),
      ],
      ["literals: empty", () => ZOrder.literals("x", [])],
      ["literals: duplicates", () => ZOrder.literals("x", ["a", "a"])],
      ["literals: an object member", () => ZOrder.literals("x", [{} as never])],
      ["literals: bits too few", () => ZOrder.literals("x", ["a", "b", "c"], { bits: 1 })],
      ["string: bytes 0", () => ZOrder.string("x", { bytes: 0 })],
      ["string: bytes 17", () => ZOrder.string("x", { bytes: 17 })],
    ]
    for (const [name, make] of cases) {
      it(name, () => {
        expect(make).toThrow(/\[EDD-9087\]/)
      })
    }
  })
})

describe("ZOrderCurve — quantization", () => {
  it.prop(
    "int quantization is monotone and stays in range",
    { a: Int(-5000, 5000), b: Int(-5000, 5000) },
    ({ a, b }) => {
      const d = bind(ZOrder.int("x", { min: -1000, max: 1000, step: 7 }))
      const [lo, hi] = a <= b ? [a, b] : [b, a]
      expect(d.quantize(lo) <= d.quantize(hi)).toBe(true)
      expect(d.quantize(hi) < d.levels).toBe(true)
      expect(d.quantize(lo) >= 0n).toBe(true)
    },
  )

  it.prop(
    "float quantization is monotone",
    {
      a: Schema.Number.check(Schema.isBetween({ minimum: -50, maximum: 150 })),
      b: Schema.Number.check(Schema.isBetween({ minimum: -50, maximum: 150 })),
    },
    ({ a, b }) => {
      const d = bind(ZOrder.float("x", { min: -10.5, max: 99.25, step: 0.3 }))
      const [lo, hi] = a <= b ? [a, b] : [b, a]
      expect(d.quantize(lo) <= d.quantize(hi)).toBe(true)
      expect(d.quantize(hi) < d.levels).toBe(true)
    },
  )

  it.prop(
    "dateTime quantization is monotone across storages",
    { a: Int(1_600_000_000_000, 1_800_000_000_000), b: Int(1_600_000_000_000, 1_800_000_000_000) },
    ({ a, b }) => {
      const spec = ZOrder.dateTime("t", { from: "2024-01-01", unit: "hours", bits: 12 }).spec
      const [lo, hi] = a <= b ? [a, b] : [b, a]
      const ms = Curve.bindDimension(spec, { _tag: "Epoch", unit: "epochMs" })
      const iso = Curve.bindDimension(spec, { _tag: "UtcIsoString" })
      expect(ms.quantize(lo) <= ms.quantize(hi)).toBe(true)
      expect(iso.quantize(new Date(lo).toISOString())).toBe(ms.quantize(lo))
    },
  )

  it.prop(
    "string quantization follows UTF-8 byte order",
    { a: Schema.String, b: Schema.String },
    ({ a, b }) => {
      const d = bind(ZOrder.string("s", { bytes: 3 }), { _tag: "RawString" })
      const order = Curve.compareBytes(Curve.utf8(a), Curve.utf8(b))
      if (order <= 0) expect(d.quantize(a) <= d.quantize(b)).toBe(true)
      else expect(d.quantize(a) >= d.quantize(b)).toBe(true)
    },
  )

  it.prop("a bigint int is quantized like the same number", { a: Int(-5000, 5000) }, ({ a }) => {
    const d = bind(ZOrder.int("x", { min: -1000, max: 1000, step: 7 }), {
      _tag: "Number",
      numeric: "bigint",
    })
    expect(d.quantize(BigInt(a))).toBe(d.quantize(a))
  })

  it("quantizes a bigint past 2^53 in bigint arithmetic", () => {
    const d = bind(ZOrder.int("x", { min: -(2 ** 52), max: 2 ** 52, step: 2 }), {
      _tag: "Number",
      numeric: "bigint",
    })
    expect(d.quantize(2n ** 52n - 1n)).toBe(2n ** 52n - 1n)
    expect(d.quantize(-(2n ** 60n))).toBe(0n)
    expect(d.quantize(2n ** 60n)).toBe(d.levels - 1n)
  })

  it("clamps values outside min..max to the edge levels", () => {
    const d = bind(ZOrder.int("x", { min: 10, max: 20, step: 2 }))
    expect(d.levels).toBe(6n)
    expect(d.quantize(-1e9)).toBe(0n)
    expect(d.quantize(10)).toBe(0n)
    expect(d.quantize(13)).toBe(1n)
    expect(d.quantize(20)).toBe(5n)
    expect(d.quantize(1e9)).toBe(5n)
  })

  it("reads dates by storage: epoch seconds, zoned ISO", () => {
    const spec = ZOrder.dateTime("t", {
      from: "2024-01-01T00:00:00Z",
      unit: "hours",
      bits: 16,
    }).spec
    const seconds = Curve.bindDimension(spec, { _tag: "Epoch", unit: "epochSeconds" })
    const zoned = Curve.bindDimension(spec, { _tag: "ZonedIsoString" })
    const at = Date.parse("2024-01-02T03:00:00Z")
    expect(seconds.quantize(at / 1000)).toBe(27n)
    expect(zoned.quantize("2024-01-02T12:00:00.000+09:00[Asia/Tokyo]")).toBe(27n)
  })

  it("throws a tagged [EDD-9092] for a value it can't place", () => {
    const status = bind(ZOrder.literals("status", ["pending", "active"]), { _tag: "Literal" })
    const price = bind(ZOrder.int("price", { min: 0, max: 100 }))
    const at = Curve.bindDimension(
      ZOrder.dateTime("t", { from: "2024-01-01", unit: "days", bits: 8 }).spec,
      { _tag: "UtcIsoString" },
    )
    for (const attempt of [
      () => status.quantize("closed"),
      () => price.quantize(Number.NaN),
      () => at.quantize("not a date"),
    ]) {
      try {
        attempt()
        expect.unreachable()
      } catch (error) {
        expect(error).toBeInstanceOf(Curve.ZOrderValueError)
        expect(Curve.isZOrderValueError(error)).toBe(true)
        expect((error as Error).message).toMatch(/^\[EDD-9092\]/)
      }
    }
    expect(status.quantize("active")).toBe(1n)
  })

  it("recognises the error by its tag: a second copy of the package agrees", () => {
    // What another installation's class produces: the same tag, another prototype.
    const foreign = { _tag: "ZOrderValueError", field: "price", value: 1, reason: "", message: "" }
    expect(foreign).not.toBeInstanceOf(Curve.ZOrderValueError)
    expect(Curve.isZOrderValueError(foreign)).toBe(true)
    expect(Curve.isZOrderValueError(new Error("[EDD-9092]"))).toBe(false)
    expect(Curve.isZOrderValueError(undefined)).toBe(false)
  })
})

describe("ZOrderCurve — layout and interleave", () => {
  it("lays out 13 / 4 / 16 bits MSB-aligned, declaration order breaking ties", () => {
    const layout = Curve.makeLayout([
      bind(ZOrder.int("price", { min: 0, max: 5_000_000, step: 1_000 })),
      bind(ZOrder.int("bedrooms", { min: 0, max: 15 })),
      bind(ZOrder.dateTime("listedAt", { from: "2024-01-01", unit: "hours", bits: 16 }), {
        _tag: "UtcIsoString",
      }),
    ])
    expect(layout.bits).toBe(33)
    expect(layout.bytes).toBe(5)
    const tags = layout.order.map((o) => "pbl"[o.dim]).join("")
    // Rounds 0–3 emit p b l, rounds 4–12 p l, rounds 13–15 l.
    expect(tags).toBe(`${"pbl".repeat(4)}${"pl".repeat(9)}${"l".repeat(3)}`)
    // Each dimension's most significant bit enters in the first round.
    expect(layout.order.slice(0, 3)).toEqual([
      { dim: 0, bit: 12 },
      { dim: 1, bit: 3 },
      { dim: 2, bit: 15 },
    ])
  })

  it("the issue's 3-bit example: BIGMIN(16) = 36, precise ranges [14,15] and [36,37]", () => {
    const layout = layoutOf([3, 3])
    const box: Curve.Box = [[[3n, 4n]], [[2n, 3n]]]
    expect(Curve.interleave(layout, [3n, 2n])).toBe(14n)
    expect(Curve.interleave(layout, [4n, 3n])).toBe(37n)
    const { zmin, zmax } = Curve.corners(layout, box)
    expect([zmin, zmax]).toEqual([14n, 37n])
    expect(Curve.bigmin(layout, 16n, zmin, zmax)).toBe(36n)
    expect(Curve.nextInBox(layout, box, 16n)).toBe(36n)
    expect(Curve.litmax(layout, 35n, zmin, zmax)).toBe(15n)
    expect(Curve.plan(layout, box, 16)).toEqual({
      ranges: [
        { lo: 14n, hi: 15n, exact: true },
        { lo: 36n, hi: 37n, exact: true },
      ],
      exact: true,
    })
    expect(Curve.plan(layout, box, 1)).toEqual({
      ranges: [{ lo: 14n, hi: 37n, exact: false }],
      exact: false,
    })
  })

  it.prop(
    "deinterleave ∘ interleave = id (1–4 dimensions, 1–8 bits)",
    {
      widths: Schema.Array(Int(1, 8)).check(Schema.isBetweenLength(1, 4)),
      values: Schema.Array(Int(0, 255)).check(Schema.isBetweenLength(4, 4)),
    },
    ({ widths, values }) => {
      const layout = layoutOf(widths)
      const levels = widths.map((bits, i) => BigInt(values[i]! % 2 ** bits))
      const z = Curve.interleave(layout, levels)
      expect(z < 1n << BigInt(layout.bits)).toBe(true)
      expect(Curve.deinterleave(layout, z)).toEqual(levels)
      expect(Curve.fromBytes(Curve.toBytes(z, layout.bytes))).toBe(z)
    },
  )

  it("writes the address right-aligned in W bytes, a plain Uint8Array", () => {
    const bytes = Curve.toBytes(0x1234n, 3)
    expect(bytes).toEqual(new Uint8Array([0x00, 0x12, 0x34]))
    expect(bytes.constructor).toBe(Uint8Array)
    expect(Curve.toBytes(0n, 1)).toEqual(new Uint8Array([0]))
  })
})

describe("ZOrderCurve — boxes, BIGMIN / LITMAX, descent", () => {
  it.prop("inBox agrees with the enumerated box", { c: BoxCase }, ({ c }) => {
    const { layout, box } = boxCase(c)
    const inside = new Set(bruteForce(layout, box))
    for (const z of allAddresses(layout)) {
      expect(Curve.inBox(layout, box, z)).toBe(inside.has(z))
    }
  })

  it.prop(
    "nextInBox / prevInBox (and BIGMIN / LITMAX on single-interval boxes) equal brute force",
    { c: BoxCase },
    ({ c }) => {
      const { layout, box } = boxCase(c)
      const inside = bruteForce(layout, box)
      const single = box.every((intervals) => intervals.length === 1)
      const { zmin, zmax } = Curve.corners(layout, box)
      let next = 0
      for (const z of allAddresses(layout)) {
        while (next < inside.length && inside[next]! < z) next++
        const atOrAfter = inside[next]
        const atOrBefore = inside[next] === z ? z : inside[next - 1]
        expect(Curve.nextInBox(layout, box, z)).toBe(atOrAfter)
        expect(Curve.prevInBox(layout, box, z)).toBe(atOrBefore)
        if (single) {
          expect(Curve.bigmin(layout, z, zmin, zmax)).toBe(atOrAfter)
          expect(Curve.litmax(layout, z, zmin, zmax)).toBe(atOrBefore)
        }
      }
    },
  )

  it.prop(
    "plan covers the box within the cap, and exact ranges hold only in-box addresses",
    { c: BoxCase, cap: Int(1, 6) },
    ({ c, cap }) => {
      const { layout, box } = boxCase(c)
      const inside = new Set(bruteForce(layout, box))
      const { ranges, exact } = Curve.plan(layout, box, cap)
      expect(ranges.length).toBeLessThanOrEqual(cap)
      expect(exact).toBe(ranges.every((r) => r.exact))
      for (const z of inside) expect(ranges.some((r) => r.lo <= z && z <= r.hi)).toBe(true)
      for (const range of ranges) {
        if (!range.exact) continue
        for (let z = range.lo; z <= range.hi; z++) expect(inside.has(z)).toBe(true)
      }
      for (let i = 1; i < ranges.length; i++) {
        expect(ranges[i]!.lo > ranges[i - 1]!.hi + 1n).toBe(true)
      }
    },
  )

  it.prop("with a large cap the plan is the brute-force maximal runs", { c: BoxCase }, ({ c }) => {
    const { layout, box } = boxCase(c)
    const runs: Array<Curve.AddressRange> = []
    for (const z of bruteForce(layout, box)) {
      const last = runs[runs.length - 1]
      if (last !== undefined && last.hi + 1n === z) runs[runs.length - 1] = { ...last, hi: z }
      else runs.push({ lo: z, hi: z, exact: true })
    }
    expect(Curve.plan(layout, box, 100_000)).toEqual({ ranges: runs, exact: true })
  })

  it("merges the smallest gap first, ties at the lowest address", () => {
    // One 4-bit dimension: levels {1, 4, 6, 12} → gaps 2, 1, 5 between them.
    const layout = layoutOf([4])
    const box: Curve.Box = [
      [
        [1n, 1n],
        [4n, 4n],
        [6n, 6n],
        [12n, 12n],
      ],
    ]
    expect(Curve.plan(layout, box, 3).ranges).toEqual([
      { lo: 1n, hi: 1n, exact: true },
      { lo: 4n, hi: 6n, exact: false },
      { lo: 12n, hi: 12n, exact: true },
    ])
    expect(Curve.plan(layout, box, 2).ranges).toEqual([
      { lo: 1n, hi: 6n, exact: false },
      { lo: 12n, hi: 12n, exact: true },
    ])
    // Equal gaps (1 and 1): the lower one merges.
    const tied: Curve.Box = [
      [
        [1n, 1n],
        [3n, 3n],
        [5n, 5n],
      ],
    ]
    expect(Curve.plan(layout, tied, 2).ranges).toEqual([
      { lo: 1n, hi: 3n, exact: false },
      { lo: 5n, hi: 5n, exact: true },
    ])
  })

  it("plans nothing for a box no cell meets, one range for the whole space", () => {
    const layout = layoutOf([2])
    expect(Curve.plan(layout, Curve.fullBox(layout), 4)).toEqual({
      ranges: [{ lo: 0n, hi: 3n, exact: true }],
      exact: true,
    })
  })
})

describe("ZOrderCurve — quantizeBounds", () => {
  const layout = Curve.makeLayout([
    bind(ZOrder.int("price", { min: 0, max: 1000, step: 10 })),
    bind(ZOrder.literals("status", ["pending", "active", "closed"]), { _tag: "Literal" }),
  ])

  it("leaves an unbounded dimension its whole bit range", () => {
    // price: 101 levels in 7 bits; status: 3 levels in 2 bits.
    expect(Curve.quantizeBounds(layout, {})).toEqual([[[0n, 127n]], [[0n, 3n]]])
  })

  it("quantizes eq, between and open ends", () => {
    expect(Curve.quantizeBounds(layout, { price: { eq: 55 } })).toEqual([[[5n, 5n]], [[0n, 3n]]])
    expect(Curve.quantizeBounds(layout, { price: { between: [100, 250] } })?.[0]).toEqual([
      [10n, 25n],
    ])
    // An upper end at the top level runs to the top of the bits.
    expect(Curve.quantizeBounds(layout, { price: { gt: 100 } })?.[0]).toEqual([[10n, 127n]])
    expect(Curve.quantizeBounds(layout, { price: { lte: 5000 } })?.[0]).toEqual([[0n, 127n]])
    expect(Curve.quantizeBounds(layout, { price: { lte: 99 } })?.[0]).toEqual([[0n, 9n]])
  })

  it.prop(
    "an inverted pair, or one inverted within a level, is empty",
    { a: Int(0, 1000), b: Int(0, 1000) },
    ({ a, b }) => {
      if (a > b) {
        expect(Curve.quantizeBounds(layout, { price: { gte: a, lte: b } })).toBe("empty")
        expect(Curve.quantizeBounds(layout, { price: { between: [a, b] } })).toBe("empty")
      }
      expect(Curve.quantizeBounds(layout, { price: { gt: a, lt: a } })).toBe("empty")
      expect(Curve.quantizeBounds(layout, { price: { gte: a, lt: a } })).toBe("empty")
    },
  )

  it("an unbounded dimension doesn't cut cells above its top level: one bound plans exactly", () => {
    const listings = Curve.makeLayout([
      bind(ZOrder.int("price", { min: 0, max: 5_000_000, step: 1_000 })), // 5,001 levels, 13 bits
      bind(ZOrder.int("bedrooms", { min: 0, max: 15 })),
      bind(ZOrder.dateTime("listedAt", { from: "2024-01-01", unit: "hours", bits: 16 }), {
        _tag: "Epoch",
        unit: "epochMs",
      }),
    ])
    const box = Curve.quantizeBounds(listings, { bedrooms: { gte: 3 } })
    expect(box).toEqual([[[0n, 8191n]], [[3n, 15n]], [[0n, 65535n]]])
    const planned = Curve.plan(listings, box as Curve.Box, 128, 1)
    expect(planned.exact).toBe(true)
    expect(planned.ranges).toHaveLength(128)
    // An edge at price level 5,000 splits cells that hold no rows: no exact plan in 1,000 ranges.
    const cut: Curve.Box = [[[0n, 5000n]], [[3n, 15n]], [[0n, 65535n]]]
    expect(Curve.plan(listings, cut, 1000, 1).exact).toBe(false)
  })

  it("an inverted pair inside one level is empty, not that level", () => {
    // 12 and 15 share level 1: { gte: 15, lte: 12 } must not read it.
    expect(Curve.quantizeBounds(layout, { price: { gte: 15, lte: 12 } })).toBe("empty")
    expect(Curve.quantizeBounds(layout, { price: { gte: 12, lte: 15 } })?.[0]).toEqual([[1n, 1n]])
  })

  it("orders literals by declared index, and groups `in` into runs", () => {
    expect(
      Curve.quantizeBounds(layout, { status: { between: ["pending", "active"] } })?.[1],
    ).toEqual([[0n, 1n]])
    expect(Curve.quantizeBounds(layout, { status: { between: ["closed", "active"] } })).toBe(
      "empty",
    )
    expect(Curve.quantizeBounds(layout, { status: { gte: "active" } })?.[1]).toEqual([[1n, 3n]])
    expect(Curve.quantizeBounds(layout, { status: { in: ["closed", "pending"] } })?.[1]).toEqual([
      [0n, 0n],
      [2n, 3n],
    ])
    expect(Curve.quantizeBounds(layout, { status: { in: [] } })).toBe("empty")
    expect(() => Curve.quantizeBounds(layout, { status: { eq: "archived" } })).toThrow(
      /\[EDD-9092\]/,
    )
  })
})

describe("ZOrderCurve — bytes", () => {
  it("FNV-1a-64 golden vectors", () => {
    expect(Curve.fnv1a64(Curve.utf8("")).toString(16)).toBe("cbf29ce484222325")
    expect(Curve.fnv1a64(Curve.utf8("a")).toString(16)).toBe("af63dc4c8601ec8c")
    expect(Curve.fnv1a64(Curve.utf8("foobar")).toString(16)).toBe("85944171f73967e8")
  })

  it("a hashed segment is the first n bytes of the hash, big-endian", () => {
    expect(Curve.toHex(Curve.prefixSegment("a", 8))).toBe("0xaf63dc4c8601ec8c")
    expect(Curve.toHex(Curve.prefixSegment("a", 2))).toBe("0xaf63")
  })

  it("segments are length-prefixed by their UTF-8 byte length, so prefix-free", () => {
    expect(Curve.prefixSegment("a", undefined)).toEqual(new Uint8Array([0, 1, 0x61]))
    expect(Curve.prefixSegment("ab", undefined)).toEqual(new Uint8Array([0, 2, 0x61, 0x62]))
    expect(Curve.prefixSegment("é", undefined)).toEqual(new Uint8Array([0, 2, 0xc3, 0xa9]))
    // Casing can change the byte length: "ß".toUpperCase() is "SS".
    expect(Curve.prefixSegment("ß".toUpperCase(), undefined)).toEqual(
      new Uint8Array([0, 2, 0x53, 0x53]),
    )
  })

  it.prop(
    "no segment is a prefix of another",
    { a: Schema.String, b: Schema.String },
    ({ a, b }) => {
      // Distinct segments for distinct UTF-8 text: two strings whose lone
      // surrogates both encode as U+FFFD are one value as UTF-8 (as they are
      // in a DynamoDB string key), so they share a segment.
      const utf8 = new TextEncoder()
      if (Curve.compareBytes(utf8.encode(a), utf8.encode(b)) === 0) return
      const x = Curve.prefixSegment(a, undefined)
      const y = Curve.prefixSegment(b, undefined)
      const n = Math.min(x.length, y.length)
      expect(Curve.compareBytes(x.slice(0, n), y.slice(0, n))).not.toBe(0)
    },
  )

  it("segments sort by (byte length, bytes)", () => {
    const sorted = ["aa", "b", "ab", "c"]
      .map((v) => Curve.prefixSegment(v, undefined))
      .sort(Curve.compareBytes)
      .map((s) => new TextDecoder().decode(s.slice(2)))
    expect(sorted).toEqual(["b", "c", "aa", "ab"])
  })

  it("succ increments past carries, and has no successor for all-0xFF or empty", () => {
    expect(Curve.succ(new Uint8Array([1, 2]))).toEqual(new Uint8Array([1, 3]))
    expect(Curve.succ(new Uint8Array([1, 0xff, 0xff]))).toEqual(new Uint8Array([2]))
    expect(Curve.succ(new Uint8Array([0xff, 0xff]))).toBeUndefined()
    expect(Curve.succ(new Uint8Array([]))).toBeUndefined()
  })

  it.prop(
    "succ(x) is above every string starting with x",
    {
      x: Schema.Array(Int(0, 255)).check(Schema.isBetweenLength(1, 4)),
      tail: Schema.Array(Int(0, 255)).check(Schema.isBetweenLength(0, 3)),
    },
    ({ x, tail }) => {
      const bytes = new Uint8Array(x)
      const next = Curve.succ(bytes)
      if (next === undefined) {
        expect(x.every((b) => b === 0xff)).toBe(true)
        return
      }
      expect(Curve.compareBytes(new Uint8Array([...x, ...tail]), next)).toBeLessThan(0)
    },
  )

  it("renders bytes as 0x hex", () => {
    expect(Curve.toHex(new Uint8Array([0, 0x0a, 0xff]))).toBe("0x000aff")
  })
})
