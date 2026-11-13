/**
 * A `rebuild` enqueues nothing in the outbox (#237), in memory, against what the published 1.40.0
 * did (`helpers/RebuildScenarios.ts`, `fixtures/outbox-rebuild-1.40.0.json`, captured once from
 * the published package against DynamoDB Local; never regenerate it from this repo). 1.40.0's
 * rebuild wrote the effects of the events it re-derived into the outbox again, so each was
 * delivered twice. Now it writes the row alone: no outbox item, the pending one delivered once, a
 * later live event's once. Single- and multi-source, over a live row and an absent one,
 * `escapeKeys` off and on. `catchUp` is unchanged: it enqueues the effects of the events the row
 * hasn't applied, and only those.
 */

import { describe, expect, it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Effect, Layer, Schema } from "effect"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
import * as Table from "../src/Table.js"
import { layoutOf } from "./helpers/OutboxScenarios.js"
import { checkRebuilt, rebuildFixture } from "./helpers/RebuildChecks.js"
import {
  REBUILD_MODES,
  REBUILD_STATES,
  rebuildKey,
  rebuildScenario,
} from "./helpers/RebuildScenarios.js"
import { makeRoutedTables } from "./helpers/RoutedTables.js"

const lib = { DynamoSchema, Table, Entity, EventStore, DynamoClient }
const tables = { events: "events", read: "read", outbox: "outbox" } as const
const routed = () =>
  makeRoutedTables((name) => {
    const layout = layoutOf("none")[name as keyof typeof tables] ?? layoutOf("none").events
    return { keys: { pk: layout.pk, sk: layout.sk }, indexes: layout.indexes }
  }, "events")

describe("a rebuild enqueues nothing in the outbox (1.40.0: each effect again)", () => {
  expect(rebuildFixture.version).toBe("1.40.0")
  for (const mode of REBUILD_MODES) {
    for (const state of REBUILD_STATES) {
      for (const escapeKeys of [false, true]) {
        const at = rebuildKey(mode, state, escapeKeys)
        it.effect(at, () =>
          Effect.gen(function* () {
            const r = routed()
            const ran = yield* rebuildScenario(lib, tables, mode, state, { escapeKeys }).run(
              Layer.succeed(DynamoClient, r.client as any),
            )
            checkRebuilt(ran, rebuildFixture.scenarios[at]!, state)
          }),
        )
      }
    }
  }
})

describe("catchUp enqueues only the effects of the events the row hasn't applied", () => {
  class Added extends Schema.TaggedClass<Added>()("Added", { amount: Schema.Number }) {}
  const schema = DynamoSchema.make({ name: "caught", version: 1 })
  const EventsTable = Table.make({ schema, entities: {} })
  const Orders = EventStore.makeStream({
    table: EventsTable,
    streamName: "Order",
    events: [Added],
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
  const ReadTable = Table.make({ schema, entities: { Ledgers } })
  const projection = EventStore.projection({
    stream: Orders,
    readModel: Ledgers,
    key: () => ({ shop: "north" }),
    initial: () => ({ shop: "north", total: 0 }),
    evolve: (row, event) => Effect.succeed({ ...row, total: row.total + event.data.amount }),
    checkpoint: "cp",
    revision: "rev",
    outbox: {
      schema: Schema.Struct({ n: Schema.Number }),
      effects: (event) => [{ n: event.version }],
    },
  })

  it.effect("after a rebuild, and with an event still to apply", () => {
    const r = makeRoutedTables(undefined, "events")
    return Effect.gen(function* () {
      yield* DynamoClient.make({ entities: { Ledgers }, tables: { ReadTable } })
      const drained = Effect.gen(function* () {
        const seen: Array<number> = []
        yield* projection.drain({ shop: "north" }, (effect) =>
          Effect.sync(() => void seen.push(effect.n)),
        )
        return seen
      })
      yield* Orders.append({ id: "s" }, [new Added({ amount: 2 }), new Added({ amount: 3 })], 0)
      const [first] = yield* Orders.read({ id: "s" })
      yield* projection.apply(first!)
      expect(yield* drained).toEqual([1])
      // Its last event never arrived: `catchUp` applies it, with its effect, and only it.
      expect((yield* projection.catchUp({ id: "s" })).applied.map((e) => e.version)).toEqual([2])
      expect(yield* drained).toEqual([2])
      // At the head (after a rebuild, too), there is nothing to apply or enqueue.
      yield* projection.rebuild({ id: "s" })
      expect((yield* projection.catchUp({ id: "s" })).applied).toEqual([])
      expect(yield* drained).toEqual([])
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(DynamoClient, r.client as any),
          EventsTable.layer({ name: "events" }),
          ReadTable.layer({ name: "read" }),
        ),
      ),
    )
  })
})
