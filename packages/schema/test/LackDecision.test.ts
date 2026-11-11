/**
 * "Can a stored row be without this field and still be read?" is decided in one of two places.
 *
 * (a) By the field's schema, where nothing the model runs takes part in reading the absence:
 *     a required field can't be lacked (`"refuse"`); an optional key, or a field whose absent
 *     attribute is one of its values and is read with no check or transformation, can
 *     (`"allow"`).
 * (b) By reading the absence, where the model's code does take part (`"decode"`): a decoding
 *     default, a step handed the absent key, a middleware, a suspension, a check or transformation
 *     on the value an absent attribute stands for. Only a write that leaves the field out asks,
 *     once. A kind of step the library doesn't know is decided here too, never by (a).
 *
 * `lackDecision` says which, from the schema alone, and runs nothing: defining an entity runs
 * none of a model's code, as on 1.39.0. Each shape below pins its decision, and the answer
 * against what the release branch gave until now by decoding at definition (`was`, kept here
 * as it was).
 */
import { Effect, Exit, Option, Schema, SchemaAST, SchemaGetter, SchemaIssue } from "effect"
import { describe, expect, it } from "vitest"
import * as DynamoModel from "../src/DynamoModel.js"
import * as Entity from "../src/Entity.js"
import {
  absentReading,
  type LackDecision,
  lackDecision,
  rowCanLack,
} from "../src/internal/SchemaAccessors.js"

/** A decode of a row without the field, when its stored side is optional. */
const probe = (field: Schema.Top): boolean =>
  SchemaAST.isOptional(SchemaAST.toEncoded(field.ast)) &&
  !Exit.hasFails(
    Schema.decodeUnknownExit(Schema.Struct({ field }) as unknown as Schema.Codec<unknown, unknown>)(
      {},
    ),
  )

/**
 * What the release branch answered until now, by decoding while the entity was defined: a row
 * without the field, when its stored side was optional, and otherwise the value an absent
 * attribute stands for.
 */
const was = (field: Schema.Top): boolean => probe(field) || absentReading(field) !== undefined

/** Counts every call of the code a schema below holds. */
const calls = { count: 0 }
const counted = <A>(value: A) =>
  Effect.sync(() => {
    calls.count++
    return value
  })
const countedCheck = Schema.makeFilter(() => {
  calls.count++
  return true
})
const countedStep = <A>(f: (a: A) => unknown) =>
  SchemaGetter.transform((value: A) => {
    calls.count++
    return f(value)
  })

class Inner extends Schema.Class<Inner>("RONInner")({
  a: Schema.String.pipe(Schema.withDecodingDefaultKey(counted("a"))),
}) {
  constructor(props: { readonly a?: string }, options?: Schema.MakeOptions) {
    calls.count++
    super(props as { readonly a: string }, options)
  }
}
const suspended: Schema.Codec<string, string | undefined> = Schema.suspend(() =>
  Schema.String.pipe(Schema.withDecodingDefaultKey(counted("s"))),
) as never

