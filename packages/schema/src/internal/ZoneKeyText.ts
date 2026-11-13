/**
 * @internal The key text 1.38.0 to 1.40.0 composed on Effect 4.1.3 for a value naming a zone, for
 * `rekey` alone (#242).
 *
 * Effect 4.1.3 kept the name a zone was made from as its `id`, where 4.1.2 held the name `Intl`
 * resolves it to. Those releases composed a zone's key text from its `id`, so on 4.1.3 a zoned date
 * made in `Asia/Kolkata` keyed `…+05:30[asia/kolkata]` where 4.1.2, and every key composed now
 * ({@link storedZoneName}), keys `…+05:30[asia/calcutta]`. Nothing in normal operation looks there:
 * `rekey` has the row in hand, and its stored values still hold the name each zone was given, in the
 * text a zoned date or a zone's string codec stored, or as the `id` of a zone's map beside its
 * `resolvedId`. {@link givenZoneReading} is the row's key-form record with each such value's key
 * text under the name it was given: a reading of the row whose key text is the one those releases
 * composed, which `rekey` recognises as an earlier position of the row and moves it from.
 *
 * Each zone is read where it sits: the key-form value is walked as every text naming a zone walks it
 * (`walkLeaves`), and each zone, or each text, is taken under the name the stored value holds at the
 * same place (the same index, property, `Option` value, zoned date's zone). So a list holding zones
 * given two names that resolve to one (`[Etc/UTC, GMT]`, keyed `[UTC, UTC]` now) reads as each was
 * given, wherever the schema puts them.
 */
import { DateTime, Option, Schema, SchemaAST } from "effect"
import { serializeValue } from "../KeyComposer.js"
import { holdsZone } from "./CompositeCodec.js"
import { isNamedZone, UNNAMED_STEP, walkLeaves, ZONE_MARKER, zoneNameOf } from "./StoredForm.js"

/** Names already resolved ({@link resolvedNameOf}), so a scan asks `Intl` once per text. */
const resolved = new Map<string, string | undefined>()

/** The name a zone made from `name` is keyed under now, or `undefined` for no zone. */
const resolvedNameOf = (name: string): string | undefined => {
  if (resolved.has(name)) return resolved.get(name)
  let zone: string | undefined
  try {
    zone = zoneNameOf(DateTime.zoneMakeNamedUnsafe(name))
  } catch {
    zone = undefined
  }
  if (resolved.size >= 4096) resolved.clear()
  resolved.set(name, zone)
  return zone
}

/** A zoned date's ISO text's zone name: the text in its closing brackets. */
const ISO_ZONE = /\[([^\]]+)\]$/

/**
 * Text naming a zone, with the zone under the name it's keyed under now: the zone in a zoned date's
 * ISO text, or the text itself. `undefined` for text naming no zone, or naming it so already.
 */
const keyedNow = (text: string): string | undefined => {
  const bracketed = ISO_ZONE.exec(text)?.[1]
  const given = bracketed ?? text
  if (given.length === 0 || given.length > 64) return undefined
  const resolved = resolvedNameOf(given)
  if (resolved === undefined || resolved === given) return undefined
  return bracketed === undefined
    ? resolved
    : `${text.slice(0, text.length - given.length - 2)}[${resolved}]`
}

/** What the stored value holds at `path` ({@link walkLeaves}' steps); `undefined` where nothing is. */
const storedAt = (stored: unknown, path: ReadonlyArray<PropertyKey>): unknown => {
  let at = stored
  for (const step of path) {
    if (step === UNNAMED_STEP || typeof at !== "object" || at === null) return undefined
    const key = typeof step === "symbol" ? step : String(step)
    if (!Object.hasOwn(at, key)) return undefined
    at = (at as Record<PropertyKey, unknown>)[key]
  }
  return at
}

/**
 * A zone under the name it was given, `id`, as 1.38.0 to 1.40.0 held it on Effect 4.1.3: its text,
 * and the text of a date zoned in it, name `id`. Built on the zone's own prototype, without a
 * `resolvedId`, so nothing names it again.
 */
