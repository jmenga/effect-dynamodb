/**
 * Read models fed by several projections (#154), around their tombstones: a row two projections
 * share, a tombstone written over another, a projection's row written over a tombstone, `create`
 * over one, writes that read a row before another projection's write on a removal path, and two
 * projections keeping one attribute in different roles.
 *
 * `fixtures/projection-tombstones-shared-1.39.0.json` holds, for every scenario here, the requests
 * the published 1.39.0 (the npm package) sent to the read model's table, the items stored there
 * afterwards and what each step returned, against DynamoDB Local under `TestClock`. It was captured
 * once and must never be regenerated from this repo: the scenarios must send, store and return
 * exactly that, except where `carried` says what `create` over a tombstone now carries that 1.39.0
 * didn't (the attributes of the projection that wrote the tombstone, when it isn't the one with
 * `removal` defined last), and where `since` says what the row token (#237) changes.
 *
 * The row token is left out of every outcome (`withoutRowToken`). A scenario `since` names sends
 * what `fixtures/projection-tombstones-shared-row-token.json` holds, captured from this repo's
 * source when the token was added, and stores and returns 1.39.0's outcome with `since`'s changes
 * applied, which that fixture is checked against too.
 *
 * Each scenario takes the library as an argument, so the same code ran against the published
 * 1.39.0 to make the fixture as runs against this repo's source to compare with it.
 */

import { readFileSync } from "node:fs"
import { Effect, Layer, Schema } from "effect"
import { expect } from "vitest"

/** The library modules the scenarios use: this repo's source, or a published release. */
export interface Library {
  readonly DynamoSchema: any
  readonly DynamoModel: any
  readonly Table: any
  readonly Entity: any
  readonly EventStore: any
  readonly Transaction: any
  /** The `DynamoClient` service key. */
  readonly DynamoClient: any
}

/** One request naming the read model's table, as the library handed it to the client. */
export interface Sent {
  readonly operation: string
  readonly input: unknown
}

/** What a scenario sent, stored and returned. */
export interface Outcome {
  readonly requests: ReadonlyArray<Sent>
  readonly items: ReadonlyArray<Record<string, unknown>>
  readonly results: ReadonlyArray<readonly [label: string, value: unknown]>
}

export interface Fixture {
  readonly writtenBy: Record<string, string>
  readonly scenarios: Record<string, Outcome>
}

const fixtureFile = (name: string): Fixture =>
  JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8")) as Fixture

export const fixture = (): Fixture => fixtureFile("projection-tombstones-shared-1.39.0.json")

/** What the scenarios `since` names send, store and return with the row token (#237). */
export const rowTokenFixture = (): Fixture =>
  fixtureFile("projection-tombstones-shared-row-token.json")

class Placed extends Schema.TaggedClass<Placed>()("Placed", { amount: Schema.Number }) {}
class Cancelled extends Schema.TaggedClass<Cancelled>()("Cancelled", {}) {}

/** Placed, then cancelled: a projection's row ends removed, its tombstone at version 2. */
const history = () => [new Placed({ amount: 1 }), new Cancelled({})]

/** What a scenario's steps can do beyond running the library. */
interface Steps {
  /** Run `effect`, recording what it returned or failed with under `label`. */
  readonly record: (
    label: string,
    effect: Effect.Effect<unknown, unknown, any>,
  ) => Effect.Effect<void>
  /** Run `effect` once, right after the next read of the read model's table returns. */
  readonly between: (effect: Effect.Effect<unknown, unknown, any>) => void
}

interface Scenario {
  readonly events: any
  readonly read: any
  readonly steps: (steps: Steps) => Effect.Effect<void, unknown, any>
  /**
   * Attributes `create` over a tombstone now carries that 1.39.0 didn't (those of the projection
   * that wrote the tombstone): `stored` appended to its put's item in this order, the scenario's
   * last request being that put, and `returned` the same as `create` returns them.
   */
  readonly carried?: Carried
}

/**
 * What `create` over a tombstone carries that 1.39.0 didn't, as stored and as returned, and what
 * 1.39.0 carried that it doesn't (`dropped`: the table's TTL attribute, under one name stored and
 * returned).
 */
interface Carried {
  readonly stored: Record<string, unknown>
  readonly returned: Record<string, unknown>
  readonly dropped?: ReadonlyArray<string>
}

/** An error as recorded: its tag, operation and cause's text. */
const errorOf = (error: any): unknown => ({
  failed: error?._tag ?? String(error),
  ...(typeof error?.operation === "string" && { operation: error.operation }),
  ...(error?.cause !== undefined && {
    cause:
      typeof error.cause === "string"
        ? error.cause
        : error.cause instanceof Error
          ? error.cause.message
          : String(error.cause),
  }),
})

/** What a projection's write returned, as recorded: the counts and flags, not the states. */
const summary = (result: any): unknown => {
  if (result === undefined || result === null || typeof result !== "object") return result
  if (Array.isArray(result.outcomes)) return result.outcomes.map(summary)
  const out: Record<string, unknown> = {}
  if (typeof result._tag === "string") out.tag = result._tag
  if (typeof result.removed === "boolean") out.removed = result.removed
  for (const k of ["applied", "alreadyApplied"]) {
    if (Array.isArray(result[k])) out[k] = result[k].length
  }
  if (Array.isArray(result.instances)) out.instances = result.instances.map(summary)
  if (result.error !== undefined) out.error = errorOf(result.error)
  return Object.keys(out).length === 0 ? JSON.parse(JSON.stringify(result)) : out
}

// ---------------------------------------------------------------------------
// One read model, four projections: three with `removal`, one without.
// ---------------------------------------------------------------------------

