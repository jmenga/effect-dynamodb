/**
 * A `rebuild` enqueues nothing in the outbox (#237), on DynamoDB Local, against what the published
 * 1.40.0 did there (`helpers/RebuildScenarios.ts`, `fixtures/outbox-rebuild-1.40.0.json`): the
 * row written alone, no outbox item, the pending one delivered once and a later live event's
 * once, where 1.40.0 delivered each re-derived effect twice. Single- and multi-source, over a live
 * row and an absent one, `escapeKeys` off and on.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 */

import { it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Config, Effect } from "effect"
import { describe, expect } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
import * as Table from "../src/Table.js"
import { layoutOf, type Tables } from "./helpers/OutboxScenarios.js"
import { checkRebuilt, rebuildFixture } from "./helpers/RebuildChecks.js"
import {
  REBUILD_MODES,
  REBUILD_STATES,
  rebuildKey,
  rebuildScenario,
} from "./helpers/RebuildScenarios.js"

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
const lib = { DynamoSchema, Table, Entity, EventStore, DynamoClient }

let made = 0
/** Fresh tables (`layoutOf("none")`), dropped after `use`. */
const withTables = <A>(use: (tables: Tables) => Effect.Effect<A, unknown, any>) =>
  Effect.gen(function* () {
    const ddb = yield* DynamoClient
    const stamp = `${Date.now()}-${made++}`
    const tables = { events: `rb-e-${stamp}`, read: `rb-r-${stamp}`, outbox: `rb-o-${stamp}` }
    const layout = layoutOf("none")
    for (const [name, physical] of Object.entries(tables)) {
      const t = layout[name as keyof Tables]
      const attributes = new Set([t.pk, t.sk])
      const global = Object.entries(t.indexes).map(([index, keys]) => {
        attributes.add(keys.pk).add(keys.sk)
        return {
          IndexName: index,
          KeySchema: [
            { AttributeName: keys.pk, KeyType: "HASH" as const },
            { AttributeName: keys.sk, KeyType: "RANGE" as const },
          ],
          Projection: { ProjectionType: "ALL" as const },
        }
      })
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

describeConnected("a rebuild enqueues nothing in the outbox, on DynamoDB Local (#237)", () => {
  for (const mode of REBUILD_MODES) {
    for (const state of REBUILD_STATES) {
      for (const escapeKeys of [false, true]) {
        const at = rebuildKey(mode, state, escapeKeys)
        it.effect(`${at}: no outbox item; the pending one and a live one delivered once`, () =>
          withTables((tables) =>
            Effect.gen(function* () {
              const ran = yield* rebuildScenario(lib, tables, mode, state, { escapeKeys }).run(
                ClientLayer,
              )
              expect(rebuildFixture.version).toBe("1.40.0")
              checkRebuilt(ran, rebuildFixture.scenarios[at]!, state)
            }),
          ).pipe(Effect.provide(ClientLayer)),
        )
      }
    }
  }
})
