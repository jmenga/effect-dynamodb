/**
 * `Aggregate.list` against DynamoDB Local: a list key with a gap, and filter operands in the root
 * row's stored form (#124). A value given after a list sort key composite left out matches a row as
 * it would in the key, casing included, so `{ league, name }` on `sk: [league, season, name]`
 * returns only that name's aggregates, in any case, page by page; up to 1.42.1 the value was
 * dropped. Text under the default casing is matched on the root items read, a number in the
 * root-item filter. A filter comparing a `DateTime.Utc` with a `Schema.DateTimeUtcFromString`
 * field, or a number with a `Schema.NumberFromString` one, matches the rows that hold it.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 */

import { it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Config, DateTime, Effect, Layer, Option, Schema } from "effect"
import { afterAll, beforeAll, describe, expect } from "vitest"
import * as Aggregate from "../src/Aggregate.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"

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

const schema = DynamoSchema.make({ name: "listgap", version: 1 })
const tableName = `list-gap-test-${Date.now()}`

class Player extends Schema.Class<Player>("ListGapPlayer")({
  id: Schema.String,
  league: Schema.String,
  season: Schema.NumberFromString,
  name: Schema.String,
  startDate: Schema.DateTimeUtcFromString,
  caps: Schema.NumberFromString,
}) {}

class Tag extends Schema.Class<Tag>("ListGapTag")({ id: Schema.String }) {}

const Tags = Entity.make({
  model: Tag,
  entityType: "Tag",
  primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
})

const MainTable = Table.make({ schema, entities: { Tags } })

const Players = Aggregate.make(Player, {
  table: MainTable,
  schema,
  pk: { field: "pk", composite: ["id"] },
  collection: { name: "player" },
  list: {
    index: "gsi1",
    name: "playerList",
    pk: { field: "gsi1pk", composite: [] },
    sk: { field: "gsi1sk", composite: ["league", "season", "name"] },
  },
  root: { entityType: "PlayerItem" },
  edges: {},
})

const provide = Effect.provide(
  Layer.mergeAll(
    DynamoClient.layer({
      region: "us-east-1",
      endpoint: ENDPOINT,
      credentials: { accessKeyId: "local", secretAccessKey: "local" },
    }),
    MainTable.layer({ name: tableName }),
  ),
)

const gateway = DynamoClient.make({
  entities: { Tags },
  aggregates: { Players },
  tables: { MainTable },
})

const day = (d: number) => DateTime.makeUnsafe(Date.UTC(2026, 0, d))

/** `[id, league, season, name, day, caps]`: Smith in four `bbl` seasons and once in `ipl`. */
const PLAYERS = [
  ["p1", "bbl", 2023, "Smith", 1, 5],
  ["p2", "bbl", 2024, "Jones", 5, 7],
  ["p3", "bbl", 2024, "Smith", 9, 12],
  ["p4", "bbl", 2025, "Lee", 7, 30],
  ["p5", "bbl", 2025, "Smith", 11, 7],
  ["p6", "bbl", 2026, "Smith", 13, 8],
  ["p7", "ipl", 2025, "Smith", 3, 7],
] as const

/** Every aggregate `list` returns for `key`, `limit` at a time, following the cursor. */
const walk = (key: Record<string, unknown>, options: Aggregate.ListOptions<Player>) =>
  Effect.gen(function* () {
    const db = yield* gateway
    const pages: Array<ReadonlyArray<string>> = []
    let cursor: string | undefined
    for (let page = 0; page < 20; page++) {
      const result: Aggregate.ListResult<Player> = yield* db.aggregates.Players.list(key, {
        ...options,
        ...(cursor === undefined ? {} : { cursor }),
      })
      pages.push(result.data.map((player) => player.id))
      if (Option.isNone(result.cursor)) break
      cursor = result.cursor.value
    }
    return pages
  })

