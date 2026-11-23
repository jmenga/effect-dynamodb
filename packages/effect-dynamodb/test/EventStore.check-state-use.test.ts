/**
 * `commandHandler({ checkStateUse: true })` (#290): a `decide` that changes
 * the state it was given is a defect (`EDD-9183`) naming the stream, the
 * command and the first changed path, on every source of state — a stream
 * load, a new stream, an inline snapshot (verified and unverified) and a
 * `loadState` record. An in-place `evolve` changing a shared `initialState`
 * is a defect too (`EDD-9184`), on load and on the fold of new events.
 * Nothing is appended after either. A well-behaved decider passes with the
 * option on and off, sending the same requests either way, and without the
 * option a mutating `decide` behaves as it always has.
 *
 * Requests go to the in-memory tables (`helpers/InMemoryTables.ts`).
 */

import { describe, expect, it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import {
  BigDecimal,
  Cause,
  Chunk,
  Data,
  DateTime,
  Effect,
  Exit,
  Layer,
  Option,
  Schema,
} from "effect"
import { beforeEach } from "vitest"
import { DynamoClient, type DynamoClientService } from "../src/DynamoClient.js"
import * as EventStore from "../src/EventStore.js"
import * as Table from "../src/Table.js"
import { InMemoryClient, resetStore } from "./helpers/InMemoryTables.js"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const AppSchema = DynamoSchema.make({ name: "csu", version: 1 })
const MatchTable = Table.make({ schema: AppSchema, entities: {} })

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

/** The mutable view a misbehaving decider writes through. */
type Writable = { status: string; innings: Array<{ overs: number }> }

/** No snapshot: every command replays the stream from `initialState`. */
const Plain = EventStore.makeStream({
  table: MatchTable,
  streamName: "Match",
  events: [Started, Scored],
  streamId: { composite: ["matchId"] },
})

/** Inline snapshot in every append. */
const Inline = EventStore.makeStream({
  table: MatchTable,
  streamName: "InlineMatch",
  events: [Started, Scored],
  streamId: { composite: ["matchId"] },
  snapshot: { schema: MatchStateSchema, mode: "inline" },
})

class Late extends Data.TaggedError("Late")<{}> {}

const decide = (command: MatchCommand): Effect.Effect<ReadonlyArray<MatchEvent>, Late> =>
  Effect.succeed(
    command._tag === "Start"
      ? [new Started({ venue: command.venue })]
      : [new Scored({ overs: command.overs })],
  )

const evolveImmutably = (state: MatchState, event: MatchEvent): MatchState =>
  event._tag === "Started"
    ? { ...state, status: "live" }
    : { ...state, innings: [...state.innings, { overs: event.overs }] }

const evolveInPlace = (state: MatchState, event: MatchEvent): MatchState => {
  const writable = state as Writable
  if (event._tag === "Started") writable.status = "live"
  else writable.innings.push({ overs: event.overs })
  return state
}

/** A well-behaved decider: `initialState` a getter, `evolve` immutable. */
const wellBehaved: EventStore.Decider<MatchState, MatchCommand, MatchEvent, Late> = {
  get initialState(): MatchState {
    return { status: "new", innings: [] }
  },
  decide: (command) => decide(command),
  evolve: evolveImmutably,
}

/** `wellBehaved`, with a `decide` that changes `innings[1].overs` first. */
const mutating: EventStore.Decider<MatchState, MatchCommand, MatchEvent, Late> = {
  ...wellBehaved,
  get initialState(): MatchState {
    return { status: "new", innings: [] }
  },
  decide: (command, state) =>
    Effect.sync(() => {
      const innings = (state as Writable).innings
      if (innings[1] !== undefined) innings[1].overs += 1
      else (state as Writable).status = "tampered"
    }).pipe(Effect.andThen(decide(command))),
}

const layer = Layer.mergeAll(InMemoryClient, MatchTable.layer({ name: "matches" }))

const provided = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.provide(layer))

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

/** Three commands through `handle`: `innings: [{ overs: 3 }, { overs: 4 }]` at version 3. */
const seedWith = <R>(handle: Handle<R>, matchId: string) =>
  Effect.gen(function* () {
    yield* handle({ matchId }, { _tag: "Start", venue: "Lord's" })
    yield* handle({ matchId }, { _tag: "Score", overs: 3 })
    return yield* handle({ matchId }, { _tag: "Score", overs: 4 })
  })

const seed = (stream: "Plain" | "Inline", matchId: string) =>
  stream === "Plain"
    ? seedWith(EventStore.commandHandler(wellBehaved, Plain), matchId)
    : seedWith(EventStore.commandHandler(wellBehaved, Inline), matchId)

