/**
 * `rekey` moves rows stored under the other numeric kind's key text (`EDD-9128`), request capture.
 * A field declared `Schema.Union([Schema.Number, Schema.BigInt])` composed each value's own kind's
 * text: `5` gave 16 digits and `5n` gave 38. A key composite is now refused that union at load, so
 * the field is declared one kind, and its rows under the other kind's text are found and moved to
 * the text the values read back as.
 *
 * The rows are what published 1.39.0 stored: items, an index key, unique sentinels, a tombstone,
 * time-series events, an aggregate's partition and a `many` edge's rows, and a `Schema.Unknown` key
 * holding a bigint safe integer, which reads back as a number. Two items holding `3` and `3n` read
 * back as one item; they're reported and left. Scenarios: `helpers/RekeyNumericKindScenarios.ts`;
 * connected twin: `connected.rekey-numeric-kinds.test.ts`.
 */

import { it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { describe, expect } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"
import {
  definitions,
  fixtureRows,
  keysOf,
  type Row,
  scenarios,
} from "./helpers/RekeyNumericKindScenarios.js"

const on = <A, E>(
  Kind: Schema.Top,
  body: (db: any, keys: Effect.Effect<ReadonlyArray<string>>) => Effect.Effect<A, E, any>,
) => {
  const { Counters, Readings, Loose, Main, Teams } = definitions(Kind)
  const table = makeRecordingTable({ indexes: { gsi1: { pk: "gsi1pk", sk: "gsi1sk" } } })
  for (const row of fixtureRows) {
    table.items.set(`${row.pk!.S}|${row.sk!.S}`, structuredClone(row) as never)
  }
  const keys = Effect.sync(() => keysOf([...table.items.values()] as unknown as ReadonlyArray<Row>))
  return Effect.gen(function* () {
    const db = yield* DynamoClient.make({
      entities: { Counters, Readings, Loose },
      aggregates: { Teams },
      tables: { Main },
    } as never) as Effect.Effect<any, never, any>
    return yield* body(db, keys)
  }).pipe(Effect.provide(Main.layer({ name: "t" })), Effect.provide(table.layer)) as Effect.Effect<
    A,
    unknown
  >
}

describe("rekey moves rows under the other numeric kind's text (EDD-9128)", () => {
  for (const scenario of scenarios) {
    it.effect(scenario.name, () => on(scenario.Kind, (db, keys) => scenario.check(db, keys)))
  }

  it.effect("a dry run counts the same moves and writes nothing", () =>
    on(Schema.Number, (db, keys) =>
      Effect.gen(function* () {
        const before = yield* keys
        const dry = yield* db.tables.Main.rekey({ dryRun: true })
        expect(yield* keys).toEqual(before)
        const real = yield* db.tables.Main.rekey()
        expect(dry.moved).toEqual(real.moved)
        expect(dry.sentinelsMoved).toBe(real.sentinelsMoved)
      }),
    ),
  )
})
