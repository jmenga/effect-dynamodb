/**
 * Context attributes and a value that keeps what it's given (`EDD-9159`), against DynamoDB Local. The suite is `helpers/AggregateContextRead.ts`; recording-table twin:
 * `AggregateContextRead.test.ts`.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { Config, Effect, Layer } from "effect"
import { describe } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import { INDEX, Main, suite } from "./helpers/AggregateContextRead.js"

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

const ClientLayer = DynamoClient.layer({
  region: "us-east-1",
  endpoint: ENDPOINT,
  credentials: { accessKeyId: "local", secretAccessKey: "local" },
})

type Row = Record<string, AttributeValue>
const sent = new Map<string, Array<string>>()
let made = 0

const harness = {
  onTable: <A, E>(body: (tableName: string) => Effect.Effect<A, E, any>) => {
    const tableName = `aggregate-context-read-${Date.now()}-${made++}`
    const commands: Array<string> = []
    sent.set(tableName, commands)
    return Effect.gen(function* () {
      const raw = yield* DynamoClient
      // Every request the library sends, by its command's name.
      const recording = new Proxy(raw, {
        get: (target, property, receiver) => {
          const value = Reflect.get(target, property, receiver)
          return typeof value === "function" && typeof property === "string"
            ? (input: unknown, ...rest: ReadonlyArray<unknown>) => {
                commands.push(property[0]!.toUpperCase() + property.slice(1))
                return value.apply(target, [input, ...rest])
              }
            : value
        },
      })
      return yield* Effect.acquireUseRelease(
        raw.createTable({
          TableName: tableName,
          BillingMode: "PAY_PER_REQUEST",
          KeySchema: [
            { AttributeName: "pk", KeyType: "HASH" },
            { AttributeName: "sk", KeyType: "RANGE" },
          ],
          AttributeDefinitions: [
            { AttributeName: "pk", AttributeType: "S" },
            { AttributeName: "sk", AttributeType: "S" },
            { AttributeName: INDEX.sk, AttributeType: "S" },
          ],
          LocalSecondaryIndexes: [
            {
              IndexName: INDEX.name,
              KeySchema: [
                { AttributeName: "pk", KeyType: "HASH" },
                { AttributeName: INDEX.sk, KeyType: "RANGE" },
              ],
              Projection: { ProjectionType: "ALL" },
            },
          ],
        }),
        () =>
          body(tableName).pipe(
            Effect.provide(
              Layer.merge(Layer.succeed(DynamoClient, recording), Main.layer({ name: tableName })),
            ),
          ),
        () => raw.deleteTable({ TableName: tableName }).pipe(Effect.ignore),
      )
    }).pipe(Effect.provide(ClientLayer)) as Effect.Effect<A, unknown>
  },
  rows: (tableName: string) =>
    Effect.gen(function* () {
      const raw = yield* DynamoClient
      const found: Array<Row> = []
      let start: Row | undefined
      do {
        const page = yield* raw.scan({
          TableName: tableName,
          ConsistentRead: true,
          ...(start === undefined ? {} : { ExclusiveStartKey: start }),
        })
        found.push(...((page.Items ?? []) as Array<Row>))
        start = page.LastEvaluatedKey as Row | undefined
      } while (start !== undefined)
      return found
    }).pipe(Effect.provide(ClientLayer), Effect.orDie),
  commands: (tableName: string) => Effect.sync(() => sent.get(tableName)!.splice(0)),
}

suite(harness, dynamoAvailable ? describe : describe.skip)
