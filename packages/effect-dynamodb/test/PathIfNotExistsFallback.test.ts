/**
 * A `pathIfNotExists` operand a check refuses is refused only where it would be stored: where the
 * row lacks its path (#236). DynamoDB keeps the stored value wherever the path is there, so the
 * operand is never stored there, and 1.40.0's refusal of it before anything was read refused an
 * update DynamoDB would have applied without it. On every write path (`helpers/PathIfNotExistsFallback.ts`),
 * alone and in a transaction, at a top-level attribute, a struct's property and a sparse map's
 * entry's property:
 *
 * - the row holds the path: the update is written, and the stored value is the one it held;
 * - the row lacks it: the update is refused with the error 1.40.0 refused it with, and nothing is
 *   written. An update that reads its row (retained, restating a packed immutable, clearing a
 *   sparse map, every update a transaction plans) decides on that read; one that reads nothing
 *   sends its write requiring the path, and decides on the row DynamoDB's refusal returns;
 * - an operand the checks take is sent as 1.40.0 sent it, with no condition added, and the refused
 *   operand's write differs from it by its operand and that condition alone.
 *
 * A version the update expects and the row isn't at is that refusal, on every path, whether or not
 * the row holds the path. Each name ends with what 1.40.0 did there (`helpers/PathIfNotExistsFallback.ts`).
 */

import { it } from "@effect/vitest"
import { Cause, Effect, Exit, Layer } from "effect"
import { SecureRandom } from "effect/crypto"
import { afterEach, beforeEach, describe, expect, vi } from "vitest"
import * as Lib from "../src/index.js"
import {
  definitions,
  paths,
  positions,
  seed,
  send,
  valueAt,
} from "./helpers/PathIfNotExistsFallback.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

/** Seeds the rows, sends the update of `id`, and gives what it did. */
const run = (
  path: (typeof paths)[number],
  segments: ReadonlyArray<string | number>,
  id: "here" | "absent" | "orphan",
  value: unknown,
  transaction: boolean,
  expectedVersion?: number,
) => {
  const { E, Main } = definitions(path)
  const table = makeRecordingTable()
  return Effect.gen(function* () {
    const db: any = yield* Lib.DynamoClient.make({ entities: { E }, tables: { Main } } as never)
    for (const row of ["here", "absent", "orphan", "other"] as const) {
      yield* db.entities.E.put(seed(row)).asEffect()
    }
    table.take()
    const before = structuredClone([...table.items])
    const sent = send(
      db,
      expectedVersion === undefined
        ? path
        : { ...path, prefix: (u: any) => path.prefix(u).expectedVersion(expectedVersion) },
      segments,
      id,
      value,
      transaction,
    )
    const exit = yield* Effect.exit(sent as Effect.Effect<unknown, unknown>)
    const requests = table.take()
    const unchanged =
      JSON.stringify([...table.items].filter(([key]) => key.includes(id))) ===
      JSON.stringify(before.filter(([key]) => key.includes(id)))
    const read = yield* Effect.exit(db.entities.E.get({ id }))
    const failure = Exit.isFailure(exit) ? (Cause.squash(exit.cause) as any) : undefined
    return {
      ok: Exit.isSuccess(exit),
      failure:
        failure === undefined
          ? undefined
          : { tag: failure._tag, operation: failure.operation, cause: String(failure.cause) },
      requests,
      unchanged,
      read: Exit.isSuccess(read) ? read.value : undefined,
    }
  }).pipe(
    Effect.provide(Main.layer({ name: "t" })),
    Effect.provide(table.layer),
    // Two runs compared request for request mint the same incarnation.
    Effect.provide(
      Layer.succeed(
        SecureRandom.SecureRandom,
        SecureRandom.make((n) => new Uint8Array(n).fill(7)),
      ),
    ),
  ) as unknown as Effect.Effect<{
    ok: boolean
    failure: { tag: string; operation: string | undefined; cause: string } | undefined
    requests: ReadonlyArray<{ command: string; input: Record<string, any> }>
    unchanged: boolean
    read: any
  }>
}

/** The update of row `here` a case sent (in a transaction, its item). */
const updateOf = (requests: ReadonlyArray<{ command: string; input: Record<string, any> }>) => {
  const own = (key: unknown) => JSON.stringify(key).includes("id_here")
  for (const request of requests) {
    if (request.command === "UpdateItem" && own(request.input.Key)) return request.input
    if (request.command === "TransactWriteItems") {
      return request.input.TransactItems.find(
        (item: any) => item.Update !== undefined && own(item.Update.Key),
      )?.Update
    }
  }
  return undefined
}

