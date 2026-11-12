/**
 * `ownsRows` (DESIGN.md §7 "Which rows in its partition are an aggregate's"). An aggregate that
 * declares it takes every row of its node types in its partition for its own: after its groups,
 * `update` deletes those of each node that changed that the new state doesn't write, `rekey`
 * moves what it moves without the option and reports the rest, and `DynamoClient.make` refuses the
 * declaration when a member it can see can write such a row (`EDD-9130`). Without it, `update` and
 * `rekey` leave every row the aggregate's value doesn't key.
 *
 * The aggregate's lines live in a sub-aggregate (its own transaction group). Its `assemble` keeps
 * the lines whose note isn't "hidden", so a hidden line is a row the decomposition never writes: a
 * stale row, as a custom `decompose` or an older write can leave.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { describe, expect, it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import * as KeyComposer from "@effect-dynamodb/schema/KeyComposer.js"
import { Cause, Effect, Exit, Layer, Schema, SchemaGetter } from "effect"
import * as Aggregate from "../src/Aggregate.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
import * as Table from "../src/Table.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

type Row = Record<string, AttributeValue>

const Line = Schema.Struct({ lid: Schema.String, note: Schema.String })
type Line = typeof Line.Type

const calls = { assemble: 0, decompose: 0 }

const world = (
  options: {
    readonly ownsRows?: boolean
    readonly escapeKeys?: boolean
    /** Two `many` edges of type `Line`, each keeping its own notes: a hidden row is handed to both. */
    readonly twoEdges?: boolean
    /** Another aggregate in the same collection with a `Line` edge, bound alongside. */
    readonly sharer?: boolean
  } = {},
) => {
  const schema = DynamoSchema.make({ name: "ex", version: 1, escapeKeys: options.escapeKeys })
  const Main = Table.make({ schema, entities: {} })
  const edge = (keep: (line: Line) => boolean) =>
    Aggregate.many({
      entityType: "Line",
      sk: { composite: ["lid"] },
      assemble: (lines) => {
        calls.assemble++
        return (lines as ReadonlyArray<Line>).filter(keep)
      },
      decompose: (lines) => {
        calls.decompose++
        return lines as ReadonlyArray<unknown>
      },
    })
  const SubModel = Schema.Struct({
    lines: Schema.Array(Line),
    ...(options.twoEdges === true && { more: Schema.Array(Line) }),
  })
  const Sub = Aggregate.make(SubModel, {
    root: { entityType: "Sub" },
    edges: {
      lines: edge((line) =>
        options.twoEdges === true ? line.note === "a" : line.note !== "hidden",
      ),
      ...(options.twoEdges === true && { more: edge((line) => line.note === "b") }),
    },
  } as any)
  const Orders = Aggregate.make(
    Schema.Struct({ id: Schema.String, note: Schema.String, sub: SubModel }),
    {
      table: Main,
      schema,
      pk: { field: "pk", composite: ["id"] },
      collection: { name: "orders" },
      root: { entityType: "Order" },
      ownsRows: options.ownsRows ?? true,
      edges: { sub: (Sub as any).with({}) },
    } as any,
  )
  const Other = Aggregate.make(Schema.Struct({ id: Schema.String, lines: Schema.Array(Line) }), {
    table: Main,
    schema,
    pk: { field: "pk", composite: ["id"] },
    collection: { name: "orders" },
    root: { entityType: "Other" },
    edges: { lines: Aggregate.many({ entityType: "Line", sk: { composite: ["lid"] } }) },
  } as any)
  const table = makeRecordingTable()
  const run = <A, E>(body: (db: any) => Effect.Effect<A, E, never>) =>
    Effect.gen(function* () {
      const db: any = yield* DynamoClient.make({
        entities: {},
        aggregates: options.sharer === true ? { Orders, Other } : { Orders },
        tables: { Main },
      } as never)
      return yield* body(db)
    }).pipe(
      Effect.provide(Layer.merge(table.layer, Main.layer({ name: "ex" })) as never),
      Effect.exit,
    ) as Effect.Effect<Exit.Exit<A, E>>
  const rows = () =>
    [...table.items.values()].sort((a, b) =>
      `${a.pk?.S}|${a.sk?.S}`.localeCompare(`${b.pk?.S}|${b.sk?.S}`),
    )
  const seed = (items: ReadonlyArray<Row>) => {
    for (const row of items) table.items.set(`${row.pk?.S}|${row.sk?.S}`, structuredClone(row))
  }
  return { table, run, rows, seed }
}

const succeed = (exit: Exit.Exit<unknown, unknown>): any => {
  if (Exit.isFailure(exit)) throw new Error(String(exit.cause))
  return exit.value
}

/** The order `p q` with a visible line `x y` and a hidden line `h`. */
const created = (
  lines: ReadonlyArray<Line> = [
    { lid: "x y", note: "shown" },
    { lid: "h", note: "hidden" },
  ],
) => ({ id: "p q", note: "n", sub: { lines } })

/** The Deletes each transaction sends. */
const deletes = (table: ReturnType<typeof makeRecordingTable>) =>
  table.requests.flatMap((request) =>
    ((request.input.TransactItems ?? []) as ReadonlyArray<any>).flatMap((item) =>
      item.Delete === undefined ? [] : [item.Delete],
    ),
  )

const reads = (table: ReturnType<typeof makeRecordingTable>) =>
  table.requests.filter((request) => ["Query", "GetItem", "Scan"].includes(request.command)).length

/** The order `p q`'s partition key, as the run's default key text composes it (`escapeKeys`). */
const orderPk = (() => {
  const schema = DynamoSchema.make({ name: "ex", version: 1 })
  return DynamoSchema.composeCollectionKey(schema, "orders", [
    KeyComposer.keyValueText(schema, "p q", schema.casing),
  ])
})()
const hiddenKey = { pk: { S: orderPk }, sk: { S: "$ex#v1#line#h" } }
const guard = (type: string) => ({
  ConditionExpression: "attribute_not_exists(#pk) OR #e = :e",
  ExpressionAttributeNames: { "#pk": "pk", "#e": "__edd_e__" },
  ExpressionAttributeValues: { ":e": { S: type } },
})

// ---------------------------------------------------------------------------
// The bind-time check
// ---------------------------------------------------------------------------

