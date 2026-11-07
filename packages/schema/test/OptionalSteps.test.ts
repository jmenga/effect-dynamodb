/**
 * A step encoded as optional that isn't a default, such as `Schema.OptionFromOptional`. What's beneath
 * it, the type side, isn't what's stored, so a read leaves it as declared, and a caller, who holds what
 * the step makes, goes round it.
 */

import { describe, expect, it } from "@effect/vitest"
import { DateTime, Effect, Exit, Option, Schema, SchemaGetter, SchemaTransformation } from "effect"
import { substituteSchemaDeep } from "../src/internal/EntitySchemas.js"

const asRead = (schema: Schema.Top) =>
  substituteSchemaDeep(schema, { tolerantTransforms: true, decodeOnly: true, absentReads: true })
const asEntityRead = (schema: Schema.Top) => substituteSchemaDeep(schema, { legacyReads: true })
const asEncoder = (schema: Schema.Top) => substituteSchemaDeep(schema, { tolerantTransforms: true })
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

const field = (schema: Schema.Top) => Schema.Struct({ f: schema } as never) as unknown as Schema.Top
const decoded = (schema: Schema.Top, value: unknown) => {
  const exit = Schema.decodeUnknownExit(schema as unknown as Schema.Codec<unknown>)(value)
  return Exit.isSuccess(exit) ? exit.value : "refused"
}
const encoded = (schema: Schema.Top, value: unknown) => {
  const exit = Schema.encodeUnknownExit(schema as unknown as Schema.Codec<unknown, unknown>)(value)
  return Exit.isSuccess(exit) ? exit.value : "refused"
}

const B = Schema.BigIntFromString
const toList = Schema.optionalKey(B).pipe(
  Schema.decodeTo(Schema.Array(Schema.BigInt), {
    decode: SchemaGetter.transformOptional((value) =>
      Option.some(Option.match(value, { onNone: () => [], onSome: (one: bigint) => [one] })),
    ),
    encode: SchemaGetter.transformOptional((value) =>
      Option.flatMap(value, (list: ReadonlyArray<bigint>) =>
        list.length > 0 ? Option.some(list[0]!) : Option.none(),
      ),
    ),
  }),
)
const STEPS: ReadonlyArray<readonly [string, Schema.Top, unknown, unknown, unknown]> = [
  [
    "OptionFromOptional over a bigint",
    Schema.OptionFromOptional(B),
    "5",
    Option.some(5n),
    Option.none(),
  ],
  [
    "OptionFromOptionalKey over a bigint",
    Schema.OptionFromOptionalKey(B),
    "5",
    Option.some(5n),
    Option.none(),
  ],
  [
    "OptionFromOptional over a struct",
    Schema.OptionFromOptional(Schema.Struct({ b: B })),
    { b: "5" },
    Option.some({ b: 5n }),
    Option.none(),
  ],
  [
    "OptionFromOptional over a list",
    Schema.OptionFromOptional(Schema.Array(B)),
    ["5"],
    Option.some([5n]),
    Option.none(),
  ],
  ["a step to a list of bigints", toList, "5", [5n], []],
  [
    "OptionFromOptional over a number text",
    Schema.OptionFromOptional(Schema.NumberFromString),
    "5",
    Option.some(5),
    Option.none(),
  ],
  [
    "OptionFromOptional over a date",
    Schema.OptionFromOptional(Schema.DateTimeUtcFromString),
    "1970-01-01T00:00:00.000Z",
    Option.some(DateTime.makeUnsafe(0)),
    Option.none(),
  ],
  [
    "OptionFromOptional over a string",
    Schema.OptionFromOptional(Schema.String),
    "x",
    Option.some("x"),
    Option.none(),
  ],
]

describe("what has nothing to substitute", () => {
  it("is left as it is where nothing lifts a bigint", () => {
    const Model = Schema.Struct({ f: Schema.OptionFromOptionalKey(Schema.BigInt) })
    expect(substituteSchemaDeep(Model)).toBe(Model)
  })
  it("doesn't take a number for a bigint beneath a step, from a caller", () => {
    const create = asCreate(Schema.Struct({ f: Schema.OptionFromOptionalKey(Schema.BigInt) }))
    expect(decoded(create, { f: Option.some(5n) })).toEqual({ f: Option.some(5n) })
    expect(decoded(create, { f: 5n })).toEqual({ f: Option.some(5n) })
    expect(decoded(create, { f: 5 })).toEqual("refused")
  })
  it("keeps a default's own encoding", () => {
    const when = new Date(0)
    const Model = Schema.Struct({
      f: Schema.Date.pipe(
        Schema.withDecodingDefaultKey(Effect.succeed(when), { encodingStrategy: "omit" }),
      ),
    })
    expect(encoded(asEncoder(Model), { f: when })).toEqual({})
  })
})

