/**
 * @internal The S3 `BlobStore` (#179, design §12.2) behind
 * `effect-dynamodb/blob/s3`, written directly against `@aws-sdk/client-s3`
 * (an optional peer dependency; the main entry never imports this module).
 *
 * - **Versions.** Every upload — `PutObject`, `CompleteMultipartUpload`,
 *   `CopyObject` — must answer with a real `VersionId`. A missing one (a
 *   bucket never versioned, or a suspended one on MinIO) or `"null"` (a
 *   suspended bucket on AWS) fails with `Unversioned`, after the object it
 *   wrote is deleted by `VersionId: "null"` (no delete marker), or by a plain
 *   `DeleteObject` when that is refused. No `GetBucketVersioning` pre-check.
 * - **Checksums.** Every upload carries the library's CRC-64/NVME
 *   (`ChecksumAlgorithm: "CRC64NVME"` and the value; never the SDK's CRC32
 *   default): a single `PutObject` the body's, a multipart upload each part's
 *   and the whole body's (`ChecksumType: "FULL_OBJECT"`), which S3 validates.
 * - **Multipart** runs the shared driver (`internal/Multipart.ts`, design §7):
 *   parts of exactly `partSize` bytes at `uploadConcurrency`, aborted on any
 *   failure or interruption between create and complete. A completion that
 *   may have happened although it failed (a lost or throttled response, a
 *   transport failure, a retry finding `NoSuchUpload`, any refusal after the
 *   SDK resent it) is `completeLost`.
 * - **Reads** stream `GetObject` by `VersionId` (and `Range`) through
 *   `transformToWebStream()`, runtime-neutral; the library verifies sizes and
 *   checksums itself (design §8.6).
 * - **Deletes** by `VersionId` through `DeleteObjects`, up to 1,000 a request;
 *   a version already gone counts as deleted.
 * - **Listing** is `ListObjectVersions` (delete markers excluded), **head**
 *   `HeadObject`, and **marks** the version's `edd-unref-since` tag, merged
 *   with any other tags it has (design §11.4).
 *
 * SDK errors become `BlobStoreFailure`s by {@link classify}; the SDK error is
 * the `cause`, after `redactCredentialRefusal` (#186) replaces a signature or
 * credential refusal, whose reply can quote the session token.
 *
 * Not part of the public API (`effect-dynamodb/blob/s3` is).
 */

import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  type CompleteMultipartUploadCommandOutput,
  CopyObjectCommand,
  type CopyObjectCommandOutput,
  CreateMultipartUploadCommand,
  type CreateMultipartUploadCommandOutput,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  type DeleteObjectsCommandOutput,
  GetObjectCommand,
  type GetObjectCommandOutput,
  GetObjectTaggingCommand,
  type GetObjectTaggingCommandOutput,
  HeadObjectCommand,
  type HeadObjectCommandOutput,
  ListObjectVersionsCommand,
  type ListObjectVersionsCommandOutput,
  type ObjectVersion,
  PutObjectCommand,
  type PutObjectCommandOutput,
  PutObjectTaggingCommand,
  S3Client,
  type S3ClientConfig,
  type ServerSideEncryption,
  type StorageClass,
  type Tag,
  UploadPartCommand,
  type UploadPartCommandOutput,
  UploadPartCopyCommand,
  type UploadPartCopyCommandOutput,
} from "@aws-sdk/client-s3"
import type { BlobStoreReason } from "@effect-dynamodb/schema/Errors.js"
import type { BlobRef } from "@effect-dynamodb/schema/internal/BlobPointer.js"
import { crc64nvme } from "@effect-dynamodb/schema/internal/Crc64Nvme.js"
import { Cause, Duration, Effect, Exit, Option, Schedule, type Scope, Stream } from "effect"
import { Base64 } from "effect/encoding"
import {
  type BlobCopyRequest,
  type BlobListing,
  type BlobPresignOptions,
  type BlobPutRequest,
  type BlobPutResult,
  BlobStoreFailure,
  type BlobStoreMarks,
  type BlobStoreService,
  type ByteRange,
  checkMaxUploadAgeOption,
  checkPositiveInteger,
  checkPrefix,
  DEFAULT_READ_CONCURRENCY,
  DEFAULT_WRITE_CONCURRENCY,
  invalid,
} from "../internal/BlobStoreContract.js"
import { redactCredentialRefusal } from "../internal/CredentialRefusal.js"
import * as Multipart from "../internal/Multipart.js"

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Server-side encryption settings every upload passes through to S3. */
export interface S3ServerSideEncryption {
  readonly ServerSideEncryption?: ServerSideEncryption | undefined
  readonly SSEKMSKeyId?: string | undefined
  readonly BucketKeyEnabled?: boolean | undefined
}

/**
 * The presigner the store signs GET URLs with: `getSignedUrl` from
 * `@aws-sdk/s3-request-presigner`, which the library never imports.
 */
export type S3GetSignedUrl = (
  client: S3Client,
  command: GetObjectCommand,
  options: { readonly expiresIn: number },
) => Promise<string>

