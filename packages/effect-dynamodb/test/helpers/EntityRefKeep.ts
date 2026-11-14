/**
 * An update reassigning one ref of an index half that holds two refs' ids (#263): `byAll`'s sort key
 * is `[season, series, teamId, playerId]`, and each row starts as `{ season: "2025", series:
 * "final", teamId: "t1", playerId: "p1" }`.
 *
 * - A plain update reads no row: its index keys are composed from the payload and the key alone,
 *   under the index policy. `.set({ teamId })` leaves the half naming the old team, and
 *   `.set({ season, series, teamId })` truncates it before the player. Giving `playerId` too keys it,
 *   but fetches the player again and rewrites the stored copy. Pinned as 1.41.0 sends them.
 * - `.keepRefs({ playerId })` gives the id for key composition only: nothing is fetched or written
 *   for it, and the write is conditioned on the row holding that player, so a row holding another
 *   fails it (`ConditionalCheckFailed`; in a transaction, `TransactionCancelled`).
 * - An update that reads the row first (`versioned: { retain: true }`, or a unique field changed)
 *   composes each half it touches from the refs the row holds, as a `put` of the row would. Up to
 *   1.41.0 it read their ids as missing and truncated a half holding one. A half it doesn't touch
 *   stays as stored (`RefIdPrimaryKey.test.ts`). Unversioned, each ref so read is guarded by its id
 *   as read, so a ref reassigned between the read and the write fails the update.
 *
 * One suite, run on a recording table (`EntityRefKeys.test.ts`) and against DynamoDB Local
 * (`connected.entity-ref-keys.test.ts`), with their harnesses.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Effect, Exit, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { DynamoClient } from "../../src/DynamoClient.js"
import * as Entity from "../../src/Entity.js"
import * as Table from "../../src/Table.js"
import * as Transaction from "../../src/Transaction.js"
import type { Harness } from "./EntityRefKeys.js"

type Row = Record<string, AttributeValue>
type Sent = { readonly command: string; readonly input: any }

const schema = DynamoSchema.make({ name: "keep", version: 1 })
const byId = {
  pk: { field: "pk", composite: ["id"] },
  sk: { field: "sk", composite: [] },
} as const

class Team extends Schema.Class<Team>("KeepTeam")({ id: Schema.String, name: Schema.String }) {}
class Player extends Schema.Class<Player>("KeepPlayer")({
  id: Schema.String,
  name: Schema.String,
}) {}
class Selection extends Schema.Class<Selection>("KeepSelection")({
  id: Schema.String,
  season: Schema.String,
  series: Schema.String,
  team: Team,
  player: Player,
  code: Schema.optionalKey(Schema.String),
}) {}

/**
 * `plain` reads no row to update one; `retain` and `unique` (an optional unique `code`, unversioned)
 * read it first.
 */
type Mode = "plain" | "retain" | "unique"

const entities = (mode: Mode) => {
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
    indexes: {
      byTeam: {
        name: "gsi1",
        pk: { field: "gsi1pk", composite: ["teamId"] },
        sk: { field: "gsi1sk", composite: ["season"] },
      },
      byAll: {
        name: "gsi2",
        pk: { field: "gsi2pk", composite: [] },
        sk: { field: "gsi2sk", composite: ["season", "series", "teamId", "playerId"] },
      },
    },
    refs: { team: { entity: Teams }, player: { entity: Players } },
    ...(mode === "retain" ? { versioned: { retain: true } } : {}),
    ...(mode === "unique" ? { unique: { code: ["code"] } } : {}),
  } as never) as any
  return { Teams, Players, Selections }
}

const prefix = "$keep#v1#selection"
const key = (rest: string) => `${prefix}#${rest}`
const started = key("season_2025#series_final#teamid_t1#playerid_p1")
const reassigned = key("season_2025#series_final#teamid_t2#playerid_p1")

