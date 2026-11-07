/**
 * What a stream's read schema does with a stored `DateTime`. Nothing substitutes
 * `Schema.DateTimeUtc` or `Schema.DateTimeZoned` on a stream, so one is stored as the map
 * the marshaller makes of it, and Effect's guard only looks for the marker and the tag.
 * `DateTime.isDateTime` is what let the plain object through, so nothing here asserts with it:
 * `isReal` checks the prototype, `Equal`, and a function that needs the zone's formatter.
 */

import { describe, expect, it } from "@effect/vitest"
import { DateTime, Effect, Equal, Option, Result, Schema } from "effect"
import { readingStreamValues } from "../src/internal/EntitySchemas.js"
import { stringifyStrict } from "../src/internal/PackedCodec.js"

const ms = 1735689600000
const iso = "2025-01-01T00:00:00.000Z"
const marker = "~effect/DateTime"
const betaMarker = "~effect/time/DateTime"
const zoneMarker = "~effect/DateTime/TimeZone"

const utc = DateTime.makeUnsafe(iso)
const named = DateTime.makeZonedUnsafe(iso, { timeZone: "Asia/Tokyo" })
const offset = DateTime.makeZonedUnsafe(iso, { timeZone: DateTime.zoneMakeOffset(32400000) })

// As 1.39.0 stores them, unmarshalled: written out, not built by the code under test.
const utcRow = (key: string = marker) => ({ epochMilliseconds: ms, [key]: key, _tag: "Utc" })
const namedRow = (key: string = marker) => ({
  [key]: key,
  epochMilliseconds: ms,
  zone: { format: {}, id: "Asia/Tokyo", [zoneMarker]: zoneMarker, _tag: "Named" },
  _tag: "Zoned",
})
const offsetRow = (key: string = marker) => ({
  [key]: key,
  epochMilliseconds: ms,
  zone: { offset: 32400000, [zoneMarker]: zoneMarker, _tag: "Offset" },
  _tag: "Zoned",
})

const reader = (schema: Schema.Top) =>
  Schema.decodeUnknownSync(readingStreamValues(schema) as Schema.Codec<any, unknown>)

const isReal = (read: any, written: DateTime.DateTime) => {
  expect(Object.getPrototypeOf(read)).toBe(Object.getPrototypeOf(written))
  expect(Object.getPrototypeOf(read)).not.toBe(Object.prototype)
  expect(Equal.equals(read, written)).toBe(true)
  expect(Equal.equals(written, read)).toBe(true)
  expect(typeof read.pipe).toBe("function")
  expect(DateTime.getPart(read, "year")).toBe(2025)
  if (DateTime.isZoned(written)) {
    expect(Object.getPrototypeOf(read.zone)).toBe(Object.getPrototypeOf(written.zone))
    expect(Equal.equals(read.zone, written.zone)).toBe(true)
    expect(DateTime.formatIsoZoned(read)).toBe(DateTime.formatIsoZoned(written))
  }
}

const DATES = [
  ["Schema.DateTimeUtc", Schema.DateTimeUtc, utc, utcRow],
  ["Schema.DateTimeZoned, a named zone", Schema.DateTimeZoned, named, namedRow],
  ["Schema.DateTimeZoned, an offset zone", Schema.DateTimeZoned, offset, offsetRow],
] as const

