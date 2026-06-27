/**
 * Codec direction tests for `Aggregate` — round-trip every (domain, storage)
 * date combination via create + get against a mocked DynamoClient.
 *
 * Companion to `test/Entity.codec.test.ts`. Aggregates decompose/assemble at
 * the root-attribute level; with the schema-driven refactor (issue #29
 * follow-up), each date field on the root schema is converted via the same
 * substituted bidirectional Schema transform that Entity uses, eliminating
 * the per-field `serializeDateForDynamo` / `deserializeDateFromDynamo`
 * helpers from Marshaller.ts.
 */

import { describe, expect, it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { DynamoError } from "@effect-dynamodb/schema/Errors.js"
import { DateTime, Effect, Layer, Schema } from "effect"
import { beforeEach, vi } from "vitest"
import * as Aggregate from "../src/Aggregate.js"
import { DynamoClient } from "../src/DynamoClient.js"
import { fromAttributeValue, toAttributeMap } from "../src/Marshaller.js"
import * as Table from "../src/Table.js"

// ---------------------------------------------------------------------------
// Shared mock client + table
// ---------------------------------------------------------------------------

const AppSchema = DynamoSchema.make({ name: "myapp", version: 1 })
const MainTable = Table.make({ schema: AppSchema })

const mockQuery = vi.fn()
const mockTransactWrite = vi.fn()

const TestDynamoClient = Layer.succeed(DynamoClient, {
  query: (input) =>
    Effect.tryPromise({
      try: () => mockQuery(input),
      catch: (e) => new DynamoError({ operation: "Query", cause: e }),
    }),
  transactWriteItems: (input) =>
    Effect.tryPromise({
      try: () => mockTransactWrite(input),
      catch: (e) => new DynamoError({ operation: "TransactWriteItems", cause: e }),
    }),
  putItem: () => Effect.die("not used"),
  getItem: () => Effect.die("not used"),
  deleteItem: () => Effect.die("not used"),
  updateItem: () => Effect.die("not used"),
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

const epochMs = 1704067200000 // 2024-01-01T00:00:00.000Z
const epochSec = 1704067200
const isoString = "2024-01-01T00:00:00.000Z"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Capture the raw root attribute value written to DynamoDB for a given
 * field. The aggregate's transactWriteItems payload contains the marshalled
 * AttributeValue map, so we unmarshall a single field via fromAttributeValue.
 */
const captureField = (field: string): { value: () => unknown } => {
  let captured: unknown
  mockTransactWrite.mockImplementation((input: Record<string, unknown>) => {
    const items = (input as any).TransactItems as Array<{ Put?: { Item?: Record<string, any> } }>
    const item = items[0]?.Put?.Item
    captured = item ? fromAttributeValue(item[field]) : undefined
    return Promise.resolve({})
  })
  return { value: () => captured }
}

// ---------------------------------------------------------------------------
// Date matrix tests
// ---------------------------------------------------------------------------

describe("Aggregate codec direction — date matrix", () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  // ------------------- Pattern A — self DateTime.Utc + storedAs --------------

  describe("Pattern A — self DateTime.Utc + storedAs annotation", () => {
    it.effect("DateTime.Utc + string storage round-trips", () =>
      Effect.gen(function* () {
        class M extends Schema.Class<M>("M")({
          id: Schema.String,
          ts: Schema.DateTimeUtc.pipe(DynamoModel.storedAs(DynamoModel.DateString)),
        }) {}
        const Agg = Aggregate.make(M, {
          table: MainTable,
          schema: AppSchema,
          pk: { field: "pk", composite: ["id"] },
          collection: { index: "lsi1", name: "m1", sk: { field: "lsi1sk", composite: [] } },
          root: { entityType: "M1" },
          edges: {},
        })

        const cap = captureField("ts")
        yield* Agg.create({ id: "x", ts: DateTime.makeUnsafe(epochMs) })
        expect(cap.value()).toBe(isoString)

        mockQuery.mockResolvedValueOnce({
          Items: [
            toAttributeMap({
              pk: "$myapp#v1#m1#x",
              sk: "$myapp#v1#m1",
              lsi1sk: "$myapp#v1#m1",
              __edd_e__: "M1",
              id: "x",
              ts: isoString,
            }),
          ],
          LastEvaluatedKey: undefined,
        })
        const r = yield* Agg.get({ id: "x" })
        expect(DateTime.isDateTime((r as M).ts)).toBe(true)
        expect(DateTime.toEpochMillis((r as M).ts)).toBe(epochMs)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("DateTime.Utc + epochMs storage round-trips", () =>
      Effect.gen(function* () {
        class M extends Schema.Class<M>("M")({
          id: Schema.String,
          ts: Schema.DateTimeUtc.pipe(DynamoModel.storedAs(DynamoModel.DateEpochMs)),
        }) {}
        const Agg = Aggregate.make(M, {
          table: MainTable,
          schema: AppSchema,
          pk: { field: "pk", composite: ["id"] },
          collection: { index: "lsi1", name: "m2", sk: { field: "lsi1sk", composite: [] } },
          root: { entityType: "M2" },
          edges: {},
        })

        const cap = captureField("ts")
        yield* Agg.create({ id: "x", ts: DateTime.makeUnsafe(epochMs) })
        expect(cap.value()).toBe(epochMs)

        mockQuery.mockResolvedValueOnce({
          Items: [
            toAttributeMap({
              pk: "$myapp#v1#m2#x",
              sk: "$myapp#v1#m2",
              lsi1sk: "$myapp#v1#m2",
              __edd_e__: "M2",
              id: "x",
              ts: epochMs,
            }),
          ],
          LastEvaluatedKey: undefined,
        })
        const r = yield* Agg.get({ id: "x" })
        expect(DateTime.isDateTime((r as M).ts)).toBe(true)
        expect(DateTime.toEpochMillis((r as M).ts)).toBe(epochMs)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("DateTime.Utc + epochSeconds storage round-trips", () =>
      Effect.gen(function* () {
        class M extends Schema.Class<M>("M")({
          id: Schema.String,
          ts: Schema.DateTimeUtc.pipe(DynamoModel.storedAs(DynamoModel.DateEpochSeconds)),
        }) {}
        const Agg = Aggregate.make(M, {
          table: MainTable,
          schema: AppSchema,
          pk: { field: "pk", composite: ["id"] },
          collection: { index: "lsi1", name: "m3", sk: { field: "lsi1sk", composite: [] } },
          root: { entityType: "M3" },
          edges: {},
        })

        const cap = captureField("ts")
        yield* Agg.create({ id: "x", ts: DateTime.makeUnsafe(epochMs) })
        expect(cap.value()).toBe(epochSec)

        mockQuery.mockResolvedValueOnce({
          Items: [
            toAttributeMap({
              pk: "$myapp#v1#m3#x",
              sk: "$myapp#v1#m3",
              lsi1sk: "$myapp#v1#m3",
              __edd_e__: "M3",
              id: "x",
              ts: epochSec,
            }),
          ],
          LastEvaluatedKey: undefined,
        })
        const r = yield* Agg.get({ id: "x" })
        expect(DateTime.isDateTime((r as M).ts)).toBe(true)
        expect(DateTime.toEpochMillis((r as M).ts)).toBe(epochMs)
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  // ------------------- Pattern A — self DateValid (Date domain) --------------

  describe("Pattern A — self Date + storedAs annotation", () => {
    it.effect("Date + string storage round-trips (default inferred encoding)", () =>
      Effect.gen(function* () {
        // No `storedAs` — Schema.DateValid alone infers default
        // `{ storage: "string", domain: "Date" }`.
        class M extends Schema.Class<M>("M")({
          id: Schema.String,
          ts: Schema.DateValid,
        }) {}
        const Agg = Aggregate.make(M, {
          table: MainTable,
          schema: AppSchema,
          pk: { field: "pk", composite: ["id"] },
          collection: { index: "lsi1", name: "md1", sk: { field: "lsi1sk", composite: [] } },
          root: { entityType: "MD1" },
          edges: {},
        })

        const cap = captureField("ts")
        yield* Agg.create({ id: "x", ts: new Date(epochMs) })
        expect(cap.value()).toBe(isoString)

        mockQuery.mockResolvedValueOnce({
          Items: [
            toAttributeMap({
              pk: "$myapp#v1#md1#x",
              sk: "$myapp#v1#md1",
              lsi1sk: "$myapp#v1#md1",
              __edd_e__: "MD1",
              id: "x",
              ts: isoString,
            }),
          ],
          LastEvaluatedKey: undefined,
        })
        const r = yield* Agg.get({ id: "x" })
        expect((r as M).ts).toBeInstanceOf(Date)
        expect(((r as M).ts as Date).getTime()).toBe(epochMs)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("Date + epochMs storage round-trips (storedAs UnsafeDateEpochMs)", () =>
      Effect.gen(function* () {
        class M extends Schema.Class<M>("M")({
          id: Schema.String,
          ts: Schema.DateValid.pipe(DynamoModel.storedAs(DynamoModel.UnsafeDateEpochMs)),
        }) {}
        const Agg = Aggregate.make(M, {
          table: MainTable,
          schema: AppSchema,
          pk: { field: "pk", composite: ["id"] },
          collection: { index: "lsi1", name: "md2", sk: { field: "lsi1sk", composite: [] } },
          root: { entityType: "MD2" },
          edges: {},
        })

        const cap = captureField("ts")
        yield* Agg.create({ id: "x", ts: new Date(epochMs) })
        expect(cap.value()).toBe(epochMs)

        mockQuery.mockResolvedValueOnce({
          Items: [
            toAttributeMap({
              pk: "$myapp#v1#md2#x",
              sk: "$myapp#v1#md2",
              lsi1sk: "$myapp#v1#md2",
              __edd_e__: "MD2",
              id: "x",
              ts: epochMs,
            }),
          ],
          LastEvaluatedKey: undefined,
        })
        const r = yield* Agg.get({ id: "x" })
        expect((r as M).ts).toBeInstanceOf(Date)
        expect(((r as M).ts as Date).getTime()).toBe(epochMs)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("Date + epochSeconds storage round-trips (storedAs UnsafeDateEpochSeconds)", () =>
      Effect.gen(function* () {
        class M extends Schema.Class<M>("M")({
          id: Schema.String,
          ts: Schema.DateValid.pipe(DynamoModel.storedAs(DynamoModel.UnsafeDateEpochSeconds)),
        }) {}
        const Agg = Aggregate.make(M, {
          table: MainTable,
          schema: AppSchema,
          pk: { field: "pk", composite: ["id"] },
          collection: { index: "lsi1", name: "md3", sk: { field: "lsi1sk", composite: [] } },
          root: { entityType: "MD3" },
          edges: {},
        })

        const cap = captureField("ts")
        yield* Agg.create({ id: "x", ts: new Date(epochMs) })
        expect(cap.value()).toBe(epochSec)

        mockQuery.mockResolvedValueOnce({
          Items: [
            toAttributeMap({
              pk: "$myapp#v1#md3#x",
              sk: "$myapp#v1#md3",
              lsi1sk: "$myapp#v1#md3",
              __edd_e__: "MD3",
              id: "x",
              ts: epochSec,
            }),
          ],
          LastEvaluatedKey: undefined,
        })
        const r = yield* Agg.get({ id: "x" })
        expect((r as M).ts).toBeInstanceOf(Date)
        expect(((r as M).ts as Date).getTime()).toBe(epochMs)
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  // ------------------- Pattern A — self DateTime.Zoned ----------------------

  describe("Pattern A — self DateTime.Zoned (string storage only)", () => {
    it.effect("DateTime.Zoned + string storage round-trips with timezone", () =>
      Effect.gen(function* () {
        class M extends Schema.Class<M>("M")({
          id: Schema.String,
          ts: Schema.DateTimeZoned,
        }) {}
        const Agg = Aggregate.make(M, {
          table: MainTable,
          schema: AppSchema,
          pk: { field: "pk", composite: ["id"] },
          collection: { index: "lsi1", name: "mz", sk: { field: "lsi1sk", composite: [] } },
          root: { entityType: "MZ" },
          edges: {},
        })

        const zoned = DateTime.makeZonedUnsafe(DateTime.makeUnsafe(epochMs), {
          timeZone: "Asia/Tokyo",
        })

        const cap = captureField("ts")
        yield* Agg.create({ id: "x", ts: zoned })
        const wireTs = cap.value() as string
        expect(typeof wireTs).toBe("string")
        expect(wireTs).toContain("Asia/Tokyo")
        expect(wireTs).toContain("+09:00")

        mockQuery.mockResolvedValueOnce({
          Items: [
            toAttributeMap({
              pk: "$myapp#v1#mz#x",
              sk: "$myapp#v1#mz",
              lsi1sk: "$myapp#v1#mz",
              __edd_e__: "MZ",
              id: "x",
              ts: wireTs,
            }),
          ],
          LastEvaluatedKey: undefined,
        })
        const r = yield* Agg.get({ id: "x" })
        expect(DateTime.isDateTime((r as M).ts)).toBe(true)
        expect(DateTime.isZoned((r as M).ts)).toBe(true)
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  // ------------------- Pattern B — transform DateTimeUtcFromString ----------
  //
  // Regression for #72: a Pattern B transform date field on the aggregate root.
  // Pre-fix, `makeAggregate` installed a `dateDecoders` pre-decoder for EVERY
  // date-resolving field, so `assembleAggregate` lifted the stored wire string
  // to a `DateTime` BEFORE the strict `Schema.decodeUnknownEffect(schema)` —
  // and that strict decoder (the transform's own) expects the string, failing
  // "Expected string, got DateTime.Utc". The fix skips the pre-decoder for
  // transform fields (the schema lifts the wire form itself), so the field is
  // decoded exactly once on read. The transform owns its wire format, so the
  // create input is the encoded form (a string).
  describe("Pattern B — transform DateTimeUtcFromString (single-decode on read)", () => {
    it.effect("DateTimeUtcFromString round-trips without double-decode", () =>
      Effect.gen(function* () {
        class M extends Schema.Class<M>("M")({
          id: Schema.String,
          ts: Schema.DateTimeUtcFromString,
        }) {}
        const Agg = Aggregate.make(M, {
          table: MainTable,
          schema: AppSchema,
          pk: { field: "pk", composite: ["id"] },
          collection: { index: "lsi1", name: "mb", sk: { field: "lsi1sk", composite: [] } },
          root: { entityType: "MB" },
          edges: {},
        })

        // Write path: the decoded domain DateTime is serialized to the wire
        // string exactly once (no double-encode).
        const cap = captureField("ts")
        yield* Agg.create({ id: "x", ts: isoString } as unknown as { id: string; ts: DateTime.Utc })
        expect(cap.value()).toBe(isoString)

        // Read path: the stored wire string is decoded exactly once by the
        // schema's own transform (no dateDecoders pre-decode).
        mockQuery.mockResolvedValueOnce({
          Items: [
            toAttributeMap({
              pk: "$myapp#v1#mb#x",
              sk: "$myapp#v1#mb",
              lsi1sk: "$myapp#v1#mb",
              __edd_e__: "MB",
              id: "x",
              ts: isoString,
            }),
          ],
          LastEvaluatedKey: undefined,
        })
        const r = yield* Agg.get({ id: "x" })
        expect(DateTime.isDateTime((r as M).ts)).toBe(true)
        expect(DateTime.toEpochMillis((r as M).ts)).toBe(epochMs)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("optional DateTimeUtcFromString is not pre-decoded either", () =>
      Effect.gen(function* () {
        class M extends Schema.Class<M>("M")({
          id: Schema.String,
          ts: Schema.optional(Schema.DateTimeUtcFromString),
        }) {}
        const Agg = Aggregate.make(M, {
          table: MainTable,
          schema: AppSchema,
          pk: { field: "pk", composite: ["id"] },
          collection: { index: "lsi1", name: "mbo", sk: { field: "lsi1sk", composite: [] } },
          root: { entityType: "MBO" },
          edges: {},
        })

        const cap = captureField("ts")
        yield* Agg.create({ id: "x", ts: isoString } as unknown as {
          id: string
          ts?: DateTime.Utc
        })
        expect(cap.value()).toBe(isoString)

        mockQuery.mockResolvedValueOnce({
          Items: [
            toAttributeMap({
              pk: "$myapp#v1#mbo#x",
              sk: "$myapp#v1#mbo",
              lsi1sk: "$myapp#v1#mbo",
              __edd_e__: "MBO",
              id: "x",
              ts: isoString,
            }),
          ],
          LastEvaluatedKey: undefined,
        })
        const r = yield* Agg.get({ id: "x" })
        expect(DateTime.isDateTime((r as M).ts)).toBe(true)
      }).pipe(Effect.provide(TestLayer)),
    )
  })
})

// ---------------------------------------------------------------------------
// Policy: transform + storage override is rejected at Aggregate.make() time
// ---------------------------------------------------------------------------

describe("Aggregate codec direction — policy rejection", () => {
  it("throws when DynamoModel.storedAs() targets a transform with mismatched wire kind", () => {
    class M extends Schema.Class<M>("M")({
      id: Schema.String,
      // Transform encodes to string, but storedAs forces epoch (number) — conflict.
      ts: DynamoModel.DateString.pipe(DynamoModel.storedAs(DynamoModel.DateEpochSeconds)),
    }) {}
    expect(() =>
      Aggregate.make(M, {
        table: MainTable,
        schema: AppSchema,
        pk: { field: "pk", composite: ["id"] },
        collection: { index: "lsi1", name: "bad", sk: { field: "lsi1sk", composite: [] } },
        root: { entityType: "Bad" },
        edges: {},
      }),
    ).toThrow(/cannot apply DynamoEncoding storage override to a transform schema/)
  })

  it("accepts a self schema + storedAs annotation (no conflict)", () => {
    class M extends Schema.Class<M>("M")({
      id: Schema.String,
      ts: Schema.DateTimeUtc.pipe(DynamoModel.storedAs(DynamoModel.DateEpochSeconds)),
    }) {}
    expect(() =>
      Aggregate.make(M, {
        table: MainTable,
        schema: AppSchema,
        pk: { field: "pk", composite: ["id"] },
        collection: { index: "lsi1", name: "good", sk: { field: "lsi1sk", composite: [] } },
        root: { entityType: "Good" },
        edges: {},
      }),
    ).not.toThrow()
  })

  it("accepts a transform without override (e.g. DynamoModel.DateString)", () => {
    class M extends Schema.Class<M>("M")({
      id: Schema.String,
      ts: DynamoModel.DateString,
    }) {}
    expect(() =>
      Aggregate.make(M, {
        table: MainTable,
        schema: AppSchema,
        pk: { field: "pk", composite: ["id"] },
        collection: { index: "lsi1", name: "good2", sk: { field: "lsi1sk", composite: [] } },
        root: { entityType: "Good2" },
        edges: {},
      }),
    ).not.toThrow()
  })
})
