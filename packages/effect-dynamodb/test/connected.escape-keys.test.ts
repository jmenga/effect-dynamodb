/**
 * `escapeKeys` (#183) on DynamoDB Local. The scenarios are in `helpers/EscapeKeyScenarios.ts`.
 * The rekeys of stored release rows start from 1.37.0's (1.38.0 stored the same keys); the unit
 * file runs both releases'.
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
import { fromAttributeMap } from "../src/Marshaller.js"
import * as Table from "../src/Table.js"
import {
  cursorScenarios,
  everyKeyScenarios,
  findsEveryKeyScenarios,
  flipScenarios,
  type Harness,
  historyScenarios,
  releaseRowScenarios,
  sentinelScenarios,
  shapeScenarios,
} from "./helpers/EscapeKeyScenarios.js"

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
  on: (MainTable, body) => {
    const tableName = `escape-keys-${Date.now()}-${tables++}`
    const create = Effect.gen(function* () {
      const client = yield* DynamoClient
      const definition = Table.definition(MainTable)
      const isShapes = MainTable.schema.name === "shapes"
      yield* client.createTable({
        TableName: tableName,
        BillingMode: "PAY_PER_REQUEST",
        ...definition,
        // The aggregate's indexes: a table's definition holds only its registered members.
        ...(isShapes
          ? {}
          : {
              AttributeDefinitions: [
                ...definition.AttributeDefinitions,
                { AttributeName: "lsi1sk", AttributeType: "S" as const },
                { AttributeName: "gsi5pk", AttributeType: "S" as const },
                { AttributeName: "gsi5sk", AttributeType: "S" as const },
              ],
              LocalSecondaryIndexes: [
                {
                  IndexName: "lsi1",
                  KeySchema: [
                    { AttributeName: "pk", KeyType: "HASH" as const },
                    { AttributeName: "lsi1sk", KeyType: "RANGE" as const },
                  ],
                  Projection: { ProjectionType: "ALL" as const },
                },
              ],
              GlobalSecondaryIndexes: [
                ...(definition.GlobalSecondaryIndexes ?? []),
                {
                  IndexName: "gsi5",
                  KeySchema: [
                    { AttributeName: "gsi5pk", KeyType: "HASH" as const },
                    { AttributeName: "gsi5sk", KeyType: "RANGE" as const },
                  ],
                  Projection: { ProjectionType: "ALL" as const },
                },
              ],
            }),
      })
    })
    const drop = Effect.gen(function* () {
      const client = yield* DynamoClient
      yield* client.deleteTable({ TableName: tableName })
    }).pipe(Effect.ignore)
    return Effect.acquireUseRelease(
      create,
      () =>
        body(
          () =>
            scanAll(tableName).pipe(Effect.map((rows) => rows.map((row) => fromAttributeMap(row)))),
          (other, effect) => effect.pipe(Effect.provide(other.layer({ name: tableName }))) as never,
        ),
      () => drop,
    ).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(ClientLayer, MainTable.layer({ name: tableName }))),
    ) as never
  },
}

describeConnected("escapeKeys", () => {
  describe("every key against the published 1.36.0", () => {
    for (const scenario of everyKeyScenarios) {
      it.live(scenario.name, () => scenario.run(harness))
    }
  })
  describe("every key path finds what it wrote", () => {
    for (const scenario of findsEveryKeyScenarios) {
      it.live(scenario.name, () => scenario.run(harness))
    }
  })
  describe("rows the published 1.37.0 and 1.38.0 stored", () => {
    // 1.38.0 stored every key 1.37.0 did (the first scenario), so here the rekeys start from
    // 1.37.0's rows; `EscapeKeys.test.ts` runs both releases'.
    for (const scenario of releaseRowScenarios.filter((s) => !s.name.startsWith("1.38.0, "))) {
      it.live(scenario.name, () => scenario.run(harness))
    }
  })
  describe("turning it on or off over stored rows", () => {
    for (const scenario of flipScenarios) {
      it.live(scenario.name, () => scenario.run(harness))
    }
  })
  describe("a unique sentinel in transition", () => {
    for (const scenario of sentinelScenarios) {
      it.live(scenario.name, () => scenario.run(harness))
    }
  })
  describe("a time series' bounds", () => {
    for (const scenario of historyScenarios) {
      it.live(scenario.name, () => scenario.run(harness))
    }
  })
  describe("cursors", () => {
    for (const scenario of cursorScenarios) {
      it.live(scenario.name, () => scenario.run(harness))
    }
  })
  describe("the canonical GSI shapes", () => {
    for (const scenario of shapeScenarios) {
      it.live(scenario.name, () => scenario.run(harness))
    }
  })
})
