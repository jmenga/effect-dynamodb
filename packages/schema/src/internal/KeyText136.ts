/**
 * KeyText136 — the key text effect-dynamodb 1.36 composed (#171).
 *
 * 1.37 composes some key text differently, so a row 1.36 wrote with such a
 * value sits under a key 1.37 does not compose:
 *
 * - **Numbers** (`serializeValue`): 1.36 zero-padded `String(n)` to 16
 *   characters (a bigint to 38), which kept non-negative integers below 1e16
 *   in order and nothing else; 1.37 encodes every number in numeric order
 *   (`NumericKey.ts`). The text of a non-negative integer below 1e16 (1e38 for
 *   a bigint) is unchanged.
 * - **Sort key values** holding a code point U+0000–U+0025 — a control
 *   character, space, `!`, `"`, `#`, `$` or `%` — are escaped in 1.37
 *   (`KeyComposer.sortKeyText`) and were not in 1.36. Partition keys, unique
 *   sentinels and the structural parts of a key are not escaped.
 * - **Time-series event keys** carried the orderBy attribute's ENCODED value
 *   (a `NumberFromString` `"10"` as the string `10`); 1.37 composes its key
 *   form (`0000000000000010`).
 *
 * Everything else — the key layout, casing, the history, sentinel, aggregate
 * and EventStore key shapes — is unchanged, so these functions compose 1.36's
 * bytes through the same `DynamoSchema` composers, fed 1.36's serialization.
 * Z-order sort keys are new in 1.37 and have no 1.36 form: `composeAllKeys`
 * leaves a Z-order index out.
 *
 * Every function takes the same key-form record its `KeyComposer` counterpart
 * does. `test/KeyText136.test.ts` checks them against golden vectors the
 * published 1.36.0 packages composed.
 *
 * The 1.37.x operations read and move rows still under their 1.36 keys while
 * the fallback is {@link enabled}; the fallback and this module go in the next
 * major release. Not part of the public API.
 */

import { DateTime } from "effect"
import * as DynamoSchema from "../DynamoSchema.js"
import {
  applyCasing,
  composeClusteredSortKey,
  composeCollectionKey,
  composeIsolatedSortKey,
  composeKey,
  KEY_DELIMITER,
} from "../DynamoSchema.js"
import { effectiveCasing, type IndexDefinition, isZOrderHalf } from "../KeyComposer.js"

/** Whether operations read and move rows under their 1.36 keys (`DynamoSchema.make`'s `legacyKeys`). */
export const enabled = (schema: DynamoSchema.DynamoSchema): boolean => schema.legacyKeys !== false

/** `%`: the highest code point 1.37 escapes in sort key text, and the first of every escape. */
const ESCAPE = 0x25

/**
 * Does sort key value text `text` hold a code point 1.37 escapes (U+0000–
 * U+0025)? Then its key text differs from 1.36's — and holds an escape, which
 * 1.36's text of another value can spell: `foo%20bar` is `foo bar`'s key now.
 */
export const holdsEscaped = (text: string): boolean => {
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) <= ESCAPE) return true
  }
  return false
}

/**
 * The first character of `text` below `%` (U+0000–U+0024), if any. Escaped
 * text never holds one, nor does any text whose casing is escaped text, so a
 * stored value holding it is not the 1.36 spelling of an escape.
 */
export const firstBelowEscape = (text: string): string | undefined => {
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) < ESCAPE) return text[i]
  }
  return undefined
}

/**
 * 1.36's composite value text: a number zero-padded to 16 characters, a bigint
 * to 38 — `String(n)` padded, so `-3` is `00000000000000-3` and `2.5` is
 * `00000000000002.5` — a boolean as `true` / `false`, a date as its ISO
 * string. Never throws: 1.36 composed `NaN` as `0000000000000NaN`.
 */
export const serializeValue = (value: unknown): string => {
  if (typeof value === "string") return value
  if (typeof value === "number") return String(value).padStart(16, "0")
  if (typeof value === "bigint") return String(value).padStart(38, "0")
  if (typeof value === "boolean") return value ? "true" : "false"
  if (typeof value === "object" && value !== null && DateTime.isDateTime(value)) {
    return DateTime.formatIso(value)
  }
  if (value instanceof Date) return value.toISOString()
  return String(value)
}

