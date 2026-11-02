/**
 * Offloaded storage end to end (#179, design §19.4): DynamoDB Local beside a
 * real S3 API (MinIO in CI), through the S3 store (`effect-dynamodb/blob/s3`)
 * over a versioned bucket.
 *
 * - **Entities.** An overflow field (zstd: under its threshold inline, over
 *   it a `B` pointer) and a binary field (`S` "~edbp:" text; a `Uint8Array`
 *   and a 12 MB `Stream` uploaded in two parts); put, get (eager and lazy), a
 *   query whose `select` omits both (no GET, counted by a store wrapper),
 *   `update().set()`, a create over an existing item (its upload deleted,
 *   the previous version still read); `transactWrite` cancellation,
 *   `Batch.write`, a stale time-series append; retain, softDelete and
 *   restore; a handle read before an update presigning a GET of the version
 *   it read.
 * - **Aggregates and EventStore.** An aggregate's offloaded edge field (the
 *   changed group re-uploaded, the superseded version swept by partition); a
 *   stream with offloaded event `data` and an offloaded inline snapshot, read
 *   through `read`, `readLatest`, `readIndex` and raw rows, its superseded
 *   snapshot state reaped.
 * - **Stream records.** `Entity.decodeStreamRecord` and `gc.reap` over
 *   records built from items fetched with the raw client and rewritten into
 *   Lambda's DynamoDB-JSON shape (`B` as base64, the table's stream ARN).
 * - **GC.** The reaper's confirm-read and `gc.sweep` on an entity with
 *   sort-key composites and prefix-colliding sibling items keep every version
 *   the item's snapshots and tombstones hold and free none of a sibling's;
 *   two tables sharing the bucket (the second holding copies of the first's
 *   rows) never delete each other's versions, through either table's reaper,
 *   sweeps or purge; a crashed rollback reported to the observer and swept in
 *   two passes, its mark a MinIO version tag; `gc.sweepStore` over the
 *   bucket; purge emptying the item's family prefix while a create racing it
 *   keeps its version.
 * - **Key text (design §11.10).** Offloading requires `escapeKeys: true`:
 *   `DynamoClient.make` dies with `[EDD-9146]` for an offloading member on a
 *   table without it, and an unbound write there is refused where it routes,
 *   nothing uploaded or written. `rekey` over the escaped table moves nothing;
 *   with `escapeKeys` turned off over rows offloading wrote (a numeric key
 *   composite, whose text the setting changes), it refuses the pointer row by
 *   its key, a dry run included, leaving the row and its version as they were.
 * - **`insert()`.** A PartiQL `INSERT` uploads as `put` does and reads its
 *   values back; a duplicate item's upload is deleted; a unique-constrained
 *   insert (`ExecuteTransaction`) whose sentinel is taken rolls its upload
 *   back, the first insert's version kept.
 *
 * Each test writes under its own store prefix. A failed write's upload is
 * shown landing (the store wrapper counts its PUT) and then deleted, and
 * every version a test shows deleted leaves no delete marker.
 *
 * Time: the GC tests set the `TestClock` to the wall clock (MinIO dates each
 * version with it) and move it on between passes.
 *
 * `DYNAMODB_ENDPOINT` (default `http://localhost:8000`), `S3_ENDPOINT`
 * (default `http://localhost:9000`) and the S3 credentials (`S3_ACCESS_KEY_ID`
 * / `S3_SECRET_ACCESS_KEY`, default MinIO's `minioadmin`) are read through
 * `Config`; the suite is skipped when either endpoint is unreachable. The
 * bucket is made by the test setup (with `PutBucketVersioning`), never by the
 * library. A geo entity's offloaded field through `nearby` is the geo
 * package's `connected.blob-offload.test.ts`.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  GetObjectTaggingCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  type ListObjectVersionsCommandOutput,
  PutBucketVersioningCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
import { it } from "@effect/vitest"
import { Compression } from "@effect-dynamodb/schema/Compression.js"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { composeCollectionKey } from "@effect-dynamodb/schema/DynamoSchema.js"
import { ValidationError } from "@effect-dynamodb/schema/Errors.js"
import type { BlobRef } from "@effect-dynamodb/schema/internal/BlobPointer.js"
import * as BlobPointer from "@effect-dynamodb/schema/internal/BlobPointer.js"
import { crc64nvme } from "@effect-dynamodb/schema/internal/Crc64Nvme.js"
import * as KeyComposer from "@effect-dynamodb/schema/KeyComposer.js"
import { Cause, Clock, Config, Effect, Exit, Layer, Option, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import { afterAll, beforeAll, describe, expect } from "vitest"
import * as Aggregate from "../src/Aggregate.js"
import * as Batch from "../src/Batch.js"
import * as BlobGc from "../src/BlobGc.js"
import { BlobStore, BlobStoreFailure, type BlobStoreService } from "../src/BlobStore.js"
import * as S3BlobStore from "../src/blob/s3.js"
import * as ZlibCompression from "../src/compression/zlib.js"
import { DynamoClient, type DynamoClientService } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
import { attributeValueEquals } from "../src/internal/AttributeValueEquals.js"
import { familyPrefix, partitionPrefix } from "../src/internal/BlobKeys.js"
import { pointerOf } from "../src/internal/GcSupport.js"
import * as Offload from "../src/Offload.js"
import * as Query from "../src/Query.js"
import * as Table from "../src/Table.js"
import * as Transaction from "../src/Transaction.js"

// ---------------------------------------------------------------------------
// Skip when DynamoDB Local or the S3 endpoint isn't reachable
// ---------------------------------------------------------------------------

const settings = Effect.runSync(
  Config.all({
    dynamodb: Config.String("DYNAMODB_ENDPOINT").pipe(Config.withDefault("http://localhost:8000")),
    s3: Config.String("S3_ENDPOINT").pipe(Config.withDefault("http://localhost:9000")),
    accessKeyId: Config.String("S3_ACCESS_KEY_ID").pipe(Config.withDefault("minioadmin")),
    secretAccessKey: Config.String("S3_SECRET_ACCESS_KEY").pipe(Config.withDefault("minioadmin")),
  }),
)

const reachable = async (url: string, init: RequestInit = {}): Promise<boolean> => {
  try {
    // Any answer (DynamoDB Local's 400, MinIO's anonymous 403) means it is up.
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(1000) }).catch(() => null)
    return res !== null
  } catch {
    return false
  }
}

const available =
  (await reachable(settings.dynamodb, { method: "POST" })) && (await reachable(settings.s3))

const describeConnected = available ? describe : describe.skip

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/** Offloading requires escaped key text (`[EDD-9146]`, design §11.10). */
const AppSchema = DynamoSchema.make({ name: "blob-e2e", version: 1, escapeKeys: true })
/** The same application with `escapeKeys` off: no member offloading on it may be bound. */
const UnescapedSchema = DynamoSchema.make({ name: "blob-e2e", version: 1, escapeKeys: false })
const stamp = Date.now()
const mainTable = `blob-e2e-main-${stamp}`
const copyTable = `blob-e2e-copy-${stamp}`
const eventsTable = `blob-e2e-events-${stamp}`
const keysTable = `blob-e2e-keys-${stamp}`
const bucket = `edd-blob-e2e-${stamp}`

const Text = Schema.Struct({ text: Schema.String })

/** Over 4,096 stored bytes after zstd: offloaded. */
const overflow = DynamoModel.Packed({
  format: "json",
  compression: { codec: "zstd" },
  external: { threshold: 4_096 },
})

class Doc extends Schema.Class<Doc>("Doc")({
  docId: Schema.String,
  title: Schema.String,
  body: Schema.optional(Text),
  scan: Schema.optional(Schema.Uint8Array),
}) {}

const docModel = DynamoModel.configure(Doc, {
  body: { storedAs: overflow },
  scan: { storedAs: DynamoModel.External({ contentType: "application/pdf" }) },
})
const docKey = {
  pk: { field: "pk", composite: ["docId"] },
  sk: { field: "sk", composite: [] },
} as const

/** A plain entity, with an index to query its rows through. */
const Docs = Entity.make({
  model: docModel,
  entityType: "Doc",
  primaryKey: docKey,
  indexes: {
    byTitle: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["title"] },
      sk: { field: "gsi1sk", composite: ["docId"] },
    },
  },
})

/** Retain and soft delete: one version shared by the live row, snapshots and tombstones. */
const Kept = Entity.make({
  model: docModel,
  entityType: "Kept",
  primaryKey: docKey,
  versioned: { retain: true },
  softDelete: true,
})

class Note extends Schema.Class<Note>("Note")({
  ownerId: Schema.String,
  noteId: Schema.String,
  title: Schema.String,
  body: Schema.optional(Text),
}) {}

/** Sort-key composites: sibling items' rows interleave in the partition. */
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

class Venue extends Schema.Class<Venue>("Venue")({
  venueId: Schema.String,
  name: Schema.String,
  plan: Schema.Uint8Array,
}) {}

const Venues = Entity.make({
  model: DynamoModel.configure(Venue, {
    venueId: { identifier: true },
    plan: { storedAs: DynamoModel.External({ contentType: "image/png" }) },
  }),
  entityType: "Venue",
  primaryKey: { pk: { field: "pk", composite: ["venueId"] }, sk: { field: "sk", composite: [] } },
})

class Ticket extends Schema.Class<Ticket>("Ticket")({
  ticketNo: Schema.Number,
  title: Schema.String,
  body: Schema.optional(Text),
  scan: Schema.optional(Schema.Uint8Array),
}) {}

const ticketKey = {
  pk: { field: "pk", composite: ["ticketNo"] },
  sk: { field: "sk", composite: [] },
} as const
const ticketModel = DynamoModel.configure(Ticket, {
  body: { storedAs: overflow },
  scan: { storedAs: DynamoModel.External() },
})

