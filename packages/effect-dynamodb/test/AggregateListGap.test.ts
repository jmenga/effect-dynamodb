/**
 * Two defects of `Aggregate.list`, both in how it builds the root-item query.
 *
 * A list key with a gap: the list sort key composites are taken in order, and up to 1.42.1 a value
 * given after one not given was dropped, so `list({ league, name })` on `sk: [league, season,
 * name]` returned every aggregate of the league. A value after the gap now matches a row as it
 * would in the key: where its key text is the row's for that composite, casing included. A number,
 * or any value under a casing that doesn't fold text, is compared in the root-item
 * `FilterExpression`; text under a folding casing is matched on the root items read, before
 * assembly. `prefix` changes nothing then. A key without a gap sends what 1.42.1 sent.
 *
 * A `list` filter operand (#124): one of Effect's instances has been sent as the root row stores it
 * since 1.41.0 (the issue's `DateTime.Utc` against a `Schema.DateTimeUtcFromString` field), but a
 * plain number compared with a `Schema.NumberFromString` field was sent as a number where the row
 * holds text, and matched nothing. It is sent in the stored form now, as an entity's is; text
 * where text is stored is sent as given, as on 1.42.1.
 */

import { describe, expect, it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { DateTime, Effect, Layer, Option, Schema } from "effect"
import * as Aggregate from "../src/Aggregate.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

class Player extends Schema.Class<Player>("GapPlayer")({
  id: Schema.String,
  league: Schema.String,
  season: Schema.NumberFromString,
  name: Schema.String,
  startDate: Schema.DateTimeUtcFromString,
  caps: Schema.NumberFromString,
}) {}

class Tag extends Schema.Class<Tag>("GapTag")({ id: Schema.String }) {}

const day = (d: number) => DateTime.makeUnsafe(Date.UTC(2026, 0, d))

/** `[id, league, season, name, day, caps]`: smith twice in `bbl`, once in `ipl`. */
const PLAYERS = [
  ["p1", "bbl", 2024, "Smith", 1, 5],
  ["p2", "bbl", 2025, "Jones", 5, 7],
  ["p3", "bbl", 2025, "Smith", 9, 12],
  ["p4", "ipl", 2025, "Smith", 3, 7],
  ["p5", "bbl", 2026, "Lee", 7, 30],
] as const

const setup = (
  options: {
    readonly cardinality?: number
    readonly casing?: DynamoSchema.Casing
    readonly sk?: ReadonlyArray<"league" | "season" | "name" | "startDate">
    /** The list index's projection: every attribute (the default), or the keys and these. */
    readonly projection?: ReadonlyArray<string>
  } = {},
) => {
  const schema = DynamoSchema.make({
    name: "gap",
    version: 1,
    ...(options.casing === undefined ? {} : { casing: options.casing }),
  })
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
      sk: { field: "gsi1sk", composite: [...(options.sk ?? ["league", "season", "name"])] },
      ...(options.cardinality === undefined ? {} : { cardinality: options.cardinality }),
    },
    root: { entityType: "PlayerItem" },
    edges: {},
  })
  const table = makeRecordingTable({
    indexes: {
      gsi1: {
        pk: "gsi1pk",
        sk: "gsi1sk",
        ...(options.projection === undefined ? {} : { projection: options.projection }),
      },
    },
  })
  const layer = Layer.merge(table.layer, MainTable.layer({ name: "players" }))
  const db = DynamoClient.make({
    entities: { Tags },
    aggregates: { Players },
    tables: { MainTable },
  })
  /** The list index reads sent since the last call. */
  const listReads = () =>
    table
      .take()
      .filter((request) => request.command === "Query" && request.input.IndexName === "gsi1")
      .map((request) => request.input)
  /** The players created, every request their writes sent forgotten. */
  const players = Effect.gen(function* () {
    const { Players } = (yield* db).aggregates
    for (const [id, league, season, name, d, caps] of PLAYERS) {
      yield* Players.create({ id, league, season, name, startDate: day(d), caps })
    }
    table.take()
    return Players
  })
  return { players, layer, listReads, table }
}

const ids = (page: Aggregate.ListResult<{ readonly id: string }>) => page.data.map((p) => p.id)
const sorted = (page: Aggregate.ListResult<{ readonly id: string }>) => ids(page).sort()