/** Options of the S3 store. */
export interface S3BlobStoreOptions {
  /** The bucket. It must have versioning enabled: every upload is checked. */
  readonly bucket: string
  /**
   * The store prefix (default `""`): at most 256 UTF-8 bytes, not starting
   * with `/`; ends with `/` by convention. An entity's `offload.prefix`
   * replaces it for that entity.
   */
  readonly prefix?: string | undefined
  /** An `S3Client` the caller owns. Give this or `clientConfig`, not both. */
  readonly client?: S3Client | undefined
  /**
   * The configuration of an `S3Client` the store builds and owns (destroyed
   * with the layer's scope): `region`, `credentials`, `endpoint` and
   * `forcePathStyle` (MinIO), …. It defaults `responseChecksumValidation` to
   * `"WHEN_REQUIRED"`, since the library verifies every full read itself.
   */
  readonly clientConfig?: S3ClientConfig | undefined
  /** Bytes per multipart part (default 8 MiB): from 5 MiB to 5 GiB. */
  readonly partSize?: number | undefined
  /** Parts of one upload sent at once (default 4). */
  readonly uploadConcurrency?: number | undefined
  /** Concurrent reads per operation (default 16). */
  readonly readConcurrency?: number | undefined
  /** Concurrent uploads per operation (default 8). */
  readonly writeConcurrency?: number | undefined
  /**
   * An upload not committed by this age after it started fails with
   * `Expired` (default 1 hour, from 1 minute to 7 days). Every process writing
   * or collecting against the bucket configures the same value.
   */
  readonly maxUploadAge?: Duration.Input | undefined
  /** Passed through to every upload (`PutObject`, `CreateMultipartUpload`, `CopyObject`). */
  readonly serverSideEncryption?: S3ServerSideEncryption | undefined
  /** Passed through to every upload. */
  readonly storageClass?: StorageClass | undefined
  /**
   * Retries a read that finds no such version (default none) — for a replica
   * region whose bucket may lag the writer's (design §16).
   */
  readonly notFoundRetry?: Schedule.Schedule<unknown, BlobStoreFailure> | undefined
  /** Implements `presign` (`BlobHandle.presignedUrl`). */
  readonly presign?: { readonly getSignedUrl: S3GetSignedUrl } | undefined
}

/** Knobs the tests turn; not options. */
export interface S3Tuning {
  /** Above this many bytes a copy runs as a multipart `UploadPartCopy` (S3: 5 GiB). */
  readonly maxCopyObjectBytes: number
  /** The most parts of an upload (S3: 10,000). */
  readonly maxParts: number
}

/** S3's largest `CopyObject` source, 5 GiB. */
export const MAX_COPY_OBJECT_BYTES = 5 * 1024 * 1024 * 1024

/** S3's longest `VersionId`, in bytes (F10). */
export const MAX_S3_VERSION_BYTES = 1_024

/** The version tag an unreferenced-since mark is (design §11.4). */
export const MARK_TAG = "edd-unref-since"

const DEFAULT_TUNING: S3Tuning = {
  maxCopyObjectBytes: MAX_COPY_OBJECT_BYTES,
  maxParts: Multipart.MAX_PARTS,
}

const OPTION_KEYS: ReadonlySet<string> = new Set([
  "bucket",
  "prefix",
  "client",
  "clientConfig",
  "partSize",
  "uploadConcurrency",
  "readConcurrency",
  "writeConcurrency",
  "maxUploadAge",
  "serverSideEncryption",
  "storageClass",
  "notFoundRetry",
  "presign",
])

const SSE_KEYS: ReadonlySet<string> = new Set([
  "ServerSideEncryption",
  "SSEKMSKeyId",
  "BucketKeyEnabled",
])

/** Validated options. */
export interface ResolvedOptions {
  readonly bucket: string
  readonly prefix: string
  readonly client: S3Client | undefined
  readonly clientConfig: S3ClientConfig | undefined
  readonly partSize: number
  readonly uploadConcurrency: number
  readonly readConcurrency: number
  readonly writeConcurrency: number
  readonly maxUploadAge: Duration.Duration
  readonly serverSideEncryption: S3ServerSideEncryption
  readonly storageClass: StorageClass | undefined
  readonly notFoundRetry: Schedule.Schedule<unknown, BlobStoreFailure> | undefined
  readonly presign: { readonly getSignedUrl: S3GetSignedUrl } | undefined
}

const show = (value: unknown): string =>
  typeof value === "string" ? JSON.stringify(value) : String(value)

/**
 * Check the options.
 *
 * @throws `[EDD-9116]` for an unknown key; an empty `bucket`; a `prefix` over
 *   256 bytes or starting with `/`; both `client` and `clientConfig`, or a
 *   `client` without `send`; a `partSize` that is not an integer from 5 MiB to
 *   5 GiB; a concurrency that is not a positive integer; a `maxUploadAge`
 *   outside 1 minute … 7 days; `serverSideEncryption` with another key;
 *   `storageClass` that is not a non-empty string; `notFoundRetry` that is
 *   not a `Schedule`; `presign` without a `getSignedUrl` function.
 */
