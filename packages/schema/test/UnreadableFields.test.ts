/**
 * `[EDD-9125]` beyond maps, on the pure makes and the rule itself: what each owner refuses, what it
 * takes, and what it can't judge. Maps have `ReadonlyMapFields.test.ts`. Streams and outboxes are in
 * `effect-dynamodb`'s test of this name, and what's taken is stored and read back in its connected
 * suite.
 */

import {
  Chunk,
  DateTime,
  Effect,
  Redacted,
  Schema,
  SchemaGetter,
  SchemaTransformation,
} from "effect"
import { describe, expect, it } from "vitest"
import * as Aggregate from "../src/Aggregate.js"
import * as DynamoModel from "../src/DynamoModel.js"
import * as DynamoSchema from "../src/DynamoSchema.js"
import * as Entity from "../src/Entity.js"
import { refuseUnreadable, type StoredBy } from "../src/internal/SchemaAccessors.js"

const AppSchema = DynamoSchema.make({ name: "app", version: 1 })
const table = { Tag: Symbol.for("test/table") }

const modelOf = (field: Schema.Top) => Schema.Struct({ id: Schema.String, f: field as never })

const entity = (model: unknown) =>
  Entity.make({
    model: model as never,
    entityType: "E",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
  } as never)

const aggregate = (model: unknown, edges: Record<string, unknown> = {}) =>
  (Aggregate.make as any)(model, {
    table,
    schema: AppSchema,
    pk: { field: "pk", composite: ["id"] },
    collection: { index: "gsi1", name: "agg", sk: { field: "gsi1sk", composite: [] } },
    root: { entityType: "Agg" },
    edges,
  })

const subAggregate = (model: unknown, edges: Record<string, unknown> = {}) =>
  (Aggregate.make as any)(model, { root: { entityType: "Sub" }, edges })

/** What a refused definition throws. */
const refusal = (run: () => unknown): string => {
  try {
    run()
  } catch (error) {
    return String((error as Error).message)
  }
  return "nothing refused"
}

const judged = (by: StoredBy, field: Schema.Top) =>
  refusal(() => refuseUnreadable("Owner", by, modelOf(field)))

class Point {
  constructor(
    readonly x: number,
    readonly y: number,
  ) {}
}

/** Refused whatever stores it, with what the refusal names and what it points to. */
const EVERY_OWNER: ReadonlyArray<readonly [Schema.Top, string, string, Schema.Top]> = [
  [Schema.URL, "Schema.URL", "Schema.URLFromString", Schema.URLFromString],
  [
    Schema.ByteSize,
    "Schema.ByteSize",
    "Schema.ByteSizeFromString or Schema.ByteSizeFromNumber",
    Schema.ByteSizeFromString,
  ],
  [Schema.URLSearchParams, "Schema.URLSearchParams", "Schema.String", Schema.String],
  [Schema.RegExp, "Schema.RegExp", "Schema.String", Schema.String],
  [
    Schema.FormData,
    "Schema.FormData",
    "Schema.Record",
    Schema.Record(Schema.String, Schema.String),
  ],
  [Schema.Headers, "Schema.Headers", "Schema.Record", Schema.Record(Schema.String, Schema.String)],
  [Schema.File, "Schema.File", "Schema.Uint8Array", Schema.Uint8Array],
  [Schema.ErrorInstance(), "Schema.ErrorInstance", "Schema.Defect()", Schema.Defect()],
  [Schema.Chunk(Schema.String), "Schema.Chunk", "Schema.Array", Schema.Array(Schema.String)],
  [
    Schema.HashMap(Schema.String, Schema.Number),
    "Schema.HashMap",
    "Schema.Record",
    Schema.Record(Schema.String, Schema.Number),
  ],
  [
    Schema.ReadonlyMap(Schema.String, Schema.Number),
    "Schema.ReadonlyMap",
    "Schema.Record",
    Schema.Record(Schema.String, Schema.Number),
  ],
]

const MAKES: ReadonlyArray<readonly [string, (model: unknown) => unknown, string]> = [
  ["Entity.make", entity, 'Entity "E"'],
  ["Aggregate.make", aggregate, 'Aggregate "Agg"'],
  ["Aggregate.make, a sub-aggregate", subAggregate, 'Aggregate "Sub"'],
]

for (const [make, build, owner] of MAKES) {
  describe(`[EDD-9125] ${make}`, () => {
    for (const [field, name, use, replacement] of EVERY_OWNER) {
      it(`refuses ${name}, pointing to ${use}, which it takes`, () => {
        const message = refusal(() => build(modelOf(field)))
        expect(message).toContain(`[EDD-9125] ${owner}: field "f" is a ${name}, which can't`)
        expect(message).toContain(`Use ${use}`)
        expect(refusal(() => build(modelOf(replacement)))).toBe("nothing refused")
      })

      it(`refuses ${name} in a struct, an array and a record, naming the path`, () => {
        for (const [wrapped, path] of [
          [Schema.Struct({ n: field as never }), "f.n"],
          [Schema.Array(field as never), "f[]"],
          [Schema.Record(Schema.String, field as never), "f[key]"],
          [Schema.NullOr(field as never), "f"],
          [Schema.optional(field as never), "f"],
          [Schema.Option(field as never), "f"],
          [Schema.suspend(() => field as never), "f"],
        ] as const) {
          expect(refusal(() => build(modelOf(wrapped)))).toContain(`field "${path}" is a ${name}`)
        }
      })
    }
  })
}

