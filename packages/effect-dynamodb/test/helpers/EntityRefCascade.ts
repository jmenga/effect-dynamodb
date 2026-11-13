/**
 * A cascade from a referenced entity stores what a `put` naming it stores (#241): the referenced
 * item encoded through its entity's `modelSchema` (`refDataOf`, one function for both), in the
 * attribute the target stores its ref in (`Entity._setOf`, the naming every write uses).
 *
 * `fixtures/entity-ref-cascade-1.40.0.json` holds what published 1.40.0 sent, stored and returned
 * on DynamoDB Local (1.39.0 is the same): a Team holding every transformed field kind (a
 * `Schema.Redacted`, a date in each encoding, a `NumberFromString`, a bigint, a renamed field, a
 * sparse map and a packed field), keyed by a string or a number, a Player put naming it (its ref
 * stored under its own name, or renamed), the team renamed with a cascade to Players. There, a
 * string-keyed cascade marshalled the team's domain item as it was, under the ref's model field
 * name: a `Redacted` became an empty map, so the Player then died on every read, a date its
 * `DateTime`'s internals, a `NumberFromString` a number; a renamed ref got a second attribute and
 * kept its stale value. A number-keyed cascade queried a partition no `put` writes and updated
 * nothing. A put of a packed ref is refused (`EDD-9075`), so a ref is never packed.
 *
 * One suite, run on a recording table (`EntityRefKeys.test.ts`) and against DynamoDB Local
 * (`connected.entity-ref-keys.test.ts`), with their harnesses.
 */

import { readFileSync } from "node:fs"
import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { DateTime, Effect, Exit, Redacted, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { DynamoClient } from "../../src/DynamoClient.js"
import * as Entity from "../../src/Entity.js"
import * as Table from "../../src/Table.js"
import type { Harness } from "./EntityRefKeys.js"

type Row = Record<string, AttributeValue>
type Sent = { readonly command: string; readonly input: any }
type Outcome = {
  readonly ok?: any
  readonly failed?: string
  readonly operation?: string
  readonly cause?: string
  readonly died?: string
}
type Recorded = {
  readonly seeded: Outcome
  readonly put: Outcome
  readonly putRequests: ReadonlyArray<Sent>
  readonly get: Outcome
  readonly rows: ReadonlyArray<Row>
  readonly cascade: Outcome
  readonly cascadeRequests: ReadonlyArray<Sent>
  readonly cascadeRows: ReadonlyArray<Row>
  readonly getAfter: Outcome
}

const published = JSON.parse(
  readFileSync(new URL("../fixtures/entity-ref-cascade-1.40.0.json", import.meta.url), "utf8"),
) as { readonly generatedFrom: string; readonly shapes: Record<string, Recorded> }

const schema = DynamoSchema.make({ name: "cascade", version: 1 })
const at = DateTime.makeUnsafe(1700000000000)
const one = (composite: ReadonlyArray<string>) => ({
  pk: { field: "pk", composite: [...composite] },
  sk: { field: "sk", composite: [] as Array<string> },
})

const shapes = {
  "keyed by a string": { key: "string", renamed: false },
  "keyed by a string, the ref renamed": { key: "string", renamed: true },
  "keyed by a number": { key: "number", renamed: false },
  "keyed by a number, the ref renamed": { key: "number", renamed: true },
} as const
type Label = keyof typeof shapes

/** The fixture generator's definitions. */
const define = (label: Label) => {
  const { key, renamed } = shapes[label]
  const idName = key === "string" ? "id" : "num"
  const fields = {
    ...(key === "string" ? { id: Schema.String } : { num: Schema.Number }),
    name: Schema.String,
    secret: Schema.Redacted(Schema.String),
    at: Schema.DateTimeUtc,
    atMs: Schema.DateTimeUtc.pipe(DynamoModel.storedAs(DynamoModel.DateEpochMs)),
    atS: DynamoModel.DateEpochSeconds,
    count: Schema.NumberFromString,
    big: Schema.BigInt,
    label: Schema.String,
    tags: Schema.Record(Schema.String, Schema.Number),
    blob: Schema.Struct({ a: Schema.Number }),
  }
  const Team = Schema.Class<unknown>("Team")(fields) as unknown as Schema.Top
  const Teams = Entity.make({
    model: DynamoModel.configure(Team, {
      [idName]: { identifier: true },
      label: { field: "teamLabel" },
      tags: { storedAs: DynamoModel.SparseMap() },
      blob: { storedAs: DynamoModel.Packed({ format: "json" }) },
    } as never),
    entityType: "Team",
    primaryKey: one([idName]),
  } as never) as any
  class Player extends Schema.Class<Player>("Player")({
    id: Schema.String,
    team: Team.pipe(DynamoModel.ref) as Schema.Top,
  }) {}
  const Players = Entity.make({
    model: renamed ? DynamoModel.configure(Player, { team: { field: "teamData" } }) : Player,
    entityType: "Player",
    primaryKey: one(["id"]),
    refs: {
      team: {
        entity: Teams,
        cascade: { index: "gsi1", pk: { field: "gsi1pk" }, sk: { field: "gsi1sk" } },
      },
    },
  } as never) as any
  const Main = Table.make({ schema, entities: { Teams, Players } } as never) as any
  const id = key === "string" ? "t1" : 5
  const seed = {
    [idName]: id,
    name: "Tigers",
    secret: Redacted.make("s3"),
    at,
    atMs: at,
    atS: at,
    count: 7,
    big: 9n,
    label: "L",
    tags: { a: 1 },
    blob: { a: 2 },
  }
  return { Teams, Players, Main, id, idName, seed, refAttribute: renamed ? "teamData" : "team" }
}

/** A value as the fixture holds it: a date as its epoch milliseconds, a `Redacted` as its value. */
const plain = (value: unknown): unknown =>
  JSON.parse(
    JSON.stringify(value, function (this: any, key, encoded) {
      const held = this[key]
      if (held !== null && typeof held === "object" && DateTime.isDateTime(held)) {
        return { date: DateTime.toEpochMillis(held) }
      }
      if (held !== null && typeof held === "object" && Redacted.isRedacted(held)) {
        return { redacted: Redacted.value(held) }
      }
      if (typeof held === "bigint") return `${held}n`
      return encoded
    }),
  )

const outcome = <A, E>(exit: Exit.Exit<A, E>): Outcome => {
  if (Exit.isSuccess(exit)) return { ok: plain(exit.value) }
  const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail")
  if (failure === undefined) return { died: String(exit.cause).split("\n")[0]! }
  const error = (failure as unknown as { readonly error: any }).error
  return {
    failed: error._tag,
    operation: error.operation,
    cause: String(error.cause?.message ?? error.cause ?? error.message),
  }
}

const keyOf = (row: Row) => `${row.pk?.S} ${row.sk?.S}`
const sorted = (rows: ReadonlyArray<Row>) =>
  [...rows].sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0))

