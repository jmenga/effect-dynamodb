/**
 * Consumed-capacity reporting (#174) — unit tests against mocked clients.
 *
 * See `docs/designs/consumed-capacity.md` §11.2 for the plan these follow.
 */

import { describe, expect, expectTypeOf, it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { DynamoError } from "@effect-dynamodb/schema/Errors.js"
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Logger,
  Schema,
  Stream,
  type Tracer,
} from "effect"
import { TestClock } from "effect/testing"
import { beforeEach } from "vitest"
import * as Aggregate from "../src/Aggregate.js"
import * as Batch from "../src/Batch.js"
import * as ConsumedCapacity from "../src/ConsumedCapacity.js"
import { DynamoClient, type DynamoClientService } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
import * as Capacity from "../src/internal/Capacity.js"
import * as Query from "../src/Query.js"
import * as Table from "../src/Table.js"
import * as Transaction from "../src/Transaction.js"
import * as VectorSearchEmulation from "../src/VectorSearchEmulation.js"
import {
  clientLayer,
  collectReports,
  DATA_PLANE,
  parentName,
  recordingTracer,
  serviceOf,
  withConsumedCapacity,
} from "./helpers/CapacityMock.js"
import { InMemoryClient, resetStore } from "./helpers/InMemoryTables.js"
import { mockDynamoClient } from "./helpers/MockDynamoClient.js"

// ---------------------------------------------------------------------------
// Fixtures — orders and accounts
// ---------------------------------------------------------------------------

const AppSchema = DynamoSchema.make({ name: "shop", version: 1 })

class Order extends Schema.Class<Order>("Order")({
  orderId: Schema.String,
  customerId: Schema.String,
  status: Schema.String,
  total: Schema.Number,
}) {}

const Orders = Entity.make({
  model: Order,
  entityType: "Order",
  primaryKey: {
    pk: { field: "pk", composite: ["orderId"] },
    sk: { field: "sk", composite: [] },
  },
  indexes: {
    byCustomer: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["customerId"] },
      sk: { field: "gsi1sk", composite: ["orderId"] },
    },
  },
})

class Account extends Schema.Class<Account>("Account")({
  accountId: Schema.String,
  email: Schema.String,
  balance: Schema.Number,
}) {}

const Accounts = Entity.make({
  model: Account,
  entityType: "Account",
  primaryKey: {
    pk: { field: "pk", composite: ["accountId"] },
    sk: { field: "sk", composite: [] },
  },
  unique: { email: ["email"] },
  versioned: true,
})

const MainTable = Table.make({ schema: AppSchema, entities: { Orders, Accounts } })
const TableLayer = MainTable.layer({ name: "shop-table" })

class Deposited extends Schema.Class<Deposited>("Deposited")({ amount: Schema.Number }) {}

const Ledgers = EventStore.makeStream({
  table: MainTable,
  streamName: "Ledger",
  events: [Deposited],
  streamId: { composite: ["ledgerId"] },
})

const ledgerDecider: EventStore.Decider<{ readonly balance: number }, number, Deposited, never> = {
  initialState: { balance: 0 },
  decide: (amount) => Effect.succeed([new Deposited({ amount })]),
  evolve: (state, event) => ({ balance: state.balance + event.amount }),
}

class OrderLine extends Schema.Class<OrderLine>("OrderLine")({
  lineId: Schema.String,
  sku: Schema.String,
  quantity: Schema.Number,
}) {}

class PurchaseOrder extends Schema.Class<PurchaseOrder>("PurchaseOrder")({
  purchaseOrderId: Schema.String,
  note: Schema.String,
  lines: Schema.Array(OrderLine),
}) {}

const PurchaseOrders = Aggregate.make(PurchaseOrder, {
  table: MainTable,
  schema: AppSchema,
  pk: { field: "pk", composite: ["purchaseOrderId"] },
  collection: { index: "lsi1", name: "purchaseOrder", sk: { field: "lsi1sk", composite: [] } },
  root: { entityType: "PurchaseOrderItem" },
  edges: {
    lines: Aggregate.many("lines", {
      entityType: "PurchaseOrderLine",
      sk: { composite: ["lineId"] },
    }),
  },
})

/** A minimal key-value client for aggregates: get, put, query by pk, transact writes. */
const aggregateStore = () => {
  const items = new Map<string, Record<string, any>>()
  const keyOf = (item: Record<string, any>) => `${item.pk?.S}|${item.sk?.S}`
  return mockDynamoClient({
    getItem: (input) => Effect.sync(() => ({ Item: items.get(keyOf(input.Key!)) }) as never),
    putItem: (input) =>
      Effect.sync(() => {
        items.set(keyOf(input.Item!), input.Item!)
        return {} as never
      }),
    query: (input) =>
      Effect.sync(() => {
        const pk = (input.ExpressionAttributeValues?.[":pk"] as { S?: string } | undefined)?.S
        return { Items: [...items.values()].filter((item) => item.pk?.S === pk) } as never
      }),
    transactWriteItems: (input) =>
      Effect.sync(() => {
        for (const op of (input.TransactItems ?? []) as Array<Record<string, any>>) {
          if (op.Put) items.set(keyOf(op.Put.Item), op.Put.Item)
          if (op.Delete) items.delete(keyOf(op.Delete.Key))
        }
        return {} as never
      }),
  })
}

const order = (n: number, customerId = "c-1") => ({
  orderId: `o-${n}`,
  customerId,
  status: "open",
  total: n,
})

const marshalledOrder = (n: number, customerId = "c-1") => ({
  pk: { S: `$shop#v1#order#o-${n}` },
  sk: { S: "$shop#v1#order" },
  gsi1pk: { S: `$shop#v1#order#${customerId}` },
  gsi1sk: { S: `$shop#v1#order#o-${n}` },
  __edd_e__: { S: "Order" },
  orderId: { S: `o-${n}` },
  customerId: { S: customerId },
  status: { S: "open" },
  total: { N: String(n) },
})

/** An in-memory client answering with consumed capacity. */
const inMemory = (options?: Parameters<typeof withConsumedCapacity>[1]) =>
  withConsumedCapacity(serviceOf(InMemoryClient), options)

/** A client whose `query` answers the given pages in turn (LastEvaluatedKey between them). */
const pagedQuery = (pages: ReadonlyArray<ReadonlyArray<Record<string, any>>>, failOn?: number) => {
  let call = 0
  return mockDynamoClient({
    query: () =>
      Effect.suspend(() => {
        const index = call++
        if (failOn !== undefined && index === failOn) {
          return Effect.fail(new DynamoError({ operation: "Query", cause: new Error("boom") }))
        }
        const page = pages[index % pages.length] ?? []
        const last = index % pages.length < pages.length - 1
        return Effect.succeed({
          Items: page as never,
          Count: page.length,
          ...(last && { LastEvaluatedKey: { pk: { S: `cursor-${index}` }, sk: { S: "x" } } }),
        } as never)
      }),
  })
}

beforeEach(() => resetStore())

const enabled = (options?: ConsumedCapacity.Options) =>
  Layer.mergeAll(TableLayer, ConsumedCapacity.layer(options))