/** A numeric key composite: `escapeKeys` changes its key text (numeric text, or zero-padded). */
const Tickets = Entity.make({ model: ticketModel, entityType: "Ticket", primaryKey: ticketKey })
const KeysTable = Table.make({ schema: AppSchema, entities: { Tickets } })
/** The same items on the table's schema with `escapeKeys` off: refused at bind and at routing. */
const UnescapedTickets = Entity.make({
  model: ticketModel,
  entityType: "Ticket",
  primaryKey: ticketKey,
})
const UnescapedKeysTable = Table.make({
  schema: UnescapedSchema,
  entities: { UnescapedTickets },
})
/** `escapeKeys` turned off, the offloaded declarations removed (as a binding requires). */
const PlainTickets = Entity.make({ model: Ticket, entityType: "Ticket", primaryKey: ticketKey })
const PlainKeysTable = Table.make({ schema: UnescapedSchema, entities: { PlainTickets } })

class Badge extends Schema.Class<Badge>("Badge")({
  badgeId: Schema.String,
  email: Schema.String,
  body: Schema.optional(Text),
}) {}

/** A unique constraint: its `insert()` is an `ExecuteTransaction` with its sentinel. */
const Badges = Entity.make({
  model: DynamoModel.configure(Badge, { body: { storedAs: overflow } }),
  entityType: "Badge",
  primaryKey: { pk: { field: "pk", composite: ["badgeId"] }, sk: { field: "sk", composite: [] } },
  unique: { email: ["email"] },
})

const MainTable = Table.make({
  schema: AppSchema,
  entities: { Docs, Kept, Notes, Readings, Venues, Badges },
})

class Match extends Schema.Class<Match>("Match")({
  matchId: Schema.String,
  name: Schema.String,
  venue: Venue,
}) {}

/** An aggregate whose edge offloads its binary field. */
const Matches = Aggregate.make(Match, {
  table: MainTable,
  schema: AppSchema,
  pk: { field: "pk", composite: ["matchId"] },
  collection: { name: "match" },
  root: { entityType: "MatchItem" },
  edges: { venue: Aggregate.one("venue", { entityType: "MatchVenue", entity: Venues }) },
})

/** The same items in a copy of the main table (a restore, an import). */
const CopyDocs = Entity.make({ model: docModel, entityType: "Doc", primaryKey: docKey })
const CopyTable = Table.make({ schema: AppSchema, entities: { CopyDocs } })

class Filed extends Schema.TaggedClass<Filed>()("Filed", { note: Schema.String }) {}
const CaseState = Schema.Struct({ notes: Schema.Array(Schema.String) })
type CaseState = typeof CaseState.Type

/** Offloaded at 256 bytes of JSON or more. */
const streamOverflow = DynamoModel.Packed({ format: "json", external: { threshold: 256 } })
const EventsTable = Table.make({ schema: AppSchema, entities: {} })

/** Event data and the inline snapshot's state offload; an LSI over every event. */
const Cases = EventStore.makeStream({
  table: EventsTable,
  streamName: "Case",
  events: [Filed],
  streamId: { composite: ["caseId"] },
  storedAs: { data: streamOverflow },
  snapshot: { schema: CaseState, mode: "inline", storedAs: streamOverflow },
  indexes: {
    byVersion: {
      index: "lsi1",
      sk: "lsi1sk",
      key: (_event: Filed, version: number) => String(version).padStart(4, "0"),
    },
  },
})

// ---------------------------------------------------------------------------
// Infrastructure
// ---------------------------------------------------------------------------

const admin = new S3Client({
  region: "us-east-1",
  endpoint: settings.s3,
  forcePathStyle: true,
  credentials: { accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey },
})

/** The S3 store over the bucket, under `prefix` (presigning GETs on request). */
const s3Store = (prefix: string, options: { readonly presign?: boolean } = {}): BlobStoreService =>
  Effect.runSync(
    Effect.scoped(
      S3BlobStore.make({
        bucket,
        client: admin,
        prefix,
        ...(options.presign === true ? { presign: { getSignedUrl } } : {}),
      }),
    ),
  )

interface Probe {
  readonly calls: { put: number; get: number; delete: number; list: number; head: number }
  /** Fail every delete, as a process that crashed before its rollback would leave the upload. */
  failDeletes: boolean
}

/** `service` with its calls counted, and its deletes failing on request. */
const probed = (service: BlobStoreService): { readonly store: BlobStoreService; probe: Probe } => {
  const probe: Probe = {
    calls: { put: 0, get: 0, delete: 0, list: 0, head: 0 },
    failDeletes: false,
  }
  const { list, head } = service
  const store: BlobStoreService = {
    ...service,
    put: (request) =>
      Effect.suspend(() => {
        probe.calls.put++
        return service.put(request)
      }),
    get: (ref, options) =>
      Stream.suspend(() => {
        probe.calls.get++
        return service.get(ref, options)
      }),
    delete: (refs) =>
      Effect.suspend(() => {
        probe.calls.delete++
        return probe.failDeletes
          ? Effect.fail(new BlobStoreFailure({ reason: "Unavailable", cause: "simulated crash" }))
          : service.delete(refs)
      }),
    ...(list === undefined
      ? {}
      : {
          list: (prefix, options) =>
            Stream.suspend(() => {
              probe.calls.list++
              return list(prefix, options)
            }),
        }),
    ...(head === undefined
      ? {}
      : {
          head: (ref) =>
            Effect.suspend(() => {
              probe.calls.head++
              return head(ref)
            }),
        }),
  }
  return { store, probe }
}

/** What runs right after each `BatchWriteItem` lands (a writer racing a purge). */
const afterBatchWrite: Array<Effect.Effect<void>> = []

const credentials = { accessKeyId: "local", secretAccessKey: "local" }
const ClientLayer = Layer.effect(
  DynamoClient,
  Effect.map(
    Effect.service(DynamoClient),
    (inner): DynamoClientService => ({
      ...inner,
      batchWriteItem: (input) =>
        Effect.tap(inner.batchWriteItem(input), () =>
          Effect.forEach(afterBatchWrite.splice(0), (effect) => effect, { discard: true }),
        ),
    }),
  ),
).pipe(
  Layer.provide(
    DynamoClient.layer({ region: "us-east-1", endpoint: settings.dynamodb, credentials }),
  ),
)

const Base = Layer.mergeAll(
  ClientLayer,
  Compression.layer([ZlibCompression.zstd()]),
  MainTable.layer({ name: mainTable }),
  CopyTable.layer({ name: copyTable }),
  EventsTable.layer({ name: eventsTable }),
  KeysTable.layer({ name: keysTable }),
)

/** Run `effect` with `store` as the blob store (and any extra layer: an observer). */
const using =
  (store: BlobStoreService, extra: Layer.Layer<never> = Layer.empty) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.suspend(() =>
      effect.pipe(Effect.provide(Layer.mergeAll(Base, BlobStore.layer(store), extra))),
    )

const client = DynamoClient.make({
  entities: { Docs, Kept, Notes, Readings, Venues, Badges },
  aggregates: { Matches },
  tables: { MainTable },
})
const copyClient = DynamoClient.make({ entities: { CopyDocs }, tables: { CopyTable } })
const keysClient = DynamoClient.make({ entities: { Tickets }, tables: { KeysTable } })

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Item = Record<string, AttributeValue>

const lower = (text: string) => text.toLowerCase()
const docPk = (entity: string, id: string) => lower(`$blob-e2e#v1#${entity}#docid_${id}`)
const docSk = (entity: string) => lower(`$blob-e2e#v1#${entity}`)

/** Every row of a partition, read strongly consistently. */
const rowsOf = (table: string, pk: string) =>
  Effect.gen(function* () {
    const raw = yield* DynamoClient
    const out: Array<Item> = []
    let start: Item | undefined
    do {
      const page = yield* raw.query({
        TableName: table,
        KeyConditionExpression: "#pk = :pk",
        ExpressionAttributeNames: { "#pk": "pk" },
        ExpressionAttributeValues: { ":pk": { S: pk } },
        ConsistentRead: true,
        ...(start === undefined ? {} : { ExclusiveStartKey: start }),
      })
      out.push(...((page.Items ?? []) as Array<Item>))
      start = page.LastEvaluatedKey as Item | undefined
    } while (start !== undefined)
    return out
  })

const rowAt = (table: string, pk: string, sk: string) =>
  Effect.map(rowsOf(table, pk), (rows) => rows.find((row) => row.sk?.S === sk))
/** A doc's live row; fails when it has none. */
const liveDoc = (entity: string, id: string, table = mainTable) =>
  Effect.flatMap(rowAt(table, docPk(entity, id), docSk(entity)), (row) =>
    row === undefined ? Effect.fail(new Error(`no ${entity} row ${id}`)) : Effect.succeed(row),
  )

/** The version a stored value's pointer names; fails when the value is not a pointer. */
const refOf = (value: AttributeValue | undefined): Effect.Effect<BlobRef, Error> => {
  const pointer = pointerOf(value)
  return pointer === undefined
    ? Effect.fail(new Error("not a pointer"))
    : Effect.succeed(pointer.ref)
}
const isOverflowPointer = (value: AttributeValue | undefined) =>
  value?.B !== undefined && BlobPointer.isPointerHeader(value.B[0]!)
const isBinaryPointer = (value: AttributeValue | undefined) =>
  value?.S !== undefined && BlobPointer.isPointerText(value.S)

/** Every ref the rows hold, on any attribute. */
const refsOfRows = (rows: ReadonlyArray<Item>): Array<BlobRef> => {
  const out = new Map<string, BlobRef>()
  for (const row of rows) {
    for (const value of Object.values(row)) {
      const pointer = pointerOf(value)
      if (pointer !== undefined) out.set(`${pointer.ref.key} ${pointer.ref.version}`, pointer.ref)
    }
  }
  return [...out.values()]
}

/** One call of the admin S3 client (the test's own view of the bucket). */
const send = <O>(command: object): Effect.Effect<O, Error> =>
  Effect.tryPromise({
    try: () =>
      (admin as unknown as { send: (c: object) => Promise<unknown> }).send(command) as Promise<O>,
    catch: (cause) => new Error(`S3 admin call failed: ${String(cause)}`),
  })

