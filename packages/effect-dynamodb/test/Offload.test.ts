/**
 * `Offload` (#179, design §3.7): the lazy forms of offloaded values —
 * `OffloadedValue` and `BlobHandle` — their guards, constructors (the read
 * path's), equality and inspection, and the module's barrel export.
 */
import { describe, expect, it } from "@effect/vitest"
import { crc64nvme } from "@effect-dynamodb/schema/internal/Crc64Nvme.js"
import { Effect, Equal, Hash, Option, Stream } from "effect"
import * as Barrel from "../src/index.js"
import {
  type BlobHandleFields,
  makeBlobHandle,
  makeOffloadedValue,
} from "../src/internal/OffloadValues.js"
import * as Offload from "../src/Offload.js"

const checksumOf = (text: string) => ({
  algorithm: "crc64nvme" as const,
  value: crc64nvme(new TextEncoder().encode(text)),
})

const handleFields = (overrides: Partial<BlobHandleFields> = {}): BlobHandleFields => ({
  location: "external",
  ref: Option.some({ key: "p/F/O", version: "v1" }),
  size: 5,
  contentType: "image/png",
  checksum: checksumOf("hello"),
  read: () => Effect.succeed(new TextEncoder().encode("hello")),
  stream: () => Stream.make(new TextEncoder().encode("hello")),
  presignedUrl: () => Effect.succeed("memory://p/F/O?versionId=v1"),
  ...overrides,
})

describe("Offload", () => {
  it("is exported from the barrel", () => {
    expect(Barrel.Offload).toBe(Offload)
    expect(Offload.isBlobHandle).toBeTypeOf("function")
    expect(Offload.isOffloadedValue).toBeTypeOf("function")
    expect(typeof Offload.BlobHandleTypeId).toBe("symbol")
    expect(typeof Offload.OffloadedValueTypeId).toBe("symbol")
  })

  describe("BlobHandle", () => {
    it.effect("carries its fields and reads through its functions", () =>
      Effect.gen(function* () {
        const handle = makeBlobHandle(handleFields())
        expect(Offload.isBlobHandle(handle)).toBe(true)
        expect(Offload.isOffloadedValue(handle)).toBe(false)
        expect(handle.location).toBe("external")
        expect(Option.getOrThrow(handle.ref)).toEqual({ key: "p/F/O", version: "v1" })
        expect(handle.size).toBe(5)
        expect(handle.contentType).toBe("image/png")
        expect(new TextDecoder().decode(yield* handle.read())).toBe("hello")
        expect((yield* Stream.runCollect(handle.stream())).length).toBe(1)
        expect(yield* handle.presignedUrl()).toBe("memory://p/F/O?versionId=v1")
      }),
    )

    it("is equal by location and ref when external", () => {
      const a = makeBlobHandle(handleFields())
      const sameRef = makeBlobHandle(handleFields({ size: 99, checksum: checksumOf("other") }))
      const otherVersion = makeBlobHandle(
        handleFields({ ref: Option.some({ key: "p/F/O", version: "v2" }) }),
      )
      const otherKey = makeBlobHandle(
        handleFields({ ref: Option.some({ key: "p/F/X", version: "v1" }) }),
      )
      expect(Equal.equals(a, sameRef)).toBe(true)
      expect(Hash.hash(a)).toBe(Hash.hash(sameRef))
      expect(Equal.equals(a, otherVersion)).toBe(false)
      expect(Equal.equals(a, otherKey)).toBe(false)
    })

    it("is equal by content checksum and size when inline", () => {
      const inline = (text: string, size = text.length) =>
        makeBlobHandle(
          handleFields({
            location: "inline",
            ref: Option.none(),
            size,
            checksum: checksumOf(text),
          }),
        )
      expect(Equal.equals(inline("hello"), inline("hello"))).toBe(true)
      expect(Hash.hash(inline("hello"))).toBe(Hash.hash(inline("hello")))
      expect(Equal.equals(inline("hello"), inline("world"))).toBe(false)
      expect(Equal.equals(inline("hello"), inline("hello", 6))).toBe(false)
      // An inline value never equals an external one, even with the same content.
      expect(Equal.equals(inline("hello"), makeBlobHandle(handleFields()))).toBe(false)
      expect(Equal.equals(inline("hello"), { location: "inline" })).toBe(false)
    })

    it("refuses a location that does not match its ref", () => {
      expect(() => makeBlobHandle(handleFields({ ref: Option.none() }))).toThrow(
        /external value has a ref/,
      )
      expect(() => makeBlobHandle(handleFields({ location: "inline" }))).toThrow(/inline one none/)
      expect(() => makeBlobHandle(handleFields({ location: "elsewhere" as never }))).toThrow(
        /location/,
      )
    })

    it("does not alias its caller's ref or checksum, and is frozen", () => {
      const checksum = checksumOf("hello")
      const ref = { key: "p/F/O", version: "v1" }
      const handle = makeBlobHandle(handleFields({ ref: Option.some(ref), checksum }))
      checksum.value[0] = (checksum.value[0]! + 1) % 256
      ;(ref as { version: string }).version = "changed"
      expect(handle.checksum.value).toEqual(checksumOf("hello").value)
      expect(Option.getOrThrow(handle.ref).version).toBe("v1")
      expect(Object.isFrozen(handle)).toBe(true)
    })

    it("inspects as its location, ref, size, content type and hex checksum", () => {
      const handle = makeBlobHandle(handleFields())
      expect(handle.toJSON()).toEqual({
        _id: "BlobHandle",
        location: "external",
        ref: { key: "p/F/O", version: "v1" },
        size: 5,
        checksum: {
          algorithm: "crc64nvme",
          value: Buffer.from(checksumOf("hello").value).toString("hex"),
        },
        contentType: "image/png",
      })
      expect(String(handle)).toContain("BlobHandle")
    })

    it("is pipeable", () => {
      expect(makeBlobHandle(handleFields()).pipe((h) => h.size)).toBe(5)
    })
  })

  describe("OffloadedValue", () => {
    it.effect("carries its fields and reads through its function", () =>
      Effect.gen(function* () {
        const value = makeOffloadedValue<{ readonly text: string }>({
          location: "inline",
          ref: Option.none(),
          size: 15,
          checksum: checksumOf('{"text":"hi"}'),
          read: () => Effect.succeed({ text: "hi" }),
        })
        expect(Offload.isOffloadedValue(value)).toBe(true)
        expect(Offload.isBlobHandle(value)).toBe(false)
        expect(value.location).toBe("inline")
        expect(Option.isNone(value.ref)).toBe(true)
        expect(yield* value.read()).toEqual({ text: "hi" })
        expect(value.toJSON()).toMatchObject({
          _id: "OffloadedValue",
          location: "inline",
          size: 15,
        })
        expect(value.pipe((v) => v.size)).toBe(15)
      }),
    )

    it("refuses a location that does not match its ref", () => {
      expect(() =>
        makeOffloadedValue({
          location: "external",
          ref: Option.none(),
          size: 1,
          checksum: checksumOf("x"),
          read: () => Effect.succeed(1),
        }),
      ).toThrow(/external value has a ref/)
    })
  })

  describe("guards", () => {
    it("are never true of plain or parsed JSON values", () => {
      for (const value of [
        null,
        undefined,
        1,
        "x",
        {},
        { location: "external" },
        JSON.parse('{"a":1}'),
      ]) {
        expect(Offload.isBlobHandle(value)).toBe(false)
        expect(Offload.isOffloadedValue(value)).toBe(false)
      }
    })
  })
})
