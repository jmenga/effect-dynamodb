/**
 * `rekey` over a table with nothing to move sends what the published 1.40.0 sent (#240): the
 * rows 1.40.0 stored, every kind a member writes, each under its current key, and the requests its
 * `rekey` sent over them (`fixtures/rekey-requests-1.40.0.json`, see `helpers/QuietTable.ts`). On
 * the recording table the scan returns rows in another order than DynamoDB Local's, so the
 * requests are compared as a multiset here; `connected.rekey-quiet-requests.test.ts` compares them
 * in order.
 */

import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import type { DynamoClientService } from "../src/DynamoClient.js"
import type * as Table from "../src/Table.js"
import { gatedLayer } from "./helpers/GatedClient.js"
import { QUIET_MODULES, QUIET_RUNS, quietFixture } from "./helpers/QuietFixture.js"
import { quietWorld, requestText } from "./helpers/QuietTable.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

describe("rekey over a table with nothing to move sends 1.40.0's requests", () => {
  for (const [setting, stored] of Object.entries(quietFixture.settings)) {
    for (const [run, expected] of Object.entries(stored.runs)) {
      it.effect(
        `${setting}, ${run}`,
        () =>
          Effect.gen(function* () {
            const world = quietWorld(QUIET_MODULES, setting === "escapeKeys on")
            const table = makeRecordingTable()
            for (const row of stored.rows) table.items.set(`${row.pk?.S}|${row.sk?.S}`, row)
            const sent: Array<string> = []
            const layer = Layer.merge(
              gatedLayer(table.client as DynamoClientService, (command, input, send) => {
                sent.push(requestText(command, input, "t"))
                return send
              }),
              world.MainTable.layer({ name: "t" }),
            )
            const report: Table.RekeyReport = yield* Effect.gen(function* () {
              const db: any = yield* world.client
              return yield* db.tables.MainTable.rekey({
                ...QUIET_RUNS[run],
                streams: [world.Counters],
              })
            }).pipe(Effect.provide(layer))
            expect(report.conflicts).toEqual([])
            expect(Object.values(report.moved).every((n) => n === 0)).toBe(true)
            expect([...sent].sort()).toEqual([...expected].sort())
            // The world's modules are untyped (`QuietModules`): so are its requirements.
          }) as Effect.Effect<void, unknown>,
      )
    }
  }
})
