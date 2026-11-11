/**
 * Behaviour published 1.39.0 had, kept: each scenario replays its steps on a recording table and
 * compares them with what 1.39.0 did (`fixtures/*-1.39.0.json`, captured once, never regenerated).
 * Scenarios: `helpers/OptionalShardAppend.ts`, `helpers/StoredNaNKeys.ts`,
 * `helpers/AggregateCreateStamps.ts`. Connected twin: `connected.kept-1.39.0.test.ts`.
 */

import { describe } from "vitest"
import { aggregateCreateStampsSuite } from "./helpers/AggregateCreateStamps.js"
import { openRecordingTable } from "./helpers/Kept139.js"
import { optionalShardAppendSuite } from "./helpers/OptionalShardAppend.js"
import { storedNaNKeySuite } from "./helpers/StoredNaNKeys.js"

describe("an appendInput that may leave a sharded index's composite out", () => {
  optionalShardAppendSuite(openRecordingTable)
})

describe("a key over a number stored as a string, holding NaN", () => {
  storedNaNKeySuite(openRecordingTable)
})

describe("an aggregate create over a field the rows declare a stamp in", () => {
  aggregateCreateStampsSuite(openRecordingTable)
})
