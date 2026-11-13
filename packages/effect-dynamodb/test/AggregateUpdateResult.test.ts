/**
 * What an aggregate's `update` returns (#241, `helpers/AggregateUpdateResult.ts`): published
 * 1.40.0's object, the state the mutation produced as decoded (its classes, its element order, its
 * own properties, an explicit `undefined`), with one change: a copy of a context attribute a
 * member's value holds is set to what its row holds after the write. Against what published 1.40.0
 * returned, sent and stored for each step (`fixtures/aggregate-update-result-1.40.0.json`), from the
 * rows its `create` wrote. A `get` right after may read otherwise (element order, a custom
 * `assemble`, a row's key text), as on 1.40.0.
 */

import { readFileSync } from "node:fs"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Cause, DateTime, Effect, Exit, Layer, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Aggregate from "../src/Aggregate.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Table from "../src/Table.js"
import {
  cases,
  type Recorded,
  type Row,
  runStep,
  sortRows,
  stamped,
  stepsOf,
  type UpdateLib,
  withCopiesAsRoot,
} from "./helpers/AggregateUpdateResult.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

const published: {
  readonly generatedFrom: ReadonlyArray<string>
  readonly "1.40.0": Record<string, Recorded>
} = JSON.parse(
  readFileSync(new URL("./fixtures/aggregate-update-result-1.40.0.json", import.meta.url), "utf8"),
)

const lib: UpdateLib = {
  Aggregate,
  DynamoClient,
  Table,
  DynamoSchema,
  Schema,
  Effect,
  Exit,
  Cause,
  Layer,
  DateTime,
}

let made = 0
const run = (c: (typeof cases)[number], step: string, created: ReadonlyArray<Row>) => {
  const tableName = `update-result-${made++}`
  const table = makeRecordingTable({ indexes: { gsi1: { pk: "status", sk: "gsi1sk" } } })
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
    runStep(lib, c, step, { tableName, client: table.client, take, scan, seed }, created),
  )
}

/** As text, so key order, element order and every tag count. */
const text = (value: unknown) => JSON.stringify(stamped(value))

describe("an aggregate's update returns 1.40.0's object, context copies as their rows hold them", () => {
  it("the fixture is published 1.40.0's, for every case and step", () => {
    expect(published.generatedFrom).toEqual(["effect-dynamodb@1.40.0"])
    expect(Object.keys(published["1.40.0"])).toEqual(cases.map((c) => c.name))
    for (const c of cases) {
      const then = published["1.40.0"][c.name]!
      expect(then.create.failed).toBeUndefined()
      expect(Object.keys(then.steps)).toEqual(stepsOf(lib, c))
      for (const step of Object.values(then.steps)) expect(step.update.failed).toBeUndefined()
    }
  })

  for (const c of cases) {
    const then = published["1.40.0"][c.name]!
    for (const step of stepsOf(lib, c)) {
      const was = then.steps[step]!
      it(`${c.name}, ${step}: sends and stores what 1.40.0 did, and returns its object`, async () => {
        const now = await run(c, step, then.created)
        expect(stamped(now.step.requests)).toEqual(stamped(was.requests))
        expect(stamped(now.step.rows)).toEqual(stamped(was.rows))
        expect(text(now.step.update)).toBe(text({ ok: withCopiesAsRoot(c, was.update.ok) }))
      })
    }
  }

  // The context case's copies, by the rows: 1.40.0 returned the copy read before the write.
  it("a changed context attribute: 1.40.0 returned the old copies, this release the rows'", () => {
    for (const escape of ["off", "on"]) {
      const was =
        published["1.40.0"][
          `context copies held by Unknown, struct and sub-aggregate values, escapeKeys ${escape}`
        ]!.steps["context changed"]!
      const value = was.update.ok as any
      expect(value.tenantId).toBe("t2")
      expect([value.any.tenantId, value.own.tenantId, value.part.tenantId]).toEqual([
        "t1",
        "t1",
        "t1",
      ])
      const rows = was.rows.filter((row) => row.__edd_e__?.S !== "Root")
      for (const row of rows) expect(row.tenantId).toEqual({ S: "t2" })
    }
  })
})
