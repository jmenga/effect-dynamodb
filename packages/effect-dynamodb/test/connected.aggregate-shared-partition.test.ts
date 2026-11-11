/**
 * Partitions holding rows of one entity type that more than one owner writes, against DynamoDB
 * Local: what each step sends and stores, against what published 1.39.0 did on DynamoDB Local
 * (see `helpers/SharedPartition.ts`).
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
import { type Row, sharedPartitionSuite } from "./helpers/SharedPartition.js"

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

describeConnected("shared partitions (connected)", () => {
  sharedPartitionSuite({
    local: true,
    open: ({ gsi, seed }) =>
      Effect.gen(function* () {
        const TableName = `shared-partition-${Date.now()}-${tables++}`
        yield* send(() =>
          raw.send(
            new CreateTableCommand({
              TableName,
              BillingMode: "PAY_PER_REQUEST",
              AttributeDefinitions: [
                { AttributeName: "pk", AttributeType: "S" },
                { AttributeName: "sk", AttributeType: "S" },
                ...(gsi
                  ? [
                      { AttributeName: "gsi1pk", AttributeType: "S" as const },
                      { AttributeName: "gsi1sk", AttributeType: "S" as const },
                    ]
                  : []),
              ],
              KeySchema: [
                { AttributeName: "pk", KeyType: "HASH" },
                { AttributeName: "sk", KeyType: "RANGE" },
              ],
              ...(gsi && {
                GlobalSecondaryIndexes: [
                  {
                    IndexName: "gsi1",
                    KeySchema: [
                      { AttributeName: "gsi1pk", KeyType: "HASH" },
                      { AttributeName: "gsi1sk", KeyType: "RANGE" },
                    ],
                    Projection: { ProjectionType: "ALL" },
                  },
                ],
              }),
            }),
          ),
        )
        const put = (row: Row) =>
          Effect.asVoid(send(() => raw.send(new PutItemCommand({ TableName, Item: row }))))
        for (const row of seed ?? []) yield* put(row)
        return {
          name: TableName,
          layer: ClientLayer,
          rows: Effect.map(
            send(() => raw.send(new ScanCommand({ TableName, ConsistentRead: true }))),
            (out) => (out.Items ?? []) as ReadonlyArray<Row>,
          ),
          put,
          close: Effect.asVoid(send(() => raw.send(new DeleteTableCommand({ TableName })))),
        }
      }),
  })
})
