/**
 * Connected integration tests for EventStore packed storage (#147):
 * `makeStream({ storedAs: { data } })` and `snapshot.storedAs` against a real
 * DynamoDB Local.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 *
 * Covers, end to end:
 *   - A stream written in phases — native map, JSON, JSON + gzip, JSON + zstd
 *     (with a value under the threshold) — read back through every read path:
 *     read, readFrom, currentVersion, readLatest (+ snapshot replay),
 *     readIndex / query.index on an LSI "all", an LSI "keys", a GSI
 *     "withoutMetadata" and a GSI "keys" (BatchGetItem hydration), and
 *     query.events.
 *   - Raw rows (Query.select) carrying data as the same plain JSON for M, S
 *     and B items, through every index projection (R3).
 *   - A ~48 KB folded state as a compressed inline snapshot and an async
 *     snapshot, read with and without verifySnapshot (R4).
 *   - measureAppend at DynamoDB's exact item-size boundary: 409,600 stored
 *     bytes accepted, 409,601 rejected and diagnosed with the stored size (R1/R4).
 *   - decodeStreamImage on items fetched with the raw client and rewritten into
 *     Lambda's DynamoDB-JSON shape with base64 B (R2).
 *   - CompressorNotRegistered on a read without the codec.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { CompressorNotRegistered, ValidationError } from "@effect-dynamodb/schema/Errors.js"
import { Config, Effect, Layer, Option, Schema } from "effect"
import { Base64 } from "effect/encoding"
import { afterAll, beforeAll, describe, expect } from "vitest"
import * as NodeCompression from "../src/compression/node.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as EventStore from "../src/EventStore.js"
import { ITEM_MAX_BYTES, itemBytes } from "../src/internal/ItemSize.js"
import { fromAttributeMap, toAttributeMap } from "../src/Marshaller.js"
import * as Query from "../src/Query.js"
import * as Table from "../src/Table.js"

// ---------------------------------------------------------------------------
// Skip when DynamoDB Local isn't reachable
// ---------------------------------------------------------------------------

const ENDPOINT = Effect.runSync(
  Config.String("DYNAMODB_ENDPOINT").pipe(Config.withDefault("http://localhost:8000")),
)

let dynamoAvailable = false
try {
  const res = await fetch(ENDPOINT, { method: "POST", signal: AbortSignal.timeout(1000) }).catch(
    () => null,
  )
  dynamoAvailable = res !== null
} catch {
  dynamoAvailable = false
}

const describeConnected = dynamoAvailable ? describe : describe.skip

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

const AppSchema = DynamoSchema.make({ name: "packed-es", version: 1 })
const LedgerTable = Table.make({ schema: AppSchema, entities: {} })
const tableName = `packed-es-${Date.now()}`

class Recorded extends Schema.TaggedClass<Recorded>()("Recorded", {
  kind: Schema.String,
  day: Schema.String,
  amount: Schema.Number,
  note: Schema.String,
}) {}

class Voided extends Schema.TaggedClass<Voided>()("Voided", {
  day: Schema.String,
  reason: Schema.String,
}) {}

type LedgerEvent = Recorded | Voided

const Metadata = Schema.Struct({ correlationId: Schema.String })

const LedgerState = Schema.Struct({
  total: Schema.Number,
  entries: Schema.Array(Schema.Struct({ amount: Schema.Number, note: Schema.String })),
})
type LedgerState = typeof LedgerState.Type

const pad = (version: number) => String(version).padStart(6, "0")

const indexes = {
  byKind: {
    index: "lsi1",
    sk: "lsi1sk",
    key: (event: LedgerEvent, version: number) =>
      event._tag === "Recorded" ? `${event.kind}#${pad(version)}` : undefined,
  },
  byVersionKeys: {
    index: "lsi2",
    sk: "lsi2sk",
    projection: "keys",
    key: (_event: LedgerEvent, version: number) => pad(version),
  },
  byDayLean: {
    type: "gsi",
    index: "gsi1",
    pk: "gsi1pk",
    sk: "gsi1sk",
    projection: "withoutMetadata",
    key: (event: LedgerEvent, version: number) => `${event.day}#${pad(version)}`,
  },
  byDayKeys: {
    type: "gsi",
    index: "gsi2",
    pk: "gsi2pk",
    sk: "gsi2sk",
    projection: "keys",
    key: (event: LedgerEvent, version: number) => `${event.day}#${pad(version)}`,
  },
} as const

const streamConfig = {
  table: LedgerTable,
  streamName: "Ledger",
  events: [Recorded, Voided],
  streamId: { composite: ["ledgerId"] },
  metadata: Metadata,
  indexes,
} as const

const json = DynamoModel.Packed({ format: "json" })
const gzip = DynamoModel.Packed({ format: "json", compression: { codec: "gzip" } })
const zstd = DynamoModel.Packed({ format: "json", compression: { codec: "zstd" } })

const NativeLedger = EventStore.makeStream({
  ...streamConfig,
  snapshot: { schema: LedgerState, mode: "inline" },
})
const JsonLedger = EventStore.makeStream({
  ...streamConfig,
  storedAs: { data: json },
  snapshot: { schema: LedgerState, mode: "inline", storedAs: json },
})
const GzipLedger = EventStore.makeStream({
  ...streamConfig,
  storedAs: { data: gzip },
  snapshot: { schema: LedgerState, mode: "inline", storedAs: gzip },
})
const ZstdLedger = EventStore.makeStream({
  ...streamConfig,
  storedAs: { data: zstd },
  snapshot: { schema: LedgerState, mode: "inline", storedAs: zstd },
})

/** No indexes: an item measured at DynamoDB's limit is exactly the base-table item. */
const BoundaryStream = EventStore.makeStream({
  table: LedgerTable,
  streamName: "Boundary",
  events: [Recorded],
  streamId: { composite: ["ledgerId"] },
  storedAs: { data: json },
})