// ---------------------------------------------------------------------------
// 1. Off by default
// ---------------------------------------------------------------------------

describe("off by default", () => {
  it.effect("sends no ReturnConsumedCapacity and passes the very input object", () =>
    Effect.gen(function* () {
      const { service, sent } = inMemory()
      const tracer = recordingTracer()
      yield* Effect.gen(function* () {
        yield* Orders.put(order(1))
        yield* Orders.get({ orderId: "o-1" })
        yield* Query.collect(Orders.query.byCustomer({ customerId: "c-1" }))
      }).pipe(Effect.provide(Layer.mergeAll(clientLayer(service), TableLayer, tracer.layer)))
      expect(sent.length).toBe(3)
      for (const { input } of sent)
        expect(Object.hasOwn(input, "ReturnConsumedCapacity")).toBe(false)
      expect(tracer.named()).toEqual([])

      // Identity of input and output through the instrumented view.
      const input = { TableName: "t", Key: { pk: { S: "a" } } }
      const output = { Item: { pk: { S: "a" } } }
      let received: unknown
      const raw = mockDynamoClient({
        getItem: (i) => {
          received = i
          return Effect.succeed(output as never)
        },
      })
      const result = yield* Capacity.instrument(raw).getItem(input)
      expect(received).toBe(input)
      expect(result).toBe(output)
    }),
  )

  it.effect("ConsumedCapacity.disabled switches a subtree off", () =>
    Effect.gen(function* () {
      const { service, sent } = inMemory()
      const { reports, onOperation } = collectReports()
      yield* Orders.put(order(1))
        .asEffect()
        .pipe(
          Effect.provide(ConsumedCapacity.disabled),
          Effect.provide(Layer.mergeAll(clientLayer(service), enabled({ onOperation }))),
        )
      expect(Object.hasOwn(sent[0]!.input, "ReturnConsumedCapacity")).toBe(false)
      expect(reports).toEqual([])
    }),
  )
})

// ---------------------------------------------------------------------------
// 2. The request flag
// ---------------------------------------------------------------------------

describe("request flag", () => {
  const echo = () => {
    const seen: Array<{ method: string; input: any }> = []
    const overrides: Partial<Record<keyof DynamoClientService, unknown>> = {}
    for (const [method] of DATA_PLANE)
      overrides[method] = (input: any) => {
        seen.push({ method, input })
        return Effect.succeed({})
      }
    overrides.createTable = (input: any) => {
      seen.push({ method: "createTable", input })
      return Effect.succeed({})
    }
    return { service: mockDynamoClient(overrides as Partial<DynamoClientService>), seen }
  }

  for (const [level, flag] of [
    ["total", "TOTAL"],
    ["indexes", "INDEXES"],
  ] as const) {
    it.effect(`level "${level}" sends ${flag} on every data-plane command`, () =>
      Effect.gen(function* () {
        const { service, seen } = echo()
        const client = Capacity.instrument(service) as unknown as Record<
          string,
          (input: unknown) => Effect.Effect<unknown>
        >
        yield* Effect.gen(function* () {
          for (const [method] of DATA_PLANE) yield* client[method]!({ TableName: "t" })
          const createInput = { TableName: "t" }
          yield* client.createTable!(createInput)
          expect(seen.at(-1)!.input).toBe(createInput)
        }).pipe(
          ConsumedCapacity.withOperation("test"),
          Effect.provide(ConsumedCapacity.layer({ level })),
        )
        expect(seen).toHaveLength(DATA_PLANE.length + 1)
        for (const { method, input } of seen.slice(0, DATA_PLANE.length)) {
          expect([method, input.ReturnConsumedCapacity]).toEqual([method, flag])
        }
        expect(Object.hasOwn(seen.at(-1)!.input, "ReturnConsumedCapacity")).toBe(false)
      }),
    )
  }

  it.effect("keeps an explicit caller value", () =>
    Effect.gen(function* () {
      const { service, seen } = echo()
      yield* Capacity.instrument(service)
        .getItem({ TableName: "t", Key: {}, ReturnConsumedCapacity: "NONE" })
        .pipe(Effect.provide(ConsumedCapacity.layer({ level: "indexes" })))
      expect(seen[0]!.input.ReturnConsumedCapacity).toBe("NONE")
    }),
  )
})

// ---------------------------------------------------------------------------
// 3. Summing
// ---------------------------------------------------------------------------

