/**
 * `AggregateUnionMembers.test.ts` against DynamoDB Local: each shape in
 * `helpers/UnionMemberShapes.ts` sends, stores and returns what published 1.39.0 did there
 * (`fixtures/aggregate-union-members-1.39.0.json`, generated once from the published package:
 * don't regenerate or "fix" it). DynamoDB Local hands a row's attributes back in its own order, so
 * this also sees an element read back in that order instead of its member's.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 */
import { readFileSync } from "node:fs"
import { type AttributeValue, DynamoDBClient, ScanCommand } from "@aws-sdk/client-dynamodb"
import { it } from "@effect/vitest"
import { Config, Effect, Layer } from "effect"
import { describe, expect } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import {
  createLineUnclassed,
  elementShapes,
  fieldShapes,
  judged,
  judgedUnclassed,
  type Recorded,
  runShape,
  sortedRows,
} from "./helpers/UnionMemberShapes.js"

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

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/aggregate-union-members-1.39.0.json", import.meta.url), "utf8"),
) as {
  readonly elements: Record<string, Recorded>
  readonly fields: Record<string, Recorded>
}

let tables = 0

/** A fresh table, and a client that keeps each request's operation and input. */
const onDynamoDbLocal = Effect.gen(function* () {
  const tableName = `union-members-${Date.now()}-${tables++}`
  const sent: Array<{ op: string; input: unknown }> = []
  const recording = Layer.effect(
    DynamoClient,
    Effect.gen(function* () {
      const inner = yield* DynamoClient
      return new Proxy(inner, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver)
          if (typeof value !== "function") return value
          return (...args: Array<unknown>) => {
            sent.push({ op: String(prop), input: args[0] ?? null })
            return value.apply(target, args)
          }
        },
      })
    }),
  ).pipe(Layer.provide(ClientLayer))
  const client = yield* DynamoClient.pipe(Effect.provide(ClientLayer))
  yield* client.createTable({
    TableName: tableName,
    BillingMode: "PAY_PER_REQUEST",
    AttributeDefinitions: [
      { AttributeName: "pk", AttributeType: "S" },
      { AttributeName: "sk", AttributeType: "S" },
    ],
    KeySchema: [
      { AttributeName: "pk", KeyType: "HASH" },
      { AttributeName: "sk", KeyType: "RANGE" },
    ],
  })
  return {
    place: {
      layer: recording,
      tableName,
      take: () =>
        JSON.parse(JSON.stringify(sent.splice(0, sent.length)).replaceAll(tableName, "<table>")),
      rows: () =>
        Effect.promise(() =>
          raw.send(new ScanCommand({ TableName: tableName, ConsistentRead: true })),
        ).pipe(
          Effect.map(
            (scanned) =>
              sortedRows(
                (scanned.Items ?? []) as Array<Record<string, AttributeValue>>,
              ) as ReadonlyArray<unknown>,
          ),
        ),
    },
    drop: client.deleteTable({ TableName: tableName }),
  }
})

describeConnected(
  "an aggregate's union elements and fields, as 1.39.0 had them, on DynamoDB Local",
  () => {
    for (const [group, shapes] of [
      ["elements", elementShapes()],
      ["fields", fieldShapes()],
    ] as const) {
      for (const [label, define] of Object.entries(shapes)) {
        it.effect(`${label}: sends, stores and returns what 1.39.0 did`, () =>
          Effect.gen(function* () {
            const { place, drop } = yield* onDynamoDbLocal
            const actual = yield* runShape(define, place).pipe(Effect.ensuring(Effect.ignore(drop)))
            const expected = fixture[group][label]!
            for (const step of ["create", "get", "update", "getAfterUpdate"] as const) {
              const judge =
                step === "create" && createLineUnclassed(label) ? judgedUnclassed : judged
              expect({ step, ...judge(actual[step]) }).toEqual({ step, ...judge(expected[step]) })
            }
            expect(actual.requests).toEqual(expected.requests)
            expect(actual.rows).toEqual(expected.rows)
            expect(actual.updateRequests).toEqual(expected.updateRequests)
            expect(actual.updateRows).toEqual(expected.updateRows)
          }),
        )
      }
    }
  },
)
