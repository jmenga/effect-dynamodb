/**
 * The upload ledger (#179, design §6.2), driven with synthetic operations: a
 * root, uploads to the in-memory store, and write requests carrying their
 * pointers sent through the instrumented client (`Capacity.instrument`, the
 * choke point every library request goes through) to a scripted mock.
 *
 * - Roots, entries, the memo (content identity per key and store; stale
 *   entries not reused; failures not memoised), the store-result checks and
 *   the per-ledger `writeConcurrency`.
 * - Settlement by outcome — every row of §6.2's table, including
 *   `$metadata.attempts`, the library's `ClientRequestToken`, `ALL_OLD`
 *   evidence (plain and pointer-copying members), the `if_not_exists` image,
 *   `BatchWriteItem`'s unprocessed items, `NotSent`, interruption and the
 *   lattice.
 * - `maxUploadAge` (`Expired`, nothing sent), the exit (rollback in one delete
 *   per store, best-effort; `Warning` logs; `Offload.layerObserver`) and the
 *   read cache.
 */

import {
  ConditionalCheckFailedException,
  DynamoDBServiceException,
  IdempotentParameterMismatchException,
  ProvisionedThroughputExceededException,
  ResourceNotFoundException,
  InternalServerError as SdkInternalServerError,
  TransactionCanceledException,
  TransactionInProgressException,
} from "@aws-sdk/client-dynamodb"
import { describe, expect, it } from "@effect/vitest"
import {
  BlobStoreError,
  DynamoError,
  DynamoValidationError,
  InternalServerError,
  ResourceNotFoundError,
  ThrottlingError,
} from "@effect-dynamodb/schema/Errors.js"
import * as BlobPointer from "@effect-dynamodb/schema/internal/BlobPointer.js"
import { crc64nvme } from "@effect-dynamodb/schema/internal/Crc64Nvme.js"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Logger, Option, References } from "effect"
import { TestClock } from "effect/testing"
import { BlobStore, type BlobStoreService, type MemoryBlobStore } from "../src/BlobStore.js"
import type { DynamoClientService } from "../src/DynamoClient.js"
import * as BlobLedger from "../src/internal/BlobLedger.js"
import * as Capacity from "../src/internal/Capacity.js"
import * as Offload from "../src/Offload.js"
import { mockDynamoClient } from "./helpers/MockDynamoClient.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text)

const target = (overrides: Partial<BlobLedger.UploadTarget> = {}): BlobLedger.UploadTarget => ({
  table: "docs",
  entityType: "Doc",
  attribute: "body",
  rowKey: { pk: "doc#1", sk: "doc" },
  operation: "Entity.put",
  copiesPointers: false,
  ...overrides,
})

const uploadJson = (
  store: BlobStoreService,
  text: string,
  options: { readonly key?: string; readonly target?: BlobLedger.UploadTarget } = {},
) =>
  BlobLedger.upload({
    store,
    key: options.key ?? "p/doc/body",
    content: { kind: "json", text },
    codec: "none",
    contentType: "application/json",
    metadata: { "edd-v": "1" },
    target: options.target ?? target(),
  })

const uploadBytes = (
  store: BlobStoreService,
  bytes: Uint8Array,
  options: { readonly key?: string; readonly target?: BlobLedger.UploadTarget } = {},
) =>
  BlobLedger.upload({
    store,
    key: options.key ?? "p/doc/scan",
    content: { kind: "bytes", bytes },
    codec: "none",
    contentType: "application/pdf",
    pointerContentType: "application/pdf",
    metadata: { "edd-v": "1" },
    target: options.target ?? target({ attribute: "scan" }),
  })

/** A pointer as an overflow field stores it (`B`), and as a binary one does (`S`). */
const asB = (pointer: BlobPointer.BlobPointer) => ({ B: BlobPointer.encode(pointer) })
const asS = (pointer: BlobPointer.BlobPointer) => ({ S: BlobPointer.encodeText(pointer) })

const rowKey = { pk: { S: "doc#1" }, sk: { S: "doc" } }

const putOf = (...values: ReadonlyArray<Record<string, unknown>>) => ({
  TableName: "docs",
  Item: {
    ...rowKey,
    ...Object.fromEntries(values.map((value, i) => [`f${i}`, value])),
  },
})

const versions = (store: MemoryBlobStore) => store.inspect().versions.map((v) => v.ref.version)

/** The state of the entry naming `pointer`, read inside the root. */
const stateOf = (pointer: BlobPointer.BlobPointer) =>
  Effect.map(
    BlobLedger.current,
    (ledger) => ledger?.entries.get(`${pointer.ref.key}\u0000${pointer.ref.version}`)?.state,
  )

interface Sent {
  readonly command: string
  readonly input: Record<string, any>
}

/**
 * A scripted client, instrumented as the library sees it: `answer` decides
 * each request's outcome; every request is recorded as sent.
 */
const scripted = (
  answer: (command: string, input: Record<string, any>) => Effect.Effect<unknown, unknown>,
) => {
  const sent: Array<Sent> = []
  const method = (command: string) => (input: Record<string, any>) =>
    Effect.suspend(() => {
      sent.push({ command, input })
      return answer(command, input)
    })
  const raw = mockDynamoClient({
    getItem: method("GetItem") as never,
    putItem: method("PutItem") as never,
    updateItem: method("UpdateItem") as never,
    deleteItem: method("DeleteItem") as never,
    batchWriteItem: method("BatchWriteItem") as never,
    transactWriteItems: method("TransactWriteItems") as never,
  })
  return { client: Capacity.instrument(raw) as DynamoClientService & Record<string, any>, sent }
}

const ok = (attempts = 1) => Effect.succeed({ $metadata: { attempts } })

/** An SDK exception as the library's client wraps it (`classifyError`). */
const wrapped = (operation: string, sdk: Error & { readonly name: string }) => {
  switch (sdk.name) {
    case "ValidationException":
      return new DynamoValidationError({ operation, cause: sdk })
    case "ThrottlingException":
    case "ProvisionedThroughputExceededException":
      return new ThrottlingError({ operation, cause: sdk })
    case "InternalServerError":
      return new InternalServerError({ operation, cause: sdk })
    case "ResourceNotFoundException":
      return new ResourceNotFoundError({ operation, cause: sdk })
    default:
      return new DynamoError({ operation, cause: sdk })
  }
}

const metadata = (attempts: number | undefined) =>
  attempts === undefined ? { $metadata: {} } : { $metadata: { attempts } }

const serviceError = (name: string, attempts: number | undefined) =>
  new DynamoDBServiceException({
    name,
    $fault: "client",
    message: name,
    ...metadata(attempts),
  })

const conditionFailed = (attempts: number, item?: Record<string, unknown>) =>
  new ConditionalCheckFailedException({
    message: "The conditional request failed",
    ...metadata(attempts),
    ...(item !== undefined && { Item: item as never }),
  })

