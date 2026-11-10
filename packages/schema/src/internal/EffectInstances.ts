/**
 * @internal Effect's own declarations whose values DynamoDB hands back as plain maps, and how each
 * is rebuilt from that map.
 *
 * The marshaller stores a class instance as the map of its enumerable properties, its prototype's
 * included, so a `BigDecimal`, a `Duration`, a zone, a cookie, a version, an address or a DNS record
 * is stored as a map carrying its marker. Each declaration's guard looks for that marker, so it takes
 * the map back as it is: a value that passes the guard and isn't one (`BigDecimal` arithmetic throws,
 * a named zone can't format, a key composed from it is `[object Object]`).
 *
 * {@link effectDeclarationOf} is the one place that decides whether a declaration is one of Effect's:
 * every path that treats these types differently asks it, so none can recognise a type another
 * doesn't. A declaration is Effect's when its parse function is the one Effect's exported schema has.
 * A `.check()`, an annotation and a brand keep that function, and a refinement Effect builds on one of
 * these keeps its base's; a `Schema.declare` of one's own has its own, whatever it's named, and so has
 * a declaration from another copy of `effect`. Those are read as they always were.
 */
import { BigDecimal, DateTime, Duration, Effect, Result, Schema, SchemaAST } from "effect"
import * as Cookies from "effect/http/Cookies"
import * as UrlParams from "effect/http/UrlParams"
import * as Dns from "effect/net/Dns"
import * as Host from "effect/net/Host"
import * as IpInterface from "effect/net/IpInterface"
import * as IpNetwork from "effect/net/IpNetwork"
import * as NetAddress from "effect/net/NetAddress"
import * as SemVer from "effect/SemVer"
import * as SemVerRange from "effect/SemVerRange"
import { BETA_DATE_MARKER, DATE_MARKER, ZONE_MARKER } from "./PackedCodec.js"

/** Which of Effect's declarations a node is: the rebuild it takes, and the rules it's held to. */
export type InstanceKind =
  | "DateTime"
  | "BigDecimal"
  | "Duration"
  | "TimeZone"
  | "Cookie"
  | "Cookies"
  | "UrlParams"
  | "SemVer"
  | "SemVerRange"
  | "NetAddress"
  | "DnsRecord"

const DECLARATIONS: ReadonlyArray<readonly [Schema.Top, InstanceKind]> = [
  [Schema.DateTimeUtc, "DateTime"],
  [Schema.DateTimeZoned, "DateTime"],
  [Schema.BigDecimal, "BigDecimal"],
  [Schema.Duration, "Duration"],
  [Schema.TimeZone, "TimeZone"],
  [Schema.TimeZoneNamed, "TimeZone"],
  [Schema.TimeZoneOffset, "TimeZone"],
  [Schema.Cookie, "Cookie"],
  [Schema.Cookies, "Cookies"],
  [Schema.UrlParams, "UrlParams"],
  [Schema.SemVer, "SemVer"],
  [Schema.SemVerRange, "SemVerRange"],
  [Schema.Ipv4Address, "NetAddress"],
  [Schema.Ipv6Address, "NetAddress"],
  [Schema.IpAddress, "NetAddress"],
  [Schema.MacAddress, "NetAddress"],
  [Schema.Ipv4Network, "NetAddress"],
  [Schema.Ipv6Network, "NetAddress"],
  [Schema.IpNetwork, "NetAddress"],
  [Schema.Ipv4Interface, "NetAddress"],
  [Schema.Ipv6Interface, "NetAddress"],
  [Schema.IpInterface, "NetAddress"],
  [Schema.InetAddressV4, "NetAddress"],
  [Schema.InetAddressV6, "NetAddress"],
  [Schema.InetAddress, "NetAddress"],
  [Schema.HostPort, "NetAddress"],
  [Schema.SocketAddress, "NetAddress"],
  [Schema.UnixPathAddress, "NetAddress"],
  [Schema.DnsARecord, "DnsRecord"],
  [Schema.DnsAaaaRecord, "DnsRecord"],
  [Schema.DnsCaaRecord, "DnsRecord"],
  [Schema.DnsCnameRecord, "DnsRecord"],
  [Schema.DnsMxRecord, "DnsRecord"],
  [Schema.DnsNaptrRecord, "DnsRecord"],
  [Schema.DnsNsRecord, "DnsRecord"],
  [Schema.DnsPtrRecord, "DnsRecord"],
  [Schema.DnsSoaRecord, "DnsRecord"],
  [Schema.DnsSrvRecord, "DnsRecord"],
  [Schema.DnsTlsaRecord, "DnsRecord"],
  [Schema.DnsTxtRecord, "DnsRecord"],
]

