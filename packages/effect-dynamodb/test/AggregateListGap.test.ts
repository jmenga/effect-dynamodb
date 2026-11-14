/**
 * Two defects of `Aggregate.list`, both in how it builds the root-item query.
 *
 * A list key with a gap: the list sort key composites are taken in order, and up to 1.42.1 a value
 * given after one not given was dropped, so `list({ league, name })` on `sk: [league, season,
 * name]` returned every aggregate of the league. Each value after the gap is now matched whole
 * against the value the root row stores, in the root-item `FilterExpression`; `prefix` changes
 * nothing then. A key without a gap sends what 1.42.1 sent.
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

const setup = (options: { readonly cardinality?: number } = {}) => {
  const schema = DynamoSchema.make({ name: "gap", version: 1 })
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
      ...(options.cardinality === undefined ? {} : { cardinality: options.cardinality }),
    },
    root: { entityType: "PlayerItem" },
    edges: {},
  })
  const table = makeRecordingTable({ indexes: { gsi1: { pk: "gsi1pk", sk: "gsi1sk" } } })
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
  return { players, layer, listReads }
}

const ids = (page: Aggregate.ListResult<{ readonly id: string }>) => page.data.map((p) => p.id)
const sorted = (page: Aggregate.ListResult<{ readonly id: string }>) => ids(page).sort()

const base = { TableName: "players", IndexName: "gsi1", ExclusiveStartKey: undefined }
const PK = { ":pk": { S: "$gap#v1#playerlist" } }

describe("Aggregate.list with a gap in its key", () => {
  it.effect("a value after the gap is matched, not dropped", () => {
    const { players, layer, listReads } = setup()
    return Effect.gen(function* () {
      const Players = yield* players

      expect(sorted(yield* Players.list({ league: "bbl", name: "Smith" }))).toEqual(["p1", "p3"])
      expect(listReads()).toStrictEqual([
        {
          ...base,
          KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :skPrefix)",
          ExpressionAttributeNames: { "#pk": "gsi1pk", "#sk": "gsi1sk", "#e0": "name" },
          ExpressionAttributeValues: {
            ...PK,
            ":skPrefix": { S: "$gap#v1#playerlist#bbl#" },
            ":e1": { S: "Smith" },
          },
          FilterExpression: "#e0 = :e1",
        },
      ])

      // The first composite missing: the key condition is the partition alone.
      expect(sorted(yield* Players.list({ name: "Smith" }))).toEqual(["p1", "p3", "p4"])
      // Two values after the gap, the first stored as text (`NumberFromString`): sent as `"2025"`.
      expect(sorted(yield* Players.list({ season: 2025, name: "Smith" }))).toEqual(["p3", "p4"])
      const [nameOnly, both] = listReads()
      expect(nameOnly?.KeyConditionExpression).toBe("#pk = :pk")
      expect(nameOnly?.FilterExpression).toBe("#e0 = :e1")
      expect(both?.FilterExpression).toBe("(#e0 = :e1) AND (#e2 = :e3)")
      expect(both?.ExpressionAttributeNames).toEqual({
        "#pk": "gsi1pk",
        "#e0": "season",
        "#e2": "name",
      })
      expect(both?.ExpressionAttributeValues).toEqual({
        ...PK,
        ":e1": { S: "2025" },
        ":e3": { S: "Smith" },
      })
    }).pipe(Effect.provide(layer))
  })

  it.effect("matched whole, as stored: the case given, and `prefix` changes nothing", () => {
    const { players, layer, listReads } = setup()
    return Effect.gen(function* () {
      const Players = yield* players

      // The leading value follows the schema's casing, the value after the gap the stored text.
      expect(sorted(yield* Players.list({ league: "BBL", name: "Smith" }))).toEqual(["p1", "p3"])
      expect(ids(yield* Players.list({ league: "bbl", name: "smith" }))).toEqual([])
      expect(ids(yield* Players.list({ league: "bbl", name: "Smi" }, { prefix: true }))).toEqual([])
      expect(
        sorted(yield* Players.list({ league: "bbl", name: "Smith" }, { prefix: true })),
      ).toEqual(["p1", "p3"])
      const [, , prefixed, whole] = listReads()
      // The leading value keeps its delimiter: `bbl` doesn't match `bblx` under `prefix`.
      expect(prefixed?.ExpressionAttributeValues[":skPrefix"]).toEqual({
        S: "$gap#v1#playerlist#bbl#",
      })
      expect(whole?.KeyConditionExpression).toBe(prefixed?.KeyConditionExpression)
    }).pipe(Effect.provide(layer))
  })

  it.effect("ANDed with the list's own filter", () => {
    const { players, layer, listReads } = setup()
    return Effect.gen(function* () {
      const Players = yield* players
      const page = yield* Players.list(
        { league: "bbl", name: "Smith" },
        { filter: (t, { gte }) => gte(t.startDate, day(4)) },
      )
      expect(ids(page)).toEqual(["p3"])
      const [read] = listReads()
      expect(read?.FilterExpression).toBe("(#e0 = :e1) AND (#e2 >= :e3)")
      expect(read?.ExpressionAttributeValues[":e3"]).toEqual({ S: "2026-01-04T00:00:00.000Z" })
    }).pipe(Effect.provide(layer))
  })

  it.effect("`limit` counts aggregates and the cursor resumes after the last one returned", () => {
    const { players, layer } = setup()
    return Effect.gen(function* () {
      const Players = yield* players
      for (const pageSize of [undefined, 1]) {
        const walked: Array<string> = []
        let cursor: string | undefined
        for (let page = 0; page < 10; page++) {
          const result: Aggregate.ListResult<Player> = yield* Players.list(
            { name: "Smith" },
            {
              limit: 1,
              ...(pageSize === undefined ? {} : { pageSize }),
              ...(cursor === undefined ? {} : { cursor }),
            },
          )
          expect(result.data.length).toBeLessThanOrEqual(1)
          walked.push(...ids(result))
          if (Option.isNone(result.cursor)) break
          cursor = result.cursor.value
        }
        expect(walked).toEqual(["p1", "p3", "p4"])
      }
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

  it.effect("a sharded list sends the condition to every shard", () => {
    const { players, layer, listReads } = setup({ cardinality: 3 })
    return Effect.gen(function* () {
      const Players = yield* players
      expect(sorted(yield* Players.list({ league: "bbl", name: "Smith" }))).toEqual(["p1", "p3"])
      const shards = listReads()
      expect(shards).toHaveLength(3)
      for (const read of shards) {
        expect(read.FilterExpression).toBe("#e0 = :e1")
        expect(read.ExpressionAttributeValues[":e1"]).toEqual({ S: "Smith" })
      }
      const limited = yield* Players.list({ name: "Smith" }, { limit: 2 })
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
