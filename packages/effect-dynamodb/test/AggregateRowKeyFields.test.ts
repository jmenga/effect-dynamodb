/**
 * A row's value declaring a field the library writes on the row (`EDD-9159`), on a recording table.
 * The suite is `helpers/AggregateRowKeyFields.ts`; connected twin:
 * `connected.aggregate-row-key-fields.test.ts`.
 */

import { Effect, Layer } from "effect"
import { Main, suite } from "./helpers/AggregateRowKeyFields.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

const tables = new Map<string, ReturnType<typeof makeRecordingTable>>()
let made = 0

suite({
  onTable: (body, pk) => {
    const tableName = `row-key-fields-${made++}`
    const table = makeRecordingTable({ keys: { pk: pk ?? "pk", sk: "sk" } })
    tables.set(tableName, table)
    return body(tableName).pipe(
      Effect.provide(Layer.merge(table.layer, Main.layer({ name: tableName }))),
    ) as Effect.Effect<any, unknown>
  },
  rows: (tableName) => Effect.sync(() => [...tables.get(tableName)!.items.values()] as never),
  commands: (tableName) =>
    Effect.sync(() =>
      tables
        .get(tableName)!
        .take()
        .map(({ command }) => command),
    ),
})
