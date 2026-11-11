/**
 * What an aggregate's `create` and `update` decode a caller's value through. A caller holds domain
 * values, so a tolerant leaf asks its domain side first. A read asks the stored side first, because
 * that's what it's reading. Where a transformation has one type on both sides, the two differ.
 */

import { describe, expect, it } from "@effect/vitest"
import { DateTime, Effect, Exit, Option, Schema, SchemaGetter, SchemaTransformation } from "effect"
import { substituteSchemaDeep } from "../src/internal/EntitySchemas.js"

const asCreate = (schema: Schema.Top) =>
  substituteSchemaDeep(schema, {
    tolerantTransforms: true,
    decodeOnly: true,
    enforceChecks: true,
    domainValues: true,
  })
const asUpdate = (schema: Schema.Top) =>
  substituteSchemaDeep(schema, {
    tolerantTransforms: true,
    decodeOnly: true,
    enforceChecks: true,
    plainStateForms: true,
    domainValues: true,
  })
const asRead = (schema: Schema.Top) =>
  substituteSchemaDeep(schema, { tolerantTransforms: true, decodeOnly: true, absentReads: true })

const decoding = (schema: Schema.Top, value: unknown) =>
  Schema.decodeUnknownExit(schema as unknown as Schema.Codec<unknown>)(value)
const taken = (schema: Schema.Top, value: unknown) => {
  const decoded = decoding(schema, value)
  return Exit.isSuccess(decoded) ? decoded.value : "refused"
}

const X10 = Schema.Number.pipe(
  Schema.decodeTo(Schema.Number, {
    decode: SchemaGetter.transform((value) => value * 10),
    encode: SchemaGetter.transform((value) => value / 10),
  }),
)
const Bang = Schema.String.pipe(
  Schema.decodeTo(Schema.String, {
    decode: SchemaGetter.transform((value) => `${value}!`),
    encode: SchemaGetter.transform((value) => value.replace(/!$/, "")),
  }),
)
const Lower = Schema.String.pipe(Schema.decodeTo(Schema.String, SchemaTransformation.toLowerCase()))
const S = Schema.String
class Held extends Schema.Class<Held>("Held")({ x: X10 }) {}
type Tree = { readonly x: number; readonly next?: Tree }
const Tree: Schema.Codec<Tree, any> = Schema.Struct({
  x: X10,
  next: Schema.optionalKey(Schema.suspend((): Schema.Codec<Tree, any> => Tree)),
})
const field = (schema: Schema.Top) => Schema.Struct({ f: schema } as never) as unknown as Schema.Top
const asField = (read: typeof asCreate, schema: Schema.Top, value: unknown) =>
  taken(read(field(schema)), { f: value })

const OWNERS = [
  ["create", asCreate],
  ["update", asUpdate],
] as const

const POSITIONS: ReadonlyArray<readonly [string, Schema.Top, unknown]> = [
  ["a number", X10, 50],
  ["a string", Bang, "a!"],
  ["a key optional", Schema.optionalKey(X10), 50],
  ["an optional", Schema.optional(X10), 50],
  ["a nullable", Schema.NullOr(X10), 50],
  ["a union", Schema.Union([X10, S]), 50],
  ["a list", Schema.Array(X10), [50]],
  ["a record", Schema.Record(S, X10), { k: 50 }],
  ["a tuple", Schema.Tuple([X10]), [50]],
  ["a struct", Schema.Struct({ x: X10 }), { x: 50 }],
  ["a class", Held, new Held({ x: 50 })],
  ["an Option", Schema.Option(X10), Option.some(50)],
  ["an Option of a struct", Schema.Option(Schema.Struct({ x: X10 })), Option.some({ x: 50 })],
  ["a set", Schema.ReadonlySet(X10), new Set([50])],
  ["a suspend", Schema.suspend(() => X10), 50],
  ["a suspended struct", Schema.suspend(() => Schema.Struct({ x: X10 })), { x: 50 }],
  ["a recursive struct", Tree, { x: 50, next: { x: 60 } }],
  ["a default", X10.pipe(Schema.withDecodingDefaultKey(Effect.succeed(7))), 50],
  [
    "a default on a struct",
    Schema.Struct({ x: X10 }).pipe(Schema.withDecodingDefaultKey(Effect.succeed({ x: 7 }))),
    { x: 50 },
  ],
  ["a step that isn't a default", Schema.OptionFromOptional(X10), Option.some(50)],
  ["a nullable step", Schema.OptionFromNullOr(X10), Option.some(50)],
  ["base64 text", Schema.StringFromBase64, "aGVsbG8="],
  ["hex text", Schema.StringFromHex, "6869"],
  ["json text", Schema.fromJsonString(S), '"x"'],
  ["encodeKeys", Schema.Struct({ a: S }).pipe(Schema.encodeKeys({ a: "b" })), { a: "x" }],
  [
    "encodeKeys, optional",
    Schema.Struct({ a: Schema.optionalKey(S) }).pipe(Schema.encodeKeys({ a: "b" })),
    { a: "x" },
  ],
]