const score: MatchCommand = { _tag: "Score", overs: 5 }

beforeEach(() => resetStore())

// ---------------------------------------------------------------------------
// decide changing its state (EDD-9183)
// ---------------------------------------------------------------------------

describe("checkStateUse — decide changing its state (EDD-9183)", () => {
  it.effect(
    "on a loaded stream: a defect naming the stream, command and path; nothing appended",
    () =>
      provided(
        Effect.gen(function* () {
          yield* seed("Plain", "m-1")
          const message = yield* defectOf(
            EventStore.commandHandler(mutating, Plain, { checkStateUse: true })(
              { matchId: "m-1" },
              score,
            ),
          )
          expect(message).toContain("[EDD-9183]")
          expect(message).toContain('EventStream "Match" (m-1)')
          expect(message).toContain('command "Score"')
          expect(message).toContain("at innings[1].overs (was 4, now 5)")
          expect(message).not.toContain("initialState itself")
          expect(yield* Plain.currentVersion({ matchId: "m-1" })).toBe(3)
        }),
      ),
  )

  it.effect("without the option, the same decider commits its change, as before #290", () =>
    provided(
      Effect.gen(function* () {
        yield* seed("Plain", "m-2")
        const result = yield* EventStore.commandHandler(mutating, Plain)({ matchId: "m-2" }, score)
        expect(result.state.innings).toEqual([{ overs: 3 }, { overs: 5 }, { overs: 5 }])
        expect(result.version).toBe(4)
      }),
    ),
  )

  it.effect("on a new stream, from a getter initialState", () =>
    provided(
      Effect.gen(function* () {
        const message = yield* defectOf(
          EventStore.commandHandler(mutating, Plain, { checkStateUse: true })(
            { matchId: "m-3" },
            { _tag: "Start", venue: "Lord's" },
          ),
        )
        expect(message).toContain("[EDD-9183]")
        expect(message).toContain('at status (was "new", now "tampered")')
        expect(yield* Plain.currentVersion({ matchId: "m-3" })).toBe(0)
      }),
    ),
  )

  it.effect("on a new stream from a shared initialState: says so", () =>
    provided(
      Effect.gen(function* () {
        const shared: EventStore.Decider<MatchState, MatchCommand, MatchEvent, Late> = {
          ...mutating,
          initialState: { status: "new", innings: [] },
        }
        const message = yield* defectOf(
          EventStore.commandHandler(shared, Plain, { checkStateUse: true })(
            { matchId: "m-4" },
            { _tag: "Start", venue: "Lord's" },
          ),
        )
        expect(message).toContain("[EDD-9183]")
        expect(message).toContain("This state is decider.initialState itself")
      }),
    ),
  )

  it.effect("on an inline snapshot load, verified and unverified", () =>
    provided(
      Effect.gen(function* () {
        yield* seed("Inline", "m-5")
        const verified = yield* defectOf(
          EventStore.commandHandler(mutating, Inline, { checkStateUse: true })(
            { matchId: "m-5" },
            score,
          ),
        )
        expect(verified).toContain('EventStream "InlineMatch" (m-5)')
        expect(verified).toContain("at innings[1].overs (was 4, now 5)")

        const unverified = yield* defectOf(
          EventStore.commandHandler(mutating, Inline, {
            checkStateUse: true,
            verifySnapshot: false,
          })({ matchId: "m-5" }, score),
        )
        expect(unverified).toContain("at innings[1].overs (was 4, now 5)")
        expect(yield* Inline.currentVersion({ matchId: "m-5" })).toBe(3)
        const latest = yield* Inline.readLatest({ matchId: "m-5" })
        expect(Option.getOrThrow(latest.snapshot).state.innings).toEqual([
          { overs: 3 },
          { overs: 4 },
        ])
      }),
    ),
  )

  it.effect("on a loadState record", () =>
    provided(
      Effect.gen(function* () {
        yield* seed("Plain", "m-6")
        const record: MatchState = { status: "live", innings: [{ overs: 3 }, { overs: 4 }] }
        const message = yield* defectOf(
          EventStore.commandHandler(mutating, Plain, {
            checkStateUse: true,
            loadState: () => Effect.succeed(Option.some({ state: record, version: 3 })),
          })({ matchId: "m-6" }, score),
        )
        expect(message).toContain("at innings[1].overs (was 4, now 5)")
        expect(yield* Plain.currentVersion({ matchId: "m-6" })).toBe(3)
      }),
    ),
  )

  it.effect("when decide changes the state before returning its Effect, or fails after", () =>
    provided(
      Effect.gen(function* () {
        yield* seed("Plain", "m-7")
        const eager: EventStore.Decider<MatchState, MatchCommand, MatchEvent, Late> = {
          ...wellBehaved,
          get initialState(): MatchState {
            return { status: "new", innings: [] }
          },
          decide: (command, state) => {
            ;(state as Writable).innings.push({ overs: 0 })
            return decide(command)
          },
        }
        expect(
          yield* defectOf(
            EventStore.commandHandler(eager, Plain, { checkStateUse: true })(
              { matchId: "m-7" },
              score,
            ),
          ),
        ).toContain("at innings (was Array of length 2, now Array of length 3)")

        const failing: EventStore.Decider<MatchState, MatchCommand, MatchEvent, Late> = {
          ...mutating,
          get initialState(): MatchState {
            return { status: "new", innings: [] }
          },
          decide: (command, state) =>
            Effect.andThen(mutating.decide(command, state), () => Effect.fail(new Late())),
        }
        expect(
          yield* defectOf(
            EventStore.commandHandler(failing, Plain, { checkStateUse: true })(
              { matchId: "m-7" },
              score,
            ),
          ),
        ).toContain("at innings[1].overs")
      }),
    ),
  )

  it.effect("a decide failure or defect of its own passes through unchanged", () =>
    provided(
      Effect.gen(function* () {
        yield* seed("Plain", "m-8")
        const failing = { ...wellBehaved, decide: () => Effect.fail(new Late()) }
        const failure = yield* Effect.flip(
          EventStore.commandHandler(failing, Plain, { checkStateUse: true })(
            { matchId: "m-8" },
            score,
          ),
        )
        expect(failure).toBeInstanceOf(Late)

        const dying = { ...wellBehaved, decide: () => Effect.die("decide's own defect") }
        const message = yield* defectOf(
          EventStore.commandHandler(dying, Plain, { checkStateUse: true })(
            { matchId: "m-8" },
            score,
          ),
        )
        expect(message).toBe("decide's own defect")
      }),
    ),
  )

  it.effect("is not retried", () =>
    provided(
      Effect.gen(function* () {
        yield* seed("Plain", "m-9")
        let decisions = 0
        const counting = {
          ...mutating,
          decide: (command: MatchCommand, state: MatchState) => {
            decisions++
            return mutating.decide(command, state)
          },
        }
        yield* defectOf(
          EventStore.commandHandler(counting, Plain, { checkStateUse: true, retry: 3 })(
            { matchId: "m-9" },
            score,
          ),
        )
        expect(decisions).toBe(1)
      }),
    ),
  )
})

