/**
 * Row-token scenarios for `RowTokenNames.test.ts` (#237), run against this repo's source and
 * against the published 1.40.0: the scenario takes the library as an argument, so the same code
 * ran against the published package (this file compiled beside it, against DynamoDB Local) to make
 * `fixtures/row-token-names-1.40.0.json`, as runs against this repo's source to compare with it.
 *
 * Each is a read model on whose rows `__edd_rt__` is already taken by something its definitions
 * name (`TokenPosition`), so its rows carry no row token (`rowTokenInUse`): with one projection or
 * two, standalone or with an outbox, it sends, stores, reads back and delivers what 1.40.0 did.
 *
 * Never regenerate the fixture from this repo.
 */

import { Effect, Layer, Schema } from "effect"

/** The library's modules the scenarios use, as 1.40.0 and this repo both export them. */
export interface Library {
  readonly DynamoSchema: any
  readonly DynamoModel: any
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
 * What takes `__edd_rt__` on the read model's rows: a model field; a field renamed to it; the
 * table's partition or sort key; the read model's index's partition or sort key; another member's
 * index on the table; an event stream's local index on the table; the `created` or `updated`
 * timestamp; the table's TTL attribute (the first projection has `removal: { ttl }`);
 * the read model's outbox index (its outbox on the read model's table). `"none"`: nothing.
 */
export type TokenPosition =
  | "none"
  | "field"
  | "rename"
  | "pk"
  | "sk"
  | "gsiPk"
  | "gsiSk"
  | "member"
  | "streamLsi"
  | "created"
  | "updated"
  | "ttl"
  | "outboxIndex"

export const TOKEN_POSITIONS: ReadonlyArray<Exclude<TokenPosition, "none">> = [
  "field",
  "rename",
  "pk",
  "sk",
  "gsiPk",
  "gsiSk",
  "member",
  "streamLsi",
  "created",
  "updated",
  "ttl",
  "outboxIndex",
]

/**
 * Without an outbox; with one whose items carry their mark (`__edd_rm__`, its name free); with
 * one whose items can't (its index's sort key is named `__edd_rm__`), so nothing this release adds
 * is in any request. `outboxIndex` has an outbox in both outbox modes, and no standalone run.
 */
export type Mode = "standalone" | "outbox" | "outboxUnmarked"

export const MODES: ReadonlyArray<Mode> = ["standalone", "outbox", "outboxUnmarked"]

/** The modes a position runs in. */
export const modesOf = (position: TokenPosition): ReadonlyArray<Mode> =>
  position === "outboxIndex" ? ["outbox", "outboxUnmarked"] : MODES

/** A table's key attributes and secondary indexes. */
export interface TableLayout {
  readonly pk: string
  readonly sk: string
  readonly indexes: Readonly<
    Record<string, { readonly pk: string; readonly sk: string; readonly local?: boolean }>
  >
}

/** Each table's keys and indexes. */
export const layoutOf = (
  position: TokenPosition,
  mode: Mode,
): Readonly<Record<keyof Tables, TableLayout>> => {
  const outboxIndex = {
    pk: position === "outboxIndex" ? "__edd_rt__" : "obpk",
    sk: mode === "outboxUnmarked" ? "__edd_rm__" : "obsk",
  }
  const readPk = position === "pk" ? "__edd_rt__" : "pk"
  return {
    events: { pk: "pk", sk: "sk", indexes: {} },
    read: {
      pk: readPk,
      sk: position === "sk" ? "__edd_rt__" : "sk",
      indexes: {
        ...(position === "gsiPk" && { byRt: { pk: "__edd_rt__", sk: "gsk" } }),
        ...(position === "gsiSk" && { byRt: { pk: "gpk", sk: "__edd_rt__" } }),
        ...(position === "member" && { byRt: { pk: "__edd_rt__", sk: "msk" } }),
        ...(position === "streamLsi" && { byRt: { pk: readPk, sk: "__edd_rt__", local: true } }),
        ...(position === "outboxIndex" && { outbox: outboxIndex }),
      },
    },
    outbox: {
      pk: "opk",
      sk: "osk",
      indexes: mode === "standalone" || position === "outboxIndex" ? {} : { outbox: outboxIndex },
    },
  }
}

