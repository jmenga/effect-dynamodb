/**
 * A read model with ONE projection that removes rows (#154): the requests it sends to its table
 * around a tombstone — the tombstone write, `create` over it (single-item and in a transaction),
 * a late redelivery, `create` over the row and over nothing — and the items stored after them.
 *
 * `fixtures/projection-tombstones-1.39.0.json` holds what the published 1.39.0 sent and stored for
 * this scenario, against DynamoDB Local under `TestClock`. Never regenerate it from this repo: a read
 * model with one projection must send and store exactly that.
 *
 * The scenario takes the library as an argument, so the same code ran against the published 1.39.0
 * to make the fixture as runs against this repo's source to compare with it.
 */

import { readFileSync } from "node:fs"
import { Effect, Layer, Schema } from "effect"
import { expect } from "vitest"

/** The library modules the scenario uses: this repo's source, or a published release. */
export interface Library {
  readonly DynamoSchema: { readonly make: (config: any) => any }
  readonly Table: { readonly make: (config: any) => any }
  readonly Entity: { readonly make: (config: any) => any }
  readonly EventStore: any
  readonly Transaction: { readonly transactWrite: (ops: any) => Effect.Effect<any, any, any> }
  /** The `DynamoClient` service key. */
  readonly DynamoClient: any
}

/** One request, as the library handed it to the client. */
export interface Sent {
  readonly operation: string
  readonly input: unknown
}

export interface Fixture {
  readonly writtenBy: Record<string, string>
  /** The requests naming the read model's table, in order. */
  readonly requests: ReadonlyArray<Sent>
  /** The read model's table afterwards, by key. */
  readonly items: ReadonlyArray<Record<string, unknown>>
}

export const fixture = (): Fixture =>
  JSON.parse(
    readFileSync(new URL("../fixtures/projection-tombstones-1.39.0.json", import.meta.url), "utf8"),
  ) as Fixture

/** `value` as JSON, every object's names sorted: what it says, whatever order it says it in. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_, v) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  )

/** `sent` and `items` are what 1.39.0 sent and stored: every request is the same bytes. */
export const expectAsFixture = (
  sent: ReadonlyArray<Sent>,
  items: ReadonlyArray<Record<string, unknown>>,
) => {
  const expected = fixture()
  expect(sent.map(canonical)).toEqual(expected.requests.map(canonical))
  const bytes = (requests: ReadonlyArray<Sent>) =>
    requests.map((request) => JSON.stringify(request))
  expect(bytes(sent)).toEqual(bytes(expected.requests))
  expect(inKeyOrder(items)).toEqual(expected.items)
}

/** A request's input, as JSON, with the tables' names replaced by their names in the fixture. */
const normalize = (input: unknown, tables: { readonly events: string; readonly read: string }) =>
  JSON.parse(
    JSON.stringify(input)
      .replaceAll(JSON.stringify(tables.read), '"read"')
      .replaceAll(JSON.stringify(tables.events), '"events"'),
  )

/** Does `input` name the read model's table? */
const namesRead = (input: unknown, read: string) => JSON.stringify(input).includes(`"${read}"`)

/** The items of a table, in key order, their attributes by name, as JSON (a table keeps no order). */
export const inKeyOrder = (
  items: ReadonlyArray<Record<string, unknown>>,
): ReadonlyArray<Record<string, unknown>> =>
  items
    .map(
      (item) =>
        JSON.parse(
          JSON.stringify(
            Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : 1))),
          ),
        ) as Record<string, any>,
    )
    .sort((a, b) => {
      const ka = `${a.pk?.S}\u0000${a.sk?.S}`
      const kb = `${b.pk?.S}\u0000${b.sk?.S}`
      return ka < kb ? -1 : ka > kb ? 1 : 0
    })

/**
 * The scenario, on tables named `tables`: `run(client)` plays it over `client` (a layer of
 * `DynamoClient`) and returns every request naming the read model's table, in order.
 */
