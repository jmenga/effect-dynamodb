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
 * stored as text; and binary data measured on 1.40.0 to be stored as less than it is or not sent: an
 * `ArrayBuffer`, a `DataView` or a `Blob` is stored as empty bytes, a `SharedArrayBuffer` as an empty
 * map, a subclass of any of them without its bytes, and the AWS SDK fails to send ten typed arrays
 * (a `TypeError`), named one by one. Any other binary kind is stored as it was. A cookie's expiry is
 * the exception to a `Date`: the marshaller writes it as ISO text.
 * `undefined`, a function or a hole in a list isn't one: the list closes up, as it always has, and a
 * caller can rely on that (a documented limit). Everything is read from descriptors, so no getter is
 * called.
 *
 * What's behind a getter (an enumerable accessor the marshaller reads, or one at a list's index) is
 * only known by calling it, and the marshaller calls it once. So {@link lostIn} doesn't: it marks
 * the value, and each object on the way to the getter, and the marshaller reads a marked value
 * through {@link readJudged}, which judges what each getter returns, as the marshaller calls it, by
 * the same rules. A getter is called as often as it was before, and what it returns is judged where
 * it's stored.
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

/**
 * Binary data whose bytes are held outside its properties: an instance of any of these, a subclass's
 * included, is stored without them. Measured on 1.40.0: an `ArrayBuffer`, a `DataView` and a `Blob`
 * (a `File` is one) were stored as empty bytes, a `SharedArrayBuffer` as an empty map, and a subclass
 * of each as the map of its enumerable properties, which holds none of its bytes.
 */
const HELD_BYTES: ReadonlyArray<Function> = [
  ArrayBuffer,
  DataView,
  ...(typeof SharedArrayBuffer === "function" ? [SharedArrayBuffer] : []),
  ...(typeof Blob === "function" ? [Blob] : []),
]

/**
 * The typed arrays the AWS SDK fails to send (a `TypeError` while serialising), each by its own
 * prototype: measured on 1.40.0, each failed the write with a `DynamoError`. Any other kind, a
 * `Float16Array` and a subclass of one of these included, is stored as the map of its elements, which
 * reads back as their numbers, as it was, and so is a kind a later runtime adds.
 */
const UNSENT_ARRAYS: ReadonlySet<object> = new Set([
  Int8Array.prototype,
  Uint8ClampedArray.prototype,
  Int16Array.prototype,
  Uint16Array.prototype,
  Int32Array.prototype,
  Uint32Array.prototype,
  Float32Array.prototype,
  Float64Array.prototype,
  BigInt64Array.prototype,
  BigUint64Array.prototype,
])

