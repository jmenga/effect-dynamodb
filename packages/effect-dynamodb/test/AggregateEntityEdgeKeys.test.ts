/**
 * An aggregate's `entity:` many edge whose declared sort key names a field the entity's model
 * encodes, on a recording table. The suites are `helpers/AggregateEntityEdgeKeys.ts`,
 * `helpers/AggregateDottedEdgeKeys.ts` (a dotted composite) and
 * `helpers/AggregateEntityEdgeKeyTable.ts` (the key text per field type); connected twin:
 * `connected.aggregate-entity-edge-keys.test.ts`, which also runs the cases needing DynamoDB's own
 * 100-item transaction limit.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { Effect } from "effect"
import { dottedSuite } from "./helpers/AggregateDottedEdgeKeys.js"
import { type Harness, suite } from "./helpers/AggregateEntityEdgeKeys.js"
import { keyTableSuite } from "./helpers/AggregateEntityEdgeKeyTable.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

const tables = new Map<string, ReturnType<typeof makeRecordingTable>>()
let made = 0

const harness: Harness = {
  onTable: (body) => {
    const tableName = `entity-edge-keys-${made++}`
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
  enforcesLimits: false,
}

suite(harness)
dottedSuite(harness)
keyTableSuite(harness)
