/**
 * Writes landing between `rekey`'s read of a row and its move that the move's guard once missed,
 * and now sees through a condition on the write it already sends (#240):
 * - `reembed` on a versioned item with a vector index: it sets the vector attributes alone, so the
 *   version didn't prove them unchanged. The guard holds them as read.
 * - a write adding a field of an aggregate node whose value exposes no `.fields` (a union's members,
 *   an annotated class): the guard holds each attribute the node can store still absent, walked from
 *   its schema.
 *
 * And one it can't see, reported in `guardGaps` instead: a write that only adds an entry to a sparse
 * map adds an attribute no declaration names, so a row guarded whole is moved without it.
 *
 * Each runs on a recording table (`RekeyMoveRaces.test.ts`) and on DynamoDB Local
 * (`connected.rekey-move-races.test.ts`). The rows are written with `escapeKeys` off and rekeyed
 * with it on.
 */
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Embedder } from "@effect-dynamodb/schema/Embedder.js"
import { Effect, Layer, Schema } from "effect"
import { expect } from "vitest"
import * as Aggregate from "../../src/Aggregate.js"
import { DynamoClient } from "../../src/DynamoClient.js"
import * as Entity from "../../src/Entity.js"
import * as Table from "../../src/Table.js"
import { makeRecordingTable } from "./RecordingTable.js"
import type { Harness } from "./RekeyRepair.js"

type Row = Record<string, any>

const NO_GAPS = { stamp: 0, sparse: 0, strongest: 0 }

export interface UnseenWriteScenario {
  readonly name: string
  readonly run: (harness: Harness) => Effect.Effect<void, unknown>
}

/** The rows `world(false)` writes with `write`, read off a recording table. */
const rowsWritten = <W extends { readonly MainTable: any }>(
  world: W,
  write: Effect.Effect<void, unknown, any>,
  more: Layer.Layer<never> = Layer.empty,
) =>
  Effect.gen(function* () {
    const table = makeRecordingTable()
    yield* write.pipe(
      Effect.provide(Layer.mergeAll(table.layer, world.MainTable.layer({ name: "t" }), more)),
    )
    return [...table.items.values()] as ReadonlyArray<Row>
  })

// ---------------------------------------------------------------------------
// reembed on a versioned item
// ---------------------------------------------------------------------------

const DIMENSIONS = 4
const STALE = [0, 0, 0, 1]
const FRESH = [1, 0, 0, 0]
const FreshEmbedder = Layer.succeed(Embedder, {
  dimensions: DIMENSIONS,
  embed: () => Effect.succeed(FRESH),
})

const docsWorld = (escapeKeys: boolean) => {
  const schema = DynamoSchema.make({ name: "unseen", version: 1, escapeKeys })
  const Docs = Entity.make({
    model: Schema.Struct({ id: Schema.String, text: Schema.String }),
    entityType: "Doc",
    primaryKey: {
      pk: { field: "pk", composite: ["id"] },
      sk: { field: "sk", composite: [] },
    },
    versioned: true,
    vectorIndexes: {
      byText: {
        name: "vec1",
        dimensions: DIMENSIONS,
        distance: "cosine",
        source: { fields: ["text"] },
      },
    },
  })
  const MainTable = Table.make({ schema, entities: { Docs } })
  return { MainTable, client: DynamoClient.make({ entities: { Docs }, tables: { MainTable } }) }
}

const vectorOf = (row: Row): ReadonlyArray<number> =>
  (row.__edd_v_vec1__?.L ?? []).map((n: Row) => Number(n.N))

