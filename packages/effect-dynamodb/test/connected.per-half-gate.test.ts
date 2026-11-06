/**
 * The per-half update gate (#183) — connected tests against DynamoDB Local.
 *
 * An update that names no composite of a half leaves that half's stored key alone,
 * unless every composite of the half is known without a read: then it's idempotent
 * (#43). A half mixing a primary key composite with a mutable one isn't known that
 * way: treating one composite in the key record as a claim on the half removed or
 * truncated keys an unrelated write had no business touching. Canonical shape 10,
 * next to shapes 1 to 6, on real writes and real index queries.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Config, DateTime, Effect, Layer, Schema } from "effect"
import { afterAll, beforeAll, describe, expect } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"

const ENDPOINT = Effect.runSync(
  Config.String("DYNAMODB_ENDPOINT").pipe(Config.withDefault("http://localhost:8000")),
)

let dynamoAvailable = false
try {
  const res = await fetch(ENDPOINT, { method: "POST", signal: AbortSignal.timeout(1000) }).catch(
    () => null,
  )
  dynamoAvailable = res !== null
} catch {
  dynamoAvailable = false
}
const describeConnected = dynamoAvailable ? describe : describe.skip

const AppSchema = DynamoSchema.make({ name: "gate", version: 1 })
const tableName = `per-half-gate-${Date.now()}`

// ---------------------------------------------------------------------------
// Shapes 1 to 6
// ---------------------------------------------------------------------------

class Fleet extends Schema.Class<Fleet>("Fleet")({
  channel: Schema.String,
  deviceId: Schema.String,
  accountId: Schema.optional(Schema.String),
  alertState: Schema.optional(Schema.String),
  timestamp: Schema.optional(Schema.Number),
  region: Schema.optional(Schema.String),
  country: Schema.optional(Schema.String),
  city: Schema.optional(Schema.String),
  zone: Schema.optional(Schema.String),
  hubId: Schema.optional(Schema.String),
  deviceBinding: Schema.optional(Schema.String),
  tenantId: Schema.optional(Schema.String),
  groupId: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  note: Schema.optional(Schema.String),
}) {}

const Fleets = Entity.make({
  model: Fleet,
  entityType: "Fleet",
  primaryKey: {
    pk: { field: "pk", composite: ["channel"] },
    sk: { field: "sk", composite: ["deviceId"] },
  },
  indexes: {
    // 1: multi-writer.
    multiWriter: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["accountId"] },
      sk: { field: "gsi1sk", composite: ["alertState", "timestamp"] },
    },
    // 2: PK-composites-only.
    byChannel: {
      name: "gsi2",
      pk: { field: "gsi2pk", composite: ["channel"] },
      sk: { field: "gsi2sk", composite: ["deviceId"] },
    },
    // 3: hierarchical.
    byPlace: {
      name: "gsi3",
      pk: { field: "gsi3pk", composite: ["region"] },
      sk: { field: "gsi3sk", composite: ["country", "city"] },
    },
    // 4: a hole.
    byHub: {
      name: "gsi4",
      pk: { field: "gsi4pk", composite: ["zone", "hubId"] },
      sk: { field: "gsi4sk", composite: ["status"] },
    },
    // 5: all composites mutable.
    byGroup: {
      name: "gsi5",
      pk: { field: "gsi5pk", composite: ["tenantId"] },
      sk: { field: "gsi5sk", composite: ["groupId", "status"] },
    },
    // 6: an empty sort key half.
    byBinding: {
      name: "gsi6",
      pk: { field: "gsi6pk", composite: ["deviceBinding"] },
      sk: { field: "gsi6sk", composite: [] },
    },
  },
})

// ---------------------------------------------------------------------------
// Shape 10
// ---------------------------------------------------------------------------

class MixedDevice extends Schema.Class<MixedDevice>("MixedDevice")({
  channel: Schema.String,
  deviceId: Schema.String,
  at: Schema.DateTimeUtc,
  zone: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
}) {}

const mixedIndexes = {
  leadingSparse: {
    name: "gsi1",
    pk: { field: "gsi1pk", composite: ["channel"] },
    sk: { field: "gsi1sk", composite: ["zone", "deviceId"] },
    indexPolicy: { sk: "sparse" },
  },
  leadingPreserve: {
    name: "gsi2",
    pk: { field: "gsi2pk", composite: ["channel"] },
    sk: { field: "gsi2sk", composite: ["zone", "deviceId"] },
  },
  trailing: {
    name: "gsi3",
    pk: { field: "gsi3pk", composite: ["channel"] },
    sk: { field: "gsi3sk", composite: ["deviceId", "zone"] },
  },
  mixedPk: {
    name: "gsi4",
    pk: { field: "gsi4pk", composite: ["channel", "zone"] },
    sk: { field: "gsi4sk", composite: ["deviceId"] },
  },
} as const

const mixedPrimary = {
  pk: { field: "pk", composite: ["channel"] },
  sk: { field: "sk", composite: ["deviceId"] },
} as const

const MixedDevices = Entity.make({
  model: MixedDevice,
  entityType: "MixedDevice",
  primaryKey: mixedPrimary,
  indexes: mixedIndexes,
})

const MixedRetained = Entity.make({
  model: MixedDevice,
  entityType: "MixedRetained",
  primaryKey: mixedPrimary,
  indexes: mixedIndexes,
  versioned: { retain: true },
})

const MixedSeries = Entity.make({
  model: MixedDevice,
  entityType: "MixedSeries",
  primaryKey: mixedPrimary,
  indexes: mixedIndexes,
  timeSeries: {
    orderBy: "at",
    appendInput: Schema.Struct({
      channel: Schema.String,
      deviceId: Schema.String,
      at: Schema.DateTimeUtc,
      status: Schema.optional(Schema.String),
    }),
  },
})

const MainTable = Table.make({
  schema: AppSchema,
  entities: { Fleets, MixedDevices, MixedRetained, MixedSeries },
})

const provide = Effect.provide(
  Layer.mergeAll(
    DynamoClient.layer({
      region: "us-east-1",
      endpoint: ENDPOINT,
      credentials: { accessKeyId: "local", secretAccessKey: "local" },
    }),
    MainTable.layer({ name: tableName }),
  ),
)

const makeDb = DynamoClient.make({
  entities: { Fleets, MixedDevices, MixedRetained, MixedSeries },
  tables: { MainTable },
})

type Db = Effect.Success<typeof makeDb>

const test = <A, E>(name: string, body: (db: Db) => Effect.Effect<A, E, any>) =>
  it.live(
    name,
    () =>
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* body(db)
      }).pipe(provide) as Effect.Effect<void, unknown>,
  )

let ids = 0
/** A channel no other test writes to. */
const nextChannel = () => `c-${ids++}`