const representationIdOf = (ast: SchemaAST.AST): string | undefined =>
  (ast.annotations?.representation as { readonly id?: unknown } | undefined)?.id as
    | string
    | undefined

/** Each declaration's parse function, with its kind and, where it has one, its representation. */
const KNOWN = new Map<unknown, { readonly kind: InstanceKind; readonly id: string | undefined }>(
  DECLARATIONS.map(([schema, kind]) => [
    (schema.ast as SchemaAST.Declaration).run,
    { kind, id: representationIdOf(schema.ast) },
  ]),
)

type Parser = SchemaAST.Declaration["run"]

/** Each read node's parser ({@link readingDeclaration}), with the declaration's own it runs. */
const READ_PARSERS = new WeakMap<Parser, Parser>()

/**
 * Which of Effect's declarations this node is, or `undefined` for any other node. Only the
 * declaration itself counts: a transformation over one stores what it encodes to, and is reached
 * through its encoding. A declaration's read node ({@link readingDeclaration}) is the declaration it
 * reads.
 */
export const effectDeclarationOf = (ast: SchemaAST.AST): InstanceKind | undefined => {
  if (!SchemaAST.isDeclaration(ast) || ast.encoding !== undefined) return undefined
  const known = KNOWN.get(READ_PARSERS.get(ast.run) ?? ast.run)
  if (known === undefined) return undefined
  if (known.id !== undefined && representationIdOf(ast) !== known.id) return undefined
  return known.kind
}

/**
 * The last step each of Effect's own codecs takes onto one of these declarations
 * (`Schema.DateTimeUtcFromString`, `Schema.DurationFromMillis`, ...): it makes the instance itself,
 * so the declaration's parser is never handed a stored map, and there's nothing to rebuild.
 */
const INSTANCE_STEPS = new WeakSet<object>()
for (const exported of Object.values(Schema)) {
  const ast = (exported as { readonly ast?: SchemaAST.AST } | null | undefined)?.ast
  if (ast === undefined || !SchemaAST.isDeclaration(ast) || !KNOWN.has(ast.run)) continue
  const step = ast.encoding?.[0]?.transformation
  if (step !== undefined) INSTANCE_STEPS.add(step)
}

/**
 * Which of Effect's declarations a read takes this node's parser for, whether or not the node has an
 * encoding: a transformation onto one hands its parser whatever its steps make of what's stored, and
 * a step that passes the stored map through leaves the parser taking it for an instance. One of
 * Effect's own codecs isn't one: its step makes the instance ({@link INSTANCE_STEPS}).
 */
export const readDeclarationOf = (ast: SchemaAST.AST): InstanceKind | undefined => {
  if (!SchemaAST.isDeclaration(ast)) return undefined
  if (ast.encoding !== undefined && INSTANCE_STEPS.has(ast.encoding[0]!.transformation)) {
    return undefined
  }
  const known = KNOWN.get(READ_PARSERS.get(ast.run) ?? ast.run)
  if (known === undefined) return undefined
  if (known.id !== undefined && representationIdOf(ast) !== known.id) return undefined
  return known.kind
}

/** Whether a node is a read node {@link readingDeclaration} built. */
export const isReadingDeclaration = (ast: SchemaAST.AST): boolean =>
  SchemaAST.isDeclaration(ast) && READ_PARSERS.has(ast.run)

// ---------------------------------------------------------------------------
// Rebuilds: each takes what DynamoDB hands back and returns the instance, or `undefined` when the
// value isn't the map one of these is stored as. A real instance carries its marker on its
// prototype, so it isn't taken for one.
// ---------------------------------------------------------------------------

type StoredMap = globalThis.Record<string, unknown>

