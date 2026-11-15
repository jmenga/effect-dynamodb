/**
 * `Entity.purge` of an offloading entity (#179, design §11.6): the item's
 * versions are deleted only after every DynamoDB delete succeeded, from a
 * bracketed re-read of the family; a partial purge leaves the store
 * untouched; a write racing the purge (a `create`, a time-series `append`)
 * keeps its new versions; young unnamed versions are left for the sweep; a
 * family whose live row never settles is left to the sweep whole; a store
 * without `list` deletes only what the purged rows named.
 */

import { describe, expect, it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { BlobStoreError, DynamoError } from "@effect-dynamodb/schema/Errors.js"
import type { BlobRef } from "@effect-dynamodb/schema/internal/BlobPointer.js"
import { crc64nvme } from "@effect-dynamodb/schema/internal/Crc64Nvme.js"
import { Effect, Layer, Logger, References, Schema } from "effect"
import { TestClock } from "effect/testing"
import { beforeEach } from "vitest"
import { BlobStore, type BlobStoreService } from "../src/BlobStore.js"
import { DynamoClient, type DynamoClientService } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import { familyPrefix } from "../src/internal/BlobKeys.js"
import { pointerOf } from "../src/internal/GcSupport.js"
import type { MemoryBlobStore } from "../src/internal/MemoryBlobStore.js"
import * as Table from "../src/Table.js"
import {
  hooks,
  InMemoryClient,
  type Item,
  keyOf,
  resetStore,
  store as rows,
} from "./helpers/InMemoryTables.js"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const AppSchema = DynamoSchema.make({ name: "purge", version: 1, escapeKeys: true })
const MAIN = "main"

const Text = Schema.Struct({ text: Schema.String })
const text = (jsonBytes: number, fill = "x") => ({ text: fill.repeat(jsonBytes - 11) })
const bytes = (n: number, fill = 7) => new Uint8Array(n).fill(fill)
const overflow = DynamoModel.Packed({ format: "json", external: { threshold: 16 } })

class Doc extends Schema.Class<Doc>("Doc")({
  docId: Schema.String,
  title: Schema.String,
  body: Schema.optional(Text),
}) {}
const docKey = {
  pk: { field: "pk", composite: ["docId"] },
  sk: { field: "sk", composite: [] },
} as const

/** Retain and soft delete: the item's versions are shared across its rows. */
const Kept = Entity.make({
  model: DynamoModel.configure(Doc, { body: { storedAs: overflow } }),
  entityType: "Kept",
  primaryKey: docKey,
  versioned: { retain: true },
  softDelete: true,
})

class Reading extends Schema.Class<Reading>("Reading")({
  sensorId: Schema.String,
  at: Schema.Number,
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
      raw: Schema.optional(Schema.Uint8Array),
    }),
  },
})

const MainTable = Table.make({ schema: AppSchema, entities: { Kept, Readings } })

/** What runs right after a `BatchWriteItem` lands; whether the next one fails. */
const afterBatch: Array<Effect.Effect<void>> = []
const batchScript = { failAt: 0, seen: 0 }

const HookedClient = Layer.effect(
  DynamoClient,
  Effect.map(
    Effect.service(DynamoClient),
    (inner): DynamoClientService => ({
      ...inner,
      batchWriteItem: (input) =>
        Effect.suspend(() => {
          batchScript.seen++
          if (batchScript.failAt === batchScript.seen) {
            return Effect.fail(
              new DynamoError({ operation: "BatchWriteItem", cause: new Error("unavailable") }),
            )
          }
          return Effect.tap(inner.batchWriteItem(input), () =>
            Effect.forEach(afterBatch.splice(0), (effect) => effect, { discard: true }),
          )
        }),
    }),
  ),
).pipe(Layer.provide(InMemoryClient))

let blobs: MemoryBlobStore = BlobStore.memory()
/** How many rows were left when the store was first asked to delete. */
let rowsAtFirstDelete: number | undefined

const freshStore = () =>
  BlobStore.memory({
    failures: (call) => {
      if (call.action === "delete" && rowsAtFirstDelete === undefined) rowsAtFirstDelete = rows.size
      return undefined
    },
  })

const layers = (store: BlobStoreService) =>
  Layer.mergeAll(HookedClient, MainTable.layer({ name: MAIN }), BlobStore.layer(store))
const withStore = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.suspend(() => effect.pipe(Effect.provide(layers(blobs))))

beforeEach(() => {
  resetStore()
  afterBatch.length = 0
  batchScript.failAt = 0
  batchScript.seen = 0
  rowsAtFirstDelete = undefined
  blobs = freshStore()
})

const client = DynamoClient.make({ entities: { Kept, Readings }, tables: { MainTable } })