describe("DynamoClient.make refuses `ownsRows` when a member can write a row of its types into its partition", () => {
  const schema = DynamoSchema.make({ name: "ex", version: 1 })
  const LineModel = Schema.Struct({ id: Schema.String, lid: Schema.String, note: Schema.String })
  const OrderModel = Schema.Struct({ id: Schema.String, note: Schema.String })
  const entity = (config: Record<string, unknown>) =>
    Entity.make({ model: LineModel, entityType: "Line", ...config } as any)
  /** A primary key composing `id` and `sk`; with `collection`, under the collection's head. */
  const keyed = (collection: string | undefined, sk: ReadonlyArray<string> = ["lid"]) => ({
    primaryKey: {
      ...(collection !== undefined && { collection }),
      pk: { field: "pk", composite: ["id"] },
      sk: { field: "sk", composite: sk },
    },
  })
  /** The index an aggregate assembling off `gsi1` reads its partition from. */
  const byOrder = {
    byOrder: {
      name: "gsi1",
      collection: "orders",
      pk: { field: "gsi1pk", composite: ["id"] },
      sk: { field: "gsi1sk", composite: ["lid"] },
    },
  }
  const orders = (
    Main: Table.Table<any, any>,
    options: { readonly collection?: string; readonly onIndex?: boolean } = {},
  ) =>
    Aggregate.make(
      Schema.Struct({ id: Schema.String, note: Schema.String, lines: Schema.Array(Line) }),
      {
        table: Main,
        schema,
        // `onIndex`: its partition is `gsi1`'s, under the attribute `gsi1pk`.
        pk: { field: options.onIndex === true ? "gsi1pk" : "pk", composite: ["id"] },
        collection: {
          name: options.collection ?? "orders",
          ...(options.onIndex === true && {
            index: "gsi1",
            sk: { field: "gsi1sk", composite: [] },
          }),
        },
        root: { entityType: "Order" },
        ownsRows: true,
        edges: { lines: Aggregate.many({ entityType: "Line", sk: { composite: ["lid"] } }) },
      } as any,
    )
  /** What binding `members` with `Orders` gives: "bound", or the refusal's message. */
  const bind = (
    declared: Record<string, unknown>,
    bound: Record<string, unknown> = {},
    options: {
      readonly collection?: string
      readonly onIndex?: boolean
      readonly aggregates?: (Main: Table.Table<any, any>) => Record<string, unknown>
      readonly tables?: Record<
        string,
        { readonly table: Table.Table<any, any>; readonly name: string }
      >
    } = {},
  ) =>
    Effect.gen(function* () {
      const Main = Table.make({ schema, entities: declared as never })
      const Orders = orders(Main, options)
      const extra = options.tables ?? {}
      const exit = yield* Effect.gen(function* () {
        yield* DynamoClient.make({
          entities: bound,
          aggregates: { Orders, ...options.aggregates?.(Main) },
          tables: {
            Main,
            ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, v.table])),
          },
        } as never)
        return "bound"
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            makeRecordingTable().layer,
            Main.layer({ name: "ex" }),
            ...Object.values(extra).map(({ table, name }) => table.layer({ name })),
          ) as never,
        ),
        Effect.exit,
      ) as unknown as Effect.Effect<Exit.Exit<string, unknown>>
      if (Exit.isSuccess(exit)) return exit.value
      const defect = Cause.squash(exit.cause)
      return defect instanceof Error ? defect.message : String(defect)
    })
  const refused = (member: string, type: string, channel: string) =>
    expect.stringContaining(
      `[EDD-9130] Aggregate "Orders" declares \`ownsRows\`, but "${member}" can write a row of type "${type}" into its partition (${channel})`,
    )

  describe("refused", () => {
    it.effect("an entity of a node's type whose primary key is in the partition", () =>
      Effect.gen(function* () {
        // Its rows are its own, read by the aggregate as lines.
        const Lines = entity(keyed("orders", ["lid", "note"]))
        expect(yield* bind({ Lines })).toEqual(refused("Lines", "Line", "its primary key"))
        // Its partition key under its own type's head, which is the aggregate's collection.
        expect(
          yield* bind({ Lines: entity(keyed(undefined, ["note"])) }, {}, { collection: "line" }),
        ).toEqual(refused("Lines", "Line", "its primary key"))
      }),
    )

    it.effect("entities declaring a node's keys: they compose them with field names", () =>
      Effect.gen(function* () {
        // `$ex#v1#orders#id_o1`, where the aggregate composes `$ex#v1#orders#o1`: the entities'
        // rows are in the partition of an aggregate keyed `id_o1`.
        const Orders = Entity.make({
          model: OrderModel,
          entityType: "Order",
          primaryKey: {
            collection: "orders",
            pk: { field: "pk", composite: ["id"] },
            sk: { field: "sk", composite: [] },
          },
        } as any)
        const Lines = entity(keyed("orders"))
        expect(yield* bind({ Orders, Lines }, { Orders, Lines })).toEqual(
          refused("Orders", "Order", "its primary key"),
        )
        expect(yield* bind({ Lines })).toEqual(refused("Lines", "Line", "its primary key"))
        expect(yield* bind({ Lines: entity({ ...keyed("orders"), softDelete: true }) })).toEqual(
          refused("Lines", "Line", "its primary key"),
        )
        // Under its own type's head, which is the aggregate's collection.
        expect(
          yield* bind({ Lines: entity(keyed(undefined)) }, {}, { collection: "line" }),
        ).toEqual(refused("Lines", "Line", "its primary key"))
      }),
    )

    it.effect("an entity whose secondary index is the partition the aggregate assembles from", () =>
      Effect.gen(function* () {
        const Lines = entity({ ...keyed(undefined), indexes: byOrder })
        expect(yield* bind({ Lines }, {}, { onIndex: true })).toEqual(
          refused("Lines", "Line", 'its index "byOrder"'),
        )
        // The aggregate on the table's own partitions: the index writes another attribute.
        expect(yield* bind({ Lines })).toBe("bound")
      }),
    )

    it.effect(
      "an entity of a node's type, the partition key's attribute not one it writes after its model",
      () =>
        Effect.gen(function* () {
          const Indexed = Entity.make({
            model: LineModel,
            entityType: "Indexed",
            ...keyed(undefined),
            indexes: byOrder,
          } as any)
          const Lines = Entity.make({
            model: Schema.Struct({ id: Schema.String, lid: Schema.String, gsi1pk: Schema.String }),
            entityType: "Line",
            ...keyed(undefined),
          } as any)
          expect(yield* bind({ Indexed, Lines }, {}, { onIndex: true })).toEqual(
            refused("Lines", "Line", "its model attributes"),
          )
          // A model attribute is any name holding any text: the check reads no schema, so a model
          // that doesn't declare `gsi1pk` is refused as one that does is.
          expect(
            yield* bind({ Indexed, Lines: entity(keyed(undefined)) }, {}, { onIndex: true }),
          ).toEqual(refused("Lines", "Line", "its model attributes"))
        }),
    )

    it.effect("another aggregate in the same collection with a node of the same type", () =>
      Effect.gen(function* () {
        const other = (entityType: string) => (Main: Table.Table<any, any>) => ({
          Other: Aggregate.make(Schema.Struct({ id: Schema.String, lines: Schema.Array(Line) }), {
            table: Main,
            schema,
            pk: { field: "pk", composite: ["id"] },
            collection: { name: "orders" },
            root: { entityType: "Other" },
            edges: { lines: Aggregate.many({ entityType, sk: { composite: ["lid"] } }) },
          } as any),
        })
        expect(yield* bind({}, {}, { aggregates: other("Line") })).toEqual(
          refused("Other", "Line", "its partition key"),
        )
        // A type whose rows' keys can be a `Line` row's: one text once cased.
        expect(yield* bind({}, {}, { aggregates: other("LINE") })).toEqual(
          refused("Other", "LINE", "its partition key"),
        )
      }),
    )

    it.effect("a member of another table object on the same physical table", () =>
      Effect.gen(function* () {
        const Lines = entity(keyed("orders", ["note"]))
        const Again = Table.make({ schema, entities: { Lines } })
        // Named as a member of the table the client binds it through.
        expect(yield* bind({}, {}, { tables: { Again: { table: Again, name: "ex" } } })).toEqual(
          refused("Again.Lines", "Line", "its primary key"),
        )
        // On another physical table, it writes another partition.
        expect(
          yield* bind({}, {}, { tables: { Again: { table: Again, name: "elsewhere" } } }),
        ).toBe("bound")
      }),
    )
  })

  describe("not refused", () => {
    it.effect("the aggregate alone", () =>
      Effect.gen(function* () {
        expect(yield* bind({})).toBe("bound")
      }),
    )

    it.effect("an entity of a node's type in its own partitions, or indexed elsewhere", () =>
      Effect.gen(function* () {
        expect(yield* bind({ Lines: entity(keyed(undefined)) })).toBe("bound")
      }),
    )

    it.effect("an entity with a unique constraint, and one an edge reads from", () =>
      Effect.gen(function* () {
        const Products = Entity.make({
          model: Schema.Struct({ id: Schema.String, sku: Schema.String }),
          entityType: "Product",
          primaryKey: {
            pk: { field: "pk", composite: ["id"] },
            sk: { field: "sk", composite: [] },
          },
          unique: { sku: ["sku"] },
        } as any)
        const Lines = entity({ ...keyed(undefined), unique: { lid: ["lid"] } })
        expect(yield* bind({ Products, Lines })).toBe("bound")
      }),
    )

    it.effect("another aggregate in the same collection whose types are its own", () =>
      Effect.gen(function* () {
        const aggregates = (Main: Table.Table<any, any>) => ({
          Other: Aggregate.make(Schema.Struct({ id: Schema.String, lines: Schema.Array(Line) }), {
            table: Main,
            schema,
            pk: { field: "pk", composite: ["id"] },
            collection: { name: "orders" },
            root: { entityType: "Other" },
            edges: {
              lines: Aggregate.many({
                entityType: "OtherLine",
                sk: { composite: ["lid"] },
                decompose: (lines) => lines as ReadonlyArray<unknown>,
              }),
            },
          } as any),
        })
        expect(yield* bind({}, {}, { aggregates })).toBe("bound")
      }),
    )
  })
})

