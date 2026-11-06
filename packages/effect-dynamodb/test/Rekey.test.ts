/**
 * `db.tables.<Table>.rekey()` (#171) — request capture.
 *
 * Rows are written by 1.37 into a recording in-memory table, then rewritten
 * as 1.36 wrote them (`KeyText136`), next to rows under their current keys,
 * and `rekey` runs over the table:
 *
 * - **Every row kind.** Items (with their unique sentinels), version
 *   snapshots, tombstones, time-series events and event streams move to the
 *   keys a 1.37 write gives them; index keys and sentinels holding 1.36 text
 *   are rewritten in place; a dry run counts the same and writes nothing; a
 *   rerun moves nothing.
 * - **Conflicts and skips.** A row under both keys is reported and left;
 *   rows no member owns are counted by reason.
 * - **The scan.** Segments, page budgets, resume tokens (`EDD-9098` for a bad
 *   one) and the consumed-capacity report.
 * - **Tombstones' sentinels.** The sentinels a soft-deleted item kept
 *   (`preserveUnique`) move to their current keys and name the item's
 *   current key: with the fallback off, the values stay taken and the item
 *   restores.
 * - **Streams.** An append (events, or a command sentinel alone) or snapshot
 *   write that located a stream under its 1.36 key before `rekey` moved it
 *   doesn't write there; a stream id holding `#` moves; rows left under a
 *   moved stream's 1.36 key move after it, a newer snapshot winning; a
 *   command sentinel whose TTL has passed holds no key.
 *
 * `connected.rekey.test.ts` runs a full table through DynamoDB Local.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { describe, expect, it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import * as KeyText136 from "@effect-dynamodb/schema/internal/KeyText136.js"
import * as KeyComposer from "@effect-dynamodb/schema/KeyComposer.js"
import { Effect, Layer, Option, Schema } from "effect"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
import { toAttributeMap } from "../src/Marshaller.js"
import * as Table from "../src/Table.js"
import { clientLayer, serviceOf, withConsumedCapacity } from "./helpers/CapacityMock.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"
import { rekeyOutcome } from "./helpers/RekeyOutcome.js"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

class Meter extends Schema.Class<Meter>("Meter")({
  site: Schema.String,
  meterId: Schema.Number,
  serial: Schema.Number,
  zone: Schema.String,
  reading: Schema.Number,
  label: Schema.String,
}) {}

class Doc extends Schema.Class<Doc>("Doc")({
  docId: Schema.Number,
  title: Schema.String,
}) {}

class Gauge extends Schema.Class<Gauge>("Gauge")({
  gaugeId: Schema.Number,
  at: Schema.Number,
  level: Schema.Number,
}) {}

class Badge extends Schema.Class<Badge>("Badge")({
  owner: Schema.String,
  tag: Schema.String,
  code: Schema.Number,
}) {}

class Card extends Schema.Class<Card>("Card")({
  cardId: Schema.Number,
  name: Schema.String,
}) {}

class Deposited extends Schema.TaggedClass<Deposited>()("Deposited", {
  amount: Schema.Number,
}) {}

const world = (schema: DynamoSchema.DynamoSchema) => {
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
        sk: { field: "gsi1sk", composite: ["reading", "label"] },
      },
      bySite: {
        name: "gsi2",
        pk: { field: "gsi2pk", composite: ["site"] },
        sk: { field: "gsi2sk", composite: [] },
      },
    },
    unique: { serial: ["serial"] },
    timestamps: true,
    versioned: true,
  })
  const Docs = Entity.make({
    model: Doc,
    entityType: "Doc",
    primaryKey: {
      pk: { field: "pk", composite: ["docId"] },
      sk: { field: "sk", composite: [] },
    },
    timestamps: true,
    versioned: { retain: true },
    softDelete: true,
  })
  const Gauges = Entity.make({
    model: Gauge,
    entityType: "Gauge",
    primaryKey: {
      pk: { field: "pk", composite: ["gaugeId"] },
      sk: { field: "sk", composite: [] },
    },
    timeSeries: {
      orderBy: "at",
      appendInput: Schema.Struct({
        gaugeId: Schema.Number,
        at: Schema.Number,
        level: Schema.Number,
      }),
    },
  })
  // Soft-deleted with their reservations kept: a badge's key text is the
  // same as 1.36's and its unique value's is not; a card's the other way.
  const Badges = Entity.make({
    model: Badge,
    entityType: "Badge",
    primaryKey: {
      pk: { field: "pk", composite: ["owner"] },
      sk: { field: "sk", composite: ["tag"] },
    },
    unique: { code: ["code"] },
    softDelete: { preserveUnique: true },
  })
  const Cards = Entity.make({
    model: Card,
    entityType: "Card",
    primaryKey: {
      pk: { field: "pk", composite: ["cardId"] },
      sk: { field: "sk", composite: [] },
    },
    unique: { name: ["name"] },
    softDelete: { preserveUnique: true },
  })
  const MainTable = Table.make({ schema, entities: { Meters, Docs, Gauges, Badges, Cards } })
  const Ledger = EventStore.makeStream({
    table: MainTable,
    streamName: "Ledger",
    events: [Deposited],
    streamId: { composite: ["ledgerId"] },
  })
  // The ledger, as a writer with a snapshot config sees it.
  const SnappedLedger = EventStore.makeStream({
    table: MainTable,
    streamName: "Ledger",
    events: [Deposited],
    streamId: { composite: ["ledgerId"] },
    snapshot: { schema: Schema.Struct({ total: Schema.Number }) },
  })
  // A stream id of two composites, the first a string that may hold `#`.
  const Accounts = EventStore.makeStream({
    table: MainTable,
    streamName: "Accounts",
    events: [Deposited],
    streamId: { composite: ["tenant", "n"] },
  })
  return {
    schema,
    Meters,
    Docs,
    Gauges,
    Badges,
    Cards,
    MainTable,
    Ledger,
    SnappedLedger,
    Accounts,
  }
}

const On = world(DynamoSchema.make({ name: "rekey", version: 1 }))
const Off = world(DynamoSchema.make({ name: "rekey", version: 1, legacyKeys: false }))
type World = typeof On

const clientOf = (w: World) =>
  DynamoClient.make({
    entities: {
      Meters: w.Meters,
      Docs: w.Docs,
      Gauges: w.Gauges,
      Badges: w.Badges,
      Cards: w.Cards,
    },
    tables: { MainTable: w.MainTable },
  })

type Recording = ReturnType<typeof makeRecordingTable>

const layerOf = (w: World, table: Recording, client?: Layer.Layer<DynamoClient>) =>
  Layer.mergeAll(client ?? table.layer, w.MainTable.layer({ name: "t" }))

/** Stream ids are typed as strings; a number — an untyped caller's — is the one whose text changed. */
const ledger = (id: number | string) =>
  ({ ledgerId: id }) as unknown as { readonly ledgerId: string }

