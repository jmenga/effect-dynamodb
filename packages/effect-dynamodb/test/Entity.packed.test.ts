/**
 * Entity packed fields (#147): `DynamoModel.configure(model, { field: {
 * storedAs: DynamoModel.Packed(...) } })` stores the field as one JSON string
 * (`S`), or — with compression, over the threshold, when smaller — as
 * header-prefixed compressed binary (`B`).
 *
 * Runs against an in-memory `DynamoClient` that applies the requests the
 * entity sends (puts, updates, deletes, key-condition queries, scans, batch and
 * transaction requests), so every write and read path round-trips through the
 * stored form — and a table holding a MIX of native-map, JSON and compressed
 * values (a field that switched encoding) is read back exactly.
 */

import type {
  AttributeValue,
  TransactWriteItem,
  UpdateItemCommandInput,
} from "@aws-sdk/client-dynamodb"
import { describe, expect, it } from "@effect/vitest"
import { Compression } from "@effect-dynamodb/schema/Compression.js"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Embedder } from "@effect-dynamodb/schema/Embedder.js"
import { DynamoError, ValidationError } from "@effect-dynamodb/schema/Errors.js"
import { DateTime, Effect, Exit, Layer, Schema } from "effect"
import { beforeEach } from "vitest"
import * as Batch from "../src/Batch.js"
import * as Collection from "../src/Collection.js"
import * as NodeCompression from "../src/compression/node.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Expression from "../src/Expression.js"
import { fromAttributeMap, toAttributeMap } from "../src/Marshaller.js"
import * as Query from "../src/Query.js"
import * as Table from "../src/Table.js"
import * as Transaction from "../src/Transaction.js"
import * as VectorSearchEmulation from "../src/VectorSearchEmulation.js"
import { missingCompressor, unregisteredCodecDefect } from "./helpers/MissingCompressor.js"
import { mockDynamoClientLayer } from "./helpers/MockDynamoClient.js"

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

const AppSchema = DynamoSchema.make({ name: "packed", version: 1 })

class Line extends Schema.Class<Line>("Line")({ sku: Schema.String, qty: Schema.Number }) {}

const Details = Schema.Struct({
  note: Schema.String,
  // A nested self date: its wire form (ISO) is what the packed JSON holds,
  // exactly as a native map stores it.
  placedAt: Schema.DateTimeUtc,
})

class Order extends Schema.Class<Order>("Order")({
  orderId: Schema.String,
  customerId: Schema.String,
  status: Schema.String,
  lines: Schema.Array(Line),
  details: Schema.optional(Details),
  // Not packed, but object/array-shaped: read by stored form too, so values
  // written while it WAS packed still read after packing is turned off.
  notes: Schema.optional(Schema.Array(Schema.String)),
}) {}

const json = DynamoModel.Packed({ format: "json" })
const gzip64 = DynamoModel.Packed({
  format: "json",
  compression: { codec: "gzip", threshold: 64 },
})

const OrderModel = DynamoModel.configure(Order, {
  lines: { storedAs: json },
  details: { field: "d", storedAs: gzip64 },
})

const Orders = Entity.make({
  model: OrderModel,
  entityType: "Order",
  primaryKey: {
    pk: { field: "pk", composite: ["orderId"] },
    sk: { field: "sk", composite: [] },
  },
  indexes: {
    byCustomer: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["customerId"] },
      sk: { field: "gsi1sk", composite: ["status"] },
    },
  },
})

class Doc extends Schema.Class<Doc>("Doc")({
  docId: Schema.String,
  title: Schema.String,
  body: Schema.Struct({ text: Schema.String }),
  origin: Schema.Struct({ source: Schema.String, tags: Schema.Array(Schema.String) }),
}) {}

const gzip0 = DynamoModel.Packed({ format: "json", compression: { codec: "gzip", threshold: 0 } })

const Docs = Entity.make({
  model: DynamoModel.configure(Doc, {
    body: { storedAs: gzip0 },
    origin: { storedAs: json, immutable: true },
  }),
  entityType: "Doc",
  primaryKey: {
    pk: { field: "pk", composite: ["docId"] },
    sk: { field: "sk", composite: [] },
  },
  versioned: { retain: true },
  softDelete: true,
})

class Reading extends Schema.Class<Reading>("Reading")({
  deviceId: Schema.String,
  at: Schema.String,
  payload: Schema.Struct({ values: Schema.Array(Schema.Number) }),
  label: Schema.optional(Schema.String),
}) {}

const Readings = Entity.make({
  model: DynamoModel.configure(Reading, { payload: { storedAs: gzip0 } }),
  entityType: "Reading",
  primaryKey: {
    pk: { field: "pk", composite: ["deviceId"] },
    sk: { field: "sk", composite: [] },
  },
  timeSeries: {
    orderBy: "at",
    appendInput: Schema.Struct({
      deviceId: Schema.String,
      at: Schema.String,
      payload: Schema.Struct({ values: Schema.Array(Schema.Number) }),
    }),
  },
})

const MainTable = Table.make({ schema: AppSchema, entities: { Orders, Docs, Readings } })

// ---------------------------------------------------------------------------
// In-memory DynamoClient
// ---------------------------------------------------------------------------

type Item = Record<string, AttributeValue>

const store = new Map<string, Item>()
const sentPuts: Array<Item> = []
const sentUpdates: Array<UpdateItemCommandInput> = []
const sentTransactions: Array<ReadonlyArray<TransactWriteItem>> = []
/** Query and Scan requests, in order. */
const sentReads: Array<{
  readonly ProjectionExpression?: string | undefined
  readonly ExpressionAttributeNames?: Record<string, string> | undefined
}> = []

const keyOf = (item: Item) => `${item.pk?.S}|${item.sk?.S}`

const conditionFailed = (operation: string, item?: Item) =>
  new DynamoError({
    operation,
    cause: Object.assign(new Error("The conditional request failed"), {
      name: "ConditionalCheckFailedException",
      ...(item !== undefined && { Item: item }),
    }),
  })

