/**
 * A projection's write carrying the bookkeeping of the read model's other projections that have
 * written the row (#237): through one function (`carriedOf`) at every site that replaces the row,
 * and only where the other projections' data stays.
 *
 * The matrix runs every kind of bookkeeping the other projection can keep, at every site, then
 * every next step, then redelivers every event: the outcome each must have is the `ideal` table,
 * the same for every kind. `fixtures/projection-carry-1.40.0.json` holds the published 1.40.0's
 * outcomes, captured once by running this same matrix on it: where 1.40.0's met the ideal, this
 * release's is the same.
 */

import { readFileSync } from "node:fs"
import { describe, expect, it } from "@effect/vitest"
import { Compression } from "@effect-dynamodb/schema/Compression.js"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Effect, Exit, Layer, Schema } from "effect"
import { beforeEach } from "vitest"
import * as ZlibCompression from "../src/compression/zlib.js"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
import * as TransactableOps from "../src/internal/TransactableOps.js"
import { fromAttributeMap } from "../src/Marshaller.js"
import * as Table from "../src/Table.js"
import { InMemoryClient, resetStore, store } from "./helpers/InMemoryTables.js"

class Placed extends Schema.TaggedClass<Placed>()("Placed", { amount: Schema.Number }) {}
class Cancelled extends Schema.TaggedClass<Cancelled>()("Cancelled", {}) {}

const AppSchema = DynamoSchema.make({ name: "carry", version: 1 })
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
const Third = stream("Third")

const ROW = "read|$carry#v1#row#id_x|$carry#v1#row"

const fields = {
  id: Schema.String,
  total: Schema.Number,
  a: Schema.optional(Schema.Number),
  ra: Schema.optional(Schema.Number),
  b: Schema.optional(Schema.Number),
  rb: Schema.optional(Schema.Number),
  owner: Schema.optional(Schema.String),
  orders: Schema.optional(Schema.Number),
  invoices: Schema.optional(Schema.Number),
  note: Schema.optional(Schema.String),
}

/**
 * What the other projection (B) keeps as bookkeeping. Not a sparse map: since 1.40.0 one can't
 * hold a checkpoint map's keys (`<source>#<id>`), so one reaches a row only in a tombstone 1.39.0
 * wrote (the pin in `EventStore.projection-tombstone-layouts.test.ts`).
 */
type Kind =
  | "scalar checkpoint"
  | "scalar checkpoint and revision"
  | "owner slot"
  | "native map"
  | "packed map"
  | "compressed packed map"
const kinds: ReadonlyArray<Kind> = [
  "scalar checkpoint",
  "scalar checkpoint and revision",
  "owner slot",
  "native map",
  "packed map",
  "compressed packed map",
]

/** Where A's write replaces a row B has written. */
type Site = "live → live" | "live → tombstone" | "tombstone → created row" | "rebuild"
const sites: ReadonlyArray<Site> = [
  "live → live",
  "live → tombstone",
  "tombstone → created row",
  "rebuild",
]

/** What comes next. */
type Then = "redelivery" | "next event" | "removal" | "create" | "rebuild"
const thens: ReadonlyArray<Then> = ["redelivery", "next event", "removal", "create", "rebuild"]

const modelOf = (kind: Kind) => {
  switch (kind) {
    case "packed map":
      return DynamoModel.configure(
        Schema.Struct({
          ...fields,
          map: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
        }),
        { map: { storedAs: DynamoModel.Packed({ format: "json" }) } },
      )
    case "compressed packed map":
      return DynamoModel.configure(
        Schema.Struct({
          ...fields,
          map: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
        }),
        {
          map: {
            storedAs: DynamoModel.Packed({
              format: "json",
              compression: { codec: "gzip", threshold: 0 },
            }),
          },
        },
      )
    default:
      return Schema.Struct({
        ...fields,
        map: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
      })
  }
}

const evolve = (state: any, event: { readonly data: Placed | Cancelled }) =>
  Effect.succeed(
    event.data._tag === "Cancelled"
      ? EventStore.removeRow
      : { ...state, total: state.total + event.data.amount },
  )

/**
 * A fresh read model: A (`Orders`; checkpoint `a`, revision `ra`, removal) and B (`Invoices`)
 * keeping `kind`, with removal.
 */
