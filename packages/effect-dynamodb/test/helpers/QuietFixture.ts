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
