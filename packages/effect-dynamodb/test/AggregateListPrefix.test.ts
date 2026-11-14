/**
 * `Aggregate.list`'s `prefix` option (#264). Up to 1.36 a list key was always matched as a prefix
 * (`begins_with(sk, "…#big")` also matched `Big Bash`); 1.37.0 made it a whole-value match and gave
 * no way back. `prefix: true` matches the last list sort key composite given as a prefix of its
 * value, composed as the key is (casing, `escapeKeys`, numeric key text), and pages with the list's
 * own cursor. A list without it sends what 1.41.0 sent.
 */

import { describe, expect, it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Effect, Layer, Option, Schema } from "effect"
import * as Aggregate from "../src/Aggregate.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

class Fixture extends Schema.Class<Fixture>("Fixture")({
  id: Schema.String,
  league: Schema.String,
  name: Schema.String,
}) {}

class Round extends Schema.Class<Round>("Round")({
  id: Schema.String,
  league: Schema.String,
  round: Schema.Number,
}) {}

class Tag extends Schema.Class<Tag>("Tag")({ id: Schema.String }) {}

/** The issue's fixtures, listed through `sk: [league, name]`. */
const LEAGUES = [
  ["f1", "Big", "Final"],
  ["f2", "Big Bash", "Final"],
  ["f3", "Big Bash", "Finals Day"],
  ["f4", "Big Bash League", "Final"],
] as const

const setup = (options: { readonly escapeKeys?: boolean; readonly cardinality?: number } = {}) => {
  const schema = DynamoSchema.make({
    name: "repro",
    version: 1,
    ...(options.escapeKeys === undefined ? {} : { escapeKeys: options.escapeKeys }),
  })
  const Tags = Entity.make({
    model: Tag,
    entityType: "Tag",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
  })
  const MainTable = Table.make({ schema, entities: { Tags } })
  const Fixtures = Aggregate.make(Fixture, {
    table: MainTable,
    schema,
    pk: { field: "pk", composite: ["id"] },
    collection: { name: "fixture" },
    list: {
      index: "gsi1",
      name: "fixtureList",
      pk: { field: "gsi1pk", composite: [] },
      sk: { field: "gsi1sk", composite: ["league", "name"] },
      ...(options.cardinality === undefined ? {} : { cardinality: options.cardinality }),
    },
    root: { entityType: "FixtureItem" },
    edges: {},
  })
  const Rounds = Aggregate.make(Round, {
    table: MainTable,
    schema,
    pk: { field: "pk", composite: ["id"] },
    collection: { name: "round" },
    list: {
      index: "gsi1",
      name: "roundList",
      pk: { field: "gsi1pk", composite: ["league"] },
      sk: { field: "gsi1sk", composite: ["round"] },
    },
    root: { entityType: "RoundItem" },
    edges: {},
  })
  const table = makeRecordingTable({ indexes: { gsi1: { pk: "gsi1pk", sk: "gsi1sk" } } })
  const layer = Layer.merge(table.layer, MainTable.layer({ name: "fixtures" }))
  const db = DynamoClient.make({
    entities: { Tags },
    aggregates: { Fixtures, Rounds },
    tables: { MainTable },
  })
  /** The list index reads sent since the last call. */
  const listReads = () =>
    table
      .take()
      .filter((request) => request.command === "Query" && request.input.IndexName === "gsi1")
      .map((request) => request.input)
  /** A key's text as this schema composes it: a space escaped with `escapeKeys`. */
  const text = (s: string) => (schema.escapeKeys === true ? s.replaceAll(" ", "%20") : s)
  return { schema, db, layer, listReads, text }
}

const ids = (page: Aggregate.ListResult<{ readonly id: string }>) => page.data.map((f) => f.id)
const sorted = (page: Aggregate.ListResult<{ readonly id: string }>) => ids(page).sort()