const at = (key: Record<string, string>) => `${key.pk}|${key.sk}`

/** Move the row at `from` to `to` (both `pk|sk` strings), with `change` applied. */
const relocate = (
  table: Recording,
  from: string,
  to: Record<string, string>,
  change: (row: Record<string, AttributeValue>) => Record<string, AttributeValue> = (row) => row,
) => {
  const row = table.items.get(from)
  expect(row, from).toBeDefined()
  table.items.delete(from)
  table.items.set(at(to), change({ ...row!, ...toAttributeMap(to) }))
}

const meter = (site: string, meterId: number, serial: number) => ({
  site,
  meterId,
  serial,
  zone: "z",
  reading: -2.5,
  label: "a b",
})

const meterKeys = (w: World, record: Record<string, unknown>) => ({
  current: KeyComposer.composeIndexKeys(
    w.schema,
    "Meter",
    1,
    w.Meters.indexes.primary,
    record,
  ) as Record<string, string>,
  old: KeyText136.composeIndexKeys(w.schema, "Meter", 1, w.Meters.indexes.primary, record),
})

/** A unique constraint's sentinel keys for `value`: now, and as 1.36 composed them. */
const uniqueKeys = (w: World, entityType: string, constraint: string, value: string | number) => {
  const current = DynamoSchema.composeUniqueKey(w.schema, entityType, constraint, [
    KeyComposer.serializeValue(value),
  ])
  const old = KeyText136.composeUniqueKey(w.schema, entityType, constraint, [value])
  return { current: { pk: current.pk, sk: current.sk }, old: { pk: old.pk, sk: old.sk } }
}

const sentinelKeys = (w: World, value: number) => uniqueKeys(w, "Meter", "serial", value)

/** A meter as 1.36 wrote it: its primary and GSI keys, and its sentinel, in 1.36 text. */
const demoteMeter = (table: Recording, w: World, record: ReturnType<typeof meter>) => {
  const { current, old } = meterKeys(w, record)
  expect(old).not.toEqual(current)
  const gsi = KeyText136.composeAllKeys(w.schema, "Meter", 1, w.Meters.indexes, record)
  relocate(table, at(current), old, (row) => ({ ...row, ...toAttributeMap(gsi) }))
  const sentinel = sentinelKeys(w, record.serial)
  relocate(table, at(sentinel.current), sentinel.old, (row) => ({
    ...row,
    ...toAttributeMap({ _entity_pk: old.pk, _entity_sk: old.sk }),
  }))
  return { current, old, sentinel }
}

/** Every row of partition `from`, moved to partition `to`. */
const demotePartition = (table: Recording, from: string, to: string) => {
  const keys = [...table.items.keys()].filter((key) => key.startsWith(`${from}|`))
  expect(keys.length).toBeGreaterThan(0)
  for (const key of keys) {
    const sk = key.slice(from.length + 1)
    relocate(table, key, { pk: to, sk })
  }
  return keys.length
}

const docPk = (w: World, docId: number) => ({
  now: KeyComposer.composePk(w.schema, "Doc", w.Docs.indexes.primary, { docId }),
  old: KeyText136.composePk(w.schema, "Doc", w.Docs.indexes.primary, { docId }),
})
const gaugePk = (w: World, gaugeId: number) => ({
  now: KeyComposer.composePk(w.schema, "Gauge", w.Gauges.indexes.primary, { gaugeId }),
  old: KeyText136.composePk(w.schema, "Gauge", w.Gauges.indexes.primary, { gaugeId }),
})
const ledgerPk = (w: World, id: number) => ({
  now: DynamoSchema.composeKey(w.schema, "Ledger", [KeyComposer.serializeValue(id)]),
  old: DynamoSchema.composeKey(w.schema, "Ledger", [KeyText136.serializeValue(id)]),
})
const cardPk = (w: World, cardId: number) => ({
  now: KeyComposer.composePk(w.schema, "Card", w.Cards.indexes.primary, { cardId }),
  old: KeyText136.composePk(w.schema, "Card", w.Cards.indexes.primary, { cardId }),
})

/**
 * The table every test starts from: one row set per kind under its 1.36
 * keys, one under its current keys, and a meter whose index keys and
 * sentinel alone hold 1.36 text.
 */
