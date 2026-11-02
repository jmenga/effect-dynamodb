/**
 * The S3 store (`effect-dynamodb/blob/s3`, #179, design §7, §12.2) over a
 * stubbed `S3Client` (`test/helpers/StubS3.ts`): the requests it sends —
 * the library's CRC-64/NVME on every upload, multipart create / parts /
 * complete with full-object checksums, copies, ranged reads, version deletes
 * in chunks of 1,000, paginated version listings, version-tag marks,
 * presigning — and how it reads S3's answers: a missing or `"null"`
 * `VersionId` is `Unversioned` after deleting what was written, a completion
 * that may have happened is `completeLost`, interruption aborts (but never a
 * `Complete` already sent, which runs to its answer), part 10,001
 * is `TooLarge`, a version already gone is deleted, and SDK errors classify
 * into the store's reasons. Plus the `[EDD-9116]` option checks and the
 * layers.
 */

import { inspect } from "node:util"
import { S3Client } from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
import { describe, expect, it } from "@effect/vitest"
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
  Schedule,
  Scope,
  Stream,
} from "effect"
import { vi } from "vitest"
import {
  type BlobPutRequest,
  type BlobRef,
  BlobStore,
  type BlobStoreFailure,
  type BlobStoreService,
} from "../src/BlobStore.js"
import {
  classify,
  copySourceOf,
  MARK_TAG,
  makeService,
  resolveOptions,
  type S3BlobStoreOptions,
  type S3Tuning,
} from "../src/blob/S3BlobStore.js"
import * as S3BlobStore from "../src/blob/s3.js"
import { REDACTED_REPLY } from "../src/internal/CredentialRefusal.js"
import {
  afterAttempts,
  makeGate,
  makeStubS3,
  type StubS3,
  type StubS3Options,
  s3Error,
  transportError,
} from "./helpers/StubS3.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MiB = 1024 * 1024
const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64")
const bytesOf = (n: number, seed = 7): Uint8Array => {
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i++) out[i] = (i * 31 + seed) & 0xff
  return out
}

/** Byte equality, fast for megabytes (`toEqual` walks each element). */
const sameBytes = (a: Uint8Array | undefined, b: Uint8Array): boolean =>
  a !== undefined && Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(b)

