/**
 * Rows 1.37.0 and 1.38.0 wrote (#183), on DynamoDB Local. The scenarios are in `helpers/Rows137.ts`.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { it } from "@effect/vitest"
import { Config, Effect, Layer } from "effect"
import { describe } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Table from "../src/Table.js"
import {
  aggregateAliasScenarios,
  aggregateScenarios,
  bothKeysScenarios,
  chainScenarios,
  type Harness,
  historyScenarios,
  indexKeyScenarios,
  invertedRowScenarios,
  itemScenarios,
  number136Scenarios,
  sentinelScenarios,
  streamScenarios,
} from "./helpers/Rows137.js"

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

const scanAll = (tableName: string) =>
  Effect.gen(function* () {
    const client = yield* DynamoClient
    const rows: Array<Record<string, AttributeValue>> = []
    let start: Record<string, AttributeValue> | undefined
    do {
      const page = yield* client.scan({
        TableName: tableName,
        ...(start === undefined ? {} : { ExclusiveStartKey: start }),
      })
      rows.push(...((page.Items ?? []) as Array<Record<string, AttributeValue>>))
      start = page.LastEvaluatedKey as Record<string, AttributeValue> | undefined
    } while (start !== undefined)
    return rows
  })

const harness: Harness = {
  on: (world, body) => {
    const tableName = `rows137-${Date.now()}-${tables++}`
    const create = Effect.gen(function* () {
      const client = yield* DynamoClient
      const definition = Table.definition(world.MainTable)
      yield* client.createTable({
        TableName: tableName,
        BillingMode: "PAY_PER_REQUEST",
        ...definition,
        // The aggregate's collection index: a table's definition holds only its registered members.
        AttributeDefinitions: [
          ...definition.AttributeDefinitions,
          { AttributeName: "lsi1sk", AttributeType: "S" },
        ],
        LocalSecondaryIndexes: [
          {
            IndexName: "lsi1",
            KeySchema: [
              { AttributeName: "pk", KeyType: "HASH" },
              { AttributeName: "lsi1sk", KeyType: "RANGE" },
            ],
            Projection: { ProjectionType: "ALL" },
          },
        ],
      })
    })
    const drop = Effect.gen(function* () {
      const client = yield* DynamoClient
      yield* client.deleteTable({ TableName: tableName })
    }).pipe(Effect.ignore)
    return Effect.acquireUseRelease(
      create,
      () =>
        Effect.gen(function* () {
          const db = yield* world.client()
          return yield* body(db, {
            seed: (row) =>
              Effect.gen(function* () {
                const client = yield* DynamoClient
                yield* client.putItem({ TableName: tableName, Item: row })
              }),
            remove: (row) =>
              Effect.gen(function* () {
                const client = yield* DynamoClient
                yield* client.deleteItem({
                  TableName: tableName,
                  Key: { pk: row.pk, sk: row.sk },
                })
              }),
            rows: () => scanAll(tableName),
            as: (other, inner) =>
              Effect.gen(function* () {
                const current = yield* other.client()
                return yield* inner(current)
              }).pipe(Effect.provide(other.MainTable.layer({ name: tableName }))),
          })
        }),
      () => drop,
    ).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(ClientLayer, world.MainTable.layer({ name: tableName }))),
    ) as never
  },
}

describeConnected("rows 1.37.0 wrote", () => {
  for (const [group, scenarios] of [
    ["an item", itemScenarios],
    ["an index key", indexKeyScenarios],
    ["history", historyScenarios],
    ["a unique sentinel", sentinelScenarios],
    ["a stream", streamScenarios],
    ["an aggregate", aggregateScenarios],
    ["an aggregate at its keys", aggregateAliasScenarios],
    ["a number", number136Scenarios],
    ["a chain", chainScenarios],
    ["both keys", bothKeysScenarios],
    ["an inverted row", invertedRowScenarios],
  ] as const) {
    describe(group, () => {
      for (const scenario of scenarios) {
        it.live(scenario.name, () => scenario.run(harness))
      }
    })
  }
})