const seed = (w: World, table: Recording) =>
  Effect.gen(function* () {
    const db = yield* clientOf(w)
    // Items: one moved, one current, one with only index keys and sentinel stale.
    yield* db.entities.Meters.put(meter("s", -7, -1001)).asEffect()
    yield* db.entities.Meters.put(meter("s", 8, 2002)).asEffect()
    yield* db.entities.Meters.put(meter("s", 9, -3003)).asEffect()
    // History: two snapshots and a tombstone; time-series: an item and two events.
    yield* db.entities.Docs.put({ docId: -5, title: "v1" }).asEffect()
    yield* db.entities.Docs.update({ docId: -5 }).set({ title: "v2" }).asEffect()
    yield* db.entities.Docs.delete({ docId: -5 }).asEffect()
    for (const at of [1, 2]) {
      yield* db.entities.Gauges.append({ gaugeId: -6, at, level: at }).asEffect()
    }
    // A stream of three events, and one of its own under its current key.
    yield* w.Ledger.append(
      ledger(-4),
      [1, 2, 3].map((amount) => new Deposited({ amount })),
      0,
    )
    yield* w.Ledger.append(ledger(-9), [new Deposited({ amount: 1 })], 0)
  }).pipe(
    Effect.provide(layerOf(w, table)),
    Effect.map(() => {
      const m = demoteMeter(table, w, meter("s", -7, -1001))
      // Meter 9: primary key text unchanged; index keys and sentinel in 1.36 text.
      const stale = meter("s", 9, -3003)
      const current = meterKeys(w, stale).current
      const gsi = KeyText136.composeAllKeys(w.schema, "Meter", 1, w.Meters.indexes, stale)
      table.items.set(at(current), {
        ...table.items.get(at(current))!,
        ...toAttributeMap({ gsi1pk: gsi.gsi1pk, gsi1sk: gsi.gsi1sk }),
      })
      const sentinel = sentinelKeys(w, -3003)
      relocate(table, at(sentinel.current), sentinel.old)
      demotePartition(table, docPk(w, -5).now, docPk(w, -5).old)
      demotePartition(table, gaugePk(w, -6).now, gaugePk(w, -6).old)
      demotePartition(table, ledgerPk(w, -4).now, ledgerPk(w, -4).old)
      return { meter: m, staleMeter: current }
    }),
  )

/** Run `rekey` over the table. */
const rekey = (w: World, table: Recording, options?: Table.RekeyOptions) =>
  Effect.gen(function* () {
    const db = yield* clientOf(w)
    return yield* db.tables.MainTable.rekey({ streams: [w.Ledger], ...options })
  }).pipe(Effect.provide(layerOf(w, table)))

const snapshot = (table: Recording) => new Map(table.items)

const ZERO = { item: 0, snapshot: 0, tombstone: 0, outbox: 0, event: 0, aggregate: 0, stream: 0 }

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("rekey — every row kind", () => {
  it.effect("a dry run counts what would move and writes nothing", () =>
    Effect.gen(function* () {
      const table = makeRecordingTable()
      yield* seed(On, table)
      const before = snapshot(table)
      table.take()
      const report = yield* rekey(On, table, { dryRun: true })
      expect(report.dryRun).toBe(true)
      expect(report.moved).toEqual({
        ...ZERO,
        item: 2, // meter -7, the doc's live item is a tombstone now; the gauge's current item
        snapshot: 2,
        tombstone: 1,
        event: 2,
        stream: 3,
      })
      expect(report.indexKeysRewritten).toBe(1)
      expect(report.sentinelsMoved).toBe(2)
      expect(report.conflicts).toEqual([])
      expect(report.resume).toEqual(Option.none())
      expect(report.scanned).toBe(before.size)
      expect(table.requests.every((r) => ["Scan", "GetItem", "Query"].includes(r.command))).toBe(
        true,
      )
      expect(table.items).toEqual(before)
    }),
  )

  it.effect("a run moves every row to the key a 1.37 write gives it; a rerun moves nothing", () =>
    Effect.gen(function* () {
      const table = makeRecordingTable()
      const { meter: m, staleMeter } = yield* seed(On, table)
      const dry = yield* rekey(On, table, { dryRun: true })
      const report = yield* rekey(On, table)
      expect(rekeyOutcome(dry)).toEqual(rekeyOutcome(report))
      expect(report.byMember.Meter?.moved.item).toBe(1)
      expect(report.byMember.Ledger?.moved.stream).toBe(3)

      // The moved meter: its current key, recomposed index keys, its sentinel.
      expect(table.items.has(at(m.old))).toBe(false)
      const moved = table.items.get(at(m.current))!
      const gsi = KeyComposer.composeAllKeys(On.schema, "Meter", 1, On.Meters.indexes, {
        ...meter("s", -7, -1001),
      })
      expect(moved.gsi1pk?.S).toBe(gsi.gsi1pk)
      expect(moved.gsi1sk?.S).toBe(gsi.gsi1sk)
      expect(table.items.has(at(m.sentinel.old))).toBe(false)
      expect(table.items.get(at(m.sentinel.current))?._entity_pk?.S).toBe(m.current.pk)
      // The meter rewritten in place.
      const stale = table.items.get(at(staleMeter))!
      const staleGsi = KeyComposer.composeAllKeys(On.schema, "Meter", 1, On.Meters.indexes, {
        ...meter("s", 9, -3003),
      })
      expect(stale.gsi1sk?.S).toBe(staleGsi.gsi1sk)
      expect(table.items.has(at(sentinelKeys(On, -3003).current))).toBe(true)
      expect(table.items.has(at(sentinelKeys(On, -3003).old))).toBe(false)
      // History, events and the stream: nothing left under a 1.36 partition.
      for (const pk of [docPk(On, -5).old, gaugePk(On, -6).old, ledgerPk(On, -4).old]) {
        expect([...table.items.keys()].filter((key) => key.startsWith(`${pk}|`))).toEqual([])
      }

      // Read back through the ops: every row where they look for it.
      const read = yield* Effect.gen(function* () {
        const db = yield* clientOf(On)
        return {
          meter: yield* db.entities.Meters.get({ site: "s", meterId: -7 }).asEffect(),
          versions: yield* db.entities.Docs.versions({ docId: -5 }).collect(),
          deleted: yield* db.entities.Docs.deleted.get({ docId: -5 }),
          events: yield* db.entities.Gauges.history({ gaugeId: -6 }).collect(),
          stream: yield* On.Ledger.read(ledger(-4)),
        }
      }).pipe(Effect.provide(layerOf(On, table)))
      expect(read.meter.serial).toBe(-1001)
      expect(read.versions.length).toBe(2)
      expect(read.deleted.title).toBe("v2")
      expect(read.events.map((e) => e.at)).toEqual([1, 2])
      expect(read.stream.map((e) => e.version)).toEqual([1, 2, 3])

      const again = yield* rekey(On, table)
      expect(again.moved).toEqual(ZERO)
      expect(again.indexKeysRewritten).toBe(0)
      expect(again.sentinelsMoved).toBe(0)
      expect(again.conflicts).toEqual([])
      expect(again.unchanged).toBeGreaterThan(0)
    }),
  )

  it.effect("moves rows with the fallback off too", () =>
    Effect.gen(function* () {
      const table = makeRecordingTable()
      yield* seed(Off, table)
      const report = yield* rekey(Off, table)
      expect(report.moved.item).toBe(2)
      expect(report.moved.stream).toBe(3)
      const again = yield* rekey(Off, table)
      expect(again.moved).toEqual(ZERO)
    }),
  )

  it.effect("parallel segments: the same report", () =>
    Effect.gen(function* () {
      const one = makeRecordingTable()
      yield* seed(On, one)
      const many = makeRecordingTable()
      yield* seed(On, many)
      const a = yield* rekey(On, one, { dryRun: true })
      const b = yield* rekey(On, many, { dryRun: true, segments: 4, concurrency: 1 })
      expect(b.moved).toEqual(a.moved)
      expect(b.scanned).toBe(a.scanned)
      expect(many.requests.filter((r) => r.command === "Scan").map((r) => r.input.Segment)).toEqual(
        expect.arrayContaining([0, 1, 2, 3]),
      )
    }),
  )
})

