/**
 * A named zone's name, as published 1.40.0 stored it on Effect 4.1.2, whichever Effect is installed
 * (#242). Effect 4.1.3 gave a named zone a `resolvedId` and kept the name it was made from as its
 * `id`; each zone here is one as 4.1.3 makes it, built on the installed Effect's own prototype, so
 * every assertion holds on either version.
 */
import { describe, expect, it } from "@effect/vitest"
import { DateTime, Effect, Option, Result, Schema } from "effect"
import * as DynamoModel from "../src/DynamoModel.js"
import {
  rewrittenZoneId,
  storedFormOf,
  storedZoneName,
  zonedIsoText,
  zoneNameOf,
  zonesAsStored,
} from "../src/internal/StoredForm.js"
import * as KeyComposer from "../src/KeyComposer.js"

/** A zone as Effect 4.1.3 makes one from `given`, which `Intl` resolves as it resolves `resolving`. */
const madeAs413 = (given: string, resolving: string): DateTime.TimeZone => {
  const real = DateTime.zoneMakeNamedUnsafe(resolving) as unknown as {
    readonly format: Intl.DateTimeFormat
  }
  const zone = Object.create(Object.getPrototypeOf(real))
  zone.id = given
  zone.resolvedId = real.format.resolvedOptions().timeZone
  zone.format = real.format
  return zone
}

/** A zone as Effect 4.1.2 made one: its `id` the resolved name, no `resolvedId`. */
const madeAs412 = (resolving: string): DateTime.TimeZone => {
  const real = DateTime.zoneMakeNamedUnsafe(resolving) as unknown as {
    readonly format: Intl.DateTimeFormat
  }
  const zone = Object.create(Object.getPrototypeOf(real))
  zone.id = real.format.resolvedOptions().timeZone
  zone.format = real.format
  return zone
}

const MARKER = "~effect/DateTime/TimeZone"
const at = (zone: DateTime.TimeZone) => DateTime.makeZonedUnsafe(0, { timeZone: zone })

describe("storedZoneName", () => {
  it("is a 4.1.3 zone's resolvedId, the name 4.1.2 gave it, and a 4.1.2 zone's id", () => {
    expect(zoneNameOf(madeAs413("Etc/UTC", "UTC"))).toBe("UTC")
    expect(zoneNameOf(madeAs413("Europe/London", "Europe/London"))).toBe("Europe/London")
    expect(zoneNameOf(madeAs412("UTC"))).toBe("UTC")
    expect(storedZoneName("Etc/UTC", "UTC")).toBe("UTC")
    expect(storedZoneName("UTC", undefined)).toBe("UTC")
    expect(storedZoneName(undefined, undefined)).toBeUndefined()
    expect(zoneNameOf(DateTime.zoneMakeOffset(3_600_000))).toBeUndefined()
  })

  it("rewrites only a named zone's map holding resolvedId", () => {
    expect(rewrittenZoneId("Named", "Etc/UTC", "UTC")).toBe("UTC")
    expect(rewrittenZoneId("Named", "UTC", "UTC")).toBe("UTC")
    expect(rewrittenZoneId("Named", "UTC", undefined)).toBeUndefined()
    expect(rewrittenZoneId("Offset", "Etc/UTC", "UTC")).toBeUndefined()
    expect(rewrittenZoneId("Named", 1, "UTC")).toBeUndefined()
  })

  it("names a zone the installed Effect makes from an alias as 4.1.2 did", () => {
    const zone = DateTime.zoneMakeNamedUnsafe("Etc/UTC")
    expect(JSON.stringify(storedFormOf(zone))).toBe(
      `{"format":{},"id":"UTC","${MARKER}":"${MARKER}","_tag":"Named"}`,
    )
    expect(KeyComposer.serializeValue(zone)).toBe("TimeZone.Named(UTC)")
  })
})

describe("a 4.1.3 zone's stored forms are 4.1.2's", () => {
  it("packed, a zone and a zoned date", () => {
    expect(JSON.stringify(storedFormOf(madeAs413("Etc/UTC", "UTC")))).toBe(
      `{"format":{},"id":"UTC","${MARKER}":"${MARKER}","_tag":"Named"}`,
    )
    expect(JSON.stringify(storedFormOf(at(madeAs413("Etc/UTC", "UTC"))))).toBe(
      `{"~effect/DateTime":"~effect/DateTime","epochMilliseconds":0,` +
        `"zone":{"format":{},"id":"UTC","${MARKER}":"${MARKER}","_tag":"Named"},"_tag":"Zoned"}`,
    )
    expect(JSON.stringify(storedFormOf(madeAs413("Etc/UTC", "UTC")))).toBe(
      JSON.stringify(storedFormOf(madeAs412("UTC"))),
    )
  })

  it("a zone carrying a resolvedId that isn't its id's resolution, under that resolvedId", () => {
    const other = madeAs413("Etc/UTC", "UTC") as unknown as { resolvedId: string }
    other.resolvedId = "Europe/London"
    expect(JSON.stringify(storedFormOf(other as never))).toBe(
      `{"format":{},"id":"Europe/London","${MARKER}":"${MARKER}","_tag":"Named"}`,
    )
  })

  it("key text, the zone itself and in an Option or a Result", () => {
    const zone = madeAs413("Etc/UTC", "UTC")
    expect(KeyComposer.serializeValue(zone)).toBe("TimeZone.Named(UTC)")
    expect(KeyComposer.serializeValue(Option.some(zone))).toBe("some(TimeZone.Named(UTC))")
    expect(KeyComposer.serializeValue(Option.some(at(zone)))).toBe(
      "some(DateTime.Zoned(1970-01-01T00:00:00.000+00:00[UTC]))",
    )
    expect(KeyComposer.serializeValue(Result.succeed(zone))).toBe(
      String(Result.succeed(madeAs412("UTC"))),
    )
    expect(KeyComposer.serializeValue(Result.fail(zone))).toBe(
      String(Result.fail(madeAs412("UTC"))),
    )
    expect(KeyComposer.serializeValue(at(zone))).toBe("1970-01-01T00:00:00.000Z")
  })

  it("ISO text, the library's and DynamoModel.DateTimeZoned's", () =>
    Effect.gen(function* () {
      const date = at(madeAs413("Etc/UTC", "UTC")) as DateTime.Zoned
      expect(zonedIsoText(date)).toBe("1970-01-01T00:00:00.000+00:00[UTC]")
      expect(yield* Schema.encodeEffect(DynamoModel.DateTimeZoned)(date)).toBe(
        "1970-01-01T00:00:00.000+00:00[UTC]",
      )
    }))

  it("leaves what it doesn't change as the same reference", () => {
    const zone = madeAs412("UTC")
    const held = Option.some(at(zone))
    expect(zonesAsStored(zone)).toBe(zone)
    expect(zonesAsStored(held)).toBe(held)
    const london = madeAs413("Europe/London", "Europe/London")
    expect(zonesAsStored(london)).toBe(london)
    const map = { zone: madeAs413("Etc/UTC", "UTC") }
    expect(zonesAsStored(map)).toBe(map)
  })
})
