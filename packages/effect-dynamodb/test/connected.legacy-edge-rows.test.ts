/**
 * Rows an upgrade from 1.36 meets at the edges of the key fallback and `rekey` (#171) —
 * connected tests against DynamoDB Local: the scenarios of `helpers/LegacyEdgeRows.ts`
 * on real writes, a real index and real byte order.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 */

import { describe, it } from "@effect/vitest"
import { Config, Effect, Layer } from "effect"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Table from "../src/Table.js"
import { clientOf, type Harness, On, type StoredRow, scenarios } from "./helpers/LegacyEdgeRows.js"

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

/** Run a scenario over a fresh table, deleted afterwards. */
const onTable = <A, E>(scenario: (h: Harness) => Effect.Effect<A, E, any>) => {
  const tableName = `legacy-edge-${Date.now()}-${tables++}`
  const h: Harness = {
    seed: (row) =>
      Effect.gen(function* () {
        const client = yield* DynamoClient
        yield* client.putItem({ TableName: tableName, Item: row })
      }).pipe(Effect.provide(ClientLayer)),
    rows: () =>
      Effect.gen(function* () {
        const client = yield* DynamoClient
        const page = yield* client.scan({ TableName: tableName, ConsistentRead: true })
        return (page.Items ?? []) as ReadonlyArray<StoredRow>
      }).pipe(Effect.provide(ClientLayer)),
    inWorld: (world, body) =>
      Effect.gen(function* () {
        const db = yield* clientOf(world)
        return yield* body(db)
      }).pipe(
        Effect.provide(Layer.merge(ClientLayer, world.MainTable.layer({ name: tableName }))),
      ) as never,
  }
  const create = Effect.gen(function* () {
    const client = yield* DynamoClient
    yield* client.createTable({
      TableName: tableName,
      BillingMode: "PAY_PER_REQUEST",
      ...Table.definition(On.MainTable),
    })
  })
  const drop = Effect.gen(function* () {
    const client = yield* DynamoClient
    yield* client.deleteTable({ TableName: tableName })
  }).pipe(Effect.ignore)
  return Effect.acquireUseRelease(
    create,
    () => scenario(h),
    () => drop,
  ).pipe(Effect.provide(ClientLayer)) as Effect.Effect<A, E>
}

describeConnected("#171 legacy edge rows — connected", () => {
  for (const scenario of scenarios) {
    it.live(scenario.name, () => onTable(scenario.run))
  }
})