describe("rekey — a retained item's snapshots", () => {
  const key = { docId: -8 }
  const pk = docPk(On, -8)
  const snapshotSk = (version: number) => DynamoSchema.composeVersionKey(On.schema, "Doc", version)
  const keysUnder = (table: Recording, partition: string) =>
    [...table.items.keys()].filter((k) => k.startsWith(`${partition}|`)).sort()

  /** A doc 1.36 put once: the item at version 1 and its version 1 snapshot, under its 1.36 key. */
  const seedDoc = (table: Recording) =>
    Effect.gen(function* () {
      const db = yield* clientOf(On)
      yield* db.entities.Docs.put({ ...key, title: "v1" }).asEffect()
    }).pipe(
      Effect.provide(layerOf(On, table)),
      Effect.map(() => demotePartition(table, pk.now, pk.old)),
    )

  it.effect("an item's move takes the snapshot of its version; each counts once", () =>
    Effect.gen(function* () {
      const table = makeRecordingTable()
      expect(yield* seedDoc(table)).toBe(2)
      const dry = yield* rekey(On, table, { dryRun: true })
      expect(dry.moved).toEqual({ ...ZERO, item: 1, snapshot: 1 })
      const report = yield* rekey(On, table)
      expect(rekeyOutcome(dry)).toEqual(rekeyOutcome(report))
      expect(report.conflicts).toEqual([])
      expect(keysUnder(table, pk.old)).toEqual([])
      expect(table.items.has(`${pk.now}|${snapshotSk(1)}`)).toBe(true)
      expect((yield* rekey(On, table)).moved).toEqual(ZERO)
    }),
  )

  it.effect("after writes through the fallback, nothing is left to move or report", () =>
    Effect.gen(function* () {
      const table = makeRecordingTable()
      yield* seedDoc(table)
      yield* Effect.gen(function* () {
        const db = yield* clientOf(On)
        yield* db.entities.Docs.update(key).set({ title: "v2" }).asEffect()
        yield* db.entities.Docs.delete(key).asEffect()
        yield* db.entities.Docs.restore(key)
      }).pipe(Effect.provide(layerOf(On, table)))
      expect(keysUnder(table, pk.old)).toEqual([])
      const dry = yield* rekey(On, table, { dryRun: true })
      expect(dry.moved).toEqual(ZERO)
      expect(dry.conflicts).toEqual([])
    }),
  )

  for (const itemAt of ["its 1.36 key", "its current key"] as const) {
    it.effect(`the same snapshot under both keys, the item at ${itemAt}: the 1.36 copy goes`, () =>
      Effect.gen(function* () {
        const table = makeRecordingTable()
        yield* seedDoc(table)
        // The item's own move takes the copy along; a moved item's leaves it to the scan.
        const sk = KeyComposer.composeSk(On.schema, "Doc", 1, On.Docs.indexes.primary, key)
        if (itemAt === "its current key") relocate(table, `${pk.old}|${sk}`, { pk: pk.now, sk })
        const copy = table.items.get(`${pk.old}|${snapshotSk(1)}`)!
        table.items.set(`${pk.now}|${snapshotSk(1)}`, { ...copy, pk: { S: pk.now } })
        const before = snapshot(table)
        const dry = yield* rekey(On, table, { dryRun: true })
        const item = itemAt === "its 1.36 key" ? 1 : 0
        expect(dry.moved).toEqual({ ...ZERO, item, snapshot: 1 })
        expect(dry.conflicts).toEqual([])
        expect(table.items).toEqual(before)
        const report = yield* rekey(On, table)
        expect(report.moved).toEqual(dry.moved)
        expect(report.conflicts).toEqual([])
        expect(keysUnder(table, pk.old)).toEqual([])
        expect(table.items.get(`${pk.now}|${snapshotSk(1)}`)).toEqual({
          ...copy,
          pk: { S: pk.now },
        })
        const again = yield* rekey(On, table)
        expect(again.moved).toEqual(ZERO)
        expect(again.conflicts).toEqual([])
      }),
    )
  }

  it.effect("another snapshot of the version under its current key is a conflict; both stay", () =>
    Effect.gen(function* () {
      const table = makeRecordingTable()
      yield* seedDoc(table)
      const copy = table.items.get(`${pk.old}|${snapshotSk(1)}`)!
      table.items.set(`${pk.now}|${snapshotSk(1)}`, {
        ...copy,
        pk: { S: pk.now },
        __edd_i__: { S: "another-incarnation" },
      })
      const report = yield* rekey(On, table)
      expect(report.conflicts).toEqual([
        expect.objectContaining({
          member: "Doc",
          kind: "snapshot",
          reason: "bothKeys",
          key: { pk: pk.old, sk: snapshotSk(1) },
        }),
      ])
      expect(table.items.has(`${pk.old}|${snapshotSk(1)}`)).toBe(true)
      expect(report.moved).toEqual({ ...ZERO, item: 1 })
    }),
  )
})

