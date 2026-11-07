/**
 * An aggregate write's value no encoder of its field takes (`EDD-9127`), with a client that keeps
 * what's written. Such a value is stored as given only when the rows read back: a transformation over
 * itself can encode no value, and a bigint or a class stored as given reads back as something else,
 * so `create` and `update` refuse it and write nothing, at every position. A one-way transformation's
 * value reads back as given, and is still stored.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { describe, expect, it } from "@effect/vitest"
import { ValidationError } from "@effect-dynamodb/schema/Errors.js"
import { Cause, Effect, Exit, Layer, Schema, SchemaGetter, SchemaTransformation } from "effect"
import * as Aggregate from "../src/Aggregate.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Table from "../src/Table.js"
import { AppSchema } from "./helpers/CustomDeclarationPaths.js"
import { mockDynamoClientLayer } from "./helpers/MockDynamoClient.js"

/** A transformation over itself, which can't decode or encode any value. */
const overItself = <S extends Schema.Top>(schema: S) =>
  schema.pipe(Schema.decodeTo(schema, SchemaTransformation.passthrough()))
class Klass extends Schema.Class<Klass>("Klass")({ b: Schema.BigIntFromString }) {}
const OverStruct = overItself(Schema.Struct({ b: Schema.BigIntFromString }))
const OverClass = overItself(Klass)
/** Decodes, and refuses to encode: stored as given, it reads back. */
const OneWay = Schema.String.pipe(
  Schema.decodeTo(Schema.String, {
    decode: SchemaGetter.passthrough(),
    encode: SchemaGetter.forbidden(() => "one way"),
  }),
)

class Line extends Schema.Class<Line>("Line")({
  lineId: Schema.String,
  f: Schema.optional(OverStruct),
}) {}
class Coach extends Schema.Class<Coach>("Coach")({
  name: Schema.String,
  f: Schema.optional(OverStruct),
}) {}
class Captain extends Schema.Class<Captain>("Captain")({
  name: Schema.String,
  f: Schema.optional(OverStruct),
}) {}
class Squad extends Schema.Class<Squad>("Squad")({
  label: Schema.String,
  f: Schema.optional(OverStruct),
  captain: Schema.optional(Captain),
}) {}
class Team extends Schema.Class<Team>("Team")({
  id: Schema.String,
  note: Schema.optional(Schema.String),
  f: Schema.optional(OverStruct),
  k: Schema.optional(OverClass),
  w: Schema.optional(OneWay),
  coach: Schema.optional(Coach),
  lines: Schema.Array(Line),
  squad: Schema.optional(Squad),
}) {}

const Base = Table.make({ schema: AppSchema, entities: {} } as never) as any
// A child edge makes it a sub-aggregate: its own transaction group and its own root row.
const SquadAggregate = Aggregate.make(Squad, {
  root: { entityType: "TeamSquad" },
  edges: { captain: Aggregate.one({ entityType: "SquadCaptain" }) },
})
const Teams = (Aggregate.make as any)(Team, {
  table: Base,
  schema: AppSchema,
  pk: { field: "pk", composite: ["id"] },
  collection: { name: "team" },
  root: { entityType: "Team" },
  edges: {
    coach: Aggregate.one({ entityType: "TeamCoach" }),
    lines: Aggregate.many({ entityType: "TeamLine", sk: { composite: ["lineId"] } }),
    squad: SquadAggregate.with({ discriminator: { n: 1 } }),
  },
})

type Row = Record<string, AttributeValue>

/** A client keeping what's written, whose every query finds all of it. */
const memory = () => {
  const rows = new Map<string, Row>()
  const writes: Array<string> = []
  const keyOf = (row: Row) => `${row.pk?.S}|${row.sk?.S}`
  const layer = mockDynamoClientLayer({
    transactWriteItems: (input: { readonly TransactItems?: ReadonlyArray<any> | undefined }) =>
      Effect.sync(() => {
        writes.push("transactWriteItems")
        for (const item of input.TransactItems ?? []) {
          if (item.Put) rows.set(keyOf(item.Put.Item), item.Put.Item)
          if (item.Delete) rows.delete(keyOf(item.Delete.Key))
        }
        return {}
      }) as never,
    query: () =>
      Effect.sync(() => {
        const items = [...rows.values()]
        return { Items: items, Count: items.length, ScannedCount: items.length }
      }) as never,
  })
  return { rows, writes, layer }
}

