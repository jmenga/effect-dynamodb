/**
 * The S3 store (`effect-dynamodb/blob/s3`, #179, design §12.2, §19.4)
 * against a real S3 API — MinIO in CI, beside DynamoDB Local: versioned put
 * / get / ranged get / head / list / copy / delete by version; marks as
 * version tags beside another tag; buckets without versioning (never
 * enabled, suspended) refused with nothing left behind; single PUT and
 * multipart of the same 11 MB agreeing on the CRC-64/NVME S3 stores; a wrong
 * checksum refused; a part S3 refuses and an interruption each leaving no
 * upload; a multipart copy; a presigned URL; `layerConfig`.
 *
 * `S3_ENDPOINT` (default `http://localhost:9000`) and the credentials
 * (`S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY`, default MinIO's
 * `minioadmin`) are read through `Config`; the suite is skipped when the
 * endpoint is unreachable. Buckets are made by the test setup (with
 * `PutBucketVersioning`), never by the library. No AWS-specific error code is
 * asserted (F15): only the store's reasons.
 */

import {
  AbortMultipartUploadCommand,
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  GetObjectTaggingCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  type ListMultipartUploadsCommandOutput,
  ListObjectVersionsCommand,
  type ListObjectVersionsCommandOutput,
  PutBucketVersioningCommand,
  PutObjectCommand,
  PutObjectTaggingCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
import { it } from "@effect/vitest"
import { crc64nvme } from "@effect-dynamodb/schema/internal/Crc64Nvme.js"
import {
  Cause,
  Config,
  ConfigProvider,
  Duration,
  Effect,
  Exit,
  Fiber,
  Option,
  Stream,
} from "effect"
import { afterAll, beforeAll, describe, expect } from "vitest"
import {
  type BlobPutRequest,
  type BlobRef,
  BlobStore,
  type BlobStoreFailure,
  type BlobStoreService,
} from "../src/BlobStore.js"
import {
  MARK_TAG,
  makeService,
  resolveOptions,
  type S3BlobStoreOptions,
  type S3Tuning,
} from "../src/blob/S3BlobStore.js"
import * as S3BlobStore from "../src/blob/s3.js"

// ---------------------------------------------------------------------------
// Skip when the S3 endpoint isn't reachable
// ---------------------------------------------------------------------------

const settings = Effect.runSync(
  Config.all({
    endpoint: Config.String("S3_ENDPOINT").pipe(Config.withDefault("http://localhost:9000")),
    accessKeyId: Config.String("S3_ACCESS_KEY_ID").pipe(Config.withDefault("minioadmin")),
    secretAccessKey: Config.String("S3_SECRET_ACCESS_KEY").pipe(Config.withDefault("minioadmin")),
  }),
)

let s3Available = false
try {
  // Any answer (MinIO's anonymous one is a 403) means it is up.
  const res = await fetch(settings.endpoint, { signal: AbortSignal.timeout(1000) }).catch(
    () => null,
  )
  s3Available = res !== null
} catch {
  s3Available = false
}

const describeConnected = s3Available ? describe : describe.skip

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const clientConfig = {
  region: "us-east-1",
  endpoint: settings.endpoint,
  forcePathStyle: true,
  credentials: { accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey },
}

const admin = new S3Client(clientConfig)
const stamp = Date.now()
const buckets = {
  versioned: `edd-s3-versioned-${stamp}`,
  unversioned: `edd-s3-unversioned-${stamp}`,
  suspended: `edd-s3-suspended-${stamp}`,
}

const MiB = 1024 * 1024
const ELEVEN_MB = 11 * 1000 * 1000
const TUNING: S3Tuning = { maxCopyObjectBytes: 5 * 1024 * MiB, maxParts: 10_000 }

/** The S3 store over `client` (default the admin client). */
const storeOf = (
  bucket: string,
  options: Partial<S3BlobStoreOptions> = {},
  tuning: Partial<S3Tuning> = {},
  client: S3Client = admin,
): BlobStoreService =>
  makeService(resolveOptions("connected", { bucket, client, ...options }), client, {
    ...TUNING,
    ...tuning,
  })

const bytesOf = (n: number, seed = 7): Uint8Array => {
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i++) out[i] = (i * 31 + seed) & 0xff
  return out
}

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64")

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(b)

