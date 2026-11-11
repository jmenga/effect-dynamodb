/**
 * Several projections on one read model (#154): each records the attributes it keeps on a row,
 * each with its role, and `create` over a tombstone carries those of the projection with `removal`
 * that wrote it, not only those of whichever one was defined last. Every other write on a removal
 * path (a tombstone, a projection's row written over one) sends and stores what the published
 * 1.39.0 did, and so does `create` but for the attributes it now carries: both pinned against
 * captures. On a read model one of whose projections has `removal`, a stored attribute one
 * projection keeps in two roles is refused (`EDD-9133`) at the definition that completes the
 * conflict, and the table's TTL attribute kept by a projection before any entry point that writes a
 * row sends anything. Two projections keeping one attribute in different roles are not refused:
 * each writes it in its own role. A sparse checkpoint map's key is refused by the tombstone's write
 * as by the row's, with nothing written.
 */

import { describe, expect, it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Effect, Exit, Layer, Schema } from "effect"
import { beforeEach } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
import * as Library from "../src/index.js"
import {
  hasProjectionTombstones,
  projectionLayoutsOf,
  projectionTtlConflict,
} from "../src/internal/TransactableOps.js"
import { fromAttributeMap } from "../src/Marshaller.js"
import * as Table from "../src/Table.js"
import * as Transaction from "../src/Transaction.js"
import { calls, InMemoryClient, resetCalls, resetStore, store } from "./helpers/InMemoryTables.js"
import {
  Cancelled,
  EventsTable,
  evolve,
  Invoices,
  type Ledger,
  type LedgerEvent,
  Ledgers,
  Orders,
  Placed,
  ReadTable,
  Shipments,
  type SparseLedger,
  SparseLedgers,
  scenarios,
} from "./helpers/ProjectionTombstoneLayouts.js"
import { expectAsFixture, scenario } from "./helpers/ProjectionTombstoneRequests.js"
import * as Shared from "./helpers/ProjectionTombstoneShared.js"

const TestLayer = Layer.mergeAll(
  InMemoryClient,
  EventsTable.layer({ name: "events" }),
  ReadTable.layer({ name: "read" }),
)

beforeEach(() => resetStore())

const { firstAndLast, multiSource, transactional, sparse } = scenarios((id) =>
  Effect.sync(() =>
    [...store.entries()]
      .filter(([key]) => key.startsWith("read|") && key.includes(`#id_${id}|`))
      .map(([, item]) => fromAttributeMap(item) as Record<string, unknown>)
      .at(0),
  ),
)

describe("create over a tombstone, with several projections on the read model", () => {
  it.effect("carries the fields of the projection that wrote the tombstone", () =>
    firstAndLast.pipe(Effect.provide(TestLayer)),
  )

  it.effect("a multi-source projection's tombstone keeps its checkpoint map", () =>
    multiSource.pipe(Effect.provide(TestLayer)),
  )

  it.effect("a transactional create carries them too", () =>
    transactional.pipe(Effect.provide(TestLayer)),
  )

  it("keeps one entry per layout, the one defined last at the end, however often one is defined", () => {
    for (let i = 0; i < 3; i++) {
      EventStore.projection({
        stream: Orders,
        readModel: Ledgers,
        key: (id: { readonly orderId: string }) => ({ id: id.orderId }),
        initial: (id: { readonly orderId: string }): Ledger => ({ id: id.orderId, total: 0 }),
        evolve,
        checkpoint: "orderVersion",
        revision: "orderRev",
        removal: {},
      })
    }
    expect(projectionLayoutsOf(Ledgers)).toEqual([
      {
        label: 'EventStore.multiProjection("Ledger")',
        roles: [
          ["checkpoints", "checkpoint map"],
          ["revision", "revision"],
        ],
        removal: true,
        ttl: false,
      },
      {
        label: 'EventStore.projection("Invoice" → "Ledger")',
        roles: [
          ["invoiceVersion", "checkpoint"],
          ["revision", "revision"],
        ],
        removal: true,
        ttl: false,
      },
      {
        label: 'EventStore.projection("Payment" → "Ledger")',
        roles: [
          ["paymentVersion", "checkpoint"],
          ["revision", "revision"],
        ],
        removal: false,
        ttl: false,
      },
      {
        label: 'EventStore.projection("Order" → "Ledger")',
        roles: [
          ["orderVersion", "checkpoint"],
          ["orderRev", "revision"],
        ],
        removal: true,
        ttl: false,
      },
    ])
    expect(hasProjectionTombstones(Ledgers)).toBe(true)
  })
})

/**
 * Every scenario of `ProjectionTombstoneShared.ts` sends, stores and returns what the published
 * 1.39.0 did (its capture), except for what `create` over a tombstone now carries, which each
 * scenario names: a row two projections share, a tombstone written over another, a projection's
 * row written over one, writes landing between a projection's read and its write, and two
 * projections keeping one attribute in different roles.
 */
describe("with several projections on a read model, what 1.39.0 sent, stored and returned", () => {
  for (const [name, scenario] of Object.entries(Shared.scenarios(Library))) {
    it.effect(name, () =>
      Effect.gen(function* () {
        const outcome = yield* Shared.run(
          Library,
          scenario,
          { events: "events", read: "read" },
          InMemoryClient,
          (table) =>
            Effect.sync(() =>
              [...store.entries()]
                .filter(([key]) => key.startsWith(`${table}|`))
                .map(([, item]) => item),
            ),
        )
        Shared.expectAsCaptured(name, scenario, outcome)
      }),
    )
  }
})

/**
 * The client, recording the operation of every request naming `table` (reads too, with `reads`)
 * in `into`.
 */
const recording = (table: string, into: Array<string>, options?: { readonly reads?: boolean }) =>
  Layer.effect(
    DynamoClient,
    Effect.gen(function* () {
      const client = yield* DynamoClient
      return new Proxy(client, {
        get: (target, prop) => {
          const value = Reflect.get(target, prop)
          if (typeof value !== "function") return value
          if (options?.reads !== true && (prop === "getItem" || prop === "query")) return value
          return (input: unknown) => {
            if (JSON.stringify(input).includes(`"TableName":"${table}"`)) into.push(String(prop))
            return value.call(target, input)
          }
        },
      })
    }),
  ).pipe(Layer.provide(InMemoryClient))

const Tally = Schema.Struct({
  id: Schema.String,
  total: Schema.Number,
  x: Schema.optional(Schema.Number),
  r: Schema.optional(Schema.Number),
  _ttl: Schema.optional(Schema.Number),
})
type Tally = typeof Tally.Type

