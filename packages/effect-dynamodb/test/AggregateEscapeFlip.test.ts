/**
 * `escapeKeys` turned over without `rekey` (#241, `EDD-9160`, `helpers/AggregateEscapeFlip.ts`). A
 * row's sort key text can differ between the two settings: a `$`, `#` or other escaped character in
 * a `many` element's sort key value or a discriminator value, and a number other than a
 * non-negative integer below 1e16. Up to 1.40.0 an update under the other setting wrote such a
 * group's rows under this setting's text and left the ones it read where they were, so every
 * element read twice, or a sub-aggregate didn't read at all, or (texts aliasing across the
 * settings) one element's row overwrote another's. Against what published 1.40.0 did with each step
 * (`fixtures/aggregate-escape-flip-1.40.0.json`), from the rows its `create` wrote:
 *
 * - where 1.40.0's `get` after the update read what the update returned, the update sends, stores
 *   and returns what 1.40.0 did, request for request;
 * - where it read something else, the update is refused with `EDD-9160` naming the member, the row
 *   and `rekey`, after its `Query` and before anything is written.
 */

import { readFileSync } from "node:fs"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Aggregate from "../src/Aggregate.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Table from "../src/Table.js"
import {
  cases,
  type FlipLib,
  type Recorded,
  type Row,
  runFlip,
  sortRows,
  stepNames,
} from "./helpers/AggregateEscapeFlip.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

const published: {
  readonly generatedFrom: ReadonlyArray<string>
  readonly "1.40.0": Record<string, Recorded>
} = JSON.parse(
  readFileSync(new URL("./fixtures/aggregate-escape-flip-1.40.0.json", import.meta.url), "utf8"),
)

const lib: FlipLib = {
  Aggregate,
  DynamoClient,
  Table,
  DynamoSchema,
  Schema,
  Effect,
  Exit,
  Cause,
  Layer,
}

let made = 0
const run = (
  c: (typeof cases)[number],
  step: (typeof stepNames)[number],
  created: ReadonlyArray<Row>,
) => {
  const tableName = `flip-${made++}`
  const table = makeRecordingTable()
  const take = () =>
    table.take().map(({ command, input }) => ({
      command,
      input: JSON.parse(JSON.stringify(input).replaceAll(tableName, "<table>")),
    }))
  const scan = () => Effect.sync(() => sortRows([...table.items.values()] as ReadonlyArray<Row>))
  const seed = (rows: ReadonlyArray<Row>) =>
    Effect.sync(() => {
      for (const row of rows) table.items.set(`${row.pk?.S}|${row.sk?.S}`, structuredClone(row))
    })
  return Effect.runPromise(
    runFlip(lib, c, step, { tableName, client: table.client, take, scan, seed }, created),
  )
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

describe("escapeKeys turned over without rekey (EDD-9160)", () => {
  it("the fixture is published 1.40.0's, for every case and step", () => {
    expect(published.generatedFrom).toEqual(["effect-dynamodb@1.40.0"])
    expect(Object.keys(published["1.40.0"])).toEqual(cases.map((c) => c.name))
    for (const c of cases) {
      expect(Object.keys(published["1.40.0"][c.name]!.steps)).toEqual([...stepNames])
    }
  })

  for (const c of cases) {
    const then = published["1.40.0"][c.name]!
    for (const step of stepNames) {
      const was = then.steps[step]!
      const misread = was.get.ok === undefined || !same(was.update.ok, was.get.ok)
      const title = misread
        ? "1.40.0's get read otherwise than its update returned: refused, nothing written"
        : "sends, stores and returns what 1.40.0 did"
      it(`${c.name}, ${step}: ${title}`, async () => {
        const now = await run(c, step, then.created)
        if (misread) {
          expect(now.step.update.failed).toBe("ValidationError")
          expect(now.step.update.cause).toMatch(
            /^\[EDD-9160\] Aggregate "Root": a row of "(lines|part|bits)" is stored under the sort key "\$flip#v1#[^"]+", the text the other `escapeKeys` setting composes; .*`rekey`/,
          )
          expect(now.step.requests.map((request) => request.command)).toEqual(["Query"])
          expect(now.step.rows).toEqual(then.created)
          return
        }
        expect(now.step.requests).toEqual(was.requests)
        expect(now.step.rows).toEqual(was.rows)
        expect(now.step.update).toEqual(was.update)
        expect(now.step.get).toEqual(was.get)
      })
    }
  }
})
