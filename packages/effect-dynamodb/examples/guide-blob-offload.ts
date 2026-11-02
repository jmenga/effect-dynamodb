/**
 * Offloaded Storage Guide Example — effect-dynamodb
 *
 * Demonstrates offloading large and binary attribute values to a versioned
 * blob store (S3):
 *   - An overflow field (`DynamoModel.Packed({ external })`: inline below its
 *     threshold, in the store at or above it) and a binary field
 *     (`DynamoModel.External()`: always in the store), plus an item budget
 *   - The S3 store layer (`effect-dynamodb/blob/s3`) with `maxUploadAge`, a
 *     presigner, and the unsettled-upload observer
 *   - Escaped key text (`escapeKeys: true`), which offloading requires
 *   - Writes from bytes and from a Stream (`Offload.source`), and `insert()`
 *   - Lazy handles: read, ranged read, stream, presigned URL
 *   - Read modes (`.offloaded(...)`) and a projection that fetches nothing
 *   - `Entity.decodeStreamRecord`: change classification without a store read
 *   - Garbage collection (`BlobGc`): the reaper, the two-pass sweep,
 *     `sweepStore`, and `purge`
 *
 * The program runs against MinIO through the S3 store when `S3_ENDPOINT` is
 * set (it creates and removes its own versioned bucket), and against the
 * in-memory store otherwise. DynamoDB Local has no stream trigger, so the
 * stream records are built from the items read back before and after a
 * write, in the shape Lambda delivers them. GC passes that must happen later
 * (after the reaper grace, a day apart) run on a clock moved forward.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   optional: docker run -p 9000:9000 cgr.dev/chainguard/minio server /data
 *
 * Run (DYNAMODB_ENDPOINT overrides the default http://localhost:8000; set
 * S3_ENDPOINT, e.g. http://localhost:9000, to use MinIO):
 *   npx tsx examples/guide-blob-offload.ts
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListObjectVersionsCommand,
  PutBucketVersioningCommand,
  S3Client,
} from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
import {
  Clock,
  Config,
  Console,
  Duration,
  Effect,
  Layer,
  Option,
  Schema,
  Stream,
} from "effect"
import { Base64 } from "effect/encoding"

// Import from source (use "effect-dynamodb" and "effect-dynamodb/blob/s3" when published)
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import * as BlobGc from "../src/BlobGc.js"
import { BlobStore } from "../src/BlobStore.js"
import * as S3BlobStore from "../src/blob/s3.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import { toAttributeMap } from "../src/Marshaller.js"
import * as Offload from "../src/Offload.js"
import * as StorageEncoding from "../src/StorageEncoding.js"
import * as Table from "../src/Table.js"

const assertEq = <T>(actual: T, expected: T, label: string): void => {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`Assertion failed [${label}]: expected ${e}, got ${a}`)
}

const assert = (condition: boolean, label: string): void => {
  if (!condition) throw new Error(`Assertion failed [${label}]`)
}

const stamp = Date.now()
const TABLE_NAME = `blob-offload-demo-${stamp}`
const BUCKET = `edd-blob-offload-demo-${stamp}`
// #region schema
// Offloading requires escaped key text: objects are named after their row's key
const AppSchema = DynamoSchema.make({ name: "blob-demo", version: 1, escapeKeys: true })
// #endregion

// =============================================================================
// 1. Model — an overflow field and a binary field
// =============================================================================

// #region model
class Body extends Schema.Class<Body>("Body")({
  text: Schema.String,
  words: Schema.Number,
}) {}

class Document extends Schema.Class<Document>("Document")({
  docId: Schema.String,
  owner: Schema.String,
  title: Schema.String,
  body: Body,
  scan: Schema.Uint8Array,
}) {}

const DocumentModel = DynamoModel.configure(Document, {
  // Overflow field: JSON inline (S) below 16 KiB stored, in the blob store at or above it
  body: {
    storedAs: DynamoModel.Packed({ format: "json", external: { threshold: 16_384 } }),
  },
  // Binary field: always in the blob store, with this Content-Type
  scan: { storedAs: DynamoModel.External({ contentType: "application/pdf" }) },
})
// #endregion

// #region entity
const Documents = Entity.make({
  model: DocumentModel,
  entityType: "Document",
  primaryKey: {
    pk: { field: "pk", composite: ["docId"] },
    sk: { field: "sk", composite: [] },
  },
  indexes: {
    byOwner: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["owner"] },
      sk: { field: "gsi1sk", composite: ["docId"] },
    },
  },
  // Offload overflow fields, largest first, until the stored item fits 300,000 bytes
  offload: { itemBudget: 300_000 },
})
// #endregion

const MainTable = Table.make({ schema: AppSchema, entities: { Documents } })

// =============================================================================
// 2. Layers — the S3 store, the observer
// =============================================================================

// #region layers
// The S3 store (effect-dynamodb/blob/s3) on a bucket with versioning enabled.
// Here it is configured for MinIO; on AWS, omit endpoint and forcePathStyle.
const S3Layer = S3BlobStore.layerConfig({
  bucket: Config.String("BLOB_BUCKET").pipe(Config.withDefault(BUCKET)),
  prefix: Config.succeed("demo/"),
  endpoint: Config.String("S3_ENDPOINT"),
  forcePathStyle: Config.succeed(true),
  region: Config.succeed("us-east-1"),
  credentials: Config.all({
    accessKeyId: Config.String("S3_ACCESS_KEY_ID").pipe(Config.withDefault("minioadmin")),
    secretAccessKey: Config.String("S3_SECRET_ACCESS_KEY").pipe(Config.withDefault("minioadmin")),
  }),
  // Writers and GC must agree on it: an upload older than this never reaches DynamoDB
  maxUploadAge: Config.succeed(Duration.hours(1)),
  // BlobHandle.presignedUrl, through @aws-sdk/s3-request-presigner
  presign: { getSignedUrl },
})

// Every upload the library could not settle: queue its item for gc.sweep
const ObserverLayer = Offload.layerObserver({
  onUnsettled: (upload) =>
    Console.log(`unsettled (${upload.reason}): ${upload.table} ${JSON.stringify(upload.rowKey)}`),
})
// #endregion

// #region memory-layer
// In tests (or without an S3 endpoint): the in-memory store, with presigning
const MemoryLayer = BlobStore.layerMemory({ presign: true })
// #endregion

const settings = Config.all({
  dynamodb: Config.String("DYNAMODB_ENDPOINT").pipe(Config.withDefault("http://localhost:8000")),
  s3: Config.option(Config.String("S3_ENDPOINT")),
  accessKeyId: Config.String("S3_ACCESS_KEY_ID").pipe(Config.withDefault("minioadmin")),
  secretAccessKey: Config.String("S3_SECRET_ACCESS_KEY").pipe(Config.withDefault("minioadmin")),
})

const ClientLayer = DynamoClient.layerConfig({
  region: Config.succeed("us-east-1"),
  endpoint: Config.String("DYNAMODB_ENDPOINT").pipe(Config.withDefault("http://localhost:8000")),
  credentials: Config.succeed({ accessKeyId: "local", secretAccessKey: "local" }),
})

/** MinIO through the S3 store when S3_ENDPOINT is set, else the in-memory store. */
const BlobLayer = Layer.unwrap(
  Effect.gen(function* () {
    const { s3 } = yield* settings
    return Option.isSome(s3) ? S3Layer : MemoryLayer
  }),
)

