/**
 * Behaviour published 1.39.0 had, kept: each scenario replays its steps on a recording table and
 * compares them with what 1.39.0 did (`fixtures/*-1.39.0.json`, captured once, never regenerated).
 * Scenarios: `helpers/OptionalShardAppend.ts`. Connected twin: `connected.kept-1.39.0.test.ts`.
 */

import { describe } from "vitest"
import { openRecordingTable } from "./helpers/Kept139.js"
import { optionalShardAppendSuite } from "./helpers/OptionalShardAppend.js"

describe("an appendInput that may leave a sharded index's composite out", () => {
  optionalShardAppendSuite(openRecordingTable)
})
