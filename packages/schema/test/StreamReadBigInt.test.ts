/**
 * What a stream's read schema does with a stored `Schema.BigInt`, and which unions a stream refuses
 * for one. A bigint is marshalled as `N`, and the unmarshaller returns a safe integer as a number and
 * anything past that as a bigint, so a stream with mixed values read back only some of them.
 */

import { describe, expect, it } from "@effect/vitest"
import { Effect, Option, Schema, SchemaTransformation } from "effect"
import { readingStreamValues } from "../src/internal/EntitySchemas.js"
import { refuseUnreadable } from "../src/internal/SchemaAccessors.js"

const reader = (schema: Schema.Top) =>
  Schema.decodeUnknownSync(readingStreamValues(schema) as Schema.Codec<any, unknown>)

const past2to53 = 2n ** 60n
const BESIDE = "a union of Schema.BigInt and something else stored as a number"

/** The refusal of a stream's schema, or what it says when there's none. */
const refusal = (schema: Schema.Top): string => {
  try {
    refuseUnreadable("Owner", "schema", schema)
    return "nothing refused"
  } catch (error) {
    return (error as Error).message
  }
}

describe("readingStreamValues over Schema.BigInt", () => {
  it("a safe integer is a bigint again, whatever its sign", () => {
    for (const [stored, read] of [
      [5, 5n],
      [0, 0n],
      [-5, -5n],
      [Number.MAX_SAFE_INTEGER, BigInt(Number.MAX_SAFE_INTEGER)],
      [Number.MIN_SAFE_INTEGER, BigInt(Number.MIN_SAFE_INTEGER)],
    ] as const) {
      expect(reader(Schema.BigInt)(stored)).toBe(read)
    }
  })

  it("a bigint the unmarshaller returned stays one", () => {
    expect(reader(Schema.BigInt)(past2to53)).toBe(past2to53)
  })

  it("what isn't a stored bigint is still refused", () => {
    for (const stored of [5.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, "5", null, {}, [5], true]) {
      expect(() => reader(Schema.BigInt)(stored)).toThrow()
    }
  })

  const POSITIONS: ReadonlyArray<readonly [string, Schema.Top, unknown, unknown]> = [
    ["a struct", Schema.Struct({ b: Schema.BigInt }), { b: 5 }, { b: 5n }],
    ["an optional", Schema.Struct({ b: Schema.optional(Schema.BigInt) }), { b: 5 }, { b: 5n }],
    [
      "an optional key",
      Schema.Struct({ b: Schema.optionalKey(Schema.BigInt) }),
      { b: 5 },
      { b: 5n },
    ],
    ["an absent optional key", Schema.Struct({ b: Schema.optionalKey(Schema.BigInt) }), {}, {}],
    ["a list", Schema.Array(Schema.BigInt), [5, past2to53], [5n, past2to53]],
    ["a tuple", Schema.Tuple([Schema.String, Schema.BigInt]), ["a", 5], ["a", 5n]],
    ["a record", Schema.Record(Schema.String, Schema.BigInt), { a: 5 }, { a: 5n }],
    ["NullOr, a value", Schema.NullOr(Schema.BigInt), 5, 5n],
    ["NullOr, null", Schema.NullOr(Schema.BigInt), null, null],
    ["a struct or null", Schema.NullOr(Schema.Struct({ b: Schema.BigInt })), { b: 5 }, { b: 5n }],
    ["a union, later", Schema.Union([Schema.String, Schema.BigInt]), 5, 5n],
    ["a union, first", Schema.Union([Schema.BigInt, Schema.String]), 5, 5n],
    ["a union, the other member", Schema.Union([Schema.BigInt, Schema.String]), "a", "a"],
    ["a oneOf union", Schema.Union([Schema.BigInt, Schema.String], { mode: "oneOf" }), 5, 5n],
    ["a suspend", Schema.suspend(() => Schema.BigInt), 5, 5n],
    [
      "a decoding default",
      Schema.Struct({ b: Schema.BigInt.pipe(Schema.withDecodingDefault(Effect.succeed(1n))) }),
      { b: 5 },
      { b: 5n },
    ],
    [
      "a decoding default, nothing stored",
      Schema.Struct({ b: Schema.BigInt.pipe(Schema.withDecodingDefault(Effect.succeed(1n))) }),
      {},
      { b: 1n },
    ],
    ["a brand", Schema.BigInt.pipe(Schema.brand("B")), 5, 5n],
    ["a check", Schema.BigInt.check(Schema.isGreaterThanBigInt(0n)), 5, 5n],
    [
      "a struct decoded to something else",
      Schema.Struct({ b: Schema.BigInt }).pipe(
        Schema.decodeTo(Schema.Struct({ b: Schema.BigInt }), SchemaTransformation.passthrough()),
      ),
      { b: 5 },
      { b: 5n },
    ],
  ]

  for (const [name, schema, stored, read] of POSITIONS) {
    it(`reaches ${name}`, () => {
      expect(reader(schema)(stored)).toEqual(read)
    })
  }

  it("reaches a class's field, and the instance is the class", () => {
    class Paid extends Schema.Class<Paid>("Paid")({ amount: Schema.BigInt }) {}
    const read = reader(Paid)({ amount: 5 })
    expect(read).toBeInstanceOf(Paid)
    expect(read.amount).toBe(5n)
  })

  it("reaches an Option's value, on the map one is stored as", () => {
    const stored = { _op: "Some", "~effect/Option": {}, value: 5, _tag: "Some" }
    const read = reader(Schema.Option(Schema.BigInt))(stored)
    expect(Option.getOrThrow(read)).toBe(5n)
  })

  it("reaches a set's members", () => {
    const read = reader(Schema.ReadonlySet(Schema.BigInt))(new Set([5, past2to53]))
    expect([...read]).toEqual([5n, past2to53])
  })

  it("keeps a check, which still judges the lifted value", () => {
    const positive = reader(Schema.BigInt.check(Schema.isGreaterThanBigInt(0n)))
    expect(positive(5)).toBe(5n)
    expect(() => positive(-5)).toThrow()
  })

  it("keeps a recursive schema's end", () => {
    type Tree = { readonly n: bigint; readonly next: ReadonlyArray<Tree> }
    const Tree: Schema.Codec<Tree> = Schema.Struct({
      n: Schema.BigInt,
      next: Schema.Array(Schema.suspend((): Schema.Codec<Tree> => Tree)),
    })
    expect(reader(Tree)({ n: 1, next: [{ n: 2, next: [] }] })).toEqual({
      n: 1n,
      next: [{ n: 2n, next: [] }],
    })
  })

  it("what holds no bigint is returned as it came", () => {
    for (const schema of [
      Schema.Number,
      Schema.BigIntFromString,
      Schema.Struct({ s: Schema.BigIntFromString }),
      Schema.Union([Schema.String, Schema.Number]),
    ] as ReadonlyArray<Schema.Top>) {
      expect(readingStreamValues(schema)).toBe(schema)
    }
  })

  it("the write side is the schema's own: a number is still not a bigint to encode", () => {
    const read = readingStreamValues(Schema.Struct({ b: Schema.BigInt })) as Schema.Codec<any>
    expect(Schema.encodeUnknownSync(read)({ b: 5n })).toEqual({ b: 5n })
  })
})

