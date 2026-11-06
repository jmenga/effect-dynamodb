/**
 * `rekey`'s report of index keys that differ and `repairIndexKeys` (#185) against DynamoDB Local: the
 * exact bytes the published 1.38.0 stored, real conditions, real index queries.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 */

import { it } from "@effect/vitest"
import { Config, Effect } from "effect"
import { describe } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Table from "../src/Table.js"
import * as RekeyRepair from "./helpers/RekeyRepair.js"

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

const harness = RekeyRepair.harnessOn((world) => {
  const tableName = `repair-${Date.now()}-${tables++}`
  return {
    tableName,
    client: ClientLayer,
    acquire: Effect.gen(function* () {
      const client = yield* DynamoClient
      yield* client.createTable({
        TableName: tableName,
        BillingMode: "PAY_PER_REQUEST",
        ...Table.definition(world.MainTable),
      })
    }),
    release: Effect.gen(function* () {
      const client = yield* DynamoClient
      yield* client.deleteTable({ TableName: tableName })
    }),
  }
})

describeConnected("#185 index keys, on DynamoDB", () => {
  for (const [name, scenarios] of [
    ["the rows 1.38.0 stored", RekeyRepair.fixtureScenarios],
    ["a writer in between", RekeyRepair.racingScenarios],
    ["the shapes", RekeyRepair.shapeScenarios],
    ["Z-order", RekeyRepair.zOrderScenarios],
    ["a ref's id", RekeyRepair.refScenarios],
    ["composites the library stamps", RekeyRepair.stampedScenarios],
    ["a row that moves", RekeyRepair.moveScenarios],
  ] as const) {
    describe(name, () => {
      for (const scenario of scenarios) {
        it.live(scenario.name, () => scenario.run(harness))
      }
    })
  }
})