const runShape = (harness: Harness, label: Label, mode?: "transactional") =>
  harness.onTable((tableName) =>
    Effect.gen(function* () {
      const shape = define(label)
      const run = <A, E>(effect: Effect.Effect<A, E, any>) =>
        harness.provide(tableName, shape.Main, effect)
      const db: any = yield* run(
        DynamoClient.make({
          entities: { Teams: shape.Teams, Players: shape.Players },
          tables: { Main: shape.Main },
        } as never),
      )
      const seeded = outcome(yield* Effect.exit(run(db.entities.Teams.put(shape.seed).asEffect())))
      yield* harness.requests(tableName)
      const put = outcome(
        yield* Effect.exit(run(db.entities.Players.put({ id: "p1", teamId: shape.id }).asEffect())),
      )
      const putRequests = yield* harness.requests(tableName)
      const get = outcome(yield* Effect.exit(run(db.entities.Players.get({ id: "p1" }))))
      const rows = sorted(yield* harness.rows(tableName))
      yield* harness.requests(tableName)
      const cascade = outcome(
        yield* Effect.exit(
          run(
            db.entities.Teams.update({ [shape.idName]: shape.id })
              .set({ name: "Lions" })
              .cascade({ targets: [shape.Players], ...(mode === undefined ? {} : { mode }) })
              .asEffect(),
          ),
        ),
      )
      const cascadeRequests = yield* harness.requests(tableName)
      const cascadeRows = sorted(yield* harness.rows(tableName))
      const getAfter = outcome(yield* Effect.exit(run(db.entities.Players.get({ id: "p1" }))))
      return {
        recorded: {
          seeded,
          put,
          putRequests,
          get,
          rows,
          cascade,
          cascadeRequests,
          cascadeRows,
          getAfter,
        } as Recorded,
        refAttribute: shape.refAttribute,
      }
    }),
  )

const playerOf = (rows: ReadonlyArray<Row>) => rows.find((row) => row.__edd_e__?.S === "Player")!
const teamOf = (rows: ReadonlyArray<Row>) => rows.find((row) => row.__edd_e__?.S === "Team")!
/** A stored ref (`{ M }`) with the team's name `Lions`. */
const renamedTeam = (ref: AttributeValue): AttributeValue => ({
  M: { ...ref.M!, name: { S: "Lions" } },
})

