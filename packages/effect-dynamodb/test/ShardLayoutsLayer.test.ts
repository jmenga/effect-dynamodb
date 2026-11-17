/**
 * Shard tables supplied at run time (#287, `docs/designs/shard-layouts.md` §10): an index
 * declared `shards: { layouts: "provided" }` takes its table from a `ShardLayouts` layer.
 * `DynamoClient.make` reads it at bind; every path without a bound client reads it from the
 * context it runs in. A missing table is `EDD-9181`, never a fallback, and nothing is sent.
 */

import { describe, expect, it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import * as ShardLayouts from "@effect-dynamodb/schema/ShardLayouts.js"
import { Config, ConfigProvider, Effect, Exit, Layer, Schema } from "effect"
import { beforeEach } from "vitest"
import * as Batch from "../src/Batch.js"
import * as Collection from "../src/Collection.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
import * as Expression from "../src/Expression.js"
import { toAttributeMap } from "../src/Marshaller.js"
import * as Query from "../src/Query.js"
import * as Table from "../src/Table.js"
import * as Transaction from "../src/Transaction.js"
import { calls, InMemoryClient, resetStore, store } from "./helpers/InMemoryTables.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

class Device extends Schema.Class<Device>("Device")({
  channel: Schema.String,
  deviceId: Schema.String,
  tenantId: Schema.String,
  groupId: Schema.String,
}) {}

const schema = DynamoSchema.make({ name: "fleet-db", version: 1, escapeKeys: true })

const Devices = Entity.make({
  model: Device,
  entityType: "Device",
  primaryKey: {
    pk: { field: "pk", composite: ["channel"] },
    sk: { field: "sk", composite: ["deviceId"] },
  },
  indexes: {
    byTenant: {
      collection: "fleet",
      name: "gsi5",
      pk: { field: "gsi5pk", composite: ["tenantId"] },
      sk: { field: "gsi5sk", composite: ["groupId", "deviceId"] },
      shards: { by: ["groupId"], layouts: "provided" },
    },
    byGroup: {
      name: "gsi6",
      pk: { field: "gsi6pk", composite: ["groupId"] },
      sk: { field: "gsi6sk", composite: ["deviceId"] },
    },
  },
})

const MainTable = Table.make({ schema, entities: { Devices } })

const makeTable = () =>
  makeRecordingTable({
    indexes: {
      gsi5: { pk: "gsi5pk", sk: "gsi5sk" },
      gsi6: { pk: "gsi6pk", sk: "gsi6sk" },
    },
  })
type Recording = ReturnType<typeof makeTable>

const hot = (layout: ShardLayouts.Layout = 8) => ({
  default: 1,
  values: [{ match: { tenantId: "T-BIG" }, layout }],
})
const layoutsOf = (layout?: ShardLayouts.Layout) =>
  ShardLayouts.layer([ShardLayouts.of(Devices, { byTenant: hot(layout) })])

const device = (i: number, tenantId: string) => ({
  channel: `channel-${i % 3}`,
  deviceId: `device-${String(i).padStart(2, "0")}`,
  tenantId,
  groupId: i % 2 === 0 ? "group-a" : "group-b",
})
const small = Array.from({ length: 4 }, (_, i) => device(i, "t-small"))
const big = Array.from({ length: 4 }, (_, i) => device(i + 10, i % 2 === 0 ? "T-BIG" : "t-big"))

const indexPkOf = (table: Recording, deviceId: string) =>
  [...table.items.values()].find((row) => row.deviceId?.S === deviceId)?.gsi5pk?.S
const ids = (rows: ReadonlyArray<{ readonly deviceId: string }>) =>
  rows.map((row) => row.deviceId).sort()
const expectSharded = (table: Recording, items: ReadonlyArray<{ readonly deviceId: string }>) => {
  for (const item of items) {
    expect(indexPkOf(table, item.deviceId)).toMatch(/#!8\.\d#tenantid_t-big$/)
  }
}
const expectUnsharded = (table: Recording, items: ReadonlyArray<{ readonly deviceId: string }>) => {
  for (const item of items) {
    expect(indexPkOf(table, item.deviceId)).toMatch(/#tenantid_t-small$/)
    expect(indexPkOf(table, item.deviceId)).not.toContain("#!")
  }
}

/** The table's client and configuration, and (unless `null`) a `ShardLayouts` layer. */
const under = (table: Recording, layouts: Layer.Layer<ShardLayouts.ShardLayouts, any> | null) =>
  layouts === null
    ? Layer.merge(table.layer, MainTable.layer({ name: "t" }))
    : Layer.mergeAll(table.layer, MainTable.layer({ name: "t" }), layouts)

const bound = Effect.gen(function* () {
  return yield* DynamoClient.make({ entities: { Devices }, tables: { MainTable } })
})

const defectOf = (exit: Exit.Exit<unknown, unknown>): string => String(exit)

describe("a table from the layer is the one every path uses", () => {
  it.effect("bound writes and accessors", () => {
    const table = makeTable()
    return Effect.gen(function* () {
      const db = yield* bound
      for (const item of [...small, ...big]) yield* db.entities.Devices.put(item)
      expectSharded(table, big)
      expectUnsharded(table, small)
      expect(ids(yield* db.entities.Devices.byTenant({ tenantId: "t-big" }).collect())).toEqual(
        ids(big),
      )
      expect(ids(yield* db.entities.Devices.byTenant({ tenantId: "t-small" }).collect())).toEqual(
        ids(small),
      )
      const explained = yield* db.entities.Devices.byTenant({ tenantId: "T-BIG" }).explain()
      expect(explained.shards?.count).toBe(8)
      const plain = yield* db.entities.Devices.byTenant({ tenantId: "t-small" }).explain()
      expect(plain.shards).toMatchObject({ count: 1, previous: undefined })
      expect(plain.plan).toBe("key")
    }).pipe(Effect.provide(under(table, layoutsOf())))
  })

  it.effect("bound ops keep R = never: run outside the layer, they use the bind's table", () => {
    const table = makeTable()
    return Effect.gen(function* () {
      const db = yield* bound.pipe(Effect.provide(under(table, layoutsOf())))
      // Nothing in this fiber's context but the client's own binding.
      yield* db.entities.Devices.put(big[0]!)
      expectSharded(table, [big[0]!])
      expect(ids(yield* db.entities.Devices.byTenant({ tenantId: "t-big" }).collect())).toEqual([
        big[0]!.deviceId,
      ])
    })
  })

  it.effect("unbound Batch.write and Transaction.transactWrite puts", () => {
    const table = makeTable()
    return Effect.gen(function* () {
      yield* Batch.write([Devices.put(small[0]!), Devices.put(big[0]!)])
      yield* Transaction.transactWrite([Devices.put(small[1]!), Devices.put(big[1]!)])
      expectSharded(table, [big[0]!, big[1]!])
      expectUnsharded(table, [small[0]!, small[1]!])
    }).pipe(Effect.provide(under(table, layoutsOf())))
  })

  it.effect("a bound builder in a transaction composes with its binding's table", () => {
    const table = makeTable()
    return Effect.gen(function* () {
      // Bound where T-BIG is at 8; the transaction runs where it is at 4.
      const db = yield* bound.pipe(Effect.provide(under(table, layoutsOf(8))))
      yield* Transaction.transactWrite([db.entities.Devices.put(big[0]!)]).pipe(
        Effect.provide(under(table, layoutsOf(4))),
      )
      expectSharded(table, [big[0]!])
    })
  })

  it.effect("unbound Entity.query resolves at the terminal: collect, explain, asParams", () => {
    const table = makeTable()
    // Built where no table is known: resolved when a terminal runs.
    const query = Devices.query.byTenant({ tenantId: "T-BIG" })
    return Effect.gen(function* () {
      yield* Batch.write(big.map((item) => Devices.put(item)))
      const rows: ReadonlyArray<any> = yield* Query.collect(query)
      expect(ids(rows)).toEqual(ids(big))
      const explained = yield* Query.explain(query)
      expect(explained.shards?.count).toBe(8)
      expect(explained.fanOut?.partitions).toHaveLength(8)
      const params = yield* Query.asParams(query)
      expect(JSON.stringify(params)).toContain("#!8.")
      // `.within()` is refused at the call: the index is sharded for every value.
      expect(() =>
        Query.refuseShardedPlan(Devices.query.byTenant({ tenantId: "t-small" }) as any),
      ).toThrow("[EDD-9104]")
    }).pipe(Effect.provide(under(table, layoutsOf())))
  })

  it.effect("unbound Collection.make queries resolve at the terminal", () => {
    const table = makeTable()
    const Fleet = Collection.make("fleet", { Devices })
    return Effect.gen(function* () {
      yield* Batch.write(big.map((item) => Devices.put(item)))
      const rows: ReadonlyArray<any> = yield* Fleet.query({ tenantId: "t-big" }).pipe(Query.collect)
      expect(rows).toHaveLength(big.length)
      const selected: ReadonlyArray<any> = yield* Query.collect(
        Fleet.Devices({ tenantId: "t-big" }) as Query.Query<any>,
      )
      expect(ids(selected)).toEqual(ids(big))
    }).pipe(Effect.provide(under(table, layoutsOf())))
  })

  it.effect("rekey moves a value's rows into the layer's layout", () => {
    const table = makeTable()
    return Effect.gen(function* () {
      // Written while T-BIG was unsharded.
      yield* Effect.gen(function* () {
        const db = yield* bound
        for (const item of big) yield* db.entities.Devices.put(item)
      }).pipe(Effect.provide(under(table, layoutsOf(1))))
      // Then { 8, previous: 1 }: reads stay complete, rekey moves the rows.
      yield* Effect.gen(function* () {
        const db = yield* bound
        expect(ids(yield* db.entities.Devices.byTenant({ tenantId: "t-big" }).collect())).toEqual(
          ids(big),
        )
        const dry: Table.RekeyReport = yield* db.tables.MainTable.rekey({ dryRun: true })
        expect(dry.indexKeysRewritten).toBe(big.length)
        yield* db.tables.MainTable.rekey()
      }).pipe(Effect.provide(under(table, layoutsOf({ count: 8, previous: 1 }))))
      expectSharded(table, big)
      // Then 8: nothing left to move.
      yield* Effect.gen(function* () {
        const db = yield* bound
        const settled: Table.RekeyReport = yield* db.tables.MainTable.rekey({ dryRun: true })
        expect(settled.indexKeysRewritten).toBe(0)
        expect(ids(yield* db.entities.Devices.byTenant({ tenantId: "t-big" }).collect())).toEqual(
          ids(big),
        )
      }).pipe(Effect.provide(under(table, layoutsOf(8))))
    })
  })
})

describe("a bound builder composes with its binding's table on every multi-item path", () => {
  // Versioned with history, unique and soft-deleted: `transactWrite` guards its put, and plans
  // its update and its delete, from reads. Its index holds the version, so a put over a stored
  // row composes its keys again with the version it continues.
  class Asset extends Schema.Class<Asset>("Asset")({
    assetId: Schema.String,
    serial: Schema.String,
    tenantId: Schema.String,
    note: Schema.String,
    version: Schema.Number,
  }) {}
  const Assets = Entity.make({
    model: Asset,
    entityType: "Asset",
    primaryKey: {
      pk: { field: "pk", composite: ["assetId"] },
      sk: { field: "sk", composite: [] },
    },
    indexes: {
      byTenant: {
        name: "gsi5",
        pk: { field: "gsi5pk", composite: ["tenantId"] },
        sk: { field: "gsi5sk", composite: ["assetId", "version"] },
        shards: { by: ["assetId"], layouts: "provided" },
      },
    },
    versioned: { retain: true },
    softDelete: true,
    unique: { serial: ["serial"] },
  })
  const AssetTable = Table.make({ schema, entities: { Assets } })
  const asset = (i: number, tenantId: string) => ({
    assetId: `asset-${i}`,
    serial: `serial-${i}`,
    tenantId,
    note: "new",
  })
  const Log = EventStore.makeStream({
    table: MainTable,
    streamName: "Log",
    events: [Schema.TaggedStruct("Logged", { note: Schema.String })],
    streamId: { composite: ["id"] },
  } as never) as any
  const keyOf = (item: ReturnType<typeof device>) => ({
    channel: item.channel,
    deviceId: item.deviceId,
  })
  const tables = (table: Recording) =>
    Layer.mergeAll(table.layer, MainTable.layer({ name: "t" }), AssetTable.layer({ name: "t" }))
  const layouts = (layout: number) =>
    ShardLayouts.layer([
      ShardLayouts.of(Devices, { byTenant: hot(layout) }),
      ShardLayouts.of(Assets, { byTenant: hot(layout) }),
    ])
  /** The live rows of one item: version snapshots and tombstones hold no index key. */
  const indexPksOf = (table: Recording, attribute: string, value: string) =>
    [...table.items.values()]
      .filter((row) => row[attribute]?.S === value && row.gsi5pk !== undefined)
      .map((row) => row.gsi5pk!.S)
  const atEight = /#!8\.\d#tenantid_t-big$/
  const bindBoth = DynamoClient.make({
    entities: { Devices, Assets },
    tables: { MainTable, AssetTable },
  })

  // The caller's context: no `ShardLayouts` at all, or one where T-BIG is at 4. Bound where it
  // is at 8, the builder composes at 8 either way.
  for (const [label, caller] of [
    ["no ShardLayouts layer", null],
    ["another table", 4],
  ] as const) {
    const scenario = (
      body: (
        db: Effect.Success<typeof bindBoth>,
        run: <A, E>(effect: Effect.Effect<A, E, any>) => Effect.Effect<A, E>,
        table: Recording,
      ) => Effect.Effect<void, unknown>,
    ) => {
      const table = makeTable()
      return Effect.gen(function* () {
        const db = yield* bindBoth.pipe(Effect.provide(Layer.merge(tables(table), layouts(8))))
        const callerLayer =
          caller === null ? tables(table) : Layer.merge(tables(table), layouts(caller))
        yield* body(
          db,
          (effect) => effect.pipe(Effect.provide(callerLayer)) as Effect.Effect<any, any>,
          table,
        )
      })
    }
    it.effect(`transactWrite: put, create, update, patch and delete (${label})`, () =>
      scenario((db, run, table) =>
        Effect.gen(function* () {
          yield* run(
            Transaction.transactWrite([
              db.entities.Devices.put(big[0]!),
              db.entities.Devices.create(big[1]!),
            ]),
          )
          expectSharded(table, [big[0]!, big[1]!])
          // Two cold rows, moved to T-BIG by an update and a patch the transaction plans.
          yield* db.entities.Devices.put(small[0]!)
          yield* db.entities.Devices.put(small[1]!)
          yield* run(
            Transaction.transactWrite([
              db.entities.Devices.update(keyOf(small[0]!)).set({
                tenantId: "T-BIG",
                groupId: small[0]!.groupId,
              }),
              db.entities.Devices.patch(keyOf(small[1]!)).set({
                tenantId: "t-big",
                groupId: small[1]!.groupId,
              }),
            ]),
          )
          expectSharded(table, [small[0]!, small[1]!])
          yield* run(Transaction.transactWrite([db.entities.Devices.delete(keyOf(big[0]!))]))
          expect(indexPkOf(table, big[0]!.deviceId)).toBeUndefined()
          expect(ids(yield* db.entities.Devices.byTenant({ tenantId: "t-big" }).collect())).toEqual(
            ids([big[1]!, small[0]!, small[1]!]),
          )
        }),
      ),
    )

    it.effect(`transactWrite: a guarded put, a planned update and delete (${label})`, () =>
      scenario((db, run, table) =>
        Effect.gen(function* () {
          yield* db.entities.Assets.put(asset(1, "t-small"))
          // Over the stored row: its version continued, its keys composed again.
          yield* run(Transaction.transactWrite([db.entities.Assets.put(asset(1, "T-BIG"))]))
          yield* run(Transaction.transactWrite([db.entities.Assets.create(asset(2, "t-small"))]))
          yield* run(
            Transaction.transactWrite([
              db.entities.Assets.update({ assetId: "asset-2" }).set({
                tenantId: "T-BIG",
                note: "moved",
              }),
            ]),
          )
          for (const id of ["asset-1", "asset-2"]) {
            const pks = indexPksOf(table, "assetId", id)
            expect(pks).toHaveLength(1)
            expect(pks[0]).toMatch(atEight)
          }
          yield* run(Transaction.transactWrite([db.entities.Assets.delete({ assetId: "asset-1" })]))
          expect(indexPksOf(table, "assetId", "asset-1")).toHaveLength(0)
          const found = yield* db.entities.Assets.byTenant({ tenantId: "t-big" }).collect()
          expect(found.map((row) => row.assetId)).toEqual(["asset-2"])
        }),
      ),
    )

    it.effect(`EventStore.append({ additionalItems }) (${label})`, () =>
      scenario((db, run, table) =>
        Effect.gen(function* () {
          yield* db.entities.Devices.put(big[1]!)
          yield* run(
            Log.append({ id: "log" }, [{ _tag: "Logged", note: "x" }], 0, {
              additionalItems: [
                db.entities.Devices.put(big[0]!),
                db.entities.Devices.create(big[2]!),
                db.entities.Devices.delete(keyOf(big[1]!)),
                db.entities.Assets.put(asset(1, "T-BIG")),
              ],
            }) as Effect.Effect<unknown, unknown>,
          )
          expectSharded(table, [big[0]!, big[2]!])
          expect(indexPkOf(table, big[1]!.deviceId)).toBeUndefined()
          expect(indexPksOf(table, "assetId", "asset-1")[0]).toMatch(atEight)
        }),
      ),
    )

    it.effect(`Batch.write and Transaction.check (${label})`, () =>
      scenario((db, run, table) =>
        Effect.gen(function* () {
          yield* db.entities.Devices.put(big[1]!)
          yield* run(
            Batch.write([
              db.entities.Devices.put(big[0]!),
              db.entities.Devices.delete(keyOf(big[1]!)),
            ]),
          )
          expectSharded(table, [big[0]!])
          expect(indexPkOf(table, big[1]!.deviceId)).toBeUndefined()
          yield* run(
            Transaction.transactWrite([
              Transaction.check(
                db.entities.Devices.get(keyOf(big[0]!)),
                Expression.condition({ attributeExists: "pk" }),
              ),
              db.entities.Devices.put(big[2]!),
            ]),
          )
          expectSharded(table, [big[2]!])
        }),
      ),
    )
  }
})

describe("tables from configuration", () => {
  it.effect("a Config of a typed table", () => {
    const table = makeTable()
    const layer = ShardLayouts.layer([
      ShardLayouts.of(Devices, {
        byTenant: Config.String("BIG_TENANT_ID").pipe(
          Config.map((id) => ({ default: 1, values: [{ match: { tenantId: id }, layout: 8 }] })),
        ),
      }),
    ]).pipe(
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ BIG_TENANT_ID: "t-big" }))),
    )
    return Effect.gen(function* () {
      const db = yield* bound
      yield* db.entities.Devices.put(big[0]!)
      expectSharded(table, [big[0]!])
    }).pipe(Effect.provide(under(table, layer)))
  })

  it.effect("the whole table as one JSON value, through ShardLayouts.Table", () => {
    const table = makeTable()
    const layer = ShardLayouts.layer([
      ShardLayouts.of(Devices, {
        byTenant: Config.schema(Schema.fromJsonString(ShardLayouts.Table), "DEVICE_SHARDS"),
      }),
    ]).pipe(
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            DEVICE_SHARDS: JSON.stringify(hot({ count: 8, previous: 1 })),
          }),
        ),
      ),
    )
    return Effect.gen(function* () {
      const db = yield* bound
      yield* db.entities.Devices.put(big[0]!)
      expectSharded(table, [big[0]!])
      const explained = yield* db.entities.Devices.byTenant({ tenantId: "t-big" }).explain()
      expect(explained.shards).toMatchObject({ count: 8, previous: 1 })
    }).pipe(Effect.provide(under(table, layer)))
  })

  it.effect("a bad JSON table is a ConfigError naming the variable", () =>
    Effect.gen(function* () {
      const layer = ShardLayouts.layer([
        ShardLayouts.of(Devices, {
          byTenant: Config.schema(Schema.fromJsonString(ShardLayouts.Table), "DEVICE_SHARDS"),
        }),
      ]).pipe(
        Layer.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({ DEVICE_SHARDS: JSON.stringify({ default: 0 }) }),
          ),
        ),
      )
      const exit = yield* Effect.exit(Layer.build(layer).pipe(Effect.scoped))
      expect(Exit.isFailure(exit)).toBe(true)
      expect(defectOf(exit)).toContain("DEVICE_SHARDS")
    }),
  )

  it.effect("a JSON table with a key it doesn't declare is a ConfigError naming the key", () =>
    Effect.gen(function* () {
      for (const table of [
        { ...hot({ count: 8, previous: 1 }), defualt: 2 },
        hot({ count: 8, previuos: 1 } as never),
        { default: 1, values: [{ match: { tenantId: "T-BIG" }, layout: 8, layuot: 4 }] },
      ]) {
        const layer = ShardLayouts.layer([
          ShardLayouts.of(Devices, {
            byTenant: Config.schema(Schema.fromJsonString(ShardLayouts.Table), "DEVICE_SHARDS"),
          }),
        ]).pipe(
          Layer.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({ DEVICE_SHARDS: JSON.stringify(table) }),
            ),
          ),
        )
        const exit = yield* Effect.exit(Layer.build(layer).pipe(Effect.scoped))
        expect(Exit.isFailure(exit)).toBe(true)
        expect(defectOf(exit)).toContain("DEVICE_SHARDS")
        expect(defectOf(exit)).toMatch(/defualt|previuos|layuot/)
      }
    }),
  )

  it.effect("layerEffect: a table loaded at startup", () => {
    const table = makeTable()
    const layer = ShardLayouts.layerEffect(
      Effect.succeed([ShardLayouts.of(Devices, { byTenant: hot() })]),
    )
    return Effect.gen(function* () {
      const db = yield* bound
      yield* db.entities.Devices.put(big[0]!)
      expectSharded(table, [big[0]!])
    }).pipe(Effect.provide(under(table, layer)))
  })

  it.effect("a failing layerEffect stops the program before it runs", () =>
    Effect.gen(function* () {
      let ran = false
      const layer = ShardLayouts.layerEffect(Effect.fail("config item unreadable" as const))
      const exit = yield* Effect.exit(
        Effect.sync(() => {
          ran = true
        }).pipe(Effect.provide(layer)),
      )
      expect(ran).toBe(false)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(defectOf(exit)).toContain("config item unreadable")
    }),
  )
})