/** A read model of its own, so what one test defines on it doesn't reach another. */
const tallies = () => {
  const Tallies = Entity.make({
    model: Tally,
    entityType: "Tally",
    primaryKey: {
      pk: { field: "pk", composite: ["id"] },
      sk: { field: "sk", composite: [] },
    },
  })
  const TallyTable = Table.make({
    schema: DynamoSchema.make({ name: "layouts", version: 1 }),
    entities: { Tallies },
  })
  return { Tallies, TallyTable }
}

const evolveTally = (state: Tally, event: EventStore.StreamEvent<LedgerEvent>) =>
  Effect.succeed(
    event.data._tag === "Cancelled"
      ? EventStore.removeRow
      : { ...state, total: state.total + event.data.amount },
  )

const orderKey = (id: { readonly orderId: string }) => ({ id: id.orderId })
const orderInitial = (id: { readonly orderId: string }): Tally => ({ id: id.orderId, total: 0 })
const invoiceKey = (id: { readonly invoiceId: string }) => ({ id: id.invoiceId })
const invoiceInitial = (id: { readonly invoiceId: string }): Tally => ({
  id: id.invoiceId,
  total: 0,
})

/** The `[EDD-9133]` refusal's text after the projection it names. */
const ONE_ROLE =
  ". A projection of the read model has `removal`, and a tombstone carries a checkpoint as it is " +
  "and raises a revision: an attribute holds one role in a projection. Give each its own field."

describe("an attribute one projection keeps in two roles, on a read model whose rows may be tombstones", () => {
  it("is refused, recording nothing", () => {
    const { Tallies } = tallies()
    expect(() =>
      EventStore.projection({
        stream: Orders,
        readModel: Tallies,
        key: orderKey,
        initial: orderInitial,
        evolve: evolveTally,
        checkpoint: "r",
        revision: "r",
        removal: {},
      }),
    ).toThrow(
      '[EDD-9133] EventStore.projection("Order" → "Tally"): on read model "Tally", "r" is this ' +
        "projection's checkpoint, and its revision" +
        ONE_ROLE,
    )
    expect(projectionLayoutsOf(Tallies)).toBeUndefined()
    expect(hasProjectionTombstones(Tallies)).toBe(false)
  })

  it("compares the attributes as stored: two of its fields renamed to one", () => {
    const Renamed = Schema.Struct({
      id: Schema.String,
      total: Schema.Number,
      cp: Schema.optional(Schema.Number),
      rev: Schema.optional(Schema.Number),
      other: Schema.optional(Schema.Number),
    })
    const make = () =>
      Entity.make({
        model: DynamoModel.configure(Renamed, {
          cp: { field: "stored" },
          rev: { field: "stored" },
          other: { field: "stored" },
        }),
        entityType: "Renamed",
        primaryKey: {
          pk: { field: "pk", composite: ["id"] },
          sk: { field: "sk", composite: [] },
        },
      })
    const project = (
      readModel: ReturnType<typeof make>,
      stream: typeof Orders,
      checkpoint: "cp" | "rev" | "other",
      revision?: "cp" | "rev" | "other",
    ) =>
      EventStore.projection({
        stream,
        readModel,
        key: (id: { readonly [k: string]: string }) => ({ id: Object.values(id)[0]! }),
        initial: (id: { readonly [k: string]: string }) => ({
          id: Object.values(id)[0]!,
          total: 0,
        }),
        evolve: (state: { readonly id: string; readonly total: number }) => Effect.succeed(state),
        checkpoint,
        ...(revision === undefined ? {} : { revision }),
        removal: {},
      } as never)
    expect(() => project(make(), Orders, "cp", "rev")).toThrow(
      '[EDD-9133] EventStore.projection("Order" → "Renamed"): on read model "Renamed", "cp" ' +
        '(stored as "stored") is this projection\'s checkpoint, and "rev" (stored as "stored") ' +
        "its revision" +
        ONE_ROLE,
    )
    // One role, in two fields of two projections stored as one attribute: not refused.
    const Shared = make()
    project(Shared, Orders, "cp")
    expect(() => project(Shared, Invoices as never, "other")).not.toThrow()
  })

  it("is refused by the definition that gives the read model removal", () => {
    const { Tallies } = tallies()
    EventStore.projection({
      stream: Orders,
      readModel: Tallies,
      key: orderKey,
      initial: orderInitial,
      evolve: evolveTally,
      checkpoint: "r",
      revision: "r",
    })
    expect(projectionLayoutsOf(Tallies)?.[0]?.roles).toEqual([
      ["r", "checkpoint"],
      ["r", "revision"],
    ])
    const before = projectionLayoutsOf(Tallies)
    expect(() =>
      EventStore.projection({
        stream: Invoices,
        readModel: Tallies,
        key: invoiceKey,
        initial: invoiceInitial,
        evolve: evolveTally,
        checkpoint: "x",
        removal: {},
      }),
    ).toThrow(
      '[EDD-9133] EventStore.projection("Invoice" → "Tally"): on read model "Tally", "r" is ' +
        'EventStore.projection("Order" → "Tally")\'s checkpoint, and its revision' +
        ONE_ROLE,
    )
    expect(projectionLayoutsOf(Tallies)).toBe(before)
    expect(hasProjectionTombstones(Tallies)).toBe(false)
  })
})

/**
 * Two projections of one read model, one writing the `a#<id>` rows and the other the `b#<id>`
 * rows, each keeping the other's revision attribute as its checkpoint. The two never meet on a row,
 * which their definitions can't tell from two that do: 1.39.0 runs them, and so does this release,
 * with or without `removal`.
 */
const disjoint = (removal: boolean) => {
  const { Tallies, TallyTable } = tallies()
  const define = (side: "a" | "b") =>
    EventStore.projection({
      stream: side === "a" ? Orders : Invoices,
      readModel: Tallies,
      key: (id: { readonly [k: string]: string }) => ({ id: `${side}#${Object.values(id)[0]}` }),
      initial: (id: { readonly [k: string]: string }): Tally => ({
        id: `${side}#${Object.values(id)[0]}`,
        total: 0,
      }),
      evolve: evolveTally,
      checkpoint: side === "a" ? "x" : "r",
      revision: side === "a" ? "r" : "x",
      ...(removal && { removal: {} }),
    } as never) as EventStore.EventProjection<any, any, any, any, any, any, any, any, any, any>
  return { Tallies, TallyTable, define }
}

