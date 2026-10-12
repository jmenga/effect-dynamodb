/**
 * Packed Storage Guide Example — effect-dynamodb
 *
 * Demonstrates `DynamoModel.Packed({ format: "json", compression? })`:
 *   - Registering Node compressors as a Compression layer merged into the app layer
 *   - An entity field stored as one JSON string (S)
 *   - An entity field compressed to binary (B) over a threshold
 *   - What conditions and updates a packed field accepts
 *   - Migrating a field from a native map to packed, with no rewrite
 *   - An EventStore stream with packed event data and a compressed inline
 *     snapshot, raw rows, and filterBy
 *   - Measuring stored sizes for chunk planning
 *   - Decoding DynamoDB Streams images (B as base64, as Lambda delivers it)
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   Node >= 22.15 (zstd)
 *
 * Run (DYNAMODB_ENDPOINT overrides the default http://localhost:8000):
 *   npx tsx examples/guide-packed-storage.ts
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { Config, Console, DateTime, Effect, Layer, Option, Schema } from "effect"
import { Base64 } from "effect/encoding"

// Import from source (use "effect-dynamodb" and "effect-dynamodb/compression/node" when published)
import * as NodeCompression from "../src/compression/node.js"
import { DynamoClient } from "../src/DynamoClient.js"
import { Compression } from "@effect-dynamodb/schema/Compression.js"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
import * as Query from "../src/Query.js"
import * as StorageEncoding from "../src/StorageEncoding.js"
import * as Table from "../src/Table.js"
import { toAttributeMap } from "../src/Marshaller.js"

const assertEq = <T>(actual: T, expected: T, label: string): void => {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`Assertion failed [${label}]: expected ${e}, got ${a}`)
}

const TABLE_NAME = "packed-storage-demo"
const AppSchema = DynamoSchema.make({ name: "packed-demo", version: 1 })

// =============================================================================
// 1. Entity model — two packed fields
// =============================================================================

// #region model
class Line extends Schema.Class<Line>("Line")({
  sku: Schema.String,
  qty: Schema.Number,
  price: Schema.Number,
}) {}

class Order extends Schema.Class<Order>("Order")({
  orderId: Schema.String,
  customerId: Schema.String,
  status: Schema.String,
  lines: Schema.Array(Line),
  details: Schema.optional(
    Schema.Struct({
      note: Schema.String,
      // Stored inside the JSON as its wire form: an ISO string
      placedAt: Schema.DateTimeUtc,
    }),
  ),
}) {}

const OrderModel = DynamoModel.configure(Order, {
  // One JSON string (S), however many lines
  lines: { storedAs: DynamoModel.Packed({ format: "json" }) },
  // JSON, compressed with zstd when it is 512 bytes or more and that is smaller.
  // Renamed to "d" like any other field.
  details: {
    field: "d",
    storedAs: DynamoModel.Packed({
      format: "json",
      compression: { codec: "zstd", threshold: 512 },
    }),
  },
})
// #endregion

// #region entity
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
// #endregion

// The same entity before packing was configured — used to show migration.
// #region native-entity
const NativeOrders = Entity.make({
  model: DynamoModel.configure(Order, { details: { field: "d" } }),
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
// #endregion

// =============================================================================
// 2. EventStore stream — packed event data, compressed inline snapshot
// =============================================================================

// #region stream
class Recorded extends Schema.TaggedClass<Recorded>()("Recorded", {
  amount: Schema.Number,
  note: Schema.String,
}) {}

class Voided extends Schema.TaggedClass<Voided>()("Voided", {
  reason: Schema.String,
}) {}

type LedgerEvent = Recorded | Voided

const LedgerState = Schema.Struct({
  total: Schema.Number,
  entries: Schema.Array(Schema.Struct({ amount: Schema.Number, note: Schema.String })),
})
type LedgerState = typeof LedgerState.Type

const EventsTable = Table.make({ schema: AppSchema, entities: { Orders } })

const Ledger = EventStore.makeStream({
  table: EventsTable,
  streamName: "Ledger",
  events: [Recorded, Voided],
  streamId: { composite: ["ledgerId"] },
  metadata: Schema.Struct({ correlationId: Schema.String }),
  // Event data as JSON (S); metadata always stays a map
  storedAs: { data: DynamoModel.Packed({ format: "json" }) },
  snapshot: {
    schema: LedgerState,
    mode: "inline",
    // Snapshot state as JSON, zstd-compressed from 1 KB (the default threshold)
    storedAs: DynamoModel.Packed({ format: "json", compression: { codec: "zstd" } }),
  },
})
// #endregion

const ledgerDecider: EventStore.Decider<
  LedgerState,
  { readonly amount: number; readonly note: string },
  LedgerEvent
> = {
  initialState: { total: 0, entries: [] },
  decide: (command) =>
    Effect.succeed([new Recorded({ amount: command.amount, note: command.note })]),
  evolve: (state, event) =>
    event._tag === "Recorded"
      ? {
          total: state.total + event.amount,
          entries: [...state.entries, { amount: event.amount, note: event.note }],
        }
      : state,
}

// The second table that NativeOrders shares (same table, unpacked definition)
const NativeTable = Table.make({ schema: AppSchema, entities: { NativeOrders } })

// =============================================================================
// 3. Layers — the compressors as their own layer, merged into the app layer
// =============================================================================

// #region compressors
const ClientLayer = DynamoClient.layerConfig({
  region: Config.succeed("us-east-1"),
  endpoint: Config.String("DYNAMODB_ENDPOINT").pipe(Config.withDefault("http://localhost:8000")),
  credentials: Config.succeed({ accessKeyId: "local", secretAccessKey: "local" }),
})

// Every codec a reader may meet. zstd needs Node >= 22.15.
const CompressionLayer = Compression.layer([NodeCompression.zstd(), NodeCompression.gzip()])

// Merged beside the client, so every layer and every program sees it
const AppLayer = Layer.mergeAll(
  ClientLayer,
  CompressionLayer,
  EventsTable.layer({ name: TABLE_NAME }),
  NativeTable.layer({ name: TABLE_NAME }),
)
// #endregion

// =============================================================================
// 4. Helpers (not shown in the guide)
// =============================================================================

/** The raw stored item, straight from DynamoDB. */
const rawItem = (pk: string, sk: string) =>
  Effect.gen(function* () {
    const client = yield* DynamoClient
    const result = yield* client.getItem({
      TableName: TABLE_NAME,
      Key: toAttributeMap({ pk, sk }),
      ConsistentRead: true,
    })
    return result.Item as Record<string, AttributeValue>
  })

