/**
 * Consumed-capacity coverage matrix (#174, design §11.2 item 12).
 *
 * Every library operation in the design's coverage table (§9.1) is driven
 * once against an in-memory client that answers every data-plane command with
 * `ConsumedCapacity`. Each must report under its own name — and no request may
 * escape into an implicit `DynamoClient.<Command>` root, which is what an
 * operation added without an entry point would produce.
 *
 * The operations run against an in-memory store, so some fail (an `Entity.get`
 * of a missing row, a `drain` of a projection without an outbox): a failed
 * operation still reports, and only the report's name is asserted here.
 */

import { describe, expect, it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Embedder } from "@effect-dynamodb/schema/Embedder.js"
import { Duration, Effect, Layer, Schema, Stream } from "effect"
import { beforeEach } from "vitest"
import * as Aggregate from "../src/Aggregate.js"
import * as Batch from "../src/Batch.js"
import * as Collection from "../src/Collection.js"
import * as ConsumedCapacity from "../src/ConsumedCapacity.js"
import { CheckpointStore } from "../src/change-feed/index.js"
import { DynamoClient, type DynamoClientService } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
import * as Query from "../src/Query.js"
import * as Table from "../src/Table.js"
import * as Transaction from "../src/Transaction.js"
import {
  clientLayer,
  collectReports,
  serviceOf,
  withConsumedCapacity,
} from "./helpers/CapacityMock.js"
import { InMemoryClient, resetStore } from "./helpers/InMemoryTables.js"
import { mockDynamoClient } from "./helpers/MockDynamoClient.js"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const AppSchema = DynamoSchema.make({ name: "shop", version: 1 })

class Order extends Schema.Class<Order>("Order")({
  orderId: Schema.String,
  customerId: Schema.String,
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
      collection: "CustomerActivity",
      pk: { field: "gsi1pk", composite: ["customerId"] },
      sk: { field: "gsi1sk", composite: ["orderId"] },
    },
  },
})

class Invoice extends Schema.Class<Invoice>("Invoice")({
  invoiceId: Schema.String,
  customerId: Schema.String,
}) {}

const Invoices = Entity.make({
  model: Invoice,
  entityType: "Invoice",
  primaryKey: {
    pk: { field: "pk", composite: ["invoiceId"] },
    sk: { field: "sk", composite: [] },
  },
  indexes: {
    byCustomer: {
      name: "gsi1",
      collection: "CustomerActivity",
      pk: { field: "gsi1pk", composite: ["customerId"] },
      sk: { field: "gsi1sk", composite: ["invoiceId"] },
    },
  },
})

class Profile extends Schema.Class<Profile>("Profile")({
  profileId: Schema.String,
  name: Schema.String,
}) {}

const Profiles = Entity.make({
  model: Profile,
  entityType: "Profile",
  primaryKey: {
    pk: { field: "pk", composite: ["profileId"] },
    sk: { field: "sk", composite: [] },
  },
  versioned: { retain: true },
  softDelete: true,
})

class Reading extends Schema.Class<Reading>("Reading")({
  sensorId: Schema.String,
  seq: Schema.Number,
  value: Schema.Number,
}) {}

const Readings = Entity.make({
  model: Reading,
  entityType: "Reading",
  primaryKey: {
    pk: { field: "pk", composite: ["sensorId"] },
    sk: { field: "sk", composite: [] },
  },
  timeSeries: {
    orderBy: "seq",
    appendInput: Schema.Struct({
      sensorId: Schema.String,
      seq: Schema.Number,
      value: Schema.Number,
    }),
  },
})

class Product extends Schema.Class<Product>("Product")({
  productId: Schema.String,
  tenantId: Schema.String,
  description: Schema.String,
}) {}

const Products = Entity.make({
  model: Product,
  entityType: "Product",
  primaryKey: {
    pk: { field: "pk", composite: ["tenantId", "productId"] },
    sk: { field: "sk", composite: [] },
  },
  vectorIndexes: {
    byDescription: {
      name: "vec1",
      dimensions: 2,
      distance: "cosine",
      source: { fields: ["description"] },
      partition: ["tenantId"],
    },
  },
})