const world = (kind: Kind) => {
  const Rows = Entity.make({
    model: modelOf(kind) as any,
    entityType: "Row",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
  }) as any
  const ReadTable = Table.make({ schema: AppSchema, entities: { Rows } })
  const initial = (id: { readonly id: string }) => ({ id: id.id, total: 0 })
  const A = EventStore.projection({
    stream: Orders,
    readModel: Rows,
    key: (id: { readonly id: string }) => ({ id: id.id }),
    initial,
    evolve,
    checkpoint: "a",
    revision: "ra",
    removal: {},
    retry: 0,
  } as any) as any
  const single = kind === "scalar checkpoint" || kind === "scalar checkpoint and revision"
  const B: any = single
    ? EventStore.projection({
        stream: Invoices,
        readModel: Rows,
        key: (id: { readonly id: string }) => ({ id: id.id }),
        initial,
        evolve,
        checkpoint: "b",
        ...(kind === "scalar checkpoint and revision" && { revision: "rb" }),
        removal: {},
        retry: 0,
      } as any)
    : EventStore.multiProjection({
        readModel: Rows,
        initial,
        sources: (source: any) => ({
          invoice: source(Invoices, {
            key: (id: { readonly id: string }) => ({ id: id.id }),
            evolve,
          }),
        }),
        checkpoints:
          kind === "owner slot"
            ? { sources: { invoice: { field: "b", instanceField: "owner" } } }
            : { field: "map" },
        revision: "rb",
        removal: {},
        retry: 0,
      } as any)
  const applyB = (event: unknown): Effect.Effect<unknown, unknown> =>
    single
      ? B.apply(event)
      : Effect.flatMap(B.applyBatch([{ stream: "invoice", event }]), (result: any) =>
          result.outcomes[0]?._tag === "Failed"
            ? Effect.fail(result.outcomes[0].error)
            : Effect.succeed(result),
        )
  const rebuildB = (): Effect.Effect<unknown, unknown> =>
    single
      ? B.rebuild({ id: "x" })
      : B.rebuild({ id: "x" }, { instances: { invoice: [{ id: "x" }] } })
  const create = (total: number): Effect.Effect<unknown, unknown> =>
    Rows.create({ id: "x", total }).asEffect()
  const layer = Layer.mergeAll(
    InMemoryClient,
    EventsTable.layer({ name: "events" }),
    ReadTable.layer({ name: "read" }),
    Compression.layer([ZlibCompression.gzip()]),
  )
  return { Rows, A, applyB, rebuildB, create, layer }
}

/** The row: absent, a tombstone, or its total. */
const state = (): number | "tombstone" | "absent" => {
  const item = store.get(ROW)
  if (item === undefined) return "absent"
  if (item.__edd_e__?.S === "Row#tombstone") return "tombstone"
  return Number(item.total?.N)
}

const outcomeOf = (exit: Exit.Exit<unknown, unknown>): string => {
  if (Exit.isSuccess(exit)) return "ok"
  const error = (exit.cause as any).reasons?.[0]?.error ?? (exit.cause as any).failures?.[0]
  const tag = error?._tag ?? String(exit.cause).slice(0, 80)
  const code = /EDD-\d+/.exec(String(error?.cause ?? ""))?.[0]
  return code === undefined ? tag : `${tag} ${code}`
}

/**
 * Every projection the row token names has an attribute on the row: the token describes the row
 * as it is (no-op where the library has no row token).
 */
const tagsNamePresentAttributes = (Rows: object) => {
  const ops = TransactableOps as any
  if (typeof ops.rowWriters !== "function") return
  const item = store.get(ROW)
  if (item === undefined) return
  const known = new Map<string, any>(
    (ops.projectionLayoutsOf(Rows) ?? []).map((layout: any) => [ops.layoutTag(layout), layout]),
  )
  for (const tag of ops.rowWriters(item.__edd_rt__)) {
    const layout = known.get(tag)
    expect(layout, `token tag ${tag}`).toBeDefined()
    const present = layout.roles.some(([field]: [string]) => Object.hasOwn(item, field))
    expect(present, `token names ${layout.label}, whose attributes the row doesn't hold`).toBe(true)
  }
}

