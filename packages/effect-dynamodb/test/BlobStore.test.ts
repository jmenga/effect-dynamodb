/**
 * `BlobStore` (#179, design §3.6, §12): the service and its layers, the
 * `[EDD-9116]` checks a store passes before the library uses it, the
 * CRC-64/NVME re-export, and the in-memory store — both versioning modes,
 * every capability, S3-like validation, `TestClock`-driven `lastModified`,
 * fault injection and `inspect()`.
 */
import { existsSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "@effect/vitest"
import { crc64nvme as crc } from "@effect-dynamodb/schema/internal/Crc64Nvme.js"
import {
  Cause,
  Clock,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Random,
  Stream,
} from "effect"
import { TestClock } from "effect/testing"
import {
  type BlobPutRequest,
  type BlobRef,
  BlobStore,
  BlobStoreFailure,
  type BlobStoreService,
  type MemoryBlobCall,
  type MemoryBlobFault,
} from "../src/BlobStore.js"
import * as Barrel from "../src/index.js"
import { build as buildMetadata } from "../src/internal/BlobMetadata.js"
import { MAX_KEY_SUFFIX_BYTES } from "../src/internal/BlobStoreContract.js"
import { compareUtf8 } from "../src/internal/MemoryBlobStore.js"

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text)

const request = (
  key: string,
  body: Uint8Array | Stream.Stream<Uint8Array, never>,
  overrides: Partial<BlobPutRequest> = {},
): BlobPutRequest => {
  const all = body instanceof Uint8Array ? body : undefined
  return {
    key,
    body: body as BlobPutRequest["body"],
    contentLength: all?.length,
    checksum:
      all === undefined
        ? Effect.die("the test computes stream checksums explicitly")
        : Effect.succeed({ algorithm: "crc64nvme", value: crc(all) }),
    contentType: "application/octet-stream",
    metadata: { "edd-v": "1" },
    ...overrides,
  }
}

const collect = (stream: Stream.Stream<Uint8Array, BlobStoreFailure>) =>
  Effect.map(Stream.runCollect(stream), (chunks) => {
    const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
    let at = 0
    for (const chunk of chunks) {
      out.set(chunk, at)
      at += chunk.length
    }
    return out
  })

const failureOf = (exit: Exit.Exit<unknown, BlobStoreFailure>): BlobStoreFailure => {
  if (Exit.isSuccess(exit)) throw new Error("expected a failure")
  const error = Cause.findErrorOption(exit.cause)
  if (Option.isNone(error)) throw new Error(`expected a Fail, got ${Cause.pretty(exit.cause)}`)
  return error.value
}

const isInterrupted = <A, E>(exit: Exit.Exit<A, E>): boolean =>
  Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)

const custom = (overrides: Record<string, unknown> = {}): BlobStoreService =>
  ({
    name: "custom://",
    prefix: "",
    limits: { maxVersionBytes: 1_024, maxKeySuffixBytes: 0 },
    maxUploadAge: Duration.hours(1),
    readConcurrency: 4,
    writeConcurrency: 2,
    put: () => Effect.die("unused"),
    get: () => Stream.empty,
    delete: () => Effect.void,
    ...overrides,
  }) as BlobStoreService

