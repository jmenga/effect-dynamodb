/**
 * Behaviour published 1.39.0 had, kept, against DynamoDB Local: the connected twin of
 * `Kept139.test.ts`. Each scenario replays its steps and compares them with what 1.39.0 did
 * (`fixtures/*-1.39.0.json`, captured once, never regenerated).
 * Scenarios: `helpers/OptionalShardAppend.ts`, `helpers/StoredNaNKeys.ts`,
 * `helpers/AggregateCreateStamps.ts`, `helpers/AggregateStampForms.ts`,
 * `helpers/OptionalTransformDates.ts`, `helpers/WideShardAppend.ts`, `helpers/PathClears.ts`,
 * `helpers/HashFieldNames.ts`, `helpers/SelectSparseMaps.ts`, `helpers/EntryBesideField.ts`,
 * `helpers/SelectBesideSparseMaps.ts`, `helpers/AccompaniedClears.ts`, `helpers/RenamedSparseMap.ts`,
 * `helpers/RenamedSparseMapWrites.ts`, `helpers/RenamedSparseMapPaths.ts`, `helpers/NestedKeyEncodings.ts` (the last seven against 1.40.0), `helpers/EntryInQueries.ts`, `helpers/EntryOnEveryTerminal.ts`, `helpers/AppendSparseMaps.ts` (both against 1.40.0), `helpers/RenamedSparseMapZOrder.ts`, `helpers/RenamedSparseMapRaces.ts`, `helpers/RenamedSparseMapVerdictTable.ts` (against 1.40.0).
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 */

import { DynamoDBClient, ScanCommand } from "@aws-sdk/client-dynamodb"
import { Config, Effect } from "effect"
import { afterAll, describe } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Table from "../src/Table.js"
import { accompaniedClearsSuite } from "./helpers/AccompaniedClears.js"
import { aggregateCreateStampsSuite } from "./helpers/AggregateCreateStamps.js"
import { aggregateListFiltersSuite } from "./helpers/AggregateListFilters.js"
import { aggregateStampFormsSuite } from "./helpers/AggregateStampForms.js"
import { appendSparseMapsSuite } from "./helpers/AppendSparseMaps.js"
import { clearBesideAbsentEntrySuite } from "./helpers/ClearBesideAbsentEntry.js"
import {
  clearEveryOpSuite,
  clearWritesSuite,
  retainedEntryRemovalsSuite,
} from "./helpers/ClearWrites.js"
import { entryBesideFieldSuite } from "./helpers/EntryBesideField.js"
import { entryInQueriesSuite } from "./helpers/EntryInQueries.js"
import { entryOnEveryTerminalSuite } from "./helpers/EntryOnEveryTerminal.js"
import { entrySelectsSuite } from "./helpers/EntrySelects.js"
import { hashFieldNamesSuite } from "./helpers/HashFieldNames.js"
import type { OpenTable, Row } from "./helpers/Kept139.js"
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
import { renamedSparseMapZOrderSuite } from "./helpers/RenamedSparseMapZOrder.js"
import { selectBesideSparseMapsSuite } from "./helpers/SelectBesideSparseMaps.js"
import { selectSparseMapsSuite } from "./helpers/SelectSparseMaps.js"
import { sparseEntryValuesSuite } from "./helpers/SparseEntryValues.js"
import { storedNaNKeySuite } from "./helpers/StoredNaNKeys.js"
import { makeTablePool } from "./helpers/TablePool.js"
import { unionMemberWritesSuite } from "./helpers/UnionMemberWrites.js"
import { unionPathWritesPassedSuite, unionPathWritesSuite } from "./helpers/UnionPathWrites.js"
import { wideShardAppendSuite } from "./helpers/WideShardAppend.js"

const ENDPOINT = Effect.runSync(
  Config.String("DYNAMODB_ENDPOINT").pipe(Config.withDefault("http://localhost:8000")),
)

let dynamoAvailable = false
try {
  const res = await fetch(ENDPOINT, { method: "POST", signal: AbortSignal.timeout(1000) }).catch(
    () => null,
  )
  dynamoAvailable = res !== null
} catch {
  dynamoAvailable = false
}
const describeConnected = dynamoAvailable ? describe : describe.skip

const credentials = { accessKeyId: "local", secretAccessKey: "local" }
const raw = new DynamoDBClient({ region: "us-east-1", endpoint: ENDPOINT, credentials })
const ClientLayer = DynamoClient.layer({ region: "us-east-1", endpoint: ENDPOINT, credentials })

const send = <A>(make: () => Promise<A>) =>
  Effect.tryPromise(make).pipe(Effect.orDie) as Effect.Effect<A>

// Each case on an empty table of its definition, one at a time: reused, emptied between cases.
const pool = makeTablePool(raw, "kept-139")
afterAll(() => pool.drain())

const openTable: OpenTable = (MainTable) =>
  Effect.gen(function* () {
    const shape = Table.definition(MainTable)
    const TableName = yield* pool.take(shape)
    return {
      name: TableName,
      layer: ClientLayer,
      rows: Effect.map(
        send(() => raw.send(new ScanCommand({ TableName, ConsistentRead: true }))),
        (out) => (out.Items ?? []) as ReadonlyArray<Row>,
      ),
      close: pool.give(TableName, shape),
    }
  })

