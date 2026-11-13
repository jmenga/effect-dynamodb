/**
 * A `many` element whose schema shows no fields of its own, stored in its stored form, on a
 * recording table. The suite is `helpers/AggregateWholeElements.ts`; connected twin:
 * `connected.aggregate-whole-elements.test.ts`.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { Effect } from "effect"
import { suite } from "./helpers/AggregateWholeElements.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

const tables = new Map<string, ReturnType<typeof makeRecordingTable>>()
let made = 0

suite({
  onTable: (body) => {
    const tableName = `whole-elements-${made++}`
    const table = makeRecordingTable()
    tables.set(tableName, table)
    return body(tableName).pipe(Effect.provide(table.layer)) as Effect.Effect<any, unknown>
  },
  rows: (tableName) => Effect.sync(() => [...tables.get(tableName)!.items.values()] as never),
  requests: (tableName) =>
    Effect.sync(() =>
      tables
        .get(tableName)!
        .take()
        .map(({ command, input }) => ({
          command,
          input: JSON.parse(JSON.stringify(input).replaceAll(tableName, "<table>")),
        })),
    ),
  seed: (tableName, rows) =>
    Effect.sync(() => {
      const items = tables.get(tableName)!.items as Map<string, Record<string, AttributeValue>>
      for (const row of rows) items.set(`${row.pk?.S}|${row.sk?.S}`, row)
    }),
})
