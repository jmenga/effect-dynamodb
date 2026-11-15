/**
 * A ref whose declared member is a copy of the target's class that changes only its annotations
 * (`Team.annotate({ description })`), or a `Schema.suspend` of it, is held as the class itself is,
 * wherever the ref is declared: beneath a union (`Schema.NullOr`, `Schema.UndefinedOr`, an optional
 * key over one, `DynamoModel.ref` of one), nested in a ref's target, and in an aggregate edge
 * entity's model. Such a copy hides the class's fields, so a walk that took only the class itself
 * for the ref left its dates as declared: reading a row that holds the team failed with
 * `Expected DateTime.Utc at ["team"]["founded"]`, after a `put` had stored it. A union holding no
 * member that is the target's model (another class) is replaced by the target whole, and its id
 * takes no `null`, as in 1.42.1.
 *
 * One suite, run on a recording table (`EntityRefKeys.test.ts`) and against DynamoDB Local
 * (`connected.entity-ref-keys.test.ts`), with their harnesses.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import * as PureEntity from "@effect-dynamodb/schema/Entity.js"
import { DateTime, Effect, Equal, Exit, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Aggregate from "../../src/Aggregate.js"
import { DynamoClient } from "../../src/DynamoClient.js"
import * as Entity from "../../src/Entity.js"
import * as Table from "../../src/Table.js"
import type { Harness } from "./EntityRefKeys.js"

type Row = Record<string, AttributeValue>
type Sent = { readonly command: string; readonly input: any }
type Step = { readonly exit: Exit.Exit<any, any>; readonly sent: ReadonlyArray<Sent> }

const schema = DynamoSchema.make({ name: "annref", version: 1 })
const byId = {
  pk: { field: "pk", composite: ["id"] },
  sk: { field: "sk", composite: [] },
} as const

class Team extends Schema.Class<Team>("AnnRefTeam")({
  id: Schema.String,
  founded: Schema.DateTimeUtc,
}) {}
const annotated = () => Team.annotate({ description: "The player's home team" })

const at = (iso: string) => DateTime.makeUnsafe(iso)
const FOUNDED = "1990-05-06T07:08:09.000Z"
const MOVED = "1991-01-01T00:00:00.000Z"
const seconds = (iso: string): AttributeValue => ({
  N: String(Math.floor(DateTime.toEpochMillis(at(iso)) / 1000)),
})
/** `founded` as 1.42.1 stored it in an aggregate edge row below an edge entity's ref. */
const marshalledDate = (iso: string): AttributeValue => ({
  M: {
    epochMilliseconds: { N: String(DateTime.toEpochMillis(at(iso))) },
    "~effect/DateTime": { S: "~effect/DateTime" },
    _tag: { S: "Utc" },
  },
})

const failure = (exit: Exit.Exit<any, any>) =>
  Exit.isFailure(exit)
    ? (exit.cause.reasons.find((reason) => reason._tag === "Fail") as any)?.error
    : undefined
const outcome = (exit: Exit.Exit<any, any>) =>
  Exit.isSuccess(exit)
    ? { ok: JSON.parse(JSON.stringify(exit.value ?? null)) }
    : { failed: failure(exit)?._tag ?? String(exit.cause) }
const same = (a: unknown, b: unknown) => expect(Equal.equals(a, b)).toBe(true)
const valuesOf = (step: Step) => Object.values(step.sent.at(-1)!.input.ExpressionAttributeValues)

/** Run `body` on a fresh table, with the entities bound and steps that record what they send. */
const onTable = <A>(
  harness: Harness,
  entities: Record<string, any>,
  body: (t: {
    readonly db: any
    readonly exec: (op: any) => Effect.Effect<any, any>
    readonly step: (op: any) => Effect.Effect<Step>
    readonly rows: Effect.Effect<ReadonlyArray<Row>>
    readonly seed: (item: Row) => Effect.Effect<void, unknown>
  }) => Effect.Effect<A, unknown>,
  aggregates: Record<string, (main: any) => any> = {},
) =>
  harness.onTable((tableName) =>
    Effect.gen(function* () {
      const Main = Table.make({ schema, entities } as never) as any
      const bound = Object.fromEntries(
        Object.entries(aggregates).map(([name, make]) => [name, make(Main)]),
      )
      const exec = (op: any): Effect.Effect<any, any> =>
        harness.provide(tableName, Main, typeof op.asEffect === "function" ? op.asEffect() : op)
      const db: any = yield* exec(
        DynamoClient.make({ entities, aggregates: bound, tables: { Main } } as never),
      )
      const step = (op: any) =>
        Effect.gen(function* () {
          yield* harness.requests(tableName)
          const exit = yield* Effect.exit(exec(op))
          return { exit, sent: [...(yield* harness.requests(tableName))] }
        })
      const seed = (item: Row) =>
        exec(
          Effect.gen(function* () {
            const client = yield* DynamoClient
            yield* client.putItem({ TableName: tableName, Item: item })
          }),
        )
      return yield* body({ db, exec, step, rows: harness.rows(tableName), seed })
    }),
  )