/** On a fresh table: teams t1 and t2, player p1, and `body` with the steps it takes. */
const onTable = (
  harness: Harness,
  mode: Mode,
  body: (t: {
    readonly db: any
    readonly Selections: any
    /** Run `op`, with the requests it sent. */
    readonly step: (op: any) => Effect.Effect<{ exit: Exit.Exit<any, any>; sent: Array<Sent> }>
    /** A selection created as each row starts. */
    readonly fresh: (id: string) => Effect.Effect<void, unknown>
    /** The selection's stored row. */
    readonly row: (id: string) => Effect.Effect<Row>
    /** Run `op(db)` as `step` does, with `between` run once after it first reads a selection. */
    readonly racing: (
      op: (db: any) => any,
      between: any,
    ) => Effect.Effect<{ exit: Exit.Exit<any, any>; sent: Array<Sent> }>
  }) => Effect.Effect<void, unknown>,
) =>
  harness.onTable((tableName) =>
    Effect.gen(function* () {
      const { Teams, Players, Selections } = entities(mode)
      const Main = Table.make({ schema, entities: { Teams, Players, Selections } } as never) as any
      const exec = <A, E>(op: any): Effect.Effect<A, E> =>
        harness.provide(tableName, Main, typeof op.asEffect === "function" ? op.asEffect() : op)
      const db: any = yield* exec(
        DynamoClient.make({ entities: { Teams, Players, Selections }, tables: { Main } } as never),
      )
      yield* exec(db.entities.Teams.put({ id: "t1", name: "Team One" }))
      yield* exec(db.entities.Teams.put({ id: "t2", name: "Team Two" }))
      yield* exec(db.entities.Players.put({ id: "p1", name: "Player One" }))
      const step = (op: any) =>
        Effect.gen(function* () {
          yield* harness.requests(tableName)
          const exit = yield* Effect.exit(exec(op))
          return { exit, sent: [...(yield* harness.requests(tableName))] as Array<Sent> }
        })
      const fresh = (id: string) =>
        exec<void, unknown>(
          db.entities.Selections.create({
            id,
            season: "2025",
            series: "final",
            teamId: "t1",
            playerId: "p1",
          }),
        )
      const row = (id: string) =>
        Effect.map(
          harness.rows(tableName),
          (rows) => rows.find((r) => r.pk?.S === key(`id_${id}`) && r.sk?.S === prefix)!,
        )
      const racing = (op: (db: any) => any, between: any) =>
        step(
          Effect.gen(function* () {
            const raw = yield* DynamoClient
            let ran = false
            const client = new Proxy(raw, {
              get: (target, property, receiver) =>
                property === "getItem"
                  ? (input: any) =>
                      Effect.tap(raw.getItem(input), () => {
                        if (ran || input.Key?.sk?.S !== prefix) return Effect.void
                        ran = true
                        return exec(between)
                      })
                  : Reflect.get(target, property, receiver),
            })
            const raced: any = yield* DynamoClient.make({
              entities: { Teams, Players, Selections },
              tables: { Main },
            } as never).pipe(Effect.provideService(DynamoClient, client))
            const target = op(raced)
            return yield* typeof target.asEffect === "function" ? target.asEffect() : target
          }),
        )
      yield* body({ db, Selections, step, fresh, row, racing })
    }),
  )

const commands = (sent: ReadonlyArray<Sent>) => sent.map((request) => request.command)
const failure = (exit: Exit.Exit<any, any>) =>
  Exit.isFailure(exit)
    ? (exit.cause.reasons.find((reason) => reason._tag === "Fail") as any)?.error
    : undefined
/** The player the row's stored copy names. */
const copied = (row: Row) => row.player?.M?.name?.S