export const reembedScenarios: ReadonlyArray<UnseenWriteScenario> = [
  {
    name: "reembed of a versioned item between the read and the move: kept",
    run: (harness) => {
      const off = docsWorld(false)
      const on = docsWorld(true)
      return harness.on(on, (table) =>
        Effect.gen(function* () {
          const seed = yield* rowsWritten(
            off,
            Effect.gen(function* () {
              const db = yield* off.client
              yield* db.entities.Docs.put({ id: "a b", text: "hello" }).withVector("byText", STALE)
            }),
          )
          expect(seed).toHaveLength(1)
          expect(vectorOf(seed[0]!)).toEqual(STALE)
          for (const row of seed) yield* table.seed(row)
          const db = yield* on.client
          const reembedding = yield* on.client.pipe(Effect.provide(FreshEmbedder))
          let landed = 0
          table.beforeTransact(() =>
            landed++ === 0
              ? Effect.asVoid(reembedding.entities.Docs.reembed({ concurrency: 1 }))
              : Effect.void,
          )
          const report = yield* db.tables.MainTable.rekey()
          expect(landed).toBeGreaterThan(1)
          expect(report.conflicts).toEqual([])
          expect(report.moved.item).toBe(1)
          expect(report.guardGaps).toEqual(NO_GAPS)
          const rows = yield* table.rows()
          expect(rows).toHaveLength(1)
          expect(rows[0]!.pk.S).toContain("a%20b")
          // The guard saw the vector change, cancelled the move, and the row moved with it.
          expect(vectorOf(rows[0]!)).toEqual(FRESH)
        }),
      )
    },
  },
]

// ---------------------------------------------------------------------------
// A field of an aggregate node with no `.fields`
// ---------------------------------------------------------------------------

const Plain = Schema.Struct({
  name: Schema.String,
  v: Schema.String,
  note: Schema.optionalKey(Schema.String),
})
const Other = Schema.Struct({ name: Schema.String, w: Schema.Number })
class Annotated extends Schema.Class<Annotated>("Annotated")({
  name: Schema.String,
  v: Schema.String,
  note: Schema.optionalKey(Schema.String),
}) {}

class Configured extends Schema.Class<Configured>("Configured")({
  name: Schema.String,
  v: Schema.String,
  note: Schema.optionalKey(Schema.String),
}) {}

/**
 * Each line's element schema, and the model of the entity its edge names, if any. The last is the
 * shape #240 left untested: an edge entity whose model is a `DynamoModel.configure` wrapper. Its
 * element exposes `.fields`, so it was guarded before too, and stays so.
 */
const ELEMENTS: Readonly<
  Record<string, { readonly element: Schema.Top; readonly model?: unknown }>
> = {
  "a union's member": { element: Schema.Union([Plain, Other]) },
  "an annotated class": { element: Annotated.annotate({ title: "Line" }) },
  "an edge entity whose model is a configure wrapper": {
    element: Configured,
    model: DynamoModel.configure(Configured, { v: { immutable: true } }),
  },
}

const ordersWorld = (escapeKeys: boolean, element: Schema.Top, model?: unknown) => {
  const schema = DynamoSchema.make({ name: "unseen", version: 1, escapeKeys })
  const MainTable = Table.make({ schema, entities: {} } as never) as any
  const entity =
    model === undefined
      ? undefined
      : Entity.make({
          model,
          entityType: "LineEntity",
          primaryKey: {
            pk: { field: "pk", composite: ["name"] },
            sk: { field: "sk", composite: [] },
          },
        } as never)
  const Order = (Aggregate.make as any)(
    Schema.Struct({ id: Schema.String, lines: Schema.Array(element) }),
    {
      schema,
      table: MainTable,
      pk: { field: "pk", composite: ["id"] },
      collection: { name: "orders" },
      root: { entityType: "Order" },
      edges: {
        lines: Aggregate.many({
          entityType: "Line",
          sk: { composite: ["name"] },
          ...(entity !== undefined && { entity }),
        } as never),
      },
    },
  )
  return {
    MainTable,
    client: DynamoClient.make({
      entities: {},
      aggregates: { Order },
      tables: { MainTable },
    } as never) as Effect.Effect<any>,
  }
}

