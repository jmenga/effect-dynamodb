/**
 * `givenZoneReading` (#242): a row's key-form record with each zone under the name it was given, the
 * key text 1.38.0 to 1.40.0 composed on Effect 4.1.3, for `rekey` alone. The same on either Effect:
 * the stored values say the given name, and the name keyed now is the installed `Intl`'s.
 */
import { describe, expect, it } from "@effect/vitest"
import { DateTime, Option, Schema } from "effect"
import * as DynamoModel from "../src/DynamoModel.js"
import * as Entity from "../src/Entity.js"
import { getSchemaFields } from "../src/internal/SchemaAccessors.js"
import { givenZoneReading, staleZonesOf } from "../src/internal/ZoneKeyText.js"

/** A zone as 4.1.2 held it, its `id` the name `Intl` resolves `name` to. */
const keyedZone = (name: string): DateTime.TimeZone => {
  const real = DateTime.zoneMakeNamedUnsafe(name) as unknown as {
    readonly format: Intl.DateTimeFormat
  }
  const zone = Object.create(Object.getPrototypeOf(real))
  zone.id = real.format.resolvedOptions().timeZone
  zone.format = real.format
  return zone
}

/** A zone's map as Effect 4.1.3 stored it: the name given as `id`, beside `resolvedId`. */
const map413 = (id: string, resolvedId: string) => ({
  format: {},
  id,
  resolvedId,
  "~effect/DateTime/TimeZone": "~effect/DateTime/TimeZone",
  _tag: "Named",
})

describe("givenZoneReading", () => {
  it("gives a codec's zone text, stored under its given name, as that name", () => {
    expect(givenZoneReading({ id: "a", tz: "UTC" }, { id: "a", tz: "Etc/UTC" })).toEqual({
      id: "a",
      tz: "Etc/UTC",
    })
    expect(givenZoneReading({ tz: "Asia/Calcutta" }, { tz: "Asia/Kolkata" })).toEqual({
      tz: "Asia/Kolkata",
    })
  })

  it("gives a zoned date's ISO text under the zone's given name", () => {
    expect(
      givenZoneReading(
        { at: "1970-01-01T05:30:00.000+05:30[Asia/Calcutta]" },
        { at: "1970-01-01T05:30:00.000+05:30[Asia/Kolkata]" },
      ),
    ).toEqual({ at: "1970-01-01T05:30:00.000+05:30[Asia/Kolkata]" })
  })

  it("gives a zone's map, holding resolvedId beside the name given, as that name's text", () => {
    expect(
      givenZoneReading(
        { tz: keyedZone("Asia/Kolkata") },
        { tz: map413("Asia/Kolkata", "Asia/Calcutta") },
      ),
    ).toEqual({ tz: "TimeZone.Named(Asia/Kolkata)" })
  })

  it("reads each zone where it sits, in a list, an Option, a zoned date, a codec's list", () => {
    // Two zones given two names that resolve to one: each under its own.
    expect(
      givenZoneReading(
        { zl: [keyedZone("Etc/UTC"), keyedZone("GMT")] },
        { zl: [map413("Etc/UTC", "UTC"), map413("GMT", "UTC")] },
      ),
    ).toEqual({ zl: "TimeZone.Named(Etc/UTC),TimeZone.Named(GMT)" })
    expect(
      givenZoneReading(
        { zo: Option.some([keyedZone("Etc/UTC")]) },
        {
          zo: {
            _tag: "Some",
            value: [map413("Etc/UTC", "UTC")],
            "~effect/Option": "~effect/Option",
          },
        },
      ),
    ).toEqual({ zo: "some([TimeZone.Named(Etc/UTC)])" })
    expect(
      givenZoneReading(
        { zd: [DateTime.makeZonedUnsafe(0, { timeZone: keyedZone("Asia/Kolkata") })] },
        {
          zd: [
            {
              "~effect/DateTime": "~effect/DateTime",
              epochMilliseconds: 0,
              zone: map413("Asia/Kolkata", "Asia/Calcutta"),
              _tag: "Zoned",
            },
          ],
        },
      ),
    ).toEqual({ zd: "DateTime.Zoned(1970-01-01T05:30:00.000+05:30[Asia/Kolkata])" })
    expect(givenZoneReading({ zc: ["UTC", "UTC", "x"] }, { zc: ["Etc/UTC", "GMT", "x"] })).toEqual({
      zc: "Etc/UTC,GMT,x",
    })
  })

  it("gives nothing for a row naming every zone as it's keyed now", () => {
    expect(givenZoneReading({ tz: "UTC" }, { tz: "UTC" })).toBeUndefined()
    expect(givenZoneReading({ tz: "Europe/London" }, { tz: "Europe/London" })).toBeUndefined()
    expect(
      givenZoneReading(
        { tz: keyedZone("Europe/London") },
        { tz: map413("Europe/London", "Europe/London") },
      ),
    ).toBeUndefined()
    expect(givenZoneReading({ n: 5, s: "x" }, { n: "5", s: "x" })).toBeUndefined()
    // Text naming no zone, which a field's codec took to other text.
    expect(givenZoneReading({ s: "x:a" }, { s: "a" })).toBeUndefined()
  })

  it("looks only at the attributes `reads` names", () => {
    expect(
      givenZoneReading(
        { tz: "UTC", other: "UTC" },
        { tz: "Etc/UTC", other: "Etc/UTC" },
        (attr) => attr === "tz",
      ),
    ).toEqual({ tz: "Etc/UTC", other: "UTC" })
    expect(
      givenZoneReading({ other: "UTC" }, { other: "Etc/UTC" }, (attr) => attr === "tz"),
    ).toBeUndefined()
  })
})

