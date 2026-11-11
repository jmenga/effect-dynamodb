/**
 * A read of a stored row lacking a field whose transformation throws on `undefined`, on an
 * aggregate, a stream and a projection: the rows published 1.39.0 stored, the field each case
 * removes, and what 1.39.0's read gave (`fixtures/missing-key-reads-1.39.0.json`, captured by
 * running 1.39.0 against DynamoDB Local). These run on a recording table
 * (`MissingKeyReads.test.ts`) and on DynamoDB Local (`connected.missing-key-reads.test.ts`).
 */
import { readFileSync } from "node:fs"
import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Cause, Effect, Exit, type Layer, Schema, SchemaGetter } from "effect"
import * as Aggregate from "../../src/Aggregate.js"
import { DynamoClient } from "../../src/DynamoClient.js"
import * as Entity from "../../src/Entity.js"
import * as EventStore from "../../src/EventStore.js"
import * as Table from "../../src/Table.js"

export type Item = Record<string, AttributeValue>
type Outcome = Record<string, unknown>

const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/missing-key-reads-1.39.0.json", import.meta.url), "utf8"),
) as Record<string, any>

/** One read of 1.39.0's rows with a field removed, and what 1.39.0's read gave. */
export interface Case {
  readonly name: string
  /** The rows to store: 1.39.0's, the field removed. */
  readonly rows: ReadonlyArray<Item>
  /** Whether the table has the aggregate's list index (`gsi1`, keys `gsi1pk` / `gsi1sk`). */
  readonly gsi1: boolean
  /** The layer naming the table `name`; needs a `DynamoClient`. */
  readonly layer: (name: string) => Layer.Layer<any, never, DynamoClient>
  /** What the read gave, as {@link describeExit} describes it. */
  readonly read: Effect.Effect<Outcome, unknown, any>
  /** What 1.39.0's read gave. */
  readonly expected: Outcome
}

const schema = DynamoSchema.make({ name: "mk", version: 1 })
/** A field whose transformation throws on `undefined`. */
const upper = Schema.Unknown.pipe(
  Schema.decodeTo(Schema.String, {
    decode: SchemaGetter.transform((u: unknown) => (u as string).toUpperCase()),
    encode: SchemaGetter.transform((s: string) => s.toLowerCase()),
  } as never),
)

/** `item` without the attribute at `path`. */
export const without = (item: Item, path: ReadonlyArray<string>): Item => {
  const copy = structuredClone(item)
  let at: Item = copy
  for (const step of path.slice(0, -1)) at = at[step]!.M as Item
  delete at[path[path.length - 1]!]
  return copy
}

/** An exit as the capture described it: its outcome, and a failure's operation and message. */
export const describeExit = (exit: Exit.Exit<unknown, unknown>): Outcome => {
  if (Exit.isSuccess(exit)) return { outcome: "ok" }
  if (!Exit.hasFails(exit)) return { outcome: "defect" }
  const error = Cause.squash(exit.cause) as Record<string, any>
  return {
    outcome: error._tag,
    ...(error.operation !== undefined ? { operation: error.operation } : {}),
    message: String(error.cause?.message ?? error.message ?? error.cause).slice(0, 300),
  }
}

/** `applyBatch`'s answer: the outcome per event, each failure as {@link describeExit} has it. */
const describeOutcomes = (exit: Exit.Exit<unknown, unknown>): Outcome =>
  Exit.isSuccess(exit)
    ? {
        outcome: "ok",
        outcomes: (exit.value as any).outcomes.map((o: any) =>
          o._tag === "Failed"
            ? {
                _tag: o._tag,
                error: o.error._tag,
                operation: o.error.operation,
                message: String(o.error.cause?.message ?? o.error.message ?? "").slice(0, 300),
              }
            : { _tag: o._tag },
        ),
      }
    : describeExit(exit)

const exitOf = <A>(read: Effect.Effect<A, unknown, any>) =>
  Effect.exit(read).pipe(Effect.map((exit) => describeExit(exit)))

// ---------------------------------------------------------------------------
// An aggregate: a root field, and a field of a `many` element
// ---------------------------------------------------------------------------

