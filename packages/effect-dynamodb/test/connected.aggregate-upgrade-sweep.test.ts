/**
 * The upgrade sweep (#241) against DynamoDB Local: aggregates 1.40.0 wrote, continued by this
 * release. The suite is `helpers/AggregateUpgradeSweepSuite.ts`; recording-table twin:
 * `AggregateUpgradeSweep.test.ts`.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb"
import { Config, Effect } from "effect"
import { afterAll, describe } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import { INDEX, type Request, type Row } from "./helpers/AggregateUpgradeSweep.js"
import { sweepSuite } from "./helpers/AggregateUpgradeSweepSuite.js"
import { makeTablePool, type TableShape } from "./helpers/TablePool.js"

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

// Each case on an empty table of its key attribute, one at a time: reused, emptied between cases.
const pool = makeTablePool(
  new DynamoDBClient({
    region: "us-east-1",
    endpoint: ENDPOINT,
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  }),
  "aggregate-upgrade-sweep",
)
afterAll(() => pool.drain())

const shapeOf = (pk: string): TableShape => ({
  KeySchema: [
    { AttributeName: pk, KeyType: "HASH" },
    { AttributeName: "sk", KeyType: "RANGE" },
  ],
  AttributeDefinitions: [
    { AttributeName: pk, AttributeType: "S" },
    { AttributeName: "sk", AttributeType: "S" },
    { AttributeName: INDEX.sk, AttributeType: "S" },
  ],
  LocalSecondaryIndexes: [
    {
      IndexName: INDEX.name,
      KeySchema: [
        { AttributeName: pk, KeyType: "HASH" },
        { AttributeName: INDEX.sk, KeyType: "RANGE" },
      ],
      Projection: { ProjectionType: "ALL" },
    },
  ],
})

sweepSuite(
  {
    onTable: (pk, body) =>
      Effect.gen(function* () {
        const raw = yield* DynamoClient
        const shape = shapeOf(pk)
        const tableName = yield* pool.take(shape)
        const sent: Array<Request> = []
        // Every request the library sends, under its command's name.
        const recording = new Proxy(raw, {
          get: (target, property, receiver) => {
            const value = Reflect.get(target, property, receiver)
            return typeof value === "function" && typeof property === "string"
              ? (input: unknown, ...rest: ReadonlyArray<unknown>) => {
                  sent.push({
                    command: property[0]!.toUpperCase() + property.slice(1),
                    input: structuredClone(input),
                  })
                  return value.apply(target, [input, ...rest])
                }
              : value
          },
        })
        const take = () =>
          sent.splice(0).map(({ command, input }) => ({
            command,
            input: JSON.parse(JSON.stringify(input).replaceAll(tableName, "<table>")),
          }))
        const keyOf = (row: Row) => `${row[pk]?.S} ${row.sk?.S}`
        const scan = () =>
          Effect.gen(function* () {
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
            return found.sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0))
          }).pipe(Effect.orDie)
        const seed = (rows: ReadonlyArray<Row>) =>
          Effect.gen(function* () {
            for (const row of rows) yield* raw.putItem({ TableName: tableName, Item: row })
          })
        return yield* body({ tableName, client: recording, take, scan }, seed).pipe(
          Effect.ensuring(pool.give(tableName, shape)),
        )
      }).pipe(Effect.provide(ClientLayer)) as Effect.Effect<any, unknown>,
  },
  dynamoAvailable ? describe : describe.skip,
)
