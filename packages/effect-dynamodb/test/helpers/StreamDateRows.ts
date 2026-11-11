/**
 * `fixtures/stream-dates-1.39.0.json` holds what the published 1.39.0 stored for a date on a stream:
 * event data, metadata, snapshots and outbox items, native and packed, as a scan returned them. A
 * packed row's date is the look-alike a read handed back, the only date that release could pack.
 * What a stream reads and writes today is pinned against these rows. Never regenerate them from this
 * repo.
 */

import { readFileSync } from "node:fs"
import { gunzipSync, gzipSync } from "node:zlib"
import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import { DateTime, Equal, Schema } from "effect"
import { expect } from "vitest"

export type Row = Record<string, AttributeValue>

const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/stream-dates-1.39.0.json", import.meta.url), "utf8"),
) as {
  readonly rows: Record<string, ReadonlyArray<Record<string, any>>>
  readonly outbox: Record<string, ReadonlyArray<Record<string, any>>>
}

const fromFixture = (item: Record<string, any>): Row =>
  Object.fromEntries(
    Object.entries(item).map(([name, attribute]) => [
      name,
      attribute.B === undefined
        ? attribute
        : { B: Uint8Array.from(Buffer.from(attribute.B, "base64")) },
    ]),
  ) as Row

export const iso = "2025-01-01T00:00:00.000Z"

export const DATES = [
  ["utc", Schema.DateTimeUtc as Schema.Top, DateTime.makeUnsafe(iso)],
  [
    "named",
    Schema.DateTimeZoned as Schema.Top,
    DateTime.makeZonedUnsafe(iso, { timeZone: "Asia/Tokyo" }),
  ],
  [
    "offset",
    Schema.DateTimeZoned as Schema.Top,
    DateTime.makeZonedUnsafe(iso, { timeZone: DateTime.zoneMakeOffset(9 * 3600 * 1000) }),
  ],
] as const

export type Zone = (typeof DATES)[number][0]

export const Json = DynamoModel.Packed({ format: "json" })
export const Gzip = DynamoModel.Packed({
  format: "json",
  compression: { codec: "gzip", threshold: 1 },
})

export const PACKED = [
  ["json", Json],
  ["gzip", Gzip],
] as const

export const STORES = [["native", undefined], ...PACKED] as const

export type Store = (typeof STORES)[number][0]

/** The rows 1.39.0 stored in one stream partition: its event and its snapshot. */
export const storedRows = (
  zone: Zone,
  store: Store,
): { readonly event: Row; readonly snapshot: Row } => {
  const rows = (fixture.rows[`${zone}/${store}`] ?? []).map(fromFixture)
  return {
    event: rows.find((row) => row.data !== undefined) as Row,
    snapshot: rows.find((row) => row.state !== undefined) as Row,
  }
}

/** The rows 1.39.0 stored for one projected event: the read model, its outbox item and the event. */
export const storedOutbox = (
  zone: Zone,
): { readonly rows: ReadonlyArray<Row>; readonly event: Row; readonly outbox: Row } => {
  const rows = (fixture.outbox[zone] ?? []).map(fromFixture)
  return {
    rows,
    event: rows.find((row) => row.data !== undefined) as Row,
    outbox: rows.find((row) => row.effect !== undefined) as Row,
  }
}

/** The JSON text inside a stored packed value, whichever form it's stored in. */
export const packedText = (attribute: AttributeValue | undefined): string => {
  if (attribute?.S !== undefined) return attribute.S
  if (attribute?.B !== undefined) return gunzipSync(attribute.B.subarray(1)).toString("utf8")
  throw new Error(`not a packed value: ${JSON.stringify(attribute)}`)
}

const olderMarker = (text: string) => text.replaceAll("~effect/DateTime", "~effect/time/DateTime")

const attributeWithOlderMarker = (attribute: AttributeValue): AttributeValue => {
  if (attribute.S !== undefined) return { S: olderMarker(attribute.S) }
  if (attribute.B === undefined) {
    return JSON.parse(olderMarker(JSON.stringify(attribute))) as AttributeValue
  }
  const compressed = gzipSync(olderMarker(packedText(attribute)))
  const header = attribute.B.subarray(0, 1)
  return { B: Uint8Array.from([...header, ...compressed]) }
}

/** A row as Effect's betas and early rcs marked a date, which is how `1.0.0` stored them. */
export const withOlderMarker = (row: Row): Row =>
  Object.fromEntries(
    Object.entries(row).map(([name, attribute]) => [
      name,
      name === "data" || name === "state" || name === "metadata"
        ? attributeWithOlderMarker(attribute)
        : attribute,
    ]),
  )

/**
 * A real date and not the look-alike: `DateTime.isDateTime` is what let the plain object through, so
 * this checks the prototype, `Equal` both ways, and functions that need the prototype and the zone's
 * formatter.
 */
export const expectReal = (read: any, written: DateTime.DateTime) => {
  expect(Object.getPrototypeOf(read)).toBe(Object.getPrototypeOf(written))
  expect(Object.getPrototypeOf(read)).not.toBe(Object.prototype)
  expect(Equal.equals(read, written)).toBe(true)
  expect(Equal.equals(written, read)).toBe(true)
  expect(typeof read.pipe).toBe("function")
  expect(DateTime.getPart(read, "year")).toBe(2025)
  expect(DateTime.formatIso(read)).toBe(iso)
  if (DateTime.isZoned(written)) {
    expect(Object.getPrototypeOf(read.zone)).toBe(Object.getPrototypeOf(written.zone))
    expect(Equal.equals(read.zone, written.zone)).toBe(true)
    expect(DateTime.formatIsoZoned(read)).toBe(DateTime.formatIsoZoned(written))
  }
}
