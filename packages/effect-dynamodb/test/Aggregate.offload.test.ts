/**
 * Offloaded edge fields in aggregates (#179, design §6.9, §8.4): an edge
 * entity's overflow and binary fields are routed and uploaded on the built
 * edge items — after their keys are composed — before the first transaction;
 * an update decides which groups it rewrites before anything is uploaded, and
 * a rewritten group uploads every one of its offloaded values afresh. Each
 * group is its own transaction, so its uploads settle by that transaction —
 * for an update too, whose fresh versions share their keys with the live
 * ones. Reads resolve both kinds eagerly: the assembled aggregate holds
 * values. Ref hydration fetches only the target's offloaded fields an edge
 * item holds.
 *
 * Offloading requires `escapeKeys: true` (design §11.10, `[EDD-9146]`): an
 * aggregate with an offloading edge on any other setting is refused at bind
 * and, unbound, where its write routes; `rekey` never moves an edge row that
 * holds a pointer. A hydrated copy holds values, never a pointer: an edge item
 * uploads its own, a ref copy holds none.
 *
 * Requests are answered by the in-memory tables, with a scripted
 * `TransactWriteItems` (to cancel a chosen group) and `BatchGetItem` (ref
 * hydration); objects land in the in-memory blob store, whose call counts and
 * versions say what was uploaded and deleted.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { describe, expect, it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { BlobStoreError, DynamoError, ValidationError } from "@effect-dynamodb/schema/Errors.js"
import * as BlobPointer from "@effect-dynamodb/schema/internal/BlobPointer.js"
import { Effect, Exit, Layer, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import { beforeEach } from "vitest"
import * as Aggregate from "../src/Aggregate.js"
import { BlobStore } from "../src/BlobStore.js"
import { DynamoClient, type DynamoClientService } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import { objectKey } from "../src/internal/BlobKeys.js"
import * as BlobMetadata from "../src/internal/BlobMetadata.js"
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
import { withOffloadGate } from "./helpers/OffloadGate.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Offloading requires escaped key text (`[EDD-9146]`, design §11.10). */
const AppSchema = DynamoSchema.make({ name: "aggoff", version: 1, escapeKeys: true })
const TABLE = "main"

const Notes = Schema.Struct({ text: Schema.String })
/** `{"text":"…"}` is 11 bytes plus the text. */
const text = (jsonBytes: number, fill = "x") => ({ text: fill.repeat(jsonBytes - 11) })
const bytes = (n: number, fill = 7) => new Uint8Array(n).fill(fill)

class Scan extends Schema.Class<Scan>("Scan")({
  id: Schema.String,
  label: Schema.String,
  image: Schema.Uint8Array,
  notes: Notes,
}) {}

const scanKey = {
  pk: { field: "pk", composite: ["id"] },
  sk: { field: "sk", composite: [] },
} as const

/** A binary image (always offloaded) and overflow notes (at 64 bytes). */
const Scans = withOffloadGate(() =>
  Entity.make({
    model: DynamoModel.configure(Scan, {
      id: { identifier: true },
      image: { storedAs: DynamoModel.External({ contentType: "image/png" }) },
      notes: { storedAs: DynamoModel.Packed({ format: "json", external: { threshold: 64 } }) },
    }),
    entityType: "Scan",
    primaryKey: scanKey,
  }),
)

/** The same entity type, configured without offloading (design §4.7). */
const PlainScans = Entity.make({
  model: DynamoModel.configure(Scan, { id: { identifier: true } }),
  entityType: "Scan",
  primaryKey: scanKey,
})

/** A subset of a scan without its offloaded fields: what a ref may copy (`EDD-9143`). */
class ScanRef extends Schema.Class<ScanRef>("ScanRef")({
  id: Schema.String,
  label: Schema.String,
}) {}

class Page extends Schema.Class<Page>("Page")({
  label: Schema.String,
  scans: Schema.Array(Scan),
}) {}

class Album extends Schema.Class<Album>("Album")({
  albumId: Schema.String,
  title: Schema.String,
  cover: Scan,
  page1: Page,
  page2: Page,
}) {}

const MainTable = Table.make({ schema: AppSchema, entities: { Scans } })
const PlainTable = Table.make({ schema: AppSchema, entities: { PlainScans } })

/** Three groups: the root (album + cover), page 1 and page 2 (each a page + its scans). */
const albumAggregate = (entity: typeof Scans | typeof PlainScans, table: typeof MainTable) => {
  const PageAggregate = Aggregate.make(Page, {
    root: { entityType: "AlbumPage" },
    edges: {
      scans: Aggregate.many("scans", {
        entityType: "AlbumScan",
        entity,
        sk: { composite: ["id"] },
      }),
    },
  })
  return Aggregate.make(Album, {
    table,
    schema: AppSchema,
    pk: { field: "pk", composite: ["albumId"] },
    collection: { name: "album" },
    root: { entityType: "AlbumItem" },
    edges: {
      cover: Aggregate.one("cover", { entityType: "AlbumCover", entity }),
      page1: PageAggregate.with({ discriminator: { pageNo: 1 } }),
      page2: PageAggregate.with({ discriminator: { pageNo: 2 } }),
    },
  })
}

const Albums = albumAggregate(Scans, MainTable)
const PlainAlbums = albumAggregate(PlainScans, PlainTable as never)

/** A scan's inline input. */
const scan = (id: string, fill = 7) => ({
  id,
  label: `scan ${id}`,
  image: bytes(5, fill),
  notes: text(100, String(fill)),
})

/** An album whose edges are given inline (no ref hydration). */
const album = (albumId = "a-1") => ({
  albumId,
  title: "Holiday",
  cover: scan("c-1", 1),
  page1: { label: "Beach", scans: [scan("s-1", 2)] },
  page2: { label: "Hills", scans: [scan("s-2", 3), scan("s-3", 4)] },
})

// ---------------------------------------------------------------------------
// The client: the in-memory tables, a scripted TransactWriteItems, batch reads
// ---------------------------------------------------------------------------

interface Sent {
  readonly command: string
  readonly input: any
}
const sent: Array<Sent> = []

/** How one `TransactWriteItems` call is answered. */
interface TransactAnswer {
  /** Cancel it (`TransactionConflict`) instead of applying it. */
  readonly cancel?: boolean | undefined
  /** Run before the request is answered (a clock adjustment). */
  readonly before?: Effect.Effect<void> | undefined
}
/** The answers of the next `TransactWriteItems` calls, in order; then each is applied. */
const transactScript: Array<TransactAnswer> = []

