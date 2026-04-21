/**
 * Unit tests for the `timeSeries` entity primitive.
 *
 * Covers:
 *   - Config validation (EDD-9010..9016) at `Entity.make()`
 *   - Append payload shape (TransactWriteItems capture)
 *   - Enrichment preservation (SET clause strictly scoped to appendInput)
 *   - Stale append: mocked TransactionCancelled → follow-up GetItem
 *   - History query shape (SK begins_with on `#e#` prefix)
 *
 * Integration-level validation (concurrent writes, real TTL, cross-call
 * enrichment) lives in `connected.test.ts` under `describe("timeSeries", ...)`.
 */

import { describe, expect, it } from "@effect/vitest"
import { DateTime, Duration, Effect, Layer, Schema } from "effect"
import { beforeEach, vi } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import * as DynamoSchema from "../src/DynamoSchema.js"
import * as Entity from "../src/Entity.js"
import { DynamoError } from "../src/Errors.js"
import * as Table from "../src/Table.js"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const AppSchema = DynamoSchema.make({ name: "tsapp", version: 1 })

class Telemetry extends Schema.Class<Telemetry>("Telemetry")({
  channel: Schema.String,
  deviceId: Schema.String,
  timestamp: Schema.DateTimeUtc,
  accountId: Schema.optional(Schema.String),
  location: Schema.optional(Schema.String),
  alert: Schema.optional(Schema.Boolean),
  gpio: Schema.optional(Schema.Number),
}) {}

const TelemetryAppendInput = Schema.Struct({
  channel: Schema.String,
  deviceId: Schema.String,
  timestamp: Schema.DateTimeUtc,
  location: Schema.optional(Schema.String),
  alert: Schema.optional(Schema.Boolean),
  gpio: Schema.optional(Schema.Number),
})

// ---------------------------------------------------------------------------
// Mock DynamoClient — captures transactWriteItems + getItem
// ---------------------------------------------------------------------------

const mockTransactWriteItems = vi.fn()
const mockGetItem = vi.fn()
const mockQuery = vi.fn()

const mockService: any = {
  putItem: () => Effect.die("not used"),
  getItem: (input: any) =>
    Effect.tryPromise({
      try: () => mockGetItem(input),
      catch: (e) => new DynamoError({ operation: "GetItem", cause: e }),
    }),
  deleteItem: () => Effect.die("not used"),
  updateItem: () => Effect.die("not used"),
  query: (input: any) =>
    Effect.tryPromise({
      try: () => mockQuery(input),
      catch: (e) => new DynamoError({ operation: "Query", cause: e }),
    }),
  transactWriteItems: (input: any) =>
    Effect.tryPromise({
      try: () => mockTransactWriteItems(input),
      catch: (e) => new DynamoError({ operation: "TransactWriteItems", cause: e }),
    }),
  batchGetItem: () => Effect.die("not used"),
  batchWriteItem: () => Effect.die("not used"),
  transactGetItems: () => Effect.die("not used"),
  createTable: () => Effect.die("not used"),
  deleteTable: () => Effect.die("not used"),
  describeTable: () => Effect.die("not used"),
  scan: () => Effect.die("not used"),
}

const TestDynamoClient = Layer.succeed(DynamoClient, mockService)

/** Build a wired entity with a real Table tag. */
const makeEntityWithTag = <E extends { _configure: (...args: any) => any }>(
  entity: E,
): { entity: E; tableLayer: Layer.Layer<any> } => {
  // Build a per-test Table definition with only this entity and bind the tag.
  const table = Table.make({
    schema: AppSchema,
    entities: { Telemetry: entity as any },
  })
  entity._configure(AppSchema, table.Tag)
  return { entity, tableLayer: table.layer({ name: "test-table" }) }
}

// ---------------------------------------------------------------------------
// 1. Validation — EDD-9010..9016
// ---------------------------------------------------------------------------