const exists = (ref: BlobRef) =>
  blobs.inspect().versions.some((v) => v.ref.key === ref.key && v.ref.version === ref.version)
const refsOf = (entityType: string, attribute: string): Array<BlobRef> => {
  const out: Array<BlobRef> = []
  for (const row of rows.values()) {
    if (row.__edd_e__?.S !== entityType) continue
    const pointer = pointerOf(row[attribute])
    if (pointer !== undefined) out.push(pointer.ref)
  }
  return out
}
const liveRow = (entityType: string): Item =>
  [...rows.values()].find(
    (row) => row.__edd_e__?.S === entityType && !/#(v|deleted|e)#/.test(row.sk!.S!),
  )!

/** Upload a stray version into a family, as a write whose DynamoDB request never landed. */
const stray = (prefix: string, content: string) =>
  Effect.gen(function* () {
    const body = new TextEncoder().encode(content)
    return (yield* blobs.put({
      key: `${prefix}${"0".repeat(32)}`,
      body,
      contentLength: body.length,
      checksum: Effect.succeed({ algorithm: "crc64nvme", value: crc64nvme(body) }),
      contentType: "application/json",
      metadata: { "edd-v": "1" },
    })).ref
  })

/** A Kept item with three versions, held by its live row, snapshots and a tombstone. */
const seedKept = Effect.gen(function* () {
  const db = yield* client
  yield* db.entities.Kept.put({ docId: "k-1", title: "t", body: text(100, "a") })
  yield* db.entities.Kept.update({ docId: "k-1" }).set({ body: text(100, "b") })
  yield* db.entities.Kept.update({ docId: "k-1" }).set({ body: text(100, "c") })
  const live = liveRow("Kept")
  const prefix = familyPrefix("", {
    table: MAIN,
    pk: live.pk as { S: string },
    familySk: live.sk as { S: string },
  })
  yield* db.entities.Kept.delete({ docId: "k-1" })
  return { db, prefix }
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Entity.purge — offloaded versions", () => {
  it.effect("deletes the item's versions only after every row delete succeeded", () =>
    withStore(
      Effect.gen(function* () {
        const { db } = yield* seedKept
        const named = refsOf("Kept", "body")
        expect(new Set(named.map((r) => r.version)).size).toBe(3)
        yield* db.entities.Kept.purge({ docId: "k-1" })
        expect(rows.size).toBe(0)
        expect(rowsAtFirstDelete).toBe(0)
        expect(blobs.inspect().versions).toHaveLength(0)
        expect(blobs.inspect().calls.delete).toBe(1)
      }),
    ),
  )

  it.effect("a partial purge leaves the store untouched", () =>
    withStore(
      Effect.gen(function* () {
        const db = yield* client
        yield* db.entities.Kept.put({ docId: "k-1", title: "t", body: text(100) })
        // 26 snapshots and the live row: two batches, the second fails.
        for (let i = 0; i < 26; i++) {
          yield* db.entities.Kept.update({ docId: "k-1" }).set({ title: `t${i}` })
        }
        const versions = blobs.inspect().versions.length
        batchScript.failAt = 2
        const error = yield* Effect.flip(db.entities.Kept.purge({ docId: "k-1" }))
        expect(error).toBeInstanceOf(DynamoError)
        expect(rows.size).toBe(2)
        expect(blobs.inspect().versions).toHaveLength(versions)
        expect(blobs.inspect().calls.delete).toBe(0)
      }),
    ),
  )

  it.effect("a create racing the purge keeps its version; young strays are left", () =>
    withStore(
      Effect.gen(function* () {
        const { db, prefix } = yield* seedKept
        const named = refsOf("Kept", "body")
        const young = yield* stray(prefix, '{"text":"young"}')
        // A writer re-creates the item between the row deletes and the store step.
        afterBatch.push(
          Effect.orDie(
            db.entities.Kept.put({ docId: "k-1", title: "again", body: text(100, "z") }).asEffect(),
          ),
        )
        yield* db.entities.Kept.purge({ docId: "k-1" })
        // The re-created live row and its first snapshot hold one new version.
        const recreated = refsOf("Kept", "body")
        expect(new Set(recreated.map((ref) => ref.version)).size).toBe(1)
        expect(exists(recreated[0]!)).toBe(true)
        for (const ref of named) expect(exists(ref)).toBe(false)
        // Unnamed and too young to be settled: left for the sweep.
        expect(exists(young)).toBe(true)
      }),
    ),
  )

  it.effect("old unnamed versions are deleted; a time-series append racing it is kept", () =>
    withStore(
      Effect.gen(function* () {
        const db = yield* client
        yield* db.entities.Readings.append({ sensorId: "r-1", at: 1, raw: bytes(4, 1) })
        yield* db.entities.Readings.append({ sensorId: "r-1", at: 2, raw: bytes(4, 2) })
        const named = refsOf("Reading", "raw")
        const prefix = familyPrefix("", {
          table: MAIN,
          pk: liveRow("Reading").pk as { S: string },
          familySk: liveRow("Reading").sk as { S: string },
        })
        const old = yield* stray(prefix, '{"text":"old"}')
        yield* TestClock.adjust("2 hours")
        // An append lands once the current item is gone (its CAS passes); by
        // the store step its version is old enough to be settled, so only the
        // re-read of the family keeps it.
        afterBatch.push(
          Effect.orDie(
            Effect.asVoid(
              db.entities.Readings.append({ sensorId: "r-1", at: 3, raw: bytes(4, 3) }).asEffect(),
            ),
          ).pipe(Effect.andThen(TestClock.adjust("2 hours"))),
        )
        yield* db.entities.Readings.purge({ sensorId: "r-1" })
        for (const ref of named) expect(exists(ref)).toBe(false)
        expect(exists(old)).toBe(false)
        const appended = refsOf("Reading", "raw")
        expect(appended).toHaveLength(2)
        expect(exists(appended[0]!)).toBe(true)
      }),
    ),
  )

  it.effect("a writer churning the live row leaves every version to the sweep, logged", () => {
    const lines: Array<{ readonly message: string; readonly annotations: object }> = []
    const logger = Logger.make((options) => {
      if (options.logLevel !== "Warn") return
      const message = Array.isArray(options.message) ? options.message[0] : options.message
      lines.push({
        message: String(message),
        annotations: options.fiber.getRef(References.CurrentLogAnnotations),
      })
    })
    return withStore(
      Effect.gen(function* () {
        const { db } = yield* seedKept
        const named = refsOf("Kept", "body")
        // A writer re-creates the item once its rows are gone, then changes
        // the live row after every read of it: the re-read never settles.
        let n = 0
        const churn = () => {
          const row = liveRow("Kept")
          rows.set(keyOf(MAIN, row), { ...row, title: { S: `t${n++}` } })
          hooks.afterGet.push(churn)
        }
        afterBatch.push(
          Effect.orDie(
            db.entities.Kept.put({ docId: "k-1", title: "again", body: text(100, "z") }).asEffect(),
          ),
          Effect.sync(() => hooks.afterGet.push(churn)),
        )
        yield* db.entities.Kept.purge({ docId: "k-1" })
        hooks.afterGet = []
        expect(n).toBe(6)
        for (const ref of named) expect(exists(ref)).toBe(true)
        for (const ref of refsOf("Kept", "body")) expect(exists(ref)).toBe(true)
        expect(blobs.inspect().calls.delete).toBe(0)
        expect(blobs.inspect().calls.list).toBe(0)
        expect(lines).toHaveLength(1)
        expect(lines[0]!.message).toContain("left its offloaded versions to the sweep")
        expect(lines[0]!.annotations).toMatchObject({ table: MAIN })
      }).pipe(Effect.provide(Logger.layer([logger]))),
    )
  })

  it.effect("a store without list deletes only the versions the purged rows named", () =>
    Effect.gen(function* () {
      const db = yield* client
      yield* db.entities.Kept.put({ docId: "k-1", title: "t", body: text(100) })
      const named = refsOf("Kept", "body")
      const prefix = familyPrefix("", {
        table: MAIN,
        pk: liveRow("Kept").pk as { S: string },
        familySk: liveRow("Kept").sk as { S: string },
      })
      const old = yield* stray(prefix, '{"text":"old"}')
      yield* TestClock.adjust("2 hours")
      yield* db.entities.Kept.purge({ docId: "k-1" })
      for (const ref of named) expect(exists(ref)).toBe(false)
      expect(exists(old)).toBe(true)
    }).pipe(
      Effect.provide(
        Layer.suspend(() => {
          const { list: _, ...withoutList } = blobs
          return layers(withoutList as BlobStoreService)
        }),
      ),
    ),
  )

  it.effect("without a store, an offloading entity's purge deletes nothing", () =>
    Effect.gen(function* () {
      yield* Kept.put({ docId: "k-1", title: "t" }).asEffect()
      const before = rows.size
      const error = yield* Effect.flip(Kept.purge({ docId: "k-1" }).asEffect())
      expect(error).toBeInstanceOf(BlobStoreError)
      expect((error as BlobStoreError).reason).toBe("NotProvided")
      expect(rows.size).toBe(before)
    }).pipe(Effect.provide(Layer.mergeAll(HookedClient, MainTable.layer({ name: MAIN })))),
  )
})
