/**
 * Whether a projection's write over a live row keeps the row's data (#237), judged on exactly the
 * attribute map its request carries: the item encoded, renamed, as sparse entries, packed and then
 * marshalled. A write over a row another projection (B) has written carries B's bookkeeping only
 * where it stores every data attribute the row holds. Anything the marshaller leaves out is a
 * dropped attribute, whatever leaves it out; anything it stores, under the same name, is kept,
 * whatever its value or type.
 *
 * Each kind runs standalone and in the outbox's transaction, under both `escapeKeys` settings.
 * B's events are 5 and 7; A writes once, between B's first event and B's redelivery of it.
 *
 * - **Dropped** (the marshaller stores nothing for the value): B's bookkeeping goes with the data,
 *   as on 1.40.0, so B's redelivered event applies again and B's part comes back whole.
 * - **Kept** (the attribute is stored, with A's value): B's bookkeeping is carried, so B's
 *   redelivery is `alreadyApplied` and B goes on from A's value (1.40.0 dropped it, so B folded
 *   its stream again: the decided reset, `EventStore.projection-carry.test.ts`).
 * - **Refused** (the marshaller refuses the value): A's write fails, as on 1.40.0, and the row is
 *   as B left it.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { describe, expect, it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { DateTime, Effect, Exit, Layer, Schema } from "effect"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
import * as Table from "../src/Table.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

class Placed extends Schema.TaggedClass<Placed>()("Placed", { amount: Schema.Number }) {}

/** A value the marshaller stores as a map of its fields (`convertClassInstanceToMap`). */
class Point {
  constructor(readonly x: number) {}
}

type Outcome = "dropped" | "kept" | "refused"

type Case = {
  readonly name: string
  readonly outcome: Outcome
  /** The data field `d`, as B's program declares it. */
  readonly field: Schema.Top
  /** The data field as A's program declares it, when A runs another program. */
  readonly fieldA?: Schema.Top
  readonly sparse?: boolean
  /** What `initial` gives `d`. */
  readonly initial?: unknown
  /** B's value for `d`, given its state and its event's amount. */
  readonly b: (d: any, amount: number) => unknown
  /** A's value for `d`. */
  readonly a: unknown
  /** The attribute holding B's data. */
  readonly attribute?: string
  /** The attribute after B's next event, as stored. */
  readonly final: AttributeValue
}

const num = (value: unknown): number => (typeof value === "number" ? value : 0)
const strings = Schema.ReadonlySet(Schema.String)