describe("[EDD-9125] what reads back on every owner stays", () => {
  const STAYS: ReadonlyArray<readonly [string, Schema.Top]> = [
    ["Schema.Duration", Schema.Duration],
    ["Schema.DurationFromMillis", Schema.DurationFromMillis],
    ["Schema.Option", Schema.Option(Schema.String)],
    ["Schema.Result", Schema.Result(Schema.String, Schema.Number)],
    ["Schema.Exit", Schema.Exit(Schema.String, Schema.String, Schema.Defect())],
    ["Schema.Cause", Schema.Cause(Schema.String, Schema.Defect())],
    ["Schema.ReadonlySet", Schema.ReadonlySet(Schema.String)],
    ["Schema.Uint8Array", Schema.Uint8Array],
    ["Schema.Json", Schema.Json],
    ["Schema.DateTimeUtc", Schema.DateTimeUtc],
    ["Schema.DateTimeZoned", Schema.DateTimeZoned],
    ["Schema.TimeZone", Schema.TimeZone],
    ["Schema.SemVer", Schema.SemVer],
    // Reads back with broken arithmetic, or never writes: the guide says so. No row can't be read.
    ["Schema.BigDecimal", Schema.BigDecimal],
    ["Schema.BigDecimalFromString", Schema.BigDecimalFromString],
    // An empty one reads back and a non-empty one is refused at write, naming the field.
    ["Schema.HashSet", Schema.HashSet(Schema.String)],
    // A map whose stored side is something else.
    ["Schema.toCodecJson of a URL", Schema.toCodecJson(Schema.URL)],
    ["Schema.toCodecJson of a chunk", Schema.toCodecJson(Schema.Chunk(Schema.String))],
    ["Schema.DateFromString", Schema.DateFromString],
    ["Schema.DateFromMillis", Schema.DateFromMillis],
    ["Schema.DateTimeUtcFromString", Schema.DateTimeUtcFromString],
    ["Schema.DateTimeUtcFromMillis", Schema.DateTimeUtcFromMillis],
    ["Schema.RedactedFromValue", Schema.RedactedFromValue(Schema.String)],
    ["Schema.BigIntFromString", Schema.BigIntFromString],
    ["a string literal", Schema.Literal("a")],
    ["a number literal", Schema.Literal(1)],
    ["Schema.Unknown", Schema.Unknown],
  ]

  for (const [name, field] of STAYS) {
    it(`${name}, wherever it's stored`, () => {
      for (const by of ["entity", "aggregate", "schema"] as const) {
        expect(judged(by, field)).toBe("nothing refused")
      }
    })
  }

  it("a declaration of your own: a Schema.instanceOf and a duck-typed one have the same AST", () => {
    const instance = Schema.instanceOf(Point)
    const ducked = Schema.declare(
      (input: unknown): input is Point =>
        typeof input === "object" && input !== null && "x" in input,
    )
    for (const by of ["entity", "aggregate", "schema"] as const) {
      expect(judged(by, instance)).toBe("nothing refused")
      expect(judged(by, ducked)).toBe("nothing refused")
    }
  })
})

/** A field, what each owner says of it: a name refused, or undefined for taken. */
const BY_OWNER: ReadonlyArray<
  readonly [
    name: string,
    field: Schema.Top,
    entity: string | undefined,
    aggregate: string | undefined,
    schema: string | undefined,
  ]
