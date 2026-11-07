/**
 * Every write path that can carry a field holding a custom declaration, each as a program over the
 * declaration and a value of it. `connected.custom-declarations.test.ts` runs them against DynamoDB
 * Local and `CustomDeclarationWrites.test.ts` against a client that records writes, and the second
 * also holds this list against the library's operations, so a new write path has to be added here.
 */

import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { DateTime, Effect, Schema } from "effect"
import * as Aggregate from "../../src/Aggregate.js"
import * as Batch from "../../src/Batch.js"
import { DynamoClient } from "../../src/DynamoClient.js"
import * as Entity from "../../src/Entity.js"
import * as EventStore from "../../src/EventStore.js"
import * as Table from "../../src/Table.js"
import * as Transaction from "../../src/Transaction.js"

export const AppSchema = DynamoSchema.make({ name: "custom", version: 1 })

const keyed = {
  primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
}

/** The members a path writes through, built over one field. */
export const membersOf = (F: Schema.Top) => {
  const f = F as never
  const Rows = Entity.make({
    model: Schema.Struct({
      id: Schema.String,
      f: Schema.optional(f),
      list: Schema.optional(Schema.Array(f)),
      nested: Schema.optional(Schema.Struct({ p: f })),
      n: Schema.optional(Schema.Number),
    }),
    entityType: "Row",
    ...keyed,
  } as never) as any
  const Defaulted = Entity.make({
    model: Schema.Struct({
      id: Schema.String,
      g: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed("x"))),
      f: Schema.optional(f),
    }),
    entityType: "Defaulted",
    ...keyed,
    indexes: {
      byG: {
        name: "gsi1",
        pk: { field: "gsi1pk", composite: ["g"] },
        sk: { field: "gsi1sk", composite: [] },
      },
    },
  } as never) as any
  const Retained = Entity.make({
    model: Schema.Struct({ id: Schema.String, f: Schema.optional(f) }),
    entityType: "Retained",
    ...keyed,
    versioned: { retain: true },
  } as never) as any
  const Unique = Entity.make({
    model: Schema.Struct({ id: Schema.String, code: Schema.String, f: Schema.optional(f) }),
    entityType: "Unique",
    ...keyed,
    unique: { byCode: ["code"] },
  } as never) as any
  const Series = Entity.make({
    model: Schema.Struct({ id: Schema.String, at: Schema.Number, f: Schema.optional(f) }),
    entityType: "Series",
    ...keyed,
    timeSeries: {
      orderBy: "at",
      appendInput: Schema.Struct({ id: Schema.String, at: Schema.Number, f: Schema.optional(f) }),
    },
  } as never) as any
  const Summaries = Entity.make({
    model: Schema.Struct({
      id: Schema.String,
      version: Schema.Number,
      rev: Schema.Number,
      f: Schema.optional(f),
    }),
    entityType: "Summary",
    ...keyed,
  } as never) as any
  const Plain = Entity.make({
    model: Schema.Struct({ id: Schema.String, version: Schema.Number, rev: Schema.Number }),
    entityType: "Plain",
    ...keyed,
  } as never) as any
  const Base = Table.make({
    schema: AppSchema,
    entities: { Rows, Defaulted, Retained, Unique, Series, Summaries, Plain },
  } as never) as any

  const Line = Schema.Struct({ sku: Schema.String, p: f })
  const Coach = Schema.Struct({ name: Schema.String, p: f })
  const Crew = Schema.Struct({ lead: Schema.String, p: f })
  const Order = (Aggregate.make as any)(
    Schema.Struct({
      id: Schema.String,
      f: Schema.optional(f),
      coach: Schema.optional(Coach),
      lines: Schema.Array(Line),
      crew: Schema.optional(Crew),
    }),
    {
      table: Base,
      schema: Base.schema,
      pk: { field: "pk", composite: ["id"] },
      collection: { name: "order" },
      root: { entityType: "Order" },
      edges: {
        coach: Aggregate.one({ entityType: "Coach" } as never),
        lines: Aggregate.many({ entityType: "Line", sk: { composite: ["sku"] } } as never),
        crew: Aggregate.one({ entityType: "Crew" } as never),
      },
    },
  )

  const Event = Schema.Struct({ _tag: Schema.tag("Noted"), f: Schema.optional(f) })
  const Tally = EventStore.makeStream({
    table: Base,
    streamName: "Tally",
    events: [Event],
    streamId: { composite: ["id"] },
    metadata: Schema.Struct({ m: Schema.optional(f) }),
  } as never) as any
  const Snapshotted = EventStore.makeStream({
    table: Base,
    streamName: "Snapshotted",
    events: [Schema.Struct({ _tag: Schema.tag("Noted") })],
    streamId: { composite: ["id"] },
    snapshot: { schema: Schema.Struct({ f: Schema.optional(f) }), mode: "inline" },
  } as never) as any
  const Inner = EventStore.makeStream({
    table: Base,
    streamName: "Inner",
    events: [Event],
    streamId: { composite: ["id"] },
  } as never) as any
  const Source = EventStore.makeStream({
    table: Base,
    streamName: "Source",
    events: [Schema.Struct({ _tag: Schema.tag("Noted") })],
    streamId: { composite: ["id"] },
  } as never) as any
  const projecting = (
    readModel: any,
    state: (value: unknown) => Record<string, unknown>,
    outbox?: { readonly schema: Schema.Top; readonly effects: () => ReadonlyArray<unknown> },
    value?: unknown,
  ) =>
    EventStore.projection({
      stream: Source,
      readModel,
      key: (input: any) => ({ id: input.id }),
      initial: (input: any) => ({ id: input.id, version: 0, rev: 0 }),
      evolve: (current: any) => Effect.succeed({ ...current, ...state(value) }),
      checkpoint: "version",
      revision: "rev",
      ...(outbox !== undefined ? { outbox } : {}),
    } as never) as any
  return {
    F,
    Rows,
    Defaulted,
    Retained,
    Unique,
    Series,
    Summaries,
    Plain,
    Base,
    Order,
    Tally,
    Snapshotted,
    Inner,
    Source,
    projecting,
  }
}

