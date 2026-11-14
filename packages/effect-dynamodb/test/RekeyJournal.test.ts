/**
 * What a `rekey` run remembers (#240, `RekeyJournal`): a row it doesn't move costs it nothing, what
 * it keeps is bounded by `journalCapacity`, and past that the run carries on, moves every row and
 * says which counts may be off. The scale cases run at sizes CI affords, the mechanism exercised by
 * a small capacity: a run over untouched rows that keeps one entry at most keeps none, and one that
 * moves thousands of rows through a hundred entries moves every one.
 */
import { setFlagsFromString } from "node:v8"
import { runInNewContext } from "node:vm"
import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { describe, expect, it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Effect, Layer, Schema } from "effect"
import { DynamoClient, type DynamoClientService } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"
import { mockDynamoClient } from "./helpers/MockDynamoClient.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

type Item = Record<string, AttributeValue>

setFlagsFromString("--expose_gc")
const gc = runInNewContext("gc") as () => void

const world = () => {
  const schema = DynamoSchema.make({ name: "mem", version: 1, escapeKeys: true })
  const Items = Entity.make({
    model: Schema.Struct({ id: Schema.String, body: Schema.String }),
    entityType: "Item",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
  })
  const MainTable = Table.make({ schema, entities: { Items } })
  return { MainTable, client: DynamoClient.make({ entities: { Items }, tables: { MainTable } }) }
}

/** Item `n`: its id holds a space, so its key text moves (`%20`) when `current` is false. */
const itemRow = (n: number, current: boolean, body = "b"): Item => ({
  pk: { S: `$mem#v1#item#id_${n}${current ? "%20" : " "}x` },
  sk: { S: "$mem#v1#item" },
  __edd_e__: { S: "Item" },
  id: { S: `${n} x` },
  body: { S: body },
})

/** A row of another application on the same table. */
const foreignRow = (n: number): Item => ({
  pk: { S: `customer#${String(n).padStart(12, "0")}` },
  sk: { S: "profile" },
  data: { S: "x" },
})

const INEXACT_REAL = [
  "scanned",
  "unchanged",
  "moved",
  "sentinelsMoved",
  "indexKeys",
  "reservations",
  "conflicts",
  "skipped",
]

/** A recording table holding `count` items under the key text that moves. */
const tableToMove = (count: number) => {
  const table = makeRecordingTable()
  for (let n = 0; n < count; n++) {
    const row = itemRow(n, false)
    table.items.set(`${row.pk!.S}|${row.sk!.S}`, row)
  }
  return table
}

const keysOf = (items: Iterable<Item>) =>
  [...items].map((item) => `${item.pk!.S}|${item.sk!.S}`).sort()

