/**
 * @internal What one of Effect's own instances is stored as, for packed storage to write.
 *
 * The marshaller stores a class instance as the map of its enumerable properties, its prototype's
 * included, and a read rebuilds Effect's look-alikes from that map (`EffectInstances`). JSON has no
 * instance, so packed storage refused one: a `Duration` in a packed struct, the same value a native
 * attribute stores and reads back, couldn't be written at all. {@link storedFormOf} is that map, in
 * the order DynamoDB Local hands it back, so an instance packs to the bytes the map read back from a
 * native row packs to, as a real date always has ({@link storedDate}).
 *
 * The map is built as the marshaller builds it: each enumerable property, its prototype's included,
 * without a function or `undefined`, and without a decimal's cached normalized form
 * ({@link isCachedNormal}). Inside one of Effect's look-alikes, everything is the library's own data,
 * so it's what the unmarshaller hands back: a bigint is the number it reads as while it's a safe
 * integer, and a cookie's expiry is the ISO text a native write stores. What JSON still can't hold
 * (binary, a bigint past 2^53, a `Date` anywhere else) is left in place, for the strict serialiser
 * to refuse where it is. An `Option` or a `Result` holds the caller's value, which is packed by the
 * rules every packed value is: only the map around it is built here.
 */
import { BigDecimal, DateTime, Option, Result } from "effect"
import * as Cookies from "effect/http/Cookies"

/** The marker a marshalled `DateTime` carries. */
export const DATE_MARKER = "~effect/DateTime"
/** The marker it carried on Effect's betas and early rcs. */
export const BETA_DATE_MARKER = "~effect/time/DateTime"
export const ZONE_MARKER = "~effect/DateTime/TimeZone"
export const BIG_DECIMAL_MARKER = "~effect/BigDecimal"
export const DURATION_MARKER = "~effect/Duration"
export const COOKIE_MARKER = "~effect/http/Cookies/Cookie"
export const COOKIES_MARKER = "~effect/http/Cookies"
export const URL_PARAMS_MARKER = "~effect/http/UrlParams"
export const SEMVER_MARKER = "~effect/SemVer"
export const SEMVER_RANGE_MARKER = "~effect/SemVerRange"
export const NET_ADDRESS_MARKER = "~effect/net/NetAddress"
export const IP_NETWORK_MARKER = "~effect/net/IpNetwork"
export const IP_INTERFACE_MARKER = "~effect/net/IpInterface"
export const HOST_MARKER = "~effect/net/Host"
export const DNS_RECORD_MARKER = "~effect/net/Dns/DnsRecord"
const OPTION_MARKER = "~effect/Option"
const RESULT_MARKER = "~effect/Result"

/** The look-alikes a read rebuilds (`EffectInstances`), a date apart: all of each is Effect's data. */
const LOOK_ALIKES: ReadonlyArray<string> = [
  BIG_DECIMAL_MARKER,
  DURATION_MARKER,
  ZONE_MARKER,
  COOKIE_MARKER,
  COOKIES_MARKER,
  URL_PARAMS_MARKER,
  SEMVER_MARKER,
  SEMVER_RANGE_MARKER,
  NET_ADDRESS_MARKER,
  IP_NETWORK_MARKER,
  IP_INTERFACE_MARKER,
  HOST_MARKER,
  DNS_RECORD_MARKER,
]

/** The instances that hold the caller's value, which Effect's own declarations rebuild on read. */
const HOLDERS: ReadonlyArray<string> = [OPTION_MARKER, RESULT_MARKER]