/** Every module the blob store and offload modules reach, and what each imports. */
const importGraph = (entries: ReadonlyArray<string>): Map<string, ReadonlyArray<string>> => {
  const src = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src")
  const graph = new Map<string, ReadonlyArray<string>>()
  const queue = entries.map((entry) => join(src, entry))
  while (queue.length > 0) {
    const file = queue.pop()!
    if (graph.has(file) || !existsSync(file)) continue
    const code = readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
    const specifiers = [...code.matchAll(/(?:from|import)\s*\(?\s*["'`]([^"'`]+)["'`]/g)].map(
      (m) => m[1]!,
    )
    graph.set(file, specifiers)
    for (const spec of specifiers) {
      if (spec.startsWith(".")) queue.push(resolve(dirname(file), spec).replace(/\.js$/, ".ts"))
    }
  }
  return graph
}

describe("BlobStore", () => {
  it("is runtime-neutral: no Node builtin and no AWS SDK in its import graph", () => {
    const graph = importGraph(["BlobStore.ts", "Offload.ts"])
    expect(graph.size).toBeGreaterThanOrEqual(7)
    const offenders = [...graph].flatMap(([file, specifiers]) =>
      specifiers
        .filter((spec) => spec.startsWith("node:") || spec.startsWith("@aws-sdk/"))
        .map((spec) => `${file} -> ${spec}`),
    )
    expect(offenders).toEqual([])
  })

  describe("service", () => {
    it.effect("BlobStore.layer provides the store", () =>
      Effect.gen(function* () {
        const service = custom()
        const resolved = yield* Effect.provide(
          Effect.serviceOption(BlobStore),
          BlobStore.layer(service),
        )
        expect(Option.getOrUndefined(resolved)).toBe(service)
        // Absent, it is simply absent: no operation gains an R.
        expect(Option.isNone(yield* Effect.serviceOption(BlobStore))).toBe(true)
      }),
    )

    it.effect("BlobStore.layerMemory provides a fresh memory store", () =>
      Effect.gen(function* () {
        const store = yield* Effect.provide(
          Effect.service(BlobStore),
          BlobStore.layerMemory({ prefix: "t/" }),
        )
        expect(store.name).toBe("memory://t/")
        expect(store.prefix).toBe("t/")
      }),
    )

    it("re-exports CRC-64/NVME for store implementers", () => {
      expect(Buffer.from(BlobStore.crc64nvme(bytesOf("123456789"))).toString("hex")).toBe(
        "ae8b14860a799888",
      )
      const hasher = BlobStore.crc64nvme.make().update(bytesOf("1234")).update(bytesOf("56789"))
      expect(hasher.digest()).toEqual(BlobStore.crc64nvme(bytesOf("123456789")))
    })

    it("is exported from the barrel", () => {
      expect(Barrel.BlobStore).toBe(BlobStore)
      expect(Barrel.BlobStoreFailure).toBe(BlobStoreFailure)
    })

    it("BlobStoreFailure names its reason, ref and cause", () => {
      const failure = new BlobStoreFailure({
        reason: "NotFound",
        ref: { key: "k", version: "v1" },
        cause: new Error("NoSuchVersion"),
      })
      expect(failure._tag).toBe("BlobStoreFailure")
      expect(failure.message).toBe(
        'blob store failure (NotFound) for object "k" version "v1": NoSuchVersion',
      )
      expect(new BlobStoreFailure({ reason: "Throttled", cause: "SlowDown" }).message).toBe(
        "blob store failure (Throttled): SlowDown",
      )
    })
  })

  describe("[EDD-9116] store checks", () => {
    it("accepts a minimal custom store, and capabilities when they are functions", () => {
      expect(() => BlobStore.layer(custom())).not.toThrow()
      expect(() =>
        BlobStore.layer(
          custom({
            copy: () => Effect.die(""),
            list: () => Stream.empty,
            head: () => Effect.succeed({}),
            presign: () => Effect.succeed(""),
            marks: {
              get: () => Effect.succeed(Option.none()),
              set: () => Effect.void,
              clear: () => Effect.void,
            },
            limits: { maxVersionBytes: 0, maxKeySuffixBytes: MAX_KEY_SUFFIX_BYTES },
          }),
        ),
      ).not.toThrow()
    })

    it("refuses invalid limits, ages, concurrencies, prefixes and operations", () => {
      const cases: ReadonlyArray<[Record<string, unknown> | null, RegExp]> = [
        [null, /must be an object/],
        [{ name: "" }, /name/],
        [{ prefix: "/abs" }, /prefix must not start with "\/"/],
        [{ prefix: "p".repeat(257) }, /257 UTF-8 bytes/],
        [{ prefix: "\ud800" }, /well-formed/],
        [{ prefix: 7 }, /prefix/],
        [{ limits: undefined }, /limits must be/],
        [{ limits: { maxVersionBytes: -1, maxKeySuffixBytes: 0 } }, /maxVersionBytes/],
        [{ limits: { maxVersionBytes: 1.5, maxKeySuffixBytes: 0 } }, /maxVersionBytes/],
        [{ limits: { maxVersionBytes: 1_025, maxKeySuffixBytes: 0 } }, /maxVersionBytes/],
        [
          { limits: { maxVersionBytes: 0, maxKeySuffixBytes: MAX_KEY_SUFFIX_BYTES + 1 } },
          /maxKeySuffixBytes/,
        ],
        [{ maxUploadAge: 3_600_000 }, /maxUploadAge/],
        [{ maxUploadAge: Duration.zero }, /maxUploadAge/],
        [{ maxUploadAge: Duration.infinity }, /maxUploadAge/],
        [{ readConcurrency: 0 }, /readConcurrency/],
        [{ writeConcurrency: 2.5 }, /writeConcurrency/],
        [{ put: undefined }, /put must be a function/],
        [{ get: "x" }, /get must be a function/],
        [{ delete: undefined }, /delete must be a function/],
        [{ list: {} }, /list must be a function/],
        [{ marks: { get: () => Effect.void } }, /marks must be/],
      ]
      for (const [overrides, message] of cases) {
        const service = overrides === null ? null : custom(overrides)
        expect(
          () => BlobStore.layer(service as BlobStoreService),
          JSON.stringify(overrides),
        ).toThrow(/\[EDD-9116\] BlobStore\.layer:/)
        expect(() => BlobStore.layer(service as BlobStoreService)).toThrow(message)
      }
    })

    it("MAX_KEY_SUFFIX_BYTES leaves room for the longest prefix and the hashed key", () => {
      expect(MAX_KEY_SUFFIX_BYTES).toBe(1_024 - 256 - 98)
    })

    it("refuses invalid memory-store options", () => {
      const cases: ReadonlyArray<[unknown, RegExp]> = [
        [{ bogus: 1 }, /unknown option "bogus"/],
        [{ versioning: "suspended" }, /versioning/],
        [{ prefix: "/x" }, /prefix/],
        [{ presign: "yes" }, /presign/],
        [{ maxVersionBytes: 31 }, /maxVersionBytes must be an integer from 32/],
        [{ maxVersionBytes: 1_025 }, /maxVersionBytes/],
        [
          { versioning: "keyPerWrite", maxVersionBytes: -1 },
          /maxVersionBytes must be an integer from 0/,
        ],
        [{ maxUploadAge: "59 seconds" }, /maxUploadAge/],
        [{ maxUploadAge: "8 days" }, /maxUploadAge/],
        [{ maxUploadAge: "soon" }, /maxUploadAge/],
        [{ readConcurrency: 0 }, /readConcurrency/],
        [{ writeConcurrency: -1 }, /writeConcurrency/],
        [{ readChunkBytes: 0 }, /readChunkBytes/],
        [{ partSize: 0 }, /partSize/],
        [{ partSize: 1.5 }, /partSize/],
        [{ maxParts: 0 }, /maxParts/],
        [{ uploadConcurrency: 0 }, /uploadConcurrency/],
        [{ partAttempts: -1 }, /partAttempts/],
        [{ clock: {} }, /clock/],
        [{ failures: 1 }, /failures/],
      ]
      for (const [options, message] of cases) {
        expect(() => BlobStore.memory(options as never), JSON.stringify(options)).toThrow(
          /\[EDD-9116\] BlobStore\.memory:/,
        )
        expect(() => BlobStore.memory(options as never)).toThrow(message)
      }
      expect(() => BlobStore.layerMemory({ versioning: "nope" as never })).toThrow(/EDD-9116/)
    })

    it("accepts the documented bounds of memory-store options", () => {
      expect(BlobStore.memory({ maxUploadAge: "1 minute" }).maxUploadAge).toEqual(
        Duration.minutes(1),
      )
      expect(BlobStore.memory({ maxUploadAge: "7 days" }).maxUploadAge).toEqual(Duration.days(7))
      expect(BlobStore.memory({ maxVersionBytes: 1_024 }).limits.maxVersionBytes).toBe(1_024)
    })
  })

  describe("memory store", () => {
    it("has the documented defaults", () => {
      const store = BlobStore.memory()
      expect(store.name).toBe("memory://")
      expect(store.prefix).toBe("")
      expect(store.limits).toEqual({ maxVersionBytes: 32, maxKeySuffixBytes: 0 })
      expect(store.maxUploadAge).toEqual(Duration.hours(1))
      expect(store.readConcurrency).toBe(16)
      expect(store.writeConcurrency).toBe(8)
      expect(store.presign).toBeUndefined()
      expect(typeof store.copy).toBe("function")
      expect(typeof store.list).toBe("function")
      expect(typeof store.head).toBe("function")
      expect(typeof store.marks.get).toBe("function")
      const perWrite = BlobStore.memory({ versioning: "keyPerWrite" })
      expect(perWrite.limits).toEqual({ maxVersionBytes: 0, maxKeySuffixBytes: 27 })
    })

    describe("versioned", () => {
      it.effect("puts new versions of a stable key and gets each back", () =>
        Effect.gen(function* () {
          const store = BlobStore.memory()
          const v1 = yield* store.put(request("p/k", bytesOf("first")))
          const v2 = yield* store.put(request("p/k", bytesOf("second, longer")))
          expect(v1.ref.key).toBe("p/k")
          expect(v2.ref.key).toBe("p/k")
          expect(v1.ref.version).toMatch(/^[0-9a-f]{32}$/)
          expect(v2.ref.version).not.toBe(v1.ref.version)
          expect(v1.size).toBe(5)
          expect(new TextDecoder().decode(yield* collect(store.get(v1.ref)))).toBe("first")
          expect(new TextDecoder().decode(yield* collect(store.get(v2.ref)))).toBe("second, longer")
          const versions = store.inspect().versions
          expect(versions.map((v) => [v.ref.version, v.isLatest])).toEqual([
            [v2.ref.version, true],
            [v1.ref.version, false],
          ])
          expect(versions[0]!.bytes).toEqual(bytesOf("second, longer"))
          expect(versions[0]!.contentType).toBe("application/octet-stream")
        }),
      )

      it.effect("makes reproducible version ids under Random.withSeed", () =>
        Effect.gen(function* () {
          const put = Effect.suspend(() => BlobStore.memory().put(request("k", bytesOf("x")))).pipe(
            Effect.map((r) => r.ref.version),
          )
          const a = yield* put.pipe(Random.withSeed("seed"))
          const b = yield* put.pipe(Random.withSeed("seed"))
          expect(a).toBe(b)
        }),
      )

      it.effect("consumes a Stream body and checks it against the request's checksum", () =>
        Effect.gen(function* () {
          const store = BlobStore.memory()
          const parts = [bytesOf("ab"), bytesOf("cd"), bytesOf("e")]
          const all = bytesOf("abcde")
          const result = yield* store.put(
            request("k", Stream.fromIterable(parts), {
              contentLength: undefined,
              checksum: Effect.succeed({ algorithm: "crc64nvme", value: crc(all) }),
            }),
          )
          expect(result.size).toBe(5)
          expect(yield* collect(store.get(result.ref))).toEqual(all)

          const mismatch = yield* Effect.exit(
            store.put(
              request("k", Stream.fromIterable(parts), {
                contentLength: undefined,
                checksum: Effect.succeed({ algorithm: "crc64nvme", value: crc(bytesOf("abcdf")) }),
              }),
            ),
          )
          expect(failureOf(mismatch).reason).toBe("ChecksumMismatch")
          expect(store.inspect().versions).toHaveLength(1)
        }),
      )

      it.effect("lets a source failure through as its own failure", () =>
        Effect.gen(function* () {
          const store = BlobStore.memory()
          const source = new BlobStoreFailure({ reason: "SourceFailed", cause: "boom" })
          const exit = yield* Effect.exit(
            store.put(
              request("k", Stream.concat(Stream.make(bytesOf("a")), Stream.fail(source)) as never, {
                contentLength: undefined,
                checksum: Effect.die("unreachable"),
              }),
            ),
          )
          expect(failureOf(exit)).toBe(source)
          expect(store.inspect().versions).toHaveLength(0)
        }),
      )

      it.effect("refuses what S3 refuses", () =>
        Effect.gen(function* () {
          const store = BlobStore.memory()
          const body = bytesOf("x")
          const refusals: ReadonlyArray<[BlobPutRequest, RegExp]> = [
            [request("", body), /non-empty/],
            [request("k".repeat(1_025), body), /1025 UTF-8 bytes/],
            [request("k", body, { contentLength: 2 }), /contentLength is 2/],
            [request("k", body, { contentType: "" }), /contentType/],
            [
              request("k", body, { contentType: "text/plain\r\nX-Injected: 1" }),
              /contentType must be a non-empty printable US-ASCII string/,
            ],
            [request("k", body, { contentType: "text/é" }), /printable US-ASCII/],
            [request("k", body, { metadata: { "edd-attr": "dök" } }), /US-ASCII/],
            [request("k", body, { metadata: { big: "x".repeat(2_048) } }), /over S3's 2048-byte/],
            [request("k", "text" as never), /body must be/],
          ]
          for (const [req, message] of refusals) {
            const failure = failureOf(yield* Effect.exit(store.put(req)))
            expect(failure.reason).toBe("Rejected")
            expect(String((failure.cause as Error).message)).toMatch(message)
          }
          expect(store.inspect().versions).toHaveLength(0)
        }),
      )

      it.effect("accepts the library's own metadata, and lowercases keys", () =>
        Effect.gen(function* () {
          const store = BlobStore.memory()
          const metadata = buildMetadata({
            table: "t",
            entity: "Document",
            attribute: "body",
            pk: { S: "p".repeat(400) },
            sk: { S: "s".repeat(400) },
            kind: "json",
            codec: "gzip",
            checksum: { algorithm: "crc64nvme", value: crc(bytesOf("{}")) },
          })
          const result = yield* store.put(request("k", bytesOf("x"), { metadata }))
          expect(yield* store.head(result.ref)).toEqual(metadata)
          const upper = yield* store.put(request("k", bytesOf("y"), { metadata: { "Edd-V": "1" } }))
          expect(yield* store.head(upper.ref)).toEqual({ "edd-v": "1" })
        }),
      )

      it.effect("reads ranges", () =>
        Effect.gen(function* () {
          const store = BlobStore.memory({ readChunkBytes: 3 })
          const { ref } = yield* store.put(request("k", bytesOf("0123456789")))
          const text = (range?: { offset: number; length?: number }) =>
            Effect.map(collect(store.get(ref, range === undefined ? undefined : { range })), (b) =>
              new TextDecoder().decode(b),
            )
          expect(yield* text()).toBe("0123456789")
          expect(yield* text({ offset: 2, length: 5 })).toBe("23456")
          expect(yield* text({ offset: 7 })).toBe("789")
          expect(yield* text({ offset: 8, length: 10 })).toBe("89")
          expect(yield* text({ offset: 10 })).toBe("")
          expect(yield* text({ offset: 3, length: 0 })).toBe("")
          // chunked by readChunkBytes
          expect((yield* Stream.runCollect(store.get(ref))).map((c) => c.length)).toEqual([
            3, 3, 3, 1,
          ])
          for (const range of [
            { offset: 11 },
            { offset: -1 },
            { offset: 1.5 },
            { offset: 0, length: -1 },
          ]) {
            const failure = failureOf(yield* Effect.exit(collect(store.get(ref, { range }))))
            expect(failure.reason).toBe("Rejected")
            expect(failure.ref).toEqual(ref)
          }
        }),
      )

      it.effect("fails NotFound for an absent version, with the ref", () =>
        Effect.gen(function* () {
          const store = BlobStore.memory()
          const { ref } = yield* store.put(request("k", bytesOf("x")))
          const absent = { key: "k", version: "0".repeat(32) }
          const exits: ReadonlyArray<Exit.Exit<unknown, BlobStoreFailure>> = [
            yield* Effect.exit(collect(store.get(absent))),
            yield* Effect.exit(store.head(absent)),
            yield* Effect.exit(
              store.copy(absent, { ...request("k2", bytesOf("")), contentLength: undefined }),
            ),
            yield* Effect.exit(collect(store.get({ key: "other", version: ref.version }))),
          ]
          for (const exit of exits) {
            const failure = failureOf(exit)
            expect(failure.reason).toBe("NotFound")
            expect(failure.ref).toBeDefined()
          }
        }),
      )

      it.effect("deletes exact versions, idempotently", () =>
        Effect.gen(function* () {
          const store = BlobStore.memory()
          const a = yield* store.put(request("k", bytesOf("a")))
          const b = yield* store.put(request("k", bytesOf("b")))
          const c = yield* store.put(request("j", bytesOf("c")))
          yield* store.delete([b.ref])
          expect(store.inspect().versions.map((v) => [v.ref, v.isLatest])).toEqual([
            [c.ref, true],
            [a.ref, true],
          ])
          yield* store.delete([b.ref, { key: "absent", version: "v" }])
          yield* store.delete([])
          yield* store.delete([a.ref, c.ref])
          expect(store.inspect().versions).toEqual([])
        }),
      )

      it.effect("copies a version server-side into a new version", () =>
        Effect.gen(function* () {
          const store = BlobStore.memory()
          const source = yield* store.put(request("a", bytesOf("payload")))
          const copied = yield* store.copy(source.ref, {
            key: "b",
            contentLength: 7,
            contentType: "image/png",
            metadata: { "edd-attr": "scan" },
          })
          expect(copied.ref.key).toBe("b")
          expect(copied.ref.version).not.toBe(source.ref.version)
          expect(copied.size).toBe(7)
          expect(yield* collect(store.get(copied.ref))).toEqual(bytesOf("payload"))
          expect(yield* store.head(copied.ref)).toEqual({ "edd-attr": "scan" })
          const wrongLength = yield* Effect.exit(
            store.copy(source.ref, {
              key: "b",
              contentLength: 6,
              contentType: "x/y",
              metadata: {},
            }),
          )
          expect(failureOf(wrongLength).reason).toBe("Rejected")
        }),
      )

      it.effect("lists versions in UTF-8 key order, newest first, from startAfter", () =>
        Effect.gen(function* () {
          const store = BlobStore.memory()
          const keys = ["p/b", "p/a", "p/￿", "p/\u{10000}", "q/a"]
          const refs: Array<BlobRef> = []
          for (const key of keys) refs.push((yield* store.put(request(key, bytesOf(key)))).ref)
          const newer = yield* store.put(request("p/a", bytesOf("again")))
          const listed = yield* Stream.runCollect(store.list("p/"))
          expect(listed.map((l) => [l.ref.key, l.isLatest])).toEqual([
            ["p/a", true],
            ["p/a", false],
            ["p/b", true],
            ["p/￿", true],
            ["p/\u{10000}", true],
          ])
          expect(listed[0]!.ref).toEqual(newer.ref)
          expect(listed[0]!.size).toBe(5)
          expect(listed[0]!.lastModified).toBeInstanceOf(Date)
          const after = yield* Stream.runCollect(store.list("p/", { startAfter: "p/a" }))
          expect(after.map((l) => l.ref.key)).toEqual(["p/b", "p/￿", "p/\u{10000}"])
          expect((yield* Stream.runCollect(store.list(""))).length).toBe(6)
          expect(yield* Stream.runCollect(store.list("none/"))).toEqual([])
          expect(compareUtf8("￿", "\u{10000}")).toBeLessThan(0)
          expect(compareUtf8("a", "ab")).toBeLessThan(0)
          expect(compareUtf8("b", "ab")).toBeGreaterThan(0)
        }),
      )

      it.effect("sets, reads and clears marks per version; absent refs succeed", () =>
        Effect.gen(function* () {
          const store = BlobStore.memory()
          const a = yield* store.put(request("k", bytesOf("a")))
          const b = yield* store.put(request("k", bytesOf("b")))
          const since = new Date("2026-11-01T00:00:00.000Z")
          expect(yield* store.marks.get(a.ref)).toEqual(Option.none())
          yield* store.marks.set(a.ref, since)
          expect(yield* store.marks.get(a.ref)).toEqual(Option.some(since))
          expect(yield* store.marks.get(b.ref)).toEqual(Option.none())
          expect(store.inspect().versions.map((v) => v.mark)).toEqual([
            Option.none(),
            Option.some(since),
          ])
          yield* store.marks.clear(a.ref)
          expect(yield* store.marks.get(a.ref)).toEqual(Option.none())
          const absent = { key: "absent", version: "v" }
          expect(yield* store.marks.get(absent)).toEqual(Option.none())
          yield* store.marks.set(absent, since)
          yield* store.marks.clear(absent)
          const invalid = yield* Effect.exit(store.marks.set(a.ref, new Date(Number.NaN)))
          expect(failureOf(invalid).reason).toBe("Rejected")
        }),
      )

      it.effect("dates versions by the fiber's Clock (TestClock), or the clock option", () =>
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.parse("2026-11-01T10:00:00.000Z"))
          const store = BlobStore.memory()
          const a = yield* store.put(request("k", bytesOf("a")))
          yield* TestClock.adjust("90 minutes")
          const b = yield* store.put(request("k", bytesOf("b")))
          const [newest, oldest] = store.inspect().versions
          expect(oldest!.ref).toEqual(a.ref)
          expect(oldest!.lastModified.toISOString()).toBe("2026-11-01T10:00:00.000Z")
          expect(newest!.ref).toEqual(b.ref)
          expect(newest!.lastModified.toISOString()).toBe("2026-11-01T11:30:00.000Z")
          const listed = yield* Stream.runCollect(store.list(""))
          expect(listed.map((l) => l.lastModified.toISOString())).toEqual([
            "2026-11-01T11:30:00.000Z",
            "2026-11-01T10:00:00.000Z",
          ])

          const fixed: Clock.Clock = {
            ...(yield* Clock.Clock),
            currentTimeMillis: Effect.succeed(Date.parse("2020-01-01T00:00:00.000Z")),
          }
          const pinned = BlobStore.memory({ clock: fixed })
          yield* pinned.put(request("k", bytesOf("a")))
          expect(pinned.inspect().versions[0]!.lastModified.toISOString()).toBe(
            "2020-01-01T00:00:00.000Z",
          )
        }),
      )

      it("returns copies: callers cannot change stored bytes", () =>
        Effect.runPromise(
          Effect.gen(function* () {
            const store = BlobStore.memory()
            const body = bytesOf("abc")
            const { ref } = yield* store.put(request("k", body))
            body[0] = 0x7a
            const read = yield* collect(store.get(ref))
            read[1] = 0x7a
            store.inspect().versions[0]!.bytes[2] = 0x7a
            expect(new TextDecoder().decode(yield* collect(store.get(ref)))).toBe("abc")
          }),
        ))
    })

    describe("keyPerWrite", () => {
      it.effect('gives every upload its own key under the requested one, version ""', () =>
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.parse("2026-11-01T00:00:00.000Z"))
          const store = BlobStore.memory({ versioning: "keyPerWrite" })
          const a = yield* store.put(request("p/F/O", bytesOf("a")))
          yield* TestClock.adjust("1 second")
          const b = yield* store.put(request("p/F/O", bytesOf("b")))
          for (const result of [a, b]) {
            expect(result.ref.version).toBe("")
            expect(result.ref.key).toMatch(/^p\/F\/O\/[0-9a-hjkmnp-tv-z]{26}$/)
            expect(result.ref.key.length - "p/F/O".length).toBeLessThanOrEqual(
              store.limits.maxKeySuffixBytes,
            )
          }
          expect(a.ref.key).not.toBe(b.ref.key)
          // time-ordered suffixes list in write order
          const listed = yield* Stream.runCollect(store.list("p/F/"))
          expect(listed.map((l) => [l.ref, l.isLatest])).toEqual([
            [a.ref, true],
            [b.ref, true],
          ])
          expect(yield* collect(store.get(b.ref))).toEqual(bytesOf("b"))
          yield* store.marks.set(a.ref, new Date(0))
          expect(yield* store.marks.get(a.ref)).toEqual(Option.some(new Date(0)))
          yield* store.delete([a.ref])
          expect(store.inspect().versions.map((v) => v.ref)).toEqual([b.ref])
          const copied = yield* store.copy(b.ref, {
            key: "p/F/O2",
            contentLength: 1,
            contentType: "x/y",
            metadata: {},
          })
          expect(copied.ref.key.startsWith("p/F/O2/")).toBe(true)
          expect(copied.ref.version).toBe("")
        }),
      )

      it.effect("lists a family's keys in write order within one millisecond", () =>
        Effect.gen(function* () {
          // the TestClock stays put: every upload lands in the same millisecond
          const start = Date.parse("2026-11-01T00:00:00.000Z")
          yield* TestClock.setTime(start)
          const store = BlobStore.memory({ versioning: "keyPerWrite" })
          const written: Array<BlobRef> = []
          for (let i = 0; i < 20; i++) {
            written.push((yield* store.put(request("P/F/O", bytesOf(String(i))))).ref)
          }
          const timePart = (ref: BlobRef) => ref.key.slice("P/F/O/".length, "P/F/O/".length + 10)
          expect(new Set(written.map((ref) => timePart(ref))).size).toBe(1)
          const listed = yield* Stream.runCollect(store.list("P/F/"))
          expect(listed.map((l) => l.ref)).toEqual(written)
          // a clock that steps back still lists later writes later
          yield* TestClock.setTime(start - 60_000)
          const later = (yield* store.put(request("P/F/O", bytesOf("later")))).ref
          const relisted = yield* Stream.runCollect(store.list("P/F/"))
          expect(relisted.map((l) => l.ref)).toEqual([...written, later])
          // the timestamp stays put until the clock passes the last one it used
          expect(timePart(later)).toBe(timePart(written[0]!))
          yield* TestClock.adjust("2 minutes")
          const next = (yield* store.put(request("P/F/O", bytesOf("next")))).ref
          expect(timePart(next) > timePart(later)).toBe(true)
          expect(
            (yield* Stream.runCollect(store.list("P/F/"))).map((l) => l.ref).slice(-2),
          ).toEqual([later, next])
        }),
      )

      it.effect("refuses a key that the suffix would push past 1,024 bytes", () =>
        Effect.gen(function* () {
          const store = BlobStore.memory({ versioning: "keyPerWrite" })
          const fits = yield* Effect.exit(store.put(request("k".repeat(1_024 - 27), bytesOf("x"))))
          expect(Exit.isSuccess(fits)).toBe(true)
          const over = yield* Effect.exit(store.put(request("k".repeat(1_024 - 26), bytesOf("x"))))
          expect(failureOf(over).reason).toBe("Rejected")
        }),
      )
    })

    describe("presign", () => {
      it.effect("makes fake memory:// URLs when enabled", () =>
        Effect.gen(function* () {
          const store = BlobStore.memory({ presign: true })
          const { ref } = yield* store.put(request("p/a b", bytesOf("x")))
          const url = yield* store.presign!(ref, { expiresIn: Duration.minutes(15) })
          expect(url).toBe(`memory://p/a%20b?versionId=${ref.version}&expiresIn=900`)
          const typed = yield* store.presign!(ref, {
            expiresIn: Duration.seconds(1.5),
            contentType: "image/png",
          })
          expect(typed).toContain("expiresIn=2&contentType=image%2Fpng")
          const bad = yield* Effect.exit(store.presign!(ref, { expiresIn: Duration.infinity }))
          expect(failureOf(bad).reason).toBe("Rejected")
        }),
      )
    })

    describe("failures", () => {
      const calls: Array<MemoryBlobCall> = []
      const faulty = (decide: (call: MemoryBlobCall) => MemoryBlobFault | undefined) =>
        BlobStore.memory({
          failures: (call) => {
            calls.push(call)
            return decide(call)
          },
        })

      it.effect("numbers calls per action and fails the chosen one before it takes effect", () =>
        Effect.gen(function* () {
          calls.length = 0
          const store = faulty((call) =>
            call.action === "put" && call.n === 2
              ? { _tag: "Fail", reason: "Throttled" }
              : undefined,
          )
          yield* store.put(request("k", bytesOf("1")))
          const failure = failureOf(yield* Effect.exit(store.put(request("k", bytesOf("2")))))
          expect(failure.reason).toBe("Throttled")
          yield* store.put(request("k", bytesOf("3")))
          expect(calls.map((c) => [c.action, c.n, c.key])).toEqual([
            ["put", 1, "k"],
            ["put", 2, "k"],
            ["put", 3, "k"],
          ])
          expect(store.inspect().versions.map((v) => new TextDecoder().decode(v.bytes))).toEqual([
            "3",
            "1",
          ])
          expect(store.inspect().calls.put).toBe(3)
        }),
      )

      it.effect("fails a put outright after its stream body was consumed", () =>
        Effect.gen(function* () {
          let pulled = 0
          const body = Stream.fromIterable([bytesOf("a"), bytesOf("b"), bytesOf("c")]).pipe(
            Stream.tap(() => Effect.sync(() => pulled++)),
          )
          const store = faulty(() => ({ _tag: "Fail", reason: "Unavailable" }))
          const exit = yield* Effect.exit(
            store.put(request("k", body, { contentLength: undefined, checksum: Effect.die("") })),
          )
          expect(failureOf(exit).reason).toBe("Unavailable")
          expect(pulled).toBe(3)
          expect(store.inspect().versions).toEqual([])
        }),
      )

      it.effect("fails or interrupts part-way through a put body", () =>
        Effect.gen(function* () {
          let pulled = 0
          const body = () =>
            Stream.fromIterable([bytesOf("a"), bytesOf("b"), bytesOf("c")]).pipe(
              Stream.tap(() => Effect.sync(() => pulled++)),
            )
          const opts = { contentLength: undefined, checksum: Effect.die("") }
          const failing = faulty(() => ({ _tag: "Fail", reason: "TooLarge", afterChunks: 1 }))
          expect(
            failureOf(yield* Effect.exit(failing.put(request("k", body(), opts)))).reason,
          ).toBe("TooLarge")
          expect(pulled).toBe(2)
          pulled = 0
          const interrupting = faulty(() => ({ _tag: "Interrupt", afterChunks: 2 }))
          const exit = yield* Effect.exit(interrupting.put(request("k", body(), opts)))
          expect(isInterrupted(exit)).toBe(true)
          expect(pulled).toBe(3)
          expect(interrupting.inspect().versions).toEqual([])
        }),
      )

      it.effect("loses a response after the call took effect", () =>
        Effect.gen(function* () {
          const store = faulty((call) =>
            call.n === 1 ? { _tag: "Fail", reason: "Unavailable", at: "response" } : undefined,
          )
          const failure = failureOf(yield* Effect.exit(store.put(request("k", bytesOf("x")))))
          expect(failure.reason).toBe("Unavailable")
          // the version exists, and the failure names it
          const [stored] = store.inspect().versions
          expect(failure.ref).toEqual(stored!.ref)
          // a delete whose response is lost still deleted
          expect(failureOf(yield* Effect.exit(store.delete([stored!.ref]))).reason).toBe(
            "Unavailable",
          )
          expect(store.inspect().versions).toEqual([])
        }),
      )

      it.effect("names the stored copy, not its source, when a copy's response is lost", () =>
        Effect.gen(function* () {
          const store = faulty((call) =>
            call.action !== "copy"
              ? undefined
              : call.n === 1
                ? { _tag: "Fail", reason: "Unavailable", at: "response" }
                : { _tag: "Fail", reason: "Throttled" },
          )
          const source = (yield* store.put(request("a", bytesOf("x")))).ref
          const target = { key: "b", contentLength: 1, contentType: "x/y", metadata: {} }
          const lost = failureOf(yield* Effect.exit(store.copy(source, target)))
          expect(lost.reason).toBe("Unavailable")
          const copied = store.inspect().versions.find((v) => v.ref.key === "b")
          expect(copied).toBeDefined()
          expect(lost.ref).toEqual(copied!.ref)
          expect(lost.ref).not.toEqual(source)
          // a fault before the copy takes effect names the source, and stores nothing
          const refused = failureOf(yield* Effect.exit(store.copy(source, target)))
          expect(refused.reason).toBe("Throttled")
          expect(refused.ref).toEqual(source)
          expect(store.inspect().versions.map((v) => v.ref.key)).toEqual(["a", "b"])
        }),
      )

      it.effect("interrupts a put before or after it takes effect", () =>
        Effect.gen(function* () {
          const before = faulty(() => ({ _tag: "Interrupt" }))
          expect(isInterrupted(yield* Effect.exit(before.put(request("k", bytesOf("x")))))).toBe(
            true,
          )
          expect(before.inspect().versions).toEqual([])
          const after = faulty(() => ({ _tag: "Interrupt", at: "response" }))
          expect(isInterrupted(yield* Effect.exit(after.put(request("k", bytesOf("x")))))).toBe(
            true,
          )
          expect(after.inspect().versions).toHaveLength(1)
        }),
      )

      it.effect("fails or interrupts a get mid-stream", () =>
        Effect.gen(function* () {
          const store = BlobStore.memory({
            readChunkBytes: 2,
            failures: (call) =>
              call.action !== "get"
                ? undefined
                : call.n === 1
                  ? { _tag: "Fail", reason: "Unavailable", afterChunks: 2 }
                  : call.n === 2
                    ? { _tag: "Interrupt", afterChunks: 1 }
                    : call.n === 3
                      ? { _tag: "Fail", reason: "Unavailable", at: "response" }
                      : undefined,
          })
          const stored = (yield* store.put(request("k", bytesOf("abcdefg")))).ref
          const received: Array<string> = []
          const read = Stream.runForEach(store.get(stored), (chunk) =>
            Effect.sync(() => received.push(new TextDecoder().decode(chunk))),
          )
          expect(failureOf(yield* Effect.exit(read)).reason).toBe("Unavailable")
          expect(received).toEqual(["ab", "cd"])
          received.length = 0
          expect(isInterrupted(yield* Effect.exit(read))).toBe(true)
          expect(received).toEqual(["ab"])
          received.length = 0
          expect(failureOf(yield* Effect.exit(read)).reason).toBe("Unavailable")
          expect(received).toEqual(["ab", "cd", "ef", "g"])
          received.length = 0
          yield* read
          expect(received).toEqual(["ab", "cd", "ef", "g"])
          expect(store.inspect().calls.get).toBe(4)
        }),
      )

      it.effect("covers every action, with the call's ref, refs and mark operation", () =>
        Effect.gen(function* () {
          calls.length = 0
          const store = BlobStore.memory({
            presign: true,
            failures: (call) => {
              calls.push(call)
              return undefined
            },
          })
          const { ref } = yield* store.put(request("k", bytesOf("x")))
          yield* collect(store.get(ref))
          yield* store.head(ref)
          yield* store.copy(ref, { key: "k2", contentLength: 1, contentType: "x/y", metadata: {} })
          yield* Stream.runCollect(store.list("k"))
          yield* store.marks.set(ref, new Date(0))
          yield* store.marks.get(ref)
          yield* store.marks.clear(ref)
          yield* store.presign!(ref, { expiresIn: Duration.minutes(1) })
          yield* store.delete([ref])
          expect(calls.map((c) => [c.action, c.n, c.mark])).toEqual([
            ["put", 1, undefined],
            ["get", 1, undefined],
            ["head", 1, undefined],
            ["copy", 1, undefined],
            ["list", 1, undefined],
            ["mark", 1, "set"],
            ["mark", 2, "get"],
            ["mark", 3, "clear"],
            ["presign", 1, undefined],
            ["delete", 1, undefined],
          ])
          expect(calls[3]!.ref).toEqual(ref)
          expect(calls[3]!.key).toBe("k2")
          expect(calls[4]!.key).toBe("k")
          expect(calls[9]!.refs).toEqual([ref])
          expect(store.inspect().calls).toEqual({
            put: 1,
            get: 1,
            delete: 1,
            copy: 1,
            list: 1,
            head: 1,
            mark: 3,
            presign: 1,
          })
        }),
      )

      it.effect("waits on a hook that returns an effect (to pause a call)", () =>
        Effect.gen(function* () {
          const gate = yield* Deferred.make<void>()
          const store = BlobStore.memory({
            failures: (call) =>
              call.action === "put" ? Effect.as(Deferred.await(gate), undefined) : undefined,
          })
          const fiber = yield* Effect.forkChild(store.put(request("k", bytesOf("x"))))
          yield* Effect.yieldNow
          expect(store.inspect().versions).toEqual([])
          yield* Deferred.succeed(gate, undefined)
          const result = yield* Fiber.join(fiber)
          expect(store.inspect().versions.map((v) => v.ref)).toEqual([result.ref])
        }),
      )

      it.effect("dies on a hook answer it does not know", () =>
        Effect.gen(function* () {
          const store = BlobStore.memory({ failures: () => ({ _tag: "Explode" }) as never })
          const exit = yield* Effect.exit(store.put(request("k", bytesOf("x"))))
          expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
        }),
      )
    })

    it.effect("is usable through the layer like any store", () =>
      Effect.gen(function* () {
        const store = BlobStore.memory()
        const program = Effect.gen(function* () {
          const blob = yield* BlobStore
          return yield* blob.put(request("k", bytesOf("x")))
        })
        const { ref } = yield* Effect.provide(program, Layer.mergeAll(BlobStore.layer(store)))
        expect(store.inspect().versions.map((v) => v.ref)).toEqual([ref])
      }),
    )
  })
})

