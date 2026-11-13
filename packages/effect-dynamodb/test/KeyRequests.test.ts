/**
 * One request per operation, whatever a key's value holds (#183). Under either setting a value
 * whose key text changed (`a b`, `-3`, `x#y`, `foo%20bar`) sends exactly the requests a plain value
 * sends: the same commands, in the same order, with the same expressions and attribute names. There
 * is no second read, second write or row check for an older key text. `rekey` alone looks for those.
 *
 * Attribute values are reduced to their types, so what differs between the two runs can only be the
 * values themselves.
 */

import { describe, expect, it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Effect, Exit, Layer, Schema } from "effect"
import * as Aggregate from "../src/Aggregate.js"
import * as Batch from "../src/Batch.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
import * as Table from "../src/Table.js"
import * as Transaction from "../src/Transaction.js"
import { indexesOf } from "./helpers/DynamoExpressions.js"
import { makeRecordingTable, type Request } from "./helpers/RecordingTable.js"

const worldOf = (escapeKeys: boolean) => {
  const schema = DynamoSchema.make({ name: "capture", version: 1, escapeKeys })
  const Item = Schema.Struct({
    tenant: Schema.String,
    n: Schema.Number,
    label: Schema.String,
    s: Schema.Number,
    region: Schema.String,
    email: Schema.String,
    note: Schema.optional(Schema.String),
  })
  const Items = Entity.make({
    model: Item,
    entityType: "Item",
    primaryKey: {
      pk: { field: "pk", composite: ["tenant", "n"] },
      sk: { field: "sk", composite: ["label", "s"] },
    },
    indexes: {
      byRegion: {
        name: "gsi1",
        pk: { field: "gsi1pk", composite: ["region"] },
        sk: { field: "gsi1sk", composite: ["label", "s"] },
      },
      byShard: {
        name: "gsi2",
        pk: { field: "gsi2pk", composite: ["tenant"] },
        sk: { field: "gsi2sk", composite: ["label"] },
        shards: 3,
      },
    },
    unique: { email: ["email"] },
    versioned: { retain: true },
    softDelete: true,
  } as never) as any
  const Doc = Schema.Struct({ tenant: Schema.String, owner: Schema.String })
  const byOwner = {
    name: "gsi1",
    collection: "owned",
    pk: { field: "gsi1pk", composite: ["owner"] },
    sk: { field: "gsi1sk", composite: ["tenant"] },
  }
  const primaryOfDoc = {
    pk: { field: "pk", composite: ["tenant"] },
    sk: { field: "sk", composite: [] },
  }
  const Docs = Entity.make({
    model: Doc,
    entityType: "Doc",
    primaryKey: primaryOfDoc,
    indexes: { byOwner },
  } as never) as any
  const Logs = Entity.make({
    model: Doc,
    entityType: "Log",
    primaryKey: primaryOfDoc,
    indexes: { byOwner },
  } as never) as any
  const Reading = Schema.Struct({
    tenant: Schema.String,
    at: Schema.Number,
    note: Schema.String,
  })
  const Readings = Entity.make({
    model: Reading,
    entityType: "Reading",
    primaryKey: {
      pk: { field: "pk", composite: ["tenant"] },
      sk: { field: "sk", composite: [] },
    },
    timeSeries: { orderBy: "at", appendInput: Reading },
  } as never) as any
  const Home = Schema.Struct({
    id: Schema.String,
    region: Schema.String,
    agency: Schema.String,
    price: Schema.Number,
    beds: Schema.Number,
  })
  const Homes = Entity.make({
    model: Home,
    entityType: "Home",
    primaryKey: {
      pk: { field: "pk", composite: ["id"] },
      sk: { field: "sk", composite: [] },
    },
    indexes: {
      byFacets: {
        name: "gsi3",
        pk: { field: "gsi3pk", composite: ["region"] },
        sk: {
          field: "gsi3sk",
          prefix: ["agency"],
          zorder: [
            { field: "price", min: 0, max: 1000 },
            { field: "beds", min: 0, max: 15 },
          ],
        },
      },
    },
  } as never) as any
  const entities = { Items, Docs, Logs, Readings, Homes }
  const MainTable = Table.make({ schema, entities } as never) as any
  const Stop = Schema.Struct({ label: Schema.String })
  const Route = Schema.Struct({
    id: Schema.String,
    note: Schema.String,
    stops: Schema.Array(Stop),
  })
  const Routes = Aggregate.make(
    Route as never,
    {
      table: MainTable,
      schema,
      pk: { field: "pk", composite: ["id"] },
      collection: { index: "lsi1", name: "routes", sk: { field: "lsi1sk", composite: [] } },
      root: { entityType: "RouteItem" },
      edges: { stops: Aggregate.many({ entityType: "RouteStop", sk: { composite: ["label"] } }) },
    } as never,
  ) as any
  class Added extends Schema.TaggedClass<Added>()("Added", { value: Schema.Number }) {}
  const Accounts = EventStore.makeStream({
    table: MainTable,
    streamName: "Accounts",
    events: [Added],
    streamId: { composite: ["tenant"] },
    snapshot: { schema: Schema.Struct({ total: Schema.Number }), mode: "inline" },
  } as never) as any
  const client = DynamoClient.make({
    entities,
    aggregates: { Routes },
    tables: { MainTable },
  } as never) as unknown as Effect.Effect<any, never, any>
  return { MainTable, Accounts, Added, client }
}
type World = ReturnType<typeof worldOf>

