/**
 * A ref the model declares nullable (`team: Schema.NullOr(Team)` configured `{ ref: true }`, or
 * `DynamoModel.ref(Schema.NullOr(Team))`) behaves as an optional ref does, with `null` stored and
 * read where the optional form stores nothing. Up to 1.42.1 such a ref wrote and read a non-null id
 * only: its id took no `null` (`put` failed `Expected string at ["teamId"]`), and a row holding
 * `null` failed every read (`Expected object`).
 *
 * - `put` / `create` / `upsert` take `teamId: null`: nothing is fetched, the row stores `team` as
 *   `NULL`, and an index half or unique constraint over `teamId` takes it as an optional ref's
 *   absent id (no key, no sentinel).
 * - `.set({ teamId })` attaches the ref, as for an optional ref; `.set({ teamId: null })` detaches
 *   it as `.remove(["team"])` detaches an optional one (the index key composed from the id goes,
 *   the sentinel is released), storing `NULL`.
 * - A `Schema.UndefinedOr` ref's id is a required key that takes `undefined`, which stores none.
 * - A primary key composed from a nullable ref's id writes and reads a non-null id as 1.42.1 did;
 *   a write giving `null` or no id is refused before anything is sent (`EDD-9169`).
 *
 * Also: a whole ref written below refs declared nullable, three levels down, is stored in its
 * entity's storage. Up to 1.42.1 such a write was refused in epoch storage.
 *
 * One suite, run on a recording table (`EntityRefKeys.test.ts`) and against DynamoDB Local
 * (`connected.entity-ref-keys.test.ts`), with their harnesses.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { DateTime, Effect, Exit, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Aggregate from "../../src/Aggregate.js"
import { DynamoClient } from "../../src/DynamoClient.js"
import * as Entity from "../../src/Entity.js"
import * as Table from "../../src/Table.js"
import * as Transaction from "../../src/Transaction.js"
import type { Harness } from "./EntityRefKeys.js"

type Row = Record<string, AttributeValue>
type Sent = { readonly command: string; readonly input: any }
type Step = { readonly exit: Exit.Exit<any, any>; readonly sent: ReadonlyArray<Sent> }

const schema = DynamoSchema.make({ name: "nullref", version: 1 })
const byId = {
  pk: { field: "pk", composite: ["id"] },
  sk: { field: "sk", composite: [] },
} as const
const byTeam = {
  name: "gsi1",
  pk: { field: "gsi1pk", composite: ["teamId"] },
  sk: { field: "gsi1sk", composite: [] },
} as const

/** How the player's model declares its ref: optional (the reference), or nullable either way. */
type Form = "optional" | "configure" | "model"

class Team extends Schema.Class<Team>("NullRefTeam")({
  id: Schema.String,
  name: Schema.String,
}) {}

const makeTeams = () =>
  Entity.make({
    model: DynamoModel.configure(Team, { id: { identifier: true } }),
    entityType: "Team",
    primaryKey: byId,
  } as never) as any

/** The members of {@link entities}' table. */
const members = (form: Form, unique = false) => {
  const { Teams, Players } = entities(form, unique)
  return { Teams, Players }
}

/** Team → player, the player's ref declared `form`, with an index keyed by the team's id. */
const entities = (form: Form, unique = false) => {
  const Teams = makeTeams()
  const team =
    form === "optional"
      ? Schema.optionalKey(Team)
      : form === "configure"
        ? Schema.NullOr(Team)
        : DynamoModel.ref(Schema.NullOr(Team))
  class Player extends Schema.Class<Player>(`NullRef${form}Player`)({
    id: Schema.String,
    nick: Schema.String,
    team: team as unknown as typeof Team,
  }) {}
  const Players = Entity.make({
    model: DynamoModel.configure(Player, {
      id: { identifier: true },
      ...(form === "model" ? {} : { team: { ref: true } }),
    } as never),
    entityType: "Player",
    primaryKey: byId,
    indexes: { byTeam },
    ...(unique ? { unique: { oneTeam: ["teamId"] } } : {}),
    refs: { team: { entity: Teams } },
  } as never) as any
  return { Teams, Players, Player }
}

const failure = (exit: Exit.Exit<any, any>) =>
  Exit.isFailure(exit)
    ? (exit.cause.reasons.find((reason) => reason._tag === "Fail") as any)?.error
    : undefined