/** Collects every unsettled upload the observer is handed. */
const observed = () => {
  const reports: Array<BlobLedger.UnsettledUpload> = []
  const layer = Offload.layerObserver({
    onUnsettled: (upload) =>
      Effect.sync(() => {
        reports.push(upload)
      }),
  })
  return { reports, layer }
}

/** Collects every log line: level, first message part and annotations. */
const logs = () => {
  const lines: Array<{
    readonly level: string
    readonly message: unknown
    readonly annotations: Readonly<Record<string, unknown>>
  }> = []
  const logger = Logger.make((options) => {
    const message = Array.isArray(options.message) ? options.message[0] : options.message
    lines.push({
      level: options.logLevel,
      message,
      annotations: options.fiber.getRef(References.CurrentLogAnnotations),
    })
  })
  return { lines, layer: Logger.layer([logger]) }
}

// ---------------------------------------------------------------------------
// Roots and uploads
// ---------------------------------------------------------------------------

describe("BlobLedger — roots and uploads", () => {
  it.effect("an upload outside a root dies", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(uploadJson(BlobStore.memory(), "{}"))
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
    }),
  )

  it.effect("an upload records a pending entry, its pointer and its content", () =>
    Effect.gen(function* () {
      const store = BlobStore.memory()
      const text = JSON.stringify({ notes: "x".repeat(100) })
      const scan = bytesOf("%PDF-1.7 ...")
      yield* BlobLedger.root(
        Effect.gen(function* () {
          const json = yield* uploadJson(store, text)
          expect(json.kind).toBe("json")
          expect(json.codec).toBe("none")
          expect(json.ref.key).toBe("p/doc/body")
          expect(json.objectSize).toBe(bytesOf(text).length)
          expect(json.contentSize).toBe(bytesOf(text).length)
          expect(json.checksum.value).toEqual(crc64nvme(bytesOf(text)))
          expect(Option.isNone(json.contentType)).toBe(true)
          const bytes = yield* uploadBytes(store, scan)
          expect(bytes.kind).toBe("bytes")
          expect(bytes.contentType).toEqual(Option.some("application/pdf"))

          const ledger = (yield* BlobLedger.current)!
          expect([...ledger.entries.values()].map((entry) => entry.state)).toEqual([
            "pending",
            "pending",
          ])
          expect(BlobLedger.cached(ledger, json.ref)).toEqual({ kind: "json", text })
          expect(BlobLedger.cached(ledger, bytes.ref)).toEqual({ kind: "bytes", bytes: scan })
          // What was stored, with the requested type and metadata.
          const stored = store.inspect().versions
          expect(stored).toHaveLength(2)
          expect(stored.find((v) => v.ref.key === "p/doc/scan")?.contentType).toBe(
            "application/pdf",
          )
          expect(stored[0]!.metadata).toEqual({ "edd-v": "1" })
        }),
      )
    }),
  )

  it.effect(
    "a compressed upload records the object and content sizes, the content's checksum",
    () =>
      Effect.gen(function* () {
        const store = BlobStore.memory()
        const text = JSON.stringify({ a: 1 })
        const body = bytesOf("compressed!")
        const pointer = yield* BlobLedger.root(
          BlobLedger.upload({
            store,
            key: "p/doc/body",
            content: { kind: "json", text },
            codec: "zstd",
            body,
            contentType: "application/json",
            metadata: {},
            target: target(),
          }),
        )
        expect(pointer.codec).toBe("zstd")
        expect(pointer.objectSize).toBe(body.length)
        expect(pointer.contentSize).toBe(bytesOf(text).length)
        expect(pointer.checksum.value).toEqual(crc64nvme(bytesOf(text)))
      }),
  )

  it.effect("a root nested in an open one joins it, and only the outer one closes it", () =>
    Effect.gen(function* () {
      const store = BlobStore.memory()
      yield* BlobLedger.root(
        Effect.gen(function* () {
          const outer = yield* BlobLedger.current
          const inner = yield* BlobLedger.root(
            Effect.andThen(uploadJson(store, "1"), BlobLedger.current),
          )
          expect(inner).toBe(outer)
          expect(outer!.closed).toBe(false)
          // Still open: a later upload joins it.
          yield* uploadJson(store, "2", { key: "p/doc/other" })
          expect(outer!.entries.size).toBe(2)
          expect(versions(store)).toHaveLength(2)
        }),
      )
      // Nothing carried them: both rolled back at the outer exit.
      expect(versions(store)).toEqual([])
    }),
  )

  it.effect("the root's exit deletes a pending upload on success, failure and interruption", () =>
    Effect.gen(function* () {
      const store = BlobStore.memory()
      yield* BlobLedger.root(uploadJson(store, "1"))
      expect(versions(store)).toEqual([])

      const failed = yield* Effect.exit(
        BlobLedger.root(Effect.andThen(uploadJson(store, "2"), Effect.fail("boom"))),
      )
      expect(failed).toEqual(Exit.fail("boom"))
      expect(versions(store)).toEqual([])

      const uploaded = yield* Deferred.make<void>()
      const fiber = yield* BlobLedger.root(
        Effect.andThen(
          uploadJson(store, "3"),
          Effect.andThen(Deferred.succeed(uploaded, undefined), Effect.never),
        ),
      ).pipe(Effect.forkChild)
      yield* Deferred.await(uploaded)
      expect(versions(store)).toHaveLength(1)
      yield* Fiber.interrupt(fiber)
      expect(versions(store)).toEqual([])
      expect(store.inspect().calls.delete).toBe(3)
    }),
  )

  it.effect("the same content to the same key and store uploads once", () =>
    Effect.gen(function* () {
      const store = BlobStore.memory()
      yield* BlobLedger.root(
        Effect.gen(function* () {
          const first = yield* uploadJson(store, "same")
          const again = yield* uploadJson(store, "same")
          expect(again).toBe(first)
          // Concurrent identical uploads share the one put.
          const both = yield* Effect.all(
            [uploadJson(store, "conc", { key: "p/c" }), uploadJson(store, "conc", { key: "p/c" })],
            { concurrency: "unbounded" },
          )
          expect(both[0]).toBe(both[1])
          expect(store.inspect().calls.put).toBe(2)
          // The same bytes to another key, other content to the same key, the
          // same content as bytes, and another store: each its own upload.
          yield* uploadJson(store, "same", { key: "p/doc/other" })
          yield* uploadJson(store, "different")
          yield* uploadBytes(store, bytesOf("same"), { key: "p/doc/body" })
          const other = BlobStore.memory()
          yield* uploadJson(other, "same")
          expect(store.inspect().calls.put).toBe(5)
          expect(other.inspect().calls.put).toBe(1)
        }),
      )
    }),
  )

  it.effect("a failed upload is not memoised", () =>
    Effect.gen(function* () {
      const store = BlobStore.memory({
        failures: (call) =>
          call.action === "put" && call.n === 1 ? { _tag: "Fail", reason: "Throttled" } : undefined,
      })
      yield* BlobLedger.root(
        Effect.gen(function* () {
          const error = yield* Effect.flip(uploadJson(store, "x"))
          expect(error).toBeInstanceOf(BlobStoreError)
          expect(error.reason).toBe("Throttled")
          expect(error.action).toBe("put")
          expect(error.entityType).toBe("Doc")
          expect(error.attribute).toBe("body")
          expect(error.operation).toBe("Entity.put")
          expect(error.committed).toBe(false)
          yield* uploadJson(store, "x")
          expect(store.inspect().calls.put).toBe(2)
        }),
      )
    }),
  )

  it.effect("an upload older than maxUploadAge that nothing committed is not reused", () =>
    Effect.gen(function* () {
      const store = BlobStore.memory({ maxUploadAge: "2 minutes" })
      yield* BlobLedger.root(
        Effect.gen(function* () {
          const first = yield* uploadJson(store, "x")
          yield* TestClock.adjust("3 minutes")
          const second = yield* uploadJson(store, "x")
          expect(second.ref.version).not.toBe(first.ref.version)
          expect(store.inspect().calls.put).toBe(2)
        }),
      )
      expect(versions(store)).toEqual([])
    }),
  )

  it.effect("uploads run at the store's writeConcurrency per ledger", () =>
    Effect.gen(function* () {
      const memory = BlobStore.memory({ writeConcurrency: 2 })
      let inFlight = 0
      let most = 0
      const store: BlobStoreService = {
        ...memory,
        put: (request) =>
          Effect.gen(function* () {
            inFlight++
            most = Math.max(most, inFlight)
            yield* Effect.yieldNow
            yield* Effect.yieldNow
            inFlight--
            return yield* memory.put(request)
          }),
      }
      yield* BlobLedger.root(
        Effect.forEach([1, 2, 3, 4, 5], (n) => uploadJson(store, `${n}`, { key: `p/${n}` }), {
          concurrency: "unbounded",
        }),
      )
      expect(most).toBe(2)
    }),
  )

  /** `memory`, its `put` answers changed by `change` and its deletes recorded. */
  const lyingStore = (
    memory: MemoryBlobStore,
    change: (result: { ref: BlobPointer.BlobRef; size: number }) => unknown,
    deletes: Array<ReadonlyArray<BlobPointer.BlobRef>>,
    limits: BlobStoreService["limits"] = memory.limits,
  ): BlobStoreService => ({
    ...memory,
    limits,
    put: (request) => Effect.map(memory.put(request), (result) => change(result) as never),
    delete: (refs) =>
      Effect.andThen(
        Effect.sync(() => {
          deletes.push(refs)
        }),
        memory.delete(refs),
      ),
  })

  it.effect(
    "a store answer naming a version of the requested key that breaks a limit is Rejected, and that version rolled back",
    () =>
      Effect.gen(function* () {
        const { reports, layer } = observed()
        const refused = (
          memory: MemoryBlobStore,
          change: (result: { ref: BlobPointer.BlobRef; size: number }) => unknown,
          limits?: BlobStoreService["limits"],
        ) =>
          Effect.gen(function* () {
            const deletes: Array<ReadonlyArray<BlobPointer.BlobRef>> = []
            const store = lyingStore(memory, change, deletes, limits)
            const error = yield* Effect.flip(BlobLedger.root(uploadJson(store, "value")))
            expect(error.reason).toBe("Rejected")
            // The version the store wrote is the one deleted, and nothing is left.
            const written = memory.inspect().calls.put
            expect(written).toBe(1)
            expect(deletes).toEqual([[error.ref]])
            expect(error.ref?.key.startsWith("p/doc/body")).toBe(true)
            expect(versions(memory)).toEqual([])
            return String(error.cause)
          }).pipe(Effect.provide(layer))

        expect(yield* refused(BlobStore.memory(), (r) => ({ ...r, size: r.size + 1 }))).toContain(
          "reported 6 stored bytes for a 5-byte body",
        )
        // Limits the store declares lower than what it makes.
        expect(
          yield* refused(BlobStore.memory(), (r) => r, {
            maxVersionBytes: 8,
            maxKeySuffixBytes: 0,
          }),
        ).toContain("returned a 32-byte version, over its declared limits.maxVersionBytes (8)")
        expect(
          yield* refused(BlobStore.memory({ versioning: "keyPerWrite" }), (r) => r, {
            maxVersionBytes: 0,
            maxKeySuffixBytes: 10,
          }),
        ).toContain("extended the key by 27 bytes, over its declared limits.maxKeySuffixBytes (10)")
        // Rolled back like any other upload: nothing to report.
        expect(reports).toEqual([])
      }),
  )

  it.effect(
    "a store answer naming no version of the requested key is Rejected, nothing it names is deleted, and the key is reported",
    () =>
      Effect.gen(function* () {
        const memory = BlobStore.memory()
        const deletes: Array<ReadonlyArray<BlobPointer.BlobRef>> = []
        const lying = (change: (result: { ref: BlobPointer.BlobRef; size: number }) => unknown) =>
          lyingStore(memory, change, deletes)
        // Another row's committed version, which a buggy store answers with.
        const elsewhere = bytesOf("committed elsewhere")
        const other = yield* memory.put({
          key: "other/row/attr",
          body: elsewhere,
          contentLength: elsewhere.length,
          checksum: Effect.succeed({ algorithm: "crc64nvme", value: crc64nvme(elsewhere) }),
          contentType: "application/json",
          metadata: {},
        })
        const underKey = () =>
          memory.inspect().versions.filter((v) => v.ref.key === "p/doc/body").length

        const refused = (run: Effect.Effect<BlobPointer.BlobPointer, BlobStoreError>) =>
          Effect.gen(function* () {
            const { reports, layer } = observed()
            deletes.length = 0
            const before = underKey()
            const error = yield* BlobLedger.root(
              Effect.gen(function* () {
                const error = yield* Effect.flip(run)
                // Reported when the root exits, with the rest.
                expect(reports).toEqual([])
                return error
              }),
            ).pipe(Effect.provide(layer))
            expect(error.reason).toBe("Rejected")
            // The ref the store answered with is never deleted; the version it
            // wrote under the requested key is left for gc.sweep, and reported.
            expect(deletes.flat()).not.toContainEqual(other.ref)
            expect(versions(memory)).toContain(other.ref.version)
            expect(underKey()).toBe(before + 1)
            expect(reports).toEqual([
              {
                reason: "answerRefused",
                table: "docs",
                entityType: "Doc",
                attribute: "body",
                operation: "Entity.put",
                rowKey: { pk: "doc#1", sk: "doc" },
                key: "p/doc/body",
                ref: undefined,
                store: memory.name,
                cause: error,
              },
            ])
            return error
          })

        const outside = yield* refused(
          uploadJson(
            lying((r) => ({ ...r, ref: other.ref })),
            "value",
          ),
        )
        expect(String(outside.cause)).toContain(
          'returned key "other/row/attr", outside the requested key "p/doc/body"',
        )
        expect(deletes).toEqual([])

        const noRef = yield* refused(
          uploadJson(
            lying(() => ({ size: 5 })),
            "value",
          ),
        )
        expect(String(noRef.cause)).toContain("returned no { key, version } ref")
        expect(noRef.ref).toBe(undefined)
        expect(deletes).toEqual([])

        // A ref returned for two different uploads: the first upload's entry
        // stands (and is rolled back at exit, as nothing committed it).
        let fixed: BlobPointer.BlobRef | undefined
        const repeating = lying((r) => {
          fixed ??= r.ref
          return { ...r, ref: fixed }
        })
        const duplicate = yield* refused(
          Effect.andThen(uploadJson(repeating, "a"), uploadJson(repeating, "b")),
        )
        expect(String(duplicate.cause)).toContain("already returned for another upload")
        expect(deletes).toEqual([[fixed]])
      }),
  )
})

