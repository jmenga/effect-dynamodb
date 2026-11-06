/**
 * Rows 1.37.0 wrote (#183), on a table that stores what it is sent. The scenarios are in
 * `helpers/Rows137.ts`; `connected.rows-1.37.0.test.ts` runs them on DynamoDB Local.
 */

import { describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { makeRecordingTable } from "./helpers/RecordingTable.js"
import {
  aggregateAliasScenario,
  aggregateScenario,
  type Harness,
  historyScenarios,
  indexKeyScenarios,
  itemScenarios,
  limitScenarios,
  numberUnderOffScenario,
  sentinelScenario,
  streamScenario,
} from "./helpers/Rows137.js"

const harness: Harness = {
  on: (world, body) => {
    const table = makeRecordingTable({
      indexes: { gsi1: { pk: "gsi1pk", sk: "gsi1sk" }, lsi1: { pk: "pk", sk: "lsi1sk" } },
    })
    return Effect.gen(function* () {
      const db = yield* world.client()
      return yield* body(db, {
        seed: (row) =>
          Effect.sync(() => {
            table.items.set(`${row.pk.S}|${row.sk.S}`, row)
          }),
        remove: (row) =>
          Effect.sync(() => {
            table.items.delete(`${row.pk.S}|${row.sk.S}`)
          }),
        rows: () => Effect.sync(() => [...table.items.values()]),
        as: (other, inner) =>
          Effect.gen(function* () {
            const current = yield* other.client()
            return yield* inner(current)
          }).pipe(Effect.provide(other.MainTable.layer({ name: "rows137" }))),
      })
    }).pipe(
      Effect.provide(Layer.merge(table.layer, world.MainTable.layer({ name: "rows137" }))),
    ) as never
  },
}

describe("rows 1.37.0 wrote", () => {
  describe("an item", () => {
    for (const scenario of itemScenarios) {
      it.effect(scenario.name, () => scenario.run(harness))
    }
  })
  describe("an index key", () => {
    for (const scenario of indexKeyScenarios) {
      it.effect(scenario.name, () => scenario.run(harness))
    }
  })
  describe("history", () => {
    for (const scenario of historyScenarios) {
      it.effect(scenario.name, () => scenario.run(harness))
    }
  })
  it.effect("a unique sentinel", () => sentinelScenario(harness))
  it.effect("a number under escapeKeys off", () => numberUnderOffScenario(harness))
  it.effect("a stream", () => streamScenario(harness))
  it.effect("an aggregate", () => aggregateScenario(harness))
  it.effect("an aggregate at its current keys, where they alias", () =>
    aggregateAliasScenario(harness),
  )
  describe("what isn't recognized", () => {
    for (const scenario of limitScenarios) {
      it.effect(scenario.name, () => scenario.run(harness))
    }
  })
})
