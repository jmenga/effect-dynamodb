/**
 * The upgrade sweep (#241) on a recording table: aggregates 1.40.0 wrote, continued by this
 * release. The suite is `helpers/AggregateUpgradeSweepSuite.ts`; connected twin:
 * `connected.aggregate-upgrade-sweep.test.ts`.
 */

import { Effect, Layer } from "effect"
import { INDEX, type Row } from "./helpers/AggregateUpgradeSweep.js"
import { sweepSuite } from "./helpers/AggregateUpgradeSweepSuite.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

let made = 0

sweepSuite({
  onTable: (pk, body) => {
    const tableName = `upgrade-sweep-${made++}`
    const table = makeRecordingTable({
      keys: { pk, sk: "sk" },
      indexes: { [INDEX.name]: { pk, sk: INDEX.sk } },
    })
    const take = () =>
      table.take().map(({ command, input }) => ({
        command,
        input: JSON.parse(JSON.stringify(input).replaceAll(tableName, "<table>")),
      }))
    const keyOf = (row: Row) => `${row[pk]?.S} ${row.sk?.S}`
    const scan = () =>
      Effect.sync(() =>
        [...table.items.values()].sort((a, b) =>
          keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0,
        ),
      )
    const seed = (rows: ReadonlyArray<Row>) =>
      Effect.gen(function* () {
        for (const row of rows) {
          yield* table.client.putItem({ TableName: tableName, Item: row } as never)
        }
        table.take()
      })
    return body({ tableName, client: table.client, take, scan }, seed).pipe(
      Effect.provide(Layer.empty),
    ) as Effect.Effect<any, unknown>
  },
})
