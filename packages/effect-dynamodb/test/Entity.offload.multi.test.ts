/**
 * Offloaded fields in multi-item operations (#179, design §6.6, §6.7, §3.6):
 * `Batch.write` and `Transaction.transactWrite` route and upload every put's
 * offloaded values before sending, and settle each upload by the request that
 * carries its pointer — a `BatchWriteItem` per ref by its unprocessed items
 * and `$metadata.attempts`, a transaction by its outcome. A bound builder
 * carries the blob store and compressors its `DynamoClient.make` bundled, into
 * writes and reads alike (`Batch.get`, `transactGet`).
 *
 * Requests are answered by the in-memory tables, with a scripted
 * `BatchWriteItem` (which they lack); objects land in the in-memory blob
 * store, whose call counts and versions say what was uploaded and deleted.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { describe, expect, it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { BlobStoreError, DynamoError, ValidationError } from "@effect-dynamodb/schema/Errors.js"
import * as BlobPointer from "@effect-dynamodb/schema/internal/BlobPointer.js"
import { Effect, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { beforeEach } from "vitest"
import * as Batch from "../src/Batch.js"
import { BlobStore } from "../src/BlobStore.js"
import * as ZlibCompression from "../src/compression/zlib.js"
import { DynamoClient, type DynamoClientService } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import type { MemoryBlobStore } from "../src/internal/MemoryBlobStore.js"
import * as Offload from "../src/Offload.js"
import * as Table from "../src/Table.js"
import * as Transaction from "../src/Transaction.js"
import {
  hooks,
  InMemoryClient,
  type Item,
  keyOf,
  resetStore,
  store as rows,
} from "./helpers/InMemoryTables.js"
import { withOffloadGate } from "./helpers/OffloadGate.js"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const AppSchema = DynamoSchema.make({ name: "multi", version: 1, escapeKeys: true })

const Text = Schema.Struct({ text: Schema.String })
/** `{"text":"…"}` is 11 bytes plus the text. */
const text = (jsonBytes: number, fill = "x") => ({ text: fill.repeat(jsonBytes - 11) })
const bytes = (n: number, fill = 7) => new Uint8Array(n).fill(fill)

class Doc extends Schema.Class<Doc>("Doc")({
  docId: Schema.String,
  title: Schema.String,
  body: Schema.optional(Text),
  scan: Schema.optional(Schema.Uint8Array),
  meta: Schema.optional(Schema.Struct({ lines: Schema.Array(Schema.String) })),
}) {}

const docKey = {
  pk: { field: "pk", composite: ["docId"] },
  sk: { field: "sk", composite: [] },
} as const

const offloaded = {
  body: { storedAs: DynamoModel.Packed({ format: "json", external: { threshold: 64 } }) },
  scan: { storedAs: DynamoModel.External() },
} as const

/** An external overflow body and a binary scan. */
const Docs = withOffloadGate(() =>
  Entity.make({
    model: DynamoModel.configure(Doc, offloaded),
    entityType: "Doc",
    primaryKey: docKey,
  }),
)

/** Versioned: `Batch.write` sends its puts as create-only transactions. */
const VDocs = withOffloadGate(() =>
  Entity.make({
    model: DynamoModel.configure(Doc, offloaded),
    entityType: "VDoc",
    primaryKey: docKey,
    versioned: true,
  }),
)

/** A gzip-packed field beside the offloaded ones: needs a compressor registry. */
const GzDocs = withOffloadGate(() =>
  Entity.make({
    model: DynamoModel.configure(Doc, {
      ...offloaded,
      meta: {
        storedAs: DynamoModel.Packed({
          format: "json",
          compression: { codec: "gzip", threshold: 0 },
        }),
      },
    }),
    entityType: "GzDoc",
    primaryKey: docKey,
  }),
)

const MainTable = Table.make({ schema: AppSchema, entities: { Docs, VDocs, GzDocs } })

// ---------------------------------------------------------------------------
// The client: the in-memory tables, a scripted BatchWriteItem, the batch reads
// ---------------------------------------------------------------------------

interface Sent {
  readonly command: string
  readonly input: any
}
const sent: Array<Sent> = []

