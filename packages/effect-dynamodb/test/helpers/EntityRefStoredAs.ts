/**
 * A ref to an entity whose `DynamoModel.configure` stores a date in another form than the default
 * (`born: { storedAs: DynamoModel.DateEpochSeconds }`) holds it in that form: hydration stores the
 * item as the entity's own read schema encodes it (`refDataOf`), so the player's `born` is held as
 * epoch seconds. Up to 1.41.0 every schema the referencing entity derived for the ref took the
 * player's model without its `configure`, so the ref was read, compared and path-written as ISO
 * text: a read took the seconds for milliseconds (a date in January 1970) and failed on a
 * `NullOr` date, a condition or filter on `player.born` sent ISO text that never matched, and
 * `pathSet(["player", "born"], …)` wrote ISO text into the ref. A `field:` rename doesn't travel:
 * the ref holds the player by its domain names. A ref whose entity configures no storage (the team)
 * is sent as 1.41.0 sent it.
 *
 * One suite, run on a recording table (`EntityRefKeys.test.ts`) and against DynamoDB Local
 * (`connected.entity-ref-keys.test.ts`), with their harnesses.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { DateTime, Effect, Equal, Exit, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { DynamoClient } from "../../src/DynamoClient.js"
import * as Entity from "../../src/Entity.js"
import * as Table from "../../src/Table.js"
import type { Harness } from "./EntityRefKeys.js"

type Row = Record<string, AttributeValue>
type Sent = { readonly command: string; readonly input: any }

const schema = DynamoSchema.make({ name: "storedas", version: 1 })
const byId = {
  pk: { field: "pk", composite: ["id"] },
  sk: { field: "sk", composite: [] },
} as const

class Team extends Schema.Class<Team>("StoredAsTeam")({
  id: Schema.String,
  founded: Schema.DateTimeUtc,
}) {}
class Player extends Schema.Class<Player>("StoredAsPlayer")({
  id: Schema.String,
  name: Schema.String,
  born: Schema.DateTimeUtc,
  retired: Schema.NullOr(Schema.DateTimeUtc),
}) {}
class Selection extends Schema.Class<Selection>("StoredAsSelection")({
  id: Schema.String,
  season: Schema.String,
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
    model: DynamoModel.configure(Player, {
      id: { identifier: true },
      name: { field: "fullName" },
      born: { storedAs: DynamoModel.DateEpochSeconds },
      retired: { storedAs: DynamoModel.DateEpochSeconds },
    }),
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

const at = (iso: string) => DateTime.makeUnsafe(iso)
const FOUNDED = "1990-05-06T07:08:09.000Z"
const BORN_5 = at("2001-02-03T04:05:06.000Z")
const BORN_6 = at("2002-03-04T05:06:07.000Z")
const RETIRED_6 = at("2024-01-02T03:04:05.000Z")
/** `DateEpochSeconds`'s stored form of a date. */
const seconds = (date: DateTime.Utc): AttributeValue => ({
  N: String(Math.floor(DateTime.toEpochMillis(date) / 1000)),
})
const prefix = "$storedas#v1#selection"

/**
 * On a fresh table: team t1, player p5 (not retired) and p6 (retired), selection `a` naming p5 and
 * `b` naming p6, each with team t1, and `body` with the steps it takes. `put` holds the requests
 * putting `a`.
 */
const onTable = (
  harness: Harness,
  body: (t: {
    readonly db: any
    readonly put: ReadonlyArray<Sent>
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
      yield* exec(db.entities.Teams.put({ id: "t1", founded: at(FOUNDED) }))
      yield* exec(db.entities.Players.put({ id: "p5", name: "P5", born: BORN_5, retired: null }))
      yield* exec(
        db.entities.Players.put({ id: "p6", name: "P6", born: BORN_6, retired: RETIRED_6 }),
      )
      const step = (op: any) =>
        Effect.gen(function* () {
          yield* harness.requests(tableName)
          const exit = yield* Effect.exit(exec(op))
          return { exit, sent: [...(yield* harness.requests(tableName))] as Array<Sent> }
        })
      const put = yield* step(
        db.entities.Selections.put({ id: "a", season: "2025", teamId: "t1", playerId: "p5" }),
      )
      expect(Exit.isSuccess(put.exit)).toBe(true)
      yield* exec(
        db.entities.Selections.put({ id: "b", season: "2025", teamId: "t1", playerId: "p6" }),
      )
      const row = (id: string) =>
        Effect.map(
          harness.rows(tableName),
          (rows) => rows.find((r) => r.pk?.S === `${prefix}#id_${id}` && r.sk?.S === prefix)!,
        )
      yield* body({ db, put: put.sent, step, row })
    }),
  )

const failure = (exit: Exit.Exit<any, any>) =>
  Exit.isFailure(exit)
    ? (exit.cause.reasons.find((reason) => reason._tag === "Fail") as any)?.error
    : undefined
const ids = (exit: Exit.Exit<any, any>) =>
  Exit.isSuccess(exit) ? (exit.value as Array<{ id: string }>).map((item) => item.id).sort() : exit
const same = (a: unknown, b: unknown) => expect(Equal.equals(a, b)).toBe(true)

