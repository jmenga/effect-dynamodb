/**
 * Where a path operation's operand is checked, and where it isn't.
 *
 * An operand is checked, and its stored form chosen, only at a position the library resolves
 * exactly: the walk from the field's read schema to the position passes through nothing but the
 * node kinds `EntitySchemas.ts` lists (a struct, a record, a list or tuple, a union, a suspended
 * schema, a `Schema.Class`). Through anything else the position is unknown, and the operand is sent
 * as 1.39.0 sent it.
 *
 * So this is a matrix, not a list of cases someone thought of: every wrapper in
 * `helpers/OperandPositions.ts`, crossed with every path operation that carries an operand and
 * three operands. `fixtures/operand-positions-1.39.0.json` holds what the published 1.39.0 did for
 * each. For every case:
 *
 * - where 1.39.0 wrote and the row read back, this source sends the same requests;
 * - where this source refuses, 1.39.0 refused, failed, or wrote a row that doesn't decode;
 * - through a wrapper marked unknown, this source sends what 1.39.0 sent, whatever the operand;
 * - at a position resolved exactly and outside a union, the row reads back afterwards, an invalid
 *   operand is refused with nothing sent, and a valid one is written.
 *
 * A name the caller supplies is looked up among what a schema declares, never among what every
 * object inherits: the matrix runs `constructor`, `toString`, `valueOf`, `hasOwnProperty` and
 * `__proto__` as a sparse map's entry key, and the last test here runs them as a path's segments.
 */

import { readFileSync } from "node:fs"
import { it } from "@effect/vitest"
import { makePathValueEncoder } from "@effect-dynamodb/schema/internal/EntitySchemas.js"
import { Effect, Schema } from "effect"
import { afterEach, beforeEach, describe, expect, vi } from "vitest"
import * as Lib from "../src/index.js"
import { capture, kinds, matrix, type Outcome, wrote } from "./helpers/OperandPositions.js"

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/operand-positions-1.39.0.json", import.meta.url), "utf8"),
) as { readonly cases: Record<string, Outcome> }

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(1700000000000)
})
afterEach(() => {
  vi.restoreAllMocks()
})

/** What an outcome amounts to. */
const verdict = (outcome: Outcome): "read back" | "refused" | "failed" | "unreadable" =>
  outcome.ok && outcome.reads
    ? "read back"
    : !wrote(outcome)
      ? "refused"
      : outcome.reads
        ? "failed"
        : "unreadable"

describe("the matrix of operand positions against published 1.39.0", () => {
  it("the fixture holds every case", () => {
    expect(Object.keys(fixture.cases)).toEqual(matrix.map((each) => each.key))
  })

  for (const kind of kinds) {
    describe(`${kind.name}${kind.unknown ? " (unknown: sent as 1.39.0)" : kind.union ? " (in a union)" : ""}`, () => {
      for (const each of matrix.filter((one) => one.kind === kind)) {
        it.effect(`${each.op} / ${each.operand}`, () =>
          Effect.gen(function* () {
            const was = fixture.cases[each.key]!
            const got = yield* capture(Lib as never, each)
            // What 1.39.0 wrote and read back is sent byte for byte.
            if (verdict(was) === "read back") {
              expect(got.requests).toEqual(was.requests)
              expect(verdict(got)).toBe("read back")
            }
            // A refusal never takes away something 1.39.0 handled.
            if (verdict(got) === "refused") expect(verdict(was)).not.toBe("read back")
            if (kind.unknown) {
              // Not judged at all: 1.39.0's requests, whatever the operand.
              expect(got.requests).toEqual(was.requests)
              return
            }
            if (each.operand === "invalid") {
              // No reader of the position takes it: nothing is sent.
              expect(verdict(got)).toBe("refused")
              return
            }
            if (kind.union) return
            // Resolved exactly: what is sent reads back, and a valid operand is sent.
            expect(verdict(got)).toBe("read back")
          }),
        )
      }
    })
  }
})

describe("in a transaction, an operand no reader of its position takes is refused before any read", () => {
  for (const each of matrix.filter((one) => !one.kind.unknown && one.operand === "invalid")) {
    it.effect(each.key, () =>
      Effect.gen(function* () {
        const got = yield* capture(Lib as never, each, true)
        expect(got.ok).toBe(false)
        expect(got.requests).toEqual([])
        expect(got.reads).toBe(true)
      }),
    )
  }
})

describe("in a transaction, an operand at an unknown position is sent as it is alone", () => {
  for (const each of matrix.filter((one) => one.kind.unknown)) {
    it.effect(each.key, () =>
      Effect.gen(function* () {
        const alone = yield* capture(Lib as never, each)
        const got = yield* capture(Lib as never, each, true)
        const update = (outcome: Outcome): unknown =>
          outcome.requests.flatMap((request) => {
            const input = request.input as any
            return request.command === "UpdateItem"
              ? [[input.UpdateExpression, input.ExpressionAttributeValues]]
              : request.command === "TransactWriteItems"
                ? input.TransactItems.map((item: any) => [
                    item.Update.UpdateExpression,
                    item.Update.ExpressionAttributeValues,
                  ])
                : []
          })
        expect(update(got)).toEqual(update(alone))
      }),
    )
  }
})

describe("a path's segment is looked up among what a schema declares, never among what every object inherits", () => {
  const fields = {
    id: Schema.String,
    target: Schema.Struct({ n: Schema.NumberFromString }),
  }
  const encoder = makePathValueEncoder(fields, fields)
  for (const name of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"]) {
    for (const segments of [[name], ["target", name], [name, "n"], ["target", name, "n"]]) {
      it(`${JSON.stringify(segments)}: no schema, so the operand is sent as given`, () => {
        for (const kind of ["value", "elements"] as const) {
          const value = kind === "value" ? 7 : [7]
          expect(encoder.encode(segments, value, kind)).toEqual({
            encoded: value,
            issue: undefined,
          })
          expect(encoder.validate(segments, value, kind)).toBeUndefined()
        }
      })
    }
  }
  it("a declared property is still encoded", () => {
    expect(encoder.encode(["target", "n"], 7, "value")).toEqual({ encoded: "7", issue: undefined })
  })
})
