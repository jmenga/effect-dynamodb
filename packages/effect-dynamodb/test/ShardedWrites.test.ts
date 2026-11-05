/**
 * Every write path on a sharded index (#183, design §4): a recording in-memory
 * table holds what each one stores. An unsharded key for a sharded index can't be
 * composed, so none of these call sites is special-cased, and that is what these
 * tests pin, including the paths the issue's list doesn't name.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { describe, expect, it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import * as KeyText136 from "@effect-dynamodb/schema/internal/KeyText136.js"
import { shardMarker, shardOf } from "@effect-dynamodb/schema/internal/Shards.js"
import * as KeyComposer from "@effect-dynamodb/schema/KeyComposer.js"
import { Effect, Layer, Schema } from "effect"
import * as Batch from "../src/Batch.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import { toAttributeMap } from "../src/Marshaller.js"
import * as Table from "../src/Table.js"
import * as Transaction from "../src/Transaction.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

const schema = DynamoSchema.make({ name: "fleet-db", version: 1 })

class Device extends Schema.Class<Device>("Device")({
  channel: Schema.String,
  deviceId: Schema.String,
  tenantId: Schema.optional(Schema.String),
  groupId: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
}) {}

const primaryKey = {
  pk: { field: "pk", composite: ["channel"] },
  sk: { field: "sk", composite: ["deviceId"] },
} as const

const indexes = {
  // The default source: the primary key composites.
  byTenant: {
    name: "gsi5",
    pk: { field: "gsi5pk", composite: ["tenantId"] },
    sk: { field: "gsi5sk", composite: ["deviceId"] },
    shards: 20,
  },
  // `by`: this index's sort key composite.
  byGroup: {
    name: "gsi6",
    pk: { field: "gsi6pk", composite: ["tenantId"] },
    sk: { field: "gsi6sk", composite: ["groupId", "deviceId"] },
    shards: { count: 20, by: ["groupId"] },
  },
} as const

const Devices = Entity.make({ model: Device, entityType: "Device", primaryKey, indexes })
const Retained = Entity.make({
  model: Device,
  entityType: "Retained",
  primaryKey,
  indexes,
  versioned: { retain: true },
})
const Soft = Entity.make({
  model: Device,
  entityType: "Soft",
  primaryKey,
  indexes,
  softDelete: true,
})

class Reading extends Schema.Class<Reading>("Reading")({
  channel: Schema.String,
  deviceId: Schema.String,
  tenantId: Schema.String,
  at: Schema.Number,
}) {}
const Readings = Entity.make({
  model: Reading,
  entityType: "Reading",
  primaryKey,
  indexes: {
    byTenant: {
      name: "gsi5",
      pk: { field: "gsi5pk", composite: ["tenantId"] },
      sk: { field: "gsi5sk", composite: ["deviceId"] },
      shards: 20,
    },
  },
  timeSeries: {
    orderBy: "at",
    appendInput: Schema.Struct({
      channel: Schema.String,
      deviceId: Schema.String,
      tenantId: Schema.String,
      at: Schema.Number,
    }),
  },
})

const MainTable = Table.make({
  schema,
  entities: { Devices, Retained, Soft, Readings },
})

const client = DynamoClient.make({
  entities: { Devices, Retained, Soft, Readings },
  tables: { MainTable },
})

const CHANNEL = "channel-a"
const DEVICE = "device-1"
const KEY = { channel: CHANNEL, deviceId: DEVICE }
const INPUT = { ...KEY, tenantId: "t-123", groupId: "group-a", status: "on" }
// Golden: FNV-1a-32 of `channel-a`, `device-1` is 0x3cca2437, shard 3 of 20.
const KEY_SHARD = "!20.03"
const GROUP_SHARD = shardMarker(20, shardOf(["group-a"], 20))

const tenantKey = (entityType: string, marker = KEY_SHARD, tenant = "t-123") =>
  `$fleet-db#v1#${entityType}#${marker}#tenantid_${tenant}`

type Recording = ReturnType<typeof makeRecordingTable>

const fresh = () => makeRecordingTable()

const provide = <A, E>(table: Recording, effect: Effect.Effect<A, E, any>) =>
  effect.pipe(
    Effect.provide(Layer.merge(table.layer, MainTable.layer({ name: "devices" }))),
  ) as Effect.Effect<A, E>

/** The live row of a device: under its current table key. */
const rowOf = (table: Recording, entityType: string, key = KEY) => {
  const at = KeyComposer.composeIndexKeys(
    schema,
    entityType,
    1,
    Devices.indexes.primary,
    key,
  ) as Record<string, string>
  return table.items.get(`${at.pk}|${at.sk}`)
}

