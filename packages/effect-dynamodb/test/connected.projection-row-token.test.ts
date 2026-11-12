/**
 * The row token (#237) against DynamoDB Local. A row read without a token, on a read model whose
 * rows carry one, was last written by a process still on 1.40.0 (which writes none) or before the
 * token: a projection's write over it names every projection's bookkeeping as it read it, a
 * checkpoint map held natively included, so a write landed since its read fails it and the next
 * attempt lands.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 */

import { it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Config, Effect, Exit, Layer, Option, Schema } from "effect"
import { afterAll, beforeAll, describe, expect } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
import { fromAttributeMap } from "../src/Marshaller.js"
import * as Table from "../src/Table.js"

const ENDPOINT = Effect.runSync(
  Config.String("DYNAMODB_ENDPOINT").pipe(Config.withDefault("http://localhost:8000")),
)

let dynamoAvailable = false
try {
  const res = await fetch(ENDPOINT, { method: "POST", signal: AbortSignal.timeout(1000) }).catch(
    () => null,
  )
  dynamoAvailable = res !== null
} catch {
  dynamoAvailable = false
}
const describeConnected = dynamoAvailable ? describe : describe.skip

const ClientLayer = DynamoClient.layer({
  region: "us-east-1",
  endpoint: ENDPOINT,
  credentials: { accessKeyId: "local", secretAccessKey: "local" },
})
const stamp = Date.now()
const tables = { events: `rt-events-${stamp}`, read: `rt-read-${stamp}` }

/**
 * Run `hook` once, right after the next `GetItem` of the read model's table returns; `each` after
 * every one, while it's set.
 */
const pending: {
  hook?: Effect.Effect<unknown, unknown> | undefined
  // The fiber that reads the row provides what it needs.
  each?: Effect.Effect<unknown, unknown, any> | undefined
} = {}
const HookedClient = Layer.effect(
  DynamoClient,
  Effect.map(Effect.service(DynamoClient), (inner) => ({
    ...inner,
    getItem: (input: Parameters<typeof inner.getItem>[0]) =>
      inner.getItem(input).pipe(
        Effect.tap(() => {
          if (input.TableName !== tables.read) return Effect.void
          if (pending.each !== undefined) {
            return Effect.orDie(pending.each) as Effect.Effect<void>
          }
          const hook = pending.hook
          if (hook === undefined) return Effect.void
          pending.hook = undefined
          return Effect.orDie(hook)
        }),
      ),
  })),
).pipe(Layer.provide(ClientLayer))

class Placed extends Schema.TaggedClass<Placed>()("Placed", { amount: Schema.Number }) {}

const AppSchema = DynamoSchema.make({ name: "rowtoken", version: 1 })
const EventsTable = Table.make({ schema: AppSchema, entities: {} })
const stream = (streamName: string) =>
  EventStore.makeStream({
    table: EventsTable,
    streamName,
    events: [Placed],
    streamId: { composite: ["id"] },
  })
const Orders = stream("Order")
const Invoices = stream("Invoice")
const Row = Schema.Struct({
  id: Schema.String,
  total: Schema.Number,
  a: Schema.optional(Schema.Number),
  ra: Schema.optional(Schema.Number),
  map: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
  rm: Schema.optional(Schema.Number),
})
type Row = typeof Row.Type
const Rows = Entity.make({
  model: Row,
  entityType: "Row",
  primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
})
/** Rows two projections race on: B writes after each of A's reads. */
const Raced = Schema.Struct({
  id: Schema.String,
  total: Schema.Number,
  a: Schema.optional(Schema.Number),
  ra: Schema.optional(Schema.Number),
  b: Schema.optional(Schema.Number),
  rb: Schema.optional(Schema.Number),
})
type Raced = typeof Raced.Type
const Races = Entity.make({
  model: Raced,
  entityType: "Race",
  primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
})
/** Rows whose data B keeps in a set (`tags`) or a map (`m`). */
const Tagged = Schema.Struct({
  id: Schema.String,
  orders: Schema.Number,
  tags: Schema.ReadonlySet(Schema.String),
  m: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
  a: Schema.optional(Schema.Number),
  ra: Schema.optional(Schema.Number),
  b: Schema.optional(Schema.Number),
  rb: Schema.optional(Schema.Number),
})
type Tagged = typeof Tagged.Type
const Tags = Entity.make({
  model: Tagged,
  entityType: "Tagged",
  primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
})
const ReadTable = Table.make({ schema: AppSchema, entities: { Rows, Races, Tags } })
const evolve = (state: Row, event: { readonly data: Placed }) =>
  Effect.succeed({ ...state, total: state.total + event.data.amount })
