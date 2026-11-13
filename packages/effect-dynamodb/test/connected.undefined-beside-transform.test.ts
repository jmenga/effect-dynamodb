/**
 * A write given `undefined` for a defaulted sparse map beside a transformed field, its other
 * values in the domain form (`{ id, n: 1, data: undefined }` beside `n: Schema.NumberFromString`),
 * against DynamoDB Local: every write takes it as it takes the same input beside
 * `n: Schema.Number` (#236). The cases and what 1.40.0 did are in
 * `helpers/UndefinedBesideTransform.ts`.
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
  expected,
  nameOf,
  seed,
  send,
} from "./helpers/UndefinedBesideTransform.js"

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

describeConnected(
  "a defaulted field given undefined beside a transformed field, on every write",
  () => {
    for (const each of cases) {
      it.effect(nameOf(each), () => {
        const { E, Main } = definitions(Lib, each)
        const tableName = `undefined-beside-transform-${Date.now()}-${tables++}`
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
              if (each.overRow) yield* seed(db)
              const exit = yield* Effect.exit(send(Lib, db, each))
              if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toBe("")
              const read = yield* db.entities.E.get({ id: "a" })
              expect(read.n).toBe(1)
              expect(read.data).toEqual(expected(each).data)
              // `n` is stored as its transform encodes it, whatever form it was given in.
              const stored = yield* Effect.promise(() =>
                raw.send(
                  new GetItemCommand({
                    TableName: tableName,
                    Key: { pk: { S: "$undefs#v1#e#id_a" }, sk: { S: "$undefs#v1#e" } },
                    ConsistentRead: true,
                  }),
                ),
              )
              expect(stored.Item?.n).toEqual(
                each.neighbour === "n: Schema.NumberFromString" ? { S: "1" } : { N: "1" },
              )
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
  },
)