describe("rekey — conflicts and skips", () => {
  it.effect("a row under both keys is reported and left; foreign rows are skipped", () =>
    Effect.gen(function* () {
      const table = makeRecordingTable()
      const { meter: m } = yield* seed(On, table)
      // The meter is under both keys.
      const copy = table.items.get(at(m.old))!
      table.items.set(at(m.current), { ...copy, ...toAttributeMap(m.current) })
      table.items.set("plain|1", toAttributeMap({ pk: "plain", sk: "1" }))
      table.items.set("other|1", toAttributeMap({ pk: "other", sk: "1", __edd_e__: "Nobody" }))
      table.items.set(
        "$rekey#v1#meter#nowhere|x",
        toAttributeMap({ pk: "$rekey#v1#meter#nowhere", sk: "x", __edd_e__: "Meter", site: "s" }),
      )
      const report = yield* rekey(On, table)
      expect(report.conflicts).toEqual([
        expect.objectContaining({
          member: "Meter",
          kind: "item",
          reason: "bothKeys",
          key: m.old,
          target: m.current,
        }),
      ])
      expect(table.items.has(at(m.old))).toBe(true)
      expect(report.skipped).toEqual({ notLibrary: 1, unregistered: 1, unrecognizedKey: 1 })
      expect(report.byMember.Meter?.conflicts).toBe(1)
    }),
  )

  it.effect("a row moved just as its target is read isn't under both keys", () =>
    Effect.gen(function* () {
      const table = makeRecordingTable()
      const { meter: m } = yield* seed(On, table)
      let moved = false
      table.hooks.onRequest = ({ command, input }) => {
        const old = table.items.get(at(m.old))
        if (moved || command !== "GetItem" || old === undefined) return
        if (input.Key.pk.S !== m.current.pk || input.Key.sk.S !== m.current.sk) return
        moved = true
        table.items.delete(at(m.old))
        table.items.set(at(m.current), { ...old, ...toAttributeMap(m.current) })
      }
      const report = yield* rekey(On, table)
      expect(moved).toBe(true)
      expect(report.conflicts).toEqual([])
      expect(table.items.has(at(m.old))).toBe(false)
      expect(table.items.has(at(m.current))).toBe(true)
    }),
  )

  it.effect("a stream is skipped unless it is passed", () =>
    Effect.gen(function* () {
      const table = makeRecordingTable()
      yield* seed(On, table)
      const report = yield* rekey(On, table, { streams: [] })
      expect(report.moved.stream).toBe(0)
      expect(report.skipped.unregistered).toBe(4)
    }),
  )
})

describe("rekey — the scan", () => {
  it.effect("maxPages stops with a resume token; resuming covers the rest", () =>
    Effect.gen(function* () {
      const table = makeRecordingTable()
      yield* seed(On, table)
      const rows = table.items.size
      const first = yield* rekey(On, table, { dryRun: true, pageSize: 3, maxPages: 2 })
      expect(first.scanned).toBe(6)
      expect(Option.getOrThrow(first.resume)).toMatch(/^rk1\./)
      let scanned = first.scanned
      let resume = first.resume
      while (Option.isSome(resume)) {
        const next = yield* rekey(On, table, {
          dryRun: true,
          pageSize: 3,
          maxPages: 2,
          resume: resume.value,
        })
        scanned += next.scanned
        resume = next.resume
      }
      expect(scanned).toBe(rows)
    }),
  )

  it.effect("onProgress delivers a token per page; a run resumed from one finishes the table", () =>
    Effect.gen(function* () {
      const table = makeRecordingTable()
      const { meter: m } = yield* seed(On, table)
      const tokens: Array<Option.Option<string>> = []
      const interrupted = yield* rekey(On, table, {
        pageSize: 2,
        onProgress: (progress) =>
          Effect.suspend(() => {
            tokens.push(progress.resume)
            return tokens.length === 3 ? Effect.die("interrupted") : Effect.void
          }),
      }).pipe(Effect.exit)
      expect(interrupted._tag).toBe("Failure")
      const resumed = yield* rekey(On, table, {
        pageSize: 2,
        resume: Option.getOrThrow(tokens[1]!),
      })
      expect(resumed.resume).toEqual(Option.none())
      expect(table.items.has(at(m.old))).toBe(false)
      for (const pk of [docPk(On, -5).old, gaugePk(On, -6).old, ledgerPk(On, -4).old]) {
        expect([...table.items.keys()].filter((key) => key.startsWith(`${pk}|`))).toEqual([])
      }
      const again = yield* rekey(On, table)
      expect(again.moved).toEqual(ZERO)
    }),
  )

  it.effect("a bad option or resume token fails with EDD-9098 before any request", () =>
    Effect.gen(function* () {
      const table = makeRecordingTable()
      yield* seed(On, table)
      const token = Option.getOrThrow(
        (yield* rekey(On, table, { dryRun: true, pageSize: 1, maxPages: 1 })).resume,
      )
      table.take()
      const failures = yield* Effect.all([
        rekey(On, table, { segments: 0 }).pipe(Effect.flip),
        rekey(On, table, { resume: "nonsense" }).pipe(Effect.flip),
        rekey(On, table, { resume: token, segments: 2 }).pipe(Effect.flip),
        rekey(On, table, { resume: `rk1.${btoa('{"t":"other","s":[0]}')}` }).pipe(Effect.flip),
      ])
      for (const failure of failures) {
        expect(failure._tag).toBe("ValidationError")
        expect(String((failure as { cause?: unknown }).cause)).toContain("EDD-9098")
      }
      expect(table.requests).toEqual([])
    }),
  )

  it.effect("reports the capacity the run consumed, whatever reporting is set to", () =>
    Effect.gen(function* () {
      const table = makeRecordingTable()
      yield* seed(On, table)
      const { service, sent } = withConsumedCapacity(serviceOf(table.layer))
      const report = yield* Effect.gen(function* () {
        const db = yield* clientOf(On)
        return yield* db.tables.MainTable.rekey({ streams: [On.Ledger] })
      }).pipe(Effect.provide(layerOf(On, table, clientLayer(service))))
      expect(report.capacity.requests).toBe(sent.length)
      expect(report.capacity.capacityUnits).toBeGreaterThan(0)
      expect(sent.every((s) => s.input.ReturnConsumedCapacity === "TOTAL")).toBe(true)
    }),
  )
})