const AppLayer = Layer.mergeAll(
  ClientLayer,
  BlobLayer,
  ObserverLayer,
  MainTable.layer({ name: TABLE_NAME }),
)

// =============================================================================
// 3. Helpers (not shown in the guide)
// =============================================================================

/** The admin S3 client for MinIO, when S3_ENDPOINT is set. */
const adminClient = Effect.gen(function* () {
  const { s3, accessKeyId, secretAccessKey } = yield* settings
  return Option.map(
    s3,
    (endpoint) =>
      new S3Client({
        endpoint,
        region: "us-east-1",
        forcePathStyle: true,
        credentials: { accessKeyId, secretAccessKey },
      }),
  )
})

const s3Call = <A>(what: string, run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new Error(`${what}: ${String(cause)}`) })

/** A versioned bucket for the demo: the library never creates one. */
const createBucket = (admin: S3Client) =>
  Effect.gen(function* () {
    yield* s3Call("CreateBucket", () => admin.send(new CreateBucketCommand({ Bucket: BUCKET })))
    yield* s3Call("PutBucketVersioning", () =>
      admin.send(
        new PutBucketVersioningCommand({
          Bucket: BUCKET,
          VersioningConfiguration: { Status: "Enabled" },
        }),
      ),
    )
  })

/** Every version of every key, then the bucket. */
const deleteBucket = (admin: S3Client) =>
  Effect.gen(function* () {
    const listed = yield* s3Call("ListObjectVersions", () =>
      admin.send(new ListObjectVersionsCommand({ Bucket: BUCKET })),
    )
    const objects = [...(listed.Versions ?? []), ...(listed.DeleteMarkers ?? [])].map((v) => ({
      Key: v.Key!,
      VersionId: v.VersionId!,
    }))
    if (objects.length > 0) {
      yield* s3Call("DeleteObjects", () =>
        admin.send(new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: objects } })),
      )
    }
    yield* s3Call("DeleteBucket", () => admin.send(new DeleteBucketCommand({ Bucket: BUCKET })))
  })