// ---------------------------------------------------------------------------
// A shared initialState changed by an in-place evolve (EDD-9184)
// ---------------------------------------------------------------------------

describe("checkStateUse — a shared initialState changed (EDD-9184)", () => {
  const inPlace = (): EventStore.Decider<MatchState, MatchCommand, MatchEvent, Late> => ({
    initialState: { status: "new", innings: [] },
    decide: (command) => decide(command),
    evolve: evolveInPlace,
  })

  it.effect("on the fold of a new stream's events: a defect before the append", () =>
    provided(
      Effect.gen(function* () {
        const decider = inPlace()
        const message = yield* defectOf(
          EventStore.commandHandler(decider, Plain, { checkStateUse: true })(
            { matchId: "n-1" },
            { _tag: "Start", venue: "Lord's" },
          ),
        )
        expect(message).toContain("[EDD-9184]")
        expect(message).toContain('EventStream "Match" (n-1), command "Start"')
        expect(message).toContain('at status (was "new", now "live")')
        expect(message).toContain("while the new events were folded")
        expect(message).toContain("Declare initialState as a getter")
        expect(yield* Plain.currentVersion({ matchId: "n-1" })).toBe(0)
      }),
    ),
  )

  it.effect("on the fold of a stored stream's events on load", () =>
    provided(
      Effect.gen(function* () {
        yield* seed("Plain", "n-2")
        const decider = inPlace()
        const message = yield* defectOf(
          EventStore.commandHandler(decider, Plain, { checkStateUse: true })(
            { matchId: "n-2" },
            score,
          ),
        )
        expect(message).toContain("[EDD-9184]")
        expect(message).toContain("while the stored events were folded on load")
        expect(yield* Plain.currentVersion({ matchId: "n-2" })).toBe(3)
      }),
    ),
  )

  it.effect("an in-place evolve with a getter initialState passes", () =>
    provided(
      Effect.gen(function* () {
        const decider: EventStore.Decider<MatchState, MatchCommand, MatchEvent, Late> = {
          get initialState(): MatchState {
            return { status: "new", innings: [] }
          },
          decide: (command) => decide(command),
          evolve: evolveInPlace,
        }
        const handle = EventStore.commandHandler(decider, Plain, { checkStateUse: true })
        yield* handle({ matchId: "n-3" }, { _tag: "Start", venue: "Lord's" })
        const result = yield* handle({ matchId: "n-3" }, score)
        expect(result.state).toEqual({ status: "live", innings: [{ overs: 5 }] })
      }),
    ),
  )
})

