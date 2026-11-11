/**
 * Keys composed from a row read back are the keys `put` composed, on a recording table.
 * `connected.stored-row-keys.test.ts` runs the same scenarios on DynamoDB Local.
 */

import { unmarshall } from "@aws-sdk/util-dynamodb"
import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import * as StoredRowKeys from "./helpers/StoredRowKeyScenarios.js"

describe("what the unmarshaller hands back for a bigint stored as N", () => {
  it("a safe integer comes back as a number, a larger one as a bigint", () => {
    expect(unmarshall({ v: { N: "5" } }).v).toBe(5)
    expect(unmarshall({ v: { N: String(StoredRowKeys.BIG) } }).v).toBe(StoredRowKeys.BIG)
  })
})

for (const [group, scenarios] of Object.entries(StoredRowKeys.allScenarios)) {
  describe(group, () => {
    for (const scenario of scenarios) {
      it.effect(scenario.name, () => scenario.run(StoredRowKeys.recordingHarness))
    }
  })
}