const documentKey = (docId: string) => ({
  pk: `$blob-demo#v1#document#docid_${docId}`,
  sk: "$blob-demo#v1#document",
})

/** The raw stored item, straight from DynamoDB. */
const rawItem = (docId: string) =>
  Effect.gen(function* () {
    const client = yield* DynamoClient
    const result = yield* client.getItem({
      TableName: TABLE_NAME,
      Key: toAttributeMap(documentKey(docId)),
      ConsistentRead: true,
    })
    return result.Item as Record<string, AttributeValue>
  })

/** An AttributeValue map in the shape Lambda delivers it: B as base64. */
const toLambdaImage = (item: Record<string, AttributeValue>): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(item).map(([name, value]) => [
      name,
      value.B !== undefined ? { B: Base64.encode(value.B) } : value,
    ]),
  )

/** A NEW_AND_OLD_IMAGES record of the demo table, as a Lambda trigger delivers it. */
const streamRecord = (
  eventName: "INSERT" | "MODIFY" | "REMOVE",
  oldItem: Record<string, AttributeValue> | undefined,
  newItem: Record<string, AttributeValue> | undefined,
  at: number,
) => {
  const keys = (oldItem ?? newItem)!
  return {
    eventName,
    eventSourceARN: `arn:aws:dynamodb:us-east-1:000000000000:table/${TABLE_NAME}/stream/2026-11-02T00:00:00.000`,
    dynamodb: {
      Keys: toLambdaImage({ pk: keys.pk!, sk: keys.sk! }),
      ...(oldItem === undefined ? {} : { OldImage: toLambdaImage(oldItem) }),
      ...(newItem === undefined ? {} : { NewImage: toLambdaImage(newItem) }),
      StreamViewType: "NEW_AND_OLD_IMAGES",
      ApproximateCreationDateTime: Math.floor(at / 1000),
    },
  }
}

/**
 * Run `effect` on a clock moved `by` ahead of the wall clock — the demo's
 * "15 minutes later" and "a day later" for GC passes. Sleeps stay real.
 */
const later =
  (by: Duration.Input) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Clock.clockWith((clock) => {
      const ms = Duration.toMillis(Duration.fromInputUnsafe(by))
      const nanos = BigInt(ms) * 1_000_000n
      const shifted: Clock.Clock = {
        currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe() + ms,
        currentTimeMillis: Effect.map(clock.currentTimeMillis, (now) => now + ms),
        currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe() + nanos,
        currentTimeNanos: Effect.map(clock.currentTimeNanos, (now) => now + nanos),
        monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
        monotonicTimeNanos: clock.monotonicTimeNanos,
        sleep: (duration) => clock.sleep(duration),
      }
      return Effect.provideService(effect, Clock.Clock, shifted)
    })

/** Deterministic, hard-to-compress text of about `bytes` bytes. */
const textOf = (bytes: number, seed: number): string => {
  let state = seed
  const words: Array<string> = []
  let length = 0
  while (length < bytes) {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648
    const word = state.toString(36)
    words.push(word)
    length += word.length + 1
  }
  return words.join(" ")
}

const bodyOf = (bytes: number, seed: number) => {
  const text = textOf(bytes, seed)
  return new Body({ text, words: text.split(" ").length })
}

