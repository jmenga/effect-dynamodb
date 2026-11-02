/**
 * The vendored SHA-256 (#179 §4.5): the FIPS 180-4 example vectors (NIST's
 * published `abc`, empty, 448-bit, 896-bit and one-million-`a` messages), the
 * padding boundaries, incremental updates over arbitrary chunkings and views,
 * agreement with Web Crypto's `subtle.digest` over random inputs, and with
 * node:crypto past 512 MiB, where the bit length reaches its high word.
 */

import { createHash } from "node:crypto"
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import * as Sha256 from "../src/internal/Sha256.js"
import { ascii, chunk, hex, seeded } from "./helpers/Bytes.js"

const webCryptoSha256 = (bytes: Uint8Array): Effect.Effect<string, unknown> =>
  Effect.tryPromise({
    try: () => globalThis.crypto.subtle.digest("SHA-256", Uint8Array.from(bytes)),
    catch: (cause) => cause,
  }).pipe(Effect.map((digest) => hex(new Uint8Array(digest))))

describe("Sha256", () => {
  it("matches the FIPS 180-4 example vectors", () => {
    const vectors: ReadonlyArray<readonly [string, string]> = [
      ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
      ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
      [
        "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
        "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
      ],
      [
        "abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu",
        "cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1",
      ],
    ]
    for (const [message, expected] of vectors) {
      const digest = Sha256.sha256(ascii(message))
      expect(digest.length).toBe(Sha256.SHA256_BYTES)
      expect(hex(digest), JSON.stringify(message)).toBe(expected)
    }
  })

  it("matches the one-million-a vector, fed in uneven pieces", () => {
    const expected = "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"
    expect(hex(Sha256.sha256(new Uint8Array(1_000_000).fill(0x61)))).toBe(expected)
    const piece = new Uint8Array(997).fill(0x61)
    const hasher = Sha256.make()
    let fed = 0
    while (fed + piece.length <= 1_000_000) {
      hasher.update(piece)
      fed += piece.length
    }
    hasher.update(piece.subarray(0, 1_000_000 - fed))
    expect(hex(hasher.digest())).toBe(expected)
  })

  it("writes the length's high word from 512 MiB on", { timeout: 60_000 }, () => {
    // The 64-bit bit length is written as two 32-bit words, and the high word
    // is nonzero only from 2^29 bytes (512 MiB) on. A reused 1 MiB buffer is
    // fed to both hashers, and the digests are compared just below, exactly at
    // and past that boundary (the last ending off a block boundary). Web
    // Crypto is one-shot, so node:crypto's incremental hash is the reference.
    const mib = 1024 * 1024
    const buffer = seeded(0x29).bytes(mib)
    const vendored = Sha256.make()
    const reference = createHash("sha256")
    const feed = (bytes: Uint8Array): void => {
      vendored.update(bytes)
      reference.update(bytes)
    }
    const check = (label: string): void => {
      expect(hex(vendored.digest()), label).toBe(reference.copy().digest("hex"))
    }
    for (let i = 0; i < 511; i++) feed(buffer)
    feed(buffer.subarray(0, mib - 1))
    check("2^29 - 1 bytes")
    feed(buffer.subarray(mib - 1))
    check("2^29 bytes")
    feed(buffer)
    feed(buffer.subarray(0, 12_345))
    check("2^29 + 1 MiB + 12,345 bytes")
  })

  it.effect("agrees with Web Crypto at every padding boundary", () =>
    Effect.gen(function* () {
      // 55 / 56 bytes: the length still fits the final block / needs a second;
      // 63 / 64 / 65: around one full block; and the same a block later.
      const random = seeded(0x256)
      for (const length of [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129]) {
        const bytes = random.bytes(length)
        expect(hex(Sha256.sha256(bytes)), `length ${length}`).toBe(yield* webCryptoSha256(bytes))
      }
    }),
  )

  it.effect("agrees with Web Crypto over random inputs", () =>
    Effect.gen(function* () {
      const random = seeded(0x179)
      for (let run = 0; run < 100; run++) {
        const bytes = random.bytes(random.int(2048))
        expect(hex(Sha256.sha256(bytes)), `run ${run}`).toBe(yield* webCryptoSha256(bytes))
      }
    }),
  )

  it("gives the one-shot digest for any chunking", () => {
    const random = seeded(64)
    for (let run = 0; run < 100; run++) {
      const bytes = random.bytes(random.int(400))
      const expected = hex(Sha256.sha256(bytes))
      for (const maxChunk of [1, 5, 63, 64, 65, 200]) {
        const hasher = Sha256.make()
        for (const piece of chunk(bytes, maxChunk, random)) hasher.update(piece)
        expect(hex(hasher.digest()), `run ${run}, chunks ≤ ${maxChunk}`).toBe(expected)
      }
    }
  })

  it("reads only the view it is given", () => {
    const random = seeded(42)
    const buffer = random.bytes(300)
    const view = buffer.subarray(17, 17 + 150)
    expect(hex(Sha256.sha256(view))).toBe(hex(Sha256.sha256(Uint8Array.from(view))))
  })

  it("does not end the computation on digest, and returns a fresh array each time", () => {
    const hasher = Sha256.make().update(ascii("ab"))
    const first = hasher.digest()
    expect(hex(first)).toBe(hex(Sha256.sha256(ascii("ab"))))
    first.fill(0)
    expect(hex(hasher.digest())).toBe(hex(Sha256.sha256(ascii("ab"))))
    hasher.update(ascii("c"))
    expect(hex(hasher.digest())).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    )
  })

  it("keeps hashers independent", () => {
    const a = Sha256.make().update(ascii("a"))
    const b = Sha256.make().update(ascii("xyz"))
    a.update(ascii("bc"))
    expect(hex(a.digest())).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    expect(hex(b.digest())).toBe(hex(Sha256.sha256(ascii("xyz"))))
  })
})
