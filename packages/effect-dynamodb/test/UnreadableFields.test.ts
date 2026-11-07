/**
 * `[EDD-9125]` beyond maps, on the operational makes, streams and outboxes. The table of what each
 * owner refuses is the schema package's test of this name; this covers that each make here asks, and
 * as what. What's taken is stored and read back in `connected.unreadable.test.ts`.
 */

import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Effect, Schema, SchemaTransformation } from "effect"
import { describe, expect, it } from "vitest"
import * as Aggregate from "../src/Aggregate.js"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
import * as Table from "../src/Table.js"

const AppSchema = DynamoSchema.make({ name: "app", version: 1 })
const Base = Table.make({ schema: AppSchema, entities: {} })
const Line = Schema.Struct({ sku: Schema.String })
const modelOf = (field: Schema.Top) => Schema.Struct({ id: Schema.String, f: field as never })

const entity = (model: unknown) =>
  Entity.make({
    model: model as never,
    entityType: "E",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
  } as never)

const aggregate = (model: unknown, edges: Record<string, unknown> = {}) =>
  (Aggregate.make as any)(model, {
    table: Base,
    schema: AppSchema,
    pk: { field: "pk", composite: ["id"] },
    collection: { name: "agg" },
    root: { entityType: "Agg" },
    edges,
  })

const subAggregate = (model: unknown, edges: Record<string, unknown> = {}) =>
  (Aggregate.make as any)(model, { root: { entityType: "Sub" }, edges })

const refusal = (run: () => unknown): string => {
  try {
    run()
  } catch (error) {
    return String((error as Error).message)
  }
  return "nothing refused"
}

