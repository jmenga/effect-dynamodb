/**
 * Migrating an index to shards over rows still holding 1.36 key text (#183, design
 * §9.3), on a table that stores what it is sent: the scenarios themselves are in
 * `helpers/ShardedLegacyRows.ts`, and `connected.sharded-legacy-text.test.ts` runs
 * them on DynamoDB Local. This file adds what a request log and a brute force can
 * show: what the reads cost, and that the merge holds over both texts.
 */

import { describe, expect, it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import * as KeyText136 from "@effect-dynamodb/schema/internal/KeyText136.js"
import * as KeyComposer from "@effect-dynamodb/schema/KeyComposer.js"
import { Effect, Layer, Option } from "effect"
import { makeRecordingTable } from "./helpers/RecordingTable.js"
import {
  clientOf,
  currentTextLeftScenario,
  Finished,
  foreignRowScenarios,
  type Harness,
  legacySortKeyScenario,
  Migrating,
  moved,
  moveJudgedScenario,
  moveLeavesLegacySortKeyScenario,
  pathScenario,
  row136,
  rowNow,
  type StoredRow,
  schema,
  TENANT,
  truncatedUnshardedScenario,
  Unsharded,
  type World,
  worldOf,
  writePaths,
} from "./helpers/ShardedLegacyRows.js"

const harness = () => {
  const table = makeRecordingTable({ indexes: { gsi: { pk: "gpk", sk: "gsk" } } })
  const h: Harness = {
    seed: (row) =>
      Effect.sync(() => {
        table.items.set(`${row.pk!.S}|${row.sk!.S}`, row)
      }),
    rows: () => Effect.sync(() => [...table.items.values()].filter((row) => row.gpk !== undefined)),
    inWorld: (world, body) =>
      Effect.gen(function* () {
        const db = yield* clientOf(world)
        return yield* body(db)
      }).pipe(
        Effect.provide(Layer.merge(table.layer, world.MainTable.layer({ name: "migrating" }))),
      ) as never,
  }
  return { table, h }
}

const queries = (table: ReturnType<typeof makeRecordingTable>) =>
  table.requests.filter((request) => request.command === "Query")

describe("a row stays reachable by the same pins", () => {
  for (const path of writePaths) {
    describe(path.name, () => {
      it.effect("a whole row", () => pathScenario(path, "whole", harness().h))
      if (path.wholeOnly !== true) {
        it.effect("a truncated row", () => pathScenario(path, "truncated", harness().h))
      }
    })
  }
})

describe("each row once, by its own pins", () => {
  for (const scenario of foreignRowScenarios) {
    it.effect(scenario.name, () => scenario.run(harness().h))
  }
})

describe("what `rekey` reports", () => {
  it.effect("a 1.36 sort key it can't rewrite is a conflict, every run, until it's written", () =>
    legacySortKeyScenario(harness().h),
  )
  it.effect("a key an index policy left in current text is not", () =>
    currentTextLeftScenario(harness().h),
  )
  it.effect("a sort key truncated under 1.36 is rewritten on an unsharded index", () =>
    truncatedUnshardedScenario(harness().h),
  )

  it.effect("a move leaves nothing unreported: the same run judges the row it moved", () =>
    moveJudgedScenario(harness().h),
  )
  it.effect("and a move that leaves a 1.36 sort key it can't rewrite says so", () =>
    moveLeavesLegacySortKeyScenario(harness().h),
  )
})

describe("what the reads cost", () => {
  const costOf = (world: World, rows: ReadonlyArray<StoredRow>, pins: Record<string, string>) => {
    const { table, h } = harness()
    return Effect.gen(function* () {
      for (const row of rows) yield* h.seed(row)
      return yield* h.inWorld(world, (db: any) =>
        Effect.gen(function* () {
          table.requests.length = 0
          const found = yield* db.entities.Rows.byTenant(pins).collect()
          return { found: found.length, requests: queries(table).length }
        }),
      )
    })
  }

  it.effect("pins whose text differs: every shard under both texts, and the 1.36 key", () =>
    Effect.gen(function* () {
      const { found, requests } = yield* costOf(
        Migrating,
        [moved("Row", { id: "1", region: "new york" })],
        { tenant: TENANT, region: "new york" },
      )
      expect(found).toBe(1)
      // 8 shards and the unsharded layout under the current text, 8 shards under
      // 1.36's, and the unsharded layout under 1.36's.
      expect(requests).toBe(18)
    }),
  )

  it.effect("pins whose text didn't change: what any fan-out reads", () =>
    Effect.gen(function* () {
      const { found, requests } = yield* costOf(
        Migrating,
        [rowNow("Row", { id: "1", region: "boston" })],
        { tenant: TENANT, region: "boston" },
      )
      expect(found).toBe(1)
      expect(requests).toBe(9)
    }),
  )

  it.effect("a pruned read: its one shard under both texts, and the unsharded layout's", () => {
    const worldBy = worldOf({ count: 8, by: ["region"], previous: 1 })
    const { table, h } = harness()
    const values = { id: "1", region: "new york" }
    const index = worldBy.Rows.indexes.byTenant
    const item = { ...values, name: "n", tenant: TENANT }
    return Effect.gen(function* () {
      yield* h.seed({
        ...moved("Row", values),
        gpk: { S: KeyComposer.composePk(schema, "Row", index, item) },
      })
      const { found, requests } = yield* h.inWorld(worldBy, (db: any) =>
        Effect.gen(function* () {
          table.requests.length = 0
          const rows = yield* db.entities.Rows.byTenant({
            tenant: TENANT,
            region: "new york",
          }).collect()
          return { found: rows.length, requests: queries(table).length }
        }),
      )
      expect(found).toBe(1)
      expect(requests).toBe(4)
    })
  })

  it.effect("with the fallback off: no 1.36 read, even under `previous: 1`", () => {
    const worldOff = worldOf(
      { count: 8, previous: 1 },
      DynamoSchema.make({
        name: "migrating",
        version: 1,
        legacyKeys: false,
      }),
    )
    const { table, h } = harness()
    return Effect.gen(function* () {
      yield* h.seed(rowNow("Row", { id: "1", region: "new york" }))
      const requests = yield* h.inWorld(worldOff, (db: any) =>
        Effect.gen(function* () {
          table.requests.length = 0
          const rows = yield* db.entities.Rows.byTenant({
            tenant: TENANT,
            region: "new york",
          }).collect()
          expect(rows).toHaveLength(1)
          return queries(table).length
        }),
      )
      expect(requests).toBe(9)
    })
  })

  it.effect("with `previous` gone: no 1.36 read, whatever the pins", () =>
    Effect.gen(function* () {
      const { found, requests } = yield* costOf(
        Finished,
        [rowNow("Row", { id: "1", region: "new york" })],
        { tenant: TENANT, region: "new york" },
      )
      expect(found).toBe(1)
      expect(requests).toBe(8)
    }),
  )
})

describe("the merge holds over both texts", () => {
  /** A deterministic PRNG (mulberry32), so a failing seed reproduces. */
  const prng = (seed: number) => {
    let a = seed >>> 0
    return () => {
      a = (a + 0x6d2b79f5) >>> 0
      let t = a
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }
  const REGIONS = ["new york", "new", "a b", "a%20b", "50%", "boston", "new yorker"]
  const compareBytes = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b))

  /** Rows of one region in every form a migration can leave: unique sort keys. */
  const seedRows = (next: () => number, region: string, count: number) =>
    Array.from({ length: count }, (_, n) => {
      const values = {
        id: `row-${n}`,
        region,
        zone: "z",
        group: `g${n}${next() < 0.5 ? " x" : ""}`,
      }
      const form = next()
      return form < 0.4
        ? rowNow("Row", values)
        : form < 0.8
          ? moved("Row", values)
          : row136("Row", values, {
              pk: rowNow("Row", values).pk!.S,
              sk: rowNow("Row", values).sk!.S,
            })
    })

  for (const [seed, region] of REGIONS.entries()) {
    for (const reverse of [false, true]) {
      it.effect(
        `\`${region}\`, ${reverse ? "reverse" : "forward"}: pages equal collect() equal a brute force`,
        () => {
          const next = prng(seed + 1)
          const { h } = harness()
          const rows = seedRows(next, region, 40)
          return Effect.gen(function* () {
            for (const row of rows) yield* h.seed(row)
            yield* h.inWorld(Migrating, (db: any) =>
              Effect.gen(function* () {
                const query = () => {
                  const q = db.entities.Rows.byTenant({ tenant: TENANT, region })
                  return reverse ? q.reverse() : q
                }
                const collected: ReadonlyArray<any> = yield* query().collect()

                const texts = new Map(rows.map((row) => [row.id!.S!, row.gsk!.S!]))
                const expected = [...texts.keys()].sort((a, b) =>
                  reverse
                    ? compareBytes(texts.get(b)!, texts.get(a)!)
                    : compareBytes(texts.get(a)!, texts.get(b)!),
                )
                expect(collected.map((row) => row.id)).toEqual(expected)
                expect(yield* query().count()).toBe(expected.length)

                // A limit landing anywhere, through both texts.
                const paged: Array<string> = []
                let cursor: Option.Option<string> = Option.none()
                do {
                  const limit = 1 + Math.floor(next() * 7)
                  const base = query().limit(limit)
                  const page: any = yield* (
                    Option.isSome(cursor) ? base.startFrom(cursor.value) : base
                  ).fetch()
                  expect(page.items.length).toBeLessThanOrEqual(limit)
                  paged.push(...page.items.map((row: any) => row.id))
                  cursor = page.cursor
                } while (Option.isSome(cursor))
                expect(paged).toEqual(expected)

                // A projection that omits what the row checks and the merge read.
                const selected: ReadonlyArray<any> = yield* query().select(["id"]).collect()
                expect(selected.map((row) => row.id)).toEqual(expected)
              }),
            )
          })
        },
      )
    }
  }
})