const outcome = (exit: Exit.Exit<any, any>) =>
  Exit.isSuccess(exit)
    ? { ok: JSON.parse(JSON.stringify(exit.value ?? null)) }
    : { failed: failure(exit)?._tag ?? String(exit.cause) }

/** Run `body` on a fresh table, with the entities bound and steps that record what they send. */
const onTable = <A>(
  harness: Harness,
  members: Record<string, any>,
  body: (t: {
    readonly db: any
    readonly exec: (op: any) => Effect.Effect<any, any>
    readonly step: (op: any) => Effect.Effect<Step>
    readonly rows: Effect.Effect<ReadonlyArray<Row>>
  }) => Effect.Effect<A, unknown>,
  aggregates: Record<string, (main: any) => any> = {},
) =>
  harness.onTable((tableName) =>
    Effect.gen(function* () {
      const Main = Table.make({ schema, entities: members } as never) as any
      const bound = Object.fromEntries(
        Object.entries(aggregates).map(([name, make]) => [name, make(Main)]),
      )
      const exec = (op: any): Effect.Effect<any, any> =>
        harness.provide(tableName, Main, typeof op.asEffect === "function" ? op.asEffect() : op)
      const db: any = yield* exec(
        DynamoClient.make({ entities: members, aggregates: bound, tables: { Main } } as never),
      )
      const step = (op: any) =>
        Effect.gen(function* () {
          yield* harness.requests(tableName)
          const exit = yield* Effect.exit(exec(op))
          return { exit, sent: [...(yield* harness.requests(tableName))] }
        })
      return yield* body({ db, exec, step, rows: harness.rows(tableName) })
    }),
  )

const PLAYER = "$nullref#v1#player"
const key = (id: string) => ({ pk: { S: `${PLAYER}#id_${id}` }, sk: { S: PLAYER } })
const lions = { M: { id: { S: "t2" }, name: { S: "Lions" } } }
const lionsT1 = { M: { id: { S: "t1" }, name: { S: "Lions" } } }

/**
 * Teams t1 and t2, player p1 on t1; then p2 is put without a team (left out, or `null`), read,
 * attached to t2, and detached (`.remove(["team"])`, or `.set({ teamId: null })`), with the index
 * keyed by the team queried along the way.
 */
const rounds = (harness: Harness, form: Form) => {
  const { Teams, Players } = entities(form)
  return onTable(harness, { Teams, Players }, ({ db, exec, step, rows }) =>
    Effect.gen(function* () {
      const P = db.entities.Players
      yield* exec(db.entities.Teams.put({ id: "t1", name: "Tigers" }))
      yield* exec(db.entities.Teams.put({ id: "t2", name: "Lions" }))
      yield* exec(P.put({ id: "p1", nick: "a", teamId: "t1" }))
      const steps = {
        put: yield* step(
          P.put({ id: "p2", nick: "b", ...(form === "optional" ? {} : { teamId: null }) }),
        ),
        get: yield* step(P.get({ id: "p2" })),
        query: yield* step(P.byTeam({ teamId: "t1" }).collect()),
        attach: yield* step(P.update({ id: "p2" }).set({ teamId: "t2" })),
        attached: yield* step(P.byTeam({ teamId: "t2" }).collect()),
        detach: yield* step(
          form === "optional"
            ? P.update({ id: "p2" }).remove(["team"])
            : P.update({ id: "p2" }).set({ teamId: null }),
        ),
        detached: yield* step(P.byTeam({ teamId: "t2" }).collect()),
        after: yield* step(P.get({ id: "p2" })),
      }
      const row = (yield* rows).find((r) => r.pk?.S === `${PLAYER}#id_p2`)!
      return { steps, row }
    }),
  )
}

