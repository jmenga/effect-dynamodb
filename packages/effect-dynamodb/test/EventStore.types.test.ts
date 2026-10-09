/**
 * Type-level tests for `EventStore.commandHandler` (#136, #137, #139).
 *
 * - A function-form `additionalItems` returning an `Effect` adds its error
 *   (`E2`) to the handler's error channel and its requirements (`R2`) to the
 *   handler's requirements — the only requirement on a `BoundEventStream`
 *   handler. The static and pure forms add nothing.
 * - `idempotency` keeps the options parameter (and `commandId`) required, with
 *   every `additionalItems` form, in all four call shapes.
 * - `readLatest` (#138) returns the stream's snapshot state type; an inline
 *   `AppendOptions.snapshot` is typed by it (and refused on a snapshot-less
 *   stream). An append is always one atomic transaction: there is no
 *   `chunked` option on `append` or `commandHandler`.
 * - `verifySnapshot` is accepted by `readLatest` (`ReadLatestOptions`) and the
 *   handler options only — not by `read` / `readFrom` / `currentVersion`, nor
 *   per call.
 * - Stream indexes (#140): the index names are a trailing `TIndexName` type
 *   parameter, so `readIndex` / `query.index` refuse an undeclared name, the
 *   `key` callback is typed by the stream's events, and indexed streams still
 *   flow through `bind` and every `commandHandler` form.
 *
 * Uses vitest's `expectTypeOf`; the assertions are compile-time only and are
 * checked by `tsc -p tsconfig.test.json` (`pnpm check`).
 */