> = (() => {
  const date = "a Schema.Date"
  const redacted = "a Schema.Redacted"
  const bigint = "a Schema.BigInt"
  const overDate = "a transformation over Schema.Date"
  const overBigint = "a transformation over Schema.BigInt"
  const same = SchemaTransformation.passthrough() as never
  const literal = "a bigint Schema.Literal"
  const F = Schema.DateTimeUtcFromDate
  const customDate = Schema.Date.pipe(
    Schema.decodeTo(Schema.Number, {
      decode: SchemaGetter.transform((d: Date) => d.getTime()),
      encode: SchemaGetter.transform((n: number) => new Date(n)),
    }),
  )
  class WithDate extends Schema.Class<WithDate>("WithDate")({ d: Schema.Date }) {}
  class WithBigint extends Schema.Class<WithBigint>("WithBigint")({ n: Schema.BigInt }) {}
  const overItself = <S extends Schema.Top>(from: S) =>
    from.pipe(Schema.decodeTo(from as never, SchemaTransformation.passthrough() as never))
  const customInstant = Schema.Date.pipe(
    Schema.decodeTo(Schema.DateTimeUtc, {
      decode: SchemaGetter.transform((d: Date) => DateTime.fromDateUnsafe(d)),
      encode: SchemaGetter.transform((u: DateTime.Utc) => DateTime.toDateUtc(u)),
    }),
  )
  return [
    ["Schema.Date", Schema.Date, undefined, undefined, date],
    ["a branded date", Schema.Date.pipe(Schema.brand("D")), undefined, undefined, date],
    [
      "a checked date",
      Schema.Date.check(Schema.isGreaterThanDate(new Date(0))),
      undefined,
      undefined,
      date,
    ],
    ["a date in a struct", Schema.Struct({ d: Schema.Date }), undefined, undefined, date],
    ["a date in an array", Schema.Array(Schema.Date), undefined, undefined, date],
    ["a date in a record", Schema.Record(Schema.String, Schema.Date), undefined, undefined, date],
    ["a date in a tuple", Schema.Tuple([Schema.Date]), undefined, undefined, date],
    ["a date in a union", Schema.Union([Schema.Date, Schema.String]), undefined, undefined, date],
    ["a date or null", Schema.NullOr(Schema.Date), undefined, undefined, date],
    ["an optional date", Schema.optional(Schema.Date), undefined, undefined, date],
    ["a date under an Option", Schema.Option(Schema.Date), date, date, date],
    ["a date in a set", Schema.ReadonlySet(Schema.Date), date, date, date],
    [
      "a date in a struct under an Option",
      Schema.Option(Schema.Struct({ d: Schema.Date })),
      date,
      date,
      date,
    ],
    [
      "a date with a decoding default",
      Schema.Date.pipe(Schema.withDecodingDefault(Effect.succeed(new Date(0)))),
      undefined,
      undefined,
      date,
    ],
    [
      "a date with a decoding default on the key",
      Schema.Date.pipe(Schema.withDecodingDefaultKey(Effect.succeed(new Date(0)))),
      undefined,
      undefined,
      date,
    ],
    [
      "a redacted value with a decoding default",
      Schema.Redacted(Schema.String).pipe(
        Schema.withDecodingDefault(Effect.succeed(Redacted.make("a"))),
      ),
      undefined,
      undefined,
      redacted,
    ],
    [
      "a date or a string with a decoding default, either way",
      Schema.Union([Schema.Date, Schema.String]).pipe(
        Schema.withDecodingDefault(Effect.succeed("a")),
      ),
      date,
      date,
      date,
    ],
    [
      "a date or null with a decoding default on an optional stored side",
      Schema.NullOr(Schema.Date).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
      date,
      undefined,
      date,
    ],
    [
      "a date in a struct with a decoding default on an optional stored side",
      Schema.Struct({ d: Schema.Date }).pipe(
        Schema.withDecodingDefault(Effect.succeed({ d: new Date(0) })),
      ),
      date,
      date,
      date,
    ],
    [
      "a date under an Option with a decoding default",
      Schema.Option(Schema.Date).pipe(Schema.withDecodingDefault(Effect.die("unused"))),
      date,
      date,
      date,
    ],

    ["Schema.Redacted", Schema.Redacted(Schema.String), undefined, undefined, redacted],
    [
      "Schema.Redacted in an array",
      Schema.Array(Schema.Redacted(Schema.String)),
      undefined,
      undefined,
      redacted,
    ],
    [
      "Schema.Redacted under an Option",
      Schema.Option(Schema.Redacted(Schema.String)),
      redacted,
      redacted,
      redacted,
    ],

    ["Schema.BigInt", Schema.BigInt, undefined, undefined, bigint],
    ["a bigint in a struct", Schema.Struct({ n: Schema.BigInt }), undefined, undefined, bigint],
    ["a bigint in an array", Schema.Array(Schema.BigInt), undefined, undefined, bigint],
    ["an optional bigint", Schema.optional(Schema.BigInt), undefined, undefined, bigint],
    ["an optional key's bigint", Schema.optionalKey(Schema.BigInt), undefined, undefined, bigint],
    [
      "a bigint with a decoding default",
      Schema.BigInt.pipe(Schema.withDecodingDefault(Effect.succeed(0n))),
      undefined,
      undefined,
      bigint,
    ],
    ["a bigint or null", Schema.NullOr(Schema.BigInt), undefined, undefined, bigint],
    ["a bigint or undefined", Schema.UndefinedOr(Schema.BigInt), undefined, undefined, bigint],
    [
      "a bigint in a union",
      Schema.Union([Schema.BigInt, Schema.String]),
      undefined,
      undefined,
      bigint,
    ],
    [
      "a bigint next to a number",
      Schema.Union([Schema.Number, Schema.BigInt]),
      undefined,
      undefined,
      bigint,
    ],
    [
      "a bigint in a oneOf union",
      Schema.Union([Schema.BigInt, Schema.String], { mode: "oneOf" }),
      undefined,
      undefined,
      bigint,
    ],
    [
      "a bigint in a struct or null",
      Schema.NullOr(Schema.Struct({ n: Schema.BigInt })),
      undefined,
      undefined,
      bigint,
    ],
    [
      "a list of a bigint or null",
      Schema.Array(Schema.NullOr(Schema.BigInt)),
      undefined,
      undefined,
      bigint,
    ],
    [
      "a bigint or null with a decoding default",
      Schema.NullOr(Schema.BigInt).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
      undefined,
      undefined,
      bigint,
    ],
    [
      "a bigint in a struct with a decoding default",
      Schema.Struct({ n: Schema.BigInt }).pipe(
        Schema.withDecodingDefault(Effect.succeed({ n: 0n })),
      ),
      undefined,
      undefined,
      bigint,
    ],
    ["a suspended bigint", Schema.suspend(() => Schema.BigInt), bigint, bigint, bigint],
    ["a suspended date", Schema.suspend(() => Schema.Date), date, date, date],
    [
      "a suspended redacted value",
      Schema.suspend(() => Schema.Redacted(Schema.String)),
      redacted,
      redacted,
      redacted,
    ],
    [
      "a date in a suspended struct",
      Schema.suspend(() => Schema.Struct({ d: Schema.Date })),
      date,
      date,
      date,
    ],
    [
      "a date in a struct with a decoding default",
      Schema.Struct({ d: Schema.Date }).pipe(
        Schema.withDecodingDefaultKey(Effect.succeed({ d: new Date(0) })),
      ),
      date,
      date,
      date,
    ],
    [
      "a date in a record with a decoding default",
      Schema.Record(Schema.String, Schema.Date).pipe(
        Schema.withDecodingDefaultKey(Effect.succeed({})),
      ),
      date,
      date,
      date,
    ],
    [
      "a date in a tuple with a decoding default",
      Schema.Tuple([Schema.Date]).pipe(
        Schema.withDecodingDefaultKey(Effect.succeed([new Date(0)] as const)),
      ),
      date,
      date,
      date,
    ],
    [
      "a date or null with a decoding default",
      Schema.NullOr(Schema.Date).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
      date,
      undefined,
      date,
    ],
    [
      "a field of a date or null with a decoding default",
      Schema.Struct({
        x: Schema.NullOr(Schema.Date).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
      }),
      date,
      date,
      date,
    ],
    [
      "a date or a string with a decoding default",
      Schema.Union([Schema.Date, Schema.String]).pipe(
        Schema.withDecodingDefaultKey(Effect.succeed("a")),
      ),
      date,
      date,
      date,
    ],
    [
      "a transformed date or null with a decoding default",
      Schema.NullOr(F).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
      date,
      date,
      date,
    ],
    [
      "a list of dates with a decoding default",
      Schema.Array(Schema.Date).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
      undefined,
      undefined,
      date,
    ],
    [
      "a list of a date or null with a decoding default",
      Schema.Array(Schema.NullOr(Schema.Date)).pipe(
        Schema.withDecodingDefaultKey(Effect.succeed([])),
      ),
      date,
      date,
      date,
    ],
    [
      "a redacted value in a struct with a decoding default",
      Schema.Struct({ r: Schema.Redacted(Schema.String) }).pipe(
        Schema.withDecodingDefaultKey(Effect.succeed({ r: Redacted.make("a") })),
      ),
      redacted,
      redacted,
      redacted,
    ],
    [
      "a date in a class with a decoding default",
      WithDate.pipe(Schema.withDecodingDefaultKey(Effect.succeed({ d: new Date(0) }))),
      date,
      date,
      date,
    ],
    ["a date over itself", overItself(Schema.Date), overDate, undefined, overDate],
    [
      "a date over itself, or null",
      Schema.NullOr(overItself(Schema.Date)),
      overDate,
      overDate,
      overDate,
    ],
    [
      "a date over itself with a decoding default",
      overItself(Schema.Date).pipe(Schema.withDecodingDefault(Effect.die("unused"))),
      overDate,
      undefined,
      overDate,
    ],
    ["a bigint over itself", overItself(Schema.BigInt), overBigint, overBigint, overBigint],
    [
      "a bigint over itself, or null",
      Schema.NullOr(overItself(Schema.BigInt)),
      overBigint,
      overBigint,
      overBigint,
    ],
    [
      "a bigint over itself with a decoding default",
      overItself(Schema.BigInt).pipe(Schema.withDecodingDefault(Effect.die("unused"))),
      overBigint,
      overBigint,
      overBigint,
    ],
    [
      "a bigint in a class with a decoding default",
      WithBigint.pipe(Schema.withDecodingDefaultKey(Effect.succeed({ n: 0n }))),
      undefined,
      undefined,
      bigint,
    ],
    [
      "a bigint on an optional stored side, decoded to a number",
      Schema.optionalKey(Schema.BigInt).pipe(
        Schema.decodeTo(Schema.Number, SchemaTransformation.passthrough() as never),
      ),
      overBigint,
      overBigint,
      overBigint,
    ],
    [
      "a date on an optional stored side, decoded to something of your own",
      Schema.optionalKey(Schema.Date).pipe(
        Schema.decodeTo(
          Schema.declare((input: unknown): input is number => typeof input === "number"),
          SchemaTransformation.passthrough() as never,
        ),
      ),
      overDate,
      overDate,
      overDate,
    ],
    [
      "a struct with a bigint on an optional stored side, decoded to another struct",
      Schema.optionalKey(Schema.Struct({ n: Schema.BigInt })).pipe(
        Schema.decodeTo(
          Schema.Struct({ x: Schema.String }),
          SchemaTransformation.passthrough() as never,
        ),
      ),
      bigint,
      bigint,
      bigint,
    ],
    [
      "a struct with a bigint on an optional stored side, decoded to one more field",
      Schema.optionalKey(Schema.Struct({ n: Schema.BigInt })).pipe(
        Schema.decodeTo(
          Schema.Struct({ n: Schema.BigInt, x: Schema.String }),
          SchemaTransformation.passthrough() as never,
        ),
      ),
      bigint,
      bigint,
      bigint,
    ],
    [
      "a struct with a bigint or a string on an optional stored side, decoded to the struct",
      Schema.optionalKey(Schema.Union([Schema.Struct({ n: Schema.BigInt }), Schema.String])).pipe(
        Schema.decodeTo(
          Schema.Struct({ n: Schema.BigInt }),
          SchemaTransformation.passthrough() as never,
        ),
      ),
      bigint,
      bigint,
      bigint,
    ],
    [
      "a struct with a bigint and more on an optional stored side, decoded to fewer fields",
      Schema.optionalKey(Schema.Struct({ n: Schema.BigInt, x: Schema.String })).pipe(
        Schema.decodeTo(
          Schema.Struct({ n: Schema.BigInt }),
          SchemaTransformation.passthrough() as never,
        ),
      ),
      bigint,
      bigint,
      bigint,
    ],
    [
      "a bigint transformed from one on an optional stored side, a node at a time",
      Schema.optionalKey(Schema.BigInt).pipe(
        Schema.decodeTo(Schema.BigInt, same),
        Schema.decodeTo(Schema.BigInt, same),
      ),
      overBigint,
      overBigint,
      overBigint,
    ],
    [
      "a bigint transformed from one on an optional stored side, in one chain of three",
      Schema.optionalKey(Schema.BigInt).pipe(
        Schema.decodeTo(
          Schema.BigInt.pipe(
            Schema.decodeTo(Schema.BigInt.pipe(Schema.decodeTo(Schema.BigInt, same)), same),
          ),
          same,
        ),
      ),
      overBigint,
      overBigint,
      overBigint,
    ],
    [
      "a bigint on an optional stored side that's a transformation itself",
      Schema.optionalKey(Schema.BigInt.pipe(Schema.decodeTo(Schema.BigInt, same))).pipe(
        Schema.decodeTo(Schema.BigInt, same),
      ),
      undefined,
      undefined,
      bigint,
    ],
    [
      "a bigint on an optional stored side that's transformed to a number there",
      Schema.optionalKey(Schema.BigInt.pipe(Schema.decodeTo(Schema.Number, same))).pipe(
        Schema.decodeTo(Schema.Number, same),
      ),
      overBigint,
      overBigint,
      overBigint,
    ],
    [
      "a date on an optional stored side that's transformed to a number there",
      Schema.optionalKey(Schema.Date.pipe(Schema.decodeTo(Schema.Number, same))).pipe(
        Schema.decodeTo(Schema.Number, same),
      ),
      overDate,
      overDate,
      overDate,
    ],
    [
      "a list of bigints or undefined, decoded to the list",
      Schema.UndefinedOr(Schema.Array(Schema.BigInt)).pipe(
        Schema.decodeTo(Schema.Array(Schema.BigInt), same),
      ),
      undefined,
      bigint,
      bigint,
    ],
    [
      "a date or undefined with a decoding default",
      Schema.UndefinedOr(Schema.Date).pipe(
        Schema.withDecodingDefaultKey(Effect.succeed(undefined)),
      ),
      date,
      undefined,
      date,
    ],
    [
      "a date or undefined with a decoding default on an optional stored side",
      Schema.UndefinedOr(Schema.Date).pipe(Schema.withDecodingDefault(Effect.succeed(undefined))),
      date,
      undefined,
      date,
    ],
    [
      "a bigint or undefined with a decoding default",
      Schema.UndefinedOr(Schema.BigInt).pipe(
        Schema.withDecodingDefaultKey(Effect.succeed(undefined)),
      ),
      undefined,
      undefined,
      bigint,
    ],
    [
      "a transformed date, optional, in a struct or null",
      Schema.NullOr(Schema.Struct({ a: Schema.optional(F) })),
      overDate,
      overDate,
      overDate,
    ],
    ["a date in a class", WithDate, undefined, undefined, date],
    ["a bigint in a class", WithBigint, undefined, undefined, bigint],
    [
      "a transformation over a struct with a date",
      overItself(Schema.Struct({ d: Schema.Date })),
      date,
      date,
      date,
    ],
    [
      "a transformation over a struct with a bigint",
      overItself(Schema.Struct({ n: Schema.BigInt })),
      bigint,
      bigint,
      bigint,
    ],
    [
      "a transformation over a struct with a redacted value",
      overItself(Schema.Struct({ r: Schema.Redacted(Schema.String) })),
      redacted,
      redacted,
      redacted,
    ],
    [
      "a list of dates transformed to one",
      overItself(Schema.Array(Schema.Date)),
      undefined,
      date,
      date,
    ],
    [
      "a list of bigints transformed to one",
      overItself(Schema.Array(Schema.BigInt)),
      undefined,
      bigint,
      bigint,
    ],
    [
      "a list of lists of bigints transformed to one",
      overItself(Schema.Array(Schema.Array(Schema.BigInt))),
      undefined,
      bigint,
      bigint,
    ],
    [
      "a list of a bigint or null transformed to one",
      overItself(Schema.Array(Schema.NullOr(Schema.BigInt))),
      bigint,
      bigint,
      bigint,
    ],
    [
      "renamed keys over a date",
      Schema.Struct({ d: Schema.Date }).pipe(Schema.encodeKeys({ d: "e" })),
      date,
      date,
      date,
    ],
    [
      "an Option from a struct with a bigint or null",
      Schema.OptionFromNullOr(Schema.Struct({ n: Schema.BigInt })),
      bigint,
      bigint,
      bigint,
    ],
    [
      "an Option from an optional key's struct with a bigint",
      Schema.OptionFromOptionalKey(Schema.Struct({ n: Schema.BigInt })),
      bigint,
      bigint,
      bigint,
    ],
    [
      "a map from a record of dates",
      Schema.Record(Schema.String, Schema.Date).pipe(
        Schema.decodeTo(Schema.ReadonlyMap(Schema.String, Schema.Date), {
          decode: SchemaGetter.transform(
            (r: Readonly<Record<string, Date>>) => new Map(Object.entries(r)),
          ),
          encode: SchemaGetter.transform((m: ReadonlyMap<string, Date>) => Object.fromEntries(m)),
        }),
      ),
      date,
      date,
      date,
    ],
    ["a bigint under an Option", Schema.Option(Schema.BigInt), bigint, bigint, bigint],
    ["a bigint in a set", Schema.ReadonlySet(Schema.BigInt), bigint, bigint, bigint],
    ["Schema.DurationFromNanos", Schema.DurationFromNanos, overBigint, overBigint, overBigint],
    ["Schema.ByteSizeFromBigInt", Schema.ByteSizeFromBigInt, overBigint, overBigint, overBigint],
    [
      "your own over a bigint, to a number",
      Schema.BigInt.pipe(
        Schema.decodeTo(Schema.Number, {
          decode: SchemaGetter.transform((b: bigint) => Number(b)),
          encode: SchemaGetter.transform((n: number) => BigInt(n)),
        }),
      ),
      overBigint,
      overBigint,
      overBigint,
    ],
    [
      "a bigint in an optional field, in a struct, or null",
      Schema.NullOr(Schema.Struct({ n: Schema.optional(Schema.BigInt) })),
      undefined,
      undefined,
      bigint,
    ],
    ["a bigint literal", Schema.Literal(1n), literal, literal, literal],
    ["bigint literals", Schema.Literals([1n, 2n]), literal, literal, literal],
    ["a literal that may be a bigint", Schema.Literals([1n, "a"]), literal, literal, literal],

    ["Schema.DateTimeUtcFromDate", F, overDate, undefined, overDate],
    ["an optional one", Schema.optional(F), overDate, undefined, overDate],
    ["an optional key's", Schema.optionalKey(F), overDate, undefined, overDate],
    ["one in a struct", Schema.Struct({ n: F }), overDate, undefined, overDate],
    ["one in an array", Schema.Array(F), overDate, undefined, overDate],
    ["one in a record", Schema.Record(Schema.String, F), overDate, undefined, overDate],
    ["one or null", Schema.NullOr(F), overDate, overDate, overDate],
    ["one or undefined", Schema.UndefinedOr(F), overDate, overDate, overDate],
    ["one in a union", Schema.Union([F, Schema.String]), overDate, overDate, overDate],
    [
      "one in a struct in a union",
      Schema.Union([Schema.Struct({ d: F }), Schema.String]),
      overDate,
      overDate,
      overDate,
    ],
    [
      "one in an array of them or null",
      Schema.Array(Schema.NullOr(F)),
      overDate,
      overDate,
      overDate,
    ],
    ["your own over a date, to a number", customDate, overDate, overDate, overDate],
    [
      "your own to a number, over Schema.DateTimeUtcFromDate",
      F.pipe(
        Schema.decodeTo(Schema.Number, {
          decode: SchemaGetter.transform((u: DateTime.Utc) => DateTime.toEpochMillis(u)),
          encode: SchemaGetter.transform((n: number) => DateTime.makeUnsafe(n)),
        }),
      ),
      overDate,
      overDate,
      overDate,
    ],
    ["that, optional", Schema.optional(customDate), overDate, overDate, overDate],
    ["that, in a struct", Schema.Struct({ d: customDate }), overDate, overDate, overDate],
    ["that, in an array", Schema.Array(customDate), overDate, overDate, overDate],
    ["your own over a date, to an instant", customInstant, overDate, undefined, overDate],
    ["that, in a struct", Schema.Struct({ d: customInstant }), overDate, undefined, overDate],
    ["that, in an array", Schema.Array(customInstant), overDate, undefined, overDate],
    ["that, or null", Schema.NullOr(customInstant), overDate, overDate, overDate],
  ]
})()

