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
import { DateTime, Duration, Effect, Layer, Option, Schema } from "effect"
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

      // Stale-as-error contract: success returns `{ current }` directly.
      expect(result.current).toBeDefined()
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

  it.effect("stale: TransactionCancelled (older orderBy) → fails with StaleAppend", () => {
    const { entity, tableLayer } = buildEntity()
    const layer = Layer.merge(TestDynamoClient, tableLayer)

    return Effect.gen(function* () {
      mockTransactWriteItems.mockRejectedValueOnce({
        name: "TransactionCanceledException",
        CancellationReasons: [{ Code: "ConditionalCheckFailed" }, { Code: "None" }],
      })
      // Stored orderBy is NEWER than attempted → CAS fired.
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

      const result = yield* entity
        .append({
          channel: "c-1",
          deviceId: "d-7",
          timestamp: DateTime.makeUnsafe("2026-04-22T10:00:00.000Z"),
        })
        .pipe(Effect.flip)

      expect(result._tag).toBe("StaleAppend")
      if (result._tag === "StaleAppend") {
        expect(result.entityType).toBe("Telemetry")
        expect(result.orderByField).toBe("timestamp")
        expect(Option.isSome(result.current)).toBe(true)
      }
    }).pipe(Effect.provide(layer))
  })

  it.effect("stale: equal orderBy (strict <) → fails with StaleAppend", () => {
    const { entity, tableLayer } = buildEntity()
    const layer = Layer.merge(TestDynamoClient, tableLayer)

    return Effect.gen(function* () {
      mockTransactWriteItems.mockRejectedValueOnce({
        name: "TransactionCanceledException",
        CancellationReasons: [{ Code: "ConditionalCheckFailed" }, { Code: "None" }],
      })
      // Stored orderBy is EQUAL to attempted → CAS fired (strict <).
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

      const result = yield* entity
        .append({
          channel: "c-1",
          deviceId: "d-7",
          timestamp: DateTime.makeUnsafe("2026-04-22T10:00:00.000Z"),
        })
        .pipe(Effect.flip)

      expect(result._tag).toBe("StaleAppend")
    }).pipe(Effect.provide(layer))
  })

  it.effect(
    "user-condition rejection (CAS held, stored < attempted) → fails with ConditionalCheckFailed",
    () => {
      const { entity, tableLayer } = buildEntity()
      const layer = Layer.merge(TestDynamoClient, tableLayer)

      return Effect.gen(function* () {
        mockTransactWriteItems.mockRejectedValueOnce({
          name: "TransactionCanceledException",
          CancellationReasons: [{ Code: "ConditionalCheckFailed" }, { Code: "None" }],
        })
        // Stored orderBy is OLDER than attempted → CAS would have HELD, so the
        // user-supplied condition is the only thing that could have rejected.
        mockGetItem.mockResolvedValueOnce({
          Item: {
            pk: { S: "$tsapp#v1#telemetry#c-1#d-7" },
            sk: { S: "$tsapp#v1#telemetry_1" },
            channel: { S: "c-1" },
            deviceId: { S: "d-7" },
            timestamp: { S: "2026-04-22T09:00:00.000Z" },
            __edd_e__: { S: "Telemetry" },
          },
        })

        const result = yield* (entity as any)
          .append(
            {
              channel: "c-1",
              deviceId: "d-7",
              timestamp: DateTime.makeUnsafe("2026-04-22T10:00:00.000Z"),
            },
            // User condition (any plausible shorthand)
            { eq: { location: "rack-1" } },
          )
          .pipe(Effect.flip)

        expect(result._tag).toBe("ConditionalCheckFailed")
        if (result._tag === "ConditionalCheckFailed") {
          expect(result.entityType).toBe("Telemetry")
          expect(Option.isSome(result.current)).toBe(true)
        }
      }).pipe(Effect.provide(layer))
    },
  )

  it.effect(
    "stale takes precedence: CAS-fail AND user-condition-fail (stored >= attempted) → StaleAppend",
    () => {
      const { entity, tableLayer } = buildEntity()
      const layer = Layer.merge(TestDynamoClient, tableLayer)

      return Effect.gen(function* () {
        mockTransactWriteItems.mockRejectedValueOnce({
          name: "TransactionCanceledException",
          CancellationReasons: [{ Code: "ConditionalCheckFailed" }, { Code: "None" }],
        })
        // Stored orderBy is NEWER than attempted → CAS fired. We don't know if
        // user-condition would also have rejected; CAS takes precedence.
        mockGetItem.mockResolvedValueOnce({
          Item: {
            pk: { S: "$tsapp#v1#telemetry#c-1#d-7" },
            sk: { S: "$tsapp#v1#telemetry_1" },
            channel: { S: "c-1" },
            deviceId: { S: "d-7" },
            timestamp: { S: "2026-04-22T12:00:00.000Z" },
            __edd_e__: { S: "Telemetry" },
          },
        })

        const result = yield* (entity as any)
          .append(
            {
              channel: "c-1",
              deviceId: "d-7",
              timestamp: DateTime.makeUnsafe("2026-04-22T10:00:00.000Z"),
            },
            { eq: { location: "rack-1" } },
          )
          .pipe(Effect.flip)

        expect(result._tag).toBe("StaleAppend")
      }).pipe(Effect.provide(layer))
    },
  )

  it.effect("skipFollowUp on success: returns void, no GetItem issued", () => {
    const { entity, tableLayer } = buildEntity()
    const layer = Layer.merge(TestDynamoClient, tableLayer)

    return Effect.gen(function* () {
      mockTransactWriteItems.mockResolvedValueOnce({})
      // Note: NO mockGetItem.mockResolvedValueOnce — if GetItem is called,
      // mockGetItem returns undefined and the test will fail differently.

      const result = yield* (entity as any).append(
        {
          channel: "c-1",
          deviceId: "d-7",
          timestamp: DateTime.makeUnsafe("2026-04-22T10:00:00.000Z"),
        },
        undefined,
        true,
      )

      expect(result).toBeUndefined()
      expect(mockGetItem).not.toHaveBeenCalled()
      expect(mockTransactWriteItems).toHaveBeenCalledOnce()
    }).pipe(Effect.provide(layer))
  })

  it.effect(
    "skipFollowUp on stale: fails with StaleAppend(current=Option.none), no GetItem",
    () => {
      const { entity, tableLayer } = buildEntity()
      const layer = Layer.merge(TestDynamoClient, tableLayer)

      return Effect.gen(function* () {
        mockTransactWriteItems.mockRejectedValueOnce({
          name: "TransactionCanceledException",
          CancellationReasons: [{ Code: "ConditionalCheckFailed" }, { Code: "None" }],
        })

        const result = yield* (entity as any)
          .append(
            {
              channel: "c-1",
              deviceId: "d-7",
              timestamp: DateTime.makeUnsafe("2026-04-22T10:00:00.000Z"),
            },
            undefined,
            true,
          )
          .pipe(Effect.flip)

        expect(result._tag).toBe("StaleAppend")
        if (result._tag === "StaleAppend") {
          expect(Option.isNone(result.current)).toBe(true)
        }
        expect(mockGetItem).not.toHaveBeenCalled()
      }).pipe(Effect.provide(layer))
    },
  )

  it.effect(
    "skipFollowUp on user-condition rejection: also fails with StaleAppend (cannot disambiguate)",
    () => {
      const { entity, tableLayer } = buildEntity()
      const layer = Layer.merge(TestDynamoClient, tableLayer)

      return Effect.gen(function* () {
        mockTransactWriteItems.mockRejectedValueOnce({
          name: "TransactionCanceledException",
          CancellationReasons: [{ Code: "ConditionalCheckFailed" }, { Code: "None" }],
        })

        const result = yield* (entity as any)
          .append(
            {
              channel: "c-1",
              deviceId: "d-7",
              timestamp: DateTime.makeUnsafe("2026-04-22T10:00:00.000Z"),
            },
            { eq: { location: "rack-1" } },
            true, // skipFollowUp
          )
          .pipe(Effect.flip)

        // Without the follow-up GetItem we cannot tell CAS-stale from
        // user-condition rejection. Both modes collapse to StaleAppend.
        expect(result._tag).toBe("StaleAppend")
      }).pipe(Effect.provide(layer))
    },
  )

  it.effect(
    "TTL race / row vanished after success: fails with ValidationError(append.followUp)",
    () => {
      const { entity, tableLayer } = buildEntity()
      const layer = Layer.merge(TestDynamoClient, tableLayer)

      return Effect.gen(function* () {
        mockTransactWriteItems.mockResolvedValueOnce({})
        // Item vanished from the table between transaction and GetItem.
        mockGetItem.mockResolvedValueOnce({})

        const result = yield* entity
          .append({
            channel: "c-1",
            deviceId: "d-7",
            timestamp: DateTime.makeUnsafe("2026-04-22T10:00:00.000Z"),
          })
          .pipe(Effect.flip)

        expect(result._tag).toBe("ValidationError")
        if (result._tag === "ValidationError") {
          expect(result.operation).toBe("append.followUp")
        }
      }).pipe(Effect.provide(layer))
    },
  )

  it.effect("TTL race on skipFollowUp path: succeeds silently (undetected)", () => {
    const { entity, tableLayer } = buildEntity()
    const layer = Layer.merge(TestDynamoClient, tableLayer)

    return Effect.gen(function* () {
      mockTransactWriteItems.mockResolvedValueOnce({})

      const result = yield* (entity as any).append(
        {
          channel: "c-1",
          deviceId: "d-7",
          timestamp: DateTime.makeUnsafe("2026-04-22T10:00:00.000Z"),
        },
        undefined,
        true,
      )

      // No detection on skipFollowUp — GetItem was never issued.
      expect(result).toBeUndefined()
      expect(mockGetItem).not.toHaveBeenCalled()
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

  // Regression: class-instance values in appendInput were marshalled via
  // toAttributeValue without convertClassInstanceToMap, throwing at runtime.
  // https://github.com/jmenga/effect-dynamodb/issues/12
  it.effect("append accepts a nested Schema.Class instance in the SET clause", () => {
    class Point extends Schema.Class<Point>("Point")({
      type: Schema.Literal("Point"),
      coordinates: Schema.Array(Schema.Number),
    }) {}
    class Reading extends Schema.Class<Reading>("Reading")({
      channel: Schema.String,
      deviceId: Schema.String,
      timestamp: Schema.DateTimeUtc,
      geometry: Schema.optional(Point),
    }) {}
    const AppendInput = Schema.Struct({
      channel: Schema.String,
      deviceId: Schema.String,
      timestamp: Schema.DateTimeUtc,
      geometry: Schema.optional(Point),
    })

    const entity = Entity.make({
      model: Reading,
      entityType: "Reading",
      primaryKey: {
        pk: { field: "pk", composite: ["channel", "deviceId"] },
        sk: { field: "sk", composite: [] },
      },
      timeSeries: {
        orderBy: "timestamp",
        appendInput: AppendInput,
      },
    })
    const { entity: wired, tableLayer } = makeEntityWithTag(entity)
    const layer = Layer.merge(TestDynamoClient, tableLayer)

    return Effect.gen(function* () {
      mockTransactWriteItems.mockResolvedValueOnce({})
      mockGetItem.mockResolvedValueOnce({
        Item: {
          pk: { S: "$tsapp#v1#reading#c-1#d-7" },
          sk: { S: "$tsapp#v1#reading_1" },
          channel: { S: "c-1" },
          deviceId: { S: "d-7" },
          timestamp: { S: "2026-04-22T10:00:00.000Z" },
          geometry: {
            M: {
              type: { S: "Point" },
              coordinates: { L: [{ N: "-87.6298" }, { N: "41.8781" }] },
            },
          },
          __edd_e__: { S: "Reading" },
        },
      })

      yield* wired.append({
        channel: "c-1",
        deviceId: "d-7",
        timestamp: DateTime.makeUnsafe("2026-04-22T10:00:00.000Z"),
        geometry: new Point({ type: "Point", coordinates: [-87.6298, 41.8781] }),
      })

      const call = mockTransactWriteItems.mock.calls[0]![0]
      // Update SET clause marshalls the class instance as a map.
      const update = call.TransactItems[0].Update
      const mapValue = Object.values(update.ExpressionAttributeValues).find(
        (v: any) => v.M?.type?.S === "Point",
      ) as any
      expect(mapValue).toBeDefined()
      expect(mapValue.M.coordinates.L).toEqual([{ N: "-87.6298" }, { N: "41.8781" }])
      // Put of event item also marshalls through toAttributeMap (already worked).
      const put = call.TransactItems[1].Put
      expect(put.Item.geometry.M.type.S).toBe("Point")
    }).pipe(Effect.provide(layer))
  })
})

// ---------------------------------------------------------------------------
// 4. indexPolicy during .append() — hybrid-writer GSI semantics
// ---------------------------------------------------------------------------

describe("TimeSeries — indexPolicy on append", () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  // A hybrid GSI like `byAccountAlert` from issue #11: pk has enrichment-owned
  // attrs (not in appendInput), sk has the event clock (in appendInput).
  const buildHybridEntity = () => {
    const entity = Entity.make({
      model: Telemetry,
      entityType: "Telemetry",
      primaryKey: {
        pk: { field: "pk", composite: ["channel", "deviceId"] },
        sk: { field: "sk", composite: [] },
      },
      indexes: {
        byAccountAlert: {
          name: "gsi6",
          // v3 design rule: each GSI half should be entirely owned by a single
          // writer's domain. PK is enrichment-owned (accountId, set out-of-band);
          // SK is ingest-owned (alert + timestamp, set on every event).
          pk: { field: "gsi6pk", composite: ["accountId"] },
          sk: { field: "gsi6sk", composite: ["alert", "timestamp"] },
          // PK preserve: when an ingest append fires without accountId in
          // appendInput, the half's leading prefix is empty → no-op → stored
          // gsi6pk left untouched. SK preserve: alert + timestamp are both in
          // appendInput → SET on every append.
          indexPolicy: { pk: "preserve", sk: "preserve" },
        },
      },
      timestamps: true,
      timeSeries: {
        orderBy: "timestamp",
        appendInput: TelemetryAppendInput,
      },
    })
    return makeEntityWithTag(entity)
  }

  it.effect("hybrid GSI: non-appendInput pk composite is preserved; sk recomposes", () => {
    const { entity, tableLayer } = buildHybridEntity()
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

      // Ingest-style append: only clock + event fields. `accountId` is not in
      // appendInput — owned by a separate enrichment writer.
      yield* entity.append({
        channel: "c-1",
        deviceId: "d-7",
        timestamp: DateTime.makeUnsafe("2026-04-22T10:00:00.000Z"),
        alert: true,
      })

      const call = mockTransactWriteItems.mock.calls[0]![0]
      const update = call.TransactItems[0].Update
      const nameVals: Array<string> = Object.values(update.ExpressionAttributeNames)
      const expr = update.UpdateExpression as string

      // gsi6pk must NOT be SET (accountId missing, preserved).
      // `alert` composite alone cannot build the pk (accountId missing), so the
      // half is untouched.
      expect(expr).not.toMatch(/SET[^R]*gsi6pk/)
      // gsi6sk (timestamp) must be SET — the clock half is fully present.
      expect(nameVals).toContain("gsi6sk")
      // No REMOVE of gsi6 keys (the item stays in the index with its existing pk).
      expect(expr).not.toMatch(/REMOVE[^S]*gsi6pk/)
    }).pipe(Effect.provide(layer))
  })

  it.effect(
    "appendInput-owned composite with sparse + touched-but-can't-compose drops only that half (v1.7.1)",
    () => {
      // v1.7.1 behavior change: sparse only fires when the writer touches the
      // half (per-half evaluation gate). A bare omission of `alert` from the
      // appendInput payload no longer fires sparse on the byAlert.pk half —
      // the half is untouched. To force a drop, declare `alert` in
      // appendInput so the writer's "no alert this event" intent is
      // explicitly signalled (alert: undefined in the payload), or use
      // Entity.remove(['alert']) on the next update.
      //
      // For a writer-owned sparse half that's actually IN appendInput,
      // touching the half with undefined → can't-compose → REMOVE that half
      // only. We exercise that here by adding `alert: undefined` to the
      // append payload.
      const entity = Entity.make({
        model: Telemetry,
        entityType: "Telemetry",
        primaryKey: {
          pk: { field: "pk", composite: ["channel", "deviceId"] },
          sk: { field: "sk", composite: [] },
        },
        indexes: {
          byAlert: {
            name: "gsi2",
            pk: { field: "gsi2pk", composite: ["alert"] },
            sk: { field: "gsi2sk", composite: ["timestamp"] },
            // v1.7.1: per-half SK preserve, PK sparse. PK touched (alert in
            // appendInput, supplied as undefined) and can't compose → REMOVE
            // gsi2pk only. SK touched (timestamp present) → SET sk.
            indexPolicy: { pk: "sparse", sk: "preserve" },
          },
        },
        timestamps: true,
        timeSeries: {
          orderBy: "timestamp",
          appendInput: TelemetryAppendInput,
        },
      })
      const { tableLayer } = makeEntityWithTag(entity)
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

        // Ingest event with `alert: undefined` — the writer explicitly
        // signals "no alert this event," sk's pk half is touched (in
        // operator true on undefined), can't compose → sparse → REMOVE pk.
        // sk is touched (timestamp present) → SET sk.
        yield* entity.append({
          channel: "c-1",
          deviceId: "d-7",
          timestamp: DateTime.makeUnsafe("2026-04-22T10:00:00.000Z"),
          alert: undefined,
        })

        const call = mockTransactWriteItems.mock.calls[0]![0]
        const update = call.TransactItems[0].Update
        const expr = update.UpdateExpression as string
        const eanEntries = Object.entries(update.ExpressionAttributeNames) as Array<
          [string, string]
        >
        const aliasOf = (physical: string) => eanEntries.find(([_, v]) => v === physical)?.[0]
        const gsi2pkAlias = aliasOf("gsi2pk")
        const gsi2skAlias = aliasOf("gsi2sk")
        expect(gsi2pkAlias).toBeDefined()
        expect(gsi2skAlias).toBeDefined()
        // gsi2pk REMOVE'd via sparse + can't-compose. gsi2sk SET (timestamp).
        const removeIdx = expr.indexOf("REMOVE")
        const setExpr = removeIdx === -1 ? expr : expr.slice(0, removeIdx)
        const remExpr = removeIdx === -1 ? "" : expr.slice(removeIdx)
        expect(remExpr.includes(gsi2pkAlias!)).toBe(true)
        expect(setExpr.includes(gsi2pkAlias!)).toBe(false)
        // v1.7.1 critical: per-half drop. gsi2sk SET (NOT removed).
        expect(setExpr.includes(gsi2skAlias!)).toBe(true)
        expect(remExpr.includes(gsi2skAlias!)).toBe(false)
      }).pipe(Effect.provide(layer))
    },
  )
})