/** One set of values for every key. */
type Values = {
  readonly tenant: string
  readonly n: number
  readonly label: string
  readonly s: number
  readonly region: string
  readonly email: string
  readonly agency: string
}

const PLAIN: Values = {
  tenant: "t1",
  n: 5,
  label: "l1",
  s: 7,
  region: "r1",
  email: "m1",
  agency: "a1",
}

const CHANGED: ReadonlyArray<readonly [string, Values]> = [
  [
    "a space, negative and fractional numbers",
    {
      tenant: "a b",
      n: -3,
      label: "x y",
      s: -2.5,
      region: "r 1",
      email: "e f",
      agency: "c d",
    },
  ],
  [
    "the delimiter and a percent sign",
    {
      tenant: "a#b",
      n: 12.5,
      label: "x#y",
      s: 0.25,
      region: "r#1",
      email: "50%",
      agency: "c#d",
    },
  ],
  [
    "what another value escapes to",
    {
      tenant: "foo%20bar",
      n: -100,
      label: "foo%20bar",
      s: 3.5,
      region: "foo%20bar",
      email: "foo%20bar",
      agency: "foo%20bar",
    },
  ],
]

type Step = readonly [name: string, run: (db: any) => Effect.Effect<unknown, unknown, any>]

/** Every operation that composes a key, in an order where each finds what it needs. */
const stepsOf = (world: World, v: Values): ReadonlyArray<Step> => {
  const key = { tenant: v.tenant, n: v.n, label: v.label, s: v.s }
  const item = { ...key, region: v.region, email: v.email, note: "first" }
  const partition = { tenant: v.tenant, n: v.n }
  const route = { id: v.tenant }
  const doc = { tenant: v.tenant, owner: v.region }
  const log = { tenant: v.email, owner: v.region }
  const account = { tenant: v.tenant }
  const home = { id: v.tenant, region: v.region, agency: v.agency, price: 100, beds: 2 }
  return [
    ["put", (db) => db.entities.Items.put(item).asEffect()],
    ["get", (db) => db.entities.Items.get(key)],
    ["update", (db) => db.entities.Items.update(key).set({ note: "second" }).asEffect()],
    ["patch", (db) => db.entities.Items.patch(key).set({ note: "third" }).asEffect()],
    ["query", (db) => db.entities.Items.primary(partition).collect()],
    [
      "query, one composite pinned",
      (db) => db.entities.Items.primary({ ...partition, label: v.label }).collect(),
    ],
    [
      "query, every composite pinned",
      (db) => db.entities.Items.primary({ ...partition, label: v.label, s: v.s }).collect(),
    ],
    [
      "query, .where",
      (db) =>
        db.entities.Items.primary(partition)
          .where((t: any, ops: any) => ops.gte(t.label, v.label))
          .collect(),
    ],
    [
      "query, .where equal",
      (db) =>
        db.entities.Items.primary(partition)
          .where((t: any, ops: any) => ops.eq(t.label, v.label))
          .collect(),
    ],
    [
      "query, .within",
      (db) =>
        db.entities.Items.primary(partition)
          .within({ s: { gte: v.s } })
          .collect(),
    ],
    ["query, a page", (db) => db.entities.Items.primary(partition).limit(1).fetch()],
    ["count", (db) => db.entities.Items.primary(partition).count()],
    ["an index", (db) => db.entities.Items.byRegion({ region: v.region }).collect()],
    [
      "an index, .where",
      (db) =>
        db.entities.Items.byRegion({ region: v.region })
          .where((t: any, ops: any) => ops.eq(t.label, v.label))
          .collect(),
    ],
    [
      "an index, .within",
      (db) =>
        db.entities.Items.byRegion({ region: v.region })
          .within({ s: { lte: v.s } })
          .collect(),
    ],
    ["a sharded index", (db) => db.entities.Items.byShard({ tenant: v.tenant }).collect()],
    ["versions", (db) => db.entities.Items.versions(key).collect()],
    ["getVersion", (db) => db.entities.Items.getVersion(key, 1)],
    ["delete, soft", (db) => db.entities.Items.delete(key).asEffect()],
    ["deleted.get", (db) => db.entities.Items.deleted.get(key)],
    ["deleted.list", (db) => db.entities.Items.deleted.list(key).collect()],
    ["restore", (db) => db.entities.Items.restore(key)],
    ["purge", (db) => db.entities.Items.purge(key)],
    ["upsert", (db) => db.entities.Items.upsert(item).asEffect()],
    ["deleteIfExists", (db) => db.entities.Items.deleteIfExists(key).asEffect()],
    ["create", (db) => db.entities.Docs.create(doc).asEffect()],
    ["collection member", (db) => db.entities.Logs.put(log).asEffect()],
    ["a collection", (db) => db.collections.owned({ owner: v.region }).collect()],
    ["Batch.get", (db) => Batch.get([db.entities.Docs.get({ tenant: v.tenant })])],
    [
      "Batch.write",
      (db) =>
        Batch.write([
          db.entities.Docs.delete({ tenant: v.tenant }),
          db.entities.Logs.delete({ tenant: v.email }),
        ]),
    ],
    ["transactWrite", (db) => Transaction.transactWrite([db.entities.Docs.put(doc)])],
    ["transactGet", (db) => Transaction.transactGet([db.entities.Docs.get({ tenant: v.tenant })])],
    ["delete, hard", (db) => db.entities.Docs.delete({ tenant: v.tenant }).asEffect()],
    [
      "an append",
      (db) => db.entities.Readings.append({ tenant: v.tenant, at: 1, note: "n" }).asEffect(),
    ],
    [
      "another append",
      (db) => db.entities.Readings.append({ tenant: v.tenant, at: 2, note: "n" }).asEffect(),
    ],
    ["history", (db) => db.entities.Readings.history({ tenant: v.tenant }).collect()],
    [
      "history, .where",
      (db) =>
        db.entities.Readings.history({ tenant: v.tenant })
          .where((t: any, ops: any) => ops.gt(t.at, 1))
          .collect(),
    ],
    ["a Z-order put", (db) => db.entities.Homes.put(home).asEffect()],
    [
      "a Z-order query",
      (db) =>
        db.entities.Homes.byFacets({ region: v.region })
          .within({
            agency: v.agency,
            price: { gte: 50, lte: 200 },
            beds: { gte: 1, lte: 3 },
          })
          .collect(),
    ],
    [
      "a Z-order update",
      (db) => db.entities.Homes.update({ id: v.tenant }).set({ price: 150, beds: 2 }).asEffect(),
    ],
    [
      "aggregate create",
      (db) =>
        db.aggregates.Routes.create({
          id: v.tenant,
          note: "n",
          stops: [{ label: v.label }, { label: "second" }],
        }),
    ],
    ["aggregate get", (db) => db.aggregates.Routes.get(route)],
    [
      "aggregate update",
      (db) =>
        db.aggregates.Routes.update(route, ({ state }: any) => ({ ...state, note: "changed" })),
    ],
    ["aggregate delete", (db) => db.aggregates.Routes.delete(route)],
    ["stream append", () => world.Accounts.append(account, [new world.Added({ value: 1 })], 0)],
    ["stream read", () => world.Accounts.read(account)],
    ["stream readFrom", () => world.Accounts.readFrom(account, 0)],
    ["stream readLatest", () => world.Accounts.readLatest(account)],
    ["stream currentVersion", () => world.Accounts.currentVersion(account)],
    ["stream writeSnapshot", () => world.Accounts.writeSnapshot(account, { total: 1 }, 1)],
    ["stream readSnapshot", () => world.Accounts.readSnapshot(account)],
  ]
}

