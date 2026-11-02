/**
 * Entity reads of offloaded fields (#179, design §8, §9.2, §10.1): every
 * decoder over rows mixing inline values and pointers, per mode; the
 * `.offloaded()` builders and the `Entity.offloaded` / `Query.offloaded`
 * duals; projections and the `limit` window; `filterBy`; `Batch.get` and
 * `Transaction.transactGet`; collections; lifecycle reads; verification
 * failures; pointers on attributes a member does not offload (§4.7);
 * `Entity.decodeMarshalledItem` on entities and pure definitions; `EDD-9117`.
 *
 * Rows are written through the entities (the write paths of commit 7) into
 * the in-memory tables, or rewritten in place; the in-memory store's call
 * counts say what each read fetched.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { describe, expect, it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { makeTestEmbedder } from "@effect-dynamodb/schema/Embedder.js"
import * as SchemaEntity from "@effect-dynamodb/schema/Entity.js"
import {
  BlobStoreError,
  ConcurrentModification,
  ValidationError,
} from "@effect-dynamodb/schema/Errors.js"
import * as BlobPointer from "@effect-dynamodb/schema/internal/BlobPointer.js"
import { Effect, Layer, Option, Schema, Stream } from "effect"
import { afterAll, beforeAll, beforeEach } from "vitest"
import * as Batch from "../src/Batch.js"
import { BlobStore } from "../src/BlobStore.js"
import * as Collection from "../src/Collection.js"
import { DynamoClient, type DynamoClientService } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import type { MemoryBlobStore } from "../src/internal/MemoryBlobStore.js"
import * as Offload from "../src/Offload.js"
import * as Query from "../src/Query.js"
import * as Table from "../src/Table.js"
import * as Transaction from "../src/Transaction.js"
import * as VectorSearchEmulation from "../src/VectorSearchEmulation.js"
import {
  holds,
  hooks,
  InMemoryClient,
  type Item,
  keyOf,
  resetStore,
  store as rows,
  tableIndexes,
} from "./helpers/InMemoryTables.js"
import { withOffloadGate } from "./helpers/OffloadGate.js"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const AppSchema = DynamoSchema.make({ name: "rd", version: 1, escapeKeys: true })

// The in-memory tables' GSI keys for this file's table, removed after it: the unit files share a
// worker's modules (`isolate: false`), and another file's "main" declares other index keys.
beforeAll(() => {
  tableIndexes.set("main", {
    gsi1: { pk: "gsi1pk", sk: "gsi1sk" },
    gsi2: { pk: "gsi2pk", sk: "gsi2sk" },
  })
})
afterAll(() => {
  tableIndexes.delete("main")
})

const Text = Schema.Struct({ text: Schema.String })

class Doc extends Schema.Class<Doc>("Doc")({
  docId: Schema.String,
  owner: Schema.String,
  title: Schema.String,
  body: Schema.optional(Text),
  scan: Schema.optional(Schema.Uint8Array),
  meta: Schema.optional(Schema.Struct({ n: Schema.Number })),
}) {}

/** `{"text":"…"}` is 11 bytes plus the text. */
const text = (jsonBytes: number, fill = "x") => ({ text: fill.repeat(jsonBytes - 11) })
const pdfBytes = (n: number, fill = 7) => new Uint8Array(n).fill(fill)

const docKey = {
  pk: { field: "pk", composite: ["docId"] },
  sk: { field: "sk", composite: [] },
} as const

const byOwner = {
  collection: "OwnerItems",
  name: "gsi1",
  pk: { field: "gsi1pk", composite: ["owner"] },
  sk: { field: "gsi1sk", composite: ["docId"] },
} as const

/** body: overflow past 64 bytes; scan: always external; meta: packed JSON. */
const docModel = DynamoModel.configure(Doc, {
  body: { storedAs: DynamoModel.Packed({ format: "json", external: { threshold: 64 } }) },
  scan: { storedAs: DynamoModel.External({ contentType: "application/pdf" }) },
  meta: { storedAs: DynamoModel.Packed({ format: "json" }) },
})

const Docs = withOffloadGate(() =>
  Entity.make({ model: docModel, entityType: "Doc", primaryKey: docKey, indexes: { byOwner } }),
)

class Note extends Schema.Class<Note>("Note")({
  noteId: Schema.String,
  owner: Schema.String,
  note: Schema.String,
}) {}

/** A collection member that offloads nothing. */
const Notes = Entity.make({
  model: Note,
  entityType: "Note",
  primaryKey: { pk: { field: "pk", composite: ["noteId"] }, sk: { field: "sk", composite: [] } },
  indexes: {
    byOwner: {
      collection: "OwnerItems",
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["owner"] },
      sk: { field: "gsi1sk", composite: ["noteId"] },
    },
  },
})

/** Version snapshots and tombstones. */
const Kept = withOffloadGate(() =>
  Entity.make({
    model: docModel,
    entityType: "Kept",
    primaryKey: docKey,
    versioned: { retain: true },
    softDelete: true,
  }),
)

/** A pure definition, from the AWS-free package. */
const PureDocs = withOffloadGate(() =>
  SchemaEntity.make({ model: docModel, entityType: "PureDoc", primaryKey: docKey }),
)

class Tally extends Schema.Class<Tally>("Tally")({
  tallyId: Schema.String,
  owner: Schema.String,
  seq: Schema.Number,
  body: Schema.optional(Text),
  scan: Schema.optional(Schema.Uint8Array),
}) {}

/**
 * Unversioned, with a numeric index composite and soft delete: an `add` to
 * `seq` reads the item, then writes guarded on what it read, and a delete
 * reads it, then tombstones it in a transaction guarded the same way — both
 * fail with `ConcurrentModification` carrying the stored item.
 */
const tallyConfig = {
  entityType: "Tally",
  primaryKey: { pk: { field: "pk", composite: ["tallyId"] }, sk: { field: "sk", composite: [] } },
  indexes: {
    bySeq: {
      name: "gsi2",
      pk: { field: "gsi2pk", composite: ["owner"] },
      sk: { field: "gsi2sk", composite: ["seq"] },
    },
  },
  softDelete: true,
} as const

const Tallies = withOffloadGate(() =>
  Entity.make({
    ...tallyConfig,
    model: DynamoModel.configure(Tally, {
      body: { storedAs: DynamoModel.Packed({ format: "json", external: { threshold: 64 } }) },
      scan: { storedAs: DynamoModel.External({ contentType: "application/pdf" }) },
    }),
  }),
)

const MainTable = Table.make({
  schema: AppSchema,
  entities: { Docs, Notes, Kept, PureDocs, Tallies },
})

/**
 * The same items as `Docs`, read by a member that no longer offloads (§4.7):
 * its own table definition over the same physical table.
 */
const Legacy = Entity.make({
  model: DynamoModel.configure(Doc, {
    body: { storedAs: DynamoModel.Packed({ format: "json" }) },
    meta: { storedAs: DynamoModel.Packed({ format: "json" }) },
  }),
  entityType: "Doc",
  primaryKey: docKey,
})
/** The same Tally items, read by a member that no longer offloads (§4.7). */
const LegacyTallies = Entity.make({
  ...tallyConfig,
  model: DynamoModel.configure(Tally, {
    body: { storedAs: DynamoModel.Packed({ format: "json" }) },
  }),
})
const LegacyTable = Table.make({ schema: AppSchema, entities: { Legacy, LegacyTallies } })

class Card extends Schema.Class<Card>("Card")({
  cardId: Schema.String,
  title: Schema.String,
  body: Schema.optional(Text),
  scan: Schema.optional(Schema.Uint8Array),
}) {}

