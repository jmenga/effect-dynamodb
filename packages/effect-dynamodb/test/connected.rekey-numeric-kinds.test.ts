/**
 * `rekey` moves rows stored under the other numeric kind's key text (`EDD-9128`), against DynamoDB
 * Local: the connected twin of `RekeyNumericKinds.test.ts`, over the rows published 1.39.0 stored
 * for keys declared `Schema.Union([Schema.Number, Schema.BigInt])`, now declared one kind.
 * Scenarios: `helpers/RekeyNumericKindScenarios.ts`.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 */

import { DynamoDBClient, PutItemCommand, ScanCommand } from "@aws-sdk/client-dynamodb"
import { it } from "@effect/vitest"
import { Config, Effect, Layer } from "effect"
import { describe } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import {
  definitions,
  fixtureRows,
  keysOf,
  type Row,
  scenarios,
} from "./helpers/RekeyNumericKindScenarios.js"

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

const credentials = { accessKeyId: "local", secretAccessKey: "local" }
const raw = new DynamoDBClient({ region: "us-east-1", endpoint: ENDPOINT, credentials })
const ClientLayer = DynamoClient.layer({ region: "us-east-1", endpoint: ENDPOINT, credentials })

const key = (hash: string, range: string) => [
  { AttributeName: hash, KeyType: "HASH" as const },
  { AttributeName: range, KeyType: "RANGE" as const },
]

let tables = 0

describeConnected("rekey moves rows under the other numeric kind's text on DynamoDB", () => {
  for (const scenario of scenarios) {
    it.effect(scenario.name, () => {
      const { Counters, Readings, Loose, Main, Teams } = definitions(scenario.Kind)
      const tableName = `kinds-${Date.now()}-${tables++}`
      const keys = Effect.promise(async () => {
        const { Items = [] } = await raw.send(
          new ScanCommand({ TableName: tableName, ConsistentRead: true }),
        )
        return keysOf(Items as ReadonlyArray<Row>)
      })
      return Effect.acquireUseRelease(
        Effect.gen(function* () {
          const client = yield* DynamoClient
          yield* client.createTable({
            TableName: tableName,
            BillingMode: "PAY_PER_REQUEST",
            AttributeDefinitions: ["pk", "sk", "gsi1pk", "gsi1sk"].map((AttributeName) => ({
              AttributeName,
              AttributeType: "S" as const,
            })),
            KeySchema: key("pk", "sk"),
            GlobalSecondaryIndexes: [
              {
                IndexName: "gsi1",
                KeySchema: key("gsi1pk", "gsi1sk"),
                Projection: { ProjectionType: "ALL" },
              },
            ],
          })
          yield* Effect.promise(async () => {
            for (const Item of fixtureRows) {
              await raw.send(new PutItemCommand({ TableName: tableName, Item }))
            }
          })
        }),
        () =>
          Effect.gen(function* () {
            const db = yield* DynamoClient.make({
              entities: { Counters, Readings, Loose },
              aggregates: { Teams },
              tables: { Main },
            } as never) as Effect.Effect<any, never, any>
            yield* scenario.check(db, keys)
          }),
        () =>
          Effect.gen(function* () {
            const client = yield* DynamoClient
            yield* client.deleteTable({ TableName: tableName })
          }).pipe(Effect.ignore),
      ).pipe(
        Effect.provide(Layer.merge(ClientLayer, Main.layer({ name: tableName }))),
      ) as Effect.Effect<void, unknown>
    })
  }
})
