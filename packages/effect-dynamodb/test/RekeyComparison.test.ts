/**
 * What `rekey` compares (#183, D58), on a table that stores what it is sent. The
 * scenarios are in `helpers/RekeyComparison.ts`; `connected.sharding.test.ts` runs
 * them on DynamoDB Local.
 */

import { describe, expect, it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
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
  sameBytesMoveScenarios,
  shardLayoutMoveScenario,
  sharedPairScenarios,
  sharedShardMoveScenario,
  sharedTableKeyMoveScenarios,
  tableKeyAttributeScenarios,
  writePathScenarios,
  zOrderScenarios,
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

describe("`rekey` touches no key a write stored", () => {
  describe("the composites in the fixture's model", () => {
    for (const scenario of compositeKindScenarios) {
      it.effect(scenario.name, () => scenario.run(harness))
    }
  })
  describe("the fixture's shapes, through the writes it lists", () => {
    for (const scenario of [...writePathScenarios, ...otherWritePathScenarios]) {
      it.effect(scenario.name, () => scenario.run(harness))
    }
  })
})

describe("what `rekey` compares", () => {
  describe("a Z-order index", () => {
    for (const scenario of zOrderScenarios) {
      it.effect(scenario.name, () => scenario.run(harness))
    }
  })
  it.effect("a sharded partition key moves between layouts, and the sort key beside it stays", () =>
    shardLayoutMoveScenario(harness),
  )
  describe("never a table key attribute", () => {
    for (const scenario of tableKeyAttributeScenarios) {
      it.effect(scenario.name, () => scenario.run(harness))
    }
  })
  for (const scenario of labelScenarios) {
    it.effect(scenario.name, () => scenario.run(harness))
  }
})

describe("two accessors sharing attributes (shape 13)", () => {
  for (const scenario of sharedPairScenarios) {
    it.effect(scenario.name, () => scenario.run(harness))
  }
})

describe("a move, where accessors sharing an attribute compose the same bytes", () => {
  for (const scenario of sameBytesMoveScenarios) {
    it.effect(scenario.name, () => scenario.run(harness))
  }
  for (const scenario of sharedTableKeyMoveScenarios) {
    it.effect(scenario.name, () => scenario.run(harness))
  }
  it.effect("two accessors over one sharded partition key", () => sharedShardMoveScenario(harness))
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

  it.effect("rewritten only when it's exactly its own 1.36 text, as for any half", () =>
    Effect.gen(function* () {
      expect(text136(-3)).not.toBe(now(-3))
      const legacy = yield* run({ tenant: -3 }, text136(-3))
      expect(legacy.report.indexKeysRewritten).toBe(1)
      expect(legacy.after).toBe(now(-3))
      const lagging = yield* run({ tenant: 5 }, now(4))
      expect(lagging.report.indexKeysRewritten).toBe(0)
      expect(lagging.after).toBe(now(4))
      const lagging136 = yield* run({ tenant: 5 }, text136(-3))
      expect(lagging136.report.indexKeysRewritten).toBe(0)
      expect(lagging136.after).toBe(text136(-3))
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

// The guard, on a key `rekey` really rewrites. Only a recording table can step in between
// its read and its write.
describe("a write between `rekey`'s read and its write wins", () => {
  const on = DynamoSchema.make({ name: "guarded", version: 1 })
  const worldWith = (shards: number | undefined) => {
    const Rows = Entity.make({
      model: DynamoModel.configure(
        Schema.Struct({
          id: Schema.String,
          tenant: Schema.String,
          region: Schema.String,
          zone: Schema.String,
          note: Schema.optional(Schema.String),
        }),
        { region: { field: "r" } },
      ),
      entityType: "Row",
      primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
      indexes: {
        byTenant: {
          name: "gsi",
          pk: { field: "gpk", composite: ["tenant"] },
          sk: { field: "gsk", composite: ["region", "zone", "id"] },
          ...(shards === undefined ? {} : { shards }),
        },
      },
    } as never) as any
    return { Rows, MainTable: Table.make({ schema: on, entities: { Rows } }) }
  }
  const values = { id: "1", tenant: "t", region: "a b", zone: "z" }

  for (const shards of [undefined, 8]) {
    for (const { name, changes, rewritten } of [
      {
        name: "a composite changing: the key is left",
        changes: { zone: { S: "y" } },
        rewritten: 0,
      },
      {
        name: "a renamed composite changing: the key is left",
        changes: { r: { S: "c d" } },
        rewritten: 0,
      },
      {
        name: "another attribute changing: the key is rewritten, and the write kept",
        changes: { note: { S: "new" } },
        rewritten: 1,
      },
    ]) {
      it.effect(`${name}, shards=${shards}`, () => {
        const world = worldWith(shards)
        const index = world.Rows.indexes.byTenant
        const unsharded = KeyComposer.unshardedView(index)
        const table = makeRecordingTable({ indexes: { gsi: { pk: "gpk", sk: "gsk" } } })
        const { region, ...rest } = values
        const stored = toAttributeMap({
          ...rest,
          r: region,
          ...KeyComposer.composeIndexKeys(on, "Row", 1, world.Rows.indexes.primary, values),
          gpk: KeyText136.composePk(on, "Row", unsharded, values),
          gsk: KeyText136.composeSk(on, "Row", 1, index, values),
          __edd_e__: "Row",
        }) as Record<string, any>
        const at = `${stored.pk.S}|${stored.sk.S}`
        table.items.set(at, stored)
        let writes = 0
        table.hooks.onRequest = ({ command }) => {
          if (command === "UpdateItem" && writes++ === 0) {
            table.items.set(at, { ...table.items.get(at)!, ...changes })
          }
        }
        return Effect.gen(function* () {
          const db = yield* clientOf(world)
          const report = yield* db.tables.MainTable.rekey()
          expect(report.conflicts).toEqual([])
          const row = table.items.get(at)!
          for (const [attr, value] of Object.entries(changes)) expect(row[attr]).toEqual(value)
          expect(row.gsk!.S).toBe(
            rewritten === 1 ? KeyComposer.composeSk(on, "Row", 1, index, values) : stored.gsk.S,
          )
          // A sharded partition key is moved whatever holds its composites: it isn't one.
          if (shards !== undefined) {
            expect(row.gpk!.S).toBe(KeyComposer.composeStoredPk(on, "Row", index, values))
          }
        }).pipe(
          Effect.provide(Layer.merge(table.layer, world.MainTable.layer({ name: "guarded" }))),
        ) as never
      })
    }
  }
})

describe("a dry run judges each row on its own", () => {
  for (const scenario of dryRunChainScenarios) {
    it.effect(scenario.name, () => scenario.run(harness))
  }
})
