/**
 * Keys composed from a row read back are the keys `put` composed, on DynamoDB Local: the same
 * scenarios as `StoredRowKeys.test.ts`, over a real table and its real secondary index.
 */

import { it } from "@effect/vitest"
import { Config, Effect } from "effect"
import { describe } from "vitest"
import * as StoredRowKeys from "./helpers/StoredRowKeyScenarios.js"

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

const harness = StoredRowKeys.connectedHarness(ENDPOINT)

describeConnected("keys composed from a row read back, on DynamoDB", () => {
  for (const [group, scenarios] of Object.entries(StoredRowKeys.allScenarios)) {
    describe(group, () => {
      for (const scenario of scenarios) {
        it.effect(scenario.name, () => scenario.run(harness), { timeout: 30_000 })
      }
    })
  }
})
