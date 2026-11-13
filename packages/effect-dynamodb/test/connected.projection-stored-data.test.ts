/**
 * Whether a projection's write over a live row another projection has written keeps the row's
 * data (#237), on DynamoDB Local: every case of `EventStore.projection-stored-data.test.ts`
 * (`helpers/StoredDataCases.ts`), standalone and in the outbox's transaction, under both
 * `escapeKeys` settings. The row's attributes as read against the attribute map the write's request
 * carries: a value DynamoDB stores nothing for, or an attribute another program names otherwise (a
 * rename either way, a field one program doesn't define or keeps inside a packed field, a sparse map
 * under another prefix), drops the other projection's bookkeeping with it, as on 1.40.0; one stored
 * under the same name, packed or not, keeps it.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { it } from "@effect/vitest"
import { Config, Effect } from "effect"
import { describe } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import { cases, runCase } from "./helpers/StoredDataCases.js"

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

let made = 0
/** Fresh event and read-model tables (`pk` / `sk`), dropped after `use`. */
const withTables = <A>(
  use: (names: {
    readonly events: string
    readonly read: string
  }) => Effect.Effect<A, unknown, DynamoClient>,
) =>
  Effect.gen(function* () {
    const ddb = yield* DynamoClient
    const stamp = `${Date.now()}-${made++}`
    const names = { events: `sd-e-${stamp}`, read: `sd-r-${stamp}` }
    for (const name of Object.values(names)) {
      yield* ddb.createTable({
        TableName: name,
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
    }
    return yield* use(names).pipe(
      Effect.ensuring(
        Effect.forEach(
          Object.values(names),
          (name) => ddb.deleteTable({ TableName: name }).pipe(Effect.ignore),
          { discard: true },
        ),
      ),
    )
  })

describeConnected(
  "a write over a live row another projection has written, on DynamoDB Local (#237)",
  () => {
    for (const c of cases) {
      for (const outbox of [false, true]) {
        for (const escapeKeys of [false, true]) {
          it.live(
            `${c.name} (${c.outcome})${outbox ? ", in the outbox's transaction" : ""}, escapeKeys ${escapeKeys ? "on" : "off"}`,
            () =>
              withTables((names) =>
                Effect.gen(function* () {
                  const ddb = yield* DynamoClient
                  const row = Effect.map(
                    ddb.scan({ TableName: names.read, ConsistentRead: true }),
                    (page) =>
                      (page.Items ?? []).find((item) => item.__edd_e__?.S === "Row") as Record<
                        string,
                        AttributeValue
                      >,
                  )
                  yield* runCase(c, outbox, escapeKeys, ClientLayer, names, row)
                }),
              ).pipe(Effect.provide(ClientLayer)),
          )
        }
      }
    }
  },
)
