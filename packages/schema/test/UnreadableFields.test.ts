/**
 * `[EDD-9125]` beyond maps, on the pure makes and the rule itself: what each owner refuses, what it
 * takes, and what it can't judge. Maps have `ReadonlyMapFields.test.ts`. Streams and outboxes are in
 * `effect-dynamodb`'s test of this name, and what's taken is stored and read back in its connected
 * suite.
 */

import { Chunk, DateTime, Effect, Schema, SchemaGetter } from "effect"
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
  const literal = "a bigint Schema.Literal"
  const F = Schema.DateTimeUtcFromDate
  const customDate = Schema.Date.pipe(
    Schema.decodeTo(Schema.Number, {
      decode: SchemaGetter.transform((d: Date) => d.getTime()),
      encode: SchemaGetter.transform((n: number) => new Date(n)),
    }),
  )
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
    ["a bigint or null", Schema.NullOr(Schema.BigInt), bigint, bigint, bigint],
    ["a bigint or undefined", Schema.UndefinedOr(Schema.BigInt), bigint, bigint, bigint],
    ["a bigint in a union", Schema.Union([Schema.BigInt, Schema.String]), bigint, bigint, bigint],
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
      bigint,
      bigint,
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
