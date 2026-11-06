/**
 * An inverted index (#183, canonical shape 14), on a table that stores what it is sent. The
 * scenarios are in `helpers/InvertedIndexes.ts`; `connected.sharding.test.ts` runs them on
 * DynamoDB Local. `packages/schema/test/InvertedIndex.test.ts` covers the composers and the
 * definitions.
 */

import { describe, expect, it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import type * as KeyComposer from "@effect-dynamodb/schema/KeyComposer.js"
import { Effect, Layer, Schema } from "effect"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"
import {
  clientOf,
  type Harness,
  multiCompositeOffScenarios,
  multiCompositeScenarios,
  number136Scenarios,
  numberAndDateScenarios,
  off136Scenarios,
  overwritten137OffScenario,
  overwritten137Scenario,
  overwritten137Scenarios,
  row136Scenarios,
  textScenarios,
  unchanged136Scenario,
  writePathScenarios,
} from "./helpers/InvertedIndexes.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

const harness: Harness = {
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
      return yield* body(db, {
        seed: (row) =>
          Effect.sync(() => {
            table.items.set(`${row.pk.S}|${row.sk.S}`, row)
          }),
        rows: () => Effect.sync(() => [...table.items.values()]),
        as: (other, inner) =>
          Effect.gen(function* () {
            const current = yield* clientOf(other)
            return yield* inner(current)
          }).pipe(Effect.provide(other.MainTable.layer({ name: "halves" }))),
      })
    }).pipe(
      Effect.provide(Layer.merge(table.layer, world.MainTable.layer({ name: "halves" }))),
    ) as never
  },
}

describe("an inverted index (shape 14)", () => {
  describe("what any value does through it", () => {
    for (const scenario of textScenarios) {
      it.effect(scenario.name, () => scenario.run(harness))
    }
  })
  describe("number and date composites", () => {
    for (const scenario of numberAndDateScenarios) {
      it.effect(scenario.name, () => scenario.run(harness))
    }
  })
  describe("every other write path", () => {
    for (const scenario of writePathScenarios) {
      it.effect(scenario.name, () => scenario.run(harness))
    }
  })
  describe("a sort key of several composites", () => {
    for (const scenario of multiCompositeScenarios) {
      it.effect(scenario.name, () => scenario.run(harness))
    }
  })
  describe("a sort key of several composites, escapeKeys off", () => {
    for (const scenario of multiCompositeOffScenarios) {
      it.effect(scenario.name, () => scenario.run(harness))
    }
  })
  describe("a row 1.36 wrote", () => {
    for (const scenario of row136Scenarios) {
      it.effect(scenario.name, () => scenario.run(harness))
    }
    it.effect("whose text didn't change", () => unchanged136Scenario(harness))
    for (const scenario of number136Scenarios) {
      it.effect(`of numbers and dates, ${scenario.name}`, () => scenario.run(harness))
    }
    for (const scenario of off136Scenarios) {
      it.effect(`under escapeKeys off: ${scenario.name}`, () => scenario.run(harness))
    }
  })
  it.effect("a row 1.37.0 overwrote is at its key", () => overwritten137Scenario(harness))
  it.effect("off moves a row 1.37.0 overwrote back", () => overwritten137OffScenario(harness))
  for (const scenario of overwritten137Scenarios) {
    it.effect(`a row 1.37.0 overwrote, ${scenario.name}`, () => scenario.run(harness))
  }
})