/** A JSON value with the run's times, expiries and claims made stable. */
const stable = (text: string) =>
  JSON.parse(text, (key, value) => {
    if (key === ":c" || key === ":u" || key === ":now") return { volatile: true }
    if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) return "<time>"
    if (key === "N" && typeof value === "string" && Number(value) >= 1e9) return "<epoch>"
    return value
  })

/** A request's input, its tables' names replaced by theirs here, made stable. */
const normalize = (input: unknown, tables: Tables) => {
  let text = JSON.stringify(input)
  for (const [name, physical] of Object.entries(tables)) {
    text = text.replaceAll(JSON.stringify(physical), JSON.stringify(name))
  }
  return stable(text)
}

/**
 * The read model, its streams, tables and projections, `__edd_rt__` taken at `position`, with
 * `projections` projections: `A` (checkpoint `a`, revision `ra`, the outbox in an outbox mode,
 * `removal: { ttl }` at `ttl`) and `B` (`b`, `rb`), each folding its own stream into row `x`.
 */
export const definitions = (
  lib: Library,
  position: TokenPosition,
  options: {
    readonly mode?: Mode
    readonly escapeKeys?: boolean
    readonly projections?: 1 | 2
  } = {},
) => {
  const mode = options.mode ?? "standalone"
  const layout = layoutOf(position, mode)
  const AppSchema = lib.DynamoSchema.make({
    name: "tok",
    version: 1,
    ...(options.escapeKeys === true ? { escapeKeys: true } : {}),
  })
  class Added extends Schema.TaggedClass<Added>()("Added", { amount: Schema.Number }) {}
  class Closed extends Schema.TaggedClass<Closed>()("Closed", {}) {}
  const EventsTable = lib.Table.make({ schema: AppSchema, entities: {} })
  // The user's own value: in the field `note`, or in a field named `__edd_rt__`.
  const noteField = position === "field" ? "__edd_rt__" : "note"
  const base = Schema.Struct({
    id: Schema.String,
    total: Schema.Number,
    [noteField]: Schema.String,
    a: Schema.optional(Schema.Number),
    ra: Schema.optional(Schema.Number),
    b: Schema.optional(Schema.Number),
    rb: Schema.optional(Schema.Number),
  })
  const index = layout.read.indexes.byRt
  const Tallies = lib.Entity.make({
    model:
      position === "rename"
        ? lib.DynamoModel.configure(base, { note: { field: "__edd_rt__" } })
        : base,
    entityType: "Tally",
    primaryKey: {
      pk: { field: layout.read.pk, composite: ["id"] },
      sk: { field: layout.read.sk, composite: [] },
    },
    ...((position === "gsiPk" || position === "gsiSk") && {
      indexes: {
        byRt: {
          name: "byRt",
          pk: { field: index!.pk, composite: ["id"] },
          sk: { field: index!.sk, composite: [] },
        },
      },
    }),
    ...(position === "created" && { timestamps: { created: "__edd_rt__" } }),
    ...(position === "updated" && { timestamps: { updated: "__edd_rt__" } }),
  })
  const Others =
    position === "member"
      ? lib.Entity.make({
          model: Schema.Struct({ x: Schema.String }),
          entityType: "Other",
          primaryKey: {
            pk: { field: layout.read.pk, composite: ["x"] },
            sk: { field: layout.read.sk, composite: [] },
          },
          indexes: {
            byRt: {
              name: "byRt",
              pk: { field: "__edd_rt__", composite: ["x"] },
              sk: { field: "msk", composite: [] },
            },
          },
        })
      : undefined
  const ReadTable = lib.Table.make({
    schema: AppSchema,
    entities: Others === undefined ? { Tallies } : { Tallies, Others },
  })
  const OutboxTable = lib.Table.make({ schema: AppSchema, entities: {} })
  const stream = (streamName: string) =>
    lib.EventStore.makeStream({
      table: position === "streamLsi" ? ReadTable : EventsTable,
      streamName,
      events: [Added, Closed],
      streamId: { composite: ["id"] },
      ...(position === "streamLsi" && {
        indexes: { byRt: { index: "byRt", sk: "__edd_rt__", key: () => "k" } },
      }),
    })
  const Streams = { A: stream("A"), B: stream("B") }
  type Row = { readonly total: number }
  const outbox =
    mode === "standalone"
      ? undefined
      : {
          schema: Schema.Struct({ total: Schema.Number }),
          effects: (_event: unknown, next: Row | undefined) => [{ total: next?.total ?? -1 }],
          ...(position === "outboxIndex"
            ? { index: { name: "outbox", ...layout.read.indexes.outbox! } }
            : {
                table: OutboxTable,
                keys: { pk: layout.outbox.pk, sk: layout.outbox.sk },
                index: { name: "outbox", ...layout.outbox.indexes.outbox! },
              }),
        }
  const projection = (name: "A" | "B") =>
    lib.EventStore.projection({
      stream: Streams[name],
      readModel: Tallies,
      key: (id: { readonly id: string }) => ({ id: id.id }),
      initial: (id: { readonly id: string }) => ({
        id: id.id,
        total: 0,
        [noteField]: "customer-owned",
      }),
      evolve: (state: Row, event: { readonly data: Added | Closed }) =>
        Effect.succeed(
          event.data._tag === "Closed"
            ? lib.EventStore.removeRow
            : { ...state, total: state.total + event.data.amount },
        ),
      checkpoint: name === "A" ? "a" : "b",
      revision: name === "A" ? "ra" : "rb",
      retry: 0,
      ...(name === "A" && outbox !== undefined && { outbox }),
      ...(name === "A" && position === "ttl" && { removal: { ttl: "1 day" } }),
    })
  const projections = Array.from({ length: options.projections ?? 1 }, (_, i) =>
    projection(i === 0 ? "A" : "B"),
  )
  const layer = (tables: Tables) =>
    Layer.mergeAll(
      EventsTable.layer({ name: tables.events }),
      ReadTable.layer({
        name: tables.read,
        ...(position === "ttl" && { ttlAttributeName: "__edd_rt__" }),
      }),
      OutboxTable.layer({ name: tables.outbox }),
    )
  /** A client binding the read model (and the table's other member) and every table. */
  const bind = lib.DynamoClient.make({
    entities: { Tallies, ...(Others === undefined ? {} : { Others }) },
    tables: { EventsTable, ReadTable, OutboxTable },
  })
  /**
   * Each stream's events, appended: A's `1, 2` (`1, Closed, 2` at `ttl`), B's `5, 7`; then
   * applied one at a time, A's and B's in turn: A's first, B's first, A's second, ...
   */
  const events = {
    A:
      position === "ttl"
        ? [new Added({ amount: 1 }), new Closed(), new Added({ amount: 2 })]
        : [new Added({ amount: 1 }), new Added({ amount: 2 })],
    B: [new Added({ amount: 5 }), new Added({ amount: 7 })],
  }
  return { Tallies, ReadTable, Streams, projections, layer, bind, events, noteField, index }
}