const run = <A, E>(
  layer: Layer.Layer<DynamoClient>,
  body: (db: any) => Effect.Effect<A, E, never>,
) =>
  Effect.gen(function* () {
    const db: any = yield* DynamoClient.make({
      entities: {},
      aggregates: { Teams },
      tables: { Base },
    } as never)
    return yield* body(db)
  }).pipe(
    Effect.provide(Layer.merge(layer, Base.layer({ name: "as-given" })) as never),
    Effect.exit,
  ) as Effect.Effect<Exit.Exit<A, E>>

const refusal = (exit: Exit.Exit<unknown, unknown>): string => {
  expect(Exit.isFailure(exit)).toBe(true)
  const error = Cause.squash((exit as Exit.Failure<unknown, unknown>).cause) as ValidationError
  expect(error).toBeInstanceOf(ValidationError)
  return String(error.cause)
}

const team = { id: "a", lines: [{ lineId: "l1" }] }

describe("[EDD-9127] an aggregate write refuses a value stored as given that wouldn't read back", () => {
  const POSITIONS: ReadonlyArray<readonly [string, Record<string, unknown>, string]> = [
    ["the root", { f: { b: 5n } }, '"f" of "Team"'],
    ["the root, a class", { k: new Klass({ b: 5n }) }, '"k" of "Team"'],
    ["a one edge", { coach: { name: "c", f: { b: 5n } } }, '"f" of "coach"'],
    ["a many edge's element", { lines: [{ lineId: "l1", f: { b: 5n } }] }, '"f" of "lines"'],
    ["a sub-aggregate", { squad: { label: "s", f: { b: 5n } } }, '"f" of "squad"'],
    [
      "a sub-aggregate's edge",
      { squad: { label: "s", captain: { name: "c", f: { b: 5n } } } },
      '"f" of "captain"',
    ],
  ]

  for (const [position, given, named] of POSITIONS) {
    it.effect(`create, at ${position}`, () =>
      Effect.gen(function* () {
        const { rows, writes, layer } = memory()
        const exit = yield* run(layer, (db) => db.aggregates.Teams.create({ ...team, ...given }))
        const cause = refusal(exit)
        expect(cause).toContain("EDD-9127")
        expect(cause).toContain(`Field ${named} can't be put in the stored form`)
        // The read's own issue, with the path it failed at.
        expect(cause).toMatch(/aggregate wouldn't read back: Expected \w+\n\s+at \["/)
        expect(writes).toEqual([])
        expect(rows.size).toBe(0)
      }),
    )

    it.effect(`update, at ${position}`, () =>
      Effect.gen(function* () {
        const { rows, writes, layer } = memory()
        yield* run(layer, (db) => db.aggregates.Teams.create(team))
        const before = new Map(rows)
        const exit = yield* run(layer, (db) =>
          db.aggregates.Teams.update({ id: "a" }, ({ state }: any) => ({ ...state, ...given })),
        )
        const cause = refusal(exit)
        expect(cause).toContain("EDD-9127")
        expect(cause).toContain(`Field ${named} can't be put in the stored form`)
        expect(writes).toEqual(["transactWriteItems"])
        expect(rows).toEqual(before)
      }),
    )
  }

  it.effect("names each field once, however many rows hold it", () =>
    Effect.gen(function* () {
      const { writes, layer } = memory()
      const exit = yield* run(layer, (db) =>
        db.aggregates.Teams.create({
          ...team,
          f: { b: 5n },
          lines: [
            { lineId: "l1", f: { b: 5n } },
            { lineId: "l2", f: { b: 6n } },
          ],
        }),
      )
      expect(refusal(exit)).toContain(`Fields "f" of "Team", "f" of "lines" can't be put`)
      expect(writes).toEqual([])
    }),
  )

  it.effect("stores a one-way transformation's value as given, since it reads back", () =>
    Effect.gen(function* () {
      const { rows, writes, layer } = memory()
      const created = yield* run(layer, (db) => db.aggregates.Teams.create({ ...team, w: "x" }))
      expect(Exit.isSuccess(created)).toBe(true)
      expect(writes).toEqual(["transactWriteItems"])
      const root = [...rows.values()].find((row) => row.w !== undefined)
      expect(root?.w).toEqual({ S: "x" })
      const read = yield* run(layer, (db) => db.aggregates.Teams.get({ id: "a" }))
      expect(Exit.isSuccess(read) && (read.value as any).w).toBe("x")
      const updated = yield* run(layer, (db) =>
        db.aggregates.Teams.update({ id: "a" }, ({ state }: any) => ({ ...state, note: "n" })),
      )
      expect(Exit.isSuccess(updated) && (updated.value as any).w).toBe("x")
      expect(writes).toEqual(["transactWriteItems", "transactWriteItems"])
    }),
  )
})
