/**
 * Per-value shard layouts (#287, `docs/designs/shard-layouts.md`) against a recording
 * table and a partition mock: writes compose each value's layout on every path; a value
 * at 1 is a plain query, byte-identical to an index without `shards`; rules stay per
 * index; `explain()` reports the resolved layout; cursors across a layout change are
 * refused for that value only; `rekey` judges every row by the sharded rule against its
 * resolved layout.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { describe, expect, it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Effect, Layer, Option, Schema } from "effect"
import * as Batch from "../src/Batch.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Query from "../src/Query.js"
import * as Table from "../src/Table.js"
import * as Transaction from "../src/Transaction.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"
import { makeDevices, prng, randomDevices, TENANT } from "./helpers/ShardedDevices.js"

class Device extends Schema.Class<Device>("Device")({
  channel: Schema.String,
  deviceId: Schema.String,
  tenantId: Schema.optional(Schema.String),
  groupId: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
}) {}

const on = DynamoSchema.make({ name: "fleet-db", version: 1, escapeKeys: true })
const off = DynamoSchema.make({ name: "fleet-db", version: 1 })

const hotTable = (layout: unknown = 8) => ({
  layouts: { default: 1, values: [{ match: { tenantId: "T-BIG" }, layout }] },
})

const declared = (shards?: unknown, schema = on) => {
  const Devices = Entity.make({
    model: Device,
    entityType: "Device",
    primaryKey: {
      pk: { field: "pk", composite: ["channel"] },
      sk: { field: "sk", composite: ["deviceId"] },
    },
    indexes: {
      byTenant: {
        name: "gsi5",
        pk: { field: "gsi5pk", composite: ["tenantId"] },
        sk: { field: "gsi5sk", composite: ["groupId", "deviceId"] },
        ...(shards === undefined ? {} : { shards }),
      },
    },
  } as any) as any
  const MainTable = Table.make({ schema, entities: { Devices } })
  return { Devices, MainTable, schema }
}
type Deployment = ReturnType<typeof declared>

const makeTable = () => makeRecordingTable({ indexes: { gsi5: { pk: "gsi5pk", sk: "gsi5sk" } } })
type Recording = ReturnType<typeof makeTable>

const using = <A, E>(
  deployment: Deployment,
  table: Recording,
  f: (db: any) => Effect.Effect<A, E, any>,
): Effect.Effect<A, E> =>
  Effect.gen(function* () {
    const db = yield* DynamoClient.make({
      entities: { Devices: deployment.Devices },
      tables: { MainTable: deployment.MainTable },
    })
    return yield* f(db)
  }).pipe(
    Effect.provide(Layer.merge(table.layer, deployment.MainTable.layer({ name: "t" }))),
  ) as Effect.Effect<A, E>

const device = (i: number, tenantId: string) => ({
  channel: `channel-${i % 3}`,
  deviceId: `device-${String(i).padStart(2, "0")}`,
  tenantId,
  groupId: i % 2 === 0 ? "group-a" : "group-b",
  status: "on",
})
const small = Array.from({ length: 6 }, (_, i) => device(i, "t-small"))
const big = Array.from({ length: 6 }, (_, i) => device(i + 10, i % 2 === 0 ? "T-BIG" : "t-big"))

const write = (deployment: Deployment, table: Recording, items: ReadonlyArray<unknown>) =>
  using(deployment, table, (db) =>
    Effect.forEach(items, (item) => db.entities.Devices.put(item).asEffect(), { discard: true }),
  )
const indexPkOf = (table: Recording, deviceId: string) =>
  [...table.items.values()].find((row) => row.deviceId?.S === deviceId)?.gsi5pk?.S
const ids = (rows: ReadonlyArray<{ readonly deviceId: string }>) =>
  rows.map((row) => row.deviceId).sort()
const read = (deployment: Deployment, table: Recording, tenantId: string) =>
  using(deployment, table, (db) =>
    db.entities.Devices.byTenant({ tenantId }).collect(),
  ) as Effect.Effect<ReadonlyArray<{ readonly deviceId: string }>>

describe("writes compose each value's layout (design §5)", () => {
  for (const schema of [on, off]) {
    const label = schema.escapeKeys === true ? "escapeKeys on" : "escapeKeys off"
    const deployment = declared(hotTable(), schema)
    const unsharded = declared(undefined, schema)

    it.effect(
      `${label}: put — a value at 1 stores the unsharded key, T-BIG and t-big one layout`,
      () =>
        Effect.gen(function* () {
          const table = makeTable()
          yield* write(deployment, table, [...small, ...big])
          const reference = makeTable()
          yield* write(unsharded, reference, small)
          for (const item of small) {
            expect(indexPkOf(table, item.deviceId)).toBe(indexPkOf(reference, item.deviceId))
          }
          for (const item of big) {
            expect(indexPkOf(table, item.deviceId)).toMatch(/#!8\.\d#tenantid_t-big$/)
          }
          expect(ids(yield* read(deployment, table, "t-big"))).toEqual(ids(big))
          expect(ids(yield* read(deployment, table, "T-BIG"))).toEqual(ids(big))
          expect(ids(yield* read(deployment, table, "t-small"))).toEqual(ids(small))
        }),
    )

    it.effect(`${label}: update moves an item to its new value's layout, and back`, () =>
      Effect.gen(function* () {
        const table = makeTable()
        yield* write(deployment, table, [small[0]!])
        const key = { channel: small[0]!.channel, deviceId: small[0]!.deviceId }
        yield* using(deployment, table, (db) =>
          db.entities.Devices.update(key).set({ tenantId: "T-BIG", groupId: "group-a" }).asEffect(),
        )
        expect(indexPkOf(table, key.deviceId)).toMatch(/#!8\.\d#tenantid_t-big$/)
        yield* using(deployment, table, (db) =>
          db.entities.Devices.update(key)
            .set({ tenantId: "t-small", groupId: "group-a" })
            .asEffect(),
        )
        expect(indexPkOf(table, key.deviceId)).toMatch(/#tenantid_t-small$/)
        expect(indexPkOf(table, key.deviceId)).not.toContain("#!")
      }),
    )

    it.effect(`${label}: Batch.write and Transaction.transactWrite puts`, () =>
      Effect.gen(function* () {
        const table = makeTable()
        yield* using(deployment, table, () =>
          Batch.write([deployment.Devices.put(small[1]!), deployment.Devices.put(big[1]!)]),
        )
        yield* using(deployment, table, () =>
          Transaction.transactWrite([
            deployment.Devices.put(small[2]!),
            deployment.Devices.put(big[2]!),
          ]),
        )
        for (const item of [small[1]!, small[2]!]) {
          expect(indexPkOf(table, item.deviceId)).toMatch(/#tenantid_t-small$/)
          expect(indexPkOf(table, item.deviceId)).not.toContain("#!")
        }
        for (const item of [big[1]!, big[2]!]) {
          expect(indexPkOf(table, item.deviceId)).toMatch(/#!8\.\d#tenantid_t-big$/)
        }
      }),
    )
  }
})

describe("reads (design §6)", () => {
  const items = randomDevices(prng(3), 40)
  const others = items.map((item, i) => ({
    ...item,
    tenantId: "t-hot",
    deviceId: `hot-${String(i).padStart(3, "0")}`,
  }))
  const table = makeDevices({
    shards: { layouts: { default: 1, values: [{ match: { tenantId: "t-hot" }, layout: 4 }] } },
  } as never)
  const plain = makeDevices({ shards: null })

  const serve = <X>(
    on: ReturnType<typeof makeDevices>,
    f: (devices: any, server: any) => Effect.Effect<X, unknown, any>,
  ) => {
    const server = on.serve([...items, ...others])
    return Effect.gen(function* () {
      const devices = yield* on.client
      return yield* f(devices, server)
    }).pipe(Effect.provide(server.layer)) as Effect.Effect<X, unknown>
  }

  it.effect("a value at 1 sends exactly the requests of an index without shards", () =>
    Effect.gen(function* () {
      const sent = (on: ReturnType<typeof makeDevices>) =>
        serve(on, (devices, server) =>
          Effect.gen(function* () {
            yield* devices.byTenant({ tenantId: TENANT }).collect()
            yield* devices.byTenant({ tenantId: TENANT }).limit(5).fetch()
            yield* devices.byTenant({ tenantId: TENANT, groupId: "group-a" }).maxPages(1).collect()
            yield* devices
              .byTenant({ tenantId: TENANT })
              .filter({ status: "on" })
              .limit(3)
              .collect()
            yield* devices.byTenant({ tenantId: TENANT }).count()
            return [...server.inputs]
          }),
        )
      const ofTable = yield* sent(table)
      expect(ofTable).toEqual(yield* sent(plain))
      expect(ofTable.length).toBeGreaterThan(4)
    }),
  )

  it.effect("a value at 1 emits the cursor an unsharded index emits", () =>
    Effect.gen(function* () {
      const cursorOf = (on: ReturnType<typeof makeDevices>) =>
        serve(on, (devices) =>
          Effect.map(devices.byTenant({ tenantId: TENANT }).limit(3).fetch(), (page: any) =>
            Option.getOrThrow(page.cursor),
          ),
        )
      const cursor = yield* cursorOf(table)
      expect(cursor).toBe(yield* cursorOf(plain))
      expect(String(cursor).startsWith("v2.")).toBe(false)
    }),
  )

  it.effect("a value at 4 fans out; each value returns exactly its rows", () =>
    serve(table, (devices, server) =>
      Effect.gen(function* () {
        const hot = yield* devices.byTenant({ tenantId: "t-hot" }).collect()
        expect(hot).toHaveLength(others.length)
        expect(server.inputs).toHaveLength(4)
        server.clear()
        const cold = yield* devices.byTenant({ tenantId: TENANT }).collect()
        expect(cold).toHaveLength(items.length)
        expect(server.inputs).toHaveLength(1)
      }),
    ),
  )

  it.effect("explain() reports the resolved layout and partitions", () =>
    serve(table, (devices) =>
      Effect.gen(function* () {
        const cold = yield* devices.byTenant({ tenantId: TENANT }).explain()
        expect(cold.plan).toBe("key")
        expect(cold.fanOut).toBeUndefined()
        expect(cold.shards).toEqual({
          count: 1,
          previous: undefined,
          partitions: [`$fleet-db#v1#devicestate#tenantid_${TENANT}`],
        })
        const hot = yield* devices.byTenant({ tenantId: "t-hot" }).explain()
        expect(hot.shards?.count).toBe(4)
        expect(hot.shards?.partitions).toHaveLength(4)
        expect(hot.fanOut?.partitions).toEqual(hot.shards?.partitions)
      }),
    ),
  )

  it.effect("explain() on { 4, previous: 1 } and { 1, previous: 4 }", () =>
    Effect.gen(function* () {
      for (const [layout, first] of [
        [{ count: 4, previous: 1 }, /#!4\.0#/],
        [{ count: 1, previous: 4 }, /#tenantid_t-hot$/],
      ] as const) {
        const moving = makeDevices({
          shards: { layouts: { default: 1, values: [{ match: { tenantId: "t-hot" }, layout }] } },
        } as never)
        const explained: any = yield* serve(moving, (devices) =>
          devices.byTenant({ tenantId: "t-hot" }).explain(),
        )
        expect(explained.shards).toMatchObject(layout)
        expect(explained.shards.partitions).toHaveLength(5)
        expect(explained.shards.partitions[0]).toMatch(first)
      }
    }),
  )

  it.effect("a static index reports explain().shards too", () =>
    serve(makeDevices({ shards: 8 }), (devices) =>
      Effect.map(devices.byTenant({ tenantId: TENANT }).explain(), (explained: any) => {
        expect(explained.shards).toMatchObject({ count: 8, previous: undefined })
        expect(explained.shards.partitions).toHaveLength(8)
      }),
    ),
  )

  it.effect(".within() is refused for a value at 1 too (EDD-9104)", () =>
    serve(table, (devices) =>
      Effect.sync(() => {
        expect(() =>
          devices.byTenant({ tenantId: TENANT }).within({ groupId: { eq: "group-a" } }),
        ).toThrow("[EDD-9104]")
        expect(() =>
          devices.byTenant({ tenantId: "t-hot" }).within({ groupId: { eq: "group-a" } }),
        ).toThrow("[EDD-9104]")
        expect(() =>
          Query.plan(table.Devices.query.byTenant({ tenantId: TENANT }), {
            planner: (() => undefined) as never,
            maxSkips: undefined,
          }),
        ).toThrow("[EDD-9104]")
      }),
    ),
  )

  it.effect("an empty plan still sends nothing on a value at 1 (review F3)", () =>
    serve(table, (_devices, server) =>
      Effect.gen(function* () {
        const query = Query.planEmpty(table.Devices.query.byTenant({ tenantId: TENANT }))
        expect(yield* Query.collect(query as any)).toEqual([])
        expect(server.inputs).toHaveLength(0)
      }),
    ),
  )
})

describe("cursors across a value's layout change (decision 10)", () => {
  const items = randomDevices(prng(5), 30)
  const hot = items.map((item, i) => ({ ...item, tenantId: "t-hot", deviceId: `hot-${i}` }))
  const cold = items.map((item, i) => ({ ...item, tenantId: "t-cold", deviceId: `cold-${i}` }))
  /** The table at a step: TENANT's entry changes; t-hot stays at 4, t-cold at 1. */
  const step = (layout: unknown) =>
    makeDevices({
      shards: {
        layouts: {
          default: 1,
          values: [
            { match: { tenantId: "t-hot" }, layout: 4 },
            ...(layout === undefined ? [] : [{ match: { tenantId: TENANT }, layout }]),
          ],
        },
      },
    } as never)
  const steps = [
    step(undefined),
    step({ count: 4, previous: 1 }),
    step(4),
    step({ count: 1, previous: 4 }),
    step(undefined),
  ]
  const run = <X>(
    on: ReturnType<typeof makeDevices>,
    f: (devices: any) => Effect.Effect<X, unknown, any>,
  ) => {
    const server = on.serve([...items, ...hot, ...cold])
    return Effect.gen(function* () {
      return yield* f(yield* on.client)
    }).pipe(Effect.provide(server.layer)) as Effect.Effect<X, unknown>
  }
  const cursorAt = (on: ReturnType<typeof makeDevices>, tenantId: string) =>
    run(on, (devices) =>
      Effect.map(devices.byTenant({ tenantId }).limit(2).fetch(), (page: any) =>
        Option.getOrThrow(page.cursor as Option.Option<string>),
      ),
    )
  const resumed = (on: ReturnType<typeof makeDevices>, tenantId: string, cursor: string) =>
    run(on, (devices) => Effect.result(devices.byTenant({ tenantId }).startFrom(cursor).fetch()))

  it.effect("each step refuses the cursor of the step before, for that value only", () =>
    Effect.gen(function* () {
      for (let i = 1; i < steps.length; i++) {
        const before = steps[i - 1]!
        const after = steps[i]!
        const cursor = yield* cursorAt(before, TENANT)
        const outcome: any = yield* resumed(after, TENANT, cursor)
        expect(outcome._tag, `step ${i}`).toBe("Failure")
        expect(String(outcome.failure.cause ?? outcome.failure.message)).toContain("[EDD-9094]")
        // Values whose entry didn't change keep their cursors: fingerprinted and legacy.
        for (const other of ["t-hot", "t-cold"]) {
          const kept: any = yield* resumed(after, other, yield* cursorAt(before, other))
          expect(kept._tag, `step ${i}, ${other}`).toBe("Success")
        }
      }
    }),
  )
})

