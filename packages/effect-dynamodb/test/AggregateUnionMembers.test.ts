/**
 * An aggregate takes, stores and reads back a union element, and a field transformed to `Unknown`,
 * as 1.39.0 did. `fixtures/aggregate-union-members-1.39.0.json` holds what published 1.39.0 sent,
 * stored and returned on DynamoDB Local for each shape in `helpers/UnionMemberShapes.ts`: `create`,
 * `get`, an `update` handing the state back, and `get`. Each runs here on a recording table and
 * does the same. A value is compared as JSON text, so its keys' order counts; a failure by its tag
 * and operation (the issue's wording differs: the substituted member reports its own).
 *
 * Two element shapes changed on the release branch before this, and their neighbours with them:
 *   - a member's value given a string `lineId` the edge fetches as `line`, in a union whose members
 *     transform to `Unknown` or a declaration, was created with the fetched record in it, the
 *     caller's `line` and `lineId` gone; 1.39.0 refused it and wrote nothing;
 *   - the other member given to a union whose wrapping member transforms to `Unknown` read back
 *     with the row's attributes in their stored order and a sub-aggregate's discriminator in it.
 * A field transformed to `Unknown` given a value its transformation can't store was stored as given;
 * 1.39.0 refused it.
 *
 * `create` given a value in the form a transformation to `Unknown` stores also returned what 1.39.0
 * did not: a field's value undecoded, and a `Line` as a plain object where 1.39.0 returned the
 * instance. `fixtures/aggregate-create-result-1.39.0.json` holds 1.39.0's for those fields, and for
 * the element shapes of a union whose other member renames a field (`compareCreateResult`).
 */
import { readFileSync } from "node:fs"
import { it } from "@effect/vitest"
import { Effect } from "effect"
import { describe, expect } from "vitest"
import { makeRecordingTable } from "./helpers/RecordingTable.js"
import {
  compareCreateResult,
  createResultFieldShapes,
  elementShapes,
  fieldShapes,
  judged,
  type Recorded,
  renameShapes,
  runShape,
  sortedRows,
} from "./helpers/UnionMemberShapes.js"

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/aggregate-union-members-1.39.0.json", import.meta.url), "utf8"),
) as {
  readonly generatedFrom: string
  readonly elements: Record<string, Recorded>
  readonly fields: Record<string, Recorded>
}

const createResults = JSON.parse(
  readFileSync(new URL("./fixtures/aggregate-create-result-1.39.0.json", import.meta.url), "utf8"),
) as {
  readonly generatedFrom: string
  readonly fields: Record<string, Recorded>
  readonly renames: Record<string, Recorded>
}

const onRecordingTable = () => {
  const table = makeRecordingTable()
  return {
    layer: table.layer,
    tableName: "<table>",
    take: () =>
      table.take().map(({ command, input }) => ({
        op: command.charAt(0).toLowerCase() + command.slice(1),
        input: JSON.parse(JSON.stringify(input)),
      })),
    rows: () => Effect.sync(() => sortedRows(table.items.values()) as ReadonlyArray<unknown>),
  }
}

const compare = (actual: Recorded, expected: Recorded) => {
  for (const step of ["create", "get", "update", "getAfterUpdate"] as const) {
    expect({ step, ...judged(actual[step]) }).toEqual({ step, ...judged(expected[step]) })
  }
  expect(actual.requests).toEqual(expected.requests)
  expect(actual.rows).toEqual(expected.rows)
  expect(actual.updateRequests).toEqual(expected.updateRequests)
  expect(actual.updateRows).toEqual(expected.updateRows)
}

describe("an aggregate's union elements and fields transformed to Unknown, as 1.39.0 had them", () => {
  const elements = elementShapes()
  const fields = fieldShapes()

  it("the fixture is published 1.39.0's, and holds every shape", () => {
    expect(fixture.generatedFrom).toBe("effect-dynamodb@1.39.0")
    expect(Object.keys(fixture.elements).sort()).toEqual(Object.keys(elements).sort())
    expect(Object.keys(fixture.fields).sort()).toEqual(Object.keys(fields).sort())
  })

  for (const [group, shapes] of [
    ["elements", elements],
    ["fields", fields],
  ] as const) {
    for (const [label, define] of Object.entries(shapes)) {
      it.effect(`${label}: sends, stores and returns what 1.39.0 did`, () =>
        Effect.gen(function* () {
          const actual = yield* runShape(define, onRecordingTable())
          compare(actual, fixture[group][label]!)
        }),
      )
    }
  }
})

describe("an aggregate's create returns what 1.39.0 did", () => {
  const fields = createResultFieldShapes()
  const renames = renameShapes()

  it("the fixture is published 1.39.0's, and holds every shape", () => {
    expect(createResults.generatedFrom).toBe("effect-dynamodb@1.39.0")
    expect(Object.keys(createResults.fields).sort()).toEqual(Object.keys(fields).sort())
    expect(Object.keys(createResults.renames).sort()).toEqual(Object.keys(renames).sort())
  })

  for (const [group, shapes] of [
    ["fields", fields],
    ["renames", renames],
  ] as const) {
    for (const [label, define] of Object.entries(shapes)) {
      it.effect(`${label}: create returns what 1.39.0 did`, () =>
        Effect.gen(function* () {
          const actual = yield* runShape(define, onRecordingTable())
          compareCreateResult(group, label, actual, createResults[group][label]!)
        }),
      )
    }
  }
})
