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
import {
  type LostAt,
  lostPath,
  lostRefusal,
  readJudged,
} from "@effect-dynamodb/schema/internal/LostValues.js"
import { PROTO_ENTRY, setOwn } from "@effect-dynamodb/schema/internal/OwnNames.js"
import { sparseReader, validateSparseKey } from "@effect-dynamodb/schema/internal/SparseKey.js"
import {
  COOKIE_MARKER,
  COOKIE_PROTO,
  cachesCycle,
  isBigDecimalInstance,
  isCachedNormal,
  ZONE_MARKER,
  zoneEntriesWritten,
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
 * A value DynamoDB can't store, and where it is (`EDD-9124`), or a map entry keyed `__proto__`
 * (`EDD-9165`). Marshalling throws this, as key composition throws `KeyValueError`; what reaches
 * it is the caller's value, so a write path turns it into a `ValidationError` (`marshalOrFail`).
 */
export class UnstorableValue extends Data.TaggedError("UnstorableValue")<{
  readonly path: ReadonlyArray<string | number>
  readonly reason: string
  /**
   * What of the value at `path` DynamoDB doesn't store, when that's why (`EDD-9161`): a getter at a
   * position no schema types returned it as the marshaller called it (`readJudged`).
   */
  readonly lost?: LostAt
  /** The diagnostic code: `EDD-9124` when absent. */
  readonly code?: "EDD-9165" | undefined
}> {
  override get message(): string {
    return this.describe()
  }

  /** The refusal in words, naming a stored attribute by what `fieldOf` makes of it. */
  describe(fieldOf?: (attribute: string) => string): string {
    if (this.lost !== undefined) {
      const [attribute, ...within] = this.path
      const root =
        attribute === undefined
          ? "value"
          : fieldOf === undefined
            ? String(attribute)
            : fieldOf(String(attribute))
      return lostRefusal(lostPath(root, within), this.lost)
    }
    const refused =
      this.path.length === 0 ? this.reason : `"${renderPath(this.path, fieldOf)}": ${this.reason}`
    return `${refused.endsWith(".") ? refused : `${refused}.`} [${this.code ?? "EDD-9124"}]`
  }

  /** The same refusal at another path. */
  at(path: ReadonlyArray<string | number>): UnstorableValue {
    return new UnstorableValue({
      path,
      reason: this.reason,
      ...(this.code === undefined ? {} : { code: this.code }),
      ...(this.lost === undefined ? {} : { lost: { ...this.lost, path } }),
    })
  }

  /**
   * The refusal as a write reports it, `outcome` (what wasn't done) after it; a lost value's refusal
   * says that itself.
   */
  refusal(outcome: string, fieldOf?: (attribute: string) => string): string {
    if (this.lost === undefined) return `${this.describe(fieldOf)} ${outcome}`
    const refused = this.describe(fieldOf)
    return `${refused[0]!.toUpperCase()}${refused.slice(1)}`
  }
}

/** A lost value a getter returned, where it's stored: thrown out of the marshaller. */
const refuseLost = (lost: LostAt): never => {
  throw new UnstorableValue({
    path: lost.path,
    reason: lostRefusal(lostPath("value", lost.path), lost),
    lost,
  })
}

/**
 * The item as the marshaller is to read it: where it holds a part `lostIn` marked, a getter it didn't
 * call, a view (`readJudged`) that judges what each such getter returns as the marshaller calls it.
 * Nothing of the item is read to find out, and the item itself when it holds none, so an item
 * without one is marshalled exactly as it always was.
 */
const judgedAsRead = (item: Record<string, unknown>): Record<string, unknown> =>
  readJudged(item, [], refuseLost) as Record<string, unknown>

/**
 * The refusal of an attribute or a map entry named `__proto__` at `path`, the name last: the
 * attribute's own name where the path is just that.
 */
export const protoEntryAt = (path: ReadonlyArray<string | number>): UnstorableValue =>
  new UnstorableValue({ path, reason: PROTO_ENTRY, code: "EDD-9165" })

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

/**
 * A list's elements with their indices, as marshalling walks them: a hole isn't there to walk (it
 * stores the list closed up), so it has no entry, in a sparse, frozen or exotic list alike.
 */
const listEntries = (list: ReadonlyArray<unknown>): ReadonlyArray<readonly [number, unknown]> =>
  list.flatMap((element, index) => [[index, element] as const])

/** {@link dataValuesOf}, with each value's name. */
const dataEntriesOf = (value: object): ReadonlyArray<readonly [string, unknown]> => {
  const entries: Array<readonly [string, unknown]> = []
  const named = new Set<string>()
  for (let at: object | null = value; at !== null; at = Object.getPrototypeOf(at)) {
    const descriptors = Object.getOwnPropertyDescriptors(at)
    for (const key of Object.keys(descriptors)) {
      if (named.has(key)) continue
      named.add(key)
      const descriptor = descriptors[key]!
      if (descriptor.enumerable && "value" in descriptor) entries.push([key, descriptor.value])
    }
  }
  return entries
}

/**
 * The path to the first part of a value that holds a value it's inside, depth first as marshalling
 * walks it, or `undefined`. Marshalling follows such a part until the stack runs out, as it does an
 * Effect `Chunk`, whose empty end holds itself. Only looked for once marshalling has refused the
 * value, and read from data descriptors, so no getter is called.
 */
const cycleIn = (
  value: unknown,
  path: ReadonlyArray<string | number> = [],
  open = new Set<object>(),
): ReadonlyArray<string | number> | undefined => {
  if (typeof value !== "object" || value === null || isOpaque(value)) return undefined
  if (open.has(value)) return path
  open.add(value)
  try {
    const parts: ReadonlyArray<readonly [string | number, unknown]> = Array.isArray(value)
      ? listEntries(value)
      : value instanceof Map
        ? [...value].map(([key, entry]) => [String(key), entry] as const)
        : dataEntriesOf(value)
    for (const [key, part] of parts) {
      const found = cycleIn(part, [...path, key], open)
      if (found !== undefined) return found
    }
    return undefined
  } finally {
    open.delete(value)
  }
}

const HOLDS_ITSELF =
  "it holds a value it's inside, so it has no end to store (an Effect Chunk is one: store " +
  "Chunk.toReadonlyArray of it)."

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
 * Gives each of Effect's cookies in `source` its expiry, and each named zone's map its name, in what
 * marshalling made of them.
 *
 * A cookie's `options.expires` is a `Date`, and marshalling stores a `Date` as an empty map: the
 * expiry was lost. Here it's ISO text instead: this finds the cookie it came from by descriptors,
 * calling no getter. A cookie is Effect's own, by its prototype; a map that only looks like one, one
 * behind a getter and an invalid `Date` are left as marshalled.
 *
 * A named zone's map holding `resolvedId`, which Effect 4.1.3 gave a zone, is stored as 4.1.2 held
 * it, under the name `zoneEntriesWritten` gives it and without `resolvedId`: what 1.40.0 stored on
 * 4.1.2, whichever Effect is installed, however the zone was reached. That's decided on the map
 * marshalling made, from the values it obtained, so it holds for a zone made fresh or read back, as
 * an own property, behind a getter or inside anything.
 *
 * Marshalling has already run, exactly as it always did, and nothing else it made is touched.
 *
 * The same walk refuses a map marshalling assigned an entry keyed `__proto__` to: that set the
 * map's prototype, so the entry would not be sent ({@link protoEntryAt}, `EDD-9165`). Given
 * `dropped`, it tells `dropped` instead and goes on, leaving the map as marshalled.
 */
const finishingInstances = (
  marshalled: Record<string, AttributeValue>,
  source: unknown,
  dropped?: (refusal: UnstorableValue) => void,
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
  const name = (map: Record<string, AttributeValue>): void => {
    if (!Object.hasOwn(map, "resolvedId")) return
    const entries = Object.entries(map)
    const written = zoneEntriesWritten(
      entries,
      true,
      (attribute) => attribute.S,
      (id): AttributeValue => ({ S: id }),
    )
    if (written === entries) return
    map.id = { S: written.find(([key]) => key === "id")![1].S! }
    delete map.resolvedId
  }
  const visit = (attribute: AttributeValue): void => {
    const map = attribute.M
    if (map !== undefined) {
      // Marshalling assigned an entry keyed `__proto__`: it is this map's prototype, not stored.
      if (Object.getPrototypeOf(map) !== Object.prototype) {
        const refusal = protoEntryAt([...path, "__proto__"])
        if (dropped === undefined) throw refusal
        dropped(refusal)
      }
      if (Object.hasOwn(map, COOKIE_MARKER)) date(map)
      if (Object.hasOwn(map, ZONE_MARKER)) name(map)
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

/** Whether marshalling refuses a value. A lost value a getter returned is refused as itself. */
const isRefused = (value: unknown): boolean => {
  try {
    marshall({ v: value }, MARSHALL_OPTIONS)
    return false
  } catch (error) {
    if (isUnstorableValue(error)) throw error
    return true
  }
}

const partsOf = (value: unknown): ReadonlyArray<readonly [string | number, unknown]> => {
  if (Array.isArray(value)) return listEntries(value)
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
 * {@link UnstorableValue}, as does a value holding one it's inside ({@link cycleIn}), which
 * marshalling follows until the stack runs out. What marshalling makes of a cookie is then given the
 * cookie's expiry, and what it makes of a named zone the zone's name ({@link finishingInstances}),
 * and a map entry keyed `__proto__`, which marshalling drops, is refused (`EDD-9165`).
 */
const marshallStorable = (
  given: Record<string, unknown>,
  dropped?: (refusal: UnstorableValue) => void,
): Record<string, AttributeValue> => {
  const item = judgedAsRead(given)
  let written: Record<string, unknown> = item
  let marshalled: Record<string, AttributeValue>
  try {
    marshalled = marshall(item, MARSHALL_OPTIONS)
  } catch (error) {
    // A lost value a getter returned: refused as it is, without reading anything again.
    if (isUnstorableValue(error)) throw error
    const fresh = holdsCachedCycle(item) ? withoutCachedNormals(item) : item
    // Followed further, a value holding itself would run the stack out here too.
    const cycle = cycleIn(fresh)
    if (cycle !== undefined) throw new UnstorableValue({ path: cycle, reason: HOLDS_ITSELF })
    written = withoutEmptySets(fresh) as Record<string, unknown>
    try {
      marshalled = marshall(written, MARSHALL_OPTIONS)
    } catch (cause) {
      if (isUnstorableValue(cause)) throw cause
      throw unstorableAt(written, [], cause instanceof Error ? cause.message : String(cause))
    }
  }
  return finishingInstances(marshalled, written, dropped)
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

/**
 * Whether `map`, or a map or a list within it at any depth, holds an entry named `__proto__`. Read
 * on every row, so written for speed: its own keys by `Object.keys` (an entry so named is an own
 * enumerable one, as a response's JSON gives it), and indexed loops. A row holding none is walked
 * once and handed to the unmarshaller as it is.
 */
const holdsProtoEntry = (map: Record<string, AttributeValue>): boolean => {
  const keys = Object.keys(map)
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index]!
    if (key === "__proto__") return true
    const value = map[key]
    if (value == null) continue
    const nested = value.M
    if (nested !== undefined) {
      if (holdsProtoEntry(nested)) return true
    } else {
      const list = value.L
      if (list !== undefined && listHoldsProtoEntry(list)) return true
    }
  }
  return false
}

const listHoldsProtoEntry = (list: ReadonlyArray<AttributeValue>): boolean => {
  for (let index = 0; index < list.length; index++) {
    const value = list[index]
    if (value == null) continue
    const nested = value.M
    if (nested !== undefined) {
      if (holdsProtoEntry(nested)) return true
    } else {
      const inner = value.L
      if (inner !== undefined && listHoldsProtoEntry(inner)) return true
    }
  }
  return false
}

/** `map` without the entries named `__proto__` it, and every map within it, holds. */
const withoutProtoEntries = (
  map: Record<string, AttributeValue>,
): Record<string, AttributeValue> => {
  const kept: Record<string, AttributeValue> = {}
  const keys = Object.keys(map)
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index]!
    if (key !== "__proto__") kept[key] = withoutProtoEntry(map[key]!)
  }
  return kept
}

const withoutProtoEntry = (value: AttributeValue): AttributeValue =>
  value == null
    ? value
    : value.M !== undefined
      ? { M: withoutProtoEntries(value.M) }
      : value.L !== undefined
        ? { L: value.L.map((element) => withoutProtoEntry(element)) }
        : value

/**
 * `item` for the AWS SDK's unmarshaller, which assigns each attribute and map entry to a plain
 * object: one named `__proto__` would set that object's prototype instead, so a map stored there
 * (by another writer: the library refuses to write one, `EDD-9165`) would give the object every
 * entry of that map as an inherited property, read as its own fields. Such an entry is left out,
 * whatever it holds. `item` itself where it holds none.
 */
const readable = (item: Record<string, AttributeValue>): Record<string, AttributeValue> =>
  holdsProtoEntry(item) ? withoutProtoEntries(item) : item

/**
 * Unmarshall a DynamoDB attribute map to a JS object. An attribute or a map entry named
 * `__proto__` is not read (`EDD-9165`).
 */
export const fromAttributeMap = (item: Record<string, AttributeValue>): Record<string, unknown> =>
  unmarshall(readable(item))

/**
 * Marshall a single value to a DynamoDB attribute value. An empty set directly
 * here is refused, as marshalling refuses it: a caller holding a value to send has
 * no attribute to leave out, and has to decide what no value means. A refusal names
 * the value's `name`, when it has one.
 *
 * Given `dropped`, a map entry keyed `__proto__` (`EDD-9165`) is not refused here: the value is
 * marshalled as 1.40.0 marshalled it, without that entry, and `dropped` is told where it was.
 * `Expression`'s builders use it, so that what they return is refused where it is sent.
 */
export const toAttributeValue = (
  value: unknown,
  name?: string,
  dropped?: (refusal: UnstorableValue) => void,
): AttributeValue => {
  const at = name === undefined ? [] : [name]
  if (isEmptySet(value))
    throw new UnstorableValue({ path: at, reason: "DynamoDB has no empty set." })
  try {
    return marshallStorable(
      { v: value },
      dropped === undefined
        ? undefined
        : (refusal) => dropped(refusal.at([...at, ...refusal.path.slice(1)])),
    ).v!
  } catch (error) {
    if (!isUnstorableValue(error)) throw error
    throw error.at([...at, ...error.path.slice(1)])
  }
}

/**
 * Unmarshall a single DynamoDB attribute value. A map entry named `__proto__` within it is not
 * read (`EDD-9165`).
 */
export const fromAttributeValue = (value: AttributeValue): unknown =>
  unmarshall(readable({ v: value })).v

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
    if (!Object.hasOwn(item, fieldName)) continue
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
    setOwn(raw, fieldName, buckets.get(fieldName)!)
  }
}
