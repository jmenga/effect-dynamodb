/**
 * What an update's path operand is written as.
 *
 * An operand 1.39.0 accepted sends the requests 1.39.0 sent. `fixtures/update-operand-requests-1.39.0.json`
 * holds them, captured from the published 1.39.0 for every case in `helpers/UpdateOperandRequests.ts`:
 * each combinator on a path the model names, on a path naming a sparse map's entry, into a union and
 * as a copy, on four kinds of entity, alone and in a transaction.
 *
 * The rest pins the rules an operand's stored form follows:
 * - what 1.39.0 sent is sent whenever the row's reader reads it back; otherwise the operand is
 *   encoded by its schema, and refused when the reader doesn't read that either;
 * - an operand 1.39.0 refused is refused, before anything is read or sent;
 * - the walk that names the attribute an operation writes picks the schema that checks it, for a
 *   path operation and for a record operation alike;
 * - inside a union, the members' schema is used only where they agree on the stored value;
 * - a copy has no operand.
 */

import { readFileSync } from "node:fs"
import { it } from "@effect/vitest"
import { Cause, Effect } from "effect"
import { afterEach, beforeEach, describe, expect, vi } from "vitest"
import * as Lib from "../src/index.js"
import {
  type Captured,
  capture,
  matrix,
  plain,
  variants,
  type World,
} from "./helpers/UpdateOperandRequests.js"

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/update-operand-requests-1.39.0.json", import.meta.url), "utf8"),
) as { readonly requests: Record<string, ReadonlyArray<unknown>> }

const api = Lib as never

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

const run = (
  variant: (typeof variants)[number],
  transaction: boolean,
  apply: (update: any) => any,
  seeded?: Record<string, unknown>,
  world?: World,
): Effect.Effect<Captured> => capture(api, variant, transaction, apply, seeded, world)

/** The value an update's `SET` wrote for item `a`, by its placeholder's prefix. */
const written = (got: Captured, prefix: string): unknown => {
  const updates = got.requests.flatMap((request) => {
    const input = request.input as any
    return request.command === "UpdateItem"
      ? [input]
      : request.command === "TransactWriteItems"
        ? input.TransactItems.flatMap((item: any) => (item.Update ? [item.Update] : []))
        : []
  })
  const update = updates.find((input: any) => input.Key.pk.S.endsWith("id_a"))
  const key = Object.keys(update?.ExpressionAttributeValues ?? {}).find((name) =>
    name.startsWith(prefix),
  )
  return key === undefined ? undefined : update.ExpressionAttributeValues[key]
}

const refusedWithNothingSent = (got: Captured, operation: string) => {
  expect(got.ok).toBe(false)
  const cause = got.error as Cause.Cause<unknown>
  expect(cause.reasons[0]!._tag).toBe("Fail")
  const error = Cause.squash(cause) as any
  expect(error._tag).toBe("ValidationError")
  expect(error.operation).toBe(operation)
  expect(got.requests).toEqual([])
}

const set = (segments: ReadonlyArray<string | number>, value: unknown) => (update: any) =>
  update.pathSet({ segments, value, isPath: false })

describe("an operand 1.39.0 accepted sends the requests 1.39.0 sent", () => {
  it("the fixture holds every case", () => {
    expect(Object.keys(fixture.requests)).toEqual(matrix.map((each) => each.key))
  })
  for (const each of matrix) {
    it.effect(each.key, () =>
      Effect.gen(function* () {
        const got = yield* run(each.variant, each.transaction, each.apply, {}, each.world)
        expect(got.requests).toEqual(fixture.requests[each.key])
        expect(got.ok).toBe(true)
        expect(got.reads).toBe(true)
      }),
    )
  }
})

