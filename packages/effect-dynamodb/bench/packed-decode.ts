/**
 * Packed storage read micro-benchmark (#147) — NOT run in CI.
 *
 * Measures the per-value and per-row cost of reading packed values against the
 * bare work they wrap (`JSON.parse`, decompress + parse, a plain loop), over
 * 5,990 values — the sub-stream size the issue's Lambda measurements used:
 *
 * - **value** — `StorageEncoding.decodeUnmarshalled` (one Effect per value, run
 *   in one `Effect.forEach`) and `StorageEncoding.decodeUnmarshalledSync`, on a
 *   native map (passthrough), a JSON string, and zstd binary.
 * - **rows** — a bound entity query (`.collect()`) over an in-memory client
 *   returning the rows in pages of 1,000: a native map field, the same field
 *   packed as JSON, and packed + zstd.
 * - **images** — `EventStream.decodeStreamImage` over Lambda-shaped DynamoDB
 *   JSON images with packed `data`.
 *
 * Each case reports the median of `RUNS` timed runs after `WARMUP` untimed ones.
 *
 * Run (Node >= 22.15 for zstd; `--expose-gc` collects the heap before each
 * timed sample, which keeps one case's garbage out of the next one's numbers):
 *   node --expose-gc --import tsx bench/packed-decode.ts
 */

import type { AttributeValue, QueryCommandOutput } from "@aws-sdk/client-dynamodb"
import { Compression } from "@effect-dynamodb/schema/Compression.js"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Effect, Layer, Schema } from "effect"
import { Base64 } from "effect/encoding"
import * as ZlibCompression from "../src/compression/zlib.js"
import { DynamoClient, type DynamoClientService } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
import { fromAttributeMap, toAttributeMap } from "../src/Marshaller.js"
import * as StorageEncoding from "../src/StorageEncoding.js"
import * as Table from "../src/Table.js"

const N = 5_990
const PAGE = 1_000
const WARMUP = 5
const RUNS = 15

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const median = (samples: ReadonlyArray<number>): number => {
  const sorted = [...samples].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]!
}

const results: Array<{ readonly group: string; readonly label: string; readonly ms: number }> = []

/** `global.gc` when Node runs with `--expose-gc` — each sample then starts from a collected heap. */
const collect = (globalThis as { readonly gc?: () => void }).gc ?? (() => {})

const bench = async (group: string, label: string, run: () => unknown): Promise<void> => {
  for (let i = 0; i < WARMUP; i++) await run()
  const samples: Array<number> = []
  for (let i = 0; i < RUNS; i++) {
    collect()
    const start = performance.now()
    await run()
    samples.push(performance.now() - start)
  }
  results.push({ group, label, ms: median(samples) })
}

// ---------------------------------------------------------------------------
// Data — ~1 KB of JSON per value, so zstd pays
// ---------------------------------------------------------------------------

const Line = Schema.Struct({ sku: Schema.String, qty: Schema.Number, price: Schema.Number })
const Payload = Schema.Struct({ note: Schema.String, lines: Schema.Array(Line) })
type Payload = typeof Payload.Type

const payload = (i: number): Payload => ({
  note: `order ${i} — packed storage benchmark`,
  lines: Array.from({ length: 16 }, (_, j) => ({ sku: `SKU-${i}-${j}`, qty: j + 1, price: 9.99 })),
})

const zstd = ZlibCompression.zstd()
const registry = Compression.make([zstd])
const zstd0 = DynamoModel.Packed({ format: "json", compression: { codec: "zstd", threshold: 0 } })
const json = DynamoModel.Packed({ format: "json" })

const wires = Array.from({ length: N }, (_, i) => payload(i))
const jsonValues = wires.map((w) => JSON.stringify(w))
const encoder = new TextEncoder()
const zstdValues = jsonValues.map((text) => {
  const z = zstd.compress(encoder.encode(text))
  const out = new Uint8Array(1 + z.length)
  out[0] = 0x23
  out.set(z, 1)
  return out
})

// ---------------------------------------------------------------------------
// Entity rows over an in-memory client
// ---------------------------------------------------------------------------