/** A value reduced to its type, and everything else kept. */
const shapeOf = (value: unknown): unknown => {
  if (value instanceof Uint8Array) return "bytes"
  if (Array.isArray(value)) return value.map(shapeOf)
  if (typeof value !== "object" || value === null) return value
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length === 1 && ["S", "N", "B"].includes(keys[0]!)) return keys[0]
  return Object.fromEntries(keys.map((key) => [key, shapeOf(record[key])]))
}

/** Each step's outcome and requests. */
const captured = (world: World, v: Values) =>
  Effect.gen(function* () {
    const table = makeRecordingTable({
      indexes: {
        ...indexesOf(Table.definition(world.MainTable)),
        // The aggregate's collection index: the aggregate isn't registered on this table, so the
        // table's definition doesn't hold it.
        lsi1: { pk: "pk", sk: "lsi1sk" },
      },
    })
    const steps: Array<{
      readonly step: string
      readonly outcome: string
      readonly requests: ReadonlyArray<Request>
    }> = []
    yield* Effect.gen(function* () {
      const db = yield* world.client
      for (const [step, run] of stepsOf(world, v)) {
        table.take()
        const exit = yield* Effect.exit(Effect.suspend(() => run(db)))
        steps.push({
          step,
          outcome: Exit.isSuccess(exit) ? "ok" : `failed: ${String(exit.cause).slice(0, 300)}`,
          requests: shapeOf(table.take()) as ReadonlyArray<Request>,
        })
      }
    }).pipe(Effect.provide(Layer.merge(table.layer, world.MainTable.layer({ name: "capture" }))))
    return steps
  }) as unknown as Effect.Effect<
    ReadonlyArray<{
      readonly step: string
      readonly outcome: string
      readonly requests: ReadonlyArray<Request>
    }>
  >

