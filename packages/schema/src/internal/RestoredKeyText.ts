/**
 * @internal The key text 1.39.0's and 1.40.0's `restore` composed for a composite the key form makes
 * an instance of, for `rekey` alone (#242).
 *
 * DynamoDB hands one of Effect's look-alikes (a `Duration`, a zone, an address, a date in an
 * `Option`, ...) back as a map. Those releases composed `put`'s key from the value given (its text,
 * `1500 millis`), but `restore` composed the key again from the tombstone read back, which held the
 * map, so the item went back under the map's text, `[object object]`, with every index key and unique
 * sentinel `restore` composed. The key form now takes the map back to the instance, so nothing in
 * normal operation looks there. `rekey` has the row in hand: {@link restoredObjectReading} is the
 * row's key-form record with each such composite under its map's text, a reading whose key text is
 * the one `restore` composed, which `rekey` recognises as an earlier position of the row and moves
 * it from.
 */
import { serializeValue } from "../KeyComposer.js"
import { defaultObjectText } from "./CompositeCodec.js"

/**
 * The row's key-form record `keyForm` with each composite whose stored value (`stored`, the row's
 * values as read) is a map composing `[object Object]`, and which the key form takes to a value of
 * other text, under the map's text: the key text 1.39.0's and 1.40.0's `restore` composed for it.
 * Only the attributes `reads` names are looked at, when it's given: those a key is composed from.
 * `undefined` when no composite reads so, which is any row whose key form keeps what's stored (text,
 * a number, a date, a struct, a value of no schema), so such a row has no other reading.
 */
export const restoredObjectReading = (
  keyForm: Record<string, unknown>,
  stored: Record<string, unknown>,
  reads?: (attr: string) => boolean,
): Record<string, unknown> | undefined => {
  let reading: Record<string, unknown> | undefined
  for (const attr of Object.keys(keyForm)) {
    if (reads !== undefined && !reads(attr)) continue
    if (!Object.hasOwn(stored, attr)) continue
    const held = stored[attr]
    if (typeof held !== "object" || held === null) continue
    let text: string | undefined
    try {
      text = defaultObjectText(held, String(held))
    } catch {
      // A map holding a `toString` attribute has no text: no release composed a key from it.
      continue
    }
    if (text === undefined || serializeValue(keyForm[attr]) === text) continue
    reading ??= { ...keyForm }
    reading[attr] = text
  }
  return reading
}