// ---------------------------------------------------------------------------
// Settlement: single-item writes
// ---------------------------------------------------------------------------

describe("BlobLedger — settling single-item writes", () => {
  /** Upload one value, send one request carrying it with `answer`, return its state and the store. */
  const settleOne = (
    answer: (command: string, input: Record<string, any>) => Effect.Effect<unknown, unknown>,
    options: {
      readonly command?: "putItem" | "updateItem" | "deleteItem"
      readonly copiesPointers?: boolean
      readonly request?: (pointer: BlobPointer.BlobPointer) => Record<string, unknown>
    } = {},
  ) =>
    Effect.gen(function* () {
      const store = BlobStore.memory()
      const { client, sent } = scripted(answer)
      const { reports, layer } = observed()
      const result = yield* BlobLedger.root(
        Effect.gen(function* () {
          const pointer = yield* uploadJson(store, "value", {
            target: target({ copiesPointers: options.copiesPointers ?? false }),
          })
          const request = options.request?.(pointer) ?? putOf(asB(pointer))
          const exit = yield* Effect.exit(client[options.command ?? "putItem"](request as never))
          return { exit, state: yield* stateOf(pointer) }
        }),
      ).pipe(Effect.provide(layer))
      return { ...result, kept: versions(store).length === 1, sent, reports }
    })

  it.effect("success commits, and the version is kept", () =>
    Effect.gen(function* () {
      const { state, kept, reports } = yield* settleOne(() => ok())
      expect(state).toBe("committed")
      expect(kept).toBe(true)
      expect(reports).toEqual([])
    }),
  )

  it.effect("a write carrying a pointer asks for ALL_OLD; a caller's choice is kept", () =>
    Effect.gen(function* () {
      const { sent } = yield* settleOne(() => ok())
      expect(sent[0]!.input.ReturnValuesOnConditionCheckFailure).toBe("ALL_OLD")
      const caller = yield* settleOne(() => Effect.fail(wrapped("PutItem", conditionFailed(1))), {
        request: (pointer) => ({
          ...putOf(asB(pointer)),
          ReturnValuesOnConditionCheckFailure: "NONE",
        }),
      })
      expect(caller.sent[0]!.input.ReturnValuesOnConditionCheckFailure).toBe("NONE")
      // No evidence was asked for: the outcome is unknown.
      expect(caller.state).toBe("inDoubt")
      expect(caller.kept).toBe(true)
    }),
  )

  it.effect("ConditionalCheckFailed settles by the ALL_OLD image", () =>
    Effect.gen(function* () {
      // The stored row holds the pointer: an earlier attempt committed it.
      let held: Record<string, unknown> | undefined
      const holding = yield* settleOne((_command, input) => {
        held = input.Item
        return Effect.fail(wrapped("PutItem", conditionFailed(2, held)))
      })
      expect(holding.state).toBe("committed")
      expect(holding.kept).toBe(true)

      // It does not: a plain member's write never committed — rolled back.
      const other = { ...rowKey, f0: { S: "something else" } }
      const plain = yield* settleOne(() =>
        Effect.fail(wrapped("PutItem", conditionFailed(2, other))),
      )
      expect(plain.state).toBe("rejected")
      expect(plain.kept).toBe(false)
      const absent = yield* settleOne(() => Effect.fail(wrapped("PutItem", conditionFailed(1))))
      expect(absent.state).toBe("rejected")

      // A member whose rows copy pointers: an earlier commit may live on in a copy.
      const copying = yield* settleOne(
        () => Effect.fail(wrapped("PutItem", conditionFailed(1, other))),
        { copiesPointers: true },
      )
      expect(copying.state).toBe("inDoubt")
      expect(copying.kept).toBe(true)
      expect(copying.reports.map((r) => r.reason)).toEqual(["inDoubt"])
    }),
  )

  it.effect("the evidence finds a binary pointer's S text and a nested one", () =>
    Effect.gen(function* () {
      const store = BlobStore.memory()
      const { client } = scripted((_command, input) =>
        Effect.fail(wrapped("PutItem", conditionFailed(2, input.Item))),
      )
      yield* BlobLedger.root(
        Effect.gen(function* () {
          const scan = yield* uploadBytes(store, bytesOf("pdf"))
          const nested = yield* uploadJson(store, "n", { key: "p/doc/nested" })
          yield* Effect.exit(
            client.putItem(putOf(asS(scan), { M: { deep: { L: [asB(nested)] } } }) as never),
          )
          expect(yield* stateOf(scan)).toBe("committed")
          expect(yield* stateOf(nested)).toBe("committed")
        }),
      )
      expect(versions(store)).toHaveLength(2)
    }),
  )

  it.effect("a refusal sent once is rejected; resent or unknown attempts are in doubt", () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<readonly [string, () => Error & { name: string }]> = [
        ["ValidationException", () => serviceError("ValidationException", 1)],
        [
          "ResourceNotFoundException",
          () => new ResourceNotFoundException({ message: "gone", ...metadata(1) }),
        ],
        [
          "ProvisionedThroughputExceededException",
          () => new ProvisionedThroughputExceededException({ message: "slow", ...metadata(1) }),
        ],
        ["ThrottlingException", () => serviceError("ThrottlingException", 1)],
        ["TransactionConflictException", () => serviceError("TransactionConflictException", 1)],
        ["AccessDeniedException", () => serviceError("AccessDeniedException", 1)],
        [
          "ItemCollectionSizeLimitExceededException",
          () => serviceError("ItemCollectionSizeLimitExceededException", 1),
        ],
      ]
      for (const [name, make] of cases) {
        const once = yield* settleOne(() => Effect.fail(wrapped("PutItem", make())))
        expect([name, once.state]).toEqual([name, "rejected"])
        expect(once.kept).toBe(false)
      }
      const resent = yield* settleOne(() =>
        Effect.fail(wrapped("PutItem", serviceError("ValidationException", 2))),
      )
      expect(resent.state).toBe("inDoubt")
      const unknown = yield* settleOne(() =>
        Effect.fail(wrapped("PutItem", serviceError("ValidationException", undefined))),
      )
      expect(unknown.state).toBe("inDoubt")
      // A mock that fails with the tagged error alone (no SDK error): no attempt count.
      const bare = yield* settleOne(() =>
        Effect.fail(new ThrottlingError({ operation: "PutItem", cause: "throttled" })),
      )
      expect(bare.state).toBe("inDoubt")
    }),
  )

  it.effect("an unknown outcome is in doubt: a server error, a defect, an interruption", () =>
    Effect.gen(function* () {
      const server = yield* settleOne(() =>
        Effect.fail(
          wrapped("PutItem", new SdkInternalServerError({ message: "oops", ...metadata(1) })),
        ),
      )
      expect(server.state).toBe("inDoubt")
      expect(server.kept).toBe(true)
      const other = yield* settleOne(() =>
        Effect.fail(wrapped("PutItem", serviceError("SomethingElse", 1))),
      )
      expect(other.state).toBe("inDoubt")
      const defect = yield* settleOne(() => Effect.die("socket hang up"))
      expect(defect.state).toBe("inDoubt")

      // Interrupted while the request is in flight.
      const store = BlobStore.memory()
      const { reports, layer } = observed()
      const inFlight = yield* Deferred.make<void>()
      const { client } = scripted(() =>
        Effect.andThen(Deferred.succeed(inFlight, undefined), Effect.never),
      )
      const fiber = yield* BlobLedger.root(
        Effect.flatMap(uploadJson(store, "v"), (pointer) =>
          client.putItem(putOf(asB(pointer)) as never),
        ),
      ).pipe(Effect.provide(layer), Effect.forkChild)
      yield* Deferred.await(inFlight)
      yield* Fiber.interrupt(fiber)
      expect(versions(store)).toHaveLength(1)
      expect(reports.map((r) => r.reason)).toEqual(["inDoubt"])
    }),
  )

  it.effect("a request recorded, not sent (NotSent), leaves the entry as it was", () =>
    Effect.gen(function* () {
      const { state, kept } = yield* settleOne(() =>
        Effect.fail(
          Capacity.markNotSent(new DynamoError({ operation: "PutItem", cause: "recorded" })),
        ),
      )
      expect(state).toBe("pending")
      expect(kept).toBe(false)
    }),
  )

  it.effect("UpdateItem and DeleteItem settle by their expression values", () =>
    Effect.gen(function* () {
      const update = yield* settleOne(() => ok(), {
        command: "updateItem",
        request: (pointer) => ({
          TableName: "docs",
          Key: rowKey,
          UpdateExpression: "SET #b = :b",
          ExpressionAttributeNames: { "#b": "body" },
          ExpressionAttributeValues: { ":b": asB(pointer) },
        }),
      })
      expect(update.state).toBe("committed")
      expect(update.sent[0]!.input.ReturnValuesOnConditionCheckFailure).toBe("ALL_OLD")
      const remove = yield* settleOne(
        () => Effect.fail(wrapped("DeleteItem", serviceError("ValidationException", 1))),
        {
          command: "deleteItem",
          request: (pointer) => ({
            TableName: "docs",
            Key: rowKey,
            ConditionExpression: "#b = :b",
            ExpressionAttributeNames: { "#b": "body" },
            ExpressionAttributeValues: { ":b": asB(pointer) },
          }),
        },
      )
      expect(remove.state).toBe("rejected")
    }),
  )

  it.effect("an if_not_exists write settles by the returned image", () =>
    Effect.gen(function* () {
      const upsert = (returnValues: string | undefined) => (pointer: BlobPointer.BlobPointer) => ({
        TableName: "docs",
        Key: rowKey,
        UpdateExpression: "SET #b = if_not_exists(#b, :b), #t = :t",
        ExpressionAttributeNames: { "#b": "body", "#t": "title" },
        ExpressionAttributeValues: { ":b": asB(pointer), ":t": { S: "T" } },
        ...(returnValues !== undefined && { ReturnValues: returnValues }),
      })
      const keptIt = yield* settleOne(
        (_command, input) =>
          Effect.succeed({
            Attributes: { ...rowKey, body: input.ExpressionAttributeValues[":b"] },
          }),
        { command: "updateItem", request: upsert("ALL_NEW") },
      )
      expect(keptIt.state).toBe("committed")
      expect(keptIt.kept).toBe(true)
      const lost = yield* settleOne(
        () => Effect.succeed({ Attributes: { ...rowKey, body: { B: new Uint8Array([1]) } } }),
        { command: "updateItem", request: upsert("UPDATED_NEW") },
      )
      expect(lost.state).toBe("rejected")
      expect(lost.kept).toBe(false)
      const blind = yield* settleOne(() => ok(), {
        command: "updateItem",
        request: upsert(undefined),
      })
      expect(blind.state).toBe("inDoubt")
    }),
  )

  it.effect("a request carrying none of the ledger's pointers, and a read, pass unchanged", () =>
    Effect.gen(function* () {
      const store = BlobStore.memory()
      const { client, sent } = scripted(() => ok())
      yield* BlobLedger.root(
        Effect.gen(function* () {
          yield* uploadJson(store, "v")
          yield* client.putItem(putOf({ S: "plain" }) as never)
          yield* client.getItem({ TableName: "docs", Key: rowKey } as never)
          // A pointer this ledger did not upload.
          const foreign = BlobPointer.make({
            kind: "json",
            codec: "none",
            ref: { key: "p/doc/body", version: "elsewhere" },
            objectSize: 1,
            contentSize: 1,
            checksum: { algorithm: "crc64nvme", value: new Uint8Array(8) },
            contentType: Option.none(),
          }) as BlobPointer.BlobPointer
          yield* client.putItem(putOf(asB(foreign)) as never)
        }),
      )
      expect(sent.map((s) => s.input.ReturnValuesOnConditionCheckFailure)).toEqual([
        undefined,
        undefined,
        undefined,
      ])
    }),
  )

  it.effect("a recording client's writes are neither prepared nor settled", () =>
    Effect.gen(function* () {
      const store = BlobStore.memory()
      const sent: Array<Record<string, unknown>> = []
      const recording = Capacity.instrument(
        Capacity.markRecording(
          mockDynamoClient({
            putItem: (input) =>
              Effect.sync(() => {
                sent.push(input as never)
                return {} as never
              }),
          }),
        ),
      )
      yield* BlobLedger.root(
        Effect.gen(function* () {
          const pointer = yield* uploadJson(store, "v")
          yield* recording.putItem(putOf(asB(pointer)) as never)
          expect(yield* stateOf(pointer)).toBe("pending")
        }),
      )
      expect(sent[0]).not.toHaveProperty("ReturnValuesOnConditionCheckFailure")
      expect(versions(store)).toEqual([])
    }),
  )

  it.effect("the lattice: a committed entry stays committed", () =>
    Effect.gen(function* () {
      const store = BlobStore.memory()
      let calls = 0
      const { client } = scripted(() =>
        ++calls === 1
          ? ok()
          : Effect.fail(wrapped("PutItem", serviceError("ValidationException", 1))),
      )
      yield* BlobLedger.root(
        Effect.gen(function* () {
          const pointer = yield* uploadJson(store, "v")
          yield* client.putItem(putOf(asB(pointer)) as never)
          yield* Effect.exit(client.putItem(putOf(asB(pointer)) as never))
          expect(yield* stateOf(pointer)).toBe("committed")
        }),
      )
      expect(versions(store)).toHaveLength(1)
    }),
  )
})

