/**
 * `StoredForm`: what one of Effect's own instances is packed as (#242). The map a native write stores,
 * in the order DynamoDB Local hands it back; every map published 1.39.0 stored for a look-alike is
 * pinned against that order in effect-dynamodb's `PackedLookalikes.test.ts`, through the bytes
 * published 1.40.0 packed for it.
 */
import { describe, expect, it } from "@effect/vitest"
import { BigDecimal, DateTime, Duration, Equal, Option, Result } from "effect"
import * as Cookies from "effect/http/Cookies"
import * as PackedCodec from "../src/internal/PackedCodec.js"
import { inStoredOrder, isCachedNormal, storedFormOf } from "../src/internal/StoredForm.js"

const keysOf = (entries: ReadonlyArray<string>) =>
  Object.keys(inStoredOrder(entries.map((key) => [key, 1] as const)))

describe("inStoredOrder", () => {
  it("puts keys in the order DynamoDB Local hands a map back, measured", () => {
    // Each as published 1.39.0 read it back from DynamoDB Local.
    expect(keysOf(["_tag", "millis"])).toEqual(["millis", "_tag"])
    expect(keysOf(["value", "~effect/Duration"])).toEqual(["~effect/Duration", "value"])
    expect(keysOf(["_tag", "~effect/DateTime/TimeZone", "id", "format"])).toEqual([
      "format",
      "id",
      "~effect/DateTime/TimeZone",
      "_tag",
    ])
    expect(keysOf(["major", "minor", "patch", "prerelease", "build", "~effect/SemVer"])).toEqual([
      "patch",
      "major",
      "minor",
      "~effect/SemVer",
      "build",
      "prerelease",
    ])
  })

  it("keeps the order keys were given in where they land in one bucket, and an index first", () => {
    expect(keysOf(["a"])).toEqual(["a"])
    expect(keysOf([])).toEqual([])
    expect(keysOf(["b", "1", "a", "0"])).toEqual(["0", "1", "a", "b"])
  })

  it("holds a key named __proto__ as its own", () => {
    const map = inStoredOrder([["__proto__", 1]])
    expect(Object.hasOwn(map, "__proto__")).toBe(true)
    expect(JSON.stringify(map)).toBe('{"__proto__":1}')
  })
})

describe("storedFormOf", () => {
  it("is undefined for what isn't one of Effect's instances", () => {
    class Own {
      readonly a = 1
    }
    for (const value of [{}, [], new Own(), new Date(0), new Map(), new Set(), new Uint8Array()]) {
      expect(storedFormOf(value)).toBeUndefined()
    }
    // A map carrying the marker as its own is what DynamoDB hands back for one: plain already.
    expect(storedFormOf({ "~effect/Duration": "~effect/Duration", value: {} })).toBeUndefined()
  })

  it("leaves out a decimal's cached normalized form, which marshalling doesn't store", () => {
    const decimal = BigDecimal.fromStringUnsafe("1.50")
    Equal.equals(decimal, BigDecimal.fromStringUnsafe("1.5"))
    expect(isCachedNormal(decimal, "normalized")).toBe(true)
    expect(JSON.stringify(storedFormOf(decimal))).toBe(
      '{"value":150,"scale":2,"~effect/BigDecimal":"~effect/BigDecimal"}',
    )
  })

  it("stores a cookie's expiry as the ISO text a native write stores", () => {
    const cookie = Cookies.makeCookieUnsafe("a", "b", { expires: new Date(0) })
    expect(JSON.stringify(storedFormOf(cookie))).toBe(
      '{"name":"a","valueEncoded":"b","options":{"expires":"1970-01-01T00:00:00.000Z"},' +
        '"value":"b","~effect/http/Cookies/Cookie":"~effect/http/Cookies/Cookie"}',
    )
  })

  it("leaves the value an Option or a Result holds as it is", () => {
    const held = { b: 1, a: 2 }
    const form = storedFormOf(Option.some(held)) as Record<string, unknown>
    expect(form.value).toBe(held)
    expect(Object.keys(form)).toEqual(["_op", "~effect/Option", "value", "_tag"])
    const failed = storedFormOf(Result.fail(held)) as Record<string, unknown>
    expect(failed.failure).toBe(held)
  })

  it("leaves in place what JSON can't hold, for the serialiser to refuse where it is", () => {
    const form = storedFormOf(Duration.nanos(2n ** 60n)) as any
    expect(form.value.nanos).toBe(2n ** 60n)
    expect(() => PackedCodec.stringifyStrict({ d: Duration.nanos(2n ** 60n) }, "v")).toThrow(
      "the value at v.d.value.nanos is a bigint",
    )
    const zoned = DateTime.makeZonedUnsafe(0, { timeZone: "Europe/London" })
    expect(JSON.stringify(storedFormOf(zoned.zone))).toBe(
      '{"format":{},"id":"Europe/London","~effect/DateTime/TimeZone":"~effect/DateTime/TimeZone","_tag":"Named"}',
    )
  })

  it("refuses a cycle through one, by the serialiser", () => {
    const duration = Object.assign(Duration.millis(1), { self: undefined as unknown })
    duration.self = duration
    expect(() => PackedCodec.stringifyStrict({ d: duration }, "v")).toThrow("a circular reference")
  })
})
