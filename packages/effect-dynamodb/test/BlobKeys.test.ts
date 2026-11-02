/**
 * Object keys of offloaded values (#179, design §4.5): the three-level
 * SHA-256/128 derivation, `canon`, the family and partition prefixes, and the
 * properties GC relies on — fixed vectors (a stored key must never change
 * meaning), table-locality, and independence from Effect's `SecureRandom` and
 * `Digest` services.
 */
import { createHash } from "node:crypto"
import { describe, expect, it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import * as KeyComposer from "@effect-dynamodb/schema/KeyComposer.js"
import { Effect } from "effect"
import { Digest, SecureRandom } from "effect/crypto"
import {
  type BlobKeyTarget,
  canon,
  canonicalNumber,
  familyHash,
  familyPrefix,
  HASHED_KEY_BYTES,
  objectHash,
  objectKey,
  partitionHash,
  partitionPrefix,
  STREAM_FAMILY_SK,
} from "../src/internal/BlobKeys.js"

/** An independent implementation of §4.5 over Node's SHA-256. */
const reference = (parts: ReadonlyArray<string>): string => {
  const hash = createHash("sha256")
  parts.forEach((part, i) => {
    if (i > 0) hash.update(new Uint8Array([0]))
    hash.update(Buffer.from(part, "utf8"))
  })
  return hash.digest("hex").slice(0, 32)
}

const live: BlobKeyTarget = {
  table: "documents",
  pk: { S: "$app#v1#document#d-1" },
  familySk: { S: "$app#v1#document" },
  rowSk: { S: "$app#v1#document" },
  attribute: "body",
}

describe("BlobKeys", () => {
  describe("fixed vectors", () => {
    // A stored pointer names its key forever: these must never change.
    // Cross-checked against Python's hashlib over the §4.5 byte layout.
    it("derives the key of an entity's live row", () => {
      expect(objectKey("prod/", live)).toBe(
        "prod/eb59e32066f14814ca779d6caadd16b8/1868d65f6adeb96256caaf3d222afc19/" +
          "158918d95166374e5bfda1692e0146f2",
      )
    })

    it("derives the key of an EventStore event row", () => {
      expect(
        objectKey("", {
          table: "ledger",
          pk: { S: "$app#v1#stream#acct-1" },
          familySk: STREAM_FAMILY_SK,
          rowSk: { S: "$app#v1#stream#e#000000000001" },
          attribute: "data",
        }),
      ).toBe(
        "917720dd88b0773b22b5318d37d17857/e3586aaade1440edd37b07274ff130d5/" +
          "6ef6c3b9538dfdf976191888a79a0bb8",
      )
    })

    it("derives the key of number and binary key values", () => {
      const b = { B: new Uint8Array([0, 1, 2]) }
      expect(
        objectKey("", { table: "t", pk: { N: "42" }, familySk: b, rowSk: b, attribute: "x" }),
      ).toBe(
        "3ba560b681a32d0d636ca68808dfff21/055cfa100f3ceadc1972ce3cf5cb1689/" +
          "0edbb82959b4c1dadea2117b35f786c9",
      )
      // An equal number spelled differently keys the same object.
      expect(
        objectKey("", { table: "t", pk: { N: "042.0" }, familySk: b, rowSk: b, attribute: "x" }),
      ).toBe(objectKey("", { table: "t", pk: { N: "42" }, familySk: b, rowSk: b, attribute: "x" }))
    })
  })

  describe("structure", () => {
    it("matches an independent SHA-256 implementation at every level", () => {
      const P = reference(["edd-blob/1", "documents", "s:$app#v1#document#d-1"])
      const F = reference([P, "s:$app#v1#document"])
      const O = reference([F, "s:$app#v1#document", "body"])
      expect(partitionHash(live.table, live.pk)).toBe(P)
      expect(familyHash(P, live.familySk)).toBe(F)
      expect(objectHash(F, live.rowSk, live.attribute)).toBe(O)
      expect(objectKey("prod/", live)).toBe(`prod/${P}/${F}/${O}`)
    })

    it("is the prefix plus 98 bytes of lowercase hex segments", () => {
      const key = objectKey("prod/documents/", live)
      expect(key.length).toBe("prod/documents/".length + HASHED_KEY_BYTES)
      expect(HASHED_KEY_BYTES).toBe(98)
      expect(key.slice("prod/documents/".length)).toMatch(
        /^[0-9a-f]{32}\/[0-9a-f]{32}\/[0-9a-f]{32}$/,
      )
      expect(objectKey("", live)).toBe(key.slice("prod/documents/".length))
    })

    it("nests the object key under its family prefix, under its partition prefix", () => {
      const key = objectKey("p/", live)
      const family = familyPrefix("p/", live)
      const partition = partitionPrefix("p/", live)
      expect(key.startsWith(family)).toBe(true)
      expect(family.startsWith(partition)).toBe(true)
      expect(family.endsWith("/")).toBe(true)
      expect(partition.length).toBe("p/".length + 33)
      expect(family.length).toBe("p/".length + 66)
    })

    it("keys each attribute of a row separately", () => {
      expect(objectKey("", live)).not.toBe(objectKey("", { ...live, attribute: "scan" }))
    })

    it("keys a time-series event item in its current item's family, by its own SK", () => {
      const event = { ...live, rowSk: { S: "$app#v1#document#e#2026-11-01T00:00:00.000Z" } }
      expect(familyPrefix("", event)).toBe(familyPrefix("", live))
      expect(objectKey("", event)).not.toBe(objectKey("", live))
    })

    it("keys EventStore rows in the stream's family", () => {
      const event = {
        ...live,
        familySk: STREAM_FAMILY_SK,
        rowSk: { S: "e#000001" },
        attribute: "data",
      }
      const snapshot = { ...event, rowSk: { S: "s#latest" }, attribute: "state" }
      expect(familyPrefix("", event)).toBe(familyPrefix("", snapshot))
      expect(familyHash(partitionHash(live.table, live.pk), STREAM_FAMILY_SK)).toBe(
        reference([partitionHash(live.table, live.pk), "s:"]),
      )
    })

    it("puts the physical table name in the partition hash (GC is table-local)", () => {
      const restored = { ...live, table: "documents-restored" }
      expect(partitionHash(restored.table, restored.pk)).not.toBe(
        partitionHash(live.table, live.pk),
      )
      expect(familyPrefix("", restored)).not.toBe(familyPrefix("", live))
    })

    it("keeps P/F under a different prefix", () => {
      const a = objectKey("old/", live)
      const b = objectKey("new/prefix/", live)
      expect(a.slice("old/".length)).toBe(b.slice("new/prefix/".length))
    })

    it("hashes key text as UTF-8", () => {
      const pk = { S: "$app#v1#doc#ünïcødé-😀" }
      expect(partitionHash("t", pk)).toBe(reference(["edd-blob/1", "t", `s:${pk.S}`]))
    })

    it.effect("does not depend on any SecureRandom or Digest service in context", () =>
      Effect.sync(() => objectKey("p/", live)).pipe(
        Effect.provideService(
          SecureRandom.SecureRandom,
          SecureRandom.make((size) => new Uint8Array(size)),
        ),
        Effect.provideService(Digest.Digest, {
          digest: () => Effect.succeed(new Uint8Array(32)),
          digestHex: () => Effect.succeed("00".repeat(32)),
        }),
        Effect.map((key) => expect(key).toBe(objectKey("p/", live))),
      ),
    )
  })

  describe("key text the composer writes (`escapeKeys: true`, which offloading requires)", () => {
    // Numbers in their order-preserving text (`-5` → `-9999999999999994:`),
    // and U+0000–U+0025 of a composite escaped as `%XX` (`#` → `%23`,
    // space → `%20`, `%` → `%25`, U+0000 → `%00`); other text as it is.
    const schema = DynamoSchema.make({ name: "app", version: 1, escapeKeys: true })
    const schemaOff = DynamoSchema.make({ name: "app", version: 1, escapeKeys: false })
    const index: KeyComposer.IndexDefinition = {
      pk: { field: "pk", composite: ["caseId"] },
      sk: { field: "sk", composite: ["seq", "label"] },
    }
    const record = { caseId: -5, seq: -3.14, label: "a#b %c\u0000ü😀" }
    const pk = { S: KeyComposer.composePk(schema, "Doc", index, record) }
    const sk = { S: KeyComposer.composeSk(schema, "Doc", 1, index, record) }

    it("hashes the key text exactly as stored: escapes, sort-order numbers, non-ASCII", () => {
      expect(pk.S).toBe("$app#v1#doc#caseid_-9999999999999994:")
      expect(sk.S).toBe("$app#v1#doc#seq_-9999999999999996.85:#label_a%23b%20%25c%00ü😀")
      expect(canon(pk)).toBe(`s:${pk.S}`)
      expect(canon(sk)).toBe(`s:${sk.S}`)
      // Cross-checked against Python's hashlib over the §4.5 byte layout.
      expect(objectKey("", { table: "t", pk, familySk: sk, rowSk: sk, attribute: "body" })).toBe(
        "8dad60da95eb3c3278cbcb95f684fa9c/6c70e5f49024dba1ef6fde9d29f91d85/" +
          "674b6a46756911c0517c5c5830d2f394",
      )
      const P = reference(["edd-blob/1", "t", `s:${pk.S}`])
      expect(partitionHash("t", pk)).toBe(P)
      expect(familyHash(P, sk)).toBe(reference([P, `s:${sk.S}`]))
    })

    it("keys the text of `escapeKeys` off under another partition, so a pointer row never moves (design §11.10)", () => {
      const pkOff = { S: KeyComposer.composePk(schemaOff, "Doc", index, record) }
      expect(pkOff.S).toBe("$app#v1#doc#caseid_00000000000000-5")
      expect(partitionHash("t", pkOff)).toBe("de388d78e53489c2b10dd78789d7aa11")
      expect(partitionHash("t", pkOff)).not.toBe(partitionHash("t", pk))
    })

    it("keeps a row key holding U+0000 unambiguous", () => {
      // A composed key never holds it (escaped as `%00`); a raw key may. Only
      // the last part of each digest input may hold the separator, but the
      // row key in `O`, whose attribute name is refused if it holds one.
      const F = familyHash(partitionHash("t", { S: "p\u0000q" }), { S: "f" })
      expect(F).toBe(reference([reference(["edd-blob/1", "t", "s:p\u0000q"]), "s:f"]))
      expect(objectHash(F, { S: "a\u0000b" }, "c")).toBe(reference([F, "s:a\u0000b", "c"]))
      expect(objectHash(F, { S: "a\u0000b" }, "c")).not.toBe(objectHash(F, { S: "a" }, "bc"))
      expect(objectHash(F, { S: "a\u0000" }, "b")).not.toBe(objectHash(F, { S: "a" }, "b"))
    })

    it("writes binary key values in standard, padded base64", () => {
      expect(canon({ B: new Uint8Array([0xfb, 0xff]) })).toBe("b:+/8=")
      expect(canon({ B: new Uint8Array([0]) })).toBe("b:AA==")
      expect(canon({ B: new Uint8Array([]) })).toBe("b:")
      const all = new Uint8Array(256).map((_, i) => i)
      expect(canon({ B: all })).toBe(`b:${Buffer.from(all).toString("base64")}`)
    })
  })

  describe("canon", () => {
    it('tags each type, so S "1" and N 1 differ', () => {
      expect(canon({ S: "1" })).toBe("s:1")
      expect(canon({ N: "1" })).toBe("n:1e0")
      expect(canon({ B: new Uint8Array([1, 2, 3, 4]) })).toBe("b:AQIDBA==")
      expect(partitionHash("t", { S: "1" })).not.toBe(partitionHash("t", { N: "1" }))
    })

    it("gives equal numbers equal text, however they are spelled", () => {
      const spellings = ["1.5", "1.50", "01.5", "15e-1", "0.15E1", "+1.5", "150e-2", "1.5e0"]
      for (const spelling of spellings) expect(canonicalNumber(spelling)).toBe("15e-1")
      expect(canonicalNumber("100")).toBe("1e2")
      expect(canonicalNumber("0")).toBe("0")
      expect(canonicalNumber("-0.000")).toBe("0")
      expect(canonicalNumber("-12.3400")).toBe("-1234e-2")
      expect(canonicalNumber(".5")).toBe("5e-1")
      expect(canonicalNumber("5.")).toBe("5e0")
      expect(canonicalNumber("0.050")).toBe("5e-2")
    })

    it("refuses text that is not a number, and values of other types", () => {
      for (const text of ["", ".", "e5", "1e", "1.2.3", "abc", "1e99999999999999999999", " 1"]) {
        expect(() => canonicalNumber(text), text).toThrow(/BlobKeys/)
      }
      expect(() => canon({ BOOL: true } as never)).toThrow(/\{ S \}, \{ N \} or \{ B \}/)
      expect(() => canon({ S: 1 } as never)).toThrow()
    })

    it("refuses an empty table name and an attribute name holding the separator", () => {
      expect(() => partitionHash("", live.pk)).toThrow(/table name/)
      expect(() => objectHash("f", live.rowSk, "a\u0000b")).toThrow(/attribute name/)
      expect(() => objectHash("f", live.rowSk, "")).toThrow(/attribute name/)
    })
  })
})