/**
 * A row (or tombstone, which holds no `id`) of a read model on the `tally` table, by its partition
 * key's value, unescaped (`escapeKeys` escapes the `#` the ids hold).
 */
const tallyRow = (id: string) =>
  [...store.entries()]
    .filter(([key]) => key.startsWith("tally|"))
    .map(([, item]) => fromAttributeMap(item) as Record<string, unknown>)
    .find((item) =>
      String(item.pk)
        .replace(/%([0-9a-f]{2})/gi, (_, hex: string) =>
          String.fromCharCode(Number.parseInt(hex, 16)),
        )
        .endsWith(`#id_${id}`),
    )

const applied = (result: unknown) =>
  (result as EventStore.ProjectionApplied<unknown, unknown, unknown>).applied

describe("an attribute two projections keep in different roles", () => {
  it.effect("is not refused without removal: the projections run as on 1.39.0", () => {
    const { Tallies, TallyTable, define } = disjoint(false)
    const A = define("a")
    const B = define("b")
    expect(hasProjectionTombstones(Tallies)).toBe(false)
    return Effect.gen(function* () {
      yield* DynamoClient.make({ entities: { Tallies }, tables: { TallyTable } })
      yield* Orders.append(
        { orderId: "d1" },
        [new Placed({ amount: 3 }), new Placed({ amount: 5 })],
        0,
      )
      yield* Invoices.append({ invoiceId: "d1" }, [new Placed({ amount: 2 })], 0)
      const orders = yield* Orders.read({ orderId: "d1" })
      const invoices = yield* Invoices.read({ invoiceId: "d1" })
      expect((yield* A.applyBatch(orders.slice(0, 1))).outcomes[0]?._tag).toBe("Applied")
      expect((yield* B.applyBatch(invoices)).outcomes[0]?._tag).toBe("Applied")
      // Redeliveries are recognised; the next event applies.
      expect(applied(yield* A.apply(orders[0]!))).toEqual([])
      expect(applied(yield* B.apply(invoices[0]!))).toEqual([])
      expect(applied(yield* A.apply(orders[1]!))).toHaveLength(1)
      expect(tallyRow("a#d1")).toMatchObject({ total: 8, x: 2, r: 2 })
      expect(tallyRow("b#d1")).toMatchObject({ total: 2, r: 1, x: 1 })
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          InMemoryClient,
          EventsTable.layer({ name: "events" }),
          TallyTable.layer({ name: "tally" }),
        ),
      ),
    )
  })

  it.effect(
    "is not refused with removal: each removes and recreates its own rows as on 1.39.0",
    () => {
      const { Tallies, TallyTable, define } = disjoint(true)
      const A = define("a")
      const B = define("b")
      expect(hasProjectionTombstones(Tallies)).toBe(true)
      return Effect.gen(function* () {
        yield* DynamoClient.make({ entities: { Tallies }, tables: { TallyTable } })
        const removed = [new Placed({ amount: 1 }), new Placed({ amount: 2 }), new Cancelled({})]
        yield* Orders.append({ orderId: "d2" }, removed, 0)
        yield* Invoices.append({ invoiceId: "d2" }, removed, 0)
        const orders = yield* Orders.read({ orderId: "d2" })
        const invoices = yield* Invoices.read({ invoiceId: "d2" })
        for (const [p, events] of [
          [A, orders],
          [B, invoices],
        ] as const) {
          expect((yield* p.applyBatch(events)).failedPositions).toEqual([])
          // A late removal is recognised: the tombstone keeps the projection's checkpoint.
          expect(applied(yield* p.apply(events[2]!))).toEqual([])
        }
        // Each tombstone, its projection's one write, keeps its checkpoint and its revision.
        expect(tallyRow("a#d2")).toMatchObject({ __edd_e__: "Tally#tombstone", x: 3, r: 1 })
        expect(tallyRow("b#d2")).toMatchObject({ __edd_e__: "Tally#tombstone", r: 3, x: 1 })
        yield* Orders.append({ orderId: "d2" }, [new Placed({ amount: 5 })], 3)
        yield* Invoices.append({ invoiceId: "d2" }, [new Placed({ amount: 5 })], 3)
        const next = [
          [A, (yield* Orders.read({ orderId: "d2" }))[3]!],
          [B, (yield* Invoices.read({ invoiceId: "d2" }))[3]!],
        ] as const
        for (const [p, event] of next) {
          expect(applied(yield* p.apply(event))).toHaveLength(1)
          expect(applied(yield* p.apply(event))).toEqual([])
        }
        expect(tallyRow("a#d2")).toMatchObject({ __edd_e__: "Tally", total: 5, x: 4, r: 2 })
        expect(tallyRow("b#d2")).toMatchObject({ __edd_e__: "Tally", total: 5, r: 4, x: 2 })
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            InMemoryClient,
            EventsTable.layer({ name: "events" }),
            TallyTable.layer({ name: "tally" }),
          ),
        ),
      )
    },
  )

  it.effect(
    "compares them as stored: a tombstone keeps its projection's attribute in its own role",
    () => {
      // `cp` (A's checkpoint) and `rv` (B's revision) are both stored as "s".
      const Model = Schema.Struct({
        id: Schema.String,
        total: Schema.Number,
        cp: Schema.optional(Schema.Number),
        ra: Schema.optional(Schema.Number),
        cb: Schema.optional(Schema.Number),
        rv: Schema.optional(Schema.Number),
      })
      const Rows = Entity.make({
        model: DynamoModel.configure(Model, { cp: { field: "s" }, rv: { field: "s" } }),
        entityType: "Tally",
        primaryKey: {
          pk: { field: "pk", composite: ["id"] },
          sk: { field: "sk", composite: [] },
        },
      })
      const RowTable = Table.make({
        schema: DynamoSchema.make({ name: "layouts", version: 1 }),
        entities: { Rows },
      })
      type Row = typeof Model.Type
      const define = (side: "a" | "b") =>
        EventStore.projection({
          stream: side === "a" ? Orders : Invoices,
          readModel: Rows,
          key: (id: { readonly [k: string]: string }) => ({
            id: `${side}#${Object.values(id)[0]}`,
          }),
          initial: (id: { readonly [k: string]: string }): Row => ({
            id: `${side}#${Object.values(id)[0]}`,
            total: 0,
          }),
          evolve: (state: Row, event: EventStore.StreamEvent<LedgerEvent>) =>
            Effect.succeed(
              event.data._tag === "Cancelled"
                ? EventStore.removeRow
                : { ...state, total: state.total + event.data.amount },
            ),
          checkpoint: side === "a" ? "cp" : "cb",
          revision: side === "a" ? "ra" : "rv",
          removal: {},
        } as never) as EventStore.EventProjection<any, any, any, any, any, any, any, any, any, any>
      const A = define("a")
      const B = define("b")
      return Effect.gen(function* () {
        const removed = [new Placed({ amount: 1 }), new Placed({ amount: 2 }), new Cancelled({})]
        yield* Orders.append({ orderId: "d3" }, removed, 0)
        yield* Invoices.append({ invoiceId: "d3" }, removed, 0)
        const orders = yield* Orders.read({ orderId: "d3" })
        const invoices = yield* Invoices.read({ invoiceId: "d3" })
        yield* A.applyBatch(orders)
        yield* B.applyBatch(invoices)
        // A's tombstone keeps its checkpoint 3 in "s", not B's revision raised there; B's keeps
        // its revision 1 there, not A's checkpoint carried.
        expect(tallyRow("a#d3")).toMatchObject({ __edd_e__: "Tally#tombstone", s: 3, ra: 1 })
        expect(tallyRow("b#d3")).toMatchObject({ __edd_e__: "Tally#tombstone", s: 1, cb: 3 })
        expect(applied(yield* A.apply(orders[2]!))).toEqual([])
        expect(applied(yield* A.apply(orders[1]!))).toEqual([])
        yield* Orders.append({ orderId: "d3" }, [new Placed({ amount: 5 })], 3)
        expect(applied(yield* A.apply((yield* Orders.read({ orderId: "d3" }))[3]!))).toHaveLength(1)
        expect(tallyRow("a#d3")).toMatchObject({ __edd_e__: "Tally", total: 5, s: 4, ra: 2 })
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            InMemoryClient,
            EventsTable.layer({ name: "events" }),
            RowTable.layer({ name: "tally" }),
          ),
        ),
      )
    },
  )

  it("is not refused whatever order they're defined in, single- or multi-source", () => {
    for (const order of [
      ["a", "b"],
      ["b", "a"],
    ] as const) {
      const { define } = disjoint(true)
      for (const side of order) expect(() => define(side)).not.toThrow()
    }
    const { Tallies } = tallies()
    EventStore.projection({
      stream: Orders,
      readModel: Tallies,
      key: orderKey,
      initial: orderInitial,
      evolve: evolveTally,
      checkpoint: "r",
      revision: "x",
    })
    expect(() =>
      EventStore.multiProjection({
        readModel: Tallies,
        initial: (key): Tally => ({ id: key.id, total: 0 }),
        sources: (source) => ({
          shipment: source(Shipments, {
            key: (id: { readonly shipmentId: string }) => ({ id: id.shipmentId }),
            evolve: evolveTally,
          }),
        }),
        checkpoints: { sources: { shipment: { field: "x", instanceField: "id" } } },
        revision: "r",
        removal: {},
      }),
    ).not.toThrow()
  })

  it("is checked against the table's TTL attribute when the projections run, not when defined", () => {
    const { Tallies } = tallies()
    EventStore.projection({
      stream: Orders,
      readModel: Tallies,
      key: orderKey,
      initial: orderInitial,
      evolve: evolveTally,
      checkpoint: "_ttl",
      revision: "x",
      removal: {},
    })
    expect(() =>
      EventStore.projection({
        stream: Invoices,
        readModel: Tallies,
        key: invoiceKey,
        initial: invoiceInitial,
        evolve: evolveTally,
        checkpoint: "x",
        removal: { ttl: "7 days" },
      }),
    ).not.toThrow()
    expect(projectionTtlConflict(Tallies, "_ttl")).toMatch(
      /^\[EDD-9133\] "_ttl" is a projection's checkpoint/,
    )
  })
})