type Cell = {
  readonly step: string
  readonly afterThen: number | "tombstone" | "absent"
  readonly afterRedelivery: number | "tombstone" | "absent"
}

const run = (kind: Kind, site: Site, then: Then): Effect.Effect<Cell, unknown> => {
  resetStore()
  const w = world(kind)
  return Effect.gen(function* () {
    yield* Orders.append(
      { id: "x" },
      site === "live → live" || site === "rebuild"
        ? [new Placed({ amount: 1 })]
        : [new Cancelled({})],
      0,
    )
    yield* Invoices.append(
      { id: "x" },
      then === "next event" || then === "rebuild"
        ? [new Placed({ amount: 5 }), new Placed({ amount: 7 })]
        : then === "removal"
          ? [new Placed({ amount: 5 }), new Cancelled({})]
          : [new Placed({ amount: 5 })],
      0,
    )
    const orders = yield* Orders.read({ id: "x" })
    const invoices = yield* Invoices.read({ id: "x" })
    yield* w.applyB(invoices[0])
    tagsNamePresentAttributes(w.Rows)
    yield* site === "rebuild" ? w.A.rebuild({ id: "x" }) : w.A.apply(orders[0])
    tagsNamePresentAttributes(w.Rows)
    if (site === "tombstone → created row") yield* w.create(100)
    tagsNamePresentAttributes(w.Rows)
    const step =
      then === "redelivery"
        ? w.applyB(invoices[0])
        : then === "next event" || then === "removal"
          ? w.applyB(invoices[1])
          : then === "create"
            ? w.create(100)
            : w.rebuildB()
    const exit = yield* Effect.exit(step)
    tagsNamePresentAttributes(w.Rows)
    const afterThen = state()
    for (const event of orders) yield* Effect.exit(w.A.apply(event))
    for (const event of invoices) yield* Effect.exit(w.applyB(event))
    tagsNamePresentAttributes(w.Rows)
    return { step: outcomeOf(exit), afterThen, afterRedelivery: state() }
  }).pipe(Effect.provide(w.layer)) as Effect.Effect<Cell, unknown>
}

/** What each cell must give, whatever B keeps: [after the step, after every event redelivered]. */
const ideal: Record<Site, Record<Then, readonly [string, Cell["afterThen"], Cell["afterThen"]]>> = {
  "live → live": {
    redelivery: ["ok", 6, 6],
    "next event": ["ok", 13, 13],
    removal: ["ok", "tombstone", "tombstone"],
    create: ["ConditionalCheckFailed", 6, 6],
    // B's rebuild drops A's part and checkpoint, so A applies its event again.
    rebuild: ["ok", 12, 13],
  },
  "live → tombstone": {
    // B's event went into a row A then removed: it never comes back.
    redelivery: ["ok", "tombstone", "tombstone"],
    "next event": ["ok", 7, 7],
    removal: ["ok", "tombstone", "tombstone"],
    create: ["ok", 100, 100],
    rebuild: ["ok", 12, 12],
  },
  "tombstone → created row": {
    redelivery: ["ok", 100, 100],
    "next event": ["ok", 107, 107],
    removal: ["ok", "tombstone", "tombstone"],
    create: ["ConditionalCheckFailed", 100, 100],
    // B's rebuild drops A's checkpoint, so A applies its removal again; B's events stay applied.
    rebuild: ["ok", 12, "tombstone"],
  },
  // A's rebuild drops B's part and checkpoint, so B folds its stream again.
  rebuild: {
    redelivery: ["ok", 6, 6],
    "next event": ["ok", 13, 13],
    removal: ["ok", "tombstone", "tombstone"],
    create: ["ConditionalCheckFailed", 1, 6],
    rebuild: ["ok", 12, 13],
  },
}

const published = JSON.parse(
  readFileSync(new URL("./fixtures/projection-carry-1.40.0.json", import.meta.url), "utf8"),
) as { readonly version: string; readonly cells: Record<string, Cell> }

const name = (kind: Kind, site: Site, then: Then) => `${kind} / ${site} / ${then}`
const meets = (
  cell: Cell,
  [step, afterThen, afterRedelivery]: readonly [string, unknown, unknown],
) => cell.step === step && cell.afterThen === afterThen && cell.afterRedelivery === afterRedelivery

beforeEach(() => resetStore())