describe("[EDD-9125] the operational makes", () => {
  for (const [name, build, owner] of [
    ["Entity.make", entity, 'Entity "E"'],
    ["Aggregate.make", aggregate, 'Aggregate "Agg"'],
    ["Aggregate.make, a sub-aggregate", subAggregate, 'Aggregate "Sub"'],
  ] as const) {
    it(`${name} refuses a Schema.URL, and takes Schema.URLFromString`, () => {
      expect(refusal(() => build(modelOf(Schema.URL)))).toContain(
        `[EDD-9125] ${owner}: field "f" is a Schema.URL, which can't be read back`,
      )
      expect(refusal(() => build(modelOf(Schema.URLFromString)))).toBe("nothing refused")
    })

    it(`${name} refuses a Schema.Chunk, and takes Schema.Array`, () => {
      expect(refusal(() => build(modelOf(Schema.Chunk(Schema.String))))).toContain(
        `field "f" is a Schema.Chunk`,
      )
      expect(refusal(() => build(modelOf(Schema.Array(Schema.String))))).toBe("nothing refused")
    })

    it(`${name} takes what it stores as something else: a date, a redacted value, a bigint`, () => {
      expect(refusal(() => build(modelOf(Schema.Date)))).toBe("nothing refused")
      expect(refusal(() => build(modelOf(Schema.Redacted(Schema.String))))).toBe("nothing refused")
      expect(refusal(() => build(modelOf(Schema.BigInt)))).toBe("nothing refused")
    })

    it(`${name} refuses a date under another declaration, which it doesn't reach`, () => {
      expect(refusal(() => build(modelOf(Schema.Option(Schema.Date))))).toContain(
        'field "f" is a Schema.Date',
      )
    })

    it(`${name} refuses a redacted value beneath a step onto another type, and takes its replacement`, () => {
      for (const field of [
        Schema.OptionFromOptional(Schema.Redacted(Schema.String)),
        Schema.OptionFromOptionalKey(Schema.Redacted(Schema.String)),
        Schema.OptionFromUndefinedOr(Schema.Redacted(Schema.String)),
      ]) {
        expect(refusal(() => build(modelOf(field)))).toContain('field "f" is a Schema.Redacted')
      }
      expect(
        refusal(() =>
          build(modelOf(Schema.OptionFromOptional(Schema.RedactedFromValue(Schema.String)))),
        ),
      ).toBe("nothing refused")
    })

    it(`${name} takes what's beneath a transformation onto the same type, and refuses what it writes as declared`, () => {
      const over = <S extends Schema.Top>(from: S) =>
        from.pipe(Schema.decodeTo(from as never, SchemaTransformation.passthrough() as never))
      expect(refusal(() => build(modelOf(over(Schema.Redacted(Schema.String)))))).toBe(
        "nothing refused",
      )
      expect(refusal(() => build(modelOf(over(Schema.Array(Schema.Date)))))).toBe("nothing refused")
      expect(
        refusal(() =>
          build(
            modelOf(
              Schema.Array(Schema.Date).pipe(
                Schema.decodeTo(
                  Schema.Array(Schema.Number),
                  SchemaTransformation.passthrough() as never,
                ),
              ),
            ),
          ),
        ),
      ).toContain('field "f[]" is a Schema.Date')
    })

    it(`${name} takes a bigint under a union, a number next to it included`, () => {
      for (const field of [
        Schema.NullOr(Schema.BigInt),
        Schema.Union([Schema.String, Schema.BigInt]),
        Schema.Union([Schema.Number, Schema.BigInt]),
        Schema.Union([Schema.BigInt, Schema.Number]),
        Schema.NullOr(Schema.Struct({ b: Schema.BigInt })),
        Schema.Array(Schema.NullOr(Schema.BigInt)),
        Schema.Union([Schema.Number, Schema.Struct({ b: Schema.BigInt })]),
      ]) {
        expect(refusal(() => build(modelOf(field)))).toBe("nothing refused")
      }
    })

    it(`${name} takes a bigint under a declaration, a suspend or a transformation`, () => {
      for (const field of [
        Schema.Option(Schema.BigInt),
        Schema.NullOr(Schema.Option(Schema.BigInt)),
        Schema.suspend(() => Schema.BigInt),
        Schema.DurationFromNanos,
        Schema.ByteSizeFromBigInt,
        Schema.OptionFromNullOr(Schema.BigInt),
      ]) {
        expect(refusal(() => build(modelOf(field)))).toBe("nothing refused")
      }
    })

    it(`${name} refuses a bigint beside a number where the lift sits on the bigint`, () => {
      for (const field of [
        Schema.Option(Schema.Union([Schema.Number, Schema.BigInt])),
        Schema.suspend(() => Schema.Union([Schema.BigInt, Schema.Number])),
      ]) {
        expect(refusal(() => build(modelOf(field)))).toContain(
          'field "f" is a union of Schema.BigInt and something else stored as a number',
        )
      }
    })

    it(`${name} refuses a date beneath a decoding default on a struct, and takes its replacement`, () => {
      const over = (date: Schema.Top) =>
        Schema.Struct({ d: date as never }).pipe(
          Schema.withDecodingDefaultKey(Effect.die("unused")),
        )
      expect(refusal(() => build(modelOf(over(Schema.Date))))).toContain(
        'field "f.d" is a Schema.Date',
      )
      expect(refusal(() => build(modelOf(over(Schema.DateFromString))))).toBe("nothing refused")
    })
  }

  it("Entity.make refuses a Schema.DateTimeUtcFromDate; Aggregate.make, under a union", () => {
    expect(refusal(() => entity(modelOf(Schema.DateTimeUtcFromDate)))).toContain(
      "a transformation over Schema.Date",
    )
    expect(refusal(() => aggregate(modelOf(Schema.DateTimeUtcFromDate)))).toBe("nothing refused")
    expect(refusal(() => aggregate(modelOf(Schema.NullOr(Schema.DateTimeUtcFromDate))))).toContain(
      "a transformation over Schema.Date",
    )
  })

  it("Aggregate.make reads its own many edges", () => {
    const lines = Aggregate.many({
      entityType: "Line",
      sk: { composite: ["sku"] },
      decompose: () => [],
      assemble: (rows: ReadonlyArray<unknown>) => rows,
    } as never)
    const Lined = Schema.Struct({ id: Schema.String, lines: Schema.Chunk(Line) })
    expect(refusal(() => aggregate(Lined, { lines }))).toBe("nothing refused")
    expect(refusal(() => subAggregate(Lined, { lines }))).toBe("nothing refused")
    expect(refusal(() => aggregate(Lined))).toContain('field "lines" is a Schema.Chunk')
    expect(refusal(() => subAggregate(Lined))).toContain('field "lines" is a Schema.Chunk')
  })
})

