/**
 * A condition's or filter's primitive operand compared with a path into a ref is sent as the stored
 * ref holds it. The stored ref is the referenced item in its entity's stored form, so a player keyed
 * by a `Schema.NumberFromString` id is held as `{ id: "5" }`. Up to 1.41.0 a primitive was sent as
 * given, so `eq(t.player.id, 5)` compared the number `5` with the text `"5"` and never held: a
 * condition naming it always failed, and a filter on it found nothing. The same went for any other
 * transformed field inside the ref, and for the entity's own. An operand the row holds as given (an
 * untransformed ref's id, a plain field inside the ref, the id's text, a partial ISO date) is the
 * request 1.41.0 sent.
 *
 * One suite, run on a recording table (`EntityRefKeys.test.ts`) and against DynamoDB Local
 * (`connected.entity-ref-keys.test.ts`), with their harnesses.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { DateTime, Effect, Exit, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { DynamoClient } from "../../src/DynamoClient.js"
import * as Entity from "../../src/Entity.js"
import * as Table from "../../src/Table.js"
import type { Harness } from "./EntityRefKeys.js"

type Row = Record<string, AttributeValue>
type Sent = { readonly command: string; readonly input: any }

const schema = DynamoSchema.make({ name: "operands", version: 1 })
const byId = {
  pk: { field: "pk", composite: ["id"] },
  sk: { field: "sk", composite: [] },
} as const

class Team extends Schema.Class<Team>("OperandTeam")({ id: Schema.String, name: Schema.String }) {}
class Player extends Schema.Class<Player>("OperandPlayer")({
  id: Schema.NumberFromString,
  name: Schema.String,
  shirt: Schema.NumberFromString,
}) {}
class Selection extends Schema.Class<Selection>("OperandSelection")({
  id: Schema.String,
  season: Schema.String,
  picks: Schema.NumberFromString,
  listed: Schema.DateTimeUtc,
  team: Team,
  player: Player,
}) {}

const entities = () => {
  const Teams = Entity.make({
    model: DynamoModel.configure(Team, { id: { identifier: true } }),
    entityType: "Team",
    primaryKey: byId,
  })
  const Players = Entity.make({
    model: DynamoModel.configure(Player, { id: { identifier: true } }),
    entityType: "Player",
    primaryKey: byId,
  })
  const Selections = Entity.make({
    model: DynamoModel.configure(Selection, {
      id: { identifier: true },
      team: { ref: true },
      player: { ref: true },
    }),
    entityType: "Selection",
    primaryKey: byId,
    refs: { team: { entity: Teams }, player: { entity: Players } },
  } as never) as any
  return { Teams, Players, Selections }
}

const prefix = "$operands#v1#selection"

/**
 * On a fresh table: team t1, players 5 (shirt 9) and 6 (shirt 10), selection `a` naming player 5
 * with 3 picks and `b` naming player 6 with 4, and `body` with the steps it takes.
 */
const onTable = (
  harness: Harness,
  body: (t: {
    readonly db: any
    /** Run `op`, with the requests it sent. */
    readonly step: (op: any) => Effect.Effect<{ exit: Exit.Exit<any, any>; sent: Array<Sent> }>
    /** The selection's stored row. */
    readonly row: (id: string) => Effect.Effect<Row>
  }) => Effect.Effect<void, unknown>,
) =>
  harness.onTable((tableName) =>
    Effect.gen(function* () {
      const { Teams, Players, Selections } = entities()
      const Main = Table.make({ schema, entities: { Teams, Players, Selections } } as never) as any
      const exec = <A, E>(op: any): Effect.Effect<A, E> =>
        harness.provide(tableName, Main, typeof op.asEffect === "function" ? op.asEffect() : op)
      const db: any = yield* exec(
        DynamoClient.make({ entities: { Teams, Players, Selections }, tables: { Main } } as never),
      )
      const listed = DateTime.makeUnsafe("2026-01-15T00:00:00.000Z")
      yield* exec(db.entities.Teams.put({ id: "t1", name: "Team One" }))
      yield* exec(db.entities.Players.put({ id: 5, name: "P5", shirt: 9 }))
      yield* exec(db.entities.Players.put({ id: 6, name: "P6", shirt: 10 }))
      for (const [id, playerId, picks] of [
        ["a", 5, 3],
        ["b", 6, 4],
      ] as const) {
        yield* exec(
          db.entities.Selections.put({ id, season: "2025", picks, listed, teamId: "t1", playerId }),
        )
      }
      const step = (op: any) =>
        Effect.gen(function* () {
          yield* harness.requests(tableName)
          const exit = yield* Effect.exit(exec(op))
          return { exit, sent: [...(yield* harness.requests(tableName))] as Array<Sent> }
        })
      const row = (id: string) =>
        Effect.map(
          harness.rows(tableName),
          (rows) => rows.find((r) => r.pk?.S === `${prefix}#id_${id}` && r.sk?.S === prefix)!,
        )
      yield* body({ db, step, row })
    }),
  )

