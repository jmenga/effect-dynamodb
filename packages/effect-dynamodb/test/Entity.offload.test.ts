/**
 * Entity single-item writes of offloaded fields (#179, design §6.1–§6.5,
 * §6.8, §6.12, §6.13): routing (per-field thresholds, then the item budget),
 * uploads through the operation's ledger and their settlement, the pointers
 * each request carries, immutables, the size-rejection retry, time-series
 * appends, lifecycle copies, write results, and the bind-time checks.
 *
 * Requests are captured from an in-memory DynamoDB; objects land in the
 * in-memory blob store, whose call counts say what was uploaded, fetched and
 * deleted. Rows are inspected as stored; the read paths are
 * `Entity.offload.read.test.ts`'s.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { describe, expect, it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import {
  BlobStoreError,
  DynamoValidationError,
  ValidationError,
} from "@effect-dynamodb/schema/Errors.js"
import * as BlobPointer from "@effect-dynamodb/schema/internal/BlobPointer.js"
import { crc64nvme } from "@effect-dynamodb/schema/internal/Crc64Nvme.js"
import { Deferred, Effect, Exit, Layer, Option, Schema } from "effect"
import { TestClock } from "effect/testing"
import { beforeEach } from "vitest"
import * as Aggregate from "../src/Aggregate.js"
import { BlobStore, BlobStoreFailure, type BlobStoreService } from "../src/BlobStore.js"
import { DynamoClient, type DynamoClientService } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import { objectKey } from "../src/internal/BlobKeys.js"
import type { MemoryBlobStore } from "../src/internal/MemoryBlobStore.js"
import * as Offload from "../src/Offload.js"
import * as Table from "../src/Table.js"
import {
  InMemoryClient,
  type Item,
  keyOf,
  resetStore,
  store as rows,
} from "./helpers/InMemoryTables.js"
import {
  awsValidationException,
  DDB_ITEM_SIZE,
  DDB_ITEM_SIZE_UPDATE,
} from "./helpers/MockDynamoClient.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const AppSchema = DynamoSchema.make({ name: "off", version: 1, escapeKeys: true })

const Text = Schema.Struct({ text: Schema.String })
const Origin = Schema.Struct({ source: Schema.String, tags: Schema.Array(Schema.String) })

class Doc extends Schema.Class<Doc>("Doc")({
  docId: Schema.String,
  title: Schema.String,
  body: Schema.optional(Text),
  notes: Schema.optional(Text),
  scan: Schema.optional(Schema.Uint8Array),
  origin: Schema.optional(Origin),
  meta: Schema.optional(Schema.Struct({ n: Schema.Number })),
}) {}

/** `{"text":"…"}` is 11 bytes plus the text. */
const text = (jsonBytes: number) => ({ text: "x".repeat(jsonBytes - 11) })
/** An origin whose JSON is `jsonBytes` bytes (`{"source":"s","tags":["…"]}`). */
const originOf = (jsonBytes: number, source = "s") => ({
  source,
  tags: ["t".repeat(jsonBytes - 25 - source.length)],
})

const overflow = (threshold: number) =>
  DynamoModel.Packed({ format: "json", external: { threshold } })
const pdf = DynamoModel.External({ contentType: "application/pdf" })

const docKey = {
  pk: { field: "pk", composite: ["docId"] },
  sk: { field: "sk", composite: [] },
} as const

const docModel = (threshold: number) =>
  DynamoModel.configure(Doc, {
    body: { storedAs: overflow(threshold) },
    notes: { field: "n", storedAs: overflow(threshold) },
    scan: { storedAs: pdf },
    origin: { storedAs: overflow(threshold), immutable: true },
  })

/** Plain: thresholds of 64 bytes, no item budget. */
const Docs = Entity.make({ model: docModel(64), entityType: "Doc", primaryKey: docKey })

/** Thresholds out of reach: only the item budget routes. */
const Budgeted = Entity.make({
  model: docModel(100_000),
  entityType: "Budgeted",
  primaryKey: docKey,
  offload: { itemBudget: 3_000 },
})

/** One reachable threshold beside a budget: an update's first attempt uploads. */
const Mixed = Entity.make({
  model: DynamoModel.configure(Doc, {
    body: { storedAs: overflow(64) },
    notes: { field: "n", storedAs: overflow(100_000) },
  }),
  entityType: "Mixed",
  primaryKey: docKey,
  offload: { itemBudget: 3_000 },
})

/** Version snapshots and tombstones: lifecycle copies of pointers. */
const Kept = Entity.make({
  model: docModel(64),
  entityType: "Kept",
  primaryKey: docKey,
  versioned: { retain: true },
  softDelete: true,
})

class Scan extends Schema.Class<Scan>("Scan")({
  scanId: Schema.String,
  label: Schema.String,
  image: Schema.Uint8Array,
}) {}

/** A binary immutable. */
const Scans = Entity.make({
  model: DynamoModel.configure(Scan, { image: { storedAs: pdf, immutable: true } }),
  entityType: "Scan",
  primaryKey: { pk: { field: "pk", composite: ["scanId"] }, sk: { field: "sk", composite: [] } },
})

class KeptScan extends Schema.Class<KeptScan>("KeptScan")({
  scanId: Schema.String,
  label: Schema.String,
  image: Schema.optional(Schema.Uint8Array),
}) {}

/** An optional binary immutable on a retain entity: its upsert takes the read-merge path. */
const KeptScans = Entity.make({
  model: DynamoModel.configure(KeptScan, { image: { storedAs: pdf, immutable: true } }),
  entityType: "KeptScan",
  primaryKey: { pk: { field: "pk", composite: ["scanId"] }, sk: { field: "sk", composite: [] } },
  versioned: { retain: true },
})

class Reading extends Schema.Class<Reading>("Reading")({
  sensorId: Schema.String,
  at: Schema.Number,
  value: Schema.Number,
  raw: Schema.optional(Schema.Uint8Array),
  label: Schema.optional(Schema.String),
  detail: Schema.optional(Text),
}) {}

const readingConfig = {
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
      label: Schema.optional(Schema.String),
    }),
  },
} as const

/** A budget too: an append is never retried for size (no read-merge form). */
const Readings = Entity.make({
  ...readingConfig,
  model: DynamoModel.configure(Reading, {
    raw: { storedAs: DynamoModel.External() },
    detail: { storedAs: overflow(100_000) },
  }),
  offload: { itemBudget: 2_000 },
})

/** The same items, appended by a member that no longer offloads (§4.7). */
const LegacyReadings = Entity.make({
  ...readingConfig,
  model: DynamoModel.configure(Reading, {
    detail: { storedAs: DynamoModel.Packed({ format: "json" }) },
  }),
})
const LegacyTable = Table.make({ schema: AppSchema, entities: { LegacyReadings } })

class Wide extends Schema.Class<Wide>("Wide")({
  id: Schema.String,
  email: Schema.String,
  totals: Schema.Record(Schema.String, Schema.Number),
  body: Schema.optional(Text),
}) {}

/** Unversioned, unique, with a sparse map: the read-merge update's wide fallback. */
const Wides = Entity.make({
  model: DynamoModel.configure(Wide, {
    totals: { storedAs: DynamoModel.SparseMap() },
    body: { storedAs: overflow(64) },
  }),
  entityType: "Wide",
  primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
  unique: { email: ["email"] },
})

const gzipped = DynamoModel.Packed({
  format: "json",
  compression: { codec: "gzip", threshold: 0 },
})

class Venue extends Schema.Class<Venue>("Venue")({
  venueId: Schema.String.pipe(DynamoModel.identifier),
  name: Schema.String,
  plan: Schema.optional(Schema.Uint8Array),
  layout: Schema.optional(Text),
}) {}

/** For the aggregate bind checks: an edge entity with a binary field. */
const Venues = Entity.make({
  model: DynamoModel.configure(Venue, { plan: { storedAs: pdf } }),
  entityType: "Venue",
  primaryKey: { pk: { field: "pk", composite: ["venueId"] }, sk: { field: "sk", composite: [] } },
})

/** For the codec checks: a packed field needing gzip. */
const Gzipped = Entity.make({
  model: DynamoModel.configure(Venue, { layout: { storedAs: gzipped } }),
  entityType: "GzVenue",
  primaryKey: { pk: { field: "pk", composite: ["venueId"] }, sk: { field: "sk", composite: [] } },
})

class Match extends Schema.Class<Match>("Match")({
  matchId: Schema.String,
  name: Schema.String,
  venue: Venue,
}) {}

const MainTable = Table.make({
  schema: AppSchema,
  entities: { Docs, Budgeted, Mixed, Kept, Scans, KeptScans, Readings, Wides, Venues, Gzipped },
})

const matchesOver = (entity: typeof Venues | typeof Gzipped) =>
  Aggregate.make(Match, {
    table: MainTable,
    schema: AppSchema,
    pk: { field: "pk", composite: ["matchId"] },
    collection: { name: "match" },
    root: { entityType: "MatchItem" },
    edges: { venue: Aggregate.one("venue", { entityType: "MatchVenue", entity }) },
  })
const Matches = matchesOver(Venues)
const GzMatches = matchesOver(Gzipped)

/** Key text not escaped (#183): offloading requires it escaped (`EDD-9146`, design §11.10). */
const UnescapedSchema = DynamoSchema.make({ name: "off", version: 1, escapeKeys: false })
const UnescapedDocs = Entity.make({ model: docModel(64), entityType: "Doc", primaryKey: docKey })
const UnescapedTable = Table.make({ schema: UnescapedSchema, entities: { UnescapedDocs } })
const UnescapedMatches = Aggregate.make(Match, {
  table: UnescapedTable,
  schema: UnescapedSchema,
  pk: { field: "pk", composite: ["matchId"] },
  collection: { name: "match" },
  root: { entityType: "MatchItem" },
  edges: { venue: Aggregate.one("venue", { entityType: "MatchVenue", entity: Venues }) },
})