describe("summing", () => {
  const answering = (capacity: unknown) =>
    mockDynamoClient(
      Object.fromEntries(
        DATA_PLANE.map(([method]) => [
          method,
          () => Effect.succeed({ ConsumedCapacity: capacity } as never),
        ]),
      ) as Partial<DynamoClientService>,
    )

  const runWith = <A, E>(
    capacity: unknown,
    body: (client: DynamoClientService) => Effect.Effect<A, E>,
    options?: ConsumedCapacity.Options,
  ) =>
    Effect.gen(function* () {
      const { reports, onOperation } = collectReports()
      yield* body(Capacity.instrument(answering(capacity))).pipe(
        ConsumedCapacity.withOperation("test", { target: "T" }),
        Effect.provide(ConsumedCapacity.layer({ ...options, onOperation })),
      )
      expect(reports).toHaveLength(1)
      return reports[0]!
    })

  it.effect("a single object, split by command kind", () =>
    Effect.gen(function* () {
      const report = yield* runWith({ TableName: "a", CapacityUnits: 3 }, (c) =>
        Effect.gen(function* () {
          yield* c.getItem({ TableName: "a", Key: {} })
          yield* c.putItem({ TableName: "a", Item: {} })
        }),
      )
      expect(report).toMatchObject({
        operation: "test",
        target: "T",
        capacityUnits: 6,
        readCapacityUnits: 3,
        writeCapacityUnits: 3,
        requests: 2,
        unreportedRequests: 0,
        tables: ["a"],
        requestsByCommand: { GetItem: 1, PutItem: 1 },
        outcome: "success",
      })
    }),
  )

  it.effect("arrays across two tables (batch and transaction)", () =>
    Effect.gen(function* () {
      const report = yield* runWith(
        [
          { TableName: "b", CapacityUnits: 2 },
          { TableName: "a", CapacityUnits: 4 },
        ],
        (c) =>
          c.transactWriteItems({
            TransactItems: [
              { Put: { TableName: "a", Item: {} } },
              { Delete: { TableName: "b", Key: {} } },
            ],
          }),
      )
      expect(report.tables).toEqual(["a", "b"])
      expect(report.capacityUnits).toBe(6)
      expect(report.writeCapacityUnits).toBe(6)
      expect(report.byTable.map((t) => [t.tableName, t.capacityUnits, t.requests])).toEqual([
        ["a", 4, 1],
        ["b", 2, 1],
      ])
    }),
  )

  it.effect("an explicit read / write split wins over the command kind", () =>
    Effect.gen(function* () {
      const report = yield* runWith(
        { TableName: "a", ReadCapacityUnits: 1, WriteCapacityUnits: 2 },
        (c) => c.updateItem({ TableName: "a", Key: {} }),
      )
      expect(report).toMatchObject({
        capacityUnits: 3,
        readCapacityUnits: 1,
        writeCapacityUnits: 2,
      })
    }),
  )

  it.effect("the INDEXES breakdown is summed per table and per index", () =>
    Effect.gen(function* () {
      const report = yield* runWith(
        {
          TableName: "a",
          CapacityUnits: 6,
          Table: { CapacityUnits: 3 },
          GlobalSecondaryIndexes: { gsi1: { CapacityUnits: 3 } },
          LocalSecondaryIndexes: { lsi1: { CapacityUnits: 1 } },
        },
        (c) =>
          Effect.gen(function* () {
            yield* c.putItem({ TableName: "a", Item: {} })
            yield* c.putItem({ TableName: "a", Item: {} })
          }),
        { level: "indexes" },
      )
      expect(report.byTable).toEqual([
        {
          tableName: "a",
          capacityUnits: 12,
          readCapacityUnits: 0,
          writeCapacityUnits: 12,
          requests: 2,
          unreportedRequests: 0,
          table: { capacityUnits: 6, readCapacityUnits: 0, writeCapacityUnits: 6 },
          globalSecondaryIndexes: {
            gsi1: { capacityUnits: 6, readCapacityUnits: 0, writeCapacityUnits: 6 },
          },
          localSecondaryIndexes: {
            lsi1: { capacityUnits: 2, readCapacityUnits: 0, writeCapacityUnits: 2 },
          },
        },
      ])
    }),
  )

  it.effect("vector bytes: search bytes and write bytes", () =>
    Effect.gen(function* () {
      const searched = yield* runWith({ VectorSearchRequestBytes: 400 }, (c) =>
        c.searchVectors({ TableName: "a", IndexName: "v", SearchVector: [], TopK: 1 }),
      )
      expect(searched).toMatchObject({
        vectorSearchRequestBytes: 400,
        requests: 1,
        unreportedRequests: 0,
        capacityUnits: 0,
        requestsByCommand: { SearchVectors: 1 },
      })
      const written = yield* runWith(
        { TableName: "a", CapacityUnits: 1, VectorIndexes: { v: { VectorWriteRequestBytes: 64 } } },
        (c) => c.putItem({ TableName: "a", Item: {} }),
      )
      expect(written.vectorWriteRequestBytes).toBe(64)
    }),
  )

  it.effect("a response without capacity counts as unreported", () =>
    Effect.gen(function* () {
      const report = yield* runWith(undefined, (c) => c.getItem({ TableName: "a", Key: {} }))
      expect(report).toMatchObject({ requests: 1, unreportedRequests: 1, capacityUnits: 0 })
      expect(report.byTable[0]).toMatchObject({ tableName: "a", unreportedRequests: 1 })
    }),
  )
})

// ---------------------------------------------------------------------------
// 4. Pagination
// ---------------------------------------------------------------------------

describe("pagination", () => {
  const threePages = [
    [marshalledOrder(1), marshalledOrder(2)],
    [marshalledOrder(3)],
    [marshalledOrder(4)],
  ]

  it.effect("a 3-page Entity.query collect reports 3 requests", () =>
    Effect.gen(function* () {
      const { service } = withConsumedCapacity(pagedQuery(threePages))
      const { reports, onOperation } = collectReports()
      const items = yield* Effect.gen(function* () {
        const db = yield* DynamoClient.make({ entities: { Orders } })
        return yield* db.entities.Orders.byCustomer({ customerId: "c-1" }).collect()
      }).pipe(Effect.provide(Layer.mergeAll(clientLayer(service), enabled({ onOperation }))))
      expect(items).toHaveLength(4)
      expect(reports).toHaveLength(1)
      expect(reports[0]).toMatchObject({
        operation: "Entity.query",
        target: "Order",
        index: "byCustomer",
        requests: 3,
        requestsByCommand: { Query: 3 },
        capacityUnits: 1.5,
        readCapacityUnits: 1.5,
        tables: ["shop-table"],
        nested: [],
      })
    }),
  )

  it.effect("fetch() without limit is one request; with limit and a filter it crosses pages", () =>
    Effect.gen(function* () {
      const { service } = withConsumedCapacity(pagedQuery(threePages))
      const { reports, onOperation } = collectReports()
      yield* Effect.gen(function* () {
        const db = yield* DynamoClient.make({ entities: { Orders } })
        yield* db.entities.Orders.byCustomer({ customerId: "c-1" }).fetch()
        yield* db.entities.Orders.byCustomer({ customerId: "c-1" })
          .filter({ status: "open" })
          .limit(3)
          .fetch()
      }).pipe(Effect.provide(Layer.mergeAll(clientLayer(service), enabled({ onOperation }))))
      expect(reports.map((r) => r.requests)).toEqual([1, 2])
    }),
  )

  it.effect("paginate() stopped after one page reports that page once, as a success", () =>
    Effect.gen(function* () {
      const { service } = withConsumedCapacity(pagedQuery(threePages))
      const { reports, onOperation } = collectReports()
      yield* Effect.gen(function* () {
        const db = yield* DynamoClient.make({ entities: { Orders } })
        const taken = yield* db.entities.Orders.byCustomer({ customerId: "c-1" })
          .paginate()
          .pipe(Stream.take(1), Stream.runCollect)
        expect(taken).toHaveLength(1)
      }).pipe(Effect.provide(Layer.mergeAll(clientLayer(service), enabled({ onOperation }))))
      expect(reports).toHaveLength(1)
      expect(reports[0]).toMatchObject({
        operation: "Entity.query",
        requests: 1,
        outcome: "success",
      })
    }),
  )

  it.effect("a stream failing on page 2 reports a failure with 2 requests", () =>
    Effect.gen(function* () {
      const { service } = withConsumedCapacity(pagedQuery(threePages, 1))
      const { reports, onOperation } = collectReports()
      const exit = yield* Effect.gen(function* () {
        const db = yield* DynamoClient.make({ entities: { Orders } })
        return yield* db.entities.Orders.byCustomer({ customerId: "c-1" })
          .paginate()
          .pipe(Stream.runCollect)
      }).pipe(
        Effect.provide(Layer.mergeAll(clientLayer(service), enabled({ onOperation }))),
        Effect.exit,
      )
      expect(Exit.isFailure(exit)).toBe(true)
      expect(reports).toHaveLength(1)
      expect(reports[0]).toMatchObject({ outcome: "failure", requests: 2, unreportedRequests: 1 })
    }),
  )

  it.effect("running the same stream twice gives two reports", () =>
    Effect.gen(function* () {
      const { service } = withConsumedCapacity(pagedQuery(threePages))
      const { reports, onOperation } = collectReports()
      yield* Effect.gen(function* () {
        const db = yield* DynamoClient.make({ entities: { Orders } })
        const stream = db.entities.Orders.byCustomer({ customerId: "c-1" }).paginate()
        yield* Stream.runCollect(stream)
        yield* Stream.runCollect(stream)
      }).pipe(Effect.provide(Layer.mergeAll(clientLayer(service), enabled({ onOperation }))))
      expect(reports.map((r) => [r.operation, r.requests])).toEqual([
        ["Entity.query", 3],
        ["Entity.query", 3],
      ])
    }),
  )

  it.effect("count() sums its pages", () =>
    Effect.gen(function* () {
      const { service } = withConsumedCapacity(pagedQuery(threePages))
      const { reports, onOperation } = collectReports()
      yield* Effect.gen(function* () {
        const db = yield* DynamoClient.make({ entities: { Orders } })
        yield* db.entities.Orders.byCustomer({ customerId: "c-1" }).count()
      }).pipe(Effect.provide(Layer.mergeAll(clientLayer(service), enabled({ onOperation }))))
      expect(reports[0]).toMatchObject({ operation: "Entity.query", requests: 3 })
    }),
  )
})

