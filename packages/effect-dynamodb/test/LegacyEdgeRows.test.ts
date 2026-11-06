/**
 * Rows an upgrade from 1.36 meets at the edges of the key fallback and `rekey` (#171),
 * on a table that stores what it is sent. The scenarios are in
 * `helpers/LegacyEdgeRows.ts`; `connected.legacy-edge-rows.test.ts` runs them on
 * DynamoDB Local.
 */

import { describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { clientOf, type Harness, scenarios } from "./helpers/LegacyEdgeRows.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

const harness = (): Harness => {
  const table = makeRecordingTable({ indexes: { gsi: { pk: "gpk", sk: "gsk" } } })
  return {
    seed: (row) =>
      Effect.sync(() => {
        table.items.set(`${row.pk!.S}|${row.sk!.S}`, row)
      }),
    rows: () => Effect.sync(() => [...table.items.values()]),
    inWorld: (world, body) =>
      Effect.gen(function* () {
        const db = yield* clientOf(world)
        return yield* body(db)
      }).pipe(
        Effect.provide(Layer.merge(table.layer, world.MainTable.layer({ name: "edge" }))),
      ) as never,
  }
}

describe("legacy edge rows", () => {
  for (const scenario of scenarios) {
    it.effect(scenario.name, () => scenario.run(harness()) as Effect.Effect<void>)
  }
})