describe("[EDD-9125] a union a stream can't read a bigint from", () => {
  const Tagged = (tag: string, field: Schema.Top) =>
    Schema.Struct({ _tag: Schema.tag(tag), v: field as never })
  const WithB = (field: Schema.Top) => Schema.Struct({ b: field as never })
  const Recursive: Schema.Codec<unknown> = Schema.Union([
    Schema.Number,
    Schema.Array(Schema.suspend(() => Recursive)),
  ])

  const REFUSED: ReadonlyArray<readonly [string, Schema.Top]> = [
    ["a number, later", Schema.Union([Schema.BigInt, Schema.Number])],
    ["a number, first", Schema.Union([Schema.Number, Schema.BigInt])],
    ["an int", Schema.Union([Schema.Int, Schema.BigInt])],
    [
      "a checked number",
      Schema.Union([Schema.Number.check(Schema.isGreaterThan(0)), Schema.BigInt]),
    ],
    ["a number literal", Schema.Union([Schema.Literal(5), Schema.BigInt])],
    ["a numeric enum", Schema.Union([Schema.Enum({ A: 1 }), Schema.BigInt])],
    [
      "a transformation stored as a number",
      Schema.Union([Schema.DateTimeUtcFromMillis, Schema.BigInt]),
    ],
    ["Schema.Unknown", Schema.Union([Schema.BigInt, Schema.Unknown])],
    ["Schema.Any", Schema.Union([Schema.BigInt, Schema.Any])],
    ["Schema.Json", Schema.Union([Schema.BigInt, Schema.Json])],
    ["Schema.MutableJson", Schema.Union([Schema.BigInt, Schema.MutableJson])],
    [
      "a custom declaration",
      Schema.Union([Schema.BigInt, Schema.declare((u): u is number => typeof u === "number")]),
    ],
    ["a suspended number", Schema.Union([Schema.BigInt, Schema.suspend(() => Schema.Number)])],
    ["a suspended bigint", Schema.Union([Schema.suspend(() => Schema.BigInt), Schema.Number])],
    ["a nested union", Schema.Union([Schema.Union([Schema.String, Schema.BigInt]), Schema.Number])],
    ["a number in a three-way union", Schema.Union([Schema.String, Schema.BigInt, Schema.Number])],
    ["the same struct over a number", Schema.Union([WithB(Schema.BigInt), WithB(Schema.Number)])],
    ["the struct the other way", Schema.Union([WithB(Schema.Number), WithB(Schema.BigInt)])],
    [
      "a first member that keeps its number, whatever more the bigint's has",
      Schema.Union([WithB(Schema.Number), Schema.Struct({ b: Schema.BigInt, c: Schema.String })]),
    ],
    [
      "a later member it would lift, whatever more that has",
      Schema.Union([WithB(Schema.BigInt), Schema.Struct({ b: Schema.Number, c: Schema.String })]),
    ],
    [
      "that, under a struct",
      Schema.Union([
        WithB(WithB(Schema.BigInt)),
        WithB(Schema.Struct({ b: Schema.Number, c: Schema.String })),
      ]),
    ],
    [
      "a struct over a record",
      Schema.Union([WithB(Schema.BigInt), Schema.Record(Schema.String, Schema.Number)]),
    ],
    [
      "a record over a struct",
      Schema.Union([Schema.Record(Schema.String, Schema.BigInt), WithB(Schema.Number)]),
    ],
    [
      "two records",
      Schema.Union([
        Schema.Record(Schema.String, Schema.BigInt),
        Schema.Record(Schema.String, Schema.Number),
      ]),
    ],
    ["a struct over Schema.Unknown", Schema.Union([WithB(Schema.BigInt), Schema.Unknown])],
    [
      "a struct over a custom declaration",
      Schema.Union([
        WithB(Schema.BigInt),
        Schema.declare((u): u is object => typeof u === "object"),
      ]),
    ],
    ["a list and a list", Schema.Union([Schema.Array(Schema.BigInt), Schema.Array(Schema.Number)])],
    ["tuples", Schema.Union([Schema.Tuple([Schema.BigInt]), Schema.Tuple([Schema.Number])])],
    [
      "a tuple and a list",
      Schema.Union([Schema.Tuple([Schema.BigInt]), Schema.Array(Schema.Number)]),
    ],
    [
      "a list in a tuple's rest",
      Schema.Union([
        Schema.TupleWithRest(Schema.Tuple([Schema.String]), [Schema.BigInt]),
        Schema.Array(Schema.Union([Schema.String, Schema.Number])),
      ]),
    ],
    ["two Options", Schema.Union([Schema.Option(Schema.BigInt), Schema.Option(Schema.Number)])],
    [
      "a struct that takes an Option's value first",
      Schema.Union([Schema.Struct({ value: Schema.Number }), Schema.Option(Schema.BigInt)]),
    ],
    [
      "a record that takes an Option first",
      Schema.Union([Schema.Record(Schema.String, Schema.Unknown), Schema.Option(Schema.BigInt)]),
    ],
    [
      "a struct that takes a Result's success first",
      Schema.Union([
        Schema.Struct({ success: Schema.Number }),
        Schema.Result(Schema.BigInt, Schema.String),
      ]),
    ],
    [
      "a struct that takes a Result's failure first",
      Schema.Union([
        Schema.Struct({ failure: Schema.Number }),
        Schema.Result(Schema.String, Schema.BigInt),
      ]),
    ],
    [
      "a declaration of no known map, after a struct",
      Schema.Union([
        Schema.Struct({ a: Schema.Number }),
        Schema.Exit(Schema.BigInt, Schema.String, Schema.Unknown),
      ]),
    ],
    [
      "a struct it would take an Option's value for",
      Schema.Union([Schema.Struct({ value: Schema.BigInt }), Schema.Option(Schema.Number)]),
    ],
    [
      "a struct it would take a Result's success for",
      Schema.Union([
        Schema.Struct({ success: Schema.BigInt }),
        Schema.Result(Schema.Number, Schema.String),
      ]),
    ],
    [
      "a struct carrying an Option's marker, after that Option",
      Schema.Union([
        Schema.Option(Schema.Number),
        Schema.Struct({ value: Schema.BigInt, "~effect/Option": Schema.Struct({}) }),
      ]),
    ],
    [
      "an Option, before a struct carrying its marker",
      Schema.Union([
        Schema.Option(Schema.BigInt),
        Schema.Struct({ value: Schema.Number, "~effect/Option": Schema.Struct({}) }),
      ]),
    ],
    [
      "Schema.Unknown before an Option",
      Schema.Union([Schema.Unknown, Schema.Option(Schema.BigInt)]),
    ],
    [
      "a oneOf, whichever comes first",
      Schema.Union([Schema.Struct({ b: Schema.Number, c: Schema.String }), WithB(Schema.BigInt)], {
        mode: "oneOf",
      }),
    ],
    [
      "a oneOf, the other way",
      Schema.Union([WithB(Schema.BigInt), Schema.Struct({ b: Schema.Number, c: Schema.String })], {
        mode: "oneOf",
      }),
    ],
    ["a transformation over a bigint", Schema.Union([Schema.DurationFromNanos, Schema.Number])],
    ["that, the other way", Schema.Union([Schema.Number, Schema.DurationFromNanos])],
    ["a recursive number", Schema.Union([Schema.BigInt, Recursive])],
    ["a nested struct", Schema.Union([WithB(WithB(Schema.BigInt)), WithB(WithB(Schema.Number))])],
    [
      "a field neither requires",
      Schema.Union([
        Schema.Struct({ b: Schema.optional(Schema.BigInt) }),
        Schema.Struct({ b: Schema.optional(Schema.Number) }),
      ]),
    ],
    [
      "tags that may both be absent",
      Schema.Union([
        Schema.Struct({ k: Schema.optional(Schema.Literal("a")), b: Schema.BigInt }),
        Schema.Struct({ k: Schema.optional(Schema.Literal("b")), b: Schema.Number }),
      ]),
    ],
    [
      "tags that may both be absent, as keys",
      Schema.Union([
        Schema.Struct({ k: Schema.optionalKey(Schema.Literal("a")), b: Schema.BigInt }),
        Schema.Struct({ k: Schema.optionalKey(Schema.Literal("b")), b: Schema.Number }),
      ]),
    ],
    [
      "tags of which it may hold the other's",
      Schema.Union([
        Schema.Struct({ k: Schema.Literals(["a", "b"]), b: Schema.BigInt }),
        Schema.Struct({ k: Schema.Literal("b"), b: Schema.Number }),
      ]),
    ],
    [
      "a tag it may hold of the other's many",
      Schema.Union([
        Schema.Struct({ k: Schema.Literal("b"), b: Schema.BigInt }),
        Schema.Struct({ k: Schema.Literals(["a", "b"]), b: Schema.Number }),
      ]),
    ],
    [
      "a tag of anything",
      Schema.Union([
        Schema.Struct({ k: Schema.Unknown, b: Schema.BigInt }),
        Schema.Struct({ k: Schema.Literal("b"), b: Schema.Number }),
      ]),
    ],
    [
      "a tag the other takes anything in",
      Schema.Union([
        Schema.Struct({ k: Schema.Literal("b"), b: Schema.BigInt }),
        Schema.Struct({ k: Schema.Unknown, b: Schema.Number }),
      ]),
    ],
    [
      "a tag of a declaration",
      Schema.Union([
        Schema.Struct({ k: Schema.Option(Schema.String), b: Schema.BigInt }),
        Schema.Struct({ k: Schema.Struct({ _tag: Schema.String }), b: Schema.Number }),
      ]),
    ],
    [
      "a tag the other has as a declaration",
      Schema.Union([
        Schema.Struct({ k: Schema.Struct({ _tag: Schema.String }), b: Schema.BigInt }),
        Schema.Struct({ k: Schema.Option(Schema.String), b: Schema.Number }),
      ]),
    ],
    [
      "a string literal tag and a string",
      Schema.Union([
        Schema.Struct({ k: Schema.Literal("a"), b: Schema.BigInt }),
        Schema.Struct({ k: Schema.String, b: Schema.Number }),
      ]),
    ],
    [
      "a string tag and a string literal",
      Schema.Union([
        Schema.Struct({ k: Schema.String, b: Schema.BigInt }),
        Schema.Struct({ k: Schema.Literal("a"), b: Schema.Number }),
      ]),
    ],
    [
      "a template literal tag and a string",
      Schema.Union([
        Schema.Struct({ k: Schema.TemplateLiteral(["a", Schema.String]), b: Schema.BigInt }),
        Schema.Struct({ k: Schema.String, b: Schema.Number }),
      ]),
    ],
    [
      "a template literal tag and a string literal",
      Schema.Union([
        Schema.Struct({ k: Schema.TemplateLiteral(["a", Schema.String]), b: Schema.BigInt }),
        Schema.Struct({ k: Schema.Literal("ab"), b: Schema.Number }),
      ]),
    ],
    [
      "a boolean literal tag and a boolean",
      Schema.Union([
        Schema.Struct({ k: Schema.Literal(true), b: Schema.BigInt }),
        Schema.Struct({ k: Schema.Boolean, b: Schema.Number }),
      ]),
    ],
    [
      "a number literal tag and a number",
      Schema.Union([
        Schema.Struct({ k: Schema.Literal(1), b: Schema.BigInt }),
        Schema.Struct({ k: Schema.Number, b: Schema.Number }),
      ]),
    ],
    [
      "a null under Schema.Unknown",
      Schema.Union([Schema.Struct({ b: Schema.NullOr(Schema.BigInt) }), Schema.Unknown]),
    ],
    ["a list under Schema.Unknown", Schema.Union([Schema.Array(Schema.BigInt), Schema.Unknown])],
    [
      "a record under Schema.Unknown",
      Schema.Union([Schema.Record(Schema.String, Schema.BigInt), Schema.Unknown]),
    ],
    ["under a list", Schema.Array(Schema.Union([Schema.Number, Schema.BigInt]))],
    ["under a struct", Schema.Struct({ s: Schema.Union([Schema.Number, Schema.BigInt]) })],
    ["under an Option", Schema.Option(Schema.Union([Schema.Number, Schema.BigInt]))],
    [
      "a struct it requires less than, with an optional field of its own",
      Schema.Union([
        Schema.Struct({ a: Schema.BigInt, x: Schema.optional(Schema.String) }),
        Schema.Struct({ a: Schema.Number }),
      ]),
    ],
    [
      "a struct taking an Option's map by its op, first",
      Schema.Union([
        Schema.Struct({ _op: Schema.String, value: Schema.Number }),
        Schema.Option(Schema.BigInt),
      ]),
    ],
    [
      "a struct taking an Option's map by its marker, first",
      Schema.Union([
        Schema.Struct({ "~effect/Option": Schema.Struct({}), value: Schema.Number }),
        Schema.Option(Schema.BigInt),
      ]),
    ],
    [
      "a struct whose field takes only an Option's none, first",
      Schema.Union([
        Schema.Struct({ k: Schema.Struct({ _tag: Schema.Literal("None") }), b: Schema.Number }),
        Schema.Struct({ k: Schema.Option(Schema.String), b: Schema.BigInt }),
      ]),
    ],
    [
      "a struct whose field could be a declaration of no known map, first",
      Schema.Union([
        Schema.Struct({
          k: Schema.Struct({ x: Schema.optional(Schema.String) }),
          b: Schema.Number,
        }),
        Schema.Struct({ k: Schema.Duration, b: Schema.BigInt }),
      ]),
    ],
    [
      "a struct whose field is another of Effect's declarations",
      Schema.Union([
        Schema.Struct({ k: Schema.Duration, b: Schema.BigInt }),
        Schema.Struct({ k: Schema.DateTimeUtc, b: Schema.Number }),
      ]),
    ],
    [
      "a record, with an optional field its values don't fit",
      Schema.Union([
        Schema.Struct({ a: Schema.BigInt, x: Schema.optional(Schema.String) }),
        Schema.Record(Schema.String, Schema.Number),
      ]),
    ],
    [
      "a record with a field the struct's field is, whatever its values",
      Schema.Union([
        Schema.Struct({ a: Schema.BigInt, c: Schema.String }),
        Schema.StructWithRest(Schema.Struct({ c: Schema.String }), [
          Schema.Record(Schema.String, Schema.Number),
        ]),
      ]),
    ],
    [
      "a record keyed by a pattern, which says nothing of a key outside it",
      Schema.Union([
        Schema.Struct({ a: Schema.BigInt, c: Schema.String }),
        Schema.Record(Schema.TemplateLiteral(["a", Schema.String]), Schema.Number),
      ]),
    ],
    [
      "a oneOf with a struct requiring more first",
      Schema.Union(
        [
          Schema.Struct({ a: Schema.BigInt, c: Schema.String }),
          Schema.Struct({ a: Schema.Number }),
        ],
        { mode: "oneOf" },
      ),
    ],
  ]

  for (const [name, schema] of REFUSED) {
    it(`refuses a bigint beside ${name}`, () => {
      expect(refusal(schema)).toContain(BESIDE)
      expect(refusal(schema)).toContain("Use Schema.BigIntFromString.")
    })
  }

  const TAKEN: ReadonlyArray<readonly [string, Schema.Top]> = [
    [
      "an Option of a number beside a struct with its marker, no bigint in either",
      Schema.Union([
        Schema.Option(Schema.Number),
        Schema.Struct({ "~effect/Option": Schema.Struct({}), value: Schema.Number }),
      ]),
    ],
    [
      "a struct with a name that isn't a marker",
      Schema.Union([
        Schema.Option(Schema.BigInt),
        Schema.Struct({ "~x": Schema.optional(Schema.String) }),
      ]),
    ],
    [
      "a struct whose field an Option's map can't be",
      Schema.Union([
        Schema.Struct({ k: Schema.Struct({ value: Schema.String }), b: Schema.Number }),
        Schema.Struct({ k: Schema.Option(Schema.Number), b: Schema.BigInt }),
      ]),
    ],
    [
      "a struct whose field an Option's map can't be, first",
      Schema.Union([
        Schema.Struct({ k: Schema.Option(Schema.Number), b: Schema.BigInt }),
        Schema.Struct({ k: Schema.Struct({ value: Schema.String }), b: Schema.Number }),
      ]),
    ],
    [
      "a struct whose field has another declaration's marker",
      Schema.Union([
        Schema.Struct({
          k: Schema.Struct({ "~effect/Result": Schema.Struct({}) }),
          b: Schema.Number,
        }),
        Schema.Struct({ k: Schema.Option(Schema.String), b: Schema.BigInt }),
      ]),
    ],
    ["null", Schema.NullOr(Schema.BigInt)],
    ["undefined", Schema.UndefinedOr(Schema.BigInt)],
    ["both", Schema.NullishOr(Schema.BigInt)],
    ["a string", Schema.Union([Schema.String, Schema.BigInt])],
    ["a boolean", Schema.Union([Schema.Boolean, Schema.BigInt])],
    ["a string literal", Schema.Union([Schema.Literal("a"), Schema.BigInt])],
    ["a transformation stored as a string", Schema.Union([Schema.NumberFromString, Schema.BigInt])],
    ["a struct", Schema.Union([WithB(Schema.Number), Schema.BigInt])],
    ["a list", Schema.Union([Schema.Array(Schema.Number), Schema.BigInt])],
    ["a date", Schema.Union([Schema.DateTimeUtc, Schema.BigInt])],
    [
      "another bigint",
      Schema.Union([Schema.BigInt.check(Schema.isGreaterThanBigInt(0n)), Schema.BigInt]),
    ],
    [
      "a number with a different tag",
      Schema.Union([Tagged("A", Schema.BigInt), Tagged("B", Schema.Number)]),
    ],
    [
      "a number with a different field tag",
      Schema.Union([
        Schema.Struct({ k: Schema.Literal("a"), b: Schema.BigInt }),
        Schema.Struct({ k: Schema.Literal("b"), b: Schema.Number }),
      ]),
    ],
    [
      "a number with a nested tag",
      Schema.Union([
        Schema.Struct({ m: Schema.Struct({ k: Schema.Literal("a") }), b: Schema.BigInt }),
        Schema.Struct({ m: Schema.Struct({ k: Schema.Literal("b") }), b: Schema.Number }),
      ]),
    ],
    [
      "a number under another name",
      Schema.Union([WithB(Schema.BigInt), Schema.Struct({ c: Schema.Number })]),
    ],
    [
      "an earlier member that requires a field it hasn't",
      Schema.Union([Schema.Struct({ b: Schema.Number, c: Schema.String }), WithB(Schema.BigInt)]),
    ],
    [
      "a later member without a field it requires",
      Schema.Union([Schema.Struct({ b: Schema.BigInt, c: Schema.String }), WithB(Schema.Number)]),
    ],
    [
      "a record of numbers it holds a string in",
      Schema.Union([
        Schema.Struct({ b: Schema.BigInt, c: Schema.String }),
        Schema.Record(Schema.String, Schema.Number),
      ]),
    ],
    [
      "that, the other way",
      Schema.Union([
        Schema.Record(Schema.String, Schema.Number),
        Schema.Struct({ b: Schema.BigInt, c: Schema.String }),
      ]),
    ],
    [
      "a record of numbers an Option's map has strings in",
      Schema.Union([Schema.Option(Schema.BigInt), Schema.Record(Schema.String, Schema.Number)]),
    ],
    [
      "a record over keys that don't take this field, whose values it doesn't fit",
      Schema.Union([
        Schema.Struct({ c: Schema.String }),
        Schema.Record(Schema.TemplateLiteral(["x-", Schema.String]), Schema.BigInt),
      ]),
    ],
    [
      "a date, with its bigint in a struct",
      Schema.Union([WithB(Schema.BigInt), Schema.DateTimeUtc]),
    ],
    ["that, the other way", Schema.Union([Schema.DateTimeUtc, WithB(Schema.BigInt)])],
    ["a Duration", Schema.Union([WithB(Schema.BigInt), Schema.Duration])],
    ["a BigDecimal", Schema.Union([WithB(Schema.BigInt), Schema.BigDecimal])],
    ["a time zone", Schema.Union([WithB(Schema.BigInt), Schema.TimeZone])],
    ["bytes", Schema.Union([WithB(Schema.BigInt), Schema.Uint8Array])],
    ["a set of numbers", Schema.Union([WithB(Schema.BigInt), Schema.ReadonlySet(Schema.Number)])],
    [
      "an Option of a string, in a struct",
      Schema.Union([WithB(Schema.BigInt), Schema.Option(Schema.String)]),
    ],
    [
      "an Option of a number, in a struct",
      Schema.Union([WithB(Schema.BigInt), Schema.Option(Schema.Number)]),
    ],
    [
      "a record's Option",
      Schema.Union([Schema.Record(Schema.String, Schema.BigInt), Schema.Option(Schema.Number)]),
    ],
    ["a list's Option", Schema.Union([Schema.Array(Schema.BigInt), Schema.Option(Schema.Number)])],
    [
      "an Option of a number, before a struct under its value",
      Schema.Union([Schema.Option(Schema.Number), Schema.Struct({ value: Schema.BigInt })]),
    ],
    [
      "a struct holding a string, with an Option's bigint",
      Schema.Union([Schema.Option(Schema.BigInt), Schema.Struct({ a: Schema.String })]),
    ],
    [
      "that, the other way",
      Schema.Union([Schema.Struct({ a: Schema.String }), Schema.Option(Schema.BigInt)]),
    ],
    [
      "a struct holding a number elsewhere, after an Option",
      Schema.Union([Schema.Option(Schema.BigInt), Schema.Struct({ a: Schema.Number })]),
    ],
    [
      "that, before it: an Option's map has no such field",
      Schema.Union([Schema.Struct({ a: Schema.Number }), Schema.Option(Schema.BigInt)]),
    ],
    [
      "a struct under an Option's value, after it",
      Schema.Union([Schema.Option(Schema.BigInt), Schema.Struct({ value: Schema.Number })]),
    ],
    [
      "that, with a tag an Option's value hasn't, before it",
      Schema.Union([
        Schema.Struct({ value: Schema.Number, _tag: Schema.Literal("None") }),
        Schema.Option(Schema.BigInt),
      ]),
    ],
    [
      "a string under an Option's value, before it",
      Schema.Union([Schema.Struct({ value: Schema.String }), Schema.Option(Schema.BigInt)]),
    ],
    [
      "another bigint under an Option's value, before it",
      Schema.Union([Schema.Struct({ value: Schema.BigInt }), Schema.Option(Schema.BigInt)]),
    ],
    [
      "a field that may be left out, before an Option",
      Schema.Union([
        Schema.Struct({ x: Schema.optional(Schema.Number) }),
        Schema.Option(Schema.BigInt),
      ]),
    ],
    [
      "a Result's other side",
      Schema.Union([
        Schema.Struct({ failure: Schema.Number }),
        Schema.Result(Schema.BigInt, Schema.String),
      ]),
    ],
    [
      "a Result's value, after it",
      Schema.Union([
        Schema.Result(Schema.BigInt, Schema.String),
        Schema.Struct({ success: Schema.Number }),
      ]),
    ],
    [
      "a set, before a struct",
      Schema.Union([Schema.ReadonlySet(Schema.BigInt), Schema.Struct({ a: Schema.Number })]),
    ],
    [
      "a set, after a struct: nothing in it is a field",
      Schema.Union([Schema.Struct({ a: Schema.Number }), Schema.ReadonlySet(Schema.BigInt)]),
    ],
    [
      "Schema.Unknown after an Option",
      Schema.Union([Schema.Option(Schema.BigInt), Schema.Unknown]),
    ],
    ["Schema.Json after an Option", Schema.Union([Schema.Option(Schema.BigInt), Schema.Json])],
    [
      "a date telling it from a number",
      Schema.Union([
        Schema.Struct({ k: Schema.DateTimeUtc, b: Schema.BigInt }),
        Schema.Struct({ k: Schema.Number, b: Schema.Number }),
      ]),
    ],
    [
      "that, the other way",
      Schema.Union([
        Schema.Struct({ k: Schema.Number, b: Schema.BigInt }),
        Schema.Struct({ k: Schema.DateTimeUtc, b: Schema.Number }),
      ]),
    ],
    [
      "an Option telling it from a string",
      Schema.Union([
        Schema.Struct({ k: Schema.Option(Schema.String), b: Schema.BigInt }),
        Schema.Struct({ k: Schema.String, b: Schema.Number }),
      ]),
    ],
    [
      "an Option telling it from a struct of other fields",
      Schema.Union([
        Schema.Struct({ k: Schema.Option(Schema.String), b: Schema.BigInt }),
        Schema.Struct({ k: Schema.Struct({ x: Schema.String }), b: Schema.Number }),
      ]),
    ],
    [
      "a list telling it from a date",
      Schema.Union([
        Schema.Struct({ k: Schema.Array(Schema.String), b: Schema.BigInt }),
        Schema.Struct({ k: Schema.DateTimeUtc, b: Schema.Number }),
      ]),
    ],
    [
      "a transformation over a bigint, beside a string",
      Schema.Union([Schema.DurationFromNanos, Schema.String]),
    ],
    ["a string under the same name", Schema.Union([WithB(Schema.BigInt), WithB(Schema.String)])],
    ["no field at all", Schema.Union([WithB(Schema.BigInt), Schema.Struct({})])],
    ["a list of strings", Schema.Union([Schema.Array(Schema.BigInt), Schema.Array(Schema.String)])],
    [
      "a tuple told apart by a literal",
      Schema.Union([
        Schema.Tuple([Schema.Literal("a"), Schema.BigInt]),
        Schema.Tuple([Schema.Literal("b"), Schema.Number]),
      ]),
    ],
    [
      "an Option of a string",
      Schema.Union([Schema.Option(Schema.BigInt), Schema.Option(Schema.String)]),
    ],
    ["a number, with no bigint in the union", Schema.Union([Schema.Number, Schema.String])],
    [
      "a number of its own list, and nothing else",
      Schema.Union([
        Schema.TupleWithRest(Schema.Tuple([Schema.Number]), [Schema.BigInt]),
        Schema.String,
      ]),
    ],
    [
      "a number in another position",
      Schema.Union([
        Schema.Tuple([Schema.BigInt, Schema.String]),
        Schema.Tuple([Schema.BigInt, Schema.Union([Schema.String, Schema.Number])]),
      ]),
    ],
    [
      "a set, which isn't an Option",
      Schema.Union([Schema.Option(Schema.BigInt), Schema.ReadonlySet(Schema.Number)]),
    ],
    [
      "a number with a tag it may leave out and the other requires",
      Schema.Union([
        Schema.Struct({ k: Schema.optionalKey(Schema.Literal("a")), b: Schema.BigInt }),
        Schema.Struct({ k: Schema.Literal("b"), b: Schema.Number }),
      ]),
    ],
    [
      "a number with a tag it requires and the other may leave out",
      Schema.Union([
        Schema.Struct({ k: Schema.Literal("a"), b: Schema.BigInt }),
        Schema.Struct({ k: Schema.optionalKey(Schema.Literal("b")), b: Schema.Number }),
      ]),
    ],
    [
      "a number with a tag of another kind",
      Schema.Union([
        Schema.Struct({ k: Schema.String, b: Schema.BigInt }),
        Schema.Struct({ k: Schema.Number, b: Schema.Number }),
      ]),
    ],
    [
      "a number with a string literal tag beside a boolean",
      Schema.Union([
        Schema.Struct({ k: Schema.Literal("true"), b: Schema.BigInt }),
        Schema.Struct({ k: Schema.Boolean, b: Schema.Number }),
      ]),
    ],
  ]

  for (const [name, schema] of TAKEN) {
    it(`takes a bigint beside ${name}`, () => {
      expect(refusal(schema)).toBe("nothing refused")
    })
  }

  const READS: ReadonlyArray<
    readonly [string, Schema.Top, ReadonlyArray<readonly [unknown, unknown]>]
  > = [
    [
      "a struct of other fields",
      Schema.Union([WithB(Schema.BigInt), Schema.Struct({ c: Schema.String })]),
      [
        [{ b: 5 }, { b: 5n }],
        [{ c: "x" }, { c: "x" }],
      ],
    ],
    [
      "the member first that requires what a bigint's hasn't",
      Schema.Union([Schema.Struct({ b: Schema.Number, c: Schema.String }), WithB(Schema.BigInt)]),
      [
        [{ b: 5 }, { b: 5n }],
        [
          { b: 5, c: "x" },
          { b: 5, c: "x" },
        ],
      ],
    ],
    [
      "the bigint first that requires what a number's hasn't",
      Schema.Union([Schema.Struct({ b: Schema.BigInt, c: Schema.String }), WithB(Schema.Number)]),
      [
        [
          { b: 5, c: "x" },
          { b: 5n, c: "x" },
        ],
        [{ b: 5 }, { b: 5 }],
      ],
    ],
    [
      "an Option before a struct under its value",
      Schema.Union([Schema.Option(Schema.BigInt), Schema.Struct({ value: Schema.Number })]),
      [
        [{ _op: "Some", _tag: "Some", "~effect/Option": {}, value: 5 }, Option.some(5n)],
        [{ value: 5 }, { value: 5 }],
      ],
    ],
    [
      "a number's Option before a struct under its value",
      Schema.Union([Schema.Option(Schema.Number), Schema.Struct({ value: Schema.BigInt })]),
      [
        [{ _op: "Some", _tag: "Some", "~effect/Option": {}, value: 5 }, Option.some(5)],
        [{ value: 5 }, { value: 5n }],
      ],
    ],
    [
      "a struct beside an Option of a number, without its value",
      Schema.Union([WithB(Schema.BigInt), Schema.Option(Schema.Number)]),
      [
        [{ b: 5 }, { b: 5n }],
        [{ _op: "Some", _tag: "Some", "~effect/Option": {}, value: 5 }, Option.some(5)],
      ],
    ],
  ]

  for (const [name, schema, rows] of READS) {
    it(`what it takes reads as what was written: ${name}`, () => {
      expect(refusal(schema)).toBe("nothing refused")
      for (const [stored, read] of rows) expect(reader(schema)(stored)).toEqual(read)
    })
  }

  it("a class's events told apart by a tag are taken", () => {
    class A extends Schema.TaggedClass<A>()("A", { v: Schema.BigInt }) {}
    class B extends Schema.TaggedClass<B>()("B", { v: Schema.Number }) {}
    expect(refusal(Schema.Union([A, B]))).toBe("nothing refused")
    expect(reader(Schema.Union([A, B]))({ _tag: "A", v: 5 })).toBeInstanceOf(A)
    expect(reader(Schema.Union([A, B]))({ _tag: "B", v: 5 })).toBeInstanceOf(B)
    expect(reader(Schema.Union([A, B]))({ _tag: "A", v: 5 }).v).toBe(5n)
    expect(reader(Schema.Union([A, B]))({ _tag: "B", v: 5 }).v).toBe(5)
  })

  it("classes with nothing to tell them apart are refused", () => {
    class A extends Schema.Class<A>("A")({ v: Schema.BigInt }) {}
    class B extends Schema.Class<B>("B")({ v: Schema.Number }) {}
    expect(refusal(Schema.Union([A, B]))).toContain(BESIDE)
  })

  it("a cycle in both members ends", () => {
    type T = { readonly b: bigint; readonly next?: T }
    type U = { readonly b: string; readonly next?: U }
    const T: Schema.Codec<T> = Schema.Struct({
      b: Schema.BigInt,
      next: Schema.optionalKey(Schema.suspend((): Schema.Codec<T> => T)),
    })
    const U: Schema.Codec<U> = Schema.Struct({
      b: Schema.String,
      next: Schema.optionalKey(Schema.suspend((): Schema.Codec<U> => U)),
    })
    expect(refusal(Schema.Union([T, U]))).toBe("nothing refused")
  })

  it("what a read takes where a tag may be left out is what was written", () => {
    const Tagged = Schema.Union([
      Schema.Struct({ k: Schema.optionalKey(Schema.Literal("a")), b: Schema.BigInt }),
      Schema.Struct({ k: Schema.Literal("b"), b: Schema.Number }),
    ])
    expect(reader(Tagged)({ b: 5 })).toEqual({ b: 5n })
    expect(reader(Tagged)({ k: "a", b: 5 })).toEqual({ k: "a", b: 5n })
    expect(reader(Tagged)({ k: "b", b: 5 })).toEqual({ k: "b", b: 5 })
  })

  it("a cycle both may hold can't be told apart", () => {
    type T = { readonly a: string; readonly next: T | "x" }
    const T: Schema.Codec<T> = Schema.Struct({
      a: Schema.String,
      next: Schema.Union([Schema.suspend((): Schema.Codec<T> => T), Schema.Literal("x")]),
    })
    const S = Schema.suspend((): Schema.Codec<T> => T)
    expect(
      refusal(
        Schema.Union([
          Schema.Struct({ k: Schema.Union([S, Schema.Literal("x")]), b: Schema.BigInt }),
          Schema.Struct({ k: Schema.Union([S, Schema.Literal("y")]), b: Schema.Number }),
        ]),
      ),
    ).toContain(BESIDE)
  })

  it("the suspended bigint in two places is judged in both", () => {
    const S = Schema.suspend(() => Schema.BigInt)
    expect(
      refusal(
        Schema.Union([
          Schema.Struct({ a: S, b: S }),
          Schema.Struct({ a: Schema.Union([Schema.String, Schema.BigInt]), b: Schema.Number }),
        ]),
      ),
    ).toContain(BESIDE)
  })

  it("an entity and an aggregate aren't judged by it where a member's try tells them apart", () => {
    for (const by of ["entity", "aggregate"] as const) {
      for (const schema of [
        Schema.Union([Schema.Number, Schema.BigInt]),
        Schema.Union([Schema.Option(Schema.BigInt), Schema.Option(Schema.Number)]),
        Schema.Union([Schema.DurationFromNanos, Schema.Number]),
        Schema.Union([Schema.suspend(() => Schema.BigInt), Schema.Number]),
        Schema.Union([Schema.Number, Schema.BigInt]).pipe(
          Schema.withDecodingDefault(Effect.succeed(0)),
        ),
      ]) {
        expect(() => refuseUnreadable("Owner", by, schema)).not.toThrow()
      }
    }
  })

  it("they are where the lift sits on the bigint: under a declaration, a suspend or a transformation", () => {
    const beside = Schema.Union([Schema.Number, Schema.BigInt])
    for (const by of ["entity", "aggregate"] as const) {
      for (const schema of [
        Schema.Option(beside),
        Schema.suspend(() => beside),
        beside.pipe(Schema.decodeTo(Schema.String, SchemaTransformation.passthrough() as never)),
        Schema.Option(Schema.Array(beside)),
        Schema.Struct({ o: Schema.Option(beside) }),
      ]) {
        expect(() => refuseUnreadable("Owner", by, schema)).toThrow(BESIDE)
      }
      for (const schema of [
        Schema.Option(Schema.Union([Schema.String, Schema.BigInt])),
        Schema.suspend(() => Schema.NullOr(Schema.BigInt)),
      ]) {
        expect(() => refuseUnreadable("Owner", by, schema)).not.toThrow()
      }
    }
  })
})
