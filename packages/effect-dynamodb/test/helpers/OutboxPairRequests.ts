/**
 * Two read models of one entity type in one schema, each with a projection whose outbox is on one
 * shared table. A client binds them, and each projection applies its stream's events: the requests
 * naming the read models' tables and the outbox's, in order. Two layouts:
 *
 * - `"prefix"`: both partition keys are led by `shop`, and the second's goes on with `branch`, so a
 *   key of one is a key of the other only through a value holding `#`.
 *   `fixtures/outbox-pair-1.39.0.json` holds what the published 1.39.0 sent and stored for it.
 * - `"typed"`: the first partition key is the number `n`, the second the string `n_x`: `n_` is
 *   followed by a number's text in one and by `x_` in the other, so no key of one is a key of the
 *   other. `fixtures/outbox-typed-pair-1.39.0.json` holds what the published 1.39.0 sent and stored
 *   for it, with `escapeKeys` off and on.
 *
 * Both fixtures were captured from the published 1.39.0 against DynamoDB Local, and their
 * `-1.40.0` twins from the published 1.40.0 the same way (this file compiled against the published
 * package; what it sent and stored equals 1.39.0's). Never regenerate them from this repo.
 *
 * The scenario takes the library as an argument, so the same code ran against the published 1.39.0
 * to make the fixture as runs against this repo's source to compare with it.
 */

import { Effect, Layer, Schema } from "effect"

/** The library's modules the scenario uses, as 1.39.0 and this repo both export them. */
export interface Library {
  readonly DynamoSchema: any
  readonly Table: any
  readonly Entity: any
  readonly EventStore: any
  readonly DynamoClient: any
}

/** A request the scenario sent: the client's operation and its input, tables named as below. */
export interface Sent {
  readonly operation: string
  readonly input: unknown
}

/** The physical names of the scenario's tables. */
export interface Tables {
  readonly events: string
  readonly readA: string
  readonly readB: string
  readonly outbox: string
}

/** A request's input, as JSON, with the tables' names replaced by their names in the fixture. */
const normalize = (input: unknown, tables: Tables) => {
  let text = JSON.stringify(input)
  for (const [name, physical] of Object.entries(tables)) {
    text = text.replaceAll(JSON.stringify(physical), JSON.stringify(name))
  }
  return JSON.parse(text)
}

/**
 * The scenario, on tables named `tables`: `run(client)` binds the read models, applies both
 * projections over `client` (a layer of `DynamoClient`) and returns every request naming a read
 * model's table or the outbox's, in order.
 */
export const scenario = (
  lib: Library,
  tables: Tables,
  layout: "prefix" | "typed" = "prefix",
  escapeKeys = false,
) => {
  const AppSchema = lib.DynamoSchema.make({
    name: "pair",
    version: 1,
    ...(escapeKeys ? { escapeKeys: true } : {}),
  })

  class Added extends Schema.TaggedClass<Added>()("Added", { amount: Schema.Number }) {}

  const EventsTable = lib.Table.make({ schema: AppSchema, entities: {} })
  const Accounts = lib.EventStore.makeStream({
    table: EventsTable,
    streamName: "Account",
    events: [Added],
    streamId: { composite: ["account"] },
  })

  const Row =
    layout === "prefix"
      ? Schema.Struct({
          shop: Schema.String,
          branch: Schema.String,
          name: Schema.String,
          total: Schema.Number,
          version: Schema.Number,
          rev: Schema.Number,
        })
      : Schema.Struct({
          n: Schema.Number,
          n_x: Schema.String,
          name: Schema.String,
          total: Schema.Number,
          version: Schema.Number,
          rev: Schema.Number,
        })
  type Row = { readonly total: number } & Record<string, unknown>
  const OutboxTable = lib.Table.make({ schema: AppSchema, entities: {} })
  const side = (pk: ReadonlyArray<string>) => {
    const Ledgers = lib.Entity.make({
      model: Row,
      entityType: "Ledger",
      primaryKey: {
        pk: { field: "pk", composite: pk },
        sk: { field: "sk", composite: ["name"] },
      },
    })
    const ReadTable = lib.Table.make({ schema: AppSchema, entities: { Ledgers } })
    const row = (account: string) =>
      layout === "prefix"
        ? { shop: "north", branch: "b1", name: account }
        : { n: 7, n_x: "q", name: account }
    const Projection = lib.EventStore.projection({
      stream: Accounts,
      readModel: Ledgers,
      key: (id: { readonly account: string }) => row(id.account),
      initial: (id: { readonly account: string }): Row => ({
        ...row(id.account),
        total: 0,
        version: 0,
        rev: 0,
      }),
      evolve: (state: Row, event: { readonly data: Added }) =>
        Effect.succeed({ ...state, total: state.total + event.data.amount }),
      checkpoint: "version",
      revision: "rev",
      outbox: {
        schema: Schema.Struct({ account: Schema.String, total: Schema.Number }),
        effects: (event: { readonly streamId: string }, next: Row | undefined) => [
          { account: event.streamId, total: next?.total ?? -1 },
        ],
        table: OutboxTable,
      },
    })
    return { Ledgers, ReadTable, Projection }
  }
  const A = side(layout === "prefix" ? ["shop"] : ["n"])
  const B = side(layout === "prefix" ? ["shop", "branch"] : ["n_x"])

  const sent: Array<Sent> = []
  const named = [tables.readA, tables.readB, tables.outbox].map((name) => JSON.stringify(name))
  const layer = <E, R>(client: Layer.Layer<any, E, R>) =>
    Layer.mergeAll(
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
                  const text = JSON.stringify(input)
                  if (named.some((name) => text.includes(name))) {
                    sent.push({ operation: String(operation), input: normalize(input, tables) })
                  }
                  return value.call(target, input, ...rest)
                }
              },
            }),
        ),
      ).pipe(Layer.provide(client)),
      EventsTable.layer({ name: tables.events }),
      A.ReadTable.layer({ name: tables.readA }),
      B.ReadTable.layer({ name: tables.readB }),
      OutboxTable.layer({ name: tables.outbox }),
    )

  const steps = Effect.gen(function* () {
    // The client binds both read models, their tables and the outbox's.
    yield* lib.DynamoClient.make({
      entities: { A: A.Ledgers, B: B.Ledgers },
      tables: { ReadA: A.ReadTable, ReadB: B.ReadTable, OutboxTable },
    })
    yield* Accounts.append(
      { account: "acct" },
      [new Added({ amount: 2 }), new Added({ amount: 3 })],
      0,
    )
    const events = (yield* Accounts.read({ account: "acct" })) as ReadonlyArray<unknown>
    for (const side of [A, B]) {
      yield* side.Projection.apply(events[0])
      yield* side.Projection.apply(events[1])
    }
    return sent as ReadonlyArray<Sent>
  })

  const run = <E, R>(
    client: Layer.Layer<any, E, R>,
  ): Effect.Effect<ReadonlyArray<Sent>, unknown, R> =>
    steps.pipe(Effect.provide(layer(client))) as Effect.Effect<ReadonlyArray<Sent>, unknown, R>

  return { run, readModels: { [tables.readA]: A.Ledgers, [tables.readB]: B.Ledgers } }
}