describe("the table's TTL attribute", () => {
  const conflicting = () => {
    const { Tallies, TallyTable } = tallies()
    const ByOrder = EventStore.projection({
      stream: Orders,
      readModel: Tallies,
      key: orderKey,
      initial: orderInitial,
      evolve: evolveTally,
      checkpoint: "_ttl",
      revision: "r",
    })
    const ByInvoice = EventStore.projection({
      stream: Invoices,
      readModel: Tallies,
      key: invoiceKey,
      initial: invoiceInitial,
      evolve: evolveTally,
      checkpoint: "x",
      removal: { ttl: "7 days" },
    })
    return { Tallies, TallyTable, ByOrder, ByInvoice }
  }

  it.effect(
    "refuses every projection on the read model, before sending anything, when one keeps an attribute stored as it and another's tombstones set it",
    () => {
      const { TallyTable, ByOrder, ByInvoice } = conflicting()
      const sentToTally: Array<string> = []
      return Effect.gen(function* () {
        yield* Orders.append({ orderId: "t1" }, [new Placed({ amount: 1 })], 0)
        yield* Invoices.append(
          { invoiceId: "t1" },
          [new Placed({ amount: 1 }), new Cancelled({})],
          0,
        )
        const refusals = [
          (yield* ByOrder.applyBatch(yield* Orders.read({ orderId: "t1" }))).outcomes[0],
          (yield* ByInvoice.applyBatch(yield* Invoices.read({ invoiceId: "t1" }))).outcomes[0],
        ]
        for (const outcome of refusals) {
          expect(outcome?._tag).toBe("Failed")
          expect((outcome as { readonly error: unknown }).error).toMatchObject({
            _tag: "ValidationError",
            entityType: "Tally",
            cause:
              '[EDD-9133] "_ttl" is a projection\'s checkpoint on read model "Tally", stored as ' +
              "\"_ttl\", the table's TTL attribute, which a projection's tombstones set " +
              "(`removal.ttl`). An attribute holds one role: give the checkpoint its own field.",
          })
        }
        expect(sentToTally).toEqual([])
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            recording("tally", sentToTally, { reads: true }),
            EventsTable.layer({ name: "events" }),
            TallyTable.layer({ name: "tally" }),
          ),
        ),
      )
    },
  )

  it.effect(
    "a table whose TTL attribute has another name leaves the attribute a checkpoint",
    () => {
      const { TallyTable, ByOrder, ByInvoice } = conflicting()
      return Effect.gen(function* () {
        yield* Orders.append({ orderId: "t2" }, [new Placed({ amount: 1 })], 0)
        yield* Invoices.append(
          { invoiceId: "t3" },
          [new Placed({ amount: 1 }), new Cancelled({})],
          0,
        )
        expect(
          (yield* ByOrder.applyBatch(yield* Orders.read({ orderId: "t2" }))).outcomes[0]?._tag,
        ).toBe("Applied")
        expect(
          (yield* ByInvoice.applyBatch(yield* Invoices.read({ invoiceId: "t3" }))).outcomes[0]
            ?._tag,
        ).toBe("Applied")
        const items = [...store.entries()]
          .filter(([key]) => key.startsWith("tally|"))
          .map(([, item]) => fromAttributeMap(item))
        expect(items).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: "t2", _ttl: 1, r: 1 }),
            expect.objectContaining({
              __edd_e__: "Tally#tombstone",
              x: 2,
              expiresAt: expect.any(Number),
            }),
          ]),
        )
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            InMemoryClient,
            EventsTable.layer({ name: "events" }),
            TallyTable.layer({ name: "tally", ttlAttributeName: "expiresAt" }),
          ),
        ),
      )
    },
  )
})

