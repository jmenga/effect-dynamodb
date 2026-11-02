/**
 * Object metadata of offloaded values (#179, design §4.6): the fields per
 * kind and codec, US-ASCII values, the 2 KB limit (`edd-item` while it fits,
 * `edd-item-sha256` otherwise) and the parser the store-wide sweep reads it
 * back with.
 */
import { createHash } from "node:crypto"
import { describe, expect, it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { crc64nvme } from "@effect-dynamodb/schema/internal/Crc64Nvme.js"
import * as KeyComposer from "@effect-dynamodb/schema/KeyComposer.js"
import { Base64, Base64Url } from "effect/encoding"
import {
  asciiValue,
  type BlobMetadataInput,
  build,
  fromAsciiValue,
  itemKeyBytes,
  Keys,
  MAX_METADATA_BYTES,
  metadataBytes,
  parse,
} from "../src/internal/BlobMetadata.js"

const checksum = { algorithm: "crc64nvme" as const, value: crc64nvme(new Uint8Array([1, 2, 3])) }

const input: BlobMetadataInput = {
  table: "documents",
  entity: "Document",
  attribute: "body",
  pk: { S: "$app#v1#document#d-1" },
  sk: { S: "$app#v1#document" },
  kind: "json",
  codec: "zstd",
  checksum,
}

describe("BlobMetadata", () => {
  describe("build", () => {
    it("writes every field of a compressed json value, in order", () => {
      const metadata = build(input)
      expect(Object.keys(metadata)).toEqual([
        "edd-v",
        "edd-table",
        "edd-entity",
        "edd-attr",
        "edd-item",
        "edd-kind",
        "edd-codec",
        "edd-checksum",
      ])
      expect(metadata).toMatchObject({
        "edd-v": "1",
        "edd-table": "documents",
        "edd-entity": "Document",
        "edd-attr": "body",
        "edd-kind": "json",
        "edd-codec": "zstd",
        "edd-checksum": Base64.encode(checksum.value),
      })
      const item = Base64Url.decode(metadata["edd-item"]!)
      expect(item._tag).toBe("Success")
      expect(new TextDecoder().decode(item._tag === "Success" ? item.success : undefined)).toBe(
        '["s:$app#v1#document#d-1","s:$app#v1#document"]',
      )
      expect(metadata["edd-item"]).not.toMatch(/=/)
    })

    it("writes no checksum for an uncompressed json value, and no codec for bytes", () => {
      const plain = build({ ...input, codec: "none" })
      expect(plain["edd-codec"]).toBe("none")
      expect(plain).not.toHaveProperty("edd-checksum")
      const bytes = build({ ...input, kind: "bytes", codec: "none", attribute: "scan" })
      expect(bytes["edd-kind"]).toBe("bytes")
      expect(bytes).not.toHaveProperty("edd-codec")
      expect(bytes).not.toHaveProperty("edd-checksum")
    })

    it("refuses a compressed bytes value", () => {
      expect(() => build({ ...input, kind: "bytes", codec: "gzip" })).toThrow(/never compressed/)
    })

    it("names an EventStore row by its stream member", () => {
      expect(build({ ...input, entity: "Ledger.event", attribute: "data" })["edd-entity"]).toBe(
        "Ledger.event",
      )
    })

    it("keeps every value US-ASCII", () => {
      const metadata = build({ ...input, entity: "Dökument 文書", attribute: "100%body" })
      for (const value of Object.values(metadata)) expect(value).toMatch(/^[\x21-\x7e]*$/)
      expect(metadata["edd-entity"]).toBe("D%C3%B6kument%20%E6%96%87%E6%9B%B8")
      expect(metadata["edd-attr"]).toBe("100%25body")
    })

    it("stays within 2 KB: edd-item while it fits, edd-item-sha256 beyond", () => {
      const base = metadataBytes(build({ ...input, sk: { S: "" } }))
      // edd-item grows 4 base64url characters per 3 bytes of canonical key.
      const room = MAX_METADATA_BYTES - base
      const fits = Math.floor(room / 4) * 3
      const atLimit = build({ ...input, sk: { S: "x".repeat(fits) } })
      expect(atLimit).toHaveProperty("edd-item")
      expect(metadataBytes(atLimit)).toBeLessThanOrEqual(MAX_METADATA_BYTES)
      const over = { ...input, sk: { S: "x".repeat(fits + 3) } }
      const hashed = build(over)
      expect(hashed).not.toHaveProperty("edd-item")
      expect(hashed["edd-item-sha256"]).toBe(
        createHash("sha256").update(itemKeyBytes(over.pk, over.sk)).digest("hex"),
      )
      expect(metadataBytes(hashed)).toBeLessThanOrEqual(MAX_METADATA_BYTES)
      expect(Object.keys(hashed)).toEqual([
        "edd-v",
        "edd-table",
        "edd-entity",
        "edd-attr",
        "edd-item-sha256",
        "edd-kind",
        "edd-codec",
        "edd-checksum",
      ])
    })

    it("counts metadata at or above S3's measure: header prefix, key and value bytes", () => {
      expect(metadataBytes({})).toBe(0)
      expect(metadataBytes({ "edd-v": "1" })).toBe("x-amz-meta-".length + "edd-v".length + 1)
      expect(metadataBytes({ a: "é" })).toBe("x-amz-meta-".length + 1 + 2)
    })
  })

  describe("asciiValue", () => {
    it("round-trips any well-formed text", () => {
      for (const text of ["Document", "a b", "%", "100%", "😀", "tab\there", "~!@#$^&*()", ""]) {
        expect(fromAsciiValue(asciiValue(text)), text).toBe(text)
      }
    })

    it("reads only what it writes", () => {
      for (const value of ["%4", "%zz", "%41", "%e2%82", "a b", "é"]) {
        expect(fromAsciiValue(value), value).toBeUndefined()
      }
    })
  })

  describe("parse", () => {
    it("reads back every kind of value", () => {
      for (const variant of [
        input,
        { ...input, codec: "none" as const },
        { ...input, kind: "bytes" as const, codec: "none" as const },
        { ...input, entity: "Dökument", pk: { N: "1.50" }, sk: { B: new Uint8Array([9, 8]) } },
      ]) {
        const parsed = parse(build(variant))
        if (typeof parsed === "string") throw new Error(parsed)
        expect(parsed.table).toBe(variant.table)
        expect(parsed.entity).toBe(variant.entity)
        expect(parsed.attribute).toBe(variant.attribute)
        expect(parsed.kind).toBe(variant.kind)
        expect(parsed.codec).toBe(variant.codec)
        expect(parsed.itemSha256).toBeUndefined()
        expect(itemKeyBytes(parsed.item!.pk, parsed.item!.sk)).toEqual(
          itemKeyBytes(variant.pk, variant.sk),
        )
        expect(parsed.checksum?.value).toEqual(
          variant.codec === "none" ? undefined : checksum.value,
        )
      }
    })

    it("round-trips edd-item for the key text the composer writes, raw text and bytes", () => {
      // Offloading requires escaped key text (design §11.10).
      const schema = DynamoSchema.make({ name: "app", version: 1, escapeKeys: true })
      const index: KeyComposer.IndexDefinition = {
        pk: { field: "pk", composite: ["caseId"] },
        sk: { field: "sk", composite: ["seq", "label"] },
      }
      const record = { caseId: -5, seq: -3.14, label: "a#b %c\u0000ü😀" }
      const composed = {
        pk: { S: KeyComposer.composePk(schema, "Doc", index, record) },
        sk: { S: KeyComposer.composeSk(schema, "Doc", 1, index, record) },
      }
      for (const key of [
        composed,
        { pk: { S: 'q"\\\u0000\u001f\u2028' }, sk: { S: "" } },
        { pk: { N: "-0.000120" }, sk: { B: new Uint8Array([0, 0xfb, 0xff]) } },
        { pk: { B: new Uint8Array(256).map((_, i) => i) }, sk: { N: "1e+3" } },
      ]) {
        const metadata = build({ ...input, ...key })
        expect(metadata["edd-item"]).toMatch(/^[A-Za-z0-9_-]+$/)
        expect(
          JSON.parse(Buffer.from(metadata["edd-item"]!, "base64url").toString("utf8")),
        ).toEqual(JSON.parse(new TextDecoder().decode(itemKeyBytes(key.pk, key.sk))))
        const parsed = parse(metadata)
        if (typeof parsed === "string") throw new Error(parsed)
        expect(itemKeyBytes(parsed.item!.pk, parsed.item!.sk)).toEqual(itemKeyBytes(key.pk, key.sk))
      }
      // Stored as the composer wrote it; numbers by their canonical text.
      const parsed = parse(build({ ...input, ...composed }))
      if (typeof parsed === "string") throw new Error(parsed)
      expect(parsed.item).toEqual(composed)
      const numeric = parse(build({ ...input, pk: { N: "-0.000120" }, sk: { N: "1e+3" } }))
      if (typeof numeric === "string") throw new Error(numeric)
      expect(numeric.item).toEqual({ pk: { N: "-12e-5" }, sk: { N: "1e3" } })
    })

    it("reads a hashed row key, and metadata keys in any case", () => {
      const metadata = build({ ...input, sk: { S: "x".repeat(2_000) } })
      const upper = Object.fromEntries(
        Object.entries(metadata).map(([key, value]) => [key.toUpperCase(), value]),
      )
      const parsed = parse(upper)
      if (typeof parsed === "string") throw new Error(parsed)
      expect(parsed.item).toBeUndefined()
      expect(parsed.itemSha256).toBe(metadata["edd-item-sha256"])
    })

    it("refuses metadata it did not write", () => {
      const good = build(input)
      const cases: ReadonlyArray<[Record<string, string>, RegExp]> = [
        [{}, /edd-v/],
        [{ ...good, [Keys.version]: "2" }, /edd-v/],
        [{ ...good, [Keys.table]: "" }, /edd-table/],
        [{ ...good, [Keys.entity]: "a b" }, /edd-entity/],
        [{ ...good, [Keys.attribute]: "%zz" }, /edd-attr/],
        [{ ...good, [Keys.kind]: "text" }, /edd-kind/],
        [{ ...good, [Keys.codec]: "lz4" }, /edd-codec/],
        [{ ...good, [Keys.checksum]: "AAAA" }, /edd-checksum/],
        [
          { ...build({ ...input, codec: "none" }), [Keys.checksum]: good["edd-checksum"]! },
          /uncompressed/,
        ],
        [{ ...build({ ...input, kind: "bytes", codec: "none" }), [Keys.codec]: "none" }, /bytes/],
        [{ ...good, [Keys.item]: Base64Url.encode('["s:a"]') }, /edd-item/],
        [{ ...good, [Keys.item]: Base64Url.encode('["s:a","x:b"]') }, /edd-item/],
        [{ ...good, [Keys.item]: Base64Url.encode('["n:1.0","s:b"]') }, /edd-item/],
        [{ ...good, [Keys.item]: "!!" }, /edd-item/],
        [{ ...good, [Keys.itemSha256]: "a".repeat(64) }, /exactly one/],
        [
          Object.fromEntries(Object.entries(good).filter(([key]) => key !== Keys.item)),
          /exactly one/,
        ],
        [{ ...good, [Keys.itemSha256]: "XYZ" }, /edd-item-sha256/],
      ]
      for (const [metadata, reason] of cases) {
        const parsed = parse(metadata)
        expect(typeof parsed, JSON.stringify(metadata)).toBe("string")
        expect(parsed as string).toMatch(reason)
      }
    })
  })
})
