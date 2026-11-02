/**
 * The multipart driver stores run (#179, design §7): re-chunking into exact
 * parts with the last marked only at a real end, the part-size rule, and the
 * single / create–parts–complete / abort protocol.
 */

import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit, Stream } from "effect"
import { BlobStoreFailure } from "../src/BlobStore.js"
import * as Multipart from "../src/internal/Multipart.js"

const bytes = (n: number): Uint8Array => Uint8Array.from({ length: n }, (_, i) => i % 256)

const chunks = (content: Uint8Array, size: number) => {
  const out: Array<Uint8Array> = []
  for (let at = 0; at < content.length; at += size) out.push(content.slice(at, at + size))
  return Stream.fromIterable(out)
}

describe("Multipart", () => {
  it("raises the part size only when maxParts parts would not hold a known length", () => {
    expect(Multipart.partSizeFor(8, undefined)).toBe(8)
    expect(Multipart.partSizeFor(8, 80, 10)).toBe(8)
    expect(Multipart.partSizeFor(8, 81, 10)).toBe(9)
    expect(Multipart.partSizeFor(Multipart.DEFAULT_PART_SIZE, 100 * 1024 ** 3)).toBe(
      Math.ceil((100 * 1024 ** 3) / Multipart.MAX_PARTS),
    )
  })

  it.effect("re-chunks into exact parts, marking the last only at the end", () =>
    Effect.gen(function* () {
      const parts = yield* Stream.runCollect(Multipart.rechunk(chunks(bytes(23), 5), 8))
      expect(parts.map((p) => [p.bytes.length, p.last])).toEqual([
        [8, false],
        [8, false],
        [7, true],
      ])
      expect(parts.flatMap((p) => [...p.bytes])).toEqual([...bytes(23)])
      const exact = yield* Stream.runCollect(Multipart.rechunk(chunks(bytes(16), 3), 8))
      expect(exact.map((p) => [p.bytes.length, p.last])).toEqual([
        [8, false],
        [8, true],
      ])
      const empty = yield* Stream.runCollect(Multipart.rechunk(Stream.empty, 8))
      expect(empty.map((p) => [p.bytes.length, p.last])).toEqual([[0, true]])
    }),
  )

  it.effect("never marks a part last when the body fails", () =>
    Effect.gen(function* () {
      const seen: Array<boolean> = []
      const body = Stream.concat(chunks(bytes(12), 4), Stream.fail("boom"))
      const exit = yield* Effect.exit(
        Stream.runForEach(Multipart.rechunk(body, 8), (part) =>
          Effect.sync(() => {
            seen.push(part.last)
          }),
        ),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      expect(seen).toEqual([])
    }),
  )

  it.effect("aborts after a failed part, logs a failed abort, and keeps the part's failure", () =>
    Effect.gen(function* () {
      const log: Array<string> = []
      const failure = new BlobStoreFailure({ reason: "Unavailable", cause: "part" })
      const exit = yield* Effect.exit(
        Multipart.upload(
          chunks(bytes(20), 4),
          undefined,
          { partSize: 8, concurrency: 1, where: "test" },
          {
            single: () => Effect.die("unused"),
            create: Effect.sync(() => {
              log.push("create")
              return "u"
            }),
            part: (_, { number }) => {
              log.push(`part ${number}`)
              return number === 2 ? Effect.fail(failure) : Effect.succeed(number)
            },
            complete: () => Effect.die("unused"),
            abort: () =>
              Effect.suspend(() => {
                log.push("abort")
                return Effect.fail(new BlobStoreFailure({ reason: "Unavailable", cause: "abort" }))
              }),
          },
        ),
      )
      expect(log).toEqual(["create", "part 1", "part 2", "abort"])
      expect(exit).toEqual(Exit.fail(failure))
    }),
  )

  it.effect("uploads at most one part in one call, without creating", () =>
    Effect.gen(function* () {
      const log: Array<string> = []
      const result = yield* Multipart.upload(
        chunks(bytes(8), 3),
        undefined,
        { partSize: 8, concurrency: 2, where: "test" },
        {
          single: (body) =>
            Effect.sync(() => {
              log.push(`single ${body.length}`)
              return { ref: { key: "k", version: "v" }, size: body.length }
            }),
          create: Effect.die("unused"),
          part: () => Effect.die("unused"),
          complete: () => Effect.die("unused"),
          abort: () => Effect.die("unused"),
        },
      )
      expect(log).toEqual(["single 8"])
      expect(result.size).toBe(8)
    }),
  )
})
