/**
 * The blob pointer codec — Packed layout `010` (#179 §4.2, §4.3): encode /
 * decode round trips in both stored forms (`B` bytes, and a binary field's
 * `~edbp:` base64url `S` text), every refusal of a malformed pointer, and the
 * `PackedCodec` changes (`parseHeader`, `unpackBytesSync`,
 * `parseBinaryPointerText`, the widened `isBase64PackedText`).
 */

import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit, Option, Schema } from "effect"
import * as Compression from "../src/Compression.js"
import { ValidationError } from "../src/Errors.js"
import * as BlobPointer from "../src/internal/BlobPointer.js"
import { crc64nvme } from "../src/internal/Crc64Nvme.js"
import * as PackedCodec from "../src/internal/PackedCodec.js"
import { ascii, seeded } from "./helpers/Bytes.js"

const ctx = { entityType: "Document", operation: "get" }

const checksum = (value = crc64nvme(ascii("{}"))): BlobPointer.BlobChecksum => ({
  algorithm: "crc64nvme",
  value,
})

const fields = (
  overrides: Partial<BlobPointer.BlobPointerFields> = {},
): BlobPointer.BlobPointerFields => ({
  kind: "json",
  codec: "zstd",
  ref: { key: "prod/0123456789abcdef0123456789abcdef/fedcba98/0a1b2c3d", version: "3HL4kqtJ" },
  objectSize: 1_234,
  contentSize: 98_765,
  checksum: checksum(),
  contentType: Option.none(),
  ...overrides,
})

const binaryFields = (
  overrides: Partial<BlobPointer.BlobPointerFields> = {},
): BlobPointer.BlobPointerFields =>
  fields({
    kind: "bytes",
    codec: "none",
    objectSize: 12_000_000,
    contentSize: 12_000_000,
    contentType: Option.some("application/pdf"),
    ...overrides,
  })

const make = (f: BlobPointer.BlobPointerFields): BlobPointer.BlobPointer => {
  const pointer = BlobPointer.make(f)
  if (typeof pointer === "string") throw new Error(pointer)
  return pointer
}

const decoded = (bytes: Uint8Array): BlobPointer.BlobPointer => {
  const pointer = BlobPointer.decode(bytes)
  if (typeof pointer === "string") throw new Error(pointer)
  return pointer
}

/** The plain fields of a pointer, for structural comparison. */
const plain = (p: BlobPointer.BlobPointerFields) => ({
  kind: p.kind,
  codec: p.codec,
  ref: { key: p.ref.key, version: p.ref.version },
  objectSize: p.objectSize,
  contentSize: p.contentSize,
  checksum: { algorithm: p.checksum.algorithm, value: Array.from(p.checksum.value) },
  contentType: Option.getOrUndefined(p.contentType),
})

/** Recompute the trailer after editing a pointer's bytes. */
const resealed = (bytes: Uint8Array): Uint8Array => {
  const out = bytes.slice()
  const end = out.length - BlobPointer.TRAILER_BYTES
  out.set(crc64nvme(out.subarray(0, end)).subarray(4), end)
  return out
}

/** A pointer's bytes, built field by field (no validation): for refusal tests. */
const raw = (parts: {
  readonly header?: number
  readonly magic?: ReadonlyArray<number>
  readonly flags?: number
  readonly algorithm?: number
  readonly checksum?: ReadonlyArray<number>
  readonly sizes?: ReadonlyArray<number>
  readonly key?: ReadonlyArray<number>
  readonly version?: ReadonlyArray<number>
  readonly contentType?: ReadonlyArray<number>
  readonly extra?: ReadonlyArray<number>
}): Uint8Array => {
  const body = [
    parts.header ?? 0x40,
    ...(parts.magic ?? BlobPointer.MAGIC),
    parts.flags ?? (parts.contentType === undefined ? 0 : 1),
    parts.algorithm ?? 1,
    ...(parts.checksum ?? [1, 2, 3, 4, 5, 6, 7, 8]),
    ...(parts.sizes ?? [5, 5]),
    ...(parts.key ?? [1, 0x6b]),
    ...(parts.version ?? [0]),
    ...(parts.contentType ?? []),
    ...(parts.extra ?? []),
  ]
  return resealed(new Uint8Array([...body, 0, 0, 0, 0]))
}

