/**
 * Entity-level refs name the referenced entity's key composite, and a cascade stores what a put
 * stores, on a recording table. The suites are `helpers/EntityRefKeys.ts` and
 * `helpers/EntityRefCascade.ts`; connected twin: `connected.entity-ref-keys.test.ts`.
 */

import { Effect, Layer } from "effect"
import { suite as cascadeSuite } from "./helpers/EntityRefCascade.js"
import { type Harness, INDEXES, suite } from "./helpers/EntityRefKeys.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

const tables = new Map<string, ReturnType<typeof makeRecordingTable>>()
let made = 0

const harness: Harness = {
  onTable: (body) => {
    const tableName = `entity-ref-keys-${made++}`
    tables.set(tableName, makeRecordingTable({ indexes: INDEXES }))
    return body(tableName) as Effect.Effect<any, unknown>
  },
  provide: (tableName, main, effect) =>
    effect.pipe(
      Effect.provide(Layer.merge(tables.get(tableName)!.layer, main.layer({ name: tableName }))),
    ) as Effect.Effect<any, any>,
  rows: (tableName) => Effect.sync(() => [...tables.get(tableName)!.items.values()] as never),
  requests: (tableName) =>
    Effect.sync(() =>
      tables
        .get(tableName)!
        .take()
        .map(({ command, input }) => ({
          command,
          input: JSON.parse(JSON.stringify(input).replaceAll(tableName, "<table>")),
        })),
    ),
}

suite(harness)
cascadeSuite(harness)