describe("a caller's value through an aggregate", () => {
  for (const [owner, read] of OWNERS) {
    describe(`on ${owner}`, () => {
      for (const [name, schema, value] of POSITIONS) {
        it(`${name} is the domain value`, () => {
          expect(asField(read, schema, value)).toEqual({ f: value })
        })
      }

      it("the stored form is still taken where it can't be a domain value", () => {
        expect(asField(read, Schema.NumberFromString, "5")).toEqual({ f: 5 })
        expect(asField(read, Schema.BigIntFromString, "5")).toEqual({ f: 5n })
        expect(asField(read, Schema.Trim, "  a ")).toEqual({ f: "a" })
        expect(asField(read, Schema.Option(Schema.NumberFromString), Option.some("5"))).toEqual({
          f: Option.some(5),
        })
      })

      it("a domain value of another type stays what it was", () => {
        const date = DateTime.makeUnsafe(0)
        expect(asField(read, Schema.DateTimeUtcFromString, date)).toEqual({ f: date })
        const member = Schema.Union([Schema.DateTimeUtcFromString, Schema.Number])
        expect(asField(read, member, date)).toEqual({ f: date })
        expect(asField(read, Schema.NumberFromString, 5)).toEqual({ f: 5 })
      })

      it("what both sides take comes out as a read of its stored form", () => {
        expect(asField(read, Lower, "A")).toEqual({ f: "a" })
        const trimming = S.pipe(Schema.decodeTo(S, SchemaTransformation.trim()))
        expect(asField(read, trimming, "  a ")).toEqual({ f: "a" })
      })

      it("a value only the domain side takes comes out as given", () => {
        const rounding = S.pipe(
          Schema.decodeTo(Schema.Number, {
            decode: SchemaGetter.transform((value) => Math.round(Number(value))),
            encode: SchemaGetter.transform((value) => String(value)),
          }),
        )
        expect(asField(read, rounding, 1.5)).toEqual({ f: 1.5 })
        expect(asField(read, rounding, "1.5")).toEqual({ f: 2 })
      })

      it("a value whose stored form can't be made stays what it was given", () => {
        const readOnly = S.pipe(
          Schema.decodeTo(S, {
            decode: SchemaGetter.transform((value: string) => `${value}!`),
            encode: SchemaGetter.forbidden(() => "read only"),
          }),
        )
        expect(asField(read, readOnly, "a")).toEqual({ f: "a" })
      })

      it("a marshalled date is rebuilt, not taken as it looks", () => {
        const marshalled = {
          epochMilliseconds: 0,
          _tag: "Utc",
          "~effect/DateTime": "~effect/DateTime",
        }
        for (const schema of [
          Schema.DateTimeUtcFromString,
          Schema.Union([Schema.DateTimeUtcFromString, Schema.Number]),
        ]) {
          const decoded = asField(read, schema, marshalled) as { readonly f: DateTime.Utc }
          expect(DateTime.isDateTime(decoded.f)).toBe(true)
          expect(DateTime.toEpochMillis(decoded.f)).toBe(0)
          expect(Object.getPrototypeOf(decoded.f)).not.toBe(Object.prototype)
        }
      })

      it("a transformation between dates in a union isn't applied to what it made", () => {
        const shifted = Schema.DateTimeUtc.pipe(
          Schema.decodeTo(Schema.DateTimeUtc, {
            decode: SchemaGetter.transform((value) => DateTime.add(value, { days: 1 })),
            encode: SchemaGetter.transform((value) => DateTime.subtract(value, { days: 1 })),
          }),
        )
        const date = DateTime.makeUnsafe(0)
        expect(asField(read, Schema.Union([shifted, Schema.Number]), date)).toEqual({ f: date })
      })

      it("the stored form of a step that isn't a default still reads", () => {
        expect(asField(read, Schema.OptionFromOptional(X10), 5)).toEqual({ f: Option.some(50) })
        expect(asField(read, Schema.OptionFromNullOr(X10), null)).toEqual({ f: Option.none() })
      })

      it("a default with no transformation beneath it isn't touched", () => {
        const schema = field(Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed("d"))))
        expect(read(schema)).toBe(schema)
      })

      it("nonsense is refused, wherever it sits", () => {
        for (const [schema, value] of [
          [X10, "nonsense"],
          [Bang, 5],
          [Schema.Array(X10), ["nonsense"]],
          [Schema.Struct({ x: X10 }), { x: "nonsense" }],
          [Schema.Option(X10), Option.some("nonsense")],
          [Schema.suspend(() => X10), "nonsense"],
          [Schema.BigIntFromString, "nonsense"],
          [Schema.OptionFromOptional(X10), "nonsense"],
          [Schema.OptionFromOptional(X10), Option.some("nonsense")],
          [X10.pipe(Schema.withDecodingDefaultKey(Effect.succeed(7))), "nonsense"],
        ] as const) {
          expect(asField(read, schema, value)).toBe("refused")
        }
      })

      it("a check is enforced on both sides, as an entity's is", () => {
        const long = Bang.check(Schema.isMinLength(3))
        expect(asField(read, long, "ab!")).toEqual({ f: "ab!" })
        expect(asField(read, long, "")).toBe("refused")
        // Too short as a domain value, and long enough once it's been read as a stored one.
        expect(asField(read, long, "a!")).toEqual({ f: "a!!" })
      })

      it("a default on a struct asks each of its fields, as a struct without one does", () => {
        const Fields = Schema.Struct({ a: Schema.BigIntFromString, b: Schema.NumberFromString })
        const withDefault = Fields.pipe(
          Schema.withDecodingDefaultKey(Effect.succeed({ a: "1", b: "2" })),
        )
        for (const schema of [Fields, withDefault]) {
          expect(asField(read, schema, { a: 5n, b: "7" })).toEqual({ f: { a: 5n, b: 7 } })
          expect(asField(read, schema, { a: "5", b: 7 })).toEqual({ f: { a: 5n, b: 7 } })
          expect(asField(read, schema, { a: "nonsense", b: 7 })).toBe("refused")
        }
      })

      it("a default stands for what its stored form reads as", () => {
        const absent = (schema: Schema.Top) => taken(read(field(schema)), {})
        expect(absent(X10.pipe(Schema.withDecodingDefaultKey(Effect.succeed(7))))).toEqual({
          f: 70,
        })
        expect(absent(X10.pipe(Schema.withDecodingDefault(Effect.succeed(7))))).toEqual({ f: 70 })
        expect(
          taken(read(field(X10.pipe(Schema.withDecodingDefault(Effect.succeed(7))))), {
            f: undefined,
          }),
        ).toEqual({ f: 70 })
        expect(
          absent(
            Schema.Struct({ x: X10 }).pipe(Schema.withDecodingDefaultKey(Effect.succeed({ x: 7 }))),
          ),
        ).toEqual({ f: { x: 70 } })
        expect(
          absent(Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed("d")))),
        ).toEqual({
          f: "d",
        })
        expect(absent(Schema.OptionFromOptional(X10))).toEqual({ f: Option.none() })
        // A step takes it as a default does.
        expect(taken(read(field(Schema.OptionFromOptional(X10))), { f: undefined })).toEqual({
          f: Option.none(),
        })
        // Only a default that takes `undefined` stands for it.
        expect(
          taken(read(field(X10.pipe(Schema.withDecodingDefaultKey(Effect.succeed(7))))), {
            f: undefined,
          }),
        ).toBe("refused")
      })
    })
  }

  describe("what a mutation hands back from its plain state", () => {
    it("an Option as a tagged object", () => {
      expect(asField(asUpdate, Schema.Option(X10), { _tag: "Some", value: 50 })).toEqual({
        f: Option.some(50),
      })
      expect(
        asField(asUpdate, Schema.OptionFromOptional(X10), { _tag: "Some", value: 50 }),
      ).toEqual({
        f: Option.some(50),
      })
    })

    it("only a mutation's plain state, not a create's input", () => {
      const tagged = { _tag: "Some", value: 50 }
      expect(asField(asCreate, Schema.Option(X10), tagged)).toBe("refused")
      expect(asField(asCreate, Schema.OptionFromOptional(X10), tagged)).toBe("refused")
      expect(asField(asCreate, Schema.ReadonlySet(X10), [50])).toBe("refused")
    })

    it("a set as a list", () => {
      expect(asField(asUpdate, Schema.ReadonlySet(X10), [50])).toEqual({ f: new Set([50]) })
    })

    it("a set under a Schema.suspend, as a list", () => {
      const schema = Schema.suspend(() => Schema.Struct({ s: Schema.ReadonlySet(S) }))
      expect(asField(asUpdate, schema, { s: ["a"] })).toEqual({ f: { s: new Set(["a"]) } })
      expect(asField(asCreate, schema, { s: ["a"] })).toBe("refused")
    })
  })

  describe("a read", () => {
    it("still takes what's stored as stored", () => {
      for (const [schema, stored, value] of [
        [X10, 5, 50],
        [Bang, "a", "a!"],
        [Schema.Array(X10), [5], [50]],
        [Schema.Struct({ x: X10 }), { x: 5 }, { x: 50 }],
        [Schema.Option(X10), Option.some(5), Option.some(50)],
        [Schema.suspend(() => X10), 5, 50],
      ] as const) {
        expect(taken(asRead(field(schema)), { f: stored })).toEqual({ f: value })
      }
    })

    it("still reads a default through the field", () => {
      const schema = X10.pipe(Schema.withDecodingDefaultKey(Effect.succeed(7)))
      expect(taken(asRead(field(schema)), {})).toEqual({ f: 70 })
    })

    it("still reads a step that isn't a default as declared", () => {
      for (const [schema, stored, value] of [
        [X10, 5, 50],
        [Schema.DateTimeUtcFromString, "1970-01-01T00:00:00.000Z", DateTime.makeUnsafe(0)],
        [Schema.BigIntFromString, "5", 5n],
        [Schema.NumberFromString, "5", 5],
      ] as const) {
        const step = field(Schema.OptionFromOptional(schema as Schema.Codec<unknown, unknown>))
        expect(taken(asRead(step), {})).toEqual({ f: Option.none() })
        expect(taken(asRead(step), { f: stored })).toEqual({ f: Option.some(value) })
      }
    })
  })
})

