/**
 * @internal The multipart upload driver a store's `put` runs (#179, design
 * §7): it decides between one `PutObject`-like call and a multipart upload,
 * re-chunks the body into parts of exactly `partSize` bytes (the last may be
 * shorter), uploads them at the store's `uploadConcurrency`, completes the
 * upload (uninterruptibly), and aborts it — in an uninterruptible finalizer,
 * after in-flight parts are interrupted — on any failure or interruption
 * between create and complete.
 *
 * ```
 * body ≤ partSize (buffered, or a stream that ends within one part) → single
 * otherwise                                                        → create, parts, complete
 * ```
 *
 * A store supplies the protocol (its `single`, `create`, `part`, `complete`
 * and `abort` calls); the in-memory store simulates S3's, and the S3 store
 * (`effect-dynamodb/blob/s3`) speaks it. The driver never pre-checks S3's
 * part limit: a part number past `maxParts` is the protocol's to refuse
 * (`TooLarge`, naming the part size — diagnosed on failure).
 *
 * The body's checksum is the caller's (`BlobPutRequest.checksum`, resolved
 * when the body ends): `complete` awaits it, so the driver computes none.
 *
 * Not part of the public API.
 */

import { Cause, Effect, Exit, Stream } from "effect"
import type { BlobPutResult, BlobStoreFailure } from "./BlobStoreContract.js"

/** S3's part limit: a multipart upload has at most 10,000 parts. */
export const MAX_PARTS = 10_000
/** The default part size, 8 MiB (design §24.1). */
export const DEFAULT_PART_SIZE = 8 * 1024 * 1024
/** S3's smallest part (but the last), 5 MiB. */
export const MIN_PART_SIZE = 5 * 1024 * 1024
/** S3's largest part, 5 GiB. */
export const MAX_PART_SIZE = 5 * 1024 * 1024 * 1024
/** The default number of parts uploaded at once. */
export const DEFAULT_UPLOAD_CONCURRENCY = 4

/**
 * The part size of a body of `contentLength` bytes (when known): `partSize`,
 * raised to `ceil(contentLength / maxParts)` when that many parts would not
 * hold it. An unknown length keeps `partSize`.
 */
export const partSizeFor = (
  partSize: number,
  contentLength: number | undefined,
  maxParts: number = MAX_PARTS,
): number =>
  contentLength === undefined ? partSize : Math.max(partSize, Math.ceil(contentLength / maxParts))

