/**
 * One value of each of Effect's look-alike declarations: the types whose guards take the map
 * DynamoDB hands back for one, so that published 1.39.0 read that map back as the value.
 */
import { BigDecimal, DateTime, Duration, Equal, Option, Result, Schema } from "effect"
import * as Cookies from "effect/http/Cookies"
import * as UrlParams from "effect/http/UrlParams"
import * as Dns from "effect/net/Dns"
import * as SemVer from "effect/SemVer"
import * as SemVerRange from "effect/SemVerRange"

const decoded = (schema: Schema.Top, text: string): any =>
  Schema.decodeUnknownSync(schema as Schema.Codec<unknown, unknown>)(text)
const ipv4 = (text: string) => decoded(Schema.Ipv4AddressFromString, text)
const ipv6 = (text: string) => decoded(Schema.Ipv6AddressFromString, text)

export interface Lookalike {
  readonly name: string
  readonly field: Schema.Top
  /**
   * A fresh value: comparing or hashing one caches its normalized form, its parts or its hash on it,
   * and a value compared once is no longer the one written.
   */
  readonly make: () => unknown
}

/** Each type, by the name the matrix and the stored comparison use. */
export const lookalikes: ReadonlyArray<Lookalike> = [
  { name: "BigDecimal", field: Schema.BigDecimal, make: () => BigDecimal.fromStringUnsafe("1.50") },
  {
    name: "BigDecimal negative",
    field: Schema.BigDecimal,
    make: () => BigDecimal.fromStringUnsafe("-0.000123"),
  },
  {
    name: "BigDecimal past 2^53",
    field: Schema.BigDecimal,
    make: () => BigDecimal.fromStringUnsafe("123456789012345678.9"),
  },
  { name: "Duration", field: Schema.Duration, make: () => Duration.millis(1500) },
  { name: "Duration nanos", field: Schema.Duration, make: () => Duration.nanos(1500n) },
  {
    name: "Duration nanos past 2^53",
    field: Schema.Duration,
    make: () => Duration.nanos(2n ** 60n + 1n),
  },
  { name: "Duration infinity", field: Schema.Duration, make: () => Duration.infinity },
  { name: "TimeZone", field: Schema.TimeZone, make: () => DateTime.zoneMakeOffset(-3600000) },
  {
    name: "TimeZoneNamed",
    field: Schema.TimeZoneNamed,
    make: () => DateTime.zoneMakeNamedUnsafe("Europe/London"),
  },
  {
    name: "TimeZoneOffset",
    field: Schema.TimeZoneOffset,
    make: () => DateTime.zoneMakeOffset(3600000),
  },
  {
    name: "Cookie",
    field: Schema.Cookie,
    make: () =>
      Cookies.makeCookieUnsafe("a", "b c", {
        path: "/",
        maxAge: Duration.seconds(5),
        httpOnly: true,
      }),
  },
  {
    name: "Cookies",
    field: Schema.Cookies,
    make: () =>
      Cookies.fromIterable([
        Cookies.makeCookieUnsafe("a", "b"),
        Cookies.makeCookieUnsafe("c", "d", { secure: true }),
      ]),
  },
  {
    name: "UrlParams",
    field: Schema.UrlParams,
    make: () => UrlParams.fromInput({ a: "b", c: ["d", "e"] }),
  },
  { name: "SemVer", field: Schema.SemVer, make: () => SemVer.parseUnsafe("1.2.3-rc.1+b5") },
  {
    name: "SemVerRange",
    field: Schema.SemVerRange,
    make: () => SemVerRange.parseUnsafe(">=1.2.3 <2 || ^3.1"),
  },
  { name: "Ipv4Address", field: Schema.Ipv4Address, make: () => ipv4("10.0.0.1") },
  { name: "Ipv4PrivateAddress", field: Schema.Ipv4PrivateAddress, make: () => ipv4("10.0.0.1") },
  { name: "Ipv6Address", field: Schema.Ipv6Address, make: () => ipv6("fe80::1:2:ffff") },
  { name: "IpAddress", field: Schema.IpAddress, make: () => ipv6("::1") },
  {
    name: "MacAddress",
    field: Schema.MacAddress,
    make: () => decoded(Schema.MacAddressFromString, "00:11:22:33:44:55"),
  },
  {
    name: "Ipv4Network",
    field: Schema.Ipv4Network,
    make: () => decoded(Schema.Ipv4NetworkFromString, "10.0.0.0/24"),
  },
  {
    name: "Ipv6Network",
    field: Schema.Ipv6Network,
    make: () => decoded(Schema.Ipv6NetworkFromString, "fe80::/64"),
  },
  {
    name: "IpNetwork",
    field: Schema.IpNetwork,
    make: () => decoded(Schema.Ipv4NetworkFromString, "10.0.0.0/8"),
  },
  {
    name: "Ipv4Interface",
    field: Schema.Ipv4Interface,
    make: () => decoded(Schema.Ipv4InterfaceFromString, "10.0.0.5/24"),
  },
  {
    name: "Ipv6Interface",
    field: Schema.Ipv6Interface,
    make: () => decoded(Schema.Ipv6InterfaceFromString, "fe80::5/64"),
  },
  {
    name: "IpInterface",
    field: Schema.IpInterface,
    make: () => decoded(Schema.Ipv6InterfaceFromString, "fe80::5/64"),
  },
  {
    name: "InetAddressV4",
    field: Schema.InetAddressV4,
    make: () => decoded(Schema.InetAddressFromString, "10.0.0.1:80"),
  },
  {
    name: "InetAddressV6",
    field: Schema.InetAddressV6,
    make: () => decoded(Schema.InetAddressFromString, "[::1]:80"),
  },
  {
    name: "InetAddress",
    field: Schema.InetAddress,
    make: () => decoded(Schema.InetAddressFromString, "[fe80::1]:443"),
  },
  {
    name: "HostPort",
    field: Schema.HostPort,
    make: () => decoded(Schema.HostPortFromString, "a.example:80"),
  },
  {
    name: "HostPort address",
    field: Schema.HostPort,
    make: () => decoded(Schema.HostPortFromString, "10.0.0.1:80"),
  },
  {
    name: "SocketAddress",
    field: Schema.SocketAddress,
    make: () => decoded(Schema.UnixPathAddressFromString, "/tmp/sock"),
  },
  {
    name: "UnixPathAddress",
    field: Schema.UnixPathAddress,
    make: () => decoded(Schema.UnixPathAddressFromString, "/tmp/sock"),
  },
  {
    name: "DnsARecord",
    field: Schema.DnsARecord,
    make: () => Dns.makeRecordUnsafe("A", { address: ipv4("10.0.0.1") } as never),
  },
  {
    name: "DnsAaaaRecord",
    field: Schema.DnsAaaaRecord,
    make: () => Dns.makeRecordUnsafe("AAAA", { address: ipv6("::1") } as never),
  },
  {
    name: "DnsCaaRecord",
    field: Schema.DnsCaaRecord,
    make: () => Dns.makeRecordUnsafe("CAA", { critical: false, tag: "issue", value: "x" } as never),
  },
  {
    name: "DnsCnameRecord",
    field: Schema.DnsCnameRecord,
    make: () => Dns.makeRecordUnsafe("CNAME", { target: "a.example" } as never),
  },
  {
    name: "DnsMxRecord",
    field: Schema.DnsMxRecord,
    make: () => Dns.makeRecordUnsafe("MX", { priority: 10, exchange: "mx.example" } as never),
  },
  {
    name: "DnsNaptrRecord",
    field: Schema.DnsNaptrRecord,
    make: () =>
      Dns.makeRecordUnsafe("NAPTR", {
        order: 1,
        preference: 2,
        flags: "s",
        service: "x",
        regexp: "",
        replacement: "a.example",
      } as never),
  },
  {
    name: "DnsNsRecord",
    field: Schema.DnsNsRecord,
    make: () => Dns.makeRecordUnsafe("NS", { host: "a.example" } as never),
  },
  {
    name: "DnsPtrRecord",
    field: Schema.DnsPtrRecord,
    make: () => Dns.makeRecordUnsafe("PTR", { host: "a.example" } as never),
  },
  {
    name: "DnsSoaRecord",
    field: Schema.DnsSoaRecord,
    make: () =>
      Dns.makeRecordUnsafe("SOA", {
        primary: "a.example",
        admin: "b.example",
        serial: 1,
        refresh: Duration.seconds(60),
        retry: Duration.seconds(30),
        expire: Duration.seconds(600),
        minimum: Duration.seconds(10),
      } as never),
  },
  {
    name: "DnsSrvRecord",
    field: Schema.DnsSrvRecord,
    make: () =>
      Dns.makeRecordUnsafe("SRV", {
        priority: 1,
        weight: 2,
        port: 80,
        target: "a.example",
      } as never),
  },
  {
    name: "DnsTlsaRecord",
    field: Schema.DnsTlsaRecord,
    make: () =>
      Dns.makeRecordUnsafe("TLSA", {
        certUsage: 3,
        selector: 1,
        matchingType: 1,
        data: new Uint8Array([0xaa, 0xbb]),
      } as never),
  },
  {
    name: "DnsTxtRecord",
    field: Schema.DnsTxtRecord,
    make: () => Dns.makeRecordUnsafe("TXT", { chunks: ["a", "b"] } as never),
  },
  {
    name: "Option(DateTimeUtc)",
    field: Schema.Option(Schema.DateTimeUtc),
    make: () => Option.some(DateTime.makeUnsafe("2025-01-01T00:00:00.000Z")),
  },
  {
    name: "Option(DateTimeZoned)",
    field: Schema.Option(Schema.DateTimeZoned),
    make: () =>
      Option.some(
        DateTime.makeZonedUnsafe("2025-01-01T00:00:00.000Z", { timeZone: "Europe/London" }),
      ),
  },
  {
    name: "Result(DateTimeUtc, String)",
    field: Schema.Result(Schema.DateTimeUtc, Schema.String),
    make: () => Result.succeed(DateTime.makeUnsafe("2025-01-01T00:00:00.000Z")),
  },
  {
    name: "Result(String, DateTimeUtc)",
    field: Schema.Result(Schema.String, Schema.DateTimeUtc),
    make: () => Result.fail(DateTime.makeUnsafe("2025-01-01T00:00:00.000Z")),
  },
]