export const resolveOptions = (where: string, options: S3BlobStoreOptions): ResolvedOptions => {
  if (typeof options !== "object" || options === null) {
    return invalid(where, `options must be an object, got ${show(options)}.`)
  }
  for (const key of Object.keys(options)) {
    if (!OPTION_KEYS.has(key)) {
      invalid(where, `unknown option "${key}" (expected ${[...OPTION_KEYS].join(", ")}).`)
    }
  }
  const bucket = options.bucket
  if (typeof bucket !== "string" || bucket.length === 0) {
    invalid(where, `bucket must be a non-empty string, got ${show(bucket)}.`)
  }
  const prefix = checkPrefix(where, "prefix", options.prefix ?? "")
  const client = options.client
  if (client !== undefined) {
    if (options.clientConfig !== undefined) {
      invalid(where, "give client or clientConfig, not both.")
    }
    if (typeof client !== "object" || client === null || typeof client.send !== "function") {
      invalid(where, "client must be an S3Client.")
    }
  }
  const clientConfig = options.clientConfig
  if (clientConfig !== undefined && (typeof clientConfig !== "object" || clientConfig === null)) {
    invalid(where, "clientConfig must be an S3ClientConfig object.")
  }
  const partSize = options.partSize ?? Multipart.DEFAULT_PART_SIZE
  if (
    typeof partSize !== "number" ||
    !Number.isSafeInteger(partSize) ||
    partSize < Multipart.MIN_PART_SIZE ||
    partSize > Multipart.MAX_PART_SIZE
  ) {
    invalid(where, `partSize must be an integer from 5 MiB to 5 GiB, got ${show(partSize)}.`)
  }
  const uploadConcurrency = checkPositiveInteger(
    where,
    "uploadConcurrency",
    options.uploadConcurrency ?? Multipart.DEFAULT_UPLOAD_CONCURRENCY,
  )
  const readConcurrency = checkPositiveInteger(
    where,
    "readConcurrency",
    options.readConcurrency ?? DEFAULT_READ_CONCURRENCY,
  )
  const writeConcurrency = checkPositiveInteger(
    where,
    "writeConcurrency",
    options.writeConcurrency ?? DEFAULT_WRITE_CONCURRENCY,
  )
  const maxUploadAge = checkMaxUploadAgeOption(where, options.maxUploadAge)
  const sse = options.serverSideEncryption ?? {}
  if (typeof sse !== "object" || sse === null) {
    invalid(where, "serverSideEncryption must be an object.")
  }
  for (const key of Object.keys(sse)) {
    if (!SSE_KEYS.has(key)) {
      invalid(
        where,
        `serverSideEncryption has an unknown key "${key}" (expected ${[...SSE_KEYS].join(", ")}).`,
      )
    }
  }
  const storageClass = options.storageClass
  if (
    storageClass !== undefined &&
    (typeof storageClass !== "string" || (storageClass as string).length === 0)
  ) {
    invalid(where, `storageClass must be a non-empty string, got ${show(storageClass)}.`)
  }
  const notFoundRetry = options.notFoundRetry
  if (notFoundRetry !== undefined && !Schedule.isSchedule(notFoundRetry)) {
    invalid(where, "notFoundRetry must be a Schedule.")
  }
  const presign = options.presign
  if (
    presign !== undefined &&
    (typeof presign !== "object" || presign === null || typeof presign.getSignedUrl !== "function")
  ) {
    invalid(where, "presign must be { getSignedUrl } (from @aws-sdk/s3-request-presigner).")
  }
  return {
    bucket,
    prefix,
    client,
    clientConfig,
    partSize,
    uploadConcurrency,
    readConcurrency,
    writeConcurrency,
    maxUploadAge,
    serverSideEncryption: sse,
    storageClass,
    notFoundRetry,
    presign,
  }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** The S3 error code of an SDK error (its `name`, or its `Code`). */
export const errorCode = (cause: unknown): string | undefined => {
  if (typeof cause !== "object" || cause === null) return undefined
  const { name, Code } = cause as { readonly name?: unknown; readonly Code?: unknown }
  if (typeof Code === "string" && Code !== "") return Code
  return typeof name === "string" && name !== "" && name !== "Error" ? name : undefined
}

/** The HTTP status of an SDK error's response, when it had one. */
export const httpStatus = (cause: unknown): number | undefined => {
  const status = (cause as { readonly $metadata?: { readonly httpStatusCode?: unknown } } | null)
    ?.$metadata?.httpStatusCode
  return typeof status === "number" ? status : undefined
}

/** How many times the SDK sent the request that failed (`$metadata.attempts`), when it says. */
export const sdkAttempts = (cause: unknown): number | undefined => {
  const attempts = (cause as { readonly $metadata?: { readonly attempts?: unknown } } | null)
    ?.$metadata?.attempts
  return typeof attempts === "number" ? attempts : undefined
}

const NOT_FOUND: ReadonlySet<string> = new Set(["NoSuchVersion", "NoSuchKey", "NoSuchBucket"])
const THROTTLED: ReadonlySet<string> = new Set([
  "SlowDown",
  "Throttling",
  "ThrottlingException",
  "TooManyRequests",
  "TooManyRequestsException",
])
const CHECKSUM: ReadonlySet<string> = new Set([
  "BadDigest",
  "XAmzContentChecksumMismatch",
  "InvalidDigest",
])
/** A version (or key) already gone: deleting it, or reading its tags, finds nothing. */
const GONE: ReadonlySet<string> = new Set(["NoSuchVersion", "NoSuchKey"])

/**
 * The reason of an S3 error code and the HTTP status it came with:
 * `NotFound` for `NoSuchVersion` / `NoSuchKey` / `NoSuchBucket` (and a
 * `HeadObject` 404, which has no body to name it); `AccessDenied` (any 403);
 * `Throttled` for `SlowDown` and 503 / 429; `ChecksumMismatch` for
 * `BadDigest` / `XAmzContentChecksumMismatch` / `InvalidDigest`; `TooLarge`
 * for `EntityTooLarge`; `Unavailable` for other 5xx and for a failure without
 * a response (transport, after the SDK's retries: no code and no status);
 * `Rejected` for any other 4xx. A code without a status is a per-key error
 * of a `DeleteObjects` response.
 */
export const classifyCode = (
  code: string | undefined,
  status: number | undefined,
): BlobStoreReason => {
  if (code !== undefined) {
    if (NOT_FOUND.has(code)) return "NotFound"
    if (code === "AccessDenied") return "AccessDenied"
    if (THROTTLED.has(code)) return "Throttled"
    if (CHECKSUM.has(code)) return "ChecksumMismatch"
    if (code === "EntityTooLarge") return "TooLarge"
  }
  if (status === undefined) {
    if (code === undefined) return "Unavailable"
    return code === "InternalError" || code === "ServiceUnavailable" ? "Unavailable" : "Rejected"
  }
  if (status === 404 && code === "NotFound") return "NotFound"
  if (status === 503 || status === 429) return "Throttled"
  if (status === 403) return "AccessDenied"
  if (status >= 500) return "Unavailable"
  if (status >= 400) return "Rejected"
  return "Unavailable"
}

/** The reason of an SDK error. */
export const classify = (cause: unknown): BlobStoreReason => {
  const status = httpStatus(cause)
  // A failure without a response (a timeout, a reset, an abort) is a
  // transport one, whatever its name.
  return classifyCode(status === undefined ? undefined : errorCode(cause), status)
}

const failure = (cause: unknown, ref?: BlobRef): BlobStoreFailure =>
  new BlobStoreFailure({ reason: classify(cause), ref, cause })

const refused = (message: string, ref?: BlobRef): BlobStoreFailure =>
  new BlobStoreFailure({ reason: "Rejected", ref, cause: new Error(message) })

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The `VersionId` of a ref (none for version `""`, an immutable key). */
const versionIdOf = (ref: BlobRef): { readonly VersionId?: string } =>
  ref.version === "" ? {} : { VersionId: ref.version }

/** A `CopySource` naming `ref` of `bucket`: each key segment URL-encoded. */
export const copySourceOf = (bucket: string, ref: BlobRef): string => {
  const path = ref.key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")
  const version = ref.version === "" ? "" : `?versionId=${encodeURIComponent(ref.version)}`
  return `${bucket}/${path}${version}`
}

/** The `Range` header of `range` (its length positive). */
const rangeHeader = (range: ByteRange): string =>
  range.length === undefined
    ? `bytes=${range.offset}-`
    : `bytes=${range.offset}-${range.offset + range.length - 1}`

const checkRange = (range: ByteRange): string | undefined => {
  const { offset, length } = range
  if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) {
    return `range offset ${String(offset)} is not a non-negative integer`
  }
  if (
    length !== undefined &&
    (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0)
  ) {
    return `range length ${String(length)} is not a non-negative integer`
  }
  return undefined
}