/** The stored item at a composed primary key, every attribute as written. */
const storedAt = (pk: string, sk: string) =>
  Effect.gen(function* () {
    const client = yield* DynamoClient
    const { Item } = yield* client.getItem({
      TableName: tableName,
      Key: { pk: { S: pk }, sk: { S: sk } },
      ConsistentRead: true,
    })
    return (Item ?? {}) as Record<string, AttributeValue>
  })

const storedOf = (entity: string, channel: string, deviceId = "d-1") =>
  storedAt(`$gate#v1#${entity}#channel_${channel}`, `$gate#v1#${entity}#deviceid_${deviceId}`)

/** Only the index key attributes of a stored row. */
const indexKeys = (row: Record<string, AttributeValue>) =>
  Object.fromEntries(
    Object.entries(row)
      .filter(([name]) => /^gsi\d+(pk|sk)$/.test(name))
      .map(([name, value]) => [name, value.S]),
  )

const deviceIds = (rows: ReadonlyArray<{ readonly deviceId: string }>) =>
  rows.map((row) => row.deviceId)

describeConnected("#183 the per-half gate", () => {
  beforeAll(async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* DynamoClient
        yield* client.createTable({
          TableName: tableName,
          BillingMode: "PAY_PER_REQUEST",
          ...Table.definition(MainTable),
        })
      }).pipe(provide) as Effect.Effect<void, unknown>,
    )
  }, 60_000)

  afterAll(async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* DynamoClient
        yield* client.deleteTable({ TableName: tableName })
      }).pipe(provide, Effect.ignore) as Effect.Effect<void>,
    )
  }, 30_000)

  describe("shapes 1 to 6: an unrelated update", () => {
    const whole = (channel: string) =>
      new Fleet({
        channel,
        deviceId: "d-1",
        accountId: `a-${channel}`,
        alertState: "ok",
        timestamp: 7,
        region: `r-${channel}`,
        country: "c",
        city: "x",
        zone: `z-${channel}`,
        hubId: "h",
        deviceBinding: `b-${channel}`,
        tenantId: `t-${channel}`,
        groupId: "g",
        status: "on",
      })

    /** Each accessor, reaching `channel`'s item. */
    const everyAccessor = (db: Db, channel: string) =>
      Effect.gen(function* () {
        const fleets = db.entities.Fleets
        return {
          multiWriter: yield* fleets.multiWriter({ accountId: `a-${channel}` }).collect(),
          byChannel: yield* fleets.byChannel({ channel }).collect(),
          byPlace: yield* fleets.byPlace({ region: `r-${channel}` }).collect(),
          byHub: yield* fleets.byHub({ zone: `z-${channel}`, hubId: "h" }).collect(),
          byGroup: yield* fleets.byGroup({ tenantId: `t-${channel}` }).collect(),
          byBinding: yield* fleets.byBinding({ deviceBinding: `b-${channel}` }).collect(),
        }
      })

    test("leaves every stored index key byte for byte, and the item in every index", (db) =>
      Effect.gen(function* () {
        const channel = nextChannel()
        yield* db.entities.Fleets.put(whole(channel)).asEffect()
        const before = indexKeys(yield* storedOf("fleet", channel))
        expect(Object.keys(before)).toHaveLength(12)
        yield* db.entities.Fleets.update({ channel, deviceId: "d-1" }).set({ note: "n" }).asEffect()
        expect(indexKeys(yield* storedOf("fleet", channel))).toEqual(before)
        for (const [name, rows] of Object.entries(yield* everyAccessor(db, channel))) {
          expect(deviceIds(rows), name).toEqual(["d-1"])
        }
      }))

    test("shape 1, multi-writer: each writer composes its half and leaves the other", (db) =>
      Effect.gen(function* () {
        const channel = nextChannel()
        const fleets = db.entities.Fleets
        yield* fleets.put(whole(channel)).asEffect()
        const key = { channel, deviceId: "d-1" }
        const before = indexKeys(yield* storedOf("fleet", channel))
        yield* fleets.update(key).set({ accountId: "moved" }).asEffect()
        const enriched = indexKeys(yield* storedOf("fleet", channel))
        expect(enriched.gsi1pk).toBe("$gate#v1#fleet#accountid_moved")
        expect(enriched.gsi1sk).toBe(before.gsi1sk)
        yield* fleets.update(key).set({ alertState: "alarm", timestamp: 8 }).asEffect()
        const telemetry = indexKeys(yield* storedOf("fleet", channel))
        expect(telemetry.gsi1pk).toBe("$gate#v1#fleet#accountid_moved")
        expect(telemetry.gsi1sk).toBe("$gate#v1#fleet#alertstate_alarm#timestamp_0000000000000008")
      }))

    test("shape 2, PK-composites-only: the half composes, on an item that lacked it too", (db) =>
      Effect.gen(function* () {
        const channel = nextChannel()
        yield* db.entities.Fleets.put(new Fleet({ channel, deviceId: "d-1" })).asEffect()
        yield* db.entities.Fleets.update({ channel, deviceId: "d-1" }).set({ note: "n" }).asEffect()
        const stored = indexKeys(yield* storedOf("fleet", channel))
        expect(stored.gsi2pk).toBe(`$gate#v1#fleet#channel_${channel}`)
        expect(stored.gsi2sk).toBe("$gate#v1#fleet#deviceid_d-1")
        expect(deviceIds(yield* db.entities.Fleets.byChannel({ channel }).collect())).toEqual([
          "d-1",
        ])
      }))

    test("shape 3, hierarchical: `.remove` truncates, and with escapeKeys the pin on the level finds it", (db) =>
      Effect.gen(function* () {
        const channel = nextChannel()
        const fleets = db.entities.Fleets
        const region = `r-${channel}`
        yield* fleets.put(whole(channel)).asEffect()
        yield* fleets
          .update({ channel, deviceId: "d-1" })
          .set({ region, country: "c" })
          .remove(["city"])
          .asEffect()
        expect(indexKeys(yield* storedOf("fleet", channel)).gsi3sk).toBe("$gate#v1#fleet#country_c")
        // Off, a pin reads `country_c#`, as 1.36 did, which the truncated key isn't under.
        expect(deviceIds(yield* fleets.byPlace({ region, country: "c" }).collect())).toEqual(
          AppSchema.escapeKeys === true ? ["d-1"] : [],
        )
        expect(deviceIds(yield* fleets.byPlace({ region }).collect())).toEqual(["d-1"])
      }))

    test("shape 4, a hole: 'preserve' leaves the key, `.remove` takes the entry out", (db) =>
      Effect.gen(function* () {
        const channel = nextChannel()
        const fleets = db.entities.Fleets
        yield* fleets.put(whole(channel)).asEffect()
        const before = indexKeys(yield* storedOf("fleet", channel))
        yield* fleets.update({ channel, deviceId: "d-1" }).set({ hubId: "h2" }).asEffect()
        expect(indexKeys(yield* storedOf("fleet", channel)).gsi4pk).toBe(before.gsi4pk)
        yield* fleets.update({ channel, deviceId: "d-1" }).remove(["zone"]).asEffect()
        expect(indexKeys(yield* storedOf("fleet", channel)).gsi4pk).toBeUndefined()
      }))

    test("shape 5, all composites mutable: the payload moves the entry", (db) =>
      Effect.gen(function* () {
        const channel = nextChannel()
        const fleets = db.entities.Fleets
        const tenantId = `t-${channel}`
        yield* fleets.put(whole(channel)).asEffect()
        yield* fleets
          .update({ channel, deviceId: "d-1" })
          .set({ tenantId, groupId: "g2", status: "off" })
          .asEffect()
        expect(deviceIds(yield* fleets.byGroup({ tenantId, groupId: "g" }).collect())).toEqual([])
        expect(deviceIds(yield* fleets.byGroup({ tenantId, groupId: "g2" }).collect())).toEqual([
          "d-1",
        ])
      }))

    test("shape 6, an empty half: the constant prefix is written, the entry stays", (db) =>
      Effect.gen(function* () {
        const channel = nextChannel()
        const fleets = db.entities.Fleets
        const deviceBinding = `b-${channel}`
        yield* fleets.put(new Fleet({ channel, deviceId: "d-1" })).asEffect()
        yield* fleets.update({ channel, deviceId: "d-1" }).set({ deviceBinding }).asEffect()
        const stored = indexKeys(yield* storedOf("fleet", channel))
        expect(stored.gsi6pk).toBe(`$gate#v1#fleet#devicebinding_${deviceBinding}`)
        expect(stored.gsi6sk).toBe("$gate#v1#fleet")
        yield* fleets.update({ channel, deviceId: "d-1" }).set({ note: "n" }).asEffect()
        expect(deviceIds(yield* fleets.byBinding({ deviceBinding }).collect())).toEqual(["d-1"])
      }))
  })

  describe("shape 10: a half mixing a primary key composite with a mutable one", () => {
    const at = DateTime.makeUnsafe("2026-04-30T10:00:00.000Z")
    const device = (channel: string, zone?: string) =>
      new MixedDevice({
        channel,
        deviceId: "d-1",
        at,
        ...(zone === undefined ? {} : { zone }),
      })

    /** The item, found (or not) through each index that has a mixed half. */
    const reach = (devices: any, channel: string, zone: string) =>
      Effect.gen(function* () {
        return {
          leadingSparse: deviceIds(yield* devices.leadingSparse({ channel, zone }).collect()),
          leadingPreserve: deviceIds(yield* devices.leadingPreserve({ channel, zone }).collect()),
          trailing: deviceIds(
            yield* devices.trailing({ channel, deviceId: "d-1", zone }).collect(),
          ),
          mixedPk: deviceIds(yield* devices.mixedPk({ channel, zone }).collect()),
        }
      })

    const everywhere = {
      leadingSparse: ["d-1"],
      leadingPreserve: ["d-1"],
      trailing: ["d-1"],
      mixedPk: ["d-1"],
    }

    test("an unrelated update leaves each stored key, under both policies", (db) =>
      Effect.gen(function* () {
        const channel = nextChannel()
        const devices = db.entities.MixedDevices
        yield* devices.put(device(channel, "z")).asEffect()
        const before = yield* storedOf("mixeddevice", channel)
        expect(indexKeys(before)).toEqual({
          gsi1pk: `$gate#v1#mixeddevice#channel_${channel}`,
          gsi1sk: "$gate#v1#mixeddevice#zone_z#deviceid_d-1",
          gsi2pk: `$gate#v1#mixeddevice#channel_${channel}`,
          gsi2sk: "$gate#v1#mixeddevice#zone_z#deviceid_d-1",
          gsi3pk: `$gate#v1#mixeddevice#channel_${channel}`,
          gsi3sk: "$gate#v1#mixeddevice#deviceid_d-1#zone_z",
          gsi4pk: `$gate#v1#mixeddevice#channel_${channel}#zone_z`,
          gsi4sk: "$gate#v1#mixeddevice#deviceid_d-1",
        })
        yield* devices.update({ channel, deviceId: "d-1" }).set({ status: "on" }).asEffect()
        expect(indexKeys(yield* storedOf("mixeddevice", channel))).toEqual(indexKeys(before))
        expect(yield* reach(devices, channel, "z")).toEqual(everywhere)
      }))

    test("an item lacking the mutable composite doesn't join, on an unrelated update", (db) =>
      Effect.gen(function* () {
        const channel = nextChannel()
        const devices = db.entities.MixedDevices
        yield* devices.put(device(channel)).asEffect()
        const before = indexKeys(yield* storedOf("mixeddevice", channel))
        yield* devices.update({ channel, deviceId: "d-1" }).set({ status: "on" }).asEffect()
        const after = indexKeys(yield* storedOf("mixeddevice", channel))
        for (const half of ["gsi1sk", "gsi2sk", "gsi3sk", "gsi4pk"]) {
          expect(after[half], half).toBe(before[half])
          expect(after[half], half).toBeUndefined()
        }
      }))

    test("naming the mutable composite composes every half, and joins each index", (db) =>
      Effect.gen(function* () {
        const channel = nextChannel()
        const devices = db.entities.MixedDevices
        yield* devices.put(device(channel)).asEffect()
        yield* devices.update({ channel, deviceId: "d-1" }).set({ zone: "z" }).asEffect()
        expect(yield* reach(devices, channel, "z")).toEqual(everywhere)
        yield* devices.update({ channel, deviceId: "d-1" }).set({ zone: "y" }).asEffect()
        expect(yield* reach(devices, channel, "y")).toEqual(everywhere)
        expect(yield* reach(devices, channel, "z")).toEqual({
          leadingSparse: [],
          leadingPreserve: [],
          trailing: [],
          mixedPk: [],
        })
      }))

    test("`.remove` is the way out: a leading hole drops, a trailing one truncates", (db) =>
      Effect.gen(function* () {
        const channel = nextChannel()
        const devices = db.entities.MixedDevices
        yield* devices.put(device(channel, "z")).asEffect()
        yield* devices.update({ channel, deviceId: "d-1" }).remove(["zone"]).asEffect()
        const after = indexKeys(yield* storedOf("mixeddevice", channel))
        expect(after.gsi1sk).toBeUndefined()
        expect(after.gsi2sk).toBeUndefined()
        expect(after.gsi3sk).toBe("$gate#v1#mixeddevice#deviceid_d-1")
        expect(after.gsi4pk).toBe(`$gate#v1#mixeddevice#channel_${channel}`)
      }))

    test("the retain path: an unrelated update leaves each stored key", (db) =>
      Effect.gen(function* () {
        const channel = nextChannel()
        const devices = db.entities.MixedRetained
        yield* devices.put(device(channel, "z")).asEffect()
        const before = indexKeys(yield* storedOf("mixedretained", channel))
        expect(before.gsi3sk).toBe("$gate#v1#mixedretained#deviceid_d-1#zone_z")
        yield* devices.update({ channel, deviceId: "d-1" }).set({ status: "on" }).asEffect()
        expect(indexKeys(yield* storedOf("mixedretained", channel))).toEqual(before)
        expect(yield* reach(devices, channel, "z")).toEqual(everywhere)
      }))

    test("the retain path: an item lacking the composite gets no half", (db) =>
      Effect.gen(function* () {
        const channel = nextChannel()
        const devices = db.entities.MixedRetained
        yield* devices.put(device(channel)).asEffect()
        yield* devices.update({ channel, deviceId: "d-1" }).set({ status: "on" }).asEffect()
        const after = indexKeys(yield* storedOf("mixedretained", channel))
        for (const half of ["gsi1sk", "gsi2sk", "gsi3sk", "gsi4pk"]) {
          expect(after[half], half).toBeUndefined()
        }
      }))

    test("the append path: a primary key in appendInput claims no mixed half", (db) =>
      Effect.gen(function* () {
        const channel = nextChannel()
        const devices = db.entities.MixedSeries
        yield* devices.put(device(channel, "z")).asEffect()
        const before = indexKeys(yield* storedOf("mixedseries", channel))
        expect(before.gsi1sk).toBe("$gate#v1#mixedseries#zone_z#deviceid_d-1")
        yield* devices
          .append({
            channel,
            deviceId: "d-1",
            at: DateTime.makeUnsafe("2026-04-30T11:00:00.000Z"),
            status: "on",
          })
          .skipFollowUp()
          .asEffect()
        expect(indexKeys(yield* storedOf("mixedseries", channel))).toEqual(before)
        expect(yield* reach(devices, channel, "z")).toEqual(everywhere)
      }))

    test("a row an earlier release damaged stays as it is until a write names the half", (db) =>
      Effect.gen(function* () {
        const channel = nextChannel()
        const devices = db.entities.MixedDevices
        yield* devices.put(device(channel, "z")).asEffect()
        const client = yield* DynamoClient
        // What 1.37 left behind: the trailing half truncated by an unrelated update.
        yield* client.updateItem({
          TableName: tableName,
          Key: {
            pk: { S: `$gate#v1#mixeddevice#channel_${channel}` },
            sk: { S: "$gate#v1#mixeddevice#deviceid_d-1" },
          },
          UpdateExpression: "SET #half = :truncated REMOVE #gone",
          ExpressionAttributeNames: { "#half": "gsi3sk", "#gone": "gsi1sk" },
          ExpressionAttributeValues: { ":truncated": { S: "$gate#v1#mixeddevice#deviceid_d-1" } },
        })
        yield* devices.update({ channel, deviceId: "d-1" }).set({ status: "on" }).asEffect()
        const damaged = indexKeys(yield* storedOf("mixeddevice", channel))
        expect(damaged.gsi3sk).toBe("$gate#v1#mixeddevice#deviceid_d-1")
        expect(damaged.gsi1sk).toBeUndefined()
        yield* devices.update({ channel, deviceId: "d-1" }).set({ zone: "z" }).asEffect()
        const repaired = indexKeys(yield* storedOf("mixeddevice", channel))
        expect(repaired.gsi3sk).toBe("$gate#v1#mixeddevice#deviceid_d-1#zone_z")
        expect(repaired.gsi1sk).toBe("$gate#v1#mixeddevice#zone_z#deviceid_d-1")
      }))
  })
})
