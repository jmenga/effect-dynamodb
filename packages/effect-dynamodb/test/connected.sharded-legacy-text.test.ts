/**
 * Migrating an index to shards over rows still holding 1.36 key text (#183, design
 * §9.3) — connected tests against DynamoDB Local: the scenarios of
 * `helpers/ShardedLegacyRows.ts` on real writes, a real index and real byte order.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 */

import { describe, expect, it } from "@effect/vitest"
import { Config, Effect, Layer } from "effect"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Table from "../src/Table.js"
import {
  clearedHalfLeftScenario,
  clearedIntegerScenario,
  clearedPartitionKeyLimitScenario,
  clearedSortKeyLimitScenario,
  clientOf,
  dryRunPredictsScenario,
  dryRunScenarios,
  foreignRowScenarios,
  type Harness,
  Migrating,
  missingKeyScenario,
  moved,
  moveJudgedScenario,
  moveLeavesClearedHalfScenario,
  pathScenario,
  rowNow,
  type StoredRow,
  staleCurrentSortKeyScenario,
  staleLegacySortKeyScenario,
  TENANT,
  truncatedHeldScenario,
  truncatedUnshardedScenario,
  writePaths,
} from "./helpers/ShardedLegacyRows.js"

const ENDPOINT = Effect.runSync(
  Config.String("DYNAMODB_ENDPOINT").pipe(Config.withDefault("http://localhost:8000")),
)

let dynamoAvailable = false
try {
  const res = await fetch(ENDPOINT, { method: "POST", signal: AbortSignal.timeout(1000) }).catch(
    () => null,
  )
  dynamoAvailable = res !== null
} catch {
  dynamoAvailable = false
}
const describeConnected = dynamoAvailable ? describe : describe.skip

const ClientLayer = DynamoClient.layer({
  region: "us-east-1",
  endpoint: ENDPOINT,
  credentials: { accessKeyId: "local", secretAccessKey: "local" },
})

let tables = 0

/** Run a scenario over a fresh table, deleted afterwards. */
const onTable = <A, E>(scenario: (h: Harness) => Effect.Effect<A, E, any>) => {
  const tableName = `migrating-${Date.now()}-${tables++}`
  const h: Harness = {
    seed: (row) =>
      Effect.gen(function* () {
        const client = yield* DynamoClient
        yield* client.putItem({ TableName: tableName, Item: row })
      }).pipe(Effect.provide(ClientLayer)),
    rows: () =>
      Effect.gen(function* () {
        const client = yield* DynamoClient
        const page = yield* client.scan({ TableName: tableName })
        return ((page.Items ?? []) as ReadonlyArray<StoredRow>).filter(
          (row) => row.gpk !== undefined,
        )
      }).pipe(Effect.provide(ClientLayer)),
    inWorld: (world, body) =>
      Effect.gen(function* () {
        const db = yield* clientOf(world)
        return yield* body(db)
      }).pipe(
        Effect.provide(Layer.merge(ClientLayer, world.MainTable.layer({ name: tableName }))),
      ) as never,
  }
  const create = Effect.gen(function* () {
    const client = yield* DynamoClient
    yield* client.createTable({
      TableName: tableName,
      BillingMode: "PAY_PER_REQUEST",
      ...Table.definition(Migrating.MainTable),
    })
  })
  const drop = Effect.gen(function* () {
    const client = yield* DynamoClient
    yield* client.deleteTable({ TableName: tableName })
  }).pipe(Effect.ignore)
  return Effect.acquireUseRelease(
    create,
    () => scenario(h),
    () => drop,
  ).pipe(Effect.scoped, Effect.provide(ClientLayer)) as Effect.Effect<A, E>
}

describeConnected("#183 a row stays reachable by the same pins", () => {
  for (const path of writePaths) {
    describe(path.name, () => {
      it.live("a whole row", () => onTable((h) => pathScenario(path, "whole", h)))
      if (path.wholeOnly !== true) {
        it.live("a truncated row", () => onTable((h) => pathScenario(path, "truncated", h)))
      }
    })
  }
})

describeConnected("#183 each row once, by its own pins", () => {
  for (const scenario of foreignRowScenarios) {
    it.live(scenario.name, () => onTable(scenario.run))
  }
})

describeConnected("#183 a dry run reports what the real run does", () => {
  for (const scenario of dryRunScenarios) {
    it.live(scenario.name, () => onTable(dryRunPredictsScenario(scenario)))
  }
})

describeConnected("#183 what `rekey` does to a row that holds a half's composites", () => {
  it.live("rewrites a 1.36 sort key they no longer compose", () =>
    onTable(staleLegacySortKeyScenario),
  )
  it.live("and a key an index policy left in current text", () =>
    onTable(staleCurrentSortKeyScenario),
  )
  it.live("and one an old gate truncated", () => onTable(truncatedHeldScenario))
  it.live("and writes no key the row doesn't have", () => onTable(missingKeyScenario))
  it.live("a sort key truncated under 1.36 is rewritten on an unsharded index", () =>
    onTable(truncatedUnshardedScenario),
  )
  it.live("a move leaves nothing to rewrite: the same run judges the row it moved", () =>
    onTable(moveJudgedScenario),
  )
})

describeConnected("#183 what `rekey` does to a half missing a composite", () => {
  it.live("leaves it, with no conflict", () => onTable(clearedHalfLeftScenario))
  it.live("and a move leaves it too", () => onTable(moveLeavesClearedHalfScenario))
  it.live(
    "the accepted limit: a pin misses a sort key's cleared value, a broader query finds",
    () => onTable(clearedSortKeyLimitScenario),
  )
  it.live("the accepted limit: a pin misses a partition key's cleared number, `get` reads", () =>
    onTable(clearedPartitionKeyLimitScenario),
  )
  it.live("a positive integer whose value went kept its text, and is still pinned", () =>
    onTable(clearedIntegerScenario),
  )
})

describeConnected("#183 the merge holds over both texts", () => {
  it.live("pages of both texts equal collect() in stored byte order, both ways", () =>
    onTable((h) =>
      Effect.gen(function* () {
        const region = "new york"
        const rows = Array.from({ length: 30 }, (_, n) => {
          const values = { id: `row-${n}`, region, zone: "z", group: `g${n} x` }
          return n % 2 === 0 ? rowNow("Row", values) : moved("Row", values)
        })
        for (const row of rows) yield* h.seed(row)
        const texts = new Map(rows.map((row) => [row.id!.S!, row.gsk!.S!]))
        const sorted = [...texts.keys()].sort((a, b) =>
          Buffer.compare(Buffer.from(texts.get(a)!), Buffer.from(texts.get(b)!)),
        )
        yield* h.inWorld(Migrating, (db: any) =>
          Effect.gen(function* () {
            for (const reverse of [false, true]) {
              const query = () => {
                const q = db.entities.Rows.byTenant({ tenant: TENANT, region })
                return reverse ? q.reverse() : q
              }
              const expected = reverse ? [...sorted].reverse() : sorted
              const collected: ReadonlyArray<any> = yield* query().collect()
              expect(collected.map((row) => row.id)).toEqual(expected)
              const paged: Array<string> = []
              let cursor: any
              do {
                const base = query().limit(4)
                const page: any = yield* (
                  cursor === undefined ? base : base.startFrom(cursor)
                ).fetch()
                paged.push(...page.items.map((row: any) => row.id))
                cursor = page.cursor._tag === "Some" ? page.cursor.value : undefined
              } while (cursor !== undefined)
              expect(paged).toEqual(expected)
            }
          }),
        )
      }),
    ),
  )
})