const chunksOf = (content: Uint8Array, size: number): Stream.Stream<Uint8Array, never> => {
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

/**
 * Interrupt `fiber` while one of its calls is held by a gate, then release the
 * gate: the interruption is registered before the call answers. The fiber's
 * exit.
 */
const interruptWhileHeld = <A, E>(fiber: Fiber.Fiber<A, E>, release: () => void) =>
  Effect.gen(function* () {
    const interrupter = yield* Effect.forkChild(Fiber.interrupt(fiber), {
      startImmediately: true,
    })
    release()
    const exit = yield* Fiber.await(fiber)
    yield* Fiber.join(interrupter)
    return exit
  })

const failureOf = (exit: Exit.Exit<unknown, BlobStoreFailure>): BlobStoreFailure => {
  if (Exit.isSuccess(exit)) throw new Error("expected a failure")
  const error = Cause.findErrorOption(exit.cause)
  if (Option.isNone(error)) throw new Error(`expected a Fail, got ${Cause.pretty(exit.cause)}`)
  return error.value
}

interface Setup {
  readonly stub: StubS3
  readonly store: BlobStoreService
}

const setup = (
  stubOptions: StubS3Options = {},
  options: Partial<S3BlobStoreOptions> = {},
  tuning?: Partial<S3Tuning>,
): Setup => {
  const stub = makeStubS3(stubOptions)
  const resolved = resolveOptions("test", {
    bucket: "test-bucket",
    prefix: "app/",
    client: stub.client as S3Client,
    partSize: 5 * MiB,
    ...options,
  })
  const store = makeService(resolved, stub.client as S3Client, {
    maxCopyObjectBytes: 5 * 1024 * MiB,
    maxParts: 10_000,
    ...tuning,
  })
  return { stub, store }
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

describe("S3 store — options ([EDD-9116])", () => {
  const client = makeStubS3().client as S3Client
  const make = (options: unknown) => () => resolveOptions("S3BlobStore.layer", options as never)

  it("checks every option when the layer is made", () => {
    const cases: ReadonlyArray<[unknown, RegExp]> = [
      [null, /options must be an object/],
      [{ bucket: "b", nope: 1 }, /unknown option "nope"/],
      [{ bucket: "" }, /bucket must be a non-empty string/],
      [{ bucket: 3 }, /bucket must be a non-empty string/],
      [{ bucket: "b", prefix: "/abs" }, /prefix must not start with "\/"/],
      [{ bucket: "b", prefix: "x".repeat(257) }, /over the 256-byte limit/],
      [{ bucket: "b", client, clientConfig: {} }, /client or clientConfig, not both/],
      [{ bucket: "b", client: {} }, /client must be an S3Client/],
      [{ bucket: "b", partSize: 5 * MiB - 1 }, /partSize must be an integer from 5 MiB to 5 GiB/],
      [{ bucket: "b", partSize: 5 * 1024 * MiB + 1 }, /partSize/],
      [{ bucket: "b", partSize: 5 * MiB + 0.5 }, /partSize/],
      [{ bucket: "b", uploadConcurrency: 0 }, /uploadConcurrency must be a positive integer/],
      [{ bucket: "b", readConcurrency: 1.5 }, /readConcurrency must be a positive integer/],
      [{ bucket: "b", writeConcurrency: -1 }, /writeConcurrency must be a positive integer/],
      [
        { bucket: "b", maxUploadAge: "30 seconds" },
        /maxUploadAge must be a duration from 1 minute/,
      ],
      [{ bucket: "b", maxUploadAge: "8 days" }, /maxUploadAge/],
      [
        { bucket: "b", serverSideEncryption: { SSECustomerKey: "k" } },
        /unknown key "SSECustomerKey"/,
      ],
      [{ bucket: "b", storageClass: "" }, /storageClass must be a non-empty string/],
      [{ bucket: "b", notFoundRetry: 3 }, /notFoundRetry must be a Schedule/],
      [{ bucket: "b", presign: {} }, /presign must be \{ getSignedUrl \}/],
    ]
    for (const [options, message] of cases) {
      expect(make(options)).toThrow(/^\[EDD-9116\] S3BlobStore\.layer: /)
      expect(make(options)).toThrow(message)
    }
    // The public constructors check when called.
    expect(() => S3BlobStore.layer({ bucket: "" })).toThrow(/\[EDD-9116\] S3BlobStore\.layer/)
    expect(() => S3BlobStore.make({ bucket: "b", partSize: 1 })).toThrow(
      /\[EDD-9116\] S3BlobStore\.make/,
    )
  })

  it("declares S3's limits and the defaults", () => {
    const { store } = setup({}, { partSize: undefined, prefix: undefined })
    expect(store.name).toBe("s3://test-bucket/")
    expect(store.prefix).toBe("")
    expect(store.limits).toEqual({ maxVersionBytes: 1024, maxKeySuffixBytes: 0 })
    expect(Duration.toMillis(store.maxUploadAge)).toBe(3_600_000)
    expect([store.readConcurrency, store.writeConcurrency]).toEqual([16, 8])
    expect(typeof store.copy).toBe("function")
    expect(typeof store.list).toBe("function")
    expect(typeof store.head).toBe("function")
    expect(store.marks).toBeDefined()
    // presign only with a presigner
    expect(store.presign).toBeUndefined()
    const custom = setup(
      {},
      {
        prefix: "prod/",
        maxUploadAge: "2 hours",
        readConcurrency: 3,
        writeConcurrency: 2,
        presign: { getSignedUrl: async () => "https://signed" },
      },
    ).store
    expect(custom.name).toBe("s3://test-bucket/prod/")
    expect(Duration.toMillis(custom.maxUploadAge)).toBe(7_200_000)
    expect([custom.readConcurrency, custom.writeConcurrency]).toEqual([3, 2])
    expect(typeof custom.presign).toBe("function")
  })
})

// ---------------------------------------------------------------------------
// put
// ---------------------------------------------------------------------------

describe("S3 store — put", () => {
  it.effect("a single PutObject carries the library's CRC-64/NVME and the passthroughs", () =>
    Effect.gen(function* () {
      const { stub, store } = setup(
        {},
        {
          serverSideEncryption: { ServerSideEncryption: "aws:kms", SSEKMSKeyId: "key-1" },
          storageClass: "STANDARD_IA",
        },
      )
      const content = bytesOf(1_000)
      const result = yield* store.put(request("app/p/f/o1", content))
      expect(result).toEqual({ ref: { key: "app/p/f/o1", version: "v000001" }, size: 1_000 })
      expect(stub.names()).toEqual(["PutObject"])
      const [input] = stub.inputs("PutObject")
      expect(input).toMatchObject({
        Bucket: "test-bucket",
        Key: "app/p/f/o1",
        ContentType: "application/pdf",
        Metadata: { "edd-v": "1", "edd-attr": "scan" },
        ContentLength: 1_000,
        ChecksumAlgorithm: "CRC64NVME",
        ChecksumCRC64NVME: b64(crc64nvme(content)),
        ServerSideEncryption: "aws:kms",
        SSEKMSKeyId: "key-1",
        StorageClass: "STANDARD_IA",
      })
      expect(stub.version("app/p/f/o1", "v000001")?.bytes).toEqual(content)
    }),
  )

  it.effect("sends the request's checksum, so S3 refuses a body that does not match it", () =>
    Effect.gen(function* () {
      const { stub, store } = setup()
      const exit = yield* Effect.exit(
        store.put(
          request("k", bytesOf(10), {
            checksum: Effect.succeed({ algorithm: "crc64nvme", value: new Uint8Array(8) }),
          }),
        ),
      )
      expect(failureOf(exit).reason).toBe("ChecksumMismatch")
      expect(stub.objects.size).toBe(0)
    }),
  )

  it.effect("a body over one part is a multipart upload with part and full-object checksums", () =>
    Effect.gen(function* () {
      const { stub, store } = setup({}, { serverSideEncryption: { BucketKeyEnabled: true } })
      const content = bytesOf(11_000_000)
      const result = yield* store.put(
        request("big", content, { body: chunksOf(content, 700_000), contentLength: undefined }),
      )
      expect(result.size).toBe(11_000_000)
      expect(stub.names()).toEqual([
        "CreateMultipartUpload",
        "UploadPart",
        "UploadPart",
        "UploadPart",
        "CompleteMultipartUpload",
      ])
      expect(stub.inputs("CreateMultipartUpload")[0]).toMatchObject({
        Key: "big",
        ContentType: "application/pdf",
        Metadata: { "edd-v": "1", "edd-attr": "scan" },
        ChecksumAlgorithm: "CRC64NVME",
        ChecksumType: "FULL_OBJECT",
        BucketKeyEnabled: true,
      })
      // Sent concurrently: in any order.
      const parts = [...stub.inputs("UploadPart")].sort((a, b) => a.PartNumber - b.PartNumber)
      expect(parts.map((p) => [p.PartNumber, p.Body.length])).toEqual([
        [1, 5 * MiB],
        [2, 5 * MiB],
        [3, 11_000_000 - 10 * MiB],
      ])
      for (const part of parts) {
        expect(part.ChecksumAlgorithm).toBe("CRC64NVME")
        expect(part.ChecksumCRC64NVME).toBe(b64(crc64nvme(part.Body)))
      }
      const [complete] = stub.inputs("CompleteMultipartUpload")
      expect(complete).toMatchObject({
        ChecksumCRC64NVME: b64(crc64nvme(content)),
        ChecksumType: "FULL_OBJECT",
        MpuObjectSize: 11_000_000,
      })
      expect(
        complete.MultipartUpload.Parts.map((p: { PartNumber: number }) => p.PartNumber),
      ).toEqual([1, 2, 3])
      expect(sameBytes(stub.version("big", result.ref.version)?.bytes, content)).toBe(true)
      expect(stub.uploads.size).toBe(0)
    }),
  )

  it.effect("single PUT and multipart store the same full-object CRC-64/NVME", () =>
    Effect.gen(function* () {
      const content = bytesOf(11_000_000, 3)
      const multipart = setup()
      const multi = yield* multipart.store.put(
        request("m", content, { body: chunksOf(content, MiB), contentLength: undefined }),
      )
      expect(multipart.stub.names()).toContain("CompleteMultipartUpload")
      // A part size over the body: one PutObject.
      const single = setup({}, { partSize: 16 * MiB })
      const one = yield* single.store.put(request("s", content))
      expect(single.stub.names()).toEqual(["PutObject"])
      // Each request carried the library's value, which the stub validated.
      expect(multipart.stub.inputs("CompleteMultipartUpload")[0].ChecksumCRC64NVME).toBe(
        single.stub.inputs("PutObject")[0].ChecksumCRC64NVME,
      )
      expect(multipart.stub.version("m", multi.ref.version)?.checksum).toBe(b64(crc64nvme(content)))
      expect(single.stub.version("s", one.ref.version)?.checksum).toBe(b64(crc64nvme(content)))
    }),
  )

  it.effect("raises the part size for a known contentLength past maxParts parts", () =>
    Effect.gen(function* () {
      const { stub, store } = setup({ maxParts: 2 }, {}, { maxParts: 2 })
      const content = bytesOf(12 * MiB)
      yield* store.put(request("adapted", content, { body: chunksOf(content, MiB) }))
      expect(stub.inputs("UploadPart").map((p) => p.Body.length)).toEqual([6 * MiB, 6 * MiB])
    }),
  )

  it.effect("part maxParts + 1 is TooLarge, naming the part size; the upload is aborted", () =>
    Effect.gen(function* () {
      const { stub, store } = setup({ maxParts: 2 }, {}, { maxParts: 2 })
      const content = bytesOf(11 * MiB)
      const exit = yield* Effect.exit(
        store.put(
          request("huge", content, { body: chunksOf(content, MiB), contentLength: undefined }),
        ),
      )
      const failure = failureOf(exit)
      expect(failure.reason).toBe("TooLarge")
      expect(String(failure.cause)).toMatch(/more than 2 parts of 5242880 bytes/)
      expect(stub.names()).toContain("AbortMultipartUpload")
      expect(stub.names()).not.toContain("CompleteMultipartUpload")
      expect(stub.uploads.size).toBe(0)
      expect(stub.objects.size).toBe(0)
    }),
  )

  it.effect("a part that fails outright aborts the upload; nothing is stored", () =>
    Effect.gen(function* () {
      const { stub, store } = setup({
        faults: (call) =>
          call.name === "UploadPart" && call.input.PartNumber === 2
            ? { _tag: "fail", error: s3Error("InternalError", 500) }
            : undefined,
      })
      const content = bytesOf(11 * MiB)
      const exit = yield* Effect.exit(store.put(request("p", content)))
      expect(failureOf(exit).reason).toBe("Unavailable")
      expect(stub.names()).toContain("AbortMultipartUpload")
      expect(stub.names()).not.toContain("CompleteMultipartUpload")
      expect(stub.uploads.size).toBe(0)
      expect(stub.objects.size).toBe(0)
    }),
  )

  it.effect("interrupting a multipart upload aborts it: no Complete, nothing stored", () =>
    Effect.gen(function* () {
      let partSent: () => void = () => undefined
      const firstPart = new Promise<void>((resolve) => {
        partSent = resolve
      })
      const { stub, store } = setup({
        faults: (call) => {
          if (call.name === "UploadPart") partSent()
          return undefined
        },
      })
      // Two parts' bytes (the first goes up once the second exists), then the source stalls.
      const content = bytesOf(11 * MiB)
      const body = Stream.concat(chunksOf(content, MiB), Stream.never)
      const fiber = yield* Effect.forkChild(
        store.put(request("stalled", content, { body, contentLength: undefined })),
      )
      yield* Effect.promise(() => firstPart)
      yield* Fiber.interrupt(fiber)
      expect(stub.names()).toContain("AbortMultipartUpload")
      expect(stub.names()).not.toContain("CompleteMultipartUpload")
      expect(stub.uploads.size).toBe(0)
      expect(stub.objects.size).toBe(0)
    }),
  )

  it.effect(
    "a Complete in flight when the put is interrupted runs to its answer, never aborted",
    () =>
      Effect.gen(function* () {
        const gate = makeGate()
        const { stub, store } = setup({
          faults: (call) => (call.name === "CompleteMultipartUpload" ? gate.hold() : undefined),
        })
        const fiber = yield* Effect.forkChild(store.put(request("c", bytesOf(11 * MiB))))
        yield* Effect.promise(() => gate.reached)
        const exit = yield* interruptWhileHeld(fiber, gate.release)
        // The interruption is delivered once the Complete answered: its answer is
        // lost to the caller (the upload ledger reports the put as interrupted).
        expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        expect(stub.objects.get("c")).toHaveLength(1)
        // A completed upload is never aborted.
        expect(stub.names()).not.toContain("AbortMultipartUpload")
        expect(stub.uploads.size).toBe(0)
      }),
  )

  it.effect("a Complete that may have completed is completeLost; one S3 refused is not", () =>
    Effect.gen(function* () {
      const content = bytesOf(11 * MiB)
      const outcome = (error: unknown, lost: boolean) =>
        Effect.gen(function* () {
          const { stub, store } = setup({
            faults: (call) =>
              call.name === "CompleteMultipartUpload"
                ? lost
                  ? { _tag: "lost", error }
                  : { _tag: "fail", error }
                : undefined,
          })
          const failure = failureOf(yield* Effect.exit(store.put(request("c", content))))
          // The driver aborts whatever is left; an upload gone already is fine.
          expect(stub.names()).toContain("AbortMultipartUpload")
          expect(stub.uploads.size).toBe(0)
          return { failure, stored: stub.objects.size }
        })
      // A response lost after S3 completed the upload: the version exists.
      const lostResponse = yield* outcome(transportError(), true)
      expect(lostResponse.failure).toMatchObject({ reason: "Unavailable", completeLost: true })
      expect(lostResponse.stored).toBe(1)
      // A retry finding the upload gone.
      const gone = yield* outcome(s3Error("NoSuchUpload", 404), false)
      expect(gone.failure).toMatchObject({ reason: "Rejected", completeLost: true })
      const throttled = yield* outcome(s3Error("SlowDown", 503), false)
      expect(throttled.failure).toMatchObject({ reason: "Throttled", completeLost: true })
      // A refusal of a request the SDK resent says nothing of the first send,
      // which may have completed with its answer lost.
      const resentDenied = yield* outcome(afterAttempts(s3Error("ExpiredToken", 403), 2), false)
      expect(resentDenied.failure).toMatchObject({ reason: "AccessDenied", completeLost: true })
      const resentRefused = yield* outcome(afterAttempts(s3Error("RequestTimeout", 400), 3), false)
      expect(resentRefused.failure).toMatchObject({ reason: "Rejected", completeLost: true })
      // Nor does a refusal that reports no attempt count.
      const uncounted = yield* outcome(afterAttempts(s3Error("InvalidPart", 400), undefined), false)
      expect(uncounted.failure).toMatchObject({ reason: "Rejected", completeLost: true })
      // Refused outright, on the SDK's only attempt: no version.
      const refusedPart = yield* outcome(s3Error("InvalidPart", 400), false)
      expect(refusedPart.failure.reason).toBe("Rejected")
      expect(refusedPart.failure.completeLost).toBeUndefined()
      expect(refusedPart.stored).toBe(0)
    }),
  )

  it.effect("an abort finding the upload gone succeeds (the put's own failure is kept)", () =>
    Effect.gen(function* () {
      const { stub, store } = setup({
        faults: (call) =>
          call.name === "UploadPart" && call.input.PartNumber === 2
            ? { _tag: "fail", error: s3Error("AccessDenied", 403) }
            : call.name === "AbortMultipartUpload"
              ? { _tag: "fail", error: s3Error("NoSuchUpload", 404) }
              : undefined,
      })
      const exit = yield* Effect.exit(store.put(request("a", bytesOf(11 * MiB))))
      expect(failureOf(exit).reason).toBe("AccessDenied")
      expect(stub.inputs("AbortMultipartUpload")).toHaveLength(1)
    }),
  )
})

// ---------------------------------------------------------------------------
// Unversioned buckets
// ---------------------------------------------------------------------------

describe("S3 store — buckets without versioning", () => {
  for (const versioning of ["Unversioned", "Suspended"] as const) {
    it.effect(`${versioning}: a put is Unversioned and leaves nothing behind`, () =>
      Effect.gen(function* () {
        const { stub, store } = setup({ versioning })
        const failure = failureOf(yield* Effect.exit(store.put(request("k", bytesOf(100)))))
        expect(failure.reason).toBe("Unversioned")
        expect(failure.ref).toBeUndefined()
        expect(String(failure.cause)).toMatch(
          versioning === "Suspended" ? /VersionId "null"/ : /no VersionId/,
        )
        expect(failure.message).toMatch(/bucket "test-bucket" does not have versioning enabled/)
        expect(failure.message).toMatch(/enable versioning/)
        // Deleted by the null version: no delete marker.
        expect(stub.inputs("DeleteObject")).toEqual([
          { Bucket: "test-bucket", Key: "k", VersionId: "null" },
        ])
        expect(stub.objects.size).toBe(0)
        expect(stub.deleteMarkers.size).toBe(0)
      }),
    )

    it.effect(`${versioning}: a multipart Complete is checked the same way`, () =>
      Effect.gen(function* () {
        const { stub, store } = setup({ versioning })
        const failure = failureOf(yield* Effect.exit(store.put(request("m", bytesOf(11 * MiB)))))
        expect(failure.reason).toBe("Unversioned")
        expect(String(failure.cause)).toMatch(/CompleteMultipartUpload/)
        expect(stub.objects.size).toBe(0)
        expect(stub.deleteMarkers.size).toBe(0)
      }),
    )

    it.effect(`${versioning}: a copy into the bucket is refused the same way`, () =>
      Effect.gen(function* () {
        const { stub, store } = setup()
        const source = stub.seed("src", bytesOf(50))
        stub.versioning = versioning
        const failure = failureOf(
          yield* Effect.exit(
            store.copy!(
              { key: "src", version: source.versionId },
              { key: "dst", contentLength: 50, contentType: "x/y", metadata: {} },
            ),
          ),
        )
        expect(failure.reason).toBe("Unversioned")
        expect(String(failure.cause)).toMatch(/CopyObject/)
        expect(stub.objects.get("dst")).toBeUndefined()
        expect(stub.version("src", source.versionId)).toBeDefined()
      }),
    )
  }

  it.effect("falls back to a plain DeleteObject when the null version's delete is refused", () =>
    Effect.gen(function* () {
      const { stub, store } = setup({
        versioning: "Suspended",
        faults: (call) =>
          call.name === "DeleteObject" && call.input.VersionId === "null"
            ? { _tag: "fail", error: s3Error("AccessDenied", 403) }
            : undefined,
      })
      const failure = failureOf(yield* Effect.exit(store.put(request("k", bytesOf(10)))))
      expect(failure.reason).toBe("Unversioned")
      expect(stub.inputs("DeleteObject")).toEqual([
        { Bucket: "test-bucket", Key: "k", VersionId: "null" },
        { Bucket: "test-bucket", Key: "k" },
      ])
      // The plain delete leaves a null delete marker (harmless).
      expect(stub.objects.size).toBe(0)
      expect(stub.deleteMarkers.get("k")).toBe(1)
      expect(String(failure.cause)).toMatch(/null delete marker may remain/)
    }),
  )

  it.effect("says so when it cannot delete what it wrote", () =>
    Effect.gen(function* () {
      const { store } = setup({
        versioning: "Unversioned",
        faults: (call) =>
          call.name === "DeleteObject"
            ? { _tag: "fail", error: s3Error("AccessDenied", 403) }
            : undefined,
      })
      const failure = failureOf(yield* Effect.exit(store.put(request("k", bytesOf(10)))))
      expect(failure.reason).toBe("Unversioned")
      expect(String(failure.cause)).toMatch(/Deleting the object it wrote failed/)
    }),
  )
})

// ---------------------------------------------------------------------------
// copy
// ---------------------------------------------------------------------------

describe("S3 store — copy", () => {
  it.effect("copies by version with fresh metadata and no tags", () =>
    Effect.gen(function* () {
      const { stub, store } = setup({}, { storageClass: "STANDARD_IA" })
      const source = stub.seed("a/src key", bytesOf(64), {
        tags: [{ Key: MARK_TAG, Value: "2026-01-01T00:00:00.000Z" }],
      })
      const result = yield* store.copy!(
        { key: "a/src key", version: source.versionId },
        { key: "a/dst", contentLength: 64, contentType: "image/png", metadata: { "edd-v": "1" } },
      )
      expect(result.size).toBe(64)
      const [input] = stub.inputs("CopyObject")
      expect(input).toMatchObject({
        Key: "a/dst",
        CopySource: `test-bucket/a/src%20key?versionId=${source.versionId}`,
        MetadataDirective: "REPLACE",
        TaggingDirective: "REPLACE",
        ContentType: "image/png",
        Metadata: { "edd-v": "1" },
        ChecksumAlgorithm: "CRC64NVME",
        StorageClass: "STANDARD_IA",
      })
      const copied = stub.version("a/dst", result.ref.version)!
      expect(copied.bytes).toEqual(bytesOf(64))
      // never the source's unreferenced-since mark
      expect(copied.tags).toEqual([])
    }),
  )

  it("encodes every key segment and the version of a CopySource", () => {
    expect(copySourceOf("b", { key: "p re+fix/ä%/k", version: "v/1+2" })).toBe(
      "b/p%20re%2Bfix/%C3%A4%25/k?versionId=v%2F1%2B2",
    )
    expect(copySourceOf("b", { key: "k", version: "" })).toBe("b/k")
  })

  it.effect("learns the source's size from HeadObject first when the request gives none", () =>
    Effect.gen(function* () {
      const { stub, store } = setup({}, {}, { maxCopyObjectBytes: 8 * MiB })
      const small = stub.seed("src", bytesOf(33))
      const result = yield* store.copy!(
        { key: "src", version: small.versionId },
        { key: "dst", contentLength: undefined, contentType: "x/y", metadata: {} },
      )
      expect(result.size).toBe(33)
      expect(stub.names()).toEqual(["HeadObject", "CopyObject"])
      expect(stub.inputs("HeadObject")[0]).toMatchObject({ Key: "src", VersionId: small.versionId })
      // The size picks the path: a source over the CopyObject limit is copied in parts.
      const large = stub.seed("big", bytesOf(12 * MiB))
      const copied = yield* store.copy!(
        { key: "big", version: large.versionId },
        { key: "dst2", contentLength: undefined, contentType: "x/y", metadata: {} },
      )
      expect(copied.size).toBe(12 * MiB)
      expect(stub.names().slice(2)).toEqual([
        "HeadObject",
        "CreateMultipartUpload",
        "UploadPartCopy",
        "UploadPartCopy",
        "UploadPartCopy",
        "CompleteMultipartUpload",
      ])
      expect(sameBytes(stub.version("dst2", copied.ref.version)?.bytes, bytesOf(12 * MiB))).toBe(
        true,
      )
      // A source that is gone fails before anything is written.
      const missing = failureOf(
        yield* Effect.exit(
          store.copy!(
            { key: "src", version: "v999999" },
            { key: "dst3", contentLength: undefined, contentType: "x/y", metadata: {} },
          ),
        ),
      )
      expect(missing).toMatchObject({ reason: "NotFound", ref: { key: "src", version: "v999999" } })
      expect(stub.names().slice(8)).toEqual(["HeadObject"])
      expect(stub.objects.get("dst3")).toBeUndefined()
    }),
  )

  it.effect("a missing source is NotFound, naming the source", () =>
    Effect.gen(function* () {
      const { store } = setup()
      const failure = failureOf(
        yield* Effect.exit(
          store.copy!(
            { key: "src", version: "v999999" },
            { key: "dst", contentLength: 1, contentType: "x/y", metadata: {} },
          ),
        ),
      )
      expect(failure).toMatchObject({ reason: "NotFound", ref: { key: "src", version: "v999999" } })
    }),
  )

  it.effect("a source over the CopyObject limit is copied in UploadPartCopy ranges", () =>
    Effect.gen(function* () {
      const { stub, store } = setup({}, {}, { maxCopyObjectBytes: 8 * MiB })
      const content = bytesOf(12 * MiB, 9)
      const source = stub.seed("src", content)
      const result = yield* store.copy!(
        { key: "src", version: source.versionId },
        { key: "dst", contentLength: content.length, contentType: "x/y", metadata: { m: "1" } },
      )
      expect(stub.names()).toEqual([
        "CreateMultipartUpload",
        "UploadPartCopy",
        "UploadPartCopy",
        "UploadPartCopy",
        "CompleteMultipartUpload",
      ])
      // No checksum algorithm: a server-side part carries none.
      expect(stub.inputs("CreateMultipartUpload")[0].ChecksumAlgorithm).toBeUndefined()
      expect(stub.inputs("UploadPartCopy").map((p) => p.CopySourceRange)).toEqual([
        `bytes=0-${5 * MiB - 1}`,
        `bytes=${5 * MiB}-${10 * MiB - 1}`,
        `bytes=${10 * MiB}-${12 * MiB - 1}`,
      ])
      expect(stub.inputs("CompleteMultipartUpload")[0].MpuObjectSize).toBe(12 * MiB)
      expect(result.size).toBe(12 * MiB)
      const copied = stub.version("dst", result.ref.version)!
      expect(sameBytes(copied.bytes, content)).toBe(true)
      expect(copied.metadata).toEqual({ m: "1" })
    }),
  )

  it.effect("a multipart copy that fails is aborted; a lost completion is completeLost", () =>
    Effect.gen(function* () {
      const failing = setup(
        {
          faults: (call) =>
            call.name === "UploadPartCopy" && call.input.PartNumber === 2
              ? { _tag: "fail", error: s3Error("AccessDenied", 403) }
              : undefined,
        },
        {},
        { maxCopyObjectBytes: 8 * MiB },
      )
      const source = failing.stub.seed("src", bytesOf(12 * MiB))
      const refusedCopy = failureOf(
        yield* Effect.exit(
          failing.store.copy!(
            { key: "src", version: source.versionId },
            { key: "dst", contentLength: 12 * MiB, contentType: "x/y", metadata: {} },
          ),
        ),
      )
      expect(refusedCopy).toMatchObject({ reason: "AccessDenied", ref: { key: "src" } })
      expect(failing.stub.names()).toContain("AbortMultipartUpload")
      expect(failing.stub.uploads.size).toBe(0)

      const lost = setup(
        {
          faults: (call) =>
            call.name === "CompleteMultipartUpload"
              ? { _tag: "lost", error: transportError() }
              : undefined,
        },
        {},
        { maxCopyObjectBytes: 8 * MiB },
      )
      const src = lost.stub.seed("src", bytesOf(12 * MiB))
      const lostCopy = failureOf(
        yield* Effect.exit(
          lost.store.copy!(
            { key: "src", version: src.versionId },
            { key: "dst", contentLength: 12 * MiB, contentType: "x/y", metadata: {} },
          ),
        ),
      )
      expect(lostCopy.completeLost).toBe(true)
    }),
  )

  it.effect("a multipart copy's Complete in flight at an interruption runs to its answer", () =>
    Effect.gen(function* () {
      const gate = makeGate()
      const { stub, store } = setup(
        { faults: (call) => (call.name === "CompleteMultipartUpload" ? gate.hold() : undefined) },
        {},
        { maxCopyObjectBytes: 8 * MiB },
      )
      const source = stub.seed("src", bytesOf(12 * MiB))
      const fiber = yield* Effect.forkChild(
        store.copy!(
          { key: "src", version: source.versionId },
          { key: "dst", contentLength: 12 * MiB, contentType: "x/y", metadata: {} },
        ),
      )
      yield* Effect.promise(() => gate.reached)
      const exit = yield* interruptWhileHeld(fiber, gate.release)
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      expect(stub.objects.get("dst")).toHaveLength(1)
      expect(stub.names()).not.toContain("AbortMultipartUpload")
    }),
  )
})

// ---------------------------------------------------------------------------
// get / head
// ---------------------------------------------------------------------------

describe("S3 store — get and head", () => {
  it.effect("reads a version as plain Uint8Array chunks", () =>
    Effect.gen(function* () {
      const { stub, store } = setup({ chunkBytes: 1_000 })
      const content = bytesOf(4_500)
      const version = stub.seed("k", content)
      const chunks = yield* Stream.runCollect(store.get({ key: "k", version: version.versionId }))
      expect(chunks.map((c) => c.length)).toEqual([1_000, 1_000, 1_000, 1_000, 500])
      // the SDK's Node Buffers, viewed as plain Uint8Arrays
      for (const chunk of chunks) expect(chunk.constructor).toBe(Uint8Array)
      expect(yield* collect(store.get({ key: "k", version: version.versionId }))).toEqual(content)
      expect(stub.inputs("GetObject")[0]).toEqual({
        Bucket: "test-bucket",
        Key: "k",
        VersionId: version.versionId,
      })
    }),
  )

  it.effect("reads ranges, an empty range at the end, and refuses one past it", () =>
    Effect.gen(function* () {
      const { stub, store } = setup()
      const content = bytesOf(100)
      const { versionId } = stub.seed("k", content)
      const ref: BlobRef = { key: "k", version: versionId }
      expect(yield* collect(store.get(ref, { range: { offset: 10, length: 5 } }))).toEqual(
        content.slice(10, 15),
      )
      expect(yield* collect(store.get(ref, { range: { offset: 95 } }))).toEqual(content.slice(95))
      expect(yield* collect(store.get(ref, { range: { offset: 90, length: 50 } }))).toEqual(
        content.slice(90),
      )
      expect(stub.inputs("GetObject").map((i) => i.Range)).toEqual([
        "bytes=10-14",
        "bytes=95-",
        "bytes=90-139",
      ])
      // At the very end: empty (S3's 416, diagnosed by the version's size).
      expect(yield* collect(store.get(ref, { range: { offset: 100 } }))).toEqual(new Uint8Array(0))
      // A zero-length range sends no Range (S3 would ignore an invalid one).
      expect(yield* collect(store.get(ref, { range: { offset: 40, length: 0 } }))).toEqual(
        new Uint8Array(0),
      )
      const past = failureOf(
        yield* Effect.exit(collect(store.get(ref, { range: { offset: 101 } }))),
      )
      expect(past).toMatchObject({ reason: "Rejected", ref })
      const zeroPast = failureOf(
        yield* Effect.exit(collect(store.get(ref, { range: { offset: 101, length: 0 } }))),
      )
      expect(zeroPast.reason).toBe("Rejected")
      const bad = failureOf(yield* Effect.exit(collect(store.get(ref, { range: { offset: -1 } }))))
      expect(bad.reason).toBe("Rejected")
    }),
  )

  it.effect("a missing version is NotFound; notFoundRetry retries it", () =>
    Effect.gen(function* () {
      const plain = setup()
      const missing = failureOf(
        yield* Effect.exit(collect(plain.store.get({ key: "k", version: "v1" }))),
      )
      expect(missing).toMatchObject({ reason: "NotFound", ref: { key: "k", version: "v1" } })

      let misses = 2
      const lagging = setup(
        {
          faults: (call) =>
            call.name === "GetObject" && misses-- > 0
              ? { _tag: "fail", error: s3Error("NoSuchVersion", 404) }
              : undefined,
        },
        { notFoundRetry: Schedule.recurs(3) },
      )
      const { versionId } = lagging.stub.seed("k", bytesOf(20))
      expect(yield* collect(lagging.store.get({ key: "k", version: versionId }))).toEqual(
        bytesOf(20),
      )
      expect(lagging.stub.inputs("GetObject")).toHaveLength(3)

      // Only NotFound is retried.
      const denied = setup(
        { faults: () => ({ _tag: "fail", error: s3Error("AccessDenied", 403) }) },
        { notFoundRetry: Schedule.recurs(3) },
      )
      const failure = failureOf(
        yield* Effect.exit(collect(denied.store.get({ key: "k", version: "v1" }))),
      )
      expect(failure.reason).toBe("AccessDenied")
      expect(denied.stub.inputs("GetObject")).toHaveLength(1)
    }),
  )

  it.effect("head returns the version's user metadata; a missing one is NotFound", () =>
    Effect.gen(function* () {
      const { stub, store } = setup()
      const { versionId } = stub.seed("k", bytesOf(5), {
        metadata: { "edd-v": "1", "edd-attr": "a" },
      })
      expect(yield* store.head!({ key: "k", version: versionId })).toEqual({
        "edd-v": "1",
        "edd-attr": "a",
      })
      const failure = failureOf(yield* Effect.exit(store.head!({ key: "k", version: "nope" })))
      expect(failure.reason).toBe("NotFound")
    }),
  )
})

// ---------------------------------------------------------------------------
// delete / list
// ---------------------------------------------------------------------------

describe("S3 store — delete and list", () => {
  it.effect("deletes by version in DeleteObjects requests of at most 1,000 keys", () =>
    Effect.gen(function* () {
      const { stub, store } = setup()
      const refs: Array<BlobRef> = Array.from({ length: 2_500 }, (_, i) => ({
        key: `k${i}`,
        version: `v${i}`,
      }))
      yield* store.delete([...refs, refs[0]!, refs[1]!])
      const requests = stub.inputs("DeleteObjects")
      expect(requests.map((r) => r.Delete.Objects.length)).toEqual([1_000, 1_000, 500])
      expect(requests[0].Delete.Quiet).toBe(true)
      expect(requests[0].Delete.Objects[0]).toEqual({ Key: "k0", VersionId: "v0" })
      yield* store.delete([])
      expect(stub.inputs("DeleteObjects")).toHaveLength(3)
    }),
  )

  it.effect("deletes the named versions only; a version already gone is deleted", () =>
    Effect.gen(function* () {
      const { stub, store } = setup()
      const a = stub.seed("k", bytesOf(1))
      const b = stub.seed("k", bytesOf(2))
      yield* store.delete([
        { key: "k", version: a.versionId },
        { key: "k", version: "v404404" },
      ])
      expect(stub.objects.get("k")?.map((v) => v.versionId)).toEqual([b.versionId])
      expect(stub.deleteMarkers.size).toBe(0)
    }),
  )

  it.effect(
    "per-key errors: NoSuchVersion is success, anything else fails naming the version",
    () =>
      Effect.gen(function* () {
        const { store } = setup({
          faults: (call) =>
            call.name === "DeleteObjects"
              ? {
                  _tag: "respond",
                  output: {
                    Errors: [
                      { Key: "a", VersionId: "1", Code: "NoSuchVersion" },
                      { Key: "b", VersionId: "2", Code: "AccessDenied", Message: "Object Lock" },
                      { Key: "c", VersionId: "3", Code: "InternalError" },
                    ],
                  },
                }
              : undefined,
        })
        const failure = failureOf(
          yield* Effect.exit(
            store.delete([
              { key: "a", version: "1" },
              { key: "b", version: "2" },
              { key: "c", version: "3" },
            ]),
          ),
        )
        expect(failure).toMatchObject({ reason: "AccessDenied", ref: { key: "b", version: "2" } })
        expect(String(failure.cause)).toMatch(
          /refused 2 of 3 versions: b@2 AccessDenied \(Object Lock\)/,
        )
      }),
  )

  it.effect(
    "lists every version under a prefix across pages, newest first, no delete markers",
    () =>
      Effect.gen(function* () {
        const { stub, store } = setup({ maxKeys: 2 })
        const a1 = stub.seed("p/a", bytesOf(1))
        const a2 = stub.seed("p/a", bytesOf(2))
        const b1 = stub.seed("p/b", bytesOf(3))
        const c1 = stub.seed("p/c", bytesOf(4))
        stub.seed("q/z", bytesOf(5))
        stub.deleteMarkers.set("p/d", 1)
        const listed = yield* Stream.runCollect(store.list!("p/"))
        expect(listed.map((l) => [l.ref.key, l.ref.version, l.size, l.isLatest])).toEqual([
          ["p/a", a2.versionId, 2, true],
          ["p/a", a1.versionId, 1, false],
          ["p/b", b1.versionId, 3, true],
          ["p/c", c1.versionId, 4, true],
        ])
        for (const listing of listed) expect(listing.lastModified).toBeInstanceOf(Date)
        expect(
          stub.inputs("ListObjectVersions").map((i) => [i.KeyMarker, i.VersionIdMarker]),
        ).toEqual([
          [undefined, undefined],
          ["p/a", a1.versionId],
        ])
        const after = yield* Stream.runCollect(store.list!("p/", { startAfter: "p/a" }))
        expect(after.map((l) => l.ref.key)).toEqual(["p/b", "p/c"])
        expect(stub.inputs("ListObjectVersions").at(-1)).toEqual({
          Bucket: "test-bucket",
          Prefix: "p/",
          KeyMarker: "p/a",
        })
      }),
  )

  it.effect("refuses a listing it cannot read (no date, a truncation without a marker)", () =>
    Effect.gen(function* () {
      const undated = setup({
        faults: () => ({
          _tag: "respond",
          output: { Versions: [{ Key: "k", VersionId: "1", Size: 1 }], IsTruncated: false },
        }),
      })
      const failure = failureOf(yield* Effect.exit(Stream.runCollect(undated.store.list!(""))))
      expect(failure.reason).toBe("Rejected")
      expect(String(failure.cause)).toMatch(/without a LastModified date/)
      const endless = setup({
        faults: () => ({ _tag: "respond", output: { Versions: [], IsTruncated: true } }),
      })
      const truncated = failureOf(yield* Effect.exit(Stream.runCollect(endless.store.list!(""))))
      expect(String(truncated.cause)).toMatch(/truncated without a next marker/)
    }),
  )
})

// ---------------------------------------------------------------------------
// marks
// ---------------------------------------------------------------------------

describe("S3 store — marks as version tags", () => {
  it.effect("sets, reads and clears the mark, keeping the version's other tags", () =>
    Effect.gen(function* () {
      const { stub, store } = setup()
      const version = stub.seed("k", bytesOf(3), { tags: [{ Key: "team", Value: "docs" }] })
      const ref = { key: "k", version: version.versionId }
      expect(yield* store.marks!.get(ref)).toEqual(Option.none())
      const since = new Date("2026-10-30T12:00:00.000Z")
      yield* store.marks!.set(ref, since)
      expect(version.tags).toEqual([
        { Key: "team", Value: "docs" },
        { Key: MARK_TAG, Value: "2026-10-30T12:00:00.000Z" },
      ])
      expect(yield* store.marks!.get(ref)).toEqual(Option.some(since))
      // set again: one mark
      yield* store.marks!.set(ref, new Date("2026-10-31T00:00:00.000Z"))
      expect(version.tags.filter((t) => t.Key === MARK_TAG)).toHaveLength(1)
      yield* store.marks!.clear(ref)
      expect(version.tags).toEqual([{ Key: "team", Value: "docs" }])
      // clearing an unmarked version writes nothing
      const puts = stub.inputs("PutObjectTagging").length
      yield* store.marks!.clear(ref)
      expect(stub.inputs("PutObjectTagging")).toHaveLength(puts)
      for (const input of stub.inputs("PutObjectTagging")) {
        expect(input.VersionId).toBe(version.versionId)
      }
    }),
  )

  it.effect("an absent version: get gives none, set and clear succeed", () =>
    Effect.gen(function* () {
      const { stub, store } = setup()
      const ref = { key: "gone", version: "v1" }
      expect(yield* store.marks!.get(ref)).toEqual(Option.none())
      yield* store.marks!.set(ref, new Date())
      yield* store.marks!.clear(ref)
      expect(stub.inputs("PutObjectTagging")).toHaveLength(0)
    }),
  )

  it.effect("an unreadable mark reads as none; an invalid date is refused", () =>
    Effect.gen(function* () {
      const { stub, store } = setup()
      const version = stub.seed("k", bytesOf(1), { tags: [{ Key: MARK_TAG, Value: "garbage" }] })
      const ref = { key: "k", version: version.versionId }
      expect(yield* store.marks!.get(ref)).toEqual(Option.none())
      const failure = failureOf(yield* Effect.exit(store.marks!.set(ref, new Date(Number.NaN))))
      expect(failure.reason).toBe("Rejected")
    }),
  )
})

// ---------------------------------------------------------------------------
// presign
// ---------------------------------------------------------------------------

describe("S3 store — presign", () => {
  it.effect("signs a GetObject of the version through the given presigner", () =>
    Effect.gen(function* () {
      const seen: Array<{ input: unknown; expiresIn: number; client: unknown }> = []
      const { stub, store } = setup(
        {},
        {
          presign: {
            getSignedUrl: async (client, command, options) => {
              seen.push({ input: command.input, expiresIn: options.expiresIn, client })
              return "https://signed.example/url"
            },
          },
        },
      )
      const url = yield* store.presign!(
        { key: "k", version: "v9" },
        { expiresIn: Duration.millis(90_500), contentType: "application/pdf" },
      )
      expect(url).toBe("https://signed.example/url")
      expect(seen).toEqual([
        {
          input: {
            Bucket: "test-bucket",
            Key: "k",
            VersionId: "v9",
            ResponseContentType: "application/pdf",
          },
          expiresIn: 91,
          client: stub.client,
        },
      ])
      const bad = failureOf(
        yield* Effect.exit(
          store.presign!({ key: "k", version: "v9" }, { expiresIn: Duration.zero }),
        ),
      )
      expect(bad.reason).toBe("Rejected")
    }),
  )

  it.effect("works with @aws-sdk/s3-request-presigner's getSignedUrl, locally", () =>
    Effect.gen(function* () {
      const client = new S3Client({
        region: "eu-west-1",
        credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" },
      })
      const store = makeService(
        resolveOptions("test", { bucket: "docs-blobs", client, presign: { getSignedUrl } }),
        client,
      )
      const url = new URL(
        yield* store.presign!(
          { key: "p/f/o", version: "abc" },
          { expiresIn: Duration.minutes(15) },
        ),
      )
      expect(url.hostname).toBe("docs-blobs.s3.eu-west-1.amazonaws.com")
      expect(url.pathname).toBe("/p/f/o")
      expect(url.searchParams.get("versionId")).toBe("abc")
      expect(url.searchParams.get("X-Amz-Expires")).toBe("900")
      client.destroy()
    }),
  )

  it.effect("a presigner that throws is Rejected", () =>
    Effect.gen(function* () {
      const { store } = setup(
        {},
        {
          presign: {
            getSignedUrl: async () => {
              throw new Error("expiry over a week")
            },
          },
        },
      )
      const failure = failureOf(
        yield* Effect.exit(
          store.presign!({ key: "k", version: "v" }, { expiresIn: Duration.days(8) }),
        ),
      )
      expect(failure.reason).toBe("Rejected")
    }),
  )
})

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

describe("S3 store — error classification", () => {
  it("maps S3 codes and statuses to reasons; a failure without a response is Unavailable", () => {
    const cases: ReadonlyArray<[unknown, string]> = [
      [s3Error("NoSuchVersion", 404), "NotFound"],
      [s3Error("NoSuchKey", 404), "NotFound"],
      [s3Error("NoSuchBucket", 404), "NotFound"],
      [s3Error("NotFound", 404), "NotFound"],
      [s3Error("NoSuchUpload", 404), "Rejected"],
      [s3Error("AccessDenied", 403), "AccessDenied"],
      [s3Error("SignatureDoesNotMatch", 403), "AccessDenied"],
      [s3Error("SlowDown", 503), "Throttled"],
      [s3Error("ServiceUnavailable", 503), "Throttled"],
      [s3Error("TooManyRequests", 429), "Throttled"],
      [s3Error("BadDigest", 400), "ChecksumMismatch"],
      [s3Error("XAmzContentChecksumMismatch", 400), "ChecksumMismatch"],
      [s3Error("InvalidDigest", 400), "ChecksumMismatch"],
      [s3Error("EntityTooLarge", 400), "TooLarge"],
      [s3Error("InternalError", 500), "Unavailable"],
      [s3Error("BadGateway", 502), "Unavailable"],
      [s3Error("InvalidArgument", 400), "Rejected"],
      [s3Error("InvalidRange", 416), "Rejected"],
      [transportError(), "Unavailable"],
      [Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }), "Unavailable"],
      ["a string", "Unavailable"],
    ]
    for (const [cause, reason] of cases) expect([cause, classify(cause)]).toEqual([cause, reason])
  })

  // #186: S3 answers a signature it can't match with the canonical request,
  // signed headers and all, and can echo a refused token back as `Token-0`.
  const TOKEN = "SENTINEL-SESSION-TOKEN"
  const refusals: ReadonlyArray<readonly [string, unknown]> = [
    [
      "SignatureDoesNotMatch",
      Object.assign(s3Error("SignatureDoesNotMatch", 403, "The request signature does not match"), {
        CanonicalRequest: `PUT\n/k\n\nx-amz-security-token:${TOKEN}\n`,
        StringToSign: "AWS4-HMAC-SHA256",
      }),
    ],
    [
      "ExpiredToken",
      Object.assign(s3Error("ExpiredToken", 400, "The provided token has expired."), {
        "Token-0": TOKEN,
      }),
    ],
    [
      "InvalidToken",
      Object.assign(s3Error("InvalidToken", 400, "The provided token is malformed."), {
        "Token-0": TOKEN,
      }),
    ],
    [
      "InvalidAccessKeyId",
      Object.assign(
        s3Error("InvalidAccessKeyId", 403, "The AWS access key Id you provided does not exist."),
        { "Token-0": TOKEN },
      ),
    ],
    [
      "TokenRefreshRequired",
      Object.assign(s3Error("TokenRefreshRequired", 400, "The provided token must be refreshed."), {
        "Token-0": TOKEN,
      }),
    ],
  ]
  const rendered = (failure: BlobStoreFailure): ReadonlyArray<string> => [
    String(failure.cause),
    JSON.stringify(failure),
    inspect(failure, { depth: 8 }),
    Cause.pretty(Cause.fail(failure)),
  ]

  it.effect.each(refusals)("S3's %s reply is kept off every failure", ([name, error]) =>
    Effect.gen(function* () {
      const { stub, store } = setup({ faults: () => ({ _tag: "fail", error }) })
      const { versionId } = stub.seed("k", bytesOf(5))
      const ref = { key: "k", version: versionId }
      const failures = [
        failureOf(yield* Effect.exit(store.put(request("k", bytesOf(5))))),
        failureOf(yield* Effect.exit(store.put(request("m", bytesOf(11 * MiB))))),
        failureOf(yield* Effect.exit(collect(store.get(ref)))),
        failureOf(yield* Effect.exit(store.delete([ref]))),
      ]
      for (const failure of failures) {
        expect((failure.cause as Error).name).toBe(name)
        expect((failure.cause as Error).message).toBe(REDACTED_REPLY)
        for (const text of rendered(failure)) expect(text).not.toContain(TOKEN)
      }
      // Classification still reads the name and status.
      expect(failures[0]?.reason).toBe(
        name === "SignatureDoesNotMatch" || name === "InvalidAccessKeyId"
          ? "AccessDenied"
          : "Rejected",
      )
    }),
  )

  it.effect("a refusal met reading a body, or signing a URL, is kept off the failure too", () =>
    Effect.gen(function* () {
      const error = Object.assign(s3Error("ExpiredToken", 400, "The provided token has expired."), {
        "Token-0": TOKEN,
      })
      const { stub, store } = setup(
        {
          faults: (call) =>
            call.name === "GetObject"
              ? {
                  _tag: "respond",
                  output: {
                    ContentLength: 5,
                    VersionId: versionOf.current,
                    Body: {
                      transformToWebStream: () =>
                        new ReadableStream<Uint8Array>({
                          pull: (controller) => controller.error(error),
                        }),
                    },
                  },
                }
              : undefined,
        },
        {
          presign: {
            getSignedUrl: async () => {
              throw error
            },
          },
        },
      )
      const versionOf = { current: stub.seed("k", bytesOf(5)).versionId }
      const ref = { key: "k", version: versionOf.current }
      const failures = [
        failureOf(yield* Effect.exit(collect(store.get(ref)))),
        failureOf(yield* Effect.exit(store.presign!(ref, { expiresIn: Duration.minutes(1) }))),
      ]
      for (const failure of failures) {
        expect((failure.cause as Error).name).toBe("ExpiredToken")
        expect((failure.cause as Error).message).toBe(REDACTED_REPLY)
        for (const text of rendered(failure)) expect(text).not.toContain(TOKEN)
      }
    }),
  )

  it.effect("any other refusal keeps S3's reply as the cause", () =>
    Effect.gen(function* () {
      const error = s3Error("AccessDenied", 403, "User is not authorized to perform s3:PutObject")
      const { store } = setup({ faults: () => ({ _tag: "fail", error }) })
      const failure = failureOf(yield* Effect.exit(store.put(request("k", bytesOf(5)))))
      expect(failure.cause).toBe(error)
    }),
  )
})

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