describe("the bind check counts each attribute as its row holds it after the last write", () => {
  /** An aggregate declaring `ownsRows` on `Main`: an `Order` root and a `many` edge of `edgeType`. */
  const owner = (
    Main: Table.Table<any, any>,
    schema: DynamoSchema.DynamoSchema,
    options: {
      readonly pkField?: string
      readonly composite?: ReadonlyArray<string>
      readonly collection: string
      readonly rootType?: string
      readonly edgeType?: string
    },
  ) =>
    Aggregate.make(
      Schema.Struct({ id: Schema.String, note: Schema.String, lines: Schema.Array(Line) }),
      {
        table: Main,
        schema,
        pk: { field: options.pkField ?? "pk", composite: options.composite ?? ["id"] },
        collection: { name: options.collection },
        root: { entityType: options.rootType ?? "Order" },
        ownsRows: true,
        edges: {
          lines: Aggregate.many({
            entityType: options.edgeType ?? "Line",
            sk: { composite: ["lid"] },
          }),
        },
      } as any,
    )
  /** "bound", or the refusal's message. */
  const binds = (config: Record<string, unknown>, layer: Layer.Layer<any, any, any>) =>
    Effect.gen(function* () {
      const exit = yield* DynamoClient.make(config as never).pipe(
        Effect.as("bound"),
        Effect.provide(Layer.merge(makeRecordingTable().layer, layer) as never),
        Effect.exit,
      ) as unknown as Effect.Effect<Exit.Exit<string, unknown>>
      if (Exit.isSuccess(exit)) return exit.value
      const defect = Cause.squash(exit.cause)
      return defect instanceof Error ? defect.message : String(defect)
    })
  const refusal = (member: string, type: string, channel: string) =>
    expect.stringContaining(
      `but "${member}" can write a row of type "${type}" into its partition (${channel})`,
    )

  it.effect("a unique sentinel's back-pointer under the partition key's attribute", () =>
    Effect.gen(function* () {
      // The table's partition attribute is `_entity_pk`: a sentinel's back-pointer replaces its key
      // with the owning row's, which is in the aggregate's partition.
      const schema = DynamoSchema.make({ name: "bp", version: 1 })
      const Accounts = Entity.make({
        model: Schema.Struct({ id: Schema.String, email: Schema.String }),
        entityType: "Account",
        primaryKey: {
          pk: { field: "_entity_pk", composite: ["id"] },
          sk: { field: "sk", composite: [] },
        },
        unique: { email: ["email"] },
      } as any)
      const Main = Table.make({ schema, entities: { Accounts } })
      const Orders = owner(Main, schema, {
        pkField: "_entity_pk",
        collection: "account",
        edgeType: "Account._unique.email",
      })
      expect(
        yield* binds(
          { entities: { Accounts }, aggregates: { Orders }, tables: { Main } },
          Main.layer({ name: "bp" }),
        ),
      ).toEqual(
        refusal(
          "Accounts",
          "Account._unique.email",
          `its unique constraint "email"'s back-pointer "_entity_pk"`,
        ),
      )
    }),
  )

  it.effect("a projection outbox's metadata under the partition key's attribute", () =>
    Effect.gen(function* () {
      // The table's partition attribute is `eventType`: an outbox item's event type replaces it.
      const schema = DynamoSchema.make({ name: "ob", version: 1 })
      class Added extends Schema.TaggedClass<Added>()("Added", {}) {}
      const Events = Table.make({ schema, entities: {} })
      const stream = EventStore.makeStream({
        table: Events,
        streamName: "Events",
        events: [Added],
        streamId: { composite: ["id"] },
      })
      const Tallies = Entity.make({
        model: Schema.Struct({ id: Schema.String, version: Schema.Number, rev: Schema.Number }),
        entityType: "Tally",
        primaryKey: {
          pk: { field: "eventType", composite: ["id"] },
          sk: { field: "sk", composite: [] },
        },
      } as any)
      EventStore.projection({
        stream,
        readModel: Tallies,
        key: (id: { readonly id: string }) => id,
        initial: (id: { readonly id: string }) => ({ ...id, version: 0, rev: 0 }),
        evolve: (state: any) => Effect.succeed(state),
        checkpoint: "version",
        revision: "rev",
        outbox: { schema: Schema.Struct({ message: Schema.String }), effects: () => [] },
      } as any)
      const Main = Table.make({ schema, entities: { Tallies } })
      const Orders = owner(Main, schema, {
        pkField: "eventType",
        collection: "shared",
        edgeType: "Tally#outbox",
      })
      expect(
        yield* binds(
          { entities: { Tallies }, aggregates: { Orders }, tables: { Main } },
          Layer.merge(Main.layer({ name: "ob" }), Events.layer({ name: "events" })),
        ),
      ).toEqual(refusal("Tallies", "Tally#outbox", `its projection outbox's "eventType"`))
    }),
  )

  it.effect("another aggregate's collection sort-key mirror, on its edge rows too", () =>
    Effect.gen(function* () {
      // `Other`'s partition is `gsi1pk`; its collection index's sort key is `pk`, and every row
      // that isn't its root holds a copy of its own `sk` there: `$mr#v1#line#l` for line `l`, the
      // partition of an order `l` in the collection `line`.
      const schema = DynamoSchema.make({ name: "mr", version: 1 })
      const Main = Table.make({ schema, entities: {} })
      const Orders = owner(Main, schema, { collection: "line" })
      const Other = Aggregate.make(
        Schema.Struct({ id: Schema.String, lines: Schema.Array(Line) }),
        {
          table: Main,
          schema,
          pk: { field: "gsi1pk", composite: ["id"] },
          collection: { name: "other", index: "gsi1", sk: { field: "pk", composite: ["id"] } },
          root: { entityType: "OtherRoot" },
          edges: { lines: Aggregate.many({ entityType: "Line", sk: { composite: ["lid"] } }) },
        } as any,
      )
      expect(
        yield* binds(
          { entities: {}, aggregates: { Orders, Other }, tables: { Main } },
          Main.layer({ name: "mr" }),
        ),
      ).toEqual(refusal("Other", "Line", "its collection index's sort key"))
    }),
  )

  const outboxOf = (
    schema: DynamoSchema.DynamoSchema,
    Tallies: unknown,
    outbox: Record<string, unknown>,
  ) => {
    class Added extends Schema.TaggedClass<Added>()("Added", {}) {}
    const Events = Table.make({ schema, entities: {} })
    const stream = EventStore.makeStream({
      table: Events,
      streamName: "Events",
      events: [Added],
      streamId: { composite: ["id"] },
    })
    EventStore.projection({
      stream,
      readModel: Tallies,
      key: (id: { readonly id: string }) => id,
      initial: (id: { readonly id: string }) => ({ ...id, version: 0, rev: 0 }),
      evolve: (state: any) => Effect.succeed(state),
      checkpoint: "version",
      revision: "rev",
      outbox: { schema: Schema.Struct({ message: Schema.String }), effects: () => [], ...outbox },
    } as any)
    return Events
  }
  const tally = () =>
    Entity.make({
      model: Schema.Struct({ id: Schema.String, version: Schema.Number, rev: Schema.Number }),
      entityType: "Tally",
      primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
    } as any)

  it.effect("a projection outbox's index keys, which have no head, are any text", () =>
    Effect.gen(function* () {
      // The outbox index's partition is `Tally#outbox`, under `opk`: the aggregate's partition.
      const schema = DynamoSchema.make({ name: "oi", version: 1 })
      const Tallies = tally()
      const Events = outboxOf(schema, Tallies, { index: { name: "gsi1", pk: "opk", sk: "osk" } })
      const Main = Table.make({ schema, entities: { Tallies } })
      const Orders = Aggregate.make(Schema.Struct({ id: Schema.String, out: Schema.Array(Line) }), {
        table: Main,
        schema,
        pk: { field: "opk", composite: [] },
        collection: { name: "zzz", index: "gsi1", sk: { field: "osk", composite: [] } },
        root: { entityType: "Order" },
        ownsRows: true,
        edges: { out: Aggregate.many({ entityType: "Tally#outbox", sk: { composite: ["lid"] } }) },
      } as any)
      expect(
        yield* binds(
          { entities: {}, aggregates: { Orders }, tables: { Main } },
          Layer.merge(Main.layer({ name: "oi" }), Events.layer({ name: "events" })),
        ),
      ).toEqual(refusal("Tallies", "Tally#outbox", `its projection outbox's "opk"`))
    }),
  )

  it.effect("a projection outbox on the aggregate's table, its entity's table another", () =>
    Effect.gen(function* () {
      const schema = DynamoSchema.make({ name: "ot", version: 1 })
      const Tallies = tally()
      const Target = Table.make({ schema, entities: {} })
      const Events = outboxOf(schema, Tallies, { table: Target, pk: "pk", sk: "sk" })
      const Source = Table.make({ schema, entities: { Tallies } })
      const Orders = owner(Target, schema, { collection: "tally", edgeType: "Tally#outbox" })
      const layer = Layer.mergeAll(
        Source.layer({ name: "source" }),
        Target.layer({ name: "target" }),
        Events.layer({ name: "events" }),
      )
      // The outbox items are on the target table, the aggregate's, whichever table the entity is on.
      expect(
        yield* binds({ entities: {}, aggregates: { Orders }, tables: { Source, Target } }, layer),
      ).toEqual(refusal("Source.Tallies", "Tally#outbox", "its projection outbox"))
      // A client that sees neither the entity nor its table doesn't check it.
      expect(
        yield* binds({ entities: {}, aggregates: { Orders }, tables: { Target } }, layer),
      ).toBe("bound")
    }),
  )

  it.effect("every projection's outbox on a read model: a second one hides none", () =>
    Effect.gen(function* () {
      const schema = DynamoSchema.make({ name: "o2", version: 1 })
      const Tallies = tally()
      const Target = Table.make({ schema, entities: {} })
      const Elsewhere = Table.make({ schema, entities: {} })
      // The first projection's items are on the aggregate's table, the second's on another.
      const First = outboxOf(schema, Tallies, { table: Target, pk: "pk", sk: "sk" })
      const Second = outboxOf(schema, Tallies, { table: Elsewhere, pk: "pk", sk: "sk" })
      const Source = Table.make({ schema, entities: { Tallies } })
      const Orders = owner(Target, schema, { collection: "tally", edgeType: "Tally#outbox" })
      expect(
        yield* binds(
          { entities: {}, aggregates: { Orders }, tables: { Source, Target, Elsewhere } },
          Layer.mergeAll(
            Source.layer({ name: "source" }),
            Target.layer({ name: "target" }),
            Elsewhere.layer({ name: "elsewhere" }),
            First.layer({ name: "events" }),
            Second.layer({ name: "events" }),
          ),
        ),
      ).toEqual(refusal("Source.Tallies", "Tally#outbox", "its projection outbox"))
    }),
  )

  it.effect("every projection's outbox index keys on the row table: a second one hides none", () =>
    Effect.gen(function* () {
      const schema = DynamoSchema.make({ name: "o3", version: 1 })
      const Tallies = tally()
      const First = outboxOf(schema, Tallies, { index: { name: "gsi1", pk: "opk", sk: "osk" } })
      const Second = outboxOf(schema, Tallies, {})
      const Main = Table.make({ schema, entities: { Tallies } })
      const Orders = Aggregate.make(Schema.Struct({ id: Schema.String, out: Schema.Array(Line) }), {
        table: Main,
        schema,
        pk: { field: "opk", composite: [] },
        collection: { name: "zzz", index: "gsi1", sk: { field: "osk", composite: [] } },
        root: { entityType: "Order" },
        ownsRows: true,
        edges: { out: Aggregate.many({ entityType: "Tally#outbox", sk: { composite: ["lid"] } }) },
      } as any)
      expect(
        yield* binds(
          { entities: {}, aggregates: { Orders }, tables: { Main } },
          Layer.mergeAll(
            Main.layer({ name: "o3" }),
            First.layer({ name: "events" }),
            Second.layer({ name: "events" }),
          ),
        ),
      ).toEqual(refusal("Tallies", "Tally#outbox", `its projection outbox's "opk"`))
    }),
  )

  it.effect(
    "a row's own attributes are any name holding any text, whatever its schema declares",
    () =>
      Effect.gen(function* () {
        // `Other`'s `Line` rows are in the owner's partition when a line's `pk` is the owner's
        // partition key. The check reads no schema (DESIGN.md §7 "Which rows in its partition are an
        // aggregate's"): a row's own attributes are any name holding any text but the ones the library
        // writes after them, `Other`'s `gpk`, `sk`, `__edd_e__` and `gsk`. So a value whose struct
        // declares no `pk` is refused as one declaring it is, and as one whose fields can't be read
        // off its schema is.
        const schema = DynamoSchema.make({ name: "op", version: 1 })
        const WithPk = Schema.Struct({
          lid: Schema.String,
          pk: Schema.optional(Schema.String),
          note: Schema.String,
        })
        const Plain = Schema.Struct({ lid: Schema.String, note: Schema.String })
        const Lines = Entity.make({
          model: Schema.Struct({ id: Schema.String, lid: Schema.String, note: Schema.String }),
          entityType: "Line",
          primaryKey: {
            pk: { field: "pk", composite: ["id"] },
            sk: { field: "sk", composite: ["lid"] },
          },
        } as any)
        const outcome = (
          field: Schema.Top,
          edge: (options: Record<string, unknown>) => unknown,
          entity?: unknown,
          pkField = "gpk",
        ) => {
          const Main = Table.make({ schema, entities: {} })
          const Orders = owner(Main, schema, { collection: "shared" })
          const Other = Aggregate.make(Schema.Struct({ id: Schema.String, lines: field }), {
            table: Main,
            schema,
            pk: { field: pkField, composite: ["id"] },
            collection: { name: "other", index: "gsi1", sk: { field: "gsk", composite: ["id"] } },
            root: { entityType: "OtherRoot" },
            edges: { lines: edge({ entityType: "Line", ...(entity !== undefined && { entity }) }) },
          } as any)
          return binds(
            { entities: {}, aggregates: { Orders, Other }, tables: { Main } },
            Main.layer({ name: "op" }),
          )
        }
        const many = (options: Record<string, unknown>) =>
          Aggregate.many({ ...options, sk: { composite: ["lid"] } } as any)
        const one = (options: Record<string, unknown>) => Aggregate.one(options as any)
        const any = refusal("Other", "Line", "its rows' own attributes")
        const Union = Schema.Union([
          WithPk,
          Schema.Struct({ lid: Schema.String, other: Schema.Number }),
        ])
        const elements = [
          WithPk,
          Plain,
          Union,
          Schema.suspend(() => WithPk),
          Schema.Record(Schema.String, Schema.String),
          Schema.Unknown,
        ]
        for (const element of elements) {
          expect(yield* outcome(Schema.Array(element), many)).toEqual(any)
        }
        // With an edge entity, whatever its model declares.
        expect(yield* outcome(Schema.Array(Union), many, Lines)).toEqual(any)
        expect(yield* outcome(Schema.Array(Plain), many, Lines)).toEqual(any)
        // A `one` edge's value.
        for (const value of [WithPk, Plain, Union, Schema.suspend(() => WithPk)]) {
          expect(yield* outcome(value, one)).toEqual(any)
        }
        // Stored under the owner's `pk.field` itself, `Other`'s partition key is written after them,
        // and its text can't be the owner's partition key.
        expect(yield* outcome(Schema.Array(Plain), many, undefined, "pk")).toBe("bound")
        expect(yield* outcome(Schema.Array(WithPk), many, Lines, "pk")).toBe("bound")
      }),
  )

  describe("an owner the client sees only as a table's aggregate is checked as one it binds", () => {
    // `rekey` runs the handler of every aggregate of a table the client binds, so the owners
    // checked are the aggregates it sees, from the same list the writers come from.
    const schema = DynamoSchema.make({ name: "tb", version: 1 })
    class ClassLine extends Schema.Class<ClassLine>("ClassLine")({
      lid: Schema.String,
      note: Schema.String,
    }) {}
    const Sub = Aggregate.make(Schema.Struct({ lines: Schema.Array(Line) }), {
      root: { entityType: "Sub" },
      edges: { lines: Aggregate.many({ entityType: "Line", sk: { composite: ["lid"] } }) },
    } as any)
    const other = (Main: Table.Table<any, any>, shape: "class" | "sub-aggregate") =>
      Aggregate.make(
        shape === "class"
          ? Schema.Struct({ id: Schema.String, lines: Schema.Array(ClassLine) })
          : Schema.Struct({ id: Schema.String, sub: Schema.Struct({ lines: Schema.Array(Line) }) }),
        {
          table: Main,
          schema,
          pk: { field: "gpk", composite: ["id"] },
          collection: { name: "other", index: "gsi1", sk: { field: "gsk", composite: ["id"] } },
          root: { entityType: "OtherRoot" },
          edges:
            shape === "class"
              ? { lines: Aggregate.many({ entityType: "Line", sk: { composite: ["lid"] } }) }
              : { sub: (Sub as any).with({ discriminator: {} }) },
        } as any,
      )
    for (const shape of ["class", "sub-aggregate"] as const) {
      it.effect(`a writer whose lines are in a ${shape}`, () =>
        Effect.gen(function* () {
          const Main = Table.make({ schema, entities: {} })
          const Orders = owner(Main, schema, { collection: "shared" })
          const Registered = Table.make({ schema, aggregates: { Orders } } as any)
          const Other = other(Main, shape)
          const layer = Layer.merge(Main.layer({ name: "tb" }), Registered.layer({ name: "tb" }))
          const refused = refusal("Other", "Line", "its rows' own attributes")
          // Seen only as `Main`'s aggregate, named as a member of the table the client binds.
          const tableOnly = yield* binds(
            { entities: {}, aggregates: { Other }, tables: { Main: Registered } },
            layer,
          )
          expect(tableOnly).toEqual(refused)
          expect(tableOnly).toContain('Aggregate "Main.Orders" declares `ownsRows`')
          // Bound itself, the same refusal.
          const bound = yield* binds(
            { entities: {}, aggregates: { Orders, Other }, tables: { Main: Registered } },
            layer,
          )
          expect(bound).toEqual(refused)
          expect(bound).toContain('Aggregate "Orders" declares `ownsRows`')
        }),
      )
    }
  })

  it.effect(
    "an entity's rows carry its own type: a model field stored under `__edd_e__` doesn't load",
    () =>
      Effect.gen(function* () {
        const schema = DynamoSchema.make({ name: "mk", version: 1 })
        // `Entity.make` refuses a model field named or renamed `__edd_e__` (`EDD-9140`), so the bind
        // check can take an entity's rows to carry its own type.
        expect(() =>
          Entity.make({
            model: DynamoModel.configure(Schema.Struct({ id: Schema.String, tag: Schema.String }), {
              tag: { field: "__edd_e__" },
            }),
            entityType: "Account",
            primaryKey: {
              pk: { field: "pk", composite: ["id"] },
              sk: { field: "sk", composite: [] },
            },
          } as any),
        ).toThrow("[EDD-9140]")
        // Its type alone collides with none of the aggregate's.
        const Plain = Entity.make({
          model: Schema.Struct({ id: Schema.String, tag: Schema.String }),
          entityType: "Account",
          primaryKey: {
            pk: { field: "pk", composite: ["id"] },
            sk: { field: "sk", composite: [] },
          },
        } as any)
        const Again = Table.make({ schema, entities: { Plain } })
        expect(
          yield* binds(
            {
              entities: { Plain },
              aggregates: { Orders: owner(Again, schema, { collection: "account" }) },
              tables: { Again },
            },
            Again.layer({ name: "mk" }),
          ),
        ).toBe("bound")
      }),
  )

  it("a projection defined again with the same outbox adds no entry to its read model", () => {
    const schema = DynamoSchema.make({ name: "od", version: 1 })
    const Tallies = tally()
    const Target = Table.make({ schema, entities: {} })
    const Elsewhere = Table.make({ schema, entities: {} })
    const outboxes = () =>
      (Tallies as unknown as { readonly _projectionOutboxes: ReadonlyArray<unknown> })
        ._projectionOutboxes
    outboxOf(schema, Tallies, { table: Target, pk: "pk", sk: "sk" })
    outboxOf(schema, Tallies, { table: Target, pk: "pk", sk: "sk" })
    expect(outboxes()).toHaveLength(1)
    // Another layout is an entry of its own, and one defined again moves to the end.
    outboxOf(schema, Tallies, { table: Elsewhere, pk: "pk", sk: "sk" })
    outboxOf(schema, Tallies, { table: Target, pk: "pk", sk: "sk" })
    expect(outboxes()).toEqual([
      expect.objectContaining({ table: Elsewhere }),
      expect.objectContaining({ table: Target }),
    ])
    outboxOf(schema, Tallies, { index: { name: "gsi1", pk: "opk", sk: "osk" } })
    outboxOf(schema, Tallies, { index: { name: "gsi1", pk: "opk", sk: "osk" } })
    expect(outboxes()).toHaveLength(3)
  })

  it.effect("a singleton aggregate: a partition key that continues its head can't be it", () =>
    Effect.gen(function* () {
      const schema = DynamoSchema.make({ name: "one", version: 1 })
      const entity = (composite: ReadonlyArray<string>) =>
        Entity.make({
          model: Schema.Struct({ id: Schema.String, lid: Schema.String, note: Schema.String }),
          entityType: "Line",
          // Its sort key isn't the aggregate's line's: its rows are its own.
          primaryKey: {
            pk: { field: "pk", composite },
            sk: { field: "sk", composite: ["lid", "note"] },
          },
        } as any)
      const outcome = (composite: ReadonlyArray<string>) => {
        const Lines = entity(composite)
        const Main = Table.make({ schema, entities: { Lines } })
        const Orders = owner(Main, schema, { composite: [], collection: "line" })
        return binds(
          { entities: { Lines }, aggregates: { Orders }, tables: { Main } },
          Main.layer({ name: "one" }),
        )
      }
      // `$one#v1#line#…` is never `$one#v1#line`.
      expect(yield* outcome(["id"])).toBe("bound")
      // With no composites, it's exactly `$one#v1#line`.
      expect(yield* outcome([])).toEqual(refusal("Lines", "Line", "its primary key"))
    }),
  )

  it.effect("types compared ignoring case only when keys are cased", () =>
    Effect.gen(function* () {
      const outcome = (casing: "lowercase" | "preserve", otherType: string) => {
        const schema = DynamoSchema.make({ name: "cs", version: 1, casing })
        const Main = Table.make({ schema, entities: {} })
        const Orders = owner(Main, schema, { collection: "shared" })
        const Other = Aggregate.make(Schema.Struct({ id: Schema.String, note: Schema.String }), {
          table: Main,
          schema,
          pk: { field: "pk", composite: ["id"] },
          collection: { name: "shared" },
          root: { entityType: otherType },
          edges: {},
        } as any)
        return binds(
          { entities: {}, aggregates: { Orders, Other }, tables: { Main } },
          Main.layer({ name: "cs" }),
        )
      }
      expect(yield* outcome("lowercase", "line")).toEqual(
        refusal("Other", "line", "its partition key"),
      )
      expect(yield* outcome("preserve", "line")).toBe("bound")
      // A type continuing another after `#` collides under every casing, a bind check only.
      expect(yield* outcome("preserve", "Line#Profile")).toEqual(
        refusal("Other", "Line#Profile", "its partition key"),
      )
    }),
  )
})

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

