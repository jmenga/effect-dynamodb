/**
 * `context` naming an attribute the library manages on each row (#241,
 * `helpers/AggregateManagedContext.ts`): a sub-aggregate's or a one edge's discriminator, a timestamp
 * (declared on the root or not, renamed), a key attribute, a member's own field, a `many` edge's key
 * composite. What the library writes there is its own value for the row, never a context copy, so
 * the stale-context repair never takes it for one: ten no-op updates send ten `Query`s and nothing
 * else, before and after an update of the root alone, and every request is 1.40.0's
 * (`fixtures/aggregate-managed-context-1.40.0.json`), on the rows 1.40.0 wrote and on this
 * release's own.
 */

import { readFileSync } from "node:fs"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Aggregate from "../src/Aggregate.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Table from "../src/Table.js"
import {
  type ManagedLib,
  type Recorded,
  type Row,
  runManaged,
  shapeNames,
  sortRows,
  steps,
} from "./helpers/AggregateManagedContext.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

const published: {
  readonly generatedFrom: ReadonlyArray<string>
  readonly "1.40.0": Record<string, Recorded>
} = JSON.parse(
  readFileSync(
    new URL("./fixtures/aggregate-managed-context-1.40.0.json", import.meta.url),
    "utf8",
  ),
)

const lib: ManagedLib = {
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

/** A timestamp the library stamps, as compared: its text differs on every run. */
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const stamped = (value: unknown): unknown =>
  JSON.parse(
    JSON.stringify(value, (_key, v) => (typeof v === "string" && STAMP.test(v) ? "<stamp>" : v)),
  )

let made = 0
const run = (name: string, created?: ReadonlyArray<Row>) => {
  const tableName = `managed-${made++}`
  const table = makeRecordingTable({
    indexes: { lsi1: { pk: "pk", sk: "csk" }, gsi1: { pk: "status", sk: "gsi1sk" } },
  })
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
    runManaged(lib, name, { tableName, client: table.client, take, scan, seed }, created),
  )
}

/**
 * A root field that is also a key attribute: `create` refuses it (`EDD-9159`), as the upgrade sweep
 * pins (1.40.0's `get` handed back the key's text). On 1.40.0's rows the updates are as 1.40.0's.
 */
const REFUSED_AT_CREATE = new Set(["the key attribute: the list partition key attribute status"])

const commands = (now: Recorded) =>
  now.steps.map(({ step, requests }) => ({ step, sent: requests.map((r) => r.command) }))

describe("context naming an attribute the library manages: a healthy aggregate's updates send 1.40.0's requests", () => {
  it("the fixture is published 1.40.0's, for every shape", () => {
    expect(published.generatedFrom).toEqual(["effect-dynamodb@1.40.0"])
    expect(Object.keys(published["1.40.0"])).toEqual([...shapeNames])
    for (const name of shapeNames) {
      const then = published["1.40.0"][name]!
      expect(then.create).toEqual({ ok: true })
      expect(commands(then)).toEqual(
        steps.map(({ step }) => ({
          step,
          sent: step === "root title" ? ["Query", "TransactWriteItems"] : ["Query"],
        })),
      )
    }
  })

  for (const name of shapeNames) {
    const then = published["1.40.0"][name]!
    it(`${name}, on 1.40.0's rows: each no-op sends one Query, the root's update one transaction`, async () => {
      const now = await run(name, then.created)
      expect(commands(now)).toEqual(commands(then))
      expect(stamped(now.steps)).toEqual(stamped(then.steps))
    })
    if (REFUSED_AT_CREATE.has(name)) {
      it(`${name}, created by this release: refused (EDD-9159)`, async () => {
        const now = await run(name)
        expect(now.create.failed).toBe("AggregateDecompositionError")
        expect(now.created).toEqual([])
      })
      continue
    }
    it(`${name}, created by this release: as 1.40.0`, async () => {
      const now = await run(name)
      expect(now.create).toEqual({ ok: true })
      expect(stamped(now.created)).toEqual(stamped(then.created))
      expect(commands(now)).toEqual(commands(then))
      expect(stamped(now.steps)).toEqual(stamped(then.steps))
    })
  }
})