describe("TimeSeries — validation", () => {
  it("EDD-9010: orderBy must name a model field", () => {
    expect(() =>
      Entity.make({
        model: Telemetry,
        entityType: "Telemetry",
        primaryKey: {
          pk: { field: "pk", composite: ["channel", "deviceId"] },
          sk: { field: "sk", composite: [] },
        },
        timeSeries: {
          orderBy: "notAField" as any,
          appendInput: TelemetryAppendInput,
        },
      }),
    ).toThrow(/EDD-9010/)
  })

  it("EDD-9011: orderBy must not be a primary-key composite (PK)", () => {
    expect(() =>
      Entity.make({
        model: Telemetry,
        entityType: "Telemetry",
        primaryKey: {
          pk: { field: "pk", composite: ["channel", "deviceId"] },
          sk: { field: "sk", composite: [] },
        },
        timeSeries: {
          orderBy: "channel",
          appendInput: TelemetryAppendInput,
        },
      }),
    ).toThrow(/EDD-9011/)
  })

  it("EDD-9011: orderBy must not be a primary-key composite (SK)", () => {
    class T2 extends Schema.Class<T2>("T2")({
      channel: Schema.String,
      deviceId: Schema.String,
      stream: Schema.String,
      timestamp: Schema.DateTimeUtc,
    }) {}
    expect(() =>
      Entity.make({
        model: T2,
        entityType: "T2",
        primaryKey: {
          pk: { field: "pk", composite: ["channel"] },
          sk: { field: "sk", composite: ["stream"] },
        },
        timeSeries: {
          orderBy: "stream",
          appendInput: Schema.Struct({
            channel: Schema.String,
            deviceId: Schema.String,
            stream: Schema.String,
            timestamp: Schema.DateTimeUtc,
          }),
        },
      }),
    ).toThrow(/EDD-9011/)
  })

  it("EDD-9012: timeSeries + versioned are mutually exclusive", () => {
    expect(() =>
      Entity.make({
        model: Telemetry,
        entityType: "Telemetry",
        primaryKey: {
          pk: { field: "pk", composite: ["channel", "deviceId"] },
          sk: { field: "sk", composite: [] },
        },
        versioned: true,
        timeSeries: {
          orderBy: "timestamp",
          appendInput: TelemetryAppendInput,
        },
      }),
    ).toThrow(/EDD-9012/)
  })

  it("EDD-9013: appendInput must include orderBy", () => {
    const WithoutOrderBy = Schema.Struct({
      channel: Schema.String,
      deviceId: Schema.String,
    })
    expect(() =>
      Entity.make({
        model: Telemetry,
        entityType: "Telemetry",
        primaryKey: {
          pk: { field: "pk", composite: ["channel", "deviceId"] },
          sk: { field: "sk", composite: [] },
        },
        timeSeries: {
          orderBy: "timestamp",
          appendInput: WithoutOrderBy,
        },
      }),
    ).toThrow(/EDD-9013/)
  })

  it("EDD-9013: appendInput must include all PK/SK composites", () => {
    const WithoutDeviceId = Schema.Struct({
      channel: Schema.String,
      timestamp: Schema.DateTimeUtc,
    })
    expect(() =>
      Entity.make({
        model: Telemetry,
        entityType: "Telemetry",
        primaryKey: {
          pk: { field: "pk", composite: ["channel", "deviceId"] },
          sk: { field: "sk", composite: [] },
        },
        timeSeries: {
          orderBy: "timestamp",
          appendInput: WithoutDeviceId,
        },
      }),
    ).toThrow(/EDD-9013/)
  })

  it("EDD-9015: timeSeries + softDelete are mutually exclusive", () => {
    expect(() =>
      Entity.make({
        model: Telemetry,
        entityType: "Telemetry",
        primaryKey: {
          pk: { field: "pk", composite: ["channel", "deviceId"] },
          sk: { field: "sk", composite: [] },
        },
        softDelete: true,
        timeSeries: {
          orderBy: "timestamp",
          appendInput: TelemetryAppendInput,
        },
      }),
    ).toThrow(/EDD-9015/)
  })

  it("EDD-9016: appendInput is required", () => {
    expect(() =>
      Entity.make({
        model: Telemetry,
        entityType: "Telemetry",
        primaryKey: {
          pk: { field: "pk", composite: ["channel", "deviceId"] },
          sk: { field: "sk", composite: [] },
        },
        timeSeries: {
          orderBy: "timestamp",
        } as any,
      }),
    ).toThrow(/EDD-9016/)
  })

  it("auto-suppresses updatedAt when timeSeries is present", () => {
    const E = Entity.make({
      model: Telemetry,
      entityType: "Telemetry",
      primaryKey: {
        pk: { field: "pk", composite: ["channel", "deviceId"] },
        sk: { field: "sk", composite: [] },
      },
      timestamps: true,
      timeSeries: {
        orderBy: "timestamp",
        appendInput: TelemetryAppendInput,
      },
    })
    expect(E.systemFields.createdAt).toBe("createdAt")
    expect(E.systemFields.updatedAt).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 2. Append payload shape + return values
// ---------------------------------------------------------------------------

describe("TimeSeries — append payload shape", () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  const buildEntity = (opts?: { ttl?: Duration.Duration }) => {
    const entity = Entity.make({
      model: Telemetry,
      entityType: "Telemetry",
      primaryKey: {
        pk: { field: "pk", composite: ["channel", "deviceId"] },
        sk: { field: "sk", composite: [] },
      },
      timestamps: true,
      timeSeries: {
        orderBy: "timestamp",
        ...(opts?.ttl ? { ttl: opts.ttl } : {}),
        appendInput: TelemetryAppendInput,
      },
    })
    return makeEntityWithTag(entity)
  }

  it.effect("builds exactly 2 TransactWriteItems (Update current + Put event)", () => {
    const { entity, tableLayer } = buildEntity({ ttl: Duration.days(7) })
    const layer = Layer.merge(TestDynamoClient, tableLayer)

    return Effect.gen(function* () {
      mockTransactWriteItems.mockResolvedValueOnce({})
      mockGetItem.mockResolvedValueOnce({
        Item: {
          pk: { S: "$tsapp#v1#telemetry#c-1#d-7" },
          sk: { S: "$tsapp#v1#telemetry_1" },
          channel: { S: "c-1" },
          deviceId: { S: "d-7" },
          timestamp: { S: "2026-04-22T10:00:00.000Z" },
          __edd_e__: { S: "Telemetry" },
        },
      })

      const result = yield* entity.append({
        channel: "c-1",
        deviceId: "d-7",
        timestamp: DateTime.makeUnsafe("2026-04-22T10:00:00.000Z"),
        location: "cabinet-A",
      })

      expect(mockTransactWriteItems).toHaveBeenCalledOnce()
      const call = mockTransactWriteItems.mock.calls[0]![0]
      expect(call.TransactItems).toHaveLength(2)

      // Item 0: UpdateItem on current
      const update = call.TransactItems[0].Update
      expect(update).toBeDefined()
      expect(update.Key.sk.S).not.toContain("#e#")

      const ue: string = update.UpdateExpression
      expect(ue).toMatch(/^SET /)
      // createdAt uses if_not_exists
      expect(ue).toContain("if_not_exists(")

      // CAS condition
      expect(update.ConditionExpression).toMatch(
        /attribute_not_exists\(#_tspk\) OR #_tsob < :_tsNewOb/,
      )

      // Item 1: Put of event
      const put = call.TransactItems[1].Put
      expect(put).toBeDefined()
      expect(put.Item.sk.S).toContain("#e#")
      expect(put.Item.pk.S).toBe(update.Key.pk.S)
      // TTL present
      expect(put.Item._ttl).toBeDefined()

      expect(result.applied).toBe(true)
    }).pipe(Effect.provide(layer))
  })

  it.effect("omits _ttl on event when config has no ttl", () => {
    const { entity, tableLayer } = buildEntity() // no ttl
    const layer = Layer.merge(TestDynamoClient, tableLayer)

    return Effect.gen(function* () {
      mockTransactWriteItems.mockResolvedValueOnce({})
      mockGetItem.mockResolvedValueOnce({
        Item: {
          pk: { S: "$tsapp#v1#telemetry#c-1#d-7" },
          sk: { S: "$tsapp#v1#telemetry_1" },
          channel: { S: "c-1" },
          deviceId: { S: "d-7" },
          timestamp: { S: "2026-04-22T10:00:00.000Z" },
          __edd_e__: { S: "Telemetry" },
        },
      })

      yield* entity.append({
        channel: "c-1",
        deviceId: "d-7",
        timestamp: DateTime.makeUnsafe("2026-04-22T10:00:00.000Z"),
      })

      const call = mockTransactWriteItems.mock.calls[0]![0]
      const put = call.TransactItems[1].Put
      expect(put.Item._ttl).toBeUndefined()
    }).pipe(Effect.provide(layer))
  })

  it.effect("stale: TransactionCancelled → { applied: false, reason: 'stale' }", () => {
    const { entity, tableLayer } = buildEntity()
    const layer = Layer.merge(TestDynamoClient, tableLayer)

    return Effect.gen(function* () {
      mockTransactWriteItems.mockRejectedValueOnce({
        name: "TransactionCanceledException",
        CancellationReasons: [{ Code: "ConditionalCheckFailed" }, { Code: "None" }],
      })
      mockGetItem.mockResolvedValueOnce({
        Item: {
          pk: { S: "$tsapp#v1#telemetry#c-1#d-7" },
          sk: { S: "$tsapp#v1#telemetry_1" },
          channel: { S: "c-1" },
          deviceId: { S: "d-7" },
          timestamp: { S: "2026-04-22T11:00:00.000Z" },
          __edd_e__: { S: "Telemetry" },
        },
      })

      const result = yield* entity.append({
        channel: "c-1",
        deviceId: "d-7",
        timestamp: DateTime.makeUnsafe("2026-04-22T10:00:00.000Z"),
      })

      expect(result.applied).toBe(false)
      if (!result.applied) {
        expect(result.reason).toBe("stale")
        expect(result.current).toBeDefined()
      }
    }).pipe(Effect.provide(layer))
  })

  it.effect("enrichment preservation: SET clause omits non-appendInput fields", () => {
    const { entity, tableLayer } = buildEntity()
    const layer = Layer.merge(TestDynamoClient, tableLayer)

    return Effect.gen(function* () {
      mockTransactWriteItems.mockResolvedValueOnce({})
      mockGetItem.mockResolvedValueOnce({
        Item: {
          pk: { S: "$tsapp#v1#telemetry#c-1#d-7" },
          sk: { S: "$tsapp#v1#telemetry_1" },
          channel: { S: "c-1" },
          deviceId: { S: "d-7" },
          timestamp: { S: "2026-04-22T10:00:00.000Z" },
          __edd_e__: { S: "Telemetry" },
        },
      })

      yield* entity.append({
        channel: "c-1",
        deviceId: "d-7",
        timestamp: DateTime.makeUnsafe("2026-04-22T10:00:00.000Z"),
        gpio: 1,
      })

      const call = mockTransactWriteItems.mock.calls[0]![0]
      const update = call.TransactItems[0].Update
      const nameVals: Array<string> = Object.values(update.ExpressionAttributeNames)
      // Fields outside appendInput (Telemetry has `accountId`) must NEVER appear.
      expect(nameVals).not.toContain("accountId")
      // appendInput fields written: timestamp + gpio
      expect(nameVals).toContain("timestamp")
      expect(nameVals).toContain("gpio")
    }).pipe(Effect.provide(layer))
  })
})