/** `KeyComposer.extractComposites` with 1.36's {@link serializeValue}. */
export const extractComposites = (
  composite: ReadonlyArray<string>,
  record: Record<string, unknown>,
): ReadonlyArray<string> =>
  composite.map((attr) => {
    const value = record[attr]
    if (value === undefined || value === null) {
      throw new Error(`Missing composite attribute "${attr}" in record`)
    }
    return serializeValue(value)
  })

/** {@link extractComposites}, or `undefined` when a composite is missing. */
export const tryExtractComposites = (
  composite: ReadonlyArray<string>,
  record: Record<string, unknown>,
): ReadonlyArray<string> | undefined =>
  composite.every((attr) => record[attr] !== undefined && record[attr] !== null)
    ? extractComposites(composite, record)
    : undefined

/** 1.36's partition key of `index` (`KeyComposer.composePk`). */
export const composePk = (
  schema: DynamoSchema.DynamoSchema,
  entityType: string,
  index: IndexDefinition,
  record: Record<string, unknown>,
): string => {
  const composites = extractComposites(index.pk.composite, record)
  const names = [...index.pk.composite]
  const collection = index.collection
  if (collection !== undefined) {
    const collectionName = Array.isArray(collection) ? collection[0]! : collection
    return composeCollectionKey(schema, collectionName, composites, { casing: index.casing, names })
  }
  return composeKey(schema, entityType, composites, { casing: index.casing, names })
}

/** The sort key text 1.36 composed from `composites` (unescaped values). */
const sortKeyOf = (
  schema: DynamoSchema.DynamoSchema,
  entityType: string,
  entityVersion: number,
  index: IndexDefinition,
  composites: ReadonlyArray<string>,
  names: ReadonlyArray<string>,
): string => {
  const collection = index.collection
  if (collection !== undefined) {
    if ((index.type ?? "isolated") === "clustered") {
      return composeClusteredSortKey(schema, collection, entityType, entityVersion, composites, {
        casing: index.casing,
        names,
      })
    }
    return composeIsolatedSortKey(schema, entityType, entityVersion, composites, {
      casing: index.casing,
      names,
    })
  }
  return composeKey(schema, entityType, composites, { casing: index.casing, names })
}

/** 1.36's sort key of a string-keyed `index` (`KeyComposer.composeSk`), values unescaped. */
export const composeSk = (
  schema: DynamoSchema.DynamoSchema,
  entityType: string,
  entityVersion: number,
  index: IndexDefinition,
  record: Record<string, unknown>,
): string =>
  sortKeyOf(
    schema,
    entityType,
    entityVersion,
    index,
    extractComposites(index.sk.composite, record),
    index.sk.composite,
  )

/** Both 1.36 keys of a string-keyed `index`. */
export const composeIndexKeys = (
  schema: DynamoSchema.DynamoSchema,
  entityType: string,
  entityVersion: number,
  index: IndexDefinition,
  record: Record<string, unknown>,
): Record<string, string> => ({
  [index.pk.field]: composePk(schema, entityType, index, record),
  [index.sk.field]: composeSk(schema, entityType, entityVersion, index, record),
})

/** {@link composeIndexKeys}, or `undefined` when a composite is missing (a sparse index). */
export const tryComposeIndexKeys = (
  schema: DynamoSchema.DynamoSchema,
  entityType: string,
  entityVersion: number,
  index: IndexDefinition,
  record: Record<string, unknown>,
): Record<string, string> | undefined => {
  const present = (composite: ReadonlyArray<string>) =>
    composite.every((attr) => record[attr] !== undefined && record[attr] !== null)
  if (!present(index.pk.composite) || !present(index.sk.composite)) return undefined
  return composeIndexKeys(schema, entityType, entityVersion, index, record)
}

/**
 * Every index's 1.36 keys (`KeyComposer.composeAllKeys`): the primary index's
 * always, a GSI's when all its composites are present. A Z-order index is new
 * in 1.37, so it has none.
 */
export const composeAllKeys = (
  schema: DynamoSchema.DynamoSchema,
  entityType: string,
  entityVersion: number,
  indexes: Record<string, IndexDefinition>,
  record: Record<string, unknown>,
): Record<string, string> => {
  const result: Record<string, string> = {}
  for (const [indexName, index] of Object.entries(indexes)) {
    if (isZOrderHalf(index.sk)) continue
    if (indexName === "primary") {
      Object.assign(result, composeIndexKeys(schema, entityType, entityVersion, index, record))
    } else {
      const keys = tryComposeIndexKeys(schema, entityType, entityVersion, index, record)
      if (keys !== undefined) Object.assign(result, keys)
    }
  }
  return result
}

