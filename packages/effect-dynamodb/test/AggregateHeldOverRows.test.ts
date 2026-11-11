/**
 * What a read gives back of a row's value, judged at write (EDD-9159), on a recording table.
 * The suite is `helpers/AggregateHeldOverRows.ts`; connected twin:
 * `connected.aggregate-held-over-rows.test.ts`.
 */

import { Effect, Layer } from "effect"
import { INDEX, Main, suite } from "./helpers/AggregateHeldOverRows.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

const tables = new Map<string, ReturnType<typeof makeRecordingTable>>()
let made = 0

suite({
  onTable: (body, pk = "pk") => {
    const tableName = `held-over-rows-${made++}`
    const table = makeRecordingTable({ indexes: { [INDEX.name]: { pk, sk: INDEX.sk } } })
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
