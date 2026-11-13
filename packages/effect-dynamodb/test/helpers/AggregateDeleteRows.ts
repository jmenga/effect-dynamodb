/**
 * An aggregate `delete` deletes the rows in its partition whose `__edd_e__` is one of its own
 * entity types, and leaves every other row there: another aggregate's, an entity's, a row with no
 * type. The read is the one it sent before, and so is every request when the partition holds only
 * its rows: `fixtures/aggregate-delete-1.40.0.json` holds what published 1.40.0 sent there (1.39.0
 * sent the same), captured once on DynamoDB Local. One suite, run on a recording table
 * (`AggregateDeleteRows.test.ts`) and against DynamoDB Local
 * (`connected.aggregate-delete-rows.test.ts`).
 */

import { readFileSync } from "node:fs"
import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Aggregate from "../../src/Aggregate.js"
import { DynamoClient } from "../../src/DynamoClient.js"
import * as Table from "../../src/Table.js"

type Row = Record<string, AttributeValue>

const published = JSON.parse(
  readFileSync(new URL("../fixtures/aggregate-delete-1.40.0.json", import.meta.url), "utf8"),
) as {
  readonly generatedFrom: string
  readonly alone: {
    readonly requests: ReadonlyArray<{ readonly command: string; readonly input: unknown }>
    readonly rowsAfter: ReadonlyArray<Row>
  }
}

class Line extends Schema.Class<Line>("Line")({ lineId: Schema.String }) {}
class Coach extends Schema.Class<Coach>("Coach")({ name: Schema.String }) {}
class Captain extends Schema.Class<Captain>("Captain")({ name: Schema.String }) {}
class Squad extends Schema.Class<Squad>("Squad")({
  label: Schema.String,
  captain: Schema.optional(Captain),
}) {}
class Team extends Schema.Class<Team>("Team")({
  id: Schema.String,
  coach: Schema.optional(Coach),
  lines: Schema.Array(Line),
  squad: Schema.optional(Squad),
}) {}

const schema = DynamoSchema.make({ name: "owned", version: 1 })
export const Main = Table.make({ schema, entities: {} })
// A child edge makes it a sub-aggregate, with a root row of its own.
const SquadAggregate = Aggregate.make(Squad, {
  root: { entityType: "TeamSquad" },
  edges: { captain: Aggregate.one({ entityType: "SquadCaptain" }) },
})
const Teams = Aggregate.make(Team, {
  table: Main,
  schema,
  pk: { field: "pk", composite: ["id"] },
  collection: { name: "team" },
  root: { entityType: "Team" },
  edges: {
    coach: Aggregate.one({ entityType: "TeamCoach" }),
    lines: Aggregate.many({ entityType: "TeamLine", sk: { composite: ["lineId"] } }),
    squad: SquadAggregate.with({ discriminator: { n: 1 } }),
  },
})

const bind = DynamoClient.make({ entities: {}, aggregates: { Teams }, tables: { Main } })

/** A team with a row of each of its six types: Team, TeamCoach, TeamLine, TeamSquad, SquadCaptain. */
const team = {
  id: "a",
  coach: { name: "c" },
  lines: [{ lineId: "l1" }, { lineId: "l2" }],
  squad: { label: "s", captain: { name: "k" } },
}
const OWN_TYPES = ["SquadCaptain", "Team", "TeamCoach", "TeamLine", "TeamLine", "TeamSquad"]
/** The team's partition. */
const PK = { S: "$owned#v1#team#a" }

/** Rows in the team's partition that aren't the aggregate's: none of its entity types. */
const foreignRows = (pk: AttributeValue): ReadonlyArray<Row> => [
  // An entity's row.
  { pk, sk: { S: "$owned#v1#other#1" }, __edd_e__: { S: "Other" }, note: { S: "kept" } },
  // A row no library wrote.
  { pk, sk: { S: "plain" }, note: { S: "kept" } },
  // A type that only begins with one of the aggregate's.
  { pk, sk: { S: "$owned#v1#teamx#1" }, __edd_e__: { S: "TeamX" }, note: { S: "kept" } },
]

/** A row of one of the aggregate's types that its value doesn't hold. */
const sharedTypeRow = (pk: AttributeValue): Row => ({
  pk,
  sk: { S: "$owned#v1#teamline#zz" },
  __edd_e__: { S: "TeamLine" },
  lineId: { S: "zz" },
})

