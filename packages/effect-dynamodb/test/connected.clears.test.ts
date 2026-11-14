/**
 * Clearing a field (#177, #178), on DynamoDB Local: the same scenarios as
 * `Entity.clears.test.ts`, over a real table and its real secondary indexes.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb"
import { it } from "@effect/vitest"
import { Config, Effect } from "effect"
import { afterAll, describe } from "vitest"
import * as Clears from "./helpers/ClearScenarios.js"
import * as NoStoredForm from "./helpers/NoStoredFormScenarios.js"
import { makeTablePool } from "./helpers/TablePool.js"

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

// Each scenario on an empty table of its definition, one at a time: reused, emptied between them.
const pool = makeTablePool(
  new DynamoDBClient({
    region: "us-east-1",
    endpoint: ENDPOINT,
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  }),
  "clears",
)
afterAll(() => pool.drain())

const harness = Clears.connectedHarness(ENDPOINT, pool)

describeConnected("clearing a field, on DynamoDB", () => {
  for (const [group, scenarios] of Object.entries({
    ...Clears.allScenarios,
    ...NoStoredForm.allScenarios,
  })) {
    describe(group, () => {
      for (const scenario of scenarios) {
        it.effect(scenario.name, () => scenario.run(harness), { timeout: 20_000 })
      }
    })
  }
})
