/**
 * Event Sourcing example — effect-dynamodb EventStore
 *
 * Demonstrates: event stream definition, decider pattern, command handler,
 * append/read/readFrom/currentVersion operations, fold helpers, Query combinators,
 * snapshots, atomic side writes, idempotency, consistent reads, If-Match
 * expected versions, inline projections, inline snapshots + readLatest,
 * large commands as stepped commands, stream indexes, event metadata and
 * timestamps, stream index projection, a GSI several streams share by a
 * derived partition, and a head proof in place of the contiguity check —
 * the inline snapshot, or the application's own state record that the
 * command handler loads its state from — and sealing a stream: a generation
 * changeover that seals one stream as it opens the next, and an atomic
 * multi-stream append.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *
 * Run (DYNAMODB_ENDPOINT overrides the default http://localhost:8000):
 *   npx tsx examples/event-sourcing.ts
 */

import {
  Config,
  Console,
  Crypto,
  Data,
  DateTime,
  Duration,
  Effect,
  Layer,
  Option,
  PlatformError,
  Schema,
} from "effect"

import { DynamoClient } from "../src/DynamoClient.js"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as PureEntity from "@effect-dynamodb/schema/Entity.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
import * as Expression from "../src/Expression.js"
import * as Query from "../src/Query.js"
import * as Table from "../src/Table.js"
import * as Transaction from "../src/Transaction.js"

// ---------------------------------------------------------------------------
// 1. Infrastructure — Schema + Table
// ---------------------------------------------------------------------------

// #region infrastructure
const AppSchema = DynamoSchema.make({ name: "cricket", version: 1 })

// A per-writer ingestion watermark — a side record updated atomically with
// events via `append({ additionalItems })`.
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

// A read model kept in step with the stream. Authored with the pure, AWS-free
// `@effect-dynamodb/schema` package — it carries no CRUD ops, so its writes are
// always built from the bound client (`db.entities.MatchStatus.put(...)`).
const MatchStatusRecord = Schema.Struct({
  matchId: Schema.String,
  status: Schema.String,
})

const MatchStatus = PureEntity.make({
  model: DynamoModel.configure(MatchStatusRecord, { matchId: { identifier: true } }),
  entityType: "MatchStatus",
  primaryKey: {
    pk: { field: "pk", composite: ["matchId"] },
    sk: { field: "sk", composite: [] },
  },
})

const EventsTable = Table.make({ schema: AppSchema, entities: { Watermarks, MatchStatus } })
// #endregion

// ---------------------------------------------------------------------------
// 2. Events — pure domain Schema.TaggedClass definitions
// ---------------------------------------------------------------------------

// #region events
class MatchStarted extends Schema.TaggedClass<MatchStarted>()("MatchStarted", {
  venue: Schema.String,
  homeTeam: Schema.String,
  awayTeam: Schema.String,
}) {}

class InningsCompleted extends Schema.TaggedClass<InningsCompleted>()("InningsCompleted", {
  innings: Schema.Number,
  runs: Schema.Number,
  wickets: Schema.Number,
}) {}

class MatchEnded extends Schema.TaggedClass<MatchEnded>()("MatchEnded", {
  result: Schema.String,
}) {}

type MatchEvent = MatchStarted | InningsCompleted | MatchEnded
// #endregion

// ---------------------------------------------------------------------------
// 3. Event Stream — binds events to a table with stream ID composites
// ---------------------------------------------------------------------------

// #region stream
const MatchEvents = EventStore.makeStream({
  table: EventsTable,
  streamName: "Match",
  events: [MatchStarted, InningsCompleted, MatchEnded],
  streamId: { composite: ["matchId"] },
})
// #endregion

// ---------------------------------------------------------------------------
// 4. Decider — command-event-state triad
// ---------------------------------------------------------------------------

// #region decider
interface MatchState {
  readonly status: "pending" | "in-progress" | "completed"
  readonly venue?: string
  readonly innings: ReadonlyArray<{ runs: number; wickets: number }>
  readonly result?: string
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
class AlreadyEnded extends Data.TaggedError("AlreadyEnded") {}

const matchDecider: EventStore.Decider<
  MatchState,
  MatchCommand,
  MatchEvent,
  AlreadyStarted | NotStarted | AlreadyEnded
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
        if (state.status === "completed") return yield* new AlreadyEnded()
        if (state.status !== "in-progress") return yield* new NotStarted()
        return [new MatchEnded({ result: command.result })]
      }
      return []
    }),

  evolve: (state, event) => {
    if (event instanceof MatchStarted) {
      return { ...state, status: "in-progress" as const, venue: event.venue }
    }
    if (event instanceof InningsCompleted) {
      return {
        ...state,
        innings: [...state.innings, { runs: event.runs, wickets: event.wickets }],
      }
    }
    if (event instanceof MatchEnded) {
      return { ...state, status: "completed" as const, result: event.result }
    }
    return state
  },
}
// #endregion

// ---------------------------------------------------------------------------
// 5. Snapshots — a state schema plus a snapshot-enabled stream
// ---------------------------------------------------------------------------

// #region snapshot-schema
const MatchStateSchema = Schema.Struct({
  status: Schema.Literals(["pending", "in-progress", "completed"]),
  venue: Schema.optionalKey(Schema.String),
  innings: Schema.Array(Schema.Struct({ runs: Schema.Number, wickets: Schema.Number })),
  result: Schema.optionalKey(Schema.String),
})
// #endregion

// #region snapshot-stream
const SnapshotMatchEvents = EventStore.makeStream({
  table: EventsTable,
  streamName: "SnapshotMatch",
  events: [MatchStarted, InningsCompleted, MatchEnded],
  streamId: { composite: ["matchId"] },
  snapshot: { schema: MatchStateSchema, every: 3 },
})
// #endregion

// #region inline-snapshot-stream
const InlineMatchEvents = EventStore.makeStream({
  table: EventsTable,
  streamName: "InlineMatch",
  events: [MatchStarted, InningsCompleted, MatchEnded],
  streamId: { composite: ["matchId"] },
  snapshot: { schema: MatchStateSchema, mode: "inline" },
})
// #endregion

// #region state-record
// The application's own record of a match: its state, and the stream version
// that state is as of. Every append writes it, in the same transaction.
class MatchRecord extends Schema.Class<MatchRecord>("MatchRecord")({
  matchId: Schema.String,
  state: MatchStateSchema,
  streamVersion: Schema.Number,
}) {}

const MatchRecords = Entity.make({
  model: MatchRecord,
  entityType: "MatchRecord",
  primaryKey: {
    pk: { field: "pk", composite: ["matchId"] },
    sk: { field: "sk", composite: [] },
  },
})

const RecordTable = Table.make({ schema: AppSchema, entities: { MatchRecords } })

const RecordedMatches = EventStore.makeStream({
  table: RecordTable,
  streamName: "RecordedMatch",
  events: [MatchStarted, InningsCompleted, MatchEnded],
  streamId: { composite: ["matchId"] },
})

// The record an append after `decision.version` writes, conditioned on the
// version the handler loaded: it holds only while the stream is still there.
const recordOf =
  (matchId: string) =>
  ({ state, version, events }: EventStore.Decision<MatchState, MatchEvent>) => [
    MatchRecords.put({ matchId, state, streamVersion: version + events.length }).pipe(
      version === 0
        ? MatchRecords.condition((t, { notExists }) => notExists(t.streamVersion))
        : MatchRecords.condition({ streamVersion: version }),
    ),
  ]
// #endregion

// ---------------------------------------------------------------------------
// 6. Stepped commands — a large command as fixed-size atomic steps
// ---------------------------------------------------------------------------

// #region stepped-decider
// Ball-by-ball deliveries from a scoring feed, and their compensating undo.
class DeliveryRecorded extends Schema.TaggedClass<DeliveryRecorded>()("DeliveryRecorded", {
  ball: Schema.Number,
}) {}

class DeliveryReverted extends Schema.TaggedClass<DeliveryReverted>()("DeliveryReverted", {
  ball: Schema.Number,
}) {}

type DeliveryEvent = DeliveryRecorded | DeliveryReverted

const DeliveryState = Schema.Struct({ live: Schema.Array(Schema.Number) })
type DeliveryState = typeof DeliveryState.Type

