/**
 * Upserts carrying a sparse map's entry key, against what the published 1.39.0 did
 * (`fixtures/upsert-entry-keys-1.39.0.json`, from `helpers/UpsertEntryKeys.ts`).
 *
 * An upsert sent as one request ends as it did on 1.39.0. One that reads the row first (an entity
 * with `unique` or `retain`, or an input omitting a defaulted index composite) writes a row that
 * isn't there as a put, and one that is as the update of the upserted fields. That update refuses
 * the entry keys a put refuses only with `retain` or a changed unique field; otherwise just an
 * empty key and one holding `#`. An entry key is refused before the read only where both writes
 * refuse it.
 *
 * - **Where 1.39.0 completed, the upsert completes**, with the same commands, row and read: a key
 *   over 255 bytes, given over a row that is there, which a put refuses and that update writes.
 *   The update is sent as 1.40.0 sends it for any key (#198).
 * - **Where 1.39.0 refused, the upsert refuses with the same error**, before the read where every
 *   row is refused.
 * - **An empty key or one holding `#`, given over a row that is there**, was refused after the read,
 *   in the update's words. Both writes refuse it, so it's refused before the read, in the put's.
 * - **`data: undefined` over a row that is there writes the default**, as an upsert sent as one
 *   request always did ("A default no key holds is stored on both paths", 1.40.0). 1.39.0's
 *   read-first upsert left the stored entries, or, with `retain` or `unique`, removed them. A
 *   default key the write refuses is refused before the read.
 */

import { readFileSync } from "node:fs"
import { it } from "@effect/vitest"
import { sparseKeyRefusal } from "@effect-dynamodb/schema/internal/SparseKey.js"
import { Effect } from "effect"
import { afterEach, beforeEach, describe, expect, vi } from "vitest"
import * as Lib from "../src/index.js"
import { type Case, capture, matrix, type Outcome } from "./helpers/UpsertEntryKeys.js"

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/upsert-entry-keys-1.39.0.json", import.meta.url), "utf8"),
) as { readonly cases: Record<string, Outcome> }

beforeEach(() => {
  // The fixture was captured with the clock and the random bytes fixed.
  vi.spyOn(Date, "now").mockReturnValue(1700000000000)
  vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation((array) => {
    ;(array as Uint8Array).fill(7)
    return array
  })
})
afterEach(() => {
  vi.restoreAllMocks()
})

/** Whether the upsert reads the row first. */
const readsFirst = (each: Case): boolean =>
  each.world === "retain" ||
  each.world === "unique" ||
  each.world === "uniqueKey" ||
  each.defaultedIndex
/** Whether the update over a row that is there refuses the entry keys a put refuses. */
const refusesPutKeys = (each: Case): boolean => each.world === "retain" || each.world === "unique"
/** Whether every write refuses the entry key. */
const everyWriteRefuses = (each: Case): boolean =>
  each.entryKey === "" || each.entryKey.includes("#")
const commands = (outcome: Outcome) => outcome.requests.map((request) => request.command)
const read = (outcome: Outcome) => outcome.read as { readonly data?: unknown }

const sentAsOne = matrix.filter((each) => !readsFirst(each))
const overRow = matrix.filter((each) => readsFirst(each) && each.present)
const completes = overRow.filter(
  (each) =>
    !refusesPutKeys(each) &&
    (each.supply === "omitted" || (each.supply === "given" && !everyWriteRefuses(each))),
)
const refusedInPutWords = overRow.filter(
  (each) => !refusesPutKeys(each) && each.supply === "given" && everyWriteRefuses(each),
)
const undefinedOverRow = overRow.filter((each) => each.supply === "undefined")
const rest = matrix.filter(
  (each) =>
    readsFirst(each) &&
    !completes.includes(each) &&
    !refusedInPutWords.includes(each) &&
    !undefinedOverRow.includes(each),
)

it("the fixture holds every case", () => {
  expect(Object.keys(fixture.cases)).toEqual(matrix.map((each) => each.key))
})

describe("an upsert sent as one request ends as on 1.39.0", () => {
  for (const each of sentAsOne) {
    it.live(each.key, () =>
      Effect.gen(function* () {
        expect(yield* capture(Lib as never, each)).toEqual(fixture.cases[each.key])
      }),
    )
  }
})

describe("an upsert over a row that is there completes where 1.39.0 completed", () => {
  for (const each of completes) {
    it.live(each.key, () =>
      Effect.gen(function* () {
        const was = fixture.cases[each.key]!
        const got = yield* capture(Lib as never, each)
        expect(was.ok).toBe(true)
        expect(got.failure).toBeUndefined()
        expect(commands(got)).toEqual(commands(was))
        expect(got.row).toEqual(was.row)
        expect(got.read).toEqual(was.read)
      }),
    )
  }
})

describe("an entry key both writes refuse is refused before the read, in the put's words", () => {
  for (const each of refusedInPutWords) {
    it.live(each.key, () =>
      Effect.gen(function* () {
        const was = fixture.cases[each.key]!
        const got = yield* capture(Lib as never, each)
        expect(was.failure).toEqual({
          error: "ValidationError",
          operation: "upsert.sparse",
          says: `Sparse map "data": invalid key ${JSON.stringify(each.entryKey)}`,
        })
        expect(was.requests.length).toBeGreaterThan(0)
        expect(got).toEqual({
          ...was,
          failure: { ...was.failure, says: sparseKeyRefusal("data", "data", each.entryKey) },
          requests: [],
        })
      }),
    )
  }
})

describe("data: undefined over a row that is there writes the default", () => {
  for (const each of undefinedOverRow) {
    it.live(each.key, () =>
      Effect.gen(function* () {
        const was = fixture.cases[each.key]!
        const got = yield* capture(Lib as never, each)
        // 1.39.0 left the stored entries, or removed them when it wrote the row whole.
        expect(was.ok).toBe(true)
        expect(read(was).data).toEqual(refusesPutKeys(each) ? {} : { ok: 1 })
        if (everyWriteRefuses(each) || refusesPutKeys(each)) {
          expect(got.failure).toEqual({
            error: "ValidationError",
            operation: "upsert.sparse",
            says: sparseKeyRefusal("data", "data", each.entryKey),
          })
          expect(got.requests).toEqual([])
          expect(got.read).toMatchObject({ note: "before", data: { ok: 1 } })
        } else {
          expect(got.failure).toBeUndefined()
          expect(commands(got)).toEqual(commands(was))
          expect(read(got).data).toEqual({ ok: 1, [each.entryKey]: 3 })
        }
      }),
    )
  }
})

describe("any other upsert that reads first ends as on 1.39.0, a refusal before the read", () => {
  for (const each of rest) {
    it.live(each.key, () =>
      Effect.gen(function* () {
        const was = fixture.cases[each.key]!
        const got = yield* capture(Lib as never, each)
        if (was.ok) {
          expect(got).toEqual(was)
        } else {
          expect({ ...got, requests: undefined }).toEqual({ ...was, requests: undefined })
          expect(got.requests).toEqual(was.requests.slice(0, got.requests.length))
        }
      }),
    )
  }
})
