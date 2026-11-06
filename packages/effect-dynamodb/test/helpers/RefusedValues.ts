/**
 * Values the library can't compose or send, on every path that takes one, under both `escapeKeys`
 * settings: a composite with no key text is a `ValidationError` (`EDD-9096`), a value with no DynamoDB
 * form is one too (`EDD-9124`), and nothing is sent. Run on a client whose every write dies
 * (`NumericKeyOrder.test.ts`) and on DynamoDB Local (`connected.refused-values.test.ts`).
 */

import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Effect, Schema, Stream } from "effect"
import { expect } from "vitest"
import * as Aggregate from "../../src/Aggregate.js"
import * as Batch from "../../src/Batch.js"
import { DynamoClient } from "../../src/DynamoClient.js"
import * as Entity from "../../src/Entity.js"
import * as EventStore from "../../src/EventStore.js"
import { parseShorthand } from "../../src/internal/Expr.js"
import * as Query from "../../src/Query.js"
import * as Table from "../../src/Table.js"
import * as Transaction from "../../src/Transaction.js"

class Noted extends Schema.TaggedClass<Noted>()("Noted", { n: Schema.Number }) {}

export const SETTINGS = [
  ["off", false],
  ["on", true],
] as const

export const refusedWorld = (escapeKeys: boolean, prefix = "refused") => {
  const Gauge = Schema.Struct({
    gaugeId: Schema.String,
    slot: Schema.Number,
    score: Schema.Number,
    plain: Schema.optional(Schema.Number),
    list: Schema.optional(Schema.Array(Schema.Number)),
    tags: Schema.optional(Schema.ReadonlySet(Schema.String)),
  })
  /** An index composite, a collection and the soft-delete lifecycle (`restore`, `purge`). */
  const Gauges = Entity.make({
    model: Gauge,
    entityType: "Gauge",
    primaryKey: {
      pk: { field: "pk", composite: ["gaugeId"] },
      sk: { field: "sk", composite: ["slot"] },
    },
    indexes: {
      byScore: {
        name: "gsi1",
        pk: { field: "gsi1pk", composite: ["gaugeId"] },
        sk: { field: "gsi1sk", composite: ["score"] },
      },
      byTick: {
        name: "gsi2",
        collection: "ticks",
        pk: { field: "gsi2pk", composite: ["score"] },
        sk: { field: "gsi2sk", composite: [] },
      },
    },
    softDelete: true,
  })
  /** A numeric unique field, and the multi-item operations. */
  const Badges = Entity.make({
    model: Schema.Struct({ badgeId: Schema.String, slot: Schema.Number, code: Schema.Number }),
    entityType: "Badge",
    primaryKey: {
      pk: { field: "pk", composite: ["badgeId"] },
      sk: { field: "sk", composite: ["slot"] },
    },
    unique: { code: ["code"] },
  })
  /** Neither unique nor lifecycle: `Batch.write` takes it. */
  const Slots = Entity.make({
    model: Schema.Struct({
      slotId: Schema.String,
      slot: Schema.Number,
      plain: Schema.optional(Schema.Number),
    }),
    entityType: "Slot",
    primaryKey: {
      pk: { field: "pk", composite: ["slotId"] },
      sk: { field: "sk", composite: ["slot"] },
    },
  })
  const Retained = Entity.make({
    model: Schema.Struct({
      retainedId: Schema.String,
      slot: Schema.Number,
      score: Schema.optional(Schema.Number),
    }),
    entityType: "Retained",
    primaryKey: {
      pk: { field: "pk", composite: ["retainedId"] },
      sk: { field: "sk", composite: ["slot"] },
    },
    indexes: {
      byScore: {
        name: "gsi1",
        pk: { field: "gsi1pk", composite: ["retainedId"] },
        sk: { field: "gsi1sk", composite: ["score"] },
      },
    },
    versioned: { retain: true },
  })
  const Meter = Schema.Struct({
    meterId: Schema.String,
    at: Schema.Number,
    v: Schema.optional(Schema.Number),
  })
  const Meters = Entity.make({
    model: Meter,
    entityType: "Meter",
    primaryKey: {
      pk: { field: "pk", composite: ["meterId"] },
      sk: { field: "sk", composite: [] },
    },
    timeSeries: { orderBy: "at", appendInput: Meter },
  })
  /** A partition key that holds a number: what `deleted.list` and `history` compose. */
  const Shelves = Entity.make({
    model: Schema.Struct({ shelf: Schema.Number, id: Schema.String }),
    entityType: "Shelf",
    primaryKey: {
      pk: { field: "pk", composite: ["shelf"] },
      sk: { field: "sk", composite: ["id"] },
    },
    softDelete: true,
  })
  const Level = Schema.Struct({ line: Schema.Number, at: Schema.Number })
  const Levels = Entity.make({
    model: Level,
    entityType: "Level",
    primaryKey: {
      pk: { field: "pk", composite: ["line"] },
      sk: { field: "sk", composite: [] },
    },
    timeSeries: { orderBy: "at", appendInput: Level },
  })
  const entities = { Gauges, Badges, Slots, Retained, Meters, Shelves, Levels }
  const Base = Table.make({
    schema: DynamoSchema.make({ name: prefix, version: 1, escapeKeys }),
    entities,
  })
  const Agg = Aggregate.make(
    Schema.Struct({
      id: Schema.String,
      rate: Schema.Number,
      note: Schema.optional(Schema.Number),
      lines: Schema.Array(Schema.Struct({ n: Schema.Number })),
    }) as never,
    {
      table: Base,
      schema: Base.schema,
      pk: { field: "pk", composite: ["id"] },
      collection: { name: "agg" },
      root: { entityType: "Agg" },
      edges: { lines: Aggregate.many({ entityType: "Line", sk: { composite: ["n"] } }) },
      list: {
        index: "gsi1",
        name: "agg",
        pk: { field: "gsi1pk", composite: [] },
        sk: { field: "gsi1sk", composite: ["rate"] },
      },
    } as never,
  ) as any
  const Events = EventStore.makeStream({
    table: Base,
    streamName: "E",
    events: [Noted],
    streamId: { composite: ["streamId"] },
  })
  const MainTable = { ...Base, aggregates: { Agg } }
  const client = DynamoClient.make({
    entities,
    aggregates: { Agg },
    tables: { MainTable },
  } as never) as any
  return { MainTable, Base, client, entities, Events, Gauges, Slots, Badges }
}

