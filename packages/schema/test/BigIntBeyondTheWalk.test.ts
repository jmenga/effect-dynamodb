/**
 * A plain `Schema.BigInt` where an entity's or an aggregate's substitution can't walk: under a
 * declaration, a `Schema.suspend` or a transformation. It's stored as a number, and a read gets a
 * number back below 2^53, so it reads through the same lift as one the walk reaches.
 */

import { describe, expect, it } from "@effect/vitest"
import { DateTime, Duration, Effect, Option, Result, Schema, SchemaGetter } from "effect"
import { substituteSchemaDeep } from "../src/internal/EntitySchemas.js"

const past2to53 = 2n ** 60n

const READS = [
  ["an entity", { legacyReads: true, absentReads: true }],
  ["an aggregate", { tolerantTransforms: true, decodeOnly: true, absentReads: true }],
  [
    "an aggregate's mutated state",
    { tolerantTransforms: true, decodeOnly: true, enforceChecks: true, plainStateForms: true },
  ],
] as const

const some = (value: unknown) => ({ _op: "Some", _tag: "Some", "~effect/Option": {}, value })
const none = { _op: "None", _tag: "None", "~effect/Option": {} }
const success = (value: unknown) => ({
  _op: "Success",
  _tag: "Success",
  "~effect/Result": {},
  success: value,
})
const failure = (value: unknown) => ({
  _op: "Failure",
  _tag: "Failure",
  "~effect/Result": {},
  failure: value,
})

type Tree = { readonly n: bigint; readonly next?: Tree }
const Tree: Schema.Codec<Tree> = Schema.Struct({
  n: Schema.BigInt,
  next: Schema.optionalKey(Schema.suspend((): Schema.Codec<Tree> => Tree)),
})

const toNumber = Schema.BigInt.pipe(
  Schema.decodeTo(Schema.Number, {
    decode: SchemaGetter.transform((b: bigint) => Number(b)),
    encode: SchemaGetter.transform((n: number) => BigInt(n)),
  }),
)
const nanos = (n: bigint) => Duration.nanos(n)
const dateFromBigInt = Schema.BigInt.pipe(
  Schema.decodeTo(Schema.DateTimeUtc, {
    decode: SchemaGetter.transform((b: bigint) => DateTime.makeUnsafe(Number(b))),
    encode: SchemaGetter.transform((d: DateTime.Utc) => BigInt(d.epochMilliseconds)),
  }),
)

const POSITIONS: ReadonlyArray<
  readonly [string, Schema.Top, ReadonlyArray<readonly [unknown, unknown]>]