describe("with `ownsRows`, update deletes the rows of a changed node the new state doesn't write", () => {
  /** The requests an update sends, each `TransactWriteItems` by its input. */
  const sentBy = (table: ReturnType<typeof makeRecordingTable>) =>
    table.requests.map((request) =>
      request.command === "TransactWriteItems" ? request.input : request.command,
    )

  it.effect("a hidden line goes after the groups, in its own request, when its node changes", () =>
    Effect.gen(function* () {
      const { table, run, rows } = world()
      succeed(yield* run((db) => db.aggregates.Orders.create(created())))
      expect(rows().map((row) => row.sk?.S)).toContain("$ex#v1#line#h")
      table.requests.length = 0
      succeed(
        yield* run((db) =>
          db.aggregates.Orders.update({ id: "p q" }, ({ state }: any) => ({
            ...state,
            sub: { lines: [...state.sub.lines, { lid: "y", note: "shown" }] },
          })),
        ),
      )
      expect(table.requests.map((request) => request.command)).toEqual([
        "Query",
        "TransactWriteItems",
        "TransactWriteItems",
      ])
      // The group's transaction holds no Delete; the cleanup's holds the hidden line's, guarded.
      expect(table.requests[2]!.input).toEqual({
        TransactItems: [{ Delete: { TableName: "ex", Key: hiddenKey, ...guard("Line") } }],
      })
      expect(deletes(table)).toHaveLength(1)
      expect(rows().map((row) => row.sk?.S)).not.toContain("$ex#v1#line#h")
    }),
  )

  it.effect("its group's transactions are exactly the ones sent without the option", () =>
    Effect.gen(function* () {
      const sent = (ownsRows: boolean) =>
        Effect.gen(function* () {
          const { table, run } = world({ ownsRows })
          succeed(yield* run((db) => db.aggregates.Orders.create(created())))
          table.requests.length = 0
          succeed(
            yield* run((db) =>
              db.aggregates.Orders.update({ id: "p q" }, ({ state }: any) => ({
                ...state,
                note: "m",
                sub: { lines: [] },
              })),
            ),
          )
          return sentBy(table)
        })
      const owned = yield* sent(true)
      const plain = yield* sent(false)
      // The cleanup comes after them, and is the only request added.
      expect(owned.slice(0, plain.length)).toEqual(plain)
      expect(owned.slice(plain.length)).toEqual([
        { TransactItems: [{ Delete: { TableName: "ex", Key: hiddenKey, ...guard("Line") } }] },
      ])
    }),
  )

  it.effect("a node the update leaves alone keeps its rows, and a no-op sends only the read", () =>
    Effect.gen(function* () {
      const { table, run, rows } = world()
      succeed(yield* run((db) => db.aggregates.Orders.create(created())))
      const before = rows()
      table.requests.length = 0
      succeed(
        yield* run((db) =>
          db.aggregates.Orders.update({ id: "p q" }, ({ state }: any) => ({ ...state, note: "m" })),
        ),
      )
      expect(deletes(table)).toEqual([])
      expect(rows().filter((row) => row.__edd_e__?.S === "Line")).toEqual(
        before.filter((row) => row.__edd_e__?.S === "Line"),
      )
      table.requests.length = 0
      succeed(
        yield* run((db) => db.aggregates.Orders.update({ id: "p q" }, ({ state }: any) => state)),
      )
      expect(table.requests.map((request) => request.command)).toEqual(["Query"])
    }),
  )

  it.effect("a row handed to two nodes is left", () =>
    Effect.gen(function* () {
      const { table, run, rows } = world({ twoEdges: true })
      succeed(
        yield* run((db) =>
          db.aggregates.Orders.create({
            id: "p q",
            note: "n",
            sub: {
              lines: [
                { lid: "a1", note: "a" },
                { lid: "h", note: "hidden" },
              ],
              more: [],
            },
          }),
        ),
      )
      table.requests.length = 0
      succeed(
        yield* run((db) =>
          db.aggregates.Orders.update({ id: "p q" }, ({ state }: any) => ({
            ...state,
            sub: { ...state.sub, more: [{ lid: "b1", note: "b" }] },
          })),
        ),
      )
      expect(deletes(table)).toEqual([])
      expect(rows().map((row) => row.sk?.S)).toContain("$ex#v1#line#h")
    }),
  )

  /**
   * Hidden lines `h1` and `h2`; `land` runs before each cleanup request, as another writer's write
   * landing just before it. The mutation counts its calls.
   */
  const raced = (land: (table: ReturnType<typeof makeRecordingTable>, request: number) => void) =>
    Effect.gen(function* () {
      const { table, run, rows } = world()
      succeed(
        yield* run((db) =>
          db.aggregates.Orders.create(
            created([
              { lid: "x y", note: "shown" },
              { lid: "h1", note: "hidden" },
              { lid: "h2", note: "hidden" },
            ]),
          ),
        ),
      )
      let writes = 0
      table.hooks.onRequest = (request) => {
        if (request.command !== "TransactWriteItems") return
        writes++
        if (writes > 1) land(table, writes - 1)
      }
      table.requests.length = 0
      let mutations = 0
      const exit = yield* run((db) =>
        db.aggregates.Orders.update({ id: "p q" }, ({ state }: any) => {
          mutations++
          return { ...state, sub: { lines: [...state.sub.lines, { lid: "y", note: "shown" }] } }
        }),
      )
      table.hooks.onRequest = undefined
      return { exit, table, rows: rows(), mutations }
    })
  const keyOf = (lid: string) => `${hiddenKey.pk.S}|$ex#v1#line#${lid}`
  const cleanupOf = (...lids: ReadonlyArray<string>) => ({
    TransactItems: lids.map((lid) => ({
      Delete: {
        TableName: "ex",
        Key: { pk: hiddenKey.pk, sk: { S: `$ex#v1#line#${lid}` } },
        ...guard("Line"),
      },
    })),
  })

  it.effect("a row another write removed in between is fine", () =>
    Effect.gen(function* () {
      const { exit, table, rows, mutations } = yield* raced((table) => {
        table.items.delete(keyOf("h1"))
      })
      succeed(exit)
      expect(mutations).toBe(1)
      expect(sentBy(table).slice(2)).toEqual([cleanupOf("h1", "h2")])
      expect(rows.map((row) => row.sk?.S)).not.toContain("$ex#v1#line#h2")
    }),
  )

  it.effect("a row replaced with another type is left, and the rest are sent once more", () =>
    Effect.gen(function* () {
      const { exit, table, rows, mutations } = yield* raced((table, request) => {
        const row = table.items.get(keyOf("h1"))!
        if (request === 1) table.items.set(keyOf("h1"), { ...row, __edd_e__: { S: "Note" } })
      })
      succeed(exit)
      expect(mutations).toBe(1)
      expect(table.requests.map((request) => request.command)).toEqual([
        "Query",
        "TransactWriteItems",
        "TransactWriteItems",
        "TransactWriteItems",
      ])
      expect(sentBy(table).slice(2)).toEqual([cleanupOf("h1", "h2"), cleanupOf("h2")])
      expect(rows.find((row) => row.sk?.S === "$ex#v1#line#h1")?.__edd_e__).toEqual({ S: "Note" })
      expect(rows.map((row) => row.sk?.S)).not.toContain("$ex#v1#line#h2")
    }),
  )

  it.effect("a cleanup that fails again is reported, with the update's groups committed", () =>
    Effect.gen(function* () {
      const { exit, table, rows, mutations } = yield* raced((table, request) => {
        const lid = request === 1 ? "h1" : "h2"
        const row = table.items.get(keyOf(lid))!
        table.items.set(keyOf(lid), { ...row, __edd_e__: { S: "Note" } })
      })
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.squash(exit.cause)).toMatchObject({ _tag: "TransactionCancelled" })
      }
      // Never run again, never read again.
      expect(mutations).toBe(1)
      expect(table.requests.map((request) => request.command)).toEqual([
        "Query",
        "TransactWriteItems",
        "TransactWriteItems",
        "TransactWriteItems",
      ])
      expect(rows.map((row) => row.sk?.S)).toContain("$ex#v1#line#y")
    }),
  )

  it.effect("cleanup goes up to 100 Deletes to a request", () =>
    Effect.gen(function* () {
      const { table, run, rows, seed } = world()
      succeed(
        yield* run((db) =>
          db.aggregates.Orders.create(
            created([
              { lid: "x y", note: "shown" },
              { lid: "h000", note: "hidden" },
            ]),
          ),
        ),
      )
      // 150 hidden lines: one create can't write them (a transaction holds at most 100 items), so
      // the rest are copies of the one it wrote.
      const first = rows().find((row) => row.note?.S === "hidden")!
      expect(first.sk?.S?.endsWith("h000")).toBe(true)
      seed(
        Array.from({ length: 149 }, (_, i) => {
          const lid = `h${String(i + 1).padStart(3, "0")}`
          return { ...first, lid: { S: lid }, sk: { S: `${first.sk!.S!.slice(0, -4)}${lid}` } }
        }),
      )
      expect(rows().filter((row) => row.note?.S === "hidden")).toHaveLength(150)
      table.requests.length = 0
      succeed(
        yield* run((db) =>
          db.aggregates.Orders.update({ id: "p q" }, ({ state }: any) => ({
            ...state,
            sub: { lines: [...state.sub.lines, { lid: "y", note: "shown" }] },
          })),
        ),
      )
      expect(
        table.requests
          .filter((request) => request.command === "TransactWriteItems")
          .map((request) => request.input.TransactItems.length),
      ).toEqual([3, 100, 50])
      expect(rows().filter((row) => row.note?.S === "hidden")).toEqual([])
    }),
  )

  it.effect("without `ownsRows`, a hidden line changes nothing the update sends", () =>
    Effect.gen(function* () {
      const sent = (hide: boolean) =>
        Effect.gen(function* () {
          const { table, run } = world({ ownsRows: false })
          succeed(
            yield* run((db) =>
              db.aggregates.Orders.create(
                created(hide ? undefined : [{ lid: "x y", note: "shown" }]),
              ),
            ),
          )
          table.requests.length = 0
          succeed(
            yield* run((db) =>
              db.aggregates.Orders.update({ id: "p q" }, ({ state }: any) => ({
                ...state,
                sub: { lines: [] },
              })),
            ),
          )
          return sentBy(table)
        })
      expect(yield* sent(true)).toEqual(yield* sent(false))
    }),
  )
})

