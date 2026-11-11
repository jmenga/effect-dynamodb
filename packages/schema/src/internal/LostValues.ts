/**
 * @internal What DynamoDB doesn't store of a value at a position no schema types (`Schema.Unknown`,
 * `Schema.Any`), the one decision for a native write and a packed one alike (`EDD-9161`).
 *
 * The marshaller stores an object as the map of its enumerable properties. A value whose meaning is
 * somewhere else is stored as less than it is, and read back as that, with no error anywhere: a
 * `Date` is an empty map and reads back as `{}`. Where a schema declares the field, its encoding
 * stores the value; where none does, nothing can, so the write is refused before anything is sent.
 * {@link lostAs} says what of one value is lost; {@link lostIn} looks through a value for the first
 * such part, as the marshaller walks it. Packed storage asks {@link lostAs} at each part it
 * serialises, so the two refuse the same values with the same words.
 *
 * What's lost: a `Date` (valid or not) and a `RegExp`, stored as an empty map; a `WeakMap`,
 * `WeakSet`, `WeakRef`, `FinalizationRegistry` or `Promise`, whose content isn't in its properties;
 * an `Error` holding a `message` or a `cause` that isn't one of its enumerable properties; Effect's
 * `Redacted`, whose value is held outside it; a `Map` with a key that isn't a string, whose keys are
 * stored as text; and binary data other than a `Uint8Array`, of which a read hands back other bytes
 * or none. A cookie's expiry is the exception to a `Date`: the marshaller writes it as ISO text.
 * `undefined`, a function or a hole in a list isn't one: the list closes up, as it always has, and a
 * caller can rely on that (a documented limit). Everything is read from descriptors, so no getter is
 * called.
 */
import { COOKIE_PROTO, expiryText } from "./StoredForm.js"

/** What a value is, why DynamoDB doesn't store it, and what to store instead. */
export interface Lost {
  readonly what: string
  readonly why: string
  readonly use: string
}

/** A lost part of a value, and where it is in it. */
export interface LostAt extends Lost {
  readonly _tag: "LostAt"
  readonly path: ReadonlyArray<string | number>
}

export const isLostAt = (value: unknown): value is LostAt =>
  typeof value === "object" && value !== null && (value as { _tag?: unknown })._tag === "LostAt"

const REDACTED_MARKER = "~effect/Redacted"

const EMPTY_MAP = "it's written as an empty map, which reads back as {}"

/** Built-ins whose content lives in internal slots, none of it in a property. */
const SLOTTED: ReadonlyArray<readonly [Function, string]> = [
  [WeakMap, "WeakMap"],
  [WeakSet, "WeakSet"],
  [Promise, "Promise"],
  ...(typeof WeakRef === "function" ? [[WeakRef, "WeakRef"] as const] : []),
  ...(typeof FinalizationRegistry === "function"
    ? [[FinalizationRegistry, "FinalizationRegistry"] as const]
    : []),
]

/** Whether a value carries a marker on its prototype, as Effect's instance does (not a stored map). */
const inherits = (value: object, marker: string): boolean => {
  if (Object.hasOwn(value, marker)) return false
  for (let at = Object.getPrototypeOf(value); at !== null; at = Object.getPrototypeOf(at)) {
    if (Object.hasOwn(at, marker)) return true
  }
  return false
}

/** A property's descriptor, own or inherited. */
const descriptorOf = (value: object, key: string): PropertyDescriptor | undefined => {
  for (let at: object | null = value; at !== null; at = Object.getPrototypeOf(at)) {
    const descriptor = Object.getOwnPropertyDescriptor(at, key)
    if (descriptor !== undefined) return descriptor
  }
  return undefined
}

/** Whether an error holds something marshalling leaves out: a message or a cause it doesn't store. */
const errorHolds = (error: Error): "message" | "cause" | undefined => {
  for (const key of ["message", "cause"] as const) {
    const descriptor = descriptorOf(error, key)
    if (descriptor === undefined || descriptor.enumerable === true || !("value" in descriptor)) {
      continue
    }
    const held: unknown = descriptor.value
    if (key === "message" ? typeof held === "string" && held !== "" : held !== undefined) return key
  }
  return undefined
}

const binaryName = (value: object): string => {
  const kind: unknown = descriptorOf(value, "constructor")?.value
  const name = typeof kind === "function" ? kind.name : ""
  return name === "" ? "binary data" : `binary data (${name})`
}

/**
 * What of this value, by itself, DynamoDB doesn't store, or `undefined`. Its parts are judged where
 * they are ({@link lostIn}).
 */