/** How one `BatchWriteItem` call is answered. */
interface BatchAnswer {
  /** Requests to leave unprocessed (default none). */
  readonly leave?: ((request: any) => boolean) | undefined
  /** `$metadata.attempts` of the response (default 1). */
  readonly attempts?: number | undefined
  /** Run before the request is applied (a clock adjustment). */
  readonly before?: Effect.Effect<void> | undefined
}
/** The answers of the next `BatchWriteItem` calls, in order; then every request is processed. */
const batchScript: Array<BatchAnswer> = []

const MultiClient = Layer.effect(
  DynamoClient,
  Effect.map(Effect.service(DynamoClient), (inner): DynamoClientService => {
    const call = (method: string, input: unknown) =>
      (inner as unknown as Record<string, (i: unknown) => Effect.Effect<any, any>>)[method]!(input)
    const spy = (method: string, command: string) => (input: any) =>
      Effect.suspend(() => {
        sent.push({ command, input })
        return call(method, input).pipe(
          Effect.mapError((error: any) => {
            const cause = error?.cause
            if (
              cause?.name === "ConditionalCheckFailedException" ||
              cause?.name === "TransactionCanceledException"
            ) {
              // The SDK sent it once.
              Object.assign(cause, { $metadata: { attempts: 1 } })
            }
            return error
          }),
        )
      })
    return {
      ...inner,
      getItem: spy("getItem", "GetItem"),
      putItem: spy("putItem", "PutItem"),
      updateItem: spy("updateItem", "UpdateItem"),
      deleteItem: spy("deleteItem", "DeleteItem"),
      transactWriteItems: spy("transactWriteItems", "TransactWriteItems"),
      batchWriteItem: (input) =>
        Effect.suspend(() => {
          sent.push({ command: "BatchWriteItem", input })
          const answer = batchScript.shift() ?? {}
          return Effect.andThen(answer.before ?? Effect.void, () => {
            const left: Record<string, Array<any>> = {}
            for (const [table, requests] of Object.entries(input.RequestItems ?? {})) {
              for (const request of requests as Array<any>) {
                if (answer.leave?.(request) === true) {
                  const kept = left[table] ?? []
                  kept.push(request)
                  left[table] = kept
                } else if (request.PutRequest !== undefined) {
                  rows.set(keyOf(table, request.PutRequest.Item), request.PutRequest.Item)
                } else if (request.DeleteRequest !== undefined) {
                  rows.delete(keyOf(table, request.DeleteRequest.Key))
                }
              }
            }
            return Effect.succeed({
              UnprocessedItems: left,
              $metadata: { attempts: answer.attempts ?? 1 },
            } as never)
          })
        }),
      batchGetItem: (input) =>
        Effect.sync(() => {
          sent.push({ command: "BatchGetItem", input })
          const Responses: Record<string, Array<Item>> = {}
          for (const [table, request] of Object.entries(input.RequestItems ?? {})) {
            Responses[table] = (request.Keys ?? []).flatMap((key) => {
              const item = rows.get(keyOf(table, key))
              return item === undefined ? [] : [item]
            })
          }
          return { Responses } as never
        }),
      transactGetItems: (input) =>
        Effect.sync(() => {
          sent.push({ command: "TransactGetItems", input })
          return {
            Responses: (input.TransactItems ?? []).map((entry) => {
              const item = rows.get(keyOf(entry.Get!.TableName!, entry.Get!.Key!))
              return item === undefined ? {} : { Item: item }
            }),
          } as never
        }),
    }
  }),
).pipe(Layer.provide(InMemoryClient))

let blobs: MemoryBlobStore = BlobStore.memory()
const reports: Array<Offload.UnsettledUpload> = []

const tableLayer = MainTable.layer({ name: "main" })
const observer = Offload.layerObserver({
  onUnsettled: (upload) =>
    Effect.sync(() => {
      reports.push(upload)
    }),
})
/** The client, the table, a fresh in-memory store (`blobs`) and the observer. */
const withStore = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.suspend(() =>
    effect.pipe(
      Effect.provide(Layer.mergeAll(MultiClient, tableLayer, BlobStore.layer(blobs), observer)),
    ),
  )
