/**
 * What `rekey` compares (#183, D58), on a table that stores what it is sent. The
 * scenarios are in `helpers/RekeyComparison.ts`; `connected.sharding.test.ts` runs
 * them on DynamoDB Local.
 */

import { describe, expect, it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import * as KeyText136 from "@effect-dynamodb/schema/internal/KeyText136.js"
import * as KeyComposer from "@effect-dynamodb/schema/KeyComposer.js"
import { Effect, Layer, Schema } from "effect"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import { toAttributeMap } from "../src/Marshaller.js"
import * as Table from "../src/Table.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"
import {
  clientOf,
  compositeKindScenarios,
  dryRunChainScenarios,
  type Harness,
  labelScenarios,
  otherWritePathScenarios,
  sharedAttributeScenario,
  tableKeyAttributeScenario,
  writePathScenarios,
  zOrderPartitionScenario,
} from "./helpers/RekeyComparison.js"

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
      })
    }).pipe(
      Effect.provide(Layer.merge(table.layer, world.MainTable.layer({ name: "compared" }))),
    ) as never
  },
}

describe("a key a write composed is what `rekey` composes", () => {
  describe("every kind of composite", () => {
    for (const scenario of compositeKindScenarios) {
      it.effect(scenario.name, () => scenario.run(harness))
    }
  })
  describe("every shape, through every write", () => {
    for (const scenario of [...writePathScenarios, ...otherWritePathScenarios]) {
      it.effect(scenario.name, () => scenario.run(harness))
    }
  })
})

describe("what `rekey` compares", () => {
  it.effect("a Z-order index's partition key, and never its address", () =>
    zOrderPartitionScenario(harness),
  )
  it.effect("two accessors sharing an attribute: the later one wins, as on a write", () =>
    sharedAttributeScenario(harness),
  )
  it.effect("never a table key attribute", () => tableKeyAttributeScenario(harness))
  for (const scenario of labelScenarios) {
    it.effect(scenario.name, () => scenario.run(harness))
  }
})

describe("a vector index's partition", () => {
  const on = DynamoSchema.make({ name: "compared", version: 1 })
  const Docs = Entity.make({
    model: Schema.Struct({
      tenant: Schema.optional(Schema.Number),
      id: Schema.String,
      text: Schema.String,
    }),
    entityType: "Doc",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
    vectorIndexes: {
      byText: {
        name: "vec",
        dimensions: 4,
        distance: "cosine",
        source: { fields: ["text"] },
        partition: ["tenant"],
      },
    },
  })
  const DocsTable = Table.make({ schema: on, entities: { Docs } })
  const definition = Docs._vectorIndexes.byText!
  const partitionField = definition.partitionField

  /** A row under its table key, its partition as `stored`; `rekey`'s run over it. */
  const run = (values: Record<string, unknown>, stored: string | undefined) => {
    const table = makeRecordingTable({ indexes: {} })
    const row = toAttributeMap({
      ...values,
      id: "1",
      text: "t",
      ...KeyComposer.composeIndexKeys(on, "Doc", 1, Docs.indexes.primary, { id: "1" }),
      ...(stored === undefined ? {} : { [partitionField]: stored }),
      __edd_e__: "Doc",
    })
    table.items.set(`${row.pk!.S}|${row.sk!.S}`, row)
    return Effect.gen(function* () {
      const db = yield* DynamoClient.make({ entities: { Docs }, tables: { DocsTable } })
      const report = yield* db.tables.DocsTable.rekey()
      expect(report.conflicts).toEqual([])
      return { report, after: [...table.items.values()][0]![partitionField]?.S }
    }).pipe(Effect.provide(Layer.merge(table.layer, DocsTable.layer({ name: "docs" }))))
  }
  const now = (tenant: number) =>
    KeyComposer.tryComposeVectorPartition(on, "Doc", definition, { tenant })
  const text136 = (tenant: number) =>
    KeyText136.tryComposeVectorPartition(on, "Doc", definition, { tenant })

  it.effect("a row's values decide, as for any half", () =>
    Effect.gen(function* () {
      expect(text136(-3)).not.toBe(now(-3))
      const legacy = yield* run({ tenant: -3 }, text136(-3))
      expect(legacy.report.indexKeysRewritten).toBe(1)
      expect(legacy.after).toBe(now(-3))
      const stale = yield* run({ tenant: 5 }, now(4))
      expect(stale.report.indexKeysRewritten).toBe(1)
      expect(stale.after).toBe(now(5))
      const same = yield* run({ tenant: 5 }, now(5))
      expect(same.report.indexKeysRewritten).toBe(0)
    }),
  )

  it.effect("one the row holds no value for is left, and none isn't written", () =>
    Effect.gen(function* () {
      const cleared = yield* run({}, text136(-3))
      expect(cleared.report.indexKeysRewritten).toBe(0)
      expect(cleared.after).toBe(text136(-3))
      const missing = yield* run({ tenant: 5 }, undefined)
      expect(missing.report.indexKeysRewritten).toBe(0)
      expect(missing.after).toBeUndefined()
    }),
  )
})

describe("a dry run judges each row on its own", () => {
  for (const scenario of dryRunChainScenarios) {
    it.effect(scenario.name, () => scenario.run(harness))
  }
})
