/**
 * Adopting sharding (#183, design §9): `rekey` moves a row whose stored key is
 * another layout's, and only the index key attribute; reads with `previous` find
 * each item exactly once through every step. Against a recording table, with rows
 * written by the entity as it was declared before.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { describe, expect, it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import * as KeyText136 from "@effect-dynamodb/schema/internal/KeyText136.js"
import { shardMarker, shardOf } from "@effect-dynamodb/schema/internal/Shards.js"
import * as KeyComposer from "@effect-dynamodb/schema/KeyComposer.js"
import { Effect, Layer, Option, Schema } from "effect"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import { toAttributeMap } from "../src/Marshaller.js"
import * as Table from "../src/Table.js"
import { mockDynamoClientLayer } from "./helpers/MockDynamoClient.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"
import { serveRows } from "./helpers/ShardedDevices.js"

class Device extends Schema.Class<Device>("Device")({
  channel: Schema.String,
  deviceId: Schema.String,
  tenantId: Schema.optional(Schema.String),
  groupId: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
}) {}

const on = DynamoSchema.make({ name: "fleet-db", version: 1 })
const off = DynamoSchema.make({ name: "fleet-db", version: 1, legacyKeys: false })

/** The entity as a deployment declares it: `shards` unset is the unsharded layout. */
const declared = (shards?: number | Record<string, unknown>, schema = on) => {
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
type Recording = ReturnType<typeof makeRecordingTable>

const makeTable = () => makeRecordingTable({ indexes: { gsi5: { pk: "gsi5pk", sk: "gsi5sk" } } })

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

const devices = Array.from({ length: 12 }, (_, i) => ({
  channel: `channel-${i % 3}`,
  deviceId: `device-${String(i).padStart(2, "0")}`,
  tenantId: "t-123",
  groupId: i % 2 === 0 ? "group-a" : "group-b",
  status: "on",
}))

const write = (deployment: Deployment, table: Recording, items = devices) =>
  using(deployment, table, (db) =>
    Effect.forEach(items, (item) => db.entities.Devices.put(item).asEffect(), { discard: true }),
  )

const seeded = (deployment: Deployment) =>
  Effect.gen(function* () {
    const table = makeTable()
    yield* write(deployment, table)
    table.requests.length = 0
    return table
  })

const rekey = (deployment: Deployment, table: Recording, options?: Table.RekeyOptions) =>
  using(
    deployment,
    table,
    (db) => db.tables.MainTable.rekey(options) as Effect.Effect<Table.RekeyReport>,
  )

const indexPks = (table: Recording) =>
  [...table.items.values()].flatMap((row) => row.gsi5pk?.S ?? [])

const updates = (table: Recording) => table.requests.filter((r) => r.command === "UpdateItem")

const ids = (rows: ReadonlyArray<{ readonly deviceId: string }>) =>
  rows.map((row) => row.deviceId).sort()

describe("adopting from an unsharded index", () => {
  const before = declared()
  const during = declared({ count: 8, previous: 1 })
  const after = declared(8)

  it.effect("reads each item once at every step, and leaves no unsharded key", () =>
    Effect.gen(function* () {
      const table = yield* seeded(before)
      const everyone = ids(devices)
      const read = (deployment: Deployment) =>
        using(deployment, table, (db) =>
          db.entities.Devices.byTenant({ tenantId: "t-123" }).collect(),
        ) as Effect.Effect<ReadonlyArray<Device>>

      expect(ids(yield* read(before))).toEqual(everyone)
      // Step 1: deploy with `previous`. Reads hold, and a new write goes sharded.
      expect(ids(yield* read(during))).toEqual(everyone)
      yield* write(during, table, devices.slice(0, 3))
      expect(ids(yield* read(during))).toEqual(everyone)
      expect(indexPks(table).filter((pk) => pk.includes("#!8."))).toHaveLength(3)

      // Step 2: `rekey`.
      const report: Table.RekeyReport = yield* rekey(during, table)
      expect(report.indexKeysRewritten).toBe(9)
      expect(report.conflicts).toEqual([])
      expect(ids(yield* read(during))).toEqual(everyone)
      for (const pk of indexPks(table)) expect(pk).toMatch(/#!8\.\d#tenantid_t-123$/)

      // Step 3: remove `previous`.
      expect(ids(yield* read(after))).toEqual(everyone)
    }),
  )

  it.effect("a row lands exactly where a write of it would", () =>
    Effect.gen(function* () {
      const table = yield* seeded(before)
      yield* rekey(during, table)
      const fresh = makeTable()
      yield* write(during, fresh)
      expect(new Map(table.items)).toEqual(new Map(fresh.items))
    }),
  )

  it.effect("moves only the index key attribute, guarded on the key's inputs", () =>
    Effect.gen(function* () {
      const table = yield* seeded(before)
      yield* rekey(during, table)
      const sent = updates(table)
      expect(sent).toHaveLength(devices.length)
      const input = sent[0]!.input
      expect(input.UpdateExpression).toBe("SET #k0 = :n0")
      expect(input.ExpressionAttributeNames["#k0"]).toBe("gsi5pk")
      expect(input.ConditionExpression).toContain("#k0 = :o0")
      expect(Object.values(input.ExpressionAttributeNames)).toEqual(
        expect.arrayContaining(["tenantId", "channel", "deviceId"]),
      )
      expect(Object.values(input.ExpressionAttributeNames)).not.toContain("status")
    }),
  )

  it.effect("is a no-op on a rerun", () =>
    Effect.gen(function* () {
      const table = yield* seeded(before)
      yield* rekey(during, table)
      const again: Table.RekeyReport = yield* rekey(during, table)
      expect(again.indexKeysRewritten).toBe(0)
      expect(again.unchanged).toBe(devices.length)
    }),
  )

  it.effect("a dry run counts the same and writes nothing", () =>
    Effect.gen(function* () {
      const table = yield* seeded(before)
      const report: Table.RekeyReport = yield* rekey(during, table, { dryRun: true })
      expect(report.dryRun).toBe(true)
      expect(report.indexKeysRewritten).toBe(devices.length)
      expect(updates(table)).toHaveLength(0)
      for (const pk of indexPks(table)) expect(pk).not.toContain("#!")
    }),
  )

  it.effect("runs in segments and resumes", () =>
    Effect.gen(function* () {
      const table = yield* seeded(before)
      const first: Table.RekeyReport = yield* rekey(during, table, { maxPages: 1, pageSize: 5 })
      expect(Option.isSome(first.resume)).toBe(true)
      expect(first.indexKeysRewritten).toBeLessThan(devices.length)
      const rest: Table.RekeyReport = yield* rekey(during, table, {
        resume: Option.getOrThrow(first.resume),
      })
      expect(first.indexKeysRewritten + rest.indexKeysRewritten).toBe(devices.length)
      for (const pk of indexPks(table)) expect(pk).toContain("#!8.")
    }),
  )

  it.effect("works with the 1.36 fallback off", () =>
    Effect.gen(function* () {
      const old = declared(undefined, off)
      const table = yield* seeded(old)
      const report: Table.RekeyReport = yield* rekey(
        declared({ count: 8, previous: 1 }, off),
        table,
      )
      expect(report.indexKeysRewritten).toBe(devices.length)
      for (const pk of indexPks(table)) expect(pk).toContain("#!8.")
    }),
  )

  it.effect("a write landing between the read and the move: judged again from the item", () =>
    Effect.gen(function* () {
      const table = yield* seeded(before)
      const victim = KeyComposer.composeIndexKeys(
        on,
        "Device",
        1,
        before.Devices.indexes.primary,
        devices[0]!,
      ) as Record<string, string>
      const at = `${victim.pk}|${victim.sk}`
      let fired = false
      table.hooks.onRequest = (request) => {
        if (fired || request.command !== "UpdateItem") return
        if (request.input.Key.pk.S !== victim.pk || request.input.Key.sk.S !== victim.sk) return
        fired = true
        // Another writer moves the tenant first: the guard fails.
        table.items.set(at, {
          ...table.items.get(at)!,
          tenantId: { S: "t-999" },
          gsi5pk: { S: "$fleet-db#v1#device#tenantid_t-999" },
        })
      }
      const report: Table.RekeyReport = yield* rekey(during, table)
      expect(fired).toBe(true)
      expect(report.conflicts).toEqual([])
      expect(table.items.get(at)!.gsi5pk?.S).toBe(
        `$fleet-db#v1#device#${shardMarker(8, shardOf([devices[0]!.channel, devices[0]!.deviceId], 8))}#tenantid_t-999`,
      )
    }),
  )

  it.effect("a write to an attribute that feeds no key doesn't make it retry", () =>
    Effect.gen(function* () {
      const table = yield* seeded(before)
      let touched = 0
      table.hooks.onRequest = (request) => {
        if (request.command !== "UpdateItem") return
        const key = `${request.input.Key.pk.S}|${request.input.Key.sk.S}`
        table.items.set(key, { ...table.items.get(key)!, status: { S: "off" } })
        touched++
      }
      yield* rekey(during, table)
      expect(touched).toBe(devices.length)
      expect(updates(table)).toHaveLength(devices.length)
    }),
  )
})

describe("changing the count", () => {
  it.effect("moves rows of the old count", () =>
    Effect.gen(function* () {
      const table = yield* seeded(declared(4))
      const report: Table.RekeyReport = yield* rekey(declared({ count: 8, previous: 4 }), table)
      expect(report.indexKeysRewritten).toBe(devices.length)
      for (const pk of indexPks(table)) expect(pk).toContain("#!8.")
    }),
  )

  it.effect("a changed `by` at a new count moves each row by its own source", () =>
    Effect.gen(function* () {
      const table = yield* seeded(declared(4))
      yield* rekey(declared({ count: 8, by: ["groupId"], previous: 4 }), table)
      for (const row of table.items.values()) {
        expect(row.gsi5pk?.S).toContain(
          `#${shardMarker(8, shardOf([row.groupId!.S!], 8))}#tenantid_`,
        )
      }
    }),
  )

  it.effect("removing `by` at the same count: reads find every row, and `rekey` moves them", () =>
    Effect.gen(function* () {
      const table = yield* seeded(declared({ count: 8, by: ["groupId"] }))
      const after = declared(8)
      // No read prunes now, so a row is found on whichever shard holds it.
      const read = using(after, table, (db) =>
        db.entities.Devices.byTenant({ tenantId: "t-123" }).collect(),
      ) as Effect.Effect<ReadonlyArray<Device>>
      expect(ids(yield* read)).toEqual(ids(devices))
      const report: Table.RekeyReport = yield* rekey(after, table)
      expect(report.conflicts).toEqual([])
      for (const row of table.items.values()) {
        const shard = shardOf([row.channel!.S!, row.deviceId!.S!], 8)
        expect(row.gsi5pk?.S).toContain(`#${shardMarker(8, shard)}#tenantid_`)
      }
      expect(ids(yield* read)).toEqual(ids(devices))
      const again: Table.RekeyReport = yield* rekey(after, table)
      expect(again.indexKeysRewritten).toBe(0)
    }),
  )

  it.effect("leaves an entry a sparse write left out", () =>
    Effect.gen(function* () {
      const table = makeTable()
      yield* write(declared(4), table, [{ channel: "c", deviceId: "d", status: "on" } as never])
      const report: Table.RekeyReport = yield* rekey(declared({ count: 8, previous: 4 }), table)
      expect(report.indexKeysRewritten).toBe(0)
      expect(report.unchanged).toBe(1)
      expect(report.conflicts).toEqual([])
    }),
  )
})

describe("a row whose values can no longer compose a key (`uncomposable`)", () => {
  const byGroup = declared({ count: 8, by: ["groupId"], previous: 4 })
  const stale = {
    channel: { S: "c" },
    deviceId: { S: "d" },
    tenantId: { S: "t" },
    pk: { S: "$fleet-db#v1#device#channel_c" },
    sk: { S: "$fleet-db#v1#device#deviceid_d" },
    __edd_e__: { S: "Device" },
  } satisfies Record<string, AttributeValue>
  const AT = `${stale.pk.S}|${stale.sk.S}`

  it.effect("from another layout: reported, and left as stored", () =>
    Effect.gen(function* () {
      const table = makeTable()
      const gsi5pk = { S: "$fleet-db#v1#device#!4.1#tenantid_t" }
      table.items.set(AT, { ...stale, gsi5pk, gsi5sk: { S: "x" } })
      const report: Table.RekeyReport = yield* rekey(byGroup, table)
      expect(report.conflicts).toHaveLength(1)
      expect(report.conflicts[0]!.reason).toBe("uncomposable")
      expect(report.conflicts[0]!.message).toContain('"byTenant"')
      expect(report.indexKeysRewritten).toBe(0)
      expect(updates(table)).toHaveLength(0)
      expect(table.items.get(AT)!.gsi5pk).toEqual(gsi5pk)
    }),
  )

  it.effect("in the current layout: left alone without a conflict", () =>
    Effect.gen(function* () {
      const table = makeTable()
      table.items.set(AT, {
        ...stale,
        gsi5pk: { S: "$fleet-db#v1#device#!8.3#tenantid_t" },
        gsi5sk: { S: "x" },
      })
      const report: Table.RekeyReport = yield* rekey(byGroup, table)
      expect(report.conflicts).toEqual([])
      expect(report.unchanged).toBe(1)
    }),
  )
})

describe("rows under 1.36 key text", () => {
  class Meter extends Schema.Class<Meter>("Meter")({
    site: Schema.String,
    meterId: Schema.Number,
    zone: Schema.String,
    level: Schema.Number,
  }) {}
  const meters = (shards?: number | Record<string, unknown>) => {
    const Meters = Entity.make({
      model: Meter,
      entityType: "Meter",
      primaryKey: {
        pk: { field: "pk", composite: ["site"] },
        sk: { field: "sk", composite: ["meterId"] },
      },
      indexes: {
        byLevel: {
          name: "gsi1",
          // A number in the partition key: its 1.36 text differs from its text now.
          pk: { field: "gsi1pk", composite: ["level"] },
          sk: { field: "gsi1sk", composite: ["meterId"] },
          ...(shards === undefined ? {} : { shards }),
        },
      },
    } as any) as any
    return { Meters, MeterTable: Table.make({ schema: on, entities: { Meters } }) }
  }
  type MeterWorld = ReturnType<typeof meters>
  const record = { site: "s", meterId: -7, zone: "z", level: -2.5 }

  const tableWith136 = (w: MeterWorld, value = record) => {
    const table = makeRecordingTable({ indexes: { gsi1: { pk: "gsi1pk", sk: "gsi1sk" } } })
    const keys = KeyText136.composeAllKeys(on, "Meter", 1, w.Meters.indexes, value)
    expect(keys.gsi1pk).not.toContain("#!")
    table.items.set(
      `${keys.pk}|${keys.sk}`,
      toAttributeMap({ ...value, ...keys, __edd_e__: "Meter" }),
    )
    return table
  }

  const useMeters = <A, E>(
    w: MeterWorld,
    table: Recording,
    f: (db: any) => Effect.Effect<A, E, any>,
  ): Effect.Effect<A, E> =>
    Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { Meters: w.Meters },
        tables: { MeterTable: w.MeterTable },
      })
      return yield* f(db)
    }).pipe(
      Effect.provide(Layer.merge(table.layer, w.MeterTable.layer({ name: "t" }))),
    ) as Effect.Effect<A, E>

  const adopting = meters({ count: 8, previous: 1 })

  it.effect("with `previous: 1`, a read holds N + 1 + the 1.36 text", () =>
    Effect.gen(function* () {
      const table = tableWith136(adopting)
      const explained: any = yield* useMeters(adopting, table, (db) =>
        db.entities.Meters.byLevel({ level: -2.5 }).explain(),
      )
      const partitions: ReadonlyArray<string> = explained.fanOut.partitions
      expect(partitions).toHaveLength(10)
      expect(partitions.filter((pk) => pk.includes("#!8."))).toHaveLength(8)
      expect(partitions.filter((pk) => !pk.includes("#!"))).toHaveLength(2)
    }),
  )

  it.effect("each item is found once, with a selection borrowing what its row check reads", () => {
    const row = () => {
      const keys = KeyText136.composeAllKeys(on, "Meter", 1, adopting.Meters.indexes, record)
      return toAttributeMap({ ...record, ...keys, __edd_e__: "Meter" })
    }
    // This one applies the projection, so a row check that reads an attribute the
    // selection left out would reject the row.
    const server = serveRows([row()], {
      pkField: "gsi1pk",
      skField: "gsi1sk",
      keyFields: ["gsi1pk", "gsi1sk", "pk", "sk"],
    })
    return Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { Meters: adopting.Meters },
        tables: { MeterTable: adopting.MeterTable },
      })
      const meters: any = db.entities.Meters
      const found: any = yield* meters.byLevel({ level: -2.5 }).collect()
      expect(found).toHaveLength(1)
      expect(found[0].meterId).toBe(-7)
      const selected: any = yield* meters.byLevel({ level: -2.5 }).select(["zone"]).collect()
      expect(selected).toEqual([{ zone: "z" }])
      const page: any = yield* meters.byLevel({ level: -2.5 }).select(["zone"]).limit(1).fetch()
      expect(page.items).toEqual([{ zone: "z" }])
    }).pipe(
      Effect.provide(
        Layer.merge(
          mockDynamoClientLayer({ query: server.query }),
          adopting.MeterTable.layer({ name: "t" }),
        ),
      ),
    ) as Effect.Effect<void, unknown>
  })

  it.effect("without `previous`, no 1.36 partition is read", () =>
    Effect.gen(function* () {
      const w = meters(8)
      const table = tableWith136(w)
      const explained: any = yield* useMeters(w, table, (db) =>
        db.entities.Meters.byLevel({ level: -2.5 }).explain(),
      )
      expect(explained.fanOut.partitions).toHaveLength(8)
    }),
  )

  it.effect("with `previous` above 1, no 1.36 partition is read", () =>
    Effect.gen(function* () {
      const w = meters({ count: 8, previous: 4 })
      const table = tableWith136(w)
      const explained: any = yield* useMeters(w, table, (db) =>
        db.entities.Meters.byLevel({ level: -2.5 }).explain(),
      )
      expect(explained.fanOut.partitions).toHaveLength(12)
    }),
  )

  it.effect("`rekey` moves the table key and lands the index key sharded", () =>
    Effect.gen(function* () {
      const table = tableWith136(adopting)
      const report: Table.RekeyReport = yield* useMeters(
        adopting,
        table,
        (db) => db.tables.MeterTable.rekey() as Effect.Effect<Table.RekeyReport>,
      )
      expect(report.moved.item).toBe(1)
      const [row] = [...table.items.values()]
      expect(row!.gsi1pk?.S).toContain("#!8.")
      expect(row!.pk?.S).toBe(
        KeyComposer.composePk(on, "Meter", adopting.Meters.indexes.primary, record),
      )
      const found: any = yield* useMeters(adopting, table, (db) =>
        db.entities.Meters.byLevel({ level: -2.5 }).collect(),
      )
      expect(found).toHaveLength(1)
    }),
  )

  it.effect("an update of a 1.36 row moves it, and lands it sharded", () =>
    Effect.gen(function* () {
      const table = tableWith136(adopting)
      yield* useMeters(adopting, table, (db) =>
        db.entities.Meters.update({ site: "s", meterId: -7 }).set({ zone: "y" }),
      )
      const rows = [...table.items.values()]
      expect(rows).toHaveLength(1)
      expect(rows[0]!.zone?.S).toBe("y")
      expect(rows[0]!.gsi1pk?.S).toContain("#!8.")
    }),
  )
})