describe("[EDD-9125] EventStore.makeStream", () => {
  const Packed = DynamoModel.Packed({ format: "json" })
  const Plain = Schema.Struct({ _tag: Schema.tag("Plain") })
  const stream = (config: Record<string, unknown>) =>
    EventStore.makeStream({
      table: Base,
      streamName: "Tally",
      events: [Plain],
      streamId: { composite: ["id"] },
      ...config,
    } as never)
  const eventOver = (field: Schema.Top) =>
    Schema.Struct({ _tag: Schema.tag("Noted"), m: field as never })

  /** A stream encodes through the schema alone, so these are refused as they aren't on an entity. */
  const REFUSED: ReadonlyArray<readonly [string, Schema.Top, string, Schema.Top]> = [
    ["a Schema.Date", Schema.Date, "Schema.DateFromString", Schema.DateFromString],
    [
      "a Schema.Redacted",
      Schema.Redacted(Schema.String),
      "Schema.RedactedFromValue",
      Schema.RedactedFromValue(Schema.String),
    ],
    [
      "a transformation over Schema.Date",
      Schema.DateTimeUtcFromDate,
      "Schema.DateTimeUtcFromString",
      Schema.DateTimeUtcFromString,
    ],
    ["a Schema.URL", Schema.URL, "Schema.URLFromString", Schema.URLFromString],
    ["a Schema.Chunk", Schema.Chunk(Schema.String), "Schema.Array", Schema.Array(Schema.String)],
  ]

  for (const [name, field, use, replacement] of REFUSED) {
    const refused = (config: Record<string, unknown>) => refusal(() => stream(config))

    it(`refuses ${name} in an event, naming it, and takes ${use}`, () => {
      expect(refused({ events: [eventOver(field)] })).toContain(
        `[EDD-9125] EventStream "Tally", events[0]: field "m" is ${name}`,
      )
      expect(refused({ events: [eventOver(field)] })).toContain(use)
      expect(refused({ events: [eventOver(replacement)] })).toBe("nothing refused")
    })

    it(`refuses ${name} in metadata and a snapshot, and takes ${use}`, () => {
      expect(refused({ metadata: Schema.Struct({ m: field as never }) })).toContain(
        `metadata: field "m" is ${name}`,
      )
      expect(refused({ snapshot: { schema: Schema.Struct({ m: field as never }) } })).toContain(
        `snapshot state: field "m" is ${name}`,
      )
      expect(refused({ metadata: Schema.Struct({ m: replacement as never }) })).toBe(
        "nothing refused",
      )
      expect(refused({ snapshot: { schema: Schema.Struct({ m: replacement as never }) } })).toBe(
        "nothing refused",
      )
    })

    it(`refuses ${name} packed, whose write would fail`, () => {
      expect(refused({ events: [eventOver(field)], storedAs: { data: Packed } })).toContain(
        `field "m" is ${name}`,
      )
    })
  }

  it("says what a whole event, metadata or state is", () => {
    expect(refusal(() => stream({ events: [Schema.URL] }))).toContain("the event is a Schema.URL")
    expect(refusal(() => stream({ metadata: Schema.Date }))).toContain(
      "the metadata is a Schema.Date",
    )
    expect(refusal(() => stream({ snapshot: { schema: Schema.Date } }))).toContain(
      "the state is a Schema.Date",
    )
  })

  it("takes what a read gets back as a plain object, which still reads", () => {
    for (const field of [Schema.Duration, Schema.DateTimeUtc, Schema.BigDecimal]) {
      expect(refusal(() => stream({ events: [eventOver(field)] }))).toBe("nothing refused")
    }
  })

  describe("a Schema.BigInt, which a read lifts", () => {
    const BESIDE = "a union of Schema.BigInt and something else stored as a number"
    const refused = (config: Record<string, unknown>) => refusal(() => stream(config))

    for (const [name, field] of [
      ["on its own", Schema.BigInt],
      ["or null", Schema.NullOr(Schema.BigInt)],
      ["optional", Schema.optional(Schema.BigInt)],
      ["beside a string", Schema.Union([Schema.String, Schema.BigInt])],
      ["in a list", Schema.Array(Schema.BigInt)],
      ["in an Option", Schema.Option(Schema.BigInt)],
      ["suspended", Schema.suspend(() => Schema.BigInt)],
      ["under Schema.DurationFromNanos", Schema.DurationFromNanos],
      ["under Schema.ByteSizeFromBigInt", Schema.ByteSizeFromBigInt],
      ["under Schema.OptionFromNullOr", Schema.OptionFromNullOr(Schema.BigInt)],
    ] as const) {
      it(`takes one ${name}, in an event, metadata and a snapshot`, () => {
        expect(refused({ events: [eventOver(field)] })).toBe("nothing refused")
        expect(refused({ metadata: Schema.Struct({ m: field as never }) })).toBe("nothing refused")
        expect(refused({ snapshot: { schema: Schema.Struct({ m: field as never }) } })).toBe(
          "nothing refused",
        )
      })
    }

    it("takes one packed: its write is what fails, as it always has", () => {
      expect(refused({ events: [eventOver(Schema.BigInt)], storedAs: { data: Packed } })).toBe(
        "nothing refused",
      )
    })

    for (const field of [
      Schema.Union([Schema.Number, Schema.BigInt]),
      Schema.Union([Schema.BigInt, Schema.Number]),
      Schema.Union([Schema.Literal(5), Schema.BigInt]),
    ]) {
      it("refuses one a read can't tell from a number, in an event, metadata and a snapshot", () => {
        expect(refused({ events: [eventOver(field)] })).toContain(
          `EventStream "Tally", events[0]: field "m" is ${BESIDE}`,
        )
        expect(refused({ metadata: Schema.Struct({ m: field as never }) })).toContain(
          `metadata: field "m" is ${BESIDE}`,
        )
        expect(refused({ snapshot: { schema: Schema.Struct({ m: field as never }) } })).toContain(
          `snapshot state: field "m" is ${BESIDE}`,
        )
      })
    }

    it("refuses two events a read can't tell apart, each fine alone", () => {
      const one = Schema.Struct({ amount: Schema.BigInt })
      const other = Schema.Struct({ amount: Schema.Number })
      expect(refused({ events: [one] })).toBe("nothing refused")
      expect(refused({ events: [other] })).toBe("nothing refused")
      expect(refused({ events: [one, other] })).toContain(
        `EventStream "Tally": the union of its events is ${BESIDE}`,
      )
      expect(refused({ events: [other, one] })).toContain(BESIDE)
    })

    it("takes two events a tag tells apart", () => {
      expect(
        refused({
          events: [
            Schema.Struct({ _tag: Schema.tag("Paid"), amount: Schema.BigInt }),
            Schema.Struct({ _tag: Schema.tag("Noted"), amount: Schema.Number }),
          ],
        }),
      ).toBe("nothing refused")
    })
  })
})