describe("rekey's journal", () => {
  it.effect(
    "keeps nothing for rows it doesn't move: untouched rows cost no entry",
    () =>
      Effect.gen(function* () {
        const on = world()
        const PAGE = 25_000
        const PAGES = 8
        // Every other page is items under their current keys; the rest, another application's rows.
        let page = 0
        const client = mockDynamoClient({
          scan: () =>
            Effect.sync(() => {
              const at = page++
              const Items = Array.from({ length: PAGE }, (_, i) =>
                at % 2 === 0 ? foreignRow(at * PAGE + i) : itemRow(at * PAGE + i, true),
              )
              return {
                Items,
                ...(page < PAGES && {
                  LastEvaluatedKey: { pk: Items[PAGE - 1]!.pk!, sk: Items[PAGE - 1]!.sk! },
                }),
              } as never
            }),
        })
        let first = 0
        let peak = 0
        const report = yield* Effect.gen(function* () {
          const db = yield* on.client
          return yield* db.tables.MainTable.rekey({
            journalCapacity: 1,
            onProgress: () =>
              Effect.sync(() => {
                gc()
                const used = process.memoryUsage().heapUsed
                if (page === 1) first = used
                else peak = Math.max(peak, used)
              }),
          })
        }).pipe(
          Effect.provide(
            Layer.merge(Layer.succeed(DynamoClient, client), on.MainTable.layer({ name: "t" })),
          ),
        )
        expect(report.scanned).toBe(PAGE * PAGES)
        expect(report.unchanged).toBe((PAGE * PAGES) / 2)
        expect(report.skipped.notLibrary).toBe((PAGE * PAGES) / 2)
        // One entry at most, and none taken: nothing the run met is remembered.
        expect(report.journal).toEqual({ capacity: 1, used: 0, full: false, inexact: [] })
        // The heap holds nothing per row: 200,000 rows at 208 bytes each would be 40 MiB.
        expect((peak - first) / 1048576).toBeLessThan(16)
      }),
    // 200,000 rows and a collection per page: seconds on an idle machine, more under load.
    120_000,
  )

  it.effect(
    "under its capacity, counts exactly what it moved and met",
    () =>
      Effect.gen(function* () {
        const on = world()
        const table = tableToMove(3_000)
        const report = yield* Effect.gen(function* () {
          const db = yield* on.client
          return yield* db.tables.MainTable.rekey({ pageSize: 100 })
        }).pipe(Effect.provide(Layer.merge(table.layer, on.MainTable.layer({ name: "t" }))))
        expect(report).toMatchObject({
          scanned: 3_000,
          unchanged: 0,
          moved: { item: 3_000 },
          conflicts: [],
          journal: { capacity: 1_000_000, full: false, inexact: [] },
        })
        expect(keysOf(table.items.values())).toEqual(
          keysOf(Array.from({ length: 3_000 }, (_, n) => itemRow(n, true))),
        )
      }),
    // 3,000 rows: under a second here, several times that on CI.
    30_000,
  )

  it.effect(
    "past its capacity, carries on: every row moves, and the report says what may be off",
    () =>
      Effect.gen(function* () {
        const on = world()
        const table = tableToMove(3_000)
        const runs = yield* Effect.gen(function* () {
          const db = yield* on.client
          const dry = yield* db.tables.MainTable.rekey({
            pageSize: 100,
            journalCapacity: 100,
            dryRun: true,
          })
          const writesByDry = table.requests.filter(
            (request) => !["GetItem", "Query", "Scan", "BatchGetItem"].includes(request.command),
          ).length
          const real = yield* db.tables.MainTable.rekey({ pageSize: 100, journalCapacity: 100 })
          const again = yield* db.tables.MainTable.rekey({ pageSize: 100, journalCapacity: 100 })
          return { dry, writesByDry, real, again }
        }).pipe(Effect.provide(Layer.merge(table.layer, on.MainTable.layer({ name: "t" }))))
        // The dry run writes nothing, and says its counts may all be off.
        expect(runs.writesByDry).toBe(0)
        expect(runs.dry.journal).toEqual({
          capacity: 100,
          used: runs.dry.journal.used,
          full: true,
          inexact: [
            "scanned",
            "unchanged",
            "moved",
            "indexKeysRewritten",
            "sentinelsMoved",
            "indexKeys",
            "reservations",
            "guardGaps",
            "conflicts",
            "skipped",
          ],
        })
        expect(runs.dry.journal.used).toBeLessThanOrEqual(100)
        // Every row moves, each once: the writes are guarded whatever the journal holds.
        expect(runs.real.moved.item).toBe(3_000)
        expect(runs.real.conflicts).toEqual([])
        expect(runs.real.journal).toEqual({
          capacity: 100,
          used: runs.real.journal.used,
          full: true,
          inexact: INEXACT_REAL,
        })
        expect(runs.real.journal.used).toBeLessThanOrEqual(100)
        expect(keysOf(table.items.values())).toEqual(
          keysOf(Array.from({ length: 3_000 }, (_, n) => itemRow(n, true))),
        )
        // A rerun finds every row current, and has nothing to keep.
        expect(runs.again).toMatchObject({
          scanned: 3_000,
          unchanged: 3_000,
          moved: { item: 0 },
          journal: { capacity: 100, used: 0, full: false, inexact: [] },
        })
      }),
    // 3,000 rows, three runs: under a second here, several times that on CI.
    30_000,
  )

  it.effect(
    "moving large rows keeps none of them once each page is done",
    () =>
      Effect.gen(function* () {
        const on = world()
        const count = 1_200
        const width = 64 * 1024
        const moved = new Set<number>()
        const big = (n: number, current: boolean) =>
          itemRow(n, current, String.fromCharCode(65 + (n % 26)).repeat(width))
        const numberOf = (text: string) => Number(/#id_(\d+)/.exec(text)?.[1])
        let page = 0
        const client: DynamoClientService = mockDynamoClient({
          scan: () =>
            Effect.sync(() => {
              const n = page++
              return {
                Items: [big(n, false)],
                ...(page < count && { LastEvaluatedKey: { pk: { S: String(n) }, sk: { S: "x" } } }),
              } as never
            }),
          getItem: (input) =>
            Effect.sync(() => {
              const text = input.Key!.pk!.S!
              const n = numberOf(text)
              const current = text.includes("%20")
              return (moved.has(n) === current ? { Item: big(n, current) } : {}) as never
            }),
          transactWriteItems: (input) =>
            Effect.sync(() => {
              for (const item of input.TransactItems ?? []) {
                if (item.Delete !== undefined) moved.add(numberOf(item.Delete.Key!.pk!.S!))
              }
              return {} as never
            }),
        })
        let first = 0
        let last = 0
        const report = yield* Effect.gen(function* () {
          const db = yield* on.client
          return yield* db.tables.MainTable.rekey({
            pageSize: 1,
            concurrency: 1,
            onProgress: () =>
              Effect.sync(() => {
                if (page !== 1 && page !== count) return
                gc()
                if (page === 1) first = process.memoryUsage().heapUsed
                else last = process.memoryUsage().heapUsed
              }),
          })
        }).pipe(
          Effect.provide(
            Layer.merge(Layer.succeed(DynamoClient, client), on.MainTable.layer({ name: "t" })),
          ),
        )
        expect(report.moved.item).toBe(count)
        // 1,200 rows of 64 KiB are 75 MiB: the run keeps no row it moved.
        expect(last - first).toBeLessThan(20 * 1048576)
      }),
    120_000,
  )

  it.effect("refuses a journalCapacity that isn't a positive integer up to 16,000,000", () =>
    Effect.gen(function* () {
      const on = world()
      const table = tableToMove(1)
      const problems = yield* Effect.gen(function* () {
        const db = yield* on.client
        return yield* Effect.forEach([0, 1.5, -3, 16_000_001], (journalCapacity) =>
          Effect.flip(db.tables.MainTable.rekey({ journalCapacity })),
        )
      }).pipe(Effect.provide(Layer.merge(table.layer, on.MainTable.layer({ name: "t" }))))
      for (const problem of problems) {
        expect(problem._tag).toBe("ValidationError")
        expect(String((problem as { cause?: unknown }).cause)).toContain("[EDD-9098]")
        expect(String((problem as { cause?: unknown }).cause)).toContain("journalCapacity")
      }
      expect(table.requests).toEqual([])
    }),
  )
})
