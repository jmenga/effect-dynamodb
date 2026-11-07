/**
 * What a stored row can be without (#178), and what a field's derived update schema
 * takes because of it. `rowCanLack` and `pathIsRequired` judge from the schema: a
 * name list couldn't see a decoding default or a transformation. A row can be without a
 * field two ways: the model lets it (`rowOmits`), or the field holds a value DynamoDB can't
 * store, which an absent attribute stands for (`absentReading`).
 */
import { DateTime, Effect, Exit, Option, Schema, SchemaGetter } from "effect"
import { describe, expect, it } from "vitest"
import * as DynamoModel from "../src/DynamoModel.js"
import * as Entity from "../src/Entity.js"
import {
  readingStreamValues,
  substituteSchemaDeep,
  writingTuplePositions,
} from "../src/internal/EntitySchemas.js"
import {
  absentReading,
  pathIsRequired,
  rowCanLack,
  rowOmits,
} from "../src/internal/SchemaAccessors.js"

describe("rowCanLack", () => {
  const CAN: ReadonlyArray<readonly [string, Schema.Top]> = [
    ["optional", Schema.optional(Schema.String)],
    ["optionalKey", Schema.optionalKey(Schema.String)],
    ["optional NullOr", Schema.optional(Schema.NullOr(Schema.String))],
    ["a decoding default", Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed("d")))],
    [
      "a decoding default on the key",
      Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed("d"))),
    ],
    ["OptionFromOptional", Schema.OptionFromOptional(Schema.String)],
    ["OptionFromOptionalKey", Schema.OptionFromOptionalKey(Schema.String)],
    ["optional transformation", Schema.optional(Schema.NumberFromString)],
  ]
  const STANDS_FOR: ReadonlyArray<readonly [string, Schema.Top, unknown]> = [
    ["UndefinedOr", Schema.UndefinedOr(Schema.String), undefined],
    ["a set", Schema.ReadonlySet(Schema.String), new Set()],
    ["a number set", Schema.ReadonlySet(Schema.Number), new Set()],
    ["NullOr of a set", Schema.NullOr(Schema.ReadonlySet(Schema.String)), new Set()],
    [
      "UndefinedOr of a set: undefined wins",
      Schema.UndefinedOr(Schema.ReadonlySet(Schema.String)),
      undefined,
    ],
    ["NullishOr", Schema.NullishOr(Schema.String), undefined],
    ["Unknown", Schema.Unknown, undefined],
    ["Void", Schema.Void, undefined],
    ["Any", Schema.Any, undefined],
    [
      "a set stored by a transformation",
      Schema.ReadonlySet(Schema.String).pipe(
        Schema.decodeTo(Schema.Array(Schema.String), {
          decode: SchemaGetter.transform((set: ReadonlySet<string>) => [...set]),
          encode: SchemaGetter.transform((list: ReadonlyArray<string>) => new Set(list)),
        } as never),
      ),
      [],
    ],
    ["a recursive set", Schema.suspend(() => Schema.ReadonlySet(Schema.String)), new Set()],
  ]
  const CANNOT: ReadonlyArray<readonly [string, Schema.Top]> = [
    ["required", Schema.String],
    ["a required struct", Schema.Struct({ a: Schema.optional(Schema.String) })],
    [
      "a required class",
      class Inner extends Schema.Class<Inner>("RCLInner")({ a: Schema.String }) {},
    ],
    ["NullOr, whose key is required", Schema.NullOr(Schema.String)],
    ["OptionFromNullOr", Schema.OptionFromNullOr(Schema.String)],
    ["a required transformation", Schema.NumberFromString],
    ["a date", Schema.DateTimeUtcFromString],
    ["a record", Schema.Record(Schema.String, Schema.String)],
    ["an array", Schema.Array(Schema.String)],
    ["a set that must not be empty", Schema.ReadonlySet(Schema.String).check(Schema.isMinSize(1))],
    [
      "a set stored as a list",
      Schema.Array(Schema.String).pipe(
        Schema.decodeTo(Schema.ReadonlySet(Schema.String), {
          decode: SchemaGetter.transform((list: ReadonlyArray<string>) => new Set(list)),
          encode: SchemaGetter.transform((set: ReadonlySet<string>) => [...set]),
        } as never),
      ),
    ],
    [
      "a defined value that must hold",
      Schema.UndefinedOr(Schema.String).check(
        Schema.makeFilter((value: string | undefined) => value !== undefined),
      ),
    ],
    [
      "optional when stored, required once decoded",
      Schema.optionalKey(Schema.String).pipe(Schema.decodeTo(Schema.String)),
    ],
  ]
  for (const [name, field] of CAN) {
    it(`can: ${name}`, () => expect(rowCanLack(field)).toBe(true))
  }
  for (const [name, field] of CANNOT) {
    it(`cannot: ${name}`, () => expect(rowCanLack(field)).toBe(false))
  }

  for (const [name, field, value] of STANDS_FOR) {
    it(`can, because an absent attribute stands for its value: ${name}`, () => {
      expect(rowCanLack(field)).toBe(true)
      expect(rowOmits(field)).toBe(false)
      expect(absentReading(field)?.value).toEqual(value)
    })
  }

  it("what an absent attribute stands for isn't something the model would omit", () => {
    for (const [, field] of CAN) expect(absentReading(field)).toBeUndefined()
  })

  it("rowOmits agrees with a decode of a row without the field, for every kind above", () => {
    for (const [, field] of [...CAN, ...CANNOT, ...STANDS_FOR]) {
      const decoded = Schema.decodeUnknownExit(
        Schema.Struct({ field }) as unknown as Schema.Codec<unknown, unknown>,
      )({})
      expect(Exit.isSuccess(decoded)).toBe(rowOmits(field))
    }
  })

  it("a default that can't run synchronously is taken at its word", () => {
    const later = Schema.String.pipe(
      Schema.withDecodingDefault(Effect.promise(() => Promise.resolve("d"))),
    )
    expect(rowCanLack(later)).toBe(true)
  })
})