describe("a missing table is EDD-9181, and nothing is sent", () => {
  it.effect("DynamoClient.make names the entity and index", () => {
    const table = makeTable()
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(bound)
      expect(defectOf(exit)).toContain("[EDD-9181]")
      expect(defectOf(exit)).toContain("Device.byTenant")
      expect(table.requests).toHaveLength(0)
    }).pipe(Effect.provide(under(table, null)))
  })

  it.effect("each unbound write path, before anything is sent", () => {
    const table = makeTable()
    return Effect.gen(function* () {
      for (const run of [
        Batch.write([Devices.put(small[0]!)]),
        Transaction.transactWrite([Devices.put(small[0]!)]),
        Devices.put(small[0]!).asEffect(),
        Devices.update({ channel: "channel-0", deviceId: "device-00" })
          .pipe(Entity.set({ groupId: "group-b" }))
          .asEffect(),
        Devices.delete({ channel: "channel-0", deviceId: "device-00" }).asEffect(),
      ] as ReadonlyArray<Effect.Effect<unknown, unknown, any>>) {
        const exit = yield* Effect.exit(run)
        expect(defectOf(exit)).toContain("[EDD-9181]")
        expect(defectOf(exit)).toContain("Device.byTenant")
      }
      // A put without the `by` value composes no entry: still refused.
      expect(table.requests).toHaveLength(0)
    }).pipe(Effect.provide(under(table, null)))
  })

  it.effect("writes that compose no provided key: transactWrite, Batch.write, append", () => {
    class Sensor extends Schema.Class<Sensor>("Sensor")({
      sensorId: Schema.String,
      siteId: Schema.String,
      seq: Schema.Number,
      value: Schema.Number,
    }) {}
    const Sensors = Entity.make({
      model: Sensor,
      entityType: "Sensor",
      primaryKey: {
        pk: { field: "pk", composite: ["sensorId"] },
        sk: { field: "sk", composite: [] },
      },
      indexes: {
        bySite: {
          name: "gsi5",
          pk: { field: "gsi5pk", composite: ["siteId"] },
          sk: { field: "gsi5sk", composite: ["sensorId"] },
          shards: { layouts: "provided" },
        },
      },
      timeSeries: {
        orderBy: "seq",
        appendInput: Schema.Struct({
          sensorId: Schema.String,
          seq: Schema.Number,
          value: Schema.Number,
        }),
      },
    })
    const Sensing = Table.make({ schema, entities: { Sensors } })
    const table = makeTable()
    const key = { sensorId: "s-1" }
    return Effect.gen(function* () {
      for (const run of [
        // An update that touches no attribute of the provided index, planned by the transaction.
        Transaction.transactWrite([Sensors.update(key).pipe(Entity.set({ value: 2 }))]),
        Transaction.transactWrite([Sensors.delete(key)]),
        Batch.write([Sensors.delete(key)]),
        Sensors.append({ sensorId: "s-1", seq: 2, value: 2 }),
      ] as ReadonlyArray<Effect.Effect<unknown, unknown, any>>) {
        const exit = yield* Effect.exit(run)
        expect(defectOf(exit)).toContain("[EDD-9181]")
        expect(defectOf(exit)).toContain("Sensor.bySite")
      }
      expect(table.requests).toHaveLength(0)
    }).pipe(Effect.provide(Layer.merge(table.layer, Sensing.layer({ name: "t" }))))
  })

  it.effect("restore and purge, before anything is read; a read of the primary key runs", () => {
    class Badge extends Schema.Class<Badge>("Badge")({
      badgeId: Schema.String,
      tenantId: Schema.optionalKey(Schema.String),
    }) {}
    const Badges = Entity.make({
      model: Badge,
      entityType: "Badge",
      primaryKey: {
        pk: { field: "pk", composite: ["badgeId"] },
        sk: { field: "sk", composite: [] },
      },
      indexes: {
        byTenant: {
          name: "gsi5",
          pk: { field: "gsi5pk", composite: ["tenantId"] },
          sk: { field: "gsi5sk", composite: ["badgeId"] },
          shards: { layouts: "provided" },
        },
      },
      softDelete: true,
    })
    const BadgeTable = Table.make({ schema, entities: { Badges } })
    const table = makeTable()
    const base = Layer.merge(table.layer, BadgeTable.layer({ name: "t" }))
    const key = { badgeId: "b-1" }
    return Effect.gen(function* () {
      // Written and soft-deleted where the table is known. It has no tenant, so its restore
      // would compose no key of the provided index: refused all the same.
      yield* Effect.gen(function* () {
        const db = yield* DynamoClient.make({ entities: { Badges }, tables: { BadgeTable } })
        yield* db.entities.Badges.put({ badgeId: "b-1" })
        yield* db.entities.Badges.delete(key)
      }).pipe(
        Effect.provide(
          Layer.merge(
            base,
            ShardLayouts.layer([ShardLayouts.of(Badges, { byTenant: { default: 1 } })]),
          ),
        ),
      )
      table.requests.length = 0
      for (const run of [Badges.restore(key).asEffect(), Badges.purge(key).asEffect()]) {
        const exit = yield* Effect.exit(run as Effect.Effect<unknown, unknown, any>)
        expect(defectOf(exit)).toContain("[EDD-9181]")
        expect(defectOf(exit)).toContain("Badge.byTenant")
      }
      expect(table.requests).toHaveLength(0)
      // Reading the tombstone composes the primary key alone: no table needed.
      const tombstone = yield* Badges.deleted.get(key).asEffect()
      expect(tombstone.badgeId).toBe("b-1")
    }).pipe(Effect.provide(base))
  })

  it.effect("an unbound query dies at its terminal, explain and asParams", () => {
    const table = makeTable()
    const query = Devices.query.byTenant({ tenantId: "t-big" })
    return Effect.gen(function* () {
      for (const run of [Query.collect(query), Query.explain(query), Query.asParams(query)]) {
        const exit = yield* Effect.exit(run as Effect.Effect<unknown, unknown, any>)
        expect(defectOf(exit)).toContain("[EDD-9181]")
      }
      expect(table.requests).toHaveLength(0)
    }).pipe(Effect.provide(under(table, null)))
  })

  it.effect("a key-text refusal on a deferred query stays a ValidationError", () => {
    const table = makeTable()
    // A tenant id with no key text (NaN) is refused where the key is composed.
    const query = Devices.query.byTenant({ tenantId: Number.NaN as unknown as string })
    return Effect.gen(function* () {
      const failed = yield* Effect.flip(Query.collect(query) as Effect.Effect<unknown, any, any>)
      expect(failed._tag).toBe("ValidationError")
      const explained = yield* Query.explain(query)
      expect(explained.plan).toBe("empty")
      expect(table.requests).toHaveLength(0)
    }).pipe(Effect.provide(under(table, layoutsOf())))
  })

  it.effect("an unbound Collection.make query dies at its terminal", () => {
    const table = makeTable()
    const Fleet = Collection.make("fleet", { Devices })
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        Fleet.query({ tenantId: "t-big" }).pipe(Query.collect) as Effect.Effect<unknown, unknown>,
      )
      expect(defectOf(exit)).toContain("[EDD-9181]")
      expect(table.requests).toHaveLength(0)
    }).pipe(Effect.provide(under(table, null)))
  })

  it.effect("rekey fails before the scan", () => {
    const table = makeTable()
    return Effect.gen(function* () {
      // The client is bound where a table is supplied; its rekey runs under that binding.
      const db = yield* bound.pipe(Effect.provide(under(table, layoutsOf())))
      expect(table.requests).toHaveLength(0)
      const report = yield* db.tables.MainTable.rekey({ dryRun: true })
      expect(report.indexKeysRewritten).toBe(0)
      // An entity on the table the client didn't bind, with no table supplied anywhere.
      const Others = Entity.make({
        model: Device,
        entityType: "OtherDevice",
        primaryKey: {
          pk: { field: "pk", composite: ["channel"] },
          sk: { field: "sk", composite: ["deviceId"] },
        },
        indexes: {
          byTenant: {
            name: "gsi5",
            pk: { field: "gsi5pk", composite: ["tenantId"] },
            sk: { field: "gsi5sk", composite: ["deviceId"] },
            shards: { layouts: "provided" },
          },
        },
      })
      const Plain = Entity.make({
        model: Device,
        entityType: "PlainDevice",
        primaryKey: {
          pk: { field: "pk", composite: ["channel"] },
          sk: { field: "sk", composite: ["deviceId"] },
        },
      })
      const Both = Table.make({ schema, entities: { Plain, Others } })
      const sent = table.requests.length
      const exit = yield* Effect.exit(
        Effect.gen(function* () {
          const client = yield* DynamoClient.make({ entities: { Plain }, tables: { Both } })
          return yield* client.tables.Both.rekey({ dryRun: true })
        }).pipe(
          Effect.provide(Layer.mergeAll(table.layer, Both.layer({ name: "t" }), layoutsOf())),
        ),
      )
      expect(defectOf(exit)).toContain("[EDD-9181]")
      expect(defectOf(exit)).toContain("OtherDevice.byTenant")
      expect(table.requests.length).toBe(sent)
    })
  })
})

