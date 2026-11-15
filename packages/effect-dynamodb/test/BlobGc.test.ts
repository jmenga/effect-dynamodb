/**
 * Garbage collection of offloaded values (#179, design §11): the reaper's
 * free rules per member config, the bracketed confirm-read (a restore landing
 * between two range reads, a family that never settles), disjoint item
 * family ranges with siblings and legacy history, table-local ownership (a
 * record is read only by its own table's members), the every-record view
 * check, duplicate and reordered records, the grace and record times, the
 * two-pass per-item sweep over every range (history-held versions kept, busy
 * families and partitions left alone), the store-wide sweep over every member
 * kind, and the `[EDD-9118]` / `[EDD-9115]` checks.
 *
 * Rows live in the in-memory tables; stream records are made by diffing the
 * tables around a write (NEW_AND_OLD_IMAGES); objects land in the in-memory
 * blob store, whose versions say what GC kept.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { describe, expect, it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import * as SchemaEntity from "@effect-dynamodb/schema/Entity.js"
import type { BlobRef } from "@effect-dynamodb/schema/internal/BlobPointer.js"
import { crc64nvme } from "@effect-dynamodb/schema/internal/Crc64Nvme.js"
import {
  Clock,
  Effect,
  Exit,
  Fiber,
  Layer,
  Logger,
  Option,
  References,
  Schema,
  Stream,
} from "effect"
import { TestClock } from "effect/testing"
import { beforeEach } from "vitest"
import * as Aggregate from "../src/Aggregate.js"
import * as BlobGc from "../src/BlobGc.js"
import { BlobStore, type BlobStoreService } from "../src/BlobStore.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
import { familyPrefix, objectKey } from "../src/internal/BlobKeys.js"
import * as BlobMetadata from "../src/internal/BlobMetadata.js"
import { pointerOf } from "../src/internal/GcSupport.js"
import type { MemoryBlobStore } from "../src/internal/MemoryBlobStore.js"
import type { StreamRecordLike } from "../src/internal/OffloadChange.js"
import * as Table from "../src/Table.js"
import {
  hooks,
  InMemoryClient,
  type Item,
  keyOf,
  resetStore,
  store as rows,
  calls as tableCalls,
} from "./helpers/InMemoryTables.js"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const AppSchema = DynamoSchema.make({ name: "gc", version: 1, escapeKeys: true })
const MAIN = "main"

const Text = Schema.Struct({ text: Schema.String })
/** `{"text":"…"}` is 11 bytes plus the text. */
const text = (jsonBytes: number, fill = "x") => ({ text: fill.repeat(jsonBytes - 11) })
const bytes = (n: number, fill = 7) => new Uint8Array(n).fill(fill)
const overflow = DynamoModel.Packed({ format: "json", external: { threshold: 16 } })

class Doc extends Schema.Class<Doc>("Doc")({
  docId: Schema.String,
  title: Schema.String,
  body: Schema.optional(Text),
  scan: Schema.optional(Schema.Uint8Array),
}) {}
const docModel = DynamoModel.configure(Doc, {
  body: { storedAs: overflow },
  scan: { storedAs: DynamoModel.External() },
})
const docKey = {
  pk: { field: "pk", composite: ["docId"] },
  sk: { field: "sk", composite: [] },
} as const

const Plain = Entity.make({ model: docModel, entityType: "Plain", primaryKey: docKey })
const Kept = Entity.make({
  model: docModel,
  entityType: "Kept",
  primaryKey: docKey,
  versioned: { retain: true },
})
const Soft = Entity.make({
  model: docModel,
  entityType: "Soft",
  primaryKey: docKey,
  softDelete: true,
})
/** Offloads, but is no collector's member. */
const Other = Entity.make({ model: docModel, entityType: "Other", primaryKey: docKey })

class Note extends Schema.Class<Note>("Note")({
  ownerId: Schema.String,
  noteId: Schema.String,
  title: Schema.String,
  body: Schema.optional(Text),
}) {}
/** Sort-key composites: sibling items share the partition. */
const Notes = Entity.make({
  model: DynamoModel.configure(Note, { body: { storedAs: overflow } }),
  entityType: "Note",
  primaryKey: {
    pk: { field: "pk", composite: ["ownerId"] },
    sk: { field: "sk", composite: ["noteId"] },
  },
  versioned: { retain: true },
  softDelete: true,
})

class Reading extends Schema.Class<Reading>("Reading")({
  sensorId: Schema.String,
  at: Schema.Number,
  value: Schema.Number,
  raw: Schema.optional(Schema.Uint8Array),
}) {}
const Readings = Entity.make({
  model: DynamoModel.configure(Reading, { raw: { storedAs: DynamoModel.External() } }),
  entityType: "Reading",
  primaryKey: {
    pk: { field: "pk", composite: ["sensorId"] },
    sk: { field: "sk", composite: [] },
  },
  timeSeries: {
    orderBy: "at",
    appendInput: Schema.Struct({
      sensorId: Schema.String,
      at: Schema.Number,
      value: Schema.Number,
      raw: Schema.optional(Schema.Uint8Array),
    }),
  },
})

class Venue extends Schema.Class<Venue>("Venue")({
  venueId: Schema.String,
  name: Schema.String,
  plan: Schema.Uint8Array,
}) {}
/** An edge entity with `retain`: aggregate writes still never snapshot it. */
const Venues = Entity.make({
  model: DynamoModel.configure(Venue, {
    venueId: { identifier: true },
    plan: { storedAs: DynamoModel.External() },
  }),
  entityType: "Venue",
  primaryKey: { pk: { field: "pk", composite: ["venueId"] }, sk: { field: "sk", composite: [] } },
  versioned: { retain: true },
})
class Match extends Schema.Class<Match>("Match")({
  matchId: Schema.String,
  name: Schema.String,
  venue: Venue,
}) {}

const MainTable = Table.make({
  schema: AppSchema,
  entities: { Plain, Kept, Soft, Other, Notes, Readings, Venues },
})

const Matches = Aggregate.make(Match, {
  table: MainTable,
  schema: AppSchema,
  pk: { field: "pk", composite: ["matchId"] },
  collection: { name: "match" },
  root: { entityType: "MatchItem" },
  edges: { venue: Aggregate.one("venue", { entityType: "MatchVenue", entity: Venues }) },
})

/**
 * An aggregate whose edge items carry the standalone entity's own type (`Venue`): the same table
 * then holds standalone `Venue` rows (with their retain snapshots) outside its partitions.
 */
const SharedMatches = Aggregate.make(Match, {
  table: MainTable,
  schema: AppSchema,
  pk: { field: "pk", composite: ["matchId"] },
  collection: { name: "sharedmatch" },
  root: { entityType: "SharedMatchItem" },
  edges: { venue: Aggregate.one("venue", { entityType: "Venue", entity: Venues }) },
})

/** A ref's id as the sort key: the row stores the ref whole, never a top-level `projectId`. */
class Proj extends Schema.Class<Proj>("GcProj")({
  projectId: Schema.String,
  name: Schema.String,
}) {}
const Projs = Entity.make({
  model: DynamoModel.configure(Proj, { projectId: { identifier: true } }),
  entityType: "Proj",
  primaryKey: {
    pk: { field: "pk", composite: ["projectId"] },
    sk: { field: "sk", composite: [] },
  },
})
class Task extends Schema.Class<Task>("GcTask")({
  taskId: Schema.String,
  project: DynamoModel.ref(Proj),
  body: Schema.optional(Text),
}) {}
const RefTasks = Entity.make({
  model: DynamoModel.configure(Task, { body: { storedAs: overflow } }),
  entityType: "Task",
  primaryKey: {
    pk: { field: "pk", composite: ["taskId"] },
    sk: { field: "sk", composite: ["projectId"] },
  },
  refs: { project: { entity: Projs } },
})
const RefTable = Table.make({ schema: AppSchema, entities: { Projs, RefTasks } })

/** The same items before and after `retain` was turned off. */
const ExOn = Entity.make({
  model: docModel,
  entityType: "Ex",
  primaryKey: docKey,
  versioned: { retain: true },
})
const ExOff = Entity.make({ model: docModel, entityType: "Ex", primaryKey: docKey })
const ExOnTable = Table.make({ schema: AppSchema, entities: { ExOn } })
const ExOffTable = Table.make({ schema: AppSchema, entities: { ExOff } })

/** The same items before and after an `offload.prefix` was set. */
const MovedOld = Entity.make({ model: docModel, entityType: "Moved", primaryKey: docKey })
const MovedNew = Entity.make({
  model: docModel,
  entityType: "Moved",
  primaryKey: docKey,
  offload: { prefix: "moved/" },
})
const MovedOldTable = Table.make({ schema: AppSchema, entities: { MovedOld } })
const MovedNewTable = Table.make({ schema: AppSchema, entities: { MovedNew } })

/** A copy of the main table under another name (a restore, an import). */
const CopyPlain = Entity.make({ model: docModel, entityType: "Plain", primaryKey: docKey })
const CopyTable = Table.make({ schema: AppSchema, entities: { CopyPlain } })

/** An `offload.prefix` with a 32-hex-character segment of its own. */
const HEX_PREFIX = "tenants/0123456789abcdef0123456789abcdef/"
const Tenanted = Entity.make({
  model: docModel,
  entityType: "Tenanted",
  primaryKey: docKey,
  offload: { prefix: HEX_PREFIX },
})
const TenantTable = Table.make({ schema: AppSchema, entities: { Tenanted } })

