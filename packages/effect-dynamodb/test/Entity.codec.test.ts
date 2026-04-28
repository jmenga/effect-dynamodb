/**
 * Codec direction tests — round-trip every (domain, storage) date combination
 * via put + get against mocked DynamoClient.
 *
 * Backs github issue #29: Entity.put rejected Schema.RedactedFromValue
 * (and any other transform schema) because the write path was decoding
 * instead of encoding. After the fix, the write path is `Schema.encode` end
 * to end, with self date schemas substituted at `Entity.make()` time and
 * RedactedFromValue substituted with a custom transform that allows encoding.
 */

import { describe, expect, it } from "@effect/vitest"
import { DateTime, Effect, Layer, Redacted, Schema } from "effect"
import { beforeEach, vi } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import * as DynamoModel from "../src/DynamoModel.js"
import * as DynamoSchema from "../src/DynamoSchema.js"
import * as Entity from "../src/Entity.js"
import { DynamoError } from "../src/Errors.js"
import { toAttributeMap } from "../src/Marshaller.js"
import * as Table from "../src/Table.js"

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const AppSchema = DynamoSchema.make({ name: "myapp", version: 1 })
const MainTable = Table.make({ schema: AppSchema })

const withConfig = <E extends { _configure: Function }>(entity: E): E => {
  entity._configure(AppSchema, MainTable.Tag)
  return entity
}

const mockPutItem = vi.fn()
const mockGetItem = vi.fn()

const TestDynamoClient = Layer.succeed(DynamoClient, {
  putItem: (input) =>
    Effect.tryPromise({
      try: () => mockPutItem(input),
      catch: (e) => new DynamoError({ operation: "PutItem", cause: e }),
    }),
  getItem: (input) =>
    Effect.tryPromise({
      try: () => mockGetItem(input),
      catch: (e) => new DynamoError({ operation: "GetItem", cause: e }),
    }),
  deleteItem: () => Effect.die("not used"),
  updateItem: () => Effect.die("not used"),
  query: () => Effect.die("not used"),
  transactWriteItems: () => Effect.die("not used"),
  batchGetItem: () => Effect.die("not used"),
  batchWriteItem: () => Effect.die("not used"),
  transactGetItems: () => Effect.die("not used"),
  createTable: () => Effect.die("not used"),
  deleteTable: () => Effect.die("not used"),
  describeTable: () => Effect.die("not used"),
  scan: () => Effect.die("not used"),
})

const TestTableConfig = MainTable.layer({ name: "test-table" })
const TestLayer = Layer.merge(TestDynamoClient, TestTableConfig)

const baseKey = { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } }
const epochMs = 1704067200000 // 2024-01-01T00:00:00.000Z
const epochSec = 1704067200
const isoString = "2024-01-01T00:00:00.000Z"

// ---------------------------------------------------------------------------
// Date matrix: (domain, storage) round-trip via Pattern A (self schema +
// annotation/override) and Pattern B (transform).
// ---------------------------------------------------------------------------