/** A chunk as a plain `Uint8Array` (a Node `Buffer` viewed, not copied). */
const plain = (chunk: Uint8Array): Uint8Array =>
  chunk.constructor === Uint8Array
    ? chunk
    : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)

const chunked = <A>(items: ReadonlyArray<A>, size: number): Array<ReadonlyArray<A>> => {
  const out: Array<ReadonlyArray<A>> = []
  for (let at = 0; at < items.length; at += size) out.push(items.slice(at, at + size))
  return out
}

/** At most this many keys per `DeleteObjects` request (S3's limit). */
export const MAX_DELETE_KEYS = 1_000

/** A part of a multipart upload, as `CompleteMultipartUpload` names it. */
interface S3Part {
  readonly number: number
  readonly etag: string
  readonly checksum: string | undefined
  readonly size: number
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

/**
 * The store over `client`.
 */
export const makeService = (
  options: ResolvedOptions,
  client: S3Client,
  tuning: S3Tuning = DEFAULT_TUNING,
): BlobStoreService => {
  const { bucket, prefix, partSize, uploadConcurrency } = options
  const name = `s3://${bucket}/${prefix}`
  const uploadSettings = {
    ...options.serverSideEncryption,
    ...(options.storageClass === undefined ? {} : { StorageClass: options.storageClass }),
  }

  const send = <O>(
    command: object,
    onError: (cause: unknown) => BlobStoreFailure,
  ): Effect.Effect<O, BlobStoreFailure> =>
    Effect.tryPromise({
      try: (signal) =>
        (
          client as unknown as {
            readonly send: (
              command: object,
              options: { readonly abortSignal: AbortSignal },
            ) => Promise<O>
          }
        ).send(command, { abortSignal: signal }),
      catch: (cause) => onError(redactCredentialRefusal(cause)),
    })

  // -------------------------------------------------------------------------
  // Unversioned answers
  // -------------------------------------------------------------------------

  /**
   * Delete the object an upload wrote to a bucket that gave it no real
   * version: by `VersionId: "null"` (removes exactly it, no delete marker),
   * else a plain `DeleteObject` (in a suspended bucket that leaves a `null`
   * delete marker, harmless). Never fails: says what it did.
   */
  const deleteUnversioned = (key: string): Effect.Effect<string> =>
    send(new DeleteObjectCommand({ Bucket: bucket, Key: key, VersionId: "null" }), (cause) =>
      failure(cause),
    ).pipe(
      Effect.as("The object it wrote was deleted."),
      Effect.catch((byVersion) =>
        send(new DeleteObjectCommand({ Bucket: bucket, Key: key }), (cause) => failure(cause)).pipe(
          Effect.as("The object it wrote was deleted (a null delete marker may remain)."),
          Effect.catch((plainDelete) =>
            Effect.logWarning(
              `effect-dynamodb: ${name} could not delete "${key}", written to an unversioned ` +
                "bucket; delete it by hand",
              byVersion.cause,
              plainDelete.cause,
            ).pipe(
              Effect.as(
                `Deleting the object it wrote failed (${String(plainDelete.cause)}); delete it by hand.`,
              ),
            ),
          ),
        ),
      ),
    )

  /**
   * The version an upload's answer names, or — when it names none (or
   * `"null"`) — `Unversioned`, after deleting what it wrote.
   */
  const versionOf = (
    version: string | undefined,
    key: string,
    action: string,
  ): Effect.Effect<string, BlobStoreFailure> => {
    if (version !== undefined && version !== "" && version !== "null") {
      return Effect.succeed(version)
    }
    return Effect.uninterruptible(
      Effect.flatMap(deleteUnversioned(key), (cleanup) =>
        Effect.fail(
          new BlobStoreFailure({
            reason: "Unversioned",
            cause: new Error(
              `${name}: ${action} of "${key}" returned ` +
                (version === "null" ? 'VersionId "null"' : "no VersionId") +
                `: bucket "${bucket}" does not have versioning enabled. Offloaded values are ` +
                `pinned by version: enable versioning on the bucket. ${cleanup}`,
            ),
          }),
        ),
      ),
    )
  }

  // -------------------------------------------------------------------------
  // put
  // -------------------------------------------------------------------------

  const tooLarge = (request: Multipart.PartRequest, cause: unknown): BlobStoreFailure =>
    new BlobStoreFailure({
      reason: "TooLarge",
      cause: new Error(
        `${name}: the body needs more than ${tuning.maxParts} parts of ${request.partSize} ` +
          "bytes; give its length (Offload.source(stream, { contentLength })) so the part size " +
          `adapts, or raise partSize (${String(cause)})`,
      ),
    })

  /**
   * A failed `CompleteMultipartUpload`, `completeLost` unless S3 refused it
   * outright: a 4xx other than 429 and `NoSuchUpload`, on the SDK's only
   * attempt (`$metadata.attempts === 1`). A lost or throttled response, a
   * transport failure, a retry finding the upload gone, or any refusal of a
   * resent request (an earlier attempt may have completed, its answer lost)
   * may each follow a completion nobody reported — as may a refusal whose
   * attempt count is not reported.
   */
  const completeFailure = (cause: unknown): BlobStoreFailure => {
    const status = httpStatus(cause)
    const refusedOutright =
      sdkAttempts(cause) === 1 &&
      status !== undefined &&
      status >= 400 &&
      status < 500 &&
      status !== 429 &&
      errorCode(cause) !== "NoSuchUpload"
    return new BlobStoreFailure({
      reason: classify(cause),
      ...(refusedOutright ? {} : { completeLost: true }),
      cause,
    })
  }

  const createUpload = (
    key: string,
    headers: object,
    checksums: boolean,
  ): Effect.Effect<string, BlobStoreFailure> =>
    send<CreateMultipartUploadCommandOutput>(
      new CreateMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        ...headers,
        ...uploadSettings,
        ...(checksums ? { ChecksumAlgorithm: "CRC64NVME", ChecksumType: "FULL_OBJECT" } : {}),
      }),
      (cause) => failure(cause),
    ).pipe(
      Effect.flatMap((out) =>
        out.UploadId === undefined || out.UploadId === ""
          ? Effect.fail(refused(`${name}: CreateMultipartUpload of "${key}" gave no UploadId`))
          : Effect.succeed(out.UploadId),
      ),
    )

  const abortUpload = (key: string, uploadId: string): Effect.Effect<void, BlobStoreFailure> =>
    send(
      new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId }),
      (cause) => failure(cause),
    ).pipe(
      Effect.asVoid,
      // Gone already (completed, or aborted before): what an abort wants.
      Effect.catchIf(
        (f) => errorCode(f.cause) === "NoSuchUpload",
        () => Effect.void,
      ),
    )

  const protocolOf = (request: BlobPutRequest): Multipart.MultipartProtocol<string, S3Part> => {
    const key = request.key
    const headers = { ContentType: request.contentType, Metadata: { ...request.metadata } }
    return {
      single: (bytes) =>
        Effect.gen(function* () {
          const checksum = yield* request.checksum
          const out = yield* send<PutObjectCommandOutput>(
            new PutObjectCommand({
              Bucket: bucket,
              Key: key,
              ...headers,
              ...uploadSettings,
              Body: bytes,
              ContentLength: bytes.length,
              ChecksumAlgorithm: "CRC64NVME",
              ChecksumCRC64NVME: Base64.encode(checksum.value),
            }),
            (cause) => failure(cause),
          )
          const version = yield* versionOf(out.VersionId, key, "PutObject")
          return { ref: { key, version }, size: bytes.length } satisfies BlobPutResult
        }),
      create: createUpload(key, headers, true),
      part: (uploadId, part) => {
        const checksum = Base64.encode(crc64nvme(part.bytes))
        return send<UploadPartCommandOutput>(
          new UploadPartCommand({
            Bucket: bucket,
            Key: key,
            UploadId: uploadId,
            PartNumber: part.number,
            Body: part.bytes,
            ContentLength: part.bytes.length,
            ChecksumAlgorithm: "CRC64NVME",
            ChecksumCRC64NVME: checksum,
          }),
          // Part 10,001 is S3's to refuse: diagnosed, not pre-checked.
          (cause) =>
            part.number > tuning.maxParts && classify(cause) === "Rejected"
              ? tooLarge(part, cause)
              : failure(cause),
        ).pipe(
          Effect.flatMap((out) =>
            out.ETag === undefined
              ? Effect.fail(refused(`${name}: UploadPart ${part.number} of "${key}" gave no ETag`))
              : Effect.succeed({
                  number: part.number,
                  etag: out.ETag,
                  checksum: out.ChecksumCRC64NVME ?? checksum,
                  size: part.bytes.length,
                }),
          ),
        )
      },
      // The driver runs it uninterruptibly — with the `VersionId` check and
      // an unversioned cleanup — so a sent Complete runs to its answer. An
      // interruption meanwhile still discards that answer (the ledger reports
      // the put as `interrupted`).
      complete: (uploadId, parts) =>
        Effect.gen(function* () {
          const checksum = yield* request.checksum
          const size = parts.reduce((total, part) => total + part.size, 0)
          const out = yield* send<CompleteMultipartUploadCommandOutput>(
            new CompleteMultipartUploadCommand({
              Bucket: bucket,
              Key: key,
              UploadId: uploadId,
              MultipartUpload: {
                Parts: parts.map((part) => ({
                  PartNumber: part.number,
                  ETag: part.etag,
                  ...(part.checksum === undefined ? {} : { ChecksumCRC64NVME: part.checksum }),
                })),
              },
              ChecksumCRC64NVME: Base64.encode(checksum.value),
              ChecksumType: "FULL_OBJECT",
              MpuObjectSize: size,
            }),
            (cause) => completeFailure(cause),
          )
          const version = yield* versionOf(out.VersionId, key, "CompleteMultipartUpload")
          return { ref: { key, version }, size } satisfies BlobPutResult
        }),
      abort: (uploadId) => abortUpload(key, uploadId),
    }
  }

  const put = (request: BlobPutRequest): Effect.Effect<BlobPutResult, BlobStoreFailure> =>
    Effect.suspend(() =>
      Multipart.upload(
        request.body,
        request.contentLength,
        { partSize, concurrency: uploadConcurrency, maxParts: tuning.maxParts, where: name },
        protocolOf(request),
      ),
    )

  // -------------------------------------------------------------------------
  // copy
  // -------------------------------------------------------------------------

  const headObject = (ref: BlobRef): Effect.Effect<HeadObjectCommandOutput, BlobStoreFailure> =>
    send<HeadObjectCommandOutput>(
      new HeadObjectCommand({ Bucket: bucket, Key: ref.key, ...versionIdOf(ref) }),
      (cause) => failure(cause, ref),
    )

  const sizeOf = (ref: BlobRef): Effect.Effect<number, BlobStoreFailure> =>
    Effect.flatMap(headObject(ref), (out) =>
      typeof out.ContentLength === "number"
        ? Effect.succeed(out.ContentLength)
        : Effect.fail(refused(`${name}: HeadObject gave no ContentLength`, ref)),
    )

  /** A copy over the `CopyObject` limit: `UploadPartCopy` ranges, completed (or aborted). */
  const multipartCopy = (
    source: BlobRef,
    request: BlobCopyRequest,
    length: number,
    headers: object,
  ): Effect.Effect<BlobPutResult, BlobStoreFailure> =>
    Effect.suspend(() => {
      const key = request.key
      const size = Multipart.partSizeFor(partSize, length, tuning.maxParts)
      const count = Math.max(1, Math.ceil(length / size))
      let created: string | undefined
      let completed = false
      const run = Effect.gen(function* () {
        // No checksum algorithm: a server-side part has no client checksum to
        // send (and MinIO refuses part copies into a checksummed upload); the
        // library verifies every full read itself.
        const uploadId = yield* Effect.uninterruptible(
          Effect.tap(createUpload(key, headers, false), (id) =>
            Effect.sync(() => {
              created = id
            }),
          ),
        )
        const parts = yield* Effect.forEach(
          Array.from({ length: count }, (_, i) => i),
          (i) => {
            const start = i * size
            const end = Math.min(length, start + size) - 1
            return send<UploadPartCopyCommandOutput>(
              new UploadPartCopyCommand({
                Bucket: bucket,
                Key: key,
                UploadId: uploadId,
                PartNumber: i + 1,
                CopySource: copySourceOf(bucket, source),
                CopySourceRange: `bytes=${start}-${end}`,
              }),
              (cause) => failure(cause, source),
            ).pipe(
              Effect.flatMap((out) => {
                const etag = out.CopyPartResult?.ETag
                return etag === undefined
                  ? Effect.fail(
                      refused(`${name}: UploadPartCopy ${i + 1} of "${key}" gave no ETag`),
                    )
                  : Effect.succeed({ PartNumber: i + 1, ETag: etag })
              }),
            )
          },
          { concurrency: uploadConcurrency },
        )
        // As the put's driver does: uninterruptible, `completed` set in the
        // same region, the `VersionId` check (and cleanup) inside it. An
        // interruption meanwhile discards the answer (the ledger reports the
        // copy as `interrupted`).
        return yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const out = yield* send<CompleteMultipartUploadCommandOutput>(
              new CompleteMultipartUploadCommand({
                Bucket: bucket,
                Key: key,
                UploadId: uploadId,
                MultipartUpload: { Parts: parts },
                MpuObjectSize: length,
              }),
              (cause) => completeFailure(cause),
            )
            completed = true
            const version = yield* versionOf(out.VersionId, key, "CompleteMultipartUpload")
            return { ref: { key, version }, size: length } satisfies BlobPutResult
          }),
        )
      })
      return run.pipe(
        Effect.onExit((exit) => {
          const uploadId = created
          if (Exit.isSuccess(exit) || uploadId === undefined || completed) return Effect.void
          return Effect.uninterruptible(
            abortUpload(key, uploadId).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning(
                  `effect-dynamodb: ${name} could not abort a multipart copy; a lifecycle ` +
                    "AbortIncompleteMultipartUpload rule reclaims its parts",
                  Cause.squash(cause),
                ),
              ),
            ),
          )
        }),
      )
    })

  /**
   * A copy of `source`: `CopyObject`, or `UploadPartCopy` ranges over S3's
   * 5 GiB `CopyObject` limit. A request that gives no `contentLength` learns
   * the source's size from `HeadObject` first — the path depends on it, and
   * nothing is written before it is known.
   */
  const copy = (
    source: BlobRef,
    request: BlobCopyRequest,
  ): Effect.Effect<BlobPutResult, BlobStoreFailure> =>
    Effect.gen(function* () {
      const key = request.key
      const headers = { ContentType: request.contentType, Metadata: { ...request.metadata } }
      const length = request.contentLength ?? (yield* sizeOf(source))
      if (length > tuning.maxCopyObjectBytes) {
        return yield* multipartCopy(source, request, length, headers)
      }
      const out = yield* send<CopyObjectCommandOutput>(
        new CopyObjectCommand({
          Bucket: bucket,
          Key: key,
          CopySource: copySourceOf(bucket, source),
          ...headers,
          MetadataDirective: "REPLACE",
          // The copy starts without tags: never with the source's
          // unreferenced-since mark (design §11.4).
          TaggingDirective: "REPLACE",
          ChecksumAlgorithm: "CRC64NVME",
          ...uploadSettings,
        }),
        (cause) => failure(cause, source),
      )
      const version = yield* versionOf(out.VersionId, key, "CopyObject")
      return { ref: { key, version }, size: length } satisfies BlobPutResult
    })

  // -------------------------------------------------------------------------
  // get / head / list / delete
  // -------------------------------------------------------------------------

  /** `offset` is at most the version's size; past it is `Rejected`. */
  const checkOffset = (
    ref: BlobRef,
    offset: number,
    cause?: unknown,
  ): Effect.Effect<void, BlobStoreFailure> =>
    Effect.flatMap(sizeOf(ref), (size) =>
      offset <= size
        ? Effect.void
        : Effect.fail(
            new BlobStoreFailure({
              reason: "Rejected",
              ref,
              cause:
                cause ?? new Error(`${name}: range offset ${offset} is past the end (${size})`),
            }),
          ),
    )

  const retryNotFound = <A>(
    effect: Effect.Effect<A, BlobStoreFailure>,
  ): Effect.Effect<A, BlobStoreFailure> =>
    options.notFoundRetry === undefined
      ? effect
      : Effect.retry(effect, {
          schedule: options.notFoundRetry,
          while: (f: BlobStoreFailure) => f.reason === "NotFound",
        })

  const get = (
    ref: BlobRef,
    getOptions?: { readonly range?: ByteRange | undefined },
  ): Stream.Stream<Uint8Array, BlobStoreFailure> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const range = getOptions?.range
        if (range !== undefined) {
          const problem = checkRange(range)
          if (problem !== undefined) return yield* refused(`${name}: ${problem}`, ref)
          if (range.length === 0) {
            yield* checkOffset(ref, range.offset)
            return Stream.empty
          }
        }
        const request = send<GetObjectCommandOutput>(
          new GetObjectCommand({
            Bucket: bucket,
            Key: ref.key,
            ...versionIdOf(ref),
            ...(range === undefined ? {} : { Range: rangeHeader(range) }),
          }),
          (cause) => failure(cause, ref),
        )
        const out = yield* retryNotFound(request).pipe(
          Effect.map(Option.some),
          // A range starting at the very end is empty; past it, refused.
          Effect.catchIf(
            (f) => range !== undefined && errorCode(f.cause) === "InvalidRange",
            (f) => Effect.as(checkOffset(ref, range?.offset ?? 0, f.cause), Option.none()),
          ),
        )
        if (Option.isNone(out)) return Stream.empty
        const body = out.value.Body
        if (body === undefined) return Stream.empty
        return Stream.fromReadableStream({
          evaluate: () => body.transformToWebStream() as ReadableStream<unknown>,
          onError: (cause) => failure(redactCredentialRefusal(cause), ref),
        }).pipe(
          Stream.mapEffect((chunk) =>
            chunk instanceof Uint8Array
              ? Effect.succeed(plain(chunk))
              : Effect.fail(
                  new BlobStoreFailure({
                    reason: "Unavailable",
                    ref,
                    cause: new Error(`${name}: GetObject's body emitted a chunk that is not bytes`),
                  }),
                ),
          ),
        )
      }),
    )

  const head = (ref: BlobRef): Effect.Effect<Readonly<Record<string, string>>, BlobStoreFailure> =>
    Effect.map(headObject(ref), (out) => ({ ...(out.Metadata ?? {}) }))

  const listingOf = (version: ObjectVersion): BlobListing | string => {
    const { Key, VersionId, Size, LastModified, IsLatest } = version
    if (Key === undefined) return "a version without a Key"
    if (VersionId === undefined) return `a version of "${Key}" without a VersionId`
    if (typeof Size !== "number") return `version "${VersionId}" of "${Key}" without a Size`
    if (!(LastModified instanceof Date) || Number.isNaN(LastModified.getTime())) {
      return `version "${VersionId}" of "${Key}" without a LastModified date`
    }
    return {
      ref: { key: Key, version: VersionId },
      size: Size,
      lastModified: LastModified,
      isLatest: IsLatest === true,
    }
  }

  interface Marker {
    readonly key: string | undefined
    readonly version: string | undefined
  }

  const list = (
    listPrefix: string,
    listOptions?: { readonly startAfter?: string | undefined },
  ): Stream.Stream<BlobListing, BlobStoreFailure> =>
    Stream.paginate<Marker, BlobListing, BlobStoreFailure>(
      { key: listOptions?.startAfter, version: undefined },
      (marker) =>
        send<ListObjectVersionsCommandOutput>(
          new ListObjectVersionsCommand({
            Bucket: bucket,
            Prefix: listPrefix,
            ...(marker.key === undefined ? {} : { KeyMarker: marker.key }),
            ...(marker.version === undefined ? {} : { VersionIdMarker: marker.version }),
          }),
          (cause) => failure(cause),
        ).pipe(
          Effect.flatMap((out) => {
            const listings: Array<BlobListing> = []
            // Delete markers (`DeleteMarkers`) are not versions: never listed.
            for (const version of out.Versions ?? []) {
              const listing = listingOf(version)
              if (typeof listing === "string") {
                return Effect.fail(refused(`${name}: ListObjectVersions gave ${listing}`))
              }
              listings.push(listing)
            }
            if (out.IsTruncated !== true) {
              return Effect.succeed([listings, Option.none<Marker>()] as const)
            }
            if (out.NextKeyMarker === undefined && out.NextVersionIdMarker === undefined) {
              return Effect.fail(
                refused(`${name}: ListObjectVersions was truncated without a next marker`),
              )
            }
            return Effect.succeed([
              listings,
              Option.some<Marker>({ key: out.NextKeyMarker, version: out.NextVersionIdMarker }),
            ] as const)
          }),
        ),
    )

  const deleteRefs = (refs: ReadonlyArray<BlobRef>): Effect.Effect<void, BlobStoreFailure> =>
    Effect.suspend(() => {
      const seen = new Set<string>()
      const unique = refs.filter((ref) => {
        const id = `${ref.key}\u0000${ref.version}`
        if (seen.has(id)) return false
        seen.add(id)
        return true
      })
      return Effect.forEach(
        chunked(unique, MAX_DELETE_KEYS),
        (chunk) =>
          send<DeleteObjectsCommandOutput>(
            new DeleteObjectsCommand({
              Bucket: bucket,
              Delete: {
                Quiet: true,
                Objects: chunk.map((ref) => ({ Key: ref.key, ...versionIdOf(ref) })),
              },
            }),
            (cause) => failure(cause),
          ).pipe(
            Effect.flatMap((out) => {
              // A version already gone is deleted: deletes are idempotent.
              const errors = (out.Errors ?? []).filter(
                (error) => error.Code === undefined || !GONE.has(error.Code),
              )
              const first = errors[0]
              if (first === undefined) return Effect.void
              return Effect.fail(
                new BlobStoreFailure({
                  reason: classifyCode(first.Code ?? "InternalError", undefined),
                  ref: { key: first.Key ?? "", version: first.VersionId ?? "" },
                  cause: new Error(
                    `${name}: DeleteObjects refused ${errors.length} of ${chunk.length} ` +
                      "versions: " +
                      errors
                        .slice(0, 5)
                        .map(
                          (error) =>
                            `${error.Key ?? "?"}@${error.VersionId ?? ""} ${error.Code ?? "?"}` +
                            (error.Message === undefined ? "" : ` (${error.Message})`),
                        )
                        .join("; "),
                  ),
                }),
              )
            }),
          ),
        { discard: true },
      )
    })

  // -------------------------------------------------------------------------
  // marks
  // -------------------------------------------------------------------------

  const tagsOf = (ref: BlobRef): Effect.Effect<ReadonlyArray<Tag>, BlobStoreFailure> =>
    Effect.map(
      send<GetObjectTaggingCommandOutput>(
        new GetObjectTaggingCommand({ Bucket: bucket, Key: ref.key, ...versionIdOf(ref) }),
        (cause) => failure(cause, ref),
      ),
      (out) => out.TagSet ?? [],
    )

  const putTags = (ref: BlobRef, tags: ReadonlyArray<Tag>): Effect.Effect<void, BlobStoreFailure> =>
    Effect.asVoid(
      send(
        new PutObjectTaggingCommand({
          Bucket: bucket,
          Key: ref.key,
          ...versionIdOf(ref),
          Tagging: { TagSet: [...tags] },
        }),
        (cause) => failure(cause, ref),
      ),
    )

  /** An absent ref: `get` gives `Option.none()`, `set` / `clear` succeed. */
  const whenPresent = <A>(
    effect: Effect.Effect<A, BlobStoreFailure>,
    absent: A,
  ): Effect.Effect<A, BlobStoreFailure> =>
    Effect.catchIf(
      effect,
      (f) => {
        const code = errorCode(f.cause)
        return code !== undefined && GONE.has(code)
      },
      () => Effect.succeed(absent),
    )

  const others = (tags: ReadonlyArray<Tag>): ReadonlyArray<Tag> =>
    tags.filter((tag) => tag.Key !== MARK_TAG)

  const marks: BlobStoreMarks = {
    get: (ref) =>
      whenPresent(
        Effect.map(tagsOf(ref), (tags): Option.Option<Date> => {
          const value = tags.find((tag) => tag.Key === MARK_TAG)?.Value
          const at = value === undefined ? Number.NaN : Date.parse(value)
          // An unreadable mark reads as none: the sweep marks the version again,
          // which only defers its deletion.
          return Number.isNaN(at) ? Option.none() : Option.some(new Date(at))
        }),
        Option.none(),
      ),
    set: (ref, since) =>
      Effect.suspend(() => {
        if (!(since instanceof Date) || Number.isNaN(since.getTime())) {
          return Effect.fail(refused(`${name}: a mark must be a valid Date`, ref))
        }
        return whenPresent(
          Effect.flatMap(tagsOf(ref), (tags) =>
            putTags(ref, [...others(tags), { Key: MARK_TAG, Value: since.toISOString() }]),
          ),
          undefined,
        )
      }),
    clear: (ref) =>
      whenPresent(
        Effect.flatMap(tagsOf(ref), (tags) =>
          tags.some((tag) => tag.Key === MARK_TAG) ? putTags(ref, others(tags)) : Effect.void,
        ),
        undefined,
      ),
  }

  // -------------------------------------------------------------------------
  // presign
  // -------------------------------------------------------------------------

  const presigner = options.presign
  const presign =
    presigner === undefined
      ? undefined
      : (ref: BlobRef, presignOptions: BlobPresignOptions) =>
          Effect.suspend(() => {
            const expiresIn = presignOptions?.expiresIn
            if (
              !Duration.isDuration(expiresIn) ||
              !Duration.isFinite(expiresIn) ||
              !Duration.isPositive(expiresIn)
            ) {
              return Effect.fail(
                refused(`${name}: expiresIn must be a positive, finite Duration`, ref),
              )
            }
            const command = new GetObjectCommand({
              Bucket: bucket,
              Key: ref.key,
              ...versionIdOf(ref),
              ...(presignOptions.contentType === undefined
                ? {}
                : { ResponseContentType: presignOptions.contentType }),
            })
            return Effect.tryPromise({
              try: () =>
                presigner.getSignedUrl(client, command, {
                  expiresIn: Math.max(1, Math.ceil(Duration.toSeconds(expiresIn))),
                }),
              // The presigner signs locally: what it refuses is the request's.
              catch: (cause) =>
                new BlobStoreFailure({
                  reason: "Rejected",
                  ref,
                  cause: redactCredentialRefusal(cause),
                }),
            })
          })

  return {
    name,
    prefix,
    limits: { maxVersionBytes: MAX_S3_VERSION_BYTES, maxKeySuffixBytes: 0 },
    maxUploadAge: options.maxUploadAge,
    readConcurrency: options.readConcurrency,
    writeConcurrency: options.writeConcurrency,
    put,
    get,
    delete: deleteRefs,
    copy,
    list,
    head,
    marks,
    ...(presign === undefined ? {} : { presign }),
  }
}

/**
 * The client the store uses: the caller's, or one built from `clientConfig`
 * and destroyed when `scope` closes.
 */
export const acquireClient = (
  options: ResolvedOptions,
): Effect.Effect<S3Client, never, Scope.Scope> =>
  options.client !== undefined
    ? Effect.succeed(options.client)
    : Effect.acquireRelease(
        Effect.sync(
          () =>
            new S3Client({
              // The library verifies every full read itself (design §8.6).
              responseChecksumValidation: "WHEN_REQUIRED",
              ...options.clientConfig,
            }),
        ),
        (client) => Effect.sync(() => client.destroy()),
      )