class Filed extends Schema.TaggedClass<Filed>()("Filed", { note: Schema.String }) {}
const CaseState = Schema.Struct({ notes: Schema.Array(Schema.String) })
const EventsTable = Table.make({ schema: AppSchema, entities: {} })
const Cases = EventStore.makeStream({
  table: EventsTable,
  streamName: "Case",
  events: [Filed],
  streamId: { composite: ["caseId"] },
  storedAs: { data: overflow },
  snapshot: { schema: CaseState, mode: "inline", storedAs: overflow },
})
const LONG = "the quick brown fox jumps over the lazy dog; ".repeat(4)

let blobs: MemoryBlobStore = BlobStore.memory()

const tables = () =>
  Layer.mergeAll(
    InMemoryClient,
    MainTable.layer({ name: MAIN }),
    ExOnTable.layer({ name: MAIN }),
    ExOffTable.layer({ name: MAIN }),
    MovedOldTable.layer({ name: MAIN }),
    MovedNewTable.layer({ name: MAIN }),
    CopyTable.layer({ name: "copy" }),
    TenantTable.layer({ name: MAIN }),
    RefTable.layer({ name: MAIN }),
    EventsTable.layer({ name: "events" }),
  )
/** The tables and the in-memory store `blobs`. */
const withStore = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.suspend(() =>
    effect.pipe(Effect.provide(Layer.mergeAll(tables(), BlobStore.layer(blobs)))),
  )
/** The tables and `store`. */
const withService = <A, E, R>(store: BlobStoreService, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(Layer.mergeAll(tables(), BlobStore.layer(store))))

beforeEach(() => {
  resetStore()
  blobs = BlobStore.memory()
})