describe("staleZonesOf", () => {
  const Placed = Entity.make({
    model: DynamoModel.configure(
      Schema.Struct({
        id: Schema.String,
        tz: Schema.TimeZoneNamed,
        tzs: Schema.Array(Schema.TimeZoneNamed),
        opt: Schema.Option(Schema.TimeZoneNamed),
        nested: Schema.Struct({ z: Schema.TimeZoneNamed, label: Schema.String }),
        at: Schema.DateTimeZoned,
        codec: Schema.TimeZoneNamedFromString,
        codecs: Schema.Array(Schema.DateTimeZonedFromString),
        u: Schema.Unknown,
        label: Schema.String,
      }),
      { at: { storedAs: DynamoModel.DateTimeZoned } },
    ),
    entityType: "Placed",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
  })
  const reads = getSchemaFields(Placed.schemas.recordSchema as Schema.Top)!
  const writes = getSchemaFields(Placed.schemas.inputSchema as Schema.Top)!
  const stale = (name: string) => staleZonesOf(reads[name]!, writes[name]!)
  const zoneIn = (value: unknown) => DateTime.zoneToString(value as DateTime.TimeZone)

  it("has nothing to say of a field no zone can be in, or one no schema types", () => {
    expect(stale("id")).toBeUndefined()
    expect(stale("label")).toBeUndefined()
    expect(stale("u")).toBeUndefined()
  })

  it("finds a zone's map holding resolvedId wherever the schema puts a zone", () => {
    expect(stale("tz")!(map413("Etc/UTC", "UTC"))!.map(({ path }) => path)).toEqual([[]])
    expect(stale("tz")!(map413("Etc/UTC", "UTC"))!.map(({ written }) => zoneIn(written))).toEqual([
      "UTC",
    ])
    // One whose given name is the resolved one holds resolvedId all the same, which a write leaves out.
    expect(stale("tz")!(map413("Europe/London", "Europe/London"))).toHaveLength(1)
    expect(
      stale("tzs")!([map413("Etc/UTC", "UTC"), map413("GMT", "UTC")])!.map(({ path }) => path),
    ).toEqual([[0], [1]])
    const some = {
      _op: "Some",
      "~effect/Option": {},
      value: map413("Etc/UTC", "UTC"),
      _tag: "Some",
    }
    expect(stale("opt")!(some)!.map(({ path }) => path)).toEqual([["value"]])
    expect(
      stale("nested")!({ z: map413("Etc/UTC", "UTC"), label: "Etc/UTC" })!.map(({ path }) => path),
    ).toEqual([["z"]])
  })

  it("finds the library's ISO text naming a zone by a name it resolves to another", () => {
    const places = stale("at")!("2023-11-15T03:43:20.000+05:30[Asia/Kolkata]")
    expect(places).toEqual([{ path: [], written: "2023-11-15T03:43:20.000+05:30[Asia/Calcutta]" }])
  })

  it("leaves Effect's string codecs' text, text in a string field, and what a write stores", () => {
    expect(stale("codec")!("Etc/UTC")).toBeUndefined()
    expect(stale("codecs")!(["1970-01-01T00:00:00.000+00:00[Etc/UTC]"])).toBeUndefined()
    const held412 = {
      format: {},
      id: "UTC",
      "~effect/DateTime/TimeZone": "~effect/DateTime/TimeZone",
      _tag: "Named",
    }
    expect(stale("tz")!(held412)).toBeUndefined()
    expect(stale("nested")!({ z: held412, label: "Etc/UTC" })).toBeUndefined()
    expect(stale("at")!("2023-11-15T03:43:20.000+05:30[Asia/Calcutta]")).toBeUndefined()
    expect(stale("tz")!("not a zone")).toBeUndefined()
  })
})
