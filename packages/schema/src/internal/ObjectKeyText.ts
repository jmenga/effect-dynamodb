/**
 * @internal An object composed into a key (#242, `EDD-9162`): every object nothing gives other text
 * to composes `[object Object]`, so rows written with different values would share one key.
 *
 * Not part of the public API.
 */

import type * as DynamoSchema from "../DynamoSchema.js"
import { KeyValueError } from "./NumericKey.js"

/**
 * The key text a composite's key-form value composes when it's an object nothing gives other text
 * to, `[object Object]` (or another `[object …]` tag), which every such value composes alike, so rows
 * written with different values would share one key (#242, `EDD-9162`). `undefined` for any other
 * value: text, a number, a date, a look-alike the key form makes an instance of, a class with a
 * `toString` of its own. `text` is the text the value composed.
 */
export const defaultObjectText = (value: unknown, text: string): string | undefined =>
  typeof value === "object" && value !== null && text === Object.prototype.toString.call(value)
    ? text
    : undefined

/**
 * The refusal of an object composed into a key for a write (`EDD-9162`): `what` names the field and
 * what composes it, and `text` is the text it composed.
 */
export const objectKeyRefusal = (what: string, text: string): string =>
  `${what}, and the value given composes the key text "${text}", which every such object ` +
  "composes alike: items written with different values would share one key. Nothing was written. " +
  "Compose the key from a field holding text, a number or a date, or give the value a toString of " +
  "its own. A get, a delete or a query given such a value still composes that text, to reach a row " +
  "an earlier release wrote. [EDD-9162]"

/**
 * The one decision, made where a key composer composes `value`'s `text` (`site` says where): under a
 * write's own schema (`objectKeys`), a value composing default object text there throws the refusal,
 * a value key composition can't place (`KeyValueError`), which every write path turns into a
 * `ValidationError` with nothing sent. A key the write doesn't compose never reaches this, so it
 * refuses nothing.
 */
export const judgeObjectKeyText = (
  schema: DynamoSchema.DynamoSchema,
  value: unknown,
  text: string,
  site: () => DynamoSchema.ObjectKeySite,
): void => {
  const own = schema.objectKeys
  if (own === undefined) return
  const refused = defaultObjectText(value, text)
  if (refused === undefined) return
  const what = own(site())
  if (what === undefined) return
  throw new KeyValueError({
    value,
    reason: `it composes the key text "${refused}"`,
    message: objectKeyRefusal(what, refused),
  })
}