// ---------------------------------------------------------------------------
// 5. Batch retries and chunks
// ---------------------------------------------------------------------------

describe("batch", () => {
  it.effect("unprocessed items on the first response: 2 requests, both summed", () =>
    Effect.gen(function* () {
      let call = 0
      const raw = mockDynamoClient({
        batchWriteItem: (input) =>
          Effect.sync(() => {
            const first = call++ === 0
            const [table, requests] = Object.entries(input.RequestItems ?? {})[0]!
            return {
              UnprocessedItems: first ? { [table]: requests.slice(0, 1) } : {},
            } as never
          }),
      })
      const { service } = withConsumedCapacity(raw, {
        capacity: (_command, input) =>
          Object.entries(input.RequestItems ?? {}).map(([TableName, reqs]) => ({
            TableName,
            CapacityUnits: (reqs as Array<unknown>).length,
          })),
      })
      const { reports, onOperation } = collectReports()
      const fiber = yield* Batch.write([Orders.put(order(1)), Orders.put(order(2))]).pipe(
        Effect.provide(Layer.mergeAll(clientLayer(service), enabled({ onOperation }))),
        Effect.forkChild,
      )
      yield* TestClock.adjust("10 seconds")
      yield* Fiber.join(fiber)
      expect(reports).toHaveLength(1)
      expect(reports[0]).toMatchObject({
        operation: "Batch.write",
        requests: 2,
        requestsByCommand: { BatchWriteItem: 2 },
        capacityUnits: 3,
        writeCapacityUnits: 3,
      })
    }),
  )

  it.effect("gets over 100 are counted per chunk", () =>
    Effect.gen(function* () {
      const raw = mockDynamoClient({
        batchGetItem: () => Effect.succeed({ Responses: {}, UnprocessedKeys: {} } as never),
      })
      const { service } = withConsumedCapacity(raw)
      const { reports, onOperation } = collectReports()
      yield* Batch.get(
        Array.from({ length: 150 }, (_, i) => Orders.get({ orderId: `o-${i}` })),
      ).pipe(Effect.provide(Layer.mergeAll(clientLayer(service), enabled({ onOperation }))))
      expect(reports[0]).toMatchObject({
        operation: "Batch.get",
        requests: 2,
        requestsByCommand: { BatchGetItem: 2 },
        capacityUnits: 1,
        readCapacityUnits: 1,
      })
    }),
  )

  it.effect("writes over 25 are counted per chunk", () =>
    Effect.gen(function* () {
      const raw = mockDynamoClient({
        batchWriteItem: () => Effect.succeed({ UnprocessedItems: {} } as never),
      })
      const { service } = withConsumedCapacity(raw)
      const { reports, onOperation } = collectReports()
      yield* Batch.write(Array.from({ length: 30 }, (_, i) => Orders.put(order(i)))).pipe(
        Effect.provide(Layer.mergeAll(clientLayer(service), enabled({ onOperation }))),
      )
      expect(reports[0]).toMatchObject({ operation: "Batch.write", requests: 2, capacityUnits: 2 })
    }),
  )
})

// ---------------------------------------------------------------------------
// 6. Errors
// ---------------------------------------------------------------------------

describe("errors", () => {
  const ccf = () =>
    new DynamoError({
      operation: "PutItem",
      cause: Object.assign(new Error("The conditional request failed"), {
        name: "ConditionalCheckFailedException",
      }),
    })

  it.effect(
    "a create failing ConditionalCheckFailed: failure, 1 unreported request, error span",
    () =>
      Effect.gen(function* () {
        const raw = mockDynamoClient({ putItem: () => Effect.fail(ccf()) })
        const { service } = withConsumedCapacity(raw)
        const { reports, onOperation } = collectReports()
        const tracer = recordingTracer()
        const exit = yield* Orders.create(order(1))
          .asEffect()
          .pipe(
            Effect.provide(
              Layer.mergeAll(clientLayer(service), enabled({ onOperation }), tracer.layer),
            ),
            Effect.exit,
          )
        expect(Exit.isFailure(exit)).toBe(true)
        expect(reports).toHaveLength(1)
        expect(reports[0]).toMatchObject({
          operation: "Entity.create",
          outcome: "failure",
          requests: 1,
          unreportedRequests: 1,
          capacityUnits: 0,
        })
        const span = tracer.named().find((s) => s.name === "effect-dynamodb.Entity.create")!
        expect(span.status._tag).toBe("Ended")
        expect(span.status._tag === "Ended" && Exit.isFailure(span.status.exit)).toBe(true)
        expect(span.attributes.get(ConsumedCapacity.Attributes.total)).toBe(0)
        expect(span.attributes.get(ConsumedCapacity.Attributes.unreportedRequests)).toBe(1)
      }),
  )

  it.effect("a failure whose cause carries ConsumedCapacity is counted", () =>
    Effect.gen(function* () {
      const raw = mockDynamoClient({
        putItem: () =>
          Effect.fail(
            new DynamoError({
              operation: "PutItem",
              cause: Object.assign(new Error("throttled"), {
                name: "SomeError",
                ConsumedCapacity: { TableName: "shop-table", CapacityUnits: 2 },
              }),
            }),
          ),
      })
      const { reports, onOperation } = collectReports()
      yield* Orders.put(order(1))
        .asEffect()
        .pipe(
          Effect.provide(Layer.mergeAll(clientLayer(raw), enabled({ onOperation }))),
          Effect.exit,
        )
      expect(reports[0]).toMatchObject({
        outcome: "failure",
        requests: 1,
        unreportedRequests: 0,
        capacityUnits: 2,
      })
    }),
  )

  it.effect(
    "a recovered op (CCF, then a diagnostic get) succeeds with 2 requests, 1 unreported",
    () =>
      Effect.gen(function* () {
        const { service: stored } = inMemory()
        const raw: DynamoClientService = { ...stored, putItem: () => Effect.fail(ccf()) }
        const { reports, onOperation } = collectReports()
        const found = yield* Orders.create(order(1))
          .asEffect()
          .pipe(
            Effect.catchTag("ConditionalCheckFailed", () =>
              Orders.get({ orderId: "o-1" }).asEffect().pipe(Effect.option),
            ),
            ConsumedCapacity.withOperation("createOrFind"),
            Effect.provide(Layer.mergeAll(clientLayer(raw), enabled({ onOperation }))),
          )
        expect(found).toBeDefined()
        expect(reports).toHaveLength(1)
        expect(reports[0]).toMatchObject({
          operation: "createOrFind",
          outcome: "success",
          requests: 2,
          unreportedRequests: 1,
          requestsByCommand: { PutItem: 1, GetItem: 1 },
        })
        expect(reports[0]!.nested.map((n) => n.operation)).toEqual(["Entity.create", "Entity.get"])
      }),
  )

  it.effect("a transaction plan's recorded write is not a request", () =>
    Effect.gen(function* () {
      // The update reads the row (real GetItem), plans its UpdateItem (recorded,
      // not sent), and the transaction sends one TransactWriteItems.
      const raw = mockDynamoClient({
        getItem: () =>
          Effect.succeed({
            Item: {
              pk: { S: "$shop#v1#account#a-1" },
              sk: { S: "$shop#v1#account" },
              __edd_e__: { S: "Account" },
              accountId: { S: "a-1" },
              email: { S: "a@example.com" },
              balance: { N: "1" },
              version: { N: "1" },
              createdAt: { S: "2026-01-01T00:00:00.000Z" },
              updatedAt: { S: "2026-01-01T00:00:00.000Z" },
            },
          } as never),
        transactWriteItems: () => Effect.succeed({} as never),
      })
      const { service, sent } = withConsumedCapacity(raw)
      const { reports, onOperation } = collectReports()
      const tracer = recordingTracer()
      yield* Transaction.transactWrite([
        Accounts.update({ accountId: "a-1" }).pipe(Entity.set({ email: "b@example.com" })),
      ]).pipe(
        Effect.provide(
          Layer.mergeAll(clientLayer(service), enabled({ onOperation }), tracer.layer),
        ),
      )
      expect(reports).toHaveLength(1)
      const report = reports[0]!
      expect(report.operation).toBe("Transaction.transactWrite")
      expect(report.requests).toBe(sent.length)
      expect(report.requestsByCommand.UpdateItem).toBeUndefined()
      expect(report.requestsByCommand.TransactWriteItems).toBe(1)
      expect(report.nested).toEqual([])
      expect(tracer.named().map((s) => s.name)).toEqual([
        "effect-dynamodb.Transaction.transactWrite",
      ])
    }),
  )

  it.effect("a planned missing-row update opens no Entity.create scope", () =>
    Effect.gen(function* () {
      const raw = mockDynamoClient({
        getItem: () => Effect.succeed({} as never),
        transactWriteItems: () => Effect.succeed({} as never),
      })
      const { reports, onOperation } = collectReports()
      const tracer = recordingTracer()
      yield* Transaction.transactWrite([
        Orders.update({ orderId: "o-1" }).pipe(
          Entity.set({ customerId: "c-1", status: "open", total: 1 }),
        ),
      ]).pipe(
        Effect.provide(
          Layer.mergeAll(
            clientLayer(withConsumedCapacity(raw).service),
            enabled({ onOperation }),
            tracer.layer,
          ),
        ),
        Effect.exit,
      )
      expect(tracer.named().map((s) => s.name)).toEqual([
        "effect-dynamodb.Transaction.transactWrite",
      ])
      expect(reports[0]!.nested).toEqual([])
    }),
  )
})