// ---------------------------------------------------------------------------
// The memory store's multipart simulation (#179, design §7, §12.3)
// ---------------------------------------------------------------------------

describe("BlobStore.memory — multipart", () => {
  const body = (n: number): Uint8Array => Uint8Array.from({ length: n }, (_, i) => (i * 7) % 251)
  /** A put request of `bytes` as a stream of `chunk`-byte chunks, checksum resolved. */
  const streamed = (
    key: string,
    bytes: Uint8Array,
    chunk: number,
    overrides: Partial<BlobPutRequest> = {},
  ): BlobPutRequest => {
    const chunks: Array<Uint8Array> = []
    for (let at = 0; at < bytes.length; at += chunk) chunks.push(bytes.slice(at, at + chunk))
    return request(key, Stream.fromIterable(chunks), {
      contentLength: undefined,
      checksum: Effect.succeed({ algorithm: "crc64nvme", value: crc(bytes) }),
      ...overrides,
    })
  }

  it("has the documented multipart defaults", () => {
    const store = BlobStore.memory()
    expect(store.inspect().multipart).toEqual({
      creates: 0,
      parts: 0,
      completes: 0,
      aborts: 0,
      inProgress: 0,
    })
  })

  it.effect("uploads a body of at most one part in one call, a longer one in parts", () =>
    Effect.gen(function* () {
      const store = BlobStore.memory({ partSize: 8 })
      const single = yield* store.put(streamed("a", body(8), 3))
      expect(store.inspect().multipart.creates).toBe(0)
      const multi = yield* store.put(streamed("b", body(30), 7))
      expect(store.inspect().multipart).toEqual({
        creates: 1,
        parts: 4,
        completes: 1,
        aborts: 0,
        inProgress: 0,
      })
      const [b, a] = [multi, single].map(
        (result) => store.inspect().versions.find((v) => v.ref.key === result.ref.key)!,
      )
      expect(b!.bytes).toEqual(body(30))
      expect(a!.bytes).toEqual(body(8))
      expect(multi.size).toBe(30)
      // A buffered body over the part size goes multipart too.
      yield* store.put(request("c", body(17)))
      expect(store.inspect().multipart.creates).toBe(2)
      // The empty body is one call.
      yield* store.put(streamed("d", new Uint8Array(0), 1))
      expect(store.inspect().calls.put).toBe(4)
      expect(store.inspect().multipart.creates).toBe(2)
    }),
  )

  it.effect("checks the whole body's checksum and length at completion, and aborts", () =>
    Effect.gen(function* () {
      const store = BlobStore.memory({ partSize: 4 })
      const wrong = failureOf(
        yield* Effect.exit(
          store.put(
            streamed("k", body(10), 3, {
              checksum: Effect.succeed({ algorithm: "crc64nvme", value: crc(body(9)) }),
            }),
          ),
        ),
      )
      expect(wrong.reason).toBe("ChecksumMismatch")
      const short = failureOf(
        yield* Effect.exit(store.put(streamed("k", body(10), 3, { contentLength: 11 }))),
      )
      expect(short.reason).toBe("Rejected")
      expect(store.inspect().versions).toEqual([])
      expect(store.inspect().multipart).toMatchObject({ creates: 2, aborts: 2, inProgress: 0 })
    }),
  )

  it.effect("asks the hook about every phase as a multipart call, with the put's own n", () =>
    Effect.gen(function* () {
      const seen: Array<MemoryBlobCall> = []
      const store = BlobStore.memory({
        partSize: 4,
        failures: (call) => {
          seen.push(call)
          return undefined
        },
      })
      yield* store.put(request("k", body(2)))
      yield* store.put(streamed("k", body(9), 9))
      expect(seen.map((c) => [c.action, c.n, c.multipart?.phase, c.multipart?.part])).toEqual([
        ["put", 1, undefined, undefined],
        ["put", 2, undefined, undefined],
        ["multipart", 2, "create", undefined],
        ["multipart", 2, "part", 1],
        ["multipart", 2, "part", 2],
        ["multipart", 2, "part", 3],
        ["multipart", 2, "complete", undefined],
      ])
      // Phases are not puts: neither counted nor seen by a hook keyed on "put".
      expect(store.inspect().calls.put).toBe(2)
      expect(seen.filter((c) => c.action === "put").every((c) => c.multipart === undefined)).toBe(
        true,
      )
    }),
  )

  it.effect("retries a throttled part, as the SDK does, and fails once attempts run out", () =>
    Effect.gen(function* () {
      const store = BlobStore.memory({
        partSize: 4,
        partAttempts: 2,
        failures: (call) =>
          call.multipart?.phase === "part" &&
          call.multipart.part === 2 &&
          (call.n === 2 || call.multipart.attempt === 1)
            ? { _tag: "Fail", reason: "Throttled" }
            : undefined,
      })
      yield* store.put(streamed("k", body(12), 5))
      expect(store.inspect().multipart).toMatchObject({ parts: 4, completes: 1 })
      const failed = failureOf(yield* Effect.exit(store.put(streamed("k", body(12), 5))))
      expect(failed.reason).toBe("Throttled")
      expect(store.inspect().multipart).toMatchObject({ completes: 1, aborts: 1, inProgress: 0 })
      expect(store.inspect().versions).toHaveLength(1)
    }),
  )

  it.effect(
    "fails part maxParts + 1 as TooLarge, naming the part size; a known length adapts",
    () =>
      Effect.gen(function* () {
        const store = BlobStore.memory({ partSize: 4, maxParts: 3 })
        const tooLarge = failureOf(yield* Effect.exit(store.put(streamed("k", body(13), 13))))
        expect(tooLarge.reason).toBe("TooLarge")
        expect(String((tooLarge.cause as Error).message)).toMatch(/more than 3 parts of 4 bytes/)
        expect(store.inspect().multipart).toMatchObject({ aborts: 1, inProgress: 0 })
        // With its length known, the part size rises to ceil(13 / 3) = 5.
        yield* store.put(streamed("k", body(13), 13, { contentLength: 13 }))
        expect(store.inspect().multipart).toMatchObject({ completes: 1 })
        expect(store.inspect().versions[0]!.bytes).toEqual(body(13))
      }),
  )

  it.effect("loses a Complete response: the version is stored, the failure says completeLost", () =>
    Effect.gen(function* () {
      const store = BlobStore.memory({
        partSize: 4,
        failures: (call) =>
          call.multipart?.phase === "complete"
            ? { _tag: "Fail", reason: "Unavailable", at: "response" }
            : undefined,
      })
      const lost = failureOf(yield* Effect.exit(store.put(streamed("k", body(9), 2))))
      expect(lost.reason).toBe("Unavailable")
      expect(lost.completeLost).toBe(true)
      expect(lost.ref).toBeUndefined()
      expect(store.inspect().versions).toHaveLength(1)
    }),
  )

  it.effect("aborts an interrupted upload after its in-flight parts are interrupted", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const store = BlobStore.memory({
        partSize: 4,
        failures: (call) =>
          call.multipart?.phase === "part" && call.multipart.part === 2
            ? Effect.andThen(Deferred.succeed(started, undefined), Effect.never)
            : undefined,
      })
      const fiber = yield* store.put(streamed("k", body(12), 4)).pipe(Effect.forkChild)
      yield* Deferred.await(started)
      yield* Fiber.interrupt(fiber)
      expect(store.inspect().multipart).toMatchObject({
        creates: 1,
        completes: 0,
        aborts: 1,
        inProgress: 0,
      })
      expect(store.inspect().versions).toEqual([])
    }),
  )

  it.effect("keeps put-level faults: a request fault after the body stores nothing", () =>
    Effect.gen(function* () {
      const pulled = { n: 0 }
      const store = BlobStore.memory({
        partSize: 4,
        failures: (call) =>
          call.action === "put" && call.n === 1
            ? { _tag: "Fail", reason: "Unavailable" }
            : undefined,
      })
      const req = streamed("k", body(10), 3)
      const counted: BlobPutRequest = {
        ...req,
        body: (req.body as Stream.Stream<Uint8Array>).pipe(
          Stream.tap(() =>
            Effect.sync(() => {
              pulled.n++
            }),
          ),
        ),
      }
      const failed = failureOf(yield* Effect.exit(store.put(counted)))
      expect(failed.reason).toBe("Unavailable")
      // The whole body was consumed; the fault fired before completion. The
      // part already uploaded was aborted with its upload.
      expect(pulled.n).toBe(4)
      expect(store.inspect().versions).toEqual([])
      expect(store.inspect().multipart).toEqual({
        creates: 1,
        parts: 1,
        completes: 0,
        aborts: 1,
        inProgress: 0,
      })
    }),
  )

  it.effect("keeps put-level faults: a response fault on a multipart body names its version", () =>
    Effect.gen(function* () {
      const store = BlobStore.memory({
        partSize: 4,
        failures: (call) =>
          call.action === "put"
            ? { _tag: "Fail", reason: "Unavailable", at: "response" }
            : undefined,
      })
      const lost = failureOf(yield* Effect.exit(store.put(streamed("k", body(10), 3))))
      expect(lost.reason).toBe("Unavailable")
      expect(lost.completeLost).toBeUndefined()
      const [stored] = store.inspect().versions
      expect(lost.ref).toEqual(stored!.ref)
      expect(stored!.bytes).toEqual(body(10))
      expect(store.inspect().multipart).toMatchObject({ creates: 1, completes: 1, aborts: 0 })
    }),
  )
})
