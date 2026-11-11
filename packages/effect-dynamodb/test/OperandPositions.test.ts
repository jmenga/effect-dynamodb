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
 * - where 1.39.0 wrote a row that didn't read, at a position the read schema resolves exactly
 *   (#236: `RESOLVED`), the operand none of the position's readers reads is refused with nothing
 *   sent, and one only its encoded form is valid for is stored as its reader reads it;
 * - nothing else changes: no other position 1.39.0 didn't check is checked, and no operand is
 *   encoded otherwise than 1.39.0 encoded it.
 */

import { readFileSync } from "node:fs"
import { it } from "@effect/vitest"
import { Effect } from "effect"
import { afterEach, beforeEach, describe, expect, vi } from "vitest"
import * as Lib from "../src/index.js"
import {
  expectAs139,
  type Outcome,
  refusedOperand,
  type Since139,
  wrote,
} from "./helpers/Against139.js"
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

/**
 * The positions 1.39.0 didn't check that a walk of the read schema resolves exactly (#236), where
 * 1.39.0 wrote rows that didn't read, each with the operands that now change: an `invalid` one no
 * reader there reads is refused, and one `valid only encoded` is stored as its reader reads it
 * back. Everywhere else (an `Option`, a decoding default, a transformed struct or list, an entry
 * keyed `__proto__`, ...) the operand is sent as 1.39.0 sent it. So is the `7` given in a union's
 * member whose `n` is text: the union's other member reads it, so it isn't one no row reads, and
 * the member the row holds is the read's to decide, as it always was.
 */
const both = new Set(["invalid", "valid only encoded"])
const invalid = new Set(["invalid"])
const RESOLVED: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["a sparse map's entry", invalid],
  ["a sparse map's entry that is the value", invalid],
  ["a sparse map's entry that is a list", invalid],
  ["a union in a sparse map's entry", invalid],
  ["a Schema.Class in a sparse map's entry", invalid],
  ["a suspended schema", both],
  ["a branded struct", both],
  ["a recursive struct", both],
  ["a recursive struct's child", both],
  ["a sparse map's entry keyed `constructor`", invalid],
  ["a sparse map's entry keyed `toString`", invalid],
  ["a sparse map's entry keyed `valueOf`", invalid],
  ["a sparse map's entry keyed `hasOwnProperty`", invalid],
])

/** What this source does otherwise than 1.39.0 for a case, if anything. */
const since = (kind: string, operand: string, was: Outcome): Since139 | undefined => {
  // The release branch reads a row 1.39.0 wrote here and then couldn't decode.
  if (kind === "a decoding default" && operand === "valid only encoded") return "reads"
  // It reads an entry keyed `__proto__`, which 1.39.0's read dropped.
  if (kind.endsWith("keyed `__proto__`") && operand === "invalid") return "reads the entry"
  if (RESOLVED.get(kind)?.has(operand) === true && wrote(was) && !was.reads) {
    return operand === "invalid" ? "refuses what wouldn't read" : "stores what reads"
  }
  return undefined
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
            const was = fixture.cases[each.key]!
            expectAs139(
              yield* capture(Lib as never, each),
              was,
              since(kind.name, each.operand, was),
            )
          }),
        )
      }
    })
  }

  it("every resolved position changes a case 1.39.0 left unreadable", () => {
    // Each kind and operand named changes some case, so the list holds nothing that doesn't.
    for (const [name, operands] of RESOLVED) {
      for (const operand of operands) {
        expect(
          matrix.some(
            (each) =>
              each.kind.name === name &&
              each.operand === operand &&
              since(name, operand, fixture.cases[each.key]!) !== undefined,
          ),
        ).toBe(true)
      }
    }
  })

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