const failure = (exit: Exit.Exit<any, any>) =>
  Exit.isFailure(exit)
    ? (exit.cause.reasons.find((reason) => reason._tag === "Fail") as any)?.error
    : undefined
const ids = (exit: Exit.Exit<any, any>) =>
  Exit.isSuccess(exit) ? (exit.value as Array<{ id: string }>).map((item) => item.id).sort() : exit

export const suite = (
  harness: Harness,
  describeIt: (name: string, body: () => void) => void = describe,
) =>
  describeIt(
    "a primitive operand compared with a path into a ref, as the stored ref holds it",
    () => {
      it("a condition on a ref's transformed id holds on the row naming that player, and only there", () =>
        Effect.runPromise(
          onTable(harness, ({ db, step, row }) =>
            Effect.gen(function* () {
              const S = db.entities.Selections
              const onPlayer5 = (id: string) =>
                S.update({ id })
                  .set({ season: "2026" })
                  .condition((t: any, { eq }: any) => eq(t.player.id, 5))
              const a = yield* step(onPlayer5("a"))
              expect(Exit.isSuccess(a.exit)).toBe(true)
              const write = a.sent.at(-1)!.input
              expect(write.ConditionExpression).toBe(
                "(#e0.#e1 = :e2) AND attribute_exists(#exists)",
              )
              expect(write.ExpressionAttributeNames).toMatchObject({ "#e0": "player", "#e1": "id" })
              expect(write.ExpressionAttributeValues[":e2"]).toEqual({ S: "5" })
              expect((yield* row("a")).season).toEqual({ S: "2026" })

              // A row naming player 6 fails it, and nothing is written.
              const before = yield* row("b")
              const b = yield* step(onPlayer5("b"))
              expect(failure(b.exit)?._tag).toBe("ConditionalCheckFailed")
              expect(yield* row("b")).toEqual(before)
            }),
          ),
        ))

      it("a filter on a ref's transformed fields, or the entity's own, finds the rows holding them", () =>
        Effect.runPromise(
          onTable(harness, ({ db, step }) =>
            Effect.gen(function* () {
              const scan = (filter: (t: any, ops: any) => unknown) =>
                step(db.entities.Selections.scan().filter(filter).collect())
              const byId = yield* scan((t, { eq }) => eq(t.player.id, 5))
              expect(ids(byId.exit)).toEqual(["a"])
              expect(byId.sent[0]!.input.ExpressionAttributeValues[":e2"]).toEqual({ S: "5" })
              // A transformed field of the player other than its id.
              expect(ids((yield* scan((t, { eq }) => eq(t.player.shirt, 10))).exit)).toEqual(["b"])
              // The entity's own transformed field.
              const own = yield* scan((t, { eq }) => eq(t.picks, 3))
              expect(ids(own.exit)).toEqual(["a"])
              expect(own.sent[0]!.input.ExpressionAttributeValues[":e1"]).toEqual({ S: "3" })
            }),
          ),
        ))

      it("an operand the row holds as given is the request 1.41.0 sent", () =>
        Effect.runPromise(
          onTable(harness, ({ db, step }) =>
            Effect.gen(function* () {
              const found = yield* step(
                db.entities.Selections.scan()
                  .filter((t: any, { and, eq, gte }: any) =>
                    and(
                      eq(t.team.id, "t1"),
                      eq(t.player.name, "P5"),
                      eq(t.player.id, "5"),
                      eq(t.season, "2025"),
                      gte(t.listed, "2026-01"),
                    ),
                  )
                  .collect(),
              )
              expect(ids(found.exit)).toEqual(["a"])
              expect(found.sent).toEqual([
                {
                  command: "Scan",
                  input: {
                    TableName: "<table>",
                    FilterExpression:
                      "#eddE IN (:et0) AND ((#e0.#e1 = :e2) AND (#e3.#e4 = :e5) AND (#e6.#e7 = :e8) AND (#e9 = :e10) AND (#e11 >= :e12))",
                    ExpressionAttributeNames: {
                      "#eddE": "__edd_e__",
                      "#e0": "team",
                      "#e1": "id",
                      "#e3": "player",
                      "#e4": "name",
                      "#e6": "player",
                      "#e7": "id",
                      "#e9": "season",
                      "#e11": "listed",
                    },
                    ExpressionAttributeValues: {
                      ":et0": { S: "Selection" },
                      ":e2": { S: "t1" },
                      ":e5": { S: "P5" },
                      ":e8": { S: "5" },
                      ":e10": { S: "2025" },
                      ":e12": { S: "2026-01" },
                    },
                  },
                },
              ])
            }),
          ),
        ))
    },
  )
