/**
 * Behaviour published 1.39.0 had, kept, against DynamoDB Local: the connected twin of
 * `Kept139.test.ts`. Each scenario replays its steps and compares them with what 1.39.0 did
 * (`fixtures/*-1.39.0.json`, captured once, never regenerated).
 * Scenarios: `helpers/OptionalShardAppend.ts`, `helpers/StoredNaNKeys.ts`,
 * `helpers/AggregateCreateStamps.ts`, `helpers/AggregateStampForms.ts`,
 * `helpers/OptionalTransformDates.ts`, `helpers/WideShardAppend.ts`.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 */

import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  ScanCommand,
} from "@aws-sdk/client-dynamodb"
import { Config, Effect } from "effect"
import { describe } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Table from "../src/Table.js"
import { aggregateCreateStampsSuite } from "./helpers/AggregateCreateStamps.js"
import { aggregateStampFormsSuite } from "./helpers/AggregateStampForms.js"
import type { OpenTable, Row } from "./helpers/Kept139.js"
import { optionalShardAppendSuite } from "./helpers/OptionalShardAppend.js"
import { optionalTransformDatesSuite } from "./helpers/OptionalTransformDates.js"
import { storedNaNKeySuite } from "./helpers/StoredNaNKeys.js"
import { wideShardAppendSuite } from "./helpers/WideShardAppend.js"

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

const credentials = { accessKeyId: "local", secretAccessKey: "local" }
const raw = new DynamoDBClient({ region: "us-east-1", endpoint: ENDPOINT, credentials })
const ClientLayer = DynamoClient.layer({ region: "us-east-1", endpoint: ENDPOINT, credentials })

const send = <A>(make: () => Promise<A>) =>
  Effect.tryPromise(make).pipe(Effect.orDie) as Effect.Effect<A>

let tables = 0
const openTable: OpenTable = (MainTable) =>
  Effect.gen(function* () {
    const TableName = `kept-139-${Date.now()}-${tables++}`
    yield* send(() =>
      raw.send(
        new CreateTableCommand({
          TableName,
          BillingMode: "PAY_PER_REQUEST",
          ...Table.definition(MainTable),
        }),
      ),
    )
    return {
      name: TableName,
      layer: ClientLayer,
      rows: Effect.map(
        send(() => raw.send(new ScanCommand({ TableName, ConsistentRead: true }))),
        (out) => (out.Items ?? []) as ReadonlyArray<Row>,
      ),
      close: Effect.asVoid(send(() => raw.send(new DeleteTableCommand({ TableName })))),
    }
  })

describeConnected("an appendInput that may leave a sharded index's composite out", () => {
  optionalShardAppendSuite(openTable)
})

describeConnected("a key over a number stored as a string, holding NaN", () => {
  storedNaNKeySuite(openTable)
})

describeConnected("an aggregate create over a field the rows declare a stamp in", () => {
  aggregateCreateStampsSuite(openTable)
})

describeConnected("the form an aggregate stores its stamps in", () => {
  aggregateStampFormsSuite(openTable)
})

describeConnected(
  "an entity's Schema.optional date over a transform stored as the other kind",
  () => {
    optionalTransformDatesSuite(openTable)
  },
)

describeConnected("an appendInput that may leave out many of a sharded index's composites", () => {
  wideShardAppendSuite(openTable)
})
