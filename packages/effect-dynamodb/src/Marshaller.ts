/**
 * Marshaller — Thin wrapper around @aws-sdk/util-dynamodb for converting
 * between JS objects and DynamoDB attribute maps.
 *
 * Date-aware (de)serialization is no longer handled here — both Entity and
 * Aggregate now route date conversion through substituted bidirectional
 * Schema transforms (`buildDateTransform` in `internal/EntitySchemas.ts`)
 * and the standard `Schema.encode` / `Schema.decode` pipelines.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb"
import type { SparseConfig } from "@effect-dynamodb/schema/DynamoModel.js"
import { Data } from "effect"

const MARSHALL_OPTIONS = { removeUndefinedValues: true, convertClassInstanceToMap: true } as const

/** A set DynamoDB can't store: nothing in it, once `undefined` values are removed. */
export const isEmptySet = (value: unknown): boolean =>
  value instanceof Set && [...value].every((element) => element === undefined)

/** `undefined` or an empty set: stored as an absent attribute. */
export const hasNoStoredForm = (value: unknown): boolean => value === undefined || isEmptySet(value)

const renderPath = (
  path: ReadonlyArray<string | number>,
  fieldOf: (attribute: string) => string = (attribute) => attribute,
): string =>
  path.reduce<string>(
    (text, segment, index) =>
      typeof segment === "number"
        ? `${text}[${segment}]`
        : index === 0
          ? fieldOf(segment)
          : `${text}.${segment}`,
    "",
  )

/**
 * A value DynamoDB can't store, and where it is (`EDD-9124`). Marshalling throws this, as
 * key composition throws `KeyValueError`; what reaches it is the caller's value, so a
 * write path turns it into a `ValidationError` (`marshalOrFail`).
 */
export class UnstorableValue extends Data.TaggedError("UnstorableValue")<{
  readonly path: ReadonlyArray<string | number>
  readonly reason: string
}> {
  override get message(): string {
    return this.describe()
  }

  /** The refusal in words, naming a stored attribute by what `fieldOf` makes of it. */
  describe(fieldOf?: (attribute: string) => string): string {
    const refused =
      this.path.length === 0 ? this.reason : `"${renderPath(this.path, fieldOf)}": ${this.reason}`
    return `${refused.endsWith(".") ? refused : `${refused}.`} [EDD-9124]`
  }
}

export const isUnstorableValue = (value: unknown): value is UnstorableValue =>
  value instanceof UnstorableValue

/**
 * What marshalling stores of an object, in the order it stores it: its enumerable properties, its
 * prototype's included. An `Option`'s `_tag`, or a `Result`'s, is on the prototype, and a copy of
 * the own properties alone is a row that can't be read.
 */
const propertiesOf = (value: object): ReadonlyArray<readonly [string, unknown]> => {
  const properties: Array<readonly [string, unknown]> = []
  for (const key in value) properties.push([key, (value as Record<string, unknown>)[key]])
  return properties
}

/**
 * The value without the empty sets in its maps, the same reference when it has
 * none. A list keeps its elements: leaving one out would move those after it, so
 * marshalling refuses an empty set there.
 */
const withoutEmptySets = (value: unknown): unknown => {
  if (typeof value !== "object" || value === null) return value
  if (Array.isArray(value)) {
    const elements = value.map((element) => withoutEmptySets(element))
    return elements.some((element, index) => element !== value[index]) ? elements : value
  }
  if (value instanceof Map) {
    const entries = [...value].filter(([, entry]) => !isEmptySet(entry))
    const next = entries.map(([key, entry]) => [key, withoutEmptySets(entry)] as const)
    const same =
      entries.length === value.size && next.every(([key, entry]) => entry === value.get(key))
    return same ? value : new Map(next)
  }
  const entries = propertiesOf(value)
  const next = entries
    .filter(([, entry]) => !isEmptySet(entry))
    .map(([key, entry]) => [key, withoutEmptySets(entry)] as const)
  const same =
    next.length === entries.length &&
    next.every(([key, entry]) => entry === (value as Record<string, unknown>)[key])
  return same ? value : Object.fromEntries(next)
}

/** Whether marshalling refuses a value. */
const isRefused = (value: unknown): boolean => {
  try {
    marshall({ v: value }, MARSHALL_OPTIONS)
    return false
  } catch {
    return true
  }
}