/** The client and the table: no ambient store, no compressors. */
const withoutStore = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(Layer.mergeAll(MultiClient, tableLayer, observer)))

beforeEach(() => {
  resetStore()
  sent.length = 0
  batchScript.length = 0
  reports.length = 0
  blobs = BlobStore.memory()
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const calls = () => blobs.inspect().calls
const versions = () => blobs.inspect().versions
const commands = () => sent.map((s) => s.command)

/** The live row of an entity type by its id. */
const live = (entityType: string, docId: string): Item => {
  const row = [...rows.values()].find(
    (item) => item.__edd_e__?.S === entityType && item.docId?.S === docId,
  )
  if (row === undefined) throw new Error(`no live ${entityType} row ${docId}`)
  return row
}
const rowOf = (entityType: string, docId: string): Item | undefined =>
  [...rows.values()].find((item) => item.__edd_e__?.S === entityType && item.docId?.S === docId)

/** An overflow attribute's stored pointer (`B`), or a binary one's (`~edbp:` text). */
const pointerOf = (value: AttributeValue | undefined): BlobPointer.BlobPointer => {
  const pointer =
    value?.B !== undefined ? BlobPointer.decode(value.B) : BlobPointer.decodeText(value!.S!)
  if (pointer === undefined || typeof pointer === "string") throw new Error(String(pointer))
  return pointer
}

/** A lazy binary field's content. */
const readHandle = (value: unknown) => {
  expect(Offload.isBlobHandle(value)).toBe(true)
  return (value as Offload.BlobHandle).read()
}

/** A put request of the given doc id. */
const putOf = (docId: string) => (request: any) => request.PutRequest?.Item?.docId?.S === docId

const doc = (docId: string, fill = "x") => ({
  docId,
  title: `title ${docId}`,
  body: text(100, fill),
  scan: bytes(5),
})

// ---------------------------------------------------------------------------
// Batch.write
// ---------------------------------------------------------------------------

describe("Batch.write — offloaded fields", () => {
  it.effect("every put uploads before any request; a processed one commits its uploads", () =>
    withStore(
      Effect.gen(function* () {
        yield* Batch.write([
          Docs.put(doc("d-1")),
          Docs.put(doc("d-2")),
          Docs.delete({ docId: "d-3" }),
        ])
        expect(commands()).toEqual(["BatchWriteItem"])
        // Two puts, two offloaded fields each; nothing deleted or reported.
        expect(calls().put).toBe(4)
        expect(calls().delete).toBe(0)
        expect(versions()).toHaveLength(4)
        expect(reports).toEqual([])
        expect(pointerOf(live("Doc", "d-1").body).kind).toBe("json")
        expect(pointerOf(live("Doc", "d-2").scan).kind).toBe("bytes")
        // The batch's own reads resolve them.
        const [one, two] = yield* Batch.get([
          Docs.get({ docId: "d-1" }),
          Docs.get({ docId: "d-2" }),
        ])
        expect(one!.body).toEqual(text(100))
        expect(yield* readHandle(two!.scan)).toEqual(bytes(5))
      }),
    ),
  )

  it.effect("a put left unprocessed by a request sent once: its uploads are deleted", () => {
    // Retries exhausted at once: the batch fails with d-2 never written.
    batchScript.push({ leave: putOf("d-2"), attempts: 1 })
    return withStore(
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          Batch.write([Docs.put(doc("d-1")), Docs.put(doc("d-2"))], { maxRetries: 0 }),
        )
        expect(error).toBeInstanceOf(DynamoError)
        expect(rowOf("Doc", "d-2")).toBeUndefined()
        // d-1's committed; d-2's two deleted, in one call.
        expect(calls().put).toBe(4)
        expect(calls().delete).toBe(1)
        expect(versions().map((v) => v.ref)).toEqual(
          expect.arrayContaining([
            pointerOf(live("Doc", "d-1").body).ref,
            pointerOf(live("Doc", "d-1").scan).ref,
          ]),
        )
        expect(versions()).toHaveLength(2)
        expect(reports).toEqual([])
      }),
    )
  })

  it.effect("a put left unprocessed by a request the SDK retried: kept and reported", () => {
    batchScript.push({ leave: putOf("d-2"), attempts: 2 })
    return withStore(
      Effect.gen(function* () {
        yield* Effect.flip(
          Batch.write([Docs.put(doc("d-1")), Docs.put(doc("d-2"))], { maxRetries: 0 }),
        )
        // An earlier attempt may have written it: nothing deleted, both reported.
        expect(calls().delete).toBe(0)
        expect(versions()).toHaveLength(4)
        expect(reports).toHaveLength(2)
        expect(reports.map((r) => r.reason)).toEqual(["inDoubt", "inDoubt"])
        expect(reports.map((r) => r.attribute).sort()).toEqual(["body", "scan"])
      }),
    )
  })

  it.live("a put unprocessed, then processed on the retry: committed", () => {
    batchScript.push({ leave: putOf("d-2"), attempts: 1 })
    return withStore(
      Effect.gen(function* () {
        yield* Batch.write([Docs.put(doc("d-1")), Docs.put(doc("d-2"))], { baseDelayMs: 1 })
        expect(commands()).toEqual(["BatchWriteItem", "BatchWriteItem"])
        // The retry resent d-2's request, carrying the same pointers: one upload each.
        expect(calls().put).toBe(4)
        expect(calls().delete).toBe(0)
        expect(reports).toEqual([])
        expect(pointerOf(live("Doc", "d-2").body).ref).toEqual(
          pointerOf(sent[0]!.input.RequestItems.main[1].PutRequest.Item.body).ref,
        )
      }),
    )
  })

  it.effect("a versioned put's create-only transaction cancelled: its uploads are deleted", () =>
    withStore(
      Effect.gen(function* () {
        yield* VDocs.put(doc("v-1"))
        const kept = versions().map((v) => v.ref)
        const error = yield* Effect.flip(Batch.write([VDocs.put(doc("v-1", "y"))]))
        // It would replace the stored item: refused, nothing of it written.
        expect(error).toBeInstanceOf(ValidationError)
        expect(commands().at(-1)).toBe("TransactWriteItems")
        expect(sent.at(-1)!.input.ClientRequestToken).toEqual(expect.any(String))
        expect(calls().put).toBe(4)
        expect(calls().delete).toBe(1)
        expect(versions().map((v) => v.ref)).toEqual(kept)
        expect(reports).toEqual([])
      }),
    ),
  )

  it.effect("an upload expired by a later request: refused, saying what was written", () => {
    blobs = BlobStore.memory({ maxUploadAge: "5 minutes" })
    // The first chunk takes ten minutes to answer; the second is refused unsent.
    batchScript.push({ before: TestClock.adjust("10 minutes") })
    return withStore(
      Effect.gen(function* () {
        const ops = Array.from({ length: 26 }, (_, i) => Docs.put(doc(`d-${i}`)))
        const error = yield* Effect.flip(Batch.write(ops))
        expect(error).toBeInstanceOf(BlobStoreError)
        const expired = error as BlobStoreError
        expect(expired.reason).toBe("Expired")
        expect(expired.committed).toBe(false)
        expect(String(expired.cause)).toMatch(
          /nothing was written to DynamoDB by that request; the batch had already written 25 non-versioned requests$/,
        )
        expect(commands()).toEqual(["BatchWriteItem"])
        // The first chunk's 50 uploads committed; the last put's 2 deleted.
        expect(calls().put).toBe(52)
        expect(calls().delete).toBe(1)
        expect(versions()).toHaveLength(50)
      }),
    )
  })

  it.effect("a failed upload sends nothing and rolls the others back", () => {
    blobs = BlobStore.memory({
      failures: (call) =>
        call.action === "put" && call.n === 3 ? { _tag: "Fail", reason: "Rejected" } : undefined,
    })
    return withStore(
      Effect.gen(function* () {
        const error = yield* Effect.flip(Batch.write([Docs.put(doc("d-1")), Docs.put(doc("d-2"))]))
        expect(error).toMatchObject({
          _tag: "BlobStoreError",
          reason: "Rejected",
          committed: false,
        })
        expect(commands()).toEqual([])
        expect(calls().put).toBe(4)
        expect(versions()).toEqual([])
      }),
    )
  })
})

