/**
 * The rows the published 1.40.0 stored for {@link quietWorld}'s members, and the requests its
 * `rekey` sent over them (`fixtures/rekey-requests-1.40.0.json`), with the `src/` modules and the
 * options each run was made with.
 */

import { readFileSync } from "node:fs"
import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Effect, Schema } from "effect"
import * as Aggregate from "../../src/Aggregate.js"
import { DynamoClient } from "../../src/DynamoClient.js"
import * as Entity from "../../src/Entity.js"
import * as EventStore from "../../src/EventStore.js"
import type * as Table from "../../src/Table.js"
import * as TableModule from "../../src/Table.js"
import type { quietWorld } from "./QuietTable.js"

type Row = Record<string, AttributeValue>

export const quietFixture: {
  readonly settings: Readonly<
    Record<
      string,
      {
        readonly rows: ReadonlyArray<Row>
        readonly runs: Readonly<Record<string, ReadonlyArray<string>>>
      }
    >
  >
} = JSON.parse(
  readFileSync(new URL("../fixtures/rekey-requests-1.40.0.json", import.meta.url), "utf8"),
)

/** `src/`'s modules, for {@link quietWorld}. */
export const QUIET_MODULES = {
  Effect,
  Schema,
  DynamoSchema,
  Entity,
  Table: TableModule,
  Aggregate,
  EventStore,
  DynamoClient,
}

/** The options each run of the fixture was made with. */
export const QUIET_RUNS: Readonly<Record<string, Table.RekeyOptions>> = {
  run: { segments: 1, concurrency: 1 },
  "dry run": { segments: 1, concurrency: 1, dryRun: true },
  "repairIndexKeys run": { segments: 1, concurrency: 1, repairIndexKeys: true },
}

/**
 * Runs with options the fixture's runs don't use, each with the fixture run whose requests it must
 * send: over a table with nothing to move, releasing orphaned reservations (new in 1.41) and
 * `writesStopped` send nothing more.
 */
export const QUIET_RUNS_ALIKE: Readonly<
  Record<string, { readonly options: Table.RekeyOptions; readonly sends: string }>
> = {
  "releaseOrphanedReservations run": {
    options: { ...QUIET_RUNS.run, releaseOrphanedReservations: true },
    sends: "run",
  },
  "releaseOrphanedReservations dry run": {
    options: { ...QUIET_RUNS["dry run"], releaseOrphanedReservations: true },
    sends: "dry run",
  },
  "writesStopped run": { options: { ...QUIET_RUNS.run, writesStopped: true }, sends: "run" },
}

/** Every run to replay over a setting's rows: its name, its options and the requests it sends. */
export const quietRuns = (
  runs: Readonly<Record<string, ReadonlyArray<string>>>,
): ReadonlyArray<readonly [string, Table.RekeyOptions, ReadonlyArray<string>]> => [
  ...Object.entries(runs).map(([run, sent]) => [run, QUIET_RUNS[run]!, sent] as const),
  ...Object.entries(QUIET_RUNS_ALIKE).map(
    ([run, { options, sends }]) => [run, options, runs[sends]!] as const,
  ),
]
