/**
 * A read model on whose rows `__edd_rt__` is already taken (#237), on DynamoDB Local, against what
 * the published 1.40.0 did on DynamoDB Local (`helpers/RowTokenScenarios.ts`,
 * `fixtures/row-token-names-1.40.0.json`, never regenerated from this repo): its rows carry no row
 * token (`rowTokenInUse`, decided from the definitions), and with one projection and two,
 * standalone and with an outbox, `escapeKeys` off and on, this release sends, stores, reads back
 * and delivers what 1.40.0 did, the user's value at `__edd_rt__` included. The differences are
 * the ones `RowTokenNames.test.ts` names: the outbox items' mark where its name is free, and the
 * tombstone read `create` no longer makes for a row read absent.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 */

import { readFileSync } from "node:fs"
import { it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Config, Effect } from "effect"
import { describe, expect } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
import { rowTokenInUse } from "../src/internal/TransactableOps.js"
import * as Table from "../src/Table.js"
import {
  layoutOf,
  type Mode,
  modesOf,
  type Ran,
  scenario,
  type Tables,
  TOKEN_POSITIONS,
  type TokenPosition,
  ttlNameOf,
  withoutMark,
} from "./helpers/RowTokenScenarios.js"

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

const lib = { DynamoSchema, DynamoModel, Table, Entity, EventStore, DynamoClient }
const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/row-token-names-1.40.0.json", import.meta.url), "utf8"),
) as { readonly version: string } & Record<string, Ran>

let made = 0
/** Fresh tables in the layout of `position` and `mode`, dropped after `use`. */
const withTables = <A>(
  position: TokenPosition,
  mode: Mode,
  use: (tables: Tables) => Effect.Effect<A, unknown, any>,
) =>
  Effect.gen(function* () {
    const ddb = yield* DynamoClient
    const stamp = `${Date.now()}-${made++}`
    const tables = { events: `rt-e-${stamp}`, read: `rt-r-${stamp}`, outbox: `rt-o-${stamp}` }
    const layout = layoutOf(position, mode)
    for (const [name, physical] of Object.entries(tables)) {
      const t = layout[name as keyof Tables]
      const attributes = new Set([t.pk, t.sk])
      const global: Array<any> = []
      const local: Array<any> = []
      for (const [index, keys] of Object.entries(t.indexes)) {
        attributes.add(keys.pk).add(keys.sk)
        const entry = {
          IndexName: index,
          KeySchema: [
            { AttributeName: keys.pk, KeyType: "HASH" as const },
            { AttributeName: keys.sk, KeyType: "RANGE" as const },
          ],
          Projection: { ProjectionType: "ALL" as const },
        }
        if (keys.local === true) local.push(entry)
        else global.push(entry)
      }
      yield* ddb.createTable({
        TableName: physical,
        BillingMode: "PAY_PER_REQUEST",
        AttributeDefinitions: [...attributes].map((name) => ({
          AttributeName: name,
          AttributeType: "S" as const,
        })),
        KeySchema: [
          { AttributeName: t.pk, KeyType: "HASH" },
          { AttributeName: t.sk, KeyType: "RANGE" },
        ],
        ...(global.length > 0 && { GlobalSecondaryIndexes: global }),
        ...(local.length > 0 && { LocalSecondaryIndexes: local }),
      })
    }
    return yield* use(tables).pipe(
      Effect.ensuring(
        Effect.forEach(
          Object.values(tables),
          (name) => ddb.deleteTable({ TableName: name }).pipe(Effect.ignore),
          { discard: true },
        ),
      ),
    )
  })

/** What 1.40.0 did, but for the tombstone read `create` no longer makes (`RowTokenNames.test.ts`). */
const expectedOf = (at: string, position: TokenPosition, mode: Mode): Ran => {
  const given = fixture[at]!
  if (position !== "ttl" || mode !== "standalone") return given
  const [first, read, create, ...rest] = given.sent
  expect(read).toEqual(first)
  return { ...given, sent: [first!, create!, ...rest] }
}

describeConnected("a read model whose row token's name is taken, on DynamoDB Local (#237)", () => {
  for (const position of TOKEN_POSITIONS) {
    for (const mode of modesOf(position)) {
      for (const projections of [1, 2] as const) {
        for (const escapeKeys of [false, true]) {
          const at = `${position}/${mode}/${projections}/${escapeKeys ? "on" : "off"}`
          it.live(`${at}: 1.40.0's requests, rows, reads and effects`, () =>
            withTables(position, mode, (tables) =>
              Effect.gen(function* () {
                const s = scenario(lib, tables, position, { mode, projections, escapeKeys })
                const ran = yield* s.run(ClientLayer)
                expect(rowTokenInUse(s.Tallies, ttlNameOf(position))).toBe(false)
                const compared = mode === "outbox" ? withoutMark(ran) : ran
                if (mode === "outbox") expect(JSON.stringify(ran.sent)).toContain("__edd_rm__")
                expect(compared).toEqual(expectedOf(at, position, mode))
              }),
            ).pipe(Effect.provide(ClientLayer)),
          )
        }
      }
    }
  }
})
