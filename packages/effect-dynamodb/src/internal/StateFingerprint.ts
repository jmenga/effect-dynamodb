/**
 * @internal A structural fingerprint of a value, for `commandHandler`'s
 * opt-in `checkStateUse` (#290). It is taken of a state before `decide` runs
 * and again after, so a change made to the object `decide` was given is found
 * and named by its path.
 *
 * A fingerprint is a pre-order list of entries, one per value reached. Each
 * entry holds its path, its kind, an identity compared with `Object.is`, and a
 * detail string. Two fingerprints of an unchanged value are equal entry for
 * entry, and the first entry that differs is the first change met in walk
 * order: a container's own entry (its keys, length or size) comes before its
 * contents, so an added or removed member is reported at the container.
 *
 * What is read:
 * - an object's prototype and its own enumerable string-keyed properties, and
 *   an array's elements, by their property descriptors: an accessor is
 *   recorded by its getter, never called. Symbol-keyed and non-enumerable
 *   properties, where Effect keeps its caches (`DateTime`'s parts, a hash),
 *   are not read;
 * - `Map`, `Set`, `HashMap` and `HashSet` by iteration, and `Chunk` by index
 *   (`Chunk.getUnsafe`, which does not build the array form a `Chunk` caches
 *   in an own field), so its fields are not read;
 * - `Date`, `DateTime` and `BigDecimal` by value (a `BigDecimal` from its
 *   digits and scale, without the normal form it caches in an own field),
 *   typed arrays and `ArrayBuffer`s by their bytes, `Option` and `Result` by
 *   tag and contents;
 * - functions and symbols by identity.
 *
 * Nothing is written, so a frozen value reads as any other. A container
 * (an array, a `Map` or `Set`, a `HashMap`, `HashSet` or `Chunk`, any other
 * object) reached a second time, through a cycle or a second path to the same
 * object, is recorded by the path it was first reached at and not walked
 * again, so a fingerprint grows with the number of distinct values, not paths.
 * Replacing such a reference with an equal copy is a change.
 */

import { BigDecimal, Chunk, DateTime, HashMap, HashSet, Option, Result } from "effect"

/** @internal One value reached by the walk. */
export interface Entry {
  readonly path: string
  readonly kind: string
  /** Compared with `Object.is`: a primitive itself, a prototype, a function. */
  readonly identity: unknown
  readonly detail: string
}

/** @internal */
export type Fingerprint = ReadonlyArray<Entry>

/** @internal The first change between two fingerprints of one value. */
export interface Difference {
  /** `""` for the value itself. */
  readonly path: string
  readonly before: string
  readonly after: string
}

/** @internal Take the fingerprint of `value`. */
export const of = (value: unknown): Fingerprint => {
  const entries: Array<Entry> = []
  walk(value, "", new Map(), entries)
  return entries
}

/** @internal The first entry at which `after` differs from `before`, if any. */
export const firstDifference = (
  before: Fingerprint,
  after: Fingerprint,
): Difference | undefined => {
  const length = Math.max(before.length, after.length)
  for (let i = 0; i < length; i++) {
    const was = before[i]
    const now = after[i]
    if (
      was === undefined ||
      now === undefined ||
      was.path !== now.path ||
      was.kind !== now.kind ||
      !Object.is(was.identity, now.identity) ||
      was.detail !== now.detail
    ) {
      return {
        path: (was ?? now)?.path ?? "",
        before: describe(was),
        after: describe(now),
      }
    }
  }
  return undefined
}

/** @internal `innings[1].overs`, or `the state itself` for the root. */
export const formatPath = (path: string): string => (path === "" ? "the state itself" : path)

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/

const child = (path: string, suffix: string): string =>
  path === "" && suffix.startsWith(".") ? suffix.slice(1) : `${path}${suffix}`

const propertyPath = (path: string, key: string): string =>
  IDENTIFIER.test(key) ? child(path, `.${key}`) : `${path}[${JSON.stringify(key)}]`

const isPrimitive = (value: unknown): boolean =>
  value === null || (typeof value !== "object" && typeof value !== "function")

const MAX_TEXT = 40

const truncate = (text: string): string =>
  text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text

/** A primitive as it reads in a message. */
const primitiveLabel = (value: unknown): string =>
  typeof value === "string" ? JSON.stringify(truncate(value)) : keyLabel(value)

