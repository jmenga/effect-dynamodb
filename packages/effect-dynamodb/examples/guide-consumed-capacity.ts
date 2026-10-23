/**
 * Consumed Capacity Guide Example — effect-dynamodb
 *
 * Demonstrates opt-in consumed-capacity reporting:
 *   - Turning it on with `ConsumedCapacity.layer` (off by default)
 *   - An observer receiving one report per library operation
 *   - Pagination: one report for a multi-page query, with its request count
 *   - Nesting: a `commandHandler` reports once, its read and append nested
 *   - `withOperation` grouping several calls into one application operation
 *   - A failed write: counted as a request, reported without capacity
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *
 * Run:
 *   npx tsx examples/guide-consumed-capacity.ts
 */

import { Config, Console, Effect, Layer, Schema } from "effect"

// Import from source (use "effect-dynamodb" when published)
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import * as ConsumedCapacity from "../src/ConsumedCapacity.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
import * as Table from "../src/Table.js"

// =============================================================================
// 1. Domain — orders and accounts
// =============================================================================

class Order extends Schema.Class<Order>("Order")({
  orderId: Schema.String,
  customerId: Schema.String,
  total: Schema.Number,
}) {}

class Account extends Schema.Class<Account>("Account")({
  accountId: Schema.String,
  orders: Schema.Number,
}) {}

const AppSchema = DynamoSchema.make({ name: "capacity-demo", version: 1 })

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

const Accounts = Entity.make({
  model: Account,
  entityType: "Account",
  primaryKey: {
    pk: { field: "pk", composite: ["accountId"] },
    sk: { field: "sk", composite: [] },
  },
})

const MainTable = Table.make({ schema: AppSchema, entities: { Orders, Accounts } })

class Deposited extends Schema.Class<Deposited>("Deposited")({ amount: Schema.Number }) {}

const Ledgers = EventStore.makeStream({
  table: MainTable,
  streamName: "Ledger",
  events: [Deposited],
  streamId: { composite: ["accountId"] },
})

const deposit: EventStore.Decider<{ readonly balance: number }, number, Deposited, never> = {
  initialState: { balance: 0 },
  decide: (amount) => Effect.succeed([new Deposited({ amount })]),
  evolve: (state, event) => ({ balance: state.balance + event.amount }),
}

// =============================================================================
// 2. Turning reporting on
// =============================================================================

// #region enable
// Every library operation run under this layer asks DynamoDB for its consumed
// capacity, and runs in a span carrying the totals.
const Reporting = ConsumedCapacity.layer()
// #endregion

// #region observer
// The same, with an observer: one report per library operation, after it ends.
const received: Array<ConsumedCapacity.OperationReport> = []

const ReportingWithObserver = ConsumedCapacity.layerEffect(
  Effect.sync(() => ({
    level: "total" as const,
    onOperation: (report: ConsumedCapacity.OperationReport) =>
      Effect.gen(function* () {
        received.push(report)
        yield* Effect.logDebug(
          `${report.operation}: ${report.capacityUnits} units in ${report.requests} requests`,
        )
      }),
  })),
)
// #endregion

// =============================================================================
// 3. Layers
// =============================================================================

const tableName = "consumed-capacity-demo"

const ClientLayer = DynamoClient.layerConfig({
  region: Config.succeed("us-east-1"),
  endpoint: Config.String("DYNAMODB_ENDPOINT").pipe(Config.withDefault("http://localhost:8000")),
  credentials: Config.succeed({ accessKeyId: "local", secretAccessKey: "local" }),
})

const AppLayer = Layer.mergeAll(ClientLayer, MainTable.layer({ name: tableName }))

const assertEq = <T>(actual: T, expected: T, label: string): void => {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`Assertion failed [${label}]: expected ${e}, got ${a}`)
}

const last = (): ConsumedCapacity.OperationReport => received[received.length - 1]!

// =============================================================================
// 4. Program
// =============================================================================

