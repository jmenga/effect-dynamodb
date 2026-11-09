/**
 * `rekey` over rows whose stored number the declared kind can't hold exactly, request capture. A key
 * once declared `Schema.Union([Schema.Number, Schema.BigInt])` stored `bigint`s past 2^53 and
 * fractions. Declared `Schema.Number` now, DynamoDB hands such a `bigint` back as a `bigint`, which
 * no number holds and `Schema.Number` doesn't read; declared `Schema.BigInt`, a fraction is held by
 * no `bigint`. Such a row composes no key: it's the conflict `uncomposable`, and it and its unique
 * sentinel stay where they are, never moved to the key of a value rounded to fit, nor counted
 * unchanged. A dry run reports the same.
 *
 * The rows are what published 1.39.0 stored (`helpers/ReadBackKeys.ts`); connected twin:
 * `connected.read-back-keys.test.ts`.
 */

import { it } from "@effect/vitest"
import { Effect } from "effect"
import { describe, expect } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import {
  conflictsByKey,
  exactKindCases,
  exactKindDefinitions,
  exactKindRows,
  refusedConflicts,
} from "./helpers/ReadBackKeys.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

describe("rekey leaves a row whose number the declared kind can't hold exactly (EDD-9050)", () => {
  for (const { name, Kind, kind, refused, read } of exactKindCases) {
    for (const dryRun of [true, false]) {
      it.effect(`declared ${name}${dryRun ? ", dry run" : ""}`, () => {
        const { E, Main } = exactKindDefinitions(Kind)
        const table = makeRecordingTable()
        for (const row of exactKindRows) {
          table.items.set(`${row.pk.S}|${row.sk.S}`, structuredClone(row) as never)
        }
        const before = structuredClone([...table.items.entries()])
        return Effect.gen(function* () {
          const db = yield* DynamoClient.make({
            entities: { E },
            tables: { Main },
          } as never) as Effect.Effect<any, never, any>
          const report = yield* db.tables.Main.rekey(dryRun ? { dryRun: true } : undefined)
          // Reported, each with the value its declaration can't hold, and nothing moved.
          expect(conflictsByKey(report.conflicts)).toEqual(refusedConflicts(refused, kind))
          expect(Object.values(report.moved).every((count) => count === 0)).toBe(true)
          expect(report.sentinelsMoved).toBe(0)
          // The items it reads are under the keys their values compose.
          expect(report.unchanged).toBe(read.length)
          // Every row, sentinels included, as 1.39.0 stored it.
          expect([...table.items.entries()]).toEqual(before)
          // A second run reports the same.
          const again = yield* db.tables.Main.rekey()
          expect(conflictsByKey(again.conflicts)).toEqual(refusedConflicts(refused, kind))
          expect([...table.items.entries()]).toEqual(before)
        }).pipe(
          Effect.provide(Main.layer({ name: "t" })),
          Effect.provide(table.layer),
        ) as Effect.Effect<void, unknown>
      })
    }
  }
})