/** Every version (and delete marker) in the bucket under `prefix`. */
const versionsUnder = (prefix: string) =>
  Effect.gen(function* () {
    const versions: Array<BlobRef> = []
    let deleteMarkers = 0
    let keyMarker: string | undefined
    let versionMarker: string | undefined
    for (;;) {
      const page = yield* send<ListObjectVersionsCommandOutput>(
        new ListObjectVersionsCommand({
          Bucket: bucket,
          Prefix: prefix,
          ...(keyMarker === undefined ? {} : { KeyMarker: keyMarker }),
          ...(versionMarker === undefined ? {} : { VersionIdMarker: versionMarker }),
        }),
      )
      for (const v of page.Versions ?? []) versions.push({ key: v.Key!, version: v.VersionId! })
      deleteMarkers += page.DeleteMarkers?.length ?? 0
      if (page.IsTruncated !== true) break
      keyMarker = page.NextKeyMarker
      versionMarker = page.NextVersionIdMarker
    }
    return { versions, deleteMarkers }
  })

const exists = (ref: BlobRef) =>
  Effect.map(versionsUnder(ref.key), ({ versions }) =>
    versions.some((v) => v.key === ref.key && v.version === ref.version),
  )

/** `ref`'s version is gone, deleted by its version id: no delete marker under its key. */
const deletedByVersion = (ref: BlobRef) =>
  Effect.map(
    versionsUnder(ref.key),
    ({ versions, deleteMarkers }) =>
      deleteMarkers === 0 && !versions.some((v) => v.version === ref.version),
  )

/** The tags of one version. */
const tagsOf = (ref: BlobRef) =>
  Effect.map(
    send<{ TagSet?: Array<{ Key?: string; Value?: string }> }>(
      new GetObjectTaggingCommand({ Bucket: bucket, Key: ref.key, VersionId: ref.version }),
    ),
    (out) => Object.fromEntries((out.TagSet ?? []).map((tag) => [tag.Key ?? "", tag.Value ?? ""])),
  )

/** Deterministic text that zstd barely compresses. */
const noise = (n: number, seed: number): string => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
  let x = seed >>> 0 || 1
  let out = ""
  for (let i = 0; i < n; i++) {
    x = (Math.imul(x, 1_103_515_245) + 12_345) >>> 0
    out += alphabet[(x >>> 16) & 63]
  }
  return out
}
/** A body offloaded even after zstd. */
const big = (seed: number) => ({ text: noise(8_000, seed) })
const bytes = (n: number, fill = 7) => new Uint8Array(n).fill(fill)
const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(b)

/** The table's stream ARN, as Lambda's `eventSourceARN` names it. */
const streamArn = (table: string) =>
  `arn:aws:dynamodb:us-east-1:000000000000:table/${table}/stream/2026-11-01T00:00:00.000`

/** An image in Lambda's DynamoDB JSON: `B` as base64. */
const lambdaImage = (item: Item): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(item).map(([name, value]) => [
      name,
      value.B !== undefined ? { B: Buffer.from(value.B).toString("base64") } : value,
    ]),
  )

const lambdaRecord = (
  table: string,
  oldItem: Item | undefined,
  newItem: Item | undefined,
  at: number,
): BlobGc.StreamRecordLike => {
  const item = (newItem ?? oldItem)!
  return {
    eventName: oldItem === undefined ? "INSERT" : newItem === undefined ? "REMOVE" : "MODIFY",
    eventSourceARN: streamArn(table),
    dynamodb: {
      // Epoch seconds, as Lambda delivers it.
      ApproximateCreationDateTime: Math.floor(at / 1000),
      Keys: lambdaImage({ pk: item.pk!, sk: item.sk! }) as never,
      StreamViewType: "NEW_AND_OLD_IMAGES",
      ...(oldItem === undefined ? {} : { OldImage: lambdaImage(oldItem) as never }),
      ...(newItem === undefined ? {} : { NewImage: lambdaImage(newItem) as never }),
    },
  }
}

const rowKey = (row: Item) => `${row.pk?.S}\u0000${row.sk?.S}`

/**
 * Run `effect` and return the stream records of the rows it changed in the
 * partition (or partitions), built from the rows read before and after it.
 */
const recorded = <A, E, R>(
  table: string,
  pk: string | ReadonlyArray<string>,
  effect: Effect.Effect<A, E, R> | { readonly asEffect: () => Effect.Effect<A, E, R> },
) =>
  Effect.gen(function* () {
    const pks = typeof pk === "string" ? [pk] : pk
    const read = Effect.map(
      Effect.forEach(pks, (partition) => rowsOf(table, partition)),
      (rows) => new Map(rows.flat().map((row) => [rowKey(row), row])),
    )
    const before = yield* read
    yield* Effect.isEffect(effect) ? effect : effect.asEffect()
    const after = yield* read
    const at = yield* Clock.currentTimeMillis
    const records: Array<BlobGc.StreamRecordLike> = []
    for (const key of new Set([...before.keys(), ...after.keys()])) {
      const old = before.get(key)
      const now = after.get(key)
      if (old !== undefined && now !== undefined && attributeValueEquals({ M: old }, { M: now })) {
        continue
      }
      records.push(lambdaRecord(table, old, now, at))
    }
    return records
  })

/** Delete a row as a TTL expiry does, returning its `REMOVE` record. */
const expire = (table: string, row: Item) =>
  Effect.gen(function* () {
    const raw = yield* DynamoClient
    yield* raw.deleteItem({ TableName: table, Key: { pk: row.pk!, sk: row.sk! } })
    return lambdaRecord(table, row, undefined, yield* Clock.currentTimeMillis)
  })

/** The `TestClock` on the wall clock: MinIO dates every version with it. */
const wallClock = Effect.suspend(() => TestClock.setTime(Date.now()))

const NO_GRACE = { gracePeriod: 0 } as const
/** Past `maxUploadAge` (1 hour) + 15 minutes: a version this old can be marked. */
const PAST_IN_FLIGHT = "80 minutes"
/** Past the default sweep grace (24 hours). */
const PAST_GRACE = "25 hours"

