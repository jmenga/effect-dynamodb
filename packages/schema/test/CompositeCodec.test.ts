/**
 * CompositeCodec — read-path composite encoding.
 *
 * Key composition runs on the ENCODED record (`Entity.put` encodes, then
 * composes). Query accessors and `.where()` receive DECODED model values, so
 * they must take the same encode step or the two sides produce different key
 * strings for a transformed composite.
 */

import { DateTime, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { encodeCompositeRecord, makeCompositeEncoder } from "../src/internal/CompositeCodec.js"
import { serializeValue } from "../src/KeyComposer.js"

const Model = Schema.Struct({
  id: Schema.String,
  status: Schema.Literals(["todo", "active", "done"]),
  seq: Schema.Number,
  ok: Schema.Boolean,
  at: Schema.Date,
  utc: Schema.DateTimeUtc,
  // Genuine `decodeTo`: Type is bigint, Encoded is string.
  txn: Schema.BigIntFromString,
})

const refuse = (attr: string, value: unknown): never => {
  throw new Error(`[EDD-9050] ${attr} ${String(value)}`)
}

describe("CompositeCodec", () => {
  const encode = makeCompositeEncoder(Model, refuse)

  describe("case 1 — attribute is not a model field", () => {
    it("passes the value through untouched", () => {
      // Ref-derived `<ref>Id` composites are not model fields; they are already
      // wire-shaped strings.
      expect(encode("teamId", "t-1")).toBe("t-1")
    })
  })

  describe("case 2 — field has no encoding transformation", () => {
    it("passes strings, numbers and booleans through", () => {
      expect(encode("id", "abc")).toBe("abc")
      expect(encode("seq", 42)).toBe(42)
      expect(encode("ok", true)).toBe(true)
    })

    it("passes an open bound that is NOT a valid value", () => {
      // `gte(t.status, "d")` on a literal union: a bound is deliberately not a
      // member of the union. Attempting an encode here would reject a
      // legitimate query, which is why case 2 short-circuits.
      expect(encode("status", "d")).toBe("d")
      expect(encode("status", "zzz")).toBe("zzz")
    })
  })

  describe("case 3 — field has an encoding transformation", () => {
    it("encodes a bigint composite to the string the write path stores", () => {
      expect(encode("txn", 420n)).toBe("420")
      // The stored key is composed from that string, NOT from the 38-digit
      // padding `serializeValue(420n)` would produce.
      expect(serializeValue(encode("txn", 420n))).toBe("420")
      expect(serializeValue(420n)).not.toBe("420")
    })

    it("accepts the already-encoded shape via the decode -> encode fallback", () => {
      // Mirrors `Entity.put`'s `encodeOrDecodeEncode`: callers may hold either
      // form, and encoding must be idempotent for the retain/restore paths.
      expect(encode("txn", "420")).toBe("420")
      expect(encode("txn", encode("txn", 420n))).toBe("420")
    })

    it("round-trips Date and DateTime to a value that serialises identically", () => {
      const d = new Date("2026-02-11T00:00:00.000Z")
      expect(serializeValue(encode("at", d))).toBe(serializeValue(d))
      const dt = DateTime.makeUnsafe("2026-02-11T00:00:00.000Z")
      expect(serializeValue(encode("utc", dt))).toBe(serializeValue(dt))
    })

    it("refuses a value that encodes under neither route (EDD-9050)", () => {
      // A prefix is not a bigint and does not decode as one, so it cannot be
      // placed in a key at all. Refuse loudly rather than compose a string that
      // silently matches nothing.
      expect(() => encode("txn", "not-a-number")).toThrow(/EDD-9050.*txn/)
    })
  })

  describe("null and undefined", () => {
    it("passes through so sparse-composite handling stays with KeyComposer", () => {
      expect(encode("txn", undefined)).toBeUndefined()
      expect(encode("txn", null)).toBeNull()
    })
  })

  describe("encodeCompositeRecord", () => {
    it("encodes every entry, leaving untransformed ones alone", () => {
      expect(encodeCompositeRecord(encode, { id: "a", status: "done", txn: 7n })).toEqual({
        id: "a",
        status: "done",
        txn: "7",
      })
    })

    it("returns an empty record unchanged", () => {
      expect(encodeCompositeRecord(encode, {})).toEqual({})
    })
  })

  describe("models without a fields record", () => {
    it("passes everything through", () => {
      const encodeAny = makeCompositeEncoder(Schema.String, refuse)
      expect(encodeAny("whatever", 1)).toBe(1)
    })
  })
})