describe.each([
  ["escapeKeys: true", true],
  ["escapeKeys: false", false],
])("%s", (_setting, escapeKeys) => {
  const world = worldOf(escapeKeys)

  it.effect("every step of a plain value succeeds and sends a request", () =>
    Effect.gen(function* () {
      for (const { step, outcome, requests } of yield* captured(world, PLAIN)) {
        expect([step, outcome]).toEqual([step, "ok"])
        expect([step, requests.length > 0]).toEqual([step, true])
      }
    }),
  )

  for (const [name, changed] of CHANGED) {
    it.effect(`${name}: the same requests as a plain value`, () =>
      Effect.gen(function* () {
        const plain = yield* captured(world, PLAIN)
        const other = yield* captured(world, changed)
        expect(other.map(({ step }) => step)).toEqual(plain.map(({ step }) => step))
        for (const [i, step] of plain.entries()) {
          expect([step.step, other[i]?.outcome]).toEqual([step.step, step.outcome])
          // Off, a key holding `x#y` reads two ways, so a skip-scan stops probing for the next
          // value and reads the rest as one filtered range. One request fewer, for the same rows.
          if (!escapeKeys && changed.label.includes("#") && step.step === "an index, .within") {
            expect(other[i]!.requests.length).toBeLessThan(step.requests.length)
            continue
          }
          expect(other[i]).toEqual(step)
        }
      }),
    )
  }
})
