/**
 * `[EDD-9125]` on the operational makes. The table of what's refused and what isn't is the schema
 * package's test of the same name; this covers that each make here asks.
 */

import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Effect, Schema, SchemaGetter } from "effect"
import { describe, expect, it } from "vitest"
import * as Aggregate from "../src/Aggregate.js"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
import * as Table from "../src/Table.js"

const AppSchema = DynamoSchema.make({ name: "app", version: 1 })
const Base = Table.make({ schema: AppSchema, entities: {} })
const Counts = Schema.ReadonlyMap(Schema.String, Schema.Number)
const Line = Schema.Struct({ sku: Schema.String })

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

const subAggregate = (model: unknown) =>
  (Aggregate.make as any)(model, { root: { entityType: "Sub" }, edges: {} })

const Direct = Schema.Struct({ id: Schema.String, f: Counts })
const Nested = Schema.Struct({ id: Schema.String, a: Schema.Array(Schema.Struct({ m: Counts })) })
const Fine = Schema.Struct({ id: Schema.String, f: Schema.Record(Schema.String, Schema.Number) })

describe("[EDD-9125] the operational makes", () => {
  for (const [name, build, owner] of [
    ["Entity.make", entity, 'Entity "E"'],
    ["Aggregate.make", aggregate, 'Aggregate "Agg"'],
    ["Aggregate.make, a sub-aggregate", subAggregate, 'Aggregate "Sub"'],
  ] as const) {
    it(`${name} refuses one on a field, naming it`, () => {
      expect(() => build(Direct)).toThrow(`[EDD-9125] ${owner}: field "f" is a Schema.ReadonlyMap`)
    })

    it(`${name} refuses one nested, naming the path`, () => {
      expect(() => build(Nested)).toThrow(`field "a[].m" is a Schema.ReadonlyMap`)
    })

    it(`${name} points to Schema.Record, and takes it`, () => {
      expect(() => build(Direct)).toThrow("Use Schema.Record")
      expect(() => build(Fine)).not.toThrow()
    })

    it(`${name} refuses a configured model's`, () => {
      const configured = DynamoModel.configure(Direct, { f: { field: "g" } })
      expect(() => build(configured)).toThrow("[EDD-9125]")
    })
  }

  it("a many edge over one isn't: its collection is rows, and only the rows are stored", () => {
    const edges = {
      lines: Aggregate.many({
        entityType: "Line",
        sk: { composite: ["sku"] },
        decompose: (rows: ReadonlyMap<string, unknown>) => [...rows.values()],
        assemble: (rows: ReadonlyArray<never>) => new Map(rows),
      } as never),
    }
    expect(() =>
      aggregate(
        Schema.Struct({ id: Schema.String, lines: Schema.ReadonlyMap(Schema.String, Line) }),
        edges,
      ),
    ).not.toThrow()
  })
})

