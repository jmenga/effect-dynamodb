/**
 * A date an aggregate declares `Schema.optional` around an encoding that isn't ISO text, on a
 * recording table. The suite is `helpers/AggregateOptionalDates.ts`; connected twin:
 * `connected.aggregate-optional-dates.test.ts`.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { Effect, Layer } from "effect"
import { INDEXES, Main, suite } from "./helpers/AggregateOptionalDates.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

const tables = new Map<string, ReturnType<typeof makeRecordingTable>>()
let made = 0

suite({
  onTable: (body) => {
    const tableName = `optional-dates-${made++}`
    const table = makeRecordingTable({ indexes: INDEXES })
    tables.set(tableName, table)
    return body(tableName).pipe(
      Effect.provide(Layer.merge(table.layer, Main.layer({ name: tableName }))),
    ) as Effect.Effect<any, unknown>
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