describe("rekey per value (design §9)", () => {
  const before = declared({ layouts: { default: 1 } })
  const adopting = declared(hotTable({ count: 8, previous: 1 }))
  const adopted = declared(hotTable(8))
  const leaving = declared(hotTable({ count: 1, previous: 8 }))
  const left = declared({ layouts: { default: 1 } })
  const rekey = (deployment: Deployment, table: Recording, dryRun = false) =>
    using(
      deployment,
      table,
      (db) => db.tables.MainTable.rekey({ dryRun }) as Effect.Effect<Table.RekeyReport>,
    )
  const pks = (table: Recording) =>
    [...table.items.values()].flatMap((row: Record<string, AttributeValue>) =>
      row.gsi5pk?.S === undefined ? [] : [[row.deviceId!.S!, row.gsi5pk.S] as const],
    )

  it.effect("adopting one value moves only its rows; reads stay complete at every step", () =>
    Effect.gen(function* () {
      const table = makeTable()
      yield* write(before, table, [...small, ...big])
      const everyone = { small: ids(small), big: ids(big) }
      const check = (deployment: Deployment) =>
        Effect.gen(function* () {
          expect(ids(yield* read(deployment, table, "t-big"))).toEqual(everyone.big)
          expect(ids(yield* read(deployment, table, "t-small"))).toEqual(everyone.small)
        })
      yield* check(before)
      yield* check(adopting)
      const dry: Table.RekeyReport = yield* rekey(adopting, table, true)
      expect(dry.indexKeysRewritten).toBe(big.length)
      const report: Table.RekeyReport = yield* rekey(adopting, table)
      expect(report.indexKeysRewritten).toBe(big.length)
      expect(report.conflicts).toEqual([])
      yield* check(adopting)
      yield* check(adopted)
      for (const [id, pk] of pks(table)) {
        if (id.startsWith("device-1")) expect(pk).toMatch(/#!8\.\d#tenantid_t-big$/)
        else expect(pk).not.toContain("#!")
      }
      const after: Table.RekeyReport = yield* rekey(adopted, table, true)
      expect(after.indexKeysRewritten).toBe(0)
    }),
  )

  it.effect("un-sharding a value through { count: 1, previous: 8 } and rekey", () =>
    Effect.gen(function* () {
      const table = makeTable()
      yield* write(adopted, table, [...small, ...big])
      expect(pks(table).filter(([, pk]) => pk.includes("#!8."))).toHaveLength(big.length)
      // Under the unsharded rule these rows would be no older format's text, and stay.
      expect(ids(yield* read(leaving, table, "t-big"))).toEqual(ids(big))
      const dry: Table.RekeyReport = yield* rekey(leaving, table, true)
      expect(dry.indexKeysRewritten).toBe(big.length)
      yield* rekey(leaving, table)
      for (const [, pk] of pks(table)) expect(pk).not.toContain("#!")
      expect(ids(yield* read(left, table, "t-big"))).toEqual(ids(big))
      const settled: Table.RekeyReport = yield* rekey(left, table, true)
      expect(settled.indexKeysRewritten).toBe(0)
      expect(settled.conflicts).toEqual([])
    }),
  )

  it.effect("a row whose `by` was cleared is judged against its resolved layout", () =>
    Effect.gen(function* () {
      const withBy = (layouts: unknown) => declared({ by: ["groupId"], ...(layouts as object) })
      const now = withBy(hotTable(8))
      const table = makeTable()
      // Rows written at 8 and at 1, then `groupId` gone from each (as `preserve` leaves them).
      yield* write(now, table, [small[0]!, big[0]!])
      for (const row of table.items.values()) delete (row as Record<string, unknown>).groupId
      const report: Table.RekeyReport = yield* rekey(now, table, true)
      expect(report.conflicts).toEqual([])
      // The same rows judged against the other value's layout are out of place.
      const swapped = withBy({
        layouts: { default: 8, values: [{ match: { tenantId: "T-BIG" }, layout: 1 }] },
      })
      const conflicts: Table.RekeyReport = yield* rekey(swapped, table, true)
      expect(conflicts.conflicts.length).toBeGreaterThan(0)
    }),
  )
})

describe("collections compare tables by content (design §11)", () => {
  class Task extends Schema.Class<Task>("Task")({
    task: Schema.String,
    employee: Schema.String,
  }) {}
  class Employee extends Schema.Class<Employee>("Employee")({
    employee: Schema.String,
    office: Schema.String,
  }) {}
  const member = (model: any, entityType: string, key: string, shards: unknown) =>
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
          ...(shards === undefined ? {} : { shards }),
        },
      },
    } as any) as any
  const table = (shardsA: unknown, shardsB: unknown) => {
    const Tasks = member(Task, "Task", "task", shardsA)
    const Employees = member(Employee, "Employee", "office", shardsB)
    const MainTable = Table.make({ schema: on, entities: { Tasks, Employees } })
    return { Tasks, Employees, MainTable }
  }
  const bind = (made: ReturnType<typeof table>) =>
    DynamoClient.make({
      entities: { Tasks: made.Tasks, Employees: made.Employees },
      tables: { MainTable: made.MainTable },
    }).pipe(Effect.provide(Layer.merge(makeTable().layer, made.MainTable.layer({ name: "t" }))))
  const dana = { layouts: { default: 1, values: [{ match: { employee: "dana" }, layout: 4 }] } }
  const DANA = { layouts: { default: 1, values: [{ match: { employee: "DANA" }, layout: 4 }] } }

  it.effect("equal tables spelled differently agree at DynamoClient.make", () =>
    Effect.gen(function* () {
      const made = table(dana, DANA)
      yield* bind(made)
    }),
  )

  it.effect("different tables, and an unsharded member beside { default: 1 }: EDD-9103", () =>
    Effect.gen(function* () {
      for (const made of [
        table(dana, {
          layouts: { default: 1, values: [{ match: { employee: "ed" }, layout: 4 }] },
        }),
        table({ layouts: { default: 1 } }, undefined),
      ]) {
        const exit = yield* Effect.exit(bind(made))
        expect(String(exit)).toContain("[EDD-9103]")
      }
    }),
  )
})
