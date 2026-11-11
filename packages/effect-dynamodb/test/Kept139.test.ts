/**
 * Behaviour published 1.39.0 had, kept: each scenario replays its steps on a recording table and
 * compares them with what 1.39.0 did (`fixtures/*-1.39.0.json`, captured once, never regenerated).
 * Scenarios: `helpers/OptionalShardAppend.ts`, `helpers/StoredNaNKeys.ts`,
 * `helpers/AggregateCreateStamps.ts`, `helpers/AggregateStampForms.ts`,
 * `helpers/OptionalTransformDates.ts`, `helpers/WideShardAppend.ts`, `helpers/PathClears.ts`. Connected twin:
 * `connected.kept-1.39.0.test.ts`.
 */

import { describe } from "vitest"
import { aggregateCreateStampsSuite } from "./helpers/AggregateCreateStamps.js"
import { aggregateStampFormsSuite } from "./helpers/AggregateStampForms.js"
import { openRecordingTable } from "./helpers/Kept139.js"
import { optionalShardAppendSuite } from "./helpers/OptionalShardAppend.js"
import { optionalTransformDatesSuite } from "./helpers/OptionalTransformDates.js"
import { pathClearSuite } from "./helpers/PathClears.js"
import { storedNaNKeySuite } from "./helpers/StoredNaNKeys.js"
import { wideShardAppendSuite } from "./helpers/WideShardAppend.js"

describe("an appendInput that may leave a sharded index's composite out", () => {
  optionalShardAppendSuite(openRecordingTable)
})

describe("a key over a number stored as a string, holding NaN", () => {
  storedNaNKeySuite(openRecordingTable)
})

describe("an aggregate create over a field the rows declare a stamp in", () => {
  aggregateCreateStampsSuite(openRecordingTable)
})

describe("the form an aggregate stores its stamps in", () => {
  aggregateStampFormsSuite(openRecordingTable)
})

describe("an entity's Schema.optional date over a transform stored as the other kind", () => {
  optionalTransformDatesSuite(openRecordingTable)
})

describe("an appendInput that may leave out many of a sharded index's composites", () => {
  wideShardAppendSuite(openRecordingTable)
})

describe("a pathRemove below a union", () => {
  pathClearSuite("union-clears")(openRecordingTable)
})

describe("a pathRemove of a list position", () => {
  pathClearSuite("tuple-clears")(openRecordingTable)
})