/** "M", "S", or "B" plus its header byte in hex. */
const formOf = (value: AttributeValue | undefined): string =>
  value === undefined
    ? "absent"
    : value.M !== undefined || value.L !== undefined
      ? value.M !== undefined
        ? "M"
        : "L"
      : value.S !== undefined
        ? "S"
        : `B 0x${value.B![0]!.toString(16)}`

/** An AttributeValue map in the shape Lambda delivers it: B and BS as base64. */
const toLambdaImage = (item: Record<string, AttributeValue>): Record<string, unknown> => {
  const convert = (value: AttributeValue): unknown => {
    if (value.B !== undefined) return { B: Base64.encode(value.B) }
    if (value.BS !== undefined) return { BS: value.BS.map((b) => Base64.encode(b)) }
    if (value.M !== undefined) {
      return { M: Object.fromEntries(Object.entries(value.M).map(([k, v]) => [k, convert(v)])) }
    }
    if (value.L !== undefined) return { L: value.L.map(convert) }
    return value
  }
  return Object.fromEntries(Object.entries(item).map(([k, v]) => [k, convert(v)]))
}

const orderKey = (orderId: string) => ({
  pk: `$packed-demo#v1#order#orderid_${orderId}`,
  sk: "$packed-demo#v1#order",
})

const LONG_NOTE = "Leave at the side door; ring twice and wait. ".repeat(30)

// =============================================================================
// 5. Program
// =============================================================================

