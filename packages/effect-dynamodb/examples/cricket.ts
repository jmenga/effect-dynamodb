/**
 * Cricket Match Example — Entity Refs + Cascade Updates + Aggregate CRUD
 *
 * Part 1: Demonstrates DynamoModel.ref and DynamoModel.identifier annotations
 * for embedding denormalized entity data in DynamoDB items.
 *
 * Part 2: Demonstrates Entity.cascade for propagating source entity changes
 * to all items that embed it via DynamoModel.ref.
 *
 * Part 3: Demonstrates the full Aggregate lifecycle:
 * - Aggregate.create: ref hydration, decomposition, sub-aggregate transactions
 * - Aggregate.get: query, discriminate, assemble from partition items
 * - Aggregate.update: fetch -> mutate -> diff -> write only changed groups
 * - Aggregate.delete: remove all items in the partition
 *
 * Key patterns:
 * - DynamoModel.identifier marks the primary business identifier on a model
 * - DynamoModel.ref marks a field that holds a denormalized copy of another entity
 * - Entity.Input accepts ID strings for ref fields (teamId, playerId)
 * - Entity.Record returns full domain objects for ref fields (team: Team, player: Player)
 * - Entity.cascade propagates source changes to denormalized copies in target entities
 * - Aggregate.make binds a Schema.Class to a graph of entity types
 * - Aggregate.create accepts ref IDs, hydrates from entities, writes via transactions
 * - Aggregate.get queries, discriminates, and assembles items into domain objects
 * - Aggregate.update diffs at graph edge boundaries, writes only changed sub-aggregates
 * - Aggregate.delete removes all items in the aggregate partition
 * - Sub-aggregates with discriminators enable reusable graph shapes
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *
 * Run:
 *   npx tsx examples/cricket.ts
 */

import { Console, Effect, Layer, Schema } from "effect"
import * as Aggregate from "../src/Aggregate.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as DynamoModel from "../src/DynamoModel.js"
import * as DynamoSchema from "../src/DynamoSchema.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"

// ---------------------------------------------------------------------------
// 1. Domain models — pure, no DynamoDB concepts
// ---------------------------------------------------------------------------

// #region models
// #region model-enums
const PlayerRole = {
  Batter: "batter",
  Bowler: "bowler",
  AllRounder: "all-rounder",
  WicketKeeper: "wicket-keeper",
} as const
const PlayerRoleSchema = Schema.Literals(Object.values(PlayerRole))
// #endregion

// #region model-standalone
// #region model-team
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
  role: PlayerRoleSchema,
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
// #endregion

// #region model-squad-selection
// SquadSelection — a player selected to a team's squad for a series/season.
class SquadSelection extends Schema.Class<SquadSelection>("SquadSelection")({
  id: Schema.String.pipe(DynamoModel.identifier),
  team: Team.pipe(DynamoModel.ref),
  player: Player.pipe(DynamoModel.ref),
  season: Schema.String,
  series: Schema.String,
  selectionNumber: Schema.Number,
  squadRole: PlayerRoleSchema,
  isCaptain: Schema.Boolean,
  isViceCaptain: Schema.Boolean,
}) {}
// #endregion

// #region model-aggregate
// Aggregate domain schemas
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
// #endregion

// ---------------------------------------------------------------------------
// 2. Schema
// ---------------------------------------------------------------------------

// #region schema
const CricketSchema = DynamoSchema.make({ name: "cricket", version: 1 })
// #endregion

// ---------------------------------------------------------------------------
// 3. Entity definitions — pure definitions, no table reference
// ---------------------------------------------------------------------------

// #region entities
// #region entity-standalone
// #region entity-team
const Teams = Entity.make({
  model: DynamoModel.configure(Team, { id: { field: "teamId" } }),
  entityType: "Team",
  primaryKey: {
    pk: { field: "pk", composite: ["id"] },
    sk: { field: "sk", composite: [] },
  },
})
// #endregion

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
// #endregion

