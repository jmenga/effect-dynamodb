/**
 * One read model fed by several projections (#154), each keeping its own checkpoint fields, three
 * of them with `removal` and one without: `create` over a tombstone carries every projection's
 * checkpoints it holds, not those of whichever projection was defined last. A row two of them feed
 * keeps both projections' checkpoints when one removes it, and when a write replaces the tombstone,
 * whether or not the other has `removal`. Each of those writes raises every projection's revision
 * the row holds, and gives a row no revision it didn't hold. A read model whose
 * checkpoint map is a sparse map has its tombstone refused as its row is. The scenarios run against
 * the in-memory tables and against DynamoDB Local; `rowOf` reads a row (or tombstone) back raw.
 */

import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Effect, Schema } from "effect"
import { expect } from "vitest"
import type { DynamoClient } from "../../src/DynamoClient.js"
import * as Entity from "../../src/Entity.js"
import * as EventStore from "../../src/EventStore.js"
import * as Table from "../../src/Table.js"
import * as Transaction from "../../src/Transaction.js"

const AppSchema = DynamoSchema.make({ name: "layouts", version: 1 })

export class Placed extends Schema.TaggedClass<Placed>()("Placed", { amount: Schema.Number }) {}
export class Cancelled extends Schema.TaggedClass<Cancelled>()("Cancelled", {}) {}
export type LedgerEvent = Placed | Cancelled

export const EventsTable = Table.make({ schema: AppSchema, entities: {} })
export const Orders = EventStore.makeStream({
  table: EventsTable,
  streamName: "Order",
  events: [Placed, Cancelled],
  streamId: { composite: ["orderId"] },
})
export const Shipments = EventStore.makeStream({
  table: EventsTable,
  streamName: "Shipment",
  events: [Placed, Cancelled],
  streamId: { composite: ["shipmentId"] },
})
export const Invoices = EventStore.makeStream({
  table: EventsTable,
  streamName: "Invoice",
  events: [Placed, Cancelled],
  streamId: { composite: ["invoiceId"] },
})
const Payments = EventStore.makeStream({
  table: EventsTable,
  streamName: "Payment",
  events: [Placed],
  streamId: { composite: ["paymentId"] },
})

const Ledger = Schema.Struct({
  id: Schema.String,
  total: Schema.Number,
  orderVersion: Schema.optional(Schema.Number),
  orderRev: Schema.optional(Schema.Number),
  checkpoints: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
  invoiceVersion: Schema.optional(Schema.Number),
  paymentVersion: Schema.optional(Schema.Number),
  revision: Schema.optional(Schema.Number),
})
export type Ledger = typeof Ledger.Type

export const Ledgers = Entity.make({
  model: Ledger,
  entityType: "Ledger",
  primaryKey: {
    pk: { field: "pk", composite: ["id"] },
    sk: { field: "sk", composite: [] },
  },
})

/**
 * A read model whose checkpoint map is stored as a sparse map. Its keys are `<source>#<streamId>`,
 * which a sparse map can't hold, so every write of a row is refused, and so is a tombstone's. A
 * projection keeping its checkpoint in fields of its own leaves the map empty, and runs.
 */
const SparseLedger = Schema.Struct({
  id: Schema.String,
  total: Schema.Number,
  checkpoints: Schema.Record(Schema.String, Schema.Number),
  revision: Schema.optional(Schema.Number),
  shipmentVersion: Schema.optional(Schema.Number),
  shipmentOwner: Schema.optional(Schema.String),
})
export type SparseLedger = typeof SparseLedger.Type

export const SparseLedgers = Entity.make({
  model: DynamoModel.configure(SparseLedger, {
    checkpoints: { storedAs: DynamoModel.SparseMap({ prefix: "cp" }) },
  }),
  entityType: "SparseLedger",
  primaryKey: {
    pk: { field: "pk", composite: ["id"] },
    sk: { field: "sk", composite: [] },
  },
})
export const ReadTable = Table.make({
  schema: AppSchema,
  entities: { Ledgers, SparseLedgers },
})

export const evolve = (state: Ledger, event: EventStore.StreamEvent<LedgerEvent>) =>
  Effect.succeed(
    event.data._tag === "Cancelled"
      ? EventStore.removeRow
      : { ...state, total: state.total + event.data.amount },
  )

