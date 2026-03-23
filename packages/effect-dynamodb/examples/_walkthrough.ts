/**
 * Step-by-step walkthrough — run with STEP=1..5 environment variable.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { Console, Effect, Layer, Schema } from "effect"
import * as Aggregate from "../src/Aggregate.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as DynamoModel from "../src/DynamoModel.js"
import * as DynamoSchema from "../src/DynamoSchema.js"
import * as Entity from "../src/Entity.js"
import { fromAttributeMap, toAttributeMap } from "../src/Marshaller.js"
import * as Table from "../src/Table.js"

// ---------------------------------------------------------------------------
// Domain models
// ---------------------------------------------------------------------------

class Team extends Schema.Class<Team>("Team")({
  id: Schema.String.pipe(DynamoModel.identifier),
  name: Schema.String,
  country: Schema.String,
  ranking: Schema.Number,
}) {}

const PlayerRole = {
  Batter: "batter",
  Bowler: "bowler",
  AllRounder: "all-rounder",
  WicketKeeper: "wicket-keeper",
} as const
const PlayerRoleSchema = Schema.Literals(Object.values(PlayerRole))

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

// SquadSelection — a player selected to a team's squad for a series/season.
// This is the "TeamSelection" concept from gamemanager: coach + player
// selections to a team for a competition period.
// squadId encodes team + season + series (e.g., "aus#2024-25#BGT").
class SquadSelection extends Schema.Class<SquadSelection>("SquadSelection")({
  squadId: Schema.String,
  selectionNumber: Schema.Number,
  team: Team.pipe(DynamoModel.ref),
  player: Player.pipe(DynamoModel.ref),
  squadRole: PlayerRoleSchema,
  isCaptain: Schema.Boolean,
  isViceCaptain: Schema.Boolean,
}) {}

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

// ---------------------------------------------------------------------------
// Infrastructure
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

const MainTable = Table.make({
  schema: CricketSchema,
  entities: { Teams, Players, Coaches, Venues, SquadSelections },
})

const TeamSheetAggregate = Aggregate.make(TeamSheet, {
  root: { entityType: "MatchTeam" },
  edges: {
    team: Aggregate.ref(Teams),
    coach: Aggregate.one("coach", { entityType: "MatchCoach", entity: Coaches }),
    players: Aggregate.many("players", { entityType: "MatchPlayer", entity: Players }),
  },
})

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const scanTable = (label: string) =>
  Effect.gen(function* () {
    const client = yield* DynamoClient
    const tableConfig = yield* MainTable.Tag
    const result = yield* client.scan({ TableName: tableConfig.name })
    const items = (result.Items ?? []).map((item) =>
      fromAttributeMap(item as Record<string, AttributeValue>),
    )
    yield* Console.log(`\n${"─".repeat(70)}`)
    yield* Console.log(`  ${label} — ${items.length} item(s) in table`)
    yield* Console.log(`${"─".repeat(70)}`)
    for (const item of items) {
      const et = item.__edd_e__ as string
      const pk = item.pk as string
      const sk = item.sk as string
      const d: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(item)) {
        if (!["pk", "sk", "lsi1sk", "__edd_e__"].includes(k)) d[k] = v
      }
      yield* Console.log(`\n  [${et}]  pk=${pk}`)
      yield* Console.log(`               sk=${sk}`)
      yield* Console.log(`    ${JSON.stringify(d)}`)
    }
    yield* Console.log(`\n${"─".repeat(70)}\n`)
  })

const scanPartition = (label: string, pkValue: string) =>
  Effect.gen(function* () {
    const client = yield* DynamoClient
    const tableConfig = yield* MainTable.Tag
    const result = yield* client.query({
      TableName: tableConfig.name,
      KeyConditionExpression: "#pk = :pk",
      ExpressionAttributeNames: { "#pk": "pk" },
      ExpressionAttributeValues: { ":pk": { S: pkValue } },
    })
    const items = (result.Items ?? []).map((item) =>
      fromAttributeMap(item as Record<string, AttributeValue>),
    )
    yield* Console.log(`\n${"═".repeat(70)}`)
    yield* Console.log(`  ${label} — ${items.length} item(s) in partition`)
    yield* Console.log(`  PK: ${pkValue}`)
    yield* Console.log(`${"═".repeat(70)}`)
    for (const item of items) {
      const et = item.__edd_e__ as string
      const sk = item.sk as string
      const d: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(item)) {
        if (!["pk", "sk", "lsi1sk", "__edd_e__"].includes(k)) d[k] = v
      }
      yield* Console.log(`\n  [${et}]  sk=${sk}`)
      yield* Console.log(`    ${JSON.stringify(d)}`)
    }
    yield* Console.log(`\n${"═".repeat(70)}\n`)
  })

const step = parseInt(process.env.STEP ?? "0", 10)
const matchId = "bgt-2025-test-1"
const pkValue = DynamoSchema.composeCollectionKey(CricketSchema, "match", [matchId])

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

const step0 = Effect.gen(function* () {
  const client = yield* DynamoClient
  const tableConfig = yield* MainTable.Tag
  yield* client
    .deleteTable({ TableName: tableConfig.name })
    .pipe(Effect.catchTag("DynamoError", () => Effect.void))
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
  })
  yield* Console.log("Table created.\n")
})

const step1 = Effect.gen(function* () {
  const db = yield* DynamoClient.make({
    entities: { Teams, Players },
  })

  yield* Console.log("STEP 1: Creating reference entities (Teams + Players)\n")
  yield* Console.log(
    "  Model uses 'id', DB stores as 'teamId'/'playerId' via DynamoModel.configure.\n",
  )
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
  yield* db.entities.Players.put({
    id: "bumrah-01",
    firstName: "Jasprit",
    lastName: "Bumrah",
    role: "bowler",
  })
  yield* scanTable("After Step 1: Teams + Players")
})

const step2 = Effect.gen(function* () {
  const db = yield* DynamoClient.make({
    entities: { SquadSelections },
  })

  yield* Console.log("STEP 2: Creating SquadSelection entries (Entity Refs)\n")
  yield* Console.log("  A SquadSelection picks a player to a team's squad for a series/season.")
  yield* Console.log("  squadId encodes team+season+series (e.g. 'aus#2024-25#BGT').")
  yield* Console.log("  Entity.Input accepts teamId/playerId strings for ref fields.")
  yield* Console.log("  Entity auto-hydrates: fetches full Team + Player, embeds as maps.\n")

  // Australia's squad for BGT 2024-25
  yield* db.entities.SquadSelections.put({
    squadId: "aus#2024-25#BGT",
    selectionNumber: 1,
    teamId: "aus",
    playerId: "cummins-01",
    squadRole: "bowler",
    isCaptain: true,
    isViceCaptain: false,
  })
  yield* db.entities.SquadSelections.put({
    squadId: "aus#2024-25#BGT",
    selectionNumber: 2,
    teamId: "aus",
    playerId: "smith-01",
    squadRole: "batter",
    isCaptain: false,
    isViceCaptain: true,
  })

  // India's squad for BGT 2024-25
  yield* db.entities.SquadSelections.put({
    squadId: "ind#2024-25#BGT",
    selectionNumber: 1,
    teamId: "ind",
    playerId: "bumrah-01",
    squadRole: "bowler",
    isCaptain: true,
    isViceCaptain: false,
  })
  yield* db.entities.SquadSelections.put({
    squadId: "ind#2024-25#BGT",
    selectionNumber: 2,
    teamId: "ind",
    playerId: "kohli-01",
    squadRole: "batter",
    isCaptain: false,
    isViceCaptain: false,
  })

  yield* scanTable("After Step 2: SquadSelections (note embedded team + player maps)")

  yield* Console.log("  Entity.get returns hydrated objects:")
  const sel = yield* db.entities.SquadSelections.get({
    squadId: "aus#2024-25#BGT",
    selectionNumber: 1,
  })
  yield* Console.log(
    `    selection.team   = { id: "${sel.team.id}", name: "${sel.team.name}", country: "${sel.team.country}" }`,
  )
  yield* Console.log(
    `    selection.player = { id: "${sel.player.id}", firstName: "${sel.player.firstName}", lastName: "${sel.player.lastName}" }`,
  )
  yield* Console.log(`    selection.squadRole  = "${sel.squadRole}"`)
  yield* Console.log(`    selection.isCaptain  = ${sel.isCaptain}\n`)
})

const step3 = Effect.gen(function* () {
  const client = yield* DynamoClient
  const tableConfig = yield* MainTable.Tag
  yield* Console.log("STEP 3: Seeding aggregate member items for a Match\n")
  yield* Console.log(`  All items share partition key: ${pkValue}`)
  yield* Console.log("  This is the single-table aggregate collection pattern.\n")

  // Root
  yield* Console.log("  3a. MatchItem (root)...")
  yield* client.putItem({
    TableName: tableConfig.name,
    Item: toAttributeMap({
      pk: pkValue,
      sk: "$cricket#v1#matchitem",
      lsi1sk: "$cricket#v1#match#AUS vs IND",
      __edd_e__: "MatchItem",
      id: matchId,
      name: "AUS vs IND, 1st Test",
    }),
  })

  // Venue
  yield* Console.log("  3b. MatchVenue (one-to-one edge)...")
  yield* client.putItem({
    TableName: tableConfig.name,
    Item: toAttributeMap({
      pk: pkValue,
      sk: "$cricket#v1#matchvenue",
      lsi1sk: "$cricket#v1#matchvenue",
      __edd_e__: "MatchVenue",
      id: "mcg",
      name: "Melbourne Cricket Ground",
      city: "Melbourne",
    }),
  })

  // Team 1
  yield* Console.log("  3c. Team 1 sub-aggregate (teamNumber=1)...")
  yield* client.putItem({
    TableName: tableConfig.name,
    Item: toAttributeMap({
      pk: pkValue,
      sk: "$cricket#v1#matchteam#1",
      lsi1sk: "$cricket#v1#matchteam#1",
      __edd_e__: "MatchTeam",
      team: { id: "aus", name: "Australia", country: "Australia", ranking: 1 },
      homeTeam: true,
      teamNumber: 1,
    }),
  })
  yield* client.putItem({
    TableName: tableConfig.name,
    Item: toAttributeMap({
      pk: pkValue,
      sk: "$cricket#v1#matchcoach#1",
      lsi1sk: "$cricket#v1#matchcoach#1",
      __edd_e__: "MatchCoach",
      id: "mcdonald",
      name: "Andrew McDonald",
      teamNumber: 1,
    }),
  })
  yield* client.putItem({
    TableName: tableConfig.name,
    Item: toAttributeMap({
      pk: pkValue,
      sk: "$cricket#v1#matchplayer#1#cummins-01",
      lsi1sk: "$cricket#v1#matchplayer#1#cummins-01",
      __edd_e__: "MatchPlayer",
      player: {
        id: "cummins-01",
        firstName: "Pat",
        lastName: "Cummins",
        role: "bowler",
      },
      battingPosition: 8,
      isCaptain: true,
      teamNumber: 1,
    }),
  })
  yield* client.putItem({
    TableName: tableConfig.name,
    Item: toAttributeMap({
      pk: pkValue,
      sk: "$cricket#v1#matchplayer#1#smith-01",
      lsi1sk: "$cricket#v1#matchplayer#1#smith-01",
      __edd_e__: "MatchPlayer",
      player: {
        id: "smith-01",
        firstName: "Steve",
        lastName: "Smith",
        role: "batter",
      },
      battingPosition: 4,
      isCaptain: false,
      teamNumber: 1,
    }),
  })

  // Team 2
  yield* Console.log("  3d. Team 2 sub-aggregate (teamNumber=2)...")
  yield* client.putItem({
    TableName: tableConfig.name,
    Item: toAttributeMap({
      pk: pkValue,
      sk: "$cricket#v1#matchteam#2",
      lsi1sk: "$cricket#v1#matchteam#2",
      __edd_e__: "MatchTeam",
      team: { id: "ind", name: "India", country: "India", ranking: 2 },
      homeTeam: false,
      teamNumber: 2,
    }),
  })
  yield* client.putItem({
    TableName: tableConfig.name,
    Item: toAttributeMap({
      pk: pkValue,
      sk: "$cricket#v1#matchcoach#2",
      lsi1sk: "$cricket#v1#matchcoach#2",
      __edd_e__: "MatchCoach",
      id: "gambhir",
      name: "Gautam Gambhir",
      teamNumber: 2,
    }),
  })
  yield* client.putItem({
    TableName: tableConfig.name,
    Item: toAttributeMap({
      pk: pkValue,
      sk: "$cricket#v1#matchplayer#2#kohli-01",
      lsi1sk: "$cricket#v1#matchplayer#2#kohli-01",
      __edd_e__: "MatchPlayer",
      player: {
        id: "kohli-01",
        firstName: "Virat",
        lastName: "Kohli",
        role: "batter",
      },
      battingPosition: 4,
      isCaptain: false,
      teamNumber: 2,
    }),
  })
  yield* client.putItem({
    TableName: tableConfig.name,
    Item: toAttributeMap({
      pk: pkValue,
      sk: "$cricket#v1#matchplayer#2#bumrah-01",
      lsi1sk: "$cricket#v1#matchplayer#2#bumrah-01",
      __edd_e__: "MatchPlayer",
      player: {
        id: "bumrah-01",
        firstName: "Jasprit",
        lastName: "Bumrah",
        role: "bowler",
      },
      battingPosition: 11,
      isCaptain: true,
      teamNumber: 2,
    }),
  })

  yield* Console.log("")
  yield* scanPartition("After Step 3: Complete aggregate partition", pkValue)
})

const step4 = Effect.gen(function* () {
  yield* Console.log('STEP 4: Aggregate.get({ id: "bgt-2025-test-1" })\n')
  yield* Console.log("  1. Query lsi1 index for all items with this PK")
  yield* Console.log("  2. Discriminate by __edd_e__ + teamNumber discriminator")
  yield* Console.log("  3. Assemble leaves-to-root into Match Schema.Class\n")

  const match = yield* MatchAggregate.get({ id: matchId })

  yield* Console.log(`${"═".repeat(70)}`)
  yield* Console.log("  ASSEMBLED: Match domain object")
  yield* Console.log(`${"═".repeat(70)}\n`)
  yield* Console.log(`  match.id    = "${match.id}"`)
  yield* Console.log(`  match.name  = "${match.name}"`)
  yield* Console.log(
    `  match.venue = { id: "${match.venue.id}", name: "${match.venue.name}", city: "${match.venue.city}" }`,
  )
  yield* Console.log("")
  yield* Console.log(
    `  match.team1.team     = { id: "${match.team1.team.id}", name: "${match.team1.team.name}" }`,
  )
  yield* Console.log(`  match.team1.homeTeam = ${match.team1.homeTeam}`)
  yield* Console.log(
    `  match.team1.coach    = { id: "${match.team1.coach.id}", name: "${match.team1.coach.name}" }`,
  )
  yield* Console.log("  match.team1.players  = [")
  for (const ps of match.team1.players) {
    yield* Console.log(
      `    { player: "${ps.player.firstName} ${ps.player.lastName}", pos: ${ps.battingPosition}, captain: ${ps.isCaptain} }`,
    )
  }
  yield* Console.log("  ]")
  yield* Console.log("")
  yield* Console.log(
    `  match.team2.team     = { id: "${match.team2.team.id}", name: "${match.team2.team.name}" }`,
  )
  yield* Console.log(`  match.team2.homeTeam = ${match.team2.homeTeam}`)
  yield* Console.log(
    `  match.team2.coach    = { id: "${match.team2.coach.id}", name: "${match.team2.coach.name}" }`,
  )
  yield* Console.log("  match.team2.players  = [")
  for (const ps of match.team2.players) {
    yield* Console.log(
      `    { player: "${ps.player.firstName} ${ps.player.lastName}", pos: ${ps.battingPosition}, captain: ${ps.isCaptain} }`,
    )
  }
  yield* Console.log("  ]")
  yield* Console.log(`\n  10 DynamoDB items → 1 typed Match object`)
  yield* Console.log(`${"═".repeat(70)}\n`)
})

const step5 = Effect.gen(function* () {
  const client = yield* DynamoClient
  const tableConfig = yield* MainTable.Tag
  yield* Console.log("STEP 5: Cleanup\n")
  yield* client.deleteTable({ TableName: tableConfig.name })
  yield* Console.log("  Table deleted.\n")
})

const steps = [step0, step1, step2, step3, step4, step5]
const program = Effect.gen(function* () {
  for (let i = 0; i <= step; i++) {
    yield* steps[i]!
  }
})

const AppLayer = Layer.merge(
  DynamoClient.layer({
    region: "us-east-1",
    endpoint: "http://localhost:8000",
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  }),
  MainTable.layer({ name: "cricket-walkthrough" }),
)
Effect.runPromise(program.pipe(Effect.provide(AppLayer))).catch((err) =>
  console.error("Failed:", err),
)