describe("with `ownsRows`, a changed node's rows are what its decomposition writes", () => {
  // A custom `decompose` that writes only the lines marked `emit`, and stores them without the
  // mark: read back, a line has none, so decomposing the value read writes nothing for it.
  const Marked = Schema.Struct({
    lid: Schema.String,
    note: Schema.String,
    emit: Schema.optional(Schema.Boolean),
  })
  const make = () => {
    const schema = DynamoSchema.make({ name: "ret", version: 1 })
    const Main = Table.make({ schema, entities: {} })
    const Orders = Aggregate.make(
      Schema.Struct({ id: Schema.String, note: Schema.String, lines: Schema.Array(Marked) }),
      {
        table: Main,
        schema,
        pk: { field: "pk", composite: ["id"] },
        collection: { name: "orders" },
        root: { entityType: "Order" },
        ownsRows: true,
        edges: {
          lines: Aggregate.many({
            entityType: "Line",
            sk: { composite: ["lid"] },
            decompose: (lines) =>
              (lines as ReadonlyArray<typeof Marked.Type>)
                .filter((line) => line.emit === true)
                .map(({ emit: _, ...line }) => line),
          }),
        },
      } as any,
    )
    const table = makeRecordingTable()
    const run = <A, E>(body: (db: any) => Effect.Effect<A, E, never>) =>
      Effect.gen(function* () {
        const db: any = yield* DynamoClient.make({
          entities: {},
          aggregates: { Orders },
          tables: { Main },
        } as never)
        return yield* body(db)
      }).pipe(
        Effect.provide(Layer.merge(table.layer, Main.layer({ name: "ret" })) as never),
        Effect.exit,
      ) as Effect.Effect<Exit.Exit<A, E>>
    return { table, run }
  }
  const lines = (table: ReturnType<typeof makeRecordingTable>) =>
    [...table.items.values()].filter((row) => row.__edd_e__?.S === "Line").map((row) => row.lid?.S)

  it.effect("an update that changes its group but not the node keeps a line it doesn't write", () =>
    Effect.gen(function* () {
      const { table, run } = make()
      succeed(
        yield* run((db) =>
          db.aggregates.Orders.create({
            id: "p",
            note: "old",
            lines: [{ lid: "k", note: "keep", emit: true }],
          }),
        ),
      )
      table.requests.length = 0
      const returned = succeed(
        yield* run((db) =>
          db.aggregates.Orders.update({ id: "p" }, ({ state }: any) => ({ ...state, note: "new" })),
        ),
      )
      expect(returned.lines).toEqual([{ lid: "k", note: "keep" }])
      expect(deletes(table)).toEqual([])
      expect(lines(table)).toEqual(["k"])
    }),
  )

  it.effect("an update that changes the node loses a line it keeps but doesn't write", () =>
    Effect.gen(function* () {
      const { table, run } = make()
      succeed(
        yield* run((db) =>
          db.aggregates.Orders.create({
            id: "p",
            note: "old",
            lines: [{ lid: "k", note: "keep", emit: true }],
          }),
        ),
      )
      succeed(
        yield* run((db) =>
          db.aggregates.Orders.update({ id: "p" }, ({ state }: any) => ({
            ...state,
            lines: [...state.lines, { lid: "n", note: "new", emit: true }],
          })),
        ),
      )
      // The retention contract: `k` is in the value, unmarked, so the decomposition doesn't write it.
      expect(lines(table)).toEqual(["n"])
    }),
  )
})