const zoneGiven = (zone: DateTime.TimeZone.Named, id: string): DateTime.TimeZone => {
  const given = Object.create(Object.getPrototypeOf(zone))
  given.id = id
  given.format = (zone as unknown as { readonly format: unknown }).format
  return given
}

/**
 * A leaf of a key-form value as those releases held it, from what the row stores at its place: a
 * zone whose stored map holds `resolvedId` (written on 4.1.3) beside another `id`, under that `id`;
 * text the row stores naming a zone by another name, which the key form named again, as stored.
 */
const leafGiven = (leaf: unknown, stored: unknown): unknown => {
  if (typeof leaf === "string") {
    return typeof stored === "string" && stored !== leaf && keyedNow(stored) === leaf
      ? stored
      : leaf
  }
  if (!isNamedZone(leaf) || typeof stored !== "object" || stored === null) return leaf
  const map = stored as Record<string, unknown>
  if (!Object.hasOwn(map, ZONE_MARKER) || map._tag !== "Named") return leaf
  const { id, resolvedId } = map
  if (typeof id !== "string" || typeof resolvedId !== "string") return leaf
  return id === (leaf as unknown as { readonly id: unknown }).id ? leaf : zoneGiven(leaf, id)
}

/**
 * The row's key-form record `keyForm` with each value whose stored form (`stored`, the row's values
 * as read) names a zone by a name other than the one it's keyed under now, as the key text 1.38.0 to
 * 1.40.0 composed for it on Effect 4.1.3: under the name it was given, zone by zone. Only the
 * attributes `reads` names are looked at, when it's given: those a key is composed from. `undefined`
 * when no value does, so a row of any other kind costs one look at its key values and no other
 * reading.
 */
export const givenZoneReading = (
  keyForm: Record<string, unknown>,
  stored: Record<string, unknown>,
  reads?: (attr: string) => boolean,
): Record<string, unknown> | undefined => {
  let reading: Record<string, unknown> | undefined
  for (const attr of Object.keys(keyForm)) {
    if (reads !== undefined && !reads(attr)) continue
    const value = keyForm[attr]
    if (value === undefined || value === null || typeof value === "number") continue
    if (typeof value === "bigint" || typeof value === "boolean") continue
    if (!Object.hasOwn(stored, attr)) continue
    const held = stored[attr]
    const given = walkLeaves(value, (leaf, path) => leafGiven(leaf, storedAt(held, path)))
    if (given === value) continue
    const text = serializeValue(given)
    if (text === serializeValue(value)) continue
    reading ??= { ...keyForm }
    reading[attr] = text
  }
  return reading
}

/** A place in a stored value naming a zone otherwise than a write of the value names it now. */
export interface StaleZone {
  /** Where, in the value as stored: {@link walkLeaves}' steps, the names it's stored under. */
  readonly path: ReadonlyArray<PropertyKey>
  /** What a write of the value stores there now: a zone, or the text naming one. */
  readonly written: unknown
}

/** Whether a stored map is a named zone's that holds `resolvedId`, as 4.1.3 held one. */
const holdsResolvedId = (stored: unknown): boolean =>
  typeof stored === "object" &&
  stored !== null &&
  Object.hasOwn(stored, ZONE_MARKER) &&
  Object.hasOwn(stored, "resolvedId")

/**
 * Whether a value read back can name a zone otherwise than a write names it now: it holds a named
 * zone's map with a `resolvedId`, or text naming a zone (alone, or a zoned date's ISO text) by a name
 * that isn't the one `Intl` resolves it to. One walk of what was read, and no decode.
 */
const mayNameStaleZone = (stored: unknown): boolean => {
  const open: Array<unknown> = [stored]
  while (open.length > 0) {
    const value = open.pop()
    if (typeof value === "string") {
      if (keyedNow(value) !== undefined) return true
      continue
    }
    if (typeof value !== "object" || value === null) continue
    if (holdsResolvedId(value)) return true
    if (Array.isArray(value) || value instanceof Set) {
      for (const element of value) open.push(element)
      continue
    }
    if (ArrayBuffer.isView(value)) continue
    for (const element of Object.values(value)) open.push(element)
  }
  return false
}