const ledgerDecider: EventStore.Decider<
  LedgerState,
  { readonly amount: number; readonly note: string },
  LedgerEvent
> = {
  initialState: { total: 0, entries: [] },
  decide: (command) =>
    Effect.succeed([
      new Recorded({ kind: "sale", day: "2026-10-11", amount: command.amount, note: command.note }),
    ]),
  evolve: (state, event) =>
    event._tag === "Recorded"
      ? {
          total: state.total + event.amount,
          entries: [...state.entries, { amount: event.amount, note: event.note }],
        }
      : state,
}

const LONG_NOTE = "the quick brown fox jumps over the lazy dog; ".repeat(60)

const recorded = (amount: number, note = `note ${amount}`) =>
  new Recorded({ kind: "sale", day: "2026-10-11", amount, note })

const credentials = { accessKeyId: "local", secretAccessKey: "local" }
/** The client with every codec registered through `DynamoClient.layer({ compressors })`. */
const ClientLayer = DynamoClient.layer({
  region: "us-east-1",
  endpoint: ENDPOINT,
  credentials,
  compressors: [NodeCompression.gzip(), NodeCompression.zstd()],
})
/** The same client with no compressors. */
const BareClientLayer = DynamoClient.layer({ region: "us-east-1", endpoint: ENDPOINT, credentials })
const TableLayer = LedgerTable.layer({ name: tableName })
const provide = Effect.provide(Layer.mergeAll(ClientLayer, TableLayer))
const provideBare = Effect.provide(Layer.mergeAll(BareClientLayer, TableLayer))

/** Every stored item of a stream partition, raw. */
const rawItems = (ledgerId: string, prefix = "$packed-es#v1#ledger.event") =>
  Effect.gen(function* () {
    const client = yield* DynamoClient
    const result = yield* client.query({
      TableName: tableName,
      KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :sk)",
      ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
      ExpressionAttributeValues: toAttributeMap({
        ":pk": `$packed-es#v1#ledger#${ledgerId.toLowerCase()}`,
        ":sk": prefix,
      }),
      ConsistentRead: true,
    })
    return (result.Items ?? []) as Array<Record<string, AttributeValue>>
  })

