/**
 * A `rebuild` of a projection with an outbox (#237), run against this repo's source and against the
 * published 1.40.0: the scenario takes the library as an argument, so the same code ran against
 * the published package (this file compiled beside it, against DynamoDB Local) to make
 * `fixtures/outbox-rebuild-1.40.0.json` as runs against this repo's source to compare with it.
 * Never regenerate the fixture from this repo.
 *
 * One read model, `Ledger` (its sort key holds `#`), one projection (`single`, or `multi`-source)
 * with a revision and an outbox on a table of its own. The stream's events add 2 and 3; the first
 * is applied and its effect drained, the second applied and its effect left pending. Then the
 * row is kept (`live`) or deleted outside the projection (`absent`), and the projection rebuilt.
 * A drain follows, then a third event (7), applied live and drained.
 */

import { Effect, Layer, Schema } from "effect"
import type { Library, Sent, Tables } from "./OutboxScenarios.js"

/** The read model's row, kept, or deleted outside the projection before the rebuild. */
export type RebuildState = "live" | "absent"
export const REBUILD_STATES: ReadonlyArray<RebuildState> = ["live", "absent"]
/** A single-source `projection`, or a `multiProjection` with one source. */
export type RebuildMode = "single" | "multi"
export const REBUILD_MODES: ReadonlyArray<RebuildMode> = ["single", "multi"]

/** What a scenario's run did. */
export interface Rebuilt {
  /** Every request the rebuild sent, its tables named as in {@link Tables}. */
  readonly sent: ReadonlyArray<Sent>
  /** The read model's row after the rebuild, as stored. */
  readonly row: unknown
  /** Effects delivered (`<version>:<total>`): before the rebuild, after it, after the live event. */
  readonly delivered: {
    readonly before: ReadonlyArray<string>
    readonly after: ReadonlyArray<string>
    readonly live: ReadonlyArray<string>
  }
  /** Outbox items left at the end. */
  readonly left: number
}

/** The `"rebuild"` scenario's key in the fixture. */
export const rebuildKey = (mode: RebuildMode, state: RebuildState, escapeKeys: boolean) =>
  `${mode}/${state}/${escapeKeys ? "on" : "off"}`

const normalize = (input: unknown, tables: Tables) => {
  let text = JSON.stringify(input)
  for (const [name, physical] of Object.entries(tables)) {
    text = text.replaceAll(JSON.stringify(physical), JSON.stringify(name))
  }
  return JSON.parse(text)
}