describe("rekey — tombstones holding their unique values", () => {
  /**
   * A badge and a card soft-deleted with their reservations kept, as 1.36
   * left them: the badge's code reservation under its 1.36 key (the badge's
   * own key text is unchanged); the card's tombstone under its 1.36
   * partition, and its name reservation (whose key text is unchanged)
   * naming the card's 1.36 key.
   */
  const seedTombstones = (w: World, table: Recording) =>
    Effect.gen(function* () {
      const db = yield* clientOf(w)
      yield* db.entities.Badges.put({ owner: "o", tag: "plain", code: -77 }).asEffect()
      yield* db.entities.Badges.delete({ owner: "o", tag: "plain" }).asEffect()
      yield* db.entities.Cards.put({ cardId: -3, name: "plain" }).asEffect()
      yield* db.entities.Cards.delete({ cardId: -3 }).asEffect()
    }).pipe(
      Effect.provide(layerOf(w, table)),
      Effect.map(() => {
        const code = uniqueKeys(w, "Badge", "code", -77)
        expect(code.old).not.toEqual(code.current)
        relocate(table, at(code.current), code.old)
        const card = cardPk(w, -3)
        demotePartition(table, card.now, card.old)
        const name = uniqueKeys(w, "Card", "name", "plain")
        expect(name.old).toEqual(name.current)
        expect(table.items.get(at(name.current))?._entity_pk?.S).toBe(card.now)
        table.items.set(at(name.current), {
          ...table.items.get(at(name.current))!,
          _entity_pk: { S: card.old },
        })
        const badge = KeyComposer.composeIndexKeys(w.schema, "Badge", 1, w.Badges.indexes.primary, {
          owner: "o",
          tag: "plain",
        }) as Record<string, string>
        return { code, name, card, badge }
      }),
    )

  it.effect("the reservations move to, and name, the item's current key", () =>
    Effect.gen(function* () {
      const table = makeRecordingTable()
      const { code, name, card, badge } = yield* seedTombstones(On, table)
      const before = snapshot(table)
      const dry = yield* rekey(On, table, { dryRun: true })
      expect(dry.sentinelsMoved).toBe(2)
      expect(dry.moved.tombstone).toBe(1)
      expect(table.items).toEqual(before)

      const report = yield* rekey(On, table)
      expect(rekeyOutcome(dry)).toEqual(rekeyOutcome(report))
      expect(report.sentinelsMoved).toBe(2)
      expect(report.moved.tombstone).toBe(1)
      expect(report.conflicts).toEqual([])
      // The badge's reservation moved and still names the badge.
      expect(table.items.has(at(code.old))).toBe(false)
      expect(table.items.get(at(code.current))?._entity_pk?.S).toBe(badge.pk)
      expect(table.items.get(at(code.current))?._entity_sk?.S).toBe(badge.sk)
      // The card's reservation names the card's current key.
      expect(table.items.get(at(name.current))?._entity_pk?.S).toBe(card.now)
      expect([...table.items.keys()].filter((key) => key.startsWith(`${card.old}|`))).toEqual([])

      // With the fallback off: the values are still taken, and both restore.
      const off = yield* Effect.gen(function* () {
        const db = yield* clientOf(Off)
        const badgeTaken = yield* db.entities.Badges.put({ owner: "p", tag: "x", code: -77 })
          .asEffect()
          .pipe(Effect.flip)
        const cardTaken = yield* db.entities.Cards.put({ cardId: 4, name: "plain" })
          .asEffect()
          .pipe(Effect.flip)
        return {
          badgeTaken,
          cardTaken,
          badge: yield* db.entities.Badges.restore({ owner: "o", tag: "plain" }),
          card: yield* db.entities.Cards.restore({ cardId: -3 }),
        }
      }).pipe(Effect.provide(layerOf(Off, table)))
      expect(off.badgeTaken._tag).toBe("UniqueConstraintViolation")
      expect(off.cardTaken._tag).toBe("UniqueConstraintViolation")
      expect(off.badge.code).toBe(-77)
      expect(off.card.name).toBe("plain")

      const again = yield* rekey(On, table)
      expect(again.sentinelsMoved).toBe(0)
      expect(again.moved).toEqual(ZERO)
    }),
  )

  it.effect("a reservation another item holds is a conflict, and nothing moves", () =>
    Effect.gen(function* () {
      const table = makeRecordingTable()
      const { code } = yield* seedTombstones(On, table)
      // Another badge took the code under its current key.
      table.items.set(
        at(code.current),
        toAttributeMap({ ...code.current, _entity_pk: "elsewhere", _entity_sk: "x" }),
      )
      const before = snapshot(table)
      const report = yield* rekey(On, table)
      expect(report.conflicts).toEqual([
        expect.objectContaining({ member: "Badge", kind: "tombstone", reason: "taken" }),
      ])
      expect(table.items.get(at(code.old))).toEqual(before.get(at(code.old)))
      expect(table.items.get(at(code.current))).toEqual(before.get(at(code.current)))
    }),
  )
})