// Defined in this order: the order projection first, the invoice projection last.
const ByOrder = EventStore.projection({
  stream: Orders,
  readModel: Ledgers,
  key: (id: { readonly orderId: string }) => ({ id: id.orderId }),
  initial: (id: { readonly orderId: string }): Ledger => ({ id: id.orderId, total: 0 }),
  evolve,
  checkpoint: "orderVersion",
  revision: "orderRev",
  removal: {},
})
const ByShipment = EventStore.multiProjection({
  readModel: Ledgers,
  initial: (key): Ledger => ({ id: key.id, total: 0 }),
  sources: (source) => ({
    shipment: source(Shipments, {
      key: (id: { readonly shipmentId: string }) => ({ id: id.shipmentId }),
      evolve,
    }),
  }),
  checkpoints: { field: "checkpoints" },
  revision: "revision",
  removal: {},
})
const ByInvoice = EventStore.projection({
  stream: Invoices,
  readModel: Ledgers,
  key: (id: { readonly invoiceId: string }) => ({ id: id.invoiceId }),
  initial: (id: { readonly invoiceId: string }): Ledger => ({ id: id.invoiceId, total: 0 }),
  evolve,
  checkpoint: "invoiceVersion",
  // Shared with the multi-source projection: a tombstone is told apart by the fields it holds.
  revision: "revision",
  removal: {},
})

// No `removal`: its checkpoint is kept on the row through the other projections' tombstones.
const ByPayment = EventStore.projection({
  stream: Payments,
  readModel: Ledgers,
  key: (id: { readonly paymentId: string }) => ({ id: id.paymentId }),
  initial: (id: { readonly paymentId: string }): Ledger => ({ id: id.paymentId, total: 0 }),
  evolve: (state: Ledger, event: EventStore.StreamEvent<Placed>) =>
    Effect.succeed({ ...state, total: state.total + event.data.amount }),
  checkpoint: "paymentVersion",
  revision: "revision",
})

const Notice = Schema.Struct({ id: Schema.String })

// With an outbox, so the engine writes the row and the tombstone alike, with its own put.
const BySparseShipment = EventStore.multiProjection({
  readModel: SparseLedgers,
  initial: (key): SparseLedger => ({ id: key.id, total: 0, checkpoints: {} }),
  sources: (source) => ({
    shipment: source(Shipments, {
      key: (id: { readonly shipmentId: string }) => ({ id: id.shipmentId }),
      evolve: (state: SparseLedger, event: EventStore.StreamEvent<LedgerEvent>) =>
        Effect.succeed(
          event.data._tag === "Cancelled"
            ? EventStore.removeRow
            : { ...state, total: state.total + event.data.amount },
        ),
    }),
  }),
  checkpoints: { field: "checkpoints" },
  revision: "revision",
  removal: {},
  outbox: { schema: Notice, effects: (event) => [{ id: event.streamId }] },
})

/** Placed, then cancelled: the projection's row ends removed, its tombstone at version 2. */
const history = [new Placed({ amount: 1 }), new Cancelled({})]

type RowOf = (
  id: string,
) => Effect.Effect<Record<string, unknown> | undefined, unknown, DynamoClient>