const cancelled = (count: number) =>
  Object.assign(new Error("Transaction cancelled"), {
    name: "TransactionCanceledException",
    CancellationReasons: Array.from({ length: count }, () => ({ Code: "TransactionConflict" })),
    $metadata: { attempts: 1 },
  })

const ScriptedClient = Layer.effect(
  DynamoClient,
  Effect.map(Effect.service(DynamoClient), (inner): DynamoClientService => {
    const call = (method: string, input: unknown) =>
      (inner as unknown as Record<string, (i: unknown) => Effect.Effect<any, any>>)[method]!(input)
    return {
      ...inner,
      query: (input) =>
        Effect.suspend(() => {
          sent.push({ command: "Query", input })
          return call("query", input)
        }),
      putItem: (input) =>
        Effect.suspend(() => {
          sent.push({ command: "PutItem", input })
          return call("putItem", input)
        }),
      transactWriteItems: (input) =>
        Effect.suspend(() => {
          sent.push({ command: "TransactWriteItems", input })
          const answer = transactScript.shift() ?? {}
          return Effect.andThen(answer.before ?? Effect.void, () =>
            answer.cancel === true
              ? Effect.fail(
                  new DynamoError({
                    operation: "TransactWriteItems",
                    cause: cancelled(input.TransactItems?.length ?? 0),
                  }),
                )
              : call("transactWriteItems", input).pipe(
                  Effect.mapError((error: any) => {
                    const cause = error?.cause
                    if (cause?.name === "TransactionCanceledException") {
                      Object.assign(cause, { $metadata: { attempts: 1 } })
                    }
                    return error
                  }),
                ),
          )
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
    }
  }),
).pipe(Layer.provide(InMemoryClient))

let blobs: MemoryBlobStore = BlobStore.memory()
const reports: Array<Offload.UnsettledUpload> = []

const observer = Offload.layerObserver({
  onUnsettled: (upload) =>
    Effect.sync(() => {
      reports.push(upload)
    }),
})
/** The client, the tables, a fresh in-memory store (`blobs`) and the observer. */
const withStore = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.suspend(() =>
    effect.pipe(
      Effect.provide(
        Layer.mergeAll(
          ScriptedClient,
          MainTable.layer({ name: TABLE }),
          PlainTable.layer({ name: TABLE }),
          BlobStore.layer(blobs),
          observer,
        ),
      ),
    ),
  )
/** The client and the tables: no ambient store. */
const withoutStore = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(
      Layer.mergeAll(
        ScriptedClient,
        MainTable.layer({ name: TABLE }),
        PlainTable.layer({ name: TABLE }),
        observer,
      ),
    ),
  )

beforeEach(() => {
  resetStore()
  sent.length = 0
  transactScript.length = 0
  reports.length = 0
  blobs = BlobStore.memory()
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const calls = () => blobs.inspect().calls
const versions = () => blobs.inspect().versions
const commands = () => sent.map((s) => s.command)

/** The stored rows of an item type. */
const rowsOf = (entityType: string): Array<Item> =>
  [...rows.values()].filter((item) => item.__edd_e__?.S === entityType)
/** The stored row of an item type by its scan id. */
const rowOf = (entityType: string, id: string): Item => {
  const row = rowsOf(entityType).find((item) => item.id?.S === id)
  if (row === undefined) throw new Error(`no ${entityType} row ${id}`)
  return row
}

/** An overflow attribute's stored pointer (`B`), or a binary one's (`~edbp:` text). */
const pointerOf = (value: AttributeValue | undefined): BlobPointer.BlobPointer => {
  const pointer =
    value?.B !== undefined ? BlobPointer.decode(value.B) : BlobPointer.decodeText(value!.S!)
  if (pointer === undefined || typeof pointer === "string") throw new Error(String(pointer))
  return pointer
}

const isPointer = (value: AttributeValue | undefined): boolean =>
  (value?.B !== undefined && BlobPointer.isPointerHeader(value.B[0]!)) ||
  (value?.S !== undefined && BlobPointer.isPointerText(value.S))

/**
 * Every pointer the rows of `types` hold names its own row's object (design §4.5, §11.10): the
 * pointer is the row's own upload, never one copied from another row. Returns how many there are.
 */
const expectOwnPointers = (types: ReadonlyArray<string>): number => {
  let pointers = 0
  for (const row of rows.values()) {
    if (!types.includes(row.__edd_e__?.S ?? "")) continue
    for (const [attribute, value] of Object.entries(row)) {
      if (!isPointer(value)) continue
      pointers++
      expect(pointerOf(value).ref.key).toBe(
        objectKey("", {
          table: TABLE,
          pk: row.pk as never,
          familySk: row.sk as never,
          rowSk: row.sk as never,
          attribute,
        }),
      )
    }
  }
  return pointers
}

/** The Puts of every `TransactWriteItems` sent, by group (one array per request). */
const transactPuts = (): Array<Array<Item>> =>
  sent
    .filter((s) => s.command === "TransactWriteItems")
    .map((s) =>
      (s.input.TransactItems as Array<any>).flatMap((entry) =>
        entry.Put?.Item !== undefined ? [entry.Put.Item as Item] : [],
      ),
    )

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

describe("Aggregate.create — offloaded edge fields", () => {
  it.effect("routes and uploads every edge item's offloaded fields on its built keys", () =>
    withStore(
      Effect.gen(function* () {
        yield* Albums.create(album() as never)
        // Four edge items (cover + three page scans), two offloaded fields each.
        expect(calls().put).toBe(8)
        expect(versions()).toHaveLength(8)
        expect(reports).toEqual([])
        // Three groups, each its own transaction; every upload before the first.
        expect(commands().filter((c) => c === "TransactWriteItems")).toHaveLength(3)

        for (const [type, id] of [
          ["AlbumCover", "c-1"],
          ["AlbumScan", "s-1"],
          ["AlbumScan", "s-3"],
        ] as const) {
          const row = rowOf(type, id)
          const image = pointerOf(row.image)
          const notes = pointerOf(row.notes)
          expect(image.kind).toBe("bytes")
          expect(notes.kind).toBe("json")
          // The object key is the built edge item's: the aggregate partition and
          // the edge item's own SK, as family and row (design §4.5).
          for (const [attribute, pointer] of [
            ["image", image],
            ["notes", notes],
          ] as const) {
            expect(pointer.ref.key).toBe(
              objectKey("", {
                table: TABLE,
                pk: row.pk as never,
                familySk: row.sk as never,
                rowSk: row.sk as never,
                attribute,
              }),
            )
            const stored = versions().find((v) => v.ref.key === pointer.ref.key)!
            const metadata = BlobMetadata.parse(stored.metadata)
            expect(metadata).toMatchObject({
              table: TABLE,
              entity: type,
              attribute,
              item: { pk: row.pk, sk: row.sk },
            })
          }
          // The pointers are what the transaction carried, never the inline values.
          expect(row.image?.B).toBeUndefined()
        }
        // The binary content type is the edge entity's.
        const image = versions().find((v) => v.metadata["edd-attr"] === "image")!
        expect(image.contentType).toBe("image/png")
      }),
    ),
  )

  it.effect("get, list and update assemble resolved values: one GET per pointer", () =>
    withStore(
      Effect.gen(function* () {
        yield* Albums.create(album() as never)
        const before = calls().get
        const read = yield* Albums.get({ albumId: "a-1" })
        expect(calls().get - before).toBe(8)
        expect(read.cover.image).toEqual(bytes(5, 1))
        expect(read.cover.notes).toEqual(text(100, "1"))
        expect(read.page2.scans.map((s) => s.image)).toEqual([bytes(5, 3), bytes(5, 4)])
        expect(read.page1.scans[0]!.notes).toEqual(text(100, "2"))
      }),
    ),
  )

  it.effect("an overflow value under its threshold stays inline", () =>
    withStore(
      Effect.gen(function* () {
        yield* Albums.create({
          ...album(),
          cover: { ...scan("c-1", 1), notes: text(20) },
        } as never)
        const cover = rowOf("AlbumCover", "c-1")
        expect(cover.notes?.S).toBe(JSON.stringify(text(20)))
        expect(pointerOf(cover.image).kind).toBe("bytes")
        expect((yield* Albums.get({ albumId: "a-1" })).cover.notes).toEqual(text(20))
      }),
    ),
  )

  it.effect("a create over an existing aggregate deletes every upload it made", () =>
    withStore(
      Effect.gen(function* () {
        yield* Albums.create(album() as never)
        const kept = versions().map((v) => v.ref)
        const error = yield* Effect.flip(Albums.create(album() as never))
        expect(error._tag).toBe("ConditionalCheckFailed")
        // The root group was refused; no later group was sent; all 8 deleted.
        expect(calls().put).toBe(16)
        expect(versions().map((v) => v.ref)).toEqual(kept)
        expect(reports).toEqual([])
      }),
    ),
  )

  it.effect("per-group settlement: a cancelled group's uploads are deleted, others kept", () => {
    // The root group commits, page 1's is cancelled; page 2 is never sent.
    transactScript.push({}, { cancel: true })
    return withStore(
      Effect.gen(function* () {
        const error = yield* Effect.flip(Albums.create(album() as never))
        expect(error._tag).toBe("TransactionCancelled")
        expect(commands().filter((c) => c === "TransactWriteItems")).toHaveLength(2)
        // Every value was uploaded before the first transaction.
        expect(calls().put).toBe(8)
        // The cover's two committed; page 1's (rejected) and page 2's (never
        // carried) six deleted.
        const cover = rowOf("AlbumCover", "c-1")
        expect(
          versions()
            .map((v) => v.ref.key)
            .sort(),
        ).toEqual([pointerOf(cover.image).ref.key, pointerOf(cover.notes).ref.key].sort())
        expect(reports).toEqual([])
      }),
    )
  })

  it.effect("an upload expired by a later group: refused, naming the committed groups", () => {
    blobs = BlobStore.memory({ maxUploadAge: "5 minutes" })
    // The root group takes ten minutes to answer; page 1's carries expired uploads.
    transactScript.push({ before: TestClock.adjust("10 minutes") })
    return withStore(
      Effect.gen(function* () {
        const error = yield* Effect.flip(Albums.create(album() as never))
        expect(error).toBeInstanceOf(BlobStoreError)
        const expired = error as BlobStoreError
        expect(expired.reason).toBe("Expired")
        expect(String(expired.cause)).toMatch(
          /by that request; earlier transactions of this write already committed sub-aggregates "root"$/,
        )
        // Only the root group was sent; its uploads committed, the rest deleted.
        expect(commands().filter((c) => c === "TransactWriteItems")).toHaveLength(1)
        expect(versions()).toHaveLength(2)
      }),
    )
  })

  it.effect("a failed upload writes nothing and rolls the others back", () => {
    blobs = BlobStore.memory({
      failures: (call) =>
        call.action === "put" && call.n === 5 ? { _tag: "Fail", reason: "Rejected" } : undefined,
    })
    return withStore(
      Effect.gen(function* () {
        const error = yield* Effect.flip(Albums.create(album() as never))
        expect(error).toMatchObject({ _tag: "BlobStoreError", reason: "Rejected" })
        expect(commands().filter((c) => c === "TransactWriteItems")).toEqual([])
        expect(versions()).toEqual([])
      }),
    )
  })

  it.effect("without a store: NotProvided, before any transaction", () =>
    withoutStore(
      Effect.gen(function* () {
        const error = yield* Effect.flip(Albums.create(album() as never))
        expect(error).toMatchObject({ _tag: "BlobStoreError", reason: "NotProvided" })
        expect(commands().filter((c) => c === "TransactWriteItems")).toEqual([])
      }),
    ),
  )

  it.effect(
    "refuses a Stream, handle, source or lazy value on an offloaded edge field (EDD-9120)",
    () =>
      withStore(
        Effect.gen(function* () {
          const cases: ReadonlyArray<readonly [string, Record<string, unknown>, RegExp]> = [
            [
              "a Stream on a binary one-edge field",
              { ...album(), cover: { ...scan("c-1"), image: Stream.make(bytes(3)) } },
              /binary field "image" of edge "cover" \(entity type "AlbumCover"\) takes a Uint8Array, got a Stream/,
            ],
            [
              "a source on a binary many element in a sub-aggregate",
              {
                ...album(),
                page2: {
                  label: "Hills",
                  scans: [scan("s-2"), { ...scan("s-3"), image: Offload.source(bytes(3)) }],
                },
              },
              /binary field "image" of edge "page2\.scans\[1\]" \(entity type "AlbumScan"\) takes a Uint8Array, got an Offload\.source/,
            ],
            [
              "a Stream on an overflow field",
              { ...album(), cover: { ...scan("c-1"), notes: Stream.make("x") } },
              /overflow field "notes" of edge "cover" \(entity type "AlbumCover"\) takes its domain value, got a Stream/,
            ],
          ]
          for (const [, input, message] of cases) {
            const error = yield* Effect.flip(Albums.create(input as never))
            expect(error).toBeInstanceOf(ValidationError)
            const validation = error as ValidationError
            expect(validation.operation).toBe("aggregate.create")
            expect(String((validation.cause as Error).message)).toMatch(
              /^\[EDD-9120\] Aggregate "AlbumItem": /,
            )
            expect(String((validation.cause as Error).message)).toMatch(message)
          }
          expect(calls().put).toBe(0)
          expect(commands()).toEqual([])
        }),
      ),
  )

  it.effect("refuses them (EDD-9120) when the input also hydrates a ref id", () =>
    withStore(
      Effect.gen(function* () {
        yield* Scans.put(scan("c-1"))
        yield* Scans.put(scan("x-1"))
        // Overflow fields read lazily: an OffloadedValue.
        const lazy = (yield* Scans.get({ id: "x-1" }).pipe(Entity.offloaded("lazy"))).notes
        expect(Offload.isOffloadedValue(lazy)).toBe(true)
        const before = calls()
        // `coverId` makes hydration copy the input: what it holds must survive the copy.
        const withCover = (page2: Record<string, unknown>) => ({
          albumId: "a-1",
          title: "Holiday",
          coverId: "c-1",
          page1: { label: "Beach", scans: [scan("s-1")] },
          page2,
        })
        const cases: ReadonlyArray<readonly [Record<string, unknown>, RegExp]> = [
          [
            withCover({
              label: "Hills",
              scans: [{ ...scan("s-2"), image: Stream.make(bytes(3)) }],
            }),
            /binary field "image" of edge "page2\.scans\[0\]" \(entity type "AlbumScan"\) takes a Uint8Array, got a Stream/,
          ],
          [
            withCover({
              label: "Hills",
              scans: [{ ...scan("s-2"), image: Offload.source(bytes(3)) }],
            }),
            /binary field "image" of edge "page2\.scans\[0\]" \(entity type "AlbumScan"\) takes a Uint8Array, got an Offload\.source/,
          ],
          [
            withCover({ label: "Hills", scans: [{ ...scan("s-2"), notes: lazy }] }),
            /overflow field "notes" of edge "page2\.scans\[0\]" \(entity type "AlbumScan"\) takes its domain value, got an OffloadedValue/,
          ],
        ]
        for (const [input, message] of cases) {
          const error = yield* Effect.flip(Albums.create(input as never))
          expect(error).toBeInstanceOf(ValidationError)
          const cause = (error as ValidationError).cause as Error
          expect(String(cause.message)).toMatch(/^\[EDD-9120\] Aggregate "AlbumItem": /)
          expect(String(cause.message)).toMatch(message)
        }
        // The cover was hydrated each time; nothing was uploaded or written.
        expect(calls().put - before.put).toBe(0)
        expect(commands().filter((c) => c === "TransactWriteItems")).toEqual([])
      }),
    ),
  )
})

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

describe("Aggregate.update — offloaded edge fields", () => {
  it.effect("an unchanged group uploads nothing (the diff runs first)", () =>
    withStore(
      Effect.gen(function* () {
        yield* Albums.create(album() as never)
        const put = calls().put
        sent.length = 0
        // A root-only change rewrites the root group (album + cover) only.
        yield* Albums.update({ albumId: "a-1" }, ({ state }) => ({ ...state, title: "Trip" }))
        expect(transactPuts().map((puts) => puts.map((item) => item.__edd_e__?.S))).toEqual([
          ["AlbumItem", "AlbumCover"],
        ])
        // The cover's two values were re-uploaded; the pages' six were not.
        expect(calls().put - put).toBe(2)
        // Nothing changed at all: no transaction, no upload.
        sent.length = 0
        yield* Albums.update({ albumId: "a-1" }, ({ state }) => state)
        expect(commands().filter((c) => c === "TransactWriteItems")).toEqual([])
        expect(calls().put - put).toBe(2)
      }),
    ),
  )

  it.effect("a changed group re-uploads every offloaded value: no read pointer is reused", () =>
    withStore(
      Effect.gen(function* () {
        yield* Albums.create(album() as never)
        const before = rowsOf("AlbumScan").map((row) => [
          row.id!.S!,
          pointerOf(row.image).ref,
          pointerOf(row.notes).ref,
        ])
        const put = calls().put
        // Change one scan's label in page 2: the whole group is rewritten.
        yield* Albums.update({ albumId: "a-1" }, ({ state }) => ({
          ...state,
          page2: {
            ...state.page2,
            scans: state.page2.scans.map((s) => (s.id === "s-2" ? { ...s, label: "renamed" } : s)),
          },
        }))
        // Page 2's two scans: four values uploaded afresh, unchanged content too.
        expect(calls().put - put).toBe(4)
        for (const [id, image, notes] of before as Array<[string, any, any]>) {
          const row = rowOf("AlbumScan", id)
          if (id === "s-1") {
            expect(pointerOf(row.image).ref).toEqual(image)
            expect(pointerOf(row.notes).ref).toEqual(notes)
          } else {
            // Same key (same row and attribute), a new version.
            expect(pointerOf(row.image).ref.key).toBe(image.key)
            expect(pointerOf(row.image).ref.version).not.toBe(image.version)
            expect(pointerOf(row.notes).ref.version).not.toBe(notes.version)
          }
        }
        const read = yield* Albums.get({ albumId: "a-1" })
        expect(read.page2.scans.map((s) => [s.label, s.image])).toEqual([
          ["renamed", bytes(5, 3)],
          ["scan s-3", bytes(5, 4)],
        ])
        expect(reports).toEqual([])
      }),
    ),
  )

  it.effect("a changed binary value is compared by content and re-uploaded", () =>
    withStore(
      Effect.gen(function* () {
        yield* Albums.create(album() as never)
        const put = calls().put
        // The same bytes in a new array: no change, nothing rewritten.
        yield* Albums.update({ albumId: "a-1" }, ({ state }) => ({
          ...state,
          cover: { ...state.cover, image: bytes(5, 1) },
        }))
        expect(calls().put - put).toBe(0)
        yield* Albums.update({ albumId: "a-1" }, ({ state }) => ({
          ...state,
          cover: { ...state.cover, image: bytes(9, 8) },
        }))
        expect(calls().put - put).toBe(2)
        expect((yield* Albums.get({ albumId: "a-1" })).cover.image).toEqual(bytes(9, 8))
      }),
    ),
  )

  it.effect("removing a scan deletes its row in the group's own transaction", () =>
    withStore(
      Effect.gen(function* () {
        yield* Albums.create(album() as never)
        yield* Albums.update({ albumId: "a-1" }, ({ state }) => ({
          ...state,
          page2: { ...state.page2, scans: state.page2.scans.slice(0, 1) },
        }))
        expect(
          rowsOf("AlbumScan")
            .map((row) => row.id?.S)
            .sort(),
        ).toEqual(["s-1", "s-2"])
        expect((yield* Albums.get({ albumId: "a-1" })).page2.scans).toHaveLength(1)
      }),
    ),
  )

  /** Rename a scan of page 2 (`page1` too when `both`): those groups are rewritten. */
  const relabel =
    (both = false) =>
    ({ state }: { readonly state: any }) => ({
      ...state,
      page1: both ? { ...state.page1, label: "Shore" } : state.page1,
      page2: {
        ...state.page2,
        scans: state.page2.scans.map((s: any) => (s.id === "s-2" ? { ...s, label: "renamed" } : s)),
      },
    })

  it.effect(
    "a cancelled rewrite deletes its fresh versions and keeps the live ones under the same keys",
    () =>
      withStore(
        Effect.gen(function* () {
          yield* Albums.create(album() as never)
          const live = versions().map((v) => v.ref)
          const pointers = () =>
            rowsOf("AlbumScan").map((row) => [pointerOf(row.image).ref, pointerOf(row.notes).ref])
          const stored = pointers()
          const put = calls().put
          transactScript.push({ cancel: true })
          const error = yield* Effect.flip(Albums.update({ albumId: "a-1" }, relabel()))
          expect(error._tag).toBe("TransactionCancelled")
          // Page 2's two scans were uploaded afresh — new versions of the same keys…
          expect(calls().put - put).toBe(4)
          // …and every one of them was deleted; the live versions are all kept.
          expect(versions().map((v) => v.ref)).toEqual(live)
          expect(pointers()).toEqual(stored)
          expect(reports).toEqual([])
          const read = yield* Albums.get({ albumId: "a-1" })
          expect(read.page2.scans.map((s) => [s.label, s.image, s.notes])).toEqual([
            ["scan s-2", bytes(5, 3), text(100, "3")],
            ["scan s-3", bytes(5, 4), text(100, "4")],
          ])
        }),
      ),
  )

  it.effect(
    "an upload expired by a later group of an update: the committed groups keep theirs",
    () => {
      blobs = BlobStore.memory({ maxUploadAge: "5 minutes" })
      return withStore(
        Effect.gen(function* () {
          yield* Albums.create(album() as never)
          const refId = (ref: { readonly key: string; readonly version: string }) =>
            `${ref.key}@${ref.version}`
          const live = new Set(versions().map((v) => refId(v.ref)))
          const put = calls().put
          sent.length = 0
          // Page 1's transaction takes ten minutes; page 2's carries expired uploads.
          transactScript.push({ before: TestClock.adjust("10 minutes") })
          const error = yield* Effect.flip(Albums.update({ albumId: "a-1" }, relabel(true)))
          expect(error).toBeInstanceOf(BlobStoreError)
          const expired = error as BlobStoreError
          expect(expired.reason).toBe("Expired")
          expect(String(expired.cause)).toMatch(
            /earlier transactions of this write already committed sub-aggregates "page1"$/,
          )
          expect(commands().filter((c) => c === "TransactWriteItems")).toHaveLength(1)
          // Page 1's one scan (2 values) and page 2's two scans (4) were uploaded;
          // page 1's committed, page 2's were deleted, and every live version kept.
          expect(calls().put - put).toBe(6)
          const now = new Set(versions().map((v) => refId(v.ref)))
          expect([...live].every((ref) => now.has(ref))).toBe(true)
          expect(now.size - live.size).toBe(2)
          // Page 1's row names its committed versions, page 2's still its live ones.
          for (const [id, isNew] of [
            ["s-1", true],
            ["s-2", false],
            ["s-3", false],
          ] as const) {
            const row = rowOf("AlbumScan", id)
            for (const value of [row.image, row.notes]) {
              const ref = refId(pointerOf(value).ref)
              expect(now.has(ref)).toBe(true)
              expect(live.has(ref)).toBe(!isNew)
            }
          }
          const read = yield* Albums.get({ albumId: "a-1" })
          expect(read.page1.label).toBe("Shore")
          expect(read.page1.scans[0]!.image).toEqual(bytes(5, 2))
          expect(read.page2.scans.map((s) => [s.label, s.image])).toEqual([
            ["scan s-2", bytes(5, 3)],
            ["scan s-3", bytes(5, 4)],
          ])
        }),
      )
    },
  )

  it.effect("refuses a handle returned by the mutation (EDD-9120)", () =>
    withStore(
      Effect.gen(function* () {
        yield* Albums.create(album() as never)
        yield* Scans.put(scan("x-1"))
        // Binary fields read lazily by default: a handle.
        const handle = (yield* Scans.get({ id: "x-1" })).image
        expect(Offload.isBlobHandle(handle)).toBe(true)
        const error = yield* Effect.flip(
          Albums.update({ albumId: "a-1" }, ({ state }) => ({
            ...state,
            cover: { ...state.cover, image: handle as never },
          })),
        )
        expect(error).toBeInstanceOf(ValidationError)
        expect((error as ValidationError).operation).toBe("aggregate.update")
        expect(String(((error as ValidationError).cause as Error).message)).toMatch(
          /\[EDD-9120\] Aggregate "AlbumItem": binary field "image" of edge "cover" .* got a BlobHandle/,
        )
      }),
    ),
  )
})

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

describe("Aggregate reads — offloaded edge fields", () => {
  it.effect("without a store: get fails NotProvided naming the attribute", () =>
    Effect.gen(function* () {
      yield* withStore(Albums.create(album() as never))
      const error = yield* withoutStore(Effect.flip(Albums.get({ albumId: "a-1" })))
      expect(error).toMatchObject({ _tag: "BlobStoreError", reason: "NotProvided" })
    }),
  )

  it.effect(
    "a pointer on an edge entity that no longer offloads resolves through the store (§4.7)",
    () =>
      withStore(
        Effect.gen(function* () {
          yield* Albums.create(album() as never)
          const read = yield* PlainAlbums.get({ albumId: "a-1" })
          expect(read.cover.image).toEqual(bytes(5, 1))
          expect(read.page2.scans[1]!.notes).toEqual(text(100, "4"))
        }),
      ),
  )

  it.effect("a bound aggregate reads and writes through the store DynamoClient.make bundled", () =>
    withoutStore(
      Effect.gen(function* () {
        const db = yield* DynamoClient.make({
          entities: { Scans },
          aggregates: { Albums },
          tables: { MainTable },
          blobStore: blobs,
        })
        yield* db.aggregates.Albums.create(album() as never)
        expect(calls().put).toBe(8)
        expect((yield* db.aggregates.Albums.get({ albumId: "a-1" })).cover.image).toEqual(
          bytes(5, 1),
        )
      }),
    ),
  )
})

// ---------------------------------------------------------------------------
// Ref hydration
// ---------------------------------------------------------------------------

describe("Aggregate ref hydration — offloading targets", () => {
  it.effect(
    "a one edge and a many element read their entity eagerly and re-upload its values",
    () =>
      withStore(
        Effect.gen(function* () {
          for (const [id, fill] of [
            ["c-1", 1],
            ["s-1", 2],
            ["s-2", 3],
          ] as const) {
            yield* Scans.put(scan(id, fill))
          }
          const seeded = versions().map((v) => v.ref.key)
          const before = calls()
          yield* Albums.create({
            albumId: "a-1",
            title: "Holiday",
            coverId: "c-1",
            page1: { label: "Beach", scans: ["s-1"] },
            page2: { label: "Hills", scans: ["s-2"] },
          } as never)
          // Each target's two values fetched once, uploaded again under the edge item.
          expect(calls().get - before.get).toBe(6)
          expect(calls().put - before.put).toBe(6)
          const cover = rowOf("AlbumCover", "c-1")
          expect(seeded).not.toContain(pointerOf(cover.image).ref.key)
          // Hydration never copies a pointer into another row: each edge row holds its own
          // uploads, named from its own key; the root holds none.
          expect(expectOwnPointers(["AlbumCover", "AlbumScan"])).toBe(6)
          expect(expectOwnPointers(["AlbumItem", "AlbumPage"])).toBe(0)
          for (const row of rows.values()) {
            if (row.__edd_e__?.S === "Scan") continue
            for (const value of Object.values(row)) {
              if (isPointer(value)) expect(seeded).not.toContain(pointerOf(value).ref.key)
            }
          }
          const read = yield* Albums.get({ albumId: "a-1" })
          expect(read.cover.image).toEqual(bytes(5, 1))
          expect(read.page2.scans[0]!.notes).toEqual(text(100, "3"))
        }),
      ),
  )

  it.effect("a ref edge reads an offloading target without fetching its offloaded values", () =>
    withStore(
      Effect.gen(function* () {
        class Pinned extends Schema.Class<Pinned>("Pinned")({
          albumId: Schema.String,
          pinned: ScanRef,
        }) {}
        const Pins = Aggregate.make(Pinned, {
          table: MainTable,
          schema: AppSchema,
          pk: { field: "pk", composite: ["albumId"] },
          collection: { name: "pins" },
          root: { entityType: "PinItem" },
          edges: { pinned: Aggregate.ref(Scans) },
        })
        yield* Scans.put(scan("s-1"))
        const before = calls()
        const created = yield* Pins.create({ albumId: "p-1", pinnedId: "s-1" } as never)
        expect(created.pinned).toEqual({ id: "s-1", label: "scan s-1" })
        expect(calls().get - before.get).toBe(0)
        expect(calls().put - before.put).toBe(0)
        // The ref copy holds no offloaded field, so no pointer: none was copied from the target.
        const pin = rowsOf("PinItem")
        expect(pin).toHaveLength(1)
        expect(Object.values(pin[0]!).some(isPointer)).toBe(false)
        expect((yield* Pins.get({ albumId: "p-1" })).pinned.label).toBe("scan s-1")
      }),
    ),
  )

  /** A shelf of `many` elements given as ids, whose element is `Element`. */
  const shelfOf = <S extends Schema.Top>(element: S, name: string, entity: any, table: any) => {
    const Shelf = Schema.Struct({ shelfId: Schema.String, items: Schema.Array(element) })
    return Aggregate.make(Shelf as never, {
      table,
      schema: AppSchema,
      pk: { field: "pk", composite: ["shelfId"] },
      collection: { name },
      root: { entityType: `${name}Item` },
      edges: {
        items: Aggregate.many("items", {
          entityType: `${name}Entry`,
          entity,
          sk: { composite: ["id"] },
        }),
      },
    }) as unknown as {
      readonly create: (input: unknown) => Effect.Effect<any, any, any>
      readonly get: (key: unknown) => Effect.Effect<any, any, any>
    }
  }

  it.effect(
    "a many element without the target's offloaded fields fetches none and needs no store",
    () =>
      Effect.gen(function* () {
        const Shelves = shelfOf(ScanRef, "Shelf", Scans, MainTable)
        yield* withStore(
          Effect.gen(function* () {
            yield* Scans.put(scan("s-1"))
            yield* Scans.put(scan("s-2"))
          }),
        )
        const before = calls()
        const created = yield* withStore(Shelves.create({ shelfId: "sh-1", items: ["s-1", "s-2"] }))
        expect(created.items).toEqual([
          { id: "s-1", label: "scan s-1" },
          { id: "s-2", label: "scan s-2" },
        ])
        expect(calls().get - before.get).toBe(0)
        expect(calls().put - before.put).toBe(0)
        // The edge items hold no offloaded field: no store is needed at all.
        yield* withoutStore(Shelves.create({ shelfId: "sh-2", items: ["s-1"] }))
        const read = yield* withoutStore(Shelves.get({ shelfId: "sh-2" }))
        expect(read.items).toEqual([{ id: "s-1", label: "scan s-1" }])
      }),
  )

  it.effect("a many element with some of them fetches only those it keeps", () =>
    Effect.gen(function* () {
      class ScanImage extends Schema.Class<ScanImage>("ScanImage")({
        id: Schema.String,
        label: Schema.String,
        image: Schema.Uint8Array,
      }) {}
      const Shelves = shelfOf(ScanImage, "Gallery", Scans, MainTable)
      yield* withStore(
        Effect.gen(function* () {
          yield* Scans.put(scan("s-1", 2))
          yield* Scans.put(scan("s-2", 3))
        }),
      )
      const before = calls()
      const created = yield* withStore(Shelves.create({ shelfId: "g-1", items: ["s-1", "s-2"] }))
      // The image of each, re-uploaded under its edge item; the notes neither.
      expect(calls().get - before.get).toBe(2)
      expect(calls().put - before.put).toBe(2)
      expect(created.items.map((s: ScanImage) => s.image)).toEqual([bytes(5, 2), bytes(5, 3)])
      const entry = rowOf("GalleryEntry", "s-1")
      expect(pointerOf(entry.image).kind).toBe("bytes")
      expect(entry.notes).toBeUndefined()
      const read = yield* withStore(Shelves.get({ shelfId: "g-1" }))
      expect(read.items.map((s: ScanImage) => s.image)).toEqual([bytes(5, 2), bytes(5, 3)])
    }),
  )

  it.effect("a many element with one of a kind's fields reads only that one of it", () => {
    class Print extends Schema.Class<Print>("Print")({
      id: Schema.String,
      image: Schema.Uint8Array,
      thumb: Schema.Uint8Array,
      notes: Notes,
    }) {}
    class PrintThumb extends Schema.Class<PrintThumb>("PrintThumb")({
      id: Schema.String,
      thumb: Schema.Uint8Array,
    }) {}
    const Prints = withOffloadGate(() =>
      Entity.make({
        model: DynamoModel.configure(Print, {
          id: { identifier: true },
          image: { storedAs: DynamoModel.External({ contentType: "image/png" }) },
          thumb: { storedAs: DynamoModel.External({ contentType: "image/png" }) },
          notes: { storedAs: DynamoModel.Packed({ format: "json", external: { threshold: 64 } }) },
        }),
        entityType: "Print",
        primaryKey: scanKey,
      }),
    )
    const PrintTable = Table.make({ schema: AppSchema, entities: { Prints } })
    const Shelves = shelfOf(PrintThumb, "Contact", Prints, PrintTable)
    return withStore(
      Effect.gen(function* () {
        yield* Prints.put({ id: "p-1", image: bytes(9, 1), thumb: bytes(4, 2), notes: text(100) })
        const before = calls()
        const created = yield* Shelves.create({ shelfId: "c-1", items: ["p-1"] })
        // The binary kind is read lazily and only the thumb read from its handle.
        expect(calls().get - before.get).toBe(1)
        expect(calls().put - before.put).toBe(1)
        expect(created.items).toEqual([{ id: "p-1", thumb: bytes(4, 2) }])
        expect((yield* Shelves.get({ shelfId: "c-1" })).items[0].thumb).toEqual(bytes(4, 2))
      }).pipe(Effect.provide(PrintTable.layer({ name: TABLE }))),
    )
  })
})

// ---------------------------------------------------------------------------
// The whole-item budget
// ---------------------------------------------------------------------------

describe("Aggregate — an edge entity's item budget", () => {
  class Note extends Schema.Class<Note>("Note")({
    id: Schema.String,
    notes: Notes,
  }) {}
  const BudgetNotes = withOffloadGate(() =>
    Entity.make({
      model: DynamoModel.configure(Note, {
        id: { identifier: true },
        notes: {
          storedAs: DynamoModel.Packed({ format: "json", external: { threshold: 100_000 } }),
        },
      }),
      entityType: "Note",
      primaryKey: scanKey,
      offload: { itemBudget: 2_000 },
    }),
  )
  class Book extends Schema.Class<Book>("Book")({
    bookId: Schema.String,
    notes: Schema.Array(Note),
  }) {}
  const BudgetTable = Table.make({ schema: AppSchema, entities: { BudgetNotes } })
  const Books = Aggregate.make(Book, {
    table: BudgetTable,
    schema: AppSchema,
    pk: { field: "pk", composite: ["bookId"] },
    collection: { name: "book" },
    root: { entityType: "BookItem" },
    edges: {
      notes: Aggregate.many("notes", {
        entityType: "BookNote",
        entity: BudgetNotes,
        sk: { composite: ["id"] },
      }),
    },
  })

  it.effect("an edge item over the budget offloads its overflow value; one under keeps it", () =>
    Effect.gen(function* () {
      yield* Books.create({
        bookId: "b-1",
        notes: [
          { id: "n-1", notes: text(3_000) },
          { id: "n-2", notes: text(100) },
        ],
      } as never)
      const notes = (id: string) =>
        [...rows.values()].find((item) => item.__edd_e__?.S === "BookNote" && item.id?.S === id)!
      expect(pointerOf(notes("n-1").notes).kind).toBe("json")
      expect(notes("n-2").notes?.S).toBe(JSON.stringify(text(100)))
      expect(calls().put).toBe(1)
      const read = yield* Books.get({ bookId: "b-1" })
      expect(read.notes.map((n) => n.notes)).toEqual([text(3_000), text(100)])
    }).pipe(
      Effect.provide(
        Layer.mergeAll(ScriptedClient, BudgetTable.layer({ name: TABLE }), BlobStore.layer(blobs)),
      ),
    ),
  )
})

// ---------------------------------------------------------------------------
// Escaped key text (owner decision 2026-11-14, design §11.10)
// ---------------------------------------------------------------------------

/** Key text not escaped (#183): offloading requires it escaped (`EDD-9146`). */
const UnescapedSchema = DynamoSchema.make({ name: "aggoff", version: 1, escapeKeys: false })
const UnescapedScans = withOffloadGate(() =>
  Entity.make({
    model: DynamoModel.configure(Scan, {
      id: { identifier: true },
      image: { storedAs: DynamoModel.External({ contentType: "image/png" }) },
      notes: { storedAs: DynamoModel.Packed({ format: "json", external: { threshold: 64 } }) },
    }),
    entityType: "Scan",
    primaryKey: scanKey,
  }),
)
const UnescapedTable = Table.make({ schema: UnescapedSchema, entities: { UnescapedScans } })
const UnescapedAlbums = Aggregate.make(Album, {
  table: UnescapedTable,
  schema: UnescapedSchema,
  pk: { field: "pk", composite: ["albumId"] },
  collection: { name: "album" },
  root: { entityType: "AlbumItem" },
  edges: {
    cover: Aggregate.one("cover", { entityType: "AlbumCover", entity: UnescapedScans }),
    page1: Aggregate.make(Page, {
      root: { entityType: "AlbumPage" },
      edges: {
        scans: Aggregate.many("scans", {
          entityType: "AlbumScan",
          entity: UnescapedScans,
          sk: { composite: ["id"] },
        }),
      },
    }).with({ discriminator: { pageNo: 1 } }),
    page2: Aggregate.make(Page, {
      root: { entityType: "AlbumPage" },
      edges: {
        scans: Aggregate.many("scans", {
          entityType: "AlbumScan",
          entity: PlainScans,
          sk: { composite: ["id"] },
        }),
      },
    }).with({ discriminator: { pageNo: 2 } }),
  },
})

const defectOf = (exit: Exit.Exit<unknown, unknown>): string => {
  if (Exit.isSuccess(exit)) throw new Error("expected a defect")
  const reason = exit.cause.reasons.find((r) => r._tag === "Die")
  if (reason === undefined || reason._tag !== "Die") throw new Error("expected a Die reason")
  return String((reason.defect as Error).message ?? reason.defect)
}

describe("Aggregate offload — escaped key text (EDD-9146)", () => {
  it.effect("Aggregate.bind and DynamoClient.make die naming the edges, before the store", () =>
    Effect.gen(function* () {
      const bound = defectOf(yield* Effect.exit(Aggregate.bind(UnescapedAlbums)))
      // Not EDD-9115: no store is given, and the key text is checked first.
      expect(bound).toContain(
        '[EDD-9146] Aggregate.bind: aggregate "AlbumItem" (edge "AlbumCover")',
      )
      expect(bound).toContain('(edge "AlbumScan") offloads "notes", "image"')
      expect(bound).toContain("escapeKeys: true")
      // A store doesn't make the key text right.
      const made = defectOf(
        yield* Effect.exit(
          DynamoClient.make({
            entities: {},
            aggregates: { UnescapedAlbums },
            tables: { UnescapedTable },
            blobStore: blobs,
          }),
        ),
      )
      expect(made).toContain('[EDD-9146] DynamoClient.make: aggregate "UnescapedAlbums"')
      expect(calls().put).toBe(0)
      expect(commands()).toEqual([])
    }).pipe(Effect.provide(Layer.mergeAll(ScriptedClient, UnescapedTable.layer({ name: TABLE })))),
  )

  it.effect("an unbound write is refused where it routes: nothing uploaded or sent", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(UnescapedAlbums.create(album() as never))
      expect(error).toBeInstanceOf(ValidationError)
      expect(String((error as ValidationError).cause)).toContain(
        "[EDD-9146] Aggregate.create: AlbumCover offloads",
      )
      expect(calls().put).toBe(0)
      expect(commands().filter((c) => c === "TransactWriteItems")).toEqual([])
      expect(rows.size).toBe(0)
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          ScriptedClient,
          UnescapedTable.layer({ name: TABLE }),
          BlobStore.layer(blobs),
        ),
      ),
    ),
  )
})

