/**
 * Rows 1.37.0 wrote (#183), on a table that stores what it is sent. The scenarios are in
 * `helpers/Rows137.ts`; `connected.rows-1.37.0.test.ts` runs them on DynamoDB Local.
 */

import { describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { makeRecordingTable } from "./helpers/RecordingTable.js"
import {
  aggregateAliasScenarios,
  aggregateScenarios,
  bothKeysScenarios,
  chainScenarios,
  type Harness,
  historyScenarios,
  indexKeyScenarios,
  invertedRowScenarios,
  itemScenarios,
  number136Scenarios,
  sentinelScenarios,
  streamScenarios,
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
  for (const [group, scenarios] of [
    ["an item", itemScenarios],
    ["an index key", indexKeyScenarios],
    ["history", historyScenarios],
    ["a unique sentinel", sentinelScenarios],
    ["a stream", streamScenarios],
    ["an aggregate", aggregateScenarios],
    ["an aggregate at its keys", aggregateAliasScenarios],
    ["a number", number136Scenarios],
    ["a chain", chainScenarios],
    ["both keys", bothKeysScenarios],
    ["an inverted row", invertedRowScenarios],
  ] as const) {
    describe(group, () => {
      for (const scenario of scenarios) {
        it.effect(scenario.name, () => scenario.run(harness))
      }
    })
  }
})