const chunksOf = (content: Uint8Array, size: number): Stream.Stream<Uint8Array> => {
  const out: Array<Uint8Array> = []
  for (let at = 0; at < content.length; at += size) out.push(content.slice(at, at + size))
  return Stream.fromIterable(out)
}

const request = (
  key: string,
  content: Uint8Array,
  overrides: Partial<BlobPutRequest> = {},
): BlobPutRequest => ({
  key,
  body: content,
  contentLength: content.length,
  checksum: Effect.succeed({ algorithm: "crc64nvme", value: crc64nvme(content) }),
  contentType: "application/pdf",
  metadata: { "edd-v": "1", "edd-attr": "scan" },
  ...overrides,
})

const collect = (stream: Stream.Stream<Uint8Array, BlobStoreFailure>) =>
  Effect.map(Stream.runCollect(stream), (chunks) => {
    const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
    let at = 0
    for (const chunk of chunks) {
      out.set(chunk, at)
      at += chunk.length
    }
    return out
  })

const failureOf = (exit: Exit.Exit<unknown, BlobStoreFailure>): BlobStoreFailure => {
  if (Exit.isSuccess(exit)) throw new Error("expected a failure")
  const error = Cause.findErrorOption(exit.cause)
  if (Option.isNone(error)) throw new Error(`expected a Fail, got ${Cause.pretty(exit.cause)}`)
  return error.value
}

/** The admin client's `send`, untyped (for the proxies and the setup). */
const raw = admin as unknown as {
  readonly send: (command: object, options?: object) => Promise<unknown>
}

const send = <O>(command: object): Effect.Effect<O> =>
  Effect.promise(() => raw.send(command) as Promise<O>)

/** Every version and delete marker under `prefix`. */
const versionsUnder = (bucket: string, prefix: string) =>
  Effect.map(
    send<ListObjectVersionsCommandOutput>(
      new ListObjectVersionsCommand({ Bucket: bucket, Prefix: prefix }),
    ),
    (out) => ({ versions: out.Versions ?? [], deleteMarkers: out.DeleteMarkers ?? [] }),
  )

/** The multipart uploads open on `key` (MinIO lists them by exact key only). */
const uploadsOf = (bucket: string, key: string) =>
  Effect.map(
    send<ListMultipartUploadsCommandOutput>(
      new ListMultipartUploadsCommand({ Bucket: bucket, Prefix: key }),
    ),
    (out) => (out.Uploads ?? []).filter((upload) => upload.Key === key),
  )

const emptyBucket = async (bucket: string): Promise<void> => {
  for (;;) {
    const out = await admin.send(new ListObjectVersionsCommand({ Bucket: bucket }))
    const objects = [...(out.Versions ?? []), ...(out.DeleteMarkers ?? [])].map((v) => ({
      Key: v.Key!,
      VersionId: v.VersionId,
    }))
    if (objects.length === 0) break
    await admin.send(
      new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects, Quiet: true } }),
    )
  }
  const uploads = await admin.send(new ListMultipartUploadsCommand({ Bucket: bucket }))
  for (const upload of uploads.Uploads ?? []) {
    await admin
      .send(
        new AbortMultipartUploadCommand({
          Bucket: bucket,
          Key: upload.Key!,
          UploadId: upload.UploadId!,
        }),
      )
      .catch(() => undefined)
  }
}

beforeAll(async () => {
  if (!s3Available) return
  for (const bucket of Object.values(buckets)) {
    await admin.send(new CreateBucketCommand({ Bucket: bucket }))
  }
  await admin.send(
    new PutBucketVersioningCommand({
      Bucket: buckets.versioned,
      VersioningConfiguration: { Status: "Enabled" },
    }),
  )
  await admin.send(
    new PutBucketVersioningCommand({
      Bucket: buckets.suspended,
      VersioningConfiguration: { Status: "Enabled" },
    }),
  )
  await admin.send(
    new PutBucketVersioningCommand({
      Bucket: buckets.suspended,
      VersioningConfiguration: { Status: "Suspended" },
    }),
  )
})