// #region entity-squad-selection
const SquadSelections = Entity.make({
  model: DynamoModel.configure(SquadSelection, { id: { field: "selectionId" } }),
  entityType: "SquadSelection",
  primaryKey: {
    pk: { field: "pk", composite: ["id"] },
    sk: { field: "sk", composite: [] },
  },
  indexes: {
    byTeamSeries: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["teamId", "season", "series"] },
      sk: { field: "gsi1sk", composite: ["selectionNumber"] },
    },
    byPlayer: {
      name: "gsi2",
      pk: { field: "gsi2pk", composite: ["playerId"] },
      sk: { field: "gsi2sk", composite: ["season", "series"] },
    },
    // Single-composite GSI keyed on `teamId` — required so `Entity.cascade`
    // can fan out from a Team update to every SquadSelection that embeds it.
    byTeam: {
      name: "gsi3",
      pk: { field: "gsi3pk", composite: ["teamId"] },
      sk: { field: "gsi3sk", composite: [] },
    },
  },
  refs: {
    team: { entity: Teams },
    player: { entity: Players },
  },
})
// #endregion
// #endregion

// ---------------------------------------------------------------------------
// 4. Table + Collections
// ---------------------------------------------------------------------------

// #region table
const MainTable = Table.make({
  schema: CricketSchema,
  entities: { Teams, Players, Coaches, Venues, SquadSelections },
})
// #endregion

// ---------------------------------------------------------------------------
// 5. Aggregate definitions
// ---------------------------------------------------------------------------

// #region aggregates
// Sub-aggregate: a team's composition within a match
const TeamSheetAggregate = Aggregate.make(TeamSheet, {
  root: { entityType: "MatchTeam" },
  edges: {
    team: Aggregate.ref(Teams),
    coach: Aggregate.one("coach", { entityType: "MatchCoach", entity: Coaches }),
    players: Aggregate.many("players", { entityType: "MatchPlayer", entity: Players }),
  },
})

// Top-level aggregate: the full match
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

// ---------------------------------------------------------------------------
// 6. Type-level demonstration
// ---------------------------------------------------------------------------

// #region types
// Entity.Input accepts IDs for ref fields, not full objects
type SelectionInput = Entity.Input<typeof SquadSelections>
type SelectionRecord = Entity.Record<typeof SquadSelections>

// Aggregate.Type extracts the domain type
type MatchType = Aggregate.Type<typeof MatchAggregate>

const _input: SelectionInput | undefined = undefined
const _record: SelectionRecord | undefined = undefined
const _matchType: MatchType | undefined = undefined
void _input
void _record
void _matchType
// #endregion

// ---------------------------------------------------------------------------
// 7. Program — Entity Refs + Aggregate Read Path
// ---------------------------------------------------------------------------