export type Members = ReturnType<typeof membersOf>

export const clientOf = (members: Members) =>
  DynamoClient.make({
    entities: {
      Rows: members.Rows,
      Defaulted: members.Defaulted,
      Retained: members.Retained,
      Unique: members.Unique,
      Series: members.Series,
      Summaries: members.Summaries,
      Plain: members.Plain,
    },
    aggregates: { Order: members.Order },
    tables: { MainTable: members.Base },
  } as never) as Effect.Effect<any, never, any>

export type Path = {
  /** The name it's reported under in `ConsumedCapacity.coverage.test.ts`, which every op must have. */
  readonly operation: string
  readonly name: string
  /** The rows that have to be there, written by a member that takes them. */
  readonly seeded?: boolean
  readonly run: (db: any, members: Members, value: unknown) => Effect.Effect<unknown, unknown, any>
}

const id = { id: "a" }
const asEffect = (op: any): Effect.Effect<unknown, unknown, any> =>
  typeof op?.asEffect === "function" ? op.asEffect() : op
const noted = (f: unknown) => ({ _tag: "Noted" as const, f })
const set = (value: unknown) => ({ f: value })
const at = (segments: ReadonlyArray<string | number>, value: unknown) => ({
  segments,
  value,
  isPath: false,
})
const line = (value: unknown) => ({ sku: "s", p: value })
const orderOf = (value: unknown) => ({ id: "a", lines: [line(value)] })

/** One command that appends what it's told and folds it into the state a snapshot stores. */
const tallying = (value: unknown) => ({
  initialState: {},
  decide: () => Effect.succeed([{ _tag: "Noted" as const }]),
  evolve: () => ({ f: value }),
})

