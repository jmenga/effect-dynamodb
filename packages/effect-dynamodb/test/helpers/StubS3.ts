/**
 * A stubbed `S3Client` for the S3 store's unit tests (#179, design §12.2,
 * §19.2): `send` serves the commands the store sends from an in-memory
 * bucket that behaves as S3 does where the store depends on it — versioning
 * (enabled, suspended, never enabled), CRC-64/NVME validation of uploads and
 * parts, full-object checksums of multipart uploads, ranges, version tags,
 * delete markers and paginated version listings — and records every call.
 * A `faults` hook fails a call before it takes effect (`fail`), after it took
 * effect (`lost`: the response is lost), or answers it (`respond`); it may
 * return a promise, so a test can pause a call.
 *
 * Errors are the SDK's own `S3ServiceException`s, with the code as `name`
 * and the HTTP status in `$metadata`, as the SDK raises them.
 */

import { S3ServiceException } from "@aws-sdk/client-s3"
import { crc64nvme } from "@effect-dynamodb/schema/internal/Crc64Nvme.js"
import { compareUtf8 } from "../../src/internal/Utf8Order.js"

/** How the stubbed bucket versions what is written to it. */
export type StubVersioning = "Enabled" | "Suspended" | "Unversioned"

/** One stored version. */
export interface StubVersion {
  readonly versionId: string
  readonly bytes: Uint8Array
  readonly contentType: string | undefined
  readonly metadata: Readonly<Record<string, string>>
  tags: Array<{ Key: string; Value: string }>
  readonly lastModified: Date
  /** The stored full-object CRC-64/NVME (base64), when the upload had one. */
  readonly checksum: string | undefined
}

/** One recorded call. */
export interface StubCall {
  /** The command's name without `Command` (`PutObject`, …). */
  readonly name: string
  readonly input: any
  /** 1-based count of calls of this name. */
  readonly n: number
}

/** What the `faults` hook answers. */
export type StubFault =
  | { readonly _tag: "fail"; readonly error: unknown }
  | { readonly _tag: "lost"; readonly error: unknown }
  | { readonly _tag: "respond"; readonly output: unknown }

/** Options of {@link makeStubS3}. */
export interface StubS3Options {
  readonly bucket?: string | undefined
  readonly versioning?: StubVersioning | undefined
  /** Versions per `ListObjectVersions` page (default 1,000). */
  readonly maxKeys?: number | undefined
  /** Bytes per chunk of a `GetObject` body (default 65,536). */
  readonly chunkBytes?: number | undefined
  /** The most parts an upload may have (default 10,000). */
  readonly maxParts?: number | undefined
  readonly faults?:
    | ((call: StubCall) => StubFault | undefined | Promise<StubFault | undefined>)
    | undefined
}

/** An SDK-shaped S3 error. */
export const s3Error = (name: string, status: number, message = name): S3ServiceException =>
  new S3ServiceException({
    name,
    $fault: status >= 500 ? "server" : "client",
    $metadata: { httpStatusCode: status, attempts: 1 },
    message,
  })

/** A transport failure (no response). */
export const transportError = (message = "socket hang up"): Error =>
  Object.assign(new Error(message), { name: "TimeoutError", $metadata: { attempts: 3 } })

/**
 * `error` as the SDK reports it after `attempts` sends of the request
 * (`undefined`: a failure that reports no attempt count).
 */
export const afterAttempts = <E extends { $metadata: object }>(
  error: E,
  attempts: number | undefined,
): E => {
  const { attempts: _, ...metadata } = error.$metadata as { readonly attempts?: number }
  error.$metadata = attempts === undefined ? metadata : { ...metadata, attempts }
  return error
}

/**
 * A gate that pauses a call: a `faults` hook returns `hold()` for the call
 * to pause, `reached` resolves once it is paused, and `release()` lets it run
 * (and every call held after).
 */