export const scenario = (
  lib: Library,
  tables: { readonly events: string; readonly read: string },
) => {
  const AppSchema = lib.DynamoSchema.make({ name: "tomb", version: 1 })

  class Placed extends Schema.TaggedClass<Placed>()("Placed", { amount: Schema.Number }) {}
  class Cancelled extends Schema.TaggedClass<Cancelled>()("Cancelled", {}) {}

  const EventsTable = lib.Table.make({ schema: AppSchema, entities: {} })
  const Orders = lib.EventStore.makeStream({
    table: EventsTable,
    streamName: "Order",
    events: [Placed, Cancelled],
    streamId: { composite: ["orderId"] },
  })

  const Summary = Schema.Struct({
    orderId: Schema.String,
    total: Schema.Number,
    version: Schema.Number,
    rev: Schema.Number,
  })
  type Summary = typeof Summary.Type

  const Summaries = lib.Entity.make({
    model: Summary,
    entityType: "Summary",
    primaryKey: {
      pk: { field: "pk", composite: ["orderId"] },
      sk: { field: "sk", composite: [] },
    },
    timestamps: true,
  })
  const ReadTable = lib.Table.make({ schema: AppSchema, entities: { Summaries } })

  // The read model's one projection.
  const Removable = lib.EventStore.projection({
    stream: Orders,
    readModel: Summaries,
    key: (id: { readonly orderId: string }) => ({ orderId: id.orderId }),
    initial: (id: { readonly orderId: string }): Summary => ({
      orderId: id.orderId,
      total: 0,
      version: 0,
      rev: 0,
    }),
    evolve: (state: Summary, event: { readonly data: Placed | Cancelled }) =>
      Effect.succeed(
        event.data._tag === "Cancelled"
          ? lib.EventStore.removeRow
          : { ...state, total: state.total + event.data.amount },
      ),
    checkpoint: "version",
    revision: "rev",
    removal: { ttl: "7 days" },
  })

  const sent: Array<Sent> = []
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
                  if (namesRead(input, tables.read)) {
                    sent.push({ operation: String(operation), input: normalize(input, tables) })
                  }
                  return value.call(target, input, ...rest)
                }
              },
            }),
        ),
      ).pipe(Layer.provide(client)),
      EventsTable.layer({ name: tables.events }),
      ReadTable.layer({ name: tables.read }),
    )

  const removed = (orderId: string) =>
    Effect.gen(function* () {
      yield* Orders.append({ orderId }, [new Placed({ amount: 1 }), new Cancelled({})], 0)
      const events = yield* Orders.read({ orderId })
      yield* Removable.applyBatch(events)
      return events
    })

  const steps = Effect.gen(function* () {
    // A tombstone, then the entity's create in its place.
    const events = yield* removed("o1")
    yield* Summaries.create({ orderId: "o1", total: 9, version: 0, rev: 0 }).asEffect()
    // A late redelivery: already applied.
    yield* Removable.apply(events[1])
    // A second create finds the row.
    const again = yield* Effect.flip(
      Summaries.create({ orderId: "o1", total: 1, version: 0, rev: 0 }).asEffect(),
    )
    if ((again as { readonly _tag?: string })._tag !== "ConditionalCheckFailed") {
      return yield* Effect.die(again)
    }
    // A transactional create over a tombstone.
    yield* removed("o2")
    yield* lib.Transaction.transactWrite([
      Summaries.create({ orderId: "o2", total: 4, version: 0, rev: 0 }),
    ])
    // A create over nothing.
    yield* Summaries.create({ orderId: "o3", total: 2, version: 0, rev: 0 }).asEffect()
    return sent as ReadonlyArray<Sent>
  })

  const run = <E, R>(
    client: Layer.Layer<any, E, R>,
  ): Effect.Effect<ReadonlyArray<Sent>, unknown, R> =>
    steps.pipe(Effect.provide(layer(client))) as Effect.Effect<ReadonlyArray<Sent>, unknown, R>

  return { run }
}