const A = EventStore.projection({
  stream: Orders,
  readModel: Rows,
  key: (id: { readonly id: string }) => ({ id: id.id }),
  initial: (id: { readonly id: string }): Row => ({ id: id.id, total: 0 }),
  evolve,
  checkpoint: "a",
  revision: "ra",
  retry: 0,
})
const M = EventStore.multiProjection({
  readModel: Rows,
  initial: (key: { readonly id: string }): Row => ({ id: key.id, total: 0 }),
  sources: (source) => ({
    invoice: source(Invoices, { key: (id: { readonly id: string }) => ({ id: id.id }), evolve }),
  }),
  checkpoints: { field: "map" },
  revision: "rm",
  retry: 0,
})

const raced = (from: typeof Orders, checkpoint: "a" | "b", retry?: number) =>
  EventStore.projection({
    stream: from,
    readModel: Races,
    key: (id: { readonly id: string }) => ({ id: id.id }),
    initial: (id: { readonly id: string }): Raced => ({ id: id.id, total: 0 }),
    evolve: (state: Raced, event: { readonly data: Placed }) =>
      Effect.succeed({ ...state, total: state.total + event.data.amount }),
    checkpoint,
    revision: checkpoint === "a" ? "ra" : "rb",
    ...(retry !== undefined && { retry }),
  })
/** A with two retries, A with the default schedule (12), and B, which writes `retry: 0`. */
const RaceA2 = raced(Orders, "a", 2)
const RaceADefault = raced(Orders, "a")
const RaceB = raced(Invoices, "b", 0)

/**
 * A and B over `Tags`. With `"an empty set"`, B adds to the tags and A resets the row to its
 * initial value, the tags an empty set. With `"an empty map key"`, B adds to `m` and A gives `m`
 * an entry whose key is the empty string, which DynamoDB refuses.
 */
const tagged = (outbox: boolean, a: "an empty set" | "an empty map key") => {
  const initial = (id: { readonly id: string }): Tagged => ({
    id: id.id,
    orders: 0,
    tags: new Set<string>(),
  })
  const define = (
    from: typeof Orders,
    checkpoint: "a" | "b",
    evolve: (state: Tagged, event: { readonly data: Placed }) => Tagged,
  ) =>
    EventStore.projection({
      stream: from,
      readModel: Tags,
      key: (id: { readonly id: string }) => ({ id: id.id }),
      initial,
      evolve: (state: Tagged, event: { readonly data: Placed }) =>
        Effect.succeed(evolve(state, event)),
      checkpoint,
      revision: checkpoint === "a" ? "ra" : "rb",
      retry: 0,
      ...(outbox && { outbox: { schema: Schema.Number, effects: () => [1] } }),
    })
  return a === "an empty set"
    ? {
        A: define(Orders, "a", (state, event) => ({
          ...initial({ id: state.id }),
          orders: state.orders + event.data.amount,
        })),
        B: define(Invoices, "b", (state, event) => ({
          ...state,
          tags: new Set([...state.tags, `invoice-${event.data.amount}`]),
        })),
      }
    : {
        A: define(Orders, "a", (state, event) => ({
          ...state,
          orders: state.orders + event.data.amount,
          m: { "": 0 },
        })),
        B: define(Invoices, "b", (state, event) => ({
          ...state,
          m: { ...state.m, x: (state.m?.x ?? 0) + event.data.amount },
        })),
      }
}