const LedgerSummary = Schema.Struct({
  ledgerId: Schema.String,
  balance: Schema.Number,
  version: Schema.Number,
})

const LedgerTotal = Schema.Struct({
  ledgerId: Schema.String,
  balance: Schema.Number,
  checkpoints: Schema.Record(Schema.String, Schema.Number),
  revision: Schema.Number,
})

const LedgerTotals = Entity.make({
  model: LedgerTotal,
  entityType: "LedgerTotal",
  primaryKey: {
    pk: { field: "pk", composite: ["ledgerId"] },
    sk: { field: "sk", composite: [] },
  },
})

const LedgerSummaries = Entity.make({
  model: LedgerSummary,
  entityType: "LedgerSummary",
  primaryKey: {
    pk: { field: "pk", composite: ["ledgerId"] },
    sk: { field: "sk", composite: [] },
  },
})

const MainTable = Table.make({
  schema: AppSchema,
  entities: { Orders, Invoices, Profiles, Readings, Products, LedgerSummaries, LedgerTotals },
})

class Deposited extends Schema.Class<Deposited>("Deposited")({ amount: Schema.Number }) {}

const Ledgers = EventStore.makeStream({
  table: MainTable,
  streamName: "Ledger",
  events: [Deposited],
  streamId: { composite: ["ledgerId"] },
  snapshot: { schema: Schema.Struct({ balance: Schema.Number }) },
  indexes: {
    byAmount: {
      index: "lsi1",
      sk: "lsi1sk",
      key: (event: Deposited, version: number) => `${event.amount}#${version}`,
    },
  },
})

const ledgerDecider: EventStore.Decider<{ readonly balance: number }, number, Deposited, never> = {
  initialState: { balance: 0 },
  decide: (amount) => Effect.succeed([new Deposited({ amount })]),
  evolve: (state, event) => ({ balance: state.balance + event.amount }),
}

const LedgerProjection = EventStore.projection({
  stream: Ledgers,
  readModel: LedgerSummaries,
  key: (id) => ({ ledgerId: id.ledgerId }),
  initial: (id) => ({ ledgerId: id.ledgerId, balance: 0, version: 0 }),
  evolve: (state, event) =>
    Effect.succeed({ ...state, balance: state.balance + event.data.amount }),
  checkpoint: "version",
})

const LedgerMultiProjection = EventStore.multiProjection({
  readModel: LedgerTotals,
  initial: (key: { readonly ledgerId: string }) => ({
    ledgerId: key.ledgerId,
    balance: 0,
    checkpoints: {},
    revision: 0,
  }),
  checkpoints: { field: "checkpoints" },
  revision: "revision" as const,
  sources: (
    source: EventStore.SourceBuilder<{ readonly ledgerId: string }, typeof LedgerTotal.Type>,
  ) => ({
    ledger: source(Ledgers, {
      key: (id) => ({ ledgerId: id.ledgerId }),
      evolve: (state, event) =>
        Effect.succeed({ ...state, balance: state.balance + event.data.amount }),
    }),
  }),
})

class Line extends Schema.Class<Line>("Line")({ lineId: Schema.String, sku: Schema.String }) {}

