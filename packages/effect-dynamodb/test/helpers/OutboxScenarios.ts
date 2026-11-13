/**
 * Outbox scenarios for `OutboxRolling.test.ts` (#237), run against this repo's source and against
 * the published 1.40.0: the scenario takes the library as an argument, so the same code ran
 * against the published package (this file compiled beside it, against DynamoDB Local) to make
 * the fixtures as runs against this repo's source to compare with them.
 *
 * - {@link names}: a read model whose outbox items can't carry their mark (`__edd_rm__`), its name
 *   being a key attribute where they are written. `fixtures/outbox-mark-names-1.40.0.json` holds
 *   what 1.40.0 sent, stored and delivered for each.
 * - {@link rolling}: outbox items this release writes (marks, and items written beside another's
 *   at its key followed by their mark), drained by 1.40.0. `fixtures/outbox-rolling-1.40.0.json`
 *   holds the items, written by this repo, and what 1.40.0's `drainPending` and `drain` did with
 *   them.
 *
 * Never regenerate the fixtures' 1.40.0 parts from this repo.
 */

import { Effect, Layer, Schema } from "effect"

/** The library's modules the scenarios use, as 1.40.0 and this repo both export them. */
export interface Library {
  readonly DynamoSchema: any
  readonly Table: any
  readonly Entity: any
  readonly EventStore: any
  readonly DynamoClient: any
}

/** A request a scenario sent: the client's operation and its input, tables named as below. */
export interface Sent {
  readonly operation: string
  readonly input: unknown
}

/** The physical names of a scenario's tables. */
export interface Tables {
  readonly events: string
  readonly read: string
  readonly outbox: string
}

/**
 * Where `__edd_rm__` is a key attribute: the outbox table's partition or sort key, its index's,
 * a member's index on the outbox table, the read model's partition key or index (its outbox on
 * its own table), or an event stream's index (its outbox on the stream's table). `"none"`: nowhere.
 */
export type Position =
  | "none"
  | "outboxPk"
  | "outboxSk"
  | "indexPk"
  | "indexSk"
  | "member"
  | "localPk"
  | "localIndex"
  | "stream"

export const POSITIONS: ReadonlyArray<Exclude<Position, "none">> = [
  "outboxPk",
  "outboxSk",
  "indexPk",
  "indexSk",
  "member",
  "localPk",
  "localIndex",
  "stream",
]

/** A table's key attributes and secondary indexes. */
export interface TableLayout {
  readonly pk: string
  readonly sk: string
  readonly indexes: Readonly<
    Record<string, { readonly pk: string; readonly sk: string; readonly local?: boolean }>
  >
}

/** Where the outbox items are: on the read model's table, the stream's, or one of their own. */
const outboxOn = (position: Position): keyof Tables =>
  position === "localPk" || position === "localIndex"
    ? "read"
    : position === "stream"
      ? "events"
      : "outbox"

/** Each table's keys and indexes in `position`. */
export const layoutOf = (position: Position): Readonly<Record<keyof Tables, TableLayout>> => {
  const index = {
    pk: position === "indexPk" ? "__edd_rm__" : "obpk",
    sk: position === "indexSk" ? "__edd_rm__" : "obsk",
  }
  const on = outboxOn(position)
  return {
    events: {
      pk: "pk",
      sk: "sk",
      indexes: {
        ...(position === "stream" && { byRm: { pk: "pk", sk: "__edd_rm__", local: true } }),
        ...(on === "events" && { outbox: index }),
      },
    },
    read: {
      pk: position === "localPk" ? "__edd_rm__" : "pk",
      sk: "sk",
      indexes: {
        ...(position === "localIndex" && { byRm: { pk: "gpk", sk: "__edd_rm__" } }),
        ...(on === "read" && { outbox: index }),
      },
    },
    outbox: {
      pk: position === "outboxPk" ? "__edd_rm__" : "opk",
      sk: position === "outboxSk" ? "__edd_rm__" : "osk",
      indexes: {
        outbox: index,
        ...(position === "member" && { byRm: { pk: "__edd_rm__", sk: "msk" } }),
      },
    },
  }
}

/** A request's input, as JSON, its tables' names replaced by theirs here and claims' values. */
const normalize = (input: unknown, tables: Tables) => {
  let text = JSON.stringify(input)
  for (const [name, physical] of Object.entries(tables)) {
    text = text.replaceAll(JSON.stringify(physical), JSON.stringify(name))
  }
  return JSON.parse(text, (key, value) =>
    key === ":c" || key === ":u" || key === ":now" ? { volatile: true } : value,
  )
}

/**
 * The definitions every scenario shares, in `position`, with `projections` projections: their
 * effects are `total`, and `1000 + count` for the second.
 */