const AppSchema = DynamoSchema.make({ name: "bench", version: 1 })

class Order extends Schema.Class<Order>("Order")({
  orderId: Schema.String,
  customerId: Schema.String,
  details: Payload,
}) {}

const makeOrders = (entityType: string, storedAs: DynamoModel.PackedConfig | undefined) =>
  Entity.make({
    model: storedAs === undefined ? Order : DynamoModel.configure(Order, { details: { storedAs } }),
    entityType,
    primaryKey: {
      pk: { field: "pk", composite: ["customerId"] },
      sk: { field: "sk", composite: ["orderId"] },
    },
  })

const NativeOrders = makeOrders("NativeOrder", undefined)
const JsonOrders = makeOrders("JsonOrder", json)
const ZstdOrders = makeOrders("ZstdOrder", zstd0)

const rowsOf = (entityType: string, details: (i: number) => unknown) =>
  Array.from({ length: N }, (_, i) =>
    toAttributeMap({
      pk: "$bench#v1#c-1",
      sk: `$bench#v1#${entityType.toLowerCase()}#o-${String(i).padStart(5, "0")}`,
      __edd_e__: entityType,
      orderId: `o-${i}`,
      customerId: "c-1",
      details: details(i),
    }),
  )

const tableRows: Record<string, ReadonlyArray<Record<string, AttributeValue>>> = {
  NativeOrder: rowsOf("NativeOrder", (i) => wires[i]),
  JsonOrder: rowsOf("JsonOrder", (i) => jsonValues[i]),
  ZstdOrder: rowsOf("ZstdOrder", (i) => zstdValues[i]),
}

const entityTypeOf = (input: { readonly ExpressionAttributeValues?: unknown }): string => {
  const values = Object.values(
    (input.ExpressionAttributeValues ?? {}) as Record<string, AttributeValue>,
  )
  for (const value of values) {
    if (value.S !== undefined && value.S in tableRows) return value.S
  }
  throw new Error("bench client: no entity type in the request")
}

const page = (input: {
  readonly ExclusiveStartKey?: unknown
  ExpressionAttributeValues?: unknown
}) =>
  Effect.sync(() => {
    const rows = tableRows[entityTypeOf(input)]!
    const start =
      input.ExclusiveStartKey === undefined
        ? 0
        : Number((input.ExclusiveStartKey as { readonly i: { readonly N: string } }).i.N)
    const end = Math.min(rows.length, start + PAGE)
    return {
      Items: rows.slice(start, end),
      ...(end < rows.length ? { LastEvaluatedKey: { i: { N: String(end) } } } : {}),
      $metadata: {},
    } as unknown as QueryCommandOutput
  })

const client = { query: page, scan: page } as unknown as DynamoClientService

const MainTable = Table.make({
  schema: AppSchema,
  entities: { NativeOrders, JsonOrders, ZstdOrders },
})

const live = Layer.mergeAll(
  Layer.succeed(DynamoClient, client),
  MainTable.layer({ name: "bench" }),
  Compression.layer([zstd]),
)

// ---------------------------------------------------------------------------
// EventStore images (Lambda shape: DynamoDB JSON, B as base64)
// ---------------------------------------------------------------------------

class Placed extends Schema.TaggedClass<Placed>()("Placed", {
  note: Schema.String,
  lines: Schema.Array(Line),
}) {}

const Ledger = EventStore.makeStream({
  table: MainTable,
  streamName: "Ledger",
  events: [Placed],
  streamId: { composite: ["ledgerId"] },
  storedAs: { data: json },
})

const images = Array.from({ length: N }, (_, i) =>
  toAttributeMap({
    pk: "$bench#v1#ledger#l-1",
    sk: `$bench#v1#ledger#e#${String(i + 1).padStart(10, "0")}`,
    __edd_e__: "ledger.event",
    streamId: "l-1",
    version: i + 1,
    eventType: "Placed",
    data: JSON.stringify({ _tag: "Placed", ...wires[i] }),
    timestamp: "2026-10-11T00:00:00.000Z",
  }),
)

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

