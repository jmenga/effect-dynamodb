/**
 * What the library writes on an edge's rows beside its value, read as on 1.40.0, on a recording table.
 * The suite is `helpers/AggregateDiscriminatorRead.ts`; connected twin:
 * `connected.aggregate-discriminator-read.test.ts`.
 */

import { Effect, Layer } from "effect"
import { INDEX, Main, suite } from "./helpers/AggregateDiscriminatorRead.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

const tables = new Map<string, ReturnType<typeof makeRecordingTable>>()
let made = 0

suite({
  onTable: (body, pk = "pk") => {
    const tableName = `discriminator-read-${made++}`
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
