/**
 * `rekey` over a table with nothing to move sends what the published 1.40.0 sent (#240), in the
 * order it sent them, on DynamoDB Local, whose scan returns the rows in the order the fixture's
 * generator met them (`fixtures/rekey-requests-1.40.0.json`, see `helpers/QuietTable.ts`).
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
import { QUIET_MODULES, QUIET_RUNS, quietFixture } from "./helpers/QuietFixture.js"
import { quietWorld, requestText } from "./helpers/QuietTable.js"

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

describeConnected(
  "rekey over a table with nothing to move sends 1.40.0's requests, in order",
  () => {
    for (const [setting, stored] of Object.entries(quietFixture.settings)) {
      for (const [run, expected] of Object.entries(stored.runs)) {
        it.live(
          `${setting}, ${run}`,
          () =>
            Effect.gen(function* () {
              const world = quietWorld(QUIET_MODULES, setting === "escapeKeys on")
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
                      if (typeof method !== "function" || typeof property !== "string")
                        return method
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
                  for (const row of stored.rows)
                    yield* raw.putItem({ TableName: tableName, Item: row })
                  recording = true
                  const report = yield* db.tables.MainTable.rekey({
                    ...QUIET_RUNS[run],
                    streams: [world.Counters],
                  })
                  recording = false
                  return report as Table.RekeyReport
                }).pipe(Effect.ensuring(Effect.ignore(db.tables.MainTable.delete())))
              }).pipe(
                Effect.provide(Layer.merge(recorder, world.MainTable.layer({ name: tableName }))),
              )
              expect(report.conflicts).toEqual([])
              expect(sent).toEqual(expected)
              // The world's modules are untyped (`QuietModules`): so are its requirements.
            }) as Effect.Effect<void, unknown>,
        )
      }
    }
  },
)