const aggregateCases = (): ReadonlyArray<Case> => {
  const Base = Table.make({ schema, entities: {} } as never) as any
  const Line = Schema.Struct({ lid: Schema.String, g: upper })
  const Root = (Aggregate.make as any)(
    Schema.Struct({
      id: Schema.String,
      customer: Schema.String,
      f: upper,
      note: Schema.optional(Schema.String),
      lines: Schema.Array(Line),
    }),
    {
      table: Base,
      schema,
      pk: { field: "pk", composite: ["id"] },
      collection: { name: "mkroot" },
      list: {
        index: "gsi1",
        name: "mklist",
        pk: { field: "gsi1pk", composite: ["customer"] },
        sk: { field: "gsi1sk", composite: ["id"] },
      },
      root: { entityType: "MkRoot" },
      edges: {
        lines: (Aggregate.many as any)({ entityType: "MkLine", sk: { composite: ["lid"] } }),
      },
    },
  )
  const reads: Record<string, (agg: any) => Effect.Effect<unknown, unknown>> = {
    get: (agg) => agg.get({ id: "a" }),
    list: (agg) => agg.list({ customer: "c" }),
    updateNoop: (agg) => agg.update({ id: "a" }, ({ state }: any) => state),
    updateNote: (agg) => agg.update({ id: "a" }, ({ state }: any) => ({ ...state, note: "n" })),
  }
  const positions = {
    root: ["MkRoot", "f"],
    line: ["MkLine", "g"],
  } as const
  return Object.entries(positions).flatMap(([position, [entityType, field]]) =>
    Object.entries(reads).map(
      ([op, read]): Case => ({
        name: `an aggregate's ${position} field, ${op}`,
        rows: (fixture.aggregate.rows as ReadonlyArray<Item>).map((row) =>
          row.__edd_e__?.S === entityType ? without(row, [field]) : row,
        ),
        gsi1: true,
        layer: (name) => Base.layer({ name }),
        read: Effect.gen(function* () {
          const db: any = yield* DynamoClient.make({
            entities: {},
            aggregates: { Root },
            tables: { Main: { ...Base, aggregates: { Root } } },
          } as never)
          return yield* exitOf(read(db.aggregates.Root))
        }),
        expected: fixture.aggregate[position][op],
      }),
    ),
  )
}

// ---------------------------------------------------------------------------
// A stream: an event's data, its metadata, a snapshot's state
// ---------------------------------------------------------------------------

const streamCases = (): ReadonlyArray<Case> => {
  const Base = Table.make({ schema, entities: {} } as never) as any
  const Notes = (EventStore.makeStream as any)({
    table: Base,
    streamName: "Notes",
    events: [Schema.Struct({ _tag: Schema.tag("Noted"), f: upper })],
    metadata: Schema.Struct({ m: upper }),
    streamId: { composite: ["id"] },
    snapshot: { schema: Schema.Struct({ s: upper, count: Schema.Number }), every: 100 },
  })
  const rows = fixture.stream.rows as ReadonlyArray<Item>
  // The event after the snapshot, so `readLatest` reads it.
  const event = rows.find((row) => row.version?.N === "2" && row.data !== undefined)!
  const snapshot = rows.find((row) => row.state !== undefined)!
  const positions = {
    eventData: [event, ["data", "f"]],
    metadata: [event, ["metadata", "m"]],
    snapshotState: [snapshot, ["state", "s"]],
  } as const
  const reads: Record<string, (stream: any) => Effect.Effect<unknown, unknown>> = {
    read: (stream) => stream.read({ id: "a" }),
    readFrom: (stream) => stream.readFrom({ id: "a" }, 0),
    readLatest: (stream) => stream.readLatest({ id: "a" }),
    readSnapshot: (stream) => stream.readSnapshot({ id: "a" }),
  }
  return Object.entries(positions).flatMap(([position, [row, path]]) => {
    const stripped = without(row, path)
    const stored = rows.map((r) => (r === row ? stripped : r))
    const cases = Object.entries(reads).map(
      ([op, read]): Case => ({
        name: `a stream's ${position}, ${op}`,
        rows: stored,
        gsi1: false,
        layer: (name) => Base.layer({ name }),
        read: Effect.gen(function* () {
          return yield* exitOf(read(yield* EventStore.bind(Notes)))
        }),
        expected: fixture.stream[position][op],
      }),
    )
    if (position === "snapshotState") return cases
    return [
      ...cases,
      {
        name: `a stream's ${position}, decodeStreamImage`,
        rows: [],
        gsi1: false,
        layer: (name) => Base.layer({ name }),
        read: Effect.gen(function* () {
          const stream: any = yield* EventStore.bind(Notes)
          return yield* exitOf(stream.decodeStreamImage(stripped))
        }),
        expected: fixture.stream[position].decodeStreamImage,
      },
    ]
  })
}

// ---------------------------------------------------------------------------
// A projection: its read-model row, and an outbox effect
// ---------------------------------------------------------------------------

const projectionKey = {
  pk: { field: "pk", composite: ["id"] },
  sk: { field: "sk", composite: [] },
}
const counted = [Schema.Struct({ _tag: Schema.tag("Counted") })]

