/**
 * Connected tests for `commandHandler({ checkStateUse: true })` (#290)
 * against a real DynamoDB Local (run with `escapeKeys` off and on).
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 *
 * A `decide` that changes the state it was given is a defect (`EDD-9183`)
 * naming the stream, the command and the first changed path, on a stream
 * load, a new stream, an inline snapshot (verified and unverified) and a
 * `loadState` record; an in-place `evolve` changing a shared `initialState`
 * is a defect (`EDD-9184`) on load and on the fold. Each leaves the stored
 * stream and snapshot as they were. A well-behaved decider passes with the
 * option on and off and sends the same requests either way, and a state
 * holding `Schema.Class`, `Option` and `DateTime` values compares by value.
 */

import { it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Cause, Config, DateTime, Effect, Exit, Layer, Option, Schema } from "effect"
import { afterAll, beforeAll, describe, expect } from "vitest"
import { DynamoClient, type DynamoClientService } from "../src/DynamoClient.js"
import * as EventStore from "../src/EventStore.js"
import * as Table from "../src/Table.js"

const ENDPOINT = Effect.runSync(
  Config.String("DYNAMODB_ENDPOINT").pipe(Config.withDefault("http://localhost:8000")),
)

let dynamoAvailable = false
try {
  const res = await fetch(ENDPOINT, { method: "POST", signal: AbortSignal.timeout(1000) }).catch(
    () => null,
  )
  dynamoAvailable = res !== null
} catch {
  dynamoAvailable = false
}

const describeConnected = dynamoAvailable ? describe : describe.skip

const AppSchema = DynamoSchema.make({ name: "csu-it", version: 1 })
const tableName = `check-state-use-${Date.now()}`
const MatchTable = Table.make({ schema: AppSchema, entities: {} })

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

class Started extends Schema.TaggedClass<Started>()("Started", { venue: Schema.String }) {}
class Scored extends Schema.TaggedClass<Scored>()("Scored", { overs: Schema.Number }) {}
type MatchEvent = Started | Scored

type MatchCommand =
  | { readonly _tag: "Start"; readonly venue: string }
  | { readonly _tag: "Score"; readonly overs: number }

const MatchStateSchema = Schema.Struct({
  status: Schema.String,
  innings: Schema.Array(Schema.Struct({ overs: Schema.Number })),
})
type MatchState = typeof MatchStateSchema.Type
type Writable = { status: string; innings: Array<{ overs: number }> }

const Plain = EventStore.makeStream({
  table: MatchTable,
  streamName: "Match",
  events: [Started, Scored],
  streamId: { composite: ["matchId"] },
})

const Inline = EventStore.makeStream({
  table: MatchTable,
  streamName: "InlineMatch",
  events: [Started, Scored],
  streamId: { composite: ["matchId"] },
  snapshot: { schema: MatchStateSchema, mode: "inline" },
})

/** A `Schema.Class` state with `Option` and `DateTime` fields, snapshotted inline. */
class Fixture extends Schema.Class<Fixture>("Fixture")({
  venue: Schema.OptionFromNullOr(Schema.String),
  startsAt: Schema.DateTimeUtcFromString,
  overs: Schema.Array(Schema.Number),
}) {}

const Fixtures = EventStore.makeStream({
  table: MatchTable,
  streamName: "Fixture",
  events: [Started, Scored],
  streamId: { composite: ["matchId"] },
  snapshot: { schema: Fixture, mode: "inline" },
})

const decide = (command: MatchCommand): Effect.Effect<ReadonlyArray<MatchEvent>> =>
  Effect.succeed(
    command._tag === "Start"
      ? [new Started({ venue: command.venue })]
      : [new Scored({ overs: command.overs })],
  )

const wellBehaved: EventStore.Decider<MatchState, MatchCommand, MatchEvent> = {
  get initialState(): MatchState {
    return { status: "new", innings: [] }
  },
  decide: (command) => decide(command),
  evolve: (state, event) =>
    event._tag === "Started"
      ? { ...state, status: "live" }
      : { ...state, innings: [...state.innings, { overs: event.overs }] },
}

/** `wellBehaved`, with a `decide` that changes `innings[1].overs` (or `status`) first. */
const mutating: EventStore.Decider<MatchState, MatchCommand, MatchEvent> = {
  get initialState(): MatchState {
    return { status: "new", innings: [] }
  },
  evolve: wellBehaved.evolve,
  decide: (command, state) =>
    Effect.sync(() => {
      const innings = (state as Writable).innings
      if (innings[1] !== undefined) innings[1].overs += 1
      else (state as Writable).status = "tampered"
    }).pipe(Effect.andThen(decide(command))),
}

const inPlace = (): EventStore.Decider<MatchState, MatchCommand, MatchEvent> => ({
  initialState: { status: "new", innings: [] },
  decide: (command) => decide(command),
  evolve: (state, event) => {
    const writable = state as Writable
    if (event._tag === "Started") writable.status = "live"
    else writable.innings.push({ overs: event.overs })
    return state
  },
})

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