const reason = (bytes: Uint8Array): string => {
  const result = BlobPointer.decode(bytes)
  expect(typeof result, `expected a refusal of ${Array.from(bytes)}`).toBe("string")
  return result as string
}

const text = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url")

describe("BlobPointer — header", () => {
  it("writers emit 0x40–0x43 (json, none / gzip / brotli / zstd) and 0x48 (bytes)", () => {
    expect(BlobPointer.pointerHeaderByte("json", "none")).toBe(0x40)
    expect(BlobPointer.pointerHeaderByte("json", "gzip")).toBe(0x41)
    expect(BlobPointer.pointerHeaderByte("json", "brotli")).toBe(0x42)
    expect(BlobPointer.pointerHeaderByte("json", "zstd")).toBe(0x43)
    expect(BlobPointer.pointerHeaderByte("bytes", "none")).toBe(0x48)
  })

  it("parseHeader reads every writable pointer header and refuses the rest of 0x40–0x5F", () => {
    expect(PackedCodec.parseHeader(0x40)).toEqual({ version: 2, kind: "json", codec: "none" })
    expect(PackedCodec.parseHeader(0x41)).toEqual({ version: 2, kind: "json", codec: "gzip" })
    expect(PackedCodec.parseHeader(0x42)).toEqual({ version: 2, kind: "json", codec: "brotli" })
    expect(PackedCodec.parseHeader(0x43)).toEqual({ version: 2, kind: "json", codec: "zstd" })
    expect(PackedCodec.parseHeader(0x48)).toEqual({ version: 2, kind: "bytes", codec: "none" })
    const readable = new Set([0x40, 0x41, 0x42, 0x43, 0x48])
    for (let byte = 0x40; byte <= 0x5f; byte++) {
      if (readable.has(byte)) continue
      const result = PackedCodec.parseHeader(byte)
      expect(typeof result, `0x${byte.toString(16)}`).toBe("string")
      expect(result).toContain("blob pointer (layout version 2)")
    }
    for (const byte of [0x44, 0x45, 0x46, 0x47]) {
      expect(PackedCodec.parseHeader(byte)).toContain(`unknown codec code ${byte & 7}`)
    }
    for (const byte of [0x49, 0x4a, 0x4b]) {
      expect(PackedCodec.parseHeader(byte)).toContain("compressed bytes pointer is reserved")
    }
    for (const byte of [0x4c, 0x4d, 0x4e, 0x4f]) {
      expect(PackedCodec.parseHeader(byte)).toContain(`unknown codec code ${byte & 7}`)
    }
    for (let byte = 0x50; byte <= 0x5f; byte++) {
      expect(PackedCodec.parseHeader(byte)).toContain(
        `reserved pointer kind ${(byte >>> 3) & 0b11}`,
      )
    }
  })

  it("layouts 011 and above are still refused as written by a newer version", () => {
    for (let byte = 0x60; byte <= 0xff; byte++) {
      const result = PackedCodec.parseHeader(byte)
      expect(result).toContain(`layout version ${byte >>> 5}`)
      expect(result).toContain("newer effect-dynamodb")
    }
  })
})

