/**
 * Context attributes and a value that keeps what it's given (`EDD-9159`), on a recording table.
 * The suite is `helpers/AggregateContextRead.ts`; connected twin:
 * `connected.aggregate-context-read.test.ts`.
 */

import { Effect, Layer } from "effect"
import { INDEX, Main, suite } from "./helpers/AggregateContextRead.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

const tables = new Map<string, ReturnType<typeof makeRecordingTable>>()
let made = 0

suite({
  onTable: (body) => {
    const tableName = `context-read-${made++}`
    const table = makeRecordingTable({ indexes: { [INDEX.name]: { pk: "pk", sk: INDEX.sk } } })
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
