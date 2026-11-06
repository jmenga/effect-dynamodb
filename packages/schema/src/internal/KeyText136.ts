/**
 * KeyText136 — the key texts rows can be stored under, for `rekey` (#171, #183).
 *
 * Every operation composes one key text, the one the schema's `escapeKeys` setting chooses, and
 * reads and writes nothing else. A row stored under another text isn't found by any read until
 * `db.tables.<Table>.rekey()` moves it. This module is what `rekey` recognises such a row by. The
 * key texts differ in:
 *
 * - **Numbers.** Up to 1.36, and with `escapeKeys` off, `String(n)` zero-padded to 16 characters
 *   (a bigint to 38), which keeps non-negative integers below 1e16 in order and nothing else.
 *   1.37.0, 1.38.0 and `escapeKeys: true` encode every number in numeric order (`NumericKey.ts`). The
 *   text of a non-negative integer below 1e16 (1e38 for a bigint) is the same.
 * - **Strings.** With `escapeKeys: true` a key value holding a code point U+0000–U+0025 is escaped
 *   (`KeyComposer.escapeKeyText`) in every key. 1.37.0 and 1.38.0 escaped sort keys only. Off, and up to 1.36,
 *   none. The structural parts of a key are never escaped.
 * - **Time-series event keys.** Up to 1.36, and off, they hold the orderBy attribute's ENCODED
 *   value (a `NumberFromString` `"10"` as the string `10`), and with numeric text its key form
 *   (`0000000000000010`): `KeyComposer.eventOrderByValue`.
 *
 * So there are four places a row can be, {@link forms}: each a pair of schemas whose composers give
 * its partition and sort key text. `test/KeyText136.test.ts` checks the composers against golden
 * vectors the published 1.36.0 packages composed.
 *
 * Not part of the public API.
 */

import * as DynamoSchema from "../DynamoSchema.js"
import { composePk, composeSk, type IndexDefinition, unescapeKeyText } from "../KeyComposer.js"
import { decodeBigInt, decodeNumber } from "./NumericKey.js"

/** The schema composing the key text 1.36 composed: what `escapeKeys` off composes. */
export const schema136 = (schema: DynamoSchema.DynamoSchema): DynamoSchema.DynamoSchema =>
  DynamoSchema.make({
    name: schema.name,
    version: schema.version,
    casing: schema.casing,
    escapeKeys: false,
  })

/**
 * The schema whose partition key text is what 1.37.0 and 1.38.0 stored: its numbers in numeric order, its
 * strings unescaped.
 */
export const schema137 = (schema: DynamoSchema.DynamoSchema): DynamoSchema.DynamoSchema => ({
  ...schema136(schema),
  numericKeyText: true,
})

/** The schema composing the key text of `escapeKeys: true`. */
export const schemaEscaped = (schema: DynamoSchema.DynamoSchema): DynamoSchema.DynamoSchema =>
  DynamoSchema.make({
    name: schema.name,
    version: schema.version,
    casing: schema.casing,
    escapeKeys: true,
  })

/** One place a row can be stored: the schemas that compose its partition and sort key text. */
export interface KeyForm {
  readonly pk: DynamoSchema.DynamoSchema
  readonly sk: DynamoSchema.DynamoSchema
}

/**
 * Every place a row can be stored, whatever the setting is now, the current one among them:
 * up to 1.36 and off; 1.37.0 and 1.38.0; on.
 */
export const forms = (schema: DynamoSchema.DynamoSchema): ReadonlyArray<KeyForm> => {
  const off = schema136(schema)
  const on = schemaEscaped(schema)
  return [
    { pk: off, sk: off },
    { pk: schema137(schema), sk: on },
    { pk: on, sk: on },
  ]
}

/**
 * The row 1.37.0 and 1.38.0 stored on an entity with an index half in a table key attribute (inverted): each half
 * was overwritten with the index's, so its partition key attribute holds the sort half's text
 * (escaped), and its sort key attribute the partition half's (not).
 */
export const invertedForm137 = (schema: DynamoSchema.DynamoSchema): KeyForm => ({
  pk: schemaEscaped(schema),
  sk: schema137(schema),
})

/**
 * A row holding no values (a projection's row tombstone or outbox item) says which text its key is
 * by its `__edd_kt__` attribute: none, off's (1.36's), whose text every setting reads the same when
 * nothing in it changes; 1, that of 1.37.0 and 1.38.0; 2, the text of `escapeKeys: true`.
 */
export const formOfMark = (
  schema: DynamoSchema.DynamoSchema,
  mark: string | undefined,
): KeyForm => {
  const off = schema136(schema)
  const on = schemaEscaped(schema)
  if (mark === "1") return { pk: schema137(schema), sk: on }
  if (mark === "2") return { pk: on, sk: on }
  return { pk: off, sk: off }
}

/** The `__edd_kt__` of a row holding no values, keyed for `record` under `schema` ({@link formOfMark}). */
export const markOf = (
  schema: DynamoSchema.DynamoSchema,
  entityType: string,
  entityVersion: number,
  index: IndexDefinition,
  record: Record<string, unknown>,
): 2 | undefined => {
  if (schema.escapeKeys !== true) return undefined
  const off = schema136(schema)
  const now = composeAt({ pk: schema, sk: schema }, entityType, entityVersion, index, record)
  const then = composeAt({ pk: off, sk: off }, entityType, entityVersion, index, record)
  return now[index.pk.field] === then[index.pk.field] &&
    now[index.sk.field] === then[index.sk.field]
    ? undefined
    : 2
}

/** The JavaScript type a composite's key form takes (`CompositeCodec.keyFormValueKind`). */
export type ValueKind = "string" | "number" | "bigint" | "boolean" | undefined

