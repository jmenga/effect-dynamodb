/**
 * `parseZonedIso` — the one parser behind every zoned-date read (#133).
 */
import { describe, expect, it } from "@effect/vitest"
import { DateTime } from "effect"
import { parseZonedIso } from "../src/internal/ZonedIso.js"

const MS = 946684800000

describe("parseZonedIso", () => {
  it("rebuilds exactly what formatIsoZoned wrote, for named and offset zones", () => {
    for (const zone of [
      "Europe/London",
      "UTC",
      "Asia/Kolkata",
      DateTime.zoneMakeOffset(0),
      DateTime.zoneMakeOffset(5 * 3_600_000),
      DateTime.zoneMakeOffset(-(3 * 3_600_000 + 30 * 60_000)),
      DateTime.zoneMakeOffset(14 * 3_600_000),
    ]) {
      const zoned = DateTime.makeZonedUnsafe(MS, { timeZone: zone })
      const wire = DateTime.formatIsoZoned(zoned)
      const back = parseZonedIso(wire)
      expect(DateTime.formatIsoZoned(back)).toBe(wire)
      expect(DateTime.toEpochMillis(back)).toBe(MS)
    }
  })

  it("reads a bare instant as UTC and rejects a non-date", () => {
    expect(DateTime.formatIsoZoned(parseZonedIso("2000-01-01T00:00:00.000Z"))).toBe(
      "2000-01-01T00:00:00.000+00:00[UTC]",
    )
    expect(() => parseZonedIso("not a date")).toThrow()
  })
})