describe("[EDD-9125] what depends on what stores it", () => {
  for (const [name, field, onEntity, onAggregate, onSchema] of BY_OWNER) {
    for (const [by, expected] of [
      ["entity", onEntity],
      ["aggregate", onAggregate],
      ["schema", onSchema],
    ] as const) {
      it(`${name}, stored by ${by}: ${expected ?? "taken"}`, () => {
        const message = judged(by, field)
        if (expected === undefined) expect(message).toBe("nothing refused")
        else expect(message).toContain(`is ${expected}`)
      })
    }
  }

  it("says the positions it doesn't reach, and a union isn't one of them for a bigint", () => {
    const beneath = judged("entity", Schema.Option(Schema.BigInt))
    expect(beneath).toContain(
      "isn't under another declaration, a Schema.suspend or a transformation",
    )
    expect(beneath).not.toContain("union")
    expect(judged("entity", Schema.Option(Schema.Date))).toContain(
      "isn't under another declaration, a Schema.suspend, a transformation or a decoding default on a container",
    )
    expect(
      judged(
        "entity",
        Schema.suspend(() => Schema.Redacted(Schema.String)),
      ),
    ).toContain(
      "isn't under another declaration, a Schema.suspend, a transformation or a decoding default on a container",
    )
  })

  it("the date encoder's exception is an attribute's own nullable plain date", () => {
    const defaulted = (field: Schema.Top) =>
      (field as Schema.Codec<any>).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null)))
    expect(judged("aggregate", defaulted(Schema.NullOr(Schema.Date)))).toBe("nothing refused")
    expect(judged("aggregate", defaulted(Schema.NullishOr(Schema.Date)))).toBe("nothing refused")
    expect(judged("aggregate", defaulted(Schema.NullOr(Schema.Redacted(Schema.String))))).toContain(
      "a Schema.Redacted",
    )
    expect(judged("aggregate", defaulted(Schema.NullOr(Schema.DateTimeUtcFromDate)))).toContain(
      "a Schema.Date",
    )
    expect(judged("aggregate", Schema.Array(defaulted(Schema.NullOr(Schema.Date))))).toContain(
      "a Schema.Date",
    )
    expect(
      judged(
        "aggregate",
        Schema.NullOr(Schema.Date).pipe(
          Schema.decodeTo(Schema.NullOr(Schema.Date), SchemaTransformation.passthrough() as never),
        ),
      ),
    ).toContain("a transformation over Schema.Date")
  })

  it("says what to use", () => {
    expect(judged("schema", Schema.Date)).toContain(
      "Use Schema.DateFromString or Schema.DateFromMillis.",
    )
    expect(judged("schema", Schema.Redacted(Schema.String))).toContain(
      "Use Schema.RedactedFromValue.",
    )
    expect(judged("schema", Schema.BigInt)).toContain("Use Schema.BigIntFromString.")
    expect(judged("entity", Schema.DateTimeUtcFromDate)).toContain(
      "Use Schema.DateTimeUtcFromString or Schema.DateTimeUtcFromMillis.",
    )
    expect(judged("entity", Schema.DurationFromNanos)).toContain("Schema.DurationFromMillis")
    expect(judged("entity", Schema.Literal(1n))).toContain("Use a string or a number literal.")
  })

  it("a Schema.Date on the make that substitutes it, and a Schema.DateTimeUtcFromDate on the one that doesn't", () => {
    expect(refusal(() => entity(modelOf(Schema.Date)))).toBe("nothing refused")
    expect(refusal(() => aggregate(modelOf(Schema.Date)))).toBe("nothing refused")
    expect(refusal(() => entity(modelOf(Schema.DateTimeUtcFromDate)))).toContain(
      'Entity "E": field "f" is a transformation over Schema.Date',
    )
    expect(refusal(() => aggregate(modelOf(Schema.DateTimeUtcFromDate)))).toBe("nothing refused")
    expect(
      refusal(() => subAggregate(modelOf(Schema.NullOr(Schema.DateTimeUtcFromDate)))),
    ).toContain('Aggregate "Sub": field "f" is a transformation over Schema.Date')
  })

  it("a class model's own field, and a configured model's", () => {
    class Model extends Schema.Class<Model>("UrlModel")({ id: Schema.String, u: Schema.URL }) {}
    expect(refusal(() => entity(Model))).toContain('field "u" is a Schema.URL')
    expect(refusal(() => aggregate(Model))).toContain('field "u" is a Schema.URL')
    const configured = DynamoModel.configure(
      modelOf(Schema.URL) as never,
      { id: { immutable: true } } as never,
    )
    expect(refusal(() => entity(configured))).toContain('field "f" is a Schema.URL')
  })

  it("a class nested under a date-holding field is walked through its encoding", () => {
    class Stamped extends Schema.Class<Stamped>("Stamped")({ at: Schema.Date }) {}
    expect(judged("schema", Stamped)).toContain('field "f.at" is a Schema.Date')
    expect(judged("entity", Stamped)).toBe("nothing refused")
    expect(judged("entity", Schema.Option(Stamped))).toContain('field "f.at" is a Schema.Date')
  })

  it("a type that's taken doesn't stop the walk at its own transformation", () => {
    const overUrl = Schema.URL.pipe(
      Schema.decodeTo(Schema.String, {
        decode: SchemaGetter.transform((url: URL) => url.href),
        encode: SchemaGetter.transform((text: string) => new URL(text)),
      }),
    )
    expect(judged("entity", overUrl)).toContain('field "f" is a Schema.URL')
  })

  it("a transformation with its own encoding is followed to what's stored in the end", () => {
    const overUrl = Schema.URL.pipe(
      Schema.decodeTo(Schema.DurationFromMillis, {
        decode: SchemaGetter.transform((_: URL) => 1),
        encode: SchemaGetter.transform((_: number) => new URL("https://example.com")),
      }),
    )
    expect(judged("entity", overUrl)).toContain('field "f" is a Schema.URL')
    expect(judged("aggregate", overUrl)).toContain('field "f" is a Schema.URL')
  })

  it("a date over a transformation over a date is judged by the last step", () => {
    const roundabout = Schema.Date.pipe(
      Schema.decodeTo(Schema.Number, {
        decode: SchemaGetter.transform((d: Date) => d.getTime()),
        encode: SchemaGetter.transform((n: number) => new Date(n)),
      }),
      Schema.decodeTo(Schema.Date, {
        decode: SchemaGetter.transform((n: number) => new Date(n)),
        encode: SchemaGetter.transform((d: Date) => d.getTime()),
      }),
    )
    expect(judged("entity", roundabout)).toContain("a transformation over Schema.Date")
    expect(judged("aggregate", roundabout)).toBe("nothing refused")
  })

  it("an aggregate's date encoder stores a date, whatever it's encoded over", () => {
    const overUrl = Schema.URL.pipe(
      Schema.decodeTo(Schema.DateFromString, {
        decode: SchemaGetter.transform((url: URL) => url.search.slice(1)),
        encode: SchemaGetter.transform((text: string) => new URL(`https://example.com?${text}`)),
      }),
    )
    expect(judged("aggregate", overUrl)).toBe("nothing refused")
    expect(judged("entity", overUrl)).toContain('field "f" is a Schema.URL')
    expect(judged("schema", overUrl)).toContain('field "f" is a Schema.URL')
    expect(judged("aggregate", Schema.NullOr(overUrl))).toContain('field "f" is a Schema.URL')
    expect(judged("aggregate", Schema.Option(overUrl))).toContain('field "f" is a Schema.URL')
  })

  it("a recursive schema ends where it starts", () => {
    interface Tree {
      readonly children: ReadonlyArray<Tree>
    }
    const Tree: Schema.Codec<Tree> = Schema.Struct({
      children: Schema.Array(Schema.suspend((): Schema.Codec<Tree> => Tree)),
    })
    expect(judged("entity", Tree)).toBe("nothing refused")
  })

  it("a model that is one says so, or what its owner calls it", () => {
    expect(refusal(() => refuseUnreadable("Owner", "schema", Schema.URL))).toContain(
      "the model is a Schema.URL",
    )
    expect(
      refusal(() => refuseUnreadable("Owner", "schema", Schema.URL, { whole: "the event" })),
    ).toContain("Owner: the event is a Schema.URL")
  })
})

