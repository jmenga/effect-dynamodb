/**
 * Change detection over offloaded fields (#179, design §3.9, §10.3, §10.4):
 * `Offload.compareStored` over every row of §10.3's table (pointers, inline
 * `S` / compressed `B`, legacy native maps, `NULL`, both field kinds, Lambda's
 * base64 `B`), and `Entity.decodeStreamRecord` over records built from the
 * rows real writes leave in the in-memory tables — both images decoded per
 * mode, each offloaded field classified with no store I/O, `[EDD-9119]` for
 * records that lack the images, `Option.none()` for other entity types.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { describe, expect, it } from "@effect/vitest"
import { Compression } from "@effect-dynamodb/schema/Compression.js"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import * as SchemaEntity from "@effect-dynamodb/schema/Entity.js"
import { CompressorNotRegistered, ValidationError } from "@effect-dynamodb/schema/Errors.js"
import * as BlobPointer from "@effect-dynamodb/schema/internal/BlobPointer.js"
import { crc64nvme } from "@effect-dynamodb/schema/internal/Crc64Nvme.js"
import { Effect, Exit, Layer, Option, Schema } from "effect"
import { beforeEach } from "vitest"
import { BlobStore } from "../src/BlobStore.js"
import * as ZlibCompression from "../src/compression/zlib.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import type { MemoryBlobStore } from "../src/internal/MemoryBlobStore.js"
import * as OffloadChange from "../src/internal/OffloadChange.js"
import { fromAttributeMap, toAttributeValue } from "../src/Marshaller.js"
import * as Offload from "../src/Offload.js"
import * as StorageEncoding from "../src/StorageEncoding.js"
import * as Table from "../src/Table.js"
import { bytesPointer, bytesPointerText, jsonPointer } from "./helpers/BlobPointers.js"
import { InMemoryClient, type Item, resetStore, store as rows } from "./helpers/InMemoryTables.js"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const AppSchema = DynamoSchema.make({ name: "chg", version: 1, escapeKeys: true })

const Text = Schema.Struct({ text: Schema.String })

class Doc extends Schema.Class<Doc>("Doc")({
  docId: Schema.String,
  title: Schema.String,
  body: Schema.optional(Text),
  scan: Schema.optional(Schema.Uint8Array),
  meta: Schema.optional(Schema.Struct({ n: Schema.Number })),
}) {}

const docKey = {
  pk: { field: "pk", composite: ["docId"] },
  sk: { field: "sk", composite: [] },
} as const

/** `{"text":"…"}` is 11 bytes plus the text. */
const text = (jsonBytes: number, fill = "x") => ({ text: fill.repeat(jsonBytes - 11) })
const BODY = text(200)
const OTHER_BODY = text(200, "y")
const SMALL = text(30)
const SCAN = new Uint8Array(300).fill(7)

/** body: overflow past 64 bytes; scan: always external, stored as `scan_bytes`. */
const docModel = DynamoModel.configure(Doc, {
  body: { storedAs: DynamoModel.Packed({ format: "json", external: { threshold: 64 } }) },
  scan: { field: "scan_bytes", storedAs: DynamoModel.External({ contentType: "image/png" }) },
  meta: { storedAs: DynamoModel.Packed({ format: "json" }) },
})

const Docs = Entity.make({ model: docModel, entityType: "Doc", primaryKey: docKey })

/**
 * The same items as `Docs`, written by a member whose body stays inline — and
 * gzip-packed — up to 1 MB: a record from it to `Docs` moves the body from
 * inline to the store.
 */
const InlineDocs = Entity.make({
  model: DynamoModel.configure(Doc, {
    body: {
      storedAs: DynamoModel.Packed({
        format: "json",
        compression: { codec: "gzip", threshold: 0 },
        external: { threshold: 1_000_000 },
      }),
    },
    scan: { field: "scan_bytes", storedAs: DynamoModel.External({ contentType: "image/png" }) },
    meta: { storedAs: DynamoModel.Packed({ format: "json" }) },
  }),
  entityType: "Doc",
  primaryKey: docKey,
})

/** An entity that offloads nothing. */
class Note extends Schema.Class<Note>("Note")({ noteId: Schema.String, note: Schema.String }) {}
const Notes = Entity.make({
  model: Note,
  entityType: "Note",
  primaryKey: { pk: { field: "pk", composite: ["noteId"] }, sk: { field: "sk", composite: [] } },
})

