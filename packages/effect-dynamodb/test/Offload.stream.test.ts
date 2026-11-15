/**
 * Binary inputs and streaming (#179, design §3.8, §7, §19.2): what a binary
 * field (`DynamoModel.External()`) takes on a write — bytes, a `Stream`, a
 * `BlobHandle`, `Offload.source(...)` — through the in-memory store's
 * multipart simulation: single PUT and multipart agree on the checksum, the
 * part size adapts to a known length, interruption aborts, a part failure is
 * retried, source and store failures send nothing to DynamoDB (a chunk that
 * is not bytes, a put that answers before its body ended, an upload past
 * `maxUploadAge`), a version DynamoDB refused is rolled back, a lost
 * `Complete` is reported, handles are copied (with and without `copy`, the
 * copy's answer checked), and streams are single-use (`[EDD-9120]`). The
 * same paths run through the S3 store over a stubbed `S3Client`
 * (`test/helpers/StubS3.ts`): the checksum S3 is sent, part-size adaptation
 * and part 10,001, aborts on interruption and on part and source failures, a
 * lost `Complete` (of a put and of a multipart copy), an interruption while
 * a `Complete` or a `PutObject` is in flight reported, unversioned buckets,
 * and handle copies by `CopyObject` (its `VersionId` checked) or streamed.
 *
 * Rows are the in-memory tables'; objects the in-memory store's or the
 * stubbed bucket's.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { describe, expect, it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { BlobStoreError, ValidationError } from "@effect-dynamodb/schema/Errors.js"
import * as BlobPointer from "@effect-dynamodb/schema/internal/BlobPointer.js"
import { crc64nvme } from "@effect-dynamodb/schema/internal/Crc64Nvme.js"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import { beforeEach } from "vitest"
import * as Batch from "../src/Batch.js"
import { BlobStore, type BlobStoreService, type MemoryBlobStoreOptions } from "../src/BlobStore.js"
import {
  copySourceOf,
  makeService,
  resolveOptions,
  type S3Tuning,
} from "../src/blob/S3BlobStore.js"
import { DynamoClient, type DynamoClientService } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as BlobLedger from "../src/internal/BlobLedger.js"
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
import { makeGate, makeStubS3, type StubS3, s3Error, transportError } from "./helpers/StubS3.js"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const AppSchema = DynamoSchema.make({ name: "str", version: 1, escapeKeys: true })

const Text = Schema.Struct({ text: Schema.String })

class Doc extends Schema.Class<Doc>("Doc")({
  docId: Schema.String,
  title: Schema.String,
  scan: Schema.optional(Schema.Uint8Array),
  thumb: Schema.optional(Schema.Uint8Array),
  body: Schema.optional(Text),
}) {}

const key = {
  pk: { field: "pk", composite: ["docId"] },
  sk: { field: "sk", composite: [] },
} as const

const Docs = Entity.make({
  model: DynamoModel.configure(Doc, {
    scan: { storedAs: DynamoModel.External({ contentType: "application/pdf" }) },
    thumb: { storedAs: DynamoModel.External() },
    body: { storedAs: DynamoModel.Packed({ format: "json", external: { threshold: 64 } }) },
  }),
  entityType: "Doc",
  primaryKey: key,
})

class Scan extends Schema.Class<Scan>("Scan")({
  scanId: Schema.String,
  label: Schema.String,
  image: Schema.Uint8Array,
}) {}

/** A binary immutable. */
const Scans = Entity.make({
  model: DynamoModel.configure(Scan, {
    image: { storedAs: DynamoModel.External(), immutable: true },
  }),
  entityType: "Scan",
  primaryKey: { pk: { field: "pk", composite: ["scanId"] }, sk: { field: "sk", composite: [] } },
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

const MainTable = Table.make({ schema: AppSchema, entities: { Docs, Scans, Readings } })

// ---------------------------------------------------------------------------
// The client, the store, the observer
// ---------------------------------------------------------------------------

/** `BatchWriteItem` requests to leave unprocessed, once each. */
const leaveOnce: Array<(request: any) => boolean> = []

/** The in-memory tables, plus a `BatchWriteItem` that can leave requests unprocessed. */
const Client = Layer.effect(
  DynamoClient,
  Effect.map(
    Effect.service(DynamoClient),
    (inner): DynamoClientService => ({
      ...inner,
      batchWriteItem: (input) =>
        Effect.sync(() => {
          const leave = leaveOnce.shift()
          const left: Record<string, Array<any>> = {}
          for (const [table, requests] of Object.entries(input.RequestItems ?? {})) {
            for (const request of requests as Array<any>) {
              if (leave?.(request) === true) {
                left[table] = [...(left[table] ?? []), request]
              } else if (request.PutRequest !== undefined) {
                rows.set(keyOf(table, request.PutRequest.Item), request.PutRequest.Item)
              }
            }
          }
          return { UnprocessedItems: left, $metadata: { attempts: 1 } } as never
        }),
    }),
  ),
).pipe(Layer.provide(InMemoryClient))

const reports: Array<Offload.UnsettledUpload> = []

const provide = <A, E, R>(store: BlobStoreService, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(
      Layer.mergeAll(
        Client,
        MainTable.layer({ name: "main" }),
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

const client = DynamoClient.make({ entities: { Docs, Scans, Readings }, tables: { MainTable } })
type Db = Effect.Success<typeof client>

/** Run `f` with the typed client, `store` in context (a builder is run as its effect). */
const withDb = <A, E>(
  store: BlobStoreService,
  f: (db: Db) => Effect.Effect<A, E> | { readonly asEffect: () => Effect.Effect<A, E> },
) =>
  provide(
    store,
    Effect.flatMap(client, (db) => {
      const out = f(db)
      return Effect.isEffect(out) ? out : out.asEffect()
    }),
  )

beforeEach(() => {
  resetStore()
  reports.length = 0
  leaveOnce.length = 0
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const memory = (options?: MemoryBlobStoreOptions): MemoryBlobStore => BlobStore.memory(options)

/** `n` deterministic bytes. */
const bytes = (n: number, seed = 1): Uint8Array =>
  Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed * 17) % 256)

/** `content` as a stream of `size`-byte chunks, counting the chunks it gives. */
const chunked = (content: Uint8Array, size: number, pulled = { n: 0 }) => {
  const chunks: Array<Uint8Array> = []
  for (let at = 0; at < content.length; at += size) chunks.push(content.slice(at, at + size))
  return Stream.fromIterable(chunks).pipe(
    Stream.tap(() =>
      Effect.sync(() => {
        pulled.n++
      }),
    ),
  )
}

const live = (entityType: string, idField: string, id: string): Item | undefined =>
  [...rows.values()].find(
    (item) =>
      item.__edd_e__?.S === entityType && item[idField]?.S === id && !/#e#/.test(item.sk?.S ?? ""),
  )

/** A binary attribute's stored pointer (`~edbp:` text). */
const pointerOf = (value: AttributeValue | undefined): BlobPointer.BlobPointer => {
  expect(typeof value?.S).toBe("string")
  const pointer = BlobPointer.decodeText(value!.S!)
  if (pointer === undefined || typeof pointer === "string") throw new Error(String(pointer))
  return pointer
}

const failureOf = <A, E>(exit: Exit.Exit<A, E>): E => {
  if (Exit.isSuccess(exit)) throw new Error("expected a failure")
  const error = Cause.findErrorOption(exit.cause)
  if (Option.isNone(error)) throw new Error(`expected a Fail, got ${Cause.pretty(exit.cause)}`)
  return error.value
}

const blobFailure = <A, E>(exit: Exit.Exit<A, E>): BlobStoreError => {
  const error = failureOf(exit)
  expect(error).toBeInstanceOf(BlobStoreError)
  return error as BlobStoreError
}

/** A `[EDD-9120]` refusal, its message matching `pattern`. */
const refusal = <A, E>(exit: Exit.Exit<A, E>, pattern: RegExp): ValidationError => {
  const error = failureOf(exit)
  expect(error).toBeInstanceOf(ValidationError)
  const cause = String((error as ValidationError).cause)
  expect(cause).toMatch(/\[EDD-9120\]/)
  expect(cause).toMatch(pattern)
  return error as ValidationError
}

const doc = (docId: string, fields: Record<string, unknown> = {}) =>
  ({ docId, title: `t-${docId}`, ...fields }) as never

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

describe("Offload — binary inputs and streaming", () => {
  it.effect("single PUT and multipart record the same checksum for the same bytes", () =>
    Effect.gen(function* () {
      const content = bytes(30)
      const single = memory()
      const multi = memory({ partSize: 8, uploadConcurrency: 2 })
      yield* withDb(single, (db) => db.entities.Docs.put(doc("a", { scan: content })))
      const viaSingle = pointerOf(live("Doc", "docId", "a")!.scan)
      resetStore()
      yield* withDb(multi, (db) => db.entities.Docs.put(doc("a", { scan: chunked(content, 7) })))
      const viaMulti = pointerOf(live("Doc", "docId", "a")!.scan)
      expect(single.inspect().multipart.creates).toBe(0)
      expect(multi.inspect().multipart).toMatchObject({ creates: 1, parts: 4, completes: 1 })
      expect(viaMulti.checksum.value).toEqual(crc64nvme(content))
      expect(viaMulti.checksum.value).toEqual(viaSingle.checksum.value)
      expect(viaMulti.contentSize).toBe(30)
      expect(viaMulti.objectSize).toBe(30)
      expect(Option.getOrUndefined(viaMulti.contentType)).toBe("application/pdf")
      expect(multi.inspect().versions[0]!.bytes).toEqual(content)
      // It reads back, verified against the pointer.
      const read = yield* withDb(multi, (db) =>
        db.entities.Docs.get({ docId: "a" }).offloaded("eager"),
      )
      expect(read.scan).toEqual(content)
    }),
  )

  it.effect("adapts the part size to a known contentLength; an unknown one is TooLarge", () =>
    Effect.gen(function* () {
      const content = bytes(40)
      const store = memory({ partSize: 4, maxParts: 5 })
      yield* withDb(store, (db) =>
        db.entities.Docs.put(
          doc("a", { scan: Offload.source(chunked(content, 9), { contentLength: 40 }) }),
        ),
      )
      // ceil(40 / 5) = 8-byte parts: five of them.
      expect(store.inspect().multipart).toMatchObject({ creates: 1, parts: 5, completes: 1 })
      const exit = yield* Effect.exit(
        withDb(store, (db) => db.entities.Docs.put(doc("b", { scan: chunked(content, 9) }))),
      )
      const error = blobFailure(exit)
      expect(error.reason).toBe("TooLarge")
      expect(error.action).toBe("put")
      expect(live("Doc", "docId", "b")).toBeUndefined()
      expect(store.inspect().multipart).toMatchObject({ aborts: 1, inProgress: 0 })
      expect(store.inspect().versions).toHaveLength(1)
    }),
  )

  it.effect("interrupting an upload aborts it: no Complete, nothing written", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const store = memory({
        partSize: 8,
        failures: (call) =>
          call.multipart?.phase === "part" && call.multipart.part === 2
            ? Effect.andThen(Deferred.succeed(started, undefined), Effect.never)
            : undefined,
      })
      const fiber = yield* withDb(store, (db) =>
        db.entities.Docs.put(doc("a", { scan: chunked(bytes(40), 8) })),
      ).pipe(Effect.forkChild)
      yield* Deferred.await(started)
      yield* Fiber.interrupt(fiber)
      expect(store.inspect().multipart).toMatchObject({
        creates: 1,
        completes: 0,
        aborts: 1,
        inProgress: 0,
      })
      expect(store.inspect().versions).toEqual([])
      expect(rows.size).toBe(0)
      // The library cannot see inside the store call: an interrupted one is
      // reported whether or not the store wrote anything.
      expect(reports.map((report) => report.reason)).toEqual(["interrupted"])
    }),
  )

  it.effect("a put interrupted after the store wrote is reported (interrupted), by its key", () =>
    Effect.gen(function* () {
      const store = memory({
        failures: (call) =>
          call.action === "put" ? { _tag: "Interrupt", at: "response" } : undefined,
      })
      const exit = yield* Effect.exit(
        withDb(store, (db) => db.entities.Docs.put(doc("a", { scan: bytes(20) }))),
      )
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      expect(rows.size).toBe(0)
      expect(reports).toHaveLength(1)
      expect(reports[0]).toMatchObject({
        reason: "interrupted",
        entityType: "Doc",
        attribute: "scan",
        operation: "Entity.put",
        ref: Option.none(),
      })
      // The version the store wrote has no pointer: under the reported key, for gc.sweep.
      const [orphan] = store.inspect().versions
      expect(orphan!.ref.key).toBe(reports[0]!.key)
    }),
  )

  it.effect("retries a part that fails with Throttled", () =>
    Effect.gen(function* () {
      const store = memory({
        partSize: 8,
        failures: (call) =>
          call.multipart?.phase === "part" &&
          call.multipart.part === 2 &&
          call.multipart.attempt === 1
            ? { _tag: "Fail", reason: "Throttled" }
            : undefined,
      })
      yield* withDb(store, (db) => db.entities.Docs.put(doc("a", { scan: chunked(bytes(32), 5) })))
      expect(store.inspect().multipart).toMatchObject({ parts: 5, completes: 1, aborts: 0 })
      expect(pointerOf(live("Doc", "docId", "a")!.scan).checksum.value).toEqual(
        crc64nvme(bytes(32)),
      )
    }),
  )

  it.effect("a source failure fails the write with SourceFailed; nothing is written", () =>
    Effect.gen(function* () {
      const store = memory({ partSize: 8 })
      const source = Stream.concat(chunked(bytes(20), 4), Stream.fail(new Error("disk gone")))
      const error = blobFailure(
        yield* Effect.exit(withDb(store, (db) => db.entities.Docs.put(doc("a", { scan: source })))),
      )
      expect(error.reason).toBe("SourceFailed")
      expect(String((error.cause as { readonly cause?: unknown }).cause)).toMatch(/disk gone/)
      expect(rows.size).toBe(0)
      expect(store.inspect().versions).toEqual([])
      expect(store.inspect().multipart).toMatchObject({ aborts: 1, inProgress: 0 })
    }),
  )

  it.effect("a stream that gives more or fewer bytes than its contentLength is SourceFailed", () =>
    Effect.gen(function* () {
      const store = memory()
      for (const contentLength of [9, 11]) {
        const error = blobFailure(
          yield* Effect.exit(
            withDb(store, (db) =>
              db.entities.Docs.put(
                doc("a", { scan: Offload.source(chunked(bytes(10), 3), { contentLength }) }),
              ),
            ),
          ),
        )
        expect(error.reason).toBe("SourceFailed")
      }
      expect(rows.size).toBe(0)
      expect(store.inspect().versions).toEqual([])
    }),
  )

  it.effect("a put that fails after consuming its stream fails the write; reuse is EDD-9120", () =>
    Effect.gen(function* () {
      const pulled = { n: 0 }
      const source = chunked(bytes(12), 4, pulled)
      const failing = memory({
        failures: (call) =>
          call.action === "put" ? { _tag: "Fail", reason: "Unavailable" } : undefined,
      })
      const error = blobFailure(
        yield* Effect.exit(
          withDb(failing, (db) => db.entities.Docs.put(doc("a", { scan: source }))),
        ),
      )
      expect(error.reason).toBe("Unavailable")
      expect(pulled.n).toBe(3)
      expect(rows.size).toBe(0)
      expect(failing.inspect().versions).toEqual([])
      // The consumed stream is never replayed — not by a retry, not elsewhere.
      const healthy = memory()
      refusal(
        yield* Effect.exit(
          withDb(healthy, (db) => db.entities.Docs.put(doc("a", { scan: source }))),
        ),
        /single-use, and an earlier operation already consumed it/,
      )
      expect(pulled.n).toBe(3)
      expect(healthy.inspect().calls.put).toBe(0)
    }),
  )

  it.effect("a store put that succeeds before its body ended is refused and rolled back", () =>
    Effect.gen(function* () {
      const inner = memory()
      const empty = new Uint8Array(0)
      // Answers for an empty body without pulling the stream it was given.
      const eager: BlobStoreService = {
        ...inner,
        put: (request) =>
          inner.put({
            ...request,
            body: empty,
            contentLength: 0,
            checksum: Effect.succeed({ algorithm: "crc64nvme", value: crc64nvme(empty) }),
          }),
      }
      const pulled = { n: 0 }
      const error = blobFailure(
        yield* Effect.exit(
          withDb(eager, (db) =>
            db.entities.Docs.put(doc("a", { scan: chunked(bytes(12), 4, pulled) })),
          ),
        ),
      )
      expect(error.reason).toBe("Rejected")
      expect(String(error.cause)).toMatch(/the store's put succeeded before its body ended/)
      expect(pulled.n).toBe(0)
      expect(rows.size).toBe(0)
      // The version it wrote names this upload: rolled back.
      expect(inner.inspect().calls.delete).toBe(1)
      expect(inner.inspect().versions).toEqual([])
    }),
  )

  it.effect("a stream chunk that is not a Uint8Array is SourceFailed; nothing is written", () =>
    Effect.gen(function* () {
      const store = memory()
      // Reachable only from untyped code.
      const error = blobFailure(
        yield* Effect.exit(
          withDb(store, (db) => db.entities.Docs.put(doc("a", { scan: Stream.make("text") }))),
        ),
      )
      expect(error.reason).toBe("SourceFailed")
      expect(String((error.cause as { readonly cause?: unknown }).cause)).toMatch(
        /a chunk that is not a Uint8Array/,
      )
      expect(rows.size).toBe(0)
      expect(store.inspect().versions).toEqual([])
    }),
  )

  it.effect(
    "a streamed upload that outlives maxUploadAge fails Expired; its version is deleted",
    () =>
      Effect.gen(function* () {
        const store = memory({ maxUploadAge: "1 minute" })
        // Each chunk takes a minute: the upload ends three minutes after it started.
        const slow = chunked(bytes(12), 4).pipe(Stream.tap(() => TestClock.adjust("1 minute")))
        const error = blobFailure(
          yield* Effect.exit(withDb(store, (db) => db.entities.Docs.put(doc("a", { scan: slow })))),
        )
        expect(error.reason).toBe("Expired")
        expect(error.action).toBe("put")
        expect(String(error.cause)).toContain("nothing was written to DynamoDB")
        expect(rows.size).toBe(0)
        expect(store.inspect().calls.put).toBe(1)
        expect(store.inspect().calls.delete).toBe(1)
        expect(store.inspect().versions).toEqual([])
      }),
  )

  it.effect(
    "a stream's version is rolled back when DynamoDB refuses the write; reuse is EDD-9120",
    () =>
      Effect.gen(function* () {
        const store = memory()
        const source = chunked(bytes(12), 4)
        yield* withDb(store, (db) => db.entities.Docs.put(doc("a")))
        const error = failureOf(
          yield* Effect.exit(
            withDb(store, (db) => db.entities.Docs.create(doc("a", { scan: source }))),
          ),
        )
        expect((error as { readonly _tag?: unknown })._tag).toBe("ConditionalCheckFailed")
        expect(live("Doc", "docId", "a")!.scan).toBeUndefined()
        // The create provably did not commit: its stream's version is deleted.
        expect(store.inspect().calls.put).toBe(1)
        expect(store.inspect().calls.delete).toBe(1)
        expect(store.inspect().versions).toEqual([])
        // The consumed stream is never replayed.
        refusal(
          yield* Effect.exit(
            withDb(store, (db) => db.entities.Docs.put(doc("b", { scan: source }))),
          ),
          /single-use, and an earlier operation already consumed it/,
        )
        expect(store.inspect().calls.put).toBe(1)
        expect(live("Doc", "docId", "b")).toBeUndefined()
      }),
  )

  it.effect("a lost Complete is reported to the observer (completeLost); nothing is written", () =>
    Effect.gen(function* () {
      const store = memory({
        partSize: 8,
        failures: (call) =>
          call.multipart?.phase === "complete"
            ? { _tag: "Fail", reason: "Unavailable", at: "response" }
            : undefined,
      })
      const error = blobFailure(
        yield* Effect.exit(
          withDb(store, (db) => db.entities.Docs.put(doc("a", { scan: chunked(bytes(20), 6) }))),
        ),
      )
      expect(error.reason).toBe("Unavailable")
      expect(rows.size).toBe(0)
      expect(reports).toHaveLength(1)
      expect(reports[0]).toMatchObject({
        reason: "completeLost",
        entityType: "Doc",
        attribute: "scan",
        ref: Option.none(),
      })
      // The version it made has no pointer: it is left for gc.sweep.
      const [orphan] = store.inspect().versions
      expect(orphan!.ref.key).toBe(reports[0]!.key)
      // Inside an enclosing root it is reported when that root exits, with the rest.
      reports.length = 0
      yield* withDb(store, (db) =>
        BlobLedger.root(
          Effect.gen(function* () {
            const exit = yield* Effect.exit(
              db.entities.Docs.put(doc("b", { scan: chunked(bytes(20), 6) })).asEffect(),
            )
            expect(Exit.isFailure(exit)).toBe(true)
            expect(reports).toEqual([])
          }),
        ),
      )
      expect(reports.map((r) => r.reason)).toEqual(["completeLost"])
    }),
  )

  it.effect("a buffered value over the part size uploads multipart too", () =>
    Effect.gen(function* () {
      const store = memory({ partSize: 8 })
      yield* withDb(store, (db) => db.entities.Docs.put(doc("a", { scan: bytes(20) })))
      expect(store.inspect().multipart).toMatchObject({ creates: 1, parts: 3, completes: 1 })
      expect(pointerOf(live("Doc", "docId", "a")!.scan).checksum.value).toEqual(
        crc64nvme(bytes(20)),
      )
    }),
  )
})

// ---------------------------------------------------------------------------
// Handles
// ---------------------------------------------------------------------------

describe("Offload — BlobHandle inputs", () => {
  /** Put `a` with `content`, then read its lazy handle. */
  const handleOf = (store: BlobStoreService, content: Uint8Array) =>
    withDb(store, (db) =>
      Effect.gen(function* () {
        yield* db.entities.Docs.put(doc("a", { scan: content }))
        const read = yield* db.entities.Docs.get({ docId: "a" })
        return read.scan!
      }),
    )

  it.effect("copies a handle's content into a new version, with the store's copy", () =>
    Effect.gen(function* () {
      const store = memory()
      const content = bytes(12)
      const handle = yield* handleOf(store, content)
      yield* withDb(store, (db) => db.entities.Docs.put(doc("b", { scan: handle })))
      expect(store.inspect().calls.copy).toBe(1)
      const pointer = pointerOf(live("Doc", "docId", "b")!.scan)
      expect(pointer.ref.key).not.toBe(Option.getOrThrow(handle.ref).key)
      expect(pointer.checksum.value).toEqual(handle.checksum.value)
      const read = yield* withDb(store, (db) =>
        db.entities.Docs.get({ docId: "b" }).offloaded("eager"),
      )
      expect(read.scan).toEqual(content)
    }),
  )

  it.effect("copies even the field's own current version into a new one", () =>
    Effect.gen(function* () {
      const store = memory()
      const handle = yield* handleOf(store, bytes(12))
      yield* withDb(store, (db) => db.entities.Docs.update({ docId: "a" }).set({ scan: handle }))
      const pointer = pointerOf(live("Doc", "docId", "a")!.scan)
      expect(pointer.ref.key).toBe(Option.getOrThrow(handle.ref).key)
      expect(pointer.ref.version).not.toBe(Option.getOrThrow(handle.ref).version)
      expect(store.inspect().calls.copy).toBe(1)
    }),
  )

  it.effect("streams a handle's content into a put without the copy capability", () =>
    Effect.gen(function* () {
      const inner = memory()
      const { copy: _copy, ...rest } = inner
      const noCopy: BlobStoreService = rest
      const content = bytes(12)
      const handle = yield* handleOf(noCopy, content)
      yield* withDb(noCopy, (db) => db.entities.Docs.put(doc("b", { scan: handle })))
      expect(inner.inspect().calls.copy).toBe(0)
      expect(inner.inspect().calls.put).toBe(2)
      expect(pointerOf(live("Doc", "docId", "b")!.scan).checksum.value).toEqual(crc64nvme(content))
    }),
  )

  it.effect("streams a handle read from another store", () =>
    Effect.gen(function* () {
      const source = memory()
      const target = memory()
      const handle = yield* handleOf(source, bytes(12))
      yield* withDb(target, (db) => db.entities.Docs.put(doc("b", { scan: handle })))
      expect(target.inspect().calls.copy).toBe(0)
      expect(target.inspect().calls.put).toBe(1)
      expect(target.inspect().versions[0]!.bytes).toEqual(bytes(12))
    }),
  )

  it.effect("checks the copy's answer: its source's ref is refused and never deleted", () =>
    Effect.gen(function* () {
      const inner = memory()
      const sourceAnswer: BlobStoreService = {
        ...inner,
        copy: (source, request) => Effect.succeed({ ref: source, size: request.contentLength! }),
      }
      const handle = yield* handleOf(sourceAnswer, bytes(12))
      const error = blobFailure(
        yield* Effect.exit(
          withDb(sourceAnswer, (db) => db.entities.Docs.put(doc("b", { scan: handle }))),
        ),
      )
      expect(error.reason).toBe("Rejected")
      expect(error.action).toBe("copy")
      expect(live("Doc", "docId", "b")).toBeUndefined()
      expect(inner.inspect().calls.delete).toBe(0)
      expect(inner.inspect().versions).toHaveLength(1)
      expect(reports.map((r) => r.reason)).toEqual(["answerRefused"])
    }),
  )

  it.effect("checks the copy's version against the store's limits, rolling it back", () =>
    Effect.gen(function* () {
      const inner = memory()
      const longVersion: BlobStoreService = {
        ...inner,
        copy: (source, request) =>
          Effect.map(inner.copy(source, request), (result) => ({
            ...result,
            ref: { key: result.ref.key, version: "v".repeat(40) },
          })),
      }
      const handle = yield* handleOf(longVersion, bytes(12))
      const error = blobFailure(
        yield* Effect.exit(
          withDb(longVersion, (db) => db.entities.Docs.put(doc("b", { scan: handle }))),
        ),
      )
      expect(error.reason).toBe("Rejected")
      expect(String(error.cause)).toMatch(/maxVersionBytes/)
      expect(live("Doc", "docId", "b")).toBeUndefined()
      expect(inner.inspect().calls.delete).toBe(1)
    }),
  )

  it.effect("an immutable binary field restated by a matching handle passes, uncopied", () =>
    Effect.gen(function* () {
      const store = memory()
      const image = bytes(16)
      const handle = yield* withDb(store, (db) =>
        Effect.gen(function* () {
          yield* db.entities.Scans.put({ scanId: "s", label: "one", image })
          return (yield* db.entities.Scans.get({ scanId: "s" })).image
        }),
      )
      const before = pointerOf(live("Scan", "scanId", "s")!.image)
      yield* withDb(store, (db) =>
        db.entities.Scans.update({ scanId: "s" }).set({ image: handle, label: "two" } as never),
      )
      const after = live("Scan", "scanId", "s")!
      expect(after.label!.S).toBe("two")
      expect(pointerOf(after.image).ref).toEqual(before.ref)
      expect(store.inspect().calls.copy).toBe(0)
      // A handle of other content is a change, refused.
      const other = yield* handleOf(store, bytes(16, 2))
      const changed = failureOf(
        yield* Effect.exit(
          withDb(store, (db) =>
            db.entities.Scans.update({ scanId: "s" }).set({ image: other } as never),
          ),
        ),
      )
      expect(changed).toBeInstanceOf(ValidationError)
      expect(String((changed as ValidationError).cause)).toMatch(/immutable/)
      // A stream cannot be compared without consuming it.
      refusal(
        yield* Effect.exit(
          withDb(store, (db) =>
            db.entities.Scans.update({ scanId: "s" }).set({
              image: chunked(image, 4),
            } as never),
          ),
        ),
        /restates it with a Stream/,
      )
    }),
  )
})

// ---------------------------------------------------------------------------
// Sources, shapes and single use
// ---------------------------------------------------------------------------

describe("Offload — sources, refusals and single-use streams", () => {
  it.effect("Offload.source gives the object and the pointer its content type", () =>
    Effect.gen(function* () {
      const store = memory()
      yield* withDb(store, (db) =>
        Effect.gen(function* () {
          yield* db.entities.Docs.put(
            doc("a", {
              scan: Offload.source(bytes(8), { contentType: "image/png" }),
              thumb: Offload.source(chunked(bytes(8), 3), { contentType: "image/webp" }),
            }),
          )
        }),
      )
      const row = live("Doc", "docId", "a")!
      expect(Option.getOrUndefined(pointerOf(row.scan).contentType)).toBe("image/png")
      expect(Option.getOrUndefined(pointerOf(row.thumb).contentType)).toBe("image/webp")
      const types = store
        .inspect()
        .versions.map((v) => v.contentType)
        .sort()
      expect(types).toEqual(["image/png", "image/webp"])
      const read = yield* withDb(store, (db) => db.entities.Docs.get({ docId: "a" }))
      expect(read.scan!.contentType).toBe("image/png")
      // Without a source, the field's External content type (or octet-stream).
      yield* withDb(store, (db) =>
        db.entities.Docs.put(doc("b", { scan: bytes(4), thumb: chunked(bytes(4), 2) })),
      )
      const plain = live("Doc", "docId", "b")!
      expect(Option.getOrUndefined(pointerOf(plain.scan).contentType)).toBe("application/pdf")
      expect(Option.getOrUndefined(pointerOf(plain.thumb).contentType)).toBe(
        "application/octet-stream",
      )
    }),
  )

  it.effect("checks Offload.source options when the write runs", () =>
    Effect.gen(function* () {
      const store = memory()
      const cases = [
        [Offload.source(bytes(4), { contentType: "" }), /contentType must be/],
        [Offload.source(bytes(4), { contentType: "image/é" }), /contentType must be/],
        // A control character no HTTP header can carry (a header injection).
        [
          Offload.source(bytes(4), { contentType: "text/plain\r\nX-Injected: 1" }),
          /contentType must be a non-empty printable US-ASCII string/,
        ],
        [Offload.source(bytes(4), { contentType: "text/plain\u0000" }), /contentType must be/],
        [Offload.source(bytes(4), { contentLength: -1 }), /contentLength must be/],
        [Offload.source(bytes(4), { contentLength: 5 }), /contentLength is 5/],
        [Offload.source("text" as never), /takes a Uint8Array or a Stream/],
      ] as const
      for (const [scan, pattern] of cases) {
        refusal(
          yield* Effect.exit(withDb(store, (db) => db.entities.Docs.put(doc("a", { scan })))),
          pattern,
        )
      }
      expect(store.inspect().calls.put).toBe(0)
      expect(rows.size).toBe(0)
    }),
  )

  it.effect("refuses an input of the wrong shape, and a stream for an overflow field", () =>
    Effect.gen(function* () {
      const store = memory()
      refusal(
        yield* Effect.exit(
          withDb(store, (db) => db.entities.Docs.put(doc("a", { scan: "not bytes" }))),
        ),
        /binary field "scan" takes a Uint8Array, a Stream of bytes, a BlobHandle/,
      )
      refusal(
        yield* Effect.exit(
          withDb(store, (db) => db.entities.Docs.put(doc("a", { body: chunked(bytes(4), 2) }))),
        ),
        /overflow field "body" takes its domain value, got a Stream/,
      )
      expect(store.inspect().calls.put).toBe(0)
    }),
  )

  it.effect("refuses a Stream given to two fields of one put, before anything uploads", () =>
    Effect.gen(function* () {
      const store = memory()
      const source = chunked(bytes(8), 4)
      refusal(
        yield* Effect.exit(
          withDb(store, (db) => db.entities.Docs.put(doc("a", { scan: source, thumb: source }))),
        ),
        /another field of this item/,
      )
      expect(store.inspect().calls.put).toBe(0)
      expect(rows.size).toBe(0)
    }),
  )

  it.effect("refuses a Stream reused by a later operation", () =>
    Effect.gen(function* () {
      const store = memory()
      const source = chunked(bytes(8), 4)
      yield* withDb(store, (db) => db.entities.Docs.put(doc("a", { scan: source })))
      refusal(
        yield* Effect.exit(
          withDb(store, (db) => db.entities.Docs.update({ docId: "a" }).set({ thumb: source })),
        ),
        /an earlier operation already consumed it/,
      )
      expect(store.inspect().versions).toHaveLength(1)
    }),
  )

  it.effect("Batch.write: one Stream for two items is refused, and nothing is written", () =>
    Effect.gen(function* () {
      const store = memory()
      const source = chunked(bytes(8), 4)
      refusal(
        yield* Effect.exit(
          provide(
            store,
            Batch.write([
              Docs.put(doc("a", { scan: source })),
              Docs.put(doc("b", { scan: source })),
            ]),
          ),
        ),
        /single-use/,
      )
      expect(rows.size).toBe(0)
      expect(store.inspect().versions).toEqual([])
    }),
  )

  it.live("a retried request reuses its stream's upload", () =>
    Effect.gen(function* () {
      const store = memory()
      const pulled = { n: 0 }
      leaveOnce.push((request) => request.PutRequest?.Item?.docId?.S === "b")
      yield* provide(
        store,
        Batch.write(
          [
            Docs.put(doc("a", { scan: bytes(4) })),
            Docs.put(doc("b", { scan: chunked(bytes(8), 4, pulled) })),
          ],
          { baseDelayMs: 1 },
        ),
      )
      expect(pulled.n).toBe(2)
      expect(store.inspect().calls.put).toBe(2)
      expect(pointerOf(live("Doc", "docId", "b")!.scan).checksum.value).toEqual(crc64nvme(bytes(8)))
    }),
  )

  it.effect("update, upsert and append take streams", () =>
    Effect.gen(function* () {
      const store = memory({ partSize: 4 })
      yield* withDb(store, (db) =>
        Effect.gen(function* () {
          yield* db.entities.Docs.put(doc("a"))
          yield* db.entities.Docs.update({ docId: "a" }).set({ scan: chunked(bytes(10), 3) })
          yield* db.entities.Docs.upsert(doc("b", { thumb: chunked(bytes(6, 3), 2) }))
          yield* db.entities.Readings.append({ sensorId: "s", at: 1, raw: chunked(bytes(9), 5) })
        }),
      )
      expect(pointerOf(live("Doc", "docId", "a")!.scan).checksum.value).toEqual(
        crc64nvme(bytes(10)),
      )
      expect(pointerOf(live("Doc", "docId", "b")!.thumb).checksum.value).toEqual(
        crc64nvme(bytes(6, 3)),
      )
      // One upload under the event item's key; its pointer is on both rows.
      const readings = [...rows.values()].filter((item) => item.__edd_e__?.S === "Reading")
      expect(readings).toHaveLength(2)
      const refs = readings.map((item) => pointerOf(item.raw).ref)
      expect(refs[0]).toEqual(refs[1])
      expect(store.inspect().calls.put).toBe(3)
    }),
  )
})

// ---------------------------------------------------------------------------
// Through the S3 store (a stubbed S3Client)
// ---------------------------------------------------------------------------

describe("Offload — streaming through the S3 store (stubbed S3Client)", () => {
  /**
   * The S3 store over `stub`, its parts `partSize` bytes (S3's 5 MiB minimum
   * is the bucket's to enforce; the stub does not).
   */
  const s3 = (stub: StubS3, partSize = 8, tuning: Partial<S3Tuning> = {}): BlobStoreService =>
    makeService(
      {
        ...resolveOptions("test", { bucket: "test-bucket", prefix: "app/", client: stub.client }),
        partSize,
      },
      stub.client,
      { maxCopyObjectBytes: 5 * 1024 ** 3, maxParts: 10_000, ...tuning },
    )

  const count = (stub: StubS3, name: string): number => stub.inputs(name).length

  /**
   * Interrupt `fiber` while one of its calls is held by a gate, then release
   * the gate: the interruption is registered before the call answers.
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

  /** Put `a` with `content`, then read its lazy handle. */
  const handleOf = (store: BlobStoreService, content: Uint8Array) =>
    withDb(store, (db) =>
      Effect.gen(function* () {
        yield* db.entities.Docs.put(doc("a", { scan: content }))
        const read = yield* db.entities.Docs.get({ docId: "a" })
        return read.scan!
      }),
    )

  it.effect("single PUT and multipart give the same checksum, sent to S3 and in the pointer", () =>
    Effect.gen(function* () {
      const content = bytes(30)
      const singleStub = makeStubS3()
      yield* withDb(s3(singleStub, 64), (db) => db.entities.Docs.put(doc("a", { scan: content })))
      const viaSingle = pointerOf(live("Doc", "docId", "a")!.scan)
      resetStore()
      const multiStub = makeStubS3()
      const multi = s3(multiStub)
      yield* withDb(multi, (db) => db.entities.Docs.put(doc("a", { scan: chunked(content, 7) })))
      const viaMulti = pointerOf(live("Doc", "docId", "a")!.scan)
      expect(singleStub.names()).toEqual(["PutObject"])
      expect(count(multiStub, "UploadPart")).toBe(4)
      expect(count(multiStub, "CompleteMultipartUpload")).toBe(1)
      expect(viaMulti.checksum.value).toEqual(crc64nvme(content))
      expect(viaMulti.checksum.value).toEqual(viaSingle.checksum.value)
      // S3 was sent (and the stub validated) the same full-object value.
      expect(multiStub.inputs("CompleteMultipartUpload")[0].ChecksumCRC64NVME).toBe(
        singleStub.inputs("PutObject")[0].ChecksumCRC64NVME,
      )
      // The pointer names the version S3 answered.
      expect(multiStub.version(viaMulti.ref.key, viaMulti.ref.version)?.bytes).toEqual(content)
      const read = yield* withDb(multi, (db) =>
        db.entities.Docs.get({ docId: "a" }).offloaded("eager"),
      )
      expect(read.scan).toEqual(content)
    }),
  )

  it.effect("adapts the part size to a known contentLength; part maxParts + 1 is TooLarge", () =>
    Effect.gen(function* () {
      const content = bytes(40)
      const stub = makeStubS3({ maxParts: 5 })
      const store = s3(stub, 4, { maxParts: 5 })
      yield* withDb(store, (db) =>
        db.entities.Docs.put(
          doc("a", { scan: Offload.source(chunked(content, 9), { contentLength: 40 }) }),
        ),
      )
      // ceil(40 / 5) = 8-byte parts: five of them.
      expect(stub.inputs("UploadPart").map((part) => part.Body.length)).toEqual([8, 8, 8, 8, 8])
      const error = blobFailure(
        yield* Effect.exit(
          withDb(store, (db) => db.entities.Docs.put(doc("b", { scan: chunked(content, 9) }))),
        ),
      )
      expect(error.reason).toBe("TooLarge")
      expect(error.action).toBe("put")
      expect(live("Doc", "docId", "b")).toBeUndefined()
      expect(count(stub, "AbortMultipartUpload")).toBe(1)
      expect(stub.uploads.size).toBe(0)
      expect(stub.objects.size).toBe(1)
    }),
  )

  it.effect("interrupting an upload aborts it: no Complete, nothing written", () =>
    Effect.gen(function* () {
      let started: () => void = () => undefined
      const partTwo = new Promise<void>((resolve) => {
        started = resolve
      })
      const stub = makeStubS3({
        faults: (call) => {
          if (call.name !== "UploadPart" || call.input.PartNumber !== 2) return undefined
          started()
          // Never answers: only the interruption's abort signal ends it.
          return new Promise<never>(() => undefined)
        },
      })
      const fiber = yield* withDb(s3(stub), (db) =>
        db.entities.Docs.put(doc("a", { scan: chunked(bytes(40), 8) })),
      ).pipe(Effect.forkChild)
      yield* Effect.promise(() => partTwo)
      yield* Fiber.interrupt(fiber)
      expect(count(stub, "CreateMultipartUpload")).toBe(1)
      expect(count(stub, "AbortMultipartUpload")).toBe(1)
      expect(count(stub, "CompleteMultipartUpload")).toBe(0)
      expect(stub.uploads.size).toBe(0)
      expect(stub.objects.size).toBe(0)
      expect(rows.size).toBe(0)
      expect(reports.map((report) => report.reason)).toEqual(["interrupted"])
    }),
  )

  it.effect("an upload interrupted while its Complete is in flight is reported (interrupted)", () =>
    Effect.gen(function* () {
      const gate = makeGate()
      const stub = makeStubS3({
        faults: (call) => (call.name === "CompleteMultipartUpload" ? gate.hold() : undefined),
      })
      const fiber = yield* withDb(s3(stub), (db) =>
        db.entities.Docs.put(doc("a", { scan: chunked(bytes(40), 8) })),
      ).pipe(Effect.forkChild)
      yield* Effect.promise(() => gate.reached)
      const exit = yield* interruptWhileHeld(fiber, gate.release)
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      expect(rows.size).toBe(0)
      // S3 completed it, and the upload is never aborted; the answer was lost
      // to the interruption, so the version has no pointer: reported by key.
      expect(count(stub, "AbortMultipartUpload")).toBe(0)
      expect(reports.map((report) => report.reason)).toEqual(["interrupted"])
      expect(reports[0]).toMatchObject({ entityType: "Doc", attribute: "scan", ref: Option.none() })
      const [complete] = stub.inputs("CompleteMultipartUpload")
      expect(reports[0]!.key).toBe(complete.Key)
      expect(stub.objects.get(complete.Key)).toHaveLength(1)
    }),
  )

  it.effect("a single PutObject interrupted mid-flight is reported (interrupted)", () =>
    Effect.gen(function* () {
      const gate = makeGate()
      const stub = makeStubS3({
        // Never answers: only the interruption's abort signal ends it.
        faults: (call) => (call.name === "PutObject" ? gate.hold() : undefined),
      })
      const fiber = yield* withDb(s3(stub, 64), (db) =>
        db.entities.Docs.put(doc("a", { scan: bytes(30) })),
      ).pipe(Effect.forkChild)
      yield* Effect.promise(() => gate.reached)
      yield* Fiber.interrupt(fiber)
      expect(rows.size).toBe(0)
      // S3 may have stored the body before the request was aborted.
      expect(reports.map((report) => report.reason)).toEqual(["interrupted"])
      expect(reports[0]!.key).toBe(stub.inputs("PutObject")[0].Key)
    }),
  )

  it.effect("a part S3 refuses fails the write and aborts the upload; nothing is written", () =>
    Effect.gen(function* () {
      const stub = makeStubS3({
        faults: (call) =>
          call.name === "UploadPart" && call.input.PartNumber === 2
            ? { _tag: "fail", error: s3Error("AccessDenied", 403) }
            : undefined,
      })
      const error = blobFailure(
        yield* Effect.exit(
          withDb(s3(stub), (db) => db.entities.Docs.put(doc("a", { scan: chunked(bytes(40), 8) }))),
        ),
      )
      expect(error.reason).toBe("AccessDenied")
      expect(error.action).toBe("put")
      expect(count(stub, "AbortMultipartUpload")).toBe(1)
      expect(count(stub, "CompleteMultipartUpload")).toBe(0)
      expect(stub.uploads.size).toBe(0)
      expect(stub.objects.size).toBe(0)
      expect(rows.size).toBe(0)
    }),
  )

  it.effect("a source failure is SourceFailed: every upload created is aborted", () =>
    Effect.gen(function* () {
      const stub = makeStubS3()
      const source = Stream.concat(chunked(bytes(20), 4), Stream.fail(new Error("disk gone")))
      const error = blobFailure(
        yield* Effect.exit(
          withDb(s3(stub), (db) => db.entities.Docs.put(doc("a", { scan: source }))),
        ),
      )
      expect(error.reason).toBe("SourceFailed")
      expect(String((error.cause as { readonly cause?: unknown }).cause)).toMatch(/disk gone/)
      expect(count(stub, "AbortMultipartUpload")).toBe(count(stub, "CreateMultipartUpload"))
      expect(count(stub, "CompleteMultipartUpload")).toBe(0)
      expect(stub.uploads.size).toBe(0)
      expect(stub.objects.size).toBe(0)
      expect(rows.size).toBe(0)
    }),
  )

  it.effect(
    "a Complete whose response is lost is reported (completeLost); nothing is written",
    () =>
      Effect.gen(function* () {
        const stub = makeStubS3({
          faults: (call) =>
            call.name === "CompleteMultipartUpload"
              ? { _tag: "lost", error: transportError() }
              : undefined,
        })
        const error = blobFailure(
          yield* Effect.exit(
            withDb(s3(stub), (db) =>
              db.entities.Docs.put(doc("a", { scan: chunked(bytes(20), 6) })),
            ),
          ),
        )
        expect(error.reason).toBe("Unavailable")
        expect(rows.size).toBe(0)
        expect(reports).toHaveLength(1)
        expect(reports[0]).toMatchObject({
          reason: "completeLost",
          entityType: "Doc",
          attribute: "scan",
          ref: Option.none(),
        })
        // S3 completed it: a version no pointer names, under the reported key, for gc.sweep.
        expect(stub.objects.get(reports[0]!.key)).toHaveLength(1)
        expect(stub.objects.size).toBe(1)
      }),
  )

  it.effect("a put into a bucket without versioning is Unversioned; nothing is left", () =>
    Effect.gen(function* () {
      for (const versioning of ["Unversioned", "Suspended"] as const) {
        resetStore()
        const stub = makeStubS3({ versioning })
        const error = blobFailure(
          yield* Effect.exit(
            withDb(s3(stub, 64), (db) => db.entities.Docs.put(doc("a", { scan: bytes(30) }))),
          ),
        )
        expect(error.reason).toBe("Unversioned")
        expect(error.action).toBe("put")
        expect(rows.size).toBe(0)
        expect(stub.objects.size).toBe(0)
        expect(stub.deleteMarkers.size).toBe(0)
      }
    }),
  )

  it.effect("copies a handle with CopyObject, by its version; the pointer names the copy", () =>
    Effect.gen(function* () {
      const stub = makeStubS3()
      const store = s3(stub)
      const content = bytes(12)
      const handle = yield* handleOf(store, content)
      const source = Option.getOrThrow(handle.ref)
      yield* withDb(store, (db) => db.entities.Docs.put(doc("b", { scan: handle })))
      const [copy] = stub.inputs("CopyObject")
      expect(copy.CopySource).toBe(copySourceOf("test-bucket", source))
      expect(copy.MetadataDirective).toBe("REPLACE")
      const pointer = pointerOf(live("Doc", "docId", "b")!.scan)
      expect(pointer.ref.key).toBe(copy.Key)
      expect(pointer.ref.key).not.toBe(source.key)
      expect(stub.version(pointer.ref.key, pointer.ref.version)?.bytes).toEqual(content)
      expect(pointer.checksum.value).toEqual(handle.checksum.value)
      const read = yield* withDb(store, (db) =>
        db.entities.Docs.get({ docId: "b" }).offloaded("eager"),
      )
      expect(read.scan).toEqual(content)
    }),
  )

  it.effect("streams a handle into a PutObject without the copy capability", () =>
    Effect.gen(function* () {
      const stub = makeStubS3()
      const { copy: _copy, ...noCopy } = s3(stub, 64)
      const content = bytes(12)
      const handle = yield* handleOf(noCopy, content)
      yield* withDb(noCopy, (db) => db.entities.Docs.put(doc("b", { scan: handle })))
      expect(count(stub, "CopyObject")).toBe(0)
      expect(count(stub, "GetObject")).toBe(1)
      expect(count(stub, "PutObject")).toBe(2)
      const pointer = pointerOf(live("Doc", "docId", "b")!.scan)
      expect(stub.version(pointer.ref.key, pointer.ref.version)?.bytes).toEqual(content)
    }),
  )

  it.effect("checks the copy's VersionId: a copy into a suspended bucket is Unversioned", () =>
    Effect.gen(function* () {
      const stub = makeStubS3()
      const store = s3(stub)
      const handle = yield* handleOf(store, bytes(12))
      const source = Option.getOrThrow(handle.ref)
      stub.versioning = "Suspended"
      const error = blobFailure(
        yield* Effect.exit(withDb(store, (db) => db.entities.Docs.put(doc("b", { scan: handle })))),
      )
      expect(error.reason).toBe("Unversioned")
      expect(error.action).toBe("copy")
      expect(live("Doc", "docId", "b")).toBeUndefined()
      // The copy was deleted; its source is untouched.
      const [copy] = stub.inputs("CopyObject")
      expect(stub.objects.get(copy.Key)).toBeUndefined()
      expect(stub.version(source.key, source.version)).toBeDefined()
      expect(stub.deleteMarkers.size).toBe(0)
    }),
  )

  it.effect("a multipart copy whose Complete response is lost is reported (completeLost)", () =>
    Effect.gen(function* () {
      // The second Complete (the copy's; the first is the source's put) is lost.
      const stub = makeStubS3({
        faults: (call) =>
          call.name === "CompleteMultipartUpload" && call.n === 2
            ? { _tag: "lost", error: transportError() }
            : undefined,
      })
      // Copies over 16 bytes run as UploadPartCopy ranges.
      const store = s3(stub, 8, { maxCopyObjectBytes: 16 })
      const handle = yield* handleOf(store, bytes(40))
      const error = blobFailure(
        yield* Effect.exit(withDb(store, (db) => db.entities.Docs.put(doc("b", { scan: handle })))),
      )
      expect(error.reason).toBe("Unavailable")
      expect(error.action).toBe("copy")
      expect(count(stub, "UploadPartCopy")).toBe(5)
      expect(live("Doc", "docId", "b")).toBeUndefined()
      expect(reports.map((report) => report.reason)).toEqual(["completeLost"])
      const [create] = stub.inputs("CreateMultipartUpload").slice(-1)
      expect(reports[0]!.key).toBe(create.Key)
      // S3 completed it: a version no pointer names, for gc.sweep.
      expect(stub.objects.get(create.Key)).toHaveLength(1)
    }),
  )

  it.effect("a multipart copy interrupted while its Complete is in flight is reported", () =>
    Effect.gen(function* () {
      const gate = makeGate()
      // The second Complete (the copy's; the first is the source's put) is held.
      const stub = makeStubS3({
        faults: (call) =>
          call.name === "CompleteMultipartUpload" && call.n === 2 ? gate.hold() : undefined,
      })
      const store = s3(stub, 8, { maxCopyObjectBytes: 16 })
      const handle = yield* handleOf(store, bytes(40))
      reports.length = 0
      const fiber = yield* withDb(store, (db) =>
        db.entities.Docs.put(doc("b", { scan: handle })),
      ).pipe(Effect.forkChild)
      yield* Effect.promise(() => gate.reached)
      const exit = yield* interruptWhileHeld(fiber, gate.release)
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      expect(live("Doc", "docId", "b")).toBeUndefined()
      expect(count(stub, "AbortMultipartUpload")).toBe(0)
      expect(reports.map((report) => report.reason)).toEqual(["interrupted"])
      const [create] = stub.inputs("CreateMultipartUpload").slice(-1)
      expect(reports[0]!.key).toBe(create.Key)
      expect(stub.objects.get(create.Key)).toHaveLength(1)
    }),
  )
})
