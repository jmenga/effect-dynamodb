/**
 * `EventStore.skipEvent` (#162): `evolve` skips an event without writing the
 * row — on single-source and multi-source projections, against the in-memory
 * tables in `helpers/InMemoryTables.ts`.
 *
 * - A row whose events are all skipped (or already applied) isn't written,
 *   and its revision and checkpoints stay as read.
 * - A skipped event is reported in `skipped`, never `applied`, and produces no
 *   outbox effects.
 * - An instance's checkpoint is its last applied or rejected event: skipped
 *   events below it are covered, a trailing run of them isn't, and an
 *   uncovered one is decided again by the next gap-fill.
 * - `latest` falls back past a skipped newest event, as past a rejection.
 * - An unowned field-mapped checkpoint is adopted by the first instance that
 *   writes it — not by one whose events were all skipped, or that failed.
 */

import { describe, expect, it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Data, Effect, Layer, Option, Schema } from "effect"
import { beforeEach } from "vitest"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
import { fromAttributeMap } from "../src/Marshaller.js"
import * as Table from "../src/Table.js"
import { calls, InMemoryClient, resetCalls, resetStore, store } from "./helpers/InMemoryTables.js"

const AppSchema = DynamoSchema.make({ name: "skip", version: 1 })
const EventsTable = Table.make({ schema: AppSchema, entities: {} })

/** A reading; a negative `value` is one `evolve` skips. */
class Reported extends Schema.TaggedClass<Reported>()("Reported", {
  deviceId: Schema.String,
  value: Schema.Number,
}) {}

class Broken extends Data.TaggedError("Broken")<{ readonly version: number }> {}
class Refused extends Data.TaggedError("Refused")<{ readonly version: number }> {}

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
const Status = EventStore.makeStream({
  table: EventsTable,
  streamName: "Status",
  events: [Reported],
  streamId: { composite: ["deviceId"] },
})

// ---------------------------------------------------------------------------
// Single-source
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Multi-source
// ---------------------------------------------------------------------------

