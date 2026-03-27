/**
 * Cricket Aggregate HTTP Pattern Validation
 *
 * Validates that all aggregate patterns used in the gamemanager tutorial's
 * Phase 5 work correctly: createSchema, get, update (cursor), delete.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *
 * Run:
 *   npx tsx examples/cricket-api-test.ts
 */

import { Console, Effect, Layer, Schema } from "effect"
import * as Aggregate from "../src/Aggregate.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as DynamoModel from "../src/DynamoModel.js"
import * as DynamoSchema from "../src/DynamoSchema.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"

// Models (identical to cricket.ts)
class Team extends Schema.Class<Team>("Team")({ id: Schema.String.pipe(DynamoModel.identifier), name: Schema.String, country: Schema.String, ranking: Schema.Number }) {}
class Player extends Schema.Class<Player>("Player")({ id: Schema.String.pipe(DynamoModel.identifier), firstName: Schema.String, lastName: Schema.String, role: Schema.Literals(["batter", "bowler", "all-rounder", "wicket-keeper"]) }) {}
class Coach extends Schema.Class<Coach>("Coach")({ id: Schema.String.pipe(DynamoModel.identifier), name: Schema.String }) {}
class Venue extends Schema.Class<Venue>("Venue")({ id: Schema.String.pipe(DynamoModel.identifier), name: Schema.String, city: Schema.String }) {}
class PlayerSheet extends Schema.Class<PlayerSheet>("PlayerSheet")({ player: Player.pipe(DynamoModel.ref), battingPosition: Schema.Number, isCaptain: Schema.Boolean }) {}
class TeamSheet extends Schema.Class<TeamSheet>("TeamSheet")({ team: Team.pipe(DynamoModel.ref), coach: Coach.pipe(DynamoModel.ref), homeTeam: Schema.Boolean, players: Schema.Array(PlayerSheet) }) {}
class Match extends Schema.Class<Match>("Match")({ id: Schema.String, name: Schema.String, venue: Venue.pipe(DynamoModel.ref), team1: TeamSheet, team2: TeamSheet }) {}

// Entities + Aggregate
const S = DynamoSchema.make({ name: "cricket", version: 1 })
const Teams = Entity.make({ model: DynamoModel.configure(Team, { id: { field: "teamId" } }), entityType: "Team", primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } } })
const Players = Entity.make({ model: DynamoModel.configure(Player, { id: { field: "playerId" } }), entityType: "Player", primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } } })
const Coaches = Entity.make({ model: DynamoModel.configure(Coach, { id: { field: "coachId" } }), entityType: "Coach", primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } } })
const Venues = Entity.make({ model: DynamoModel.configure(Venue, { id: { field: "venueId" } }), entityType: "Venue", primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } } })
const MainTable = Table.make({ schema: S, entities: { Teams, Players, Coaches, Venues } })

const TSA = Aggregate.make(TeamSheet, {
  root: { entityType: "MatchTeam" },
  edges: {
    team: Aggregate.ref(Teams),
    coach: Aggregate.one("coach", { entityType: "MatchCoach", entity: Coaches }),
    players: Aggregate.many("players", { entityType: "MatchPlayer", entity: Players }),
  },
})
const MatchAggregate = Aggregate.make(Match, {
  table: MainTable, schema: S,
  pk: { field: "pk", composite: ["id"] },
  collection: { index: "lsi1", name: "match", sk: { field: "lsi1sk", composite: ["name"] } },
  root: { entityType: "MatchItem" },
  edges: {
    venue: Aggregate.one("venue", { entityType: "MatchVenue", entity: Venues }),
    team1: TSA.with({ discriminator: { teamNumber: 1 } }),
    team2: TSA.with({ discriminator: { teamNumber: 2 } }),
  },
})

const assert = (cond: boolean, msg: string) => { if (!cond) throw new Error(`Assertion failed: ${msg}`) }
const assertEq = <T>(a: T, b: T, msg: string) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`Assertion failed [${msg}]: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`) }

