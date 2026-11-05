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
import { Effect, Layer, Option, Schema } from "effect"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import { toAttributeMap } from "../src/Marshaller.js"
import * as Table from "../src/Table.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"
import { rekeyOutcome } from "./helpers/RekeyOutcome.js"
import {
  clearedHalfLeftScenario,
  clearedIntegerScenario,
  clearedPartitionKeyLimitScenario,
  clearedSortKeyLimitScenario,
  clientOf,
  dryRunPredictsScenario,
  dryRunScenarios,
  Finished,
  foreignRowScenarios,
  type Harness,
  laggingLegacySortKeyScenario,
  laggingPartitionKeyScenario,
  leftCurrentSortKeyScenario,
  Migrating,
  missingKeyScenario,
  moved,
  moveJudgedScenario,
  moveLeavesClearedHalfScenario,
  pathScenario,
  row136,
  rowNow,
  type StoredRow,
  schema,
  TENANT,
  truncatedHeldScenario,
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

describe("what `rekey` does to a row that holds a half's composites", () => {
  it.effect("leaves a 1.36 sort key lagging them: the accepted limit", () =>
    laggingLegacySortKeyScenario(harness().h),
  )
  it.effect("and a key an index policy left in current text", () =>
    leftCurrentSortKeyScenario(harness().h),
  )
  it.effect("and one an old gate truncated", () => truncatedHeldScenario(harness().h))
  it.effect("and writes no key the row doesn't have", () => missingKeyScenario(harness().h))
  it.effect("a sort key truncated under 1.36 is rewritten on an unsharded index", () =>
    truncatedUnshardedScenario(harness().h),
  )
  it.effect("a move leaves nothing to rewrite: the same run judges the row it moved", () =>
    moveJudgedScenario(harness().h),
  )
})

describe("what `rekey` does to a half missing a composite", () => {
  it.effect("leaves it, with no conflict", () => clearedHalfLeftScenario(harness().h))
  it.effect("and a move leaves it too", () => moveLeavesClearedHalfScenario(harness().h))
  it.effect(
    "the accepted limit: a pin misses a sort key's cleared value, a broader query finds",
    () => clearedSortKeyLimitScenario(harness().h),
  )
  it.effect("the accepted limit: a pin misses a partition key's cleared number, `get` reads", () =>
    clearedPartitionKeyLimitScenario(harness().h),
  )
  it.effect("the accepted limit: a partition key lagging its values", () =>
    laggingPartitionKeyScenario(harness().h),
  )
  it.effect("a positive integer whose value went kept its text, and is still pinned", () =>
    clearedIntegerScenario(harness().h),
  )
})

describe("a dry run reports what the real run does", () => {
  for (const scenario of dryRunScenarios) {
    it.effect(scenario.name, () => dryRunPredictsScenario(scenario)(harness().h))
  }
})

describe("a dry run reports a move that would fail", () => {
  const OutOfRange = Entity.make({
    model: Schema.Struct({ id: Schema.Number, tenant: Schema.String, status: Schema.String }),
    entityType: "Ranged",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
    indexes: {
      byX: {
        name: "gsi",
        pk: { field: "gpk", composite: ["tenant"] },
        sk: { field: "gsk", zorder: [{ field: "status", values: ["a", "b"] }] },
      },
    },
  })
  const OutOfRangeTable = Table.make({ schema, entities: { OutOfRange } })

  it.effect("as the real run does: its values compose no key, so nothing moves", () => {
    const table = makeRecordingTable({ indexes: { gsi: { pk: "gpk", sk: "gsk" } } })
    const item = { id: -7, tenant: "t", status: "c" }
    const primary = OutOfRange.indexes.primary
    const row = toAttributeMap({
      ...item,
      pk: KeyText136.composePk(schema, "Ranged", primary, item),
      sk: KeyText136.composeSk(schema, "Ranged", 1, primary, item),
      __edd_e__: "Ranged",
    })
    table.items.set(`${row.pk!.S}|${row.sk!.S}`, row)
    return Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { OutOfRange },
        tables: { OutOfRangeTable },
      })
      const dry = yield* db.tables.OutOfRangeTable.rekey({ dryRun: true })
      const real = yield* db.tables.OutOfRangeTable.rekey()
      expect(real.conflicts.map((conflict) => conflict.reason)).toEqual(["failed"])
      expect(real.moved.item).toBe(0)
      expect(rekeyOutcome(dry)).toEqual(rekeyOutcome(real))
    }).pipe(Effect.provide(Layer.merge(table.layer, OutOfRangeTable.layer({ name: "t" }))))
  })
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

