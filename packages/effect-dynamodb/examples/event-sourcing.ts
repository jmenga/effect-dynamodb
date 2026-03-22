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

import { Console, Data, Effect, Layer, Schema } from "effect"

import { DynamoClient } from "../src/DynamoClient.js"
import * as DynamoSchema from "../src/DynamoSchema.js"
import * as EventStore from "../src/EventStore.js"
import * as Query from "../src/Query.js"
import * as Table from "../src/Table.js"

// ---------------------------------------------------------------------------
// 1. Infrastructure — Schema + Table
// ---------------------------------------------------------------------------

// #region infrastructure
const AppSchema = DynamoSchema.make({ name: "cricket", version: 1 })
const EventsTable = Table.make({ schema: AppSchema })
// #endregion

// ---------------------------------------------------------------------------
// 2. Events — pure domain Schema.Class definitions
// ---------------------------------------------------------------------------

// #region events
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
// 5. Main program
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
