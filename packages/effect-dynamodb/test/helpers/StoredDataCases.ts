/**
 * The cases of `EventStore.projection-stored-data.test.ts` (#237), shared with its run on DynamoDB
 * Local (`connected.projection-stored-data.test.ts`): whether a projection's write over a live row
 * another projection has written keeps the row's data, judged on the row's attributes as read and
 * the attribute map the write's request carries.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { DateTime, Effect, Exit, Layer, Schema } from "effect"
import { expect } from "vitest"
import type { DynamoClient } from "../../src/DynamoClient.js"
import * as Entity from "../../src/Entity.js"
import * as EventStore from "../../src/EventStore.js"
import * as Table from "../../src/Table.js"

export class Placed extends Schema.TaggedClass<Placed>()("Placed", { amount: Schema.Number }) {}

/** A value the marshaller stores as a map of its fields (`convertClassInstanceToMap`). */
export class Point {
  constructor(readonly x: number) {}
}

export type Outcome = "dropped" | "kept" | "refused"

export type Case = {
  readonly name: string
  readonly outcome: Outcome
  /** The data field `d`, as B's program declares it. */
  readonly field: Schema.Top
  /** The data field as A's program declares it, when A runs another program; `null`: it has none. */
  readonly fieldA?: Schema.Top | null
  /** How B's program stores its fields (`DynamoModel.configure`); `sparse`: `d` a sparse map. */
  readonly stored?: Record<string, unknown>
  /** How A's program stores its fields, when A runs another program. */
  readonly storedA?: Record<string, unknown>
  /** Fields only A's program has, and what A writes to them instead of `d`. */
  readonly onlyA?: {
    readonly fields: Record<string, Schema.Top>
    readonly writes: Record<string, unknown>
  }
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

export const cases: ReadonlyArray<Case> = [
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
  // A's program (a later deployment, or an earlier one still running) defines the row otherwise:
  // judged on the attribute names alone, never on either program's definition of its data.
  {
    // B's reader, finding no `dB`, takes A's `d` (its field's own name), as 1.40.0's did: B folds
    // its stream again from A's value.
    name: "a field the other program renames (B's under dB, A's under d)",
    outcome: "dropped",
    field: Schema.optional(Schema.Number),
    stored: { d: { field: "dB" } },
    storedA: {},
    b: (d, n) => num(d) + n,
    a: 100,
    attribute: "dB",
    final: { N: "112" },
  },
  {
    name: "a field the other program renames (B's under d, A's under dA)",
    outcome: "dropped",
    field: Schema.optional(Schema.Number),
    storedA: { d: { field: "dA" } },
    b: (d, n) => num(d) + n,
    a: 100,
    final: { N: "12" },
  },
  {
    name: "a field the other program doesn't define",
    outcome: "dropped",
    field: Schema.optional(Schema.Number),
    fieldA: null,
    onlyA: { fields: {}, writes: {} },
    b: (d, n) => num(d) + n,
    a: undefined,
    final: { N: "12" },
  },
  {
    name: "a field the other program keeps inside a packed field",
    outcome: "dropped",
    field: Schema.optional(Schema.Number),
    fieldA: null,
    storedA: { meta: { storedAs: DynamoModel.Packed({ format: "json" }) } },
    onlyA: {
      fields: { meta: Schema.optional(Schema.Struct({ d: Schema.optional(Schema.Number) })) },
      writes: { meta: { d: 100 } },
    },
    b: (d, n) => num(d) + n,
    a: undefined,
    final: { N: "12" },
  },
  {
    name: "a sparse map the other program stores under another prefix",
    outcome: "dropped",
    field: Schema.Record(Schema.String, Schema.Number),
    sparse: true,
    storedA: { d: { storedAs: DynamoModel.SparseMap({ prefix: "ia" }) } },
    initial: {},
    b: (d, n) => ({ ...(d ?? {}), x: num(d?.x) + n }),
    a: { x: 100 },
    attribute: "iv#x",
    final: { N: "12" },
  },
  {
    name: "a field the other program packs (B's native, A's packed)",
    outcome: "kept",
    field: Schema.optional(Schema.Struct({ n: Schema.Number })),
    storedA: { d: { storedAs: DynamoModel.Packed({ format: "json" }) } },
    b: (d, n) => ({ n: num(d?.n) + n }),
    a: { n: 100 },
    final: { M: { n: { N: "107" } } },
  },
  {
    name: "a field the other program doesn't pack (B's packed, A's native)",
    outcome: "kept",
    field: Schema.optional(Schema.Struct({ n: Schema.Number })),
    stored: { d: { storedAs: DynamoModel.Packed({ format: "json" }) } },
    storedA: {},
    b: (d, n) => ({ n: num(d?.n) + n }),
    a: { n: 100 },
    final: { S: '{"n":107}' },
  },
  // The marshaller refuses the value.
  {
    name: "a symbol",
    outcome: "refused",
    field: Schema.optional(Schema.Unknown),
    b: (d, n) => ({ n: num(d?.n) + n }),
    a: Symbol("s"),
    final: { M: { n: { N: "12" } } },
  },
  {
    name: "NaN",
    outcome: "refused",
    field: Schema.optional(Schema.Number),
    b: (d, n) => num(d) + n,
    a: Number.NaN,
    final: { N: "12" },
  },
  {
    name: "a set inside a list, emptied",
    outcome: "refused",
    field: Schema.optional(Schema.Array(strings)),
    b: (_d, n) => [new Set([`v${n}`])],
    a: [new Set()],
    final: { L: [{ SS: ["v7"] }] },
  },
]

/** Whether A runs another program than B's. */
export const otherProgram = (c: Case): boolean =>
  c.fieldA !== undefined || c.storedA !== undefined || c.onlyA !== undefined

/**
 * One read model's program, as `side` declares it: its entity, and projections A (`Orders`) and B
 * (`Invoices`).
 */
export const program = (
  c: Case,
  side: "A" | "B",
  escapeKeys: boolean,
  outbox: boolean,
  client: Layer.Layer<DynamoClient>,
  names: { readonly events: string; readonly read: string },
) => {
  const field = side === "A" && c.fieldA !== undefined ? c.fieldA : c.field
  const stored =
    side === "A" && c.storedA !== undefined
      ? c.storedA
      : (c.stored ?? (c.sparse ? { d: { storedAs: DynamoModel.SparseMap({ prefix: "iv" }) } } : {}))
  const only = side === "A" ? (c.onlyA?.fields ?? {}) : {}
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
    ...(field !== null && { d: field }),
    ...only,
    a: Schema.optional(Schema.Number),
    ra: Schema.optional(Schema.Number),
    b: Schema.optional(Schema.Number),
    rb: Schema.optional(Schema.Number),
  } as any)
  const Rows = Entity.make({
    model:
      Object.keys(stored).length > 0 ? DynamoModel.configure(Model as any, stored as any) : Model,
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
    ...(c.onlyA === undefined ? { d: c.a } : c.onlyA.writes),
  }))
  const B = define(Invoices, "b", "rb", (state: any, event: any) => ({
    ...state,
    d: c.b(state.d, event.data.amount),
  }))
  const layer = Layer.mergeAll(
    client,
    Events.layer({ name: names.events }),
    Read.layer({ name: names.read }),
  )
  return { Orders, Invoices, A, B, layer }
}