const SHAPES: ReadonlyArray<readonly [string, LackDecision, Schema.Top]> = [
  // Optional keys
  ["optional", "allow", Schema.optional(Schema.String)],
  ["optionalKey", "allow", Schema.optionalKey(Schema.String)],
  ["optional NullOr", "allow", Schema.optional(Schema.NullOr(Schema.String))],
  [
    "optionalKey of a checked string",
    "allow",
    Schema.optionalKey(Schema.String.check(countedCheck)),
  ],
  ["optional of a transformation", "allow", Schema.optional(Schema.NumberFromString)],
  ["optionalKey of a struct", "allow", Schema.optionalKey(Schema.Struct({ a: Schema.String }))],
  ["optional of a class with a default inside", "allow", Schema.optional(Inner)],
  // Decoding defaults, synchronous and effectful
  [
    "withDecodingDefault, sync",
    "decode",
    Schema.String.pipe(Schema.withDecodingDefault(counted("d"))),
  ],
  [
    "withDecodingDefaultKey, sync",
    "decode",
    Schema.String.pipe(Schema.withDecodingDefaultKey(counted("d"))),
  ],
  [
    "withDecodingDefault, succeed",
    "decode",
    Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed("d"))),
  ],
  [
    "withDecodingDefaultKey, effectful",
    "decode",
    Schema.String.pipe(
      Schema.withDecodingDefaultKey(Effect.flatMap(counted("d"), (d) => Effect.succeed(`${d}!`))),
    ),
  ],
  [
    "withDecodingDefault, asynchronous",
    "decode",
    Schema.String.pipe(Schema.withDecodingDefault(Effect.promise(() => Promise.resolve("d")))),
  ],
  [
    "withDecodingDefaultKey, omitted when encoded",
    "decode",
    Schema.String.pipe(Schema.withDecodingDefaultKey(counted("d"), { encodingStrategy: "omit" })),
  ],
  [
    "withDecodingDefaultType",
    "decode",
    Schema.NumberFromString.pipe(Schema.withDecodingDefaultType(counted(1))),
  ],
  [
    "withDecodingDefaultTypeKey",
    "decode",
    Schema.NumberFromString.pipe(Schema.withDecodingDefaultTypeKey(counted(1))),
  ],
  [
    "a default on a transformation",
    "decode",
    Schema.NumberFromString.pipe(Schema.withDecodingDefaultKey(counted("1"))),
  ],
  [
    "a default on a checked string",
    "decode",
    Schema.String.check(countedCheck).pipe(Schema.withDecodingDefaultKey(counted("d"))),
  ],
  [
    "a check after the default",
    "decode",
    Schema.String.pipe(Schema.withDecodingDefaultKey(counted("d"))).check(countedCheck),
  ],
  [
    "a default on a class",
    "decode",
    Inner.pipe(Schema.withDecodingDefaultKey(counted({ a: "x" }))),
  ],
  ["a class with a default inside", "refuse", Inner],
  [
    "a struct with a default inside",
    "refuse",
    Schema.Struct({ a: Schema.String.pipe(Schema.withDecodingDefaultKey(counted("a"))) }),
  ],
  // Steps
  [
    "a step onto a required value",
    "refuse",
    Schema.optionalKey(Schema.String).pipe(
      Schema.decodeTo(Schema.String, {
        decode: countedStep((s: string) => s),
        encode: SchemaGetter.passthrough(),
      } as never),
    ),
  ],
  [
    "a step onto an optional value",
    "allow",
    Schema.optionalKey(Schema.String).pipe(
      Schema.decodeTo(Schema.optionalKey(Schema.String), {
        decode: countedStep((s: string) => s),
        encode: SchemaGetter.passthrough(),
      } as never),
    ),
  ],
  [
    "optional when stored, required once decoded",
    "refuse",
    Schema.optionalKey(Schema.String).pipe(Schema.decodeTo(Schema.String)),
  ],
  [
    "required when stored, optional once decoded",
    "allow",
    Schema.String.pipe(
      Schema.decodeTo(Schema.optionalKey(Schema.String), {
        decode: countedStep((s: string) => s),
        encode: SchemaGetter.passthrough(),
      } as never),
    ),
  ],
  [
    "a middleware",
    "decode",
    Schema.optionalKey(Schema.String).pipe(Schema.catchDecoding(() => Effect.succeedNone)),
  ],
  [
    "a middleware filling a missing key",
    "decode",
    Schema.optionalKey(Schema.String).pipe(
      Schema.decodeTo(Schema.String, {
        decode: SchemaGetter.passthrough(),
        encode: SchemaGetter.passthrough(),
      } as never),
      Schema.middlewareDecoding((read) =>
        Effect.map(read, (value) => {
          calls.count++
          return Option.isNone(value) ? Option.some("fallback") : value
        }),
      ),
    ),
  ],
  [
    "a middleware failing a missing key",
    "decode",
    Schema.optionalKey(Schema.String).pipe(
      Schema.middlewareDecoding((read) =>
        Effect.flatMap(read, (value) => {
          calls.count++
          return Option.isNone(value)
            ? Effect.fail(new SchemaIssue.InvalidValue(Option.none() as never))
            : Effect.succeed(value)
        }),
      ),
    ),
  ],
  [
    "a middleware on a required key",
    "decode",
    Schema.String.pipe(
      Schema.middlewareDecoding((read) =>
        Effect.map(read, (value) => {
          calls.count++
          return value
        }),
      ),
    ),
  ],
  [
    "a middleware filling a required key",
    "decode",
    Schema.String.pipe(
      Schema.middlewareDecoding((read) =>
        Effect.map(read, (value) => {
          calls.count++
          return Option.isNone(value) ? Option.some("fallback") : value
        }),
      ),
    ),
  ],
  [
    "a step filling a required key",
    "decode",
    Schema.String.pipe(
      Schema.decodeTo(Schema.String, {
        decode: SchemaGetter.transformOptional((value: Option.Option<string>) => {
          calls.count++
          return Option.orElse(value, () => Option.some("filled"))
        }),
        encode: SchemaGetter.passthrough(),
      } as never),
    ),
  ],
  // Unions
  ["optional union", "allow", Schema.optional(Schema.Union([Schema.String, Schema.Number]))],
  ["required union", "refuse", Schema.Union([Schema.String, Schema.Number])],
  [
    "a union with a defaulted member",
    "refuse",
    Schema.Union([Schema.String.pipe(Schema.withDecodingDefaultKey(counted("u"))), Schema.Number]),
  ],
  [
    "a default on a union",
    "decode",
    Schema.Union([Schema.String, Schema.Number]).pipe(Schema.withDecodingDefaultKey(counted("u"))),
  ],
  // Suspensions
  [
    "optionalKey of a suspension",
    "decode",
    Schema.optionalKey(Schema.suspend(() => Schema.String)),
  ],
  ["a suspended default", "decode", suspended],
  ["optionalKey of a suspended default", "decode", Schema.optionalKey(suspended)],
  ["a suspended optional", "decode", Schema.suspend(() => Schema.optionalKey(Schema.String))],
  // Options
  ["Option", "refuse", Schema.Option(Schema.String)],
  ["optional Option", "allow", Schema.optional(Schema.Option(Schema.String))],
  ["OptionFromOptional", "decode", Schema.OptionFromOptional(Schema.String)],
  ["OptionFromOptionalKey", "decode", Schema.OptionFromOptionalKey(Schema.NumberFromString)],
  ["OptionFromOptionalNullOr", "decode", Schema.OptionFromOptionalNullOr(Schema.String)],
  ["OptionFromNullOr", "refuse", Schema.OptionFromNullOr(Schema.String)],
  ["OptionFromUndefinedOr", "decode", Schema.OptionFromUndefinedOr(Schema.String)],
  // Required
  ["required", "refuse", Schema.String],
  ["a required transformation", "refuse", Schema.NumberFromString],
  ["NullOr", "refuse", Schema.NullOr(Schema.String)],
  ["UndefinedOr", "allow", Schema.UndefinedOr(Schema.String)],
  ["a set", "allow", Schema.ReadonlySet(Schema.String)],
  ["Unknown", "allow", Schema.Unknown],
  ["a record", "refuse", Schema.Record(Schema.String, Schema.Number)],
  ["a date", "refuse", Schema.DateTimeUtcFromString],
  // Values an absent attribute stands for, with the model's code on them
  ["a checked set", "decode", Schema.ReadonlySet(Schema.String).check(countedCheck)],
  ["a set of checked strings", "decode", Schema.ReadonlySet(Schema.String.check(countedCheck))],
  ["a checked UndefinedOr", "decode", Schema.UndefinedOr(Schema.String).check(countedCheck)],
  [
    "UndefinedOr of a checked string",
    "decode",
    Schema.UndefinedOr(Schema.String.check(countedCheck)),
  ],
  ["UndefinedOr of a transformation", "decode", Schema.UndefinedOr(Schema.NumberFromString)],
  [
    "a step over UndefinedOr",
    "decode",
    Schema.UndefinedOr(Schema.String).pipe(
      Schema.decodeTo(Schema.UndefinedOr(Schema.String), {
        decode: countedStep((s: string | undefined) => s),
        encode: SchemaGetter.passthrough(),
      } as never),
    ),
  ],
  ["NullOr of a set", "allow", Schema.NullOr(Schema.ReadonlySet(Schema.String))],
  ["a suspended UndefinedOr", "decode", Schema.suspend(() => Schema.UndefinedOr(Schema.String))],
  [
    "a flipped checked UndefinedOr",
    "decode",
    Schema.flip(Schema.UndefinedOr(Schema.String).check(countedCheck)) as unknown as Schema.Top,
  ],
  [
    "a custom declaration",
    "refuse",
    Schema.declare((u): u is unknown => {
      calls.count++
      return true
    }),
  ],
]