describe("building a layer", () => {
  const built = (layer: Layer.Layer<ShardLayouts.ShardLayouts, any>) =>
    Effect.exit(Layer.build(layer).pipe(Effect.scoped))

  it.effect("a malformed table is EDD-9099 when the layer is built", () =>
    Effect.gen(function* () {
      for (const byTenant of [
        { default: 0 },
        { default: 1, values: [{ match: { tenantId: "a" }, layout: { count: 4, previous: 4 } }] },
        { default: 1, values: [{ match: { tenantID: "a" }, layout: 4 }] },
        {
          default: 1,
          values: [
            { match: { tenantId: "T-BIG" }, layout: 4 },
            { match: { tenantId: "t-big" }, layout: 8 },
          ],
        },
      ]) {
        const exit = yield* built(
          ShardLayouts.layer([ShardLayouts.of(Devices, { byTenant } as any)]),
        )
        expect(defectOf(exit)).toContain("[EDD-9099]")
      }
    }),
  )

  it.effect("misusing of() is EDD-9182", () =>
    Effect.gen(function* () {
      const Loose = Entity.make({
        model: Device,
        entityType: "Loose",
        primaryKey: {
          pk: { field: "pk", composite: ["channel"] },
          sk: { field: "sk", composite: ["deviceId"] },
        },
        indexes: {
          byTenant: {
            name: "gsi5",
            pk: { field: "gsi5pk", composite: ["tenantId"] },
            sk: { field: "gsi5sk", composite: ["deviceId"] },
            shards: { layouts: "provided" },
          },
        },
      })
      for (const entries of [
        [ShardLayouts.of(Devices, { byTenant: hot(), byGroup: hot() } as any)],
        [ShardLayouts.of(Devices, { byTenant: hot(), nope: hot() } as any)],
        [ShardLayouts.of(Devices, {} as any)],
        [
          ShardLayouts.of(Devices, { byTenant: hot() }),
          ShardLayouts.of(Devices, { byTenant: hot() }),
        ],
        // Registered on no table.
        [ShardLayouts.of(Loose, { byTenant: hot() })],
      ]) {
        const exit = yield* built(ShardLayouts.layer(entries))
        expect(defectOf(exit)).toContain("[EDD-9182]")
      }
    }),
  )
})