describe("Entity codec direction — date matrix", () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  // -------------------- Pattern A: self schema + annotation --------------------

  describe("Pattern A — self DateTime.Utc + storedAs annotation", () => {
    it.effect("DateTime.Utc + string storage round-trips", () =>
      Effect.gen(function* () {
        class M extends Schema.Class<M>("M")({
          id: Schema.String,
          ts: Schema.DateTimeUtc.pipe(DynamoModel.storedAs(DynamoModel.DateString)),
        }) {}
        const E = withConfig(
          Entity.make({ model: M, entityType: "M", primaryKey: baseKey, timestamps: false }),
        )
        mockPutItem.mockResolvedValue({})
        yield* E.put({ id: "x", ts: DateTime.makeUnsafe(epochMs) }).asEffect()
        expect(mockPutItem.mock.calls[0]![0].Item.ts).toEqual({ S: isoString })

        mockGetItem.mockResolvedValue({
          Item: toAttributeMap({
            pk: "$myapp#v1#m#x",
            sk: "$myapp#v1#m",
            id: "x",
            ts: isoString,
            __edd_e__: "M",
          }),
        })
        const r = yield* E.get({ id: "x" }).asEffect()
        expect(DateTime.isDateTime(r.ts)).toBe(true)
        expect(DateTime.toEpochMillis(r.ts)).toBe(epochMs)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("DateTime.Utc + epochMs storage round-trips", () =>
      Effect.gen(function* () {
        class M extends Schema.Class<M>("M")({
          id: Schema.String,
          ts: Schema.DateTimeUtc.pipe(DynamoModel.storedAs(DynamoModel.DateEpochMs)),
        }) {}
        const E = withConfig(
          Entity.make({ model: M, entityType: "M2", primaryKey: baseKey, timestamps: false }),
        )
        mockPutItem.mockResolvedValue({})
        yield* E.put({ id: "x", ts: DateTime.makeUnsafe(epochMs) }).asEffect()
        expect(mockPutItem.mock.calls[0]![0].Item.ts).toEqual({ N: String(epochMs) })

        mockGetItem.mockResolvedValue({
          Item: toAttributeMap({
            pk: "$myapp#v1#m2#x",
            sk: "$myapp#v1#m2",
            id: "x",
            ts: epochMs,
            __edd_e__: "M2",
          }),
        })
        const r = yield* E.get({ id: "x" }).asEffect()
        expect(DateTime.toEpochMillis(r.ts)).toBe(epochMs)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("DateTime.Utc + epochSeconds storage round-trips", () =>
      Effect.gen(function* () {
        class M extends Schema.Class<M>("M")({
          id: Schema.String,
          ts: Schema.DateTimeUtc.pipe(DynamoModel.storedAs(DynamoModel.DateEpochSeconds)),
        }) {}
        const E = withConfig(
          Entity.make({ model: M, entityType: "M3", primaryKey: baseKey, timestamps: false }),
        )
        mockPutItem.mockResolvedValue({})
        yield* E.put({ id: "x", ts: DateTime.makeUnsafe(epochMs) }).asEffect()
        expect(mockPutItem.mock.calls[0]![0].Item.ts).toEqual({ N: String(epochSec) })

        mockGetItem.mockResolvedValue({
          Item: toAttributeMap({
            pk: "$myapp#v1#m3#x",
            sk: "$myapp#v1#m3",
            id: "x",
            ts: epochSec,
            __edd_e__: "M3",
          }),
        })
        const r = yield* E.get({ id: "x" }).asEffect()
        expect(DateTime.toEpochMillis(r.ts)).toBe(epochMs)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("Date + epochSeconds storage round-trips", () =>
      Effect.gen(function* () {
        class M extends Schema.Class<M>("M")({
          id: Schema.String,
          ts: Schema.DateValid.pipe(DynamoModel.storedAs(DynamoModel.UnsafeDateEpochSeconds)),
        }) {}
        const E = withConfig(
          Entity.make({ model: M, entityType: "M4", primaryKey: baseKey, timestamps: false }),
        )
        mockPutItem.mockResolvedValue({})
        yield* E.put({ id: "x", ts: new Date(epochMs) }).asEffect()
        expect(mockPutItem.mock.calls[0]![0].Item.ts).toEqual({ N: String(epochSec) })

        mockGetItem.mockResolvedValue({
          Item: toAttributeMap({
            pk: "$myapp#v1#m4#x",
            sk: "$myapp#v1#m4",
            id: "x",
            ts: epochSec,
            __edd_e__: "M4",
          }),
        })
        const r = yield* E.get({ id: "x" }).asEffect()
        expect(r.ts).toBeInstanceOf(Date)
        expect((r.ts as Date).getTime()).toBe(epochMs)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("DateTime.Zoned + string storage round-trips", () =>
      Effect.gen(function* () {
        class M extends Schema.Class<M>("M")({
          id: Schema.String,
          ts: Schema.DateTimeZoned,
        }) {}
        const E = withConfig(
          Entity.make({ model: M, entityType: "M5", primaryKey: baseKey, timestamps: false }),
        )
        mockPutItem.mockResolvedValue({})
        const zoned = DateTime.makeZonedUnsafe(new Date(epochMs), { timeZone: "Asia/Tokyo" })
        yield* E.put({ id: "x", ts: zoned }).asEffect()
        const stored = mockPutItem.mock.calls[0]![0].Item.ts.S
        expect(stored).toContain("[Asia/Tokyo]")
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  // -------------------- Pattern B: transform owns the wire format --------------------

  describe("Pattern B — transform schema (wire format owned by transform)", () => {
    it.effect("DynamoModel.DateString round-trips", () =>
      Effect.gen(function* () {
        class M extends Schema.Class<M>("M")({
          id: Schema.String,
          ts: DynamoModel.DateString,
        }) {}
        const E = withConfig(
          Entity.make({ model: M, entityType: "M6", primaryKey: baseKey, timestamps: false }),
        )
        mockPutItem.mockResolvedValue({})
        yield* E.put({ id: "x", ts: DateTime.makeUnsafe(epochMs) }).asEffect()
        expect(mockPutItem.mock.calls[0]![0].Item.ts).toEqual({ S: isoString })
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("DynamoModel.DateEpochSeconds round-trips", () =>
      Effect.gen(function* () {
        class M extends Schema.Class<M>("M")({
          id: Schema.String,
          ts: DynamoModel.DateEpochSeconds,
        }) {}
        const E = withConfig(
          Entity.make({ model: M, entityType: "M7", primaryKey: baseKey, timestamps: false }),
        )
        mockPutItem.mockResolvedValue({})
        yield* E.put({ id: "x", ts: DateTime.makeUnsafe(epochMs) }).asEffect()
        expect(mockPutItem.mock.calls[0]![0].Item.ts).toEqual({ N: String(epochSec) })
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("Schema.DateTimeUtcFromString (raw transform) round-trips", () =>
      Effect.gen(function* () {
        class M extends Schema.Class<M>("M")({
          id: Schema.String,
          ts: Schema.DateTimeUtcFromString,
        }) {}
        const E = withConfig(
          Entity.make({ model: M, entityType: "M8", primaryKey: baseKey, timestamps: false }),
        )
        mockPutItem.mockResolvedValue({})
        yield* E.put({ id: "x", ts: DateTime.makeUnsafe(epochMs) }).asEffect()
        expect(mockPutItem.mock.calls[0]![0].Item.ts).toEqual({ S: isoString })
      }).pipe(Effect.provide(TestLayer)),
    )
  })
})

// ---------------------------------------------------------------------------
// RedactedFromValue + non-date transforms — the original issue #29
// ---------------------------------------------------------------------------

describe("Entity codec direction — non-date transforms (issue #29)", () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it.effect("Schema.RedactedFromValue(Schema.String) round-trips", () =>
    Effect.gen(function* () {
      class Chipcode extends Schema.Class<Chipcode>("Chipcode")({
        thingId: Schema.String,
        chipcode: Schema.RedactedFromValue(Schema.String),
        issuedAt: Schema.Number,
      }) {}
      const E = withConfig(
        Entity.make({
          model: Chipcode,
          entityType: "Chipcode",
          primaryKey: {
            pk: { field: "pk", composite: ["thingId"] },
            sk: { field: "sk", composite: [] },
          },
          timestamps: false,
        }),
      )
      mockPutItem.mockResolvedValue({})
      yield* E.put({
        thingId: "thing-1",
        chipcode: Redacted.make("secret-value"),
        issuedAt: 1234567890,
      }).asEffect()
      // Wire form is a plain string, not a Redacted instance.
      expect(mockPutItem.mock.calls[0]![0].Item.chipcode).toEqual({ S: "secret-value" })

      // Read path returns Redacted<string>.
      mockGetItem.mockResolvedValue({
        Item: toAttributeMap({
          pk: "$myapp#v1#chipcode#thing-1",
          sk: "$myapp#v1#chipcode",
          thingId: "thing-1",
          chipcode: "secret-value",
          issuedAt: 1234567890,
          __edd_e__: "Chipcode",
        }),
      })
      const r = yield* E.get({ thingId: "thing-1" }).asEffect()
      // Redacted.value extracts the inner; console.log(record) prints <redacted>.
      expect(Redacted.value(r.chipcode)).toBe("secret-value")
      expect(String(r.chipcode)).toContain("redacted")
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("Schema.NumberFromString round-trips", () =>
    Effect.gen(function* () {
      class M extends Schema.Class<M>("M")({
        id: Schema.String,
        n: Schema.NumberFromString,
      }) {}
      const E = withConfig(
        Entity.make({ model: M, entityType: "MN", primaryKey: baseKey, timestamps: false }),
      )
      mockPutItem.mockResolvedValue({})
      yield* E.put({ id: "x", n: 42 }).asEffect()
      // Wire form is a string, not a number.
      expect(mockPutItem.mock.calls[0]![0].Item.n).toEqual({ S: "42" })

      mockGetItem.mockResolvedValue({
        Item: toAttributeMap({
          pk: "$myapp#v1#mn#x",
          sk: "$myapp#v1#mn",
          id: "x",
          n: "42",
          __edd_e__: "MN",
        }),
      })
      const r = yield* E.get({ id: "x" }).asEffect()
      expect(typeof r.n).toBe("number")
      expect(r.n).toBe(42)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("update().set with Redacted value works", () =>
    Effect.gen(function* () {
      class M extends Schema.Class<M>("M")({
        id: Schema.String,
        secret: Schema.RedactedFromValue(Schema.String),
      }) {}
      const E = withConfig(
        Entity.make({ model: M, entityType: "MR", primaryKey: baseKey, timestamps: false }),
      )
      // Mock updateItem
      const updatedItem = toAttributeMap({
        pk: "$myapp#v1#mr#x",
        sk: "$myapp#v1#mr",
        id: "x",
        secret: "new-secret",
        __edd_e__: "MR",
      })
      // Mock the underlying client.updateItem via a dedicated layer override
      const mockUpdateItem = vi.fn().mockResolvedValue({ Attributes: updatedItem })
      const Layer2 = Layer.succeed(DynamoClient, {
        ...((yield* DynamoClient) as any),
        updateItem: (input: any) =>
          Effect.tryPromise({
            try: () => mockUpdateItem(input),
            catch: (e) => new DynamoError({ operation: "UpdateItem", cause: e }),
          }),
      })
      const r = yield* E.update({ id: "x" })
        .pipe(Entity.set({ secret: Redacted.make("new-secret") }))
        .asEffect()
        .pipe(Effect.provide(Layer2))
      expect(Redacted.value(r.secret)).toBe("new-secret")
      // Confirm wire form is a plain string in the update expression.
      const call = mockUpdateItem.mock.calls[0]![0]
      const stringValues = Object.values(call.ExpressionAttributeValues ?? {}).filter(
        (v: any) => typeof v.S === "string" && v.S === "new-secret",
      )
      expect(stringValues.length).toBeGreaterThan(0)
    }).pipe(Effect.provide(TestLayer)),
  )
})

// ---------------------------------------------------------------------------
// Policy: transform + storage override is rejected at Entity.make() time
// ---------------------------------------------------------------------------

describe("Entity codec direction — policy rejection", () => {
  it("throws when ConfiguredModel.storedAs targets a transform schema", () => {
    class M extends Schema.Class<M>("M")({
      id: Schema.String,
      // Transform schema (wire format = string)
      ts: Schema.DateTimeUtcFromString,
    }) {}
    const Configured = DynamoModel.configure(M, {
      ts: { storedAs: DynamoModel.DateEpochSeconds },
    })
    expect(() =>
      Entity.make({
        model: Configured,
        entityType: "Bad",
        primaryKey: baseKey,
      }),
    ).toThrow(/cannot apply DynamoEncoding storage override to a transform schema/)
  })

  it("throws when DynamoModel.storedAs() modifier targets a transform with mismatched wire kind", () => {
    class M extends Schema.Class<M>("M")({
      id: Schema.String,
      // Transform encodes to string but storedAs forces epoch (number) — conflict.
      ts: DynamoModel.DateString.pipe(DynamoModel.storedAs(DynamoModel.DateEpochSeconds)),
    }) {}
    expect(() =>
      Entity.make({
        model: M,
        entityType: "Bad2",
        primaryKey: baseKey,
      }),
    ).toThrow(/cannot apply DynamoEncoding storage override to a transform schema/)
  })

  it("accepts a self schema + storedAs annotation (no conflict)", () => {
    class M extends Schema.Class<M>("M")({
      id: Schema.String,
      ts: Schema.DateTimeUtc.pipe(DynamoModel.storedAs(DynamoModel.DateEpochSeconds)),
    }) {}
    expect(() =>
      Entity.make({
        model: M,
        entityType: "Good",
        primaryKey: baseKey,
      }),
    ).not.toThrow()
  })

  it("accepts a transform without override (e.g. DynamoModel.DateString)", () => {
    class M extends Schema.Class<M>("M")({
      id: Schema.String,
      ts: DynamoModel.DateString,
    }) {}
    expect(() =>
      Entity.make({
        model: M,
        entityType: "Good2",
        primaryKey: baseKey,
      }),
    ).not.toThrow()
  })
})