describe("a read model whose projections have no removal", () => {
  it.effect("records their layouts, and create still sends its put alone", () => {
    const { Tallies, TallyTable } = tallies()
    EventStore.projection({
      stream: Orders,
      readModel: Tallies,
      key: orderKey,
      initial: orderInitial,
      evolve: (state: Tally, event: EventStore.StreamEvent<LedgerEvent>) =>
        Effect.succeed(
          event.data._tag === "Placed"
            ? { ...state, total: state.total + event.data.amount }
            : state,
        ),
      checkpoint: "x",
      revision: "r",
    })
    expect(projectionLayoutsOf(Tallies)).toEqual([
      {
        label: 'EventStore.projection("Order" → "Tally")',
        roles: [
          ["x", "checkpoint"],
          ["r", "revision"],
        ],
        removal: false,
        ttl: false,
      },
    ])
    expect(hasProjectionTombstones(Tallies)).toBe(false)
    const sentToTally: Array<string> = []
    return Effect.gen(function* () {
      yield* Tallies.create({ id: "t5", total: 1 }).asEffect()
      expect(sentToTally).toEqual(["putItem"])
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          recording("tally", sentToTally, { reads: true }),
          TallyTable.layer({ name: "tally" }),
        ),
      ),
    )
  })
})

describe("a checkpoint map stored as a sparse map", () => {
  it.effect("refuses the tombstone as it refuses the row, and writes nothing", () => {
    const writes: Array<string> = []
    return Effect.gen(function* () {
      const { row, tombstone } = yield* sparse
      expect(row).toMatchObject({
        _tag: "ValidationError",
        entityType: "SparseLedger",
        cause: `Sparse map "checkpoints": key "shipment#<id>" must not contain '#' — the library does not silently escape`,
      })
      expect(row.operation).toMatch(/\.write$/)
      expect(tombstone).toEqual(row)
      // Each read its row, and wrote nothing.
      expect(writes).toEqual(["getItem", "getItem"])
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          recording("read", writes, { reads: true }),
          EventsTable.layer({ name: "events" }),
          ReadTable.layer({ name: "read" }),
        ),
      ),
    )
  })

  it.effect.each([false, true])(
    "a projection keeping its checkpoint in fields of its own runs, the map left empty (removal: %s)",
    (removal) => {
      const BySparseFields = EventStore.multiProjection({
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
        checkpoints: {
          field: "checkpoints",
          sources: { shipment: { field: "shipmentVersion", instanceField: "shipmentOwner" } },
        },
        revision: "revision",
        removal: {},
      })
      const id = `f${removal}`
      return Effect.gen(function* () {
        yield* Shipments.append(
          { shipmentId: id },
          removal ? [new Placed({ amount: 1 }), new Cancelled({})] : [new Placed({ amount: 1 })],
          0,
        )
        const events = (yield* Shipments.read({ shipmentId: id })).map((event) => ({
          stream: "shipment" as const,
          event,
        }))
        expect((yield* BySparseFields.applyBatch(events)).outcomes[0]?._tag).toBe("Applied")
        if (removal) yield* SparseLedgers.create({ id, total: 10, checkpoints: {} }).asEffect()
        const again = (yield* BySparseFields.applyBatch(events)).outcomes[0]!
        if (again._tag !== "Applied") throw new Error(`not applied: ${again._tag}`)
        expect(again.instances[0]!.applied).toEqual([])
      }).pipe(Effect.provide(TestLayer))
    },
  )
})

/**
 * A read model fed by two projections with `removal`, `A` (checkpoint `a`, revision `ra`) and `B`
 * (checkpoint `b`, revision `rb`), on rows of one key, retrying a lost race `retry` times.
 */
const Race = Schema.Struct({
  id: Schema.String,
  total: Schema.Number,
  a: Schema.optional(Schema.Number),
  ra: Schema.optional(Schema.Number),
  b: Schema.optional(Schema.Number),
  rb: Schema.optional(Schema.Number),
})
type Race = typeof Race.Type
const racing = (retry: number) => {
  const Races = Entity.make({
    model: Race,
    entityType: "Race",
    primaryKey: {
      pk: { field: "pk", composite: ["id"] },
      sk: { field: "sk", composite: [] },
    },
  })
  const RaceTable = Table.make({
    schema: DynamoSchema.make({ name: "race", version: 1 }),
    entities: { Races },
  })
  const evolveRace = (state: Race, event: EventStore.StreamEvent<LedgerEvent>) =>
    Effect.succeed(
      event.data._tag === "Cancelled"
        ? EventStore.removeRow
        : { ...state, total: state.total + event.data.amount },
    )
  const A = EventStore.projection({
    stream: Orders,
    readModel: Races,
    key: (id: { readonly orderId: string }) => ({ id: id.orderId }),
    initial: (id: { readonly orderId: string }): Race => ({ id: id.orderId, total: 0 }),
    evolve: evolveRace,
    checkpoint: "a",
    revision: "ra",
    removal: {},
    retry,
  })
  const B = EventStore.projection({
    stream: Invoices,
    readModel: Races,
    key: (id: { readonly invoiceId: string }) => ({ id: id.invoiceId }),
    initial: (id: { readonly invoiceId: string }): Race => ({ id: id.invoiceId, total: 0 }),
    evolve: evolveRace,
    checkpoint: "b",
    revision: "rb",
    removal: {},
    retry,
  })
  return { Races, RaceTable, A, B }
}