// ---------------------------------------------------------------------------
// Transaction.transactWrite
// ---------------------------------------------------------------------------

describe("Transaction.transactWrite — offloaded fields", () => {
  it.effect("a put and a planned update commit their uploads with the transaction", () =>
    withStore(
      Effect.gen(function* () {
        yield* Docs.put({ docId: "d-1", title: "one" })
        sent.length = 0
        yield* Transaction.transactWrite([
          Docs.put(doc("d-2")),
          Docs.update({ docId: "d-1" }).pipe(Entity.set({ body: text(120) })),
        ])
        expect(commands().filter((c) => c !== "GetItem")).toEqual(["TransactWriteItems"])
        expect(calls().put).toBe(3)
        expect(calls().delete).toBe(0)
        expect(reports).toEqual([])
        const [one, two] = yield* Transaction.transactGet([
          Docs.get({ docId: "d-1" }),
          Docs.get({ docId: "d-2" }),
        ])
        expect(one!.body).toEqual(text(120))
        expect(yield* readHandle(two!.scan)).toEqual(bytes(5))
      }),
    ),
  )

  it.effect("a cancelled transaction deletes every upload, a planned update's included", () =>
    withStore(
      Effect.gen(function* () {
        yield* Docs.put({ docId: "d-1", title: "one" })
        yield* Docs.put({ docId: "d-3", title: "three" })
        const error = yield* Effect.flip(
          Transaction.transactWrite([
            Docs.put(doc("d-2")),
            Docs.update({ docId: "d-1" }).pipe(Entity.set({ body: text(120) })),
            // d-3 exists: the transaction is cancelled.
            Docs.create(doc("d-3")),
          ]),
        )
        expect(error._tag).toBe("TransactionCancelled")
        // The update's upload was recorded with its plan, never settled by it.
        expect(calls().put).toBe(5)
        expect(calls().delete).toBe(1)
        expect(versions()).toEqual([])
        expect(reports).toEqual([])
        expect(rowOf("Doc", "d-2")).toBeUndefined()
      }),
    ),
  )

  it.effect("a lost race is planned again: the same content uploads once", () =>
    withStore(
      Effect.gen(function* () {
        yield* VDocs.put({ docId: "v-1", title: "one" })
        // A concurrent writer between the guarded put's read and its transaction.
        hooks.afterGet.push((table) => {
          const row = live("VDoc", "v-1")
          rows.set(keyOf(table, row), {
            ...row,
            version: { N: String(Number(row.version!.N) + 1) },
          })
        })
        sent.length = 0
        yield* Transaction.transactWrite([VDocs.put(doc("v-1"))])
        expect(commands().filter((c) => c === "TransactWriteItems")).toHaveLength(2)
        // One upload per field, reused by the second attempt; nothing deleted.
        expect(calls().put).toBe(2)
        expect(calls().delete).toBe(0)
        expect(reports).toEqual([])
        expect(versions().map((v) => v.ref)).toContainEqual(pointerOf(live("VDoc", "v-1").body).ref)
      }),
    ),
  )

  it.effect("a refused put stops the transaction before a planned update reads or uploads", () =>
    withStore(
      Effect.gen(function* () {
        yield* Docs.put({ docId: "d-1", title: "one" })
        sent.length = 0
        const error = yield* Effect.flip(
          Transaction.transactWrite([
            Docs.update({ docId: "d-1" }).pipe(Entity.set({ body: text(120) })),
            Docs.put({ docId: "d-2", title: 42 as never }),
          ]),
        )
        expect(error).toBeInstanceOf(ValidationError)
        expect(commands()).toEqual([])
        expect(calls().put).toBe(0)
        expect(calls().delete).toBe(0)
      }),
    ),
  )

  it.effect("a store failure planning an update is a typed BlobStoreError, nothing sent", () => {
    blobs = BlobStore.memory({
      failures: (call) =>
        call.action === "put" ? { _tag: "Fail", reason: "Rejected" } : undefined,
    })
    return withStore(
      Effect.gen(function* () {
        // No offloaded value: the seed uploads nothing.
        yield* Docs.put({ docId: "d-1", title: "one" })
        sent.length = 0
        // A failure (flipped), not a defect.
        const error = yield* Effect.flip(
          Transaction.transactWrite([
            Docs.update({ docId: "d-1" }).pipe(Entity.set({ body: text(120) })),
          ]),
        )
        expect(error).toBeInstanceOf(BlobStoreError)
        expect(error).toMatchObject({ reason: "Rejected", committed: false })
        expect(commands()).not.toContain("TransactWriteItems")
        expect(versions()).toEqual([])
      }),
    )
  })
})

