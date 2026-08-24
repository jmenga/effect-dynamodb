/**
 * Event Sourcing example — effect-dynamodb EventStore
 *
 * Demonstrates: event stream definition, decider pattern, command handler,
 * append/read/readFrom/currentVersion operations, fold helpers, Query combinators.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *
 * Run:
 *   npx tsx examples/event-sourcing.ts
 */

import { Console, Data, Duration, Effect, Layer, Option, Schema } from "effect"

import { DynamoClient } from "../src/DynamoClient.js"
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

const EventsTable = Table.make({ schema: AppSchema, entities: { Watermarks } })
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

// ---------------------------------------------------------------------------
// 6. Main program
// ---------------------------------------------------------------------------

const program = Effect.gen(function* () {
  const client = yield* DynamoClient
  const tableConfig = yield* EventsTable.Tag

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

  // --- Cleanup ---
  yield* Console.log("\n=== Cleanup ===")
  yield* client.deleteTable({ TableName: tableConfig.name })
  yield* Console.log("Table deleted.")
})

// ---------------------------------------------------------------------------
// 6. Provide dependencies and run
// ---------------------------------------------------------------------------

// #region layer-setup
const AppLayer = Layer.mergeAll(
  DynamoClient.layer({
    region: "us-east-1",
    endpoint: "http://localhost:8000",
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  }),
  EventsTable.layer({ name: "event-sourcing-example" }),
)

const main = program.pipe(Effect.provide(AppLayer))

Effect.runPromise(main).then(
  () => console.log("\nDone."),
  (err) => console.error("Failed:", err),
)
// #endregion