const Device = Schema.Struct({
  deviceId: Schema.String,
  setting: Schema.Number,
  firmware: Schema.Number,
  status: Schema.Number,
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

/** Every `effects` call, to show a skipped event produces none. */
const effectCalls: Array<number> = []

const settingBase = {
  stream: Settings,
  readModel: SettingRows,
  key: (id: { readonly deviceId: string }) => ({ deviceId: id.deviceId }),
  initial: (id: { readonly deviceId: string }): Setting => ({
    deviceId: id.deviceId,
    total: 0,
    version: 0,
    rev: 0,
  }),
  evolve: (state: Setting, event: EventStore.StreamEvent<Reported>) =>
    event.data.value === 0
      ? Effect.fail(new Refused({ version: event.version }))
      : Effect.succeed(
          event.data.value < 0
            ? EventStore.skipEvent
            : { ...state, total: state.total + event.data.value },
        ),
  terminal: (error: Refused) => error._tag === "Refused",
  checkpoint: "version" as const,
}

const SettingProjection = EventStore.projection({ ...settingBase, revision: "rev" })
/** No revision: writes are guarded by the scalar checkpoint. */
const UnrevisionedSetting = EventStore.projection(settingBase)
const NotifyingSetting = EventStore.projection({
  ...settingBase,
  revision: "rev",
  outbox: {
    schema: Schema.Struct({ deviceId: Schema.String, total: Schema.Number }),
    effects: (event, next) => {
      effectCalls.push(event.version)
      return [{ deviceId: event.data.deviceId, total: next?.total ?? -1 }]
    },
  },
})

const skipNegative =
  <F extends "setting" | "firmware" | "status">(field: F) =>
  (state: Device, event: EventStore.StreamEvent<Reported>) =>
    event.data.value < 0
      ? Effect.succeed(EventStore.skipEvent)
      : Effect.succeed({ ...state, [field]: state[field] + event.data.value })

const deviceConfig = {
  readModel: Devices,
  initial: (key: { readonly deviceId: string }): Device => ({
    deviceId: key.deviceId,
    setting: 0,
    firmware: 0,
    status: 0,
    revision: 0,
  }),
  sources: (source: EventStore.SourceBuilder<{ readonly deviceId: string }, Device>) => ({
    setting: source(Settings, {
      key: (id) => ({ deviceId: id.deviceId }),
      evolve: skipNegative("setting"),
    }),
    firmware: source(Firmware, {
      key: (_id, event) => ({ deviceId: event.data.deviceId }),
      evolve: (state, event) =>
        event.data.value === 99
          ? Effect.fail(new Broken({ version: event.version }))
          : skipNegative("firmware")(state, event),
    }),
    status: source(Status, {
      key: (id) => ({ deviceId: id.deviceId }),
      // The newest reading carries the whole status.
      evolve: (state, event) =>
        Effect.succeed(
          event.data.value < 0 ? EventStore.skipEvent : { ...state, status: event.data.value },
        ),
      mode: "latest",
    }),
  }),
  revision: "revision" as const,
}

const DeviceProjection = EventStore.multiProjection({
  ...deviceConfig,
  checkpoints: {
    field: "checkpoints",
    sources: { firmware: { field: "fwVersion", instanceField: "fwChannel" } },
  },
})
/** Firmware alone, field-mapped, and no map: a second instance has nowhere else to go. */
const MaplessFirmware = EventStore.multiProjection({
  ...deviceConfig,
  sources: (source: EventStore.SourceBuilder<{ readonly deviceId: string }, Device>) => ({
    firmware: deviceConfig.sources(source).firmware,
  }),
  checkpoints: { sources: { firmware: { field: "fwVersion", instanceField: "fwChannel" } } },
})

const TestLayer = Layer.mergeAll(
  InMemoryClient,
  EventsTable.layer({ name: "events" }),
  ReadTable.layer({ name: "read" }),
)

beforeEach(() => {
  resetStore()
  effectCalls.length = 0
})

const readItems = () =>
  [...store.entries()]
    .filter(([k]) => k.startsWith("read|"))
    .map(([, item]) => fromAttributeMap(item) as Record<string, unknown>)

const rowOf = (deviceId: string) =>
  readItems().find((item) => item.deviceId === deviceId && item.__edd_e__ !== undefined)

/** The stored row's raw item, to compare byte for byte. */
const rawRow = (deviceId: string) =>
  JSON.stringify(
    [...store.entries()].find(
      ([k, item]) => k.startsWith("read|") && item.deviceId?.S === deviceId,
    ),
  )

/** Append readings of `values` to a stream instance; its new events, decoded. */
const append = (
  stream: typeof Settings | typeof Firmware | typeof Status,
  id: Record<string, string>,
  values: ReadonlyArray<number>,
) =>
  Effect.gen(function* () {
    // The three streams share one event type; their stream ids differ.
    const s = stream as typeof Settings
    const before = yield* s.read(id as never)
    yield* s.append(
      id as never,
      values.map((value) => new Reported({ deviceId: "d1", value })),
      before.length,
    )
    const events = yield* s.read(id as never)
    resetCalls()
    return events.slice(before.length)
  })

const writes = () => calls.putItem + calls.transactWriteItems

const applied = <O extends { readonly _tag: string }>(outcome: O | undefined) => {
  if (outcome?._tag !== "Applied") throw new Error(`not applied: ${JSON.stringify(outcome)}`)
  return outcome as Extract<O, { readonly _tag: "Applied" }>
}

// ---------------------------------------------------------------------------

describe("projection skipEvent — single source", () => {
  it.effect("a skipped-only batch writes nothing and reports `skipped`", () =>
    Effect.gen(function* () {
      const [first] = yield* append(Settings, { deviceId: "d1" }, [5])
      yield* SettingProjection.apply(first!)
      const before = rawRow("d1")
      const events = yield* append(Settings, { deviceId: "d1" }, [-1, -2])
      const result = yield* SettingProjection.applyBatch(events)
      const outcome = applied(result.outcomes[0])
      expect(writes()).toBe(0)
      expect(rawRow("d1")).toBe(before)
      expect(outcome.applied).toEqual([])
      expect(outcome.skipped.map((e) => e.version)).toEqual([2, 3])
      expect(outcome.version).toBe(1)
      expect(Option.map(outcome.state, (s) => [s.total, s.rev])).toEqual(Option.some([5, 1]))
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("skipped events alone don't create a row", () =>
    Effect.gen(function* () {
      const events = yield* append(Settings, { deviceId: "d1" }, [-1])
      const outcome = applied((yield* SettingProjection.applyBatch(events)).outcomes[0])
      expect(writes()).toBe(0)
      expect(rowOf("d1")).toBeUndefined()
      expect(outcome.state).toEqual(Option.none())
      expect(outcome.version).toBe(0)
      expect(outcome.skipped.map((e) => e.version)).toEqual([1])
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("a mixed batch writes once; a trailing skip stays above the checkpoint", () =>
    Effect.gen(function* () {
      const events = yield* append(Settings, { deviceId: "d1" }, [-1, 2, 3, -4])
      const outcome = applied((yield* SettingProjection.applyBatch(events)).outcomes[0])
      expect(writes()).toBe(1)
      expect(outcome.applied.map((e) => e.version)).toEqual([2, 3])
      expect(outcome.skipped.map((e) => e.version)).toEqual([1, 4])
      // v1 is covered by v3; v4 is not
      expect(outcome.version).toBe(3)
      expect(rowOf("d1")).toMatchObject({ total: 5, version: 3, rev: 1 })

      // Redelivered, v4 is decided again — skipped again, nothing written
      resetCalls()
      const again = applied((yield* SettingProjection.applyBatch([events[3]!])).outcomes[0])
      expect(writes()).toBe(0)
      expect(again.alreadyApplied).toEqual([])
      expect(again.skipped.map((e) => e.version)).toEqual([4])
      expect(again.version).toBe(3)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("the next gap-fill reads an uncovered skipped event and decides it again", () =>
    Effect.gen(function* () {
      const [v1] = yield* append(Settings, { deviceId: "d1" }, [-1])
      yield* SettingProjection.apply(v1!)
      const [v2] = yield* append(Settings, { deviceId: "d1" }, [2])
      const outcome = yield* SettingProjection.apply(v2!)
      expect(calls.query).toBe(1) // the gap-fill
      expect(outcome.skipped.map((e) => e.version)).toEqual([1])
      expect(outcome.applied.map((e) => e.version)).toEqual([2])
      expect(outcome.version).toBe(2)
      expect(rowOf("d1")).toMatchObject({ total: 2, version: 2, rev: 1 })
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("a rejection still writes an existing row and moves its checkpoint", () =>
    Effect.gen(function* () {
      const [first] = yield* append(Settings, { deviceId: "d1" }, [5])
      yield* SettingProjection.apply(first!)
      const events = yield* append(Settings, { deviceId: "d1" }, [-1, 0, -2])
      const outcome = applied((yield* SettingProjection.applyBatch(events)).outcomes[0])
      expect(writes()).toBe(1)
      expect(outcome.rejected.map((r) => r.event.version)).toEqual([3])
      expect(outcome.skipped.map((e) => e.version)).toEqual([2, 4])
      expect(outcome.version).toBe(3)
      expect(rowOf("d1")).toMatchObject({ version: 3, rev: 2 })
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("without a revision, a skipped-only batch writes nothing", () =>
    Effect.gen(function* () {
      const [first] = yield* append(Settings, { deviceId: "d1" }, [5])
      yield* UnrevisionedSetting.apply(first!)
      const before = rawRow("d1")
      const events = yield* append(Settings, { deviceId: "d1" }, [-1])
      const outcome = applied((yield* UnrevisionedSetting.applyBatch(events)).outcomes[0])
      expect(writes()).toBe(0)
      expect(rawRow("d1")).toBe(before)
      expect(outcome.version).toBe(1)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("a skipped event produces no outbox effects", () =>
    Effect.gen(function* () {
      const events = yield* append(Settings, { deviceId: "d1" }, [1, -2, 3])
      const outcome = applied((yield* NotifyingSetting.applyBatch(events)).outcomes[0])
      expect(effectCalls).toEqual([1, 3])
      expect(outcome.enqueued).toBe(2)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect(
    "catchUp and rebuild report `skipped`; the checkpoint is the last non-skipped event",
    () =>
      Effect.gen(function* () {
        yield* append(Settings, { deviceId: "d1" }, [1, -2, 3, -4])
        const caught = yield* SettingProjection.catchUp({ deviceId: "d1" })
        expect(caught.applied.map((e) => e.version)).toEqual([1, 3])
        expect(caught.skipped.map((e) => e.version)).toEqual([2, 4])
        expect(caught.version).toBe(3)

        const { rows } = yield* SettingProjection.rebuild({ deviceId: "d1" })
        expect(rows[0]!.skipped.map((e) => e.version)).toEqual([2, 4])
        expect(rows[0]!.version).toBe(3)
        expect(rowOf("d1")).toMatchObject({ total: 4, version: 3 })
      }).pipe(Effect.provide(TestLayer)),
  )
})

describe("projection skipEvent — multi source", () => {
  it.effect("a skipped-only row is not written; revision and map stay as read", () =>
    Effect.gen(function* () {
      const [s1] = yield* append(Settings, { deviceId: "d1" }, [5])
      yield* DeviceProjection.applyBatch([{ stream: "setting", event: s1! }])
      const before = rawRow("d1")
      const events = yield* append(Firmware, { channel: "stable" }, [-1, -2])
      const result = yield* DeviceProjection.applyBatch(
        events.map((event) => ({ stream: "firmware" as const, event })),
      )
      const outcome = applied(result.outcomes[0])
      expect(writes()).toBe(0)
      expect(rawRow("d1")).toBe(before)
      expect(outcome.revision).toBe(1)
      expect(outcome.instances).toMatchObject([{ source: "firmware", applied: [], version: 0 }])
      expect(outcome.instances[0]!.skipped.map((e) => e.version)).toEqual([1, 2])
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("a row mixing a skipped instance and an applied one writes once", () =>
    Effect.gen(function* () {
      const setting = yield* append(Settings, { deviceId: "d1" }, [5])
      const firmware = yield* append(Firmware, { channel: "beta" }, [-1])
      const result = yield* DeviceProjection.applyBatch([
        { stream: "setting", event: setting[0]! },
        { stream: "firmware", event: firmware[0]! },
      ])
      const outcome = applied(result.outcomes[0])
      expect(writes()).toBe(1)
      expect(outcome.revision).toBe(1)
      const row = rowOf("d1")!
      expect(row).toMatchObject({ setting: 5, firmware: 0, revision: 1 })
      // The skipped instance adopted nothing and has no map entry
      expect(row.fwVersion).toBeUndefined()
      expect(row.fwChannel).toBeUndefined()
      expect(row.checkpoints).toEqual({ "setting#d1": 1 })
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("an absent map stays absent when the only map instance skipped", () =>
    Effect.gen(function* () {
      const setting = yield* append(Settings, { deviceId: "d1" }, [-5])
      const firmware = yield* append(Firmware, { channel: "beta" }, [2])
      yield* DeviceProjection.applyBatch([
        { stream: "setting", event: setting[0]! },
        { stream: "firmware", event: firmware[0]! },
      ])
      const row = rowOf("d1")!
      expect(row).toMatchObject({ firmware: 2, fwVersion: 1, fwChannel: "beta" })
      expect(row.checkpoints).toBeUndefined()
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("`latest` falls back past a skipped newest event", () =>
    Effect.gen(function* () {
      const events = yield* append(Status, { deviceId: "d1" }, [1, 2, -3])
      const result = yield* DeviceProjection.applyBatch(
        events.map((event) => ({ stream: "status" as const, event })),
      )
      const instance = applied(result.outcomes[0]).instances[0]!
      expect(instance.applied.map((e) => e.version)).toEqual([2])
      expect(instance.superseded.map((e) => e.version)).toEqual([1])
      expect(instance.skipped.map((e) => e.version)).toEqual([3])
      expect(instance.version).toBe(2)
      expect(rowOf("d1")).toMatchObject({ status: 2, checkpoints: { "status#d1": 2 } })
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("an unowned field is adopted by the first instance that writes it", () =>
    Effect.gen(function* () {
      // "alpha" sorts first, and every one of its events is skipped
      const alpha = yield* append(Firmware, { channel: "alpha" }, [-1])
      const beta = yield* append(Firmware, { channel: "beta" }, [4, 5])
      const result = yield* DeviceProjection.applyBatch([
        { stream: "firmware", event: alpha[0]! },
        ...beta.map((event) => ({ stream: "firmware" as const, event })),
      ])
      const outcome = applied(result.outcomes[0])
      expect(writes()).toBe(1)
      const row = rowOf("d1")!
      expect(row).toMatchObject({ firmware: 9, fwVersion: 2, fwChannel: "beta" })
      expect(row.checkpoints).toBeUndefined()
      const byStream = Object.fromEntries(outcome.instances.map((i) => [i.streamId, i]))
      expect(byStream.alpha!.skipped.map((e) => e.version)).toEqual([1])
      expect(byStream.beta!.version).toBe(2)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("…also without a map, where the other instance would have conflicted", () =>
    Effect.gen(function* () {
      const alpha = yield* append(Firmware, { channel: "alpha" }, [-1])
      const beta = yield* append(Firmware, { channel: "beta" }, [4])
      const result = yield* MaplessFirmware.applyBatch([
        { stream: "firmware", event: alpha[0]! },
        { stream: "firmware", event: beta[0]! },
      ])
      expect(result.failedPositions).toEqual([])
      expect(rowOf("d1")).toMatchObject({ firmware: 4, fwVersion: 1, fwChannel: "beta" })
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("an instance that fails releases the unowned field it adopted", () =>
    Effect.gen(function* () {
      const alpha = yield* append(Firmware, { channel: "alpha" }, [99])
      const beta = yield* append(Firmware, { channel: "beta" }, [4])
      const result = yield* MaplessFirmware.applyBatch([
        { stream: "firmware", event: alpha[0]! },
        { stream: "firmware", event: beta[0]! },
      ])
      // alpha fails on its own; beta takes the field instead of conflicting
      expect(result.outcomes.map((o) => o._tag).sort()).toEqual(["Applied", "Failed"])
      const failed = result.outcomes.find((o) => o._tag === "Failed")!
      expect(failed._tag === "Failed" && (failed.error as Broken)._tag).toBe("Broken")
      expect(rowOf("d1")).toMatchObject({ firmware: 4, fwVersion: 1, fwChannel: "beta" })
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("rebuild gives a skipped-only instance no checkpoint", () =>
    Effect.gen(function* () {
      yield* append(Settings, { deviceId: "d1" }, [5])
      yield* append(Firmware, { channel: "alpha" }, [-1])
      const rebuilt = yield* DeviceProjection.rebuild(
        { deviceId: "d1" },
        { instances: { setting: [{ deviceId: "d1" }], firmware: [{ channel: "alpha" }] } },
      )
      expect(rebuilt.instances.find((i) => i.source === "firmware")!.skipped).toHaveLength(1)
      const row = rowOf("d1")!
      expect(row).toMatchObject({ setting: 5, checkpoints: { "setting#d1": 1 } })
      expect(row.fwChannel).toBeUndefined()
      expect(row.fwVersion).toBeUndefined()
    }).pipe(Effect.provide(TestLayer)),
  )
})