/** A primitive in full, as a path names a `Map` key. */
const keyLabel = (value: unknown): string => {
  switch (typeof value) {
    case "string":
      return JSON.stringify(value)
    case "bigint":
      return `${value}n`
    case "symbol":
      return value.toString()
    default:
      return String(value)
  }
}

const hex = (bytes: Uint8Array): string => {
  let text = ""
  for (const byte of bytes) text += byte.toString(16).padStart(2, "0")
  return text
}

/** The decimal text of a `BigDecimal`, read from its fields without normalising it. */
const decimalText = (value: BigDecimal.BigDecimal): string => {
  let digits = value.value
  let scale = value.scale
  if (digits === 0n) return "0"
  while (digits % 10n === 0n) {
    digits /= 10n
    scale--
  }
  if (scale <= 0) return scale === 0 ? `${digits}` : `${digits}e${-scale}`
  const negative = digits < 0n
  const text = (negative ? -digits : digits).toString().padStart(scale + 1, "0")
  return `${negative ? "-" : ""}${text.slice(0, -scale)}.${text.slice(-scale)}`
}

/** Paths at which each container was first reached. */
type Seen = Map<object, string>

const walk = (value: unknown, path: string, seen: Seen, out: Array<Entry>): void => {
  if (value === null) {
    out.push({ path, kind: "null", identity: null, detail: "" })
    return
  }
  if (typeof value === "function") {
    out.push({ path, kind: "function", identity: value, detail: "" })
    return
  }
  if (typeof value !== "object") {
    out.push({ path, kind: typeof value, identity: value, detail: "" })
    return
  }
  walkObject(value, path, seen, out)
}

/** A property or an element, by its descriptor: an accessor is never called. */
const walkProperty = (
  owner: object,
  key: string,
  at: string,
  seen: Seen,
  out: Array<Entry>,
): void => {
  const descriptor = Object.getOwnPropertyDescriptor(owner, key)
  if (descriptor === undefined) {
    // An array hole, or gone between `Object.keys` and here (a proxy).
    out.push({ path: at, kind: "absent", identity: undefined, detail: "" })
  } else if ("value" in descriptor) {
    walk(descriptor.value, at, seen, out)
  } else {
    out.push({ path: at, kind: "accessor", identity: descriptor.get, detail: "" })
  }
}

const walkIterable = (
  items: Iterable<unknown>,
  path: string,
  seen: Seen,
  out: Array<Entry>,
): void => {
  let i = 0
  for (const item of items) {
    walk(item, `${path}[${i}]`, seen, out)
    i++
  }
}

const walkEntries = (
  entries: Iterable<readonly [unknown, unknown]>,
  path: string,
  seen: Seen,
  out: Array<Entry>,
): void => {
  let i = 0
  for (const [key, member] of entries) {
    if (isPrimitive(key) && typeof key !== "symbol") {
      walk(member, child(path, `.get(${keyLabel(key)})`), seen, out)
    } else {
      walk(key, child(path, `.keys()[${i}]`), seen, out)
      walk(member, child(path, `.values()[${i}]`), seen, out)
    }
    i++
  }
}