describe("collections over a provided index", () => {
  class Task extends Schema.Class<Task>("Task")({
    task: Schema.String,
    employee: Schema.String,
  }) {}
  class Employee extends Schema.Class<Employee>("Employee")({
    employee: Schema.String,
    office: Schema.String,
  }) {}
  const member = (model: any, entityType: string, key: string) =>
    Entity.make({
      model,
      entityType,
      primaryKey: {
        pk: { field: "pk", composite: [key] },
        sk: { field: "sk", composite: [] },
      },
      indexes: {
        assignments: {
          collection: "assignments",
          name: "gsi1",
          pk: { field: "gsi1pk", composite: ["employee"] },
          sk: { field: "gsi1sk", composite: [key] },
          shards: { layouts: "provided" },
        },
      },
    } as any) as any
  const Tasks = member(Task, "Task", "task")
  const Employees = member(Employee, "Employee", "office")
  const People = Table.make({ schema, entities: { Tasks, Employees } })
  const dana = (layout: number) => ({
    default: 1,
    values: [{ match: { employee: "dana" }, layout }],
  })
  const layers = (tasks: number, employees: number) =>
    Layer.mergeAll(
      makeRecordingTable({ indexes: { gsi1: { pk: "gsi1pk", sk: "gsi1sk" } } }).layer,
      People.layer({ name: "t" }),
      ShardLayouts.layer([
        ShardLayouts.of(Tasks, { assignments: dana(tasks) }),
        ShardLayouts.of(Employees, { assignments: dana(employees) }),
      ]),
    )
  const bind = DynamoClient.make({ entities: { Tasks, Employees }, tables: { People } })

  it.effect("tables applied at bind are compared by content (EDD-9103)", () =>
    Effect.gen(function* () {
      yield* bind.pipe(Effect.provide(layers(4, 4)))
      const exit = yield* Effect.exit(bind.pipe(Effect.provide(layers(4, 8))))
      expect(defectOf(exit)).toContain("[EDD-9103]")
    }),
  )

  it.effect("an unbound collection compares them when its query resolves", () =>
    Effect.gen(function* () {
      const Assignments = Collection.make("assignments", { Tasks, Employees })
      const agreeing: ReadonlyArray<unknown> = yield* Assignments.query({ employee: "dana" }).pipe(
        Query.collect,
        Effect.provide(layers(4, 4)),
      ) as unknown as Effect.Effect<ReadonlyArray<unknown>>
      expect(agreeing).toHaveLength(0)
      const exit = yield* Effect.exit(
        Assignments.query({ employee: "dana" }).pipe(
          Query.collect,
          Effect.provide(layers(4, 8)),
        ) as Effect.Effect<unknown>,
      )
      expect(defectOf(exit)).toContain("[EDD-9103]")
    }),
  )

  it.effect("an unbound collection with one member's table missing is EDD-9181", () =>
    Effect.gen(function* () {
      const Assignments = Collection.make("assignments", { Tasks, Employees })
      // The whole collection and each member's selector: one rule for the collection.
      for (const query of [
        Assignments.query({ employee: "dana" }),
        Assignments.Tasks({ employee: "dana" }),
        Assignments.Employees({ employee: "dana" }),
      ]) {
        const recording = makeRecordingTable({
          indexes: { gsi1: { pk: "gsi1pk", sk: "gsi1sk" } },
        })
        const exit = yield* Effect.exit(
          Query.collect(query as Query.Query<unknown>).pipe(
            Effect.provide(
              Layer.mergeAll(
                recording.layer,
                People.layer({ name: "t" }),
                ShardLayouts.layer([ShardLayouts.of(Tasks, { assignments: dana(1) })]),
              ),
            ),
          ) as Effect.Effect<unknown>,
        )
        expect(defectOf(exit)).toContain("[EDD-9181]")
        expect(defectOf(exit)).toContain("Employee.assignments")
        expect(recording.requests).toHaveLength(0)
      }
    }),
  )

  describe("a member that names the collection's index differently", () => {
    // Members name their indexes for their own accessors: only the physical index is shared, so
    // each member's own index for the collection is the one compared.
    const named = (model: any, entityType: string, key: string, indexName: string, shards: any) =>
      Entity.make({
        model,
        entityType,
        primaryKey: {
          pk: { field: "pk", composite: [key] },
          sk: { field: "sk", composite: [] },
        },
        indexes: {
          [indexName]: {
            collection: "assignments",
            name: "gsi1",
            pk: { field: "gsi1pk", composite: ["employee"] },
            sk: { field: "gsi1sk", composite: [key] },
            shards,
          },
        },
      } as any) as any
    const Chores = named(Task, "Chore", "task", "assignments", { layouts: "provided" })
    const Staff = named(Employee, "Staffer", "office", "byEmployee", { layouts: "provided" })
    const Crew = Table.make({ schema, entities: { Chores, Staff } })
    const env = (recording: Recording, chores: number, staff: number) =>
      Layer.mergeAll(
        recording.layer,
        Crew.layer({ name: "t" }),
        ShardLayouts.layer([
          ShardLayouts.of(Chores, { assignments: dana(chores) }),
          ShardLayouts.of(Staff, { byEmployee: dana(staff) }),
        ]),
      )
    const recordingOf = () =>
      makeRecordingTable({ indexes: { gsi1: { pk: "gsi1pk", sk: "gsi1sk" } } }) as Recording
    const seed = Effect.gen(function* () {
      yield* Chores.put({ task: "t-1", employee: "dana" }).asEffect()
      yield* Staff.put({ office: "o-1", employee: "dana" }).asEffect()
    })

    it.effect(
      "an unbound collection: different tables are EDD-9103, equal ones read both",
      () =>
        Effect.gen(function* () {
          const Assignments = Collection.make("assignments", { chores: Chores, staff: Staff })
          const differing = recordingOf()
          const exit = yield* Effect.exit(
            Effect.gen(function* () {
              yield* seed
              return yield* Assignments.query({ employee: "dana" }).pipe(Query.collect)
            }).pipe(Effect.provide(env(differing, 1, 8))) as Effect.Effect<unknown>,
          )
          expect(defectOf(exit)).toContain("[EDD-9103]")
          expect(differing.requests.filter((r) => r.command === "Query")).toHaveLength(0)

          const rows = (yield* Effect.gen(function* () {
            yield* seed
            return yield* Assignments.query({ employee: "dana" }).pipe(Query.collect)
          }).pipe(Effect.provide(env(recordingOf(), 8, 8)))) as ReadonlyArray<any>
          expect(rows.map((row) => row._entityKey).sort()).toEqual(["chores", "staff"])
          const staff = (yield* Effect.gen(function* () {
            yield* seed
            return yield* Query.collect(Assignments.staff({ employee: "dana" }) as Query.Query<any>)
          }).pipe(Effect.provide(env(recordingOf(), 8, 8)))) as ReadonlyArray<any>
          expect(staff.map((row) => row.office)).toEqual(["o-1"])
        }) as Effect.Effect<void, unknown>,
    )

    it.effect(
      "a bound collection: different tables fail the bind, equal ones read both",
      () =>
        Effect.gen(function* () {
          const bindCrew = DynamoClient.make({
            entities: { chores: Chores, staff: Staff },
            tables: { Crew },
          })
          const exit = yield* Effect.exit(bindCrew.pipe(Effect.provide(env(recordingOf(), 1, 8))))
          expect(defectOf(exit)).toContain("[EDD-9103]")

          const found = (yield* Effect.gen(function* () {
            const db = yield* bindCrew
            yield* seed
            return yield* (db.collections as any).assignments({ employee: "dana" }).collect()
          }).pipe(Effect.provide(env(recordingOf(), 8, 8)))) as any
          expect(found.chores.map((row: any) => row.task)).toEqual(["t-1"])
          expect(found.staff.map((row: any) => row.office)).toEqual(["o-1"])
        }) as Effect.Effect<void, unknown>,
    )

    it("declared tables are compared when the collection is made", () => {
      const DeclaredChores = named(Task, "DeclaredChore", "task", "assignments", {
        layouts: { default: 1 },
      })
      const DeclaredStaff = named(Employee, "DeclaredStaffer", "office", "byEmployee", {
        layouts: { default: 8 },
      })
      Table.make({ schema, entities: { DeclaredChores, DeclaredStaff } })
      expect(() =>
        Collection.make("assignments", { chores: DeclaredChores, staff: DeclaredStaff }),
      ).toThrow("[EDD-9103]")
    })
  })
})