/** The requests 1.42.1 sends for the optional form, which a nullable ref doesn't change. */
const optionalPins = {
  put: [
    {
      command: "PutItem",
      input: {
        TableName: "<table>",
        Item: { id: { S: "p2" }, nick: { S: "b" }, __edd_e__: { S: "Player" }, ...key("p2") },
      },
    },
  ],
  attach: [
    {
      command: "GetItem",
      input: {
        TableName: "<table>",
        Key: { pk: { S: "$nullref#v1#team#id_t2" }, sk: { S: "$nullref#v1#team" } },
      },
    },
    {
      command: "UpdateItem",
      input: {
        TableName: "<table>",
        Key: key("p2"),
        UpdateExpression: "SET #u0 = :u0, #u1 = :u1, #u2 = :u2",
        ConditionExpression: "attribute_exists(#exists)",
        ExpressionAttributeNames: {
          "#u0": "team",
          "#u1": "gsi1pk",
          "#u2": "gsi1sk",
          "#exists": "pk",
        },
        ExpressionAttributeValues: {
          ":u0": lions,
          ":u1": { S: "$nullref#v1#player#teamid_t2" },
          ":u2": { S: PLAYER },
        },
        ReturnValues: "ALL_NEW",
        ReturnValuesOnConditionCheckFailure: "ALL_OLD",
      },
    },
  ],
  attached: [
    {
      command: "Query",
      input: {
        TableName: "<table>",
        IndexName: "gsi1",
        KeyConditionExpression: "#pk = :pk",
        ExpressionAttributeNames: { "#pk": "gsi1pk", "#eddE": "__edd_e__" },
        ExpressionAttributeValues: {
          ":pk": { S: "$nullref#v1#player#teamid_t2" },
          ":et0": { S: "Player" },
        },
        FilterExpression: "#eddE IN (:et0)",
        ScanIndexForward: true,
      },
    },
  ],
  detach: [
    {
      command: "UpdateItem",
      input: {
        TableName: "<table>",
        Key: key("p2"),
        UpdateExpression: "SET #u0 = :u0 REMOVE #r0, #r1",
        ConditionExpression: "attribute_exists(#exists)",
        ExpressionAttributeNames: {
          "#u0": "gsi1sk",
          "#r0": "team",
          "#r1": "gsi1pk",
          "#exists": "pk",
        },
        ExpressionAttributeValues: { ":u0": { S: PLAYER } },
        ReturnValues: "ALL_NEW",
        ReturnValuesOnConditionCheckFailure: "ALL_OLD",
      },
    },
  ],
} as const