describe("the derived read schema", () => {
  class Part extends Schema.Class<Part>("RCLPart")({
    tags: Schema.ReadonlySet(Schema.String),
    note: Schema.UndefinedOr(Schema.String),
  }) {}
  class Row extends Schema.Class<Row>("RCLRow")({
    id: Schema.String,
    tags: Schema.ReadonlySet(Schema.String),
    numbers: Schema.ReadonlySet(Schema.Number),
    note: Schema.UndefinedOr(Schema.String),
    part: Part,
    parts: Schema.Array(Part),
    maybePart: Schema.optional(Part),
    choice: Schema.Union([Part, Schema.Struct({ other: Schema.Number })]),
    strict: Schema.Union([Part, Schema.Struct({ other: Schema.Number })], { mode: "oneOf" }),
    optionalTags: Schema.optional(Schema.ReadonlySet(Schema.String)),
    filled: Schema.optional(Schema.ReadonlySet(Schema.String).check(Schema.isMinSize(1))),
  }) {}
  const Rows = Entity.make({
    model: Row,
    entityType: "Row",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
  })
  const read = (row: unknown): any =>
    Schema.decodeUnknownSync(Rows.schemas.modelSchema as Schema.Codec<unknown, unknown>)(row)
  const stored = {
    id: "1",
    part: {},
    parts: [{}],
    choice: {},
    strict: { other: 1 },
  }

  it("an absent attribute reads as the value, wherever it's nested", () => {
    const row = read(stored)
    expect(row.tags).toEqual(new Set())
    expect(row.numbers).toEqual(new Set())
    expect("note" in row).toBe(true)
    expect(row.part).toBeInstanceOf(Part)
    expect(row.part.tags).toEqual(new Set())
    expect("note" in row.part).toBe(true)
    expect(row.parts[0].tags).toEqual(new Set())
    expect(row.choice.tags).toEqual(new Set())
  })

  it("each read gets its own set", () => {
    expect(read(stored).tags).not.toBe(read(stored).tags)
  })

  it("a field left optional stays absent", () => {
    const row = read(stored)
    expect("optionalTags" in row).toBe(false)
    expect("maybePart" in row).toBe(false)
  })

  it("a union member with a lenient reading doesn't take a later member's row", () => {
    expect(read({ ...stored, choice: { other: 2 } }).choice).toEqual({ other: 2 })
  })

  it("a union keeps a member's own values, and a value decodes as declared", () => {
    expect(read({ ...stored, choice: { tags: new Set(["a"]) } }).choice.tags).toEqual(
      new Set(["a"]),
    )
    expect(read({ ...stored, tags: new Set(["a"]) }).tags).toEqual(new Set(["a"]))
  })

  it("a oneOf union stays strict: an empty row isn't both members", () => {
    expect(read(stored).strict).toEqual({ other: 1 })
    const decoded = Schema.decodeUnknownExit(
      Rows.schemas.modelSchema as Schema.Codec<unknown, unknown>,
    )({ ...stored, strict: {} })
    expect(Exit.isFailure(decoded)).toBe(true)
  })

  it("the input schema stays strict: a write names its required fields", () => {
    const decoded = Schema.decodeUnknownExit(
      Rows.schemas.inputSchema as Schema.Codec<unknown, unknown>,
    )({ id: "1" })
    expect(Exit.isFailure(decoded)).toBe(true)
  })
})