const client = DynamoClient.make({
  entities: { Plain, Kept, Soft, Other, Notes, Readings },
  tables: { MainTable },
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const record = (
  eventName: "INSERT" | "MODIFY" | "REMOVE",
  oldImage: Item | undefined,
  newImage: Item | undefined,
  at: number,
): StreamRecordLike => ({
  eventName,
  dynamodb: {
    StreamViewType: "NEW_AND_OLD_IMAGES",
    ApproximateCreationDateTime: new Date(at),
    ...(oldImage === undefined ? {} : { OldImage: oldImage }),
    ...(newImage === undefined ? {} : { NewImage: newImage }),
  },
})

/** Run `effect` (an effect or a bound builder), and the stream records of the rows it changed. */
const recorded = <A, E, R>(
  effect: Effect.Effect<A, E, R> | { readonly asEffect: () => Effect.Effect<A, E, R> },
) =>
  Effect.gen(function* () {
    const before = new Map(rows)
    yield* Effect.isEffect(effect) ? effect : effect.asEffect()
    const at = yield* Clock.currentTimeMillis
    const out: Array<StreamRecordLike> = []
    for (const key of new Set([...before.keys(), ...rows.keys()])) {
      const old = before.get(key)
      const now = rows.get(key)
      if (old === now) continue
      out.push(
        record(
          old === undefined ? "INSERT" : now === undefined ? "REMOVE" : "MODIFY",
          old,
          now,
          at,
        ),
      )
    }
    return out
  })

/** Remove a row as a TTL expiry does, and its `REMOVE` record. */
const expire = (row: Item, table = MAIN) =>
  Effect.map(Clock.currentTimeMillis, (at) => {
    rows.delete(keyOf(table, row))
    return record("REMOVE", row, undefined, at)
  })

const rowsWhere = (entityType: string, test: (row: Item) => boolean = () => true, table = MAIN) =>
  [...rows.entries()]
    .filter(([key, row]) => key.startsWith(`${table}|`) && row.__edd_e__?.S === entityType)
    .map(([, row]) => row)
    .filter(test)
const isHistory = (row: Item) => /#(v|deleted|e)#/.test(row.sk?.S ?? "")
const live = (entityType: string, id: string, idField = "docId", table = MAIN): Item => {
  const row = rowsWhere(entityType, (r) => r[idField]?.S === id && !isHistory(r), table)[0]
  if (row === undefined) throw new Error(`no live ${entityType} row ${id}`)
  return row
}
const refOf = (value: AttributeValue | undefined): BlobRef => {
  const pointer = pointerOf(value)
  if (pointer === undefined) throw new Error("not a pointer")
  return pointer.ref
}
const exists = (ref: BlobRef) =>
  blobs
    .inspect()
    .versions.some((version) => version.ref.key === ref.key && version.ref.version === ref.version)
const versionCount = () => blobs.inspect().versions.length

const defectOf = (exit: Exit.Exit<unknown, unknown>): string => {
  if (Exit.isSuccess(exit)) throw new Error("expected a defect")
  const reason = exit.cause.reasons.find((r) => r._tag === "Die")
  if (reason === undefined || reason._tag !== "Die") throw new Error("expected a Die reason")
  return String((reason.defect as Error).message ?? reason.defect)
}

const NO_GRACE = { gracePeriod: 0 } as const

/** `records` as Lambda delivers them from `table`'s stream: with its `eventSourceARN`. */
const fromTable = (table: string, records: ReadonlyArray<StreamRecordLike>) =>
  records.map(
    (r): StreamRecordLike => ({
      ...r,
      eventSourceARN: `arn:aws:dynamodb:us-east-1:123456789012:table/${table}/stream/2026-11-01T00:00:00.000`,
    }),
  )

/** Collects every warning: its message and annotations. */
const warnings = () => {
  const lines: Array<{
    readonly message: string
    readonly annotations: Readonly<Record<string, unknown>>
  }> = []
  const logger = Logger.make((options) => {
    if (options.logLevel !== "Warn") return
    const message = Array.isArray(options.message) ? options.message[0] : options.message
    lines.push({
      message: String(message),
      annotations: options.fiber.getRef(References.CurrentLogAnnotations),
    })
  })
  return { lines, layer: Logger.layer([logger]) }
}

/** Upload a version into a family as a write whose DynamoDB request never landed. */
const stray = (familyPrefix: string, content: string) =>
  Effect.gen(function* () {
    const body = new TextEncoder().encode(content)
    return (yield* blobs.put({
      key: `${familyPrefix}${"0".repeat(32)}`,
      body,
      contentLength: body.length,
      checksum: Effect.succeed({ algorithm: "crc64nvme", value: crc64nvme(body) }),
      contentType: "application/json",
      metadata: { "edd-v": "1" },
    })).ref
  })

// ---------------------------------------------------------------------------
// The reaper: free rules
// ---------------------------------------------------------------------------

describe("BlobGc.reap — free rules", () => {
  it.effect("a plain entity: superseded versions are freed directly, with no read", () =>
    withStore(
      Effect.gen(function* () {
        const db = yield* client
        const gc = yield* BlobGc.make({ entities: { Plain }, reaper: NO_GRACE })
        const created = yield* recorded(
          db.entities.Plain.put({ docId: "p-1", title: "t", body: text(100), scan: bytes(4) }),
        )
        const v1 = refOf(live("Plain", "p-1").body)
        const scan = refOf(live("Plain", "p-1").scan)
        const updated = yield* recorded(
          db.entities.Plain.update({ docId: "p-1" }).set({ body: text(100, "y") }),
        )
        const v2 = refOf(live("Plain", "p-1").body)
        const before = { ...tableCalls }
        const report = yield* gc.reap([...created, ...updated])
        expect(report).toEqual({
          records: 2,
          candidates: 1,
          freed: 1,
          retained: 0,
          foreign: 0,
          skipped: 1,
        })
        expect(tableCalls.getItem).toBe(before.getItem)
        expect(tableCalls.query).toBe(before.query)
        expect(exists(v1)).toBe(false)
        expect(exists(v2)).toBe(true)
        expect(exists(scan)).toBe(true)
        // A REMOVE frees every version the row held.
        const removed = yield* recorded(db.entities.Plain.delete({ docId: "p-1" }))
        expect((yield* gc.reap(removed)).freed).toBe(2)
        expect(versionCount()).toBe(0)
      }),
    ),
  )

  it.effect("an aggregate edge of an entity with retain is freed directly too", () =>
    withStore(
      Effect.gen(function* () {
        const gc = yield* BlobGc.make({ aggregates: { Matches }, reaper: NO_GRACE })
        yield* Matches.create({
          matchId: "m-1",
          name: "Final",
          venue: { venueId: "v-1", name: "Arena", plan: bytes(6, 1) },
        } as never)
        const [edge] = rowsWhere("MatchVenue")
        const v1 = refOf(edge!.plan)
        const records = yield* recorded(
          Matches.update({ matchId: "m-1" }, ({ state }) => ({
            ...state,
            venue: { ...state.venue, plan: bytes(6, 2) },
          })),
        )
        const before = tableCalls.query + tableCalls.getItem
        const report = yield* gc.reap(records)
        expect(report.freed).toBe(1)
        expect(report.retained).toBe(0)
        expect(tableCalls.query + tableCalls.getItem).toBe(before)
        expect(exists(v1)).toBe(false)
        expect(exists(refOf(rowsWhere("MatchVenue")[0]!.plan))).toBe(true)
      }),
    ),
  )

  it.effect("an aggregates-only collector never reads a standalone row of its edge type", () =>
    withStore(
      Effect.gen(function* () {
        const db = yield* DynamoClient.make({ entities: { Venues }, tables: { MainTable } })
        const gc = yield* BlobGc.make({ aggregates: { SharedMatches }, reaper: NO_GRACE })
        // Standalone: the retain snapshot of the update holds v1.
        yield* db.entities.Venues.put({ venueId: "v-1", name: "Arena", plan: bytes(6, 1) })
        const v1 = refOf(live("Venue", "v-1", "venueId").plan)
        const updated = yield* recorded(
          db.entities.Venues.update({ venueId: "v-1" }).set({ plan: bytes(6, 2) }),
        )
        expect(yield* gc.reap(updated)).toMatchObject({ candidates: 0, freed: 0 })
        expect(exists(v1)).toBe(true)
        // The aggregate's own edge rows, of the same type, are still its own.
        yield* SharedMatches.create({
          matchId: "m-1",
          name: "Final",
          venue: { venueId: "v-9", name: "Hall", plan: bytes(6, 3) },
        } as never)
        const inPartition = (row: Item) => row.pk!.S!.includes("sharedmatch")
        const p1 = refOf(rowsWhere("Venue", inPartition)[0]!.plan)
        const records = yield* recorded(
          SharedMatches.update({ matchId: "m-1" }, ({ state }) => ({
            ...state,
            venue: { ...state.venue, plan: bytes(6, 4) },
          })),
        )
        expect(yield* gc.reap(records)).toMatchObject({ candidates: 1, freed: 1 })
        expect(exists(p1)).toBe(false)
        expect(exists(v1)).toBe(true)
      }),
    ),
  )

  it.effect("a ref's id in the sort key: the row's family is found, its versions freed", () =>
    withStore(
      Effect.gen(function* () {
        const db = yield* DynamoClient.make({ entities: { Projs, RefTasks }, tables: { RefTable } })
        const gc = yield* BlobGc.make({ entities: { RefTasks }, reaper: NO_GRACE })
        yield* db.entities.Projs.put({ projectId: "p-1", name: "P" })
        yield* db.entities.RefTasks.put({
          taskId: "t-1",
          projectId: "p-1",
          body: text(100),
        } as never)
        const v1 = refOf(live("Task", "t-1", "taskId").body)
        const removed = yield* recorded(
          db.entities.RefTasks.delete({ taskId: "t-1", projectId: "p-1" }),
        )
        expect(yield* gc.reap(removed)).toMatchObject({ candidates: 1, freed: 1, foreign: 0 })
        expect(exists(v1)).toBe(false)
      }),
    ),
  )

  it.effect("retain: a live-row MODIFY is skipped; a snapshot's expiry is confirmed", () =>
    withStore(
      Effect.gen(function* () {
        const db = yield* client
        const gc = yield* BlobGc.make({ entities: { Kept }, reaper: NO_GRACE })
        yield* db.entities.Kept.put({ docId: "k-1", title: "t", body: text(100) })
        const v1 = refOf(live("Kept", "k-1").body)
        // Two snapshots hold v1: one per update that left the body alone,
        // then the body changes (a third snapshot holds v1 too).
        yield* db.entities.Kept.update({ docId: "k-1" }).set({ title: "t2" })
        const changed = yield* recorded(
          db.entities.Kept.update({ docId: "k-1" }).set({ body: text(100, "y") }),
        )
        const live1 = changed.find((r) => r.eventName === "MODIFY")!
        const reads = tableCalls.query + tableCalls.getItem
        const skipped = yield* gc.reap([live1])
        expect(skipped).toMatchObject({ candidates: 0, freed: 0, skipped: 1 })
        expect(tableCalls.query + tableCalls.getItem).toBe(reads)
        const snapshots = rowsWhere("Kept", (row) => /#v#/.test(row.sk!.S!))
        expect(snapshots).toHaveLength(2)
        // The first snapshot expires: the other still holds v1.
        const first = yield* gc.reap([yield* expire(snapshots[0]!)])
        expect(first).toMatchObject({ candidates: 1, freed: 0, retained: 1 })
        expect(exists(v1)).toBe(true)
        // The last one expires: nothing holds v1.
        const last = yield* gc.reap([yield* expire(snapshots[1]!)])
        expect(last).toMatchObject({ candidates: 1, freed: 1, retained: 0 })
        expect(exists(v1)).toBe(false)
        expect(exists(refOf(live("Kept", "k-1").body))).toBe(true)
      }),
    ),
  )

  it.effect("softDelete: the live REMOVE is kept by its tombstone; a restore keeps it", () =>
    withStore(
      Effect.gen(function* () {
        const db = yield* client
        const gc = yield* BlobGc.make({ entities: { Soft }, reaper: NO_GRACE })
        yield* db.entities.Soft.put({ docId: "s-1", title: "t", body: text(100) })
        const v1 = refOf(live("Soft", "s-1").body)
        const deleted = yield* recorded(db.entities.Soft.delete({ docId: "s-1" }))
        expect(yield* gc.reap(deleted)).toMatchObject({ candidates: 1, freed: 0, retained: 1 })
        const restored = yield* recorded(db.entities.Soft.restore({ docId: "s-1" }))
        expect(yield* gc.reap(restored)).toMatchObject({ candidates: 1, freed: 0, retained: 1 })
        expect(exists(v1)).toBe(true)
        expect(refOf(live("Soft", "s-1").body)).toEqual(v1)
      }),
    ),
  )

  it.effect("timeSeries: an event's expiry is kept by the current item; .update() frees", () =>
    withStore(
      Effect.gen(function* () {
        const db = yield* client
        const gc = yield* BlobGc.make({ entities: { Readings }, reaper: NO_GRACE })
        yield* db.entities.Readings.append({ sensorId: "r-1", at: 1, value: 1, raw: bytes(4, 1) })
        const v1 = refOf(live("Reading", "r-1", "sensorId").raw)
        const [e1] = rowsWhere("Reading", (row) => /#e#/.test(row.sk!.S!))
        // The current item still holds v1: the event's TTL expiry frees nothing.
        expect(yield* gc.reap([yield* expire(e1!)])).toMatchObject({ freed: 0, retained: 1 })
        // A second append moves the current item on; e1 is gone, so v1 is free.
        const appended = yield* recorded(
          db.entities.Readings.append({ sensorId: "r-1", at: 2, value: 2, raw: bytes(4, 2) }),
        )
        expect(yield* gc.reap(appended)).toMatchObject({ candidates: 1, freed: 1 })
        expect(exists(v1)).toBe(false)
        const v2 = refOf(live("Reading", "r-1", "sensorId").raw)
        // `.update()` writes the current item only: the version it replaces
        // is still held by event 2.
        const updated = yield* recorded(
          db.entities.Readings.update({ sensorId: "r-1" }).set({ raw: bytes(4, 3) }),
        )
        expect(yield* gc.reap(updated)).toMatchObject({ freed: 0, retained: 1 })
        expect(exists(v2)).toBe(true)
        // A version only an `.update()` set is freed when the current item moves on.
        const v3 = refOf(live("Reading", "r-1", "sensorId").raw)
        const again = yield* recorded(
          db.entities.Readings.update({ sensorId: "r-1" }).set({ raw: bytes(4, 4) }),
        )
        expect(yield* gc.reap(again)).toMatchObject({ freed: 1, retained: 0 })
        expect(exists(v3)).toBe(false)
      }),
    ),
  )

  it.effect("EventStore: a snapshot's state is freed directly; events never", () =>
    withStore(
      Effect.gen(function* () {
        const gc = yield* BlobGc.make({ streams: { Cases }, reaper: NO_GRACE })
        const id = { caseId: "c-1" }
        const first = yield* recorded(
          Cases.append(id, [new Filed({ note: LONG })], 0, { snapshot: { notes: [LONG] } }),
        )
        const snapshot = rowsWhere("case.snapshot", () => true, "events")[0]!
        const s1 = refOf(snapshot.state)
        expect((yield* gc.reap(first)).skipped).toBe(first.length)
        const second = yield* recorded(
          Cases.append(id, [new Filed({ note: LONG })], 1, { snapshot: { notes: [LONG, LONG] } }),
        )
        const reads = tableCalls.query + tableCalls.getItem
        const report = yield* gc.reap(second)
        expect(report).toMatchObject({ candidates: 1, freed: 1 })
        expect(tableCalls.query + tableCalls.getItem).toBe(reads)
        expect(exists(s1)).toBe(false)
        // An event row's removal frees nothing: events are removed only by purge.
        const [event] = rowsWhere("case.event", () => true, "events")
        const data = refOf(event!.data)
        const removal = yield* gc.reap([yield* expire(event!, "events")])
        expect(removal).toMatchObject({ candidates: 0, freed: 0, skipped: 1 })
        expect(exists(data)).toBe(true)
      }),
    ),
  )

  it.effect('confirm: "always" covers an entity whose retain was turned off', () =>
    withStore(
      Effect.gen(function* () {
        const on = yield* DynamoClient.make({ entities: { ExOn }, tables: { ExOnTable } })
        const off = yield* DynamoClient.make({ entities: { ExOff }, tables: { ExOffTable } })
        yield* on.entities.ExOn.put({ docId: "x-1", title: "t", body: text(100) })
        const v1 = refOf(live("Ex", "x-1").body)
        // A snapshot holding v1 was left when retain was turned off.
        yield* on.entities.ExOn.update({ docId: "x-1" }).set({ title: "t2" })
        const records = yield* recorded(
          off.entities.ExOff.update({ docId: "x-1" }).set({ body: text(100, "y") }),
        )
        const always = yield* BlobGc.make({
          entities: { ExOff },
          reaper: { gracePeriod: 0, confirm: "always" },
        })
        expect(yield* always.reap(records)).toMatchObject({ freed: 0, retained: 1 })
        expect(exists(v1)).toBe(true)
        // The default reads the member's current (plain) config: it would free it.
        const auto = yield* BlobGc.make({ entities: { ExOff }, reaper: NO_GRACE })
        expect(yield* auto.reap(records)).toMatchObject({ freed: 1 })
        expect(exists(v1)).toBe(false)
      }),
    ),
  )
})

// ---------------------------------------------------------------------------
// The reaper: the confirm-read
// ---------------------------------------------------------------------------

describe("BlobGc.reap — the bracketed confirm-read", () => {
  it.effect("a restore landing between the range reads is seen on the retry", () =>
    withStore(
      Effect.gen(function* () {
        const db = yield* client
        const gc = yield* BlobGc.make({ entities: { Notes }, reaper: NO_GRACE })
        yield* db.entities.Notes.put({ ownerId: "o", noteId: "n-1", title: "t", body: text(100) })
        const v1 = refOf(live("Note", "n-1", "noteId").body)
        const liveSk = live("Note", "n-1", "noteId").sk!.S!
        const deleted = yield* recorded(db.entities.Notes.delete({ ownerId: "o", noteId: "n-1" }))
        const removal = deleted.filter((r) => r.eventName === "REMOVE")
        // The restore commits right after the live range is read, before the
        // tombstone range: neither range read sees a holder.
        hooks.afterQueryEffect.push(() =>
          Effect.sync(() => {
            const [tombstone] = rowsWhere("Note", (row) => /#deleted#/.test(row.sk!.S!))
            rows.delete(keyOf(MAIN, tombstone!))
            const { deletedAt: _, ...restored } = tombstone!
            rows.set(keyOf(MAIN, { ...restored, sk: { S: liveSk } }), {
              ...restored,
              sk: { S: liveSk },
            })
          }),
        )
        const gets = tableCalls.getItem
        const report = yield* gc.reap(removal)
        expect(report).toMatchObject({ candidates: 1, freed: 0, retained: 1 })
        // Two bracketed attempts: the live row differed in the first.
        expect(tableCalls.getItem - gets).toBe(4)
        expect(exists(v1)).toBe(true)
      }),
    ),
  )

  it.effect("a family whose live row never settles is retained as busy", () =>
    withStore(
      Effect.gen(function* () {
        const db = yield* client
        const gc = yield* BlobGc.make({ entities: { Kept }, reaper: NO_GRACE })
        yield* db.entities.Kept.put({ docId: "k-1", title: "t", body: text(100) })
        const v1 = refOf(live("Kept", "k-1").body)
        yield* db.entities.Kept.update({ docId: "k-1" }).set({ body: text(100, "y") })
        const [snapshot] = rowsWhere("Kept", (row) => /#v#/.test(row.sk!.S!))
        const expiry = yield* expire(snapshot!)
        // A writer changes the live row after every read of it.
        let n = 0
        const churn = () => {
          const row = live("Kept", "k-1")
          rows.set(keyOf(MAIN, row), { ...row, title: { S: `t${n++}` } })
          hooks.afterGet.push(churn)
        }
        hooks.afterGet.push(churn)
        const report = yield* gc.reap([expiry])
        hooks.afterGet = []
        expect(report).toMatchObject({ candidates: 1, freed: 0, retained: 1 })
        expect(n).toBe(6)
        expect(exists(v1)).toBe(true)
      }),
    ),
  )

  it.effect("disjoint family ranges: siblings and legacy rows are told apart", () =>
    withStore(
      Effect.gen(function* () {
        const db = yield* client
        const gc = yield* BlobGc.make({ entities: { Notes }, reaper: NO_GRACE })
        const note = (noteId: string, fill: string) =>
          db.entities.Notes.put({ ownerId: "o", noteId, title: "t", body: text(100, fill) })
        yield* note("n-1", "a")
        yield* note("n-2", "b")
        const v1 = refOf(live("Note", "n-1", "noteId").body)
        const w1 = refOf(live("Note", "n-2", "noteId").body)
        for (const noteId of ["n-1", "n-2"]) {
          yield* db.entities.Notes.update({ ownerId: "o", noteId }).set({ title: "t2" })
        }
        const changed = yield* recorded(
          db.entities.Notes.update({ ownerId: "o", noteId: "n-1" }).set({ body: text(100, "c") }),
        )
        expect((yield* gc.reap(changed)).skipped).toBe(changed.length)
        const own = rowsWhere("Note", (row) => row.noteId?.S === "n-1" && /#v#/.test(row.sk!.S!))
        expect(own).toHaveLength(2)
        // Rewrite the later snapshot as an earlier release wrote it: no item segment.
        const segmented = own[1]!.sk!.S!
        const legacySk =
          DynamoSchema.composeVersionKeyPrefix(AppSchema, "Note") +
          segmented.slice(segmented.lastIndexOf("#") + 1)
        rows.delete(keyOf(MAIN, own[1]!))
        const legacy = { ...own[1]!, sk: { S: legacySk } }
        rows.set(keyOf(MAIN, legacy), legacy)
        // The first snapshot expires: the legacy row (R4) still holds v1.
        expect(yield* gc.reap([yield* expire(own[0]!)])).toMatchObject({
          freed: 0,
          retained: 1,
        })
        // The legacy row expires: nothing of n-1 holds v1; n-2's rows never counted.
        expect(yield* gc.reap([yield* expire(legacy)])).toMatchObject({ freed: 1 })
        expect(exists(v1)).toBe(false)
        expect(exists(w1)).toBe(true)
        expect(exists(refOf(live("Note", "n-1", "noteId").body))).toBe(true)
      }),
    ),
  )
})

// ---------------------------------------------------------------------------
// The reaper: records
// ---------------------------------------------------------------------------

describe("BlobGc.reap — records", () => {
  it.effect("[EDD-9119]: every record is checked before any version is freed", () =>
    withStore(
      Effect.gen(function* () {
        const db = yield* client
        const gc = yield* BlobGc.make({ entities: { Plain }, reaper: NO_GRACE })
        const created = yield* recorded(
          db.entities.Plain.put({ docId: "p-1", title: "t", body: text(100) }),
        )
        const v1 = refOf(live("Plain", "p-1").body)
        const updated = yield* recorded(
          db.entities.Plain.update({ docId: "p-1" }).set({ body: text(100, "y") }),
        )
        const broken: StreamRecordLike = {
          eventName: "MODIFY",
          dynamodb: { NewImage: live("Plain", "p-1") },
        }
        const exit = yield* Effect.exit(gc.reap([...updated, ...created, broken]))
        expect(defectOf(exit)).toContain("[EDD-9119]")
        expect(blobs.inspect().calls.delete).toBe(0)
        expect(exists(v1)).toBe(true)
        const keysOnly: StreamRecordLike = {
          eventName: "REMOVE",
          dynamodb: { StreamViewType: "KEYS_ONLY", Keys: { pk: { S: "x" } } },
        }
        expect(defectOf(yield* Effect.exit(gc.reap([...updated, keysOnly])))).toContain(
          "[EDD-9119]",
        )
        expect(exists(v1)).toBe(true)
      }),
    ),
  )

  it.effect("duplicate and reordered records free each version once, idempotently", () =>
    withStore(
      Effect.gen(function* () {
        const db = yield* client
        const gc = yield* BlobGc.make({ entities: { Plain }, reaper: NO_GRACE })
        yield* db.entities.Plain.put({ docId: "p-1", title: "t", body: text(100, "a") })
        const v1 = refOf(live("Plain", "p-1").body)
        const first = yield* recorded(
          db.entities.Plain.update({ docId: "p-1" }).set({ body: text(100, "b") }),
        )
        const v2 = refOf(live("Plain", "p-1").body)
        const second = yield* recorded(
          db.entities.Plain.update({ docId: "p-1" }).set({ body: text(100, "c") }),
        )
        const batch = [...second, ...first, ...first]
        expect(yield* gc.reap(batch)).toMatchObject({ records: 3, candidates: 2, freed: 2 })
        expect(blobs.inspect().calls.delete).toBe(1)
        expect(exists(v1) || exists(v2)).toBe(false)
        // Delivered again: deletes are idempotent.
        expect(yield* gc.reap(batch)).toMatchObject({ freed: 2 })
        expect(exists(refOf(live("Plain", "p-1").body))).toBe(true)
      }),
    ),
  )

  it.effect("the grace: 15 minutes by default, from the newest superseding record", () =>
    withStore(
      Effect.gen(function* () {
        const db = yield* client
        const gc = yield* BlobGc.make({ entities: { Plain } })
        yield* db.entities.Plain.put({ docId: "p-1", title: "t", body: text(100) })
        const v1 = refOf(live("Plain", "p-1").body)
        const records = yield* recorded(
          db.entities.Plain.update({ docId: "p-1" }).set({ body: text(100, "y") }),
        )
        const fiber = yield* Effect.forkChild(gc.reap(records))
        yield* TestClock.adjust("14 minutes")
        expect(fiber.pollUnsafe()).toBeUndefined()
        expect(exists(v1)).toBe(true)
        yield* TestClock.adjust("1 minute")
        expect((yield* Fiber.join(fiber)).freed).toBe(1)
        expect(exists(v1)).toBe(false)
      }),
    ),
  )

  it.effect("a record's time in epoch seconds (Lambda, Pipes) counts as such", () =>
    withStore(
      Effect.gen(function* () {
        const db = yield* client
        const gc = yield* BlobGc.make({ entities: { Plain }, reaper: { gracePeriod: "1 minute" } })
        yield* TestClock.adjust("10 minutes")
        yield* db.entities.Plain.put({ docId: "p-1", title: "t", body: text(100) })
        const [modify] = yield* recorded(
          db.entities.Plain.update({ docId: "p-1" }).set({ body: text(100, "y") }),
        )
        const seconds: StreamRecordLike = {
          ...modify!,
          dynamodb: { ...modify!.dynamodb, ApproximateCreationDateTime: 600 },
        }
        const fiber = yield* Effect.forkChild(gc.reap([seconds]))
        yield* TestClock.adjust("59 seconds")
        expect(fiber.pollUnsafe()).toBeUndefined()
        yield* TestClock.adjust("1 second")
        expect((yield* Fiber.join(fiber)).freed).toBe(1)
      }),
    ),
  )

  it.effect("Kinesis times: MICROSECOND precision, magnitude, and a future time as now", () =>
    withStore(
      Effect.gen(function* () {
        const db = yield* client
        const gc = yield* BlobGc.make({ entities: { Plain }, reaper: { gracePeriod: "1 minute" } })
        yield* TestClock.setTime(Date.UTC(2026, 10, 1))
        yield* db.entities.Plain.put({ docId: "p-1", title: "t", body: text(100, "a") })
        /** One superseding record, its time as `at(now)` gives it. */
        const superseding = (fill: string, dynamodb: (now: number) => object) =>
          Effect.gen(function* () {
            const [modify] = yield* recorded(
              db.entities.Plain.update({ docId: "p-1" }).set({ body: text(100, fill) }),
            )
            const now = yield* Clock.currentTimeMillis
            return {
              ...modify!,
              dynamodb: { ...modify!.dynamodb, ...dynamodb(now) },
            } as StreamRecordLike
          })
        /** Reaped exactly one grace after now: not a second earlier. */
        const reapedAfterGrace = (record: StreamRecordLike) =>
          Effect.gen(function* () {
            const fiber = yield* Effect.forkChild(gc.reap([record]))
            yield* TestClock.adjust("59 seconds")
            expect(fiber.pollUnsafe()).toBeUndefined()
            yield* TestClock.adjust("1 second")
            expect((yield* Fiber.join(fiber)).freed).toBe(1)
          })
        // Kinesis Data Streams with MICROSECOND precision.
        yield* reapedAfterGrace(
          yield* superseding("b", (now) => ({
            ApproximateCreationDateTime: now * 1000,
            ApproximateCreationDateTimePrecision: "MICROSECOND",
          })),
        )
        // MILLISECOND precision.
        yield* reapedAfterGrace(
          yield* superseding("c", (now) => ({
            ApproximateCreationDateTime: now,
            ApproximateCreationDateTimePrecision: "MILLISECOND",
          })),
        )
        // No precision: microseconds by magnitude.
        yield* reapedAfterGrace(
          yield* superseding("d", (now) => ({ ApproximateCreationDateTime: now * 1000 })),
        )
        // A time ahead of the clock counts as now: the grace never stalls the batch.
        yield* reapedAfterGrace(
          yield* superseding("e", (now) => ({
            ApproximateCreationDateTime: now + 10 * 365 * 24 * 3_600_000,
          })),
        )
      }),
    ),
  )
})

// ---------------------------------------------------------------------------
// Table-local
// ---------------------------------------------------------------------------

describe("BlobGc — table-local", () => {
  it.effect("a copy's GC never deletes its source's versions, nor the source its copy's", () =>
    withStore(
      Effect.gen(function* () {
        const db = yield* client
        const copy = yield* DynamoClient.make({ entities: { CopyPlain }, tables: { CopyTable } })
        for (const docId of ["p-1", "p-2"]) {
          yield* db.entities.Plain.put({ docId, title: "t", body: text(100) })
          const row = live("Plain", docId)
          rows.set(keyOf("copy", row), row)
        }
        const source = refOf(live("Plain", "p-1").body)
        const gcCopy = yield* BlobGc.make({ entities: { CopyPlain }, reaper: NO_GRACE })
        // The copy's sweep: the source's version is foreign, never listed.
        const swept = yield* gcCopy.sweep("CopyPlain", { docId: "p-1" })
        expect(swept).toMatchObject({ referenced: 0, foreign: 1, listed: 0 })
        // The copy's reaper: superseding the copied pointer frees nothing.
        const records = yield* recorded(
          copy.entities.CopyPlain.update({ docId: "p-1" }).set({ body: text(100, "y") }),
        )
        expect(yield* gcCopy.reap(records)).toMatchObject({ candidates: 0, foreign: 1, freed: 0 })
        expect(exists(source)).toBe(true)
        // The copy's purge: the row's copied pointer is foreign.
        const p2 = refOf(live("Plain", "p-2").body)
        yield* copy.entities.CopyPlain.purge({ docId: "p-2" })
        expect(exists(p2)).toBe(true)
        // The source's sweep lists its own family only, not the copy's upload.
        const gcMain = yield* BlobGc.make({ entities: { Plain } })
        expect(yield* gcMain.sweep("Plain", { docId: "p-1" })).toMatchObject({
          referenced: 1,
          listed: 1,
        })
      }),
    ),
  )

  it.effect(
    "one collector over a table and its copy: a record is read by its table's members",
    () =>
      withStore(
        Effect.gen(function* () {
          const db = yield* client
          const copy = yield* DynamoClient.make({ entities: { CopyPlain }, tables: { CopyTable } })
          yield* db.entities.Plain.put({ docId: "p-1", title: "t", body: text(100) })
          rows.set(keyOf("copy", live("Plain", "p-1")), live("Plain", "p-1"))
          const source = refOf(live("Plain", "p-1").body)
          const gc = yield* BlobGc.make({ entities: { Plain, CopyPlain }, reaper: NO_GRACE })
          const records = yield* recorded(
            copy.entities.CopyPlain.update({ docId: "p-1" }).set({ body: text(100, "y") }),
          )
          // The records do not say which table they came from: refused, nothing freed.
          const unnamed = defectOf(yield* Effect.exit(gc.reap(records)))
          expect(unnamed).toContain("[EDD-9118]")
          expect(unnamed).toContain("does not name its table")
          // Lambda's eventSourceARN, the call's table (a change feed's stream ARN), or
          // Kinesis' tableName: only the copy's member reads them, and the source's
          // version is foreign to it.
          const expected = { candidates: 0, freed: 0, foreign: 1 }
          expect(yield* gc.reap(fromTable("copy", records))).toMatchObject(expected)
          const streamArn = fromTable("copy", records)[0]!.eventSourceARN!
          expect(yield* gc.reap(records, { table: streamArn })).toMatchObject(expected)
          expect(yield* gc.reap(records, { table: "copy" })).toMatchObject(expected)
          const kinesis = records.map((r): StreamRecordLike => ({ ...r, tableName: "copy" }))
          expect(yield* gc.reap(kinesis)).toMatchObject(expected)
          expect(blobs.inspect().calls.delete).toBe(0)
          expect(exists(source)).toBe(true)
          expect((yield* db.entities.Plain.get({ docId: "p-1" })).body).toEqual(text(100))
          // A record whose table contradicts the call's, or its own tableName: refused.
          for (const exit of [
            yield* Effect.exit(gc.reap(fromTable("copy", records), { table: MAIN })),
            yield* Effect.exit(
              gc.reap(fromTable("copy", records).map((r) => ({ ...r, tableName: MAIN }))),
            ),
            yield* Effect.exit(gc.reap(records, { table: "arn:aws:kinesis:us-east-1:1:stream/x" })),
          ]) {
            expect(defectOf(exit)).toContain("[EDD-9118]")
          }
          expect(exists(source)).toBe(true)
        }),
      ),
  )

  it.effect("a collector fed another table's records skips them", () =>
    withStore(
      Effect.gen(function* () {
        const db = yield* client
        const copy = yield* DynamoClient.make({ entities: { CopyPlain }, tables: { CopyTable } })
        yield* db.entities.Plain.put({ docId: "p-1", title: "t", body: text(100) })
        rows.set(keyOf("copy", live("Plain", "p-1")), live("Plain", "p-1"))
        const source = refOf(live("Plain", "p-1").body)
        const gc = yield* BlobGc.make({ entities: { Plain }, reaper: NO_GRACE })
        const records = yield* recorded(
          copy.entities.CopyPlain.update({ docId: "p-1" }).set({ body: text(100, "y") }),
        )
        expect(yield* gc.reap(fromTable("copy", records))).toMatchObject({
          candidates: 0,
          freed: 0,
          skipped: records.length,
        })
        expect(yield* gc.reap(records, { table: "copy" })).toMatchObject({ freed: 0 })
        expect(exists(source)).toBe(true)
        expect((yield* db.entities.Plain.get({ docId: "p-1" })).body).toEqual(text(100))
      }),
    ),
  )
})

// ---------------------------------------------------------------------------
// The per-item sweep
// ---------------------------------------------------------------------------

const twoPassSweep = Effect.gen(function* () {
  const db = yield* client
  const gc = yield* BlobGc.make({ entities: { Plain } })
  yield* db.entities.Plain.put({ docId: "p-1", title: "t", body: text(100, "a") })
  const v1 = refOf(live("Plain", "p-1").body)
  yield* db.entities.Plain.update({ docId: "p-1" }).set({ body: text(100, "b") })
  const v2 = refOf(live("Plain", "p-1").body)
  const sweep = gc.sweep("Plain", { docId: "p-1" })
  // Too young to mark: its write may still be in flight.
  expect(yield* sweep).toEqual({
    referenced: 1,
    listed: 2,
    marked: 0,
    deleted: 0,
    retainedYoung: 1,
    foreign: 0,
    busy: false,
  })
  yield* TestClock.adjust("76 minutes")
  expect(yield* sweep).toMatchObject({ listed: 2, marked: 1, deleted: 0, retainedYoung: 0 })
  // Marked less than the grace (24 hours) ago: kept.
  yield* TestClock.adjust("23 hours")
  expect(yield* sweep).toMatchObject({ marked: 0, deleted: 0 })
  expect(exists(v1)).toBe(true)
  yield* TestClock.adjust("1 hour")
  expect(yield* sweep).toMatchObject({ marked: 0, deleted: 1 })
  expect(exists(v1)).toBe(false)
  expect(exists(v2)).toBe(true)
  // A last version with no successor: marked on its first pass, not deleted.
  yield* db.entities.Plain.update({ docId: "p-1" }).remove(["body"])
  yield* TestClock.adjust("76 minutes")
  expect(yield* sweep).toMatchObject({ referenced: 0, listed: 1, marked: 1, deleted: 0 })
  expect(exists(v2)).toBe(true)
})

describe("BlobGc.sweep", () => {
  it.effect("two passes: referenced kept, young kept unmarked, marked then deleted", () =>
    withStore(twoPassSweep),
  )

  it.effect("the same on a key-per-write store", () =>
    Effect.suspend(() => {
      blobs = BlobStore.memory({ versioning: "keyPerWrite" })
      return withStore(twoPassSweep)
    }),
  )

  it.effect("own versions under an earlier prefix are listed and swept", () =>
    withStore(
      Effect.gen(function* () {
        const old = yield* DynamoClient.make({ entities: { MovedOld }, tables: { MovedOldTable } })
        yield* old.entities.MovedOld.put({ docId: "m-1", title: "t", body: text(100, "a") })
        const v0 = refOf(live("Moved", "m-1").body)
        yield* old.entities.MovedOld.update({ docId: "m-1" }).set({ body: text(100, "b") })
        // The entity now offloads under "moved/"; the row still names the "" prefix.
        const gc = yield* BlobGc.make({ entities: { MovedNew } })
        yield* TestClock.adjust("76 minutes")
        expect(yield* gc.sweep("MovedNew", { docId: "m-1" })).toMatchObject({
          referenced: 1,
          listed: 2,
          marked: 1,
        })
        yield* TestClock.adjust("24 hours")
        expect(yield* gc.sweep("MovedNew", { docId: "m-1" })).toMatchObject({ deleted: 1 })
        expect(exists(v0)).toBe(false)
      }),
    ),
  )

  it.effect("sweepPartition: an aggregate's orphaned edge versions are swept", () =>
    withStore(
      Effect.gen(function* () {
        const gc = yield* BlobGc.make({ aggregates: { Matches } })
        yield* Matches.create({
          matchId: "m-1",
          name: "Final",
          venue: { venueId: "v-1", name: "Arena", plan: bytes(6, 1) },
        } as never)
        const v1 = refOf(rowsWhere("MatchVenue")[0]!.plan)
        yield* Matches.update({ matchId: "m-1" }, ({ state }) => ({
          ...state,
          venue: { ...state.venue, plan: bytes(6, 2) },
        }))
        yield* TestClock.adjust("76 minutes")
        const sweep = gc.sweepPartition("Matches", { matchId: "m-1" })
        expect(yield* sweep).toMatchObject({ referenced: 1, listed: 2, marked: 1, busy: false })
        yield* TestClock.adjust("24 hours")
        expect(yield* sweep).toMatchObject({ deleted: 1 })
        expect(exists(v1)).toBe(false)
      }),
    ),
  )

  it.effect("retain + softDelete with sort-key composites: history-held versions are kept", () =>
    withStore(
      Effect.gen(function* () {
        const db = yield* client
        const gc = yield* BlobGc.make({ entities: { Notes } })
        const key = { ownerId: "o", noteId: "n-1" }
        yield* db.entities.Notes.put({ ...key, title: "t", body: text(100, "a") })
        const liveRow = live("Note", "n-1", "noteId")
        const family = familyPrefix("", {
          table: MAIN,
          pk: liveRow.pk as { S: string },
          familySk: liveRow.sk as { S: string },
        })
        const v1 = refOf(liveRow.body)
        yield* db.entities.Notes.update(key).set({ body: text(100, "b") })
        const v2 = refOf(live("Note", "n-1", "noteId").body)
        yield* db.entities.Notes.update(key).set({ body: text(100, "c") })
        const v3 = refOf(live("Note", "n-1", "noteId").body)
        // A sibling item in the same partition, between the family's ranges.
        yield* db.entities.Notes.put({ ownerId: "o", noteId: "n-2", title: "t", body: text(100) })
        const w1 = refOf(live("Note", "n-2", "noteId").body)
        const ofN1 = (pattern: RegExp) =>
          rowsWhere("Note", (row) => row.noteId?.S === "n-1" && pattern.test(row.sk!.S!))
        // v1's only holder: a snapshot an earlier release wrote without an item segment (R4).
        const first = ofN1(/#v#/).find((row) => refOf(row.body).version === v1.version)!
        rows.delete(keyOf(MAIN, first))
        const segmented = first.sk!.S!
        const legacy = {
          ...first,
          sk: {
            S:
              DynamoSchema.composeVersionKeyPrefix(AppSchema, "Note") +
              segmented.slice(segmented.lastIndexOf("#") + 1),
          },
        }
        rows.set(keyOf(MAIN, legacy), legacy)
        // v2's only holder: its segmented snapshot (R2). v3's: the tombstone (R3).
        yield* db.entities.Notes.delete(key)
        for (const row of ofN1(/#v#/)) {
          if (refOf(row.body).version === v3.version) rows.delete(keyOf(MAIN, row))
        }
        expect(ofN1(/#deleted#/)).toHaveLength(1)
        const orphan = yield* stray(family, '{"text":"orphan"}')
        yield* TestClock.adjust("76 minutes")
        const sweep = gc.sweep("Notes", key)
        expect(yield* sweep).toEqual({
          referenced: 3,
          listed: 4,
          marked: 1,
          deleted: 0,
          retainedYoung: 0,
          foreign: 0,
          busy: false,
        })
        yield* TestClock.adjust("24 hours")
        expect(yield* sweep).toMatchObject({ referenced: 3, listed: 4, deleted: 1 })
        expect(exists(orphan)).toBe(false)
        for (const ref of [v1, v2, v3, w1]) expect(exists(ref)).toBe(true)
      }),
    ),
  )

  it.effect("retain without sort-key composites: snapshot-held versions are kept", () =>
    withStore(
      Effect.gen(function* () {
        const db = yield* client
        const gc = yield* BlobGc.make({ entities: { Kept } })
        yield* db.entities.Kept.put({ docId: "k-1", title: "t", body: text(100, "a") })
        const v1 = refOf(live("Kept", "k-1").body)
        yield* db.entities.Kept.update({ docId: "k-1" }).set({ body: text(100, "b") })
        yield* db.entities.Kept.update({ docId: "k-1" }).set({ body: text(100, "c") })
        // The snapshot holding v2 expires: only v2 is unreferenced.
        const v2 = refOf(rowsWhere("Kept", (row) => /#v#0+2$/.test(row.sk!.S!))[0]!.body)
        rows.delete(keyOf(MAIN, rowsWhere("Kept", (row) => /#v#0+2$/.test(row.sk!.S!))[0]!))
        yield* TestClock.adjust("76 minutes")
        expect(yield* gc.sweep("Kept", { docId: "k-1" })).toMatchObject({
          referenced: 2,
          listed: 3,
          marked: 1,
        })
        yield* TestClock.adjust("24 hours")
        expect(yield* gc.sweep("Kept", { docId: "k-1" })).toMatchObject({ deleted: 1 })
        expect(exists(v2)).toBe(false)
        expect(exists(v1)).toBe(true)
      }),
    ),
  )

  it.effect("timeSeries: event-held versions are kept, an .update()-only one swept", () =>
    withStore(
      Effect.gen(function* () {
        const db = yield* client
        const gc = yield* BlobGc.make({ entities: { Readings } })
        const id = { sensorId: "r-1" }
        yield* db.entities.Readings.append({ ...id, at: 1, value: 1, raw: bytes(4, 1) })
        const v1 = refOf(live("Reading", "r-1", "sensorId").raw)
        yield* db.entities.Readings.append({ ...id, at: 2, value: 2, raw: bytes(4, 2) })
        const v2 = refOf(live("Reading", "r-1", "sensorId").raw)
        // Two `.update()`s of the current item: v3 is left with no holder.
        yield* db.entities.Readings.update(id).set({ raw: bytes(4, 3) })
        const v3 = refOf(live("Reading", "r-1", "sensorId").raw)
        yield* db.entities.Readings.update(id).set({ raw: bytes(4, 4) })
        const v4 = refOf(live("Reading", "r-1", "sensorId").raw)
        yield* TestClock.adjust("76 minutes")
        expect(yield* gc.sweep("Readings", id)).toMatchObject({
          referenced: 3,
          listed: 4,
          marked: 1,
        })
        yield* TestClock.adjust("24 hours")
        expect(yield* gc.sweep("Readings", id)).toMatchObject({ deleted: 1 })
        expect(exists(v3)).toBe(false)
        for (const ref of [v1, v2, v4]) expect(exists(ref)).toBe(true)
      }),
    ),
  )

  it.effect("a family whose live row never settles is left untouched as busy", () => {
    const logged = warnings()
    return withStore(
      Effect.gen(function* () {
        const db = yield* client
        const gc = yield* BlobGc.make({ entities: { Kept } })
        yield* db.entities.Kept.put({ docId: "k-1", title: "t", body: text(100) })
        yield* TestClock.adjust("76 minutes")
        let n = 0
        const churn = () => {
          const row = live("Kept", "k-1")
          rows.set(keyOf(MAIN, row), { ...row, title: { S: `t${n++}` } })
          hooks.afterGet.push(churn)
        }
        hooks.afterGet.push(churn)
        const report = yield* gc.sweep("Kept", { docId: "k-1" })
        hooks.afterGet = []
        expect(report).toEqual({
          referenced: 0,
          listed: 0,
          marked: 0,
          deleted: 0,
          retainedYoung: 0,
          foreign: 0,
          busy: true,
        })
        expect(n).toBe(6)
        expect(blobs.inspect().calls.list).toBe(0)
        expect(logged.lines).toHaveLength(1)
        expect(logged.lines[0]!.message).toContain("Sweep it again later")
        expect(logged.lines[0]!.annotations).toMatchObject({ table: MAIN })
      }).pipe(Effect.provide(logged.layer)),
    )
  })

  it.effect(
    "sweepPartition: a partition changing between its reads is read again; one that never settles is busy",
    () =>
      withStore(
        Effect.gen(function* () {
          const gc = yield* BlobGc.make({ aggregates: { Matches } })
          yield* Matches.create({
            matchId: "m-1",
            name: "Final",
            venue: { venueId: "v-1", name: "Arena", plan: bytes(6, 1) },
          } as never)
          yield* TestClock.adjust("76 minutes")
          let n = 0
          const rename = () =>
            Effect.sync(() => {
              const [root] = rowsWhere("MatchItem")
              rows.set(keyOf(MAIN, root!), { ...root!, name: { S: `Final ${n++}` } })
            })
          // A write lands between the first two reads: a second pair agrees.
          hooks.afterQueryEffect.push(rename)
          const queries = tableCalls.query
          expect(yield* gc.sweepPartition("Matches", { matchId: "m-1" })).toMatchObject({
            referenced: 1,
            listed: 1,
            busy: false,
          })
          expect(tableCalls.query - queries).toBe(4)
          // A write after every read: three attempts, then busy.
          const churn = (): Effect.Effect<void> =>
            Effect.andThen(
              rename(),
              Effect.sync(() => hooks.afterQueryEffect.push(churn)),
            )
          hooks.afterQueryEffect.push(churn)
          const lists = blobs.inspect().calls.list
          const busy = yield* gc.sweepPartition("Matches", { matchId: "m-1" })
          hooks.afterQueryEffect = []
          expect(busy).toMatchObject({ busy: true, listed: 0, marked: 0, deleted: 0 })
          expect(blobs.inspect().calls.list).toBe(lists)
        }),
      ),
  )

  it.effect("sweepPartition: a stream's superseded snapshot states are swept", () =>
    withStore(
      Effect.gen(function* () {
        const gc = yield* BlobGc.make({ streams: { Cases } })
        const id = { caseId: "c-1" }
        yield* Cases.append(id, [new Filed({ note: LONG })], 0, { snapshot: { notes: [LONG] } })
        yield* Cases.append(id, [new Filed({ note: LONG })], 1, {
          snapshot: { notes: [LONG, LONG] },
        })
        yield* TestClock.adjust("76 minutes")
        // Two events and the current snapshot referenced; the first state not.
        expect(yield* gc.sweepPartition("Cases", id)).toMatchObject({
          referenced: 3,
          listed: 4,
          marked: 1,
        })
      }),
    ),
  )
})

// ---------------------------------------------------------------------------
// The store-wide sweep
// ---------------------------------------------------------------------------

describe("BlobGc.sweepStore", () => {
  const seed = Effect.gen(function* () {
    const db = yield* client
    yield* db.entities.Plain.put({ docId: "p-1", title: "t", body: text(100, "a") })
    yield* db.entities.Plain.update({ docId: "p-1" }).set({ body: text(100, "b") })
    yield* db.entities.Other.put({ docId: "o-1", title: "t", body: text(100) })
    const copy = yield* DynamoClient.make({ entities: { CopyPlain }, tables: { CopyTable } })
    yield* copy.entities.CopyPlain.put({ docId: "c-1", title: "t", body: text(100) })
    // A row key too long for metadata: only its SHA-256 is recorded.
    const pk = { S: `$gc#v1#plain#${"k".repeat(2_100)}` }
    const sk = { S: "$gc#v1#plain" }
    const content = new TextEncoder().encode('{"text":"long"}')
    yield* blobs.put({
      key: objectKey("", { table: MAIN, pk, familySk: sk, rowSk: sk, attribute: "body" }),
      body: content,
      contentLength: content.length,
      checksum: Effect.succeed({ algorithm: "crc64nvme", value: crc64nvme(content) }),
      contentType: "application/json",
      metadata: BlobMetadata.build({
        table: MAIN,
        entity: "Plain",
        attribute: "body",
        pk,
        sk,
        kind: "json",
        codec: "none",
        checksum: { algorithm: "crc64nvme", value: crc64nvme(content) },
      }),
    })
  })

  it.effect("own families swept; foreign and unconfigured skipped; unattributable reported", () =>
    withStore(
      Effect.gen(function* () {
        yield* seed
        const gc = yield* BlobGc.make({ entities: { Plain } })
        const families = yield* Stream.runCollect(gc.sweepStore())
        const tags = families.map((family) =>
          family._tag === "Foreign"
            ? `Foreign:${Option.getOrElse(family.table, () => "?")}`
            : family._tag,
        )
        expect(tags.sort()).toEqual(["Foreign:copy", "Foreign:main", "Swept", "Unattributable"])
        const swept = families.find((family) => family._tag === "Swept")!
        expect(swept._tag === "Swept" && swept.member).toBe("Plain")
        expect(swept._tag === "Swept" && swept.report).toMatchObject({
          referenced: 1,
          listed: 2,
          retainedYoung: 1,
        })
        const unattributable = families.find((family) => family._tag === "Unattributable")!
        expect(unattributable).toMatchObject({ versions: 1, bytes: 15 })
        // Nothing was deleted or marked.
        expect(blobs.inspect().calls.delete).toBe(0)
      }),
    ),
  )

  it.effect("startAfter and maxFamilies resume a run", () =>
    withStore(
      Effect.gen(function* () {
        yield* seed
        const gc = yield* BlobGc.make({ entities: { Plain } })
        const all = (yield* Stream.runCollect(gc.sweepStore())).map((f) => f.familyPrefix)
        const first = yield* Stream.runCollect(gc.sweepStore({ maxFamilies: 1 }))
        expect(first.map((f) => f.familyPrefix)).toEqual(all.slice(0, 1))
        const rest = yield* Stream.runCollect(
          gc.sweepStore({ startAfter: first[0]!.familyPrefix, maxFamilies: 10 }),
        )
        expect(rest.map((f) => f.familyPrefix)).toEqual(all.slice(1))
      }),
    ),
  )

  it.effect("time-series, aggregate edge and stream families are attributed and swept", () =>
    withStore(
      Effect.gen(function* () {
        const db = yield* client
        const gc = yield* BlobGc.make({
          entities: { Readings },
          aggregates: { Matches },
          streams: { Cases },
        })
        // Time series: objects keyed per event row; the first event expires.
        yield* db.entities.Readings.append({ sensorId: "r-1", at: 1, value: 1, raw: bytes(4, 1) })
        const v1 = refOf(live("Reading", "r-1", "sensorId").raw)
        yield* db.entities.Readings.append({ sensorId: "r-1", at: 2, value: 2, raw: bytes(4, 2) })
        const [e1] = rowsWhere("Reading", (row) => /#e#/.test(row.sk!.S!) && row.at?.N === "1")
        rows.delete(keyOf(MAIN, e1!))
        // An aggregate edge: its first plan superseded.
        yield* Matches.create({
          matchId: "m-1",
          name: "Final",
          venue: { venueId: "v-1", name: "Arena", plan: bytes(6, 1) },
        } as never)
        const p1 = refOf(rowsWhere("MatchVenue")[0]!.plan)
        yield* Matches.update({ matchId: "m-1" }, ({ state }) => ({
          ...state,
          venue: { ...state.venue, plan: bytes(6, 2) },
        }))
        // A stream: its first snapshot state superseded.
        const id = { caseId: "c-1" }
        yield* Cases.append(id, [new Filed({ note: LONG })], 0, { snapshot: { notes: [LONG] } })
        const s1 = refOf(rowsWhere("case.snapshot", () => true, "events")[0]!.state)
        yield* Cases.append(id, [new Filed({ note: LONG })], 1, {
          snapshot: { notes: [LONG, LONG] },
        })
        const run = Effect.map(Stream.runCollect(gc.sweepStore()), (families) =>
          Object.fromEntries(
            families.map((family) => [
              family._tag === "Swept" ? family.member : family._tag,
              family._tag === "Swept" ? family.report : family,
            ]),
          ),
        )
        yield* TestClock.adjust("76 minutes")
        expect(yield* run).toEqual({
          Readings: expect.objectContaining({ referenced: 1, listed: 2, marked: 1 }),
          Matches: expect.objectContaining({ referenced: 1, listed: 2, marked: 1 }),
          Cases: expect.objectContaining({ referenced: 3, listed: 4, marked: 1 }),
        })
        yield* TestClock.adjust("24 hours")
        expect(yield* run).toEqual({
          Readings: expect.objectContaining({ deleted: 1 }),
          Matches: expect.objectContaining({ deleted: 1 }),
          Cases: expect.objectContaining({ deleted: 1 }),
        })
        for (const ref of [v1, p1, s1]) expect(exists(ref)).toBe(false)
        expect(exists(refOf(live("Reading", "r-1", "sensorId").raw))).toBe(true)
        expect(exists(refOf(rowsWhere("MatchVenue")[0]!.plan))).toBe(true)
        expect(exists(refOf(rowsWhere("case.snapshot", () => true, "events")[0]!.state))).toBe(true)
      }),
    ),
  )

  it.effect("a standalone row of an aggregate's edge type is not the aggregate's family", () =>
    withStore(
      Effect.gen(function* () {
        const db = yield* DynamoClient.make({ entities: { Venues }, tables: { MainTable } })
        const gc = yield* BlobGc.make({ aggregates: { SharedMatches } })
        yield* db.entities.Venues.put({ venueId: "v-1", name: "Arena", plan: bytes(6, 1) })
        const v1 = refOf(live("Venue", "v-1", "venueId").plan)
        // Only the retain snapshot holds v1 now.
        yield* db.entities.Venues.update({ venueId: "v-1" }).set({ plan: bytes(6, 2) })
        const run = Stream.runCollect(gc.sweepStore())
        yield* TestClock.adjust("76 minutes")
        const first = yield* run
        expect(first.map((family) => family._tag)).toEqual(["Foreign"])
        yield* TestClock.adjust("24 hours")
        yield* run
        expect(exists(v1)).toBe(true)
        expect(blobs.inspect().calls.delete).toBe(0)
      }),
    ),
  )

  it.effect("a member prefix with a 32-hex-character segment is not read as a partition", () =>
    withStore(
      Effect.gen(function* () {
        const db = yield* DynamoClient.make({ entities: { Tenanted }, tables: { TenantTable } })
        for (const docId of ["t-1", "t-2"]) {
          yield* db.entities.Tenanted.put({ docId, title: "t", body: text(100, "a") })
          yield* db.entities.Tenanted.update({ docId }).set({ body: text(100, "b") })
        }
        expect(refOf(live("Tenanted", "t-1").body).key.startsWith(HEX_PREFIX)).toBe(true)
        const gc = yield* BlobGc.make({ entities: { Tenanted } })
        const families = yield* Stream.runCollect(gc.sweepStore())
        expect(families.map((family) => family._tag)).toEqual(["Swept", "Swept"])
        for (const family of families) {
          expect(family).toMatchObject({
            member: "Tenanted",
            report: { referenced: 1, listed: 2, retainedYoung: 1 },
          })
          expect(family.familyPrefix.startsWith(HEX_PREFIX)).toBe(true)
        }
      }),
    ),
  )
})

// ---------------------------------------------------------------------------
// make: [EDD-9118] / [EDD-9115]
// ---------------------------------------------------------------------------

describe("BlobGc.make — checks", () => {
  const madeWith = (options: unknown) =>
    Effect.exit(BlobGc.make(options as BlobGc.MakeOptions<never, never, never>))

  it.effect("[EDD-9118]: invalid options and members", () =>
    withStore(
      Effect.gen(function* () {
        for (const [options, message] of [
          [{ entities: { Plain }, sweep: { gracePeriod: "30 minutes" } }, "sweep.gracePeriod"],
          [{ entities: { Plain }, reaper: { gracePeriod: -1 } }, "reaper.gracePeriod"],
          [{ entities: { Plain }, reaper: { confirm: "never" } }, "reaper.confirm"],
          [{ entities: { Plain }, purge: true }, "unknown option purge"],
          [{ entities: { Plain: { _tag: "Entity" } } }, "entities.Plain is not"],
          [{ aggregates: { Matches: Plain } }, "aggregates.Matches is not"],
          [{}, "no member"],
        ] as const) {
          const text = defectOf(yield* madeWith(options))
          expect(text).toContain("[EDD-9118]")
          expect(text).toContain(message)
        }
        const plainOnly = Entity.make({
          model: Doc,
          entityType: "Bare",
          primaryKey: docKey,
        })
        Table.make({ schema: AppSchema, entities: { plainOnly } })
        expect(defectOf(yield* madeWith({ entities: { plainOnly } }))).toContain(
          "has no offloaded field",
        )
      }),
    ),
  )

  it.effect("a pure definition is promoted, as DynamoClient.make promotes it", () =>
    withStore(
      Effect.gen(function* () {
        const PureDocs = SchemaEntity.make({
          model: docModel,
          entityType: "Plain",
          primaryKey: docKey,
        })
        const PureTable = Table.make({ schema: AppSchema, entities: { PureDocs } })
        const db = yield* client
        yield* db.entities.Plain.put({ docId: "p-1", title: "t", body: text(100) })
        const gc = yield* BlobGc.make({ entities: { PureDocs } }).pipe(
          Effect.provide(PureTable.layer({ name: MAIN })),
        )
        expect(yield* gc.sweep("PureDocs", { docId: "p-1" })).toMatchObject({
          referenced: 1,
          listed: 1,
        })
      }),
    ),
  )

  it.effect("[EDD-9118]: a sweep grace under the store's maxUploadAge + 15 minutes", () =>
    Effect.suspend(() => {
      blobs = BlobStore.memory({ maxUploadAge: "3 hours" })
      return withStore(
        Effect.gen(function* () {
          const exit = yield* madeWith({ entities: { Plain }, sweep: { gracePeriod: "3 hours" } })
          expect(defectOf(exit)).toContain("[EDD-9118]")
          // The default grows with the store's in-flight age.
          const gc = yield* BlobGc.make({ entities: { Plain } })
          expect(gc).toBeDefined()
        }),
      )
    }),
  )

  it.effect("[EDD-9118]: sweeps on a store without list, marks or head", () => {
    const memory = BlobStore.memory()
    const { list: _list, ...noList } = memory
    const { head: _head, ...noHead } = memory
    const { marks: _marks, ...noMarks } = memory
    const lacks = (store: object, missing: string) =>
      withService(
        store as BlobStoreService,
        Effect.gen(function* () {
          const gc = yield* BlobGc.make({ entities: { Plain }, aggregates: { Matches } })
          const exits: Array<Exit.Exit<unknown, unknown>> = [
            yield* Effect.exit(gc.sweep("Plain", { docId: "p-1" })),
            yield* Effect.exit(gc.sweepPartition("Matches", { matchId: "m-1" })),
            yield* Effect.exit(Stream.runCollect(gc.sweepStore())),
          ]
          for (const exit of missing === "head" ? exits.slice(2) : exits) {
            const text = defectOf(exit)
            expect(text).toContain("[EDD-9118]")
            expect(text).toContain(`lacks ${missing}`)
          }
          if (missing === "head") {
            for (const exit of exits.slice(0, 2)) expect(Exit.isSuccess(exit)).toBe(true)
          }
        }),
      )
    return Effect.gen(function* () {
      yield* lacks(noList, "list")
      yield* lacks(noMarks, "marks")
      yield* lacks(noHead, "head")
    })
  })

  it.effect("[EDD-9146]: a member on a table without escapeKeys, before the store", () =>
    Effect.gen(function* () {
      const Unescaped = Entity.make({
        model: docModel,
        entityType: "Unescaped",
        primaryKey: docKey,
      })
      const UnescapedTable = Table.make({
        schema: DynamoSchema.make({ name: "gc", version: 1, escapeKeys: false }),
        entities: { Unescaped },
      })
      const exit = yield* Effect.exit(BlobGc.make({ entities: { Unescaped } })).pipe(
        Effect.provide(Layer.merge(tables(), UnescapedTable.layer({ name: MAIN }))),
      )
      const text = defectOf(exit)
      expect(text).toContain("[EDD-9146] BlobGc.make")
      expect(text).toContain('entity "Unescaped"')
    }),
  )

  it.effect("[EDD-9115]: no store in context", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(BlobGc.make({ entities: { Plain } })).pipe(
        Effect.provide(tables()),
      )
      expect(defectOf(exit)).toContain("[EDD-9115]")
    }),
  )
})