export const suite = (
  harness: Harness,
  describeIt: (name: string, body: () => void) => void = describe,
) =>
  describeIt("a ref the model declares nullable", () => {
    it("is put null, read, attached, queried and detached as an optional ref is, holding null", () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const optional = yield* rounds(harness, "optional")
          // The optional form sends what 1.42.1 sent.
          for (const name of ["put", "attach", "attached", "detach"] as const) {
            expect({ name, sent: optional.steps[name].sent }).toEqual({
              name,
              sent: optionalPins[name],
            })
          }
          const configured = yield* rounds(harness, "configure")
          const declared = yield* rounds(harness, "model")
          // Request for request and answer for answer, the two declarations are one.
          for (const name of Object.keys(configured.steps) as Array<
            keyof typeof configured.steps
          >) {
            expect(declared.steps[name].sent).toEqual(configured.steps[name].sent)
            expect(outcome(declared.steps[name].exit)).toEqual(outcome(configured.steps[name].exit))
          }
          expect(declared.row).toEqual(configured.row)
          const { steps, row } = configured
          // Put with `null`: nothing fetched, the ref stored as NULL, no key of the team's index.
          expect(steps.put.sent).toEqual([
            {
              command: "PutItem",
              input: {
                TableName: "<table>",
                Item: {
                  id: { S: "p2" },
                  nick: { S: "b" },
                  team: { NULL: true },
                  __edd_e__: { S: "Player" },
                  ...key("p2"),
                },
              },
            },
          ])
          expect(outcome(steps.get.exit)).toEqual({ ok: { id: "p2", nick: "b", team: null } })
          // The index keyed by the team holds the players that have one, as for an optional ref.
          expect(steps.query.sent).toEqual(optional.steps.query.sent)
          expect(outcome(steps.query.exit)).toEqual(outcome(optional.steps.query.exit))
          // Attached as an optional ref is.
          expect(steps.attach.sent).toEqual(optionalPins.attach)
          expect(steps.attached.sent).toEqual(optionalPins.attached)
          expect(outcome(steps.attached.exit)).toEqual({
            ok: [{ id: "p2", nick: "b", team: { id: "t2", name: "Lions" } }],
          })
          // Detached by `null`: as `.remove(["team"])`, the ref stored as NULL.
          expect(steps.detach.sent).toEqual([
            {
              command: "UpdateItem",
              input: {
                TableName: "<table>",
                Key: key("p2"),
                UpdateExpression: "SET #u0 = :u0, #u1 = :u1 REMOVE #r0",
                ConditionExpression: "attribute_exists(#exists)",
                ExpressionAttributeNames: {
                  "#u0": "team",
                  "#u1": "gsi1sk",
                  "#r0": "gsi1pk",
                  "#exists": "pk",
                },
                ExpressionAttributeValues: { ":u0": { NULL: true }, ":u1": { S: PLAYER } },
                ReturnValues: "ALL_NEW",
                ReturnValuesOnConditionCheckFailure: "ALL_OLD",
              },
            },
          ])
          expect(outcome(steps.detached.exit)).toEqual({ ok: [] })
          expect(outcome(steps.after.exit)).toEqual({ ok: { id: "p2", nick: "b", team: null } })
          expect(row.team).toEqual({ NULL: true })
          expect(row).not.toHaveProperty("gsi1pk")
          expect(optional.row).not.toHaveProperty("team")
          expect(optional.row).not.toHaveProperty("gsi1pk")
        }),
      ))

    it("a unique constraint over its id takes null as no id: attach reserves, detach releases", () =>
      Effect.runPromise(
        onTable(harness, members("configure", true), ({ db, exec, step, rows }) =>
          Effect.gen(function* () {
            const P = db.entities.Players
            yield* exec(db.entities.Teams.put({ id: "t2", name: "Lions" }))
            const nulls = [
              yield* step(P.put({ id: "p2", nick: "b", teamId: null })),
              yield* step(P.put({ id: "p3", nick: "c", teamId: null })),
            ]
            for (const put of nulls) expect(Exit.isSuccess(put.exit)).toBe(true)
            const sentinels = () =>
              Effect.map(rows, (all) =>
                all
                  .filter((r) => r.pk?.S?.startsWith(`${PLAYER}.oneteam#`))
                  .map((r) => [r.pk!.S, r._entity_pk?.S]),
              )
            expect(yield* sentinels()).toEqual([])
            yield* exec(P.update({ id: "p2" }).set({ teamId: "t2" }))
            expect(yield* sentinels()).toEqual([[`${PLAYER}.oneteam#t2`, `${PLAYER}#id_p2`]])
            const taken = yield* step(P.update({ id: "p3" }).set({ teamId: "t2" }))
            expect(failure(taken.exit)?._tag).toBe("UniqueConstraintViolation")
            const detached = yield* step(P.update({ id: "p2" }).set({ teamId: null }))
            expect(outcome(detached.exit)).toEqual({ ok: { id: "p2", nick: "b", team: null } })
            expect(yield* sentinels()).toEqual([])
            yield* exec(P.update({ id: "p3" }).set({ teamId: "t2" }))
            expect(yield* sentinels()).toEqual([[`${PLAYER}.oneteam#t2`, `${PLAYER}#id_p3`]])
          }),
        ),
      ))

    it("a transactWrite update detaches it as the update alone does; a transactWrite put is refused as before", () =>
      Effect.runPromise(
        onTable(harness, members("configure"), ({ db, exec, step, rows }) =>
          Effect.gen(function* () {
            const P = db.entities.Players
            yield* exec(db.entities.Teams.put({ id: "t1", name: "Tigers" }))
            yield* exec(P.put({ id: "p1", nick: "a", teamId: "t1" }))
            const write = yield* step(
              Transaction.transactWrite([P.update({ id: "p1" }).set({ teamId: null })]),
            )
            if (Exit.isFailure(write.exit)) throw write.exit
            const row = (yield* rows).find((r) => r.pk?.S === `${PLAYER}#id_p1`)!
            expect(row.team).toEqual({ NULL: true })
            expect(row).not.toHaveProperty("gsi1pk")
            // A ref entity's put can't be planned in a transaction (its ref is hydrated by a read).
            const put = yield* step(
              Transaction.transactWrite([P.put({ id: "p2", nick: "b", teamId: null })]),
            )
            expect(failure(put.exit)?._tag).toBe("ValidationError")
            expect(put.sent).toEqual([])
          }),
        ),
      ))

    it("an aggregate edge holding a player without a team stores and reads null", () =>
      Effect.runPromise(
        Effect.gen(function* () {
          // Up to 1.42.1 the player's read refused the null, so the aggregate's create failed.
          const { Teams, Players, Player } = entities("configure")
          class Lineup extends Schema.Class<Lineup>("NullRefLineup")({
            id: Schema.String,
            player: DynamoModel.ref(Player as unknown as typeof Team),
          }) {}
          const Lineups = (main: any) =>
            Aggregate.make(Lineup, {
              table: main,
              schema,
              pk: { field: "pk", composite: ["id"] },
              collection: { name: "lineup" },
              root: { entityType: "Lineup" },
              edges: { player: Aggregate.one({ entityType: "LineupPlayer", entity: Players }) },
            } as never)
          yield* onTable(
            harness,
            { Teams, Players },
            ({ db, exec, rows }) =>
              Effect.gen(function* () {
                yield* exec(db.entities.Players.put({ id: "p0", nick: "z", teamId: null }))
                const made = yield* exec(db.aggregates.Lineups.create({ id: "l0", playerId: "p0" }))
                expect(made.player.team).toBeNull()
                const edge = (yield* rows).find((r) => r.__edd_e__?.S === "LineupPlayer")!
                expect(edge.team).toEqual({ NULL: true })
                const read = yield* exec(db.aggregates.Lineups.get({ id: "l0" }))
                expect(read.player.team).toBeNull()
              }),
            { Lineups },
          )
        }),
      ))

    it("a Schema.UndefinedOr ref takes undefined, which stores none and reads as undefined", () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const Teams = makeTeams()
          class Player extends Schema.Class<Player>("NullRefUndefinedPlayer")({
            id: Schema.String,
            team: Schema.UndefinedOr(Team),
          }) {}
          const Players = Entity.make({
            model: DynamoModel.configure(Player, { id: { identifier: true }, team: { ref: true } }),
            entityType: "Player",
            primaryKey: byId,
            refs: { team: { entity: Teams } },
          } as never) as any
          yield* onTable(harness, { Teams, Players }, ({ db, step }) =>
            Effect.gen(function* () {
              const put = yield* step(db.entities.Players.put({ id: "u0", teamId: undefined }))
              expect(put.sent.map((sent) => sent.command)).toEqual(["PutItem"])
              expect(put.sent[0]!.input.Item).not.toHaveProperty("team")
              const read = yield* step(db.entities.Players.get({ id: "u0" }))
              expect(outcome(read.exit)).toEqual({ ok: { id: "u0" } })
            }),
          )
        }),
      ))

    it("a primary key composed from its id writes and reads a non-null id as 1.42.1 did; null or none is refused at the write (EDD-9169)", () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const keyed = {
            pk: { field: "pk", composite: ["teamId"] },
            sk: { field: "sk", composite: ["id"] },
          }
          // The model as 1.42.1 took it: an attached team wrote and read. Only `null` failed.
          const Teams = makeTeams()
          class Player extends Schema.Class<Player>("NullRefKeyedPlayer")({
            id: Schema.String,
            nick: Schema.String,
            team: Schema.NullOr(Team).pipe(DynamoModel.ref),
          }) {}
          const Players = Entity.make({
            model: Player,
            entityType: "Player",
            primaryKey: keyed,
            refs: { team: { entity: Teams } },
          } as never) as any
          // An optional ref left out: up to 1.42.1 its write died in key composition.
          class Member extends Schema.Class<Member>("NullRefKeyedMember")({
            id: Schema.String,
            team: Schema.optionalKey(Team),
          }) {}
          const Members = Entity.make({
            model: DynamoModel.configure(Member, { team: { ref: true } }),
            entityType: "Member",
            primaryKey: keyed,
            refs: { team: { entity: Teams } },
          } as never) as any
          yield* onTable(harness, { Teams, Players, Members }, ({ db, step }) =>
            Effect.gen(function* () {
              const P = db.entities.Players
              const team = yield* step(db.entities.Teams.put({ id: "t1", name: "Lions" }))
              const put = yield* step(P.put({ id: "p1", nick: "a", teamId: "t1" }))
              const get = yield* step(P.get({ id: "p1", teamId: "t1" }))
              const playerKey = {
                pk: { S: "$nullref#v1#player#teamid_t1" },
                sk: { S: "$nullref#v1#player#id_p1" },
              }
              const teamKey = { pk: { S: "$nullref#v1#team#id_t1" }, sk: { S: "$nullref#v1#team" } }
              expect([...team.sent, ...put.sent, ...get.sent]).toEqual([
                {
                  command: "PutItem",
                  input: {
                    TableName: "<table>",
                    Item: {
                      id: { S: "t1" },
                      name: { S: "Lions" },
                      __edd_e__: { S: "Team" },
                      ...teamKey,
                    },
                  },
                },
                { command: "GetItem", input: { TableName: "<table>", Key: teamKey } },
                {
                  command: "PutItem",
                  input: {
                    TableName: "<table>",
                    Item: {
                      id: { S: "p1" },
                      nick: { S: "a" },
                      team: lionsT1,
                      __edd_e__: { S: "Player" },
                      ...playerKey,
                    },
                  },
                },
                { command: "GetItem", input: { TableName: "<table>", Key: playerKey } },
              ])
              expect(outcome(get.exit)).toEqual({
                ok: { id: "p1", nick: "a", team: { id: "t1", name: "Lions" } },
              })
              const refusals = [
                yield* step(P.put({ id: "p2", nick: "b", teamId: null })),
                yield* step(P.create({ id: "p2", nick: "b", teamId: null })),
                yield* step(P.upsert({ id: "p2", nick: "b", teamId: null })),
                yield* step(db.entities.Members.put({ id: "m1" })),
                yield* step(db.entities.Members.upsert({ id: "m1" })),
              ]
              for (const refused of refusals) {
                expect(failure(refused.exit)?._tag).toBe("ValidationError")
                expect(String(failure(refused.exit)?.cause)).toMatch(
                  /^\[EDD-9169\] the primary key is composed from "teamId", the id of ref "team", and the write (gives null|leaves it out)/,
                )
                expect(refused.sent).toEqual([])
              }
            }),
          )
        }),
      ))

    it("a whole ref written three levels down, below refs declared nullable, is stored as its entity stores it", () =>
      Effect.runPromise(
        Effect.gen(function* () {
          // Up to 1.42.1 the write was refused in epoch storage: the union on the way was judged in
          // the default storage.
          class Club extends Schema.Class<Club>("NullRefClub")({
            id: Schema.String,
            founded: Schema.DateTimeUtc,
          }) {}
          const level = (name: string, child: Schema.Top, below: any) => {
            const Model = Schema.Class<any>(`NullRef${name}`)({
              id: Schema.String,
              child: Schema.NullOr(child as Schema.Codec<any>),
            })
            const made = Entity.make({
              model: DynamoModel.configure(Model, {
                id: { identifier: true },
                child: { ref: true },
              }),
              entityType: name,
              primaryKey: byId,
              refs: { child: { entity: below } },
            } as never) as any
            return { Model, made }
          }
          const Clubs = Entity.make({
            model: DynamoModel.configure(Club, {
              id: { identifier: true },
              founded: { storedAs: DynamoModel.DateEpochSeconds },
            }),
            entityType: "Club",
            primaryKey: byId,
          } as never) as any
          const one = level("One", Club, Clubs)
          const two = level("Two", one.Model, one.made)
          const three = level("Three", two.Model, two.made)
          const members = { Clubs, Ones: one.made, Twos: two.made, Threes: three.made }
          yield* onTable(harness, members, ({ db, exec, step }) =>
            Effect.gen(function* () {
              const at = (iso: string) => DateTime.makeUnsafe(iso)
              yield* exec(
                db.entities.Clubs.put({ id: "c", founded: at("1990-05-06T07:08:09.000Z") }),
              )
              yield* exec(db.entities.Ones.put({ id: "1", childId: "c" }))
              yield* exec(db.entities.Twos.put({ id: "2", childId: "1" }))
              yield* exec(db.entities.Threes.put({ id: "3", childId: "2" }))
              const moved = at("1991-01-01T00:00:00.000Z")
              const set = yield* step(
                db.entities.Threes.update({ id: "3" }).pathSet({
                  segments: ["child", "child", "child"],
                  value: new Club({ id: "c", founded: moved }),
                }),
              )
              if (Exit.isFailure(set.exit)) throw set.exit
              const values = Object.values(set.sent.at(-1)!.input.ExpressionAttributeValues)
              expect(values).toEqual([{ M: { id: { S: "c" }, founded: { N: "662688000" } } }])
              const read = yield* exec(db.entities.Threes.get({ id: "3" }))
              expect(DateTime.toEpochMillis(read.child.child.child.founded)).toBe(
                DateTime.toEpochMillis(moved),
              )
            }),
          )
        }),
      ))
  })
