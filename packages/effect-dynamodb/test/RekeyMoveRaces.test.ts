/**
 * `rekey`'s move of a row a write changed after `rekey` read it, on a recording table. The same
 * scenarios run on DynamoDB Local in `connected.rekey-move-races.test.ts`.
 */
import { describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { expect } from "vitest"
import { makeRecordingTable } from "./helpers/RecordingTable.js"
import * as RekeyMoveRaces from "./helpers/RekeyMoveRaces.js"
import * as RekeyRepair from "./helpers/RekeyRepair.js"

const harness = RekeyRepair.harnessOn(() => {
  const table = makeRecordingTable()
  return { tableName: "t", client: table.layer, acquire: Effect.void, release: Effect.void }
})

describe("rekey's move of a row a write changed after rekey read it", () => {
  it("covers every case of the fixture, and names each case that still loses its write", () => {
    expect(RekeyMoveRaces.CASES).toHaveLength(34)
    for (const name of Object.keys(RekeyMoveRaces.LOST)) {
      expect(RekeyMoveRaces.CASES).toContain(name)
    }
  })

  for (const [label, setting] of RekeyMoveRaces.SETTINGS) {
    describe(label, () => {
      for (const scenario of RekeyMoveRaces.scenarios(setting)) {
        it.live(scenario.name, () => scenario.run(harness))
      }
    })
  }
  for (const scenario of RekeyMoveRaces.unstampedScenarios) {
    it.live(scenario.name, () => scenario.run(harness))
  }
})
