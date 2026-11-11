/**
 * Projections writing one read model's rows (#237). On a read model with more than one projection
 * layout, every projection write, tombstone and rebuild write, and `create` over a tombstone, writes
 * a fresh row token (`__edd_rt__`) conditioned on the one it read, so a write that read the row
 * before another fails and retries. A tombstone, and a write over one, carry the bookkeeping of the
 * other projections that have written the row, and an attribute holding two meanings on such a row
 * is refused (`EDD-9144`). A read model with one projection layout carries no token: without
 * `removal` it sends and stores what 1.40.0 did, and with `removal` and no revision its write over a
 * tombstone it read names the tombstone, so it can't replace a row `create` wrote there.
 */

import { describe, expect, it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Effect, Exit, Layer, Schema } from "effect"
import { beforeEach } from "vitest"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
import { fromAttributeMap } from "../src/Marshaller.js"
import * as Table from "../src/Table.js"
import { hooks, InMemoryClient, resetStore, store } from "./helpers/InMemoryTables.js"

class Placed extends Schema.TaggedClass<Placed>()("Placed", { amount: Schema.Number }) {}
class Cancelled extends Schema.TaggedClass<Cancelled>()("Cancelled", {}) {}

const AppSchema = DynamoSchema.make({ name: "token", version: 1 })
const EventsTable = Table.make({ schema: AppSchema, entities: {} })
const stream = (streamName: string) =>
  EventStore.makeStream({
    table: EventsTable,
    streamName,
    events: [Placed, Cancelled],
    streamId: { composite: ["id"] },
  })
const Orders = stream("Order")
const Invoices = stream("Invoice")
const OutboxTable = Table.make({ schema: AppSchema, entities: {} })

const Row = Schema.Struct({
  id: Schema.String,
  total: Schema.Number,
  a: Schema.optional(Schema.Number),
  ra: Schema.optional(Schema.Number),
  b: Schema.optional(Schema.Number),
  rb: Schema.optional(Schema.Number),
  shared: Schema.optional(Schema.Number),
})
type Row = typeof Row.Type

/** A projection's bookkeeping, and whether it removes rows. */
interface Layout {
  readonly checkpoint: "a" | "b" | "shared"
  readonly revision?: "ra" | "rb" | "shared"
  readonly removal?: boolean
  readonly outbox?: boolean
}

const evolve = (state: Row, event: { readonly data: Placed | Cancelled }) =>
  Effect.succeed(
    event.data._tag === "Cancelled"
      ? EventStore.removeRow
      : { ...state, total: state.total + event.data.amount },
  )

/** A fresh read model `Row`, A projecting `Orders` and B projecting `Invoices` onto it. */
const setup = (a: Layout, b: Layout | undefined, options?: { readonly key?: "a" | "b" }) => {
  const Rows = Entity.make({
    model: Row,
    entityType: "Row",
    primaryKey: {
      pk: { field: "pk", composite: ["id"] },
      sk: { field: "sk", composite: [] },
    },
  })
  const ReadTable = Table.make({ schema: AppSchema, entities: { Rows } })
  const define = (from: typeof Orders, layout: Layout, prefix: string) =>
    EventStore.projection({
      stream: from,
      readModel: Rows,
      // Rows of their own (`a-<id>`, `b-<id>`), or one row per id.
      key: (id: { readonly id: string }) => ({
        id: options?.key === undefined ? id.id : `${prefix}-${id.id}`,
      }),
      initial: (id: { readonly id: string }): Row => ({
        id: options?.key === undefined ? id.id : `${prefix}-${id.id}`,
        total: 0,
      }),
      evolve,
      checkpoint: layout.checkpoint,
      ...(layout.revision !== undefined && { revision: layout.revision }),
      ...(layout.removal === true && { removal: {} }),
      ...(layout.outbox === true && {
        outbox: {
          schema: Schema.Struct({ total: Schema.Number }),
          effects: (_event: unknown, next: Row | undefined) =>
            next === undefined ? [] : [{ total: next.total }],
          table: OutboxTable,
        },
      }),
      retry: 0,
    })
  const A = define(Orders, a, "a")
  const B = b === undefined ? undefined : define(Invoices, b, "b")
  const layer = Layer.mergeAll(
    InMemoryClient,
    EventsTable.layer({ name: "events" }),
    ReadTable.layer({ name: "read" }),
    OutboxTable.layer({ name: "outbox" }),
  )
  /** The item stored at `id`'s row, as stored. */
  const row = (id: string): Record<string, unknown> | undefined => {
    const item = store.get(`read|$token#v1#row#id_${id}|$token#v1#row`)
    return item === undefined ? undefined : (fromAttributeMap(item) as Record<string, unknown>)
  }
  /** Run `effect` once, right after the next read of a row returns. */
  const between = (effect: Effect.Effect<unknown, unknown, any>) => {
    hooks.afterGet.push(() => {
      Effect.runSync(effect.pipe(Effect.provide(layer)) as Effect.Effect<unknown, unknown>)
    })
  }
  return { Rows, A, B: B!, layer, row, between }
}