const formOf = (item: Record<string, AttributeValue>, attribute = "data") => {
  const value = item[attribute]!
  return value.M !== undefined ? "M" : value.S !== undefined ? "S" : `B${value.B![0]}`
}

/** Write the mixed stream: v1–2 map, v3 JSON, v4 gzip, v5 zstd under threshold (S), v6 zstd. */
const writeMixed = (ledgerId: string) =>
  Effect.gen(function* () {
    const id = { ledgerId }
    yield* NativeLedger.append(
      id,
      [recorded(1), new Voided({ day: "2026-10-10", reason: "dup" })],
      0,
      {
        metadata: { correlationId: "c-native" },
      },
    )
    yield* JsonLedger.append(id, [recorded(3)], 2, { metadata: { correlationId: "c-json" } })
    yield* GzipLedger.append(id, [recorded(4, LONG_NOTE)], 3, {
      metadata: { correlationId: "c-gzip" },
    })
    yield* ZstdLedger.append(id, [recorded(5)], 4, { metadata: { correlationId: "c-small" } })
    yield* ZstdLedger.append(id, [recorded(6, LONG_NOTE)], 5, {
      metadata: { correlationId: "c-zstd" },
    })
  })

const mixedWire = [
  { _tag: "Recorded", kind: "sale", day: "2026-10-11", amount: 1, note: "note 1" },
  { _tag: "Voided", day: "2026-10-10", reason: "dup" },
  { _tag: "Recorded", kind: "sale", day: "2026-10-11", amount: 3, note: "note 3" },
  { _tag: "Recorded", kind: "sale", day: "2026-10-11", amount: 4, note: LONG_NOTE },
  { _tag: "Recorded", kind: "sale", day: "2026-10-11", amount: 5, note: "note 5" },
  { _tag: "Recorded", kind: "sale", day: "2026-10-11", amount: 6, note: LONG_NOTE },
]

const expectEvents = (
  events: ReadonlyArray<EventStore.StreamEvent<LedgerEvent, unknown>>,
  versions: ReadonlyArray<number>,
) => {
  expect(events.map((e) => e.version)).toEqual(versions)
  for (const event of events) {
    const { _tag, ...fields } = mixedWire[event.version - 1]!
    expect(event.data).toBeInstanceOf(_tag === "Recorded" ? Recorded : Voided)
    expect(event.data).toMatchObject(fields)
  }
}

