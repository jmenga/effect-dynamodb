import { describe, expect, it } from "@effect/vitest"
import { Duration, Schema } from "effect"
import * as Entity from "../src/Entity.js"
import { normalizeTtlSeconds } from "../src/Entity.js"

/**
 * Unit coverage for TTL normalization + make()-time validation (#58).
 *
 * `normalizeTtlSeconds` underpins every framework TTL site (versioned retain,
 * soft-delete, time-series, unique). It accepts a `Duration` or a humanized
 * string, rejects non-finite durations + unparseable strings (EDD-9005), and
 * deliberately does NOT accept a bare `number` at the type level (a number is
 * milliseconds in Effect's Duration grammar — a 1000× footgun).
 */
describe("normalizeTtlSeconds", () => {
  it("converts a Duration to whole seconds", () => {
    expect(normalizeTtlSeconds(Duration.days(7))).toBe(604800)
    expect(normalizeTtlSeconds(Duration.hours(24))).toBe(86400)
    expect(normalizeTtlSeconds(Duration.minutes(30))).toBe(1800)
  })

  it("parses a humanized string to the same whole seconds", () => {
    expect(normalizeTtlSeconds("7 days")).toBe(604800)
    expect(normalizeTtlSeconds("24 hours")).toBe(86400)
    expect(normalizeTtlSeconds("30 minutes")).toBe(1800)
  })

  it("string and Duration forms agree", () => {
    expect(normalizeTtlSeconds("7 days")).toBe(normalizeTtlSeconds(Duration.days(7)))
  })

  it("rejects a non-finite (infinite) duration with EDD-9005", () => {
    expect(() => normalizeTtlSeconds("Infinity")).toThrow(/EDD-9005/)
    expect(() => normalizeTtlSeconds(Duration.infinity)).toThrow(/EDD-9005/)
  })

  it("rejects an unparseable string with EDD-9005", () => {
    expect(() => normalizeTtlSeconds("banana")).toThrow(/EDD-9005/)
    expect(() => normalizeTtlSeconds("7 lightyears")).toThrow(/EDD-9005/)
  })

  it("does NOT accept a bare number at the type level (ms footgun)", () => {
    // @ts-expect-error — a bare number is rejected: Duration treats it as
    // milliseconds, so `3600` would mean 3.6s, not an hour. Pass Duration | string.
    expect(() => normalizeTtlSeconds(3600)).toBeDefined()
  })
})

class Doc extends Schema.Class<Doc>("Doc")({
  id: Schema.String,
  email: Schema.String,
}) {}

const primaryKey = {
  pk: { field: "pk", composite: ["id"] as const },
  sk: { field: "sk", composite: [] as const },
}

describe("Entity.make TTL validation (EDD-9005)", () => {
  it("rejects an infinite versioned.ttl at make() time", () => {
    expect(() =>
      Entity.make({
        model: Doc,
        entityType: "Doc",
        primaryKey,
        versioned: { retain: true, ttl: Duration.infinity },
      }),
    ).toThrow(/EDD-9005/)
  })

  it("rejects an infinite softDelete.ttl (string form) at make() time", () => {
    expect(() =>
      Entity.make({
        model: Doc,
        entityType: "Doc",
        primaryKey,
        softDelete: { ttl: "Infinity" },
      }),
    ).toThrow(/EDD-9005/)
  })

  it("rejects an infinite unique.ttl at make() time", () => {
    expect(() =>
      Entity.make({
        model: Doc,
        entityType: "Doc",
        primaryKey,
        unique: { byEmail: { fields: ["email"], ttl: Duration.infinity } },
      }),
    ).toThrow(/EDD-9005/)
  })

  it("accepts valid Duration and string TTL forms", () => {
    expect(() =>
      Entity.make({
        model: Doc,
        entityType: "Doc",
        primaryKey,
        versioned: { retain: true, ttl: Duration.days(7) },
        unique: { byEmail: { fields: ["email"], ttl: "30 minutes" } },
      }),
    ).not.toThrow()
  })
})
