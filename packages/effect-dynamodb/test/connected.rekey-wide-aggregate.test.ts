/**
 * An aggregate row too wide to guard whole, with no `updatedAt` or one the caller owns, and an
 * update landing after `rekey` read it, against DynamoDB Local: real limits on the item, the transaction and the guard.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 */

import { it } from "@effect/vitest"
import { Config, Effect } from "effect"
import { describe } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import * as RekeyWideAggregate from "./helpers/RekeyWideAggregate.js"

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
  "rekey of an aggregate row too wide to guard whole, with no updatedAt it stamps, on DynamoDB",
  () => {
    for (const [name, toEscaped, writesStopped, ownUpdatedAt] of RekeyWideAggregate.CASES) {
      it.live(name, () =>
        Effect.gen(function* () {
          const client = yield* DynamoClient
          const tableName = `wide-aggregate-${Date.now()}-${tables++}`
          yield* Effect.acquireUseRelease(
            client.createTable({
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
            }),
            () =>
              RekeyWideAggregate.wideAggregatePin({
                client,
                tableName,
                toEscaped,
                writesStopped,
                ownUpdatedAt,
              }),
            () => Effect.ignore(client.deleteTable({ TableName: tableName })),
          )
        }).pipe(Effect.provide(ClientLayer)),
      )
    }
  },
)
