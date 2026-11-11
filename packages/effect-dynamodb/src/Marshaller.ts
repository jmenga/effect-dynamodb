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
import { sparseReader, validateSparseKey } from "@effect-dynamodb/schema/internal/SparseKey.js"
import {
  COOKIE_MARKER,
  COOKIE_PROTO,
  cachesCycle,
  isBigDecimalInstance,
  isCachedNormal,
} from "@effect-dynamodb/schema/internal/StoredForm.js"
import { Data } from "effect"

export { isCachedNormal }

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

/** Values marshalling stores whole, which hold no `BigDecimal` to swap. */
const isOpaque = (value: object): boolean =>
  value instanceof Set ||
  value instanceof Date ||
  ArrayBuffer.isView(value) ||
  value instanceof ArrayBuffer

/**
 * The enumerable data properties marshalling walks on an object, its prototypes' included, read
 * from their descriptors. A getter is never called, so what's behind one isn't seen.
 */
const dataValuesOf = (value: object): ReadonlyArray<unknown> => {
  const values: Array<unknown> = []
  const named = new Set<string>()
  for (let at: object | null = value; at !== null; at = Object.getPrototypeOf(at)) {
    const descriptors = Object.getOwnPropertyDescriptors(at)
    for (const key of Object.keys(descriptors)) {
      if (named.has(key)) continue
      named.add(key)
      const descriptor = descriptors[key]!
      if (descriptor.enumerable && "value" in descriptor) values.push(descriptor.value)
    }
  }
  return values
}

/**
 * Whether a value holds a `BigDecimal` whose cached `normalized` form leads into a cycle, anywhere
 * marshalling would reach it through data. Only looked for once marshalling has refused the value,
 * and without calling a getter, so a value holding none is then handled exactly as it always was:
 * the same getter calls, the same bytes.
 */
const holdsCachedCycle = (value: unknown, seen = new Set<object>()): boolean => {
  if (typeof value !== "object" || value === null || isOpaque(value) || seen.has(value)) {
    return false
  }
  seen.add(value)
  if (isBigDecimalInstance(value) && cachesCycle(value)) return true
  const parts = value instanceof Map ? [...value.values()] : dataValuesOf(value)
  return parts.some((part) => holdsCachedCycle(part, seen))
}

/**
 * The value with each `BigDecimal` whose cached `normalized` form leads into a cycle written
 * without that cache: on its own prototype, with every other enumerable property it has, in order.
 * A decimal nothing has cached on marshals to exactly that, so the stored bytes are a fresh
 * decimal's. The same reference when the value holds no such decimal.
 *
 * `Equal.equals`, `Hash.hash` and `BigDecimal.normalize` cache the normalized decimal on the one
 * they're given, and that decimal holds itself, so marshalling recursed until the stack ran out.
 */
const withoutCachedNormals = (value: unknown, open = new Set<object>()): unknown => {
  if (typeof value !== "object" || value === null || isOpaque(value) || open.has(value)) {
    return value
  }
  open.add(value)
  try {
    if (isBigDecimalInstance(value) && cachesCycle(value)) {
      const written = Object.create(Object.getPrototypeOf(value))
      for (const key of Object.keys(value)) {
        if (key === "normalized") continue
        written[key] = withoutCachedNormals(
          (value as unknown as Record<string, unknown>)[key],
          open,
        )
      }
      return written
    }
    if (Array.isArray(value)) {
      const elements = value.map((element) => withoutCachedNormals(element, open))
      return elements.some((element, index) => element !== value[index]) ? elements : value
    }
    if (value instanceof Map) {
      const entries = [...value].map(
        ([key, entry]) => [key, withoutCachedNormals(entry, open)] as const,
      )
      return entries.every(([key, entry]) => entry === value.get(key)) ? value : new Map(entries)
    }
    const entries = propertiesOf(value)
    const next = entries.map(([key, entry]) => [key, withoutCachedNormals(entry, open)] as const)
    return next.every(([, entry], index) => entry === entries[index]![1])
      ? value
      : Object.fromEntries(next)
  } finally {
    open.delete(value)
  }
}

/** A part marshalling reached that this can't reach without running a getter, or at all. */
const UNREACHED = Symbol("unreached")

/**
 * A property as marshalling reads it, own or inherited, but from its descriptor: an accessor is
 * {@link UNREACHED}, since reading it again would call its getter again.
 */
const dataAt = (value: object, key: string): unknown => {
  for (let at: object | null = value; at !== null; at = Object.getPrototypeOf(at)) {
    const descriptor = Object.getOwnPropertyDescriptor(at, key)
    if (descriptor !== undefined) return "value" in descriptor ? descriptor.value : UNREACHED
  }
  return UNREACHED
}

/**
 * The elements marshalling stores of a list, in order: it leaves out `undefined` and functions, so
 * the elements after one move up.
 */
const storedElements = (list: ReadonlyArray<unknown>): ReadonlyArray<unknown> | undefined => {
  const stored: Array<unknown> = []
  for (let index = 0; index < list.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(list, index)
    if (descriptor === undefined) continue
    if (!("value" in descriptor)) return undefined
    const element: unknown = descriptor.value
    if (element !== undefined && typeof element !== "function") stored.push(element)
  }
  return stored
}