export type RefusedWorld = ReturnType<typeof refusedWorld>
type Case = readonly [string, (client: any) => Effect.Effect<unknown, unknown, any>]

/** A composite with no key text, `v`: every path that composes a key from it. */
export const keyCases = (w: RefusedWorld, v: number): ReadonlyArray<Case> => {
  const { Badges, Events, Gauges, Slots } = w
  const key = { gaugeId: "g", slot: v }
  const accessor = (c: any) => c.entities.Gauges.byScore({ gaugeId: "g", score: v })
  return [
    ["put of a key", (c) => c.entities.Gauges.put({ ...key, score: 1 }).asEffect()],
    [
      "put of an index composite",
      (c) => c.entities.Gauges.put({ gaugeId: "g", slot: 1, score: v }).asEffect(),
    ],
    ["create", (c) => c.entities.Gauges.create({ ...key, score: 1 }).asEffect()],
    ["get", (c) => c.entities.Gauges.get(key)],
    ["delete", (c) => c.entities.Gauges.delete(key).asEffect()],
    ["update of a key", (c) => c.entities.Gauges.update(key).set({ plain: 1 }).asEffect()],
    [
      "update setting an index composite",
      (c) => c.entities.Gauges.update({ gaugeId: "g", slot: 1 }).set({ score: v }).asEffect(),
    ],
    ["upsert of a key", (c) => c.entities.Gauges.upsert({ ...key, score: 1 }).asEffect()],
    [
      "upsert of an index composite",
      (c) => c.entities.Gauges.upsert({ gaugeId: "g", slot: 1, score: v }).asEffect(),
    ],
    [
      "upsert that reads first, of an index composite",
      (c) => c.entities.Retained.upsert({ retainedId: "r", slot: 1, score: v }).asEffect(),
    ],
    ["restore", (c) => c.entities.Gauges.restore(key)],
    ["purge", (c) => c.entities.Gauges.purge(key)],
    ["deleted.get", (c) => c.entities.Gauges.deleted.get(key)],
    ["getVersion", (c) => c.entities.Retained.getVersion({ retainedId: "r", slot: v }, 1)],
    ["deleted.list", (c) => c.entities.Shelves.deleted.list({ shelf: v, id: "x" }).collect()],
    ["history", (c) => c.entities.Levels.history({ line: v }).collect()],
    ["versions", (c) => c.entities.Retained.versions({ retainedId: "r", slot: v }).collect()],
    ["append of an orderBy", (c) => c.entities.Meters.append({ meterId: "m", at: v }).asEffect()],
    [
      "a history bound",
      (c) =>
        c.entities.Meters.history({ meterId: "m" })
          .where((t: any, { gte }: any) => gte(t.at, v))
          .collect(),
    ],
    ["Batch.get", () => Batch.get([Slots.get({ slotId: "s", slot: v })])],
    ["Batch.write delete", () => Batch.write([Slots.delete({ slotId: "s", slot: v })])],
    ["Batch.write put", () => Batch.write([Slots.put({ slotId: "s", slot: v })])],
    ["transactGet", () => Transaction.transactGet([Badges.get({ badgeId: "b", slot: v })])],
    [
      "transactWrite delete",
      () => Transaction.transactWrite([Badges.delete({ badgeId: "b", slot: v })]),
    ],
    [
      "transactWrite put of a unique field",
      () => Transaction.transactWrite([Badges.put({ badgeId: "b", slot: 1, code: v })]),
    ],
    [
      "put of a unique field",
      (c) => c.entities.Badges.put({ badgeId: "b", slot: 1, code: v }).asEffect(),
    ],
    ["an accessor's collect", (c) => accessor(c).collect()],
    ["an accessor's fetch", (c) => accessor(c).fetch()],
    ["an accessor's paginate", (c) => Stream.runCollect(accessor(c).paginate())],
    ["an accessor's count", (c) => accessor(c).count()],
    [
      "an accessor, through what it can be chained with",
      (c) =>
        c.entities.Gauges.primary({ gaugeId: "g", slot: v })
          .filter({ plain: 1 })
          .select(["slot"])
          .limit(1)
          .reverse()
          .collect(),
    ],
    [
      "an accessor's where",
      (c) =>
        c.entities.Gauges.byScore({ gaugeId: "g" })
          .where((t: any, { gte }: any) => gte(t.score, v))
          .collect(),
    ],
    [
      "an accessor's within",
      (c) =>
        c.entities.Gauges.byScore({ gaugeId: "g" })
          .within({ score: { gte: v } })
          .collect(),
    ],
    [
      "a refused accessor, through a filter",
      (c) =>
        c.entities.Gauges.primary({ gaugeId: Number.NaN, slot: v }).filter({ plain: 1 }).collect(),
    ],
    [
      "where after a refused accessor",
      (c) =>
        c.entities.Gauges.byScore({ gaugeId: v })
          .where((t: any, { gte }: any) => gte(t.score, 1))
          .collect(),
    ],
    [
      "within after a refused accessor",
      (c) =>
        c.entities.Gauges.byScore({ gaugeId: v })
          .within({ score: { gte: 1 } })
          .collect(),
    ],
    ["a collection accessor", (c) => c.collections.ticks({ score: v }).collect()],
    [
      "an unbound query",
      () => Query.collect((Gauges as any).query.byScore({ gaugeId: "g", score: v })),
    ],
    ["aggregate get", (c) => c.aggregates.Agg.get({ id: v })],
    [
      "aggregate create, a list key",
      (c) => c.aggregates.Agg.create({ id: "a", rate: v, lines: [] }),
    ],
    [
      "aggregate create, a many sort key",
      (c) => c.aggregates.Agg.create({ id: "a", rate: 1, lines: [{ n: v }] }),
    ],
    ["aggregate list", (c) => c.aggregates.Agg.list({ rate: v })],
    ["a stream's append", () => Events.append({ streamId: v as never }, [new Noted({ n: 1 })], 0)],
    ["a stream's read", () => Events.read({ streamId: v as never })],
    ["a stream's version", () => Events.currentVersion({ streamId: v as never })],
  ]
}

