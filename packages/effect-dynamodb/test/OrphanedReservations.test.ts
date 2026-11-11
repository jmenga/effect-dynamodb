/**
 * `rekey`'s report of unique sentinels no row holds and `releaseOrphanedReservations`, on a
 * recording table. The same scenarios run on DynamoDB Local in
 * `connected.orphaned-reservations.test.ts`.
 */

import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import * as OrphanedReservations from "./helpers/OrphanedReservations.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"
import * as RekeyRepair from "./helpers/RekeyRepair.js"

const harness = RekeyRepair.harnessOn(() => {
  const table = makeRecordingTable()
  return { tableName: "t", client: table.layer, acquire: Effect.void, release: Effect.void }
})

for (const [name, scenarios] of [
  ["the rows 1.39.0 left", OrphanedReservations.fixtureScenarios],
  ["reservations a row holds", OrphanedReservations.heldScenarios],
  ["a writer in between", OrphanedReservations.racingScenarios],
  ["what isn't judged", OrphanedReservations.untouchedScenarios],
  ["what DynamoDB can't store", OrphanedReservations.recordingOnlyScenarios],
] as const) {
  describe(name, () => {
    for (const scenario of scenarios) {
      it.live(scenario.name, () => scenario.run(harness))
    }
  })
}

describe("the sentinel as it is now", () => {
  it.effect("one a write claimed after the scan read it is judged as it is now: held", () => {
    const table = makeRecordingTable()
    const w = OrphanedReservations.world(false)
    const owner = OrphanedReservations.itemKey("account", "a")
    const claimed = OrphanedReservations.sentinelRow(
      "account",
      5,
      OrphanedReservations.itemKey("account", "z"),
    )
    const store = (row: Record<string, any>) => table.items.set(`${row.pk.S}|${row.sk.S}`, row)
    store(OrphanedReservations.orphanOf5)
    // The scan has read the sentinel naming `a`; another item claims the value before the judging.
    table.hooks.onRequest = ({ command, input }) => {
      if (command === "GetItem" && input.Key.pk?.S === owner.pk) {
        store(claimed)
        store(OrphanedReservations.itemRow("account", "z", { N: "5" }))
      }
    }
    return Effect.gen(function* () {
      const db = yield* w.client
      const report = yield* db.tables.MainTable.rekey({ releaseOrphanedReservations: true })
      expect(report.reservations).toEqual({
        orphaned: 0,
        released: 0,
        skipped: 0,
        undecided: 0,
        entries: [],
      })
      expect(table.requests.filter((r) => r.command === "TransactWriteItems")).toEqual([])
      expect(table.items.get(`${claimed.pk.S}|${claimed.sk.S}`)).toEqual(claimed)
    }).pipe(Effect.provide(Layer.merge(table.layer, w.MainTable.layer({ name: "t" }))))
  })
})
