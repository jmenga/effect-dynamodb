/**
 * EventStore offloaded storage — types (#179, design §9.3, §10.2): what
 * `makeStream` infers for `EventStream`'s `TOffloaded`; reads typed per mode
 * (`LazyStreamEvent` / `LazySnapshot` when lazy) with `BlobStoreError` only
 * where an eager read can raise it; writes and `additionalItems`; stream
 * images, projections and the change-feed surface lazy by default; and a
 * stream that offloads nothing exactly as before.
 *
 * Compile-time only; checked by `tsc -p tsconfig.test.json` (`pnpm check`).
 */

import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import type { BlobStoreError, ValidationError } from "@effect-dynamodb/schema/Errors.js"
import { Effect, type Option, Schema } from "effect"
import { describe, expectTypeOf, it } from "vitest"
import type { DynamoClientError } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
import type { OffloadedValue } from "../src/Offload.js"
import * as Query from "../src/Query.js"
import * as Table from "../src/Table.js"

const AppSchema = DynamoSchema.make({ name: "evt", version: 1, escapeKeys: true })
const EventsTable = Table.make({ schema: AppSchema, entities: {} })

class Filed extends Schema.TaggedClass<Filed>()("Filed", { note: Schema.String }) {}
type CaseEvent = Filed
const CaseState = Schema.Struct({ notes: Schema.Array(Schema.String) })
type CaseState = typeof CaseState.Type

const overflow = DynamoModel.Packed({ format: "json", external: { threshold: 1_024 } })
const json = DynamoModel.Packed({ format: "json" })

const base = {
  table: EventsTable,
  events: [Filed],
  streamId: { composite: ["caseId"] },
} as const

const Both = EventStore.makeStream({
  ...base,
  streamName: "Both",
  storedAs: { data: overflow },
  snapshot: { schema: CaseState, mode: "inline", storedAs: overflow },
})
const DataOnly = EventStore.makeStream({
  ...base,
  streamName: "DataOnly",
  storedAs: { data: overflow },
  snapshot: { schema: CaseState, mode: "inline" },
})
const StateOnly = EventStore.makeStream({
  ...base,
  streamName: "StateOnly",
  storedAs: { data: json },
  snapshot: { schema: CaseState, mode: "inline", storedAs: overflow },
})
const Plain = EventStore.makeStream({
  ...base,
  streamName: "Plain",
  storedAs: { data: json },
  snapshot: { schema: CaseState, mode: "inline", storedAs: json },
})

type OffloadedOf<S> =
  S extends EventStore.EventStream<any, any, any, any, any, any, any, infer O> ? O : "none"

const id = { caseId: "c-1" }
type Meta = Record<string, unknown> | undefined

