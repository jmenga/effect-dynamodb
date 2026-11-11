/**
 * A read of a stored row lacking a field whose transformation throws on `undefined`, against
 * DynamoDB Local: the rows published 1.39.0 stored, the field removed, read on an aggregate, a
 * stream and a projection, fail as 1.39.0's read failed (`helpers/MissingKeyReads.ts`,
 * `fixtures/missing-key-reads-1.39.0.json`).
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 */

import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb"
import { it } from "@effect/vitest"
import { Config, Effect, Layer } from "effect"
import { describe, expect } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import { type Case, cases, throwingOnAnyValue } from "./helpers/MissingKeyReads.js"

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

let tables = 0
const onTable = (c: Case) => {
  const tableName = `missing-key-reads-${Date.now()}-${tables++}`
  const keys = (pk: string, sk: string) => [
    { AttributeName: pk, KeyType: "HASH" as const },
    { AttributeName: sk, KeyType: "RANGE" as const },
  ]
  return Effect.acquireUseRelease(
    Effect.gen(function* () {
      const client = yield* DynamoClient
      yield* client.createTable({
        TableName: tableName,
        BillingMode: "PAY_PER_REQUEST",
        KeySchema: keys("pk", "sk"),
        AttributeDefinitions: [
          { AttributeName: "pk", AttributeType: "S" },
          { AttributeName: "sk", AttributeType: "S" },
          ...(c.gsi1
            ? [
                { AttributeName: "gsi1pk", AttributeType: "S" as const },
                { AttributeName: "gsi1sk", AttributeType: "S" as const },
              ]
            : []),
        ],
        ...(c.gsi1 && {
          GlobalSecondaryIndexes: [
            {
              IndexName: "gsi1",
              KeySchema: keys("gsi1pk", "gsi1sk"),
              Projection: { ProjectionType: "ALL" },
            },
          ],
        }),
      })
      for (const Item of c.rows) {
        yield* Effect.promise(() => raw.send(new PutItemCommand({ TableName: tableName, Item })))
      }
    }),
    () => c.read.pipe(Effect.provide(c.layer(tableName))),
    () =>
      Effect.gen(function* () {
        const client = yield* DynamoClient
        yield* client.deleteTable({ TableName: tableName })
      }).pipe(Effect.ignore),
  ).pipe(Effect.provide(Layer.fresh(ClientLayer))) as Effect.Effect<Record<string, unknown>>
}

describeConnected("a read of a row lacking a field whose step throws on its absence", () => {
  for (const c of cases()) {
    it.effect(`${c.name}: as 1.39.0`, () =>
      Effect.gen(function* () {
        expect(yield* onTable(c)).toEqual(c.expected)
      }),
    )
  }

  const c = throwingOnAnyValue()
  it.effect(`${c.name}: still a defect`, () =>
    Effect.gen(function* () {
      expect(yield* onTable(c)).toEqual(c.expected)
    }),
  )
})