const isMap = (value: unknown): value is StoredMap =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** A plain record, what unmarshalling produces, as opposed to a class instance. */
const isPlain = (value: unknown): value is StoredMap => {
  if (value === null || typeof value !== "object") return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

const markedBy = (value: unknown, marker: string): value is StoredMap =>
  isMap(value) && Object.hasOwn(value, marker)

const resultOf = <A>(result: Result.Result<A, unknown>): A | undefined =>
  Result.isSuccess(result) ? result.success : undefined

const attempt = <A>(make: () => A): A | undefined => {
  try {
    return make()
  } catch {
    return undefined
  }
}

/**
 * A stored integer as a bigint. The unmarshaller hands an integer back as a number while it's a safe
 * one and as a bigint past that, so either is exact; a number that isn't a safe integer is no integer
 * this was written from.
 */
const exactInteger = (value: unknown): bigint | undefined =>
  typeof value === "bigint"
    ? value
    : typeof value === "number" && Number.isSafeInteger(value)
      ? BigInt(value)
      : undefined

const isUint32 = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffffffff

const BIG_DECIMAL = "~effect/BigDecimal"
const DURATION = "~effect/Duration"
const COOKIE = "~effect/http/Cookies/Cookie"
const COOKIES = "~effect/http/Cookies"
const URL_PARAMS = "~effect/http/UrlParams"
const SEMVER = "~effect/SemVer"
const SEMVER_RANGE = "~effect/SemVerRange"
const NET_ADDRESS = "~effect/net/NetAddress"
const IP_NETWORK = "~effect/net/IpNetwork"
const IP_INTERFACE = "~effect/net/IpInterface"
const HOST = "~effect/net/Host"
const DNS_RECORD = "~effect/net/Dns/DnsRecord"

/**
 * A stored `normalized` is left where it is, in the map: on an instance it's the slot
 * `BigDecimal.normalize` caches in, and a map there would be handed out as the normalized decimal.
 */
const rebuildBigDecimal = (value: unknown): BigDecimal.BigDecimal | undefined => {
  if (!markedBy(value, BIG_DECIMAL) || Object.hasOwn(value, "normalized")) return undefined
  const unscaled = exactInteger(value.value)
  const scale = value.scale
  if (unscaled === undefined || typeof scale !== "number" || !Number.isSafeInteger(scale)) {
    return undefined
  }
  return BigDecimal.make(unscaled, scale)
}

const rebuildDuration = (value: unknown): Duration.Duration | undefined => {
  if (!markedBy(value, DURATION) || !isMap(value.value)) return undefined
  const stored = value.value
  switch (stored._tag) {
    case "Millis":
      return typeof stored.millis === "number" && Number.isFinite(stored.millis)
        ? Duration.millis(stored.millis)
        : undefined
    case "Nanos": {
      const nanos = exactInteger(stored.nanos)
      return nanos === undefined ? undefined : Duration.nanos(nanos)
    }
    case "Infinity":
      return Duration.infinity
    case "NegativeInfinity":
      return Duration.negativeInfinity
    default:
      return undefined
  }
}

/** A zone from its stored form: a named one from its id, an offset one from its offset. */
export const reviveTimeZone = (zone: unknown): DateTime.TimeZone | undefined => {
  if (!isPlain(zone)) return undefined
  try {
    if (zone._tag === "Named" && typeof zone.id === "string") {
      return DateTime.zoneMakeNamedUnsafe(zone.id)
    }
    if (zone._tag === "Offset" && typeof zone.offset === "number") {
      return DateTime.zoneMakeOffset(zone.offset)
    }
  } catch {
    return undefined
  }
  return undefined
}

/**
 * Rebuild a `DateTime` from a MARSHALLED instance (#133).
 *
 * Before #133 an aggregate stored some `DateTime`s by marshalling the instance
 * itself, which keeps its own enumerable properties:
 *
 * - `Utc`: `{ epochMilliseconds, <type-id>, _tag: "Utc" }`
 * - `Zoned`: the same plus `zone`, itself `{ id, _tag: "Named" }` or
 *   `{ offset, _tag: "Offset" }` (a named zone's `Intl` formatter marshals to
 *   an empty map and is not needed).
 *
 * The type-id key is `~effect/time/DateTime` on effect 4.0.0-rc and
 * `~effect/DateTime` on 4.0.0, so it is deliberately NOT inspected: the instant
 * and the tag are what identify the value, and they are all a `DateTime` holds.
 * A zoned value is rebuilt only when its zone is recoverable.
 *
 * Returns `undefined` for anything else — including a genuine `DateTime`, which
 * needs no rebuilding.
 */
export const reviveMarshalledDateTime = (value: unknown): DateTime.DateTime | undefined => {
  if (!isPlain(value)) return undefined
  const epochMs = value.epochMilliseconds
  if (typeof epochMs !== "number" || !Number.isFinite(epochMs)) return undefined
  if (value._tag === "Utc") return DateTime.makeUnsafe(epochMs)
  if (value._tag === "Zoned") {
    const timeZone = reviveTimeZone(value.zone)
    return timeZone === undefined ? undefined : DateTime.makeZonedUnsafe(epochMs, { timeZone })
  }
  return undefined
}

const rebuildDateTime = (value: unknown): DateTime.DateTime | undefined =>
  isMap(value) && (DATE_MARKER in value || BETA_DATE_MARKER in value)
    ? reviveMarshalledDateTime(value)
    : undefined

const rebuildTimeZone = (value: unknown): DateTime.TimeZone | undefined =>
  markedBy(value, ZONE_MARKER) ? reviveTimeZone(value) : undefined

const COOKIE_PROTO: object = Object.getPrototypeOf(Cookies.makeCookieUnsafe("a", "b"))

/** An expiry as it's stored, ISO text, back as the `Date` it was written from. */
const expiryOf = (text: string): Date | undefined => {
  const date = new Date(text)
  return Number.isNaN(date.getTime()) || date.toISOString() !== text ? undefined : date
}

/**
 * A cookie's options as stored: `expires` is the ISO text of the `Date` written, or, as 1.39.0
 * stored it, the empty map the marshaller makes of a `Date`, which is no expiry. A `maxAge` that's
 * a `Duration` is one again.
 */
const cookieOptions = (options: unknown): StoredMap | undefined => {
  if (!isMap(options)) return undefined
  const rebuilt: StoredMap = {}
  for (const [key, value] of Object.entries(options)) {
    if (key === "expires" && typeof value === "string") {
      const expires = expiryOf(value)
      if (expires === undefined) return undefined
      rebuilt[key] = expires
      continue
    }
    if (key === "expires" && isMap(value) && Object.keys(value).length === 0) continue
    if (key === "maxAge" && markedBy(value, DURATION)) {
      const maxAge = rebuildDuration(value)
      if (maxAge === undefined) return undefined
      rebuilt[key] = maxAge
      continue
    }
    rebuilt[key] = value
  }
  return rebuilt
}

/**
 * A cookie on its own prototype with the fields stored, so `valueEncoded` stays exactly what was
 * written: rebuilding it from `value` could encode it otherwise.
 */
const rebuildCookie = (value: unknown): Cookies.Cookie | undefined => {
  if (!markedBy(value, COOKIE)) return undefined
  const { name, valueEncoded } = value
  if (
    typeof name !== "string" ||
    typeof value.value !== "string" ||
    typeof valueEncoded !== "string"
  ) {
    return undefined
  }
  const fields: StoredMap = { name, value: value.value, valueEncoded }
  if (Object.hasOwn(value, "options")) {
    const options = value.options === undefined ? undefined : cookieOptions(value.options)
    if (value.options !== undefined && options === undefined) return undefined
    fields.options = options
  }
  return Object.assign(Object.create(COOKIE_PROTO), fields) as Cookies.Cookie
}

const rebuildCookies = (value: unknown): Cookies.Cookies | undefined => {
  if (!markedBy(value, COOKIES) || !isMap(value.cookies)) return undefined
  const cookies: Array<Cookies.Cookie> = []
  for (const stored of Object.values(value.cookies)) {
    const cookie = rebuildCookie(stored)
    if (cookie === undefined) return undefined
    cookies.push(cookie)
  }
  return Cookies.fromIterable(cookies)
}

const rebuildUrlParams = (value: unknown): UrlParams.UrlParams | undefined => {
  if (!markedBy(value, URL_PARAMS) || !Array.isArray(value.params)) return undefined
  const params: Array<readonly [string, string]> = []
  for (const pair of value.params) {
    if (!Array.isArray(pair) || pair.length !== 2) return undefined
    const [key, text] = pair
    if (typeof key !== "string" || typeof text !== "string") return undefined
    params.push([key, text])
  }
  return UrlParams.make(params)
}

const rebuildSemVer = (value: unknown): SemVer.SemVer | undefined => {
  if (!markedBy(value, SEMVER)) return undefined
  const { major, minor, patch, prerelease, build } = value
  if (!Array.isArray(prerelease) || !Array.isArray(build)) return undefined
  return attempt(() =>
    SemVer.make({ major, minor, patch, prerelease, build } as Parameters<typeof SemVer.make>[0]),
  )
}

const RANGE_PROTO: object = Object.getPrototypeOf(SemVerRange.any)

const isComparator = (value: unknown): boolean =>
  isMap(value) &&
  value._tag === "Comparator" &&
  typeof value.operator === "string" &&
  isMap(value.version) &&
  Array.isArray(value.version.components) &&
  value.version.components.every((part) => typeof part === "number") &&
  Array.isArray(value.version.prerelease)

/** A range is its comparator sets, plain data: the range module has no constructor for them. */
const rebuildSemVerRange = (value: unknown): SemVerRange.SemVerRange | undefined => {
  if (!markedBy(value, SEMVER_RANGE) || !Array.isArray(value.sets)) return undefined
  const sets: Array<Array<StoredMap>> = []
  for (const set of value.sets) {
    if (!Array.isArray(set) || !set.every(isComparator)) return undefined
    sets.push(
      set.map((comparator: StoredMap) => {
        const version = comparator.version as StoredMap
        return {
          _tag: "Comparator",
          operator: comparator.operator,
          version: { components: version.components, prerelease: version.prerelease },
        }
      }),
    )
  }
  return Object.assign(Object.create(RANGE_PROTO), { sets }) as SemVerRange.SemVerRange
}

const ipv4 = (value: StoredMap): NetAddress.Ipv4Address | undefined => {
  if (!markedBy(value, NET_ADDRESS) || !isUint32(value.value)) return undefined
  const word = value.value
  return resultOf(
    NetAddress.ipv4FromOctets([
      word >>> 24,
      (word >>> 16) & 0xff,
      (word >>> 8) & 0xff,
      word & 0xff,
    ]),
  )
}

const ipv6 = (value: StoredMap): NetAddress.Ipv6Address | undefined => {
  if (!markedBy(value, NET_ADDRESS)) return undefined
  const words = [value.w0, value.w1, value.w2, value.w3]
  if (!words.every(isUint32)) return undefined
  return resultOf(
    NetAddress.ipv6FromSegments(
      (words as ReadonlyArray<number>).flatMap((word) => [word >>> 16, word & 0xffff]) as never,
    ),
  )
}

const ipAddress = (value: unknown): NetAddress.IpAddress | undefined => {
  if (!isMap(value)) return undefined
  return value._tag === "Ipv4Address"
    ? ipv4(value)
    : value._tag === "Ipv6Address"
      ? ipv6(value)
      : undefined
}

const isPort = (value: unknown): value is number => typeof value === "number"

/** An address, network, interface, socket address or host and port, by its tag. */
const rebuildNetAddress = (value: unknown): unknown => {
  if (!isMap(value)) return undefined
  switch (value._tag) {
    case "Ipv4Address":
    case "Ipv6Address":
      return ipAddress(value)
    case "MacAddress":
      return markedBy(value, NET_ADDRESS) && value.bytes instanceof Uint8Array
        ? resultOf(NetAddress.macAddressFromOctets([...value.bytes] as never))
        : undefined
    case "IpNetwork":
    case "IpInterface": {
      const marker = value._tag === "IpNetwork" ? IP_NETWORK : IP_INTERFACE
      const address = ipAddress(value.address)
      if (!markedBy(value, marker) || address === undefined) return undefined
      if (typeof value.prefixLength !== "number") return undefined
      return value._tag === "IpNetwork"
        ? resultOf(IpNetwork.make(address, value.prefixLength))
        : resultOf(IpInterface.make(address, value.prefixLength))
    }
    case "InetAddressV4": {
      const address = ipAddress(value.address)
      if (!markedBy(value, NET_ADDRESS) || !isPort(value.port)) return undefined
      return address !== undefined && address._tag === "Ipv4Address"
        ? resultOf(NetAddress.inetAddressV4(address, value.port))
        : undefined
    }
    case "InetAddressV6": {
      const address = ipAddress(value.address)
      if (!markedBy(value, NET_ADDRESS) || !isPort(value.port)) return undefined
      if (typeof value.scopeId !== "number") return undefined
      return address !== undefined && address._tag === "Ipv6Address"
        ? resultOf(NetAddress.inetAddressV6(address, value.port, { scopeId: value.scopeId }))
        : undefined
    }
    case "HostPort": {
      if (!markedBy(value, HOST) || !isPort(value.port)) return undefined
      const host = typeof value.host === "string" ? value.host : ipAddress(value.host)
      return host === undefined ? undefined : resultOf(Host.hostPort(host as Host.Host, value.port))
    }
    case "UnixPathAddress":
      return markedBy(value, NET_ADDRESS) && typeof value.path === "string"
        ? NetAddress.unixPathAddress(value.path)
        : undefined
    default:
      return undefined
  }
}

/** A value inside a DNS record: an address or a `Duration` is rebuilt, anything else kept. */
const recordField = (value: unknown): unknown =>
  markedBy(value, DURATION)
    ? rebuildDuration(value)
    : isMap(value) && (Object.hasOwn(value, NET_ADDRESS) || Object.hasOwn(value, HOST))
      ? rebuildNetAddress(value)
      : value

const rebuildDnsRecord = (value: unknown): Dns.DnsRecord | undefined => {
  if (!markedBy(value, DNS_RECORD) || typeof value._tag !== "string") return undefined
  const fields: StoredMap = {}
  for (const [key, field] of Object.entries(value)) {
    if (key === "_tag" || key === DNS_RECORD) continue
    const rebuilt = recordField(field)
    if (rebuilt === undefined && field !== undefined) return undefined
    fields[key] = rebuilt
  }
  return resultOf(Dns.makeRecord(value._tag as Dns.RecordType, fields as never)) as
    | Dns.DnsRecord
    | undefined
}

const REBUILDS: { readonly [K in InstanceKind]: (value: unknown) => unknown } = {
  DateTime: rebuildDateTime,
  BigDecimal: rebuildBigDecimal,
  Duration: rebuildDuration,
  TimeZone: rebuildTimeZone,
  Cookie: rebuildCookie,
  Cookies: rebuildCookies,
  UrlParams: rebuildUrlParams,
  SemVer: rebuildSemVer,
  SemVerRange: rebuildSemVerRange,
  NetAddress: rebuildNetAddress,
  DnsRecord: rebuildDnsRecord,
}

/** What marshalling stores of an object: its enumerable properties, its prototype's included. */
const writtenProperties = (value: object): ReadonlyArray<readonly [string, unknown]> => {
  const properties: Array<readonly [string, unknown]> = []
  for (const key in value) {
    const property = (value as StoredMap)[key]
    if (property !== undefined && typeof property !== "function") properties.push([key, property])
  }
  return properties
}

const sameNumber = (written: number | bigint, stored: unknown): boolean => {
  if (typeof stored !== "number" && typeof stored !== "bigint") return false
  if (typeof written === typeof stored) return written === stored
  const [integer, float] = typeof written === "bigint" ? [written, stored] : [stored, written]
  return Number.isSafeInteger(float) && BigInt(float as number) === integer
}

/**
 * Whether a value, written, is what's stored: the marshaller's walk of it, against what the
 * unmarshaller handed back. Anything this can't say for sure isn't the same.
 */
const writesAs = (written: unknown, stored: unknown): boolean => {
  if (typeof written === "number" || typeof written === "bigint") return sameNumber(written, stored)
  if (written === null || typeof written !== "object") return written === stored
  if (written instanceof Uint8Array) {
    return (
      stored instanceof Uint8Array &&
      stored.length === written.length &&
      written.every((byte, index) => byte === stored[index])
    )
  }
  if (written instanceof Set) {
    if (!(stored instanceof Set) || stored.size !== written.size) return false
    const members = [...stored]
    return [...written].every((member) => members.some((other) => writesAs(member, other)))
  }
  if (Array.isArray(written)) {
    const elements = written.filter(
      (element) => element !== undefined && typeof element !== "function",
    )
    return (
      Array.isArray(stored) &&
      stored.length === elements.length &&
      elements.every((element, index) => writesAs(element, stored[index]))
    )
  }
  if (!isPlain(stored)) return false
  const properties = written instanceof Map ? [...written] : writtenProperties(written)
  return (
    properties.length === Object.keys(stored).length &&
    properties.every(
      ([key, property]) =>
        typeof key === "string" && Object.hasOwn(stored, key) && writesAs(property, stored[key]),
    )
  )
}

/**
 * The instance with every stored property its rebuild made no use of, as its own: what an instance
 * was given on top of its fields (`Object.assign(duration, { source })`) was stored with it, and is
 * written again with it. On a copy of the instance, so nothing shared is touched; the instance
 * itself when there's nothing to carry.
 */
const carrying = (instance: object, stored: StoredMap): object => {
  const written = new Set<string>()
  for (const key in instance) written.add(key)
  const carried = Object.keys(stored).filter((key) => !written.has(key))
  if (carried.length === 0) return instance
  const copy = Object.create(
    Object.getPrototypeOf(instance),
    Object.getOwnPropertyDescriptors(instance),
  ) as object
  for (const key of carried) {
    Object.defineProperty(copy, key, {
      value: stored[key],
      enumerable: true,
      writable: true,
      configurable: true,
    })
  }
  return copy
}

/**
 * The kinds whose instance is rebuilt only if writing it stores what was read. A date's marker
 * changed between releases and a cookie's expiry is stored otherwise than it's held, so those are
 * rebuilt as they always were.
 */
const EXACT: { readonly [K in InstanceKind]: boolean } = {
  DateTime: false,
  BigDecimal: true,
  Duration: true,
  TimeZone: true,
  Cookie: false,
  Cookies: false,
  UrlParams: true,
  SemVer: true,
  SemVerRange: true,
  NetAddress: true,
  DnsRecord: true,
}

/**
 * The instance a stored value of this kind stands for, or `undefined` when the value isn't the map
 * one is stored as, or holds what can't be rebuilt exactly. A real instance is never one: it carries
 * its marker on its prototype, where the map carries it as its own.
 *
 * The instance carries every stored property its rebuild made no use of ({@link carrying}), so
 * writing it again stores what was read. Where it still wouldn't (a property the rebuild dropped
 * from inside the map), the value isn't rebuilt, and stays the map it always was.
 */
export const rebuildStored = (kind: InstanceKind, value: unknown): unknown => {
  const rebuilt = REBUILDS[kind](value)
  if (kind === "DateTime" || typeof rebuilt !== "object" || rebuilt === null || !isMap(value)) {
    return rebuilt
  }
  const instance = carrying(rebuilt, value)
  return EXACT[kind] && !writesAs(instance, value) ? undefined : instance
}

/**
 * One of Effect's declarations as a read takes it: its own parser decides on what's stored, exactly
 * as it always did, and what it takes is returned as the instance it stands for. Where that can't be
 * rebuilt exactly, it's returned as the parser returned it. A value the parser refuses is refused as
 * it was. The declaration's checks, and everything holding it, see what's returned.
 *
 * Encoding goes through the declaration's own parser, untouched. Annotations, checks, context and
 * the encoding chain are the declaration's: a transformation onto one runs its steps as it did, and
 * only what its parser then returns is rebuilt. A step that made a real instance itself has made
 * what's returned, the same object.
 */
export const readingDeclaration = (
  ast: SchemaAST.Declaration,
  kind: InstanceKind,
): SchemaAST.Declaration => {
  const parse = ast.run
  const read: Parser = (typeParameters) => {
    const parser = parse(typeParameters)
    return (input, self, options) =>
      Effect.map(parser(input, self, options), (parsed) => {
        const rebuilt = attempt(() => rebuildStored(kind, parsed))
        return rebuilt === undefined ? parsed : rebuilt
      })
  }
  READ_PARSERS.set(read, parse)
  return new SchemaAST.Declaration(
    ast.typeParameters,
    read,
    ast.annotations,
    ast.checks,
    ast.encoding,
    ast.context,
    ast.encodingChecks,
    ast.encodingRun ?? parse,
  )
}