// ---------------------------------------------------------------------------
// Bound builders: their DynamoClient.make store and compressors (§3.6)
// ---------------------------------------------------------------------------

describe("bound builders in Batch and Transaction — captured services", () => {
  it.effect("upload to, and read from, the store their client bundled", () => {
    const bundled = BlobStore.memory()
    return withStore(
      Effect.gen(function* () {
        const db = yield* DynamoClient.make({
          entities: { Docs },
          tables: { MainTable },
          blobStore: bundled,
        })
        yield* Batch.write([db.entities.Docs.put(doc("d-1"))])
        yield* Transaction.transactWrite([
          db.entities.Docs.put(doc("d-2")),
          db.entities.Docs.update({ docId: "d-1" }).set({ body: text(120) }),
        ])
        // The ambient store saw nothing.
        expect(calls().put).toBe(0)
        expect(bundled.inspect().calls.put).toBe(5)
        const [one] = yield* Batch.get([db.entities.Docs.get({ docId: "d-1" })])
        expect(one!.body).toEqual(text(120))
        const [two] = yield* Transaction.transactGet([db.entities.Docs.get({ docId: "d-2" })])
        expect(yield* readHandle(two!.scan)).toEqual(bytes(5))
        expect(calls().get).toBe(0)
      }),
    )
  })

  it.effect("with no ambient store or compressors at all", () => {
    const bundled = BlobStore.memory()
    return withoutStore(
      Effect.gen(function* () {
        const db = yield* DynamoClient.make({
          entities: { GzDocs },
          tables: { MainTable },
          blobStore: bundled,
          compressors: [ZlibCompression.gzip()],
        })
        const meta = { lines: Array.from({ length: 20 }, (_, i) => `line ${i}`) }
        yield* Batch.write([db.entities.GzDocs.put({ ...doc("g-1"), meta })])
        yield* Transaction.transactWrite([db.entities.GzDocs.put({ ...doc("g-2"), meta })])
        // Packed with the bundled gzip, inline; the rest offloaded to the bundled store.
        expect(live("GzDoc", "g-1").meta?.B).toBeInstanceOf(Uint8Array)
        expect(bundled.inspect().calls.put).toBe(4)
        const [one, two] = yield* Batch.get([
          db.entities.GzDocs.get({ docId: "g-1" }),
          db.entities.GzDocs.get({ docId: "g-2" }),
        ])
        expect(one!.meta).toEqual(meta)
        expect(two!.body).toEqual(text(100))
        const [three] = yield* Transaction.transactGet([db.entities.GzDocs.get({ docId: "g-2" })])
        expect(three!.meta).toEqual(meta)
      }),
    )
  })

  it.effect("an unbound put beside them uses the ambient store, and fails without one", () => {
    const bundled = BlobStore.memory()
    return withoutStore(
      Effect.gen(function* () {
        const db = yield* DynamoClient.make({
          entities: { Docs },
          tables: { MainTable },
          blobStore: bundled,
        })
        const error = yield* Effect.flip(
          Batch.write([db.entities.Docs.put(doc("d-1")), Docs.put(doc("d-2"))]),
        )
        expect(error).toMatchObject({ _tag: "BlobStoreError", reason: "NotProvided" })
        // Nothing sent; the bound op's uploads rolled back.
        expect(commands()).toEqual([])
        expect(bundled.inspect().versions).toEqual([])
      }),
    )
  })
})
