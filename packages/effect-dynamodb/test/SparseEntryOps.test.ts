/**
 * Operations on a sparse map's entries, against what the published 1.39.0 did
 * (`fixtures/sparse-entry-ops-1.39.0.json`, from `helpers/SparseEntryOps.ts`), and the requests
 * the published 1.40.0 sent (`fixtures/sparse-entry-ops-requests-1.40.0.json`): every case sends
 * them, whole, unless `OVERRIDES` says why not and which it sends instead, whole.
 *
 * - **Every entry operation reaches the entry, whatever its key is called.** The record and the
 *   path operations, on a plain, a retained and a unique entity, alone and in a transaction, with
 *   the entry present and absent, under an ordinary key and under the names every object inherits
 *   (`constructor`, `toString`, `valueOf`, `hasOwnProperty`, `__proto__`). The update that reads
 *   the row and writes it whole looks an entry up as the map's own property: on a plain object,
 *   `data#constructor` found `Object`'s constructor, and a number was added to a function.
 * - **A payload's entry key is refused before any read only where the operation is refused
 *   whatever the row holds.** An immutable map's value is written by an upsert only into a row
 *   that isn't there, and by an update never: each ends as it did on 1.39.0.
 * - **A write that reads a ref first** refuses an entry key every such write refuses before that
 *   read.
 * - **An operation naming the table's TTL attribute** is refused only on an entity that writes it.
 */

import { readFileSync } from "node:fs"
import { it } from "@effect/vitest"
import { Effect } from "effect"
import { afterEach, beforeEach, describe, expect, vi } from "vitest"
import * as Lib from "../src/index.js"
import {
  type Case,
  captureWithRequests,
  cases,
  conditional,
  entryOps,
  type Outcome,
  refRead,
  type SentRequest,
  ttlNamed,
} from "./helpers/SparseEntryOps.js"

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/sparse-entry-ops-1.39.0.json", import.meta.url), "utf8"),
) as { readonly cases: Record<string, Outcome> }

/** Every request the published 1.40.0 sent for each case, whole (captured once; never regenerate it). */
const sent140 = JSON.parse(
  readFileSync(
    new URL("./fixtures/sparse-entry-ops-requests-1.40.0.json", import.meta.url),
    "utf8",
  ),
) as { readonly cases: Record<string, ReadonlyArray<SentRequest>> }

/**
 * Cases whose requests differ from the ones 1.40.0 sent: each with the reason, and the requests it
 * sends instead, whole. None does.
 */
const OVERRIDES: Readonly<
  Record<string, { readonly reason: string; readonly requests: ReadonlyArray<SentRequest> }>
> = {}

/** Runs a case, checking it sends 1.40.0's requests, whole, or its override's, whole. */
const capture = (each: Case) =>
  Effect.map(captureWithRequests(Lib as never, each), ({ outcome, requests }) => {
    const override = OVERRIDES[each.key]
    if (override === undefined) expect(requests).toEqual(sent140.cases[each.key])
    else expect(requests, override.reason).toEqual(override.requests)
    return outcome
  })

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

it("the fixtures hold every case", () => {
  expect(Object.keys(fixture.cases)).toEqual(cases.map((each) => each.key))
  expect(Object.keys(sent140.cases)).toEqual(cases.map((each) => each.key))
})

it("every override names a case, with its reason and requests that differ from 1.40.0's", () => {
  for (const [key, { reason, requests }] of Object.entries(OVERRIDES)) {
    expect(Object.hasOwn(sent140.cases, key), key).toBe(true)
    expect(reason.length, key).toBeGreaterThan(0)
    expect(requests, key).not.toEqual(sent140.cases[key])
  }
})

describe("an entry operation reaches the entry, whatever its key is called", () => {
  for (const each of entryOps) {
    it.live(each.key, () =>
      Effect.gen(function* () {
        const was = fixture.cases[each.key]!
        const got = yield* capture(each)
        // Sent as an expression, an operation reading an entry the row doesn't hold is refused by
        // DynamoDB ("The provided expression refers to an attribute that does not exist in the
        // item"), and now by the recording table as DynamoDB Local refuses it (#243). The 1.39.0
        // fixture recorded a table that took the update: 1.39.0 sent the same commands up to that
        // one, and 1.40.0 the same requests, whole (`capture`).
        const refused = each.expected === undefined && !each.whole
        if (refused) {
          const last = got.commands[got.commands.length - 1]
          expect(got).toMatchObject({ ok: false, error: `DynamoValidationError ${last}` })
          expect(got.commands).toEqual(was.commands.slice(0, got.commands.length))
          expect(got.stored).toBeUndefined()
        } else if (each.expected === undefined) {
          // Written whole, the row takes it, as on 1.39.0.
          expect(got.ok).toBe(was.ok)
          if (got.ok) expect(got.stored).toEqual(was.stored)
        } else {
          expect(got.error).toBeUndefined()
          expect(got.stored).toEqual(each.expected.stored)
        }
        // The row still decodes, and a read returns the entry under its key: `__proto__` too,
        // which 1.39.0's reader dropped.
        expect(got.read).toBeDefined()
        const data = (got.read as { readonly data: Record<string, unknown> }).data
        expect(Object.hasOwn(data, each.attribute!.slice("data#".length))).toBe(
          got.stored !== undefined,
        )
        // Sent as an expression, the operation sends what 1.39.0 sent.
        if (!each.whole && !refused) {
          expect({ ...got, read: undefined }).toEqual({ ...was, read: undefined })
        }
      }),
    )
  }

  it("1.39.0 got these wrong only where the update writes the row whole", () => {
    const wrong = entryOps.filter((each) => {
      const was = fixture.cases[each.key]!
      return (
        each.expected !== undefined &&
        (!was.ok || JSON.stringify(was.stored) !== JSON.stringify(each.expected.stored))
      )
    })
    expect(wrong.length).toBeGreaterThan(0)
    expect(wrong.every((each) => each.whole)).toBe(true)
  })
})

describe("an operation carrying an entry key it writes only into some rows ends as on 1.39.0", () => {
  for (const each of conditional) {
    it.live(each.key, () =>
      Effect.gen(function* () {
        expect(yield* capture(each)).toEqual(fixture.cases[each.key])
      }),
    )
  }
})

describe("a write that reads a ref first refuses an entry key before that read", () => {
  for (const each of refRead) {
    it.live(each.key, () =>
      Effect.gen(function* () {
        const was = fixture.cases[each.key]!
        const got = yield* capture(each)
        // 1.39.0 refused it too, after reading the ref (and the row).
        expect(was.ok).toBe(false)
        expect(was.commands.length).toBeGreaterThan(0)
        expect(got).toEqual({ ...was, commands: [] })
      }),
    )
  }
})

describe("the table's TTL attribute is the library's only on an entity that writes it", () => {
  for (const each of ttlNamed) {
    it.live(each.key, () =>
      Effect.gen(function* () {
        const was = fixture.cases[each.key]!
        expect(was.ok).toBe(true)
        expect(yield* capture(each)).toEqual(was)
      }),
    )
  }
})