const listed = (key: Record<string, unknown>, options?: Aggregate.ListOptions<Player>) =>
  Effect.gen(function* () {
    const db = yield* gateway
    const page = yield* db.aggregates.Players.list(key, options)
    return page.data.map((player) => player.id).sort()
  })

describeConnected("Aggregate.list with a gap in its key, and #124 filter operands", () => {
  beforeAll(async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* gateway
        yield* db.tables.MainTable.create()
        for (const [id, league, season, name, d, caps] of PLAYERS) {
          yield* db.aggregates.Players.create({ id, league, season, name, startDate: day(d), caps })
        }
      }).pipe(provide),
    )
  }, 60000)

  afterAll(async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* DynamoClient
        yield* client.deleteTable({ TableName: tableName })
      }).pipe(
        provide,
        Effect.catchTag("ResourceNotFoundError", () => Effect.void),
      ),
    )
  }, 15000)

  it.effect("a value after the gap is matched as in the key, page by page", () =>
    Effect.gen(function* () {
      // Text, in whatever case: matched on the root items read, so rows are dropped after the read.
      for (const key of [
        { league: "bbl", name: "Smith" },
        { league: "bbl", name: "smith" },
        { league: "BBL", name: "SMITH" },
      ]) {
        const pages = yield* walk(key, { limit: 1 })
        expect(pages.flat()).toEqual(["p1", "p3", "p5", "p6"])
        expect(pages.length).toBeGreaterThan(1)
        expect(pages.every((page) => page.length <= 1)).toBe(true)
      }

      for (const pageSize of [1, 2, 3]) {
        const smith = yield* walk({ name: "sMITH" }, { limit: 2, pageSize })
        expect(smith.flat().sort()).toEqual(["p1", "p3", "p5", "p6", "p7"])
        expect(smith.every((page) => page.length <= 2)).toBe(true)
      }

      // A number after the gap, in the root-item filter, and with text after it.
      expect(yield* listed({ season: 2024 })).toEqual(["p2", "p3"])
      expect(yield* listed({ season: 2025, name: "smith" })).toEqual(["p5", "p7"])
      const mixed = yield* walk({ season: 2025, name: "SMITH" }, { limit: 1, pageSize: 1 })
      expect(mixed.flat().sort()).toEqual(["p5", "p7"])

      // `prefix` changes nothing after a gap: the value is matched whole.
      expect(yield* listed({ league: "BBL", name: "smith" }, { prefix: true })).toEqual([
        "p1",
        "p3",
        "p5",
        "p6",
      ])
      expect(yield* listed({ league: "bbl", name: "smi" }, { prefix: true })).toEqual([])
      // With `filterBy`, which sees only the rows the key matches.
      expect(
        yield* listed({ name: "smith" }, { filterBy: (root) => root.league === "ipl" }),
      ).toEqual(["p7"])
      // A key without a gap, as before.
      expect(yield* listed({ league: "bbl", season: 2024 })).toEqual(["p2", "p3"])
    }).pipe(provide),
  )

  it.effect("a filter's operands are compared as the root row stores them (#124)", () =>
    Effect.gen(function* () {
      expect(yield* listed({}, { filter: (t, { gte }) => gte(t.startDate, day(9)) })).toEqual([
        "p3",
        "p5",
        "p6",
      ])
      expect(yield* listed({}, { filter: (t, { lt }) => lt(t.startDate, day(5)) })).toEqual([
        "p1",
        "p7",
      ])
      expect(
        yield* listed({}, { filter: (t, { between }) => between(t.startDate, day(5), day(9)) }),
      ).toEqual(["p2", "p3", "p4"])
      expect(yield* listed({}, { filter: (t, { eq }) => eq(t.caps, 7) })).toEqual([
        "p2",
        "p5",
        "p7",
      ])
      // With a gap, and on a later page.
      const walked = yield* walk(
        { league: "bbl", name: "smith" },
        { limit: 1, filter: (t, { gte }) => gte(t.startDate, day(9)) },
      )
      expect(walked.flat()).toEqual(["p3", "p5", "p6"])
    }).pipe(provide),
  )
})
