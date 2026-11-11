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
 */
import { DateTime } from "effect"
import { serializeValue } from "../KeyComposer.js"
import { ZONE_MARKER, zoneNameOf } from "./StoredForm.js"

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

type Given = ReadonlyArray<readonly [resolved: string, given: string]>

/**
 * The zones a stored value names by a name other than the one it's keyed under now, as pairs of the
 * name keyed now and the name given: the zone of a zoned date's ISO text, a zone's name stored as
 * text (`top`: the value itself, whose key text a field's codec took to another text), and a zone's
 * map holding `resolvedId` beside the `id` it was given, wherever it sits.
 */
const givenNames = (
  stored: unknown,
  found: Array<readonly [string, string]>,
  open: Set<object>,
  top: boolean,
) => {
  if (typeof stored === "string") {
    const given = ISO_ZONE.exec(stored)?.[1] ?? (top ? stored : undefined)
    if (given === undefined || given.length === 0 || given.length > 64) return
    const resolved = resolvedNameOf(given)
    if (resolved !== undefined && resolved !== given) found.push([resolved, given])
    return
  }
  if (typeof stored !== "object" || stored === null || open.has(stored)) return
  open.add(stored)
  if (Array.isArray(stored)) {
    for (const element of stored) givenNames(element, found, open, false)
    return
  }
  const map = stored as Record<string, unknown>
  if (Object.hasOwn(map, ZONE_MARKER) && map._tag === "Named") {
    const { id, resolvedId } = map
    if (typeof id === "string" && typeof resolvedId === "string" && id !== resolvedId) {
      found.push([resolvedId, id])
      const now = resolvedNameOf(resolvedId)
      if (now !== undefined && now !== resolvedId) found.push([now, id])
    }
  }
  for (const key of Object.keys(map)) givenNames(map[key], found, open, false)
}

/** A value's key text with each zone under the name it was given. */
const givenText = (text: string, given: Given): string => {
  let out = text
  for (const [resolved, name] of given) {
    if (out === resolved) return name
    out = out
      .split(`[${resolved}]`)
      .join(`[${name}]`)
      .split(`TimeZone.Named(${resolved})`)
      .join(`TimeZone.Named(${name})`)
  }
  return out
}

/**
 * The row's key-form record `keyForm` with each value whose stored form (`stored`, the row's values
 * as read) names a zone by a name other than the one it's keyed under now, as the key text 1.38.0 to
 * 1.40.0 composed for it on Effect 4.1.3: under the name it was given. Only the attributes `reads`
 * names are looked at, when it's given: those a key is composed from. `undefined` when no value
 * does, so a row of any other kind costs one look at its key values and no other reading.
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
    // Text the key form keeps as it is names no zone another way: a field's codec took a zone's
    // text to its name keyed now, or there's nothing to read.
    if (typeof held === "string" && (typeof value !== "string" || value === held)) continue
    const found: Array<readonly [string, string]> = []
    givenNames(held, found, new Set(), true)
    if (found.length === 0) continue
    const text = serializeValue(value)
    const given = givenText(text, found)
    if (given === text) continue
    reading ??= { ...keyForm }
    reading[attr] = given
  }
  return reading
}