describe("[EDD-9125] a many edge is rows", () => {
  const Line = Schema.Struct({ sku: Schema.String })

  it("what a many edge's collection holds is judged, when it isn't a row of fields", () => {
    const lines = Aggregate.many({
      entityType: "Line",
      sk: { composite: ["sku"] },
      decompose: () => [],
      assemble: () => Chunk.empty(),
    } as never)
    const model = Schema.Struct({ id: Schema.String, lines: Schema.Chunk(Schema.URL) })
    expect(refusal(() => aggregate(model, { lines }))).toContain('field "lines" is a Schema.URL')
  })

  const edge = () =>
    Aggregate.many({
      entityType: "Line",
      sk: { composite: ["sku"] },
      decompose: () => [],
      assemble: (rows: ReadonlyArray<unknown>) => rows,
    } as never)
  const COLLECTIONS: ReadonlyArray<readonly [string, (row: Schema.Top) => Schema.Top]> = [
    ["Schema.Chunk", (row) => Schema.Chunk(row as never)],
    ["Schema.HashMap", (row) => Schema.HashMap(Schema.String, row as never)],
    ["Schema.ReadonlyMap", (row) => Schema.ReadonlyMap(Schema.String, row as never)],
  ]
  const over = (lines: Schema.Top) => Schema.Struct({ id: Schema.String, lines: lines as never })

  for (const [name, collection] of COLLECTIONS) {
    it(`a many edge over ${name} isn't refused for the collection`, () => {
      expect(refusal(() => aggregate(over(collection(Line)), { lines: edge() }))).toBe(
        "nothing refused",
      )
      expect(refusal(() => subAggregate(over(collection(Line)), { lines: edge() }))).toBe(
        "nothing refused",
      )
    })

    it(`an optional many edge over ${name} isn't either`, () => {
      expect(
        refusal(() => aggregate(over(Schema.optional(collection(Line))), { lines: edge() })),
      ).toBe("nothing refused")
    })

    it(`the same field with no edge is refused, as a one edge is`, () => {
      expect(refusal(() => aggregate(over(collection(Line))))).toContain(
        `field "lines" is a ${name}`,
      )
      expect(
        refusal(() =>
          aggregate(over(collection(Line)), {
            lines: Aggregate.one({ entityType: "Line" } as never),
          }),
        ),
      ).toContain(`field "lines" is a ${name}`)
    })

    it(`what ${name}'s rows hold is still judged, as a row's field`, () => {
      expect(
        refusal(() =>
          aggregate(over(collection(Schema.Struct({ sku: Schema.String, u: Schema.URL }))), {
            lines: edge(),
          }),
        ),
      ).toContain('field "lines.u" is a Schema.URL')
      // A row is an entity-like item: a date in one is stored as a string.
      expect(
        refusal(() =>
          aggregate(over(collection(Schema.Struct({ sku: Schema.String, at: Schema.Date }))), {
            lines: edge(),
          }),
        ),
      ).toBe("nothing refused")
    })
  }

  it("a many edge inside a sub-aggregate isn't refused from the parent", () => {
    const Inner = over(Schema.Chunk(Line))
    const Sub = subAggregate(Inner, { lines: edge() })
    const Parent = Schema.Struct({ id: Schema.String, team: Inner as never })
    expect(refusal(() => aggregate(Parent, { team: Sub.with({ teamNumber: 1 }) }))).toBe(
      "nothing refused",
    )
    // Named as an edge of the parent, or not at all, the path differs and the field is refused.
    expect(refusal(() => aggregate(Parent))).toContain('field "team.lines" is a Schema.Chunk')
  })
})
