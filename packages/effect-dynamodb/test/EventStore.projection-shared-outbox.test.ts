/**
 * Read models sharing an outbox table and its sparse index (#237): `drainPending` drains the rows
 * of its own read model, and leaves another read model's items, with no claim taken on them, to
 * that read model's drainer. The index is keyed by entity type alone, so read models of one entity
 * type in other schemas or primary collections list each other's items there.
 */

import { describe, expect, it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { DateTime, Effect, Layer, Schema, SchemaGetter } from "effect"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
import { fromAttributeMap } from "../src/Marshaller.js"
import * as Table from "../src/Table.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

class Placed extends Schema.TaggedClass<Placed>()("Placed", { amount: Schema.Number }) {}

const Ledger = Schema.Struct({
  id: Schema.String,
  total: Schema.Number,
  version: Schema.Number,
  rev: Schema.Number,
})
type Ledger = typeof Ledger.Type

const EventsTable = Table.make({
  schema: DynamoSchema.make({ name: "ev", version: 1 }),
  entities: {},
})
const Orders = EventStore.makeStream({
  table: EventsTable,
  streamName: "Order",
  events: [Placed],
  streamId: { composite: ["id"] },
})
const OutboxTable = Table.make({
  schema: DynamoSchema.make({ name: "ev", version: 1 }),
  entities: {},
})
const index = { name: "outbox", pk: "obpk", sk: "obsk" } as const

/**
 * A `Ledger` read model in schema `schemaName` (in primary collection `collection`, when given),
 * whose projection writes `effectOf(row)` into the outbox table, under its index.
 */
const readModel = <A>(
  schemaName: string,
  effect: Schema.Codec<A, any>,
  effectOf: (row: Ledger) => A,
  collection?: string,
) => {
  const Ledgers = Entity.make({
    model: Ledger,
    entityType: "Ledger",
    primaryKey: {
      ...(collection === undefined ? {} : { collection }),
      pk: { field: "pk", composite: ["id"] },
      sk: { field: "sk", composite: [] },
    },
  })
  const ReadTable = Table.make({
    schema: DynamoSchema.make({ name: schemaName, version: 1 }),
    entities: { Ledgers },
  })
  const Notifying = EventStore.projection({
    stream: Orders,
    readModel: Ledgers,
    key: (id: { readonly id: string }) => ({ id: id.id }),
    initial: (id: { readonly id: string }): Ledger => ({ id: id.id, total: 0, version: 0, rev: 0 }),
    evolve: (state, event) => Effect.succeed({ ...state, total: state.total + event.data.amount }),
    checkpoint: "version",
    revision: "rev",
    outbox: {
      schema: effect,
      effects: (_event, next) => (next === undefined ? [] : [effectOf(next)]),
      table: OutboxTable,
      index,
    },
  })
  return { Ledgers, ReadTable, Notifying }
}

const A = readModel("a", Schema.Struct({ total: Schema.Number }), (row) => ({ total: row.total }))
const B = readModel("b", Schema.Struct({ label: Schema.String }), (row) => ({
  label: `b${row.total}`,
}))
const C = readModel(
  "a",
  Schema.Struct({ code: Schema.Number }),
  (row) => ({ code: row.total }),
  "c",
)

const setup = () => {
  const table = makeRecordingTable({ indexes: { outbox: { pk: index.pk, sk: index.sk } } })
  const layer = Layer.mergeAll(
    table.layer,
    EventsTable.layer({ name: "events" }),
    OutboxTable.layer({ name: "outbox" }),
    A.ReadTable.layer({ name: "read-a" }),
    B.ReadTable.layer({ name: "read-b" }),
    C.ReadTable.layer({ name: "read-c" }),
  )
  /** The outbox items left, by their rows' partition keys. */
  const outboxRows = () =>
    [...table.items.values()]
      .filter((item) => item.__edd_e__?.S === "Ledger#outbox")
      .map((item) => fromAttributeMap(item) as Record<string, unknown>)
  return { table, layer, outboxRows }
}

describe("drainPending on an outbox index shared by read models of one entity type", () => {
  it.effect("drains its own rows, and leaves another read model's items unclaimed", () => {
    const { table, layer, outboxRows } = setup()
    return Effect.gen(function* () {
      yield* Orders.append({ id: "1" }, [new Placed({ amount: 2 })], 0)
      yield* Orders.append({ id: "2" }, [new Placed({ amount: 5 })], 0)
      const events = [...(yield* Orders.read({ id: "1" })), ...(yield* Orders.read({ id: "2" }))]
      for (const side of [A, B, C]) yield* side.Notifying.applyBatch(events)
      expect(outboxRows()).toHaveLength(6)
      table.take()

      const seen: Array<unknown> = []
      const swept = yield* A.Notifying.drainPending((effect) =>
        Effect.sync(() => seen.push(effect)),
      )
      expect(swept).toEqual({ delivered: 2, undelivered: [] })
      expect(seen).toEqual([{ total: 2 }, { total: 5 }])
      // The index query is the one 1.40.0 sent; no request touched another read model's item.
      const sent = table.take()
      expect(sent[0]).toEqual({
        command: "Query",
        input: {
          TableName: "outbox",
          IndexName: "outbox",
          KeyConditionExpression: "#p = :p",
          ExpressionAttributeNames: { "#p": "obpk" },
          ExpressionAttributeValues: { ":p": { S: "Ledger#outbox" } },
        },
      })
      for (const { input } of sent.slice(1)) {
        expect(JSON.stringify(input)).not.toMatch(/\$b#v1#|\$a#v1#c#/)
      }
      const left = outboxRows()
      expect(left.map((item) => item.__edd_row_pk__).sort()).toEqual([
        "$a#v1#c#id_1",
        "$a#v1#c#id_2",
        "$b#v1#ledger#id_1",
        "$b#v1#ledger#id_2",
      ])
      // Nothing claimed them: their drainers deliver them now.
      expect(left.every((item) => item.__edd_claim__ === undefined)).toBe(true)
      for (const [side, want] of [
        [B, [{ label: "b2" }, { label: "b5" }]],
        [C, [{ code: 2 }, { code: 5 }]],
      ] as const) {
        const delivered: Array<unknown> = []
        const result = yield* side.Notifying.drainPending((effect) =>
          Effect.sync(() => delivered.push(effect)),
        )
        expect(result).toEqual({ delivered: 2, undelivered: [] })
        expect(delivered).toEqual(want)
      }
      expect(outboxRows()).toEqual([])
    }).pipe(Effect.provide(layer))
  })
})

/**
 * A read model keyed by a date beside one keyed by a label whose text a date's can't spell
 * (`at_2026-…` beside `at_x_q`) binds since a date's key text is modelled (#237). Each drainer
 * takes as its own only the keys its read model's composer writes: a date's reader would take
 * `x_q` as the date's text, which no date writes. Every date schema beside every label shape the
 * bind check admits, under either setting: each `drainPending` delivers exactly its own item, and
 * a pair it refuses is one 1.40.0 refused too.
 */
describe("drainPending, a read model keyed by a date beside one keyed by a label", () => {
  const datesSchemas = [
    ["DynamoModel.DateString", DynamoModel.DateString],
    ["Schema.DateTimeUtc", Schema.DateTimeUtc],
    ["Schema.Date", Schema.Date],
    ["DynamoModel.UnsafeDateString", DynamoModel.UnsafeDateString],
    ["DynamoModel.DateTimeZoned", DynamoModel.DateTimeZoned],
    ["DynamoModel.DateEpochSeconds", DynamoModel.DateEpochSeconds],
    ["DynamoModel.DateEpochMs", DynamoModel.DateEpochMs],
    ["an optional DynamoModel.DateString", Schema.optional(DynamoModel.DateString)],
  ] as const
  // Labels a date's text may or may not spell: a letter, a digit, a letter of an ISO text.
  const labels = ["at_x", "at_1", "at_t"] as const
  const at = DateTime.makeUnsafe("2026-11-11T08:00:00.000Z")
  const valueOf = (schema: Schema.Top) =>
    schema === Schema.Date
      ? new Date("2026-11-11T08:00:00.000Z")
      : schema === DynamoModel.UnsafeDateString
        ? "2026-11-11T08:00:00.000Z"
        : schema === DynamoModel.DateTimeZoned
          ? DateTime.makeZonedUnsafe(at, { timeZone: "Europe/London" })
          : at

  const world = (
    dateSchema: Schema.Top,
    label: string,
    escapeKeys: boolean,
    lead: ReadonlyArray<string> = [],
  ) => {
    const schema = DynamoSchema.make({ name: "dates", version: 1, escapeKeys })
    const Outbox = Table.make({ schema, entities: {} })
    const Model = Schema.Struct({
      at: dateSchema as typeof Schema.DateTimeUtc,
      [label]: Schema.String,
      shop: Schema.String,
      total: Schema.Number,
      cp: Schema.optional(Schema.Number),
      rev: Schema.optional(Schema.Number),
    } as unknown as { at: typeof Schema.DateTimeUtc; total: typeof Schema.Number })
    const key = { at: valueOf(dateSchema), [label]: "q", shop: "s" }
    const sides = (["at", label] as const).map((composite, i) => {
      const Ledgers = Entity.make({
        model: Model as unknown as Schema.Struct<any>,
        entityType: "Ledger",
        primaryKey: {
          pk: { field: "pk", composite: [...lead, composite] },
          sk: { field: "sk", composite: [] },
        },
      } as any)
      const ReadTable = Table.make({ schema, entities: { Ledgers } })
      const Notifying = EventStore.projection({
        stream: Orders,
        readModel: Ledgers,
        key: () => key,
        initial: () => ({ ...key, total: 0 }),
        evolve: (state: any, event: any) =>
          Effect.succeed({ ...state, total: state.total + event.data.amount }),
        checkpoint: "cp",
        revision: "rev",
        outbox: {
          schema: Schema.String,
          effects: () => [i === 0 ? "date" : "label"],
          table: Outbox,
          index,
        },
      } as any)
      return { Ledgers, ReadTable, Notifying: Notifying as any, name: `read${i}` }
    })
    const table = makeRecordingTable({ indexes: { outbox: { pk: index.pk, sk: index.sk } } })
    const layer = Layer.mergeAll(
      table.layer,
      EventsTable.layer({ name: "events" }),
      Outbox.layer({ name: "outbox" }),
      ...sides.map((side) => side.ReadTable.layer({ name: side.name })),
    )
    const bound = DynamoClient.make({
      entities: { A: sides[0]!.Ledgers, B: sides[1]!.Ledgers },
      tables: { Outbox, R0: sides[0]!.ReadTable, R1: sides[1]!.ReadTable },
    } as any).pipe(
      Effect.as("binds"),
      Effect.catchDefect((cause) => Effect.succeed(String(cause))),
    )
    return { sides, layer, bound }
  }

  it.effect(
    "after a string, a date beside a label stays refused, as on 1.40.0",
    () =>
      Effect.gen(function* () {
        for (const escapeKeys of [false, true]) {
          const w = world(Schema.DateTimeUtc, "at_x", escapeKeys, ["shop"])
          // `shop_s#at_x_q#at_2026-…` is a key of both: `shop` can be `s#at_x_q`.
          expect(yield* w.bound.pipe(Effect.provide(w.layer))).toContain(
            "[EDD-9134] DynamoClient.make:",
          )
        }
      }) as Effect.Effect<void, unknown>,
  )

  it.effect(
    "a date with a codec of its own beside a label stays refused, as on 1.40.0",
    () =>
      Effect.gen(function* () {
        // Stored, and keyed, as `x_<ISO>`: `at_x_2026-…` is a key of both.
        const Labelled = Schema.String.pipe(
          Schema.decodeTo(Schema.DateTimeUtc, {
            decode: SchemaGetter.transform((s: string) => DateTime.makeUnsafe(s.slice(2))),
            encode: SchemaGetter.transform((d: DateTime.Utc) => `x_${DateTime.formatIso(d)}`),
          }),
        )
        for (const dateSchema of [Labelled, Schema.DateTimeUtcFromString]) {
          for (const escapeKeys of [false, true]) {
            const w = world(dateSchema, "at_x", escapeKeys)
            expect(yield* w.bound.pipe(Effect.provide(w.layer))).toContain(
              "[EDD-9134] DynamoClient.make:",
            )
          }
        }
      }) as Effect.Effect<void, unknown>,
  )

  for (const escapeKeys of [false, true]) {
    it.effect.each(datesSchemas)(
      `%s beside each label (escapeKeys ${escapeKeys}): each drainer delivers its own`,
      ([, dateSchema]) =>
        Effect.gen(function* () {
          const outcomes: Array<string> = []
          for (const label of labels) {
            const w = world(dateSchema, label, escapeKeys)
            const result = yield* Effect.gen(function* () {
              const bound = yield* w.bound
              if (bound !== "binds") {
                expect(bound).toContain("[EDD-9134] DynamoClient.make:")
                return "refused"
              }
              const id = `${label}-${escapeKeys}`
              yield* Orders.append({ id }, [new Placed({ amount: 2 })], 0)
              const events = yield* Orders.read({ id })
              for (const side of w.sides) yield* side.Notifying.applyBatch(events)
              const delivered: Array<ReadonlyArray<unknown>> = []
              for (const side of w.sides) {
                const seen: Array<unknown> = []
                yield* side.Notifying.drainPending((effect: unknown) =>
                  Effect.sync(() => void seen.push(effect)),
                )
                delivered.push(seen)
              }
              expect(delivered).toEqual([["date"], ["label"]])
              return "drains its own"
            }).pipe(Effect.provide(w.layer))
            outcomes.push(`${label}: ${result}`)
          }
          // A zoned date's text goes on in any text: only a label it can't start is apart.
          expect(outcomes).toEqual(
            dateSchema === DynamoModel.DateTimeZoned
              ? ["at_x: drains its own", "at_1: refused", "at_t: drains its own"]
              : labels.map((label) => `${label}: drains its own`),
          )
        }) as Effect.Effect<void, unknown>,
    )
  }
})

/**
 * Read models of one entity type in one schema whose keys only a value holding `#` can make the
 * same (`[shop]` with `north#branch_b1` beside `[shop, branch]`), or whose keys part where a
 * literal can't spell the other's label: they bind, as on 1.39.0. A key alone can't always say
 * whose an item is, so from 1.41.0 each outbox item names its read model (`__edd_rm__`), and each
 * drainer delivers exactly its own (#237). An item written before, at a key both write, is drained
 * as 1.40.0 drained it.
 */
describe("drainPending, read models whose keys only a value holding `#` can make the same", () => {
  const world = (pairs: "prefix" | "literal") => {
    const schema = DynamoSchema.make({ name: "one", version: 1 })
    const Outbox = Table.make({ schema, entities: {} })
    const Model = Schema.Struct({
      shop: Schema.String,
      branch: Schema.String,
      at: Schema.Literals(["a", "b"]),
      at_x: Schema.String,
      total: Schema.Number,
      cp: Schema.optional(Schema.Number),
      rev: Schema.optional(Schema.Number),
    })
    const key = { shop: "north", branch: "b1", at: "a", at_x: "q" } as const
    const composites =
      pairs === "prefix" ? ([["shop"], ["shop", "branch"]] as const) : ([["at"], ["at_x"]] as const)
    const sides = composites.map((pk, i) => {
      const Ledgers = Entity.make({
        model: Model,
        entityType: "Ledger",
        primaryKey: { pk: { field: "pk", composite: [...pk] }, sk: { field: "sk", composite: [] } },
      } as any)
      const ReadTable = Table.make({ schema, entities: { Ledgers } })
      const Notifying = EventStore.projection({
        stream: Orders,
        readModel: Ledgers,
        key: () => key,
        initial: () => ({ ...key, total: 0 }),
        evolve: (state: any, event: any) =>
          Effect.succeed({ ...state, total: state.total + event.data.amount }),
        checkpoint: "cp",
        revision: "rev",
        outbox: {
          schema: Schema.String,
          effects: () => [i === 0 ? "A" : "B"],
          table: Outbox,
          index,
        },
      } as any)
      return { Ledgers, ReadTable, Notifying: Notifying as any, name: `read${i}` }
    })
    const table = makeRecordingTable({ indexes: { outbox: { pk: index.pk, sk: index.sk } } })
    const layer = Layer.mergeAll(
      table.layer,
      EventsTable.layer({ name: "events" }),
      Outbox.layer({ name: "outbox" }),
      ...sides.map((side) => side.ReadTable.layer({ name: side.name })),
    )
    const bound = DynamoClient.make({
      entities: { A: sides[0]!.Ledgers, B: sides[1]!.Ledgers },
      tables: { Outbox, R0: sides[0]!.ReadTable, R1: sides[1]!.ReadTable },
    } as any)
    const outboxItems = () =>
      [...table.items.values()].filter((item) => item.__edd_e__?.S === "Ledger#outbox")
    const apply = (id: string) =>
      Effect.gen(function* () {
        yield* bound
        yield* Orders.append({ id }, [new Placed({ amount: 2 })], 0)
        const events = yield* Orders.read({ id })
        for (const side of sides) yield* side.Notifying.applyBatch(events)
      })
    const drain = (i: 0 | 1) =>
      Effect.gen(function* () {
        const seen: Array<unknown> = []
        const result = yield* sides[i]!.Notifying.drainPending((effect: unknown) =>
          Effect.sync(() => void seen.push(effect)),
        )
        expect(result.undelivered).toEqual([])
        return seen
      })
    return { layer, outboxItems, apply, drain }
  }

  it.effect.each(["prefix", "literal"] as const)(
    "%s: each drainer delivers exactly its own, and leaves the other's unclaimed",
    (pairs) => {
      const w = world(pairs)
      return Effect.gen(function* () {
        yield* w.apply(`own-${pairs}`)
        expect(w.outboxItems()).toHaveLength(2)
        expect(yield* w.drain(0)).toEqual(["A"])
        const left = w.outboxItems()
        expect(left).toHaveLength(1)
        expect(left[0]!.__edd_claim__).toBeUndefined()
        expect(yield* w.drain(1)).toEqual(["B"])
        expect(w.outboxItems()).toEqual([])
      }).pipe(Effect.provide(w.layer)) as Effect.Effect<void, unknown>
    },
  )

  it.effect(
    "an item written before 1.41.0, at a key both write, is drained as 1.40.0 drained it",
    () => {
      const w = world("prefix")
      return Effect.gen(function* () {
        yield* w.apply("unmarked")
        // As 1.40.0 wrote them: no read-model tag.
        for (const item of w.outboxItems()) delete (item as Record<string, unknown>).__edd_rm__
        // `[shop]` writes `shop_north#branch_b1` too (a shop holding `#`): it drains both, as
        // 1.40.0 did; `[shop, branch]` writes no `shop_north`, and leaves that one.
        expect(yield* w.drain(0)).toEqual(["A", "B"])
        expect(yield* w.drain(1)).toEqual([])
        expect(w.outboxItems()).toEqual([])
      }).pipe(Effect.provide(w.layer)) as Effect.Effect<void, unknown>
    },
  )

  it.effect("an unmarked item at a key only the other writes is left to its drainer", () => {
    const w = world("prefix")
    return Effect.gen(function* () {
      yield* w.apply("left")
      for (const item of w.outboxItems()) delete (item as Record<string, unknown>).__edd_rm__
      expect(yield* w.drain(1)).toEqual(["B"])
      const left = w.outboxItems()
      expect(left.map((item) => item.__edd_row_pk__?.S)).toEqual(["$one#v1#ledger#shop_north"])
      expect(left[0]!.__edd_claim__).toBeUndefined()
      expect(yield* w.drain(0)).toEqual(["A"])
    }).pipe(Effect.provide(w.layer)) as Effect.Effect<void, unknown>
  })
})

/**
 * Read models whose ROW keys are the same text (#237): `[shop]` with `north#branch_b1` and
 * `[shop, branch]` with `north` and `b1`, under `escapeKeys: false`, on separate read tables with
 * one outbox. Their items sit under one row key, apart only by revision. Each drainer delivers
 * exactly its own, judged item by item at the head of the row, whichever way it drains (1.39.0
 * and 1.40.0 delivered both read models' items to the first drainer, or failed decoding the
 * other's and left it claimed).
 */
describe("drain at a row key two read models write", () => {
  const world = (escapeKeys: boolean, schemas: "same" | "different") => {
    const schema = DynamoSchema.make({ name: "one", version: 1, escapeKeys })
    const Outbox = Table.make({ schema, entities: {} })
    const sidesOf = [
      { pk: ["shop"], key: { shop: "north#branch_b1", branch: "-" }, revision: 1 },
      { pk: ["shop", "branch"], key: { shop: "north", branch: "b1" }, revision: 10 },
    ] as const
    const sides = sidesOf.map(({ pk, key, revision }, i) => {
      const Ledgers = Entity.make({
        model: Schema.Struct({
          shop: Schema.String,
          branch: Schema.String,
          total: Schema.Number,
          cp: Schema.optional(Schema.Number),
          rev: Schema.optional(Schema.Number),
        }),
        entityType: "Ledger",
        primaryKey: { pk: { field: "pk", composite: [...pk] }, sk: { field: "sk", composite: [] } },
      } as any)
      const ReadTable = Table.make({ schema, entities: { Ledgers } })
      const effect =
        i === 0 || schemas === "same"
          ? Schema.Struct({ total: Schema.Number })
          : Schema.Struct({ label: Schema.String })
      const Notifying = EventStore.projection({
        stream: Orders,
        readModel: Ledgers,
        key: () => key,
        initial: () => ({ ...key, total: 0 }),
        evolve: (state: any, event: any) =>
          Effect.succeed({ ...state, total: state.total + event.data.amount }),
        checkpoint: "cp",
        revision: { field: "rev", initial: revision },
        outbox: {
          schema: effect,
          effects: (_event: unknown, next: any) =>
            next === undefined
              ? []
              : [
                  i === 0
                    ? { total: next.total }
                    : schemas === "same"
                      ? { total: next.total + 100 }
                      : { label: `b${next.total}` },
                ],
          table: Outbox,
          index,
        },
      } as any)
      return { Ledgers, ReadTable, Notifying: Notifying as any, name: `read${i}` }
    })
    // One recording table per physical table: the read models' rows are at one key.
    const tables = new Map<string, ReturnType<typeof makeRecordingTable>>()
    const tableOf = (name: string) => {
      const known = tables.get(name)
      if (known !== undefined) return known
      const made = makeRecordingTable({ indexes: { outbox: { pk: index.pk, sk: index.sk } } })
      tables.set(name, made)
      return made
    }
    const client = new Proxy(tableOf("events").client, {
      get: (_target, operation) => (input: any) => {
        if (operation === "transactWriteItems") {
          const groups = new Map<string, Array<unknown>>()
          for (const item of input.TransactItems) {
            const name = (Object.values(item)[0] as { readonly TableName: string }).TableName
            groups.set(name, [...(groups.get(name) ?? []), item])
          }
          return Effect.forEach([...groups], ([name, items]) =>
            (tableOf(name).client as any)[operation]({ ...input, TransactItems: items }),
          ).pipe(Effect.as({}))
        }
        return (tableOf(String(input.TableName)).client as any)[operation](input)
      },
    })
    const table = tableOf("outbox")
    const layer = Layer.mergeAll(
      Layer.succeed(DynamoClient, client as any),
      EventsTable.layer({ name: "events" }),
      Outbox.layer({ name: "outbox" }),
      ...sides.map((side) => side.ReadTable.layer({ name: side.name })),
    )
    const bound = DynamoClient.make({
      entities: { A: sides[0]!.Ledgers, B: sides[1]!.Ledgers },
      tables: { Outbox, R0: sides[0]!.ReadTable, R1: sides[1]!.ReadTable },
    } as any)
    const outboxItems = () =>
      [...table.items.values()].filter((item) => item.__edd_e__?.S === "Ledger#outbox")
    const events = (id: string) =>
      Effect.gen(function* () {
        yield* bound
        yield* Orders.append({ id }, [new Placed({ amount: 2 })], 0)
        return yield* Orders.read({ id })
      })
    const collect = () => {
      const seen: Array<unknown> = []
      return { seen, deliver: (effect: unknown) => Effect.sync(() => void seen.push(effect)) }
    }
    return { sides, table, layer, outboxItems, events, collect }
  }
  const B_EFFECT = { same: { total: 102 }, different: { label: "b2" } } as const

  for (const schemas of ["same", "different"] as const) {
    it.effect(`drainPending (effect schemas ${schemas}): each drainer delivers its own`, () => {
      const w = world(false, schemas)
      return Effect.gen(function* () {
        const events = yield* w.events(`pending-${schemas}`)
        for (const side of w.sides) yield* side.Notifying.applyBatch(events)
        const items = w.outboxItems()
        // One row key, two items, each naming its read model.
        expect(
          new Set(items.map((item) => `${item.__edd_row_pk__?.S}|${item.__edd_row_sk__?.S}`)),
        ).toHaveProperty("size", 1)
        expect(new Set(items.map((item) => item.__edd_rm__?.S))).toHaveProperty("size", 2)
        const a = w.collect()
        expect(yield* w.sides[0]!.Notifying.drainPending(a.deliver)).toEqual({
          delivered: 1,
          undelivered: [],
        })
        expect(a.seen).toEqual([{ total: 2 }])
        const left = w.outboxItems()
        expect(left).toHaveLength(1)
        expect(left[0]!.__edd_claim__).toBeUndefined()
        const b = w.collect()
        expect(yield* w.sides[1]!.Notifying.drainPending(b.deliver)).toEqual({
          delivered: 1,
          undelivered: [],
        })
        expect(b.seen).toEqual([B_EFFECT[schemas]])
        expect(w.outboxItems()).toEqual([])
      }).pipe(Effect.provide(w.layer)) as Effect.Effect<void, unknown>
    })

    it.effect(`drain and deliver (effect schemas ${schemas}): each delivers its own`, () => {
      const w = world(false, schemas)
      return Effect.gen(function* () {
        const events = yield* w.events(`deliver-${schemas}`)
        // B writes first; A's write then drains its row, where B's item waits for B.
        yield* w.sides[1]!.Notifying.applyBatch(events)
        const a = w.collect()
        const applied = yield* w.sides[0]!.Notifying.applyBatch(events, { deliver: a.deliver })
        expect(applied.undelivered ?? []).toEqual([])
        expect(a.seen).toEqual([{ total: 2 }])
        expect(w.outboxItems()).toHaveLength(1)
        // The other's item at A's row: passed over, unclaimed, by `drain` too.
        const again = w.collect()
        yield* w.sides[0]!.Notifying.drain({ shop: "north#branch_b1", branch: "-" }, again.deliver)
        expect(again.seen).toEqual([])
        expect(w.outboxItems()[0]!.__edd_claim__).toBeUndefined()
        const b = w.collect()
        yield* w.sides[1]!.Notifying.drain({ shop: "north", branch: "b1" }, b.deliver)
        expect(b.seen).toEqual([B_EFFECT[schemas]])
        expect(w.outboxItems()).toEqual([])
      }).pipe(Effect.provide(w.layer)) as Effect.Effect<void, unknown>
    })
  }

  it.effect("a row holding only the drainer's own items: the requests 1.40.0 sent", () => {
    const w = world(false, "same")
    return Effect.gen(function* () {
      const events = yield* w.events("own-only")
      yield* w.sides[0]!.Notifying.applyBatch(events)
      w.table.take()
      yield* w.sides[0]!.Notifying.drainPending(w.collect().deliver)
      const queries = w.table
        .take()
        .filter((request) => request.command === "Query")
        .map((request) => request.input as Record<string, unknown>)
      // The index query, then the row's head twice (the item, then nothing): no start key.
      expect(queries).toHaveLength(3)
      for (const query of queries) expect(query.ExclusiveStartKey).toBeUndefined()
    }).pipe(Effect.provide(w.layer)) as Effect.Effect<void, unknown>
  })
})