/** A pure definition, from the AWS-free package. */
const PureDocs = SchemaEntity.make({ model: docModel, entityType: "PureDoc", primaryKey: docKey })

const MainTable = Table.make({ schema: AppSchema, entities: { Docs, Notes, PureDocs } })
const InlineTable = Table.make({ schema: AppSchema, entities: { InlineDocs } })

let blobs: MemoryBlobStore = BlobStore.memory()

const compression = Compression.layer(ZlibCompression.available())

const layers = () =>
  Layer.mergeAll(
    InMemoryClient,
    MainTable.layer({ name: "main" }),
    InlineTable.layer({ name: "main" }),
    BlobStore.layer(blobs),
    compression,
  )

const withStore = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.suspend(() => effect.pipe(Effect.provide(layers())))

beforeEach(() => {
  resetStore()
  blobs = BlobStore.memory()
})

const client = DynamoClient.make({
  entities: { Docs, Notes, PureDocs, InlineDocs },
  tables: { MainTable, InlineTable },
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const gets = () => blobs.inspect().calls.get

/** The row of an item by its id attribute, as DynamoDB JSON — a copy. */
const row = (id: string): Item => {
  const found = [...rows.values()].find((item) => item.docId?.S === id || item.noteId?.S === id)
  if (found === undefined) throw new Error(`no row ${id}`)
  return structuredClone(found)
}

const modify = (oldImage: Item, newImage: Item) => ({
  eventName: "MODIFY",
  dynamodb: { StreamViewType: "NEW_AND_OLD_IMAGES", OldImage: oldImage, NewImage: newImage },
})
const insert = (newImage: Item) => ({
  eventName: "INSERT",
  dynamodb: { StreamViewType: "NEW_AND_OLD_IMAGES", NewImage: newImage },
})
const remove = (oldImage: Item) => ({
  eventName: "REMOVE",
  dynamodb: { StreamViewType: "NEW_AND_OLD_IMAGES", OldImage: oldImage },
})

/** An image as Lambda / EventBridge Pipes deliver it: every `B` as base64 text. */
const lambdaImage = (image: Item): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(image).map(([name, value]) => [
      name,
      value.B === undefined ? value : { B: Buffer.from(value.B).toString("base64") },
    ]),
  )

const failure = <E>(exit: Exit.Exit<unknown, E>): E => {
  if (Exit.isSuccess(exit)) throw new Error("expected a failure")
  const reason = exit.cause.reasons.find((r) => r._tag === "Fail")
  if (reason === undefined || reason._tag !== "Fail") throw new Error("expected a Fail reason")
  return reason.error
}

const causeMessage = (error: unknown): string => {
  expect(error).toBeInstanceOf(ValidationError)
  return ((error as ValidationError).cause as Error).message
}

const pointer = (fields: Partial<BlobPointer.BlobPointerFields> = {}): BlobPointer.BlobPointer => {
  const made = BlobPointer.make({ ...jsonPointer, ...fields })
  if (typeof made === "string") throw new Error(made)
  return made
}

const encoder = new TextEncoder()
const JSON_TEXT = '{"a":1,"b":[1,2,3]}'
const CONTENT = encoder.encode(JSON_TEXT)
/** A json pointer whose content checksum and size are `content`'s. */
const pointerTo = (content: Uint8Array, version = "v1") =>
  pointer({
    codec: "none",
    ref: { key: "p/f/o", version },
    objectSize: content.length,
    contentSize: content.length,
    checksum: { algorithm: "crc64nvme", value: crc64nvme(content) },
  })
const B = (p: BlobPointer.BlobPointer): AttributeValue => ({ B: BlobPointer.encode(p) })
/** An inline `B` value: header `0x21` (v1, json, gzip) and the gzip of the JSON. */
const gzipped = (json: string): AttributeValue => ({
  B: new Uint8Array([0x21, ...ZlibCompression.gzip().compress(encoder.encode(json))]),
})

const compare = (
  before: Offload.StoredAttributeValue | undefined,
  after: Offload.StoredAttributeValue | undefined,
  kind: Offload.OffloadKind = "overflow",
) => Offload.compareStored(before, after, kind).pipe(Effect.provide(compression))

// ---------------------------------------------------------------------------
// Offload.compareStored — design §10.3, row by row
// ---------------------------------------------------------------------------

describe("Offload.compareStored", () => {
  it.effect("absent / present: added, removed; both absent: unchanged", () =>
    Effect.gen(function* () {
      expect(yield* compare(undefined, { S: JSON_TEXT })).toBe("added")
      expect(yield* compare(B(pointerTo(CONTENT)), undefined)).toBe("removed")
      expect(yield* compare(undefined, undefined)).toBe("unchanged")
      expect(yield* compare(undefined, { S: bytesPointerText }, "binary")).toBe("added")
      expect(yield* compare({ B: SCAN }, undefined, "binary")).toBe("removed")
    }),
  )

  it.effect("pointer / pointer: same ref unchanged; same checksum and size rewritten", () =>
    Effect.gen(function* () {
      const v1 = pointerTo(CONTENT, "v1")
      expect(yield* compare(B(v1), B(v1))).toBe("unchanged")
      expect(yield* compare(B(v1), B(pointerTo(CONTENT, "v2")))).toBe("rewritten")
      // Another codec, the same content: rewritten.
      expect(
        yield* compare(
          B(v1),
          B(pointer({ ...v1, codec: "zstd", objectSize: 7, ref: { key: "k", version: "v3" } })),
        ),
      ).toBe("rewritten")
      // Binary pointers, as `~edbp:` text.
      const text = { S: bytesPointerText }
      expect(yield* compare(text, text, "binary")).toBe("unchanged")
      const moved = BlobPointer.make({ ...bytesPointer, ref: { key: "k", version: "v9" } })
      expect(
        yield* compare(
          text,
          { S: BlobPointer.encodeText(moved as BlobPointer.BlobPointer) },
          "binary",
        ),
      ).toBe("rewritten")
    }),
  )

  it.effect("different checksum, or equal checksums with different content sizes: changed", () =>
    Effect.gen(function* () {
      const v1 = pointerTo(CONTENT, "v1")
      const otherChecksum = pointer({
        ...v1,
        ref: { key: "p/f/o", version: "v2" },
        checksum: { algorithm: "crc64nvme", value: new Uint8Array(8).fill(9) },
      })
      expect(yield* compare(B(v1), B(otherChecksum))).toBe("changed")
      const otherSize = pointer({
        ...v1,
        ref: { key: "p/f/o", version: "v2" },
        objectSize: CONTENT.length + 1,
        contentSize: CONTENT.length + 1,
      })
      expect(yield* compare(B(v1), B(otherSize))).toBe("changed")
      // The same ref but another checksum (a corrupt pointer): changed.
      expect(yield* compare(B(v1), B(pointer({ ...otherChecksum, ref: v1.ref })))).toBe("changed")
    }),
  )

  it.effect("inline against a pointer: the inline content's checksum and size, computed here", () =>
    Effect.gen(function* () {
      const p = B(pointerTo(CONTENT))
      // S text, and gzip-packed B, of the pointer's content: rewritten (either way).
      expect(yield* compare({ S: JSON_TEXT }, p)).toBe("rewritten")
      expect(yield* compare(p, { S: JSON_TEXT })).toBe("rewritten")
      expect(yield* compare(gzipped(JSON_TEXT), p)).toBe("rewritten")
      expect(yield* compare(p, gzipped(JSON_TEXT))).toBe("rewritten")
      // Different content: changed. The same entries in another key order: changed.
      expect(yield* compare({ S: '{"a":2,"b":[1,2,3]}' }, p)).toBe("changed")
      expect(yield* compare({ S: '{"b":[1,2,3],"a":1}' }, p)).toBe("changed")
      // The pointer's checksum, but another content size: changed.
      const longer = pointer({
        ...pointerTo(CONTENT),
        objectSize: CONTENT.length + 4,
        contentSize: CONTENT.length + 4,
      })
      expect(yield* compare({ S: JSON_TEXT }, B(longer))).toBe("changed")
      // Binary: native bytes against a bytes pointer of them.
      const bytes = BlobPointer.make({
        ...bytesPointer,
        objectSize: SCAN.length,
        contentSize: SCAN.length,
        checksum: { algorithm: "crc64nvme", value: crc64nvme(SCAN) },
      }) as BlobPointer.BlobPointer
      const pointerText = { S: BlobPointer.encodeText(bytes) }
      expect(yield* compare({ B: SCAN }, pointerText, "binary")).toBe("rewritten")
      expect(yield* compare(pointerText, { B: SCAN }, "binary")).toBe("rewritten")
      expect(yield* compare({ B: SCAN.subarray(1) }, pointerText, "binary")).toBe("changed")
    }),
  )

  it.effect("inline / inline: the same content unchanged (whatever its codec), else changed", () =>
    Effect.gen(function* () {
      expect(yield* compare({ S: JSON_TEXT }, { S: JSON_TEXT })).toBe("unchanged")
      expect(yield* compare({ S: JSON_TEXT }, gzipped(JSON_TEXT))).toBe("unchanged")
      expect(yield* compare({ S: JSON_TEXT }, { S: '{"a":1,"b":[1,2]}' })).toBe("changed")
      // A key-order restatement is other content.
      expect(yield* compare({ S: JSON_TEXT }, { S: '{"b":[1,2,3],"a":1}' })).toBe("changed")
      expect(yield* compare({ B: SCAN }, { B: new Uint8Array(SCAN) }, "binary")).toBe("unchanged")
      expect(yield* compare({ B: SCAN }, { B: SCAN.subarray(1) }, "binary")).toBe("changed")
    }),
  )

  it.effect(
    "a legacy native value: changed against any other form, compared with its own kind",
    () =>
      Effect.gen(function* () {
        const native: AttributeValue = {
          M: { a: { N: "1" }, b: { L: [{ N: "1" }, { N: "2" }, { N: "3" }] } },
        }
        expect(yield* compare(native, { S: JSON_TEXT })).toBe("changed")
        expect(yield* compare(native, B(pointerTo(CONTENT)))).toBe("changed")
        expect(yield* compare({ S: JSON_TEXT }, native)).toBe("changed")
        expect(yield* compare(native, structuredClone(native))).toBe("unchanged")
        expect(yield* compare(native, { M: { a: { N: "2" } } })).toBe("changed")
        // Sets compare as sets; binary members as bytes, base64 or not.
        expect(
          yield* compare({ M: { s: { SS: ["x", "y"] }, b: { B: new Uint8Array([1, 2]) } } }, {
            M: { s: { SS: ["y", "x"] }, b: { B: "AQI=" } },
          } as Offload.StoredAttributeValue),
        ).toBe("unchanged")
      }),
  )

  it.effect("NULL: unchanged against NULL, changed against a value", () =>
    Effect.gen(function* () {
      expect(yield* compare({ NULL: true }, { NULL: true })).toBe("unchanged")
      expect(yield* compare({ NULL: true }, { S: JSON_TEXT })).toBe("changed")
      expect(yield* compare(B(pointerTo(CONTENT)), { NULL: true })).toBe("changed")
      expect(yield* compare(undefined, { NULL: true })).toBe("added")
    }),
  )

  it.effect("Lambda's DynamoDB JSON: B as base64 text", () =>
    Effect.gen(function* () {
      const p = BlobPointer.encode(pointerTo(CONTENT))
      const base64 = { B: Buffer.from(p).toString("base64") }
      expect(yield* compare(base64, { B: p })).toBe("unchanged")
      expect(yield* compare({ S: JSON_TEXT }, base64)).toBe("rewritten")
      const scan = { B: Buffer.from(SCAN).toString("base64") }
      expect(yield* compare(scan, { B: SCAN }, "binary")).toBe("unchanged")
    }),
  )

  it.effect("values that are not a stored form of the kind fail with a ValidationError", () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<
        readonly [
          Offload.StoredAttributeValue | undefined,
          Offload.StoredAttributeValue | undefined,
          Offload.OffloadKind,
          string,
        ]
      > = [
        // An S value on a binary attribute that is not a pointer.
        [{ S: "plain text" }, undefined, "binary", "neither a binary value nor a blob pointer"],
        [{ N: "1" }, undefined, "binary", "neither a binary value nor a blob pointer"],
        // A malformed pointer, and the other kind than the form stores.
        [
          { B: BlobPointer.encode(jsonPointer).subarray(0, 20) },
          undefined,
          "overflow",
          "blob pointer",
        ],
        [{ B: BlobPointer.encode(bytesPointer) }, undefined, "overflow", "kind bytes"],
        [{ S: BlobPointer.encodeText(jsonPointer) }, undefined, "binary", "kind json"],
        [{ S: `${bytesPointerText}!` }, undefined, "binary", "base64url"],
        // A binary field's `~edbp:` text on an overflow attribute, on either side.
        [{ S: bytesPointerText }, undefined, "overflow", "~edbp"],
        [{ S: JSON_TEXT }, { S: bytesPointerText }, "overflow", "~edbp"],
        [{ S: bytesPointerText }, { S: bytesPointerText }, "overflow", "~edbp"],
        // Not an attribute value at all.
        [
          { S: "a", N: "1" } as Offload.StoredAttributeValue,
          undefined,
          "overflow",
          "DynamoDB JSON",
        ],
      ]
      for (const [before, after, kind, message] of cases) {
        const error = failure(yield* Effect.exit(compare(before, after, kind)))
        expect(error).toMatchObject({ entityType: "Offload", operation: "Offload.compareStored" })
        expect(causeMessage(error)).toContain(message)
      }
      const kind = failure(
        yield* Effect.exit(compare(undefined, undefined, "json" as Offload.OffloadKind)),
      )
      expect(causeMessage(kind)).toContain('"overflow" or "binary"')
      // A compressed inline value without its codec: CompressorNotRegistered.
      const missing = failure(
        yield* Effect.exit(
          Offload.compareStored(gzipped(JSON_TEXT), B(pointerTo(CONTENT)), "overflow"),
        ),
      )
      expect(missing).toBeInstanceOf(ValidationError)
      expect(missing.cause).toBeInstanceOf(CompressorNotRegistered)
      // An unmarshalled image's overflow string refuses `~edbp:` text the same way.
      const unmarshalled = OffloadChange.formOfUnmarshalled(
        bytesPointerText,
        "overflow",
        true,
        toAttributeValue,
        Compression.make([]),
        { entityType: "Doc", operation: "decodeStreamRecord" },
        "body",
      )
      expect(causeMessage(unmarshalled)).toContain("~edbp")
    }),
  )

  it.effect("a member set to undefined is no member", () =>
    Effect.gen(function* () {
      // The type admits it (every member is optional, `| undefined`): still an `S` value.
      expect(yield* compare({ S: JSON_TEXT, B: undefined }, { S: JSON_TEXT })).toBe("unchanged")
      expect(yield* compare({ S: JSON_TEXT, N: undefined }, B(pointerTo(CONTENT)))).toBe(
        "rewritten",
      )
      expect(yield* compare({ B: SCAN, S: undefined }, { B: SCAN }, "binary")).toBe("unchanged")
      // Nested legacy native values compare by their defined members too.
      expect(
        yield* compare(
          { M: { a: { N: "1", S: undefined } }, L: undefined },
          { M: { a: { N: "1" } } },
        ),
      ).toBe("unchanged")
      expect(yield* compare({ M: { a: { N: "1", S: undefined } } }, { M: { a: { N: "2" } } })).toBe(
        "changed",
      )
      // No defined member at all: not an attribute value.
      const none = failure(yield* Effect.exit(compare({ S: undefined }, undefined)))
      expect(causeMessage(none)).toContain("DynamoDB JSON")
    }),
  )
})