// ---------------------------------------------------------------------------
// rekey never moves a pointer row (design §11.10)
// ---------------------------------------------------------------------------

describe("Aggregate offload — rekey never moves a pointer row", () => {
  class Shelf extends Schema.Class<Shelf>("Shelf")({
    shelfId: Schema.String,
    items: Schema.Array(Scan),
  }) {}
  const shelfOver = (entity: typeof Scans | typeof PlainScans, table: typeof MainTable) =>
    Aggregate.make(Shelf, {
      table,
      schema: table === MainTable ? AppSchema : UnescapedSchema,
      pk: { field: "pk", composite: ["shelfId"] },
      collection: { name: "shelf" },
      root: { entityType: "ShelfItem" },
      edges: {
        items: Aggregate.many("items", {
          entityType: "ShelfScan",
          entity,
          sk: { composite: ["id"] },
        }),
      },
    })
  /** Written with offloading, under escaped key text. */
  const Shelves = shelfOver(Scans, MainTable)
  /** `escapeKeys` turned off and the offloaded declarations removed: the only way it can run. */
  const PlainScansOff = Entity.make({
    model: DynamoModel.configure(Scan, { id: { identifier: true } }),
    entityType: "Scan",
    primaryKey: scanKey,
  })
  const PlainOffTable = Table.make({ schema: UnescapedSchema, entities: { PlainScansOff } })
  const PlainShelves = shelfOver(PlainScansOff, PlainOffTable as never)

  /** One shelf whose element's sort key text differs between the two settings (a space). */
  const written = (table: ReturnType<typeof makeRecordingTable>) =>
    Shelves.create({ shelfId: "sh-1", items: [scan("s 1", 2)] } as never).pipe(
      Effect.provide(
        Layer.mergeAll(table.layer, MainTable.layer({ name: TABLE }), BlobStore.layer(blobs)),
      ),
    )
  const rekeyedEscaped = (table: ReturnType<typeof makeRecordingTable>) =>
    Effect.flatMap(
      DynamoClient.make({
        entities: { Scans },
        aggregates: { Shelves },
        tables: { MainTable },
      }),
      (db) => db.tables.MainTable.rekey(),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(table.layer, MainTable.layer({ name: TABLE }), BlobStore.layer(blobs)),
      ),
    )
  const rekeyedPlain = (table: ReturnType<typeof makeRecordingTable>, dryRun: boolean) =>
    Effect.flatMap(
      DynamoClient.make({
        entities: { PlainScansOff },
        aggregates: { PlainShelves },
        tables: { PlainOffTable },
      }),
      (db) => db.tables.PlainOffTable.rekey({ dryRun }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          table.layer,
          PlainOffTable.layer({ name: TABLE }),
          // The plain read resolves the pointers through the ambient store (§4.7).
          BlobStore.layer(blobs),
        ),
      ),
    )

  it.effect("under escaped key text, rekey moves nothing", () =>
    Effect.gen(function* () {
      const table = makeRecordingTable()
      yield* written(table)
      const element = [...table.items.values()].find((row) => row.__edd_e__?.S === "ShelfScan")!
      expect(element.sk?.S).toContain("s%201")
      expect(isPointer(element.image)).toBe(true)
      const before = new Map(table.items)
      const report = yield* rekeyedEscaped(table)
      expect(report.conflicts).toEqual([])
      expect(Object.values(report.moved).every((n) => n === 0)).toBe(true)
      expect(new Map(table.items)).toEqual(before)
    }),
  )

  for (const dryRun of [true, false]) {
    it.effect(
      `with escapeKeys turned off, an edge row holding a pointer is refused${dryRun ? " (dry run)" : ""}`,
      () =>
        Effect.gen(function* () {
          const table = makeRecordingTable()
          yield* written(table)
          const held = new Map(table.items)
          const element = [...held.values()].find((row) => row.__edd_e__?.S === "ShelfScan")!
          table.take()
          const error = yield* Effect.flip(rekeyedPlain(table, dryRun))
          expect(error).toBeInstanceOf(ValidationError)
          const cause = String((error as ValidationError).cause)
          expect(cause).toContain('[EDD-9146] Aggregate "ShelfItem"')
          expect(cause).toContain("holds a blob pointer")
          // The row's key, as stored (escaped).
          expect(cause).toContain(JSON.stringify(element.sk!.S!).slice(1, -1))
          // Nothing written: every row is where it was, as it was.
          expect(new Map(table.items)).toEqual(held)
          const writes = table
            .take()
            .filter((r) => !["GetItem", "Query", "Scan", "BatchGetItem"].includes(r.command))
          expect(writes).toEqual([])
        }),
    )
  }
})