/**
 * Shapes whose row reads without the field, which the release branch refused to clear because
 * the stored key isn't optional: it never read the absence to find out, or took the stored key
 * for the read one. 1.39.0 wrote these and read them back, and the decision now says the same.
 */
const READS_WHERE_REFUSED = new Set([
  "a suspended default",
  "a step filling a required key",
  "a middleware filling a required key",
  "required when stored, optional once decoded",
])

describe("how it's decided whether a row can lack a field", () => {
  for (const [name, decision, field] of SHAPES) {
    const where = decision === "decode" ? "(b) read at the write" : `(a) the schema: ${decision}`
    it(`${name}: ${where}`, () => {
      calls.count = 0
      expect(lackDecision(field)).toBe(decision)
      expect(calls.count).toBe(0)
      const answer = was(field)
      // The write's own answer, reading the absence where (b) decides.
      const reads = READS_WHERE_REFUSED.has(name)
      if (reads) expect(answer).toBe(false)
      else if (decision === "allow") expect(answer).toBe(true)
      else if (decision === "refuse") expect(answer).toBe(false)
      expect(rowCanLack(field)).toBe(reads ? true : answer)
    })
  }

  it("a schema-decided field's write runs nothing; a read-decided one runs the model's code", () => {
    calls.count = 0
    for (const [, decision, field] of SHAPES) if (decision !== "decode") rowCanLack(field)
    expect(calls.count).toBe(0)

    calls.count = 0
    expect(rowCanLack(Schema.String.pipe(Schema.withDecodingDefaultKey(counted("d"))))).toBe(true)
    expect(calls.count).toBe(1)
    calls.count = 0
    expect(rowCanLack(Schema.ReadonlySet(Schema.String).check(countedCheck))).toBe(true)
    expect(calls.count).toBe(1)
  })

  describe("where only reading the absence can say, the write's read says no", () => {
    const REFUSED: ReadonlyArray<readonly [string, Schema.Top]> = [
      [
        "a default its own check refuses",
        Schema.String.check(Schema.makeFilter((s: string) => s.length > 5)).pipe(
          Schema.withDecodingDefaultKey(Effect.succeed("x")),
        ),
      ],
      [
        "a default that fails",
        Schema.String.pipe(
          Schema.withDecodingDefaultKey(
            Effect.fail(
              new SchemaIssue.InvalidValue(undefined),
            ) as unknown as Effect.Effect<string>,
          ),
        ),
      ],
      [
        "a step of one's own refusing an absent key",
        Schema.optionalKey(Schema.String).pipe(
          Schema.decodeTo(Schema.String, {
            decode: SchemaGetter.required(),
            encode: SchemaGetter.passthrough(),
          } as never),
        ),
      ],
      [
        "a step of one's own leaving an absent key absent",
        Schema.optionalKey(Schema.String).pipe(
          Schema.decodeTo(Schema.String, {
            decode: SchemaGetter.transformOptional((o) => o),
            encode: SchemaGetter.passthrough(),
          } as never),
        ),
      ],
      ["a set that mustn't be empty", Schema.ReadonlySet(Schema.String).check(Schema.isMinSize(1))],
      [
        "an undefined its check refuses",
        Schema.UndefinedOr(Schema.String).check(Schema.makeFilter((s) => s !== undefined)),
      ],
    ]
    for (const [name, field] of REFUSED) {
      it(`${name}: (b), and a row can't lack it`, () => {
        expect(lackDecision(field)).toBe("decode")
        expect(was(field)).toBe(false)
        expect(rowCanLack(field)).toBe(false)
      })
    }
  })
})