/** Every request sent, by operation, in order. */
const requests: Array<string> = []

const RecordingClient = Layer.effect(
  DynamoClient,
  Effect.map(
    DynamoClient,
    (client): DynamoClientService =>
      new Proxy(client, {
        get: (target, name) => {
          const member = target[name as keyof DynamoClientService]
          return typeof member === "function"
            ? (input: unknown) => {
                requests.push(String(name))
                return (member as (input: unknown) => unknown)(input)
              }
            : member
        },
      }),
  ),
).pipe(
  Layer.provide(
    DynamoClient.layer({
      region: "us-east-1",
      endpoint: ENDPOINT,
      credentials: { accessKeyId: "local", secretAccessKey: "local" },
    }),
  ),
)

const provide = Effect.provide(
  Layer.mergeAll(RecordingClient, MatchTable.layer({ name: tableName })),
)

/** The defect message the effect died with (fails the test if it did not die). */
const defectOf = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.map(Effect.exit(effect), (exit) => {
    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
    return String(Cause.squash((exit as Exit.Failure<A, E>).cause))
  })

type Handle<R> = (
  streamId: { readonly matchId: string },
  command: MatchCommand,
) => Effect.Effect<EventStore.CommandHandlerResult<MatchState, MatchEvent>, unknown, R>

/** Three commands: `innings: [{ overs: 3 }, { overs: 4 }]` at version 3. */
const seedWith = <R>(handle: Handle<R>, matchId: string) =>
  Effect.gen(function* () {
    yield* handle({ matchId }, { _tag: "Start", venue: "Lord's" })
    yield* handle({ matchId }, { _tag: "Score", overs: 3 })
    return yield* handle({ matchId }, { _tag: "Score", overs: 4 })
  })

