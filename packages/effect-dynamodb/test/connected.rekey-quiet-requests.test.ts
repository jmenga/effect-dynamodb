/**
 * `rekey` over a table with nothing to move sends what the published 1.40.0 sent (#240), in the
 * order it sent them, on DynamoDB Local, whose scan returns the rows in the order the fixture's
 * generator met them (`fixtures/rekey-requests-1.40.0.json`, see `helpers/QuietTable.ts`; and
 * `fixtures/rekey-requests-reservations-1.40.0.json`, see `helpers/ReservationTable.ts`).
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 */

import { it } from "@effect/vitest"
import { Config, Effect, Layer } from "effect"
import { describe, expect } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import type * as Table from "../src/Table.js"
import {
  QUIET_MODULES,
  quietFixture,
  quietRuns,
  RESERVATION_MODULES,
  RESERVATION_RUNS_ALIKE,
  reservationFixture,
} from "./helpers/QuietFixture.js"
import { quietWorld, requestText } from "./helpers/QuietTable.js"
import { reservationWorld } from "./helpers/ReservationTable.js"

const ENDPOINT = Effect.runSync(
  Config.String("DYNAMODB_ENDPOINT").pipe(Config.withDefault("http://localhost:8000")),
)

let dynamoAvailable = false
try {
  const res = await fetch(ENDPOINT, { method: "POST", signal: AbortSignal.timeout(1000) }).catch(
    () => null,
  )
  dynamoAvailable = res !== null
} catch {
  dynamoAvailable = false
}
const describeConnected = dynamoAvailable ? describe : describe.skip

const ClientLayer = DynamoClient.layer({
  region: "us-east-1",
  endpoint: ENDPOINT,
  credentials: { accessKeyId: "local", secretAccessKey: "local" },
})

let tables = 0

/** `rekey` with `options` over `rows`, on a new DynamoDB Local table: its report and requests. */
const replay = (
  world: { readonly MainTable: any; readonly client: any },
  rows: ReadonlyArray<Record<string, any>>,
  options: Table.RekeyOptions,
) =>
  Effect.gen(function* () {
    const tableName = `quiet-requests-${Date.now()}-${tables++}`
    const sent: Array<string> = []
    let recording = false
    const recorder = Layer.effect(
      DynamoClient,
      Effect.gen(function* () {
        const inner: any = yield* DynamoClient
        return new Proxy(inner, {
          get: (target, property) => {
            const method = Reflect.get(target, property)
            if (typeof method !== "function" || typeof property !== "string") return method
            return (input: unknown) => {
              if (recording) sent.push(requestText(property, input, tableName))
              return method.call(target, input)
            }
          },
        })
      }) as never,
    ).pipe(Layer.provide(ClientLayer)) as Layer.Layer<DynamoClient>
    const report: Table.RekeyReport = yield* Effect.gen(function* () {
      const db: any = yield* world.client
      const raw = yield* DynamoClient
      yield* db.tables.MainTable.create()
      return yield* Effect.gen(function* () {
        for (const row of rows) yield* raw.putItem({ TableName: tableName, Item: row })
        recording = true
        const report = yield* db.tables.MainTable.rekey(options)
        recording = false
        return report as Table.RekeyReport
      }).pipe(Effect.ensuring(Effect.ignore(db.tables.MainTable.delete())))
    }).pipe(Effect.provide(Layer.merge(recorder, world.MainTable.layer({ name: tableName }))))
    return { report, sent }
    // The world's modules are untyped: so are its requirements.
  }) as Effect.Effect<{ report: Table.RekeyReport; sent: Array<string> }, unknown>

describeConnected(
  "rekey over a table with nothing to move sends 1.40.0's requests, in order",
  () => {
    for (const [setting, stored] of Object.entries(quietFixture.settings)) {
      for (const [run, options, expected] of quietRuns(stored.runs)) {
        it.live(`${setting}, ${run}`, () =>
          Effect.gen(function* () {
            const world = quietWorld(QUIET_MODULES, setting === "escapeKeys on")
            const { report, sent } = yield* replay(world, stored.rows, {
              ...options,
              streams: [world.Counters],
            })
            expect(report.conflicts).toEqual([])
            expect(sent).toEqual(expected)
          }),
        )
      }
    }
  },
)

describeConnected(
  "rekey over unique sentinels whose keys were used again sends 1.40.0's requests, in order",
  () => {
    for (const [setting, stored] of Object.entries(reservationFixture.settings)) {
      for (const [run, options, expected] of quietRuns(stored.runs, RESERVATION_RUNS_ALIKE)) {
        it.live(`${setting}, ${run}`, () =>
          Effect.gen(function* () {
            const world = reservationWorld(RESERVATION_MODULES, setting.endsWith("escapeKeys on"))
            const { report, sent } = yield* replay(world, stored.rows, options)
            expect(report.conflicts).toEqual([])
            expect({
              scanned: report.scanned,
              unchanged: report.unchanged,
              skipped: report.skipped,
            }).toEqual(stored.reports[options.dryRun === true ? "dry run" : "run"])
            expect(sent).toEqual(expected)
          }),
        )
      }
    }
  },
)