const raceRow = () =>
  [...store.entries()]
    .filter(([key]) => key.startsWith("race|"))
    .map(([, item]) => fromAttributeMap(item) as Record<string, unknown>)
    .at(0)

describe("a removal path, on a row another projection never wrote", () => {
  it.effect("a removal gives a row no revision it didn't hold, as on 1.39.0", () => {
    const { Races, RaceTable, B } = racing(0)
    return Effect.gen(function* () {
      yield* Invoices.append({ invoiceId: "r3" }, [new Cancelled({}), new Cancelled({})], 0)
      const invoices = yield* Invoices.read({ invoiceId: "r3" })
      yield* B.apply(invoices[0]!)
      expect(raceRow()).toMatchObject({ __edd_e__: "Race#tombstone", b: 1, rb: 1 })
      expect(raceRow()).not.toHaveProperty("ra")
      // A tombstone over it, then `create`: A's revision stays absent.
      yield* B.apply(invoices[1]!)
      expect(raceRow()).toMatchObject({ __edd_e__: "Race#tombstone", b: 2, rb: 2 })
      expect(raceRow()).not.toHaveProperty("ra")
      yield* Races.create({ id: "r3", total: 10 }).asEffect()
      expect(raceRow()).toMatchObject({ __edd_e__: "Race", total: 10, b: 2, rb: 3 })
      expect(raceRow()).not.toHaveProperty("ra")
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          InMemoryClient,
          EventsTable.layer({ name: "events" }),
          RaceTable.layer({ name: "race" }),
        ),
      ),
    )
  })
})

/**
 * Every entry point that writes a row of a read model whose projection keeps an attribute stored
 * as the table's TTL attribute, which another's tombstones set: `[EDD-9133]` before anything is
 * sent, under the attribute's own name or another it is stored as. The drains write no row and
 * aren't refused (below).
 */
describe.each([
  false,
  true,
])("the table's TTL attribute, every entry point that writes a row (renamed: %s)", (renamed) => {
  const TtlTally = Schema.Struct({
    id: Schema.String,
    total: Schema.Number,
    cp: Schema.optional(Schema.Number),
    other: Schema.optional(Schema.Number),
    rev: Schema.optional(Schema.Number),
  })
  type TtlTally = typeof TtlTally.Type
  const ttlAttribute = renamed ? "expiresAt" : "cp"
  const setup = () => {
    const TtlTallies = Entity.make({
      model: renamed ? DynamoModel.configure(TtlTally, { cp: { field: "expiresAt" } }) : TtlTally,
      entityType: "TtlTally",
      primaryKey: {
        pk: { field: "pk", composite: ["id"] },
        sk: { field: "sk", composite: [] },
      },
    })
    const TtlTable = Table.make({
      schema: DynamoSchema.make({ name: "ttl", version: 1 }),
      entities: { TtlTallies },
    })
    const evolveTtl = (state: TtlTally, event: EventStore.StreamEvent<LedgerEvent>) =>
      Effect.succeed(
        event.data._tag === "Cancelled"
          ? EventStore.removeRow
          : { ...state, total: state.total + event.data.amount },
      )
    // Its checkpoint is the TTL attribute.
    const Single = EventStore.projection({
      stream: Orders,
      readModel: TtlTallies,
      key: (id: { readonly orderId: string }) => ({ id: id.orderId }),
      initial: (id: { readonly orderId: string }): TtlTally => ({ id: id.orderId, total: 0 }),
      evolve: evolveTtl,
      checkpoint: "cp",
      revision: "rev",
    })
    const Multi = EventStore.multiProjection({
      readModel: TtlTallies,
      initial: (key): TtlTally => ({ id: key.id, total: 0 }),
      sources: (source) => ({
        shipment: source(Shipments, {
          key: (id: { readonly shipmentId: string }) => ({ id: id.shipmentId }),
          evolve: evolveTtl,
        }),
      }),
      checkpoints: { sources: { shipment: { field: "cp", instanceField: "id" } } },
      revision: "rev",
    })
    // Its tombstones set the TTL attribute.
    const Removing = EventStore.projection({
      stream: Invoices,
      readModel: TtlTallies,
      key: (id: { readonly invoiceId: string }) => ({ id: id.invoiceId }),
      initial: (id: { readonly invoiceId: string }): TtlTally => ({ id: id.invoiceId, total: 0 }),
      evolve: evolveTtl,
      checkpoint: "other",
      revision: "rev",
      removal: { ttl: "7 days" },
      outbox: {
        schema: Schema.Struct({ id: Schema.String }),
        effects: () => [],
        index: { name: "outbox", pk: "obpk", sk: "obsk" },
      },
    })
    return { TtlTable, Single, Multi, Removing }
  }

  type Read = {
    readonly orders: ReadonlyArray<EventStore.StreamEvent<LedgerEvent>>
    readonly shipments: ReadonlyArray<EventStore.StreamEvent<LedgerEvent>>
  }
  const refused = (
    name: string,
    run: (p: ReturnType<typeof setup>, read: Read) => Effect.Effect<unknown, unknown, any>,
  ) =>
    it.effect(name, () => {
      const p = setup()
      return Effect.gen(function* () {
        yield* Orders.append({ orderId: "t" }, [new Placed({ amount: 1 })], 0)
        yield* Shipments.append({ shipmentId: "t" }, [new Placed({ amount: 1 })], 0)
        const read = {
          orders: yield* Orders.read({ orderId: "t" }),
          shipments: yield* Shipments.read({ shipmentId: "t" }),
        }
        resetCalls()
        const result = yield* Effect.exit(run(p, read))
        expect(Object.values(calls).reduce((a, b) => a + b, 0)).toBe(0)
        expect(JSON.stringify(result)).toContain("[EDD-9133]")
        expect(JSON.stringify(result)).toContain(`stored as \\"${ttlAttribute}\\"`)
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            InMemoryClient,
            EventsTable.layer({ name: "events" }),
            p.TtlTable.layer({ name: "ttl", ttlAttributeName: ttlAttribute }),
          ),
        ),
      )
    })

  refused("apply", (p, { orders }) => p.Single.apply(orders[0]!))
  refused("applyBatch", (p, { orders }) => p.Single.applyBatch(orders))
  refused("catchUp", (p) => p.Single.catchUp({ orderId: "t" }))
  refused("rebuild", (p) => p.Single.rebuild({ orderId: "t" }))
  refused("a multi-source projection's applyBatch", (p, { shipments }) =>
    p.Multi.applyBatch(shipments.map((event) => ({ stream: "shipment" as const, event }))),
  )
  // Its row doesn't exist: refused all the same.
  refused("a multi-source projection's catchUp", (p) => p.Multi.catchUp({ id: "t" }))
  refused("a multi-source projection's rebuild", (p) =>
    p.Multi.rebuild({ id: "t" }, { instances: { shipment: [{ shipmentId: "t" }] } }),
  )
})

