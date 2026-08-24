import { describe, expect, it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import {
  AppendTooLarge,
  DynamoError,
  TRANSACT_WRITE_ITEMS_LIMIT,
  VersionConflict,
} from "@effect-dynamodb/schema/Errors.js"
import { Data, DateTime, Effect, Layer, Schema } from "effect"
import { beforeEach, vi } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import * as EventStore from "../src/EventStore.js"
import { fromAttributeMap, toAttributeMap } from "../src/Marshaller.js"
import * as Query from "../src/Query.js"
import * as Table from "../src/Table.js"

// ---------------------------------------------------------------------------
// Test setup — Schema, Table, Event classes
// ---------------------------------------------------------------------------

const AppSchema = DynamoSchema.make({ name: "cricket", version: 1 })
const EventsTable = Table.make({ schema: AppSchema })

class MatchStarted extends Schema.Class<MatchStarted>("MatchStarted")({
  venue: Schema.String,
  homeTeam: Schema.String,
  awayTeam: Schema.String,
}) {}

class InningsCompleted extends Schema.Class<InningsCompleted>("InningsCompleted")({
  innings: Schema.Number,
  runs: Schema.Number,
  wickets: Schema.Number,
}) {}

class MatchEnded extends Schema.Class<MatchEnded>("MatchEnded")({
  result: Schema.String,
}) {}

type MatchEvent = MatchStarted | InningsCompleted | MatchEnded

const MatchEvents = EventStore.makeStream({
  table: EventsTable,
  streamName: "Match",
  events: [MatchStarted, InningsCompleted, MatchEnded],
  streamId: { composite: ["matchId"] },
})

// ---------------------------------------------------------------------------
// Decider for command handler tests
// ---------------------------------------------------------------------------

interface MatchState {
  readonly status: "pending" | "in-progress" | "completed"
  readonly innings: ReadonlyArray<{ runs: number; wickets: number }>
}

type MatchCommand =
  | {
      readonly _tag: "StartMatch"
      readonly venue: string
      readonly homeTeam: string
      readonly awayTeam: string
    }
  | {
      readonly _tag: "CompleteInnings"
      readonly innings: number
      readonly runs: number
      readonly wickets: number
    }
  | { readonly _tag: "EndMatch"; readonly result: string }

class AlreadyStarted extends Data.TaggedError("AlreadyStarted") {}
class NotStarted extends Data.TaggedError("NotStarted") {}

const matchDecider: EventStore.Decider<
  MatchState,
  MatchCommand,
  MatchEvent,
  AlreadyStarted | NotStarted
> = {
  initialState: { status: "pending", innings: [] },
  decide: (command, state) =>
    Effect.gen(function* () {
      if (command._tag === "StartMatch") {
        if (state.status !== "pending") return yield* new AlreadyStarted()
        return [
          new MatchStarted({
            venue: command.venue,
            homeTeam: command.homeTeam,
            awayTeam: command.awayTeam,
          }),
        ]
      }
      if (command._tag === "CompleteInnings") {
        if (state.status !== "in-progress") return yield* new NotStarted()
        return [
          new InningsCompleted({
            innings: command.innings,
            runs: command.runs,
            wickets: command.wickets,
          }),
        ]
      }
      if (command._tag === "EndMatch") {
        if (state.status !== "in-progress") return yield* new NotStarted()
        return [new MatchEnded({ result: command.result })]
      }
      return []
    }),
  evolve: (state, event) => {
    if (event instanceof MatchStarted) return { ...state, status: "in-progress" as const }
    if (event instanceof InningsCompleted)
      return { ...state, innings: [...state.innings, { runs: event.runs, wickets: event.wickets }] }
    if (event instanceof MatchEnded) return { ...state, status: "completed" as const }
    return state
  },
}

// ---------------------------------------------------------------------------
// Mock DynamoClient
// ---------------------------------------------------------------------------

const mockQuery = vi.fn()
const mockTransactWriteItems = vi.fn()

const TestDynamoClient = Layer.succeed(DynamoClient, {
  query: (input) =>
    Effect.tryPromise({
      try: () => mockQuery(input),
      catch: (e) => new DynamoError({ operation: "Query", cause: e }),
    }),
  transactWriteItems: (input) =>
    Effect.tryPromise({
      try: () => mockTransactWriteItems(input),
      catch: (e) => new DynamoError({ operation: "TransactWriteItems", cause: e }),
    }),
  putItem: () => Effect.die("not used"),
  getItem: () => Effect.die("not used"),
  deleteItem: () => Effect.die("not used"),
  updateItem: () => Effect.die("not used"),
  scan: () => Effect.die("not used"),
  batchGetItem: () => Effect.die("not used"),
  batchWriteItem: () => Effect.die("not used"),
  transactGetItems: () => Effect.die("not used"),
  createTable: () => Effect.die("not used"),
  deleteTable: () => Effect.die("not used"),
  describeTable: () => Effect.die("not used"),
})

const TestTableConfig = EventsTable.layer({ name: "events-table" })
const TestLayer = Layer.merge(TestDynamoClient, TestTableConfig)

beforeEach(() => {
  vi.resetAllMocks()
})

// ---------------------------------------------------------------------------
// Helper to build mock query results
// ---------------------------------------------------------------------------

const makeEventItem = (
  streamId: string,
  version: number,
  eventType: string,
  data: Record<string, unknown>,
) =>
  toAttributeMap({
    pk: `$cricket#v1#match#${streamId}`,
    sk: DynamoSchema.composeEventVersionKey(AppSchema, "match.event", version),
    __edd_e__: "match.event",
    streamId,
    version,
    eventType,
    data: { _tag: eventType, ...data },
    timestamp: "2026-03-08T12:00:00.000Z",
  })

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("EventStore", () => {
  // -------------------------------------------------------------------------
  // makeStream construction
  // -------------------------------------------------------------------------

  describe("makeStream", () => {
    it("creates a stream with correct streamName", () => {
      expect(MatchEvents.streamName).toBe("Match")
    })

    it("creates a stream with eventSchema", () => {
      expect(MatchEvents.eventSchema).toBeDefined()
    })

    it("single event schema works", () => {
      const SingleEventStream = EventStore.makeStream({
        table: EventsTable,
        streamName: "Simple",
        events: [MatchStarted],
        streamId: { composite: ["matchId"] },
      })
      expect(SingleEventStream.streamName).toBe("Simple")
    })
  })

  // -------------------------------------------------------------------------
  // append
  // -------------------------------------------------------------------------

  describe("append", () => {
    it.effect("appends events via transactWriteItems", () =>
      Effect.gen(function* () {
        mockTransactWriteItems.mockResolvedValue({})

        const result = yield* MatchEvents.append(
          { matchId: "m-1" },
          [new MatchStarted({ venue: "MCG", homeTeam: "AUS", awayTeam: "ENG" })],
          0,
        )

        expect(result.version).toBe(1)
        expect(result.events).toHaveLength(1)
        expect(mockTransactWriteItems).toHaveBeenCalledOnce()

        const call = mockTransactWriteItems.mock.calls[0]![0]
        expect(call.TransactItems).toHaveLength(1)

        const putItem = call.TransactItems[0].Put
        expect(putItem.TableName).toBe("events-table")
        expect(putItem.ConditionExpression).toBe("attribute_not_exists(pk)")

        // Verify item structure
        const item = fromAttributeMap(putItem.Item)
        expect(item.pk).toBe("$cricket#v1#match#m-1")
        expect(item.__edd_e__).toBe("match.event")
        expect(item.streamId).toBe("m-1")
        expect(item.version).toBe(1)
        expect(item.eventType).toBe("MatchStarted")
        expect(item.data).toEqual({
          _tag: "MatchStarted",
          venue: "MCG",
          homeTeam: "AUS",
          awayTeam: "ENG",
        })
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("appends multiple events atomically", () =>
      Effect.gen(function* () {
        mockTransactWriteItems.mockResolvedValue({})

        const result = yield* MatchEvents.append(
          { matchId: "m-1" },
          [
            new MatchStarted({ venue: "MCG", homeTeam: "AUS", awayTeam: "ENG" }),
            new InningsCompleted({ innings: 1, runs: 250, wickets: 10 }),
          ],
          0,
        )

        expect(result.version).toBe(2)
        expect(result.events).toHaveLength(2)

        const call = mockTransactWriteItems.mock.calls[0]![0]
        expect(call.TransactItems).toHaveLength(2)

        // Verify version numbers
        const item1 = fromAttributeMap(call.TransactItems[0].Put.Item)
        const item2 = fromAttributeMap(call.TransactItems[1].Put.Item)
        expect(item1.version).toBe(1)
        expect(item2.version).toBe(2)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("returns no-op for empty events", () =>
      Effect.gen(function* () {
        const result = yield* MatchEvents.append({ matchId: "m-1" }, [], 5)

        expect(result.version).toBe(5)
        expect(result.events).toEqual([])
        expect(mockTransactWriteItems).not.toHaveBeenCalled()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("maps ConditionalCheckFailed to VersionConflict", () =>
      Effect.gen(function* () {
        const txError = {
          name: "TransactionCanceledException",
          CancellationReasons: [{ Code: "ConditionalCheckFailed", Message: "Item already exists" }],
        }
        mockTransactWriteItems.mockRejectedValue(txError)

        const result = yield* MatchEvents.append(
          { matchId: "m-1" },
          [new MatchStarted({ venue: "MCG", homeTeam: "AUS", awayTeam: "ENG" })],
          0,
        ).pipe(Effect.flip)

        expect(result._tag).toBe("VersionConflict")
        const conflict = result as VersionConflict
        expect(conflict.streamName).toBe("Match")
        expect(conflict.streamId).toBe("m-1")
        expect(conflict.expectedVersion).toBe(0)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("maps non-conflict TransactionCanceledException to TransactionCancelled", () =>
      Effect.gen(function* () {
        const txError = {
          name: "TransactionCanceledException",
          CancellationReasons: [{ Code: "ValidationError", Message: "Bad input" }],
        }
        mockTransactWriteItems.mockRejectedValue(txError)

        const result = yield* MatchEvents.append(
          { matchId: "m-1" },
          [new MatchStarted({ venue: "MCG", homeTeam: "AUS", awayTeam: "ENG" })],
          0,
        ).pipe(Effect.flip)

        expect(result._tag).toBe("TransactionCancelled")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("includes metadata when provided (typed stream)", () =>
      Effect.gen(function* () {
        // Stream with metadata schema
        const MetaStream = EventStore.makeStream({
          table: EventsTable,
          streamName: "MetaMatch",
          events: [MatchStarted],
          streamId: { composite: ["matchId"] },
          metadata: Schema.Struct({ correlationId: Schema.String, userId: Schema.String }),
        })

        mockTransactWriteItems.mockResolvedValue({})

        yield* MetaStream.append(
          { matchId: "m-1" },
          [new MatchStarted({ venue: "MCG", homeTeam: "AUS", awayTeam: "ENG" })],
          0,
          { metadata: { correlationId: "corr-1", userId: "admin" } },
        )

        const call = mockTransactWriteItems.mock.calls[0]![0]
        const item = fromAttributeMap(call.TransactItems[0].Put.Item)
        expect(item.metadata).toEqual({ correlationId: "corr-1", userId: "admin" })
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("version padding produces correct SK", () =>
      Effect.gen(function* () {
        mockTransactWriteItems.mockResolvedValue({})

        yield* MatchEvents.append(
          { matchId: "m-1" },
          [new MatchStarted({ venue: "MCG", homeTeam: "AUS", awayTeam: "ENG" })],
          99,
        )

        const call = mockTransactWriteItems.mock.calls[0]![0]
        // TransactItems[0] is the version-contiguity ConditionCheck (expectedVersion > 0)
        const item = fromAttributeMap(call.TransactItems[1].Put.Item)
        // Version 100 → 10-digit padded
        expect(item.sk).toContain("0000000100")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("adds a version-contiguity ConditionCheck when expectedVersion > 0", () =>
      Effect.gen(function* () {
        mockTransactWriteItems.mockResolvedValue({})

        yield* MatchEvents.append(
          { matchId: "m-1" },
          [new InningsCompleted({ innings: 2, runs: 180, wickets: 10 })],
          3,
        )

        const call = mockTransactWriteItems.mock.calls[0]![0]
        expect(call.TransactItems).toHaveLength(2)

        const check = call.TransactItems[0].ConditionCheck
        expect(check.TableName).toBe("events-table")
        expect(check.ConditionExpression).toBe("attribute_exists(pk)")

        const key = fromAttributeMap(check.Key)
        expect(key.pk).toBe("$cricket#v1#match#m-1")
        // Key targets the event at exactly expectedVersion (3)
        expect(key.sk).toBe(DynamoSchema.composeEventVersionKey(AppSchema, "match.event", 3))

        // The Put still targets expectedVersion + 1
        const item = fromAttributeMap(call.TransactItems[1].Put.Item)
        expect(item.version).toBe(4)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("does not add a ConditionCheck when expectedVersion is 0", () =>
      Effect.gen(function* () {
        mockTransactWriteItems.mockResolvedValue({})

        yield* MatchEvents.append(
          { matchId: "m-1" },
          [new MatchStarted({ venue: "MCG", homeTeam: "AUS", awayTeam: "ENG" })],
          0,
        )

        const call = mockTransactWriteItems.mock.calls[0]![0]
        expect(call.TransactItems).toHaveLength(1)
        expect(call.TransactItems[0].ConditionCheck).toBeUndefined()
        expect(call.TransactItems[0].Put).toBeDefined()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("ahead expectedVersion ConditionCheck failure maps to VersionConflict", () =>
      Effect.gen(function* () {
        // The ConditionCheck item fails (event at expectedVersion doesn't exist);
        // the Put items are cancelled with None.
        const txError = {
          name: "TransactionCanceledException",
          CancellationReasons: [
            { Code: "ConditionalCheckFailed", Message: "The conditional request failed" },
            { Code: "None" },
          ],
        }
        mockTransactWriteItems.mockRejectedValue(txError)

        const result = yield* MatchEvents.append(
          { matchId: "m-1" },
          [new MatchEnded({ result: "AUS won" })],
          10,
        ).pipe(Effect.flip)

        expect(result._tag).toBe("VersionConflict")
        const conflict = result as VersionConflict
        expect(conflict.streamName).toBe("Match")
        expect(conflict.streamId).toBe("m-1")
        expect(conflict.expectedVersion).toBe(10)
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  // -------------------------------------------------------------------------
  // append — TransactWriteItems limit guard
  // -------------------------------------------------------------------------

  describe("append limit guard", () => {
    const manyEvents = (n: number): ReadonlyArray<MatchEvent> =>
      Array.from(
        { length: n },
        (_, i) => new InningsCompleted({ innings: i + 1, runs: 100, wickets: 5 }),
      )

    it.effect("fails with AppendTooLarge before any client call at > limit", () =>
      Effect.gen(function* () {
        const result = yield* MatchEvents.append({ matchId: "m-1" }, manyEvents(101), 0).pipe(
          Effect.flip,
        )

        expect(result._tag).toBe("AppendTooLarge")
        const err = result as AppendTooLarge
        expect(err.streamName).toBe("Match")
        expect(err.streamId).toBe("m-1")
        expect(err.count).toBe(101)
        expect(err.limit).toBe(TRANSACT_WRITE_ITEMS_LIMIT)
        expect(mockTransactWriteItems).not.toHaveBeenCalled()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("exactly 100 events at expectedVersion 0 passes the guard", () =>
      Effect.gen(function* () {
        mockTransactWriteItems.mockResolvedValue({})

        const result = yield* MatchEvents.append({ matchId: "m-1" }, manyEvents(100), 0)

        expect(result.version).toBe(100)
        expect(mockTransactWriteItems).toHaveBeenCalledOnce()
        const call = mockTransactWriteItems.mock.calls[0]![0]
        expect(call.TransactItems).toHaveLength(100)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect(
      "ConditionCheck counts toward the limit: 100 events at expectedVersion > 0 fails",
      () =>
        Effect.gen(function* () {
          const result = yield* MatchEvents.append({ matchId: "m-1" }, manyEvents(100), 3).pipe(
            Effect.flip,
          )

          expect(result._tag).toBe("AppendTooLarge")
          const err = result as AppendTooLarge
          expect(err.count).toBe(101)
          expect(err.limit).toBe(TRANSACT_WRITE_ITEMS_LIMIT)
          expect(mockTransactWriteItems).not.toHaveBeenCalled()
        }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("99 events at expectedVersion > 0 passes the guard (100 transact items)", () =>
      Effect.gen(function* () {
        mockTransactWriteItems.mockResolvedValue({})

        const result = yield* MatchEvents.append({ matchId: "m-1" }, manyEvents(99), 3)

        expect(result.version).toBe(102)
        const call = mockTransactWriteItems.mock.calls[0]![0]
        expect(call.TransactItems).toHaveLength(100)
        expect(call.TransactItems[0].ConditionCheck).toBeDefined()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("joins composite stream ids in the AppendTooLarge error", () =>
      Effect.gen(function* () {
        const CompoundStream = EventStore.makeStream({
          table: EventsTable,
          streamName: "Team",
          events: [MatchStarted],
          streamId: { composite: ["leagueId", "teamId"] },
        })

        const result = yield* CompoundStream.append(
          { leagueId: "L-1", teamId: "T-5" },
          Array.from(
            { length: 101 },
            () => new MatchStarted({ venue: "MCG", homeTeam: "AUS", awayTeam: "ENG" }),
          ),
          0,
        ).pipe(Effect.flip)

        expect(result._tag).toBe("AppendTooLarge")
        expect((result as AppendTooLarge).streamId).toBe("L-1#T-5")
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  // -------------------------------------------------------------------------
  // read
  // -------------------------------------------------------------------------

  describe("read", () => {
    it.effect("reads all events from a stream", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue({
          Items: [
            makeEventItem("m-1", 1, "MatchStarted", {
              venue: "MCG",
              homeTeam: "AUS",
              awayTeam: "ENG",
            }),
            makeEventItem("m-1", 2, "InningsCompleted", { innings: 1, runs: 250, wickets: 10 }),
          ],
        })

        const events = yield* MatchEvents.read({ matchId: "m-1" })

        expect(events).toHaveLength(2)
        expect(events[0]!.version).toBe(1)
        expect(events[0]!.eventType).toBe("MatchStarted")
        expect(events[0]!.data).toBeInstanceOf(MatchStarted)
        expect((events[0]!.data as MatchStarted).venue).toBe("MCG")
        expect(events[1]!.version).toBe(2)
        expect(events[1]!.data).toBeInstanceOf(InningsCompleted)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("returns empty array for empty stream", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue({ Items: [] })

        const events = yield* MatchEvents.read({ matchId: "m-nonexistent" })

        expect(events).toEqual([])
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("composes correct PK for query", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue({ Items: [] })

        yield* MatchEvents.read({ matchId: "m-1" })

        const call = mockQuery.mock.calls[0]![0]
        expect(call.TableName).toBe("events-table")
        expect(call.IndexName).toBeUndefined()
        // PK should be the composed stream key
        expect(call.KeyConditionExpression).toContain("#pk = :pk")
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  // -------------------------------------------------------------------------
  // readFrom
  // -------------------------------------------------------------------------

  describe("readFrom", () => {
    it.effect("reads events after a given version", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue({
          Items: [
            makeEventItem("m-1", 3, "InningsCompleted", { innings: 2, runs: 180, wickets: 10 }),
          ],
        })

        const events = yield* MatchEvents.readFrom({ matchId: "m-1" }, 2)

        expect(events).toHaveLength(1)
        expect(events[0]!.version).toBe(3)

        // Verify SK condition uses gt
        const call = mockQuery.mock.calls[0]![0]
        expect(call.KeyConditionExpression).toContain("#sk >")
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  // -------------------------------------------------------------------------
  // currentVersion
  // -------------------------------------------------------------------------

  describe("currentVersion", () => {
    it.effect("returns version of the last event", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue({
          Items: [
            makeEventItem("m-1", 5, "InningsCompleted", { innings: 2, runs: 180, wickets: 10 }),
          ],
        })

        const version = yield* MatchEvents.currentVersion({ matchId: "m-1" })

        expect(version).toBe(5)

        // Verify it uses reverse + limit 1
        const call = mockQuery.mock.calls[0]![0]
        expect(call.ScanIndexForward).toBe(false)
        expect(call.Limit).toBe(1)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("returns 0 for empty stream", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue({ Items: [] })

        const version = yield* MatchEvents.currentVersion({ matchId: "m-nonexistent" })

        expect(version).toBe(0)
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  // -------------------------------------------------------------------------
  // query.events
  // -------------------------------------------------------------------------

  describe("query.events", () => {
    it("returns a Query<StreamEvent>", () => {
      const q = MatchEvents.query.events({ matchId: "m-1" })
      expect(Query.isQuery(q)).toBe(true)
    })

    it.effect("supports Query combinators (reverse, limit)", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue({
          Items: [makeEventItem("m-1", 3, "MatchEnded", { result: "AUS won" })],
        })

        const events = yield* MatchEvents.query
          .events({ matchId: "m-1" })
          .pipe(Query.reverse, Query.limit(1), Query.collect)

        expect(events).toHaveLength(1)
        expect(events[0]!.version).toBe(3)

        const call = mockQuery.mock.calls[0]![0]
        expect(call.ScanIndexForward).toBe(false)
        expect(call.Limit).toBe(1)
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  // -------------------------------------------------------------------------
  // fold
  // -------------------------------------------------------------------------

  describe("fold", () => {
    it("reconstructs state from events (data-first)", () => {
      const events: ReadonlyArray<EventStore.StreamEvent<MatchEvent>> = [
        {
          streamId: "m-1",
          version: 1,
          eventType: "MatchStarted",
          data: new MatchStarted({ venue: "MCG", homeTeam: "AUS", awayTeam: "ENG" }),
          metadata: undefined,
          timestamp: "2026-03-08T12:00:00Z",
        },
        {
          streamId: "m-1",
          version: 2,
          eventType: "InningsCompleted",
          data: new InningsCompleted({ innings: 1, runs: 250, wickets: 10 }),
          metadata: undefined,
          timestamp: "2026-03-08T13:00:00Z",
        },
      ]

      const state = EventStore.fold(matchDecider, events)

      expect(state.status).toBe("in-progress")
      expect(state.innings).toEqual([{ runs: 250, wickets: 10 }])
    })

    it("reconstructs state from events (data-last / pipe)", () => {
      const events: ReadonlyArray<EventStore.StreamEvent<MatchEvent>> = [
        {
          streamId: "m-1",
          version: 1,
          eventType: "MatchStarted",
          data: new MatchStarted({ venue: "MCG", homeTeam: "AUS", awayTeam: "ENG" }),
          metadata: undefined,
          timestamp: "2026-03-08T12:00:00Z",
        },
      ]

      const state = EventStore.fold(events)(matchDecider)

      expect(state.status).toBe("in-progress")
      expect(state.innings).toEqual([])
    })

    it("returns initialState for empty events", () => {
      const state = EventStore.fold(matchDecider, [])

      expect(state).toEqual({ status: "pending", innings: [] })
    })
  })

  // -------------------------------------------------------------------------
  // foldFrom
  // -------------------------------------------------------------------------

  describe("foldFrom", () => {
    it("folds from a starting state (data-first)", () => {
      const snapshot: MatchState = { status: "in-progress", innings: [{ runs: 200, wickets: 8 }] }
      const events: ReadonlyArray<EventStore.StreamEvent<MatchEvent>> = [
        {
          streamId: "m-1",
          version: 3,
          eventType: "InningsCompleted",
          data: new InningsCompleted({ innings: 2, runs: 180, wickets: 10 }),
          metadata: undefined,
          timestamp: "2026-03-08T14:00:00Z",
        },
      ]

      const state = EventStore.foldFrom(matchDecider, snapshot, events)

      expect(state.status).toBe("in-progress")
      expect(state.innings).toHaveLength(2)
      expect(state.innings[1]).toEqual({ runs: 180, wickets: 10 })
    })
  })

  // -------------------------------------------------------------------------
  // commandHandler
  // -------------------------------------------------------------------------

  describe("commandHandler", () => {
    const handleMatch = EventStore.commandHandler(matchDecider, MatchEvents)

    it.effect("reads, decides, and appends (data-first)", () =>
      Effect.gen(function* () {
        // First call: read returns empty stream
        mockQuery.mockResolvedValueOnce({ Items: [] })
        // Then: append succeeds
        mockTransactWriteItems.mockResolvedValueOnce({})

        const result = yield* handleMatch(
          { matchId: "m-1" },
          { _tag: "StartMatch", venue: "MCG", homeTeam: "AUS", awayTeam: "ENG" },
        )

        expect(result.state.status).toBe("in-progress")
        expect(result.version).toBe(1)
        expect(result.events).toHaveLength(1)
        expect(result.events[0]).toBeInstanceOf(MatchStarted)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("evolves state from existing events before deciding", () =>
      Effect.gen(function* () {
        // Read returns existing events
        mockQuery.mockResolvedValueOnce({
          Items: [
            makeEventItem("m-1", 1, "MatchStarted", {
              venue: "MCG",
              homeTeam: "AUS",
              awayTeam: "ENG",
            }),
          ],
        })
        mockTransactWriteItems.mockResolvedValueOnce({})

        const result = yield* handleMatch(
          { matchId: "m-1" },
          { _tag: "CompleteInnings", innings: 1, runs: 250, wickets: 10 },
        )

        expect(result.state.status).toBe("in-progress")
        expect(result.state.innings).toHaveLength(1)
        expect(result.version).toBe(2)

        // Verify expectedVersion passed to append.
        // TransactItems[0] is the contiguity ConditionCheck (expectedVersion=1 > 0).
        const twCall = mockTransactWriteItems.mock.calls[0]![0]
        const item = fromAttributeMap(twCall.TransactItems[1].Put.Item)
        expect(item.version).toBe(2) // expectedVersion=1, so new event is v2
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("returns domain error from decider", () =>
      Effect.gen(function* () {
        // Read returns stream where match is already started
        mockQuery.mockResolvedValueOnce({
          Items: [
            makeEventItem("m-1", 1, "MatchStarted", {
              venue: "MCG",
              homeTeam: "AUS",
              awayTeam: "ENG",
            }),
          ],
        })

        const error = yield* handleMatch(
          { matchId: "m-1" },
          { _tag: "StartMatch", venue: "SCG", homeTeam: "AUS", awayTeam: "IND" },
        ).pipe(Effect.flip)

        expect(error._tag).toBe("AlreadyStarted")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("handles no-op commands (decider returns empty events)", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValueOnce({ Items: [] })

        // Create a decider that always returns empty events
        const noopDecider: EventStore.Decider<MatchState, MatchCommand, MatchEvent> = {
          ...matchDecider,
          decide: () => Effect.succeed([]),
        }
        const handle = EventStore.commandHandler(noopDecider, MatchEvents)

        const result = yield* handle(
          { matchId: "m-1" },
          { _tag: "StartMatch", venue: "MCG", homeTeam: "AUS", awayTeam: "ENG" },
        )

        expect(result.events).toEqual([])
        expect(result.version).toBe(0)
        expect(mockTransactWriteItems).not.toHaveBeenCalled()
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  // -------------------------------------------------------------------------
  // bind
  // -------------------------------------------------------------------------

  describe("bind", () => {
    it.effect("returns a BoundEventStream with R = never on all operations", () =>
      Effect.gen(function* () {
        const bound = yield* EventStore.bind(MatchEvents)

        // Verify structural properties
        expect(bound.streamName).toBe("Match")
        expect(bound.eventSchema).toBeDefined()
        expect(typeof bound.append).toBe("function")
        expect(typeof bound.read).toBe("function")
        expect(typeof bound.readFrom).toBe("function")
        expect(typeof bound.currentVersion).toBe("function")
        expect(typeof bound.query.events).toBe("function")
        expect(typeof bound.provide).toBe("function")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("bound append works without providing layers again", () =>
      Effect.gen(function* () {
        const bound = yield* EventStore.bind(MatchEvents)

        mockTransactWriteItems.mockResolvedValue({})

        // This call has R = never — no need to provide DynamoClient | TableConfig
        const result = yield* bound.append(
          { matchId: "m-1" },
          [new MatchStarted({ venue: "MCG", homeTeam: "AUS", awayTeam: "ENG" })],
          0,
        )

        expect(result.version).toBe(1)
        expect(result.events).toHaveLength(1)
        expect(mockTransactWriteItems).toHaveBeenCalledOnce()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("bound read works without providing layers again", () =>
      Effect.gen(function* () {
        const bound = yield* EventStore.bind(MatchEvents)

        mockQuery.mockResolvedValue({
          Items: [
            makeEventItem("m-1", 1, "MatchStarted", {
              venue: "MCG",
              homeTeam: "AUS",
              awayTeam: "ENG",
            }),
          ],
        })

        const events = yield* bound.read({ matchId: "m-1" })

        expect(events).toHaveLength(1)
        expect(events[0]!.version).toBe(1)
        expect(events[0]!.data).toBeInstanceOf(MatchStarted)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("bound readFrom works without providing layers again", () =>
      Effect.gen(function* () {
        const bound = yield* EventStore.bind(MatchEvents)

        mockQuery.mockResolvedValue({
          Items: [
            makeEventItem("m-1", 3, "InningsCompleted", { innings: 2, runs: 180, wickets: 10 }),
          ],
        })

        const events = yield* bound.readFrom({ matchId: "m-1" }, 2)

        expect(events).toHaveLength(1)
        expect(events[0]!.version).toBe(3)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("bound currentVersion works without providing layers again", () =>
      Effect.gen(function* () {
        const bound = yield* EventStore.bind(MatchEvents)

        mockQuery.mockResolvedValue({
          Items: [
            makeEventItem("m-1", 5, "InningsCompleted", { innings: 2, runs: 180, wickets: 10 }),
          ],
        })

        const version = yield* bound.currentVersion({ matchId: "m-1" })

        expect(version).toBe(5)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("bound query.events returns a Query", () =>
      Effect.gen(function* () {
        const bound = yield* EventStore.bind(MatchEvents)

        const q = bound.query.events({ matchId: "m-1" })
        expect(Query.isQuery(q)).toBe(true)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("bound provide wraps arbitrary effects", () =>
      Effect.gen(function* () {
        const bound = yield* EventStore.bind(MatchEvents)

        // Use provide to wrap the unbound stream's read operation
        mockQuery.mockResolvedValue({
          Items: [
            makeEventItem("m-1", 1, "MatchStarted", {
              venue: "MCG",
              homeTeam: "AUS",
              awayTeam: "ENG",
            }),
          ],
        })

        const events = yield* bound.provide(MatchEvents.read({ matchId: "m-1" }))

        expect(events).toHaveLength(1)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("commandHandler works with BoundEventStream", () =>
      Effect.gen(function* () {
        const bound = yield* EventStore.bind(MatchEvents)

        // commandHandler with BoundEventStream produces R = never
        const handleMatch = EventStore.commandHandler(matchDecider, bound)

        mockQuery.mockResolvedValueOnce({ Items: [] })
        mockTransactWriteItems.mockResolvedValueOnce({})

        const result = yield* handleMatch(
          { matchId: "m-1" },
          { _tag: "StartMatch", venue: "MCG", homeTeam: "AUS", awayTeam: "ENG" },
        )

        expect(result.state.status).toBe("in-progress")
        expect(result.version).toBe(1)
        expect(result.events).toHaveLength(1)
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  // -------------------------------------------------------------------------
  // DynamoDB item structure verification
  // -------------------------------------------------------------------------

  describe("item structure", () => {
    it.effect("produces correct DynamoDB key format", () =>
      Effect.gen(function* () {
        mockTransactWriteItems.mockResolvedValue({})

        yield* MatchEvents.append(
          { matchId: "m-123" },
          [new MatchStarted({ venue: "MCG", homeTeam: "AUS", awayTeam: "ENG" })],
          0,
        )

        const call = mockTransactWriteItems.mock.calls[0]![0]
        const item = fromAttributeMap(call.TransactItems[0].Put.Item)

        // PK: $cricket#v1#match#m-123
        expect(item.pk).toBe("$cricket#v1#match#m-123")
        // SK: follows isolated pattern with 10-digit padding
        expect(item.sk).toMatch(/\$cricket#v1#match\.event_1#\d{10}/)
        // Entity type discriminator
        expect(item.__edd_e__).toBe("match.event")
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  // -------------------------------------------------------------------------
  // Composite stream ID
  // -------------------------------------------------------------------------

  describe("composite stream ID", () => {
    const CompoundStream = EventStore.makeStream({
      table: EventsTable,
      streamName: "Team",
      events: [MatchStarted],
      streamId: { composite: ["leagueId", "teamId"] },
    })

    it.effect("composes PK from multiple composite fields", () =>
      Effect.gen(function* () {
        mockTransactWriteItems.mockResolvedValue({})

        yield* CompoundStream.append(
          { leagueId: "L-1", teamId: "T-5" },
          [new MatchStarted({ venue: "MCG", homeTeam: "AUS", awayTeam: "ENG" })],
          0,
        )

        const call = mockTransactWriteItems.mock.calls[0]![0]
        const item = fromAttributeMap(call.TransactItems[0].Put.Item)

        // PK should include both composites
        expect(item.pk).toBe("$cricket#v1#team#l-1#t-5")
        // streamId should join composites with #
        expect(item.streamId).toBe("L-1#T-5")
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  // -------------------------------------------------------------------------
  // DynamoSchema.composeEventVersionKey
  // -------------------------------------------------------------------------

  describe("composeEventVersionKey", () => {
    it("produces 10-digit zero-padded version key", () => {
      const key = DynamoSchema.composeEventVersionKey(AppSchema, "match.event", 1)
      expect(key).toBe("$cricket#v1#match.event_1#0000000001")
    })

    it("pads larger versions correctly", () => {
      const key = DynamoSchema.composeEventVersionKey(AppSchema, "match.event", 12345)
      expect(key).toBe("$cricket#v1#match.event_1#0000012345")
    })

    it("handles max realistic version", () => {
      const key = DynamoSchema.composeEventVersionKey(AppSchema, "match.event", 9999999999)
      expect(key).toBe("$cricket#v1#match.event_1#9999999999")
    })
  })

  // -------------------------------------------------------------------------
  // Codec symmetry (issue #81) — encode on write, decode on read
  // -------------------------------------------------------------------------

  describe("codec symmetry (issue #81)", () => {
    const epochMs = 1704067200000 // 2024-01-01T00:00:00.000Z
    const isoString = "2024-01-01T00:00:00.000Z"

    class GoalScored extends Schema.Class<GoalScored>("GoalScored")({
      scorer: Schema.String,
      occurredAt: Schema.DateTimeUtcFromString,
    }) {}

    class MatchAbandoned extends Schema.TaggedClass<MatchAbandoned>()("MatchAbandoned", {
      reason: Schema.String,
      abandonedAt: Schema.DateTimeUtcFromString,
    }) {}

    const GoalStream = EventStore.makeStream({
      table: EventsTable,
      streamName: "Goal",
      events: [GoalScored, MatchAbandoned],
      streamId: { composite: ["matchId"] },
      metadata: Schema.Struct({
        correlationId: Schema.String,
        recordedAt: Schema.DateTimeUtcFromString,
      }),
    })

    it.effect("append encodes transform event fields to wire form", () =>
      Effect.gen(function* () {
        mockTransactWriteItems.mockResolvedValue({})

        yield* GoalStream.append(
          { matchId: "g-1" },
          [new GoalScored({ scorer: "Kane", occurredAt: DateTime.makeUnsafe(epochMs) })],
          0,
        )

        const call = mockTransactWriteItems.mock.calls[0]![0]
        const item = fromAttributeMap(call.TransactItems[0].Put.Item)
        // Wire form is the encoded ISO string, not a marshalled DateTime instance.
        expect(item.data).toEqual({
          _tag: "GoalScored",
          scorer: "Kane",
          occurredAt: isoString,
        })
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("append encodes transform metadata fields to wire form", () =>
      Effect.gen(function* () {
        mockTransactWriteItems.mockResolvedValue({})

        yield* GoalStream.append(
          { matchId: "g-1" },
          [new GoalScored({ scorer: "Kane", occurredAt: DateTime.makeUnsafe(epochMs) })],
          0,
          { metadata: { correlationId: "corr-1", recordedAt: DateTime.makeUnsafe(epochMs) } },
        )

        const call = mockTransactWriteItems.mock.calls[0]![0]
        const item = fromAttributeMap(call.TransactItems[0].Put.Item)
        expect(item.metadata).toEqual({ correlationId: "corr-1", recordedAt: isoString })
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("transforming event schema round-trips append → read", () =>
      Effect.gen(function* () {
        mockTransactWriteItems.mockResolvedValue({})

        yield* GoalStream.append(
          { matchId: "g-1" },
          [new GoalScored({ scorer: "Kane", occurredAt: DateTime.makeUnsafe(epochMs) })],
          0,
          { metadata: { correlationId: "corr-1", recordedAt: DateTime.makeUnsafe(epochMs) } },
        )

        // Feed the exact stored item back through the read path.
        const call = mockTransactWriteItems.mock.calls[0]![0]
        mockQuery.mockResolvedValue({ Items: [call.TransactItems[0].Put.Item] })

        const events = yield* GoalStream.read({ matchId: "g-1" })

        expect(events).toHaveLength(1)
        const event = events[0]!
        expect(event.version).toBe(1)
        expect(event.eventType).toBe("GoalScored")
        expect(event.data).toBeInstanceOf(GoalScored)
        const goal = event.data as GoalScored
        expect(DateTime.isDateTime(goal.occurredAt)).toBe(true)
        expect(DateTime.toEpochMillis(goal.occurredAt)).toBe(epochMs)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("metadata round-trips append → read (decoded, not raw)", () =>
      Effect.gen(function* () {
        mockTransactWriteItems.mockResolvedValue({})

        yield* GoalStream.append(
          { matchId: "g-1" },
          [new GoalScored({ scorer: "Kane", occurredAt: DateTime.makeUnsafe(epochMs) })],
          0,
          { metadata: { correlationId: "corr-1", recordedAt: DateTime.makeUnsafe(epochMs) } },
        )

        const call = mockTransactWriteItems.mock.calls[0]![0]
        mockQuery.mockResolvedValue({ Items: [call.TransactItems[0].Put.Item] })

        const events = yield* GoalStream.read({ matchId: "g-1" })

        const metadata = events[0]!.metadata
        expect(metadata).toBeDefined()
        expect(metadata!.correlationId).toBe("corr-1")
        expect(DateTime.isDateTime(metadata!.recordedAt)).toBe(true)
        expect(DateTime.toEpochMillis(metadata!.recordedAt)).toBe(epochMs)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("Schema.TaggedClass events keep their _tag through append → read", () =>
      Effect.gen(function* () {
        mockTransactWriteItems.mockResolvedValue({})

        yield* GoalStream.append(
          { matchId: "g-1" },
          [new MatchAbandoned({ reason: "rain", abandonedAt: DateTime.makeUnsafe(epochMs) })],
          0,
        )

        const call = mockTransactWriteItems.mock.calls[0]![0]
        const item = fromAttributeMap(call.TransactItems[0].Put.Item)
        expect(item.eventType).toBe("MatchAbandoned")
        expect(item.data).toEqual({
          _tag: "MatchAbandoned",
          reason: "rain",
          abandonedAt: isoString,
        })

        mockQuery.mockResolvedValue({ Items: [call.TransactItems[0].Put.Item] })
        const events = yield* GoalStream.read({ matchId: "g-1" })
        expect(events[0]!.data).toBeInstanceOf(MatchAbandoned)
        const abandoned = events[0]!.data as MatchAbandoned
        expect(abandoned._tag).toBe("MatchAbandoned")
        expect(DateTime.toEpochMillis(abandoned.abandonedAt)).toBe(epochMs)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("event encode failure maps to ValidationError with EventStore.append", () =>
      Effect.gen(function* () {
        const error = yield* GoalStream.append(
          { matchId: "g-1" },
          // Invalid in both Type and Encoded shape — encode and fallback fail.
          [{ scorer: 42, occurredAt: "not-a-date" } as unknown as GoalScored],
          0,
        ).pipe(Effect.flip)

        expect(error._tag).toBe("ValidationError")
        expect((error as { operation: string }).operation).toBe("EventStore.append")
        expect(mockTransactWriteItems).not.toHaveBeenCalled()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("metadata encode failure maps to ValidationError", () =>
      Effect.gen(function* () {
        const error = yield* GoalStream.append(
          { matchId: "g-1" },
          [new GoalScored({ scorer: "Kane", occurredAt: DateTime.makeUnsafe(epochMs) })],
          0,
          {
            metadata: { correlationId: 42, recordedAt: "bogus" } as unknown as {
              correlationId: string
              recordedAt: DateTime.Utc
            },
          },
        ).pipe(Effect.flip)

        expect(error._tag).toBe("ValidationError")
        expect((error as { operation: string }).operation).toBe("EventStore.append.metadata")
        expect(mockTransactWriteItems).not.toHaveBeenCalled()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("malformed envelope fails read with ValidationError", () =>
      Effect.gen(function* () {
        // Item missing the `version` envelope field.
        mockQuery.mockResolvedValue({
          Items: [
            toAttributeMap({
              pk: "$cricket#v1#match#m-1",
              sk: DynamoSchema.composeEventVersionKey(AppSchema, "match.event", 1),
              __edd_e__: "match.event",
              streamId: "m-1",
              eventType: "MatchStarted",
              data: { _tag: "MatchStarted", venue: "MCG", homeTeam: "AUS", awayTeam: "ENG" },
              timestamp: "2026-03-08T12:00:00.000Z",
            }),
          ],
        })

        const error = yield* MatchEvents.read({ matchId: "m-1" }).pipe(Effect.flip)

        expect(error._tag).toBe("ValidationError")
        expect((error as { operation: string }).operation).toBe("EventStore.decode")
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  // -------------------------------------------------------------------------
  // VersionConflict error
  // -------------------------------------------------------------------------

  describe("VersionConflict", () => {
    it("is a TaggedError with correct tag", () => {
      const error = new VersionConflict({
        streamName: "Match",
        streamId: "m-1",
        expectedVersion: 3,
      })
      expect(error._tag).toBe("VersionConflict")
      expect(error.streamName).toBe("Match")
      expect(error.streamId).toBe("m-1")
      expect(error.expectedVersion).toBe(3)
    })
  })

  // -------------------------------------------------------------------------
  // AppendTooLarge error
  // -------------------------------------------------------------------------

  describe("AppendTooLarge", () => {
    it("is a TaggedError with correct tag", () => {
      const error = new AppendTooLarge({
        streamName: "Match",
        streamId: "m-1",
        count: 101,
        limit: TRANSACT_WRITE_ITEMS_LIMIT,
      })
      expect(error._tag).toBe("AppendTooLarge")
      expect(error.streamName).toBe("Match")
      expect(error.streamId).toBe("m-1")
      expect(error.count).toBe(101)
      expect(error.limit).toBe(100)
    })
  })
})