export const suite = (
  harness: Harness,
  describeIt: (name: string, body: () => void) => void = describe,
) =>
  describeIt("a ref to an entity whose configure stores a date otherwise, in that form", () => {
    it("is put as hydration stores it, read back, compared and path-written in that form", () =>
      Effect.runPromise(
        onTable(harness, ({ db, put, step, row }) =>
          Effect.gen(function* () {
            const S = db.entities.Selections
            // The put: what 1.41.0 stored, the player by its domain names.
            expect(put.map((request) => request.command).sort()).toEqual([
              "GetItem",
              "GetItem",
              "PutItem",
            ])
            expect(put.find((request) => request.command === "PutItem")!.input).toEqual({
              TableName: "<table>",
              Item: {
                id: { S: "a" },
                season: { S: "2025" },
                team: { M: { id: { S: "t1" }, founded: { S: FOUNDED } } },
                player: {
                  M: {
                    id: { S: "p5" },
                    name: { S: "P5" },
                    born: seconds(BORN_5),
                    retired: { NULL: true },
                  },
                },
                __edd_e__: { S: "Selection" },
                pk: { S: `${prefix}#id_a` },
                sk: { S: prefix },
              },
            })
            expect((yield* row("b")).player!.M!.retired).toEqual(seconds(RETIRED_6))

            // A read takes the dates as they're held.
            const a = yield* step(S.get({ id: "a" }))
            const b = yield* step(S.get({ id: "b" }))
            if (Exit.isFailure(a.exit) || Exit.isFailure(b.exit)) throw [a.exit, b.exit]
            same(a.exit.value.player.born, BORN_5)
            expect(a.exit.value.player.retired).toBeNull()
            same(b.exit.value.player.born, BORN_6)
            same(b.exit.value.player.retired, RETIRED_6)

            // A condition on the player's date holds on the row naming that player, and only there.
            const bornOn = (id: string) =>
              S.update({ id })
                .set({ season: "2026" })
                .condition((t: any, { eq }: any) => eq(t.player.born, BORN_5))
            const held = yield* step(bornOn("a"))
            expect(Exit.isSuccess(held.exit)).toBe(true)
            expect(held.sent.at(-1)!.input.ExpressionAttributeValues[":e2"]).toEqual(
              seconds(BORN_5),
            )
            expect((yield* row("a")).season).toEqual({ S: "2026" })
            const before = yield* row("b")
            expect(failure((yield* step(bornOn("b"))).exit)?._tag).toBe("ConditionalCheckFailed")
            expect(yield* row("b")).toEqual(before)

            // A filter on the `NullOr` date finds the row holding it.
            const retired = yield* step(
              S.scan()
                .filter((t: any, { eq }: any) => eq(t.player.retired, RETIRED_6))
                .collect(),
            )
            expect(ids(retired.exit)).toEqual(["b"])
            expect(retired.sent[0]!.input.ExpressionAttributeValues[":e2"]).toEqual(
              seconds(RETIRED_6),
            )

            // `pathSet` writes the date in that form, and a read takes it.
            const moved = at("2003-04-05T06:07:08.000Z")
            const set = yield* step(
              S.update({ id: "a" }).pathSet({ segments: ["player", "born"], value: moved }),
            )
            expect(Exit.isSuccess(set.exit)).toBe(true)
            expect(set.sent.at(-1)!.input.UpdateExpression).toBe("SET #ps0.#ps1 = :ps2")
            expect(set.sent.at(-1)!.input.ExpressionAttributeValues[":ps2"]).toEqual(seconds(moved))
            expect((yield* row("a")).player!.M!.born).toEqual(seconds(moved))
            const after = yield* step(S.get({ id: "a" }))
            if (Exit.isFailure(after.exit)) throw after.exit
            same(after.exit.value.player.born, moved)
          }),
        ),
      ))

    it("a ref whose entity configures no storage is sent as 1.41.0 sent it", () =>
      Effect.runPromise(
        onTable(harness, ({ db, step }) =>
          Effect.gen(function* () {
            const S = db.entities.Selections
            const founded = (t: any, { eq }: any) => eq(t.team.founded, at(FOUNDED))
            const updated = yield* step(
              S.update({ id: "a" }).set({ season: "2026" }).condition(founded),
            )
            expect(Exit.isSuccess(updated.exit)).toBe(true)
            expect(updated.sent).toEqual([
              {
                command: "UpdateItem",
                input: {
                  TableName: "<table>",
                  Key: { pk: { S: `${prefix}#id_a` }, sk: { S: prefix } },
                  UpdateExpression: "SET #u0 = :u0",
                  ExpressionAttributeNames: {
                    "#u0": "season",
                    "#e0": "team",
                    "#e1": "founded",
                    "#exists": "pk",
                  },
                  ExpressionAttributeValues: { ":u0": { S: "2026" }, ":e2": { S: FOUNDED } },
                  ConditionExpression: "(#e0.#e1 = :e2) AND attribute_exists(#exists)",
                  ReturnValuesOnConditionCheckFailure: "ALL_OLD",
                  ReturnValues: "ALL_NEW",
                },
              },
            ])
            const found = yield* step(S.scan().filter(founded).collect())
            expect(found.sent).toEqual([
              {
                command: "Scan",
                input: {
                  TableName: "<table>",
                  FilterExpression: "#eddE IN (:et0) AND (#e0.#e1 = :e2)",
                  ExpressionAttributeNames: {
                    "#eddE": "__edd_e__",
                    "#e0": "team",
                    "#e1": "founded",
                  },
                  ExpressionAttributeValues: { ":et0": { S: "Selection" }, ":e2": { S: FOUNDED } },
                },
              },
            ])
            expect(ids(found.exit)).toEqual(["a", "b"])
          }),
        ),
      ))
  })