/** `item` without its row token. */
const untokened = (item: Record<string, unknown> | undefined) => {
  if (item === undefined) return undefined
  const { __edd_rt__: _, ...rest } = item
  return rest
}

beforeEach(() => resetStore())

describe("a row two projections write (#237 §1)", () => {
  it.effect(
    "a tombstone keeps the other's checkpoint and revision, so its redelivery stays out",
    () => {
      const { A, B, layer, row } = setup(
        { checkpoint: "a", revision: "ra", removal: true },
        { checkpoint: "b", revision: "rb" },
      )
      return Effect.gen(function* () {
        yield* Orders.append({ id: "x" }, [new Placed({ amount: 1 }), new Cancelled({})], 0)
        yield* Invoices.append({ id: "x" }, [new Placed({ amount: 5 })], 0)
        const orders = yield* Orders.read({ id: "x" })
        const invoice = (yield* Invoices.read({ id: "x" }))[0]!
        yield* A.apply(orders[0]!)
        yield* B.apply(invoice)
        yield* A.apply(orders[1]!)
        expect(untokened(row("x"))).toMatchObject({ __edd_e__: "Row#tombstone", a: 2, b: 1, rb: 1 })
        // 1.39.0 and 1.40.0 applied it again over the tombstone: a row of total 5.
        const again = yield* B.apply(invoice)
        expect(again.applied).toHaveLength(0)
        expect(again.alreadyApplied).toHaveLength(1)
        expect(row("x")?.__edd_e__).toBe("Row#tombstone")
      }).pipe(Effect.provide(layer))
    },
  )

  it.effect(
    "a write over the other's tombstone keeps its checkpoints, whatever `initial` gives",
    () => {
      const { A, B, layer, row } = setup(
        { checkpoint: "a", revision: "ra", removal: true },
        { checkpoint: "b", revision: "rb" },
      )
      return Effect.gen(function* () {
        yield* Orders.append({ id: "x" }, [new Cancelled({}), new Placed({ amount: 2 })], 0)
        yield* Invoices.append({ id: "x" }, [new Placed({ amount: 5 })], 0)
        const orders = yield* Orders.read({ id: "x" })
        const invoice = (yield* Invoices.read({ id: "x" }))[0]!
        yield* B.apply(invoice)
        yield* A.apply(orders[0]!)
        yield* A.apply(orders[1]!)
        expect(untokened(row("x"))).toMatchObject({ total: 2, a: 2, b: 1, rb: 1 })
        expect((yield* B.apply(invoice)).applied).toHaveLength(0)
      }).pipe(Effect.provide(layer))
    },
  )

  it.effect(
    "a write that read the row before the other's write fails, and retried keeps both",
    () => {
      const { A, B, layer, row, between } = setup(
        { checkpoint: "a", revision: "ra" },
        { checkpoint: "b", revision: "rb" },
      )
      return Effect.gen(function* () {
        yield* Orders.append({ id: "x" }, [new Placed({ amount: 1 }), new Placed({ amount: 2 })], 0)
        yield* Invoices.append({ id: "x" }, [new Placed({ amount: 5 })], 0)
        const orders = yield* Orders.read({ id: "x" })
        yield* A.apply(orders[0]!)
        between(B.apply((yield* Invoices.read({ id: "x" }))[0]!))
        // 1.39.0 and 1.40.0: A's write, guarded by its own revision, replaced B's (total 3, no `b`).
        const exit = yield* Effect.exit(A.apply(orders[1]!))
        expect(Exit.isFailure(exit)).toBe(true)
        expect(String(exit)).toContain("ConcurrentModification")
        expect(untokened(row("x"))).toMatchObject({ total: 6, a: 1, b: 1 })
        yield* A.apply(orders[1]!)
        expect(untokened(row("x"))).toMatchObject({ total: 8, a: 2, b: 1 })
      }).pipe(Effect.provide(layer))
    },
  )

  it.effect(
    "a write guarded by its checkpoint alone doesn't replace a tombstone written since",
    () => {
      const { A, B, layer, row, between } = setup(
        { checkpoint: "a" },
        { checkpoint: "b", revision: "rb", removal: true },
      )
      return Effect.gen(function* () {
        yield* Orders.append({ id: "x" }, [new Placed({ amount: 1 }), new Placed({ amount: 2 })], 0)
        yield* Invoices.append({ id: "x" }, [new Cancelled({})], 0)
        const orders = yield* Orders.read({ id: "x" })
        yield* A.apply(orders[0]!)
        between(B.apply((yield* Invoices.read({ id: "x" }))[0]!))
        // 1.39.0 and 1.40.0: A's write, guarded by `a = 1`, replaced B's tombstone with a live row.
        const exit = yield* Effect.exit(A.apply(orders[1]!))
        expect(String(exit)).toContain("ConcurrentModification")
        expect(untokened(row("x"))).toMatchObject({ __edd_e__: "Row#tombstone", a: 1, b: 1 })
      }).pipe(Effect.provide(layer))
    },
  )

  it.effect("a rebuild over a live row drops the other's part, which it applies again", () => {
    const { A, B, layer, row } = setup(
      { checkpoint: "a", revision: "ra" },
      { checkpoint: "b", revision: "rb" },
    )
    return Effect.gen(function* () {
      yield* Orders.append({ id: "x" }, [new Placed({ amount: 1 })], 0)
      yield* Invoices.append({ id: "x" }, [new Placed({ amount: 5 })], 0)
      yield* A.apply((yield* Orders.read({ id: "x" }))[0]!)
      yield* B.apply((yield* Invoices.read({ id: "x" }))[0]!)
      yield* A.rebuild({ id: "x" })
      expect(untokened(row("x"))).toMatchObject({ total: 1, a: 1 })
      expect(row("x")?.b).toBeUndefined()
      // B's next event folds every event of its stream again, from its checkpoint's absence.
      yield* Invoices.append({ id: "x" }, [new Placed({ amount: 3 })], 1)
      yield* B.apply((yield* Invoices.read({ id: "x" }))[1]!)
      expect(untokened(row("x"))).toMatchObject({ total: 9, a: 1, b: 2 })
    }).pipe(Effect.provide(layer))
  })

  it.effect(
    "projections writing disjoint rows gain nothing of each other's, whatever their roles",
    () => {
      const { A, B, layer, row } = setup(
        { checkpoint: "a", revision: "shared", removal: true },
        { checkpoint: "shared" },
        { key: "a" },
      )
      return Effect.gen(function* () {
        yield* Orders.append({ id: "x" }, [new Placed({ amount: 1 }), new Cancelled({})], 0)
        yield* Invoices.append({ id: "x" }, [new Placed({ amount: 5 })], 0)
        const orders = yield* Orders.read({ id: "x" })
        yield* A.apply(orders[0]!)
        yield* A.apply(orders[1]!)
        yield* B.apply((yield* Invoices.read({ id: "x" }))[0]!)
        // Disjoint rows: neither gains the other's attributes.
        expect(untokened(row("a-x"))).toEqual({
          pk: "$token#v1#row#id_a-x",
          sk: "$token#v1#row",
          __edd_e__: "Row#tombstone",
          __edd_removed__: expect.any(String),
          a: 2,
          shared: 2,
        })
        expect(untokened(row("b-x"))).toMatchObject({ total: 5, shared: 1 })
        expect(row("b-x")?.a).toBeUndefined()
      }).pipe(Effect.provide(layer))
    },
  )
})