/** What a scenario's run sent, stored, read back and delivered. */
export interface Ran {
  readonly sent: ReadonlyArray<Sent>
  readonly stored: ReadonlyArray<unknown>
  readonly read: unknown
  readonly indexed: unknown
  readonly delivered: ReadonlyArray<unknown>
}

/** `client` (a layer of `DynamoClient`), each request whose input names a `Tally` pushed. */
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
              if (JSON.stringify(input).toLowerCase().includes("tally")) {
                sent.push({ operation: String(operation), input: normalize(input, tables) })
              }
              return value.call(target, input, ...rest)
            }
          },
        }),
    ),
  ).pipe(Layer.provide(client))

/** As stored: each item's attributes and the items sorted. */
const sorted = (items: ReadonlyArray<Record<string, unknown>>) =>
  items
    .map((item) => Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : 1))))
    .sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1))

/**
 * A read model, `__edd_rt__` taken at `position`: `run(client)` binds it, appends each stream's
 * events, applies them one at a time in turn, drains A's outbox, then reads row `x` back (`get`,
 * and its index at `gsiPk` / `gsiSk`). It returns every request naming a `Tally` row or item, in
 * order, the read model's items as stored (scanned), what was read back and what was delivered.
 */
export const scenario = (
  lib: Library,
  tables: Tables,
  position: TokenPosition,
  options: {
    readonly mode?: Mode
    readonly escapeKeys?: boolean
    readonly projections?: 1 | 2
  } = {},
) => {
  const d = definitions(lib, position, options)
  const run = (client: Layer.Layer<any, any, any>) => {
    const sent: Array<Sent> = []
    return Effect.gen(function* () {
      const db = yield* d.bind
      const read: Record<"A" | "B", ReadonlyArray<unknown>> = { A: [], B: [] }
      const names = d.projections.length === 2 ? (["A", "B"] as const) : (["A"] as const)
      for (const name of names) {
        yield* d.Streams[name].append({ id: "x" }, d.events[name], 0)
        read[name] = (yield* d.Streams[name].read({ id: "x" })) as ReadonlyArray<unknown>
      }
      for (let i = 0; i < Math.max(read.A.length, read.B.length); i++) {
        for (const [n, name] of names.entries()) {
          const event = read[name][i]
          if (event !== undefined) yield* d.projections[n]!.apply(event)
        }
      }
      const delivered: Array<unknown> = []
      if (options.mode !== undefined && options.mode !== "standalone") {
        yield* d.projections[0]!.drainPending((effect: unknown) =>
          Effect.sync(() => void delivered.push(effect)),
        )
      }
      const got = yield* Effect.exit(db.entities.Tallies.get({ id: "x" }))
      const indexed =
        d.index === undefined || position === "member" || position === "streamLsi"
          ? null
          : yield* Effect.exit(db.entities.Tallies.byRt({ id: "x" }).collect())
      const ddb = yield* lib.DynamoClient
      const page = yield* ddb.scan({ TableName: tables.read, ConsistentRead: true })
      const stored = sorted(
        (page.Items ?? []).filter((item: any) => String(item.__edd_e__?.S).startsWith("Tally")),
      )
      return stable(
        JSON.stringify({
          sent,
          stored,
          read: got,
          indexed,
          delivered,
        }),
      ) as Ran
    }).pipe(
      Effect.provide(Layer.merge(recording(lib, client, sent, tables), d.layer(tables))),
    ) as unknown as Effect.Effect<Ran, unknown>
  }
  return { run, Tallies: d.Tallies }
}

/** The table's TTL attribute in `position`, as its layer names it (`"_ttl"` by default). */
export const ttlNameOf = (position: TokenPosition): string =>
  position === "ttl" ? "__edd_rt__" : "_ttl"

/**
 * A run without the outbox items' mark (`__edd_rm__`, #237), which 1.40.0 doesn't write: the
 * attribute off each item sent or stored, and the condition naming it off each `Put` sent.
 */
export const withoutMark = (ran: Ran): Ran => {
  const strip = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(strip)
    if (typeof value !== "object" || value === null) return value
    const out: Record<string, unknown> = {}
    for (const [key, v] of Object.entries(value)) {
      if (key === "__edd_rm__") continue
      out[key] = strip(v)
    }
    const names = out.ExpressionAttributeNames as Record<string, string> | undefined
    if (names !== undefined && Object.values(names).includes("__edd_rm__")) {
      delete out.ConditionExpression
      delete out.ExpressionAttributeNames
      delete out.ExpressionAttributeValues
    }
    return out
  }
  return {
    ...ran,
    sent: strip(ran.sent) as ReadonlyArray<Sent>,
    stored: strip(ran.stored) as ReadonlyArray<unknown>,
  }
}
