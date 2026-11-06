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
 * - Stream index projection: each index's `projection` literal is inferred per
 *   name (`"all"` when omitted), so `readIndex` / `query.index` type `metadata`
 *   as `undefined` through a `"withoutMetadata"` index only, `key` stays
 *   contextually typed, and projected streams flow through `bind`,
 *   `commandHandler` and `indexDefinitions`.
 * - Per-event metadata (#144): `metadata` and `eventMetadata` are exclusive on
 *   `append` and the handler; entries are typed `M | undefined`; an effectful
 *   `eventMetadata` joins its own `E3` / `R3` to the handler's channels next to
 *   an `additionalItems`' `E2` / `R2`; idempotency still requires `commandId`.
 *   `eventTimestamps` entries are `DateTime | undefined`, allowed next to either
 *   metadata option. The handler's is a function returning the array (widening
 *   neither channel) or an `Effect` of it, whose error / requirements join as a
 *   separate `E4` / `R4` — so it infers next to an `eventMetadata` effect with a
 *   different error type, the case one shared `E3` / `R3` pair would break.
 * - Shared stream indexes (#149): a GSI's `partition` receives the event, its
 *   version and the typed stream id (as `key` now does), and `snapshot` the
 *   stream's state, `asOfVersion` and stream id; a generic wrapper over a
 *   stream's index names (no derived partition) still type-checks;
 *   an index with a `partition` is a `TPartitionedIndexName`, so `readIndex` /
 *   `query.index` require `partition` for it, on unbound and bound streams,
 *   and such a stream stays assignable to a plain `EventStream`; `snapshot`
 *   and `partition` are refused on an LSI.
 * - Packed storage (#147): `storedAs` admits only `data`, and it and
 *   `snapshot.storedAs` only a `DynamoModel.Packed` config; error channels
 *   are unchanged (a missing compressor is a `ValidationError` whose cause is
 *   `CompressorNotRegistered`); `measureAppend` / `measureSnapshot` need only
 *   `TableConfig` (nothing on a bound stream) and `decodeStreamImage` nothing,
 *   returning the read paths' `StreamEvent`.
 * - Head proof and `loadState` (#164): an inline `loadState` lambda is
 *   contextually typed by the stream id and the decider's state (the handler's
 *   `TConfig` has no default, so the lambda does not fix it first); its error
 *   and requirements join the handler's — a bound handler's only ones — in
 *   all four forms, and a handler without it keeps its channels. `HeadProof`
 *   is `{ additionalItem }` or `"snapshot"`, on `append` and `measureAppend`.
 *
 * Uses vitest's `expectTypeOf`; the assertions are compile-time only and are
 * checked by `tsc -p tsconfig.test.json` (`pnpm check`).
 */

import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import type {
  AdditionalItemConditionFailed,
  AppendTooLarge,
  ConcurrentModification,
  DuplicateCommand,
  OptimisticLockError,
  StreamSealed,
  TransactionCancelled,
  UniqueConstraintViolation,
  ValidationError,
  VersionConflict,
} from "@effect-dynamodb/schema/Errors.js"
import { Context, Data, DateTime, Effect, type Option, Schema } from "effect"
import { describe, expect, expectTypeOf, it } from "vitest"
import type { DynamoClient, DynamoClientError } from "../src/DynamoClient.js"
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

  it("stream index projection types metadata per index name", () => {
    typeOnly(() => {
      class Reset extends Schema.TaggedClass<Reset>()("Reset", { reason: Schema.String }) {}
      interface Meta {
        readonly eventId: string
      }
      const Projected = EventStore.makeStream({
        table: AppTable,
        streamName: "Projected",
        events: [Incremented, Reset],
        streamId: { composite: ["counterId"] },
        metadata: Schema.Struct({ eventId: Schema.String }),
        indexes: {
          slim: {
            index: "lsi1",
            sk: "lsi1sk",
            projection: "withoutMetadata",
            key: (event, version) => {
              // `key` stays contextually typed with `projection` present...
              expectTypeOf(event).toEqualTypeOf<Incremented | Reset>()
              expectTypeOf(version).toEqualTypeOf<number>()
              return event._tag === "Incremented" ? `by#${event.by}` : undefined
            },
          },
          lean: {
            type: "gsi",
            index: "gsi1",
            pk: "gsi1pk",
            sk: "gsi1sk",
            projection: "keys",
            key: (event) => (event._tag === "Reset" ? event.reason : undefined),
          },
          // ...and absent.
          full: {
            index: "lsi2",
            sk: "lsi2sk",
            key: (event) => {
              expectTypeOf(event).toEqualTypeOf<Incremented | Reset>()
              return undefined
            },
          },
          declared: { index: "lsi3", sk: "lsi3sk", projection: "all", key: () => undefined },
        },
      })
      // An omitted projection infers "all".
      expectTypeOf(Projected).toEqualTypeOf<
        EventStore.EventStream<
          Incremented | Reset,
          readonly ["counterId"],
          Meta,
          never,
          "slim" | "lean" | "full" | "declared",
          {
            readonly slim: "withoutMetadata"
            readonly lean: "keys"
            readonly full: "all"
            readonly declared: "all"
          }
        >
      >()

      type MetadataOf<T> =
        T extends Effect.Effect<infer A, infer _E, infer _R>
          ? A extends ReadonlyArray<EventStore.StreamEvent<unknown, infer M>>
            ? M
            : never
          : never
      type QueryMetadataOf<T> =
        T extends Query.Query<EventStore.StreamEvent<unknown, infer M>> ? M : never

      const slim = Projected.readIndex("slim", key)
      expectTypeOf<MetadataOf<typeof slim>>().toEqualTypeOf<undefined>()
      expectTypeOf<Effect.Success<typeof slim>[number]["data"]>().toEqualTypeOf<
        Incremented | Reset
      >()
      const lean = Projected.readIndex("lean", key)
      expectTypeOf<MetadataOf<typeof lean>>().toEqualTypeOf<Meta | undefined>()
      const full = Projected.readIndex("full", key)
      expectTypeOf<MetadataOf<typeof full>>().toEqualTypeOf<Meta | undefined>()
      // A union name yields the union of the metadata types.
      const either = Projected.readIndex("slim" as "slim" | "lean", key)
      expectTypeOf<MetadataOf<typeof either>>().toEqualTypeOf<Meta | undefined>()

      // query.index mirrors readIndex.
      expectTypeOf<
        QueryMetadataOf<ReturnType<typeof Projected.query.index<"slim">>>
      >().toEqualTypeOf<undefined>()
      const leanQuery = Projected.query.index("lean", key)
      expectTypeOf<QueryMetadataOf<typeof leanQuery>>().toEqualTypeOf<Meta | undefined>()
      const slimQuery = Projected.query.index("slim", key)
      expectTypeOf(slimQuery).toEqualTypeOf<
        Query.Query<EventStore.StreamEvent<Incremented | Reset, undefined>>
      >()

      // @ts-expect-error — not a declared index name
      Projected.readIndex("byNothing", key)
      // @ts-expect-error — not a declared index name
      Projected.query.index("byNothing", key)

      EventStore.makeStream({
        table: AppTable,
        streamName: "BadProjection",
        events: [Incremented],
        streamId: { composite: ["counterId"] },
        indexes: {
          // @ts-expect-error — not a stream index projection
          bad: { index: "lsi1", sk: "lsi1sk", projection: "include", key: () => undefined },
        },
      })

      EventStore.makeStream({
        table: AppTable,
        streamName: "TypoProjection",
        events: [Incremented],
        streamId: { composite: ["counterId"] },
        indexes: {
          // @ts-expect-error — a misspelled `projection` is not an index member
          lsi: { index: "lsi1", sk: "lsi1sk", projecton: "keys", key: () => undefined },
          gsi: {
            type: "gsi",
            index: "gsi1",
            pk: "gsi1pk",
            sk: "gsi1sk",
            // @ts-expect-error — a misspelled `projection` is not an index member
            projecton: "keys",
            key: () => undefined,
          },
        },
      })

      // BoundEventStream mirrors the stream.
      Effect.gen(function* () {
        const bound = yield* EventStore.bind(Projected)
        expectTypeOf(bound).toEqualTypeOf<
          EventStore.BoundEventStream<
            Incremented | Reset,
            readonly ["counterId"],
            Meta,
            never,
            "slim" | "lean" | "full" | "declared",
            {
              readonly slim: "withoutMetadata"
              readonly lean: "keys"
              readonly full: "all"
              readonly declared: "all"
            }
          >
        >()
        const boundSlim = bound.readIndex("slim", key)
        expectTypeOf<MetadataOf<typeof boundSlim>>().toEqualTypeOf<undefined>()
        expectTypeOf<Effect.Services<typeof boundSlim>>().toEqualTypeOf<never>()
        const boundLean = bound.readIndex("lean", key)
        expectTypeOf<MetadataOf<typeof boundLean>>().toEqualTypeOf<Meta | undefined>()
        const boundQuery = bound.query.index("slim", key)
        expectTypeOf<QueryMetadataOf<typeof boundQuery>>().toEqualTypeOf<undefined>()
        // @ts-expect-error — not a declared index name
        bound.readIndex("byNothing", key)

        // Projected streams flow through commandHandler and indexDefinitions.
        const tallyDecider: EventStore.Decider<
          CounterState,
          { readonly by: number },
          Incremented | Reset,
          Overflow
        > = {
          initialState: { total: 0 },
          decide: (c) => Effect.succeed([new Incremented({ by: c.by })]),
          evolve: (state) => state,
        }
        const dataFirst = EventStore.commandHandler(tallyDecider, Projected)(key, command)
        expectTypeOf<Effect.Services<typeof dataFirst>>().toEqualTypeOf<Base>()
        const dataLast = Projected.pipe(EventStore.commandHandler(tallyDecider))(key, command)
        expectTypeOf<Effect.Services<typeof dataLast>>().toEqualTypeOf<Base>()
        const boundFirst = EventStore.commandHandler(tallyDecider, bound)(key, command)
        expectTypeOf<Effect.Services<typeof boundFirst>>().toEqualTypeOf<never>()
        EventStore.indexDefinitions(Projected, bound)
        // A hand-built settings object without `projection` is accepted.
        EventStore.indexDefinitions({
          streamName: "Manual",
          indexes: { byX: { type: "lsi", index: "lsi9", pk: "pk", sk: "lsi9sk" } },
        })
      })

      // A stream without indexes accepts no name.
      // @ts-expect-error — the stream declares no indexes
      Counter.readIndex("slim", key)
    })
    expect(true).toBe(true)
  })

  describe("per-event metadata (#144)", () => {
    interface Meta {
      readonly eventId: string
    }
    const Audited = EventStore.makeStream({
      table: AppTable,
      streamName: "Audited",
      events: [Incremented],
      streamId: { composite: ["counterId"] },
      metadata: Schema.Struct({ eventId: Schema.String }),
    })
    const events = [new Incremented({ by: 1 }), new Incremented({ by: 2 })]

    /** The `R3` of an effectful `eventMetadata`. */
    class IdMinter extends Context.Service<IdMinter, { readonly next: Effect.Effect<string> }>()(
      "test/IdMinter",
    ) {}
    /** The `E3` of an effectful `eventMetadata` — not `ProjectionFailed` (the `E2`). */
    class MintFailed extends Data.TaggedError("MintFailed") {}
    /** In no handler's error channel — catches a channel widened to `unknown` / `any`. */
    type Unrelated = { readonly _tag: "Unrelated" }

    const mintIds = (decision: EventStore.Decision<CounterState, Incremented>) =>
      Effect.gen(function* () {
        const minter = yield* IdMinter
        const ids: Array<Meta> = []
        for (const _ of decision.events) {
          const id = yield* minter.next
          if (id === "") return yield* new MintFailed()
          ids.push({ eventId: id })
        }
        return ids
      })

    it("append: entries are typed M | undefined, exclusive with metadata", () => {
      typeOnly(() => {
        const appended = Audited.append(key, events, 0, {
          eventMetadata: [{ eventId: "a" }, undefined],
        })
        expectTypeOf<Effect.Error<typeof appended>>().toEqualTypeOf<EventStore.AppendError>()
        Audited.append(key, events, 0, { metadata: { eventId: "shared" } })
        // `undefined` counts as absent, so this is not "both".
        Audited.append(key, events, 0, { metadata: undefined, eventMetadata: [undefined] })

        type Entries = NonNullable<
          Extract<
            EventStore.AppendOptions<Meta>,
            { readonly eventMetadata?: ReadonlyArray<unknown> }
          >["eventMetadata"]
        >
        expectTypeOf<Entries>().toEqualTypeOf<ReadonlyArray<Meta | undefined>>()

        // @ts-expect-error — metadata and eventMetadata are exclusive
        Audited.append(key, events, 0, { metadata: { eventId: "x" }, eventMetadata: [] })
        // @ts-expect-error — an entry is the stream's metadata type
        Audited.append(key, events, 0, { eventMetadata: [{ eventId: 1 }] })
        // @ts-expect-error — eventMetadata is an array, not one value
        Audited.append(key, events, 0, { eventMetadata: { eventId: "x" } })

        Effect.gen(function* () {
          const bound = yield* EventStore.bind(Audited)
          const boundAppended = bound.append(key, events, 0, {
            eventMetadata: [{ eventId: "a" }, { eventId: "b" }],
          })
          expectTypeOf<Effect.Services<typeof boundAppended>>().toEqualTypeOf<never>()
          // @ts-expect-error — metadata and eventMetadata are exclusive
          bound.append(key, events, 0, { metadata: { eventId: "x" }, eventMetadata: [] })
        })
      })
      expect(true).toBe(true)
    })

    it("handler: eventMetadata receives the Decision and is exclusive with metadata", () => {
      typeOnly(() => {
        const handle = EventStore.commandHandler(decider, Audited)
        const pure = handle(key, command, {
          eventMetadata: (decision) => {
            expectTypeOf(decision).toEqualTypeOf<EventStore.Decision<CounterState, Incremented>>()
            return decision.events.map((_, i) => (i === 0 ? { eventId: "a" } : undefined))
          },
        })
        const plain = handle(key, command)
        expectTypeOf<Effect.Services<typeof pure>>().toEqualTypeOf<Base>()
        expectTypeOf<Effect.Error<typeof pure>>().toEqualTypeOf<Effect.Error<typeof plain>>()
        handle(key, command, { metadata: { eventId: "shared" } })

        handle(key, command, {
          metadata: { eventId: "x" },
          // @ts-expect-error — metadata and eventMetadata are exclusive
          eventMetadata: () => [],
        })
        // @ts-expect-error — function-only: a static array cannot know the event count
        handle(key, command, { eventMetadata: [{ eventId: "x" }] })
        // @ts-expect-error — an entry is the stream's metadata type
        handle(key, command, { eventMetadata: () => [{ eventId: 1 }] })
      })
      expect(true).toBe(true)
    })

    it("an effectful eventMetadata joins E3 / R3 next to additionalItems' E2 / R2", () => {
      typeOnly(() => {
        const handle = EventStore.commandHandler(decider, Audited)
        const onlyIds = handle(key, command, { eventMetadata: mintIds })
        expectTypeOf<Effect.Services<typeof onlyIds>>().toEqualTypeOf<Base | IdMinter>()
        expectTypeOf<MintFailed>().toExtend<Effect.Error<typeof onlyIds>>()
        expectTypeOf<ProjectionFailed>().not.toExtend<Effect.Error<typeof onlyIds>>()

        const both = handle(key, command, {
          eventMetadata: mintIds,
          additionalItems: effectfulItems,
        })
        expectTypeOf<Effect.Services<typeof both>>().toEqualTypeOf<Base | IdMinter | Projector>()
        expectTypeOf<MintFailed>().toExtend<Effect.Error<typeof both>>()
        expectTypeOf<ProjectionFailed>().toExtend<Effect.Error<typeof both>>()
        expectTypeOf<Overflow>().toExtend<Effect.Error<typeof both>>()
        expectTypeOf<Unrelated>().not.toExtend<Effect.Error<typeof both>>()

        // Data-last form.
        const piped = Audited.pipe(EventStore.commandHandler(decider))
        const pipedBoth = piped(key, command, {
          additionalItems: effectfulItems,
          eventMetadata: mintIds,
        })
        expectTypeOf<Effect.Services<typeof pipedBoth>>().toEqualTypeOf<
          Base | IdMinter | Projector
        >()
        expectTypeOf<MintFailed | ProjectionFailed>().toExtend<Effect.Error<typeof pipedBoth>>()
        expectTypeOf<Unrelated>().not.toExtend<Effect.Error<typeof pipedBoth>>()

        Effect.gen(function* () {
          const bound = yield* EventStore.bind(Audited)
          const dataFirst = EventStore.commandHandler(decider, bound)(key, command, {
            eventMetadata: mintIds,
            additionalItems: effectfulItems,
          })
          expectTypeOf<Effect.Services<typeof dataFirst>>().toEqualTypeOf<IdMinter | Projector>()
          expectTypeOf<MintFailed | ProjectionFailed>().toExtend<Effect.Error<typeof dataFirst>>()
          // Guards against the bound error channel widening to unknown / any.
          expectTypeOf<Unrelated>().not.toExtend<Effect.Error<typeof dataFirst>>()
          const dataLast = bound.pipe(EventStore.commandHandler(decider))(key, command, {
            eventMetadata: mintIds,
          })
          expectTypeOf<Effect.Services<typeof dataLast>>().toEqualTypeOf<IdMinter>()
          expectTypeOf<MintFailed>().toExtend<Effect.Error<typeof dataLast>>()
          expectTypeOf<Unrelated>().not.toExtend<Effect.Error<typeof dataLast>>()
          EventStore.commandHandler(decider, bound)(key, command, {
            metadata: { eventId: "x" },
            // @ts-expect-error — metadata and eventMetadata are exclusive
            eventMetadata: mintIds,
          })
        })
      })
      expect(true).toBe(true)
    })

    it("idempotency still requires commandId with eventMetadata present", () => {
      typeOnly(() => {
        const dataFirst = EventStore.commandHandler(decider, Audited, { idempotency: {} })
        // @ts-expect-error — commandId is required
        dataFirst(key, command, { eventMetadata: mintIds })
        const result = dataFirst(key, command, { commandId: "cmd-1", eventMetadata: mintIds })
        expectTypeOf<Effect.Services<typeof result>>().toEqualTypeOf<Base | IdMinter>()
        expectTypeOf<MintFailed>().toExtend<Effect.Error<typeof result>>()
        expectTypeOf<Unrelated>().not.toExtend<Effect.Error<typeof result>>()
        // @ts-expect-error — metadata and eventMetadata are exclusive
        dataFirst(key, command, {
          commandId: "cmd-1",
          metadata: { eventId: "x" },
          eventMetadata: mintIds,
        })

        const dataLast = Audited.pipe(EventStore.commandHandler(decider, { idempotency: {} }))
        // @ts-expect-error — commandId is required
        dataLast(key, command, { eventMetadata: mintIds })
        Effect.gen(function* () {
          const bound = yield* EventStore.bind(Audited)
          const boundFirst = EventStore.commandHandler(decider, bound, { idempotency: {} })
          // @ts-expect-error — commandId is required
          boundFirst(key, command, { eventMetadata: () => [] })
          const boundResult = boundFirst(key, command, {
            commandId: "cmd-1",
            eventMetadata: mintIds,
          })
          expectTypeOf<Effect.Services<typeof boundResult>>().toEqualTypeOf<IdMinter>()
          expectTypeOf<MintFailed>().toExtend<Effect.Error<typeof boundResult>>()
          expectTypeOf<Unrelated>().not.toExtend<Effect.Error<typeof boundResult>>()
        })
      })
      expect(true).toBe(true)
    })

    describe("eventTimestamps", () => {
      const t = DateTime.makeUnsafe("2019-05-01T00:00:00Z")

      it("append: entries are DateTime | undefined, next to either metadata option", () => {
        typeOnly(() => {
          type Entries = NonNullable<EventStore.AppendOptions<Meta>["eventTimestamps"]>
          expectTypeOf<Entries>().toEqualTypeOf<ReadonlyArray<DateTime.DateTime | undefined>>()

          const appended = Audited.append(key, events, 0, { eventTimestamps: [t, undefined] })
          expectTypeOf<Effect.Error<typeof appended>>().toEqualTypeOf<EventStore.AppendError>()
          // A zoned DateTime is a DateTime.
          Audited.append(key, events, 0, {
            eventTimestamps: [DateTime.makeZonedUnsafe(0, { timeZone: "Europe/London" }), t],
          })
          Audited.append(key, events, 0, {
            metadata: { eventId: "shared" },
            eventTimestamps: [t, t],
          })
          Audited.append(key, events, 0, {
            eventMetadata: [{ eventId: "a" }, undefined],
            eventTimestamps: [undefined, t],
          })

          // @ts-expect-error — an entry is a DateTime, not a Date
          Audited.append(key, events, 0, { eventTimestamps: [new Date(0), t] })
          // @ts-expect-error — an entry is a DateTime, not an ISO string
          Audited.append(key, events, 0, { eventTimestamps: ["2019-05-01T00:00:00Z", t] })
          // @ts-expect-error — eventTimestamps is an array, not one value
          Audited.append(key, events, 0, { eventTimestamps: t })

          Effect.gen(function* () {
            const bound = yield* EventStore.bind(Audited)
            const boundAppended = bound.append(key, events, 0, {
              eventMetadata: [{ eventId: "a" }, { eventId: "b" }],
              eventTimestamps: [t, t],
            })
            expectTypeOf<Effect.Services<typeof boundAppended>>().toEqualTypeOf<never>()
            // @ts-expect-error — an entry is a DateTime, not a Date
            bound.append(key, events, 0, { eventTimestamps: [new Date(0), t] })
          })
        })
        expect(true).toBe(true)
      })

      it("handler: a plain function of the Decision, widening neither channel", () => {
        typeOnly(() => {
          const handle = EventStore.commandHandler(decider, Audited)
          const plain = handle(key, command)
          const stamped = handle(key, command, {
            eventTimestamps: (decision) => {
              expectTypeOf(decision).toEqualTypeOf<EventStore.Decision<CounterState, Incremented>>()
              return decision.events.map((_, i) => (i === 0 ? t : undefined))
            },
          })
          expectTypeOf<Effect.Services<typeof stamped>>().toEqualTypeOf<Base>()
          expectTypeOf<Effect.Error<typeof stamped>>().toEqualTypeOf<Effect.Error<typeof plain>>()

          // Alongside either metadata option, and an effectful pair: only the
          // pair's E2 / R2 and E3 / R3 join the channels.
          handle(key, command, {
            metadata: { eventId: "shared" },
            eventTimestamps: ({ events }) => events.map(() => t),
          })
          const all = handle(key, command, {
            eventMetadata: mintIds,
            eventTimestamps: ({ events }) => events.map(() => t),
            additionalItems: effectfulItems,
          })
          expectTypeOf<Effect.Services<typeof all>>().toEqualTypeOf<Base | IdMinter | Projector>()
          expectTypeOf<MintFailed | ProjectionFailed>().toExtend<Effect.Error<typeof all>>()
          expectTypeOf<Unrelated>().not.toExtend<Effect.Error<typeof all>>()

          // @ts-expect-error — function-only: a static array cannot know the event count
          handle(key, command, { eventTimestamps: [t] })
          handle(key, command, {
            // @ts-expect-error — an entry is a DateTime, not a Date
            eventTimestamps: ({ events }) => events.map(() => new Date(0)),
          })

          // Idempotency still requires commandId.
          const idempotent = EventStore.commandHandler(decider, Audited, { idempotency: {} })
          // @ts-expect-error — commandId is required
          idempotent(key, command, { eventTimestamps: () => [t] })
          idempotent(key, command, { commandId: "cmd-1", eventTimestamps: () => [t] })

          Effect.gen(function* () {
            const bound = yield* EventStore.bind(Audited)
            const boundStamped = bound.pipe(EventStore.commandHandler(decider))(key, command, {
              eventTimestamps: () => [t],
            })
            expectTypeOf<Effect.Services<typeof boundStamped>>().toEqualTypeOf<never>()
            expectTypeOf<Unrelated>().not.toExtend<Effect.Error<typeof boundStamped>>()
          })
        })
        expect(true).toBe(true)
      })

      /** The `R4` of an effectful `eventTimestamps`. */
      class SourceLog extends Context.Service<
        SourceLog,
        { readonly originalTime: (by: number) => Effect.Effect<DateTime.DateTime | undefined> }
      >()("test/SourceLog") {}
      /** The `E4` of an effectful `eventTimestamps` — neither `MintFailed` nor `ProjectionFailed`. */
      class LookupFailed extends Data.TaggedError("LookupFailed") {}

      const sourceTimes = (decision: EventStore.Decision<CounterState, Incremented>) =>
        Effect.gen(function* () {
          const log = yield* SourceLog
          const times: Array<DateTime.DateTime | undefined> = []
          for (const event of decision.events) {
            const time = yield* log.originalTime(event.by)
            if (time === undefined) return yield* new LookupFailed()
            times.push(time)
          }
          return times
        })

      it("handler: an Effect form joins its own E4 / R4", () => {
        typeOnly(() => {
          const handle = EventStore.commandHandler(decider, Audited)
          const plain = handle(key, command)

          // Alone: E4 / R4 inferred, nothing else joins.
          const alone = handle(key, command, {
            eventTimestamps: (decision) => {
              expectTypeOf(decision).toEqualTypeOf<EventStore.Decision<CounterState, Incremented>>()
              return sourceTimes(decision)
            },
          })
          expectTypeOf<Effect.Services<typeof alone>>().toEqualTypeOf<Base | SourceLog>()
          expectTypeOf<Effect.Error<typeof alone>>().toEqualTypeOf<
            Effect.Error<typeof plain> | LookupFailed
          >()
          expectTypeOf<MintFailed>().not.toExtend<Effect.Error<typeof alone>>()
          expectTypeOf<Unrelated>().not.toExtend<Effect.Error<typeof alone>>()

          // A service-free Effect (e.g. through the Clock) adds nothing.
          const clocked = handle(key, command, {
            eventTimestamps: ({ events }) =>
              Effect.map(DateTime.now, (now) => events.map(() => now)),
          })
          expectTypeOf<Effect.Services<typeof clocked>>().toEqualTypeOf<Base>()
          expectTypeOf<Effect.Error<typeof clocked>>().toEqualTypeOf<Effect.Error<typeof plain>>()

          // Next to a plain eventMetadata: still only E4 / R4.
          const plainMeta = handle(key, command, {
            eventMetadata: ({ events }) => events.map(() => ({ eventId: "a" })),
            eventTimestamps: sourceTimes,
          })
          expectTypeOf<Effect.Services<typeof plainMeta>>().toEqualTypeOf<Base | SourceLog>()
          expectTypeOf<Effect.Error<typeof plainMeta>>().toEqualTypeOf<
            Effect.Error<typeof plain> | LookupFailed
          >()

          // A plain eventTimestamps next to an effectful eventMetadata: only E3 / R3.
          const plainStamps = handle(key, command, {
            eventMetadata: mintIds,
            eventTimestamps: ({ events }) => events.map(() => t),
          })
          expectTypeOf<Effect.Services<typeof plainStamps>>().toEqualTypeOf<Base | IdMinter>()
          expectTypeOf<Effect.Error<typeof plainStamps>>().toEqualTypeOf<
            Effect.Error<typeof plain> | MintFailed
          >()

          // The case one shared E3 / R3 pair breaks: three effects, three
          // different error types and services — all inferred as unions.
          const all = handle(key, command, {
            eventMetadata: mintIds,
            eventTimestamps: sourceTimes,
            additionalItems: effectfulItems,
          })
          expectTypeOf<Effect.Services<typeof all>>().toEqualTypeOf<
            Base | IdMinter | SourceLog | Projector
          >()
          expectTypeOf<Effect.Error<typeof all>>().toEqualTypeOf<
            Effect.Error<typeof plain> | MintFailed | LookupFailed | ProjectionFailed
          >()
          expectTypeOf<Unrelated>().not.toExtend<Effect.Error<typeof all>>()

          // Data-last form.
          const piped = Audited.pipe(EventStore.commandHandler(decider))(key, command, {
            eventTimestamps: sourceTimes,
            eventMetadata: mintIds,
          })
          expectTypeOf<Effect.Services<typeof piped>>().toEqualTypeOf<Base | IdMinter | SourceLog>()
          expectTypeOf<Effect.Error<typeof piped>>().toEqualTypeOf<
            Effect.Error<typeof plain> | MintFailed | LookupFailed
          >()

          // Alongside per-call metadata.
          handle(key, command, { metadata: { eventId: "shared" }, eventTimestamps: sourceTimes })

          // @ts-expect-error — the Effect's element is a DateTime, not a string
          handle(key, command, { eventTimestamps: () => Effect.succeed(["2019-05-01T00:00:00Z"]) })
          handle(key, command, {
            // @ts-expect-error — the Effect's element is a DateTime, not a Date
            eventTimestamps: ({ events }) => Effect.succeed(events.map(() => new Date(0))),
          })

          // Idempotency still requires commandId.
          const idempotent = EventStore.commandHandler(decider, Audited, { idempotency: {} })
          // @ts-expect-error — commandId is required
          idempotent(key, command, { eventTimestamps: sourceTimes })
          const idempotentResult = idempotent(key, command, {
            commandId: "cmd-1",
            eventTimestamps: sourceTimes,
          })
          expectTypeOf<Effect.Services<typeof idempotentResult>>().toEqualTypeOf<Base | SourceLog>()
          expectTypeOf<LookupFailed>().toExtend<Effect.Error<typeof idempotentResult>>()
          expectTypeOf<Unrelated>().not.toExtend<Effect.Error<typeof idempotentResult>>()

          Effect.gen(function* () {
            const bound = yield* EventStore.bind(Audited)
            const boundPlain = bound.pipe(EventStore.commandHandler(decider))(key, command)
            // On a bound stream R4 is the only requirement.
            const boundAlone = bound.pipe(EventStore.commandHandler(decider))(key, command, {
              eventTimestamps: sourceTimes,
            })
            expectTypeOf<Effect.Services<typeof boundAlone>>().toEqualTypeOf<SourceLog>()
            expectTypeOf<Effect.Error<typeof boundAlone>>().toEqualTypeOf<
              Effect.Error<typeof boundPlain> | LookupFailed
            >()
            const boundAll = EventStore.commandHandler(decider, bound)(key, command, {
              eventMetadata: mintIds,
              eventTimestamps: sourceTimes,
              additionalItems: effectfulItems,
            })
            expectTypeOf<Effect.Services<typeof boundAll>>().toEqualTypeOf<
              IdMinter | SourceLog | Projector
            >()
            expectTypeOf<Effect.Error<typeof boundAll>>().toEqualTypeOf<
              Effect.Error<typeof boundPlain> | MintFailed | LookupFailed | ProjectionFailed
            >()
            // Guards against the bound error channel widening to unknown / any.
            expectTypeOf<Unrelated>().not.toExtend<Effect.Error<typeof boundAll>>()
          })
        })
        expect(true).toBe(true)
      })
    })
  })
})

