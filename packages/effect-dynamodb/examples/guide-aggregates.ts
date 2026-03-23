/**
 * Aggregates & Relational Patterns — Guide Example
 *
 * Demonstrates:
 *   - DynamoModel.identifier for marking business ID fields
 *   - DynamoModel.ref for denormalized entity references
 *   - Entity.make with refs config for ref hydration
 *   - Entity.Input accepts IDs, Entity.Record returns full objects
 *   - RefNotFound error handling
 *   - Aggregate.make for sub-aggregates and top-level aggregates
 *   - Aggregate.one, Aggregate.many, Aggregate.ref edge types
 *   - Sub-aggregate discriminators via .with()
 *   - Aggregate CRUD: create, get, update (cursor + spread), delete
 *   - Aggregate type extractors
 *   - Aggregate error handling
 *   - Entity.cascade for propagating source changes to ref consumers
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *
 * Run:
 *   npx tsx examples/guide-aggregates.ts
 */

import { Console, Effect, Layer, Schema } from "effect"
import * as Aggregate from "../src/Aggregate.js"
import * as Collections from "../src/Collections.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as DynamoModel from "../src/DynamoModel.js"
import * as DynamoSchema from "../src/DynamoSchema.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"

// ---------------------------------------------------------------------------
// 1. Domain models
// ---------------------------------------------------------------------------

// #region identifier-model
class Team extends Schema.Class<Team>("Team")({
  id: Schema.String.pipe(DynamoModel.identifier),
  name: Schema.String,
  country: Schema.String,
  ranking: Schema.Number,
}) {}
// #endregion

class Player extends Schema.Class<Player>("Player")({
  id: Schema.String.pipe(DynamoModel.identifier),
  firstName: Schema.String,
  lastName: Schema.String,
  role: Schema.Literals(["batter", "bowler", "all-rounder", "wicket-keeper"]),
}) {}

class Coach extends Schema.Class<Coach>("Coach")({
  id: Schema.String.pipe(DynamoModel.identifier),
  name: Schema.String,
}) {}

class Venue extends Schema.Class<Venue>("Venue")({
  id: Schema.String.pipe(DynamoModel.identifier),
  name: Schema.String,
  city: Schema.String,
}) {}

// #region ref-model
class SquadSelection extends Schema.Class<SquadSelection>("SquadSelection")({
  squadId: Schema.String,
  selectionNumber: Schema.Number,
  team: Team.pipe(DynamoModel.ref),
  player: Player.pipe(DynamoModel.ref),
  squadRole: Schema.Literals(["batter", "bowler", "all-rounder"]),
  isCaptain: Schema.Boolean,
}) {}
// #endregion

// #region aggregate-schemas
class PlayerSheet extends Schema.Class<PlayerSheet>("PlayerSheet")({
  player: Player.pipe(DynamoModel.ref),
  battingPosition: Schema.Number,
  isCaptain: Schema.Boolean,
}) {}

class TeamSheet extends Schema.Class<TeamSheet>("TeamSheet")({
  team: Team.pipe(DynamoModel.ref),
  coach: Coach.pipe(DynamoModel.ref),
  homeTeam: Schema.Boolean,
  players: Schema.Array(PlayerSheet),
}) {}

class Match extends Schema.Class<Match>("Match")({
  id: Schema.String,
  name: Schema.String,
  venue: Venue.pipe(DynamoModel.ref),
  team1: TeamSheet,
  team2: TeamSheet,
}) {}
// #endregion

// ---------------------------------------------------------------------------
// 2. Schema + Table + Entities
// ---------------------------------------------------------------------------

const CricketSchema = DynamoSchema.make({ name: "cricket", version: 1 })

const Teams = Entity.make({
  model: DynamoModel.configure(Team, { id: { field: "teamId" } }),
  entityType: "Team",
  primaryKey: {
    pk: { field: "pk", composite: ["id"] },
    sk: { field: "sk", composite: [] },
  },
})

const Players = Entity.make({
  model: DynamoModel.configure(Player, { id: { field: "playerId" } }),
  entityType: "Player",
  primaryKey: {
    pk: { field: "pk", composite: ["id"] },
    sk: { field: "sk", composite: [] },
  },
})