/** A set's members in order, so two sets compare by their members. */
export const normal = (value: AttributeValue | undefined): unknown => {
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

export const failureOf = (exit: Exit.Exit<unknown, unknown>): string | undefined => {
  if (Exit.isSuccess(exit)) return undefined
  const error = (exit.cause as any).reasons?.[0]?.error
  return `${error?._tag} ${/EDD-\d+/.exec(String(error?.cause ?? error?.message))?.[0]}`
}

/**
 * Run case `c`: B applies its first event, A writes once (from its own program, where it runs
 * another), B's first event is redelivered, then B applies its second. `row` reads the row as
 * stored; `client` and `names` are the tables'.
 */
export const runCase = (
  c: Case,
  outbox: boolean,
  escapeKeys: boolean,
  client: Layer.Layer<DynamoClient>,
  names: { readonly events: string; readonly read: string },
  readRow: Effect.Effect<Record<string, AttributeValue>, unknown>,
): Effect.Effect<void, unknown> => {
  const forB = program(c, "B", escapeKeys, outbox, client, names)
  const forA = otherProgram(c) ? program(c, "A", escapeKeys, outbox, client, names) : forB
  const name = c.attribute ?? "d"
  return Effect.gen(function* () {
    const { Orders, Invoices } = forB
    const setUp = Effect.gen(function* () {
      yield* Orders.append({ id: "x" }, [new Placed({ amount: 1 })], 0)
      yield* Invoices.append({ id: "x" }, [new Placed({ amount: 5 }), new Placed({ amount: 7 })], 0)
      return {
        orders: yield* Orders.read({ id: "x" }),
        invoices: yield* Invoices.read({ id: "x" }),
      }
    })
    const { orders, invoices } = yield* Effect.provide(setUp, forB.layer)
    yield* Effect.provide(forB.B.apply(invoices[0]!), forB.layer)
    let row = yield* readRow
    expect(row[name]).toBeDefined()
    expect(row).toMatchObject({ b: { N: "1" }, rb: { N: "1" } })

    const wrote = yield* Effect.exit(Effect.provide(forA.A.apply(orders[0]!), forA.layer))
    row = yield* readRow
    if (c.outcome === "refused") {
      // As on 1.40.0: the marshaller refuses A's value, and nothing is written.
      expect(failureOf(wrote)).toBe("ValidationError EDD-9124")
      expect(row.a).toBeUndefined()
    } else {
      expect(failureOf(wrote)).toBeUndefined()
      expect(row.a).toEqual({ N: "1" })
    }
    if (c.outcome === "dropped") {
      // Nothing stored for B's data, and B's bookkeeping went with it, as on 1.40.0.
      expect(Object.hasOwn(row, name)).toBe(false)
      expect(row.b).toBeUndefined()
      expect(row.rb).toBeUndefined()
    } else {
      expect(Object.hasOwn(row, name)).toBe(true)
      expect(row).toMatchObject({ b: { N: "1" }, rb: { N: "1" } })
    }

    const redelivered = (yield* Effect.provide(forB.B.apply(invoices[0]!), forB.layer)) as {
      readonly applied: ReadonlyArray<unknown>
      readonly alreadyApplied: ReadonlyArray<unknown>
    }
    expect(redelivered.applied).toHaveLength(c.outcome === "dropped" ? 1 : 0)
    expect(redelivered.alreadyApplied).toHaveLength(c.outcome === "dropped" ? 0 : 1)
    yield* Effect.provide(forB.B.apply(invoices[1]!), forB.layer)
    row = yield* readRow
    expect(normal(row[name])).toEqual(normal(c.final))
    expect(row).toMatchObject({ b: { N: "2" }, rb: { N: "2" } })
  }) as Effect.Effect<void, unknown>
}