describe("EventStore packed storage types (#147)", () => {
  const Packed = EventStore.makeStream({
    table: AppTable,
    streamName: "Packed",
    events: [Incremented],
    streamId: { composite: ["counterId"] },
    metadata: Schema.Struct({ by: Schema.String }),
    storedAs: { data: DynamoModel.Packed({ format: "json" }) },
    snapshot: {
      schema: Schema.Struct({ total: Schema.Number }),
      storedAs: DynamoModel.Packed({ format: "json", compression: { codec: "zstd" } }),
    },
  })

  it("storedAs admits only data, and only Packed configs", () => {
    typeOnly(() => {
      EventStore.makeStream({
        table: AppTable,
        streamName: "Bad",
        events: [Incremented],
        streamId: { composite: ["counterId"] },
        // @ts-expect-error — metadata always stays a map
        storedAs: { metadata: DynamoModel.Packed({ format: "json" }) },
      })
      EventStore.makeStream({
        table: AppTable,
        streamName: "Bad",
        events: [Incremented],
        streamId: { composite: ["counterId"] },
        // @ts-expect-error — not a Packed config
        storedAs: { data: { format: "json" } },
      })
      EventStore.makeStream({
        table: AppTable,
        streamName: "Bad",
        events: [Incremented],
        streamId: { composite: ["counterId"] },
        // @ts-expect-error — not a Packed config
        snapshot: { schema: Schema.Struct({ total: Schema.Number }), storedAs: "json" },
      })
    })
    expectTypeOf(Packed.storedAs).toEqualTypeOf<EventStore.StreamStorageSettings>()
  })

  it("error channels are those of 1.25.0 (a missing compressor is a ValidationError)", () => {
    typeOnly(() => {
      type ReadErrors = DynamoClientError | ValidationError
      expectTypeOf<Effect.Error<ReturnType<typeof Packed.read>>>().toEqualTypeOf<ReadErrors>()
      expectTypeOf<Effect.Error<ReturnType<typeof Packed.readFrom>>>().toEqualTypeOf<ReadErrors>()
      expectTypeOf<Effect.Error<ReturnType<typeof Packed.readLatest>>>().toEqualTypeOf<ReadErrors>()
      expectTypeOf<
        Effect.Error<ReturnType<typeof Packed.readSnapshot>>
      >().toEqualTypeOf<ReadErrors>()
      expectTypeOf<
        Effect.Error<ReturnType<typeof Packed.writeSnapshot>>
      >().toEqualTypeOf<ReadErrors>()
      expectTypeOf<
        Effect.Error<ReturnType<typeof Packed.currentVersion>>
      >().toEqualTypeOf<ReadErrors>()
      expectTypeOf<EventStore.AppendError>().toEqualTypeOf<
        | VersionConflict
        | StreamSealed
        | DuplicateCommand
        | AdditionalItemConditionFailed
        | AppendTooLarge
        | DynamoClientError
        | ValidationError
        | TransactionCancelled
        | UniqueConstraintViolation
        | OptimisticLockError
        | ConcurrentModification
      >()
      expectTypeOf<
        Effect.Error<ReturnType<typeof Packed.append>>
      >().toEqualTypeOf<EventStore.AppendError>()
      expectTypeOf<
        Effect.Error<ReturnType<typeof Query.collect<unknown>>>
      >().toEqualTypeOf<ReadErrors>()
      const handled = EventStore.commandHandler(decider, Packed)(key, command)
      expectTypeOf<Effect.Error<typeof handled>>().toEqualTypeOf<
        Overflow | EventStore.AppendError
      >()
    })
    expect(true).toBe(true)
  })

  it("measureAppend / measureSnapshot / decodeStreamImage signatures", () => {
    typeOnly(() => {
      const measured = Packed.measureAppend(key, [new Incremented({ by: 1 })], 0, {
        metadata: { by: "me" },
        snapshot: { total: 1 },
      })
      expectTypeOf(measured).toEqualTypeOf<
        Effect.Effect<EventStore.AppendMeasurement, ValidationError, Table.TableConfig>
      >()
      // @ts-expect-error — additionalItems are not measured
      Packed.measureAppend(key, [], 0, { additionalItems: [] })
      expectTypeOf(Packed.measureSnapshot(key, { total: 1 }, 1)).toEqualTypeOf<
        Effect.Effect<number, ValidationError, Table.TableConfig>
      >()
      // @ts-expect-error — no snapshot config: the state is never
      Counter.measureSnapshot(key, { total: 1 }, 1)
      const decoded = Packed.decodeStreamImage({ pk: { S: "x" } })
      expectTypeOf(decoded).toEqualTypeOf<
        Effect.Effect<
          Option.Option<EventStore.StreamEvent<Incremented, { readonly by: string } | undefined>>,
          ValidationError,
          never
        >
      >()
      Effect.gen(function* () {
        const bound = yield* EventStore.bind(Packed)
        expectTypeOf(bound.measureAppend(key, [], 0)).toEqualTypeOf<
          Effect.Effect<EventStore.AppendMeasurement, ValidationError, never>
        >()
        expectTypeOf(bound.decodeStreamImage({})).toEqualTypeOf<typeof decoded>()
        expectTypeOf(bound.decodeStreamImage({}, { raw: true })).toEqualTypeOf<typeof decodedRaw>()
      })
      // { raw: true } adds rawData; { raw: false } or no option does not.
      const decodedRaw = Packed.decodeStreamImage({ pk: { S: "x" } }, { raw: true })
      expectTypeOf(decodedRaw).toEqualTypeOf<
        Effect.Effect<
          Option.Option<
            EventStore.RawStreamEvent<Incremented, { readonly by: string } | undefined>
          >,
          ValidationError,
          never
        >
      >()
      expectTypeOf(Packed.decodeStreamImage({}, { raw: false })).toEqualTypeOf<typeof decoded>()
      expectTypeOf(Packed.decodeStreamImage({}, {})).toEqualTypeOf<typeof decoded>()
      expectTypeOf<EventStore.RawStreamEvent<Incremented>["rawData"]>().toEqualTypeOf<
        Readonly<Record<string, unknown>>
      >()
    })
    expect(true).toBe(true)
  })
})

