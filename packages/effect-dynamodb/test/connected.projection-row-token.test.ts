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
import { Config, Effect, Exit, Layer, Schema } from "effect"
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

/** Run `hook` once, right after the next `GetItem` of the read model's table returns. */
const pending: { hook?: Effect.Effect<unknown, unknown> | undefined } = {}
const HookedClient = Layer.effect(
  DynamoClient,
  Effect.map(Effect.service(DynamoClient), (inner) => ({
    ...inner,
    getItem: (input: Parameters<typeof inner.getItem>[0]) =>
      inner.getItem(input).pipe(
        Effect.tap(() => {
          const hook = pending.hook
          if (input.TableName !== tables.read || hook === undefined) return Effect.void
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
const ReadTable = Table.make({ schema: AppSchema, entities: { Rows } })
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
})