const ledger = (lib: Library) => {
  const AppSchema = lib.DynamoSchema.make({ name: "shared", version: 1 })
  const events = lib.Table.make({ schema: AppSchema, entities: {} })
  const stream = (streamName: string, id: string) =>
    lib.EventStore.makeStream({
      table: events,
      streamName,
      events: [Placed, Cancelled],
      streamId: { composite: [id] },
    })
  const Orders = stream("Order", "orderId")
  const Shipments = stream("Shipment", "shipmentId")
  const Invoices = stream("Invoice", "invoiceId")
  const Payments = stream("Payment", "paymentId")
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
  type Ledger = typeof Ledger.Type
  const Ledgers = lib.Entity.make({
    model: Ledger,
    entityType: "Ledger",
    primaryKey: {
      pk: { field: "pk", composite: ["id"] },
      sk: { field: "sk", composite: [] },
    },
  })
  const read = lib.Table.make({ schema: AppSchema, entities: { Ledgers } })
  const evolve = (state: Ledger, event: { readonly data: Placed | Cancelled }) =>
    Effect.succeed(
      event.data._tag === "Cancelled"
        ? lib.EventStore.removeRow
        : { ...state, total: state.total + event.data.amount },
    )
  // Defined in this order: the order projection first, the invoice projection last with `removal`.
  const ByOrder = lib.EventStore.projection({
    stream: Orders,
    readModel: Ledgers,
    key: (id: { readonly orderId: string }) => ({ id: id.orderId }),
    initial: (id: { readonly orderId: string }): Ledger => ({ id: id.orderId, total: 0 }),
    evolve,
    checkpoint: "orderVersion",
    revision: "orderRev",
    removal: {},
  })
  const ByShipment = lib.EventStore.multiProjection({
    readModel: Ledgers,
    initial: (key: { readonly id: string }): Ledger => ({ id: key.id, total: 0 }),
    sources: (source: any) => ({
      shipment: source(Shipments, {
        key: (id: { readonly shipmentId: string }) => ({ id: id.shipmentId }),
        evolve,
      }),
    }),
    checkpoints: { field: "checkpoints" },
    revision: "revision",
    removal: {},
  })
  const ByInvoice = lib.EventStore.projection({
    stream: Invoices,
    readModel: Ledgers,
    key: (id: { readonly invoiceId: string }) => ({ id: id.invoiceId }),
    initial: (id: { readonly invoiceId: string }): Ledger => ({ id: id.invoiceId, total: 0 }),
    evolve,
    checkpoint: "invoiceVersion",
    revision: "revision",
    removal: {},
  })
  const ByPayment = lib.EventStore.projection({
    stream: Payments,
    readModel: Ledgers,
    key: (id: { readonly paymentId: string }) => ({ id: id.paymentId }),
    initial: (id: { readonly paymentId: string }): Ledger => ({ id: id.paymentId, total: 0 }),
    evolve,
    checkpoint: "paymentVersion",
    revision: "revision",
  })
  const tagged = (from: ReadonlyArray<unknown>) =>
    from.map((event) => ({ stream: "shipment" as const, event }))
  return {
    events,
    read,
    Orders,
    Shipments,
    Invoices,
    Payments,
    Ledgers,
    ByOrder,
    ByShipment,
    ByInvoice,
    ByPayment,
    tagged,
  }
}

const ledgerScenarios = (lib: Library): Record<string, Scenario> => {
  const at = (
    f: (l: ReturnType<typeof ledger>, steps: Steps) => Effect.Effect<void, unknown, any>,
    carried?: Carried,
  ): Scenario => {
    const l = ledger(lib)
    return {
      events: l.events,
      read: l.read,
      steps: (steps) => f(l, steps),
      ...(carried !== undefined && { carried }),
    }
  }
  return {
    // The invoice and order projections share a row; the order projection removes it, then the
    // invoice projection's redelivery and next event, then the order projection's late removal.
    "ledger: a shared row the order projection removes": at((l, { record }) =>
      Effect.gen(function* () {
        yield* l.Invoices.append({ invoiceId: "x1" }, [new Placed({ amount: 5 })], 0)
        const invoices = yield* l.Invoices.read({ invoiceId: "x1" })
        yield* record("invoice applies", l.ByInvoice.applyBatch(invoices))
        yield* l.Orders.append({ orderId: "x1" }, history(), 0)
        const orders = yield* l.Orders.read({ orderId: "x1" })
        yield* record("order removes", l.ByOrder.applyBatch(orders))
        yield* record("invoice redelivered", l.ByInvoice.apply(invoices[0]))
        yield* l.Invoices.append({ invoiceId: "x1" }, [new Placed({ amount: 7 })], 1)
        const next = (yield* l.Invoices.read({ invoiceId: "x1" }))[1]
        yield* record("invoice's next event", l.ByInvoice.apply(next))
        yield* record("order's late removal", l.ByOrder.apply(orders[1]))
      }),
    ),
    // The order projection removes a row the invoice projection feeds, then the invoice projection
    // removes it again.
    "ledger: a shared row removed twice": at((l, { record }) =>
      Effect.gen(function* () {
        yield* l.Invoices.append({ invoiceId: "x3" }, [new Placed({ amount: 5 })], 0)
        yield* record(
          "invoice applies",
          l.ByInvoice.applyBatch(yield* l.Invoices.read({ invoiceId: "x3" })),
        )
        yield* l.Orders.append({ orderId: "x3" }, history(), 0)
        const orders = yield* l.Orders.read({ orderId: "x3" })
        yield* record("order removes", l.ByOrder.applyBatch(orders))
        yield* l.Invoices.append({ invoiceId: "x3" }, [new Cancelled({})], 1)
        const cancelled = (yield* l.Invoices.read({ invoiceId: "x3" }))[1]
        yield* record("invoice removes", l.ByInvoice.apply(cancelled))
        yield* record("order's late removal", l.ByOrder.apply(orders[1]))
      }),
    ),
    // A projection without `removal` shares a row the order projection removes.
    "ledger: a shared row with a projection without removal": at((l, { record }) =>
      Effect.gen(function* () {
        yield* l.Payments.append({ paymentId: "x4" }, [new Placed({ amount: 5 })], 0)
        const payments = yield* l.Payments.read({ paymentId: "x4" })
        yield* record("payment applies", l.ByPayment.applyBatch(payments))
        yield* l.Orders.append({ orderId: "x4" }, history(), 0)
        yield* record(
          "order removes",
          l.ByOrder.applyBatch(yield* l.Orders.read({ orderId: "x4" })),
        )
        yield* record("payment redelivered", l.ByPayment.apply(payments[0]))
      }),
    ),
    // The multi-source projection removes its row; a late redelivery.
    "ledger: the multi-source projection's tombstone": at((l, { record }) =>
      Effect.gen(function* () {
        yield* l.Shipments.append({ shipmentId: "s1" }, history(), 0)
        const events = yield* l.Shipments.read({ shipmentId: "s1" })
        yield* record("shipment removes", l.ByShipment.applyBatch(l.tagged(events)))
        yield* record("late removal", l.ByShipment.applyBatch(l.tagged(events.slice(1))))
        yield* l.Shipments.append({ shipmentId: "s1" }, [new Placed({ amount: 4 })], 2)
        const next = (yield* l.Shipments.read({ shipmentId: "s1" })).slice(2)
        yield* record("next event", l.ByShipment.applyBatch(l.tagged(next)))
      }),
    ),
    // The projection with `removal` defined last: 1.39.0 carried its attributes already.
    "ledger: create over the invoice projection's tombstone": at((l, { record }) =>
      Effect.gen(function* () {
        yield* l.Invoices.append({ invoiceId: "i1" }, history(), 0)
        const invoices = yield* l.Invoices.read({ invoiceId: "i1" })
        yield* record("invoice removes", l.ByInvoice.applyBatch(invoices))
        yield* record("create", l.Ledgers.create({ id: "i1", total: 4 }).asEffect())
        yield* record("late removal", l.ByInvoice.apply(invoices[1]))
      }),
    ),
    // The others: 1.39.0 carried what the invoice projection's layout names, which these
    // tombstones don't hold; the head carries the writer's.
    "ledger: create over the order projection's tombstone": at(
      (l, { record }) =>
        Effect.gen(function* () {
          yield* l.Orders.append({ orderId: "o1" }, history(), 0)
          yield* record(
            "order removes",
            l.ByOrder.applyBatch(yield* l.Orders.read({ orderId: "o1" })),
          )
          yield* record("create", l.Ledgers.create({ id: "o1", total: 9 }).asEffect())
        }),
      {
        stored: { orderVersion: { N: "2" }, orderRev: { N: "2" } },
        returned: { orderVersion: 2, orderRev: 2 },
      },
    ),
    "ledger: a transactional create over the order projection's tombstone": at(
      (l, { record }) =>
        Effect.gen(function* () {
          yield* l.Orders.append({ orderId: "o2" }, history(), 0)
          yield* record(
            "order removes",
            l.ByOrder.applyBatch(yield* l.Orders.read({ orderId: "o2" })),
          )
          yield* record(
            "create",
            lib.Transaction.transactWrite([l.Ledgers.create({ id: "o2", total: 5 })]),
          )
        }),
      {
        stored: { orderVersion: { N: "2" }, orderRev: { N: "2" } },
        returned: { orderVersion: 2, orderRev: 2 },
      },
    ),
    "ledger: create over the multi-source projection's tombstone": at(
      (l, { record }) =>
        Effect.gen(function* () {
          yield* l.Shipments.append({ shipmentId: "s2" }, history(), 0)
          const events = yield* l.Shipments.read({ shipmentId: "s2" })
          yield* record("shipment removes", l.ByShipment.applyBatch(l.tagged(events)))
          yield* record("create", l.Ledgers.create({ id: "s2", total: 3 }).asEffect())
        }),
      {
        stored: { checkpoints: { M: { "shipment#s2": { N: "2" } } } },
        returned: { checkpoints: { "shipment#s2": 2 } },
      },
    ),
    "ledger: create over a shared row's tombstone": at(
      (l, { record }) =>
        Effect.gen(function* () {
          yield* l.Shipments.append({ shipmentId: "x2" }, [new Placed({ amount: 2 })], 0)
          const shipments = yield* l.Shipments.read({ shipmentId: "x2" })
          yield* record("shipment applies", l.ByShipment.applyBatch(l.tagged(shipments)))
          yield* l.Orders.append({ orderId: "x2" }, history(), 0)
          yield* record(
            "order removes",
            l.ByOrder.applyBatch(yield* l.Orders.read({ orderId: "x2" })),
          )
          yield* record("create", l.Ledgers.create({ id: "x2", total: 3 }).asEffect())
        }),
      {
        stored: { orderVersion: { N: "2" }, orderRev: { N: "2" } },
        returned: { orderVersion: 2, orderRev: 2 },
      },
    ),
  }
}