describe("EventStore shared stream index types (#149)", () => {
  class Placed extends Schema.TaggedClass<Placed>()("Placed", { groupId: Schema.String }) {}
  const State = Schema.Struct({ total: Schema.Number })

  it("types the partition, key and snapshot functions, and the partition of a read", () => {
    typeOnly(() => {
      const Grouped = EventStore.makeStream({
        table: AppTable,
        streamName: "Grouped",
        events: [Incremented, Placed],
        streamId: { composite: ["groupId", "counterId"] },
        snapshot: { schema: State, mode: "inline" },
        indexes: {
          byGroup: {
            type: "gsi",
            index: "gsi1",
            pk: "gsi1pk",
            sk: "gsi1sk",
            partition: (event, version, streamId) => {
              expectTypeOf(version).toEqualTypeOf<number>()
              expectTypeOf(streamId).toEqualTypeOf<{
                readonly groupId: string
                readonly counterId: string
              }>()
              expectTypeOf(event).toEqualTypeOf<Incremented | Placed>()
              return event._tag === "Placed" ? `G#${event.groupId}` : `G#${streamId.groupId}`
            },
            key: (_event, version, streamId) => {
              expectTypeOf(streamId.counterId).toEqualTypeOf<string>()
              return `C#${streamId.counterId}#${version}`
            },
            snapshot: (state, asOfVersion, streamId) => {
              expectTypeOf(state).toEqualTypeOf<{ readonly total: number }>()
              expectTypeOf(asOfVersion).toEqualTypeOf<number>()
              return { partition: `G#${streamId.groupId}`, key: `C#${streamId.counterId}#S` }
            },
          },
          byAmount: { index: "lsi1", sk: "lsi1sk", key: (event) => event._tag },
        },
      })
      expectTypeOf(Grouped).toEqualTypeOf<
        EventStore.EventStream<
          Incremented | Placed,
          readonly ["groupId", "counterId"],
          undefined,
          { readonly total: number },
          "byGroup" | "byAmount",
          { readonly byGroup: "all"; readonly byAmount: "all" },
          "byGroup"
        >
      >()

      const id = { groupId: "g-1", counterId: "c-1" }
      const read = Grouped.readIndex("byGroup", id, { partition: "G#g-1", beginsWith: "C#c-1" })
      expectTypeOf<Effect.Success<typeof read>[number]["data"]>().toEqualTypeOf<
        Incremented | Placed
      >()
      // @ts-expect-error — the index derives its partition: it is required
      Grouped.readIndex("byGroup", id)
      // @ts-expect-error — the index derives its partition: it is required
      Grouped.readIndex("byGroup", id, { beginsWith: "C#" })
      Grouped.readIndex("byAmount", id)
      // A stream whose indexes derive their partition is still an EventStream
      // of its events, state and stream id (a scoped index's `partition` is
      // refused at runtime instead).
      const plain: EventStore.EventStream<
        Incremented | Placed,
        readonly ["groupId", "counterId"],
        undefined,
        { readonly total: number }
      > = Grouped
      expectTypeOf(plain.streamName).toEqualTypeOf<string>()
      Grouped.query.index("byGroup", id, { partition: "G#g-1" })
      // @ts-expect-error — the index derives its partition: it is required
      Grouped.query.index("byGroup", id)
      Grouped.query.index("byAmount", id)

      Effect.gen(function* () {
        const bound = yield* EventStore.bind(Grouped)
        const boundRead = bound.readIndex("byGroup", id, { partition: "G#g-1" })
        expectTypeOf<Effect.Services<typeof boundRead>>().toEqualTypeOf<never>()
        // @ts-expect-error — the index derives its partition: it is required
        bound.readIndex("byGroup", id)
      })

      // Streams with a derived partition flow through commandHandler and
      // indexDefinitions.
      const GroupedCounter = EventStore.makeStream({
        table: AppTable,
        streamName: "GroupedCounter",
        events: [Incremented],
        streamId: { composite: ["counterId"] },
        snapshot: { schema: State, mode: "inline" },
        indexes: {
          byGroup: {
            type: "gsi",
            index: "gsi1",
            pk: "gsi1pk",
            sk: "gsi1sk",
            partition: () => "G",
            key: () => "K",
            snapshot: () => undefined,
          },
        },
      })
      const handled = EventStore.commandHandler(decider, GroupedCounter)(key, command)
      expectTypeOf<Effect.Services<typeof handled>>().toEqualTypeOf<Base>()
      EventStore.indexDefinitions(Grouped, GroupedCounter, Counter)

      // A generic wrapper over a stream's index names (the 1.26 shape)
      // type-checks: with no index deriving its partition, the options stay
      // optional while the name is still a type parameter.
      const readAny = <F extends ReadonlyArray<string>, I extends string>(
        stream: EventStore.EventStream<Incremented, F, undefined, never, I>,
        name: I,
        streamId: { readonly [K in F[number]]: string },
        options?: EventStore.ReadIndexOptions,
      ) => {
        const read = stream.readIndex(name, streamId, options)
        const query = stream.query.index(name, streamId)
        return { read, query }
      }
      const Indexed = EventStore.makeStream({
        table: AppTable,
        streamName: "Wrapped",
        events: [Incremented],
        streamId: { composite: ["counterId"] },
        indexes: { byAmount: { index: "lsi1", sk: "lsi1sk", key: (e) => `${e.by}` } },
      })
      readAny(Indexed, "byAmount", key, { limit: 1 })

      EventStore.makeStream({
        table: AppTable,
        streamName: "BadLsi",
        events: [Incremented],
        streamId: { composite: ["counterId"] },
        indexes: {
          // @ts-expect-error — an lsi is partitioned by the stream
          lsi: { index: "lsi1", sk: "lsi1sk", key: () => "K", partition: () => "P" },
        },
      })
      EventStore.makeStream({
        table: AppTable,
        streamName: "BadEntry",
        events: [Incremented],
        streamId: { composite: ["counterId"] },
        snapshot: { schema: State },
        indexes: {
          byGroup: {
            type: "gsi",
            index: "gsi1",
            pk: "gsi1pk",
            sk: "gsi1sk",
            partition: () => "P",
            key: () => "K",
            // @ts-expect-error — the entry is { partition, key }
            snapshot: () => ({ partition: "P" }),
          },
        },
      })
    })
    expect(true).toBe(true)
  })
})

