/**
 * `rekey`'s report of index keys that differ and `repairIndexKeys` (#185) on a recording table. The
 * same scenarios run on DynamoDB Local in `connected.rekey-repair.test.ts`.
 */

import { describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { makeRecordingTable } from "./helpers/RecordingTable.js"
import * as RekeyRepair from "./helpers/RekeyRepair.js"

const harness = RekeyRepair.harnessOn(() => {
  const table = makeRecordingTable({ indexes: RekeyRepair.RECORDING_INDEXES })
  return { tableName: "t", client: table.layer, acquire: Effect.void, release: Effect.void }
})

for (const [name, scenarios] of [
  ["the rows 1.38.0 stored", RekeyRepair.fixtureScenarios],
  ["a writer in between", RekeyRepair.racingScenarios],
  ["the shapes", RekeyRepair.shapeScenarios],
  ["Z-order", RekeyRepair.zOrderScenarios],
  ["a ref's id", RekeyRepair.refScenarios],
  ["composites the library stamps", RekeyRepair.stampedScenarios],
  ["a row that moves", RekeyRepair.moveScenarios],
] as const) {
  describe(name, () => {
    for (const scenario of scenarios) {
      it.effect(scenario.name, () => scenario.run(harness))
    }
  })
}
