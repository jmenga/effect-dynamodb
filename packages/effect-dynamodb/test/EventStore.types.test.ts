/**
 * Type-level tests for `EventStore.commandHandler` (#136, #137, #139).
 *
 * - A function-form `additionalItems` returning an `Effect` adds its error
 *   (`E2`) to the handler's error channel and its requirements (`R2`) to the
 *   handler's requirements — the only requirement on a `BoundEventStream`
 *   handler. The static and pure forms add nothing.
 * - `idempotency` keeps the options parameter (and `commandId`) required, with
 *   every `additionalItems` form, in all four call shapes.
 *
 * Uses vitest's `expectTypeOf`; the assertions are compile-time only and are
 * checked by `tsc -p tsconfig.test.json` (`pnpm check`).
 */

import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import type { ValidationError, VersionConflict } from "@effect-dynamodb/schema/Errors.js"
import { Context, Data, Effect, Schema } from "effect"
import { describe, expect, expectTypeOf, it } from "vitest"
import type { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
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
})
