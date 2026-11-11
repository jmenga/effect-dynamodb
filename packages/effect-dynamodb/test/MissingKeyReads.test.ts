/**
 * A read of a stored row lacking a field whose transformation throws on `undefined`, on an
 * aggregate, a stream and a projection, fails as published 1.39.0's read failed: a
 * `ValidationError` on the missing key, with 1.39.0's operation and message
 * (`fixtures/missing-key-reads-1.39.0.json`: the rows 1.39.0 stored and what each read gave).
 *
 * A read schema reads an absent attribute as the value it stands for, through the field's own
 * steps, so such a step killed the read (`failingAsBefore`). Reads that 1.39.0 answered otherwise
 * (a snapshot read of a stream whose event lacks a field, a projection's row) answer as they did,
 * and a read dying on a value the row holds stays a defect. The same cases run against DynamoDB
 * Local in `connected.missing-key-reads.test.ts`.
 */
import { it } from "@effect/vitest"
import { Effect } from "effect"
import { describe, expect } from "vitest"
import { type Case, cases, throwingOnAnyValue } from "./helpers/MissingKeyReads.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

const onRecordingTable = (c: Case) => {
  const table = makeRecordingTable(
    c.gsi1 ? { indexes: { gsi1: { pk: "gsi1pk", sk: "gsi1sk" } } } : undefined,
  )
  for (const row of c.rows) table.items.set(`${row.pk!.S}|${row.sk!.S}`, structuredClone(row))
  return c.read.pipe(Effect.provide(c.layer("t")), Effect.provide(table.layer)) as Effect.Effect<
    Record<string, unknown>
  >
}

describe("a read of a row lacking a field whose step throws on its absence", () => {
  for (const c of cases()) {
    it.effect(`${c.name}: as 1.39.0`, () =>
      Effect.gen(function* () {
        expect(yield* onRecordingTable(c)).toEqual(c.expected)
      }),
    )
  }

  const c = throwingOnAnyValue()
  it.effect(`${c.name}: still a defect`, () =>
    Effect.gen(function* () {
      expect(yield* onRecordingTable(c)).toEqual(c.expected)
    }),
  )
})