describe("the merge holds over both number texts", () => {
  // 1.36 and the current code spell these differently, so they sort differently; a
  // positive integer they spell alike. A shard holds whichever each row was written with.
  const scoreSchema = DynamoSchema.make({ name: "numbers", version: 1 })
  const model = Schema.Struct({
    id: Schema.String,
    tenant: Schema.String,
    score: Schema.Number,
    tail: Schema.String,
    keep: Schema.Boolean,
  })
  const Numbers = Entity.make({
    model,
    entityType: "N",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
    indexes: {
      byTenant: {
        name: "gsi",
        pk: { field: "gpk", composite: ["tenant"] },
        sk: { field: "gsk", composite: ["score", "tail"] },
        shards: { count: 4, previous: 1 },
      },
    },
  })
  const NumbersTable = Table.make({ schema: scoreSchema, entities: { Numbers } })
  const compareBytes = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b))

  for (const score of [-3, -3.14, 2.5, 1e-7, 42, -10000000]) {
    for (const reverse of [false, true]) {
      it.effect(`${score}, ${reverse ? "reverse" : "forward"}: a filtered fetch chain`, () => {
        const table = makeRecordingTable({ indexes: { gsi: { pk: "gpk", sk: "gsk" } } })
        const index = Numbers.indexes.byTenant
        const rows = Array.from({ length: 48 }, (_, i) => {
          const values = {
            id: String(i).padStart(3, "0"),
            tenant: "t",
            score: i % 4 === 0 ? score + 1 : score,
            tail: `tail ${i}`,
            keep: i % 5 !== 0,
          }
          return toAttributeMap({
            ...values,
            ...KeyComposer.composeAllKeys(scoreSchema, "N", 1, Numbers.indexes, values),
            ...(i % 3 === 0 ? { gpk: KeyText136.composePk(scoreSchema, "N", index, values) } : {}),
            ...(i % 2 === 0
              ? { gsk: KeyText136.composeSk(scoreSchema, "N", 1, index, values) }
              : {}),
            __edd_e__: "N",
          })
        })
        for (const row of rows) table.items.set(`${row.pk!.S}|${row.sk!.S}`, row)
        const expected = rows
          .filter((row) => Number(row.score!.N) === score && row.keep!.BOOL)
          .sort((a, b) => compareBytes(a.gsk!.S!, b.gsk!.S!) * (reverse ? -1 : 1))
          .map((row) => row.id!.S!)
        return Effect.gen(function* () {
          const db = yield* DynamoClient.make({
            entities: { Numbers },
            tables: { NumbersTable },
          })
          const query = db.entities.Numbers.byTenant({ tenant: "t", score })
            .filter({ keep: true })
            .pageSize(1)
            .maxPages(1)
            .select(["id"])
          const base = reverse ? query.reverse() : query
          const got: Array<string> = []
          let cursor: Option.Option<string> = Option.none()
          let pages = 0
          do {
            expect(pages++).toBeLessThan(200)
            const limited = base.limit(1 + (pages % 3))
            const page: any = yield* (
              Option.isSome(cursor) ? limited.startFrom(cursor.value) : limited
            ).fetch()
            got.push(...page.items.map((row: any) => row.id))
            cursor = page.cursor
          } while (Option.isSome(cursor))
          expect(got).toEqual(expected)
          expect(expected.length).toBeGreaterThan(0)
        }).pipe(Effect.provide(Layer.merge(table.layer, NumbersTable.layer({ name: "t" }))))
      })
    }
  }
})

describe("`rekey` over a partition key", () => {
  it.effect("one its values compose isn't judged, though a string makes it read as 1.36's", () => {
    const world = worldOf(undefined, schema, ["id"], ["tenant", "score"])
    const item = { id: "1", name: "n", tenant: "a#score_1", at: 1, score: 42 }
    const row = toAttributeMap({
      ...item,
      ...KeyComposer.composeIndexKeys(schema, "Row", 1, world.Rows.indexes.primary, item),
      ...KeyComposer.composeIndexKeys(schema, "Row", 1, world.Rows.indexes.byTenant, item),
      __edd_e__: "Row",
    }) as StoredRow
    const { h } = harness()
    return Effect.gen(function* () {
      yield* h.seed(row)
      const report = yield* h.inWorld(world, (db: any) => db.tables.MainTable.rekey())
      expect((report as Table.RekeyReport).conflicts).toEqual([])
    })
  })
})

describe("a row moved just as `rekey` reads its target", () => {
  it.effect("isn't under both keys, though another row has taken its old key", () => {
    // `50%` escapes to what 1.36 wrote for `50%25`: the first row's current key is the
    // second's old one, which is how a run moving one can take the other along.
    const { table, h } = harness()
    const second = row136("Row", { id: "1", name: "50%25", region: "r" })
    const first = rowNow("Row", { id: "1", name: "50%", region: "r" })
    const moved = rowNow("Row", { id: "1", name: "50%25", region: "r" })
    expect(first.sk).toEqual(second.sk)
    let raced = false
    table.hooks.onRequest = ({ command, input }) => {
      if (raced || command !== "GetItem" || input.Key.sk.S !== moved.sk!.S) return
      raced = true
      table.items.set(`${moved.pk!.S}|${moved.sk!.S}`, moved)
      table.items.set(`${first.pk!.S}|${first.sk!.S}`, first)
    }
    return Effect.gen(function* () {
      yield* h.seed(second)
      const report = yield* h.inWorld(Migrating, (db: any) => db.tables.MainTable.rekey())
      expect(raced).toBe(true)
      expect((report as Table.RekeyReport).conflicts).toEqual([])
    })
  })
})

it("the fixture's worlds differ only in `shards`", () => {
  expect(KeyComposer.unshardedView(Migrating.Rows.indexes.byTenant).shards).toBeUndefined()
  expect(Finished.Rows.indexes.byTenant.shards?.previous).toBeUndefined()
  expect(Unsharded.Rows.indexes.byTenant.shards).toBeUndefined()
})
