/**
 * A `field:` rename is a top-level attribute's name: below it a path's segments are named as the
 * value stores them. `put` stores `meta.count` as `count` whatever a top-level `count` is renamed
 * to, and a path write, a condition, a filter and a projection each name that attribute
 * (`internal/PathBuilder.ts`'s `storedPath`).
 *
 * On 1.39.0 a path write and a condition renamed every segment, so `["meta", "count"]` named
 * `meta.renamed`: the write added a stray attribute and left `meta.count` as it was, and the
 * condition tested an attribute that isn't there.
 *
 * A path with no such segment sends the requests 1.39.0 sent:
 * `fixtures/nested-path-requests-1.39.0.json` holds them, captured from the published 1.39.0 for
 * every case in `helpers/NestedPathRequests.ts`'s `unaffected`.
 */

import { readFileSync } from "node:fs"
import { it } from "@effect/vitest"
import { Cause, Effect } from "effect"
import { afterEach, beforeEach, describe, expect, vi } from "vitest"
import * as Lib from "../src/index.js"
import { compilePath, storedPath } from "../src/internal/PathBuilder.js"
import { affected, type Captured, capture, matrix, variants } from "./helpers/NestedPathRequests.js"

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/nested-path-requests-1.39.0.json", import.meta.url), "utf8"),
) as { readonly requests: Record<string, ReadonlyArray<unknown>> }

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

/** The stored names a renamed top-level field goes under: none of them is a property below one. */
const RENAMED = ["renamed", "items", "labels", "label"]

/** Every expression a request sends for item `a`, with the names it binds. */
const expressions = (
  got: Captured,
): ReadonlyArray<{ readonly text: string; readonly names: Record<string, string> }> =>
  got.requests.flatMap((request) => {
    const inputs: ReadonlyArray<any> =
      request.command === "TransactWriteItems"
        ? request.input.TransactItems.flatMap((item: any) => Object.values(item))
        : [request.input]
    return inputs
      .filter((input) => input.Key === undefined || input.Key.pk?.S?.endsWith("id_a"))
      .map((input) => ({
        text: [
          input.UpdateExpression,
          input.ConditionExpression,
          input.FilterExpression,
          input.ProjectionExpression,
        ]
          .filter((part) => part !== undefined)
          .join(" | "),
        names: (input.ExpressionAttributeNames ?? {}) as Record<string, string>,
      }))
  })

/** The dotted paths an expression names, each as stored names. */
const pathsNamed = (got: Captured): ReadonlyArray<string> =>
  expressions(got).flatMap(({ text, names }) =>
    (text.match(/#\w+(?:(?:\[\d+\])?\.#\w+)*/g) ?? []).map((path) =>
      path
        .split(".")
        .map((part) => names[part.replace(/\[\d+\]$/, "")] ?? part)
        .join("."),
    ),
  )

const at = (row: Record<string, any> | undefined, path: ReadonlyArray<string>): unknown => {
  let current: any = row
  for (const [i, segment] of path.entries()) {
    current = i === 0 ? current?.[segment] : current?.M?.[segment]
  }
  return current
}

describe("a path with no segment spelled as a renamed field sends the requests 1.39.0 sent", () => {
  it("the fixture holds every case", () => {
    expect(Object.keys(fixture.requests)).toEqual(matrix.map((each) => each.key))
  })
  for (const each of matrix) {
    it.effect(each.key, () =>
      Effect.gen(function* () {
        const got = yield* capture(Lib as never, each.variant, each.transaction, each.each)
        expect(got.error === undefined ? undefined : Cause.squash(got.error as never)).toBe(
          undefined,
        )
        expect(got.requests).toEqual(fixture.requests[each.key])
      }),
    )
  }
})

describe("a segment below a field is named as the value stores it, whatever a top-level field of that name is renamed to", () => {
  for (const variant of variants) {
    for (const each of affected) {
      for (const transaction of each.reads || each.aloneOnly ? [false] : [false, true]) {
        it.effect(`${each.name}, ${variant}, ${transaction ? "in a transaction" : "alone"}`, () =>
          Effect.gen(function* () {
            const got = yield* capture(Lib as never, variant, transaction, each)
            // The path the case is about is named as `put` stored it, and no renamed attribute's
            // name appears below a field.
            const named = pathsNamed(got)
            expect(named).toContain(each.named ?? each.at.join("."))
            for (const path of named) {
              const [, ...below] = path.split(".")
              for (const stored of RENAMED) expect(below).not.toContain(stored)
            }
            if (each.namesOnly) return
            expect(got.error === undefined ? undefined : Cause.squash(got.error as never)).toBe(
              undefined,
            )
            if (each.reads) {
              expect((got.collected as ReadonlyArray<unknown>).length).toBe(2)
              return
            }
            if (!("stored" in each)) {
              expect(got.row).toBeUndefined()
              return
            }
            expect(at(got.row, each.at)).toEqual(each.stored)
            // No stray attribute: what a map held is what `put` stored there.
            expect(Object.keys(got.row!.meta.M).filter((key) => RENAMED.includes(key))).toEqual([])
            expect(Object.keys(got.row!.owner.M).sort()).toEqual(["count", "id", "name"])
            expect(got.read).toBeDefined()
          }),
        )
      }
    }
  }
})

describe("one function says what a path is stored as", () => {
  const resolve = (name: string) => ({ count: "renamed", list: "items" })[name] ?? name
  it("storedPath maps the first segment and leaves the rest", () => {
    expect(storedPath(["count"], resolve)).toEqual(["renamed"])
    expect(storedPath(["meta", "count"], resolve)).toEqual(["meta", "count"])
    expect(storedPath(["list", 0, "count"], resolve)).toEqual(["items", 0, "count"])
    expect(storedPath(["count", "count", "list"], resolve)).toEqual(["renamed", "count", "list"])
  })
  it("compilePath names the attributes storedPath gives, a first segment holding `#` as it is", () => {
    const names: Record<string, string> = {}
    const counter = { value: 0 }
    expect(compilePath(["list", 0, "count"], names, "p", counter, resolve)).toBe("#p0[0].#p1")
    expect(compilePath(["data#count", "count"], names, "p", counter, resolve)).toBe("#p2.#p3")
    expect(names).toEqual({ "#p0": "items", "#p1": "count", "#p2": "data#count", "#p3": "count" })
  })
})