/** Whether DynamoDB is sent less of this binary value than it is, or fails to be sent it. */
const isLostBinary = (value: object): boolean => {
  if (ArrayBuffer.isView(value) && UNSENT_ARRAYS.has(Object.getPrototypeOf(value))) return true
  for (const kind of HELD_BYTES) if (value instanceof kind) return true
  return false
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
  if (isLostBinary(value)) {
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
 * order it walks them: without a function or `undefined`, and without calling a getter. `getters`
 * says whether it walks an enumerable accessor too, whose value only a call says.
 */
const storedProperties = (
  value: object,
): {
  readonly properties: ReadonlyArray<readonly [string, unknown]>
  readonly getters: boolean
} => {
  const properties: Array<readonly [string, unknown]> = []
  const named = new Set<string>()
  let getters = false
  for (let at: object | null = value; at !== null; at = Object.getPrototypeOf(at)) {
    const descriptors = Object.getOwnPropertyDescriptors(at)
    for (const key of Object.keys(descriptors)) {
      if (named.has(key)) continue
      named.add(key)
      const descriptor = descriptors[key]!
      if (!descriptor.enumerable) continue
      if (!("value" in descriptor)) {
        getters = true
        continue
      }
      const property: unknown = descriptor.value
      if (property !== undefined && typeof property !== "function") properties.push([key, property])
    }
  }
  return { properties, getters }
}

/**
 * The values {@link lostIn} looked through holding a part behind a getter, and each object on the
 * way to it: what the getter returns is judged when the marshaller calls it ({@link readJudged}).
 */
const behindGetters = new WeakSet<object>()

/** Whether anything has been marked: until then, nothing is judged as it's read, and nothing looked for. */
let marking = false

const mark = (value: object): void => {
  behindGetters.add(value)
  marking = true
}

/** Whether {@link lostIn} found a part of this value behind a getter, which it didn't call. */
export const holdsGetters = (value: unknown): value is object =>
  typeof value === "object" && value !== null && behindGetters.has(value)

const found = (lost: Lost, path: ReadonlyArray<string | number>): LostAt => ({
  _tag: "LostAt",
  ...lost,
  path,
})

/**
 * The first lost part of a value, or whether it holds a part behind a getter (marking it, and each
 * object on the way, in {@link behindGetters}).
 */
const walk = (
  value: unknown,
  path: ReadonlyArray<string | number>,
  open: Set<object>,
): LostAt | boolean => {
  if (typeof value !== "object" || value === null || open.has(value)) return false
  const lost = lostAs(value)
  if (lost !== undefined) return found(lost, path)
  // A set holds strings, numbers or bytes, or marshalling refuses it; bytes are stored whole.
  if (value instanceof Set || value instanceof Uint8Array) return false
  open.add(value)
  try {
    let getters = false
    const inside = (part: unknown, at: ReadonlyArray<string | number>): LostAt | undefined => {
      const walked = walk(part, at, open)
      if (walked === true) getters = true
      return typeof walked === "boolean" ? undefined : walked
    }
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, index)
        if (descriptor === undefined) continue
        if (!("value" in descriptor)) {
          getters = true
          continue
        }
        const lostInside = inside(descriptor.value, [...path, index])
        if (lostInside !== undefined) return lostInside
      }
    } else if (value instanceof Map) {
      for (const [key, entry] of value) {
        const lostInside = inside(entry, [...path, String(key)])
        if (lostInside !== undefined) return lostInside
      }
    } else {
      // One of Effect's cookies: the marshaller writes its expiry as ISO text.
      const cookie = Object.getPrototypeOf(value) === COOKIE_PROTO
      const stored = storedProperties(value)
      if (stored.getters) getters = true
      for (const [key, property] of stored.properties) {
        if (cookie && key === "options" && typeof property === "object" && property !== null) {
          const options = walkOptions(property, [...path, key], open)
          if (options === true) getters = true
          if (typeof options !== "boolean") return options
          continue
        }
        const lostInside = inside(property, [...path, key])
        if (lostInside !== undefined) return lostInside
      }
    }
    if (getters) mark(value)
    return getters
  } finally {
    open.delete(value)
  }
}

/** A cookie's options: an expiry the marshaller writes as text is stored. */
const walkOptions = (
  options: object,
  path: ReadonlyArray<string | number>,
  open: Set<object>,
): LostAt | boolean => {
  if (open.has(options)) return false
  open.add(options)
  try {
    const stored = storedProperties(options)
    let getters = stored.getters
    for (const [key, property] of stored.properties) {
      if (key === "expires" && expiryText(property) !== undefined) continue
      const walked = walk(property, [...path, key], open)
      if (walked === true) getters = true
      else if (walked !== false) return walked
    }
    if (getters) mark(options)
    return getters
  } finally {
    open.delete(options)
  }
}

/**
 * The first part of a value, depth first as the marshaller walks it, that DynamoDB doesn't store
 * ({@link lostAs}), with its path; `undefined` when it stores all of it. A
 * cycle isn't followed: the marshaller refuses one itself (`EDD-9124`). A part behind a getter isn't
 * called for: the value is marked, and judged as the marshaller reads it ({@link readJudged}).
 */
export const lostIn = (value: unknown): LostAt | undefined => {
  const walked = walk(value, [], new Set())
  return typeof walked === "boolean" ? undefined : walked
}

const INDEX = /^(?:0|[1-9][0-9]*)$/

/**
 * The parts of `value` that are marked ({@link holdsGetters}) or hold one that is, the value's own
 * included, read from descriptors: a value the library built around a marked one (a copy of the
 * struct holding it, say) leads to it. A marked part isn't looked into: what's behind a getter in it
 * is marked in turn.
 */