// ---------------------------------------------------------------------------
// 7. Nesting
// ---------------------------------------------------------------------------

describe("nesting", () => {
  it.effect("commandHandler: one report, read and append nested, three spans", () =>
    Effect.gen(function* () {
      const { service, sent } = inMemory()
      const { reports, onOperation } = collectReports()
      const tracer = recordingTracer()
      const handle = EventStore.commandHandler(ledgerDecider, Ledgers)
      yield* handle({ ledgerId: "l-1" }, 5).pipe(
        Effect.provide(
          Layer.mergeAll(clientLayer(service), enabled({ onOperation }), tracer.layer),
        ),
      )
      expect(reports).toHaveLength(1)
      const report = reports[0]!
      expect(report.operation).toBe("EventStore.commandHandler")
      expect(report.target).toBe("Ledger")
      expect(report.requests).toBe(sent.length)
      expect(report.nested.map((n) => [n.operation, n.calls]).sort()).toEqual([
        ["EventStream.append", 1],
        ["EventStream.read", 1],
      ])
      const nestedTotal = report.nested.reduce((sum, n) => sum + n.capacityUnits, 0)
      expect(report.capacityUnits).toBe(nestedTotal)
      const spans = tracer.named()
      expect(spans.map((s) => s.name).sort()).toEqual([
        "effect-dynamodb.EventStore.commandHandler",
        "effect-dynamodb.EventStream.append",
        "effect-dynamodb.EventStream.read",
      ])
      for (const span of spans) {
        const isRoot = span.name === "effect-dynamodb.EventStore.commandHandler"
        expect(span.attributes.get(ConsumedCapacity.Attributes.nested)).toBe(!isRoot)
        if (!isRoot) expect(parentName(span)).toBe("effect-dynamodb.EventStore.commandHandler")
      }
    }),
  )

  it.effect("Aggregate.create and Aggregate.update give one report each", () =>
    Effect.gen(function* () {
      const { service, sent } = withConsumedCapacity(aggregateStore())
      const { reports, onOperation } = collectReports()
      yield* Effect.gen(function* () {
        yield* PurchaseOrders.create({
          purchaseOrderId: "po-1",
          note: "first",
          lines: [
            { lineId: "l-1", sku: "A", quantity: 1 },
            { lineId: "l-2", sku: "B", quantity: 2 },
          ],
        })
        yield* PurchaseOrders.update({ purchaseOrderId: "po-1" }, ({ state }) => ({
          ...state,
          note: "second",
        }))
      }).pipe(Effect.provide(Layer.mergeAll(clientLayer(service), enabled({ onOperation }))))
      expect(reports.map((r) => [r.operation, r.target])).toEqual([
        ["Aggregate.create", "PurchaseOrderItem"],
        ["Aggregate.update", "PurchaseOrderItem"],
      ])
      expect(reports.reduce((sum, r) => sum + r.requests, 0)).toBe(sent.length)
      expect(reports.every((r) => r.unreportedRequests === 0)).toBe(true)
    }),
  )

  it.effect("a Query.collect run directly is a root; under Entity.query it opens no scope", () =>
    Effect.gen(function* () {
      const { service } = inMemory()
      const { reports, onOperation } = collectReports()
      const tracer = recordingTracer()
      yield* Effect.gen(function* () {
        yield* Query.collect(Orders.query.byCustomer({ customerId: "c-1" }))
        const db = yield* DynamoClient.make({ entities: { Orders } })
        yield* db.entities.Orders.byCustomer({ customerId: "c-1" }).collect()
      }).pipe(
        Effect.provide(
          Layer.mergeAll(clientLayer(service), enabled({ onOperation }), tracer.layer),
        ),
      )
      expect(reports.map((r) => [r.operation, r.target, r.index, r.requests])).toEqual([
        ["Query.collect", "Order", "gsi1", 1],
        ["Entity.query", "Order", "byCustomer", 1],
      ])
      expect(tracer.named().map((s) => s.name)).toEqual([
        "effect-dynamodb.Query.collect",
        "effect-dynamodb.Entity.query",
      ])
    }),
  )

  it.effect("concurrent fan-out under one withOperation sums every request", () =>
    Effect.gen(function* () {
      const { service } = inMemory()
      const { reports, onOperation } = collectReports()
      yield* Effect.forEach(
        Array.from({ length: 8 }, (_, i) => i),
        (i) => Query.collect(Orders.query.byCustomer({ customerId: `c-${i}` })),
        { concurrency: "unbounded" },
      ).pipe(
        ConsumedCapacity.withOperation("searchCustomers"),
        Effect.provide(Layer.mergeAll(clientLayer(service), enabled({ onOperation }))),
      )
      expect(reports).toHaveLength(1)
      expect(reports[0]).toMatchObject({
        operation: "searchCustomers",
        requests: 8,
        capacityUnits: 4,
        nested: [],
      })
    }),
  )

  it.effect("library ops inside withOperation are nested and charged to it", () =>
    Effect.gen(function* () {
      const { service } = inMemory()
      const { reports, onOperation } = collectReports()
      yield* Effect.gen(function* () {
        yield* Orders.put(order(1))
        yield* Orders.put(order(2))
        yield* Orders.get({ orderId: "o-1" })
      }).pipe(
        ConsumedCapacity.withOperation("placeOrders", { target: "Order" }),
        Effect.provide(Layer.mergeAll(clientLayer(service), enabled({ onOperation }))),
      )
      expect(reports).toHaveLength(1)
      expect(reports[0]).toMatchObject({
        operation: "placeOrders",
        target: "Order",
        requests: 3,
        capacityUnits: 2.5,
        readCapacityUnits: 0.5,
        writeCapacityUnits: 2,
      })
      expect(reports[0]!.nested).toEqual([
        {
          operation: "Entity.put",
          calls: 2,
          capacityUnits: 2,
          readCapacityUnits: 0,
          writeCapacityUnits: 2,
          requests: 2,
          unreportedRequests: 0,
        },
        {
          operation: "Entity.get",
          calls: 1,
          capacityUnits: 0.5,
          readCapacityUnits: 0.5,
          writeCapacityUnits: 0,
          requests: 1,
          unreportedRequests: 0,
        },
      ])
    }),
  )

  it.effect("a request outside every operation is an implicit DynamoClient.<Command> root", () =>
    Effect.gen(function* () {
      const { service } = inMemory()
      const { reports, onOperation } = collectReports()
      yield* Effect.gen(function* () {
        const client = yield* Capacity.client
        yield* client.getItem({ TableName: "shop-table", Key: { pk: { S: "x" }, sk: { S: "y" } } })
      }).pipe(Effect.provide(Layer.mergeAll(clientLayer(service), enabled({ onOperation }))))
      expect(reports.map((r) => r.operation)).toEqual(["DynamoClient.GetItem"])
    }),
  )
})