// ---------------------------------------------------------------------------
// Entity.decodeStreamRecord over real writes
// ---------------------------------------------------------------------------

const asValue = (u: unknown) => u as Offload.OffloadedValue<{ readonly text: string }>
const asHandle = (u: unknown) => u as Offload.BlobHandle

describe("Entity.decodeStreamRecord", () => {
  it.effect(
    "INSERT / MODIFY / REMOVE: both images, lazy, and each offloaded field classified",
    () =>
      withStore(
        Effect.gen(function* () {
          const db = yield* client
          yield* db.entities.Docs.put({
            docId: "d-1",
            title: "t",
            body: BODY,
            scan: SCAN,
            meta: { n: 1 },
          })
          const created = row("d-1")
          const before = gets()

          const inserted = Option.getOrThrow(
            yield* Entity.decodeStreamRecord(Docs, insert(created)),
          )
          expect(inserted.eventName).toBe("INSERT")
          expect(Option.isNone(inserted.oldItem)).toBe(true)
          const item = Option.getOrThrow(inserted.newItem)
          expect(item.title).toBe("t")
          expect(item.meta).toEqual({ n: 1 })
          // Domain names, the renamed binary field included.
          expect(inserted.offloaded).toEqual({ body: "added", scan: "added" })
          // Lazy by default, and nothing fetched to classify.
          expect(gets()).toBe(before)
          expect(yield* asValue(item.body).read()).toEqual(BODY)
          expect(yield* asHandle(item.scan).read()).toEqual(SCAN)

          // A write that leaves the offloaded fields alone keeps their pointers.
          yield* db.entities.Docs.update({ docId: "d-1" }).set({ title: "t2" })
          const retitled = row("d-1")
          const kept = Option.getOrThrow(
            yield* Entity.decodeStreamRecord(Docs, modify(created, retitled)),
          )
          expect(kept.offloaded).toEqual({ body: "unchanged", scan: "unchanged" })
          expect(Option.getOrThrow(kept.oldItem).title).toBe("t")
          expect(Option.getOrThrow(kept.newItem).title).toBe("t2")

          // Restating the same content uploads a new version: rewritten.
          yield* db.entities.Docs.update({ docId: "d-1" }).set({ body: BODY, scan: SCAN })
          const restated = row("d-1")
          expect(
            Option.getOrThrow(yield* Entity.decodeStreamRecord(Docs, modify(retitled, restated)))
              .offloaded,
          ).toEqual({ body: "rewritten", scan: "rewritten" })

          // New content: changed; a removed field: removed.
          yield* db.entities.Docs.update({ docId: "d-1" })
            .set({ body: OTHER_BODY })
            .remove(["scan"])
          const changed = row("d-1")
          expect(
            Option.getOrThrow(yield* Entity.decodeStreamRecord(Docs, modify(restated, changed)))
              .offloaded,
          ).toEqual({ body: "changed", scan: "removed" })

          yield* db.entities.Docs.delete({ docId: "d-1" })
          const removed = Option.getOrThrow(yield* Entity.decodeStreamRecord(Docs, remove(changed)))
          expect(removed.eventName).toBe("REMOVE")
          expect(Option.isNone(removed.newItem)).toBe(true)
          expect(yield* asValue(Option.getOrThrow(removed.oldItem).body).read()).toEqual(OTHER_BODY)
          expect(removed.offloaded).toEqual({ body: "removed" })
        }),
      ),
  )

  it.effect(
    "inline → external of the same content is rewritten; inline / inline compares content",
    () =>
      withStore(
        Effect.gen(function* () {
          const db = yield* client
          yield* db.entities.InlineDocs.put({ docId: "d-2", title: "t", body: BODY })
          const inline = row("d-2")
          // Gzip-packed inline (the InlineDocs config).
          expect(inline.body?.B?.[0]).toBe(0x21)
          yield* db.entities.Docs.put({ docId: "d-2", title: "t", body: BODY })
          const external = row("d-2")
          expect(Option.isSome(StorageEncoding.pointer(external.body!))).toBe(true)
          expect(
            Option.getOrThrow(yield* Entity.decodeStreamRecord(Docs, modify(inline, external)))
              .offloaded,
          ).toEqual({ body: "rewritten" })
          expect(
            Option.getOrThrow(yield* Entity.decodeStreamRecord(Docs, modify(external, inline)))
              .offloaded,
          ).toEqual({ body: "rewritten" })
          // Under the threshold: S inline. Against the gzip-packed B of other content: changed;
          // against the same JSON as S: unchanged.
          yield* db.entities.Docs.put({ docId: "d-2", title: "t", body: SMALL })
          const small = row("d-2")
          expect(typeof small.body?.S).toBe("string")
          expect(
            Option.getOrThrow(yield* Entity.decodeStreamRecord(Docs, modify(inline, small)))
              .offloaded,
          ).toEqual({ body: "changed" })
          expect(
            Option.getOrThrow(yield* Entity.decodeStreamRecord(Docs, modify(small, row("d-2"))))
              .offloaded,
          ).toEqual({ body: "unchanged" })
        }),
      ),
  )

  it.effect("Lambda's base64 B and unmarshalled images classify and decode the same", () =>
    withStore(
      Effect.gen(function* () {
        const db = yield* client
        yield* db.entities.Docs.put({ docId: "d-3", title: "t", body: BODY, scan: SCAN })
        const v1 = row("d-3")
        yield* db.entities.Docs.update({ docId: "d-3" }).set({ body: BODY })
        const v2 = row("d-3")
        const expected = { body: "rewritten", scan: "unchanged" }
        const lambda = modify(lambdaImage(v1) as Item, lambdaImage(v2) as Item)
        const fromLambda = Option.getOrThrow(
          yield* Entity.decodeStreamRecord(Docs, lambda, { offloaded: "eager" }),
        )
        expect(fromLambda.offloaded).toEqual(expected)
        expect(Option.getOrThrow(fromLambda.newItem).body).toEqual(BODY)
        expect(Option.getOrThrow(fromLambda.newItem).scan).toEqual(SCAN)
        // Unmarshalled images: B as bytes, and as base64 text.
        const unmarshalled = (image: Item) => fromAttributeMap(image) as Item
        const base64 = (image: Item) =>
          Object.fromEntries(
            Object.entries(fromAttributeMap(image)).map(([name, value]) => [
              name,
              value instanceof Uint8Array ? Buffer.from(value).toString("base64") : value,
            ]),
          ) as Item
        for (const shape of [unmarshalled, base64]) {
          const change = Option.getOrThrow(
            yield* Entity.decodeStreamRecord(Docs, modify(shape(v1), shape(v2)), {
              offloaded: "eager",
            }),
          )
          expect(change.offloaded).toEqual(expected)
          expect(Option.getOrThrow(change.oldItem).body).toEqual(BODY)
          expect(Option.getOrThrow(change.oldItem).scan).toEqual(SCAN)
        }
      }),
    ),
  )

  it.effect("eager resolves both images; a lazy read's errors name decodeStreamRecord.read", () =>
    Effect.gen(function* () {
      yield* withStore(
        Effect.gen(function* () {
          const db = yield* client
          yield* db.entities.Docs.put({ docId: "d-4", title: "t", body: BODY, scan: SCAN })
          const v1 = row("d-4")
          yield* db.entities.Docs.update({ docId: "d-4" }).set({ body: OTHER_BODY })
          const v2 = row("d-4")
          const before = gets()
          const eager = Option.getOrThrow(
            yield* Entity.decodeStreamRecord(Docs, modify(v1, v2), { offloaded: "eager" }),
          )
          expect(Option.getOrThrow(eager.oldItem).body).toEqual(BODY)
          expect(Option.getOrThrow(eager.newItem).body).toEqual(OTHER_BODY)
          expect(Option.getOrThrow(eager.newItem).scan).toEqual(SCAN)
          // Two bodies and two scans (one version, read once per image).
          expect(gets() - before).toBe(4)
          const mixed = Option.getOrThrow(
            yield* Entity.decodeStreamRecord(Docs, modify(v1, v2), {
              offloaded: { binary: "eager" },
            }),
          )
          expect(Option.getOrThrow(mixed.newItem).scan).toEqual(SCAN)
          expect(Offload.isOffloadedValue(Option.getOrThrow(mixed.newItem).body)).toBe(true)
        }),
      )
      // Decoded without a store: the decode needs none; a lazy read fails NotProvided.
      const lazy = Option.getOrThrow(yield* Entity.decodeStreamRecord(Docs, insert(row("d-4"))))
      const error = yield* Effect.flip(asValue(Option.getOrThrow(lazy.newItem).body).read())
      expect(error).toMatchObject({
        _tag: "BlobStoreError",
        reason: "NotProvided",
        operation: "decodeStreamRecord.read",
        attribute: "body",
      })
      // ...and an eager decode fails with it.
      const eager = failure(
        yield* Effect.exit(
          Entity.decodeStreamRecord(Docs, insert(row("d-4")), { offloaded: "eager" }),
        ),
      )
      expect(eager).toMatchObject({ _tag: "BlobStoreError", reason: "NotProvided" })
    }),
  )

  it.effect("[EDD-9119]: a record without the images of a NEW_AND_OLD_IMAGES stream", () =>
    withStore(
      Effect.gen(function* () {
        const db = yield* client
        yield* db.entities.Docs.put({ docId: "d-5", title: "t", body: BODY })
        const image = row("d-5")
        yield* db.entities.Notes.put({ noteId: "n-1", note: "x" })
        const note = row("n-1")
        const records: ReadonlyArray<readonly [unknown, string]> = [
          [
            { eventName: "INSERT", dynamodb: { StreamViewType: "NEW_IMAGE", NewImage: image } },
            '"NEW_IMAGE"',
          ],
          [
            { eventName: "MODIFY", dynamodb: { StreamViewType: "KEYS_ONLY", Keys: {} } },
            '"KEYS_ONLY"',
          ],
          [
            { eventName: "REMOVE", dynamodb: { StreamViewType: "OLD_IMAGE", OldImage: image } },
            '"OLD_IMAGE"',
          ],
          // Another entity type's record is checked too.
          [
            { eventName: "INSERT", dynamodb: { StreamViewType: "NEW_IMAGE", NewImage: note } },
            '"NEW_IMAGE"',
          ],
          // No view type (an input template stripped it): the images are checked.
          [{ eventName: "MODIFY", dynamodb: { NewImage: image } }, "MODIFY record has no OldImage"],
          [{ eventName: "REMOVE", dynamodb: { Keys: {} } }, "REMOVE record has no OldImage"],
          [{ eventName: "INSERT", dynamodb: { Keys: {} } }, "INSERT record has no NewImage"],
          [{ eventName: "MODIFY", dynamodb: { OldImage: image } }, "MODIFY record has no NewImage"],
          [{ eventName: "MODIFY" }, "MODIFY record has no OldImage"],
        ]
        for (const [record, message] of records) {
          const error = failure(
            yield* Effect.exit(Entity.decodeStreamRecord(Docs, record as Entity.StreamRecordLike)),
          )
          expect(error).toMatchObject({ entityType: "Doc", operation: "decodeStreamRecord" })
          expect(causeMessage(error)).toContain("[EDD-9119]")
          expect(causeMessage(error)).toContain(message)
        }
        // Without a view type, records with their images pass.
        const ok = yield* Entity.decodeStreamRecord(Docs, {
          eventName: "MODIFY",
          dynamodb: { OldImage: image, NewImage: image },
        })
        expect(Option.getOrThrow(ok).offloaded).toEqual({ body: "unchanged" })
        // Not a record of DynamoDB's: a plain ValidationError.
        for (const record of [{ dynamodb: { NewImage: image } }, { eventName: "UPSERT" }]) {
          const error = failure(
            yield* Effect.exit(Entity.decodeStreamRecord(Docs, record as Entity.StreamRecordLike)),
          )
          expect(causeMessage(error)).toContain("eventName")
          expect(causeMessage(error)).not.toContain("EDD-9119")
        }
      }),
    ),
  )

  it.effect("none for another entity type; an image of another type counts as absent", () =>
    withStore(
      Effect.gen(function* () {
        const db = yield* client
        yield* db.entities.Notes.put({ noteId: "n-2", note: "x" })
        const note = row("n-2")
        expect(Option.isNone(yield* Entity.decodeStreamRecord(Docs, insert(note)))).toBe(true)
        const { __edd_e__: _, ...untyped } = note
        expect(Option.isNone(yield* Entity.decodeStreamRecord(Docs, remove(untyped)))).toBe(true)
        yield* db.entities.Docs.put({ docId: "d-6", title: "t", body: BODY })
        const doc = row("d-6")
        const replaced = Option.getOrThrow(
          yield* Entity.decodeStreamRecord(Docs, modify(note, doc)),
        )
        expect(Option.isNone(replaced.oldItem)).toBe(true)
        expect(replaced.offloaded).toEqual({ body: "added" })
      }),
    ),
  )

  it.effect("an entity that offloads nothing, and a pure definition", () =>
    withStore(
      Effect.gen(function* () {
        const db = yield* client
        yield* db.entities.Notes.put({ noteId: "n-3", note: "x" })
        const v1 = row("n-3")
        yield* db.entities.Notes.update({ noteId: "n-3" }).set({ note: "y" })
        const plain = Option.getOrThrow(
          yield* Entity.decodeStreamRecord(Notes, modify(v1, row("n-3"))),
        )
        expect(plain.offloaded).toEqual({})
        expect(Option.getOrThrow(plain.oldItem).note).toBe("x")
        expect(Option.getOrThrow(plain.newItem).note).toBe("y")

        yield* db.entities.PureDocs.put({ docId: "p-1", title: "t", body: BODY, meta: { n: 2 } })
        const pure = Option.getOrThrow(
          yield* Entity.decodeStreamRecord(PureDocs, insert(row("p-1")), { offloaded: "eager" }),
        )
        expect(Option.getOrThrow(pure.newItem).body).toEqual(BODY)
        expect(Option.getOrThrow(pure.newItem).meta).toEqual({ n: 2 })
        expect(pure.offloaded).toEqual({ body: "added" })
      }),
    ),
  )

  it.effect("an invalid mode is a ValidationError ([EDD-9117])", () =>
    withStore(
      Effect.gen(function* () {
        const db = yield* client
        yield* db.entities.Docs.put({ docId: "d-7", title: "t" })
        const error = failure(
          yield* Effect.exit(
            Entity.decodeStreamRecord(Docs, insert(row("d-7")), { offloaded: "maybe" as never }),
          ),
        )
        expect(error).toMatchObject({ operation: "decodeStreamRecord" })
        expect(String((error as ValidationError).cause)).toContain("EDD-9117")
      }),
    ),
  )
})