describe("readingStreamValues", () => {
  const Set_ = Schema.ReadonlySet(Schema.String)
  const reader = (schema: Schema.Top) =>
    Schema.decodeUnknownSync(readingStreamValues(schema) as Schema.Codec<any, unknown>)

  it("a schema with nothing to read as absent is returned unchanged", () => {
    // Entity derivation would swap this date for a tolerant one. A schema it doesn't own stays.
    const Dated = Schema.Struct({ at: Schema.DateTimeUtcFromString, n: Schema.Number })
    expect(readingStreamValues(Dated)).toBe(Dated)
  })

  it("finds a field through a list, an optional, a record and a union", () => {
    const list = reader(Schema.Struct({ list: Schema.Array(Schema.Struct({ tags: Set_ })) }))
    expect(list({ list: [{}] }).list[0].tags).toEqual(new Set())
    const maybe = reader(Schema.Struct({ maybe: Schema.optional(Schema.Struct({ tags: Set_ })) }))
    expect(maybe({ maybe: {} }).maybe.tags).toEqual(new Set())
    expect("maybe" in maybe({})).toBe(false)
    const keyed = reader(Schema.Record(Schema.String, Schema.Struct({ tags: Set_ })))
    expect(keyed({ k: {} }).k.tags).toEqual(new Set())
  })

  it("a check on a list it rebuilds still holds", () => {
    const read = reader(
      Schema.Struct({
        list: Schema.Array(Schema.Struct({ tags: Set_ })).check(Schema.isMinLength(1)),
      }),
    )
    expect(read({ list: [{}] }).list).toHaveLength(1)
    expect(() => read({ list: [] })).toThrow()
  })

  it("a union's other members stay as declared: a date isn't made tolerant", () => {
    const read = reader(
      Schema.Union([
        Schema.Struct({ at: Schema.DateTimeUtc, tags: Set_ }),
        Schema.Struct({ other: Schema.Number }),
      ]),
    )
    expect(() => read({ at: "2024-01-01T00:00:00.000Z", tags: new Set(["a"]) })).toThrow()
  })

  it("a union isn't judged as entity derivation judges one: a date beside a number is allowed", () => {
    expect(() =>
      readingStreamValues(
        Schema.Union([
          Schema.DateTimeUtc.pipe(DynamoModel.storedAs(DynamoModel.DateEpochMs)),
          Schema.Number,
          Schema.Struct({ tags: Set_ }),
        ]),
      ),
    ).not.toThrow()
  })

  it("reads what it can, and leaves the rest as declared", () => {
    const Holding = Schema.Struct({
      at: Schema.DateTimeUtcFromString,
      tags: Schema.ReadonlySet(Schema.String),
      nested: Schema.Struct({ note: Schema.UndefinedOr(Schema.String) }),
    })
    const read = Schema.decodeUnknownSync(
      readingStreamValues(Holding) as Schema.Codec<any, unknown>,
    )({ at: "2024-01-01T00:00:00.000Z", nested: {} })
    expect(read.tags).toEqual(new Set())
    expect("note" in read.nested).toBe(true)
    expect(() =>
      Schema.decodeUnknownSync(readingStreamValues(Holding) as Schema.Codec<any, unknown>)({
        at: new Date(0),
        nested: {},
      }),
    ).toThrow()
  })

  it("a member of a union reads as absent only for a row no member takes as declared", () => {
    const Union = Schema.Union([
      Schema.Struct({ tags: Schema.ReadonlySet(Schema.String) }),
      Schema.Struct({ other: Schema.Number }),
    ])
    const read = Schema.decodeUnknownSync(readingStreamValues(Union) as Schema.Codec<any, unknown>)
    expect(read({ other: 1 })).toEqual({ other: 1 })
    expect(read({}).tags).toEqual(new Set())
  })
})