afterAll(async () => {
  if (!s3Available) return
  for (const bucket of Object.values(buckets)) {
    await emptyBucket(bucket).catch(() => undefined)
    await admin.send(new DeleteBucketCommand({ Bucket: bucket })).catch(() => undefined)
  }
  admin.destroy()
})

// ---------------------------------------------------------------------------
// Versioned
// ---------------------------------------------------------------------------

describeConnected("S3 store (connected) — a versioned bucket", () => {
  it.effect("puts, reads (whole and ranged), heads, lists, copies and deletes by version", () =>
    Effect.gen(function* () {
      const store = storeOf(buckets.versioned, { prefix: "basic/" })
      const content = bytesOf(1_000)
      const first = yield* store.put(request("basic/doc/a", content))
      expect(first.size).toBe(1_000)
      expect(first.ref.key).toBe("basic/doc/a")
      expect(first.ref.version).not.toBe("")
      expect(first.ref.version).not.toBe("null")

      expect(sameBytes(yield* collect(store.get(first.ref)), content)).toBe(true)
      const ranged = (offset: number, length?: number) =>
        collect(store.get(first.ref, { range: { offset, length } }))
      expect(yield* ranged(10, 20)).toEqual(content.slice(10, 30))
      expect(yield* ranged(990)).toEqual(content.slice(990))
      expect(yield* ranged(990, 50)).toEqual(content.slice(990))
      expect(yield* ranged(1_000)).toEqual(new Uint8Array(0))
      expect(yield* ranged(40, 0)).toEqual(new Uint8Array(0))
      expect(failureOf(yield* Effect.exit(ranged(1_001))).reason).toBe("Rejected")

      expect(yield* store.head!(first.ref)).toMatchObject({ "edd-v": "1", "edd-attr": "scan" })

      // A second version of the key: the first still reads as it was.
      const second = yield* store.put(request("basic/doc/a", bytesOf(500, 3)))
      expect(second.ref.version).not.toBe(first.ref.version)
      expect(sameBytes(yield* collect(store.get(first.ref)), content)).toBe(true)
      const other = yield* store.put(request("basic/doc/b", bytesOf(10)))

      const listed = yield* Stream.runCollect(store.list!("basic/"))
      const summary = listed.map((l) => [l.ref.key, l.ref.version, l.size, l.isLatest])
      expect(summary).toEqual(
        expect.arrayContaining([
          ["basic/doc/a", first.ref.version, 1_000, false],
          ["basic/doc/a", second.ref.version, 500, true],
          ["basic/doc/b", other.ref.version, 10, true],
        ]),
      )
      expect(listed).toHaveLength(3)
      for (const listing of listed) expect(listing.lastModified).toBeInstanceOf(Date)
      const after = yield* Stream.runCollect(store.list!("basic/", { startAfter: "basic/doc/a" }))
      expect(after.map((l) => l.ref.key)).toEqual(["basic/doc/b"])

      // A copy of the first version: fresh metadata, no tags.
      yield* store.marks!.set(first.ref, new Date("2026-10-30T00:00:00.000Z"))
      const copied = yield* store.copy!(first.ref, {
        key: "basic/doc/c",
        contentLength: 1_000,
        contentType: "image/png",
        metadata: { "edd-v": "1", "edd-attr": "copied" },
      })
      expect(copied.size).toBe(1_000)
      expect(sameBytes(yield* collect(store.get(copied.ref)), content)).toBe(true)
      expect(yield* store.head!(copied.ref)).toMatchObject({ "edd-attr": "copied" })
      expect(yield* store.marks!.get(copied.ref)).toEqual(Option.none())
      // Its size from HeadObject when the request gives none.
      const sized = yield* store.copy!(first.ref, {
        key: "basic/doc/d",
        contentLength: undefined,
        contentType: "image/png",
        metadata: {},
      })
      expect(sized.size).toBe(1_000)

      // Delete by version: exactly those versions; again is fine.
      yield* store.delete([first.ref, copied.ref, sized.ref])
      yield* store.delete([first.ref])
      const gone = failureOf(yield* Effect.exit(collect(store.get(first.ref))))
      expect(gone).toMatchObject({ reason: "NotFound", ref: first.ref })
      expect(sameBytes(yield* collect(store.get(second.ref)), bytesOf(500, 3))).toBe(true)
      const { versions, deleteMarkers } = yield* versionsUnder(buckets.versioned, "basic/")
      expect(versions.map((v) => v.VersionId).sort()).toEqual(
        [second.ref.version, other.ref.version].sort(),
      )
      expect(deleteMarkers).toEqual([])
    }),
  )

  it.effect("marks are a version tag, kept beside the version's other tags", () =>
    Effect.gen(function* () {
      const store = storeOf(buckets.versioned)
      const { ref } = yield* store.put(request("marks/k", bytesOf(10)))
      yield* send(
        new PutObjectTaggingCommand({
          Bucket: buckets.versioned,
          Key: ref.key,
          VersionId: ref.version,
          Tagging: { TagSet: [{ Key: "team", Value: "docs" }] },
        }),
      )
      expect(yield* store.marks!.get(ref)).toEqual(Option.none())
      const since = new Date("2026-10-31T12:00:00.000Z")
      yield* store.marks!.set(ref, since)
      expect(yield* store.marks!.get(ref)).toEqual(Option.some(since))
      const tags = (r: BlobRef) =>
        Effect.map(
          send<{ TagSet?: Array<{ Key?: string; Value?: string }> }>(
            new GetObjectTaggingCommand({
              Bucket: buckets.versioned,
              Key: r.key,
              VersionId: r.version,
            }),
          ),
          (out) =>
            Object.fromEntries((out.TagSet ?? []).map((tag) => [tag.Key ?? "", tag.Value ?? ""])),
        )
      expect(yield* tags(ref)).toEqual({ team: "docs", [MARK_TAG]: since.toISOString() })
      yield* store.marks!.clear(ref)
      expect(yield* tags(ref)).toEqual({ team: "docs" })
      expect(yield* store.marks!.get(ref)).toEqual(Option.none())
      // A version already gone: nothing to read, set or clear.
      yield* store.delete([ref])
      expect(yield* store.marks!.get(ref)).toEqual(Option.none())
      yield* store.marks!.set(ref, since)
      yield* store.marks!.clear(ref)
    }),
  )

  it.effect("single PUT and multipart of the same 11 MB store the library's CRC-64/NVME", () =>
    Effect.gen(function* () {
      const content = bytesOf(ELEVEN_MB, 5)
      const expected = b64(crc64nvme(content))
      const single = yield* storeOf(buckets.versioned, { partSize: 16 * MiB }).put(
        request("checksum/single", content),
      )
      const multi = yield* storeOf(buckets.versioned, { partSize: 5 * MiB }).put(
        request("checksum/multi", content, {
          body: chunksOf(content, MiB),
          contentLength: undefined,
        }),
      )
      const stored = (ref: BlobRef) =>
        Effect.map(
          send<{ ChecksumCRC64NVME?: string; ContentLength?: number }>(
            new HeadObjectCommand({
              Bucket: buckets.versioned,
              Key: ref.key,
              VersionId: ref.version,
              ChecksumMode: "ENABLED",
            }),
          ),
          (out) => [out.ChecksumCRC64NVME, out.ContentLength],
        )
      expect(yield* stored(single.ref)).toEqual([expected, ELEVEN_MB])
      expect(yield* stored(multi.ref)).toEqual([expected, ELEVEN_MB])
      const store = storeOf(buckets.versioned)
      expect(sameBytes(yield* collect(store.get(multi.ref)), content)).toBe(true)
      expect(yield* uploadsOf(buckets.versioned, "checksum/multi")).toEqual([])
    }),
  )

  it.effect("a body whose checksum is wrong is refused; nothing is stored", () =>
    Effect.gen(function* () {
      const store = storeOf(buckets.versioned)
      const failure = failureOf(
        yield* Effect.exit(
          store.put(
            request("wrong/k", bytesOf(100), {
              checksum: Effect.succeed({ algorithm: "crc64nvme", value: crc64nvme(bytesOf(99)) }),
            }),
          ),
        ),
      )
      expect(failure.reason).toBe("ChecksumMismatch")
      expect((yield* versionsUnder(buckets.versioned, "wrong/")).versions).toEqual([])
    }),
  )

  it.effect("a part S3 refuses fails the put: no completed upload, no open one", () =>
    Effect.gen(function* () {
      // A part's checksum corrupted on its way: S3 itself refuses that part.
      const corrupting = {
        send: (command: object, options?: object) => {
          if (command instanceof UploadPartCommand && command.input.PartNumber === 2) {
            return raw.send(
              new UploadPartCommand({
                ...command.input,
                ChecksumCRC64NVME: b64(crc64nvme(bytesOf(8))),
              }),
              options,
            )
          }
          return raw.send(command, options)
        },
        destroy: () => undefined,
      } as unknown as S3Client
      const store = storeOf(buckets.versioned, { partSize: 5 * MiB }, {}, corrupting)
      const failure = failureOf(
        yield* Effect.exit(store.put(request("refused/k", bytesOf(ELEVEN_MB)))),
      )
      expect(failure.reason).toBe("ChecksumMismatch")
      expect(failure.completeLost).toBeUndefined()
      expect((yield* versionsUnder(buckets.versioned, "refused/")).versions).toEqual([])
      expect(yield* uploadsOf(buckets.versioned, "refused/k")).toEqual([])
    }),
  )

  it.effect("interrupting a multipart upload aborts it: no upload is left", () =>
    Effect.gen(function* () {
      let partDone: () => void = () => undefined
      const firstPart = new Promise<void>((resolve) => {
        partDone = resolve
      })
      const signalling = {
        send: async (command: object, options?: object) => {
          const out = await raw.send(command, options)
          if (command instanceof UploadPartCommand) partDone()
          return out
        },
        destroy: () => undefined,
      } as unknown as S3Client
      const store = storeOf(buckets.versioned, { partSize: 5 * MiB }, {}, signalling)
      const content = bytesOf(11 * MiB)
      // Two parts' bytes (the first goes up once the second exists), then the source stalls.
      const fiber = yield* Effect.forkChild(
        store.put(
          request("interrupted/k", content, {
            body: Stream.concat(chunksOf(content, MiB), Stream.never),
            contentLength: undefined,
          }),
        ),
      )
      yield* Effect.promise(() => firstPart)
      expect(yield* uploadsOf(buckets.versioned, "interrupted/k")).toHaveLength(1)
      yield* Fiber.interrupt(fiber)
      expect(yield* uploadsOf(buckets.versioned, "interrupted/k")).toEqual([])
      expect((yield* versionsUnder(buckets.versioned, "interrupted/")).versions).toEqual([])
    }),
  )

  it.effect("copies a source over the CopyObject limit in UploadPartCopy ranges", () =>
    Effect.gen(function* () {
      const content = bytesOf(ELEVEN_MB, 11)
      const store = storeOf(
        buckets.versioned,
        { partSize: 5 * MiB },
        { maxCopyObjectBytes: 5 * MiB },
      )
      const source = yield* store.put(request("mpcopy/src", content))
      const copied = yield* store.copy!(source.ref, {
        key: "mpcopy/dst",
        contentLength: ELEVEN_MB,
        contentType: "application/pdf",
        metadata: { "edd-v": "1" },
      })
      expect(copied.size).toBe(ELEVEN_MB)
      expect(copied.ref.version).not.toBe("null")
      expect(sameBytes(yield* collect(store.get(copied.ref)), content)).toBe(true)
      expect(yield* store.head!(copied.ref)).toMatchObject({ "edd-v": "1" })
      expect(yield* uploadsOf(buckets.versioned, "mpcopy/dst")).toEqual([])
    }),
  )

  it.effect("presigns a GET of the version (with @aws-sdk/s3-request-presigner)", () =>
    Effect.gen(function* () {
      const store = storeOf(buckets.versioned, { presign: { getSignedUrl } })
      const content = bytesOf(64)
      const first = yield* store.put(request("presign/k", content))
      yield* store.put(request("presign/k", bytesOf(64, 9)))
      const url = yield* store.presign!(first.ref, {
        expiresIn: Duration.minutes(5),
        contentType: "application/octet-stream",
      })
      const res = yield* Effect.promise(() => fetch(url))
      expect(res.status).toBe(200)
      expect(res.headers.get("content-type")).toBe("application/octet-stream")
      expect(new Uint8Array(yield* Effect.promise(() => res.arrayBuffer()))).toEqual(content)
    }),
  )

  it.effect("layerConfig builds the store (and its own client) from Config", () =>
    Effect.gen(function* () {
      const content = bytesOf(32)
      const read = yield* Effect.gen(function* () {
        const store = yield* BlobStore
        const { ref } = yield* store.put(request("config/k", content))
        return yield* collect(store.get(ref))
      }).pipe(
        Effect.provide(
          S3BlobStore.layerConfig({
            bucket: Config.String("BUCKET"),
            prefix: Config.String("PREFIX"),
            region: Config.String("REGION"),
            endpoint: Config.String("ENDPOINT"),
            forcePathStyle: Config.Boolean("PATH_STYLE"),
            credentials: Config.all({
              accessKeyId: Config.String("ACCESS_KEY_ID"),
              secretAccessKey: Config.String("SECRET_ACCESS_KEY"),
            }),
          }),
        ),
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              BUCKET: buckets.versioned,
              PREFIX: "config/",
              REGION: "us-east-1",
              ENDPOINT: settings.endpoint,
              PATH_STYLE: "true",
              ACCESS_KEY_ID: settings.accessKeyId,
              SECRET_ACCESS_KEY: settings.secretAccessKey,
            }),
          ),
        ),
      )
      expect(read).toEqual(content)
    }),
  )
})