describe("rekey — event streams", () => {
  it.effect("an append that located the stream before it moved fails its location check", () =>
    Effect.gen(function* () {
      const table = makeRecordingTable()
      yield* seed(On, table)
      const pk = ledgerPk(On, -4)
      // `rekey` flips the stream between the append's locate and its write.
      const service = serviceOf(table.layer)
      let flipped = false
      const racing = {
        ...service,
        transactWriteItems: (input: Parameters<typeof service.transactWriteItems>[0]) =>
          Effect.suspend(() => {
            if (!flipped) {
              flipped = true
              const [first, row] = [...table.items].find(
                ([key, item]) => key.startsWith(`${pk.old}|`) && item.version?.N === "1",
              )!
              table.items.set(first, { ...row, __edd_moved__: { S: pk.now } })
            }
            return service.transactWriteItems(input)
          }),
      }
      table.take()
      const error = yield* On.Ledger.append(ledger(-4), [new Deposited({ amount: 4 })], 3).pipe(
        Effect.flip,
        Effect.provide(layerOf(On, table, clientLayer(racing))),
      )
      expect(error._tag).toBe("VersionConflict")
      const sent = table.requests.find((r) => r.command === "TransactWriteItems")!
      const checks = (sent.input.TransactItems as Array<any>).filter((i) => i.ConditionCheck)
      expect(checks.map((c) => c.ConditionCheck.ConditionExpression)).toEqual([
        "attribute_exists(#pk) AND attribute_not_exists(#sealed)",
        "attribute_exists(#pk) AND attribute_not_exists(#moved)",
      ])
      // Nothing was written under the 1.36 key.
      expect([...table.items.keys()].filter((key) => key.startsWith(`${pk.old}|`)).length).toBe(3)
    }),
  )

  it.effect("a stream at its current key appends with no location check", () =>
    Effect.gen(function* () {
      const table = makeRecordingTable()
      yield* seed(On, table)
      table.take()
      yield* On.Ledger.append(ledger(-9), [new Deposited({ amount: 2 })], 1).pipe(
        Effect.provide(layerOf(On, table)),
      )
      const sent = table.requests.find((r) => r.command === "TransactWriteItems")!
      expect(JSON.stringify(sent.input)).not.toContain("__edd_moved__")
    }),
  )

  it.effect(
    "a command-only append that located the stream before it moved fails its location check",
    () =>
      Effect.gen(function* () {
        const table = makeRecordingTable()
        yield* seed(On, table)
        const pk = ledgerPk(On, -4)
        const service = serviceOf(table.layer)
        let flipped = false
        const racing = {
          ...service,
          transactWriteItems: (input: Parameters<typeof service.transactWriteItems>[0]) =>
            Effect.suspend(() => {
              if (!flipped) {
                flipped = true
                const [first, row] = [...table.items].find(
                  ([key, item]) => key.startsWith(`${pk.old}|`) && item.version?.N === "1",
                )!
                table.items.set(first, { ...row, __edd_moved__: { S: pk.now } })
              }
              return service.transactWriteItems(input)
            }),
        }
        table.take()
        const error = yield* On.Ledger.append(ledger(-4), [], 3, {
          idempotency: { commandId: "c-1" },
        }).pipe(Effect.flip, Effect.provide(layerOf(On, table, clientLayer(racing))))
        expect(error._tag).toBe("VersionConflict")
        const sent = table.requests.find((r) => r.command === "TransactWriteItems")!
        const checks = (sent.input.TransactItems as Array<any>).filter((i) => i.ConditionCheck)
        expect(checks.map((c) => c.ConditionCheck.ConditionExpression)).toEqual([
          "attribute_exists(#pk) AND attribute_not_exists(#moved)",
        ])
        // No sentinel under the 1.36 key.
        expect([...table.items.keys()].filter((key) => key.startsWith(`${pk.old}|`)).length).toBe(3)
      }),
  )

  it.effect("a stream id of several composites, a string one holding '#', moves", () =>
    Effect.gen(function* () {
      const table = makeRecordingTable()
      const id = { tenant: "a#b", n: -3 } as unknown as {
        readonly tenant: string
        readonly n: string
      }
      yield* On.Accounts.append(
        id,
        [new Deposited({ amount: 1 }), new Deposited({ amount: 2 })],
        0,
      ).pipe(Effect.provide(layerOf(On, table)))
      const pk = {
        now: DynamoSchema.composeKey(On.schema, "Accounts", [
          "a#b",
          KeyComposer.serializeValue(-3),
        ]),
        old: DynamoSchema.composeKey(On.schema, "Accounts", ["a#b", KeyText136.serializeValue(-3)]),
      }
      demotePartition(table, pk.now, pk.old)
      const report = yield* rekey(On, table, { streams: [On.Accounts] })
      expect(report.moved.stream).toBe(2)
      expect(report.skipped.unrecognizedKey).toBe(0)
      expect(report.conflicts).toEqual([])
      const events = yield* Off.Accounts.read(id).pipe(Effect.provide(layerOf(Off, table)))
      expect(events.map((e) => e.data.amount)).toEqual([1, 2])
    }),
  )

  it.effect(
    "rows left under a moved stream's 1.36 key move after it; the newer snapshot wins",
    () =>
      Effect.gen(function* () {
        const table = makeRecordingTable()
        yield* seed(On, table)
        const pk = ledgerPk(On, -4)
        yield* rekey(On, table)
        // As a run that stopped after the flip leaves it, with a command
        // sentinel and a snapshot written under the 1.36 key beside the flip.
        const firstKey = [...table.items.keys()].find(
          (key) => key.startsWith(`${pk.now}|`) && table.items.get(key)!.version?.N === "1",
        )!
        const firstSk = firstKey.slice(pk.now.length + 1)
        table.items.set(`${pk.old}|${firstSk}`, {
          ...table.items.get(firstKey)!,
          pk: { S: pk.old },
          __edd_moved__: { S: pk.now },
        })
        const commandSk = DynamoSchema.composeKey(On.schema, "Ledger.command", ["c-9"])
        table.items.set(
          `${pk.old}|${commandSk}`,
          toAttributeMap({
            pk: pk.old,
            sk: commandSk,
            __edd_e__: "ledger.command",
            streamId: "-4",
            commandId: "c-9",
            version: 3,
          }),
        )
        const snapshotSk = DynamoSchema.composeKey(On.schema, "Ledger.snapshot", [])
        const snapshotRow = (pkValue: string, asOfVersion: number) =>
          toAttributeMap({
            pk: pkValue,
            sk: snapshotSk,
            __edd_e__: "ledger.snapshot",
            streamId: "-4",
            asOfVersion,
            timestamp: `t${asOfVersion}`,
          })
        table.items.set(`${pk.now}|${snapshotSk}`, snapshotRow(pk.now, 2))
        table.items.set(`${pk.old}|${snapshotSk}`, snapshotRow(pk.old, 3))

        const report = yield* rekey(On, table)
        expect(report.moved.stream).toBe(3)
        expect(report.conflicts).toEqual([])
        expect([...table.items.keys()].filter((key) => key.startsWith(`${pk.old}|`))).toEqual([])
        expect(table.items.get(`${pk.now}|${snapshotSk}`)?.asOfVersion?.N).toBe("3")
        expect(table.items.get(`${pk.now}|${commandSk}`)?.commandId?.S).toBe("c-9")
        expect(table.items.get(firstKey)?.__edd_moved__).toBeUndefined()

        // An older snapshot left there does not replace the newer one.
        table.items.set(`${pk.old}|${snapshotSk}`, snapshotRow(pk.old, 1))
        const again = yield* rekey(On, table)
        expect(again.moved.stream).toBe(1)
        expect(table.items.get(`${pk.now}|${snapshotSk}`)?.asOfVersion?.N).toBe("3")
        expect(table.items.has(`${pk.old}|${snapshotSk}`)).toBe(false)
      }),
  )

  it.effect("a row left there that differs from the moved stream's is a conflict", () =>
    Effect.gen(function* () {
      const table = makeRecordingTable()
      yield* seed(On, table)
      const pk = ledgerPk(On, -4)
      yield* rekey(On, table)
      const second = [...table.items].find(
        ([key, row]) => key.startsWith(`${pk.now}|`) && row.version?.N === "2",
      )!
      const sk = second[0].slice(pk.now.length + 1)
      table.items.set(`${pk.old}|${sk}`, {
        ...second[1],
        pk: { S: pk.old },
        data: { S: "different" },
      })
      const report = yield* rekey(On, table)
      expect(report.conflicts).toEqual([
        expect.objectContaining({
          member: "Ledger",
          kind: "stream",
          reason: "bothKeys",
          key: { pk: pk.old, sk },
        }),
      ])
      expect(table.items.has(`${pk.old}|${sk}`)).toBe(true)
    }),
  )

  it.effect("a command sentinel whose TTL has passed does not hold the stream's current key", () =>
    Effect.gen(function* () {
      const table = makeRecordingTable()
      yield* seed(On, table)
      const pk = ledgerPk(On, -4)
      // A command recorded under the 1.36 key, with a TTL.
      yield* On.Ledger.append(ledger(-4), [], 3, {
        idempotency: { commandId: "c-2", ttl: "1 hour" },
      }).pipe(Effect.provide(layerOf(On, table)))
      const commandSk = DynamoSchema.composeKey(On.schema, "Ledger.command", ["c-2"])
      const recorded = table.items.get(`${pk.old}|${commandSk}`)!
      expect(Number(recorded._ttl?.N)).toBeGreaterThan(0)
      // Under the current key, expired but not yet deleted: the same
      // command, and one the stream does not have.
      const otherSk = DynamoSchema.composeKey(On.schema, "Ledger.command", ["c-3"])
      for (const sk of [commandSk, otherSk]) {
        table.items.set(`${pk.now}|${sk}`, {
          ...recorded,
          ...toAttributeMap({ pk: pk.now, sk }),
          _ttl: { N: "0" },
        })
      }
      const report = yield* rekey(On, table)
      expect(report.conflicts).toEqual([])
      expect(report.moved.stream).toBe(4)
      expect(table.items.get(`${pk.now}|${commandSk}`)?._ttl).toEqual(recorded._ttl)
      expect([...table.items.keys()].filter((key) => key.startsWith(`${pk.old}|`))).toEqual([])
    }),
  )

  it.effect(
    "a snapshot write that located the stream before it moved writes at its current key",
    () =>
      Effect.gen(function* () {
        const table = makeRecordingTable()
        yield* seed(On, table)
        const pk = ledgerPk(On, -4)
        // `rekey` moves the stream between the snapshot write's locate and its write.
        const service = serviceOf(table.layer)
        let moved = false
        const racing = {
          ...service,
          transactWriteItems: (input: Parameters<typeof service.transactWriteItems>[0]) =>
            Effect.suspend(() => {
              if (moved) return service.transactWriteItems(input)
              moved = true
              return Effect.andThen(
                rekey(On, table).pipe(Effect.orDie),
                service.transactWriteItems(input),
              )
            }),
        }
        yield* On.SnappedLedger.writeSnapshot(ledger(-4), { total: 6 }, 3).pipe(
          Effect.provide(layerOf(On, table, clientLayer(racing))),
        )
        expect(moved).toBe(true)
        const snapshotSk = DynamoSchema.composeKey(On.schema, "Ledger.snapshot", [])
        expect(table.items.get(`${pk.now}|${snapshotSk}`)?.asOfVersion?.N).toBe("3")
        expect([...table.items.keys()].filter((key) => key.startsWith(`${pk.old}|`))).toEqual([])
      }),
  )
})
