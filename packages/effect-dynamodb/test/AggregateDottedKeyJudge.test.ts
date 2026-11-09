/**
 * An aggregate's dotted edge sort key composite under a transformation of what holds it (`EDD-9128`
 * at write). A `many` edge keyed by `nested.n`, where `nested` is a struct decoded to another
 * struct, composes its key from the domain value (`{ n: 5 }`, 16 digits) and stores the encoded one
 * (`{ n: 5n }`), which DynamoDB hands back as `{ n: 5 }` and the field decodes to `{ n: 5 }` again:
 * the key composed from the row as a read takes it is the key written. So the write is judged
 * through the field holding the value, never by the stored value at the path alone, which reads
 * back as the other kind. A parent whose decode keeps the kind DynamoDB hands back does move the key,
 * and is refused.
 *
 * The rows are what published 1.39.0 stored (`helpers/ReadBackKeys.ts`); connected twin:
 * `connected.read-back-keys.test.ts`.
 */

import { it } from "@effect/vitest"
import { Effect, Exit, type Schema } from "effect"
import { describe, expect } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import {
  asGiven,
  byKey,
  dottedDefinitions,
  dottedParentRows,
  dottedShapes,
  type Row,
  toNumber,
} from "./helpers/ReadBackKeys.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

const on = <A, E>(
  parent: Schema.Top,
  optional: boolean,
  deep: boolean,
  rows: ReadonlyArray<Row>,
  body: (aggregate: any, table: ReturnType<typeof makeRecordingTable>) => Effect.Effect<A, E, any>,
) => {
  const { Main, Roots } = dottedDefinitions(parent, optional, deep)
  const table = makeRecordingTable()
  for (const row of rows) table.items.set(`${row.pk.S}|${row.sk.S}`, structuredClone(row) as never)
  return Effect.gen(function* () {
    const db = yield* DynamoClient.make({
      entities: {},
      aggregates: { Roots },
      tables: { Main },
    } as never) as Effect.Effect<any, never, any>
    return yield* body(db.aggregates.Roots, table)
  }).pipe(Effect.provide(Main.layer({ name: "t" })), Effect.provide(table.layer)) as Effect.Effect<
    A,
    unknown
  >
}

const keysOf = (rows: ReadonlyArray<Row>) => rows.map((row) => `${row.pk.S}|${row.sk.S}`).sort()

describe("a dotted edge key under a transformed parent is judged through the parent", () => {
  for (const { optional, deep, shape, path, value, held } of dottedShapes) {
    const stored = dottedParentRows[shape]!

    it.effect(`${shape}: create, update and get store the rows 1.39.0 stored`, () =>
      on(toNumber, optional, deep, [], (aggregate, table) =>
        Effect.gen(function* () {
          yield* aggregate.create({ id: "x", lines: [{ nested: value, note: "before" }] })
          // The key composed from `{ n: 5 }`, and `{ n: 5n }` stored, as 1.39.0 stored them.
          expect(byKey([...table.items.values()] as never)).toEqual(byKey(stored))
          yield* aggregate.update({ id: "x" }, ({ state }: any) => ({
            ...state,
            lines: state.lines.map((line: any) => ({ ...line, note: "after" })),
          }))
          const got = yield* aggregate.get({ id: "x" })
          expect(got.lines).toEqual([{ nested: value, note: "after" }])
          // The edge row was rewritten where it was: no second row.
          expect([...table.items.keys()].sort()).toEqual(keysOf(stored))
        }),
      ),
    )

    it.effect(`${shape}: the rows 1.39.0 stored read and update`, () =>
      on(toNumber, optional, deep, stored, (aggregate, table) =>
        Effect.gen(function* () {
          expect((yield* aggregate.get({ id: "x" })).lines).toEqual([
            { nested: value, note: "before" },
          ])
          yield* aggregate.update({ id: "x" }, ({ state }: any) => ({
            ...state,
            lines: state.lines.map((line: any) => ({ ...line, note: "after" })),
          }))
          expect((yield* aggregate.get({ id: "x" })).lines).toEqual([
            { nested: value, note: "after" },
          ])
          expect([...table.items.keys()].sort()).toEqual(keysOf(stored))
        }),
      ),
    )

    it.effect(`${shape}: a parent that keeps the kind read back is refused`, () =>
      on(asGiven, optional, deep, [], (aggregate, table) =>
        Effect.gen(function* () {
          const created = yield* Effect.exit(
            aggregate
              .create({ id: "x", lines: [{ nested: held, note: "before" }] })
              .pipe(Effect.asVoid),
          )
          // `{ n: 5n }` keys 38 digits, and reads back `{ n: 5 }`, which keys 16.
          expect(Exit.isFailure(created)).toBe(true)
          const message = JSON.stringify(created)
          expect(message).toContain("EDD-9128")
          expect(message).toContain(`Field \\"${path}\\" of \\"lines\\"`)
          expect(message).toContain("the bigint 5n would read back as a number")
          expect(table.items.size).toBe(0)
        }),
      ),
    )
  }
})