describe("BlobPointer — encode / decode round trip", () => {
  const cases: ReadonlyArray<readonly [string, BlobPointer.BlobPointerFields]> = [
    ["json, zstd, no content type", fields()],
    [
      "json, none (sizes equal)",
      fields({ codec: "none", objectSize: 70_000, contentSize: 70_000 }),
    ],
    ["json, gzip", fields({ codec: "gzip" })],
    [
      "json, brotli, with a content type",
      fields({ codec: "brotli", contentType: Option.some("x") }),
    ],
    ["bytes, with a content type", binaryFields()],
    ["bytes, no content type", binaryFields({ contentType: Option.none() })],
    [
      "a 1-byte key and an empty version (key-per-write store)",
      fields({ ref: { key: "k", version: "" } }),
    ],
    [
      "a 1,024-byte key and a 1,024-byte version",
      fields({ ref: { key: "k".repeat(1_024), version: "v".repeat(1_024) } }),
    ],
    [
      "multi-byte UTF-8 at the key limit (341 × 3 bytes + 1)",
      fields({ ref: { key: `${"€".repeat(341)}x`, version: "é" } }),
    ],
    [
      "a key starting with U+FEFF (not a byte-order mark)",
      fields({ ref: { key: "﻿k", version: "﻿" } }),
    ],
    ["a 1-byte content type", binaryFields({ contentType: Option.some("a") })],
    ["a 255-byte content type", binaryFields({ contentType: Option.some("t".repeat(255)) })],
    ["zero sizes", fields({ codec: "none", objectSize: 0, contentSize: 0 })],
    [
      "the largest safe sizes",
      fields({ objectSize: Number.MAX_SAFE_INTEGER, contentSize: Number.MAX_SAFE_INTEGER - 1 }),
    ],
    ["LEB128 boundaries", fields({ objectSize: 127, contentSize: 128 })],
    ["LEB128 boundaries (2)", fields({ objectSize: 16_383, contentSize: 16_384 })],
    ["50 TB object", binaryFields({ objectSize: 50e12, contentSize: 50e12 })],
  ]

  for (const [name, f] of cases) {
    it(`${name}: B and S forms decode back to the same pointer`, () => {
      const pointer = make(f)
      expect(plain(pointer)).toEqual(plain(f))
      const bytes = BlobPointer.encode(pointer)
      expect(bytes[0]).toBe(BlobPointer.pointerHeaderByte(f.kind, f.codec))
      expect(Array.from(bytes.subarray(1, 5))).toEqual([0x45, 0x44, 0x42, 0x50])
      const fromBytes = decoded(bytes)
      expect(plain(fromBytes)).toEqual(plain(f))
      expect(Array.from(BlobPointer.encode(fromBytes))).toEqual(Array.from(bytes))

      const s = BlobPointer.encodeText(pointer)
      expect(s.startsWith("~edbp:")).toBe(true)
      expect(s.slice(6)).toBe(text(bytes))
      expect(s).not.toContain("=")
      const fromText = BlobPointer.decodeText(s)
      expect(typeof fromText).toBe("object")
      expect(plain(fromText as BlobPointer.BlobPointer)).toEqual(plain(f))
    })
  }

  it("the bytes follow the documented layout", () => {
    const pointer = make(
      binaryFields({
        ref: { key: "ab", version: "v1" },
        objectSize: 300,
        contentSize: 300,
        contentType: Option.some("image/png"),
        checksum: checksum(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])),
      }),
    )
    const bytes = BlobPointer.encode(pointer)
    const expected = [
      0x48,
      0x45,
      0x44,
      0x42,
      0x50,
      0x01, // flags: a content type follows
      0x01, // CRC-64/NVME
      1,
      2,
      3,
      4,
      5,
      6,
      7,
      8,
      0xac, // 300 = 0b10_0101100 → 0xac 0x02
      0x02,
      0xac,
      0x02,
      2,
      0x61,
      0x62,
      2,
      0x76,
      0x31,
      9,
      ...ascii("image/png"),
    ]
    expect(Array.from(bytes.subarray(0, expected.length))).toEqual(expected)
    expect(bytes.length).toBe(expected.length + 4)
    const trailer = crc64nvme(bytes.subarray(0, expected.length)).subarray(4)
    expect(Array.from(bytes.subarray(expected.length))).toEqual(Array.from(trailer))
  })

  it("a typical pointer is about 200 bytes as B and 275 as S", () => {
    const key = `prod/${"a".repeat(32)}/${"b".repeat(32)}/${"c".repeat(32)}`
    const pointer = make(
      binaryFields({
        ref: { key, version: "v".repeat(32) },
        contentType: Option.some("image/png"),
      }),
    )
    const bytes = BlobPointer.encode(pointer)
    expect(bytes.length).toBeGreaterThan(150)
    expect(bytes.length).toBeLessThan(220)
    expect(BlobPointer.encodeText(pointer).length).toBeLessThan(300)
  })

  it("a pointer never aliases the bytes it was made or decoded from", () => {
    const value = new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9])
    const pointer = make(fields({ checksum: checksum(value) }))
    value[0] = 0
    expect(pointer.checksum.value[0]).toBe(9)
    const bytes = BlobPointer.encode(pointer)
    const back = decoded(bytes)
    bytes[7] = 0
    expect(back.checksum.value[0]).toBe(9)
    expect(Object.isFrozen(back)).toBe(true)
    expect(Object.isFrozen(back.ref)).toBe(true)
  })

  it("a pointer never aliases a Buffer it was made or decoded from (Buffer#slice is a view)", () => {
    const value = Buffer.from([9, 9, 9, 9, 9, 9, 9, 9])
    const pointer = make(fields({ checksum: checksum(value) }))
    value[0] = 0
    expect(pointer.checksum.value[0]).toBe(9)
    expect(Buffer.isBuffer(pointer.checksum.value)).toBe(false)
    const bytes = Buffer.from(BlobPointer.encode(pointer))
    const back = decoded(bytes)
    // Byte 7 is the checksum's first byte (header, magic, flags, algorithm).
    expect(bytes[7]).toBe(9)
    bytes[7] = 0
    expect(back.checksum.value[0]).toBe(9)
    expect(Buffer.isBuffer(back.checksum.value)).toBe(false)
  })

  it("isBlobPointer: pointers only — never a parsed JSON value", () => {
    const pointer = make(fields())
    expect(BlobPointer.isBlobPointer(pointer)).toBe(true)
    expect(BlobPointer.isBlobPointer(decoded(BlobPointer.encode(pointer)))).toBe(true)
    for (const value of [
      null,
      undefined,
      "x",
      1,
      {},
      [],
      plain(pointer),
      JSON.parse(JSON.stringify(pointer)),
      JSON.parse('{"__proto__":{"x":1}}'),
    ]) {
      expect(BlobPointer.isBlobPointer(value)).toBe(false)
    }
  })

  it("is inspectable and pipeable", () => {
    const pointer = make(
      binaryFields({ checksum: checksum(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 255])) }),
    )
    expect(pointer.toJSON()).toMatchObject({
      _id: "BlobPointer",
      kind: "bytes",
      checksum: { algorithm: "crc64nvme", value: "00010203040506ff" },
      contentType: "application/pdf",
    })
    expect(String(pointer)).toContain("00010203040506ff")
    expect(pointer.pipe((p) => p.ref.key)).toBe(pointer.ref.key)
  })

  it("random pointers round trip in both forms", () => {
    const random = seeded(179)
    const string = (length: number, alphabet: string) =>
      Array.from({ length }, () => alphabet[random.int(alphabet.length)]).join("")
    for (let i = 0; i < 300; i++) {
      const kind = random.int(2) === 0 ? "json" : "bytes"
      const codec =
        kind === "bytes" ? "none" : (["none", "gzip", "brotli", "zstd"] as const)[random.int(4)]!
      const contentSize = random.int(2) === 0 ? random.int(200) : random.int(2 ** 31) * 4096
      const f = fields({
        kind,
        codec,
        ref: {
          key: string(1 + random.int(300), "abcdef0123456789/-_.é€"),
          version: string(random.int(80), "ABCDEFabcdef0123456789._"),
        },
        objectSize: codec === "none" ? contentSize : random.int(2 ** 40),
        contentSize,
        checksum: checksum(random.bytes(8)),
        contentType:
          random.int(2) === 0 ? Option.none() : Option.some(string(1 + random.int(60), "abc/+;=")),
      })
      const pointer = make(f)
      expect(plain(decoded(BlobPointer.encode(pointer)))).toEqual(plain(f))
      expect(
        plain(BlobPointer.decodeText(BlobPointer.encodeText(pointer)) as BlobPointer.BlobPointer),
      ).toEqual(plain(f))
    }
  })
})

