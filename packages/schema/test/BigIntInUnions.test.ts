/**
 * A plain `Schema.BigInt` under a union, read back: DynamoDB hands back a number below 2^53 and a
 * bigint past it, and every member gets its try as declared before a number is lifted. What's stored
 * and read back on real rows is in `effect-dynamodb`'s `connected.unreadable.test.ts`.
 */

import { Effect, Option, Schema, type SchemaAST } from "effect"
import { describe, expect, it } from "vitest"
import { optionalField, substituteSchemaDeep } from "../src/internal/EntitySchemas.js"

const big = 2n ** 60n

const READERS = [
  ["an entity's read schema", { legacyReads: true, absentReads: true }],
  ["an aggregate's read schema", { tolerantTransforms: true, decodeOnly: true, absentReads: true }],
] as const

/** What a field reads each stored value as, or `"fails"`. */
const reads = (
  options: (typeof READERS)[number][1],
  field: Schema.Top,
  stored: unknown,
): unknown => {
  const decode = Schema.decodeUnknownOption(
    substituteSchemaDeep(Schema.Struct({ f: field as never }), options) as Schema.Codec<any>,
  )
  const out = decode({ f: stored })
  return Option.isSome(out) ? (out.value as { readonly f: unknown }).f : "fails"
}

const Between = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 10 }))
const V = (value: Schema.Top) => Schema.Struct({ v: value as never })
const nullable = Schema.NullOr(Schema.BigInt)

const cases: ReadonlyArray<
  readonly [string, Schema.Top, ReadonlyArray<readonly [stored: unknown, read: unknown]>]