/** The scenarios, reading rows back through `rowOf`; `run` tells them apart between runs. */
export const scenarios = (rowOf: RowOf, run = "") => {
  const id = (name: string) => `${name}${run}`

  /** A tombstone of the first projection, then of the last, each created over by the entity. */
  const firstAndLast = Effect.gen(function* () {
    const o1 = id("o1")
    yield* Orders.append({ orderId: o1 }, history, 0)
    const orders = yield* Orders.read({ orderId: o1 })
    yield* ByOrder.applyBatch(orders)
    expect(yield* rowOf(o1)).toMatchObject({
      __edd_e__: "Ledger#tombstone",
      orderVersion: 2,
      orderRev: 1,
    })
    yield* Ledgers.create({ id: o1, total: 9 }).asEffect()
    // The first projection's checkpoint and revision, carried over.
    expect(yield* rowOf(o1)).toMatchObject({
      __edd_e__: "Ledger",
      total: 9,
      orderVersion: 2,
      orderRev: 2,
    })
    // So a late redelivery of the removal is already applied: the created row stays.
    const late = yield* ByOrder.apply(orders[1]!)
    expect(late.applied).toEqual([])
    expect(late.removed).toBe(false)
    expect(yield* rowOf(o1)).toMatchObject({ __edd_e__: "Ledger", total: 9, orderRev: 2 })

    // The last projection's tombstone, as before.
    const i1 = id("i1")
    yield* Invoices.append({ invoiceId: i1 }, history, 0)
    const invoices = yield* Invoices.read({ invoiceId: i1 })
    yield* ByInvoice.applyBatch(invoices)
    yield* Ledgers.create({ id: i1, total: 4 }).asEffect()
    const created = yield* rowOf(i1)
    expect(created).toMatchObject({
      __edd_e__: "Ledger",
      total: 4,
      invoiceVersion: 2,
      revision: 2,
    })
    expect(created!.checkpoints).toBeUndefined()
    expect((yield* ByInvoice.apply(invoices[1]!)).applied).toEqual([])
  })

  const tagged = (from: ReadonlyArray<EventStore.StreamEvent<LedgerEvent>>) =>
    from.map((event) => ({ stream: "shipment" as const, event }))

  /** The multi-source projection's tombstone: its checkpoint map and the revision it shares. */
  const multiSource = Effect.gen(function* () {
    const s1 = id("s1")
    yield* Shipments.append({ shipmentId: s1 }, history, 0)
    const events = yield* Shipments.read({ shipmentId: s1 })
    yield* ByShipment.applyBatch(tagged(events))
    expect(yield* rowOf(s1)).toMatchObject({
      __edd_e__: "Ledger#tombstone",
      checkpoints: { [`shipment#${s1}`]: 2 },
      revision: 1,
    })
    yield* Ledgers.create({ id: s1, total: 3 }).asEffect()
    const created = yield* rowOf(s1)
    expect(created).toMatchObject({
      __edd_e__: "Ledger",
      total: 3,
      checkpoints: { [`shipment#${s1}`]: 2 },
      revision: 2,
    })
    expect(created!.invoiceVersion).toBeUndefined()
    const late = yield* ByShipment.applyBatch(tagged(events.slice(1)))
    const outcome = late.outcomes[0]!
    if (outcome._tag !== "Applied") throw new Error("not applied")
    expect(outcome.removed).toBe(false)
    expect(yield* rowOf(s1)).toMatchObject({ __edd_e__: "Ledger", total: 3, revision: 2 })
  })

  /** The first projection's tombstone, created over in a transaction. */
  const transactional = Effect.gen(function* () {
    const o2 = id("o2")
    yield* Orders.append({ orderId: o2 }, history, 0)
    const orders = yield* Orders.read({ orderId: o2 })
    yield* ByOrder.applyBatch(orders)
    yield* Transaction.transactWrite([Ledgers.create({ id: o2, total: 5 })])
    expect(yield* rowOf(o2)).toMatchObject({
      __edd_e__: "Ledger",
      total: 5,
      orderVersion: 2,
      orderRev: 2,
    })
    const late = yield* ByOrder.apply(orders[1]!)
    expect(late.applied).toEqual([])
    expect(yield* rowOf(o2)).toMatchObject({ __edd_e__: "Ledger", total: 5, orderRev: 2 })
  })

  /**
   * One row fed by the order and invoice projections; the order projection removes it. The
   * tombstone keeps the invoice projection's checkpoint as well as its own, and raises its
   * revision, so a redelivery of an invoice event is already applied, and the stream's next event
   * starts the row from `initial` at that checkpoint. The row it writes keeps the order projection's
   * checkpoint in turn, and raises its revision, so a late redelivery of the removal is already
   * applied.
   */
  const sharedRow = Effect.gen(function* () {
    const x1 = id("x1")
    yield* Invoices.append({ invoiceId: x1 }, [new Placed({ amount: 5 })], 0)
    const invoices = yield* Invoices.read({ invoiceId: x1 })
    yield* ByInvoice.applyBatch(invoices)
    yield* Orders.append({ orderId: x1 }, history, 0)
    const orders = yield* Orders.read({ orderId: x1 })
    yield* ByOrder.applyBatch(orders)
    expect(yield* rowOf(x1)).toMatchObject({
      __edd_e__: "Ledger#tombstone",
      orderVersion: 2,
      orderRev: 1,
      invoiceVersion: 1,
      revision: 2,
    })
    const redelivered = yield* ByInvoice.apply(invoices[0]!)
    expect(redelivered.applied).toEqual([])
    expect(redelivered.alreadyApplied).toHaveLength(1)
    expect(yield* rowOf(x1)).toMatchObject({ __edd_e__: "Ledger#tombstone", invoiceVersion: 1 })

    yield* Invoices.append({ invoiceId: x1 }, [new Placed({ amount: 7 })], 1)
    const next = (yield* Invoices.read({ invoiceId: x1 }))[1]!
    expect((yield* ByInvoice.apply(next)).applied).toHaveLength(1)
    expect(yield* rowOf(x1)).toMatchObject({
      __edd_e__: "Ledger",
      total: 7,
      invoiceVersion: 2,
      revision: 3,
      orderVersion: 2,
      orderRev: 2,
    })
    const late = yield* ByOrder.apply(orders[1]!)
    expect(late.applied).toEqual([])
    expect(late.removed).toBe(false)
    expect(yield* rowOf(x1)).toMatchObject({ __edd_e__: "Ledger", total: 7 })
  })

  /**
   * One row fed by the multi-source and order projections; the order projection removes it, then
   * the entity's `create` takes the tombstone's place. It carries both projections' checkpoints,
   * and both revisions one higher than the tombstone's, which raised the multi-source one already.
   */
  const sharedCreate = Effect.gen(function* () {
    const x2 = id("x2")
    yield* Shipments.append({ shipmentId: x2 }, [new Placed({ amount: 2 })], 0)
    const shipments = yield* Shipments.read({ shipmentId: x2 })
    yield* ByShipment.applyBatch(tagged(shipments))
    yield* Orders.append({ orderId: x2 }, history, 0)
    const orders = yield* Orders.read({ orderId: x2 })
    yield* ByOrder.applyBatch(orders)
    expect(yield* rowOf(x2)).toMatchObject({
      __edd_e__: "Ledger#tombstone",
      orderVersion: 2,
      orderRev: 1,
      checkpoints: { [`shipment#${x2}`]: 1 },
      revision: 2,
    })
    yield* Ledgers.create({ id: x2, total: 3 }).asEffect()
    expect(yield* rowOf(x2)).toMatchObject({
      __edd_e__: "Ledger",
      total: 3,
      orderVersion: 2,
      orderRev: 2,
      checkpoints: { [`shipment#${x2}`]: 1 },
      revision: 3,
    })
    const late = (yield* ByShipment.applyBatch(tagged(shipments))).outcomes[0]!
    if (late._tag !== "Applied") throw new Error("not applied")
    expect(late.instances[0]!.applied).toEqual([])
    expect((yield* ByOrder.apply(orders[1]!)).applied).toEqual([])
    expect(yield* rowOf(x2)).toMatchObject({ __edd_e__: "Ledger", total: 3 })
  })

  /**
   * The order projection removes a row the invoice projection feeds; then the invoice projection
   * removes it too. Its tombstone, written over the order projection's, keeps the order
   * projection's checkpoint, and raises its revision.
   */
  const sharedTwice = Effect.gen(function* () {
    const x3 = id("x3")
    yield* Invoices.append({ invoiceId: x3 }, [new Placed({ amount: 5 })], 0)
    yield* ByInvoice.applyBatch(yield* Invoices.read({ invoiceId: x3 }))
    yield* Orders.append({ orderId: x3 }, history, 0)
    const orders = yield* Orders.read({ orderId: x3 })
    yield* ByOrder.applyBatch(orders)
    yield* Invoices.append({ invoiceId: x3 }, [new Cancelled({})], 1)
    const cancelled = (yield* Invoices.read({ invoiceId: x3 }))[1]!
    expect((yield* ByInvoice.apply(cancelled)).removed).toBe(true)
    expect(yield* rowOf(x3)).toMatchObject({
      __edd_e__: "Ledger#tombstone",
      invoiceVersion: 2,
      revision: 3,
      orderVersion: 2,
      orderRev: 2,
    })
    expect((yield* ByOrder.apply(orders[1]!)).applied).toEqual([])
  })

  /**
   * One row fed by the payment projection, which has no `removal`, and the order projection, which
   * removes it. The tombstone keeps the payment projection's checkpoint, and so does the entity's
   * `create` over it, each raising its revision, so a redelivery of the payment event is already
   * applied.
   */
  const withoutRemoval = Effect.gen(function* () {
    const x4 = id("x4")
    yield* Payments.append({ paymentId: x4 }, [new Placed({ amount: 5 })], 0)
    const payments = yield* Payments.read({ paymentId: x4 })
    yield* ByPayment.applyBatch(payments)
    yield* Orders.append({ orderId: x4 }, history, 0)
    const orders = yield* Orders.read({ orderId: x4 })
    yield* ByOrder.applyBatch(orders)
    expect(yield* rowOf(x4)).toMatchObject({
      __edd_e__: "Ledger#tombstone",
      orderVersion: 2,
      orderRev: 1,
      paymentVersion: 1,
      revision: 2,
    })
    expect((yield* ByPayment.apply(payments[0]!)).applied).toEqual([])
    yield* Ledgers.create({ id: x4, total: 3 }).asEffect()
    expect(yield* rowOf(x4)).toMatchObject({
      __edd_e__: "Ledger",
      total: 3,
      orderVersion: 2,
      orderRev: 2,
      paymentVersion: 1,
      revision: 3,
    })
    expect((yield* ByPayment.apply(payments[0]!)).applied).toEqual([])
    expect((yield* ByOrder.apply(orders[1]!)).applied).toEqual([])
    expect(yield* rowOf(x4)).toMatchObject({ __edd_e__: "Ledger", total: 3 })
  })

  /**
   * The order projection removes a row, and `create` takes the tombstone's place; then the invoice
   * projection removes the created row. Its tombstone keeps the order projection's checkpoint the
   * row held, and so does the next `create`, so a late redelivery of the order's removal is already
   * applied. The first tombstone and the row created over it hold no revision of the invoice
   * projection, so they get none; its own first write sets it, and every write after raises both.
   */
  const removedTwice = Effect.gen(function* () {
    const x5 = id("x5")
    yield* Orders.append({ orderId: x5 }, history, 0)
    const orders = yield* Orders.read({ orderId: x5 })
    yield* ByOrder.applyBatch(orders)
    yield* Ledgers.create({ id: x5, total: 1 }).asEffect()
    expect(yield* rowOf(x5)).not.toHaveProperty("revision")
    yield* Invoices.append({ invoiceId: x5 }, history, 0)
    yield* ByInvoice.applyBatch(yield* Invoices.read({ invoiceId: x5 }))
    expect(yield* rowOf(x5)).toMatchObject({
      __edd_e__: "Ledger#tombstone",
      invoiceVersion: 2,
      revision: 1,
      orderVersion: 2,
      orderRev: 3,
    })
    yield* Ledgers.create({ id: x5, total: 2 }).asEffect()
    expect(yield* rowOf(x5)).toMatchObject({
      __edd_e__: "Ledger",
      total: 2,
      invoiceVersion: 2,
      revision: 2,
      orderVersion: 2,
      orderRev: 4,
    })
    const late = yield* ByOrder.apply(orders[1]!)
    expect(late.applied).toEqual([])
    expect(late.removed).toBe(false)
    expect(yield* rowOf(x5)).toMatchObject({ __edd_e__: "Ledger", total: 2 })
  })

  /**
   * A checkpoint map stored as a sparse map: its row write and its tombstone write are refused
   * alike, with nothing written. `sparse` returns the two refusals, each with its stream id named
   * `<id>`.
   */
  const sparse = Effect.gen(function* () {
    const s4 = id("s4")
    const s5 = id("s5")
    yield* Shipments.append({ shipmentId: s4 }, [new Placed({ amount: 1 })], 0)
    yield* Shipments.append({ shipmentId: s5 }, history, 0)
    const refusal = (
      outcome: { readonly _tag: string; readonly error?: unknown } | undefined,
      streamId: string,
    ) => {
      if (outcome?._tag !== "Failed") throw new Error(`not refused: ${outcome?._tag}`)
      const error = outcome.error as {
        readonly _tag: string
        readonly operation: string
        readonly cause: string
      }
      return { ...error, _tag: error._tag, cause: error.cause.replace(streamId, "<id>") }
    }
    const row = yield* BySparseShipment.applyBatch(
      tagged(yield* Shipments.read({ shipmentId: s4 })),
    )
    const tombstone = yield* BySparseShipment.applyBatch(
      tagged(yield* Shipments.read({ shipmentId: s5 })),
    )
    expect(yield* rowOf(s4)).toBeUndefined()
    expect(yield* rowOf(s5)).toBeUndefined()
    return { row: refusal(row.outcomes[0], s4), tombstone: refusal(tombstone.outcomes[0], s5) }
  })

  return {
    firstAndLast,
    multiSource,
    transactional,
    sharedRow,
    sharedCreate,
    sharedTwice,
    withoutRemoval,
    removedTwice,
    sparse,
  }
}
