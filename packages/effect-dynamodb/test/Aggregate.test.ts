import { describe, expect, it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import {
  type AggregateAssemblyError,
  type AggregateDecompositionError,
  DynamoError,
  type RefNotFound,
} from "@effect-dynamodb/schema/Errors.js"
import { Effect, Layer, Schema } from "effect"
import { beforeEach, vi } from "vitest"
import * as Aggregate from "../src/Aggregate.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import { toAttributeMap } from "../src/Marshaller.js"
import * as Table from "../src/Table.js"

// ---------------------------------------------------------------------------
// Fixtures: Domain models
// ---------------------------------------------------------------------------

class Venue extends Schema.Class<Venue>("Venue")({
  venueId: Schema.String.pipe(DynamoModel.identifier),
  name: Schema.String,
  city: Schema.String,
}) {}

class Team extends Schema.Class<Team>("Team")({
  teamId: Schema.String.pipe(DynamoModel.identifier),
  name: Schema.String,
  country: Schema.String,
}) {}

class Coach extends Schema.Class<Coach>("Coach")({
  coachId: Schema.String.pipe(DynamoModel.identifier),
  name: Schema.String,
}) {}

class Player extends Schema.Class<Player>("Player")({
  playerId: Schema.String.pipe(DynamoModel.identifier),
  displayName: Schema.String,
  role: Schema.String,
}) {}

// Edge-attributed player sheet (relationship owns battingPosition, isCaptain)
class PlayerSheet extends Schema.Class<PlayerSheet>("PlayerSheet")({
  player: Player,
  battingPosition: Schema.Number,
  isCaptain: Schema.Boolean,
}) {}

// Sub-aggregate domain schema
class TeamSheet extends Schema.Class<TeamSheet>("TeamSheet")({
  team: Team,
  coach: Coach,
  homeTeam: Schema.Boolean,
  players: Schema.Array(PlayerSheet),
}) {}

// Top-level aggregate domain schema
class Match extends Schema.Class<Match>("Match")({
  id: Schema.String,
  name: Schema.String,
  venue: Venue,
  team1: TeamSheet,
  team2: TeamSheet,
}) {}

// Simple flat aggregate (no sub-aggregates)
class Article extends Schema.Class<Article>("Article")({
  articleId: Schema.String,
  title: Schema.String,
  author: Schema.String,
  tags: Schema.Array(Schema.String),
}) {}

// ---------------------------------------------------------------------------
// Fixtures: Schema + Table + Entities
// ---------------------------------------------------------------------------

const AppSchema = DynamoSchema.make({ name: "myapp", version: 1 })

const VenueEntity = Entity.make({
  model: Venue,
  entityType: "Venue",
  primaryKey: {
    pk: { field: "pk", composite: ["venueId"] },
    sk: { field: "sk", composite: [] },
  },
})

const TeamEntity = Entity.make({
  model: Team,
  entityType: "Team",
  primaryKey: {
    pk: { field: "pk", composite: ["teamId"] },
    sk: { field: "sk", composite: [] },
  },
})

const CoachEntity = Entity.make({
  model: Coach,
  entityType: "Coach",
  primaryKey: {
    pk: { field: "pk", composite: ["coachId"] },
    sk: { field: "sk", composite: [] },
  },
})

const PlayerEntity = Entity.make({
  model: Player,
  entityType: "Player",
  primaryKey: {
    pk: { field: "pk", composite: ["playerId"] },
    sk: { field: "sk", composite: [] },
  },
})

const MainTable = Table.make({
  schema: AppSchema,
  entities: { VenueEntity, TeamEntity, CoachEntity, PlayerEntity },
})

// ---------------------------------------------------------------------------
// Mock DynamoClient
// ---------------------------------------------------------------------------

const mockQuery = vi.fn()

const TestDynamoClient = Layer.succeed(DynamoClient, {
  query: (input) =>
    Effect.tryPromise({
      try: () => mockQuery(input),
      catch: (e) => new DynamoError({ operation: "Query", cause: e }),
    }),
  putItem: () => Effect.die("not used"),
  getItem: () => Effect.die("not used"),
  deleteItem: () => Effect.die("not used"),
  updateItem: () => Effect.die("not used"),
  batchGetItem: () => Effect.die("not used"),
  batchWriteItem: () => Effect.die("not used"),
  transactGetItems: () => Effect.die("not used"),
  transactWriteItems: () => Effect.die("not used"),
  createTable: () => Effect.die("not used"),
  deleteTable: () => Effect.die("not used"),
  describeTable: () => Effect.die("not used"),
  scan: () => Effect.die("not used"),
})

const TestTableConfig = MainTable.layer({ name: "test-table" })
const TestLayer = Layer.merge(TestDynamoClient, TestTableConfig)

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Aggregate", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // -------------------------------------------------------------------------
  // Edge builders
  // -------------------------------------------------------------------------

  describe("edge builders", () => {
    it("one() creates a OneEdge", () => {
      const edge = Aggregate.one("venue", { entityType: "MatchVenue" })
      expect(edge._tag).toBe("OneEdge")
      expect(edge.name).toBe("venue")
      expect(edge.entityType).toBe("MatchVenue")
    })

    it("many() creates a ManyEdge", () => {
      const edge = Aggregate.many("players", {
        entityType: "MatchPlayer",
        edgeAttributes: ["battingPosition", "isCaptain"],
      })
      expect(edge._tag).toBe("ManyEdge")
      expect(edge.name).toBe("players")
      expect(edge.entityType).toBe("MatchPlayer")
      expect(edge.edgeAttributes).toEqual(["battingPosition", "isCaptain"])
    })

    it("many() with custom assemble function", () => {
      const assemble = (items: ReadonlyArray<unknown>) => ({ custom: items })
      const edge = Aggregate.many("umpires", {
        entityType: "MatchUmpire",
        assemble,
      })
      expect(edge.assemble).toBe(assemble)
    })

    it("isOneEdge / isManyEdge type guards", () => {
      const oneEdge = Aggregate.one("venue", { entityType: "MatchVenue" })
      const manyEdge = Aggregate.many("players", { entityType: "MatchPlayer" })

      expect(Aggregate.isOneEdge(oneEdge)).toBe(true)
      expect(Aggregate.isManyEdge(oneEdge)).toBe(false)
      expect(Aggregate.isOneEdge(manyEdge)).toBe(false)
      expect(Aggregate.isManyEdge(manyEdge)).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // Sub-aggregate creation
  // -------------------------------------------------------------------------

  describe("make (sub-aggregate form)", () => {
    it("creates a SubAggregate", () => {
      const sub = Aggregate.make(TeamSheet, {
        root: { entityType: "MatchTeam" },
        edges: {
          coach: Aggregate.one("coach", { entityType: "MatchCoach" }),
          players: Aggregate.many("players", { entityType: "MatchPlayer" }),
        },
      })

      expect(sub._tag).toBe("SubAggregate")
      expect(sub.root.entityType).toBe("MatchTeam")
    })

    it(".with() returns a BoundSubAggregate", () => {
      const sub = Aggregate.make(TeamSheet, {
        root: { entityType: "MatchTeam" },
        edges: {
          coach: Aggregate.one("coach", { entityType: "MatchCoach" }),
          players: Aggregate.many("players", { entityType: "MatchPlayer" }),
        },
      })

      const bound = sub.with({ discriminator: { teamNumber: 1 } })
      expect(bound._tag).toBe("BoundSubAggregate")
      expect(bound.discriminator).toEqual({ teamNumber: 1 })
      expect(bound.aggregate).toBe(sub)
    })

    it("same sub-aggregate can be bound with different discriminators", () => {
      const sub = Aggregate.make(TeamSheet, {
        root: { entityType: "MatchTeam" },
        edges: {
          coach: Aggregate.one("coach", { entityType: "MatchCoach" }),
          players: Aggregate.many("players", { entityType: "MatchPlayer" }),
        },
      })

      const team1 = sub.with({ discriminator: { teamNumber: 1 } })
      const team2 = sub.with({ discriminator: { teamNumber: 2 } })

      expect(team1.discriminator).toEqual({ teamNumber: 1 })
      expect(team2.discriminator).toEqual({ teamNumber: 2 })
      expect(team1.aggregate).toBe(team2.aggregate)
    })
  })

  // -------------------------------------------------------------------------
  // Top-level aggregate creation
  // -------------------------------------------------------------------------

  describe("make (top-level form)", () => {
    it("creates an Aggregate with get method", () => {
      const TeamSheetAggregate = Aggregate.make(TeamSheet, {
        root: { entityType: "MatchTeam" },
        edges: {
          team: Aggregate.ref(TeamEntity),
          coach: Aggregate.one("coach", { entityType: "MatchCoach", entity: CoachEntity }),
          players: Aggregate.many("players", { entityType: "MatchPlayer", entity: PlayerEntity }),
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
          venue: Aggregate.one("venue", { entityType: "MatchVenue", entity: VenueEntity }),
          team1: TeamSheetAggregate.with({ discriminator: { teamNumber: 1 } }),
          team2: TeamSheetAggregate.with({ discriminator: { teamNumber: 2 } }),
        },
      })

      expect(MatchAggregate._tag).toBe("Aggregate")
      expect(typeof MatchAggregate.get).toBe("function")
    })
  })

  // -------------------------------------------------------------------------
  // Aggregate.get — flat edges (one + many, no sub-aggregates)
  // -------------------------------------------------------------------------

  describe("get (flat edges)", () => {
    it.effect("assembles one-to-one and one-to-many edges", () =>
      Effect.gen(function* () {
        // Flat aggregate: Article with author (one) and tags stored as separate items
        class BlogPost extends Schema.Class<BlogPost>("BlogPost")({
          postId: Schema.String,
          title: Schema.String,
          author: Schema.Struct({ name: Schema.String, bio: Schema.String }),
          comments: Schema.Array(Schema.Struct({ user: Schema.String, text: Schema.String })),
        }) {}

        const PostAggregate = Aggregate.make(BlogPost, {
          table: MainTable,
          schema: AppSchema,
          pk: { field: "pk", composite: ["postId"] },
          collection: {
            index: "lsi1",
            name: "post",
            sk: { field: "lsi1sk", composite: [] },
          },
          root: { entityType: "PostItem" },
          edges: {
            author: Aggregate.one("author", { entityType: "PostAuthor" }),
            comments: Aggregate.many("comments", { entityType: "PostComment" }),
          },
        })

        mockQuery.mockResolvedValueOnce({
          Items: [
            toAttributeMap({
              postId: "post-1",
              title: "Hello World",
              pk: "$myapp#v1#post#post-1",
              lsi1sk: "$myapp#v1#post",
              __edd_e__: "PostItem",
            }),
            toAttributeMap({
              name: "Alice",
              bio: "Writer",
              pk: "$myapp#v1#post#post-1",
              lsi1sk: "$myapp#v1#postauthor",
              __edd_e__: "PostAuthor",
            }),
            toAttributeMap({
              user: "Bob",
              text: "Great post!",
              pk: "$myapp#v1#post#post-1",
              lsi1sk: "$myapp#v1#postcomment#1",
              __edd_e__: "PostComment",
            }),
            toAttributeMap({
              user: "Charlie",
              text: "Interesting read",
              pk: "$myapp#v1#post#post-1",
              lsi1sk: "$myapp#v1#postcomment#2",
              __edd_e__: "PostComment",
            }),
          ],
          LastEvaluatedKey: undefined,
        })

        const result = yield* PostAggregate.get({ postId: "post-1" })

        expect(result.postId).toBe("post-1")
        expect(result.title).toBe("Hello World")
        expect(result.author.name).toBe("Alice")
        expect(result.author.bio).toBe("Writer")
        expect(result.comments).toHaveLength(2)
        expect(result.comments[0]!.user).toBe("Bob")
        expect(result.comments[1]!.user).toBe("Charlie")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("paginates through multiple pages", () =>
      Effect.gen(function* () {
        class SimpleAgg extends Schema.Class<SimpleAgg>("SimpleAgg")({
          id: Schema.String,
          title: Schema.String,
          items: Schema.Array(Schema.Struct({ value: Schema.Number })),
        }) {}

        const agg = Aggregate.make(SimpleAgg, {
          table: MainTable,
          schema: AppSchema,
          pk: { field: "pk", composite: ["id"] },
          collection: {
            index: "lsi1",
            name: "simple",
            sk: { field: "lsi1sk", composite: [] },
          },
          root: { entityType: "SimpleRoot" },
          edges: {
            items: Aggregate.many("items", { entityType: "SimpleItem" }),
          },
        })

        // Page 1
        mockQuery.mockResolvedValueOnce({
          Items: [
            toAttributeMap({
              id: "s-1",
              title: "Test",
              pk: "$myapp#v1#simple#s-1",
              lsi1sk: "$myapp#v1#simpleroot",
              __edd_e__: "SimpleRoot",
            }),
            toAttributeMap({
              value: 1,
              pk: "$myapp#v1#simple#s-1",
              lsi1sk: "$myapp#v1#simpleitem#1",
              __edd_e__: "SimpleItem",
            }),
          ],
          LastEvaluatedKey: toAttributeMap({ pk: "x", sk: "y" }),
        })

        // Page 2
        mockQuery.mockResolvedValueOnce({
          Items: [
            toAttributeMap({
              value: 2,
              pk: "$myapp#v1#simple#s-1",
              lsi1sk: "$myapp#v1#simpleitem#2",
              __edd_e__: "SimpleItem",
            }),
          ],
          LastEvaluatedKey: undefined,
        })

        const result = yield* agg.get({ id: "s-1" })
        expect(result.items).toHaveLength(2)
        expect(result.items[0]!.value).toBe(1)
        expect(result.items[1]!.value).toBe(2)
        expect(mockQuery).toHaveBeenCalledTimes(2)
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  // -------------------------------------------------------------------------
  // Aggregate.get — with sub-aggregates and discriminators
  // -------------------------------------------------------------------------

  describe("get (sub-aggregates)", () => {
    const TeamSheetAggregate = Aggregate.make(TeamSheet, {
      root: { entityType: "MatchTeam" },
      edges: {
        team: Aggregate.ref(TeamEntity),
        coach: Aggregate.one("coach", { entityType: "MatchCoach", entity: CoachEntity }),
        players: Aggregate.many("players", { entityType: "MatchPlayer", entity: PlayerEntity }),
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
        venue: Aggregate.one("venue", { entityType: "MatchVenue", entity: VenueEntity }),
        team1: TeamSheetAggregate.with({ discriminator: { teamNumber: 1 } }),
        team2: TeamSheetAggregate.with({ discriminator: { teamNumber: 2 } }),
      },
    })

    it.effect("assembles a multi-level aggregate with discriminators", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValueOnce({
          Items: [
            // Root item
            toAttributeMap({
              id: "match-1",
              name: "AUS vs IND",
              pk: "$myapp#v1#match#match-1",
              lsi1sk: "$myapp#v1#match#AUS vs IND",
              __edd_e__: "MatchItem",
            }),
            // Venue
            toAttributeMap({
              venueId: "v-1",
              name: "MCG",
              city: "Melbourne",
              pk: "$myapp#v1#match#match-1",
              lsi1sk: "$myapp#v1#matchvenue",
              __edd_e__: "MatchVenue",
            }),
            // Team 1 root — team is a ref stored as embedded map
            toAttributeMap({
              team: { teamId: "t-aus", name: "Australia", country: "Australia" },
              homeTeam: true,
              teamNumber: 1,
              pk: "$myapp#v1#match#match-1",
              lsi1sk: "$myapp#v1#matchteam#teamNumber#1",
              __edd_e__: "MatchTeam",
            }),
            // Team 1 coach — coach data maps to Coach schema
            toAttributeMap({
              coachId: "c-1",
              name: "Andrew McDonald",
              teamNumber: 1,
              pk: "$myapp#v1#match#match-1",
              lsi1sk: "$myapp#v1#matchcoach#teamNumber#1",
              __edd_e__: "MatchCoach",
            }),
            // Team 1 players — player is a ref stored as embedded map
            toAttributeMap({
              player: { playerId: "p-smith", displayName: "Steve Smith", role: "batter" },
              battingPosition: 1,
              isCaptain: false,
              teamNumber: 1,
              pk: "$myapp#v1#match#match-1",
              lsi1sk: "$myapp#v1#matchplayer#teamNumber#1#p-smith",
              __edd_e__: "MatchPlayer",
            }),
            toAttributeMap({
              player: { playerId: "p-cummins", displayName: "Pat Cummins", role: "bowler" },
              battingPosition: 2,
              isCaptain: true,
              teamNumber: 1,
              pk: "$myapp#v1#match#match-1",
              lsi1sk: "$myapp#v1#matchplayer#teamNumber#1#p-cummins",
              __edd_e__: "MatchPlayer",
            }),
            // Team 2 root
            toAttributeMap({
              team: { teamId: "t-ind", name: "India", country: "India" },
              homeTeam: false,
              teamNumber: 2,
              pk: "$myapp#v1#match#match-1",
              lsi1sk: "$myapp#v1#matchteam#teamNumber#2",
              __edd_e__: "MatchTeam",
            }),
            // Team 2 coach
            toAttributeMap({
              coachId: "c-2",
              name: "Gautam Gambhir",
              teamNumber: 2,
              pk: "$myapp#v1#match#match-1",
              lsi1sk: "$myapp#v1#matchcoach#teamNumber#2",
              __edd_e__: "MatchCoach",
            }),
            // Team 2 player
            toAttributeMap({
              player: { playerId: "p-kohli", displayName: "Virat Kohli", role: "batter" },
              battingPosition: 1,
              isCaptain: true,
              teamNumber: 2,
              pk: "$myapp#v1#match#match-1",
              lsi1sk: "$myapp#v1#matchplayer#teamNumber#2#p-kohli",
              __edd_e__: "MatchPlayer",
            }),
          ],
          LastEvaluatedKey: undefined,
        })

        const result = yield* MatchAggregate.get({ id: "match-1" })

        // Root fields
        expect(result.id).toBe("match-1")
        expect(result.name).toBe("AUS vs IND")

        // Venue (one edge — ref stored as embedded map)
        expect(result.venue.venueId).toBe("v-1")
        expect(result.venue.name).toBe("MCG")
        expect(result.venue.city).toBe("Melbourne")

        // Team 1 (sub-aggregate, discriminator teamNumber=1)
        expect(result.team1.team.teamId).toBe("t-aus")
        expect(result.team1.team.name).toBe("Australia")
        expect(result.team1.homeTeam).toBe(true)
        expect(result.team1.coach.coachId).toBe("c-1")
        expect(result.team1.coach.name).toBe("Andrew McDonald")
        expect(result.team1.players).toHaveLength(2)
        expect(result.team1.players[0]!.player.displayName).toBe("Steve Smith")
        expect(result.team1.players[0]!.battingPosition).toBe(1)
        expect(result.team1.players[1]!.isCaptain).toBe(true)

        // Team 2 (sub-aggregate, discriminator teamNumber=2)
        expect(result.team2.team.teamId).toBe("t-ind")
        expect(result.team2.team.name).toBe("India")
        expect(result.team2.homeTeam).toBe(false)
        expect(result.team2.coach.coachId).toBe("c-2")
        expect(result.team2.coach.name).toBe("Gautam Gambhir")
        expect(result.team2.players).toHaveLength(1)
        expect(result.team2.players[0]!.player.displayName).toBe("Virat Kohli")
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  // -------------------------------------------------------------------------
  // Aggregate.get — custom assemble function on many edge
  // -------------------------------------------------------------------------

  describe("get (custom assemble)", () => {
    it.effect("uses custom assemble function for many edge", () =>
      Effect.gen(function* () {
        class UmpirePanel extends Schema.Class<UmpirePanel>("UmpirePanel")({
          matchReferee: Schema.String,
          matchUmpires: Schema.Array(Schema.String),
        }) {}

        class MatchWithUmpires extends Schema.Class<MatchWithUmpires>("MatchWithUmpires")({
          id: Schema.String,
          name: Schema.String,
          umpires: UmpirePanel,
        }) {}

        const agg = Aggregate.make(MatchWithUmpires, {
          table: MainTable,
          schema: AppSchema,
          pk: { field: "pk", composite: ["id"] },
          collection: {
            index: "lsi1",
            name: "matchumpire",
            sk: { field: "lsi1sk", composite: [] },
          },
          root: { entityType: "MatchRoot" },
          edges: {
            umpires: Aggregate.many("umpires", {
              entityType: "MatchUmpire",
              assemble: (items) => ({
                matchReferee: (items as Array<{ umpireName: string; role: string }>).find(
                  (i) => i.role === "referee",
                )?.umpireName,
                matchUmpires: (items as Array<{ umpireName: string; role: string }>)
                  .filter((i) => i.role === "umpire")
                  .map((i) => i.umpireName),
              }),
            }),
          },
        })

        mockQuery.mockResolvedValueOnce({
          Items: [
            toAttributeMap({
              id: "m-1",
              name: "Test Match",
              pk: "$myapp#v1#matchumpire#m-1",
              lsi1sk: "$myapp#v1#matchroot",
              __edd_e__: "MatchRoot",
            }),
            toAttributeMap({
              umpireName: "Ravi",
              role: "referee",
              pk: "$myapp#v1#matchumpire#m-1",
              lsi1sk: "$myapp#v1#matchumpire#1",
              __edd_e__: "MatchUmpire",
            }),
            toAttributeMap({
              umpireName: "Tucker",
              role: "umpire",
              pk: "$myapp#v1#matchumpire#m-1",
              lsi1sk: "$myapp#v1#matchumpire#2",
              __edd_e__: "MatchUmpire",
            }),
            toAttributeMap({
              umpireName: "Erasmus",
              role: "umpire",
              pk: "$myapp#v1#matchumpire#m-1",
              lsi1sk: "$myapp#v1#matchumpire#3",
              __edd_e__: "MatchUmpire",
            }),
          ],
          LastEvaluatedKey: undefined,
        })

        const result = yield* agg.get({ id: "m-1" })

        expect(result.umpires.matchReferee).toBe("Ravi")
        expect(result.umpires.matchUmpires).toEqual(["Tucker", "Erasmus"])
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  // -------------------------------------------------------------------------
  // OneEdge with discriminator
  // -------------------------------------------------------------------------

  describe("get (OneEdge with discriminator)", () => {
    class Umpire extends Schema.Class<Umpire>("Umpire")({
      umpireId: Schema.String.pipe(DynamoModel.identifier),
      name: Schema.String,
    }) {}

    const UmpireEntity = Entity.make({
      model: Umpire,
      entityType: "Umpire",
      primaryKey: {
        pk: { field: "pk", composite: ["umpireId"] },
        sk: { field: "sk", composite: [] },
      },
    })
    UmpireEntity._configure(AppSchema, MainTable.Tag)

    class UmpireSheet extends Schema.Class<UmpireSheet>("UmpireSheet")({
      matchReferee: Schema.optionalKey(Umpire),
      tvUmpire: Schema.optionalKey(Umpire),
    }) {}

    class MatchWithDiscUmpires extends Schema.Class<MatchWithDiscUmpires>("MatchWithDiscUmpires")({
      id: Schema.String,
      name: Schema.String,
      umpires: UmpireSheet,
    }) {}

    const UmpireSheetAggregate = Aggregate.make(UmpireSheet, {
      root: { entityType: "MatchUmpires" },
      edges: {
        matchReferee: Aggregate.one("matchReferee", {
          entity: UmpireEntity,
          entityType: "MatchUmpire",
          discriminator: { role: "referee" },
        }),
        tvUmpire: Aggregate.one("tvUmpire", {
          entity: UmpireEntity,
          entityType: "MatchUmpire",
          discriminator: { role: "tvUmpire" },
        }),
      },
    })

    const MatchDiscAggregate = Aggregate.make(MatchWithDiscUmpires, {
      table: MainTable,
      schema: AppSchema,
      pk: { field: "pk", composite: ["id"] },
      collection: {
        index: "lsi1",
        name: "matchdisc",
        sk: { field: "lsi1sk", composite: [] },
      },
      root: { entityType: "MatchItem" },
      edges: {
        umpires: UmpireSheetAggregate.with({ discriminator: {} }),
      },
    })

    it.effect("assembles OneEdge items with discriminator matching", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValueOnce({
          Items: [
            // Root item
            toAttributeMap({
              id: "m-1",
              name: "Test Match",
              pk: "$myapp#v1#matchdisc#m-1",
              lsi1sk: "$myapp#v1#matchitem",
              __edd_e__: "MatchItem",
            }),
            // Umpire sub-aggregate root
            toAttributeMap({
              pk: "$myapp#v1#matchdisc#m-1",
              lsi1sk: "$myapp#v1#matchumpires",
              __edd_e__: "MatchUmpires",
            }),
            // Match referee (OneEdge with discriminator role=referee)
            toAttributeMap({
              umpireId: "u-1",
              name: "Ravi",
              role: "referee",
              pk: "$myapp#v1#matchdisc#m-1",
              lsi1sk: "$myapp#v1#matchumpire#role#referee",
              __edd_e__: "MatchUmpire",
            }),
            // TV umpire (OneEdge with discriminator role=tvUmpire)
            toAttributeMap({
              umpireId: "u-2",
              name: "Tucker",
              role: "tvUmpire",
              pk: "$myapp#v1#matchdisc#m-1",
              lsi1sk: "$myapp#v1#matchumpire#role#tvUmpire",
              __edd_e__: "MatchUmpire",
            }),
          ],
          LastEvaluatedKey: undefined,
        })

        const result = yield* MatchDiscAggregate.get({ id: "m-1" })

        expect(result.id).toBe("m-1")
        expect(result.name).toBe("Test Match")
        // Both umpire roles assembled correctly via discriminator matching
        expect(result.umpires.matchReferee?.name).toBe("Ravi")
        expect(result.umpires.tvUmpire?.name).toBe("Tucker")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("same entityType with different discriminators assembles correctly", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValueOnce({
          Items: [
            toAttributeMap({
              id: "m-2",
              name: "Another Match",
              pk: "$myapp#v1#matchdisc#m-2",
              lsi1sk: "$myapp#v1#matchitem",
              __edd_e__: "MatchItem",
            }),
            toAttributeMap({
              pk: "$myapp#v1#matchdisc#m-2",
              lsi1sk: "$myapp#v1#matchumpires",
              __edd_e__: "MatchUmpires",
            }),
            // Only referee, no tvUmpire — tvUmpire should be omitted (optional)
            toAttributeMap({
              umpireId: "u-3",
              name: "Erasmus",
              role: "referee",
              pk: "$myapp#v1#matchdisc#m-2",
              lsi1sk: "$myapp#v1#matchumpire#role#referee",
              __edd_e__: "MatchUmpire",
            }),
          ],
          LastEvaluatedKey: undefined,
        })

        const result = yield* MatchDiscAggregate.get({ id: "m-2" })

        expect(result.umpires.matchReferee?.name).toBe("Erasmus")
        // tvUmpire should be undefined since no matching item exists
        expect(result.umpires.tvUmpire).toBeUndefined()
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  // -------------------------------------------------------------------------
  // Error paths
  // -------------------------------------------------------------------------

  describe("error paths", () => {
    const SimpleAggregate = Aggregate.make(Article, {
      table: MainTable,
      schema: AppSchema,
      pk: { field: "pk", composite: ["articleId"] },
      collection: {
        index: "lsi1",
        name: "article",
        sk: { field: "lsi1sk", composite: [] },
      },
      root: { entityType: "ArticleItem" },
      edges: {},
    })

    it.effect("fails with AggregateAssemblyError when no items found", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValueOnce({
          Items: [],
          LastEvaluatedKey: undefined,
        })

        const error = yield* SimpleAggregate.get({ articleId: "missing" }).pipe(Effect.flip)
        expect(error._tag).toBe("AggregateAssemblyError")
        expect((error as AggregateAssemblyError).reason).toContain("No items found")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("fails with AggregateAssemblyError when root item is missing", () =>
      Effect.gen(function* () {
        // Items present but none with the root entity type
        mockQuery.mockResolvedValueOnce({
          Items: [
            toAttributeMap({
              value: "something",
              pk: "$myapp#v1#article#a-1",
              lsi1sk: "$myapp#v1#other",
              __edd_e__: "OtherType",
            }),
          ],
          LastEvaluatedKey: undefined,
        })

        const error = yield* SimpleAggregate.get({ articleId: "a-1" }).pipe(Effect.flip)
        expect(error._tag).toBe("AggregateAssemblyError")
        expect((error as AggregateAssemblyError).reason).toBe("Missing root item")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("fails with AggregateAssemblyError when multiple root items found", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValueOnce({
          Items: [
            toAttributeMap({
              articleId: "a-1",
              title: "First",
              author: "Alice",
              pk: "$myapp#v1#article#a-1",
              lsi1sk: "$myapp#v1#articleitem#1",
              __edd_e__: "ArticleItem",
            }),
            toAttributeMap({
              articleId: "a-1",
              title: "Duplicate",
              author: "Bob",
              pk: "$myapp#v1#article#a-1",
              lsi1sk: "$myapp#v1#articleitem#2",
              __edd_e__: "ArticleItem",
            }),
          ],
          LastEvaluatedKey: undefined,
        })

        const error = yield* SimpleAggregate.get({ articleId: "a-1" }).pipe(Effect.flip)
        expect(error._tag).toBe("AggregateAssemblyError")
        expect((error as AggregateAssemblyError).reason).toBe("Multiple root items found")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("fails when one-to-one edge item is missing", () =>
      Effect.gen(function* () {
        class WithOneEdge extends Schema.Class<WithOneEdge>("WithOneEdge")({
          id: Schema.String,
          detail: Schema.Struct({ info: Schema.String }),
        }) {}

        const agg = Aggregate.make(WithOneEdge, {
          table: MainTable,
          schema: AppSchema,
          pk: { field: "pk", composite: ["id"] },
          collection: {
            index: "lsi1",
            name: "withone",
            sk: { field: "lsi1sk", composite: [] },
          },
          root: { entityType: "WithOneRoot" },
          edges: {
            detail: Aggregate.one("detail", { entityType: "WithOneDetail" }),
          },
        })

        mockQuery.mockResolvedValueOnce({
          Items: [
            // Root present but detail edge missing
            toAttributeMap({
              id: "w-1",
              pk: "$myapp#v1#withone#w-1",
              lsi1sk: "$myapp#v1#withoneroot",
              __edd_e__: "WithOneRoot",
            }),
          ],
          LastEvaluatedKey: undefined,
        })

        const error = yield* agg.get({ id: "w-1" }).pipe(Effect.flip)
        // Required one-to-one edge missing → Schema decode fails with ValidationError
        expect(error._tag).toBe("ValidationError")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("propagates DynamoError from query failure", () =>
      Effect.gen(function* () {
        mockQuery.mockRejectedValueOnce(new Error("Connection failed"))

        const error = yield* SimpleAggregate.get({ articleId: "a-1" }).pipe(Effect.flip)
        expect(error._tag).toBe("DynamoError")
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  // -------------------------------------------------------------------------
  // Aggregate.get — root-only (no edges)
  // -------------------------------------------------------------------------

  describe("get (root only, no edges)", () => {
    it.effect("assembles aggregate with only root fields", () =>
      Effect.gen(function* () {
        const SimpleAggregate = Aggregate.make(Article, {
          table: MainTable,
          schema: AppSchema,
          pk: { field: "pk", composite: ["articleId"] },
          collection: {
            index: "lsi1",
            name: "article",
            sk: { field: "lsi1sk", composite: [] },
          },
          root: { entityType: "ArticleItem" },
          edges: {},
        })

        mockQuery.mockResolvedValueOnce({
          Items: [
            toAttributeMap({
              articleId: "a-1",
              title: "My Article",
              author: "Alice",
              tags: ["typescript", "effect"],
              pk: "$myapp#v1#article#a-1",
              lsi1sk: "$myapp#v1#articleitem",
              __edd_e__: "ArticleItem",
            }),
          ],
          LastEvaluatedKey: undefined,
        })

        const result = yield* SimpleAggregate.get({ articleId: "a-1" })

        expect(result.articleId).toBe("a-1")
        expect(result.title).toBe("My Article")
        expect(result.author).toBe("Alice")
        expect(result.tags).toEqual(["typescript", "effect"])
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  // -------------------------------------------------------------------------
  // Aggregate.get — empty many edge
  // -------------------------------------------------------------------------

  describe("get (empty many edge)", () => {
    it.effect("returns empty array for many edge with no items", () =>
      Effect.gen(function* () {
        class WithMany extends Schema.Class<WithMany>("WithMany")({
          id: Schema.String,
          items: Schema.Array(Schema.Struct({ value: Schema.Number })),
        }) {}

        const agg = Aggregate.make(WithMany, {
          table: MainTable,
          schema: AppSchema,
          pk: { field: "pk", composite: ["id"] },
          collection: {
            index: "lsi1",
            name: "withmany",
            sk: { field: "lsi1sk", composite: [] },
          },
          root: { entityType: "WithManyRoot" },
          edges: {
            items: Aggregate.many("items", { entityType: "WithManyItem" }),
          },
        })

        mockQuery.mockResolvedValueOnce({
          Items: [
            toAttributeMap({
              id: "w-1",
              pk: "$myapp#v1#withmany#w-1",
              lsi1sk: "$myapp#v1#withmanyroot",
              __edd_e__: "WithManyRoot",
            }),
          ],
          LastEvaluatedKey: undefined,
        })

        const result = yield* agg.get({ id: "w-1" })
        expect(result.items).toEqual([])
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  // -------------------------------------------------------------------------
  // DynamoDB query params verification
  // -------------------------------------------------------------------------

  describe("query params", () => {
    it.effect("sends correct PK and index to DynamoDB", () =>
      Effect.gen(function* () {
        const SimpleAggregate = Aggregate.make(Article, {
          table: MainTable,
          schema: AppSchema,
          pk: { field: "pk", composite: ["articleId"] },
          collection: {
            index: "lsi1",
            name: "article",
            sk: { field: "lsi1sk", composite: [] },
          },
          root: { entityType: "ArticleItem" },
          edges: {},
        })

        mockQuery.mockResolvedValueOnce({
          Items: [
            toAttributeMap({
              articleId: "a-1",
              title: "Test",
              author: "Author",
              tags: [],
              pk: "$myapp#v1#article#a-1",
              lsi1sk: "$myapp#v1#articleitem",
              __edd_e__: "ArticleItem",
            }),
          ],
          LastEvaluatedKey: undefined,
        })

        yield* SimpleAggregate.get({ articleId: "a-1" })

        // Verify the query was called with correct parameters
        expect(mockQuery).toHaveBeenCalledTimes(1)
        const queryInput = mockQuery.mock.calls[0]![0]
        expect(queryInput.TableName).toBe("test-table")
        expect(queryInput.IndexName).toBe("lsi1")
        expect(queryInput.KeyConditionExpression).toBe("#pk = :pk")
        expect(queryInput.ExpressionAttributeNames).toEqual({ "#pk": "pk" })
        // PK value should contain the collection key format
        expect(queryInput.ExpressionAttributeValues[":pk"]).toBeDefined()
      }).pipe(Effect.provide(TestLayer)),
    )
  })
})

// ===========================================================================
// Write Path Tests
// ===========================================================================

describe("Aggregate write path", () => {
  // -------------------------------------------------------------------------
  // Write path fixtures & mocks
  // -------------------------------------------------------------------------

  const mockWriteQuery = vi.fn()
  const mockTransactWrite = vi.fn()
  const mockBatchWrite = vi.fn()
  const mockGetItem = vi.fn()
  const mockBatchGetItem = vi.fn()

  const WriteDynamoClient = Layer.succeed(DynamoClient, {
    query: (input) =>
      Effect.tryPromise({
        try: () => mockWriteQuery(input),
        catch: (e) => new DynamoError({ operation: "Query", cause: e }),
      }),
    getItem: (input) =>
      Effect.tryPromise({
        try: () => mockGetItem(input),
        catch: (e) => new DynamoError({ operation: "GetItem", cause: e }),
      }),
    transactWriteItems: (input) =>
      Effect.tryPromise({
        try: () => mockTransactWrite(input),
        catch: (e) => new DynamoError({ operation: "TransactWriteItems", cause: e }),
      }),
    batchWriteItem: (input) =>
      Effect.tryPromise({
        try: () => mockBatchWrite(input),
        catch: (e) => new DynamoError({ operation: "BatchWriteItem", cause: e }),
      }),
    putItem: () => Effect.die("not used"),
    deleteItem: () => Effect.die("not used"),
    updateItem: () => Effect.die("not used"),
    batchGetItem: (input) =>
      Effect.tryPromise({
        try: () => mockBatchGetItem(input),
        catch: (e) => new DynamoError({ operation: "BatchGetItem", cause: e }),
      }),
    transactGetItems: () => Effect.die("not used"),
    createTable: () => Effect.die("not used"),
    deleteTable: () => Effect.die("not used"),
    describeTable: () => Effect.die("not used"),
    scan: () => Effect.die("not used"),
  })

  const WriteTableConfig = MainTable.layer({ name: "test-table" })
  const WriteLayer = Layer.merge(WriteDynamoClient, WriteTableConfig)

  beforeEach(() => {
    mockWriteQuery.mockReset()
    mockTransactWrite.mockReset()
    mockBatchWrite.mockReset()
    mockGetItem.mockReset()
    mockBatchGetItem.mockReset()
  })

  // -------------------------------------------------------------------------
  // Flat aggregate: Article (no refs, no sub-aggregates)
  // -------------------------------------------------------------------------

  describe("create (flat, no refs)", () => {
    const ArticleAggregate = Aggregate.make(Article, {
      table: MainTable,
      schema: AppSchema,
      pk: { field: "pk", composite: ["articleId"] },
      collection: {
        index: "lsi1",
        name: "article",
        sk: { field: "lsi1sk", composite: [] },
      },
      root: { entityType: "ArticleItem" },
      edges: {},
    })

    it.effect("creates a flat aggregate with correct items", () =>
      Effect.gen(function* () {
        mockTransactWrite.mockResolvedValueOnce({})

        const result = yield* ArticleAggregate.create({
          articleId: "a-1",
          title: "Hello World",
          author: "Alice",
          tags: ["ts", "effect"],
        })

        expect(result.articleId).toBe("a-1")
        expect(result.title).toBe("Hello World")
        expect(result.tags).toEqual(["ts", "effect"])

        // Verify transactWriteItems was called with one Put item
        expect(mockTransactWrite).toHaveBeenCalledTimes(1)
        const call = mockTransactWrite.mock.calls[0]![0]
        expect(call.TransactItems).toHaveLength(1)
        expect(call.TransactItems[0].Put).toBeDefined()
        expect(call.TransactItems[0].Put.TableName).toBe("test-table")
      }).pipe(Effect.provide(WriteLayer)),
    )
  })

  // -------------------------------------------------------------------------
  // Non-context Date fields round-trip (create + get)
  // -------------------------------------------------------------------------

  describe("non-context Date field round-trip", () => {
    class Event extends Schema.Class<Event>("Event")({
      eventId: Schema.String,
      name: Schema.String,
      startDate: Schema.Date,
      finishDate: Schema.optional(Schema.Date),
    }) {}

    const EventAggregate = Aggregate.make(Event, {
      table: MainTable,
      schema: AppSchema,
      pk: { field: "pk", composite: ["eventId"] },
      collection: {
        index: "lsi1",
        name: "event",
        sk: { field: "lsi1sk", composite: [] },
      },
      root: { entityType: "EventItem" },
      context: ["startDate"],
      edges: {},
    })

    it.effect("create with finishDate set → get → Date survives round-trip", () =>
      Effect.gen(function* () {
        // Capture what gets written to DynamoDB
        let writtenItems: Array<Record<string, unknown>> = []
        mockTransactWrite.mockImplementation((input: Record<string, unknown>) => {
          const items = (input as any).TransactItems as Array<Record<string, unknown>>
          writtenItems = items
          return Promise.resolve({})
        })

        yield* EventAggregate.create({
          eventId: "e-1",
          name: "Grand Final",
          startDate: new Date("2025-06-15T00:00:00.000Z"),
          finishDate: new Date("2025-06-16T00:00:00.000Z"),
        })

        // Verify finishDate was serialized as a string (not left as Date object)
        const putItem = (writtenItems[0] as any)?.Put?.Item
        expect(putItem).toBeDefined()

        // Now simulate get: return what DynamoDB would have stored
        // The written item should have finishDate as a string (from serialization)
        // and startDate as a string (context field serialization)
        mockWriteQuery.mockResolvedValueOnce({
          Items: [
            toAttributeMap({
              pk: "$myapp#v1#event#e-1",
              sk: "$myapp#v1#eventitem",
              lsi1sk: "$myapp#v1#event",
              __edd_e__: "EventItem",
              eventId: "e-1",
              name: "Grand Final",
              startDate: "2025-06-15T00:00:00.000Z",
              finishDate: "2025-06-16T00:00:00.000Z",
            }),
          ],
          LastEvaluatedKey: undefined,
        })

        const result = yield* EventAggregate.get({ eventId: "e-1" })
        expect(result.name).toBe("Grand Final")
        expect(result.startDate).toBeInstanceOf(Date)
        expect(result.startDate.toISOString()).toBe("2025-06-15T00:00:00.000Z")
        expect(result.finishDate).toBeInstanceOf(Date)
        expect((result.finishDate as Date).toISOString()).toBe("2025-06-16T00:00:00.000Z")
      }).pipe(Effect.provide(WriteLayer)),
    )

    it.effect("create without finishDate → get → undefined survives round-trip", () =>
      Effect.gen(function* () {
        mockTransactWrite.mockResolvedValueOnce({})

        yield* EventAggregate.create({
          eventId: "e-2",
          name: "Qualifier",
          startDate: new Date("2025-01-01T00:00:00.000Z"),
        })

        // Simulate get: finishDate is absent from DynamoDB item
        mockWriteQuery.mockResolvedValueOnce({
          Items: [
            toAttributeMap({
              pk: "$myapp#v1#event#e-2",
              sk: "$myapp#v1#eventitem",
              lsi1sk: "$myapp#v1#event",
              __edd_e__: "EventItem",
              eventId: "e-2",
              name: "Qualifier",
              startDate: "2025-01-01T00:00:00.000Z",
            }),
          ],
          LastEvaluatedKey: undefined,
        })

        const result = yield* EventAggregate.get({ eventId: "e-2" })
        expect(result.name).toBe("Qualifier")
        expect(result.startDate).toBeInstanceOf(Date)
        expect(result.finishDate).toBeUndefined()
      }).pipe(Effect.provide(WriteLayer)),
    )
  })

  // -------------------------------------------------------------------------
  // Aggregate with one-to-one + one-to-many edges (no refs)
  // -------------------------------------------------------------------------

  describe("create (edges, no refs)", () => {
    class BlogPost extends Schema.Class<BlogPost>("BlogPost")({
      postId: Schema.String,
      title: Schema.String,
      author: Schema.Struct({ name: Schema.String, bio: Schema.String }),
      comments: Schema.Array(Schema.Struct({ user: Schema.String, text: Schema.String })),
    }) {}

    const PostAggregate = Aggregate.make(BlogPost, {
      table: MainTable,
      schema: AppSchema,
      pk: { field: "pk", composite: ["postId"] },
      collection: {
        index: "lsi1",
        name: "post",
        sk: { field: "lsi1sk", composite: [] },
      },
      root: { entityType: "PostItem" },
      edges: {
        author: Aggregate.one("author", { entityType: "PostAuthor" }),
        // Entity-less many edge: nothing identifies an element, so the sort key
        // has to be declared or every comment lands on one row (#103).
        comments: Aggregate.many("comments", {
          entityType: "PostComment",
          sk: { composite: ["user"] },
        }),
      },
    })

    it.effect("decomposes into root + one-edge + many-edge items", () =>
      Effect.gen(function* () {
        mockTransactWrite.mockResolvedValue({})

        const result = yield* PostAggregate.create({
          postId: "p-1",
          title: "My Post",
          author: { name: "Alice", bio: "Writer" },
          comments: [
            { user: "Bob", text: "Great!" },
            { user: "Charlie", text: "Nice" },
          ],
        })

        expect(result.postId).toBe("p-1")
        expect(result.author.name).toBe("Alice")
        expect(result.comments).toHaveLength(2)

        // Should produce one transaction group ("root") with 4 items:
        // 1 root + 1 author + 2 comments
        expect(mockTransactWrite).toHaveBeenCalledTimes(1)
        const call = mockTransactWrite.mock.calls[0]![0]
        expect(call.TransactItems).toHaveLength(4)
      }).pipe(Effect.provide(WriteLayer)),
    )
  })

  // -------------------------------------------------------------------------
  // Aggregate with sub-aggregates and discriminators
  // -------------------------------------------------------------------------

  describe("create (sub-aggregates with discriminators)", () => {
    const TeamSheetAggregate = Aggregate.make(TeamSheet, {
      root: { entityType: "MatchTeam" },
      edges: {
        team: Aggregate.ref(TeamEntity),
        coach: Aggregate.one("coach", { entityType: "MatchCoach", entity: CoachEntity }),
        players: Aggregate.many("players", { entityType: "MatchPlayer", entity: PlayerEntity }),
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
        venue: Aggregate.one("venue", { entityType: "MatchVenue", entity: VenueEntity }),
        team1: TeamSheetAggregate.with({ discriminator: { teamNumber: 1 } }),
        team2: TeamSheetAggregate.with({ discriminator: { teamNumber: 2 } }),
      },
    })

    it.effect("writes sub-aggregates as separate transaction groups", () =>
      Effect.gen(function* () {
        // Mock ref hydration via batchGetItem — Batch.get groups by table
        const refItems: Record<string, Record<string, unknown>> = {
          venue: {
            pk: "$myapp#v1#venue#venueid_v-1",
            sk: "$myapp#v1#venue",
            __edd_e__: "Venue",
            venueId: "v-1",
            name: "MCG",
            city: "Melbourne",
          },
          "team-aus": {
            pk: "$myapp#v1#team#teamid_t-aus",
            sk: "$myapp#v1#team",
            __edd_e__: "Team",
            teamId: "t-aus",
            name: "Australia",
            country: "Australia",
          },
          "team-ind": {
            pk: "$myapp#v1#team#teamid_t-ind",
            sk: "$myapp#v1#team",
            __edd_e__: "Team",
            teamId: "t-ind",
            name: "India",
            country: "India",
          },
          "coach-1": {
            pk: "$myapp#v1#coach#coachid_c-1",
            sk: "$myapp#v1#coach",
            __edd_e__: "Coach",
            coachId: "c-1",
            name: "Andrew McDonald",
          },
          "coach-2": {
            pk: "$myapp#v1#coach#coachid_c-2",
            sk: "$myapp#v1#coach",
            __edd_e__: "Coach",
            coachId: "c-2",
            name: "Gautam Gambhir",
          },
          "player-smith": {
            pk: "$myapp#v1#player#playerid_p-smith",
            sk: "$myapp#v1#player",
            __edd_e__: "Player",
            playerId: "p-smith",
            displayName: "Steve Smith",
            role: "batter",
          },
          "player-kohli": {
            pk: "$myapp#v1#player#playerid_p-kohli",
            sk: "$myapp#v1#player",
            __edd_e__: "Player",
            playerId: "p-kohli",
            displayName: "Virat Kohli",
            role: "batter",
          },
        }
        mockBatchGetItem.mockImplementation((input: Record<string, unknown>) => {
          const requestItems = input.RequestItems as Record<
            string,
            { Keys: Array<Record<string, { S?: string }>> }
          >
          const responses: Record<string, Array<Record<string, unknown>>> = {}
          for (const [tableName, { Keys }] of Object.entries(requestItems)) {
            responses[tableName] = Keys.map((key) => {
              const pk = key.pk?.S ?? ""
              const match = Object.values(refItems).find((item) => item.pk === pk)
              return match ? toAttributeMap(match) : undefined
            }).filter(Boolean) as Array<Record<string, unknown>>
          }
          return Promise.resolve({ Responses: responses })
        })

        mockTransactWrite.mockResolvedValue({})

        const result = yield* MatchAggregate.create({
          id: "match-1",
          name: "AUS vs IND",
          venueId: "v-1",
          team1: {
            teamId: "t-aus",
            coachId: "c-1",
            homeTeam: true,
            players: [{ playerId: "p-smith", battingPosition: 1, isCaptain: true }],
          },
          team2: {
            teamId: "t-ind",
            coachId: "c-2",
            homeTeam: false,
            players: [{ playerId: "p-kohli", battingPosition: 1, isCaptain: true }],
          },
        })

        // Verify the assembled domain object
        expect(result.id).toBe("match-1")
        expect(result.name).toBe("AUS vs IND")
        expect(result.venue.name).toBe("MCG")
        expect(result.team1.team.name).toBe("Australia")
        expect(result.team1.coach.name).toBe("Andrew McDonald")
        expect(result.team1.players[0]!.player.displayName).toBe("Steve Smith")
        expect(result.team2.team.name).toBe("India")

        // Should produce 3 transaction groups: root, team1, team2
        expect(mockTransactWrite).toHaveBeenCalledTimes(3)
      }).pipe(Effect.provide(WriteLayer)),
    )
  })

  // -------------------------------------------------------------------------
  // Aggregate.delete
  // -------------------------------------------------------------------------

  describe("delete", () => {
    const SimpleAggregate = Aggregate.make(Article, {
      table: MainTable,
      schema: AppSchema,
      pk: { field: "pk", composite: ["articleId"] },
      collection: {
        index: "lsi1",
        name: "article",
        sk: { field: "lsi1sk", composite: [] },
      },
      root: { entityType: "ArticleItem" },
      edges: {},
    })

    it.effect("deletes all items in the partition", () =>
      Effect.gen(function* () {
        // Mock query returning items to delete
        mockWriteQuery.mockResolvedValueOnce({
          Items: [
            toAttributeMap({
              pk: "$myapp#v1#article#a-1",
              sk: "$myapp#v1#articleitem",
              lsi1sk: "$myapp#v1#article",
              __edd_e__: "ArticleItem",
              articleId: "a-1",
              title: "Test",
              author: "Alice",
              tags: [],
            }),
          ],
          LastEvaluatedKey: undefined,
        })

        mockBatchWrite.mockResolvedValueOnce({})

        yield* SimpleAggregate.delete({ articleId: "a-1" })

        expect(mockBatchWrite).toHaveBeenCalledTimes(1)
        const call = mockBatchWrite.mock.calls[0]![0]
        expect(call.RequestItems["test-table"]).toHaveLength(1)
        expect(call.RequestItems["test-table"][0].DeleteRequest).toBeDefined()
      }).pipe(Effect.provide(WriteLayer)),
    )

    it.effect("fails with AggregateAssemblyError when no items found", () =>
      Effect.gen(function* () {
        mockWriteQuery.mockResolvedValueOnce({
          Items: [],
          LastEvaluatedKey: undefined,
        })

        const error = yield* SimpleAggregate.delete({ articleId: "missing" }).pipe(Effect.flip)
        expect(error._tag).toBe("AggregateAssemblyError")
      }).pipe(Effect.provide(WriteLayer)),
    )
  })

  // -------------------------------------------------------------------------
  // Aggregate.update (diff-based)
  // -------------------------------------------------------------------------

  describe("update", () => {
    // A transformed-field model for the #116 diff-narrowing checks.
    class TxnRow extends Schema.Class<TxnRow>("TxnRow")({
      txnId: Schema.String,
      amount: Schema.BigIntFromString,
      label: Schema.String,
    }) {}

    const TxnRowAggregate = Aggregate.make(TxnRow, {
      table: MainTable,
      schema: AppSchema,
      pk: { field: "pk", composite: ["txnId"] },
      collection: { index: "lsi1", name: "txnrow", sk: { field: "lsi1sk", composite: [] } },
      root: { entityType: "TxnRowItem" },
      edges: {},
    })

    const ArticleAggregate = Aggregate.make(Article, {
      table: MainTable,
      schema: AppSchema,
      pk: { field: "pk", composite: ["articleId"] },
      collection: {
        index: "lsi1",
        name: "article",
        sk: { field: "lsi1sk", composite: [] },
      },
      root: { entityType: "ArticleItem" },
      edges: {},
    })

    it.effect("fetches, mutates, and writes changed groups", () =>
      Effect.gen(function* () {
        // Mock query for current state
        mockWriteQuery.mockResolvedValueOnce({
          Items: [
            toAttributeMap({
              pk: "$myapp#v1#article#a-1",
              sk: "$myapp#v1#articleitem",
              lsi1sk: "$myapp#v1#article",
              __edd_e__: "ArticleItem",
              articleId: "a-1",
              title: "Old Title",
              author: "Alice",
              tags: ["ts"],
            }),
          ],
          LastEvaluatedKey: undefined,
        })

        mockTransactWrite.mockResolvedValue({})

        const result = yield* ArticleAggregate.update({ articleId: "a-1" }, ({ state }) => ({
          ...state,
          title: "New Title",
          tags: ["ts", "effect"],
        }))

        expect(result.title).toBe("New Title")
        expect(result.tags).toEqual(["ts", "effect"])

        // Should write the changed root group
        expect(mockTransactWrite).toHaveBeenCalledTimes(1)
      }).pipe(Effect.provide(WriteLayer)),
    )

    it.effect("skips write when nothing changed", () =>
      Effect.gen(function* () {
        mockWriteQuery.mockResolvedValueOnce({
          Items: [
            toAttributeMap({
              pk: "$myapp#v1#article#a-1",
              sk: "$myapp#v1#articleitem",
              lsi1sk: "$myapp#v1#article",
              __edd_e__: "ArticleItem",
              articleId: "a-1",
              title: "Same Title",
              author: "Alice",
              tags: ["ts"],
            }),
          ],
          LastEvaluatedKey: undefined,
        })

        const result = yield* ArticleAggregate.update({ articleId: "a-1" }, ({ state }) => state)

        expect(result.title).toBe("Same Title")
        // No writes because nothing changed
        expect(mockTransactWrite).not.toHaveBeenCalled()
      }).pipe(Effect.provide(WriteLayer)),
    )

    // Same claim, on a model with a TRANSFORMED field (#116). `deepEqualGroups`
    // compares DECOMPOSED groups and decomposition is where attribute encoding
    // now happens — so both sides must be encoded identically. Encoding only one
    // side would make every update look dirty and write the whole aggregate.
    it.effect("skips write when nothing changed, on a transformed model", () =>
      Effect.gen(function* () {
        mockWriteQuery.mockResolvedValueOnce({
          Items: [
            toAttributeMap({
              pk: "$myapp#v1#txnrow#t-1",
              sk: "$myapp#v1#txnrowitem",
              lsi1sk: "$myapp#v1#txnrow",
              __edd_e__: "TxnRowItem",
              txnId: "t-1",
              // Stored ENCODED, as the write path now writes it.
              amount: "420",
              label: "L",
            }),
          ],
          LastEvaluatedKey: undefined,
        })

        const result = yield* TxnRowAggregate.update({ txnId: "t-1" }, ({ state }) => state)

        expect((result as unknown as { amount: bigint }).amount).toBe(420n)
        expect(mockTransactWrite).not.toHaveBeenCalled()
      }).pipe(Effect.provide(WriteLayer)),
    )

    it.effect("still writes when a transformed field actually changes", () =>
      Effect.gen(function* () {
        mockWriteQuery.mockResolvedValueOnce({
          Items: [
            toAttributeMap({
              pk: "$myapp#v1#txnrow#t-2",
              sk: "$myapp#v1#txnrowitem",
              lsi1sk: "$myapp#v1#txnrow",
              __edd_e__: "TxnRowItem",
              txnId: "t-2",
              amount: "420",
              label: "L",
            }),
          ],
          LastEvaluatedKey: undefined,
        })
        mockTransactWrite.mockResolvedValueOnce({})

        yield* TxnRowAggregate.update({ txnId: "t-2" }, ({ state }) => ({
          ...state,
          amount: 999n,
        }))

        expect(mockTransactWrite).toHaveBeenCalledTimes(1)
        const item = mockTransactWrite.mock.calls[0]![0].TransactItems[0].Put.Item
        // ...and it is written in the ENCODED form.
        expect(item.amount).toEqual({ S: "999" })
      }).pipe(Effect.provide(WriteLayer)),
    )

    it.effect("provides update context with state, cursor, optic, and current", () =>
      Effect.gen(function* () {
        mockWriteQuery.mockResolvedValueOnce({
          Items: [
            toAttributeMap({
              pk: "$myapp#v1#article#a-1",
              sk: "$myapp#v1#articleitem",
              lsi1sk: "$myapp#v1#article",
              __edd_e__: "ArticleItem",
              articleId: "a-1",
              title: "Original",
              author: "Alice",
              tags: ["ts"],
            }),
          ],
          LastEvaluatedKey: undefined,
        })

        mockTransactWrite.mockResolvedValue({})

        let receivedState: unknown
        let receivedCursor: unknown
        let receivedOptic: unknown
        let receivedCurrent: unknown

        yield* ArticleAggregate.update(
          { articleId: "a-1" },
          ({ state, cursor, optic, current }) => {
            receivedState = state
            receivedCursor = cursor
            receivedOptic = optic
            receivedCurrent = current
            return state
          },
        )

        // state is a plain object, not a class instance
        expect(receivedState).toBeDefined()
        expect(Object.getPrototypeOf(receivedState)).toBe(Object.prototype)
        expect((receivedState as any).title).toBe("Original")

        // cursor is provided with key, get, replace, modify
        expect(receivedCursor).toBeDefined()
        expect(typeof (receivedCursor as any).key).toBe("function")
        expect(typeof (receivedCursor as any).get).toBe("function")
        expect(typeof (receivedCursor as any).replace).toBe("function")
        expect(typeof (receivedCursor as any).modify).toBe("function")

        // optic is provided and has key method
        expect(receivedOptic).toBeDefined()
        expect(typeof (receivedOptic as any).key).toBe("function")

        // current is a class instance
        expect(receivedCurrent).toBeInstanceOf(Article)
      }).pipe(Effect.provide(WriteLayer)),
    )

    it.effect("cursor key.replace updates a field", () =>
      Effect.gen(function* () {
        mockWriteQuery.mockResolvedValueOnce({
          Items: [
            toAttributeMap({
              pk: "$myapp#v1#article#a-1",
              sk: "$myapp#v1#articleitem",
              lsi1sk: "$myapp#v1#article",
              __edd_e__: "ArticleItem",
              articleId: "a-1",
              title: "Old Title",
              author: "Alice",
              tags: ["ts"],
            }),
          ],
          LastEvaluatedKey: undefined,
        })

        mockTransactWrite.mockResolvedValue({})

        const result = yield* ArticleAggregate.update({ articleId: "a-1" }, ({ cursor }) =>
          cursor.key("title").replace("New Title"),
        )

        expect(result.title).toBe("New Title")
        expect(result.author).toBe("Alice")
        expect(result.tags).toEqual(["ts"])
        // Result should be a proper class instance (reconstructed via Schema.decode)
        expect(result).toBeInstanceOf(Article)
      }).pipe(Effect.provide(WriteLayer)),
    )

    it.effect("cursor modify updates nested array data", () =>
      Effect.gen(function* () {
        mockWriteQuery.mockResolvedValueOnce({
          Items: [
            toAttributeMap({
              pk: "$myapp#v1#article#a-1",
              sk: "$myapp#v1#articleitem",
              lsi1sk: "$myapp#v1#article",
              __edd_e__: "ArticleItem",
              articleId: "a-1",
              title: "Title",
              author: "Alice",
              tags: ["ts"],
            }),
          ],
          LastEvaluatedKey: undefined,
        })

        mockTransactWrite.mockResolvedValue({})

        const result = yield* ArticleAggregate.update({ articleId: "a-1" }, ({ cursor }) =>
          cursor.key("tags").modify((tags) => [...tags, "effect"]),
        )

        expect(result.tags).toEqual(["ts", "effect"])
        expect(result).toBeInstanceOf(Article)
      }).pipe(Effect.provide(WriteLayer)),
    )

    it.effect("spread-based mutation via state works", () =>
      Effect.gen(function* () {
        mockWriteQuery.mockResolvedValueOnce({
          Items: [
            toAttributeMap({
              pk: "$myapp#v1#article#a-1",
              sk: "$myapp#v1#articleitem",
              lsi1sk: "$myapp#v1#article",
              __edd_e__: "ArticleItem",
              articleId: "a-1",
              title: "Old Title",
              author: "Alice",
              tags: ["ts"],
            }),
          ],
          LastEvaluatedKey: undefined,
        })

        mockTransactWrite.mockResolvedValue({})

        const result = yield* ArticleAggregate.update({ articleId: "a-1" }, ({ state }) => ({
          ...state,
          title: "New Title",
        }))

        expect(result.title).toBe("New Title")
        expect(result.author).toBe("Alice")
        expect(result).toBeInstanceOf(Article)
      }).pipe(Effect.provide(WriteLayer)),
    )

    it.effect("cursor.at modifies an array element by index", () =>
      Effect.gen(function* () {
        mockWriteQuery.mockResolvedValueOnce({
          Items: [
            toAttributeMap({
              pk: "$myapp#v1#article#a-1",
              sk: "$myapp#v1#articleitem",
              lsi1sk: "$myapp#v1#article",
              __edd_e__: "ArticleItem",
              articleId: "a-1",
              title: "Title",
              author: "Alice",
              tags: ["ts", "effect"],
            }),
          ],
          LastEvaluatedKey: undefined,
        })

        mockTransactWrite.mockResolvedValue({})

        const result = yield* ArticleAggregate.update({ articleId: "a-1" }, ({ cursor }) =>
          cursor.key("tags").at(0).replace("typescript"),
        )

        expect(result.tags).toEqual(["typescript", "effect"])
        expect(result).toBeInstanceOf(Article)
      }).pipe(Effect.provide(WriteLayer)),
    )

    it.effect("cursor.get reads the focused value", () =>
      Effect.gen(function* () {
        mockWriteQuery.mockResolvedValueOnce({
          Items: [
            toAttributeMap({
              pk: "$myapp#v1#article#a-1",
              sk: "$myapp#v1#articleitem",
              lsi1sk: "$myapp#v1#article",
              __edd_e__: "ArticleItem",
              articleId: "a-1",
              title: "My Title",
              author: "Alice",
              tags: ["ts"],
            }),
          ],
          LastEvaluatedKey: undefined,
        })

        mockTransactWrite.mockResolvedValue({})

        let readTitle: unknown
        yield* ArticleAggregate.update({ articleId: "a-1" }, ({ state, cursor }) => {
          readTitle = cursor.key("title").get()
          return state
        })

        expect(readTitle).toBe("My Title")
      }).pipe(Effect.provide(WriteLayer)),
    )
  })

  // -------------------------------------------------------------------------
  // update — orphan deletes (#74): an edge element removed by the mutation must
  // emit a Delete (in the same per-group transaction), not just be skipped. A
  // many-edge element lives in its parent group, so removal shrinks a group —
  // the diff must be item-level, not group-level.
  // -------------------------------------------------------------------------

  describe("update — orphan deletes (#74)", () => {
    class CommentX extends Schema.Class<CommentX>("CommentX")({
      id: Schema.String, // required → each comment gets a distinct SK composite
      text: Schema.String,
    }) {}
    class PostX extends Schema.Class<PostX>("PostX")({
      postId: Schema.String,
      title: Schema.String,
      comments: Schema.Array(CommentX),
    }) {}
    const PostXAggregate = Aggregate.make(PostX, {
      table: MainTable,
      schema: AppSchema,
      pk: { field: "pk", composite: ["postId"] },
      collection: { index: "lsi1", name: "postx", sk: { field: "lsi1sk", composite: [] } },
      root: { entityType: "PostXRoot" },
      edges: { comments: Aggregate.many("comments", { entityType: "PostXComment" }) },
    })

    // Create (capturing the written rows), then arm the partition query with those
    // rows so the subsequent update assembles from the real created state.
    const seed = (input: Parameters<typeof PostXAggregate.create>[0]) =>
      Effect.gen(function* () {
        const written: Array<Record<string, unknown>> = []
        mockTransactWrite.mockImplementation((i: { TransactItems: Array<any> }) => {
          for (const ti of i.TransactItems) if (ti.Put) written.push(ti.Put.Item)
          return Promise.resolve({})
        })
        yield* PostXAggregate.create(input)
        mockTransactWrite.mockReset()
        mockTransactWrite.mockResolvedValue({})
        mockWriteQuery.mockResolvedValueOnce({ Items: written, LastEvaluatedKey: undefined })
      })

    const lastTransactItems = (): Array<any> =>
      (mockTransactWrite.mock.calls[0]![0] as { TransactItems: Array<any> }).TransactItems
    const skOf = (x: { S?: string } | undefined): string => x?.S ?? ""

    it.effect("removing one element emits a Delete for the orphan + Puts for survivors", () =>
      Effect.gen(function* () {
        yield* seed({
          postId: "p",
          title: "T",
          comments: [
            { id: "c1", text: "a" },
            { id: "c2", text: "b" },
          ],
        })

        yield* PostXAggregate.update({ postId: "p" }, ({ state }) => ({
          ...state,
          comments: state.comments.filter((c) => c.id !== "c1"),
        }))

        expect(mockTransactWrite).toHaveBeenCalledTimes(1)
        const ti = lastTransactItems()
        const deletes = ti.filter((x) => x.Delete)
        const puts = ti.filter((x) => x.Put)
        expect(deletes).toHaveLength(1)
        expect(skOf(deletes[0].Delete.Key.sk)).toMatch(/#c1$/)
        expect(puts.some((p) => /#c2$/.test(skOf(p.Put.Item.sk)))).toBe(true)
        expect(puts.some((p) => /#c1$/.test(skOf(p.Put.Item.sk)))).toBe(false)
      }).pipe(Effect.provide(WriteLayer)),
    )

    it.effect("removing all elements emits a Delete per orphan, only root remains a Put", () =>
      Effect.gen(function* () {
        yield* seed({
          postId: "p",
          title: "T",
          comments: [
            { id: "c1", text: "a" },
            { id: "c2", text: "b" },
          ],
        })

        yield* PostXAggregate.update({ postId: "p" }, ({ state }) => ({ ...state, comments: [] }))

        const ti = lastTransactItems()
        expect(ti.filter((x) => x.Delete)).toHaveLength(2)
        const puts = ti.filter((x) => x.Put)
        expect(puts).toHaveLength(1) // root only
        expect(skOf(puts[0].Put.Item.sk)).toMatch(/postxroot$/)
      }).pipe(Effect.provide(WriteLayer)),
    )

    it.effect(
      "atomic add + remove: one transaction carries the new Put and the orphan Delete",
      () =>
        Effect.gen(function* () {
          yield* seed({
            postId: "p",
            title: "T",
            comments: [
              { id: "c1", text: "a" },
              { id: "c2", text: "b" },
            ],
          })

          yield* PostXAggregate.update({ postId: "p" }, ({ state }) => ({
            ...state,
            comments: [...state.comments.filter((c) => c.id !== "c1"), { id: "c9", text: "n" }],
          }))

          expect(mockTransactWrite).toHaveBeenCalledTimes(1)
          const ti = lastTransactItems()
          const deletes = ti.filter((x) => x.Delete)
          expect(deletes).toHaveLength(1)
          expect(skOf(deletes[0].Delete.Key.sk)).toMatch(/#c1$/)
          expect(ti.filter((x) => x.Put).some((p) => /#c9$/.test(skOf(p.Put.Item.sk)))).toBe(true)
        }).pipe(Effect.provide(WriteLayer)),
    )

    it.effect("root-field-only update issues Puts only — zero Deletes", () =>
      Effect.gen(function* () {
        yield* seed({
          postId: "p",
          title: "T",
          comments: [
            { id: "c1", text: "a" },
            { id: "c2", text: "b" },
          ],
        })

        yield* PostXAggregate.update({ postId: "p" }, ({ state }) => ({ ...state, title: "T2" }))

        const ti = lastTransactItems()
        expect(ti.filter((x) => x.Delete)).toHaveLength(0)
        expect(ti.filter((x) => x.Put).length).toBeGreaterThanOrEqual(1)
      }).pipe(Effect.provide(WriteLayer)),
    )

    it.effect("create path emits Puts only (never a Delete)", () =>
      Effect.gen(function* () {
        mockTransactWrite.mockResolvedValue({})
        yield* PostXAggregate.create({
          postId: "p2",
          title: "T",
          comments: [{ id: "c1", text: "a" }],
        })
        for (const call of mockTransactWrite.mock.calls) {
          for (const ti of (call[0] as { TransactItems: Array<any> }).TransactItems) {
            expect(ti.Delete).toBeUndefined()
            expect(ti.Put).toBeDefined()
          }
        }
      }).pipe(Effect.provide(WriteLayer)),
    )
  })

  // -------------------------------------------------------------------------
  // Error paths for write operations
  // -------------------------------------------------------------------------

  describe("write error paths", () => {
    it.effect("create fails with ValidationError for invalid input", () =>
      Effect.gen(function* () {
        const ArticleAggregate = Aggregate.make(Article, {
          table: MainTable,
          schema: AppSchema,
          pk: { field: "pk", composite: ["articleId"] },
          collection: {
            index: "lsi1",
            name: "article",
            sk: { field: "lsi1sk", composite: [] },
          },
          root: { entityType: "ArticleItem" },
          edges: {},
        })

        const error = yield* ArticleAggregate.create({
          articleId: "a-1",
          // missing required fields: title, author, tags
        }).pipe(Effect.flip)

        expect(error._tag).toBe("ValidationError")
      }).pipe(Effect.provide(WriteLayer)),
    )

    it.effect("create fails with RefNotFound when ref entity does not exist", () =>
      Effect.gen(function* () {
        class RefTarget extends Schema.Class<RefTarget>("RefTarget")({
          refId: Schema.String.pipe(DynamoModel.identifier),
          value: Schema.String,
        }) {}

        const RefEntity = Entity.make({
          model: RefTarget,
          entityType: "RefTarget",
          primaryKey: {
            pk: { field: "pk", composite: ["refId"] },
            sk: { field: "sk", composite: [] },
          },
        })
        RefEntity._configure(AppSchema, MainTable.Tag)

        class WithRef extends Schema.Class<WithRef>("WithRef")({
          id: Schema.String,
          ref: RefTarget,
        }) {}

        const WithRefAggregate = Aggregate.make(WithRef, {
          table: MainTable,
          schema: AppSchema,
          pk: { field: "pk", composite: ["id"] },
          collection: {
            index: "lsi1",
            name: "withref",
            sk: { field: "lsi1sk", composite: [] },
          },
          root: { entityType: "WithRefItem" },
          edges: {
            ref: Aggregate.ref(RefEntity),
          },
        })

        // Mock batchGetItem to return empty (ref not found)
        mockBatchGetItem.mockResolvedValueOnce({ Responses: { "test-table": [] } })

        const error = yield* WithRefAggregate.create({
          id: "w-1",
          refId: "nonexistent",
        } as any).pipe(Effect.flip)

        expect(error._tag).toBe("RefNotFound")
        const refError = error as RefNotFound
        expect(refError.refId).toBe("nonexistent")
      }).pipe(Effect.provide(WriteLayer)),
    )
  })

  // ---------------------------------------------------------------------------
  // inputSchema — derives API input schema from aggregate definition
  // ---------------------------------------------------------------------------

  describe("inputSchema", () => {
    const TeamSheetAggregate = Aggregate.make(TeamSheet, {
      root: { entityType: "MatchTeam" },
      edges: {
        team: Aggregate.ref(TeamEntity),
        coach: Aggregate.one("coach", { entityType: "MatchCoach", entity: CoachEntity }),
        players: Aggregate.many("players", { entityType: "MatchPlayer", entity: PlayerEntity }),
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
        venue: Aggregate.one("venue", { entityType: "MatchVenue", entity: VenueEntity }),
        team1: TeamSheetAggregate.with({ discriminator: { teamNumber: 1 } }),
        team2: TeamSheetAggregate.with({ discriminator: { teamNumber: 2 } }),
      },
    })

    it("replaces ref fields with ID fields", () => {
      const schema = MatchAggregate.inputSchema
      // Should decode successfully with venueId instead of venue
      const decoded = Schema.decodeUnknownSync(schema as any)({
        name: "AUS vs IND",
        venueId: "v-1",
        team1: {
          teamId: "t-1",
          coachId: "c-1",
          homeTeam: true,
          players: [{ playerId: "p-1", battingPosition: 1, isCaptain: true }],
        },
        team2: {
          teamId: "t-2",
          coachId: "c-2",
          homeTeam: false,
          players: [{ playerId: "p-2", battingPosition: 1, isCaptain: true }],
        },
      })

      expect(decoded.name).toBe("AUS vs IND")
      expect(decoded.venueId).toBe("v-1")
      expect(decoded.team1.teamId).toBe("t-1")
      expect(decoded.team1.coachId).toBe("c-1")
      expect(decoded.team1.players[0].playerId).toBe("p-1")
      expect(decoded.team2.teamId).toBe("t-2")
    })

    it("omits PK composite fields", () => {
      const schema = MatchAggregate.inputSchema
      // "id" is a PK composite — it should not be required
      const decoded = Schema.decodeUnknownSync(schema as any)({
        name: "Test Match",
        venueId: "v-1",
        team1: {
          teamId: "t-1",
          coachId: "c-1",
          homeTeam: true,
          players: [{ playerId: "p-1", battingPosition: 1, isCaptain: true }],
        },
        team2: {
          teamId: "t-2",
          coachId: "c-2",
          homeTeam: false,
          players: [{ playerId: "p-2", battingPosition: 1, isCaptain: true }],
        },
      })

      // id should not be in the decoded result
      expect("id" in decoded).toBe(false)
    })

    it("converts Date fields to accept ISO strings via toCodecJson", () => {
      // Create a model with a Date field
      class Event extends Schema.Class<Event>("Event")({
        eventId: Schema.String,
        name: Schema.String,
        startDate: Schema.Date,
        endDate: Schema.optional(Schema.Date),
      }) {}

      const EventAggregate = Aggregate.make(Event, {
        table: MainTable,
        schema: AppSchema,
        pk: { field: "pk", composite: ["eventId"] },
        collection: {
          index: "lsi1",
          name: "event",
          sk: { field: "lsi1sk", composite: [] },
        },
        root: { entityType: "EventItem" },
        edges: {},
      })

      const schema = EventAggregate.inputSchema
      const decoded = Schema.decodeUnknownSync(schema as any)({
        name: "Test Event",
        startDate: "2025-06-15T00:00:00.000Z",
        endDate: "2025-06-16T00:00:00.000Z",
      }) as Record<string, unknown>

      expect(decoded.name).toBe("Test Event")
      expect(decoded.startDate).toBeInstanceOf(Date)
      expect((decoded.startDate as Date).toISOString()).toBe("2025-06-15T00:00:00.000Z")
      expect(decoded.endDate).toBeInstanceOf(Date)

      // eventId (PK composite) should be omitted
      expect("eventId" in decoded).toBe(false)

      // Optional Date can be omitted
      const decoded2 = Schema.decodeUnknownSync(schema as any)({
        name: "No End",
        startDate: "2025-01-01T00:00:00.000Z",
      }) as Record<string, unknown>
      expect(decoded2.name).toBe("No End")
      expect(decoded2.startDate).toBeInstanceOf(Date)
      expect("endDate" in decoded2).toBe(false)
    })

    it("rejects invalid input", () => {
      const schema = MatchAggregate.inputSchema
      // Missing required field "name"
      expect(() =>
        Schema.decodeUnknownSync(schema as any)({
          venueId: "v-1",
          team1: {
            teamId: "t-1",
            coachId: "c-1",
            homeTeam: true,
            players: [],
          },
          team2: {
            teamId: "t-2",
            coachId: "c-2",
            homeTeam: false,
            players: [],
          },
        }),
      ).toThrow()
    })
    it("preserves optionality for optional edge fields in Aggregate.Input type", () => {
      class Fixture extends Schema.Class<Fixture>("Fixture")({
        id: Schema.String,
        name: Schema.String,
        sponsor: Schema.optionalKey(Team),
      }) {}

      const FixtureAggregate = Aggregate.make(Fixture, {
        table: MainTable,
        schema: AppSchema,
        pk: { field: "pk", composite: ["id"] },
        collection: {
          index: "lsi1",
          name: "fixture",
          sk: { field: "lsi1sk", composite: ["name"] },
        },
        root: { entityType: "FixtureItem" },
        edges: {
          sponsor: Aggregate.one("sponsor", { entityType: "FixtureSponsor", entity: TeamEntity }),
        },
      })

      // Type-level assertion: sponsorId should be optional in the input type
      type Input = Aggregate.Input<typeof FixtureAggregate>
      type _AssertOptional = {} extends Pick<Input, "sponsorId"> ? true : never
      const _proof: _AssertOptional = true

      // Runtime assertion: inputSchema should accept input without sponsorId
      const schema = FixtureAggregate.inputSchema
      const decoded = Schema.decodeUnknownSync(schema as any)({
        name: "Grand Final",
      })
      expect(decoded.name).toBe("Grand Final")
      expect("sponsorId" in decoded).toBe(false)

      // And also accept input with sponsorId
      const decoded2 = Schema.decodeUnknownSync(schema as any)({
        name: "Grand Final",
        sponsorId: "t-1",
      })
      expect(decoded2.sponsorId).toBe("t-1")
    })

    it("createSchema is identical to inputSchema", () => {
      expect(MatchAggregate.createSchema).toBe(MatchAggregate.inputSchema)
    })

    it("updateSchema makes all fields optional", () => {
      const schema = MatchAggregate.updateSchema
      // Should decode successfully with only a partial payload
      const decoded = Schema.decodeUnknownSync(schema as any)({
        name: "Updated Name",
      })
      expect(decoded.name).toBe("Updated Name")
      expect("venueId" in decoded).toBe(false)
      expect("team1" in decoded).toBe(false)
    })

    it("updateSchema accepts empty object", () => {
      const schema = MatchAggregate.updateSchema
      const decoded = Schema.decodeUnknownSync(schema as any)({})
      expect(Object.keys(decoded as object)).toEqual([])
    })

    it("updateSchema uses ref Id fields (not entity fields)", () => {
      const schema = MatchAggregate.updateSchema
      // venueId is a ref → should accept venueId (not venue) as optional
      const decoded = Schema.decodeUnknownSync(schema as any)({
        venueId: "v-new",
      })
      expect(decoded.venueId).toBe("v-new")
      expect("venue" in decoded).toBe(false)
    })
  })

  // ---------------------------------------------------------------------------
  // ManyEdge inputField — configurable input field name
  // ---------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Many-edge declared sort key (#103)
  // -------------------------------------------------------------------------

  describe("ManyEdge sk.composite (#103)", () => {
    class Official extends Schema.Class<Official>("Official")({
      officialId: Schema.String.pipe(DynamoModel.identifier),
      name: Schema.String,
    }) {}

    const OfficialEntity = Entity.make({
      model: Official,
      entityType: "Official",
      primaryKey: {
        pk: { field: "pk", composite: ["officialId"] },
        sk: { field: "sk", composite: [] },
      },
    })
    OfficialEntity._configure(AppSchema, MainTable.Tag)

    // A real panel has both kinds of role: "onfield" seats TWO umpires, while
    // "third" and "referee" seat one each — and the same person routinely holds
    // more than one appointment. So neither the role nor the umpire is unique on
    // its own; only the pair is.
    class Appointment extends Schema.Class<Appointment>("Appointment")({
      official: Official,
      role: Schema.Literals(["onfield", "third", "referee"]),
    }) {}

    class OfficiatedMatch extends Schema.Class<OfficiatedMatch>("OfficiatedMatch")({
      id: Schema.String,
      name: Schema.String,
      officials: Schema.Array(Appointment),
    }) {}

    /** Build the aggregate with a given (or absent) declared sort key. */
    const makeMatchAggregate = (sk?: { readonly composite: ReadonlyArray<string> }) =>
      Aggregate.make(OfficiatedMatch, {
        table: MainTable,
        schema: AppSchema,
        pk: { field: "pk", composite: ["id"] },
        collection: {
          index: "lsi1",
          name: "officiated",
          sk: { field: "lsi1sk", composite: [] },
        },
        root: { entityType: "OfficiatedMatchItem" },
        edges: {
          officials: Aggregate.many("officials", {
            entityType: "MatchOfficial",
            entity: OfficialEntity,
            ...(sk !== undefined && { sk }),
          }),
        },
      })

    const officialItems: Record<string, Record<string, unknown>> = {
      "off-1": {
        pk: "$myapp#v1#official#officialid_off-1",
        sk: "$myapp#v1#official",
        __edd_e__: "Official",
        officialId: "off-1",
        name: "Ravi Bowen",
      },
      "off-2": {
        pk: "$myapp#v1#official#officialid_off-2",
        sk: "$myapp#v1#official",
        __edd_e__: "Official",
        officialId: "off-2",
        name: "Kumar D.",
      },
      "off-3": {
        pk: "$myapp#v1#official#officialid_off-3",
        sk: "$myapp#v1#official",
        __edd_e__: "Official",
        officialId: "off-3",
        name: "Marais E.",
      },
    }

    const stubHydration = () => {
      mockBatchGetItem.mockImplementation((input: Record<string, unknown>) => {
        const requestItems = input.RequestItems as Record<
          string,
          { Keys: Array<Record<string, { S?: string }>> }
        >
        const responses: Record<string, Array<Record<string, unknown>>> = {}
        for (const [tableName, { Keys }] of Object.entries(requestItems)) {
          responses[tableName] = Keys.map((key) => {
            const pk = key.pk?.S ?? ""
            const match = Object.values(officialItems).find((item) => item.pk === pk)
            return match ? toAttributeMap(match) : undefined
          }).filter(Boolean) as Array<Record<string, unknown>>
        }
        return Promise.resolve({ Responses: responses })
      })
    }

    /** Sort keys of the MatchOfficial rows written by the last transaction. */
    const writtenOfficialSks = (): Array<string> => {
      const call = mockTransactWrite.mock.calls[0]![0] as {
        TransactItems: Array<{ Put?: { Item: Record<string, { S?: string }> } }>
      }
      return call.TransactItems.filter((i) => i.Put?.Item.__edd_e__?.S === "MatchOfficial").map(
        (i) => i.Put!.Item.sk!.S!,
      )
    }

    /** The full panel: two on-field umpires, one of whom is also the third umpire. */
    const fullPanel = [
      { officialId: "off-1", role: "onfield" as const },
      { officialId: "off-2", role: "onfield" as const },
      { officialId: "off-1", role: "third" as const },
      { officialId: "off-3", role: "referee" as const },
    ]

    it.effect("role + official keys a panel where neither is unique alone", () =>
      Effect.gen(function* () {
        stubHydration()
        mockTransactWrite.mockResolvedValue({})

        // Dotted path: ref hydration replaces `officialId` with the hydrated
        // `official` object, so the identifier lives one level down.
        const MatchAggregate = makeMatchAggregate({ composite: ["role", "official.officialId"] })

        const result = yield* MatchAggregate.create({
          id: "m-1",
          name: "AUS vs IND",
          officials: fullPanel,
        })

        expect(result.officials).toHaveLength(4)
        expect(writtenOfficialSks()).toEqual([
          "$myapp#v1#matchofficial#onfield#off-1",
          "$myapp#v1#matchofficial#onfield#off-2",
          "$myapp#v1#matchofficial#third#off-1",
          "$myapp#v1#matchofficial#referee#off-3",
        ])
      }).pipe(Effect.provide(WriteLayer)),
    )

    it.effect("role alone suffices when every role seats one official", () =>
      Effect.gen(function* () {
        stubHydration()
        mockTransactWrite.mockResolvedValue({})

        const MatchAggregate = makeMatchAggregate({ composite: ["role"] })

        yield* MatchAggregate.create({
          id: "m-2",
          name: "ENG vs NZ",
          officials: [
            { officialId: "off-1", role: "third" },
            // Same official, second appointment — one row under the ref-id default.
            { officialId: "off-1", role: "referee" },
          ],
        })

        expect(writtenOfficialSks()).toEqual([
          "$myapp#v1#matchofficial#third",
          "$myapp#v1#matchofficial#referee",
        ])
      }).pipe(Effect.provide(WriteLayer)),
    )

    it.effect("an under-specified key collides on the multi-occupancy role", () =>
      Effect.gen(function* () {
        stubHydration()
        mockTransactWrite.mockResolvedValue({})

        // `role` alone cannot separate the two on-field umpires.
        const MatchAggregate = makeMatchAggregate({ composite: ["role"] })

        const error = yield* MatchAggregate.create({
          id: "m-3",
          name: "SA vs PAK",
          officials: fullPanel,
        }).pipe(Effect.flip)

        expect(error._tag).toBe("AggregateDecompositionError")
        const decomposition = error as AggregateDecompositionError
        expect(decomposition.member).toBe("officials")
        expect(decomposition.reason).toContain("$myapp#v1#matchofficial#onfield")
        expect(mockTransactWrite).not.toHaveBeenCalled()
      }).pipe(Effect.provide(WriteLayer)),
    )

    it.effect("the ref-identifier default collides on the repeated official", () =>
      Effect.gen(function* () {
        stubHydration()
        mockTransactWrite.mockResolvedValue({})

        // No declared sk at all — the key is the official, so off-1's two
        // appointments compose one row.
        const MatchAggregate = makeMatchAggregate()

        const error = yield* MatchAggregate.create({
          id: "m-4",
          name: "SL vs BAN",
          officials: fullPanel,
        }).pipe(Effect.flip)

        expect(error._tag).toBe("AggregateDecompositionError")
        const decomposition = error as AggregateDecompositionError
        expect(decomposition.member).toBe("officials")
        expect(decomposition.reason).toContain("$myapp#v1#matchofficial#off-1")
        expect(decomposition.reason).toContain("sk: { composite: [...] }")
        expect(mockTransactWrite).not.toHaveBeenCalled()
      }).pipe(Effect.provide(WriteLayer)),
    )

    it.effect("falls back to the ref-identifier default with no declaration", () =>
      Effect.gen(function* () {
        stubHydration()
        mockTransactWrite.mockResolvedValue({})

        const MatchAggregate = makeMatchAggregate()

        yield* MatchAggregate.create({
          id: "m-5",
          name: "WI vs ZIM",
          officials: [
            { officialId: "off-1", role: "onfield" },
            { officialId: "off-2", role: "onfield" },
          ],
        })

        expect(writtenOfficialSks()).toEqual([
          "$myapp#v1#matchofficial#off-1",
          "$myapp#v1#matchofficial#off-2",
        ])
      }).pipe(Effect.provide(WriteLayer)),
    )

    it.effect("a declared composite that names a missing attribute fails with a hint", () =>
      Effect.gen(function* () {
        stubHydration()
        mockTransactWrite.mockResolvedValue({})

        // "officialId" is the INPUT field name; after hydration it is
        // official.officialId.
        const MatchAggregate = makeMatchAggregate({ composite: ["officialId"] })

        const error = yield* MatchAggregate.create({
          id: "m-6",
          name: "IRE vs AFG",
          officials: [{ officialId: "off-1", role: "onfield" }],
        }).pipe(Effect.flip)

        expect(error._tag).toBe("AggregateDecompositionError")
        const decomposition = error as AggregateDecompositionError
        expect(decomposition.member).toBe("officials")
        expect(decomposition.reason).toContain('"officialId"')
        // The hint points at the dotted path that does resolve after hydration.
        expect(decomposition.reason).toContain("dotted path")
        expect(mockTransactWrite).not.toHaveBeenCalled()
      }).pipe(Effect.provide(WriteLayer)),
    )

    it.effect("a composite naming the ref object is rejected, not stringified into the key", () =>
      Effect.gen(function* () {
        stubHydration()
        mockTransactWrite.mockResolvedValue({})

        // Naming the hydrated ref itself instead of a scalar path. Without a
        // scalar check `serializeValue` falls through to `String(value)` and the
        // whole object lands in a real sort key.
        const MatchAggregate = makeMatchAggregate({ composite: ["role", "official"] })

        const error = yield* MatchAggregate.create({
          id: "m-7",
          name: "NZ vs SL",
          officials: [{ officialId: "off-1", role: "onfield" }],
        }).pipe(Effect.flip)

        expect(error._tag).toBe("AggregateDecompositionError")
        const decomposition = error as AggregateDecompositionError
        expect(decomposition.member).toBe("officials")
        expect(decomposition.reason).toContain('"official"')
        expect(decomposition.reason).toContain("non-scalar")
        expect(decomposition.reason).toContain("dotted path")
        expect(mockTransactWrite).not.toHaveBeenCalled()
      }).pipe(Effect.provide(WriteLayer)),
    )

    it.effect("scalar composites of every supported kind compose", () =>
      Effect.gen(function* () {
        stubHydration()
        mockTransactWrite.mockResolvedValue({})

        class Slot extends Schema.Class<Slot>("Slot")({
          official: Official,
          seq: Schema.Number,
          confirmed: Schema.Boolean,
        }) {}

        class Roster extends Schema.Class<Roster>("Roster")({
          id: Schema.String,
          slots: Schema.Array(Slot),
        }) {}

        const RosterAggregate = Aggregate.make(Roster, {
          table: MainTable,
          schema: AppSchema,
          pk: { field: "pk", composite: ["id"] },
          collection: {
            index: "lsi1",
            name: "roster",
            sk: { field: "lsi1sk", composite: [] },
          },
          root: { entityType: "RosterItem" },
          edges: {
            slots: Aggregate.many("slots", {
              entityType: "RosterSlot",
              entity: OfficialEntity,
              sk: { composite: ["seq", "confirmed", "official.officialId"] },
            }),
          },
        })

        yield* RosterAggregate.create({
          id: "r-1",
          slots: [{ officialId: "off-1", seq: 2, confirmed: true }],
        })

        const call = mockTransactWrite.mock.calls[0]![0] as {
          TransactItems: Array<{ Put?: { Item: Record<string, { S?: string }> } }>
        }
        const sks = call.TransactItems.filter((i) => i.Put?.Item.__edd_e__?.S === "RosterSlot").map(
          (i) => i.Put!.Item.sk!.S!,
        )
        // Numbers zero-pad for sort order; booleans render as true/false.
        expect(sks).toEqual(["$myapp#v1#rosterslot#0000000000000002#true#off-1"])
      }).pipe(Effect.provide(WriteLayer)),
    )

    // "Element IS the ref" panel: a multi-occupancy role modelled as its own
    // edge over Array(Official), with single-occupancy roles as `one` edges.
    // Here the element carries no wrapper, so the entity's own identifier field
    // is what separates the rows.
    describe("multi-occupancy role as an Array(Official) edge", () => {
      class Panel extends Schema.Class<Panel>("Panel")({
        id: Schema.String,
        name: Schema.String,
        onfield: Schema.Array(Official),
        third: Official,
      }) {}

      const PanelAggregate = Aggregate.make(Panel, {
        table: MainTable,
        schema: AppSchema,
        pk: { field: "pk", composite: ["id"] },
        collection: {
          index: "lsi1",
          name: "panel",
          sk: { field: "lsi1sk", composite: [] },
        },
        root: { entityType: "PanelItem" },
        edges: {
          onfield: Aggregate.many("onfield", {
            entityType: "PanelOnfield",
            entity: OfficialEntity,
          }),
          third: Aggregate.one("third", { entityType: "PanelThird", entity: OfficialEntity }),
        },
      })

      it.effect("each umpire in the array gets its own row, keyed by identifier", () =>
        Effect.gen(function* () {
          stubHydration()
          mockTransactWrite.mockResolvedValue({})

          const result = yield* PanelAggregate.create({
            id: "p-1",
            name: "AUS vs IND",
            onfield: ["off-1", "off-2"],
            // Same official as an on-field umpire AND the third umpire — a
            // separate edge, so a separate row, no collision.
            thirdId: "off-1",
          })

          expect(result.onfield).toHaveLength(2)
          expect(result.third.officialId).toBe("off-1")

          const call = mockTransactWrite.mock.calls[0]![0] as {
            TransactItems: Array<{ Put?: { Item: Record<string, { S?: string }> } }>
          }
          const sks = call.TransactItems.map((i) => i.Put!.Item.sk!.S!)
          expect(sks).toContain("$myapp#v1#panelonfield#off-1")
          expect(sks).toContain("$myapp#v1#panelonfield#off-2")
          expect(sks).toContain("$myapp#v1#panelthird")
        }).pipe(Effect.provide(WriteLayer)),
      )
    })
  })

  describe("ManyEdge inputField", () => {
    // "Element IS entity" case: Umpire[] → inputField renames to matchUmpireIds: string[]
    class Umpire extends Schema.Class<Umpire>("Umpire")({
      umpireId: Schema.String.pipe(DynamoModel.identifier),
      name: Schema.String,
    }) {}

    const UmpireEntity = Entity.make({
      model: Umpire,
      entityType: "Umpire",
      primaryKey: {
        pk: { field: "pk", composite: ["umpireId"] },
        sk: { field: "sk", composite: [] },
      },
    })
    UmpireEntity._configure(AppSchema, MainTable.Tag)

    class UmpireSheet extends Schema.Class<UmpireSheet>("UmpireSheet")({
      matchReferee: Schema.optionalKey(Umpire),
      matchUmpire: Schema.optional(Schema.Array(Umpire)),
    }) {}

    class MatchWithInputField extends Schema.Class<MatchWithInputField>("MatchWithInputField")({
      id: Schema.String,
      name: Schema.String,
      umpires: Schema.optionalKey(UmpireSheet),
    }) {}

    const UmpireSheetAggregate = Aggregate.make(UmpireSheet, {
      root: { entityType: "MatchUmpires" },
      edges: {
        matchReferee: Aggregate.one("matchReferee", {
          entity: UmpireEntity,
          entityType: "MatchUmpire",
          discriminator: { role: "referee" },
        }),
        matchUmpire: Aggregate.many("matchUmpire", {
          entity: UmpireEntity,
          entityType: "MatchUmpire",
          inputField: "matchUmpireIds",
        }),
      },
    })

    const MatchInputFieldAggregate = Aggregate.make(MatchWithInputField, {
      table: MainTable,
      schema: AppSchema,
      pk: { field: "pk", composite: ["id"] },
      collection: {
        index: "lsi1",
        name: "matchif",
        sk: { field: "lsi1sk", composite: [] },
      },
      root: { entityType: "MatchItem" },
      edges: {
        umpires: UmpireSheetAggregate.with({ discriminator: {} }),
      },
    })

    it("renames ManyEdge field in inputSchema when inputField is set", () => {
      const schema = MatchInputFieldAggregate.inputSchema
      // Should accept matchUmpireIds (not matchUmpire) for the umpire array
      const decoded = Schema.decodeUnknownSync(schema as any)({
        name: "Test Match",
        umpires: {
          matchRefereeId: "u-1",
          matchUmpireIds: ["u-2", "u-3"],
        },
      })

      expect(decoded.name).toBe("Test Match")
      expect(decoded.umpires.matchRefereeId).toBe("u-1")
      expect(decoded.umpires.matchUmpireIds).toEqual(["u-2", "u-3"])
    })

    it("ignores original field name when inputField is set", () => {
      const schema = MatchInputFieldAggregate.inputSchema
      // matchUmpire (original name) is not recognized — matchUmpireIds is the expected key
      const decoded = Schema.decodeUnknownSync(schema as any)({
        name: "Test Match",
        umpires: {
          matchRefereeId: "u-1",
          matchUmpire: ["u-2", "u-3"],
        },
      })
      // The old key is ignored; matchUmpireIds is absent (optional)
      expect(decoded.umpires.matchUmpireIds).toBeUndefined()
      expect("matchUmpire" in decoded.umpires).toBe(false)
    })

    it.effect("create/get round-trip with inputField", () =>
      Effect.gen(function* () {
        // Setup ref mocks for umpires via batchGetItem
        const umpireItems: Record<string, Record<string, unknown>> = {
          "u-1": {
            pk: "$myapp#v1#umpire#umpireid_u-1",
            sk: "$myapp#v1#umpire",
            __edd_e__: "Umpire",
            umpireId: "u-1",
            name: "Ravi Bowen",
          },
          "u-2": {
            pk: "$myapp#v1#umpire#umpireid_u-2",
            sk: "$myapp#v1#umpire",
            __edd_e__: "Umpire",
            umpireId: "u-2",
            name: "Kumar D.",
          },
          "u-3": {
            pk: "$myapp#v1#umpire#umpireid_u-3",
            sk: "$myapp#v1#umpire",
            __edd_e__: "Umpire",
            umpireId: "u-3",
            name: "Marais E.",
          },
        }
        mockBatchGetItem.mockImplementation((input: Record<string, unknown>) => {
          const requestItems = input.RequestItems as Record<
            string,
            { Keys: Array<Record<string, { S?: string }>> }
          >
          const responses: Record<string, Array<Record<string, unknown>>> = {}
          for (const [tableName, { Keys }] of Object.entries(requestItems)) {
            responses[tableName] = Keys.map((key) => {
              const pk = key.pk?.S ?? ""
              const match = Object.values(umpireItems).find((item) => item.pk === pk)
              return match ? toAttributeMap(match) : undefined
            }).filter(Boolean) as Array<Record<string, unknown>>
          }
          return Promise.resolve({ Responses: responses })
        })

        mockTransactWrite.mockResolvedValue({})

        const result = yield* MatchInputFieldAggregate.create({
          id: "m-1",
          name: "Test Match",
          umpires: {
            matchRefereeId: "u-1",
            matchUmpireIds: ["u-2", "u-3"],
          },
        })

        expect(result.id).toBe("m-1")
        expect(result.name).toBe("Test Match")
        expect(result.umpires!.matchReferee!.name).toBe("Ravi Bowen")
        expect(result.umpires!.matchUmpire).toHaveLength(2)
        expect(result.umpires!.matchUmpire![0]!.name).toBe("Kumar D.")
        expect(result.umpires!.matchUmpire![1]!.name).toBe("Marais E.")
      }).pipe(Effect.provide(WriteLayer)),
    )

    it("ManyEdge without inputField preserves original field name", () => {
      class SimpleMatch extends Schema.Class<SimpleMatch>("SimpleMatch")({
        id: Schema.String,
        players: Schema.Array(Player),
      }) {}

      const SimpleAgg = Aggregate.make(SimpleMatch, {
        table: MainTable,
        schema: AppSchema,
        pk: { field: "pk", composite: ["id"] },
        collection: {
          index: "lsi1",
          name: "simplem",
          sk: { field: "lsi1sk", composite: [] },
        },
        root: { entityType: "SimpleMatchItem" },
        edges: {
          players: Aggregate.many("players", { entityType: "MatchPlayer", entity: PlayerEntity }),
        },
      })

      const schema = SimpleAgg.inputSchema
      // Without inputField, the key stays as "players"
      const decoded = Schema.decodeUnknownSync(schema as any)({
        players: ["p-1", "p-2"],
      })
      expect(decoded.players).toEqual(["p-1", "p-2"])
    })
  })

  // -------------------------------------------------------------------------
  // Aggregate.list
  // -------------------------------------------------------------------------

  describe("list", () => {
    const mockListQuery = vi.fn()

    const ListDynamoClient = Layer.succeed(DynamoClient, {
      scan: () => Effect.die("scan should not be called"),
      query: (input) =>
        Effect.tryPromise({
          try: () => mockListQuery(input),
          catch: (e) => new DynamoError({ operation: "Query", cause: e }),
        }),
      putItem: () => Effect.die("not used"),
      getItem: () => Effect.die("not used"),
      deleteItem: () => Effect.die("not used"),
      updateItem: () => Effect.die("not used"),
      batchGetItem: () => Effect.die("not used"),
      batchWriteItem: () => Effect.die("not used"),
      transactGetItems: () => Effect.die("not used"),
      transactWriteItems: () => Effect.die("not used"),
      createTable: () => Effect.die("not used"),
      deleteTable: () => Effect.die("not used"),
      describeTable: () => Effect.die("not used"),
    })

    const ListLayer = Layer.merge(ListDynamoClient, MainTable.layer({ name: "test-table" }))

    const ListAggregate = Aggregate.make(Article, {
      table: MainTable,
      schema: AppSchema,
      pk: { field: "pk", composite: ["articleId"] },
      collection: {
        index: "lsi1",
        name: "article",
        sk: { field: "lsi1sk", composite: [] },
      },
      list: {
        index: "gsi1",
        name: "articlelist",
        pk: { field: "gsi1pk", composite: [] },
        sk: { field: "gsi1sk", composite: ["author", "title"] },
      },
      root: { entityType: "ArticleItem" },
      edges: {},
    })

    // No list config — list() should fail
    const NoListAggregate = Aggregate.make(Article, {
      table: MainTable,
      schema: AppSchema,
      pk: { field: "pk", composite: ["articleId"] },
      collection: {
        index: "lsi1",
        name: "article",
        sk: { field: "lsi1sk", composite: [] },
      },
      root: { entityType: "ArticleItem" },
      edges: {},
    })

    beforeEach(() => {
      mockListQuery.mockReset()
    })

    it.effect("fails with ValidationError when no list config is defined", () =>
      Effect.gen(function* () {
        const result = yield* Effect.flip(NoListAggregate.list())

        expect(result._tag).toBe("ValidationError")
      }).pipe(Effect.provide(ListLayer)),
    )

    it.effect("GSI query: returns all aggregates with no filter (PK-only query)", () =>
      Effect.gen(function* () {
        // GSI query returns root items
        mockListQuery
          .mockResolvedValueOnce({
            Items: [
              toAttributeMap({
                pk: "$myapp#v1#article#a-1",
                sk: "$myapp#v1#articleitem",
                gsi1pk: "$myapp#v1#articlelist",
                gsi1sk: "$myapp#v1#articlelist#alice#first",
                __edd_e__: "ArticleItem",
                articleId: "a-1",
                title: "First",
                author: "Alice",
                tags: [],
              }),
              toAttributeMap({
                pk: "$myapp#v1#article#a-2",
                sk: "$myapp#v1#articleitem",
                gsi1pk: "$myapp#v1#articlelist",
                gsi1sk: "$myapp#v1#articlelist#bob#second",
                __edd_e__: "ArticleItem",
                articleId: "a-2",
                title: "Second",
                author: "Bob",
                tags: ["ts"],
              }),
            ],
          })
          // Assembly queries (get each aggregate by PK)
          .mockResolvedValueOnce({
            Items: [
              toAttributeMap({
                pk: "$myapp#v1#article#a-1",
                sk: "$myapp#v1#articleitem",
                __edd_e__: "ArticleItem",
                articleId: "a-1",
                title: "First",
                author: "Alice",
                tags: [],
              }),
            ],
          })
          .mockResolvedValueOnce({
            Items: [
              toAttributeMap({
                pk: "$myapp#v1#article#a-2",
                sk: "$myapp#v1#articleitem",
                __edd_e__: "ArticleItem",
                articleId: "a-2",
                title: "Second",
                author: "Bob",
                tags: ["ts"],
              }),
            ],
          })

        const results = yield* ListAggregate.list()

        expect(results.data).toHaveLength(2)
        expect(results.data[0]!.articleId).toBe("a-1")
        expect(results.data[1]!.articleId).toBe("a-2")
        expect(results.cursor).toBeNull()

        // 1 GSI query + 2 assembly queries
        expect(mockListQuery).toHaveBeenCalledTimes(3)

        // Verify GSI query params
        const gsiInput = mockListQuery.mock.calls[0]![0]
        expect(gsiInput.IndexName).toBe("gsi1")
        expect(gsiInput.KeyConditionExpression).toBe("#pk = :pk")
        expect(gsiInput.ExpressionAttributeNames["#pk"]).toBe("gsi1pk")
        expect(gsiInput.ExpressionAttributeValues[":pk"]).toEqual({ S: "$myapp#v1#articlelist" })
      }).pipe(Effect.provide(ListLayer)),
    )

    it.effect("GSI query: filters by SK prefix using contiguous composites", () =>
      Effect.gen(function* () {
        // GSI query with SK prefix
        mockListQuery
          .mockResolvedValueOnce({
            Items: [
              toAttributeMap({
                pk: "$myapp#v1#article#a-1",
                sk: "$myapp#v1#articleitem",
                gsi1pk: "$myapp#v1#articlelist",
                gsi1sk: "$myapp#v1#articlelist#alice#first",
                __edd_e__: "ArticleItem",
                articleId: "a-1",
                title: "First",
                author: "Alice",
                tags: [],
              }),
            ],
          })
          // Assembly query
          .mockResolvedValueOnce({
            Items: [
              toAttributeMap({
                pk: "$myapp#v1#article#a-1",
                sk: "$myapp#v1#articleitem",
                __edd_e__: "ArticleItem",
                articleId: "a-1",
                title: "First",
                author: "Alice",
                tags: [],
              }),
            ],
          })

        const results = yield* ListAggregate.list({ author: "Alice" })

        expect(results.data).toHaveLength(1)
        expect(results.data[0]!.author).toBe("Alice")

        // Verify begins_with on SK
        const gsiInput = mockListQuery.mock.calls[0]![0]
        expect(gsiInput.KeyConditionExpression).toBe("#pk = :pk AND begins_with(#sk, :skPrefix)")
        expect(gsiInput.ExpressionAttributeNames["#sk"]).toBe("gsi1sk")
        expect(gsiInput.ExpressionAttributeValues[":skPrefix"]).toEqual({
          S: "$myapp#v1#articlelist#alice",
        })
      }).pipe(Effect.provide(ListLayer)),
    )

    it.effect("GSI query: returns empty array when no items match", () =>
      Effect.gen(function* () {
        mockListQuery.mockResolvedValueOnce({ Items: [] })

        const results = yield* ListAggregate.list({ author: "Nobody" })

        expect(results.data).toHaveLength(0)
        expect(results.cursor).toBeNull()
        expect(mockListQuery).toHaveBeenCalledOnce()
      }).pipe(Effect.provide(ListLayer)),
    )

    it.effect("GSI query with cardinality: fans out to N shard queries", () =>
      Effect.gen(function* () {
        const ShardedAggregate = Aggregate.make(Article, {
          table: MainTable,
          schema: AppSchema,
          pk: { field: "pk", composite: ["articleId"] },
          collection: {
            index: "lsi1",
            name: "article",
            sk: { field: "lsi1sk", composite: [] },
          },
          list: {
            index: "gsi1",
            name: "articlelist",
            pk: { field: "gsi1pk", composite: [] },
            sk: { field: "gsi1sk", composite: ["author"] },
            cardinality: 3,
          },
          root: { entityType: "ArticleItem" },
          edges: {},
        })

        // 3 shard queries — shard 0 has an item, shards 1 and 2 are empty
        mockListQuery
          .mockResolvedValueOnce({
            Items: [
              toAttributeMap({
                pk: "$myapp#v1#article#a-1",
                sk: "$myapp#v1#articleitem",
                gsi1pk: "$myapp#v1#articlelist#0",
                gsi1sk: "$myapp#v1#articlelist#alice",
                __edd_e__: "ArticleItem",
                articleId: "a-1",
                title: "First",
                author: "Alice",
                tags: [],
              }),
            ],
          })
          .mockResolvedValueOnce({ Items: [] })
          .mockResolvedValueOnce({ Items: [] })
          // Assembly query for the one found item
          .mockResolvedValueOnce({
            Items: [
              toAttributeMap({
                pk: "$myapp#v1#article#a-1",
                sk: "$myapp#v1#articleitem",
                __edd_e__: "ArticleItem",
                articleId: "a-1",
                title: "First",
                author: "Alice",
                tags: [],
              }),
            ],
          })

        const results = yield* ShardedAggregate.list()

        expect(results.data).toHaveLength(1)
        expect(results.data[0]!.articleId).toBe("a-1")
        expect(results.cursor).toBeNull()

        // 3 shard queries + 1 assembly query
        expect(mockListQuery).toHaveBeenCalledTimes(4)

        // Verify shard PKs
        const shard0Input = mockListQuery.mock.calls[0]![0]
        expect(shard0Input.ExpressionAttributeValues[":pk"]).toEqual({
          S: "$myapp#v1#articlelist#0",
        })
        const shard1Input = mockListQuery.mock.calls[1]![0]
        expect(shard1Input.ExpressionAttributeValues[":pk"]).toEqual({
          S: "$myapp#v1#articlelist#1",
        })
        const shard2Input = mockListQuery.mock.calls[2]![0]
        expect(shard2Input.ExpressionAttributeValues[":pk"]).toEqual({
          S: "$myapp#v1#articlelist#2",
        })
      }).pipe(Effect.provide(ListLayer)),
    )

    it.effect("pagination: returns cursor when limit is set and more items exist", () =>
      Effect.gen(function* () {
        const lastEvaluatedKey = {
          gsi1pk: { S: "$myapp#v1#articlelist" },
          gsi1sk: { S: "$myapp#v1#articlelist#alice#first" },
          pk: { S: "$myapp#v1#article#a-1" },
          sk: { S: "$myapp#v1#articleitem" },
        }

        // GSI query returns 1 item with LastEvaluatedKey (more pages)
        mockListQuery
          .mockResolvedValueOnce({
            Items: [
              toAttributeMap({
                pk: "$myapp#v1#article#a-1",
                sk: "$myapp#v1#articleitem",
                gsi1pk: "$myapp#v1#articlelist",
                gsi1sk: "$myapp#v1#articlelist#alice#first",
                __edd_e__: "ArticleItem",
                articleId: "a-1",
                title: "First",
                author: "Alice",
                tags: [],
              }),
            ],
            LastEvaluatedKey: lastEvaluatedKey,
          })
          // Assembly query for the root item
          .mockResolvedValueOnce({
            Items: [
              toAttributeMap({
                pk: "$myapp#v1#article#a-1",
                sk: "$myapp#v1#articleitem",
                __edd_e__: "ArticleItem",
                articleId: "a-1",
                title: "First",
                author: "Alice",
                tags: [],
              }),
            ],
          })

        const results = yield* ListAggregate.list(undefined, { limit: 1 })

        expect(results.data).toHaveLength(1)
        expect(results.data[0]!.articleId).toBe("a-1")
        expect(results.cursor).not.toBeNull()

        // Verify Limit was passed to DynamoDB query
        const gsiInput = mockListQuery.mock.calls[0]![0]
        expect(gsiInput.Limit).toBe(1)

        // Decode cursor and verify it matches the LastEvaluatedKey
        const decodedCursor = JSON.parse(atob(results.cursor!))
        expect(decodedCursor).toEqual(lastEvaluatedKey)
      }).pipe(Effect.provide(ListLayer)),
    )

    it.effect("pagination: uses cursor to resume from previous position", () =>
      Effect.gen(function* () {
        const startKey = {
          gsi1pk: { S: "$myapp#v1#articlelist" },
          gsi1sk: { S: "$myapp#v1#articlelist#alice#first" },
          pk: { S: "$myapp#v1#article#a-1" },
          sk: { S: "$myapp#v1#articleitem" },
        }
        const cursor = btoa(JSON.stringify(startKey))

        // GSI query returns next page with no LastEvaluatedKey (last page)
        mockListQuery
          .mockResolvedValueOnce({
            Items: [
              toAttributeMap({
                pk: "$myapp#v1#article#a-2",
                sk: "$myapp#v1#articleitem",
                gsi1pk: "$myapp#v1#articlelist",
                gsi1sk: "$myapp#v1#articlelist#bob#second",
                __edd_e__: "ArticleItem",
                articleId: "a-2",
                title: "Second",
                author: "Bob",
                tags: ["ts"],
              }),
            ],
          })
          // Assembly query
          .mockResolvedValueOnce({
            Items: [
              toAttributeMap({
                pk: "$myapp#v1#article#a-2",
                sk: "$myapp#v1#articleitem",
                __edd_e__: "ArticleItem",
                articleId: "a-2",
                title: "Second",
                author: "Bob",
                tags: ["ts"],
              }),
            ],
          })

        const results = yield* ListAggregate.list(undefined, { limit: 1, cursor })

        expect(results.data).toHaveLength(1)
        expect(results.data[0]!.articleId).toBe("a-2")
        expect(results.cursor).toBeNull()

        // Verify ExclusiveStartKey was passed
        const gsiInput = mockListQuery.mock.calls[0]![0]
        expect(gsiInput.ExclusiveStartKey).toEqual(startKey)
        expect(gsiInput.Limit).toBe(1)
      }).pipe(Effect.provide(ListLayer)),
    )

    it.effect("pagination: returns all items with null cursor when no limit specified", () =>
      Effect.gen(function* () {
        // GSI query returns items across two DynamoDB pages (no limit)
        mockListQuery
          .mockResolvedValueOnce({
            Items: [
              toAttributeMap({
                pk: "$myapp#v1#article#a-1",
                sk: "$myapp#v1#articleitem",
                gsi1pk: "$myapp#v1#articlelist",
                gsi1sk: "$myapp#v1#articlelist#alice#first",
                __edd_e__: "ArticleItem",
                articleId: "a-1",
                title: "First",
                author: "Alice",
                tags: [],
              }),
            ],
            LastEvaluatedKey: {
              gsi1pk: { S: "$myapp#v1#articlelist" },
              gsi1sk: { S: "$myapp#v1#articlelist#alice#first" },
              pk: { S: "$myapp#v1#article#a-1" },
              sk: { S: "$myapp#v1#articleitem" },
            },
          })
          .mockResolvedValueOnce({
            Items: [
              toAttributeMap({
                pk: "$myapp#v1#article#a-2",
                sk: "$myapp#v1#articleitem",
                gsi1pk: "$myapp#v1#articlelist",
                gsi1sk: "$myapp#v1#articlelist#bob#second",
                __edd_e__: "ArticleItem",
                articleId: "a-2",
                title: "Second",
                author: "Bob",
                tags: ["ts"],
              }),
            ],
          })
          // Assembly queries for both items
          .mockResolvedValueOnce({
            Items: [
              toAttributeMap({
                pk: "$myapp#v1#article#a-1",
                sk: "$myapp#v1#articleitem",
                __edd_e__: "ArticleItem",
                articleId: "a-1",
                title: "First",
                author: "Alice",
                tags: [],
              }),
            ],
          })
          .mockResolvedValueOnce({
            Items: [
              toAttributeMap({
                pk: "$myapp#v1#article#a-2",
                sk: "$myapp#v1#articleitem",
                __edd_e__: "ArticleItem",
                articleId: "a-2",
                title: "Second",
                author: "Bob",
                tags: ["ts"],
              }),
            ],
          })

        const results = yield* ListAggregate.list()

        expect(results.data).toHaveLength(2)
        expect(results.cursor).toBeNull()

        // Without limit, no Limit param is sent
        const gsiInput = mockListQuery.mock.calls[0]![0]
        expect(gsiInput.Limit).toBeUndefined()
      }).pipe(Effect.provide(ListLayer)),
    )

    // -----------------------------------------------------------------------
    // list — filter / reverse / sharded limit + cursor (#104)
    // -----------------------------------------------------------------------

    /** Root item as it appears on the list GSI. */
    const listRow = (id: string, author: string, title: string) =>
      toAttributeMap({
        pk: `$myapp#v1#article#${id}`,
        sk: "$myapp#v1#articleitem",
        gsi1pk: "$myapp#v1#articlelist",
        gsi1sk: `$myapp#v1#articlelist#${author.toLowerCase()}#${title.toLowerCase()}`,
        __edd_e__: "ArticleItem",
        articleId: id,
        title,
        author,
        tags: [],
      })

    /** The partition read `list` issues per surviving root item (the N+1). */
    const assemblyPage = (id: string, author: string, title: string) => ({
      Items: [
        toAttributeMap({
          pk: `$myapp#v1#article#${id}`,
          sk: "$myapp#v1#articleitem",
          __edd_e__: "ArticleItem",
          articleId: id,
          title,
          author,
          tags: [],
        }),
      ],
    })

    it.effect("filter shorthand compiles to a FilterExpression on the root query", () =>
      Effect.gen(function* () {
        // DynamoDB applies the FilterExpression server-side, so only Alice's
        // row comes back.
        mockListQuery
          .mockResolvedValueOnce({ Items: [listRow("a-1", "Alice", "First")] })
          .mockResolvedValueOnce(assemblyPage("a-1", "Alice", "First"))

        const results = yield* ListAggregate.list(undefined, { filter: { author: "Alice" } })

        expect(results.data).toHaveLength(1)
        expect(results.data[0]!.author).toBe("Alice")

        const gsiInput = mockListQuery.mock.calls[0]![0]
        expect(gsiInput.FilterExpression).toBeDefined()
        // The filter's placeholders live alongside the key-condition ones.
        const nameEntry = Object.entries(gsiInput.ExpressionAttributeNames).find(
          ([, v]) => v === "author",
        )
        expect(nameEntry).toBeDefined()
        expect(gsiInput.FilterExpression).toContain(nameEntry![0])
        expect(Object.values(gsiInput.ExpressionAttributeValues)).toContainEqual({ S: "Alice" })
      }).pipe(Effect.provide(ListLayer)),
    )

    it.effect("filter callback form compiles through the same Expr compiler", () =>
      Effect.gen(function* () {
        mockListQuery
          .mockResolvedValueOnce({ Items: [listRow("a-2", "Bob", "Second")] })
          .mockResolvedValueOnce(assemblyPage("a-2", "Bob", "Second"))

        const results = yield* ListAggregate.list(undefined, {
          filter: (t, { ne }) => ne(t.author, "Alice"),
        })

        expect(results.data).toHaveLength(1)
        const gsiInput = mockListQuery.mock.calls[0]![0]
        expect(gsiInput.FilterExpression).toContain("<>")
        expect(Object.values(gsiInput.ExpressionAttributeValues)).toContainEqual({ S: "Alice" })
      }).pipe(Effect.provide(ListLayer)),
    )

    it.effect('an empty shorthand filter is a no-op, not FilterExpression: ""', () =>
      Effect.gen(function* () {
        mockListQuery
          .mockResolvedValueOnce({ Items: [listRow("a-1", "Alice", "First")] })
          .mockResolvedValueOnce(assemblyPage("a-1", "Alice", "First"))

        yield* ListAggregate.list(undefined, { filter: {} })

        expect(mockListQuery.mock.calls[0]![0].FilterExpression).toBeUndefined()
      }).pipe(Effect.provide(ListLayer)),
    )

    it.effect("the N+1 assembly does NOT run for rows the filter rejected", () =>
      Effect.gen(function* () {
        // Unfiltered: two root items -> two partition assemblies (1 + 2 = 3).
        mockListQuery
          .mockResolvedValueOnce({
            Items: [listRow("a-1", "Alice", "First"), listRow("a-2", "Bob", "Second")],
          })
          .mockResolvedValueOnce(assemblyPage("a-1", "Alice", "First"))
          .mockResolvedValueOnce(assemblyPage("a-2", "Bob", "Second"))

        const unfiltered = yield* ListAggregate.list()
        expect(unfiltered.data).toHaveLength(2)
        expect(mockListQuery).toHaveBeenCalledTimes(3)

        mockListQuery.mockReset()

        // Filtered: the same partition, but Bob's row never reaches the client,
        // so his assembly read is never issued (1 + 1 = 2).
        mockListQuery
          .mockResolvedValueOnce({ Items: [listRow("a-1", "Alice", "First")] })
          .mockResolvedValueOnce(assemblyPage("a-1", "Alice", "First"))

        const filtered = yield* ListAggregate.list(undefined, { filter: { author: "Alice" } })
        expect(filtered.data).toHaveLength(1)
        expect(mockListQuery).toHaveBeenCalledTimes(2)
      }).pipe(Effect.provide(ListLayer)),
    )

    it.effect("under a filter, limit accumulates across requests that return nothing", () =>
      Effect.gen(function* () {
        const lek = (id: string) => ({
          gsi1pk: { S: "$myapp#v1#articlelist" },
          gsi1sk: { S: `$myapp#v1#articlelist#${id}` },
          pk: { S: `$myapp#v1#article#${id}` },
          sk: { S: "$myapp#v1#articleitem" },
        })

        mockListQuery
          // Two requests examine rows that all fail the filter.
          .mockResolvedValueOnce({ Items: [], LastEvaluatedKey: lek("x-1") })
          .mockResolvedValueOnce({ Items: [], LastEvaluatedKey: lek("x-2") })
          .mockResolvedValueOnce({
            Items: [listRow("a-1", "Alice", "First")],
            LastEvaluatedKey: lek("a-1"),
          })
          .mockResolvedValueOnce({
            Items: [listRow("a-3", "Alice", "Third")],
            LastEvaluatedKey: lek("a-3"),
          })
          .mockResolvedValueOnce(assemblyPage("a-1", "Alice", "First"))
          .mockResolvedValueOnce(assemblyPage("a-3", "Alice", "Third"))

        const results = yield* ListAggregate.list(undefined, {
          limit: 2,
          pageSize: 5,
          filter: { author: "Alice" },
        })

        // A full page of MATCHING aggregates, not a short one.
        expect(results.data.map((a) => a.articleId)).toEqual(["a-1", "a-3"])
        // 4 root requests + 2 assemblies.
        expect(mockListQuery).toHaveBeenCalledTimes(6)
        // Every root request asked for pageSize rows — `limit` cannot be a
        // DynamoDB `Limit` under a filter, because `Limit` bounds rows examined.
        for (const call of mockListQuery.mock.calls.slice(0, 4)) {
          expect(call[0].Limit).toBe(5)
        }
        // More to come, so the cursor is not null.
        expect(results.cursor).not.toBeNull()
        expect(JSON.parse(atob(results.cursor!))).toEqual(lek("a-3"))
      }).pipe(Effect.provide(ListLayer)),
    )

    it.effect("an over-reading request rebuilds the cursor from the last item RETURNED", () =>
      Effect.gen(function* () {
        // Three matches come back in one request with no LastEvaluatedKey; the
        // caller asked for two, so the third is discarded and must be re-read.
        mockListQuery
          .mockResolvedValueOnce({
            Items: [
              listRow("a-1", "Alice", "First"),
              listRow("a-2", "Alice", "Second"),
              listRow("a-3", "Alice", "Third"),
            ],
          })
          .mockResolvedValueOnce(assemblyPage("a-1", "Alice", "First"))
          .mockResolvedValueOnce(assemblyPage("a-2", "Alice", "Second"))

        const results = yield* ListAggregate.list(undefined, {
          limit: 2,
          filter: { author: "Alice" },
        })

        expect(results.data.map((a) => a.articleId)).toEqual(["a-1", "a-2"])
        // Not null — a-3 was read and dropped, so the range is NOT exhausted.
        expect(results.cursor).not.toBeNull()
        // Rebuilt from a-2 (the last item handed back), not from a-3.
        expect(JSON.parse(atob(results.cursor!))).toEqual({
          pk: { S: "$myapp#v1#article#a-2" },
          sk: { S: "$myapp#v1#articleitem" },
          gsi1pk: { S: "$myapp#v1#articlelist" },
          gsi1sk: { S: "$myapp#v1#articlelist#alice#second" },
        })
      }).pipe(Effect.provide(ListLayer)),
    )

    it.effect("cursor is null when the filtered range is genuinely exhausted", () =>
      Effect.gen(function* () {
        mockListQuery
          .mockResolvedValueOnce({ Items: [listRow("a-1", "Alice", "First")] })
          .mockResolvedValueOnce(assemblyPage("a-1", "Alice", "First"))

        const results = yield* ListAggregate.list(undefined, {
          limit: 10,
          filter: { author: "Alice" },
        })

        expect(results.data).toHaveLength(1)
        expect(results.cursor).toBeNull()
      }).pipe(Effect.provide(ListLayer)),
    )

    it.effect("reverse walks the list index descending", () =>
      Effect.gen(function* () {
        mockListQuery
          .mockResolvedValueOnce({ Items: [listRow("a-2", "Bob", "Second")] })
          .mockResolvedValueOnce(assemblyPage("a-2", "Bob", "Second"))

        yield* ListAggregate.list(undefined, { reverse: true })

        expect(mockListQuery.mock.calls[0]![0].ScanIndexForward).toBe(false)
      }).pipe(Effect.provide(ListLayer)),
    )

    it.effect("forward order sends no ScanIndexForward", () =>
      Effect.gen(function* () {
        mockListQuery
          .mockResolvedValueOnce({ Items: [listRow("a-1", "Alice", "First")] })
          .mockResolvedValueOnce(assemblyPage("a-1", "Alice", "First"))

        yield* ListAggregate.list()

        expect(mockListQuery.mock.calls[0]![0].ScanIndexForward).toBeUndefined()
      }).pipe(Effect.provide(ListLayer)),
    )

    describe("sharded (cardinality)", () => {
      const ShardedAggregate = Aggregate.make(Article, {
        table: MainTable,
        schema: AppSchema,
        pk: { field: "pk", composite: ["articleId"] },
        collection: {
          index: "lsi1",
          name: "article",
          sk: { field: "lsi1sk", composite: [] },
        },
        list: {
          index: "gsi1",
          name: "articlelist",
          pk: { field: "gsi1pk", composite: [] },
          sk: { field: "gsi1sk", composite: ["author"] },
          cardinality: 3,
        },
        root: { entityType: "ArticleItem" },
        edges: {},
      })

      it.effect("limit truncates the merged fan-out", () =>
        Effect.gen(function* () {
          mockListQuery
            .mockResolvedValueOnce({ Items: [listRow("a-1", "Alice", "First")] })
            .mockResolvedValueOnce({ Items: [listRow("a-2", "Bob", "Second")] })
            .mockResolvedValueOnce({ Items: [listRow("a-3", "Cara", "Third")] })
            .mockResolvedValueOnce(assemblyPage("a-1", "Alice", "First"))
            .mockResolvedValueOnce(assemblyPage("a-2", "Bob", "Second"))

          const results = yield* ShardedAggregate.list(undefined, { limit: 2 })

          // Previously the option was accepted and discarded — all three came back.
          expect(results.data.map((a) => a.articleId)).toEqual(["a-1", "a-2"])
          // 3 shard queries + 2 assemblies — the truncated row is never assembled.
          expect(mockListQuery).toHaveBeenCalledTimes(5)
          // Each shard is bounded by the same limit; no shard can exceed the page.
          for (const call of mockListQuery.mock.calls.slice(0, 3)) {
            expect(call[0].Limit).toBe(2)
          }
          // No resumable position across shards.
          expect(results.cursor).toBeNull()
        }).pipe(Effect.provide(ListLayer)),
      )

      it.effect("a cursor is rejected with EDD-9051 rather than silently ignored", () =>
        Effect.gen(function* () {
          const cursor = btoa(JSON.stringify({ pk: { S: "$myapp#v1#article#a-1" } }))

          const error = yield* Effect.flip(ShardedAggregate.list(undefined, { limit: 2, cursor }))

          expect(error._tag).toBe("ValidationError")
          expect((error as { cause: string }).cause).toContain("EDD-9051")
          // No request was issued at all.
          expect(mockListQuery).not.toHaveBeenCalled()
        }).pipe(Effect.provide(ListLayer)),
      )

      it.effect("filter and reverse reach every shard", () =>
        Effect.gen(function* () {
          mockListQuery
            .mockResolvedValueOnce({ Items: [listRow("a-1", "Alice", "First")] })
            .mockResolvedValueOnce({ Items: [] })
            .mockResolvedValueOnce({ Items: [] })
            .mockResolvedValueOnce(assemblyPage("a-1", "Alice", "First"))

          yield* ShardedAggregate.list(undefined, {
            filter: { author: "Alice" },
            reverse: true,
          })

          for (const call of mockListQuery.mock.calls.slice(0, 3)) {
            expect(call[0].FilterExpression).toBeDefined()
            expect(call[0].ScanIndexForward).toBe(false)
          }
        }).pipe(Effect.provide(ListLayer)),
      )
    })
  })
})