const TestLayer = Layer.mergeAll(
  HookedClient,
  EventsTable.layer({ name: tables.events }),
  ReadTable.layer({ name: tables.read }),
)

const withClient = <A, E>(f: (client: DynamoClient["Service"]) => Effect.Effect<A, E>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* f(yield* DynamoClient)
    }).pipe(Effect.provide(ClientLayer)),
  )

const key = { pk: { S: "$rowtoken#v1#row#id_x" }, sk: { S: "$rowtoken#v1#row" } }
const row = Effect.gen(function* () {
  const client = yield* DynamoClient
  const { Item } = yield* client.getItem({ TableName: tables.read, Key: key, ConsistentRead: true })
  return Item === undefined ? undefined : (fromAttributeMap(Item) as Record<string, unknown>)
})
/** The row as a process still on 1.40.0 leaves it: every write it makes drops the token. */
const asWrittenBy140 = Effect.gen(function* () {
  const client = yield* DynamoClient
  yield* client.updateItem({
    TableName: tables.read,
    Key: key,
    UpdateExpression: "REMOVE #t",
    ExpressionAttributeNames: { "#t": "__edd_rt__" },
  })
})

describeConnected("the row token on DynamoDB Local (#237)", () => {
  beforeAll(() =>
    withClient((client) =>
      Effect.forEach(Object.values(tables), (TableName) =>
        client.createTable({
          TableName,
          BillingMode: "PAY_PER_REQUEST",
          KeySchema: [
            { AttributeName: "pk", KeyType: "HASH" },
            { AttributeName: "sk", KeyType: "RANGE" },
          ],
          AttributeDefinitions: [
            { AttributeName: "pk", AttributeType: "S" },
            { AttributeName: "sk", AttributeType: "S" },
          ],
        }),
      ),
    ),
  )
  afterAll(() =>
    withClient((client) =>
      Effect.forEach(Object.values(tables), (TableName) =>
        Effect.ignore(client.deleteTable({ TableName })),
      ),
    ),
  )

  it.effect(
    "a write over a row without a token names the bookkeeping it read, a native map included",
    () =>
      Effect.gen(function* () {
        yield* Orders.append(
          { id: "x" },
          [new Placed({ amount: 1 }), new Placed({ amount: 2 }), new Placed({ amount: 4 })],
          0,
        )
        yield* Invoices.append({ id: "x" }, [new Placed({ amount: 5 })], 0)
        const orders = yield* Orders.read({ id: "x" })
        yield* A.apply(orders[0]!)
        yield* M.applyBatch([{ stream: "invoice", event: (yield* Invoices.read({ id: "x" }))[0]! }])
        expect(yield* row).toMatchObject({ total: 6, a: 1, map: { "invoice#x": 1 }, rm: 1 })
        // Nothing written since its read: the terms, the map's included, hold.
        yield* asWrittenBy140
        yield* A.apply(orders[1]!)
        expect(yield* row).toMatchObject({ total: 8, a: 2, ra: 2, map: { "invoice#x": 1 } })
        expect((yield* row)?.__edd_rt__).toBeDefined()
        // A write landed since its read, changing the map alone: the write fails, naming it.
        yield* asWrittenBy140
        pending.hook = Effect.gen(function* () {
          const client = yield* DynamoClient
          yield* client.updateItem({
            TableName: tables.read,
            Key: key,
            UpdateExpression: "SET #m.#k = :v",
            ExpressionAttributeNames: { "#m": "map", "#k": "invoice#y" },
            ExpressionAttributeValues: { ":v": { N: "1" } },
          })
        }).pipe(Effect.provide(ClientLayer))
        const exit = yield* Effect.exit(A.apply(orders[2]!))
        expect(pending.hook).toBeUndefined()
        expect(Exit.isFailure(exit) && (exit.cause as any).reasons?.[0]?.error).toMatchObject({
          _tag: "ConcurrentModification",
          attributes: ["map"],
        })
        expect(yield* row).toMatchObject({ total: 8, map: { "invoice#x": 1, "invoice#y": 1 } })
        // The next attempt lands, keeping it.
        yield* A.apply(orders[2]!)
        expect(yield* row).toMatchObject({
          total: 12,
          a: 3,
          map: { "invoice#x": 1, "invoice#y": 1 },
        })
      }).pipe(Effect.provide(TestLayer)),
  )

  // Live: the default schedule waits between retries, and `it.effect`'s test clock never moves.
  it.live.each([
    ["two retries", 2],
    ["the default schedule", 12],
  ] as const)(
    "A losing every race (%s): retries re-read the row, then the caller sees ConcurrentModification",
    ([, retries]) => {
      const A = retries === 2 ? RaceA2 : RaceADefault
      const id = `race-${retries}`
      const raceKey = { pk: { S: `$rowtoken#v1#race#id_${id}` }, sk: { S: "$rowtoken#v1#race" } }
      return Effect.gen(function* () {
        yield* Orders.append({ id }, [new Placed({ amount: 1 })], 0)
        yield* Invoices.append(
          { id },
          Array.from({ length: retries + 2 }, (_, i) => new Placed({ amount: 10 * (i + 1) })),
          0,
        )
        const invoices = yield* Invoices.read({ id })
        // B writes first, so the row carries the token.
        yield* RaceB.apply(invoices[0]!)
        // Then B writes once more after each of A's reads: every write A makes has lost.
        let next = 1
        let reads = 0
        let racing = false
        // B's own read of the row comes through here too: it doesn't race itself.
        pending.each = Effect.gen(function* () {
          if (racing) return
          reads++
          racing = true
          yield* RaceB.apply(invoices[next++]!).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                racing = false
              }),
            ),
          )
        })
        const exit = yield* Effect.exit(A.apply((yield* Orders.read({ id }))[0]!)).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              pending.each = undefined
            }),
          ),
        )
        // One read per attempt: the first, then one per retry.
        expect(reads).toBe(retries + 1)
        const error = Exit.isFailure(exit) ? (exit.cause as any).reasons?.[0]?.error : undefined
        expect(error).toMatchObject({
          _tag: "ConcurrentModification",
          entityType: "Race",
          key: { id },
        })
        // The write was conditioned on the token it read: the token is what changed.
        expect(error.attributes).toEqual(["__edd_rt__"])
        // As on 1.40.0, a projection's carries no row: the next read is the retry's.
        expect(Option.isNone(error.current)).toBe(true)
        const client = yield* DynamoClient
        const { Item } = yield* client.getItem({
          TableName: tables.read,
          Key: raceKey,
          ConsistentRead: true,
        })
        const stored = fromAttributeMap(Item!) as Record<string, unknown>
        // Every one of B's writes landed, and none of A's.
        expect(stored).toMatchObject({ b: retries + 2, rb: retries + 2 })
        expect(stored.a).toBeUndefined()
        expect(stored.total).toBe(
          Array.from({ length: retries + 2 }, (_, i) => 10 * (i + 1)).reduce((x, y) => x + y, 0),
        )
        // The race over, A's next attempt lands.
        yield* A.apply((yield* Orders.read({ id }))[0]!)
        const { Item: after } = yield* client.getItem({
          TableName: tables.read,
          Key: raceKey,
          ConsistentRead: true,
        })
        expect(fromAttributeMap(after!)).toMatchObject({ a: 1, b: retries + 2 })
      }).pipe(Effect.provide(TestLayer))
    },
  )

  const taggedRow = (id: string) => {
    const taggedKey = {
      pk: { S: `$rowtoken#v1#tagged#id_${id}` },
      sk: { S: "$rowtoken#v1#tagged" },
    }
    return Effect.gen(function* () {
      const client = yield* DynamoClient
      const { Item } = yield* client.getItem({
        TableName: tables.read,
        Key: taggedKey,
        ConsistentRead: true,
      })
      return Item!
    })
  }

  it.effect.each([
    ["standalone", false],
    ["in the outbox's transaction", true],
  ] as const)(
    "a write that empties a set stores no attribute, so the other's bookkeeping goes with it (%s)",
    ([, outbox]) => {
      const { A, B } = tagged(outbox, "an empty set")
      const id = `set-${outbox ? "outbox" : "standalone"}`
      const stored = taggedRow(id)
      return Effect.gen(function* () {
        yield* Orders.append({ id }, [new Placed({ amount: 1 })], 0)
        yield* Invoices.append({ id }, [new Placed({ amount: 5 }), new Placed({ amount: 7 })], 0)
        const invoices = yield* Invoices.read({ id })
        yield* B.apply(invoices[0]!)
        expect((yield* stored).tags).toEqual({ SS: ["invoice-5"] })
        // A resets the tags to an empty set: DynamoDB has none, so the attribute is gone, and
        // B's checkpoint and revision with it, as on 1.40.0.
        yield* A.apply((yield* Orders.read({ id }))[0]!)
        const afterA = yield* stored
        expect(afterA.tags).toBeUndefined()
        expect(afterA.b).toBeUndefined()
        expect(afterA.rb).toBeUndefined()
        expect(afterA).toMatchObject({ a: { N: "1" }, ra: { N: "1" } })
        // B's redelivered event applies again, and its next one: its tags come back whole.
        expect((yield* B.apply(invoices[0]!)).applied).toHaveLength(1)
        yield* B.apply(invoices[1]!)
        const final = yield* stored
        expect([...(final.tags?.SS ?? [])].sort()).toEqual(["invoice-5", "invoice-7"])
        expect(final).toMatchObject({ b: { N: "2" }, rb: { N: "2" } })
      }).pipe(Effect.provide(TestLayer))
    },
  )

  it.effect.each([
    ["standalone", false],
    ["in the outbox's transaction", true],
  ] as const)(
    "a write giving a map an empty key is refused by DynamoDB, as on 1.40.0, and writes nothing (%s)",
    ([, outbox]) => {
      const { A, B } = tagged(outbox, "an empty map key")
      const id = `key-${outbox ? "outbox" : "standalone"}`
      const stored = taggedRow(id)
      return Effect.gen(function* () {
        yield* Orders.append({ id }, [new Placed({ amount: 1 })], 0)
        yield* Invoices.append({ id }, [new Placed({ amount: 5 }), new Placed({ amount: 7 })], 0)
        const invoices = yield* Invoices.read({ id })
        yield* B.apply(invoices[0]!)
        const afterB = yield* stored
        // The marshaller stores the entry, and DynamoDB refuses the write ("Empty attribute name").
        const exit = yield* Effect.exit(A.apply((yield* Orders.read({ id }))[0]!))
        expect(Exit.isFailure(exit) && (exit.cause as any).reasons?.[0]?.error?._tag).toBe(
          "DynamoValidationError",
        )
        expect(String(Exit.isFailure(exit) && exit.cause)).toContain("Empty attribute name")
        expect(yield* stored).toEqual(afterB)
        // B's bookkeeping is the row's own: its redelivery is recognised, its next event applies.
        expect((yield* B.apply(invoices[0]!)).alreadyApplied).toHaveLength(1)
        yield* B.apply(invoices[1]!)
        expect(yield* stored).toMatchObject({ m: { M: { x: { N: "12" } } }, b: { N: "2" } })
      }).pipe(Effect.provide(TestLayer))
    },
  )
})
