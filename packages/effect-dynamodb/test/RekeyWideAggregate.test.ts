/**
 * An aggregate row too wide to guard whole, with no `updatedAt`, and an update landing after
 * `rekey` read it, on a recording table. The same cases run on DynamoDB Local in
 * `connected.rekey-wide-aggregate.test.ts`.
 */
import { describe, it } from "@effect/vitest"
import { makeRecordingTable } from "./helpers/RecordingTable.js"
import * as RekeyWideAggregate from "./helpers/RekeyWideAggregate.js"

describe("rekey of an aggregate row too wide to guard whole, with no updatedAt", () => {
  for (const [name, toEscaped, writesStopped] of RekeyWideAggregate.CASES) {
    it.live(name, () =>
      RekeyWideAggregate.wideAggregatePin({
        client: makeRecordingTable().client,
        tableName: "t",
        toEscaped,
        writesStopped,
      }),
    )
  }
})
