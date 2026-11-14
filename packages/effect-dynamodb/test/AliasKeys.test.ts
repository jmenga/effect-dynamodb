/**
 * After `rekey`, `foo bar` and `foo%20bar` are two values (#183), on a table that stores what it is
 * sent. The scenarios are in `helpers/AliasKeys.ts`; `connected.alias-keys.test.ts` runs them on
 * DynamoDB Local. Every operation runs on every cell for the variant with both key halves, and on
 * the cells rekeyed in each direction for the variants without sort key composites and with a
 * `field:` rename (the values scenarios run every variant on every cell).
 */

import { describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import {
  aggregateValueScenarios,
  CELLS,
  entityOperationScenarios,
  entityValueScenarios,
  type Harness,
  streamValueScenarios,
  VARIANTS,
} from "./helpers/AliasKeys.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

const harness: Harness = {
  on: (world, body) => {
    const table = makeRecordingTable({ indexes: { gsi1: { pk: "gsi1pk", sk: "gsi1sk" } } })
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
        rows: () => Effect.sync(() => [...table.items.values()].map((row) => ({ ...row }))),
        as: (other, inner) =>
          Effect.gen(function* () {
            const current = yield* other.client()
            return yield* inner(current)
          }).pipe(Effect.provide(other.MainTable.layer({ name: "alias" }))),
      })
    }).pipe(
      Effect.provide(Layer.merge(table.layer, world.MainTable.layer({ name: "alias" }))),
    ) as never
  },
}

describe("after rekey, each value is its own", () => {
  for (const [group, scenarios] of [
    ["an entity's values", entityValueScenarios],
    [
      "an entity's operations",
      [
        ...entityOperationScenarios([VARIANTS[0]], CELLS),
        ...entityOperationScenarios(VARIANTS.slice(1), [CELLS[0], CELLS[3]]),
      ],
    ],
    ["an aggregate", aggregateValueScenarios],
    ["a stream", streamValueScenarios],
  ] as const) {
    describe(group, () => {
      for (const scenario of scenarios) {
        it.effect(scenario.name, () => scenario.run(harness))
      }
    })
  }
})