const Deliveries = EventStore.makeStream({
  table: EventsTable,
  streamName: "Deliveries",
  events: [DeliveryRecorded, DeliveryReverted],
  streamId: { composite: ["matchId"] },
  snapshot: { schema: DeliveryState, mode: "inline" },
})

type DeliveryCommand =
  | { readonly _tag: "RecordDeliveries"; readonly balls: ReadonlyArray<number> }
  | { readonly _tag: "RevertDeliveries"; readonly balls: ReadonlyArray<number> }

class NotRecorded extends Data.TaggedError("NotRecorded")<{ readonly ball: number }> {}

const deliveryDecider: EventStore.Decider<
  DeliveryState,
  DeliveryCommand,
  DeliveryEvent,
  NotRecorded
> = {
  initialState: { live: [] },
  decide: (command, state) =>
    Effect.gen(function* () {
      if (command._tag === "RecordDeliveries") {
        return command.balls.map((ball) => new DeliveryRecorded({ ball }))
      }
      for (const ball of command.balls) {
        if (!state.live.includes(ball)) return yield* new NotRecorded({ ball })
      }
      return command.balls.map((ball) => new DeliveryReverted({ ball }))
    }),
  evolve: (state, event) => ({
    live:
      event._tag === "DeliveryRecorded"
        ? [...state.live, event.ball]
        : state.live.filter((ball) => ball !== event.ball),
  }),
}
// #endregion

// ---------------------------------------------------------------------------
// 7. Stream indexes — sub-streams ordered by a key derived from each event
// ---------------------------------------------------------------------------

// #region index-stream
// An LSI can only be created with its table, so indexed streams get their own.
const ScorecardTable = Table.make({ schema: AppSchema, entities: {} })

const pad = (n: number) => String(n).padStart(4, "0")

const Scorecards = EventStore.makeStream({
  table: ScorecardTable,
  streamName: "Scorecard",
  events: [MatchStarted, InningsCompleted, MatchEnded],
  streamId: { composite: ["matchId"] },
  indexes: {
    // LSI (the default type): innings in innings order, strongly consistent.
    byInnings: {
      index: "lsi1",
      sk: "lsi1sk",
      key: (event) =>
        event._tag === "InningsCompleted" ? `INNINGS#${pad(event.innings)}` : undefined,
    },
    // GSI: innings by runs scored, eventually consistent, no 10 GB cap.
    byRuns: {
      type: "gsi",
      index: "gsi1",
      pk: "gsi1pk",
      sk: "gsi1sk",
      key: (event, version) =>
        event._tag === "InningsCompleted" ? `RUNS#${pad(event.runs)}#${pad(version)}` : undefined,
    },
  },
})
// #endregion

// ---------------------------------------------------------------------------
// 8. Event metadata — a metadata schema on the stream
// ---------------------------------------------------------------------------

// #region metadata-stream
// Facts about an event that are not part of the domain event itself.
const AuditMetadata = Schema.Struct({
  // The request that produced the event: shared by every event it appends.
  correlationId: Schema.String,
  // An id of the event's own: a ULID, minted when the event is decided.
  eventId: Schema.optionalKey(Schema.String.check(Schema.isULID())),
  // For an imported event: its id in the store it came from.
  sourceId: Schema.optionalKey(Schema.String),
})

const AuditedMatchEvents = EventStore.makeStream({
  table: EventsTable,
  streamName: "AuditedMatch",
  events: [MatchStarted, InningsCompleted, MatchEnded],
  streamId: { composite: ["matchId"] },
  metadata: AuditMetadata,
})
// #endregion

// #region index-projection
// Metadata is often an event's largest attribute, and an index projecting ALL
// copies it into every entry. `projection` keeps it out.
const AuditedScorecardTable = Table.make({ schema: AppSchema, entities: {} })

const AuditedScorecards = EventStore.makeStream({
  table: AuditedScorecardTable,
  streamName: "AuditedScorecard",
  events: [MatchStarted, InningsCompleted, MatchEnded],
  streamId: { composite: ["matchId"] },
  metadata: AuditMetadata,
  indexes: {
    // Every event attribute except `metadata`: read with one query, and
    // `metadata` is typed (and read as) undefined.
    byInnings: {
      index: "lsi1",
      sk: "lsi1sk",
      projection: "withoutMetadata",
      key: (event) =>
        event._tag === "InningsCompleted" ? `INNINGS#${pad(event.innings)}` : undefined,
    },
    // Keys only: the smallest entries. A read queries the index, then fetches
    // the full events from the table with BatchGetItem, in index order.
    byRuns: {
      type: "gsi",
      index: "gsi1",
      pk: "gsi1pk",
      sk: "gsi1sk",
      projection: "keys",
      key: (event, version) =>
        event._tag === "InningsCompleted" ? `RUNS#${pad(event.runs)}#${pad(version)}` : undefined,
    },
  },
})
// #endregion

// ---------------------------------------------------------------------------
// 9. Shared indexes — one GSI partition several streams write (#149)
// ---------------------------------------------------------------------------

// #region shared-index-streams
// A series groups its matches, squads and umpire appointments. The three
// streams derive one partition of `gsi1` per series, so one query of it reads
// the whole series, each match's current state included.
const SeriesTable = Table.make({ schema: AppSchema, entities: {} })

class SquadNamed extends Schema.TaggedClass<SquadNamed>()("SquadNamed", {
  players: Schema.Array(Schema.String),
}) {}

class UmpireAppointed extends Schema.TaggedClass<UmpireAppointed>()("UmpireAppointed", {
  seriesId: Schema.String,
  matchId: Schema.String,
}) {}

const SeriesMatches = EventStore.makeStream({
  table: SeriesTable,
  streamName: "SeriesMatch",
  events: [MatchStarted, InningsCompleted, MatchEnded],
  streamId: { composite: ["seriesId", "matchId"] },
  snapshot: { schema: MatchStateSchema, mode: "inline" },
  indexes: {
    bySeries: {
      type: "gsi",
      index: "gsi1",
      pk: "gsi1pk",
      sk: "gsi1sk",
      // Written raw: no prefix, no casing.
      partition: (_event, _version, streamId) => `SERIES#${streamId.seriesId}`,
      key: (_event, version, streamId) => `MATCH#${streamId.matchId}#EVT#${pad(version)}`,
      // Each match's snapshot is in the partition too, written in the same
      // transaction as the events (an inline snapshot).
      snapshot: (_state, _asOfVersion, streamId) => ({
        partition: `SERIES#${streamId.seriesId}`,
        key: `MATCH#${streamId.matchId}#STATE`,
      }),
    },
  },
})

const SeriesSquads = EventStore.makeStream({
  table: SeriesTable,
  streamName: "SeriesSquad",
  events: [SquadNamed],
  streamId: { composite: ["seriesId", "team"] },
  indexes: {
    bySeries: {
      type: "gsi",
      index: "gsi1",
      pk: "gsi1pk",
      sk: "gsi1sk",
      partition: (_event, _version, streamId) => `SERIES#${streamId.seriesId}`,
      key: (_event, version, streamId) => `SQUAD#${streamId.team}#EVT#${pad(version)}`,
    },
  },
})

// An umpire's stream is keyed by the umpire alone: the series comes from
// each event.
const Umpires = EventStore.makeStream({
  table: SeriesTable,
  streamName: "Umpire",
  events: [UmpireAppointed],
  streamId: { composite: ["umpireId"] },
  indexes: {
    bySeries: {
      type: "gsi",
      index: "gsi1",
      pk: "gsi1pk",
      sk: "gsi1sk",
      partition: (event) => `SERIES#${event.seriesId}`,
      key: (_event, version, streamId) => `UMPIRE#${streamId.umpireId}#EVT#${pad(version)}`,
    },
  },
})
// #endregion

// ---------------------------------------------------------------------------
// 10. Sealing a stream — generations of an account's ledger (#166)
// ---------------------------------------------------------------------------

// #region seal-stream
// An account's ledger, keyed by generation. After a table restore, writers
// move to the next generation; sealing the old one makes sure nobody can
// append to it again.
class LedgerOpened extends Schema.TaggedClass<LedgerOpened>()("LedgerOpened", {
  balance: Schema.Number,
  // The generation this one continues, and the version its balance was read at.
  continuesFrom: Schema.optionalKey(
    Schema.Struct({ generation: Schema.String, version: Schema.Number }),
  ),
}) {}