describeConnected("an appendInput that may leave a sharded index's composite out", () => {
  optionalShardAppendSuite(openTable)
})

describeConnected("a key over a number stored as a string, holding NaN", () => {
  storedNaNKeySuite(openTable)
})

describeConnected("an aggregate create over a field the rows declare a stamp in", () => {
  aggregateCreateStampsSuite(openTable)
})

describeConnected("the form an aggregate stores its stamps in", () => {
  aggregateStampFormsSuite(openTable)
})

describeConnected(
  "an entity's Schema.optional date over a transform stored as the other kind",
  () => {
    optionalTransformDatesSuite(openTable)
  },
)

describeConnected("an appendInput that may leave out many of a sharded index's composites", () => {
  wideShardAppendSuite(openTable)
})

describeConnected("a pathRemove below a union", () => {
  pathClearSuite("union-clears")(openTable)
})

describeConnected("a pathRemove of a list position", () => {
  pathClearSuite("tuple-clears")(openTable)
})

describeConnected("a pathRemove below a sparse map's entry", () => {
  pathClearSuite("sparse-entry-clears")(openTable)
})

describeConnected(
  "a path naming a renamed field whose name holds '#', or a sparse map's entry",
  () => {
    hashFieldNamesSuite(openTable, { projects: true })
  },
)

describeConnected("a sparse map's entry named through the map, beside a field named as it", () => {
  entryBesideFieldSuite(openTable)
})

describeConnected("a select naming a sparse map field", () => {
  selectSparseMapsSuite(openTable, { dynamodb: true })
})

describeConnected("a select naming a sparse map beside other paths", () => {
  selectBesideSparseMapsSuite(openTable, { dynamodb: true })
})

describeConnected("a pathRemove beside another clause in the same field", () => {
  accompaniedClearsSuite(openTable)
})

describeConnected("a sparse map a field: rename stores whole", () => {
  renamedSparseMapSuite(openTable)
})

describeConnected("an upsert of a sparse map a field: rename stores whole", () => {
  renamedSparseMapUpsertsSuite(openTable)
})

describeConnected(
  "a sparse map a field: rename stores whole, through the paths beyond an update",
  () => {
    renamedSparseMapPathsSuite(openTable)
  },
)

describeConnected(
  "a sparse map a field: rename stores whole, moved between a transaction's plan and its write",
  () => {
    renamedSparseMapRacesSuite(openTable)
  },
)

describeConnected(
  "a refused write of a sparse map a field: rename stores whole, cell by cell of its decision table",
  () => {
    renamedSparseMapVerdictTableSuite(openTable)
  },
)

describeConnected("a copy from an entry of a sparse map a field: rename stores whole", () => {
  renamedSparseMapCopiesSuite(openTable)
})

describeConnected(
  "an update of a sparse map a field: rename stores whole: whose verdict a refusal gives",
  () => {
    renamedSparseMapVerdictsSuite(openTable)
  },
)

describeConnected("a select of a sparse map's entry", () => {
  entrySelectsSuite(openTable)
})

describeConnected("a clearMap with another write to the map", () => {
  clearWritesSuite(openTable)
})

describeConnected("a clearMap beside every other kind of write to the map", () => {
  clearEveryOpSuite(openTable)
})

describeConnected("a retained entity's removal of a sparse map's entries", () => {
  retainedEntryRemovalsSuite(openTable)
})

describeConnected("a value a path operation writes into a sparse map's entry", () => {
  sparseEntryValuesSuite(openTable)
})

describeConnected("a path below a struct that renames its keys as they're stored", () => {
  nestedKeyEncodingsSuite(openTable)
})

describeConnected("a path below a struct that renames its keys, in a collection", () => {
  nestedKeyCollectionSuite(openTable)
})

describeConnected(
  "a sparse map entry in a query's, a scan's and a collection's filter and select",
  () => {
    entryInQueriesSuite(openTable)
  },
)

describeConnected("a sparse map entry on every terminal that takes a path callback", () => {
  entryOnEveryTerminalSuite(openTable)
})

describeConnected("a time-series append whose appendInput holds a sparse map", () => {
  appendSparseMapsSuite(openTable)
})

describeConnected(
  "a path write into a union whose members name it differently, or out of a member",
  () => {
    unionMemberWritesSuite(openTable)
  },
)

describeConnected(".clearMap() beside a pathSubtract of an entry the row doesn't hold", () => {
  clearBesideAbsentEntrySuite(openTable)
})

describeConnected("a renamed sparse map on an entity with a Z-order index", () => {
  renamedSparseMapZOrderSuite(openTable)
})

describeConnected(
  "an aggregate list filter below a struct that renames its keys as they're stored",
  () => {
    aggregateListFiltersSuite(openTable)
  },
)

describeConnected("a path write into a union's member", () => {
  unionPathWritesSuite(openTable)
})

describeConnected("a path write through unions every member of which holds the path", () => {
  unionPathWritesPassedSuite(openTable)
})