describe("the other projections' bookkeeping, by kind × site × what follows (#237)", () => {
  for (const kind of kinds) {
    for (const site of sites) {
      for (const then of thens) {
        it.effect(name(kind, site, then), () =>
          Effect.gen(function* () {
            const cell = yield* run(kind, site, then)
            const [outcome, afterThen, afterRedelivery] = ideal[site][then]
            expect(cell).toEqual({ step: outcome, afterThen, afterRedelivery })
            const before = published.cells[name(kind, site, then)]!
            if (meets(before, ideal[site][then])) expect(cell).toEqual(before)
          }),
        )
      }
    }
  }

  it("1.40.0 missed it where its tombstone dropped the other's bookkeeping, and nowhere else", () => {
    expect(published.version).toBe("1.40.0")
    const missed = Object.entries(published.cells)
      .filter(([cell, outcome]) => {
        const [, site, then] = cell.split(" / ") as [Kind, Site, Then]
        return !meets(outcome, ideal[site][then])
      })
      .map(([cell]) => cell)
    // B's event applied again over A's tombstone, or over the row `create` wrote there, or (after
    // B's rebuild drops A's checkpoint, and A applies its removal again) over A's new tombstone.
    expect(missed).toEqual(
      kinds.flatMap((kind) => [
        name(kind, "live → tombstone", "redelivery"),
        name(kind, "live → tombstone", "next event"),
        name(kind, "live → tombstone", "create"),
        name(kind, "tombstone → created row", "redelivery"),
        name(kind, "tombstone → created row", "next event"),
        name(kind, "tombstone → created row", "create"),
        name(kind, "tombstone → created row", "rebuild"),
      ]),
    )
  })
})

// ---------------------------------------------------------------------------
// Named cases
// ---------------------------------------------------------------------------

const Free = Schema.Struct({
  id: Schema.String,
  total: Schema.optional(Schema.Number),
  orders: Schema.optional(Schema.Number),
  invoices: Schema.optional(Schema.Number),
  note: Schema.optional(Schema.String),
  a: Schema.optional(Schema.Number),
  ra: Schema.optional(Schema.Number),
  b: Schema.optional(Schema.Number),
  rb: Schema.optional(Schema.Number),
  shared: Schema.optional(Schema.Number),
})
type Free = typeof Free.Type

type Evolve = (
  state: Free,
  event: { readonly data: Placed | Cancelled },
) => Free | typeof EventStore.removeRow

/** Projections over one fresh read model of `Free` rows: each `[stream, options]`. */
const free = (
  ...defined: ReadonlyArray<
    readonly [
      typeof Orders,
      {
        readonly evolve: Evolve
        readonly checkpoint: keyof Free
        readonly revision?: keyof Free
        readonly removal?: boolean
        readonly toItem?: (state: Free) => Free
      },
    ]
  >
) => {
  const Rows = Entity.make({
    model: Free,
    entityType: "Row",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
  })
  const ReadTable = Table.make({ schema: AppSchema, entities: { Rows } })
  const projections = defined.map(
    ([from, options]) =>
      EventStore.projection({
        stream: from,
        readModel: Rows,
        key: (id: { readonly id: string }) => ({ id: id.id }),
        initial: (id: { readonly id: string }): Free => ({ id: id.id }),
        evolve: (state: Free, event: { readonly data: Placed | Cancelled }) =>
          Effect.succeed(options.evolve(state, event)),
        checkpoint: options.checkpoint,
        ...(options.revision !== undefined && { revision: options.revision }),
        ...(options.removal === true && { removal: {} }),
        ...(options.toItem !== undefined && { toItem: options.toItem }),
        retry: 0,
      } as any) as any,
  )
  const layer = Layer.mergeAll(
    InMemoryClient,
    EventsTable.layer({ name: "events" }),
    ReadTable.layer({ name: "read" }),
  )
  /** The row's attributes, without its key, type and row token. */
  const row = (): Record<string, unknown> | undefined => {
    const item = store.get(ROW)
    if (item === undefined) return undefined
    const { pk: _pk, sk: _sk, __edd_rt__: _rt, ...rest } = fromAttributeMap(item) as any
    return rest
  }
  return { Rows, projections, layer, row }
}