describe("paths that compose without a bound client", () => {
  const Log = EventStore.makeStream({
    table: MainTable,
    streamName: "Log",
    events: [Schema.TaggedStruct("Logged", { note: Schema.String })],
    streamId: { composite: ["id"] },
  } as never) as any
  const appendWith = (item: ReturnType<typeof device>) =>
    Log.append({ id: "log" }, [{ _tag: "Logged", note: "x" }], 0, {
      additionalItems: [Devices.put(item)],
    }) as Effect.Effect<unknown, unknown>

  it.effect("EventStore.append({ additionalItems }) puts with the context's table", () => {
    const table = makeTable()
    return Effect.gen(function* () {
      yield* appendWith(big[0]!)
      expectSharded(table, [big[0]!])
    }).pipe(Effect.provide(under(table, layoutsOf())))
  })

  it.effect("EventStore.append({ additionalItems }) without a table writes nothing", () => {
    const table = makeTable()
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(appendWith(big[0]!))
      expect(defectOf(exit)).toContain("[EDD-9181]")
      expect(table.requests.filter((r) => r.command === "TransactWriteItems")).toHaveLength(0)
      expect(table.items.size).toBe(0)
    }).pipe(Effect.provide(under(table, null)))
  })

  describe("a cascade's targets are checked before the update writes", () => {
    class Player extends Schema.Class<Player>("Player")({
      playerId: Schema.String.pipe(DynamoModel.identifier),
      displayName: Schema.String,
    }) {}
    class Selection extends Schema.Class<Selection>("Selection")({
      selectionId: Schema.String,
      player: Player.pipe(DynamoModel.ref),
      role: Schema.String,
    }) {}
    const Players: any = Entity.make({
      model: Player,
      entityType: "Player",
      primaryKey: {
        pk: { field: "pk", composite: ["playerId"] },
        sk: { field: "sk", composite: [] },
      },
    } as any)
    const Selections: any = Entity.make({
      model: Selection,
      entityType: "Selection",
      primaryKey: {
        pk: { field: "pk", composite: ["selectionId"] },
        sk: { field: "sk", composite: [] },
      },
      indexes: {
        byPlayer: {
          name: "gsi2",
          pk: { field: "gsi2pk", composite: ["playerId"] },
          sk: { field: "gsi2sk", composite: ["selectionId"] },
          shards: { layouts: "provided" },
        },
      },
      refs: { player: { entity: Players } },
    } as any)
    const Sports = Table.make({ schema, entities: { Players, Selections } })
    const player = { playerId: "p-1", displayName: "Old" }
    const seeded = () => {
      const table = makeRecordingTable({ indexes: { gsi2: { pk: "gsi2pk", sk: "gsi2sk" } } })
      table.items.set(
        "$fleet-db#v1#player#playerid_p-1|$fleet-db#v1#player",
        toAttributeMap({
          ...player,
          pk: "$fleet-db#v1#player#playerid_p-1",
          sk: "$fleet-db#v1#player",
          __edd_e__: "Player",
        }),
      )
      return table
    }
    const rename = Players.update({ playerId: "p-1" }).pipe(
      Entity.set({ displayName: "New" }),
      Entity.cascade({ targets: [Selections] }),
      Entity.asModel,
    ) as Effect.Effect<unknown, unknown, any>

    it.effect("missing: EDD-9181, and the source row is not written", () => {
      const table = seeded()
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(rename)
        expect(defectOf(exit)).toContain("[EDD-9181]")
        expect(defectOf(exit)).toContain("Selection.byPlayer")
        expect(table.requests).toHaveLength(0)
      }).pipe(Effect.provide(Layer.merge(table.layer, Sports.layer({ name: "t" }))))
    })

    it.effect("supplied: the cascade reads the target's partitions in its layout", () => {
      const table = seeded()
      return Effect.gen(function* () {
        yield* rename
        const queried = table.requests.filter((r) => r.command === "Query")
        expect(queried).toHaveLength(4)
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            table.layer,
            Sports.layer({ name: "t" }),
            ShardLayouts.layer([
              ShardLayouts.of(Selections, {
                byPlayer: { default: 1, values: [{ match: { playerId: "p-1" }, layout: 4 }] },
              }),
            ]),
          ),
        ),
      )
    })
  })
})