class Deposited extends Schema.TaggedClass<Deposited>()("Deposited", {
  amount: Schema.Number,
}) {}

class Withdrawn extends Schema.TaggedClass<Withdrawn>()("Withdrawn", {
  amount: Schema.Number,
}) {}

class LedgerClosed extends Schema.TaggedClass<LedgerClosed>()("LedgerClosed", {
  reason: Schema.String,
  // The generation that carries the ledger on, when there is one.
  continuedIn: Schema.optionalKey(Schema.String),
}) {}

type LedgerEvent = LedgerOpened | Deposited | Withdrawn | LedgerClosed

// The application's chain index: which generation is current, and where each
// closed one ends. Every writer of it increments `revision`.
class LedgerChain extends Schema.Class<LedgerChain>("LedgerChain")({
  accountId: Schema.String,
  current: Schema.String,
  revision: Schema.Number,
  generations: Schema.Array(
    Schema.Struct({
      generation: Schema.String,
      validThrough: Schema.optionalKey(Schema.Number),
    }),
  ),
}) {}

const LedgerChains = Entity.make({
  model: LedgerChain,
  entityType: "LedgerChain",
  primaryKey: {
    pk: { field: "pk", composite: ["accountId"] },
    sk: { field: "sk", composite: [] },
  },
})

const LedgerTable = Table.make({ schema: AppSchema, entities: { LedgerChains } })

const Ledgers = EventStore.makeStream({
  table: LedgerTable,
  streamName: "Ledger",
  events: [LedgerOpened, Deposited, Withdrawn, LedgerClosed],
  streamId: { composite: ["accountId", "generation"] },
})

type LedgerState = { readonly balance: number }
type LedgerCommand = { readonly _tag: "Deposit"; readonly amount: number }

const ledgerDecider: EventStore.Decider<LedgerState, LedgerCommand, LedgerEvent> = {
  initialState: { balance: 0 },
  decide: (command) => Effect.succeed([new Deposited({ amount: command.amount })]),
  evolve: (state, event) => {
    if (event._tag === "LedgerOpened") return { balance: event.balance }
    if (event._tag === "Deposited") return { balance: state.balance + event.amount }
    if (event._tag === "Withdrawn") return { balance: state.balance - event.amount }
    return state
  },
}
// #endregion

// ---------------------------------------------------------------------------
// 11. Main program
// ---------------------------------------------------------------------------

const assertEq = <T>(actual: T, expected: T, label: string): void => {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`Assertion failed [${label}]: expected ${e}, got ${a}`)
}