/**
 * Gives each of Effect's cookies in `source` its expiry, in what marshalling made of it.
 *
 * A cookie's `options.expires` is a `Date`, and marshalling stores a `Date` as an empty map: the
 * expiry was lost. Here it's ISO text instead. Marshalling has already run, exactly as it always
 * did, and nothing else it made is touched: this only looks through its output for a cookie's
 * marker, and finds the cookie it came from by descriptors, calling no getter. A cookie is Effect's
 * own, by its prototype; a map that only looks like one, a cookie behind a getter and an invalid
 * `Date` are left as marshalled.
 */
const datingCookies = (
  marshalled: Record<string, AttributeValue>,
  source: unknown,
): Record<string, AttributeValue> => {
  const path: Array<string | number> = []
  const lists = new Map<object, ReadonlyArray<unknown> | undefined>()
  const elementsOf = (list: ReadonlyArray<unknown>) => {
    if (!lists.has(list)) lists.set(list, storedElements(list))
    return lists.get(list)
  }
  const sourceAt = (): unknown => {
    let value: unknown = source
    for (const step of path) {
      if (typeof value !== "object" || value === null) return UNREACHED
      if (typeof step === "number") {
        const elements = Array.isArray(value) ? elementsOf(value) : undefined
        if (elements === undefined || step >= elements.length) return UNREACHED
        value = elements[step]
      } else if (value instanceof Map) {
        let found: unknown = UNREACHED
        for (const [key, entry] of value) if (String(key) === step) found = entry
        value = found
      } else {
        value = dataAt(value, step)
      }
    }
    return value
  }
  const date = (map: Record<string, AttributeValue>): void => {
    const options = Object.hasOwn(map, "options") ? map.options!.M : undefined
    const expires =
      options !== undefined && Object.hasOwn(options, "expires") ? options.expires : undefined
    if (expires?.M === undefined || Object.keys(expires.M).length > 0) return
    const cookie = sourceAt()
    if (typeof cookie !== "object" || cookie === null) return
    if (Object.getPrototypeOf(cookie) !== COOKIE_PROTO) return
    const given = dataAt(cookie, "options")
    if (typeof given !== "object" || given === null) return
    const expiry = dataAt(given, "expires")
    if (!(expiry instanceof Date)) return
    if (Number.isNaN(Date.prototype.getTime.call(expiry))) return
    options!.expires = { S: Date.prototype.toISOString.call(expiry) }
  }
  const visit = (attribute: AttributeValue): void => {
    const map = attribute.M
    if (map !== undefined) {
      if (Object.hasOwn(map, COOKIE_MARKER)) date(map)
      for (const key of Object.keys(map)) {
        path.push(key)
        visit(map[key]!)
        path.pop()
      }
      return
    }
    const list = attribute.L
    if (list === undefined) return
    for (let index = 0; index < list.length; index++) {
      path.push(index)
      visit(list[index]!)
      path.pop()
    }
  }
  visit({ M: marshalled })
  return marshalled
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
 * any costs nothing and marshals exactly as it did. A `BigDecimal` something has
 * cached a normalized form on is refused the same way, since the cache holds
 * itself: it's written without that cache before anything else walks the item
 * ({@link withoutCachedNormals}). An item holding no such decimal
 * ({@link holdsCachedCycle}, which calls no getter) goes on exactly as before.
 * Whatever is still refused has no attribute to leave out, and throws
 * {@link UnstorableValue}. What marshalling makes of a cookie is then given the
 * cookie's expiry ({@link datingCookies}).
 */
const marshallStorable = (item: Record<string, unknown>): Record<string, AttributeValue> => {
  let written: Record<string, unknown> = item
  let marshalled: Record<string, AttributeValue>
  try {
    marshalled = marshall(item, MARSHALL_OPTIONS)
  } catch {
    written = withoutEmptySets(
      holdsCachedCycle(item) ? withoutCachedNormals(item) : item,
    ) as Record<string, unknown>
    try {
      marshalled = marshall(written, MARSHALL_OPTIONS)
    } catch (cause) {
      throw unstorableAt(written, [], cause instanceof Error ? cause.message : String(cause))
    }
  }
  return datingCookies(marshalled, written)
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
 * Each attribute the reader takes as a sparse map's entry (`sparseReader`: `<prefix>#` and a
 * non-empty key) moves into `raw[field][key]`. Every sparse field gets a Record, `{}` when no
 * attribute is its entry — sparse fields on the domain side are required (a `Schema.Record`
 * always decodes to an object, never `undefined`).
 *
 * Mutates `raw` in place.
 */
export const decodeSparseFields = (
  raw: Record<string, unknown>,
  sparseFields: Record<string, SparseConfig>,
): void => {
  if (Object.keys(sparseFields).length === 0) return
  const { fields, entryOf } = sparseReader(sparseFields)

  // An empty bucket for each sparse field: a plain object, as the row's other maps are, so
  // whatever reads the row (a vector's source text, a caller's `compose`) meets an ordinary
  // object. An entry's key is whatever follows the prefix in the attribute's name, so an entry
  // is defined as the bucket's own property: `__proto__` is a key like any other, where
  // assigning it dropped the entry.
  const buckets = new Map<string, Record<string, unknown>>()
  for (const fieldName of fields) buckets.set(fieldName, {})

  // One pass over keys.
  for (const k of Object.keys(raw)) {
    const entry = entryOf(k)
    if (entry === undefined) continue
    Object.defineProperty(buckets.get(entry.field)!, entry.key, {
      value: raw[k],
      enumerable: true,
      writable: true,
      configurable: true,
    })
    delete raw[k]
  }

  for (const fieldName of fields) {
    raw[fieldName] = buckets.get(fieldName)!
  }
}
