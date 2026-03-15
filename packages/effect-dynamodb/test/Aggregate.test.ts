import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Schema } from "effect"
import { beforeEach, vi } from "vitest"
import * as Aggregate from "../src/Aggregate.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as DynamoModel from "../src/DynamoModel.js"
import * as DynamoSchema from "../src/DynamoSchema.js"
import * as Entity from "../src/Entity.js"
import { type AggregateAssemblyError, DynamoError, type RefNotFound } from "../src/Errors.js"
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
const MainTable = Table.make({ schema: AppSchema })

const VenueEntity = Entity.make({
  model: Venue,
  table: MainTable,
  entityType: "Venue",
  indexes: {
    primary: {
      pk: { field: "pk", composite: ["venueId"] },
      sk: { field: "sk", composite: [] },
    },
  },
})

const TeamEntity = Entity.make({
  model: Team,
  table: MainTable,
  entityType: "Team",
  indexes: {
    primary: {
      pk: { field: "pk", composite: ["teamId"] },
      sk: { field: "sk", composite: [] },
    },
  },
})

const CoachEntity = Entity.make({
  model: Coach,
  table: MainTable,
  entityType: "Coach",
  indexes: {
    primary: {
      pk: { field: "pk", composite: ["coachId"] },
      sk: { field: "sk", composite: [] },
    },
  },
})

const PlayerEntity = Entity.make({
  model: Player,
  table: MainTable,
  entityType: "Player",
  indexes: {
    primary: {
      pk: { field: "pk", composite: ["playerId"] },
      sk: { field: "sk", composite: [] },
    },
  },
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
      table: MainTable,
      entityType: "Umpire",
      indexes: {
        primary: {
          pk: { field: "pk", composite: ["umpireId"] },
          sk: { field: "sk", composite: [] },
        },
      },
    })

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
        comments: Aggregate.many("comments", { entityType: "PostComment" }),
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
            pk: "$myapp#v1#venue#v-1",
            sk: "$myapp#v1#venue",
            __edd_e__: "Venue",
            venueId: "v-1",
            name: "MCG",
            city: "Melbourne",
          },
          "team-aus": {
            pk: "$myapp#v1#team#t-aus",
            sk: "$myapp#v1#team",
            __edd_e__: "Team",
            teamId: "t-aus",
            name: "Australia",
            country: "Australia",
          },
          "team-ind": {
            pk: "$myapp#v1#team#t-ind",
            sk: "$myapp#v1#team",
            __edd_e__: "Team",
            teamId: "t-ind",
            name: "India",
            country: "India",
          },
          "coach-1": {
            pk: "$myapp#v1#coach#c-1",
            sk: "$myapp#v1#coach",
            __edd_e__: "Coach",
            coachId: "c-1",
            name: "Andrew McDonald",
          },
          "coach-2": {
            pk: "$myapp#v1#coach#c-2",
            sk: "$myapp#v1#coach",
            __edd_e__: "Coach",
            coachId: "c-2",
            name: "Gautam Gambhir",
          },
          "player-smith": {
            pk: "$myapp#v1#player#p-smith",
            sk: "$myapp#v1#player",
            __edd_e__: "Player",
            playerId: "p-smith",
            displayName: "Steve Smith",
            role: "batter",
          },
          "player-kohli": {
            pk: "$myapp#v1#player#p-kohli",
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
          table: MainTable,
          entityType: "RefTarget",
          indexes: {
            primary: {
              pk: { field: "pk", composite: ["refId"] },
              sk: { field: "sk", composite: [] },
            },
          },
        })

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

  describe("ManyEdge inputField", () => {
    // "Element IS entity" case: Umpire[] → inputField renames to matchUmpireIds: string[]
    class Umpire extends Schema.Class<Umpire>("Umpire")({
      umpireId: Schema.String.pipe(DynamoModel.identifier),
      name: Schema.String,
    }) {}

    const UmpireEntity = Entity.make({
      model: Umpire,
      table: MainTable,
      entityType: "Umpire",
      indexes: {
        primary: {
          pk: { field: "pk", composite: ["umpireId"] },
          sk: { field: "sk", composite: [] },
        },
      },
    })

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
            pk: "$myapp#v1#umpire#u-1",
            sk: "$myapp#v1#umpire",
            __edd_e__: "Umpire",
            umpireId: "u-1",
            name: "Ravi Bowen",
          },
          "u-2": {
            pk: "$myapp#v1#umpire#u-2",
            sk: "$myapp#v1#umpire",
            __edd_e__: "Umpire",
            umpireId: "u-2",
            name: "Kumar D.",
          },
          "u-3": {
            pk: "$myapp#v1#umpire#u-3",
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
          S: "$myapp#v1#articlelist#Alice",
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
  })
})