export const PATHS: ReadonlyArray<Path> = [
  // An entity's own writes
  {
    operation: "Entity.put",
    name: "put",
    run: (db, _, value) => asEffect(db.entities.Rows.put({ ...id, ...set(value) })),
  },
  {
    operation: "Entity.put",
    name: "put, in a list",
    run: (db, _, value) => asEffect(db.entities.Rows.put({ ...id, list: [value] })),
  },
  {
    operation: "Entity.put",
    name: "put, in a struct",
    run: (db, _, value) => asEffect(db.entities.Rows.put({ ...id, nested: { p: value } })),
  },
  {
    operation: "Entity.put",
    name: "put, with retained versions",
    run: (db, _, value) => asEffect(db.entities.Retained.put({ ...id, ...set(value) })),
  },
  {
    operation: "Entity.put",
    name: "put, with a unique constraint",
    run: (db, _, value) => asEffect(db.entities.Unique.put({ ...id, code: "c", ...set(value) })),
  },
  {
    operation: "Entity.put",
    name: "put, unbound",
    run: (_, members, value) => asEffect(members.Rows.put({ ...id, ...set(value) })),
  },
  {
    operation: "Entity.create",
    name: "create",
    run: (db, _, value) => asEffect(db.entities.Rows.create({ ...id, ...set(value) })),
  },
  {
    operation: "Entity.upsert",
    name: "upsert",
    run: (db, _, value) => asEffect(db.entities.Rows.upsert({ ...id, ...set(value) })),
  },
  {
    operation: "Entity.upsert",
    name: "upsert, omitting a defaulted index composite",
    run: (db, _, value) => asEffect(db.entities.Defaulted.upsert({ ...id, ...set(value) })),
  },
  {
    operation: "Entity.update",
    seeded: true,
    name: "update .set",
    run: (db, _, value) => asEffect(db.entities.Rows.update(id).set(set(value))),
  },
  {
    operation: "Entity.update",
    seeded: true,
    name: "update .set, with retained versions, which reads first",
    run: (db, _, value) => asEffect(db.entities.Retained.update(id).set(set(value))),
  },
  {
    operation: "Entity.update",
    seeded: true,
    name: "update .append",
    run: (db, _, value) => asEffect(db.entities.Rows.update(id).append({ list: [value] })),
  },
  {
    operation: "Entity.update",
    seeded: true,
    name: "update pathSet",
    run: (db, _, value) => asEffect(db.entities.Rows.update(id).pathSet(at(["f"], value))),
  },
  {
    operation: "Entity.update",
    seeded: true,
    name: "update pathSet, below a field",
    run: (db, _, value) =>
      asEffect(db.entities.Rows.update(id).pathSet(at(["nested", "p"], value))),
  },
  {
    operation: "Entity.update",
    seeded: true,
    name: "update pathSet, of the struct holding one",
    run: (db, _, value) =>
      asEffect(db.entities.Rows.update(id).pathSet(at(["nested"], { p: value }))),
  },
  {
    operation: "Entity.update",
    seeded: true,
    name: "update pathSet, of a list position",
    run: (db, _, value) => asEffect(db.entities.Rows.update(id).pathSet(at(["list", 0], value))),
  },
  {
    operation: "Entity.update",
    seeded: true,
    name: "update pathAppend",
    run: (db, _, value) =>
      asEffect(db.entities.Rows.update(id).pathAppend({ segments: ["list"], value: [value] })),
  },
  {
    operation: "Entity.update",
    seeded: true,
    name: "update pathPrepend",
    run: (db, _, value) =>
      asEffect(db.entities.Rows.update(id).pathPrepend({ segments: ["list"], value: [value] })),
  },
  {
    operation: "Entity.update",
    seeded: true,
    name: "update pathIfNotExists",
    run: (db, _, value) =>
      asEffect(db.entities.Rows.update(id).pathIfNotExists({ segments: ["f"], value })),
  },
  {
    operation: "Entity.patch",
    name: "patch .set",
    seeded: true,
    run: (db, _, value) => asEffect(db.entities.Rows.patch(id).set(set(value))),
  },
  {
    operation: "Entity.patch",
    name: "patch pathSet",
    seeded: true,
    run: (db, _, value) => asEffect(db.entities.Rows.patch(id).pathSet(at(["f"], value))),
  },
  {
    operation: "Entity.append",
    name: "a time series' append",
    run: (db, _, value) => asEffect(db.entities.Series.append({ ...id, at: 1, ...set(value) })),
  },
  // Many items
  {
    operation: "Transaction.transactWrite",
    name: "a transaction's put",
    run: (db, _, value) =>
      Transaction.transactWrite([db.entities.Rows.put({ ...id, ...set(value) })]),
  },
  {
    operation: "Transaction.transactWrite",
    name: "a transaction's create, unbound",
    run: (_, members, value) =>
      Transaction.transactWrite([members.Rows.create({ ...id, ...set(value) })]),
  },
  {
    operation: "Transaction.transactWrite",
    name: "a transaction's put, with a unique constraint",
    run: (db, _, value) =>
      Transaction.transactWrite([db.entities.Unique.put({ ...id, code: "c", ...set(value) })]),
  },
  {
    operation: "Transaction.transactWrite",
    name: "a transaction's update",
    seeded: true,
    run: (db, _, value) => Transaction.transactWrite([db.entities.Rows.update(id).set(set(value))]),
  },
  {
    operation: "Transaction.transactWrite",
    name: "a transaction's patch pathSet",
    seeded: true,
    run: (db, _, value) =>
      Transaction.transactWrite([db.entities.Rows.patch(id).pathSet(at(["f"], value))]),
  },
  {
    operation: "Batch.write",
    name: "a batch's put",
    run: (db, _, value) => Batch.write([db.entities.Rows.put({ ...id, ...set(value) })]),
  },
  {
    operation: "Batch.write",
    name: "a batch's put, unbound",
    run: (_, members, value) => Batch.write([members.Rows.put({ ...id, ...set(value) })]),
  },
  // Aggregates
  {
    operation: "Aggregate.create",
    name: "an aggregate's create, on the root",
    run: (db, _, value) => db.aggregates.Order.create({ id: "a", f: value, lines: [] }),
  },
  {
    operation: "Aggregate.create",
    name: "an aggregate's create, on a one edge",
    run: (db, _, value) =>
      db.aggregates.Order.create({ id: "a", coach: { name: "c", p: value }, lines: [] }),
  },
  {
    operation: "Aggregate.create",
    name: "an aggregate's create, on a many edge",
    run: (db, _, value) => db.aggregates.Order.create(orderOf(value)),
  },
  {
    operation: "Aggregate.update",
    name: "an aggregate's update, on the root",
    seeded: true,
    run: (db, _, value) =>
      db.aggregates.Order.update(id, ({ current }: any) => ({ ...current, f: value })),
  },
  {
    operation: "Aggregate.update",
    name: "an aggregate's update, on a one edge",
    seeded: true,
    run: (db, _, value) =>
      db.aggregates.Order.update(id, ({ current }: any) => ({
        ...current,
        crew: { lead: "l", p: value },
      })),
  },
  {
    operation: "Aggregate.update",
    name: "an aggregate's update, on a many edge",
    seeded: true,
    run: (db, _, value) =>
      db.aggregates.Order.update(id, ({ current }: any) => ({
        ...current,
        lines: [...current.lines, { sku: "t", p: value }],
      })),
  },
  // Streams
  {
    operation: "EventStream.append",
    name: "an event",
    run: (_, members, value) => members.Tally.append(id, [noted(value)], 0),
  },
  {
    operation: "EventStream.append",
    name: "an append's metadata",
    run: (_, members, value) =>
      members.Tally.append(id, [{ _tag: "Noted" }], 0, { metadata: { m: value } }),
  },
  {
    operation: "EventStream.append",
    name: "an event's own metadata",
    run: (_, members, value) =>
      members.Tally.append(id, [{ _tag: "Noted" }], 0, { eventMetadata: [{ m: value }] }),
  },
  {
    operation: "EventStream.append",
    name: "an additional item's put",
    run: (db, members, value) =>
      members.Tally.append(id, [{ _tag: "Noted" }], 0, {
        additionalItems: [db.entities.Rows.put({ id: "b", ...set(value) })],
      }),
  },
  {
    operation: "EventStream.append",
    name: "a nested append's event",
    run: (_, members, value) =>
      members.Tally.append(id, [{ _tag: "Noted" }], 0, {
        additionalItems: [members.Inner.appendOp(id, [noted(value)], 0)],
      }),
  },
  {
    operation: "EventStream.writeSnapshot",
    name: "writeSnapshot",
    run: (_, members, value) => members.Snapshotted.writeSnapshot(id, { f: value }, 1),
  },
  {
    operation: "EventStore.commandHandler",
    name: "a command's event",
    run: (_, members, value) =>
      (
        EventStore.commandHandler(
          {
            initialState: {},
            decide: () => Effect.succeed([noted(value)]),
            evolve: (state: unknown) => state,
          } as never,
          members.Tally,
        ) as any
      )(id, {}),
  },
  {
    operation: "EventStore.commandHandler",
    name: "a command's metadata",
    run: (_, members, value) =>
      (
        EventStore.commandHandler(
          {
            initialState: {},
            decide: () => Effect.succeed([{ _tag: "Noted" }]),
            evolve: (state: unknown) => state,
          } as never,
          members.Tally,
        ) as any
      )(id, {}, { metadata: { m: value } }),
  },
  {
    operation: "EventStore.commandHandler",
    name: "a command's additional item",
    run: (db, members, value) =>
      (
        EventStore.commandHandler(
          {
            initialState: {},
            decide: () => Effect.succeed([{ _tag: "Noted" }]),
            evolve: (state: unknown) => state,
          } as never,
          members.Tally,
        ) as any
      )(id, {}, { additionalItems: [db.entities.Rows.put({ id: "b", ...set(value) })] }),
  },
  {
    operation: "EventStore.commandHandler",
    name: "a command's inline snapshot",
    run: (_, members, value) =>
      (EventStore.commandHandler(tallying(value) as never, members.Snapshotted) as any)(id, {}),
  },
  {
    operation: "Projection.apply",
    name: "a projection's outbox",
    run: (_, members, value) =>
      members
        .projecting(members.Plain, () => ({}), {
          schema: Schema.Struct({ m: members.F as never }),
          effects: () => [{ m: value }],
        })
        .apply(sourceEvent),
  },
  {
    operation: "Projection.apply",
    name: "a projection's row",
    run: (_, members, value) =>
      members.projecting(members.Summaries, set, undefined, value).apply(sourceEvent),
  },
  {
    operation: "Projection.apply",
    name: "a projection's row, beside its outbox",
    run: (_, members, value) =>
      members
        .projecting(
          members.Summaries,
          set,
          { schema: Schema.Struct({ m: Schema.String }), effects: () => [{ m: "m" }] },
          value,
        )
        .apply(sourceEvent),
  },
]

const sourceEvent = {
  streamId: "a",
  streamName: "Source",
  version: 1,
  eventType: "Noted",
  data: { _tag: "Noted" },
  metadata: undefined,
  timestamp: DateTime.makeUnsafe("2025-01-01T00:00:00.000Z"),
}