describe("what a mutation's plain state holds, inside what a transformation decodes to", () => {
  const SetS = Schema.ReadonlySet(S)
  const from = (to: Schema.Top) =>
    S.pipe(
      Schema.decodeTo(
        to as Schema.Codec<any, any>,
        {
          decode: SchemaGetter.forbidden(() => "never read in these tests"),
          encode: SchemaGetter.forbidden(() => "never read in these tests"),
        } as never,
      ),
    ) as unknown as Schema.Top

  for (const [name, to, plain, read] of [
    ["at the top", SetS, ["a"], new Set(["a"])],
    ["in a list", Schema.Array(SetS), [["a"]], [new Set(["a"])]],
    ["in a tuple", Schema.Tuple([SetS]), [["a"]], [new Set(["a"])]],
    [
      "in a tuple's rest",
      Schema.TupleWithRest(Schema.Tuple([S]), [SetS]),
      ["s", ["a"]],
      ["s", new Set(["a"])],
    ],
    ["in a struct", Schema.Struct({ y: SetS }), { y: ["a"] }, { y: new Set(["a"]) }],
    ["in a record", Schema.Record(S, SetS), { k: ["a"] }, { k: new Set(["a"]) }],
    ["in a union", Schema.Union([Schema.Number, SetS]), ["a"], new Set(["a"])],
    ["a class", Schema.Array(Schema.toType(Held)), [{ x: 50 }], [new Held({ x: 50 })]],
  ] as const) {
    it(`${name}: update takes it`, () => {
      expect(asField(asUpdate, from(to), plain)).toEqual({ f: read })
    })
    it(`${name}: create and a read don't`, () => {
      expect(asField(asCreate, from(to), plain)).toBe("refused")
      expect(asField(asRead, from(to), plain)).toBe("refused")
    })
  }

  it("what holds no such thing has no plain form to ask", () => {
    expect(asField(asUpdate, from(Schema.Struct({ y: S })), { y: 5 })).toBe("refused")
    expect(asField(asUpdate, from(Schema.Array(S)), [5])).toBe("refused")
  })

  it("a set held as a list is asked as the plain state before it's asked as what's stored", () => {
    const SetFromListX10 = Schema.Array(Schema.Number).pipe(
      Schema.decodeTo(Schema.ReadonlySet(Schema.Number), {
        decode: SchemaGetter.transform(
          (list: ReadonlyArray<number>) => new Set(list.map((x) => x * 10)),
        ),
        encode: SchemaGetter.transform((set: ReadonlySet<number>) => [...set].map((x) => x / 10)),
      }),
    )
    expect(asField(asUpdate, SetFromListX10, [50])).toEqual({ f: new Set([50]) })
    expect(
      asField(
        asUpdate,
        Schema.suspend(() => SetFromListX10),
        [50],
      ),
    ).toEqual({
      f: new Set([50]),
    })
    expect(asField(asCreate, SetFromListX10, [50])).toEqual({ f: new Set([500]) })
    expect(asField(asRead, SetFromListX10, [50])).toEqual({ f: new Set([500]) })
  })
})