describe("S3 store — layers", () => {
  it.effect("layer provides it as the BlobStore service, over the caller's client", () =>
    Effect.gen(function* () {
      const stub = makeStubS3()
      const destroy = vi.fn()
      stub.client.destroy = destroy
      const store = yield* Effect.scoped(
        Effect.gen(function* () {
          return yield* BlobStore
        }).pipe(
          Effect.provide(
            S3BlobStore.layer({ bucket: "test-bucket", prefix: "x/", client: stub.client }),
          ),
        ),
      )
      expect(store.name).toBe("s3://test-bucket/x/")
      yield* store.put(request("x/k", bytesOf(4)))
      expect(stub.names()).toEqual(["PutObject"])
      // The caller owns its client.
      expect(destroy).not.toHaveBeenCalled()
    }),
  )

  it.effect("make builds and owns a client from clientConfig, destroying it with the scope", () =>
    Effect.gen(function* () {
      const destroy = vi.spyOn(S3Client.prototype, "destroy")
      try {
        const scope = yield* Scope.make()
        const store = yield* S3BlobStore.make({
          bucket: "b",
          clientConfig: {
            region: "us-east-1",
            credentials: { accessKeyId: "a", secretAccessKey: "s" },
          },
        }).pipe(Scope.provide(scope))
        expect(store.name).toBe("s3://b/")
        expect(destroy).not.toHaveBeenCalled()
        yield* Scope.close(scope, Exit.void)
        expect(destroy).toHaveBeenCalledTimes(1)
      } finally {
        destroy.mockRestore()
      }
    }),
  )

  it.effect("layerConfig reads its settings from Config, defaulting the optional ones", () =>
    Effect.gen(function* () {
      const store = yield* Effect.scoped(
        Effect.gen(function* () {
          return yield* BlobStore
        }).pipe(
          Effect.provide(
            S3BlobStore.layerConfig({
              bucket: Config.String("BLOB_BUCKET"),
              prefix: Config.String("BLOB_PREFIX"),
              region: Config.String("BLOB_REGION"),
              endpoint: Config.String("BLOB_ENDPOINT"),
              forcePathStyle: Config.Boolean("BLOB_PATH_STYLE"),
              readConcurrency: Config.Int("BLOB_READS"),
              writeConcurrency: Config.Int("BLOB_WRITES"),
              maxUploadAge: Config.Duration("BLOB_MAX_UPLOAD_AGE"),
            }),
          ),
          Effect.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({
                BLOB_BUCKET: "docs",
                BLOB_PREFIX: "prod/",
                BLOB_REGION: "us-east-1",
                BLOB_ENDPOINT: "http://127.0.0.1:1",
                BLOB_PATH_STYLE: "true",
                BLOB_READS: "4",
                BLOB_MAX_UPLOAD_AGE: "2 hours",
              }),
            ),
          ),
        ),
      )
      expect(store.name).toBe("s3://docs/prod/")
      expect(store.readConcurrency).toBe(4)
      // missing: the default
      expect(store.writeConcurrency).toBe(8)
      expect(Duration.toMillis(store.maxUploadAge)).toBe(7_200_000)

      const invalid = yield* Effect.exit(
        Effect.scoped(
          Effect.gen(function* () {
            return yield* BlobStore
          }).pipe(
            Effect.provide(
              S3BlobStore.layerConfig({
                bucket: Config.String("BLOB_BUCKET"),
                partSize: Config.Int("BLOB_PART_SIZE"),
                clientConfig: { region: "us-east-1" },
              }),
            ),
            Effect.provide(
              ConfigProvider.layer(
                ConfigProvider.fromUnknown({ BLOB_BUCKET: "docs", BLOB_PART_SIZE: "1024" }),
              ),
            ),
          ),
        ),
      )
      // Invalid settings are [EDD-9116] defects when the layer is built.
      expect(Exit.isFailure(invalid) && Cause.hasDies(invalid.cause)).toBe(true)
      expect(Exit.isFailure(invalid) ? Cause.pretty(invalid.cause) : "").toMatch(
        /\[EDD-9116\] S3BlobStore\.layerConfig: partSize/,
      )
    }),
  )

  it.effect("layerConfig reads credentials as DynamoClient.layerConfig does", () =>
    Effect.gen(function* () {
      const credentials = Config.all({
        accessKeyId: Config.String("BLOB_KEY"),
        secretAccessKey: Config.String("BLOB_SECRET"),
        sessionToken: Config.String("BLOB_TOKEN").pipe(Config.withDefault(undefined)),
      })
      const built = (values: Record<string, string>) =>
        Effect.exit(
          Effect.scoped(
            Effect.gen(function* () {
              return yield* BlobStore
            }).pipe(
              Effect.provide(
                S3BlobStore.layerConfig({
                  bucket: Config.String("BLOB_BUCKET"),
                  credentials,
                  clientConfig: { region: "us-east-1", endpoint: "http://127.0.0.1:1" },
                }),
              ),
              Effect.provide(
                ConfigProvider.layer(
                  ConfigProvider.fromUnknown({ BLOB_BUCKET: "docs", ...values }),
                ),
              ),
            ),
          ),
        )
      // None given: the SDK's default chain. All given, a token included: the store is built.
      expect(Exit.isSuccess(yield* built({}))).toBe(true)
      expect(
        Exit.isSuccess(yield* built({ BLOB_KEY: "AKID", BLOB_SECRET: "s", BLOB_TOKEN: "t" })),
      ).toBe(true)
      // A key without its secret is never signed by the default chain's identity.
      const partial = yield* built({ BLOB_KEY: "AKID" })
      expect(Exit.isFailure(partial)).toBe(true)
      expect(Exit.isFailure(partial) ? Cause.pretty(partial.cause) : "").toContain("BLOB_SECRET")
    }),
  )
})