const pdfBytes = (size: number) => {
  const bytes = new Uint8Array(size)
  bytes.set([0x25, 0x50, 0x44, 0x46]) // %PDF
  for (let i = 4; i < size; i++) bytes[i] = (i * 31) % 251
  return bytes
}

// =============================================================================
// 4. Program
// =============================================================================

const program = Effect.gen(function* () {
  const client = yield* DynamoClient
  yield* client.createTable({
    TableName: TABLE_NAME,
    BillingMode: "PAY_PER_REQUEST",
    ...Table.definition(MainTable),
  })

  const db = yield* DynamoClient.make({
    entities: { Documents },
    tables: { MainTable },
  })

  // ---------------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------------

  // #region put
  // The body (about 20 KB of JSON) is at its threshold or over: uploaded, then the
  // item is written holding a pointer to that exact object version.
  // The scan always goes to the store.
  yield* db.entities.Documents.put({
    docId: "d-1",
    owner: "ada",
    title: "Quarterly report",
    body: bodyOf(20_000, 1),
    scan: pdfBytes(300_000),
  })

  // A small body stays inline, as packed JSON
  yield* db.entities.Documents.put({
    docId: "d-2",
    owner: "ada",
    title: "Note",
    body: new Body({ text: "short", words: 1 }),
    scan: pdfBytes(1_000),
  })
  // #endregion

  // #region insert
  // insert() — a PartiQL INSERT, refused when the item exists — uploads as put does
  const memo = yield* db.entities.Documents.insert({
    docId: "d-4",
    owner: "lin",
    title: "Memo",
    body: bodyOf(18_000, 4),
    scan: pdfBytes(2_000),
  })
  // memo.body → the Body written, read back from the upload without a GET
  // #endregion
  assertEq(memo.body.words, bodyOf(18_000, 4).words, "insert reads its body back")

  // #region stored-form
  // What the item holds: pointers, read without touching the store
  const stored = yield* rawItem("d-1")
  const bodyPointer = StorageEncoding.pointer(stored.body!) // Option<BlobPointer>, a B value
  const scanPointer = StorageEncoding.pointer(stored.scan!) // the S text "~edbp:…"
  // bodyPointer.value → { kind: "json", ref: { key, version }, contentSize, checksum, … }
  // #endregion
  assert(Option.isSome(bodyPointer) && Option.isSome(scanPointer), "both offloaded")
  assert(stored.scan!.S!.startsWith("~edbp:"), "binary pointer is S text")
  assertEq(Option.getOrThrow(bodyPointer).kind, "json", "body pointer kind")
  assertEq(Option.getOrThrow(scanPointer).contentType, Option.some("application/pdf"), "scan type")
  assert(
    Option.isNone(StorageEncoding.pointer((yield* rawItem("d-2")).body!)),
    "small body inline",
  )
  yield* Console.log(
    `d-1: body ${Option.getOrThrow(bodyPointer).contentSize} bytes and scan ` +
      `${Option.getOrThrow(scanPointer).contentSize} bytes offloaded`,
  )

  // #region put-stream
  // A binary field also takes a Stream of bytes: single-use, uploaded once
  // (multipart above the store's part size), never buffered whole
  const chunks = [pdfBytes(64_000), pdfBytes(64_000), pdfBytes(64_000)]
  yield* db.entities.Documents.put({
    docId: "d-3",
    owner: "grace",
    title: "Scanned contract",
    body: new Body({ text: "contract", words: 1 }),
    scan: Offload.source(Stream.fromIterable(chunks), {
      contentType: "application/pdf",
      contentLength: 192_000,
    }),
  })
  // #endregion

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  // #region lazy-handles
  // Defaults: overflow fields eager (the value), binary fields lazy (a BlobHandle)
  const doc = yield* db.entities.Documents.get({ docId: "d-1" })
  const words = doc.body.words // fetched and verified with the item

  const scan = doc.scan // BlobHandle: nothing fetched yet
  const header = yield* scan.read({ range: { offset: 0, length: 4 } }) // %PDF
  const all = yield* scan.read() // the whole object, verified by size and checksum
  const streamed = yield* Stream.runFold(scan.stream(), () => 0, (n, chunk) => n + chunk.length)
  const url = yield* scan.presignedUrl({ expiresIn: "5 minutes" })
  // #endregion
  assertEq(words, bodyOf(20_000, 1).words, "eager body")
  assertEq([...header], [0x25, 0x50, 0x44, 0x46], "ranged read")
  assertEq(all.length, 300_000, "full read")
  assertEq(streamed, 300_000, "streamed read")
  assertEq(scan.contentType, "application/pdf", "handle content type")
  assert(url.length > 0, "presigned url")
  yield* Console.log(`d-1: scan read ${all.length} bytes; presigned ${url.slice(0, 32)}…`)

  // #region modes
  // Both kinds eager: scan is the Uint8Array itself
  const eager = yield* db.entities.Documents.get({ docId: "d-1" }).offloaded("eager")
  const bytes: Uint8Array = eager.scan

  // Both kinds lazy: body is an OffloadedValue<Body>, fetched only on read()
  const lazy = yield* db.entities.Documents.byOwner({ owner: "ada" }).offloaded("lazy").collect()
  const firstBody = yield* lazy[0]!.body.read()

  // One kind: binary eager, overflow at its default (eager)
  const withScan = yield* db.entities.Documents.get({ docId: "d-3" }).offloaded({
    binary: "eager",
  })

  // A projection that omits the offloaded fields never fetches them
  const titles = yield* db.entities.Documents.byOwner({ owner: "ada" })
    .select(["docId", "title"])
    .collect()
  // #endregion
  assertEq(bytes.length, 300_000, "eager scan")
  assertEq(firstBody.words, bodyOf(20_000, 1).words, "lazy body read")
  assertEq(withScan.scan.length, 192_000, "streamed scan stored whole")
  assertEq(
    titles.map((row) => row.title),
    ["Quarterly report", "Note"],
    "projection",
  )

  // #region update-one-field
  // Only what a write names is uploaded: this update writes no object
  yield* db.entities.Documents.update({ docId: "d-1" }).set({ title: "Q3 report" })

  // Restating a field uploads it again as a new version, even with the same content
  yield* db.entities.Documents.update({ docId: "d-1" }).set({ body: bodyOf(24_000, 2) })
  // #endregion

  // ---------------------------------------------------------------------------
  // Stream records
  // ---------------------------------------------------------------------------

  const beforeChange = yield* rawItem("d-1")
  const changedAt = yield* Clock.currentTimeMillis
  yield* db.entities.Documents.update({ docId: "d-1" }).set({ body: bodyOf(26_000, 3) })
  const afterChange = yield* rawItem("d-1")
  const record = streamRecord("MODIFY", beforeChange, afterChange, changedAt)

  // #region decode-stream-record
  // A NEW_AND_OLD_IMAGES record, as Lambda, EventBridge Pipes or the change feed deliver it
  const change = yield* Entity.decodeStreamRecord(Documents, record)
  if (Option.isSome(change) && change.value.offloaded.body !== "unchanged") {
    // offloaded → { body: "changed", scan: "unchanged" }, decided from the two
    // pointers alone. Items are lazy by default: the new body is fetched only here.
    const { newItem } = change.value
    const newBody = Option.isSome(newItem) ? yield* newItem.value.body.read() : undefined
  }
  // #endregion
  const decoded = Option.getOrThrow(change)
  assertEq(decoded.offloaded, { body: "changed", scan: "unchanged" }, "classification")
  const oldBody = Option.getOrThrow(decoded.oldItem).body

  // ---------------------------------------------------------------------------
  // Garbage collection
  // ---------------------------------------------------------------------------

  // #region gc
  const gc = yield* BlobGc.make({
    entities: { Documents },
    // Free a superseded version 15 minutes after its record (presigned URLs and
    // lagging readers of the old row stay valid that long)
    reaper: { gracePeriod: "15 minutes" },
    // Delete a version only after it has been unreferenced for a day
    sweep: { gracePeriod: "1 day" },
  })
  // #endregion

  // The reaper runs once the grace has passed since the record
  const reaped = yield* later("16 minutes")(
    Effect.gen(function* () {
      // #region gc-reap
      // A batch of records from Lambda, Pipes or the change feed: each own version
      // a record superseded is freed once the grace has passed
      const report = yield* gc.reap([record])
      // report → { records: 1, candidates: 1, freed: 1, retained: 0, foreign: 0, skipped: 0 }
      // #endregion
      return report
    }),
  )
  assertEq(
    reaped,
    { records: 1, candidates: 1, freed: 1, retained: 0, foreign: 0, skipped: 0 },
    "reap report",
  )

  // #region not-found
  // A consumer reading the superseded body after the reaper freed it
  const stale = yield* oldBody.read().pipe(
    Effect.as("read"),
    Effect.catchTag("BlobStoreError", (error) =>
      error.reason === "NotFound" ? Effect.succeed("superseded") : Effect.fail(error),
    ),
  )
  // stale → "superseded": the newer record carries the newer pointer
  // #endregion
  assertEq(stale, "superseded", "freed version")

  // The earlier body version of d-1 (superseded by the update above, never
  // reaped: no record of it was delivered) is left for the sweep.
  const firstPass = yield* later("76 minutes")(
    Effect.gen(function* () {
      // #region gc-sweep
      // A periodic job: one pass marks each version no row holds (and old enough
      // not to be in flight); a pass at least the grace later deletes it
      const report = yield* gc.sweep("Documents", { docId: "d-1" })
      // report → { referenced: 2, listed: 3, marked: 1, deleted: 0, … }
      // #endregion
      return report
    }),
  )
  const secondPass = yield* later(Duration.sum(Duration.minutes(77), Duration.days(1)))(
    gc.sweep("Documents", { docId: "d-1" }),
  )
  yield* Console.log(
    `sweep d-1: marked ${firstPass.marked}, then deleted ${secondPass.deleted} a day later`,
  )
  assertEq(
    [firstPass.referenced, firstPass.marked, firstPass.deleted, firstPass.busy],
    [2, 1, 0, false],
    "first sweep pass",
  )
  assertEq([secondPass.marked, secondPass.deleted], [0, 1], "second sweep pass")

  const families = yield* later(Duration.sum(Duration.minutes(78), Duration.days(1)))(
    Effect.gen(function* () {
      // #region gc-sweep-store
      // The store-wide backstop for leaks no row records: run rarely, in bounded runs.
      // Each family is Swept (with its SweepReport), Foreign (another table's or
      // not the library's: never deleted) or Unattributable (handle by hand)
      const results = yield* Stream.runCollect(gc.sweepStore({ maxFamilies: 1_000 }))
      const deleted = results.reduce(
        (n, family) => (family._tag === "Swept" ? n + family.report.deleted : n),
        0,
      )

      // The next run resumes after the last family this one reached
      const last = results.at(-1)
      const next =
        last === undefined
          ? []
          : yield* Stream.runCollect(
              gc.sweepStore({ startAfter: last.familyPrefix, maxFamilies: 1_000 }),
            )
      // #endregion
      yield* Console.log(`sweepStore: ${results.length} families, ${deleted} versions deleted`)
      assertEq(next.length, 0, "nothing after the last family")
      return results
    }),
  )
  assertEq(
    families.map((family) => family._tag),
    ["Swept", "Swept", "Swept", "Swept"],
    "every family swept",
  )

  // #region purge
  // purge deletes every row of the item, then its object versions
  yield* db.entities.Documents.purge({ docId: "d-3" })
  // #endregion
  const purged = yield* later(Duration.sum(Duration.minutes(79), Duration.days(1)))(
    gc.sweep("Documents", { docId: "d-3" }),
  )
  assertEq([purged.referenced, purged.listed], [0, 0], "purge left nothing")

  yield* client.deleteTable({ TableName: TABLE_NAME })
})

// =============================================================================
// 5. Run
// =============================================================================

const main = Effect.gen(function* () {
  const admin = yield* adminClient
  if (Option.isNone(admin)) {
    yield* Console.log("S3_ENDPOINT is not set: running on the in-memory store")
    return yield* program.pipe(Effect.provide(AppLayer))
  }
  yield* Console.log(`S3_ENDPOINT is set: running on the S3 store, bucket ${BUCKET}`)
  yield* createBucket(admin.value)
  yield* program.pipe(
    Effect.provide(AppLayer),
    Effect.ensuring(Effect.ignore(deleteBucket(admin.value))),
  )
  admin.value.destroy()
})

Effect.runPromise(main).then(() => console.log("Done."))