describe("a step encoded as optional that isn't a default", () => {
  for (const [name, schema, stored, value, none] of STEPS) {
    describe(name, () => {
      const asField = field(schema)

      for (const [owner, read] of [
        ["an aggregate's read", asRead],
        ["an entity's read", asEntityRead],
      ] as const) {
        it(`${owner} takes what's stored`, () => {
          expect(decoded(read(asField), { f: stored })).toEqual({ f: value })
        })

        it(`${owner} reads absent as the step does`, () => {
          expect(decoded(read(asField), {})).toEqual({ f: none })
        })

        it(`${owner} refuses what the step makes, as stored`, () => {
          expect(decoded(read(asField), { f: value })).toBe("refused")
        })
      }

      it("stores what's stored", () => {
        expect(encoded(asEncoder(asField), { f: value })).toEqual({ f: stored })
      })

      it("stores nothing for what stands for absent", () => {
        const absent = encoded(asEncoder(asField), { f: none })
        expect((absent as { readonly f?: unknown }).f).toBeUndefined()
      })

      for (const [owner, take] of [
        ["create", asCreate],
        ["update", asUpdate],
      ] as const) {
        it(`${owner} takes what the step makes`, () => {
          expect(decoded(take(asField), { f: value })).toEqual({ f: value })
          expect(decoded(take(asField), { f: none })).toEqual({ f: none })
        })

        it(`${owner} takes what's stored`, () => {
          expect(decoded(take(asField), { f: stored })).toEqual({ f: value })
        })

        it(`${owner} reads absent as the step does`, () => {
          expect(decoded(take(asField), {})).toEqual({ f: none })
        })

        it(`${owner} refuses nonsense`, () => {
          expect(decoded(take(asField), { f: { nonsense: true } })).toBe("refused")
          expect(decoded(take(asField), { f: Option.some({ nonsense: true }) })).toBe("refused")
        })
      }
    })
  }

  it("takes undefined as absent where the step does", () => {
    const schema = field(Schema.OptionFromOptional(B))
    expect(decoded(asCreate(schema), { f: undefined })).toEqual({ f: Option.none() })
    expect(decoded(asRead(schema), { f: undefined })).toEqual({ f: Option.none() })
  })

  it("refuses undefined where the step doesn't", () => {
    const schema = field(Schema.OptionFromOptionalKey(B))
    expect(decoded(asCreate(schema), { f: undefined })).toBe("refused")
    expect(decoded(asRead(schema), { f: undefined })).toBe("refused")
  })

  it("only an update takes the form a plain state holds it as", () => {
    const schema = field(Schema.OptionFromOptional(B))
    const tagged = { _tag: "Some", value: 5n }
    expect(decoded(asUpdate(schema), { f: tagged })).toEqual({ f: Option.some(5n) })
    expect(decoded(asCreate(schema), { f: tagged })).toBe("refused")
    expect(decoded(asRead(schema), { f: tagged })).toBe("refused")
  })

  it("a read of a plain bigint beneath the step still lifts it", () => {
    for (const step of [Schema.OptionFromOptional, Schema.OptionFromOptionalKey] as const) {
      const schema = field(step(Schema.BigInt))
      expect(decoded(asRead(schema), { f: 5 })).toEqual({ f: Option.some(5n) })
      expect(decoded(asRead(schema), {})).toEqual({ f: Option.none() })
    }
  })

  it("a default is still a default", () => {
    const schema = field(B.pipe(Schema.withDecodingDefaultKey(Effect.succeed("7"))))
    expect(decoded(asRead(schema), {})).toEqual({ f: 7n })
    expect(decoded(asRead(schema), { f: "5" })).toEqual({ f: 5n })
    expect(decoded(asCreate(schema), {})).toEqual({ f: 7n })
    expect(decoded(asCreate(schema), { f: 5n })).toEqual({ f: 5n })
  })

  it("nothing to substitute leaves the schema as it was", () => {
    const schema = field(Schema.OptionFromOptional(Schema.String))
    expect(asRead(schema)).toBe(schema)
    expect(asEntityRead(schema)).toBe(schema)
  })
})