describe("a path's operand is encoded by the schema of the attribute the path names", () => {
  // `count` is stored as `renamed`, and a rename is a top-level attribute's name: below a field,
  // a path's `count` names the property `count`, which is a number stored as text.
  for (const transaction of [false, true]) {
    it.effect(
      `a property named as a renamed field, ${transaction ? "in a transaction" : "alone"}`,
      () =>
        Effect.gen(function* () {
          const got = yield* run("plain", transaction, set(["tally", "count"], 2))
          expect(got.ok).toBe(true)
          expect(written(got, ":ps")).toEqual({ S: "2" })
          expect(got.row?.tally).toEqual({ M: { count: { S: "2" }, renamed: { N: "1" } } })
          expect(got.reads).toBe(true)
        }),
    )
    it.effect(
      `the same in a sparse map's entry, ${transaction ? "in a transaction" : "alone"}`,
      () =>
        Effect.gen(function* () {
          const got = yield* run("plain", transaction, set(["tallies#a", "count"], 2))
          expect(got.ok).toBe(true)
          // An entry's operand is sent as given where the row's reader reads it back.
          expect(written(got, ":ps")).toEqual({ N: "2" })
          expect(got.row?.["tallies#a"]).toEqual({ M: { count: { N: "2" }, renamed: { N: "1" } } })
          expect(got.reads).toBe(true)
        }),
    )
  }
})

describe("inside a union, an operand is encoded only where the members agree", () => {
  for (const variant of variants) {
    for (const transaction of [false, true]) {
      const where = `${variant}, ${transaction ? "in a transaction" : "alone"}`

      it.effect(
        `members that store a value differently: an entry's is written as given (${where})`,
        () =>
          Effect.gen(function* () {
            // `codes#a` holds the second member, whose `value` is a number.
            const got = yield* run(variant, transaction, set(["codes#a", "value"], 2))
            expect(got.ok).toBe(true)
            expect(written(got, ":ps")).toEqual({ N: "2" })
            expect(got.reads).toBe(true)
          }),
      )

      it.effect(
        `on a path the model names, a value the first member refuses is refused, as on 1.39.0 (${where})`,
        () =>
          Effect.gen(function* () {
            // The row holds the first member. Written by the second, it would stop decoding.
            const got = yield* run(variant, transaction, set(["shape", "value"], "new"))
            refusedWithNothingSent(got, "update.pathSet")
            expect(got.reads).toBe(true)
          }),
      )

      it.effect(
        `in a sparse map's entry, a value only a later member reads is written as given (${where})`,
        () =>
          Effect.gen(function* () {
            const got = yield* run(variant, transaction, set(["shapes#a", "value"], "new"))
            expect(got.ok).toBe(true)
            expect(written(got, ":ps")).toEqual({ S: "new" })
            expect(got.reads).toBe(true)
          }),
      )

      it.effect(`a value no member takes is refused with nothing sent (${where})`, () =>
        Effect.gen(function* () {
          refusedWithNothingSent(
            yield* run(variant, transaction, set(["shape", "value"], true)),
            "update.pathSet",
          )
          refusedWithNothingSent(
            yield* run(variant, transaction, set(["shapes#a", "value"], true)),
            "update.pathSet",
          )
        }),
      )

      it.effect(
        `members that disagree, and none reads the value as given: refused with nothing sent (${where})`,
        () =>
          Effect.gen(function* () {
            // Either member would store `2` as text, `"2"` or `"n2"`, and the entry holds the second.
            refusedWithNothingSent(
              yield* run(variant, transaction, set(["rivals#a", "value"], 2)),
              "update.pathSet",
            )
          }),
      )
    }
  }

  it.effect(
    "on a path the model names, members that disagree write the first member's form, as 1.39.0 did",
    () =>
      Effect.gen(function* () {
        const got = yield* run("plain", false, set(["coded", "value"], 2))
        expect(written(got, ":ps")).toEqual({ S: "2" })
        expect(got.reads).toBe(true)
      }),
  )

  for (const [name, apply, value] of [
    ["pathAppend", (u: any) => u.pathAppend({ segments: ["codes#a", "list"], value: [2] }), 2],
    ["pathPrepend", (u: any) => u.pathPrepend({ segments: ["codes#a", "list"], value: [2] }), 2],
  ] as const) {
    it.effect(`${name} of elements the members store differently writes them as given`, () =>
      Effect.gen(function* () {
        const got = yield* run("plain", false, apply)
        expect(got.ok).toBe(true)
        expect(got.reads).toBe(true)
        const list = got.row?.["codes#a"].M.list.L
        expect(list).toContainEqual({ N: String(value) })
        expect(list).not.toContainEqual({ S: String(value) })
      }),
    )
  }
})