// ---------------------------------------------------------------------------
// Well-behaved deciders, and what is compared
// ---------------------------------------------------------------------------

describe("checkStateUse — well-behaved deciders", () => {
  /** Every request the handler sends, by operation, in order. */
  const recorded = (requests: Array<string>) =>
    Layer.effect(
      DynamoClient,
      Effect.map(
        Effect.service(DynamoClient),
        (inner): DynamoClientService =>
          new Proxy(inner, {
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
    ).pipe(Layer.provide(InMemoryClient))

  const run = (stream: "Plain" | "Inline", checkStateUse: boolean, matchId: string) => {
    const requests: Array<string> = []
    const seeded =
      stream === "Plain"
        ? seedWith(EventStore.commandHandler(wellBehaved, Plain, { checkStateUse }), matchId)
        : seedWith(EventStore.commandHandler(wellBehaved, Inline, { checkStateUse }), matchId)
    return Effect.map(seeded, (result) => ({ result, requests })).pipe(
      Effect.provide(Layer.mergeAll(recorded(requests), MatchTable.layer({ name: "matches" }))),
    )
  }

  it.effect("pass with the option on and off, sending the same requests", () =>
    Effect.gen(function* () {
      for (const stream of ["Plain", "Inline"] as const) {
        const off = yield* run(stream, false, `w-${stream}`)
        resetStore()
        const on = yield* run(stream, true, `w-${stream}`)
        expect(on.result).toEqual(off.result)
        expect(on.requests).toEqual(off.requests)
        expect(on.result.state).toEqual({ status: "live", innings: [{ overs: 3 }, { overs: 4 }] })
      }
    }),
  )

  it.effect("reading Effect data types in decide is not a change", () =>
    provided(
      Effect.gen(function* () {
        // No snapshot schema: compared field by field, with the data types by value.
        type Rich = {
          readonly at: DateTime.Zoned
          readonly amount: BigDecimal.BigDecimal
          readonly overs: Chunk.Chunk<number>
          readonly venue: Option.Option<string>
        }
        const decider: EventStore.Decider<Rich, MatchCommand, MatchEvent, Late> = {
          get initialState(): Rich {
            return {
              at: DateTime.makeZonedUnsafe(0, { timeZone: "Europe/London" }),
              amount: BigDecimal.make(1500n, 3),
              overs: Chunk.appendAll(Chunk.make(1), Chunk.make(2)),
              venue: Option.none(),
            }
          },
          decide: (command, state) =>
            Effect.sync(() => {
              DateTime.formatIsoZoned(state.at)
              BigDecimal.normalize(state.amount)
              Chunk.toReadonlyArray(state.overs)
            }).pipe(Effect.andThen(decide(command))),
          evolve: (state, event) =>
            event._tag === "Started" ? { ...state, venue: Option.some(event.venue) } : state,
        }
        const result = yield* EventStore.commandHandler(decider, Plain, { checkStateUse: true })(
          { matchId: "r-1" },
          { _tag: "Start", venue: "Lord's" },
        )
        expect(result.version).toBe(1)
      }),
    ),
  )

  it.effect("with a snapshot schema, a state is compared as the snapshot stores it", () =>
    provided(
      Effect.gen(function* () {
        yield* seed("Inline", "s-1")
        // A field outside the snapshot schema isn't stored, so it isn't compared.
        const scratch: EventStore.Decider<MatchState, MatchCommand, MatchEvent, Late> = {
          ...wellBehaved,
          decide: (command, state) =>
            Effect.sync(() => {
              ;(state as Record<string, unknown>).scratch = true
            }).pipe(Effect.andThen(decide(command))),
        }
        const result = yield* EventStore.commandHandler(scratch, Inline, { checkStateUse: true })(
          { matchId: "s-1" },
          score,
        )
        expect(result.version).toBe(4)
        // Without a snapshot schema the same change is reported, at the state itself.
        yield* seed("Plain", "s-2")
        const message = yield* defectOf(
          EventStore.commandHandler(scratch, Plain, { checkStateUse: true })(
            { matchId: "s-2" },
            score,
          ),
        )
        expect(message).toContain(
          "at the state itself (was { status, innings }, now { status, innings, scratch })",
        )
      }),
    ),
  )
})
