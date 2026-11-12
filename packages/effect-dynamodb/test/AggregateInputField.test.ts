/**
 * A `many` edge's value given under its `inputField` (#241, `EDD-9159`,
 * `helpers/AggregateInputField.ts`): `create` looks the value up by the one name the input holds it
 * under (`inputNameIn`) wherever it reads the input (the ids it fetches, the value it decodes, the
 * value `EDD-9159` judges), at the root and beneath a sub-aggregate, with a ref to hydrate or none,
 * under each `escapeKeys` setting.
 * Against what published 1.40.0 did (`fixtures/aggregate-input-field-1.40.0.json`):
 *
 * - an element given the root's `context` value: sent, stored and read as 1.40.0 did;
 * - an element given another value, which 1.40.0 stored and then read back as the root's: refused
 *   by `EDD-9159` whichever name it came under, before anything is written;
 * - 1.40.0 failed `create` (`ValidationError`) for a value under its `inputField` with no ref to
 *   fetch, the one place it didn't rename it, though the input type names it so: it is now taken
 *   as the same value under its field's name is, request for request and row for row.
 */

import { readFileSync } from "node:fs"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Aggregate from "../src/Aggregate.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"
import {
  type Case,
  cases,
  type InputFieldLib,
  type Recorded,
  type Row,
  runInputField,
} from "./helpers/AggregateInputField.js"
import { CONTEXT, givenOverRow } from "./helpers/AggregateUpgradeSweep.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

const published: {
  readonly generatedFrom: ReadonlyArray<string>
  readonly "1.40.0": Record<string, Recorded>
} = JSON.parse(
  readFileSync(new URL("./fixtures/aggregate-input-field-1.40.0.json", import.meta.url), "utf8"),
)

const lib: InputFieldLib = {
  Aggregate,
  Entity,
  DynamoClient,
  Table,
  DynamoSchema,
  DynamoModel,
  Schema,
  Effect,
  Exit,
  Cause,
  Layer,
}

let made = 0
const run = (c: Case) => {
  const tableName = `input-field-${made++}`
  const table = makeRecordingTable()
  const take = () =>
    table.take().map(({ command, input }) => ({
      command,
      input: JSON.parse(JSON.stringify(input).replaceAll(tableName, "<table>")),
    }))
  const scan = () => Effect.sync(() => [...table.items.values()] as ReadonlyArray<Row>)
  return Effect.runPromise(runInputField(lib, c, { tableName, client: table.client, take, scan }))
}

const labelOf = (c: Case) =>
  cases.find((each) => each.label.length > 0 && same(pick(each), c))!.label
const pick = ({ escape, alias, sub, ref, tenant }: Case) => ({ escape, alias, sub, ref, tenant })
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const writes = (recorded: Recorded) =>
  recorded.requests.filter((request) => request.command !== "BatchGetItem")

describe("a many edge's value given under its inputField (EDD-9159)", () => {
  it("the fixture is published 1.40.0's, for every case", () => {
    expect(published.generatedFrom).toEqual(["effect-dynamodb@1.40.0"])
    expect(Object.keys(published["1.40.0"]).sort()).toEqual(cases.map((c) => c.label).sort())
  })

  for (const c of cases) {
    const then = published["1.40.0"][c.label]!
    // 1.40.0 refused it; the same value under its field's name is what it is now taken as.
    const asField = then.create.failed === "ValidationError"
    const pinned = asField ? published["1.40.0"][labelOf({ ...pick(c), alias: false })]! : then
    if (c.tenant === "root") {
      it(`${c.label}: sends, stores and reads what 1.40.0 did${asField ? " under its field" : ""}`, async () => {
        if (asField) expect(c.alias && !c.ref).toBe(true)
        expect(pinned.create.ok).toBeDefined()
        const now = await run(c)
        expect(now.create).toEqual(pinned.create)
        expect(now.requests).toEqual(pinned.requests)
        expect(now.rows).toEqual(pinned.rows)
        expect(now.get).toEqual(pinned.get)
      })
    } else {
      it(`${c.label}: 1.40.0 read the element back as the root's tenant; refused, nothing written`, async () => {
        // What 1.40.0 stored for it read back with the root's value, not the one given.
        expect((pinned.create.ok as any).lines ?? (pinned.create.ok as any).part.lines).toEqual([
          { id: "l", tenant: "t2" },
        ])
        expect((pinned.get.ok as any).lines ?? (pinned.get.ok as any).part.lines).toEqual([
          { id: "l", tenant: "t1" },
        ])
        const now = await run(c)
        expect(now.create).toEqual({
          failed: "AggregateDecompositionError",
          member: "lines",
          reason: givenOverRow("lines", "tenant", "t2", CONTEXT, "t1"),
        })
        expect(writes(now)).toEqual([])
        expect(now.rows).toEqual([])
      })
    }
  }
})
