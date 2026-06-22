/**
 * Type-level tests for Aggregate derived input/update/create schemas.
 *
 * Regression coverage for #61: `Aggregate.inputSchema` / `updateSchema` /
 * `createSchema` must preserve the referenced entity's *branded* primary-key
 * identifier type on flattened edge refs (e.g. `venueId: VenueId`), rather than
 * collapsing them to plain `string` — mirroring the standalone Entity ref path
 * (`EntityRefInputType`, exercised in `Entity.types.test.ts`).
 *
 * Uses vitest's `expectTypeOf` to verify compile-time type relationships.
 * These assertions are compile-time only; the runtime schema deliberately
 * builds `Schema.String` for id fields (brands are compile-time phantoms).
 */

import { Schema } from "effect"
import { describe, expectTypeOf, it } from "vitest"
import * as Aggregate from "../src/Aggregate.js"
import * as DynamoModel from "../src/DynamoModel.js"
import * as DynamoSchema from "../src/DynamoSchema.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"

// ---------------------------------------------------------------------------
// Branded identifier types
// ---------------------------------------------------------------------------

const VenueId = Schema.String.pipe(Schema.brand("VenueId"))
type VenueId = typeof VenueId.Type

const TeamId = Schema.String.pipe(Schema.brand("TeamId"))
type TeamId = typeof TeamId.Type

const CoachId = Schema.String.pipe(Schema.brand("CoachId"))
type CoachId = typeof CoachId.Type

const PlayerId = Schema.String.pipe(Schema.brand("PlayerId"))
type PlayerId = typeof PlayerId.Type

// ---------------------------------------------------------------------------
// Domain models — branded primary identifiers
// ---------------------------------------------------------------------------

const PlayerRole = Schema.Literals(["batter", "bowler", "all-rounder", "wicket-keeper"])

class Venue extends Schema.Class<Venue>("Venue")({
  id: VenueId.pipe(DynamoModel.identifier),
  name: Schema.String,
  city: Schema.String,
}) {}

class Team extends Schema.Class<Team>("Team")({
  id: TeamId.pipe(DynamoModel.identifier),
  name: Schema.String,
  country: Schema.String,
}) {}

class Coach extends Schema.Class<Coach>("Coach")({
  id: CoachId.pipe(DynamoModel.identifier),
  name: Schema.String,
}) {}

class Player extends Schema.Class<Player>("Player")({
  id: PlayerId.pipe(DynamoModel.identifier),
  firstName: Schema.String,
  lastName: Schema.String,
  role: PlayerRole,
}) {}

// A value object — NOT a ref. Must be unaffected by the id-flattening.
class Address extends Schema.Class<Address>("Address")({
  line1: Schema.String,
  postcode: Schema.String,
}) {}

// PlayerSheet wraps a ref (`player`) plus relationship-owned fields.
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
  // optional OneEdge ref — exercises the optional branded-id path
  venue: Schema.optional(Venue.pipe(DynamoModel.ref)),
  // plain value object (non-ref) — control
  address: Address,
  // plain enum field (non-ref) — control
  status: Schema.Literals(["scheduled", "live", "complete"]),
  team1: TeamSheet,
  team2: TeamSheet,
}) {}

// ---------------------------------------------------------------------------
// Schema + Entities
// ---------------------------------------------------------------------------

const AppSchema = DynamoSchema.make({ name: "cricket-branded", version: 1 })

const Venues = Entity.make({
  model: DynamoModel.configure(Venue, { id: { field: "venueId", identifier: true } }),
  entityType: "Venue",
  primaryKey: {
    pk: { field: "pk", composite: ["id"] },
    sk: { field: "sk", composite: [] },
  },
})

const Teams = Entity.make({
  model: DynamoModel.configure(Team, { id: { field: "teamId", identifier: true } }),
  entityType: "Team",
  primaryKey: {
    pk: { field: "pk", composite: ["id"] },
    sk: { field: "sk", composite: [] },
  },
})

const Coaches = Entity.make({
  model: DynamoModel.configure(Coach, { id: { field: "coachId", identifier: true } }),
  entityType: "Coach",
  primaryKey: {
    pk: { field: "pk", composite: ["id"] },
    sk: { field: "sk", composite: [] },
  },
})

const Players = Entity.make({
  model: DynamoModel.configure(Player, { id: { field: "playerId", identifier: true } }),
  entityType: "Player",
  primaryKey: {
    pk: { field: "pk", composite: ["id"] },
    sk: { field: "sk", composite: [] },
  },
})

const MainTable = Table.make({
  schema: AppSchema,
  entities: { Venues, Teams, Coaches, Players },
})

// ---------------------------------------------------------------------------
// Aggregate definitions — branded entity edges
// ---------------------------------------------------------------------------

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
  schema: AppSchema,
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
// Tests
// ---------------------------------------------------------------------------

type MatchInput = Aggregate.Input<typeof MatchAggregate>
type MatchUpdate = (typeof MatchAggregate.updateSchema)["Type"]
type MatchCreate = (typeof MatchAggregate.createSchema)["Type"]