const concat = (chunks: ReadonlyArray<Uint8Array>, length: number): Uint8Array => {
  const out = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

/** A part of a re-chunked body; `last` only once the body ended (never on its failure). */
export interface Part {
  readonly bytes: Uint8Array
  readonly last: boolean
}

interface Pending {
  readonly chunks: Array<Uint8Array>
  readonly length: number
  /** The latest full part, held back until it is known whether more follow. */
  readonly held: Uint8Array | undefined
}

type Signal = { readonly _tag: "Chunk"; readonly chunk: Uint8Array } | { readonly _tag: "End" }

const END: Signal = { _tag: "End" }

/**
 * `body` as parts of exactly `size` bytes, the last shorter; an empty body
 * is one empty part. A part is marked `last` only when the body **ended** —
 * a failing body fails before its final part is emitted (Effect's own
 * end-of-stream hooks also run on failure, so the end is an explicit marker
 * concatenated after the body). Each part is a fresh array: a source that
 * reuses its chunk buffers cannot change a part once emitted.
 */
export const rechunk = <E, R>(
  body: Stream.Stream<Uint8Array, E, R>,
  size: number,
): Stream.Stream<Part, E, R> =>
  Stream.concat(
    Stream.map(body, (chunk): Signal => ({ _tag: "Chunk", chunk })),
    Stream.succeed(END),
  ).pipe(
    Stream.mapAccum(
      (): Pending => ({ chunks: [], length: 0, held: undefined }),
      (state, signal: Signal): readonly [Pending, ReadonlyArray<Part>] => {
        const parts: Array<Part> = []
        let { chunks, length, held } = state
        if (signal._tag === "End") {
          const tail = length > 0 ? concat(chunks, length) : undefined
          if (held !== undefined) parts.push({ bytes: held, last: tail === undefined })
          if (tail !== undefined || held === undefined) {
            parts.push({ bytes: tail ?? new Uint8Array(0), last: true })
          }
          return [{ chunks: [], length: 0, held: undefined }, parts]
        }
        const { chunk } = signal
        let offset = 0
        while (length + (chunk.length - offset) >= size) {
          const take = size - length
          chunks.push(chunk.slice(offset, offset + take))
          offset += take
          if (held !== undefined) parts.push({ bytes: held, last: false })
          held = concat(chunks, size)
          chunks = []
          length = 0
        }
        if (offset < chunk.length) {
          chunks.push(chunk.slice(offset))
          length += chunk.length - offset
        }
        return [{ chunks, length, held }, parts]
      },
    ),
  )

/** One part to upload. */
export interface PartRequest {
  /** 1-based. */
  readonly number: number
  readonly bytes: Uint8Array
  /** The upload's part size (for a `TooLarge` message). */
  readonly partSize: number
}

/** A store's calls, as the driver makes them. */
export interface MultipartProtocol<U, P> {
  /** Upload the whole body in one call (a body of at most one part). */
  readonly single: (bytes: Uint8Array) => Effect.Effect<BlobPutResult, BlobStoreFailure>
  /** Start a multipart upload. Run once, uninterruptibly, when the second part exists. */
  readonly create: Effect.Effect<U, BlobStoreFailure>
  /** Upload one part (retrying as the store's client does). */
  readonly part: (upload: U, request: PartRequest) => Effect.Effect<P, BlobStoreFailure>
  /**
   * Complete the upload from its parts, in order. The driver runs it
   * uninterruptibly, so a sent `Complete` is never abandoned mid-request.
   */
  readonly complete: (
    upload: U,
    parts: ReadonlyArray<P>,
  ) => Effect.Effect<BlobPutResult, BlobStoreFailure>
  /** Abort it (idempotent: an upload already gone succeeds). */
  readonly abort: (upload: U) => Effect.Effect<void, BlobStoreFailure>
}

/** How the driver uploads. */
export interface MultipartOptions {
  readonly partSize: number
  readonly concurrency: number
  readonly maxParts?: number | undefined
  /** The store's name, for the log of a failed abort. */
  readonly where: string
}

type Outcome<P> =
  | { readonly _tag: "Single"; readonly result: BlobPutResult }
  | { readonly _tag: "Part"; readonly part: P }

/**
 * Upload `body` (`contentLength` its length, when known) through `protocol`:
 * one `single` call for a body of at most one part, else a multipart upload
 * (design §7). Memory held is at most about `partSize × (concurrency + 2)`.
 */
export const upload = <U, P>(
  body: Uint8Array | Stream.Stream<Uint8Array, BlobStoreFailure>,
  contentLength: number | undefined,
  options: MultipartOptions,
  protocol: MultipartProtocol<U, P>,
): Effect.Effect<BlobPutResult, BlobStoreFailure> =>
  Effect.suspend(() => {
    const known = body instanceof Uint8Array ? body.length : contentLength
    const partSize = partSizeFor(options.partSize, known, options.maxParts ?? MAX_PARTS)
    if (body instanceof Uint8Array && body.length <= partSize) return protocol.single(body)
    const source = body instanceof Uint8Array ? Stream.succeed(body) : body
    let created: U | undefined
    let completed = false
    const run = Effect.gen(function* () {
      // Uninterruptible once started, so an upload S3 created is always known
      // to the finalizer that aborts it.
      const create = yield* Effect.cached(
        Effect.uninterruptible(
          Effect.tap(protocol.create, (handle) =>
            Effect.sync(() => {
              created = handle
            }),
          ),
        ),
      )
      const outcomes = yield* rechunk(source, partSize).pipe(
        Stream.mapEffect(
          ({ bytes, last }, i): Effect.Effect<Outcome<P>, BlobStoreFailure> =>
            i === 0 && last
              ? Effect.map(protocol.single(bytes), (result) => ({ _tag: "Single", result }))
              : Effect.flatMap(create, (handle) =>
                  Effect.map(protocol.part(handle, { number: i + 1, bytes, partSize }), (part) => ({
                    _tag: "Part",
                    part,
                  })),
                ),
          { concurrency: options.concurrency },
        ),
        Stream.runCollect,
      )
      const first = outcomes[0]
      if (first === undefined) {
        return yield* Effect.die(new Error("Multipart: a body gave no part"))
      }
      if (first._tag === "Single") return first.result
      const handle = yield* create
      const parts = outcomes.flatMap((outcome) => (outcome._tag === "Part" ? [outcome.part] : []))
      // Uninterruptible, with `completed` set in the same region: a sent
      // Complete runs to its answer, and a completed upload is never aborted.
      // An interruption that arrives meanwhile is delivered when the region
      // ends, so the caller never sees that answer: the upload ledger reports
      // an interrupted put by its key (`interrupted`).
      return yield* Effect.uninterruptible(
        Effect.tap(protocol.complete(handle, parts), () =>
          Effect.sync(() => {
            completed = true
          }),
        ),
      )
    })
    return run.pipe(
      Effect.onExit((exit) => {
        const handle = created
        if (Exit.isSuccess(exit) || handle === undefined || completed) return Effect.void
        return Effect.uninterruptible(
          protocol
            .abort(handle)
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning(
                  `effect-dynamodb: ${options.where} could not abort a multipart upload; a ` +
                    "lifecycle AbortIncompleteMultipartUpload rule reclaims its parts",
                  Cause.squash(cause),
                ),
              ),
            ),
        )
      }),
    )
  })