describe("BlobPointer — make refuses fields no pointer can hold", () => {
  const refused: ReadonlyArray<readonly [string, BlobPointer.BlobPointerFields, string]> = [
    ["an unknown kind", fields({ kind: "text" as never }), "kind"],
    ["an unknown codec", fields({ codec: "lz4" as never }), "codec"],
    ["a compressed bytes pointer", binaryFields({ codec: "gzip" }), "never compressed"],
    ["an empty key", fields({ ref: { key: "", version: "v" } }), "outside 1 … 1024"],
    [
      "a 1,025-byte key",
      fields({ ref: { key: "k".repeat(1_025), version: "v" } }),
      "outside 1 … 1024",
    ],
    [
      "a key of 1,025 UTF-8 bytes in fewer characters",
      fields({ ref: { key: `${"€".repeat(341)}xx`, version: "v" } }),
      "1025 UTF-8 bytes",
    ],
    [
      "a 1,025-byte version",
      fields({ ref: { key: "k", version: "v".repeat(1_025) } }),
      "over 1024",
    ],
    [
      "a lone surrogate in the key",
      fields({ ref: { key: "a\uD800", version: "" } }),
      "well-formed",
    ],
    [
      "a lone surrogate in the version",
      fields({ ref: { key: "a", version: "\uDC00" } }),
      "well-formed",
    ],
    ["a negative size", fields({ objectSize: -1 }), "safe size"],
    ["a fractional size", fields({ contentSize: 1.5 }), "safe size"],
    ["an unsafe size", fields({ objectSize: 2 ** 53 }), "safe size"],
    [
      "different sizes without compression",
      fields({ codec: "none", objectSize: 1, contentSize: 2 }),
      "nothing is compressed",
    ],
    [
      "a SHA-256 checksum",
      fields({ checksum: { algorithm: "sha256" as never, value: new Uint8Array(32) } }),
      "crc64nvme",
    ],
    ["a 7-byte checksum", fields({ checksum: checksum(new Uint8Array(7)) }), "8 bytes"],
    ["an empty content type", binaryFields({ contentType: Option.some("") }), "outside 1 … 255"],
    [
      "a 256-byte content type",
      binaryFields({ contentType: Option.some("t".repeat(256)) }),
      "outside 1 … 255",
    ],
    [
      "a non-ASCII content type",
      binaryFields({ contentType: Option.some("tëxt/plain") }),
      "US-ASCII",
    ],
    [
      "a content type that is not an Option",
      binaryFields({ contentType: "text/plain" as never }),
      "Option",
    ],
  ]
  for (const [name, f, fragment] of refused) {
    it(name, () => {
      const result = BlobPointer.make(f)
      expect(typeof result).toBe("string")
      expect(result).toContain(fragment)
    })
  }
})

