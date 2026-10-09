/**
 * Event Sourcing example — effect-dynamodb EventStore
 *
 * Demonstrates: event stream definition, decider pattern, command handler,
 * append/read/readFrom/currentVersion operations, fold helpers, Query combinators,
 * snapshots, atomic side writes, idempotency, consistent reads, If-Match
 * expected versions, inline projections, inline snapshots + readLatest,
 * large commands as stepped commands, and stream indexes.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *
 * Run (DYNAMODB_ENDPOINT overrides the default http://localhost:8000):
 *   npx tsx examples/event-sourcing.ts
 */

import { Config, Console, Data, Duration, Effect, Layer, Option, Schema } from "effect"

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
// 8. Main program
// ---------------------------------------------------------------------------

const program = Effect.gen(function* () {
  const client = yield* DynamoClient
  const tableConfig = yield* EventsTable.Tag
  const scorecardConfig = yield* ScorecardTable.Tag

  // --- Bind event stream ---
  // #region command-handler
  const matchEvents = yield* EventStore.bind(MatchEvents)
  const handleMatch = EventStore.commandHandler(matchDecider, matchEvents)
  // #endregion

  // --- Create table ---
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

  // --- Cleanup ---
  yield* Console.log("\n=== Cleanup ===")
  yield* client.deleteTable({ TableName: tableConfig.name })
  yield* client.deleteTable({ TableName: scorecardConfig.name })
  yield* Console.log("Tables deleted.")
})

// ---------------------------------------------------------------------------
// 9. Provide dependencies and run
// ---------------------------------------------------------------------------

// #region layer-setup
const AppLayer = Layer.mergeAll(
  DynamoClient.layerConfig({
    region: Config.succeed("us-east-1"),
    endpoint: Config.String("DYNAMODB_ENDPOINT").pipe(Config.withDefault("http://localhost:8000")),
    credentials: Config.succeed({ accessKeyId: "local", secretAccessKey: "local" }),
  }),
  EventsTable.layer({ name: "event-sourcing-example" }),
  ScorecardTable.layer({ name: "event-sourcing-scorecards" }),
)

const main = program.pipe(Effect.provide(AppLayer))

Effect.runPromise(main).then(
  () => console.log("\nDone."),
  (err) => console.error("Failed:", err),
)
// #endregion