const holdersIn = (value: unknown, holders: Set<object>, seen: Set<object>): boolean => {
  if (typeof value !== "object" || value === null) return false
  if (behindGetters.has(value)) {
    holders.add(value)
    return true
  }
  if (seen.has(value)) return holders.has(value)
  seen.add(value)
  if (value instanceof Set || value instanceof ArrayBuffer || ArrayBuffer.isView(value))
    return false
  let holds = false
  const parts: Iterable<unknown> =
    value instanceof Map
      ? Map.prototype.values.call(value)
      : Array.isArray(value)
        ? Object.values(Object.getOwnPropertyDescriptors(value)).flatMap((descriptor) =>
            "value" in descriptor ? [descriptor.value] : [],
          )
        : storedProperties(value).properties.map(([, property]) => property)
  for (const part of parts) if (holdersIn(part, holders, seen)) holds = true
  if (holds) holders.add(value)
  return holds
}

/**
 * The value as the marshaller is to read it. Where it holds a part {@link lostIn} marked
 * ({@link holdsGetters}), a view whose getters, each called as the marshaller calls it and once for
 * each time it does, have what they return judged by {@link lostIn} where it's stored. A lost part
 * calls `refuse` with where it is, from `path`; any other is handed on, viewed in turn where it's
 * marked. Any other value is itself, and until anything has been marked nothing is looked for.
 *
 * The view forwards every read to the value, so the marshaller takes the branch it always took and
 * stores what it always stored: the same prototype, the same keys in the same order, the same
 * values. Only a part that is or holds a marked one is a view; the rest is the value's own. A view's
 * target is a stand-in (an empty list for a list), so a frozen value can be viewed: a proxy can only
 * report another value of a property its own target lets it.
 */
export const readJudged = (
  value: unknown,
  path: ReadonlyArray<string | number>,
  refuse: (lost: LostAt) => never,
): unknown => {
  if (!marking || typeof value !== "object" || value === null) return value
  const holders = new Set<object>()
  return holdersIn(value, holders, new Set())
    ? viewOf(value, path, refuse, holders, new Map())
    : value
}

const viewOf = (
  real: object,
  path: ReadonlyArray<string | number>,
  refuse: (lost: LostAt) => never,
  holders: ReadonlySet<object>,
  views: Map<object, object>,
): object => {
  const had = views.get(real)
  if (had !== undefined) return had
  const list = Array.isArray(real)
  const map = real instanceof Map
  const part = (value: unknown, at: ReadonlyArray<string | number>): unknown =>
    holdsGetters(value) || (typeof value === "object" && value !== null && holders.has(value))
      ? viewOf(value, at, refuse, holders, views)
      : value
  const stand: object = list ? new Array((real as ReadonlyArray<unknown>).length) : {}
  const view = new Proxy(stand, {
    get: (_, key) => {
      if (map && (key === Symbol.iterator || key === "entries")) {
        return function* () {
          for (const [entryKey, entry] of Map.prototype.entries.call(real)) {
            yield [entryKey, part(entry, [...path, String(entryKey)])]
          }
        }
      }
      if (typeof key !== "string") return Reflect.get(real, key)
      const segment = list && INDEX.test(key) ? Number(key) : key
      const descriptor = descriptorOf(real, key)
      if (
        descriptor !== undefined &&
        !("value" in descriptor) &&
        (descriptor.enumerable === true || typeof segment === "number")
      ) {
        // What the marshaller reads here: called once, as it calls it, and judged where `lostIn`
        // marked it; a getter of a value built around a marked one is only called.
        const read: unknown = Reflect.get(real, key)
        if (!behindGetters.has(real)) return part(read, [...path, segment])
        const lost = lostIn(read)
        if (lost !== undefined) return refuse({ ...lost, path: [...path, segment, ...lost.path] })
        return part(read, [...path, segment])
      }
      const property: unknown = Reflect.get(real, key)
      // A map's own methods run on the map itself; its constructor is handed on as it is.
      if (map && key !== "constructor" && typeof property === "function") {
        return property.bind(real)
      }
      return part(property, [...path, segment])
    },
    has: (_, key) => Reflect.has(real, key),
    ownKeys: () => Reflect.ownKeys(real),
    getOwnPropertyDescriptor: (_, key) => {
      const descriptor = Reflect.getOwnPropertyDescriptor(real, key)
      if (descriptor === undefined) return undefined
      // A list's length is its stand-in's, as long as it, and the rest reported as configurable,
      // as a property of an extensible target that hasn't got it can be.
      if (list && key === "length") return Reflect.getOwnPropertyDescriptor(stand, key)
      return { ...descriptor, configurable: true }
    },
    getPrototypeOf: () => Reflect.getPrototypeOf(real),
  })
  views.set(real, view)
  return view
}

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
