/**
 * `rekey` over an entity made with `@effect-dynamodb/schema`'s pure `Entity.make` (#265), on
 * DynamoDB Local: a row written with `escapeKeys` off holds an index key a write with it on doesn't
 * store. The run with it on counts that key, repairs it, and the index query finds the row, as it
 * does for the same entity made with `effect-dynamodb`. Up to the fix the pure entity's row was
 * `skipped.unregistered` and kept its index key.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 */

import { it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import * as PureEntity from "@effect-dynamodb/schema/Entity.js"
import { Config, Effect, Schema } from "effect"
import { describe, expect } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"

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

class Team extends Schema.Class<Team>("Team")({ id: Schema.String, name: Schema.String }) {}

const teams = {
  model: DynamoModel.configure(Team, { id: { identifier: true } }),
  entityType: "Team",
  primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
  indexes: {
    byName: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: [] },
      sk: { field: "gsi1sk", composite: ["name"] },
    },
  },
} as const

const world = (made: "pure" | "runtime", escapeKeys: boolean) => {
  const schema = DynamoSchema.make({ name: "repro", version: 1, escapeKeys })
  if (made === "pure") {
    const Teams = PureEntity.make(teams)
    const MainTable = Table.make({ schema, entities: { Teams } })
    return { MainTable, client: DynamoClient.make({ entities: { Teams }, tables: { MainTable } }) }
  }
  const Teams = Entity.make(teams)
  const MainTable = Table.make({ schema, entities: { Teams } })
  return { MainTable, client: DynamoClient.make({ entities: { Teams }, tables: { MainTable } }) }
}

let tables = 0

describeConnected("rekey over a pure definition's rows (#265)", () => {
  for (const made of ["pure", "runtime"] as const) {
    it.live(`an index key written with escapeKeys off, entity made ${made}`, () =>
      Effect.gen(function* () {
        const tableName = `rekey-pure-${Date.now()}-${tables++}`
        const before = world(made, false)
        const after = world(made, true)
        yield* Effect.gen(function* () {
          const db = yield* before.client
          yield* db.tables.MainTable.create()
          yield* db.entities.Teams.create({ id: "t1", name: "Team One" }).asEffect()
        }).pipe(Effect.provide(before.MainTable.layer({ name: tableName })))
        const runs = yield* Effect.gen(function* () {
          const db = yield* after.client
          // The issue's options.
          const options = { repairIndexKeys: true } as const
          const dry = yield* db.tables.MainTable.rekey({ ...options, dryRun: true })
          const real = yield* db.tables.MainTable.rekey(options)
          const again = yield* db.tables.MainTable.rekey(options)
          const found = yield* db.entities.Teams.byName({ name: "Team One" }).collect()
          return { dry, real, again, found }
        }).pipe(
          Effect.ensuring(
            Effect.ignore(Effect.flatMap(after.client, (db) => db.tables.MainTable.delete())),
          ),
          Effect.provide(after.MainTable.layer({ name: tableName })),
        )
        for (const report of [runs.dry, runs.real, runs.again]) {
          expect(report.scanned).toBe(1)
          expect(report.skipped.unregistered).toBe(0)
          expect(Object.keys(report.byMember)).toEqual(["Team"])
        }
        expect(runs.dry.indexKeysRewritten).toBe(1)
        expect(runs.real.indexKeysRewritten).toBe(1)
        expect(runs.again.indexKeysRewritten).toBe(0)
        expect(runs.again.unchanged).toBe(1)
        // Found under the key the run wrote.
        expect(runs.found.map((team) => team.id)).toEqual(["t1"])
      }).pipe(Effect.provide(ClientLayer)),
    )
  }
})
