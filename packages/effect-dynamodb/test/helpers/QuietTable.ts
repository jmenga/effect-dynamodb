/**
 * A table with nothing for `rekey` to do: every kind of row a member writes, each under the key its
 * setting composes. `rekey` over it must send the requests the published 1.40.0 sent, byte for
 * byte (`fixtures/rekey-requests-1.40.0.json`).
 *
 * No runtime import: the modules come in as arguments, so the generator that wrote the fixture ran
 * this file against the published 1.40.0 and the tests run it against `src/`.
 */

/** The modules {@link quietWorld} builds from: the published package's or `src/`'s. */
export interface QuietModules {
  readonly Effect: any
  readonly Schema: any
  readonly DynamoSchema: any
  readonly Entity: any
  readonly Table: any
  readonly Aggregate: any
  readonly EventStore: any
  readonly DynamoClient: any
}

/** The members, under `escapeKeys`, and how to write each kind of row. */
export const quietWorld = (m: QuietModules, escapeKeys: boolean) => {
  const { Schema } = m
  const schema = m.DynamoSchema.make({ name: "quiet", version: 1, escapeKeys })
  const Users = m.Entity.make({
    model: Schema.Struct({
      team: Schema.String,
      id: Schema.String,
      email: Schema.String,
      name: Schema.String,
    }),
    entityType: "User",
    primaryKey: {
      pk: { field: "pk", composite: ["team"] },
      sk: { field: "sk", composite: ["id"] },
    },
    indexes: {
      byName: {
        name: "gsi1",
        pk: { field: "gsi1pk", composite: ["team"] },
        sk: { field: "gsi1sk", composite: ["name"] },
      },
    },
    unique: { email: ["email"] },
    timestamps: true,
    versioned: { retain: true },
    softDelete: { preserveUnique: true },
  })
  const Readings = m.Entity.make({
    model: Schema.Struct({ device: Schema.String, at: Schema.Number, value: Schema.Number }),
    entityType: "Reading",
    primaryKey: {
      pk: { field: "pk", composite: ["device"] },
      sk: { field: "sk", composite: [] },
    },
    timeSeries: {
      orderBy: "at",
      appendInput: Schema.Struct({
        device: Schema.String,
        at: Schema.Number,
        value: Schema.Number,
      }),
    },
  })
  const MainTable = m.Table.make({ schema, entities: { Users, Readings } })
  const Line = Schema.Struct({ lid: Schema.String, qty: Schema.Number })
  const Orders = m.Aggregate.make(
    Schema.Struct({ id: Schema.String, customer: Schema.String, lines: Schema.Array(Line) }),
    {
      schema,
      table: MainTable,
      pk: { field: "pk", composite: ["id"] },
      collection: { name: "orders" },
      root: { entityType: "Order" },
      edges: { lines: m.Aggregate.many({ entityType: "OrderLine", sk: { composite: ["lid"] } }) },
    },
  )
  class Counted extends Schema.TaggedClass()("Counted", { by: Schema.Number }) {}
  const Counters = m.EventStore.makeStream({
    table: MainTable,
    streamName: "Counters",
    events: [Counted],
    streamId: { composite: ["name"] },
  })
  const client = m.DynamoClient.make({
    entities: { Users, Readings },
    aggregates: { Orders },
    tables: { MainTable },
  })
  // Built from untyped modules: its constructor is typed here.
  return {
    schema,
    MainTable,
    Counters,
    Counted: Counted as new (props: { by: number }) => unknown,
    client,
  }
}

/**
 * Every kind of row, written by the library under `world`'s setting: live items with their unique
 * sentinels and index keys, a version snapshot, a soft-deleted item with the sentinel it kept, a
 * time-series item and its events, an aggregate of three rows and a stream's events. Values hold a
 * space and a `%`, so their text differs between the settings.
 */
export const writeRows = (m: QuietModules, world: ReturnType<typeof quietWorld>) =>
  m.Effect.gen(function* () {
    const db: any = yield* world.client
    yield* db.entities.Users.put({ team: "red one", id: "u 1", email: "a b@x", name: "Ann" })
    yield* db.entities.Users.put({ team: "red one", id: "u%2", email: "c%d@x", name: "Bo" })
    yield* db.entities.Users.update({ team: "red one", id: "u 1" }).set({ name: "Ann B" })
    yield* db.entities.Users.put({ team: "red one", id: "u 3", email: "e f@x", name: "Cy" })
    yield* db.entities.Users.delete({ team: "red one", id: "u 3" })
    yield* db.entities.Readings.append({ device: "d 1", at: 1, value: 10 })
    yield* db.entities.Readings.append({ device: "d 1", at: 2, value: 20 })
    yield* db.aggregates.Orders.create({
      id: "o 1",
      customer: "Ann",
      lines: [
        { lid: "l 1", qty: 1 },
        { lid: "l%2", qty: 2 },
      ],
    })
    yield* world.Counters.append({ name: "c 1" }, [new world.Counted({ by: 1 })], 0)
    yield* world.Counters.append({ name: "c 1" }, [new world.Counted({ by: 2 })], 1)
  })

/** A request as the fixture holds it: the command, and its input as JSON with the table named `t`. */
export const requestText = (command: string, input: unknown, tableName: string): string =>
  `${command} ${JSON.stringify(input, (_key, value) =>
    value instanceof Uint8Array ? { B: Array.from(value) } : value,
  ).replaceAll(JSON.stringify(tableName), '"t"')}`
