/**
 * A key written must be the key composed again from the row as it reads back, on a recording
 * table: the scenarios of `helpers/KeyReadBack.ts`, over rows published 1.39.0 stored, and the
 * definitions refused or loaded for it. Connected twin: `connected.key-read-back.test.ts`.
 */

import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as Table from "../src/Table.js"
import {
  keyReadBackSuite,
  nestedKeyAggregate,
  storesBoth,
  storesNumber,
} from "./helpers/KeyReadBack.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

describe("a key written is the key composed again from the row read back", () => {
  keyReadBackSuite((seed) =>
    Effect.sync(() => {
      const table = makeRecordingTable()
      for (const row of seed) {
        table.items.set(`${row.pk!.S}|${row.sk!.S}`, structuredClone(row) as never)
      }
      return {
        name: "t",
        layer: table.layer,
        rows: Effect.sync(() => [...table.items.values()] as never),
        close: Effect.void,
      }
    }),
  )
})

describe("a key path judged by what the row stores there (EDD-9128)", () => {
  const schema = DynamoSchema.make({ name: "nested", version: 1 })
  const Main = Table.make({ schema, entities: {} })

  it("loads a path into a struct stored as a number and decoded to either kind", () => {
    expect(() => nestedKeyAggregate(Main, schema, storesNumber)).not.toThrow()
  })

  it("refuses a path into a struct storing either kind, whatever it decodes to", () => {
    // A field storing both kinds is refused wherever it is (EDD-9125), before its key is judged.
    expect(() => nestedKeyAggregate(Main, schema, storesBoth)).toThrow(
      /\[EDD-9125\] Aggregate "Root": field "lines\[\]\.nested\.n"/,
    )
  })
})