const walkObject = (value: object, path: string, seen: Seen, out: Array<Entry>): void => {
  if (value instanceof Date) {
    const time = value.getTime()
    const detail = Number.isNaN(time) ? "Invalid Date" : new Date(time).toISOString()
    out.push({ path, kind: "Date", identity: undefined, detail })
    return
  }
  if (DateTime.isDateTime(value)) {
    const zone = DateTime.isZoned(value) ? ` ${DateTime.zoneToString(value.zone)}` : ""
    out.push({
      path,
      kind: "DateTime",
      identity: undefined,
      detail: `${DateTime.formatIso(value)}${zone}`,
    })
    return
  }
  if (BigDecimal.isBigDecimal(value)) {
    out.push({ path, kind: "BigDecimal", identity: undefined, detail: decimalText(value) })
    return
  }
  if (Option.isOption(value)) {
    out.push({ path, kind: "Option", identity: undefined, detail: value._tag })
    if (Option.isSome(value)) walk(value.value, child(path, ".value"), seen, out)
    return
  }
  if (Result.isResult(value)) {
    out.push({ path, kind: "Result", identity: undefined, detail: value._tag })
    if (Result.isSuccess(value)) walk(value.success, child(path, ".success"), seen, out)
    else walk(value.failure, child(path, ".failure"), seen, out)
    return
  }
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    const bytes = ArrayBuffer.isView(value)
      ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
      : new Uint8Array(value)
    out.push({
      path,
      kind: value.constructor?.name ?? "bytes",
      identity: undefined,
      detail: hex(bytes),
    })
    return
  }
  // A container: walked once, however many paths reach it.
  const first = seen.get(value)
  if (first !== undefined) {
    out.push({ path, kind: "seen", identity: undefined, detail: first })
    return
  }
  seen.set(value, path)
  if (Array.isArray(value)) {
    out.push({
      path,
      kind: "Array",
      identity: Object.getPrototypeOf(value),
      detail: `length ${value.length}`,
    })
    for (let i = 0; i < value.length; i++)
      walkProperty(value, String(i), `${path}[${i}]`, seen, out)
    return
  }
  if (value instanceof Map) {
    out.push({
      path,
      kind: "Map",
      identity: Object.getPrototypeOf(value),
      detail: `size ${value.size}`,
    })
    walkEntries(value, path, seen, out)
    return
  }
  if (HashMap.isHashMap(value)) {
    out.push({ path, kind: "HashMap", identity: undefined, detail: `size ${HashMap.size(value)}` })
    walkEntries(value as Iterable<readonly [unknown, unknown]>, path, seen, out)
    return
  }
  if (value instanceof Set) {
    out.push({
      path,
      kind: "Set",
      identity: Object.getPrototypeOf(value),
      detail: `size ${value.size}`,
    })
    walkIterable(value, path, seen, out)
    return
  }
  if (HashSet.isHashSet(value)) {
    out.push({ path, kind: "HashSet", identity: undefined, detail: `size ${HashSet.size(value)}` })
    walkIterable(value as Iterable<unknown>, path, seen, out)
    return
  }
  if (Chunk.isChunk(value)) {
    const length = Chunk.size(value)
    out.push({ path, kind: "Chunk", identity: undefined, detail: `length ${length}` })
    for (let i = 0; i < length; i++) walk(Chunk.getUnsafe(value, i), `${path}[${i}]`, seen, out)
    return
  }
  const keys = Object.keys(value)
  out.push({
    path,
    kind: "object",
    identity: Object.getPrototypeOf(value),
    detail: JSON.stringify(keys),
  })
  for (const key of keys) walkProperty(value, key, propertyPath(path, key), seen, out)
}

// ---------------------------------------------------------------------------
// Describing an entry in a message
// ---------------------------------------------------------------------------

const constructorName = (prototype: unknown): string | undefined => {
  if (prototype === null) return "null-prototype object"
  const name = (prototype as { readonly constructor?: { readonly name?: unknown } } | undefined)
    ?.constructor?.name
  return typeof name === "string" && name !== "" && name !== "Object" ? name : undefined
}

const describe = (entry: Entry | undefined): string => {
  if (entry === undefined) return "absent"
  switch (entry.kind) {
    case "null":
      return "null"
    case "undefined":
    case "boolean":
    case "number":
    case "string":
    case "bigint":
    case "symbol":
      return primitiveLabel(entry.identity)
    case "function": {
      const name = (entry.identity as { readonly name?: unknown }).name
      return typeof name === "string" && name !== "" ? `function ${name}` : "a function"
    }
    case "seen":
      return entry.detail === ""
        ? "a reference to the state itself"
        : `the same object as at ${truncate(entry.detail)}`
    case "accessor":
      return "an accessor property"
    case "absent":
      return "absent"
    case "object": {
      const keys = JSON.parse(entry.detail) as ReadonlyArray<string>
      const name = constructorName(entry.identity)
      return truncate(`${name === undefined ? "" : `${name} `}{ ${keys.join(", ")} }`)
    }
    case "Array":
    case "Map":
    case "Set":
    case "HashMap":
    case "HashSet":
    case "Chunk":
      return `${entry.kind} of ${entry.detail}`
    case "Option":
    case "Result":
      return `${entry.kind}.${entry.detail}`
    case "Date":
    case "DateTime":
    case "BigDecimal":
      return `${entry.kind}(${truncate(entry.detail)})`
    default:
      // Typed arrays and ArrayBuffers: the kind is the constructor's name.
      return `${entry.kind} of ${entry.detail.length / 2} bytes`
  }
}