// ---------------------------------------------------------------------------
// 7b. Work that outlives its operation
// ---------------------------------------------------------------------------

describe("work that outlives its operation", () => {
  /**
   * An in-memory client whose `method` signals `started` and then waits for
   * `gate` before answering, so a test can close an operation while the
   * request is in flight.
   */
  const gatedClient = (method: "putItem" | "getItem") =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const gate = yield* Deferred.make<void>()
      const inner = serviceOf(InMemoryClient)
      const raw = inner[method] as (input: any) => Effect.Effect<any, any>
      const gated = {
        ...inner,
        [method]: (input: any) =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(gate)),
            Effect.andThen(raw(input)),
          ),
      } as DynamoClientService
      const { service } = withConsumedCapacity(gated)
      return { service, started, gate }
    })

  const summary = (reports: ReadonlyArray<ConsumedCapacity.OperationReport>) =>
    reports.map((r) => ({
      operation: r.operation,
      requests: r.requests,
      capacityUnits: r.capacityUnits,
      nested: r.nested.map((n) => [n.operation, n.calls, n.requests]),
    }))

  it.effect("a library op forked out of a root and finishing after it reports as a root", () =>
    Effect.gen(function* () {
      const { service, started, gate } = yield* gatedClient("putItem")
      const { reports, onOperation } = collectReports()
      const fiber = yield* Effect.gen(function* () {
        const forked = yield* Effect.forkDetach(Orders.put(order(1)).asEffect())
        yield* Deferred.await(started)
        return forked
      }).pipe(
        ConsumedCapacity.withOperation("root"),
        Effect.provide(Layer.mergeAll(clientLayer(service), enabled({ onOperation }))),
      )
      expect(summary(reports)).toEqual([
        { operation: "root", requests: 0, capacityUnits: 0, nested: [] },
      ])
      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.join(fiber)
      expect(summary(reports)).toEqual([
        { operation: "root", requests: 0, capacityUnits: 0, nested: [] },
        { operation: "Entity.put", requests: 1, capacityUnits: 1, nested: [] },
      ])
    }),
  )

  it.effect("a bare request in flight when its root closes reports as DynamoClient.<Command>", () =>
    Effect.gen(function* () {
      const { service, started, gate } = yield* gatedClient("getItem")
      const { reports, onOperation } = collectReports()
      const fiber = yield* Effect.gen(function* () {
        const forked = yield* Effect.forkDetach(
          Effect.flatMap(Capacity.client, (client) =>
            client.getItem({ TableName: "shop-table", Key: { pk: { S: "x" }, sk: { S: "y" } } }),
          ),
        )
        yield* Deferred.await(started)
        return forked
      }).pipe(
        ConsumedCapacity.withOperation("root"),
        Effect.provide(Layer.mergeAll(clientLayer(service), enabled({ onOperation }))),
      )
      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.join(fiber)
      expect(summary(reports)).toEqual([
        { operation: "root", requests: 0, capacityUnits: 0, nested: [] },
        { operation: "DynamoClient.GetItem", requests: 1, capacityUnits: 0.5, nested: [] },
      ])
      expect(reports[1]!.outcome).toBe("success")
    }),
  )

  it.effect(
    "work spanning its root's close is reported once: before in the root, after in its own",
    () =>
      Effect.gen(function* () {
        const { service, started, gate } = yield* gatedClient("getItem")
        const { reports, onOperation } = collectReports()
        const tracer = recordingTracer()
        const child = Effect.gen(function* () {
          yield* Orders.put(order(1))
          yield* Orders.get({ orderId: "o-1" })
        }).pipe(ConsumedCapacity.withOperation("child"))
        const fiber = yield* Effect.gen(function* () {
          const forked = yield* Effect.forkDetach(child)
          yield* Deferred.await(started)
          return forked
        }).pipe(
          ConsumedCapacity.withOperation("root"),
          Effect.provide(
            Layer.mergeAll(clientLayer(service), enabled({ onOperation }), tracer.layer),
          ),
        )
        yield* Deferred.succeed(gate, undefined)
        yield* Fiber.join(fiber)
        expect(summary(reports)).toEqual([
          { operation: "root", requests: 1, capacityUnits: 1, nested: [] },
          { operation: "child", requests: 1, capacityUnits: 0.5, nested: [["Entity.get", 1, 1]] },
        ])
        // Summing reports counts every request exactly once.
        expect(reports.reduce((sum, r) => sum + r.requests, 0)).toBe(2)
        // The child's span still covers its whole life.
        const span = tracer.named().find((s) => s.name === "effect-dynamodb.child")!
        expect(span.attributes.get(ConsumedCapacity.Attributes.requestCount)).toBe(2)
        expect(span.attributes.get(ConsumedCapacity.Attributes.total)).toBe(1.5)
      }),
  )

  it.effect("a child outliving an inner operation is charged to the still-open root", () =>
    Effect.gen(function* () {
      const { service, started, gate } = yield* gatedClient("putItem")
      const { reports, onOperation } = collectReports()
      yield* Effect.gen(function* () {
        const fiber = yield* Effect.gen(function* () {
          const forked = yield* Effect.forkDetach(Orders.put(order(1)).asEffect())
          yield* Deferred.await(started)
          return forked
        }).pipe(ConsumedCapacity.withOperation("inner"))
        yield* Deferred.succeed(gate, undefined)
        yield* Fiber.join(fiber)
      }).pipe(
        ConsumedCapacity.withOperation("root"),
        Effect.provide(Layer.mergeAll(clientLayer(service), enabled({ onOperation }))),
      )
      expect(summary(reports)).toEqual([
        {
          operation: "root",
          requests: 1,
          capacityUnits: 1,
          nested: [
            ["inner", 1, 0],
            ["Entity.put", 1, 1],
          ],
        },
      ])
    }),
  )
})

