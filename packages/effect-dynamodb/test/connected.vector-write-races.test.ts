/**
 * Writes landing between a vector entity's read and a write that copies what it read, against
 * DynamoDB Local: real conditions on real requests. The same scenarios run on a recording table in
 * `VectorWriteRaces.test.ts`.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 */

import { it } from "@effect/vitest"
import { Config, Effect } from "effect"
import { describe } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import * as RekeyRepair from "./helpers/RekeyRepair.js"
import * as VectorWriteRaces from "./helpers/VectorWriteRaces.js"

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

const harness = RekeyRepair.harnessOn(() => {
  const tableName = `vector-races-${Date.now()}-${tables++}`
  return {
    tableName,
    client: ClientLayer,
    acquire: Effect.gen(function* () {
      const client = yield* DynamoClient
      yield* client.createTable({
        TableName: tableName,
        BillingMode: "PAY_PER_REQUEST",
        AttributeDefinitions: [
          { AttributeName: "pk", AttributeType: "S" },
          { AttributeName: "sk", AttributeType: "S" },
        ],
        KeySchema: [
          { AttributeName: "pk", KeyType: "HASH" },
          { AttributeName: "sk", KeyType: "RANGE" },
        ],
      })
    }),
    release: Effect.gen(function* () {
      const client = yield* DynamoClient
      yield* client.deleteTable({ TableName: tableName })
    }),
  }
})

describeConnected(
  "a write landing between a vector entity's read and its write, on DynamoDB",
  () => {
    for (const scenario of VectorWriteRaces.reembedScenarios) {
      it.live(scenario.name, () => scenario.run(harness))
    }
  },
)