describe.each(DATES)("%s", (_name, date, written, row) => {
  const D = date as unknown as Schema.DateTimeUtc
  const stored = row()

  it("comes back as a real date from the form 1.39.0 stores", () => {
    isReal(reader(D)(stored), written)
  })

  it("comes back as a real date from the form Effect's betas and early rcs wrote", () => {
    isReal(reader(D)(row(betaMarker)), written)
  })

  it("takes a real date as it is", () => {
    expect(reader(D)(written)).toBe(written)
  })

  it("comes back as a real date from what a packed write stores", () => {
    isReal(reader(D)(JSON.parse(stringifyStrict(written))), written)
  })

  class Holder extends Schema.Class<Holder>(`Holder-${_name}`)({ at: D }) {}
  class Tagged extends Schema.TaggedClass<Tagged>(`Tagged-${_name}`)(`Tagged-${_name}`, {
    at: D,
  }) {}
  type Any = any
  const POSITIONS: ReadonlyArray<readonly [string, Schema.Top, unknown, (read: Any) => unknown]> = [
    ["Array", Schema.Array(D), [stored], (r) => r[0]],
    ["an Array of an Array", Schema.Array(Schema.Array(D)), [[stored]], (r) => r[0][0]],
    ["NonEmptyArray", Schema.NonEmptyArray(D), [stored], (r) => r[0]],
    ["Tuple", Schema.Tuple([Schema.String, D]), ["a", stored], (r) => r[1]],
    [
      "a tuple's rest",
      Schema.TupleWithRest(Schema.Tuple([Schema.String]), [D]),
      ["a", stored],
      (r) => r[1],
    ],
    ["Record", Schema.Record(Schema.String, D), { a: stored }, (r) => r.a],
    ["Struct", Schema.Struct({ at: D }), { at: stored }, (r) => r.at],
    [
      "a Struct in a Struct",
      Schema.Struct({ s: Schema.Struct({ at: D }) }),
      { s: { at: stored } },
      (r) => r.s.at,
    ],
    [
      "a struct's index signature",
      Schema.StructWithRest(Schema.Struct({ at: D }), [Schema.Record(Schema.String, D)]),
      { at: stored, a: stored },
      (r) => r.a,
    ],
    ["Class", Holder, { at: stored }, (r) => r.at],
    ["TaggedClass", Tagged, { _tag: `Tagged-${_name}`, at: stored }, (r) => r.at],
    ["an annotated Class", Holder.annotate({ title: "t" }), { at: stored }, (r) => r.at],
    ["NullOr", Schema.NullOr(D), stored, (r) => r],
    ["NullishOr", Schema.NullishOr(D), stored, (r) => r],
    ["Union, the date first", Schema.Union([D, Schema.String]), stored, (r) => r],
    ["Union, the date second", Schema.Union([Schema.String, D]), stored, (r) => r],
    ["a oneOf Union", Schema.Union([D, Schema.String], { mode: "oneOf" }), stored, (r) => r],
    ["an annotated Union", Schema.Union([D, Schema.Number]).annotate({}), stored, (r) => r],
    ["optional", Schema.Struct({ at: Schema.optional(D) }), { at: stored }, (r) => r.at],
    ["optionalKey", Schema.Struct({ at: Schema.optionalKey(D) }), { at: stored }, (r) => r.at],
    [
      "optionalKey over a union",
      Schema.Struct({ at: Schema.optionalKey(Schema.Union([Schema.String, D])) }),
      { at: stored },
      (r) => r.at,
    ],
    [
      "optional over NullOr",
      Schema.Struct({ at: Schema.optional(Schema.NullOr(D)) }),
      { at: stored },
      (r) => r.at,
    ],
    [
      "a decoding default",
      Schema.Struct({
        at: D.pipe(Schema.withDecodingDefault(Effect.succeed(written as DateTime.Utc))),
      }),
      { at: stored },
      (r) => r.at,
    ],
    [
      "a decoding default on a key",
      Schema.Struct({
        at: D.pipe(Schema.withDecodingDefaultKey(Effect.succeed(written as DateTime.Utc))),
      }),
      { at: stored },
      (r) => r.at,
    ],
    ["a brand", D.pipe(Schema.brand("B")), stored, (r) => r],
    ["an annotation", D.annotate({ title: "t" }), stored, (r) => r],
    ["a check", D.check(Schema.makeFilter(() => true)), stored, (r) => r],
    ["suspend", Schema.suspend(() => D), stored, (r) => r],
    ["a mutable Array", Schema.mutable(Schema.Array(D)), [stored], (r) => r[0]],
    ["a checked Array", Schema.Array(D).check(Schema.isMinLength(1)), [stored], (r) => r[0]],
    [
      "a checked Struct",
      Schema.Struct({ at: D }).check(Schema.makeFilter(() => true)),
      { at: stored },
      (r) => r.at,
    ],
    [
      "the encoded side of a transformation",
      Schema.Struct({ at: D }).pipe(Schema.decodeTo(Schema.Struct({ at: D }))),
      { at: stored },
      (r) => r.at,
    ],
    [
      "a renamed key",
      Schema.Struct({ at: D }).pipe(Schema.encodeKeys({ at: "stored" })),
      { stored },
      (r) => r.at,
    ],
    [
      "Option",
      Schema.Option(D),
      Option.some(stored),
      (r) => Option.getOrThrow(r as Option.Option<unknown>),
    ],
    [
      "an Array of Option",
      Schema.Array(Schema.Option(D)),
      [Option.some(stored)],
      (r) => Option.getOrThrow(r[0] as Option.Option<unknown>),
    ],
    ["Result", Schema.Result(D, Schema.String), Result.succeed(stored), (r) => r.success],
  ]

  it.each(POSITIONS)("comes back real in %s", (_position, schema, input, pick) => {
    isReal(pick(reader(schema)(input)), written)
  })

  it("comes back real at every depth of a recursive schema", () => {
    type Tree = { readonly at: unknown; readonly next: ReadonlyArray<Tree> }
    const Tree: Schema.Codec<Tree> = Schema.Struct({
      at: D as Schema.Codec<unknown>,
      next: Schema.Array(Schema.suspend((): Schema.Codec<Tree> => Tree)),
    })
    const read = reader(Tree)({
      at: stored,
      next: [{ at: stored, next: [{ at: stored, next: [] }] }],
    })
    isReal(read.at, written)
    isReal(read.next[0].at, written)
    isReal(read.next[0].next[0].at, written)
  })

  it("a class stays the class, with a real date in it", () => {
    const read = reader(Holder)({ at: stored })
    expect(read).toBeInstanceOf(Holder)
    expect(read.constructor).toBe(Holder)
  })

  it("beside an absent value read back, in either order of a union", () => {
    const Tags = Schema.ReadonlySet(Schema.String)
    const members = [
      Schema.Struct({ k: Schema.Literal("a"), at: D, tags: Tags }),
      Schema.Struct({ k: Schema.Literal("b"), at: D }),
    ] as const
    for (const union of [
      Schema.Union(members),
      Schema.Union([members[1], members[0]]),
    ] as ReadonlyArray<Schema.Top>) {
      const a = reader(union)({ k: "a", at: stored })
      isReal(a.at, written)
      expect(a.tags).toEqual(new Set())
      isReal(reader(union)({ k: "b", at: stored }).at, written)
    }
  })

  it("a decoding default still fills a missing key", () => {
    const defaulted = D.pipe(Schema.withDecodingDefaultKey(Effect.succeed(written as DateTime.Utc)))
    isReal(reader(Schema.Struct({ at: defaulted }))({}).at, written)
  })

  it("a missing key is missing on optional, and an error on a required date", () => {
    expect(reader(Schema.Struct({ at: Schema.optionalKey(D) }))({})).toEqual({})
    expect(reader(Schema.Struct({ at: Schema.optional(D) }))({})).toEqual({})
    expect(reader(Schema.Struct({ at: Schema.optional(D) }))({ at: undefined })).toEqual({
      at: undefined,
    })
    expect(() => reader(Schema.Struct({ at: D }))({})).toThrow("Missing key")
  })

  it("a check runs on the real date", () => {
    const seen: Array<unknown> = []
    const checked = D.check(
      Schema.makeFilter((value: DateTime.Utc) => {
        seen.push(value)
        return true
      }),
    )
    reader(checked)(stored)
    expect(seen).toHaveLength(1)
    isReal(seen[0], written)
    const refusing = D.check(Schema.makeFilter(() => "no"))
    expect(() => reader(refusing)(stored)).toThrow("no")
  })

  it("refuses what its declaration refuses", () => {
    const read = reader(D)
    expect(() => read("x")).toThrow("Expected DateTime")
    expect(() => read(iso)).toThrow("Expected DateTime")
    expect(() => read(ms)).toThrow("Expected DateTime")
    expect(() => read(null)).toThrow("Expected DateTime")
    expect(() => read({ epochMilliseconds: ms, _tag: stored._tag })).toThrow("Expected DateTime")
  })
})