const allWrites = (table: Recording) =>
  table.requests.filter((request) =>
    ["PutItem", "UpdateItem", "DeleteItem", "BatchWriteItem", "TransactWriteItems"].includes(
      request.command,
    ),
  )

/** Every index partition key any row holds: none may be unsharded. */
const expectNoUnshardedKey = (table: Recording) => {
  for (const row of table.items.values()) {
    for (const field of ["gsi5pk", "gsi6pk"]) {
      const text = row[field]?.S
      if (text !== undefined) expect(text).toMatch(/#!20\.\d\d(#|$)/)
    }
  }
}

describe("every write path composes the sharded key", () => {
  it.effect("put", () => {
    const table = fresh()
    return provide(
      table,
      Effect.gen(function* () {
        const db = yield* client
        yield* db.entities.Devices.put(INPUT)
        const row = rowOf(table, "Device")!
        expect(row.gsi5pk?.S).toBe(tenantKey("device"))
        expect(row.gsi6pk?.S).toBe(tenantKey("device", GROUP_SHARD))
        expect(row.gsi5sk?.S).toBe("$fleet-db#v1#device#deviceid_device-1")
        expect(row.gsi6sk?.S).toBe("$fleet-db#v1#device#groupid_group-a#deviceid_device-1")
      }),
    )
  })

  it.effect("create", () => {
    const table = fresh()
    return provide(
      table,
      Effect.gen(function* () {
        const db = yield* client
        yield* db.entities.Devices.create(INPUT)
        expect(rowOf(table, "Device")!.gsi5pk?.S).toBe(tenantKey("device"))
      }),
    )
  })

  it.effect("upsert, creating and over an item", () => {
    const table = fresh()
    return provide(
      table,
      Effect.gen(function* () {
        const db = yield* client
        yield* db.entities.Devices.upsert(INPUT)
        expect(rowOf(table, "Device")!.gsi5pk?.S).toBe(tenantKey("device"))
        expect(rowOf(table, "Device")!.gsi6pk?.S).toBe(tenantKey("device", GROUP_SHARD))
        yield* db.entities.Devices.upsert({ ...INPUT, groupId: "group-b" })
        expect(rowOf(table, "Device")!.gsi6pk?.S).toBe(
          tenantKey("device", shardMarker(20, shardOf(["group-b"], 20))),
        )
        expectNoUnshardedKey(table)
      }),
    )
  })

  it.effect("update", () => {
    const table = fresh()
    return provide(
      table,
      Effect.gen(function* () {
        const db = yield* client
        yield* db.entities.Devices.put({ ...KEY, status: "on" })
        expect(rowOf(table, "Device")!.gsi5pk).toBeUndefined()
        yield* db.entities.Devices.update(KEY).set({ tenantId: "t-123", groupId: "group-a" })
        const row = rowOf(table, "Device")!
        expect(row.gsi5pk?.S).toBe(tenantKey("device"))
        expect(row.gsi6pk?.S).toBe(tenantKey("device", GROUP_SHARD))
      }),
    )
  })

  it.effect("patch", () => {
    const table = fresh()
    return provide(
      table,
      Effect.gen(function* () {
        const db = yield* client
        yield* db.entities.Devices.put({ ...KEY, status: "on" })
        yield* db.entities.Devices.patch(KEY).set({ tenantId: "t-123", groupId: "group-a" })
        expect(rowOf(table, "Device")!.gsi5pk?.S).toBe(tenantKey("device"))
      }),
    )
  })

  it.effect("the retain path, with its snapshot stripped of index keys", () => {
    const table = fresh()
    return provide(
      table,
      Effect.gen(function* () {
        const db = yield* client
        yield* db.entities.Retained.put(INPUT)
        yield* db.entities.Retained.update(KEY).set({ tenantId: "t-999" })
        const row = rowOf(table, "Retained")!
        expect(row.gsi5pk?.S).toBe(tenantKey("retained", KEY_SHARD, "t-999"))
        const snapshots = [...table.items.values()].filter(
          (item) => item.__edd_e__?.S === "Retained" && item !== row,
        )
        expect(snapshots.length).toBeGreaterThan(0)
        for (const snapshot of snapshots) expect(snapshot.gsi5pk).toBeUndefined()
      }),
    )
  })

  it.effect("append, with its event stripped of index keys", () => {
    const table = fresh()
    return provide(
      table,
      Effect.gen(function* () {
        const db = yield* client
        yield* db.entities.Readings.append({ ...KEY, tenantId: "t-123", at: 1 })
        const row = rowOf(table, "Reading")!
        expect(row.gsi5pk?.S).toBe(tenantKey("reading"))
        const events = [...table.items.values()].filter((item) => item !== row)
        expect(events.length).toBeGreaterThan(0)
        for (const event of events) expect(event.gsi5pk).toBeUndefined()
      }),
    )
  })

  it.effect("soft delete strips them; restore recomposes the sharded key", () => {
    const table = fresh()
    return provide(
      table,
      Effect.gen(function* () {
        const db = yield* client
        yield* db.entities.Soft.put(INPUT)
        yield* db.entities.Soft.delete(KEY)
        expect(rowOf(table, "Soft")).toBeUndefined()
        for (const row of table.items.values()) expect(row.gsi5pk).toBeUndefined()
        yield* db.entities.Soft.restore(KEY)
        const row = rowOf(table, "Soft")!
        expect(row.gsi5pk?.S).toBe(tenantKey("soft"))
        expect(row.gsi6pk?.S).toBe(tenantKey("soft", GROUP_SHARD))
      }),
    )
  })

  it.effect("Batch.write", () => {
    const table = fresh()
    return provide(
      table,
      Effect.gen(function* () {
        yield* Batch.write([Devices.put(INPUT)])
        expect(rowOf(table, "Device")!.gsi5pk?.S).toBe(tenantKey("device"))
      }),
    )
  })

  it.effect("Transaction.transactWrite: put", () => {
    const table = fresh()
    return provide(
      table,
      Effect.gen(function* () {
        yield* Transaction.transactWrite([Devices.put(INPUT)])
        expect(rowOf(table, "Device")!.gsi5pk?.S).toBe(tenantKey("device"))
        expect(rowOf(table, "Device")!.gsi6pk?.S).toBe(tenantKey("device", GROUP_SHARD))
      }),
    )
  })

  it.effect("Transaction.transactWrite: update", () => {
    const table = fresh()
    return provide(
      table,
      Effect.gen(function* () {
        yield* Transaction.transactWrite([Devices.put(INPUT)])
        yield* Transaction.transactWrite([
          Devices.update(KEY).pipe(Entity.set({ tenantId: "t-999", groupId: "group-b" })),
        ])
        const row = rowOf(table, "Device")!
        expect(row.gsi5pk?.S).toBe(tenantKey("device", KEY_SHARD, "t-999"))
        expect(row.gsi6pk?.S).toBe(
          tenantKey("device", shardMarker(20, shardOf(["group-b"], 20)), "t-999"),
        )
      }),
    )
  })

  it.effect("Transaction.transactWrite: a `by`-only update fails with nothing written", () => {
    const table = fresh()
    return provide(
      table,
      Effect.gen(function* () {
        yield* Transaction.transactWrite([Devices.put(INPUT)])
        const before = allWrites(table).length
        const error: any = yield* Transaction.transactWrite([
          Devices.update(KEY).pipe(Entity.set({ groupId: "group-b" })),
        ]).pipe(Effect.flip)
        expect(error._tag).toBe("ValidationError")
        expect(String(error.cause)).toContain("[EDD-9100]")
        expect(allWrites(table)).toHaveLength(before)
      }),
    )
  })
})

describe("a missing source fails, and nothing is written", () => {
  it.effect("a `by`-only update on the standard path", () => {
    const table = fresh()
    return provide(
      table,
      Effect.gen(function* () {
        const db = yield* client
        yield* db.entities.Devices.put(INPUT)
        const before = allWrites(table).length
        const error: any = yield* db.entities.Devices.update(KEY)
          .set({ groupId: "group-b" })
          .asEffect()
          .pipe(Effect.flip)
        expect(error._tag).toBe("ValidationError")
        expect(String(error.cause)).toContain("[EDD-9100]")
        expect(allWrites(table)).toHaveLength(before)
        expect(rowOf(table, "Device")!.gsi6pk?.S).toBe(tenantKey("device", GROUP_SHARD))
      }),
    )
  })

  it.effect("moving the tenant without `by`", () => {
    const table = fresh()
    return provide(
      table,
      Effect.gen(function* () {
        const db = yield* client
        yield* db.entities.Devices.put(INPUT)
        const before = allWrites(table).length
        const error: any = yield* db.entities.Devices.update(KEY)
          .set({ tenantId: "t-999" })
          .asEffect()
          .pipe(Effect.flip)
        expect(String(error.cause)).toContain("[EDD-9100]")
        expect(allWrites(table)).toHaveLength(before)
      }),
    )
  })

  it.effect("the same updates with the whole key move the entry", () => {
    const table = fresh()
    return provide(
      table,
      Effect.gen(function* () {
        const db = yield* client
        yield* db.entities.Devices.put(INPUT)
        yield* db.entities.Devices.update(KEY).set({ tenantId: "t-999", groupId: "group-b" })
        const row = rowOf(table, "Device")!
        expect(row.gsi6pk?.S).toBe(
          tenantKey("device", shardMarker(20, shardOf(["group-b"], 20)), "t-999"),
        )
        expect(row.gsi5pk?.S).toBe(tenantKey("device", KEY_SHARD, "t-999"))
      }),
    )
  })

  it.effect("the retain path reads the item, so a `by`-only update succeeds", () => {
    const table = fresh()
    return provide(
      table,
      Effect.gen(function* () {
        const db = yield* client
        yield* db.entities.Retained.put(INPUT)
        yield* db.entities.Retained.update(KEY).set({ groupId: "group-b" })
        expect(rowOf(table, "Retained")!.gsi6pk?.S).toBe(
          tenantKey("retained", shardMarker(20, shardOf(["group-b"], 20))),
        )
      }),
    )
  })

  it.effect("a put without `by` has no index entry at all: sparse, not unsharded", () => {
    const table = fresh()
    return provide(
      table,
      Effect.gen(function* () {
        const db = yield* client
        yield* db.entities.Devices.put({ ...KEY, tenantId: "t-123" })
        const row = rowOf(table, "Device")!
        expect(row.gsi6pk).toBeUndefined()
        expect(row.gsi6sk).toBeUndefined()
        expect(row.gsi5pk?.S).toBe(tenantKey("device"))
      }),
    )
  })

  it.effect("`.remove(['groupId'])` takes the item out, and writes no unsharded key", () => {
    const table = fresh()
    return provide(
      table,
      Effect.gen(function* () {
        const db = yield* client
        yield* db.entities.Devices.put(INPUT)
        yield* db.entities.Devices.update(KEY).remove(["groupId"])
        const row = rowOf(table, "Device")!
        expect(row.gsi6pk).toBeUndefined()
        expect(row.gsi5pk?.S).toBe(tenantKey("device"))
      }),
    )
  })

  it.effect("an unrelated update touches no key", () => {
    const table = fresh()
    return provide(
      table,
      Effect.gen(function* () {
        const db = yield* client
        yield* db.entities.Devices.put(INPUT)
        const before = rowOf(table, "Device")!
        yield* db.entities.Devices.update(KEY).set({ status: "off" })
        const row = rowOf(table, "Device")!
        expect(row.gsi6pk).toEqual(before.gsi6pk)
        expect(row.gsi5pk).toEqual(before.gsi5pk)
        expect(row.status?.S).toBe("off")
      }),
    )
  })
})

describe("rows under 1.36 key text (finding 7)", () => {
  class Meter extends Schema.Class<Meter>("Meter")({
    site: Schema.String,
    meterId: Schema.Number,
    zone: Schema.optional(Schema.String),
    label: Schema.optional(Schema.String),
  }) {}
  const Meters = Entity.make({
    model: Meter,
    entityType: "Meter",
    primaryKey: {
      pk: { field: "pk", composite: ["site"] },
      sk: { field: "sk", composite: ["meterId"] },
    },
    indexes: {
      byZone: {
        name: "gsi1",
        pk: { field: "gsi1pk", composite: ["zone"] },
        sk: { field: "gsi1sk", composite: ["meterId"] },
        shards: { count: 8, previous: 1 },
      },
    },
  })
  const MeterTable = Table.make({ schema, entities: { Meters } })
  const meterClient = DynamoClient.make({ entities: { Meters }, tables: { MeterTable } })
  const record = { site: "s", meterId: -7, zone: "z", label: "a" }
  const layerFor = (table: Recording) =>
    Layer.merge(table.layer, MeterTable.layer({ name: "meters" }))

  /** A meter as 1.36 wrote it: unsharded, and its number in 1.36's text. */
  const seed136 = (table: Recording) => {
    const keys = KeyText136.composeAllKeys(schema, "Meter", 1, Meters.indexes, record)
    table.items.set(`${keys.pk}|${keys.sk}`, {
      ...toAttributeMap({ ...record, ...keys, __edd_e__: "Meter" }),
    } as Record<string, AttributeValue>)
    return keys
  }

  it("the 1.36 composer stays unsharded", () => {
    const keys = KeyText136.composeAllKeys(schema, "Meter", 1, Meters.indexes, record)
    expect(keys.gsi1pk).toBe("$fleet-db#v1#meter#zone_z")
  })

  it.effect("the move path lands a row sharded", () => {
    const table = fresh()
    seed136(table)
    return Effect.gen(function* () {
      const db = yield* meterClient
      yield* db.entities.Meters.update({ site: "s", meterId: -7 }).set({ label: "b" })
      const current = KeyComposer.composeAllKeys(schema, "Meter", 1, Meters.indexes, record)
      const row = table.items.get(`${current.pk}|${current.sk}`)
      expect(row).toBeDefined()
      expect(row!.gsi1pk?.S).toBe(current.gsi1pk)
      expect(row!.gsi1pk?.S).toMatch(/#!8\.\d#zone_z$/)
    }).pipe(Effect.provide(layerFor(table)))
  })
})