describe("pathIsRequired", () => {
  class Inner extends Schema.Class<Inner>("PIRInner")({
    must: Schema.String,
    may: Schema.optional(Schema.String),
  }) {}
  type Tree = { readonly value: string; readonly next?: Tree | undefined }
  const Tree: Schema.Codec<Tree> = Schema.Struct({
    value: Schema.String,
    next: Schema.optional(Schema.suspend((): Schema.Codec<Tree> => Tree)),
  })
  const Address = Schema.Struct({ city: Schema.String, zip: Schema.optional(Schema.String) })

  const CASES: ReadonlyArray<
    readonly [string, Schema.Top, ReadonlyArray<string | number>, boolean]
  > = [
    ["a required property", Address, ["city"], true],
    ["an optional property", Address, ["zip"], false],
    ["below an optional parent, its required property", Schema.optional(Address), ["city"], true],
    ["below an optional parent, its optional property", Schema.optional(Address), ["zip"], false],
    ["a class's required property", Inner, ["must"], true],
    ["a class's optional property", Inner, ["may"], false],
    ["two levels down", Schema.Struct({ a: Address }), ["a", "city"], true],
    ["a whole nested struct", Schema.Struct({ a: Address }), ["a"], true],
    ["a record's entry", Schema.Record(Schema.String, Schema.String), ["k"], false],
    ["below a record's entry", Schema.Record(Schema.String, Address), ["k", "city"], true],
    ["a list's element", Schema.Array(Schema.String), [0], false],
    ["below a list's element", Schema.Array(Address), [0, "city"], true],
    ["an optional property below a list's element", Schema.Array(Address), [0, "zip"], false],
    ["a tuple's element", Schema.Tuple([Schema.String, Schema.Number]), [1], true],
    ["a recursive schema's required property", Tree, ["next", "value"], true],
    ["a recursive schema's optional property", Tree, ["next", "next"], false],
    [
      "a union whose every member requires it",
      Schema.Union([Address, Schema.Struct({ city: Schema.String })]),
      ["city"],
      true,
    ],
    [
      "a union with a member that doesn't",
      Schema.Union([Address, Schema.Struct({ city: Schema.optional(Schema.String) })]),
      ["city"],
      false,
    ],
    [
      "a union where only one member has it",
      Schema.Union([Address, Schema.Struct({ other: Schema.String })]),
      ["city"],
      true,
    ],
    ["a nested set", Schema.Struct({ s: Schema.ReadonlySet(Schema.String) }), ["s"], false],
    ["a nested UndefinedOr", Schema.Struct({ s: Schema.UndefinedOr(Schema.String) }), ["s"], false],
    [
      "a nested set that must not be empty",
      Schema.Struct({ s: Schema.ReadonlySet(Schema.String).check(Schema.isMinSize(1)) }),
      ["s"],
      true,
    ],
    [
      "a nested NullOr: its null is a value, and it has no absent reading",
      Schema.Struct({ s: Schema.NullOr(Schema.String) }),
      ["s"],
      true,
    ],
    ["a name the schema doesn't know", Address, ["nope"], false],
    ["a scalar's path", Schema.String, ["x"], false],
    ["a string key into a list", Schema.Array(Schema.String), ["x"], false],
    ["a number key into a struct", Address, [0], false],
  ]
  for (const [name, field, path, expected] of CASES) {
    it(`${name}: ${expected}`, () => expect(pathIsRequired(field, path)).toBe(expected))
  }
})