describe("BlobPointer — decode refuses malformed pointers", () => {
  const valid = BlobPointer.encode(make(binaryFields()))

  it("truncation at every offset", () => {
    for (let length = 0; length < valid.length; length++) {
      reason(valid.subarray(0, length))
    }
  })

  it("a corrupted byte anywhere (the trailer catches what the fields do not)", () => {
    for (let i = 0; i < valid.length; i++) {
      for (const flip of [0x01, 0x80]) {
        const corrupt = valid.slice()
        corrupt[i] = corrupt[i]! ^ flip
        reason(corrupt)
      }
    }
  })

  it("a bad trailer", () => {
    const corrupt = valid.slice()
    corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 0xff
    expect(reason(corrupt)).toContain("trailer")
  })

  it("a bad magic, even with a matching trailer", () => {
    for (let i = 1; i <= 4; i++) {
      const corrupt = valid.slice()
      corrupt[i] = 0x00
      expect(reason(resealed(corrupt))).toContain("bad magic")
    }
  })

  it("every reserved header value", () => {
    const readable = new Set([0x40, 0x41, 0x42, 0x43, 0x48])
    for (let byte = 0; byte < 256; byte++) {
      if (readable.has(byte)) continue
      const bytes = valid.slice()
      bytes[0] = byte
      reason(resealed(bytes))
    }
  })

  const cases: ReadonlyArray<readonly [string, Uint8Array, string]> = [
    ["reserved flag bits", raw({ flags: 0x02 }), "reserved flag bits"],
    ["the SHA-256 algorithm (reserved)", raw({ algorithm: 0x02 }), "SHA-256"],
    ["an unknown algorithm", raw({ algorithm: 0x03 }), "unknown checksum algorithm 0x03"],
    ["algorithm 0", raw({ algorithm: 0x00 }), "unknown checksum algorithm 0x00"],
    ["a non-minimal LEB128 size", raw({ sizes: [0x85, 0x00, 5] }), "not minimally encoded"],
    [
      "a LEB128 size over 8 bytes",
      raw({ sizes: [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01, 5] }),
      "longer than 8 bytes",
    ],
    [
      "an unsafe LEB128 size",
      raw({ sizes: [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f, 5] }),
      "not a safe integer",
    ],
    ["an empty key", raw({ key: [0], version: [1, 0x76] }), "key length 0 is outside 1 … 1024"],
    [
      "a 1,025-byte key length",
      raw({ key: [0x81, 0x08, ...new Array(1_025).fill(0x6b)] }),
      "outside 1 … 1024",
    ],
    [
      "a 1,025-byte version length",
      raw({ version: [0x81, 0x08, ...new Array(1_025).fill(0x76)] }),
      "outside 0 … 1024",
    ],
    ["a key that is not UTF-8", raw({ key: [2, 0xc3, 0x28] }), "key is not valid UTF-8"],
    ["a version that is not UTF-8", raw({ version: [1, 0xff] }), "version is not valid UTF-8"],
    [
      "an empty content type",
      raw({ contentType: [0] }),
      "content type length 0 is outside 1 … 255",
    ],
    [
      "a 256-byte content type",
      raw({ contentType: [0x80, 0x02, ...new Array(256).fill(0x61)] }),
      "outside 1 … 255",
    ],
    ["a non-ASCII content type", raw({ contentType: [1, 0xe9] }), "not US-ASCII"],
    [
      "a flagged content type that is missing",
      raw({ flags: 1 }),
      "truncated in the content type length",
    ],
    ["bytes before the trailer", raw({ extra: [0] }), "1 unexpected bytes"],
    ["different sizes without compression", raw({ sizes: [5, 6] }), "nothing is compressed"],
    ["a key length past the end", raw({ key: [9, 0x6b], version: [] }), "truncated"],
  ]
  for (const [name, bytes, fragment] of cases) {
    it(name, () => {
      expect(reason(bytes)).toContain(fragment)
    })
  }

  it("the raw builder makes valid pointers when nothing is wrong", () => {
    expect(plain(decoded(raw({})))).toMatchObject({ kind: "json", codec: "none", objectSize: 5 })
    expect(plain(decoded(raw({ header: 0x48, contentType: [3, ...ascii("a/b")] })))).toMatchObject({
      kind: "bytes",
      contentType: "a/b",
    })
  })
})

