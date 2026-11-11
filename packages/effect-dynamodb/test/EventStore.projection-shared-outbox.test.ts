/**
 * Read models sharing an outbox table and its sparse index (#237): `drainPending` drains the rows
 * of its own read model, and leaves another read model's items, with no claim taken on them, to
 * that read model's drainer. The index is keyed by entity type alone, so read models of one entity
 * type in other schemas or primary collections list each other's items there.
 */

import { describe, expect, it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { DateTime, Effect, Layer, Schema } from "effect"
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
