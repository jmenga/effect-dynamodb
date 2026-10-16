/**
 * Connected integration tests for `EventStore.skipEvent` (#162) against a real
 * DynamoDB Local: `evolve` skips an event without writing the row.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 *
 * Asserts on the raw stored items: a skipped-only batch leaves the item byte
 * for byte as it was; a mixed batch is one write (the revision moves by one);
 * a skipped instance's checkpoint stays as read; an unowned field-mapped
 * checkpoint goes to the instance that writes it.
 */

import { it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Config, Effect, Layer, Option, Schema } from "effect"
import { afterAll, beforeAll, describe, expect } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
import { fromAttributeMap, toAttributeMap } from "../src/Marshaller.js"
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

const AppSchema = DynamoSchema.make({ name: "skip-it", version: 1 })
const suffix = Date.now()
const eventsTableName = `skip-events-${suffix}`
const readTableName = `skip-read-${suffix}`

/** A reading; a negative `value` is one `evolve` skips. */
class Reported extends Schema.TaggedClass<Reported>()("Reported", {
  deviceId: Schema.String,
  value: Schema.Number,
}) {}

const EventsTable = Table.make({ schema: AppSchema, entities: {} })
const Settings = EventStore.makeStream({
  table: EventsTable,
  streamName: "Setting",
  events: [Reported],
  streamId: { composite: ["deviceId"] },
})
const Firmware = EventStore.makeStream({
  table: EventsTable,
  streamName: "Firmware",
  events: [Reported],
  streamId: { composite: ["channel"] },
})

const Setting = Schema.Struct({
  deviceId: Schema.String,
  total: Schema.Number,
  version: Schema.Number,
  rev: Schema.Number,
})
type Setting = typeof Setting.Type

const SettingRows = Entity.make({
  model: Setting,
  entityType: "Setting",
  primaryKey: {
    pk: { field: "pk", composite: ["deviceId"] },
    sk: { field: "sk", composite: [] },
  },
})

const Device = Schema.Struct({
  deviceId: Schema.String,
  setting: Schema.Number,
  firmware: Schema.Number,
  fwVersion: Schema.optional(Schema.Number),
  fwChannel: Schema.optional(Schema.String),
  checkpoints: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
  revision: Schema.Number,
})
type Device = typeof Device.Type

const Devices = Entity.make({
  model: Device,
  entityType: "Device",
  primaryKey: {
    pk: { field: "pk", composite: ["deviceId"] },
    sk: { field: "sk", composite: [] },
  },
})

const ReadTable = Table.make({ schema: AppSchema, entities: { SettingRows, Devices } })

const SettingProjection = EventStore.projection({
  stream: Settings,
  readModel: SettingRows,
  key: (id) => ({ deviceId: id.deviceId }),
  initial: (id): Setting => ({ deviceId: id.deviceId, total: 0, version: 0, rev: 0 }),
  evolve: (state, event) =>
    Effect.succeed(
      event.data.value < 0
        ? EventStore.skipEvent
        : { ...state, total: state.total + event.data.value },
    ),
  checkpoint: "version",
  revision: "rev",
})

const DeviceProjection = EventStore.multiProjection({
  readModel: Devices,
  initial: (key: { readonly deviceId: string }): Device => ({
    deviceId: key.deviceId,
    setting: 0,
    firmware: 0,
    revision: 0,
  }),
  sources: (source) => ({
    setting: source(Settings, {
      key: (id) => ({ deviceId: id.deviceId }),
      evolve: (state, event) =>
        Effect.succeed(
          event.data.value < 0
            ? EventStore.skipEvent
            : { ...state, setting: state.setting + event.data.value },
        ),
    }),
    firmware: source(Firmware, {
      key: (_id, event) => ({ deviceId: event.data.deviceId }),
      evolve: (state, event) =>
        Effect.succeed(
          event.data.value < 0
            ? EventStore.skipEvent
            : { ...state, firmware: state.firmware + event.data.value },
        ),
    }),
  }),
  checkpoints: {
    field: "checkpoints",
    sources: { firmware: { field: "fwVersion", instanceField: "fwChannel" } },
  },
  revision: "revision",
})