/**
 * 1.36's sort key prefix from the leading sort key composites present in
 * `record` (`KeyComposer.composeSortKeyPrefix`).
 */
export const composeSortKeyPrefix = (
  schema: DynamoSchema.DynamoSchema,
  entityType: string,
  entityVersion: number,
  index: IndexDefinition,
  record: Record<string, unknown>,
): string => {
  const names: Array<string> = []
  for (const attr of index.sk.composite) {
    if (record[attr] === undefined || record[attr] === null) break
    names.push(attr)
  }
  return sortKeyOf(
    schema,
    entityType,
    entityVersion,
    index,
    extractComposites(names, record),
    names,
  )
}

/**
 * 1.36's `begins_with` operand: {@link composeSortKeyPrefix}, with the key
 * delimiter appended while composites remain unsupplied.
 */
export const composeSortKeyBeginsWith = (
  schema: DynamoSchema.DynamoSchema,
  entityType: string,
  entityVersion: number,
  index: IndexDefinition,
  record: Record<string, unknown>,
): string => {
  const prefix = composeSortKeyPrefix(schema, entityType, entityVersion, index, record)
  const supplied = index.sk.composite.findIndex(
    (attr) => record[attr] === undefined || record[attr] === null,
  )
  return supplied === -1 ? prefix : `${prefix}${KEY_DELIMITER}`
}

/** How many leading sort key composites `record` holds. */
const leadingSupplied = (index: IndexDefinition, record: Record<string, unknown>): number => {
  const i = index.sk.composite.findIndex(
    (attr) => record[attr] === undefined || record[attr] === null,
  )
  return i === -1 ? index.sk.composite.length : i
}

/**
 * The condition that selects, under 1.36's key text, the rows a query
 * accessor's pins select (`KeyComposer.composeSortKeyCondition`): `eq` on the
 * complete key, else `beginsWith` on the prefix and the delimiter.
 */
export const composeSortKeyCondition = (
  schema: DynamoSchema.DynamoSchema,
  entityType: string,
  entityVersion: number,
  index: IndexDefinition,
  record: Record<string, unknown>,
): { readonly eq: string } | { readonly beginsWith: string } => {
  const prefix = composeSortKeyPrefix(schema, entityType, entityVersion, index, record)
  return leadingSupplied(index, record) === index.sk.composite.length
    ? { eq: prefix }
    : { beginsWith: `${prefix}${KEY_DELIMITER}` }
}

/**
 * The condition that selects, under 1.36's key text, the rows an `eq` or
 * `beginsWith` bound on sort key composite `field` selects, every composite
 * before it pinned in `pinned` (`composeRangeUnder` in `DynamoClient.ts`):
 * `eq` on the last composite is its key, on any other the value's subtree (the
 * delimiter appended); a `beginsWith` is a prefix of the value's text, or `eq`
 * for a number, which has no text prefix.
 */
export const composeBoundCondition = (
  schema: DynamoSchema.DynamoSchema,
  entityType: string,
  entityVersion: number,
  index: IndexDefinition,
  pinned: Record<string, unknown>,
  field: string,
  bound: { readonly eq: unknown } | { readonly beginsWith: unknown },
): { readonly eq: string } | { readonly beginsWith: string } => {
  const casing = effectiveCasing(schema, index)
  const prefix = composeSortKeyBeginsWith(schema, entityType, entityVersion, index, pinned)
  const segment = (value: unknown) =>
    `${prefix}${applyCasing(field, casing)}_${applyCasing(serializeValue(value), casing)}`
  if ("beginsWith" in bound) {
    const operand = bound.beginsWith
    if (typeof operand !== "number" && typeof operand !== "bigint") {
      return { beginsWith: segment(operand) }
    }
  }
  const value = "eq" in bound ? bound.eq : bound.beginsWith
  const last = index.sk.composite.indexOf(field) === index.sk.composite.length - 1
  return last ? { eq: segment(value) } : { beginsWith: `${segment(value)}${KEY_DELIMITER}` }
}

/**
 * 1.36's time-series event sort key: `currentSk` (the current item's 1.36 sort
 * key), the cased `e` infix and the orderBy attribute's ENCODED value — not
 * its key form — through 1.36's {@link serializeValue}, cased.
 */