// ---------------------------------------------------------------------------
// 8. Decorated and mocked clients
// ---------------------------------------------------------------------------

describe("decorated clients", () => {
  it.effect("a user decorator layer is instrumented and counted once", () =>
    Effect.gen(function* () {
      const { service, sent } = inMemory()
      let decorated = 0
      const Decorated = Layer.effect(
        DynamoClient,
        Effect.map(Effect.service(DynamoClient), (inner) => ({
          ...inner,
          putItem: (input: Parameters<DynamoClientService["putItem"]>[0]) => {
            decorated++
            return inner.putItem(input)
          },
        })),
      ).pipe(Layer.provide(clientLayer(service)))
      const { reports, onOperation } = collectReports()
      yield* Orders.put(order(1))
        .asEffect()
        .pipe(Effect.provide(Layer.mergeAll(Decorated, enabled({ onOperation }))))
      expect(decorated).toBe(1)
      expect(sent).toHaveLength(1)
      expect(sent[0]!.input.ReturnConsumedCapacity).toBe("TOTAL")
      expect(reports[0]).toMatchObject({ requests: 1, capacityUnits: 1, unreportedRequests: 0 })
    }),
  )

  it.effect("a decorator that drops the flag: requests counted, all unreported", () =>
    Effect.gen(function* () {
      const { service } = inMemory()
      const dropping: DynamoClientService = {
        ...service,
        putItem: ({ ReturnConsumedCapacity: _drop, ...input }) => service.putItem(input),
      }
      const { reports, onOperation } = collectReports()
      yield* Orders.put(order(1))
        .asEffect()
        .pipe(Effect.provide(Layer.mergeAll(clientLayer(dropping), enabled({ onOperation }))))
      expect(reports[0]).toMatchObject({ requests: 1, unreportedRequests: 1, capacityUnits: 0 })
    }),
  )

  it.effect("VectorSearchEmulation: searchVectors is one request, its scans are not counted", () =>
    Effect.gen(function* () {
      const { service, sent } = withConsumedCapacity(
        mockDynamoClient({ scan: () => Effect.succeed({ Items: [] } as never) }),
      )
      const emulated = VectorSearchEmulation.wrap(service)
      const { reports, onOperation } = collectReports()
      yield* Effect.gen(function* () {
        const client = yield* Capacity.client
        yield* client.searchVectors({
          TableName: "shop-table",
          IndexName: "byEmbedding",
          SearchVector: [{ N: "1" }],
          TopK: 3,
        })
      }).pipe(
        ConsumedCapacity.withOperation("search"),
        Effect.provide(Layer.mergeAll(clientLayer(emulated), enabled({ onOperation }))),
      )
      expect(reports[0]).toMatchObject({
        requests: 1,
        requestsByCommand: { SearchVectors: 1 },
        unreportedRequests: 1,
      })
      expect(sent.every((s) => s.command === "Scan")).toBe(true)
    }),
  )
})

// ---------------------------------------------------------------------------
// 9. Context capture
// ---------------------------------------------------------------------------

describe("context capture", () => {
  const terminals = (db: any) => {
    const q = () => db.entities.Orders.byCustomer({ customerId: "c-1" })
    return Effect.gen(function* () {
      yield* q().collect()
      yield* q().fetch()
      yield* q().count()
      yield* Stream.runCollect(q().paginate())
    }) as Effect.Effect<void, unknown>
  }

  it.effect("enabled at bind time reports on collect, fetch, count and paginate", () =>
    Effect.gen(function* () {
      const { service } = inMemory()
      const { reports, onOperation } = collectReports()
      const db = yield* DynamoClient.make({ entities: { Orders } }).pipe(
        Effect.provide(Layer.mergeAll(clientLayer(service), enabled({ onOperation }))),
      )
      yield* terminals(db)
      expect(reports.map((r) => r.operation)).toEqual([
        "Entity.query",
        "Entity.query",
        "Entity.query",
        "Entity.query",
      ])
    }),
  )

  it.effect("enabled at run time only also reports on all four", () =>
    Effect.gen(function* () {
      const { service } = inMemory()
      const { reports, onOperation } = collectReports()
      const db = yield* DynamoClient.make({ entities: { Orders } }).pipe(
        Effect.provide(Layer.mergeAll(clientLayer(service), TableLayer)),
      )
      yield* terminals(db).pipe(Effect.provide(ConsumedCapacity.layer({ onOperation })))
      expect(reports).toHaveLength(4)
    }),
  )

  it.effect("a client bound under `disabled` does not report, even with run-time reporting", () =>
    Effect.gen(function* () {
      const { service, sent } = inMemory()
      const { reports, onOperation } = collectReports()
      const db = yield* DynamoClient.make({ entities: { Orders } }).pipe(
        Effect.provide(Layer.mergeAll(clientLayer(service), TableLayer, ConsumedCapacity.disabled)),
      )
      yield* terminals(db).pipe(Effect.provide(ConsumedCapacity.layer({ onOperation })))
      expect(reports).toEqual([])
      expect(sent.every((s) => !Object.hasOwn(s.input, "ReturnConsumedCapacity"))).toBe(true)
    }),
  )

  it.effect("a client made inside an operation does not pin later calls to it", () =>
    Effect.gen(function* () {
      const { service } = inMemory()
      const { reports, onOperation } = collectReports()
      const layer = Layer.mergeAll(clientLayer(service), enabled({ onOperation }))
      const db = yield* DynamoClient.make({ entities: { Orders } }).pipe(
        ConsumedCapacity.withOperation("invoke"),
        Effect.provide(layer),
      )
      yield* db.entities.Orders.put(order(1))
      yield* db.entities.Orders.get({ orderId: "o-1" })
      expect(reports.map((r) => r.operation)).toEqual(["invoke", "Entity.put", "Entity.get"])
    }),
  )

  it.effect("bound under span A, called under span B: the library span's parent is B", () =>
    Effect.gen(function* () {
      const { service } = inMemory()
      const tracer = recordingTracer()
      yield* Effect.gen(function* () {
        const db = yield* DynamoClient.make({ entities: { Orders } }).pipe(Effect.withSpan("A"))
        yield* db.entities.Orders.put(order(1)).asEffect().pipe(Effect.withSpan("B"))
      }).pipe(Effect.provide(Layer.mergeAll(clientLayer(service), enabled(), tracer.layer)))
      const span = tracer.named().find((s) => s.name === "effect-dynamodb.Entity.put")!
      expect(parentName(span)).toBe("B")
    }),
  )
})

