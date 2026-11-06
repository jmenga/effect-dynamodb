/**
 * One program that writes a row through every key path (#183), taking the library as a
 * parameter so a published package can run it too. `fixtures/rows-1.36.0.json`,
 * `rows-1.37.0.json` and `rows-1.38.0.json` hold what those packages stored: each generated once,
 * from outside the repo, and never regenerated from this tree, since their whole point is that
 * the bytes came from that release. With `escapeKeys: false` this tree must store 1.36.0's bytes.
 */

export type Casing = "lowercase" | "uppercase" | "preserve"

/** The library's modules: the published package's, or this tree's. */
export interface Library {
  readonly Effect: any
  readonly Schema: any
  readonly DynamoSchema: any
  readonly Entity: any
  readonly Table: any
  readonly EventStore: any
  readonly Aggregate: any
  readonly DynamoClient: any
}

/** Values for the composites. */
export interface Values {
  readonly a: string
  readonly b: string
  readonly c: string
  readonly d: string
}

/** Every character here is one a key escapes: a space, a `#`, a `%`, a newline, a capital. */
export const SPELLED: Values = { a: "u 1", b: "a b", c: "50%", d: "Foo#Bar\nBaz" }
/** Nothing here is: a key holds these as they are, under any setting. */
export const PLAIN: Values = { a: "u1", b: "ab", c: "50", d: "FooBarBaz" }

/** The numeric composites and the time-series `orderBy`. */
export interface Numbers {
  readonly n: number
  readonly s: number
  readonly at: number
}

/** Numbers every release holds as the same zero-padded text. */
export const PADDED: Numbers = { n: 5, s: 7, at: 9 }
/** Numbers whose text changed in 1.37.0: a negative, a fraction, and a negative `orderBy`. */
export const CHANGED: Numbers = { n: -3, s: 2.5, at: -9 }

export const CASINGS: ReadonlyArray<Casing> = ["lowercase", "uppercase", "preserve"]

export const makeWorld = (
  lib: Library,
  schemaOptions: {
    readonly casing: Casing
    readonly escapeKeys?: boolean
  },
) => {
  const { Schema, DynamoSchema, Entity, Table, EventStore, Aggregate, DynamoClient } = lib
  const schema = DynamoSchema.make({ name: "Rows", version: 1, ...schemaOptions })
  const Items = Entity.make({
    model: Schema.Struct({
      tenant: Schema.String,
      n: Schema.Number,
      label: Schema.String,
      s: Schema.Number,
      region: Schema.optional(Schema.String),
      zone: Schema.optional(Schema.String),
    }),
    entityType: "Item",
    primaryKey: {
      pk: { field: "pk", composite: ["tenant", "n"] },
      sk: { field: "sk", composite: ["label", "s"] },
    },
    indexes: {
      byRegion: {
        name: "gsi1",
        pk: { field: "gsi1pk", composite: ["region"] },
        sk: { field: "gsi1sk", composite: ["zone"] },
      },
    },
  })
  const Members = Entity.make({
    model: Schema.Struct({
      memberId: Schema.String,
      teamId: Schema.String,
      orgId: Schema.String,
    }),
    entityType: "Member",
    primaryKey: {
      pk: { field: "pk", composite: ["memberId"] },
      sk: { field: "sk", composite: [] },
    },
    indexes: {
      byTeam: {
        name: "gsi2",
        collection: "team",
        type: "isolated",
        pk: { field: "gsi2pk", composite: ["teamId"] },
        sk: { field: "gsi2sk", composite: ["memberId"] },
      },
      byOrg: {
        name: "gsi3",
        collection: ["org", "dept"],
        type: "clustered",
        pk: { field: "gsi3pk", composite: ["orgId"] },
        sk: { field: "gsi3sk", composite: ["memberId"] },
      },
    },
  })
  const Users = Entity.make({
    model: Schema.Struct({
      id: Schema.String,
      email: Schema.String,
      note: Schema.optional(Schema.String),
    }),
    entityType: "User",
    primaryKey: {
      pk: { field: "pk", composite: ["id"] },
      sk: { field: "sk", composite: [] },
    },
    unique: { contact: ["email"] },
    versioned: { retain: true },
    softDelete: true,
  })
  const Reading = Schema.Struct({
    device: Schema.String,
    channel: Schema.String,
    at: Schema.Number,
  })
  const Readings = Entity.make({
    model: Reading,
    entityType: "Reading",
    primaryKey: {
      pk: { field: "pk", composite: ["device"] },
      sk: { field: "sk", composite: ["channel"] },
    },
    timeSeries: { orderBy: "at", appendInput: Reading },
  })
  const Edges = Entity.make({
    model: Schema.Struct({ userId: Schema.String, groupId: Schema.String }),
    entityType: "Edge",
    primaryKey: {
      pk: { field: "pk", composite: ["userId"] },
      sk: { field: "sk", composite: ["groupId"] },
    },
    indexes: {
      byGroup: {
        name: "gsi4",
        pk: { field: "sk", composite: ["groupId"] },
        sk: { field: "pk", composite: ["userId"] },
      },
    },
  })
  const MainTable = Table.make({ schema, entities: { Items, Members, Users, Readings, Edges } })
  class Deposited extends Schema.TaggedClass()("Deposited", { amount: Schema.Number }) {}
  const Accounts = EventStore.makeStream({
    table: MainTable,
    streamName: "Accounts",
    events: [Deposited],
    streamId: { composite: ["tenant", "n"] },
  })
  const Ledgers = EventStore.makeStream({
    table: MainTable,
    streamName: "Ledgers",
    casing: "preserve",
    events: [Deposited],
    streamId: { composite: ["tenant"] },
  })
  const Stop = Schema.Struct({ label: Schema.String, note: Schema.String })
  const Route = Schema.Struct({
    id: Schema.String,
    area: Schema.String,
    stops: Schema.Array(Stop),
  })
  const Routes = Aggregate.make(Route, {
    table: MainTable,
    schema,
    pk: { field: "pk", composite: ["id"] },
    collection: { index: "lsi1", name: "routes", sk: { field: "lsi1sk", composite: ["area"] } },
    root: { entityType: "RouteItem" },
    // The form 1.36 had.
    edges: {
      stops: Aggregate.many("stops", { entityType: "RouteStop", sk: { composite: ["label"] } }),
    },
    list: {
      index: "gsi5",
      name: "routelist",
      pk: { field: "gsi5pk", composite: ["area"] },
      sk: { field: "gsi5sk", composite: ["id"] },
    },
  })
  const client = () =>
    DynamoClient.make({
      entities: { Items, Members, Users, Readings, Edges },
      aggregates: { Routes },
      tables: { MainTable },
    })
  return { schema, MainTable, Accounts, Ledgers, Routes, Deposited, client }
}