/**
 * A composite's text under `under` back as the key-form value it was composed from: a number or
 * bigint from its padded or numeric key text, a boolean from `true` / `false` in any casing,
 * anything else as the (cased) text, unescaped where `under` escapes. `undefined` when the text is
 * no bigint or boolean; text that is no number reads as `NaN`, which composes only `NaN`'s text.
 */
const valueOf = (under: DynamoSchema.DynamoSchema, rawText: string, kind: ValueKind): unknown => {
  const text = under.escapeKeys === true ? unescapeKeyText(rawText) : rawText
  if (kind === "number" || kind === "bigint") {
    if (under.escapeKeys === true || under.numericKeyText === true) {
      return kind === "number" ? decodeNumber(text) : decodeBigInt(text)
    }
    const digits = text.replace(/^0+/, "")
    const unpadded = digits === "" ? "0" : digits.startsWith(".") ? `0${digits}` : digits
    // Casing may have changed `Infinity`'s letters, which `Number` reads in one spelling.
    if (kind === "number") return Number(unpadded.replace(/^(-?)infinity$/i, "$1Infinity"))
    try {
      return BigInt(unpadded)
    } catch {
      return undefined
    }
  }
  if (kind === "boolean") {
    const lower = text.toLowerCase()
    return lower === "true" ? true : lower === "false" ? false : undefined
  }
  return text
}

/** How many readings of one key {@link readIndexKeys} tries before it gives up on it. */
const MAX_READINGS = 8

/** Placeholder `i` in a key template: no casing changes it, and no prefix or label holds it. */
const placeholder = (i: number): string => `\u0000${i}\u0000`

/** The partition and sort key of `index` under `form`. Throws when a composite is missing. */
export const composeAt = (
  form: KeyForm,
  entityType: string,
  entityVersion: number,
  index: IndexDefinition,
  record: Record<string, unknown>,
): Record<string, string> => ({
  [index.pk.field]: composePk(form.pk, entityType, index, record),
  [index.sk.field]: composeSk(form.sk, entityType, entityVersion, index, record),
})

/**
 * The key-form values `form` composed `stored` — a primary key `index` stores rows under — from,
 * read back from its text, for a row that holds no values of its own (a projection's row
 * tombstone or outbox item, which carry only the key they were written for). Each composite's
 * text is what lies between the key's fixed parts (the prefix, labels and delimiters {@link
 * composeAt} writes around it), turned back into a value by `kindOf` ({@link valueOf}); a reading
 * counts only when {@link composeAt} composes exactly `stored` from it. `undefined` unless exactly
 * one reading does: none, when `stored` is not `form`'s text of any values, and more than one when
 * a string value holds the delimiter and the next composite's label.
 *
 * A string comes back cased, which composes the same key text as the value it was cased from.
 */
export const readIndexKeys = (
  form: KeyForm,
  entityType: string,
  entityVersion: number,
  index: IndexDefinition,
  stored: Readonly<Record<string, unknown>>,
  kindOf: (attr: string) => ValueKind,
): Record<string, unknown> | undefined => {
  const attrs = [...new Set([...index.pk.composite, ...index.sk.composite])]
  // The fixed parts are the same under every form, and off leaves a placeholder as it is.
  const off = schema136(form.pk)
  const template = composeAt(
    { pk: off, sk: off },
    entityType,
    entityVersion,
    index,
    Object.fromEntries(attrs.map((attr, i) => [attr, placeholder(i)])),
  )
  /** Every way `text` splits into `template`'s parts: each composite's text, by attribute. */
  const readings = (text: string, layout: string): Array<Map<number, string>> => {
    // Fixed text and slot numbers alternate: `placeholder` brackets each number.
    const parts = layout.split("\u0000")
    const found: Array<Map<number, string>> = []
    const walk = (at: number, part: number, taken: Map<number, string>): void => {
      if (found.length >= MAX_READINGS) return
      const slot = Number(parts[part])
      const after = parts[part + 1]!
      if (part + 2 === parts.length) {
        if (!text.endsWith(after) || text.length - after.length < at) return
        found.push(new Map(taken).set(slot, text.slice(at, text.length - after.length)))
        return
      }
      for (let end = text.indexOf(after, at); end !== -1; end = text.indexOf(after, end + 1)) {
        walk(end + after.length, part + 2, new Map(taken).set(slot, text.slice(at, end)))
      }
    }
    if (!text.startsWith(parts[0]!)) return []
    if (parts.length === 1) return text === parts[0] ? [new Map()] : []
    walk(parts[0]!.length, 1, new Map())
    return found
  }
  const pk = stored[index.pk.field]
  const sk = stored[index.sk.field]
  if (typeof pk !== "string" || typeof sk !== "string") return undefined
  const fits: Array<Record<string, unknown>> = []
  for (const fromPk of readings(pk, template[index.pk.field]!)) {
    for (const fromSk of readings(sk, template[index.sk.field]!)) {
      const record: Record<string, unknown> = {}
      let consistent = true
      const read = (halves: Map<number, string>, under: DynamoSchema.DynamoSchema) => {
        for (const [slot, text] of halves) {
          const attr = attrs[slot]!
          const value = valueOf(under, text, kindOf(attr))
          if (value === undefined || (attr in record && record[attr] !== value)) consistent = false
          record[attr] = value
        }
      }
      read(fromPk, form.pk)
      read(fromSk, form.sk)
      if (!consistent) continue
      try {
        const keys = composeAt(form, entityType, entityVersion, index, record)
        if (keys[index.pk.field] === pk && keys[index.sk.field] === sk) fits.push(record)
      } catch {
        // `NaN` read from no number: not this form's text.
      }
    }
  }
  return fits.length === 1 ? fits[0] : undefined
}