// ---------------------------------------------------------------------------
// Without versioning
// ---------------------------------------------------------------------------

describeConnected("S3 store (connected) — buckets without versioning", () => {
  for (const kind of ["unversioned", "suspended"] as const) {
    it.effect(`${kind}: a put is Unversioned and leaves no object (and no delete marker)`, () =>
      Effect.gen(function* () {
        const bucket = buckets[kind]
        const store = storeOf(bucket, { partSize: 5 * MiB })
        const single = failureOf(yield* Effect.exit(store.put(request("put/single", bytesOf(100)))))
        expect(single.reason).toBe("Unversioned")
        expect(single.message).toMatch(/enable versioning/)
        const multi = failureOf(
          yield* Effect.exit(store.put(request("put/multi", bytesOf(ELEVEN_MB)))),
        )
        expect(multi.reason).toBe("Unversioned")
        const left = yield* versionsUnder(bucket, "put/")
        expect(left.versions).toEqual([])
        expect(left.deleteMarkers).toEqual([])
        expect(yield* uploadsOf(bucket, "put/multi")).toEqual([])
      }),
    )

    it.effect(`${kind}: a CopyObject into it is refused the same way`, () =>
      Effect.gen(function* () {
        const bucket = buckets[kind]
        // A source written around the store (it would refuse to write one).
        yield* send(new PutObjectCommand({ Bucket: bucket, Key: "copy/src", Body: bytesOf(20) }))
        const store = storeOf(bucket)
        const failure = failureOf(
          yield* Effect.exit(
            store.copy!(
              { key: "copy/src", version: "null" },
              { key: "copy/dst", contentLength: 20, contentType: "x/y", metadata: {} },
            ),
          ),
        )
        expect(failure.reason).toBe("Unversioned")
        const left = yield* versionsUnder(bucket, "copy/")
        expect(left.versions.map((v) => v.Key)).toEqual(["copy/src"])
        expect(left.deleteMarkers).toEqual([])
      }),
    )
  }
})