/**
 * A worker draining an outbox on another table provides that table alone. A drain writes no row,
 * so it never checks the read model's TTL attribute or resolves its table, with or without
 * `removal.ttl` on the read model: the worker delivers as on 1.39.0.
 */
describe("a drain worker providing only its outbox's table", () => {
  const Outboxes = Table.make({
    schema: DynamoSchema.make({ name: "drain", version: 1 }),
    entities: {},
  })
  const setup = (multi: boolean, ttl: boolean) => {
    const { Tallies, TallyTable } = tallies()
    const removal = ttl ? { removal: { ttl: "7 days" as const } } : {}
    const outbox = {
      schema: Schema.Number,
      effects: () => [5],
      table: Outboxes,
      index: { name: "outbox", pk: "opk", sk: "osk" },
    }
    const projection = multi
      ? EventStore.multiProjection({
          readModel: Tallies,
          initial: (key): Tally => ({ id: key.id, total: 0 }),
          sources: (source) => ({
            order: source(Orders, { key: orderKey, evolve: evolveTally }),
          }),
          checkpoints: { sources: { order: { field: "x", instanceField: "id" } } },
          revision: "r",
          outbox,
          ...removal,
        })
      : EventStore.projection({
          stream: Orders,
          readModel: Tallies,
          key: orderKey,
          initial: orderInitial,
          evolve: evolveTally,
          checkpoint: "x",
          revision: "r",
          outbox,
          ...removal,
        })
    return { TallyTable, projection }
  }

  for (const [multi, ttl, method] of [false, true].flatMap((multi) =>
    [false, true].flatMap((ttl) =>
      (["drain", "drainPending"] as const).map((method) => [multi, ttl, method] as const),
    ),
  )) {
    {
      const name = `${multi ? "multi-source" : "single-source"}${ttl ? ", removal.ttl" : ""}`
      it.effect(`${name}: ${method} delivers`, () => {
        const { TallyTable, projection } = setup(multi, ttl)
        const p = projection as unknown as {
          readonly applyBatch: (
            events: ReadonlyArray<unknown>,
          ) => Effect.Effect<unknown, unknown, any>
          readonly drain: (
            key: unknown,
            deliver: (effect: number) => Effect.Effect<void>,
          ) => Effect.Effect<unknown, unknown, any>
          readonly drainPending: (
            deliver: (effect: number) => Effect.Effect<void>,
          ) => Effect.Effect<unknown, unknown, any>
        }
        return Effect.gen(function* () {
          // The writer, with every table.
          yield* Effect.gen(function* () {
            yield* Orders.append({ orderId: "w" }, [new Placed({ amount: 1 })], 0)
            const orders = yield* Orders.read({ orderId: "w" })
            yield* p.applyBatch(
              multi ? orders.map((event) => ({ stream: "order", event })) : orders,
            )
          }).pipe(
            Effect.provide(
              Layer.mergeAll(
                InMemoryClient,
                EventsTable.layer({ name: "events" }),
                TallyTable.layer({ name: "tally" }),
                Outboxes.layer({ name: "outbox" }),
              ),
            ),
          )
          // The worker, with its outbox's table alone.
          const delivered: Array<number> = []
          const deliver = (effect: number) => Effect.sync(() => void delivered.push(effect))
          const result = yield* Effect.exit(
            method === "drain" ? p.drain({ id: "w" }, deliver) : p.drainPending(deliver),
          ).pipe(Effect.provide(Layer.mergeAll(InMemoryClient, Outboxes.layer({ name: "outbox" }))))
          expect(Exit.isSuccess(result)).toBe(true)
          expect(delivered).toEqual([5])
        })
      })
    }
  }
})

/**
 * A sparse checkpoint map can't hold a key with `#`. A multi-source `rebuild` is refused by its
 * write, a row's or a tombstone's, with nothing written.
 */
describe("a multi-source rebuild given an instance a sparse checkpoint map can't hold", () => {
  for (const removal of [false, true]) {
    it.effect(`is refused, and nothing is written${removal ? " (removal)" : ""}`, () => {
      const Model = Schema.Struct({
        id: Schema.String,
        total: Schema.Number,
        rev: Schema.optional(Schema.Number),
        map: Schema.Record(Schema.String, Schema.Number),
      })
      type Row = typeof Model.Type
      const Rows = Entity.make({
        model: DynamoModel.configure(Model, {
          map: { storedAs: DynamoModel.SparseMap({ prefix: "sparsecp" }) },
        }),
        entityType: "SparseRebuild",
        primaryKey: {
          pk: { field: "pk", composite: ["id"] },
          sk: { field: "sk", composite: [] },
        },
      })
      const RowTable = Table.make({
        schema: DynamoSchema.make({ name: "sparse", version: 1 }),
        entities: { Rows },
      })
      const projection = EventStore.multiProjection({
        readModel: Rows,
        initial: (key): Row => ({ id: key.id, total: 0, map: {} }),
        sources: (source) => ({
          order: source(Orders, {
            key: orderKey,
            evolve: (state: Row, event: EventStore.StreamEvent<LedgerEvent>) =>
              Effect.succeed(
                event.data._tag === "Cancelled"
                  ? EventStore.removeRow
                  : { ...state, total: state.total + event.data.amount },
              ),
          }),
        }),
        checkpoints: { field: "map" },
        revision: "rev",
        ...(removal && { removal: {} }),
      })
      return Effect.gen(function* () {
        yield* Orders.append(
          { orderId: "s" },
          [removal ? new Cancelled({}) : new Placed({ amount: 1 })],
          0,
        )
        resetCalls()
        const result = yield* Effect.exit(
          projection.rebuild({ id: "s" }, { instances: { order: [{ orderId: "s" }] } }),
        )
        expect(JSON.stringify(result)).toContain("ValidationError")
        expect(JSON.stringify(result)).toContain("order#s")
        expect(calls.putItem + calls.transactWriteItems + calls.updateItem + calls.deleteItem).toBe(
          0,
        )
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            InMemoryClient,
            EventsTable.layer({ name: "events" }),
            RowTable.layer({ name: "sparse" }),
          ),
        ),
      )
    })
  }
})

