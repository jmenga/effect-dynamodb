/**
 * `rekey` runs started together on DynamoDB Local (#240), the connected twin of
 * `RekeyConcurrentRuns.test.ts`: random tables (`helpers/RandomTables.ts`) written under one
 * `escapeKeys` setting are rekeyed to the other by two or three runs at once, then by one more, and
 * must end where one run over the same rows ends, with no unique sentinel naming a key its row
 * left. A run releasing orphans then releases nothing, and a new item taking any value a row holds
 * is refused. The table two 1.40.0 runs at once left (`fixtures/rekey-two-runs-1.40.0.json`) is
 * repaired by one run. Here the runs' requests interleave as DynamoDB Local answers them, and a
 * transaction touching an item another one is writing is cancelled as DynamoDB cancels it.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 */

import { readFileSync } from "node:fs"
import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { it } from "@effect/vitest"
import { Config, Effect } from "effect"
import { describe, expect } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import type * as Table from "../src/Table.js"
import {
  type Row,
  randomWorld,
  rekeyRunsOn,
  strayed,
  takenValues,
  takeValueOn,
  writeRandom,
} from "./helpers/RandomTables.js"
import { storedRows } from "./helpers/StoredRows.js"

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

const RUNS = [
  { segments: 2, pageSize: 3 },
  { segments: 3, pageSize: 2 },
  { segments: 1, pageSize: 4 },
] as const

let tables = 0

/** A new DynamoDB Local table holding `rows`, `use`d, then deleted. */
const withTable = <A, E>(
  rows: ReadonlyArray<Row>,
  use: (name: string) => Effect.Effect<A, E, DynamoClient>,
) =>
  Effect.gen(function* () {
    const name = `rekey-concurrent-${Date.now()}-${tables++}`
    const world = randomWorld(false)
    const raw = yield* DynamoClient
    yield* Effect.gen(function* () {
      const db = yield* world.client
      yield* db.tables.MainTable.create()
    }).pipe(Effect.provide(world.MainTable.layer({ name })))
    return yield* Effect.gen(function* () {
      for (const row of rows) yield* raw.putItem({ TableName: name, Item: row })
      return yield* use(name)
    }).pipe(Effect.ensuring(Effect.ignore(raw.deleteTable({ TableName: name }))))
  }).pipe(Effect.provide(ClientLayer))

/** Every row of the table `name`. */
const scanAll = (name: string) =>
  Effect.gen(function* () {
    const raw = yield* DynamoClient
    const rows: Array<Row> = []
    let start: Record<string, AttributeValue> | undefined
    do {
      const page = yield* raw.scan({ TableName: name, ExclusiveStartKey: start })
      rows.push(...((page.Items ?? []) as Array<Row>))
      start = page.LastEvaluatedKey as Record<string, AttributeValue> | undefined
    } while (start !== undefined)
    return rows
  })

/** `runs` started together over `rows` under `escapeKeys`: the rows they leave. */
const leftBy = (
  escapeKeys: boolean,
  rows: ReadonlyArray<Row>,
  runs: ReadonlyArray<ReadonlyArray<Table.RekeyOptions>>,
) =>
  withTable(rows, (name) =>
    Effect.gen(function* () {
      for (const together of runs) yield* rekeyRunsOn(escapeKeys, ClientLayer, name, together)
      return yield* scanAll(name)
    }),
  )

/**
 * Over the rows `rows`: release what no row holds, then try to take every value a row holds.
 * What the release counted, and each value a new item took.
 */
const valuesStillReserved = (escapeKeys: boolean, rows: ReadonlyArray<Row>) =>
  withTable(rows, (name) =>
    Effect.gen(function* () {
      const [release] = yield* rekeyRunsOn(escapeKeys, ClientLayer, name, [
        { releaseOrphanedReservations: true, writesStopped: true },
      ])
      const accepted: Array<string> = []
      for (const [n, value] of takenValues(yield* scanAll(name)).entries()) {
        const outcome = yield* takeValueOn(escapeKeys, ClientLayer, name, value, n)
        if (outcome !== "refused") accepted.push(`${value.member} ${value.value}: ${outcome}`)
      }
      return { reservations: release!.reservations, accepted }
    }),
  )

const SEEDS = [1, 2, 3, 4, 5, 6, 18]

describeConnected("rekey runs started together on DynamoDB Local", () => {
  for (const escapeKeys of [true, false]) {
    for (const together of [2, 3]) {
      for (const seed of SEEDS) {
        it.live(
          `to ${escapeKeys ? "on" : "off"}, ${together} runs at once, seed ${seed}`,
          () =>
            Effect.gen(function* () {
              const rows = yield* writeRandom(!escapeKeys, seed)
              const alone = yield* leftBy(escapeKeys, rows, [[RUNS[0]]])
              // What a conflict left, one run alone takes.
              const left = yield* leftBy(escapeKeys, rows, [RUNS.slice(0, together), [RUNS[0]]])
              expect(strayed(left)).toEqual([])
              expect(storedRows(left)).toEqual(storedRows(alone))
              const after = yield* valuesStillReserved(escapeKeys, left)
              expect(after.reservations).toMatchObject({ orphaned: 0, released: 0, undecided: 0 })
              expect(after.accepted).toEqual([])
            }),
          60_000,
        )
      }
    }
  }

  it.live("repairs the table two 1.40.0 runs at once left", () =>
    Effect.gen(function* () {
      const fixture: {
        readonly written: ReadonlyArray<Row>
        readonly leftBy140: ReadonlyArray<Row>
      } = JSON.parse(
        readFileSync(new URL("./fixtures/rekey-two-runs-1.40.0.json", import.meta.url), "utf8"),
      )
      expect(strayed(fixture.leftBy140)).toHaveLength(1)
      const alone = yield* leftBy(false, fixture.written, [[RUNS[0]]])
      const left = yield* leftBy(false, fixture.leftBy140, [[RUNS[0]]])
      expect(strayed(left)).toEqual([])
      expect(storedRows(left)).toEqual(storedRows(alone))
      const after = yield* valuesStillReserved(false, left)
      expect(after.reservations).toMatchObject({ orphaned: 0, released: 0, undecided: 0 })
      expect(after.accepted).toEqual([])
    }),
  )
})