describe("what isn't a date stays what it is", () => {
  const Short = Schema.Struct({ _tag: Schema.Literal("Utc"), epochMilliseconds: Schema.Number })
  const Full = Schema.Struct({
    _tag: Schema.Literal("Utc"),
    epochMilliseconds: Schema.Number,
    [marker]: Schema.Literal(marker),
  })
  const short = { _tag: "Utc", epochMilliseconds: 5 }
  const full = { _tag: "Utc", epochMilliseconds: 5, [marker]: marker }

  it.each([
    ["a string, the date first", Schema.Union([Schema.DateTimeUtc, Schema.String]), "x"],
    ["a string, the date second", Schema.Union([Schema.String, Schema.DateTimeUtc]), "x"],
    ["the text of a date, the date first", Schema.Union([Schema.DateTimeUtc, Schema.String]), iso],
    ["the text of a date, the date second", Schema.Union([Schema.String, Schema.DateTimeUtc]), iso],
    ["a number", Schema.Union([Schema.DateTimeUtc, Schema.Number]), ms],
    ["null", Schema.NullOr(Schema.DateTimeUtc), null],
    ["a plain object, the date first", Schema.Union([Schema.DateTimeUtc, Short]), short],
    ["a plain object, the date second", Schema.Union([Short, Schema.DateTimeUtc]), short],
    [
      "a plain object with the marker, its member first",
      Schema.Union([Full, Schema.DateTimeUtc]),
      full,
    ],
    ["a map under Schema.Unknown", Schema.Unknown, utcRow()],
    [
      "a map under a union with Schema.Unknown first",
      Schema.Union([Schema.Unknown, Schema.DateTimeUtc]),
      utcRow(),
    ],
    ["a map under Schema.Any", Schema.Any, utcRow()],
    [
      "a map under a record of Unknown",
      Schema.Record(Schema.String, Schema.Unknown),
      { a: utcRow() },
    ],
    [
      "an unrelated declaration",
      Schema.declare((u: unknown): u is object => typeof u === "object"),
      utcRow(),
    ],
  ] as ReadonlyArray<readonly [string, Schema.Top, unknown]>)("%s", (_name, schema, value) => {
    expect(reader(schema)(value)).toEqual(value)
  })

  it("a plain object the date member claims first, since it has the marker, reads as that date", () => {
    // It carries Effect's own private key, so the guard takes it, as it always has.
    const read = reader(Schema.Union([Schema.DateTimeUtc, Full]))(full)
    expect(Equal.equals(read, DateTime.makeUnsafe(5))).toBe(true)
  })

  it("a stored date under a struct member first stays that struct's, as it was written", () => {
    expect(reader(Schema.Union([Short, Schema.DateTimeUtc]))(utcRow())).toEqual({
      _tag: "Utc",
      epochMilliseconds: ms,
    })
  })

  it("a union of both picks the member its tag says", () => {
    const read = reader(Schema.Union([Schema.DateTimeUtc, Schema.DateTimeZoned]))
    isReal(read(utcRow()), utc)
    isReal(read(namedRow()), named)
    const flipped = reader(Schema.Union([Schema.DateTimeZoned, Schema.DateTimeUtc]))
    isReal(flipped(utcRow()), utc)
    isReal(flipped(offsetRow()), offset)
  })
})

