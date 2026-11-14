/**
 * Connected tests for a unique constraint over refs (#266), against DynamoDB Local.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 *
 * The constraint names each ref's id (`teamId`), and its sentinel is composed from the id the
 * stored ref holds. On 1.41.0 the id was refused, and naming the ref (`team`) composed
 * `[object object]` for every item, so every item after the first collided. `UniqueOverRefs.test.ts`
 * covers the same ground against the in-memory table.
 */

import { it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Config, Effect, Layer, Schema } from "effect"
import { afterAll, beforeAll, describe, expect } from "vitest"
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

const tableName = `unique-refs-conn-${Date.now()}`

class Team extends Schema.Class<Team>("UniqueRefConnTeam")({
  id: Schema.String,
  name: Schema.String,
}) {}
class Player extends Schema.Class<Player>("UniqueRefConnPlayer")({
  id: Schema.String,
  name: Schema.String,
}) {}
class Selection extends Schema.Class<Selection>("UniqueRefConnSelection")({
  id: Schema.String,
  season: Schema.String,
  team: Team,
  player: Player,
}) {}

const primaryKey = {
  pk: { field: "pk", composite: ["id"] },
  sk: { field: "sk", composite: [] },
} as const

const Teams = Entity.make({
  model: DynamoModel.configure(Team, { id: { identifier: true } }),
  entityType: "Team",
  primaryKey,
})
const Players = Entity.make({
  model: DynamoModel.configure(Player, { id: { identifier: true } }),
  entityType: "Player",
  primaryKey,
})
const Selections = Entity.make({
  model: DynamoModel.configure(Selection, {
    id: { identifier: true },
    team: { ref: true },
    player: { ref: true },
  }),
  entityType: "Selection",
  primaryKey,
  refs: { team: { entity: Teams }, player: { entity: Players } },
  unique: { identity: ["season", "teamId", "playerId"] },
  softDelete: true,
})

const entities = { Teams, Players, Selections }
const MainTable = Table.make({
  schema: DynamoSchema.make({ name: "repro", version: 1 }),
  entities,
})

const TestLayer = Layer.mergeAll(
  DynamoClient.layer({
    region: "us-east-1",
    endpoint: ENDPOINT,
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  }),
  MainTable.layer({ name: tableName }),
)

const database = DynamoClient.make({ entities, tables: { MainTable } })

/** The partition key of each sentinel stored, sorted. */
const sentinels = Effect.gen(function* () {
  const client = yield* DynamoClient
  const all = yield* client.scan({ TableName: tableName, ConsistentRead: true })
  return (all.Items ?? [])
    .filter((row) => row.__edd_e__?.S === "Selection._unique.identity")
    .map((row) => row.pk?.S)
    .sort()
})
const reserved = (team: string, player: string) =>
  `$repro#v1#selection.identity#2025#${team}#${player}`

const tagOf = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.map(Effect.flip(effect), (error) => (error as { readonly _tag: string })._tag)

describeConnected("a unique constraint over refs — connected", () => {
  beforeAll(async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* DynamoClient
        yield* client.createTable({
          TableName: tableName,
          BillingMode: "PAY_PER_REQUEST",
          ...Table.definition(MainTable),
        })
        const db = yield* database
        for (const id of ["t1", "t2"]) yield* db.entities.Teams.create({ id, name: `Team ${id}` })
        for (const id of ["p1", "p2"]) yield* db.entities.Players.create({ id, name: `P ${id}` })
      }).pipe(Effect.provide(TestLayer)),
    )
  }, 15000)

  afterAll(async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* DynamoClient
        yield* client.deleteTable({ TableName: tableName })
      }).pipe(
        Effect.provide(TestLayer),
        Effect.catchTag("ResourceNotFoundError", () => Effect.void),
      ),
    )
  }, 15000)

  it.effect("reserves the values each item references, through update, delete and restore", () =>
    Effect.gen(function* () {
      const db = yield* database
      const selections = db.entities.Selections
      const create = (id: string, teamId: string, playerId: string) =>
        selections.create({ id, season: "2025", teamId, playerId }).asEffect()

      // The issue's script: a true duplicate is refused, another team and player is written.
      yield* create("s1", "t1", "p1")
      expect(yield* tagOf(create("s2", "t1", "p1"))).toBe("UniqueConstraintViolation")
      yield* create("s3", "t2", "p2")
      expect(yield* sentinels).toEqual([reserved("t1", "p1"), reserved("t2", "p2")])

      // An update reassigning a ref moves the reservation; a taken value is refused.
      yield* selections.update({ id: "s1" }).set({ teamId: "t2" })
      expect(yield* sentinels).toEqual([reserved("t2", "p1"), reserved("t2", "p2")])
      expect(yield* tagOf(selections.update({ id: "s3" }).set({ playerId: "p1" }).asEffect())).toBe(
        "UniqueConstraintViolation",
      )

      // A soft delete releases it, and `restore` takes it again.
      yield* selections.delete({ id: "s1" })
      expect(yield* sentinels).toEqual([reserved("t2", "p2")])
      yield* selections.restore({ id: "s1" })
      expect(yield* sentinels).toEqual([reserved("t2", "p1"), reserved("t2", "p2")])
      expect(yield* selections.get({ id: "s1" })).toMatchObject({
        team: { id: "t2" },
        player: { id: "p1" },
      })
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("rekey finds each sentinel held, and releases one composed from the ref itself", () =>
    Effect.gen(function* () {
      const db = yield* database
      const client = yield* DynamoClient
      const held = yield* db.tables.MainTable.rekey({ reservations: true })
      expect(held).toMatchObject({
        sentinelsMoved: 0,
        conflicts: [],
        reservations: { orphaned: 0, undecided: 0 },
      })

      // What 1.41.0 wrote for `unique: { identity: ["season", "team", "player"] }`, naming s3.
      const all = yield* client.scan({ TableName: tableName, ConsistentRead: true })
      const s3 = (all.Items ?? []).find((row) => row.pk?.S === reserved("t2", "p2"))
      const stale = "$repro#v1#selection.identity#2025#[object object]#[object object]"
      yield* client.putItem({ TableName: tableName, Item: { ...s3, pk: { S: stale } } })

      const judged = yield* db.tables.MainTable.rekey({ reservations: true, dryRun: true })
      expect(judged.reservations).toMatchObject({
        orphaned: 1,
        entries: [{ key: { pk: stale }, outcome: "orphaned" }],
      })
      const released = yield* db.tables.MainTable.rekey({
        releaseOrphanedReservations: true,
        writesStopped: true,
      })
      expect(released.reservations).toMatchObject({ orphaned: 1, released: 1 })
      expect(yield* sentinels).toEqual([reserved("t2", "p1"), reserved("t2", "p2")])
    }).pipe(Effect.provide(TestLayer)),
  )
})