/**
 * The offloading members with their offloaded declarations removed, on the same schema with
 * `escapeKeys` turned off: the only way a table offloading wrote can be rekeyed off escaped text.
 */
const PlainDocs = Entity.make({ model: Doc, entityType: "Doc", primaryKey: docKey })
const PlainKept = Entity.make({
  model: Doc,
  entityType: "Kept",
  primaryKey: docKey,
  versioned: { retain: true },
  softDelete: true,
})
const PlainReadings = Entity.make({
  model: Reading,
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
      label: Schema.optional(Schema.String),
    }),
  },
})
const PlainTable = Table.make({
  schema: UnescapedSchema,
  entities: { PlainDocs, PlainKept, PlainReadings },
})

// ---------------------------------------------------------------------------
// The capturing client
// ---------------------------------------------------------------------------

interface Sent {
  readonly command: string
  readonly input: any
}

const sent: Array<Sent> = []
/** The next request of a command is refused with this `ValidationException` (sent once). */
const refuseNext = new Map<string, string>()
/** The SDK attempts a refusal of the in-memory tables reports (1: sent once). */
let refusalAttempts = 1

const METHODS = {
  getItem: "GetItem",
  putItem: "PutItem",
  updateItem: "UpdateItem",
  deleteItem: "DeleteItem",
  query: "Query",
  transactWriteItems: "TransactWriteItems",
  executeStatement: "ExecuteStatement",
  executeTransaction: "ExecuteTransaction",
} as const satisfies Partial<Record<keyof DynamoClientService, string>>

/**
 * Captures every request and answers as the in-memory tables do, with what
 * DynamoDB adds that they do not: `$metadata.attempts` on a failure (the SDK
 * sent it once) and the stored item on a `ConditionalCheckFailedException`
 * that asked for `ALL_OLD`.
 */
const SpyClient = Layer.effect(
  DynamoClient,
  Effect.map(Effect.service(DynamoClient), (inner): DynamoClientService => {
    const spied: Record<string, unknown> = { ...inner }
    for (const [method, command] of Object.entries(METHODS)) {
      spied[method] = (input: any) =>
        Effect.suspend(() => {
          sent.push({ command, input })
          const refusal = refuseNext.get(command)
          if (refusal !== undefined) {
            refuseNext.delete(command)
            return Effect.fail(
              new DynamoValidationError({
                operation: command,
                cause: Object.assign(awsValidationException(refusal), {
                  $metadata: { attempts: 1 },
                }),
              }),
            )
          }
          const key = input.Key ?? input.Item
          const old = key === undefined ? undefined : rows.get(keyOf(input.TableName, key))
          return (
            inner as unknown as Record<string, (i: unknown) => Effect.Effect<unknown, unknown>>
          )[method]!(input).pipe(
            Effect.mapError((error) => {
              const cause = (error as { readonly cause?: { readonly name?: string } }).cause
              if (
                cause?.name === "ConditionalCheckFailedException" ||
                cause?.name === "TransactionCanceledException" ||
                cause?.name === "DuplicateItemException"
              ) {
                Object.assign(cause, { $metadata: { attempts: refusalAttempts } })
                if (input.ReturnValuesOnConditionCheckFailure === "ALL_OLD" && old !== undefined) {
                  Object.assign(cause, { Item: old })
                }
              }
              return error
            }),
          )
        })
    }
    return spied as unknown as DynamoClientService
  }),
).pipe(Layer.provide(InMemoryClient))

let blobs: MemoryBlobStore = BlobStore.memory()

const tableLayer = MainTable.layer({ name: "main" })
/** The client, the table and a fresh in-memory store (`blobs`). */
const withStore = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.suspend(() =>
    effect.pipe(Effect.provide(Layer.mergeAll(SpyClient, tableLayer, BlobStore.layer(blobs)))),
  )
/** The client, the table, `store` and an observer collecting into `reports`. */
const withService = <A, E, R>(
  store: BlobStoreService,
  reports: Array<Offload.UnsettledUpload>,
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.provide(
      Layer.mergeAll(
        SpyClient,
        tableLayer,
        BlobStore.layer(store),
        Offload.layerObserver({
          onUnsettled: (upload) =>
            Effect.sync(() => {
              reports.push(upload)
            }),
        }),
      ),
    ),
  )
/** The client and the table, no store. */
const withoutStore = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(Layer.mergeAll(SpyClient, tableLayer)))

beforeEach(() => {
  resetStore()
  sent.length = 0
  refuseNext.clear()
  refusalAttempts = 1
  blobs = BlobStore.memory()
})

