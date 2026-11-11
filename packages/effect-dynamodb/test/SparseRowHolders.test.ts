/**
 * Three places that hold a caller's object or a stored row, each as 1.39.0 handled it:
 *
 * - an aggregate write takes a field the payload's class gives it (a getter, a prototype's
 *   property) as present, and only a member every object inherits as absent;
 * - an update that sets a ref's id together with a path op is sent as an expression, so a
 *   sparse entry key only a whole-item write refuses is not refused before the ref is read;
 * - a row's sparse map reaches a vector index's source text as a plain object.
 */

import { describe, expect, it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Embedder } from "@effect-dynamodb/schema/Embedder.js"
import { Effect, Layer, Schema } from "effect"
import * as Aggregate from "../src/Aggregate.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

const schema = DynamoSchema.make({ name: "holders", version: 1 })

/** The fixtures here are built untyped (`any`), so their effects are too. */
const typed = (effect: Effect.Effect<void, unknown, unknown>) => effect as Effect.Effect<void>

describe("an aggregate write holds a field the payload's class gives it", () => {
  const Lines = Schema.Array(Schema.Struct({ id: Schema.String, n: Schema.Number }))
  const Order = Schema.Struct({
    id: Schema.String,
    lines: Lines.pipe(Schema.withDecodingDefault(Effect.succeed([{ id: "default", n: 5 }]))),
  })
  const table = Table.make({ schema, entities: {} })
  const Orders = (Aggregate.make as any)(Order, {
    table,
    schema,
    pk: { field: "pk", composite: ["id"] },
    collection: { name: "orders" },
    root: { entityType: "Order" },
    edges: {
      lines: Aggregate.many({
        entityType: "Line",
        sk: { composite: ["id"] },
        decompose: (lines: ReadonlyArray<Record<string, unknown>>) =>
          lines.map((line) => ({ ...line })),
      } as any),
    },
  })

  class OrderWithGetter {
    id = "a"
    readonly #lines = [{ id: "line", n: 50 }]
    get lines() {
      return this.#lines
    }
  }
  const payloads = {
    "an own property": () => ({ id: "a", lines: [{ id: "line", n: 50 }] }),
    "a class getter": () => new OrderWithGetter(),
    "a prototype's property": () =>
      Object.assign(Object.create({ lines: [{ id: "line", n: 50 }] }), { id: "a" }),
  }

  for (const [label, payload] of Object.entries(payloads)) {
    it.effect(`create with lines as ${label}: the caller's line is stored`, () =>
      typed(
        Effect.gen(function* () {
          const rows = makeRecordingTable()
          yield* Orders.create(payload()).pipe(
            Effect.provide(Layer.merge(rows.layer, table.layer({ name: "t" }))),
          )
          const lines = [...rows.items.entries()]
            .filter(([key]) => key.includes("#line"))
            .map(([, row]) => `${row.id?.S}=${row.n?.N}`)
          expect(lines).toEqual(["line=50"])
        }),
      ),
    )
  }
})

describe("an update setting a ref's id with a path op", () => {
  class Project extends Schema.Class<Project>("Project")({
    projectId: Schema.String,
    name: Schema.String,
  }) {}
  const projects = () =>
    Entity.make({
      entityType: "Project",
      model: DynamoModel.configure(Project, { projectId: { identifier: true } }),
      primaryKey: {
        pk: { field: "pk", composite: ["projectId"] },
        sk: { field: "sk", composite: [] },
      },
    })
  class Task extends Schema.Class<Task>("Task")({
    id: Schema.String,
    project: DynamoModel.ref(Project),
    count: Schema.Number,
    extra: Schema.optional(Schema.Number),
    data: Schema.Record(Schema.String, Schema.Number),
  }) {}
  const longKey = "k".repeat(251)

  for (const [mode, lifecycle] of [
    ["retained", { versioned: { retain: true } }],
    ["versioned", { versioned: true }],
    ["plain", {}],
  ] as const) {
    const Projects = projects()
    const Tasks = Entity.make({
      entityType: "Task",
      model: DynamoModel.configure(Task, { data: { storedAs: DynamoModel.SparseMap() } }),
      primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
      refs: { project: { entity: Projects } },
      ...lifecycle,
    } as any) as any
    const table = Table.make({ schema, entities: { Projects, Tasks } })

    it.effect(`${mode}: a 251-character entry key is written, as 1.39.0 wrote it`, () =>
      typed(
        Effect.gen(function* () {
          const rows = makeRecordingTable()
          yield* Effect.gen(function* () {
            const db: any = yield* DynamoClient.make({
              entities: { Projects, Tasks },
              tables: { Main: table },
            })
            yield* db.entities.Projects.put({ projectId: "p", name: "Project" })
            yield* db.entities.Projects.put({ projectId: "q", name: "Other" })
            yield* db.entities.Tasks.put({
              id: "a",
              projectId: "p",
              count: 1,
              extra: 1,
              data: { ok: 1 },
            })
            yield* db.entities.Tasks.update({ id: "a" })
              .set({ projectId: "q", data: { [longKey]: 2 } })
              .pathSet({ segments: ["extra"], value: 7, isPath: false })
            const read = yield* db.entities.Tasks.get({ id: "a" })
            expect(read.data[longKey]).toBe(2)
            expect(read.extra).toBe(7)
          }).pipe(Effect.provide(Layer.merge(rows.layer, table.layer({ name: "t" }))))
        }),
      ),
    )
  }
})

describe("a vector index's source text over a sparse map", () => {
  const Doc = DynamoModel.configure(
    Schema.Struct({
      id: Schema.String,
      note: Schema.String,
      data: Schema.Record(Schema.String, Schema.Number),
    }),
    { data: { storedAs: DynamoModel.SparseMap() } },
  )

  for (const [mode, lifecycle] of [
    ["retained", { versioned: { retain: true } }],
    ["plain", {}],
  ] as const) {
    it.effect(`${mode}: an update's source text gets the map as a plain object`, () =>
      typed(
        Effect.gen(function* () {
          const seen: Array<{ readonly plain: boolean; readonly text: string }> = []
          const Docs = Entity.make({
            entityType: "Doc",
            model: Doc,
            primaryKey: {
              pk: { field: "pk", composite: ["id"] },
              sk: { field: "sk", composite: [] },
            },
            vectorIndexes: {
              byText: {
                name: "vec",
                dimensions: 2,
                source: {
                  fields: ["note", "data"],
                  compose: ({ note, data }: { note: string; data: Record<string, number> }) => {
                    // biome-ignore lint/suspicious/noPrototypeBuiltins: a caller's compose may call it
                    const text = `${note} ${data.hasOwnProperty("ok") ? data.ok : "none"}`
                    seen.push({ plain: Object.getPrototypeOf(data) === Object.prototype, text })
                    return text
                  },
                },
              },
            },
            ...lifecycle,
          } as any) as any
          const table = Table.make({ schema, entities: { Docs } })
          const rows = makeRecordingTable()
          yield* Effect.gen(function* () {
            const db: any = yield* DynamoClient.make({
              entities: { Docs },
              tables: { Main: table },
            })
            yield* db.entities.Docs.put({ id: "a", note: "before", data: { ok: 1 } })
            seen.length = 0
            yield* db.entities.Docs.update({ id: "a" }).set({ note: "after" })
            expect(seen).toEqual([{ plain: true, text: "after 1" }])
          }).pipe(
            Effect.provide(
              Layer.mergeAll(
                rows.layer,
                table.layer({ name: "t" }),
                Embedder.layerTest({ dimensions: 2 }),
              ),
            ),
          )
        }),
      ),
    )
  }
})
