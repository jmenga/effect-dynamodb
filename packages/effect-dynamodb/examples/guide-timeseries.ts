/**
 * Time-series Guide Example — effect-dynamodb v2
 *
 * Demonstrates the `timeSeries` entity primitive:
 *   - Configuring an entity with one current + N event items
 *   - `.append()` — atomic TransactWriteItems with CAS on orderBy
 *   - Stale appends (out-of-order arrivals) returned as values, not errors
 *   - Enrichment preservation — fields outside appendInput are never touched
 *   - `.history(key).where(...)` — range queries on the orderBy attribute
 *   - TTL on event items
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *
 * Run:
 *   npx tsx examples/guide-timeseries.ts
 */

import { Console, DateTime, Duration, Effect, Layer, Schema } from "effect"

// Import from source (use "effect-dynamodb" when published)
import { DynamoClient } from "../src/DynamoClient.js"
import * as DynamoSchema from "../src/DynamoSchema.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"

// =============================================================================
// 1. Pure domain model — IoT telemetry record
// =============================================================================

// #region model
class TelemetryRecord extends Schema.Class<TelemetryRecord>("TelemetryRecord")({
  channel: Schema.String,
  deviceId: Schema.String,
  // `timestamp` is the caller-supplied monotonic clock used for CAS ordering.
  timestamp: Schema.DateTimeUtc,
  // Device-reported fields (flow through `.append()` — in appendInput):
  location: Schema.optional(Schema.String),
  alert: Schema.optional(Schema.Boolean),
  gpio: Schema.optional(Schema.Number),
  // Enrichment fields (set by background jobs — NOT in appendInput):
  accountId: Schema.optional(Schema.String),
  diagnostics: Schema.optional(Schema.String),
}) {}

// Only these fields are accepted by .append() — other model fields (accountId,
// diagnostics) are never overwritten. This is the enrichment-preservation
// contract. See guides/timeseries.mdx § "Enrichment Preservation".
const TelemetryAppendInput = Schema.Struct({
  channel: Schema.String,
  deviceId: Schema.String,
  timestamp: Schema.DateTimeUtc,
  location: Schema.optional(Schema.String),
  alert: Schema.optional(Schema.Boolean),
  gpio: Schema.optional(Schema.Number),
})
// #endregion

const AppSchema = DynamoSchema.make({ name: "timeseries-demo", version: 1 })

// =============================================================================
// 2. Entity definition
// =============================================================================

// #region define
const Telemetries = Entity.make({
  model: TelemetryRecord,
  entityType: "Telemetry",
  primaryKey: {
    pk: { field: "pk", composite: ["channel", "deviceId"] },
    sk: { field: "sk", composite: [] },
  },
  indexes: {
    byAccount: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["accountId"] },
      sk: { field: "gsi1sk", composite: ["deviceId"] },
    },
  },
  timestamps: { created: "createdAt" }, // `updated` auto-disabled by timeSeries
  timeSeries: {
    orderBy: "timestamp",
    ttl: Duration.days(7),
    appendInput: TelemetryAppendInput,
  },
})
// #endregion

const MainTable = Table.make({
  schema: AppSchema,
  entities: { Telemetries },
})

// =============================================================================
// 3. Layers
// =============================================================================

const ClientLayer = DynamoClient.layer({
  region: "us-east-1",
  endpoint: "http://localhost:8000",
  credentials: { accessKeyId: "local", secretAccessKey: "local" },
})

const MainTableLayer = MainTable.layer({ name: "timeseries-demo-table" })
const AppLayer = Layer.mergeAll(ClientLayer, MainTableLayer)

// =============================================================================
// 4. Program
// =============================================================================

const program = Effect.gen(function* () {
  const client = yield* DynamoClient
  yield* client.createTable({
    TableName: "timeseries-demo-table",
    BillingMode: "PAY_PER_REQUEST",
    ...Table.definition(MainTable),
  })

  const db = yield* DynamoClient.make({
    entities: { Telemetries },
    tables: { MainTable },
  })

  // ---------- Append an event ----------
  // #region append
  const r = yield* db.entities.Telemetries.append({
    channel: "c-1",
    deviceId: "d-7",
    timestamp: DateTime.makeUnsafe("2026-04-22T10:00:00.000Z"),
    location: "cabinet-A",
    gpio: 1,
  })
  if (r.applied) {
    yield* Console.log(`Applied. Current timestamp: ${DateTime.formatIso(r.current.timestamp)}`)
  } else {
    // Stale — someone beat us to the CAS. `r.current` is the winner.
    yield* Console.log(`Stale (reason=${r.reason}).`)
  }
  // #endregion

  // A second append with an OLDER orderBy is a stale drop — no error.
  const stale = yield* db.entities.Telemetries.append({
    channel: "c-1",
    deviceId: "d-7",
    timestamp: DateTime.makeUnsafe("2026-04-22T09:00:00.000Z"),
    location: "cabinet-B",
  })
  yield* Console.log(`Second append applied=${stale.applied}`)

  // ---------- Enrichment preservation ----------
  // #region enrichment
  // Device appends (no accountId in appendInput — cannot touch enrichment):
  yield* db.entities.Telemetries.append({
    channel: "c-1",
    deviceId: "d-7",
    timestamp: DateTime.makeUnsafe("2026-04-22T10:05:00.000Z"),
    location: "cabinet-C",
  })

  // Background job enriches with accountId (via `.update()`, not `.append()`):
  yield* db.entities.Telemetries.update(
    { channel: "c-1", deviceId: "d-7" },
    Telemetries.set({ accountId: "acct-1" }),
  )

  // Device appends again — accountId is preserved even though the device
  // doesn't know about it.
  yield* db.entities.Telemetries.append({
    channel: "c-1",
    deviceId: "d-7",
    timestamp: DateTime.makeUnsafe("2026-04-22T10:10:00.000Z"),
    location: "cabinet-D",
  })

  const cur = yield* db.entities.Telemetries.get({
    channel: "c-1",
    deviceId: "d-7",
  })
  yield* Console.log(`accountId preserved: ${cur.accountId}`)
  // #endregion

  // ---------- History range query ----------
  // #region history
  const fromIso = "2026-04-22T10:00:00.000Z"
  const toIso = "2026-04-22T10:10:00.000Z"
  const range = yield* db.entities.Telemetries.history({
    channel: "c-1",
    deviceId: "d-7",
  })
    .where((t, { between }) => between(t.timestamp, fromIso, toIso))
    .collect()
  yield* Console.log(`History in range: ${range.length} events`)
  // #endregion

  // Cleanup
  yield* client.deleteTable({ TableName: "timeseries-demo-table" })
})

// =============================================================================
// 5. Run
// =============================================================================

Effect.runPromise(program.pipe(Effect.provide(AppLayer), Effect.scoped))