describe("isSortKeyText136: judging text with no values to compose it from", () => {
  const index = Migrating.Rows.indexes.byTenant
  const judged = (stored: string, record: Record<string, unknown> = {}) =>
    KeyText136.isSortKeyText136(schema, "Row", 1, index, stored, record)
  const prefix = "$migrating#v1#row"

  it("current text is not", () => {
    expect(judged(`${prefix}#region_a%20b#zone_z#group_g`)).toBe(false)
    expect(judged(`${prefix}#region_a`)).toBe(false)
    expect(judged(prefix)).toBe(false)
  })

  it("a character 1.37 escapes", () => {
    expect(judged(`${prefix}#region_a b`)).toBe(true)
    expect(judged(`${prefix}#region_a!b`)).toBe(true)
    expect(judged(`${prefix}#region_a$b`)).toBe(true)
  })

  it("a `%` that starts no escape", () => {
    expect(judged(`${prefix}#region_50%`)).toBe(true)
    expect(judged(`${prefix}#region_50%2`)).toBe(true)
    expect(judged(`${prefix}#region_50%zz`)).toBe(true)
  })

  it("a `#` a value held: a segment no composite labels", () => {
    expect(judged(`${prefix}#region_a#b`)).toBe(true)
  })

  it("a number in 1.36's form, for a composite the row holds as a number", () => {
    const num = { region: 1 }
    expect(judged(`${prefix}#region_00000000000002.5`, num)).toBe(true)
    expect(judged(`${prefix}#region_00000000000000-3`, num)).toBe(true)
    expect(judged(`${prefix}#region_12345678901234567`, num)).toBe(true)
    expect(judged(`${prefix}#region_0000000000000042`, num)).toBe(false)
    expect(judged(`${prefix}#region_0000000000000002.5`, num)).toBe(false)
    expect(judged(`${prefix}#region_:0161`, num)).toBe(false)
    expect(judged(`${prefix}#region_-9999999999999996.85:`, num)).toBe(false)
    expect(judged(`${prefix}#region_${"0".repeat(38)}`, { region: 1n })).toBe(false)
  })

  it("text under another prefix is no key of this index", () => {
    expect(judged("$other#v1#row#region_a b")).toBe(false)
  })

  it("a value spelled like an escape can't be told from one", () => {
    expect(judged(`${prefix}#region_50%25`)).toBe(false)
  })
})

it("the fixture's worlds differ only in `shards`", () => {
  expect(KeyComposer.unshardedView(Migrating.Rows.indexes.byTenant).shards).toBeUndefined()
  expect(Finished.Rows.indexes.byTenant.shards?.previous).toBeUndefined()
  expect(Unsharded.Rows.indexes.byTenant.shards).toBeUndefined()
})