/** Teams (`founded` in `storage`), and players whose model declares `team` as `declare` gives it. */
const players = (
  name: string,
  declare: (team: typeof Team) => Schema.Top,
  options: {
    readonly configured?: boolean
    readonly seconds?: boolean
    readonly make?: (config: any) => any
  } = {},
) => {
  const make = options.make ?? Entity.make
  const Teams = make({
    model: DynamoModel.configure(Team, {
      id: { identifier: true },
      ...(options.seconds ? { founded: { storedAs: DynamoModel.DateEpochSeconds } } : {}),
    }),
    entityType: "Team",
    primaryKey: byId,
  } as never) as any
  class Player extends Schema.Class<Player>(`AnnRef${name}Player`)({
    id: Schema.String,
    team: declare(Team) as typeof Team,
  }) {}
  const Players = make({
    model: DynamoModel.configure(Player, {
      id: { identifier: true },
      ...(options.configured === false ? {} : { team: { ref: true } }),
    } as never),
    entityType: "Player",
    primaryKey: byId,
    refs: { team: { entity: Teams } },
  } as never) as any
  return { Teams, Players, Player }
}

const PLAYER = "$annref#v1#player"
const playerKey = (id: string) => ({ pk: { S: `${PLAYER}#id_${id}` }, sk: { S: PLAYER } })
const teamKey = { pk: { S: "$annref#v1#team#id_t1" }, sk: { S: "$annref#v1#team" } }
const heldTeam = { M: { id: { S: "t1" }, founded: { S: FOUNDED } } }

/** What 1.42.1 sent for a player put with `teamId: "t1"`, its ref declared any of these ways. */
const putPins = (id: string) => [
  { command: "GetItem", input: { TableName: "<table>", Key: teamKey } },
  {
    command: "PutItem",
    input: {
      TableName: "<table>",
      Item: { id: { S: id }, team: heldTeam, __edd_e__: { S: "Player" }, ...playerKey(id) },
    },
  },
]

/** The ways a model declares the ref in a union around an annotated copy (or a suspend) of Team. */
const unionForms: ReadonlyArray<{
  readonly name: string
  readonly declare: (team: typeof Team) => Schema.Top
  readonly configured: boolean
  readonly nullable: boolean
}> = [
  { name: "NullOr", declare: () => Schema.NullOr(annotated()), configured: true, nullable: true },
  {
    name: "OptionalKeyNullOr",
    declare: () => Schema.optionalKey(Schema.NullOr(annotated())),
    configured: true,
    nullable: true,
  },
  {
    name: "RefNullOr",
    declare: () => DynamoModel.ref(Schema.NullOr(annotated())),
    configured: false,
    nullable: true,
  },
  {
    name: "UndefinedOr",
    declare: () => Schema.UndefinedOr(annotated()),
    configured: true,
    nullable: false,
  },
  {
    name: "Suspend",
    declare: (team) => Schema.NullOr(Schema.suspend((): typeof Team => team)),
    configured: true,
    nullable: true,
  },
]

/** Selection → player → team, `Player.team` declared as `declare` gives it, configured a ref. */
const chain = (name: string, declare: (team: typeof Team) => Schema.Top) => {
  const { Teams, Players, Player } = players(name, declare, { seconds: true })
  class Selection extends Schema.Class<Selection>(`AnnRef${name}Selection`)({
    id: Schema.String,
    note: Schema.String,
    player: Player,
  }) {}
  const Selections = Entity.make({
    model: DynamoModel.configure(Selection, { id: { identifier: true }, player: { ref: true } }),
    entityType: "Selection",
    primaryKey: byId,
    refs: { player: { entity: Players } },
  } as never) as any
  return { Teams, Players, Selections }
}