describe("an entity with no provided index reads nothing (design §16.1)", () => {
  const Plain = Entity.make({
    model: Device,
    entityType: "Plain",
    primaryKey: {
      pk: { field: "pk", composite: ["channel"] },
      sk: { field: "sk", composite: ["deviceId"] },
    },
    indexes: {
      byGroup: {
        name: "gsi6",
        pk: { field: "gsi6pk", composite: ["groupId"] },
        sk: { field: "gsi6sk", composite: ["deviceId"] },
        shards: 4,
      },
    },
  })
  const PlainTable = Table.make({ schema, entities: { Plain } })
  const run = (layouts: Layer.Layer<ShardLayouts.ShardLayouts, any> | null) => {
    const table = makeTable()
    const base = Layer.merge(table.layer, PlainTable.layer({ name: "t" }))
    return Effect.gen(function* () {
      const db = yield* DynamoClient.make({ entities: { Plain }, tables: { PlainTable } })
      yield* db.entities.Plain.put(small[0]!)
      yield* db.entities.Plain.update({
        channel: small[0]!.channel,
        deviceId: small[0]!.deviceId,
      }).set({ groupId: "group-b" })
      yield* db.entities.Plain.byGroup({ groupId: "group-b" }).collect()
      yield* Batch.write([Plain.put(small[1]!)])
      yield* Transaction.transactWrite([Plain.put(small[2]!)])
      yield* Query.collect(Plain.query.byGroup({ groupId: "group-a" }))
      yield* db.tables.PlainTable.rekey({ dryRun: true })
      return table.requests
    }).pipe(Effect.provide(layouts === null ? base : Layer.merge(base, layouts)))
  }

  it.effect("the same requests with and without an unrelated ShardLayouts layer", () =>
    Effect.gen(function* () {
      const without = yield* run(null)
      const withLayer = yield* run(layoutsOf())
      expect(withLayer.length).toBeGreaterThan(0)
      expect(JSON.stringify(withLayer)).toBe(JSON.stringify(without))
    }),
  )
})