/** A value with no DynamoDB form, `v`: every path that sends one, none of them through a key. */
export const valueCases = (w: RefusedWorld, v: number): ReadonlyArray<Case> => {
  const { Events, Slots } = w
  const base = { gaugeId: "g", slot: 1, score: 1 }
  const key = { gaugeId: "g", slot: 1 }
  return [
    ["put", (c) => c.entities.Gauges.put({ ...base, plain: v }).asEffect()],
    ["put, nested", (c) => c.entities.Gauges.put({ ...base, list: [v] }).asEffect()],
    ["create", (c) => c.entities.Gauges.create({ ...base, plain: v }).asEffect()],
    ["upsert", (c) => c.entities.Gauges.upsert({ ...base, plain: v }).asEffect()],
    ["update set", (c) => c.entities.Gauges.update(key).set({ plain: v }).asEffect()],
    ["update add", (c) => c.entities.Gauges.update(key).add({ plain: v }).asEffect()],
    ["update subtract", (c) => c.entities.Gauges.update(key).subtract({ plain: v }).asEffect()],
    [
      "update condition",
      (c) => c.entities.Gauges.update(key).set({ plain: 1 }).condition({ plain: v }).asEffect(),
    ],
    ["put condition", (c) => c.entities.Gauges.put(base).condition({ plain: v }).asEffect()],
    ["delete condition", (c) => c.entities.Gauges.delete(key).condition({ plain: v }).asEffect()],
    [
      "query filter",
      (c) => c.entities.Gauges.byScore({ gaugeId: "g" }).filter({ plain: v }).collect(),
    ],
    [
      "query filter, paginated",
      (c) =>
        Stream.runCollect(
          c.entities.Gauges.byScore({ gaugeId: "g" }).filter({ plain: v }).paginate(),
        ),
    ],
    [
      "query filter, counted",
      (c) => c.entities.Gauges.byScore({ gaugeId: "g" }).filter({ plain: v }).count(),
    ],
    ["scan filter", (c) => c.entities.Gauges.scan().filter({ plain: v }).collect()],
    ["collection filter", (c) => c.collections.ticks({ score: 1 }).filter({ plain: v }).collect()],
    ["Batch.write", () => Batch.write([Slots.put({ slotId: "s", slot: 1, plain: v })])],
    [
      "transactWrite put",
      () => Transaction.transactWrite([Slots.put({ slotId: "s", slot: 1, plain: v })]),
    ],
    [
      "transactWrite update",
      () =>
        Transaction.transactWrite([
          Slots.update({ slotId: "s", slot: 1 }).pipe(Entity.set({ plain: v })),
        ]),
    ],
    [
      "an unbound query's filter",
      () =>
        Query.collect(
          (w.Gauges as any).query
            .byScore({ gaugeId: "g", score: 1 })
            .pipe(Query.filterExpr(parseShorthand({ eq: { plain: v } }))),
        ),
    ],
    ["aggregate create", (c) => c.aggregates.Agg.create({ id: "a", rate: 1, note: v, lines: [] })],
    ["aggregate list filter", (c) => c.aggregates.Agg.list({ rate: 1 }, { filter: { note: v } })],
    ["event append", () => Events.append({ streamId: "s" }, [new Noted({ n: v })], 0)],
  ]
}

/** `run` refused with `code`, as a `ValidationError` over a `tag`. */
export const expectRefused = (
  run: Effect.Effect<unknown, unknown, any>,
  tag: string,
  code: string,
) =>
  Effect.map(Effect.flip(run), (error: any) => {
    expect(error._tag).toBe("ValidationError")
    expect(error.cause._tag).toBe(tag)
    expect(error.cause.message).toContain(code)
  })

/** `run` refused as a value DynamoDB can't store: a `ValidationError` saying so in words. */
export const expectUnstorable = (run: Effect.Effect<unknown, unknown, any>) =>
  Effect.map(Effect.flip(run), (error: any) => {
    expect(error._tag).toBe("ValidationError")
    expect(String(error.cause)).toContain("[EDD-9124]")
  })