export const makeGate = () => {
  let reach: () => void = () => undefined
  let open: () => void = () => undefined
  const reached = new Promise<void>((resolve) => {
    reach = resolve
  })
  const opened = new Promise<void>((resolve) => {
    open = resolve
  })
  return {
    hold: (): Promise<undefined> => {
      reach()
      return opened.then(() => undefined)
    },
    reached,
    release: (): void => open(),
  }
}

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64")

const concat = (chunks: ReadonlyArray<Uint8Array>): Uint8Array => {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.length
  }
  return out
}

interface Upload {
  readonly key: string
  readonly contentType: string | undefined
  readonly metadata: Readonly<Record<string, string>>
  readonly checksummed: boolean
  readonly parts: Map<number, { bytes: Uint8Array; etag: string; checksum: string | undefined }>
}

/** The stubbed client and what it holds. */
export interface StubS3 {
  /** Pass as `client` (cast: it implements `send` only). */
  readonly client: any
  readonly calls: Array<StubCall>
  /** Versions per key, oldest first. */
  readonly objects: Map<string, Array<StubVersion>>
  /** Delete markers written per key. */
  readonly deleteMarkers: Map<string, number>
  /** Multipart uploads still open. */
  readonly uploads: Map<string, Upload>
  versioning: StubVersioning
  /** The names of the calls made, in order. */
  readonly names: () => ReadonlyArray<string>
  /** The inputs of the calls named `name`. */
  readonly inputs: (name: string) => ReadonlyArray<any>
  /** The version `versionId` of `key`. */
  readonly version: (key: string, versionId: string) => StubVersion | undefined
  /** Store a version directly (test setup). */
  readonly seed: (key: string, bytes: Uint8Array, init?: Partial<StubVersion>) => StubVersion
}