describe("a step from an optional tuple to another tuple isn't a decoding default", () => {
  const step = (
    from: Schema.Top,
    to: Schema.Top,
    decode: (value: any) => unknown,
    encode: (value: any) => unknown,
  ) =>
    Schema.optionalKey(from as Schema.Codec<any>).pipe(
      Schema.decodeTo(to as Schema.Codec<any>, {
        decode: SchemaGetter.transformOptional((value) => Option.map(value, decode)),
        encode: SchemaGetter.transformOptional((value) => Option.map(value, encode)),
      }),
    ) as unknown as Schema.Top
  it("reads a tuple of bigints decoded to a tuple of strings through the step", () => {
    const ToText = step(
      Schema.Tuple([Schema.BigInt]),
      Schema.Tuple([Schema.String]),
      ([b]: readonly [bigint]) => [String(b)],
      ([t]: readonly [string]) => [BigInt(t)],
    )
    expect(decoded(field(asRead(ToText)), { f: [5] })).toEqual({ f: ["5"] })
    expect(decoded(field(asEntityRead(ToText)), { f: [5] })).toEqual({ f: ["5"] })
  })
  it("reads a pair decoded to one through the step", () => {
    const ToOne = step(
      Schema.Tuple([Schema.BigInt, Schema.BigInt]),
      Schema.Tuple([Schema.BigInt]),
      ([a, b]: readonly [bigint, bigint]) => [a + b],
      ([a]: readonly [bigint]) => [a, 0n],
    )
    expect(decoded(field(asRead(ToOne)), { f: [2, 3] })).toEqual({ f: [5n] })
    expect(decoded(field(asEntityRead(ToOne)), { f: [2, 3] })).toEqual({ f: [5n] })
  })
})

describe("a union member holding a step", () => {
  const BigintsToText = Schema.optionalKey(Schema.BigInt).pipe(
    Schema.decodeTo(Schema.String, {
      decode: SchemaGetter.transformOptional((value) =>
        Option.some(Option.match(value, { onNone: () => "", onSome: (b: bigint) => String(b) })),
      ),
      encode: SchemaGetter.transformOptional((value) =>
        Option.flatMap(value, (text: string) =>
          text === "" ? Option.none() : Option.some(BigInt(text)),
        ),
      ),
    }),
  )
  it("leaves a row to a later member, when the step holds a plain bigint on its stored side", () => {
    const Beside = Schema.Union([
      Schema.Struct({ a: Schema.OptionFromOptionalKey(Schema.BigInt) }),
      Schema.Struct({ a: Schema.Number }),
    ])
    expect(decoded(asRead(Beside), { a: 5 })).toEqual({ a: 5 })
  })
  it("looks at what the step stores, not what it makes", () => {
    const Beside = Schema.Union([
      Schema.Struct({ a: BigintsToText }),
      Schema.Struct({ a: Schema.Number }),
    ])
    expect(decoded(asRead(Beside), { a: 5 })).toEqual({ a: 5 })
    expect(decoded(asRead(Beside), { a: 5n })).toEqual({ a: "5" })
  })
})