describe("the derived update schema", () => {
  class Item extends Schema.Class<Item>("RCLItem")({
    id: Schema.String,
    note: Schema.String,
    code: Schema.optional(Schema.String),
    keyed: Schema.optionalKey(Schema.String),
    defaulted: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed("d"))),
    nullable: Schema.NullOr(Schema.String),
    maybe: Schema.OptionFromOptional(Schema.String),
    tags: Schema.ReadonlySet(Schema.String),
    undefinable: Schema.UndefinedOr(Schema.String),
    filled: Schema.ReadonlySet(Schema.String).check(Schema.isMinSize(1)),
  }) {}
  const Items = Entity.make({
    model: Item,
    entityType: "Item",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
  })
  const decode = (input: unknown) =>
    Schema.decodeUnknownExit(Items.schemas.updateSchema as Schema.Codec<unknown, unknown>)(input)

  it("takes a field left out", () => {
    expect(Exit.isSuccess(decode({}))).toBe(true)
  })

  it("refuses `undefined` for a required field, or a required key whose value may be empty", () => {
    expect(Exit.isFailure(decode({ note: undefined }))).toBe(true)
    expect(Exit.isFailure(decode({ nullable: undefined }))).toBe(true)
  })

  it("refuses `null` for a required field: the shape JSON gives `undefined`", () => {
    expect(Exit.isFailure(decode({ note: null }))).toBe(true)
  })

  it("takes `undefined` for any field a row can lack", () => {
    for (const field of ["code", "keyed", "defaulted"]) {
      expect(Exit.isSuccess(decode({ [field]: undefined }))).toBe(true)
    }
    expect(Exit.isSuccess(decode({ maybe: undefined }))).toBe(true)
  })

  it("takes `undefined` for a field whose value has no stored form", () => {
    for (const field of ["tags", "undefinable"]) {
      expect(Exit.isSuccess(decode({ [field]: undefined }))).toBe(true)
    }
  })

  it("refuses `undefined` for a set that must not be empty", () => {
    expect(Exit.isFailure(decode({ filled: undefined }))).toBe(true)
  })

  it("takes an empty set for a set, and refuses one for a set that must not be empty", () => {
    expect(Exit.isSuccess(decode({ tags: new Set() }))).toBe(true)
    expect(Exit.isFailure(decode({ filled: new Set() }))).toBe(true)
  })

  it("keeps `null` for a field that declares it", () => {
    expect(Exit.isSuccess(decode({ nullable: null }))).toBe(true)
  })

  it("a value that decodes to None stays one", () => {
    const decoded = decode({ maybe: "x" })
    expect(Exit.isSuccess(decoded)).toBe(true)
    expect(Option.isSome((decoded as Exit.Success<any, never>).value.maybe)).toBe(true)
  })

  it("a colliding updatedAt takes `undefined`: it means generate it, however the model declares it", () => {
    class Stamped extends Schema.Class<Stamped>("RCLStamped")({
      id: Schema.String,
      updatedAt: Schema.DateTimeUtcFromString,
    }) {}
    const Stampeds = Entity.make({
      model: Stamped,
      entityType: "Stamped",
      primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
      timestamps: true,
    })
    const decoded = Schema.decodeUnknownExit(
      Stampeds.schemas.updateSchema as Schema.Codec<unknown, unknown>,
    )({ updatedAt: undefined })
    expect(Exit.isSuccess(decoded)).toBe(true)
  })

  describe("over JSON, as an HTTP API built from it sees it", () => {
    const json = () =>
      Schema.decodeUnknownExit(
        Schema.toCodecJson(Items.schemas.updateSchema as Schema.Codec<unknown, unknown>),
      )
    it("a required field: left out or a value, and `null` is a decode error", () => {
      expect(Exit.isSuccess(json()({}))).toBe(true)
      expect(Exit.isSuccess(json()({ note: "n" }))).toBe(true)
      expect(Exit.isFailure(json()({ note: null }))).toBe(true)
    })
    it("an optional field: `null` means clear it", () => {
      expect(Exit.isSuccess(json()({ code: null }))).toBe(true)
    })
    it("a field whose value has no stored form: `null` means clear it", () => {
      expect(Exit.isSuccess(json()({ tags: null }))).toBe(true)
      expect(Exit.isSuccess(json()({ undefinable: null }))).toBe(true)
    })
  })
})

