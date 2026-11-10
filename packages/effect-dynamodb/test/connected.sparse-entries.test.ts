/**
 * Writes of a sparse map's entry that 1.39.0 stored and read back, against DynamoDB Local: every
 * case of `helpers/SparseEntryWrites.ts` (an entry under an attribute name over 255 bytes, an entry
 * named by its attribute under a key holding `#`, a field named as an entry and stored elsewhere)
 * is written and read back as `fixtures/sparse-entry-writes-1.39.0.json` records 1.39.0 read it.
 * `test/SparseEntries.test.ts` compares the requests.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 */

import { readFileSync } from "node:fs"
import { it } from "@effect/vitest"
import { Cause, Config, Effect, Exit, Layer } from "effect"
import { describe, expect } from "vitest"
import * as Lib from "../src/index.js"
import { cases, definitions, plain, type World } from "./helpers/SparseEntryWrites.js"

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
const ClientLayer = Lib.DynamoClient.layer({ region: "us-east-1", endpoint: ENDPOINT, credentials })

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/sparse-entry-writes-1.39.0.json", import.meta.url), "utf8"),
) as { readonly cases: Record<string, { readonly read: Record<string, unknown> }> }

let tables = 0
/** Runs `body` with a client bound to `world`'s entity on a table of its own. */
const onTable = <A>(world: World, body: (db: any) => Effect.Effect<A, unknown, any>) => {
  const { Docs, MainTable } = definitions(Lib as never, world)
  const tableName = `sparse-entries-${Date.now()}-${tables++}`
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
          entities: { Docs },
          tables: { MainTable },
        } as never)
        return yield* body(db)
      }),
    () =>
      Effect.gen(function* () {
        const client = yield* Lib.DynamoClient
        yield* client.deleteTable({ TableName: tableName })
      }).pipe(Effect.ignore),
  ).pipe(
    Effect.provide(
      Layer.merge(ClientLayer, MainTable.layer({ name: tableName }) as Layer.Layer<never>),
    ),
  ) as Effect.Effect<A, unknown>
}

describeConnected("a write of a sparse map's entry that 1.39.0 stored, on DynamoDB Local", () => {
  for (const each of cases) {
    it.effect(`${each.key}: written, and read back as 1.39.0 read it`, () =>
      onTable(each.world, (db) =>
        Effect.gen(function* () {
          yield* db.entities.Docs.put({
            id: "a",
            data: { ok: 1 },
            ...(each.world === "renamed" ? { "data#x#y": 1 } : {}),
          }).asEffect()
          const exit = yield* Effect.exit(Effect.suspend(() => each.write(db, Lib as never)))
          expect(Exit.isFailure(exit) ? String(Cause.squash(exit.cause)) : "written").toBe(
            "written",
          )
          const read = yield* db.entities.Docs.get({ id: "a" })
          expect(plain(read)).toEqual(fixture.cases[each.key]!.read)
        }),
      ),
    )
  }
})