export const suite = (
  harness: Harness,
  describeIt: (name: string, body: () => void) => void = describe,
) =>
  describeIt("an update reassigning one ref of an index half holding two refs' ids (#263)", () => {
    it("a plain update composes the half under the index policy, as 1.41.0 did", () =>
      Effect.runPromise(
        onTable(harness, "plain", ({ db, step, fresh, row }) =>
          Effect.gen(function* () {
            const S = db.entities.Selections
            // A: the half holds no composite the payload gives but `teamId`: kept as stored.
            yield* fresh("a")
            const a = yield* step(S.update({ id: "a" }).set({ teamId: "t2" }))
            expect(commands(a.sent)).toEqual(["GetItem", "UpdateItem"])
            expect((yield* row("a")).gsi1pk).toEqual({ S: key("teamid_t2") })
            expect((yield* row("a")).gsi2sk).toEqual({ S: started })

            // B: the leading composites given, the player not: truncated before it.
            yield* fresh("b")
            const b = yield* step(
              S.update({ id: "b" }).set({ season: "2025", series: "final", teamId: "t2" }),
            )
            expect(b.sent[1]).toEqual({
              command: "UpdateItem",
              input: {
                TableName: "<table>",
                Key: { pk: { S: key("id_b") }, sk: { S: prefix } },
                UpdateExpression:
                  "SET #u0 = :u0, #u1 = :u1, #u2 = :u2, #u3 = :u3, #u4 = :u4, #u5 = :u5, #u6 = :u6",
                ExpressionAttributeNames: {
                  "#u0": "season",
                  "#u1": "series",
                  "#u2": "team",
                  "#u3": "gsi1pk",
                  "#u4": "gsi1sk",
                  "#u5": "gsi2pk",
                  "#u6": "gsi2sk",
                  "#exists": "pk",
                },
                ExpressionAttributeValues: {
                  ":u0": { S: "2025" },
                  ":u1": { S: "final" },
                  ":u2": { M: { id: { S: "t2" }, name: { S: "Team Two" } } },
                  ":u3": { S: key("teamid_t2") },
                  ":u4": { S: key("season_2025") },
                  ":u5": { S: prefix },
                  ":u6": { S: key("season_2025#series_final#teamid_t2") },
                },
                ConditionExpression: "attribute_exists(#exists)",
                ReturnValuesOnConditionCheckFailure: "ALL_OLD",
                ReturnValues: "ALL_NEW",
              },
            })

            // C: the player's id given too keys the half, and re-copies the player as it is now.
            yield* fresh("c")
            yield* step(db.entities.Players.update({ id: "p1" }).set({ name: "Renamed" }))
            const c = yield* step(
              S.update({ id: "c" }).set({
                season: "2025",
                series: "final",
                teamId: "t2",
                playerId: "p1",
              }),
            )
            expect(commands(c.sent)).toEqual(["GetItem", "GetItem", "UpdateItem"])
            expect((yield* row("c")).gsi2sk).toEqual({ S: reassigned })
            expect(copied(yield* row("c"))).toBe("Renamed")
          }),
        ),
      ))

    it(".keepRefs() keys the half from the kept id, fetching and re-copying nothing", () =>
      Effect.runPromise(
        onTable(harness, "plain", ({ db, step, fresh, row }) =>
          Effect.gen(function* () {
            const S = db.entities.Selections
            yield* fresh("e")
            yield* fresh("f")
            yield* step(db.entities.Players.update({ id: "p1" }).set({ name: "Renamed" }))
            const e = yield* step(
              S.update({ id: "e" })
                .set({ season: "2025", series: "final", teamId: "t2" })
                .keepRefs({ playerId: "p1" }),
            )
            expect(Exit.isSuccess(e.exit)).toBe(true)
            // One fetch, of the team; no read of the row, one write.
            expect(commands(e.sent)).toEqual(["GetItem", "UpdateItem"])
            expect(e.sent[0]!.input.Key.pk).toEqual({ S: "$keep#v1#team#id_t2" })
            // B's request, the half composed whole and the guard added: no `player` is written.
            const write = e.sent[1]!.input
            expect(write.UpdateExpression).toBe(
              "SET #u0 = :u0, #u1 = :u1, #u2 = :u2, #u3 = :u3, #u4 = :u4, #u5 = :u5, #u6 = :u6",
            )
            expect(write.ExpressionAttributeNames).toEqual({
              "#u0": "season",
              "#u1": "series",
              "#u2": "team",
              "#u3": "gsi1pk",
              "#u4": "gsi1sk",
              "#u5": "gsi2pk",
              "#u6": "gsi2sk",
              "#e0": "player",
              "#e1": "id",
              "#exists": "pk",
            })
            expect(write.ExpressionAttributeValues[":u6"]).toEqual({ S: reassigned })
            expect(write.ExpressionAttributeValues[":e2"]).toEqual({ S: "p1" })
            expect(write.ConditionExpression).toBe("(#e0.#e1 = :e2) AND attribute_exists(#exists)")
            const stored = yield* row("e")
            expect(stored.gsi2sk).toEqual({ S: reassigned })
            expect(copied(stored)).toBe("Player One")
            expect(e.exit).toMatchObject({ value: { player: { name: "Player One" } } })

            // A row holding another player fails the guard, and nothing is written.
            const before = yield* row("f")
            const f = yield* step(
              S.update({ id: "f" })
                .set({ season: "2025", series: "final", teamId: "t2" })
                .keepRefs({ playerId: "p9" }),
            )
            expect(failure(f.exit)?._tag).toBe("ConditionalCheckFailed")
            expect(commands(f.sent)).toEqual(["GetItem", "UpdateItem"])
            expect(yield* row("f")).toEqual(before)
          }),
        ),
      ))

    it("a retain update composes the half from the refs the row holds", () =>
      Effect.runPromise(
        onTable(harness, "retain", ({ db, step, fresh, row }) =>
          Effect.gen(function* () {
            const S = db.entities.Selections
            // `.set({ teamId })` alone: the rest of the half is the row's. 1.41.0 truncated it to
            // `…#teamid_t2`.
            yield* fresh("a")
            const a = yield* step(S.update({ id: "a" }).set({ teamId: "t2" }))
            expect(commands(a.sent)).toEqual(["GetItem", "GetItem", "TransactWriteItems"])
            expect((yield* row("a")).gsi2sk).toEqual({ S: reassigned })
            expect(copied(yield* row("a"))).toBe("Player One")
            // A write giving no ref: 1.41.0 truncated it to `…#season_2026#series_final`.
            yield* fresh("s")
            yield* step(S.update({ id: "s" }).set({ season: "2026" }))
            expect((yield* row("s")).gsi2sk).toEqual({
              S: key("season_2026#series_final#teamid_t1#playerid_p1"),
            })

            // `.keepRefs()` guards the write here too.
            yield* fresh("e")
            yield* step(db.entities.Players.update({ id: "p1" }).set({ name: "Renamed" }))
            const e = yield* step(
              S.update({ id: "e" }).set({ teamId: "t2" }).keepRefs({ playerId: "p1" }),
            )
            expect(commands(e.sent)).toEqual(["GetItem", "GetItem", "TransactWriteItems"])
            const update = e.sent[2]!.input.TransactItems[0].Update
            expect(update.ConditionExpression).toContain("(#e0.#e1 = :e2)")
            expect((yield* row("e")).gsi2sk).toEqual({ S: reassigned })
            expect(copied(yield* row("e"))).toBe("Player One")
            yield* fresh("f")
            const before = yield* row("f")
            const f = yield* step(
              S.update({ id: "f" }).set({ teamId: "t2" }).keepRefs({ playerId: "p9" }),
            )
            expect(failure(f.exit)?._tag).toBe("ConditionalCheckFailed")
            expect(yield* row("f")).toEqual(before)
          }),
        ),
      ))

    it("an unversioned update that reads the row guards each ref it keys a half from, as read", () =>
      Effect.runPromise(
        onTable(harness, "unique", ({ db, step, fresh, row, racing }) =>
          Effect.gen(function* () {
            const S = db.entities.Selections
            // Changing the unique `code` reads the row. Each ref's id the update doesn't give is
            // the row's, and guarded by the id in the stored ref: a guard on `teamId` would hold
            // whatever the row's team is, as the row stores no such attribute.
            yield* fresh("u")
            const u = yield* step(S.update({ id: "u" }).set({ season: "2026", code: "c1" }))
            expect(Exit.isSuccess(u.exit)).toBe(true)
            expect(commands(u.sent)).toEqual(["GetItem", "TransactWriteItems"])
            const update = u.sent[1]!.input.TransactItems[0].Update
            expect(update.ConditionExpression).toBe(
              "attribute_exists(#pk) AND #g0 = :g0 AND #g1.#g1k = :g1 AND #g2.#g2k = :g2 " +
                "AND attribute_not_exists(#g3)",
            )
            expect(update.ExpressionAttributeNames).toMatchObject({
              "#g0": "series",
              "#g1": "team",
              "#g1k": "id",
              "#g2": "player",
              "#g2k": "id",
              "#g3": "code",
            })
            expect(update.ExpressionAttributeValues).toMatchObject({
              ":g0": { S: "final" },
              ":g1": { S: "t1" },
              ":g2": { S: "p1" },
            })
            expect((yield* row("u")).gsi2sk).toEqual({
              S: key("season_2026#series_final#teamid_t1#playerid_p1"),
            })

            // The team reassigned (keyed whole) between the update's read and its write: the guard
            // fails, nothing is written, and no key names the team the update read.
            yield* fresh("v")
            const v = yield* racing(
              (raced) =>
                raced.entities.Selections.update({ id: "v" }).set({ season: "2026", code: "c2" }),
              S.update({ id: "v" })
                .set({ season: "2025", series: "final", teamId: "t2" })
                .keepRefs({ playerId: "p1" }),
            )
            // The row read; the team fetched and the row written by the other writer; this write.
            expect(commands(v.sent)).toEqual([
              "GetItem",
              "GetItem",
              "UpdateItem",
              "TransactWriteItems",
            ])
            expect(failure(v.exit)).toMatchObject({
              _tag: "ConcurrentModification",
              attributes: ["team"],
            })
            const stored = yield* row("v")
            expect(stored.team?.M?.id).toEqual({ S: "t2" })
            expect(stored.gsi1pk).toEqual({ S: key("teamid_t2") })
            expect(stored.gsi2sk).toEqual({ S: reassigned })
          }),
        ),
      ))

    it("in a transaction, .keepRefs() keys the half, and a row holding another player cancels it", () =>
      Effect.runPromise(
        onTable(harness, "plain", ({ db, Selections, step, fresh, row }) =>
          Effect.gen(function* () {
            yield* fresh("g")
            yield* fresh("h")
            yield* step(db.entities.Players.update({ id: "p1" }).set({ name: "Renamed" }))
            // The pipeable form, as an unbound op.
            const g = yield* step(
              Transaction.transactWrite([
                Selections.update({ id: "g" }).pipe(
                  Entity.set({ season: "2025", series: "final", teamId: "t2" }),
                  Entity.keepRefs({ playerId: "p1" }),
                ),
              ]),
            )
            expect(Exit.isSuccess(g.exit)).toBe(true)
            expect((yield* row("g")).gsi2sk).toEqual({ S: reassigned })
            expect(copied(yield* row("g"))).toBe("Player One")

            const before = yield* row("h")
            const h = yield* step(
              Transaction.transactWrite([
                db.entities.Selections.update({ id: "h" })
                  .set({ season: "2025", series: "final", teamId: "t2" })
                  .keepRefs({ playerId: "p9" }),
              ]),
            )
            expect(failure(h.exit)?._tag).toBe("TransactionCancelled")
            expect(commands(h.sent).at(-1)).toBe("TransactWriteItems")
            expect(yield* row("h")).toEqual(before)
          }),
        ),
      ))

    it("refuses a name that is no ref id, and a ref the same update reassigns, sending nothing", () =>
      Effect.runPromise(
        onTable(harness, "plain", ({ db, step, fresh }) =>
          Effect.gen(function* () {
            const S = db.entities.Selections
            yield* fresh("r")
            const named = yield* step(S.update({ id: "r" }).keepRefs({ season: "2025" }))
            expect(failure(named.exit)).toMatchObject({
              _tag: "ValidationError",
              operation: "update.keepRefs",
            })
            expect(String(failure(named.exit).cause)).toContain("[EDD-9166]")
            const both = yield* step(
              S.update({ id: "r" }).set({ playerId: "p1" }).keepRefs({ playerId: "p1" }),
            )
            expect(String(failure(both.exit).cause)).toContain("[EDD-9167]")
            expect([...named.sent, ...both.sent]).toEqual([])
          }),
        ),
      ))
  })