const nested = (harness: Harness, name: string, declare: (team: typeof Team) => Schema.Top) =>
  onTable(harness, chain(name, declare), ({ db, exec, step, rows }) =>
    Effect.gen(function* () {
      const S = db.entities.Selections
      yield* exec(db.entities.Teams.put({ id: "t1", founded: at(FOUNDED) }))
      yield* exec(db.entities.Players.put({ id: "p1", teamId: "t1" }))
      const foundedOn = (t: any, { eq }: any) => eq(t.player.team.founded, at(FOUNDED))
      const steps = {
        put: yield* step(S.put({ id: "s1", note: "-", playerId: "p1" })),
        get: yield* step(S.get({ id: "s1" })),
        held: yield* step(S.update({ id: "s1" }).set({ note: "held" }).condition(foundedOn)),
        pathSet: yield* step(
          S.update({ id: "s1" }).pathSet({
            segments: ["player", "team", "founded"],
            value: at(MOVED),
          }),
        ),
        after: yield* step(S.get({ id: "s1" })),
      }
      const row = (yield* rows).find((r) => r.__edd_e__?.S === "Selection")!
      return { steps, row }
    }),
  )

export const suite = (
  harness: Harness,
  describeIt: (name: string, body: () => void) => void = describe,
) =>
  describeIt("a ref declared as an annotated copy of its target's class", () => {
    for (const form of unionForms) {
      it(`in a union (${form.name}) reads a row 1.42.1 stored, and writes and reads it as 1.42.1 did`, () =>
        Effect.runPromise(
          Effect.gen(function* () {
            const { Teams, Players } = players(form.name, form.declare, {
              configured: form.configured,
            })
            yield* onTable(harness, { Teams, Players }, ({ db, exec, step, seed }) =>
              Effect.gen(function* () {
                const P = db.entities.Players
                yield* exec(db.entities.Teams.put({ id: "t1", founded: at(FOUNDED) }))
                // A player 1.42.1 stored: up to this fix every read of it failed.
                yield* seed({
                  id: { S: "p1" },
                  team: heldTeam,
                  __edd_e__: { S: "Player" },
                  ...playerKey("p1"),
                })
                const read = yield* step(P.get({ id: "p1" }))
                if (Exit.isFailure(read.exit)) throw read.exit
                same(read.exit.value.team.founded, at(FOUNDED))
                // A put sends what 1.42.1 sent, and returns and reads the team.
                const put = yield* step(P.put({ id: "p2", teamId: "t1" }))
                expect(put.sent).toEqual(putPins("p2"))
                if (Exit.isFailure(put.exit)) throw put.exit
                same(put.exit.value.team.founded, at(FOUNDED))
                const again = yield* step(P.get({ id: "p2" }))
                expect(outcome(again.exit)).toEqual({
                  ok: { id: "p2", team: { id: "t1", founded: FOUNDED } },
                })
                if (!form.nullable) return
                // ...and, declared nullable, holds `null` as the unannotated class does.
                const none = yield* step(P.put({ id: "p3", teamId: null }))
                expect(none.sent.map((sent) => sent.command)).toEqual(["PutItem"])
                expect(none.sent[0]!.input.Item.team).toEqual({ NULL: true })
                const empty = yield* step(P.get({ id: "p3" }))
                expect(outcome(empty.exit)).toEqual({ ok: { id: "p3", team: null } })
              }),
            )
          }),
        ))
    }

    it("in a union holding no member that is the target's model, is replaced by the target, and takes no null, as in 1.42.1", () =>
      Effect.runPromise(
        Effect.gen(function* () {
          class TeamView extends Schema.Class<TeamView>("AnnRefTeamView")({
            id: Schema.String,
            founded: Schema.DateTimeUtc,
          }) {}
          const { Teams, Players } = players("Other", () => Schema.NullOr(TeamView))
          yield* onTable(harness, { Teams, Players }, ({ db, exec, step }) =>
            Effect.gen(function* () {
              const P = db.entities.Players
              yield* exec(db.entities.Teams.put({ id: "t1", founded: at(FOUNDED) }))
              const put = yield* step(P.put({ id: "p2", teamId: "t1" }))
              expect(put.sent).toEqual(putPins("p2"))
              const read = yield* step(P.get({ id: "p2" }))
              if (Exit.isFailure(read.exit)) throw read.exit
              same(read.exit.value.team.founded, at(FOUNDED))
              const none = yield* step(P.put({ id: "p3", teamId: null }))
              expect(failure(none.exit)?._tag).toBe("ValidationError")
              expect(String(failure(none.exit)?.cause)).toContain(
                `Expected string\n  at ["teamId"]`,
              )
              expect(none.sent).toEqual([])
            }),
          )
        }),
      ))

    it("nested in a ref's target, is put, read, conditioned and path-written as the class itself is", () =>
      Effect.runPromise(
        Effect.gen(function* () {
          // Up to 1.42.1 every form but the class itself failed the selection's put, after its row
          // was stored, and every read of it, with `Expected DateTime.Utc at player.team.founded`.
          const reference = yield* nested(harness, "Class", (team) => team)
          const forms = {
            Annotated: () => annotated(),
            NullOrAnnotated: () => Schema.NullOr(annotated()),
            OptionalAnnotated: () => Schema.optional(annotated()),
            Suspend: (team: typeof Team) => Schema.suspend((): typeof Team => team),
          }
          const { steps, row } = reference
          const team = (iso: string) => ({ M: { id: { S: "t1" }, founded: seconds(iso) } })
          expect(steps.put.sent.at(-1)!.input.Item.player).toEqual({
            M: { id: { S: "p1" }, team: team(FOUNDED) },
          })
          if (Exit.isFailure(steps.get.exit)) throw steps.get.exit
          same(steps.get.exit.value.player.team.founded, at(FOUNDED))
          expect(valuesOf(steps.held)).toContainEqual(seconds(FOUNDED))
          expect(valuesOf(steps.pathSet)).toEqual([seconds(MOVED)])
          expect(row.player).toEqual({ M: { id: { S: "p1" }, team: team(MOVED) } })
          for (const [name, declare] of Object.entries(forms)) {
            const declared = yield* nested(harness, name, declare)
            // Request for request and answer for answer, the forms are one.
            for (const step of Object.keys(steps) as Array<keyof typeof steps>) {
              expect({ name, step, sent: declared.steps[step].sent }).toEqual({
                name,
                step,
                sent: steps[step].sent,
              })
              expect({ name, step, outcome: outcome(declared.steps[step].exit) }).toEqual({
                name,
                step,
                outcome: outcome(steps[step].exit),
              })
            }
            expect(declared.row).toEqual(row)
          }
        }),
      ))

    for (const pure of [false, true]) {
      it(`in a union in an aggregate edge entity's model${pure ? " (a pure definition)" : ""}, stores and reads the team's date, and null`, () =>
        Effect.runPromise(
          Effect.gen(function* () {
            // Up to 1.42.1, on this package's `Entity.make`, the edge row held `team.founded` as a
            // map and a read returned that map; a pure definition's held no `null`.
            for (const declare of [
              () => Schema.NullOr(annotated()),
              (team: typeof Team) => Schema.NullOr(DynamoModel.ref(team)),
            ]) {
              const { Teams, Players, Player } = players("Edge", declare, {
                ...(pure ? { make: PureEntity.make } : {}),
              })
              class Lineup extends Schema.Class<Lineup>("AnnRefLineup")({
                id: Schema.String,
                player: DynamoModel.ref(Player),
              }) {}
              const Lineups = (main: any) =>
                Aggregate.make(Lineup, {
                  table: main,
                  schema,
                  pk: { field: "pk", composite: ["id"] },
                  collection: { name: "lineup" },
                  root: { entityType: "Lineup" },
                  edges: {
                    player: Aggregate.one({ entityType: "LineupPlayer", entity: Players }),
                  },
                } as never)
              yield* onTable(
                harness,
                { Teams, Players },
                ({ db, exec, rows, seed }) =>
                  Effect.gen(function* () {
                    yield* exec(db.entities.Teams.put({ id: "t1", founded: at(FOUNDED) }))
                    yield* exec(db.entities.Players.put({ id: "p1", teamId: "t1" }))
                    yield* exec(db.entities.Players.put({ id: "p0", teamId: null }))
                    const made = yield* exec(
                      db.aggregates.Lineups.create({ id: "l1", playerId: "p1" }),
                    )
                    same(made.player.team.founded, at(FOUNDED))
                    const edge = (id: string) =>
                      Effect.map(rows, (all) =>
                        all.find((r) => r.__edd_e__?.S === "LineupPlayer" && r.pk?.S?.includes(id)),
                      )
                    const stored = (yield* edge("l1"))!
                    expect(stored.team).toEqual(heldTeam)
                    same(
                      (yield* exec(db.aggregates.Lineups.get({ id: "l1" }))).player.team.founded,
                      at(FOUNDED),
                    )
                    // The map 1.42.1 stored there reads as the date it holds.
                    yield* seed({
                      ...stored,
                      team: { M: { id: { S: "t1" }, founded: marshalledDate(FOUNDED) } },
                    })
                    same(
                      (yield* exec(db.aggregates.Lineups.get({ id: "l1" }))).player.team.founded,
                      at(FOUNDED),
                    )
                    // A player without a team.
                    yield* exec(db.aggregates.Lineups.create({ id: "l0", playerId: "p0" }))
                    expect((yield* edge("l0"))!.team).toEqual({ NULL: true })
                    const none = yield* exec(db.aggregates.Lineups.get({ id: "l0" }))
                    expect(none.player.team).toBeNull()
                  }),
                { Lineups },
              )
            }
          }),
        ))
    }
  })
