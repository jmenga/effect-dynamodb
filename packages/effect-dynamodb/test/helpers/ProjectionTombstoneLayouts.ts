/**
 * One read model fed by three projections with `removal` (#154), each keeping its own checkpoint
 * fields: `create` over a tombstone carries the fields of the projection that wrote it, not those of
 * whichever projection was defined last. The scenarios run against the in-memory tables and against
 * DynamoDB Local; `rowOf` reads a row (or tombstone) back raw.
 */

import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Effect, Schema } from "effect"
import { expect } from "vitest"
import type { DynamoClient } from "../../src/DynamoClient.js"
import * as Entity from "../../src/Entity.js"
import * as EventStore from "../../src/EventStore.js"
import * as Table from "../../src/Table.js"
import * as Transaction from "../../src/Transaction.js"

const AppSchema = DynamoSchema.make({ name: "layouts", version: 1 })

class Placed extends Schema.TaggedClass<Placed>()("Placed", { amount: Schema.Number }) {}
class Cancelled extends Schema.TaggedClass<Cancelled>()("Cancelled", {}) {}
type LedgerEvent = Placed | Cancelled

export const EventsTable = Table.make({ schema: AppSchema, entities: {} })
export const Orders = EventStore.makeStream({
  table: EventsTable,
  streamName: "Order",
  events: [Placed, Cancelled],
  streamId: { composite: ["orderId"] },
})
const Shipments = EventStore.makeStream({
  table: EventsTable,
  streamName: "Shipment",
  events: [Placed, Cancelled],
  streamId: { composite: ["shipmentId"] },
})
const Invoices = EventStore.makeStream({
  table: EventsTable,
  streamName: "Invoice",
  events: [Placed, Cancelled],
  streamId: { composite: ["invoiceId"] },
})

const Ledger = Schema.Struct({
  id: Schema.String,
  total: Schema.Number,
  orderVersion: Schema.optional(Schema.Number),
  orderRev: Schema.optional(Schema.Number),
  checkpoints: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
  invoiceVersion: Schema.optional(Schema.Number),
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
 * A read model whose two projections name one attribute in different roles: `r` is the first's
 * revision and the second's checkpoint, so a tombstone holding `r` alone fits both layouts.
 */
const Tally = Schema.Struct({
  id: Schema.String,
  total: Schema.Number,
  x: Schema.optional(Schema.Number),
  r: Schema.optional(Schema.Number),
})
type Tally = typeof Tally.Type

const Tallies = Entity.make({
  model: Tally,
  entityType: "Tally",
  primaryKey: {
    pk: { field: "pk", composite: ["id"] },
    sk: { field: "sk", composite: [] },
  },
})
export const ReadTable = Table.make({ schema: AppSchema, entities: { Ledgers, Tallies } })

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

// The first keeps `x` and its revision `r`, the last keeps only its checkpoint `r`.
const CountByOrder = EventStore.projection({
  stream: Orders,
  readModel: Tallies,
  key: (id: { readonly orderId: string }) => ({ id: id.orderId }),
  initial: (id: { readonly orderId: string }): Tally => ({ id: id.orderId, total: 0 }),
  evolve,
  checkpoint: "x",
  revision: "r",
  removal: {},
})
const CountByInvoice = EventStore.projection({
  stream: Invoices,
  readModel: Tallies,
  key: (id: { readonly invoiceId: string }) => ({ id: id.invoiceId }),
  initial: (id: { readonly invoiceId: string }): Tally => ({ id: id.invoiceId, total: 0 }),
  evolve,
  checkpoint: "r",
  removal: {},
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

  /** The multi-source projection's tombstone: its checkpoint map and the revision it shares. */
  const multiSource = Effect.gen(function* () {
    const s1 = id("s1")
    yield* Shipments.append({ shipmentId: s1 }, history, 0)
    const events = yield* Shipments.read({ shipmentId: s1 })
    const tagged = (from: ReadonlyArray<EventStore.StreamEvent<LedgerEvent>>) =>
      from.map((event) => ({ stream: "shipment" as const, event }))
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
   * Two layouts naming one attribute in different roles. The first projection's tombstone holds
   * `x` and `r`: its own layout names both. The last's holds `r` alone, which both name: it is read
   * by the layout defined last, as every tombstone was when the read model kept one, so `r` is
   * carried as the checkpoint it is, not raised as a revision.
   */
  const ambiguous = Effect.gen(function* () {
    const o3 = id("o3")
    yield* Orders.append({ orderId: o3 }, history, 0)
    const orders = yield* Orders.read({ orderId: o3 })
    yield* CountByOrder.applyBatch(orders)
    expect(yield* rowOf(o3)).toMatchObject({ __edd_e__: "Tally#tombstone", x: 2, r: 1 })
    yield* Tallies.create({ id: o3, total: 1 }).asEffect()
    expect(yield* rowOf(o3)).toMatchObject({ __edd_e__: "Tally", total: 1, x: 2, r: 2 })
    expect((yield* CountByOrder.apply(orders[1]!)).applied).toEqual([])

    const i3 = id("i3")
    yield* Invoices.append({ invoiceId: i3 }, history, 0)
    yield* CountByInvoice.applyBatch(yield* Invoices.read({ invoiceId: i3 }))
    const tombstone = yield* rowOf(i3)
    expect(tombstone).toMatchObject({ __edd_e__: "Tally#tombstone", r: 2 })
    expect(tombstone!.x).toBeUndefined()
    yield* Tallies.create({ id: i3, total: 7 }).asEffect()
    expect(yield* rowOf(i3)).toMatchObject({ __edd_e__: "Tally", total: 7, r: 2 })
    // The checkpoint is 2, so the stream's next event applies.
    yield* Invoices.append({ invoiceId: i3 }, [new Placed({ amount: 5 })], 2)
    const next = (yield* Invoices.read({ invoiceId: i3 }))[2]!
    expect((yield* CountByInvoice.apply(next)).applied).toHaveLength(1)
    expect(yield* rowOf(i3)).toMatchObject({ __edd_e__: "Tally", total: 12, r: 3 })
  })

  return { firstAndLast, multiSource, transactional, ambiguous }
}