const partsOf = (value: unknown): ReadonlyArray<readonly [string | number, unknown]> => {
  if (Array.isArray(value)) return value.map((element, index) => [index, element] as const)
  if (value instanceof Map) return [...value]
  if (typeof value !== "object" || value === null) return []
  return propertiesOf(value)
}

/**
 * The deepest part of a value marshalling refuses, as the error saying so. Marshalling
 * walks in this order and stops at the first it refuses, so `reason` is that part's.
 */
const unstorableAt = (
  value: unknown,
  path: ReadonlyArray<string | number>,
  reason: string,
): UnstorableValue => {
  for (const [key, part] of partsOf(value)) {
    if (isRefused(part)) return unstorableAt(part, [...path, key], reason)
  }
  return new UnstorableValue({
    path,
    reason: isEmptySet(value) ? NO_EMPTY_SET : reason,
  })
}

const NO_EMPTY_SET =
  "DynamoDB has no empty set, and a list element can't be left out without moving those after it."

/**
 * DynamoDB can't store an empty set, so one is an absent attribute. Marshalling
 * refuses it, and only then are the item's empty sets looked for: an item without
 * any costs nothing and marshals exactly as it did. Whatever is still refused has
 * no attribute to leave out, and throws {@link UnstorableValue}.
 */
const marshallStorable = (item: Record<string, unknown>): Record<string, AttributeValue> => {
  try {
    return marshall(item, MARSHALL_OPTIONS)
  } catch {
    const storable = withoutEmptySets(item) as Record<string, unknown>
    try {
      return marshall(storable, MARSHALL_OPTIONS)
    } catch (cause) {
      throw unstorableAt(storable, [], cause instanceof Error ? cause.message : String(cause))
    }
  }
}

/**
 * What in these attributes DynamoDB can't store, or `undefined`, for a path that
 * has to know before it reads or sends anything. An attribute holding an empty set
 * is left out, as when it's written.
 */
export const unstorableIn = (attributes: Record<string, unknown>): UnstorableValue | undefined => {
  try {
    marshallStorable(attributes)
    return undefined
  } catch (error) {
    if (isUnstorableValue(error)) return error
    throw error
  }
}

/** Marshall a JS object to a DynamoDB attribute map */
export const toAttributeMap = (item: Record<string, unknown>): Record<string, AttributeValue> =>
  marshallStorable(item)

/** Unmarshall a DynamoDB attribute map to a JS object */
export const fromAttributeMap = (item: Record<string, AttributeValue>): Record<string, unknown> =>
  unmarshall(item)

/**
 * Marshall a single value to a DynamoDB attribute value. An empty set directly
 * here is refused, as marshalling refuses it: a caller holding a value to send has
 * no attribute to leave out, and has to decide what no value means. A refusal names
 * the value's `name`, when it has one.
 */
export const toAttributeValue = (value: unknown, name?: string): AttributeValue => {
  const at = name === undefined ? [] : [name]
  if (isEmptySet(value))
    throw new UnstorableValue({ path: at, reason: "DynamoDB has no empty set." })
  try {
    return marshallStorable({ v: value }).v!
  } catch (error) {
    if (!isUnstorableValue(error)) throw error
    throw new UnstorableValue({ path: [...at, ...error.path.slice(1)], reason: error.reason })
  }
}

/** Unmarshall a single DynamoDB attribute value */
export const fromAttributeValue = (value: AttributeValue): unknown => unmarshall({ v: value }).v

// ---------------------------------------------------------------------------
// Sparse Map flatten / rebuild
// ---------------------------------------------------------------------------

/**
 * Validate a sparse-map key at write time.
 *
 * Rules:
 *  - Must be a string (we don't silently coerce).
 *  - Must not contain `#` — `#` is reserved as the prefix/key delimiter.
 *  - The composed `<prefix>#<key>` must satisfy DynamoDB's 1–255 byte
 *    attribute-name limit.
 *
 * Throws on violation. Caller is expected to translate into a tagged
 * `ValidationError` at the entity boundary.
 */
