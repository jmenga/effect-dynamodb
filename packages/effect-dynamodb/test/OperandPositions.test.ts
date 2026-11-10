/**
 * A path operation's operand is sent as the published 1.39.0 sent it, wherever it sits.
 *
 * This is a matrix, not a list of cases someone thought of: every way a schema can wrap a value
 * (`helpers/OperandPositions.ts`: a struct, a record, a sparse map's entry, a list, a tuple, a
 * union, a class, a suspended, transformed, checked, flipped or branded schema, a default, a
 * packed or renamed field), crossed with every path operation that carries an operand, with three
 * operands, and with three ways of sending the update. `fixtures/operand-positions-1.39.0.json`
 * and `fixtures/operand-positions-retained-1.39.0.json` hold what 1.39.0 did for each. For every
 * case (`helpers/Against139.ts`):
 *
 * - where 1.39.0 sent a write, this source sends the same requests, byte for byte, and the update
 *   ends as it ended;
 * - where 1.39.0 refused the operand, this source refuses it with the same error and sends
 *   nothing, where a retained entity's update had read the row first;
 * - nothing else changes: no position 1.39.0 didn't check is checked, and no operand is encoded
 *   otherwise than 1.39.0 encoded it.
 */

import { readFileSync } from "node:fs"
import { it } from "@effect/vitest"
import { Effect } from "effect"
import { afterEach, beforeEach, describe, expect, vi } from "vitest"
import * as Lib from "../src/index.js"
import { expectAs139, type Outcome, refusedOperand } from "./helpers/Against139.js"
import { capture, kinds, matrix } from "./helpers/OperandPositions.js"

const read = (name: string) =>
  (
    JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as {
      readonly cases: Record<string, Outcome>
    }
  ).cases
/** An update alone and in a transaction in one file, a retained entity's in another. */
const fixture = {
  cases: {
    ...read("operand-positions-1.39.0.json"),
    ...read("operand-positions-retained-1.39.0.json"),
  },
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

describe("the matrix of operand positions against published 1.39.0", () => {
  it("the fixture holds every case", () => {
    expect(Object.keys(fixture.cases).sort()).toEqual(matrix.map((each) => each.key).sort())
  })

  for (const kind of kinds) {
    describe(kind.name, () => {
      for (const each of matrix.filter((one) => one.kind === kind)) {
        it.effect(`${each.op} / ${each.operand} / ${each.sending}`, () =>
          Effect.gen(function* () {
            expectAs139(
              yield* capture(Lib as never, each),
              fixture.cases[each.key]!,
              // The release branch reads a row 1.39.0 wrote here and then couldn't decode.
              kind.name === "a decoding default" && each.operand === "valid only encoded"
                ? "reads"
                : undefined,
            )
          }),
        )
      }
    })
  }

  it("a retained entity's update read the row before 1.39.0 refused its operand", () => {
    const refused = matrix.filter((each) => refusedOperand(fixture.cases[each.key]!))
    expect(refused.length).toBeGreaterThan(200)
    for (const each of refused) {
      expect(fixture.cases[each.key]!.requests.map((request) => request.command)).toEqual(
        each.sending === "retained" ? ["GetItem"] : [],
      )
    }
  })
})