/**
 * A named zone whose `id` is `PROBE` and whose name the library writes ({@link zoneNameOf}) is the
 * zone's own: text a write encodes it to under `PROBE` came from its `id` (one of Effect's string
 * codecs, or an application's), and any other text from the library (a zoned date's ISO text).
 */
const PROBE = "~effect-dynamodb/probe"
const zoneProbe = (zone: DateTime.TimeZone.Named): DateTime.TimeZone => {
  const probe = Object.create(Object.getPrototypeOf(zone))
  probe.id = PROBE
  probe.resolvedId = zoneNameOf(zone)
  probe.format = (zone as unknown as { readonly format: unknown }).format
  return probe
}

const pathKey = (path: ReadonlyArray<PropertyKey>): string =>
  path.map((step) => (typeof step === "symbol" ? "\u0000" : String(step))).join("\u0001")

/**
 * For a field whose values can name a zone (`holdsZone`): the places in a value of it, as read back,
 * naming a zone otherwise than a write of the same value stores it now (#242), for `rekey` alone. Each
 * place is one the field's schema puts a zone or a zoned date's text at: the value is decoded as a
 * read decodes it (`read`, the field's schema reading a row) and encoded as a write encodes it
 * (`write`, its schema writing one), and every zone and every text in that is compared
 * with what was read at its place ({@link walkLeaves}). Two kinds are places: a named zone's map
 * holding `resolvedId`, as 1.38.0 to 1.40.0 stored every named zone on Effect 4.1.3, which a write
 * stores now without it, under the resolved name; and the library's ISO text of a zoned date naming
 * its zone by a name the runtime resolves to another, as those releases wrote it on 4.1.3, which a
 * write names by the resolved name now. The text of one of Effect's string codecs, or an
 * application's, is the codec's, and isn't one: what tells it from the library's is that it changes
 * with the zone's `id` ({@link zoneProbe}). Nothing else is a place: a place holding what a write
 * stores, a value the schema doesn't type (`Schema.Unknown`), any other difference. `undefined` for
 * any other field, and from the function returned when there's no place, or the value doesn't decode.
 */
export const staleZonesOf = (
  read: Schema.Top,
  write: Schema.Top,
): ((stored: unknown) => ReadonlyArray<StaleZone> | undefined) | undefined => {
  if (!holdsZone(SchemaAST.toType(write.ast))) return undefined
  const decode = Schema.decodeUnknownOption(read as unknown as Schema.Codec<unknown, unknown>)
  const encode = Schema.encodeUnknownOption(write as unknown as Schema.Codec<unknown, unknown>)
  return (stored) => {
    if (!mayNameStaleZone(stored)) return undefined
    let decoded: unknown
    let written: unknown
    try {
      const read = decode(stored)
      if (Option.isNone(read)) return undefined
      decoded = read.value
      const encoded = encode(decoded)
      if (Option.isNone(encoded)) return undefined
      written = encoded.value
    } catch {
      return undefined
    }
    /** The text a write encodes at each place with every zone a probe: built when text differs. */
    let probed: Map<string, unknown> | undefined
    const libraryText = (path: ReadonlyArray<PropertyKey>, text: string): boolean => {
      if (probed === undefined) {
        probed = new Map()
        try {
          const probe = walkLeaves(decoded, (leaf) => (isNamedZone(leaf) ? zoneProbe(leaf) : leaf))
          const encoded = encode(probe)
          if (Option.isSome(encoded)) {
            walkLeaves(encoded.value, (leaf, at) => {
              probed!.set(pathKey(at), leaf)
              return leaf
            })
          }
        } catch {
          // No probe: no text is taken for the library's.
        }
      }
      return probed.get(pathKey(path)) === text
    }
    const stale: Array<StaleZone> = []
    walkLeaves(written, (leaf, path) => {
      const at = storedAt(stored, path)
      const named = isNamedZone(leaf)
        ? holdsResolvedId(at)
        : typeof leaf === "string" &&
          typeof at === "string" &&
          at !== leaf &&
          keyedNow(at) === leaf &&
          libraryText(path, leaf)
      if (named) stale.push({ path: [...path], written: leaf })
      return leaf
    })
    return stale.length > 0 ? stale : undefined
  }
}