describe("with `ownsRows`, which nodes changed is the base's own decision", () => {
  /** Run `body` against `rows` under a client binding `aggregate`, recording what it sends. */
  const bound = (aggregate: unknown, Main: Table.Table<any, any>, name: string) => {
    const table = makeRecordingTable()
    const run = <A, E>(body: (db: any) => Effect.Effect<A, E, never>) =>
      Effect.gen(function* () {
        const db: any = yield* DynamoClient.make({
          entities: {},
          aggregates: { Agg: aggregate },
          tables: { Main },
        } as never)
        return yield* body(db)
      }).pipe(
        Effect.provide(Layer.merge(table.layer, Main.layer({ name })) as never),
        Effect.exit,
      ) as Effect.Effect<Exit.Exit<A, E>>
    return { table, run }
  }

  it.effect(
    "items compared by type and attributes, not keys: a lossy codec's update writes nothing",
    () =>
      Effect.gen(function* () {
        // Every number is stored as 0; 1.39.0 keyed the line by the value written (`…0050`).
        const Lossy = Schema.Number.pipe(
          Schema.decodeTo(Schema.Number, {
            decode: SchemaGetter.transform((n: number) => n),
            encode: SchemaGetter.transform(() => 0),
          }),
        )
        const sent = (ownsRows: boolean) =>
          Effect.gen(function* () {
            const schema = DynamoSchema.make({ name: "lz", version: 1 })
            const Main = Table.make({ schema, entities: {} })
            const Agg = Aggregate.make(
              Schema.Struct({
                id: Schema.String,
                lines: Schema.Array(Schema.Struct({ f: Lossy, note: Schema.String })),
              }),
              {
                table: Main,
                schema,
                pk: { field: "pk", composite: ["id"] },
                collection: { name: "shared" },
                root: { entityType: "Root" },
                ownsRows,
                edges: { lines: Aggregate.many({ entityType: "Line", sk: { composite: ["f"] } }) },
              } as any,
            )
            const { table, run } = bound(Agg, Main, "lz")
            succeed(yield* run((db) => db.aggregates.Agg.create({ id: "p", lines: [] })))
            const line: Row = {
              pk: { S: "$lz#v1#shared#p" },
              sk: { S: "$lz#v1#line#0000000000000050" },
              __edd_e__: { S: "Line" },
              f: { N: "0" },
              note: { S: "row" },
            }
            table.items.set(`${line.pk!.S}|${line.sk!.S}`, line)
            const before = structuredClone([...table.items.values()])
            table.requests.length = 0
            succeed(
              yield* run((db) =>
                db.aggregates.Agg.update({ id: "p" }, ({ state }: any) => ({
                  ...state,
                  lines: [{ f: 60, note: "row" }],
                })),
              ),
            )
            // Stored `f` is 0 before and after: the items compare equal, and the update is a no-op.
            expect(table.requests.map((request) => request.command)).toEqual(["Query"])
            expect([...table.items.values()]).toEqual(before)
            return table.requests
          })
        expect(yield* sent(true)).toEqual(yield* sent(false))
      }),
  )

  for (const shape of ["array", "record", "sub-aggregate"] as const) {
    it.effect(
      `a row handed to two nodes is left, its node's change notwithstanding: ${shape}`,
      () =>
        Effect.gen(function* () {
          // Two edges of type `Line`, one per side, with the same sort key composites: every `Line`
          // row is handed to both. A `decompose` that divides `f` once more leaves its row where the
          // value read keys nothing.
          const X10 = Schema.Number.pipe(
            Schema.decodeTo(Schema.Number, {
              decode: SchemaGetter.transform((n: number) => n * 10),
              encode: SchemaGetter.transform((n: number) => n / 10),
            }),
          )
          const Side = Schema.Struct({ f: X10, side: Schema.String })
          const keyed = shape === "record"
          const EdgeModel = keyed ? Schema.Record(Schema.String, Side) : Schema.Array(Side)
          const many = (side: string) =>
            Aggregate.many({
              entityType: "Line",
              sk: { composite: ["f", "side"] },
              assemble: (rows) => {
                const own = (rows as ReadonlyArray<typeof Side.Type>).filter((r) => r.side === side)
                return keyed ? Object.fromEntries(own.map((r) => [r.side, r])) : own
              },
              decompose: (value) =>
                (Array.isArray(value) ? value : Object.values(value as object)).map((r: any) => ({
                  ...r,
                  f: r.f / 100,
                })),
            })
          const Part = Schema.Struct({ left: EdgeModel, right: EdgeModel })
          const empty = keyed ? {} : []
          const left = keyed ? { left: { f: 50, side: "left" } } : [{ f: 50, side: "left" }]
          const sent = (ownsRows: boolean) =>
            Effect.gen(function* () {
              const schema = DynamoSchema.make({ name: "two", version: 1 })
              const Main = Table.make({ schema, entities: {} })
              const edges = { left: many("left"), right: many("right") }
              const Sub = Aggregate.make(Part, { root: { entityType: "Sub" }, edges } as any)
              const nested = shape === "sub-aggregate"
              const Agg = Aggregate.make(
                Schema.Struct({ id: Schema.String, ...(nested ? { sub: Part } : Part.fields) }),
                {
                  table: Main,
                  schema,
                  pk: { field: "pk", composite: ["id"] },
                  collection: { name: "shared" },
                  root: { entityType: "Root" },
                  ownsRows,
                  edges: nested
                    ? { sub: (Sub as any).with({ discriminator: { zone: "one" } }) }
                    : edges,
                } as any,
              )
              const { table, run } = bound(Agg, Main, "two")
              const value = { left, right: empty }
              succeed(
                yield* run((db) =>
                  db.aggregates.Agg.create({ id: "p", ...(nested ? { sub: value } : value) }),
                ),
              )
              const row = [...table.items.values()].find((item) => item.__edd_e__?.S === "Line")!
              const before = succeed(yield* run((db) => db.aggregates.Agg.get({ id: "p" })))
              table.requests.length = 0
              succeed(
                yield* run((db) =>
                  db.aggregates.Agg.update({ id: "p" }, ({ state }: any) =>
                    nested
                      ? { ...state, sub: { ...state.sub, left: empty } }
                      : { ...state, left: empty },
                  ),
                ),
              )
              // The `left` node changed, but its row is handed to `right` too: it's left, and `get`
              // still returns it.
              expect([...table.items.values()]).toContainEqual(row)
              const after = succeed(yield* run((db) => db.aggregates.Agg.get({ id: "p" })))
              expect(nested ? after.sub.left : after.left).toEqual(
                nested ? before.sub.left : before.left,
              )
              return table.requests.slice(0, -1)
            })
          expect(yield* sent(true)).toEqual(yield* sent(false))
        }),
    )
  }
})

