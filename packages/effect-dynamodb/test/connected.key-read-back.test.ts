/**
 * A key written must be the key composed again from the row as it reads back, against DynamoDB
 * Local: the connected twin of `KeyReadBack.test.ts`, over rows published 1.39.0 stored.
 * Scenarios: `helpers/KeyReadBack.ts`.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 */

import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  PutItemCommand,
  ScanCommand,
} from "@aws-sdk/client-dynamodb"
import { Config, Effect } from "effect"
import { describe } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import { keyReadBackSuite, type Row } from "./helpers/KeyReadBack.js"

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

describeConnected(
  "a key written is the key composed again from the row read back (connected)",
  () => {
    keyReadBackSuite((seed) =>
      Effect.gen(function* () {
        const TableName = `key-read-back-${Date.now()}-${tables++}`
        yield* send(() =>
          raw.send(
            new CreateTableCommand({
              TableName,
              BillingMode: "PAY_PER_REQUEST",
              AttributeDefinitions: [
                { AttributeName: "pk", AttributeType: "S" },
                { AttributeName: "sk", AttributeType: "S" },
              ],
              KeySchema: [
                { AttributeName: "pk", KeyType: "HASH" },
                { AttributeName: "sk", KeyType: "RANGE" },
              ],
            }),
          ),
        )
        for (const Item of seed)
          yield* send(() => raw.send(new PutItemCommand({ TableName, Item })))
        return {
          name: TableName,
          layer: ClientLayer,
          rows: Effect.map(
            send(() => raw.send(new ScanCommand({ TableName, ConsistentRead: true }))),
            (out) => (out.Items ?? []) as ReadonlyArray<Row>,
          ),
          close: Effect.asVoid(send(() => raw.send(new DeleteTableCommand({ TableName })))),
        }
      }),
    )
  },
)
