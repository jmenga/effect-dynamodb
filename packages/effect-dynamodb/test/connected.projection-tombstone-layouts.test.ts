/**
 * Several projections with `removal` on one read model (#154), against DynamoDB Local: `create` over
 * a tombstone carries the fields of the projection that wrote it, single-item and in a transaction.
 * A read model with one projection sends and stores exactly what the published 1.39.0 did.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 */

import { it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Config, Effect, Layer } from "effect"
import { afterAll, beforeAll, describe } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
import { fromAttributeMap } from "../src/Marshaller.js"
import * as Table from "../src/Table.js"
import * as Transaction from "../src/Transaction.js"
import { EventsTable, ReadTable, scenarios } from "./helpers/ProjectionTombstoneLayouts.js"
import { expectAsFixture, scenario } from "./helpers/ProjectionTombstoneRequests.js"

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
const stamp = Date.now()
const tables = {
  layouts: { events: `pt-layouts-events-${stamp}`, read: `pt-layouts-read-${stamp}` },
  single: { events: `pt-single-events-${stamp}`, read: `pt-single-read-${stamp}` },
}
const names = [...Object.values(tables.layouts), ...Object.values(tables.single)]

const withClient = <A, E>(f: (client: DynamoClient["Service"]) => Effect.Effect<A, E>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* f(yield* DynamoClient)
    }).pipe(Effect.provide(ClientLayer)),
  )

const TestLayer = Layer.mergeAll(
  ClientLayer,
  EventsTable.layer({ name: tables.layouts.events }),
  ReadTable.layer({ name: tables.layouts.read }),
)

const rowOf = (id: string) =>
  Effect.gen(function* () {
    const client = yield* DynamoClient
    const { Items } = yield* client.scan({ TableName: tables.layouts.read, ConsistentRead: true })
    const item = (Items ?? []).find((row) => row.pk?.S?.endsWith(`#id_${id}`))
    return item === undefined ? undefined : (fromAttributeMap(item) as Record<string, unknown>)
  })

describeConnected("projection tombstones on DynamoDB Local", () => {
  beforeAll(() =>
    withClient((client) =>
      Effect.forEach(names, (TableName) =>
        client.createTable({
          TableName,
          BillingMode: "PAY_PER_REQUEST",
          KeySchema: [
            { AttributeName: "pk", KeyType: "HASH" },
            { AttributeName: "sk", KeyType: "RANGE" },
          ],
          AttributeDefinitions: [
            { AttributeName: "pk", AttributeType: "S" },
            { AttributeName: "sk", AttributeType: "S" },
          ],
        }),
      ),
    ),
  )
  afterAll(() =>
    withClient((client) =>
      Effect.forEach(names, (TableName) => Effect.ignore(client.deleteTable({ TableName }))),
    ),
  )

  describe("create over a tombstone, with several projections on the read model", () => {
    const { firstAndLast, multiSource, transactional, ambiguous } = scenarios(rowOf)

    it.effect("carries the fields of the projection that wrote the tombstone", () =>
      firstAndLast.pipe(Effect.provide(TestLayer)),
    )

    it.effect("a multi-source projection's tombstone keeps its checkpoint map", () =>
      multiSource.pipe(Effect.provide(TestLayer)),
    )

    it.effect("a transactional create carries them too", () =>
      transactional.pipe(Effect.provide(TestLayer)),
    )

    it.effect("a tombstone two layouts name alike is read by the one defined last", () =>
      ambiguous.pipe(Effect.provide(TestLayer)),
    )
  })

  it.effect("a read model with one projection sends and stores what 1.39.0 did", () => {
    const { run } = scenario(
      { DynamoSchema, Table, Entity, EventStore, Transaction, DynamoClient },
      tables.single,
    )
    return Effect.gen(function* () {
      const sent = yield* run(ClientLayer)
      const client = yield* DynamoClient
      const { Items } = yield* client.scan({ TableName: tables.single.read, ConsistentRead: true })
      expectAsFixture(sent, Items ?? [])
    }).pipe(Effect.provide(ClientLayer))
  })
})