/**
 * A write that adds no key to a sparse checkpoint map isn't refused: a batch whose events are all
 * skipped is applied with nothing written, and so is its rebuild, as on 1.39.0.
 */
describe("a sparse checkpoint map and events that are all skipped", () => {
  it.effect("applyBatch and rebuild are applied, with nothing written", () => {
    const Model = Schema.Struct({
      id: Schema.String,
      total: Schema.Number,
      rev: Schema.optional(Schema.Number),
      map: Schema.Record(Schema.String, Schema.Number),
    })
    type Row = typeof Model.Type
    const Rows = Entity.make({
      model: DynamoModel.configure(Model, {
        map: { storedAs: DynamoModel.SparseMap({ prefix: "sparsecp" }) },
      }),
      entityType: "SparseSkipped",
      primaryKey: {
        pk: { field: "pk", composite: ["id"] },
        sk: { field: "sk", composite: [] },
      },
    })
    const RowTable = Table.make({
      schema: DynamoSchema.make({ name: "skipped", version: 1 }),
      entities: { Rows },
    })
    const projection = EventStore.multiProjection({
      readModel: Rows,
      initial: (key): Row => ({ id: key.id, total: 0, map: {} }),
      sources: (source) => ({
        order: source(Orders, {
          key: orderKey,
          evolve: () => Effect.succeed(EventStore.skipEvent),
        }),
      }),
      checkpoints: { field: "map" },
      revision: "rev",
    })
    return Effect.gen(function* () {
      yield* Orders.append({ orderId: "k" }, [new Placed({ amount: 1 })], 0)
      const events = yield* Orders.read({ orderId: "k" })
      resetCalls()
      const live = yield* projection.applyBatch(
        events.map((event) => ({ stream: "order" as const, event })),
      )
      expect(live.outcomes[0]?._tag).toBe("Applied")
      const rebuilt = yield* Effect.exit(
        projection.rebuild({ id: "k" }, { instances: { order: [{ orderId: "k" }] } }),
      )
      expect(Exit.isSuccess(rebuilt)).toBe(true)
      expect(calls.putItem + calls.transactWriteItems + calls.updateItem + calls.deleteItem).toBe(0)
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          InMemoryClient,
          EventsTable.layer({ name: "events" }),
          RowTable.layer({ name: "skipped" }),
        ),
      ),
    )
  })
})

/**
 * A source with a checkpoint field of its own takes the map only when another instance owns the
 * field, which the row decides. A sparse map can't hold that key either: the write is refused,
 * after the reads, with nothing written.
 */
describe("a source's second instance falling back to a sparse checkpoint map", () => {
  const Model = Schema.Struct({
    id: Schema.String,
    total: Schema.Number,
    cp: Schema.optional(Schema.Number),
    owner: Schema.optional(Schema.String),
    rev: Schema.optional(Schema.Number),
    map: Schema.Record(Schema.String, Schema.Number),
  })
  type Row = typeof Model.Type
  const setup = () => {
    const Rows = Entity.make({
      model: DynamoModel.configure(Model, {
        map: { storedAs: DynamoModel.SparseMap({ prefix: "sparsecp" }) },
      }),
      entityType: "SparseFallback",
      primaryKey: {
        pk: { field: "pk", composite: ["id"] },
        sk: { field: "sk", composite: [] },
      },
    })
    const RowTable = Table.make({
      schema: DynamoSchema.make({ name: "fallback", version: 1 }),
      entities: { Rows },
    })
    const projection = EventStore.multiProjection({
      readModel: Rows,
      initial: (key): Row => ({ id: key.id, total: 0, map: {} }),
      sources: (source) => ({
        order: source(Orders, {
          // Every order feeds the one row.
          key: () => ({ id: "shared" }),
          evolve: (state: Row, event: EventStore.StreamEvent<LedgerEvent>) =>
            Effect.succeed(
              event.data._tag === "Cancelled"
                ? state
                : { ...state, total: state.total + event.data.amount },
            ),
        }),
      }),
      checkpoints: { field: "map", sources: { order: { field: "cp", instanceField: "owner" } } },
      revision: "rev",
    })
    return { RowTable, projection }
  }
  const written = () =>
    calls.putItem + calls.transactWriteItems + calls.updateItem + calls.deleteItem

  it.effect("applyBatch and rebuild are refused by the write, and nothing is written", () => {
    const { RowTable, projection } = setup()
    return Effect.gen(function* () {
      yield* Orders.append({ orderId: "f1" }, [new Placed({ amount: 1 })], 0)
      yield* Orders.append({ orderId: "f2" }, [new Placed({ amount: 2 })], 0)
      const first = yield* Orders.read({ orderId: "f1" })
      const second = yield* Orders.read({ orderId: "f2" })
      // The first instance takes the source's field: no map entry, so the row is written.
      const applied = yield* projection.applyBatch(
        first.map((event) => ({ stream: "order" as const, event })),
      )
      expect(applied.outcomes[0]?._tag).toBe("Applied")
      const before = new Map(store)
      resetCalls()
      const live = yield* projection.applyBatch(
        second.map((event) => ({ stream: "order" as const, event })),
      )
      expect(JSON.stringify(live.outcomes)).toContain("ValidationError")
      expect(JSON.stringify(live.outcomes)).toContain("order#f2")
      expect(written()).toBe(0)
      resetCalls()
      const rebuilt = yield* Effect.exit(
        projection.rebuild(
          { id: "shared" },
          { instances: { order: [{ orderId: "f1" }, { orderId: "f2" }] } },
        ),
      )
      expect(JSON.stringify(rebuilt)).toContain("ValidationError")
      expect(JSON.stringify(rebuilt)).toContain("order#f2")
      expect(written()).toBe(0)
      expect(new Map(store)).toEqual(before)
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          InMemoryClient,
          EventsTable.layer({ name: "events" }),
          RowTable.layer({ name: "fallback" }),
        ),
      ),
    )
  })
})

describe("a read model with one projection", () => {
  it.effect("sends and stores what 1.39.0 did, around its tombstones", () => {
    const { run } = scenario(
      { DynamoSchema, Table, Entity, EventStore, Transaction, DynamoClient },
      { events: "events", read: "read" },
    )
    return Effect.gen(function* () {
      const sent = yield* run(InMemoryClient)
      expectAsFixture(
        sent,
        [...store.entries()].filter(([key]) => key.startsWith("read|")).map(([, item]) => item),
      )
    })
  })
})