describe("commandHandler loadState and headProof (#164)", () => {
  /** The store holding the caller's state records — `loadState`'s requirement. */
  class RecordStore extends Context.Service<
    RecordStore,
    {
      readonly load: (
        id: string,
      ) => Effect.Effect<Option.Option<EventStore.LoadedState<CounterState>>, RecordUnavailable>
    }
  >()("test/RecordStore") {}
  class RecordUnavailable extends Data.TaggedError("RecordUnavailable") {}

  const loadState = (streamId: { readonly counterId: string }) =>
    Effect.flatMap(RecordStore, (store) => store.load(streamId.counterId))

  it("loadState's error and requirements join the handler's, in every form", () => {
    typeOnly(() => {
      const handle = EventStore.commandHandler(decider, Counter, {
        loadState: (streamId) => {
          // Contextually typed by the stream and the decider.
          expectTypeOf(streamId).toEqualTypeOf<EventStore.StreamIdInput<readonly ["counterId"]>>()
          return loadState(streamId)
        },
        headProof: { additionalItem: 0 },
      })
      const result = handle(key, command)
      expectTypeOf<Effect.Services<typeof result>>().toEqualTypeOf<Base | RecordStore>()
      expectTypeOf<RecordUnavailable>().toExtend<Effect.Error<typeof result>>()
      expectTypeOf<Overflow>().toExtend<Effect.Error<typeof result>>()

      // Data-last.
      const piped = Counter.pipe(EventStore.commandHandler(decider, { loadState }))
      const pipedResult = piped(key, command)
      expectTypeOf<Effect.Services<typeof pipedResult>>().toEqualTypeOf<Base | RecordStore>()
      expectTypeOf<RecordUnavailable>().toExtend<Effect.Error<typeof pipedResult>>()

      // Bound: loadState's requirements are the handler's only ones.
      Effect.gen(function* () {
        const bound = yield* EventStore.bind(Counter)
        const boundResult = EventStore.commandHandler(decider, bound, { loadState })(key, command)
        expectTypeOf<Effect.Services<typeof boundResult>>().toEqualTypeOf<RecordStore>()
        const boundPiped = bound.pipe(EventStore.commandHandler(decider, { loadState }))(
          key,
          command,
        )
        expectTypeOf<Effect.Services<typeof boundPiped>>().toEqualTypeOf<RecordStore>()
        expectTypeOf<RecordUnavailable>().toExtend<Effect.Error<typeof boundPiped>>()
      })
    })
    expect(true).toBe(true)
  })

  it("without loadState the handler's channels are unchanged", () => {
    typeOnly(() => {
      const plain = EventStore.commandHandler(decider, Counter)(key, command)
      const proved = EventStore.commandHandler(decider, Counter, {
        headProof: { additionalItem: 0 },
      })(key, command)
      expectTypeOf<Effect.Services<typeof proved>>().toEqualTypeOf<Base>()
      expectTypeOf<Effect.Error<typeof proved>>().toEqualTypeOf<Effect.Error<typeof plain>>()
    })
    expect(true).toBe(true)
  })

  it("loadState must return the decider's state", () => {
    typeOnly(() => {
      // @ts-expect-error — `total` must be a number
      EventStore.commandHandler(decider, Counter, {
        loadState: () => Effect.succeed(Option_some({ state: { total: "1" }, version: 1 })),
      })
    })
    expect(true).toBe(true)
  })

  it("append and measureAppend accept a headProof; nothing else is one", () => {
    typeOnly(() => {
      Counter.append(key, [], 0, { headProof: { additionalItem: 0 } })
      Counter.append(key, [], 0, { headProof: "snapshot" })
      Counter.measureAppend(key, [], 0, { headProof: { additionalItem: 0 } })
      // @ts-expect-error — not a head proof
      Counter.append(key, [], 0, { headProof: "record" })
      expectTypeOf<EventStore.HeadProof>().toEqualTypeOf<
        { readonly additionalItem: number } | "snapshot" | "none"
      >()
    })
    expect(true).toBe(true)
  })
})