// ---------------------------------------------------------------------------
// 10. Observer isolation
// ---------------------------------------------------------------------------

describe("observer", () => {
  it.effect("an observer writing through a client bound with reporting on does not recurse", () =>
    Effect.gen(function* () {
      const { service, sent } = inMemory()
      const reports: Array<ConsumedCapacity.OperationReport> = []
      // The observer's own client is bound under the ENABLED layer.
      let metricsDb: any
      const observer = (report: ConsumedCapacity.OperationReport) =>
        Effect.gen(function* () {
          reports.push(report)
          yield* metricsDb.entities.Orders.put(order(100 + reports.length)).asEffect()
        }).pipe(Effect.orDie) as Effect.Effect<void>
      const layer = Layer.mergeAll(clientLayer(service), enabled({ onOperation: observer }))
      yield* Effect.gen(function* () {
        metricsDb = yield* DynamoClient.make({ entities: { Orders } })
        yield* Orders.get({ orderId: "o-1" }).asEffect().pipe(Effect.ignore)
      }).pipe(Effect.provide(layer))
      expect(reports.map((r) => r.operation)).toEqual(["Entity.get"])
      // The get, plus exactly one observer write — sent without the flag.
      expect(sent.map((s) => s.command)).toEqual(["GetItem", "PutItem"])
      expect(Object.hasOwn(sent[1]!.input, "ReturnConsumedCapacity")).toBe(false)
    }),
  )

  it.effect("an observer defect is logged and the result is unchanged", () =>
    Effect.gen(function* () {
      const { service } = inMemory()
      const logged: Array<unknown> = []
      const logger = Logger.make((options) => {
        logged.push(options.message)
      })
      const result = yield* Effect.gen(function* () {
        yield* Orders.put(order(1))
        return yield* Orders.get({ orderId: "o-1" })
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            clientLayer(service),
            enabled({ onOperation: () => Effect.die("observer exploded") }),
            Logger.layer([logger]),
          ),
        ),
      )
      expect(result.orderId).toBe("o-1")
      expect(JSON.stringify(logged)).toContain("ConsumedCapacity observer failed")
    }),
  )

  it.effect("a slow observer is interrupted by a timeout around the operation", () =>
    Effect.gen(function* () {
      const { service } = inMemory()
      const fiber = yield* Orders.put(order(1))
        .asEffect()
        .pipe(
          Effect.timeout("1 second"),
          Effect.provide(
            Layer.mergeAll(
              clientLayer(service),
              enabled({ onOperation: () => Effect.sleep("30 seconds") }),
            ),
          ),
          Effect.exit,
          Effect.forkChild,
        )
      yield* TestClock.adjust("2 seconds")
      const exit = yield* Fiber.join(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(true)
    }),
  )

  it.effect("spans: false gives observer calls and no spans", () =>
    Effect.gen(function* () {
      const { service } = inMemory()
      const { reports, onOperation } = collectReports()
      const tracer = recordingTracer()
      yield* Orders.put(order(1))
        .asEffect()
        .pipe(
          Effect.provide(
            Layer.mergeAll(
              clientLayer(service),
              enabled({ onOperation, spans: false }),
              tracer.layer,
            ),
          ),
        )
      expect(reports).toHaveLength(1)
      expect(tracer.named()).toEqual([])
    }),
  )

  it.effect("span attributes carry the totals", () =>
    Effect.gen(function* () {
      const { service } = inMemory()
      const tracer = recordingTracer()
      yield* Orders.put(order(1))
        .asEffect()
        .pipe(Effect.provide(Layer.mergeAll(clientLayer(service), enabled(), tracer.layer)))
      const span = tracer.named()[0]!
      expect(span.name).toBe("effect-dynamodb.Entity.put")
      expect(span.kind).toBe("client")
      expect(Object.fromEntries(span.attributes)).toEqual({
        "db.system.name": "aws.dynamodb",
        "effect_dynamodb.operation": "Entity.put",
        "effect_dynamodb.target": "Order",
        "effect_dynamodb.nested": false,
        "aws.dynamodb.table_names": ["shop-table"],
        "aws.dynamodb.consumed_capacity.total": 1,
        "aws.dynamodb.consumed_capacity.read": 0,
        "aws.dynamodb.consumed_capacity.write": 1,
        "effect_dynamodb.request_count": 1,
      })
    }),
  )
})

// ---------------------------------------------------------------------------
// 11. Types
// ---------------------------------------------------------------------------

describe("types", () => {
  it("bound ops keep R = never and their return types; the layer is Layer<never>", () => {
    expectTypeOf(ConsumedCapacity.layer()).toEqualTypeOf<Layer.Layer<never>>()
    expectTypeOf(ConsumedCapacity.disabled).toEqualTypeOf<Layer.Layer<never>>()
    const program = Effect.gen(function* () {
      const db = yield* DynamoClient.make({ entities: { Orders } })
      const got = db.entities.Orders.get({ orderId: "o-1" })
      expectTypeOf<Effect.Services<typeof got>>().toEqualTypeOf<never>()
      expectTypeOf<Effect.Success<typeof got>>().toEqualTypeOf<Order>()
      const listed = db.entities.Orders.byCustomer({ customerId: "c-1" }).collect()
      expectTypeOf<Effect.Services<typeof listed>>().toEqualTypeOf<never>()
    })
    expectTypeOf(program).toEqualTypeOf<
      Effect.Effect<void, never, DynamoClient | Table.TableConfig>
    >()
    const wrapped = Effect.succeed(1).pipe(ConsumedCapacity.withOperation("x"))
    expectTypeOf(wrapped).toEqualTypeOf<Effect.Effect<number>>()
    const stream = Stream.fromIterable([1, 2]).pipe(ConsumedCapacity.withOperationStream("x"))
    expectTypeOf<Stream.Success<typeof stream>>().toEqualTypeOf<number>()
    expectTypeOf<Stream.Error<typeof stream>>().toEqualTypeOf<never>()
    expectTypeOf<Stream.Services<typeof stream>>().toEqualTypeOf<never>()
    expectTypeOf<Tracer.Span>().not.toBeNever()
  })
})