describe("[EDD-9144] an attribute holding two meanings on a row two projections write (#237 §2)", () => {
  it.effect("the other's revision is never read as this projection's checkpoint", () => {
    const { A, B, layer, row } = setup(
      { checkpoint: "a", revision: "shared", removal: true },
      { checkpoint: "shared" },
    )
    return Effect.gen(function* () {
      yield* Orders.append({ id: "x" }, [new Cancelled({})], 0)
      yield* Invoices.append({ id: "x" }, [new Placed({ amount: 5 })], 0)
      yield* A.apply((yield* Orders.read({ id: "x" }))[0]!)
      // 1.39.0 and 1.40.0 read A's revision 1 as B's checkpoint: `alreadyApplied`, no write.
      const error = yield* Effect.flip(B.apply((yield* Invoices.read({ id: "x" }))[0]!))
      expect(error).toMatchObject({ _tag: "ValidationError" })
      expect(String((error as { readonly cause?: unknown }).cause)).toContain(
        `[EDD-9144] EventStore.projection("Invoice" → "Row"): on read model "Row", "shared" is ` +
          `EventStore.projection("Order" → "Row")'s revision on a row ` +
          `EventStore.projection("Order" → "Row") has written, and this projection's checkpoint.`,
      )
      expect(row("x")?.__edd_e__).toBe("Row#tombstone")
    }).pipe(Effect.provide(layer))
  })

  it.effect("a write changing the other's checkpoint is refused before anything is sent", () => {
    // A keeps `shared` as data; B keeps it as its checkpoint.
    const { Rows, B, layer, row } = setup(
      { checkpoint: "a", revision: "ra" },
      { checkpoint: "shared" },
    )
    return Effect.gen(function* () {
      yield* Invoices.append({ id: "x" }, [new Placed({ amount: 5 })], 0)
      yield* Orders.append({ id: "x" }, [new Placed({ amount: 1 })], 0)
      yield* B.apply((yield* Invoices.read({ id: "x" }))[0]!)
      const before = row("x")
      const changing = EventStore.projection({
        stream: Orders,
        readModel: Rows,
        key: (id: { readonly id: string }) => ({ id: id.id }),
        initial: (id: { readonly id: string }): Row => ({ id: id.id, total: 0 }),
        evolve: (state: Row) => Effect.succeed({ ...state, shared: 7 }),
        checkpoint: "a",
        revision: "ra",
      })
      const error = yield* Effect.flip(changing.apply((yield* Orders.read({ id: "x" }))[0]!))
      expect(String((error as { readonly cause?: unknown }).cause)).toContain(
        `this write changes "shared", which is EventStore.projection("Invoice" → "Row")'s ` +
          `checkpoint, on a row EventStore.projection("Invoice" → "Row") has written.`,
      )
      expect(row("x")).toEqual(before)
    }).pipe(Effect.provide(layer))
  })
})