// ---------------------------------------------------------------------------
// Settlement: transactions and batches
// ---------------------------------------------------------------------------

describe("BlobLedger — settling transactions and batches", () => {
  const transact = (pointer: BlobPointer.BlobPointer, extra: Record<string, unknown> = {}) => ({
    TransactItems: [
      { Put: { TableName: "docs", Item: { ...rowKey, body: asB(pointer) } } },
      {
        Update: {
          TableName: "docs",
          Key: { pk: { S: "doc#2" }, sk: { S: "doc" } },
          UpdateExpression: "SET #s = :s",
          ExpressionAttributeNames: { "#s": "scan" },
          ExpressionAttributeValues: { ":s": asS(pointer) },
        },
      },
    ],
    ...extra,
  })

  const settleTransaction = (
    answer: (command: string, input: Record<string, any>) => Effect.Effect<unknown, unknown>,
    extra: Record<string, unknown> = {},
  ) =>
    Effect.gen(function* () {
      const store = BlobStore.memory()
      const { client, sent } = scripted(answer)
      const state = yield* BlobLedger.root(
        Effect.gen(function* () {
          const pointer = yield* uploadJson(store, "value")
          yield* Effect.exit(client.transactWriteItems(transact(pointer, extra) as never))
          return yield* stateOf(pointer)
        }),
      )
      return { state, kept: versions(store).length === 1, sent }
    })

  it.effect("a transaction carries the library's ClientRequestToken and commits on success", () =>
    Effect.gen(function* () {
      const { state, kept, sent } = yield* settleTransaction(() => ok())
      expect(state).toBe("committed")
      expect(kept).toBe(true)
      expect(sent[0]!.input.ClientRequestToken).toMatch(/^[0-9a-f]{32}$/)
      // No ALL_OLD on a transaction: its items carry their own.
      expect(sent[0]!.input).not.toHaveProperty("ReturnValuesOnConditionCheckFailure")
    }),
  )

  it.effect("a cancellation, validation or condition failure with the token is rejected", () =>
    Effect.gen(function* () {
      const failures = [
        new TransactionCanceledException({ message: "cancelled", ...metadata(3) }),
        serviceError("ValidationException", 2),
        new ConditionalCheckFailedException({ message: "failed", ...metadata(1) }),
      ]
      for (const failure of failures) {
        const { state, kept } = yield* settleTransaction(() =>
          Effect.fail(wrapped("TransactWriteItems", failure)),
        )
        expect([failure.name, state]).toEqual([failure.name, "rejected"])
        expect(kept).toBe(false)
      }
    }),
  )

  it.effect("a caller's own token is kept, and proves nothing", () =>
    Effect.gen(function* () {
      const { state, sent } = yield* settleTransaction(
        () =>
          Effect.fail(
            wrapped(
              "TransactWriteItems",
              new TransactionCanceledException({ message: "cancelled", ...metadata(1) }),
            ),
          ),
        { ClientRequestToken: "caller-token" },
      )
      expect(sent[0]!.input.ClientRequestToken).toBe("caller-token")
      expect(state).toBe("inDoubt")
    }),
  )

  it.effect("IdempotentParameterMismatch and TransactionInProgress are in doubt", () =>
    Effect.gen(function* () {
      for (const failure of [
        new IdempotentParameterMismatchException({ message: "mismatch", ...metadata(1) }),
        new TransactionInProgressException({ message: "in progress", ...metadata(1) }),
      ]) {
        const { state, kept } = yield* settleTransaction(() =>
          Effect.fail(wrapped("TransactWriteItems", failure)),
        )
        expect(state).toBe("inDoubt")
        expect(kept).toBe(true)
      }
    }),
  )

  it.effect("a whole-request refusal sent once is rejected; otherwise in doubt", () =>
    Effect.gen(function* () {
      const once = yield* settleTransaction(() =>
        Effect.fail(
          wrapped(
            "TransactWriteItems",
            new ProvisionedThroughputExceededException({ message: "slow", ...metadata(1) }),
          ),
        ),
      )
      expect(once.state).toBe("rejected")
      const retried = yield* settleTransaction(() =>
        Effect.fail(wrapped("TransactWriteItems", serviceError("ThrottlingException", 3))),
      )
      expect(retried.state).toBe("inDoubt")
      const server = yield* settleTransaction(() =>
        Effect.fail(
          wrapped(
            "TransactWriteItems",
            new SdkInternalServerError({ message: "oops", ...metadata(1) }),
          ),
        ),
      )
      expect(server.state).toBe("inDoubt")
    }),
  )

  it.effect(
    "a retrying wrapper inside the client resends one token; each request gets its own",
    () =>
      Effect.gen(function* () {
        const store = BlobStore.memory()
        const tokens: Array<string> = []
        let calls = 0
        // A custom client whose own retry layer resends the request it was given.
        const inner = (input: Record<string, any>) =>
          Effect.suspend(() => {
            tokens.push(input.ClientRequestToken)
            return ++calls % 2 === 1
              ? Effect.fail(wrapped("TransactWriteItems", serviceError("ThrottlingException", 1)))
              : ok()
          })
        const client = Capacity.instrument(
          mockDynamoClient({
            transactWriteItems: ((input: Record<string, any>) =>
              Effect.retry(inner(input), { times: 3 })) as never,
          }),
        )
        yield* BlobLedger.root(
          Effect.gen(function* () {
            const pointer = yield* uploadJson(store, "v")
            yield* client.transactWriteItems(transact(pointer) as never)
            yield* client.transactWriteItems(transact(pointer) as never)
            expect(yield* stateOf(pointer)).toBe("committed")
          }),
        )
        expect(tokens).toHaveLength(4)
        expect(tokens[0]).toBe(tokens[1])
        expect(tokens[2]).toBe(tokens[3])
        expect(tokens[0]).not.toBe(tokens[2])
      }),
  )

  it.effect("BatchWriteItem: processed commit; unprocessed by the response's attempts", () =>
    Effect.gen(function* () {
      const store = BlobStore.memory()
      const answers: Array<(input: Record<string, any>) => unknown> = []
      const { client } = scripted((_command, input) => Effect.succeed(answers.shift()!(input)))
      const batch = (...pointers: ReadonlyArray<BlobPointer.BlobPointer>) => ({
        RequestItems: {
          docs: pointers.map((pointer, i) => ({
            PutRequest: { Item: { pk: { S: `doc#${i}` }, sk: { S: "doc" }, body: asB(pointer) } },
          })),
        },
      })
      const unprocessed =
        (attempts: number, keep: ReadonlyArray<number>) => (input: Record<string, any>) => ({
          UnprocessedItems: { docs: keep.map((i) => input.RequestItems.docs[i]) },
          $metadata: { attempts },
        })
      yield* BlobLedger.root(
        Effect.gen(function* () {
          const a = yield* uploadJson(store, "a", { key: "p/a" })
          const b = yield* uploadJson(store, "b", { key: "p/b" })
          const c = yield* uploadJson(store, "c", { key: "p/c" })
          answers.push(unprocessed(1, [1, 2]))
          yield* client.batchWriteItem(batch(a, b, c) as never)
          expect(yield* stateOf(a)).toBe("committed")
          expect(yield* stateOf(b)).toBe("rejected")
          // A resend reported by the SDK: in doubt, and never back to rejected.
          answers.push(unprocessed(2, [0]), unprocessed(1, [0]))
          yield* client.batchWriteItem(batch(c) as never)
          expect(yield* stateOf(c)).toBe("inDoubt")
          yield* client.batchWriteItem(batch(c) as never)
          expect(yield* stateOf(c)).toBe("inDoubt")
          // Processed later: committed.
          answers.push(() => ({ UnprocessedItems: {}, $metadata: { attempts: 1 } }))
          yield* client.batchWriteItem(batch(c) as never)
          expect(yield* stateOf(c)).toBe("committed")
        }),
      )
      expect(
        store
          .inspect()
          .versions.map((v) => v.ref.key)
          .sort(),
      ).toEqual(["p/a", "p/c"])
    }),
  )

  it.effect(
    "BatchWriteItem: a ref a processed request carried commits, though another request carrying it is unprocessed",
    () =>
      Effect.gen(function* () {
        const store = BlobStore.memory()
        const answers: Array<(input: Record<string, any>) => unknown> = []
        const { client } = scripted((_command, input) => Effect.succeed(answers.shift()!(input)))
        const rows = (...pointers: ReadonlyArray<BlobPointer.BlobPointer>) => ({
          RequestItems: {
            docs: pointers.map((pointer, i) => ({
              PutRequest: { Item: { pk: { S: `doc#${i}` }, sk: { S: "doc" }, body: asB(pointer) } },
            })),
          },
        })
        const leaving =
          (attempts: number, keep: ReadonlyArray<number>) => (input: Record<string, any>) => ({
            UnprocessedItems: { docs: keep.map((i) => input.RequestItems.docs[i]) },
            $metadata: { attempts },
          })
        yield* BlobLedger.root(
          Effect.gen(function* () {
            const shared = yield* uploadJson(store, "shared", { key: "p/shared" })
            const alone = yield* uploadJson(store, "alone", { key: "p/alone" })
            // Rows 0 and 1 carry `shared`; row 1 (and `alone`'s row 2) is left.
            answers.push(leaving(1, [1, 2]))
            yield* client.batchWriteItem(rows(shared, shared, alone) as never)
            expect(yield* stateOf(shared)).toBe("committed")
            expect(yield* stateOf(alone)).toBe("rejected")
            // Every request carrying it left: by the response's attempts.
            const both = yield* uploadJson(store, "both", { key: "p/both" })
            answers.push(leaving(1, [0, 1]))
            yield* client.batchWriteItem(rows(both, both) as never)
            expect(yield* stateOf(both)).toBe("rejected")
          }),
        )
        expect(store.inspect().versions.map((v) => v.ref.key)).toEqual(["p/shared"])
      }),
  )

  it.effect("BatchWriteItem refused whole: rejected once, otherwise in doubt", () =>
    Effect.gen(function* () {
      const settle = (failure: unknown) =>
        Effect.gen(function* () {
          const store = BlobStore.memory()
          const { client } = scripted(() => Effect.fail(failure))
          return yield* BlobLedger.root(
            Effect.gen(function* () {
              const pointer = yield* uploadJson(store, "v")
              yield* Effect.exit(
                client.batchWriteItem({
                  RequestItems: { docs: [{ PutRequest: { Item: putOf(asB(pointer)).Item } }] },
                } as never),
              )
              return yield* stateOf(pointer)
            }),
          )
        })
      expect(yield* settle(wrapped("BatchWriteItem", serviceError("ValidationException", 1)))).toBe(
        "rejected",
      )
      expect(yield* settle(wrapped("BatchWriteItem", serviceError("ThrottlingException", 2)))).toBe(
        "inDoubt",
      )
      expect(yield* settle(new DynamoError({ operation: "BatchWriteItem", cause: "reset" }))).toBe(
        "inDoubt",
      )
    }),
  )
})