// ---------------------------------------------------------------------------
// rekey
// ---------------------------------------------------------------------------

describe("with `ownsRows`, rekey moves what it moves without the option", () => {
  /** Rows written under the old key text, rekeyed under escaped keys (`p q` becomes `p%20q`). */
  const rekeyed = (options: {
    readonly lines?: ReadonlyArray<Line>
    readonly extra?: ReadonlyArray<Row>
    readonly id?: string
    readonly twoEdges?: boolean
    readonly ownsRows?: boolean
  }) =>
    Effect.gen(function* () {
      const writer = world({ ...options, escapeKeys: false })
      const id = options.id ?? "p q"
      const lines = options.lines ?? [
        { lid: "x y", note: "shown" },
        { lid: "h k", note: "hidden" },
      ]
      succeed(
        yield* writer.run((db) =>
          db.aggregates.Orders.create({
            id,
            note: "n",
            sub: { lines, ...(options.twoEdges === true && { more: [] }) },
          }),
        ),
      )
      const before = [...writer.rows(), ...(options.extra ?? [])].sort((a, b) =>
        `${a.pk?.S}|${a.sk?.S}`.localeCompare(`${b.pk?.S}|${b.sk?.S}`),
      )
      const outcomes = []
      for (const dryRun of [true, false]) {
        const mover = world({ ...options, escapeKeys: true })
        mover.seed(before)
        mover.table.requests.length = 0
        const report = succeed(yield* mover.run((db) => db.tables.Main.rekey({ dryRun })))
        outcomes.push({ report, rows: mover.rows(), mover, requests: [...mover.table.requests] })
      }
      const [dry, real] = outcomes
      // A dry run reports what the run does, and writes nothing.
      const told = ({
        scanned,
        unchanged,
        moved,
        indexKeysRewritten,
        conflicts,
        skipped,
      }: any) => ({
        scanned,
        unchanged,
        moved,
        indexKeysRewritten,
        conflicts,
        skipped,
      })
      expect(told(dry!.report)).toEqual(told(real!.report))
      expect(dry!.rows).toEqual(before)
      return {
        before,
        report: real!.report,
        rows: real!.rows,
        mover: real!.mover,
        requests: real!.requests,
      }
    })
  const at = (rows: ReadonlyArray<Row>, sk: string) => rows.filter((row) => row.sk?.S === sk)

  const hidden = { pk: "$ex#v1#orders#p q", sk: "$ex#v1#line#h k" }
  const stray: Row = {
    pk: { S: "$ex#v1#orders#p q" },
    sk: { S: "$ex#v1#line#zzz" },
    __edd_e__: { S: "Line" },
    lid: { S: "x y" },
    note: { S: "hidden" },
  }
  /** What `rekey` sends: its writes, as the run without `ownsRows` sends them. */
  const writes = (requests: ReadonlyArray<{ readonly command: string; readonly input: any }>) =>
    requests.filter((request) => !["Query", "GetItem", "Scan"].includes(request.command))

  it.effect("a hidden line, when the aggregate moves: failed, and nothing moves", () =>
    Effect.gen(function* () {
      // Where it goes can't be told from what's stored: it isn't a row the value decomposes to.
      const { before, report, rows, requests } = yield* rekeyed({})
      expect(report.moved.aggregate).toBe(0)
      expect(report.conflicts).toEqual([
        expect.objectContaining({ member: "Order", reason: "failed", key: hidden }),
      ])
      expect(rows).toEqual(before)
      expect(writes(requests)).toEqual([])
    }),
  )

  it.effect("without `ownsRows`, the hidden line stays where it is, as on 1.39.0", () =>
    Effect.gen(function* () {
      const { before, report, rows } = yield* rekeyed({ ownsRows: false })
      expect(report.conflicts).toEqual([])
      expect(report.moved.aggregate).toBe(3)
      expect(at(rows, "$ex#v1#line#h k")).toEqual(at(before, "$ex#v1#line#h k"))
    }),
  )

  it.effect("every row its value doesn't key is named, a row handed to two nodes too", () =>
    Effect.gen(function* () {
      const strayed = yield* rekeyed({ extra: [stray] })
      expect(strayed.report.moved.aggregate).toBe(0)
      expect(strayed.report.conflicts.map((conflict: any) => conflict.key)).toEqual([
        hidden,
        { pk: "$ex#v1#orders#p q", sk: "$ex#v1#line#zzz" },
      ])
      expect(strayed.rows).toEqual(strayed.before)
      // Each edge keeps its own notes, so the hidden line is handed to both.
      const shared = yield* rekeyed({
        twoEdges: true,
        lines: [
          { lid: "a1", note: "a" },
          { lid: "h k", note: "hidden" },
        ],
      })
      expect(shared.report.moved.aggregate).toBe(0)
      expect(shared.report.conflicts).toEqual([
        expect.objectContaining({ reason: "failed", key: hidden }),
      ])
      expect(shared.rows).toEqual(shared.before)
    }),
  )

  it.effect("when its partition key stays: left, counted unrecognized, the rest moved", () =>
    Effect.gen(function* () {
      // `pq` keeps its partition key, and the line `x y` moves to `x%20y`.
      const options = {
        id: "pq",
        lines: [
          { lid: "x y", note: "shown" },
          { lid: "h", note: "hidden" },
        ],
        extra: [{ ...stray, pk: { S: "$ex#v1#orders#pq" } }],
      }
      const owned = yield* rekeyed(options)
      expect(owned.report.conflicts).toEqual([])
      expect(owned.report.moved.aggregate).toBe(1)
      expect(owned.report.skipped.unrecognizedKey).toBe(2)
      expect(at(owned.rows, "$ex#v1#line#zzz")).toHaveLength(1)
      expect(at(owned.rows, "$ex#v1#line#h")).toHaveLength(1)
      // The requests are the ones it sends without the option, and so are the rows.
      const plain = yield* rekeyed({ ...options, ownsRows: false })
      expect(owned.requests).toEqual(plain.requests)
      expect(owned.rows).toEqual(plain.rows)
      expect(plain.report.skipped.unrecognizedKey).toBe(0)
    }),
  )

  it.effect("with nothing it doesn't key, the requests are the ones sent without the option", () =>
    Effect.gen(function* () {
      const lines = [{ lid: "x y", note: "shown" }]
      const owned = yield* rekeyed({ lines })
      const plain = yield* rekeyed({ lines, ownsRows: false })
      expect(owned.report.moved.aggregate).toBe(3)
      expect(owned.requests).toEqual(plain.requests)
      expect(owned.rows).toEqual(plain.rows)
    }),
  )
})

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