describe("a transformation between lists, or onto a list", () => {
  const mapped = (
    from: Schema.Top,
    to: Schema.Top,
    decode: (value: any) => unknown,
    encode: (value: any) => unknown,
  ) =>
    (from as Schema.Codec<any>).pipe(
      Schema.decodeTo(to as Schema.Codec<any>, {
        decode: SchemaGetter.transform((list: ReadonlyArray<unknown>) => list.map(decode)),
        encode: SchemaGetter.transform((list: ReadonlyArray<unknown>) => list.map(encode)),
      }),
    ) as Schema.Top
  const StringsToBigints = mapped(
    Schema.Array(Schema.String),
    Schema.Array(Schema.BigInt),
    (s: string) => BigInt(s),
    (b: bigint) => String(b),
  )
  const BigintsToStrings = mapped(
    Schema.Array(Schema.BigInt),
    Schema.Array(Schema.String),
    (b: bigint) => String(b),
    (s: string) => BigInt(s),
  )
  const JsonBigints = Schema.fromJsonString(Schema.Array(B))
  const StringsToNumbers = mapped(
    Schema.Array(Schema.String),
    Schema.Array(Schema.NumberFromString),
    (s: string) => s,
    (s: string) => s,
  )
  const NumbersToDates = mapped(
    Schema.Array(Schema.Number),
    Schema.Array(Schema.Date),
    (n: number) => new Date(n),
    (d: Date) => d.getTime(),
  )

  describe("an entity's read", () => {
    it("reads what a step onto bigints stored, through the step", () => {
      expect(decoded(field(asEntityRead(StringsToBigints)), { f: ["5"] })).toEqual({ f: [5n] })
    })
    it("lifts the bigints a step's stored side holds", () => {
      expect(decoded(field(asEntityRead(BigintsToStrings)), { f: [5] })).toEqual({ f: ["5"] })
    })
    it("reads a list held as JSON through the JSON", () => {
      expect(decoded(field(asEntityRead(JsonBigints)), { f: '["1"]' })).toEqual({ f: [1n] })
    })
    it("still walks a list with no bigint on either side, which a row in domain form relies on", () => {
      expect(decoded(field(asEntityRead(StringsToNumbers)), { f: [5] })).toEqual({ f: [5] })
    })
    it("still walks a list whose elements read what's stored themselves", () => {
      const OverItself = (Schema.Array(B) as unknown as Schema.Codec<any>).pipe(
        Schema.decodeTo(Schema.Array(B) as never, SchemaTransformation.passthrough() as never),
      ) as unknown as Schema.Top
      expect(decoded(field(asEntityRead(OverItself)), { f: ["5"] })).toEqual({ f: [5n] })
      const ToElements = (Schema.Array(Schema.String) as Schema.Top as Schema.Codec<any>).pipe(
        Schema.decodeTo(Schema.Array(B) as never, SchemaTransformation.passthrough() as never),
      ) as unknown as Schema.Top
      expect(decoded(field(asEntityRead(ToElements)), { f: ["5"] })).toEqual({ f: [5n] })
    })
    it("still walks a list a write walks, whatever it's stored as", () => {
      const Json = Schema.fromJsonString(Schema.Array(Schema.Date))
      const iso = new Date(0).toISOString()
      expect(decoded(field(asEntityRead(Json)), { f: [iso] })).toEqual({ f: [new Date(0)] })
    })
    it("still walks a list a write walks, whose step never runs", () => {
      expect(
        decoded(field(asEntityRead(NumbersToDates)), { f: [new Date(0).toISOString()] }),
      ).toEqual({ f: [new Date(0)] })
    })
    it("leaves a list with nothing to read differently as it is", () => {
      const Plain = mapped(
        Schema.Array(Schema.String),
        Schema.Array(Schema.Number),
        (s: string) => Number(s),
        (n: number) => String(n),
      )
      expect(asEntityRead(Plain)).toBe(Plain)
    })
  })

  describe("an aggregate", () => {
    it("walks a list whose elements are substituted, so what's stored is what 1.39.0 stored", () => {
      expect(encoded(field(asEncoder(NumbersToDates)), { f: [new Date(0)] })).toEqual({
        f: [new Date(0).toISOString()],
      })
      expect(encoded(field(asEncoder(StringsToBigints)), { f: [5n] })).toEqual({ f: [5n] })
      expect(encoded(field(asEncoder(JsonBigints)), { f: [1n] })).toEqual({ f: ["1"] })
    })
    it("takes either side of a list with nothing to substitute", () => {
      const Plain = mapped(
        Schema.Array(Schema.String),
        Schema.Array(Schema.Number),
        (s: string) => Number(s),
        (n: number) => String(n),
      )
      const read = field(asRead(Plain))
      expect(decoded(read, { f: ["5"] })).toEqual({ f: [5] })
      expect(decoded(read, { f: [5] })).toEqual({ f: [5] })
    })
    it("takes a step onto a tuple with a rest as a whole, on either side", () => {
      const WithRest = (Schema.Array(Schema.String) as unknown as Schema.Codec<any>).pipe(
        Schema.decodeTo(
          Schema.TupleWithRest(Schema.Tuple([Schema.String]), [Schema.Date]) as never,
          {
            decode: SchemaGetter.transform(([a, ...rest]: ReadonlyArray<string>) => [
              a,
              ...rest.map((iso) => new Date(iso)),
            ]),
            encode: SchemaGetter.transform(([a, ...rest]: ReadonlyArray<any>) => [
              a,
              ...rest.map((date: Date) => date.toISOString()),
            ]),
          } as never,
        ),
      ) as unknown as Schema.Top
      const read = field(asRead(WithRest))
      const iso = new Date(0).toISOString()
      expect(decoded(read, { f: ["a", iso] })).toEqual({ f: ["a", new Date(0)] })
      expect(decoded(read, { f: ["a", new Date(0)] })).toEqual({ f: ["a", new Date(0)] })
    })
    it("takes a tuple's step as a whole, on either side", () => {
      const Pair = Schema.Tuple([Schema.Number]).pipe(
        Schema.decodeTo(Schema.Tuple([Schema.Date]), {
          decode: SchemaGetter.transform(([n]: readonly [number]) => [new Date(n)] as const),
          encode: SchemaGetter.transform(([d]: readonly [Date]) => [d.getTime()] as const),
        }),
      )
      const read = field(asRead(Pair))
      expect(decoded(read, { f: [0] })).toEqual({ f: [new Date(0)] })
      expect(decoded(read, { f: [new Date(0)] })).toEqual({ f: [new Date(0)] })
      expect(encoded(field(asEncoder(Pair)), { f: [new Date(0)] })).toEqual({ f: [0] })
    })
  })

  describe("a step from an optional list to a list of something else isn't a decoding default", () => {
    const ToListOfLists = Schema.optionalKey(Schema.Array(Schema.BigInt)).pipe(
      Schema.decodeTo(Schema.Array(Schema.Array(Schema.BigInt)), {
        decode: SchemaGetter.transformOptional((value) =>
          Option.some(
            Option.match(value, {
              onNone: () => [],
              onSome: (one: ReadonlyArray<bigint>) => [one],
            }),
          ),
        ),
        encode: SchemaGetter.transformOptional((value) =>
          Option.flatMap(value, (list: ReadonlyArray<ReadonlyArray<bigint>>) =>
            list.length > 0 ? Option.some(list[0]!) : Option.none(),
          ),
        ),
      }),
    )
    it("reads what's stored through the step", () => {
      expect(decoded(field(asEntityRead(ToListOfLists)), { f: [5] })).toEqual({ f: [[5n]] })
      expect(decoded(field(asRead(ToListOfLists)), { f: [5] })).toEqual({ f: [[5n]] })
      expect(decoded(field(asEntityRead(ToListOfLists)), {})).toEqual({ f: [] })
    })
    it("takes what it reads an absent field as for a domain value, not a stored one", () => {
      const create = field(asCreate(ToListOfLists))
      expect(decoded(create, {})).toEqual({ f: [] })
      const OverUnknown = Schema.optionalKey(Schema.Unknown).pipe(
        Schema.decodeTo(Schema.Array(Schema.Unknown), {
          decode: SchemaGetter.transformOptional((value) =>
            Option.some(Option.match(value, { onNone: () => [], onSome: (one: unknown) => [one] })),
          ),
          encode: SchemaGetter.transformOptional((value) =>
            Option.flatMap(value, (list: ReadonlyArray<unknown>) =>
              list.length > 0 ? Option.some(list[0]) : Option.none(),
            ),
          ),
        }),
      )
      expect(decoded(field(asCreate(OverUnknown)), {})).toEqual({ f: [] })
      expect(decoded(field(asCreate(Schema.OptionFromOptional(Schema.Unknown))), {})).toEqual({
        f: Option.none(),
      })
    })
    it("still sees a decoding default on a list as one", () => {
      const Defaulted = Schema.Array(Schema.BigInt).pipe(
        Schema.withDecodingDefault(Effect.succeed([1n])),
      )
      expect(decoded(field(asEntityRead(Defaulted)), { f: [5] })).toEqual({ f: [5n] })
      expect(decoded(field(asEntityRead(Defaulted)), {})).toEqual({ f: [1n] })
    })
  })
})

describe("a plain bigint under an optional key, when it's lifted", () => {
  it("stays optional when nothing's there to encode", () => {
    const schema = field(Schema.OptionFromOptionalKey(Schema.BigInt))
    expect(encoded(asEncoder(schema), { f: Option.none() })).toEqual({})
    expect(encoded(asEncoder(schema), { f: Option.some(5n) })).toEqual({ f: 5n })
  })

  it("stays optional inside a declaration", () => {
    const inner = Schema.Struct({ c: Schema.String, b: Schema.optionalKey(Schema.BigInt) })
    const schema = field(Schema.Option(inner))
    expect(encoded(asEncoder(schema), { f: Option.some({ c: "x" }) })).toEqual({
      f: Option.some({ c: "x" }),
    })
  })

  it("stays required where it was required", () => {
    const schema = field(Schema.Option(Schema.Struct({ b: Schema.BigInt })))
    expect(decoded(asRead(schema), { f: Option.some({}) })).toBe("refused")
    expect(encoded(asEncoder(schema), { f: Option.some({}) })).toBe("refused")
  })
})