describe("Aggregate.list prefix (#264)", () => {
  it.effect("a list without `prefix` sends the requests 1.41.0 sent", () => {
    const { db, layer, listReads, text } = setup()
    return Effect.gen(function* () {
      const { Fixtures } = (yield* db).aggregates
      for (const [id, league, name] of LEAGUES) yield* Fixtures.create({ id, league, name })
      listReads()

      yield* Fixtures.list({ league: "Big Bash" }, { limit: 50 })
      yield* Fixtures.list({ league: "Big Bash", name: "Final" })
      yield* Fixtures.list({ league: "Big Bash" }, { prefix: false })
      yield* Fixtures.list({}, { prefix: true })

      const base = {
        TableName: "fixtures",
        IndexName: "gsi1",
        ExclusiveStartKey: undefined,
      }
      const partial = {
        ...base,
        KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :skPrefix)",
        ExpressionAttributeNames: { "#pk": "gsi1pk", "#sk": "gsi1sk" },
        ExpressionAttributeValues: {
          ":pk": { S: "$repro#v1#fixturelist" },
          ":skPrefix": { S: `$repro#v1#fixturelist#${text("big bash")}#` },
        },
      }
      expect(listReads()).toStrictEqual([
        { ...partial, Limit: 50 },
        {
          ...base,
          KeyConditionExpression: "#pk = :pk AND #sk = :sk",
          ExpressionAttributeNames: { "#pk": "gsi1pk", "#sk": "gsi1sk" },
          ExpressionAttributeValues: {
            ":pk": { S: "$repro#v1#fixturelist" },
            ":sk": { S: `$repro#v1#fixturelist#${text("big bash")}#final` },
          },
        },
        partial,
        {
          ...base,
          KeyConditionExpression: "#pk = :pk",
          ExpressionAttributeNames: { "#pk": "gsi1pk" },
          ExpressionAttributeValues: { ":pk": { S: "$repro#v1#fixturelist" } },
        },
      ])
    }).pipe(Effect.provide(layer))
  })

  it.effect("the first composite as a prefix, in any casing", () => {
    const { db, layer, listReads, text } = setup()
    return Effect.gen(function* () {
      const { Fixtures } = (yield* db).aggregates
      for (const [id, league, name] of LEAGUES) yield* Fixtures.create({ id, league, name })
      listReads()

      expect(ids(yield* Fixtures.list({ league: "big" }))).toEqual(["f1"])
      const big = yield* Fixtures.list({ league: "big" }, { prefix: true })
      expect(sorted(big)).toEqual(["f1", "f2", "f3", "f4"])
      expect(sorted(yield* Fixtures.list({ league: "BIG bash" }, { prefix: true }))).toEqual([
        "f2",
        "f3",
        "f4",
      ])

      const [, prefixed, mixed] = listReads()
      expect(prefixed?.KeyConditionExpression).toBe("#pk = :pk AND begins_with(#sk, :skPrefix)")
      expect(prefixed?.ExpressionAttributeValues[":skPrefix"]).toEqual({
        S: "$repro#v1#fixturelist#big",
      })
      expect(mixed?.ExpressionAttributeValues[":skPrefix"]).toEqual({
        S: `$repro#v1#fixturelist#${text("big bash")}`,
      })
    }).pipe(Effect.provide(layer))
  })

  it.effect("the last composite as a prefix, under whole earlier values", () => {
    const { db, layer, listReads, text } = setup()
    return Effect.gen(function* () {
      const { Fixtures } = (yield* db).aggregates
      for (const [id, league, name] of LEAGUES) yield* Fixtures.create({ id, league, name })

      expect(ids(yield* Fixtures.list({ league: "Big Bash", name: "fin" }))).toEqual([])
      expect(
        sorted(yield* Fixtures.list({ league: "Big Bash", name: "fin" }, { prefix: true })),
      ).toEqual(["f2", "f3"])
      // Every composite given: `begins_with` on the whole key, not `=`.
      expect(
        sorted(yield* Fixtures.list({ league: "Big Bash", name: "Final" }, { prefix: true })),
      ).toEqual(["f2", "f3"])
      expect(ids(yield* Fixtures.list({ league: "Big Bash", name: "Final" }))).toEqual(["f2"])

      listReads()
      yield* Fixtures.list({ league: "Big Bash", name: "Final" }, { prefix: true })
      const [complete] = listReads()
      expect(complete?.KeyConditionExpression).toBe("#pk = :pk AND begins_with(#sk, :skPrefix)")
      expect(complete?.ExpressionAttributeValues[":skPrefix"]).toEqual({
        S: `$repro#v1#fixturelist#${text("big bash")}#final`,
      })
    }).pipe(Effect.provide(layer))
  })

  for (const escapeKeys of [true, false]) {
    it.effect(`a prefix holding \`#\`, escapeKeys ${escapeKeys ? "on" : "off"}`, () => {
      const { db, layer } = setup({ escapeKeys })
      return Effect.gen(function* () {
        const { Fixtures } = (yield* db).aggregates
        yield* Fixtures.create({ id: "h1", league: "A#B", name: "One" })
        yield* Fixtures.create({ id: "h2", league: "A", name: "B side" })

        const found = sorted(yield* Fixtures.list({ league: "a#" }, { prefix: true }))
        // Off, `#` is the key delimiter in a value too, so `a#` also starts league `a` followed
        // by name `b…`: the documented limit of `escapeKeys` off.
        expect(found).toEqual(escapeKeys ? ["h1"] : ["h1", "h2"])
      }).pipe(Effect.provide(layer))
    })
  }

  it.effect("a number has no text prefix: the whole value, the request without `prefix`", () => {
    const { db, layer, listReads } = setup({ escapeKeys: true })
    return Effect.gen(function* () {
      const { Rounds } = (yield* db).aggregates
      // Numeric key text: 1's is a prefix of 1.5's.
      for (const [id, round] of [
        ["r1", 1],
        ["r2", 1.5],
        ["r3", 10],
      ] as const) {
        yield* Rounds.create({ id, league: "x", round })
      }
      listReads()

      expect(ids(yield* Rounds.list({ league: "x", round: 1 }, { prefix: true }))).toEqual(["r1"])
      yield* Rounds.list({ league: "x", round: 1 })
      const [prefixed, whole] = listReads()
      expect(prefixed).toStrictEqual(whole)
      expect(prefixed?.KeyConditionExpression).toBe("#pk = :pk AND #sk = :sk")
    }).pipe(Effect.provide(layer))
  })

  it.effect("a prefix list pages with its own cursor", () => {
    const { db, layer } = setup()
    return Effect.gen(function* () {
      const { Fixtures } = (yield* db).aggregates
      for (const [id, league, name] of LEAGUES) yield* Fixtures.create({ id, league, name })
      const all = ids(yield* Fixtures.list({ league: "big" }, { prefix: true }))

      const walked: Array<string> = []
      let cursor: string | undefined
      for (let page = 0; page < 10; page++) {
        const result: Aggregate.ListResult<Fixture> = yield* Fixtures.list(
          { league: "big" },
          { prefix: true, limit: 1, ...(cursor === undefined ? {} : { cursor }) },
        )
        walked.push(...ids(result))
        if (Option.isNone(result.cursor)) break
        cursor = result.cursor.value
      }
      expect(walked).toEqual(all)
    }).pipe(Effect.provide(layer))
  })

  it.effect(
    "a cursor resumes a list whose key range holds it; DynamoDB refuses one outside",
    () => {
      const { db, layer } = setup()
      return Effect.gen(function* () {
        const { Fixtures } = (yield* db).aggregates
        for (const [id, league, name] of LEAGUES) yield* Fixtures.create({ id, league, name })
        const all = ids(yield* Fixtures.list({ league: "big" }, { prefix: true }))

        // A whole-value list's position is inside the prefix list's range: it resumes there.
        const whole = yield* Fixtures.list({ league: "Big Bash" }, { limit: 1 })
        expect(ids(whole)).toEqual(["f2"])
        const resumed = yield* Fixtures.list(
          { league: "big" },
          { prefix: true, cursor: Option.getOrThrow(whole.cursor) },
        )
        expect(ids(resumed)).toEqual(all.slice(all.indexOf("f2") + 1))

        // A prefix list's position at a `Big Bash…` league is outside the whole `big` list's range.
        const prefixed = yield* Fixtures.list({ league: "Big Bash" }, { prefix: true, limit: 1 })
        const error = yield* Effect.flip(
          Fixtures.list({ league: "big" }, { cursor: Option.getOrThrow(prefixed.cursor) }),
        )
        expect(error._tag).toBe("DynamoValidationError")
      }).pipe(Effect.provide(layer))
    },
  )

  it.effect(
    "a sharded list fans the prefix out to every shard, `limit` truncating the merge",
    () => {
      const { db, layer, listReads } = setup({ cardinality: 3 })
      return Effect.gen(function* () {
        const { Fixtures } = (yield* db).aggregates
        for (const [id, league, name] of LEAGUES) yield* Fixtures.create({ id, league, name })
        listReads()

        expect(sorted(yield* Fixtures.list({ league: "big" }, { prefix: true }))).toEqual([
          "f1",
          "f2",
          "f3",
          "f4",
        ])
        const shards = listReads()
        expect(shards.map((input) => input.ExpressionAttributeValues[":pk"].S)).toEqual([
          "$repro#v1#fixturelist#0",
          "$repro#v1#fixturelist#1",
          "$repro#v1#fixturelist#2",
        ])
        for (const input of shards) {
          expect(input.ExpressionAttributeValues[":skPrefix"]).toEqual({
            S: "$repro#v1#fixturelist#big",
          })
        }
        const limited = yield* Fixtures.list({ league: "big" }, { prefix: true, limit: 3 })
        expect(limited.data).toHaveLength(3)
        expect(Option.isNone(limited.cursor)).toBe(true)
      }).pipe(Effect.provide(layer))
    },
  )

  it("`prefix` is a flag, not the prefix's text", () => {
    const flag: Aggregate.ListOptions<Fixture> = { prefix: true }
    // @ts-expect-error — the prefix is the last value the key gives
    const textual: Aggregate.ListOptions<Fixture> = { prefix: "big" }
    expect([flag, textual]).toHaveLength(2)
  })
})
