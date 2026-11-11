/**
 * An aggregate row too wide to guard whole, with no `updatedAt` or one the caller owns, and an
 * update landing after `rekey` read it, on a recording table. The same cases run on DynamoDB Local in
 * `connected.rekey-wide-aggregate.test.ts`.
 */
import { describe, it } from "@effect/vitest"
import { makeRecordingTable } from "./helpers/RecordingTable.js"
import * as RekeyWideAggregate from "./helpers/RekeyWideAggregate.js"

describe("rekey of an aggregate row too wide to guard whole, with no updatedAt it stamps", () => {
  for (const [name, toEscaped, writesStopped, ownUpdatedAt] of RekeyWideAggregate.CASES) {
    it.live(name, () =>
      RekeyWideAggregate.wideAggregatePin({
        client: makeRecordingTable().client,
        tableName: "t",
        toEscaped,
        writesStopped,
        ownUpdatedAt,
      }),
    )
  }
})
