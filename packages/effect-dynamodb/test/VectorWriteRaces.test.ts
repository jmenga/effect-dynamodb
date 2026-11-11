/**
 * Writes landing between a vector entity's read and a write that copies what it read, on a
 * recording table. The same scenarios run on DynamoDB Local in
 * `connected.vector-write-races.test.ts`.
 */
import { describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { makeRecordingTable } from "./helpers/RecordingTable.js"
import * as RekeyRepair from "./helpers/RekeyRepair.js"
import * as VectorWriteRaces from "./helpers/VectorWriteRaces.js"

const harness = RekeyRepair.harnessOn(() => {
  const table = makeRecordingTable()
  return { tableName: "t", client: table.layer, acquire: Effect.void, release: Effect.void }
})

describe("a write landing between a vector entity's read and its write", () => {
  for (const scenario of VectorWriteRaces.reembedScenarios) {
    it.live(scenario.name, () => scenario.run(harness))
  }
})

describe("a reembed landing between a read-first write's read and its write", () => {
  for (const scenario of VectorWriteRaces.copyScenarios) {
    it.live(scenario.name, () => scenario.run(harness))
  }
})
