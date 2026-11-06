/**
 * What a stored row can be without (#178), and what a field's derived update schema
 * takes because of it. `rowCanLack` and `pathIsRequired` judge from the schema: a
 * name list couldn't see a decoding default or a transformation.
 */
import { Effect, Exit, Option, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Entity from "../src/Entity.js"
import { pathIsRequired, rowCanLack } from "../src/internal/SchemaAccessors.js"

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
  const CANNOT: ReadonlyArray<readonly [string, Schema.Top]> = [
    ["required", Schema.String],
    ["a required struct", Schema.Struct({ a: Schema.optional(Schema.String) })],
    [
      "a required class",
      class Inner extends Schema.Class<Inner>("RCLInner")({ a: Schema.String }) {},
    ],
    ["NullOr, whose key is required", Schema.NullOr(Schema.String)],
    ["UndefinedOr, whose key is required", Schema.UndefinedOr(Schema.String)],
    ["OptionFromNullOr", Schema.OptionFromNullOr(Schema.String)],
    ["a required transformation", Schema.NumberFromString],
    ["a date", Schema.DateTimeUtcFromString],
    ["a record", Schema.Record(Schema.String, Schema.String)],
    ["an array", Schema.Array(Schema.String)],
    ["a set", Schema.ReadonlySet(Schema.String)],
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

  it("agrees with a decode of a row without the field, for every kind above", () => {
    for (const [, field] of [...CAN, ...CANNOT]) {
      const decoded = Schema.decodeUnknownExit(
        Schema.Struct({ field }) as unknown as Schema.Codec<unknown, unknown>,
      )({})
      expect(Exit.isSuccess(decoded)).toBe(rowCanLack(field))
    }
  })

  it("a default that can't run synchronously is taken at its word", () => {
    const later = Schema.String.pipe(
      Schema.withDecodingDefault(Effect.promise(() => Promise.resolve("d"))),
    )
    expect(rowCanLack(later)).toBe(true)
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
  })
})