/** Enforce the existence parts of a condition — all the entity paths here need. */
const conditionHolds = (
  expression: string | undefined,
  names: Record<string, string>,
  current: Item | undefined,
): boolean => {
  if (expression === undefined) return true
  for (const match of expression.matchAll(/attribute_not_exists\((#\w+)\)/g)) {
    const name = names[match[1]!]
    if ((name === "pk" || name === "sk") && current !== undefined && !/ OR /.test(expression)) {
      return false
    }
  }
  for (const match of expression.matchAll(/attribute_exists\((#\w+)\)/g)) {
    const name = names[match[1]!]
    if ((name === "pk" || name === "sk") && current === undefined) return false
  }
  return true
}

/** Split on commas outside parentheses. */
const splitTopLevel = (body: string): Array<string> => {
  const out: Array<string> = []
  let depth = 0
  let current = ""
  for (const ch of body) {
    if (ch === "(") depth++
    if (ch === ")") depth--
    if (ch === "," && depth === 0) {
      out.push(current.trim())
      current = ""
    } else current += ch
  }
  if (current.trim() !== "") out.push(current.trim())
  return out
}

const applyUpdateExpression = (
  current: Item | undefined,
  key: Item,
  input: {
    readonly UpdateExpression?: string | undefined
    readonly ExpressionAttributeNames?: Record<string, string> | undefined
    readonly ExpressionAttributeValues?: Record<string, AttributeValue> | undefined
  },
): Item => {
  const names = input.ExpressionAttributeNames ?? {}
  const values = input.ExpressionAttributeValues ?? {}
  const next: Item = { ...(current ?? key) }
  const sections = (input.UpdateExpression ?? "").split(/\b(SET|REMOVE|ADD|DELETE)\b/).slice(1)
  for (let i = 0; i + 1 < sections.length; i += 2) {
    const action = sections[i]!
    for (const clause of splitTopLevel(sections[i + 1]!)) {
      if (action === "REMOVE") {
        delete next[names[clause]!]
        continue
      }
      if (action !== "SET") continue
      const [target, source] = clause.split(/ = (.*)/s) as [string, string]
      const name = names[target.trim()]!
      const ifNotExistsPlus = /^if_not_exists\((#\w+), (:\w+)\) \+ (:\w+)$/.exec(source)
      const ifNotExists = /^if_not_exists\((#\w+), (:\w+)\)$/.exec(source)
      const plus = /^(#\w+) \+ (:\w+)$/.exec(source)
      if (ifNotExistsPlus) {
        const base = Number(next[name]?.N ?? values[ifNotExistsPlus[2]!]!.N)
        next[name] = { N: String(base + Number(values[ifNotExistsPlus[3]!]!.N)) }
      } else if (ifNotExists) {
        if (next[name] === undefined) next[name] = values[ifNotExists[2]!]!
      } else if (plus) {
        next[name] = { N: String(Number(next[name]?.N ?? 0) + Number(values[plus[2]!]!.N)) }
      } else if (source.startsWith(":")) {
        next[name] = values[source]!
      } else {
        throw new Error(`mock: unsupported SET ${clause}`)
      }
    }
  }
  return next
}

const project = (
  item: Item,
  expression: string | undefined,
  names: Record<string, string>,
): Item => {
  if (expression === undefined) return item
  const out: Item = {}
  for (const token of expression.split(",").map((t) => t.trim())) {
    const name = token.startsWith("#") ? names[token]! : token
    if (item[name] !== undefined) out[name] = item[name]!
  }
  return out
}

const ownership = (
  rows: Array<Item>,
  filter: string | undefined,
  values: Record<string, AttributeValue>,
): Array<Item> => {
  const owner = /#eddE IN \(([^)]*)\)/.exec(filter ?? "")
  if (!owner) return rows
  const allowed = owner[1]!.split(",").map((p) => values[p.trim()]!.S)
  return rows.filter((item) => allowed.includes(item.__edd_e__?.S))
}

const runQuery = (input: {
  readonly ScanIndexForward?: boolean | undefined
  readonly Limit?: number | undefined
  readonly KeyConditionExpression?: string | undefined
  readonly FilterExpression?: string | undefined
  readonly ProjectionExpression?: string | undefined
  readonly ExpressionAttributeNames?: Record<string, string> | undefined
  readonly ExpressionAttributeValues?: Record<string, AttributeValue> | undefined
}) => {
  const names = input.ExpressionAttributeNames ?? {}
  const values = input.ExpressionAttributeValues ?? {}
  const kc = /^(#\w+) = (:\w+)(?: AND (.*))?$/.exec(input.KeyConditionExpression ?? "")!
  const pkAttr = names[kc[1]!]!
  let rows = [...store.values()].filter((item) => item[pkAttr]?.S === values[kc[2]!]!.S)
  const condition = kc[3]
  if (condition !== undefined) {
    const skName = /(#\w+)/.exec(condition)![1]!
    const skAttr = names[skName]!
    const sk = (item: Item) => item[skAttr]?.S ?? ""
    rows = rows.filter((item) => item[skAttr] !== undefined)
    rows.sort((a, b) => (sk(a) < sk(b) ? -1 : sk(a) > sk(b) ? 1 : 0))
    const v = (name: string) => values[name]!.S!
    const begins = /^begins_with\(#\w+, (:\w+)\)$/.exec(condition)
    const between = /^#\w+ BETWEEN (:\w+) AND (:\w+)$/.exec(condition)
    const compare = /^#\w+ (=|<|<=|>|>=) (:\w+)$/.exec(condition)
    if (begins) rows = rows.filter((item) => sk(item).startsWith(v(begins[1]!)))
    else if (between) {
      rows = rows.filter((item) => sk(item) >= v(between[1]!) && sk(item) <= v(between[2]!))
    } else if (compare) {
      const op = compare[1]!
      const y = v(compare[2]!)
      rows = rows.filter((item) => {
        const x = sk(item)
        return op === "="
          ? x === y
          : op === "<"
            ? x < y
            : op === "<="
              ? x <= y
              : op === ">"
                ? x > y
                : x >= y
      })
    } else throw new Error(`mock: unsupported key condition ${condition}`)
  }
  if (input.ScanIndexForward === false) rows.reverse()
  rows = ownership(rows, input.FilterExpression, values)
  if (input.Limit !== undefined) rows = rows.slice(0, input.Limit)
  return { Items: rows.map((item) => project(item, input.ProjectionExpression, names)) }
}

const InMemoryClient = mockDynamoClientLayer({
  putItem: (input) =>
    Effect.suspend(() => {
      const current = store.get(keyOf(input.Item!))
      if (!conditionHolds(input.ConditionExpression, input.ExpressionAttributeNames ?? {}, current))
        return Effect.fail(conditionFailed("PutItem", current))
      sentPuts.push(input.Item!)
      store.set(keyOf(input.Item!), input.Item!)
      return Effect.succeed({} as never)
    }),
  getItem: (input) =>
    Effect.sync(() => {
      const item = store.get(keyOf(input.Key!))
      if (item === undefined) return {} as never
      return {
        Item: project(item, input.ProjectionExpression, input.ExpressionAttributeNames ?? {}),
      } as never
    }),
  updateItem: (input) =>
    Effect.suspend(() => {
      sentUpdates.push(input)
      const current = store.get(keyOf(input.Key!))
      if (!conditionHolds(input.ConditionExpression, input.ExpressionAttributeNames ?? {}, current))
        return Effect.fail(conditionFailed("UpdateItem", current))
      const next = applyUpdateExpression(current, input.Key!, input)
      store.set(keyOf(next), next)
      return Effect.succeed({
        Attributes: input.ReturnValues === "ALL_OLD" ? current : next,
      } as never)
    }),
  deleteItem: (input) =>
    Effect.sync(() => {
      const current = store.get(keyOf(input.Key!))
      store.delete(keyOf(input.Key!))
      return { Attributes: current } as never
    }),
  query: (input) =>
    Effect.sync(() => {
      sentReads.push(input)
      return runQuery(input) as never
    }),
  scan: (input) =>
    Effect.sync(() => {
      sentReads.push(input)
      return {
        Items: ownership(
          [...store.values()],
          input.FilterExpression,
          input.ExpressionAttributeValues ?? {},
        ).map((item) =>
          project(item, input.ProjectionExpression, input.ExpressionAttributeNames ?? {}),
        ),
      } as never
    }),
  batchGetItem: (input) =>
    Effect.sync(() => {
      const Responses: Record<string, Array<Item>> = {}
      for (const [table, request] of Object.entries(input.RequestItems ?? {})) {
        Responses[table] = (request.Keys ?? []).flatMap((key) => {
          const item = store.get(keyOf(key))
          return item === undefined ? [] : [item]
        })
      }
      return { Responses } as never
    }),
  batchWriteItem: (input) =>
    Effect.sync(() => {
      for (const requests of Object.values(input.RequestItems ?? {})) {
        for (const request of requests) {
          if (request.PutRequest?.Item !== undefined) {
            sentPuts.push(request.PutRequest.Item)
            store.set(keyOf(request.PutRequest.Item), request.PutRequest.Item)
          }
          if (request.DeleteRequest?.Key !== undefined) {
            store.delete(keyOf(request.DeleteRequest.Key))
          }
        }
      }
      return {} as never
    }),
  transactGetItems: (input) =>
    Effect.sync(
      () =>
        ({
          Responses: (input.TransactItems ?? []).map((entry) => {
            const item = store.get(keyOf(entry.Get!.Key!))
            return item === undefined ? {} : { Item: item }
          }),
        }) as never,
    ),
  transactWriteItems: (input) =>
    Effect.sync(() => {
      const items = input.TransactItems ?? []
      sentTransactions.push(items)
      for (const entry of items) {
        if (entry.Put?.Item !== undefined) store.set(keyOf(entry.Put.Item), entry.Put.Item)
        if (entry.Update !== undefined) {
          const current = store.get(keyOf(entry.Update.Key!))
          const next = applyUpdateExpression(current, entry.Update.Key!, entry.Update)
          store.set(keyOf(next), next)
        }
        if (entry.Delete?.Key !== undefined) store.delete(keyOf(entry.Delete.Key))
      }
      return {} as never
    }),
})

const TableLayer = MainTable.layer({ name: "packed-entity-table" })
const Codecs = Compression.layer([NodeCompression.gzip(), NodeCompression.brotli()])
const TestLayer = Layer.mergeAll(InMemoryClient, TableLayer, Codecs)
const NoCodecs = Layer.mergeAll(InMemoryClient, TableLayer)

beforeEach(() => {
  store.clear()
  sentPuts.length = 0
  sentUpdates.length = 0
  sentTransactions.length = 0
  sentReads.length = 0
})

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const placedAt = DateTime.makeUnsafe("2026-10-01T12:00:00.000Z")
const smallDetails = { note: "hi", placedAt }
const bigDetails = { note: "x".repeat(400), placedAt }
const lines = [new Line({ sku: "A", qty: 1 }), new Line({ sku: "B", qty: 2 })]

const order = (overrides: Partial<Order> = {}) =>
  new Order({
    orderId: "o-1",
    customerId: "c-1",
    status: "open",
    lines,
    details: bigDetails,
    ...overrides,
  })

const client = DynamoClient.make({ entities: { Orders, Docs, Readings }, tables: { MainTable } })

const failure = <E>(exit: Exit.Exit<unknown, E>): E => {
  if (Exit.isSuccess(exit)) throw new Error("expected a failure")
  const reason = exit.cause.reasons.find((r) => r._tag === "Fail")
  if (reason === undefined || reason._tag !== "Fail") throw new Error("expected a Fail reason")
  return reason.error
}

/** The live item whose partition key ends in `_<id>` (not a snapshot, tombstone or event). */
const stored = (id: string): Item =>
  [...store.values()].find(
    (item) => item.pk?.S?.endsWith(`_${id}`) === true && !/#(v|deleted|e)#/.test(item.sk?.S ?? ""),
  )!
const ORDER_KEY = "o-1"

// ---------------------------------------------------------------------------
// Write: put / create / upsert
// ---------------------------------------------------------------------------

describe("Entity packed fields — writes", () => {
  it.effect("put stores JSON as S, compressed JSON as B under its renamed attribute", () =>
    Effect.gen(function* () {
      const db = yield* client
      yield* db.entities.Orders.put(order())
      const item = stored(ORDER_KEY)
      // `lines`: uncompressed config → JSON string.
      expect(item.lines?.S).toBe(
        JSON.stringify([
          { sku: "A", qty: 1 },
          { sku: "B", qty: 2 },
        ]),
      )
      // `details` → stored as `d`: over 64 bytes, gzip pays → B with header 0x21.
      expect(item.details).toBeUndefined()
      expect(item.d?.B).toBeInstanceOf(Uint8Array)
      expect(item.d!.B![0]).toBe(0x21)
      // The wire form inside: the nested self date as its ISO string.
      const roundTrip = yield* db.entities.Orders.get({ orderId: "o-1" })
      expect(roundTrip).toEqual(order())
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("a value under the threshold is stored as S even with compression", () =>
    Effect.gen(function* () {
      const db = yield* client
      yield* db.entities.Orders.put(order({ details: smallDetails }))
      const item = stored(ORDER_KEY)
      expect(item.d?.S).toBe(JSON.stringify({ note: "hi", placedAt: "2026-10-01T12:00:00.000Z" }))
      expect((yield* db.entities.Orders.get({ orderId: "o-1" })).details).toEqual(smallDetails)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("an absent optional packed field stays absent", () =>
    Effect.gen(function* () {
      const db = yield* client
      const { details: _, ...rest } = order()
      yield* db.entities.Orders.put(new Order(rest))
      expect(stored(ORDER_KEY).d).toBeUndefined()
      expect((yield* db.entities.Orders.get({ orderId: "o-1" })).details).toBeUndefined()
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("create and upsert pack too", () =>
    Effect.gen(function* () {
      const db = yield* client
      yield* db.entities.Orders.create(order())
      expect(stored(ORDER_KEY).d?.B).toBeInstanceOf(Uint8Array)
      store.clear()
      yield* db.entities.Orders.upsert(order({ details: smallDetails }))
      const upsert = sentUpdates.at(-1)!
      const valueOf = (attr: string) => {
        const placeholder = Object.entries(upsert.ExpressionAttributeNames!).find(
          ([, name]) => name === attr,
        )![0]
        const clause = upsert.UpdateExpression!.split(", ").find((c) => c.includes(placeholder))!
        return upsert.ExpressionAttributeValues![clause.split(" = ")[1]!]!
      }
      expect(valueOf("lines").S).toBe(
        JSON.stringify([
          { sku: "A", qty: 1 },
          { sku: "B", qty: 2 },
        ]),
      )
      expect(valueOf("d").S).toContain('"note":"hi"')
      expect((yield* db.entities.Orders.get({ orderId: "o-1" })).details).toEqual(smallDetails)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect(
    "a value over the threshold without its codec registered fails with a ValidationError caused by CompressorNotRegistered",
    () =>
      Effect.gen(function* () {
        // Unbound: the registry is resolved when the op runs (a bound client
        // refuses the missing codec at bind — see the DynamoClient.make tests).
        const error = failure(yield* Effect.exit(Orders.put(order()).asEffect()))
        expect(missingCompressor(error)).toMatchObject({
          codec: "gzip",
          direction: "compress",
          entityType: "Order",
          attribute: "d",
        })
        expect(store.size).toBe(0)
        // Under the threshold no codec is needed.
        yield* Orders.put(order({ details: smallDetails }))
        expect(stored(ORDER_KEY).d?.S).toBeDefined()
      }).pipe(Effect.provide(NoCodecs)),
  )

  it.effect("a non-JSON value is refused with a ValidationError naming the path", () =>
    Effect.gen(function* () {
      class Bad extends Schema.Class<Bad>("Bad")({
        id: Schema.String,
        data: Schema.Struct({ big: Schema.BigInt }),
      }) {}
      const Bads = Entity.make({
        model: DynamoModel.configure(Bad, { data: { storedAs: json } }),
        entityType: "Bad",
        primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
      })
      const T = Table.make({ schema: AppSchema, entities: { Bads } })
      const db = yield* DynamoClient.make({ entities: { Bads }, tables: { T } }).pipe(
        Effect.provide(T.layer({ name: "packed-entity-table" })),
      )
      const error = failure(
        yield* Effect.exit(db.entities.Bads.put({ id: "b", data: { big: 1n } }).asEffect()),
      )
      expect(error).toBeInstanceOf(ValidationError)
      expect((error as ValidationError).operation).toBe("put.packed")
      expect(String((error as ValidationError).cause)).toMatch(/data\.big is a bigint/)
    }).pipe(Effect.provide(TestLayer)),
  )
})

// ---------------------------------------------------------------------------
// Read: stored-form dispatch
// ---------------------------------------------------------------------------

describe("Entity packed fields — reads", () => {
  /**
   * The item `put` writes, with the packed fields rewritten as an earlier
   * writer stored them: native maps / lists (before packing was configured),
   * and an unpacked list field holding JSON (written while it WAS packed).
   */
  const writeLegacy = (orderId: string) =>
    Effect.gen(function* () {
      const db = yield* client
      yield* db.entities.Orders.put(order({ orderId }))
      const live = stored(orderId)
      store.set(keyOf(live), {
        ...live,
        ...toAttributeMap({
          lines: [
            { sku: "A", qty: 1 },
            { sku: "B", qty: 2 },
          ],
          d: { note: "legacy", placedAt: "2026-10-01T12:00:00.000Z" },
          notes: JSON.stringify(["written-while-packed"]),
        }),
      })
    })

  it.effect("a legacy native-map item still decodes after the field is configured packed", () =>
    Effect.gen(function* () {
      yield* writeLegacy("o-1")
      const db = yield* client
      const read = yield* db.entities.Orders.get({ orderId: "o-1" })
      expect(read.lines).toEqual(lines)
      expect(read.details).toEqual({ note: "legacy", placedAt })
      // An unpacked object/array field holding a JSON string (written while it
      // was packed) reads too.
      expect(read.notes).toEqual(["written-while-packed"])
      // A put re-packs it — the natural migrate-on-write.
      yield* db.entities.Orders.put(read)
      expect(stored(ORDER_KEY).lines?.S).toBeDefined()
      expect(stored(ORDER_KEY).notes?.L).toBeDefined()
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("asNative returns the stored S / B; asRecord / asItem decode", () =>
    Effect.gen(function* () {
      const db = yield* client
      yield* db.entities.Orders.put(order())
      const native = yield* Entity.asNative(Orders.get({ orderId: "o-1" }))
      expect(native.lines?.S).toBeDefined()
      expect(native.d?.B).toBeInstanceOf(Uint8Array)
      const record = yield* Entity.asRecord(Orders.get({ orderId: "o-1" }))
      expect(record.details).toEqual(bigDetails)
      const item = yield* Entity.asItem(Orders.get({ orderId: "o-1" }))
      expect(item.lines).toEqual([
        { sku: "A", qty: 1 },
        { sku: "B", qty: 2 },
      ])
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect(
    "reading a B value without its codec fails with a ValidationError caused by CompressorNotRegistered",
    () =>
      Effect.gen(function* () {
        // Unbound: written with the codec in scope, read without it.
        yield* Orders.put(order()).asEffect().pipe(Effect.provide(Codecs))
        const error = failure(yield* Effect.exit(Orders.get({ orderId: "o-1" }).asEffect()))
        expect(missingCompressor(error)).toMatchObject({
          codec: "gzip",
          direction: "decompress",
          attribute: "d",
        })
        // A JSON (S) value needs no codec.
        yield* Orders.put(order({ orderId: "o-2", details: smallDetails }))
        expect((yield* Orders.get({ orderId: "o-2" })).details).toEqual(smallDetails)
      }).pipe(Effect.provide(NoCodecs)),
  )

  it.effect("queries and scans read a mix of native, JSON and compressed rows", () =>
    Effect.gen(function* () {
      const db = yield* client
      yield* writeLegacy("o-1")
      yield* db.entities.Orders.put(order({ orderId: "o-2", details: smallDetails }))
      yield* db.entities.Orders.put(order({ orderId: "o-3" }))
      const byCustomer = yield* db.entities.Orders.byCustomer({ customerId: "c-1" }).collect()
      expect(byCustomer.map((o) => o.details?.note).sort()).toEqual([
        "hi",
        "legacy",
        "x".repeat(400),
      ])
      const scanned = yield* db.entities.Orders.scan().collect()
      expect(scanned).toHaveLength(3)
      expect(scanned.every((o) => o.lines.length === 2)).toBe(true)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("a projection returns a packed field whole, as its parsed JSON", () =>
    Effect.gen(function* () {
      const db = yield* client
      yield* db.entities.Orders.put(order())
      const rows = yield* db.entities.Orders.byCustomer({ customerId: "c-1" })
        .select(["status", "lines", "details"])
        .collect()
      expect(rows).toEqual([
        {
          status: "open",
          lines: [
            { sku: "A", qty: 1 },
            { sku: "B", qty: 2 },
          ],
          // Parsed JSON — the wire form, not schema-decoded (the date stays ISO).
          details: { note: "x".repeat(400), placedAt: "2026-10-01T12:00:00.000Z" },
        },
      ])
      const projected = yield* Orders.get({ orderId: "o-1" }).pipe(
        Entity.project(["lines", "d"]),
        Entity.asRecord,
      )
      expect(projected.lines).toEqual([
        { sku: "A", qty: 1 },
        { sku: "B", qty: 2 },
      ])
      expect((projected.d as { note: string }).note).toBe("x".repeat(400))
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("Batch.get and Transaction.transactGet decode packed fields", () =>
    Effect.gen(function* () {
      const db = yield* client
      yield* db.entities.Orders.put(order())
      const [viaBatch] = yield* Batch.get([db.entities.Orders.get({ orderId: "o-1" })])
      expect(viaBatch?.details).toEqual(bigDetails)
      const [viaTransaction] = yield* Transaction.transactGet([
        db.entities.Orders.get({ orderId: "o-1" }),
      ])
      expect(viaTransaction?.lines).toEqual(lines)
    }).pipe(Effect.provide(TestLayer)),
  )
})

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

describe("Entity packed fields — raw rows of other entity types", () => {
  /**
   * A row of another entity type in the same partition (and on the same GSI),
   * whose plain string attributes share names with Orders' packed (`lines`,
   * `d`) and dispatch-eligible (`notes`) attributes. Only `ignoreOwnership()`
   * lets it through; a projection must return it exactly as 1.25.0 did.
   */
  const writeForeign = Effect.gen(function* () {
    const db = yield* client
    yield* db.entities.Orders.put(order())
    const own = stored(ORDER_KEY)
    const foreign: Item = {
      ...own,
      sk: { S: "$packed#v1#memo" },
      __edd_e__: { S: "Memo" },
      lines: { S: "plain text, not JSON" },
      d: { S: "{also not json" },
      notes: { S: "a note" },
    }
    store.set(keyOf(foreign), foreign)
  })

  const ownLines = [
    { sku: "A", qty: 1 },
    { sku: "B", qty: 2 },
  ]

  /** The names a request's ProjectionExpression reads. */
  const projected = (input: (typeof sentReads)[number]): ReadonlyArray<string> =>
    (input.ProjectionExpression ?? "")
      .split(",")
      .map((token) => token.trim())
      .map((token) => input.ExpressionAttributeNames?.[token] ?? token)

  it.effect("a bound query projection unpacks only the entity's own rows", () =>
    Effect.gen(function* () {
      yield* writeForeign
      const db = yield* client
      const rows = yield* db.entities.Orders.byCustomer({ customerId: "c-1" })
        .ignoreOwnership()
        .select(["orderId", "lines", "notes", "details"])
        .collect()
      expect(rows).toHaveLength(2)
      const [own, foreign] = [...rows].sort((a, b) =>
        Array.isArray(a.lines) === Array.isArray(b.lines) ? 0 : Array.isArray(a.lines) ? -1 : 1,
      )
      expect(own).toEqual({
        orderId: "o-1",
        lines: ownLines,
        details: { note: "x".repeat(400), placedAt: "2026-10-01T12:00:00.000Z" },
      })
      // Exactly the stored strings — never JSON.parsed — and no borrowed __edd_e__.
      expect(foreign).toEqual({
        orderId: "o-1",
        lines: "plain text, not JSON",
        notes: "a note",
        details: "{also not json",
      })
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("a scan projection unpacks only the entity's own rows", () =>
    Effect.gen(function* () {
      yield* writeForeign
      const db = yield* client
      const rows = yield* db.entities.Orders.scan()
        .ignoreOwnership()
        .select(["lines", "notes"])
        .collect()
      expect(rows).toEqual(
        expect.arrayContaining([
          { lines: ownLines },
          { lines: "plain text, not JSON", notes: "a note" },
        ]),
      )
      expect(rows).toHaveLength(2)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("an unbound Query.select / selectPaths unpacks only the entity's own rows", () =>
    Effect.gen(function* () {
      yield* writeForeign
      const rows = yield* Orders.query
        .byCustomer({ customerId: "c-1" })
        .pipe(Query.ignoreOwnership, Query.select(["lines", "notes"]), Query.collect)
      expect(rows).toEqual(
        expect.arrayContaining([
          { lines: ownLines },
          { lines: "plain text, not JSON", notes: "a note" },
        ]),
      )
      const paths = yield* Orders.query
        .byCustomer({ customerId: "c-1" })
        .pipe(Query.ignoreOwnership, Query.selectPaths([["lines"]]), Query.collect)
      expect(paths).toEqual(
        expect.arrayContaining([{ lines: ownLines }, { lines: "plain text, not JSON" }]),
      )
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("__edd_e__ is borrowed for the check and stripped, unless selected", () =>
    Effect.gen(function* () {
      yield* writeForeign
      const db = yield* client
      const selected = yield* db.entities.Orders.byCustomer({ customerId: "c-1" })
        .ignoreOwnership()
        .select(["lines", "__edd_e__"])
        .collect()
      expect(selected).toEqual(
        expect.arrayContaining([
          { lines: ownLines, __edd_e__: "Order" },
          { lines: "plain text, not JSON", __edd_e__: "Memo" },
        ]),
      )
      expect(projected(sentReads.at(-1)!)).toContain("__edd_e__")
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("a projection naming no packed or dispatch attribute installs no hook", () =>
    Effect.gen(function* () {
      yield* writeForeign
      const db = yield* client
      const rows = yield* db.entities.Orders.byCustomer({ customerId: "c-1" })
        .ignoreOwnership()
        .select(["orderId", "status"])
        .collect()
      expect(rows).toEqual([
        { orderId: "o-1", status: "open" },
        { orderId: "o-1", status: "open" },
      ])
      // Nothing to unpack, so nothing is borrowed into the projection.
      expect(projected(sentReads.at(-1)!)).not.toContain("__edd_e__")
    }).pipe(Effect.provide(TestLayer)),
  )
})

describe("Entity packed fields — update", () => {
  it.effect(".set() writes the whole packed value in its stored form; .remove() REMOVEs it", () =>
    Effect.gen(function* () {
      const db = yield* client
      yield* db.entities.Orders.put(order({ details: smallDetails }))
      yield* db.entities.Orders.update({ orderId: "o-1" }).set({ details: bigDetails })
      const update = sentUpdates.at(-1)!
      const dValue = Object.entries(update.ExpressionAttributeNames!).find(
        ([, name]) => name === "d",
      )![0]
      expect(update.UpdateExpression).toContain(`${dValue} = :`)
      expect(stored(ORDER_KEY).d?.B).toBeInstanceOf(Uint8Array)
      expect((yield* db.entities.Orders.get({ orderId: "o-1" })).details).toEqual(bigDetails)

      yield* db.entities.Orders.update({ orderId: "o-1" }).remove(["details"])
      expect(sentUpdates.at(-1)!.UpdateExpression).toMatch(/REMOVE/)
      expect(stored(ORDER_KEY).d).toBeUndefined()
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect(
    "refuses add / subtract / append / deleteFromSet / path ops on a packed field (EDD-9077)",
    () =>
      Effect.gen(function* () {
        const db = yield* client
        yield* db.entities.Orders.put(order())
        const refused = (op: Effect.Effect<unknown, unknown>) =>
          Effect.map(Effect.exit(op), (exit) => {
            const error = failure(exit) as ValidationError
            expect(error).toBeInstanceOf(ValidationError)
            expect(String(error.cause)).toMatch(/\[EDD-9077\]/)
            return String(error.cause)
          })
        const update = () => db.entities.Orders.update({ orderId: "o-1" })
        expect(yield* refused(update().add({ lines: 1 }).asEffect())).toMatch(
          /\.add\(\) on "lines"/,
        )
        yield* refused(update().subtract({ details: 1 }).asEffect())
        yield* refused(
          update()
            .append({ lines: [{ sku: "C", qty: 3 }] })
            .asEffect(),
        )
        yield* refused(
          update()
            .deleteFromSet({ lines: new Set(["x"]) })
            .asEffect(),
        )
        expect(
          yield* refused(
            update()
              .pathSet({ segments: ["lines", 0, "qty"], value: 9, isPath: false })
              .asEffect(),
          ),
        ).toMatch(/pathSet on "lines"/)
        yield* refused(
          update()
            .pathSet({ segments: ["details"], value: smallDetails, isPath: false })
            .asEffect(),
        )
        yield* refused(update().pathRemove(["details", "note"]).asEffect())
        yield* refused(
          update()
            .pathAppend({ segments: ["lines"], value: [] })
            .asEffect(),
        )
        yield* refused(update().removeEntries("lines", ["0"]).asEffect())
        // Nothing was written.
        expect(sentUpdates).toHaveLength(0)
      }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("the read-merge (retain) path carries unnamed packed values byte-identical", () =>
    Effect.gen(function* () {
      const db = yield* client
      yield* db.entities.Docs.put({
        docId: "d-1",
        title: "v1",
        body: { text: "lorem ".repeat(50) },
        origin: { source: "import", tags: ["a"] },
      })
      const before = stored("d-1")
      expect(before.body?.B).toBeInstanceOf(Uint8Array)
      sentTransactions.length = 0
      yield* db.entities.Docs.update({ docId: "d-1" }).set({ title: "v2" })
      // The live-item Update writes only what changed: not `body` / `origin`.
      const write = sentTransactions[0]!.find((entry) => entry.Update !== undefined)!.Update!
      expect(Object.values(write.ExpressionAttributeNames ?? {})).not.toContain("body")
      expect(Object.values(write.ExpressionAttributeNames ?? {})).not.toContain("origin")
      // The version snapshot copies the stored bytes as they were.
      const snapshot = sentTransactions[0]!.find((entry) => entry.Put !== undefined)!.Put!.Item!
      expect(snapshot.body?.B).toEqual(before.body?.B)
      expect(snapshot.origin?.S).toBe(before.origin?.S)
      const after = yield* db.entities.Docs.get({ docId: "d-1" })
      expect(after.title).toBe("v2")
      expect(after.body.text).toBe("lorem ".repeat(50))
      const v1 = yield* db.entities.Docs.getVersion({ docId: "d-1" }, 1)
      expect(v1.title).toBe("v1")
      expect(v1.body.text).toBe("lorem ".repeat(50))
      // A named packed field on the same path is packed fresh.
      yield* db.entities.Docs.update({ docId: "d-1" }).set({ body: { text: "short" } })
      expect(stored("d-1").body?.S).toBe('{"text":"short"}')
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("an immutable packed field is compared by its unpacked JSON, not its bytes", () =>
    Effect.gen(function* () {
      const db = yield* client
      yield* db.entities.Docs.put({
        docId: "d-2",
        title: "t",
        body: { text: "b" },
        origin: { source: "import", tags: ["a"] },
      })
      // Same JSON, stored by an older writer as compressed binary: still equal.
      const live = stored("d-2")
      const gz = NodeCompression.gzip().compress(
        new TextEncoder().encode(JSON.stringify({ source: "import", tags: ["a"] })),
      )
      store.set(keyOf(live), { ...live, origin: { B: new Uint8Array([0x21, ...gz]) } })
      yield* db.entities.Docs.update({ docId: "d-2" }).set({
        title: "t2",
        origin: { source: "import", tags: ["a"] },
      })
      expect((yield* db.entities.Docs.get({ docId: "d-2" })).title).toBe("t2")
      const error = failure(
        yield* Effect.exit(
          db.entities.Docs.update({ docId: "d-2" })
            .set({ origin: { source: "other", tags: [] } })
            .asEffect(),
        ),
      )
      expect(error).toBeInstanceOf(ValidationError)
      expect(String((error as ValidationError).cause)).toMatch(/"origin" is immutable/)
    }).pipe(Effect.provide(TestLayer)),
  )
})

// ---------------------------------------------------------------------------
// Expressions and projections (EDD-9076)
// ---------------------------------------------------------------------------

describe("Entity packed fields — expression guards", () => {
  it.effect("conditions: exists / notExists on the whole field pass; anything else throws", () =>
    Effect.gen(function* () {
      const db = yield* client
      yield* db.entities.Orders.put(order())
      yield* db.entities.Orders.update({ orderId: "o-1" })
        .set({ status: "paid" })
        .condition((t, { exists }) => exists(t.lines))
      expect(sentUpdates.at(-1)!.ConditionExpression).toMatch(/attribute_exists/)

      expect(() => db.entities.Orders.update({ orderId: "o-1" }).condition({ lines: [] })).toThrow(
        /\[EDD-9076\] Entity "Order".*applies = to "lines"/,
      )
      expect(() =>
        db.entities.Orders.put(order()).condition((t, { eq }) =>
          // @ts-expect-error — a packed field's path is not a comparable Path
          eq(t.details, smallDetails),
        ),
      ).toThrow(/\[EDD-9076\]/)
      expect(() =>
        db.entities.Orders.delete({ orderId: "o-1" }).condition((t, { eq }) =>
          // @ts-expect-error — a packed field exposes no nested paths
          eq(t.details.note, "x"),
        ),
      ).toThrow(/addresses "details\.note"/)
      expect(() =>
        db.entities.Orders.put(order()).condition((t, { gt }) =>
          // @ts-expect-error — no size() on a packed field
          gt(t.lines.size(), 1),
        ),
      ).toThrow(/\[EDD-9076\]/)
      // Unbound Entity.condition is guarded too.
      expect(() => Orders.condition({ lines: [] })).toThrow(/\[EDD-9076\]/)
      expect(() =>
        Orders.update({ orderId: "o-1" }).pipe(Orders.condition({ notExists: "lines" })),
      ).not.toThrow()
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("filters and projections: whole-field only, with a filterBy hint", () =>
    Effect.gen(function* () {
      const db = yield* client
      const query = () => db.entities.Orders.byCustomer({ customerId: "c-1" })
      expect(() => query().filter({ lines: [] })).toThrow(/\[EDD-9076\].*filterBy/)
      expect(() =>
        // @ts-expect-error — no nested path on a packed field
        query().filter((t, { eq }) => eq(t.details.note, "x")),
      ).toThrow(/\[EDD-9076\]/)
      // The stored (renamed) name is guarded as well.
      expect(() => query().filter({ d: 1 })).toThrow(/\[EDD-9076\]/)
      expect(() => query().select(["details.note"])).toThrow(/\[EDD-9076\].*projection/)
      expect(() => Orders.get({ orderId: "o-1" }).pipe(Entity.project(["d.note"]))).toThrow(
        /\[EDD-9076\]/,
      )
      // Allowed: exists on the whole field, a non-packed filter, whole-field select.
      yield* db.entities.Orders.put(order())
      const kept = yield* query()
        .filter((t, { exists, eq, and }) => and(exists(t.details), eq(t.status, "open")))
        .collect()
      expect(kept).toHaveLength(1)
      const selected = yield* query()
        .select((t) => [t.lines, t.status])
        .collect()
      expect(selected[0]!.status).toBe("open")
    }).pipe(Effect.provide(TestLayer)),
  )

  it("Transaction.check refuses a compiled condition looking inside a packed field", () => {
    const get = Orders.get({ orderId: "o-1" })
    expect(() => Transaction.check(get, Expression.condition({ eq: { lines: [] } }))).toThrow(
      /\[EDD-9076\]/,
    )
    expect(() =>
      Transaction.check(get, Expression.condition({ attributeExists: "lines" })),
    ).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Batch / Transaction writes
// ---------------------------------------------------------------------------

describe("Entity packed fields — batch and transaction writes", () => {
  it.effect("Batch.write and Transaction.transactWrite pack like put", () =>
    Effect.gen(function* () {
      const db = yield* client
      yield* Batch.write([db.entities.Orders.put(order({ orderId: "o-b" }))])
      expect(stored("o-b").d?.B).toBeInstanceOf(Uint8Array)
      yield* Transaction.transactWrite([db.entities.Orders.put(order({ orderId: "o-t" }))])
      const tx = sentTransactions.at(-1)![0]!.Put!.Item!
      expect(tx.lines?.S).toBeDefined()
      expect(tx.d?.B).toBeInstanceOf(Uint8Array)
      const back = yield* db.entities.Orders.get({ orderId: "o-t" })
      expect(back.details).toEqual(bigDetails)
    }).pipe(Effect.provide(TestLayer)),
  )
})

// ---------------------------------------------------------------------------
// Lifecycle: soft delete / restore, time series
// ---------------------------------------------------------------------------

describe("Entity packed fields — lifecycle", () => {
  it.effect("soft delete copies stored values onto the tombstone; restore writes them back", () =>
    Effect.gen(function* () {
      const db = yield* client
      yield* db.entities.Docs.put({
        docId: "d-3",
        title: "t",
        body: { text: "z".repeat(300) },
        origin: { source: "s", tags: [] },
      })
      const live = stored("d-3")
      yield* db.entities.Docs.delete({ docId: "d-3" })
      const tombstone = [...store.values()].find((item) => item.sk?.S?.includes("#deleted#"))!
      expect(tombstone.body?.B).toEqual(live.body?.B)
      const deleted = yield* db.entities.Docs.deleted.get({ docId: "d-3" })
      expect(deleted.body.text).toBe("z".repeat(300))
      const listed = yield* db.entities.Docs.deleted.list({ docId: "d-3" }).collect()
      expect(listed[0]!.body.text).toBe("z".repeat(300))
      const restored = yield* db.entities.Docs.restore({ docId: "d-3" })
      expect(restored.body.text).toBe("z".repeat(300))
      expect(stored("d-3").body?.B).toEqual(live.body?.B)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("time-series append writes the same packed value on the current and event item", () =>
    Effect.gen(function* () {
      const db = yield* client
      const payload = { values: Array.from({ length: 50 }, (_, i) => i) }
      yield* db.entities.Readings.append({ deviceId: "dev", at: "2026-10-01", payload })
      const transaction = sentTransactions.at(-1)!
      const update = transaction[0]!.Update!
      const event = transaction[1]!.Put!.Item!
      const placeholder = Object.entries(update.ExpressionAttributeNames!).find(
        ([, name]) => name === "payload",
      )![0]
      const clause = update.UpdateExpression!.split(", ").find((c) => c.startsWith(placeholder))!
      const setValue = update.ExpressionAttributeValues![clause.split(" = ")[1]!]!
      expect(setValue.B).toBeInstanceOf(Uint8Array)
      expect(event.payload?.B).toEqual(setValue.B)
      const current = yield* db.entities.Readings.get({ deviceId: "dev" })
      expect(current.payload).toEqual(payload)
      const history = yield* db.entities.Readings.history({ deviceId: "dev" }).collect()
      expect(history.map((r) => r.payload)).toEqual([payload])
    }).pipe(Effect.provide(TestLayer)),
  )
})

// ---------------------------------------------------------------------------
// DynamoDB Streams images
// ---------------------------------------------------------------------------

describe("Entity.decodeMarshalledItem — stream images", () => {
  const base64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64")

  it.effect("another entity type's image is not read by stored form", () =>
    Effect.gen(function* () {
      const db = yield* client
      yield* db.entities.Orders.put(order())
      const image = stored(ORDER_KEY)
      // An Order-shaped image of another type whose dispatch-eligible
      // attribute is a plain string that happens to be valid JSON: decoded as
      // 1.25.0 decoded it — the string is not an array, so it fails.
      const foreign = { ...image, __edd_e__: { S: "Memo" }, notes: { S: '["a"]' } }
      const error = failure(yield* Effect.exit(Entity.decodeMarshalledItem(Orders, foreign)))
      expect(error).toBeInstanceOf(ValidationError)
      // The entity's own image still reads `notes` by its stored form.
      const own = { ...image, notes: { S: '["a"]' } }
      expect(
        ((yield* Entity.decodeMarshalledItem(Orders, own)) as { notes?: unknown }).notes,
      ).toEqual(["a"])
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("an unrepresentable number is a ValidationError, not a defect", () =>
    Effect.gen(function* () {
      const db = yield* client
      yield* db.entities.Orders.put(order())
      const image = { ...stored(ORDER_KEY), extra: { N: "12345678901234567890.5" } }
      const exit = yield* Effect.exit(Entity.decodeMarshalledItem(Orders, image))
      expect(failure(exit)).toBeInstanceOf(ValidationError)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("decodes DynamoDB JSON with B as bytes or base64, and unmarshalled images", () =>
    Effect.gen(function* () {
      const db = yield* client
      yield* db.entities.Orders.put(order())
      const image = stored(ORDER_KEY)
      const expected = yield* Entity.asItem(Orders.get({ orderId: "o-1" }))

      // DynamoDB JSON, B as bytes (an SDK GetRecords response).
      expect(yield* Entity.decodeMarshalledItem(Orders, image)).toEqual(expected)
      // DynamoDB JSON, B as base64 text (Lambda / EventBridge Pipes).
      const lambda = { ...image, d: { B: base64(image.d!.B!) } }
      expect(yield* Entity.decodeMarshalledItem(Orders, lambda)).toEqual(expected)
      // Already unmarshalled, B still base64 text.
      const unmarshalled = { ...fromAttributeMap(image), d: base64(image.d!.B!) }
      expect(yield* Entity.decodeMarshalledItem(Orders, unmarshalled)).toEqual(expected)
      // Already unmarshalled, B as bytes.
      expect(yield* Entity.decodeMarshalledItem(Orders, fromAttributeMap(image))).toEqual(expected)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("honours field renames and sparse maps (previously undecodable images)", () =>
    Effect.gen(function* () {
      class Page extends Schema.Class<Page>("Page")({
        pageId: Schema.String,
        title: Schema.String,
        metrics: Schema.Record(Schema.String, Schema.Number),
      }) {}
      const Pages = Entity.make({
        model: DynamoModel.configure(Page, {
          title: { field: "t" },
          metrics: { storedAs: DynamoModel.SparseMap() },
        }),
        entityType: "Page",
        primaryKey: {
          pk: { field: "pk", composite: ["pageId"] },
          sk: { field: "sk", composite: [] },
        },
      })
      const decoded = yield* Entity.decodeMarshalledItem(Pages, {
        pk: { S: "$packed#v1#page#p" },
        sk: { S: "$packed#v1#page" },
        __edd_e__: { S: "Page" },
        pageId: { S: "p" },
        t: { S: "Hello" },
        "metrics#2026-01": { N: "3" },
      })
      expect(decoded).toMatchObject({ pageId: "p", title: "Hello", metrics: { "2026-01": 3 } })
    }),
  )

  it.effect(
    "a compressed value without its codec fails with a ValidationError caused by CompressorNotRegistered",
    () =>
      Effect.gen(function* () {
        yield* Orders.put(order()).asEffect().pipe(Effect.provide(Codecs))
        const image = stored(ORDER_KEY)
        const error = failure(yield* Effect.exit(Entity.decodeMarshalledItem(Orders, image)))
        missingCompressor(error)
        // With the codec provided where the decode runs, it decodes.
        const decoded = yield* Entity.decodeMarshalledItem(Orders, image).pipe(
          Effect.provide(Codecs),
        )
        expect((decoded as { details: unknown }).details).toEqual(bigDetails)
      }).pipe(Effect.provide(NoCodecs)),
  )
})

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------

describe("Entity packed fields — collections", () => {
  class Ticket extends Schema.Class<Ticket>("Ticket")({
    ticketId: Schema.String,
    tenantId: Schema.String,
    thread: Schema.Array(Schema.String),
  }) {}
  class Invoice extends Schema.Class<Invoice>("Invoice")({
    invoiceId: Schema.String,
    tenantId: Schema.String,
    total: Schema.Number,
  }) {}
  const byTenant = {
    collection: "TenantItems",
    name: "gsi2",
    pk: { field: "gsi2pk", composite: ["tenantId"] },
    sk: { field: "gsi2sk", composite: [] },
  } as const
  const Tickets = Entity.make({
    model: DynamoModel.configure(Ticket, { thread: { storedAs: gzip0 } }),
    entityType: "Ticket",
    primaryKey: {
      pk: { field: "pk", composite: ["ticketId"] },
      sk: { field: "sk", composite: [] },
    },
    indexes: { byTenant },
  })
  const Invoices = Entity.make({
    model: Invoice,
    entityType: "Invoice",
    primaryKey: {
      pk: { field: "pk", composite: ["invoiceId"] },
      sk: { field: "sk", composite: [] },
    },
    indexes: { byTenant },
  })
  const CollTable = Table.make({ schema: AppSchema, entities: { Tickets, Invoices } })
  const CollLayer = Layer.mergeAll(
    InMemoryClient,
    CollTable.layer({ name: "packed-entity-table" }),
    Codecs,
  )

  it.effect("decodes each member by its own stored form; a packed member's path is refused", () =>
    Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { Tickets, Invoices },
        tables: { CollTable },
      })
      const thread = Array.from({ length: 30 }, (_, i) => `message ${i}`)
      yield* db.entities.Tickets.put({ ticketId: "t-1", tenantId: "acme", thread })
      yield* db.entities.Invoices.put({ invoiceId: "i-1", tenantId: "acme", total: 10 })
      const ticket = [...store.values()].find((item) => item.__edd_e__?.S === "Ticket")!
      expect(ticket.thread?.B).toBeInstanceOf(Uint8Array)

      const grouped = (yield* db.collections.TenantItems!({ tenantId: "acme" }).collect()) as {
        readonly Tickets: ReadonlyArray<Ticket>
        readonly Invoices: ReadonlyArray<Invoice>
      }
      expect(grouped.Tickets[0]!.thread).toEqual(thread)
      expect(grouped.Invoices[0]!.total).toBe(10)

      expect(() =>
        db.collections.TenantItems!({ tenantId: "acme" }).filter({ thread: [] }),
      ).toThrow(/\[EDD-9076\] Entity "Ticket"/)
      // A whole-field projection comes back as parsed JSON.
      const rows = yield* db.collections.TenantItems!({ tenantId: "acme" })
        .select(["thread", "total"])
        .collect()
      expect(
        (rows as unknown as Record<string, ReadonlyArray<{ thread?: unknown }>>).Tickets,
      ).toEqual([{ thread }])
    }).pipe(Effect.provide(CollLayer)),
  )

  it.effect("an unbound collection Query.select reads each packed member by __edd_e__", () =>
    Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { Tickets, Invoices },
        tables: { CollTable },
      })
      const thread = Array.from({ length: 30 }, (_, i) => `message ${i}`)
      yield* db.entities.Tickets.put({ ticketId: "t-1", tenantId: "acme", thread })
      yield* db.entities.Invoices.put({ invoiceId: "i-1", tenantId: "acme", total: 10 })
      const TenantItems = Collection.make("TenantItems", { Tickets, Invoices })
      // `__edd_e__` is not selected: it is borrowed for the member lookup and
      // stripped again, so each row holds exactly what was selected.
      const rows = yield* TenantItems.query({ tenantId: "acme" }).pipe(
        Query.select(["thread", "total"]),
        Query.collect,
      )
      expect(rows).toEqual(expect.arrayContaining([{ thread }, { total: 10 }]))
      expect(rows).toHaveLength(2)
      const paths = yield* TenantItems.query({ tenantId: "acme" }).pipe(
        Query.selectPaths([["thread"]]),
        Query.collect,
      )
      expect(paths).toEqual(expect.arrayContaining([{ thread }, {}]))
    }).pipe(Effect.provide(CollLayer)),
  )

  it.effect(
    "a collection projection reads members only, and only when it names their attributes",
    () =>
      Effect.gen(function* () {
        const db = yield* DynamoClient.make({
          entities: { Tickets, Invoices },
          tables: { CollTable },
        })
        const thread = Array.from({ length: 30 }, (_, i) => `message ${i}`)
        yield* db.entities.Tickets.put({ ticketId: "t-1", tenantId: "acme", thread })
        const ticket = [...store.values()].find((item) => item.__edd_e__?.S === "Ticket")!
        // A row of a non-member type in the collection's partition.
        const foreign: Item = {
          ...ticket,
          pk: { S: "foreign" },
          __edd_e__: { S: "Memo" },
          thread: { S: "plain text, not JSON" },
        }
        store.set(keyOf(foreign), foreign)
        const TenantItems = Collection.make("TenantItems", { Tickets, Invoices })
        const rows = yield* TenantItems.query({ tenantId: "acme" }).pipe(
          Query.ignoreOwnership,
          Query.select(["thread"]),
          Query.collect,
        )
        expect(rows).toEqual(
          expect.arrayContaining([{ thread }, { thread: "plain text, not JSON" }]),
        )
        expect(rows).toHaveLength(2)
        // `total` is no member's packed or dispatch attribute: no hook, nothing borrowed.
        yield* TenantItems.query({ tenantId: "acme" }).pipe(Query.select(["total"]), Query.collect)
        const last = sentReads.at(-1)!
        const projectedNames = (last.ProjectionExpression ?? "")
          .split(",")
          .map((token) => last.ExpressionAttributeNames?.[token.trim()] ?? token.trim())
        expect(projectedNames).not.toContain("__edd_e__")
      }).pipe(Effect.provide(CollLayer)),
  )

  it.effect("DynamoClient.make({ compressors }) reaches collection reads", () =>
    Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { Tickets, Invoices },
        tables: { CollTable },
        compressors: [NodeCompression.gzip()],
      })
      const thread = Array.from({ length: 30 }, (_, i) => `message ${i}`)
      yield* db.entities.Tickets.put({ ticketId: "t-1", tenantId: "acme", thread })
      const grouped = (yield* db.collections.TenantItems!({ tenantId: "acme" }).collect()) as {
        readonly Tickets: ReadonlyArray<Ticket>
      }
      expect(grouped.Tickets[0]!.thread).toEqual(thread)
    }).pipe(
      Effect.provide(
        Layer.mergeAll(InMemoryClient, CollTable.layer({ name: "packed-entity-table" })),
      ),
    ),
  )
})

// ---------------------------------------------------------------------------
// DynamoClient.make({ compressors }) — registration precedence (design §3.4)
// ---------------------------------------------------------------------------

describe("Entity packed fields — DynamoClient.make({ compressors })", () => {
  const body = { text: "y".repeat(200) }
  const origin = { source: "s", tags: ["a"] }
  const Brotli = Compression.layer([NodeCompression.brotli()])
  const Gzip = Compression.layer([NodeCompression.gzip()])

  it.effect("explicit compressors reach bound CRUD and query accessors with nothing ambient", () =>
    Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { Orders, Docs, Readings },
        tables: { MainTable },
        compressors: [NodeCompression.gzip()],
      })
      yield* db.entities.Docs.put({ docId: "d-1", title: "T", body, origin })
      const doc = [...store.values()].find((item) => item.__edd_e__?.S === "Doc")!
      expect(doc.body?.B).toBeInstanceOf(Uint8Array)
      expect((yield* db.entities.Docs.get({ docId: "d-1" })).body).toEqual(body)

      yield* db.entities.Orders.put(order())
      const stored = [...store.values()].find((item) => item.__edd_e__?.S === "Order")!
      expect(stored.d?.B).toBeInstanceOf(Uint8Array)
      const found = yield* db.entities.Orders.byCustomer({ customerId: "c-1" }).collect()
      expect(found[0]!.details?.note).toBe(bigDetails.note)
    }).pipe(Effect.provide(NoCodecs)),
  )

  it.effect("explicit compressors win over an ambient Compression at bind time", () =>
    Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { Orders, Docs, Readings },
        tables: { MainTable },
        compressors: [NodeCompression.gzip()],
      })
      yield* db.entities.Docs.put({ docId: "d-1", title: "T", body, origin })
      expect((yield* db.entities.Docs.get({ docId: "d-1" })).body).toEqual(body)
    }).pipe(Effect.provide(Layer.mergeAll(NoCodecs, Brotli))),
  )

  it.effect("an ambient Compression at bind time wins over one at run time", () =>
    Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { Orders, Docs, Readings },
        tables: { MainTable },
      }).pipe(Effect.provide(Gzip))
      yield* db.entities.Docs.put({ docId: "d-1", title: "T", body, origin })
        .asEffect()
        .pipe(Effect.provide(Brotli))
      const read = yield* db.entities.Docs.get({ docId: "d-1" })
        .asEffect()
        .pipe(Effect.provide(Brotli))
      expect(read.body).toEqual(body)
    }).pipe(Effect.provide(NoCodecs)),
  )

  it.effect("a bound member naming a codec the registry lacks fails at bind with EDD-9078", () =>
    Effect.gen(function* () {
      const defect = unregisteredCodecDefect
      // Nothing at bind time.
      const none = defect(
        yield* Effect.exit(DynamoClient.make({ entities: { Docs }, tables: { MainTable } })),
      )
      expect(none).toContain("[EDD-9078] DynamoClient.make")
      expect(none).toContain('entity "Docs" stores "body" packed with codec "gzip"')
      expect(none).toContain("no Compression registry is in scope")
      // An ambient registry without the codec.
      const ambient = defect(
        yield* Effect.exit(
          DynamoClient.make({ entities: { Docs }, tables: { MainTable } }).pipe(
            Effect.provide(Brotli),
          ),
        ),
      )
      expect(ambient).toContain('the Compression registry in scope has "brotli"')
      // Explicit compressors without the codec (they win over the ambient one).
      const explicit = defect(
        yield* Effect.exit(
          DynamoClient.make({
            entities: { Orders },
            tables: { MainTable },
            compressors: [NodeCompression.brotli()],
          }).pipe(Effect.provide(Gzip)),
        ),
      )
      // A renamed field is named once, by its domain name.
      expect(explicit).toContain('entity "Orders" stores "details" packed with codec "gzip"')
      expect(explicit).not.toContain('stores "d"')
      // A JSON-only packed member needs no registry.
      const JsonOrders = Entity.make({
        model: DynamoModel.configure(Order, { lines: { storedAs: json } }),
        entityType: "Order",
        primaryKey: {
          pk: { field: "pk", composite: ["orderId"] },
          sk: { field: "sk", composite: [] },
        },
      })
      const JsonTable = Table.make({ schema: AppSchema, entities: { JsonOrders } })
      yield* DynamoClient.make({ entities: { JsonOrders }, tables: { JsonTable } }).pipe(
        Effect.provide(JsonTable.layer({ name: "packed-entity-table" })),
      )
    }).pipe(Effect.provide(NoCodecs)),
  )

  it.effect(
    "with nothing at bind time, a Compression provided at run time reads values of a codec the config no longer names",
    () =>
      Effect.gen(function* () {
        // Written gzip-compressed while `details` was configured with gzip ...
        yield* Orders.put(order()).asEffect().pipe(Effect.provide(Gzip))
        // ... and read by a definition that packs it as plain JSON now: no
        // codec is named, so binding needs no registry, and the reader's
        // run-time registry decodes the old values.
        const JsonOrders = Entity.make({
          model: DynamoModel.configure(Order, {
            lines: { storedAs: json },
            details: { field: "d", storedAs: json },
          }),
          entityType: "Order",
          primaryKey: {
            pk: { field: "pk", composite: ["orderId"] },
            sk: { field: "sk", composite: [] },
          },
        })
        const JsonTable = Table.make({ schema: AppSchema, entities: { JsonOrders } })
        const db = yield* DynamoClient.make({
          entities: { JsonOrders },
          tables: { JsonTable },
        }).pipe(Effect.provide(JsonTable.layer({ name: "packed-entity-table" })))
        missingCompressor(
          failure(yield* Effect.exit(db.entities.JsonOrders.get({ orderId: "o-1" }).asEffect())),
        )
        const read = yield* db.entities.JsonOrders.get({ orderId: "o-1" })
          .asEffect()
          .pipe(Effect.provide(Gzip))
        expect(read.details).toEqual(bigDetails)
      }).pipe(Effect.provide(NoCodecs)),
  )
})

// ---------------------------------------------------------------------------
// Vector indexes whose source includes a packed field
// ---------------------------------------------------------------------------

describe("Entity packed fields — vector index source", () => {
  class Note extends Schema.Class<Note>("Note")({
    noteId: Schema.String,
    title: Schema.String,
    details: Schema.Struct({ summary: Schema.String }),
  }) {}
  const source = {
    fields: ["title", "details"],
    compose: (picked: Record<string, unknown>) =>
      `${String(picked.title ?? "")} ${(picked.details as { summary?: string } | undefined)?.summary ?? ""}`,
  }
  const noteModel = DynamoModel.configure(Note, { details: { storedAs: gzip0 } })
  const VNotes = Entity.make({
    model: noteModel,
    entityType: "VNote",
    primaryKey: {
      pk: { field: "pk", composite: ["noteId"] },
      sk: { field: "sk", composite: [] },
    },
    vectorIndexes: { search: { name: "vecn", dimensions: 2, source } },
  })
  const VRetained = Entity.make({
    model: noteModel,
    entityType: "VRetained",
    primaryKey: {
      pk: { field: "pk", composite: ["noteId"] },
      sk: { field: "sk", composite: [] },
    },
    versioned: { retain: true },
    vectorIndexes: { search: { name: "vecr", dimensions: 2, source } },
  })
  const VTable = Table.make({ schema: AppSchema, entities: { VNotes, VRetained } })
  const embedded: Array<string> = []
  const RecordingEmbedder = Layer.succeed(Embedder, {
    dimensions: 2,
    embed: (text: string) =>
      Effect.sync(() => {
        embedded.push(text)
        return [1, 0]
      }),
  })
  const VLayer = Layer.mergeAll(
    VectorSearchEmulation.layer(InMemoryClient, { tables: { VTable } }),
    VTable.layer({ name: "packed-entity-table" }),
    Codecs,
    RecordingEmbedder,
  )
  const details = { summary: "s".repeat(200) }

  it.effect("an update re-embeds from the packed field's value, not its stored bytes", () =>
    Effect.gen(function* () {
      embedded.length = 0
      const db = yield* DynamoClient.make({ entities: { VNotes, VRetained }, tables: { VTable } })
      yield* db.entities.VNotes.put({ noteId: "n-1", title: "T", details })
      const stored = [...store.values()].find((item) => item.__edd_e__?.S === "VNote")!
      expect(stored.details?.B).toBeInstanceOf(Uint8Array)
      yield* db.entities.VNotes.update({ noteId: "n-1" }).set({ title: "T2" })
      expect(embedded).toEqual([`T ${details.summary}`, `T2 ${details.summary}`])
    }).pipe(Effect.provide(VLayer)),
  )

  it.effect("the retain update path re-embeds from the packed field's value too", () =>
    Effect.gen(function* () {
      embedded.length = 0
      const db = yield* DynamoClient.make({ entities: { VNotes, VRetained }, tables: { VTable } })
      yield* db.entities.VRetained.put({ noteId: "n-1", title: "T", details })
      yield* db.entities.VRetained.update({ noteId: "n-1" }).set({ title: "T2" })
      expect(embedded).toEqual([`T ${details.summary}`, `T2 ${details.summary}`])
      // The untouched packed field is still written byte-identical (not rewritten).
      const current = [...store.values()].find(
        (item) => item.__edd_e__?.S === "VRetained" && item.title?.S === "T2",
      )!
      expect(current.details?.B).toBeInstanceOf(Uint8Array)
      expect((yield* db.entities.VRetained.get({ noteId: "n-1" })).details).toEqual(details)
    }).pipe(Effect.provide(VLayer)),
  )

  it.effect("a .select() projection of a packed field returns its parsed value", () =>
    Effect.gen(function* () {
      const db = yield* DynamoClient.make({ entities: { VNotes, VRetained }, tables: { VTable } })
      yield* db.entities.VNotes.put({ noteId: "n-1", title: "T", details })
      const hits = yield* db.entities.VNotes.search("anything")
        .select(["noteId", "details"])
        .collect()
      expect(hits.map((hit) => hit.item)).toEqual([{ noteId: "n-1", details }])
    }).pipe(Effect.provide(VLayer)),
  )
})
