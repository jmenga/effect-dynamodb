/**
 * `EDD-9128` from the operational `Entity.make` and `Aggregate.make`: no value is composed into key
 * text from a field storing both numeric kinds. Every place is covered on the pure makes, in
 * `@effect-dynamodb/schema`'s `test/BothKindsKeys.test.ts`; a field no key reads, on every path
 * that composes keys from a stored row, in `helpers/StoredRowKeyScenarios.ts`.
 */

import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Aggregate from "../src/Aggregate.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"

const Both = Schema.Union([Schema.Number, Schema.BigInt])
const Model = Schema.Struct({ id: Schema.String, n: Both, note: Schema.String })
const primary = (sk: ReadonlyArray<string>) => ({
  pk: { field: "pk", composite: ["id"] },
  sk: { field: "sk", composite: sk },
})

describe("EDD-9128 from the operational makes", () => {
  it("an entity's key, unique constraint and time-series orderBy", () => {
    const make = (config: Record<string, unknown>) => () =>
      Entity.make({ model: Model, entityType: "E", primaryKey: primary([]), ...config } as never)
    expect(make({ primaryKey: primary(["n"]) })).toThrow(
      /\[EDD-9128\] Entity "E": the primary key can't be composed from "n"/,
    )
    expect(
      make({
        indexes: {
          byN: {
            name: "gsi1",
            pk: { field: "gsi1pk", composite: ["id"] },
            sk: { field: "gsi1sk", composite: ["n"] },
          },
        },
      }),
    ).toThrow(/\[EDD-9128\] Entity "E": index "byN"/)
    expect(make({ unique: { byN: ["n"] } })).toThrow(/unique constraint "byN"/)
    expect(
      make({
        timeSeries: {
          orderBy: "n",
          appendInput: Schema.Struct({ id: Schema.String, n: Both, note: Schema.String }),
        },
      }),
    ).toThrow(/EDD-9128.*timeSeries\.orderBy/)
    // A field no key reads may store both.
    expect(make({})).not.toThrow()
  })

  it("an aggregate's partition key and a many edge's sort key", () => {
    const schema = DynamoSchema.make({ name: "app", version: 1 })
    const Lines = Entity.make({
      model: Schema.Struct({ id: Schema.String }),
      entityType: "Anchor",
      primaryKey: primary([]),
    } as never)
    const Main = Table.make({ schema, entities: { Lines } } as never) as Table.Table
    const Line = Schema.Struct({ sku: Schema.String, n: Both })
    const Root = Schema.Struct({ id: Schema.String, n: Both, lines: Schema.Array(Line) })
    const make = (pk: ReadonlyArray<string>, sk: ReadonlyArray<string>) => () =>
      Aggregate.make(Root, {
        table: Main,
        schema,
        pk: { field: "pk", composite: pk },
        collection: { name: "root" },
        root: { entityType: "Root" },
        edges: { lines: Aggregate.many({ entityType: "Line", sk: { composite: sk } }) },
      } as never)
    expect(make(["id", "n"], ["sku"])).toThrow(
      /\[EDD-9128\] Aggregate "Root": its partition key can't be composed from "n"/,
    )
    expect(make(["id"], ["n"])).toThrow(/\[EDD-9128\] Aggregate "Root": edge "lines"'s sort key/)
    expect(make(["id"], ["sku"])).not.toThrow()
  })
})
