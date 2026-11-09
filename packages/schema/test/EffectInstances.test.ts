/**
 * Which of Effect's own declarations a node is (`effectDeclarationOf`): told apart by the parser
 * Effect gave it, and by its `representation` id where it has one, never by a name. A check, an
 * annotation, a brand or one of Effect's refinements over a declaration keeps it; a transformation
 * over one stores what it encodes to, and isn't one.
 */
import { describe, expect, it } from "@effect/vitest"
import { Duration, Schema } from "effect"
import { effectDeclarationOf } from "../src/internal/EffectInstances.js"

const kinds: ReadonlyArray<readonly [string, Schema.Top, string]> = [
  ["DateTimeUtc", Schema.DateTimeUtc, "DateTime"],
  ["DateTimeZoned", Schema.DateTimeZoned, "DateTime"],
  ["BigDecimal", Schema.BigDecimal, "BigDecimal"],
  ["Duration", Schema.Duration, "Duration"],
  ["TimeZone", Schema.TimeZone, "TimeZone"],
  ["TimeZoneNamed", Schema.TimeZoneNamed, "TimeZone"],
  ["TimeZoneOffset", Schema.TimeZoneOffset, "TimeZone"],
  ["Cookie", Schema.Cookie, "Cookie"],
  ["Cookies", Schema.Cookies, "Cookies"],
  ["UrlParams", Schema.UrlParams, "UrlParams"],
  ["SemVer", Schema.SemVer, "SemVer"],
  ["SemVerRange", Schema.SemVerRange, "SemVerRange"],
  ["Ipv4Address", Schema.Ipv4Address, "NetAddress"],
  ["Ipv4PrivateAddress", Schema.Ipv4PrivateAddress, "NetAddress"],
  ["Ipv6Address", Schema.Ipv6Address, "NetAddress"],
  ["IpAddress", Schema.IpAddress, "NetAddress"],
  ["MacAddress", Schema.MacAddress, "NetAddress"],
  ["MacUnicastAddress", Schema.MacUnicastAddress, "NetAddress"],
  ["Ipv4Network", Schema.Ipv4Network, "NetAddress"],
  ["Ipv6Network", Schema.Ipv6Network, "NetAddress"],
  ["IpNetwork", Schema.IpNetwork, "NetAddress"],
  ["Ipv4Interface", Schema.Ipv4Interface, "NetAddress"],
  ["Ipv6Interface", Schema.Ipv6Interface, "NetAddress"],
  ["IpInterface", Schema.IpInterface, "NetAddress"],
  ["InetAddressV4", Schema.InetAddressV4, "NetAddress"],
  ["InetAddressV6", Schema.InetAddressV6, "NetAddress"],
  ["InetAddress", Schema.InetAddress, "NetAddress"],
  ["HostPort", Schema.HostPort, "NetAddress"],
  ["SocketAddress", Schema.SocketAddress, "NetAddress"],
  ["UnixPathAddress", Schema.UnixPathAddress, "NetAddress"],
  ["DnsARecord", Schema.DnsARecord, "DnsRecord"],
  ["DnsAaaaRecord", Schema.DnsAaaaRecord, "DnsRecord"],
  ["DnsCaaRecord", Schema.DnsCaaRecord, "DnsRecord"],
  ["DnsCnameRecord", Schema.DnsCnameRecord, "DnsRecord"],
  ["DnsMxRecord", Schema.DnsMxRecord, "DnsRecord"],
  ["DnsNaptrRecord", Schema.DnsNaptrRecord, "DnsRecord"],
  ["DnsNsRecord", Schema.DnsNsRecord, "DnsRecord"],
  ["DnsPtrRecord", Schema.DnsPtrRecord, "DnsRecord"],
  ["DnsSoaRecord", Schema.DnsSoaRecord, "DnsRecord"],
  ["DnsSrvRecord", Schema.DnsSrvRecord, "DnsRecord"],
  ["DnsTlsaRecord", Schema.DnsTlsaRecord, "DnsRecord"],
  ["DnsTxtRecord", Schema.DnsTxtRecord, "DnsRecord"],
]

describe("effectDeclarationOf", () => {
  for (const [name, schema, kind] of kinds) {
    it(`${name} is ${kind}, checked, annotated and branded alike`, () => {
      expect(effectDeclarationOf(schema.ast)).toBe(kind)
      const checked = schema.check(Schema.makeFilter(() => true))
      expect(effectDeclarationOf(checked.ast)).toBe(kind)
      expect(effectDeclarationOf(schema.annotate({ title: "t" }).ast)).toBe(kind)
      expect(effectDeclarationOf(schema.pipe(Schema.brand("B")).ast)).toBe(kind)
    })
  }

  it("a transformation over one isn't one: what's stored is what it encodes to", () => {
    expect(effectDeclarationOf(Schema.DurationFromMillis.ast)).toBeUndefined()
    expect(effectDeclarationOf(Schema.BigDecimalFromString.ast)).toBeUndefined()
    expect(effectDeclarationOf(Schema.DateTimeUtcFromString.ast)).toBeUndefined()
    expect(effectDeclarationOf(Schema.Ipv4AddressFromString.ast)).toBeUndefined()
  })

  it("a declaration of one's own is none, whatever it's named", () => {
    for (const identifier of ["Duration", "Ipv4Address", "DnsARecord", "BigDecimal"]) {
      const own = Schema.declare((u: unknown): u is Duration.Duration =>
        Duration.isDuration(u),
      ).annotate({ identifier })
      expect(effectDeclarationOf(own.ast)).toBeUndefined()
    }
    expect(effectDeclarationOf(Schema.instanceOf(Map).ast)).toBeUndefined()
  })

  it("a container of one isn't one", () => {
    expect(effectDeclarationOf(Schema.Option(Schema.Duration).ast)).toBeUndefined()
    expect(effectDeclarationOf(Schema.Array(Schema.Duration).ast)).toBeUndefined()
    expect(effectDeclarationOf(Schema.Union([Schema.Duration, Schema.String]).ast)).toBeUndefined()
  })
})
