/**
 * Connected tests for consumed-capacity reporting (#174) against DynamoDB Local.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 *
 * DynamoDB Local answers every data-plane command with `ConsumedCapacity`
 * (`TableName` + `CapacityUnits`, never a read / write split — so these tests
 * also exercise the command-kind attribution). The values asserted follow the
 * published rules (design §11.1):
 *
 * - a write is 1 unit per started KB, on the table and again on each GSI the
 *   item is written to;
 * - a read is 0.5 units per started 4 KB eventually consistent, 1 consistent;
 *   a Query page is charged on the data it reads;
 * - a transaction item costs what the same item costs outside one. Real
 *   DynamoDB doubles transactional units; DynamoDB Local does not, so these
 *   tests assert Local's values and the doubling is covered by the unit tests.
 */

import { it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Config, Effect, Exit, Layer, Schema } from "effect"
import { afterAll, beforeAll, describe, expect } from "vitest"
import * as Aggregate from "../src/Aggregate.js"
import * as Batch from "../src/Batch.js"
import * as ConsumedCapacity from "../src/ConsumedCapacity.js"
import { DynamoClient, type DynamoClientService } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
import * as Table from "../src/Table.js"
import * as Transaction from "../src/Transaction.js"

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

const AppSchema = DynamoSchema.make({ name: "capacity", version: 1 })
const tableName = `consumed-capacity-${Date.now()}`

// ---------------------------------------------------------------------------
// Model — orders (with a GSI), accounts (unique email), ledgers, purchase orders
// ---------------------------------------------------------------------------