/** The rebuild scenario in `mode` over a row in `state`. `run(client)` runs it. */
export const rebuildScenario = (
  lib: Library,
  tables: Tables,
  mode: RebuildMode,
  state: RebuildState,
  options: { readonly escapeKeys?: boolean } = {},
) => {
  const AppSchema = lib.DynamoSchema.make({
    name: "rebuilt",
    version: 1,
    // Stated either way, so a run that turns the default over (`test:escape-on`) keeps it.
    escapeKeys: options.escapeKeys === true,
  })
  class Added extends Schema.TaggedClass<Added>()("Added", { amount: Schema.Number }) {}
  const EventsTable = lib.Table.make({ schema: AppSchema, entities: {} })
  const Orders = lib.EventStore.makeStream({
    table: EventsTable,
    streamName: "Order",
    events: [Added],
    streamId: { composite: ["id"] },
  })
  const Ledgers = lib.Entity.make({
    model: Schema.Struct({
      shop: Schema.String,
      name: Schema.String,
      total: Schema.Number,
      cp: Schema.optional(Schema.Number),
      cpm: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
      rev: Schema.optional(Schema.Number),
    }),
    entityType: "Ledger",
    primaryKey: {
      pk: { field: "pk", composite: ["shop"] },
      sk: { field: "sk", composite: ["name"] },
    },
  })
  const ReadTable = lib.Table.make({ schema: AppSchema, entities: { Ledgers } })
  const OutboxTable = lib.Table.make({ schema: AppSchema, entities: {} })
  const KEY = { shop: "north", name: "a#b" }
  type Row = { readonly total: number }
  const evolve = (row: Row, event: { readonly data: Added }) =>
    Effect.succeed({ ...row, total: row.total + event.data.amount })
  const outbox = {
    schema: Schema.Struct({ n: Schema.Number, total: Schema.Number }),
    effects: (event: { readonly version: number }, next: Row | undefined) => [
      { n: event.version, total: next?.total ?? -1 },
    ],
    table: OutboxTable,
    keys: { pk: "opk", sk: "osk" },
    index: { name: "outbox", pk: "obpk", sk: "obsk" },
  }
  const initial = () => ({ ...KEY, total: 0 })
  const projection =
    mode === "multi"
      ? lib.EventStore.multiProjection({
          readModel: Ledgers,
          initial,
          sources: (source: any) => ({ orders: source(Orders, { key: () => KEY, evolve }) }),
          checkpoints: { field: "cpm" },
          revision: "rev",
          outbox,
        })
      : lib.EventStore.projection({
          stream: Orders,
          readModel: Ledgers,
          key: () => KEY,
          initial,
          evolve,
          checkpoint: "cp",
          revision: "rev",
          outbox,
        })
  const apply = (event: unknown) =>
    (mode === "multi"
      ? projection.applyBatch([{ stream: "orders", event }])
      : projection.apply(event)) as Effect.Effect<unknown, unknown>
  const rebuild = () =>
    (mode === "multi"
      ? projection.rebuild(KEY, { instances: { orders: [{ id: "s" }] } })
      : projection.rebuild({ id: "s" })) as Effect.Effect<unknown, unknown>
  const drain = Effect.gen(function* () {
    const delivered: Array<string> = []
    yield* projection.drainPending((effect: { readonly n: number; readonly total: number }) =>
      Effect.sync(() => void delivered.push(`${effect.n}:${effect.total}`)),
    )
    return delivered
  })
  const ledgerRows = Effect.gen(function* () {
    const ddb = yield* lib.DynamoClient
    const page = yield* ddb.scan({ TableName: tables.read, ConsistentRead: true })
    return ((page.Items ?? []) as ReadonlyArray<Record<string, any>>).filter(
      (item) => item.__edd_e__?.S === "Ledger",
    )
  })

  const run = (client: Layer.Layer<any, any, any>) => {
    const sent: Array<Sent> = []
    let recording = false
    const recorded = Layer.effect(
      lib.DynamoClient,
      Effect.map(
        lib.DynamoClient as Effect.Effect<Record<string, unknown>>,
        (inner) =>
          new Proxy(inner, {
            get: (target, operation) => {
              const value = target[operation as string]
              if (typeof value !== "function") return value
              return (input: unknown, ...rest: Array<unknown>) => {
                if (recording) {
                  sent.push({ operation: String(operation), input: normalize(input, tables) })
                }
                return value.call(target, input, ...rest)
              }
            },
          }),
      ),
    ).pipe(Layer.provide(client))
    return Effect.gen(function* () {
      yield* lib.DynamoClient.make({
        entities: { Ledgers },
        tables: { EventsTable, ReadTable, OutboxTable },
      })
      yield* Orders.append({ id: "s" }, [new Added({ amount: 2 }), new Added({ amount: 3 })], 0)
      const events = (yield* Orders.read({ id: "s" })) as ReadonlyArray<unknown>
      yield* apply(events[0])
      const before = yield* drain
      yield* apply(events[1])
      if (state === "absent") {
        const ddb = yield* lib.DynamoClient
        for (const row of yield* ledgerRows) {
          yield* ddb.deleteItem({ TableName: tables.read, Key: { pk: row.pk, sk: row.sk } })
        }
      }
      recording = true
      yield* rebuild()
      recording = false
      const [row] = yield* ledgerRows
      const after = yield* drain
      yield* Orders.append({ id: "s" }, [new Added({ amount: 7 })], 2)
      const [third] = ((yield* Orders.read({ id: "s" })) as ReadonlyArray<unknown>).slice(2)
      yield* apply(third)
      const live = yield* drain
      const ddb = yield* lib.DynamoClient
      const left = ((yield* ddb.scan({ TableName: tables.outbox, ConsistentRead: true })).Items ??
        []) as ReadonlyArray<unknown>
      return {
        sent,
        row: normalize(row, tables),
        delivered: { before, after, live },
        left: left.length,
      } satisfies Rebuilt
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          recorded,
          EventsTable.layer({ name: tables.events }),
          ReadTable.layer({ name: tables.read }),
          OutboxTable.layer({ name: tables.outbox }),
        ),
      ),
    ) as unknown as Effect.Effect<Rebuilt, unknown>
  }
  return { run, Ledgers }
}