const program = Effect.gen(function* () {
  const client = yield* DynamoClient
  const tableConfig = yield* EventsTable.Tag
  const scorecardConfig = yield* ScorecardTable.Tag
  const auditedScorecardConfig = yield* AuditedScorecardTable.Tag
  const seriesConfig = yield* SeriesTable.Tag

  // --- Bind event stream ---
  // #region command-handler
  const matchEvents = yield* EventStore.bind(MatchEvents)
  const handleMatch = EventStore.commandHandler(matchDecider, matchEvents)
  // #endregion

  // --- Create table ---
  yield* Console.log("Creating table:", tableConfig.name)
  // Start clean: drop the tables a failed earlier run may have left behind
  yield* client
    .deleteTable({ TableName: tableConfig.name })
    .pipe(Effect.catchTag("ResourceNotFoundError", () => Effect.void))
  yield* client
    .deleteTable({ TableName: scorecardConfig.name })
    .pipe(Effect.catchTag("ResourceNotFoundError", () => Effect.void))
  yield* client
    .deleteTable({ TableName: auditedScorecardConfig.name })
    .pipe(Effect.catchTag("ResourceNotFoundError", () => Effect.void))
  yield* client
    .deleteTable({ TableName: seriesConfig.name })
    .pipe(Effect.catchTag("ResourceNotFoundError", () => Effect.void))
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
    ],
  })
  yield* Console.log("Table created.\n")

  // --- Command handler: Start match ---
  yield* Console.log("=== Starting match ===")
  // #region start-match
  const r1 = yield* handleMatch(
    { matchId: "m-1" },
    { _tag: "StartMatch", venue: "MCG", homeTeam: "AUS", awayTeam: "ENG" },
  )
  // #endregion
  yield* Console.log(
    `State: ${r1.state.status}, Version: ${r1.version}, Events: ${r1.events.length}`,
  )

  // --- Command handler: Complete innings ---
  yield* Console.log("\n=== Completing innings ===")
  // #region complete-innings
  const r2 = yield* handleMatch(
    { matchId: "m-1" },
    { _tag: "CompleteInnings", innings: 1, runs: 250, wickets: 10 },
  )

  const r3 = yield* handleMatch(
    { matchId: "m-1" },
    { _tag: "CompleteInnings", innings: 2, runs: 180, wickets: 10 },
  )
  // #endregion
  yield* Console.log(
    `State: ${r2.state.status}, Innings: ${r2.state.innings.length}, Version: ${r2.version}`,
  )
  yield* Console.log(
    `State: ${r3.state.status}, Innings: ${r3.state.innings.length}, Version: ${r3.version}`,
  )

  // --- Command handler: End match ---
  yield* Console.log("\n=== Ending match ===")
  // #region end-match
  const r4 = yield* handleMatch(
    { matchId: "m-1" },
    { _tag: "EndMatch", result: "AUS won by 70 runs" },
  )
  // #endregion
  yield* Console.log(
    `State: ${r4.state.status}, Result: ${r4.state.result}, Version: ${r4.version}`,
  )

  // --- Read all events ---
  yield* Console.log("\n=== Read all events ===")
  // #region read-all
  const allEvents = yield* matchEvents.read({ matchId: "m-1" })
  // #endregion
  for (const event of allEvents) {
    yield* Console.log(`  v${event.version}: ${event.eventType} at ${event.timestamp}`)
  }

  // --- Read from version ---
  yield* Console.log("\n=== Read from version 2 ===")
  // #region read-from
  const laterEvents = yield* matchEvents.readFrom({ matchId: "m-1" }, 2)
  // #endregion
  for (const event of laterEvents) {
    yield* Console.log(`  v${event.version}: ${event.eventType}`)
  }

  // --- Current version ---
  // #region current-version
  const version = yield* matchEvents.currentVersion({ matchId: "m-1" })
  // #endregion
  yield* Console.log(`\nCurrent version: ${version}`)

  // --- Fold: reconstruct state from events ---
  yield* Console.log("\n=== Fold: Reconstruct state ===")
  // #region fold
  const state = EventStore.fold(matchDecider, allEvents)
  // #endregion
  yield* Console.log(`Reconstructed: status=${state.status}, innings=${state.innings.length}`)

  // --- Query combinator: get latest event ---
  yield* Console.log("\n=== Query: Latest event ===")
  // #region query-latest
  const latest = yield* matchEvents.provide(
    matchEvents.query.events({ matchId: "m-1" }).pipe(Query.reverse, Query.limit(1), Query.collect),
  )
  const [latestEvent] = latest
  // #endregion
  if (latestEvent) {
    yield* Console.log(`Latest: v${latestEvent.version} ${latestEvent.eventType}`)
  }

  // --- Domain error: try to start again ---
  yield* Console.log("\n=== Domain error: StartMatch on completed match ===")
  // #region domain-error
  const error = yield* handleMatch(
    { matchId: "m-1" },
    { _tag: "StartMatch", venue: "SCG", homeTeam: "AUS", awayTeam: "IND" },
  ).pipe(Effect.flip)
  // #endregion
  yield* Console.log(`Error: ${error._tag}`)

  // --- Snapshots: snapshot-aware handler with retry ---
  yield* Console.log("\n=== Snapshots ===")
  // #region snapshot-handler
  const snapshotMatchEvents = yield* EventStore.bind(SnapshotMatchEvents)
  const handleSnapshotMatch = EventStore.commandHandler(matchDecider, snapshotMatchEvents, {
    retry: 3,
  })
  // #endregion

  // #region snapshot-commands
  yield* handleSnapshotMatch(
    { matchId: "m-2" },
    { _tag: "StartMatch", venue: "SCG", homeTeam: "AUS", awayTeam: "IND" },
  )
  yield* handleSnapshotMatch(
    { matchId: "m-2" },
    { _tag: "CompleteInnings", innings: 1, runs: 310, wickets: 8 },
  )
  // The third event crosses the `every: 3` threshold — a snapshot is written.
  const s3 = yield* handleSnapshotMatch(
    { matchId: "m-2" },
    { _tag: "CompleteInnings", innings: 2, runs: 275, wickets: 10 },
  )
  // #endregion
  yield* Console.log(`State: ${s3.state.status}, Version: ${s3.version}`)

  // #region read-snapshot
  const snapshot = yield* snapshotMatchEvents.readSnapshot({ matchId: "m-2" })
  const asOfVersion = Option.match(snapshot, {
    onNone: () => 0,
    onSome: (s) => s.asOfVersion,
  })
  // #endregion
  yield* Console.log(`Snapshot asOfVersion: ${asOfVersion}`)

  // Subsequent commands fold from the snapshot plus the delta, not the whole
  // stream. The result is identical either way.
  // #region snapshot-fold
  const s4 = yield* handleSnapshotMatch(
    { matchId: "m-2" },
    { _tag: "EndMatch", result: "AUS won by 35 runs" },
  )
  // #endregion
  yield* Console.log(`State: ${s4.state.status}, Version: ${s4.version}`)

  // Snapshots can also be written by hand — e.g. from a backfill job.
  // #region write-snapshot
  const events = yield* snapshotMatchEvents.read({ matchId: "m-2" })
  const folded = EventStore.fold(matchDecider, events)
  yield* snapshotMatchEvents.writeSnapshot({ matchId: "m-2" }, folded, s4.version)
  // #endregion
  yield* Console.log(`Rewrote snapshot at version ${s4.version}`)

  // --- Atomic side writes: additionalItems ---
  yield* Console.log("\n=== Atomic side write: append + watermark ===")
  // #region additional-items
  yield* matchEvents.append(
    { matchId: "m-2" },
    [new MatchStarted({ venue: "SCG", homeTeam: "AUS", awayTeam: "IND" })],
    0,
    {
      additionalItems: [Watermarks.put({ writerId: "ingest-1", lastSeq: 4021 })],
    },
  )
  // #endregion
  const watermark = yield* Watermarks.get({ writerId: "ingest-1" })
  yield* Console.log(`Watermark committed with the event: lastSeq=${watermark.lastSeq}`)

  // --- The read-model case: a put built from the bound client ---
  yield* Console.log("\n=== Atomic side write: append + read model ===")
  // #region additional-items-read-model
  const db = yield* DynamoClient.make({ entities: { MatchStatus }, tables: { EventsTable } })

  yield* matchEvents.append(
    { matchId: "m-4" },
    [new MatchStarted({ venue: "Basin Reserve", homeTeam: "NZL", awayTeam: "SAF" })],
    0,
    {
      additionalItems: [db.entities.MatchStatus.put({ matchId: "m-4", status: "in-progress" })],
    },
  )
  // #endregion
  const status = yield* db.entities.MatchStatus.get({ matchId: "m-4" })
  yield* Console.log(`Read model committed with the event: status=${status.status}`)

  // --- A failing user condition is NOT a version conflict ---
  yield* Console.log("\n=== Additional-item condition failure ===")
  // #region additional-item-condition
  const condError = yield* matchEvents
    .append({ matchId: "m-2" }, [new InningsCompleted({ innings: 1, runs: 300, wickets: 8 })], 1, {
      additionalItems: [
        Transaction.check(
          Watermarks.get({ writerId: "ingest-1" }),
          Expression.condition({ lt: { lastSeq: 100 } }),
        ),
      ],
    })
    .pipe(Effect.flip)
  // #endregion
  yield* Console.log(
    `Error: ${condError._tag} (not VersionConflict — the caller's condition failed)`,
  )

  // --- Command idempotency ---
  yield* Console.log("\n=== Command idempotency ===")
  // #region idempotency
  const handleIdempotent = EventStore.commandHandler(matchDecider, matchEvents, {
    idempotency: { ttl: Duration.days(1) },
  })

  yield* handleIdempotent(
    { matchId: "m-3" },
    { _tag: "StartMatch", venue: "Lords", homeTeam: "ENG", awayTeam: "NZ" },
    { commandId: "cmd-7f3a" },
  )

  // CompleteInnings is not self-guarding — the decider happily produces a second
  // event, so only the dedup sentinel can catch the replay.
  yield* handleIdempotent(
    { matchId: "m-3" },
    { _tag: "CompleteInnings", innings: 1, runs: 210, wickets: 6 },
    { commandId: "cmd-9b12" },
  )

  const dupError = yield* handleIdempotent(
    { matchId: "m-3" },
    { _tag: "CompleteInnings", innings: 1, runs: 210, wickets: 6 },
    { commandId: "cmd-9b12" },
  ).pipe(Effect.flip)
  // #endregion
  yield* Console.log(`Replay: ${dupError._tag}`)
  const m3 = yield* matchEvents.read({ matchId: "m-3" })
  yield* Console.log(`Events on m-3 after the replay: ${m3.length}`)

  // --- Consistent reads ---
  yield* Console.log("\n=== Consistent reads ===")
  // #region consistent-read
  const fresh = yield* matchEvents.read({ matchId: "m-1" }, { consistentRead: true })
  const head = yield* matchEvents.currentVersion({ matchId: "m-1" }, { consistentRead: true })

  // commandHandler loads state consistently by default. Opt out per handler:
  const handleRelaxed = EventStore.commandHandler(matchDecider, matchEvents, {
    consistentRead: false,
  })
  yield* handleRelaxed(
    { matchId: "m-7" },
    { _tag: "StartMatch", venue: "Gabba", homeTeam: "AUS", awayTeam: "PAK" },
  )
  // #endregion
  yield* Console.log(`Read ${fresh.length} events consistently; head is v${head}`)

  // --- If-Match: a caller-supplied expected version ---
  yield* Console.log("\n=== If-Match expected version ===")
  // #region if-match
  // The client last saw m-1 at version 2; the stream has since moved to 4.
  const stale = yield* handleMatch(
    { matchId: "m-1" },
    { _tag: "EndMatch", result: "Abandoned" },
    { expectedVersion: 2 },
  ).pipe(Effect.flip)
  const actual = stale._tag === "VersionConflict" ? stale.actualVersion : undefined
  // → VersionConflict, actualVersion 4 — decide never ran, nothing was retried

  // The version the client saw goes through.
  const matched = yield* handleMatch(
    { matchId: "m-4" },
    { _tag: "CompleteInnings", innings: 1, runs: 220, wickets: 9 },
    { expectedVersion: 1 },
  )
  // #endregion
  yield* Console.log(`Stale: ${stale._tag} (actualVersion ${actual})`)
  yield* Console.log(`Matched: version ${matched.version}`)

  // --- Inline projections: additionalItems derived from the decision ---
  yield* Console.log("\n=== Inline projection ===")
  // #region inline-projection
  const handleProjected = EventStore.commandHandler(matchDecider, matchEvents)

  // Pure form: the read-model row comes from the post-fold state.
  yield* handleProjected(
    { matchId: "m-5" },
    { _tag: "StartMatch", venue: "Eden Park", homeTeam: "NZL", awayTeam: "AUS" },
    {
      additionalItems: ({ state }) => [
        db.entities.MatchStatus.put({ matchId: "m-5", status: state.status }),
      ],
    },
  )

  // Effect form: a projection that reads before it writes.
  yield* handleProjected(
    { matchId: "m-5" },
    { _tag: "EndMatch", result: "NZL won by 4 wickets" },
    {
      additionalItems: ({ state, version }) =>
        Effect.gen(function* () {
          const row = yield* db.entities.MatchStatus.get({ matchId: "m-5" })
          return [
            db.entities.MatchStatus.put({
              matchId: "m-5",
              status: `${row.status} -> ${state.status} (v${version + 1})`,
            }),
          ]
        }),
    },
  )
  // #endregion
  const projectedRow = yield* db.entities.MatchStatus.get({ matchId: "m-5" })
  yield* Console.log(`Projected read model: status=${projectedRow.status}`)

  // --- Inline snapshots + readLatest ---
  yield* Console.log("\n=== Inline snapshots ===")
  // #region inline-snapshot
  const inlineMatchEvents = yield* EventStore.bind(InlineMatchEvents)
  const handleInline = EventStore.commandHandler(matchDecider, inlineMatchEvents)

  yield* handleInline(
    { matchId: "m-6" },
    { _tag: "StartMatch", venue: "Newlands", homeTeam: "SAF", awayTeam: "IND" },
  )
  // The snapshot rides in each append's transaction: current after every command.
  const inlined = yield* handleInline(
    { matchId: "m-6" },
    { _tag: "CompleteInnings", innings: 1, runs: 198, wickets: 10 },
  )
  // #endregion
  yield* Console.log(`State: ${inlined.state.status}, Version: ${inlined.version}`)

  // #region read-latest
  // One Query: the snapshot plus every event after it.
  const loadedState = yield* inlineMatchEvents.readLatest(
    { matchId: "m-6" },
    { consistentRead: true },
  )
  const current = Option.match(loadedState.snapshot, {
    onNone: () => EventStore.fold(matchDecider, loadedState.events),
    onSome: (s) => EventStore.foldFrom(matchDecider, s.state, loadedState.events),
  })
  // → snapshot asOfVersion 2, no events after it, version 2
  // #endregion
  yield* Console.log(
    `readLatest: version ${loadedState.version}, ${loadedState.events.length} events after the snapshot, status=${current.status}`,
  )

  // #region verify-snapshot
  // Inline without `every`: the snapshot is normally at the head, so load it alone.
  const handleLean = EventStore.commandHandler(matchDecider, inlineMatchEvents, {
    verifySnapshot: false,
  })
  // One GetItem of the snapshot, then one transaction.
  const ended = yield* handleLean(
    { matchId: "m-6" },
    { _tag: "EndMatch", result: "SAF won by 6 wickets" },
  )
  // → version 3, status "completed"

  // The snapshot alone; its version is the snapshot's, unverified.
  const lean = yield* inlineMatchEvents.readLatest({ matchId: "m-6" }, { verifySnapshot: false })
  // → snapshot asOfVersion 3, events [], version 3
  // #endregion
  yield* Console.log(
    `verifySnapshot: false: version ${ended.version}, status=${ended.state.status}; readLatest version ${lean.version}`,
  )

  // #region head-proof-snapshot
  // The inline snapshot proves the head, so no contiguity check is written.
  const handleProved = EventStore.commandHandler(matchDecider, inlineMatchEvents, {
    headProof: "snapshot",
  })
  yield* handleProved(
    { matchId: "m-7" },
    { _tag: "StartMatch", venue: "Eden Gardens", homeTeam: "IND", awayTeam: "AUS" },
  )
  // [event put, snapshot put conditioned on asOfVersion = 1]
  const proved = yield* handleProved(
    { matchId: "m-7" },
    { _tag: "CompleteInnings", innings: 1, runs: 305, wickets: 10 },
  )
  // → version 2
  // #endregion
  yield* Console.log(`headProof "snapshot": version ${proved.version}`)

  // --- Large commands: stepped commands ---
  yield* Console.log("\n=== Stepped commands ===")
  // #region stepped-command
  const deliveries = yield* EventStore.bind(Deliveries)
  const handleDeliveries = EventStore.commandHandler(deliveryDecider, deliveries, {
    idempotency: { ttl: Duration.days(1) },
  })

  // A fixed step size, not one computed from event sizes: event content varies.
  const STEP_SIZE = 50

  /**
   * Run one large command as fixed-size steps, chained by `expectedVersion`.
   * Redelivered with the same `commandId` and `expectedVersion`, it resumes.
   */
  const stepped = (
    matchId: string,
    balls: ReadonlyArray<number>,
    toCommand: (step: ReadonlyArray<number>) => DeliveryCommand,
    commandId: string,
    expectedVersion: number,
  ) =>
    Effect.gen(function* () {
      let version = expectedVersion
      let skipping = false
      for (let n = 0; n * STEP_SIZE < balls.length; n++) {
        const step = balls.slice(n * STEP_SIZE, (n + 1) * STEP_SIZE)
        // An ordinary command: decide, fold, one atomic append with its own
        // snapshot and sentinel. Each step has its own commandId.
        const run = (expected: number) =>
          handleDeliveries({ matchId }, toCommand(step), {
            commandId: `${commandId}#step-${n}`,
            expectedVersion: expected,
          }).pipe(Effect.map((result) => result.version))
        const committed = yield* run(version).pipe(
          // An earlier delivery committed this step. Keep the stale version, so
          // the next step is checked against its sentinel too, before `decide`.
          Effect.catchTag("DuplicateCommand", () => Effect.succeed(undefined)),
          // After skipped steps: the first step not committed. Run it at the head.
          Effect.catchTag("VersionConflict", (conflict) =>
            skipping && conflict.actualVersion !== undefined
              ? run(conflict.actualVersion)
              : Effect.fail(conflict),
          ),
        )
        skipping = committed === undefined
        if (committed !== undefined) version = committed
      }
      // Every step was committed before: the stream's head.
      return skipping
      ? yield* deliveries.currentVersion({ matchId }, { consistentRead: true })
      : version
    })

  const feed = Array.from({ length: 150 }, (_, i) => i + 1)
  const record = (balls: ReadonlyArray<number>): DeliveryCommand => ({
    _tag: "RecordDeliveries",
    balls,
  })
  const revert = (balls: ReadonlyArray<number>): DeliveryCommand => ({
    _tag: "RevertDeliveries",
    balls,
  })

  // One decision of 150 events cannot be one atomic append.
  const tooLarge = yield* handleDeliveries({ matchId: "m-8" }, record(feed), {
    commandId: "feed-1",
  }).pipe(Effect.flip)
  // → AppendTooLarge (count 152, limit 100) — nothing written

  const imported = yield* stepped("m-8", feed, record, "feed-1", 0)
  // → version 150, in three atomic steps

  // The compensating undo: planned newest first, in the same fixed-size steps.
  const undone = yield* stepped("m-8", [...feed].reverse(), revert, "undo-1", imported)
  // → version 300. A failure partway stops at the last step's real state.

  // Redelivered (its response lost): every step is a duplicate, nothing is written.
  const redelivered = yield* stepped("m-8", [...feed].reverse(), revert, "undo-1", imported)
  // → version 300
  // #endregion
  yield* Console.log(
    `One command: ${tooLarge._tag}; stepped import: v${imported}; stepped undo: v${undone}; redelivered undo: v${redelivered}`,
  )

  // --- Stream indexes ---
  yield* Console.log("\n=== Stream indexes ===")
  // #region index-table
  const fragments = EventStore.indexDefinitions(Scorecards)
  yield* client.createTable({
    TableName: scorecardConfig.name,
    BillingMode: "PAY_PER_REQUEST",
    KeySchema: [
      { AttributeName: "pk", KeyType: "HASH" },
      { AttributeName: "sk", KeyType: "RANGE" },
    ],
    AttributeDefinitions: [
      { AttributeName: "pk", AttributeType: "S" },
      { AttributeName: "sk", AttributeType: "S" },
      ...fragments.AttributeDefinitions,
    ],
    LocalSecondaryIndexes: fragments.LocalSecondaryIndexes,
    GlobalSecondaryIndexes: fragments.GlobalSecondaryIndexes,
  })
  // #endregion

  // #region index-read
  const scorecards = yield* EventStore.bind(Scorecards)
  yield* scorecards.append(
    { matchId: "m-10" },
    [
      new MatchStarted({ venue: "Lords", homeTeam: "ENG", awayTeam: "AUS" }),
      new InningsCompleted({ innings: 1, runs: 245, wickets: 10 }),
      new InningsCompleted({ innings: 2, runs: 310, wickets: 7 }),
      new InningsCompleted({ innings: 3, runs: 120, wickets: 10 }),
      new InningsCompleted({ innings: 4, runs: 56, wickets: 2 }),
    ],
    0,
  )

  // LSI sub-stream: the second-half innings, strongly consistent.
  const secondHalf = yield* scorecards.readIndex(
    "byInnings",
    { matchId: "m-10" },
    { between: ["INNINGS#0003", "INNINGS#0004"], consistentRead: true },
  )
  // → versions 4 and 5 (MatchStarted is not in the index)

  // GSI sub-stream: the highest-scoring innings.
  const [top] = yield* scorecards.readIndex(
    "byRuns",
    { matchId: "m-10" },
    { reverse: true, limit: 1 },
  )
  // → innings 2, 310 runs

  // query.index composes with the Query combinators.
  const firstInnings = yield* scorecards.provide(
    scorecards.query
      .index("byInnings", { matchId: "m-10" })
      .pipe(Query.where({ beginsWith: "INNINGS#0001" }), Query.consistentRead(), Query.collect),
  )
  // #endregion
  yield* Console.log(`Second half: versions ${secondHalf.map((e) => e.version).join(", ")}`)
  if (top !== undefined && top.data._tag === "InningsCompleted") {
    yield* Console.log(`Top innings: #${top.data.innings} with ${top.data.runs} runs`)
  }
  yield* Console.log(`First innings: ${firstInnings.length} event`)

  // --- Event metadata ---
  yield* Console.log("\n=== Event metadata ===")
  // #region append-metadata
  const audited = yield* EventStore.bind(AuditedMatchEvents)

  // One value for the whole append: every event carries a copy.
  yield* audited.append(
    { matchId: "m-20" },
    [
      new MatchStarted({ venue: "WACA", homeTeam: "AUS", awayTeam: "SL" }),
      new InningsCompleted({ innings: 1, runs: 301, wickets: 9 }),
    ],
    0,
    { metadata: { correlationId: "req-81c2" } },
  )
  // → v1 and v2 both carry { correlationId: "req-81c2" }
  // #endregion
  const shared = yield* audited.read({ matchId: "m-20" })
  yield* Console.log(
    `Shared: ${shared.map((e) => `v${e.version} ${e.metadata?.correlationId}`).join(", ")}`,
  )

  // #region event-metadata
  // An import from a previous store: each event keeps its original id.
  yield* audited.append(
    { matchId: "m-21" },
    [
      new MatchStarted({ venue: "Kensington Oval", homeTeam: "WI", awayTeam: "ENG" }),
      new InningsCompleted({ innings: 1, runs: 202, wickets: 10 }),
      new InningsCompleted({ innings: 2, runs: 205, wickets: 4 }),
    ],
    0,
    {
      eventMetadata: [
        { correlationId: "import-17", sourceId: "legacy-118" },
        // `undefined`: this event is written without metadata.
        undefined,
        { correlationId: "import-17", sourceId: "legacy-121" },
      ],
    },
  )

  // Each event reads back with its own entry.
  const importedEvents = yield* audited.read({ matchId: "m-21" })
  const sourceIds = importedEvents.map((event) => event.metadata?.sourceId)
  // → ["legacy-118", undefined, "legacy-121"]
  // #endregion
  yield* Console.log(
    `Imported source ids: ${sourceIds.map((id) => id ?? "(none)").join(", ")}`,
  )

  // #region handler-event-metadata
  // One ULID per event: its time comes from the Clock, its random bits from
  // the Crypto service.
  const crypto = yield* Crypto.Crypto
  const mintEventIds = (correlationId: string, events: ReadonlyArray<MatchEvent>) =>
    Effect.forEach(events, () =>
      Effect.map(crypto.randomULID, (eventId) => ({ correlationId, eventId })),
    )

  // Idempotent: a redelivered command fails with DuplicateCommand, so the ids
  // of its first commit are the only ones ever written.
  const handleAudited = EventStore.commandHandler(matchDecider, audited, {
    idempotency: { ttl: Duration.days(1) },
  })

  // A function of the decision: one entry per event `decide` returned.
  yield* handleAudited(
    { matchId: "m-22" },
    { _tag: "StartMatch", venue: "Adelaide Oval", homeTeam: "AUS", awayTeam: "WI" },
    { commandId: "msg-4470", eventMetadata: ({ events }) => mintEventIds("msg-4470", events) },
  )
  // → v1 carries an eventId such as "01M4M3EK1SVFC94QZ8SC9H0ZPW"

  // A message delivered twice, its first response lost.
  const completeInnings = handleAudited(
    { matchId: "m-22" },
    { _tag: "CompleteInnings", innings: 1, runs: 289, wickets: 10 },
    { commandId: "msg-4471", eventMetadata: ({ events }) => mintEventIds("msg-4471", events) },
  )
  yield* completeInnings
  const duplicate = yield* Effect.flip(completeInnings)
  // → DuplicateCommand: v2 keeps the eventId of the first delivery
  // #endregion
  const handled = yield* audited.read({ matchId: "m-22" })
  yield* Console.log(
    `Handler event ids: ${handled.map((e) => `v${e.version} ${e.metadata?.eventId}`).join(", ")}`,
  )
  yield* Console.log(`Redelivery: ${duplicate._tag}`)

  // #region event-timestamps
  // History from a previous store, each record with its own id and the time
  // it happened.
  const legacyRecords = [
    {
      sourceId: "legacy-204",
      occurredAt: "2025-01-02T23:30:00Z",
      event: new MatchStarted({ venue: "SCG", homeTeam: "AUS", awayTeam: "IND" }),
    },
    {
      sourceId: "legacy-205",
      occurredAt: "2025-01-03T06:40:00Z",
      event: new InningsCompleted({ innings: 1, runs: 185, wickets: 10 }),
    },
    {
      sourceId: "legacy-206",
      occurredAt: "2025-01-04T04:15:00Z",
      event: new InningsCompleted({ innings: 2, runs: 181, wickets: 10 }),
    },
  ]

  // One append keeps every event's original time: entry `i` of
  // `eventTimestamps` is event `i`'s timestamp (`undefined` keeps the
  // append's own time). It combines with either metadata option.
  yield* audited.append(
    { matchId: "m-23" },
    legacyRecords.map((record) => record.event),
    0,
    {
      eventMetadata: legacyRecords.map((record) => ({
        correlationId: "import-18",
        sourceId: record.sourceId,
      })),
      eventTimestamps: legacyRecords.map((record) => DateTime.makeUnsafe(record.occurredAt)),
    },
  )

  // Each event reads back with its own time, in UTC.
  const history = yield* audited.read({ matchId: "m-23" })
  const occurred = history.map((event) => `${event.metadata?.sourceId} ${event.timestamp}`)
  // → ["legacy-204 2025-01-02T23:30:00.000Z", "legacy-205 2025-01-03T06:40:00.000Z", …]
  // #endregion
  yield* Console.log(`Imported history:\n  ${occurred.join("\n  ")}`)

  // #region handler-event-timestamps-effect
  // Through the handler, the times can come from an effect — here a lookup in
  // the import's source log, which fails if a record is missing. The effect's
  // error and requirements join the handler's.
  const sourceLog = new Map([["m-24:MatchStarted", "2025-02-01T09:00:00Z"]])
  const originalTime = (key: string) =>
    Effect.fromNullishOr(sourceLog.get(key)).pipe(Effect.map((iso) => DateTime.makeUnsafe(iso)))

  const handleImport = EventStore.commandHandler(matchDecider, audited)
  yield* handleImport(
    { matchId: "m-24" },
    { _tag: "StartMatch", venue: "Basin Reserve", homeTeam: "NZL", awayTeam: "SL" },
    {
      eventTimestamps: ({ events }) =>
        Effect.forEach(events, (event) => originalTime(`m-24:${event._tag}`)),
    },
  )
  // → v1 is stamped 2025-02-01T09:00:00.000Z
  // #endregion
  const sourced = yield* audited.read({ matchId: "m-24" })
  yield* Console.log(`Handler-sourced time: ${sourced.map((e) => e.timestamp).join(", ")}`)

  // --- Stream index projection ---
  yield* Console.log("\n=== Stream index projection ===")
  // #region index-projection-table
  const projected = EventStore.indexDefinitions(AuditedScorecards)
  // byInnings (LSI) → Projection: { ProjectionType: "INCLUDE", NonKeyAttributes:
  //   ["__edd_e__", "data", "eventType", "streamId", "timestamp", "version"] }
  // byRuns (GSI)    → Projection: { ProjectionType: "INCLUDE", NonKeyAttributes: ["__edd_e__"] }
  yield* client.createTable({
    TableName: auditedScorecardConfig.name,
    BillingMode: "PAY_PER_REQUEST",
    KeySchema: [
      { AttributeName: "pk", KeyType: "HASH" },
      { AttributeName: "sk", KeyType: "RANGE" },
    ],
    AttributeDefinitions: [
      { AttributeName: "pk", AttributeType: "S" },
      { AttributeName: "sk", AttributeType: "S" },
      ...projected.AttributeDefinitions,
    ],
    LocalSecondaryIndexes: projected.LocalSecondaryIndexes,
    GlobalSecondaryIndexes: projected.GlobalSecondaryIndexes,
  })
  // #endregion
  const emitted = [
    ...(projected.LocalSecondaryIndexes ?? []),
    ...(projected.GlobalSecondaryIndexes ?? []),
  ].map((index) => `${index.IndexName} ${JSON.stringify(index.Projection)}`)
  yield* Console.log(`Projections:\n  ${emitted.join("\n  ")}`)

  // #region index-projection-read
  const auditedScorecards = yield* EventStore.bind(AuditedScorecards)
  yield* auditedScorecards.append(
    { matchId: "m-30" },
    [
      new MatchStarted({ venue: "Eden Park", homeTeam: "NZL", awayTeam: "ENG" }),
      new InningsCompleted({ innings: 1, runs: 278, wickets: 10 }),
      new InningsCompleted({ innings: 2, runs: 301, wickets: 8 }),
    ],
    0,
    { metadata: { correlationId: "req-9a41" } },
  )

  // "withoutMetadata": the index does not hold metadata, so it reads as
  // undefined — and its type is `undefined`, so it cannot be read by mistake.
  const innings = yield* auditedScorecards.readIndex(
    "byInnings",
    { matchId: "m-30" },
    { consistentRead: true },
  )
  // → [v2, v3], each with metadata: undefined

  // "keys": the query finds the entries, then the events are fetched from the
  // table, so metadata is there.
  const byRuns = yield* auditedScorecards.readIndex(
    "byRuns",
    { matchId: "m-30" },
    { reverse: true },
  )
  // → [v3, v2], each with metadata { correlationId: "req-9a41" }
  // #endregion
  const slim = innings.map((e) => `v${e.version} metadata=${String(e.metadata)}`)
  yield* Console.log(`Through byInnings: ${slim.join(", ")}`)
  const hydrated = byRuns.map((e) => `v${e.version} ${e.metadata?.correlationId}`)
  yield* Console.log(`Through byRuns: ${hydrated.join(", ")}`)

  // --- Shared indexes ---
  yield* Console.log("\n=== Shared indexes ===")
  // #region shared-index-table
  const seriesIndexes = EventStore.indexDefinitions(SeriesMatches, SeriesSquads, Umpires)
  // gsi1 once, Projection ALL: the three streams declare it alike.
  yield* client.createTable({
    TableName: seriesConfig.name,
    BillingMode: "PAY_PER_REQUEST",
    KeySchema: [
      { AttributeName: "pk", KeyType: "HASH" },
      { AttributeName: "sk", KeyType: "RANGE" },
    ],
    AttributeDefinitions: [
      { AttributeName: "pk", AttributeType: "S" },
      { AttributeName: "sk", AttributeType: "S" },
      ...seriesIndexes.AttributeDefinitions,
    ],
    GlobalSecondaryIndexes: seriesIndexes.GlobalSecondaryIndexes,
  })
  // #endregion
  yield* Console.log(
    `Indexes: ${(seriesIndexes.GlobalSecondaryIndexes ?? []).map((index) => index.IndexName).join(", ")}`,
  )

  // #region shared-index-read
  const seriesMatches = yield* EventStore.bind(SeriesMatches)
  const handleSeriesMatch = EventStore.commandHandler(matchDecider, seriesMatches)
  const firstTest = { seriesId: "ashes-25", matchId: "t1" }
  yield* handleSeriesMatch(firstTest, {
    _tag: "StartMatch",
    venue: "Perth",
    homeTeam: "AUS",
    awayTeam: "ENG",
  })
  yield* handleSeriesMatch(firstTest, { _tag: "CompleteInnings", innings: 1, runs: 172, wickets: 10 })

  const squads = yield* EventStore.bind(SeriesSquads)
  yield* squads.append(
    { seriesId: "ashes-25", team: "ENG" },
    [new SquadNamed({ players: ["Root", "Stokes", "Wood"] })],
    0,
  )
  const umpires = yield* EventStore.bind(Umpires)
  yield* umpires.append(
    { umpireId: "u-7" },
    [new UmpireAppointed({ seriesId: "ashes-25", matchId: "t1" })],
    0,
  )

  // Another service reading the partition directly gets every stream's
  // events, and each match's snapshot.
  const series = yield* client.query({
    TableName: seriesConfig.name,
    IndexName: "gsi1",
    KeyConditionExpression: "#pk = :pk",
    ExpressionAttributeNames: { "#pk": "gsi1pk" },
    ExpressionAttributeValues: { ":pk": { S: "SERIES#ashes-25" } },
  })
  // → MATCH#t1#EVT#0001, MATCH#t1#EVT#0002, MATCH#t1#STATE,
  //   SQUAD#ENG#EVT#0001, UMPIRE#u-7#EVT#0001

  // A stream reads its own events in the partition: pass the partition.
  const t1 = yield* seriesMatches.readIndex("bySeries", firstTest, {
    partition: "SERIES#ashes-25",
  })
  // → v1 and v2 of match t1 only
  // #endregion
  const sortKeys = (series.Items ?? []).map((item) => item.gsi1sk?.S)
  yield* Console.log(`Series partition:\n  ${sortKeys.join("\n  ")}`)
  yield* Console.log(`Match t1 through bySeries: ${t1.map((e) => `v${e.version}`).join(", ")}`)

  // --- State from the application's own record ---
  yield* Console.log("\n=== loadState + headProof ===")
  const recordConfig = yield* RecordTable.Tag
  yield* client
    .deleteTable({ TableName: recordConfig.name })
    .pipe(Effect.catchTag("ResourceNotFoundError", () => Effect.void))
  yield* client.createTable({
    TableName: recordConfig.name,
    BillingMode: "PAY_PER_REQUEST",
    ...Table.definition(RecordTable),
  })
  // #region load-state
  const recordedMatches = yield* EventStore.bind(RecordedMatches)
  const handleRecorded = EventStore.commandHandler(matchDecider, recordedMatches, {
    // State and head from the record, read strongly consistent; none is a new match.
    loadState: ({ matchId }) =>
      Effect.gen(function* () {
        const record = yield* Entity.consistentRead(MatchRecords.get({ matchId }))
        return Option.some({ state: record.state, version: record.streamVersion })
      }).pipe(Effect.catchTag("ItemNotFound", () => Effect.succeed(Option.none()))),
    // The record at additionalItems[0] proves the head: no contiguity check.
    headProof: { additionalItem: 0 },
    retry: 3,
  })

  yield* handleRecorded(
    { matchId: "m-8" },
    { _tag: "StartMatch", venue: "Gabba", homeTeam: "AUS", awayTeam: "IND" },
    { additionalItems: recordOf("m-8") },
  )
  // Loaded from the record: one GetItem, then [event put, record put].
  const recorded = yield* handleRecorded(
    { matchId: "m-8" },
    { _tag: "CompleteInnings", innings: 1, runs: 260, wickets: 10 },
    { additionalItems: recordOf("m-8") },
  )
  // → version 2; the record holds the same state at streamVersion 2
  // #endregion
  const stored = yield* Entity.consistentRead(MatchRecords.get({ matchId: "m-8" }))
  yield* Console.log(
    `loadState: version ${recorded.version}; record at streamVersion ${stored.streamVersion}`,
  )
  yield* client.deleteTable({ TableName: recordConfig.name })

  // --- Sealing a stream ---
  yield* Console.log("\n=== Sealing a stream ===")
  const ledgerConfig = yield* LedgerTable.Tag
  yield* client
    .deleteTable({ TableName: ledgerConfig.name })
    .pipe(Effect.catchTag("ResourceNotFoundError", () => Effect.void))
  yield* client.createTable({
    TableName: ledgerConfig.name,
    BillingMode: "PAY_PER_REQUEST",
    ...Table.definition(LedgerTable),
  })

  // #region seal-append
  const ledgers = yield* EventStore.bind(Ledgers)
  const closing = { accountId: "acc-9", generation: "1" }
  yield* ledgers.append(
    closing,
    [new LedgerOpened({ balance: 0 }), new Deposited({ amount: 40 })],
    0,
  )

  // The account closes for good: this append's last event is the stream's last.
  const sealedAt = yield* ledgers.append(
    closing,
    [new Withdrawn({ amount: 40 }), new LedgerClosed({ reason: "account closed" })],
    2,
    { seal: true },
  )
  // → version 4; event 4 carries the seal marker
  // #endregion
  yield* Console.log(`Sealed acc-9 generation 1 at version ${sealedAt.version}`)

  // #region sealed-read
  const closed = yield* ledgers.readLatest(closing, { consistentRead: true })
  // → closed.seal: the LedgerClosed event at version 4, closed.version 4

  const closedEvents = yield* ledgers.read(closing, { consistentRead: true })
  const final = closedEvents.at(-1)
  // → final.sealed === true; no other event carries `sealed`
  // #endregion
  assertEq(closed.seal?.version, 4, "readLatest reports the seal")
  assertEq(final?.sealed, true, "the sealing event is marked")
  yield* Console.log(
    `readLatest: seal at v${closed.seal?.version} (${closed.seal?.eventType}), head v${closed.version}`,
  )

  // #region sealed-handler
  const handleLedger = EventStore.commandHandler(ledgerDecider, ledgers, { retry: 3 })

  const outcome = yield* handleLedger(closing, { _tag: "Deposit", amount: 10 }).pipe(
    Effect.map((result) => `deposited at v${result.version}`),
    Effect.catchTag("StreamSealed", (sealed) =>
      Effect.succeed(`refused: ${sealed.streamId} is sealed at v${sealed.sealedVersion}`),
    ),
  )
  // → "refused: acc-9#1 is sealed at v4": seen on load, before decide, never retried

  // A raw append at the head fails the same way.
  const late = yield* ledgers
    .append(closing, [new Deposited({ amount: 10 })], 4)
    .pipe(Effect.flip)
  // → StreamSealed { sealedVersion: 4 }
  // #endregion
  assertEq(late._tag, "StreamSealed", "an append past the seal is refused")
  yield* Console.log(`Handler: ${outcome}`)
  yield* Console.log(`Raw append: ${late._tag}`)

  // --- Generation changeover ---
  yield* Console.log("\n=== Generation changeover ===")
  // Generation 1 is open, and the chain index names it.
  yield* ledgers.append(
    { accountId: "acc-1", generation: "1" },
    [new LedgerOpened({ balance: 0 }), new Deposited({ amount: 250 })],
    0,
    {
      additionalItems: [
        LedgerChains.create({
          accountId: "acc-1",
          current: "1",
          revision: 1,
          generations: [{ generation: "1" }],
        }),
      ],
    },
  )

  // #region changeover
  // Close generation `from`, open `to`, and move the chain index: one transaction.
  const changeover = (accountId: string, from: string, to: string) =>
    Effect.gen(function* () {
      const closingGeneration = { accountId, generation: from }
      // ONE read gives the carried-over state AND the version the seal goes at.
      const latest = yield* ledgers.readLatest(closingGeneration, { consistentRead: true })
      if (latest.seal !== undefined) return latest.seal.version // already closed
      const carried = EventStore.fold(ledgerDecider, latest.events)

      // The chain index, read-modify-write: the whole item, rebuilt from this
      // read, replaced only if no writer has changed it since.
      const chain = yield* Entity.consistentRead(LedgerChains.get({ accountId }))
      const nextChain = LedgerChains.put({
        accountId,
        current: to,
        revision: chain.revision + 1,
        generations: [
          ...chain.generations.map((entry) =>
            entry.generation === from ? { ...entry, validThrough: latest.version + 1 } : entry,
          ),
          { generation: to },
        ],
      }).pipe(LedgerChains.condition({ revision: chain.revision }))

      yield* ledgers.append(
        { accountId, generation: to },
        [
          new LedgerOpened({
            balance: carried.balance,
            continuesFrom: { generation: from, version: latest.version },
          }),
        ],
        0,
        {
          additionalItems: [
            // Generation `from` sealed at the version its state was read at.
            ledgers.appendOp(
              closingGeneration,
              [new LedgerClosed({ reason: "restored", continuedIn: to })],
              latest.version,
              { seal: true },
            ),
            nextChain,
          ],
        },
      )
      return latest.version + 1
    }).pipe(
      // A stale append on `from`, or another writer of the chain index, since
      // the reads: read both again, carrying the stale append forward.
      Effect.retry({
        times: 3,
        while: (error) =>
          error._tag === "VersionConflict" || error._tag === "AdditionalItemConditionFailed",
      }),
    )

  const sealedVersion = yield* changeover("acc-1", "1", "2")
  // → 3: generation 1 ends at its LedgerClosed event; generation 2 opens at
  //   version 1 with balance 250, continuing from generation 1 at version 2
  // #endregion
  const opened = yield* ledgers.read({ accountId: "acc-1", generation: "2" }, { consistentRead: true })
  const chain = yield* Entity.consistentRead(LedgerChains.get({ accountId: "acc-1" }))
  assertEq(sealedVersion, 3, "generation 1 is sealed at version 3")
  assertEq(chain.revision, 2, "the chain index moved once")
  const openedEvent = opened[0]?.data
  yield* Console.log(
    `Generation 1 sealed at v${sealedVersion}; generation 2 opened with ${openedEvent?._tag === "LedgerOpened" ? `balance ${openedEvent.balance}` : "?"}`,
  )
  yield* Console.log(
    `Chain: current ${chain.current}, revision ${chain.revision}, generations ${JSON.stringify(chain.generations)}`,
  )

  // --- Atomic multi-stream append ---
  yield* Console.log("\n=== Atomic multi-stream append ===")
  const savings = { accountId: "acc-2", generation: "1" }
  yield* ledgers.append(savings, [new LedgerOpened({ balance: 0 })], 0)
  // #region multi-stream-append
  // A transfer: both ledgers' events commit together, or neither does.
  const transfer = yield* ledgers.append(
    { accountId: "acc-1", generation: "2" },
    [new Withdrawn({ amount: 75 })],
    1,
    { additionalItems: [ledgers.appendOp(savings, [new Deposited({ amount: 75 })], 1)] },
  )
  // → acc-1 generation 2 at version 2, acc-2 generation 1 at version 2
  // #endregion
  const savingsHead = yield* ledgers.currentVersion(savings, { consistentRead: true })
  yield* Console.log(`Transfer: acc-1 v${transfer.version}, acc-2 v${savingsHead}`)
  yield* client.deleteTable({ TableName: ledgerConfig.name })

  // --- Cleanup ---
  yield* Console.log("\n=== Cleanup ===")
  yield* client.deleteTable({ TableName: tableConfig.name })
  yield* client.deleteTable({ TableName: scorecardConfig.name })
  yield* client.deleteTable({ TableName: auditedScorecardConfig.name })
  yield* client.deleteTable({ TableName: seriesConfig.name })
  yield* Console.log("Tables deleted.")
})