/** An AttributeValue map as Lambda / EventBridge Pipes deliver it (B as base64). */
const toLambdaJson = (value: AttributeValue): unknown => {
  if (value.B !== undefined) return { B: Base64.encode(value.B) }
  if (value.BS !== undefined) return { BS: value.BS.map((b) => Base64.encode(b)) }
  if (value.M !== undefined) {
    return { M: Object.fromEntries(Object.entries(value.M).map(([k, v]) => [k, toLambdaJson(v)])) }
  }
  if (value.L !== undefined) return { L: value.L.map(toLambdaJson) }
  return value
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describeConnected("EventStore packed storage (#147)", () => {
  beforeAll(async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* DynamoClient
        const fragments = EventStore.indexDefinitions(ZstdLedger)
        yield* client.createTable({
          TableName: tableName,
          BillingMode: "PAY_PER_REQUEST",
          KeySchema: [
            { AttributeName: "pk", KeyType: "HASH" },
            { AttributeName: "sk", KeyType: "RANGE" },
          ],
          AttributeDefinitions: [
            { AttributeName: "pk", AttributeType: "S" },
            { AttributeName: "sk", AttributeType: "S" },
            ...fragments.AttributeDefinitions,
          ],
          LocalSecondaryIndexes: fragments.LocalSecondaryIndexes,
          GlobalSecondaryIndexes: fragments.GlobalSecondaryIndexes,
        })
      }).pipe(provide),
    )
  }, 15000)

  afterAll(async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* DynamoClient
        yield* client.deleteTable({ TableName: tableName })
      }).pipe(
        provide,
        Effect.catchTag("ResourceNotFoundError", () => Effect.void),
      ),
    )
  }, 15000)

  it.effect("a stream written in phases stores map, JSON and compressed items", () =>
    Effect.gen(function* () {
      yield* writeMixed("mix-forms")
      const items = yield* rawItems("mix-forms")
      expect(items.map((item) => formOf(item))).toEqual(["M", "M", "S", "B33", "S", "B35"])
      // Metadata stays a map on every item.
      expect(items.every((item) => item.metadata?.M !== undefined)).toBe(true)
    }).pipe(provide),
  )

  it.effect("read / readFrom / currentVersion / query.events decode every stored form", () =>
    Effect.gen(function* () {
      const id = { ledgerId: "mix-read" }
      yield* writeMixed(id.ledgerId)
      for (const stream of [NativeLedger, JsonLedger, GzipLedger, ZstdLedger]) {
        expectEvents(yield* stream.read(id, { consistentRead: true }), [1, 2, 3, 4, 5, 6])
        expectEvents(yield* stream.readFrom(id, 2, { consistentRead: true }), [3, 4, 5, 6])
        expect(yield* stream.currentVersion(id, { consistentRead: true })).toBe(6)
      }
      const events = yield* Query.collect(ZstdLedger.query.events(id))
      expectEvents(events, [1, 2, 3, 4, 5, 6])
      expect(events.map((e) => e.metadata?.correlationId)).toEqual([
        "c-native",
        "c-native",
        "c-json",
        "c-gzip",
        "c-small",
        "c-zstd",
      ])
      const ranged = yield* ZstdLedger.query.events(id).pipe(
        Query.reverse,
        Query.filterBy((e) => e.data._tag === "Recorded" && e.data.note === LONG_NOTE),
        Query.collect,
      )
      expect(ranged.map((e) => e.version)).toEqual([6, 4])
    }).pipe(provide),
  )

  it.effect("readIndex / query.index on LSI all, LSI keys, GSI withoutMetadata, GSI keys", () =>
    Effect.gen(function* () {
      const id = { ledgerId: "mix-index" }
      yield* writeMixed(id.ledgerId)
      expectEvents(
        yield* ZstdLedger.readIndex("byKind", id, { consistentRead: true }),
        [1, 3, 4, 5, 6],
      )
      expectEvents(
        yield* ZstdLedger.readIndex("byVersionKeys", id, { consistentRead: true }),
        [1, 2, 3, 4, 5, 6],
      )
      const lean = yield* ZstdLedger.readIndex("byDayLean", id)
      expectEvents(lean, [2, 1, 3, 4, 5, 6])
      expect(lean.every((e) => e.metadata === undefined)).toBe(true)
      const keys = yield* ZstdLedger.readIndex("byDayKeys", id, { beginsWith: "2026-10-11" })
      expectEvents(keys, [1, 3, 4, 5, 6])
      expect(keys.map((e) => e.metadata?.correlationId)).toEqual([
        "c-native",
        "c-json",
        "c-gzip",
        "c-small",
        "c-zstd",
      ])
      expectEvents(
        yield* ZstdLedger.query.index("byDayKeys", id).pipe(Query.reverse, Query.collect),
        [6, 5, 4, 3, 1, 2],
      )
    }).pipe(provide),
  )

  it.effect("raw rows carry data as the same plain JSON for M, S and B items (R3)", () =>
    Effect.gen(function* () {
      const id = { ledgerId: "mix-raw" }
      yield* writeMixed(id.ledgerId)
      const check = (rows: ReadonlyArray<Record<string, unknown>>, expected: number) => {
        expect(rows).toHaveLength(expected)
        for (const row of rows) {
          expect(row.data).toEqual(mixedWire[(row.version as number) - 1])
        }
      }
      check(
        yield* ZstdLedger.query.events(id).pipe(Query.select(["version", "data"]), Query.collect),
        6,
      )
      check(
        yield* NativeLedger.query
          .events(id)
          .pipe(Query.selectPaths([["version"], ["data"]]), Query.collect),
        6,
      )
      check(
        yield* ZstdLedger.query
          .index("byKind", id)
          .pipe(Query.select(["version", "data"]), Query.collect),
        5,
      )
      check(
        yield* ZstdLedger.query
          .index("byVersionKeys", id)
          .pipe(Query.select(["version", "data"]), Query.collect),
        6,
      )
      check(
        yield* ZstdLedger.query
          .index("byDayLean", id)
          .pipe(Query.select(["version", "data"]), Query.collect),
        6,
      )
      check(
        yield* ZstdLedger.query
          .index("byDayKeys", id)
          .pipe(Query.select(["version", "data"]), Query.collect),
        6,
      )
    }).pipe(provide),
  )

  it.effect("a compressed ~48 KB state rides inline and as an async snapshot (R4)", () =>
    Effect.gen(function* () {
      const id = { ledgerId: "big-state" }
      const handle = EventStore.commandHandler(ledgerDecider, ZstdLedger)
      // ~48 KB folded state: 120 entries of ~400 bytes.
      let last: EventStore.CommandHandlerResult<LedgerState, LedgerEvent> | undefined
      for (let i = 0; i < 120; i++) {
        last = yield* handle(id, { amount: i, note: `${i}: ${LONG_NOTE.slice(0, 380)}` })
      }
      const stateJson = JSON.stringify(last!.state)
      expect(stateJson.length).toBeGreaterThan(45_000)
      const [snapshotItem] = yield* rawItems(id.ledgerId, "$packed-es#v1#ledger.snapshot")
      expect(formOf(snapshotItem!, "state")).toBe("B35")
      const storedBytes = itemBytes(snapshotItem!)
      expect(storedBytes).toBeLessThan(stateJson.length / 5)
      // The measured size is the stored size.
      expect(yield* ZstdLedger.measureSnapshot(id, last!.state, 120)).toBe(storedBytes)

      const verified = yield* ZstdLedger.readLatest(id, { consistentRead: true })
      expect(Option.getOrThrow(verified.snapshot).state).toEqual(last!.state)
      expect(verified.version).toBe(120)
      const unverified = yield* ZstdLedger.readLatest(id, {
        consistentRead: true,
        verifySnapshot: false,
      })
      expect(Option.getOrThrow(unverified.snapshot).state).toEqual(last!.state)
      expect(EventStore.fold(ledgerDecider, yield* ZstdLedger.read(id))).toEqual(last!.state)

      // An async snapshot, gzip, through another definition — and back.
      yield* GzipLedger.writeSnapshot(id, last!.state, 121)
      const [rewritten] = yield* rawItems(id.ledgerId, "$packed-es#v1#ledger.snapshot")
      expect(formOf(rewritten!, "state")).toBe("B33")
      expect(Option.getOrThrow(yield* NativeLedger.readSnapshot(id)).state).toEqual(last!.state)
    }).pipe(provide),
  )

  it.effect("measureAppend at the item limit: 409,600 accepted, 409,601 diagnosed (R1/R4)", () =>
    Effect.gen(function* () {
      const sized = (ledgerId: string, target: number) =>
        Effect.gen(function* () {
          const base = yield* BoundaryStream.measureAppend({ ledgerId }, [recorded(1, "")], 0)
          const event = recorded(1, "x".repeat(target - base.events[0]!))
          const measured = yield* BoundaryStream.measureAppend({ ledgerId }, [event], 0)
          expect(measured.events[0]).toBe(target)
          return { event, measured }
        })

      const fits = yield* sized("edge-fits", ITEM_MAX_BYTES)
      const appended = yield* BoundaryStream.append({ ledgerId: "edge-fits" }, [fits.event], 0)
      expect(appended.version).toBe(1)
      const read = yield* BoundaryStream.read({ ledgerId: "edge-fits" }, { consistentRead: true })
      expect(read[0]!.data).toEqual(fits.event)

      const over = yield* sized("edge-over", ITEM_MAX_BYTES + 1)
      const error = yield* BoundaryStream.append({ ledgerId: "edge-over" }, [over.event], 0).pipe(
        Effect.flip,
      )
      expect(error).toBeInstanceOf(ValidationError)
      const text = String((error as ValidationError).cause)
      expect(text).toContain(`${ITEM_MAX_BYTES + 1} bytes by DynamoDB's item-size rules`)
      expect(text).toContain("the event at version 1")
    }).pipe(provide),
  )

  it.effect(
    "a compressed (B) inline snapshot over the item limit is diagnosed by its stored bytes (R4)",
    () =>
      Effect.gen(function* () {
        const id = { ledgerId: "big-b-snapshot" }
        // ~600 KB of incompressible text: zstd packs it to more than 400 KB.
        const noise = Base64.encode(
          Uint8Array.from({ length: 450_000 }, () => Math.floor(Math.random() * 256)),
        )
        const state = { total: 1, entries: [{ amount: 1, note: noise }] }
        const events = [recorded(1)]
        const measured = yield* ZstdLedger.measureAppend(id, events, 0, { snapshot: state })
        expect(measured.snapshot!).toBeGreaterThan(ITEM_MAX_BYTES)
        expect(measured.snapshot!).toBeLessThan(JSON.stringify(state).length)
        const error = yield* ZstdLedger.append(id, events, 0, { snapshot: state }).pipe(Effect.flip)
        expect(error).toBeInstanceOf(ValidationError)
        expect(String((error as ValidationError).cause)).toContain(
          `the inline snapshot, at pk=$packed-es#v1#ledger#big-b-snapshot, ` +
            `sk=$packed-es#v1#ledger.snapshot, ${measured.snapshot} bytes by DynamoDB's item-size rules`,
        )
        // Nothing was written.
        expect(yield* rawItems(id.ledgerId)).toEqual([])
      }).pipe(provide),
  )

  it.effect("decodeStreamImage on Lambda-shaped images equals the read result (R2)", () =>
    Effect.gen(function* () {
      const id = { ledgerId: "mix-image" }
      yield* writeMixed(id.ledgerId)
      const read = yield* ZstdLedger.read(id, { consistentRead: true })
      const items = yield* rawItems(id.ledgerId)
      for (const [i, item] of items.entries()) {
        const lambda = Object.fromEntries(
          Object.entries(item).map(([name, value]) => [name, toLambdaJson(value)]),
        )
        const unmarshalled = fromAttributeMap(item)
        for (const image of [lambda, item, unmarshalled]) {
          const decoded = yield* ZstdLedger.decodeStreamImage(image as EventStore.StreamImage)
          expect(Option.getOrThrow(decoded)).toStrictEqual(read[i])
        }
      }
    }).pipe(provide),
  )

  it.effect("reading compressed items without the codec fails with CompressorNotRegistered", () =>
    Effect.gen(function* () {
      const id = { ledgerId: "mix-bare" }
      yield* writeMixed(id.ledgerId).pipe(provide)
      const error = yield* ZstdLedger.read(id, { consistentRead: true }).pipe(Effect.flip)
      expect(error).toBeInstanceOf(CompressorNotRegistered)
      expect(error).toMatchObject({ codec: "gzip", direction: "decompress", attribute: "data" })
      // Native and JSON items need no codec.
      expectEvents(
        yield* ZstdLedger.query.events(id).pipe(Query.limit(3), Query.collect),
        [1, 2, 3],
      )
    }).pipe(provideBare),
  )
})