// ---------------------------------------------------------------------------
// Two projections with `removal` on rows of one key, a write landing between a read and a write.
// ---------------------------------------------------------------------------

const race = (lib: Library, retry: number) => {
  const AppSchema = lib.DynamoSchema.make({ name: "race", version: 1 })
  const events = lib.Table.make({ schema: AppSchema, entities: {} })
  const stream = (streamName: string) =>
    lib.EventStore.makeStream({
      table: events,
      streamName,
      events: [Placed, Cancelled],
      streamId: { composite: ["id"] },
    })
  const Orders = stream("Order")
  const Invoices = stream("Invoice")
  const Race = Schema.Struct({
    id: Schema.String,
    total: Schema.Number,
    a: Schema.optional(Schema.Number),
    ra: Schema.optional(Schema.Number),
    b: Schema.optional(Schema.Number),
    rb: Schema.optional(Schema.Number),
  })
  type Race = typeof Race.Type
  const Races = lib.Entity.make({
    model: Race,
    entityType: "Race",
    primaryKey: {
      pk: { field: "pk", composite: ["id"] },
      sk: { field: "sk", composite: [] },
    },
  })
  const read = lib.Table.make({ schema: AppSchema, entities: { Races } })
  const evolve = (state: Race, event: { readonly data: Placed | Cancelled }) =>
    Effect.succeed(
      event.data._tag === "Cancelled"
        ? lib.EventStore.removeRow
        : { ...state, total: state.total + event.data.amount },
    )
  const define = (from: any, checkpoint: string, revision: string) =>
    lib.EventStore.projection({
      stream: from,
      readModel: Races,
      key: (id: { readonly id: string }) => ({ id: id.id }),
      initial: (id: { readonly id: string }): Race => ({ id: id.id, total: 0 }),
      evolve,
      checkpoint,
      revision,
      removal: {},
      retry,
    })
  const A = define(Orders, "a", "ra")
  const B = define(Invoices, "b", "rb")
  return { events, read, Orders, Invoices, Races, A, B }
}