export const composeEventSk = (
  currentSk: string,
  encodedOrderBy: unknown,
  casing: DynamoSchema.Casing = "lowercase",
): string =>
  `${currentSk}#${applyCasing("e", casing)}#${applyCasing(serializeValue(encodedOrderBy), casing)}`

/** 1.36's unique-constraint sentinel key over the constraint's field values, in order. */
export const composeUniqueKey = (
  schema: DynamoSchema.DynamoSchema,
  entityType: string,
  constraintName: string,
  values: ReadonlyArray<unknown>,
): { readonly pk: string; readonly sk: string } =>
  DynamoSchema.composeUniqueKey(schema, entityType, constraintName, values.map(serializeValue))

/** 1.36's vector index partition value, or `undefined` when a composite is missing. */
export const tryComposeVectorPartition = (
  schema: DynamoSchema.DynamoSchema,
  entityType: string,
  index: { readonly partition: ReadonlyArray<string>; readonly casing?: DynamoSchema.Casing },
  record: Record<string, unknown>,
): string | undefined => {
  const composites = tryExtractComposites(index.partition, record)
  if (composites === undefined) return undefined
  return composeKey(schema, entityType, composites, {
    casing: index.casing,
    names: [...index.partition],
  })
}

/**
 * The 1.36 primary key of the item at `record` when the fallback is
 * {@link enabled} and its text differs from `current` — the key 1.37
 * composes — else `undefined`: the item can only be at `current`.
 */
export const changedPrimaryKey = (
  schema: DynamoSchema.DynamoSchema,
  entityType: string,
  entityVersion: number,
  primary: IndexDefinition,
  record: Record<string, unknown>,
  current: Readonly<Record<string, unknown>>,
): Record<string, string> | undefined => {
  if (!enabled(schema)) return undefined
  const keys = composeIndexKeys(schema, entityType, entityVersion, primary, record)
  return keys[primary.pk.field] === current[primary.pk.field] &&
    keys[primary.sk.field] === current[primary.sk.field]
    ? undefined
    : keys
}

/** The JavaScript type a composite's key form takes (`CompositeCodec.keyFormValueKind`). */
export type ValueKind = "string" | "number" | "bigint" | "boolean" | undefined

/**
 * A composite's 1.36 text back as the key-form value it was composed from:
 * a number or bigint without the zeros {@link serializeValue} padded it with,
 * a boolean from `true` / `false` in any casing, anything else as the (cased)
 * text. `undefined` when the text is no bigint or boolean; text that is no
 * number reads as `NaN`, which composes only `NaN`'s text.
 */
const valueOf136 = (text: string, kind: ValueKind): unknown => {
  if (kind === "number" || kind === "bigint") {
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

/**
 * The key-form values 1.36 composed `stored` — a primary key `index` stores
 * rows under — from, read back from its text, for a row that holds no values
 * of its own (a projection's row tombstone or outbox item, which carry only
 * the key they were written for). Each composite's text is what lies between
 * the key's fixed parts (the prefix, labels and delimiters {@link
 * composeIndexKeys} writes around it), turned back into a value by `kindOf`
 * ({@link valueOf136}); a reading counts only when {@link composeIndexKeys}
 * composes exactly `stored` from it. `undefined` unless exactly one reading
 * does: none, when `stored` is not 1.36 text of any values (1.37 text of a
 * changed number, say), and more than one when a string value holds the
 * delimiter and the next composite's label.
 *
 * A string comes back cased, which composes the same key text, in 1.36 and
 * 1.37 alike, as the value it was cased from.
 */
export const readIndexKeys = (
  schema: DynamoSchema.DynamoSchema,
  entityType: string,
  entityVersion: number,
  index: IndexDefinition,
  stored: Readonly<Record<string, unknown>>,
  kindOf: (attr: string) => ValueKind,
): Record<string, unknown> | undefined => {
  const attrs = [...new Set([...index.pk.composite, ...index.sk.composite])]
  const template = composeIndexKeys(
    schema,
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
      for (const [slot, text] of [...fromPk, ...fromSk]) {
        const attr = attrs[slot]!
        const value = valueOf136(text, kindOf(attr))
        if (value === undefined || (attr in record && record[attr] !== value)) consistent = false
        record[attr] = value
      }
      if (!consistent) continue
      const keys = composeIndexKeys(schema, entityType, entityVersion, index, record)
      if (keys[index.pk.field] === pk && keys[index.sk.field] === sk) fits.push(record)
    }
  }
  return fits.length === 1 ? fits[0] : undefined
}
