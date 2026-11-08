/**
 * Partitions holding rows of one entity type that more than one owner writes, on an in-memory
 * table: what each step sends and stores, against what published 1.39.0 did (see
 * `helpers/SharedPartition.ts`).
 */

import { Effect } from "effect"
import { makeRecordingTable } from "./helpers/RecordingTable.js"
import { sharedPartitionSuite } from "./helpers/SharedPartition.js"

sharedPartitionSuite({
  local: false,
  open: ({ gsi, seed }) =>
    Effect.sync(() => {
      const table = makeRecordingTable(
        gsi ? { indexes: { gsi1: { pk: "gsi1pk", sk: "gsi1sk" } } } : undefined,
      )
      for (const row of seed ?? []) {
        table.items.set(`${row.pk?.S}|${row.sk?.S}`, structuredClone(row))
      }
      return {
        name: "t",
        layer: table.layer,
        rows: Effect.sync(() => [...table.items.values()].map((row) => structuredClone(row))),
        put: (row) =>
          Effect.sync(() => {
            table.items.set(`${row.pk?.S}|${row.sk?.S}`, structuredClone(row))
          }),
        close: Effect.void,
      }
    }),
})
