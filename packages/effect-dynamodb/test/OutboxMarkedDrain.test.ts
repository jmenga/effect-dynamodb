/**
 * Rolling deployment (#237): from 1.41.0 each outbox item names its read model (`__edd_rm__`).
 * The published 1.40.0's `drainPending` was run on an item 1.41.0 writes and on the same item as
 * 1.40.0 wrote it (`fixtures/outbox-marked-drain-1.40.0.json`, captured once from the published
 * package against DynamoDB Local): it sent the same requests, delivered the same effect and
 * deleted both. The item this release writes is the one that drainer was given.
 */

import { readFileSync } from "node:fs"
import { describe, expect, it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Effect, Layer, Schema } from "effect"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
import { readModelTag } from "../src/internal/ProjectionEngine.js"
import * as Table from "../src/Table.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

type Run = {
  readonly item: Record<string, unknown>
  readonly result: unknown
  readonly delivered: ReadonlyArray<unknown>
  readonly requests: ReadonlyArray<unknown>
  readonly left: ReadonlyArray<unknown>
}
const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/outbox-marked-drain-1.40.0.json", import.meta.url), "utf8"),
) as {
  readonly version: string
  readonly tag: string
  readonly unmarked: Run
  readonly marked: Run
}

// The world the fixture was captured in.
const index = { name: "outbox", pk: "obpk", sk: "obsk" } as const
class Placed extends Schema.TaggedClass<Placed>()("Placed", { amount: Schema.Number }) {}
const AppSchema = DynamoSchema.make({ name: "roll", version: 1 })
const EventsTable = Table.make({ schema: AppSchema, entities: {} })
const Orders = EventStore.makeStream({
  table: EventsTable,
  streamName: "Order",
  events: [Placed],
  streamId: { composite: ["id"] },
})
const Ledgers = Entity.make({
  model: Schema.Struct({
    shop: Schema.String,
    total: Schema.Number,
    cp: Schema.optional(Schema.Number),
    rev: Schema.optional(Schema.Number),
  }),
  entityType: "Ledger",
  primaryKey: { pk: { field: "pk", composite: ["shop"] }, sk: { field: "sk", composite: [] } },
})
const ReadTable = Table.make({ schema: AppSchema, entities: { Ledgers } })
const OutboxTable = Table.make({ schema: AppSchema, entities: {} })
const Notifying = EventStore.projection({
  stream: Orders,
  readModel: Ledgers,
  key: () => ({ shop: "north" }),
  initial: () => ({ shop: "north", total: 0 }),
  evolve: (state, event) => Effect.succeed({ ...state, total: state.total + event.data.amount }),
  checkpoint: "cp",
  revision: "rev",
  outbox: {
    schema: Schema.Struct({ total: Schema.Number }),
    effects: (_event, next) => [{ total: next!.total }],
    table: OutboxTable,
    index,
  },
})

describe("1.40.0's drainPending on an outbox item 1.41.0 writes", () => {
  it("delivers and deletes it as it does an item 1.40.0 wrote", () => {
    expect(fixture.version).toBe("1.40.0")
    const { __edd_rm__: tag, ...untagged } = fixture.marked.item
    expect(tag).toEqual({ S: fixture.tag })
    expect(untagged).toEqual(fixture.unmarked.item)
    expect(fixture.unmarked.item).not.toHaveProperty("__edd_rm__")
    expect(fixture.marked.requests).toEqual(fixture.unmarked.requests)
    expect(fixture.marked.result).toEqual({ delivered: 1, undelivered: [] })
    expect(fixture.marked.result).toEqual(fixture.unmarked.result)
    expect(fixture.marked.delivered).toEqual(fixture.unmarked.delivered)
    expect(fixture.marked.left).toEqual([])
    expect(fixture.unmarked.left).toEqual([])
  })

  it.effect("the item this release writes is the one that drainer was given", () => {
    const table = makeRecordingTable({ indexes: { outbox: { pk: index.pk, sk: index.sk } } })
    return Effect.gen(function* () {
      expect(readModelTag(Ledgers)).toBe(fixture.tag)
      yield* Orders.append({ id: "o1" }, [new Placed({ amount: 2 })], 0)
      yield* Notifying.applyBatch(yield* Orders.read({ id: "o1" }))
      const items = [...table.items.values()].filter(
        (item) => item.__edd_e__?.S === "Ledger#outbox",
      )
      expect(items).toEqual([fixture.marked.item])
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          table.layer,
          EventsTable.layer({ name: "events" }),
          ReadTable.layer({ name: "read" }),
          OutboxTable.layer({ name: "outbox" }),
        ),
      ),
    )
  })
})
