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
import { DateTime } from "effect"
import { serializeValue } from "../KeyComposer.js"
import { isNamedZone, UNNAMED_STEP, walkLeaves, ZONE_MARKER, zoneNameOf } from "./StoredForm.js"

/** The name a zone made from `name` is keyed under now, or `undefined` for no zone. */
const resolvedNameOf = (name: string): string | undefined => {
  try {
    return zoneNameOf(DateTime.zoneMakeNamedUnsafe(name))
  } catch {
    return undefined
  }
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