export const suite = (
  harness: Harness,
  describeIt: (name: string, body: () => void) => void = describe,
) =>
  describeIt("a cascade stores what a put naming the entity stores", () => {
    it("the fixture is published 1.40.0's, and holds every shape", () => {
      expect(published.generatedFrom).toBe("effect-dynamodb@1.40.0")
      expect(Object.keys(published.shapes).sort()).toEqual(Object.keys(shapes).sort())
    })

    it("on 1.40.0 a cascade stored the domain item unencoded, under the ref's model field name", () => {
      const own = published.shapes["keyed by a string"]!
      const sent = own.cascadeRequests[2]!.input
      expect(sent.ExpressionAttributeNames).toEqual({ "#ref": "team" })
      const stored = sent.ExpressionAttributeValues[":refData"].M
      expect(stored.secret).toEqual({ M: { "~effect/Redacted": { M: {} } } })
      expect(stored.at.M.epochMilliseconds).toEqual({ N: "1700000000000" })
      expect(stored.count).toEqual({ N: "7" })
      expect(own.getAfter).toEqual({
        died: expect.stringContaining("Unable to get redacted value"),
      })
      const renamed = published.shapes["keyed by a string, the ref renamed"]!
      expect(renamed.cascadeRequests[2]!.input.ExpressionAttributeNames).toEqual({
        "#ref": "team",
      })
      expect(Object.keys(playerOf(renamed.cascadeRows))).toContain("team")
      expect(renamed.getAfter.ok.team.name).toBe("Tigers")
      for (const label of ["keyed by a number", "keyed by a number, the ref renamed"] as const) {
        expect(published.shapes[label]!.cascadeRequests.map((sent) => sent.command)).toEqual([
          "UpdateItem",
          "Query",
        ])
      }
    })

    for (const label of Object.keys(shapes) as ReadonlyArray<Label>) {
      it(`${label}: the put is 1.40.0's, and the cascade rewrites the ref exactly as the put stored it`, () =>
        Effect.runPromise(
          Effect.gen(function* () {
            const before = published.shapes[label]!
            const { recorded, refAttribute } = yield* runShape(harness, label)
            // Seeding, the put and its read are 1.40.0's, byte for byte.
            expect(recorded.seeded).toEqual(before.seeded)
            expect(recorded.put).toEqual(before.put)
            expect(recorded.putRequests).toEqual(before.putRequests)
            expect(recorded.rows).toEqual(before.rows)
            expect(recorded.get).toEqual(before.get)
            expect(recorded.cascade).toEqual(before.cascade)

            const putRow = playerOf(before.rows)
            expect(recorded.cascadeRequests.map((sent) => sent.command)).toEqual([
              "UpdateItem",
              "Query",
              "UpdateItem",
            ])
            // The source's own update is 1.40.0's; the query reads the partition the put wrote.
            expect(recorded.cascadeRequests[0]).toEqual(before.cascadeRequests[0])
            expect(recorded.cascadeRequests[1]!.input.ExpressionAttributeValues[":pk"]).toEqual(
              putRow.gsi1pk,
            )
            if (shapes[label].key === "string") {
              expect(recorded.cascadeRequests[1]).toEqual(before.cascadeRequests[1])
            }
            // The ref is written where the put stored it, as the put stored it, but the name.
            const update = recorded.cascadeRequests[2]!.input
            expect(update.ExpressionAttributeNames).toEqual({ "#ref": refAttribute })
            expect(update.ExpressionAttributeValues).toEqual({
              ":refData": renamedTeam(putRow[refAttribute]!),
            })
            // The row afterwards is the row the put wrote, but the name, and nothing else.
            expect(playerOf(recorded.cascadeRows)).toEqual({
              ...putRow,
              [refAttribute]: renamedTeam(putRow[refAttribute]!),
            })
            expect(teamOf(recorded.cascadeRows)).toEqual(teamOf(before.cascadeRows))
            expect(recorded.getAfter).toEqual({
              ok: { ...before.get.ok, team: { ...before.get.ok.team, name: "Lions" } },
            })
          }),
        ))
    }

    it("a transactional cascade writes the same update", () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const label = "keyed by a number, the ref renamed"
          const eventual = (yield* runShape(harness, label)).recorded
          const { recorded } = yield* runShape(harness, label, "transactional")
          expect(recorded.cascadeRequests.map((sent) => sent.command)).toEqual([
            "UpdateItem",
            "Query",
            "TransactWriteItems",
          ])
          const {
            TableName,
            Key,
            UpdateExpression,
            ExpressionAttributeNames,
            ExpressionAttributeValues,
          } = eventual.cascadeRequests[2]!.input
          expect(recorded.cascadeRequests[2]!.input).toEqual({
            TransactItems: [
              {
                Update: {
                  TableName,
                  Key,
                  UpdateExpression,
                  ExpressionAttributeNames,
                  ExpressionAttributeValues,
                },
              },
            ],
          })
          expect(recorded.cascadeRows).toEqual(eventual.cascadeRows)
          expect(recorded.getAfter).toEqual(eventual.getAfter)
        }),
      ))
  })