// ---------------------------------------------------------------------------
// Hard compile-enforced assertions.
//
// `expectTypeOf().toEqualTypeOf()` is the established idiom here (see
// `Entity.types.test.ts`), but it does not always discriminate a branded
// `string & Brand<...>` from a plain `string`. A direct typed assignment does:
// a plain `string` is NOT assignable to a branded id, so if the fix regresses
// and an edge id collapses back to `string`, each assignment below fails to
// compile. These declarations are type-checked, never executed.
// ---------------------------------------------------------------------------
// Wrapped in a never-called function so the assignments are type-checked but
// never executed (the params are typed, not constructed at runtime).
function _brandAssertions(
  matchInput: MatchInput,
  matchCreate: MatchCreate,
  matchUpdate: MatchUpdate,
): void {
  // inputSchema — optional OneEdge, RefEdge, required OneEdge, ManyEdge element
  const _venueId: VenueId | undefined = matchInput.venueId
  const _teamId: TeamId = matchInput.team1.teamId
  const _coachId: CoachId = matchInput.team1.coachId
  const _playerId: PlayerId = matchInput.team1.players[0]!.playerId
  // createSchema (alias of inputSchema) preserves the brand
  const _cTeamId: TeamId = matchCreate.team1.teamId
  // updateSchema (Partial<inputSchema>) preserves the brand through the partial
  const _uVenueId: VenueId | undefined = matchUpdate.venueId
  const _uPlayerId: PlayerId = matchUpdate.team1!.players[0]!.playerId
  void _venueId
  void _teamId
  void _coachId
  void _playerId
  void _cTeamId
  void _uVenueId
  void _uPlayerId
}
void _brandAssertions

describe("Aggregate derived schemas preserve branded identifier types (#61)", () => {
  it("inputSchema: optional OneEdge ref id is the branded type, not string", () => {
    // `venue` is an optional OneEdge → `venueId?: VenueId`
    expectTypeOf<MatchInput>().toHaveProperty("venueId")
    expectTypeOf<NonNullable<MatchInput["venueId"]>>().toEqualTypeOf<VenueId>()

    // Optional → undefined allowed
    expectTypeOf<MatchInput["venueId"]>().toEqualTypeOf<VenueId | undefined>()

    // The original ref object field is gone
    expectTypeOf<MatchInput>().not.toHaveProperty("venue")
  })

  it("inputSchema: required RefEdge id is the branded type, not string", () => {
    // `team1.team` is a RefEdge → required `teamId: TeamId`
    type Team1 = MatchInput["team1"]
    expectTypeOf<Team1>().toHaveProperty("teamId")
    expectTypeOf<Team1["teamId"]>().toEqualTypeOf<TeamId>()
    expectTypeOf<Team1>().not.toHaveProperty("team")
  })

  it("inputSchema: required OneEdge id is the branded type, not string", () => {
    // `team1.coach` is a OneEdge → required `coachId: CoachId`
    type Team1 = MatchInput["team1"]
    expectTypeOf<Team1>().toHaveProperty("coachId")
    expectTypeOf<Team1["coachId"]>().toEqualTypeOf<CoachId>()
    expectTypeOf<Team1>().not.toHaveProperty("coach")
  })

  it("inputSchema: ManyEdge element ref id (players[].playerId) is the branded type", () => {
    // `team1.players` is a ManyEdge whose element wraps a `player` ref →
    // element gains `playerId: PlayerId`
    type Players = MatchInput["team1"]["players"]
    type PlayerElem = Players[number]
    expectTypeOf<PlayerElem>().toHaveProperty("playerId")
    expectTypeOf<PlayerElem["playerId"]>().toEqualTypeOf<PlayerId>()
    expectTypeOf<PlayerElem>().not.toHaveProperty("player")

    // Relationship-owned (non-ref) element fields are unaffected
    expectTypeOf<PlayerElem["battingPosition"]>().toEqualTypeOf<number>()
    expectTypeOf<PlayerElem["isCaptain"]>().toEqualTypeOf<boolean>()
  })

  it("inputSchema: plain (non-ref) fields are UNAFFECTED", () => {
    // Value object (nested class) passes through intact
    expectTypeOf<MatchInput["address"]>().toMatchTypeOf<{ line1: string; postcode: string }>()
    // Enum literal union passes through intact
    expectTypeOf<MatchInput["status"]>().toEqualTypeOf<"scheduled" | "live" | "complete">()
    // Plain scalar passes through
    expectTypeOf<MatchInput["name"]>().toEqualTypeOf<string>()
  })

  it("createSchema: branded edge ids match inputSchema (alias)", () => {
    expectTypeOf<NonNullable<MatchCreate["venueId"]>>().toEqualTypeOf<VenueId>()
    expectTypeOf<MatchCreate["team1"]["teamId"]>().toEqualTypeOf<TeamId>()
    expectTypeOf<MatchCreate["team1"]["coachId"]>().toEqualTypeOf<CoachId>()
    expectTypeOf<MatchCreate["team1"]["players"][number]["playerId"]>().toEqualTypeOf<PlayerId>()
  })

  it("updateSchema: branded edge ids preserved on the partial payload", () => {
    // `updateSchema` makes top-level fields optional but keeps the branded id types.
    expectTypeOf<NonNullable<MatchUpdate["venueId"]>>().toEqualTypeOf<VenueId>()

    type Team1 = NonNullable<MatchUpdate["team1"]>
    expectTypeOf<Team1["teamId"]>().toEqualTypeOf<TeamId>()
    expectTypeOf<Team1["coachId"]>().toEqualTypeOf<CoachId>()
    expectTypeOf<Team1["players"][number]["playerId"]>().toEqualTypeOf<PlayerId>()
  })
})
