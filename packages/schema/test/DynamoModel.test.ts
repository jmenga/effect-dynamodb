import { DateTime, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as DynamoModel from "../src/DynamoModel.js"

describe("DynamoModel", () => {
  // ---------------------------------------------------------------------------
  // configure — immutable
  // ---------------------------------------------------------------------------

  describe("configure immutable", () => {
    it("marks a field as immutable via configure", () => {
      class User extends Schema.Class<User>("User")({
        userId: Schema.String,
        createdBy: Schema.String,
      }) {}

      const configured = DynamoModel.configure(User, {
        createdBy: { immutable: true },
      })

      expect(DynamoModel.isConfiguredModel(configured)).toBe(true)
      expect(configured.attributes.createdBy?.immutable).toBe(true)
      expect(configured.attributes.userId).toBeUndefined()
    })
  })

  // ---------------------------------------------------------------------------
  // Identifier annotation
  // ---------------------------------------------------------------------------

  describe("identifier", () => {
    it("marks a field as identifier", () => {
      const field = Schema.String.pipe(DynamoModel.identifier)
      expect(DynamoModel.isIdentifier(field)).toBe(true)
    })

    it("unmarked fields are not identifiers", () => {
      expect(DynamoModel.isIdentifier(Schema.String)).toBe(false)
    })

    it("preserves the schema type", () => {
      const field = Schema.NonEmptyString.pipe(DynamoModel.identifier)
      const result = Schema.decodeUnknownSync(field)("hello")
      expect(result).toBe("hello")
    })

    it("composes with Hidden", () => {
      const field = Schema.String.pipe(DynamoModel.identifier, DynamoModel.Hidden)
      expect(DynamoModel.isIdentifier(field)).toBe(true)
      expect(DynamoModel.isHidden(field)).toBe(true)
    })

    it("works with Schema.Class fields", () => {
      class Team extends Schema.Class<Team>("Team")({
        id: Schema.String.pipe(DynamoModel.identifier),
        name: Schema.String,
      }) {}

      expect(DynamoModel.isIdentifier(Team.fields.id)).toBe(true)
      expect(DynamoModel.isIdentifier(Team.fields.name)).toBe(false)
    })
  })

  // ---------------------------------------------------------------------------
  // getIdentifierField
  // ---------------------------------------------------------------------------

  describe("getIdentifierField", () => {
    it("finds the identifier field in a Schema.Class", () => {
      class Team extends Schema.Class<Team>("Team")({
        id: Schema.String.pipe(DynamoModel.identifier),
        name: Schema.String,
        country: Schema.String,
      }) {}

      const result = DynamoModel.getIdentifierField(Team)
      expect(result).toBeDefined()
      expect(result!.name).toBe("id")
    })

    it("returns undefined when no field has the annotation", () => {
      class Plain extends Schema.Class<Plain>("Plain")({
        name: Schema.String,
        age: Schema.Number,
      }) {}

      expect(DynamoModel.getIdentifierField(Plain)).toBeUndefined()
    })

    it("returns undefined for schema without fields", () => {
      expect(DynamoModel.getIdentifierField(Schema.String)).toBeUndefined()
    })
  })

  // ---------------------------------------------------------------------------
  // Ref annotation
  // ---------------------------------------------------------------------------

  describe("ref", () => {
    class Team extends Schema.Class<Team>("Team")({
      id: Schema.String.pipe(DynamoModel.identifier),
      name: Schema.String,
      country: Schema.String,
    }) {}

    it("marks a schema as a ref", () => {
      const field = Team.pipe(DynamoModel.ref)
      expect(DynamoModel.isRef(field)).toBe(true)
    })

    it("unmarked schemas are not refs", () => {
      expect(DynamoModel.isRef(Team)).toBe(false)
      expect(DynamoModel.isRef(Schema.String)).toBe(false)
    })

    it("composes with Hidden", () => {
      const field = Team.pipe(DynamoModel.ref, DynamoModel.Hidden)
      expect(DynamoModel.isRef(field)).toBe(true)
      expect(DynamoModel.isHidden(field)).toBe(true)
    })

    it("works with Schema.Class types", () => {
      class Selection extends Schema.Class<Selection>("Selection")({
        team: Team.pipe(DynamoModel.ref),
        note: Schema.String,
      }) {}

      expect(DynamoModel.isRef(Selection.fields.team)).toBe(true)
      expect(DynamoModel.isRef(Selection.fields.note)).toBe(false)
    })
  })

  // ---------------------------------------------------------------------------
  // Hidden annotation
  // ---------------------------------------------------------------------------

  describe("Hidden", () => {
    it("marks a field as hidden", () => {
      const field = Schema.String.pipe(DynamoModel.Hidden)
      expect(DynamoModel.isHidden(field)).toBe(true)
    })

    it("unmarked fields are not hidden", () => {
      expect(DynamoModel.isHidden(Schema.String)).toBe(false)
    })

    it("preserves the schema type", () => {
      const field = Schema.String.pipe(DynamoModel.Hidden)
      const result = Schema.decodeUnknownSync(field)("hello")
      expect(result).toBe("hello")
    })

    it("composes with identifier", () => {
      const field = Schema.String.pipe(DynamoModel.identifier, DynamoModel.Hidden)
      expect(DynamoModel.isIdentifier(field)).toBe(true)
      expect(DynamoModel.isHidden(field)).toBe(true)
    })
  })

  // ---------------------------------------------------------------------------
  // DynamoEncoding annotation
  // ---------------------------------------------------------------------------

  describe("DynamoEncoding", () => {
    it("getEncoding returns undefined for unannotated schemas", () => {
      expect(DynamoModel.getEncoding(Schema.String)).toBeUndefined()
      expect(DynamoModel.getEncoding(Schema.Number)).toBeUndefined()
    })

    it("getEncoding reads encoding from annotated schemas", () => {
      const encoding = DynamoModel.getEncoding(DynamoModel.DateString)
      expect(encoding).toEqual({ storage: "string", domain: "DateTime.Utc" })
    })
  })

  // ---------------------------------------------------------------------------
  // DateString — wire: ISO string, domain: DateTime.Utc
  // ---------------------------------------------------------------------------

  describe("DateString", () => {
    it("decodes ISO string to DateTime.Utc", () => {
      const dt = Schema.decodeUnknownSync(DynamoModel.DateString)("2024-01-01T00:00:00.000Z")
      expect(DateTime.isDateTime(dt)).toBe(true)
      expect(DateTime.toEpochMillis(dt)).toBe(1704067200000)
    })

    it("encodes DateTime.Utc to ISO string", () => {
      const dt = DateTime.makeUnsafe(1704067200000)
      const str = Schema.encodeSync(DynamoModel.DateString)(dt)
      expect(str).toBe("2024-01-01T00:00:00.000Z")
    })

    it("has storage: string encoding", () => {
      const encoding = DynamoModel.getEncoding(DynamoModel.DateString)
      expect(encoding).toEqual({ storage: "string", domain: "DateTime.Utc" })
    })

    it("rejects invalid strings", () => {
      expect(() => Schema.decodeUnknownSync(DynamoModel.DateString)("not a date")).toThrow()
    })
  })

  // ---------------------------------------------------------------------------
  // DateEpochMs — wire: epoch ms, domain: DateTime.Utc
  // ---------------------------------------------------------------------------

  describe("DateEpochMs", () => {
    it("decodes epoch milliseconds to DateTime.Utc", () => {
      const dt = Schema.decodeUnknownSync(DynamoModel.DateEpochMs)(1704067200000)
      expect(DateTime.isDateTime(dt)).toBe(true)
      expect(DateTime.toEpochMillis(dt)).toBe(1704067200000)
    })

    it("encodes DateTime.Utc to epoch milliseconds", () => {
      const dt = DateTime.makeUnsafe(1704067200000)
      const ms = Schema.encodeSync(DynamoModel.DateEpochMs)(dt)
      expect(ms).toBe(1704067200000)
    })

    it("has storage: epochMs encoding", () => {
      const encoding = DynamoModel.getEncoding(DynamoModel.DateEpochMs)
      expect(encoding).toEqual({ storage: "epochMs", domain: "DateTime.Utc" })
    })
  })

  // ---------------------------------------------------------------------------
  // DateEpochSeconds — wire: epoch seconds, domain: DateTime.Utc
  // ---------------------------------------------------------------------------

  describe("DateEpochSeconds", () => {
    it("decodes epoch seconds to DateTime.Utc", () => {
      const dt = Schema.decodeUnknownSync(DynamoModel.DateEpochSeconds)(1704067200)
      expect(DateTime.isDateTime(dt)).toBe(true)
      expect(DateTime.toEpochMillis(dt)).toBe(1704067200000)
    })

    it("encodes DateTime.Utc to epoch seconds", () => {
      const dt = DateTime.makeUnsafe(1704067200000)
      const secs = Schema.encodeSync(DynamoModel.DateEpochSeconds)(dt)
      expect(secs).toBe(1704067200)
    })

    it("has storage: epochSeconds encoding", () => {
      const encoding = DynamoModel.getEncoding(DynamoModel.DateEpochSeconds)
      expect(encoding).toEqual({ storage: "epochSeconds", domain: "DateTime.Utc" })
    })

    it("truncates sub-second precision", () => {
      const dt = DateTime.makeUnsafe(1704067200500) // .5 seconds
      const secs = Schema.encodeSync(DynamoModel.DateEpochSeconds)(dt)
      expect(secs).toBe(1704067200)
    })
  })

  // ---------------------------------------------------------------------------
  // TTL — alias for DateEpochSeconds
  // ---------------------------------------------------------------------------

  describe("TTL", () => {
    it("is the same as DateEpochSeconds", () => {
      expect(DynamoModel.TTL).toBe(DynamoModel.DateEpochSeconds)
    })
  })

  // ---------------------------------------------------------------------------
  // DateEpoch — wire: auto-detect ms/seconds, domain: DateTime.Utc
  // ---------------------------------------------------------------------------

  describe("DateEpoch", () => {
    const schema = DynamoModel.DateEpoch({ minimum: "2020-01-01" })

    it("decodes epoch milliseconds (above minimum as ms)", () => {
      const dt = Schema.decodeUnknownSync(schema)(1704067200000) // 2024-01-01 as ms
      expect(DateTime.toEpochMillis(dt)).toBe(1704067200000)
    })

    it("falls back to seconds when ms is below minimum", () => {
      const dt = Schema.decodeUnknownSync(schema)(1704067200) // 2024-01-01 as seconds
      expect(DateTime.toEpochMillis(dt)).toBe(1704067200000)
    })

    it("fails when both ms and seconds are below minimum", () => {
      expect(() => Schema.decodeUnknownSync(schema)(500)).toThrow()
    })

    it("encodes as ms by default", () => {
      const dt = DateTime.makeUnsafe(1704067200000)
      const val = Schema.encodeSync(schema)(dt)
      expect(val).toBe(1704067200000)
    })

    it("encodes as seconds when encode option is DateEpochSeconds", () => {
      const secsSchema = DynamoModel.DateEpoch({
        minimum: "2020-01-01",
        encode: DynamoModel.DateEpochSeconds,
      })
      const dt = DateTime.makeUnsafe(1704067200000)
      const val = Schema.encodeSync(secsSchema)(dt)
      expect(val).toBe(1704067200)
    })

    it("has DynamoEncoding annotation", () => {
      const encoding = DynamoModel.getEncoding(schema)
      expect(encoding).toEqual({ storage: "epochMs", domain: "DateTime.Utc" })
    })

    it("has epochSeconds storage when encode is DateEpochSeconds", () => {
      const secsSchema = DynamoModel.DateEpoch({
        minimum: "2020-01-01",
        encode: DynamoModel.DateEpochSeconds,
      })
      const encoding = DynamoModel.getEncoding(secsSchema)
      expect(encoding).toEqual({ storage: "epochSeconds", domain: "DateTime.Utc" })
    })
  })

  // ---------------------------------------------------------------------------
  // DateTimeZoned — wire: ISO+zone, domain: DateTime.Zoned
  // ---------------------------------------------------------------------------

  describe("DateTimeZoned", () => {
    it("decodes extended ISO with zone to DateTime.Zoned", () => {
      const dt = Schema.decodeUnknownSync(DynamoModel.DateTimeZoned)(
        "2024-01-01T15:00:00+09:00[Asia/Tokyo]",
      )
      expect(DateTime.isZoned(dt)).toBe(true)
    })

    it("encodes DateTime.Zoned to extended ISO with zone", () => {
      const utc = DateTime.makeUnsafe("2024-01-01T06:00:00Z")
      const zoned = DateTime.makeZonedUnsafe(utc, { timeZone: "Asia/Tokyo" })
      const str = Schema.encodeSync(DynamoModel.DateTimeZoned)(zoned)
      expect(str).toMatch(/Asia\/Tokyo/)
      expect(str).toMatch(/\+09:00/)
    })

    it("has storage: string encoding", () => {
      const encoding = DynamoModel.getEncoding(DynamoModel.DateTimeZoned)
      expect(encoding).toEqual({ storage: "string", domain: "DateTime.Zoned" })
    })

    it("decodes offset-only string with UTC zone", () => {
      const dt = Schema.decodeUnknownSync(DynamoModel.DateTimeZoned)("2024-01-01T00:00:00.000Z")
      expect(DateTime.isZoned(dt)).toBe(true)
    })

    it("rejects invalid strings", () => {
      expect(() => Schema.decodeUnknownSync(DynamoModel.DateTimeZoned)("not a date")).toThrow()
    })
  })

  // ---------------------------------------------------------------------------
  // UnsafeDateString — wire: ISO string, domain: Date
  // ---------------------------------------------------------------------------

  describe("UnsafeDateString", () => {
    it("decodes ISO string to native Date", () => {
      const d = Schema.decodeUnknownSync(DynamoModel.UnsafeDateString)("2024-01-01T00:00:00.000Z")
      expect(d).toBeInstanceOf(Date)
      expect(d.getTime()).toBe(1704067200000)
    })

    it("encodes Date to ISO string", () => {
      const str = Schema.encodeSync(DynamoModel.UnsafeDateString)(new Date(1704067200000))
      expect(str).toBe("2024-01-01T00:00:00.000Z")
    })

    it("has storage: string, domain: Date encoding", () => {
      const encoding = DynamoModel.getEncoding(DynamoModel.UnsafeDateString)
      expect(encoding).toEqual({ storage: "string", domain: "Date" })
    })
  })

  // ---------------------------------------------------------------------------
  // UnsafeDateEpochMs — wire: epoch ms, domain: Date
  // ---------------------------------------------------------------------------

  describe("UnsafeDateEpochMs", () => {
    it("decodes epoch ms to native Date", () => {
      const d = Schema.decodeUnknownSync(DynamoModel.UnsafeDateEpochMs)(1704067200000)
      expect(d).toBeInstanceOf(Date)
      expect(d.getTime()).toBe(1704067200000)
    })

    it("encodes Date to epoch ms", () => {
      const ms = Schema.encodeSync(DynamoModel.UnsafeDateEpochMs)(new Date(1704067200000))
      expect(ms).toBe(1704067200000)
    })

    it("has storage: epochMs, domain: Date encoding", () => {
      const encoding = DynamoModel.getEncoding(DynamoModel.UnsafeDateEpochMs)
      expect(encoding).toEqual({ storage: "epochMs", domain: "Date" })
    })
  })

  // ---------------------------------------------------------------------------
  // UnsafeDateEpochSeconds — wire: epoch seconds, domain: Date
  // ---------------------------------------------------------------------------

  describe("UnsafeDateEpochSeconds", () => {
    it("decodes epoch seconds to native Date", () => {
      const d = Schema.decodeUnknownSync(DynamoModel.UnsafeDateEpochSeconds)(1704067200)
      expect(d).toBeInstanceOf(Date)
      expect(d.getTime()).toBe(1704067200000)
    })

    it("encodes Date to epoch seconds", () => {
      const secs = Schema.encodeSync(DynamoModel.UnsafeDateEpochSeconds)(new Date(1704067200000))
      expect(secs).toBe(1704067200)
    })

    it("has storage: epochSeconds, domain: Date encoding", () => {
      const encoding = DynamoModel.getEncoding(DynamoModel.UnsafeDateEpochSeconds)
      expect(encoding).toEqual({ storage: "epochSeconds", domain: "Date" })
    })
  })

  // ---------------------------------------------------------------------------
  // storedAs modifier
  // ---------------------------------------------------------------------------

  describe("storedAs", () => {
    it("overrides storage format from string to epochSeconds", () => {
      const schema = DynamoModel.DateString.pipe(DynamoModel.storedAs(DynamoModel.DateEpochSeconds))
      const encoding = DynamoModel.getEncoding(schema)
      expect(encoding).toEqual({ storage: "epochSeconds", domain: "DateTime.Utc" })
    })

    it("overrides storage format from epochMs to string", () => {
      const schema = DynamoModel.DateEpochMs.pipe(DynamoModel.storedAs(DynamoModel.DateString))
      const encoding = DynamoModel.getEncoding(schema)
      expect(encoding).toEqual({ storage: "string", domain: "DateTime.Utc" })
    })

    it("preserves wire format decode/encode", () => {
      const schema = DynamoModel.DateString.pipe(DynamoModel.storedAs(DynamoModel.DateEpochSeconds))
      // Still decodes from ISO string (wire format unchanged)
      const dt = Schema.decodeUnknownSync(schema)("2024-01-01T00:00:00.000Z")
      expect(DateTime.toEpochMillis(dt)).toBe(1704067200000)
      // Still encodes to ISO string (wire format unchanged)
      const str = Schema.encodeSync(schema)(dt)
      expect(str).toBe("2024-01-01T00:00:00.000Z")
    })

    it("works with Unsafe variants", () => {
      const schema = DynamoModel.UnsafeDateString.pipe(
        DynamoModel.storedAs(DynamoModel.UnsafeDateEpochSeconds),
      )
      const encoding = DynamoModel.getEncoding(schema)
      expect(encoding).toEqual({ storage: "epochSeconds", domain: "Date" })
    })

    it("works with DateEpoch", () => {
      const schema = DynamoModel.DateEpoch({ minimum: "2020-01-01" }).pipe(
        DynamoModel.storedAs(DynamoModel.DateEpochSeconds),
      )
      const encoding = DynamoModel.getEncoding(schema)
      expect(encoding).toEqual({ storage: "epochSeconds", domain: "DateTime.Utc" })
    })

    it("throws for schemas without DynamoEncoding", () => {
      expect(() => DynamoModel.storedAs(Schema.String as any)).toThrow(
        "storedAs: target schema has no DynamoEncoding annotation",
      )
    })
  })

  // ---------------------------------------------------------------------------
  // Annotation composition
  // ---------------------------------------------------------------------------

  describe("Annotation composition", () => {
    it("Hidden + DynamoEncoding compose", () => {
      const field = DynamoModel.DateString.pipe(DynamoModel.Hidden)
      expect(DynamoModel.isHidden(field)).toBe(true)
      const encoding = DynamoModel.getEncoding(field)
      expect(encoding).toEqual({ storage: "string", domain: "DateTime.Utc" })
    })

    it("storedAs + Hidden compose", () => {
      const field = DynamoModel.DateString.pipe(
        DynamoModel.storedAs(DynamoModel.DateEpochSeconds),
        DynamoModel.Hidden,
      )
      expect(DynamoModel.isHidden(field)).toBe(true)
      const encoding = DynamoModel.getEncoding(field)
      expect(encoding).toEqual({ storage: "epochSeconds", domain: "DateTime.Utc" })
    })
  })

  // ---------------------------------------------------------------------------
  // Schema.Class integration
  // ---------------------------------------------------------------------------

  describe("Schema.Class integration", () => {
    it("date schemas work as Schema.Class fields", () => {
      class Order extends Schema.Class<Order>("Order")({
        orderId: Schema.String,
        placedAt: DynamoModel.DateString,
        expiresAt: DynamoModel.DateString.pipe(DynamoModel.storedAs(DynamoModel.DateEpochSeconds)),
        ttl: DynamoModel.TTL,
      }) {}

      // Decode a full order
      const order = Schema.decodeUnknownSync(Order)({
        orderId: "o-1",
        placedAt: "2024-01-01T00:00:00.000Z",
        expiresAt: "2024-01-02T00:00:00.000Z",
        ttl: 1704067200,
      })

      expect(order.orderId).toBe("o-1")
      expect(DateTime.isDateTime(order.placedAt)).toBe(true)
      expect(DateTime.isDateTime(order.expiresAt)).toBe(true)
      expect(DateTime.isDateTime(order.ttl)).toBe(true)
    })

    it("annotations survive Schema.Class field extraction", () => {
      class Order extends Schema.Class<Order>("Order")({
        placedAt: DynamoModel.DateString.pipe(DynamoModel.storedAs(DynamoModel.DateEpochSeconds)),
      }) {}

      const encoding = DynamoModel.getEncoding(Order.fields.placedAt)
      expect(encoding).toEqual({ storage: "epochSeconds", domain: "DateTime.Utc" })
    })
  })

  // ---------------------------------------------------------------------------
  // DynamoModel.configure
  // ---------------------------------------------------------------------------

  describe("configure", () => {
    class Order extends Schema.Class<Order>("Order")({
      orderId: Schema.String,
      placedAt: Schema.DateTimeUtcFromString,
      expiresAt: Schema.DateTimeUtcFromString,
      name: Schema.String,
    }) {}

    it("creates a ConfiguredModel with storage override", () => {
      const configured = DynamoModel.configure(Order, {
        expiresAt: { storedAs: DynamoModel.DateEpochSeconds },
      })
      expect(DynamoModel.isConfiguredModel(configured)).toBe(true)
      expect(configured.model).toBe(Order)
      expect(configured.attributes.expiresAt?.encoding).toEqual({
        storage: "epochSeconds",
        domain: "DateTime.Utc",
      })
    })

    it("creates a ConfiguredModel with field rename", () => {
      const configured = DynamoModel.configure(Order, {
        orderId: { field: "order_id" },
      })
      expect(configured.attributes.orderId?.field).toBe("order_id")
      expect(configured.attributes.orderId?.encoding).toBeUndefined()
    })

    it("creates a ConfiguredModel with both field rename and storage override", () => {
      const configured = DynamoModel.configure(Order, {
        expiresAt: { field: "ttl", storedAs: DynamoModel.DateEpochSeconds },
      })
      expect(configured.attributes.expiresAt?.field).toBe("ttl")
      expect(configured.attributes.expiresAt?.encoding?.storage).toBe("epochSeconds")
    })

    it("throws if storedAs schema has no DynamoEncoding annotation", () => {
      expect(() =>
        DynamoModel.configure(Order, {
          name: { storedAs: Schema.String } as any,
        }),
      ).toThrow('storedAs schema for "name" has no DynamoEncoding annotation')
    })

    it("isConfiguredModel returns false for non-ConfiguredModel", () => {
      expect(DynamoModel.isConfiguredModel(Order)).toBe(false)
      expect(DynamoModel.isConfiguredModel(null)).toBe(false)
      expect(DynamoModel.isConfiguredModel(42)).toBe(false)
    })

    it("preserves original model reference", () => {
      const configured = DynamoModel.configure(Order, {})
      expect(configured.model).toBe(Order)
      expect(Object.keys(configured.attributes)).toEqual([])
    })
  })
})