const cases: ReadonlyArray<Case> = [
  // The marshaller stores nothing for the value.
  {
    name: "an optional set emptied",
    outcome: "dropped",
    field: Schema.optional(strings),
    b: (d, n) => new Set([...(d ?? []), `v${n}`]),
    a: new Set(),
    final: { SS: ["v5", "v7"] },
  },
  {
    name: "a required set reset to its initial empty value",
    outcome: "dropped",
    field: strings,
    initial: new Set(),
    b: (d, n) => new Set([...d, `v${n}`]),
    a: new Set(),
    final: { SS: ["v5", "v7"] },
  },
  {
    name: "a number set emptied",
    outcome: "dropped",
    field: Schema.optional(Schema.ReadonlySet(Schema.Number)),
    b: (d, n) => new Set([...(d ?? []), n]),
    a: new Set(),
    final: { NS: ["5", "7"] },
  },
  {
    name: "a sparse map's entry holding a set, emptied",
    outcome: "dropped",
    field: Schema.Record(Schema.String, strings),
    sparse: true,
    initial: {},
    b: (d, n) => ({ ...d, x: new Set([...(d.x ?? []), `v${n}`]) }),
    a: { x: new Set() },
    attribute: "iv#x",
    final: { SS: ["v5", "v7"] },
  },
  {
    name: "a function",
    outcome: "dropped",
    field: Schema.optional(Schema.Unknown),
    b: (d, n) => ({ n: num(d?.n) + n }),
    a: () => 0,
    final: { M: { n: { N: "12" } } },
  },
  // The attribute is stored, under the same name.
  {
    name: "a set with one member removed",
    outcome: "kept",
    field: Schema.optional(strings),
    b: (d, n) => new Set([...(d ?? []), `v${n}`, "k"]),
    a: new Set(["k"]),
    final: { SS: ["k", "v7"] },
  },
  {
    name: "undefined inside a map",
    outcome: "kept",
    field: Schema.optional(Schema.Record(Schema.String, Schema.UndefinedOr(Schema.Number))),
    b: (d, n) => ({ x: num(d?.x) + n }),
    a: { x: undefined },
    final: { M: { x: { N: "7" } } },
  },
  {
    name: "undefined inside a list",
    outcome: "kept",
    field: Schema.optional(Schema.Array(Schema.UndefinedOr(Schema.Number))),
    b: (d, n) => [...(d ?? []), n],
    a: [undefined],
    final: { L: [{ N: "7" }] },
  },
  {
    name: "an empty string",
    outcome: "kept",
    field: Schema.optional(Schema.String),
    b: (d, n) => `${d ?? ""}${n}`,
    a: "",
    final: { S: "7" },
  },
  {
    name: "an empty binary",
    outcome: "kept",
    field: Schema.optional(Schema.Uint8Array),
    b: (_d, n) => new Uint8Array([n]),
    a: new Uint8Array(0),
    final: { B: new Uint8Array([7]) },
  },
  {
    name: "a set inside a list, one member removed",
    outcome: "kept",
    field: Schema.optional(Schema.Array(strings)),
    b: (_d, n) => [new Set([`v${n}`, "k"])],
    a: [new Set(["k"])],
    final: { L: [{ SS: ["k", "v7"] }] },
  },
  {
    name: "a class instance",
    outcome: "kept",
    field: Schema.optional(Schema.Unknown),
    b: (d, n) => ({ n: num(d?.n) + n }),
    a: new Point(0),
    final: { M: { n: { N: "7" } } },
  },
  {
    name: "another type under the same name",
    outcome: "kept",
    field: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
    b: (_d, n) => `v${n}`,
    a: 0,
    final: { S: "v7" },
  },
  {
    // B's program stores the date as epoch milliseconds, A's (a later deployment) as ISO text.
    name: "a date another program stores as another type",
    outcome: "kept",
    field: Schema.optional(Schema.DateTimeUtc.pipe(DynamoModel.storedAs(DynamoModel.DateEpochMs))),
    fieldA: Schema.optional(Schema.DateTimeUtc),
    b: (_d, n) => DateTime.makeUnsafe(n * 1000),
    a: DateTime.makeUnsafe(1000),
    final: { N: "7000" },
  },
  // The marshaller refuses the value.
  {
    name: "a set inside a list, emptied",
    outcome: "refused",
    field: Schema.optional(Schema.Array(strings)),
    b: (_d, n) => [new Set([`v${n}`])],
    a: [new Set()],
    final: { L: [{ SS: ["v7"] }] },
  },
]

/** One read model's program: its entity, and projections A (`Orders`) and B (`Invoices`). */
const program = (
  c: Case,
  field: Schema.Top,
  escapeKeys: boolean,
  outbox: boolean,
  table: ReturnType<typeof makeRecordingTable>,
) => {
  const schema = DynamoSchema.make({ name: "stored", version: 1, escapeKeys })
  const Events = Table.make({ schema, entities: {} })
  const stream = (streamName: string) =>
    EventStore.makeStream({
      table: Events,
      streamName,
      events: [Placed],
      streamId: { composite: ["id"] },
    })
  const Orders = stream("Order")
  const Invoices = stream("Invoice")
  const Model = Schema.Struct({
    id: Schema.String,
    orders: Schema.Number,
    d: field,
    a: Schema.optional(Schema.Number),
    ra: Schema.optional(Schema.Number),
    b: Schema.optional(Schema.Number),
    rb: Schema.optional(Schema.Number),
  } as any)
  const Rows = Entity.make({
    model: c.sparse
      ? DynamoModel.configure(
          Model as any,
          {
            d: { storedAs: DynamoModel.SparseMap({ prefix: "iv" }) },
          } as any,
        )
      : Model,
    entityType: "Row",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
  } as any) as any
  const Read = Table.make({ schema, entities: { Rows } })
  const define = (from: typeof Orders, checkpoint: string, revision: string, evolve: any) =>
    EventStore.projection({
      stream: from,
      readModel: Rows,
      key: (id: { readonly id: string }) => ({ id: id.id }),
      initial: (id: { readonly id: string }) => ({
        id: id.id,
        orders: 0,
        ...(c.initial !== undefined && { d: c.initial }),
      }),
      evolve: (state: any, event: any) => Effect.succeed(evolve(state, event)),
      checkpoint,
      revision,
      retry: 0,
      ...(outbox && { outbox: { schema: Schema.Number, effects: () => [1] } }),
    } as any) as any
  const A = define(Orders, "a", "ra", (state: any, event: any) => ({
    id: state.id,
    orders: state.orders + event.data.amount,
    d: c.a,
  }))
  const B = define(Invoices, "b", "rb", (state: any, event: any) => ({
    ...state,
    d: c.b(state.d, event.data.amount),
  }))
  const layer = Layer.mergeAll(
    Layer.succeed(DynamoClient, table.client),
    Events.layer({ name: "events" }),
    Read.layer({ name: "read" }),
  )
  return { Orders, Invoices, A, B, layer }
}

