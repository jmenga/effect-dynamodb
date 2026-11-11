/**
 * An update with an operand does what the published 1.39.0 did, but for one thing: an operand its
 * schema refuses is refused before the update reads or sends anything.
 *
 * `fixtures/update-operand-requests-1.39.0.json` holds what 1.39.0 did for every case in
 * `helpers/UpdateOperandRequests.ts`: each combinator on a path the model names, on a path naming a
 * sparse map's entry, into a union and as a copy, with an operand 1.39.0 wrote and with one it
 * refused, on four kinds of entity, alone and in a transaction. For every case
 * (`helpers/Against139.ts`):
 *
 * - where 1.39.0 sent a write, this source sends the same requests, byte for byte, and the update
 *   ends as it ended (written and read back, or written and then failing to decode);
 * - where 1.39.0 refused the operand, this source refuses it with the same error, and sends
 *   nothing: 1.39.0 had read first on a retained entity and in a transaction. But a
 *   `pathIfNotExists` operand is refused only where the row lacks its path (#236), as the row
 *   these cases seed lacks `meta.optional`: after the read or the guarded write that finds it;
 * - no operand 1.39.0 wrote is refused, and no operand it refused is written;
 * - but where 1.39.0 wrote a row that didn't read, at a position the read schema resolves exactly
 *   (#236: `RESOLVED`), an operand none of the position's readers reads is refused with nothing
 *   sent, and one with a single stored form they read is sent in that form. Some of those cases
 *   are named `unchecked:` (the fixture's keys are as 1.39.0's capture named them).
 */

import { readFileSync } from "node:fs"
import { it } from "@effect/vitest"
import { Effect } from "effect"
import { afterEach, beforeEach, describe, expect, vi } from "vitest"
import * as Lib from "../src/index.js"
import { expectAs139, type Outcome, refusedOperand, wrote } from "./helpers/Against139.js"
import { capture, matrix, nameOf, RESOLVED } from "./helpers/UpdateOperandRequests.js"

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/update-operand-requests-1.39.0.json", import.meta.url), "utf8"),
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

describe("an update with an operand does what 1.39.0 did, and refuses what it refused before reading", () => {
  it("the fixture holds every case", () => {
    expect(Object.keys(fixture.cases)).toEqual(matrix.map((each) => each.key))
  })
  for (const each of matrix) {
    it.effect(each.key, () =>
      Effect.gen(function* () {
        const got = yield* capture(
          Lib as never,
          each.variant,
          each.transaction,
          each.apply,
          each.seeded,
          each.world,
        )
        const resolved = RESOLVED.get(nameOf(each.key))
        expectAs139(
          got,
          fixture.cases[each.key]!,
          each.key.includes("a property named as a renamed field")
            ? "names the property"
            : resolved?.[0],
          ...(resolved?.[1] === undefined ? [] : [resolved[1]]),
        )
      }),
    )
  }
})

describe("what the fixture holds", () => {
  const cases = Object.entries(fixture.cases)
  it("operands 1.39.0 wrote, operands it refused, and operands it refused after reading", () => {
    expect(cases.filter(([, was]) => wrote(was)).length).toBeGreaterThan(200)
    const refused = cases.filter(([, was]) => refusedOperand(was))
    expect(refused.length).toBeGreaterThan(60)
    // The ones the timing changes: 1.39.0 had sent a read before it refused.
    expect(refused.filter(([, was]) => was.requests.length > 0).length).toBeGreaterThan(40)
  })
  it("every case resolved since is one 1.39.0 wrote and then couldn't read, or refused", () => {
    for (const [name, [since]] of RESOLVED) {
      const each = matrix.filter((one) => nameOf(one.key) === name)
      expect(each.length).toBeGreaterThan(0)
      for (const one of each) {
        const was = fixture.cases[one.key]!
        if (since === "refused where stored") {
          // A `pathIfNotExists` operand 1.39.0 refused before reading the row.
          expect(refusedOperand(was)).toBe(true)
          continue
        }
        expect(wrote(was)).toBe(true)
        expect(was.reads).toBe(false)
      }
    }
  })
  it("1.39.0 never refused an operand after writing", () => {
    for (const [, was] of cases) if (refusedOperand(was)) expect(wrote(was)).toBe(false)
  })
})