/** Vector search over an offloading member: the vector source is an inline field. */
const Cards = withOffloadGate(() =>
  Entity.make({
    model: DynamoModel.configure(Card, {
      body: { storedAs: DynamoModel.Packed({ format: "json", external: { threshold: 64 } }) },
      scan: { storedAs: DynamoModel.External() },
    }),
    entityType: "Card",
    primaryKey: { pk: { field: "pk", composite: ["cardId"] }, sk: { field: "sk", composite: [] } },
    vectorIndexes: {
      byTitle: { name: "vec1", dimensions: 2, distance: "cosine", source: { fields: ["title"] } },
    },
  }),
)
class Brief extends Schema.Class<Brief>("Brief")({
  briefId: Schema.String,
  title: Schema.String,
  body: Schema.optional(Text),
  scan: Schema.optional(Schema.Uint8Array),
}) {}

const briefModel = DynamoModel.configure(Brief, {
  body: { storedAs: DynamoModel.Packed({ format: "json", external: { threshold: 64 } }) },
  scan: { storedAs: DynamoModel.External() },
})
const briefKey = {
  pk: { field: "pk", composite: ["briefId"] },
  sk: { field: "sk", composite: [] },
} as const
/** The text a brief embeds: its title and its (offloaded) body — model-typed fields (#171). */
const briefSource = {
  fields: ["title", "body"] as const,
  compose: (picked: Record<string, unknown>) =>
    `${String(picked.title ?? "")} ${(picked.body as { readonly text?: string } | undefined)?.text ?? ""}`,
}

/** Vector search over an offloading member whose embedding source is offloaded. */
const Briefs = withOffloadGate(() =>
  Entity.make({
    model: briefModel,
    entityType: "Brief",
    primaryKey: briefKey,
    vectorIndexes: {
      byText: { name: "vec2", dimensions: 2, distance: "cosine", source: briefSource },
    },
  }),
)
/** `Briefs` with retained versions: an update takes the read-merge (retain) path. */
const RetainedBriefs = withOffloadGate(() =>
  Entity.make({
    model: briefModel,
    entityType: "RetainedBrief",
    primaryKey: briefKey,
    versioned: { retain: true },
    vectorIndexes: {
      byText: { name: "vec3", dimensions: 2, distance: "cosine", source: briefSource },
    },
  }),
)
const CardTable = Table.make({ schema: AppSchema, entities: { Cards, Briefs, RetainedBriefs } })

// ---------------------------------------------------------------------------
// The client: the in-memory tables, plus the reads they lack
// ---------------------------------------------------------------------------

interface Sent {
  readonly command: string
  readonly input: any
}
const sent: Array<Sent> = []

/** Keep the top-level attributes a `ProjectionExpression` names. */
const project = (
  item: Item,
  expression: string | undefined,
  names: Record<string, string> | undefined,
): Item => {
  if (expression === undefined) return item
  const out: Item = {}
  for (const token of expression.split(",").map((t) => t.trim())) {
    const name = token.startsWith("#") ? names![token]! : token
    if (item[name] !== undefined) out[name] = item[name]!
  }
  return out
}

/**
 * The in-memory tables with projections applied, and the reads they do not
 * serve (`Scan`, `BatchGetItem`, `TransactGetItems`) answered from the same
 * rows. A conditional write's refusal carries the stored item when it asked
 * for `ALL_OLD`, as DynamoDB's does.
 */
const ReadClient = Layer.effect(
  DynamoClient,
  Effect.map(Effect.service(DynamoClient), (inner): DynamoClientService => {
    const call = (method: string, input: unknown) =>
      (inner as unknown as Record<string, (i: unknown) => Effect.Effect<any, any>>)[method]!(input)
    const withOld = (command: string, input: any) => {
      const key = input.Key ?? input.Item
      const old = key === undefined ? undefined : rows.get(keyOf(input.TableName, key))
      return Effect.mapError((error: any) => {
        const cause = error?.cause
        if (
          cause?.name === "ConditionalCheckFailedException" &&
          input.ReturnValuesOnConditionCheckFailure === "ALL_OLD" &&
          old !== undefined
        ) {
          Object.assign(cause, { Item: old, $metadata: { attempts: 1 } })
        }
        void command
        return error
      })
    }
    const live = (table: string, key: Item) => rows.get(keyOf(table, key))
    return {
      ...inner,
      query: (input) =>
        Effect.suspend(() => {
          sent.push({ command: "Query", input })
          return Effect.map(call("query", input), (output) => ({
            ...output,
            Items: (output.Items as Array<Item>).map((item) =>
              project(item, input.ProjectionExpression, input.ExpressionAttributeNames),
            ),
          }))
        }),
      getItem: (input) =>
        Effect.suspend(() => {
          sent.push({ command: "GetItem", input })
          return Effect.map(call("getItem", input), (output) =>
            output.Item === undefined
              ? output
              : {
                  ...output,
                  Item: project(
                    output.Item,
                    input.ProjectionExpression,
                    input.ExpressionAttributeNames,
                  ),
                },
          )
        }),
      putItem: (input) =>
        Effect.suspend(() => {
          sent.push({ command: "PutItem", input })
          return call("putItem", input).pipe(withOld("PutItem", input))
        }),
      updateItem: (input) =>
        Effect.suspend(() => {
          sent.push({ command: "UpdateItem", input })
          return call("updateItem", input).pipe(withOld("UpdateItem", input))
        }),
      deleteItem: (input) =>
        Effect.suspend(() => {
          sent.push({ command: "DeleteItem", input })
          return call("deleteItem", input).pipe(withOld("DeleteItem", input))
        }),
      transactWriteItems: (input) =>
        Effect.suspend(() => {
          sent.push({ command: "TransactWriteItems", input })
          // Each item asking for ALL_OLD: its stored item, as before the write.
          const olds = (input.TransactItems ?? []).map((entry) => {
            const target = entry.Put ?? entry.Update ?? entry.Delete ?? entry.ConditionCheck
            if (target?.ReturnValuesOnConditionCheckFailure !== "ALL_OLD") return undefined
            const key = entry.Put?.Item ?? (target as { readonly Key?: Item }).Key
            return key === undefined ? undefined : rows.get(keyOf(target.TableName!, key))
          })
          return call("transactWriteItems", input).pipe(
            Effect.mapError((error: any) => {
              const reasons = error?.cause?.CancellationReasons as
                | Array<{ Code?: string; Item?: Item }>
                | undefined
              reasons?.forEach((reason, i) => {
                if (reason.Code === "ConditionalCheckFailed" && olds[i] !== undefined) {
                  reason.Item = olds[i]
                }
              })
              if (reasons !== undefined) Object.assign(error.cause, { $metadata: { attempts: 1 } })
              return error
            }),
          )
        }),
      scan: (input) =>
        Effect.sync(() => {
          sent.push({ command: "Scan", input })
          const names = input.ExpressionAttributeNames ?? {}
          const values = input.ExpressionAttributeValues ?? {}
          const items = [...rows.entries()]
            .filter(([key]) => key.startsWith(`${input.TableName}|`))
            .map(([, item]) => item)
            .filter((item) => holds(input.FilterExpression, item, names, values))
            .map((item) => project(item, input.ProjectionExpression, names))
          return { Items: items } as never
        }),
      batchGetItem: (input) =>
        Effect.sync(() => {
          sent.push({ command: "BatchGetItem", input })
          const Responses: Record<string, Array<Item>> = {}
          for (const [table, request] of Object.entries(input.RequestItems ?? {})) {
            Responses[table] = (request.Keys ?? []).flatMap((key) => {
              const item = live(table, key)
              return item === undefined
                ? []
                : [project(item, request.ProjectionExpression, request.ExpressionAttributeNames)]
            })
          }
          return { Responses } as never
        }),
      transactGetItems: (input) =>
        Effect.sync(() => {
          sent.push({ command: "TransactGetItems", input })
          return {
            Responses: (input.TransactItems ?? []).map((entry) => {
              const get = entry.Get!
              const item = live(get.TableName!, get.Key!)
              return item === undefined
                ? {}
                : { Item: project(item, get.ProjectionExpression, get.ExpressionAttributeNames) }
            }),
          } as never
        }),
    }
  }),
).pipe(Layer.provide(InMemoryClient))