const program = Effect.gen(function* () {
  const db = yield* DynamoClient.make(MainTable)
  const client = yield* DynamoClient
  const tableConfig = yield* MainTable.Tag

  // Create table with LSI (delete first if exists)
  yield* client.deleteTable({ TableName: tableConfig.name }).pipe(Effect.ignore)
  yield* client.createTable({
    TableName: tableConfig.name,
    BillingMode: "PAY_PER_REQUEST",
    KeySchema: [
      { AttributeName: "pk", KeyType: "HASH" },
      { AttributeName: "sk", KeyType: "RANGE" },
    ],
    AttributeDefinitions: [
      { AttributeName: "pk", AttributeType: "S" },
      { AttributeName: "sk", AttributeType: "S" },
      { AttributeName: "lsi1sk", AttributeType: "S" },
    ],
    LocalSecondaryIndexes: [{
      IndexName: "lsi1",
      KeySchema: [
        { AttributeName: "pk", KeyType: "HASH" },
        { AttributeName: "lsi1sk", KeyType: "RANGE" },
      ],
      Projection: { ProjectionType: "ALL" },
    }],
  })

  // Seed reference data
  yield* db.Teams.put({ id: "aus", name: "Australia", country: "Australia", ranking: 1 })
  yield* db.Teams.put({ id: "ind", name: "India", country: "India", ranking: 2 })
  yield* db.Players.put({ id: "smith-01", firstName: "Steve", lastName: "Smith", role: "batter" })
  yield* db.Players.put({ id: "cummins-01", firstName: "Pat", lastName: "Cummins", role: "bowler" })
  yield* db.Players.put({ id: "kohli-01", firstName: "Virat", lastName: "Kohli", role: "batter" })
  yield* db.Coaches.put({ id: "mcdonald", name: "Andrew McDonald" })
  yield* db.Coaches.put({ id: "gambhir", name: "Gautam Gambhir" })
  yield* db.Venues.put({ id: "mcg", name: "Melbourne Cricket Ground", city: "Melbourne" })

  // === Test 1: Validate MatchAggregate.createSchema ===
  yield* Console.log("Test 1: MatchAggregate.createSchema")
  const createInput = {
    id: "bgt-2025-test-1",
    name: "AUS vs IND, 1st Test",
    venueId: "mcg",
    team1: {
      teamId: "aus", coachId: "mcdonald", homeTeam: true,
      players: [
        { playerId: "cummins-01", battingPosition: 8, isCaptain: true },
        { playerId: "smith-01", battingPosition: 4, isCaptain: false },
      ],
    },
    team2: {
      teamId: "ind", coachId: "gambhir", homeTeam: false,
      players: [{ playerId: "kohli-01", battingPosition: 4, isCaptain: true }],
    },
  }
  // createSchema omits PK composites (id) — only contains non-PK fields
  const createPayload = { ...createInput }
  delete (createPayload as any).id
  const decoded = yield* Schema.decodeUnknownEffect(MatchAggregate.createSchema)(createPayload)
  assert((decoded as any).venueId === "mcg", "createSchema decoded venueId")
  assert((decoded as any).id === undefined, "createSchema omits PK composite (id)")
  yield* Console.log("  createSchema decodes input (minus PK) correctly — OK")

  // === Test 2: Aggregate.create with ref hydration ===
  yield* Console.log("\nTest 2: Aggregate.create (ref hydration)")
  const match = yield* MatchAggregate.create(createInput)
  assertEq(match.name, "AUS vs IND, 1st Test", "match name")
  assertEq(match.venue.name, "Melbourne Cricket Ground", "venue name hydrated")
  assertEq(match.team1.team.name, "Australia", "team1 hydrated")
  assertEq(match.team2.team.name, "India", "team2 hydrated")
  assertEq(match.team1.coach.name, "Andrew McDonald", "team1 coach hydrated")
  assertEq(match.team1.players.length, 2, "team1 has 2 players")
  assertEq(match.team2.players.length, 1, "team2 has 1 player")
  yield* Console.log("  Created and hydrated match — OK")

  // === Test 3: Aggregate.get ===
  yield* Console.log("\nTest 3: Aggregate.get")
  const fetched = yield* MatchAggregate.get({ id: "bgt-2025-test-1" })
  assertEq(fetched.name, "AUS vs IND, 1st Test", "fetched match name")
  assertEq(fetched.team1.players.length, 2, "fetched team1 players")
  assertEq(fetched.venue.city, "Melbourne", "fetched venue city")
  yield* Console.log("  Get and assemble match — OK")

  // === Test 4: Aggregate.update (cursor) ===
  yield* Console.log("\nTest 4: Aggregate.update (cursor replace)")
  const renamed = yield* MatchAggregate.update({ id: "bgt-2025-test-1" }, ({ cursor }) =>
    cursor.key("name").replace("AUS vs IND, Boxing Day Test"),
  )
  assertEq(renamed.name, "AUS vs IND, Boxing Day Test", "renamed match")
  yield* Console.log("  Cursor-based rename — OK")

  // === Test 5: Aggregate.update (captaincy transfer) ===
  yield* Console.log("\nTest 5: Aggregate.update (mutation)")
  const updated = yield* MatchAggregate.update({ id: "bgt-2025-test-1" }, ({ cursor }) =>
    cursor.key("team1").key("players").modify((players) =>
      players.map((ps) => ({ ...ps, isCaptain: ps.player.lastName === "Smith" })),
    ),
  )
  const smithCaptain = updated.team1.players.find((p) => p.player.lastName === "Smith")
  const cumminsCaptain = updated.team1.players.find((p) => p.player.lastName === "Cummins")
  assert(smithCaptain?.isCaptain === true, "Smith is now captain")
  assert(cumminsCaptain?.isCaptain === false, "Cummins is no longer captain")
  yield* Console.log("  Captaincy transfer — OK")

  // === Test 6: Aggregate.delete ===
  yield* Console.log("\nTest 6: Aggregate.delete")
  yield* MatchAggregate.delete({ id: "bgt-2025-test-1" })
  const getResult = yield* MatchAggregate.get({ id: "bgt-2025-test-1" }).pipe(Effect.flip)
  assertEq(getResult._tag, "AggregateAssemblyError", "get after delete fails")
  yield* Console.log("  Delete and verify gone — OK")

  // Cleanup
  yield* db.deleteTable()
  yield* Console.log("\n=== All 6 tests passed ===")
})

const AppLayer = Layer.merge(
  DynamoClient.layer({ region: "us-east-1", endpoint: "http://localhost:8000", credentials: { accessKeyId: "local", secretAccessKey: "local" } }),
  MainTable.layer({ name: "cricket-api-test" }),
)
const main = program.pipe(Effect.provide(AppLayer))
Effect.runPromise(main).then(
  () => console.log("\nDone."),
  (err) => console.error("Failed:", err),
)