class PurchaseOrder extends Schema.Class<PurchaseOrder>("PurchaseOrder")({
  purchaseOrderId: Schema.String,
  note: Schema.String,
  lines: Schema.Array(Line),
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

const feed = { streamArn: "arn:aws:dynamodb:local:stream/1", consumer: "ledger-reader" }

// ---------------------------------------------------------------------------
// The client: the in-memory tables, plus empty answers for the rest
// ---------------------------------------------------------------------------

const universal = (): DynamoClientService =>
  withConsumedCapacity({
    ...mockDynamoClient({
      scan: () => Effect.succeed({ Items: [], Count: 0 } as never),
      batchGetItem: () => Effect.succeed({ Responses: {}, UnprocessedKeys: {} } as never),
      batchWriteItem: () => Effect.succeed({ UnprocessedItems: {} } as never),
      transactGetItems: () => Effect.succeed({ Responses: [] } as never),
      searchVectors: () => Effect.succeed({ Items: [] } as never),
    }),
    ...serviceOf(InMemoryClient),
  }).service

const FixedEmbedder = Layer.succeed(Embedder, {
  dimensions: 2,
  embed: () => Effect.succeed([1, 0]),
})

const baseLayer = () =>
  Layer.mergeAll(clientLayer(universal()), MainTable.layer({ name: "shop-table" }), FixedEmbedder)

const bindAll = Effect.gen(function* () {
  const db = yield* DynamoClient.make({
    entities: { Orders, Invoices, Profiles, Readings, Products },
    tables: { MainTable },
  })
  const orders = yield* Entity.bind(Orders)
  const ledgers = yield* EventStore.bind(Ledgers)
  const projection = yield* EventStore.bindProjection(LedgerProjection)
  const purchaseOrders = yield* Aggregate.bind(PurchaseOrders)
  return { db, orders, ledgers, projection, purchaseOrders }
})

type Bound = Effect.Success<typeof bindAll>

type Case = readonly [
  operation: string,
  run: (bound: Bound) => Effect.Effect<unknown, unknown, any>,
  setup?: (bound: Bound) => Effect.Effect<unknown, unknown, any>,
]

const drainStream = <A, E, R>(stream: Stream.Stream<A, E, R>) => Stream.runDrain(stream)

const seedOrder = ({ db }: Bound) =>
  db.entities.Orders.put({ orderId: "o-1", customerId: "c-1", total: 1 }).asEffect()
const seedProfile = ({ db }: Bound) =>
  Effect.gen(function* () {
    yield* db.entities.Profiles.put({ profileId: "p-1", name: "Ada" })
    yield* db.entities.Profiles.update({ profileId: "p-1" }).set({ name: "Grace" })
  })
const seedLedger = () =>
  Effect.gen(function* () {
    yield* Ledgers.append({ ledgerId: "l-1" }, [new Deposited({ amount: 5 })], 0)
  })

/** The stream's events, read with reporting off (setup, not the operation under test). */
const ledgerEvents = Ledgers.read({ ledgerId: "l-1" }).pipe(
  Effect.provide(ConsumedCapacity.disabled),
)

const ordersQuery = () => Orders.query.byCustomer({ customerId: "c-1" })

type Checkpoints = Effect.Success<ReturnType<typeof CheckpointStore.makeDynamoDB>>
const lease = Duration.seconds(30)

/** Each checkpoint method, on a store built against the table's client. */
const checkpointCases = (
  methods: ReadonlyArray<
    readonly [string, (store: Checkpoints) => Effect.Effect<unknown, unknown>]
  >,
): ReadonlyArray<Case> =>
  methods.map(([name, run]) => [
    name,
    () =>
      Effect.flatMap(CheckpointStore.makeDynamoDB({ tableName: "checkpoints" }), (store) =>
        run(store),
      ),
  ])

const cases: ReadonlyArray<Case> = [
  // Entity CRUD — bound and unbound
  ["Entity.get", ({ db }) => db.entities.Orders.get({ orderId: "o-1" }).asEffect(), seedOrder],
  ["Entity.get", () => Orders.get({ orderId: "o-1" }).asEffect(), seedOrder],
  [
    "Entity.put",
    ({ db }) => db.entities.Orders.put({ orderId: "o-1", customerId: "c", total: 1 }).asEffect(),
  ],
  ["Entity.create", () => Orders.create({ orderId: "o-2", customerId: "c", total: 1 }).asEffect()],
  [
    "Entity.upsert",
    ({ db }) => db.entities.Orders.upsert({ orderId: "o-1", customerId: "c", total: 1 }).asEffect(),
  ],
  [
    "Entity.update",
    ({ db }) => db.entities.Orders.update({ orderId: "o-1" }).set({ total: 2 }).asEffect(),
    seedOrder,
  ],
  [
    "Entity.patch",
    ({ db }) => db.entities.Orders.patch({ orderId: "o-1" }).set({ total: 2 }).asEffect(),
    seedOrder,
  ],
  [
    "Entity.delete",
    ({ db }) => db.entities.Orders.delete({ orderId: "o-1" }).asEffect(),
    seedOrder,
  ],
  ["Entity.delete", () => Orders.delete({ orderId: "o-1" }).asEffect(), seedOrder],
  [
    "Entity.deleteIfExists",
    ({ db }) => db.entities.Orders.deleteIfExists({ orderId: "o-1" }).asEffect(),
    seedOrder,
  ],
  // Lifecycle
  [
    "Entity.getVersion",
    ({ db }) => db.entities.Profiles.getVersion({ profileId: "p-1" }, 1),
    seedProfile,
  ],
  [
    "Entity.versions",
    ({ db }) => db.entities.Profiles.versions({ profileId: "p-1" }).collect(),
    seedProfile,
  ],
  ["Entity.restore", ({ db }) => db.entities.Profiles.restore({ profileId: "p-1" }), seedProfile],
  ["Entity.purge", ({ db }) => db.entities.Profiles.purge({ profileId: "p-1" }), seedProfile],
  ["Entity.deleted.get", ({ db }) => db.entities.Profiles.deleted.get({ profileId: "p-1" })],
  [
    "Entity.deleted.list",
    ({ db }) => db.entities.Profiles.deleted.list({ profileId: "p-1" }).collect(),
  ],
  // Time series
  [
    "Entity.append",
    ({ db }) =>
      Effect.gen(function* () {
        yield* db.entities.Readings.append({ sensorId: "s-1", seq: 1, value: 3 })
      }),
  ],
  ["Entity.history", ({ db }) => db.entities.Readings.history({ sensorId: "s-1" }).collect()],
  // Queries — every terminal of the bound builder
  [
    "Entity.query",
    ({ db }) => db.entities.Orders.byCustomer({ customerId: "c-1" }).collect(),
    seedOrder,
  ],
  ["Entity.query", ({ db }) => db.entities.Orders.byCustomer({ customerId: "c-1" }).fetch()],
  ["Entity.query", ({ db }) => db.entities.Orders.byCustomer({ customerId: "c-1" }).count()],
  [
    "Entity.query",
    ({ db }) => drainStream(db.entities.Orders.byCustomer({ customerId: "c-1" }).paginate()),
  ],
  ["Entity.scan", ({ db }) => db.entities.Orders.scan().collect()],
  ["Entity.scan", ({ orders }) => orders.scanFetch()],
  ["Entity.collect", ({ orders }) => orders.collect(ordersQuery())],
  ["Entity.fetch", ({ orders }) => orders.fetch(ordersQuery())],
  ["Entity.paginate", ({ orders }) => drainStream(orders.paginate(ordersQuery()))],
  // Vectors
  [
    "Entity.vectorSearch",
    ({ db }) =>
      db.entities.Products.byDescription("boots").partition({ tenantId: "t-1" }).topK(2).collect(),
  ],
  ["Entity.reembed", ({ db }) => db.entities.Products.reembed()],
  // Query terminals run directly
  ["Query.collect", () => Query.collect(ordersQuery())],
  ["Query.execute", () => Query.execute(ordersQuery())],
  ["Query.count", () => Query.count(ordersQuery())],
  ["Query.paginate", () => Effect.flatMap(Query.paginate(ordersQuery()), drainStream)],
  // Collections
  [
    "Collection.query",
    ({ db }) => db.collections.CustomerActivity!({ customerId: "c-1" }).collect(),
  ],
  [
    "Query.collect",
    () =>
      Query.collect(
        Collection.make("CustomerActivity", { Orders, Invoices }).query({ customerId: "c-1" }),
      ),
  ],
  // Batch + transactions
  ["Batch.get", () => Batch.get([Orders.get({ orderId: "o-1" })])],
  ["Batch.write", () => Batch.write([Orders.put({ orderId: "o-1", customerId: "c", total: 1 })])],
  ["Transaction.transactGet", () => Transaction.transactGet([Orders.get({ orderId: "o-1" })])],
  [
    "Transaction.transactWrite",
    () => Transaction.transactWrite([Orders.put({ orderId: "o-1", customerId: "c", total: 1 })]),
  ],
  // Aggregates
  [
    "Aggregate.create",
    () =>
      PurchaseOrders.create({
        purchaseOrderId: "po-1",
        note: "n",
        lines: [{ lineId: "l-1", sku: "A" }],
      }),
  ],
  ["Aggregate.get", () => PurchaseOrders.get({ purchaseOrderId: "po-1" })],
  [
    "Aggregate.update",
    () => PurchaseOrders.update({ purchaseOrderId: "po-1" }, ({ state }) => state),
  ],
  ["Aggregate.get", ({ purchaseOrders }) => purchaseOrders.get({ purchaseOrderId: "po-1" })],
  ["Aggregate.delete", () => PurchaseOrders.delete({ purchaseOrderId: "po-1" })],
  ["Aggregate.list", () => (PurchaseOrders as any).list({ purchaseOrderId: "po-1" })],
  // Event streams
  [
    "EventStream.append",
    () => Ledgers.append({ ledgerId: "l-1" }, [new Deposited({ amount: 1 })], 0),
  ],
  ["EventStream.read", () => Ledgers.read({ ledgerId: "l-1" }), seedLedger],
  ["EventStream.read", ({ ledgers }) => ledgers.read({ ledgerId: "l-1" }), seedLedger],
  [
    "EventStream.append",
    ({ ledgers }) => ledgers.append({ ledgerId: "l-1" }, [new Deposited({ amount: 1 })], 1),
    seedLedger,
  ],
  ["EventStream.readFrom", () => Ledgers.readFrom({ ledgerId: "l-1" }, 1), seedLedger],
  ["EventStream.currentVersion", () => Ledgers.currentVersion({ ledgerId: "l-1" }), seedLedger],
  ["EventStream.readLatest", () => Ledgers.readLatest({ ledgerId: "l-1" }), seedLedger],
  ["EventStream.readIndex", () => Ledgers.readIndex("byAmount", { ledgerId: "l-1" }), seedLedger],
  ["EventStream.readSnapshot", () => Ledgers.readSnapshot({ ledgerId: "l-1" })],
  [
    "EventStream.writeSnapshot",
    () => Ledgers.writeSnapshot({ ledgerId: "l-1" }, { balance: 5 }, 1),
    seedLedger,
  ],
  ["Query.collect", () => Query.collect(Ledgers.query.events({ ledgerId: "l-1" }))],
  [
    "EventStore.commandHandler",
    () => EventStore.commandHandler(ledgerDecider, Ledgers)({ ledgerId: "l-1" }, 5),
  ],
  [
    "EventStore.commandHandler",
    ({ ledgers }) => EventStore.commandHandler(ledgerDecider, ledgers)({ ledgerId: "l-1" }, 5),
  ],
  // Projections
  [
    "Projection.applyBatch",
    () => Effect.flatMap(ledgerEvents, (events) => LedgerProjection.applyBatch(events)),
    seedLedger,
  ],
  [
    "Projection.apply",
    () => Effect.flatMap(ledgerEvents, (events) => LedgerProjection.apply(events[0]!)),
    seedLedger,
  ],
  ["Projection.catchUp", () => LedgerProjection.catchUp({ ledgerId: "l-1" }), seedLedger],
  ["Projection.catchUp", ({ projection }) => projection.catchUp({ ledgerId: "l-1" }), seedLedger],
  ["Projection.rebuild", () => LedgerProjection.rebuild({ ledgerId: "l-1" }), seedLedger],
  ["Projection.processBatch", () => LedgerProjection.processBatch([], { source: "lambda" })],
  [
    "Projection.drain",
    () => (LedgerProjection as any).drain({ ledgerId: "l-1" }, () => Effect.void),
  ],
  ["Projection.drainPending", () => (LedgerProjection as any).drainPending(() => Effect.void)],
  [
    "MultiProjection.applyBatch",
    () =>
      Effect.flatMap(ledgerEvents, (events) =>
        LedgerMultiProjection.applyBatch(
          events.map((event) => ({ stream: "ledger" as const, event })),
        ),
      ),
    seedLedger,
  ],
  ["MultiProjection.catchUp", () => LedgerMultiProjection.catchUp({ ledgerId: "l-1" }), seedLedger],
  ["MultiProjection.rebuild", () => LedgerMultiProjection.rebuild({ ledgerId: "l-1" }), seedLedger],
  [
    "MultiProjection.processBatch",
    () => LedgerMultiProjection.processBatch([], { source: "lambda" }),
  ],
  [
    "EventStore.processBatch",
    () =>
      EventStore.processBatch([], {
        projections: { ledger: LedgerProjection },
        source: "lambda",
      } as any),
  ],
  // Change-feed checkpoints
  ...checkpointCases([
    ["CheckpointStore.load", (store) => store.load(feed)],
    ["CheckpointStore.commit", (store) => store.commit(feed, "shard-1", { _tag: "Finished" })],
    ["CheckpointStore.acquireLease", (store) => store.acquireLease(feed, "a", lease)],
    ["CheckpointStore.renewLease", (store) => store.renewLease(feed, "a", lease)],
    ["CheckpointStore.releaseLease", (store) => store.releaseLease(feed, "a")],
  ]),
]

beforeEach(() => resetStore())

describe("consumed-capacity coverage", () => {
  for (const [operation, run, setup] of cases) {
    it.effect(`${operation} reports under its own name`, () =>
      Effect.gen(function* () {
        const layer = baseLayer()
        const bound = yield* bindAll.pipe(Effect.provide(layer))
        if (setup !== undefined) yield* setup(bound).pipe(Effect.provide(layer), Effect.orDie)
        const { reports, onOperation } = collectReports()
        yield* run(bound).pipe(
          Effect.exit,
          Effect.provide(ConsumedCapacity.layer({ onOperation })),
          Effect.provide(layer),
        )
        const names = reports.map((report) => report.operation)
        expect(names.filter((name) => name.startsWith("DynamoClient."))).toEqual([])
        expect(names).toEqual([operation])
      }),
    )
  }
})

describe("consumed-capacity targets", () => {
  it.effect("a stream's queries report under the stream name, as its operations do", () =>
    Effect.gen(function* () {
      const layer = baseLayer()
      yield* seedLedger().pipe(Effect.provide(layer), Effect.orDie)
      const { reports, onOperation } = collectReports()
      yield* Effect.gen(function* () {
        yield* Ledgers.read({ ledgerId: "l-1" })
        yield* Query.collect(Ledgers.query.events({ ledgerId: "l-1" }))
        yield* Query.collect(Ledgers.query.index("byAmount", { ledgerId: "l-1" }))
        yield* Stream.runCollect(yield* Query.paginate(Ledgers.query.events({ ledgerId: "l-1" })))
        yield* Query.count(Ledgers.query.events({ ledgerId: "l-1" }))
      }).pipe(Effect.provide(ConsumedCapacity.layer({ onOperation })), Effect.provide(layer))
      expect(reports.map((report) => [report.operation, report.target])).toEqual([
        ["EventStream.read", "Ledger"],
        ["Query.collect", "Ledger"],
        ["Query.collect", "Ledger"],
        ["Query.paginate", "Ledger"],
        ["Query.count", "Ledger"],
      ])
    }),
  )
})