const client = DynamoClient.make({
  entities: { Docs, Budgeted, Mixed, Kept, Scans, KeptScans, Readings, Wides },
  tables: { MainTable },
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const calls = () => blobs.inspect().calls
const versions = () => blobs.inspect().versions
const commands = () => sent.map((s) => s.command)
const lastOf = (command: string) => sent.filter((s) => s.command === command).at(-1)?.input

/** The live row of an entity type by its id attribute. */
const live = (entityType: string, id: string, idField = "docId"): Item => {
  const row = [...rows.values()].find(
    (item) =>
      item.__edd_e__?.S === entityType &&
      item[idField]?.S === id &&
      !/#(v|deleted|e)#/.test(item.sk?.S ?? ""),
  )
  if (row === undefined) throw new Error(`no live ${entityType} row ${id}`)
  return row
}
const rowsWhere = (entityType: string, sk: RegExp): Array<Item> =>
  [...rows.values()].filter((item) => item.__edd_e__?.S === entityType && sk.test(item.sk!.S!))

/** An overflow attribute's stored pointer (`B`). */
const overflowPointer = (value: AttributeValue | undefined): BlobPointer.BlobPointer => {
  expect(value?.B).toBeInstanceOf(Uint8Array)
  const pointer = BlobPointer.decode(value!.B!)
  if (typeof pointer === "string") throw new Error(pointer)
  expect(pointer.kind).toBe("json")
  return pointer
}
/** A binary attribute's stored pointer (`~edbp:` text). */
const binaryPointer = (value: AttributeValue | undefined): BlobPointer.BlobPointer => {
  expect(typeof value?.S).toBe("string")
  const pointer = BlobPointer.decodeText(value!.S!)
  if (pointer === undefined || typeof pointer === "string") throw new Error(String(pointer))
  expect(pointer.kind).toBe("bytes")
  return pointer
}
const isPointer = (value: AttributeValue | undefined): boolean =>
  (value?.B !== undefined && BlobPointer.isPointerHeader(value.B[0]!)) ||
  (value?.S !== undefined && BlobPointer.isPointerText(value.S))

const failureOf = <A, E>(exit: Exit.Exit<A, E>): E => {
  if (Exit.isSuccess(exit)) throw new Error("expected a failure")
  const reason = exit.cause.reasons.find((r) => r._tag === "Fail")
  if (reason === undefined || reason._tag !== "Fail") throw new Error("expected a Fail reason")
  return reason.error
}
const defectOf = (exit: Exit.Exit<unknown, unknown>): string => {
  if (Exit.isSuccess(exit)) throw new Error("expected a defect")
  const reason = exit.cause.reasons.find((r) => r._tag === "Die")
  if (reason === undefined || reason._tag !== "Die") throw new Error("expected a Die reason")
  return String((reason.defect as Error).message ?? reason.defect)
}

/** The attribute names an UpdateItem writes (SET / REMOVE targets). */
const namesOf = (input: { readonly ExpressionAttributeNames?: Record<string, string> }) =>
  Object.values(input.ExpressionAttributeNames ?? {})

const pdfBytes = (n: number, fill = 7) => new Uint8Array(n).fill(fill)

// ---------------------------------------------------------------------------
// put / create — thresholds
// ---------------------------------------------------------------------------

describe("Entity offload — put / create routing", () => {
  it.effect("a value under its threshold stays inline; at or over it, it uploads", () =>
    withStore(
      Effect.gen(function* () {
        const db = yield* client
        yield* db.entities.Docs.put({
          docId: "d-1",
          title: "t",
          body: text(63),
          notes: text(64),
          origin: originOf(200),
        })
        const row = live("Doc", "d-1")
        expect(row.body?.S).toBe(JSON.stringify(text(63)))
        expect(overflowPointer(row.n).contentSize).toBe(64)
        expect(isPointer(row.origin)).toBe(true)
        expect(calls().put).toBe(2)
        // One version per offloaded attribute, under the row's object keys.
        const keys = versions().map((v) => v.ref.key)
        expect(new Set(keys).size).toBe(2)
        expect(keys).toContain(overflowPointer(row.n).ref.key)
      }),
    ),
  )

  it.effect("a binary value always uploads, stored as ~edbp: text with its content type", () =>
    withStore(
      Effect.gen(function* () {
        const db = yield* client
        const scan = pdfBytes(1)
        const result = yield* db.entities.Docs.create({ docId: "d-1", title: "t", scan })
        const pointer = binaryPointer(live("Doc", "d-1").scan)
        expect(Option.getOrUndefined(pointer.contentType)).toBe("application/pdf")
        expect(pointer.contentSize).toBe(1)
        expect(pointer.checksum.value).toEqual(crc64nvme(scan))
        expect(versions()[0]!.contentType).toBe("application/pdf")
        // Binary is lazy by default: the result holds a handle on the object.
        expect(Offload.isBlobHandle(result.scan)).toBe(true)
        expect(result.scan?.contentType).toBe("application/pdf")
        // Eager, it is the input, read from what the write uploaded: no GET.
        const eager = yield* db.entities.Docs.create({ docId: "d-2", title: "t", scan }).offloaded(
          "eager",
        )
        expect(eager.scan).toEqual(scan)
        expect(calls().get).toBe(0)
      }),
    ),
  )

  it.effect("the object key is the row's: table, partition and sort key, attribute", () =>
    withStore(
      Effect.gen(function* () {
        const db = yield* client
        yield* db.entities.Docs.put({ docId: "d-1", title: "t", body: text(100) })
        const row = live("Doc", "d-1")
        expect(overflowPointer(row.body).ref.key).toBe(
          objectKey("", {
            table: "main",
            pk: row.pk as { S: string },
            familySk: row.sk as { S: string },
            rowSk: row.sk as { S: string },
            attribute: "body",
          }),
        )
      }),
    ),
  )

  it.effect("a put over an existing item uploads every offloaded field again", () =>
    withStore(
      Effect.gen(function* () {
        const db = yield* client
        const doc = { docId: "d-1", title: "t", body: text(100), scan: pdfBytes(10) }
        yield* db.entities.Docs.put(doc)
        const first = live("Doc", "d-1")
        yield* db.entities.Docs.put(doc)
        const second = live("Doc", "d-1")
        expect(calls().put).toBe(4)
        // Same content, same keys, new versions: nothing compared by checksum.
        expect(overflowPointer(second.body).ref.key).toBe(overflowPointer(first.body).ref.key)
        expect(overflowPointer(second.body).ref.version).not.toBe(
          overflowPointer(first.body).ref.version,
        )
        expect(binaryPointer(second.scan).ref.version).not.toBe(
          binaryPointer(first.scan).ref.version,
        )
        // No inline freeing: the superseded versions are the reaper's.
        expect(versions()).toHaveLength(4)
        expect(calls().delete).toBe(0)
      }),
    ),
  )

  it.effect("create over an existing item: refused, and its uploads are deleted", () =>
    withStore(
      Effect.gen(function* () {
        const db = yield* client
        yield* db.entities.Docs.put({ docId: "d-1", title: "t", body: text(100) })
        const kept = overflowPointer(live("Doc", "d-1").body).ref
        const error = yield* Effect.flip(
          db.entities.Docs.create({ docId: "d-1", title: "t", body: text(120) }).asEffect(),
        )
        expect(error._tag).toBe("ConditionalCheckFailed")
        // ALL_OLD came back without the new pointer: it provably did not commit.
        expect(lastOf("PutItem").ReturnValuesOnConditionCheckFailure).toBe("ALL_OLD")
        expect(calls().put).toBe(2)
        expect(calls().delete).toBe(1)
        expect(versions().map((v) => v.ref)).toEqual([kept])
      }),
    ),
  )

  it.effect("an unbound put that must upload with no store fails with NotProvided", () =>
    withoutStore(
      Effect.gen(function* () {
        // Nothing to offload: no store needed.
        yield* Docs.put({ docId: "d-0", title: "t", body: text(20) })
        sent.length = 0
        const error = yield* Effect.flip(
          Docs.put({ docId: "d-1", title: "t", body: text(100) }).asEffect(),
        )
        expect(error).toBeInstanceOf(BlobStoreError)
        expect((error as BlobStoreError).reason).toBe("NotProvided")
        expect((error as BlobStoreError).attribute).toBe("body")
        expect(commands()).toEqual([])
      }),
    ),
  )
})

// ---------------------------------------------------------------------------
// put — item budget
// ---------------------------------------------------------------------------

describe("Entity offload — item budget", () => {
  it.effect("under the budget nothing uploads", () =>
    withStore(
      Effect.gen(function* () {
        const db = yield* client
        yield* db.entities.Budgeted.put({
          docId: "b-1",
          title: "t",
          body: text(500),
          notes: text(500),
        })
        expect(calls().put).toBe(0)
      }),
    ),
  )

  it.effect("over it, the largest overflow value uploads first, until the item fits", () =>
    withStore(
      Effect.gen(function* () {
        const db = yield* client
        yield* db.entities.Budgeted.put({
          docId: "b-1",
          title: "t",
          body: text(1_000),
          notes: text(2_000),
        })
        const row = live("Budgeted", "b-1")
        expect(isPointer(row.n)).toBe(true)
        expect(row.body?.S).toBe(JSON.stringify(text(1_000)))
        expect(calls().put).toBe(1)
      }),
    ),
  )

  it.effect("equal sizes break ties by stored attribute name", () =>
    withStore(
      Effect.gen(function* () {
        const db = yield* client
        yield* db.entities.Budgeted.put({
          docId: "b-1",
          title: "t",
          body: text(1_600),
          notes: text(1_601),
        })
        // By stored value size: `n` (notes, renamed) holds 1,601 bytes, `body` 1,600.
        const row = live("Budgeted", "b-1")
        expect(isPointer(row.n)).toBe(true)
        expect(isPointer(row.body)).toBe(false)
        yield* db.entities.Budgeted.put({
          docId: "b-2",
          title: "t",
          body: text(1_600),
          notes: text(1_600),
        })
        // The same size: `body` sorts before `n`.
        const tie = live("Budgeted", "b-2")
        expect(isPointer(tie.body)).toBe(true)
        expect(isPointer(tie.n)).toBe(false)
      }),
    ),
  )

  it.effect("an unreachable budget sends the item, and DynamoDB's rejection is diagnosed", () =>
    withStore(
      Effect.gen(function* () {
        const db = yield* client
        refuseNext.set("PutItem", DDB_ITEM_SIZE)
        const error = yield* Effect.flip(
          db.entities.Budgeted.put({
            docId: "b-1",
            title: "x".repeat(410_000),
            body: text(1_000),
            notes: text(2_000),
          }).asEffect(),
        )
        expect(error).toBeInstanceOf(ValidationError)
        // Every offloadable value was offloaded, then rejected and deleted.
        const item = lastOf("PutItem").Item as Item
        expect(isPointer(item.body) && isPointer(item.n)).toBe(true)
        expect(calls().put).toBe(2)
        expect(calls().delete).toBeGreaterThan(0)
        expect(versions()).toHaveLength(0)
      }),
    ),
  )
})

// ---------------------------------------------------------------------------
// upsert
// ---------------------------------------------------------------------------

describe("Entity offload — upsert", () => {
  it.effect("each offloaded value uploads before it becomes its :value", () =>
    withStore(
      Effect.gen(function* () {
        const db = yield* client
        const result = yield* db.entities.Docs.upsert({
          docId: "d-1",
          title: "t",
          body: text(100),
          origin: originOf(100),
        })
        const update = lastOf("UpdateItem")
        expect(update.UpdateExpression).toMatch(/if_not_exists/)
        const row = live("Doc", "d-1")
        expect(isPointer(row.body) && isPointer(row.origin)).toBe(true)
        expect(result.body).toEqual(text(100))
        expect(calls().get).toBe(0)
      }),
    ),
  )

  it.effect("an immutable value the item already holds keeps it: the upload is settled away", () =>
    withStore(
      Effect.gen(function* () {
        const db = yield* client
        yield* db.entities.Docs.upsert({ docId: "d-1", title: "t", origin: originOf(100) })
        const first = overflowPointer(live("Doc", "d-1").origin).ref
        const result = yield* db.entities.Docs.upsert({
          docId: "d-1",
          title: "t2",
          origin: originOf(120),
        })
        // `if_not_exists` kept the stored pointer; ALL_NEW says the new one lost.
        expect(overflowPointer(live("Doc", "d-1").origin).ref).toEqual(first)
        expect(calls().put).toBe(2)
        expect(calls().delete).toBe(1)
        expect(versions().map((v) => v.ref)).toEqual([first])
        // The result holds the kept value, fetched (it is not this write's).
        expect(result.origin).toEqual(originOf(100))
        expect(calls().get).toBe(1)
      }),
    ),
  )

  it.effect("read-merge: an immutable the row lacks is routed and uploaded, never inline", () =>
    withStore(
      Effect.gen(function* () {
        const db = yield* client
        // Retain: the upsert reads the row and writes the diff.
        yield* db.entities.Kept.put({ docId: "k-1", title: "t" })
        const result = yield* db.entities.Kept.upsert({
          docId: "k-1",
          title: "t2",
          origin: originOf(500),
        })
        expect(overflowPointer(live("Kept", "k-1").origin).kind).toBe("json")
        expect(calls().put).toBe(1)
        expect(result.origin).toEqual(originOf(500))
        // A binary immutable, the same.
        yield* db.entities.KeptScans.put({ scanId: "s-1", label: "a" })
        yield* db.entities.KeptScans.upsert({ scanId: "s-1", label: "b", image: pdfBytes(3) })
        expect(binaryPointer(live("KeptScan", "s-1", "scanId").image).kind).toBe("bytes")
        expect(calls().put).toBe(2)
        // Held already: the stored value stays, nothing more uploaded for good.
        const kept = overflowPointer(live("Kept", "k-1").origin).ref
        yield* db.entities.Kept.upsert({ docId: "k-1", title: "t3", origin: originOf(500) })
        expect(overflowPointer(live("Kept", "k-1").origin).ref).toEqual(kept)
      }),
    ),
  )

  it.effect("an upsert rejected for item size is retried through the read-then-write path", () =>
    withStore(
      Effect.gen(function* () {
        const db = yield* client
        refuseNext.set("UpdateItem", DDB_ITEM_SIZE_UPDATE)
        yield* db.entities.Budgeted.upsert({
          docId: "b-1",
          title: "t",
          body: text(1_000),
          notes: text(2_000),
        })
        // Missing: created, the whole item routed.
        expect(commands()).toEqual(["UpdateItem", "GetItem", "PutItem"])
        const row = live("Budgeted", "b-1")
        expect(isPointer(row.n)).toBe(true)
        expect(isPointer(row.body)).toBe(false)
      }),
    ),
  )

  it.effect("an existing item's upsert rejected for size is updated on the read-merge path", () =>
    withStore(
      Effect.gen(function* () {
        const db = yield* client
        yield* db.entities.Budgeted.put({ docId: "b-1", title: "t", notes: text(2_000) })
        sent.length = 0
        refuseNext.set("UpdateItem", DDB_ITEM_SIZE_UPDATE)
        const result = yield* db.entities.Budgeted.upsert({
          docId: "b-1",
          title: "t2",
          body: text(1_500),
          notes: text(2_000),
        })
        // Existing: the merged item routed, written as an update of the diff.
        expect(commands()).toEqual(["UpdateItem", "GetItem", "UpdateItem"])
        const row = live("Budgeted", "b-1")
        expect(row.title?.S).toBe("t2")
        expect(isPointer(row.n)).toBe(true)
        expect(row.body?.S).toBe(JSON.stringify(text(1_500)))
        expect(calls().put).toBe(1)
        expect(calls().delete).toBe(0)
        // The result reads the upload back from the ledger: no GET.
        expect(result.notes).toEqual(text(2_000))
        expect(calls().get).toBe(0)
      }),
    ),
  )
})

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

describe("Entity offload — update", () => {
  it.effect("a named field always uploads, even with the content the item holds", () =>
    withStore(
      Effect.gen(function* () {
        const db = yield* client
        yield* db.entities.Docs.put({ docId: "d-1", title: "t", body: text(100) })
        const before = overflowPointer(live("Doc", "d-1").body).ref
        const result = yield* db.entities.Docs.update({ docId: "d-1" }).set({ body: text(100) })
        const after = overflowPointer(live("Doc", "d-1").body).ref
        expect(after.version).not.toBe(before.version)
        expect(calls().put).toBe(2)
        expect(result.body).toEqual(text(100))
        expect(calls().get).toBe(0)
      }),
    ),
  )

  it.effect("an untouched pointer is not in the request; the result fetches it", () =>
    withStore(
      Effect.gen(function* () {
        const db = yield* client
        yield* db.entities.Docs.put({ docId: "d-1", title: "t", body: text(100) })
        const before = live("Doc", "d-1").body
        const result = yield* db.entities.Docs.update({ docId: "d-1" }).set({ title: "t2" })
        expect(namesOf(lastOf("UpdateItem"))).not.toContain("body")
        expect(live("Doc", "d-1").body).toEqual(before)
        expect(calls().put).toBe(1)
        expect(result.body).toEqual(text(100))
        expect(calls().get).toBe(1)
      }),
    ),
  )

  it.effect("a result read that fails after the write committed says so", () => {
    let failGets = false
    blobs = BlobStore.memory({
      failures: (call) =>
        failGets && call.action === "get" ? { _tag: "Fail", reason: "Unavailable" } : undefined,
    })
    return withStore(
      Effect.gen(function* () {
        const db = yield* client
        yield* db.entities.Docs.put({ docId: "d-1", title: "t", body: text(100) })
        failGets = true
        const error = yield* Effect.flip(
          db.entities.Docs.update({ docId: "d-1" }).set({ title: "t2" }).asEffect(),
        )
        expect(error).toBeInstanceOf(BlobStoreError)
        expect((error as BlobStoreError).committed).toBe(true)
        expect((error as BlobStoreError).reason).toBe("Unavailable")
        expect(live("Doc", "d-1").title?.S).toBe("t2")
      }),
    )
  })

  it.effect(".remove() and set(undefined) clear an offloaded field without the store", () =>
    withStore(
      Effect.gen(function* () {
        const db = yield* client
        yield* db.entities.Docs.put({
          docId: "d-1",
          title: "t",
          body: text(100),
          scan: pdfBytes(3),
        })
        yield* db.entities.Docs.update({ docId: "d-1" }).remove(["body", "scan"])
        expect(lastOf("UpdateItem").UpdateExpression).toMatch(/REMOVE/)
        const row = live("Doc", "d-1")
        expect(row.body).toBeUndefined()
        expect(row.scan).toBeUndefined()
        expect(calls().put).toBe(2)
      }),
    ),
  )

  it.effect("the read-merge path uploads named fields and carries the rest byte-identical", () =>
    withStore(
      Effect.gen(function* () {
        const db = yield* client
        yield* db.entities.Kept.put({
          docId: "k-1",
          title: "v1",
          body: text(100),
          scan: pdfBytes(5),
        })
        const before = live("Kept", "k-1")
        sent.length = 0
        yield* db.entities.Kept.update({ docId: "k-1" }).set({ title: "v2" })
        const transaction = lastOf("TransactWriteItems").TransactItems as ReadonlyArray<{
          readonly Update?: { readonly ExpressionAttributeNames?: Record<string, string> }
          readonly Put?: { readonly Item: Item }
        }>
        const write = transaction.find((entry) => entry.Update !== undefined)!.Update!
        expect(namesOf(write)).not.toContain("body")
        expect(namesOf(write)).not.toContain("scan")
        // The version snapshot copies the pointers; nothing is uploaded.
        const snapshot = transaction.find((entry) => entry.Put !== undefined)!.Put!.Item
        expect(snapshot.body).toEqual(before.body)
        expect(snapshot.scan).toEqual(before.scan)
        expect(calls().put).toBe(2)
        // A named one uploads on the merged item.
        yield* db.entities.Kept.update({ docId: "k-1" }).set({ body: text(130) })
        expect(overflowPointer(live("Kept", "k-1").body).contentSize).toBe(130)
        expect(calls().put).toBe(3)
      }),
    ),
  )

  it.effect("the read-merge wide fallback guards every offloaded attribute first", () =>
    withStore(
      Effect.gen(function* () {
        const db = yield* client
        const totals = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`k${i}`, i]))
        yield* db.entities.Wides.put({ id: "w-1", email: "a@x.io", totals, body: text(100) })
        const body = live("Wide", "w-1", "id").body
        sent.length = 0
        const more = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`m${i}`, i]))
        yield* db.entities.Wides.update({ id: "w-1" }).set({ email: "b@x.io", totals: more })
        const put = (
          lastOf("TransactWriteItems").TransactItems as ReadonlyArray<{
            readonly Put?: {
              readonly Item: Item
              readonly ConditionExpression?: string
              readonly ExpressionAttributeNames?: Record<string, string>
              readonly ExpressionAttributeValues?: Record<string, AttributeValue>
            }
          }>
        ).find((entry) => entry.Put?.Item.id !== undefined)!.Put!
        // The whole item, carrying the pointer it read under a guard comparing it.
        expect(put.Item.body).toEqual(body)
        const guarded = Object.entries(put.ExpressionAttributeNames ?? {}).find(
          ([token, name]) => token.startsWith("#dg") && name === "body",
        )
        expect(guarded?.[0]).toBe("#dg0")
        expect(put.ExpressionAttributeValues?.[":dg0"]).toEqual(body)
        expect(calls().put).toBe(1)
      }),
    ),
  )

  it.effect("an update rejected for item size runs once more on the read-merge path", () =>
    withStore(
      Effect.gen(function* () {
        const db = yield* client
        yield* db.entities.Budgeted.put({ docId: "b-1", title: "t", notes: text(2_000) })
        sent.length = 0
        refuseNext.set("UpdateItem", DDB_ITEM_SIZE_UPDATE)
        yield* db.entities.Budgeted.update({ docId: "b-1" }).set({ body: text(1_500) })
        expect(commands()).toEqual(["UpdateItem", "GetItem", "UpdateItem"])
        // The merged item routed: the named field uploaded, the untouched one kept.
        const retry = lastOf("UpdateItem")
        expect(namesOf(retry)).toContain("body")
        expect(namesOf(retry)).not.toContain("n")
        const row = live("Budgeted", "b-1")
        expect(isPointer(row.body)).toBe(true)
        expect(row.n?.S).toBe(JSON.stringify(text(2_000)))
        expect(calls().put).toBe(1)
      }),
    ),
  )

  it.effect("the size retry reuses the first attempt's upload: one version, none deleted", () =>
    withStore(
      Effect.gen(function* () {
        const db = yield* client
        yield* db.entities.Mixed.put({ docId: "m-1", title: "t", notes: text(2_000) })
        sent.length = 0
        refuseNext.set("UpdateItem", DDB_ITEM_SIZE_UPDATE)
        yield* db.entities.Mixed.update({ docId: "m-1" }).set({ body: text(100) })
        expect(commands()).toEqual(["UpdateItem", "GetItem", "UpdateItem"])
        const row = live("Mixed", "m-1")
        const pointer = overflowPointer(row.body)
        // Both attempts carried the same pointer: attempt 1 uploaded it (its
        // threshold is reachable), and the retry took it from the ledger's memo.
        const carried = (input: { readonly ExpressionAttributeValues?: Record<string, any> }) =>
          Object.values(input.ExpressionAttributeValues ?? {}).filter((value) => isPointer(value))
        expect(carried(sent[0]!.input)).toEqual([row.body])
        expect(carried(sent[2]!.input)).toEqual([row.body])
        // Rejected with attempt 1, committed by the retry: kept.
        expect(calls().put).toBe(1)
        expect(calls().delete).toBe(0)
        expect(versions().map((v) => v.ref)).toEqual([pointer.ref])
        expect(row.n?.S).toBe(JSON.stringify(text(2_000)))
      }),
    ),
  )

  it.effect("a path-operation update is not retried: the rejection is diagnosed", () =>
    withStore(
      Effect.gen(function* () {
        const db = yield* client
        yield* db.entities.Budgeted.put({ docId: "b-1", title: "t", meta: { n: 1 } })
        sent.length = 0
        refuseNext.set("UpdateItem", DDB_ITEM_SIZE_UPDATE)
        const error = yield* Effect.flip(
          db.entities.Budgeted.update({ docId: "b-1" })
            .set({ body: text(1_500) })
            .pathSet({ segments: ["meta", "n"], value: 2, isPath: false })
            .asEffect(),
        )
        expect(error).toBeInstanceOf(ValidationError)
        expect(commands()).toEqual(["UpdateItem"])
      }),
    ),
  )
})