class Order extends Schema.Class<Order>("Order")({
  orderId: Schema.String,
  customerId: Schema.String,
  notes: Schema.String,
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

class LineItem extends Schema.Class<LineItem>("LineItem")({
  orderId: Schema.String,
  lineId: Schema.String,
  sku: Schema.String,
}) {}

/** No GSI: a write costs the table's units only. */
const LineItems = Entity.make({
  model: LineItem,
  entityType: "LineItem",
  primaryKey: {
    pk: { field: "pk", composite: ["orderId"] },
    sk: { field: "sk", composite: ["lineId"] },
  },
})

class Account extends Schema.Class<Account>("Account")({
  accountId: Schema.String,
  email: Schema.String,
}) {}

const Accounts = Entity.make({
  model: Account,
  entityType: "Account",
  primaryKey: {
    pk: { field: "pk", composite: ["accountId"] },
    sk: { field: "sk", composite: [] },
  },
  unique: { email: ["email"] },
})

class Line extends Schema.Class<Line>("Line")({ lineId: Schema.String, sku: Schema.String }) {}

class PurchaseOrder extends Schema.Class<PurchaseOrder>("PurchaseOrder")({
  purchaseOrderId: Schema.String,
  note: Schema.String,
  lines: Schema.Array(Line),
}) {}

const MainTable = Table.make({ schema: AppSchema, entities: { Orders, LineItems, Accounts } })

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

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

/** The item count of every `TransactWriteItems` sent. */
const transactions: Array<number> = []

const ClientLayer = Layer.effect(
  DynamoClient,
  Effect.map(
    Effect.service(DynamoClient),
    (client): DynamoClientService => ({
      ...client,
      transactWriteItems: (input) => {
        transactions.push(input.TransactItems?.length ?? 0)
        return client.transactWriteItems(input)
      },
    }),
  ),
).pipe(
  Layer.provide(
    DynamoClient.layer({
      region: "us-east-1",
      endpoint: ENDPOINT,
      credentials: { accessKeyId: "local", secretAccessKey: "local" },
    }),
  ),
)
const BaseLayer = Layer.mergeAll(ClientLayer, MainTable.layer({ name: tableName }))

/** Run `effect` with reporting on, returning its exit and the reports delivered. */
const reported = <A, E>(
  effect: Effect.Effect<A, E, DynamoClient | Table.TableConfig>,
  options?: Omit<ConsumedCapacity.Options, "onOperation">,
) =>
  Effect.gen(function* () {
    const reports: Array<ConsumedCapacity.OperationReport> = []
    const exit = yield* effect.pipe(
      Effect.exit,
      Effect.provide(
        ConsumedCapacity.layer({
          ...options,
          onOperation: (report) =>
            Effect.sync(() => {
              reports.push(report)
            }),
        }),
      ),
      Effect.provide(BaseLayer),
    )
    return { exit, reports }
  })

const setup = <A, E>(effect: Effect.Effect<A, E, DynamoClient | Table.TableConfig>) =>
  effect.pipe(Effect.provide(BaseLayer), Effect.orDie)

let ids = 0
const fresh = (prefix: string) => `${prefix}-${++ids}`

describeConnected("consumed capacity (connected)", () => {
  beforeAll(async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        // Through `DynamoClient.make`, so the aggregate's lsi1 collection
        // index is merged into the CreateTable call.
        const db = yield* DynamoClient.make({
          entities: { Orders, LineItems, Accounts },
          aggregates: { PurchaseOrders },
          tables: { MainTable },
        })
        yield* db.tables.MainTable.create()
      }).pipe(Effect.provide(BaseLayer)),
    )
  }, 15000)

  afterAll(async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* DynamoClient
        yield* client
          .deleteTable({ TableName: tableName })
          .pipe(Effect.catchTag("ResourceNotFoundError", () => Effect.void))
      }).pipe(Effect.provide(BaseLayer)),
    )
  })

  it.effect("Entity.put with one GSI under indexes: table and GSI units", () =>
    Effect.gen(function* () {
      const small = { orderId: fresh("o"), customerId: "c-1", notes: "n" }
      // A 2.5 KB item: 3 units on the table and 3 on the GSI.
      const large = { orderId: fresh("o"), customerId: "c-1", notes: "x".repeat(2500) }
      const { reports } = yield* reported(
        Effect.gen(function* () {
          yield* Orders.put(small)
          yield* Orders.put(large)
        }),
        { level: "indexes" },
      )
      expect(reports.map((r) => [r.operation, r.capacityUnits])).toEqual([
        ["Entity.put", 2],
        ["Entity.put", 6],
      ])
      expect(reports[1]!.byTable).toEqual([
        {
          tableName,
          capacityUnits: 6,
          readCapacityUnits: 0,
          writeCapacityUnits: 6,
          requests: 1,
          unreportedRequests: 0,
          table: { capacityUnits: 3, readCapacityUnits: 0, writeCapacityUnits: 3 },
          globalSecondaryIndexes: {
            gsi1: { capacityUnits: 3, readCapacityUnits: 0, writeCapacityUnits: 3 },
          },
        },
      ])
    }),
  )

  it.effect("Entity.get: 0.5 units eventually consistent, 1 consistent", () =>
    Effect.gen(function* () {
      const orderId = fresh("o")
      yield* setup(Orders.put({ orderId, customerId: "c-2", notes: "n" }).asEffect())
      const { reports } = yield* reported(
        Effect.gen(function* () {
          yield* Orders.get({ orderId })
          yield* Entity.consistentRead(Orders.get({ orderId }))
        }),
      )
      expect(reports.map((r) => [r.operation, r.capacityUnits, r.readCapacityUnits])).toEqual([
        ["Entity.get", 0.5, 0.5],
        ["Entity.get", 1, 1],
      ])
      expect(reports[0]).toMatchObject({
        requests: 1,
        unreportedRequests: 0,
        tables: [tableName],
        outcome: "success",
      })
    }),
  )

  it.effect("Entity.query over 3 pages: 3 requests, units summed", () =>
    Effect.gen(function* () {
      const customerId = fresh("c")
      yield* setup(
        Effect.forEach([1, 2, 3, 4, 5], (n) =>
          Orders.put({ orderId: `${customerId}-o-${n}`, customerId, notes: "n" }).asEffect(),
        ),
      )
      const { exit, reports } = yield* reported(
        Effect.gen(function* () {
          const db = yield* DynamoClient.make({ entities: { Orders } })
          return yield* db.entities.Orders.byCustomer({ customerId }).pageSize(2).collect()
        }),
      )
      expect(Exit.isSuccess(exit) && exit.value.length).toBe(5)
      expect(reports).toHaveLength(1)
      expect(reports[0]).toMatchObject({
        operation: "Entity.query",
        index: "byCustomer",
        requests: 3,
        requestsByCommand: { Query: 3 },
        capacityUnits: 1.5,
        readCapacityUnits: 1.5,
        unreportedRequests: 0,
      })
    }),
  )

  it.effect("Batch.write of 30 items: 2 requests, 1 unit per item", () =>
    Effect.gen(function* () {
      const orderId = fresh("o")
      const { reports } = yield* reported(
        Batch.write(
          Array.from({ length: 30 }, (_, n) =>
            LineItems.put({ orderId, lineId: `l-${n}`, sku: "A" }),
          ),
        ),
      )
      expect(reports).toHaveLength(1)
      expect(reports[0]).toMatchObject({
        operation: "Batch.write",
        requests: 2,
        requestsByCommand: { BatchWriteItem: 2 },
        capacityUnits: 30,
        writeCapacityUnits: 30,
        unreportedRequests: 0,
      })
    }),
  )

  it.effect("Transaction.transactWrite: one request, units per item", () =>
    Effect.gen(function* () {
      const orderId = fresh("o")
      const { reports } = yield* reported(
        Transaction.transactWrite([
          LineItems.put({ orderId, lineId: "l-1", sku: "A" }),
          LineItems.put({ orderId, lineId: "l-2", sku: "B" }),
        ]),
      )
      expect(reports).toHaveLength(1)
      expect(reports[0]).toMatchObject({
        operation: "Transaction.transactWrite",
        requests: 1,
        requestsByCommand: { TransactWriteItems: 1 },
        capacityUnits: 2,
        writeCapacityUnits: 2,
      })
    }),
  )

  it.effect("Entity.create with a unique constraint: one sentinel transaction", () =>
    Effect.gen(function* () {
      const accountId = fresh("a")
      const { reports } = yield* reported(
        Accounts.create({ accountId, email: `${accountId}@example.com` }).asEffect(),
      )
      expect(reports).toHaveLength(1)
      expect(reports[0]).toMatchObject({
        operation: "Entity.create",
        target: "Account",
        requests: 1,
        requestsByCommand: { TransactWriteItems: 1 },
        // The item and its sentinel.
        capacityUnits: 2,
      })
    }),
  )

  it.effect("a failed create (ConditionalCheckFailed) reports 1 unreported request", () =>
    Effect.gen(function* () {
      const orderId = fresh("o")
      yield* setup(Orders.put({ orderId, customerId: "c-3", notes: "n" }).asEffect())
      const { exit, reports } = yield* reported(
        Orders.create({ orderId, customerId: "c-3", notes: "n" }).asEffect(),
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
    }),
  )

  it.effect("EventStream.append, read, and commandHandler nesting", () =>
    Effect.gen(function* () {
      const ledgerId = fresh("l")
      const { reports } = yield* reported(
        Effect.gen(function* () {
          yield* Ledgers.append({ ledgerId }, [new Deposited({ amount: 5 })], 0)
          yield* Ledgers.read({ ledgerId })
          yield* EventStore.commandHandler(ledgerDecider, Ledgers)({ ledgerId }, 3)
          // The same shape as the handler's append: one event above version 0.
          yield* Ledgers.append({ ledgerId }, [new Deposited({ amount: 4 })], 2)
        }),
      )
      expect(reports.map((r) => r.operation)).toEqual([
        "EventStream.append",
        "EventStream.read",
        "EventStore.commandHandler",
        "EventStream.append",
      ])
      // The first event is a one-item append, sent as a PutItem (#173); the
      // later appends carry the head check, so they are transactions.
      expect(reports[0]!.requestsByCommand).toEqual({ PutItem: 1 })
      expect(reports[3]!.requestsByCommand).toEqual({ TransactWriteItems: 1 })
      for (const report of reports) {
        expect(report.unreportedRequests).toBe(0)
        expect(report.capacityUnits).toBeGreaterThan(0)
      }
      const handler = reports[2]!
      expect(handler.nested.map((n) => [n.operation, n.calls])).toEqual([
        ["EventStream.read", 1],
        ["EventStream.append", 1],
      ])
      // Inclusive totals: the root is the sum of its children, nothing counted twice.
      expect(handler.capacityUnits).toBe(
        handler.nested.reduce((sum, child) => sum + child.capacityUnits, 0),
      )
      expect(handler.requests).toBe(handler.nested.reduce((sum, child) => sum + child.requests, 0))
      // The handler's append costs what a standalone append of its shape cost.
      expect(handler.nested[1]!.capacityUnits).toBe(reports[3]!.capacityUnits)
    }),
  )

  it.effect("Aggregate.create: one report for its transaction", () =>
    Effect.gen(function* () {
      const purchaseOrderId = fresh("po")
      const { exit, reports } = yield* reported(
        PurchaseOrders.create({
          purchaseOrderId,
          note: "n",
          lines: [
            { lineId: "l-1", sku: "A" },
            { lineId: "l-2", sku: "B" },
          ],
        }),
      )
      expect(Exit.isSuccess(exit)).toBe(true)
      expect(reports).toHaveLength(1)
      expect(reports[0]).toMatchObject({
        operation: "Aggregate.create",
        target: "PurchaseOrderItem",
        unreportedRequests: 0,
      })
      expect(reports[0]!.requestsByCommand.TransactWriteItems).toBe(1)
      // At least a unit for each item of its one transaction, as DynamoDB charged it.
      expect(reports[0]!.requests).toBe(1)
      expect(reports[0]!.capacityUnits).toBeGreaterThanOrEqual(transactions.at(-1)!)
    }),
  )

  it.effect("with reporting off, nothing is reported and results are unchanged", () =>
    Effect.gen(function* () {
      const orderId = fresh("o")
      const order = yield* setup(
        Effect.gen(function* () {
          yield* Orders.put({ orderId, customerId: "c-4", notes: "n" })
          return yield* Orders.get({ orderId })
        }),
      )
      expect(order.orderId).toBe(orderId)
    }),
  )
})