const validateSparseKey = (field: string, prefix: string, key: string): void => {
  if (typeof key !== "string") {
    throw new Error(`Sparse map "${field}": key must be a string, got ${typeof key}`)
  }
  if (key.length === 0) {
    throw new Error(`Sparse map "${field}": key must be non-empty`)
  }
  if (key.includes("#")) {
    throw new Error(
      `Sparse map "${field}": key "${key}" must not contain '#' — the library does not silently escape`,
    )
  }
  const attrName = `${prefix}#${key}`
  // DynamoDB attribute names: 1–255 bytes. Length check is approximate (UTF-8
  // bytes vs JS code units), but `key.length + prefix.length + 1` is an upper
  // bound on byte length when both are ASCII, which is the common case.
  // For full UTF-8 correctness, encode via TextEncoder.
  const byteLen = new TextEncoder().encode(attrName).length
  if (byteLen < 1 || byteLen > 255) {
    throw new Error(
      `Sparse map "${field}": composed attribute name "${attrName}" is ${byteLen} bytes (must be 1–255)`,
    )
  }
}

/**
 * Flatten sparse-map fields on an item before marshalling.
 *
 * For each `(fieldName, { prefix })` in `sparseFields`:
 *  - If `item[fieldName]` is undefined/null, drop the field (no-op).
 *  - Otherwise, expect `Record<string, V>`. For each `(k, v)`:
 *      validate `k`, write `item["<prefix>#<k>"] = v`.
 *  - Delete the original `item[fieldName]` so it doesn't marshal as a Map.
 *
 * Mutates `item` in place. Idempotent on items already flattened (the field is
 * absent — the for/in skips it).
 */
export const encodeSparseFields = (
  item: Record<string, unknown>,
  sparseFields: Record<string, SparseConfig>,
): void => {
  for (const [fieldName, sparse] of Object.entries(sparseFields)) {
    if (!(fieldName in item)) continue
    const value = item[fieldName]
    if (value === undefined || value === null) {
      delete item[fieldName]
      continue
    }
    if (typeof value !== "object") {
      throw new Error(`Sparse map "${fieldName}": expected an object/record, got ${typeof value}`)
    }
    const record = value as Record<string, unknown>
    for (const [k, v] of Object.entries(record)) {
      validateSparseKey(fieldName, sparse.prefix, k)
      item[`${sparse.prefix}#${k}`] = v
    }
    delete item[fieldName]
  }
}

/**
 * Rebuild sparse-map fields on a raw item after unmarshalling.
 *
 * For each `(fieldName, { prefix })` in `sparseFields`:
 *  - Walk top-level keys, collect any matching `<prefix>#<key>`,
 *    extract the key portion, and accumulate into `out[fieldName][key]`.
 *  - Delete the flattened attributes from the raw item.
 *  - If no matching attributes are found, the result is `{}` — sparse fields
 *    on the domain side are required (a `Schema.Record` always decodes to an
 *    object, never `undefined`).
 *
 * Mutates `raw` in place.
 */
export const decodeSparseFields = (
  raw: Record<string, unknown>,
  sparseFields: Record<string, SparseConfig>,
): void => {
  if (Object.keys(sparseFields).length === 0) return
  // Build a list of (fieldName, prefix, prefixWithDelim) once so we don't
  // re-concatenate per attribute.
  const entries: Array<[string, string, string]> = []
  for (const [fieldName, sparse] of Object.entries(sparseFields)) {
    entries.push([fieldName, sparse.prefix, `${sparse.prefix}#`])
  }
  // Sort by prefix length descending so a longer prefix wins over a shorter
  // prefix that happens to be its own substring (e.g. `metric` vs `metrics`).
  entries.sort((a, b) => b[2].length - a[2].length)

  // Initialize empty buckets for each sparse field.
  const buckets: Record<string, Record<string, unknown>> = {}
  for (const [fieldName] of entries) buckets[fieldName] = {}

  // One pass over keys.
  const keys = Object.keys(raw)
  for (const k of keys) {
    for (const [fieldName, , prefixWithDelim] of entries) {
      if (k.startsWith(prefixWithDelim)) {
        const subKey = k.substring(prefixWithDelim.length)
        // Skip empty sub-keys (defensive — would mean the stored attr was
        // literally `<prefix>#`, which validation rejects on write).
        if (subKey.length === 0) break
        buckets[fieldName]![subKey] = raw[k]
        delete raw[k]
        break
      }
    }
  }

  for (const [fieldName] of entries) {
    raw[fieldName] = buckets[fieldName]!
  }
}
