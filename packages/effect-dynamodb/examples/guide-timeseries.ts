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

import { Console, DateTime, Duration, Effect, Layer, Option, Schema } from "effect"

// Import from source (use "effect-dynamodb" when published)
import { DynamoClient } from "../src/DynamoClient.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
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
  const { current } = yield* db.entities.Telemetries.append({
    channel: "c-1",
    deviceId: "d-7",
    timestamp: DateTime.makeUnsafe("2026-04-22T10:00:00.000Z"),
    location: "cabinet-A",
    gpio: 1,
  })
  yield* Console.log(`Applied. Current timestamp: ${DateTime.formatIso(current.timestamp)}`)
  // #endregion

  // A second append with an OLDER orderBy is a CAS rejection — surfaced on
  // the Effect error channel as `StaleAppend`.
  // #region stale
  const result = yield* db.entities.Telemetries.append({
    channel: "c-1",
    deviceId: "d-7",
    timestamp: DateTime.makeUnsafe("2026-04-22T09:00:00.000Z"),
    location: "cabinet-B",
  }).asEffect().pipe(
    Effect.catchTag("StaleAppend", (e) =>
      Effect.succeed({
        applied: false as const,
        // `e.current` is `Option<unknown>` — use Option.match to handle the
        // skipFollowUp case where it is `Option.none()`.
        winner: Option.getOrUndefined(e.current),
      }),
    ),
  )
  yield* Console.log(`Stale append surfaced: applied=${"applied" in result}`)
  // #endregion

  // ---------- skipFollowUp — fire-and-forget ingest ----------
  // High-volume ingest paths that don't need `current` save one RCU per call.
  // CAS / user-condition rejection still fires `StaleAppend` (current is
  // Option.none — we cannot disambiguate without the follow-up GetItem).
  // #region skip
  yield* db.entities.Telemetries.append({
    channel: "c-1",
    deviceId: "d-7",
    timestamp: DateTime.makeUnsafe("2026-04-22T10:01:00.000Z"),
    gpio: 0,
  })
    .skipFollowUp()
    .asEffect()
    .pipe(
      Effect.catchTag("StaleAppend", () => Effect.void),
    )
  // #endregion

  // ---------- Clear an attribute atomically via .remove() ----------
  // `.append(input).remove([...])` rides the same UpdateItem as the scoped
  // SET + CAS. Use it to signal "this attribute should no longer exist on
  // the current item" — e.g. an IoT device reporting a status event whose
  // absence of an `alert` field means "no alert this event, clear the
  // existing alert state". The single TransactWriteItems closes the race
  // window the previous two-write workaround (`.append()` then
  // `.update().remove([...])`) exposed.
  //
  // Names listed in `.remove()` must be in `appendInput`, must not be
  // `orderBy` / a PK composite / a ref-derived `${name}Id`, and must not
  // also appear in the append payload (DDB rejects SET/REMOVE overlap).
  // #region remove
  yield* db.entities.Telemetries.append({
    channel: "c-1",
    deviceId: "d-7",
    timestamp: DateTime.makeUnsafe("2026-04-22T10:02:00.000Z"),
    // Note: `alert` is intentionally omitted from the payload. The .remove()
    // call below clears it on the current item in the same UpdateItem.
  }).remove(["alert"])
  // #endregion

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
  yield* db.entities.Telemetries.update({ channel: "c-1", deviceId: "d-7" }).set({
    accountId: "acct-1",
  })

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
// 5. TTL attribute-name override (issue #51)
//
// `TableConfig.ttlAttributeName` overrides the default `_ttl` attribute used
// across `timeSeries: { ttl }`, `softDelete: { ttl }`, and
// `versioned: { retain, ttl }` lifecycle features. Use it to align the
// library's writes with a pre-existing or migrated DynamoDB table whose
// `TimeToLiveSpecification.AttributeName` differs from the default.
// =============================================================================

const ttlOverrideProgram = Effect.gen(function* () {
  const client = yield* DynamoClient
  yield* client.createTable({
    TableName: "timeseries-demo-table",
    BillingMode: "PAY_PER_REQUEST",
    ...Table.definition(MainTable),
  })

  // #region ttl-attribute-name
  // Provide the table layer with a non-default TTL attribute name.
  const overriddenLayer = MainTable.layer({
    name: "timeseries-demo-table",
    ttlAttributeName: "ttl",
  })

  const program = Effect.gen(function* () {
    const db = yield* DynamoClient.make({ entities: { Telemetries }, tables: { MainTable } })
    yield* db.entities.Telemetries.append({
      channel: "c-ttl-demo",
      deviceId: "d-1",
      timestamp: DateTime.makeUnsafe("2026-04-22T10:00:00.000Z"),
    })
  })

  yield* program.pipe(Effect.provide(Layer.mergeAll(ClientLayer, overriddenLayer)))
  // #endregion

  // Assert the event item carries TTL on the configured "ttl" attribute (not "_ttl").
  const raw = yield* client.query({
    TableName: "timeseries-demo-table",
    KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :skPrefix)",
    ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
    ExpressionAttributeValues: {
      ":pk": { S: "$timeseries-demo#v1#telemetry#channel_c-ttl-demo#deviceid_d-1" },
      ":skPrefix": { S: "$timeseries-demo#v1#telemetry#e#" },
    },
  })
  if (!raw.Items || raw.Items.length !== 1) {
    yield* Effect.die(new Error("expected exactly one event item"))
  }
  const event = raw.Items![0]!
  if (event.ttl?.N === undefined) {
    yield* Effect.die(new Error("expected 'ttl' attribute to be set on event item"))
  }
  if (event._ttl !== undefined) {
    yield* Effect.die(new Error("'_ttl' must be absent when override is in effect"))
  }
  yield* Console.log(`TTL written to 'ttl' attribute: ${event.ttl!.N}`)

  yield* client.deleteTable({ TableName: "timeseries-demo-table" })
})

// =============================================================================
// 6. Run
// =============================================================================

// Run the main program first, then the override demo sequentially — both share
// the `timeseries-demo-table` name, so they must not overlap.
const runAll = Effect.gen(function* () {
  yield* program.pipe(Effect.provide(AppLayer), Effect.scoped)
  yield* ttlOverrideProgram.pipe(Effect.provide(ClientLayer), Effect.scoped)
})

Effect.runPromise(runAll)
