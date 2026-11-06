/**
 * Key halves sharing an attribute (#183, `EDD-9106`): what `Table.make` can judge that
 * `Entity.make` can't, what's refused, and that the definitions it lets through work. The
 * rule itself is checked against the composers in `packages/schema/test/Shards.test.ts`;
 * these scenarios also run on DynamoDB Local (`connected.sharding.test.ts`).
 */

import { describe, expect, it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import * as PureEntity from "@effect-dynamodb/schema/Entity.js"
import type * as KeyComposer from "@effect-dynamodb/schema/KeyComposer.js"
import { Effect, Layer, Schema } from "effect"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"
import {
  agreeingCasingScenario,
  clientOf,
  type Harness,
  keptEntryScenarios,
  leavingIndexScenarios,
  offIndexScenarios,
  tableKeyScenarios,
} from "./helpers/SharedKeyAttributes.js"

const lower = DynamoSchema.make({ name: "shared", version: 1 })
const upper = DynamoSchema.make({ name: "shared", version: 1, casing: "uppercase" })

const model = Schema.Struct({ tenant: Schema.String, id: Schema.String })
const definition = {
  model,
  entityType: "Cased",
  primaryKey: {
    pk: { field: "pk", composite: ["tenant"] },
    sk: { field: "sk", composite: ["id"] },
  },
  indexes: {
    byId: {
      name: "gsi",
      pk: { field: "gpk", composite: ["id"] },
      sk: { field: "sk", composite: ["id"] },
      shards: 8,
      casing: "uppercase",
    },
  },
} as const

describe("Table.make resolves a casing an index leaves to the schema", () => {
  it("refuses a sharded index's sort key cased differently from the table's it shares", () => {
    const Cased = Entity.make(definition)
    expect(() => Table.make({ schema: lower, entities: { Cased } })).toThrow(
      /\[EDD-9106\].*the primary key's sort key and index "byId"'s sort key.*"sk".*"lowercase" and "uppercase"/,
    )
  })

  it("takes it under a schema that agrees", () => {
    const Cased = Entity.make(definition)
    expect(Table.make({ schema: upper, entities: { Cased } }).schema).toBe(upper)
  })

  it("judges a pure definition the same way", () => {
    const Cased = PureEntity.make(definition)
    expect(() => Table.make({ schema: lower, entities: { Cased } as never })).toThrow("[EDD-9106]")
    expect(Table.make({ schema: upper, entities: { Cased } as never }).schema).toBe(upper)
  })

  describe("one entity on two tables with different schemas", () => {
    it("each judges by its own, and a refusal leaves the binding it had", () => {
      const Cased = Entity.make(definition)
      Table.make({ schema: upper, entities: { Cased } })
      expect(Cased._schema).toBe(upper)
      expect(() => Table.make({ schema: lower, entities: { Cased } })).toThrow("[EDD-9106]")
      expect(Cased._schema).toBe(upper)
    })

    it("a refusal first leaves it unbound, and doesn't stop the table that agrees", () => {
      const Cased = Entity.make(definition)
      expect(() => Table.make({ schema: lower, entities: { Cased } })).toThrow("[EDD-9106]")
      expect(Cased._schema).toBeUndefined()
      Table.make({ schema: upper, entities: { Cased } })
      expect(Cased._schema).toBe(upper)
    })

    it("a refused table binds none of its members, valid ones included", () => {
      const Cased = Entity.make(definition)
      const Plain = Entity.make({ ...definition, entityType: "Plain", indexes: {} })
      expect(() => Table.make({ schema: lower, entities: { Plain, Cased } })).toThrow("[EDD-9106]")
      expect(Plain._schema).toBeUndefined()
    })
  })

  it("a casing is judged through the table, whatever it reaches", () => {
    const Numeric = Entity.make({
      model: Schema.Struct({
        tenant: Schema.String,
        id: Schema.String,
        n: Schema.Number,
        x: Schema.Number,
      }),
      entityType: "Numeric",
      primaryKey: definition.primaryKey,
      indexes: {
        a: {
          name: "a",
          pk: { field: "apk", composite: ["tenant"] },
          sk: { field: "zsk", prefix: ["n"], zorder: [{ field: "x", min: 0, max: 100 }] },
        },
        b: {
          name: "b",
          pk: { field: "bpk", composite: ["tenant"] },
          sk: { field: "zsk", prefix: ["n"], zorder: [{ field: "x", min: 0, max: 100 }] },
          casing: "uppercase",
        },
      },
    })
    expect(() => Table.make({ schema: lower, entities: { Numeric } })).toThrow("[EDD-9106]")
    expect(Table.make({ schema: upper, entities: { Numeric } }).schema).toBe(upper)
  })
})

/** Every attribute an update writes, by name. */
const writtenBy = (request: { readonly input: Record<string, any> }): ReadonlyArray<string> => {
  const names: Record<string, string> = request.input.ExpressionAttributeNames ?? {}
  const clauses = String(request.input.UpdateExpression ?? "").replace(
    /=\s*[^,]*?(?=,|\s[A-Z]+\s|$)/g,
    "",
  )
  return (clauses.match(/#\w+/g) ?? []).map((name) => names[name] ?? name)
}

const harness = (): { readonly h: Harness; readonly written: () => ReadonlyArray<string> } => {
  const written: Array<string> = []
  const h: Harness = {
    on: (world, body) => {
      const indexes: Record<string, { readonly pk: string; readonly sk: string }> = {}
      for (const index of Object.values<KeyComposer.IndexDefinition>(world.Rows.indexes)) {
        if (index.index !== undefined) {
          indexes[index.index] = { pk: index.pk.field, sk: index.sk.field }
        }
      }
      const table = makeRecordingTable({ indexes })
      return Effect.gen(function* () {
        const db = yield* clientOf(world)
        const result = yield* body(db)
        for (const request of table.requests) {
          if (request.command === "UpdateItem") written.push(...writtenBy(request))
          if (request.command === "TransactWriteItems") {
            for (const item of request.input.TransactItems as ReadonlyArray<Record<string, any>>) {
              if (item.Update !== undefined) written.push(...writtenBy({ input: item.Update }))
            }
          }
        }
        return result
      }).pipe(
        Effect.provide(Layer.merge(table.layer, world.MainTable.layer({ name: "shared" }))),
      ) as never
    },
  }
  return { h, written: () => written }
}

describe("a half stored in a table key attribute", () => {
  for (const scenario of tableKeyScenarios) {
    it.effect(scenario.name, () => {
      const { h, written } = harness()
      return Effect.gen(function* () {
        yield* scenario.run(h)
        expect(written()).not.toContain("pk")
        expect(written()).not.toContain("sk")
      })
    })
  }

  describe("leaving the index", () => {
    for (const scenario of leavingIndexScenarios) {
      it.effect(scenario.name, () => {
        const { h, written } = harness()
        return Effect.gen(function* () {
          yield* scenario.run(h)
          expect(written()).not.toContain("sk")
        })
      })
    }
  })

  describe("an entry `preserve` keeps", () => {
    for (const scenario of keptEntryScenarios) {
      it.effect(scenario.name, () => {
        const { h, written } = harness()
        return Effect.gen(function* () {
          yield* scenario.run(h)
          expect(written()).not.toContain("pk")
          expect(written()).not.toContain("sk")
        })
      })
    }
  })

  describe("on no index, with retained versions", () => {
    for (const scenario of offIndexScenarios) {
      it.effect(scenario.name, () => scenario.run(harness().h))
    }
  })

  it.effect("under a casing the schema agrees with", () => agreeingCasingScenario(harness().h))
})

describe("two accessors over one row (shape 13)", () => {
  const model = Schema.Struct({
    tenant: Schema.String,
    id: Schema.String,
    region: Schema.optional(Schema.String),
    group: Schema.optional(Schema.String),
  })
  const shape13 = {
    model,
    entityType: "Paired",
    primaryKey: definition.primaryKey,
    indexes: {
      byRegion: {
        name: "gsi",
        pk: { field: "gpk", composite: ["tenant"] },
        sk: { field: "gsk", composite: ["region"] },
      },
      byGroup: {
        name: "gsi",
        pk: { field: "gpk", composite: ["tenant"] },
        sk: { field: "gsk", composite: ["group"] },
      },
    },
  } as const

  it("Entity.make refuses them on one index, on the runtime and the pure definition", () => {
    const refused = /\[EDD-9108\].*indexes "byRegion" and "byGroup".*"gsi"/
    expect(() => Entity.make(shape13)).toThrow(refused)
    expect(() => PureEntity.make(shape13)).toThrow(refused)
  })

  it("Table.make refuses a pair only its schema can judge", () => {
    const cased = {
      ...shape13,
      indexes: {
        byRegion: {
          name: "gsi",
          pk: { field: "gpk", composite: ["tenant"] },
          sk: { field: "gsk", composite: ["region"] },
          casing: "uppercase",
        },
        byGroup: {
          name: "gsi2",
          pk: { field: "gpk", composite: ["tenant"] },
          sk: { field: "gsk2", composite: ["group"] },
        },
      },
    } as const
    const Paired = Entity.make(cased)
    expect(() => Table.make({ schema: lower, entities: { Paired } })).toThrow(
      /\[EDD-9106\].*"gpk".*"uppercase" and "lowercase"|\[EDD-9106\].*"gpk".*"lowercase" and "uppercase"/,
    )
    expect(Table.make({ schema: upper, entities: { Paired } }).schema).toBe(upper)
  })

  it("in their own attributes, each is its own index", () => {
    const apart = {
      ...shape13,
      indexes: {
        byRegion: shape13.indexes.byRegion,
        byGroup: {
          name: "gsi2",
          pk: { field: "gpk2", composite: ["tenant"] },
          sk: { field: "gsk2", composite: ["group"] },
        },
      },
    } as const
    const Paired = Entity.make(apart)
    expect(Table.make({ schema: lower, entities: { Paired } }).schema).toBe(lower)
  })
})