import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import type { ValidationError, VersionConflict } from "@effect-dynamodb/schema/Errors.js"
import { Context, Data, Effect, type Option, Schema } from "effect"
import { describe, expect, expectTypeOf, it } from "vitest"
import type { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
import type * as Query from "../src/Query.js"
import * as Table from "../src/Table.js"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

class Tally extends Schema.Class<Tally>("Tally")({
  counterId: Schema.String,
  total: Schema.Number,
}) {}

const Tallies = Entity.make({
  model: Tally,
  entityType: "Tally",
  primaryKey: {
    pk: { field: "pk", composite: ["counterId"] },
    sk: { field: "sk", composite: [] },
  },
})

const AppTable = Table.make({
  schema: DynamoSchema.make({ name: "types", version: 1 }),
  entities: { Tallies },
})

class Incremented extends Schema.TaggedClass<Incremented>()("Incremented", {
  by: Schema.Number,
}) {}

const Counter = EventStore.makeStream({
  table: AppTable,
  streamName: "Counter",
  events: [Incremented],
  streamId: { composite: ["counterId"] },
})

interface CounterState {
  readonly total: number
}

class Overflow extends Data.TaggedError("Overflow") {}

const decider: EventStore.Decider<CounterState, { readonly by: number }, Incremented, Overflow> = {
  initialState: { total: 0 },
  decide: (command) => Effect.succeed([new Incremented({ by: command.by })]),
  evolve: (state, event) => ({ total: state.total + event.by }),
}

/** A projection dependency — the `R2` of an effectful `additionalItems`. */
class Projector extends Context.Service<Projector, { readonly owner: Effect.Effect<string> }>()(
  "test/Projector",
) {}

/** The `E2` of an effectful `additionalItems`. */
class ProjectionFailed extends Data.TaggedError("ProjectionFailed") {}

const effectfulItems = (decision: EventStore.Decision<CounterState, Incremented>) =>
  Effect.gen(function* () {
    const projector = yield* Projector
    const owner = yield* projector.owner
    if (owner === "") return yield* new ProjectionFailed()
    return [Tallies.put({ counterId: owner, total: decision.state.total })]
  })

const key = { counterId: "c-1" }
const command = { by: 1 }

type Base = DynamoClient | Table.TableConfig

// The assertions live in functions that are type-checked but never executed —
// they would need DynamoDB to run.
const typeOnly = (_: () => void) => undefined

describe("EventStore.commandHandler types", () => {
  it("VersionConflict.actualVersion is optional", () => {
    expectTypeOf<VersionConflict["actualVersion"]>().toEqualTypeOf<number | undefined>()
  })

  it("read / readFrom / currentVersion accept ReadOptions", () => {
    typeOnly(() => {
      expectTypeOf(Counter.read(key, { consistentRead: true })).toEqualTypeOf<
        ReturnType<typeof Counter.read>
      >()
      Counter.readFrom(key, 3, { consistentRead: true })
      Counter.currentVersion(key, { consistentRead: false })
      // @ts-expect-error — not a ReadOptions field
      Counter.read(key, { consistent: true })
    })
    expect(true).toBe(true)
  })

  it("the Decision passed to additionalItems is typed by the decider", () => {
    typeOnly(() => {
      const handle = EventStore.commandHandler(decider, Counter)
      handle(key, command, {
        additionalItems: (decision) => {
          expectTypeOf(decision.state).toEqualTypeOf<CounterState>()
          expectTypeOf(decision.previous).toEqualTypeOf<CounterState>()
          expectTypeOf(decision.events).toEqualTypeOf<ReadonlyArray<Incremented>>()
          expectTypeOf(decision.version).toEqualTypeOf<number>()
          return []
        },
      })
    })
    expect(true).toBe(true)
  })

  it("static and pure additionalItems add no error or requirement", () => {
    typeOnly(() => {
      const handle = EventStore.commandHandler(decider, Counter)
      const plain = handle(key, command)
      const staticItems = handle(key, command, {
        additionalItems: [Tallies.put({ counterId: "x", total: 1 })],
      })
      const pure = handle(key, command, {
        additionalItems: ({ state }) => [Tallies.put({ counterId: "x", total: state.total })],
      })
      expectTypeOf<Effect.Services<typeof plain>>().toEqualTypeOf<Base>()
      expectTypeOf<Effect.Services<typeof staticItems>>().toEqualTypeOf<Base>()
      expectTypeOf<Effect.Services<typeof pure>>().toEqualTypeOf<Base>()
      expectTypeOf<Effect.Error<typeof pure>>().toEqualTypeOf<Effect.Error<typeof plain>>()
      expectTypeOf<Overflow>().toExtend<Effect.Error<typeof plain>>()
      expectTypeOf<ProjectionFailed>().not.toExtend<Effect.Error<typeof plain>>()
    })
    expect(true).toBe(true)
  })

  it("an effectful additionalItems joins E2 to the errors and R2 to the requirements", () => {
    typeOnly(() => {
      const handle = EventStore.commandHandler(decider, Counter)
      const result = handle(key, command, { additionalItems: effectfulItems })
      expectTypeOf<Effect.Services<typeof result>>().toEqualTypeOf<Base | Projector>()
      expectTypeOf<ProjectionFailed>().toExtend<Effect.Error<typeof result>>()
      expectTypeOf<Overflow>().toExtend<Effect.Error<typeof result>>()
      expectTypeOf<VersionConflict>().toExtend<Effect.Error<typeof result>>()

      // Data-last form.
      const piped = Counter.pipe(EventStore.commandHandler(decider))
      const pipedResult = piped(key, command, { additionalItems: effectfulItems })
      expectTypeOf<Effect.Services<typeof pipedResult>>().toEqualTypeOf<Base | Projector>()
      expectTypeOf<ProjectionFailed>().toExtend<Effect.Error<typeof pipedResult>>()
    })
    expect(true).toBe(true)
  })

  it("on a BoundEventStream handler R2 is the only requirement", () => {
    typeOnly(() => {
      Effect.gen(function* () {
        const bound = yield* EventStore.bind(Counter)

        const dataFirst = EventStore.commandHandler(decider, bound)
        const plain = dataFirst(key, command)
        const pure = dataFirst(key, command, { additionalItems: () => [] })
        const effectful = dataFirst(key, command, { additionalItems: effectfulItems })
        expectTypeOf<Effect.Services<typeof plain>>().toEqualTypeOf<never>()
        expectTypeOf<Effect.Services<typeof pure>>().toEqualTypeOf<never>()
        expectTypeOf<Effect.Services<typeof effectful>>().toEqualTypeOf<Projector>()
        expectTypeOf<ProjectionFailed>().toExtend<Effect.Error<typeof effectful>>()

        const dataLast = bound.pipe(EventStore.commandHandler(decider))
        const pipedPlain = dataLast(key, command)
        const pipedEffectful = dataLast(key, command, { additionalItems: effectfulItems })
        expectTypeOf<Effect.Services<typeof pipedPlain>>().toEqualTypeOf<never>()
        expectTypeOf<Effect.Services<typeof pipedEffectful>>().toEqualTypeOf<Projector>()
        expectTypeOf<ProjectionFailed>().toExtend<Effect.Error<typeof pipedEffectful>>()
      })
    })
    expect(true).toBe(true)
  })

  it("idempotency keeps the options and commandId required with every additionalItems form", () => {
    typeOnly(() => {
      const dataFirst = EventStore.commandHandler(decider, Counter, { idempotency: {} })
      // @ts-expect-error — options (with commandId) are required
      dataFirst(key, command)
      // @ts-expect-error — commandId is required
      dataFirst(key, command, { additionalItems: effectfulItems })
      // @ts-expect-error — commandId is required
      dataFirst(key, command, { expectedVersion: 3 })
      const result = dataFirst(key, command, {
        commandId: "cmd-1",
        expectedVersion: 3,
        additionalItems: effectfulItems,
      })
      expectTypeOf<Effect.Services<typeof result>>().toEqualTypeOf<Base | Projector>()
      expectTypeOf<ProjectionFailed>().toExtend<Effect.Error<typeof result>>()
      expectTypeOf<ValidationError>().toExtend<Effect.Error<typeof result>>()

      const dataLast = Counter.pipe(EventStore.commandHandler(decider, { idempotency: {} }))
      // @ts-expect-error — options (with commandId) are required
      dataLast(key, command)
      // @ts-expect-error — commandId is required
      dataLast(key, command, { additionalItems: effectfulItems })
      const pipedResult = dataLast(key, command, {
        commandId: "cmd-1",
        additionalItems: effectfulItems,
      })
      expectTypeOf<Effect.Services<typeof pipedResult>>().toEqualTypeOf<Base | Projector>()

      Effect.gen(function* () {
        const bound = yield* EventStore.bind(Counter)

        const boundFirst = EventStore.commandHandler(decider, bound, { idempotency: {} })
        // @ts-expect-error — options (with commandId) are required
        boundFirst(key, command)
        // @ts-expect-error — commandId is required
        boundFirst(key, command, { additionalItems: () => [] })
        const boundResult = boundFirst(key, command, {
          commandId: "cmd-1",
          additionalItems: effectfulItems,
        })
        expectTypeOf<Effect.Services<typeof boundResult>>().toEqualTypeOf<Projector>()

        const boundLast = bound.pipe(EventStore.commandHandler(decider, { idempotency: {} }))
        // @ts-expect-error — options (with commandId) are required
        boundLast(key, command)
        const boundPiped = boundLast(key, command, {
          commandId: "cmd-1",
          additionalItems: effectfulItems,
        })
        expectTypeOf<Effect.Services<typeof boundPiped>>().toEqualTypeOf<Projector>()
      })
    })
    expect(true).toBe(true)
  })

  it("data-last still refuses a stream whose snapshot state is not the decider's", () => {
    typeOnly(() => {
      const Mismatched = EventStore.makeStream({
        table: AppTable,
        streamName: "Mismatched",
        events: [Incremented],
        streamId: { composite: ["counterId"] },
        snapshot: { schema: Schema.Struct({ label: Schema.String }) },
      })
      // @ts-expect-error — snapshot state { label } is not CounterState
      EventStore.commandHandler(decider, Mismatched)
      // @ts-expect-error — snapshot state { label } is not CounterState
      Mismatched.pipe(EventStore.commandHandler(decider))
      Effect.gen(function* () {
        const bound = yield* EventStore.bind(Mismatched)
        // @ts-expect-error — snapshot state { label } is not CounterState
        bound.pipe(EventStore.commandHandler(decider))
      })
    })
    expect(true).toBe(true)
  })

  it("without idempotency the options stay optional and expectedVersion is accepted", () => {
    typeOnly(() => {
      const handle = EventStore.commandHandler(decider, Counter, {
        retry: 3,
        consistentRead: false,
      })
      handle(key, command)
      handle(key, command, { expectedVersion: 0 })
      handle(key, command, { expectedVersion: undefined })
      // @ts-expect-error — expectedVersion is a number
      handle(key, command, { expectedVersion: "3" })
    })
    expect(true).toBe(true)
  })

  it("readLatest and inline snapshots are typed, and appends stay atomic (#138)", () => {
    typeOnly(() => {
      const Snapshotted = EventStore.makeStream({
        table: AppTable,
        streamName: "Snapshotted",
        events: [Incremented],
        streamId: { composite: ["counterId"] },
        snapshot: { schema: Schema.Struct({ total: Schema.Number }), mode: "inline", every: 5 },
      })
      const latest = Snapshotted.readLatest(key, { consistentRead: true })
      expectTypeOf<Effect.Success<typeof latest>["snapshot"]>().toEqualTypeOf<
        Option.Option<EventStore.Snapshot<{ readonly total: number }>>
      >()
      expectTypeOf<
        Effect.Success<typeof latest>["events"][number]["data"]
      >().toEqualTypeOf<Incremented>()
      expectTypeOf<Effect.Success<typeof latest>["version"]>().toEqualTypeOf<number>()

      // An inline snapshot is the stream's state type...
      const appended = Snapshotted.append(key, [new Incremented({ by: 1 })], 0, {
        snapshot: { total: 1 },
      })
      expectTypeOf<Effect.Error<typeof appended>>().toEqualTypeOf<EventStore.AppendError>()
      // @ts-expect-error — not the state type
      Snapshotted.append(key, [new Incremented({ by: 1 })], 0, { snapshot: { label: "x" } })
      // ...and there is none on a stream without a snapshot config.
      // @ts-expect-error — `never` on a snapshot-less stream
      Counter.append(key, [new Incremented({ by: 1 })], 0, { snapshot: { total: 1 } })

      // No append is ever split across transactions: there is no `chunked`.
      // @ts-expect-error — not an append option
      Counter.append(key, [new Incremented({ by: 1 })], 0, { chunked: true })
      // @ts-expect-error — not a handler option
      EventStore.commandHandler(decider, Counter, { chunked: true })
      const handle = EventStore.commandHandler(decider, Counter)
      // @ts-expect-error — not a per-call option
      handle(key, command, { chunked: true })

      Effect.gen(function* () {
        const bound = yield* EventStore.bind(Snapshotted)
        const boundLatest = bound.readLatest(key)
        expectTypeOf<Effect.Services<typeof boundLatest>>().toEqualTypeOf<never>()
      })
    })
    expect(true).toBe(true)
  })

  it("verifySnapshot is a readLatest and handler option only", () => {
    typeOnly(() => {
      const Inline = EventStore.makeStream({
        table: AppTable,
        streamName: "InlineTyped",
        events: [Incremented],
        streamId: { composite: ["counterId"] },
        snapshot: { schema: Schema.Struct({ total: Schema.Number }), mode: "inline" },
      })
      const options: EventStore.ReadLatestOptions = { verifySnapshot: false, consistentRead: true }
      const latest = Inline.readLatest(key, options)
      expectTypeOf<Effect.Success<typeof latest>["version"]>().toEqualTypeOf<number>()
      // @ts-expect-error — not a ReadOptions field: only readLatest verifies a snapshot
      Inline.read(key, { verifySnapshot: false })
      // @ts-expect-error — not a ReadOptions field
      Inline.currentVersion(key, { verifySnapshot: false })
      // @ts-expect-error — a boolean
      Inline.readLatest(key, { verifySnapshot: "no" })

      const handle = EventStore.commandHandler(decider, Inline, { verifySnapshot: false })
      handle(key, command, { expectedVersion: 3 })
      Inline.pipe(EventStore.commandHandler(decider, { verifySnapshot: false, retry: 1 }))
      Effect.gen(function* () {
        const bound = yield* EventStore.bind(Inline)
        const boundLatest = bound.readLatest(key, { verifySnapshot: false })
        expectTypeOf<Effect.Services<typeof boundLatest>>().toEqualTypeOf<never>()
        bound.pipe(EventStore.commandHandler(decider, { verifySnapshot: false }))
      })
      // @ts-expect-error — a handler option, not a per-call option
      handle(key, command, { verifySnapshot: false })
    })
    expect(true).toBe(true)
  })

  it("stream indexes type their names and key callbacks (#140)", () => {
    typeOnly(() => {
      class Reset extends Schema.TaggedClass<Reset>()("Reset", { reason: Schema.String }) {}
      const Indexed = EventStore.makeStream({
        table: AppTable,
        streamName: "Indexed",
        events: [Incremented, Reset],
        streamId: { composite: ["counterId"] },
        indexes: {
          byAmount: {
            index: "lsi1",
            sk: "lsi1sk",
            key: (event, version) => {
              expectTypeOf(event).toEqualTypeOf<Incremented | Reset>()
              expectTypeOf(version).toEqualTypeOf<number>()
              return event._tag === "Incremented" ? `by#${event.by}` : undefined
            },
          },
          byReason: {
            type: "gsi",
            index: "gsi1",
            pk: "gsi1pk",
            sk: "gsi1sk",
            key: (event) => (event._tag === "Reset" ? event.reason : undefined),
          },
        },
      })
      expectTypeOf(Indexed).toEqualTypeOf<
        EventStore.EventStream<
          Incremented | Reset,
          readonly ["counterId"],
          undefined,
          never,
          "byAmount" | "byReason"
        >
      >()
      expectTypeOf<keyof typeof Indexed.indexes>().toEqualTypeOf<"byAmount" | "byReason">()

      const read = Indexed.readIndex("byAmount", key, { beginsWith: "by#", limit: 5 })
      expectTypeOf<Effect.Success<typeof read>[number]["data"]>().toEqualTypeOf<
        Incremented | Reset
      >()
      expectTypeOf<Effect.Services<typeof read>>().toEqualTypeOf<Base>()
      Indexed.readIndex("byReason", key, { between: ["a", "m"], reverse: true })
      // @ts-expect-error — beginsWith and between are exclusive
      Indexed.readIndex("byAmount", key, { beginsWith: "a", between: ["a", "b"] })
      // @ts-expect-error — not a declared index name
      Indexed.readIndex("byNothing", key)
      // @ts-expect-error — not a declared index name
      Indexed.query.index("byNothing", key)
      const query = Indexed.query.index("byReason", key)
      expectTypeOf(query).toEqualTypeOf<
        Query.Query<
          EventStore.StreamEvent<Incremented | Reset, Record<string, unknown> | undefined>
        >
      >()

      // A stream without indexes accepts no index name at all.
      // @ts-expect-error — the stream declares no indexes
      Counter.readIndex("byAmount", key)
      // @ts-expect-error — the stream declares no indexes
      Counter.query.index("byAmount", key)

      // The key callback is typed by the stream's events.
      EventStore.makeStream({
        table: AppTable,
        streamName: "BadKey",
        events: [Incremented],
        streamId: { composite: ["counterId"] },
        indexes: {
          // @ts-expect-error — `reason` is not a field of Incremented
          bad: { index: "lsi1", sk: "lsi1sk", key: (event) => event.reason },
        },
      })
      EventStore.makeStream({
        table: AppTable,
        streamName: "BadShape",
        events: [Incremented],
        streamId: { composite: ["counterId"] },
        indexes: {
          // @ts-expect-error — a gsi requires pk
          noPk: { type: "gsi", index: "gsi1", sk: "gsi1sk", key: () => undefined },
        },
      })
      EventStore.makeStream({
        table: AppTable,
        streamName: "BadShape",
        events: [Incremented],
        streamId: { composite: ["counterId"] },
        indexes: {
          // @ts-expect-error — an lsi uses the table pk
          withPk: { index: "lsi1", pk: "x", sk: "lsi1sk", key: () => undefined },
        },
      })

      // Indexed streams flow through every commandHandler form and bind.
      const IndexedCounter = EventStore.makeStream({
        table: AppTable,
        streamName: "IndexedCounter",
        events: [Incremented],
        streamId: { composite: ["counterId"] },
        indexes: { byAmount: { index: "lsi1", sk: "lsi1sk", key: (e) => `${e.by}` } },
      })
      const dataFirst = EventStore.commandHandler(decider, IndexedCounter)(key, command)
      expectTypeOf<Effect.Services<typeof dataFirst>>().toEqualTypeOf<Base>()
      const dataLast = IndexedCounter.pipe(EventStore.commandHandler(decider))(key, command)
      expectTypeOf<Effect.Services<typeof dataLast>>().toEqualTypeOf<Base>()
      Effect.gen(function* () {
        const bound = yield* EventStore.bind(IndexedCounter)
        expectTypeOf(bound).toEqualTypeOf<
          EventStore.BoundEventStream<
            Incremented,
            readonly ["counterId"],
            undefined,
            never,
            "byAmount"
          >
        >()
        const boundRead = bound.readIndex("byAmount", key)
        expectTypeOf<Effect.Services<typeof boundRead>>().toEqualTypeOf<never>()
        // @ts-expect-error — not a declared index name
        bound.readIndex("byNothing", key)
        const boundFirst = EventStore.commandHandler(decider, bound)(key, command)
        expectTypeOf<Effect.Services<typeof boundFirst>>().toEqualTypeOf<never>()
        const boundLast = bound.pipe(EventStore.commandHandler(decider))(key, command)
        expectTypeOf<Effect.Services<typeof boundLast>>().toEqualTypeOf<never>()

        // indexDefinitions accepts plain and bound streams, with or without indexes.
        const fragments = EventStore.indexDefinitions(IndexedCounter, bound, Counter, Indexed)
        expectTypeOf(fragments).toEqualTypeOf<EventStore.StreamIndexDefinitions>()
      })
    })
    expect(true).toBe(true)
  })
})
