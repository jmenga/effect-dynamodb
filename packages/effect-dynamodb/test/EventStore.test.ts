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
  Crypto,
  Data,
  DateTime,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  pipe,
  Schedule,
  Schema,
  SchemaGetter,
} from "effect"
import { TestClock } from "effect/testing"
import { beforeEach, vi } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
import * as Expression from "../src/Expression.js"
import { refuseRepeatedItems, transactItemTarget } from "../src/internal/TransactWriteOps.js"
import { fromAttributeMap, toAttributeMap } from "../src/Marshaller.js"
import * as Query from "../src/Query.js"
import * as Table from "../src/Table.js"
import * as Transaction from "../src/Transaction.js"
import {
  awsTransactionCanceled,
  awsValidationException,
  DDB_ITEM_SIZE,
  DDB_ITEM_SIZE_UPDATE,
  DDB_SORT_KEY_AWS,
  DDB_SORT_KEY_LOCAL,
  DDB_TOO_MANY_ITEMS,
  ddbPayloadTooLarge,
  mockDynamoClientLayer,
} from "./helpers/MockDynamoClient.js"

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

// #144 — an entity whose own GSI writes `gsi1sk`, the attribute a stream index
// can also use (single-table designs share physical index attributes).
class Label extends Schema.Class<Label>("Label")({
  labelId: Schema.String,
  text: Schema.String,
}) {}

const Labels = Entity.make({
  model: Label,
  entityType: "Label",
  primaryKey: { pk: { field: "pk", composite: ["labelId"] }, sk: { field: "sk", composite: [] } },
  indexes: {
    byText: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["labelId"] },
      sk: { field: "gsi1sk", composite: ["text"] },
    },
  },
})