const credentials = { accessKeyId: "local", secretAccessKey: "local" }
const TestLayer = Layer.mergeAll(
  DynamoClient.layer({ region: "us-east-1", endpoint: ENDPOINT, credentials }),
  EventsTable.layer({ name: eventsTableName }),
  ReadTable.layer({ name: readTableName }),
)
const provide = Effect.provide(TestLayer)

/** The stored item, unmarshalled — and its raw form, to compare byte for byte. */
const raw = (entityType: string, deviceId: string) =>
  Effect.gen(function* () {
    const client = yield* DynamoClient
    const prefix = `$skip-it#v1#${entityType.toLowerCase()}`
    const { Item } = yield* client.getItem({
      TableName: readTableName,
      Key: toAttributeMap({ pk: `${prefix}#deviceid_${deviceId}`, sk: prefix }),
      ConsistentRead: true,
    })
    return {
      item: Item === undefined ? undefined : (fromAttributeMap(Item) as Record<string, unknown>),
      bytes: JSON.stringify(Item),
    }
  })

/** Append readings to a stream instance; its new events. */
const append = (
  stream: typeof Settings | typeof Firmware,
  id: Record<string, string>,
  deviceId: string,
  values: ReadonlyArray<number>,
) =>
  Effect.gen(function* () {
    const s = stream as typeof Settings
    const before = yield* s.read(id as never)
    yield* s.append(
      id as never,
      values.map((value) => new Reported({ deviceId, value })),
      before.length,
    )
    return (yield* s.read(id as never)).slice(before.length)
  })

const applied = <O extends { readonly _tag: string }>(outcome: O | undefined) => {
  if (outcome?._tag !== "Applied") throw new Error(`not applied: ${JSON.stringify(outcome)}`)
  return outcome as Extract<O, { readonly _tag: "Applied" }>
}