export interface Harness {
  /** Run `body` on a fresh, empty table named `tableName`. */
  readonly onTable: <A, E>(
    body: (tableName: string) => Effect.Effect<A, E, any>,
  ) => Effect.Effect<A, unknown>
  /** Every row of the table. */
  readonly rows: (tableName: string) => Effect.Effect<ReadonlyArray<Row>>
  /** The requests sent since the last call: commands and inputs, `TableName` left out. */
  readonly requests: (
    tableName: string,
  ) => Effect.Effect<ReadonlyArray<{ readonly command: string; readonly input: unknown }>>
}

const keyOf = (row: Row) => `${row.pk?.S} ${row.sk?.S}`
const sorted = (rows: ReadonlyArray<Row>) =>
  [...rows].sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0))

const put = (tableName: string, rows: ReadonlyArray<Row>) =>
  Effect.gen(function* () {
    const client = yield* DynamoClient
    for (const Item of rows) yield* client.putItem({ TableName: tableName, Item })
  })

export const suite = (
  harness: Harness,
  describeIt: (name: string, body: () => void) => void = describe,
) =>
  describeIt("an aggregate delete deletes only the rows of its own entity types", () => {
    /** Create the team, add `extra(pk)` to its partition, and forget the requests so far. */
    const seeded = (tableName: string, extra: (pk: AttributeValue) => ReadonlyArray<Row>) =>
      Effect.gen(function* () {
        const db = yield* bind
        yield* db.aggregates.Teams.create(team as never)
        const own = yield* harness.rows(tableName)
        expect(own.map((row) => row.__edd_e__?.S).sort()).toEqual(OWN_TYPES)
        expect([...new Set(own.map((row) => row.pk?.S))]).toEqual([PK.S])
        const added = extra(PK)
        yield* put(tableName, added)
        yield* harness.requests(tableName)
        return { db, own, added }
      })

    it("a foreign row is kept, and every own row is deleted", () =>
      Effect.runPromise(
        harness.onTable((tableName) =>
          Effect.gen(function* () {
            const { db, added } = yield* seeded(tableName, foreignRows)
            yield* db.aggregates.Teams.delete({ id: "a" })
            expect(sorted(yield* harness.rows(tableName))).toEqual(sorted(added))
            const error = yield* db.aggregates.Teams.get({ id: "a" }).pipe(Effect.flip)
            expect(error._tag).toBe("AggregateAssemblyError")
          }),
        ),
      ))

    it("the requests are 1.40.0's for the partition without the foreign rows", () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const deleteOn = (extra: (pk: AttributeValue) => ReadonlyArray<Row>) =>
            harness.onTable((tableName) =>
              Effect.gen(function* () {
                const { db } = yield* seeded(tableName, extra)
                yield* db.aggregates.Teams.delete({ id: "a" })
                return yield* harness.requests(tableName)
              }),
            )
          const alone = yield* deleteOn(() => [])
          const beside = yield* deleteOn(foreignRows)
          expect(published.generatedFrom).toBe("effect-dynamodb@1.40.0")
          expect(alone).toEqual(published.alone.requests)
          expect(beside).toEqual(alone)
        }),
      ))

    it("a row of one of its types is deleted, whoever wrote it, as on 1.39.0", () =>
      Effect.runPromise(
        harness.onTable((tableName) =>
          Effect.gen(function* () {
            const { db } = yield* seeded(tableName, (pk) => [...foreignRows(pk), sharedTypeRow(pk)])
            yield* db.aggregates.Teams.delete({ id: "a" })
            const left = yield* harness.rows(tableName)
            expect(left.map((row) => row.__edd_e__?.S ?? null).sort()).toEqual([
              "Other",
              "TeamX",
              null,
            ])
          }),
        ),
      ))

    it("a partition holding none of its rows: the key finds nothing, and nothing is deleted", () =>
      Effect.runPromise(
        harness.onTable((tableName) =>
          Effect.gen(function* () {
            const db = yield* bind
            yield* put(tableName, foreignRows(PK))
            const before = yield* harness.rows(tableName)
            yield* harness.requests(tableName)
            const error = yield* db.aggregates.Teams.delete({ id: "a" }).pipe(Effect.flip)
            expect(error._tag).toBe("AggregateAssemblyError")
            expect((yield* harness.requests(tableName)).map((request) => request.command)).toEqual([
              "Query",
            ])
            expect(sorted(yield* harness.rows(tableName))).toEqual(sorted(before))
          }),
        ),
      ))
  })