const withCompression = <A, E>(effect: Effect.Effect<A, E>) =>
  effect.pipe(Effect.provideService(Compression, registry))

const main = async () => {
  // value — passthrough (a native map)
  await bench("value: native map (passthrough)", "bare loop", () => {
    let n = 0
    for (const w of wires) if (typeof w === "object") n++
    return n
  })
  await bench("value: native map (passthrough)", "decodeUnmarshalled (Effect)", () =>
    Effect.runSync(withCompression(Effect.forEach(wires, StorageEncoding.decodeUnmarshalled))),
  )
  await bench("value: native map (passthrough)", "decodeUnmarshalledSync", () =>
    wires.map((w) => StorageEncoding.decodeUnmarshalledSync(w, { compressors: registry })),
  )

  // value — JSON string
  await bench("value: JSON string (S)", "JSON.parse", () => jsonValues.map((t) => JSON.parse(t)))
  await bench("value: JSON string (S)", "decodeUnmarshalled (Effect)", () =>
    Effect.runSync(withCompression(Effect.forEach(jsonValues, StorageEncoding.decodeUnmarshalled))),
  )
  await bench("value: JSON string (S)", "decodeUnmarshalledSync", () =>
    jsonValues.map((t) => StorageEncoding.decodeUnmarshalledSync(t, { compressors: registry })),
  )

  // value — zstd binary
  const decoder = new TextDecoder()
  await bench("value: zstd (B)", "decompress + JSON.parse", () =>
    zstdValues.map((b) => JSON.parse(decoder.decode(zstd.decompress(b.subarray(1))))),
  )
  await bench("value: zstd (B)", "decodeUnmarshalled (Effect)", () =>
    Effect.runSync(withCompression(Effect.forEach(zstdValues, StorageEncoding.decodeUnmarshalled))),
  )
  await bench("value: zstd (B)", "decodeUnmarshalledSync", () =>
    zstdValues.map((b) => StorageEncoding.decodeUnmarshalledSync(b, { compressors: registry })),
  )

  // rows — bound entity query
  const db = await Effect.runPromise(
    DynamoClient.make({
      entities: { NativeOrders, JsonOrders, ZstdOrders },
      tables: { MainTable },
    }).pipe(Effect.provide(live)),
  )
  const rawRows = tableRows.NativeOrder!
  await bench("rows: entity query, 5,990 rows", "fromAttributeMap only (floor)", () =>
    rawRows.map((row) => fromAttributeMap(row)),
  )
  await bench("rows: entity query, 5,990 rows", "native map field", () =>
    Effect.runPromise(db.entities.NativeOrders.scan().collect()),
  )
  await bench("rows: entity query, 5,990 rows", "packed JSON field", () =>
    Effect.runPromise(db.entities.JsonOrders.scan().collect()),
  )
  await bench("rows: entity query, 5,990 rows", "packed zstd field", () =>
    Effect.runPromise(db.entities.ZstdOrders.scan().collect()),
  )

  // images — EventStream.decodeStreamImage
  const lambdaImages = images.map((image) =>
    Object.fromEntries(
      Object.entries(image).map(([k, v]) => [
        k,
        v.B !== undefined ? { B: Base64.encode(v.B) } : (v as unknown),
      ]),
    ),
  )
  const decodedImages = Effect.runSync(
    withCompression(
      Effect.forEach(lambdaImages, (image) => Ledger.decodeStreamImage(image as never)),
    ),
  )
  if (!decodedImages.every((event) => event._tag === "Some")) {
    throw new Error("bench: a stream image did not decode to an event")
  }
  await bench("images: decodeStreamImage, 5,990 images", "packed JSON data", () =>
    Effect.runSync(
      withCompression(
        Effect.forEach(lambdaImages, (image) => Ledger.decodeStreamImage(image as never)),
      ),
    ),
  )

  let group = ""
  for (const r of results) {
    if (r.group !== group) {
      group = r.group
      console.log(`\n${group}`)
    }
    console.log(`  ${r.label.padEnd(34)} ${r.ms.toFixed(2).padStart(9)} ms`)
  }
}

main().catch((error) => {
  console.error(error)
  throw error
})