describe("[EDD-9125] EventStore.makeStream", () => {
  const Text = Schema.Record(Schema.String, Schema.Number)
  const Decoded = Text.pipe(
    Schema.decodeTo(Counts, {
      decode: SchemaGetter.transform((text) => new Map(Object.entries(text))),
      encode: SchemaGetter.transform((counts) => Object.fromEntries(counts)),
    }),
  )
  const Json = Schema.toCodecJson(Counts)
  const Packed = DynamoModel.Packed({ format: "json" })
  const Plain = Schema.Struct({ _tag: Schema.tag("Plain") })

  class Noted extends Schema.TaggedClass<Noted>()("Noted", { m: Counts }) {}
  class Fine extends Schema.TaggedClass<Fine>()("Fine", { m: Text }) {}

  const stream = (config: Record<string, unknown>) =>
    EventStore.makeStream({
      table: Base,
      streamName: "Tally",
      events: [Plain],
      streamId: { composite: ["id"] },
      ...config,
    } as never)
  const message = (config: Record<string, unknown>) => {
    try {
      stream(config)
    } catch (error) {
      return String((error as Error).message)
    }
    return "nothing refused"
  }
  const eventOver = (field: Schema.Top) =>
    Schema.Struct({ _tag: Schema.tag("Noted"), m: field as never })

  const REFUSED: ReadonlyArray<readonly [string, Record<string, unknown>, string]> = [
    [
      "an event's field",
      { events: [eventOver(Counts)] },
      'EventStream "Tally", events[0]: field "m" is a Schema.ReadonlyMap',
    ],
    [
      "the second event's field, by position",
      { events: [Plain, eventOver(Counts)] },
      'EventStream "Tally", events[1]: field "m"',
    ],
    [
      "a class event's field, by name",
      { events: [Noted] },
      'EventStream "Tally", event "Noted": field "m"',
    ],
    [
      "an event's nested field",
      { events: [eventOver(Schema.Struct({ n: Counts }))] },
      'field "m.n"',
    ],
    ["an event's array element", { events: [eventOver(Schema.Array(Counts))] }, 'field "m[]"'],
    [
      "an event's record value",
      { events: [eventOver(Schema.Record(Schema.String, Counts))] },
      'field "m[key]"',
    ],
    ["an event's optional field", { events: [eventOver(Schema.optional(Counts))] }, 'field "m"'],
    ["an event that is one", { events: [Counts] }, "the event is a Schema.ReadonlyMap"],
    ["a union event's member", { events: [Schema.Union([Plain, eventOver(Counts)])] }, 'field "m"'],
    [
      "a packed event, whose append fails",
      { events: [eventOver(Counts)], storedAs: { data: Packed } },
      'field "m"',
    ],
    [
      "metadata's field",
      { metadata: Schema.Struct({ m: Counts }) },
      'EventStream "Tally", metadata: field "m"',
    ],
    ["metadata that is one", { metadata: Counts }, "the metadata is a Schema.ReadonlyMap"],
    [
      "a snapshot state's field",
      { snapshot: { schema: Schema.Struct({ m: Counts }) } },
      'EventStream "Tally", snapshot state: field "m"',
    ],
    [
      "a snapshot state that is one",
      { snapshot: { schema: Counts } },
      "the state is a Schema.ReadonlyMap",
    ],
    [
      "a packed snapshot state, whose write fails",
      { snapshot: { schema: Schema.Struct({ m: Counts }), storedAs: Packed } },
      'snapshot state: field "m"',
    ],
    [
      "an inline snapshot state",
      { snapshot: { schema: Schema.Struct({ m: Counts }), mode: "inline" } },
      'snapshot state: field "m"',
    ],
  ]

  for (const [name, config, says] of REFUSED) {
    it(`refuses ${name}`, () => {
      const refusal = message(config)
      expect(refusal).toContain("[EDD-9125]")
      expect(refusal).toContain(says)
      expect(refusal).toContain("Use Schema.Record")
    })
  }

  const ALLOWED: ReadonlyArray<readonly [string, Schema.Top]> = [
    ["a record", Text],
    ["a map decoded from a record", Decoded],
    ["Schema.toCodecJson of a map", Json],
  ]

  for (const [name, field] of ALLOWED) {
    it(`takes ${name}, on an event, metadata and a snapshot, native and packed`, () => {
      for (const config of [
        { events: [eventOver(field)] },
        { events: [eventOver(field)], storedAs: { data: Packed } },
        { metadata: Schema.Struct({ m: field as never }) },
        { snapshot: { schema: Schema.Struct({ m: field as never }) } },
        { snapshot: { schema: Schema.Struct({ m: field as never }), storedAs: Packed } },
      ]) {
        expect(message(config)).toBe("nothing refused")
      }
    })
  }

  it("takes a class event and no metadata or snapshot", () => {
    expect(message({ events: [Fine] })).toBe("nothing refused")
    expect(message({})).toBe("nothing refused")
  })
})

describe("[EDD-9125] a projection's outbox", () => {
  const Text = Schema.Record(Schema.String, Schema.Number)
  const Decoded = Text.pipe(
    Schema.decodeTo(Counts, {
      decode: SchemaGetter.transform((text) => new Map(Object.entries(text))),
      encode: SchemaGetter.transform((counts) => Object.fromEntries(counts)),
    }),
  )
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
  const shared = {
    readModel: Summaries,
    revision: "rev",
  }
  const single = (schema: Schema.Top) =>
    EventStore.projection({
      ...shared,
      stream: Tally,
      key: (id: { readonly id: string }) => ({ id: id.id }),
      initial: (id: { readonly id: string }) => ({ id: id.id, version: 0, rev: 0 }),
      evolve: (state: unknown) => Effect.succeed(state),
      checkpoint: "version",
      outbox: { schema, effects: () => [] },
    } as never)
  const multi = (schema: Schema.Top) =>
    EventStore.multiProjection({
      ...shared,
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

  const CONSTRUCTORS = [
    ["projection", single, 'EventStore.projection("Tally" \u2192 "Summary"), outbox schema'],
    ["multiProjection", multi, 'EventStore.multiProjection("Summary"), outbox schema'],
  ] as const

  for (const [name, build, owner] of CONSTRUCTORS) {
    it(`${name} refuses an effect's field`, () => {
      expect(() => build(Schema.Struct({ m: Counts }))).toThrow(
        `[EDD-9125] ${owner}: field "m" is a Schema.ReadonlyMap`,
      )
    })

    it(`${name} refuses an effect's nested field`, () => {
      expect(() => build(Schema.Struct({ n: Schema.Struct({ m: Counts }) }))).toThrow(
        `${owner}: field "n.m"`,
      )
    })

    it(`${name} refuses an effect that is one`, () => {
      expect(() => build(Counts)).toThrow(`${owner}: the effect is a Schema.ReadonlyMap`)
    })

    for (const [form, schema] of [
      ["a record", Text],
      ["a map decoded from a record", Decoded],
      ["a map under toCodecJson", Schema.toCodecJson(Counts)],
    ] as const) {
      it(`${name} allows ${form}, which reads back`, () => {
        expect(() => build(Schema.Struct({ m: schema }))).not.toThrow()
      })
    }
  }

  it("a projection with no outbox has nothing to refuse", () => {
    expect(() =>
      EventStore.projection({
        ...shared,
        stream: Tally,
        key: (id: { readonly id: string }) => ({ id: id.id }),
        initial: (id: { readonly id: string }) => ({ id: id.id, version: 0, rev: 0 }),
        evolve: (state: unknown) => Effect.succeed(state),
        checkpoint: "version",
      } as never),
    ).not.toThrow()
  })
})