describe("a tuple position holding undefined", () => {
  const S = Schema.String
  const U = Schema.UndefinedOr(Schema.String)
  const O = Schema.optional(Schema.String)
  const u = undefined
  const writes = (schema: Schema.Top, value: unknown) =>
    Exit.isSuccess(Schema.encodeUnknownExit(writingTuplePositions(schema) as never)(value))
  const refusal = (schema: Schema.Top, value: unknown) => {
    const exit = Schema.encodeUnknownExit(writingTuplePositions(schema) as never)(value)
    return Exit.isFailure(exit) ? String(exit.cause) : ""
  }

  const REFUSED: ReadonlyArray<readonly [string, Schema.Top, unknown, number]> = [
    ["in the middle", Schema.Tuple([S, U, S]), ["a", u, "b"], 1],
    ["at the end, required", Schema.Tuple([S, U]), ["a", u], 1],
    ["at the start", Schema.Tuple([U, S]), [u, "b"], 0],
    ["before an optional that holds a value", Schema.Tuple([S, U, O]), ["a", u, "c"], 1],
    ["an optional with a value after it", Schema.Tuple([S, O, O]), ["a", u, "c"], 1],
    ["the first of several", Schema.Tuple([U, U, S]), [u, u, "c"], 0],
  ]
  for (const [name, schema, value, position] of REFUSED) {
    it(`refused ${name}`, () => {
      expect(refusal(schema, value)).toContain(`Position ${position} holds undefined`)
    })
  }

  const STORED: ReadonlyArray<readonly [string, Schema.Top, unknown]> = [
    ["every position holding a value", Schema.Tuple([S, U, S]), ["a", "b", "c"]],
    ["a last optional holding undefined", Schema.Tuple([S, O]), ["a", u]],
    ["a last optional left out", Schema.Tuple([S, O]), ["a"]],
    ["two last optionals holding undefined", Schema.Tuple([S, O, O]), ["a", u, u]],
    ["an optional holding a value", Schema.Tuple([S, O]), ["a", "b"]],
  ]
  for (const [name, schema, value] of STORED) {
    it(`stored: ${name}`, () => {
      expect(writes(schema, value)).toBe(true)
    })
  }

  const NESTED: ReadonlyArray<readonly [string, Schema.Top, unknown]> = [
    ["a struct field", Schema.Struct({ t: Schema.Tuple([U, S]) }), { t: [u, "b"] }],
    [
      "an optional field",
      Schema.Struct({ t: Schema.optional(Schema.Tuple([U, S])) }),
      { t: [u, "b"] },
    ],
    [
      "a field with a decoding default",
      Schema.Struct({
        t: Schema.Tuple([U, S]).pipe(Schema.withDecodingDefault(Effect.succeed([u, "d"] as const))),
      }),
      { t: [u, "b"] },
    ],
    ["a list", Schema.Array(Schema.Tuple([U, S])), [[u, "b"]]],
    ["a tuple", Schema.Tuple([S, Schema.Tuple([U, S])]), ["a", [u, "b"]]],
    [
      "a deep struct",
      Schema.Struct({ a: Schema.Struct({ b: Schema.Array(Schema.Tuple([U, S])) }) }),
      { a: { b: [[u, "b"]] } },
    ],
    ["a union", Schema.Union([Schema.Number, Schema.Tuple([U, S])]), [u, "b"]],
    ["a record", Schema.Record(Schema.String, Schema.Tuple([U, S])), { k: [u, "b"] }],
  ]
  for (const [name, schema, value] of NESTED) {
    it(`found inside ${name}`, () => {
      expect(refusal(schema, value)).toContain("Position 0 holds undefined")
    })
  }

  it("a class holding one", () => {
    class Holder extends Schema.Class<Holder>("RowCanLackTupleHolder")({
      t: Schema.Tuple([U, S]),
    }) {}
    expect(refusal(Holder, new Holder({ t: [u, "b"] }))).toContain("Position 0 holds undefined")
  })

  const UNCHANGED: ReadonlyArray<readonly [string, Schema.Top]> = [
    ["a plain struct", Schema.Struct({ a: S, b: Schema.Number })],
    ["a tuple no position of which can hold it", Schema.Tuple([S, Schema.Number])],
    ["a list of undefined", Schema.Array(U)],
    ["a struct field holding undefined", Schema.Struct({ a: U })],
    ["a nullable tuple position", Schema.Tuple([S, Schema.NullOr(S)])],
    ["a transformation", Schema.Tuple([Schema.NumberFromString, S])],
    [
      "a set position, which is an empty set and not undefined",
      Schema.Tuple([S, Schema.ReadonlySet(S)]),
    ],
    ["a date, left as declared", Schema.Struct({ at: Schema.DateTimeUtc })],
    [
      "a position only its encoding makes undefined",
      Schema.Tuple([S, Schema.OptionFromUndefinedOr(S)]),
    ],
  ]
  for (const [name, schema] of UNCHANGED) {
    it(`no tuple can hold one: ${name} is the same schema`, () => {
      expect(writingTuplePositions(schema)).toBe(schema)
    })
  }

  it("what it doesn't refuse is encoded as declared", () => {
    const Declared = Schema.Struct({
      t: Schema.Tuple([U, Schema.NumberFromString]),
      n: Schema.NumberFromString,
      checked: Schema.String.check(Schema.isMinLength(3)),
      at: Schema.DateTimeUtc,
    })
    const at = DateTime.makeUnsafe("2026-01-02T03:04:05.000Z")
    const encoded = Schema.encodeUnknownSync(writingTuplePositions(Declared) as never)({
      t: ["a", 1],
      n: 2,
      checked: "abc",
      at,
    })
    expect(encoded).toEqual({ t: ["a", "1"], n: "2", checked: "abc", at })
  })

  it("an undefined that encodes to something else has a stored form, and stays", () => {
    const NoneIsEmpty = Schema.String.pipe(
      Schema.decodeTo(Schema.UndefinedOr(S), {
        decode: SchemaGetter.transform((text: string) => (text === "" ? undefined : text)),
        encode: SchemaGetter.transform((value: string | undefined) => value ?? ""),
      }),
    )
    const Declared = Schema.Tuple([NoneIsEmpty, S])
    expect(writingTuplePositions(Declared)).toBe(Declared)
    expect(Schema.encodeUnknownSync(writingTuplePositions(Declared) as never)([u, "b"])).toEqual([
      "",
      "b",
    ])
  })

  it("a limit: a struct beneath a decoding default isn't walked", () => {
    const Declared = Schema.Struct({ t: Schema.Tuple([U, S]) }).pipe(
      Schema.withDecodingDefault(Effect.succeed({ t: [u, "d"] as const })),
    )
    expect(writes(Declared, { t: [u, "b"] })).toBe(true)
  })

  it("a read isn't refused, nor anything but the write schemas", () => {
    const Read = readingStreamValues(Schema.Tuple([U, Schema.Struct({ s: Schema.ReadonlySet(S) })]))
    expect(Exit.isSuccess(Schema.decodeUnknownExit(Read as never)([u, {}]))).toBe(true)
    const Plain = substituteSchemaDeep(Schema.Tuple([U, Schema.DateTimeUtc]))
    const at = DateTime.makeUnsafe("2026-01-02T03:04:05.000Z")
    expect(Exit.isSuccess(Schema.encodeUnknownExit(Plain as never)([u, at]))).toBe(true)
  })

  it("a list holding undefined isn't its concern: a list has no positions to keep", () => {
    const Declared = Schema.Array(U)
    expect(writes(Declared, ["a", u, "b"])).toBe(true)
  })

  it("the rest of a tuple with a rest is a list, and it's the fixed positions that count", () => {
    const Declared = Schema.TupleWithRest(Schema.Tuple([S, U]), [U])
    expect(writes(Declared, ["a", "b", u, "c"])).toBe(true)
    expect(refusal(Declared, ["a", u, "c"])).toContain("Position 1 holds undefined")
  })

  describe("on an entity", () => {
    const Tupled = Schema.Struct({ id: S, t: Schema.Tuple([S, U, S]) })
    const Rows = Entity.make({
      model: Tupled,
      entityType: "Row",
      primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
    } as never) as unknown as {
      readonly inputSchema: Schema.Top
      readonly updateSchema: Schema.Top
    }

    it("the write schemas refuse it, on an encode and a decode", () => {
      const value = { id: "1", t: ["a", u, "b"] }
      for (const derived of [Rows.inputSchema]) {
        expect(Exit.isFailure(Schema.encodeUnknownExit(derived as never)(value))).toBe(true)
        expect(Exit.isFailure(Schema.decodeUnknownExit(derived as never)(value))).toBe(true)
      }
      expect(
        Exit.isFailure(Schema.encodeUnknownExit(Rows.updateSchema as never)({ t: ["a", u, "b"] })),
      ).toBe(true)
    })

    it("and take it whole", () => {
      const value = { id: "1", t: ["a", "x", "b"] }
      expect(Exit.isSuccess(Schema.encodeUnknownExit(Rows.inputSchema as never)(value))).toBe(true)
    })
  })
})