export type World = ReturnType<typeof makeWorld>

/** A row through every key path. */
export const writeEveryKey = (lib: Library, world: World, v: Values, numbers: Numbers = PADDED) =>
  lib.Effect.gen(function* () {
    const db: any = yield* world.client()
    yield* db.entities.Items.put({
      tenant: v.a,
      n: numbers.n,
      label: v.b,
      s: numbers.s,
      region: v.c,
      zone: v.d,
    }).asEffect()
    yield* db.entities.Members.put({ memberId: v.a, teamId: v.b, orgId: v.c }).asEffect()
    // A snapshot, a tombstone and a sentinel.
    yield* db.entities.Users.put({ id: v.a, email: v.b }).asEffect()
    yield* db.entities.Users.update({ id: v.a }).set({ note: "n" }).asEffect()
    yield* db.entities.Users.delete({ id: v.a }).asEffect()
    yield* db.entities.Users.put({ id: v.c, email: v.d }).asEffect()
    // A current row and an event.
    yield* db.entities.Readings.append({ device: v.a, channel: v.b, at: numbers.at }).asEffect()
    yield* db.entities.Edges.put({ userId: v.a, groupId: v.b }).asEffect()
    // A stream's events and a command's sentinel, under the schema's casing and the stream's own.
    const deposit = [new (world.Deposited as any)({ amount: 1 })]
    yield* world.Accounts.append({ tenant: v.a, n: numbers.n }, deposit, 0, {
      idempotency: { commandId: v.b },
    })
    yield* world.Ledgers.append({ tenant: v.d }, deposit, 0)
    yield* db.aggregates.Routes.create({
      id: v.a,
      area: v.b,
      stops: [{ label: v.c, note: "o" }],
    })
  })

/** What a key comparison looks at: a row's key attributes, a tombstone's time left out. */
export const keysOf = (
  rows: ReadonlyArray<Record<string, unknown>>,
): ReadonlyArray<Record<string, string>> =>
  rows
    .map((row) =>
      Object.fromEntries(
        Object.entries(row)
          .filter(([name]) => name === "__edd_e__" || /^(pk|sk|(gsi|lsi)\d+(pk|sk))$/.test(name))
          .map(([name, value]) => [
            name,
            String(value).replace(/\d{4}-\d\d-\d\dt[\d:.]+z/gi, "<time>"),
          ])
          .sort(([a], [b]) => (a! < b! ? -1 : a! > b! ? 1 : 0)),
      ),
    )
    .map((row) => [JSON.stringify(row), row] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, row]) => row)