describe("a date's map that can't be rebuilt", () => {
  const unreadable = [
    ["the instant as text", { ...utcRow(), epochMilliseconds: "1735689600000" }],
    ["an instant that isn't finite", { ...utcRow(), epochMilliseconds: Number.NaN }],
  ] as const

  it.each(unreadable)("%s, with the current marker, reads as it always has", (_name, map) => {
    expect(reader(Schema.DateTimeUtc)(map)).toBe(map)
  })

  it.each(unreadable)("%s, with the older marker, fails as it always has", (_name, map) => {
    const { [marker]: _, ...rest } = map as Record<string, unknown>
    expect(() => reader(Schema.DateTimeUtc)({ ...rest, [betaMarker]: betaMarker })).toThrow(
      "Expected DateTime.Utc",
    )
  })

  it("a zone that can't be rebuilt, with the current marker, reads as it always has", () => {
    const map = { ...namedRow(), zone: { id: "No/Such_Zone", _tag: "Named" } }
    expect(reader(Schema.DateTimeZoned)(map)).toBe(map)
  })

  it("a zone that can't be rebuilt, with the older marker, fails as it always has", () => {
    const map = { ...namedRow(betaMarker), zone: { id: "No/Such_Zone", _tag: "Named" } }
    expect(() => reader(Schema.DateTimeZoned)(map)).toThrow("Expected DateTime.Zoned")
  })

  it("another tag isn't rebuilt under this declaration", () => {
    expect(() => reader(Schema.DateTimeUtc)(namedRow())).toThrow("Expected DateTime.Utc")
    expect(() => reader(Schema.DateTimeZoned)(utcRow())).toThrow("Expected DateTime.Zoned")
    expect(() => reader(Schema.DateTimeUtc)(namedRow(betaMarker))).toThrow("Expected DateTime.Utc")
    expect(() => reader(Schema.DateTimeZoned)(utcRow(betaMarker))).toThrow(
      "Expected DateTime.Zoned",
    )
  })

  it("a map with no marker isn't rebuilt, so a union keeps offering it to the next member", () => {
    const { [marker]: _, ...noMarker } = utcRow()
    expect(() => reader(Schema.DateTimeUtc)(noMarker)).toThrow("Expected DateTime.Utc")
  })
})

