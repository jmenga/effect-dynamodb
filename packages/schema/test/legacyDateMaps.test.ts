/**
 * `buildDateTransform` decode of LEGACY marshalled `DateTime` maps (#133).
 *
 * Before #133 an aggregate stored some `DateTime`s by marshalling the instance
 * itself, producing `{ epochMilliseconds, <type-id key>, _tag }` maps. The
 * type-id key changed between effect 4.0.0-rc (`~effect/time/DateTime`) and
 * 4.0.0 (`~effect/DateTime`). The tolerant date transform must rebuild a REAL
 * domain value from either form (or none) rather than:
 *
 * - rejecting the rc-era map (`Expected DateTime.Utc`), or
 * - passing a 4.0.0-era map through because it duck-types as a `DateTime`,
 *   which hands the caller a plain object that is not `Equal` to the instant.
 */
import { describe, expect, it } from "@effect/vitest"
import { DateTime, Effect, Equal, Schema } from "effect"
import { buildDateTransform } from "../src/internal/EntitySchemas.js"

const MS = 946684800000 // 2000-01-01T00:00:00.000Z

const utcMap = (typeIdKey: string | undefined) => ({
  epochMilliseconds: MS,
  ...(typeIdKey === undefined ? {} : { [typeIdKey]: typeIdKey }),
  _tag: "Utc",
})

const legacyUtcMaps = [
  ["rc-era (~effect/time/DateTime)", utcMap("~effect/time/DateTime")],
  ["4.0.0-era (~effect/DateTime)", utcMap("~effect/DateTime")],
  ["no type-id key", utcMap(undefined)],
] as const

const decodeWith = (domain: "DateTime.Utc" | "DateTime.Zoned" | "Date") =>
  Schema.decodeUnknownEffect(buildDateTransform({ storage: "string", domain }) as Schema.Codec<any>)

const isRealUtc = (value: unknown): boolean =>
  DateTime.isDateTime(value) &&
  DateTime.isUtc(value) &&
  Object.getPrototypeOf(value) !== Object.prototype &&
  Equal.equals(value, DateTime.makeUnsafe(MS))

describe("buildDateTransform — legacy marshalled DateTime maps", () => {
  for (const [name, map] of legacyUtcMaps) {
    it.effect(`lifts a ${name} Utc map to a real DateTime.Utc`, () =>
      Effect.gen(function* () {
        const decoded = yield* decodeWith("DateTime.Utc")(map)
        expect(isRealUtc(decoded)).toBe(true)
      }),
    )

    it.effect(`lifts a ${name} Utc map to a Date for the Date domain`, () =>
      Effect.gen(function* () {
        const decoded = yield* decodeWith("Date")(map)
        expect(decoded).toBeInstanceOf(Date)
        expect((decoded as Date).getTime()).toBe(MS)
      }),
    )

    it.effect(`lifts a ${name} Utc map to a UTC-zoned DateTime for the Zoned domain`, () =>
      Effect.gen(function* () {
        const decoded = yield* decodeWith("DateTime.Zoned")(map)
        expect(DateTime.isZoned(decoded)).toBe(true)
        expect(DateTime.toEpochMillis(decoded)).toBe(MS)
      }),
    )
  }

  it.effect("rebuilds a marshalled Zoned map with a named zone", () =>
    Effect.gen(function* () {
      const decoded = yield* decodeWith("DateTime.Zoned")({
        epochMilliseconds: MS,
        zone: { id: "Asia/Tokyo", format: {}, "~effect/DateTime/TimeZone": "x", _tag: "Named" },
        "~effect/DateTime": "~effect/DateTime",
        _tag: "Zoned",
      })
      const expected = DateTime.makeZonedUnsafe(MS, { timeZone: "Asia/Tokyo" })
      expect(Object.getPrototypeOf(decoded)).not.toBe(Object.prototype)
      expect(Equal.equals(decoded, expected)).toBe(true)
      expect(DateTime.formatIsoZoned(decoded as DateTime.Zoned)).toBe(
        DateTime.formatIsoZoned(expected),
      )
    }),
  )

  it.effect("rebuilds a marshalled Zoned map with an offset zone", () =>
    Effect.gen(function* () {
      const decoded = yield* decodeWith("DateTime.Zoned")({
        epochMilliseconds: MS,
        zone: { offset: 3_600_000, _tag: "Offset" },
        _tag: "Zoned",
      })
      const expected = DateTime.makeZonedUnsafe(MS, {
        timeZone: DateTime.zoneMakeOffset(3_600_000),
      })
      expect(DateTime.formatIsoZoned(decoded as DateTime.Zoned)).toBe(
        DateTime.formatIsoZoned(expected),
      )
    }),
  )

  it.effect("passes a genuine DateTime through unchanged", () =>
    Effect.gen(function* () {
      const real = DateTime.makeUnsafe(MS)
      const decoded = yield* decodeWith("DateTime.Utc")(real)
      expect(decoded).toBe(real)
    }),
  )

  it.effect("still lifts the wire forms", () =>
    Effect.gen(function* () {
      expect(isRealUtc(yield* decodeWith("DateTime.Utc")("2000-01-01T00:00:00.000Z"))).toBe(true)
      expect(isRealUtc(yield* decodeWith("DateTime.Utc")(MS))).toBe(true)
    }),
  )

  it.effect("rejects a map that carries no instant (a marshalled Date)", () =>
    Effect.gen(function* () {
      const result = yield* Effect.flip(decodeWith("Date")({}))
      expect(result._tag).toBe("SchemaError")
    }),
  )

  it.effect("rejects a map whose instant is not a number", () =>
    Effect.gen(function* () {
      const result = yield* Effect.flip(
        decodeWith("DateTime.Utc")({ epochMilliseconds: "nope", _tag: "Utc" }),
      )
      expect(result._tag).toBe("SchemaError")
    }),
  )
})
