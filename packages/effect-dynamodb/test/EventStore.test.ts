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
  type UniqueConstraintViolation,
  type ValidationError,
  VersionConflict,
} from "@effect-dynamodb/schema/Errors.js"
import {
  Cause,
  Context,
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
import { TRANSACT_WRITE_MAX_BYTES, transactItemBytes } from "../src/internal/ItemSize.js"
import { refuseRepeatedItems, transactItemTarget } from "../src/internal/TransactWriteOps.js"
import { fromAttributeMap, toAttributeMap } from "../src/Marshaller.js"
import * as Query from "../src/Query.js"
import * as Table from "../src/Table.js"
import * as Transaction from "../src/Transaction.js"
import { mockDynamoClientLayer } from "./helpers/MockDynamoClient.js"

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

// #113 — an entity whose put expands into three items (row + sentinel +
// snapshot). Used to prove `additionalItems` indices survive expansion.
class Registration extends Schema.Class<Registration>("Registration")({
  regId: Schema.String,
  code: Schema.String,
}) {}

const Registrations = Entity.make({
  model: Registration,
  entityType: "Registration",
  primaryKey: { pk: { field: "pk", composite: ["regId"] }, sk: { field: "sk", composite: [] } },
  unique: { code: ["code"] },
  versioned: { retain: true },
})

// #120 — a read model keyed by a framework-generated id. The "commit the read
// model atomically with the events that produced it" pattern (#100) was barred
// outright for this shape, even when the caller supplied the id and so needed
// no `Crypto` at all.
class AuditRecord extends Schema.Class<AuditRecord>("AuditRecord")({
  auditId: Schema.String,
  note: Schema.String,
}) {}

const AuditRecords = Entity.make({
  model: AuditRecord,
  entityType: "Audit",
  primaryKey: { pk: { field: "pk", composite: ["auditId"] }, sk: { field: "sk", composite: [] } },
  generatedId: { field: "auditId" },
})

const EventsTable = Table.make({
  schema: AppSchema,
  entities: { Watermarks, StatusProjection, Registrations, AuditRecords },
})

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

const TestDynamoClient = mockDynamoClientLayer({
  // Unanswered, a query finds nothing — a guarded additional put of a missing
  // retain item looks for its retained history (#133).
  query: (input) =>
    Effect.tryPromise({
      try: async () => (await mockQuery(input)) ?? { Items: [] },
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
  // Unanswered, a read finds no item (a guarded additional put reads its item).
  getItem: (input) =>
    Effect.tryPromise({
      try: async () => (await mockGetItem(input)) ?? {},
      catch: (e) => new DynamoError({ operation: "GetItem", cause: e }),
    }),
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
 * The page `readLatest` gets back from its single reverse query: the snapshot
 * first (its SK sorts after every event), then the events newest-first.
 * `events` are given ascending, as they are written.
 */
const latestPage = (
  snapshot: ReturnType<typeof makeSnapshotItem> | undefined,
  events: ReadonlyArray<ReturnType<typeof makeEventItem>> = [],
) => ({ Items: [...(snapshot === undefined ? [] : [snapshot]), ...[...events].reverse()] })

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

    it.effect("refuses additional items that repeat one item, before writing (#133)", () =>
      Effect.gen(function* () {
        const twice = yield* MatchEvents.append({ matchId: "m-1" }, [startMatch()], 0, {
          additionalItems: [
            Watermarks.put({ writerId: "ingest-1", lastSeq: 1 }),
            Watermarks.put({ writerId: "ingest-1", lastSeq: 2 }),
          ],
        }).pipe(Effect.flip)
        expect(twice._tag).toBe("ValidationError")
        expect((twice as ValidationError).entityType).toBe("Watermark")
        expect(String((twice as ValidationError).cause)).toContain(
          "touches one item more than once",
        )

        // A versioned retain put repeated: refused too, never judged a lost race.
        const retained = yield* MatchEvents.append({ matchId: "m-1" }, [startMatch()], 0, {
          additionalItems: [
            Registrations.put({ regId: "r-1", code: "a" }),
            Registrations.put({ regId: "r-1", code: "a" }),
          ],
        }).pipe(Effect.flip)
        expect(retained._tag).toBe("ValidationError")
        expect(mockTransactWriteItems).not.toHaveBeenCalled()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("refuses an append whose items exceed DynamoDB's 4 MB, before writing (#133)", () =>
      Effect.gen(function* () {
        const big = "x".repeat(380_000)
        const error = yield* MatchEvents.append({ matchId: "m-1" }, [startMatch()], 0, {
          additionalItems: Array.from({ length: 6 }, (_, i) =>
            Registrations.put({ regId: `r-${i}`, code: `${i}${big}` }),
          ),
        }).pipe(Effect.flip)
        expect(error._tag).toBe("ValidationError")
        expect((error as ValidationError).entityType).toBe("Registration")
        expect(String((error as ValidationError).cause)).toContain("4194304 bytes (4 MB)")
        expect(mockTransactWriteItems).not.toHaveBeenCalled()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("an additional item repeating a stream item is refused by the same check", () =>
      Effect.gen(function* () {
        // No entity key composes to a stream key (names prefix every composite),
        // so the stream-side targets are proven against the check directly.
        const key = {
          pk: { S: "$cricket#v1#match#m-1" },
          sk: { S: "$cricket#v1#match.event_1#0000000001" },
        }
        const error = yield* refuseRepeatedItems(
          [
            transactItemTarget(
              { Put: { TableName: "events-table", Item: { ...key, data: { S: "x" } } } },
              "events-table",
              ["pk", "sk"],
              "match.event",
              "the event at version 1",
            ),
            transactItemTarget(
              { Delete: { TableName: "events-table", Key: key } },
              "events-table",
              ["pk", "sk"],
              "Watermark",
              "operation 0 (Watermark)",
            ),
          ],
          "EventStore.append",
        ).pipe(Effect.flip)
        expect(error.entityType).toBe("match.event")
        expect(String(error.cause)).toContain(
          "the event at version 1 and operation 0 (Watermark) both target the item",
        )
        // A different table is a different item.
        yield* refuseRepeatedItems(
          [
            transactItemTarget(
              { Delete: { TableName: "a", Key: key } },
              "a",
              ["pk", "sk"],
              "X",
              "x",
            ),
            transactItemTarget(
              { Delete: { TableName: "b", Key: key } },
              "b",
              ["pk", "sk"],
              "X",
              "y",
            ),
          ],
          "EventStore.append",
        )
      }),
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
              Watermarks.get({ writerId: "ingest-2" }),
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

    // -----------------------------------------------------------------------
    // #120 — a generatedId read model, committed with the events that made it.
    // -----------------------------------------------------------------------

    it.effect("commits a generatedId read model when the caller supplies the id", () =>
      Effect.gen(function* () {
        mockTransactWriteItems.mockResolvedValue({})

        yield* MatchEvents.append({ matchId: "m-1" }, [startMatch()], 0, {
          additionalItems: [AuditRecords.put({ auditId: "a-1", note: "match started" })],
        })

        const call = mockTransactWriteItems.mock.calls[0]![0]
        expect(call.TransactItems).toHaveLength(2)
        const audit = fromAttributeMap(call.TransactItems[1].Put.Item)
        expect(audit.auditId).toBe("a-1")
        expect(audit.pk).toBe("$cricket#v1#audit#auditid_a-1")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("still refuses one whose id would have to be generated here", () =>
      Effect.gen(function* () {
        const error = yield* MatchEvents.append({ matchId: "m-1" }, [startMatch()], 0, {
          additionalItems: [AuditRecords.put({ note: "match started" } as never)],
        }).pipe(Effect.flip)

        expect(error._tag).toBe("ValidationError")
        expect(String((error as { cause: unknown }).cause)).toContain("omitted generated id")
        expect(mockTransactWriteItems).not.toHaveBeenCalled()
      }).pipe(Effect.provide(TestLayer)),
    )

    // -----------------------------------------------------------------------
    // #113 — one additional op can now emit several items. The caller-facing
    // `indices` must stay indices into the caller's `additionalItems` array.
    // -----------------------------------------------------------------------

    it.effect("expands a unique + retain additional item into item, sentinel and snapshot", () =>
      Effect.gen(function* () {
        mockTransactWriteItems.mockResolvedValue({})

        yield* MatchEvents.append({ matchId: "m-1" }, [startMatch()], 0, {
          additionalItems: [Registrations.put({ regId: "r-1", code: "C1" })],
        })

        const items = mockTransactWriteItems.mock.calls[0]![0].TransactItems
        // 1 event + (row + sentinel + snapshot)
        expect(items).toHaveLength(4)
        expect(fromAttributeMap(items[0].Put.Item).__edd_e__).toBe("match.event")
        expect(fromAttributeMap(items[1].Put.Item).__edd_e__).toBe("Registration")
        expect(fromAttributeMap(items[2].Put.Item).__edd_e__).toBe("Registration._unique.code")
        expect(items[2].Put.ConditionExpression).toBe("attribute_not_exists(#sentinel_pk)")
        expect(items[2].Put.ExpressionAttributeNames).toEqual({ "#sentinel_pk": "pk" })
        expect(fromAttributeMap(items[3].Put.Item).sk).toBe("$cricket#v1#registration#v#0000001")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect(
      "a taken unique value is a UniqueConstraintViolation, not the caller's condition",
      () =>
        Effect.gen(function* () {
          // Layout: [event, reg row, reg sentinel, reg snapshot]. The sentinel is
          // transaction index 2, but it belongs to caller additionalItems index 0
          // — whose caller set no condition, so it is not
          // AdditionalItemConditionFailed: it is what `Registrations.put` reports
          // for the same item (#133).
          mockTransactWriteItems.mockRejectedValue(
            cancelled([
              { Code: "None" },
              { Code: "None" },
              { Code: "ConditionalCheckFailed", Message: "code taken" },
              { Code: "None" },
            ]),
          )

          const error = yield* MatchEvents.append({ matchId: "m-1" }, [startMatch()], 0, {
            additionalItems: [Registrations.put({ regId: "r-1", code: "C1" })],
          }).pipe(Effect.flip)

          expect(error._tag).toBe("UniqueConstraintViolation")
          expect((error as UniqueConstraintViolation).fields).toEqual({ code: "C1" })
        }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("maps a later op's failure past an earlier op's expansion", () =>
      Effect.gen(function* () {
        // Layout: [event, reg row, reg sentinel, reg snapshot, watermark].
        // The watermark is caller index 1 but transaction index 4.
        mockTransactWriteItems.mockRejectedValue(
          cancelled([
            { Code: "None" },
            { Code: "None" },
            { Code: "None" },
            { Code: "None" },
            { Code: "ConditionalCheckFailed", Message: "watermark moved" },
          ]),
        )

        const error = yield* MatchEvents.append({ matchId: "m-1" }, [startMatch()], 0, {
          additionalItems: [
            Registrations.put({ regId: "r-1", code: "C1" }),
            Watermarks.put({ writerId: "ingest-1", lastSeq: 42 }),
          ],
        }).pipe(Effect.flip)

        expect(error._tag).toBe("AdditionalItemConditionFailed")
        expect((error as AdditionalItemConditionFailed).indices).toEqual([1])
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("reports one caller index even when several of its items fail", () =>
      Effect.gen(function* () {
        // The row (its caller's condition) and its snapshot both fail.
        mockTransactWriteItems.mockRejectedValue(
          cancelled([
            { Code: "None" },
            { Code: "ConditionalCheckFailed" },
            { Code: "None" },
            { Code: "ConditionalCheckFailed" },
          ]),
        )

        const error = yield* MatchEvents.append({ matchId: "m-1" }, [startMatch()], 0, {
          additionalItems: [
            Registrations.put({ regId: "r-1", code: "C1" }).pipe(
              Registrations.condition({ code: "C0" }),
            ),
          ],
        }).pipe(Effect.flip)

        expect(error._tag).toBe("AdditionalItemConditionFailed")
        // Deduped — the caller passed one op and must be told about one op.
        expect((error as AdditionalItemConditionFailed).indices).toEqual([0])
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("an event-put failure still wins over an expanded additional item", () =>
      Effect.gen(function* () {
        // Precedence must be unchanged: VersionConflict > AdditionalItemConditionFailed.
        mockTransactWriteItems.mockRejectedValue(
          cancelled([
            { Code: "ConditionalCheckFailed" },
            { Code: "None" },
            { Code: "ConditionalCheckFailed" },
            { Code: "None" },
          ]),
        )

        const error = yield* MatchEvents.append({ matchId: "m-1" }, [startMatch()], 0, {
          additionalItems: [Registrations.put({ regId: "r-1", code: "C1" })],
        }).pipe(Effect.flip)

        expect(error._tag).toBe("VersionConflict")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("the idempotency sentinel stays LAST after expansion", () =>
      Effect.gen(function* () {
        mockTransactWriteItems.mockResolvedValue({})

        yield* MatchEvents.append({ matchId: "m-1" }, [startMatch()], 0, {
          additionalItems: [Registrations.put({ regId: "r-1", code: "C1" })],
          idempotency: { commandId: "cmd-1" },
        })

        const items = mockTransactWriteItems.mock.calls[0]![0].TransactItems
        expect(items).toHaveLength(5)
        expect(fromAttributeMap(items[4].Put.Item).__edd_e__).toBe("match.command")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("AppendTooLarge counts the EXPANDED item total", () =>
      Effect.gen(function* () {
        // 34 registration ops expand to 102 items; unexpanded they would pass.
        const additionalItems = Array.from({ length: 34 }, (_, i) =>
          Registrations.put({ regId: `r-${i}`, code: `C${i}` }),
        )

        const error = yield* MatchEvents.append({ matchId: "m-1" }, [], 0, {
          additionalItems,
        }).pipe(Effect.flip)

        expect(error._tag).toBe("AppendTooLarge")
        expect((error as AppendTooLarge).count).toBe(102)
        expect(mockTransactWriteItems).not.toHaveBeenCalled()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("rejects a delete of a lifecycle entity as an additional item (EDD-9048)", () =>
      Effect.gen(function* () {
        const error = yield* MatchEvents.append({ matchId: "m-1" }, [startMatch()], 0, {
          additionalItems: [Registrations.delete({ regId: "r-1" })],
        }).pipe(Effect.flip)

        expect(error._tag).toBe("ValidationError")
        expect(String((error as ValidationError).cause)).toContain("EDD-9048")
        expect(mockTransactWriteItems).not.toHaveBeenCalled()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("rejects an upsert additional item instead of compiling it as a Put", () =>
      Effect.gen(function* () {
        const db = yield* DynamoClient.make({
          entities: { StatusProjection },
          tables: { EventsTable },
        })

        const error = yield* MatchEvents.append({ matchId: "m-1" }, [startMatch()], 0, {
          additionalItems: [
            db.entities.StatusProjection.upsert({ matchId: "m-1", state: "IN_PROGRESS" }),
          ],
        }).pipe(Effect.flip)

        expect(error._tag).toBe("ValidationError")
        expect(String((error as ValidationError).cause)).toContain("upsert")
        // Nothing may be written — the whole append is refused up front.
        expect(mockTransactWriteItems).not.toHaveBeenCalled()
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

    // Documented, not probed: the sentinel is consulted only by `append`, so a
    // redelivery whose `decide` returns no events against the loaded state
    // succeeds as a no-op — whether it must be told apart is the
    // application's call.
    it.effect("a no-op redelivery succeeds without consulting the sentinel", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValueOnce({
          Items: [
            makeEventItem("m-1", 1, "MatchStarted", {
              venue: "MCG",
              homeTeam: "AUS",
              awayTeam: "ENG",
            }),
          ],
        })
        // The redelivered command decides nothing against the loaded state, so
        // it never appends — and the sentinel is never consulted.
        const noopDecider: EventStore.Decider<MatchState, MatchCommand, MatchEvent> = {
          ...matchDecider,
          decide: () => Effect.succeed([]),
        }
        const redeliver = EventStore.commandHandler(noopDecider, MatchEvents, { idempotency: {} })
        const result = yield* redeliver(
          { matchId: "m-1" },
          { _tag: "StartMatch", venue: "MCG", homeTeam: "AUS", awayTeam: "ENG" },
          { commandId: "cmd-7f3a" },
        )
        expect(result.version).toBe(1)
        expect(result.events).toEqual([])
        expect(mockGetItem).not.toHaveBeenCalled()
        expect(mockTransactWriteItems).not.toHaveBeenCalled()
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
      expect(SnapshotMatchEvents.snapshotConfig).toEqual({ mode: "after-append", every: 3 })
      expect(ManualSnapshotMatchEvents.snapshotConfig).toEqual({
        mode: "after-append",
        every: undefined,
      })
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

    it.effect("cold start with no snapshot replays the stream through the same query", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue({ Items: [] })
        mockTransactWriteItems.mockResolvedValue({})

        const result = yield* handleSnap(
          { matchId: "m-1" },
          { _tag: "StartMatch", venue: "MCG", homeTeam: "AUS", awayTeam: "ENG" },
        )

        expect(result.version).toBe(1)
        // One readLatest query, no separate snapshot GetItem.
        expect(mockQuery).toHaveBeenCalledOnce()
        expect(mockGetItem).not.toHaveBeenCalled()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("folds from the snapshot and only the events after it", () =>
      Effect.gen(function* () {
        // The snapshot at v3 and the event after it — plus the event AT the
        // snapshot's version, which the reverse page reaches and must drop.
        mockQuery.mockResolvedValue(
          latestPage(
            makeSnapshotItem("snapmatch", "m-1", 3, {
              status: "i",
              innings: ["250/10"],
            }),
            [
              makeStreamEventItem("snapmatch", "m-1", 3, "InningsCompleted", {
                innings: 1,
                runs: 250,
                wickets: 10,
              }),
              makeStreamEventItem("snapmatch", "m-1", 4, "InningsCompleted", {
                innings: 2,
                runs: 180,
                wickets: 8,
              }),
            ],
          ),
        )
        mockTransactWriteItems.mockResolvedValue({})

        const result = yield* handleSnap(
          { matchId: "m-1" },
          { _tag: "EndMatch", result: "AUS won" },
        )

        // One reverse query over [first event SK, snapshot SK].
        expect(mockQuery).toHaveBeenCalledOnce()
        expect(mockGetItem).not.toHaveBeenCalled()
        const call = mockQuery.mock.calls[0]![0]
        expect(call.ScanIndexForward).toBe(false)
        expect(call.KeyConditionExpression).toBe("#pk = :pk AND #sk BETWEEN :first AND :snapshot")

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
        mockQuery.mockResolvedValue(
          latestPage(makeSnapshotItem("snapmatch", "m-1", 3, { status: "i", innings: [] })),
        )
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
        mockQuery.mockResolvedValue(
          latestPage(makeSnapshotItem("snapmatch", "m-1", 1, { status: "i", innings: [] }), [
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
          ]),
        )
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
        mockQuery.mockResolvedValue(
          latestPage(makeSnapshotItem("snapmatch", "m-1", 3, { status: "i", innings: [] })),
        )
        mockTransactWriteItems.mockResolvedValue({})

        yield* handleSnap({ matchId: "m-1" }, { _tag: "EndMatch", result: "AUS won" })

        expect(mockPutItem).not.toHaveBeenCalled()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("never auto-snapshots when `every` is not configured", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue({ Items: [] })
        mockTransactWriteItems.mockResolvedValue({})

        const handle = EventStore.commandHandler(matchDecider, ManualSnapshotMatchEvents)
        yield* handle(
          { matchId: "m-1" },
          { _tag: "StartMatch", venue: "MCG", homeTeam: "AUS", awayTeam: "ENG" },
        )

        expect(mockQuery).toHaveBeenCalledOnce()
        expect(mockPutItem).not.toHaveBeenCalled()
        // No inline snapshot either: the mode is "after-append".
        const call = mockTransactWriteItems.mock.calls[0]![0]
        expect(call.TransactItems).toHaveLength(1)
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
        mockQuery.mockResolvedValue(
          latestPage(makeSnapshotItem("snapmatch", "m-1", 9, { status: "i", innings: [] })),
        )

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
        mockQuery.mockResolvedValue(
          latestPage(makeSnapshotItem("snapmatch", "m-1", 1, { status: "i", innings: [] })),
        )
        mockTransactWriteItems.mockRejectedValueOnce(conflict).mockResolvedValue({})

        const handle = EventStore.commandHandler(matchDecider, SnapshotMatchEvents, { retry: 2 })
        const result = yield* handle({ matchId: "m-1" }, { _tag: "EndMatch", result: "AUS won" })

        // The snapshot is re-read on the retry — the whole cycle re-runs.
        expect(mockQuery).toHaveBeenCalledTimes(2)
        expect(result.version).toBe(2)
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  // -------------------------------------------------------------------------
  // Consistent reads (#139)
  // -------------------------------------------------------------------------

  describe("consistent reads (#139)", () => {
    const started = () =>
      makeEventItem("m-1", 1, "MatchStarted", { venue: "MCG", homeTeam: "AUS", awayTeam: "ENG" })

    it.effect("read / readFrom / currentVersion are eventually consistent by default", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue({ Items: [started()] })

        yield* MatchEvents.read({ matchId: "m-1" })
        yield* MatchEvents.readFrom({ matchId: "m-1" }, 0)
        yield* MatchEvents.currentVersion({ matchId: "m-1" })

        expect(mockQuery).toHaveBeenCalledTimes(3)
        for (const [input] of mockQuery.mock.calls) {
          expect(input.ConsistentRead).toBeUndefined()
        }
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("consistentRead: true sets ConsistentRead on every request", () =>
      Effect.gen(function* () {
        // Two pages, so `read` proves the flag rides on every page.
        mockQuery
          .mockResolvedValueOnce({ Items: [started()], LastEvaluatedKey: { pk: { S: "x" } } })
          .mockResolvedValue({ Items: [] })

        yield* MatchEvents.read({ matchId: "m-1" }, { consistentRead: true })
        yield* MatchEvents.readFrom({ matchId: "m-1" }, 0, { consistentRead: true })
        yield* MatchEvents.currentVersion({ matchId: "m-1" }, { consistentRead: true })

        expect(mockQuery).toHaveBeenCalledTimes(4)
        for (const [input] of mockQuery.mock.calls) {
          expect(input.ConsistentRead).toBe(true)
        }
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("consistentRead keeps the event SK bounds of each read", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue({ Items: [] })

        yield* MatchEvents.readFrom({ matchId: "m-1" }, 4, { consistentRead: true })
        yield* MatchEvents.currentVersion({ matchId: "m-1" }, { consistentRead: true })

        const [rangeCall] = mockQuery.mock.calls[0]!
        expect(rangeCall.KeyConditionExpression).toContain("#sk BETWEEN :sk1 AND :sk2")
        const [headCall] = mockQuery.mock.calls[1]!
        expect(headCall.ScanIndexForward).toBe(false)
        expect(headCall.Limit).toBe(1)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("BoundEventStream forwards ReadOptions", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue({ Items: [] })

        const bound = yield* EventStore.bind(MatchEvents)
        yield* bound.read({ matchId: "m-1" }, { consistentRead: true })
        yield* bound.readFrom({ matchId: "m-1" }, 0, { consistentRead: true })
        yield* bound.currentVersion({ matchId: "m-1" }, { consistentRead: true })
        yield* bound.read({ matchId: "m-1" })

        const flags = mockQuery.mock.calls.map(([input]) => input.ConsistentRead)
        expect(flags).toEqual([true, true, true, undefined])
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("commandHandler loads state consistently by default", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue({ Items: [] })
        mockTransactWriteItems.mockResolvedValue({})

        yield* EventStore.commandHandler(matchDecider, MatchEvents)(
          { matchId: "m-1" },
          { _tag: "StartMatch", venue: "MCG", homeTeam: "AUS", awayTeam: "ENG" },
        )

        expect(mockQuery.mock.calls[0]![0].ConsistentRead).toBe(true)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("the snapshot and its delta are read consistently too", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue(
          latestPage(makeSnapshotItem("snapmatch", "m-1", 3, { status: "i", innings: [] })),
        )
        mockTransactWriteItems.mockResolvedValue({})

        yield* EventStore.commandHandler(matchDecider, SnapshotMatchEvents)(
          { matchId: "m-1" },
          { _tag: "EndMatch", result: "AUS won" },
        )

        expect(mockGetItem).not.toHaveBeenCalled()
        expect(mockQuery.mock.calls[0]![0].ConsistentRead).toBe(true)

        // ...and the opt-out covers both, being one query.
        yield* SnapshotMatchEvents.pipe(
          EventStore.commandHandler(matchDecider, { consistentRead: false }),
        )({ matchId: "m-1" }, { _tag: "EndMatch", result: "AUS won" })
        expect(mockQuery.mock.calls[1]![0].ConsistentRead).toBeUndefined()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("CommandHandlerOptions.consistentRead: false opts out", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue({ Items: [] })
        mockTransactWriteItems.mockResolvedValue({})

        const handle = MatchEvents.pipe(
          EventStore.commandHandler(matchDecider, { consistentRead: false }),
        )
        yield* handle(
          { matchId: "m-1" },
          { _tag: "StartMatch", venue: "MCG", homeTeam: "AUS", awayTeam: "ENG" },
        )

        expect(mockQuery.mock.calls[0]![0].ConsistentRead).toBeUndefined()
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  // -------------------------------------------------------------------------
  // Caller-supplied expectedVersion — If-Match (#136)
  // -------------------------------------------------------------------------

  describe("commandHandler expectedVersion (#136)", () => {
    const conflict = {
      name: "TransactionCanceledException",
      CancellationReasons: [{ Code: "ConditionalCheckFailed" }],
    }
    const atV2 = () => ({
      Items: [
        makeEventItem("m-1", 1, "MatchStarted", { venue: "MCG", homeTeam: "AUS", awayTeam: "ENG" }),
        makeEventItem("m-1", 2, "InningsCompleted", { innings: 1, runs: 250, wickets: 10 }),
      ],
    })
    const completeInnings: MatchCommand = {
      _tag: "CompleteInnings",
      innings: 2,
      runs: 180,
      wickets: 8,
    }

    /** `matchDecider` with a spy on `decide`. */
    const spied = () => {
      const decide = vi.fn(matchDecider.decide)
      const decider: EventStore.Decider<
        MatchState,
        MatchCommand,
        MatchEvent,
        AlreadyStarted | NotStarted
      > = { ...matchDecider, decide }
      return { decide, decider }
    }

    it.effect("a stale expectedVersion fails before decide with actualVersion", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue(atV2())
        const { decide, decider } = spied()

        const error = yield* EventStore.commandHandler(decider, MatchEvents)(
          { matchId: "m-1" },
          completeInnings,
          { expectedVersion: 1 },
        ).pipe(Effect.flip)

        expect(error).toBeInstanceOf(VersionConflict)
        const vc = error as VersionConflict
        expect(vc.streamName).toBe("Match")
        expect(vc.streamId).toBe("m-1")
        expect(vc.expectedVersion).toBe(1)
        expect(vc.actualVersion).toBe(2)
        expect(decide).not.toHaveBeenCalled()
        expect(mockTransactWriteItems).not.toHaveBeenCalled()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("an expectedVersion ahead of the stream fails the same way", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue({ Items: [] })
        const { decide, decider } = spied()

        const error = yield* EventStore.commandHandler(decider, MatchEvents)(
          { matchId: "m-1" },
          { _tag: "StartMatch", venue: "MCG", homeTeam: "AUS", awayTeam: "ENG" },
          { expectedVersion: 5 },
        ).pipe(Effect.flip)

        expect((error as VersionConflict).actualVersion).toBe(0)
        expect(decide).not.toHaveBeenCalled()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("a pre-decide conflict is never retried, whatever the retry policy", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue(atV2())
        const { decide, decider } = spied()

        const error = yield* EventStore.commandHandler(decider, MatchEvents, { retry: 5 })(
          { matchId: "m-1" },
          completeInnings,
          { expectedVersion: 1 },
        ).pipe(Effect.flip)

        expect(error._tag).toBe("VersionConflict")
        expect(mockQuery).toHaveBeenCalledOnce()
        expect(decide).not.toHaveBeenCalled()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("a matching expectedVersion conditions the append on that version", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue(atV2())
        mockTransactWriteItems.mockResolvedValue({})

        const result = yield* EventStore.commandHandler(matchDecider, MatchEvents)(
          { matchId: "m-1" },
          completeInnings,
          { expectedVersion: 2 },
        )

        expect(result.version).toBe(3)
        const items = mockTransactWriteItems.mock.calls[0]![0].TransactItems
        // Contiguity check on v2, then the event put at v3.
        expect(fromAttributeMap(items[0].ConditionCheck.Key).sk).toBe(
          DynamoSchema.composeEventVersionKey(AppSchema, "match.event", 2),
        )
        expect(fromAttributeMap(items[1].Put.Item).version).toBe(3)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("an append-time conflict is not retried and carries no actualVersion", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue(atV2())
        mockTransactWriteItems.mockRejectedValue(conflict)
        const { decide, decider } = spied()

        const error = yield* EventStore.commandHandler(decider, MatchEvents, { retry: 5 })(
          { matchId: "m-1" },
          completeInnings,
          { expectedVersion: 2 },
        ).pipe(Effect.flip)

        expect(error._tag).toBe("VersionConflict")
        expect((error as VersionConflict).expectedVersion).toBe(2)
        expect((error as VersionConflict).actualVersion).toBeUndefined()
        expect(mockTransactWriteItems).toHaveBeenCalledOnce()
        expect(decide).toHaveBeenCalledOnce()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("without expectedVersion the retry policy still applies", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue(atV2())
        mockTransactWriteItems.mockRejectedValueOnce(conflict).mockResolvedValue({})

        const result = yield* EventStore.commandHandler(matchDecider, MatchEvents, { retry: 5 })(
          { matchId: "m-1" },
          completeInnings,
        )

        expect(result.version).toBe(3)
        expect(mockTransactWriteItems).toHaveBeenCalledTimes(2)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("a no-op decision at the matching version succeeds", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue(atV2())
        const noop: EventStore.Decider<MatchState, MatchCommand, MatchEvent> = {
          ...matchDecider,
          decide: () => Effect.succeed([]),
        }

        const result = yield* EventStore.commandHandler(noop, MatchEvents)(
          { matchId: "m-1" },
          completeInnings,
          { expectedVersion: 2 },
        )

        expect(result.version).toBe(2)
        expect(result.events).toEqual([])
        expect(result.state.innings).toHaveLength(1)
        expect(mockTransactWriteItems).not.toHaveBeenCalled()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("checks against the snapshot-aware load", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue(
          latestPage(makeSnapshotItem("snapmatch", "m-1", 3, { status: "i", innings: [] }), [
            makeStreamEventItem("snapmatch", "m-1", 4, "InningsCompleted", {
              innings: 1,
              runs: 1,
              wickets: 1,
            }),
          ]),
        )

        const error = yield* EventStore.commandHandler(matchDecider, SnapshotMatchEvents)(
          { matchId: "m-1" },
          { _tag: "EndMatch", result: "AUS won" },
          { expectedVersion: 3 },
        ).pipe(Effect.flip)

        expect((error as VersionConflict).actualVersion).toBe(4)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("reports a composite stream id joined as append does", () =>
      Effect.gen(function* () {
        const TeamStream = EventStore.makeStream({
          table: EventsTable,
          streamName: "Team",
          events: [MatchStarted, InningsCompleted, MatchEnded],
          streamId: { composite: ["leagueId", "teamId"] },
        })
        mockQuery.mockResolvedValue({ Items: [] })

        const bound = yield* EventStore.bind(TeamStream)
        // Keys deliberately out of composite order.
        const error = yield* EventStore.commandHandler(matchDecider, bound)(
          { teamId: "T-5", leagueId: "L-1" },
          { _tag: "StartMatch", venue: "MCG", homeTeam: "AUS", awayTeam: "ENG" },
          { expectedVersion: 1 },
        ).pipe(Effect.flip)

        expect((error as VersionConflict).streamId).toBe("L-1#T-5")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("refuses a malformed expectedVersion before reading", () =>
      Effect.gen(function* () {
        const handle = EventStore.commandHandler(matchDecider, MatchEvents)
        for (const expectedVersion of [-1, 1.5, Number.NaN]) {
          const error = yield* handle(
            { matchId: "m-1" },
            { _tag: "StartMatch", venue: "MCG", homeTeam: "AUS", awayTeam: "ENG" },
            { expectedVersion },
          ).pipe(Effect.flip)
          expect(error._tag).toBe("ValidationError")
          expect(String((error as ValidationError).cause)).toContain("expectedVersion")
        }
        expect(mockQuery).not.toHaveBeenCalled()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect(
      "a redelivered idempotent command with its original expectedVersion is a DuplicateCommand",
      () =>
        Effect.gen(function* () {
          // The first delivery committed v2 (its response was lost); the
          // redelivery carries the same commandId and the same If-Match.
          mockQuery.mockResolvedValue(atV2())
          mockGetItem.mockResolvedValue({ Item: toAttributeMap({ pk: "x" }) })
          const { decide, decider } = spied()

          const error = yield* EventStore.commandHandler(decider, MatchEvents, {
            idempotency: {},
            retry: 5,
          })({ matchId: "m-1" }, completeInnings, {
            commandId: "cmd-1",
            expectedVersion: 1,
          }).pipe(Effect.flip)

          expect(error._tag).toBe("DuplicateCommand")
          const duplicate = error as DuplicateCommand
          expect(duplicate.streamName).toBe("Match")
          expect(duplicate.streamId).toBe("m-1")
          expect(duplicate.commandId).toBe("cmd-1")
          // One strongly consistent read of the sentinel key, no decide, no write.
          expect(mockGetItem).toHaveBeenCalledOnce()
          const probe = mockGetItem.mock.calls[0]![0]
          expect(probe.ConsistentRead).toBe(true)
          expect(fromAttributeMap(probe.Key)).toEqual({
            pk: "$cricket#v1#match#m-1",
            sk: "$cricket#v1#match.command#cmd-1",
          })
          expect(decide).not.toHaveBeenCalled()
          expect(mockTransactWriteItems).not.toHaveBeenCalled()
          expect(mockQuery).toHaveBeenCalledOnce()
        }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("an idempotent command whose sentinel is absent still reports VersionConflict", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue(atV2())
        const { decide, decider } = spied()

        const error = yield* EventStore.commandHandler(decider, MatchEvents, {
          idempotency: {},
        })({ matchId: "m-1" }, completeInnings, {
          commandId: "cmd-2",
          expectedVersion: 1,
        }).pipe(Effect.flip)

        expect(error._tag).toBe("VersionConflict")
        expect((error as VersionConflict).actualVersion).toBe(2)
        expect(mockGetItem).toHaveBeenCalledOnce()
        expect(decide).not.toHaveBeenCalled()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("a bound stream probes the sentinel with its own services", () =>
      Effect.gen(function* () {
        const bound = yield* EventStore.bind(MatchEvents)
        mockQuery.mockResolvedValue(atV2())
        mockGetItem.mockResolvedValue({ Item: toAttributeMap({ pk: "x" }) })

        const error = yield* EventStore.commandHandler(matchDecider, bound, {
          idempotency: {},
        })({ matchId: "m-1" }, completeInnings, {
          commandId: "cmd-3",
          expectedVersion: 0,
        }).pipe(Effect.flip)

        expect(error._tag).toBe("DuplicateCommand")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("a handler without idempotency never probes on a conflict", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue(atV2())

        const error = yield* EventStore.commandHandler(matchDecider, MatchEvents)(
          { matchId: "m-1" },
          completeInnings,
          { commandId: "cmd-4", expectedVersion: 1 },
        ).pipe(Effect.flip)

        expect(error._tag).toBe("VersionConflict")
        expect(mockGetItem).not.toHaveBeenCalled()
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  // -------------------------------------------------------------------------
  // Decision-derived additionalItems, fold before append (#137)
  // -------------------------------------------------------------------------

  describe("commandHandler decision-derived additionalItems (#137)", () => {
    const started = () =>
      makeEventItem("m-1", 1, "MatchStarted", { venue: "MCG", homeTeam: "AUS", awayTeam: "ENG" })
    const completeInnings: MatchCommand = {
      _tag: "CompleteInnings",
      innings: 1,
      runs: 250,
      wickets: 10,
    }

    class Projector extends Context.Service<
      Projector,
      { readonly writerId: Effect.Effect<string> }
    >()("test/Projector") {}
    class ProjectionFailed extends Data.TaggedError("ProjectionFailed") {}

    it.effect("passes the decision — events, folded state, previous state and version", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue({ Items: [started()] })
        mockTransactWriteItems.mockResolvedValue({})
        const seen: Array<EventStore.Decision<MatchState, MatchEvent>> = []

        const result = yield* EventStore.commandHandler(matchDecider, MatchEvents)(
          { matchId: "m-1" },
          completeInnings,
          {
            additionalItems: (decision) => {
              seen.push(decision)
              // Fold BEFORE append: nothing has been written yet.
              expect(mockTransactWriteItems).not.toHaveBeenCalled()
              return [Watermarks.put({ writerId: "proj", lastSeq: decision.state.innings.length })]
            },
          },
        )

        expect(seen).toHaveLength(1)
        const decision = seen[0]!
        expect(decision.version).toBe(1)
        expect(decision.events).toHaveLength(1)
        expect(decision.events[0]).toBeInstanceOf(InningsCompleted)
        expect(decision.previous).toEqual({ status: "in-progress", innings: [] })
        expect(decision.state).toEqual({
          status: "in-progress",
          innings: [{ runs: 250, wickets: 10 }],
        })
        // The handler returns exactly the state the projection saw.
        expect(result.state).toBe(decision.state)

        const items = mockTransactWriteItems.mock.calls[0]![0].TransactItems
        expect(items).toHaveLength(3) // contiguity check, event, projection
        const projected = fromAttributeMap(items[2].Put.Item)
        expect(projected.__edd_e__).toBe("Watermark")
        expect(projected.lastSeq).toBe(1)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("an Effect-returning function may read services and fail", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue({ Items: [] })
        mockTransactWriteItems.mockResolvedValue({})

        const handle = EventStore.commandHandler(matchDecider, MatchEvents)
        const project = (decision: EventStore.Decision<MatchState, MatchEvent>) =>
          Effect.gen(function* () {
            const writerId = yield* (yield* Projector).writerId
            if (writerId === "") return yield* new ProjectionFailed()
            return [Watermarks.put({ writerId, lastSeq: decision.version + 1 })]
          })
        const start: MatchCommand = {
          _tag: "StartMatch",
          venue: "MCG",
          homeTeam: "AUS",
          awayTeam: "ENG",
        }

        yield* handle({ matchId: "m-1" }, start, { additionalItems: project }).pipe(
          Effect.provideService(Projector, { writerId: Effect.succeed("proj-1") }),
        )
        const items = mockTransactWriteItems.mock.calls[0]![0].TransactItems
        expect(fromAttributeMap(items[1].Put.Item)).toMatchObject({
          writerId: "proj-1",
          lastSeq: 1,
        })

        const error = yield* handle({ matchId: "m-1" }, start, { additionalItems: project }).pipe(
          Effect.provideService(Projector, { writerId: Effect.succeed("") }),
          Effect.flip,
        )
        expect(error._tag).toBe("ProjectionFailed")
        // The projection failed before the append was attempted.
        expect(mockTransactWriteItems).toHaveBeenCalledOnce()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("a BoundEventStream handler needs only the projection's services", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue({ Items: [] })
        mockTransactWriteItems.mockResolvedValue({})

        const bound = yield* EventStore.bind(MatchEvents)
        const handle = bound.pipe(EventStore.commandHandler(matchDecider))
        const program = handle(
          { matchId: "m-1" },
          { _tag: "StartMatch", venue: "MCG", homeTeam: "AUS", awayTeam: "ENG" },
          {
            additionalItems: () =>
              Effect.gen(function* () {
                yield* Projector
                return [Watermarks.put({ writerId: "bound", lastSeq: 1 })]
              }),
          },
        )
        // Only `Projector` is provided here — the stream's services are bound.
        const result = yield* Effect.provideService(program, Projector, {
          writerId: Effect.succeed("unused"),
        })

        expect(result.version).toBe(1)
        expect(mockTransactWriteItems.mock.calls[0]![0].TransactItems).toHaveLength(2)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("is not called when decide returns no events", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue({ Items: [] })
        const derive = vi.fn(() => [Watermarks.put({ writerId: "never", lastSeq: 0 })])
        const noop: EventStore.Decider<MatchState, MatchCommand, MatchEvent> = {
          ...matchDecider,
          decide: () => Effect.succeed([]),
        }

        const result = yield* EventStore.commandHandler(noop, MatchEvents)(
          { matchId: "m-1" },
          completeInnings,
          { additionalItems: derive },
        )

        expect(result.events).toEqual([])
        expect(derive).not.toHaveBeenCalled()
        expect(mockTransactWriteItems).not.toHaveBeenCalled()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("is re-evaluated against the fresh decision on every retry attempt", () =>
      Effect.gen(function* () {
        const firstInnings = makeEventItem("m-1", 2, "InningsCompleted", {
          innings: 1,
          runs: 250,
          wickets: 10,
        })
        mockQuery
          .mockResolvedValueOnce({ Items: [started()] })
          .mockResolvedValue({ Items: [started(), firstInnings] })
        mockTransactWriteItems
          .mockRejectedValueOnce({
            name: "TransactionCanceledException",
            CancellationReasons: [{ Code: "ConditionalCheckFailed" }],
          })
          .mockResolvedValue({})
        const versions: Array<number> = []

        yield* EventStore.commandHandler(matchDecider, MatchEvents, { retry: 2 })(
          { matchId: "m-1" },
          { _tag: "CompleteInnings", innings: 2, runs: 180, wickets: 8 },
          {
            additionalItems: ({ version, state }) => {
              versions.push(version)
              return [Watermarks.put({ writerId: "proj", lastSeq: state.innings.length })]
            },
          },
        )

        expect(versions).toEqual([1, 2])
        const retried = mockTransactWriteItems.mock.calls[1]![0].TransactItems
        expect(fromAttributeMap(retried[2].Put.Item).lastSeq).toBe(2)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("AdditionalItemConditionFailed indices refer to the returned array", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue({ Items: [] })
        mockTransactWriteItems.mockRejectedValue({
          name: "TransactionCanceledException",
          CancellationReasons: [
            { Code: "None" },
            { Code: "None" },
            { Code: "ConditionalCheckFailed" },
          ],
        })

        const error = yield* EventStore.commandHandler(matchDecider, MatchEvents)(
          { matchId: "m-1" },
          { _tag: "StartMatch", venue: "MCG", homeTeam: "AUS", awayTeam: "ENG" },
          {
            additionalItems: () => [
              Watermarks.put({ writerId: "ok", lastSeq: 1 }),
              Transaction.check(
                Watermarks.get({ writerId: "guard" }),
                Expression.condition({ lt: { lastSeq: 1 } }),
              ),
            ],
          },
        ).pipe(Effect.flip)

        expect(error._tag).toBe("AdditionalItemConditionFailed")
        expect((error as AdditionalItemConditionFailed).indices).toEqual([1])
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect(
      "an evolve that mutates in place is supported — previous is then the same object",
      () =>
        Effect.gen(function* () {
          mockQuery.mockResolvedValue({ Items: [started()] })
          mockTransactWriteItems.mockResolvedValue({})

          interface Mutable {
            status: string
            innings: number
          }
          const mutating: EventStore.Decider<Mutable, MatchCommand, MatchEvent> = {
            // A factory per call: in-place mutation must never touch a shared seed.
            get initialState() {
              return { status: "pending", innings: 0 }
            },
            decide: () =>
              Effect.succeed([new InningsCompleted({ innings: 1, runs: 1, wickets: 1 })]),
            evolve: (state, event) => {
              if (event instanceof MatchStarted) state.status = "in-progress"
              if (event instanceof InningsCompleted) state.innings += 1
              return state
            },
          }
          let decision: EventStore.Decision<Mutable, MatchEvent> | undefined

          const result = yield* EventStore.commandHandler(mutating, MatchEvents)(
            { matchId: "m-1" },
            completeInnings,
            {
              additionalItems: (d) => {
                decision = d
                return []
              },
            },
          )

          expect(decision!.previous).toBe(decision!.state)
          expect(result.state).toEqual({ status: "in-progress", innings: 1 })
        }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("the snapshot written after the append is the folded state", () =>
      Effect.gen(function* () {
        const stream = EventStore.makeStream({
          table: EventsTable,
          streamName: "EagerFold",
          events: [MatchStarted, InningsCompleted, MatchEnded],
          streamId: { composite: ["matchId"] },
          snapshot: { schema: MatchStateSchema, every: 1 },
        })
        mockGetItem.mockResolvedValue({})
        mockQuery.mockResolvedValue({ Items: [] })
        mockTransactWriteItems.mockResolvedValue({})
        mockPutItem.mockResolvedValue({})
        let projected: MatchState | undefined

        const result = yield* EventStore.commandHandler(matchDecider, stream)(
          { matchId: "m-1" },
          { _tag: "StartMatch", venue: "MCG", homeTeam: "AUS", awayTeam: "ENG" },
          {
            additionalItems: ({ state }) => {
              projected = state
              return []
            },
          },
        )

        expect(projected).toBe(result.state)
        const snapshot = fromAttributeMap(mockPutItem.mock.calls[0]![0].Item)
        expect(snapshot.state).toEqual({ status: "i", innings: [] })
        expect(snapshot.asOfVersion).toBe(1)
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
        expect(bound.snapshotConfig).toEqual({ mode: "after-append", every: 3 })

        const snapshot = yield* bound.readSnapshot({ matchId: "m-1" })
        expect(Option.getOrThrow(snapshot).asOfVersion).toBe(2)

        yield* bound.writeSnapshot({ matchId: "m-1" }, { status: "completed", innings: [] }, 5)
        expect(fromAttributeMap(mockPutItem.mock.calls[0]![0].Item).asOfVersion).toBe(5)
      }).pipe(Effect.provide(TestLayer)),
    )
  })
})

// ---------------------------------------------------------------------------
// Stream key casing — `casing` overrides the casing of the stream's keys, as an
// index's `casing` does. Omitted, the stream keeps the layout it has always
// been written with: name lower-cased, the rest following the schema.
// ---------------------------------------------------------------------------

describe("EventStore stream casing", () => {
  const streamFor = (
    schemaCasing: DynamoSchema.Casing,
    casing: DynamoSchema.Casing | undefined,
  ) => {
    const table = Table.make({
      schema: DynamoSchema.make({ name: "App", version: 1, casing: schemaCasing }),
      entities: {},
    })
    const stream = EventStore.makeStream({
      table,
      streamName: "OrderBook",
      events: [MatchStarted],
      streamId: { composite: ["orderId"] },
      snapshot: { schema: MatchStateSchema },
      ...(casing !== undefined ? { casing } : {}),
    })
    return {
      stream,
      layer: Layer.merge(TestDynamoClient, table.layer({ name: "events-table" })),
    }
  }

  // Every key the stream writes or reads, captured from the mock client.
  const captureKeys = (
    schemaCasing: DynamoSchema.Casing,
    casing: DynamoSchema.Casing | undefined,
  ) => {
    const { stream, layer } = streamFor(schemaCasing, casing)
    return Effect.gen(function* () {
      vi.resetAllMocks()
      mockTransactWriteItems.mockResolvedValue({})
      mockPutItem.mockResolvedValue({})
      mockQuery.mockResolvedValue({ Items: [] })

      yield* stream.append(
        { orderId: "Ord-1" },
        [new MatchStarted({ venue: "MCG", homeTeam: "AUS", awayTeam: "ENG" })],
        0,
        { idempotency: { commandId: "Cmd-1" } },
      )
      yield* stream.writeSnapshot({ orderId: "Ord-1" }, { status: "in-progress", innings: [] }, 1)
      yield* stream.read({ orderId: "Ord-1" })

      const transact = mockTransactWriteItems.mock.calls[0]![0].TransactItems
      const event = fromAttributeMap(transact[0].Put.Item)
      const sentinel = fromAttributeMap(transact[transact.length - 1].Put.Item)
      const snapshot = fromAttributeMap(mockPutItem.mock.calls[0]![0].Item)
      const read = mockQuery.mock.calls[0]![0]
      expect(read.ExpressionAttributeValues[":pk"].S).toBe(event.pk)
      // The discriminators never vary — reads match them exactly.
      expect([event.__edd_e__, sentinel.__edd_e__, snapshot.__edd_e__]).toEqual([
        "orderbook.event",
        "orderbook.command",
        "orderbook.snapshot",
      ])
      return {
        pk: event.pk,
        eventSk: event.sk,
        sentinelSk: sentinel.sk,
        snapshotSk: snapshot.sk,
        readSkPrefix: read.ExpressionAttributeValues[":sk"].S,
      }
    }).pipe(Effect.provide(layer))
  }

  // The layout streams were written with before `casing` existed.
  const legacyKeys = {
    lowercase: {
      pk: "$app#v1#orderbook#ord-1",
      eventSk: "$app#v1#orderbook.event_1#0000000001",
      sentinelSk: "$app#v1#orderbook.command#cmd-1",
      snapshotSk: "$app#v1#orderbook.snapshot",
      readSkPrefix: "$app#v1#orderbook.event_1#",
    },
    uppercase: {
      pk: "$APP#v1#ORDERBOOK#ORD-1",
      eventSk: "$APP#v1#ORDERBOOK.EVENT_1#0000000001",
      sentinelSk: "$APP#v1#ORDERBOOK.COMMAND#CMD-1",
      snapshotSk: "$APP#v1#ORDERBOOK.SNAPSHOT",
      readSkPrefix: "$APP#v1#ORDERBOOK.EVENT_1#",
    },
    preserve: {
      pk: "$App#v1#orderbook#Ord-1",
      eventSk: "$App#v1#orderbook.event_1#0000000001",
      sentinelSk: "$App#v1#orderbook.command#Cmd-1",
      snapshotSk: "$App#v1#orderbook.snapshot",
      readSkPrefix: "$App#v1#orderbook.event_1#",
    },
  } as const

  for (const schemaCasing of ["lowercase", "uppercase", "preserve"] as const) {
    it.effect(`omitted keeps the existing layout (schema casing: "${schemaCasing}")`, () =>
      Effect.gen(function* () {
        expect(yield* captureKeys(schemaCasing, undefined)).toEqual(legacyKeys[schemaCasing])
      }),
    )
  }

  for (const schemaCasing of ["lowercase", "uppercase"] as const) {
    it.effect(`set to the schema's casing matches the existing layout ("${schemaCasing}")`, () =>
      Effect.gen(function* () {
        expect(yield* captureKeys(schemaCasing, schemaCasing)).toEqual(legacyKeys[schemaCasing])
      }),
    )
  }

  it.effect(`"preserve" on a "preserve" schema keeps the stream name as written`, () =>
    Effect.gen(function* () {
      expect(yield* captureKeys("preserve", "preserve")).toEqual({
        pk: "$App#v1#OrderBook#Ord-1",
        eventSk: "$App#v1#OrderBook.event_1#0000000001",
        sentinelSk: "$App#v1#OrderBook.command#Cmd-1",
        snapshotSk: "$App#v1#OrderBook.snapshot",
        readSkPrefix: "$App#v1#OrderBook.event_1#",
      })
    }),
  )

  it.effect("overrides the schema's casing for the whole key except the schema prefix", () =>
    Effect.gen(function* () {
      // Stream ids and command ids stay distinct by case on a lower-casing schema.
      expect(yield* captureKeys("lowercase", "preserve")).toEqual({
        pk: "$app#v1#OrderBook#Ord-1",
        eventSk: "$app#v1#OrderBook.event_1#0000000001",
        sentinelSk: "$app#v1#OrderBook.command#Cmd-1",
        snapshotSk: "$app#v1#OrderBook.snapshot",
        readSkPrefix: "$app#v1#OrderBook.event_1#",
      })
      expect(yield* captureKeys("uppercase", "lowercase")).toEqual({
        pk: "$APP#v1#orderbook#ord-1",
        eventSk: "$APP#v1#orderbook.event_1#0000000001",
        sentinelSk: "$APP#v1#orderbook.command#cmd-1",
        snapshotSk: "$APP#v1#orderbook.snapshot",
        readSkPrefix: "$APP#v1#orderbook.event_1#",
      })
    }),
  )

  it.effect(
    "readLatest's range holds the events and the snapshot, not the sentinels, under every casing (#138)",
    () =>
      Effect.gen(function* () {
        const casings: ReadonlyArray<DynamoSchema.Casing> = ["lowercase", "uppercase", "preserve"]
        for (const schemaCasing of casings) {
          for (const casing of [undefined, ...casings]) {
            const captured = yield* captureKeys(schemaCasing, casing)
            const keys = {
              pk: String(captured.pk),
              eventSk: String(captured.eventSk),
              sentinelSk: String(captured.sentinelSk),
              snapshotSk: String(captured.snapshotSk),
            }
            const { stream, layer } = streamFor(schemaCasing, casing)
            vi.resetAllMocks()
            mockQuery.mockResolvedValue({ Items: [] })
            yield* stream.readLatest({ orderId: "Ord-1" }).pipe(Effect.provide(layer))
            const query = mockQuery.mock.calls[0]![0]
            const first = query.ExpressionAttributeValues[":first"].S as string
            const last = query.ExpressionAttributeValues[":snapshot"].S as string
            const lastEvent = keys.eventSk.replace(/\d{10}$/, "9999999999")
            const label = `${schemaCasing}/${String(casing)}`
            expect(query.ExpressionAttributeValues[":pk"].S, label).toBe(keys.pk)
            expect(last, label).toBe(keys.snapshotSk)
            // command < first ≤ event … newest event < snapshot
            expect(keys.sentinelSk < first, label).toBe(true)
            expect(first <= keys.eventSk, label).toBe(true)
            expect(lastEvent < keys.snapshotSk, label).toBe(true)
            // Under every casing, a sentinel whose id sorts last still sorts first.
            expect(`${keys.sentinelSk}~~~~` < first, label).toBe(true)
          }
        }
      }),
  )

  it(`a preserved stream name still sorts the snapshot after every event`, () => {
    const schema = DynamoSchema.make({ name: "app", version: 1, casing: "preserve" })
    const snapshotSk = DynamoSchema.composeKey(schema, "OrderBook.snapshot", [])
    const lastEvent = DynamoSchema.composeEventVersionKey(
      schema,
      "OrderBook.event",
      DynamoSchema.MAX_EVENT_VERSION,
    )
    const sentinel = DynamoSchema.composeKey(schema, "OrderBook.command", ["zzz"])
    const firstEvent = DynamoSchema.composeEventVersionKey(schema, "OrderBook.event", 1)
    expect(snapshotSk > lastEvent).toBe(true)
    expect(sentinel < firstEvent).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Inline snapshots and single-request state load (#138)
// ---------------------------------------------------------------------------

describe("EventStore inline snapshots and readLatest (#138)", () => {
  const InlineMatchEvents = EventStore.makeStream({
    table: EventsTable,
    streamName: "InlineMatch",
    events: [MatchStarted, InningsCompleted, MatchEnded],
    streamId: { composite: ["matchId"] },
    snapshot: { schema: MatchStateSchema, mode: "inline" },
  })

  const InlineEvery3 = EventStore.makeStream({
    table: EventsTable,
    streamName: "InlineEvery",
    events: [MatchStarted, InningsCompleted, MatchEnded],
    streamId: { composite: ["matchId"] },
    snapshot: { schema: MatchStateSchema, mode: "inline", every: 3 },
  })

  const started = () => new MatchStarted({ venue: "MCG", homeTeam: "AUS", awayTeam: "ENG" })
  const innings = (n: number) => new InningsCompleted({ innings: n, runs: 100 + n, wickets: n })
  const inningsItem = (label: string, version: number) =>
    makeStreamEventItem(label, "m-1", version, "InningsCompleted", {
      innings: version,
      runs: 100 + version,
      wickets: version,
    })

  describe("configuration", () => {
    it("exposes the mode, defaulting to after-append", () => {
      expect(InlineMatchEvents.snapshotConfig).toEqual({ mode: "inline", every: undefined })
      expect(InlineEvery3.snapshotConfig).toEqual({ mode: "inline", every: 3 })
    })

    it("throws EDD-9062 for an unknown mode", () => {
      expect(() =>
        EventStore.makeStream({
          table: EventsTable,
          streamName: "BadMode",
          events: [MatchStarted],
          streamId: { composite: ["matchId"] },
          snapshot: { schema: MatchStateSchema, mode: "eager" as "inline" },
        }),
      ).toThrow(/EDD-9062/)
    })
  })

  describe("readLatest", () => {
    it.effect("issues one reverse query over [first event SK, snapshot SK]", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue(
          latestPage(makeSnapshotItem("snapmatch", "m-1", 3, { status: "i", innings: ["1/1"] }), [
            inningsItem("snapmatch", 3),
            inningsItem("snapmatch", 4),
          ]),
        )

        const latest = yield* SnapshotMatchEvents.readLatest(
          { matchId: "m-1" },
          { consistentRead: true },
        )

        expect(mockQuery).toHaveBeenCalledOnce()
        expect(mockGetItem).not.toHaveBeenCalled()
        const call = mockQuery.mock.calls[0]![0]
        expect(call.TableName).toBe("events-table")
        expect(call.ScanIndexForward).toBe(false)
        expect(call.ConsistentRead).toBe(true)
        // every: 3 → the snapshot plus up to three events in the first page.
        expect(call.Limit).toBe(4)
        expect(call.KeyConditionExpression).toBe("#pk = :pk AND #sk BETWEEN :first AND :snapshot")
        expect(call.FilterExpression).toBe("#e IN (:eventType, :snapshotType)")
        const values = fromAttributeMap(call.ExpressionAttributeValues)
        expect(values).toEqual({
          ":pk": "$cricket#v1#snapmatch#m-1",
          ":first": DynamoSchema.composeEventVersionKeyPrefix(AppSchema, "snapmatch.event"),
          ":snapshot": DynamoSchema.composeKey(AppSchema, "snapmatch.snapshot", []),
          ":eventType": "snapmatch.event",
          ":snapshotType": "snapmatch.snapshot",
        })

        // The snapshot decoded through the state schema; only the events after it.
        const snapshot = Option.getOrThrow(latest.snapshot)
        expect(snapshot.asOfVersion).toBe(3)
        expect(snapshot.state).toEqual({
          status: "in-progress",
          innings: [{ runs: 1, wickets: 1 }],
        })
        expect(latest.events.map((e) => e.version)).toEqual([4])
        expect(latest.version).toBe(4)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("sizes the first page for a current snapshot when `every` is unset", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue({ Items: [] })
        yield* InlineMatchEvents.readLatest({ matchId: "m-1" })
        const call = mockQuery.mock.calls[0]![0]
        expect(call.Limit).toBe(2)
        // Eventually consistent unless asked.
        expect(call.ConsistentRead).toBeUndefined()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect(
      "pages on, sized to the missing events, until it reaches the snapshot's version",
      () =>
        Effect.gen(function* () {
          const cursor = toAttributeMap({ pk: "p", sk: "s" })
          mockQuery
            .mockResolvedValueOnce({
              Items: [
                makeSnapshotItem("snapmatch", "m-1", 2, { status: "i", innings: [] }),
                inningsItem("snapmatch", 7),
                inningsItem("snapmatch", 6),
                inningsItem("snapmatch", 5),
              ],
              LastEvaluatedKey: cursor,
            })
            .mockResolvedValueOnce({
              Items: [inningsItem("snapmatch", 4), inningsItem("snapmatch", 3)],
              LastEvaluatedKey: toAttributeMap({ pk: "p", sk: "s2" }),
            })

          const latest = yield* SnapshotMatchEvents.readLatest({ matchId: "m-1" })

          // Two requests: event 3 (the first after the snapshot) was reached
          // on the second, so the older events are never read.
          expect(mockQuery).toHaveBeenCalledTimes(2)
          const second = mockQuery.mock.calls[1]![0]
          // Events 4 and 3 are still missing: exactly two.
          expect(second.Limit).toBe(2)
          expect(second.ExclusiveStartKey).toEqual(cursor)
          expect(second.ScanIndexForward).toBe(false)
          expect(latest.events.map((e) => e.version)).toEqual([3, 4, 5, 6, 7])
          expect(latest.version).toBe(7)
        }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("a snapshot lagging by exactly `every` events loads in one request", () =>
      Effect.gen(function* () {
        // every: 3, snapshot at v3, head at v6: the first page (Limit 4) holds
        // the snapshot and events 6, 5 and 4 — everything the snapshot lacks.
        mockQuery.mockResolvedValue({
          ...latestPage(makeSnapshotItem("snapmatch", "m-1", 3, { status: "i", innings: [] }), [
            inningsItem("snapmatch", 4),
            inningsItem("snapmatch", 5),
            inningsItem("snapmatch", 6),
          ]),
          LastEvaluatedKey: toAttributeMap({ pk: "p", sk: "s" }),
        })

        const latest = yield* SnapshotMatchEvents.readLatest({ matchId: "m-1" })

        expect(mockQuery).toHaveBeenCalledOnce()
        expect(latest.events.map((e) => e.version)).toEqual([4, 5, 6])
        expect(latest.version).toBe(6)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("stops after one page once the snapshot's version is reached", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue({
          ...latestPage(makeSnapshotItem("snapmatch", "m-1", 5, { status: "i", innings: [] }), [
            inningsItem("snapmatch", 5),
            inningsItem("snapmatch", 6),
          ]),
          LastEvaluatedKey: toAttributeMap({ pk: "p", sk: "s" }),
        })

        const latest = yield* SnapshotMatchEvents.readLatest({ matchId: "m-1" })

        expect(mockQuery).toHaveBeenCalledOnce()
        expect(latest.events.map((e) => e.version)).toEqual([6])
        expect(latest.version).toBe(6)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("reads to the start of the stream when there is no snapshot", () =>
      Effect.gen(function* () {
        mockQuery
          .mockResolvedValueOnce({
            Items: [inningsItem("snapmatch", 3), inningsItem("snapmatch", 2)],
            LastEvaluatedKey: toAttributeMap({ pk: "p", sk: "s" }),
          })
          .mockResolvedValueOnce({ Items: [inningsItem("snapmatch", 1)] })

        const latest = yield* SnapshotMatchEvents.readLatest({ matchId: "m-1" })

        expect(mockQuery).toHaveBeenCalledTimes(2)
        expect(mockQuery.mock.calls[1]![0].Limit).toBeUndefined()
        expect(Option.isNone(latest.snapshot)).toBe(true)
        expect(latest.events.map((e) => e.version)).toEqual([1, 2, 3])
        expect(latest.version).toBe(3)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("reports the snapshot's version when no event follows it", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue(
          latestPage(makeSnapshotItem("snapmatch", "m-1", 9, { status: "c", innings: [] })),
        )
        const latest = yield* SnapshotMatchEvents.readLatest({ matchId: "m-1" })
        expect(latest.events).toEqual([])
        expect(latest.version).toBe(9)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("an empty stream is version 0 with no snapshot", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue({ Items: [] })
        const latest = yield* SnapshotMatchEvents.readLatest({ matchId: "m-1" })
        expect(latest).toEqual({ snapshot: Option.none(), events: [], version: 0 })
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("fails with ValidationError when the snapshot does not decode", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue(
          latestPage(makeSnapshotItem("snapmatch", "m-1", 2, { status: "nope", innings: [] })),
        )
        const error = yield* SnapshotMatchEvents.readLatest({ matchId: "m-1" }).pipe(Effect.flip)
        expect(error._tag).toBe("ValidationError")
        expect((error as ValidationError).operation).toBe("EventStore.readLatest")
        expect((error as ValidationError).entityType).toBe("snapmatch.snapshot")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("is `read` plus the head on a stream without a snapshot config", () =>
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
        const latest = yield* MatchEvents.readLatest({ matchId: "m-1" }, { consistentRead: true })
        expect(Option.isNone(latest.snapshot)).toBe(true)
        expect(latest.events.map((e) => e.version)).toEqual([1])
        expect(latest.version).toBe(1)
        const call = mockQuery.mock.calls[0]![0]
        expect(call.KeyConditionExpression).toContain("begins_with(#sk, :sk)")
        expect(call.ConsistentRead).toBe(true)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("is available on a bound stream with R = never", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue(
          latestPage(makeSnapshotItem("snapmatch", "m-1", 2, { status: "i", innings: [] })),
        )
        const bound = yield* EventStore.bind(SnapshotMatchEvents)
        const latest: EventStore.LatestState<
          MatchState,
          MatchEvent,
          Record<string, unknown> | undefined
        > = yield* bound.readLatest({ matchId: "m-1" })
        expect(latest.version).toBe(2)
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  describe("append({ snapshot })", () => {
    it.effect("adds an unconditional snapshot Put after the idempotency sentinel", () =>
      Effect.gen(function* () {
        mockTransactWriteItems.mockResolvedValue({})

        const result = yield* InlineMatchEvents.append(
          { matchId: "m-1" },
          [innings(4), innings(5)],
          3,
          {
            idempotency: { commandId: "cmd-1" },
            additionalItems: [Watermarks.put({ writerId: "w", lastSeq: 1 })],
            snapshot: { status: "in-progress", innings: [{ runs: 250, wickets: 10 }] },
          },
        )

        expect(result.version).toBe(5)
        const items = mockTransactWriteItems.mock.calls[0]![0].TransactItems
        // check, 2 events, 1 additional, sentinel, snapshot
        expect(items).toHaveLength(6)
        expect(items[0].ConditionCheck).toBeDefined()
        expect(fromAttributeMap(items[3].Put.Item).__edd_e__).toBe("Watermark")
        expect(fromAttributeMap(items[4].Put.Item).__edd_e__).toBe("inlinematch.command")
        const snapshotPut = items[5].Put
        expect(snapshotPut.ConditionExpression).toBeUndefined()
        expect(fromAttributeMap(snapshotPut.Item)).toEqual({
          pk: "$cricket#v1#inlinematch#m-1",
          sk: DynamoSchema.composeKey(AppSchema, "inlinematch.snapshot", []),
          __edd_e__: "inlinematch.snapshot",
          streamId: "m-1",
          asOfVersion: 5,
          // Encoded through the (transforming) state schema.
          state: { status: "i", innings: ["250/10"] },
          timestamp: expect.any(String),
        })
        expect(mockPutItem).not.toHaveBeenCalled()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("counts the snapshot towards the item limit", () =>
      Effect.gen(function* () {
        const error = yield* InlineMatchEvents.append(
          { matchId: "m-1" },
          Array.from({ length: 99 }, (_, i) => innings(i + 1)),
          0,
          {
            idempotency: { commandId: "cmd-1" },
            snapshot: { status: "in-progress", innings: [] },
          },
        ).pipe(Effect.flip)
        expect(error._tag).toBe("AppendTooLarge")
        expect((error as AppendTooLarge).count).toBe(101)
        expect(mockTransactWriteItems).not.toHaveBeenCalled()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("reports a cancellation at the snapshot's position as TransactionCancelled", () =>
      Effect.gen(function* () {
        mockTransactWriteItems.mockRejectedValue({
          name: "TransactionCanceledException",
          CancellationReasons: [{ Code: "None" }, { Code: "ThrottlingError" }],
        })
        const error = yield* InlineMatchEvents.append({ matchId: "m-1" }, [started()], 0, {
          snapshot: { status: "in-progress", innings: [] },
        }).pipe(Effect.flip)
        expect(error._tag).toBe("TransactionCancelled")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("refuses a snapshot without events, before writing", () =>
      Effect.gen(function* () {
        const error = yield* InlineMatchEvents.append({ matchId: "m-1" }, [], 4, {
          snapshot: { status: "in-progress", innings: [] },
        }).pipe(Effect.flip)
        expect(error._tag).toBe("ValidationError")
        expect((error as ValidationError).operation).toBe("EventStore.append.snapshot")
        expect(mockTransactWriteItems).not.toHaveBeenCalled()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("fails with ValidationError when the state does not encode", () =>
      Effect.gen(function* () {
        const error = yield* InlineMatchEvents.append({ matchId: "m-1" }, [started()], 0, {
          snapshot: { status: "bogus", innings: [] } as unknown as MatchState,
        }).pipe(Effect.flip)
        expect(error._tag).toBe("ValidationError")
        expect((error as ValidationError).operation).toBe("EventStore.append.snapshot")
        expect(mockTransactWriteItems).not.toHaveBeenCalled()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("dies with EDD-9026 on a stream without a snapshot config", () =>
      Effect.gen(function* () {
        const exit = yield* (MatchEvents as unknown as typeof InlineMatchEvents)
          .append({ matchId: "m-1" }, [started()], 0, {
            snapshot: { status: "in-progress", innings: [] },
          })
          .pipe(Effect.exit)
        expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
        expect(String(Cause.pretty((exit as Exit.Failure<unknown, unknown>).cause))).toContain(
          "EDD-9026",
        )
        expect(mockTransactWriteItems).not.toHaveBeenCalled()
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  describe("commandHandler", () => {
    it.effect("mode inline writes the post-fold state in every append transaction", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue(
          latestPage(makeSnapshotItem("inlinematch", "m-1", 1, { status: "i", innings: [] }), [
            makeStreamEventItem("inlinematch", "m-1", 1, "MatchStarted", {
              venue: "MCG",
              homeTeam: "AUS",
              awayTeam: "ENG",
            }),
          ]),
        )
        mockTransactWriteItems.mockResolvedValue({})

        const handle = EventStore.commandHandler(matchDecider, InlineMatchEvents)
        const result = yield* handle(
          { matchId: "m-1" },
          { _tag: "CompleteInnings", innings: 1, runs: 250, wickets: 10 },
        )

        expect(result.version).toBe(2)
        // One request to load, one to write — no separate snapshot write.
        expect(mockQuery).toHaveBeenCalledOnce()
        expect(mockGetItem).not.toHaveBeenCalled()
        expect(mockPutItem).not.toHaveBeenCalled()
        const items = mockTransactWriteItems.mock.calls[0]![0].TransactItems
        const snapshot = fromAttributeMap(items[items.length - 1].Put.Item)
        expect(snapshot.__edd_e__).toBe("inlinematch.snapshot")
        expect(snapshot.asOfVersion).toBe(2)
        expect(snapshot.state).toEqual({ status: "i", innings: ["250/10"] })
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("mode inline with `every` snapshots only once the cadence is reached", () =>
      Effect.gen(function* () {
        mockTransactWriteItems.mockResolvedValue({})
        const handle = EventStore.commandHandler(matchDecider, InlineEvery3)
        const snapshotAt1 = makeSnapshotItem("inlineevery", "m-1", 1, { status: "i", innings: [] })
        const command = { _tag: "CompleteInnings", innings: 1, runs: 1, wickets: 1 } as const

        // Snapshot at v1, head at v1 → appending v2 is one event on: no snapshot.
        mockQuery.mockResolvedValueOnce(latestPage(snapshotAt1))
        yield* handle({ matchId: "m-1" }, command)
        const first = mockTransactWriteItems.mock.calls[0]![0].TransactItems
        expect(
          first.map((i: any) =>
            i.Put === undefined ? "check" : fromAttributeMap(i.Put.Item).__edd_e__,
          ),
        ).toEqual(["check", "inlineevery.event"])

        // Snapshot at v1, head at v3 → appending v4 is three on: snapshot inline.
        mockQuery.mockResolvedValueOnce(
          latestPage(snapshotAt1, [inningsItem("inlineevery", 2), inningsItem("inlineevery", 3)]),
        )
        const result = yield* handle({ matchId: "m-1" }, command)
        expect(result.version).toBe(4)
        const second = mockTransactWriteItems.mock.calls[1]![0].TransactItems
        const snapshot = fromAttributeMap(second[second.length - 1].Put.Item)
        expect(snapshot.__edd_e__).toBe("inlineevery.snapshot")
        expect(snapshot.asOfVersion).toBe(4)
        expect(mockPutItem).not.toHaveBeenCalled()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("a failed inline append writes no snapshot and fails the command", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue({ Items: [] })
        mockTransactWriteItems.mockRejectedValue({
          name: "TransactionCanceledException",
          CancellationReasons: [{ Code: "ConditionalCheckFailed" }, { Code: "None" }],
        })
        const error = yield* EventStore.commandHandler(matchDecider, InlineMatchEvents)(
          { matchId: "m-1" },
          { _tag: "StartMatch", venue: "MCG", homeTeam: "AUS", awayTeam: "ENG" },
        ).pipe(Effect.flip)
        expect(error._tag).toBe("VersionConflict")
        expect(mockPutItem).not.toHaveBeenCalled()
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  // A `Schema.Class` state with an immutable `evolve` that spreads: the fold
  // yields a structurally matching plain object, which TypeScript accepts as
  // the class type but a plain `Schema.encode` refuses (`Expected Tally`).
  // The snapshot encoder decodes it first, as events and metadata are.
  describe("Schema.Class state with a spreading evolve", () => {
    class Tally extends Schema.Class<Tally>("Tally")({
      innings: Schema.Number,
      runs: Schema.Number,
    }) {}

    const tallyDecider: EventStore.Decider<Tally, number, MatchEvent> = {
      initialState: new Tally({ innings: 0, runs: 0 }),
      decide: (runs, state) =>
        Effect.succeed([new InningsCompleted({ innings: state.innings + 1, runs, wickets: 0 })]),
      evolve: (state, event) =>
        event instanceof InningsCompleted
          ? { ...state, innings: state.innings + 1, runs: state.runs + event.runs }
          : state,
    }

    const InlineTally = EventStore.makeStream({
      table: EventsTable,
      streamName: "InlineTally",
      events: [MatchStarted, InningsCompleted, MatchEnded],
      streamId: { composite: ["matchId"] },
      snapshot: { schema: Tally, mode: "inline" },
    })

    const AfterAppendTally = EventStore.makeStream({
      table: EventsTable,
      streamName: "AfterTally",
      events: [MatchStarted, InningsCompleted, MatchEnded],
      streamId: { composite: ["matchId"] },
      snapshot: { schema: Tally, every: 1 },
    })

    it.effect("inline: the spread state is written in the append transaction", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue({ Items: [] })
        mockTransactWriteItems.mockResolvedValue({})

        const result = yield* EventStore.commandHandler(tallyDecider, InlineTally)(
          { matchId: "m-1" },
          120,
        )

        expect(result.version).toBe(1)
        expect(result.state).toEqual({ innings: 1, runs: 120 })
        const items = mockTransactWriteItems.mock.calls[0]![0].TransactItems
        const snapshot = fromAttributeMap(items[items.length - 1].Put.Item)
        expect(snapshot.__edd_e__).toBe("inlinetally.snapshot")
        expect(snapshot.asOfVersion).toBe(1)
        expect(snapshot.state).toEqual({ innings: 1, runs: 120 })
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("after-append: the spread state is written by writeSnapshot", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue({ Items: [] })
        mockTransactWriteItems.mockResolvedValue({})
        mockPutItem.mockResolvedValue({})

        const result = yield* EventStore.commandHandler(tallyDecider, AfterAppendTally)(
          { matchId: "m-1" },
          80,
        )

        expect(result.version).toBe(1)
        expect(mockPutItem).toHaveBeenCalledOnce()
        const snapshot = fromAttributeMap(mockPutItem.mock.calls[0]![0].Item)
        expect(snapshot.__edd_e__).toBe("aftertally.snapshot")
        expect(snapshot.state).toEqual({ innings: 1, runs: 80 })
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("append({ snapshot }) still refuses a state that matches neither shape", () =>
      Effect.gen(function* () {
        const error = yield* InlineTally.append(
          { matchId: "m-1" },
          [new InningsCompleted({ innings: 1, runs: 1, wickets: 0 })],
          0,
          { snapshot: { innings: "one" } as unknown as Tally },
        ).pipe(Effect.flip)
        expect(error._tag).toBe("ValidationError")
        expect((error as ValidationError).entityType).toBe("inlinetally.snapshot")
        expect((error as ValidationError).operation).toBe("EventStore.append.snapshot")
        expect(mockTransactWriteItems).not.toHaveBeenCalled()
      }).pipe(Effect.provide(TestLayer)),
    )
  })
})

// ---------------------------------------------------------------------------
// Stream indexes — sub-streams by derived key (#140)
// ---------------------------------------------------------------------------

describe("EventStore stream indexes (#140)", () => {
  const pad = (n: number) => String(n).padStart(4, "0")

  /** `byInnings` (LSI) indexes InningsCompleted only; `byResult` (GSI) MatchEnded only. */
  const IndexedMatch = EventStore.makeStream({
    table: EventsTable,
    streamName: "IndexedMatch",
    events: [MatchStarted, InningsCompleted, MatchEnded],
    streamId: { composite: ["matchId"] },
    snapshot: { schema: MatchStateSchema, mode: "inline" },
    indexes: {
      byInnings: {
        index: "lsi1",
        sk: "lsi1sk",
        key: (event, version) =>
          event instanceof InningsCompleted
            ? `INN#${pad(event.innings)}#${pad(version)}`
            : undefined,
      },
      byResult: {
        type: "gsi",
        index: "gsi1",
        pk: "gsi1pk",
        sk: "gsi1sk",
        key: (event) => (event instanceof MatchEnded ? `RESULT#${event.result}` : undefined),
      },
    },
  })

  const pk = "$cricket#v1#indexedmatch#m-1"
  const started = () => new MatchStarted({ venue: "MCG", homeTeam: "AUS", awayTeam: "ENG" })
  const innings = (n: number) => new InningsCompleted({ innings: n, runs: 100 + n, wickets: n })

  /** Every Put item of one TransactWriteItems call, decoded. */
  const putsOf = (call: { TransactItems: ReadonlyArray<any> }) =>
    call.TransactItems.filter((i) => i.Put !== undefined).map((i) => fromAttributeMap(i.Put.Item))
  const eventPutsOf = (call: { TransactItems: ReadonlyArray<any> }) =>
    putsOf(call).filter((item) => String(item.__edd_e__).endsWith(".event"))

  const make = (indexes: unknown) => () =>
    EventStore.makeStream({
      table: EventsTable,
      streamName: "Bad",
      events: [MatchStarted],
      streamId: { composite: ["matchId"] },
      indexes: indexes as never,
    })

  describe("definition-time validation", () => {
    const key = () => undefined

    it("exposes each index's settings", () => {
      expect(IndexedMatch.indexes).toEqual({
        byInnings: { type: "lsi", index: "lsi1", pk: "pk", sk: "lsi1sk" },
        byResult: { type: "gsi", index: "gsi1", pk: "gsi1pk", sk: "gsi1sk" },
      })
      expect(MatchEvents.indexes).toEqual({})
    })

    it("throws EDD-9063 for a malformed index", () => {
      expect(make({ a: { type: "lsx", index: "i", sk: "s", key } })).toThrow(/EDD-9063.*type/)
      expect(make({ a: { type: "gsi", index: "i", sk: "s", key } })).toThrow(/EDD-9063.*pk/)
      expect(make({ a: { index: "i", pk: "p", sk: "s", key } })).toThrow(/EDD-9063.*lsi/)
      expect(make({ a: { index: "", sk: "s", key } })).toThrow(/EDD-9063.*index/)
      expect(make({ a: { index: "i", sk: "", key } })).toThrow(/EDD-9063.*sk/)
      expect(make({ a: { index: "i", sk: "s", key: "x" } })).toThrow(/EDD-9063.*key/)
      expect(make({ a: null })).toThrow(/EDD-9063/)
    })

    it("throws EDD-9064 for an attribute the stream writes itself", () => {
      for (const attribute of ["pk", "sk", "__edd_e__", "version", "data", "state", "_ttl"]) {
        expect(make({ a: { index: "i", sk: attribute, key } })).toThrow(/EDD-9064/)
      }
      expect(make({ a: { type: "gsi", index: "i", pk: "streamId", sk: "s", key } })).toThrow(
        /EDD-9064.*streamId/,
      )
      expect(make({ a: { type: "gsi", index: "i", pk: "p", sk: "commandId", key } })).toThrow(
        /EDD-9064.*commandId/,
      )
    })

    it("throws EDD-9065 for indexes sharing an index or an attribute", () => {
      expect(make({ a: { index: "i", sk: "s1", key }, b: { index: "i", sk: "s2", key } })).toThrow(
        /EDD-9065.*physical index "i"/,
      )
      expect(make({ a: { index: "i1", sk: "s", key }, b: { index: "i2", sk: "s", key } })).toThrow(
        /EDD-9065.*attribute "s"/,
      )
      expect(
        make({
          a: { type: "gsi", index: "g1", pk: "gpk", sk: "s1", key },
          b: { type: "gsi", index: "g2", pk: "gpk", sk: "s2", key },
        }),
      ).toThrow(/EDD-9065.*attribute "gpk"/)
      expect(make({ a: { type: "gsi", index: "g", pk: "k", sk: "k", key } })).toThrow(/EDD-9065/)
    })
  })

  describe("append", () => {
    it.effect("writes the derived keys on indexed event items only", () =>
      Effect.gen(function* () {
        mockTransactWriteItems.mockResolvedValue({})
        yield* IndexedMatch.append(
          { matchId: "m-1" },
          [started(), innings(1), new MatchEnded({ result: "AUS won" })],
          0,
          { idempotency: { commandId: "cmd-1" }, snapshot: { status: "completed", innings: [] } },
        )
        const call = mockTransactWriteItems.mock.calls[0]![0]
        const [first, second, third] = eventPutsOf(call)
        // Sparse: MatchStarted is in neither index.
        expect(first).not.toHaveProperty("lsi1sk")
        expect(first).not.toHaveProperty("gsi1pk")
        expect(first).not.toHaveProperty("gsi1sk")
        // LSI: the derived key, raw (no casing, no prefix).
        expect(second!.lsi1sk).toBe("INN#0001#0002")
        expect(second).not.toHaveProperty("gsi1pk")
        // GSI: the stream's partition key plus the derived key.
        expect(third!.gsi1pk).toBe(pk)
        expect(third!.gsi1sk).toBe("RESULT#AUS won")
        expect(third).not.toHaveProperty("lsi1sk")
        // The sentinel and the snapshot never carry index attributes.
        const others = putsOf(call).filter((item) => !String(item.__edd_e__).endsWith(".event"))
        expect(others.map((item) => item.__edd_e__).sort()).toEqual([
          "indexedmatch.command",
          "indexedmatch.snapshot",
        ])
        for (const item of others) {
          for (const attribute of ["lsi1sk", "gsi1pk", "gsi1sk"]) {
            expect(item).not.toHaveProperty(attribute)
          }
        }
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("counts the index attributes towards the 4 MB check", () =>
      Effect.gen(function* () {
        mockTransactWriteItems.mockResolvedValue({})
        // A 1000-byte key on each of 100 events: alone it adds ~100 KB, which
        // tips a transaction sized just under 4 MB without the keys over it.
        const big = (version: number) => `K${pad(version)}${"x".repeat(995)}`
        const Heavy = EventStore.makeStream({
          table: EventsTable,
          streamName: "Heavy",
          events: [MatchEnded],
          streamId: { composite: ["matchId"] },
          indexes: { byKey: { index: "lsi1", sk: "lsi1sk", key: (_, version) => big(version) } },
        })
        const Light = EventStore.makeStream({
          table: EventsTable,
          streamName: "Heavy",
          events: [MatchEnded],
          streamId: { composite: ["matchId"] },
        })
        const events = (length: number) =>
          Array.from({ length: 99 }, () => new MatchEnded({ result: "r".repeat(length) }))
        // Calibrate: size the events so the transaction without keys sits
        // 50 KB under the limit.
        yield* Light.append({ matchId: "m-1" }, events(40_000), 0)
        const probe = mockTransactWriteItems.mock.calls[0]![0].TransactItems.reduce(
          (sum: number, item: Parameters<typeof transactItemBytes>[0]) =>
            sum + transactItemBytes(item),
          0,
        )
        const length = 40_000 + Math.floor((TRANSACT_WRITE_MAX_BYTES - 50_000 - probe) / 99)
        yield* Light.append({ matchId: "m-1" }, events(length), 0)
        expect(mockTransactWriteItems).toHaveBeenCalledTimes(2)
        const error = yield* Heavy.append({ matchId: "m-1" }, events(length), 0).pipe(Effect.flip)
        expect(error._tag).toBe("ValidationError")
        expect(String((error as ValidationError).cause)).toContain("4 MB")
        expect(mockTransactWriteItems).toHaveBeenCalledTimes(2)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("refuses an empty, non-string, oversized or throwing key before writing", () =>
      Effect.gen(function* () {
        const withKey = (key: (event: unknown) => unknown) =>
          EventStore.makeStream({
            table: EventsTable,
            streamName: "KeyCheck",
            events: [MatchStarted],
            streamId: { composite: ["matchId"] },
            indexes: { byKey: { index: "lsi1", sk: "lsi1sk", key: key as () => string } },
          })
        const cases: ReadonlyArray<[(event: unknown) => unknown, RegExp]> = [
          [() => "", /empty string/],
          [() => 42, /non-empty string/],
          [() => "x".repeat(1025), /1024-byte/],
          [
            () => {
              throw new Error("boom")
            },
            /boom/,
          ],
        ]
        for (const [key, pattern] of cases) {
          const error = yield* withKey(key)
            .append({ matchId: "m-1" }, [started()], 0)
            .pipe(Effect.flip)
          expect(error._tag).toBe("ValidationError")
          expect(String((error as ValidationError).cause)).toMatch(pattern)
        }
        // Exactly 1024 bytes is accepted.
        mockTransactWriteItems.mockResolvedValue({})
        yield* withKey(() => "é".repeat(512)).append({ matchId: "m-1" }, [started()], 0)
        expect(mockTransactWriteItems).toHaveBeenCalledOnce()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("refuses an index attribute equal to a custom TTL attribute", () =>
      Effect.gen(function* () {
        const Stream = EventStore.makeStream({
          table: EventsTable,
          streamName: "TtlClash",
          events: [MatchStarted],
          streamId: { composite: ["matchId"] },
          indexes: { byKey: { index: "lsi1", sk: "expiresAt", key: () => "k" } },
        })
        const error = yield* Stream.append({ matchId: "m-1" }, [started()], 0).pipe(
          Effect.flip,
          Effect.provide(
            Layer.merge(
              TestDynamoClient,
              EventsTable.layer({ name: "events-table", ttlAttributeName: "expiresAt" }),
            ),
          ),
        )
        expect(error._tag).toBe("ValidationError")
        expect(String((error as ValidationError).cause)).toContain("TTL attribute")
        expect(mockTransactWriteItems).not.toHaveBeenCalled()
      }),
    )

    it.effect("commandHandler writes the derived keys", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue({ Items: [] })
        mockTransactWriteItems.mockResolvedValue({})
        const handle = EventStore.commandHandler(matchDecider, IndexedMatch)
        yield* handle(
          { matchId: "m-1" },
          { _tag: "StartMatch", venue: "MCG", homeTeam: "AUS", awayTeam: "ENG" },
        )
        expect(eventPutsOf(mockTransactWriteItems.mock.calls[0]![0])[0]).not.toHaveProperty(
          "lsi1sk",
        )
        mockQuery.mockResolvedValue({
          Items: [
            toAttributeMap({
              pk,
              sk: DynamoSchema.composeKey(AppSchema, "indexedmatch.snapshot", []),
              __edd_e__: "indexedmatch.snapshot",
              streamId: "m-1",
              asOfVersion: 1,
              state: { status: "i", innings: [] },
              timestamp: "2026-03-08T12:00:00.000Z",
            }),
          ],
        })
        yield* handle(
          { matchId: "m-1" },
          { _tag: "CompleteInnings", innings: 1, runs: 250, wickets: 10 },
        )
        expect(eventPutsOf(mockTransactWriteItems.mock.calls[1]![0])[0]!.lsi1sk).toBe(
          "INN#0001#0002",
        )
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  describe("query.index / readIndex", () => {
    const indexedItem = (version: number, extra: Record<string, unknown>) =>
      toAttributeMap({
        pk,
        sk: DynamoSchema.composeEventVersionKey(AppSchema, "indexedmatch.event", version),
        __edd_e__: "indexedmatch.event",
        streamId: "m-1",
        version,
        eventType: "InningsCompleted",
        data: { _tag: "InningsCompleted", innings: version, runs: 1, wickets: 0 },
        timestamp: "2026-03-08T12:00:00.000Z",
        ...extra,
      })

    it.effect("queries the LSI in the stream's partition and decodes events", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue({
          Items: [indexedItem(4, { lsi1sk: "INN#0001#0004" })],
        })
        const events = yield* IndexedMatch.query
          .index("byInnings", { matchId: "m-1" })
          .pipe(Query.where({ beginsWith: "INN#0001" }), Query.consistentRead(), Query.collect)
        expect(events).toHaveLength(1)
        expect(events[0]!.version).toBe(4)
        expect(events[0]!.data).toBeInstanceOf(InningsCompleted)

        const call = mockQuery.mock.calls[0]![0]
        expect(call.TableName).toBe("events-table")
        expect(call.IndexName).toBe("lsi1")
        expect(call.ConsistentRead).toBe(true)
        expect(call.KeyConditionExpression).toContain("begins_with")
        expect(Object.values(call.ExpressionAttributeNames)).toEqual(
          expect.arrayContaining(["pk", "lsi1sk"]),
        )
        expect(fromAttributeMap(call.ExpressionAttributeValues)).toMatchObject({
          ":pk": pk,
          ":sk": "INN#0001",
        })
        expect(call.FilterExpression).toBeDefined()
        expect(Object.values(fromAttributeMap(call.ExpressionAttributeValues))).toContain(
          "indexedmatch.event",
        )
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("queries a GSI by its pk attribute and refuses consistentRead on it", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue({ Items: [] })
        yield* IndexedMatch.query.index("byResult", { matchId: "m-1" }).pipe(Query.collect)
        const call = mockQuery.mock.calls[0]![0]
        expect(call.IndexName).toBe("gsi1")
        expect(Object.values(call.ExpressionAttributeNames)).toContain("gsi1pk")
        expect(fromAttributeMap(call.ExpressionAttributeValues)[":pk"]).toBe(pk)
        expect(call.ConsistentRead).toBeUndefined()

        const error = yield* IndexedMatch.readIndex(
          "byResult",
          { matchId: "m-1" },
          { consistentRead: true },
        ).pipe(Effect.flip)
        expect(error._tag).toBe("ValidationError")
        expect(mockQuery).toHaveBeenCalledOnce()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("readIndex applies between, reverse and limit", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue({
          Items: [indexedItem(3, { lsi1sk: "INN#0003#0003" })],
        })
        const events = yield* IndexedMatch.readIndex(
          "byInnings",
          { matchId: "m-1" },
          { between: ["INN#0001", "INN#0003~"], reverse: true, limit: 1 },
        )
        expect(events.map((event) => event.version)).toEqual([3])
        const call = mockQuery.mock.calls[0]![0]
        expect(call.IndexName).toBe("lsi1")
        expect(call.KeyConditionExpression).toContain("BETWEEN")
        expect(call.ScanIndexForward).toBe(false)
        expect(call.Limit).toBe(1)
        expect(fromAttributeMap(call.ExpressionAttributeValues)).toMatchObject({
          ":sk1": "INN#0001",
          ":sk2": "INN#0003~",
        })
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("readIndex refuses both key conditions and a bad limit before sending", () =>
      Effect.gen(function* () {
        const both = yield* IndexedMatch.readIndex("byInnings", { matchId: "m-1" }, {
          beginsWith: "a",
          between: ["a", "b"],
        } as never).pipe(Effect.flip)
        expect(both._tag).toBe("ValidationError")
        for (const limit of [0, -1, 1.5]) {
          const error = yield* IndexedMatch.readIndex(
            "byInnings",
            { matchId: "m-1" },
            { limit },
          ).pipe(Effect.flip)
          expect(error._tag).toBe("ValidationError")
        }
        expect(mockQuery).not.toHaveBeenCalled()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("readIndex refuses empty and inverted key bounds before sending", () =>
      Effect.gen(function* () {
        const refused: ReadonlyArray<EventStore.ReadIndexOptions> = [
          { beginsWith: "" },
          { between: ["", "INN#0009"] },
          { between: ["INN#0001", ""] },
          { between: ["INN#0009", "INN#0001"] },
          { between: ["INN#0001"] } as never,
          { between: ["INN#0001", 9] } as never,
          { beginsWith: 1 } as never,
        ]
        for (const options of refused) {
          const error = yield* IndexedMatch.readIndex(
            "byInnings",
            { matchId: "m-1" },
            options,
          ).pipe(Effect.flip)
          expect(error._tag).toBe("ValidationError")
          expect(String((error as { cause: unknown }).cause)).toContain("Nothing was sent")
        }
        expect(mockQuery).not.toHaveBeenCalled()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("readIndex orders between bounds by UTF-8 bytes, as DynamoDB does", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue({ Items: [] })
        // UTF-16 code units put U+FFFF after U+1F600 (a surrogate pair, 0xD83D…);
        // UTF-8 bytes — DynamoDB's order — put it before (EF… < F0…).
        yield* IndexedMatch.readIndex(
          "byInnings",
          { matchId: "m-1" },
          {
            between: ["￿", "\u{1F600}"],
          },
        )
        // Equal bounds are a valid (point) range.
        yield* IndexedMatch.readIndex(
          "byInnings",
          { matchId: "m-1" },
          {
            between: ["INN#0001", "INN#0001"],
          },
        )
        expect(mockQuery).toHaveBeenCalledTimes(2)
        const reversed = yield* IndexedMatch.readIndex(
          "byInnings",
          { matchId: "m-1" },
          {
            between: ["\u{1F600}", "￿"],
          },
        ).pipe(Effect.flip)
        expect(reversed._tag).toBe("ValidationError")
        expect(mockQuery).toHaveBeenCalledTimes(2)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("an undeclared index name is a defect (EDD-9066)", () =>
      Effect.gen(function* () {
        expect(() =>
          (IndexedMatch.query.index as (n: string, id: object) => unknown)("nope", {
            matchId: "m-1",
          }),
        ).toThrow(/EDD-9066.*"byInnings", "byResult"/)
        const exit = yield* (MatchEvents as unknown as { readIndex: typeof IndexedMatch.readIndex })
          .readIndex("byInnings", { matchId: "m-1" })
          .pipe(Effect.exit)
        expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
        expect(Cause.pretty((exit as Exit.Failure<unknown, unknown>).cause)).toContain(
          "declares no indexes",
        )
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("a bound stream carries the indexes and resolves its services", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue({ Items: [indexedItem(2, { lsi1sk: "INN#0002#0002" })] })
        const bound = yield* EventStore.bind(IndexedMatch)
        expect(bound.indexes).toEqual(IndexedMatch.indexes)
        const events = yield* bound.readIndex("byInnings", { matchId: "m-1" })
        expect(events.map((event) => event.version)).toEqual([2])
        expect(mockQuery.mock.calls[0]![0].IndexName).toBe("lsi1")
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  describe("indexDefinitions", () => {
    const Other = EventStore.makeStream({
      table: EventsTable,
      streamName: "Other",
      events: [MatchStarted],
      streamId: { composite: ["matchId"] },
      indexes: {
        // The same physical LSI as IndexedMatch's byInnings, defined identically.
        byVenue: { index: "lsi1", sk: "lsi1sk", key: (event) => event.venue },
        byTeam: { type: "gsi", index: "gsi2", pk: "gsi2pk", sk: "gsi2sk", key: (e) => e.homeTeam },
      },
    })

    it("derives LSI and GSI fragments with projection ALL, deduplicated", () => {
      expect(EventStore.indexDefinitions(IndexedMatch, Other, MatchEvents)).toEqual({
        AttributeDefinitions: ["gsi1pk", "gsi1sk", "gsi2pk", "gsi2sk", "lsi1sk"].map(
          (AttributeName) => ({ AttributeName, AttributeType: "S" }),
        ),
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
        GlobalSecondaryIndexes: ["gsi1", "gsi2"].map((IndexName) => ({
          IndexName,
          KeySchema: [
            { AttributeName: `${IndexName}pk`, KeyType: "HASH" },
            { AttributeName: `${IndexName}sk`, KeyType: "RANGE" },
          ],
          Projection: { ProjectionType: "ALL" },
        })),
      })
    })

    it("omits empty index lists", () => {
      expect(EventStore.indexDefinitions(MatchEvents)).toEqual({ AttributeDefinitions: [] })
      expect(EventStore.indexDefinitions()).toEqual({ AttributeDefinitions: [] })
    })

    it("throws EDD-9067 for conflicting definitions of one physical index", () => {
      const Conflicting = EventStore.makeStream({
        table: EventsTable,
        streamName: "Conflicting",
        events: [MatchStarted],
        streamId: { composite: ["matchId"] },
        indexes: { byVenue: { index: "lsi1", sk: "venueSk", key: (event) => event.venue } },
      })
      expect(() => EventStore.indexDefinitions(IndexedMatch, Conflicting)).toThrow(
        /EDD-9067.*"lsi1"/,
      )
      const AsGsi = EventStore.makeStream({
        table: EventsTable,
        streamName: "AsGsi",
        events: [MatchStarted],
        streamId: { composite: ["matchId"] },
        indexes: {
          byVenue: { type: "gsi", index: "lsi1", pk: "x", sk: "lsi1sk", key: (e) => e.venue },
        },
      })
      expect(() => EventStore.indexDefinitions(IndexedMatch, AsGsi)).toThrow(/EDD-9067/)
    })
  })
})
