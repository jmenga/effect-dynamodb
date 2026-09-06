import { describe, expect, it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import * as PureEntity from "@effect-dynamodb/schema/Entity.js"
import {
  type AdditionalItemConditionFailed,
  AppendTooLarge,
  type DuplicateCommand,
  DynamoError,
  TRANSACT_WRITE_ITEMS_LIMIT,
  type ValidationError,
  VersionConflict,
} from "@effect-dynamodb/schema/Errors.js"
import {
  Cause,
  Data,
  DateTime,
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
  pipe,
  Schedule,
  Schema,
  SchemaGetter,
} from "effect"
import { beforeEach, vi } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
import * as Expression from "../src/Expression.js"
import { fromAttributeMap, toAttributeMap } from "../src/Marshaller.js"
import * as Query from "../src/Query.js"
import * as Table from "../src/Table.js"
import * as Transaction from "../src/Transaction.js"

// ---------------------------------------------------------------------------
// Test setup — Schema, Table, Event classes
// ---------------------------------------------------------------------------

const AppSchema = DynamoSchema.make({ name: "cricket", version: 1 })

// Side-record entity used to exercise `append({ additionalItems })`. Registered
// on the same physical table as the event stream.
class Watermark extends Schema.Class<Watermark>("Watermark")({
  writerId: Schema.String,
  lastSeq: Schema.Number,
}) {}

const Watermarks = Entity.make({
  model: Watermark,
  entityType: "Watermark",
  primaryKey: {
    pk: { field: "pk", composite: ["writerId"] },
    sk: { field: "sk", composite: [] },
  },
})

// A read model authored with the PURE, AWS-free `@effect-dynamodb/schema`
// `Entity.make` — the shape reported in #100. A pure definition carries no CRUD
// ops, so the only put its author can build is the bound builder returned by
// `db.entities.StatusProjection.put(...)`.
const StatusRecord = Schema.Struct({
  matchId: Schema.String,
  state: Schema.String,
})

const StatusProjection = PureEntity.make({
  model: DynamoModel.configure(StatusRecord, { matchId: { identifier: true } }),
  entityType: "Status",
  primaryKey: {
    pk: { field: "pk", composite: ["matchId"] },
    sk: { field: "sk", composite: [] },
  },
})

const EventsTable = Table.make({ schema: AppSchema, entities: { Watermarks, StatusProjection } })

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
// Snapshot fixtures (#84)
//
// `MatchStateSchema` is deliberately *transforming*: `status` is stored as a
// single-letter code and `innings` as a packed "runs/wickets" string, so the
// tests fail if the implementation stores the domain value verbatim instead of
// round-tripping it through `Schema.encodeUnknownEffect` / `decodeUnknownEffect`.
// ---------------------------------------------------------------------------

const StatusCode = Schema.Literals(["p", "i", "c"]).pipe(
  Schema.decodeTo(Schema.Literals(["pending", "in-progress", "completed"]), {
    decode: SchemaGetter.transform((code: "p" | "i" | "c") =>
      code === "p"
        ? ("pending" as const)
        : code === "i"
          ? ("in-progress" as const)
          : ("completed" as const),
    ),
    encode: SchemaGetter.transform((status: "pending" | "in-progress" | "completed") =>
      status === "pending"
        ? ("p" as const)
        : status === "in-progress"
          ? ("i" as const)
          : ("c" as const),
    ),
  }),
)

const PackedInnings = Schema.String.pipe(
  Schema.decodeTo(Schema.Struct({ runs: Schema.Number, wickets: Schema.Number }), {
    decode: SchemaGetter.transform((packed: string) => {
      const [runs, wickets] = packed.split("/")
      return { runs: Number(runs), wickets: Number(wickets) }
    }),
    encode: SchemaGetter.transform(
      (innings: { readonly runs: number; readonly wickets: number }) =>
        `${innings.runs}/${innings.wickets}`,
    ),
  }),
)

const MatchStateSchema = Schema.Struct({
  status: StatusCode,
  innings: Schema.Array(PackedInnings),
})

const SnapshotMatchEvents = EventStore.makeStream({
  table: EventsTable,
  streamName: "SnapMatch",
  events: [MatchStarted, InningsCompleted, MatchEnded],
  streamId: { composite: ["matchId"] },
  snapshot: { schema: MatchStateSchema, every: 3 },
})

/** Same stream, snapshots enabled but no auto-cadence. */
const ManualSnapshotMatchEvents = EventStore.makeStream({
  table: EventsTable,
  streamName: "ManualMatch",
  events: [MatchStarted, InningsCompleted, MatchEnded],
  streamId: { composite: ["matchId"] },
  snapshot: { schema: MatchStateSchema },
})

// ---------------------------------------------------------------------------
// Mock DynamoClient
// ---------------------------------------------------------------------------

const mockQuery = vi.fn()
const mockTransactWriteItems = vi.fn()
const mockPutItem = vi.fn()
const mockGetItem = vi.fn()

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
  putItem: (input) =>
    Effect.tryPromise({
      try: () => mockPutItem(input),
      catch: (e) => new DynamoError({ operation: "PutItem", cause: e }),
    }),
  getItem: (input) =>
    Effect.tryPromise({
      try: () => mockGetItem(input),
      catch: (e) => new DynamoError({ operation: "GetItem", cause: e }),
    }),
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

const makeStreamEventItem = (
  streamLabel: string,
  streamId: string,
  version: number,
  eventType: string,
  data: Record<string, unknown>,
) =>
  toAttributeMap({
    pk: `$cricket#v1#${streamLabel}#${streamId}`,
    sk: DynamoSchema.composeEventVersionKey(AppSchema, `${streamLabel}.event`, version),
    __edd_e__: `${streamLabel}.event`,
    streamId,
    version,
    eventType,
    data: { _tag: eventType, ...data },
    timestamp: "2026-03-08T12:00:00.000Z",
  })

const makeEventItem = (
  streamId: string,
  version: number,
  eventType: string,
  data: Record<string, unknown>,
) => makeStreamEventItem("match", streamId, version, eventType, data)

/** A snapshot item as it is stored — `state` is the *encoded* form. */
const makeSnapshotItem = (
  streamLabel: string,
  streamId: string,
  asOfVersion: number,
  encodedState: unknown,
) =>
  toAttributeMap({
    pk: `$cricket#v1#${streamLabel}#${streamId}`,
    sk: DynamoSchema.composeKey(AppSchema, `${streamLabel}.snapshot`, []),
    __edd_e__: `${streamLabel}.snapshot`,
    streamId,
    asOfVersion,
    state: encodedState,
    timestamp: "2026-03-08T12:00:00.000Z",
  })

/**
 * The decoded item of the first `Put` in a TransactWriteItems call.
 *
 * `append` prepends a version-contiguity `ConditionCheck` whenever
 * `expectedVersion > 0` (#82), so the first event `Put` is not necessarily at
 * index 0. Locating the Put by shape keeps these assertions about *which event
 * was appended* rather than about the item layout, which the guard owns and
 * which its own tests assert directly.
 */
const firstAppendedEvent = (call: { TransactItems: ReadonlyArray<any> }) => {
  const put = call.TransactItems.find((i) => i.Put !== undefined)
  expect(put).toBeDefined()
  return fromAttributeMap(put!.Put.Item)
}

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

        // SK range is bounded to the event range (#84): the inclusive lower
        // bound is `afterVersion + 1`, which is exactly the old exclusive
        // `#sk > eventSk(afterVersion)`, and the upper bound keeps the snapshot
        // item (which sorts after every event) out of the scanned range.
        const call = mockQuery.mock.calls[0]![0]
        expect(call.KeyConditionExpression).toContain("#sk BETWEEN :sk1 AND :sk2")
        expect(call.ExpressionAttributeValues[":sk1"].S).toBe(
          DynamoSchema.composeEventVersionKey(AppSchema, "match.event", 3),
        )
        expect(call.ExpressionAttributeValues[":sk2"].S).toBe(
          DynamoSchema.composeEventVersionKey(
            AppSchema,
            "match.event",
            DynamoSchema.MAX_EVENT_VERSION,
          ),
        )
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
  // append — additionalItems (#85)
  // -------------------------------------------------------------------------

  describe("append — additionalItems", () => {
    const startMatch = () => new MatchStarted({ venue: "MCG", homeTeam: "AUS", awayTeam: "ENG" })

    const cancelled = (reasons: ReadonlyArray<{ Code: string; Message?: string }>) => ({
      name: "TransactionCanceledException",
      CancellationReasons: reasons,
    })

    it.effect("merges additional items after the event puts, in caller order", () =>
      Effect.gen(function* () {
        mockTransactWriteItems.mockResolvedValue({})

        yield* MatchEvents.append({ matchId: "m-1" }, [startMatch()], 0, {
          additionalItems: [
            Watermarks.put({ writerId: "ingest-1", lastSeq: 42 }),
            Watermarks.delete({ writerId: "ingest-0" }),
          ],
        })

        const call = mockTransactWriteItems.mock.calls[0]![0]
        expect(call.TransactItems).toHaveLength(3)

        // Event put first
        expect(fromAttributeMap(call.TransactItems[0].Put.Item).__edd_e__).toBe("match.event")

        // Then the caller's items, in the order supplied
        const wmItem = fromAttributeMap(call.TransactItems[1].Put.Item)
        expect(call.TransactItems[1].Put.TableName).toBe("events-table")
        expect(wmItem.__edd_e__).toBe("Watermark")
        expect(wmItem.lastSeq).toBe(42)

        expect(call.TransactItems[2].Delete.TableName).toBe("events-table")
        expect(fromAttributeMap(call.TransactItems[2].Delete.Key).pk).toBe(
          "$cricket#v1#watermark#writerid_ingest-0",
        )
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("supports Transaction.check items", () =>
      Effect.gen(function* () {
        mockTransactWriteItems.mockResolvedValue({})

        yield* MatchEvents.append({ matchId: "m-1" }, [startMatch()], 0, {
          additionalItems: [
            Transaction.check(
              Watermarks.get({ writerId: "ingest-1" }),
              Expression.condition({ lt: { lastSeq: 42 } }),
            ),
          ],
        })

        const call = mockTransactWriteItems.mock.calls[0]![0]
        const check = call.TransactItems[1].ConditionCheck
        expect(check.TableName).toBe("events-table")
        expect(check.ConditionExpression).toContain("<")
        expect(fromAttributeMap(check.Key).pk).toBe("$cricket#v1#watermark#writerid_ingest-1")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("maps an additional-item condition failure to AdditionalItemConditionFailed", () =>
      Effect.gen(function* () {
        mockTransactWriteItems.mockRejectedValue(
          cancelled([
            { Code: "None" },
            { Code: "None" },
            { Code: "ConditionalCheckFailed", Message: "watermark moved" },
          ]),
        )

        const error = yield* MatchEvents.append({ matchId: "m-1" }, [startMatch()], 0, {
          additionalItems: [
            Watermarks.put({ writerId: "ingest-1", lastSeq: 42 }),
            Transaction.check(
              Watermarks.get({ writerId: "ingest-1" }),
              Expression.condition({ lt: { lastSeq: 42 } }),
            ),
          ],
        }).pipe(Effect.flip)

        expect(error._tag).toBe("AdditionalItemConditionFailed")
        const failure = error as AdditionalItemConditionFailed
        expect(failure.streamName).toBe("Match")
        expect(failure.streamId).toBe("m-1")
        // Transaction index 2 → additionalItems index 1
        expect(failure.indices).toEqual([1])
        expect(failure.reasons).toHaveLength(3)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("reports every failing additional-item index", () =>
      Effect.gen(function* () {
        mockTransactWriteItems.mockRejectedValue(
          cancelled([
            { Code: "None" },
            { Code: "ConditionalCheckFailed" },
            { Code: "ConditionalCheckFailed" },
          ]),
        )

        const error = yield* MatchEvents.append({ matchId: "m-1" }, [startMatch()], 0, {
          additionalItems: [
            Watermarks.put({ writerId: "ingest-1", lastSeq: 42 }),
            Watermarks.put({ writerId: "ingest-2", lastSeq: 43 }),
          ],
        }).pipe(Effect.flip)

        expect((error as AdditionalItemConditionFailed).indices).toEqual([0, 1])
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("prefers VersionConflict when an event put also failed", () =>
      Effect.gen(function* () {
        mockTransactWriteItems.mockRejectedValue(
          cancelled([{ Code: "ConditionalCheckFailed" }, { Code: "ConditionalCheckFailed" }]),
        )

        const error = yield* MatchEvents.append({ matchId: "m-1" }, [startMatch()], 3, {
          additionalItems: [Watermarks.put({ writerId: "ingest-1", lastSeq: 42 })],
        }).pipe(Effect.flip)

        expect(error._tag).toBe("VersionConflict")
        expect((error as VersionConflict).expectedVersion).toBe(3)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("still maps VersionConflict correctly with additional items present", () =>
      Effect.gen(function* () {
        mockTransactWriteItems.mockRejectedValue(
          cancelled([{ Code: "ConditionalCheckFailed" }, { Code: "None" }]),
        )

        const error = yield* MatchEvents.append({ matchId: "m-1" }, [startMatch()], 7, {
          additionalItems: [Watermarks.put({ writerId: "ingest-1", lastSeq: 42 })],
        }).pipe(Effect.flip)

        expect(error._tag).toBe("VersionConflict")
        expect((error as VersionConflict).expectedVersion).toBe(7)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("falls back to TransactionCancelled when reasons are absent", () =>
      Effect.gen(function* () {
        mockTransactWriteItems.mockRejectedValue({ name: "TransactionCanceledException" })

        const error = yield* MatchEvents.append({ matchId: "m-1" }, [startMatch()], 0, {
          additionalItems: [Watermarks.put({ writerId: "ingest-1", lastSeq: 42 })],
        }).pipe(Effect.flip)

        expect(error._tag).toBe("TransactionCancelled")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("falls back to TransactionCancelled for non-conditional reasons", () =>
      Effect.gen(function* () {
        mockTransactWriteItems.mockRejectedValue(
          cancelled([{ Code: "TransactionConflict" }, { Code: "None" }]),
        )

        const error = yield* MatchEvents.append({ matchId: "m-1" }, [startMatch()], 0, {
          additionalItems: [Watermarks.put({ writerId: "ingest-1", lastSeq: 42 })],
        }).pipe(Effect.flip)

        expect(error._tag).toBe("TransactionCancelled")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("runs the transaction for zero events when additional items are present", () =>
      Effect.gen(function* () {
        mockTransactWriteItems.mockResolvedValue({})

        const result = yield* MatchEvents.append({ matchId: "m-1" }, [], 5, {
          additionalItems: [Watermarks.put({ writerId: "ingest-1", lastSeq: 42 })],
        })

        expect(result.version).toBe(5)
        expect(mockTransactWriteItems).toHaveBeenCalledOnce()
        expect(mockTransactWriteItems.mock.calls[0]![0].TransactItems).toHaveLength(1)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("fails with AppendTooLarge past the 100-item cap, without calling AWS", () =>
      Effect.gen(function* () {
        const events = Array.from({ length: 99 }, () => startMatch())

        const error = yield* MatchEvents.append({ matchId: "m-1" }, events, 0, {
          additionalItems: [
            Watermarks.put({ writerId: "ingest-1", lastSeq: 1 }),
            Watermarks.put({ writerId: "ingest-2", lastSeq: 2 }),
          ],
        }).pipe(Effect.flip)

        expect(error._tag).toBe("AppendTooLarge")
        const overflow = error as AppendTooLarge
        expect(overflow.streamName).toBe("Match")
        expect(overflow.count).toBe(101)
        expect(overflow.limit).toBe(TRANSACT_WRITE_ITEMS_LIMIT)
        expect(mockTransactWriteItems).not.toHaveBeenCalled()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("counts the idempotency sentinel against the cap", () =>
      Effect.gen(function* () {
        const events = Array.from({ length: 100 }, () => startMatch())

        const error = yield* MatchEvents.append({ matchId: "m-1" }, events, 0, {
          idempotency: { commandId: "cmd-1" },
        }).pipe(Effect.flip)

        expect(error._tag).toBe("AppendTooLarge")
        expect((error as AppendTooLarge).count).toBe(101)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("counts the version-contiguity ConditionCheck against the cap", () =>
      Effect.gen(function* () {
        // 99 events + 1 additional item = 100, which fits at expectedVersion 0.
        // At expectedVersion > 0 the contiguity ConditionCheck is the 101st item.
        const events = Array.from({ length: 99 }, () => startMatch())
        const additionalItems = [Watermarks.put({ writerId: "ingest-1", lastSeq: 1 })]

        const error = yield* MatchEvents.append({ matchId: "m-1" }, events, 7, {
          additionalItems,
        }).pipe(Effect.flip)

        expect(error._tag).toBe("AppendTooLarge")
        expect((error as AppendTooLarge).count).toBe(101)
        expect(mockTransactWriteItems).not.toHaveBeenCalled()
      }).pipe(Effect.provide(TestLayer)),
    )

    // -----------------------------------------------------------------------
    // #100 — the read-model use case: a put built from the bound client whose
    // entity was authored with the pure `@effect-dynamodb/schema` Entity.make.
    // Before the fix this failed with
    // ValidationError { entityType: "unknown", operation: "EventStore.append.additionalItems" }.
    // -----------------------------------------------------------------------

    it.effect("commits a pure-authored read-model put atomically with the events", () =>
      Effect.gen(function* () {
        mockTransactWriteItems.mockResolvedValue({})
        const db = yield* DynamoClient.make({
          entities: { StatusProjection },
          tables: { EventsTable },
        })

        yield* MatchEvents.append({ matchId: "m-1" }, [startMatch()], 0, {
          additionalItems: [
            db.entities.StatusProjection.put({ matchId: "m-1", state: "IN_PROGRESS" }),
          ],
        })

        const call = mockTransactWriteItems.mock.calls[0]![0]
        expect(call.TransactItems).toHaveLength(2)
        expect(fromAttributeMap(call.TransactItems[0].Put.Item).__edd_e__).toBe("match.event")

        const projection = fromAttributeMap(call.TransactItems[1].Put.Item)
        expect(call.TransactItems[1].Put.TableName).toBe("events-table")
        expect(projection.__edd_e__).toBe("Status")
        expect(projection.pk).toBe("$cricket#v1#status#matchid_m-1")
        expect(projection.state).toBe("IN_PROGRESS")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("supports a bound delete from a pure-authored entity", () =>
      Effect.gen(function* () {
        mockTransactWriteItems.mockResolvedValue({})
        const db = yield* DynamoClient.make({
          entities: { StatusProjection },
          tables: { EventsTable },
        })

        yield* MatchEvents.append({ matchId: "m-1" }, [startMatch()], 0, {
          additionalItems: [db.entities.StatusProjection.delete({ matchId: "m-1" })],
        })

        const call = mockTransactWriteItems.mock.calls[0]![0]
        expect(fromAttributeMap(call.TransactItems[1].Delete.Key).pk).toBe(
          "$cricket#v1#status#matchid_m-1",
        )
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("keeps cancellation indices aligned for a bound additional item", () =>
      Effect.gen(function* () {
        mockTransactWriteItems.mockRejectedValue(
          cancelled([{ Code: "None" }, { Code: "ConditionalCheckFailed", Message: "stale" }]),
        )
        const db = yield* DynamoClient.make({
          entities: { StatusProjection },
          tables: { EventsTable },
        })

        const error = yield* MatchEvents.append({ matchId: "m-1" }, [startMatch()], 0, {
          additionalItems: [
            db.entities.StatusProjection.put({ matchId: "m-1", state: "IN_PROGRESS" }).condition({
              state: "PRE_MATCH",
            }),
          ],
        }).pipe(Effect.flip)

        expect(error._tag).toBe("AdditionalItemConditionFailed")
        expect((error as AdditionalItemConditionFailed).indices).toEqual([0])
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  // -------------------------------------------------------------------------
  // append — command idempotency (#85)
  // -------------------------------------------------------------------------

  describe("append — idempotency", () => {
    const startMatch = () => new MatchStarted({ venue: "MCG", homeTeam: "AUS", awayTeam: "ENG" })

    it.effect("appends a dedup sentinel as the last transact item", () =>
      Effect.gen(function* () {
        mockTransactWriteItems.mockResolvedValue({})

        yield* MatchEvents.append({ matchId: "m-1" }, [startMatch()], 3, {
          idempotency: { commandId: "cmd-7f3a" },
        })

        const call = mockTransactWriteItems.mock.calls[0]![0]
        // [contiguity ConditionCheck (expectedVersion 3 > 0), event put, sentinel].
        // The sentinel is always LAST — that is what keeps additional-item
        // indices stable for the caller.
        expect(call.TransactItems).toHaveLength(3)
        expect(call.TransactItems[0].ConditionCheck).toBeDefined()

        const sentinel = call.TransactItems[call.TransactItems.length - 1].Put
        expect(sentinel.TableName).toBe("events-table")
        expect(sentinel.ConditionExpression).toBe("attribute_not_exists(pk)")

        const item = fromAttributeMap(sentinel.Item)
        expect(item.pk).toBe("$cricket#v1#match#m-1")
        expect(item.sk).toBe("$cricket#v1#match.command#cmd-7f3a")
        expect(item.__edd_e__).toBe("match.command")
        expect(item.streamId).toBe("m-1")
        expect(item.commandId).toBe("cmd-7f3a")
        expect(item.version).toBe(4)
        expect(item._ttl).toBeUndefined()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("keeps additional-item indices stable when a sentinel is present", () =>
      Effect.gen(function* () {
        mockTransactWriteItems.mockRejectedValue({
          name: "TransactionCanceledException",
          CancellationReasons: [
            { Code: "None" },
            { Code: "None" },
            { Code: "ConditionalCheckFailed" },
            { Code: "None" },
          ],
        })

        const error = yield* MatchEvents.append({ matchId: "m-1" }, [startMatch()], 0, {
          additionalItems: [
            Watermarks.put({ writerId: "ingest-1", lastSeq: 1 }),
            Watermarks.put({ writerId: "ingest-2", lastSeq: 2 }),
          ],
          idempotency: { commandId: "cmd-1" },
        }).pipe(Effect.flip)

        expect(error._tag).toBe("AdditionalItemConditionFailed")
        expect((error as AdditionalItemConditionFailed).indices).toEqual([1])
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("writes a TTL to the configured attribute when idempotency.ttl is set", () =>
      Effect.gen(function* () {
        mockTransactWriteItems.mockResolvedValue({})

        yield* MatchEvents.append({ matchId: "m-1" }, [startMatch()], 0, {
          idempotency: { commandId: "cmd-1", ttl: Duration.days(1) },
        })

        const item = fromAttributeMap(
          mockTransactWriteItems.mock.calls[0]![0].TransactItems[1].Put.Item,
        )
        // TestClock is frozen at epoch 0
        expect(item._ttl).toBe(86_400)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("honours TableConfig.ttlAttributeName for the sentinel", () =>
      Effect.gen(function* () {
        mockTransactWriteItems.mockResolvedValue({})

        yield* MatchEvents.append({ matchId: "m-1" }, [startMatch()], 0, {
          idempotency: { commandId: "cmd-1", ttl: "30 minutes" },
        })

        const item = fromAttributeMap(
          mockTransactWriteItems.mock.calls[0]![0].TransactItems[1].Put.Item,
        )
        expect(item.ttl).toBe(1_800)
        expect(item._ttl).toBeUndefined()
      }).pipe(
        Effect.provide(
          Layer.merge(
            TestDynamoClient,
            EventsTable.layer({ name: "events-table", ttlAttributeName: "ttl" }),
          ),
        ),
      ),
    )

    it.effect("maps a sentinel condition failure to DuplicateCommand", () =>
      Effect.gen(function* () {
        mockTransactWriteItems.mockRejectedValue({
          name: "TransactionCanceledException",
          CancellationReasons: [{ Code: "None" }, { Code: "ConditionalCheckFailed" }],
        })

        const error = yield* MatchEvents.append({ matchId: "m-1" }, [startMatch()], 0, {
          idempotency: { commandId: "cmd-7f3a" },
        }).pipe(Effect.flip)

        expect(error._tag).toBe("DuplicateCommand")
        const dup = error as DuplicateCommand
        expect(dup.streamName).toBe("Match")
        expect(dup.streamId).toBe("m-1")
        expect(dup.commandId).toBe("cmd-7f3a")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("prefers DuplicateCommand over VersionConflict", () =>
      Effect.gen(function* () {
        mockTransactWriteItems.mockRejectedValue({
          name: "TransactionCanceledException",
          CancellationReasons: [
            { Code: "ConditionalCheckFailed" },
            { Code: "ConditionalCheckFailed" },
          ],
        })

        const error = yield* MatchEvents.append({ matchId: "m-1" }, [startMatch()], 0, {
          idempotency: { commandId: "cmd-7f3a" },
        }).pipe(Effect.flip)

        expect(error._tag).toBe("DuplicateCommand")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("writes a sentinel with zero events when idempotency is requested", () =>
      Effect.gen(function* () {
        mockTransactWriteItems.mockResolvedValue({})

        const result = yield* MatchEvents.append({ matchId: "m-1" }, [], 2, {
          idempotency: { commandId: "cmd-1" },
        })

        expect(result.version).toBe(2)
        expect(mockTransactWriteItems.mock.calls[0]![0].TransactItems).toHaveLength(1)
      }).pipe(Effect.provide(TestLayer)),
    )
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

    it.effect("works in data-last (pipeable) form", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValueOnce({ Items: [] })
        mockTransactWriteItems.mockResolvedValueOnce({})

        const handle = pipe(MatchEvents, EventStore.commandHandler(matchDecider))

        const result = yield* handle(
          { matchId: "m-1" },
          { _tag: "StartMatch", venue: "MCG", homeTeam: "AUS", awayTeam: "ENG" },
        )

        expect(result.state.status).toBe("in-progress")
        expect(result.version).toBe(1)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("threads commandId into the append transaction when idempotency is configured", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValueOnce({ Items: [] })
        mockTransactWriteItems.mockResolvedValueOnce({})

        const handle = EventStore.commandHandler(matchDecider, MatchEvents, {
          idempotency: { ttl: Duration.days(1) },
        })

        yield* handle(
          { matchId: "m-1" },
          { _tag: "StartMatch", venue: "MCG", homeTeam: "AUS", awayTeam: "ENG" },
          { commandId: "cmd-7f3a" },
        )

        const call = mockTransactWriteItems.mock.calls[0]![0]
        expect(call.TransactItems).toHaveLength(2)
        const sentinel = fromAttributeMap(call.TransactItems[1].Put.Item)
        expect(sentinel.commandId).toBe("cmd-7f3a")
        expect(sentinel._ttl).toBe(86_400)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("surfaces DuplicateCommand on a replayed commandId", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValueOnce({ Items: [] })
        mockTransactWriteItems.mockRejectedValueOnce({
          name: "TransactionCanceledException",
          CancellationReasons: [{ Code: "None" }, { Code: "ConditionalCheckFailed" }],
        })

        const handle = EventStore.commandHandler(matchDecider, MatchEvents, {
          idempotency: {},
        })

        const error = yield* handle(
          { matchId: "m-1" },
          { _tag: "StartMatch", venue: "MCG", homeTeam: "AUS", awayTeam: "ENG" },
          { commandId: "cmd-7f3a" },
        ).pipe(Effect.flip)

        expect(error._tag).toBe("DuplicateCommand")
        expect((error as DuplicateCommand).commandId).toBe("cmd-7f3a")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect(
      "fails with ValidationError when idempotency is configured but commandId is absent",
      () =>
        Effect.gen(function* () {
          const handle = EventStore.commandHandler(matchDecider, MatchEvents, {
            idempotency: {},
          }) as unknown as (
            streamId: { matchId: string },
            command: MatchCommand,
          ) => Effect.Effect<unknown, { readonly _tag: string }, DynamoClient | Table.TableConfig>

          const error = yield* handle(
            { matchId: "m-1" },
            { _tag: "StartMatch", venue: "MCG", homeTeam: "AUS", awayTeam: "ENG" },
          ).pipe(Effect.flip)

          expect(error._tag).toBe("ValidationError")
          expect(mockQuery).not.toHaveBeenCalled()
        }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("forwards additionalItems from the per-call options", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValueOnce({ Items: [] })
        mockTransactWriteItems.mockResolvedValueOnce({})

        yield* handleMatch(
          { matchId: "m-1" },
          { _tag: "StartMatch", venue: "MCG", homeTeam: "AUS", awayTeam: "ENG" },
          { additionalItems: [Watermarks.put({ writerId: "ingest-1", lastSeq: 42 })] },
        )

        const call = mockTransactWriteItems.mock.calls[0]![0]
        expect(call.TransactItems).toHaveLength(2)
        expect(fromAttributeMap(call.TransactItems[1].Put.Item).__edd_e__).toBe("Watermark")
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

  // -------------------------------------------------------------------------
  // Snapshots (#84) — key scheme
  // -------------------------------------------------------------------------

  describe("snapshot key scheme", () => {
    it("snapshot SK can never collide with an event SK", () => {
      const snapshotSk = DynamoSchema.composeKey(AppSchema, "snapmatch.snapshot", [])
      expect(snapshotSk).toBe("$cricket#v1#snapmatch.snapshot")

      const eventPrefix = DynamoSchema.composeEventVersionKeyPrefix(AppSchema, "snapmatch.event")
      expect(eventPrefix).toBe("$cricket#v1#snapmatch.event_1#")
      expect(snapshotSk.startsWith(eventPrefix)).toBe(false)
    })

    it("snapshot SK sorts after every event SK in the partition", () => {
      const snapshotSk = DynamoSchema.composeKey(AppSchema, "snapmatch.snapshot", [])
      const firstEvent = DynamoSchema.composeEventVersionKey(AppSchema, "snapmatch.event", 1)
      const lastEvent = DynamoSchema.composeEventVersionKey(
        AppSchema,
        "snapmatch.event",
        DynamoSchema.MAX_EVENT_VERSION,
      )
      expect(snapshotSk > firstEvent).toBe(true)
      expect(snapshotSk > lastEvent).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // Snapshots (#84) — event reads are SK-range hardened
  // -------------------------------------------------------------------------

  describe("event read SK-range hardening", () => {
    it.effect("read bounds the key condition to the event prefix", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue({ Items: [] })

        yield* MatchEvents.read({ matchId: "m-1" })

        const call = mockQuery.mock.calls[0]![0]
        expect(call.KeyConditionExpression).toContain("begins_with(#sk, :sk)")
        expect(call.ExpressionAttributeValues[":sk"].S).toBe("$cricket#v1#match.event_1#")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("currentVersion bounds by prefix and issues exactly one request", () =>
      Effect.gen(function* () {
        // A `Limit`-bearing query returns a LastEvaluatedKey on every truncated
        // page. `collect` would walk the whole partition; `execute` must not.
        mockQuery.mockResolvedValue({
          Items: [makeEventItem("m-1", 7, "MatchEnded", { result: "AUS won" })],
          LastEvaluatedKey: { pk: { S: "$cricket#v1#match#m-1" }, sk: { S: "whatever" } },
        })

        const version = yield* MatchEvents.currentVersion({ matchId: "m-1" })

        expect(version).toBe(7)
        expect(mockQuery).toHaveBeenCalledOnce()
        const call = mockQuery.mock.calls[0]![0]
        expect(call.KeyConditionExpression).toContain("begins_with(#sk, :sk)")
        expect(call.ExpressionAttributeValues[":sk"].S).toBe("$cricket#v1#match.event_1#")
        expect(call.ScanIndexForward).toBe(false)
        expect(call.Limit).toBe(1)
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  // -------------------------------------------------------------------------
  // Snapshots (#84) — writeSnapshot / readSnapshot
  // -------------------------------------------------------------------------

  describe("writeSnapshot", () => {
    it.effect("writes the snapshot item with the expected shape", () =>
      Effect.gen(function* () {
        mockPutItem.mockResolvedValue({})

        yield* SnapshotMatchEvents.writeSnapshot(
          { matchId: "m-1" },
          { status: "in-progress", innings: [{ runs: 250, wickets: 10 }] },
          4,
        )

        const call = mockPutItem.mock.calls[0]![0]
        expect(call.TableName).toBe("events-table")

        const item = fromAttributeMap(call.Item)
        expect(item.pk).toBe("$cricket#v1#snapmatch#m-1")
        expect(item.sk).toBe("$cricket#v1#snapmatch.snapshot")
        expect(item.__edd_e__).toBe("snapmatch.snapshot")
        expect(item.streamId).toBe("m-1")
        expect(item.asOfVersion).toBe(4)
        expect(typeof item.timestamp).toBe("string")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("encodes state through the state schema", () =>
      Effect.gen(function* () {
        mockPutItem.mockResolvedValue({})

        yield* SnapshotMatchEvents.writeSnapshot(
          { matchId: "m-1" },
          {
            status: "completed",
            innings: [
              { runs: 250, wickets: 10 },
              { runs: 180, wickets: 8 },
            ],
          },
          9,
        )

        const item = fromAttributeMap(mockPutItem.mock.calls[0]![0].Item)
        // Encoded form, not the domain form.
        expect(item.state).toEqual({ status: "c", innings: ["250/10", "180/8"] })
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("uses a monotonic condition expression", () =>
      Effect.gen(function* () {
        mockPutItem.mockResolvedValue({})

        yield* SnapshotMatchEvents.writeSnapshot(
          { matchId: "m-1" },
          { status: "pending", innings: [] },
          12,
        )

        const call = mockPutItem.mock.calls[0]![0]
        expect(call.ConditionExpression).toBe(
          "attribute_not_exists(#pk) OR #asOfVersion < :asOfVersion",
        )
        expect(call.ExpressionAttributeNames).toEqual({
          "#pk": "pk",
          "#asOfVersion": "asOfVersion",
        })
        expect(call.ExpressionAttributeValues[":asOfVersion"].N).toBe("12")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("treats a losing monotonic race as a successful no-op", () =>
      Effect.gen(function* () {
        mockPutItem.mockRejectedValue({ name: "ConditionalCheckFailedException" })

        // Must not fail — the events the snapshot summarises are already durable.
        yield* SnapshotMatchEvents.writeSnapshot(
          { matchId: "m-1" },
          { status: "pending", innings: [] },
          1,
        )

        expect(mockPutItem).toHaveBeenCalledOnce()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("surfaces other PutItem failures", () =>
      Effect.gen(function* () {
        mockPutItem.mockRejectedValue({ name: "ProvisionedThroughputExceededException" })

        const error = yield* SnapshotMatchEvents.writeSnapshot(
          { matchId: "m-1" },
          { status: "pending", innings: [] },
          1,
        ).pipe(Effect.flip)

        expect(error._tag).toBe("DynamoError")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("fails with ValidationError when the state cannot be encoded", () =>
      Effect.gen(function* () {
        mockPutItem.mockResolvedValue({})

        const error = yield* SnapshotMatchEvents.writeSnapshot(
          { matchId: "m-1" },
          { status: "not-a-status", innings: [] } as never,
          1,
        ).pipe(Effect.flip)

        expect(error._tag).toBe("ValidationError")
        expect((error as ValidationError).operation).toBe("EventStore.writeSnapshot")
        expect(mockPutItem).not.toHaveBeenCalled()
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  describe("readSnapshot", () => {
    it.effect("returns None when no snapshot exists", () =>
      Effect.gen(function* () {
        mockGetItem.mockResolvedValue({})

        const result = yield* SnapshotMatchEvents.readSnapshot({ matchId: "m-1" })

        expect(Option.isNone(result)).toBe(true)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("reads by exact snapshot key with a consistent read", () =>
      Effect.gen(function* () {
        mockGetItem.mockResolvedValue({})

        yield* SnapshotMatchEvents.readSnapshot({ matchId: "m-1" })

        const call = mockGetItem.mock.calls[0]![0]
        expect(call.TableName).toBe("events-table")
        expect(fromAttributeMap(call.Key)).toEqual({
          pk: "$cricket#v1#snapmatch#m-1",
          sk: "$cricket#v1#snapmatch.snapshot",
        })
        expect(call.ConsistentRead).toBe(true)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("decodes state through the state schema", () =>
      Effect.gen(function* () {
        mockGetItem.mockResolvedValue({
          Item: makeSnapshotItem("snapmatch", "m-1", 6, {
            status: "i",
            innings: ["250/10"],
          }),
        })

        const result = yield* SnapshotMatchEvents.readSnapshot({ matchId: "m-1" })

        expect(Option.isSome(result)).toBe(true)
        const snapshot = Option.getOrThrow(result)
        expect(snapshot.asOfVersion).toBe(6)
        expect(snapshot.timestamp).toBe("2026-03-08T12:00:00.000Z")
        // Domain form, not the encoded form.
        expect(snapshot.state).toEqual({
          status: "in-progress",
          innings: [{ runs: 250, wickets: 10 }],
        })
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("surfaces a decode failure instead of silently replaying", () =>
      Effect.gen(function* () {
        mockGetItem.mockResolvedValue({
          Item: makeSnapshotItem("snapmatch", "m-1", 6, { status: "nope", innings: [] }),
        })

        const error = yield* SnapshotMatchEvents.readSnapshot({ matchId: "m-1" }).pipe(Effect.flip)

        expect(error._tag).toBe("ValidationError")
        expect((error as ValidationError).operation).toBe("EventStore.readSnapshot")
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  // -------------------------------------------------------------------------
  // Snapshots (#84) — configuration guards
  // -------------------------------------------------------------------------

  describe("snapshot configuration guards", () => {
    it("exposes snapshotConfig only when configured", () => {
      expect(MatchEvents.snapshotConfig).toBeUndefined()
      expect(SnapshotMatchEvents.snapshotConfig).toEqual({ every: 3 })
      expect(ManualSnapshotMatchEvents.snapshotConfig).toEqual({ every: undefined })
    })

    it("throws EDD-9027 when snapshot.every is not a positive integer", () => {
      const make = (every: number) =>
        EventStore.makeStream({
          table: EventsTable,
          streamName: "Bad",
          events: [MatchStarted],
          streamId: { composite: ["matchId"] },
          snapshot: { schema: MatchStateSchema, every },
        })

      expect(() => make(0)).toThrow(/EDD-9027/)
      expect(() => make(-1)).toThrow(/EDD-9027/)
      expect(() => make(2.5)).toThrow(/EDD-9027/)
    })

    it.effect("readSnapshot dies with EDD-9026 on an unconfigured stream", () =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          (MatchEvents as unknown as typeof SnapshotMatchEvents).readSnapshot({ matchId: "m-1" }),
        )
        expect(Exit.isFailure(exit)).toBe(true)
        expect(Cause.pretty((exit as Exit.Failure<never, never>).cause)).toContain("EDD-9026")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("writeSnapshot dies with EDD-9026 on an unconfigured stream", () =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          (MatchEvents as unknown as typeof SnapshotMatchEvents).writeSnapshot(
            { matchId: "m-1" },
            { status: "pending", innings: [] },
            1,
          ),
        )
        expect(Exit.isFailure(exit)).toBe(true)
        expect(Cause.pretty((exit as Exit.Failure<never, never>).cause)).toContain("EDD-9026")
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  // -------------------------------------------------------------------------
  // Snapshots (#84) — snapshot-aware commandHandler
  // -------------------------------------------------------------------------

  describe("snapshot-aware commandHandler", () => {
    const handleSnap = EventStore.commandHandler(matchDecider, SnapshotMatchEvents)

    it.effect("never reads a snapshot for a stream without snapshot config", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue({ Items: [] })
        mockTransactWriteItems.mockResolvedValue({})

        const handle = EventStore.commandHandler(matchDecider, MatchEvents)
        yield* handle(
          { matchId: "m-1" },
          { _tag: "StartMatch", venue: "MCG", homeTeam: "AUS", awayTeam: "ENG" },
        )

        expect(mockGetItem).not.toHaveBeenCalled()
        expect(mockPutItem).not.toHaveBeenCalled()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("cold start with no snapshot falls back to a full replay", () =>
      Effect.gen(function* () {
        mockGetItem.mockResolvedValue({})
        mockQuery.mockResolvedValue({ Items: [] })
        mockTransactWriteItems.mockResolvedValue({})

        const result = yield* handleSnap(
          { matchId: "m-1" },
          { _tag: "StartMatch", venue: "MCG", homeTeam: "AUS", awayTeam: "ENG" },
        )

        expect(result.version).toBe(1)
        // Full replay: `begins_with` over the whole event range, no lower bound.
        const call = mockQuery.mock.calls[0]![0]
        expect(call.KeyConditionExpression).toContain("begins_with(#sk, :sk)")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("folds from the snapshot and reads only the delta", () =>
      Effect.gen(function* () {
        mockGetItem.mockResolvedValue({
          Item: makeSnapshotItem("snapmatch", "m-1", 3, {
            status: "i",
            innings: ["250/10"],
          }),
        })
        // One event after the snapshot.
        mockQuery.mockResolvedValue({
          Items: [
            makeStreamEventItem("snapmatch", "m-1", 4, "InningsCompleted", {
              innings: 2,
              runs: 180,
              wickets: 8,
            }),
          ],
        })
        mockTransactWriteItems.mockResolvedValue({})

        const result = yield* handleSnap(
          { matchId: "m-1" },
          { _tag: "EndMatch", result: "AUS won" },
        )

        // Delta query is a BETWEEN starting at snapshot version + 1.
        const call = mockQuery.mock.calls[0]![0]
        expect(call.KeyConditionExpression).toContain("#sk BETWEEN :sk1 AND :sk2")
        expect(call.ExpressionAttributeValues[":sk1"].S).toBe(
          DynamoSchema.composeEventVersionKey(AppSchema, "snapmatch.event", 4),
        )

        // Base version comes from the delta's newest event, so the append CAS is v5.
        expect(result.version).toBe(5)
        const appended = firstAppendedEvent(mockTransactWriteItems.mock.calls[0]![0])
        expect(appended.version).toBe(5)

        // State carries the snapshot's innings plus the delta's.
        expect(result.state.status).toBe("completed")
        expect(result.state.innings).toEqual([
          { runs: 250, wickets: 10 },
          { runs: 180, wickets: 8 },
        ])
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("uses the snapshot version as the base when the delta is empty", () =>
      Effect.gen(function* () {
        mockGetItem.mockResolvedValue({
          Item: makeSnapshotItem("snapmatch", "m-1", 3, { status: "i", innings: [] }),
        })
        mockQuery.mockResolvedValue({ Items: [] })
        mockTransactWriteItems.mockResolvedValue({})

        const result = yield* handleSnap(
          { matchId: "m-1" },
          { _tag: "EndMatch", result: "AUS won" },
        )

        expect(result.version).toBe(4)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("writes an auto-snapshot once the cadence threshold is crossed", () =>
      Effect.gen(function* () {
        // every: 3 — snapshot at v1, appending to v4 crosses the threshold.
        mockGetItem.mockResolvedValue({
          Item: makeSnapshotItem("snapmatch", "m-1", 1, { status: "i", innings: [] }),
        })
        mockQuery.mockResolvedValue({
          Items: [
            makeStreamEventItem("snapmatch", "m-1", 2, "InningsCompleted", {
              innings: 1,
              runs: 250,
              wickets: 10,
            }),
            makeStreamEventItem("snapmatch", "m-1", 3, "InningsCompleted", {
              innings: 2,
              runs: 180,
              wickets: 8,
            }),
          ],
        })
        mockTransactWriteItems.mockResolvedValue({})
        mockPutItem.mockResolvedValue({})

        yield* handleSnap({ matchId: "m-1" }, { _tag: "EndMatch", result: "AUS won" })

        expect(mockPutItem).toHaveBeenCalledOnce()
        const item = fromAttributeMap(mockPutItem.mock.calls[0]![0].Item)
        expect(item.asOfVersion).toBe(4)
        expect(item.state).toEqual({ status: "c", innings: ["250/10", "180/8"] })
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("does not auto-snapshot below the cadence threshold", () =>
      Effect.gen(function* () {
        // every: 3 — snapshot at v3, appending to v4 is only 1 event on.
        mockGetItem.mockResolvedValue({
          Item: makeSnapshotItem("snapmatch", "m-1", 3, { status: "i", innings: [] }),
        })
        mockQuery.mockResolvedValue({ Items: [] })
        mockTransactWriteItems.mockResolvedValue({})

        yield* handleSnap({ matchId: "m-1" }, { _tag: "EndMatch", result: "AUS won" })

        expect(mockPutItem).not.toHaveBeenCalled()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("never auto-snapshots when `every` is not configured", () =>
      Effect.gen(function* () {
        mockGetItem.mockResolvedValue({})
        mockQuery.mockResolvedValue({ Items: [] })
        mockTransactWriteItems.mockResolvedValue({})

        const handle = EventStore.commandHandler(matchDecider, ManualSnapshotMatchEvents)
        yield* handle(
          { matchId: "m-1" },
          { _tag: "StartMatch", venue: "MCG", homeTeam: "AUS", awayTeam: "ENG" },
        )

        expect(mockGetItem).toHaveBeenCalledOnce()
        expect(mockPutItem).not.toHaveBeenCalled()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("swallows an auto-snapshot write failure (events are already durable)", () =>
      Effect.gen(function* () {
        mockGetItem.mockResolvedValue({})
        mockQuery.mockResolvedValue({ Items: [] })
        mockTransactWriteItems.mockResolvedValue({})
        mockPutItem.mockRejectedValue({ name: "InternalServerError" })

        const stream = EventStore.makeStream({
          table: EventsTable,
          streamName: "EagerSnap",
          events: [MatchStarted, InningsCompleted, MatchEnded],
          streamId: { composite: ["matchId"] },
          snapshot: { schema: MatchStateSchema, every: 1 },
        })
        const handle = EventStore.commandHandler(matchDecider, stream)

        const result = yield* handle(
          { matchId: "m-1" },
          { _tag: "StartMatch", venue: "MCG", homeTeam: "AUS", awayTeam: "ENG" },
        )

        expect(result.version).toBe(1)
        expect(mockPutItem).toHaveBeenCalledOnce()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("no-op commands do not append or snapshot", () =>
      Effect.gen(function* () {
        mockGetItem.mockResolvedValue({
          Item: makeSnapshotItem("snapmatch", "m-1", 9, { status: "i", innings: [] }),
        })
        mockQuery.mockResolvedValue({ Items: [] })

        const noopDecider: EventStore.Decider<MatchState, MatchCommand, MatchEvent> = {
          ...matchDecider,
          decide: () => Effect.succeed([]),
        }
        const handle = EventStore.commandHandler(noopDecider, SnapshotMatchEvents)
        const result = yield* handle({ matchId: "m-1" }, { _tag: "EndMatch", result: "x" })

        expect(result.events).toEqual([])
        expect(result.version).toBe(9)
        expect(mockTransactWriteItems).not.toHaveBeenCalled()
        expect(mockPutItem).not.toHaveBeenCalled()
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  // -------------------------------------------------------------------------
  // commandHandler dual dispatch (#84) — data-last was broken before
  // -------------------------------------------------------------------------

  describe("commandHandler dual dispatch", () => {
    it.effect("data-last without options", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue({ Items: [] })
        mockTransactWriteItems.mockResolvedValue({})

        const handle = MatchEvents.pipe(EventStore.commandHandler(matchDecider))
        const result = yield* handle(
          { matchId: "m-1" },
          { _tag: "StartMatch", venue: "MCG", homeTeam: "AUS", awayTeam: "ENG" },
        )

        expect(result.version).toBe(1)
        expect(result.state.status).toBe("in-progress")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("data-last with options", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue({ Items: [] })
        mockTransactWriteItems
          .mockRejectedValueOnce({
            name: "TransactionCanceledException",
            CancellationReasons: [{ Code: "ConditionalCheckFailed" }],
          })
          .mockResolvedValue({})

        const handle = MatchEvents.pipe(EventStore.commandHandler(matchDecider, { retry: 2 }))
        const result = yield* handle(
          { matchId: "m-1" },
          { _tag: "StartMatch", venue: "MCG", homeTeam: "AUS", awayTeam: "ENG" },
        )

        expect(result.version).toBe(1)
        expect(mockTransactWriteItems).toHaveBeenCalledTimes(2)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("data-last works with a BoundEventStream", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue({ Items: [] })
        mockTransactWriteItems.mockResolvedValue({})

        const bound = yield* EventStore.bind(MatchEvents)
        const handle = bound.pipe(EventStore.commandHandler(matchDecider))
        const result = yield* handle(
          { matchId: "m-1" },
          { _tag: "StartMatch", venue: "MCG", homeTeam: "AUS", awayTeam: "ENG" },
        )

        expect(result.version).toBe(1)
      }).pipe(Effect.provide(TestLayer)),
    )

    // Regression guard for the reconciliation of #84 and #85: both layers added a
    // trailing options argument to `commandHandler`, and the whole reason this is
    // a hand-rolled dual on the `EventStreamTypeId` brand rather than
    // `Function.dual`'s numeric-arity form is that the arity form SILENTLY DROPS
    // that trailing argument in the data-last position. A dropped `{ retry }`
    // degrades to no retry; a dropped `{ idempotency }` degrades to at-least-once
    // — both look like success until the day they matter. Assert the option
    // actually reaches the implementation, for BOTH option kinds and BOTH stream
    // kinds.
    it.effect("data-last passes an idempotency option through (EventStream)", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue({ Items: [] })
        mockTransactWriteItems.mockResolvedValue({})

        const handle = MatchEvents.pipe(
          EventStore.commandHandler(matchDecider, { idempotency: { ttl: Duration.days(1) } }),
        )
        yield* handle(
          { matchId: "m-1" },
          { _tag: "StartMatch", venue: "MCG", homeTeam: "AUS", awayTeam: "ENG" },
          { commandId: "cmd-datalast" },
        )

        // The dedup sentinel exists only if `{ idempotency }` survived the pipe.
        const items = mockTransactWriteItems.mock.calls[0]![0].TransactItems
        const sentinel = fromAttributeMap(items[items.length - 1].Put.Item)
        expect(sentinel.__edd_e__).toBe("match.command")
        expect(sentinel.commandId).toBe("cmd-datalast")
        expect(sentinel._ttl).toBeDefined()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("data-last passes an idempotency option through (BoundEventStream)", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue({ Items: [] })
        mockTransactWriteItems.mockResolvedValue({})

        const bound = yield* EventStore.bind(MatchEvents)
        const handle = bound.pipe(EventStore.commandHandler(matchDecider, { idempotency: {} }))
        yield* handle(
          { matchId: "m-1" },
          { _tag: "StartMatch", venue: "MCG", homeTeam: "AUS", awayTeam: "ENG" },
          { commandId: "cmd-bound-datalast" },
        )

        const items = mockTransactWriteItems.mock.calls[0]![0].TransactItems
        const sentinel = fromAttributeMap(items[items.length - 1].Put.Item)
        expect(sentinel.__edd_e__).toBe("match.command")
        expect(sentinel.commandId).toBe("cmd-bound-datalast")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("data-last passes a retry option through (BoundEventStream)", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue({ Items: [] })
        mockTransactWriteItems
          .mockRejectedValueOnce({
            name: "TransactionCanceledException",
            CancellationReasons: [{ Code: "ConditionalCheckFailed" }],
          })
          .mockResolvedValue({})

        const bound = yield* EventStore.bind(MatchEvents)
        const handle = bound.pipe(EventStore.commandHandler(matchDecider, { retry: 2 }))
        const result = yield* handle(
          { matchId: "m-1" },
          { _tag: "StartMatch", venue: "MCG", homeTeam: "AUS", awayTeam: "ENG" },
        )

        expect(result.version).toBe(1)
        // Without the option surviving the pipe this would be 1 and the effect
        // would have failed with VersionConflict.
        expect(mockTransactWriteItems).toHaveBeenCalledTimes(2)
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  // -------------------------------------------------------------------------
  // commandHandler retry (#84)
  // -------------------------------------------------------------------------

  describe("commandHandler retry", () => {
    const conflict = {
      name: "TransactionCanceledException",
      CancellationReasons: [{ Code: "ConditionalCheckFailed" }],
    }

    it.effect("no retry by default — VersionConflict propagates", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue({ Items: [] })
        mockTransactWriteItems.mockRejectedValue(conflict)

        const handle = EventStore.commandHandler(matchDecider, MatchEvents)
        const error = yield* handle(
          { matchId: "m-1" },
          { _tag: "StartMatch", venue: "MCG", homeTeam: "AUS", awayTeam: "ENG" },
        ).pipe(Effect.flip)

        expect(error._tag).toBe("VersionConflict")
        expect(mockTransactWriteItems).toHaveBeenCalledOnce()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("retry: n re-runs the FULL read-decide-append cycle", () =>
      Effect.gen(function* () {
        const started = makeEventItem("m-1", 1, "MatchStarted", {
          venue: "MCG",
          homeTeam: "AUS",
          awayTeam: "ENG",
        })
        const firstInnings = makeEventItem("m-1", 2, "InningsCompleted", {
          innings: 1,
          runs: 250,
          wickets: 10,
        })

        // First attempt sees the stream at v1 and appends at v2 — but a
        // concurrent writer got there first, so the CAS fails. The retry must
        // re-READ (now v2), re-DECIDE against the fresh state, and append at v3.
        // A blind re-append would target v2 again and conflict forever.
        mockQuery
          .mockResolvedValueOnce({ Items: [started] })
          .mockResolvedValue({ Items: [started, firstInnings] })
        mockTransactWriteItems.mockRejectedValueOnce(conflict).mockResolvedValue({})

        const handle = EventStore.commandHandler(matchDecider, MatchEvents, { retry: 3 })
        const result = yield* handle(
          { matchId: "m-1" },
          { _tag: "CompleteInnings", innings: 2, runs: 180, wickets: 8 },
        )

        // Re-read happened (two queries), and the second append targets v3.
        expect(mockQuery).toHaveBeenCalledTimes(2)
        expect(mockTransactWriteItems).toHaveBeenCalledTimes(2)
        expect(result.version).toBe(3)
        const firstAppend = firstAppendedEvent(mockTransactWriteItems.mock.calls[0]![0])
        expect(firstAppend.version).toBe(2)
        const secondAppend = firstAppendedEvent(mockTransactWriteItems.mock.calls[1]![0])
        expect(secondAppend.version).toBe(3)
        // Fresh decide: state already carries the concurrent innings.
        expect(result.state.innings).toHaveLength(2)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("retry accepts an Effect Schedule", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue({ Items: [] })
        mockTransactWriteItems
          .mockRejectedValueOnce(conflict)
          .mockRejectedValueOnce(conflict)
          .mockResolvedValue({})

        const handle = EventStore.commandHandler(matchDecider, MatchEvents, {
          retry: Schedule.recurs(5),
        })
        const result = yield* handle(
          { matchId: "m-1" },
          { _tag: "StartMatch", venue: "MCG", homeTeam: "AUS", awayTeam: "ENG" },
        )

        expect(result.version).toBe(1)
        expect(mockTransactWriteItems).toHaveBeenCalledTimes(3)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("gives up after the policy is exhausted", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue({ Items: [] })
        mockTransactWriteItems.mockRejectedValue(conflict)

        const handle = EventStore.commandHandler(matchDecider, MatchEvents, { retry: 2 })
        const error = yield* handle(
          { matchId: "m-1" },
          { _tag: "StartMatch", venue: "MCG", homeTeam: "AUS", awayTeam: "ENG" },
        ).pipe(Effect.flip)

        expect(error._tag).toBe("VersionConflict")
        // Initial attempt + 2 retries.
        expect(mockTransactWriteItems).toHaveBeenCalledTimes(3)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("does not retry domain errors", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue({
          Items: [
            makeEventItem("m-1", 1, "MatchStarted", {
              venue: "MCG",
              homeTeam: "AUS",
              awayTeam: "ENG",
            }),
          ],
        })

        const handle = EventStore.commandHandler(matchDecider, MatchEvents, { retry: 5 })
        const error = yield* handle(
          { matchId: "m-1" },
          { _tag: "StartMatch", venue: "SCG", homeTeam: "AUS", awayTeam: "IND" },
        ).pipe(Effect.flip)

        expect(error._tag).toBe("AlreadyStarted")
        expect(mockQuery).toHaveBeenCalledOnce()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("does not retry infrastructure errors", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue({ Items: [] })
        mockTransactWriteItems.mockRejectedValue({ name: "InternalServerError" })

        const handle = EventStore.commandHandler(matchDecider, MatchEvents, { retry: 5 })
        const error = yield* handle(
          { matchId: "m-1" },
          { _tag: "StartMatch", venue: "MCG", homeTeam: "AUS", awayTeam: "ENG" },
        ).pipe(Effect.flip)

        expect(error._tag).toBe("DynamoError")
        expect(mockTransactWriteItems).toHaveBeenCalledOnce()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("retry composes with the snapshot-aware read path", () =>
      Effect.gen(function* () {
        mockGetItem.mockResolvedValue({
          Item: makeSnapshotItem("snapmatch", "m-1", 1, { status: "i", innings: [] }),
        })
        mockQuery.mockResolvedValue({ Items: [] })
        mockTransactWriteItems.mockRejectedValueOnce(conflict).mockResolvedValue({})

        const handle = EventStore.commandHandler(matchDecider, SnapshotMatchEvents, { retry: 2 })
        const result = yield* handle({ matchId: "m-1" }, { _tag: "EndMatch", result: "AUS won" })

        // The snapshot is re-read on the retry — the whole cycle re-runs.
        expect(mockGetItem).toHaveBeenCalledTimes(2)
        expect(result.version).toBe(2)
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  // -------------------------------------------------------------------------
  // bind parity (#84)
  // -------------------------------------------------------------------------

  describe("bind snapshot parity", () => {
    it.effect("carries snapshotConfig and both primitives with R = never", () =>
      Effect.gen(function* () {
        mockGetItem.mockResolvedValue({
          Item: makeSnapshotItem("snapmatch", "m-1", 2, { status: "i", innings: [] }),
        })
        mockPutItem.mockResolvedValue({})

        const bound = yield* EventStore.bind(SnapshotMatchEvents)
        expect(bound.snapshotConfig).toEqual({ every: 3 })

        const snapshot = yield* bound.readSnapshot({ matchId: "m-1" })
        expect(Option.getOrThrow(snapshot).asOfVersion).toBe(2)

        yield* bound.writeSnapshot({ matchId: "m-1" }, { status: "completed", innings: [] }, 5)
        expect(fromAttributeMap(mockPutItem.mock.calls[0]![0].Item).asOfVersion).toBe(5)
      }).pipe(Effect.provide(TestLayer)),
    )
  })
})