export const nodeNameScenarios: ReadonlyArray<UnseenWriteScenario> = Object.entries(ELEMENTS).map(
  ([label, { element, model }]) => ({
    name: `a write adding a field of ${label} between the read and the move: kept`,
    run: (harness: Harness) => {
      const off = ordersWorld(false, element, model)
      const on = ordersWorld(true, element, model)
      return harness.on(on, (table) =>
        Effect.gen(function* () {
          const line =
            label === "an annotated class"
              ? new Annotated({ name: "l1", v: "x" })
              : model !== undefined
                ? new Configured({ name: "l1", v: "x" })
                : { name: "l1", v: "x" }
          const seed = yield* rowsWritten(
            off,
            Effect.gen(function* () {
              const db = yield* off.client
              yield* db.aggregates.Order.create({ id: "a b", lines: [line] })
            }),
          )
          for (const row of seed) yield* table.seed(row)
          const lineRow = seed.find((row) => row.__edd_e__?.S === "Line")!
          expect(lineRow.note).toBeUndefined()
          const db = yield* on.client
          let landed = 0
          table.beforeTransact(() =>
            landed++ === 0 ? table.seed({ ...lineRow, note: { S: "added" } }) : Effect.void,
          )
          const report = yield* db.tables.MainTable.rekey()
          expect(landed).toBeGreaterThan(1)
          expect(report.conflicts).toEqual([])
          expect(report.guardGaps).toEqual(NO_GAPS)
          const rows = yield* table.rows()
          const moved = rows.filter((row) => row.__edd_e__?.S === "Line")
          expect(moved).toHaveLength(1)
          expect(moved[0]!.pk.S).toContain("a%20b")
          // The guard held `note` absent, saw it added, and the row moved with it.
          expect(moved[0]!.note?.S).toBe("added")
        }),
      )
    },
  }),
)

// ---------------------------------------------------------------------------
// A sparse map entry added: not seen, reported
// ---------------------------------------------------------------------------

const tagsWorld = (escapeKeys: boolean) => {
  const schema = DynamoSchema.make({ name: "unseen", version: 1, escapeKeys })
  const Tagged = Entity.make({
    model: DynamoModel.configure(
      Schema.Struct({ id: Schema.String, tags: Schema.Record(Schema.String, Schema.String) }),
      { tags: { storedAs: DynamoModel.SparseMap() } },
    ),
    entityType: "Tagged",
    primaryKey: {
      pk: { field: "pk", composite: ["id"] },
      sk: { field: "sk", composite: [] },
    },
  })
  const MainTable = Table.make({ schema, entities: { Tagged } })
  return { MainTable, client: DynamoClient.make({ entities: { Tagged }, tables: { MainTable } }) }
}

export const sparseScenarios: ReadonlyArray<UnseenWriteScenario> = [false, true].map(
  (writesStopped) => ({
    name: writesStopped
      ? "an item with a sparse map, writes stopped: moved, nothing reported"
      : "a sparse map entry added between the read and the move: lost, reported in guardGaps",
    run: (harness: Harness) => {
      const off = tagsWorld(false)
      const on = tagsWorld(true)
      return harness.on(on, (table) =>
        Effect.gen(function* () {
          const written = yield* rowsWritten(
            off,
            Effect.gen(function* () {
              const db = yield* off.client
              yield* db.entities.Tagged.put({ id: "a b", tags: { a: "1" } })
            }),
          )
          const raced = yield* rowsWritten(
            off,
            Effect.gen(function* () {
              const db = yield* off.client
              yield* db.entities.Tagged.put({ id: "a b", tags: { a: "1" } })
              yield* db.entities.Tagged.update({ id: "a b" }).set({ tags: { b: "2" } })
            }),
          )
          expect(raced[0]!["tags#b"]).toEqual({ S: "2" })
          for (const row of written) yield* table.seed(row)
          const db = yield* on.client
          const dry = yield* db.tables.MainTable.rekey({ writesStopped, dryRun: true })
          expect(dry.guardGaps).toEqual({ ...NO_GAPS, sparse: writesStopped ? 0 : 1 })
          let landed = 0
          if (!writesStopped) {
            table.beforeTransact(() => (landed++ === 0 ? table.seed(raced[0]!) : Effect.void))
          }
          const report = yield* db.tables.MainTable.rekey({ writesStopped })
          expect(report.conflicts).toEqual([])
          expect(report.moved.item).toBe(1)
          expect(report.guardGaps).toEqual({ ...NO_GAPS, sparse: writesStopped ? 0 : 1 })
          expect(report.byMember.Tagged!.guardGaps).toEqual(report.guardGaps)
          const rows = yield* table.rows()
          expect(rows).toHaveLength(1)
          expect(rows[0]!.pk.S).toContain("a%20b")
          expect(rows[0]!["tags#a"]).toEqual({ S: "1" })
          if (!writesStopped) {
            // The entry the write added names an attribute no declaration does: the guard can't
            // hold it absent, so the move went ahead and put the row back without it.
            expect(landed).toBe(1)
            expect(rows[0]!["tags#b"]).toBeUndefined()
          }
        }),
      )
    },
  }),
)