const program = Effect.gen(function* () {
  // Get typed client — binds all entities and collections
  const db = yield* DynamoClient.make({
    entities: { Teams, Players, Coaches, Venues, SquadSelections },
  })

  // Keep raw client + table config for manual table creation (LSI required)
  const client = yield* DynamoClient
  const tableConfig = yield* MainTable.Tag

  yield* Console.log("=== Cricket Match Example ===\n")

  // --- Create table (with LSI for aggregate collection queries) ---
  yield* Console.log("Creating table:", tableConfig.name)
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
      { AttributeName: "gsi2pk", AttributeType: "S" },
      { AttributeName: "gsi2sk", AttributeType: "S" },
      { AttributeName: "gsi3pk", AttributeType: "S" },
      { AttributeName: "gsi3sk", AttributeType: "S" },
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
      {
        IndexName: "gsi2",
        KeySchema: [
          { AttributeName: "gsi2pk", KeyType: "HASH" },
          { AttributeName: "gsi2sk", KeyType: "RANGE" },
        ],
        Projection: { ProjectionType: "ALL" },
      },
      {
        IndexName: "gsi3",
        KeySchema: [
          { AttributeName: "gsi3pk", KeyType: "HASH" },
          { AttributeName: "gsi3sk", KeyType: "RANGE" },
        ],
        Projection: { ProjectionType: "ALL" },
      },
    ],
  })

  // =========================================================================
  // Part 1: Entity Refs
  // =========================================================================

  yield* Console.log("\n--- Part 1: Entity Refs ---\n")

  // #region seed-data
  // --- Create teams (model uses 'id', DB stores as 'teamId') ---
  yield* Console.log("Creating teams...")
  yield* db.entities.Teams.put({ id: "aus", name: "Australia", country: "Australia", ranking: 1 })
  yield* db.entities.Teams.put({ id: "ind", name: "India", country: "India", ranking: 2 })

  // --- Create players (model uses 'id', DB stores as 'playerId') ---
  yield* Console.log("Creating players...")
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

  // --- Create coaches ---
  yield* Console.log("Creating coaches...")
  yield* db.entities.Coaches.put({ id: "mcdonald", name: "Andrew McDonald" })
  yield* db.entities.Coaches.put({ id: "gambhir", name: "Gautam Gambhir" })

  // --- Create venues ---
  yield* Console.log("Creating venues...")
  yield* db.entities.Venues.put({ id: "mcg", name: "Melbourne Cricket Ground", city: "Melbourne" })
  // #endregion

  // #region squad-refs
  // --- Create squad selections with ref IDs ---
  yield* Console.log("\nCreating squad selections (AUS BGT 2024-25)...")

  yield* db.entities.SquadSelections.put({
    id: "sel-aus-1",
    season: "2024-25",
    series: "BGT",
    selectionNumber: 1,
    teamId: "aus",
    playerId: "cummins-01",
    squadRole: "bowler",
    isCaptain: true,
    isViceCaptain: false,
  })

  yield* db.entities.SquadSelections.put({
    id: "sel-aus-2",
    season: "2024-25",
    series: "BGT",
    selectionNumber: 2,
    teamId: "aus",
    playerId: "smith-01",
    squadRole: "batter",
    isCaptain: false,
    isViceCaptain: true,
  })

  yield* db.entities.SquadSelections.put({
    id: "sel-ind-1",
    season: "2024-25",
    series: "BGT",
    selectionNumber: 1,
    teamId: "ind",
    playerId: "kohli-01",
    squadRole: "batter",
    isCaptain: false,
    isViceCaptain: false,
  })

  // --- Get by ID returns full embedded data ---
  yield* Console.log("\nRetrieving squad selection...")
  const captain = yield* db.entities.SquadSelections.get({ id: "sel-aus-1" })
  yield* Console.log(`Captain: ${captain.player.firstName} ${captain.player.lastName}`)
  yield* Console.log(`  Team: ${captain.team.name} (${captain.team.country})`)
  yield* Console.log(`  Role: ${captain.player.role}`)
  yield* Console.log(`  Captain: ${captain.isCaptain}`)
  // #endregion

  // #region ref-not-found
  // --- RefNotFound when ref doesn't exist ---
  yield* Console.log("\nAttempting to create selection with nonexistent player...")
  const refError = yield* db.entities.SquadSelections.put({
    id: "sel-bad",
    season: "2024-25",
    series: "BGT",
    selectionNumber: 99,
    teamId: "aus",
    playerId: "nonexistent",
    squadRole: "batter",
    isCaptain: false,
    isViceCaptain: false,
  }).pipe(Effect.flip)

  if (refError._tag === "RefNotFound") {
    yield* Console.log(
      `RefNotFound: ${refError.field} "${refError.refId}" not found in ${refError.refEntity}`,
    )
  }
  // #endregion

  // =========================================================================
  // Part 2: Cascade Updates
  // =========================================================================

  yield* Console.log("\n--- Part 2: Cascade Updates ---\n")
  yield* Console.log("Updating Player 'Steve Smith' → 'Steven Smith' with cascade...")

  // #region cascade
  // Update the player and cascade to all SquadSelections that embed this player
  const updatedPlayer = yield* db.entities.Players.update(
    { id: "smith-01" },
    Entity.set({ firstName: "Steven" }),
    Entity.cascade({ targets: [SquadSelections] }),
  )

  yield* Console.log(`Updated player: ${updatedPlayer.firstName} ${updatedPlayer.lastName}`)

  // Verify cascade propagated — the squad selection should have the updated name
  const afterCascade = yield* db.entities.SquadSelections.get({ id: "sel-aus-2" })
  yield* Console.log(
    `Squad selection player after cascade: ${afterCascade.player.firstName} ${afterCascade.player.lastName}`,
  )
  yield* Console.log(`  (Should be "Steven Smith", was "Steve Smith")`)
  // #endregion

  // =========================================================================
  // Part 3: Aggregate CRUD
  // =========================================================================

  yield* Console.log("\n--- Part 3: Aggregate CRUD ---\n")

  // #region aggregate-create
  // --- Aggregate.create: ref hydration + sub-aggregate transactions ---
  yield* Console.log("Creating match via Aggregate.create...")
  yield* Console.log("  (Input uses ref IDs; system hydrates from entity data)")

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

  yield* Console.log(`\nCreated match: ${match.name}`)
  yield* Console.log(`Venue: ${match.venue.name}, ${match.venue.city}`)

  const printMatch = (m: typeof match) =>
    Effect.gen(function* () {
      yield* Console.log(`\nTeam 1: ${m.team1.team.name} (${m.team1.team.country})`)
      yield* Console.log(`  Home: ${m.team1.homeTeam}`)
      yield* Console.log(`  Coach: ${m.team1.coach.name}`)
      yield* Console.log(`  Players:`)
      for (const ps of m.team1.players) {
        const captainTag = ps.isCaptain ? " (C)" : ""
        yield* Console.log(
          `    ${ps.battingPosition}. ${ps.player.firstName} ${ps.player.lastName}${captainTag} [${ps.player.role}]`,
        )
      }

      yield* Console.log(`\nTeam 2: ${m.team2.team.name} (${m.team2.team.country})`)
      yield* Console.log(`  Home: ${m.team2.homeTeam}`)
      yield* Console.log(`  Coach: ${m.team2.coach.name}`)
      yield* Console.log(`  Players:`)
      for (const ps of m.team2.players) {
        const captainTag = ps.isCaptain ? " (C)" : ""
        yield* Console.log(
          `    ${ps.battingPosition}. ${ps.player.firstName} ${ps.player.lastName}${captainTag} [${ps.player.role}]`,
        )
      }
    })

  yield* printMatch(match)

  // #region aggregate-get
  // --- Aggregate.get: read it back ---
  yield* Console.log("\n--- Aggregate.get: Read back the match ---")
  const fetched = yield* MatchAggregate.get({ id: "bgt-2025-test-1" })
  yield* Console.log(`\nFetched match: ${fetched.name}`)
  yield* Console.log(`Venue: ${fetched.venue.name}, ${fetched.venue.city}`)
  yield* printMatch(fetched)
  // #endregion

  // #region aggregate-update
  // --- Aggregate.update: rename match using cursor ---
  yield* Console.log("\n--- Aggregate.update: Rename match (cursor replace) ---")
  const renamed = yield* MatchAggregate.update({ id: "bgt-2025-test-1" }, ({ cursor }) =>
    cursor.key("name").replace("AUS vs IND, Boxing Day Test"),
  )
  yield* Console.log(`Renamed match: ${renamed.name}`)

  // --- Aggregate.update: transfer captaincy using cursor ---
  yield* Console.log("\n--- Aggregate.update: Transfer captaincy (Cummins → Smith) ---")
  const updated = yield* MatchAggregate.update({ id: "bgt-2025-test-1" }, ({ cursor }) =>
    cursor
      .key("team1")
      .key("players")
      .modify((players) =>
        players.map((ps) => ({ ...ps, isCaptain: ps.player.lastName === "Smith" })),
      ),
  )

  yield* Console.log(`\nUpdated match: ${updated.name}`)
  yield* printMatch(updated)
  // #endregion

  // #region aggregate-delete
  // --- Aggregate.delete: remove all items ---
  yield* Console.log("\n--- Aggregate.delete: Remove the match ---")
  yield* MatchAggregate.delete({ id: "bgt-2025-test-1" })
  yield* Console.log("Match deleted successfully.")

  // Verify deletion
  const getResult = yield* MatchAggregate.get({ id: "bgt-2025-test-1" }).pipe(Effect.flip)
  yield* Console.log(`Get after delete: ${getResult._tag}`)
  // #endregion

  // --- Cleanup ---
  yield* Console.log("\nCleaning up...")
  yield* db.tables["cricket-table"]!.delete()
  yield* Console.log("\n=== Done ===")
})

// ---------------------------------------------------------------------------
// 8. Run
// ---------------------------------------------------------------------------

// #region layer
const AppLayer = Layer.merge(
  DynamoClient.layer({
    region: "us-east-1",
    endpoint: "http://localhost:8000",
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  }),
  MainTable.layer({ name: "cricket-table" }),
)

const main = program.pipe(Effect.provide(AppLayer))

Effect.runPromise(main).then(
  () => console.log("\nDone."),
  (err) => console.error("Failed:", err),
)
// #endregion