describe("what an inverted query sends", () => {
  class Member extends Schema.Class<Member>("Member")({
    tenant: Schema.String,
    userId: Schema.String,
    groupId: Schema.String,
  }) {}
  const schema = DynamoSchema.make({ name: "sent", version: 1, escapeKeys: true })
  const definition = {
    model: Member,
    entityType: "Member",
    primaryKey: {
      pk: { field: "pk", composite: ["tenant", "userId"] },
      sk: { field: "sk", composite: ["groupId"] },
    },
    indexes: {
      byGroup: {
        name: "inverted",
        pk: { field: "sk", composite: ["groupId"] },
        sk: { field: "pk", composite: ["tenant", "userId"] },
      },
    },
  } as const
  const Members = Entity.make(definition)
  const MainTable = Table.make({ schema, entities: { Members } })

  const queries = (
    body: (db: any) => Effect.Effect<unknown, unknown, any>,
  ): Effect.Effect<ReadonlyArray<Record<string, any>>, unknown> => {
    const table = makeRecordingTable({ indexes: { inverted: { pk: "sk", sk: "pk" } } })
    return Effect.gen(function* () {
      const db = yield* DynamoClient.make({ entities: { Members }, tables: { MainTable } })
      yield* body(db)
      return table.requests
        .filter((request) => request.command === "Query")
        .map((request) => request.input)
    }).pipe(Effect.provide(Layer.merge(table.layer, MainTable.layer({ name: "sent" })))) as never
  }

  const key = (input: Record<string, any>) =>
    Object.values<{ readonly S: string }>(input.ExpressionAttributeValues)
      .map((value) => value.S)
      .filter((text) => text.startsWith("$"))

  it.effect("a partial pin on plain values: one request, as on any other index", () =>
    Effect.gen(function* () {
      const sent = yield* queries((db) =>
        db.entities.Members.byGroup({ groupId: "g", tenant: "t" }).collect(),
      )
      expect(sent).toHaveLength(1)
      expect(sent[0]!.KeyConditionExpression).toContain("BETWEEN")
      expect(key(sent[0]!).sort()).toEqual([
        "$sent#v1#member#groupid_g",
        "$sent#v1#member#tenant_t",
        "$sent#v1#member#tenant_t#\uFFFF",
      ])
    }),
  )

  it.effect("a value with something to escape is one request, under its escaped key", () =>
    Effect.gen(function* () {
      const sent = yield* queries((db) =>
        db.entities.Members.byGroup({ groupId: "a b", tenant: "x y" }).collect(),
      )
      expect(sent.map((input) => key(input).sort())).toEqual([
        [
          "$sent#v1#member#groupid_a%20b",
          "$sent#v1#member#tenant_x%20y",
          "$sent#v1#member#tenant_x%20y#\uFFFF",
        ],
      ])
    }),
  )

  it.effect("escapeKeys off: one request, as 1.36 sent it", () =>
    Effect.gen(function* () {
      const off = DynamoSchema.make({ name: "sent", version: 1, escapeKeys: false })
      const Unescaped = Entity.make(definition)
      const OffTable = Table.make({ schema: off, entities: { Members: Unescaped } })
      const table = makeRecordingTable({ indexes: { inverted: { pk: "sk", sk: "pk" } } })
      yield* Effect.gen(function* () {
        const db = (yield* DynamoClient.make({
          entities: { Members: Unescaped },
          tables: { MainTable: OffTable },
        })) as any
        yield* db.entities.Members.byGroup({ groupId: "a b", tenant: "x y" }).collect()
      }).pipe(
        Effect.provide(Layer.merge(table.layer, OffTable.layer({ name: "sent" }))),
      ) as Effect.Effect<void>
      const sent = table.requests
        .filter((request) => request.command === "Query")
        .map((request) => request.input)
      expect(sent).toHaveLength(1)
      expect(sent[0]!.KeyConditionExpression).toContain("begins_with")
      expect(key(sent[0]!).sort()).toEqual([
        "$sent#v1#member#groupid_a b",
        "$sent#v1#member#tenant_x y#",
      ])
    }),
  )

  it.effect("a `.where()` equal on a composite before the last is one request", () =>
    Effect.gen(function* () {
      const sent = yield* queries((db) =>
        db.entities.Members.byGroup({ groupId: "g" })
          .where((t: any, o: any) => o.eq(t.tenant, "x y"))
          .collect(),
      )
      expect(sent).toHaveLength(1)
      expect(key(sent[0]!)).toEqual(expect.arrayContaining(["$sent#v1#member#tenant_x%20y"]))
    }),
  )

  it.effect("a one-sided range under a pin is the plan of any other index", () =>
    Effect.gen(function* () {
      const sent = yield* queries((db) =>
        db.entities.Members.byGroup({ groupId: "g", tenant: "t" })
          .where((t: any, o: any) => o.gt(t.userId, "a"))
          .collect(),
      )
      expect(key(sent[0]!)).toContain("$sent#v1#member#tenant_t#userid_a#\uFFFF")
    }),
  )
})