const base = { TableName: "players", IndexName: "gsi1", ExclusiveStartKey: undefined }
const PK = { ":pk": { S: "$gap#v1#playerlist" } }

describe("Aggregate.list with a gap in its key", () => {
  it.effect("a value after the gap is matched as it would be in the key, casing included", () => {
    const { players, layer, listReads } = setup()
    return Effect.gen(function* () {
      const Players = yield* players

      // Text under the default `lowercase` casing: DynamoDB can't fold case, so the root items
      // read are matched on their key text, and the read carries no condition for `name`.
      for (const key of [
        { league: "bbl", name: "Smith" },
        { league: "bbl", name: "smith" },
        { league: "BBL", name: "SMITH" },
      ]) {
        expect(sorted(yield* Players.list(key))).toEqual(["p1", "p3"])
      }
      const reads = listReads()
      expect(reads).toHaveLength(3)
      for (const read of reads) {
        expect(read).toStrictEqual({
          ...base,
          KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :skPrefix)",
          ExpressionAttributeNames: { "#pk": "gsi1pk", "#sk": "gsi1sk" },
          ExpressionAttributeValues: { ...PK, ":skPrefix": { S: "$gap#v1#playerlist#bbl#" } },
        })
      }

      // The first composite missing: the key condition is the partition alone.
      expect(sorted(yield* Players.list({ name: "sMiTh" }))).toEqual(["p1", "p3", "p4"])
      expect(listReads()[0]?.KeyConditionExpression).toBe("#pk = :pk")
    }).pipe(Effect.provide(layer))
  })

  it.effect("a number after the gap is compared in the root-item filter, as stored", () => {
    const { players, layer, listReads } = setup()
    return Effect.gen(function* () {
      const Players = yield* players
      // `season` is a `Schema.NumberFromString`: its key text is a function of the number, so the
      // stored `"2025"` is compared. `name`, text, is matched on the rows read.
      expect(sorted(yield* Players.list({ season: 2025 }))).toEqual(["p2", "p3", "p4"])
      expect(sorted(yield* Players.list({ season: 2025, name: "SMITH" }))).toEqual(["p3", "p4"])
      for (const read of listReads()) {
        expect(read.FilterExpression).toBe("#e0 = :e1")
        expect(read.ExpressionAttributeNames).toEqual({ "#pk": "gsi1pk", "#e0": "season" })
        expect(read.ExpressionAttributeValues).toEqual({ ...PK, ":e1": { S: "2025" } })
      }
    }).pipe(Effect.provide(layer))
  })

  it.effect("under a casing that doesn't fold text, the match is exact, in the filter", () => {
    const { players, layer, listReads } = setup({ casing: "preserve" })
    return Effect.gen(function* () {
      const Players = yield* players
      expect(sorted(yield* Players.list({ league: "bbl", name: "Smith" }))).toEqual(["p1", "p3"])
      expect(ids(yield* Players.list({ league: "bbl", name: "smith" }))).toEqual([])
      const [read] = listReads()
      expect(read?.FilterExpression).toBe("#e0 = :e1")
      expect(read?.ExpressionAttributeValues[":e1"]).toEqual({ S: "Smith" })
    }).pipe(Effect.provide(layer))
  })

  it.effect("a date after the gap, as a `DateTime` or as ISO text", () => {
    const iso = "2026-01-09T00:00:00Z" as unknown as DateTime.Utc
    const run = (casing: "lowercase" | "preserve") => {
      const { players, layer, listReads } = setup({ casing, sk: ["league", "startDate", "name"] })
      return Effect.gen(function* () {
        const Players = yield* players
        expect(ids(yield* Players.list({ startDate: day(9) }))).toEqual(["p3"])
        // Text a read of the field takes, in another spelling than the stored one, keys alike.
        expect(ids(yield* Players.list({ startDate: iso }))).toEqual(["p3"])
        return listReads()
      }).pipe(Effect.provide(layer))
    }
    return Effect.gen(function* () {
      // The key's text is the stored ISO text cased: matched on the rows read.
      const [folded] = yield* run("lowercase")
      expect(folded?.FilterExpression).toBeUndefined()
      // Not folded: the stored text, compared in the filter.
      const [exact] = yield* run("preserve")
      expect(exact?.FilterExpression).toBe("#e0 = :e1")
      expect(exact?.ExpressionAttributeValues[":e1"]).toEqual({ S: "2026-01-09T00:00:00.000Z" })
    })
  })

  it.effect("`prefix` changes nothing after a gap", () => {
    const { players, layer, listReads } = setup()
    return Effect.gen(function* () {
      const Players = yield* players
      expect(ids(yield* Players.list({ league: "bbl", name: "Smi" }, { prefix: true }))).toEqual([])
      expect(
        sorted(yield* Players.list({ league: "bbl", name: "smith" }, { prefix: true })),
      ).toEqual(["p1", "p3"])
      const [prefixed, whole] = listReads()
      // The leading value keeps its delimiter: `bbl` doesn't match `bblx` under `prefix`.
      expect(prefixed?.ExpressionAttributeValues[":skPrefix"]).toEqual({
        S: "$gap#v1#playerlist#bbl#",
      })
      expect(whole?.KeyConditionExpression).toBe(prefixed?.KeyConditionExpression)
    }).pipe(Effect.provide(layer))
  })

  it.effect("with the list's own `filter` and `filterBy`", () => {
    const { players, layer, listReads } = setup()
    return Effect.gen(function* () {
      const Players = yield* players
      const page = yield* Players.list(
        { league: "bbl", name: "smith" },
        { filter: (t, { gte }) => gte(t.startDate, day(4)) },
      )
      expect(ids(page)).toEqual(["p3"])
      const [read] = listReads()
      expect(read?.FilterExpression).toBe("#e0 >= :e1")
      expect(read?.ExpressionAttributeValues[":e1"]).toEqual({ S: "2026-01-04T00:00:00.000Z" })
      const seen: Array<unknown> = []
      const kept = yield* Players.list(
        { name: "smith" },
        {
          filterBy: (root) => {
            seen.push(root.id)
            return root.league === "ipl"
          },
        },
      )
      expect(ids(kept)).toEqual(["p4"])
      // `filterBy` sees only the rows the key matches.
      expect(seen.sort()).toEqual(["p1", "p3", "p4"])
    }).pipe(Effect.provide(layer))
  })

  it.effect("`limit` counts aggregates and the cursor resumes after the last one returned", () => {
    const { players, layer, listReads } = setup()
    return Effect.gen(function* () {
      const Players = yield* players
      // `name` matched on the rows read, `season` in the filter: both drop rows.
      for (const key of [{ name: "SMITH" }, { season: 2025, name: "smith" }]) {
        for (const pageSize of [undefined, 1, 2]) {
          const walked: Array<string> = []
          let cursor: string | undefined
          for (let page = 0; page < 10; page++) {
            const result: Aggregate.ListResult<Player> = yield* Players.list(key, {
              limit: 1,
              ...(pageSize === undefined ? {} : { pageSize }),
              ...(cursor === undefined ? {} : { cursor }),
            })
            expect(result.data.length).toBeLessThanOrEqual(1)
            walked.push(...ids(result))
            if (Option.isNone(result.cursor)) break
            cursor = result.cursor.value
          }
          expect(walked).toEqual("season" in key ? ["p3", "p4"] : ["p1", "p3", "p4"])
        }
      }
      // With a row matched on its key text, `limit` is not DynamoDB's `Limit`.
      expect(listReads().every((read) => read.Limit === undefined || read.Limit <= 2)).toBe(true)
    }).pipe(Effect.provide(layer))
  })

  it.effect("a value no condition can compare is a `ValidationError`, nothing sent", () => {
    const { players, layer, listReads } = setup()
    return Effect.gen(function* () {
      const Players = yield* players
      const error = yield* Effect.flip(Players.list({ league: "bbl", name: Number.NaN }))
      expect(error._tag).toBe("ValidationError")
      expect(String((error as { cause?: unknown }).cause)).toContain('Comparing "name"')
      expect(listReads()).toEqual([])
    }).pipe(Effect.provide(layer))
  })

  it.effect("only the composites given after the gap are read off the index row", () => {
    // An index projecting `id`, `league` and `name`, not `season`: `season` isn't asked for.
    const { players, layer } = setup({ projection: ["id", "league", "name"] })
    return Effect.gen(function* () {
      const Players = yield* players
      expect(sorted(yield* Players.list({ league: "bbl", name: "Smith" }))).toEqual(["p1", "p3"])
      expect(sorted(yield* Players.list({ name: "SMITH" }))).toEqual(["p1", "p3", "p4"])
    }).pipe(Effect.provide(layer))
  })

  it.effect("a composite matched that the index row holds no readable value for (EDD-9168)", () => {
    return Effect.gen(function* () {
      // The index doesn't project `name`.
      const unprojected = setup({ projection: ["id", "league"] })
      const absent = yield* Effect.flip(
        Effect.flatMap(unprojected.players, (Players) =>
          Players.list({ league: "bbl", name: "smith" }),
        ).pipe(Effect.provide(unprojected.layer)),
      )
      // The row holds `name` as a number, which the field can't read.
      const unreadable = setup()
      const stored = yield* Effect.flip(
        Effect.gen(function* () {
          const Players = yield* unreadable.players
          for (const [text, item] of [...unreadable.table.items.entries()]) {
            if (item.id?.S === "p5" && item.gsi1sk !== undefined) {
              unreadable.table.items.set(text, { ...item, name: { N: "5" } })
            }
          }
          return yield* Players.list({ league: "bbl", name: "smith" })
        }).pipe(Effect.provide(unreadable.layer)),
      )
      for (const error of [absent, stored]) {
        expect(error._tag).toBe("ValidationError")
        const cause = String((error as { cause?: unknown }).cause)
        expect(cause).toContain("EDD-9168")
        expect(cause).toContain('no readable value for "name"')
      }
    })
  })

  it.effect("a sharded list matches every shard's rows", () => {
    const { players, layer, listReads } = setup({ cardinality: 3 })
    return Effect.gen(function* () {
      const Players = yield* players
      expect(sorted(yield* Players.list({ league: "BBL", name: "smith" }))).toEqual(["p1", "p3"])
      const shards = listReads()
      expect(shards).toHaveLength(3)
      for (const read of shards) expect(read.FilterExpression).toBeUndefined()
      expect(sorted(yield* Players.list({ season: 2025, name: "Smith" }))).toEqual(["p3", "p4"])
      for (const read of listReads()) expect(read.FilterExpression).toBe("#e0 = :e1")
      const limited = yield* Players.list({ name: "SMITH" }, { limit: 2 })
      expect(limited.data).toHaveLength(2)
      expect(Option.isNone(limited.cursor)).toBe(true)
    }).pipe(Effect.provide(layer))
  })

  it.effect("a key without a gap sends what 1.42.1 sent", () => {
    const { players, layer, listReads } = setup()
    return Effect.gen(function* () {
      const Players = yield* players
      yield* Players.list({ league: "bbl", season: 2025, name: "Smith" })
      yield* Players.list({ league: "bbl" }, { limit: 2 })
      yield* Players.list({ league: "bbl", season: 2025 })
      yield* Players.list({ league: "bb" }, { prefix: true })
      yield* Players.list({ league: "bbl" }, { filter: { name: "Smith" } })
      yield* Players.list({}, { filter: (t, { eq }) => eq(t.league, "ipl") })
      const names = { "#pk": "gsi1pk", "#sk": "gsi1sk" }
      expect(listReads()).toStrictEqual([
        {
          ...base,
          KeyConditionExpression: "#pk = :pk AND #sk = :sk",
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: {
            ...PK,
            ":sk": { S: "$gap#v1#playerlist#bbl#0000000000002025#smith" },
          },
        },
        {
          ...base,
          KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :skPrefix)",
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: { ...PK, ":skPrefix": { S: "$gap#v1#playerlist#bbl#" } },
          Limit: 2,
        },
        {
          ...base,
          KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :skPrefix)",
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: {
            ...PK,
            ":skPrefix": { S: "$gap#v1#playerlist#bbl#0000000000002025#" },
          },
        },
        {
          ...base,
          KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :skPrefix)",
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: { ...PK, ":skPrefix": { S: "$gap#v1#playerlist#bb" } },
        },
        {
          ...base,
          KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :skPrefix)",
          ExpressionAttributeNames: { ...names, "#e0": "name" },
          ExpressionAttributeValues: {
            ...PK,
            ":skPrefix": { S: "$gap#v1#playerlist#bbl#" },
            ":e1": { S: "Smith" },
          },
          FilterExpression: "#e0 = :e1",
        },
        {
          ...base,
          KeyConditionExpression: "#pk = :pk",
          ExpressionAttributeNames: { "#pk": "gsi1pk", "#e0": "league" },
          ExpressionAttributeValues: { ...PK, ":e1": { S: "ipl" } },
          FilterExpression: "#e0 = :e1",
        },
      ])
    }).pipe(Effect.provide(layer))
  })

  it.effect("a sharded list without a gap sends what 1.42.1 sent", () => {
    const { players, layer, listReads } = setup({ cardinality: 2 })
    return Effect.gen(function* () {
      const Players = yield* players
      yield* Players.list({ league: "bbl" }, { limit: 3 })
      expect(listReads()).toStrictEqual(
        [0, 1].map((shard) => ({
          ...base,
          KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :skPrefix)",
          ExpressionAttributeNames: { "#pk": "gsi1pk", "#sk": "gsi1sk" },
          ExpressionAttributeValues: {
            ":pk": { S: `$gap#v1#playerlist#${shard}` },
            ":skPrefix": { S: "$gap#v1#playerlist#bbl#" },
          },
          Limit: 3,
        })),
      )
    }).pipe(Effect.provide(layer))
  })
})