const raceScenarios = (lib: Library): Record<string, Scenario> => {
  const out: Record<string, Scenario> = {}
  for (const transaction of [false, true]) {
    const r = race(lib, 0)
    out[
      `race: create lands between a projection's read of a tombstone and its write${transaction ? ", in a transaction" : ""}`
    ] = {
      events: r.events,
      read: r.read,
      steps: ({ record, between }) =>
        Effect.gen(function* () {
          yield* r.Orders.append(
            { id: "r1" },
            [new Placed({ amount: 5 }), new Placed({ amount: 7 })],
            0,
          )
          yield* r.Invoices.append({ id: "r1" }, [new Cancelled({})], 0)
          const orders = yield* r.Orders.read({ id: "r1" })
          yield* record("A applies", r.A.apply(orders[0]))
          yield* record("B removes", r.B.apply((yield* r.Invoices.read({ id: "r1" }))[0]))
          between(
            transaction
              ? lib.Transaction.transactWrite([r.Races.create({ id: "r1", total: 10 })])
              : r.Races.create({ id: "r1", total: 10 }).asEffect(),
          )
          yield* record("A's next event", r.A.apply(orders[1]))
        }),
    }
  }
  for (const removes of [false, true]) {
    for (const retry of [0, 2]) {
      const r = race(lib, retry)
      out[
        `race: another projection ${removes ? "removes the row again" : "writes a row over the tombstone"} between a read and a write (retry ${retry})`
      ] = {
        events: r.events,
        read: r.read,
        steps: ({ record, between }) =>
          Effect.gen(function* () {
            yield* r.Orders.append({ id: "r2" }, [new Cancelled({}), new Placed({ amount: 2 })], 0)
            yield* r.Invoices.append(
              { id: "r2" },
              [removes ? new Cancelled({}) : new Placed({ amount: 5 })],
              0,
            )
            const orders = yield* r.Orders.read({ id: "r2" })
            const invoice = (yield* r.Invoices.read({ id: "r2" }))[0]
            yield* record("A removes", r.A.apply(orders[0]))
            between(r.B.apply(invoice))
            yield* record("A's next event", r.A.apply(orders[1]))
            yield* record("B redelivered", r.B.apply(invoice))
          }),
      }
    }
  }
  {
    const r = race(lib, 0)
    out["race: a removal and create over it, the other projection's revision never held"] = {
      events: r.events,
      read: r.read,
      steps: ({ record }) =>
        Effect.gen(function* () {
          yield* r.Invoices.append({ id: "r3" }, [new Cancelled({}), new Cancelled({})], 0)
          const invoices = yield* r.Invoices.read({ id: "r3" })
          yield* record("B removes", r.B.apply(invoices[0]))
          yield* record("B removes again", r.B.apply(invoices[1]))
          yield* record("create", r.Races.create({ id: "r3", total: 10 }).asEffect())
        }),
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// One attribute, different roles in two projections writing rows of their own.
// ---------------------------------------------------------------------------

const rolesScenarios = (lib: Library): Record<string, Scenario> => {
  const base = (name: string) => {
    const AppSchema = lib.DynamoSchema.make({ name, version: 1 })
    const events = lib.Table.make({ schema: AppSchema, entities: {} })
    const stream = (streamName: string) =>
      lib.EventStore.makeStream({
        table: events,
        streamName,
        events: [Placed, Cancelled],
        streamId: { composite: ["id"] },
      })
    return { AppSchema, events, sA: stream("OrdersA"), sB: stream("OrdersB") }
  }
  const evolve = (state: any, event: { readonly data: Placed | Cancelled }) =>
    Effect.succeed(
      event.data._tag === "Cancelled"
        ? lib.EventStore.removeRow
        : { ...state, total: state.total + event.data.amount },
    )
  const out: Record<string, Scenario> = {}

  // A (removal) keeps `version` as its checkpoint; B (no removal, multi-source) as its revision.
  for (const bLast of [true, false]) {
    const { AppSchema, events, sA, sB } = base("rolesa")
    const Model = Schema.Struct({
      id: Schema.String,
      total: Schema.Number,
      version: Schema.optional(Schema.Number),
      rev: Schema.optional(Schema.Number),
      checkpoints: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
    })
    const Rows = lib.Entity.make({
      model: Model,
      entityType: "Read",
      primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
    })
    const read = lib.Table.make({ schema: AppSchema, entities: { Rows } })
    const defineA = () =>
      lib.EventStore.projection({
        stream: sA,
        readModel: Rows,
        key: (id: any) => ({ id: `a${id.id}` }),
        initial: (id: any) => ({ id: `a${id.id}`, total: 0 }),
        evolve,
        checkpoint: "version",
        revision: "rev",
        removal: {},
        retry: 3,
      })
    const defineB = () =>
      lib.EventStore.multiProjection({
        readModel: Rows,
        initial: (key: any) => ({ id: key.id, total: 0 }),
        sources: (source: any) => ({
          b: source(sB, { key: (id: any) => ({ id: `b${id.id}` }), evolve }),
        }),
        checkpoints: { field: "checkpoints" },
        revision: "version",
        retry: 3,
      })
    const [A, B] = bLast ? [defineA(), defineB()] : (([b, a]) => [a, b])([defineB(), defineA()])
    out[
      `roles: create over A's tombstone, A's checkpoint B's revision (B defined ${bLast ? "last" : "first"})`
    ] = {
      events,
      read,
      steps: ({ record }) =>
        Effect.gen(function* () {
          yield* sA.append(
            { id: "x" },
            [new Placed({ amount: 2 }), new Cancelled({}), new Placed({ amount: 3 })],
            0,
          )
          yield* sB.append({ id: "y" }, [new Placed({ amount: 5 })], 0)
          const ea = yield* sA.read({ id: "x" })
          const eb = yield* sB.read({ id: "y" })
          yield* record("B applies", B.applyBatch(eb.map((event: any) => ({ stream: "b", event }))))
          yield* record("A removes", A.applyBatch(ea.slice(0, 2)))
          yield* record("create", Rows.create({ id: "ax", total: 10 }).asEffect())
          yield* record("A's next event", A.applyBatch([ea[2]]))
        }),
    }
  }

  // A (removal) keeps `version` as its revision; B (no removal) as its checkpoint. `create` lands
  // between A's read of its tombstone and its write.
  for (const bLast of [true, false]) {
    for (const transaction of [false, true]) {
      const { AppSchema, events, sA, sB } = base("rolesb")
      const Model = Schema.Struct({
        id: Schema.String,
        total: Schema.Number,
        version: Schema.optional(Schema.Number),
        cp: Schema.optional(Schema.Number),
      })
      const Rows = lib.Entity.make({
        model: Model,
        entityType: "Read",
        primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
      })
      const read = lib.Table.make({ schema: AppSchema, entities: { Rows } })
      const defineA = () =>
        lib.EventStore.projection({
          stream: sA,
          readModel: Rows,
          key: (id: any) => ({ id: `a${id.id}` }),
          initial: (id: any) => ({ id: `a${id.id}`, total: 0 }),
          evolve,
          checkpoint: "cp",
          revision: "version",
          removal: {},
          retry: 3,
        })
      const defineB = () =>
        lib.EventStore.projection({
          stream: sB,
          readModel: Rows,
          key: (id: any) => ({ id: `b${id.id}` }),
          initial: (id: any) => ({ id: `b${id.id}`, total: 0 }),
          evolve,
          checkpoint: "version",
          retry: 3,
        })
      const A = bLast
        ? (([a]) => a)([defineA(), defineB()])
        : (([, a]) => a)([defineB(), defineA()])
      out[
        `roles: create between A's read of its tombstone and its write, A's revision B's checkpoint (B defined ${bLast ? "last" : "first"}${transaction ? ", in a transaction" : ""})`
      ] = {
        events,
        read,
        steps: ({ record, between }) =>
          Effect.gen(function* () {
            yield* sA.append(
              { id: "x" },
              [new Placed({ amount: 2 }), new Cancelled({}), new Placed({ amount: 3 })],
              0,
            )
            const ea = yield* sA.read({ id: "x" })
            yield* record("A removes", A.applyBatch(ea.slice(0, 2)))
            between(
              transaction
                ? lib.Transaction.transactWrite([Rows.create({ id: "ax", total: 10 })])
                : Rows.create({ id: "ax", total: 10 }).asEffect(),
            )
            yield* record("A's next event", A.applyBatch([ea[2]]))
          }),
      }
    }
  }

  // A (removal) keeps a data field `n`; B (no removal) keeps `n` as its checkpoint or revision.
  for (const role of ["checkpoint", "revision"] as const) {
    const { AppSchema, events, sA, sB } = base("rolesc")
    const Model = Schema.Struct({
      id: Schema.String,
      total: Schema.Number,
      n: Schema.optional(Schema.Number),
      cp: Schema.optional(Schema.Number),
      rev: Schema.optional(Schema.Number),
      bcp: Schema.optional(Schema.Number),
    })
    const Rows = lib.Entity.make({
      model: Model,
      entityType: "Read",
      primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
    })
    const read = lib.Table.make({ schema: AppSchema, entities: { Rows } })
    const A = lib.EventStore.projection({
      stream: sA,
      readModel: Rows,
      key: (id: any) => ({ id: `a${id.id}` }),
      initial: (id: any) => ({ id: `a${id.id}`, total: 0 }),
      evolve: (state: any, event: { readonly data: Placed | Cancelled }) =>
        Effect.succeed(
          event.data._tag === "Cancelled"
            ? lib.EventStore.removeRow
            : { ...state, total: state.total + event.data.amount, n: (state.n ?? 0) + 100 },
        ),
      checkpoint: "cp",
      revision: "rev",
      removal: {},
      retry: 3,
    })
    const B = lib.EventStore.projection({
      stream: sB,
      readModel: Rows,
      key: (id: any) => ({ id: `b${id.id}` }),
      initial: (id: any) => ({ id: `b${id.id}`, total: 0 }),
      evolve,
      ...(role === "checkpoint" ? { checkpoint: "n" } : { checkpoint: "bcp", revision: "n" }),
    })
    out[`roles: A's data field is B's ${role}, A's row removed and written again`] = {
      events,
      read,
      steps: ({ record }) =>
        Effect.gen(function* () {
          const db = yield* lib.DynamoClient.make({ entities: { Rows }, tables: { read } })
          yield* sA.append(
            { id: "x" },
            [
              new Placed({ amount: 2 }),
              new Placed({ amount: 1 }),
              new Cancelled({}),
              new Placed({ amount: 3 }),
            ],
            0,
          )
          yield* sB.append({ id: "y" }, [new Placed({ amount: 5 })], 0)
          const ea = yield* sA.read({ id: "x" })
          yield* record("B applies", B.applyBatch(yield* sB.read({ id: "y" })))
          yield* record("A applies", A.applyBatch(ea.slice(0, 2)))
          yield* record("A removes", A.applyBatch([ea[2]]))
          yield* record("A applies over its tombstone", A.applyBatch([ea[3]]))
          yield* record("get", db.entities.Rows.get({ id: "ax" }))
        }),
    }
  }

  // As above, B's checkpoint; the application's `create` over A's tombstone, with its own `n`.
  {
    const { AppSchema, events, sA, sB } = base("rolesd")
    const Model = Schema.Struct({
      id: Schema.String,
      total: Schema.Number,
      n: Schema.optional(Schema.Number),
      cp: Schema.optional(Schema.Number),
      rev: Schema.optional(Schema.Number),
    })
    const Rows = lib.Entity.make({
      model: Model,
      entityType: "Read",
      primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
    })
    const read = lib.Table.make({ schema: AppSchema, entities: { Rows } })
    const A = lib.EventStore.projection({
      stream: sA,
      readModel: Rows,
      key: (id: any) => ({ id: `a${id.id}` }),
      initial: (id: any) => ({ id: `a${id.id}`, total: 0 }),
      evolve: (state: any, event: { readonly data: Placed | Cancelled }) =>
        Effect.succeed(
          event.data._tag === "Cancelled"
            ? lib.EventStore.removeRow
            : { ...state, total: state.total + event.data.amount, n: (state.n ?? 0) + 100 },
        ),
      checkpoint: "cp",
      revision: "rev",
      removal: {},
      retry: 3,
    })
    lib.EventStore.projection({
      stream: sB,
      readModel: Rows,
      key: (id: any) => ({ id: `b${id.id}` }),
      initial: (id: any) => ({ id: `b${id.id}`, total: 0 }),
      evolve,
      checkpoint: "n",
      retry: 3,
    })
    out["roles: A's data field is B's checkpoint, create over A's tombstone with its own value"] = {
      events,
      read,
      steps: ({ record }) =>
        Effect.gen(function* () {
          const db = yield* lib.DynamoClient.make({ entities: { Rows }, tables: { read } })
          yield* sA.append({ id: "x" }, [new Placed({ amount: 2 }), new Cancelled({})], 0)
          const ea = yield* sA.read({ id: "x" })
          yield* record("A applies", A.applyBatch([ea[0]]))
          yield* record("A removes", A.applyBatch([ea[1]]))
          yield* record("create", Rows.create({ id: "ax", total: 10, n: 7 }).asEffect())
          yield* record("get", db.entities.Rows.get({ id: "ax" }))
        }),
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// One projection: a sparse checkpoint map left empty by a field-mapped source; the TTL attribute.
// ---------------------------------------------------------------------------

const otherScenarios = (lib: Library): Record<string, Scenario> => {
  const out: Record<string, Scenario> = {}
  {
    const AppSchema = lib.DynamoSchema.make({ name: "sparsefm", version: 1 })
    const events = lib.Table.make({ schema: AppSchema, entities: {} })
    const sA = lib.EventStore.makeStream({
      table: events,
      streamName: "OrdersA",
      events: [Placed, Cancelled],
      streamId: { composite: ["id"] },
    })
    const Model = Schema.Struct({
      id: Schema.String,
      total: Schema.Number,
      checkpoints: Schema.Record(Schema.String, Schema.Number),
      revision: Schema.optional(Schema.Number),
      aV: Schema.optional(Schema.Number),
      aOwner: Schema.optional(Schema.String),
    })
    const Rows = lib.Entity.make({
      model: lib.DynamoModel.configure(Model, {
        checkpoints: { storedAs: lib.DynamoModel.SparseMap({ prefix: "cp" }) },
      }),
      entityType: "Read",
      primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
    })
    const read = lib.Table.make({ schema: AppSchema, entities: { Rows } })
    const A = lib.EventStore.multiProjection({
      readModel: Rows,
      initial: (key: any) => ({ id: key.id, total: 0, checkpoints: {} }),
      sources: (source: any) => ({
        a: source(sA, {
          key: (id: any) => ({ id: id.id }),
          evolve: (state: any, event: { readonly data: Placed | Cancelled }) =>
            Effect.succeed(
              event.data._tag === "Cancelled"
                ? lib.EventStore.removeRow
                : { ...state, total: state.total + event.data.amount },
            ),
        }),
      }),
      checkpoints: {
        field: "checkpoints",
        sources: { a: { field: "aV", instanceField: "aOwner" } },
      },
      revision: "revision",
      removal: {},
      retry: 3,
    })
    const tag = (from: ReadonlyArray<unknown>) => from.map((event) => ({ stream: "a", event }))
    out["one projection: a sparse checkpoint map a field-mapped source leaves empty"] = {
      events,
      read,
      steps: ({ record }) =>
        Effect.gen(function* () {
          const db = yield* lib.DynamoClient.make({ entities: { Rows }, tables: { read } })
          yield* sA.append(
            { id: "x" },
            [new Placed({ amount: 2 }), new Cancelled({}), new Placed({ amount: 3 })],
            0,
          )
          const ea = yield* sA.read({ id: "x" })
          yield* record("applies", A.applyBatch(tag([ea[0]])))
          yield* record("removes", A.applyBatch(tag([ea[1]])))
          yield* record("create", Rows.create({ id: "x", total: 10, checkpoints: {} }).asEffect())
          yield* record("late removal", A.applyBatch(tag([ea[1]])))
          yield* record("next event", A.applyBatch(tag([ea[2]])))
          yield* record("get", db.entities.Rows.get({ id: "x" }))
        }),
    }
  }
  // A tombstone written while the read model's one projection sets the TTL attribute; then a
  // projection with `removal` keeping its checkpoint in the TTL attribute (which the head refuses
  // when it writes, not when it's defined), and `create` over the tombstone. With `again`, the
  // tombstone's writer is defined again after it, so it's the one with `removal` defined last.
  for (const again of [false, true]) {
    const AppSchema = lib.DynamoSchema.make({ name: "ttlcreate", version: 1 })
    const events = lib.Table.make({ schema: AppSchema, entities: {} })
    const stream = (streamName: string) =>
      lib.EventStore.makeStream({
        table: events,
        streamName,
        events: [Placed, Cancelled],
        streamId: { composite: ["id"] },
      })
    const Invoices = stream("Invoice")
    const Orders = stream("Order")
    const Model = Schema.Struct({
      id: Schema.String,
      total: Schema.Number,
      x: Schema.optional(Schema.Number),
      r: Schema.optional(Schema.Number),
      _ttl: Schema.optional(Schema.Number),
    })
    const Rows = lib.Entity.make({
      model: Model,
      entityType: "Tally",
      primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
    })
    const read = lib.Table.make({ schema: AppSchema, entities: { Rows } })
    const evolve = (state: any, event: { readonly data: Placed | Cancelled }) =>
      Effect.succeed(
        event.data._tag === "Cancelled"
          ? lib.EventStore.removeRow
          : { ...state, total: state.total + event.data.amount },
      )
    const defineInvoices = () =>
      lib.EventStore.projection({
        stream: Invoices,
        readModel: Rows,
        key: (id: any) => ({ id: id.id }),
        initial: (id: any) => ({ id: id.id, total: 0 }),
        evolve,
        checkpoint: "x",
        removal: { ttl: "7 days" },
        retry: 3,
      })
    const ByInvoice = defineInvoices()
    const name = again
      ? "two projections: create over the tombstone of the one defined last, the other keeping the TTL attribute"
      : "two projections: create over the first's tombstone, the one defined last keeping the TTL attribute"
    out[name] = {
      events,
      read,
      steps: ({ record }) =>
        Effect.gen(function* () {
          yield* Invoices.append({ id: "t" }, history(), 0)
          yield* record("removes", ByInvoice.applyBatch(yield* Invoices.read({ id: "t" })))
          lib.EventStore.projection({
            stream: Orders,
            readModel: Rows,
            key: (id: any) => ({ id: id.id }),
            initial: (id: any) => ({ id: id.id, total: 0 }),
            evolve,
            checkpoint: "_ttl",
            revision: "r",
            removal: {},
            retry: 3,
          })
          if (again) defineInvoices()
          yield* record("create", Rows.create({ id: "t", total: 5 }).asEffect())
        }),
      // The tombstone's writer is the first projection: 1.39.0 carried the second's layout only,
      // the TTL attribute with it, so the created row expired with the tombstone.
      ...(!again && {
        carried: { stored: { x: { N: "2" } }, returned: { x: 2 }, dropped: ["_ttl"] },
      }),
    }
  }
  return out
}

/**
 * What the row token (#237) changes in a scenario's outcome from 1.39.0's, and why: what steps
 * return, by label, and the stored items' attributes, by partition key (`null`: no longer stored).
 */
interface Since {
  readonly why: string
  readonly results?: Record<string, unknown>
  readonly items?: Record<string, Record<string, unknown>>
}

const absentRead =
  "A projection's write for a row it read absent proves the key still holds nothing, instead " +
  "of reading the key again for a tombstone to replace: one GetItem fewer for each new row."

export const since: Record<string, Since> = {
  "ledger: a shared row the order projection removes": {
    why:
      "The order projection's tombstone keeps the invoice projection's checkpoint and revision, " +
      "and the invoice projection's row over it keeps the order projection's: the redelivered " +
      "invoice event and the late removal are recognised. 1.39.0 applied the invoice event " +
      "again, bringing the removed row back, and the late removal removed the row the invoice " +
      "projection wrote after it.",
    results: {
      "invoice redelivered": { removed: true, applied: 0, alreadyApplied: 1 },
      "order's late removal": { removed: false, applied: 0, alreadyApplied: 1 },
    },
    items: {
      "$shared#v1#ledger#id_x1": {
        __edd_e__: { S: "Ledger" },
        __edd_removed__: null,
        id: { S: "x1" },
        invoiceVersion: { N: "2" },
        revision: { N: "2" },
        total: { N: "7" },
      },
    },
  },
  "ledger: a shared row removed twice": {
    why:
      "The order projection's tombstone keeps the invoice projection's checkpoint and revision: " +
      "the invoice projection's removal folds its one new event, and the order projection's " +
      "late removal is recognised. 1.39.0 folded both streams again.",
    results: {
      "invoice removes": { removed: true, applied: 1, alreadyApplied: 0 },
      "order's late removal": { removed: true, applied: 0, alreadyApplied: 1 },
    },
    items: {
      "$shared#v1#ledger#id_x3": { invoiceVersion: { N: "2" }, revision: { N: "2" } },
    },
  },
  "ledger: a shared row with a projection without removal": {
    why:
      "The order projection's tombstone keeps the payment projection's checkpoint: its " +
      "redelivered event is recognised. 1.39.0 applied it again and brought the removed row back.",
    results: { "payment redelivered": { removed: true, applied: 0, alreadyApplied: 1 } },
    items: {
      "$shared#v1#ledger#id_x4": {
        __edd_e__: { S: "Ledger#tombstone" },
        __edd_removed__: { S: "1970-01-01T00:00:00.000Z" },
        id: null,
        orderRev: { N: "1" },
        orderVersion: { N: "2" },
        total: null,
      },
    },
  },
  "ledger: create over a shared row's tombstone": {
    why:
      "The order projection's tombstone keeps the shipment projection's checkpoint map and " +
      "revision, and `create` over it carries them, the revision raised.",
    results: {
      create: {
        id: "x2",
        total: 3,
        orderVersion: 2,
        orderRev: 2,
        checkpoints: { "shipment#x2": 1 },
        revision: 2,
      },
    },
    items: {
      "$shared#v1#ledger#id_x2": {
        checkpoints: { M: { "shipment#x2": { N: "1" } } },
        revision: { N: "2" },
      },
    },
  },
  "race: create lands between a projection's read of a tombstone and its write": {
    why:
      "`create` lands between A's read of B's tombstone and A's write, so A's write fails " +
      "(retry 0) where 1.39.0's replaced the created row; B's tombstone kept A's checkpoint and " +
      "revision, which the created row carries.",
    results: { "A's next event": { failed: "ConcurrentModification" } },
    items: {
      "$race#v1#race#id_r1": {
        a: { N: "1" },
        b: { N: "1" },
        ra: { N: "2" },
        rb: { N: "2" },
        total: { N: "10" },
      },
    },
  },
  "race: create lands between a projection's read of a tombstone and its write, in a transaction": {
    why:
      "As without a transaction: A's write fails where 1.39.0's replaced the row the " +
      "transaction created.",
    results: { "A's next event": { failed: "ConcurrentModification" } },
    items: {
      "$race#v1#race#id_r1": {
        a: { N: "1" },
        b: { N: "1" },
        ra: { N: "2" },
        rb: { N: "2" },
        total: { N: "10" },
      },
    },
  },
  "race: another projection removes the row again between a read and a write (retry 0)": {
    why: "B's tombstone keeps A's checkpoint and revision.",
    items: { "$race#v1#race#id_r2": { a: { N: "1" }, ra: { N: "1" } } },
  },
  "race: another projection removes the row again between a read and a write (retry 2)": {
    why:
      "B's tombstone keeps A's checkpoint: A's retry folds its one new event, and B's " +
      "redelivered removal is recognised. 1.39.0 folded A's stream again, and B's redelivery " +
      "removed the row A wrote after it.",
    results: {
      "A's next event": { removed: false, applied: 1, alreadyApplied: 0 },
      "B redelivered": { removed: false, applied: 0, alreadyApplied: 1 },
    },
    items: {
      "$race#v1#race#id_r2": {
        __edd_e__: { S: "Race" },
        __edd_removed__: null,
        a: { N: "2" },
        id: { S: "r2" },
        ra: { N: "2" },
        total: { N: "2" },
      },
    },
  },
  "race: another projection writes a row over the tombstone between a read and a write (retry 0)": {
    why: "B's row over A's tombstone keeps A's checkpoint and revision.",
    items: { "$race#v1#race#id_r2": { a: { N: "1" }, ra: { N: "1" } } },
  },
  "race: another projection writes a row over the tombstone between a read and a write (retry 2)": {
    why:
      "B's row over A's tombstone keeps A's checkpoint: A's retry folds its one new event, " +
      "and B's redelivered event is recognised. 1.39.0 applied A's removal again, and B's " +
      "event twice.",
    results: {
      "A's next event": { removed: false, applied: 1, alreadyApplied: 0 },
      "B redelivered": { removed: false, applied: 0, alreadyApplied: 1 },
    },
    items: { "$race#v1#race#id_r2": { ra: { N: "2" } } },
  },
  "roles: A's data field is B's checkpoint, A's row removed and written again": { why: absentRead },
  "one projection: a sparse checkpoint map a field-mapped source leaves empty": { why: absentRead },
  "roles: A's data field is B's checkpoint, create over A's tombstone with its own value": {
    why: absentRead,
  },
  "roles: A's data field is B's revision, A's row removed and written again": { why: absentRead },
  "roles: create over A's tombstone, A's checkpoint B's revision (B defined first)": {
    why: absentRead,
  },
  "roles: create over A's tombstone, A's checkpoint B's revision (B defined last)": {
    why: absentRead,
  },
}

/** Every scenario, by name, for `lib`. Each defines its own read model, so none reaches another. */
export const scenarios = (lib: Library): Record<string, Scenario> => ({
  ...ledgerScenarios(lib),
  ...raceScenarios(lib),
  ...rolesScenarios(lib),
  ...otherScenarios(lib),
})

/** A request's input, as JSON, with the tables' names replaced by their names in the fixture. */
const normalize = (input: unknown, tables: { readonly events: string; readonly read: string }) =>
  JSON.parse(
    JSON.stringify(input)
      .replaceAll(JSON.stringify(tables.read), '"read"')
      .replaceAll(JSON.stringify(tables.events), '"events"'),
  )

/** The items of a table, in key order, their attributes by name, as JSON (a table keeps no order). */
const inKeyOrder = (
  items: ReadonlyArray<Record<string, unknown>>,
): ReadonlyArray<Record<string, unknown>> =>
  items
    .map(
      (item) =>
        JSON.parse(
          JSON.stringify(
            Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : 1))),
          ),
        ) as Record<string, any>,
    )
    .sort((a, b) => {
      const ka = `${a.pk?.S}\u0000${a.sk?.S}`
      const kb = `${b.pk?.S}\u0000${b.sk?.S}`
      return ka < kb ? -1 : ka > kb ? 1 : 0
    })

/** The row token's attribute (#237). */
const ROW_TOKEN = "__edd_rt__"

/** A condition naming the row token read, after the write's own. */
const TOKEN_TERM = /^\((.*)\) AND \((?:attribute_not_exists\(#eddRt\)|#eddRt = :eddRt)\)$/s

/**
 * A `Put`'s item and condition without the row token, and without the request for the item as
 * stored that a write naming the token makes (to name what changed when it fails).
 */
const putWithoutRowToken = (put: Record<string, any> | undefined) => {
  if (put === undefined) return
  if (put.Item !== undefined) delete put.Item[ROW_TOKEN]
  const condition = TOKEN_TERM.exec(put.ConditionExpression ?? "")
  if (condition === null) return
  put.ConditionExpression = condition[1]
  delete put.ReturnValuesOnConditionCheckFailure
  delete put.ExpressionAttributeNames["#eddRt"]
  if (put.ExpressionAttributeValues === undefined) return
  delete put.ExpressionAttributeValues[":eddRt"]
  if (Object.keys(put.ExpressionAttributeValues).length === 0) delete put.ExpressionAttributeValues
}

/**
 * `outcome` without the row token (#237): 128 random bits, left out of the stored items and the
 * requests' items, and the term naming the one read (and the request for the item as stored that
 * comes with it) left out of their conditions. What the token
 * holds and how a write names it is pinned in `EventStore.projection-row-token.test.ts`.
 */
const withoutRowToken = (outcome: Outcome): Outcome => {
  const out = JSON.parse(JSON.stringify(outcome)) as {
    requests: Array<{ operation: string; input: any }>
    items: Array<Record<string, unknown>>
    results: Outcome["results"]
  }
  for (const item of out.items) delete item[ROW_TOKEN]
  for (const { operation, input } of out.requests) {
    if (operation === "putItem") putWithoutRowToken(input)
    if (operation === "transactWriteItems") {
      for (const item of input.TransactItems) putWithoutRowToken(item.Put)
    }
  }
  return out
}

/**
 * Run `scenario` on tables named `tables` over `client` (a layer of the library's `DynamoClient`);
 * `items` reads the read model's table afterwards (marshalled items).
 */
export const run = <E, R>(
  lib: Library,
  scenario: Scenario,
  tables: { readonly events: string; readonly read: string },
  client: Layer.Layer<any, E, R>,
  items: (table: string) => Effect.Effect<ReadonlyArray<Record<string, unknown>>, unknown, any>,
): Effect.Effect<Outcome, unknown, R> => {
  const requests: Array<Sent> = []
  const results: Array<readonly [string, unknown]> = []
  const pending: { run?: Effect.Effect<unknown, unknown, any> | undefined } = {}
  const names = (input: unknown) => JSON.stringify(input).includes(`"${tables.read}"`)
  const recorded = Layer.effect(
    lib.DynamoClient,
    Effect.map(
      lib.DynamoClient as Effect.Effect<Record<string, unknown>>,
      (inner) =>
        new Proxy(inner, {
          get: (target, operation) => {
            const value = target[operation as string]
            if (typeof value !== "function") return value
            return (input: unknown, ...rest: Array<unknown>) => {
              const reads = names(input)
              if (reads)
                requests.push({ operation: String(operation), input: normalize(input, tables) })
              const sent = value.call(target, input, ...rest) as Effect.Effect<
                unknown,
                unknown,
                any
              >
              if (operation !== "getItem" || !reads) return sent
              return Effect.tap(sent, () => {
                const next = pending.run
                if (next === undefined) return Effect.void
                pending.run = undefined
                return Effect.asVoid(next)
              })
            }
          },
        }),
    ),
  ).pipe(Layer.provide(client))
  const steps: Steps = {
    record: (label, effect) =>
      effect.pipe(
        Effect.map((value) => summary(value)),
        Effect.catch((error) => Effect.succeed(errorOf(error))),
        Effect.flatMap((value) => Effect.sync(() => void results.push([label, value]))),
      ) as Effect.Effect<void>,
    between: (effect) => {
      pending.run = effect
    },
  }
  return Effect.gen(function* () {
    yield* scenario.steps(steps)
    if (pending.run !== undefined) return yield* Effect.die(new Error("`between` never ran"))
    const stored = yield* items(tables.read)
    // As JSON, so a step that returned nothing reads as the capture does.
    return withoutRowToken({ requests, items: inKeyOrder(stored), results })
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        recorded,
        scenario.events.layer({ name: tables.events }),
        scenario.read.layer({ name: tables.read }),
      ),
    ),
  ) as Effect.Effect<Outcome, unknown, R>
}

/**
 * What `scenario` sends, stores and returns: 1.39.0's outcome with what `since` says, its requests
 * those of the row-token fixture, which must store and return exactly that.
 */
export const expected = (name: string, scenario: Scenario): Outcome => {
  const was = asCaptured(name, scenario)
  const change = since[name]
  if (change === undefined) return was
  const now = rowTokenFixture().scenarios[name]
  if (now === undefined) throw new Error(`no row-token capture for "${name}"`)
  const results = change.results ?? {}
  for (const label of Object.keys(results)) {
    if (was.results.filter(([at]) => at === label).length !== 1) {
      throw new Error(`"${name}" has no single step "${label}"`)
    }
  }
  expect(now.results).toEqual(
    was.results.map(([label, value]) => [
      label,
      Object.hasOwn(results, label) ? results[label] : value,
    ]),
  )
  const items = change.items ?? {}
  expect(now.items).toEqual(
    inKeyOrder(
      was.items.map((item) => {
        const changed = items[(item.pk as { readonly S: string }).S]
        if (changed === undefined) return item
        const out: Record<string, unknown> = { ...item }
        for (const [attribute, value] of Object.entries(changed)) {
          if (value === null) delete out[attribute]
          else out[attribute] = value
        }
        return out
      }),
    ),
  )
  return now
}

/**
 * What 1.39.0 sent, stored and returned for `scenario`, with what `create` over a tombstone now
 * carries (`carried`) appended to its put's item and to the item stored at its key.
 */
const asCaptured = (name: string, scenario: Scenario): Outcome => {
  const captured = fixture().scenarios[name]
  if (captured === undefined) throw new Error(`no capture for "${name}"`)
  if (scenario.carried === undefined) return captured
  const { stored: carried, returned, dropped = [] } = scenario.carried
  const out = JSON.parse(JSON.stringify(captured)) as {
    requests: Array<{ operation: string; input: any }>
    items: Array<Record<string, any>>
    results: Outcome["results"]
  }
  const last = out.requests.at(-1)!
  const item =
    last.operation === "transactWriteItems" ? last.input.TransactItems[0].Put.Item : last.input.Item
  if (item === undefined) throw new Error(`"${name}" doesn't end with a put`)
  for (const attribute of dropped) {
    if (!Object.hasOwn(item, attribute)) throw new Error(`1.39.0 didn't carry "${attribute}"`)
    delete item[attribute]
  }
  for (const [attribute, value] of Object.entries(carried)) {
    if (Object.hasOwn(item, attribute)) throw new Error(`1.39.0 carried "${attribute}" already`)
    item[attribute] = value
  }
  const at = out.items.findIndex(
    (stored) => stored.pk?.S === item.pk.S && stored.sk?.S === item.sk.S,
  )
  const kept = Object.fromEntries(
    Object.entries(out.items[at]!).filter(([attribute]) => !dropped.includes(attribute)),
  )
  out.items[at] = inKeyOrder([{ ...kept, ...carried }])[0]!
  // What `create` returned, when it returns the row.
  const created = out.results.map(([label]) => label).lastIndexOf("create")
  const value = out.results[created]![1]
  if (value !== null && typeof value === "object") {
    const left = Object.fromEntries(
      Object.entries(value).filter(([field]) => !dropped.includes(field)),
    )
    ;(out.results as Array<readonly [string, unknown]>)[created] = [
      "create",
      { ...left, ...returned },
    ]
  }
  return out
}

/** `outcome` is what `expected` says, every request the same bytes. */
export const expectAsCaptured = (name: string, scenario: Scenario, outcome: Outcome) => {
  const want = expected(name, scenario)
  expect(outcome.results).toEqual(want.results)
  expect(outcome.items).toEqual(want.items)
  expect(outcome.requests.map((request) => JSON.stringify(request))).toEqual(
    want.requests.map((request) => JSON.stringify(request)),
  )
}
