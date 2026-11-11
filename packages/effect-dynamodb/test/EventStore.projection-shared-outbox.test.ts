/**
 * Read models sharing an outbox table and its sparse index (#237): `drainPending` drains the rows
 * of its own read model, and leaves another read model's items, with no claim taken on them, to
 * that read model's drainer. The index is keyed by entity type alone, so read models of one entity
 * type in other schemas or primary collections list each other's items there.
 */

import { describe, expect, it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Effect, Layer, Schema } from "effect"
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