/** A stubbed `S3Client`. */
export const makeStubS3 = (options: StubS3Options = {}): StubS3 => {
  const bucketName = options.bucket ?? "test-bucket"
  const maxKeys = options.maxKeys ?? 1_000
  const chunkBytes = options.chunkBytes ?? 65_536
  const maxParts = options.maxParts ?? 10_000
  const objects = new Map<string, Array<StubVersion>>()
  const deleteMarkers = new Map<string, number>()
  const uploads = new Map<string, Upload>()
  const calls: Array<StubCall> = []
  const counts = new Map<string, number>()
  let nextVersion = 0
  let nextUpload = 0
  let clock = Date.parse("2026-11-01T00:00:00.000Z")

  const stub: StubS3 = {
    client: undefined,
    calls,
    objects,
    deleteMarkers,
    uploads,
    versioning: options.versioning ?? "Enabled",
    names: () => calls.map((c) => c.name),
    inputs: (name) => calls.filter((c) => c.name === name).map((c) => c.input),
    version: (key, versionId) => objects.get(key)?.find((v) => v.versionId === versionId),
    seed: (key, bytes, init = {}) => store(key, bytes, init),
  }

  /** Store a version as the bucket's versioning decides (`"null"` unless enabled). */
  function store(key: string, bytes: Uint8Array, init: Partial<StubVersion> = {}): StubVersion {
    const versioned = stub.versioning === "Enabled"
    nextVersion += 1
    clock += 1000
    const versionId = versioned ? `v${String(nextVersion).padStart(6, "0")}` : "null"
    const existing = (objects.get(key) ?? []).filter((v) => versioned || v.versionId !== "null")
    const version: StubVersion = {
      versionId,
      bytes: new Uint8Array(bytes),
      contentType: init.contentType,
      metadata: init.metadata ?? {},
      tags: init.tags ?? [],
      lastModified: new Date(clock),
      // An upload without a checksum algorithm stores none.
      checksum: "checksum" in init ? init.checksum : b64(crc64nvme(bytes)),
    }
    existing.push(version)
    objects.set(key, existing)
    return version
  }

  /** What a write answers as its `VersionId`. */
  const answered = (version: StubVersion): string | undefined =>
    stub.versioning === "Enabled"
      ? version.versionId
      : stub.versioning === "Suspended"
        ? "null"
        : undefined

  const find = (key: string, versionId: string | undefined): StubVersion => {
    const versions = objects.get(key)
    if (versions === undefined || versions.length === 0) {
      throw s3Error(versionId === undefined ? "NoSuchKey" : "NoSuchVersion", 404)
    }
    const found =
      versionId === undefined
        ? versions[versions.length - 1]
        : versions.find((v) => v.versionId === versionId)
    if (found === undefined) throw s3Error("NoSuchVersion", 404)
    return found
  }

  const checkChecksum = (bytes: Uint8Array, expected: string | undefined): void => {
    if (expected !== undefined && expected !== b64(crc64nvme(bytes))) {
      throw s3Error(
        "BadDigest",
        400,
        "The CRC64NVME you specified did not match the calculated checksum.",
      )
    }
  }

  const parseSource = (source: string): { key: string; versionId: string | undefined } => {
    const [path, query] = source.split("?") as [string, string | undefined]
    const [bucket, ...segments] = path.split("/")
    if (bucket !== bucketName) throw s3Error("NoSuchBucket", 404)
    const key = segments.map((s) => decodeURIComponent(s)).join("/")
    const versionId =
      query === undefined ? undefined : decodeURIComponent(query.replace(/^versionId=/, ""))
    return { key, versionId }
  }

  const parseRange = (range: string, size: number): [number, number] => {
    const match = /^bytes=(\d+)-(\d*)$/.exec(range)
    if (match === null) return [0, size]
    const start = Number(match[1])
    const end = match[2] === "" ? size - 1 : Math.min(size - 1, Number(match[2]))
    if (start >= size) throw s3Error("InvalidRange", 416, "The requested range is not satisfiable")
    return [start, end + 1]
  }

  const body = (bytes: Uint8Array) => ({
    transformToWebStream: () => {
      let at = 0
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          if (at >= bytes.length) {
            controller.close()
            return
          }
          // A Node Buffer, as the SDK's Node handler emits.
          controller.enqueue(Buffer.from(bytes.slice(at, at + chunkBytes)))
          at += chunkBytes
        },
      })
    },
  })

  const handlers: Record<string, (input: any) => unknown> = {
    PutObject: (input) => {
      const bytes = input.Body as Uint8Array
      checkChecksum(bytes, input.ChecksumCRC64NVME)
      const version = store(input.Key, bytes, {
        contentType: input.ContentType,
        metadata: input.Metadata ?? {},
      })
      return {
        ETag: `"e-${version.versionId}"`,
        VersionId: answered(version),
        ChecksumCRC64NVME: version.checksum,
      }
    },
    CreateMultipartUpload: (input) => {
      const id = `u${++nextUpload}`
      uploads.set(id, {
        key: input.Key,
        contentType: input.ContentType,
        metadata: input.Metadata ?? {},
        checksummed: input.ChecksumAlgorithm === "CRC64NVME",
        parts: new Map(),
      })
      return { UploadId: id, Bucket: bucketName, Key: input.Key }
    },
    UploadPart: (input) => {
      const upload = uploads.get(input.UploadId)
      if (upload === undefined) throw s3Error("NoSuchUpload", 404)
      if (input.PartNumber > maxParts) {
        throw s3Error("InvalidArgument", 400, "Part number must be an integer between 1 and 10000")
      }
      const bytes = input.Body as Uint8Array
      checkChecksum(bytes, input.ChecksumCRC64NVME)
      const etag = `"p${input.PartNumber}-${bytes.length}"`
      upload.parts.set(input.PartNumber, {
        bytes: new Uint8Array(bytes),
        etag,
        checksum: input.ChecksumCRC64NVME,
      })
      return { ETag: etag, ChecksumCRC64NVME: input.ChecksumCRC64NVME }
    },
    UploadPartCopy: (input) => {
      const upload = uploads.get(input.UploadId)
      if (upload === undefined) throw s3Error("NoSuchUpload", 404)
      const { key, versionId } = parseSource(input.CopySource)
      const source = find(key, versionId)
      const [start, end] = parseRange(input.CopySourceRange, source.bytes.length)
      const bytes = source.bytes.slice(start, end)
      const etag = `"c${input.PartNumber}-${bytes.length}"`
      upload.parts.set(input.PartNumber, { bytes, etag, checksum: undefined })
      return { CopyPartResult: { ETag: etag } }
    },
    CompleteMultipartUpload: (input) => {
      const upload = uploads.get(input.UploadId)
      if (upload === undefined) throw s3Error("NoSuchUpload", 404)
      const named = (input.MultipartUpload?.Parts ?? []) as Array<{
        PartNumber: number
        ETag: string
      }>
      const chunks = named.map((part) => {
        const stored = upload.parts.get(part.PartNumber)
        if (stored === undefined || stored.etag !== part.ETag) throw s3Error("InvalidPart", 400)
        return stored.bytes
      })
      const bytes = concat(chunks)
      if (input.MpuObjectSize !== undefined && input.MpuObjectSize !== bytes.length) {
        throw s3Error("InvalidRequest", 400, "MpuObjectSize does not match")
      }
      checkChecksum(bytes, input.ChecksumCRC64NVME)
      uploads.delete(input.UploadId)
      const version = store(upload.key, bytes, {
        contentType: upload.contentType,
        metadata: upload.metadata,
        checksum: upload.checksummed ? b64(crc64nvme(bytes)) : undefined,
      })
      return { VersionId: answered(version), Key: upload.key, ChecksumCRC64NVME: version.checksum }
    },
    AbortMultipartUpload: (input) => {
      if (!uploads.delete(input.UploadId)) throw s3Error("NoSuchUpload", 404)
      return {}
    },
    CopyObject: (input) => {
      const { key, versionId } = parseSource(input.CopySource)
      const source = find(key, versionId)
      const version = store(input.Key, source.bytes, {
        contentType: input.MetadataDirective === "REPLACE" ? input.ContentType : source.contentType,
        metadata: input.MetadataDirective === "REPLACE" ? (input.Metadata ?? {}) : source.metadata,
        tags: input.TaggingDirective === "REPLACE" ? [] : source.tags.map((t) => ({ ...t })),
      })
      return {
        VersionId: answered(version),
        CopySourceVersionId: source.versionId,
        CopyObjectResult: { ETag: `"e-${version.versionId}"` },
      }
    },
    GetObject: (input) => {
      const version = find(input.Key, input.VersionId)
      const [start, end] =
        input.Range === undefined
          ? [0, version.bytes.length]
          : parseRange(input.Range, version.bytes.length)
      return {
        Body: body(version.bytes.slice(start, end)),
        ContentLength: end - start,
        VersionId: version.versionId,
        ContentType: version.contentType,
      }
    },
    HeadObject: (input) => {
      let version: StubVersion
      try {
        version = find(input.Key, input.VersionId)
      } catch {
        // A HEAD has no body: the SDK names its 404 "NotFound".
        throw s3Error("NotFound", 404, "UnknownError")
      }
      return {
        ContentLength: version.bytes.length,
        VersionId: version.versionId,
        ContentType: version.contentType,
        Metadata: { ...version.metadata },
        ...(input.ChecksumMode === "ENABLED" && version.checksum !== undefined
          ? { ChecksumCRC64NVME: version.checksum }
          : {}),
      }
    },
    DeleteObject: (input) => {
      const versions = objects.get(input.Key) ?? []
      if (input.VersionId !== undefined) {
        const kept = versions.filter((v) => v.versionId !== input.VersionId)
        if (kept.length === 0) objects.delete(input.Key)
        else objects.set(input.Key, kept)
        return {}
      }
      if (stub.versioning === "Unversioned") {
        objects.delete(input.Key)
        return {}
      }
      // A plain delete in a versioning-enabled or suspended bucket inserts a
      // delete marker (suspended: removing the null version first).
      if (stub.versioning === "Suspended") {
        const kept = versions.filter((v) => v.versionId !== "null")
        if (kept.length === 0) objects.delete(input.Key)
        else objects.set(input.Key, kept)
      }
      deleteMarkers.set(input.Key, (deleteMarkers.get(input.Key) ?? 0) + 1)
      return { DeleteMarker: true }
    },
    DeleteObjects: (input) => {
      for (const object of input.Delete.Objects as Array<{ Key: string; VersionId?: string }>) {
        handlers.DeleteObject!({ Key: object.Key, VersionId: object.VersionId })
      }
      return {}
    },
    ListObjectVersions: (input) => {
      const prefix = (input.Prefix ?? "") as string
      const all = [...objects.keys()]
        .filter((key) => key.startsWith(prefix))
        .sort((a, b) => compareUtf8(a, b))
        .flatMap((key) => {
          const versions = objects.get(key) ?? []
          return versions.map((v, i) => ({ key, v, isLatest: i === versions.length - 1 })).reverse()
        })
      // Resume after (KeyMarker, VersionIdMarker): exclusive.
      let start = 0
      if (input.KeyMarker !== undefined) {
        if (input.VersionIdMarker === undefined) {
          start = all.findIndex((e) => compareUtf8(e.key, input.KeyMarker) > 0)
        } else {
          const at = all.findIndex(
            (e) => e.key === input.KeyMarker && e.v.versionId === input.VersionIdMarker,
          )
          start = at + 1
        }
        if (start < 0) start = all.length
      }
      const page = all.slice(start, start + maxKeys)
      const truncated = start + maxKeys < all.length
      const last = page[page.length - 1]
      return {
        Versions: page.map((e) => ({
          Key: e.key,
          VersionId: e.v.versionId,
          Size: e.v.bytes.length,
          LastModified: e.v.lastModified,
          IsLatest: e.isLatest,
        })),
        // Delete markers are listed apart (and never as versions).
        DeleteMarkers: [...deleteMarkers.keys()]
          .filter((key) => key.startsWith(prefix))
          .map((key) => ({ Key: key, VersionId: "marker", IsLatest: true })),
        IsTruncated: truncated,
        ...(truncated && last !== undefined
          ? { NextKeyMarker: last.key, NextVersionIdMarker: last.v.versionId }
          : {}),
      }
    },
    GetObjectTagging: (input) => {
      const version = find(input.Key, input.VersionId)
      return { VersionId: version.versionId, TagSet: version.tags.map((t) => ({ ...t })) }
    },
    PutObjectTagging: (input) => {
      const version = find(input.Key, input.VersionId)
      version.tags = (input.Tagging.TagSet as Array<{ Key: string; Value: string }>).map((t) => ({
        ...t,
      }))
      return { VersionId: version.versionId }
    },
  }

  const send = async (
    command: { readonly input: any },
    sendOptions?: { abortSignal?: AbortSignal },
  ) => {
    const name = command.constructor.name.replace(/Command$/, "")
    const n = (counts.get(name) ?? 0) + 1
    counts.set(name, n)
    const call: StubCall = { name, input: command.input, n }
    calls.push(call)
    const signal = sendOptions?.abortSignal
    const abortable = <A>(promise: Promise<A>): Promise<A> =>
      signal === undefined
        ? promise
        : new Promise<A>((resolve, reject) => {
            if (signal.aborted) reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
            signal.addEventListener("abort", () =>
              reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
            )
            promise.then(resolve, reject)
          })
    const fault = await abortable(Promise.resolve(options.faults?.(call)))
    if (fault?._tag === "fail") throw fault.error
    if (fault?._tag === "respond") return fault.output
    const handler = handlers[name]
    if (handler === undefined) throw new Error(`StubS3: no handler for ${name}`)
    const output = handler(command.input)
    if (fault?._tag === "lost") throw fault.error
    return { ...(output as object), $metadata: { httpStatusCode: 200, attempts: 1 } }
  }

  ;(stub as { client: any }).client = { send, destroy: () => undefined, config: {} }
  return stub
}