// ---------------------------------------------------------------------------
// maxUploadAge
// ---------------------------------------------------------------------------

describe("BlobLedger — maxUploadAge", () => {
  it.effect("a request carrying an upload older than maxUploadAge fails Expired, unsent", () =>
    Effect.gen(function* () {
      const store = BlobStore.memory({ maxUploadAge: "5 minutes" })
      const { client, sent } = scripted(() => ok())
      const error = yield* BlobLedger.root(
        Effect.gen(function* () {
          const pointer = yield* uploadJson(store, "v")
          yield* TestClock.adjust("4 minutes")
          // Within the age: sent.
          yield* client.putItem(putOf({ S: "no pointer" }) as never)
          const fresh = yield* uploadJson(store, "fresh", { key: "p/fresh" })
          yield* TestClock.adjust("2 minutes")
          return yield* Effect.flip(client.putItem(putOf(asB(fresh), asB(pointer)) as never))
        }),
      )
      expect(error).toBeInstanceOf(BlobStoreError)
      // The raw client's static error type does not name it: the choke point
      // adds it, and the write paths that upload declare it (commit 7).
      const expired = error as unknown as BlobStoreError
      expect(expired.reason).toBe("Expired")
      expect(expired.action).toBe("put")
      expect(expired.ref?.key).toBe("p/doc/body")
      expect(String(expired.cause)).toContain("nothing was written to DynamoDB")
      expect(sent).toHaveLength(1)
      // Nothing committed either: both rolled back.
      expect(versions(store)).toEqual([])
    }),
  )
})