describe('headProof: "none" (#173)', () => {
  it("append and measureAppend accept it, unbound and bound", () => {
    typeOnly(() => {
      Counter.append(key, [], 0, { headProof: "none" })
      Counter.measureAppend(key, [], 0, { headProof: "none" })
      Effect.gen(function* () {
        const bound = yield* EventStore.bind(Counter)
        yield* bound.append(key, [], 0, { headProof: "none" })
        yield* bound.measureAppend(key, [], 0, { headProof: "none" })
      })
    })
    expect(true).toBe(true)
  })

  it("commandHandler does not accept it, in either call form", () => {
    typeOnly(() => {
      // @ts-expect-error — "none" is append's alone
      EventStore.commandHandler(decider, Counter, { headProof: "none" })
      // @ts-expect-error — "none" is append's alone
      Counter.pipe(EventStore.commandHandler(decider, { headProof: "none" }))
      // The proofs it does accept are unchanged.
      EventStore.commandHandler(decider, Counter, { headProof: "snapshot" })
      EventStore.commandHandler(decider, Counter, { headProof: { additionalItem: 0 } })
      expectTypeOf<NonNullable<EventStore.CommandHandlerOptions["headProof"]>>().toEqualTypeOf<
        { readonly additionalItem: number } | "snapshot"
      >()
    })
    expect(true).toBe(true)
  })
})

declare const Option_some: <A>(value: A) => Option.Option<A>