/** A set's members in order, so two sets compare by their members. */
const normal = (value: AttributeValue | undefined): unknown => {
  if (value === undefined) return undefined
  if (value.SS !== undefined) return { SS: [...value.SS].sort() }
  if (value.NS !== undefined) return { NS: [...value.NS].sort() }
  if (value.B !== undefined) return { B: [...value.B] }
  if (value.L !== undefined) return { L: value.L.map(normal) }
  if (value.M !== undefined) {
    return { M: Object.fromEntries(Object.entries(value.M).map(([k, v]) => [k, normal(v)])) }
  }
  return value
}

const failureOf = (exit: Exit.Exit<unknown, unknown>): string | undefined => {
  if (Exit.isSuccess(exit)) return undefined
  const error = (exit.cause as any).reasons?.[0]?.error
  return `${error?._tag} ${/EDD-\d+/.exec(String(error?.cause ?? error?.message))?.[0]}`
}

describe("a write over a live row the other projection has written, judged on its marshalled attributes (#237)", () => {
  for (const c of cases) {
    for (const outbox of [false, true]) {
      for (const escapeKeys of [false, true]) {
        it.effect(
          `${c.name} (${c.outcome})${outbox ? ", in the outbox's transaction" : ""}, escapeKeys ${escapeKeys ? "on" : "off"}`,
          () => {
            const table = makeRecordingTable()
            const forB = program(c, c.field, escapeKeys, outbox, table)
            const forA =
              c.fieldA === undefined ? forB : program(c, c.fieldA, escapeKeys, outbox, table)
            const name = c.attribute ?? "d"
            const row = () => [...table.items.values()].find((item) => item.__edd_e__?.S === "Row")!
            return Effect.gen(function* () {
              const { Orders, Invoices } = forB
              const setUp = Effect.gen(function* () {
                yield* Orders.append({ id: "x" }, [new Placed({ amount: 1 })], 0)
                yield* Invoices.append(
                  { id: "x" },
                  [new Placed({ amount: 5 }), new Placed({ amount: 7 })],
                  0,
                )
                return {
                  orders: yield* Orders.read({ id: "x" }),
                  invoices: yield* Invoices.read({ id: "x" }),
                }
              })
              const { orders, invoices } = yield* Effect.provide(setUp, forB.layer)
              yield* Effect.provide(forB.B.apply(invoices[0]!), forB.layer)
              expect(row()[name]).toBeDefined()
              expect(row()).toMatchObject({ b: { N: "1" }, rb: { N: "1" } })

              const wrote = yield* Effect.exit(Effect.provide(forA.A.apply(orders[0]!), forA.layer))
              if (c.outcome === "refused") {
                // As on 1.40.0: the marshaller refuses A's value, and nothing is written.
                expect(failureOf(wrote)).toBe("ValidationError EDD-9124")
                expect(row().a).toBeUndefined()
              } else {
                expect(failureOf(wrote)).toBeUndefined()
                expect(row().a).toEqual({ N: "1" })
              }
              if (c.outcome === "dropped") {
                // Nothing stored for B's data, and B's bookkeeping went with it, as on 1.40.0.
                expect(Object.hasOwn(row(), name)).toBe(false)
                expect(row().b).toBeUndefined()
                expect(row().rb).toBeUndefined()
              } else {
                expect(Object.hasOwn(row(), name)).toBe(true)
                expect(row()).toMatchObject({ b: { N: "1" }, rb: { N: "1" } })
              }

              const redelivered = (yield* Effect.provide(
                forB.B.apply(invoices[0]!),
                forB.layer,
              )) as {
                readonly applied: ReadonlyArray<unknown>
                readonly alreadyApplied: ReadonlyArray<unknown>
              }
              expect(redelivered.applied).toHaveLength(c.outcome === "dropped" ? 1 : 0)
              expect(redelivered.alreadyApplied).toHaveLength(c.outcome === "dropped" ? 0 : 1)
              yield* Effect.provide(forB.B.apply(invoices[1]!), forB.layer)
              expect(normal(row()[name])).toEqual(normal(c.final))
              expect(row()).toMatchObject({ b: { N: "2" }, rb: { N: "2" } })
            }) as Effect.Effect<void, unknown>
          },
        )
      }
    }
  }
})