describe("BlobPointer — S form (binary fields)", () => {
  const pointer = make(binaryFields())
  const s = BlobPointer.encodeText(pointer)

  it("the sentinel is outside every base64 alphabet", () => {
    for (const bytes of [
      new Uint8Array([0x48]),
      BlobPointer.encode(pointer),
      seeded(1).bytes(64),
    ]) {
      for (const encoded of [Buffer.from(bytes).toString("base64"), text(bytes)]) {
        expect(encoded.startsWith("~edbp:")).toBe(false)
        expect(BlobPointer.isPointerText(encoded)).toBe(false)
      }
    }
    expect(BlobPointer.isPointerText(s)).toBe(true)
  })

  it("decodeText: not a pointer without the prefix", () => {
    for (const other of [
      "",
      "edbp:abc",
      "~edbp",
      "~EDBP:abc",
      " ~edbp:abc",
      "{}",
      text(BlobPointer.encode(pointer)),
    ]) {
      expect(BlobPointer.decodeText(other)).toBeUndefined()
    }
  })

  it("decodeText refuses text that is not canonical unpadded base64url", () => {
    const body = s.slice(6)
    const refused = [
      `~edbp:${body}=`, // padded
      `~edbp:${body}==`,
      `~edbp:${body.slice(0, -1)}!`,
      `~edbp:${body.slice(0, -1)}+`, // the standard alphabet
      `~edbp:${body.slice(0, -1)}/`,
      `~edbp:${body}\n`,
      `~edbp: ${body}`,
      `~edbp:${body}A`, // an extra character: a bad length, or bytes that are not a pointer
      "~edbp:",
    ]
    for (const bad of refused) {
      const result = BlobPointer.decodeText(bad)
      expect(typeof result, JSON.stringify(bad)).toBe("string")
    }
  })

  it("decodeText refuses a last character with non-zero padding bits (same bytes, not canonical)", () => {
    // Only lengths that are not a multiple of 3 have padding bits: a 25-byte
    // pointer (1-byte remainder, 4 padding bits) and a 26-byte one (2 bits).
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
    const remainders = new Set<number>()
    for (const key of ["ab", "abc"]) {
      const small = make(
        fields({ codec: "none", objectSize: 1, contentSize: 1, ref: { key, version: "" } }),
      )
      const bytes = BlobPointer.encode(small)
      expect(bytes.length % 3).not.toBe(0)
      remainders.add(bytes.length % 3)
      const body = BlobPointer.encodeText(small).slice(6)
      const last = alphabet.indexOf(body[body.length - 1]!)
      const tweaked = `~edbp:${body.slice(0, -1)}${alphabet[last + 1]}`
      // The tweak changes padding bits only: a lenient decoder reads the same bytes.
      expect(Buffer.from(tweaked.slice(6), "base64url")).toEqual(Buffer.from(bytes))
      expect(BlobPointer.decodeText(tweaked)).toContain("not canonical base64url")
      expect(BlobPointer.isBlobPointer(BlobPointer.decodeText(`~edbp:${body}`))).toBe(true)
    }
    expect([...remainders].sort()).toEqual([1, 2])
  })

  it("decodeText of valid base64url that is not a pointer is the pointer's reason", () => {
    expect(BlobPointer.decodeText(`~edbp:${text(ascii("hello"))}`)).toContain("not a blob pointer")
    const corrupt = BlobPointer.encode(pointer)
    corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 1
    expect(BlobPointer.decodeText(`~edbp:${text(corrupt)}`)).toContain("trailer")
  })
})