describe("[EDD-9125] a projection's outbox", () => {
  const Tally = EventStore.makeStream({
    table: Base,
    streamName: "Tally",
    events: [Schema.Struct({ _tag: Schema.tag("Plain") })],
    streamId: { composite: ["id"] },
  })
  const Summaries = Entity.make({
    model: Schema.Struct({ id: Schema.String, version: Schema.Number, rev: Schema.Number }),
    entityType: "Summary",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
  })
  const single = (schema: Schema.Top) =>
    EventStore.projection({
      readModel: Summaries,
      revision: "rev",
      stream: Tally,
      key: (id: { readonly id: string }) => ({ id: id.id }),
      initial: (id: { readonly id: string }) => ({ id: id.id, version: 0, rev: 0 }),
      evolve: (state: unknown) => Effect.succeed(state),
      checkpoint: "version",
      outbox: { schema, effects: () => [] },
    } as never)
  const multi = (schema: Schema.Top) =>
    EventStore.multiProjection({
      readModel: Summaries,
      revision: "rev",
      initial: (key: { readonly id: string }) => ({ id: key.id, version: 0, rev: 0 }),
      sources: (source: (stream: unknown, config: unknown) => unknown) => ({
        tally: source(Tally, {
          key: (event: { readonly streamId: string }) => ({ id: event.streamId }),
          evolve: (state: unknown) => Effect.succeed(state),
        }),
      }),
      checkpoints: { field: "version" },
      outbox: { schema, effects: () => [] },
    } as never)

  for (const [name, build, owner] of [
    ["projection", single, 'EventStore.projection("Tally" → "Summary"), outbox schema'],
    ["multiProjection", multi, 'EventStore.multiProjection("Summary"), outbox schema'],
  ] as const) {
    for (const [what, field, replacement] of [
      ["a Schema.Date", Schema.Date, Schema.DateFromMillis],
      [
        "a Schema.Redacted",
        Schema.Redacted(Schema.String),
        Schema.RedactedFromValue(Schema.String),
      ],
      ["a Schema.URL", Schema.URL, Schema.URLFromString],
    ] as const) {
      it(`${name} refuses ${what}, and takes its replacement`, () => {
        expect(refusal(() => build(Schema.Struct({ m: field as never })))).toContain(
          `[EDD-9125] ${owner}: field "m" is ${what}`,
        )
        expect(refusal(() => build(Schema.Struct({ m: replacement as never })))).toBe(
          "nothing refused",
        )
      })
    }

    it(`${name} says what a whole effect is`, () => {
      expect(refusal(() => build(Schema.URL))).toContain(`${owner}: the effect is a Schema.URL`)
    })

    it(`${name} takes a Schema.BigInt, which a read lifts, unless it's beside a number`, () => {
      expect(refusal(() => build(Schema.Struct({ m: Schema.BigInt })))).toBe("nothing refused")
      expect(
        refusal(() => build(Schema.Struct({ m: Schema.Union([Schema.Number, Schema.BigInt]) }))),
      ).toContain(
        `${owner}: field "m" is a union of Schema.BigInt and something else stored as a number`,
      )
    })
  }
})