describe("projection rows read the table of the context they run in", () => {
  class Placed extends Schema.TaggedClass<Placed>()("Placed", { amount: Schema.Number }) {}

  const projectionSchema = DynamoSchema.make({ name: "shop", version: 1 })
  const EventsTable = Table.make({ schema: projectionSchema, entities: {} })
  const Orders = EventStore.makeStream({
    table: EventsTable,
    streamName: "Order",
    events: [Placed],
    streamId: { composite: ["orderId"] },
  })
  const Summary = Schema.Struct({
    orderId: Schema.String,
    region: Schema.String,
    total: Schema.Number,
    version: Schema.Number,
  })
  const Summaries = Entity.make({
    model: Summary,
    entityType: "Summary",
    primaryKey: {
      pk: { field: "pk", composite: ["orderId"] },
      sk: { field: "sk", composite: [] },
    },
    indexes: {
      byRegion: {
        name: "gsi1",
        pk: { field: "gsi1pk", composite: ["region"] },
        sk: { field: "gsi1sk", composite: ["orderId"] },
        shards: { layouts: "provided" },
      },
    },
  })
  const ReadTable = Table.make({ schema: projectionSchema, entities: { Summaries } })
  const Totals = EventStore.projection({
    stream: Orders,
    readModel: Summaries,
    key: (id: { readonly orderId: string }) => ({ orderId: id.orderId }),
    initial: (id: { readonly orderId: string }) => ({
      orderId: id.orderId,
      region: "emea",
      total: 0,
      version: 0,
    }),
    evolve: (state: typeof Summary.Type, event: EventStore.StreamEvent<Placed>) =>
      Effect.succeed({ ...state, total: state.total + event.data.amount }),
    checkpoint: "version" as const,
  })
  const base = Layer.mergeAll(
    InMemoryClient,
    EventsTable.layer({ name: "events" }),
    ReadTable.layer({ name: "read" }),
  )
  const readRows = () =>
    [...store.entries()].filter(([key]) => key.startsWith("read|")).map(([, item]) => item)

  beforeEach(() => resetStore())

  it.effect("supplied: the row carries the value's layout", () =>
    Effect.gen(function* () {
      yield* Orders.append({ orderId: "o-1" }, [new Placed({ amount: 5 })], 0)
      const events = yield* Orders.read({ orderId: "o-1" })
      yield* Totals.apply(events[0]!)
      const rows = readRows()
      expect(rows).toHaveLength(1)
      expect(rows[0]!.gsi1pk?.S).toMatch(/^\$shop#v1#summary#!4\.\d#region_emea$/)
    }).pipe(
      Effect.provide(
        Layer.merge(
          base,
          ShardLayouts.layer([
            ShardLayouts.of(Summaries, {
              byRegion: { default: 1, values: [{ match: { region: "EMEA" }, layout: 4 }] },
            }),
          ]),
        ),
      ),
    ),
  )

  it.effect("missing: EDD-9181, and no row is written", () =>
    Effect.gen(function* () {
      yield* Orders.append({ orderId: "o-1" }, [new Placed({ amount: 5 })], 0)
      const events = yield* Orders.read({ orderId: "o-1" })
      const exit = yield* Effect.exit(Totals.apply(events[0]!))
      expect(defectOf(exit)).toContain("[EDD-9181]")
      expect(readRows()).toHaveLength(0)
    }).pipe(Effect.provide(base)),
  )

  it.effect("missing, over a row with no key of the index: EDD-9181 before the row is read", () => {
    // The row has no region, so writing it composes no key of the provided index.
    const Sparse = Schema.Struct({
      orderId: Schema.String,
      region: Schema.optionalKey(Schema.String),
      total: Schema.Number,
      version: Schema.Number,
    })
    const SparseSummaries = Entity.make({
      model: Sparse,
      entityType: "SparseSummary",
      primaryKey: {
        pk: { field: "pk", composite: ["orderId"] },
        sk: { field: "sk", composite: [] },
      },
      indexes: {
        byRegion: {
          name: "gsi1",
          pk: { field: "gsi1pk", composite: ["region"] },
          sk: { field: "gsi1sk", composite: ["orderId"] },
          shards: { layouts: "provided" },
        },
      },
    })
    const SparseTable = Table.make({ schema: projectionSchema, entities: { SparseSummaries } })
    const SparseTotals = EventStore.projection({
      stream: Orders,
      readModel: SparseSummaries,
      key: (id: { readonly orderId: string }) => ({ orderId: id.orderId }),
      initial: (id: { readonly orderId: string }) => ({
        orderId: id.orderId,
        total: 0,
        version: 0,
      }),
      evolve: (state: typeof Sparse.Type, event: EventStore.StreamEvent<Placed>) =>
        Effect.succeed({ ...state, total: state.total + event.data.amount }),
      checkpoint: "version" as const,
    })
    const sparseBase = Layer.mergeAll(
      InMemoryClient,
      EventsTable.layer({ name: "events" }),
      SparseTable.layer({ name: "read" }),
    )
    return Effect.gen(function* () {
      yield* Orders.append(
        { orderId: "o-1" },
        [new Placed({ amount: 5 }), new Placed({ amount: 7 })],
        0,
      )
      const events = yield* Orders.read({ orderId: "o-1" })
      // The row, written where the table is known.
      yield* SparseTotals.apply(events[0]!).pipe(
        Effect.provide(
          ShardLayouts.layer([ShardLayouts.of(SparseSummaries, { byRegion: { default: 1 } })]),
        ),
      )
      const before = readRows()
      expect(before).toHaveLength(1)
      const reads = calls.getItem + calls.query
      const exit = yield* Effect.exit(SparseTotals.apply(events[1]!))
      expect(defectOf(exit)).toContain("[EDD-9181]")
      expect(defectOf(exit)).toContain("SparseSummary.byRegion")
      expect(calls.getItem + calls.query).toBe(reads)
      expect(readRows()).toEqual(before)
    }).pipe(Effect.provide(sparseBase))
  })
})