// ---------------------------------------------------------------------------
// 12. Provide dependencies and run
// ---------------------------------------------------------------------------

// #region crypto-layer
// Effect core ships no default Crypto service. This one is backed by the Web
// Crypto API (`globalThis.crypto`): Node 19+ (Node 18 only with
// --experimental-global-webcrypto), browsers and edge runtimes.
const WebCrypto = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
    digest: (algorithm, data) =>
      Effect.tryPromise({
        try: () => globalThis.crypto.subtle.digest(algorithm, new Uint8Array(data)),
        catch: (cause) =>
          PlatformError.badArgument({ module: "Crypto", method: "digest", cause }),
      }).pipe(Effect.map((digest) => new Uint8Array(digest))),
  }),
)
// #endregion

// #region layer-setup
const AppLayer = Layer.mergeAll(
  DynamoClient.layerConfig({
    region: Config.succeed("us-east-1"),
    endpoint: Config.String("DYNAMODB_ENDPOINT").pipe(Config.withDefault("http://localhost:8000")),
    credentials: Config.succeed({ accessKeyId: "local", secretAccessKey: "local" }),
  }),
  EventsTable.layer({ name: "event-sourcing-example" }),
  ScorecardTable.layer({ name: "event-sourcing-scorecards" }),
  AuditedScorecardTable.layer({ name: "event-sourcing-audited-scorecards" }),
  SeriesTable.layer({ name: "event-sourcing-series" }),
  RecordTable.layer({ name: "event-sourcing-records" }),
  LedgerTable.layer({ name: "event-sourcing-ledgers" }),
  WebCrypto,
)

const main = program.pipe(Effect.provide(AppLayer))

Effect.runPromise(main).then(() => console.log("\nDone."))
// #endregion