describe("PackedCodec.parseBinaryPointerText", () => {
  const pointer = make(binaryFields())

  it("valid text → the pointer", () => {
    const result = PackedCodec.parseBinaryPointerText(BlobPointer.encodeText(pointer), ctx, "scan")
    expect(BlobPointer.isBlobPointer(result)).toBe(true)
    expect(plain(result as BlobPointer.BlobPointer)).toEqual(plain(pointer))
  })

  it("text without the prefix → not a pointer", () => {
    expect(PackedCodec.parseBinaryPointerText("hello", ctx, "scan")).toBeUndefined()
    expect(PackedCodec.parseBinaryPointerText("", ctx, "scan")).toBeUndefined()
  })

  it("~edbp: with invalid base64url → a ValidationError naming the attribute", () => {
    const result = PackedCodec.parseBinaryPointerText("~edbp:not*base64", ctx, "scan")
    expect(result).toBeInstanceOf(ValidationError)
    expect(result).toMatchObject({ entityType: "Document", operation: "get" })
    const message = ((result as ValidationError).cause as Error).message
    expect(message).toContain('Binary attribute "scan"')
    expect(message).toContain("base64url")
  })

  it("~edbp: with a malformed pointer → a ValidationError", () => {
    const corrupt = BlobPointer.encode(pointer).subarray(0, 20)
    const result = PackedCodec.parseBinaryPointerText(`~edbp:${text(corrupt)}`, ctx, "scan")
    expect(result).toBeInstanceOf(ValidationError)
  })

  it("an overflow (json) pointer as text → a ValidationError: binary fields hold bytes pointers", () => {
    const json = BlobPointer.encodeText(make(fields()))
    const result = PackedCodec.parseBinaryPointerText(json, ctx, "scan")
    expect(result).toBeInstanceOf(ValidationError)
    expect(((result as ValidationError).cause as Error).message).toContain("kind json")
  })
})

