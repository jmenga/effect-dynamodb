/**
 * After `rekey`, `foo bar` and `foo%20bar` are two values (#183), on DynamoDB Local. The scenarios
 * are in `helpers/AliasKeys.ts`; `AliasKeys.test.ts` runs every variant of them on a recording table.
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
  aggregateValueScenarios,
  CELLS,
  entityOperationScenarios,
  entityValueScenarios,
  type Harness,
  streamValueScenarios,
  VARIANTS,
} from "./helpers/AliasKeys.js"

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
    const tableName = `alias-${Date.now()}-${tables++}`
    const create = Effect.gen(function* () {
      const client = yield* DynamoClient
      yield* client.createTable({
        TableName: tableName,
        BillingMode: "PAY_PER_REQUEST",
        ...Table.definition(world.MainTable),
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

describeConnected("after rekey, each value is its own", () => {
  for (const [group, scenarios] of [
    ["an entity's values", entityValueScenarios],
    // The rows that move, on the variant that has both key halves.
    ["an entity's operations", entityOperationScenarios([VARIANTS[0]], CELLS.slice(0, 4))],
    ["an aggregate", aggregateValueScenarios],
    ["a stream", streamValueScenarios],
  ] as const) {
    describe(group, () => {
      for (const scenario of scenarios) {
        it.live(scenario.name, () => scenario.run(harness))
      }
    })
  }
})