describe("a read model with one projection layout", () => {
  it.effect("a write over a tombstone fails when `create` lands after its read", () => {
    const { Rows, A, layer, row, between } = setup({ checkpoint: "a", removal: true }, undefined)
    return Effect.gen(function* () {
      yield* Orders.append({ id: "x" }, [new Placed({ amount: 1 }), new Cancelled({})], 0)
      const orders = yield* Orders.read({ id: "x" })
      yield* A.apply(orders[0]!)
      yield* A.apply(orders[1]!)
      // One projection: no row token. Its write names the tombstone it read instead.
      expect(row("x")?.__edd_rt__).toBeUndefined()
      between(Rows.create({ id: "x", total: 10 }).asEffect())
      yield* Orders.append({ id: "x" }, [new Placed({ amount: 4 })], 2)
      const next = (yield* Orders.read({ id: "x" }))[2]!
      // 1.39.0 and 1.40.0: A's write, guarded by `a = 2`, replaced the created row.
      const exit = yield* Effect.exit(A.apply(next))
      expect(String(exit)).toContain("ConcurrentModification")
      expect(untokened(row("x"))).toMatchObject({ total: 10, a: 2 })
    }).pipe(Effect.provide(layer))
  })

  it.effect("without removal, sends what 1.40.0 did: no row token", () => {
    const { A, layer, row } = setup({ checkpoint: "a", revision: "ra" }, undefined)
    return Effect.gen(function* () {
      yield* Orders.append({ id: "x" }, [new Placed({ amount: 1 })], 0)
      yield* A.apply((yield* Orders.read({ id: "x" }))[0]!)
      expect(row("x")).not.toHaveProperty("__edd_rt__")
    }).pipe(Effect.provide(layer))
  })
})

describe("a worker draining the outbox of a read model whose rows carry the row token", () => {
  it.effect("needs only its outbox's table", () => {
    const { A, B, layer } = setup(
      { checkpoint: "a", revision: "ra", outbox: true },
      { checkpoint: "b", revision: "rb" },
    )
    return Effect.gen(function* () {
      // The writers, with every table: both projections write the row.
      yield* Effect.gen(function* () {
        yield* Orders.append({ id: "x" }, [new Placed({ amount: 1 })], 0)
        yield* Invoices.append({ id: "x" }, [new Placed({ amount: 5 })], 0)
        yield* B.apply((yield* Invoices.read({ id: "x" }))[0]!)
        yield* A.apply((yield* Orders.read({ id: "x" }))[0]!)
      }).pipe(Effect.provide(layer))
      // The worker, with its outbox's table alone.
      const delivered: Array<unknown> = []
      yield* A.drain({ id: "x" }, (effect) => Effect.sync(() => void delivered.push(effect))).pipe(
        Effect.provide(Layer.mergeAll(InMemoryClient, OutboxTable.layer({ name: "outbox" }))),
      )
      expect(delivered).toEqual([{ total: 6 }])
    })
  })
})