describe("a copy has no operand to check", () => {
  // The entry's `blob` is a custom declaration, so each literal operand is checked as it would
  // read back. A copy names another attribute and holds no literal.
  for (const variant of variants) {
    for (const transaction of [false, true]) {
      for (const [name, segments, valueSegments] of [
        ["a whole entry", ["buckets#a"], ["beside"]],
        ["a property of an entry", ["buckets#a", "blob"], ["beside", "blob"]],
        ["a field", ["beside"], ["buckets#a"]],
        ["a property of a field", ["beside", "blob"], ["buckets#a", "blob"]],
      ] as const) {
        it.effect(`${name}, ${variant}, ${transaction ? "in a transaction" : "alone"}`, () =>
          Effect.gen(function* () {
            const got = yield* run(variant, transaction, (update) =>
              update.pathSet({ segments, value: undefined, isPath: true, valueSegments }),
            )
            expect(got.error === undefined ? undefined : Cause.squash(got.error as never)).toBe(
              undefined,
            )
            expect(got.ok).toBe(true)
            expect(got.reads).toBe(true)
            const sets = plain(got.requests).flatMap((request) => {
              const input = request.input as any
              return request.command === "UpdateItem"
                ? [input.UpdateExpression as string]
                : request.command === "TransactWriteItems"
                  ? input.TransactItems.flatMap((item: any) =>
                      item.Update?.Key.pk.S.endsWith("id_a") ? [item.Update.UpdateExpression] : [],
                    )
                  : []
            })
            expect(
              sets.some((expression: string) => /#ps\d+(\.#ps\d+)? = #ps\d+/.test(expression)),
            ).toBe(true)
          }),
        )
      }
    }
  }
})

describe("what 1.39.0 sent is sent whenever the row's reader reads it back", () => {
  it.effect("a stored form that encoding would rewrite", () =>
    Effect.gen(function* () {
      const got = yield* run("plain", false, set(["buckets#a", "amount"], "007"))
      expect(written(got, ":ps")).toEqual({ S: "007" })
      expect(got.reads).toBe(true)
    }),
  )
  // The reader takes a number where the schema stores text, so 1.39.0's rows hold numbers there.
  for (const [name, segments, value, sent] of [
    ["a whole entry", ["counts#a"], 2, { N: "2" }],
    ["a bigint", ["bigs#a"], 2n, { N: "2" }],
    ["a property", ["slots#a", "amount"], 2, { N: "2" }],
    ["a nested property", ["slots#a", "nested", "amount"], 2, { N: "2" }],
    ["a number its stored form has no text for", ["slots#a", "digit"], 10, { N: "10" }],
  ] as const) {
    it.effect(`${name} given as a number where the schema stores text is sent as given`, () =>
      Effect.gen(function* () {
        const got = yield* run("plain", false, set(segments, value), {}, "stored")
        expect(got.ok).toBe(true)
        expect(written(got, ":ps")).toEqual(sent)
        expect(got.reads).toBe(true)
      }),
    )
  }
  it.effect("list operands given as numbers where the schema stores text are sent as given", () =>
    Effect.gen(function* () {
      const got = yield* run(
        "plain",
        false,
        (update) => update.pathAppend({ segments: ["slots#a", "amounts"], value: [2] }),
        {},
        "stored",
      )
      expect(got.ok).toBe(true)
      expect(written(got, ":pa")).toEqual({ L: [{ N: "2" }] })
      expect(got.reads).toBe(true)
    }),
  )
  it.effect("a value the reader doesn't read is encoded by its schema", () =>
    Effect.gen(function* () {
      // A `Set` isn't what the reader reads for a number stored as a set of one: the schema's
      // encoding of 2 is.
      const got = yield* run("plain", false, set(["sets#a", "value"], 2), {}, "stored")
      expect(got.ok).toBe(true)
      expect(written(got, ":ps")).toEqual({ NS: ["2"] })
      expect(got.reads).toBe(true)
    }),
  )
  for (const transaction of [false, true]) {
    it.effect(
      `a value the reader reads in no form is refused with nothing sent (${transaction ? "in a transaction" : "alone"})`,
      () =>
        Effect.gen(function* () {
          refusedWithNothingSent(
            yield* run("plain", transaction, set(["counts#a"], true), {}, "stored"),
            "update.pathSet",
          )
        }),
    )
  }
})

describe("union members that encode a value to the same stored value agree", () => {
  // Each member encodes 2 to a `Set` of its own holding 2: one stored value, `{ NS: ["2"] }`.
  for (const variant of variants) {
    for (const transaction of [false, true]) {
      it.effect(`a set, ${variant}, ${transaction ? "in a transaction" : "alone"}`, () =>
        Effect.gen(function* () {
          const got = yield* run(variant, transaction, set(["sets#a", "value"], 2), {}, "stored")
          expect(got.error === undefined ? undefined : Cause.squash(got.error as never)).toBe(
            undefined,
          )
          expect(written(got, ":ps")).toEqual({ NS: ["2"] })
          expect(got.reads).toBe(true)
        }),
      )
    }
  }
})

describe("an append to a union of lists is checked against each list's elements", () => {
  for (const transaction of [false, true]) {
    const where = transaction ? "in a transaction" : "alone"
    for (const [name, operation, apply] of [
      [".append()", "update.append", (u: any, value: unknown) => u.append({ either: value })],
      [
        "pathAppend",
        "update.pathAppend",
        (u: any, value: unknown) => u.pathAppend({ segments: ["either"], value }),
      ],
      [
        "pathPrepend",
        "update.pathPrepend",
        (u: any, value: unknown) => u.pathPrepend({ segments: ["either"], value }),
      ],
    ] as const) {
      it.effect(`${name} of elements no list takes is refused with nothing sent (${where})`, () =>
        Effect.gen(function* () {
          const got = yield* run("plain", transaction, (u) => apply(u, [true]), {}, "stored")
          refusedWithNothingSent(got, operation)
          expect(got.reads).toBe(true)
        }),
      )
      it.effect(
        `${name} of elements the lists take between them and none takes whole is refused (${where})`,
        () =>
          Effect.gen(function* () {
            const got = yield* run("plain", transaction, (u) => apply(u, [2, "two"]), {}, "stored")
            refusedWithNothingSent(got, operation)
          }),
      )
      it.effect(`${name} of elements the second list takes is sent as given (${where})`, () =>
        Effect.gen(function* () {
          const got = yield* run(
            "plain",
            transaction,
            (u) => apply(u, ["two"]),
            {
              either: ["one"],
            },
            "stored",
          )
          expect(got.ok).toBe(true)
          expect(got.reads).toBe(true)
          expect(got.row?.either.L).toContainEqual({ S: "two" })
        }),
      )
    }
  }
})

describe("a record operation is checked by the schema of the field it names", () => {
  // `list#x` is a field stored as `storedList`. As a path's segment the same text would name the
  // entry `x` of the sparse map whose prefix is `list`, a list of booleans.
  for (const variant of ["plain", "softDelete", "unique"] as const) {
    for (const transaction of [false, true]) {
      const where = `${variant}, ${transaction ? "in a transaction" : "alone"}`
      it.effect(
        `.append() writes the field's attribute in the field's stored form (${where})`,
        () =>
          Effect.gen(function* () {
            const got = yield* run(
              variant,
              transaction,
              (update) => update.append({ "list#x": [2] }),
              {},
              "named",
            )
            expect(got.error === undefined ? undefined : Cause.squash(got.error as never)).toBe(
              undefined,
            )
            expect(got.row?.storedList).toEqual({ L: [{ S: "1" }, { S: "2" }] })
            expect(got.row?.["list#x"]).toEqual({ L: [{ BOOL: true }] })
            expect(got.reads).toBe(true)
          }),
      )
      it.effect(
        `.append() of elements the field refuses is refused with nothing sent (${where})`,
        () =>
          Effect.gen(function* () {
            refusedWithNothingSent(
              yield* run(variant, transaction, (u) => u.append({ "list#x": [true] }), {}, "named"),
              "update.append",
            )
          }),
      )
    }
  }
})
