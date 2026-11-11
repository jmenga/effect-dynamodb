/**
 * An aggregate `delete` leaves the rows in its partition that aren't of its own entity types, on a
 * recording table. The suite is `helpers/AggregateDeleteRows.ts`; connected twin:
 * `connected.aggregate-delete-rows.test.ts`.
 */

import { Effect, Layer } from "effect"
import { Main, suite } from "./helpers/AggregateDeleteRows.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

const tables = new Map<string, ReturnType<typeof makeRecordingTable>>()
let made = 0

suite({
  onTable: (body) => {
    const tableName = `t${made++}`
    const table = makeRecordingTable()
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
})
