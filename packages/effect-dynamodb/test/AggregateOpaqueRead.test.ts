/**
 * `create`'s judgement (#241, `EDD-9159`) on a union or suspended root and a union sub-aggregate
 * (with and without an edge), `helpers/AggregateOpaqueRead.ts`: a node whose schema can't place a
 * field exactly is read whole, by the schema `get` decodes it with. Against what published 1.40.0
 * did (`fixtures/aggregate-opaque-read-1.40.0.json`): where its `get` handed back something other
 * than the value given, the create is refused, nothing written; otherwise it creates, stores and
 * reads what 1.40.0 did.
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
  type OpaqueLib,
  type Recorded,
  type Row,
  runOpaque,
  sortRows,
} from "./helpers/AggregateOpaqueRead.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

const published: {
  readonly generatedFrom: ReadonlyArray<string>
  readonly "1.40.0": Record<string, Recorded>
} = JSON.parse(
  readFileSync(new URL("./fixtures/aggregate-opaque-read-1.40.0.json", import.meta.url), "utf8"),
)

const lib: OpaqueLib = {
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
const run = (c: (typeof cases)[number]) => {
  const tableName = `opaque-${made++}`
  const table = makeRecordingTable()
  const scan = () => Effect.sync(() => sortRows([...table.items.values()] as ReadonlyArray<Row>))
  return Effect.runPromise(runOpaque(lib, c, { tableName, client: table.client, scan }))
}

/** The name the case gives a value for, and where in the aggregate. */
const at = (c: (typeof cases)[number], value: any) =>
  c.kind.endsWith("root") ? value?.sk : value?.part?.tenant

describe("EDD-9159 on a union or suspended node, read whole", () => {
  it("the fixture is published 1.40.0's, for every case", () => {
    expect(published.generatedFrom).toEqual(["effect-dynamodb@1.40.0"])
    expect(Object.keys(published["1.40.0"])).toEqual(cases.map((c) => c.name))
  })

  for (const c of cases) {
    const then = published["1.40.0"][c.name]!
    const misread = c.given !== undefined && at(c, then.get.ok) !== c.given
    it(`${c.name}: ${misread ? "1.40.0 read back another value: refused, nothing written" : "creates, stores and reads what 1.40.0 did"}`, async () => {
      expect(then.create.ok).toBeDefined()
      const now = await run(c)
      if (misread) {
        expect(now.create.failed).toBe("AggregateDecompositionError")
        expect(now.create.cause).toMatch(/EDD-9159/)
        expect(now.rows).toEqual([])
        return
      }
      expect(now).toEqual(then)
    })
  }
})
