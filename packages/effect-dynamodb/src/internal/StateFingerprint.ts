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
 * - an object's prototype and its own enumerable string-keyed properties. An
 *   accessor is recorded by its getter, never called. Symbol-keyed and
 *   non-enumerable properties, where Effect keeps its caches (`DateTime`'s
 *   parts, a hash), are not read;
 * - arrays by index, and `Map`, `Set`, `HashMap`, `HashSet` and `Chunk` by
 *   iteration. A `Chunk` caches its array form in an own field, so its fields
 *   are not read;
 * - `Date`, `DateTime` and `BigDecimal` by value (a `BigDecimal` caches its
 *   normal form in an own field), typed arrays and `ArrayBuffer`s by their
 *   bytes, `Option` and `Result` by tag and contents;
 * - functions and symbols by identity. A reference back to an object on the
 *   current path is recorded as a cycle and not walked again.
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
  walk(value, "", [], entries)
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

/** A primitive as it reads in a message or a path. */
const primitiveLabel = (value: unknown): string => {
  switch (typeof value) {
    case "string":
      return JSON.stringify(truncate(value))
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

const walk = (value: unknown, path: string, ancestors: Array<object>, out: Array<Entry>): void => {
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
  const depth = ancestors.indexOf(value)
  if (depth >= 0) {
    out.push({ path, kind: "cycle", identity: undefined, detail: String(depth) })
    return
  }
  ancestors.push(value)
  try {
    walkObject(value, path, ancestors, out)
  } finally {
    ancestors.pop()
  }
}

const walkIterable = (
  items: Iterable<unknown>,
  path: string,
  ancestors: Array<object>,
  out: Array<Entry>,
): void => {
  let i = 0
  for (const item of items) {
    walk(item, `${path}[${i}]`, ancestors, out)
    i++
  }
}

const walkEntries = (
  entries: Iterable<readonly [unknown, unknown]>,
  path: string,
  ancestors: Array<object>,
  out: Array<Entry>,
): void => {
  let i = 0
  for (const [key, member] of entries) {
    if (isPrimitive(key)) {
      walk(member, child(path, `.get(${primitiveLabel(key)})`), ancestors, out)
    } else {
      walk(key, child(path, `.keys()[${i}]`), ancestors, out)
      walk(member, child(path, `.values()[${i}]`), ancestors, out)
    }
    i++
  }
}

const walkObject = (
  value: object,
  path: string,
  ancestors: Array<object>,
  out: Array<Entry>,
): void => {
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
    out.push({ path, kind: "BigDecimal", identity: undefined, detail: BigDecimal.format(value) })
    return
  }
  if (Option.isOption(value)) {
    out.push({ path, kind: "Option", identity: undefined, detail: value._tag })
    if (Option.isSome(value)) walk(value.value, child(path, ".value"), ancestors, out)
    return
  }
  if (Result.isResult(value)) {
    out.push({ path, kind: "Result", identity: undefined, detail: value._tag })
    if (Result.isSuccess(value)) walk(value.success, child(path, ".success"), ancestors, out)
    else walk(value.failure, child(path, ".failure"), ancestors, out)
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
  if (Array.isArray(value)) {
    out.push({
      path,
      kind: "Array",
      identity: Object.getPrototypeOf(value),
      detail: `length ${value.length}`,
    })
    for (let i = 0; i < value.length; i++) walk(value[i], `${path}[${i}]`, ancestors, out)
    return
  }
  if (value instanceof Map) {
    out.push({
      path,
      kind: "Map",
      identity: Object.getPrototypeOf(value),
      detail: `size ${value.size}`,
    })
    walkEntries(value, path, ancestors, out)
    return
  }
  if (HashMap.isHashMap(value)) {
    out.push({ path, kind: "HashMap", identity: undefined, detail: `size ${HashMap.size(value)}` })
    walkEntries(value as Iterable<readonly [unknown, unknown]>, path, ancestors, out)
    return
  }
  if (value instanceof Set) {
    out.push({
      path,
      kind: "Set",
      identity: Object.getPrototypeOf(value),
      detail: `size ${value.size}`,
    })
    walkIterable(value, path, ancestors, out)
    return
  }
  if (HashSet.isHashSet(value)) {
    out.push({ path, kind: "HashSet", identity: undefined, detail: `size ${HashSet.size(value)}` })
    walkIterable(value as Iterable<unknown>, path, ancestors, out)
    return
  }
  if (Chunk.isChunk(value)) {
    out.push({ path, kind: "Chunk", identity: undefined, detail: `length ${Chunk.size(value)}` })
    walkIterable(value as Iterable<unknown>, path, ancestors, out)
    return
  }
  const keys = Object.keys(value)
  out.push({
    path,
    kind: "object",
    identity: Object.getPrototypeOf(value),
    detail: JSON.stringify(keys),
  })
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    const at = propertyPath(path, key)
    if (descriptor === undefined) {
      // Gone between `Object.keys` and here (a proxy): nothing to read.
      out.push({ path: at, kind: "absent", identity: undefined, detail: "" })
    } else if ("value" in descriptor) {
      walk(descriptor.value, at, ancestors, out)
    } else {
      out.push({ path: at, kind: "accessor", identity: descriptor.get, detail: "" })
    }
  }
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
    case "cycle":
      return "a reference back to an enclosing object"
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