const Coaches = Entity.make({
  model: DynamoModel.configure(Coach, { id: { field: "coachId" } }),
  entityType: "Coach",
  primaryKey: {
    pk: { field: "pk", composite: ["id"] },
    sk: { field: "sk", composite: [] },
  },
})

const Venues = Entity.make({
  model: DynamoModel.configure(Venue, { id: { field: "venueId" } }),
  entityType: "Venue",
  primaryKey: {
    pk: { field: "pk", composite: ["id"] },
    sk: { field: "sk", composite: [] },
  },
})

// #region entity-with-refs
const SquadSelections = Entity.make({
  model: SquadSelection,
  entityType: "SquadSelection",
  primaryKey: {
    pk: { field: "pk", composite: ["squadId"] },
    sk: { field: "sk", composite: ["selectionNumber"] },
  },
  refs: {
    team: { entity: Teams },
    player: { entity: Players },
  },
})
// #endregion

const SquadByPlayer = Collections.make("squadByPlayer", {
  index: "gsi1",
  pk: { field: "gsi1pk", composite: ["playerId"] },
  sk: { field: "gsi1sk" },
  members: {
    SquadSelections: Collections.member(SquadSelections, {
      sk: { composite: ["squadId", "selectionNumber"] },
    }),
  },
})

const MainTable = Table.make({
  schema: CricketSchema,
  entities: { Teams, Players, Coaches, Venues, SquadSelections },
})

// ---------------------------------------------------------------------------
// 3. Aggregate definitions
// ---------------------------------------------------------------------------

// #region sub-aggregate
const TeamSheetAggregate = Aggregate.make(TeamSheet, {
  root: { entityType: "MatchTeam" },
  edges: {
    team: Aggregate.ref(Teams),
    coach: Aggregate.one("coach", { entityType: "MatchCoach", entity: Coaches }),
    players: Aggregate.many("players", { entityType: "MatchPlayer", entity: Players }),
  },
})
// #endregion

// #region top-level-aggregate
const MatchAggregate = Aggregate.make(Match, {
  table: MainTable,
  schema: CricketSchema,
  pk: { field: "pk", composite: ["id"] },
  collection: {
    index: "lsi1",
    name: "match",
    sk: { field: "lsi1sk", composite: ["name"] },
  },
  root: { entityType: "MatchItem" },
  edges: {
    venue: Aggregate.one("venue", { entityType: "MatchVenue", entity: Venues }),
    team1: TeamSheetAggregate.with({ discriminator: { teamNumber: 1 } }),
    team2: TeamSheetAggregate.with({ discriminator: { teamNumber: 2 } }),
  },
})
// #endregion

// #region type-extractors
type MatchDomain = Aggregate.Type<typeof MatchAggregate> // Match
type MatchKey = Aggregate.Key<typeof MatchAggregate> // { id: string }
// #endregion

void (undefined as MatchDomain | undefined)
void (undefined as MatchKey | undefined)

// ---------------------------------------------------------------------------
// 4. Program
// ---------------------------------------------------------------------------

