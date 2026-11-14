/**
 * The {@link Harness} the suites written for it run on against DynamoDB Local: each case on a table of
 * its own (with {@link INDEXES}), deleted after it, every request the library sends recorded under
 * its command's name, and the table's rows read by a consistent scan. Recording-table twin: the
 * harness in `EntityRefKeys.test.ts`.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { Config, Effect, Layer } from "effect"
import { DynamoClient } from "../../src/DynamoClient.js"
import { type Harness, INDEXES } from "./EntityRefKeys.js"

const ENDPOINT = Effect.runSync(
  Config.String("DYNAMODB_ENDPOINT").pipe(Config.withDefault("http://localhost:8000")),
)

/** Whether DynamoDB Local answers at the endpoint. */
export const dynamoAvailable = async (): Promise<boolean> => {
  try {
    const res = await fetch(ENDPOINT, { method: "POST", signal: AbortSignal.timeout(1000) }).catch(
      () => null,
    )
    return res !== null
  } catch {
    return false
  }
}

const ClientLayer = DynamoClient.layer({
  region: "us-east-1",
  endpoint: ENDPOINT,
  credentials: { accessKeyId: "local", secretAccessKey: "local" },
})

type Row = Record<string, AttributeValue>

/** A harness whose tables are named after `prefix`. */
export const connectedHarness = (prefix: string): Harness => {
  const sent = new Map<string, Array<{ command: string; input: unknown }>>()
  const recording = new Map<string, Layer.Layer<DynamoClient>>()
  let made = 0
  return {
    onTable: (body) => {
      const tableName = `${prefix}-${Date.now()}-${made++}`
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
}