describe("deciding which rows are the aggregate's reads and decomposes nothing more", () => {
  it.effect("update and rekey: the same reads, assemblies and decompositions either way", () =>
    Effect.gen(function* () {
      const count = (ownsRows: boolean, hide: boolean) =>
        Effect.gen(function* () {
          const writer = world({ ownsRows })
          succeed(
            yield* writer.run((db) =>
              db.aggregates.Orders.create(
                created(hide ? undefined : [{ lid: "x y", note: "shown" }]),
              ),
            ),
          )
          calls.assemble = 0
          calls.decompose = 0
          writer.table.requests.length = 0
          succeed(
            yield* writer.run((db) =>
              db.aggregates.Orders.update({ id: "p q" }, ({ state }: any) => ({
                ...state,
                sub: { lines: [] },
              })),
            ),
          )
          const update = {
            ...calls,
            reads: reads(writer.table),
            requests: writer.table.requests.length,
          }
          // Rekeyed from the rows written before the update.
          const mover = world({ ownsRows, escapeKeys: true })
          const before = world({ ownsRows, escapeKeys: false })
          succeed(
            yield* before.run((db) =>
              db.aggregates.Orders.create(
                created(hide ? undefined : [{ lid: "x y", note: "shown" }]),
              ),
            ),
          )
          mover.seed(before.rows())
          calls.assemble = 0
          calls.decompose = 0
          mover.table.requests.length = 0
          succeed(yield* mover.run((db) => db.tables.Main.rekey()))
          return { update, rekey: { ...calls, reads: reads(mover.table) } }
        })
      const owned = yield* count(true, true)
      // A hidden row, which the update deletes and `rekey` reports, costs neither a read nor a call:
      // only the cleanup's own request.
      const plain = yield* count(true, false)
      expect({
        ...owned,
        update: { ...owned.update, requests: owned.update.requests - 1 },
      }).toEqual(plain)
      // The update reads the partition, assembles the old state, decomposes it and the new state,
      // and reads the value written once more for its stamps (as 1.39.0 did), then writes its
      // group and its cleanup, and assembles the rows read and written as a `get` right after
      // reads them, its result (#241, no request); `rekey` reads what it reads without one (the
      // scan, the old and new partitions, the roots it checks), and assembles and decomposes the
      // aggregate once.
      expect(owned).toEqual({
        update: { assemble: 2, decompose: 3, reads: 1, requests: 3 },
        rekey: { assemble: 1, decompose: 1, reads: 5 },
      })
      // Without `ownsRows`, the same but the cleanup.
      expect(yield* count(false, true)).toEqual(plain)
    }),
  )
})
