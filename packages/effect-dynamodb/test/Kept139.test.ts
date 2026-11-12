/**
 * Behaviour published 1.39.0 had, kept: each scenario replays its steps on a recording table and
 * compares them with what 1.39.0 did (`fixtures/*-1.39.0.json`, captured once, never regenerated).
 * Scenarios: `helpers/OptionalShardAppend.ts`, `helpers/StoredNaNKeys.ts`,
 * `helpers/AggregateCreateStamps.ts`, `helpers/AggregateStampForms.ts`,
 * `helpers/OptionalTransformDates.ts`, `helpers/WideShardAppend.ts`, `helpers/PathClears.ts`,
 * `helpers/HashFieldNames.ts`, `helpers/SelectSparseMaps.ts`, `helpers/EntryBesideField.ts`,
 * `helpers/SelectBesideSparseMaps.ts`, `helpers/AccompaniedClears.ts`, `helpers/RenamedSparseMap.ts`,
 * `helpers/RenamedSparseMapWrites.ts`, `helpers/RenamedSparseMapPaths.ts`, `helpers/NestedKeyEncodings.ts` (the last seven against 1.40.0), `helpers/EntryInQueries.ts`, `helpers/RenamedSparseMapRaces.ts`, `helpers/RenamedSparseMapVerdictTable.ts` (against 1.40.0). Connected twin:
 * `connected.kept-1.39.0.test.ts`.
 */

import { describe } from "vitest"
import { accompaniedClearsSuite } from "./helpers/AccompaniedClears.js"
import { aggregateCreateStampsSuite } from "./helpers/AggregateCreateStamps.js"
import { aggregateListFiltersSuite } from "./helpers/AggregateListFilters.js"
import { aggregateStampFormsSuite } from "./helpers/AggregateStampForms.js"
import {
  clearEveryOpSuite,
  clearWritesSuite,
  retainedEntryRemovalsSuite,
} from "./helpers/ClearWrites.js"
import { entryBesideFieldSuite } from "./helpers/EntryBesideField.js"
import { entryInQueriesSuite } from "./helpers/EntryInQueries.js"
import { entrySelectsSuite } from "./helpers/EntrySelects.js"
import { hashFieldNamesSuite } from "./helpers/HashFieldNames.js"
import { openRecordingTable } from "./helpers/Kept139.js"
import { nestedKeyCollectionSuite, nestedKeyEncodingsSuite } from "./helpers/NestedKeyEncodings.js"
import { optionalShardAppendSuite } from "./helpers/OptionalShardAppend.js"
import { optionalTransformDatesSuite } from "./helpers/OptionalTransformDates.js"
import { pathClearSuite } from "./helpers/PathClears.js"
import { renamedSparseMapSuite } from "./helpers/RenamedSparseMap.js"
import { renamedSparseMapPathsSuite } from "./helpers/RenamedSparseMapPaths.js"
import { renamedSparseMapRacesSuite } from "./helpers/RenamedSparseMapRaces.js"
import { renamedSparseMapVerdictTableSuite } from "./helpers/RenamedSparseMapVerdictTable.js"
import {
  renamedSparseMapCopiesSuite,
  renamedSparseMapUpsertsSuite,
  renamedSparseMapVerdictsSuite,
} from "./helpers/RenamedSparseMapWrites.js"
import { selectBesideSparseMapsSuite } from "./helpers/SelectBesideSparseMaps.js"
import { selectSparseMapsSuite } from "./helpers/SelectSparseMaps.js"
import { storedNaNKeySuite } from "./helpers/StoredNaNKeys.js"
import { unionPathWritesPassedSuite, unionPathWritesSuite } from "./helpers/UnionPathWrites.js"
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

describe("a sparse map a field: rename stores whole", () => {
  renamedSparseMapSuite(openRecordingTable)
})

describe("an upsert of a sparse map a field: rename stores whole", () => {
  renamedSparseMapUpsertsSuite(openRecordingTable)
})

describe("a sparse map a field: rename stores whole, through the paths beyond an update", () => {
  renamedSparseMapPathsSuite(openRecordingTable)
})

describe("a sparse map a field: rename stores whole, moved between a transaction's plan and its write", () => {
  renamedSparseMapRacesSuite(openRecordingTable)
})

describe("a refused write of a sparse map a field: rename stores whole, cell by cell of its decision table", () => {
  renamedSparseMapVerdictTableSuite(openRecordingTable)
})

describe("a copy from an entry of a sparse map a field: rename stores whole", () => {
  renamedSparseMapCopiesSuite(openRecordingTable)
})

describe("an update of a sparse map a field: rename stores whole: whose verdict a refusal gives", () => {
  renamedSparseMapVerdictsSuite(openRecordingTable)
})

describe("a select of a sparse map's entry", () => {
  entrySelectsSuite(openRecordingTable)
})

describe("a clearMap with another write to the map", () => {
  clearWritesSuite(openRecordingTable)
})

describe("a clearMap beside every other kind of write to the map", () => {
  clearEveryOpSuite(openRecordingTable)
})

describe("a retained entity's removal of a sparse map's entries", () => {
  retainedEntryRemovalsSuite(openRecordingTable)
})

describe("a path below a struct that renames its keys as they're stored", () => {
  nestedKeyEncodingsSuite(openRecordingTable)
})

describe("a path below a struct that renames its keys, in a collection", () => {
  nestedKeyCollectionSuite(openRecordingTable)
})

describe("a sparse map entry in a query's, a scan's and a collection's filter and select", () => {
  entryInQueriesSuite(openRecordingTable)
})

describe("an aggregate list filter below a struct that renames its keys as they're stored", () => {
  aggregateListFiltersSuite(openRecordingTable)
})

describe("a path write into a union's member", () => {
  unionPathWritesSuite(openRecordingTable)
})

describe("a path write through unions every member of which holds the path", () => {
  unionPathWritesPassedSuite(openRecordingTable)
})