describe("readingStreamValues", () => {
  it("what holds no date is returned as it came", () => {
    for (const schema of [
      Schema.Unknown,
      Schema.String,
      Schema.Struct({ n: Schema.Number, s: Schema.Array(Schema.String) }),
      Schema.Union([Schema.String, Schema.Number]),
      Schema.Option(Schema.String),
      Schema.Tuple([Schema.String]),
      Schema.Record(Schema.String, Schema.Number),
      Schema.DateTimeUtcFromString,
      Schema.DateFromString,
    ] as ReadonlyArray<Schema.Top>) {
      expect(readingStreamValues(schema)).toBe(schema)
    }
  })

  it("a transformation from a string to a date isn't a stored map, and reads as declared", () => {
    expect(
      Equal.equals(
        reader(Schema.Struct({ at: Schema.DateTimeUtcFromString }))({ at: iso }).at,
        utc,
      ),
    ).toBe(true)
    expect(() => reader(Schema.DateTimeUtcFromString)(utcRow())).toThrow()
  })

  it("Schema.Date isn't touched: it's refused before a stream reads one", () => {
    const Schema_ = Schema.Struct({ at: Schema.Date })
    expect(readingStreamValues(Schema_)).toBe(Schema_)
  })

  it("the same schema builds the same read, so a recursive one has an end", () => {
    const Dated = Schema.Struct({ at: Schema.DateTimeUtc })
    expect(readingStreamValues(Dated).ast).toBe(readingStreamValues(Dated).ast)
    type Tree = { readonly at: unknown; readonly next: ReadonlyArray<Tree> }
    const Tree: Schema.Codec<Tree> = Schema.Struct({
      at: Schema.DateTimeUtc as Schema.Codec<unknown>,
      next: Schema.Array(Schema.suspend((): Schema.Codec<Tree> => Tree)),
    })
    const forced = (schema: Schema.Top) => {
      const next = (schema.ast as any).propertySignatures[1].type
      return next.rest[0].thunk()
    }
    const read = readingStreamValues(Tree)
    const once = forced(read)
    expect(once).toBe(read.ast)
    expect(forced(Schema.make<Schema.Top>(once))).toBe(once)
  })
})