const isPlainObject = (value: object): boolean => {
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * Whether a value carries a marker on its prototype: one of Effect's instances does, where the map
 * DynamoDB hands back for one carries it as its own.
 */
const inherits = (value: object, marker: string): boolean => {
  if (Object.hasOwn(value, marker)) return false
  for (let at = Object.getPrototypeOf(value); at !== null; at = Object.getPrototypeOf(at)) {
    if (Object.hasOwn(at, marker)) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// A decimal's cached normalized form
// ---------------------------------------------------------------------------

/** A `BigDecimal` itself, not the map DynamoDB hands back for one: its marker is on the prototype. */
export const isBigDecimalInstance = (value: object): value is BigDecimal.BigDecimal =>
  BigDecimal.isBigDecimal(value) && !Object.hasOwn(value, BIG_DECIMAL_MARKER)

/**
 * An own property's value read from its descriptor, or `undefined` for an accessor: a getter is
 * never called.
 */
const ownData = (value: object, key: string): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined
}

/**
 * Whether a decimal's cached `normalized` form leads into a cycle: the one `BigDecimal.normalize`
 * caches holds itself, so following it never ends.
 */
export const cachesCycle = (decimal: BigDecimal.BigDecimal): boolean => {
  const seen = new Set<object>()
  let current: unknown = decimal
  while (typeof current === "object" && current !== null && isBigDecimalInstance(current)) {
    if (seen.has(current)) return true
    seen.add(current)
    current = ownData(current, "normalized")
  }
  return false
}

/**
 * Whether a property of an object is a decimal's cached `normalized` form, which marshalling doesn't
 * store: what compares two values as stored, and what packs one, leave it out too. Reads descriptors
 * only, so no getter is called.
 */
export const isCachedNormal = (value: object, key: string): boolean =>
  key === "normalized" && isBigDecimalInstance(value) && cachesCycle(value)

// ---------------------------------------------------------------------------
// A cookie's expiry
// ---------------------------------------------------------------------------

/** The prototype of Effect's own cookies. */
export const COOKIE_PROTO: object = Object.getPrototypeOf(Cookies.makeCookieUnsafe("a", "b"))

/** Whether a `Date` holds anything marshalling would store of it, which then isn't an empty map. */
const holdsAnything = (date: Date): boolean => {
  for (const key in date) {
    const property = (date as unknown as Record<string, unknown>)[key]
    if (property !== undefined && typeof property !== "function") return true
  }
  return false
}

/**
 * A cookie's expiry as a native write stores it: the ISO text of a valid `Date` marshalling would
 * store as an empty map. `undefined` for anything else, which is stored as marshalling makes it.
 */
export const expiryText = (expires: unknown): string | undefined =>
  expires instanceof Date &&
  !Number.isNaN(Date.prototype.getTime.call(expires)) &&
  !holdsAnything(expires)
    ? Date.prototype.toISOString.call(expires)
    : undefined

// ---------------------------------------------------------------------------
// A named zone's name
// ---------------------------------------------------------------------------

/**
 * The name a named zone is stored, keyed, compared and written in ISO text under, from what it holds:
 * its `resolvedId` where it holds one as text, otherwise its `id`. The one decision on what names a
 * zone; `undefined` for one holding neither as text.
 *
 * Effect 4.1.3 gave a named zone a `resolvedId`, the name its `Intl` formatter resolves it to, and
 * kept the name it was made from as its `id` (`Etc/UTC`, resolved `UTC`). Up to 4.1.2 the `id` was
 * that resolved name, and there was no `resolvedId`. So this is the resolved name on either Effect,
 * for a zone made fresh or rebuilt from a stored map of either form, and two zones Effect holds equal
 * (`Equal.equals`) have the same one: 4.1.3 compares `resolvedId` against `resolvedId ?? id`. It's
 * the `id` 1.40.0 stored on 4.1.2. The resolved name is what the runtime's `Intl` makes of the name a
 * zone was made from, so it is the runtime's: `Asia/Kolkata` is `Asia/Calcutta` on this one.
 */
export const storedZoneName = (id: unknown, resolvedId: unknown): string | undefined =>
  typeof resolvedId === "string" ? resolvedId : typeof id === "string" ? id : undefined

/**
 * The `id` a named zone's map is written with where it holds a `resolvedId`, which the write leaves
 * out ({@link storedZoneName}); `undefined` for any other map, written as it is. Every write of a zone
 * takes it, from the entries it obtained: the map a native write marshalled, a packed one, a zone's
 * own properties, a map that only looks like one. A map holding `resolvedId` was written on 4.1.3 by
 * a release storing a zone as Effect held it; it is read as the zone it is, and written as 4.1.2 held
 * it the next time the item is.
 */
export const rewrittenZoneId = (
  tag: unknown,
  id: unknown,
  resolvedId: unknown,
): string | undefined =>
  tag === "Named" && typeof id === "string" && typeof resolvedId === "string"
    ? storedZoneName(id, resolvedId)
    : undefined

/**
 * Entries a write obtained of a map, with a named zone's written as {@link rewrittenZoneId} says:
 * `id` under the resolved name, in its place, and no `resolvedId`. The same array when it isn't one.
 * `isZone` says the map carries a zone's marker, its own or its prototype's.
 */
export const zoneEntriesWritten = <V>(
  entries: ReadonlyArray<readonly [string, V]>,
  isZone: boolean,
  text: (value: V) => unknown,
  named: (name: string) => V,
): ReadonlyArray<readonly [string, V]> => {
  if (!isZone) return entries
  const of = (key: string) => {
    const entry = entries.find(([at]) => at === key)
    return entry === undefined ? undefined : text(entry[1])
  }
  const id = rewrittenZoneId(of("_tag"), of("id"), of("resolvedId"))
  if (id === undefined) return entries
  return entries.flatMap(([key, value]) =>
    key === "resolvedId"
      ? []
      : key === "id"
        ? [[key, named(id)] as const]
        : [[key, value] as const],
  )
}

/** A named zone's name ({@link storedZoneName}), read from its own data: no getter is called. */
export const zoneNameOf = (zone: object): string | undefined =>
  storedZoneName(ownData(zone, "id"), ownData(zone, "resolvedId"))

/** One of Effect's zones itself, not the map DynamoDB hands back for one: its marker is inherited. */
export const isZoneInstance = (value: object): boolean => inherits(value, ZONE_MARKER)

/** A zone under this name, as Effect makes one from it; `undefined` when it can't. */
const namedZone = (name: string): DateTime.TimeZone | undefined => {
  try {
    return DateTime.zoneMakeNamedUnsafe(name)
  } catch {
    return undefined
  }
}

/**
 * A value whose text names a zone, with each of Effect's named zones in it under the name
 * {@link storedZoneName} gives it, so its text is the text 4.1.2 gave it, and two values Effect holds
 * equal have one text: a zone itself, the zone of a zoned date, and the value of an `Option` or a
 * `Result`, whose text is their content's. The same reference when nothing in it changes.
 */
export const zonesAsStored = (value: unknown): unknown => {
  if (typeof value !== "object" || value === null || isPlainObject(value)) return value
  if (isZoneInstance(value)) {
    if (!DateTime.isTimeZoneNamed(value)) return value
    const name = zoneNameOf(value)
    return name === undefined || ownData(value, "id") === name ? value : (namedZone(name) ?? value)
  }
  if (isRealDate(value)) {
    if (!DateTime.isZoned(value)) return value
    const zone = zonesAsStored(value.zone) as DateTime.TimeZone
    return zone === value.zone
      ? value
      : DateTime.makeZonedUnsafe(value.epochMilliseconds, { timeZone: zone })
  }
  if (inherits(value, OPTION_MARKER) && Option.isOption(value) && Option.isSome(value)) {
    const held = zonesAsStored(value.value)
    return held === value.value ? value : Option.some(held)
  }
  if (inherits(value, RESULT_MARKER) && Result.isResult(value)) {
    const held = Result.isSuccess(value) ? value.success : value.failure
    const stored = zonesAsStored(held)
    if (stored === held) return value
    return Result.isSuccess(value) ? Result.succeed(stored) : Result.fail(stored)
  }
  return value
}

/**
 * Whether a value names a zone ({@link zonesAsStored} takes it): a named zone, a date zoned in one, or
 * an `Option` or a `Result` holding one.
 */
export const namesZone = (value: unknown): boolean => {
  if (typeof value !== "object" || value === null || isPlainObject(value)) return false
  if (isZoneInstance(value)) return DateTime.isTimeZoneNamed(value)
  if (isRealDate(value)) return DateTime.isZoned(value) && DateTime.isTimeZoneNamed(value.zone)
  if (inherits(value, OPTION_MARKER) && Option.isOption(value)) {
    return Option.isSome(value) && namesZone(value.value)
  }
  if (inherits(value, RESULT_MARKER) && Result.isResult(value)) {
    return namesZone(Result.isSuccess(value) ? value.success : value.failure)
  }
  return false
}

/** A zoned date as ISO text with its zone's name, the name 4.1.2 gave it ({@link zonesAsStored}). */
export const zonedIsoText = (date: DateTime.Zoned): string =>
  DateTime.formatIsoZoned(zonesAsStored(date) as DateTime.Zoned)

// ---------------------------------------------------------------------------
// DynamoDB Local's order
// ---------------------------------------------------------------------------

/** Java's `String.hashCode`, spread as a `HashMap` spreads it. */
const spread = (key: string): number => {
  let hash = 0
  for (let index = 0; index < key.length; index++) {
    hash = (Math.imul(31, hash) + key.charCodeAt(index)) | 0
  }
  return hash ^ (hash >>> 16)
}

/** The table a `HashMap` holds this many keys in: sized for them, doubled past three quarters full. */
const tableSize = (count: number): number => {
  let size = 1
  while (size < count) size *= 2
  while (count > size * 0.75) size *= 2
  return size
}

/**
 * A map with its keys in the order DynamoDB Local hands a stored map back: by the bucket each lands
 * in, and in the order written within one. Measured against every map published 1.39.0 stored for
 * one of Effect's look-alikes. A key that's an array index comes first in any JavaScript object, and
 * the unmarshaller's map is one, so it does here too.
 */
export const inStoredOrder = (
  entries: ReadonlyArray<readonly [string, unknown]>,
): Record<string, unknown> => {
  const mask = tableSize(entries.length) - 1
  const ordered = entries
    .map((entry, index) => ({ entry, bucket: spread(entry[0]) & mask, index }))
    .sort((a, b) => a.bucket - b.bucket || a.index - b.index)
  const map: Record<string, unknown> = Object.create(null)
  for (const { entry } of ordered) map[entry[0]] = entry[1]
  return map
}

// ---------------------------------------------------------------------------
// Stored forms
// ---------------------------------------------------------------------------

const isRealDate = (value: object): value is DateTime.DateTime =>
  DateTime.isDateTime(value) && !isPlainObject(value)

/**
 * What a real date is stored as, packed: the map a native write stores, with its keys in the order
 * DynamoDB Local hands that map back, which is what a date read back from one has always been packed
 * as. `toJSON` would give ISO text, which a date's declaration refuses on read.
 */
const storedDate = (date: DateTime.DateTime): object => {
  if (DateTime.isUtc(date)) {
    return { epochMilliseconds: date.epochMilliseconds, [DATE_MARKER]: DATE_MARKER, _tag: "Utc" }
  }
  const zone = date.zone
  return {
    [DATE_MARKER]: DATE_MARKER,
    epochMilliseconds: date.epochMilliseconds,
    zone:
      zone._tag === "Named"
        ? {
            format: {},
            id: zoneNameOf(zone) ?? zone.id,
            [ZONE_MARKER]: ZONE_MARKER,
            _tag: "Named",
          }
        : { offset: zone.offset, [ZONE_MARKER]: ZONE_MARKER, _tag: "Offset" },
    _tag: "Zoned",
  }
}

/** What marshalling stores of a property: nothing of a function or of `undefined`. */
const isStored = (property: unknown): boolean =>
  property !== undefined && typeof property !== "function"

/**
 * A value inside one of Effect's look-alikes, as the unmarshaller hands it back. `open` holds the
 * objects being built around it: one met again is left in place, so the serialiser names the cycle.
 */
const libraryValue = (value: unknown, open: Set<object>): unknown => {
  if (typeof value === "bigint") return Number.isSafeInteger(Number(value)) ? Number(value) : value
  if (typeof value !== "object" || value === null || open.has(value)) return value
  if (Array.isArray(value)) {
    open.add(value)
    const elements = value.filter(isStored).map((element) => libraryValue(element, open))
    open.delete(value)
    return elements
  }
  const form = formOf(value, open)
  if (form !== undefined) return form
  // A named zone's formatter: marshalling stores the nothing it enumerates.
  if (value instanceof Intl.DateTimeFormat) return libraryMap(value, open)
  return isPlainObject(value) ? libraryMap(value, open) : value
}

/**
 * An object inside one of Effect's look-alikes, or one itself, as the map a native write stores: a
 * named zone holding `resolvedId` under the name {@link rewrittenZoneId} gives it, without it.
 */
const libraryMap = (value: object, open: Set<object>, cookieOptions = false): object => {
  open.add(value)
  const cookie = Object.getPrototypeOf(value) === COOKIE_PROTO
  const entries: Array<readonly [string, unknown]> = []
  for (const key in value) {
    if (isCachedNormal(value, key)) continue
    const property = (value as Record<string, unknown>)[key]
    if (!isStored(property)) continue
    const expiry = cookieOptions && key === "expires" ? expiryText(property) : undefined
    entries.push([
      key,
      expiry !== undefined
        ? expiry
        : cookie && key === "options" && typeof property === "object" && property !== null
          ? open.has(property)
            ? property
            : libraryMap(property, open, true)
          : libraryValue(property, open),
    ])
  }
  open.delete(value)
  return inStoredOrder(
    zoneEntriesWritten(
      entries,
      ZONE_MARKER in value,
      (entry) => entry,
      (name) => name,
    ),
  )
}

/**
 * An `Option` or a `Result` as the map marshalling stores: its own properties are the caller's
 * value, left as they are, and the rest (its tag and marker) are Effect's.
 */
const holderMap = (value: object, open: Set<object>): object => {
  open.add(value)
  const entries: Array<readonly [string, unknown]> = []
  for (const key in value) {
    const property = (value as Record<string, unknown>)[key]
    if (!isStored(property)) continue
    entries.push([key, Object.hasOwn(value, key) ? property : libraryValue(property, open)])
  }
  open.delete(value)
  return inStoredOrder(entries)
}

const formOf = (value: object, open: Set<object>): object | undefined => {
  if (isPlainObject(value)) return undefined
  if (isRealDate(value)) return storedDate(value)
  if (LOOK_ALIKES.some((marker) => inherits(value, marker))) return libraryMap(value, open)
  if (HOLDERS.some((marker) => inherits(value, marker))) return holderMap(value, open)
  return undefined
}

/**
 * What one of Effect's own instances is stored as, for packed storage to write: a date, one of the
 * look-alikes a read rebuilds, an `Option` or a `Result`, as the map a native write stores, in the
 * order DynamoDB Local hands it back. `undefined` for any other value, which packed storage refuses
 * as it always has.
 */
export const storedFormOf = (value: object): object | undefined => formOf(value, new Set())
