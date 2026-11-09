/**
 * An aggregate's partition key composed again from its stored root (`list`, `rekey`), for a key
 * composite whose transformation isn't its own inverse on the other side: `Schema.Option` of a
 * transformation, or a value stored divided by ten. `create` and `get` compose the key from the
 * domain value; the root stores the encoded one (`Option.some(50)` as a map holding `5`). A key
 * composed from the stored form is other text, so `list` returned nothing and `rekey` counted the
 * root `unrecognizedKey`, and after an `escapeKeys` change `get` found nothing. The key is composed
 * from the root's composites decoded as a read decodes them: the key `create` wrote.
 *
 * A row 1.39.0 wrote under `Schema.Option` of a transformation holds the value `create` decoded,
 * unencoded, so it reads back as a value its key wasn't composed from. `list` and `rekey` skip it,
 * as they do on 1.39.0, and `get` with the value its `create` returned, the one its key was
 * composed from, still finds it. The rows are what
 * published 1.39.0 stored (`helpers/ReadBackKeys.ts`); connected twin:
 * `connected.read-back-keys.test.ts`.
 */

import { it } from "@effect/vitest"
import { Effect, Option, Schema } from "effect"
import { describe, expect } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import {
  rootKeyDefinitions,
  rootKeyIndexes,
  rootKeyRows,
  rootKeyShapes,
  x10,
} from "./helpers/ReadBackKeys.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

const run = <A, E>(
  table: ReturnType<typeof makeRecordingTable>,
  name: string,
  Kind: Schema.Top,
  escapeKeys: boolean,
  body: (aggregate: any, db: any) => Effect.Effect<A, E, any>,
) => {
  const { Main, Roots } = rootKeyDefinitions(name, Kind, escapeKeys)
  return Effect.gen(function* () {
    const db = yield* DynamoClient.make({
      entities: {},
      aggregates: { Roots },
      tables: { Main },
    } as never) as Effect.Effect<any, never, any>
    return yield* body(db.aggregates.Roots, db)
  }).pipe(Effect.provide(Main.layer({ name: "t" })), Effect.provide(table.layer)) as Effect.Effect<
    A,
    unknown
  >
}

const keys = (table: ReturnType<typeof makeRecordingTable>) =>
  [...table.items.values()].map((row: any) => `${row.pk.S} ${row.sk.S}`).sort()

describe("an aggregate's partition key composed from its stored root is the key create wrote", () => {
  for (const { name, Kind, n, text } of rootKeyShapes) {
    for (const escapeKeys of [false, true]) {
      it.effect(`${name}, escapeKeys ${escapeKeys}: get, list and rekey find it`, () => {
        const table = makeRecordingTable({ indexes: rootKeyIndexes })
        return run(table, name, Kind, escapeKeys, (aggregate, db) =>
          Effect.gen(function* () {
            yield* aggregate.create({ id: "a", n, note: "before" })
            expect(keys(table)).toEqual([`$${name}#v1#roots#a#${text} $${name}#v1#root`])
            expect((yield* aggregate.get({ id: "a", n })).n).toEqual(n)
            const listed = yield* aggregate.list({})
            expect(listed.data.map((root: any) => root.n)).toEqual([n])
            const report = yield* db.tables.Main.rekey()
            expect(report.conflicts).toEqual([])
            expect(report.skipped.unrecognizedKey).toBe(0)
            expect(report.moved.aggregate).toBe(0)
            expect(keys(table)).toEqual([`$${name}#v1#roots#a#${text} $${name}#v1#root`])
          }),
        )
      })
    }

    it.effect(`${name}: rekey moves it on an escapeKeys change, and get finds it there`, () => {
      const table = makeRecordingTable({ indexes: rootKeyIndexes })
      return Effect.gen(function* () {
        yield* run(table, name, Kind, false, (aggregate) =>
          aggregate.create({ id: "a#b", n, note: "before" }),
        )
        yield* run(table, name, Kind, true, (aggregate, db) =>
          Effect.gen(function* () {
            const dry = yield* db.tables.Main.rekey({ dryRun: true })
            expect(dry.moved.aggregate).toBe(1)
            const report = yield* db.tables.Main.rekey()
            expect(report.moved.aggregate).toBe(1)
            expect(report.conflicts).toEqual([])
            expect(report.skipped.unrecognizedKey).toBe(0)
            expect(keys(table)).toEqual([`$${name}#v1#roots#a%23b#${text} $${name}#v1#root`])
            expect((yield* aggregate.get({ id: "a#b", n })).note).toBe("before")
            expect((yield* aggregate.list({})).data).toHaveLength(1)
          }),
        )
      })
    })
  }

  it.effect(
    "the rows 1.39.0 stored: a transformation's are found, an Option of one's as on 1.39.0",
    () => {
      const table = makeRecordingTable({ indexes: rootKeyIndexes })
      for (const row of rootKeyRows) {
        table.items.set(`${row.pk.S}|${row.sk.S}`, structuredClone(row) as never)
      }
      const before = keys(table)
      return Effect.gen(function* () {
        // 1.39.0 decoded `create`'s `5` to `50`, keyed `50`'s stored form and stored it so.
        yield* run(table, "x10", x10, false, (aggregate, db) =>
          Effect.gen(function* () {
            expect((yield* aggregate.get({ id: "a", n: 50 })).n).toBe(50)
            expect((yield* aggregate.list({})).data.map((root: any) => root.n)).toEqual([50])
            const report = yield* db.tables.Main.rekey()
            expect(report.skipped.unrecognizedKey).toBe(0)
            expect(report.conflicts).toEqual([])
          }),
        )
        // 1.39.0 decoded `create`'s `Option.some(5)` to `Option.some(50)`, keyed it `some(50)` and
        // stored it unencoded, so it reads back as `Option.some(500)`, which keys `some(500)`.
        yield* run(table, "optionx10", Schema.Option(x10), false, (aggregate, db) =>
          Effect.gen(function* () {
            expect((yield* aggregate.get({ id: "a", n: Option.some(50) })).n).toEqual(
              Option.some(500),
            )
            expect((yield* aggregate.list({})).data).toEqual([])
            const report = yield* db.tables.Main.rekey()
            expect(report.skipped.unrecognizedKey).toBe(1)
            expect(report.conflicts).toEqual([])
          }),
        )
        expect(keys(table)).toEqual(before)
      })
    },
  )
})
