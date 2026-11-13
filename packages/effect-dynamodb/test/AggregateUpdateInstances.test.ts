/**
 * The instances `update` returns after a change to a `context` field (#241). Where a member value's
 * copy of a context attribute is set to what its row holds (DESIGN.md §11 "What `update`
 * returns"), the value is built as a read builds it: a `Schema.Class` instance by its class's
 * constructor, so a private field and a method reading it work, as on published 1.40.0, which
 * returned the decoded instance (its copy the old value). A value no constructor can build again (an
 * instance of a class of the caller's own, held by `Schema.Unknown`) is returned as the mutation
 * gave it, as on 1.40.0. Under each `escapeKeys` setting.
 */

import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Effect, Layer, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Aggregate from "../src/Aggregate.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Table from "../src/Table.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

class Line extends Schema.Class<Line>("UpdateInstancesLine")({
  id: Schema.String,
  tenantId: Schema.String,
}) {
  #prefix = "Line"
  label() {
    return `${this.#prefix}: ${this.id} (${this.tenantId})`
  }
}

class Order extends Schema.Class<Order>("UpdateInstancesOrder")({
  id: Schema.String,
  tenantId: Schema.String,
  line: Line,
}) {
  #prefix = "Order"
  label() {
    return `${this.#prefix}: ${this.id} (${this.tenantId}), ${this.line.label()}`
  }
}

/** A class of the caller's own, not a schema: nothing can build it again but the caller. */
class Note {
  #prefix = "Note"
  readonly tenantId: string
  readonly text: string
  constructor(tenantId: string, text: string) {
    this.tenantId = tenantId
    this.text = text
  }
  label() {
    return `${this.#prefix}: ${this.text} (${this.tenantId})`
  }
}

const run = <A>(
  escapeKeys: boolean,
  model: Schema.Top,
  edges: Record<string, unknown>,
  body: (agg: any) => Effect.Effect<A, unknown>,
): Promise<A> => {
  const schema = DynamoSchema.make({ name: "updinst", version: 1, escapeKeys })
  const Main = Table.make({ schema, entities: {} })
  const Agg = Aggregate.make(
    model as never,
    {
      schema,
      table: Main,
      pk: { field: "pk", composite: ["id"] },
      collection: { name: "agg" },
      root: { entityType: "Root" },
      context: ["tenantId"],
      edges,
    } as never,
  ) as any
  const table = makeRecordingTable()
  return Effect.runPromise(
    Effect.gen(function* () {
      const db: any = yield* DynamoClient.make({
        entities: {},
        aggregates: { Agg },
        tables: { Main },
      })
      return yield* body(db.aggregates.Agg)
    }).pipe(
      Effect.provide(Layer.merge(table.layer, Main.layer({ name: "updinst" }))),
    ) as Effect.Effect<A, never, never>,
  )
}

const toT2 = ({ state }: any) => ({ ...state, tenantId: "t2" })

describe.each([false, true])("update after a context change (escapeKeys %s)", (escapeKeys) => {
  it("a Schema.Class member holding a private field: an instance its method works on, the copy as its row holds it", async () => {
    const { updated, after } = await run(
      escapeKeys,
      Schema.Struct({ id: Schema.String, tenantId: Schema.String, line: Line }),
      { line: Aggregate.one({ entityType: "Line" }) },
      (agg) =>
        Effect.gen(function* () {
          yield* agg.create({
            id: "a",
            tenantId: "t1",
            line: new Line({ id: "b", tenantId: "t1" }),
          })
          const updated = yield* agg.update({ id: "a" }, toT2)
          const after = yield* agg.get({ id: "a" })
          return { updated, after }
        }),
    )
    expect(updated.line).toBeInstanceOf(Line)
    expect(updated.line.label()).toBe("Line: b (t2)")
    expect(after.line.label()).toBe("Line: b (t2)")
  })

  it("a Schema.Class root above it: built by its constructor too", async () => {
    const { updated, after } = await run(
      escapeKeys,
      Order,
      { line: Aggregate.one({ entityType: "Line" }) },
      (agg) =>
        Effect.gen(function* () {
          yield* agg.create(
            new Order({ id: "a", tenantId: "t1", line: new Line({ id: "b", tenantId: "t1" }) }),
          )
          const updated = yield* agg.update(
            { id: "a" },
            ({ state }: any) => new Order({ id: state.id, tenantId: "t2", line: state.line }),
          )
          const after = yield* agg.get({ id: "a" })
          return { updated, after }
        }),
    )
    expect(updated).toBeInstanceOf(Order)
    expect(updated.line).toBeInstanceOf(Line)
    expect(updated.label()).toBe("Order: a (t2), Line: b (t2)")
    expect(after.label()).toBe("Order: a (t2), Line: b (t2)")
  })

  it("an instance of the caller's own class under Schema.Unknown: the mutation's, as on 1.40.0", async () => {
    const note = new Note("t1", "n")
    const { updated, after } = await run(
      escapeKeys,
      Schema.Struct({ id: Schema.String, tenantId: Schema.String, note: Schema.Unknown }),
      { note: Aggregate.one({ entityType: "Note" }) },
      (agg) =>
        Effect.gen(function* () {
          yield* agg.create({ id: "a", tenantId: "t1", note: { text: "n" } })
          const updated = yield* agg.update({ id: "a" }, ({ state }: any) => ({
            ...state,
            tenantId: "t2",
            note,
          }))
          const after = yield* agg.get({ id: "a" })
          return { updated, after }
        }),
    )
    expect(updated.note).toBe(note)
    expect(updated.note.label()).toBe("Note: n (t1)")
    expect(after.note).toEqual({ text: "n", tenantId: "t2" })
  })
})
