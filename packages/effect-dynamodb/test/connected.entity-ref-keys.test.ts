/**
 * Entity-level refs name the referenced entity's key composite, and a cascade stores what a put
 * stores, against DynamoDB Local. The suites are `helpers/EntityRefKeys.ts` and
 * `helpers/EntityRefCascade.ts`; recording-table twin: `EntityRefKeys.test.ts`.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { Config, Effect, Layer } from "effect"
import { describe } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import { suite as cascadeSuite } from "./helpers/EntityRefCascade.js"
import { type Harness, INDEXES, suite } from "./helpers/EntityRefKeys.js"

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
const sent = new Map<string, Array<{ command: string; input: unknown }>>()
const recording = new Map<string, Layer.Layer<DynamoClient>>()
let made = 0

const harness: Harness = {
  onTable: (body) => {
    const tableName = `entity-ref-keys-${Date.now()}-${made++}`
    const requests: Array<{ command: string; input: unknown }> = []
    sent.set(tableName, requests)
    return Effect.gen(function* () {
      const raw = yield* DynamoClient
      // Every request the library sends, under its command's name.
      const client = new Proxy(raw, {
        get: (target, property, receiver) => {
          const value = Reflect.get(target, property, receiver)
          return typeof value === "function" && typeof property === "string"
            ? (input: unknown, ...rest: ReadonlyArray<unknown>) => {
                requests.push({
                  command: property[0]!.toUpperCase() + property.slice(1),
                  input: structuredClone(input),
                })
                return value.apply(target, [input, ...rest])
              }
            : value
        },
      })
      recording.set(tableName, Layer.succeed(DynamoClient, client))
      const indexes = Object.entries(INDEXES)
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
            ...indexes.flatMap(([, keys]) => [
              { AttributeName: keys.pk, AttributeType: "S" as const },
              { AttributeName: keys.sk, AttributeType: "S" as const },
            ]),
          ],
          GlobalSecondaryIndexes: indexes.map(([IndexName, keys]) => ({
            IndexName,
            KeySchema: [
              { AttributeName: keys.pk, KeyType: "HASH" as const },
              { AttributeName: keys.sk, KeyType: "RANGE" as const },
            ],
            Projection: { ProjectionType: "ALL" as const },
          })),
        }),
        () => body(tableName),
        () => raw.deleteTable({ TableName: tableName }).pipe(Effect.ignore),
      )
    }).pipe(Effect.provide(ClientLayer)) as Effect.Effect<any, unknown>
  },
  provide: (tableName, main, effect) =>
    effect.pipe(
      Effect.provide(Layer.merge(recording.get(tableName)!, main.layer({ name: tableName }))),
    ) as Effect.Effect<any, any>,
  rows: (tableName) =>
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
  requests: (tableName) =>
    Effect.sync(() =>
      sent
        .get(tableName)!
        .splice(0)
        .map(({ command, input }) => ({
          command,
          input: JSON.parse(JSON.stringify(input).replaceAll(tableName, "<table>")),
        })),
    ),
}

suite(harness, dynamoAvailable ? describe : describe.skip)
cascadeSuite(harness, dynamoAvailable ? describe : describe.skip)