// ---------------------------------------------------------------------------
// Exit: rollback and reports
// ---------------------------------------------------------------------------

describe("BlobLedger — exit", () => {
  it.effect("rollback is one delete per store, after which the cache is cleared", () =>
    Effect.gen(function* () {
      const first = BlobStore.memory()
      const second = BlobStore.memory()
      const ledger = yield* BlobLedger.root(
        Effect.gen(function* () {
          yield* uploadJson(first, "a", { key: "p/a" })
          yield* uploadJson(first, "b", { key: "p/b" })
          yield* uploadJson(second, "c", { key: "p/c" })
          return (yield* BlobLedger.current)!
        }),
      )
      expect(first.inspect().calls.delete).toBe(1)
      expect(second.inspect().calls.delete).toBe(1)
      expect(versions(first)).toEqual([])
      expect(versions(second)).toEqual([])
      expect(ledger.closed).toBe(true)
      expect(ledger.cache.size).toBe(0)
      // A closed ledger is no ledger.
      expect(
        yield* Effect.provideService(BlobLedger.current, BlobLedger.CurrentLedger, ledger),
      ).toBe(undefined)
    }),
  )

  it.effect("an in-doubt upload is kept, logged at Warning and reported", () =>
    Effect.gen(function* () {
      const store = BlobStore.memory()
      const { reports, layer } = observed()
      const log = logs()
      const { client } = scripted(() =>
        Effect.fail(
          wrapped("PutItem", new SdkInternalServerError({ message: "oops", ...metadata(1) })),
        ),
      )
      const pointer = yield* BlobLedger.root(
        Effect.gen(function* () {
          const pointer = yield* uploadJson(store, "v", {
            target: target({ operation: "Entity.update" }),
          })
          yield* Effect.exit(client.putItem(putOf(asB(pointer)) as never))
          return pointer
        }),
      ).pipe(Effect.provide(Layer.merge(layer, log.layer)))
      expect(versions(store)).toEqual([pointer.ref.version])
      expect(reports).toEqual([
        {
          reason: "inDoubt",
          table: "docs",
          entityType: "Doc",
          attribute: "body",
          operation: "Entity.update",
          rowKey: { pk: "doc#1", sk: "doc" },
          key: "p/doc/body",
          ref: pointer.ref,
          store: store.name,
        },
      ])
      const warning = log.lines.find((line) => line.level === "Warn")
      expect(String(warning?.message)).toContain(
        'an upload of Doc attribute "body" (Entity.update) could not be settled',
      )
      expect(warning?.annotations).toMatchObject({
        table: "docs",
        objectKey: "p/doc/body",
        version: pointer.ref.version,
        store: store.name,
      })
    }),
  )

  it.effect("a failed rollback delete never replaces the outcome, and is reported", () =>
    Effect.gen(function* () {
      const store = BlobStore.memory({
        failures: (call) =>
          call.action === "delete" ? { _tag: "Fail", reason: "Unavailable" } : undefined,
      })
      const { reports, layer } = observed()
      const log = logs()
      const exit = yield* BlobLedger.root(
        Effect.andThen(uploadJson(store, "v"), Effect.fail("the operation's own error")),
      ).pipe(Effect.provide(Layer.merge(layer, log.layer)), Effect.exit)
      expect(exit).toEqual(Exit.fail("the operation's own error"))
      expect(versions(store)).toHaveLength(1)
      expect(reports.map((r) => r.reason)).toEqual(["rollbackFailed"])
      expect(reports[0]!.cause).toBeInstanceOf(BlobStoreError)
      expect((reports[0]!.cause as BlobStoreError).reason).toBe("Unavailable")
      expect((reports[0]!.cause as BlobStoreError).action).toBe("delete")
      expect(log.lines.some((line) => line.level === "Warn")).toBe(true)
    }),
  )

  it.effect("a failing observer is logged and changes nothing", () =>
    Effect.gen(function* () {
      const store = BlobStore.memory({
        failures: (call) =>
          call.action === "delete" ? { _tag: "Fail", reason: "Unavailable" } : undefined,
      })
      const log = logs()
      const result = yield* BlobLedger.root(Effect.as(uploadJson(store, "v"), "done")).pipe(
        Effect.provide(
          Layer.merge(
            Offload.layerObserver({ onUnsettled: () => Effect.die("observer exploded") }),
            log.layer,
          ),
        ),
      )
      expect(result).toBe("done")
      expect(log.lines.map((line) => String(line.message))).toContain(
        "effect-dynamodb: the Offload observer failed; the unsettled upload was not delivered",
      )
    }),
  )

  it.effect("the observer runs outside the ledger it reports on", () =>
    Effect.gen(function* () {
      const store = BlobStore.memory()
      const seen: Array<BlobLedger.Ledger | undefined> = []
      const { client } = scripted(() => Effect.die("lost"))
      yield* BlobLedger.root(
        Effect.flatMap(uploadJson(store, "v"), (pointer) =>
          Effect.exit(client.putItem(putOf(asB(pointer)) as never)),
        ),
      ).pipe(
        Effect.provide(
          Offload.layerObserver({
            onUnsettled: () =>
              Effect.map(BlobLedger.current, (ledger) => {
                seen.push(ledger)
              }),
          }),
        ),
      )
      expect(seen).toEqual([undefined])
    }),
  )

  it.effect("a lost multipart completion is reported as completeLost", () =>
    Effect.gen(function* () {
      const store = BlobStore.memory()
      const { reports, layer } = observed()
      yield* BlobLedger.reportCompleteLost(target(), store, "p/doc/scan", "NoSuchUpload").pipe(
        Effect.provide(layer),
      )
      expect(reports).toEqual([
        expect.objectContaining({
          reason: "completeLost",
          key: "p/doc/scan",
          ref: undefined,
          cause: "NoSuchUpload",
        }),
      ])
      // Inside an open ledger: reported when the root exits, with the rest.
      reports.length = 0
      yield* BlobLedger.root(
        Effect.gen(function* () {
          yield* BlobLedger.reportCompleteLost(target(), store, "p/doc/scan", "NoSuchUpload")
          expect(reports).toEqual([])
        }),
      ).pipe(Effect.provide(layer))
      expect(reports.map((r) => r.reason)).toEqual(["completeLost"])
    }),
  )
})

// ---------------------------------------------------------------------------
// Store calls
// ---------------------------------------------------------------------------

describe("BlobLedger — store calls", () => {
  it.effect("a store failing outside the contract is Rejected with what it failed with", () =>
    Effect.gen(function* () {
      const memory = BlobStore.memory()
      const broken: BlobStoreService = {
        ...memory,
        put: () => Effect.fail("not a failure" as never),
      }
      const error = yield* Effect.flip(BlobLedger.root(uploadJson(broken, "v")))
      expect(error.reason).toBe("Rejected")
      expect(error.cause).toBe("not a failure")
    }),
  )
})