> = [
  [
    "a bigint or null",
    nullable,
    [
      [5, 5n],
      [big, big],
      [null, null],
      [1.5, "fails"],
      ["5", "fails"],
    ],
  ],
  [
    "a bigint or undefined",
    Schema.UndefinedOr(Schema.BigInt),
    [
      [5, 5n],
      [big, big],
    ],
  ],
  [
    "a bigint, null or undefined",
    Schema.NullishOr(Schema.BigInt),
    [
      [5, 5n],
      [null, null],
    ],
  ],
  [
    "a string or a bigint",
    Schema.Union([Schema.String, Schema.BigInt]),
    [
      [5, 5n],
      [big, big],
      ["5", "5"],
      ["a", "a"],
    ],
  ],
  [
    "a bigint or a string",
    Schema.Union([Schema.BigInt, Schema.String]),
    [
      [5, 5n],
      [big, big],
      ["5", "5"],
    ],
  ],
  [
    "a checked bigint or null",
    Schema.NullOr(Schema.BigInt.check(Schema.isGreaterThanBigInt(0n))),
    [
      [5, 5n],
      [-5, "fails"],
      [null, null],
    ],
  ],
  [
    "a struct holding a bigint, or null",
    Schema.NullOr(Schema.Struct({ b: Schema.BigInt })),
    [
      [{ b: 5 }, { b: 5n }],
      [{ b: big }, { b: big }],
      [null, null],
    ],
  ],
  [
    "a list of a bigint or null",
    Schema.Array(nullable),
    [
      [
        [5, null, big],
        [5n, null, big],
      ],
    ],
  ],
  ["a record of a bigint or null", Schema.Record(Schema.String, nullable), [[{ a: 5 }, { a: 5n }]]],
  [
    "a tuple of a bigint or null",
    Schema.Tuple([nullable]),
    [
      [[5], [5n]],
      [[null], [null]],
    ],
  ],
  [
    "a list or null",
    Schema.NullOr(Schema.Array(Schema.BigInt)),
    [
      [[5], [5n]],
      [null, null],
    ],
  ],

  // A number member isn't competing with what's inside another member.
  [
    "a number, or a struct holding a bigint",
    Schema.Union([Schema.Number, Schema.Struct({ b: Schema.BigInt })]),
    [
      [{ b: 5 }, { b: 5n }],
      [{ b: big }, { b: big }],
      [7, 7],
    ],
  ],
  [
    "a struct holding a bigint, or a number",
    Schema.Union([Schema.Struct({ b: Schema.BigInt }), Schema.Number]),
    [
      [{ b: 5 }, { b: 5n }],
      [7, 7],
    ],
  ],
  [
    "a list of a struct holding a bigint, or a string",
    Schema.Array(Schema.Union([Schema.Struct({ b: Schema.BigInt }), Schema.String])),
    [
      [
        [{ b: 5 }, "a"],
        [{ b: 5n }, "a"],
      ],
    ],
  ],

  // A member that takes a number keeps what it takes, whatever the declared order.
  [
    "a number or a bigint",
    Schema.Union([Schema.Number, Schema.BigInt]),
    [
      [5, 5],
      [big, big],
    ],
  ],
  [
    "a bigint or a number",
    Schema.Union([Schema.BigInt, Schema.Number]),
    [
      [5, 5],
      [big, big],
    ],
  ],
  [
    "an int or a bigint",
    Schema.Union([Schema.Int, Schema.BigInt]),
    [
      [5, 5],
      [big, big],
    ],
  ],
  [
    "a number literal or a bigint",
    Schema.Union([Schema.Literal(5), Schema.BigInt]),
    [
      [5, 5],
      [6, 6n],
      [big, big],
    ],
  ],
  [
    "a bigint or a number literal",
    Schema.Union([Schema.BigInt, Schema.Literal(5)]),
    [
      [5, 5],
      [6, 6n],
    ],
  ],
  [
    "a number in a range or a bigint",
    Schema.Union([Between, Schema.BigInt]),
    [
      [5, 5],
      [50, 50n],
      [big, big],
    ],
  ],
  [
    "a struct with a bigint or a struct with a number",
    Schema.Union([V(Schema.BigInt), V(Schema.Number)]),
    [
      [{ v: 5 }, { v: 5 }],
      [{ v: big }, { v: big }],
    ],
  ],
  [
    "a struct with a number or a struct with a bigint",
    Schema.Union([V(Schema.Number), V(Schema.BigInt)]),
    [
      [{ v: 5 }, { v: 5 }],
      [{ v: big }, { v: big }],
    ],
  ],
  [
    "a struct with a bigint or a struct with a string",
    Schema.Union([V(Schema.BigInt), V(Schema.String)]),
    [
      [{ v: 5 }, { v: 5n }],
      [{ v: "a" }, { v: "a" }],
    ],
  ],
  [
    "a list of bigints or a list of numbers",
    Schema.Union([Schema.Array(Schema.BigInt), Schema.Array(Schema.Number)]),
    [[[5], [5]]],
  ],
  [
    "tagged structs",
    Schema.Union([
      Schema.Struct({ _tag: Schema.Literal("A"), v: Schema.BigInt }),
      Schema.Struct({ _tag: Schema.Literal("B"), v: Schema.Number }),
    ]),
    [
      [
        { _tag: "A", v: 5 },
        { _tag: "A", v: 5n },
      ],
      [
        { _tag: "B", v: 5 },
        { _tag: "B", v: 5 },
      ],
    ],
  ],

  // Nested unions: the outer union's other members come first too.
  [
    "a bigint or null, or a number",
    Schema.Union([nullable, Schema.Number]),
    [
      [5, 5],
      [big, big],
      [null, null],
    ],
  ],
  [
    "a number, or a bigint or null",
    Schema.Union([Schema.Number, nullable]),
    [
      [5, 5],
      [big, big],
      [null, null],
    ],
  ],
  [
    "a bigint or null, or a string",
    Schema.Union([nullable, Schema.String]),
    [
      [5, 5n],
      ["a", "a"],
    ],
  ],

  // Exactly one member of a `oneOf` union takes each.
  [
    "oneOf a bigint or a string",
    Schema.Union([Schema.BigInt, Schema.String], { mode: "oneOf" }),
    [
      [5, 5n],
      [big, big],
      ["a", "a"],
    ],
  ],
  [
    "oneOf a bigint or a number",
    Schema.Union([Schema.BigInt, Schema.Number], { mode: "oneOf" }),
    [
      [5, 5],
      [big, big],
    ],
  ],
  [
    "oneOf a struct with a bigint or a struct with a number",
    Schema.Union([V(Schema.BigInt), V(Schema.Number)], { mode: "oneOf" }),
    [
      [{ v: 5 }, { v: 5 }],
      [{ v: big }, { v: big }],
    ],
  ],
  [
    "a oneOf union or null",
    Schema.NullOr(Schema.Union([Schema.BigInt, Schema.String], { mode: "oneOf" })),
    [
      [5, 5n],
      ["a", "a"],
      [null, null],
    ],
  ],

  [
    "oneOf with two members taking a string and a bigint",
    Schema.Union([Schema.String, Schema.NonEmptyString, Schema.BigInt], { mode: "oneOf" }),
    [
      [5, 5n],
      ["a", "fails"],
    ],
  ],
  [
    "oneOf with a struct holding a bigint and a set an empty one of which isn't stored",
    Schema.Union(
      [Schema.Struct({ b: Schema.BigInt, tags: Schema.ReadonlySet(Schema.String) }), Schema.String],
      { mode: "oneOf" },
    ),
    [
      [{ b: 5 }, { b: 5n, tags: new Set() }],
      ["a", "a"],
    ],
  ],

  // A bigint a field down, whatever it's behind, still comes after a member taking a number.
  [
    "a struct with an optional bigint or a struct with a number",
    Schema.Union([
      Schema.Struct({ v: Schema.optional(Schema.BigInt) }),
      Schema.Struct({ v: Schema.Number }),
    ]),
    [[{ v: 5 }, { v: 5 }]],
  ],
  [
    "a struct with a bigint with a default or a struct with a number",
    Schema.Union([
      Schema.Struct({ v: Schema.BigInt.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0n))) }),
      Schema.Struct({ v: Schema.Number }),
    ]),
    [[{ v: 5 }, { v: 5 }]],
  ],
  [
    "a struct with a struct with a default holding a bigint, or the same with a number",
    Schema.Union([
      Schema.Struct({
        v: Schema.Struct({ b: Schema.BigInt }).pipe(
          Schema.withDecodingDefaultKey(Effect.succeed({ b: 0n })),
        ),
      }),
      Schema.Struct({ v: Schema.Struct({ b: Schema.Number }) }),
    ]),
    [[{ v: { b: 5 } }, { v: { b: 5 } }]],
  ],

  // Optional and defaulted.
  [
    "an optional bigint or null",
    Schema.optional(nullable),
    [
      [5, 5n],
      [big, big],
      [null, null],
    ],
  ],
  [
    "an optional key's bigint or null",
    Schema.optionalKey(nullable),
    [
      [5, 5n],
      [big, big],
      [null, null],
    ],
  ],
  [
    "an optional key's string or bigint",
    Schema.optionalKey(Schema.Union([Schema.String, Schema.BigInt])),
    [
      [5, 5n],
      ["a", "a"],
    ],
  ],
  [
    "a bigint or null with a default",
    nullable.pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
    [
      [5, 5n],
      [big, big],
      [null, null],
    ],
  ],
  [
    "a struct with a bigint with a default",
    Schema.Struct({ b: Schema.BigInt }).pipe(Schema.withDecodingDefault(Effect.succeed({ b: 1n }))),
    [[{ b: 5 }, { b: 5n }]],
  ],
  [
    "a list of a bigint or null with a default",
    Schema.Array(nullable).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
    [
      [
        [5, null],
        [5n, null],
      ],
    ],
  ],
]

