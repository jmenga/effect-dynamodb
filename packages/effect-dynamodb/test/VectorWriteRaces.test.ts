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

describe("a write landing between the read and the write of a reembed whose source is too wide for one expression", () => {
  // Hundreds of source fields, or a vector of hundreds of thousands of dimensions: up to a second
  // here, several times that on CI.
  for (const scenario of VectorWriteRaces.wideSourceScenarios) {
    it.live(scenario.name, () => scenario.run(harness), 30_000)
  }
  // Only a table without the 400 KB item limit holds such an item: not on DynamoDB Local.
  const unguardable = VectorWriteRaces.wideSourceUnguardable
  it.live(unguardable.name, () => unguardable.run(harness), 30_000)
})

describe("a reembed landing between a read-first write's read and its write", () => {
  for (const scenario of VectorWriteRaces.copyScenarios) {
    it.live(scenario.name, () => scenario.run(harness))
  }
})

describe("the vector terms are held only where they fit beside the caller's condition", () => {
  for (const scenario of VectorWriteRaces.budgetScenarios) {
    it.live(scenario.name, () => scenario.run(harness))
  }
})
