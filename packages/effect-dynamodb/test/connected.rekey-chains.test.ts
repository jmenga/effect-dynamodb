/**
 * A dry run follows the chain (D88) on real DynamoDB: sentinels, streams and aggregates, in both
 * directions. A table on DynamoDB scans in hash order, not key order, so which of the two rows the
 * scan meets first depends on the value: each scenario runs over several values, and the last test
 * in each block asserts both orders were met, so a run that only ever met one order fails.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 */

import { it } from "@effect/vitest"
import { Config, Effect, Layer } from "effect"
import { describe, expect } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Table from "../src/Table.js"
import * as RekeyChains from "./helpers/RekeyChains.js"

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

const harness: RekeyChains.Harness = {
  on: (world, body) => {
    const tableName = `chains-${Date.now()}-${tables++}`
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
    const table: RekeyChains.StoredRows = {
      seed: (row) =>
        Effect.gen(function* () {
          const client = yield* DynamoClient
          yield* client.putItem({ TableName: tableName, Item: row })
        }),
      remove: (row) =>
        Effect.gen(function* () {
          const client = yield* DynamoClient
          yield* client.deleteItem({ TableName: tableName, Key: { pk: row.pk, sk: row.sk } })
        }),
      rows: () =>
        Effect.gen(function* () {
          const client = yield* DynamoClient
          const rows: Array<Record<string, any>> = []
          let start: Record<string, any> | undefined
          do {
            const page = yield* client.scan({
              TableName: tableName,
              ...(start === undefined ? {} : { ExclusiveStartKey: start }),
            })
            rows.push(...(page.Items ?? []))
            start = page.LastEvaluatedKey
          } while (start !== undefined)
          return rows
        }),
      as: (other, effect) =>
        effect.pipe(Effect.provide(other.MainTable.layer({ name: tableName }))) as never,
    }
    return Effect.acquireUseRelease(
      create,
      () => body(table),
      () => drop,
    ).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(ClientLayer, world.MainTable.layer({ name: tableName }))),
    ) as never
  },
}

const STEMS = ["foo", "alpha", "beta", "gamma", "delta", "kappa"]

describeConnected("#185 a dry run follows the chain, on DynamoDB", () => {
  for (const scenario of RekeyChains.chainScenarios) {
    describe(scenario.name, () => {
      const met = new Set<RekeyChains.Met>()
      for (const stem of STEMS) {
        const values = RekeyChains.chainOf(scenario.escapeKeys, stem)
        it.live(`${values.moving}, ${values.holder}`, () =>
          scenario.run(harness, values, 1).pipe(
            Effect.tap((order) =>
              Effect.sync(() => {
                met.add(order)
              }),
            ),
          ),
        )
        it.live(`${values.moving}, ${values.holder}, in three segments`, () =>
          Effect.asVoid(scenario.run(harness, values, 3)),
        )
      }
      it("the scan met them in both orders", () => {
        expect([...met].sort()).toEqual(["holder first", "moving first"])
      })
    })
  }
})