describe("a Schema.BigInt under a union, read back", () => {
  for (const [reader, options] of READERS) {
    for (const [name, field, values] of cases) {
      it(`${reader}: ${name}`, () => {
        for (const [stored, read] of values) expect(reads(options, field, stored)).toEqual(read)
      })
    }

    it(`${reader}: an absent attribute takes the default`, () => {
      const decode = Schema.decodeUnknownOption(
        substituteSchemaDeep(
          Schema.Struct({
            f: nullable.pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
          }),
          options,
        ) as Schema.Codec<any>,
      )
      expect(decode({})).toEqual(Option.some({ f: null }))
    })

    it(`${reader}: a union without a bigint isn't rebuilt`, () => {
      const field = Schema.Union([Schema.String, Schema.Number])
      expect(substituteSchemaDeep(field, options)).toBe(field)
    })
  }

  it("only a member holding a bigint is tried a second time, and only where a read lifts", () => {
    const membersOf = (schema: Schema.Top) =>
      (schema as unknown as Schema.Union<any>).members.length
    const dated = Schema.Union([Schema.DateTimeUtc, Schema.String])
    const both = Schema.Union([Schema.DateTimeUtc, Schema.String, Schema.BigInt])
    for (const [, options] of READERS) {
      expect(membersOf(substituteSchemaDeep(dated, options))).toBe(2)
      expect(membersOf(substituteSchemaDeep(both, options))).toBe(4)
    }
    expect(membersOf(substituteSchemaDeep(both, { enforceChecks: true }))).toBe(3)
  })

  it("a oneOf union without a bigint stays one", () => {
    const oneOf = Schema.Union(
      [
        Schema.Struct({ tags: Schema.ReadonlySet(Schema.String) }),
        Schema.Struct({ d: Schema.DateTimeUtc }),
      ],
      { mode: "oneOf" },
    )
    const read = substituteSchemaDeep(oneOf, READERS[0][1])
    expect((read.ast as SchemaAST.Union).options?.mode).toBe("oneOf")
  })

  it("a suspended schema with nothing to take isn't wrapped on an aggregate", () => {
    const field = Schema.suspend(() => Schema.String)
    expect(substituteSchemaDeep(field, READERS[1][1])).toBe(field)
    const dated = Schema.suspend(() => Schema.DateFromString)
    expect(substituteSchemaDeep(dated, READERS[1][1])).not.toBe(dated)
  })

  it("a value two declared members take is still refused by a oneOf union", () => {
    const both = Schema.Union([V(Schema.Number), V(Schema.Number)], { mode: "oneOf" })
    expect(reads(READERS[0][1], both, { v: 5 })).toBe("fails")
    expect(reads(READERS[1][1], both, { v: 5 })).toBe("fails")
    expect(Option.isNone(Schema.decodeUnknownOption(both as Schema.Codec<any>)({ v: 5 }))).toBe(
      true,
    )
  })

  it("a write schema doesn't lift", () => {
    const write = Schema.decodeUnknownOption(
      substituteSchemaDeep(Schema.Struct({ f: nullable }), {
        enforceChecks: true,
      }) as Schema.Codec<any>,
    )
    expect(Option.isNone(write({ f: 5 }))).toBe(true)
  })

  it("encoding through a read schema keeps the bigint", () => {
    const encode = Schema.encodeUnknownOption(
      substituteSchemaDeep(Schema.Struct({ f: nullable }), READERS[0][1]) as Schema.Codec<any>,
    )
    expect(encode({ f: 5n })).toEqual(Option.some({ f: 5n }))
    expect(encode({ f: null })).toEqual(Option.some({ f: null }))
  })

  it("a schema nothing reads through a default stays as declared", () => {
    const field = Schema.Struct({ d: Schema.DateTimeUtc }).pipe(
      Schema.withDecodingDefaultKey(Effect.die("unused")),
    )
    expect(substituteSchemaDeep(field, { enforceChecks: true })).toBe(field)
    expect(substituteSchemaDeep(field, { tolerantTransforms: true })).toBe(field)
    expect(substituteSchemaDeep(field, { legacyReads: true })).not.toBe(field)
    expect(substituteSchemaDeep(field, { decodeOnly: true })).not.toBe(field)
  })

  it("a check added after a default: a read doesn't enforce it, a write schema does", () => {
    const field = nullable
      .pipe(Schema.withDecodingDefaultKey(Effect.succeed(null)))
      .check(Schema.makeFilter((value: bigint | null) => value !== 7n))
    const forWrite = substituteSchemaDeep(Schema.Struct({ f: field }), {
      tolerantTransforms: true,
      decodeOnly: true,
      enforceChecks: true,
    }) as Schema.Codec<any>
    expect(Option.isNone(Schema.decodeUnknownOption(forWrite)({ f: 7n }))).toBe(true)
    expect(reads(READERS[0][1], field, 7)).toBe(7n)
  })
})