// ---------------------------------------------------------------------------
// Immutables
// ---------------------------------------------------------------------------

describe("Entity offload — immutables", () => {
  const origin = { source: "import", tags: ["a"] }

  it.effect("a restated equal value passes by checksum and is left out of the write", () =>
    withStore(
      Effect.gen(function* () {
        const db = yield* client
        yield* db.entities.Docs.put({ docId: "d-1", title: "t", origin: originOf(100) })
        const before = live("Doc", "d-1").origin
        expect(isPointer(before)).toBe(true)
        yield* db.entities.Docs.update({ docId: "d-1" }).set({ title: "t2", origin: originOf(100) })
        expect(namesOf(lastOf("UpdateItem"))).not.toContain("origin")
        expect(live("Doc", "d-1").origin).toEqual(before)
        expect(calls().put).toBe(1)
        // The pointer's checksum decided: the stored value was not fetched.
        expect(calls().get).toBe(1) // the result's read of the kept value
      }),
    ),
  )

  it.effect("a different value is confirmed by a fetch and refused, uploading nothing", () =>
    withStore(
      Effect.gen(function* () {
        const db = yield* client
        yield* db.entities.Docs.put({ docId: "d-1", title: "t", origin: originOf(100) })
        sent.length = 0
        const error = yield* Effect.flip(
          db.entities.Docs.update({ docId: "d-1" })
            .set({ origin: originOf(100, "z") })
            .asEffect(),
        )
        expect(error).toBeInstanceOf(ValidationError)
        expect(String((error as ValidationError).cause)).toMatch(/"origin" is immutable/)
        expect(calls().get).toBe(1)
        expect(calls().put).toBe(1)
        expect(commands()).not.toContain("UpdateItem")
      }),
    ),
  )

  it.effect("the same entries in another key order pass the structural confirm", () =>
    withStore(
      Effect.gen(function* () {
        const db = yield* client
        yield* db.entities.Docs.put({ docId: "d-1", title: "t" })
        // An older writer stored the same value with its keys in another order.
        const content = new TextEncoder().encode('{"tags":["a"],"source":"import"}')
        const checksum = { algorithm: "crc64nvme" as const, value: crc64nvme(content) }
        const row = live("Doc", "d-1")
        const { ref } = yield* blobs.put({
          key: "legacy/origin",
          body: content,
          contentLength: content.length,
          checksum: Effect.succeed(checksum),
          contentType: "application/json",
          metadata: {},
        })
        const pointer = BlobPointer.make({
          kind: "json",
          codec: "none",
          ref,
          objectSize: content.length,
          contentSize: content.length,
          checksum,
          contentType: Option.none(),
        }) as BlobPointer.BlobPointer
        rows.set(keyOf("main", row), { ...row, origin: { B: BlobPointer.encode(pointer) } })
        yield* db.entities.Docs.update({ docId: "d-1" }).set({ title: "t2", origin })
        expect(namesOf(lastOf("UpdateItem"))).not.toContain("origin")
        expect(live("Doc", "d-1").origin?.B).toEqual(BlobPointer.encode(pointer))
      }),
    ),
  )

  it.effect("a crafted checksum match passes the fast path, but the value is never written", () =>
    withStore(
      Effect.gen(function* () {
        const db = yield* client
        yield* db.entities.Docs.put({ docId: "d-1", title: "t" })
        const restated = new TextEncoder().encode(JSON.stringify(origin))
        // A pointer claiming the restated content's checksum and size, naming other bytes.
        const pointer = BlobPointer.make({
          kind: "json",
          codec: "none",
          ref: { key: "elsewhere/origin", version: "v1" },
          objectSize: restated.length,
          contentSize: restated.length,
          checksum: { algorithm: "crc64nvme", value: crc64nvme(restated) },
          contentType: Option.none(),
        }) as BlobPointer.BlobPointer
        const row = live("Doc", "d-1")
        rows.set(keyOf("main", row), { ...row, origin: { B: BlobPointer.encode(pointer) } })
        sent.length = 0
        const exit = yield* Effect.exit(
          db.entities.Docs.update({ docId: "d-1" }).set({ title: "t2", origin }).asEffect(),
        )
        // The restated value was dropped: the stored attribute is unchanged.
        expect(namesOf(lastOf("UpdateItem"))).not.toContain("origin")
        expect(live("Doc", "d-1").title?.S).toBe("t2")
        // Only the result's read of the stored pointer finds nothing behind it.
        const error = failureOf(exit)
        expect(error).toBeInstanceOf(BlobStoreError)
        expect((error as BlobStoreError).committed).toBe(true)
        expect(live("Doc", "d-1").origin?.B).toEqual(BlobPointer.encode(pointer))
        expect(calls().put).toBe(0)
      }),
    ),
  )

  it.effect("a binary immutable compares by checksum and size, never fetching", () =>
    withStore(
      Effect.gen(function* () {
        const db = yield* client
        yield* db.entities.Scans.put({ scanId: "s-1", label: "a", image: pdfBytes(20) })
        yield* db.entities.Scans.update({ scanId: "s-1" }).set({ label: "b", image: pdfBytes(20) })
        expect(namesOf(lastOf("UpdateItem"))).not.toContain("image")
        const error = yield* Effect.flip(
          db.entities.Scans.update({ scanId: "s-1" })
            .set({ image: pdfBytes(20, 9) })
            .asEffect(),
        )
        expect(error).toBeInstanceOf(ValidationError)
        expect(String((error as ValidationError).cause)).toMatch(/"image" is immutable/)
        // The first update's result holds a lazy handle on the kept image
        // (binary is lazy by default); the refusal fetched nothing.
        expect(calls().get).toBe(0)
        expect(calls().put).toBe(1)
      }),
    ),
  )
})

