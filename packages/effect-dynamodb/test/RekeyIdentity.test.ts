/**
 * `rekey` tells keys apart by every key attribute's type and value (#240): the units it judges once
 * (`Rekey.rowUnit` and the rest), the keys its journal follows and the moves it counts never take
 * two different keys for one, whatever characters the key text holds.
 *
 * Up to the fix, a unit was its key's texts joined with NUL, so a row at (`x`, `y\0…#s_z`) and one
 * at (`x\0…#s_y`, `z`) were one unit: the second was taken for judged, and stayed under its old key.
 * Each scenario runs in both directions, and a dry run reports what the real run does.
 */
import { describe, expect, it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Effect, Layer, Schema } from "effect"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Rekey from "../src/internal/Rekey.js"
import * as Table from "../src/Table.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

const world = (escapeKeys: boolean) => {
  const schema = DynamoSchema.make({ name: "nul", version: 1, escapeKeys })
  const Items = Entity.make({
    model: Schema.Struct({ p: Schema.String, s: Schema.String, data: Schema.String }),
    entityType: "Item",
    primaryKey: {
      pk: { field: "pk", composite: ["p"] },
      sk: { field: "sk", composite: ["s"] },
    },
  })
  const MainTable = Table.make({ schema, entities: { Items } })
  return {
    MainTable,
    client: DynamoClient.make({ entities: { Items }, tables: { MainTable } }),
  }
}

/** Two items whose key texts, joined with NUL, are one text when written without escaping. */
const VALUES = [
  { p: "x", s: "y\u0000$nul#v1#item#s_z", data: "first" },
  { p: "x\u0000$nul#v1#item#s_y", s: "z", data: "second" },
]

const scenario = (from: boolean, dryRun: boolean) =>
  Effect.gen(function* () {
    const table = makeRecordingTable()
    const on = (w: ReturnType<typeof world>) =>
      Effect.provide(Layer.merge(table.layer, w.MainTable.layer({ name: "t" })))
    const was = world(from)
    const now = world(!from)
    yield* Effect.gen(function* () {
      const db = yield* was.client
      for (const value of VALUES) yield* db.entities.Items.put(value).asEffect()
    }).pipe(on(was))
    expect(table.items.size).toBe(2)
    const before = [...table.items.keys()]
    const report = yield* Effect.gen(function* () {
      const db = yield* now.client
      return yield* db.tables.MainTable.rekey({ concurrency: 1, dryRun })
    }).pipe(on(now))
    return { report, before, table }
  })

describe("rekey tells keys apart by their attributes' values, whatever characters they hold", () => {
  for (const from of [false, true]) {
    const direction = from ? "escaped to unescaped" : "unescaped to escaped"
    it.effect(`two rows whose keys joined with NUL are one text both move (${direction})`, () =>
      Effect.gen(function* () {
        const { report, before, table } = yield* scenario(from, false)
        expect(report.scanned).toBe(2)
        expect(report.moved.item).toBe(2)
        expect(report.conflicts).toEqual([])
        expect(before.filter((key) => table.items.has(key))).toEqual([])
        expect(table.items.size).toBe(2)
      }),
    )

    it.effect(`a dry run reports the same (${direction})`, () =>
      Effect.gen(function* () {
        const { report, before, table } = yield* scenario(from, true)
        expect(report.scanned).toBe(2)
        expect(report.moved.item).toBe(2)
        expect(report.conflicts).toEqual([])
        expect([...table.items.keys()]).toEqual(before)
      }),
    )
  }

  it("a unit is one text only for the same kind and key", () => {
    const units = [
      Rekey.rowUnit("x", "y\u0000z"),
      Rekey.rowUnit("x\u0000y", "z"),
      Rekey.rowUnit("x", undefined),
      Rekey.rowUnit("x", ""),
      Rekey.rowUnit({ S: "1" }, { S: "2" }),
      Rekey.rowUnit({ N: "1" }, { S: "2" }),
      Rekey.rowUnit({ B: new Uint8Array([1]) }, { S: "2" }),
      Rekey.rowUnit({ B: new Uint8Array([1, 0]) }, { S: "2" }),
      Rekey.reservationUnit("x", "y\u0000z"),
      Rekey.reservationUnit("x\u0000y", "z"),
      Rekey.identity("row", "x", "y"),
    ]
    expect(new Set(units).size).toBe(units.length)
    // A string is a key attribute's S value.
    expect(Rekey.rowUnit("1", "2")).toBe(Rekey.rowUnit({ S: "1" }, { S: "2" }))
    // A number by its value, as DynamoDB keeps it.
    expect(Rekey.rowUnit({ N: "1.0" }, { S: "2" })).toBe(Rekey.rowUnit({ N: "1" }, { S: "2" }))
  })

  it("identity is one text only for equal parts", () => {
    expect(Rekey.identity("a\u0000b", "c")).not.toBe(Rekey.identity("a", "b\u0000c"))
    expect(Rekey.identity("a", "")).not.toBe(Rekey.identity("a"))
    expect(Rekey.identity('a","b')).not.toBe(Rekey.identity("a", "b"))
    expect(Rekey.identity("a", "b")).toBe(Rekey.identity("a", "b"))
  })
})