describeConnected("EventStore projections: skipEvent (connected)", () => {
  beforeAll(async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* DynamoClient
        for (const TableName of [eventsTableName, readTableName]) {
          yield* client.createTable({
            TableName,
            BillingMode: "PAY_PER_REQUEST",
            KeySchema: [
              { AttributeName: "pk", KeyType: "HASH" },
              { AttributeName: "sk", KeyType: "RANGE" },
            ],
            AttributeDefinitions: [
              { AttributeName: "pk", AttributeType: "S" },
              { AttributeName: "sk", AttributeType: "S" },
            ],
          })
        }
      }).pipe(provide),
    )
  })

  afterAll(async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* DynamoClient
        for (const TableName of [eventsTableName, readTableName]) {
          yield* client.deleteTable({ TableName }).pipe(Effect.ignore)
        }
      }).pipe(provide),
    )
  })

  it.effect("single source: a skipped-only batch leaves the item byte-identical", () =>
    Effect.gen(function* () {
      const [first] = yield* append(Settings, { deviceId: "s1" }, "s1", [5])
      yield* SettingProjection.apply(first!)
      const before = yield* raw("Setting", "s1")
      const events = yield* append(Settings, { deviceId: "s1" }, "s1", [-1, -2])
      const outcome = applied((yield* SettingProjection.applyBatch(events)).outcomes[0])
      expect((yield* raw("Setting", "s1")).bytes).toBe(before.bytes)
      expect(outcome.applied).toEqual([])
      expect(outcome.skipped.map((e) => e.version)).toEqual([2, 3])
      expect(outcome.version).toBe(1)
      expect(Option.map(outcome.state, (s) => s.rev)).toEqual(Option.some(1))
    }).pipe(provide),
  )

  it.effect("single source: a mixed batch writes once, to the last applied event", () =>
    Effect.gen(function* () {
      const events = yield* append(Settings, { deviceId: "s2" }, "s2", [-1, 2, 3, -4])
      const outcome = applied((yield* SettingProjection.applyBatch(events)).outcomes[0])
      expect(outcome.skipped.map((e) => e.version)).toEqual([1, 4])
      expect((yield* raw("Setting", "s2")).item).toMatchObject({ total: 5, version: 3, rev: 1 })
    }).pipe(provide),
  )

  it.effect("single source: the gap-fill decides a skipped event again", () =>
    Effect.gen(function* () {
      const [v1] = yield* append(Settings, { deviceId: "s3" }, "s3", [-1])
      const skipped = yield* SettingProjection.apply(v1!)
      expect(skipped.skipped.map((e) => e.version)).toEqual([1])
      expect((yield* raw("Setting", "s3")).item).toBeUndefined()

      const [v2] = yield* append(Settings, { deviceId: "s3" }, "s3", [2])
      const outcome = yield* SettingProjection.apply(v2!)
      expect(outcome.skipped.map((e) => e.version)).toEqual([1])
      expect(outcome.applied.map((e) => e.version)).toEqual([2])
      expect(outcome.version).toBe(2)
      expect((yield* raw("Setting", "s3")).item).toMatchObject({ total: 2, version: 2, rev: 1 })
    }).pipe(provide),
  )

  it.effect("multi source: a skipped-only batch leaves the item byte-identical", () =>
    Effect.gen(function* () {
      const [setting] = yield* append(Settings, { deviceId: "m1" }, "m1", [5])
      yield* DeviceProjection.applyBatch([{ stream: "setting", event: setting! }])
      const before = yield* raw("Device", "m1")
      const events = yield* append(Firmware, { channel: "m1-stable" }, "m1", [-1])
      const outcome = applied(
        (yield* DeviceProjection.applyBatch([{ stream: "firmware", event: events[0]! }]))
          .outcomes[0],
      )
      expect((yield* raw("Device", "m1")).bytes).toBe(before.bytes)
      expect(outcome.revision).toBe(1)
      expect(outcome.instances[0]!.applied).toEqual([])
      expect(outcome.instances[0]!.skipped.map((e) => e.version)).toEqual([1])
    }).pipe(provide),
  )

  it.effect("multi source: a mixed row is one write; the skipped instance's checkpoint stays", () =>
    Effect.gen(function* () {
      const [first] = yield* append(Settings, { deviceId: "m2" }, "m2", [5])
      yield* DeviceProjection.applyBatch([{ stream: "setting", event: first! }])
      expect((yield* raw("Device", "m2")).item).toMatchObject({
        revision: 1,
        checkpoints: { "setting#m2": 1 },
      })

      const [skipped] = yield* append(Settings, { deviceId: "m2" }, "m2", [-1])
      const [fw] = yield* append(Firmware, { channel: "m2-beta" }, "m2", [7])
      const outcome = applied(
        (yield* DeviceProjection.applyBatch([
          { stream: "setting", event: skipped! },
          { stream: "firmware", event: fw! },
        ])).outcomes[0],
      )
      expect(outcome.revision).toBe(2)
      const { item } = yield* raw("Device", "m2")
      expect(item).toMatchObject({
        setting: 5,
        firmware: 7,
        revision: 2,
        fwVersion: 1,
        fwChannel: "m2-beta",
        checkpoints: { "setting#m2": 1 },
      })
    }).pipe(provide),
  )

  it.effect("multi source: a skipped-only instance doesn't adopt an unowned field", () =>
    Effect.gen(function* () {
      // "m3-a" sorts first; its only event is skipped
      const [a] = yield* append(Firmware, { channel: "m3-a" }, "m3", [-1])
      const [b] = yield* append(Firmware, { channel: "m3-b" }, "m3", [4])
      yield* DeviceProjection.applyBatch([
        { stream: "firmware", event: a! },
        { stream: "firmware", event: b! },
      ])
      const { item } = yield* raw("Device", "m3")
      expect(item).toMatchObject({ firmware: 4, fwVersion: 1, fwChannel: "m3-b", revision: 1 })
      expect(item!.checkpoints).toBeUndefined()

      // Alone, a skipped-only instance writes nothing at all
      const [c] = yield* append(Firmware, { channel: "m3-c" }, "m4", [-1])
      yield* DeviceProjection.applyBatch([{ stream: "firmware", event: c! }])
      expect((yield* raw("Device", "m4")).item).toBeUndefined()
    }).pipe(provide),
  )
})
