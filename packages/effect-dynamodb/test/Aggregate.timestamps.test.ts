import { describe, expect, it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { DynamoError } from "@effect-dynamodb/schema/Errors.js"
import { Duration, Effect, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { beforeEach, vi } from "vitest"
import * as Aggregate from "../src/Aggregate.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FROZEN_MS = 1_700_000_000_000
const FROZEN_ISO = new Date(FROZEN_MS).toISOString()

class Player extends Schema.Class<Player>("Player")({
  playerId: Schema.String.pipe(DynamoModel.identifier),
  displayName: Schema.String,
}) {}

class Venue extends Schema.Class<Venue>("Venue")({
  venueId: Schema.String.pipe(DynamoModel.identifier),
  name: Schema.String,
}) {}

class Match extends Schema.Class<Match>("Match")({
  matchId: Schema.String,
  name: Schema.String,
  venue: Venue,
  players: Schema.Array(Player),
}) {}

const AppSchema = DynamoSchema.make({ name: "myapp", version: 1 })

const PlayerEntity = Entity.make({
  model: Player,
  entityType: "Player",
  primaryKey: {
    pk: { field: "pk", composite: ["playerId"] },
    sk: { field: "sk", composite: [] },
  },
})

const VenueEntity = Entity.make({
  model: Venue,
  entityType: "Venue",
  primaryKey: {
    pk: { field: "pk", composite: ["venueId"] },
    sk: { field: "sk", composite: [] },
  },
})

const MainTable = Table.make({ schema: AppSchema, entities: { PlayerEntity, VenueEntity } })

const baseConfig = {
  table: MainTable,
  schema: AppSchema,
  pk: { field: "pk", composite: ["matchId"] as const },
  collection: {
    index: "lsi1",
    name: "match",
    sk: { field: "lsi1sk", composite: [] },
  },
  root: { entityType: "MatchItem" },
  edges: {
    venue: Aggregate.one("venue", { entityType: "MatchVenue" }),
    players: Aggregate.many("players", { entityType: "MatchPlayer", composite: ["playerId"] }),
  },
}

// Default names, default (ISO string) storage.
const DefaultTimestamps = Aggregate.make(Match, { ...baseConfig, timestamps: true })

// ElectroDB-shaped: custom names, epoch-millis storage (the #98 driver).
const EpochTimestamps = Aggregate.make(Match, {
  ...baseConfig,
  timestamps: {
    created: { field: "created", schema: DynamoModel.DateEpochMs },
    updated: { field: "updated", schema: DynamoModel.DateEpochMs },
  },
})

const NoTimestamps = Aggregate.make(Match, baseConfig)

// A sub-aggregate puts its rows in their OWN transaction group, which is what
// makes diff narrowing observable: the flat fixture above keeps every edge in
// the "root" group, so any root change rewrites all of it.
class Squad extends Schema.Class<Squad>("Squad")({
  squadName: Schema.String,
  players: Schema.Array(Player),
}) {}

class Fixture extends Schema.Class<Fixture>("Fixture")({
  matchId: Schema.String,
  name: Schema.String,
  squad: Squad,
}) {}

const SquadSub = Aggregate.make(Squad, {
  root: { entityType: "MatchSquad" },
  edges: {
    players: Aggregate.many("players", { entityType: "MatchPlayer", composite: ["playerId"] }),
  },
})

const SubAggregateTimestamps = Aggregate.make(Fixture, {
  table: MainTable,
  schema: AppSchema,
  pk: { field: "pk", composite: ["matchId"] },
  collection: { index: "lsi1", name: "match", sk: { field: "lsi1sk", composite: [] } },
  root: { entityType: "FixtureItem" },
  edges: { squad: SquadSub.with({ discriminator: { squadNumber: 1 } }) },
  timestamps: {
    created: { field: "created", schema: DynamoModel.DateEpochMs },
    updated: { field: "updated", schema: DynamoModel.DateEpochMs },
  },
})

const fixtureInput = {
  matchId: "f-1",
  name: "Final",
  squad: {
    squadName: "First XI",
    players: [
      { playerId: "p-1", displayName: "Ada" },
      { playerId: "p-2", displayName: "Grace" },
    ],
  },
}

// ---------------------------------------------------------------------------
// Mock client
// ---------------------------------------------------------------------------

const mockQuery = vi.fn()
const mockTransactWrite = vi.fn()

const TestDynamoClient = Layer.succeed(DynamoClient, {
  query: (input) =>
    Effect.tryPromise({
      try: () => mockQuery(input),
      catch: (e) => new DynamoError({ operation: "Query", cause: e }),
    }),
  transactWriteItems: (input) =>
    Effect.tryPromise({
      try: () => mockTransactWrite(input),
      catch: (e) => new DynamoError({ operation: "TransactWriteItems", cause: e }),
    }),
  putItem: () => Effect.die("not used"),
  getItem: () => Effect.die("not used"),
  deleteItem: () => Effect.die("not used"),
  updateItem: () => Effect.die("not used"),
  batchGetItem: () => Effect.die("not used"),
  batchWriteItem: () => Effect.die("not used"),
  transactGetItems: () => Effect.die("not used"),
  createTable: () => Effect.die("not used"),
  deleteTable: () => Effect.die("not used"),
  describeTable: () => Effect.die("not used"),
  scan: () => Effect.die("not used"),
})

const TestLayer = Layer.merge(TestDynamoClient, MainTable.layer({ name: "test-table" }))

const input = {
  matchId: "m-1",
  name: "Final",
  venue: { venueId: "v-1", name: "MCG" },
  players: [
    { playerId: "p-1", displayName: "Ada" },
    { playerId: "p-2", displayName: "Grace" },
  ],
}

/** Every Item written across all transactions, in write order. */
const writtenItems = (): Array<Record<string, any>> =>
  mockTransactWrite.mock.calls
    .flatMap((call) => call[0].TransactItems as Array<Record<string, any>>)
    .filter((t) => t.Put !== undefined)
    .map((t) => t.Put.Item)

describe("Aggregate timestamps", () => {
  beforeEach(() => {
    mockQuery.mockReset()
    mockTransactWrite.mockReset()
  })

  // -------------------------------------------------------------------------
  // create
  // -------------------------------------------------------------------------

  it.effect("create stamps every row — root and edges alike", () =>
    Effect.gen(function* () {
      yield* TestClock.adjust(Duration.millis(FROZEN_MS))
      mockTransactWrite.mockResolvedValue({})

      yield* DefaultTimestamps.create(input)

      const items = writtenItems()
      // root + venue + 2 players
      expect(items).toHaveLength(4)
      for (const item of items) {
        expect(item.createdAt.S).toBe(FROZEN_ISO)
        expect(item.updatedAt.S).toBe(FROZEN_ISO)
      }
      // Edge rows are covered, not just the root (the #98 complaint).
      const entityTypes = items.map((i) => i.__edd_e__.S).sort()
      expect(entityTypes).toEqual(["MatchItem", "MatchPlayer", "MatchPlayer", "MatchVenue"])
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("create honours custom field names and epoch-millis storage", () =>
    Effect.gen(function* () {
      yield* TestClock.adjust(Duration.millis(FROZEN_MS))
      mockTransactWrite.mockResolvedValue({})

      yield* EpochTimestamps.create(input)

      for (const item of writtenItems()) {
        expect(item.created.N).toBe(String(FROZEN_MS))
        expect(item.updated.N).toBe(String(FROZEN_MS))
        expect(item.createdAt).toBeUndefined()
        expect(item.updatedAt).toBeUndefined()
      }
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("no timestamps config → no timestamp attributes", () =>
    Effect.gen(function* () {
      yield* TestClock.adjust(Duration.millis(FROZEN_MS))
      mockTransactWrite.mockResolvedValue({})

      yield* NoTimestamps.create(input)

      for (const item of writtenItems()) {
        expect(item.createdAt).toBeUndefined()
        expect(item.updatedAt).toBeUndefined()
      }
    }).pipe(Effect.provide(TestLayer)),
  )

  // -------------------------------------------------------------------------
  // update
  // -------------------------------------------------------------------------

  /** Create once, then replay the written items as the stored partition. */
  const seed = (
    aggregate: { create: (i: any) => Effect.Effect<any, any, any> },
    createInput: unknown = input,
  ) =>
    Effect.gen(function* () {
      mockTransactWrite.mockResolvedValue({})
      yield* aggregate.create(createInput)
      const stored = writtenItems()
      mockTransactWrite.mockReset()
      mockTransactWrite.mockResolvedValue({})
      mockQuery.mockResolvedValueOnce({ Items: stored, LastEvaluatedKey: undefined })
      return stored
    })

  it.effect("update carries `created` forward and bumps `updated`", () =>
    Effect.gen(function* () {
      yield* TestClock.adjust(Duration.millis(FROZEN_MS))
      yield* seed(EpochTimestamps)

      // A second instant, so a carried-forward `created` is distinguishable.
      yield* TestClock.adjust(Duration.millis(5_000))

      yield* EpochTimestamps.update({ matchId: "m-1" }, ({ state }) => ({
        ...state,
        name: "Grand Final",
      }))

      // The flat fixture keeps every edge in the root transaction group, so a
      // root change rewrites all four rows.
      const rewritten = writtenItems()
      expect(rewritten).toHaveLength(4)
      for (const item of rewritten) {
        expect(item.created.N).toBe(String(FROZEN_MS))
        expect(item.updated.N).toBe(String(FROZEN_MS + 5_000))
      }
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("update leaves untouched sub-aggregate rows alone — the diff still narrows", () =>
    Effect.gen(function* () {
      yield* TestClock.adjust(Duration.millis(FROZEN_MS))
      const stored = yield* seed(SubAggregateTimestamps, fixtureInput)
      expect(stored).toHaveLength(4) // root + squad root + 2 players
      yield* TestClock.adjust(Duration.millis(5_000))

      // Mutating the root only must not rewrite the squad's transaction group.
      yield* SubAggregateTimestamps.update({ matchId: "f-1" }, ({ state }) => ({
        ...state,
        name: "Grand Final",
      }))

      const rewritten = writtenItems()
      expect(rewritten.map((i) => i.__edd_e__.S)).toEqual(["FixtureItem"])
      expect(rewritten[0]!.updated.N).toBe(String(FROZEN_MS + 5_000))
      // The squad rows still carry their original stamp — `updated` is per row.
      const squadRows = stored.filter((i) => i.__edd_e__.S !== "FixtureItem")
      for (const row of squadRows) expect(row.updated.N).toBe(String(FROZEN_MS))
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("a no-op update writes nothing — timestamps do not defeat the diff", () =>
    Effect.gen(function* () {
      yield* TestClock.adjust(Duration.millis(FROZEN_MS))
      yield* seed(EpochTimestamps)
      yield* TestClock.adjust(Duration.millis(5_000))

      yield* EpochTimestamps.update({ matchId: "m-1" }, ({ state }) => state)

      expect(mockTransactWrite).not.toHaveBeenCalled()
    }).pipe(Effect.provide(TestLayer)),
  )

  // -------------------------------------------------------------------------
  // read path
  // -------------------------------------------------------------------------

  it.effect("get does not leak timestamp attributes into the domain object", () =>
    Effect.gen(function* () {
      yield* TestClock.adjust(Duration.millis(FROZEN_MS))
      yield* seed(EpochTimestamps)

      const match = yield* EpochTimestamps.get({ matchId: "m-1" })

      expect(match).toBeInstanceOf(Match)
      expect(Object.keys(match)).not.toContain("created")
      expect(Object.keys(match)).not.toContain("updated")
      expect(Object.keys(match.venue)).not.toContain("updated")
      expect(Object.keys(match.players[0]!)).not.toContain("updated")
      expect(match.name).toBe("Final")
      expect(match.players.map((p) => p.playerId)).toEqual(["p-1", "p-2"])
    }).pipe(Effect.provide(TestLayer)),
  )

  // -------------------------------------------------------------------------
  // model collision
  // -------------------------------------------------------------------------

  describe("root model declaring the timestamp field", () => {
    class Tracked extends Schema.Class<Tracked>("Tracked")({
      matchId: Schema.String,
      name: Schema.String,
      updated: DynamoModel.DateEpochMs,
    }) {}

    const TrackedAggregate = Aggregate.make(Tracked, {
      table: MainTable,
      schema: AppSchema,
      pk: { field: "pk", composite: ["matchId"] },
      collection: { index: "lsi1", name: "match", sk: { field: "lsi1sk", composite: [] } },
      root: { entityType: "TrackedItem" },
      edges: {},
      timestamps: { updated: { field: "updated" } },
    })

    it.effect("library manages it, using the model's encoding, and it round-trips", () =>
      Effect.gen(function* () {
        yield* TestClock.adjust(Duration.millis(FROZEN_MS))
        mockTransactWrite.mockResolvedValue({})

        yield* TrackedAggregate.create({
          matchId: "m-9",
          name: "Tracked",
          updated: new Date(0),
        })

        const stored = writtenItems()
        // Model encoding (epoch millis) wins over the ISO-string default, and the
        // caller-supplied value is replaced by the generated one.
        expect(stored[0]!.updated.N).toBe(String(FROZEN_MS))

        mockQuery.mockResolvedValueOnce({ Items: stored, LastEvaluatedKey: undefined })
        const read = yield* TrackedAggregate.get({ matchId: "m-9" })
        // Declared by the model → kept on the domain object, not stripped.
        expect(read.updated).toBeDefined()
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  // -------------------------------------------------------------------------
  // EDD-9044 (shared with Entity — see #97)
  // -------------------------------------------------------------------------

  it("rejects a timestamps schema with no DynamoEncoding annotation", () => {
    expect(() =>
      Aggregate.make(Match, {
        ...baseConfig,
        timestamps: { updated: { field: "updated", schema: Schema.Number } },
      }),
    ).toThrow(/EDD-9044/)
  })
})