const program = Effect.gen(function* () {
  const client = yield* DynamoClient
  yield* client
    .deleteTable({ TableName: TABLE_NAME })
    .pipe(Effect.catchTag("ResourceNotFoundError", () => Effect.void))
  yield* client.createTable({
    TableName: TABLE_NAME,
    BillingMode: "PAY_PER_REQUEST",
    ...Table.definition(EventsTable),
  })

  const db = yield* DynamoClient.make({
    entities: { Orders },
    tables: { EventsTable },
  })
  const nativeDb = yield* DynamoClient.make({
    entities: { NativeOrders },
    tables: { NativeTable },
  })

  // ---------------------------------------------------------------------------
  // Entity: write and read packed fields
  // ---------------------------------------------------------------------------

  // #region entity-put
  const placedAt = DateTime.makeUnsafe("2026-10-11T08:00:00.000Z")

  yield* db.entities.Orders.put({
    orderId: "o-1",
    customerId: "c-1",
    status: "open",
    lines: [
      { sku: "A-100", qty: 2, price: 9.5 },
      { sku: "B-200", qty: 1, price: 24 },
    ],
    details: { note: "Short note", placedAt },
  })

  // Reads are transparent: the domain value comes back
  const order = yield* db.entities.Orders.get({ orderId: "o-1" })
  // order.lines → [Line { sku: "A-100", ... }, Line { sku: "B-200", ... }]
  // #endregion
  assertEq(order.lines.length, 2, "two lines")
  assertEq(order.details?.note, "Short note", "details note")

  const stored1 = yield* rawItem(orderKey("o-1").pk, orderKey("o-1").sk)
  // lines → S, d → S (under the 512-byte threshold)
  assertEq(formOf(stored1.lines), "S", "lines stored as S")
  assertEq(formOf(stored1.d), "S", "short details stored as S")
  yield* Console.log(`o-1 stored: lines=${formOf(stored1.lines)} d=${formOf(stored1.d)}`)
  yield* Console.log(`  lines S = ${stored1.lines?.S}`)

  // #region entity-compressed
  // details over the threshold: stored as B — header byte 0x23 (v1, json, zstd)
  // followed by the zstd-compressed JSON
  yield* db.entities.Orders.update({ orderId: "o-1" }).set({
    details: { note: LONG_NOTE, placedAt },
  })
  // #endregion
  const stored2 = yield* rawItem(orderKey("o-1").pk, orderKey("o-1").sk)
  assertEq(formOf(stored2.d), "B 0x23", "long details stored as B (zstd)")
  yield* Console.log(
    `o-1 after update: d=${formOf(stored2.d)} (${stored2.d?.B?.length} bytes, JSON was ${
      JSON.stringify({ note: LONG_NOTE, placedAt: "2026-10-11T08:00:00.000Z" }).length
    })`,
  )

  // ---------------------------------------------------------------------------
  // Entity: what a packed field accepts
  // ---------------------------------------------------------------------------

  // #region entity-rules
  // Whole-field existence checks work in conditions and filters
  yield* db.entities.Orders.update({ orderId: "o-1" })
    .set({ status: "confirmed" })
    .condition((t, { exists }) => exists(t.lines))

  // Whole-value .set() and .remove() are the only updates
  yield* db.entities.Orders.update({ orderId: "o-1" }).set({
    lines: [{ sku: "A-100", qty: 3, price: 9.5 }],
  })

  // Projections return the packed field as parsed JSON (its wire form)
  const rows = yield* db.entities.Orders.byCustomer({ customerId: "c-1" })
    .select(["orderId", "lines", "details"])
    .collect()
  // rows[0].details → { note: "...", placedAt: "2026-10-11T08:00:00.000Z" }

  // A path inside the field is refused when the expression is built:
  // .filter((t, { gt }) => gt(t.lines.at(0).qty, 1))   → compile error + [EDD-9076]
  // .filter({ lines: [] })                              → [EDD-9076]
  // .update(key).add({ lines: 1 })                      → [EDD-9077]
  // #endregion
  assertEq((rows[0]?.details as { placedAt: string }).placedAt, "2026-10-11T08:00:00.000Z", "projection is wire JSON")

  const refused = yield* Effect.try({
    try: () => db.entities.Orders.byCustomer({ customerId: "c-1" }).filter({ lines: [] }),
    catch: (e) => String(e),
  }).pipe(Effect.flip)
  assertEq(refused.includes("[EDD-9076]"), true, "filter inside packed field refused")
  yield* Console.log(`filter on lines refused: ${refused.split("\n")[0]?.slice(0, 80)}...`)

  // ---------------------------------------------------------------------------
  // Migration: native map → packed, no rewrite
  // ---------------------------------------------------------------------------

  // #region migration
  // Written before packing was configured: lines is a native list (L)
  yield* nativeDb.entities.NativeOrders.put({
    orderId: "o-legacy",
    customerId: "c-1",
    status: "open",
    lines: [{ sku: "C-300", qty: 1, price: 5 }],
  })

  // The packed definition reads it: readers go by the stored form
  const legacy = yield* db.entities.Orders.get({ orderId: "o-legacy" })

  // The next write of the field stores it packed
  yield* db.entities.Orders.update({ orderId: "o-legacy" }).set({ lines: legacy.lines })

  // And the native definition still reads the packed value back
  const rolledBack = yield* nativeDb.entities.NativeOrders.get({ orderId: "o-legacy" })
  // #endregion
  assertEq(rolledBack.lines[0]?.sku, "C-300", "native definition reads packed value")
  const legacyStored = yield* rawItem(orderKey("o-legacy").pk, orderKey("o-legacy").sk)
  assertEq(formOf(legacyStored.lines), "S", "migrated lines stored as S")
  yield* Console.log(`o-legacy migrated: lines=${formOf(legacyStored.lines)}`)

  // ---------------------------------------------------------------------------
  // EventStore: packed data, compressed inline snapshot
  // ---------------------------------------------------------------------------

  // #region stream-append
  const handle = EventStore.commandHandler(ledgerDecider, Ledger)
  const id = { ledgerId: "L-1" }

  // Each event's data is stored as JSON; the inline snapshot rides in the
  // same transaction, compressed once the state's JSON reaches 1 KB
  let latest: LedgerState = ledgerDecider.initialState
  for (let i = 1; i <= 40; i++) {
    const result = yield* handle(id, { amount: i, note: `entry ${i}: ${"x".repeat(40)}` })
    latest = result.state
  }

  // Reads decode every stored form: map, JSON string, compressed binary
  const events = yield* Ledger.read(id)
  const { snapshot, version } = yield* Ledger.readLatest(id)
  // #endregion
  assertEq(events.length, 40, "40 events")
  assertEq(version, 40, "version 40")
  assertEq(Option.getOrThrow(snapshot).state.total, latest.total, "snapshot state")
  const snapshotItem = yield* rawItem(
    "$packed-demo#v1#ledger#l-1",
    "$packed-demo#v1#ledger.snapshot",
  )
  assertEq(formOf(snapshotItem.state), "B 0x23", "snapshot state stored as zstd B")
  yield* Console.log(
    `snapshot state: ${formOf(snapshotItem.state)} ${snapshotItem.state?.B?.length} bytes ` +
      `(JSON ${JSON.stringify(latest).length} bytes)`,
  )

  // #region raw-rows
  // Raw rows carry data as plain parsed JSON — not schema-decoded — whether
  // the item stores it as a map, a JSON string or compressed binary
  const raw = yield* Ledger.query
    .events(id)
    .pipe(Query.select(["version", "data"]), Query.limit(2), Query.collect)
  // raw[0] → { version: 1, data: { _tag: "Recorded", amount: 1, note: "entry 1: ..." } }

  // A filter on a path inside packed data is refused ([EDD-9076]);
  // filter the decoded events instead
  const big = yield* Ledger.query.events(id).pipe(
    Query.filterBy((event) => event.data._tag === "Recorded" && event.data.amount > 35),
    Query.collect,
  )
  // #endregion
  assertEq((raw[0]?.data as { _tag: string })._tag, "Recorded", "raw row data is JSON")
  assertEq(
    big.map((e) => e.version),
    [36, 37, 38, 39, 40],
    "filterBy",
  )

  // ---------------------------------------------------------------------------
  // Sizing for chunk planning
  // ---------------------------------------------------------------------------

  // #region measure
  // The bytes an append would write, by DynamoDB's item-size rules, built by
  // the same code append uses: packed data, metadata, keys, inline snapshot
  const next = new Recorded({ amount: 41, note: "entry 41" })
  const plan = yield* Ledger.measureAppend(id, [next], 40, {
    metadata: { correlationId: "batch-7" },
    snapshot: ledgerDecider.evolve(latest, next),
  })
  // plan.events      → [bytes of each event item]
  // plan.snapshot    → bytes of the inline snapshot item (compressed)
  // plan.transactionBytes → what the append adds to the 4 MB request

  const fits =
    plan.events.every((bytes) => bytes <= StorageEncoding.limits.item) &&
    plan.transactionBytes <= StorageEncoding.limits.transaction

  // One value under a config, or as a native map (storedAs omitted)
  const asMap = yield* StorageEncoding.valueBytes({ schema: LedgerState, value: latest })
  const asZstd = yield* StorageEncoding.valueBytes({
    schema: LedgerState,
    value: latest,
    storedAs: DynamoModel.Packed({ format: "json", compression: { codec: "zstd" } }),
  })
  // #endregion
  assertEq(fits, true, "append fits")
  assertEq(plan.events.length, 1, "one event measured")
  assertEq(asZstd < asMap, true, "compressed state smaller than map")
  yield* Console.log(
    `measureAppend: events=${JSON.stringify(plan.events)} snapshot=${plan.snapshot} ` +
      `transaction=${plan.transactionBytes}; state as map=${asMap} as zstd=${asZstd}`,
  )

  // ---------------------------------------------------------------------------
  // DynamoDB Streams images
  // ---------------------------------------------------------------------------

  // The latest event item, raw
  const eventItem = yield* client
    .query({
      TableName: TABLE_NAME,
      KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :sk)",
      ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
      ExpressionAttributeValues: toAttributeMap({
        ":pk": "$packed-demo#v1#ledger#l-1",
        ":sk": "$packed-demo#v1#ledger.event",
      }),
      ScanIndexForward: false,
      Limit: 1,
      ConsistentRead: true,
    })
    .pipe(Effect.map((result) => result.Items![0] as Record<string, AttributeValue>))
  const orderItem = yield* rawItem(orderKey("o-1").pk, orderKey("o-1").sk)
  // As a Lambda trigger or EventBridge Pipes would deliver them: B as base64
  const images = [toLambdaImage(eventItem), toLambdaImage(orderItem)]

  // #region stream-image
  // One handler for a table's NewImage records. decodeStreamImage returns
  // Option.none() for anything that is not one of the stream's events.
  const decodeImage = (image: EventStore.StreamImage) =>
    Effect.gen(function* () {
      const event = yield* Ledger.decodeStreamImage(image)
      if (Option.isSome(event)) {
        // Exactly the StreamEvent Ledger.read returns
        return `ledger ${event.value.version}: ${event.value.data._tag}`
      }
      const order = (yield* Entity.decodeMarshalledItem(Orders, image)) as Order
      return `order ${order.orderId}: ${order.lines.length} line(s)`
    })
  // #endregion

  for (const image of images) {
    const line = yield* decodeImage(image as EventStore.StreamImage)
    yield* Console.log(`stream image → ${line}`)
  }
  const decodedEvent = yield* Ledger.decodeStreamImage(images[0] as EventStore.StreamImage)
  assertEq(Option.getOrThrow(decodedEvent).version, 40, "stream image decodes")

  // #region stream-image-raw
  // { raw: true } also returns rawData: the event's data as stored, in wire
  // form, with fields the event schemas don't model (a newer writer's, say).
  // It's the object the decode parsed, so nothing is parsed twice.
  const withRaw = yield* Ledger.decodeStreamImage(images[0] as EventStore.StreamImage, {
    raw: true,
  })
  if (Option.isSome(withRaw)) {
    const { data, rawData } = withRaw.value
    yield* Console.log(`decoded ${data._tag}; stored fields: ${Object.keys(rawData).join(", ")}`)
  }
  // #endregion
  assertEq(
    Option.getOrThrow(withRaw).rawData,
    { _tag: "Recorded", amount: 40, note: `entry 40: ${"x".repeat(40)}` },
    "stream image raw data",
  )

  yield* client.deleteTable({ TableName: TABLE_NAME })
})

// =============================================================================
// 6. Run
// =============================================================================

Effect.runPromise(program.pipe(Effect.provide(AppLayer))).then(() => console.log("Done."))