const EventsTable = Table.make({
  schema: AppSchema,
  entities: { Watermarks, StatusProjection, Registrations, AuditRecords, Labels },
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
const mockBatchGetItem = vi.fn()

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
  batchGetItem: (input) =>
    Effect.tryPromise({
      try: async () => (await mockBatchGetItem(input)) ?? {},
      catch: (e) => new DynamoError({ operation: "BatchGetItem", cause: e }),
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

    it.effect("fails with AppendTooLarge when DynamoDB rejects over 100 items (#144)", () =>
      Effect.gen(function* () {
        mockTransactWriteItems.mockRejectedValueOnce(awsValidationException(DDB_TOO_MANY_ITEMS))
        const result = yield* MatchEvents.append({ matchId: "m-1" }, manyEvents(101), 0).pipe(
          Effect.flip,
        )

        expect(result._tag).toBe("AppendTooLarge")
        const err = result as AppendTooLarge
        expect(err.streamName).toBe("Match")
        expect(err.streamId).toBe("m-1")
        expect(err.count).toBe(101)
        expect(err.limit).toBe(TRANSACT_WRITE_ITEMS_LIMIT)
        expect(mockTransactWriteItems).toHaveBeenCalledOnce()
        // DynamoDB's error, as the client reported it, is the cause.
        expect((err.cause as { _tag: string })._tag).toBe("DynamoError")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("a count rejection the request does not confirm passes through (#144)", () =>
      Effect.gen(function* () {
        const rejection = awsValidationException(DDB_TOO_MANY_ITEMS)
        mockTransactWriteItems.mockRejectedValueOnce(rejection)
        const result = yield* MatchEvents.append({ matchId: "m-1" }, manyEvents(3), 0).pipe(
          Effect.flip,
        )
        expect(result._tag).toBe("DynamoError")
        expect((result as { cause: unknown }).cause).toBe(rejection)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("an unrecognised ValidationException passes through unchanged (#144)", () =>
      Effect.gen(function* () {
        const rejection = awsValidationException("Some other validation problem")
        mockTransactWriteItems.mockRejectedValueOnce(rejection)
        const result = yield* MatchEvents.append({ matchId: "m-1" }, manyEvents(3), 0).pipe(
          Effect.flip,
        )
        expect(result._tag).toBe("DynamoError")
        expect((result as { cause: unknown }).cause).toBe(rejection)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("an oversized event is named from DynamoDB's request-wide rejection (#144)", () =>
      Effect.gen(function* () {
        const rejection = awsValidationException(DDB_ITEM_SIZE)
        mockTransactWriteItems.mockRejectedValueOnce(rejection)
        const big = new MatchStarted({
          venue: "x".repeat(410_000),
          homeTeam: "AUS",
          awayTeam: "ENG",
        })
        const result = yield* MatchEvents.append(
          { matchId: "m-1" },
          [...manyEvents(2), big],
          0,
        ).pipe(Effect.flip)

        expect(result._tag).toBe("ValidationError")
        const failure = result as ValidationError
        expect(failure.operation).toBe("EventStore.append")
        const text = String(failure.cause)
        expect(text).toContain("the item of the event at version 3, at pk=$cricket#v1#match#m-1")
        expect(text).toContain("409600 bytes (400 KB)")
        expect(text).toContain("Nothing was written.")
        expect(((failure.cause as Error).cause as { cause: unknown }).cause).toBe(rejection)
        expect(mockTransactWriteItems).toHaveBeenCalledOnce()
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
          mockTransactWriteItems.mockRejectedValueOnce(awsValidationException(DDB_TOO_MANY_ITEMS))
          const result = yield* MatchEvents.append({ matchId: "m-1" }, manyEvents(100), 3).pipe(
            Effect.flip,
          )

          expect(result._tag).toBe("AppendTooLarge")
          const err = result as AppendTooLarge
          expect(err.count).toBe(101)
          expect(err.limit).toBe(TRANSACT_WRITE_ITEMS_LIMIT)
          expect(mockTransactWriteItems).toHaveBeenCalledOnce()
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
        mockTransactWriteItems.mockRejectedValueOnce(awsValidationException(DDB_TOO_MANY_ITEMS))
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

    it.effect("an append over DynamoDB's 4 MB is diagnosed, naming the largest items (#144)", () =>
      Effect.gen(function* () {
        const rejection = awsValidationException(ddbPayloadTooLarge(4_400_000))
        mockTransactWriteItems.mockRejectedValueOnce(rejection)
        const big = "x".repeat(380_000)
        const error = yield* MatchEvents.append({ matchId: "m-1" }, [startMatch()], 0, {
          additionalItems: Array.from({ length: 6 }, (_, i) =>
            Registrations.put({ regId: `r-${i}`, code: `${i}${big}` }),
          ),
        }).pipe(Effect.flip)
        expect(error._tag).toBe("ValidationError")
        const failure = error as ValidationError
        expect(failure.entityType).toBe("Registration")
        expect(failure.operation).toBe("EventStore.append")
        expect(String(failure.cause)).toContain("4194304 bytes (4 MB)")
        expect(String(failure.cause)).toMatch(/The largest: operation \d \(Registration/)
        expect(((failure.cause as Error).cause as { cause: unknown }).cause).toBe(rejection)
        expect(mockTransactWriteItems).toHaveBeenCalledOnce()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("an additional item's cancellation reason for its size is named (#144)", () =>
      Effect.gen(function* () {
        // [event put, additional put]: the additional item's reason is a
        // ValidationError — never read as a conflict or a condition failure.
        mockTransactWriteItems.mockRejectedValueOnce(
          awsTransactionCanceled([
            { Code: "None" },
            { Code: "ValidationError", Message: DDB_ITEM_SIZE_UPDATE },
          ]),
        )
        const error = yield* MatchEvents.append({ matchId: "m-1" }, [startMatch()], 0, {
          additionalItems: [Watermarks.put({ writerId: "ingest-1", lastSeq: 1 })],
        }).pipe(Effect.flip)
        expect(error._tag).toBe("ValidationError")
        expect(String((error as ValidationError).cause)).toContain("operation 0 (")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("a conflict beside a size reason is still the conflict (#144)", () =>
      Effect.gen(function* () {
        mockTransactWriteItems.mockRejectedValueOnce(
          awsTransactionCanceled([
            { Code: "ConditionalCheckFailed" },
            { Code: "ValidationError", Message: DDB_ITEM_SIZE },
          ]),
        )
        const error = yield* MatchEvents.append({ matchId: "m-1" }, [startMatch()], 0, {
          additionalItems: [Watermarks.put({ writerId: "ingest-1", lastSeq: 1 })],
        }).pipe(Effect.flip)
        expect(error._tag).toBe("VersionConflict")
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

    it.effect(
      "fails with AppendTooLarge past the 100-item cap, from DynamoDB's rejection (#144)",
      () =>
        Effect.gen(function* () {
          mockTransactWriteItems.mockRejectedValueOnce(awsValidationException(DDB_TOO_MANY_ITEMS))
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
          expect(mockTransactWriteItems).toHaveBeenCalledOnce()
        }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("counts the idempotency sentinel against the cap", () =>
      Effect.gen(function* () {
        mockTransactWriteItems.mockRejectedValueOnce(awsValidationException(DDB_TOO_MANY_ITEMS))
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
        mockTransactWriteItems.mockRejectedValueOnce(awsValidationException(DDB_TOO_MANY_ITEMS))
        // 99 events + 1 additional item = 100, which fits at expectedVersion 0.
        // At expectedVersion > 0 the contiguity ConditionCheck is the 101st item.
        const events = Array.from({ length: 99 }, () => startMatch())
        const additionalItems = [Watermarks.put({ writerId: "ingest-1", lastSeq: 1 })]

        const error = yield* MatchEvents.append({ matchId: "m-1" }, events, 7, {
          additionalItems,
        }).pipe(Effect.flip)

        expect(error._tag).toBe("AppendTooLarge")
        expect((error as AppendTooLarge).count).toBe(101)
        expect(mockTransactWriteItems).toHaveBeenCalledOnce()
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
        mockTransactWriteItems.mockRejectedValueOnce(awsValidationException(DDB_TOO_MANY_ITEMS))
        // 34 registration ops expand to 102 items; unexpanded they would pass.
        const additionalItems = Array.from({ length: 34 }, (_, i) =>
          Registrations.put({ regId: `r-${i}`, code: `C${i}` }),
        )

        const error = yield* MatchEvents.append({ matchId: "m-1" }, [], 0, {
          additionalItems,
        }).pipe(Effect.flip)

        expect(error._tag).toBe("AppendTooLarge")
        expect((error as AppendTooLarge).count).toBe(102)
        expect(mockTransactWriteItems).toHaveBeenCalledOnce()
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

    it.effect(
      "an oversized decided event is named from DynamoDB's rejection, not retried (#144)",
      () =>
        Effect.gen(function* () {
          mockQuery.mockResolvedValueOnce({ Items: [] })
          const rejection = awsValidationException(DDB_ITEM_SIZE)
          mockTransactWriteItems.mockRejectedValueOnce(rejection)

          const error = yield* handleMatch(
            { matchId: "m-1" },
            { _tag: "StartMatch", venue: "x".repeat(410_000), homeTeam: "AUS", awayTeam: "ENG" },
          ).pipe(Effect.flip)

          expect(error._tag).toBe("ValidationError")
          const failure = error as ValidationError
          expect(failure.operation).toBe("EventStore.append")
          expect(String(failure.cause)).toContain(
            "the item of the event at version 1, at pk=$cricket#v1#match#m-1",
          )
          expect(((failure.cause as Error).cause as { cause: unknown }).cause).toBe(rejection)
          expect(mockTransactWriteItems).toHaveBeenCalledOnce()
        }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("DynamoDB's 101-item rejection of a decision is AppendTooLarge (#144)", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValueOnce({ Items: [] })
        mockTransactWriteItems.mockRejectedValueOnce(awsValidationException(DDB_TOO_MANY_ITEMS))
        const flood: EventStore.Decider<MatchState, MatchCommand, MatchEvent> = {
          ...matchDecider,
          decide: () =>
            Effect.succeed(
              Array.from(
                { length: 101 },
                (_, i) => new InningsCompleted({ innings: i + 1, runs: 1, wickets: 1 }),
              ),
            ),
        }
        const error = yield* EventStore.commandHandler(flood, MatchEvents)(
          { matchId: "m-1" },
          { _tag: "CompleteInnings", innings: 1, runs: 1, wickets: 1 },
        ).pipe(Effect.flip)

        expect(error._tag).toBe("AppendTooLarge")
        expect((error as AppendTooLarge).count).toBe(101)
        expect(mockTransactWriteItems).toHaveBeenCalledOnce()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("an unrecognised rejection of a decision passes through unchanged (#144)", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValueOnce({ Items: [] })
        const rejection = awsValidationException("Some other validation problem")
        mockTransactWriteItems.mockRejectedValueOnce(rejection)

        const error = yield* handleMatch(
          { matchId: "m-1" },
          { _tag: "StartMatch", venue: "MCG", homeTeam: "AUS", awayTeam: "ENG" },
        ).pipe(Effect.flip)

        expect(error._tag).toBe("DynamoError")
        expect((error as { cause: unknown }).cause).toBe(rejection)
        expect(mockTransactWriteItems).toHaveBeenCalledOnce()
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

    it.effect("an oversized snapshot is named from DynamoDB's rejection (#144)", () =>
      Effect.gen(function* () {
        const rejection = awsValidationException(DDB_ITEM_SIZE)
        mockPutItem.mockRejectedValueOnce(rejection)

        const error = yield* SnapshotMatchEvents.writeSnapshot(
          { matchId: "m-1" },
          { status: "pending", innings: [] },
          1,
        ).pipe(Effect.flip)

        expect(error._tag).toBe("ValidationError")
        const failure = error as ValidationError
        expect(failure.operation).toBe("EventStore.writeSnapshot")
        expect(String(failure.cause)).toContain("the item of the snapshot, at pk=")
        expect(((failure.cause as Error).cause as { cause: unknown }).cause).toBe(rejection)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("an unrecognised snapshot rejection passes through unchanged (#144)", () =>
      Effect.gen(function* () {
        const rejection = awsValidationException("Some other validation problem")
        mockPutItem.mockRejectedValueOnce(rejection)

        const error = yield* SnapshotMatchEvents.writeSnapshot(
          { matchId: "m-1" },
          { status: "pending", innings: [] },
          1,
        ).pipe(Effect.flip)

        expect(error._tag).toBe("DynamoError")
        expect((error as { cause: unknown }).cause).toBe(rejection)
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
        mockTransactWriteItems.mockRejectedValueOnce(awsValidationException(DDB_TOO_MANY_ITEMS))
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
        expect(mockTransactWriteItems).toHaveBeenCalledOnce()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("a size reason at the snapshot's position names the inline snapshot (#144)", () =>
      Effect.gen(function* () {
        mockTransactWriteItems.mockRejectedValueOnce(
          awsTransactionCanceled([
            { Code: "None" },
            { Code: "ValidationError", Message: DDB_ITEM_SIZE },
          ]),
        )
        const error = yield* InlineMatchEvents.append({ matchId: "m-1" }, [started()], 0, {
          snapshot: { status: "in-progress", innings: [] },
        }).pipe(Effect.flip)
        expect(error._tag).toBe("ValidationError")
        expect(String((error as ValidationError).cause)).toContain(
          "the item of the inline snapshot, at pk=$cricket#v1#inlinematch#m-1",
        )
        expect(mockTransactWriteItems).toHaveBeenCalledOnce()
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

describe("EventStore verifySnapshot: false — unverified snapshot loads", () => {
  /** The one mode that accepts `verifySnapshot: false`. */
  const Inline = EventStore.makeStream({
    table: EventsTable,
    streamName: "Unverified",
    events: [MatchStarted, InningsCompleted, MatchEnded],
    streamId: { composite: ["matchId"] },
    snapshot: { schema: MatchStateSchema, mode: "inline" },
  })
  const InlineEvery = EventStore.makeStream({
    table: EventsTable,
    streamName: "UnverifiedEvery",
    events: [MatchStarted, InningsCompleted, MatchEnded],
    streamId: { composite: ["matchId"] },
    snapshot: { schema: MatchStateSchema, mode: "inline", every: 5 },
  })
  const AfterAppend = EventStore.makeStream({
    table: EventsTable,
    streamName: "UnverifiedAfter",
    events: [MatchStarted, InningsCompleted, MatchEnded],
    streamId: { composite: ["matchId"] },
    snapshot: { schema: MatchStateSchema, every: 5 },
  })

  const label = "unverified"
  /**
   * The head check of an unverified load: one reverse `Limit: 1` `Query`
   * bounded below by the event after `floorVersion`, so a snapshot at the head
   * reads no items at all.
   */
  const expectHeadAbove = (call: any, floorVersion: number) => {
    expect(call.Limit).toBe(1)
    expect(call.ScanIndexForward).toBe(false)
    expect(call.ConsistentRead).toBe(true)
    expect(call.KeyConditionExpression).toContain("#sk BETWEEN :sk1 AND :sk2")
    expect(call.ExpressionAttributeValues[":sk1"].S).toBe(
      DynamoSchema.composeEventVersionKey(AppSchema, `${label}.event`, floorVersion + 1),
    )
    expect(call.ExpressionAttributeValues[":sk2"].S).toBe(
      DynamoSchema.composeEventVersionKey(
        AppSchema,
        `${label}.event`,
        DynamoSchema.MAX_EVENT_VERSION,
      ),
    )
  }
  const snapshotKey = {
    pk: "$cricket#v1#unverified#m-1",
    sk: DynamoSchema.composeKey(AppSchema, "unverified.snapshot", []),
  }
  /** A stored snapshot at `asOfVersion` with `innings` completed innings. */
  const snapshotAt = (asOfVersion: number, innings: number) =>
    makeSnapshotItem(label, "m-1", asOfVersion, {
      status: "i",
      innings: Array.from({ length: innings }, (_, i) => `${i + 1}/${i + 1}`),
    })
  const inningsItem = (version: number) =>
    makeStreamEventItem(label, "m-1", version, "InningsCompleted", {
      innings: version,
      runs: version,
      wickets: version,
    })
  /** Answer snapshot-key `GetItem`s with `item`; any other key finds nothing. */
  const snapshotGetItem = (item: ReturnType<typeof makeSnapshotItem> | undefined) =>
    mockGetItem.mockImplementation(async (input: any) =>
      fromAttributeMap(input.Key).sk === snapshotKey.sk && item !== undefined ? { Item: item } : {},
    )
  const conflict = {
    name: "TransactionCanceledException",
    CancellationReasons: [{ Code: "ConditionalCheckFailed" }],
  }
  const command: MatchCommand = { _tag: "CompleteInnings", innings: 9, runs: 9, wickets: 9 }
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
  /** The `asOfVersion` / event versions of a recorded transaction. */
  const transactShape = (call: { TransactItems: ReadonlyArray<any> }) =>
    call.TransactItems.filter((i) => i.Put !== undefined).map((i) => {
      const item = fromAttributeMap(i.Put.Item)
      return item.__edd_e__ === `${label}.snapshot`
        ? `snapshot@${String(item.asOfVersion)}`
        : `event@${String(item.version)}`
    })

  describe("readLatest", () => {
    it.effect("reads the snapshot item alone with one GetItem and trusts its version", () =>
      Effect.gen(function* () {
        snapshotGetItem(snapshotAt(4, 2))

        const latest = yield* Inline.readLatest({ matchId: "m-1" }, { verifySnapshot: false })

        expect(mockQuery).not.toHaveBeenCalled()
        expect(mockGetItem).toHaveBeenCalledOnce()
        const call = mockGetItem.mock.calls[0]![0]
        expect(call.TableName).toBe("events-table")
        expect(fromAttributeMap(call.Key)).toEqual(snapshotKey)
        // Eventually consistent unless asked, as the verified read is.
        expect(call.ConsistentRead).toBeUndefined()
        expect(latest.events).toEqual([])
        expect(latest.version).toBe(4)
        expect(Option.getOrThrow(latest.snapshot).state).toEqual({
          status: "in-progress",
          innings: [
            { runs: 1, wickets: 1 },
            { runs: 2, wickets: 2 },
          ],
        })
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("honours consistentRead on the GetItem", () =>
      Effect.gen(function* () {
        snapshotGetItem(snapshotAt(1, 0))
        yield* Inline.readLatest(
          { matchId: "m-1" },
          { verifySnapshot: false, consistentRead: true },
        )
        expect(mockGetItem.mock.calls[0]![0].ConsistentRead).toBe(true)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("falls back to the verified read when there is no snapshot item", () =>
      Effect.gen(function* () {
        snapshotGetItem(undefined)
        mockQuery.mockResolvedValue({ Items: [inningsItem(2), inningsItem(1)] })

        const latest = yield* Inline.readLatest({ matchId: "m-1" }, { verifySnapshot: false })

        expect(mockGetItem).toHaveBeenCalledOnce()
        expect(mockQuery).toHaveBeenCalledOnce()
        expect(mockQuery.mock.calls[0]![0].KeyConditionExpression).toBe(
          "#pk = :pk AND #sk BETWEEN :first AND :snapshot",
        )
        expect(Option.isNone(latest.snapshot)).toBe(true)
        expect(latest.events.map((e) => e.version)).toEqual([1, 2])
        expect(latest.version).toBe(2)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("fails with ValidationError when the snapshot does not decode", () =>
      Effect.gen(function* () {
        snapshotGetItem(makeSnapshotItem(label, "m-1", 2, { status: "nope", innings: [] }))
        const error = yield* Inline.readLatest({ matchId: "m-1" }, { verifySnapshot: false }).pipe(
          Effect.flip,
        )
        expect(error._tag).toBe("ValidationError")
        expect((error as ValidationError).operation).toBe("EventStore.readLatest")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("verifySnapshot: true is the verified Query", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue(latestPage(snapshotAt(1, 0)))
        yield* Inline.readLatest({ matchId: "m-1" }, { verifySnapshot: true })
        expect(mockQuery).toHaveBeenCalledOnce()
        expect(mockGetItem).not.toHaveBeenCalled()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("dies with EDD-9068 unless the stream is inline without `every`", () =>
      Effect.gen(function* () {
        for (const stream of [InlineEvery, AfterAppend] as const) {
          const exit = yield* stream
            .readLatest({ matchId: "m-1" }, { verifySnapshot: false })
            .pipe(Effect.exit)
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) {
            expect(Cause.hasDies(exit.cause)).toBe(true)
            expect(String(Cause.squash(exit.cause))).toMatch(/EDD-9068/)
          }
        }
        expect(mockGetItem).not.toHaveBeenCalled()
        expect(mockQuery).not.toHaveBeenCalled()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("is ignored on a stream without a snapshot config", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue({ Items: [] })
        const latest = yield* MatchEvents.readLatest({ matchId: "m-1" }, { verifySnapshot: false })
        expect(latest.version).toBe(0)
        expect(mockGetItem).not.toHaveBeenCalled()
        expect(mockQuery.mock.calls[0]![0].KeyConditionExpression).toContain("begins_with")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("a bound stream forwards the option", () =>
      Effect.gen(function* () {
        snapshotGetItem(snapshotAt(3, 1))
        const bound = yield* EventStore.bind(Inline)
        const latest = yield* bound.readLatest({ matchId: "m-1" }, { verifySnapshot: false })
        expect(latest.version).toBe(3)
        expect(mockQuery).not.toHaveBeenCalled()
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  describe("commandHandler", () => {
    it.effect("loads with exactly one strongly consistent GetItem on the happy path", () =>
      Effect.gen(function* () {
        snapshotGetItem(snapshotAt(4, 2))
        mockTransactWriteItems.mockResolvedValue({})
        const { decide, decider } = spied()

        const result = yield* EventStore.commandHandler(decider, Inline, {
          verifySnapshot: false,
        })({ matchId: "m-1" }, command)

        expect(mockGetItem).toHaveBeenCalledOnce()
        const call = mockGetItem.mock.calls[0]![0]
        expect(fromAttributeMap(call.Key)).toEqual(snapshotKey)
        expect(call.ConsistentRead).toBe(true)
        expect(mockQuery).not.toHaveBeenCalled()
        expect(decide).toHaveBeenCalledOnce()
        expect(mockTransactWriteItems).toHaveBeenCalledOnce()
        expect(transactShape(mockTransactWriteItems.mock.calls[0]![0])).toEqual([
          "event@5",
          "snapshot@5",
        ])
        expect(result.version).toBe(5)
        expect(result.state.innings).toHaveLength(3)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("consistentRead: false makes the GetItem eventually consistent", () =>
      Effect.gen(function* () {
        snapshotGetItem(snapshotAt(1, 0))
        mockTransactWriteItems.mockResolvedValue({})
        yield* EventStore.commandHandler(matchDecider, Inline, {
          verifySnapshot: false,
          consistentRead: false,
        })({ matchId: "m-1" }, command)
        expect(mockGetItem.mock.calls[0]![0].ConsistentRead).toBeUndefined()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("a missing snapshot falls back to the verified load at once; decide runs once", () =>
      Effect.gen(function* () {
        snapshotGetItem(undefined)
        mockQuery.mockResolvedValue({
          Items: [
            inningsItem(2),
            makeStreamEventItem(label, "m-1", 1, "MatchStarted", {
              venue: "MCG",
              homeTeam: "AUS",
              awayTeam: "ENG",
            }),
          ],
        })
        mockTransactWriteItems.mockResolvedValue({})
        const { decide, decider } = spied()

        const result = yield* EventStore.commandHandler(decider, Inline, {
          verifySnapshot: false,
        })({ matchId: "m-1" }, command)

        expect(mockGetItem).toHaveBeenCalledOnce()
        expect(mockQuery).toHaveBeenCalledOnce()
        expect(mockQuery.mock.calls[0]![0].ConsistentRead).toBe(true)
        expect(decide).toHaveBeenCalledOnce()
        expect(transactShape(mockTransactWriteItems.mock.calls[0]![0])).toEqual([
          "event@3",
          "snapshot@3",
        ])
        expect(result.version).toBe(3)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect(
      "a stale snapshot is re-read verified and decided on again, without a retry policy",
      () =>
        Effect.gen(function* () {
          // The snapshot is at v4, but events 5 and 6 were appended without one.
          snapshotGetItem(snapshotAt(4, 2))
          mockQuery.mockResolvedValue(
            latestPage(snapshotAt(4, 2), [inningsItem(5), inningsItem(6)]),
          )
          mockTransactWriteItems.mockRejectedValueOnce(conflict).mockResolvedValue({})
          const { decide, decider } = spied()

          const result = yield* EventStore.commandHandler(decider, Inline, {
            verifySnapshot: false,
          })({ matchId: "m-1" }, command)

          // One unverified load, one verified load, two decisions, two appends.
          expect(mockGetItem).toHaveBeenCalledOnce()
          expect(mockQuery).toHaveBeenCalledOnce()
          expect(mockQuery.mock.calls[0]![0].ConsistentRead).toBe(true)
          expect(decide).toHaveBeenCalledTimes(2)
          expect(decide.mock.calls[0]![1].innings).toHaveLength(2)
          expect(decide.mock.calls[1]![1].innings).toHaveLength(4)
          expect(transactShape(mockTransactWriteItems.mock.calls[0]![0])).toEqual([
            "event@5",
            "snapshot@5",
          ])
          expect(transactShape(mockTransactWriteItems.mock.calls[1]![0])).toEqual([
            "event@7",
            "snapshot@7",
          ])
          expect(result.version).toBe(7)
          expect(result.state.innings).toHaveLength(5)
        }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("re-evaluates a function-form additionalItems on the re-decision", () =>
      Effect.gen(function* () {
        snapshotGetItem(snapshotAt(4, 2))
        mockQuery.mockResolvedValue(latestPage(snapshotAt(4, 2), [inningsItem(5)]))
        mockTransactWriteItems.mockRejectedValueOnce(conflict).mockResolvedValue({})
        const versions: Array<number> = []

        yield* EventStore.commandHandler(matchDecider, Inline, { verifySnapshot: false })(
          { matchId: "m-1" },
          command,
          {
            additionalItems: ({ version }) => {
              versions.push(version)
              return []
            },
          },
        )

        expect(versions).toEqual([4, 5])
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("a snapshot at the head after a conflict is a genuine race: surfaced", () =>
      Effect.gen(function* () {
        snapshotGetItem(snapshotAt(4, 2))
        // A concurrent handler appended v5 and its inline snapshot.
        mockQuery.mockResolvedValue(latestPage(snapshotAt(5, 3)))
        mockTransactWriteItems.mockRejectedValue(conflict)
        const { decide, decider } = spied()

        const error = yield* EventStore.commandHandler(decider, Inline, {
          verifySnapshot: false,
        })({ matchId: "m-1" }, command).pipe(Effect.flip)

        expect(error._tag).toBe("VersionConflict")
        expect((error as VersionConflict).actualVersion).toBeUndefined()
        expect(decide).toHaveBeenCalledOnce()
        expect(mockTransactWriteItems).toHaveBeenCalledOnce()
        expect(mockQuery).toHaveBeenCalledOnce()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("a genuine race goes to the retry policy, which reloads unverified", () =>
      Effect.gen(function* () {
        mockGetItem
          .mockResolvedValueOnce({ Item: snapshotAt(4, 2) })
          .mockResolvedValue({ Item: snapshotAt(5, 3) })
        mockQuery.mockResolvedValue(latestPage(snapshotAt(5, 3)))
        mockTransactWriteItems.mockRejectedValueOnce(conflict).mockResolvedValue({})
        const { decide, decider } = spied()

        const result = yield* EventStore.commandHandler(decider, Inline, {
          verifySnapshot: false,
          retry: 1,
        })({ matchId: "m-1" }, command)

        expect(mockGetItem).toHaveBeenCalledTimes(2)
        expect(mockQuery).toHaveBeenCalledOnce()
        expect(decide).toHaveBeenCalledTimes(2)
        expect(transactShape(mockTransactWriteItems.mock.calls[1]![0])).toEqual([
          "event@6",
          "snapshot@6",
        ])
        expect(result.version).toBe(6)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("the re-decision happens once; its own conflict follows the policy", () =>
      Effect.gen(function* () {
        snapshotGetItem(snapshotAt(4, 2))
        mockQuery.mockResolvedValue(latestPage(snapshotAt(4, 2), [inningsItem(5)]))
        mockTransactWriteItems.mockRejectedValue(conflict)
        const { decide, decider } = spied()

        const error = yield* EventStore.commandHandler(decider, Inline, {
          verifySnapshot: false,
        })({ matchId: "m-1" }, command).pipe(Effect.flip)

        expect(error._tag).toBe("VersionConflict")
        expect(decide).toHaveBeenCalledTimes(2)
        expect(mockTransactWriteItems).toHaveBeenCalledTimes(2)
        expect(mockQuery).toHaveBeenCalledOnce()
      }).pipe(Effect.provide(TestLayer)),
    )

    describe("a decision that appends nothing is confirmed against the head", () => {
      /** A snapshot of a match not yet started, and the start the snapshot missed. */
      const pendingAt = (asOfVersion: number) =>
        makeSnapshotItem(label, "m-1", asOfVersion, { status: "p", innings: [] })
      const startedItem = (version: number) =>
        makeStreamEventItem(label, "m-1", version, "MatchStarted", {
          venue: "MCG",
          homeTeam: "AUS",
          awayTeam: "ENG",
        })
      /** `EndMatch` on a match that is not in progress is a no-op, not an error. */
      const spiedNoop = () => {
        const decide = vi.fn((command: MatchCommand, state: MatchState) =>
          command._tag === "EndMatch" && state.status !== "in-progress"
            ? Effect.succeed([] as ReadonlyArray<MatchEvent>)
            : matchDecider.decide(command, state),
        )
        const decider: EventStore.Decider<
          MatchState,
          MatchCommand,
          MatchEvent,
          AlreadyStarted | NotStarted
        > = { ...matchDecider, decide }
        return { decide, decider }
      }
      const endMatch: MatchCommand = { _tag: "EndMatch", result: "drawn" }

      it.effect("a domain error is returned once the head is at the snapshot", () =>
        Effect.gen(function* () {
          snapshotGetItem(snapshotAt(4, 2))
          // Nothing above v4: the head check reads no items.
          mockQuery.mockResolvedValue({ Items: [] })
          const { decide, decider } = spied()
          const error = yield* EventStore.commandHandler(decider, Inline, {
            verifySnapshot: false,
          })(
            { matchId: "m-1" },
            { _tag: "StartMatch", venue: "x", homeTeam: "a", awayTeam: "b" },
          ).pipe(Effect.flip)
          expect(error._tag).toBe("AlreadyStarted")
          expect(decide).toHaveBeenCalledOnce()
          expect(mockQuery).toHaveBeenCalledOnce()
          expectHeadAbove(mockQuery.mock.calls[0]![0], 4)
          expect(mockTransactWriteItems).not.toHaveBeenCalled()
        }).pipe(Effect.provide(TestLayer)),
      )

      it.effect("a domain error on a lagging snapshot is decided again on the verified state", () =>
        Effect.gen(function* () {
          // The snapshot (v1) says not started; the start (v2) was appended raw.
          snapshotGetItem(pendingAt(1))
          mockQuery
            .mockResolvedValueOnce({ Items: [startedItem(2)] })
            .mockResolvedValueOnce(latestPage(pendingAt(1), [startedItem(2)]))
          mockTransactWriteItems.mockResolvedValue({})
          const { decide, decider } = spied()

          const result = yield* EventStore.commandHandler(decider, Inline, {
            verifySnapshot: false,
          })({ matchId: "m-1" }, command)

          expect(decide).toHaveBeenCalledTimes(2)
          expect(decide.mock.calls[0]![1].status).toBe("pending")
          expect(decide.mock.calls[1]![1].status).toBe("in-progress")
          // The head check, then the verified load.
          expect(mockQuery).toHaveBeenCalledTimes(2)
          expectHeadAbove(mockQuery.mock.calls[0]![0], 1)
          expect(mockTransactWriteItems).toHaveBeenCalledOnce()
          expect(transactShape(mockTransactWriteItems.mock.calls[0]![0])).toEqual([
            "event@3",
            "snapshot@3",
          ])
          expect(result.version).toBe(3)
        }).pipe(Effect.provide(TestLayer)),
      )

      it.effect("a no-op is returned once the head is at the snapshot", () =>
        Effect.gen(function* () {
          snapshotGetItem(pendingAt(1))
          mockQuery.mockResolvedValue({ Items: [] })
          const { decide, decider } = spiedNoop()

          const result = yield* EventStore.commandHandler(decider, Inline, {
            verifySnapshot: false,
          })({ matchId: "m-1" }, endMatch)

          expect(result).toEqual({
            state: { status: "pending", innings: [] },
            version: 1,
            events: [],
          })
          expect(decide).toHaveBeenCalledOnce()
          expect(mockQuery).toHaveBeenCalledOnce()
          expectHeadAbove(mockQuery.mock.calls[0]![0], 1)
          expect(mockTransactWriteItems).not.toHaveBeenCalled()
        }).pipe(Effect.provide(TestLayer)),
      )

      it.effect("a no-op on a lagging snapshot is decided again on the verified state", () =>
        Effect.gen(function* () {
          snapshotGetItem(pendingAt(1))
          mockQuery
            .mockResolvedValueOnce({ Items: [startedItem(2)] })
            .mockResolvedValueOnce(latestPage(pendingAt(1), [startedItem(2)]))
          mockTransactWriteItems.mockResolvedValue({})
          const { decide, decider } = spiedNoop()

          const result = yield* EventStore.commandHandler(decider, Inline, {
            verifySnapshot: false,
          })({ matchId: "m-1" }, endMatch)

          expect(decide).toHaveBeenCalledTimes(2)
          expect(transactShape(mockTransactWriteItems.mock.calls[0]![0])).toEqual([
            "event@3",
            "snapshot@3",
          ])
          expect(result.version).toBe(3)
          expect(result.state.status).toBe("completed")
        }).pipe(Effect.provide(TestLayer)),
      )

      it.effect("a function-form additionalItems is not evaluated for a no-op", () =>
        Effect.gen(function* () {
          snapshotGetItem(pendingAt(1))
          mockQuery
            .mockResolvedValueOnce({ Items: [startedItem(2)] })
            .mockResolvedValueOnce(latestPage(pendingAt(1), [startedItem(2)]))
          mockTransactWriteItems.mockResolvedValue({})
          const versions: Array<number> = []

          yield* EventStore.commandHandler(spiedNoop().decider, Inline, {
            verifySnapshot: false,
          })({ matchId: "m-1" }, endMatch, {
            additionalItems: ({ version }) => {
              versions.push(version)
              return []
            },
          })

          // Only the re-decision appended, so only it derived items.
          expect(versions).toEqual([2])
        }).pipe(Effect.provide(TestLayer)),
      )
    })

    describe("with expectedVersion", () => {
      it.effect("a snapshot at the expected version is decided on without a verified read", () =>
        Effect.gen(function* () {
          snapshotGetItem(snapshotAt(4, 2))
          mockTransactWriteItems.mockResolvedValue({})
          const result = yield* EventStore.commandHandler(matchDecider, Inline, {
            verifySnapshot: false,
          })({ matchId: "m-1" }, command, { expectedVersion: 4 })
          expect(mockQuery).not.toHaveBeenCalled()
          expect(result.version).toBe(5)
        }).pipe(Effect.provide(TestLayer)),
      )

      it.effect(
        "its append-time conflict reports the head as actualVersion, never re-decided or retried",
        () =>
          Effect.gen(function* () {
            // The If-Match equals the snapshot's v4, but v5 was appended raw.
            snapshotGetItem(snapshotAt(4, 2))
            mockTransactWriteItems.mockRejectedValue(conflict)
            mockQuery.mockResolvedValue({ Items: [inningsItem(5)] })
            const { decide, decider } = spied()

            const error = yield* EventStore.commandHandler(decider, Inline, {
              verifySnapshot: false,
              retry: 5,
            })({ matchId: "m-1" }, command, { expectedVersion: 4 }).pipe(Effect.flip)

            expect(error._tag).toBe("VersionConflict")
            expect((error as VersionConflict).actualVersion).toBe(5)
            expect(decide).toHaveBeenCalledOnce()
            expect(mockTransactWriteItems).toHaveBeenCalledOnce()
            // One head check above the If-Match, no verified load.
            expect(mockQuery).toHaveBeenCalledOnce()
            expectHeadAbove(mockQuery.mock.calls[0]![0], 4)
          }).pipe(Effect.provide(TestLayer)),
      )

      it.effect("a domain error or no-op at a lagging If-Match is a VersionConflict", () =>
        Effect.gen(function* () {
          snapshotGetItem(makeSnapshotItem(label, "m-1", 1, { status: "p", innings: [] }))
          mockQuery.mockResolvedValue({ Items: [inningsItem(2)] })
          const handle = EventStore.commandHandler(matchDecider, Inline, {
            verifySnapshot: false,
          })
          const noopHandle = EventStore.commandHandler(
            {
              ...matchDecider,
              decide: (c: MatchCommand, state: MatchState) =>
                c._tag === "EndMatch" ? Effect.succeed([]) : matchDecider.decide(c, state),
            },
            Inline,
            { verifySnapshot: false },
          )

          // `NotStarted` against the snapshot — but the stream has moved past v1.
          const failed = yield* handle({ matchId: "m-1" }, command, { expectedVersion: 1 }).pipe(
            Effect.flip,
          )
          expect(failed).toMatchObject({
            _tag: "VersionConflict",
            expectedVersion: 1,
            actualVersion: 2,
          })

          const noop = yield* noopHandle(
            { matchId: "m-1" },
            { _tag: "EndMatch", result: "drawn" },
            { expectedVersion: 1 },
          ).pipe(Effect.flip)
          expect(noop).toMatchObject({
            _tag: "VersionConflict",
            expectedVersion: 1,
            actualVersion: 2,
          })
          expect(mockTransactWriteItems).not.toHaveBeenCalled()
          expect(mockQuery).toHaveBeenCalledTimes(2)
        }).pipe(Effect.provide(TestLayer)),
      )

      it.effect("a domain error at an If-Match the head confirms is returned", () =>
        Effect.gen(function* () {
          snapshotGetItem(makeSnapshotItem(label, "m-1", 1, { status: "p", innings: [] }))
          mockQuery.mockResolvedValue({ Items: [] })
          const error = yield* EventStore.commandHandler(matchDecider, Inline, {
            verifySnapshot: false,
          })({ matchId: "m-1" }, command, { expectedVersion: 1 }).pipe(Effect.flip)
          expect(error._tag).toBe("NotStarted")
          expect(mockQuery).toHaveBeenCalledOnce()
          expectHeadAbove(mockQuery.mock.calls[0]![0], 1)
        }).pipe(Effect.provide(TestLayer)),
      )

      it.effect("a no-op redelivery at a lagging If-Match is a DuplicateCommand", () =>
        Effect.gen(function* () {
          mockGetItem.mockImplementation(async (input: any) => ({
            Item:
              fromAttributeMap(input.Key).sk === snapshotKey.sk
                ? makeSnapshotItem(label, "m-1", 1, { status: "p", innings: [] })
                : toAttributeMap({ pk: "x" }),
          }))
          mockQuery.mockResolvedValue({ Items: [inningsItem(2)] })

          const error = yield* EventStore.commandHandler(
            {
              ...matchDecider,
              decide: (c: MatchCommand, state: MatchState) =>
                c._tag === "EndMatch" ? Effect.succeed([]) : matchDecider.decide(c, state),
            },
            Inline,
            { verifySnapshot: false, idempotency: {} },
          )(
            { matchId: "m-1" },
            { _tag: "EndMatch", result: "drawn" },
            { commandId: "cmd-1", expectedVersion: 1 },
          ).pipe(Effect.flip)

          expect(error._tag).toBe("DuplicateCommand")
          expect(fromAttributeMap(mockGetItem.mock.calls[1]![0].Key).sk).toBe(
            "$cricket#v1#unverified.command#cmd-1",
          )
        }).pipe(Effect.provide(TestLayer)),
      )

      it.effect("a lagging snapshot is re-read verified before the If-Match check", () =>
        Effect.gen(function* () {
          // The caller saw v6; the snapshot lags at v4.
          snapshotGetItem(snapshotAt(4, 2))
          mockQuery.mockResolvedValue(
            latestPage(snapshotAt(4, 2), [inningsItem(5), inningsItem(6)]),
          )
          mockTransactWriteItems.mockResolvedValue({})
          const { decide, decider } = spied()

          const result = yield* EventStore.commandHandler(decider, Inline, {
            verifySnapshot: false,
          })({ matchId: "m-1" }, command, { expectedVersion: 6 })

          expect(mockQuery).toHaveBeenCalledOnce()
          expect(decide).toHaveBeenCalledOnce()
          expect(decide.mock.calls[0]![1].innings).toHaveLength(4)
          expect(result.version).toBe(7)
        }).pipe(Effect.provide(TestLayer)),
      )

      it.effect("a genuine mismatch reports the verified head as actualVersion", () =>
        Effect.gen(function* () {
          snapshotGetItem(snapshotAt(4, 2))
          mockQuery.mockResolvedValue(
            latestPage(snapshotAt(4, 2), [inningsItem(5), inningsItem(6)]),
          )
          const { decide, decider } = spied()

          const error = yield* EventStore.commandHandler(decider, Inline, {
            verifySnapshot: false,
          })({ matchId: "m-1" }, command, { expectedVersion: 3 }).pipe(Effect.flip)

          expect(error._tag).toBe("VersionConflict")
          expect((error as VersionConflict).actualVersion).toBe(6)
          expect(decide).not.toHaveBeenCalled()
          expect(mockTransactWriteItems).not.toHaveBeenCalled()
        }).pipe(Effect.provide(TestLayer)),
      )

      it.effect("an idempotent redelivery is still a DuplicateCommand", () =>
        Effect.gen(function* () {
          mockGetItem.mockImplementation(async (input: any) => ({
            Item:
              fromAttributeMap(input.Key).sk === snapshotKey.sk
                ? snapshotAt(5, 3)
                : toAttributeMap({ pk: "x" }),
          }))
          mockQuery.mockResolvedValue(latestPage(snapshotAt(5, 3)))

          const error = yield* EventStore.commandHandler(matchDecider, Inline, {
            verifySnapshot: false,
            idempotency: {},
          })({ matchId: "m-1" }, command, { commandId: "cmd-1", expectedVersion: 4 }).pipe(
            Effect.flip,
          )

          expect(error._tag).toBe("DuplicateCommand")
          // Snapshot GetItem, verified Query, then the sentinel probe.
          expect(mockGetItem).toHaveBeenCalledTimes(2)
          expect(fromAttributeMap(mockGetItem.mock.calls[1]![0].Key).sk).toBe(
            "$cricket#v1#unverified.command#cmd-1",
          )
          expect(mockQuery).toHaveBeenCalledOnce()
        }).pipe(Effect.provide(TestLayer)),
      )
    })

    describe("EDD-9068", () => {
      it.effect("refuses every form unless the stream is inline without `every`", () =>
        Effect.gen(function* () {
          const bound = yield* EventStore.bind(InlineEvery)
          const boundAfter = yield* EventStore.bind(AfterAppend)
          const options = { verifySnapshot: false } as const
          expect(() => EventStore.commandHandler(matchDecider, InlineEvery, options)).toThrow(
            /EDD-9068.*"inline" without "every".*mode "inline" with every: 5/,
          )
          expect(() => EventStore.commandHandler(matchDecider, AfterAppend, options)).toThrow(
            /EDD-9068.*mode "after-append" with every: 5/,
          )
          expect(() => EventStore.commandHandler(matchDecider, bound, options)).toThrow(/EDD-9068/)
          expect(() => InlineEvery.pipe(EventStore.commandHandler(matchDecider, options))).toThrow(
            /EDD-9068/,
          )
          expect(() => boundAfter.pipe(EventStore.commandHandler(matchDecider, options))).toThrow(
            /EDD-9068/,
          )
          // `true` (or omitted) is accepted everywhere.
          EventStore.commandHandler(matchDecider, InlineEvery, { verifySnapshot: true })
          AfterAppend.pipe(EventStore.commandHandler(matchDecider))
        }).pipe(Effect.provide(TestLayer)),
      )

      it.effect("accepts the inline stream in every form", () =>
        Effect.gen(function* () {
          const bound = yield* EventStore.bind(Inline)
          snapshotGetItem(snapshotAt(4, 2))
          mockTransactWriteItems.mockResolvedValue({})
          const handlers = [
            EventStore.commandHandler(matchDecider, bound, { verifySnapshot: false }),
            bound.pipe(EventStore.commandHandler(matchDecider, { verifySnapshot: false })),
          ]
          for (const handle of handlers) yield* handle({ matchId: "m-1" }, command)
          yield* Inline.pipe(EventStore.commandHandler(matchDecider, { verifySnapshot: false }))(
            { matchId: "m-1" },
            command,
          )
          expect(mockQuery).not.toHaveBeenCalled()
          expect(mockGetItem).toHaveBeenCalledTimes(3)
        }).pipe(Effect.provide(TestLayer)),
      )

      it.effect("is ignored on a stream without a snapshot config", () =>
        Effect.gen(function* () {
          mockQuery.mockResolvedValue({ Items: [] })
          mockTransactWriteItems.mockResolvedValue({})
          const result = yield* EventStore.commandHandler(matchDecider, MatchEvents, {
            verifySnapshot: false,
          })({ matchId: "m-1" }, { _tag: "StartMatch", venue: "x", homeTeam: "a", awayTeam: "b" })
          expect(result.version).toBe(1)
          expect(mockGetItem).not.toHaveBeenCalled()
          expect(mockQuery).toHaveBeenCalledOnce()
          expect(mockQuery.mock.calls[0]![0].ConsistentRead).toBe(true)
        }).pipe(Effect.provide(TestLayer)),
      )
    })
  })
})

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
        byInnings: { type: "lsi", index: "lsi1", pk: "pk", sk: "lsi1sk", projection: "all" },
        byResult: { type: "gsi", index: "gsi1", pk: "gsi1pk", sk: "gsi1sk", projection: "all" },
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

    it.effect("the index attributes count in a diagnosed 4 MB rejection", () =>
      Effect.gen(function* () {
        mockTransactWriteItems.mockRejectedValueOnce(
          awsValidationException(ddbPayloadTooLarge(4_300_000)),
        )
        const big = (version: number) => `K${pad(version)}${"x".repeat(995)}`
        const Heavy = EventStore.makeStream({
          table: EventsTable,
          streamName: "Heavy",
          events: [MatchEnded],
          streamId: { composite: ["matchId"] },
          indexes: { byKey: { index: "lsi1", sk: "lsi1sk", key: (_, version) => big(version) } },
        })
        const error = yield* Heavy.append(
          { matchId: "m-1" },
          Array.from({ length: 3 }, () => new MatchEnded({ result: "r" })),
          0,
        ).pipe(Effect.flip)
        expect(error._tag).toBe("ValidationError")
        const text = String((error as ValidationError).cause)
        expect(text).toContain("4 MB")
        // Each event carries its 1000-byte index key: over 1000 bytes each.
        const sizes = [...text.matchAll(/the event at version \d, at [^(]*\((\d+) bytes\)/g)].map(
          (match) => Number(match[1]),
        )
        expect(sizes).toHaveLength(3)
        for (const size of sizes) expect(size).toBeGreaterThan(1000)
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
        // Nothing is sent for any of these: the caller's own invariant.
        expect(mockTransactWriteItems).not.toHaveBeenCalled()
        // Length is DynamoDB's to judge (#144): a long key is sent.
        mockTransactWriteItems.mockResolvedValue({})
        yield* withKey(() => "x".repeat(1025)).append({ matchId: "m-1" }, [started()], 0)
        expect(mockTransactWriteItems).toHaveBeenCalledOnce()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect(
      "a key over 1024 bytes is diagnosed from DynamoDB's rejection, naming index and event",
      () =>
        Effect.gen(function* () {
          const Keyed = EventStore.makeStream({
            table: EventsTable,
            streamName: "KeyCheck",
            events: [MatchStarted],
            streamId: { composite: ["matchId"] },
            indexes: { byKey: { index: "lsi1", sk: "lsi1sk", key: () => "é".repeat(513) } },
          })
          for (const message of [DDB_SORT_KEY_LOCAL, DDB_SORT_KEY_AWS]) {
            const rejection = awsValidationException(message)
            mockTransactWriteItems.mockRejectedValueOnce(rejection)
            const error = yield* Keyed.append({ matchId: "m-1" }, [started()], 0).pipe(Effect.flip)
            expect(error._tag).toBe("ValidationError")
            const failure = error as ValidationError
            expect(failure.operation).toBe("EventStore.append.indexes")
            expect(String(failure.cause)).toContain(
              'The key of index "byKey" for the event at version 1 is 1026 bytes',
            )
            expect(String(failure.cause)).toContain("1024-byte limit")
            expect(((failure.cause as Error).cause as { cause: unknown }).cause).toBe(rejection)
          }
        }).pipe(Effect.provide(TestLayer)),
    )

    it.effect(
      "an additional item's over-long key on a stream index's attribute names the item, not the index",
      () =>
        Effect.gen(function* () {
          const Indexed = EventStore.makeStream({
            table: EventsTable,
            streamName: "KeyCheck",
            events: [MatchStarted],
            streamId: { composite: ["matchId"] },
            indexes: {
              byKey: { type: "gsi", index: "gsi1", pk: "gsi1pk", sk: "gsi1sk", key: () => "k" },
            },
          })
          const rejection = awsValidationException(DDB_SORT_KEY_LOCAL)
          mockTransactWriteItems.mockRejectedValueOnce(rejection)
          const error = yield* Indexed.append({ matchId: "m-1" }, [started()], 0, {
            additionalItems: [Labels.put({ labelId: "l-1", text: "t".repeat(1100) })],
          }).pipe(Effect.flip)
          expect(error._tag).toBe("ValidationError")
          const failure = error as ValidationError
          expect(failure.operation).toBe("EventStore.append")
          expect(failure.entityType).toBe("Label")
          const text = String(failure.cause)
          expect(text).not.toContain('index "byKey"')
          expect(text).toContain('the sort key "gsi1sk" of operation 0 (Label)')
          expect(((failure.cause as Error).cause as { cause: unknown }).cause).toBe(rejection)
        }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("a sort-key rejection with every key within 1024 bytes passes through", () =>
      Effect.gen(function* () {
        const Keyed = EventStore.makeStream({
          table: EventsTable,
          streamName: "KeyCheck",
          events: [MatchStarted],
          streamId: { composite: ["matchId"] },
          indexes: { byKey: { index: "lsi1", sk: "lsi1sk", key: () => "é".repeat(512) } },
        })
        const rejection = awsValidationException(DDB_SORT_KEY_LOCAL)
        mockTransactWriteItems.mockRejectedValueOnce(rejection)
        const error = yield* Keyed.append({ matchId: "m-1" }, [started()], 0).pipe(Effect.flip)
        expect(error._tag).toBe("DynamoError")
        expect((error as { cause: unknown }).cause).toBe(rejection)
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

describe("EventStore stream index projection", () => {
  const pad = (n: number) => String(n).padStart(4, "0")
  const pk = "$cricket#v1#projmatch#m-1"
  const entityType = "projmatch.event"
  const vkey = (_event: unknown, version: number) => `V#${pad(version)}`

  const ProjMeta = Schema.Struct({ eventId: Schema.String })

  /** One index per index type x projection. */
  const ProjMatch = EventStore.makeStream({
    table: EventsTable,
    streamName: "ProjMatch",
    events: [MatchStarted, InningsCompleted, MatchEnded],
    streamId: { composite: ["matchId"] },
    metadata: ProjMeta,
    indexes: {
      fullLsi: { index: "lsi1", sk: "lsi1sk", key: vkey },
      slimLsi: { index: "lsi2", sk: "lsi2sk", projection: "withoutMetadata", key: vkey },
      keysLsi: { index: "lsi3", sk: "lsi3sk", projection: "keys", key: vkey },
      slimGsi: {
        type: "gsi",
        index: "gsi1",
        pk: "gsi1pk",
        sk: "gsi1sk",
        projection: "withoutMetadata",
        key: vkey,
      },
      keysGsi: {
        type: "gsi",
        index: "gsi2",
        pk: "gsi2pk",
        sk: "gsi2sk",
        projection: "keys",
        key: vkey,
      },
    },
  })

  const sk = (version: number) =>
    DynamoSchema.composeEventVersionKey(AppSchema, "projmatch.event", version)

  /** A full event item, as the table holds it. */
  const fullItem = (version: number, extra: Record<string, unknown> = {}) => ({
    pk,
    sk: sk(version),
    __edd_e__: entityType,
    streamId: "m-1",
    version,
    eventType: "InningsCompleted",
    data: { _tag: "InningsCompleted", innings: version, runs: 100 + version, wickets: 1 },
    timestamp: "2026-03-08T12:00:00.000Z",
    metadata: { eventId: `evt-${version}` },
    gsi2pk: pk,
    gsi2sk: `V#${pad(version)}`,
    ...extra,
  })

  /** What a "keys" GSI row carries: table key, index key, `__edd_e__`. */
  const keysRow = (version: number) =>
    toAttributeMap({
      pk,
      sk: sk(version),
      gsi2pk: pk,
      gsi2sk: `V#${pad(version)}`,
      __edd_e__: entityType,
    })

  /**
   * Answer `BatchGetItem` from `store` (by `sk`), in reverse order of the
   * request — DynamoDB does not preserve order. Keys whose `sk` is in
   * `unprocessed` are returned as `UnprocessedKeys` (once each).
   */
  const answerFrom =
    (store: Map<string, Record<string, unknown>>, unprocessed: Set<string> = new Set()) =>
    async (input: { RequestItems: Record<string, { Keys: Array<any> }> }) => {
      const Responses: Record<string, Array<any>> = {}
      const UnprocessedKeys: Record<string, { Keys: Array<any> }> = {}
      for (const [table, request] of Object.entries(input.RequestItems)) {
        Responses[table] = []
        for (const key of request.Keys) {
          const keySk = fromAttributeMap(key).sk as string
          if (unprocessed.delete(keySk)) {
            UnprocessedKeys[table] ??= { Keys: [] }
            UnprocessedKeys[table]!.Keys.push(key)
            continue
          }
          const item = store.get(keySk)
          if (item !== undefined) Responses[table]!.push(toAttributeMap(item))
        }
        Responses[table]!.reverse()
      }
      return { Responses, UnprocessedKeys }
    }

  const storeOf = (versions: ReadonlyArray<number>) =>
    new Map(versions.map((v) => [sk(v), fullItem(v)] as const))

  const batchKeys = (call: number) =>
    Object.values(
      mockBatchGetItem.mock.calls[call]![0].RequestItems as Record<string, { Keys: Array<any> }>,
    ).flatMap((entry) => entry.Keys.map((k) => fromAttributeMap(k)))

  describe("definition", () => {
    it("exposes the resolved projection, defaulting to all", () => {
      expect(ProjMatch.indexes.fullLsi.projection).toBe("all")
      expect(ProjMatch.indexes.slimLsi.projection).toBe("withoutMetadata")
      expect(ProjMatch.indexes.keysGsi.projection).toBe("keys")
    })

    it("throws EDD-9063 for an unknown projection", () => {
      expect(() =>
        EventStore.makeStream({
          table: EventsTable,
          streamName: "Bad",
          events: [MatchStarted],
          streamId: { composite: ["matchId"] },
          indexes: {
            a: { index: "i", sk: "s", projection: "include", key: () => undefined },
          } as never,
        }),
      ).toThrow(
        /EDD-9063.*projection must be "all", "withoutMetadata" or "keys"; received "include"/,
      )
    })

    it("throws EDD-9063 for a member an index entry does not declare", () => {
      // A misspelled `projection` must not silently resolve to "all".
      expect(() =>
        EventStore.makeStream({
          table: EventsTable,
          streamName: "Typo",
          events: [MatchStarted],
          streamId: { composite: ["matchId"] },
          indexes: {
            a: { index: "i", sk: "s", projecton: "keys", key: () => undefined },
          } as never,
        }),
      ).toThrow(/EDD-9063.*index "a": unknown member "projecton"/)
    })
  })

  describe("indexDefinitions", () => {
    const withoutMetadata = {
      ProjectionType: "INCLUDE",
      NonKeyAttributes: ["__edd_e__", "data", "eventType", "streamId", "timestamp", "version"],
    }
    const keys = { ProjectionType: "INCLUDE", NonKeyAttributes: ["__edd_e__"] }

    it("emits each projection on an LSI and a GSI", () => {
      const fragments = EventStore.indexDefinitions(ProjMatch)
      expect(fragments.LocalSecondaryIndexes!.map((i) => [i.IndexName, i.Projection])).toEqual([
        ["lsi1", { ProjectionType: "ALL" }],
        ["lsi2", withoutMetadata],
        ["lsi3", keys],
      ])
      expect(fragments.GlobalSecondaryIndexes!.map((i) => [i.IndexName, i.Projection])).toEqual([
        ["gsi1", withoutMetadata],
        ["gsi2", keys],
      ])
    })

    it.effect(
      "an appended event carries exactly pk, sk, the withoutMetadata list, metadata and its index attributes",
      () =>
        Effect.gen(function* () {
          mockTransactWriteItems.mockResolvedValue({})
          yield* ProjMatch.append({ matchId: "m-1" }, [new MatchEnded({ result: "won" })], 0, {
            metadata: { eventId: "evt-1" },
          })
          const item = fromAttributeMap(
            mockTransactWriteItems.mock.calls[0]![0].TransactItems.find(
              (i: any) => i.Put !== undefined,
            ).Put.Item,
          )
          const indexAttributes = [
            "lsi1sk",
            "lsi2sk",
            "lsi3sk",
            "gsi1pk",
            "gsi1sk",
            "gsi2pk",
            "gsi2sk",
          ]
          expect(Object.keys(item).sort()).toEqual(
            [
              "pk",
              "sk",
              "metadata",
              ...withoutMetadata.NonKeyAttributes,
              ...indexAttributes,
            ].sort(),
          )
        }).pipe(Effect.provide(TestLayer)),
    )

    it("throws EDD-9067 when two streams share a physical index with different projections", () => {
      const Other = EventStore.makeStream({
        table: EventsTable,
        streamName: "OtherProj",
        events: [MatchStarted],
        streamId: { composite: ["matchId"] },
        indexes: { byVenue: { index: "lsi2", sk: "lsi2sk", key: (e) => e.venue } },
      })
      expect(() => EventStore.indexDefinitions(ProjMatch, Other)).toThrow(
        /EDD-9067.*"lsi2".*projection "withoutMetadata".*projection "all"/,
      )
      // The same projection is shared, emitted once.
      const Same = EventStore.makeStream({
        table: EventsTable,
        streamName: "SameProj",
        events: [MatchStarted],
        streamId: { composite: ["matchId"] },
        indexes: {
          byVenue: {
            index: "lsi2",
            sk: "lsi2sk",
            projection: "withoutMetadata",
            key: (e) => e.venue,
          },
        },
      })
      expect(EventStore.indexDefinitions(ProjMatch, Same).LocalSecondaryIndexes).toHaveLength(3)
    })

    it("reads a hand-built settings object without projection as all", () => {
      expect(
        EventStore.indexDefinitions({
          streamName: "Manual",
          indexes: { byX: { type: "gsi", index: "gsi9", pk: "gsi9pk", sk: "gsi9sk" } },
        }).GlobalSecondaryIndexes![0]!.Projection,
      ).toEqual({ ProjectionType: "ALL" })
    })
  })

  describe("withoutMetadata", () => {
    it.effect("reads with one query, sends the ownership filter and drops metadata", () =>
      Effect.gen(function* () {
        // The row carries metadata (an index deployed wider than declared).
        mockQuery.mockResolvedValue({ Items: [toAttributeMap(fullItem(2, { lsi2sk: "V#0002" }))] })
        const events = yield* ProjMatch.readIndex("slimLsi", { matchId: "m-1" })
        expect(events).toHaveLength(1)
        expect(events[0]!.data).toBeInstanceOf(InningsCompleted)
        expect(events[0]!.metadata).toBeUndefined()
        expect(mockQuery).toHaveBeenCalledOnce()
        expect(mockBatchGetItem).not.toHaveBeenCalled()
        const call = mockQuery.mock.calls[0]![0]
        expect(call.IndexName).toBe("lsi2")
        expect(call.Select).toBeUndefined()
        expect(call.FilterExpression).toContain("#eddE IN")
        expect(Object.values(fromAttributeMap(call.ExpressionAttributeValues))).toContain(
          entityType,
        )

        mockQuery.mockResolvedValue({ Items: [toAttributeMap(fullItem(3))] })
        const viaGsi = yield* ProjMatch.query
          .index("slimGsi", { matchId: "m-1" })
          .pipe(Query.collect)
        expect(viaGsi[0]!.metadata).toBeUndefined()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("the all index keeps metadata", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue({ Items: [toAttributeMap(fullItem(2))] })
        const events = yield* ProjMatch.readIndex("fullLsi", { matchId: "m-1" })
        expect(events[0]!.metadata).toEqual({ eventId: "evt-2" })
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  describe("keys on an LSI", () => {
    it.effect("queries with Select ALL_ATTRIBUTES and the ownership filter", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue({ Items: [toAttributeMap(fullItem(4))] })
        const events = yield* ProjMatch.readIndex(
          "keysLsi",
          { matchId: "m-1" },
          { consistentRead: true },
        )
        expect(events[0]!.metadata).toEqual({ eventId: "evt-4" })
        const call = mockQuery.mock.calls[0]![0]
        expect(call.IndexName).toBe("lsi3")
        expect(call.Select).toBe("ALL_ATTRIBUTES")
        expect(call.ConsistentRead).toBe(true)
        expect(call.ProjectionExpression).toBeUndefined()
        expect(call.FilterExpression).toContain("#eddE IN")
        expect(mockBatchGetItem).not.toHaveBeenCalled()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("select sends a ProjectionExpression and no Select; count sends Select COUNT", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue({ Items: [toAttributeMap({ data: { _tag: "X" } })] })
        yield* ProjMatch.query
          .index("keysLsi", { matchId: "m-1" })
          .pipe(Query.select(["data"]), Query.collect)
        const selected = mockQuery.mock.calls[0]![0]
        expect(selected.ProjectionExpression).toBeDefined()
        expect(selected.Select).toBeUndefined()

        mockQuery.mockResolvedValue({ Count: 7 })
        const count = yield* ProjMatch.query.index("keysLsi", { matchId: "m-1" }).pipe(Query.count)
        expect(count).toBe(7)
        expect(mockQuery.mock.calls[1]![0].Select).toBe("COUNT")
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  describe("keys on a GSI", () => {
    it.effect("hydrates each page with BatchGetItem, in index order", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue({ Items: [3, 1, 2].map(keysRow) })
        mockBatchGetItem.mockImplementation(answerFrom(storeOf([1, 2, 3])))
        const events = yield* ProjMatch.readIndex("keysGsi", { matchId: "m-1" })
        // Index order, although the mock answers in reverse.
        expect(events.map((e) => e.version)).toEqual([3, 1, 2])
        expect(events[0]!.data).toBeInstanceOf(InningsCompleted)
        expect(events[0]!.metadata).toEqual({ eventId: "evt-3" })

        const query = mockQuery.mock.calls[0]![0]
        expect(query.IndexName).toBe("gsi2")
        expect(query.Select).toBeUndefined()
        expect(query.FilterExpression).toContain("#eddE IN")
        expect(mockBatchGetItem).toHaveBeenCalledOnce()
        const request = mockBatchGetItem.mock.calls[0]![0].RequestItems["events-table"]
        expect(request.ConsistentRead).toBeUndefined()
        expect(request.ProjectionExpression).toBeUndefined()
        expect(batchKeys(0)).toEqual([3, 1, 2].map((v) => ({ pk, sk: sk(v) })))
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("query.index hydrates the same way", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue({ Items: [1, 2].map(keysRow) })
        mockBatchGetItem.mockImplementation(answerFrom(storeOf([1, 2])))
        const events = yield* ProjMatch.query
          .index("keysGsi", { matchId: "m-1" })
          .pipe(Query.reverse, Query.collect)
        expect(events.map((e) => e.version)).toEqual([1, 2])
        expect(mockQuery.mock.calls[0]![0].ScanIndexForward).toBe(false)
        const page = yield* ProjMatch.query.index("keysGsi", { matchId: "m-1" }).pipe(Query.execute)
        expect(page.items.map((e) => e.version)).toEqual([1, 2])
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("chunks BatchGetItem at 100 keys", () =>
      Effect.gen(function* () {
        const versions = Array.from({ length: 250 }, (_, i) => i + 1)
        mockQuery.mockResolvedValue({ Items: versions.map(keysRow) })
        mockBatchGetItem.mockImplementation(answerFrom(storeOf(versions)))
        const events = yield* ProjMatch.readIndex("keysGsi", { matchId: "m-1" })
        expect(events.map((e) => e.version)).toEqual(versions)
        expect(mockBatchGetItem).toHaveBeenCalledTimes(3)
        expect([0, 1, 2].map((call) => batchKeys(call).length)).toEqual([100, 100, 50])
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("retries unprocessed keys with backoff", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue({ Items: [1, 2, 3].map(keysRow) })
        mockBatchGetItem.mockImplementation(answerFrom(storeOf([1, 2, 3]), new Set([sk(2)])))
        const fiber = yield* ProjMatch.readIndex("keysGsi", { matchId: "m-1" }).pipe(
          Effect.forkChild,
        )
        yield* TestClock.adjust("1 second")
        const events = yield* Fiber.join(fiber)
        expect(events.map((e) => e.version)).toEqual([1, 2, 3])
        expect(mockBatchGetItem).toHaveBeenCalledTimes(2)
        expect(batchKeys(1)).toEqual([{ pk, sk: sk(2) }])
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("fails with DynamoError after 5 retries", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue({ Items: [keysRow(1)] })
        mockBatchGetItem.mockImplementation(async (input: any) => ({
          Responses: {},
          UnprocessedKeys: input.RequestItems,
        }))
        const fiber = yield* ProjMatch.readIndex("keysGsi", { matchId: "m-1" }).pipe(
          Effect.flip,
          Effect.forkChild,
        )
        yield* TestClock.adjust("10 seconds")
        const error = yield* Fiber.join(fiber)
        expect(error._tag).toBe("DynamoError")
        expect((error as DynamoError).operation).toBe("BatchGetItem")
        expect(String((error as DynamoError).cause)).toContain(
          "Unprocessed keys remain after 5 retries",
        )
        expect(mockBatchGetItem).toHaveBeenCalledTimes(6)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("re-reads a missing key consistently, then drops it", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue({ Items: [1, 2, 3].map(keysRow) })
        mockBatchGetItem.mockImplementation(answerFrom(storeOf([1, 3])))
        const events = yield* ProjMatch.readIndex("keysGsi", { matchId: "m-1" })
        expect(events.map((e) => e.version)).toEqual([1, 3])
        expect(mockBatchGetItem).toHaveBeenCalledTimes(2)
        expect(batchKeys(1)).toEqual([{ pk, sk: sk(2) }])
        expect(mockBatchGetItem.mock.calls[1]![0].RequestItems["events-table"].ConsistentRead).toBe(
          true,
        )
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("re-reads more than 100 missing keys consistently, in chunks of 100", () =>
      Effect.gen(function* () {
        const versions = Array.from({ length: 150 }, (_, i) => i + 1)
        mockQuery.mockResolvedValue({ Items: versions.map(keysRow) })
        // Only version 150 exists: 149 keys go missing on the first read.
        mockBatchGetItem.mockImplementation(answerFrom(storeOf([150])))
        const events = yield* ProjMatch.readIndex("keysGsi", { matchId: "m-1" })
        expect(events.map((e) => e.version)).toEqual([150])
        expect(mockBatchGetItem).toHaveBeenCalledTimes(4)
        expect([0, 1, 2, 3].map((call) => batchKeys(call).length)).toEqual([100, 50, 100, 49])
        const consistent = [0, 1, 2, 3].map(
          (call) =>
            mockBatchGetItem.mock.calls[call]![0].RequestItems["events-table"].ConsistentRead,
        )
        expect(consistent).toEqual([undefined, undefined, true, true])
        expect([...batchKeys(2), ...batchKeys(3)].map((key) => key.sk)).toEqual(
          versions.slice(0, 149).map(sk),
        )
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("a consistent re-read that finds the item keeps it in order", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue({ Items: [1, 2].map(keysRow) })
        mockBatchGetItem
          .mockImplementationOnce(answerFrom(storeOf([2])))
          .mockImplementationOnce(answerFrom(storeOf([1])))
        const events = yield* ProjMatch.readIndex("keysGsi", { matchId: "m-1" })
        expect(events.map((e) => e.version)).toEqual([1, 2])
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("limit hydrates only the window and the cursor resumes after the last row kept", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue({
          Items: [1, 2, 3].map(keysRow),
          LastEvaluatedKey: toAttributeMap({ pk, sk: sk(3), gsi2pk: pk, gsi2sk: "V#0003" }),
        })
        mockBatchGetItem.mockImplementation(answerFrom(storeOf([1, 2, 3])))
        const page = yield* ProjMatch.query
          .index("keysGsi", { matchId: "m-1" })
          .pipe(Query.limit(2), Query.execute)
        expect(page.items.map((e) => e.version)).toEqual([1, 2])
        expect(batchKeys(0)).toEqual([1, 2].map((v) => ({ pk, sk: sk(v) })))
        expect(JSON.parse(atob(page.cursor!))).toEqual(
          toAttributeMap({ gsi2pk: pk, gsi2sk: "V#0002", pk, sk: sk(2) }),
        )

        // readIndex's limit also bounds what is fetched.
        mockBatchGetItem.mockClear()
        const limited = yield* ProjMatch.readIndex("keysGsi", { matchId: "m-1" }, { limit: 1 })
        expect(limited.map((e) => e.version)).toEqual([1])
        expect(batchKeys(0)).toEqual([{ pk, sk: sk(1) }])
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("a dropped row widens the window so limit still fills from the page", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue({ Items: [1, 2, 3, 4].map(keysRow) })
        // Version 2 is gone from the table (never in the store).
        mockBatchGetItem.mockImplementation(answerFrom(storeOf([1, 3, 4])))
        const page = yield* ProjMatch.query
          .index("keysGsi", { matchId: "m-1" })
          .pipe(Query.limit(2), Query.execute)
        expect(page.items.map((e) => e.version)).toEqual([1, 3])
        expect(JSON.parse(atob(page.cursor!))).toMatchObject(toAttributeMap({ sk: sk(3) }))
        expect(mockQuery).toHaveBeenCalledOnce()

        const streamed = yield* ProjMatch.query
          .index("keysGsi", { matchId: "m-1" })
          .pipe(Query.limit(2), Query.collect)
        expect(streamed.map((e) => e.version)).toEqual([1, 3])
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("count counts index rows and fetches nothing", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue({ Count: 3 })
        const count = yield* ProjMatch.query.index("keysGsi", { matchId: "m-1" }).pipe(Query.count)
        expect(count).toBe(3)
        expect(mockQuery.mock.calls[0]![0].Select).toBe("COUNT")
        expect(mockBatchGetItem).not.toHaveBeenCalled()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("select moves the projection onto BatchGetItem and strips the borrowed keys", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue({ Items: [1, 2].map(keysRow) })
        mockBatchGetItem.mockImplementation(async (input: any) => {
          const request = input.RequestItems["events-table"]
          const projected = (version: number) => ({
            pk,
            sk: sk(version),
            __edd_e__: entityType,
            version,
          })
          return {
            Responses: {
              "events-table": request.Keys.map((k: any) =>
                toAttributeMap(projected(Number(String(fromAttributeMap(k).sk).split("#").pop()))),
              ),
            },
          }
        })
        const rows = yield* ProjMatch.query
          .index("keysGsi", { matchId: "m-1" })
          .pipe(Query.select(["version"]), Query.collect)
        expect(rows).toEqual([{ version: 1 }, { version: 2 }])
        expect(mockQuery.mock.calls[0]![0].ProjectionExpression).toBeUndefined()
        const request = mockBatchGetItem.mock.calls[0]![0].RequestItems["events-table"]
        expect(Object.values(request.ExpressionAttributeNames).sort()).toEqual(
          ["__edd_e__", "pk", "sk", "version"].sort(),
        )
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("a fetched item owned by another entity is a defect", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue({ Items: [keysRow(1)] })
        mockBatchGetItem.mockImplementation(
          answerFrom(new Map([[sk(1), fullItem(1, { __edd_e__: "other.event" })]])),
        )
        const exit = yield* ProjMatch.readIndex("keysGsi", { matchId: "m-1" }).pipe(Effect.exit)
        expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
        expect(Cause.pretty((exit as Exit.Failure<unknown, unknown>).cause)).toContain(
          '"other.event"',
        )
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  describe("decode diagnosis", () => {
    const lacking = (version: number, attribute: string, extra: Record<string, unknown> = {}) => {
      const item: Record<string, unknown> = fullItem(version, extra)
      delete item[attribute]
      return toAttributeMap(item)
    }

    it.effect(
      "a row lacking an event attribute names the index and the likely projection mismatch",
      () =>
        Effect.gen(function* () {
          for (const [name, physical, projection] of [
            ["fullLsi", "lsi1", "all"],
            ["slimGsi", "gsi1", "withoutMetadata"],
          ] as const) {
            mockQuery.mockResolvedValue({ Items: [lacking(1, "data")] })
            const error = (yield* ProjMatch.readIndex(name, { matchId: "m-1" }).pipe(
              Effect.flip,
            )) as ValidationError
            expect(error._tag).toBe("ValidationError")
            expect(error.operation).toBe("EventStore.index.decode")
            expect(error.entityType).toBe(entityType)
            const cause = error.cause as Error
            expect(cause.message).toContain(`Stream index "${name}" (physical "${physical}")`)
            expect(cause.message).toContain(`projection: "${projection}"`)
            expect(cause.message).toContain("lack data")
            expect((cause.cause as ValidationError).operation).toBe("EventStore.decode")
          }
        }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("an invalid but present attribute passes through unchanged", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue({
          Items: [
            toAttributeMap(fullItem(1, { data: { _tag: "InningsCompleted", innings: "x" } })),
          ],
        })
        const error = (yield* ProjMatch.readIndex("slimLsi", { matchId: "m-1" }).pipe(
          Effect.flip,
        )) as ValidationError
        expect(error.operation).toBe("EventStore.decode")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("a keys read's decode failure passes through", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue({ Items: [lacking(1, "data")] })
        const lsi = (yield* ProjMatch.readIndex("keysLsi", { matchId: "m-1" }).pipe(
          Effect.flip,
        )) as ValidationError
        expect(lsi.operation).toBe("EventStore.decode")

        mockQuery.mockResolvedValue({ Items: [keysRow(1)] })
        mockBatchGetItem.mockImplementation(async () => ({
          Responses: { "events-table": [lacking(1, "data")] },
        }))
        const gsi = (yield* ProjMatch.readIndex("keysGsi", { matchId: "m-1" }).pipe(
          Effect.flip,
        )) as ValidationError
        expect(gsi.operation).toBe("EventStore.decode")
      }).pipe(Effect.provide(TestLayer)),
    )
  })
})

describe("EventStore per-event metadata (#144)", () => {
  const epochMs = 1704067200000 // 2024-01-01T00:00:00.000Z
  const isoString = "2024-01-01T00:00:00.000Z"

  /** A transforming metadata schema: `recordedAt` is stored as an ISO string. */
  const AuditMetadata = Schema.Struct({
    eventId: Schema.String,
    recordedAt: Schema.DateTimeUtcFromString,
  })
  const meta = (eventId: string) => ({ eventId, recordedAt: DateTime.makeUnsafe(epochMs) })
  const wireMeta = (eventId: string) => ({ eventId, recordedAt: isoString })

  const Audited = EventStore.makeStream({
    table: EventsTable,
    streamName: "Audited",
    events: [MatchStarted, InningsCompleted, MatchEnded],
    streamId: { composite: ["matchId"] },
    metadata: AuditMetadata,
  })
  const AuditedInline = EventStore.makeStream({
    table: EventsTable,
    streamName: "AuditedInline",
    events: [MatchStarted, InningsCompleted, MatchEnded],
    streamId: { composite: ["matchId"] },
    metadata: AuditMetadata,
    snapshot: { schema: MatchStateSchema, mode: "inline" },
  })

  const started = () => new MatchStarted({ venue: "MCG", homeTeam: "AUS", awayTeam: "ENG" })
  const innings = (n: number) => new InningsCompleted({ innings: n, runs: 100 + n, wickets: n })
  const ended = () => new MatchEnded({ result: "AUS won" })

  /** The event items of one TransactWriteItems call, decoded, in order. */
  const eventPutsOf = (call: { TransactItems: ReadonlyArray<any> }) =>
    call.TransactItems.filter((i) => i.Put !== undefined)
      .map((i) => fromAttributeMap(i.Put.Item))
      .filter((item) => String(item.__edd_e__).endsWith(".event"))
  const conflict = {
    name: "TransactionCanceledException",
    CancellationReasons: [{ Code: "ConditionalCheckFailed" }],
  }

  describe("append", () => {
    it.effect("writes entry i onto event i, encoded through the metadata schema", () =>
      Effect.gen(function* () {
        mockTransactWriteItems.mockResolvedValue({})

        const result = yield* Audited.append({ matchId: "m-1" }, [started(), innings(1)], 0, {
          eventMetadata: [meta("e-1"), meta("e-2")],
        })

        expect(result.version).toBe(2)
        const call = mockTransactWriteItems.mock.calls[0]![0]
        expect(call.TransactItems).toHaveLength(2)
        const [first, second] = eventPutsOf(call)
        expect(first!.version).toBe(1)
        expect(first!.metadata).toEqual(wireMeta("e-1"))
        expect(second!.version).toBe(2)
        expect(second!.metadata).toEqual(wireMeta("e-2"))
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("an undefined entry writes no metadata attribute", () =>
      Effect.gen(function* () {
        mockTransactWriteItems.mockResolvedValue({})

        yield* Audited.append({ matchId: "m-1" }, [started(), innings(1), ended()], 0, {
          eventMetadata: [undefined, meta("e-2"), undefined],
        })

        const items = eventPutsOf(mockTransactWriteItems.mock.calls[0]![0])
        expect(items).toHaveLength(3)
        expect("metadata" in items[0]!).toBe(false)
        expect(items[1]!.metadata).toEqual(wireMeta("e-2"))
        expect("metadata" in items[2]!).toBe(false)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("round-trips append → read decoded, each event with its own entry", () =>
      Effect.gen(function* () {
        mockTransactWriteItems.mockResolvedValue({})

        yield* Audited.append({ matchId: "m-1" }, [started(), innings(1), ended()], 0, {
          eventMetadata: [meta("e-1"), undefined, meta("e-3")],
        })

        const stored = mockTransactWriteItems.mock.calls[0]![0].TransactItems.map(
          (i: any) => i.Put.Item,
        )
        mockQuery.mockResolvedValue({ Items: stored })
        const events = yield* Audited.read({ matchId: "m-1" })

        expect(events.map((e) => e.metadata?.eventId)).toEqual(["e-1", undefined, "e-3"])
        const first = events[0]!.metadata!
        expect(DateTime.isDateTime(first.recordedAt)).toBe(true)
        expect(DateTime.toEpochMillis(first.recordedAt)).toBe(epochMs)
        expect(events[1]!.metadata).toBeUndefined()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("an entry that does not encode names its event's index", () =>
      Effect.gen(function* () {
        const error = yield* Audited.append({ matchId: "m-1" }, [started(), innings(1)], 0, {
          eventMetadata: [
            meta("e-1"),
            { eventId: 42, recordedAt: "bogus" } as unknown as ReturnType<typeof meta>,
          ],
        }).pipe(Effect.flip)

        expect(error._tag).toBe("ValidationError")
        expect((error as ValidationError).operation).toBe("EventStore.append.eventMetadata[1]")
        expect(mockTransactWriteItems).not.toHaveBeenCalled()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("a length mismatch is refused before anything is sent", () =>
      Effect.gen(function* () {
        for (const entries of [[meta("e-1")], [meta("e-1"), meta("e-2"), meta("e-3")]]) {
          const error = yield* Audited.append({ matchId: "m-1" }, [started(), innings(1)], 0, {
            eventMetadata: entries,
          }).pipe(Effect.flip)
          expect(error._tag).toBe("ValidationError")
          expect((error as ValidationError).operation).toBe("EventStore.append.eventMetadata")
          expect(String((error as ValidationError).cause)).toContain(
            `${entries.length} entries for 2 events`,
          )
        }
        expect(mockTransactWriteItems).not.toHaveBeenCalled()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("metadata and eventMetadata together are refused before anything is sent", () =>
      Effect.gen(function* () {
        const error = yield* Audited.append({ matchId: "m-1" }, [started()], 0, {
          metadata: meta("shared"),
          eventMetadata: [meta("e-1")],
        } as never).pipe(Effect.flip)

        expect(error._tag).toBe("ValidationError")
        expect((error as ValidationError).operation).toBe("EventStore.append.eventMetadata")
        expect(String((error as ValidationError).cause)).toContain("mutually exclusive")
        expect(mockTransactWriteItems).not.toHaveBeenCalled()

        // `undefined` is absent, so this is not "both".
        mockTransactWriteItems.mockResolvedValue({})
        yield* Audited.append({ matchId: "m-1" }, [started()], 0, {
          metadata: undefined,
          eventMetadata: [meta("e-1")],
        })
        expect(mockTransactWriteItems).toHaveBeenCalledOnce()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("zero events: [m] is a mismatch the no-op fast path does not swallow", () =>
      Effect.gen(function* () {
        const error = yield* Audited.append({ matchId: "m-1" }, [], 3, {
          eventMetadata: [meta("e-1")],
        }).pipe(Effect.flip)
        expect(error._tag).toBe("ValidationError")
        expect((error as ValidationError).operation).toBe("EventStore.append.eventMetadata")
        expect(mockTransactWriteItems).not.toHaveBeenCalled()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("zero events: [] keeps the no-op fast path", () =>
      Effect.gen(function* () {
        const result = yield* Audited.append({ matchId: "m-1" }, [], 3, { eventMetadata: [] })
        expect(result).toEqual({ version: 3, events: [] })
        expect(mockTransactWriteItems).not.toHaveBeenCalled()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("shared metadata is still copied onto every event", () =>
      Effect.gen(function* () {
        mockTransactWriteItems.mockResolvedValue({})

        yield* Audited.append({ matchId: "m-1" }, [started(), innings(1)], 0, {
          metadata: meta("shared"),
        })

        const items = eventPutsOf(mockTransactWriteItems.mock.calls[0]![0])
        expect(items.map((item) => item.metadata)).toEqual([wireMeta("shared"), wireMeta("shared")])
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect(
      "with additionalItems, idempotency and an inline snapshot the layout is unchanged",
      () =>
        Effect.gen(function* () {
          mockTransactWriteItems.mockResolvedValueOnce({})
          const options = {
            eventMetadata: [meta("e-4"), meta("e-5")],
            additionalItems: [Watermarks.put({ writerId: "w", lastSeq: 1 })],
            idempotency: { commandId: "cmd-1" },
            snapshot: { status: "in-progress" as const, innings: [{ runs: 250, wickets: 10 }] },
          }

          yield* AuditedInline.append({ matchId: "m-1" }, [innings(4), innings(5)], 3, options)

          const items = mockTransactWriteItems.mock.calls[0]![0].TransactItems
          // check, 2 events, 1 additional, sentinel, snapshot
          expect(items).toHaveLength(6)
          expect(items[0].ConditionCheck).toBeDefined()
          const decoded = items.slice(1).map((i: any) => fromAttributeMap(i.Put.Item))
          expect(decoded.map((item: any) => item.__edd_e__)).toEqual([
            "auditedinline.event",
            "auditedinline.event",
            "Watermark",
            "auditedinline.command",
            "auditedinline.snapshot",
          ])
          expect(decoded[0].metadata).toEqual(wireMeta("e-4"))
          expect(decoded[1].metadata).toEqual(wireMeta("e-5"))
          for (const other of decoded.slice(2)) expect(other.metadata).toBeUndefined()

          // A cancellation at the additional item still maps to its index.
          mockTransactWriteItems.mockRejectedValueOnce({
            name: "TransactionCanceledException",
            CancellationReasons: [
              { Code: "None" },
              { Code: "None" },
              { Code: "None" },
              { Code: "ConditionalCheckFailed" },
              { Code: "None" },
              { Code: "None" },
            ],
          })
          const error = yield* AuditedInline.append(
            { matchId: "m-1" },
            [innings(4), innings(5)],
            3,
            options,
          ).pipe(Effect.flip)
          expect(error._tag).toBe("AdditionalItemConditionFailed")
          expect((error as AdditionalItemConditionFailed).indices).toEqual([0])
        }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("a bound stream accepts eventMetadata", () =>
      Effect.gen(function* () {
        mockTransactWriteItems.mockResolvedValue({})
        const bound = yield* EventStore.bind(Audited)

        yield* bound.append({ matchId: "m-1" }, [started(), innings(1)], 0, {
          eventMetadata: [meta("e-1"), meta("e-2")],
        })

        const items = eventPutsOf(mockTransactWriteItems.mock.calls[0]![0])
        expect(items.map((item) => item.metadata)).toEqual([wireMeta("e-1"), wireMeta("e-2")])
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("an event item over 400 KB is diagnosed from DynamoDB's rejection, naming it", () =>
      Effect.gen(function* () {
        const rejection = awsValidationException(DDB_ITEM_SIZE)
        mockTransactWriteItems.mockRejectedValueOnce(rejection)
        const big = "x".repeat(410_000)
        const error = yield* Audited.append({ matchId: "m-1" }, [started(), innings(1)], 0, {
          eventMetadata: [meta("e-1"), meta(big)],
        }).pipe(Effect.flip)

        expect(error._tag).toBe("ValidationError")
        const failure = error as ValidationError
        expect(failure.operation).toBe("EventStore.append")
        expect(failure.entityType).toBe("audited.event")
        expect(String(failure.cause)).toContain("the item of the event at version 2, at pk=")
        expect(String(failure.cause)).toContain("409600 bytes (400 KB)")
        expect(((failure.cause as Error).cause as { cause: unknown }).cause).toBe(rejection)
        expect(mockTransactWriteItems).toHaveBeenCalledOnce()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("the idempotency sentinel and inline snapshot are named by their role", () =>
      Effect.gen(function* () {
        // [event, sentinel]: the sentinel's reason is the size failure.
        mockTransactWriteItems.mockRejectedValueOnce(
          awsTransactionCanceled([
            { Code: "None" },
            { Code: "ValidationError", Message: DDB_ITEM_SIZE },
          ]),
        )
        const error = yield* Audited.append({ matchId: "m-1" }, [started()], 0, {
          idempotency: { commandId: "cmd-1" },
        }).pipe(Effect.flip)
        expect(error._tag).toBe("ValidationError")
        expect(String((error as ValidationError).cause)).toContain(
          "the idempotency sentinel, at pk=",
        )
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  describe("commandHandler", () => {
    const startedItem = () =>
      makeStreamEventItem("audited", "m-1", 1, "MatchStarted", {
        venue: "MCG",
        homeTeam: "AUS",
        awayTeam: "ENG",
      })
    const completeInnings: MatchCommand = {
      _tag: "CompleteInnings",
      innings: 1,
      runs: 250,
      wickets: 10,
    }
    /** Two events per command, so the per-event pairing is visible. */
    const twoEvents: EventStore.Decider<
      MatchState,
      MatchCommand,
      MatchEvent,
      AlreadyStarted | NotStarted
    > = {
      ...matchDecider,
      decide: (command, state) =>
        Effect.map(matchDecider.decide(command, state), (events) =>
          events.length === 0 ? events : [...events, ended()],
        ),
    }

    class IdMinter extends Context.Service<IdMinter, { readonly next: Effect.Effect<string> }>()(
      "test/IdMinter",
    ) {}
    class MintFailed extends Data.TaggedError("MintFailed") {}

    it.effect("a plain function receives the Decision; entry i lands on event i", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue({ Items: [startedItem()] })
        mockTransactWriteItems.mockResolvedValue({})
        const seen: Array<EventStore.Decision<MatchState, MatchEvent>> = []

        const result = yield* EventStore.commandHandler(twoEvents, Audited)(
          { matchId: "m-1" },
          completeInnings,
          {
            eventMetadata: (decision) => {
              seen.push(decision)
              // Evaluated before the append.
              expect(mockTransactWriteItems).not.toHaveBeenCalled()
              return decision.events.map((_, i) => meta(`v${decision.version + i + 1}`))
            },
          },
        )

        expect(seen).toHaveLength(1)
        const decision = seen[0]!
        expect(decision.version).toBe(1)
        expect(decision.events).toHaveLength(2)
        expect(decision.previous).toEqual({ status: "in-progress", innings: [] })
        expect(decision.state).toEqual({
          status: "completed",
          innings: [{ runs: 250, wickets: 10 }],
        })
        expect(result.version).toBe(3)
        const items = eventPutsOf(mockTransactWriteItems.mock.calls[0]![0])
        expect(items.map((item) => [item.version, item.metadata])).toEqual([
          [2, wireMeta("v2")],
          [3, wireMeta("v3")],
        ])
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("an Effect-returning function may use services, before additionalItems", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue({ Items: [startedItem()] })
        mockTransactWriteItems.mockResolvedValue({})
        const order: Array<string> = []
        let minted = 0

        const program = EventStore.commandHandler(twoEvents, Audited)(
          { matchId: "m-1" },
          completeInnings,
          {
            additionalItems: () => {
              order.push("additionalItems")
              return [Watermarks.put({ writerId: "proj", lastSeq: 1 })]
            },
            eventMetadata: ({ events }) =>
              Effect.gen(function* () {
                order.push("eventMetadata")
                const minter = yield* IdMinter
                const entries: Array<ReturnType<typeof meta>> = []
                for (const _ of events) entries.push(meta(yield* minter.next))
                return entries
              }),
          },
        )
        yield* Effect.provideService(program, IdMinter, {
          next: Effect.sync(() => `id-${++minted}`),
        })

        expect(order).toEqual(["eventMetadata", "additionalItems"])
        const call = mockTransactWriteItems.mock.calls[0]![0]
        expect(eventPutsOf(call).map((item) => item.metadata)).toEqual([
          wireMeta("id-1"),
          wireMeta("id-2"),
        ])
        // The additional item carries no event metadata.
        const watermark = fromAttributeMap(call.TransactItems.at(-1).Put.Item)
        expect(watermark.__edd_e__).toBe("Watermark")
        expect(watermark.metadata).toBeUndefined()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect(
      "ids minted with Crypto.randomULID are deterministic under TestClock and a fixed Crypto",
      () =>
        Effect.gen(function* () {
          mockQuery.mockResolvedValue({ Items: [startedItem()] })
          mockTransactWriteItems.mockResolvedValue({})
          yield* TestClock.setTime(epochMs)

          // The documented pattern (tutorials/event-sourcing.mdx, Step 20): one
          // ULID per event from the Crypto service.
          const program = Effect.gen(function* () {
            const crypto = yield* Crypto.Crypto
            return yield* EventStore.commandHandler(twoEvents, Audited)(
              { matchId: "m-1" },
              completeInnings,
              {
                eventMetadata: ({ events }) =>
                  Effect.forEach(events, () =>
                    Effect.map(crypto.randomULID, (eventId) => meta(eventId)),
                  ),
              },
            )
          })
          // A test Crypto: call n returns n-filled bytes; the time is the TestClock's.
          let calls = 0
          const fixedCrypto = Crypto.make({
            randomBytes: (size) => new Uint8Array(size).fill(++calls),
            digest: () => Effect.succeed(new Uint8Array(0)),
          })
          yield* Effect.provideService(program, Crypto.Crypto, fixedCrypto)

          const ids = eventPutsOf(mockTransactWriteItems.mock.calls[0]![0]).map(
            (item) => (item.metadata as { eventId: string }).eventId,
          )
          expect(ids).toEqual(["01HK153X00040G2081040G2081", "01HK153X00081040G2081040G2"])
          const isUlid = Schema.is(Schema.String.check(Schema.isULID()))
          expect(ids.every((id) => isUlid(id))).toBe(true)
        }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("is not called for a no-op decision", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue({ Items: [] })
        const derive = vi.fn(() => [meta("never")])
        const noop: EventStore.Decider<MatchState, MatchCommand, MatchEvent> = {
          ...matchDecider,
          decide: () => Effect.succeed([]),
        }

        const result = yield* EventStore.commandHandler(noop, Audited)(
          { matchId: "m-1" },
          completeInnings,
          { eventMetadata: derive },
        )

        expect(result.events).toEqual([])
        expect(derive).not.toHaveBeenCalled()
        expect(mockTransactWriteItems).not.toHaveBeenCalled()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("is re-run, minting again, on a VersionConflict retry", () =>
      Effect.gen(function* () {
        const firstInnings = makeStreamEventItem("audited", "m-1", 2, "InningsCompleted", {
          innings: 1,
          runs: 250,
          wickets: 10,
        })
        mockQuery
          .mockResolvedValueOnce({ Items: [startedItem()] })
          .mockResolvedValue({ Items: [startedItem(), firstInnings] })
        mockTransactWriteItems.mockRejectedValueOnce(conflict).mockResolvedValue({})
        let minted = 0

        yield* EventStore.commandHandler(matchDecider, Audited, { retry: 2 })(
          { matchId: "m-1" },
          { _tag: "CompleteInnings", innings: 2, runs: 180, wickets: 8 },
          { eventMetadata: ({ events }) => events.map(() => meta(`id-${++minted}`)) },
        )

        expect(minted).toBe(2)
        expect(mockTransactWriteItems).toHaveBeenCalledTimes(2)
        const [retried] = eventPutsOf(mockTransactWriteItems.mock.calls[1]![0])
        expect(retried!.version).toBe(3)
        expect(retried!.metadata).toEqual(wireMeta("id-2"))
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("is re-run on the re-decision of a stale unverified snapshot", () =>
      Effect.gen(function* () {
        const label = "auditedinline"
        const snapshot = makeSnapshotItem(label, "m-1", 4, { status: "i", innings: ["1/1", "2/2"] })
        const snapshotSk = DynamoSchema.composeKey(AppSchema, `${label}.snapshot`, [])
        mockGetItem.mockImplementation(async (input: any) =>
          fromAttributeMap(input.Key).sk === snapshotSk ? { Item: snapshot } : {},
        )
        // Event 5 was appended without a snapshot: the first decision is stale.
        mockQuery.mockResolvedValue(
          latestPage(snapshot, [
            makeStreamEventItem(label, "m-1", 5, "InningsCompleted", {
              innings: 3,
              runs: 3,
              wickets: 3,
            }),
          ]),
        )
        mockTransactWriteItems.mockRejectedValueOnce(conflict).mockResolvedValue({})
        const versions: Array<number> = []

        const result = yield* EventStore.commandHandler(matchDecider, AuditedInline, {
          verifySnapshot: false,
        })({ matchId: "m-1" }, completeInnings, {
          eventMetadata: ({ events, version }) => {
            versions.push(version)
            return events.map((_, i) => meta(`v${version + i + 1}`))
          },
        })

        expect(versions).toEqual([4, 5])
        expect(result.version).toBe(6)
        const [event] = eventPutsOf(mockTransactWriteItems.mock.calls[1]![0])
        expect(event!.version).toBe(6)
        expect(event!.metadata).toEqual(wireMeta("v6"))
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("a length mismatch fails with ValidationError named for the handler", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue({ Items: [startedItem()] })
        const derive = vi.fn(() => [meta("only-one")])

        const error = yield* EventStore.commandHandler(twoEvents, Audited, { retry: 3 })(
          { matchId: "m-1" },
          completeInnings,
          { eventMetadata: derive },
        ).pipe(Effect.flip)

        expect(error._tag).toBe("ValidationError")
        expect((error as ValidationError).operation).toBe("EventStore.commandHandler.eventMetadata")
        expect(String((error as ValidationError).cause)).toContain(
          "returned 1 entries for the decision's 2 events",
        )
        // Not retried, and nothing sent.
        expect(derive).toHaveBeenCalledOnce()
        expect(mockTransactWriteItems).not.toHaveBeenCalled()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("a function returning undefined is refused, not written without metadata", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue({ Items: [startedItem()] })
        // A block body with no `return` — only reachable from untyped code.
        const derive = vi.fn(() => undefined)

        const error = yield* EventStore.commandHandler(twoEvents, Audited, { retry: 3 })(
          { matchId: "m-1" },
          completeInnings,
          { eventMetadata: derive as never },
        ).pipe(Effect.flip)

        expect(error._tag).toBe("ValidationError")
        expect((error as ValidationError).operation).toBe("EventStore.commandHandler.eventMetadata")
        expect(String((error as ValidationError).cause)).toContain(
          "returned no entries for the decision's 2 events",
        )
        expect(derive).toHaveBeenCalledOnce()
        expect(mockTransactWriteItems).not.toHaveBeenCalled()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("an E3 failure surfaces as is and is not retried", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue({ Items: [startedItem()] })
        let calls = 0

        const error = yield* EventStore.commandHandler(matchDecider, Audited, { retry: 3 })(
          { matchId: "m-1" },
          completeInnings,
          {
            eventMetadata: () => {
              calls++
              return Effect.fail(new MintFailed())
            },
          },
        ).pipe(Effect.flip)

        expect(error).toBeInstanceOf(MintFailed)
        expect(calls).toBe(1)
        expect(mockQuery).toHaveBeenCalledOnce()
        expect(mockTransactWriteItems).not.toHaveBeenCalled()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("metadata and eventMetadata together are refused before anything is read", () =>
      Effect.gen(function* () {
        const handle = EventStore.commandHandler(matchDecider, Audited)
        const both = yield* handle({ matchId: "m-1" }, completeInnings, {
          metadata: meta("shared"),
          eventMetadata: () => [meta("e-1")],
        } as never).pipe(Effect.flip)
        expect(both._tag).toBe("ValidationError")
        expect((both as ValidationError).operation).toBe("EventStore.commandHandler.eventMetadata")
        expect(String((both as ValidationError).cause)).toContain("mutually exclusive")

        // Function-only: an untyped static array is refused the same way.
        const array = yield* handle({ matchId: "m-1" }, completeInnings, {
          eventMetadata: [meta("e-1")],
        } as never).pipe(Effect.flip)
        expect(array._tag).toBe("ValidationError")
        expect(String((array as ValidationError).cause)).toContain("must be a function")

        expect(mockQuery).not.toHaveBeenCalled()
        expect(mockTransactWriteItems).not.toHaveBeenCalled()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("per-call metadata is still copied onto every event", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue({ Items: [startedItem()] })
        mockTransactWriteItems.mockResolvedValue({})

        yield* EventStore.commandHandler(twoEvents, Audited)({ matchId: "m-1" }, completeInnings, {
          metadata: meta("shared"),
        })

        const items = eventPutsOf(mockTransactWriteItems.mock.calls[0]![0])
        expect(items.map((item) => item.metadata)).toEqual([wireMeta("shared"), wireMeta("shared")])
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("works through a BoundEventStream handler", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue({ Items: [startedItem()] })
        mockTransactWriteItems.mockResolvedValue({})
        const bound = yield* EventStore.bind(Audited)

        yield* bound.pipe(EventStore.commandHandler(matchDecider))(
          { matchId: "m-1" },
          completeInnings,
          { eventMetadata: ({ events }) => events.map(() => meta("bound")) },
        )

        const [event] = eventPutsOf(mockTransactWriteItems.mock.calls[0]![0])
        expect(event!.metadata).toEqual(wireMeta("bound"))
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  describe("eventTimestamps", () => {
    // TestClock is frozen at epoch 0: the append's own `now`.
    const clockNow = "1970-01-01T00:00:00.000Z"
    const at = (iso: string) => DateTime.makeUnsafe(iso)

    describe("append", () => {
      it.effect("writes entry i as event i's timestamp; undefined keeps the append's now", () =>
        Effect.gen(function* () {
          mockTransactWriteItems.mockResolvedValue({})

          yield* Audited.append({ matchId: "m-1" }, [started(), innings(1), ended()], 0, {
            eventTimestamps: [
              at("2019-05-01T09:30:00.250Z"),
              undefined,
              at("2019-05-02T17:00:00Z"),
            ],
          })

          const items = eventPutsOf(mockTransactWriteItems.mock.calls[0]![0])
          expect(items.map((item) => [item.version, item.timestamp])).toEqual([
            [1, "2019-05-01T09:30:00.250Z"],
            [2, clockNow],
            [3, "2019-05-02T17:00:00.000Z"],
          ])
        }).pipe(Effect.provide(TestLayer)),
      )

      it.effect("a zoned DateTime is stored as its UTC instant, and read back so", () =>
        Effect.gen(function* () {
          mockTransactWriteItems.mockResolvedValue({})
          const instant = new Date("2019-05-01T09:30:00.250Z")

          yield* Audited.append({ matchId: "m-1" }, [started(), innings(1)], 0, {
            eventTimestamps: [
              DateTime.makeZonedUnsafe(instant, { timeZone: "Australia/Sydney" }),
              DateTime.makeZonedUnsafe(instant, {
                timeZone: DateTime.zoneMakeOffset(-5 * 3_600_000),
              }),
            ],
          })

          const stored = mockTransactWriteItems.mock.calls[0]![0].TransactItems.map(
            (i: any) => i.Put.Item,
          )
          const items = stored.map((item: any) => fromAttributeMap(item))
          expect(items.map((item: any) => item.timestamp)).toEqual([
            "2019-05-01T09:30:00.250Z",
            "2019-05-01T09:30:00.250Z",
          ])

          mockQuery.mockResolvedValue({ Items: stored })
          const events = yield* Audited.read({ matchId: "m-1" })
          expect(events.map((e) => e.timestamp)).toEqual([
            "2019-05-01T09:30:00.250Z",
            "2019-05-01T09:30:00.250Z",
          ])
        }).pipe(Effect.provide(TestLayer)),
      )

      it.effect("a length mismatch is refused before anything is sent", () =>
        Effect.gen(function* () {
          for (const entries of [[at("2019-05-01T00:00:00Z")], [undefined, undefined, undefined]]) {
            const error = yield* Audited.append({ matchId: "m-1" }, [started(), innings(1)], 0, {
              eventTimestamps: entries,
            }).pipe(Effect.flip)
            expect(error._tag).toBe("ValidationError")
            expect((error as ValidationError).operation).toBe("EventStore.append.eventTimestamps")
            expect(String((error as ValidationError).cause)).toContain(
              `has ${entries.length} entries for 2 events`,
            )
          }
          expect(mockTransactWriteItems).not.toHaveBeenCalled()
        }).pipe(Effect.provide(TestLayer)),
      )

      it.effect("an entry that is not a DateTime is refused before anything is sent", () =>
        Effect.gen(function* () {
          for (const [bad, received] of [
            [new Date("2019-05-01T00:00:00Z"), "a Date"],
            ["2019-05-01T00:00:00Z", "string"],
            [1556668800000, "number"],
            [null, "null"],
          ] as const) {
            const error = yield* Audited.append({ matchId: "m-1" }, [started(), innings(1)], 0, {
              eventTimestamps: [at("2019-05-01T00:00:00Z"), bad as never],
            }).pipe(Effect.flip)
            expect(error._tag).toBe("ValidationError")
            expect((error as ValidationError).operation).toBe("EventStore.append.eventTimestamps")
            expect(String((error as ValidationError).cause)).toContain(
              `eventTimestamps[1] is not a DateTime (received ${received}`,
            )
          }

          // Not an array at all (untyped caller).
          const notArray = yield* Audited.append({ matchId: "m-1" }, [started()], 0, {
            eventTimestamps: at("2019-05-01T00:00:00Z") as never,
          }).pipe(Effect.flip)
          expect((notArray as ValidationError).operation).toBe("EventStore.append.eventTimestamps")
          expect(String((notArray as ValidationError).cause)).toContain("has no entries")

          expect(mockTransactWriteItems).not.toHaveBeenCalled()
        }).pipe(Effect.provide(TestLayer)),
      )

      it.effect("an invalid DateTime (NaN epoch) is refused, not a defect from formatIso", () =>
        Effect.gen(function* () {
          const valid = at("2019-05-01T00:00:00Z")
          for (const bad of [
            DateTime.mapEpochMillis(valid, () => Number.NaN),
            DateTime.mapEpochMillis(
              DateTime.makeZonedUnsafe(0, { timeZone: "Australia/Sydney" }),
              () => Number.NaN,
            ),
          ]) {
            const error = yield* Audited.append({ matchId: "m-1" }, [started(), innings(1)], 0, {
              eventTimestamps: [valid, bad],
            }).pipe(Effect.flip)
            expect(error._tag).toBe("ValidationError")
            expect((error as ValidationError).operation).toBe("EventStore.append.eventTimestamps")
            expect(String((error as ValidationError).cause)).toContain(
              "eventTimestamps[1] is an invalid DateTime",
            )
          }

          expect(mockTransactWriteItems).not.toHaveBeenCalled()
        }).pipe(Effect.provide(TestLayer)),
      )

      it.effect("zero events: a mismatch or bad entry is not swallowed by the fast path", () =>
        Effect.gen(function* () {
          const mismatch = yield* Audited.append({ matchId: "m-1" }, [], 3, {
            eventTimestamps: [at("2019-05-01T00:00:00Z")],
          }).pipe(Effect.flip)
          expect(mismatch._tag).toBe("ValidationError")
          expect((mismatch as ValidationError).operation).toBe("EventStore.append.eventTimestamps")

          const notArray = yield* Audited.append({ matchId: "m-1" }, [], 3, {
            eventTimestamps: "now" as never,
          }).pipe(Effect.flip)
          expect((notArray as ValidationError).operation).toBe("EventStore.append.eventTimestamps")

          // `[]` is consistent and keeps the fast path.
          const result = yield* Audited.append({ matchId: "m-1" }, [], 3, { eventTimestamps: [] })
          expect(result).toEqual({ version: 3, events: [] })
          expect(mockTransactWriteItems).not.toHaveBeenCalled()
        }).pipe(Effect.provide(TestLayer)),
      )

      it.effect("combines with eventMetadata, or with shared metadata", () =>
        Effect.gen(function* () {
          mockTransactWriteItems.mockResolvedValue({})

          yield* Audited.append({ matchId: "m-1" }, [started(), innings(1)], 0, {
            eventMetadata: [meta("e-1"), undefined],
            eventTimestamps: [undefined, at("2019-05-02T00:00:00Z")],
          })
          const perEvent = eventPutsOf(mockTransactWriteItems.mock.calls[0]![0])
          expect(perEvent.map((item) => [item.metadata, item.timestamp])).toEqual([
            [wireMeta("e-1"), clockNow],
            [undefined, "2019-05-02T00:00:00.000Z"],
          ])

          yield* Audited.append({ matchId: "m-2" }, [started(), innings(1)], 0, {
            metadata: meta("shared"),
            eventTimestamps: [at("2019-05-01T00:00:00Z"), at("2019-05-02T00:00:00Z")],
          })
          const shared = eventPutsOf(mockTransactWriteItems.mock.calls[1]![0])
          expect(shared.map((item) => [item.metadata, item.timestamp])).toEqual([
            [wireMeta("shared"), "2019-05-01T00:00:00.000Z"],
            [wireMeta("shared"), "2019-05-02T00:00:00.000Z"],
          ])
        }).pipe(Effect.provide(TestLayer)),
      )

      it.effect("the sentinel, its TTL and the inline snapshot keep the append's now", () =>
        Effect.gen(function* () {
          mockTransactWriteItems.mockResolvedValue({})

          yield* AuditedInline.append({ matchId: "m-1" }, [innings(4), innings(5)], 3, {
            eventTimestamps: [at("2019-05-01T00:00:00Z"), at("2019-05-02T00:00:00Z")],
            additionalItems: [Watermarks.put({ writerId: "w", lastSeq: 1 })],
            idempotency: { commandId: "cmd-1", ttl: Duration.days(1) },
            snapshot: { status: "in-progress" as const, innings: [{ runs: 250, wickets: 10 }] },
          })

          const items = mockTransactWriteItems.mock.calls[0]![0].TransactItems
          // check, 2 events, 1 additional, sentinel, snapshot
          expect(items).toHaveLength(6)
          const decoded = items.slice(1).map((i: any) => fromAttributeMap(i.Put.Item))
          const own = decoded.filter((item: any) => item.__edd_e__ !== "Watermark")
          expect(own.map((item: any) => [item.__edd_e__, item.timestamp])).toEqual([
            ["auditedinline.event", "2019-05-01T00:00:00.000Z"],
            ["auditedinline.event", "2019-05-02T00:00:00.000Z"],
            ["auditedinline.command", clockNow],
            ["auditedinline.snapshot", clockNow],
          ])
          // The sentinel's TTL counts from when the append was written.
          expect(own[2]._ttl).toBe(86_400)
        }).pipe(Effect.provide(TestLayer)),
      )

      it.effect("timestamps may repeat, run backwards or lie in the future", () =>
        Effect.gen(function* () {
          mockTransactWriteItems.mockResolvedValue({})

          const result = yield* Audited.append(
            { matchId: "m-1" },
            [started(), innings(1), innings(2), ended()],
            0,
            {
              eventTimestamps: [
                at("2030-01-01T00:00:00Z"),
                at("2019-05-01T00:00:00Z"),
                at("2019-05-01T00:00:00Z"),
                at("1999-12-31T23:59:59.999Z"),
              ],
            },
          )

          expect(result.version).toBe(4)
          const items = eventPutsOf(mockTransactWriteItems.mock.calls[0]![0])
          expect(items.map((item) => item.timestamp)).toEqual([
            "2030-01-01T00:00:00.000Z",
            "2019-05-01T00:00:00.000Z",
            "2019-05-01T00:00:00.000Z",
            "1999-12-31T23:59:59.999Z",
          ])
        }).pipe(Effect.provide(TestLayer)),
      )

      it.effect("a bound stream accepts eventTimestamps", () =>
        Effect.gen(function* () {
          mockTransactWriteItems.mockResolvedValue({})
          const bound = yield* EventStore.bind(Audited)

          yield* bound.append({ matchId: "m-1" }, [started()], 0, {
            eventTimestamps: [at("2019-05-01T00:00:00Z")],
          })

          const [event] = eventPutsOf(mockTransactWriteItems.mock.calls[0]![0])
          expect(event!.timestamp).toBe("2019-05-01T00:00:00.000Z")
        }).pipe(Effect.provide(TestLayer)),
      )
    })

    describe("commandHandler", () => {
      const startedItem = () =>
        makeStreamEventItem("audited", "m-1", 1, "MatchStarted", {
          venue: "MCG",
          homeTeam: "AUS",
          awayTeam: "ENG",
        })
      const completeInnings: MatchCommand = {
        _tag: "CompleteInnings",
        innings: 1,
        runs: 250,
        wickets: 10,
      }
      /** Two events per command, so the per-event pairing is visible. */
      const twoEvents: EventStore.Decider<
        MatchState,
        MatchCommand,
        MatchEvent,
        AlreadyStarted | NotStarted
      > = {
        ...matchDecider,
        decide: (command, state) =>
          Effect.map(matchDecider.decide(command, state), (events) =>
            events.length === 0 ? events : [...events, ended()],
          ),
      }
      /** One distinct time per version, so a re-derived entry is visible. */
      const forVersion = (version: number) =>
        at(`2019-05-${String(version).padStart(2, "0")}T00:00:00Z`)

      it.effect("receives the Decision; entry i lands on event i", () =>
        Effect.gen(function* () {
          mockQuery.mockResolvedValue({ Items: [startedItem()] })
          mockTransactWriteItems.mockResolvedValue({})
          const seen: Array<EventStore.Decision<MatchState, MatchEvent>> = []

          const result = yield* EventStore.commandHandler(twoEvents, Audited)(
            { matchId: "m-1" },
            completeInnings,
            {
              eventTimestamps: (decision) => {
                seen.push(decision)
                // Evaluated before the append.
                expect(mockTransactWriteItems).not.toHaveBeenCalled()
                return [forVersion(decision.version + 1), undefined]
              },
            },
          )

          expect(seen).toHaveLength(1)
          const decision = seen[0]!
          expect(decision.version).toBe(1)
          expect(decision.events).toHaveLength(2)
          expect(decision.previous).toEqual({ status: "in-progress", innings: [] })
          expect(decision.state).toEqual({
            status: "completed",
            innings: [{ runs: 250, wickets: 10 }],
          })
          expect(result.version).toBe(3)
          const items = eventPutsOf(mockTransactWriteItems.mock.calls[0]![0])
          expect(items.map((item) => [item.version, item.timestamp])).toEqual([
            [2, "2019-05-02T00:00:00.000Z"],
            [3, clockNow],
          ])
        }).pipe(Effect.provide(TestLayer)),
      )

      it.effect("runs after eventMetadata and before additionalItems", () =>
        Effect.gen(function* () {
          mockQuery.mockResolvedValue({ Items: [startedItem()] })
          mockTransactWriteItems.mockResolvedValue({})
          const order: Array<string> = []

          yield* EventStore.commandHandler(twoEvents, Audited)(
            { matchId: "m-1" },
            completeInnings,
            {
              additionalItems: () => {
                order.push("additionalItems")
                return [Watermarks.put({ writerId: "proj", lastSeq: 1 })]
              },
              eventTimestamps: ({ events }) => {
                order.push("eventTimestamps")
                return events.map(() => forVersion(9))
              },
              eventMetadata: ({ events }) =>
                Effect.sync(() => {
                  order.push("eventMetadata")
                  return events.map((_, i) => meta(`e-${i + 1}`))
                }),
            },
          )

          expect(order).toEqual(["eventMetadata", "eventTimestamps", "additionalItems"])
          const items = eventPutsOf(mockTransactWriteItems.mock.calls[0]![0])
          expect(items.map((item) => [item.metadata, item.timestamp])).toEqual([
            [wireMeta("e-1"), "2019-05-09T00:00:00.000Z"],
            [wireMeta("e-2"), "2019-05-09T00:00:00.000Z"],
          ])
        }).pipe(Effect.provide(TestLayer)),
      )

      it.effect("combines with per-call metadata", () =>
        Effect.gen(function* () {
          mockQuery.mockResolvedValue({ Items: [startedItem()] })
          mockTransactWriteItems.mockResolvedValue({})

          yield* EventStore.commandHandler(twoEvents, Audited)(
            { matchId: "m-1" },
            completeInnings,
            {
              metadata: meta("shared"),
              eventTimestamps: ({ events }) => events.map(() => forVersion(7)),
            },
          )

          const items = eventPutsOf(mockTransactWriteItems.mock.calls[0]![0])
          expect(items.map((item) => [item.metadata, item.timestamp])).toEqual([
            [wireMeta("shared"), "2019-05-07T00:00:00.000Z"],
            [wireMeta("shared"), "2019-05-07T00:00:00.000Z"],
          ])
        }).pipe(Effect.provide(TestLayer)),
      )

      it.effect("is not called for a no-op decision", () =>
        Effect.gen(function* () {
          mockQuery.mockResolvedValue({ Items: [] })
          const derive = vi.fn(() => [forVersion(1)])
          const noop: EventStore.Decider<MatchState, MatchCommand, MatchEvent> = {
            ...matchDecider,
            decide: () => Effect.succeed([]),
          }

          const result = yield* EventStore.commandHandler(noop, Audited)(
            { matchId: "m-1" },
            completeInnings,
            { eventTimestamps: derive },
          )

          expect(result.events).toEqual([])
          expect(derive).not.toHaveBeenCalled()
          expect(mockTransactWriteItems).not.toHaveBeenCalled()
        }).pipe(Effect.provide(TestLayer)),
      )

      it.effect("is re-run on a VersionConflict retry", () =>
        Effect.gen(function* () {
          const firstInnings = makeStreamEventItem("audited", "m-1", 2, "InningsCompleted", {
            innings: 1,
            runs: 250,
            wickets: 10,
          })
          mockQuery
            .mockResolvedValueOnce({ Items: [startedItem()] })
            .mockResolvedValue({ Items: [startedItem(), firstInnings] })
          mockTransactWriteItems.mockRejectedValueOnce(conflict).mockResolvedValue({})
          const versions: Array<number> = []

          yield* EventStore.commandHandler(matchDecider, Audited, { retry: 2 })(
            { matchId: "m-1" },
            { _tag: "CompleteInnings", innings: 2, runs: 180, wickets: 8 },
            {
              eventTimestamps: ({ events, version }) => {
                versions.push(version)
                return events.map((_, i) => forVersion(version + i + 1))
              },
            },
          )

          expect(versions).toEqual([1, 2])
          expect(mockTransactWriteItems).toHaveBeenCalledTimes(2)
          const [retried] = eventPutsOf(mockTransactWriteItems.mock.calls[1]![0])
          expect(retried!.version).toBe(3)
          expect(retried!.timestamp).toBe("2019-05-03T00:00:00.000Z")
        }).pipe(Effect.provide(TestLayer)),
      )

      it.effect("is re-run on the re-decision of a stale unverified snapshot", () =>
        Effect.gen(function* () {
          const label = "auditedinline"
          const snapshot = makeSnapshotItem(label, "m-1", 4, {
            status: "i",
            innings: ["1/1", "2/2"],
          })
          const snapshotSk = DynamoSchema.composeKey(AppSchema, `${label}.snapshot`, [])
          mockGetItem.mockImplementation(async (input: any) =>
            fromAttributeMap(input.Key).sk === snapshotSk ? { Item: snapshot } : {},
          )
          // Event 5 was appended without a snapshot: the first decision is stale.
          mockQuery.mockResolvedValue(
            latestPage(snapshot, [
              makeStreamEventItem(label, "m-1", 5, "InningsCompleted", {
                innings: 3,
                runs: 3,
                wickets: 3,
              }),
            ]),
          )
          mockTransactWriteItems.mockRejectedValueOnce(conflict).mockResolvedValue({})
          const versions: Array<number> = []

          const result = yield* EventStore.commandHandler(matchDecider, AuditedInline, {
            verifySnapshot: false,
          })({ matchId: "m-1" }, completeInnings, {
            eventTimestamps: ({ events, version }) => {
              versions.push(version)
              return events.map((_, i) => forVersion(version + i + 1))
            },
          })

          expect(versions).toEqual([4, 5])
          expect(result.version).toBe(6)
          const [event] = eventPutsOf(mockTransactWriteItems.mock.calls[1]![0])
          expect(event!.version).toBe(6)
          expect(event!.timestamp).toBe("2019-05-06T00:00:00.000Z")
        }).pipe(Effect.provide(TestLayer)),
      )

      it.effect("a bad result fails with ValidationError named for the handler, not retried", () =>
        Effect.gen(function* () {
          mockQuery.mockResolvedValue({ Items: [startedItem()] })
          for (const [returned, cause] of [
            [[forVersion(2)], "returned 1 entries for the decision's 2 events"],
            [undefined, "returned no entries for the decision's 2 events"],
            [[forVersion(2), new Date(0)], "eventTimestamps[1] is not a DateTime (received a Date"],
            [[forVersion(2), "2019-05-03T00:00:00Z"], "eventTimestamps[1] is not a DateTime"],
            [
              [forVersion(2), DateTime.mapEpochMillis(forVersion(3), () => Number.NaN)],
              "eventTimestamps[1] is an invalid DateTime",
            ],
          ] as const) {
            const derive = vi.fn(() => returned)

            const error = yield* EventStore.commandHandler(twoEvents, Audited, { retry: 3 })(
              { matchId: "m-1" },
              completeInnings,
              { eventTimestamps: derive as never },
            ).pipe(Effect.flip)

            expect(error._tag).toBe("ValidationError")
            expect((error as ValidationError).operation).toBe(
              "EventStore.commandHandler.eventTimestamps",
            )
            expect(String((error as ValidationError).cause)).toContain(cause)
            // Not retried.
            expect(derive).toHaveBeenCalledOnce()
          }
          expect(mockTransactWriteItems).not.toHaveBeenCalled()
        }).pipe(Effect.provide(TestLayer)),
      )

      it.effect("a value that is not a function is refused before anything is read", () =>
        Effect.gen(function* () {
          const handle = EventStore.commandHandler(matchDecider, Audited)
          const error = yield* handle({ matchId: "m-1" }, completeInnings, {
            eventTimestamps: [forVersion(1)],
          } as never).pipe(Effect.flip)

          expect(error._tag).toBe("ValidationError")
          expect((error as ValidationError).operation).toBe(
            "EventStore.commandHandler.eventTimestamps",
          )
          expect(String((error as ValidationError).cause)).toContain("must be a function")
          expect(mockQuery).not.toHaveBeenCalled()
          expect(mockTransactWriteItems).not.toHaveBeenCalled()
        }).pipe(Effect.provide(TestLayer)),
      )

      describe("Effect form", () => {
        /** A service the times come from: the import's source log. */
        class SourceLog extends Context.Service<
          SourceLog,
          { readonly originalTime: (version: number) => Effect.Effect<DateTime.DateTime> }
        >()("test/SourceLog") {}
        class LookupFailed extends Data.TaggedError("LookupFailed") {}
        const sourceLog = Layer.succeed(SourceLog, {
          originalTime: (version) => Effect.succeed(forVersion(version)),
        })

        it.effect("may use services; receives the Decision; entry i lands on event i", () =>
          Effect.gen(function* () {
            mockQuery.mockResolvedValue({ Items: [startedItem()] })
            mockTransactWriteItems.mockResolvedValue({})
            const seen: Array<EventStore.Decision<MatchState, MatchEvent>> = []

            const result = yield* EventStore.commandHandler(twoEvents, Audited)(
              { matchId: "m-1" },
              completeInnings,
              {
                eventTimestamps: (decision) =>
                  Effect.gen(function* () {
                    seen.push(decision)
                    // Evaluated before the append.
                    expect(mockTransactWriteItems).not.toHaveBeenCalled()
                    const log = yield* SourceLog
                    return [yield* log.originalTime(decision.version + 1), undefined]
                  }),
              },
            ).pipe(Effect.provide(sourceLog))

            expect(seen).toHaveLength(1)
            expect(seen[0]!.version).toBe(1)
            expect(seen[0]!.events).toHaveLength(2)
            expect(result.version).toBe(3)
            const items = eventPutsOf(mockTransactWriteItems.mock.calls[0]![0])
            expect(items.map((item) => [item.version, item.timestamp])).toEqual([
              [2, "2019-05-02T00:00:00.000Z"],
              [3, clockNow],
            ])
          }).pipe(Effect.provide(TestLayer)),
        )

        it.effect("reads the Clock deterministically under TestClock", () =>
          Effect.gen(function* () {
            mockQuery.mockResolvedValue({ Items: [startedItem()] })
            mockTransactWriteItems.mockResolvedValue({})
            const frozenMs = Date.UTC(2024, 0, 1)
            yield* TestClock.setTime(frozenMs)
            const dayMs = 86_400_000

            yield* EventStore.commandHandler(twoEvents, Audited)(
              { matchId: "m-1" },
              completeInnings,
              {
                // Imported history: each event one day further back than the next.
                eventTimestamps: ({ events }) =>
                  Effect.map(DateTime.now, (now) =>
                    events.map((_, i) =>
                      DateTime.makeUnsafe(
                        DateTime.toEpochMillis(now) - (events.length - i) * dayMs,
                      ),
                    ),
                  ),
              },
            )

            const items = eventPutsOf(mockTransactWriteItems.mock.calls[0]![0])
            expect(items.map((item) => item.timestamp)).toEqual([
              "2023-12-30T00:00:00.000Z",
              "2023-12-31T00:00:00.000Z",
            ])
          }).pipe(Effect.provide(TestLayer)),
        )

        it.effect("runs after eventMetadata and before additionalItems, each to completion", () =>
          Effect.gen(function* () {
            mockQuery.mockResolvedValue({ Items: [startedItem()] })
            mockTransactWriteItems.mockResolvedValue({})
            const order: Array<string> = []
            const step = (name: string) =>
              Effect.gen(function* () {
                order.push(`${name}:start`)
                yield* Effect.yieldNow
                order.push(`${name}:end`)
              })

            yield* EventStore.commandHandler(twoEvents, Audited)(
              { matchId: "m-1" },
              completeInnings,
              {
                additionalItems: () =>
                  Effect.as(step("additionalItems"), [
                    Watermarks.put({ writerId: "proj", lastSeq: 1 }),
                  ]),
                eventTimestamps: ({ events }) =>
                  Effect.as(
                    step("eventTimestamps"),
                    events.map(() => forVersion(9)),
                  ),
                eventMetadata: ({ events }) =>
                  Effect.as(
                    step("eventMetadata"),
                    events.map((_, i) => meta(`e-${i + 1}`)),
                  ),
              },
            )

            expect(order).toEqual([
              "eventMetadata:start",
              "eventMetadata:end",
              "eventTimestamps:start",
              "eventTimestamps:end",
              "additionalItems:start",
              "additionalItems:end",
            ])
            const items = eventPutsOf(mockTransactWriteItems.mock.calls[0]![0])
            expect(items.map((item) => [item.metadata, item.timestamp])).toEqual([
              [wireMeta("e-1"), "2019-05-09T00:00:00.000Z"],
              [wireMeta("e-2"), "2019-05-09T00:00:00.000Z"],
            ])
          }).pipe(Effect.provide(TestLayer)),
        )

        it.effect(
          "an E4 failure surfaces as is, is not retried, and additionalItems is not run",
          () =>
            Effect.gen(function* () {
              mockQuery.mockResolvedValue({ Items: [startedItem()] })
              let calls = 0
              const additionalItems = vi.fn(() => [
                Watermarks.put({ writerId: "proj", lastSeq: 1 }),
              ])

              const error = yield* EventStore.commandHandler(matchDecider, Audited, { retry: 3 })(
                { matchId: "m-1" },
                completeInnings,
                {
                  additionalItems,
                  eventTimestamps: () => {
                    calls++
                    return Effect.fail(new LookupFailed())
                  },
                },
              ).pipe(Effect.flip)

              expect(error).toBeInstanceOf(LookupFailed)
              expect(calls).toBe(1)
              expect(additionalItems).not.toHaveBeenCalled()
              expect(mockQuery).toHaveBeenCalledOnce()
              expect(mockTransactWriteItems).not.toHaveBeenCalled()
            }).pipe(Effect.provide(TestLayer)),
        )

        it.effect("is not run when eventMetadata's effect fails", () =>
          Effect.gen(function* () {
            mockQuery.mockResolvedValue({ Items: [startedItem()] })
            let ran = false

            const error = yield* EventStore.commandHandler(matchDecider, Audited)(
              { matchId: "m-1" },
              completeInnings,
              {
                eventMetadata: () => Effect.fail(new LookupFailed()),
                eventTimestamps: ({ events }) =>
                  Effect.sync(() => {
                    ran = true
                    return events.map(() => forVersion(2))
                  }),
              },
            ).pipe(Effect.flip)

            expect(error).toBeInstanceOf(LookupFailed)
            expect(ran).toBe(false)
            expect(mockTransactWriteItems).not.toHaveBeenCalled()
          }).pipe(Effect.provide(TestLayer)),
        )

        it.effect(
          "a bad result fails with ValidationError named for the handler, not retried",
          () =>
            Effect.gen(function* () {
              mockQuery.mockResolvedValue({ Items: [startedItem()] })
              for (const [returned, cause] of [
                [[forVersion(2)], "returned 1 entries for the decision's 2 events"],
                [undefined, "returned no entries for the decision's 2 events"],
                [
                  [forVersion(2), new Date(0)],
                  "eventTimestamps[1] is not a DateTime (received a Date",
                ],
              ] as const) {
                let runs = 0
                const derive = () =>
                  Effect.sync(() => {
                    runs++
                    return returned
                  })

                const error = yield* EventStore.commandHandler(twoEvents, Audited, { retry: 3 })(
                  { matchId: "m-1" },
                  completeInnings,
                  { eventTimestamps: derive as never },
                ).pipe(Effect.flip)

                expect(error._tag).toBe("ValidationError")
                expect((error as ValidationError).operation).toBe(
                  "EventStore.commandHandler.eventTimestamps",
                )
                expect(String((error as ValidationError).cause)).toContain(cause)
                // Not retried.
                expect(runs).toBe(1)
              }
              expect(mockTransactWriteItems).not.toHaveBeenCalled()
            }).pipe(Effect.provide(TestLayer)),
        )

        it.effect("is not run for a no-op decision", () =>
          Effect.gen(function* () {
            mockQuery.mockResolvedValue({ Items: [] })
            let ran = false
            const derive = vi.fn(() =>
              Effect.sync(() => {
                ran = true
                return [forVersion(1)]
              }),
            )
            const noop: EventStore.Decider<MatchState, MatchCommand, MatchEvent> = {
              ...matchDecider,
              decide: () => Effect.succeed([]),
            }

            const result = yield* EventStore.commandHandler(noop, Audited)(
              { matchId: "m-1" },
              completeInnings,
              { eventTimestamps: derive },
            )

            expect(result.events).toEqual([])
            expect(derive).not.toHaveBeenCalled()
            expect(ran).toBe(false)
            expect(mockTransactWriteItems).not.toHaveBeenCalled()
          }).pipe(Effect.provide(TestLayer)),
        )

        it.effect("is re-run on a VersionConflict retry", () =>
          Effect.gen(function* () {
            const firstInnings = makeStreamEventItem("audited", "m-1", 2, "InningsCompleted", {
              innings: 1,
              runs: 250,
              wickets: 10,
            })
            mockQuery
              .mockResolvedValueOnce({ Items: [startedItem()] })
              .mockResolvedValue({ Items: [startedItem(), firstInnings] })
            mockTransactWriteItems.mockRejectedValueOnce(conflict).mockResolvedValue({})
            const versions: Array<number> = []

            yield* EventStore.commandHandler(matchDecider, Audited, { retry: 2 })(
              { matchId: "m-1" },
              { _tag: "CompleteInnings", innings: 2, runs: 180, wickets: 8 },
              {
                eventTimestamps: ({ events, version }) =>
                  Effect.sync(() => {
                    versions.push(version)
                    return events.map((_, i) => forVersion(version + i + 1))
                  }),
              },
            )

            expect(versions).toEqual([1, 2])
            expect(mockTransactWriteItems).toHaveBeenCalledTimes(2)
            const [retried] = eventPutsOf(mockTransactWriteItems.mock.calls[1]![0])
            expect(retried!.version).toBe(3)
            expect(retried!.timestamp).toBe("2019-05-03T00:00:00.000Z")
          }).pipe(Effect.provide(TestLayer)),
        )

        it.effect("is re-run on the re-decision of a stale unverified snapshot", () =>
          Effect.gen(function* () {
            const label = "auditedinline"
            const snapshot = makeSnapshotItem(label, "m-1", 4, {
              status: "i",
              innings: ["1/1", "2/2"],
            })
            const snapshotSk = DynamoSchema.composeKey(AppSchema, `${label}.snapshot`, [])
            mockGetItem.mockImplementation(async (input: any) =>
              fromAttributeMap(input.Key).sk === snapshotSk ? { Item: snapshot } : {},
            )
            // Event 5 was appended without a snapshot: the first decision is stale.
            mockQuery.mockResolvedValue(
              latestPage(snapshot, [
                makeStreamEventItem(label, "m-1", 5, "InningsCompleted", {
                  innings: 3,
                  runs: 3,
                  wickets: 3,
                }),
              ]),
            )
            mockTransactWriteItems.mockRejectedValueOnce(conflict).mockResolvedValue({})
            const versions: Array<number> = []

            const result = yield* EventStore.commandHandler(matchDecider, AuditedInline, {
              verifySnapshot: false,
            })({ matchId: "m-1" }, completeInnings, {
              eventTimestamps: ({ events, version }) =>
                Effect.sync(() => {
                  versions.push(version)
                  return events.map((_, i) => forVersion(version + i + 1))
                }),
            })

            expect(versions).toEqual([4, 5])
            expect(result.version).toBe(6)
            const [event] = eventPutsOf(mockTransactWriteItems.mock.calls[1]![0])
            expect(event!.version).toBe(6)
            expect(event!.timestamp).toBe("2019-05-06T00:00:00.000Z")
          }).pipe(Effect.provide(TestLayer)),
        )

        it.effect("works through a BoundEventStream handler", () =>
          Effect.gen(function* () {
            mockQuery.mockResolvedValue({ Items: [startedItem()] })
            mockTransactWriteItems.mockResolvedValue({})
            const bound = yield* EventStore.bind(Audited)

            yield* bound
              .pipe(EventStore.commandHandler(matchDecider))({ matchId: "m-1" }, completeInnings, {
                eventTimestamps: ({ events, version }) =>
                  Effect.gen(function* () {
                    const log = yield* SourceLog
                    return yield* Effect.forEach(events, (_, i) =>
                      log.originalTime(version + i + 1),
                    )
                  }),
              })
              .pipe(Effect.provide(sourceLog))

            const [event] = eventPutsOf(mockTransactWriteItems.mock.calls[0]![0])
            expect(event!.timestamp).toBe("2019-05-02T00:00:00.000Z")
          }).pipe(Effect.provide(TestLayer)),
        )
      })

      it.effect("works through a BoundEventStream handler", () =>
        Effect.gen(function* () {
          mockQuery.mockResolvedValue({ Items: [startedItem()] })
          mockTransactWriteItems.mockResolvedValue({})
          const bound = yield* EventStore.bind(Audited)

          yield* bound.pipe(EventStore.commandHandler(matchDecider))(
            { matchId: "m-1" },
            completeInnings,
            { eventTimestamps: ({ events }) => events.map(() => forVersion(2)) },
          )

          const [event] = eventPutsOf(mockTransactWriteItems.mock.calls[0]![0])
          expect(event!.timestamp).toBe("2019-05-02T00:00:00.000Z")
        }).pipe(Effect.provide(TestLayer)),
      )
    })
  })
})