> = [
  [
    "an Option",
    Schema.Option(Schema.BigInt),
    [
      [some(5), Option.some(5n)],
      [some(0), Option.some(0n)],
      [some(-5), Option.some(-5n)],
      [some(past2to53), Option.some(past2to53)],
      [none, Option.none()],
    ],
  ],
  [
    "an Option with a check",
    Schema.Option(Schema.BigInt.check(Schema.isGreaterThanBigInt(0n))),
    [[some(5), Option.some(5n)]],
  ],
  [
    "a branded one",
    Schema.Option(Schema.BigInt.pipe(Schema.brand("B"))),
    [[some(5), Option.some(5n)]],
  ],
  [
    "an Option of a bigint or null",
    Schema.Option(Schema.NullOr(Schema.BigInt)),
    [
      [some(5), Option.some(5n)],
      [some(null), Option.some(null)],
    ],
  ],
  [
    "an Option of a bigint or a string",
    Schema.Option(Schema.Union([Schema.String, Schema.BigInt])),
    [
      [some(5), Option.some(5n)],
      [some("s"), Option.some("s")],
    ],
  ],
  [
    "an Option of a list",
    Schema.Option(Schema.Array(Schema.BigInt)),
    [[some([5, past2to53]), Option.some([5n, past2to53])]],
  ],
  [
    "an Option of a struct",
    Schema.Option(Schema.Struct({ b: Schema.BigInt })),
    [[some({ b: 5 }), Option.some({ b: 5n })]],
  ],
  [
    "an Option of a tuple",
    Schema.Option(Schema.Tuple([Schema.BigInt, Schema.String])),
    [[some([5, "x"]), Option.some([5n, "x"])]],
  ],
  [
    "an Option of a record",
    Schema.Option(Schema.Record(Schema.String, Schema.BigInt)),
    [[some({ k: 5 }), Option.some({ k: 5n })]],
  ],
  [
    "two Options",
    Schema.Option(Schema.Option(Schema.BigInt)),
    [[some(some(5)), Option.some(Option.some(5n))]],
  ],
  [
    "a suspend in an Option",
    Schema.Option(Schema.suspend(() => Schema.BigInt)),
    [[some(5), Option.some(5n)]],
  ],
  [
    "an Option or null",
    Schema.NullOr(Schema.Option(Schema.BigInt)),
    [
      [some(5), Option.some(5n)],
      [null, null],
    ],
  ],
  [
    "a list of them",
    Schema.Array(Schema.Option(Schema.BigInt)),
    [
      [
        [some(5), none],
        [Option.some(5n), Option.none()],
      ],
    ],
  ],
  [
    "a struct's",
    Schema.Struct({ o: Schema.Option(Schema.BigInt) }),
    [[{ o: some(5) }, { o: Option.some(5n) }]],
  ],
  [
    "an optional one",
    Schema.Struct({ o: Schema.optional(Schema.Option(Schema.BigInt)) }),
    [
      [{ o: some(5) }, { o: Option.some(5n) }],
      [{}, {}],
    ],
  ],
  [
    "an optional key's",
    Schema.Struct({ o: Schema.optionalKey(Schema.Option(Schema.BigInt)) }),
    [
      [{ o: some(5) }, { o: Option.some(5n) }],
      [{}, {}],
    ],
  ],
  [
    "one with a decoding default",
    Schema.Struct({
      o: Schema.Option(Schema.BigInt).pipe(
        Schema.withDecodingDefaultKey(Effect.succeed(Option.none<bigint>())),
      ),
    }),
    [
      [{ o: some(5) }, { o: Option.some(5n) }],
      [{}, { o: Option.none() }],
    ],
  ],
  [
    "a record's",
    Schema.Record(Schema.String, Schema.Option(Schema.BigInt)),
    [[{ k: some(5) }, { k: Option.some(5n) }]],
  ],
  [
    "a tuple's",
    Schema.Tuple([Schema.Option(Schema.BigInt), Schema.String]),
    [
      [
        [some(5), "x"],
        [Option.some(5n), "x"],
      ],
    ],
  ],
  [
    "a Result's success",
    Schema.Result(Schema.BigInt, Schema.String),
    [
      [success(5), Result.succeed(5n)],
      [failure("e"), Result.fail("e")],
    ],
  ],
  [
    "a Result's failure",
    Schema.Result(Schema.String, Schema.BigInt),
    [[failure(5), Result.fail(5n)]],
  ],
  ["a set", Schema.ReadonlySet(Schema.BigInt), [[new Set([5]), new Set([5n])]]],
  [
    "a set in an Option",
    Schema.Option(Schema.ReadonlySet(Schema.BigInt)),
    [[some(new Set([5])), Option.some(new Set([5n]))]],
  ],
  [
    "a suspend",
    Schema.suspend(() => Schema.BigInt),
    [
      [5, 5n],
      [past2to53, past2to53],
    ],
  ],
  [
    "a suspended bigint or null",
    Schema.suspend(() => Schema.NullOr(Schema.BigInt)),
    [
      [5, 5n],
      [null, null],
    ],
  ],
  [
    "a suspended struct",
    Schema.suspend(() => Schema.Struct({ b: Schema.BigInt })),
    [[{ b: 5 }, { b: 5n }]],
  ],
  ["a suspended list", Schema.suspend(() => Schema.Array(Schema.BigInt)), [[[5], [5n]]]],
  ["a list of suspends", Schema.Array(Schema.suspend(() => Schema.BigInt)), [[[5], [5n]]]],
  [
    "a recursive schema, all the way down",
    Tree,
    [
      [{ n: 5 }, { n: 5n }],
      [
        { n: 5, next: { n: 6, next: { n: past2to53 } } },
        { n: 5n, next: { n: 6n, next: { n: past2to53 } } },
      ],
    ],
  ],
  [
    "Schema.DurationFromNanos",
    Schema.DurationFromNanos,
    [
      [5, nanos(5n)],
      [past2to53, nanos(past2to53)],
    ],
  ],
  [
    "Schema.OptionFromNullOr",
    Schema.OptionFromNullOr(Schema.BigInt),
    [
      [5, Option.some(5n)],
      [null, Option.none()],
    ],
  ],
  ["your own to a number", toNumber, [[5, 5]]],
  ["your own to a date", dateFromBigInt, [[5, DateTime.makeUnsafe(5)]]],
  [
    "one or null",
    Schema.NullOr(Schema.DurationFromNanos),
    [
      [5, nanos(5n)],
      [null, null],
    ],
  ],
  ["a list of them", Schema.Array(Schema.DurationFromNanos), [[[5], [nanos(5n)]]]],
  ["a struct's", Schema.Struct({ d: Schema.DurationFromNanos }), [[{ d: 5 }, { d: nanos(5n) }]]],
  [
    "one in an Option",
    Schema.Option(Schema.DurationFromNanos),
    [[some(5), Option.some(nanos(5n))]],
  ],
  ["a suspended one", Schema.suspend(() => Schema.DurationFromNanos), [[5, nanos(5n)]]],
  [
    "a struct over a struct",
    Schema.Struct({ a: Schema.BigInt }).pipe(
      Schema.decodeTo(Schema.Struct({ b: Schema.BigInt }), {
        decode: SchemaGetter.transform(({ a }: { readonly a: bigint }) => ({ b: a })),
        encode: SchemaGetter.transform(({ b }: { readonly b: bigint }) => ({ a: b })),
      }),
    ),
    [[{ a: 5 }, { b: 5n }]],
  ],
]