describe("optionalField", () => {
  const inner = (field: Schema.Top) => optionalField(field)?.inner

  it("Schema.optional(X) is X, a union included", () => {
    expect(inner(Schema.optional(Schema.String))).toBe(Schema.String)
    expect(inner(Schema.optional(nullable))).toBe(nullable)
  })

  it("Schema.optionalKey(X) is X, whichever X", () => {
    expect(inner(Schema.optionalKey(Schema.String))).toBe(Schema.String)
    expect(inner(Schema.optionalKey(nullable))).toBe(nullable)
    const three = Schema.Union([Schema.String, Schema.Number, Schema.Undefined])
    expect(inner(Schema.optionalKey(three))).toBe(three)
    const one = Schema.Union([Schema.String])
    expect(inner(Schema.optionalKey(one))).toBe(one)
  })

  it("an optional key's union keeps every member through the substitution", () => {
    const field = Schema.optionalKey(Schema.NullOr(Schema.DateTimeUtc))
    const decode = Schema.decodeUnknownOption(
      substituteSchemaDeep(Schema.Struct({ f: field }), READERS[0][1]) as Schema.Codec<any>,
    )
    expect(decode({ f: null })).toEqual(Option.some({ f: null }))
    expect(decode({})).toEqual(Option.some({}))
    expect(Option.isSome(decode({ f: "2025-01-01T00:00:00.000Z" }))).toBe(true)
  })

  it("isn't an optional field otherwise", () => {
    expect(optionalField(nullable)).toBeUndefined()
    expect(optionalField(Schema.UndefinedOr(Schema.String))).toBeUndefined()
  })
})