/** A request without the `attribute_exists(<path>)` the refused operand's write requires. */
const unguarded = (input: Record<string, any> | undefined) => {
  if (input === undefined) return undefined
  const names = Object.fromEntries(
    Object.entries(input.ExpressionAttributeNames as Record<string, string>).filter(
      ([name]) => !/^#fb\d+$/.test(name),
    ),
  )
  return {
    ...input,
    ConditionExpression: String(input.ConditionExpression).replace(
      / AND attribute_exists\(#fb\d+((\.#fb\d+)|\[\d+\])*\)/g,
      "",
    ),
    ExpressionAttributeNames: names,
  }
}

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(1700000000000)
  vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation((array) => {
    ;(array as Uint8Array).fill(7)
    return array
  })
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe("pathIfNotExists with an operand a check refuses: refused only where it would be stored", () => {
  for (const path of paths) {
    for (const position of positions) {
      for (const transaction of [false, true]) {
        const at = `${path.name} | ${position.name} | ${transaction ? "in a transaction" : "alone"}`

        it.effect(
          `${at} | the row holds the path: written, value kept | 1.40.0: ${position.on140.here}`,
          () =>
            Effect.gen(function* () {
              const got = yield* run(path, position.segments, "here", -1, transaction)
              expect(got.failure).toBeUndefined()
              expect(got.ok).toBe(true)
              expect(valueAt(got.read, position.segments)).toBe(1)
            }),
        )

        it.effect(
          `${at} | the row lacks the path: refused, nothing written | 1.40.0: ${position.on140.absent}`,
          () =>
            Effect.gen(function* () {
              const got = yield* run(path, position.segments, "absent", -1, transaction)
              expect(got.ok).toBe(false)
              expect(got.failure?.tag).toBe("ValidationError")
              expect(got.failure?.operation).toBe("update.pathIfNotExists")
              expect(got.failure?.cause).toContain("greater than 0")
              expect(got.unchanged).toBe(true)
              expect(got.requests.some((request) => request.command === "TransactWriteItems")).toBe(
                false,
              )
              expect(valueAt(got.read, position.segments)).toBeUndefined()
            }),
        )

        it.effect(`${at} | an operand the checks take: sent as 1.40.0 sent it`, () =>
          Effect.gen(function* () {
            const valid = yield* run(path, position.segments, "here", 5, transaction)
            const refused = yield* run(path, position.segments, "here", -1, transaction)
            expect(valid.ok).toBe(true)
            const sent = updateOf(valid.requests)
            expect(JSON.stringify(sent)).not.toContain("#fb")
            // The refused operand's write: the same, but for its operand and the path it requires.
            const guarded = updateOf(refused.requests)
            expect(
              JSON.parse(JSON.stringify(unguarded(guarded)).replaceAll('{"N":"-1"}', '{"N":"5"}')),
            ).toEqual(sent)
          }),
        )
      }
    }
  }

  for (const transaction of [false, true]) {
    it.effect(
      `plain | a struct the row lacks, holding the path | ${transaction ? "in a transaction" : "alone"} | refused, nothing written | 1.40.0: ${positions[1]!.on140.absent}`,
      () =>
        Effect.gen(function* () {
          const got = yield* run(paths[0]!, ["meta", "n"], "orphan", -1, transaction)
          expect(got.failure?.tag).toBe("ValidationError")
          expect(got.failure?.operation).toBe("update.pathIfNotExists")
          expect(got.unchanged).toBe(true)
        }),
    )
  }

  // The version first: the operand's decision is the row's, at the version the caller expects.
  const versioned = paths.find((path) => path.name.startsWith("versioned"))!
  const unexpecting = { ...versioned, prefix: (u: any) => u }
  for (const position of positions) {
    for (const id of ["here", "absent"] as const) {
      for (const transaction of [false, true]) {
        it.effect(
          `versioned, expecting another version | ${position.name} | the row ${id === "here" ? "holds" : "lacks"} the path | ${transaction ? "in a transaction" : "alone"} | OptimisticLockError | 1.40.0: ${position.on140.stale}`,
          () =>
            Effect.gen(function* () {
              const got = yield* run(unexpecting, position.segments, id, -1, transaction, 7)
              expect(got.failure?.tag).toBe("OptimisticLockError")
              expect(got.unchanged).toBe(true)
            }),
        )
      }
    }
  }
})
