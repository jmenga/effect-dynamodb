/**
 * Clearing a field (#177, #178), on DynamoDB Local: the same scenarios as
 * `Entity.clears.test.ts`, over a real table and its real secondary indexes.
 */

import { it } from "@effect/vitest"
import { Config, Effect } from "effect"
import { describe } from "vitest"
import * as Clears from "./helpers/ClearScenarios.js"

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

const harness = Clears.connectedHarness(ENDPOINT)

describeConnected("clearing a field, on DynamoDB", () => {
  for (const [group, scenarios] of Object.entries(Clears.allScenarios)) {
    describe(group, () => {
      for (const scenario of scenarios) {
        it.effect(scenario.name, () => scenario.run(harness), { timeout: 20_000 })
      }
    })
  }
})
