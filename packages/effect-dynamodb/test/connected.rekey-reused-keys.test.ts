/**
 * Keys used again after a delete (#240, `helpers/ReusedKeys.ts`) on DynamoDB Local: a tombstone
 * without `preserveUnique` never takes the sentinel its item's live row holds, and with it the
 * item's rows, whose keys chain through delete and re-create cycles, each reach their own value's
 * key in one run, which its dry run says, and a second run moves nothing. DynamoDB scans in hash
 * order, and the run is made with one segment and with three.
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
import { rekeyOutcome } from "./helpers/RekeyOutcome.js"
import {
  RESERVED,
  REUSED_ROWS,
  reservedOf,
  reusedWorld,
  SENTINELS_ON,
  sentinelsOf,
  writeReusedKeys,
} from "./helpers/ReusedKeys.js"

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

describeConnected("rekey over keys used again after a delete", () => {
  for (const segments of [1, 3]) {
    for (const reservations of [false, true]) {
      it.live(
        `${segments} segment(s), reservations ${reservations}`,
        () =>
          Effect.gen(function* () {
            const tableName = `reused-keys-${Date.now()}-${tables++}`
            const off = reusedWorld(false)
            const on = reusedWorld(true)
            const scan = Effect.gen(function* () {
              const raw = yield* DynamoClient
              const { Items = [] } = yield* raw.scan({ TableName: tableName, ConsistentRead: true })
              return Items
            })
            const runs = yield* Effect.gen(function* () {
              const db: any = yield* on.client
              yield* db.tables.MainTable.create()
              return yield* Effect.gen(function* () {
                // A tombstone's key holds its time, to the millisecond.
                yield* writeReusedKeys(off, Effect.sleep("5 millis")).pipe(
                  Effect.provide(off.MainTable.layer({ name: tableName })),
                )
                const rows = yield* scan
                const options = { segments, pageSize: 3, ...(reservations && { reservations }) }
                const dry: Table.RekeyReport = yield* db.tables.MainTable.rekey({
                  ...options,
                  dryRun: true,
                })
                const real: Table.RekeyReport = yield* db.tables.MainTable.rekey(options)
                const sentinels = sentinelsOf(yield* scan)
                const again: Table.RekeyReport = yield* db.tables.MainTable.rekey(options)
                const taken = yield* reservedOf(db)
                return { rows, dry, real, sentinels, again, taken }
              }).pipe(Effect.ensuring(Effect.ignore(db.tables.MainTable.delete())))
            }).pipe(
              Effect.provide(Layer.merge(ClientLayer, on.MainTable.layer({ name: tableName }))),
            )
            expect(runs.rows).toHaveLength(REUSED_ROWS)
            expect(rekeyOutcome(runs.dry)).toEqual(rekeyOutcome(runs.real))
            expect(runs.real.conflicts).toEqual([])
            expect(runs.real.scanned).toBe(REUSED_ROWS)
            expect(runs.sentinels).toEqual(SENTINELS_ON)
            expect(runs.again.sentinelsMoved).toBe(0)
            expect(Object.values(runs.again.moved).every((n) => n === 0)).toBe(true)
            expect(runs.again.conflicts).toEqual([])
            expect(runs.taken).toEqual(RESERVED.map(() => "reserved"))
          }) as Effect.Effect<void, unknown>,
      )
    }
  }
})