// ---------------------------------------------------------------------------
// Time-series append
// ---------------------------------------------------------------------------

describe("Entity offload — time-series append", () => {
  it.effect("one upload, keyed by the event item, its pointer on both items", () =>
    withStore(
      Effect.gen(function* () {
        const db = yield* client
        const raw = pdfBytes(40)
        const { current } = yield* db.entities.Readings.append({
          sensorId: "s-1",
          at: 1,
          value: 10,
          raw,
        }).offloaded("eager")
        expect(current.raw).toEqual(raw)
        expect(calls().put).toBe(1)
        expect(calls().get).toBe(0)
        const head = live("Reading", "s-1", "sensorId")
        const [event] = rowsWhere("Reading", /#e#/)
        expect(event!.raw).toEqual(head.raw)
        expect(binaryPointer(head.raw).ref.key).toBe(
          objectKey("", {
            table: "main",
            pk: head.pk as { S: string },
            familySk: head.sk as { S: string },
            rowSk: event!.sk as { S: string },
            attribute: "raw",
          }),
        )
      }),
    ),
  )

  it.effect("a stale append's upload is deleted", () =>
    withStore(
      Effect.gen(function* () {
        const db = yield* client
        yield* db.entities.Readings.append({ sensorId: "s-1", at: 5, value: 1, raw: pdfBytes(4) })
        const error = yield* Effect.flip(
          db.entities.Readings.append({
            sensorId: "s-1",
            at: 2,
            value: 2,
            raw: pdfBytes(4, 1),
          }).asEffect(),
        )
        expect(error._tag).toBe("StaleAppend")
        expect(calls().put).toBe(2)
        expect(calls().delete).toBe(1)
        expect(versions()).toHaveLength(1)
      }),
    ),
  )

  it.effect("an append rejected for item size is not retried", () =>
    withStore(
      Effect.gen(function* () {
        const db = yield* client
        refuseNext.set("TransactWriteItems", DDB_ITEM_SIZE_UPDATE)
        const error = yield* Effect.flip(
          db.entities.Readings.append({
            sensorId: "s-1",
            at: 1,
            value: 1,
            label: "x".repeat(3_000),
          }).asEffect(),
        )
        expect(error).toBeInstanceOf(ValidationError)
        expect(commands()).toEqual(["TransactWriteItems"])
      }),
    ),
  )
})

// ---------------------------------------------------------------------------
// Lifecycle copies
// ---------------------------------------------------------------------------

describe("Entity offload — lifecycle copies", () => {
  it.effect("snapshots, tombstones and restore copy pointers without uploading", () =>
    withStore(
      Effect.gen(function* () {
        const db = yield* client
        yield* db.entities.Kept.put({
          docId: "k-1",
          title: "v1",
          body: text(100),
          scan: pdfBytes(5),
        })
        const original = live("Kept", "k-1")
        yield* db.entities.Kept.update({ docId: "k-1" }).set({ title: "v2" })
        yield* db.entities.Kept.delete({ docId: "k-1" })
        const [tombstone] = rowsWhere("Kept", /#deleted#/)
        expect(tombstone!.body).toEqual(original.body)
        expect(tombstone!.scan).toEqual(original.scan)
        for (const snapshot of rowsWhere("Kept", /#v#/)) {
          expect(snapshot.body).toEqual(original.body)
          expect(snapshot.scan).toEqual(original.scan)
        }
        const restored = yield* db.entities.Kept.restore({ docId: "k-1" })
        expect(live("Kept", "k-1").body).toEqual(original.body)
        expect(restored.body).toEqual(text(100))
        // Binary is lazy by default: a handle on the copied object.
        expect(Offload.isBlobHandle(restored.scan)).toBe(true)
        // One upload per field, ever. The update's and the restore's results
        // fetched the overflow body (neither uploaded it), not the scan.
        expect(calls().put).toBe(2)
        expect(calls().get).toBe(2)
        expect(yield* restored.scan!.read()).toEqual(pdfBytes(5))
        expect(calls().get).toBe(3)
      }),
    ),
  )
})

// ---------------------------------------------------------------------------
// External fields in expressions and update ops (EDD-9076 / EDD-9077)
// ---------------------------------------------------------------------------

describe("Entity offload — External fields are opaque to expressions", () => {
  it.effect(
    "conditions and filters take only exists / notExists; projections the whole field",
    () =>
      withStore(
        Effect.gen(function* () {
          const db = yield* client
          yield* db.entities.Docs.put({ docId: "d-1", title: "t", scan: pdfBytes(2) })
          yield* db.entities.Docs.update({ docId: "d-1" })
            .set({ title: "t2" })
            .condition((t, { exists }) => exists(t.scan))
          expect(() =>
            db.entities.Docs.update({ docId: "d-1" }).condition({ scan: pdfBytes(2) }),
          ).toThrow(
            /\[EDD-9076\] Entity "Doc".*"scan".*stored External \(content type "application\/pdf"/,
          )
          expect(() =>
            db.entities.Docs.put({ docId: "d-1", title: "t" }).condition((t, { eq }) =>
              // @ts-expect-error — an External field's path is not a comparable Path
              eq(t.scan, pdfBytes(2)),
            ),
          ).toThrow(/\[EDD-9076\]/)
          expect(() => Docs.condition({ scan: pdfBytes(1) })).toThrow(/stored External/)
          expect(() => db.entities.Docs.scan().filter({ scan: pdfBytes(1) })).toThrow(
            /\[EDD-9076\].*filterBy/,
          )
          expect(() => db.entities.Docs.scan().select(["scan.x"])).toThrow(/\[EDD-9076\]/)
        }),
      ),
  )

  it.effect("update ops other than set / remove are refused on an External field", () =>
    withStore(
      Effect.gen(function* () {
        const db = yield* client
        const error = yield* Effect.flip(
          db.entities.Docs.update({ docId: "d-1" })
            .append({ scan: [1] } as never)
            .asEffect(),
        )
        expect(error).toBeInstanceOf(ValidationError)
        expect(String((error as ValidationError).cause)).toMatch(
          /\[EDD-9077\] Entity "Doc": \.append\(\) on "scan", but "scan" is stored External/,
        )
        expect(commands()).toEqual([])
      }),
    ),
  )

  it.effect("a path copy FROM an offloaded field is refused, nothing uploaded or sent", () =>
    withStore(
      Effect.gen(function* () {
        const db = yield* client
        for (const [source, pattern] of [
          [
            "body",
            /\[EDD-9077\] Entity "Doc": pathSet copies from "body", but "body" is stored packed/,
          ],
          [
            "scan",
            /\[EDD-9077\] Entity "Doc": pathSet copies from "scan", but "scan" is stored External/,
          ],
        ] as const) {
          const error = yield* Effect.flip(
            db.entities.Docs.update({ docId: "d-1" })
              .pathSet({
                segments: ["title"],
                value: undefined,
                isPath: true,
                valueSegments: [source],
              })
              .asEffect(),
          )
          expect(error).toBeInstanceOf(ValidationError)
          expect(String((error as ValidationError).cause)).toMatch(pattern)
        }
        // pathSubtract's copy form (type-free: the source is not a number)
        const subtract = yield* Effect.flip(
          db.entities.Docs.update({ docId: "d-1" })
            .pathSubtract({
              segments: ["title"],
              value: undefined,
              isPath: true,
              valueSegments: ["notes"],
            } as never)
            .asEffect(),
        )
        expect(String((subtract as ValidationError).cause)).toMatch(
          /\[EDD-9077\] Entity "Doc": pathSubtract copies from "notes"/,
        )
        expect(commands()).toEqual([])
        expect(calls().put).toBe(0)
      }),
    ),
  )
})

// ---------------------------------------------------------------------------
// Failure paths
// ---------------------------------------------------------------------------

describe("Entity offload — failure paths", () => {
  it.effect("a store put failure sends nothing and rolls the other uploads back", () => {
    blobs = BlobStore.memory({
      failures: (call) =>
        call.action === "put" && call.n === 2 ? { _tag: "Fail", reason: "Rejected" } : undefined,
    })
    return withStore(
      Effect.gen(function* () {
        const db = yield* client
        const error = yield* Effect.flip(
          db.entities.Docs.put({
            docId: "d-1",
            title: "t",
            body: text(100),
            notes: text(100),
            scan: pdfBytes(3),
          }).asEffect(),
        )
        expect(error).toBeInstanceOf(BlobStoreError)
        expect((error as BlobStoreError).reason).toBe("Rejected")
        expect((error as BlobStoreError).committed).toBe(false)
        expect(commands()).toEqual([])
        expect(calls().put).toBe(3)
        // The two that succeeded, deleted in one call.
        expect(calls().delete).toBe(1)
        expect(versions()).toEqual([])
      }),
    )
  })

  it.live("a failed upload lets the others in flight finish, then rolls them back", () => {
    const memory = BlobStore.memory()
    const notesStored = Deferred.makeUnsafe<void>()
    const store: BlobStoreService = {
      ...memory,
      put: (request) =>
        request.metadata["edd-attr"] === "n"
          ? memory.put(request).pipe(
              // It took effect; its answer is still on its way.
              Effect.tap(() => Deferred.succeed(notesStored, undefined)),
              Effect.tap(() => Effect.sleep("50 millis")),
            )
          : Effect.andThen(
              Deferred.await(notesStored),
              Effect.fail(new BlobStoreFailure({ reason: "Rejected", cause: "refused" })),
            ),
    }
    const reports: Array<Offload.UnsettledUpload> = []
    return withService(
      store,
      reports,
      Effect.gen(function* () {
        const db = yield* client
        const error = yield* Effect.flip(
          db.entities.Docs.put({
            docId: "d-1",
            title: "t",
            body: text(100),
            notes: text(100),
          }).asEffect(),
        )
        expect(error).toBeInstanceOf(BlobStoreError)
        expect((error as BlobStoreError).attribute).toBe("body")
        expect(commands()).toEqual([])
        // Not interrupted by its sibling's failure: answered, registered, deleted.
        expect(memory.inspect().calls.put).toBe(1)
        expect(memory.inspect().calls.delete).toBe(1)
        expect(memory.inspect().versions).toEqual([])
        expect(reports).toEqual([])
      }),
    )
  })

  it.effect("delete allOld: a failed read of the removed item's pointer says it committed", () => {
    let failGets = false
    blobs = BlobStore.memory({
      failures: (call) =>
        failGets && call.action === "get" ? { _tag: "Fail", reason: "Unavailable" } : undefined,
    })
    return withStore(
      Effect.gen(function* () {
        const db = yield* client
        yield* db.entities.Docs.put({ docId: "d-1", title: "t", body: text(100) })
        failGets = true
        const error = yield* Effect.flip(
          db.entities.Docs.delete({ docId: "d-1" }).returnValues("allOld").asEffect(),
        )
        // Not `DeleteAppliedButUnreadable`: the store's own error, committed.
        expect(error).toBeInstanceOf(BlobStoreError)
        expect((error as BlobStoreError).reason).toBe("Unavailable")
        expect((error as BlobStoreError).action).toBe("get")
        expect((error as BlobStoreError).committed).toBe(true)
        expect([...rows.values()].filter((item) => item.__edd_e__?.S === "Doc")).toEqual([])
        // No inline freeing: the removed item's version is the reaper's.
        expect(versions()).toHaveLength(1)
      }),
    )
  })

  describe("an upload older than maxUploadAge when its write is sent fails Expired", () => {
    /** Each put takes two hours (the default maxUploadAge is one), once armed. */
    let slow = false
    const slowStore = () =>
      BlobStore.memory({
        failures: (call) =>
          slow && call.action === "put"
            ? Effect.as(TestClock.adjust("2 hours"), undefined)
            : undefined,
      })
    const expectExpired = (error: unknown) => {
      expect(error).toBeInstanceOf(BlobStoreError)
      expect((error as BlobStoreError).reason).toBe("Expired")
      expect((error as BlobStoreError).committed).toBe(false)
      // Refused at the choke point: nothing written, the upload deleted.
      expect(commands().filter((c) => c !== "GetItem")).toEqual([])
      expect(versions()).toEqual([])
    }
    beforeEach(() => {
      slow = false
    })

    it.effect("put", () => {
      blobs = slowStore()
      return withStore(
        Effect.gen(function* () {
          const db = yield* client
          slow = true
          expectExpired(
            yield* Effect.flip(
              db.entities.Docs.put({ docId: "d-1", title: "t", body: text(100) }).asEffect(),
            ),
          )
        }),
      )
    })

    it.effect("update", () => {
      blobs = slowStore()
      return withStore(
        Effect.gen(function* () {
          const db = yield* client
          yield* db.entities.Docs.put({ docId: "d-1", title: "t" })
          sent.length = 0
          slow = true
          expectExpired(
            yield* Effect.flip(
              db.entities.Docs.update({ docId: "d-1" })
                .set({ body: text(100) })
                .asEffect(),
            ),
          )
          expect(live("Doc", "d-1").body).toBeUndefined()
        }),
      )
    })

    it.effect("upsert", () => {
      blobs = slowStore()
      return withStore(
        Effect.gen(function* () {
          const db = yield* client
          slow = true
          expectExpired(
            yield* Effect.flip(
              db.entities.Docs.upsert({ docId: "d-1", title: "t", body: text(100) }).asEffect(),
            ),
          )
        }),
      )
    })

    it.effect("append", () => {
      blobs = slowStore()
      return withStore(
        Effect.gen(function* () {
          const db = yield* client
          slow = true
          expectExpired(
            yield* Effect.flip(
              db.entities.Readings.append({
                sensorId: "s-1",
                at: 1,
                value: 1,
                raw: pdfBytes(4),
              }).asEffect(),
            ),
          )
        }),
      )
    })
  })

  describe("a write that must upload with no store fails with NotProvided, sending nothing", () => {
    const expectNotProvided = (error: unknown, attribute: string) => {
      expect(error).toBeInstanceOf(BlobStoreError)
      expect((error as BlobStoreError).reason).toBe("NotProvided")
      expect((error as BlobStoreError).attribute).toBe(attribute)
      expect(commands()).toEqual([])
    }

    it.effect("update", () =>
      withoutStore(
        Effect.gen(function* () {
          expectNotProvided(
            yield* Effect.flip(
              Docs.update({ docId: "d-1" })
                .pipe(Entity.set({ body: text(100) }))
                .asEffect(),
            ),
            "body",
          )
        }),
      ),
    )

    it.effect("upsert", () =>
      withoutStore(
        Effect.gen(function* () {
          expectNotProvided(
            yield* Effect.flip(
              Docs.upsert({ docId: "d-1", title: "t", scan: pdfBytes(2) }).asEffect(),
            ),
            "scan",
          )
        }),
      ),
    )

    it.effect("append", () =>
      withoutStore(
        Effect.gen(function* () {
          expectNotProvided(
            yield* Effect.flip(
              Readings.append({ sensorId: "s-1", at: 1, value: 1, raw: pdfBytes(4) }),
            ),
            "raw",
          )
        }),
      ),
    )
  })

  it.effect("a stale append's current decodes without store I/O, a pointer as a lazy handle", () =>
    withStore(
      Effect.gen(function* () {
        const db = yield* client
        yield* db.entities.Readings.append({ sensorId: "s-1", at: 5, value: 1 })
        const stale = () =>
          Effect.flip(
            db.entities.Readings.append({
              sensorId: "s-1",
              at: 2,
              value: 2,
              raw: pdfBytes(4),
            }).asEffect(),
          )
        // No pointer: decoded, as for an entity that offloads nothing.
        const first = yield* stale()
        expect(first._tag).toBe("StaleAppend")
        expect(
          Option.getOrUndefined((first as { readonly current: Option.Option<any> }).current),
        ).toMatchObject({ sensorId: "s-1", at: 5, value: 1 })
        // A corrupt item is a ValidationError, not a StaleAppend with none.
        const head = live("Reading", "s-1", "sensorId")
        rows.set(keyOf("main", head), { ...head, value: { S: "not a number" } })
        expect(yield* stale()).toBeInstanceOf(ValidationError)
        // A pointer: a lazy handle, fetched only when read (§6.13) — even
        // when the append asked for eager results.
        yield* db.entities.Readings.append({ sensorId: "s-2", at: 5, value: 1, raw: pdfBytes(4) })
        const gets = calls().get
        const pointed = yield* Effect.flip(
          db.entities.Readings.append({ sensorId: "s-2", at: 2, value: 2 })
            .offloaded("eager")
            .asEffect(),
        )
        expect(pointed._tag).toBe("StaleAppend")
        const current = Option.getOrThrow(
          (pointed as { readonly current: Option.Option<{ readonly raw: unknown }> }).current,
        )
        expect(Offload.isBlobHandle(current.raw)).toBe(true)
        expect(calls().get).toBe(gets)
        expect(yield* (current.raw as Offload.BlobHandle).read()).toEqual(pdfBytes(4))
        expect(calls().get).toBe(gets + 1)
      }),
    ),
  )

  it.effect(
    "a refused condition's current decodes without store I/O, a pointer as a lazy handle",
    () =>
      withStore(
        Effect.gen(function* () {
          const db = yield* client
          yield* db.entities.Readings.append({ sensorId: "s-1", at: 5, value: 1, raw: pdfBytes(4) })
          const gets = calls().get
          // Not stale (6 > 5): the caller's condition refused it.
          const refused = yield* Effect.flip(
            db.entities.Readings.append({ sensorId: "s-1", at: 6, value: 2 })
              .condition({ eq: { value: 99 } })
              .offloaded("eager")
              .asEffect(),
          )
          expect(refused._tag).toBe("ConditionalCheckFailed")
          const current = Option.getOrThrow(
            (refused as { readonly current: Option.Option<{ readonly raw: unknown }> }).current,
          )
          expect(Offload.isBlobHandle(current.raw)).toBe(true)
          expect(calls().get).toBe(gets)
          expect(yield* (current.raw as Offload.BlobHandle).read()).toEqual(pdfBytes(4))
        }),
      ),
  )

  it.effect(
    "a stale append whose current holds a pointer the member no longer offloads fails",
    () =>
      withStore(
        Effect.gen(function* () {
          const db = yield* client
          yield* db.entities.Readings.append({ sensorId: "s-1", at: 5, value: 1, raw: pdfBytes(4) })
          const gets = calls().get
          const failed = yield* Effect.flip(
            LegacyReadings.append({ sensorId: "s-1", at: 2, value: 2 }).pipe(
              Effect.provide(LegacyTable.layer({ name: "main" })),
            ),
          )
          // Resolving it needs a fetch, which an error payload never makes.
          expect(failed).toBeInstanceOf(ValidationError)
          expect(String((failed as ValidationError).cause)).toContain('Attribute "raw"')
          expect(String((failed as ValidationError).cause)).toContain("without store I/O")
          expect(calls().get).toBe(gets)
        }),
      ),
  )
})

// ---------------------------------------------------------------------------
// Bind-time checks (EDD-9115, EDD-9078)
// ---------------------------------------------------------------------------

describe("Entity offload — bind-time checks", () => {
  it.effect("DynamoClient.make with an offloading member and no store dies with EDD-9115", () =>
    withoutStore(
      Effect.gen(function* () {
        const message = defectOf(
          yield* Effect.exit(DynamoClient.make({ entities: { Docs }, tables: { MainTable } })),
        )
        expect(message).toContain('[EDD-9115] DynamoClient.make: entity "Docs" offloads')
        expect(message).toContain('"body"')
        expect(message).toContain('"scan"')
        // An aggregate's offloading edge is checked too.
        const edge = defectOf(
          yield* Effect.exit(
            DynamoClient.make({ entities: {}, aggregates: { Matches }, tables: { MainTable } }),
          ),
        )
        expect(edge).toContain('aggregate "Matches" (edge "MatchVenue") offloads "plan"')
        // An explicit store satisfies it.
        yield* DynamoClient.make({
          entities: { Docs },
          tables: { MainTable },
          blobStore: BlobStore.memory(),
        })
      }),
    ),
  )

  it.effect("Entity.bind and Aggregate.bind check the store and the codecs", () =>
    withoutStore(
      Effect.gen(function* () {
        expect(defectOf(yield* Effect.exit(Entity.bind(Docs)))).toContain(
          '[EDD-9115] Entity.bind: entity "Doc" offloads',
        )
        expect(defectOf(yield* Effect.exit(Aggregate.bind(Matches)))).toContain(
          '[EDD-9115] Aggregate.bind: aggregate "MatchItem" (edge "MatchVenue") offloads "plan"',
        )
        expect(defectOf(yield* Effect.exit(Entity.bind(Gzipped)))).toContain(
          "[EDD-9078] Entity.bind",
        )
        expect(defectOf(yield* Effect.exit(Aggregate.bind(GzMatches)))).toContain(
          "[EDD-9078] Aggregate.bind",
        )
        // A member that offloads nothing binds without a store.
        yield* Entity.bind(
          Entity.make({ model: Doc, entityType: "PlainDoc", primaryKey: docKey }),
        ).pipe(Effect.provide(MainTable.layer({ name: "main" })))
      }),
    ),
  )
})

// ---------------------------------------------------------------------------
// Escaped key text (owner decision 2026-11-14, design §11.10)
// ---------------------------------------------------------------------------

describe("Entity offload — bind-time checks: escaped key text", () => {
  it.effect("every bind site dies with EDD-9146 before the store check", () =>
    withoutStore(
      Effect.gen(function* () {
        const made = defectOf(
          yield* Effect.exit(
            DynamoClient.make({ entities: { UnescapedDocs }, tables: { UnescapedTable } }),
          ),
        )
        // Not EDD-9115: no store is given, and the key text is checked first.
        expect(made).toContain('[EDD-9146] DynamoClient.make: entity "UnescapedDocs" offloads')
        expect(made).toContain('"body"')
        expect(made).toContain("escapeKeys: true")
        // A store doesn't make the key text right.
        expect(
          defectOf(
            yield* Effect.exit(
              DynamoClient.make({
                entities: { UnescapedDocs },
                tables: { UnescapedTable },
                blobStore: BlobStore.memory(),
              }),
            ),
          ),
        ).toContain("[EDD-9146] DynamoClient.make")
        expect(
          defectOf(
            yield* Effect.exit(
              DynamoClient.make({
                entities: {},
                aggregates: { UnescapedMatches },
                tables: { UnescapedTable },
              }),
            ),
          ),
        ).toContain(
          '[EDD-9146] DynamoClient.make: aggregate "UnescapedMatches" (edge "MatchVenue")',
        )
        expect(defectOf(yield* Effect.exit(Entity.bind(UnescapedDocs)))).toContain(
          '[EDD-9146] Entity.bind: entity "Doc" offloads',
        )
        expect(defectOf(yield* Effect.exit(Aggregate.bind(UnescapedMatches)))).toContain(
          '[EDD-9146] Aggregate.bind: aggregate "MatchItem" (edge "MatchVenue") offloads "plan"',
        )
      }),
    ),
  )

  it.effect("an unbound write is refused where it routes: nothing uploaded or sent", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        UnescapedDocs.put({ docId: "d-1", title: "t", body: text(100) }).asEffect(),
      )
      expect(error).toBeInstanceOf(ValidationError)
      expect(String((error as ValidationError).cause)).toContain(
        '[EDD-9146] Entity.put: Doc offloads "body"',
      )
      expect(calls().put).toBe(0)
      expect(commands()).toEqual([])
    }).pipe(
      Effect.provide(
        Layer.mergeAll(SpyClient, UnescapedTable.layer({ name: "main" }), BlobStore.layer(blobs)),
      ),
    ),
  )
})

describe("Entity offload — rekey never moves a pointer row", () => {
  /** Write with the offloading members (escaped key text) on a recording table. */
  const written = <A, E>(
    table: ReturnType<typeof makeRecordingTable>,
    write: (db: Effect.Success<typeof client>) => Effect.Effect<A, E>,
  ) =>
    Effect.flatMap(client, write).pipe(
      Effect.provide(Layer.mergeAll(table.layer, tableLayer, BlobStore.layer(blobs))),
    )
  const rekeyedEscaped = (table: ReturnType<typeof makeRecordingTable>) =>
    Effect.flatMap(
      DynamoClient.make({ entities: { Docs, Kept, Readings }, tables: { MainTable } }),
      (db) => db.tables.MainTable.rekey(),
    ).pipe(Effect.provide(Layer.mergeAll(table.layer, tableLayer, BlobStore.layer(blobs))))
  /** `escapeKeys` turned off, the offloaded declarations removed. */
  const rekeyedPlain = (table: ReturnType<typeof makeRecordingTable>, dryRun: boolean) =>
    Effect.flatMap(
      DynamoClient.make({
        entities: { PlainDocs, PlainKept, PlainReadings },
        tables: { PlainTable },
      }),
      (db) => db.tables.PlainTable.rekey({ dryRun }),
    ).pipe(Effect.provide(Layer.mergeAll(table.layer, PlainTable.layer({ name: "main" }))))
  /** Keep only the rows `keep` names. */
  const only = (table: ReturnType<typeof makeRecordingTable>, keep: (row: Item) => boolean) => {
    for (const [text, row] of [...table.items]) if (!keep(row)) table.items.delete(text)
  }
  const kinds: ReadonlyArray<{
    readonly kind: string
    readonly write: (db: Effect.Success<typeof client>) => Effect.Effect<unknown, unknown>
    readonly keep: (row: Item) => boolean
  }> = [
    {
      kind: "a live item",
      write: (db) => db.entities.Docs.put({ docId: "d 1", title: "t", body: text(100) }).asEffect(),
      keep: (row) => row.__edd_e__?.S === "Doc",
    },
    {
      kind: "a snapshot",
      write: (db) => db.entities.Kept.put({ docId: "d 1", title: "t", body: text(100) }).asEffect(),
      keep: (row) => row.__edd_e__?.S === "Kept" && /#v#/.test(row.sk!.S!),
    },
    {
      kind: "a tombstone",
      write: (db) =>
        Effect.andThen(
          db.entities.Kept.put({ docId: "d 1", title: "t", body: text(100) }).asEffect(),
          db.entities.Kept.delete({ docId: "d 1" }).asEffect(),
        ),
      keep: (row) => row.__edd_e__?.S === "Kept" && /#deleted#/.test(row.sk!.S!),
    },
    {
      kind: "an event item",
      write: (db) =>
        db.entities.Readings.append({
          sensorId: "s 1",
          at: 1,
          value: 1,
          raw: pdfBytes(8),
        }).asEffect(),
      keep: (row) => row.__edd_e__?.S === "Reading" && /#e#/.test(row.sk!.S!),
    },
  ]

  it.effect("under escaped key text, rekey moves nothing", () =>
    Effect.gen(function* () {
      const table = makeRecordingTable()
      for (const { write } of kinds) yield* written(table, write)
      const before = new Map(table.items)
      const report = yield* rekeyedEscaped(table)
      expect(report.conflicts).toEqual([])
      expect(Object.values(report.moved).every((n) => n === 0)).toBe(true)
      expect(new Map(table.items)).toEqual(before)
    }),
  )

  for (const { kind, write, keep } of kinds) {
    for (const dryRun of [true, false]) {
      it.effect(
        `with escapeKeys turned off, ${kind} holding a pointer is refused${dryRun ? " (dry run)" : ""}`,
        () =>
          Effect.gen(function* () {
            const table = makeRecordingTable()
            yield* written(table, write)
            only(table, keep)
            const held = [...table.items.values()]
            expect(held).toHaveLength(1)
            table.take()
            const error = yield* Effect.flip(rekeyedPlain(table, dryRun))
            expect(error).toBeInstanceOf(ValidationError)
            const cause = String((error as ValidationError).cause)
            expect(cause).toContain("[EDD-9146]")
            expect(cause).toContain("holds a blob pointer")
            // The row's key, as stored (escaped).
            expect(cause).toContain(JSON.stringify(held[0]!.pk!.S!).slice(1, -1))
            // Nothing written: the row is where it was, as it was.
            expect([...table.items.values()]).toEqual(held)
            const writes = table
              .take()
              .filter((r) => !["GetItem", "Query", "Scan", "BatchGetItem"].includes(r.command))
            expect(writes).toEqual([])
          }),
      )
    }
  }
})

// ---------------------------------------------------------------------------
// PartiQL insert (owner decision 2026-11-14, design §6.2)
// ---------------------------------------------------------------------------

describe("Entity offload — insert()", () => {
  it.effect("routes and uploads as put does, and decodes the written values", () =>
    withStore(
      Effect.gen(function* () {
        const db = yield* client
        const body = text(100)
        const scan = pdfBytes(20)
        const doc = yield* db.entities.Docs.insert({
          docId: "d-1",
          title: "t",
          body,
          scan,
        }).offloaded("eager")
        expect(doc.body).toEqual(body)
        expect(doc.scan).toEqual(scan)
        expect(calls().put).toBe(2)
        // The written values: from the ledger's read cache, not fetched.
        expect(calls().get).toBe(0)
        expect(commands()).toEqual(["ExecuteStatement"])
        const row = live("Doc", "d-1")
        overflowPointer(row.body)
        binaryPointer(row.scan)
        expect(versions()).toHaveLength(2)
      }),
    ),
  )

  it.effect("reads its result in the default modes: overflow eager, binary a lazy handle", () =>
    withStore(
      Effect.gen(function* () {
        const db = yield* client
        const body = text(100)
        const scan = pdfBytes(20)
        const doc = yield* db.entities.Docs.insert({ docId: "d-1", title: "t", body, scan })
        expect(doc.body).toEqual(body)
        expect(Offload.isBlobHandle(doc.scan)).toBe(true)
        // Nothing fetched: the overflow value comes from the ledger's read cache.
        expect(calls().get).toBe(0)
      }),
    ),
  )

  it.effect("a duplicate item (sent once) rolls the uploads back", () =>
    withStore(
      Effect.gen(function* () {
        const db = yield* client
        yield* db.entities.Docs.put({ docId: "d-1", title: "t" })
        const error = yield* Effect.flip(
          db.entities.Docs.insert({ docId: "d-1", title: "t", body: text(100) }).asEffect(),
        )
        expect(error._tag).toBe("ItemAlreadyExists")
        expect(calls().put).toBe(1)
        expect(calls().delete).toBe(1)
        expect(versions()).toEqual([])
      }),
    ),
  )

  it.effect(
    "an INSERT-only transaction carries the library's token; a cancelled one rolls back",
    () =>
      withStore(
        Effect.gen(function* () {
          const db = yield* client
          yield* db.entities.Wides.insert({
            id: "w-1",
            email: "a@x",
            totals: { a: 1 },
            body: text(100),
          })
          const first = lastOf("ExecuteTransaction")
          expect(typeof first.ClientRequestToken).toBe("string")
          expect(versions()).toHaveLength(1)
          const error = yield* Effect.flip(
            db.entities.Wides.insert({
              id: "w-2",
              email: "a@x",
              totals: { a: 1 },
              body: text(100),
            }).asEffect(),
          )
          expect(error._tag).toBe("UniqueConstraintViolation")
          expect(lastOf("ExecuteTransaction").ClientRequestToken).not.toBe(first.ClientRequestToken)
          expect(calls().put).toBe(2)
          expect(calls().delete).toBe(1)
          expect(versions()).toHaveLength(1)
        }),
      ),
  )

  it.effect("a duplicate after a resend is in doubt: kept and reported", () => {
    const reports: Array<Offload.UnsettledUpload> = []
    const store = BlobStore.memory()
    return withService(
      store,
      reports,
      Effect.gen(function* () {
        const db = yield* client
        yield* db.entities.Docs.put({ docId: "d-1", title: "t" })
        // The SDK sent the statement twice: the first attempt may have written the item.
        refusalAttempts = 2
        const error = yield* Effect.flip(
          db.entities.Docs.insert({ docId: "d-1", title: "t", body: text(100) }).asEffect(),
        )
        expect(error._tag).toBe("ItemAlreadyExists")
        expect(store.inspect().calls.delete).toBe(0)
        expect(store.inspect().versions).toHaveLength(1)
        expect(reports.map((r) => [r.reason, r.operation, r.attribute])).toEqual([
          ["inDoubt", "Entity.insert", "body"],
        ])
      }),
    )
  })
})