/** The value's own form for comparing: through its JSON codec, where it has one. */
const jsonOf = (field: Schema.Top, value: unknown): unknown => {
  try {
    return Schema.encodeUnknownSync(
      Schema.toCodecJson(field) as unknown as Schema.Codec<unknown, unknown>,
    )(value)
  } catch (error) {
    return `unencodable: ${String(error)}`
  }
}

/** Whether `value` is the instance `expected` is, not a map shaped like one: every level of it. */
export const isInstanceOf = (value: unknown, expected: unknown, field: Schema.Top): boolean => {
  const realAt = (a: unknown, b: unknown): boolean => {
    if (typeof b !== "object" || b === null) return Object.is(a, b) || a === b
    if (typeof a !== "object" || a === null) return false
    if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false
    if (b instanceof Uint8Array) return a instanceof Uint8Array && a.every((x, i) => x === b[i])
    const keys = Reflect.ownKeys(b).filter((key) => typeof key === "string")
    return keys.every((key) => realAt((a as any)[key], (b as any)[key]))
  }
  return (
    realAt(value, expected) &&
    (!Equal.isEqual(expected) || Equal.equals(value, expected)) &&
    JSON.stringify(jsonOf(field, value)) === JSON.stringify(jsonOf(field, expected))
  )
}
