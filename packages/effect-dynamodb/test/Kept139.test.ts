/**
 * Behaviour published 1.39.0 had, kept: each scenario replays its steps on a recording table and
 * compares them with what 1.39.0 did (`fixtures/*-1.39.0.json`, captured once, never regenerated).
 * Scenarios: `helpers/OptionalShardAppend.ts`, `helpers/StoredNaNKeys.ts`,
 * `helpers/AggregateCreateStamps.ts`, `helpers/AggregateStampForms.ts`,
 * `helpers/OptionalTransformDates.ts`, `helpers/WideShardAppend.ts`, `helpers/PathClears.ts`,
 * `helpers/HashFieldNames.ts`, `helpers/SelectSparseMaps.ts`, `helpers/EntryBesideField.ts`,
 * `helpers/SelectBesideSparseMaps.ts`, `helpers/AccompaniedClears.ts` (the last three against 1.40.0). Connected twin:
 * `connected.kept-1.39.0.test.ts`.
 */

import { describe } from "vitest"
import { accompaniedClearsSuite } from "./helpers/AccompaniedClears.js"
import { aggregateCreateStampsSuite } from "./helpers/AggregateCreateStamps.js"
import { aggregateStampFormsSuite } from "./helpers/AggregateStampForms.js"
import { entryBesideFieldSuite } from "./helpers/EntryBesideField.js"
import { hashFieldNamesSuite } from "./helpers/HashFieldNames.js"
import { openRecordingTable } from "./helpers/Kept139.js"
import { optionalShardAppendSuite } from "./helpers/OptionalShardAppend.js"
import { optionalTransformDatesSuite } from "./helpers/OptionalTransformDates.js"
import { pathClearSuite } from "./helpers/PathClears.js"
import { selectBesideSparseMapsSuite } from "./helpers/SelectBesideSparseMaps.js"
import { selectSparseMapsSuite } from "./helpers/SelectSparseMaps.js"
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

describe("a pathRemove below a sparse map's entry", () => {
  pathClearSuite("sparse-entry-clears")(openRecordingTable)
})

describe("a path naming a renamed field whose name holds '#', or a sparse map's entry", () => {
  hashFieldNamesSuite(openRecordingTable, { projects: false })
})

describe("a sparse map's entry named through the map, beside a field named as it", () => {
  entryBesideFieldSuite(openRecordingTable)
})

describe("a select naming a sparse map field", () => {
  selectSparseMapsSuite(openRecordingTable, { dynamodb: false })
})

describe("a select naming a sparse map beside other paths", () => {
  selectBesideSparseMapsSuite(openRecordingTable, { dynamodb: false })
})

describe("a pathRemove beside another clause in the same field", () => {
  accompaniedClearsSuite(openRecordingTable)
})