describe("Aggregate.list filter operands in the root row's stored form (#124)", () => {
  it.effect("a `DateTime.Utc` against a `Schema.DateTimeUtcFromString` field", () => {
    const { players, layer, listReads } = setup()
    return Effect.gen(function* () {
      const Players = yield* players
      expect(
        sorted(yield* Players.list({}, { filter: (t, { gte }) => gte(t.startDate, day(5)) })),
      ).toEqual(["p2", "p3", "p5"])
      expect(
        sorted(yield* Players.list({}, { filter: (t, { lt }) => lt(t.startDate, day(5)) })),
      ).toEqual(["p1", "p4"])
      expect(
        sorted(
          yield* Players.list(
            {},
            { filter: (t, { between }) => between(t.startDate, day(3), day(7)) },
          ),
        ),
      ).toEqual(["p2", "p4", "p5"])
      const [gte, , between] = listReads()
      expect(gte?.ExpressionAttributeValues[":e1"]).toEqual({ S: "2026-01-05T00:00:00.000Z" })
      expect(between?.FilterExpression).toBe("#e0 BETWEEN :e1 AND :e2")
      expect([
        between?.ExpressionAttributeValues[":e1"],
        between?.ExpressionAttributeValues[":e2"],
      ]).toEqual([{ S: "2026-01-03T00:00:00.000Z" }, { S: "2026-01-07T00:00:00.000Z" }])
    }).pipe(Effect.provide(layer))
  })

  it.effect("a number against a `Schema.NumberFromString` field", () => {
    const { players, layer, listReads } = setup()
    return Effect.gen(function* () {
      const Players = yield* players
      expect(sorted(yield* Players.list({}, { filter: (t, { eq }) => eq(t.caps, 7) }))).toEqual([
        "p2",
        "p4",
      ])
      expect(sorted(yield* Players.list({}, { filter: { caps: 12 } }))).toEqual(["p3"])
      expect(
        sorted(yield* Players.list({}, { filter: (t, { isIn }) => isIn(t.caps, [5, 30]) })),
      ).toEqual(["p1", "p5"])
      const [callback, shorthand] = listReads()
      expect(callback?.ExpressionAttributeValues[":e1"]).toEqual({ S: "7" })
      expect(shorthand?.ExpressionAttributeValues[":e1"]).toEqual({ S: "12" })
    }).pipe(Effect.provide(layer))
  })

  it.effect("text where text is stored is sent as given, as on 1.42.1", () => {
    const { players, layer, listReads } = setup()
    return Effect.gen(function* () {
      const Players = yield* players
      yield* Players.list({}, { filter: (t, { eq }) => eq(t.name, "Smith") })
      yield* Players.list({}, { filter: (t, { contains }) => contains(t.name, "mit") })
      // The issue's workaround, the stored text cast to the field's type, sends what it sent.
      const text = "2026-01-05" as unknown as DateTime.Utc
      yield* Players.list({}, { filter: (t, { gte }) => gte(t.startDate, text) })
      yield* Players.list({}, { filter: { caps: "7" } })
      expect(listReads().map((read) => read.ExpressionAttributeValues[":e1"])).toEqual([
        { S: "Smith" },
        { S: "mit" },
        { S: "2026-01-05" },
        { S: "7" },
      ])
    }).pipe(Effect.provide(layer))
  })
})