describe("PackedCodec.unpackBytesSync / unpackValue — layout 010", () => {
  const registry = Compression.empty

  it("returns the decoded pointer for a json pointer (never fetching)", () => {
    for (const codec of ["none", "gzip", "brotli", "zstd"] as const) {
      const pointer = make(
        fields(codec === "none" ? { codec, objectSize: 9, contentSize: 9 } : { codec }),
      )
      const result = PackedCodec.unpackBytesSync(BlobPointer.encode(pointer), registry, ctx, "body")
      expect(BlobPointer.isBlobPointer(result)).toBe(true)
      expect(plain(result as BlobPointer.BlobPointer)).toEqual(plain(pointer))
      // No compressor is needed: the codec names the object, which is not read here.
      expect(
        BlobPointer.isBlobPointer(
          PackedCodec.unpackStoredSync(BlobPointer.encode(pointer), registry, ctx, "body"),
        ),
      ).toBe(true)
    }
  })

  it.effect("unpackValue succeeds with the pointer", () =>
    Effect.gen(function* () {
      const pointer = make(fields())
      const result = yield* PackedCodec.unpackValue(BlobPointer.encode(pointer), registry, {
        ...ctx,
        attribute: "body",
      })
      expect(BlobPointer.isBlobPointer(result)).toBe(true)
    }),
  )

  it("a bytes pointer stored as B on a packed attribute is a ValidationError", () => {
    const result = PackedCodec.unpackBytesSync(
      BlobPointer.encode(make(binaryFields())),
      registry,
      ctx,
      "body",
    )
    expect(result).toBeInstanceOf(ValidationError)
    expect(((result as ValidationError).cause as Error).message).toContain("kind bytes")
  })

  it("a malformed pointer is a ValidationError naming the attribute", () => {
    for (const bytes of [
      new Uint8Array([0x40]),
      new Uint8Array([0x40, 1, 2]),
      BlobPointer.encode(make(fields())).subarray(0, 30),
      new Uint8Array([0x44, ...BlobPointer.MAGIC]),
      new Uint8Array([0x50, 1]),
    ]) {
      const result = PackedCodec.unpackBytesSync(bytes, registry, ctx, "body")
      expect(result).toBeInstanceOf(ValidationError)
      expect(((result as ValidationError).cause as Error).message).toContain(
        'Packed attribute "body"',
      )
    }
  })

  it("still rejects layout 011 and above", () => {
    for (const byte of [0x60, 0x61, 0x80, 0xe3, 0xff]) {
      const result = PackedCodec.unpackBytesSync(
        new Uint8Array([byte, 1, 2]),
        registry,
        ctx,
        "body",
      )
      expect(result).toBeInstanceOf(ValidationError)
      expect(((result as ValidationError).cause as Error).message).toContain(
        "newer effect-dynamodb",
      )
    }
  })

  it("unresolvedPointer names the attribute and the object version", () => {
    const pointer = make(fields())
    const error = PackedCodec.unresolvedPointer(ctx, "body", pointer)
    expect(error).toBeInstanceOf(ValidationError)
    expect(error).toMatchObject({ entityType: "Document", operation: "get" })
    const message = (error.cause as Error).message
    expect(message).toContain('Packed attribute "body"')
    expect(message).toContain(pointer.ref.key)
    expect(message).toContain(pointer.ref.version)
    expect(message).toContain("cannot resolve")
  })
})

describe("PackedCodec.isBase64PackedText — widened to I–X", () => {
  it("matches the base64 of every header byte of layouts 001 and 010", () => {
    for (let byte = 0x20; byte <= 0x5f; byte++) {
      for (const tail of [[], [0], [255, 255], [1, 2, 3, 4]]) {
        const encoded = Buffer.from([byte, ...tail]).toString("base64")
        expect(PackedCodec.isBase64PackedText(encoded)).toBe(true)
        expect("IJKLMNOPQRSTUVWX").toContain(encoded[0])
      }
    }
    // The writable pointer headers: json → Q, bytes → S.
    expect(Buffer.from([0x40]).toString("base64")[0]).toBe("Q")
    expect(Buffer.from([0x43]).toString("base64")[0]).toBe("Q")
    expect(Buffer.from([0x48]).toString("base64")[0]).toBe("S")
  })

  it("never matches JSON text, nor a layout 011+ value", () => {
    for (const value of [{}, [], "x", "Q", 0, -1, 12.5, true, false, null, { Q: 1 }, ["X"]]) {
      expect(PackedCodec.isBase64PackedText(JSON.stringify(value))).toBe(false)
    }
    for (const first of '{["-0123456789tfn') {
      expect(PackedCodec.isBase64PackedText(`${first}rest`)).toBe(false)
    }
    for (const byte of [0x00, 0x1f, 0x60, 0x80, 0xff]) {
      expect(PackedCodec.isBase64PackedText(Buffer.from([byte, 1]).toString("base64"))).toBe(false)
    }
    expect(PackedCodec.isBase64PackedText("")).toBe(false)
    expect(PackedCodec.isBase64PackedText("~edbp:SEVE")).toBe(false)
  })
})

describe("an S-form binary pointer through a pre-pointer reader", () => {
  it("a Uint8Array schema refuses the S text — it never decodes to the pointer's bytes", () => {
    const Record = Schema.Struct({ id: Schema.String, scan: Schema.Uint8Array })
    const s = BlobPointer.encodeText(make(binaryFields()))
    const exit = Schema.decodeUnknownExit(Record)({ id: "d-1", scan: s })
    expect(Exit.isFailure(exit)).toBe(true)
    // A B value of the same bytes is what a pre-pointer reader would pass through silently.
    const passthrough = Schema.decodeUnknownExit(Record)({
      id: "d-1",
      scan: BlobPointer.encode(make(binaryFields())),
    })
    expect(Exit.isSuccess(passthrough)).toBe(true)
  })
})