const program = Effect.gen(function* () {
  const client = yield* DynamoClient
  yield* client
    .deleteTable({ TableName: tableName })
    .pipe(Effect.catchTag("ResourceNotFoundError", () => Effect.void))
  yield* client.createTable({
    TableName: tableName,
    BillingMode: "PAY_PER_REQUEST",
    ...Table.definition(MainTable),
  })

  const db = yield* DynamoClient.make({
    entities: { Orders, Accounts },
    tables: { MainTable },
  })

  // ---------- One operation, one report ----------
  // #region report
  yield* db.entities.Orders.put({ orderId: "o-1", customerId: "c-1", total: 40 })
  const order = yield* db.entities.Orders.get({ orderId: "o-1" })

  const report = last()
  // report.operation      → "Entity.get"
  // report.target         → "Order"
  // report.capacityUnits  → 0.5   (an eventually consistent read of a small item)
  // report.requests       → 1
  // report.tables         → ["consumed-capacity-demo"]
  // #endregion
  assertEq(order.orderId, "o-1", "get returns the order")
  assertEq(
    [report.operation, report.target, report.capacityUnits, report.requests, report.tables],
    ["Entity.get", "Order", 0.5, 1, [tableName]],
    "get report",
  )
  yield* Console.log(`${report.operation}: ${report.capacityUnits} units`)

  // A bound client keeps the setting it was bound under: `db` was made under
  // the observer layer, so providing the plain layer around a call through it
  // changes nothing, and the observer still receives the report.
  const beforeBound = received.length
  yield* db.entities.Orders.get({ orderId: "o-1" }).asEffect().pipe(Effect.provide(Reporting))
  assertEq(received.length, beforeBound + 1, "a bound client keeps its bind-time setting")

  // An unbound op reads the setting when it runs, so the innermost layer wins:
  // under the plain layer the get still runs in a span, but no observer is called.
  const beforeUnbound = received.length
  yield* Orders.get({ orderId: "o-1" }).asEffect().pipe(Effect.provide(Reporting))
  assertEq(received.length, beforeUnbound, "the innermost setting wins for an unbound op")

  // ---------- Pagination: one report per query, every page counted ----------
  for (const n of [2, 3, 4, 5]) {
    yield* db.entities.Orders.put({ orderId: `o-${n}`, customerId: "c-1", total: n * 10 })
  }
  // #region pagination
  const orders = yield* db.entities.Orders.byCustomer({ customerId: "c-1" }).pageSize(2).collect()

  const query = last()
  // query.operation          → "Entity.query"
  // query.index              → "byCustomer"
  // query.requests           → 3   (pages of 2, 2 and 1)
  // query.requestsByCommand  → { Query: 3 }
  // #endregion
  assertEq(orders.length, 5, "five orders")
  assertEq(
    [query.operation, query.index, query.requests, query.requestsByCommand],
    ["Entity.query", "byCustomer", 3, { Query: 3 }],
    "query report",
  )
  yield* Console.log(`${query.operation}: ${query.requests} pages`)

  // ---------- Nesting: one report for the handler ----------
  // #region nesting
  const handle = EventStore.commandHandler(deposit, Ledgers)
  yield* handle({ accountId: "a-1" }, 25)

  const handled = last()
  // handled.operation  → "EventStore.commandHandler"
  // handled.nested     → [{ operation: "EventStream.read", calls: 1, ... },
  //                       { operation: "EventStream.append", calls: 1, ... }]
  // handled.capacityUnits includes both: never add the nested totals again.
  // #endregion
  assertEq(
    handled.nested.map((child) => child.operation),
    ["EventStream.read", "EventStream.append"],
    "handler nests its read and append",
  )
  assertEq(
    handled.capacityUnits,
    handled.nested.reduce((sum, child) => sum + child.capacityUnits, 0),
    "inclusive totals",
  )

  // ---------- Grouping calls into an application operation ----------
  yield* db.entities.Accounts.put({ accountId: "a-1", orders: 0 })
  // #region custom-operation
  const placeOrder = (input: { orderId: string; accountId: string; total: number }) =>
    Effect.gen(function* () {
      yield* db.entities.Orders.put({
        orderId: input.orderId,
        customerId: input.accountId,
        total: input.total,
      })
      yield* db.entities.Accounts.update({ accountId: input.accountId }).add({ orders: 1 })
    }).pipe(ConsumedCapacity.withOperation("placeOrder", { target: "Order" }))

  yield* placeOrder({ orderId: "o-6", accountId: "a-1", total: 60 })

  const placed = last()
  // placed.operation  → "placeOrder"
  // placed.requests   → 2
  // placed.nested     → Entity.put and Entity.update, one call each
  // #endregion
  assertEq(
    [placed.operation, placed.requests, placed.nested.map((child) => child.operation)],
    ["placeOrder", 2, ["Entity.put", "Entity.update"]],
    "placeOrder report",
  )

  // ---------- A failed write ----------
  // #region failure
  const duplicate = yield* db.entities.Orders.create({
    orderId: "o-1",
    customerId: "c-1",
    total: 40,
  })
    .asEffect()
    .pipe(Effect.flip)

  const failed = last()
  // duplicate._tag              → "ConditionalCheckFailed"
  // failed.outcome              → "failure"
  // failed.requests             → 1
  // failed.unreportedRequests   → 1   (DynamoDB returns no capacity with this error)
  // #endregion
  assertEq(duplicate._tag, "ConditionalCheckFailed", "duplicate create fails")
  assertEq(
    [failed.operation, failed.outcome, failed.requests, failed.unreportedRequests],
    ["Entity.create", "failure", 1, 1],
    "failure report",
  )

  yield* client.deleteTable({ TableName: tableName })
  yield* Console.log(`${received.length} operations reported`)
})

Effect.runPromise(program.pipe(Effect.provide(Layer.mergeAll(AppLayer, ReportingWithObserver)))).then(
  () => console.log("\nDone."),
)