describe("EventStore offload types", () => {
  it("makeStream infers what a stream offloads", () => {
    expectTypeOf<OffloadedOf<typeof Both>>().toEqualTypeOf<"data" | "state">()
    expectTypeOf<OffloadedOf<typeof DataOnly>>().toEqualTypeOf<"data">()
    expectTypeOf<OffloadedOf<typeof StateOnly>>().toEqualTypeOf<"state">()
    expectTypeOf<OffloadedOf<typeof Plain>>().toEqualTypeOf<never>()
    expectTypeOf(Both.offload).toEqualTypeOf<EventStore.StreamOffloadSettings | undefined>()
  })

  it("a stream that offloads nothing reads and writes as before", () => {
    const read = Plain.read(id)
    expectTypeOf<Effect.Success<typeof read>>().toEqualTypeOf<
      ReadonlyArray<EventStore.StreamEvent<CaseEvent, Meta>>
    >()
    expectTypeOf<BlobStoreError>().not.toExtend<Effect.Error<typeof read>>()
    // `offloaded` is accepted and changes nothing.
    const lazy = Plain.read(id, { offloaded: "lazy" })
    expectTypeOf<Effect.Success<typeof lazy>>().toEqualTypeOf<Effect.Success<typeof read>>()
    expectTypeOf<Effect.Error<typeof lazy>>().toEqualTypeOf<Effect.Error<typeof read>>()
    const append = Plain.append(id, [new Filed({ note: "n" })], 0)
    expectTypeOf<Effect.Error<typeof append>>().toEqualTypeOf<EventStore.AppendError>()
    const snapshot = Plain.writeSnapshot(id, { notes: [] }, 1)
    expectTypeOf<Effect.Error<typeof snapshot>>().toEqualTypeOf<
      DynamoClientError | ValidationError
    >()
    const image = Plain.decodeStreamImage({})
    expectTypeOf<Effect.Success<typeof image>>().toEqualTypeOf<
      Option.Option<EventStore.StreamEvent<CaseEvent, Meta>>
    >()
    expectTypeOf<Effect.Error<typeof image>>().toEqualTypeOf<ValidationError>()
    // Options forwarded from a caller's own optional parameter, or `undefined`.
    const forward = (
      image: EventStore.StreamImage,
      options?: EventStore.DecodeStreamImageOptions,
    ) => Plain.decodeStreamImage(image, options)
    expectTypeOf<Effect.Success<ReturnType<typeof forward>>>().toEqualTypeOf<
      Option.Option<EventStore.StreamEvent<CaseEvent, Meta>>
    >()
    expectTypeOf<Effect.Error<ReturnType<typeof forward>>>().toEqualTypeOf<ValidationError>()
    const absent = Plain.decodeStreamImage({}, undefined)
    expectTypeOf<Effect.Success<typeof absent>>().toEqualTypeOf<Effect.Success<typeof image>>()
    const bound = Effect.map(EventStore.bind(Plain), (stream) =>
      stream.decodeStreamImage({}, undefined as EventStore.DecodeStreamImageOptions | undefined),
    )
    expectTypeOf<Effect.Success<Effect.Success<typeof bound>>>().toEqualTypeOf<
      Effect.Success<typeof image>
    >()
  })

  it("currentVersion reads only the version: it takes no offloaded mode", () => {
    const version = Both.currentVersion(id, { consistentRead: true })
    expectTypeOf<Effect.Success<typeof version>>().toEqualTypeOf<number>()
    expectTypeOf<BlobStoreError>().not.toExtend<Effect.Error<typeof version>>()
    // @ts-expect-error — `offloaded` is not a currentVersion option
    Both.currentVersion(id, { offloaded: "eager" })
  })

  it("reads are eager by default: BlobStoreError where the read meets an offloaded kind", () => {
    const read = Both.read(id)
    expectTypeOf<Effect.Success<typeof read>>().toEqualTypeOf<
      ReadonlyArray<EventStore.StreamEvent<CaseEvent, Meta>>
    >()
    expectTypeOf<BlobStoreError>().toExtend<Effect.Error<typeof read>>()
    expectTypeOf<BlobStoreError>().toExtend<Effect.Error<ReturnType<typeof Both.readFrom>>>()
    expectTypeOf<BlobStoreError>().toExtend<Effect.Error<ReturnType<typeof Both.readLatest>>>()
    expectTypeOf<BlobStoreError>().toExtend<Effect.Error<ReturnType<typeof Both.readSnapshot>>>()
    // Per kind: events of a state-only stream, the snapshot of a data-only one.
    expectTypeOf<BlobStoreError>().not.toExtend<Effect.Error<ReturnType<typeof StateOnly.read>>>()
    expectTypeOf<BlobStoreError>().not.toExtend<
      Effect.Error<ReturnType<typeof DataOnly.readSnapshot>>
    >()
    expectTypeOf<BlobStoreError>().toExtend<Effect.Error<ReturnType<typeof StateOnly.readLatest>>>()
  })

  it("offloaded: 'lazy' types LazyStreamEvent / LazySnapshot and drops BlobStoreError", () => {
    const read = Both.read(id, { offloaded: "lazy" })
    expectTypeOf<Effect.Success<typeof read>>().toEqualTypeOf<
      ReadonlyArray<EventStore.LazyStreamEvent<CaseEvent, Meta>>
    >()
    expectTypeOf<BlobStoreError>().not.toExtend<Effect.Error<typeof read>>()
    const latest = Both.readLatest(id, { offloaded: "lazy" })
    type Latest = Effect.Success<typeof latest>
    expectTypeOf<Latest["snapshot"]>().toEqualTypeOf<
      Option.Option<EventStore.LazySnapshot<CaseState>>
    >()
    expectTypeOf<Latest["events"]>().toEqualTypeOf<
      ReadonlyArray<EventStore.LazyStreamEvent<CaseEvent, Meta>>
    >()
    expectTypeOf<BlobStoreError>().not.toExtend<Effect.Error<typeof latest>>()
    const snapshot = Both.readSnapshot(id, { offloaded: "lazy" })
    expectTypeOf<Effect.Success<typeof snapshot>>().toEqualTypeOf<
      Option.Option<EventStore.LazySnapshot<CaseState>>
    >()
    // The lazy value's read() carries the store's errors.
    expectTypeOf<
      Effect.Error<ReturnType<EventStore.LazyStreamEvent<CaseEvent>["data"]["read"]>>
    >().toEqualTypeOf<BlobStoreError | ValidationError>()
    // A state-only stream's events stay StreamEvents.
    const stateOnly = StateOnly.read(id, { offloaded: "lazy" })
    expectTypeOf<Effect.Success<typeof stateOnly>>().toEqualTypeOf<
      ReadonlyArray<EventStore.StreamEvent<CaseEvent, Meta>>
    >()
  })

  it("Query.offloaded on query.events", () => {
    const eager = Both.query.events(id).pipe(Query.collect)
    expectTypeOf<Effect.Success<typeof eager>>().toEqualTypeOf<
      Array<EventStore.StreamEvent<CaseEvent, Meta>>
    >()
    expectTypeOf<BlobStoreError>().toExtend<Effect.Error<typeof eager>>()
    const lazy = Both.query.events(id).pipe(Query.offloaded("lazy"), Query.collect)
    expectTypeOf<Effect.Success<typeof lazy>[number]["data"]>().toEqualTypeOf<
      OffloadedValue<CaseEvent>
    >()
    expectTypeOf<BlobStoreError>().not.toExtend<Effect.Error<typeof lazy>>()
    const dataFirst = Query.offloaded(Both.query.events(id), "lazy").pipe(Query.collect)
    expectTypeOf<Effect.Success<typeof dataFirst>>().toEqualTypeOf<Effect.Success<typeof lazy>>()
    // A stream that offloads no data: unchanged.
    const plain = Plain.query.events(id).pipe(Query.offloaded("lazy"), Query.collect)
    expectTypeOf<Effect.Success<typeof plain>>().toEqualTypeOf<
      Array<EventStore.StreamEvent<CaseEvent, Meta>>
    >()
  })

  it("writes carry BlobStoreError per the kind they upload", () => {
    const append = Both.append(id, [new Filed({ note: "n" })], 0)
    expectTypeOf<Effect.Error<typeof append>>().toEqualTypeOf<
      EventStore.AppendError | BlobStoreError
    >()
    expectTypeOf<Effect.Error<ReturnType<typeof StateOnly.writeSnapshot>>>().toEqualTypeOf<
      DynamoClientError | ValidationError | BlobStoreError
    >()
    expectTypeOf<Effect.Error<ReturnType<typeof DataOnly.writeSnapshot>>>().toEqualTypeOf<
      DynamoClientError | ValidationError
    >()
    // additionalItems: an offloading stream's appendOp adds BlobStoreError to a plain append.
    const carried = Plain.append(id, [new Filed({ note: "n" })], 0, {
      additionalItems: [Both.appendOp({ caseId: "c-2" }, [new Filed({ note: "m" })], 0)],
    })
    expectTypeOf<Effect.Error<typeof carried>>().toEqualTypeOf<
      EventStore.AppendError | BlobStoreError
    >()
    const plainOp = Plain.append(id, [new Filed({ note: "n" })], 0, {
      additionalItems: [Plain.appendOp({ caseId: "c-2" }, [new Filed({ note: "m" })], 0)],
    })
    expectTypeOf<Effect.Error<typeof plainOp>>().toEqualTypeOf<EventStore.AppendError>()
    const erased: ReadonlyArray<any> = []
    const anyOps = Plain.append(id, [new Filed({ note: "n" })], 0, { additionalItems: erased })
    expectTypeOf<Effect.Error<typeof anyOps>>().toEqualTypeOf<EventStore.AppendError>()
  })

  it("commandHandler adds BlobStoreError for an offloading stream", () => {
    const decider: EventStore.Decider<CaseState, { readonly note: string }, CaseEvent> = {
      initialState: { notes: [] },
      decide: (command) => Effect.succeed([new Filed({ note: command.note })]),
      evolve: (state, event) => ({ notes: [...state.notes, event.note] }),
    }
    const offloading = EventStore.commandHandler(decider, Both)(id, { note: "n" })
    expectTypeOf<BlobStoreError>().toExtend<Effect.Error<typeof offloading>>()
    const plain = EventStore.commandHandler(decider, Plain)(id, { note: "n" })
    expectTypeOf<BlobStoreError>().not.toExtend<Effect.Error<typeof plain>>()
  })

  it("decodeStreamImage is lazy by default and eager on request", () => {
    const lazy = Both.decodeStreamImage({})
    expectTypeOf<Effect.Success<typeof lazy>>().toEqualTypeOf<
      Option.Option<EventStore.LazyStreamEvent<CaseEvent, Meta>>
    >()
    expectTypeOf<Effect.Error<typeof lazy>>().toEqualTypeOf<ValidationError>()
    const eager = Both.decodeStreamImage({}, { offloaded: "eager" })
    expectTypeOf<Effect.Success<typeof eager>>().toEqualTypeOf<
      Option.Option<EventStore.StreamEvent<CaseEvent, Meta>>
    >()
    expectTypeOf<Effect.Error<typeof eager>>().toEqualTypeOf<ValidationError | BlobStoreError>()
    const raw = Both.decodeStreamImage({}, { raw: true })
    expectTypeOf<Effect.Success<typeof raw>>().toEqualTypeOf<
      Option.Option<EventStore.LazyRawStreamEvent<CaseEvent, Meta>>
    >()
    // Forwarded options that may name either mode: either event, and the store's error.
    const forward = (options?: EventStore.DecodeStreamImageOptions) =>
      Both.decodeStreamImage({}, options)
    expectTypeOf<Effect.Success<ReturnType<typeof forward>>>().toEqualTypeOf<
      Option.Option<
        EventStore.LazyStreamEvent<CaseEvent, Meta> | EventStore.StreamEvent<CaseEvent, Meta>
      >
    >()
    expectTypeOf<Effect.Error<ReturnType<typeof forward>>>().toEqualTypeOf<
      ValidationError | BlobStoreError
    >()
    // `undefined`: the default, lazy.
    const absent = Both.decodeStreamImage({}, undefined)
    expectTypeOf<Effect.Success<typeof absent>>().toEqualTypeOf<Effect.Success<typeof lazy>>()
    expectTypeOf<Effect.Error<typeof absent>>().toEqualTypeOf<ValidationError>()
    // EventStore.decoder decodes in the default mode.
    const decode = EventStore.decoder({ both: Both, plain: Plain })
    type Decoded =
      Effect.Success<ReturnType<typeof decode>> extends Option.Option<infer D> ? D : never
    expectTypeOf<Extract<Decoded, { readonly stream: "both" }>["event"]>().toEqualTypeOf<
      EventStore.LazyStreamEvent<CaseEvent, Meta>
    >()
    expectTypeOf<Extract<Decoded, { readonly stream: "plain" }>["event"]>().toEqualTypeOf<
      EventStore.StreamEvent<CaseEvent, Meta>
    >()
  })

  it("projection handlers receive LazyStreamEvents by default", () => {
    const Summary = Schema.Struct({ caseId: Schema.String, n: Schema.Number, v: Schema.Number })
    const Summaries = Entity.make({
      model: Summary,
      entityType: "Summary",
      primaryKey: {
        pk: { field: "pk", composite: ["caseId"] },
        sk: { field: "sk", composite: [] },
      },
    })
    const config = {
      readModel: Summaries,
      key: (streamId: { readonly caseId: string }) => ({ caseId: streamId.caseId }),
      initial: (key: { readonly caseId: string }) => ({ caseId: key.caseId, n: 0, v: 0 }),
      checkpoint: "v" as const,
    }
    EventStore.projection({
      ...config,
      stream: Both,
      evolve: (state, event) => {
        expectTypeOf(event.data).toEqualTypeOf<OffloadedValue<CaseEvent>>()
        return Effect.succeed(state)
      },
    })
    const eager = EventStore.projection({
      ...config,
      stream: Both,
      offloaded: "eager",
      evolve: (state, event) => {
        expectTypeOf(event.data).toEqualTypeOf<CaseEvent>()
        return Effect.succeed(state)
      },
    })
    // An eager projection's reads can fail with the store's error.
    expectTypeOf<BlobStoreError>().toExtend<Effect.Error<ReturnType<typeof eager.rebuild>>>()
    EventStore.projection({
      ...config,
      stream: Plain,
      evolve: (state, event) => {
        expectTypeOf(event.data).toEqualTypeOf<CaseEvent>()
        return Effect.succeed(state)
      },
    })
    const Multi = Schema.Struct({
      caseId: Schema.String,
      checkpoints: Schema.Record(Schema.String, Schema.Number),
      revision: Schema.Number,
    })
    const Multis = Entity.make({
      model: Multi,
      entityType: "Multi",
      primaryKey: {
        pk: { field: "pk", composite: ["caseId"] },
        sk: { field: "sk", composite: [] },
      },
    })
    const multiConfig = {
      readModel: Multis,
      initial: (key: { readonly caseId: string }) => ({
        caseId: key.caseId,
        checkpoints: {},
        revision: 0,
      }),
      checkpoints: { field: "checkpoints" as const },
      revision: "revision" as const,
    }
    EventStore.multiProjection({
      ...multiConfig,
      sources: (source) => ({
        both: source(Both, {
          key: (streamId) => ({ caseId: streamId.caseId }),
          evolve: (state, event) => {
            expectTypeOf(event.data).toEqualTypeOf<OffloadedValue<CaseEvent>>()
            return Effect.succeed(state)
          },
        }),
        plain: source(Plain, {
          key: (streamId) => ({ caseId: streamId.caseId }),
          evolve: (state, event) => {
            expectTypeOf(event.data).toEqualTypeOf<CaseEvent>()
            return Effect.succeed(state)
          },
        }),
      }),
    })
    EventStore.multiProjection({
      ...multiConfig,
      offloaded: "eager",
      sources: (source) => ({
        both: source(Both, {
          key: (streamId) => ({ caseId: streamId.caseId }),
          evolve: (state, event) => {
            expectTypeOf(event.data).toEqualTypeOf<CaseEvent>()
            return Effect.succeed(state)
          },
        }),
      }),
    })
  })

  it("an offloading stream is a plain EventStream / BoundEventStream for erased code", () => {
    const streams: ReadonlyArray<EventStore.EventStream<any, any, any, any, any, any, any, any>> = [
      Both,
      Plain,
    ]
    expectTypeOf(streams).toEqualTypeOf<
      ReadonlyArray<EventStore.EventStream<any, any, any, any, any, any, any, any>>
    >()
    const bind = EventStore.bind(Both)
    type Bound = Effect.Success<typeof bind>
    expectTypeOf<OffloadedOf<Bound>>().toEqualTypeOf<"none">()
    expectTypeOf<
      Bound extends EventStore.BoundEventStream<any, any, any, any, any, any, any, infer O>
        ? O
        : never
    >().toEqualTypeOf<"data" | "state">()
  })
})
