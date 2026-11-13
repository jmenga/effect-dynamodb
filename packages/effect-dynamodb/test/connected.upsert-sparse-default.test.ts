/**
 * `upsert` given `undefined` for a sparse map with a decoding default, over a row that's there,
 * against DynamoDB Local: every path stores the default's entries beside the stored ones (#236
 * section 6, resolved as intended behaviour; the cases and why are in
 * `helpers/UpsertSparseDefault.ts`).
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 */

import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb"
import { it } from "@effect/vitest"
import { Cause, Config, Effect, Exit, Layer } from "effect"
import { describe, expect } from "vitest"
import * as Lib from "../src/index.js"
import {
  cases,
  definitions,
  entriesOf,
  expected,
  nameOf,
  ROW_KEY,
  seed,
  storedEntries,
  upsert,
} from "./helpers/UpsertSparseDefault.js"

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
const ClientLayer = Lib.DynamoClient.layer({ region: "us-east-1", endpoint: ENDPOINT, credentials })

let tables = 0

describeConnected("upsert of data: undefined over a row that's there, on every path", () => {
  for (const each of cases) {
    it.effect(nameOf(each), () => {
      const { E, Main } = definitions(Lib, each)
      const tableName = `upsert-sparse-default-${Date.now()}-${tables++}`
      return Effect.acquireUseRelease(
        Effect.gen(function* () {
          const client = yield* Lib.DynamoClient
          yield* client.createTable({
            TableName: tableName,
            BillingMode: "PAY_PER_REQUEST",
            KeySchema: [
              { AttributeName: "pk", KeyType: "HASH" },
              { AttributeName: "sk", KeyType: "RANGE" },
            ],
            AttributeDefinitions: [
              { AttributeName: "pk", AttributeType: "S" },
              { AttributeName: "sk", AttributeType: "S" },
            ],
          })
        }),
        () =>
          Effect.gen(function* () {
            const db: any = yield* Lib.DynamoClient.make({
              entities: { E },
              tables: { Main },
            } as never)
            yield* seed(db)
            const exit = yield* Effect.exit(upsert(db, each))
            const row = yield* Effect.promise(() =>
              raw.send(
                new GetItemCommand({ TableName: tableName, Key: ROW_KEY, ConsistentRead: true }),
              ),
            )
            const read = yield* db.entities.E.get({ id: "a" })
            const want = expected(each)
            if (want.failure === undefined) {
              if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toBe("")
            } else {
              expect(Exit.isFailure(exit)).toBe(true)
              const failure = Exit.isFailure(exit) ? (Cause.squash(exit.cause) as any) : undefined
              expect({ error: failure?._tag, operation: failure?.operation }).toEqual(want.failure)
            }
            expect(entriesOf(row.Item)).toEqual(storedEntries(want.data))
            expect(read.data).toEqual(want.data)
          }),
        () =>
          Effect.gen(function* () {
            const client = yield* Lib.DynamoClient
            yield* client.deleteTable({ TableName: tableName })
          }).pipe(Effect.ignore),
      ).pipe(
        Effect.provide(
          Layer.merge(ClientLayer, Main.layer({ name: tableName }) as Layer.Layer<never>),
        ),
      ) as Effect.Effect<void>
    })
  }
})