/** `effect` with `layer` provided. */
const within =
  (layer: Layer.Layer<any, any, never>) =>
  <A>(effect: Effect.Effect<A, unknown, any>): Effect.Effect<A, unknown> =>
    effect.pipe(Effect.provide(layer)) as Effect.Effect<A, unknown>

const adds =
  (field: "total" | "orders" | "invoices"): Evolve =>
  (state, event) =>
    event.data._tag === "Cancelled"
      ? EventStore.removeRow
      : { ...state, [field]: (state[field] ?? 0) + event.data.amount }

describe("a rebuild (#237)", () => {
  it.effect(
    "never reads the checkpoint, so another's revision in that attribute refuses nothing",
    () => {
      // A's revision is `shared`; B keeps its checkpoint there.
      const { projections, layer, row } = free(
        [Orders, { evolve: adds("total"), checkpoint: "a", revision: "shared", removal: true }],
        [Invoices, { evolve: adds("total"), checkpoint: "shared" }],
      )
      const [A, B] = projections
      return Effect.gen(function* () {
        yield* Orders.append({ id: "x" }, [new Cancelled({})], 0)
        yield* Invoices.append({ id: "x" }, [new Placed({ amount: 5 })], 0)
        yield* A.apply((yield* Orders.read({ id: "x" }))[0]!)
        expect(row()).toMatchObject({ __edd_e__: "Row#tombstone", a: 1, shared: 1 })
        // As 1.40.0 did: B's rebuild folds its stream from `initial`, its checkpoint from scratch.
        yield* B.rebuild({ id: "x" })
        expect(row()).toMatchObject({ __edd_e__: "Row", total: 5, shared: 1 })
      }).pipe(within(layer))
    },
  )

  it.effect("drops the other's bookkeeping and its name from the row token", () => {
    // C keeps its checkpoint in `rb`, B's revision.
    const { Rows, projections, layer, row } = free(
      [Orders, { evolve: adds("total"), checkpoint: "a", revision: "ra" }],
      [Invoices, { evolve: adds("total"), checkpoint: "b", revision: "rb" }],
      [Third, { evolve: adds("total"), checkpoint: "rb" }],
    )
    const [A, B, C] = projections
    return Effect.gen(function* () {
      yield* Orders.append({ id: "x" }, [new Placed({ amount: 1 })], 0)
      yield* Invoices.append({ id: "x" }, [new Placed({ amount: 5 })], 0)
      yield* Third.append({ id: "x" }, [new Placed({ amount: 10 })], 0)
      yield* A.apply((yield* Orders.read({ id: "x" }))[0]!)
      yield* B.apply((yield* Invoices.read({ id: "x" }))[0]!)
      yield* A.rebuild({ id: "x" })
      expect(row()).toEqual({ __edd_e__: "Row", id: "x", total: 1, a: 1, ra: 2 })
      tagsNamePresentAttributes(Rows)
      // As 1.40.0 did: C applies onto the row A's rebuild left.
      yield* C.apply((yield* Third.read({ id: "x" }))[0]!)
      expect(row()).toMatchObject({ total: 11, a: 1, ra: 2, rb: 1 })
      tagsNamePresentAttributes(Rows)
    }).pipe(within(layer))
  })
})