const score: MatchCommand = { _tag: "Score", overs: 5 }

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeConnected("EventStore commandHandler checkStateUse (#290)", () => {
  beforeAll(async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* DynamoClient
        yield* client.createTable({
          TableName: tableName,
          BillingMode: "PAY_PER_REQUEST",
          // Streams only: no entity for `Table.definition` to read.
          KeySchema: [
            { AttributeName: "pk", KeyType: "HASH" },
            { AttributeName: "sk", KeyType: "RANGE" },
          ],
          AttributeDefinitions: [
            { AttributeName: "pk", AttributeType: "S" },
            { AttributeName: "sk", AttributeType: "S" },
          ],
        })
      }).pipe(provide),
    )
  }, 15000)

  afterAll(async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* DynamoClient
        yield* client.deleteTable({ TableName: tableName })
      }).pipe(
        provide,
        Effect.catchTag("ResourceNotFoundError", () => Effect.void),
      ),
    )
  })

  it.effect(
    "decide changing a loaded stream's state: EDD-9183 naming the path; nothing stored",
    () =>
      Effect.gen(function* () {
        yield* seedWith(EventStore.commandHandler(wellBehaved, Plain), "c-1")
        const message = yield* defectOf(
          EventStore.commandHandler(mutating, Plain, { checkStateUse: true })(
            { matchId: "c-1" },
            score,
          ),
        )
        expect(message).toContain("[EDD-9183]")
        expect(message).toContain('EventStream "Match" (c-1), command "Score"')
        expect(message).toContain("at innings[1].overs (was 4, now 5)")
        expect(yield* Plain.currentVersion({ matchId: "c-1" })).toBe(3)
      }).pipe(provide),
  )

  it.effect("decide changing a new stream's state: EDD-9183; nothing stored", () =>
    Effect.gen(function* () {
      const message = yield* defectOf(
        EventStore.commandHandler(mutating, Plain, { checkStateUse: true })(
          { matchId: "c-2" },
          { _tag: "Start", venue: "Lord's" },
        ),
      )
      expect(message).toContain('at status (was "new", now "tampered")')
      expect(yield* Plain.currentVersion({ matchId: "c-2" })).toBe(0)
    }).pipe(provide),
  )

  it.effect("decide changing an inline snapshot's state, verified and unverified", () =>
    Effect.gen(function* () {
      yield* seedWith(EventStore.commandHandler(wellBehaved, Inline), "c-3")
      for (const verifySnapshot of [true, false]) {
        const message = yield* defectOf(
          EventStore.commandHandler(mutating, Inline, { checkStateUse: true, verifySnapshot })(
            { matchId: "c-3" },
            score,
          ),
        )
        expect(message).toContain('EventStream "InlineMatch" (c-3)')
        expect(message).toContain("at innings[1].overs (was 4, now 5)")
      }
      const latest = yield* Inline.readLatest({ matchId: "c-3" })
      expect(latest.version).toBe(3)
      expect(Option.getOrThrow(latest.snapshot).state.innings).toEqual([{ overs: 3 }, { overs: 4 }])
    }).pipe(provide),
  )

  it.effect("decide changing a loadState record: EDD-9183", () =>
    Effect.gen(function* () {
      yield* seedWith(EventStore.commandHandler(wellBehaved, Plain), "c-4")
      const record: MatchState = { status: "live", innings: [{ overs: 3 }, { overs: 4 }] }
      const message = yield* defectOf(
        EventStore.commandHandler(mutating, Plain, {
          checkStateUse: true,
          loadState: () => Effect.succeed(Option.some({ state: record, version: 3 })),
        })({ matchId: "c-4" }, score),
      )
      expect(message).toContain("at innings[1].overs (was 4, now 5)")
      expect(yield* Plain.currentVersion({ matchId: "c-4" })).toBe(3)
    }).pipe(provide),
  )

  it.effect(
    "an in-place evolve changing a shared initialState: EDD-9184 on the fold and on load",
    () =>
      Effect.gen(function* () {
        const fold = yield* defectOf(
          EventStore.commandHandler(inPlace(), Plain, { checkStateUse: true })(
            { matchId: "c-5" },
            { _tag: "Start", venue: "Lord's" },
          ),
        )
        expect(fold).toContain("[EDD-9184]")
        expect(fold).toContain('at status (was "new", now "live")')
        expect(fold).toContain("while the new events were folded")
        expect(yield* Plain.currentVersion({ matchId: "c-5" })).toBe(0)

        yield* seedWith(EventStore.commandHandler(wellBehaved, Plain), "c-6")
        const load = yield* defectOf(
          EventStore.commandHandler(inPlace(), Plain, { checkStateUse: true })(
            { matchId: "c-6" },
            score,
          ),
        )
        expect(load).toContain("[EDD-9184]")
        expect(load).toContain("while the stored events were folded on load")
        expect(yield* Plain.currentVersion({ matchId: "c-6" })).toBe(3)
      }).pipe(provide),
  )

  it.effect(
    "a well-behaved decider passes with the option on and off, with the same requests",
    () =>
      Effect.gen(function* () {
        for (const [stream, label] of [
          [Plain, "plain"],
          [Inline, "inline"],
        ] as const) {
          const sent = (checkStateUse: boolean, matchId: string) =>
            Effect.gen(function* () {
              const mark = requests.length
              const result =
                stream === Plain
                  ? yield* seedWith(
                      EventStore.commandHandler(wellBehaved, Plain, { checkStateUse }),
                      matchId,
                    )
                  : yield* seedWith(
                      EventStore.commandHandler(wellBehaved, Inline, { checkStateUse }),
                      matchId,
                    )
              return { result, sent: requests.slice(mark) }
            })
          const off = yield* sent(false, `w-off-${label}`)
          const on = yield* sent(true, `w-on-${label}`)
          expect(on.result).toEqual(off.result)
          expect(on.sent).toEqual(off.sent)
          expect(on.result.state).toEqual({ status: "live", innings: [{ overs: 3 }, { overs: 4 }] })
        }
      }).pipe(provide),
  )

  it.effect("a Schema.Class state with Option and DateTime fields compares by value", () =>
    Effect.gen(function* () {
      const base: EventStore.Decider<Fixture, MatchCommand, MatchEvent> = {
        get initialState(): Fixture {
          return new Fixture({
            venue: Option.none(),
            startsAt: DateTime.makeUnsafe(0),
            overs: [],
          })
        },
        decide: (command, state) =>
          Effect.sync(() => {
            // Reading values (DateTime caches its parts) is not a change.
            DateTime.toParts(state.startsAt)
            DateTime.formatIso(state.startsAt)
          }).pipe(Effect.andThen(decide(command))),
        evolve: (state, event) =>
          event._tag === "Started"
            ? new Fixture({ ...state, venue: Option.some(event.venue) })
            : new Fixture({ ...state, overs: [...state.overs, event.overs] }),
      }
      const handle = EventStore.commandHandler(base, Fixtures, { checkStateUse: true })
      yield* handle({ matchId: "c-7" }, { _tag: "Start", venue: "Lord's" })
      yield* handle({ matchId: "c-7" }, { _tag: "Score", overs: 3 })

      const changing: EventStore.Decider<Fixture, MatchCommand, MatchEvent> = {
        ...base,
        get initialState(): Fixture {
          return base.initialState
        },
        decide: (command, state) =>
          Effect.sync(() => {
            ;(state.overs as Array<number>)[0] = 9
          }).pipe(Effect.andThen(decide(command))),
      }
      const message = yield* defectOf(
        EventStore.commandHandler(changing, Fixtures, { checkStateUse: true })(
          { matchId: "c-7" },
          score,
        ),
      )
      expect(message).toContain('EventStream "Fixture" (c-7)')
      expect(message).toContain("at overs[0] (was 3, now 9)")
      expect(yield* Fixtures.currentVersion({ matchId: "c-7" })).toBe(2)
    }).pipe(provide),
  )
})