let blobs: MemoryBlobStore = BlobStore.memory()

const tableLayer = MainTable.layer({ name: "main" })
const legacyLayer = LegacyTable.layer({ name: "main" })

/** The client, the table and a fresh in-memory store (`blobs`). */
const withStore = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.suspend(() =>
    effect.pipe(Effect.provide(Layer.mergeAll(ReadClient, tableLayer, BlobStore.layer(blobs)))),
  )
/** The client and the table, no store. */
const withoutStore = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(Layer.mergeAll(ReadClient, tableLayer)))

beforeEach(() => {
  resetStore()
  sent.length = 0
  blobs = BlobStore.memory()
})

const client = DynamoClient.make({
  entities: { Docs, Notes, Kept, PureDocs, Tallies },
  tables: { MainTable },
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const gets = () => blobs.inspect().calls.get

/** The live row of an entity type by its id. */
const live = (entityType: string, docId: string): Item => {
  const row = [...rows.values()].find(
    (item) =>
      item.__edd_e__?.S === entityType &&
      item.docId?.S === docId &&
      !/#(v|deleted)#/.test(item.sk?.S ?? ""),
  )
  if (row === undefined) throw new Error(`no live ${entityType} row ${docId}`)
  return row
}

/** Replace attributes of a stored row in place. */
const rewrite = (row: Item, attributes: Record<string, AttributeValue>) => {
  rows.set(keyOf("main", row), { ...row, ...attributes })
}

const pointerOf = (value: AttributeValue | undefined): BlobPointer.BlobPointer => {
  const pointer =
    value?.B !== undefined ? BlobPointer.decode(value.B) : BlobPointer.decodeText(value!.S!)
  if (pointer === undefined || typeof pointer === "string") throw new Error(String(pointer))
  return pointer
}

/** `pointer` claiming another checksum: its object no longer verifies. */
const withWrongChecksum = (pointer: BlobPointer.BlobPointer): BlobPointer.BlobPointer => {
  const made = BlobPointer.make({
    kind: pointer.kind,
    codec: pointer.codec,
    ref: pointer.ref,
    objectSize: pointer.objectSize,
    contentSize: pointer.contentSize,
    checksum: {
      algorithm: pointer.checksum.algorithm,
      value: pointer.checksum.value.map((byte) => byte ^ 0xff),
    },
    contentType: pointer.contentType,
  })
  if (typeof made === "string") throw new Error(made)
  return made
}

const asHandle = (u: unknown): Offload.BlobHandle => {
  expect(Offload.isBlobHandle(u)).toBe(true)
  return u as Offload.BlobHandle
}
const asValue = (u: unknown): Offload.OffloadedValue<unknown> => {
  expect(Offload.isOffloadedValue(u)).toBe(true)
  return u as Offload.OffloadedValue<unknown>
}

const BODY = text(200)
const SCAN = pdfBytes(300)

/** Doc `docId` with an external body and scan, and an inline packed meta. */
const putDoc = (docId: string, owner = "o-1") =>
  Effect.gen(function* () {
    const db = yield* client
    yield* db.entities.Docs.put({
      docId,
      owner,
      title: `title ${docId}`,
      body: BODY,
      scan: SCAN,
      meta: { n: 1 },
    })
  })

// ---------------------------------------------------------------------------
// get and the read modes
// ---------------------------------------------------------------------------

describe("Entity offload reads — get and the read modes", () => {
  it.effect("reads overflow eagerly and binary as a lazy handle by default", () =>
    withStore(
      Effect.gen(function* () {
        const db = yield* client
        yield* putDoc("d-1")
        const before = gets()
        const doc = yield* db.entities.Docs.get({ docId: "d-1" })
        expect(doc.body).toEqual(BODY)
        expect(doc.meta).toEqual({ n: 1 })
        // Only the overflow value was fetched.
        expect(gets()).toBe(before + 1)
        const scan = asHandle(doc.scan)
        expect(scan.location).toBe("external")
        expect(scan.contentType).toBe("application/pdf")
        expect(scan.size).toBe(SCAN.length)
        expect(Option.getOrThrow(scan.ref)).toEqual(pointerOf(live("Doc", "d-1").scan).ref)
        expect(yield* scan.read()).toEqual(SCAN)
        expect(gets()).toBe(before + 2)
        // A ranged read is served by the store.
        expect(yield* scan.read({ range: { offset: 0, length: 10 } })).toEqual(SCAN.slice(0, 10))
      }),
    ),
  )

  it.effect(".offloaded() sets both kinds, or the kinds it names over the current modes", () =>
    withStore(
      Effect.gen(function* () {
        const db = yield* client
        yield* putDoc("d-1")
        const key = { docId: "d-1" }

        let before = gets()
        const eager = yield* db.entities.Docs.get(key).offloaded("eager")
        expect(eager.body).toEqual(BODY)
        expect(eager.scan).toEqual(SCAN)
        expect(gets()).toBe(before + 2)

        before = gets()
        const lazy = yield* db.entities.Docs.get(key).offloaded("lazy")
        expect(gets()).toBe(before)
        const body = asValue(lazy.body)
        expect(body.location).toBe("external")
        expect(yield* body.read()).toEqual(BODY)
        expect(gets()).toBe(before + 1)
        asHandle(lazy.scan)

        before = gets()
        const binaryEager = yield* db.entities.Docs.get(key).offloaded({ binary: "eager" })
        expect(binaryEager.body).toEqual(BODY)
        expect(binaryEager.scan).toEqual(SCAN)
        expect(gets()).toBe(before + 2)

        // Each call resolves over the builder's modes so far.
        before = gets()
        const mixed = yield* db.entities.Docs.get(key)
          .offloaded("lazy")
          .offloaded({ overflow: "eager" })
        expect(mixed.body).toEqual(BODY)
        asHandle(mixed.scan)
        expect(gets()).toBe(before + 1)
      }),
    ),
  )

  it.effect("an inline value read lazily needs no store I/O", () =>
    withStore(
      Effect.gen(function* () {
        const db = yield* client
        yield* db.entities.Docs.put({ docId: "d-2", owner: "o-1", title: "t", body: text(30) })
        // A native binary value, stored before the field was External.
        rewrite(live("Doc", "d-2"), { scan: { B: pdfBytes(5, 3) } })
        const before = gets()
        const doc = yield* db.entities.Docs.get({ docId: "d-2" }).offloaded("lazy")
        const body = asValue(doc.body)
        expect(body.location).toBe("inline")
        expect(Option.isNone(body.ref)).toBe(true)
        expect(yield* body.read()).toEqual(text(30))
        const scan = asHandle(doc.scan)
        expect(scan.location).toBe("inline")
        expect(scan.contentType).toBe("application/pdf")
        expect(yield* scan.read()).toEqual(pdfBytes(5, 3))
        expect(gets()).toBe(before)
        // Read eagerly, an inline value is just the value.
        const eager = yield* db.entities.Docs.get({ docId: "d-2" }).offloaded("eager")
        expect(eager).toMatchObject({ body: text(30), scan: pdfBytes(5, 3) })
        expect(gets()).toBe(before)
      }),
    ),
  )

  it.effect("asNative returns the stored pointers; asRecord reads per Entity.offloaded", () =>
    withStore(
      Effect.gen(function* () {
        yield* putDoc("d-1")
        const key = { docId: "d-1" }
        const before = gets()
        const native = (yield* Entity.asNative(Docs.get(key))) as unknown as Item
        expect(BlobPointer.isPointerHeader(native.body!.B![0]!)).toBe(true)
        expect(BlobPointer.isPointerText(native.scan!.S!)).toBe(true)
        expect(gets()).toBe(before)

        // Data-first.
        const lazy = yield* Entity.asRecord(Entity.offloaded(Docs.get(key), "lazy"))
        asValue(lazy.body)
        asHandle(lazy.scan)
        expect(gets()).toBe(before)
        // Data-last.
        const eager = yield* Docs.get(key).pipe(Entity.offloaded("eager"), Entity.asRecord)
        expect(eager.body).toEqual(BODY)
        expect(eager.scan).toEqual(SCAN)
        expect(gets()).toBe(before + 2)
        // The unbound default: binary lazy.
        const record = yield* Entity.asRecord(Docs.get(key))
        expect(record.body).toEqual(BODY)
        asHandle(record.scan)
      }),
    ),
  )

  it.effect("checksum mismatches and missing objects fail eager reads and lazy reads", () =>
    withStore(
      Effect.gen(function* () {
        const db = yield* client
        yield* putDoc("d-1")
        const row = live("Doc", "d-1")
        const body = pointerOf(row.body)
        rewrite(row, {
          body: { B: BlobPointer.encode(withWrongChecksum(body)) },
          scan: { S: BlobPointer.encodeText(withWrongChecksum(pointerOf(row.scan))) },
        })
        const eager = yield* Effect.flip(db.entities.Docs.get({ docId: "d-1" }).asEffect())
        expect(eager).toBeInstanceOf(BlobStoreError)
        expect(eager).toMatchObject({
          reason: "ChecksumMismatch",
          attribute: "body",
          entityType: "Doc",
          ref: body.ref,
        })
        // Lazy: the read succeeds, the value's own read fails.
        const lazy = yield* db.entities.Docs.get({ docId: "d-1" }).offloaded("lazy")
        const failed = yield* Effect.flip(asHandle(lazy.scan).read())
        expect(failed).toMatchObject({ reason: "ChecksumMismatch", attribute: "scan" })

        // A deleted version: NotFound.
        yield* putDoc("d-2")
        const gone = pointerOf(live("Doc", "d-2").body).ref
        yield* blobs.delete([gone])
        const missing = yield* Effect.flip(db.entities.Docs.get({ docId: "d-2" }).asEffect())
        expect(missing).toMatchObject({ reason: "NotFound", attribute: "body", ref: gone })
      }),
    ),
  )

  it.effect("a lazy value read with no store in context fails with NotProvided", () =>
    Effect.gen(function* () {
      yield* withStore(putDoc("d-1"))
      const doc = yield* withoutStore(
        Effect.gen(function* () {
          return yield* Docs.get({ docId: "d-1" }).pipe(Entity.offloaded("lazy"), Entity.asModel)
        }),
      )
      const failed = yield* Effect.flip(asValue(doc.body).read())
      expect(failed).toMatchObject({ _tag: "BlobStoreError", reason: "NotProvided" })
      // Eager with no store: the read itself fails.
      const eager = yield* withoutStore(Effect.flip(Docs.get({ docId: "d-1" }).asEffect()))
      expect(eager).toMatchObject({ _tag: "BlobStoreError", reason: "NotProvided" })
    }),
  )

  it.effect("an unknown mode throws EDD-9117", () =>
    withStore(
      Effect.gen(function* () {
        const db = yield* client
        const get = db.entities.Docs.get({ docId: "d-1" })
        expect(() => get.offloaded("sometimes" as never)).toThrow(/\[EDD-9117\]/)
        expect(() => get.offloaded({ overflow: "eager", other: "lazy" } as never)).toThrow(
          /\[EDD-9117\]/,
        )
        expect(() => Docs.get({ docId: "d-1" }).pipe(Entity.offloaded(1 as never))).toThrow(
          /\[EDD-9117\]/,
        )
        expect(() => db.entities.Docs.scan().offloaded({ binary: "never" } as never)).toThrow(
          /\[EDD-9117\]/,
        )
      }),
    ),
  )
})

// ---------------------------------------------------------------------------
// Queries, scans, projections
// ---------------------------------------------------------------------------

describe("Entity offload reads — queries, scans and projections", () => {
  it.effect("index queries and scans read per mode", () =>
    withStore(
      Effect.gen(function* () {
        const db = yield* client
        yield* putDoc("d-1")
        yield* putDoc("d-2")
        let before = gets()
        const queried = yield* db.entities.Docs.byOwner({ owner: "o-1" }).collect()
        expect(queried).toHaveLength(2)
        for (const doc of queried) {
          expect(doc.body).toEqual(BODY)
          asHandle(doc.scan)
        }
        expect(gets()).toBe(before + 2)

        before = gets()
        const lazy = yield* db.entities.Docs.byOwner({ owner: "o-1" }).offloaded("lazy").collect()
        for (const doc of lazy) asValue(doc.body)
        expect(gets()).toBe(before)

        before = gets()
        const scanned = yield* db.entities.Docs.scan().offloaded("eager").collect()
        expect(scanned).toHaveLength(2)
        for (const doc of scanned) expect(doc.scan).toEqual(SCAN)
        expect(gets()).toBe(before + 4)

        // Unbound, through Query.offloaded (data-last and data-first).
        before = gets()
        const unbound = yield* Docs.query
          .byOwner({ owner: "o-1" })
          .pipe(Query.offloaded("lazy"), Query.collect)
        for (const doc of unbound) asHandle(doc.scan)
        const scannedLazy = yield* Query.collect(Query.offloaded(Docs.scan(), "lazy"))
        expect(scannedLazy).toHaveLength(2)
        expect(gets()).toBe(before)
      }),
    ),
  )

  it.effect("a projection omitting an offloaded field fetches nothing; naming it resolves", () =>
    withStore(
      Effect.gen(function* () {
        const db = yield* client
        yield* putDoc("d-1")
        yield* putDoc("d-2")
        let before = gets()
        const titles = yield* db.entities.Docs.byOwner({ owner: "o-1" }).select(["title"]).collect()
        expect(titles).toEqual(
          expect.arrayContaining([{ title: "title d-1" }, { title: "title d-2" }]),
        )
        expect(gets()).toBe(before)

        before = gets()
        const named = yield* db.entities.Docs.byOwner({ owner: "o-1" })
          .select(["title", "body"])
          .collect()
        for (const row of named) expect(row.body).toEqual(BODY)
        expect(gets()).toBe(before + 2)

        // Lazy: a handle on the wire form.
        before = gets()
        const lazy = yield* db.entities.Docs.byOwner({ owner: "o-1" })
          .offloaded("lazy")
          .select(["body", "scan"])
          .collect()
        expect(gets()).toBe(before)
        expect(yield* asValue(lazy[0]!.body).read()).toEqual(BODY)
        asHandle(lazy[0]!.scan)

        // An unbound get projection reads the same way.
        before = gets()
        const projected = yield* Docs.get({ docId: "d-1" }).pipe(
          Entity.project(["title", "body"]),
          Entity.asRecord,
        )
        expect((projected as { readonly body?: unknown }).body).toEqual(BODY)
        expect(gets()).toBe(before + 1)
      }),
    ),
  )

  it.effect("rows past limit are never fetched; filterBy under lazy fetches nothing", () =>
    withStore(
      Effect.gen(function* () {
        const db = yield* client
        for (const id of ["d-1", "d-2", "d-3", "d-4"]) yield* putDoc(id)
        // Under a filter the request examines more rows than `limit` (#171
        // sizes it from the pass rate): every row comes back, and only the
        // window `limit` can still take is loaded.
        let before = gets()
        const two = yield* db.entities.Docs.byOwner({ owner: "o-1" })
          .filter({ owner: "o-1" })
          .limit(2)
          .collect()
        expect(two).toHaveLength(2)
        expect(lastQuery().Limit).toBeGreaterThanOrEqual(4)
        expect(gets()).toBe(before + 2)

        before = gets()
        const page = yield* db.entities.Docs.byOwner({ owner: "o-1" })
          .filter({ owner: "o-1" })
          .limit(1)
          .fetch()
        expect(page.items).toHaveLength(1)
        expect(gets()).toBe(before + 1)

        // filterBy examines every row; lazily, it downloads nothing.
        before = gets()
        const filtered = yield* db.entities.Docs.byOwner({ owner: "o-1" })
          .offloaded("lazy")
          .filterBy((doc) => doc.title !== "title d-2")
          .collect()
        expect(filtered).toHaveLength(3)
        expect(gets()).toBe(before)
        // Eagerly, it fetches every row it examines.
        const counted = yield* db.entities.Docs.byOwner({ owner: "o-1" })
          .filterBy((doc) => doc.body?.text.startsWith("x") === true)
          .count()
        expect(counted).toBe(4)
        expect(gets()).toBe(before + 4)
      }),
    ),
  )

  it.effect("rows a scan drops by their raw form never widen the loaded window", () =>
    withStore(
      Effect.gen(function* () {
        const db = yield* client
        for (const docId of ["k-1", "k-2", "k-3"]) {
          yield* db.entities.Kept.put({ docId, owner: "o", title: "v1", body: BODY })
          yield* db.entities.Kept.update({ docId }).set({ title: "v2" })
        }
        // One response holds every row: three live rows and their version
        // snapshots (history rows, dropped by their raw form before they are
        // loaded). Only the live row `limit` takes is fetched — the surplus
        // live rows past it never are.
        const before = gets()
        const one = yield* db.entities.Kept.scan().pageSize(100).limit(1).collect()
        expect(one).toHaveLength(1)
        expect(one[0]!.body).toEqual(BODY)
        expect(gets()).toBe(before + 1)
      }),
    ),
  )

  it.effect(".offloaded() after filterBy throws EDD-9117", () =>
    withStore(
      Effect.gen(function* () {
        const db = yield* client
        const filtered = db.entities.Docs.byOwner({ owner: "o-1" }).filterBy(() => true)
        expect(() => filtered.offloaded("lazy")).toThrow(/\[EDD-9117\].*filterBy/)
        expect(() =>
          Docs.query.byOwner({ owner: "o-1" }).pipe(
            Query.filterBy(() => true),
            Query.offloaded("eager"),
          ),
        ).toThrow(/\[EDD-9117\]/)
      }),
    ),
  )

  it.effect("paginate streams pages, each resolved together", () =>
    withStore(
      Effect.gen(function* () {
        const db = yield* client
        for (const id of ["d-1", "d-2", "d-3"]) yield* putDoc(id)
        const before = gets()
        const all = yield* Stream.runCollect(
          db.entities.Docs.byOwner({ owner: "o-1" }).offloaded({ binary: "eager" }).paginate(),
        )
        expect(all).toHaveLength(3)
        for (const doc of all) expect(doc.scan).toEqual(SCAN)
        expect(gets()).toBe(before + 6)
      }),
    ),
  )
})

const lastQuery = () => sent.filter((s) => s.command === "Query").at(-1)!.input

// ---------------------------------------------------------------------------
// Batch, transactions, collections
// ---------------------------------------------------------------------------

describe("Entity offload reads — Batch.get, transactGet and collections", () => {
  it.effect("Batch.get and transactGet read each get in its own modes", () =>
    withStore(
      Effect.gen(function* () {
        const db = yield* client
        yield* putDoc("d-1")
        yield* putDoc("d-2")
        let before = gets()
        const [first, second, absent] = yield* Batch.get([
          db.entities.Docs.get({ docId: "d-1" }),
          db.entities.Docs.get({ docId: "d-2" }).offloaded("lazy"),
          db.entities.Docs.get({ docId: "d-9" }),
        ])
        expect(first!.body).toEqual(BODY)
        asHandle(first!.scan)
        asValue(second!.body)
        asHandle(second!.scan)
        expect(absent).toBeUndefined()
        expect(gets()).toBe(before + 1)

        before = gets()
        const [eager, unbound] = yield* Transaction.transactGet([
          db.entities.Docs.get({ docId: "d-1" }).offloaded("eager"),
          Docs.get({ docId: "d-2" }),
        ])
        expect(eager!.scan).toEqual(SCAN)
        expect(unbound!.body).toEqual(BODY)
        asHandle(unbound!.scan)
        expect(gets()).toBe(before + 3)
      }),
    ),
  )

  it.effect("Batch.get groups gets by their modes' value, within the store's readConcurrency", () =>
    Effect.gen(function* () {
      // Every GET pauses so concurrent reads overlap; the peak is what was in flight.
      let inFlight = 0
      let peak = 0
      blobs = BlobStore.memory({
        readConcurrency: 2,
        failures: (call) =>
          call.action !== "get"
            ? undefined
            : Effect.gen(function* () {
                inFlight++
                peak = Math.max(peak, inFlight)
                yield* Effect.yieldNow
                yield* Effect.yieldNow
                inFlight--
                return undefined
              }),
      })
      yield* withStore(
        Effect.gen(function* () {
          const db = yield* client
          const ids = ["d-1", "d-2", "d-3", "d-4", "d-5"]
          for (const id of ids) yield* putDoc(id)
          peak = 0
          const before = gets()
          // Each object-form mode is its own value-equal `Modes`: one group.
          const docs = yield* Batch.get(
            ids.map((docId) => db.entities.Docs.get({ docId }).offloaded({ binary: "eager" })),
          )
          for (const doc of docs) {
            expect(doc!.body).toEqual(BODY)
            expect(doc!.scan).toEqual(SCAN)
          }
          expect(gets()).toBe(before + 10)
          expect(peak).toBe(2)
        }),
      )
    }),
  )

  it.effect("collections read their offloading members per mode", () =>
    withStore(
      Effect.gen(function* () {
        const db = yield* client
        yield* putDoc("d-1")
        yield* db.entities.Notes.put({ noteId: "n-1", owner: "o-1", note: "hello" })
        let before = gets()
        const grouped = (yield* db.collections.OwnerItems!({ owner: "o-1" }).collect()) as {
          readonly Docs: ReadonlyArray<{ readonly body?: unknown; readonly scan?: unknown }>
          readonly Notes: ReadonlyArray<Note>
        }
        expect(grouped.Docs[0]!.body).toEqual(BODY)
        asHandle(grouped.Docs[0]!.scan)
        expect(grouped.Notes[0]!.note).toBe("hello")
        expect(gets()).toBe(before + 1)

        before = gets()
        const lazy = (yield* db.collections.OwnerItems!({ owner: "o-1" })
          .offloaded("lazy")
          .collect()) as typeof grouped
        asValue(lazy.Docs[0]!.body)
        expect(lazy.Notes[0]!.note).toBe("hello")
        expect(gets()).toBe(before)

        // A projection omitting the offloaded fields fetches nothing.
        const titles = yield* db.collections.OwnerItems!({ owner: "o-1" })
          .select(["title", "note"])
          .collect()
        expect(titles).toBeDefined()
        expect(gets()).toBe(before)
      }),
    ),
  )

  it.effect("explicit collections tag each item with its member and read per mode", () =>
    withStore(
      Effect.gen(function* () {
        const db = yield* client
        yield* putDoc("d-1")
        yield* db.entities.Notes.put({ noteId: "n-1", owner: "o-1", note: "hello" })
        const C = Collection.make("OwnerItems", { Docs, Notes })

        let before = gets()
        const items = yield* Query.collect(C.query({ owner: "o-1" }))
        const doc = items.find((item) => item._entityKey === "Docs")
        const note = items.find((item) => item._entityKey === "Notes")
        expect(doc?._entityType).toBe("Doc")
        expect(note?._entityType).toBe("Note")
        if (doc?._entityKey !== "Docs" || note?._entityKey !== "Notes") throw new Error("members")
        expect(doc._decoded.body).toEqual(BODY)
        asHandle(doc._decoded.scan)
        expect(note._decoded.note).toBe("hello")
        expect(gets()).toBe(before + 1)

        before = gets()
        const lazy = yield* Query.collect(Query.offloaded(C.query({ owner: "o-1" }), "lazy"))
        const lazyDoc = lazy.find((item) => item._entityKey === "Docs")
        if (lazyDoc?._entityKey !== "Docs") throw new Error("Docs")
        expect(yield* asValue(lazyDoc._decoded.body).read()).toEqual(BODY)
        expect(gets()).toBe(before + 1)

        // A member selector reads in its own modes.
        before = gets()
        const [eager] = yield* C.Docs({ owner: "o-1" }).pipe(
          Query.offloaded({ binary: "eager" }),
          Query.collect,
        )
        expect(eager!.body).toEqual(BODY)
        expect(eager!.scan).toEqual(SCAN)
        expect(gets()).toBe(before + 2)
      }),
    ),
  )
})

// ---------------------------------------------------------------------------
// Lifecycle reads and write results
// ---------------------------------------------------------------------------

describe("Entity offload reads — lifecycle reads and write results", () => {
  it.effect("versions, getVersion, deleted.get, deleted.list and restore", () =>
    withStore(
      Effect.gen(function* () {
        const db = yield* client
        const key = { docId: "k-1" }
        yield* db.entities.Kept.put({ ...key, owner: "o", title: "v1", body: BODY, scan: SCAN })
        yield* db.entities.Kept.update(key).set({ title: "v2" })

        let before = gets()
        const versions = yield* db.entities.Kept.versions(key).collect()
        // The snapshot the update kept of version 1.
        expect(versions.map((v) => v.title)).toEqual(["v1"])
        for (const v of versions) {
          expect(v.body).toEqual(BODY)
          asHandle(v.scan)
        }
        expect(gets()).toBe(before + 1)
        before = gets()
        const lazyVersions = yield* db.entities.Kept.versions(key).offloaded("lazy").collect()
        for (const v of lazyVersions) asValue(v.body)
        expect(gets()).toBe(before)

        const v1 = yield* db.entities.Kept.getVersion(key, 1)
        expect(v1.title).toBe("v1")
        expect(v1.body).toEqual(BODY)
        asHandle(v1.scan)

        yield* db.entities.Kept.delete(key)
        before = gets()
        const tombstone = yield* db.entities.Kept.deleted.get(key)
        expect(tombstone.body).toEqual(BODY)
        expect(yield* asHandle(tombstone.scan).read()).toEqual(SCAN)
        expect(gets()).toBe(before + 2)
        before = gets()
        const listed = yield* db.entities.Kept.deleted.list(key).offloaded("lazy").collect()
        expect(listed).toHaveLength(1)
        asValue(listed[0]!.body)
        expect(gets()).toBe(before)

        const restored = yield* db.entities.Kept.restore(key)
        expect(restored.body).toEqual(BODY)
        asHandle(restored.scan)
      }),
    ),
  )

  it.effect("write results read in the operation's modes, the lazy binary default first", () =>
    withStore(
      Effect.gen(function* () {
        const db = yield* client
        const put = yield* db.entities.Docs.put({
          docId: "d-1",
          owner: "o",
          title: "t",
          body: BODY,
          scan: SCAN,
        })
        asHandle(put.scan)
        expect(put.body).toEqual(BODY)
        // The operation's own uploads come from its read cache.
        const eager = yield* db.entities.Docs.put({
          docId: "d-2",
          owner: "o",
          title: "t",
          body: BODY,
          scan: SCAN,
        }).offloaded("eager")
        expect(eager.scan).toEqual(SCAN)

        const before = gets()
        const updated = yield* db.entities.Docs.update({ docId: "d-1" })
          .set({ title: "t2" })
          .offloaded("lazy")
        expect(updated.title).toBe("t2")
        asValue(updated.body)
        asHandle(updated.scan)
        const old = yield* db.entities.Docs.update({ docId: "d-1" })
          .set({ title: "t3" })
          .returnValues("allOld")
          .offloaded({ overflow: "lazy" })
        expect(old.title).toBe("t2")
        asValue(old.body)
        const deleted = yield* db.entities.Docs.delete({ docId: "d-2" })
          .returnValues("allOld")
          .offloaded("lazy")
        asValue(deleted!.body)
        expect(gets()).toBe(before)
      }),
    ),
  )
})

// ---------------------------------------------------------------------------
// Pointers on attributes a member does not offload (§4.7)
// ---------------------------------------------------------------------------

describe("Entity offload reads — a member that no longer offloads", () => {
  it.effect("resolves pointers eagerly through the ambient store", () =>
    withStore(
      Effect.gen(function* () {
        yield* putDoc("d-1")
        const before = gets()
        const doc = yield* Legacy.get({ docId: "d-1" }).asEffect().pipe(Effect.provide(legacyLayer))
        expect(doc.body).toEqual(BODY)
        expect(doc.scan).toEqual(SCAN)
        expect(doc.meta).toEqual({ n: 1 })
        expect(gets()).toBe(before + 2)
      }),
    ),
  )

  it.effect("a store failure, or no store, is a ValidationError whose cause it is", () =>
    Effect.gen(function* () {
      yield* withStore(putDoc("d-1"))
      const read = Legacy.get({ docId: "d-1" }).asEffect().pipe(Effect.provide(legacyLayer))
      // No store in context.
      const unprovided = yield* withoutStore(Effect.flip(read))
      expect(unprovided).toBeInstanceOf(ValidationError)
      expect((unprovided as ValidationError).cause).toMatchObject({
        _tag: "BlobStoreError",
        reason: "NotProvided",
      })
      // A version the store no longer holds.
      yield* blobs.delete([pointerOf(live("Doc", "d-1").scan).ref])
      const missing = yield* withStore(Effect.flip(read))
      expect(missing).toBeInstanceOf(ValidationError)
      expect(missing).toMatchObject({ entityType: "Doc" })
      expect((missing as ValidationError).cause).toMatchObject({
        _tag: "BlobStoreError",
        reason: "NotFound",
        attribute: "scan",
      })
    }),
  )
})

// ---------------------------------------------------------------------------
// Error payloads (§6.13): lazy, with no store I/O
// ---------------------------------------------------------------------------

describe("Entity offload reads — error payloads", () => {
  /** The live Tally row by its id. */
  const tallyRow = (tallyId: string): Item => {
    const row = [...rows.values()].find(
      (item) => item.__edd_e__?.S === "Tally" && item.tallyId?.S === tallyId,
    )
    if (row === undefined) throw new Error(`no Tally row ${tallyId}`)
    return row
  }
  /** Another writer changes `seq` between the operation's read and its write. */
  const raceAfterNextRead = (tallyId: string) => {
    hooks.afterGet.push(() => rewrite(tallyRow(tallyId), { seq: { N: "7" } }))
  }
  /** …after every read, so an operation that re-reads to retry loses every time. */
  const raceAfterEveryRead = (tallyId: string) => {
    let seq = 7
    const race = () => {
      rewrite(tallyRow(tallyId), { seq: { N: String(seq++) } })
      hooks.afterGet.push(race)
    }
    hooks.afterGet.push(race)
  }
  const putTally = (tallyId: string) =>
    Effect.gen(function* () {
      const db = yield* client
      yield* db.entities.Tallies.put({ tallyId, owner: "o", seq: 1, body: BODY, scan: SCAN })
    })
  const currentOf = (error: unknown) => {
    expect(error).toBeInstanceOf(ConcurrentModification)
    return (error as ConcurrentModification).current as Option.Option<{
      readonly seq: number
      readonly body?: unknown
      readonly scan?: unknown
    }>
  }

  it.effect("a read-then-write update's ConcurrentModification: current lazy, unfetched", () =>
    withStore(
      Effect.gen(function* () {
        const db = yield* client
        yield* putTally("t-1")
        raceAfterNextRead("t-1")
        const before = gets()
        const error = yield* Effect.flip(
          db.entities.Tallies.update({ tallyId: "t-1" })
            .add({ seq: 1 })
            .offloaded("eager")
            .asEffect(),
        )
        const current = Option.getOrThrow(currentOf(error))
        expect(current.seq).toBe(7)
        // Lazy whatever the operation's modes; nothing fetched.
        const body = asValue(current.body)
        asHandle(current.scan)
        expect(gets()).toBe(before)
        expect(yield* body.read()).toEqual(BODY)
      }),
    ),
  )

  it.effect("a guarded delete's ConcurrentModification: current lazy, unfetched", () =>
    withStore(
      Effect.gen(function* () {
        const db = yield* client
        yield* putTally("t-1")
        // The delete re-reads and retries a lost race: it loses every one.
        raceAfterEveryRead("t-1")
        const before = gets()
        const error = yield* Effect.flip(db.entities.Tallies.delete({ tallyId: "t-1" }).asEffect())
        hooks.afterGet = []
        const current = Option.getOrThrow(currentOf(error))
        expect(current.seq).toBeGreaterThan(1)
        asValue(current.body)
        expect(yield* asHandle(current.scan).read()).toEqual(SCAN)
        expect(gets()).toBe(before + 1)
      }),
    ),
  )

  it.effect("a pointer on an attribute the member no longer offloads: no current", () =>
    withStore(
      Effect.gen(function* () {
        yield* putTally("t-1")
        raceAfterNextRead("t-1")
        const error = yield* Effect.flip(
          LegacyTallies.update({ tallyId: "t-1" })
            .pipe(Entity.add({ seq: 1 }))
            .asEffect()
            .pipe(Effect.provide(legacyLayer)),
        )
        // Resolving the pointer needs a fetch, which an error payload never makes.
        expect(Option.isNone(currentOf(error))).toBe(true)
      }),
    ),
  )
})

// ---------------------------------------------------------------------------
// Vector search hits
// ---------------------------------------------------------------------------

describe("Entity offload reads — vector search hits", () => {
  /** The refs the store served a `get` for, by key, and by key and version. */
  const fetched: Array<string> = []
  const fetchedRefs: Array<string> = []
  const refName = (ref: BlobPointer.BlobRef) => `${ref.key}@${ref.version}`
  const recording = () => {
    fetched.length = 0
    fetchedRefs.length = 0
    blobs = BlobStore.memory({
      failures: (call) => {
        if (call.action === "get" && call.ref !== undefined) {
          fetched.push(call.ref.key)
          fetchedRefs.push(refName(call.ref))
        }
        return undefined
      },
    })
  }
  const withVectors = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.suspend(() =>
      effect.pipe(
        Effect.provide(
          Layer.mergeAll(
            VectorSearchEmulation.layer(ReadClient, { tables: { CardTable } }),
            CardTable.layer({ name: "main" }),
            BlobStore.layer(blobs),
          ),
        ),
      ),
    )
  const vectorClient = DynamoClient.make({
    entities: { Cards, Briefs, RetainedBriefs },
    tables: { CardTable },
    embedder: makeTestEmbedder(2),
  })
  const rowOf = (entityType: string) =>
    [...rows.values()].find((item) => item.__edd_e__?.S === entityType)!
  /** The live row of an entity type: not a retained version snapshot (`…#v#<n>`). */
  const liveOf = (entityType: string) =>
    [...rows.values()].find(
      (item) => item.__edd_e__?.S === entityType && !(item.sk?.S ?? "").includes("#v#"),
    )!
  const versionsOf = (entityType: string) =>
    [...rows.values()].filter(
      (item) => item.__edd_e__?.S === entityType && (item.sk?.S ?? "").includes("#v#"),
    )
  const putCard = (cardId: string) =>
    Effect.gen(function* () {
      const db = yield* vectorClient
      yield* db.entities.Cards.put({ cardId, title: "t", body: BODY, scan: SCAN }).withVector(
        "byTitle",
        [1, 0],
      )
    })

  it.effect("default modes: overflow eager, binary a handle; the hits resolve together", () =>
    withVectors(
      Effect.gen(function* () {
        const db = yield* vectorClient
        yield* putCard("c-1")
        yield* putCard("c-2")
        const before = gets()
        const hits = yield* db.entities.Cards.byTitle([1, 0]).collect()
        expect(hits).toHaveLength(2)
        // Two bodies, fetched once each; no scan.
        expect(gets()).toBe(before + 2)
        for (const hit of hits) {
          expect(hit.item.body).toEqual(BODY)
          expect(yield* asHandle(hit.item.scan).read()).toEqual(SCAN)
        }
      }),
    ),
  )

  it.effect(".offloaded(mode) re-reads the hits eagerly or lazily", () =>
    withVectors(
      Effect.gen(function* () {
        const db = yield* vectorClient
        yield* putCard("c-1")
        let before = gets()
        const [eager] = yield* db.entities.Cards.byTitle([1, 0]).offloaded("eager").collect()
        expect(eager!.item).toMatchObject({ body: BODY, scan: SCAN })
        expect(gets()).toBe(before + 2)

        before = gets()
        const [lazy] = yield* db.entities.Cards.byTitle([1, 0]).offloaded("lazy").collect()
        expect(gets()).toBe(before)
        expect(yield* asValue(lazy!.item.body).read()).toEqual(BODY)
        asHandle(lazy!.item.scan)

        const [mixed] = yield* db.entities.Cards.byTitle([1, 0])
          .offloaded("lazy")
          .offloaded({ binary: "eager" })
          .collect()
        asValue(mixed!.item.body)
        expect(mixed!.item.scan).toEqual(SCAN)
      }),
    ),
  )

  it.effect("a store failure is a typed BlobStoreError, not a ValidationError", () =>
    withVectors(
      Effect.gen(function* () {
        const db = yield* vectorClient
        yield* putCard("c-1")
        yield* blobs.delete([pointerOf(rowOf("Card").body).ref])
        const failed = yield* Effect.flip(db.entities.Cards.byTitle([1, 0]).collect())
        expect(failed).toMatchObject({
          _tag: "BlobStoreError",
          reason: "NotFound",
          entityType: "Card",
          attribute: "body",
        })
        // A lazy read of the same hit succeeds; the failure moves to its read.
        const [lazy] = yield* db.entities.Cards.byTitle([1, 0]).offloaded("lazy").collect()
        const reread = yield* Effect.flip(asValue(lazy!.item.body).read())
        expect(reread).toMatchObject({ _tag: "BlobStoreError", reason: "NotFound" })
      }),
    ),
  )

  it.effect("select: an inline field fetches nothing; an offloaded one reads raw", () =>
    withVectors(
      Effect.gen(function* () {
        const db = yield* vectorClient
        yield* putCard("c-1")
        let before = gets()
        const [titled] = yield* db.entities.Cards.byTitle([1, 0]).select(["title"]).collect()
        expect(titled!.item).toEqual({ title: "t" })
        expect(gets()).toBe(before)

        before = gets()
        const [named] = yield* db.entities.Cards.byTitle([1, 0])
          .select(["title", "body", "scan"])
          .collect()
        // The overflow field's JSON wire form, eagerly; the binary one a handle.
        expect(named!.item.body).toEqual(BODY)
        expect(yield* asHandle(named!.item.scan).read()).toEqual(SCAN)
        expect(gets()).toBe(before + 2)

        before = gets()
        const [lazy] = yield* db.entities.Cards.byTitle([1, 0])
          .offloaded("lazy")
          .select(["body"])
          .collect()
        expect(gets()).toBe(before)
        expect(yield* asValue(lazy!.item.body).read()).toEqual(BODY)
      }),
    ),
  )

  it.effect("reembed reads only an offloaded source field", () => {
    recording()
    return withVectors(
      Effect.gen(function* () {
        const db = yield* vectorClient
        yield* db.entities.Briefs.put({ briefId: "b-1", title: "alpha", body: BODY, scan: SCAN })
        const row = rowOf("Brief")
        fetched.length = 0
        expect(yield* db.entities.Briefs.reembed()).toBe(1)
        expect(fetched).toEqual([pointerOf(row.body).ref.key])
      }),
    )
  })

  it.effect("an update re-embedding from the stored source never fetches a binary field", () => {
    recording()
    return withVectors(
      Effect.gen(function* () {
        const db = yield* vectorClient
        yield* db.entities.Briefs.put({ briefId: "b-1", title: "alpha", body: BODY, scan: SCAN })
        const row = rowOf("Brief")
        const vectorBefore = row.__edd_v_vec2__
        fetched.length = 0
        // The title is a source: the stored body is read to re-derive the text.
        const updated = yield* db.entities.Briefs.update({ briefId: "b-1" })
          .set({ title: "beta gamma" })
          .offloaded("lazy")
        expect(fetched.length).toBeGreaterThan(0)
        expect(fetched.every((key) => key === pointerOf(row.body).ref.key)).toBe(true)
        asHandle(updated.scan)
        expect(rowOf("Brief").__edd_v_vec2__).not.toEqual(vectorBefore)
      }),
    )
  })

  it.effect("a retained update re-embeds from the stored source, never fetching a binary", () => {
    recording()
    return withVectors(
      Effect.gen(function* () {
        const db = yield* vectorClient
        yield* db.entities.RetainedBriefs.put({
          briefId: "b-1",
          title: "alpha",
          body: BODY,
          scan: SCAN,
        })
        const row = liveOf("RetainedBrief")
        const vectorBefore = row.__edd_v_vec3__
        fetched.length = 0
        // The title is a source: the read-merge copy reads the stored body,
        // which the payload does not supply — and not the scan.
        const updated = yield* db.entities.RetainedBriefs.update({ briefId: "b-1" })
          .set({ title: "beta gamma" })
          .offloaded("lazy")
        expect(fetchedRefs).toEqual([refName(pointerOf(row.body).ref)])
        asHandle(updated.scan)
        expect(liveOf("RetainedBrief").__edd_v_vec3__).not.toEqual(vectorBefore)
        expect(versionsOf("RetainedBrief").length).toBeGreaterThan(0)

        // A payload that supplies the source fetches nothing to embed it.
        fetchedRefs.length = 0
        yield* db.entities.RetainedBriefs.update({ briefId: "b-1" })
          .set({ title: "delta", body: text(150, "y") })
          .offloaded("lazy")
        expect(fetchedRefs).toEqual([])
      }),
    )
  })

  it.effect("reembed skips a retained snapshot without reading its source", () => {
    recording()
    return withVectors(
      Effect.gen(function* () {
        const db = yield* vectorClient
        yield* db.entities.RetainedBriefs.put({
          briefId: "b-1",
          title: "alpha",
          body: BODY,
          scan: SCAN,
        })
        // A new body: the snapshot of the first version keeps the old pointer.
        yield* db.entities.RetainedBriefs.update({ briefId: "b-1" })
          .set({ body: text(150, "y") })
          .offloaded("lazy")
        const liveBody = refName(pointerOf(liveOf("RetainedBrief").body).ref)
        expect(
          versionsOf("RetainedBrief").some(
            (snapshot) => refName(pointerOf(snapshot.body).ref) !== liveBody,
          ),
        ).toBe(true)
        fetchedRefs.length = 0
        expect(yield* db.entities.RetainedBriefs.reembed()).toBe(1)
        expect(fetchedRefs).toEqual([liveBody])
      }),
    )
  })
})

// ---------------------------------------------------------------------------
// decodeMarshalledItem
// ---------------------------------------------------------------------------

describe("Entity offload reads — decodeMarshalledItem", () => {
  it.effect("is lazy by default, eager on request; an invalid mode is a ValidationError", () =>
    withStore(
      Effect.gen(function* () {
        yield* putDoc("d-1")
        const image = live("Doc", "d-1")
        const before = gets()
        const lazy = yield* Entity.decodeMarshalledItem(Docs, image)
        expect(gets()).toBe(before)
        expect(yield* asValue(lazy.body).read()).toEqual(BODY)
        expect(yield* asHandle(lazy.scan).read()).toEqual(SCAN)
        expect(lazy.meta).toEqual({ n: 1 })

        const eager = yield* Entity.decodeMarshalledItem(Docs, image, { offloaded: "eager" })
        expect(eager.body).toEqual(BODY)
        expect(eager.scan).toEqual(SCAN)

        // Lambda's DynamoDB JSON: `B` as base64 text, the pointer included.
        const base64 = {
          ...image,
          body: { B: Buffer.from(image.body!.B!).toString("base64") },
        } as unknown as Record<string, AttributeValue>
        const fromLambda = yield* Entity.decodeMarshalledItem(Docs, base64, {
          offloaded: { overflow: "eager" },
        })
        expect(fromLambda.body).toEqual(BODY)

        const invalid = yield* Effect.flip(
          Entity.decodeMarshalledItem(Docs, image, { offloaded: "maybe" as never }),
        )
        expect(invalid).toBeInstanceOf(ValidationError)
        expect(String((invalid as ValidationError).cause)).toContain("EDD-9117")
      }),
    ),
  )

  it.effect("a pure definition unpacks packed fields and dispatches pointers", () =>
    Effect.gen(function* () {
      yield* withStore(
        Effect.gen(function* () {
          const db = yield* client
          yield* db.entities.PureDocs.put({
            docId: "p-1",
            owner: "o",
            title: "t",
            body: BODY,
            scan: SCAN,
            meta: { n: 2 },
          })
        }),
      )
      const image = live("PureDoc", "p-1")
      // The packed field is stored as JSON text, the overflow field as a pointer.
      expect(typeof image.meta?.S).toBe("string")
      // No store in context: the decode needs none, a lazy read fails.
      const decoded = yield* Entity.decodeMarshalledItem(PureDocs, image)
      expect(decoded.meta).toEqual({ n: 2 })
      expect(decoded.title).toBe("t")
      const failed = yield* Effect.flip(asValue(decoded.body).read())
      expect(failed).toMatchObject({ _tag: "BlobStoreError", reason: "NotProvided" })
      expect(yield* Effect.flip(asHandle(decoded.scan).read())).toMatchObject({
        reason: "NotProvided",
      })
      // With a store in context, the lazy values read.
      const resolved = yield* Effect.provide(
        Effect.flatMap(Entity.decodeMarshalledItem(PureDocs, image), (item) =>
          asValue(item.body).read(),
        ),
        BlobStore.layer(blobs),
      )
      expect(resolved).toEqual(BODY)
    }),
  )
})