const readerOf = (schema: Schema.Top, options: (typeof READS)[number][1]) =>
  Schema.decodeUnknownSync(substituteSchemaDeep(schema, options) as Schema.Codec<any, unknown>)

describe("a bigint the substitution can't walk to", () => {
  for (const [owner, options] of READS) {
    describe(`read by ${owner}`, () => {
      for (const [name, schema, rows] of POSITIONS) {
        it(`reaches ${name}`, () => {
          for (const [stored, read] of rows) expect(readerOf(schema, options)(stored)).toEqual(read)
        })
      }

      it("a value that isn't a stored bigint is still refused", () => {
        for (const value of [5.5, Number.MAX_SAFE_INTEGER + 1, "5", {}]) {
          expect(() => readerOf(Schema.Option(Schema.BigInt), options)(some(value))).toThrow()
          expect(() =>
            readerOf(
              Schema.suspend(() => Schema.BigInt),
              options,
            )(value),
          ).toThrow()
          expect(() => readerOf(Schema.DurationFromNanos, options)(value)).toThrow()
        }
      })

      it("a check still judges what's lifted", () => {
        const checked = Schema.Option(Schema.BigInt.check(Schema.isGreaterThanBigInt(0n)))
        expect(() => readerOf(checked, options)(some(-5))).toThrow()
      })

      it("every member of a union it's in gets its try as declared first", () => {
        const reader = readerOf(
          Schema.Union([Schema.Option(Schema.BigInt), Schema.Option(Schema.Number)]),
          options,
        )
        expect(reader(some(5))).toEqual(Option.some(5))
        expect(reader(some(past2to53))).toEqual(Option.some(past2to53))
      })

      it("a number no member takes is lifted", () => {
        const reader = readerOf(
          Schema.Union([Schema.Option(Schema.BigInt), Schema.String]),
          options,
        )
        expect(reader(some(5))).toEqual(Option.some(5n))
        expect(reader("s")).toBe("s")
      })

      it("a suspended member gets its try too", () => {
        const reader = readerOf(
          Schema.Union([Schema.suspend(() => Schema.BigInt), Schema.Number]),
          options,
        )
        expect(reader(5)).toBe(5)
        expect(reader(past2to53)).toBe(past2to53)
      })

      it("a transformation that's a member gets its try too", () => {
        const reader = readerOf(Schema.Union([Schema.DurationFromNanos, Schema.Number]), options)
        expect(reader(5)).toBe(5)
        expect(reader(past2to53)).toEqual(nanos(past2to53))
      })

      it("a transformation to a date that's a member reads its number", () => {
        const reader = readerOf(Schema.Union([dateFromBigInt, Schema.String]), options)
        expect(reader(5)).toEqual(DateTime.makeUnsafe(5))
        expect(reader("s")).toBe("s")
      })

      it("what a struct field holds is rebuilt around it, not instead of it", () => {
        const reader = readerOf(
          Schema.Struct({ o: Schema.Option(Schema.BigInt), s: Schema.String }),
          options,
        )
        expect(reader({ o: some(5), s: "x" })).toEqual({ o: Option.some(5n), s: "x" })
      })
    })
  }

  describe("a step onto another type, over an optional stored side", () => {
    for (const [owner, options] of READS.slice(0, 1)) {
      it(`${owner} reads Schema.OptionFromOptionalKey's number and its absence`, () => {
        const reader = readerOf(
          Schema.Struct({ o: Schema.OptionFromOptionalKey(Schema.BigInt) }),
          options,
        )
        expect(reader({ o: 5 })).toEqual({ o: Option.some(5n) })
        expect(reader({ o: past2to53 })).toEqual({ o: Option.some(past2to53) })
        expect(reader({})).toEqual({ o: Option.none() })
      })

      it(`${owner} reads Schema.OptionFromOptional's number and its absence`, () => {
        const reader = readerOf(
          Schema.Struct({ o: Schema.OptionFromOptional(Schema.BigInt) }),
          options,
        )
        expect(reader({ o: 5 })).toEqual({ o: Option.some(5n) })
        expect(reader({})).toEqual({ o: Option.none() })
      })

      it(`${owner} reads a step over an optional side with an encoding of its own`, () => {
        const nested = Schema.optionalKey(toNumber).pipe(
          Schema.decodeTo(Schema.Number, {
            decode: SchemaGetter.transformOptional((n) => n as Option.Option<number>),
            encode: SchemaGetter.transformOptional((n) => n as Option.Option<number>),
          }),
        )
        const reader = readerOf(Schema.Struct({ o: nested }), options)
        expect(reader({ o: 5 })).toEqual({ o: 5 })
        expect(reader({ o: past2to53 })).toEqual({ o: Number(past2to53) })
      })

      it(`${owner} reads a number on an optional stored side decoded to a number`, () => {
        const stored = Schema.optionalKey(Schema.BigInt).pipe(
          Schema.decodeTo(Schema.Number, {
            decode: SchemaGetter.transformOptional((b) => Option.map(b, (n: bigint) => Number(n))),
            encode: SchemaGetter.transformOptional((n) => Option.map(n, (b: number) => BigInt(b))),
          }),
        )
        expect(readerOf(Schema.Struct({ o: stored }), options)({ o: 5 })).toEqual({ o: 5 })
      })
    }
  })

  describe("what a read doesn't change", () => {
    it("a schema nothing is lifted in comes back as it came", () => {
      for (const schema of [
        Schema.Option(Schema.String),
        Schema.Option(Schema.Number),
        Schema.suspend(() => Schema.Struct({ a: Schema.String })),
        Schema.DurationFromMillis,
        Schema.OptionFromOptionalKey(Schema.String),
      ]) {
        for (const [, options] of READS.slice(0, 1)) {
          expect(substituteSchemaDeep(schema, options)).toBe(schema)
        }
      }
    })

    it("a write schema isn't touched: what's stored is what the schema encodes", () => {
      for (const schema of [
        Schema.Option(Schema.BigInt),
        Schema.suspend(() => Schema.BigInt),
        Schema.DurationFromNanos,
        Schema.OptionFromOptionalKey(Schema.BigInt),
        Schema.Struct({ o: Schema.Option(Schema.BigInt) }),
      ]) {
        expect(substituteSchemaDeep(schema, { enforceChecks: true })).toBe(schema)
        expect(substituteSchemaDeep(schema)).toBe(schema)
      }
    })

    it("a date under a declaration beside a bigint is read as it was", () => {
      const held = Option.getOrThrow(
        readerOf(
          Schema.Option(Schema.Struct({ b: Schema.BigInt, d: Schema.DateTimeUtc })),
          READS[0][1],
        )(
          some({
            b: 5,
            d: { epochMilliseconds: 5, "~effect/DateTime": "~effect/DateTime", _tag: "Utc" },
          }),
        ) as Option.Option<{ readonly d: object }>,
      )
      expect(Object.getPrototypeOf(held.d)).toBe(Object.prototype)
    })

    it("a union's try as declared lifts nothing", () => {
      const reader = Schema.decodeUnknownSync(
        substituteSchemaDeep(Schema.Option(Schema.BigInt), {
          legacyReads: true,
          exactBigInts: true,
        }) as Schema.Codec<any, unknown>,
      )
      expect(() => reader(some(5))).toThrow()
      expect(reader(some(past2to53))).toEqual(Option.some(past2to53))
    })
  })
})
