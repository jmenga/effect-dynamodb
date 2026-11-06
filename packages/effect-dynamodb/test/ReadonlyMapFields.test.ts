/**
 * `[EDD-9125]` on the operational makes. The table of what's refused and what isn't is the schema
 * package's test of the same name; this covers that each make here asks.
 */

import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Aggregate from "../src/Aggregate.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"

const AppSchema = DynamoSchema.make({ name: "app", version: 1 })
const Base = Table.make({ schema: AppSchema, entities: {} })
const Counts = Schema.ReadonlyMap(Schema.String, Schema.Number)
const Line = Schema.Struct({ sku: Schema.String })

const entity = (model: unknown) =>
  Entity.make({
    model: model as never,
    entityType: "E",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
  } as never)

const aggregate = (model: unknown, edges: Record<string, unknown> = {}) =>
  (Aggregate.make as any)(model, {
    table: Base,
    schema: AppSchema,
    pk: { field: "pk", composite: ["id"] },
    collection: { name: "agg" },
    root: { entityType: "Agg" },
    edges,
  })

const subAggregate = (model: unknown) =>
  (Aggregate.make as any)(model, { root: { entityType: "Sub" }, edges: {} })

const Direct = Schema.Struct({ id: Schema.String, f: Counts })
const Nested = Schema.Struct({ id: Schema.String, a: Schema.Array(Schema.Struct({ m: Counts })) })
const Fine = Schema.Struct({ id: Schema.String, f: Schema.Record(Schema.String, Schema.Number) })

describe("[EDD-9125] the operational makes", () => {
  for (const [name, build, owner] of [
    ["Entity.make", entity, 'Entity "E"'],
    ["Aggregate.make", aggregate, 'Aggregate "Agg"'],
    ["Aggregate.make, a sub-aggregate", subAggregate, 'Aggregate "Sub"'],
  ] as const) {
    it(`${name} refuses one on a field, naming it`, () => {
      expect(() => build(Direct)).toThrow(`[EDD-9125] ${owner}: field "f" is a Schema.ReadonlyMap`)
    })

    it(`${name} refuses one nested, naming the path`, () => {
      expect(() => build(Nested)).toThrow(`field "a[].m" is a Schema.ReadonlyMap`)
    })

    it(`${name} points to Schema.Record, and takes it`, () => {
      expect(() => build(Direct)).toThrow("Use Schema.Record")
      expect(() => build(Fine)).not.toThrow()
    })

    it(`${name} refuses a configured model's`, () => {
      const configured = DynamoModel.configure(Direct, { f: { field: "g" } })
      expect(() => build(configured)).toThrow("[EDD-9125]")
    })
  }

  it("a many edge over one, the form `create` and `get` could reach but `update` couldn't", () => {
    const edges = {
      lines: Aggregate.many({
        entityType: "Line",
        sk: { composite: ["sku"] },
        decompose: (rows: ReadonlyMap<string, unknown>) => [...rows.values()],
        assemble: (rows: ReadonlyArray<never>) => new Map(rows),
      } as never),
    }
    expect(() =>
      aggregate(
        Schema.Struct({ id: Schema.String, lines: Schema.ReadonlyMap(Schema.String, Line) }),
        edges,
      ),
    ).toThrow('field "lines" is a Schema.ReadonlyMap')
  })
})
