/**
 * Shard tables supplied at run time (#287, `docs/designs/shard-layouts.md` §10): an index
 * declared `shards: { layouts: "provided" }` takes its table from a `ShardLayouts` layer.
 * `DynamoClient.make` reads it at bind; every path without a bound client reads it from the
 * context it runs in. A missing table is `EDD-9180`, never a fallback, and nothing is sent.
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
import { toAttributeMap } from "../src/Marshaller.js"
import * as Query from "../src/Query.js"
import * as Table from "../src/Table.js"
import * as Transaction from "../src/Transaction.js"
import { InMemoryClient, resetStore, store } from "./helpers/InMemoryTables.js"
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

describe("a missing table is EDD-9180, and nothing is sent", () => {
  it.effect("DynamoClient.make names the entity and index", () => {
    const table = makeTable()
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(bound)
      expect(defectOf(exit)).toContain("[EDD-9180]")
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
        expect(defectOf(exit)).toContain("[EDD-9180]")
        expect(defectOf(exit)).toContain("Device.byTenant")
      }
      // A put without the `by` value composes no entry: still refused.
      expect(table.requests).toHaveLength(0)
    }).pipe(Effect.provide(under(table, null)))
  })

  it.effect("an unbound query dies at its terminal, explain and asParams", () => {
    const table = makeTable()
    const query = Devices.query.byTenant({ tenantId: "t-big" })
    return Effect.gen(function* () {
      for (const run of [Query.collect(query), Query.explain(query), Query.asParams(query)]) {
        const exit = yield* Effect.exit(run as Effect.Effect<unknown, unknown, any>)
        expect(defectOf(exit)).toContain("[EDD-9180]")
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
      expect(defectOf(exit)).toContain("[EDD-9180]")
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
      expect(defectOf(exit)).toContain("[EDD-9180]")
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

  it.effect("misusing of() is EDD-9181", () =>
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
        expect(defectOf(exit)).toContain("[EDD-9181]")
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
      expect(defectOf(exit)).toContain("[EDD-9180]")
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

    it.effect("missing: EDD-9180, and the source row is not written", () => {
      const table = seeded()
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(rename)
        expect(defectOf(exit)).toContain("[EDD-9180]")
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

  it.effect("missing: EDD-9180, and no row is written", () =>
    Effect.gen(function* () {
      yield* Orders.append({ orderId: "o-1" }, [new Placed({ amount: 5 })], 0)
      const events = yield* Orders.read({ orderId: "o-1" })
      const exit = yield* Effect.exit(Totals.apply(events[0]!))
      expect(defectOf(exit)).toContain("[EDD-9180]")
      expect(readRows()).toHaveLength(0)
    }).pipe(Effect.provide(base)),
  )
})