export const definitions = (
  lib: Library,
  position: Position,
  options: {
    readonly escapeKeys?: boolean
    readonly projections?: 1 | 2
    readonly streams?: ReadonlyArray<string>
  },
) => {
  const layout = layoutOf(position)
  const AppSchema = lib.DynamoSchema.make({
    name: "roll",
    version: 1,
    ...(options.escapeKeys === true ? { escapeKeys: true } : {}),
  })
  class Added extends Schema.TaggedClass<Added>()("Added", { amount: Schema.Number }) {}
  const EventsTable = lib.Table.make({ schema: AppSchema, entities: {} })
  const Accounts = lib.EventStore.makeStream({
    table: EventsTable,
    streamName: "Account",
    events: [Added],
    streamId: { composite: ["account"] },
    ...(position === "stream" && {
      indexes: { byRm: { index: "byRm", sk: "__edd_rm__", key: () => "k" } },
    }),
  })
  const Ledgers = lib.Entity.make({
    model: Schema.Struct({
      shop: Schema.String,
      total: Schema.Number,
      count: Schema.optional(Schema.Number),
      cp: Schema.optional(Schema.Number),
      rev: Schema.optional(Schema.Number),
      cp2: Schema.optional(Schema.Number),
      rev2: Schema.optional(Schema.Number),
    }),
    entityType: "Ledger",
    primaryKey: {
      pk: { field: layout.read.pk, composite: ["shop"] },
      sk: { field: "sk", composite: [] },
    },
    ...(position === "localIndex" && {
      indexes: {
        byRm: {
          name: "byRm",
          pk: { field: "gpk", composite: ["shop"] },
          sk: { field: "__edd_rm__", composite: [] },
        },
      },
    }),
  })
  const ReadTable = lib.Table.make({ schema: AppSchema, entities: { Ledgers } })
  const Others =
    position === "member"
      ? lib.Entity.make({
          model: Schema.Struct({ x: Schema.String }),
          entityType: "Other",
          primaryKey: {
            pk: { field: layout.outbox.pk, composite: ["x"] },
            sk: { field: layout.outbox.sk, composite: [] },
          },
          indexes: {
            byRm: {
              name: "byRm",
              pk: { field: "__edd_rm__", composite: ["x"] },
              sk: { field: "msk", composite: [] },
            },
          },
        })
      : undefined
  const OutboxTable = lib.Table.make({
    schema: AppSchema,
    entities: Others === undefined ? {} : { Others },
  })
  const on = outboxOn(position)
  const outbox = {
    schema: Schema.Struct({ total: Schema.Number }),
    index: { name: "outbox", ...layout[on].indexes.outbox! },
    ...(on === "outbox" && {
      table: OutboxTable,
      keys: { pk: layout.outbox.pk, sk: layout.outbox.sk },
    }),
    ...(on === "events" && { table: EventsTable, keys: { pk: "pk", sk: "sk" } }),
  }
  type Row = { readonly total: number; readonly count?: number }
  const projections = Array.from({ length: options.projections ?? 1 }, (_, i) =>
    lib.EventStore.projection({
      stream: Accounts,
      readModel: Ledgers,
      key: () => ({ shop: "north" }),
      initial: () => ({ shop: "north", total: 0 }),
      evolve: (state: Row, event: { readonly data: Added }) =>
        Effect.succeed(
          i === 0
            ? { ...state, total: state.total + event.data.amount }
            : { ...state, count: (state.count ?? 0) + event.data.amount },
        ),
      checkpoint: i === 0 ? "cp" : "cp2",
      revision: i === 0 ? "rev" : "rev2",
      outbox: {
        ...outbox,
        effects: (_event: unknown, next: Row | undefined) => [
          { total: i === 0 ? (next?.total ?? -1) : 1000 + (next?.count ?? -1) },
        ],
      },
    }),
  )
  const layer = (tables: Tables) =>
    Layer.mergeAll(
      EventsTable.layer({ name: tables.events }),
      ReadTable.layer({ name: tables.read }),
      OutboxTable.layer({ name: tables.outbox }),
    )
  /** A client binding the read model (and the outbox table's member) and every table. */
  const bind = lib.DynamoClient.make({
    entities: { Ledgers, ...(Others === undefined ? {} : { Others }) },
    tables: { EventsTable, ReadTable, OutboxTable },
  })
  /** Each stream's two events, appended. */
  const append = Effect.gen(function* () {
    const appended: Array<ReadonlyArray<unknown>> = []
    for (const account of options.streams ?? ["acct"]) {
      yield* Accounts.append({ account }, [new Added({ amount: 2 }), new Added({ amount: 3 })], 0)
      appended.push((yield* Accounts.read({ account })) as ReadonlyArray<unknown>)
    }
    return appended
  })
  return { Ledgers, ReadTable, OutboxTable, EventsTable, projections, layer, bind, append }
}

/** What a scenario's run sent, what its drain delivered, and the drain's result. */
export interface Ran {
  readonly sent: ReadonlyArray<Sent>
  readonly delivered: ReadonlyArray<unknown>
  readonly result: unknown
}

