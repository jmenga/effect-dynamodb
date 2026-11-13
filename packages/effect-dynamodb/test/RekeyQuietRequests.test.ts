/**
 * `rekey` over a table with nothing to move sends what the published 1.40.0 sent (#240): the
 * rows 1.40.0 stored, every kind a member writes, each under its current key, and the requests its
 * `rekey` sent over them (`fixtures/rekey-requests-1.40.0.json`, see `helpers/QuietTable.ts`); and
 * tables of unique sentinels, an item's key used again after each kind of delete and the rows
 * 1.39.0 left (`fixtures/rekey-requests-reservations-1.40.0.json`, see
 * `helpers/ReservationTable.ts`), where only a run asking for `reservations` reads more. On the
 * recording table the scan returns rows in another order than DynamoDB Local's, so the requests
 * are compared as a multiset here; `connected.rekey-quiet-requests.test.ts` compares them in order.
 */

import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import type { DynamoClientService } from "../src/DynamoClient.js"
import type * as Table from "../src/Table.js"
import { gatedLayer } from "./helpers/GatedClient.js"
import {
  QUIET_MODULES,
  QUIET_RUNS,
  quietFixture,
  quietRuns,
  RESERVATION_MODULES,
  RESERVATION_RUNS_ALIKE,
  reservationFixture,
} from "./helpers/QuietFixture.js"
import { quietWorld, requestText } from "./helpers/QuietTable.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"
import { reservationWorld } from "./helpers/ReservationTable.js"

/** `rekey` with `options` over `rows`, on a recording table: its report, and what it sent. */
const replay = (
  world: { readonly MainTable: any; readonly client: any },
  rows: ReadonlyArray<Record<string, any>>,
  options: Table.RekeyOptions,
) =>
  Effect.gen(function* () {
    const table = makeRecordingTable()
    for (const row of rows) table.items.set(`${row.pk?.S}|${row.sk?.S}`, row)
    const before = JSON.stringify([...table.items.entries()])
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
      return yield* db.tables.MainTable.rekey(options)
    }).pipe(Effect.provide(layer))
    return { report, sent, unchanged: JSON.stringify([...table.items.entries()]) === before }
    // The world's modules are untyped: so are its requirements.
  }) as Effect.Effect<
    { report: Table.RekeyReport; sent: Array<string>; unchanged: boolean },
    unknown
  >

describe("rekey over a table with nothing to move sends 1.40.0's requests", () => {
  for (const [setting, stored] of Object.entries(quietFixture.settings)) {
    for (const [run, options, expected] of quietRuns(stored.runs)) {
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
                ...options,
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

describe("rekey over unique sentinels whose keys were used again sends 1.40.0's requests", () => {
  for (const [setting, stored] of Object.entries(reservationFixture.settings)) {
    for (const [run, options, expected] of quietRuns(stored.runs, RESERVATION_RUNS_ALIKE)) {
      it.effect(`${setting}, ${run}`, () =>
        Effect.gen(function* () {
          const world = reservationWorld(RESERVATION_MODULES, setting.endsWith("escapeKeys on"))
          const { report, sent, unchanged } = yield* replay(world, stored.rows, options)
          expect(unchanged).toBe(true)
          expect(report.conflicts).toEqual([])
          expect(Object.values(report.moved).every((n) => n === 0)).toBe(true)
          // Counted as 1.40.0 counted them: a sentinel no live row holds is `unrecognizedKey`.
          const counted = stored.reports[options.dryRun === true ? "dry run" : "run"]!
          expect({
            scanned: report.scanned,
            unchanged: report.unchanged,
            skipped: report.skipped,
          }).toEqual(counted)
          expect(report.reservations).toEqual({
            orphaned: 0,
            released: 0,
            skipped: 0,
            raced: 0,
            undecided: 0,
            entries: [],
          })
          expect([...sent].sort()).toEqual([...expected].sort())
        }),
      )
    }
    it.effect(`${setting}, reservations run: judges them, and writes nothing`, () =>
      Effect.gen(function* () {
        const world = reservationWorld(RESERVATION_MODULES, setting.endsWith("escapeKeys on"))
        const { report, sent, unchanged } = yield* replay(world, stored.rows, {
          ...QUIET_RUNS.run,
          reservations: true,
        })
        expect(unchanged).toBe(true)
        expect(report.conflicts).toEqual([])
        // The sentinels a tombstone under `preserveUnique` holds are held: only the three 1.39.0
        // left behind are orphaned.
        const orphaned = setting.startsWith("1.39.0") ? 3 : 0
        expect(report.reservations).toMatchObject({
          orphaned,
          released: 0,
          skipped: 0,
          raced: 0,
          undecided: 0,
        })
        expect(report.skipped.unrecognizedKey).toBe(0)
        // It reads more than 1.40.0 did, and writes nothing.
        expect(sent.length).toBeGreaterThan(stored.runs.run!.length)
        expect(
          sent.filter((request) => !/^(getItem|query|scan|batchGetItem) /.test(request)),
        ).toEqual([])
      }),
    )
  }
})
