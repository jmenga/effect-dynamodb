/**
 * `internal/Digest.ts`'s SHA-256 against `node:crypto`'s, over the same bytes (a string's UTF-16
 * code units, high byte first), at every length around a block's padding boundaries, and over the
 * characters a key or a row can hold.
 */
import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { digest, sha256Words } from "../src/internal/Digest.js"

const reference = (text: string): string =>
  createHash("sha256").update(Buffer.from(text, "utf16le").swap16()).digest("hex")

const hexOf = (words: Int32Array): string =>
  Array.from(words, (word) => (word >>> 0).toString(16).padStart(8, "0")).join("")

describe("digest", () => {
  it("is SHA-256 of the UTF-16BE code units, at every length up to three blocks", () => {
    for (let length = 0; length <= 100; length++) {
      const text = Array.from({ length }, (_, i) => String.fromCharCode(0x41 + (i % 26))).join("")
      expect(hexOf(sha256Words(text)), `length ${length}`).toBe(reference(text))
    }
  })

  it("is SHA-256 over NUL, control characters, surrogates and a lone surrogate", () => {
    for (const text of [
      "\u0000",
      "a\u0000b",
      "$app#v1#item#id_a%20b",
      "\u{1F600} x",
      "\ud800",
      "x\udfff",
      "￿\u0000￿",
    ]) {
      expect(hexOf(sha256Words(text)), JSON.stringify(text)).toBe(reference(text))
    }
  })

  it("is SHA-256 of a text as long as a 400 KB row's", () => {
    const text = "éx".repeat(200_000)
    expect(hexOf(sha256Words(text))).toBe(reference(text))
  })

  it("covers the whole text: one code unit changed anywhere gives another digest", () => {
    // What the journal keys by (DESIGN.md "A digest stands for its text"): a long key, as a unit's
    // identity text, changed at each position in turn, a lone surrogate included.
    const text = JSON.stringify(["Item", "row", `$app#v1#item#${"id_a%20b".repeat(40)}`, "$app#v1"])
    const seen = new Set([digest(text)])
    for (let at = 0; at < text.length; at++) {
      for (const unit of ["\u0000", "\ud800", String.fromCharCode(text.charCodeAt(at) ^ 1)]) {
        const changed = text.slice(0, at) + unit + text.slice(at + 1)
        if (changed === text) continue
        expect(seen.has(digest(changed)), `at ${at}`).toBe(false)
        seen.add(digest(changed))
      }
    }
    expect(seen.has(digest(`${text} `))).toBe(false)
  })

  it("is the first 128 bits, as eight code units", () => {
    for (const text of ["", "a", "a\u0000b", "\ud800"]) {
      const full = reference(text)
      const short = Array.from(digest(text), (unit) =>
        unit.charCodeAt(0).toString(16).padStart(4, "0"),
      ).join("")
      expect(digest(text)).toHaveLength(8)
      expect(short).toBe(full.slice(0, 32))
    }
  })
})