const emptyBucket = async (): Promise<void> => {
  for (;;) {
    const out = await admin.send(new ListObjectVersionsCommand({ Bucket: bucket }))
    const objects = [...(out.Versions ?? []), ...(out.DeleteMarkers ?? [])].map((v) => ({
      Key: v.Key!,
      VersionId: v.VersionId,
    }))
    if (objects.length === 0) return
    await admin.send(
      new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects, Quiet: true } }),
    )
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeConnected("Offloaded storage end to end over S3 (#179)", () => {
  const setupStore = s3Store("setup/")

  beforeAll(async () => {
    await admin.send(new CreateBucketCommand({ Bucket: bucket }))
    await admin.send(
      new PutBucketVersioningCommand({
        Bucket: bucket,
        VersioningConfiguration: { Status: "Enabled" },
      }),
    )
    await Effect.runPromise(
      using(setupStore)(
        Effect.gen(function* () {
          const db = yield* client
          yield* db.tables.MainTable.create()
          const copy = yield* copyClient
          yield* copy.tables.CopyTable.create()
          const keys = yield* keysClient
          yield* keys.tables.KeysTable.create()
          const raw = yield* DynamoClient
          const fragments = EventStore.indexDefinitions(Cases)
          yield* raw.createTable({
            TableName: eventsTable,
            BillingMode: "PAY_PER_REQUEST",
            KeySchema: [
              { AttributeName: "pk", KeyType: "HASH" },
              { AttributeName: "sk", KeyType: "RANGE" },
            ],
            AttributeDefinitions: [
              { AttributeName: "pk", AttributeType: "S" },
              { AttributeName: "sk", AttributeType: "S" },
              ...fragments.AttributeDefinitions,
            ],
            LocalSecondaryIndexes: fragments.LocalSecondaryIndexes,
          })
        }),
      ),
    )
  }, 30000)

  afterAll(async () => {
    await Effect.runPromise(
      using(setupStore)(
        Effect.gen(function* () {
          const raw = yield* DynamoClient
          for (const table of [mainTable, copyTable, eventsTable, keysTable]) {
            yield* raw
              .deleteTable({ TableName: table })
              .pipe(Effect.catchTag("ResourceNotFoundError", () => Effect.void))
          }
        }),
      ),
    )
    await emptyBucket().catch(() => undefined)
    await admin.send(new DeleteBucketCommand({ Bucket: bucket })).catch(() => undefined)
    admin.destroy()
  }, 30000)

  // -------------------------------------------------------------------------
  // Entities
  // -------------------------------------------------------------------------

  describe("entities", () => {
    it.effect(
      "an overflow field (zstd) and a binary field: B and S pointers, inline under the threshold, a 12 MB stream",
      () => {
        const { store, probe } = probed(s3Store("entities/put/"))
        return using(store)(
          Effect.gen(function* () {
            const db = yield* client
            const body = big(1)
            const scan = bytes(1_000, 3)
            yield* db.entities.Docs.put({ docId: "e-1", title: "t", body, scan })
            const row = yield* liveDoc("doc", "e-1")
            expect(isOverflowPointer(row.body)).toBe(true)
            expect(isBinaryPointer(row.scan)).toBe(true)
            const bodyPointer = pointerOf(row.body)!
            expect(bodyPointer.codec).toBe("zstd")
            expect(bodyPointer.contentSize).toBe(JSON.stringify(body).length)
            // What S3 holds: the compressed JSON (§4.4) and the metadata (§4.6).
            const head = yield* send<{
              ContentType?: string
              ContentLength?: number
              Metadata?: Record<string, string>
            }>(
              new HeadObjectCommand({
                Bucket: bucket,
                Key: bodyPointer.ref.key,
                VersionId: bodyPointer.ref.version,
              }),
            )
            expect(head.ContentLength).toBe(bodyPointer.objectSize)
            expect(head.ContentType).toBe("application/octet-stream")
            expect(head.Metadata).toMatchObject({
              "edd-v": "1",
              "edd-table": mainTable,
              "edd-entity": "Doc",
              "edd-attr": "body",
              "edd-kind": "json",
              "edd-codec": "zstd",
            })
            const scanRef = yield* refOf(row.scan)
            const scanHead = yield* send<{ ContentType?: string }>(
              new HeadObjectCommand({
                Bucket: bucket,
                Key: scanRef.key,
                VersionId: scanRef.version,
              }),
            )
            expect(scanHead.ContentType).toBe("application/pdf")
            expect(
              scanRef.key.startsWith(
                familyPrefix("entities/put/", {
                  table: mainTable,
                  pk: { S: docPk("doc", "e-1") },
                  familySk: { S: docSk("doc") },
                }),
              ),
            ).toBe(true)

            // A value zstd shrinks under the threshold stays inline: no upload.
            const puts = probe.calls.put
            yield* db.entities.Docs.put({
              docId: "e-2",
              title: "t",
              body: { text: "x".repeat(20_000) },
            })
            const inline = yield* liveDoc("doc", "e-2")
            expect(inline.body?.B).toBeInstanceOf(Uint8Array)
            expect(isOverflowPointer(inline.body)).toBe(false)
            expect(probe.calls.put).toBe(puts)
            expect((yield* db.entities.Docs.get({ docId: "e-2" })).body).toEqual({
              text: "x".repeat(20_000),
            })

            // 12 MB from a stream: a multipart upload (two 8 MiB parts), checksummed as it streams.
            const MB = 1_000_000
            const content = new Uint8Array(12 * MB)
            for (let i = 0; i < content.length; i++) content[i] = (i * 31 + 5) & 0xff
            const chunks = Array.from({ length: 12 }, (_, i) => content.slice(i * MB, (i + 1) * MB))
            yield* db.entities.Docs.put({
              docId: "e-3",
              title: "t",
              scan: Stream.fromIterable(chunks),
            })
            const streamed = yield* liveDoc("doc", "e-3")
            const pointer = pointerOf(streamed.scan)!
            expect(pointer.contentSize).toBe(12 * MB)
            expect(pointer.checksum.value).toEqual(crc64nvme(content))
            const stored = yield* send<{
              ChecksumCRC64NVME?: string
              ContentLength?: number
              ETag?: string
            }>(
              new HeadObjectCommand({
                Bucket: bucket,
                Key: pointer.ref.key,
                VersionId: pointer.ref.version,
                ChecksumMode: "ENABLED",
              }),
            )
            expect(stored).toMatchObject({
              ChecksumCRC64NVME: Buffer.from(crc64nvme(content)).toString("base64"),
              ContentLength: 12 * MB,
            })
            // A full-object checksum is the same for one PUT: the parts prove the multipart upload.
            expect(stored.ETag).toMatch(/-2"?$/)
            const firstPart = yield* send<{ PartsCount?: number; ContentLength?: number }>(
              new HeadObjectCommand({
                Bucket: bucket,
                Key: pointer.ref.key,
                VersionId: pointer.ref.version,
                PartNumber: 1,
              }),
            )
            expect(firstPart).toMatchObject({ PartsCount: 2, ContentLength: 8 * 1024 * 1024 })
            const handle = (yield* db.entities.Docs.get({ docId: "e-3" })).scan!
            expect(Offload.isBlobHandle(handle)).toBe(true)
            expect(sameBytes(yield* handle.read(), content)).toBe(true)
            expect(yield* handle.read({ range: { offset: 9 * MB, length: 10 } })).toEqual(
              content.slice(9 * MB, 9 * MB + 10),
            )
            const eager = yield* db.entities.Docs.get({ docId: "e-3" }).offloaded("eager")
            expect(sameBytes(eager.scan!, content)).toBe(true)
          }),
        )
      },
      60000,
    )

    it.effect(
      "reads per mode, a select that fetches nothing, update().set(), a refused create's upload deleted",
      () => {
        const { store, probe } = probed(s3Store("entities/reads/"))
        return using(store)(
          Effect.gen(function* () {
            const db = yield* client
            for (const [i, docId] of ["r-1", "r-2", "r-3"].entries()) {
              yield* db.entities.Docs.put({
                docId,
                title: "reads",
                body: big(10 + i),
                scan: bytes(64, i),
              })
            }
            // get: overflow eager, binary a lazy handle.
            let gets = probe.calls.get
            const doc = yield* db.entities.Docs.get({ docId: "r-1" })
            expect(doc.body).toEqual(big(10))
            expect(probe.calls.get).toBe(gets + 1)
            expect(Offload.isBlobHandle(doc.scan)).toBe(true)
            expect(yield* doc.scan!.read()).toEqual(bytes(64, 0))
            expect(probe.calls.get).toBe(gets + 2)

            gets = probe.calls.get
            const lazy = yield* db.entities.Docs.get({ docId: "r-2" }).offloaded("lazy")
            expect(probe.calls.get).toBe(gets)
            expect(Offload.isOffloadedValue(lazy.body)).toBe(true)
            expect(yield* lazy.body!.read()).toEqual(big(11))
            expect(probe.calls.get).toBe(gets + 1)

            // A query whose select omits both fields fetches nothing.
            gets = probe.calls.get
            const ids = yield* db.entities.Docs.byTitle({ title: "reads" })
              .select(["docId", "title"])
              .collect()
            expect(ids.map((d) => d.docId)).toEqual(["r-1", "r-2", "r-3"])
            expect(probe.calls.get).toBe(gets)
            const all = yield* db.entities.Docs.byTitle({ title: "reads" }).collect()
            expect(all.map((d) => d.body)).toEqual([big(10), big(11), big(12)])
            expect(probe.calls.get).toBe(gets + 3)

            // update().set(): a new version under the same key; the old one is the reaper's.
            const before = yield* refOf((yield* liveDoc("doc", "r-1")).body)
            const updated = yield* db.entities.Docs.update({ docId: "r-1" }).set({ body: big(19) })
            expect(updated.body).toEqual(big(19))
            const after = yield* refOf((yield* liveDoc("doc", "r-1")).body)
            expect(after.key).toBe(before.key)
            expect(after.version).not.toBe(before.version)
            expect(yield* exists(before)).toBe(true)
            expect((yield* db.entities.Docs.get({ docId: "r-1" })).body).toEqual(big(19))

            // A create over the existing item: its upload lands, then is deleted; the previous version kept.
            const versions = (yield* versionsUnder(after.key)).versions.length
            const calls = { ...probe.calls }
            const refused = yield* Effect.flip(
              db.entities.Docs.create({ docId: "r-1", title: "reads", body: big(20) }).asEffect(),
            )
            expect(refused._tag).toBe("ConditionalCheckFailed")
            expect(probe.calls.put - calls.put).toBe(1)
            expect(probe.calls.delete - calls.delete).toBe(1)
            expect(yield* versionsUnder(after.key)).toMatchObject({ deleteMarkers: 0 })
            expect((yield* versionsUnder(after.key)).versions).toHaveLength(versions)
            expect(yield* exists(after)).toBe(true)
            expect((yield* db.entities.Docs.get({ docId: "r-1" })).body).toEqual(big(19))
          }),
        )
      },
    )

    it.effect(
      "transactWrite cancelled deletes every upload; Batch.write; a stale append's upload deleted",
      () => {
        const { store, probe } = probed(s3Store("entities/writes/"))
        return using(store)(
          Effect.gen(function* () {
            const db = yield* client
            yield* db.entities.Docs.put({ docId: "x-1", title: "t" })
            yield* db.entities.Docs.put({ docId: "x-2", title: "t" })
            const listed = () =>
              Effect.map(versionsUnder("entities/writes/"), (all) => all.versions.length)
            const before = yield* listed()
            const puts = probe.calls.put
            const error = yield* Effect.flip(
              Transaction.transactWrite([
                db.entities.Docs.put({ docId: "x-3", title: "t", body: big(30) }),
                db.entities.Docs.update({ docId: "x-1" }).set({ body: big(31), scan: bytes(9) }),
                // x-2 exists: DynamoDB cancels the transaction.
                db.entities.Docs.create({ docId: "x-2", title: "t", body: big(32) }),
              ]),
            )
            expect(error._tag).toBe("TransactionCancelled")
            expect(probe.calls.put - puts).toBe(4)
            expect(yield* listed()).toBe(before)
            expect(yield* versionsUnder("entities/writes/")).toMatchObject({ deleteMarkers: 0 })
            expect((yield* liveDoc("doc", "x-1")).body).toBeUndefined()

            yield* Batch.write([
              db.entities.Docs.put({ docId: "w-1", title: "t", body: big(33), scan: bytes(5) }),
              db.entities.Docs.put({ docId: "w-2", title: "t", body: big(34) }),
            ])
            expect(isOverflowPointer((yield* liveDoc("doc", "w-1")).body)).toBe(true)
            const [one, two] = yield* Batch.get([
              db.entities.Docs.get({ docId: "w-1" }).offloaded("eager"),
              db.entities.Docs.get({ docId: "w-2" }),
            ])
            expect(one).toMatchObject({ body: big(33), scan: bytes(5) })
            expect(two!.body).toEqual(big(34))

            // A time-series append keyed by its event item; a stale one's upload deleted.
            yield* db.entities.Readings.append({ sensorId: "s-1", at: 5, raw: bytes(32, 1) })
            const family = familyPrefix("entities/writes/", {
              table: mainTable,
              pk: { S: "$blob-e2e#v1#reading#sensorid_s-1" },
              familySk: { S: "$blob-e2e#v1#reading" },
            })
            expect((yield* versionsUnder(family)).versions).toHaveLength(1)
            const calls = { ...probe.calls }
            const stale = yield* Effect.flip(
              db.entities.Readings.append({ sensorId: "s-1", at: 2, raw: bytes(32, 2) }).asEffect(),
            )
            expect(stale._tag).toBe("StaleAppend")
            expect(probe.calls.put - calls.put).toBe(1)
            expect(probe.calls.delete - calls.delete).toBe(1)
            expect(yield* versionsUnder(family)).toMatchObject({ deleteMarkers: 0 })
            expect((yield* versionsUnder(family)).versions).toHaveLength(1)
            const current = yield* db.entities.Readings.get({ sensorId: "s-1" }).offloaded("eager")
            expect(current.raw).toEqual(bytes(32, 1))
          }),
        )
      },
    )

    it.effect("retain, softDelete and restore keep every pointer resolving", () => {
      const { store, probe } = probed(s3Store("entities/kept/"))
      return using(store)(
        Effect.gen(function* () {
          const db = yield* client
          const key = { docId: "k-1" }
          yield* db.entities.Kept.put({ ...key, title: "v1", body: big(40), scan: bytes(7, 4) })
          const original = yield* liveDoc("kept", "k-1")
          yield* db.entities.Kept.update(key).set({ title: "v2" })
          const versions = yield* db.entities.Kept.versions(key).collect()
          expect(versions.map((v) => v.title)).toContain("v1")
          for (const v of versions) expect(v.body).toEqual(big(40))
          yield* db.entities.Kept.delete(key)
          const tombstone = yield* db.entities.Kept.deleted.get(key)
          expect(tombstone.body).toEqual(big(40))
          expect(yield* tombstone.scan!.read()).toEqual(bytes(7, 4))
          const restored = yield* db.entities.Kept.restore(key)
          expect(restored.body).toEqual(big(40))
          const live = yield* liveDoc("kept", "k-1")
          expect(live.body).toEqual(original.body)
          expect(live.scan).toEqual(original.scan)
          const read = yield* db.entities.Kept.get(key).offloaded("eager")
          expect(read).toMatchObject({ title: "v2", body: big(40), scan: bytes(7, 4) })
          // Every copy shares the two uploads.
          expect(probe.calls.put).toBe(2)
        }),
      )
    })

    it.effect("a handle read before an update presigns a GET of the version it read", () => {
      const { store } = probed(s3Store("entities/presign/", { presign: true }))
      const fetched = (url: string) =>
        Effect.tryPromise(async () => {
          const response = await fetch(url)
          return {
            status: response.status,
            contentType: response.headers.get("content-type"),
            body: new Uint8Array(await response.arrayBuffer()),
          }
        })
      return using(store)(
        Effect.gen(function* () {
          const db = yield* client
          yield* db.entities.Docs.put({ docId: "u-1", title: "t", scan: bytes(500, 1) })
          const handle = (yield* db.entities.Docs.get({ docId: "u-1" })).scan!
          yield* db.entities.Docs.update({ docId: "u-1" }).set({ scan: bytes(500, 2) })
          // The superseded version, pinned by the handle, with the field's content type.
          const old = yield* fetched(yield* handle.presignedUrl())
          expect(old).toEqual({
            status: 200,
            contentType: "application/pdf",
            body: bytes(500, 1),
          })
          const current = (yield* db.entities.Docs.get({ docId: "u-1" })).scan!
          const now = yield* fetched(yield* current.presignedUrl({ expiresIn: "1 minute" }))
          expect(now).toEqual({ status: 200, contentType: "application/pdf", body: bytes(500, 2) })
        }),
      )
    })
  })

  // -------------------------------------------------------------------------
  // Aggregates and EventStore
  // -------------------------------------------------------------------------

  describe("aggregates and streams", () => {
    it.effect("an aggregate's offloaded edge field: re-uploaded per changed group, swept", () => {
      const { store } = probed(s3Store("aggregates/"))
      return using(store)(
        Effect.gen(function* () {
          yield* wallClock
          const gc = yield* BlobGc.make({ aggregates: { Matches } })
          yield* Matches.create({
            matchId: "m-1",
            name: "Final",
            venue: { venueId: "v-1", name: "Arena", plan: bytes(2_000, 1) },
          })
          const pk = composeCollectionKey(AppSchema, "match", ["m-1"])
          const edge = () =>
            Effect.map(rowsOf(mainTable, pk), (rows) =>
              rows.find((row) => row.__edd_e__?.S === "MatchVenue"),
            )
          const first = yield* refOf((yield* edge())!.plan)
          expect(isBinaryPointer((yield* edge())!.plan)).toBe(true)
          expect((yield* Matches.get({ matchId: "m-1" })).venue.plan).toEqual(bytes(2_000, 1))
          // The changed group uploads its values again: a new version of the edge's key.
          yield* Matches.update({ matchId: "m-1" }, ({ state }) => ({
            ...state,
            name: "Cup",
            venue: { ...state.venue, plan: bytes(2_000, 2) },
          }))
          const second = yield* refOf((yield* edge())!.plan)
          expect(second.version).not.toBe(first.version)
          const match = yield* Matches.get({ matchId: "m-1" })
          expect(match).toMatchObject({ name: "Cup", venue: { plan: bytes(2_000, 2) } })

          // The partition sweep: the superseded version marked, then deleted.
          yield* TestClock.adjust(PAST_IN_FLIGHT)
          const sweep = gc.sweepPartition("Matches", { matchId: "m-1" })
          expect(yield* sweep).toMatchObject({ referenced: 1, listed: 2, marked: 1, deleted: 0 })
          yield* TestClock.adjust(PAST_GRACE)
          expect(yield* sweep).toMatchObject({ referenced: 1, listed: 2, deleted: 1 })
          expect(yield* deletedByVersion(first)).toBe(true)
          expect(yield* exists(second)).toBe(true)
          expect((yield* Matches.get({ matchId: "m-1" })).venue.plan).toEqual(bytes(2_000, 2))
        }),
      )
    })

    it.effect(
      "a stream with offloaded data and snapshot: read, readLatest, readIndex, raw rows; a superseded snapshot reaped",
      () => {
        const { store, probe } = probed(s3Store("streams/"))
        const LONG = "the quick brown fox jumps over the lazy dog; ".repeat(20)
        const filed = (note: string) => new Filed({ note })
        const state = (n: number): CaseState => ({ notes: Array.from({ length: n }, () => LONG) })
        const id = { caseId: "c-1" }
        return using(store)(
          Effect.gen(function* () {
            yield* wallClock
            yield* Cases.append(id, [filed("short"), filed(LONG)], 0, { snapshot: state(2) })
            const pk = "$blob-e2e#v1#case#c-1"
            const rows = yield* rowsOf(eventsTable, pk)
            const events = rows
              .filter((row) => row.__edd_e__?.S === "case.event")
              .sort((a, b) => (a.sk!.S! < b.sk!.S! ? -1 : 1))
            const snapshot = rows.find((row) => row.__edd_e__?.S === "case.snapshot")!
            expect(events).toHaveLength(2)
            expect(isOverflowPointer(events[0]!.data)).toBe(false)
            expect(isOverflowPointer(events[1]!.data)).toBe(true)
            expect(isOverflowPointer(snapshot.state)).toBe(true)
            expect(probe.calls.put).toBe(2)

            const expected = [filed("short"), filed(LONG)]
            expect((yield* Cases.read(id)).map((e) => e.data)).toEqual(expected)
            const latest = yield* Cases.readLatest(id)
            expect(latest.version).toBe(2)
            expect(latest.snapshot.pipe(Option.map((s) => s.state))).toEqual(Option.some(state(2)))
            const indexed = yield* Cases.readIndex("byVersion", id)
            expect(indexed.map((e) => e.data)).toEqual(expected)
            const raw = yield* Cases.query
              .events(id)
              .pipe(Query.select(["version", "data"]), Query.collect)
            expect(raw.map((row) => row.data)).toEqual([
              { _tag: "Filed", note: "short" },
              { _tag: "Filed", note: LONG },
            ])
            const gets = probe.calls.get
            const lazy = yield* Cases.read(id, { offloaded: "lazy" })
            expect(probe.calls.get).toBe(gets)
            expect(yield* lazy[1]!.data.read()).toEqual(filed(LONG))
            expect(probe.calls.get).toBe(gets + 1)

            // A second snapshot supersedes the first's state: the reaper frees it directly.
            const gc = yield* BlobGc.make({ streams: { Cases }, reaper: NO_GRACE })
            const old = yield* refOf(snapshot.state)
            const records = yield* recorded(
              eventsTable,
              pk,
              Cases.append(id, [filed(`${LONG}3`)], 2, { snapshot: state(3) }),
            )
            const report = yield* gc.reap(records)
            expect(report).toMatchObject({ candidates: 1, freed: 1, retained: 0 })
            expect(yield* deletedByVersion(old)).toBe(true)
            const now = yield* Cases.readLatest(id)
            expect(now.snapshot.pipe(Option.map((s) => s.state))).toEqual(Option.some(state(3)))
            expect((yield* Cases.read(id)).map((e) => e.data)).toEqual([
              ...expected,
              filed(`${LONG}3`),
            ])
          }),
        )
      },
    )
  })

  // -------------------------------------------------------------------------
  // Stream records
  // -------------------------------------------------------------------------

  describe("stream records (Lambda's shape)", () => {
    it.effect(
      "decodeStreamRecord classifies, reads per mode; gc.reap frees what was superseded",
      () => {
        const { store } = probed(s3Store("records/"))
        return using(store)(
          Effect.gen(function* () {
            yield* wallClock
            const db = yield* client
            const gc = yield* BlobGc.make({ entities: { Docs }, reaper: NO_GRACE })
            const pk = docPk("doc", "d-1")
            const inserted = yield* recorded(
              mainTable,
              pk,
              db.entities.Docs.put({ docId: "d-1", title: "t", body: big(50), scan: bytes(8, 1) }),
            )
            const v1 = yield* refOf((yield* liveDoc("doc", "d-1")).body)
            const scan = yield* refOf((yield* liveDoc("doc", "d-1")).scan)
            const changed = yield* recorded(
              mainTable,
              pk,
              db.entities.Docs.update({ docId: "d-1" }).set({ body: big(51) }),
            )
            const v2 = yield* refOf((yield* liveDoc("doc", "d-1")).body)
            const rewritten = yield* recorded(
              mainTable,
              pk,
              db.entities.Docs.update({ docId: "d-1" }).set({ body: big(51) }),
            )
            const v3 = yield* refOf((yield* liveDoc("doc", "d-1")).body)
            expect(new Set([v1.version, v2.version, v3.version]).size).toBe(3)

            // Lazy by default: the images' values read from S3 on demand.
            const change = Option.getOrThrow(yield* Entity.decodeStreamRecord(Docs, changed[0]!))
            expect(change.eventName).toBe("MODIFY")
            expect(change.offloaded).toEqual({ body: "changed", scan: "unchanged" })
            const oldItem = Option.getOrThrow(change.oldItem)
            const newItem = Option.getOrThrow(change.newItem)
            expect(Offload.isOffloadedValue(oldItem.body)).toBe(true)
            expect(yield* oldItem.body!.read()).toEqual(big(50))
            expect(yield* newItem.body!.read()).toEqual(big(51))
            expect(yield* newItem.scan!.read()).toEqual(bytes(8, 1))
            const eager = Option.getOrThrow(
              yield* Entity.decodeStreamRecord(Docs, rewritten[0]!, { offloaded: "eager" }),
            )
            expect(eager.offloaded).toEqual({ body: "rewritten", scan: "unchanged" })
            expect(Option.getOrThrow(eager.newItem)).toMatchObject({
              body: big(51),
              scan: bytes(8, 1),
            })
            const created = Option.getOrThrow(yield* Entity.decodeStreamRecord(Docs, inserted[0]!))
            expect(created.offloaded).toEqual({ body: "added", scan: "added" })

            // The reaper: each superseded own version freed; the live ones kept.
            const report = yield* gc.reap([...inserted, ...changed, ...rewritten])
            expect(report).toEqual({
              records: 3,
              candidates: 2,
              freed: 2,
              retained: 0,
              foreign: 0,
              skipped: 1,
            })
            expect(yield* deletedByVersion(v1)).toBe(true)
            expect(yield* deletedByVersion(v2)).toBe(true)
            expect(yield* exists(v3)).toBe(true)
            expect(yield* exists(scan)).toBe(true)
            expect((yield* db.entities.Docs.get({ docId: "d-1" })).body).toEqual(big(51))
            // Redelivered: idempotent.
            expect((yield* gc.reap(changed)).freed).toBe(1)

            // A REMOVE frees every version the row held: the family prefix empties.
            const family = familyPrefix("records/", {
              table: mainTable,
              pk: { S: pk },
              familySk: { S: docSk("doc") },
            })
            for (const ref of [v3, scan]) expect(ref.key.startsWith(family)).toBe(true)
            expect((yield* versionsUnder(family)).versions).toHaveLength(2)
            const removed = yield* recorded(
              mainTable,
              pk,
              db.entities.Docs.delete({ docId: "d-1" }),
            )
            expect(yield* gc.reap(removed)).toMatchObject({ candidates: 2, freed: 2 })
            expect(yield* versionsUnder(family)).toEqual({ versions: [], deleteMarkers: 0 })
          }),
        )
      },
    )
  })

  // -------------------------------------------------------------------------
  // GC
  // -------------------------------------------------------------------------

  describe("garbage collection", () => {
    it.effect(
      "sort-key composites: history-held versions kept by the reaper and the sweep, no sibling's freed",
      () => {
        const { store } = probed(s3Store("siblings/"))
        return using(store)(
          Effect.gen(function* () {
            yield* wallClock
            const db = yield* client
            const gc = yield* BlobGc.make({ entities: { Notes }, reaper: NO_GRACE })
            const pk = "$blob-e2e#v1#note#ownerid_o-1"
            const note = (noteId: string) => ({ ownerId: "o-1", noteId })
            // "n-1" and "n-10" share a sort-key prefix; "n-2" sorts after both.
            const writes: ReadonlyArray<{
              readonly asEffect: () => Effect.Effect<unknown, unknown>
            }> = [
              db.entities.Notes.put({ ...note("n-1"), title: "a", body: big(60) }),
              db.entities.Notes.put({ ...note("n-10"), title: "b", body: big(61) }),
              db.entities.Notes.put({ ...note("n-2"), title: "c", body: big(62) }),
              db.entities.Notes.update(note("n-1")).set({ title: "a2" }),
              db.entities.Notes.update(note("n-1")).set({ body: big(63) }),
              db.entities.Notes.update(note("n-10")).set({ body: big(64) }),
              db.entities.Notes.delete(note("n-1")),
            ]
            const records = (yield* Effect.forEach(writes, (write) =>
              Effect.orDie(recorded(mainTable, pk, write.asEffect())),
            )).flat()
            const rows = yield* rowsOf(mainTable, pk)
            const held = refsOfRows(rows)
            expect(held).toHaveLength(5)

            // The only candidate — n-1's last body, superseded by its delete — is
            // held by its tombstone and its last snapshot; every other record is
            // an INSERT or a retain live-row MODIFY.
            expect(yield* gc.reap(records)).toEqual({
              records: 13,
              candidates: 1,
              freed: 0,
              retained: 1,
              foreign: 0,
              skipped: 12,
            })
            for (const ref of held) expect(yield* exists(ref)).toBe(true)

            // n-10's history expires (as a TTL deletes it): the version only it held is freed.
            const tenLive = rows.find(
              (r) => r.noteId?.S === "n-10" && !/#(v|deleted)#/.test(r.sk!.S!),
            )!
            const tenHistory = rows.filter(
              (r) => r.noteId?.S === "n-10" && /#(v|deleted)#/.test(r.sk!.S!),
            )
            const onlyHistory = refsOfRows(tenHistory).filter(
              (ref) => !refsOfRows([tenLive]).some((live) => live.version === ref.version),
            )
            expect(onlyHistory).toHaveLength(1)
            const expired = yield* Effect.forEach(tenHistory, (row) => expire(mainTable, row))
            expect(yield* gc.reap(expired)).toMatchObject({ freed: 1 })
            expect(yield* deletedByVersion(onlyHistory[0]!)).toBe(true)
            for (const ref of held.filter((r) => r.version !== onlyHistory[0]!.version)) {
              expect(yield* exists(ref)).toBe(true)
            }

            // The deleted n-1's sweep: its live row is gone, its snapshots and
            // tombstone hold both its versions; n-10's rows are never its own.
            const oneRefs = refsOfRows(rows.filter((r) => r.noteId?.S === "n-1"))
            expect(oneRefs).toHaveLength(2)
            yield* TestClock.adjust(PAST_IN_FLIGHT)
            const sweep = gc.sweep("Notes", note("n-1"))
            const quiet = {
              referenced: 2,
              listed: 2,
              marked: 0,
              deleted: 0,
              retainedYoung: 0,
              foreign: 0,
              busy: false,
            }
            expect(yield* sweep).toEqual(quiet)
            yield* TestClock.adjust(PAST_GRACE)
            expect(yield* sweep).toEqual(quiet)
            expect(yield* gc.sweep("Notes", note("n-10"))).toMatchObject({
              referenced: 1,
              listed: 1,
              deleted: 0,
            })
            for (const ref of held.filter((r) => r.version !== onlyHistory[0]!.version)) {
              expect(yield* exists(ref)).toBe(true)
            }
            const restored = yield* db.entities.Notes.restore(note("n-1"))
            expect(restored.body).toEqual(big(63))
          }),
        )
      },
    )

    it.effect("two tables sharing the bucket never delete each other's versions", () => {
      const { store } = probed(s3Store("copies/"))
      return using(store)(
        Effect.gen(function* () {
          yield* wallClock
          const db = yield* client
          const copy = yield* copyClient
          const gcMain = yield* BlobGc.make({ entities: { Docs }, reaper: NO_GRACE })
          const gcCopy = yield* BlobGc.make({ entities: { CopyDocs }, reaper: NO_GRACE })
          yield* db.entities.Docs.put({ docId: "c-1", title: "t", body: big(70), scan: bytes(6) })
          const source = yield* liveDoc("doc", "c-1")
          // Copy the row as an import or a migration script would.
          const raw = yield* DynamoClient
          yield* raw.putItem({ TableName: copyTable, Item: source })
          expect((yield* copy.entities.CopyDocs.get({ docId: "c-1" })).body).toEqual(big(70))

          // The copy rewrites its body: a version under its own keys.
          const pk = docPk("doc", "c-1")
          const modified = yield* recorded(
            copyTable,
            pk,
            copy.entities.CopyDocs.update({ docId: "c-1" }).set({ body: big(71) }),
          )
          const copied = yield* liveDoc("doc", "c-1", copyTable)
          const sourceBody = yield* refOf(source.body)
          const sourceScan = yield* refOf(source.scan)
          const copyBody = yield* refOf(copied.body)
          expect(copyBody.key).not.toBe(sourceBody.key)
          expect(yield* refOf(copied.scan)).toEqual(sourceScan)
          // The copy's reaper: the superseded body is the source's — foreign.
          expect(yield* gcCopy.reap(modified)).toMatchObject({
            candidates: 0,
            freed: 0,
            foreign: 1,
          })
          expect(yield* exists(sourceBody)).toBe(true)
          // The main table's reaper fed the copy's record: another table's, skipped.
          expect(yield* gcMain.reap(modified)).toMatchObject({
            records: 1,
            candidates: 0,
            freed: 0,
            skipped: 1,
          })
          expect(yield* exists(sourceBody)).toBe(true)

          // Sweeps on both, two passes: each lists only its own versions.
          yield* TestClock.adjust(PAST_IN_FLIGHT)
          expect(yield* gcMain.sweep("Docs", { docId: "c-1" })).toMatchObject({
            referenced: 2,
            listed: 2,
            marked: 0,
            foreign: 0,
          })
          expect(yield* gcCopy.sweep("CopyDocs", { docId: "c-1" })).toMatchObject({
            referenced: 1,
            listed: 1,
            marked: 0,
            foreign: 1,
          })
          // sweepStore: the other table's families are foreign, named by their table.
          const families = (gc: typeof gcMain | typeof gcCopy) =>
            Effect.map(Stream.runCollect(gc.sweepStore()), (all) =>
              all.map((family) =>
                family._tag === "Foreign"
                  ? `Foreign:${Option.getOrElse(family.table, () => "?")}`
                  : family._tag === "Swept"
                    ? `Swept:${family.member}`
                    : family._tag,
              ),
            )
          expect(yield* families(gcMain)).toEqual(
            expect.arrayContaining(["Swept:Docs", `Foreign:${copyTable}`]),
          )
          expect(yield* families(gcCopy)).toEqual(
            expect.arrayContaining(["Swept:CopyDocs", `Foreign:${mainTable}`]),
          )
          yield* TestClock.adjust(PAST_GRACE)
          expect((yield* gcMain.sweep("Docs", { docId: "c-1" })).deleted).toBe(0)
          expect((yield* gcCopy.sweep("CopyDocs", { docId: "c-1" })).deleted).toBe(0)

          // The copy's row is deleted: its own body freed, the source's scan never,
          // whichever table's reaper the record reaches.
          const removed = yield* recorded(
            copyTable,
            pk,
            copy.entities.CopyDocs.delete({ docId: "c-1" }),
          )
          expect(yield* gcMain.reap(removed)).toMatchObject({ candidates: 0, freed: 0, skipped: 1 })
          expect(yield* gcCopy.reap(removed)).toMatchObject({ freed: 1, foreign: 1 })
          expect(yield* deletedByVersion(copyBody)).toBe(true)
          for (const ref of [sourceBody, sourceScan]) expect(yield* exists(ref)).toBe(true)
          const read = yield* db.entities.Docs.get({ docId: "c-1" }).offloaded("eager")
          expect(read).toMatchObject({ body: big(70), scan: bytes(6) })

          // Copied again and rewritten, then purged: the copy's family prefix
          // empties; the source's scan, which the copy's row names, is kept.
          yield* raw.putItem({ TableName: copyTable, Item: source })
          yield* copy.entities.CopyDocs.update({ docId: "c-1" }).set({ body: big(72) })
          const copyFamily = familyPrefix("copies/", {
            table: copyTable,
            pk: { S: pk },
            familySk: { S: docSk("doc") },
          })
          const recopied = yield* refOf((yield* liveDoc("doc", "c-1", copyTable)).body)
          expect(recopied.key.startsWith(copyFamily)).toBe(true)
          yield* copy.entities.CopyDocs.purge({ docId: "c-1" })
          expect(yield* rowsOf(copyTable, pk)).toEqual([])
          expect(yield* versionsUnder(copyFamily)).toEqual({ versions: [], deleteMarkers: 0 })
          for (const ref of [sourceBody, sourceScan]) expect(yield* exists(ref)).toBe(true)
          const kept = yield* db.entities.Docs.get({ docId: "c-1" }).offloaded("eager")
          expect(kept).toMatchObject({ body: big(70), scan: bytes(6) })
        }),
      )
    })

    it.effect(
      "a crashed rollback is reported, then swept in two passes with its mark a version tag",
      () => {
        const { store, probe } = probed(s3Store("rollback/"))
        const unsettled: Array<Offload.UnsettledUpload> = []
        const observer = Offload.layerObserver({
          onUnsettled: (upload) => Effect.sync(() => void unsettled.push(upload)),
        })
        return using(
          store,
          observer,
        )(
          Effect.gen(function* () {
            yield* wallClock
            const db = yield* client
            const gc = yield* BlobGc.make({ entities: { Docs } })
            yield* db.entities.Docs.put({ docId: "g-1", title: "t", body: big(80) })
            const live = yield* refOf((yield* liveDoc("doc", "g-1")).body)
            // A create over it fails; deleting its upload fails too.
            probe.failDeletes = true
            const refused = yield* Effect.flip(
              db.entities.Docs.create({ docId: "g-1", title: "t", body: big(81) }).asEffect(),
            )
            probe.failDeletes = false
            expect(refused._tag).toBe("ConditionalCheckFailed")
            expect(unsettled).toHaveLength(1)
            const leak = unsettled[0]!
            expect(leak).toMatchObject({
              reason: "rollbackFailed",
              table: mainTable,
              attribute: "body",
            })
            const leaked = Option.getOrThrow(leak.ref)
            expect(yield* exists(leaked)).toBe(true)

            // The application queues the item for a sweep.
            const sweep = gc.sweep("Docs", { docId: "g-1" })
            expect(yield* sweep).toEqual({
              referenced: 1,
              listed: 2,
              marked: 0,
              deleted: 0,
              retainedYoung: 1,
              foreign: 0,
              busy: false,
            })
            yield* TestClock.adjust(PAST_IN_FLIGHT)
            expect(yield* sweep).toMatchObject({ marked: 1, deleted: 0, retainedYoung: 0 })
            const markedAt = new Date(yield* Clock.currentTimeMillis).toISOString()
            expect(yield* tagsOf(leaked)).toEqual({ "edd-unref-since": markedAt })
            expect(yield* tagsOf(live)).toEqual({})
            // Marked less than the grace ago: kept.
            yield* TestClock.adjust("23 hours")
            expect(yield* sweep).toMatchObject({ marked: 0, deleted: 0 })
            expect(yield* exists(leaked)).toBe(true)
            yield* TestClock.adjust("2 hours")
            expect(yield* sweep).toMatchObject({ marked: 0, deleted: 1 })
            expect(yield* deletedByVersion(leaked)).toBe(true)
            expect(yield* exists(live)).toBe(true)
            expect((yield* versionsUnder(leaked.key)).deleteMarkers).toBe(0)
            expect((yield* db.entities.Docs.get({ docId: "g-1" })).body).toEqual(big(80))
          }),
        )
      },
    )

    it.effect(
      "sweepStore over the bucket: every member kind swept, foreign objects skipped, resumable",
      () => {
        const { store } = probed(s3Store("store/"))
        const LONG = "the quick brown fox jumps over the lazy dog; ".repeat(20)
        return using(store)(
          Effect.gen(function* () {
            yield* wallClock
            const db = yield* client
            const copy = yield* copyClient
            const gc = yield* BlobGc.make({
              entities: { Docs, Readings },
              aggregates: { Matches },
              streams: { Cases },
            })
            // An entity: its first body superseded.
            yield* db.entities.Docs.put({ docId: "s-1", title: "t", body: big(90) })
            const d1 = yield* refOf((yield* liveDoc("doc", "s-1")).body)
            yield* db.entities.Docs.update({ docId: "s-1" }).set({ body: big(91) })
            // A time series: objects keyed per event row; the first event expires.
            yield* db.entities.Readings.append({ sensorId: "s-2", at: 1, raw: bytes(16, 1) })
            const readingPk = "$blob-e2e#v1#reading#sensorid_s-2"
            const firstEvent = (yield* rowsOf(mainTable, readingPk)).find((r) =>
              /#e#/.test(r.sk!.S!),
            )!
            const r1 = yield* refOf(firstEvent.raw)
            yield* db.entities.Readings.append({ sensorId: "s-2", at: 2, raw: bytes(16, 2) })
            yield* expire(mainTable, firstEvent)
            // An aggregate edge: its first plan superseded.
            yield* Matches.create({
              matchId: "m-2",
              name: "Semi",
              venue: { venueId: "v-2", name: "Dome", plan: bytes(300, 1) },
            })
            const matchPk = composeCollectionKey(AppSchema, "match", ["m-2"])
            const edgePlan = () =>
              Effect.flatMap(rowsOf(mainTable, matchPk), (rows) =>
                refOf(rows.find((row) => row.__edd_e__?.S === "MatchVenue")?.plan),
              )
            const p1 = yield* edgePlan()
            yield* Matches.update({ matchId: "m-2" }, ({ state }) => ({
              ...state,
              venue: { ...state.venue, plan: bytes(300, 2) },
            }))
            // A stream: its first snapshot state superseded.
            const id = { caseId: "c-2" }
            yield* Cases.append(id, [new Filed({ note: LONG })], 0, { snapshot: { notes: [LONG] } })
            const casePk = "$blob-e2e#v1#case#c-2"
            const snapshotState = () =>
              Effect.flatMap(rowsOf(eventsTable, casePk), (rows) =>
                refOf(rows.find((row) => row.__edd_e__?.S === "case.snapshot")?.state),
              )
            const s1 = yield* snapshotState()
            yield* Cases.append(id, [new Filed({ note: LONG })], 1, {
              snapshot: { notes: [LONG, LONG] },
            })
            // Another table's family, objects the library did not write, a non-library key.
            yield* copy.entities.CopyDocs.put({ docId: "s-3", title: "t", body: big(92) })
            const foreignKey = `store/${"a".repeat(32)}/${"b".repeat(32)}/${"c".repeat(32)}`
            yield* send(new PutObjectCommand({ Bucket: bucket, Key: foreignKey, Body: "{}" }))
            yield* send(new PutObjectCommand({ Bucket: bucket, Key: "store/README", Body: "hi" }))

            const run = (options?: BlobGc.SweepStoreOptions) =>
              Stream.runCollect(gc.sweepStore(options))
            const summary = (families: ReadonlyArray<BlobGc.StoreSweepFamily>) =>
              families.map((family) =>
                family._tag === "Swept"
                  ? { member: family.member, report: family.report }
                  : family._tag === "Foreign"
                    ? { foreign: Option.getOrElse(family.table, () => "unknown") }
                    : { unattributable: family.versions },
              )
            yield* TestClock.adjust(PAST_IN_FLIGHT)
            const first = yield* run()
            expect(first).toHaveLength(6)
            expect(summary(first)).toEqual(
              expect.arrayContaining([
                {
                  member: "Docs",
                  report: expect.objectContaining({ referenced: 1, listed: 2, marked: 1 }),
                },
                {
                  member: "Readings",
                  report: expect.objectContaining({ referenced: 1, listed: 2, marked: 1 }),
                },
                {
                  member: "Matches",
                  report: expect.objectContaining({ referenced: 1, listed: 2, marked: 1 }),
                },
                {
                  member: "Cases",
                  report: expect.objectContaining({ referenced: 3, listed: 4, marked: 1 }),
                },
                { foreign: copyTable },
                { foreign: "unknown" },
              ]),
            )
            // Resumable: a bounded run, then the rest after its last family.
            const head = yield* run({ maxFamilies: 2 })
            const rest = yield* run({ startAfter: head[1]!.familyPrefix })
            expect([...head, ...rest].map((f) => f.familyPrefix)).toEqual(
              first.map((f) => f.familyPrefix),
            )

            yield* TestClock.adjust(PAST_GRACE)
            const second = yield* run()
            const deleted = Object.fromEntries(
              second.flatMap((f) => (f._tag === "Swept" ? [[f.member, f.report.deleted]] : [])),
            )
            expect(deleted).toEqual({ Docs: 1, Readings: 1, Matches: 1, Cases: 1 })
            for (const ref of [d1, r1, p1, s1]) expect(yield* deletedByVersion(ref)).toBe(true)
            expect((yield* versionsUnder(foreignKey)).versions).toHaveLength(1)
            expect((yield* versionsUnder("store/README")).versions).toHaveLength(1)
            // Every live value still reads.
            expect((yield* db.entities.Docs.get({ docId: "s-1" })).body).toEqual(big(91))
            const reading = yield* db.entities.Readings.get({ sensorId: "s-2" }).offloaded("eager")
            expect(reading.raw).toEqual(bytes(16, 2))
            expect((yield* Matches.get({ matchId: "m-2" })).venue.plan).toEqual(bytes(300, 2))
            const latest = yield* Cases.readLatest(id)
            expect(latest.snapshot.pipe(Option.map((s) => s.state))).toEqual(
              Option.some({ notes: [LONG, LONG] }),
            )
            expect((yield* copy.entities.CopyDocs.get({ docId: "s-3" })).body).toEqual(big(92))
            // The edge's objects are under the aggregate's partition prefix.
            expect(
              p1.key.startsWith(
                partitionPrefix("store/", { table: mainTable, pk: { S: matchPk } }),
              ),
            ).toBe(true)
          }),
        )
      },
    )

    it.effect(
      "purge empties the item's family prefix; a create racing it keeps its version",
      () => {
        const { store } = probed(s3Store("purge/"))
        return using(store)(
          Effect.gen(function* () {
            yield* wallClock
            const db = yield* client
            const key = { docId: "p-1" }
            yield* db.entities.Kept.put({ ...key, title: "t", body: big(100), scan: bytes(5, 1) })
            yield* db.entities.Kept.update(key).set({ body: big(101) })
            yield* db.entities.Kept.update(key).set({ body: big(102) })
            yield* db.entities.Kept.delete(key)
            const family = familyPrefix("purge/", {
              table: mainTable,
              pk: { S: docPk("kept", "p-1") },
              familySk: { S: docSk("kept") },
            })
            // A version no row names (a write whose request never landed), old enough to settle.
            const stray = yield* store.put({
              key: `${family}${"0".repeat(32)}`,
              body: new TextEncoder().encode("{}"),
              contentLength: 2,
              checksum: Effect.succeed({
                algorithm: "crc64nvme",
                value: crc64nvme(new TextEncoder().encode("{}")),
              }),
              contentType: "application/json",
              metadata: { "edd-v": "1" },
            })
            expect((yield* versionsUnder(family)).versions).toHaveLength(5)
            yield* TestClock.adjust("2 hours")

            // A writer re-creates the item between the row deletes and the store step.
            afterBatchWrite.push(
              Effect.orDie(
                db.entities.Kept.put({ ...key, title: "again", body: big(103) }).asEffect(),
              ),
            )
            yield* db.entities.Kept.purge(key)
            expect(afterBatchWrite).toHaveLength(0)
            const kept = (yield* versionsUnder(family)).versions
            expect(kept).toHaveLength(1)
            expect(yield* deletedByVersion(stray.ref)).toBe(true)
            expect(yield* refOf((yield* liveDoc("kept", "p-1")).body)).toEqual(kept[0])
            expect((yield* db.entities.Kept.get(key)).body).toEqual(big(103))

            // Purged again, with nothing racing it: the family prefix is empty.
            yield* db.entities.Kept.purge(key)
            expect(yield* rowsOf(mainTable, docPk("kept", "p-1"))).toEqual([])
            expect(yield* versionsUnder(family)).toEqual({ versions: [], deleteMarkers: 0 })
          }),
        )
      },
    )
  })

  // -------------------------------------------------------------------------
  // Key text (design §11.10)
  // -------------------------------------------------------------------------

  describe("key text", () => {
    const ticketPk = (ticketNo: number, schema: DynamoSchema.DynamoSchema) =>
      KeyComposer.composePk(schema, "Ticket", Tickets.indexes.primary, { ticketNo })
    const ticketRows = (ticketNo: number) => rowsOf(keysTable, ticketPk(ticketNo, AppSchema))

    it.effect(
      "an offloading member without escapeKeys: refused at bind and where an unbound write routes",
      () => {
        const { store, probe } = probed(s3Store("keys/refused/"))
        const unescaped = UnescapedKeysTable.layer({ name: keysTable })
        return using(store)(
          Effect.gen(function* () {
            const made = yield* Effect.exit(
              DynamoClient.make({
                entities: { UnescapedTickets },
                tables: { UnescapedKeysTable },
              }).pipe(Effect.provide(unescaped)),
            )
            expect(Exit.isFailure(made)).toBe(true)
            expect(Cause.pretty((made as Exit.Failure<unknown, unknown>).cause)).toContain(
              '[EDD-9146] DynamoClient.make: entity "UnescapedTickets" offloads',
            )

            const error = yield* Effect.flip(
              UnescapedTickets.put({ ticketNo: 7, title: "t", body: big(130) })
                .asEffect()
                .pipe(Effect.provide(unescaped)),
            )
            expect(error).toBeInstanceOf(ValidationError)
            expect(String((error as ValidationError).cause)).toContain(
              '[EDD-9146] Entity.put: Ticket offloads "body"',
            )
            // Nothing uploaded, nothing written.
            expect(probe.calls.put).toBe(0)
            expect(yield* versionsUnder("keys/refused/")).toEqual({
              versions: [],
              deleteMarkers: 0,
            })
            for (const schema of [AppSchema, UnescapedSchema]) {
              expect(yield* rowsOf(keysTable, ticketPk(7, schema))).toEqual([])
            }
          }),
        )
      },
    )

    it.effect(
      "rekey moves no pointer row: nothing under escaped text, a refusal with escapeKeys turned off",
      () => {
        const { store } = probed(s3Store("keys/rekey/"))
        return using(store)(
          Effect.gen(function* () {
            const db = yield* keysClient
            yield* db.entities.Tickets.put({
              ticketNo: -1,
              title: "t",
              body: big(131),
              scan: bytes(900, 1),
            })
            // Escaped (numeric) text and the text escapeKeys off composes differ.
            expect(ticketPk(-1, AppSchema)).not.toBe(ticketPk(-1, UnescapedSchema))
            const held = yield* ticketRows(-1)
            expect(held).toHaveLength(1)
            const refs = refsOfRows(held)
            expect(refs).toHaveLength(2)

            // Under the setting offloading wrote with, every row is current.
            const report = yield* db.tables.KeysTable.rekey()
            expect(report.conflicts).toEqual([])
            expect(Object.values(report.moved).every((n) => n === 0)).toBe(true)
            expect(yield* ticketRows(-1)).toEqual(held)

            // escapeKeys turned off: the row would move, and it holds pointers.
            const plain = yield* DynamoClient.make({
              entities: { PlainTickets },
              tables: { PlainKeysTable },
            }).pipe(Effect.provide(PlainKeysTable.layer({ name: keysTable })))
            for (const dryRun of [true, false]) {
              const error = yield* Effect.flip(plain.tables.PlainKeysTable.rekey({ dryRun }))
              expect(error).toBeInstanceOf(ValidationError)
              const cause = String((error as ValidationError).cause)
              expect(cause).toContain("[EDD-9146]")
              expect(cause).toContain("holds a blob pointer")
              expect(cause).toContain(JSON.stringify(held[0]!.pk!.S!).slice(1, -1))
            }
            // The row is where it was, as it was, and both versions remain.
            expect(yield* ticketRows(-1)).toEqual(held)
            expect(yield* rowsOf(keysTable, ticketPk(-1, UnescapedSchema))).toEqual([])
            for (const ref of refs) expect(yield* exists(ref)).toBe(true)
            const ticket = yield* db.entities.Tickets.get({ ticketNo: -1 }).offloaded("eager")
            expect(ticket).toMatchObject({ body: big(131), scan: bytes(900, 1) })
          }),
        )
      },
      30000,
    )
  })

  // -------------------------------------------------------------------------
  // PartiQL insert (design §6.2)
  // -------------------------------------------------------------------------

  describe("insert()", () => {
    it.effect(
      "uploads as put does and reads its values back; a duplicate's upload is deleted",
      () => {
        const { store, probe } = probed(s3Store("insert/plain/"))
        return using(store)(
          Effect.gen(function* () {
            const db = yield* client
            const body = big(140)
            const scan = bytes(2_000, 4)
            const doc = yield* db.entities.Docs.insert({
              docId: "i-1",
              title: "t",
              body,
              scan,
            }).offloaded("eager")
            expect(doc.body).toEqual(body)
            expect(sameBytes(doc.scan!, scan)).toBe(true)
            expect(probe.calls.put).toBe(2)
            const row = yield* liveDoc("doc", "i-1")
            expect(isOverflowPointer(row.body)).toBe(true)
            expect(isBinaryPointer(row.scan)).toBe(true)
            const refs = refsOfRows([row])
            for (const ref of refs) expect(yield* exists(ref)).toBe(true)
            expect((yield* versionsUnder("insert/plain/")).versions).toHaveLength(2)

            // A duplicate item, sent once: DynamoDB provably wrote nothing, so the upload goes.
            const error = yield* Effect.flip(
              db.entities.Docs.insert({ docId: "i-1", title: "again", body: big(141) }).asEffect(),
            )
            expect(error._tag).toBe("ItemAlreadyExists")
            expect(probe.calls.put).toBe(3)
            expect(probe.calls.delete).toBe(1)
            expect((yield* versionsUnder("insert/plain/")).versions).toEqual(
              expect.arrayContaining(refs),
            )
            expect(yield* versionsUnder("insert/plain/")).toMatchObject({ deleteMarkers: 0 })
            expect((yield* versionsUnder("insert/plain/")).versions).toHaveLength(2)
            expect((yield* db.entities.Docs.get({ docId: "i-1" })).body).toEqual(body)
          }),
        )
      },
    )

    it.effect(
      "a unique-constrained insert is an ExecuteTransaction: a taken value rolls its upload back",
      () => {
        const { store, probe } = probed(s3Store("insert/unique/"))
        return using(store)(
          Effect.gen(function* () {
            const db = yield* client
            const first = yield* db.entities.Badges.insert({
              badgeId: "b-1",
              email: "a@example.com",
              body: big(150),
            })
            expect(first.body).toEqual(big(150))
            const kept = (yield* versionsUnder("insert/unique/")).versions
            expect(kept).toHaveLength(1)

            const error = yield* Effect.flip(
              db.entities.Badges.insert({
                badgeId: "b-2",
                email: "a@example.com",
                body: big(151),
              }).asEffect(),
            )
            expect(error._tag).toBe("UniqueConstraintViolation")
            expect(probe.calls.put).toBe(2)
            expect(probe.calls.delete).toBe(1)
            expect(yield* versionsUnder("insert/unique/")).toEqual({
              versions: kept,
              deleteMarkers: 0,
            })
            expect((yield* db.entities.Badges.get({ badgeId: "b-1" })).body).toEqual(big(150))
          }),
        )
      },
    )
  })
})