/** `client` (a layer of `DynamoClient`), each request whose input names a read-model row pushed. */
const recording = (
  lib: Library,
  client: Layer.Layer<any, any, any>,
  sent: Array<Sent>,
  tables: Tables,
) =>
  Layer.effect(
    lib.DynamoClient,
    Effect.map(
      lib.DynamoClient as Effect.Effect<Record<string, unknown>>,
      (inner) =>
        new Proxy(inner, {
          get: (target, operation) => {
            const value = target[operation as string]
            if (typeof value !== "function") return value
            return (input: unknown, ...rest: Array<unknown>) => {
              if (JSON.stringify(input).toLowerCase().includes("ledger")) {
                sent.push({ operation: String(operation), input: normalize(input, tables) })
              }
              return value.call(target, input, ...rest)
            }
          },
        }),
    ),
  ).pipe(Layer.provide(client))

/**
 * A read model, `__edd_rm__` a key attribute at `position`: `run(client)` binds it, each of its
 * `projections` applies the stream's two events, one at a time, and the first drains the read
 * model's outbox (`drainPending`). It returns every request naming a `Ledger` row or item, in
 * order, what was delivered, and the drain's result.
 */
export const names = (
  lib: Library,
  tables: Tables,
  position: Position,
  options: { readonly escapeKeys?: boolean; readonly projections?: 1 | 2 } = {},
) => {
  const d = definitions(lib, position, options)
  const run = (client: Layer.Layer<any, any, any>) => {
    const sent: Array<Sent> = []
    return Effect.gen(function* () {
      yield* d.bind
      const [events] = yield* d.append
      for (const projection of d.projections) {
        for (const event of events!) yield* projection.apply(event)
      }
      const delivered: Array<unknown> = []
      const result = yield* d.projections[0].drainPending((effect: unknown) =>
        Effect.sync(() => void delivered.push(effect)),
      )
      return { sent: sent as ReadonlyArray<Sent>, delivered, result }
    }).pipe(
      Effect.provide(Layer.merge(recording(lib, client, sent, tables), d.layer(tables))),
    ) as unknown as Effect.Effect<Ran, unknown>
  }
  return { run, Ledgers: d.Ledgers }
}

/** The rolling-deployment scenarios: what this release writes, and 1.40.0 drains. */
export type Rolling = "single" | "twoProjections" | "rowLost"

/**
 * Outbox items this release writes, for 1.40.0 to drain (`fixtures/outbox-rolling-1.40.0.json`):
 *
 * - `"single"`: one projection applies two events: two items, each with its mark.
 * - `"twoProjections"`: two projections of one read model, each with its revision, apply the
 *   same two events: the second's items at each revision beside the first's.
 * - `"rowLost"`: two streams fold into one row; the row is deleted after the first stream's
 *   events, and the second's then write at the first's revisions, beside its items.
 *
 * `write(client)` writes them; `drainPending(client)` and `drain(client)` drain them with the
 * first projection, returning what was delivered and every request naming a `Ledger` item.
 */
export const rolling = (lib: Library, tables: Tables, scenario: Rolling) => {
  const d = definitions(lib, "none", {
    projections: scenario === "twoProjections" ? 2 : 1,
    ...(scenario === "rowLost" && { streams: ["acct", "acct2"] }),
  })
  const write = (client: Layer.Layer<any, any, any>) =>
    Effect.gen(function* () {
      yield* d.bind
      const appended = yield* d.append
      for (const [n, events] of appended.entries()) {
        if (n > 0) {
          // The row lost (deleted outside the projection): its revision starts again.
          const ddb = yield* lib.DynamoClient
          const page = yield* ddb.scan({ TableName: tables.read, ConsistentRead: true })
          for (const item of page.Items ?? []) {
            if (item.__edd_e__?.S !== "Ledger") continue
            yield* ddb.deleteItem({ TableName: tables.read, Key: { pk: item.pk, sk: item.sk } })
          }
        }
        for (const projection of d.projections) {
          for (const event of events) yield* projection.apply(event)
        }
      }
    }).pipe(Effect.provide(Layer.merge(client, d.layer(tables)))) as Effect.Effect<void, unknown>
  const draining = (how: "drainPending" | "drain") => (client: Layer.Layer<any, any, any>) => {
    const sent: Array<Sent> = []
    return Effect.gen(function* () {
      yield* d.bind
      const delivered: Array<unknown> = []
      const deliver = (effect: unknown, meta: unknown) =>
        Effect.sync(() => void delivered.push({ effect, meta }))
      const result =
        how === "drainPending"
          ? yield* d.projections[0].drainPending(deliver)
          : yield* d.projections[0].drain({ shop: "north" }, deliver)
      return { sent: sent as ReadonlyArray<Sent>, delivered, result }
    }).pipe(
      Effect.provide(Layer.merge(recording(lib, client, sent, tables), d.layer(tables))),
    ) as unknown as Effect.Effect<Ran, unknown>
  }
  return {
    write,
    drainPending: draining("drainPending"),
    drain: draining("drain"),
    Ledgers: d.Ledgers,
  }
}