export const lostAs = (value: object): Lost | undefined => {
  if (value instanceof Date) {
    return {
      what: "a Date",
      why: EMPTY_MAP,
      use: "Declare the field, as Schema.Date or Schema.DateTimeUtc, or store its ISO text",
    }
  }
  if (value instanceof RegExp) {
    return { what: "a RegExp", why: EMPTY_MAP, use: "Store its source text" }
  }
  for (const [kind, name] of SLOTTED) {
    if (value instanceof kind) {
      return {
        what: `a ${name}`,
        why: `what it holds isn't in its properties, so ${EMPTY_MAP}`,
        use: "Store what it holds instead",
      }
    }
  }
  if (value instanceof Error) {
    const held = errorHolds(value)
    if (held !== undefined) {
      return {
        what: `an Error with a ${held}`,
        why: `its ${held} isn't one of its enumerable properties, which are all DynamoDB stores of it`,
        use: "Store a struct of what you need of it, such as its message",
      }
    }
  }
  if (inherits(value, REDACTED_MARKER)) {
    return {
      what: "a Redacted",
      why: "its value is held outside it, so only its marker is stored",
      use: "Declare the field as Schema.Redacted, which stores the value",
    }
  }
  if (value instanceof Map) {
    for (const key of value.keys()) {
      if (typeof key !== "string") {
        return {
          what: `a Map with a ${key === null ? "null" : typeof key} key`,
          why: "a map's keys are stored as text, so the key reads back as a string",
          use: "Give it string keys, or store a list of its entries",
        }
      }
    }
  }
  if (
    value instanceof ArrayBuffer ||
    (typeof SharedArrayBuffer === "function" && value instanceof SharedArrayBuffer) ||
    (ArrayBuffer.isView(value) && !(value instanceof Uint8Array))
  ) {
    return {
      what: binaryName(value),
      why: "only a Uint8Array is stored as its bytes, and a read hands back a Uint8Array",
      use: "Store a Uint8Array of its bytes",
    }
  }
  return undefined
}

/**
 * The enumerable data properties marshalling stores of an object, its prototypes' included, in the
 * order it walks them: without a function or `undefined`, and without calling a getter.
 */
const storedProperties = (value: object): ReadonlyArray<readonly [string, unknown]> => {
  const properties: Array<readonly [string, unknown]> = []
  const named = new Set<string>()
  for (let at: object | null = value; at !== null; at = Object.getPrototypeOf(at)) {
    const descriptors = Object.getOwnPropertyDescriptors(at)
    for (const key of Object.keys(descriptors)) {
      if (named.has(key)) continue
      named.add(key)
      const descriptor = descriptors[key]!
      if (!descriptor.enumerable || !("value" in descriptor)) continue
      const property: unknown = descriptor.value
      if (property !== undefined && typeof property !== "function") properties.push([key, property])
    }
  }
  return properties
}

const found = (lost: Lost, path: ReadonlyArray<string | number>): LostAt => ({
  _tag: "LostAt",
  ...lost,
  path,
})

const walk = (
  value: unknown,
  path: ReadonlyArray<string | number>,
  open: Set<object>,
): LostAt | undefined => {
  if (typeof value !== "object" || value === null || open.has(value)) return undefined
  const lost = lostAs(value)
  if (lost !== undefined) return found(lost, path)
  // A set holds strings, numbers or bytes, or marshalling refuses it; bytes are stored whole.
  if (value instanceof Set || value instanceof Uint8Array) return undefined
  open.add(value)
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, index)
        if (descriptor === undefined || !("value" in descriptor)) continue
        const inside = walk(descriptor.value, [...path, index], open)
        if (inside !== undefined) return inside
      }
      return undefined
    }
    if (value instanceof Map) {
      for (const [key, entry] of value) {
        const inside = walk(entry, [...path, String(key)], open)
        if (inside !== undefined) return inside
      }
      return undefined
    }
    // One of Effect's cookies: the marshaller writes its expiry as ISO text.
    const cookie = Object.getPrototypeOf(value) === COOKIE_PROTO
    for (const [key, property] of storedProperties(value)) {
      if (cookie && key === "options" && typeof property === "object" && property !== null) {
        const inside = walkOptions(property, [...path, key], open)
        if (inside !== undefined) return inside
        continue
      }
      const inside = walk(property, [...path, key], open)
      if (inside !== undefined) return inside
    }
    return undefined
  } finally {
    open.delete(value)
  }
}

/** A cookie's options: an expiry the marshaller writes as text is stored. */
const walkOptions = (
  options: object,
  path: ReadonlyArray<string | number>,
  open: Set<object>,
): LostAt | undefined => {
  if (open.has(options)) return undefined
  open.add(options)
  try {
    for (const [key, property] of storedProperties(options)) {
      if (key === "expires" && expiryText(property) !== undefined) continue
      const inside = walk(property, [...path, key], open)
      if (inside !== undefined) return inside
    }
    return undefined
  } finally {
    open.delete(options)
  }
}

/**
 * The first part of a value, depth first as the marshaller walks it, that DynamoDB doesn't store
 * ({@link lostAs}), with its path; `undefined` when it stores all of it. A
 * cycle isn't followed: the marshaller refuses one itself (`EDD-9124`).
 */
export const lostIn = (value: unknown): LostAt | undefined => walk(value, [], new Set())

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/** A path into a value from `root`, as a refusal names it: `f.a[0]["b c"]`. */
export const lostPath = (root: string, path: ReadonlyArray<string | number>): string =>
  path.reduce<string>(
    (at, segment) =>
      typeof segment === "number"
        ? `${at}[${segment}]`
        : IDENTIFIER.test(segment)
          ? `${at}.${segment}`
          : `${at}[${JSON.stringify(segment)}]`,
    root,
  )

/** The refusal in words: the value at `at` is lost (`EDD-9161`). */
export const lostRefusal = (at: string, lost: Lost): string =>
  `the value at ${at} is ${lost.what}, which DynamoDB doesn't store: ${lost.why}. Nothing was ` +
  `written. ${lost.use}. [EDD-9161]`