const projectionCases = (): ReadonlyArray<Case> => {
  const Summaries = Entity.make({
    model: Schema.Struct({
      id: Schema.String,
      f: upper,
      count: Schema.Number,
      version: Schema.Number,
    }),
    entityType: "Summary",
    primaryKey: projectionKey,
  } as never) as any
  const Main = Table.make({ schema, entities: { Summaries } } as never) as any
  const Counts = (EventStore.makeStream as any)({
    table: Main,
    streamName: "Counts",
    events: counted,
    streamId: { composite: ["id"] },
  })
  const Proj = (EventStore.projection as any)({
    stream: Counts,
    readModel: Summaries,
    key: (streamId: any) => ({ id: streamId.id }),
    initial: (streamId: any) => ({ id: streamId.id, f: "init", count: 0, version: 0 }),
    evolve: (state: any) => Effect.succeed({ ...state, count: state.count + 1 }),
    checkpoint: "version",
  })
  const rows = (fixture.projection.rows as ReadonlyArray<Item>).map((row) =>
    row.__edd_e__?.S === "Summary" ? without(row, ["f"]) : row,
  )
  const reads: Record<
    string,
    (proj: any, events: ReadonlyArray<unknown>) => Effect.Effect<Outcome, never, any>
  > = {
    apply: (proj, events) => exitOf(proj.apply(events[1])),
    catchUp: (proj) => exitOf(proj.catchUp({ id: "a" })),
    applyBatch: (proj, events) =>
      Effect.exit(proj.applyBatch([events[1]]) as Effect.Effect<unknown, unknown>).pipe(
        Effect.map((exit) => describeOutcomes(exit)),
      ),
  }
  return Object.entries(reads).map(
    ([op, read]): Case => ({
      name: `a projection's row, ${op}`,
      rows,
      gsi1: false,
      layer: (name) => Main.layer({ name }),
      read: Effect.gen(function* () {
        const stream: any = yield* EventStore.bind(Counts)
        const proj = yield* EventStore.bindProjection(Proj)
        return yield* read(proj, yield* stream.read({ id: "a" }))
      }),
      expected: fixture.projection[op],
    }),
  )
}

const outboxCase = (): Case => {
  const Summaries = Entity.make({
    model: Schema.Struct({
      id: Schema.String,
      count: Schema.Number,
      version: Schema.Number,
      rev: Schema.Number,
    }),
    entityType: "Summary",
    primaryKey: projectionKey,
  } as never) as any
  const Main = Table.make({ schema, entities: { Summaries } } as never) as any
  const Counts = (EventStore.makeStream as any)({
    table: Main,
    streamName: "Counts",
    events: counted,
    streamId: { composite: ["id"] },
  })
  const Proj = (EventStore.projection as any)({
    stream: Counts,
    readModel: Summaries,
    key: (streamId: any) => ({ id: streamId.id }),
    initial: (streamId: any) => ({ id: streamId.id, count: 0, version: 0, rev: 0 }),
    evolve: (state: any) => Effect.succeed({ ...state, count: state.count + 1 }),
    checkpoint: "version",
    revision: "rev",
    outbox: { schema: Schema.Struct({ o: upper }), effects: () => [{ o: "x" }] },
  })
  return {
    name: "a projection's outbox effect, drain",
    rows: (fixture.outbox.rows as ReadonlyArray<Item>).map((row) =>
      row.__edd_e__?.S === "Summary#outbox" ? without(row, ["effect", "o"]) : row,
    ),
    gsi1: false,
    layer: (name) => Main.layer({ name }),
    read: Effect.gen(function* () {
      const proj: any = yield* EventStore.bindProjection(Proj)
      return yield* exitOf(proj.drain({ id: "a" }, () => Effect.void))
    }),
    expected: fixture.outbox.drain,
  }
}

/** Every case 1.39.0's capture has. */
export const cases = (): ReadonlyArray<Case> => [
  ...aggregateCases(),
  ...streamCases(),
  ...projectionCases(),
  outboxCase(),
]

/**
 * A read that dies on a value the row holds, not on an absent one: a stream event whose field's
 * step throws on any value. 1.39.0's read of it died too, so it stays a defect.
 */
export const throwingOnAnyValue = (): Case => {
  const Base = Table.make({ schema, entities: {} } as never) as any
  const throwing = Schema.Unknown.pipe(
    Schema.decodeTo(Schema.String, {
      decode: SchemaGetter.transform((): string => {
        throw new Error("a step that throws")
      }),
      encode: SchemaGetter.transform((s: string) => s),
    } as never),
  )
  const Notes = (EventStore.makeStream as any)({
    table: Base,
    streamName: "Notes",
    events: [Schema.Struct({ _tag: Schema.tag("Noted"), f: throwing })],
    streamId: { composite: ["id"] },
  })
  const event = (fixture.stream.rows as ReadonlyArray<Item>).find(
    (row) => row.version?.N === "2" && row.data !== undefined,
  )!
  return {
    name: "a stream event holding a value its step throws on, decodeStreamImage",
    rows: [],
    gsi1: false,
    layer: (name) => Base.layer({ name }),
    read: Effect.gen(function* () {
      const stream: any = yield* EventStore.bind(Notes)
      return yield* exitOf(stream.decodeStreamImage(without(event, ["metadata"])))
    }),
    expected: { outcome: "defect" },
  }
}