const program = Effect.gen(function* () {
  const db = yield* DynamoClient.make({
    entities: { Teams, Players, Coaches, Venues, SquadSelections },
    collections: { SquadByPlayer },
  })
  const client = yield* DynamoClient
  const tableConfig = yield* MainTable.Tag

  yield* Console.log("=== Aggregates & Relational Patterns ===\n")

  // --- Create table (with LSI + GSI) ---
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
      { AttributeName: "gsi1pk", AttributeType: "S" },
      { AttributeName: "gsi1sk", AttributeType: "S" },
    ],
    LocalSecondaryIndexes: [
      {
        IndexName: "lsi1",
        KeySchema: [
          { AttributeName: "pk", KeyType: "HASH" },
          { AttributeName: "lsi1sk", KeyType: "RANGE" },
        ],
        Projection: { ProjectionType: "ALL" },
      },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: "gsi1",
        KeySchema: [
          { AttributeName: "gsi1pk", KeyType: "HASH" },
          { AttributeName: "gsi1sk", KeyType: "RANGE" },
        ],
        Projection: { ProjectionType: "ALL" },
      },
    ],
  })

  // =========================================================================
  // Part 1: Entity References
  // =========================================================================

  yield* Console.log("--- Part 1: Entity References ---\n")

  // Seed reference data
  yield* db.entities.Teams.put({ id: "aus", name: "Australia", country: "Australia", ranking: 1 })
  yield* db.entities.Teams.put({ id: "ind", name: "India", country: "India", ranking: 2 })
  yield* db.entities.Players.put({
    id: "smith-01",
    firstName: "Steve",
    lastName: "Smith",
    role: "batter",
  })
  yield* db.entities.Players.put({
    id: "cummins-01",
    firstName: "Pat",
    lastName: "Cummins",
    role: "bowler",
  })
  yield* db.entities.Players.put({
    id: "kohli-01",
    firstName: "Virat",
    lastName: "Kohli",
    role: "batter",
  })
  yield* db.entities.Coaches.put({ id: "mcdonald", name: "Andrew McDonald" })
  yield* db.entities.Coaches.put({ id: "gambhir", name: "Gautam Gambhir" })
  yield* db.entities.Venues.put({ id: "mcg", name: "Melbourne Cricket Ground", city: "Melbourne" })

  // #region ref-put-get
  // Input accepts IDs — not full objects
  yield* db.entities.SquadSelections.put({
    squadId: "aus#2024-25#BGT",
    selectionNumber: 1,
    teamId: "aus",
    playerId: "cummins-01",
    squadRole: "bowler",
    isCaptain: true,
  })

  // Record returns full domain objects
  const selection = yield* db.entities.SquadSelections.get({
    squadId: "aus#2024-25#BGT",
    selectionNumber: 1,
  })
  yield* Console.log(`Captain: ${selection.player.firstName} ${selection.player.lastName}`)
  yield* Console.log(`  Team: ${selection.team.name} (${selection.team.country})`)
  yield* Console.log(`  Role: ${selection.player.role}`)
  // #endregion

  yield* db.entities.SquadSelections.put({
    squadId: "aus#2024-25#BGT",
    selectionNumber: 2,
    teamId: "aus",
    playerId: "smith-01",
    squadRole: "batter",
    isCaptain: false,
  })
  yield* db.entities.SquadSelections.put({
    squadId: "ind#2024-25#BGT",
    selectionNumber: 1,
    teamId: "ind",
    playerId: "kohli-01",
    squadRole: "batter",
    isCaptain: false,
  })

  // #region ref-not-found
  // RefNotFound when a ref doesn't resolve
  const refError = yield* db.entities.SquadSelections.put({
    squadId: "aus#2024-25#BGT",
    selectionNumber: 99,
    teamId: "aus",
    playerId: "nonexistent",
    squadRole: "batter",
    isCaptain: false,
  }).pipe(Effect.flip)

  if (refError._tag === "RefNotFound") {
    // refError.field     → "player"
    // refError.refId     → "nonexistent"
    // refError.refEntity → "Player"
  }
  // #endregion
  yield* Console.log(`RefNotFound: ${refError._tag}`)

  // =========================================================================
  // Part 2: Aggregate CRUD
  // =========================================================================

  yield* Console.log("\n--- Part 2: Aggregate CRUD ---\n")

  // #region aggregate-create
  const match = yield* MatchAggregate.create({
    id: "bgt-2025-test-1",
    name: "AUS vs IND, 1st Test",
    venueId: "mcg",
    team1: {
      teamId: "aus",
      coachId: "mcdonald",
      homeTeam: true,
      players: [
        { playerId: "cummins-01", battingPosition: 8, isCaptain: true },
        { playerId: "smith-01", battingPosition: 4, isCaptain: false },
      ],
    },
    team2: {
      teamId: "ind",
      coachId: "gambhir",
      homeTeam: false,
      players: [{ playerId: "kohli-01", battingPosition: 4, isCaptain: true }],
    },
  })
  // #endregion

  yield* Console.log(`Created match: ${match.name}`)
  yield* Console.log(`Venue: ${match.venue.name}, ${match.venue.city}`)

  // #region aggregate-get
  const fetched = yield* MatchAggregate.get({ id: "bgt-2025-test-1" })
  // #endregion

  yield* Console.log(`Fetched: ${fetched.name}`)
  yield* Console.log(`Venue: ${fetched.venue.name}`)
  yield* Console.log(`Team 1: ${fetched.team1.team.name}`)

  // #region aggregate-update-spread
  const updated = yield* MatchAggregate.update({ id: "bgt-2025-test-1" }, (current) => ({
    ...current.state,
    team1: {
      ...current.state.team1,
      players: current.state.team1.players.map((ps) => ({
        ...ps,
        isCaptain: ps.player.lastName === "Smith",
      })),
    },
  }))
  // #endregion

  yield* Console.log(
    `\nUpdated captain: ${updated.team1.players.find((p) => p.isCaptain)?.player.lastName}`,
  )

  // #region aggregate-update-cursor
  const cursorUpdated = yield* MatchAggregate.update({ id: "bgt-2025-test-1" }, ({ cursor }) =>
    cursor
      .key("team1")
      .key("players")
      .modify((players) =>
        players.map((ps) => ({ ...ps, isCaptain: ps.player.lastName === "Smith" })),
      ),
  )
  // #endregion

  yield* Console.log(
    `Cursor update captain: ${cursorUpdated.team1.players.find((p) => p.isCaptain)?.player.lastName}`,
  )

  // #region aggregate-update-simple
  yield* MatchAggregate.update({ id: "bgt-2025-test-1" }, ({ cursor }) =>
    cursor.key("name").replace("AUS vs IND, Boxing Day Test"),
  )
  // #endregion

  // #region aggregate-update-optic
  yield* MatchAggregate.update({ id: "bgt-2025-test-1" }, ({ state, optic }) =>
    optic.key("name").replace("AUS vs IND, 1st Test", state),
  )
  // #endregion

  // #region aggregate-error-handling
  const result = yield* MatchAggregate.get({ id: "nonexistent" }).pipe(
    Effect.catchTag("AggregateAssemblyError", (e) =>
      Effect.succeed(`Assembly failed for ${e.aggregate}: ${e.reason}`),
    ),
  )
  yield* Console.log(`Error handled: ${result}`)
  // #endregion

  // #region aggregate-delete
  yield* MatchAggregate.delete({ id: "bgt-2025-test-1" })
  // #endregion

  yield* Console.log("Match deleted.")

  // =========================================================================
  // Part 3: Cascade Updates
  // =========================================================================

  yield* Console.log("\n--- Part 3: Cascade Updates ---\n")

  // #region cascade-basic
  const updatedPlayer = yield* db.entities.Players.update(
    { id: "smith-01" },
    Entity.set({ firstName: "Steven" }),
    Entity.cascade({ targets: [SquadSelections] }),
  )
  // #endregion

  yield* Console.log(`Updated player: ${updatedPlayer.firstName} ${updatedPlayer.lastName}`)

  // Verify cascade propagated
  const afterCascade = yield* db.entities.SquadSelections.get({
    squadId: "aus#2024-25#BGT",
    selectionNumber: 2,
  })
  yield* Console.log(
    `After cascade: ${afterCascade.player.firstName} ${afterCascade.player.lastName} (was "Steve Smith")`,
  )

  // #region cascade-eventual
  yield* db.entities.Players.update(
    { id: "smith-01" },
    Entity.set({ firstName: "Steven" }),
    Entity.cascade({ targets: [SquadSelections], mode: "eventual" }),
  )
  // #endregion

  // #region cascade-transactional
  yield* db.entities.Players.update(
    { id: "smith-01" },
    Entity.set({ firstName: "Steven" }),
    Entity.cascade({ targets: [SquadSelections], mode: "transactional" }),
  )
  // #endregion

  // --- Cleanup ---
  yield* Console.log("\nCleaning up...")
  yield* db.tables["guide-aggregates-table"]!.delete()
  yield* Console.log("Done.")
})

// ---------------------------------------------------------------------------
// 5. Run
// ---------------------------------------------------------------------------

// #region layer
const AppLayer = Layer.merge(
  DynamoClient.layer({
    region: "us-east-1",
    endpoint: "http://localhost:8000",
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  }),
  MainTable.layer({ name: "guide-aggregates-table" }),
)

const main = program.pipe(Effect.provide(AppLayer))

Effect.runPromise(main).then(
  () => console.log("\nDone."),
  (err) => console.error("Failed:", err),
)
// #endregion
