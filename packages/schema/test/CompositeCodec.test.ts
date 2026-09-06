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
import { DateEpochMs } from "../src/DynamoModel.js"
import { makeCompositeKeyForm, toCompositeKeyRecord } from "../src/internal/CompositeCodec.js"
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
  epoch: DateEpochMs,
})

const refuse = (attr: string, value: unknown): never => {
  throw new Error(`[EDD-9050] ${attr} ${String(value)}`)
}

describe("CompositeCodec", () => {
  const encode = makeCompositeKeyForm(Model, refuse)

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
    it("keeps a numeric-Type/string-Encoded composite on the TYPE side so it pads", () => {
      // THE EXCEPTION. `serializeValue` pads a bigint to 38 digits but leaves a
      // string alone, so composing the encoded "420" stored `txn_420` beside
      // `txn_100` and `txn_5` — which DynamoDB orders 100 < 42 < 5.
      expect(encode("txn", 420n)).toBe(420n)
      expect(serializeValue(encode("txn", 420n))).toBe("420".padStart(38, "0"))
    })

    it("lifts the encoded string back to the Type side, so both inputs agree", () => {
      // The write path holds the encoded record, the read path the domain
      // value; both must land on the same key.
      expect(encode("txn", "420")).toBe(420n)
      expect(encode("txn", encode("txn", 420n))).toBe(420n)
    })

    it("padding makes mixed-width values sort numerically", () => {
      const keys = [5n, 42n, 100n].map((v) => serializeValue(encode("txn", v)))
      expect([...keys].sort()).toEqual(keys)
    })

    it("a numeric ENCODED form is used as-is — the exception does not apply", () => {
      // `DateEpochMs`: Type is DateTime, Encoded is a number, already padded by
      // `serializeValue`.
      const dt = DateTime.makeUnsafe("2026-02-11T00:00:00.000Z")
      expect(encode("epoch", dt)).toBe(DateTime.toEpochMillis(dt))
      expect(serializeValue(encode("epoch", dt))).toBe(
        String(DateTime.toEpochMillis(dt)).padStart(16, "0"),
      )
    })

    it("round-trips Date and DateTime to a value that serialises identically", () => {
      const d = new Date("2026-02-11T00:00:00.000Z")
      expect(serializeValue(encode("at", d))).toBe(serializeValue(d))
      const dt = DateTime.makeUnsafe("2026-02-11T00:00:00.000Z")
      expect(serializeValue(encode("utc", dt))).toBe(serializeValue(dt))
    })

    it("refuses a value that resolves under neither route (EDD-9050)", () => {
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
      expect(toCompositeKeyRecord(encode, { id: "a", status: "done", txn: 7n })).toEqual({
        id: "a",
        status: "done",
        txn: 7n,
      })
    })

    it("returns an empty record unchanged", () => {
      expect(toCompositeKeyRecord(encode, {})).toEqual({})
    })
  })

  describe("models without a fields record", () => {
    it("passes everything through", () => {
      const encodeAny = makeCompositeKeyForm(Schema.String, refuse)
      expect(encodeAny("whatever", 1)).toBe(1)
    })
  })
})