describe("a write over a live row the other projections have written (#237)", () => {
  /**
   * A's write leaves out the invoices B wrote, by its `evolve` or its `toItem`, so it leaves out
   * B's bookkeeping too, as 1.40.0 did: B folds its stream again and puts its part back.
   */
  for (const how of ["evolve", "toItem"] as const) {
    for (const then of ["next", "redelivered"] as const) {
      it.effect(
        `that drops the other's data (by ${how}) drops its checkpoint: B's ${then} event`,
        () => {
          const ownOnly = (state: Free): Free => ({
            id: state.id,
            ...(state.orders !== undefined && { orders: state.orders }),
          })
          const { projections, layer, row } = free(
            [
              Orders,
              how === "evolve"
                ? {
                    evolve: (state, event) => ownOnly(adds("orders")(state, event) as Free),
                    checkpoint: "a",
                    revision: "ra",
                  }
                : { evolve: adds("orders"), toItem: ownOnly, checkpoint: "a", revision: "ra" },
            ],
            [Invoices, { evolve: adds("invoices"), checkpoint: "b", revision: "rb" }],
          )
          const [A, B] = projections
          return Effect.gen(function* () {
            yield* Orders.append({ id: "x" }, [new Placed({ amount: 1 })], 0)
            yield* Invoices.append(
              { id: "x" },
              [new Placed({ amount: 5 }), new Placed({ amount: 7 })],
              0,
            )
            const invoices = yield* Invoices.read({ id: "x" })
            yield* B.apply(invoices[0]!)
            yield* A.apply((yield* Orders.read({ id: "x" }))[0]!)
            expect(row()).toEqual({ __edd_e__: "Row", id: "x", orders: 1, a: 1, ra: 1 })
            const result = yield* B.apply(then === "next" ? invoices[1]! : invoices[0]!)
            // 1.40.0: the same.
            expect(result.applied).toHaveLength(then === "next" ? 2 : 1)
            expect(row()).toMatchObject(
              then === "next"
                ? { orders: 1, invoices: 12, b: 2 }
                : { orders: 1, invoices: 5, b: 1 },
            )
          }).pipe(within(layer))
        },
      )
    }
  }

  it.effect("that keeps every data attribute carries the other's bookkeeping it left out", () => {
    // A's write is `{ id, total }`: B's data (`total`) is kept, its checkpoint left out.
    const { projections, layer, row } = free(
      [
        Orders,
        {
          evolve: (state, event) => ({
            id: state.id,
            total: (state.total ?? 0) + (event.data as Placed).amount,
          }),
          checkpoint: "a",
          revision: "ra",
        },
      ],
      [Invoices, { evolve: adds("total"), checkpoint: "b", revision: "rb" }],
    )
    const [A, B] = projections
    return Effect.gen(function* () {
      yield* Orders.append({ id: "x" }, [new Placed({ amount: 1 })], 0)
      yield* Invoices.append({ id: "x" }, [new Placed({ amount: 5 }), new Placed({ amount: 7 })], 0)
      const invoices = yield* Invoices.read({ id: "x" })
      yield* B.apply(invoices[0]!)
      yield* A.apply((yield* Orders.read({ id: "x" }))[0]!)
      expect(row()).toMatchObject({ total: 6, a: 1, b: 1, rb: 1 })
      // 1.40.0 dropped `b` and `rb`: B folded both its events again, a total of 18.
      yield* B.apply(invoices[1]!)
      expect(row()).toMatchObject({ total: 13, a: 1, b: 2, rb: 2 })
    }).pipe(within(layer))
  })

  it.effect(
    "that drops only its own optional field drops the other's bookkeeping, as 1.40.0 did",
    () => {
      // A's first write sets `note`, its second leaves it out. The row records who wrote it, not
      // which data each wrote, so the dropped `note` counts as dropped data.
      const { projections, layer, row } = free(
        [
          Orders,
          {
            evolve: (state, event) => ({
              id: state.id,
              total: (state.total ?? 0) + (event.data as Placed).amount,
              ...((event.data as Placed).amount === 1 && { note: "first" }),
            }),
            checkpoint: "a",
            revision: "ra",
          },
        ],
        [Invoices, { evolve: adds("total"), checkpoint: "b", revision: "rb" }],
      )
      const [A, B] = projections
      return Effect.gen(function* () {
        yield* Orders.append({ id: "x" }, [new Placed({ amount: 1 }), new Placed({ amount: 2 })], 0)
        yield* Invoices.append(
          { id: "x" },
          [new Placed({ amount: 5 }), new Placed({ amount: 7 })],
          0,
        )
        const orders = yield* Orders.read({ id: "x" })
        const invoices = yield* Invoices.read({ id: "x" })
        yield* B.apply(invoices[0]!)
        yield* A.apply(orders[0]!)
        expect(row()).toMatchObject({ total: 6, note: "first", b: 1, rb: 1 })
        yield* A.apply(orders[1]!)
        expect(row()).toEqual({ __edd_e__: "Row", id: "x", total: 8, a: 2, ra: 2 })
        // B folds both its events again: 8 + 5 + 7, as with 1.40.0 (which dropped `b` and `rb` at
        // A's first write already).
        yield* B.apply(invoices[1]!)
        expect(row()).toMatchObject({ total: 20, a: 2, b: 2 })
      }).pipe(within(layer))
    },
  )
})