describe("defining an entity runs none of a model's code", () => {
  class Address extends Schema.Class<Address>("RONAddress")({
    city: Schema.String.pipe(Schema.withDecodingDefaultKey(counted("Paris"))),
  }) {}
  const Model = Schema.Struct({
    id: Schema.String,
    plain: Schema.String.pipe(Schema.withDecodingDefaultKey(counted("p"))),
    renamed: Schema.String.pipe(Schema.withDecodingDefault(counted("r"))),
    checked: Schema.Number.check(countedCheck).pipe(Schema.withDecodingDefaultKey(counted(1))),
    transformed: Schema.NumberFromString.pipe(Schema.withDecodingDefaultKey(counted("1"))),
    address: Schema.optional(Address),
    defaultedAddress: Address.pipe(Schema.withDecodingDefaultKey(counted({ city: "Rome" }))),
    tags: Schema.Record(Schema.String, Schema.Number).pipe(
      Schema.withDecodingDefaultKey(counted({})),
    ),
    details: Schema.Struct({ note: Schema.String }).pipe(
      Schema.withDecodingDefaultKey(counted({ note: "n" })),
    ),
    option: Schema.OptionFromOptionalKey(Schema.String),
    union: Schema.Union([Schema.String, Schema.Number]).pipe(
      Schema.withDecodingDefaultKey(counted("u")),
    ),
    later: Schema.suspend(() => Schema.String).pipe(Schema.withDecodingDefaultKey(counted("l"))),
    labels: Schema.ReadonlySet(Schema.String).check(countedCheck),
    note: Schema.UndefinedOr(Schema.String).check(countedCheck),
    nested: Schema.Struct({ labels: Schema.ReadonlySet(Schema.String).check(countedCheck) }),
    maybe: Schema.Option(Schema.ReadonlySet(Schema.String).check(countedCheck)),
  })
  const define = (model: Schema.Top) =>
    Entity.make({
      model,
      entityType: "Row",
      primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
    } as never) as unknown as Entity.EntityDefinition

  const configured = DynamoModel.configure(Model, {
    renamed: { field: "r" },
    tags: { storedAs: DynamoModel.SparseMap() },
    details: { storedAs: DynamoModel.Packed({ format: "json" }) },
  } as never)

  it("as a plain model, and configured: renamed, sparse and packed", () => {
    for (const model of [Model, configured]) {
      calls.count = 0
      define(model as Schema.Top)
      expect(calls.count).toBe(0)
    }
  })

  it("and decides each field the library asks about without running it", () => {
    for (const model of [Model, configured]) {
      const definition = define(model as Schema.Top)
      const written = (
        definition.schemas.writeModelSchema as unknown as {
          readonly fields: Record<string, Schema.Top>
        }
      ).fields
      const judged: ReadonlyArray<Schema.Top> = [
        ...Object.values(definition._data.modelFields),
        ...Object.values(written),
      ]
      expect(judged).toHaveLength(2 * Object.keys(Model.fields).length)
      calls.count = 0
      for (const field of judged) lackDecision(field)
      expect(calls.count).toBe(0)
      for (const field of judged) expect(rowCanLack(field)).toBe(was(field))
    }
  })
})
