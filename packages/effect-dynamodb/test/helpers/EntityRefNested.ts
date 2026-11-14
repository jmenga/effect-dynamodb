/**
 * A ref whose target model declares a ref of its own (`Selection.player` → `Player.team` → `Team`)
 * is held, read, compared and path-written the same whichever way the models declare their refs: on
 * the model (`team: DynamoModel.ref(Team)`) or as a plain class configured `{ ref: true }`. Up to
 * 1.42.1 the model form failed every selection put and read with `Expected DateTime.Utc at
 * player.team.founded`, after the put had stored its row: the annotation hides `Team`'s fields, so
 * the selection's schemas took the stored copy of `founded` for a domain date. A condition or filter
 * on `t.player.team.founded` sent the date as a map, and so did a `pathSet` into it. The selection
 * now holds the player's ref as the player entity's own read holds it, at any depth, so the model
 * form sends what the configure form sends, which is what 1.42.1 sent for it: the date in the
 * team entity's storage (`storedAs` included).
 *
 * One suite, run on a recording table (`EntityRefKeys.test.ts`) and against DynamoDB Local
 * (`connected.entity-ref-keys.test.ts`), with their harnesses.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
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

const schema = DynamoSchema.make({ name: "nestedref", version: 1 })
const byId = {
  pk: { field: "pk", composite: ["id"] },
  sk: { field: "sk", composite: [] },
} as const
const bySeason = {
  name: "gsi1",
  pk: { field: "gsi1pk", composite: ["season"] },
  sk: { field: "gsi1sk", composite: [] },
} as const

/** How the models declare their refs. */
type Form = "model" | "configure"
/** How the team entity stores `founded`. */
type Storage = "default" | "seconds"

class Team extends Schema.Class<Team>("NestedRefTeam")({
  id: Schema.String,
  founded: Schema.DateTimeUtc,
}) {}

/** Distinct classes per form; the requests and rows don't name a class. */
const models = (form: Form) => {
  if (form === "model") {
    class Player extends Schema.Class<Player>("NestedRefModelPlayer")({
      id: Schema.String,
      team: DynamoModel.ref(Team),
    }) {}
    class Selection extends Schema.Class<Selection>("NestedRefModelSelection")({
      id: Schema.String,
      season: Schema.String,
      note: Schema.String,
      player: DynamoModel.ref(Player),
    }) {}
    return { Player, Selection } as { Player: Schema.Top; Selection: Schema.Top }
  }
  class Player extends Schema.Class<Player>("NestedRefConfigurePlayer")({
    id: Schema.String,
    team: Team,
  }) {}
  class Selection extends Schema.Class<Selection>("NestedRefConfigureSelection")({
    id: Schema.String,
    season: Schema.String,
    note: Schema.String,
    player: Player,
  }) {}
  return { Player, Selection } as { Player: Schema.Top; Selection: Schema.Top }
}

const chain = (form: Form, storage: Storage) => {
  const { Player, Selection } = models(form)
  const ref = (field: string) => (form === "configure" ? { [field]: { ref: true } } : {})
  const Teams = Entity.make({
    model: DynamoModel.configure(Team, {
      id: { identifier: true },
      ...(storage === "seconds" ? { founded: { storedAs: DynamoModel.DateEpochSeconds } } : {}),
    }),
    entityType: "Team",
    primaryKey: byId,
  } as never) as any
  const Players = Entity.make({
    model: DynamoModel.configure(Player as never, { id: { identifier: true }, ...ref("team") }),
    entityType: "Player",
    primaryKey: byId,
    refs: { team: { entity: Teams } },
  } as never) as any
  const Selections = Entity.make({
    model: DynamoModel.configure(Selection as never, {
      id: { identifier: true },
      ...ref("player"),
    }),
    entityType: "Selection",
    primaryKey: byId,
    indexes: { bySeason },
    refs: { player: { entity: Players } },
  } as never) as any
  return { entities: { Teams, Players, Selections }, Player }
}

const at = (iso: string) => DateTime.makeUnsafe(iso)
const FOUNDED = "1990-05-06T07:08:09.000Z"
const OTHER = "1985-01-02T03:04:05.000Z"
const MOVED = "1991-01-01T00:00:00.000Z"
/** `founded` as the team entity stores it. */
const stored = (storage: Storage, iso: string): AttributeValue =>
  storage === "seconds"
    ? { N: String(Math.floor(DateTime.toEpochMillis(at(iso)) / 1000)) }
    : { S: iso }
const prefix = "$nestedref#v1#selection"

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

/**
 * Team t1 (founded {@link FOUNDED}) and t2, player p1 on t1 and p2 on t2, selection `b` naming p2;
 * then the selection `a` naming p1 is put, read, queried, conditioned and path-written.
 */
const rounds = (harness: Harness, form: Form, storage: Storage) => {
  const { entities } = chain(form, storage)
  return onTable(harness, entities, ({ db, exec, step, rows }) =>
    Effect.gen(function* () {
      const S = db.entities.Selections
      yield* exec(db.entities.Teams.put({ id: "t1", founded: at(FOUNDED) }))
      yield* exec(db.entities.Teams.put({ id: "t2", founded: at(OTHER) }))
      yield* exec(db.entities.Players.put({ id: "p1", teamId: "t1" }))
      yield* exec(db.entities.Players.put({ id: "p2", teamId: "t2" }))
      yield* exec(S.put({ id: "b", season: "2025", note: "-", playerId: "p2" }))
      const foundedOn = (t: any, { eq }: any) => eq(t.player.team.founded, at(FOUNDED))
      const steps = {
        put: yield* step(S.put({ id: "a", season: "2025", note: "-", playerId: "p1" })),
        get: yield* step(S.get({ id: "a" })),
        query: yield* step(S.bySeason({ season: "2025" }).filter(foundedOn).collect()),
        held: yield* step(S.update({ id: "a" }).set({ note: "held" }).condition(foundedOn)),
        refused: yield* step(S.update({ id: "b" }).set({ note: "held" }).condition(foundedOn)),
        pathSet: yield* step(
          S.update({ id: "a" }).pathSet({
            segments: ["player", "team", "founded"],
            value: at(MOVED),
          }),
        ),
        after: yield* step(S.get({ id: "a" })),
      }
      const row = (yield* rows).find((r) => r.pk?.S === `${prefix}#id_a` && r.sk?.S === prefix)!
      return { steps, row }
    }),
  )
}

/** One level: a squad holding a team, declared `form`. */
const oneLevel = (form: Form) => {
  const Teams = Entity.make({
    model: DynamoModel.configure(Team, { id: { identifier: true } }),
    entityType: "Team",
    primaryKey: byId,
  } as never) as any
  const Squad =
    form === "model"
      ? class Squad extends Schema.Class<Squad>("NestedRefModelSquad")({
          id: Schema.String,
          team: DynamoModel.ref(Team),
        }) {}
      : class Squad extends Schema.Class<Squad>("NestedRefConfigureSquad")({
          id: Schema.String,
          team: Team,
        }) {}
  const Squads = Entity.make({
    model: DynamoModel.configure(Squad as never, {
      id: { identifier: true },
      ...(form === "configure" ? { team: { ref: true } } : {}),
    }),
    entityType: "Squad",
    primaryKey: byId,
    refs: { team: { entity: Teams } },
  } as never) as any
  return { Teams, Squads }
}

/**
 * Team (`founded` stored as epoch seconds) → player → selection, with `Player.team` and
 * `Selection.player` declared as given, and configured `{ ref: true }` where `configured` says.
 */
const declared = (
  name: string,
  declare: {
    readonly team: (target: typeof Team) => Schema.Top
    readonly player: (target: Schema.Top) => Schema.Top
    readonly configured: ReadonlyArray<"team" | "player">
  },
) => {
  const ref = (field: "team" | "player") =>
    declare.configured.includes(field) ? { [field]: { ref: true } } : {}
  const Teams = Entity.make({
    model: DynamoModel.configure(Team, {
      id: { identifier: true },
      founded: { storedAs: DynamoModel.DateEpochSeconds },
    }),
    entityType: "Team",
    primaryKey: byId,
  } as never) as any
  class Player extends Schema.Class<Player>(`NestedRef${name}Player`)({
    id: Schema.String,
    team: declare.team(Team) as typeof Team,
  }) {}
  const Players = Entity.make({
    model: DynamoModel.configure(Player, { id: { identifier: true }, ...ref("team") } as never),
    entityType: "Player",
    primaryKey: byId,
    refs: { team: { entity: Teams } },
  } as never) as any
  class Selection extends Schema.Class<Selection>(`NestedRef${name}Selection`)({
    id: Schema.String,
    note: Schema.String,
    player: declare.player(Player) as typeof Player,
  }) {}
  const Selections = Entity.make({
    model: DynamoModel.configure(Selection, {
      id: { identifier: true },
      ...ref("player"),
    } as never),
    entityType: "Selection",
    primaryKey: byId,
    refs: { player: { entity: Players } },
  } as never) as any
  return { Teams, Players, Selections }
}

/** A selection row of {@link declared}'s selection entity, holding `player`. */
const selectionRow = (id: string, player: AttributeValue): Row => ({
  id: { S: id },
  note: { S: "-" },
  player,
  __edd_e__: { S: "Selection" },
  pk: { S: `${prefix}#id_${id}` },
  sk: { S: prefix },
})

export const suite = (
  harness: Harness,
  describeIt: (name: string, body: () => void) => void = describe,
) =>
  describeIt("a ref two levels down, declared on the model or configured", () => {
    for (const storage of ["default", "seconds"] as const) {
      it(`is put, read, queried, conditioned and path-written alike (${storage} storage)`, () =>
        Effect.runPromise(
          Effect.gen(function* () {
            const configured = yield* rounds(harness, "configure", storage)
            const declared = yield* rounds(harness, "model", storage)
            for (const { steps, row } of [configured, declared]) {
              const team = (iso: string) => ({
                M: { id: { S: "t1" }, founded: stored(storage, iso) },
              })
              // The put: the player as a read of it returns, `founded` in the team's storage.
              expect(steps.put.sent).toEqual([
                {
                  command: "GetItem",
                  input: {
                    TableName: "<table>",
                    Key: {
                      pk: { S: "$nestedref#v1#player#id_p1" },
                      sk: { S: "$nestedref#v1#player" },
                    },
                  },
                },
                {
                  command: "PutItem",
                  input: {
                    TableName: "<table>",
                    Item: {
                      id: { S: "a" },
                      season: { S: "2025" },
                      note: { S: "-" },
                      player: { M: { id: { S: "p1" }, team: team(FOUNDED) } },
                      __edd_e__: { S: "Selection" },
                      pk: { S: `${prefix}#id_a` },
                      sk: { S: prefix },
                      gsi1pk: { S: `${prefix}#season_2025` },
                      gsi1sk: { S: prefix },
                    },
                  },
                },
              ])
              expect(steps.get.sent).toEqual([
                {
                  command: "GetItem",
                  input: {
                    TableName: "<table>",
                    Key: { pk: { S: `${prefix}#id_a` }, sk: { S: prefix } },
                  },
                },
              ])
              if (Exit.isFailure(steps.get.exit)) throw steps.get.exit
              same(steps.get.exit.value.player.team.founded, at(FOUNDED))
              // A filter and a condition on the team's date send it as stored.
              expect(Exit.isSuccess(steps.query.exit)).toBe(true)
              expect((steps.query.exit as any).value.map((s: any) => s.id)).toEqual(["a"])
              expect(valuesOf(steps.query)).toContainEqual(stored(storage, FOUNDED))
              expect(Exit.isSuccess(steps.held.exit)).toBe(true)
              expect(valuesOf(steps.held)).toContainEqual(stored(storage, FOUNDED))
              expect(failure(steps.refused.exit)?._tag).toBe("ConditionalCheckFailed")
              // `pathSet` writes the date as stored, and a read takes it.
              const written = steps.pathSet.sent.at(-1)!.input
              expect(written.UpdateExpression).toContain("#ps0.#ps1.#ps2 = :ps3")
              expect(written.ExpressionAttributeValues[":ps3"]).toEqual(stored(storage, MOVED))
              expect(row.player).toEqual({ M: { id: { S: "p1" }, team: team(MOVED) } })
              if (Exit.isFailure(steps.after.exit)) throw steps.after.exit
              same(steps.after.exit.value.player.team.founded, at(MOVED))
            }
            // Request for request and answer for answer, the two forms are one.
            for (const name of Object.keys(configured.steps) as Array<
              keyof typeof configured.steps
            >) {
              expect(declared.steps[name].sent).toEqual(configured.steps[name].sent)
              expect(outcome(declared.steps[name].exit)).toEqual(
                outcome(configured.steps[name].exit),
              )
            }
            expect(declared.row).toEqual(configured.row)
          }),
        ))
    }

    for (const form of ["model", "configure"] as const) {
      it(`one level down, declared ${form === "model" ? "on the model" : "by configure"}, sends what 1.42.1 sent`, () =>
        Effect.runPromise(
          onTable(harness, oneLevel(form), ({ db, exec, step }) =>
            Effect.gen(function* () {
              yield* exec(db.entities.Teams.put({ id: "t1", founded: at(FOUNDED) }))
              const put = yield* step(db.entities.Squads.put({ id: "s1", teamId: "t1" }))
              const get = yield* step(db.entities.Squads.get({ id: "s1" }))
              expect([...put.sent, ...get.sent]).toEqual([
                {
                  command: "GetItem",
                  input: {
                    TableName: "<table>",
                    Key: {
                      pk: { S: "$nestedref#v1#team#id_t1" },
                      sk: { S: "$nestedref#v1#team" },
                    },
                  },
                },
                {
                  command: "PutItem",
                  input: {
                    TableName: "<table>",
                    Item: {
                      id: { S: "s1" },
                      team: { M: { id: { S: "t1" }, founded: { S: FOUNDED } } },
                      __edd_e__: { S: "Squad" },
                      pk: { S: "$nestedref#v1#squad#id_s1" },
                      sk: { S: "$nestedref#v1#squad" },
                    },
                  },
                },
                {
                  command: "GetItem",
                  input: {
                    TableName: "<table>",
                    Key: {
                      pk: { S: "$nestedref#v1#squad#id_s1" },
                      sk: { S: "$nestedref#v1#squad" },
                    },
                  },
                },
              ])
              if (Exit.isFailure(get.exit)) throw get.exit
              same(get.exit.value.team.founded, at(FOUNDED))
            }),
          ),
        ))
    }

    it("reads a copy a 1.42.1 path write left as a map", () =>
      Effect.runPromise(
        onTable(harness, chain("model", "default").entities, ({ db, exec, step, rows, seed }) =>
          Effect.gen(function* () {
            yield* exec(db.entities.Teams.put({ id: "t1", founded: at(FOUNDED) }))
            yield* exec(db.entities.Players.put({ id: "p1", teamId: "t1" }))
            yield* exec(
              db.entities.Selections.put({ id: "a", season: "2025", note: "-", playerId: "p1" }),
            )
            const row = (yield* rows).find((r) => r.pk?.S === `${prefix}#id_a`)!
            // What 1.42.1's `pathSet(["player", "team", "founded"], …)` stored.
            yield* seed({
              ...row,
              player: {
                M: {
                  id: { S: "p1" },
                  team: {
                    M: {
                      id: { S: "t1" },
                      founded: {
                        M: {
                          epochMilliseconds: { N: String(DateTime.toEpochMillis(at(MOVED))) },
                          "~effect/DateTime": { S: "~effect/DateTime" },
                          _tag: { S: "Utc" },
                        },
                      },
                    },
                  },
                },
              },
            })
            const read = yield* step(db.entities.Selections.get({ id: "a" }))
            if (Exit.isFailure(read.exit)) throw read.exit
            same(read.exit.value.player.team.founded, at(MOVED))
          }),
        ),
      ))

    // The wrapper a model declares around a nested ref is kept: only the ref inside it is held as
    // its entity's read holds it. 1.42.1 read and path-wrote these copies as declared.
    for (const form of ["configure", "model"] as const) {
      it(`a nullable nested ref reads and path-writes null, declared ${form === "model" ? "on the model" : "by configure"}`, () =>
        Effect.runPromise(
          onTable(
            harness,
            declared(`Nullable${form}`, {
              team: (target) =>
                form === "model" ? DynamoModel.ref(Schema.NullOr(target)) : Schema.NullOr(target),
              player: (target) => (form === "model" ? DynamoModel.ref(target) : target),
              configured: form === "model" ? [] : ["team", "player"],
            }),
            ({ db, step, rows, seed }) =>
              Effect.gen(function* () {
                // A selection of a player without a team, as 1.42.1 stored it.
                yield* seed(selectionRow("s0", { M: { id: { S: "p0" }, team: { NULL: true } } }))
                const read = yield* step(db.entities.Selections.get({ id: "s0" }))
                expect(outcome(read.exit)).toEqual({
                  ok: { id: "s0", note: "-", player: { id: "p0", team: null } },
                })
                const set = yield* step(
                  db.entities.Selections.update({ id: "s0" }).pathSet({
                    segments: ["player", "team"],
                    value: null,
                  }),
                )
                if (Exit.isFailure(set.exit)) throw set.exit
                expect(set.sent.at(-1)!.input.UpdateExpression).toBe("SET #ps0.#ps1 = :ps2")
                expect(valuesOf(set)).toEqual([{ NULL: true }])
                const row = (yield* rows).find((r) => r.pk?.S === `${prefix}#id_s0`)!
                expect(row.player).toEqual({ M: { id: { S: "p0" }, team: { NULL: true } } })
                const again = yield* step(db.entities.Selections.get({ id: "s0" }))
                expect(outcome(again.exit)).toEqual(outcome(read.exit))
              }),
          ),
        ))
    }

    it("an optional nested ref the copy leaves out reads without it", () =>
      Effect.runPromise(
        onTable(
          harness,
          declared("Optional", {
            team: (target) => Schema.optionalKey(target),
            player: (target) => target,
            configured: ["team", "player"],
          }),
          ({ db, step, seed }) =>
            Effect.gen(function* () {
              yield* seed(selectionRow("s0", { M: { id: { S: "p0" } } }))
              const read = yield* step(db.entities.Selections.get({ id: "s0" }))
              expect(outcome(read.exit)).toEqual({
                ok: { id: "s0", note: "-", player: { id: "p0" } },
              })
            }),
        ),
      ))

    it("a nested ref beneath a nullable ref is held as its entity's read holds it", () =>
      Effect.runPromise(
        onTable(
          harness,
          declared("BeneathNullable", {
            team: (target) => DynamoModel.ref(target),
            player: (target) => DynamoModel.ref(Schema.NullOr(target)),
            configured: [],
          }),
          ({ db, exec, step, rows }) =>
            Effect.gen(function* () {
              // Up to 1.42.1 the put stored the row and failed `Expected DateTime.Utc at
              // player.team.founded`, and so did every read of it.
              const S = db.entities.Selections
              yield* exec(db.entities.Teams.put({ id: "t1", founded: at(FOUNDED) }))
              yield* exec(db.entities.Players.put({ id: "p1", teamId: "t1" }))
              const put = yield* step(S.put({ id: "s1", note: "-", playerId: "p1" }))
              if (Exit.isFailure(put.exit)) throw put.exit
              same(put.exit.value.player.team.founded, at(FOUNDED))
              const row = () =>
                Effect.map(rows, (all) => all.find((r) => r.pk?.S === `${prefix}#id_s1`)!.player)
              const team = (iso: string) => ({
                M: { id: { S: "t1" }, founded: stored("seconds", iso) },
              })
              expect(yield* row()).toEqual({ M: { id: { S: "p1" }, team: team(FOUNDED) } })
              const read = yield* step(S.get({ id: "s1" }))
              if (Exit.isFailure(read.exit)) throw read.exit
              same(read.exit.value.player.team.founded, at(FOUNDED))
              const held = yield* step(
                S.update({ id: "s1" })
                  .set({ note: "held" })
                  .condition((t: any, { eq }: any) => eq(t.player.team.founded, at(FOUNDED))),
              )
              if (Exit.isFailure(held.exit)) throw held.exit
              expect(valuesOf(held)).toContainEqual(stored("seconds", FOUNDED))
              const set = yield* step(
                S.update({ id: "s1" }).pathSet({
                  segments: ["player", "team", "founded"],
                  value: at(MOVED),
                }),
              )
              if (Exit.isFailure(set.exit)) throw set.exit
              expect(valuesOf(set)).toEqual([stored("seconds", MOVED)])
              expect(yield* row()).toEqual({ M: { id: { S: "p1" }, team: team(MOVED) } })
              const after = yield* step(S.get({ id: "s1" }))
              if (Exit.isFailure(after.exit)) throw after.exit
              same(after.exit.value.player.team.founded, at(MOVED))
            }),
        ),
      ))

    it("an aggregate edge holding the player stores and reads the team's date", () =>
      Effect.runPromise(
        Effect.gen(function* () {
          // Up to 1.42.1 the edge row held `team.founded` as a map, and a read returned that map.
          const {
            entities: { Teams, Players },
            Player,
          } = chain("model", "default")
          class Lineup extends Schema.Class<Lineup>("NestedRefLineup")({
            id: Schema.String,
            player: (Player as typeof Team).pipe(DynamoModel.ref),
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
                yield* exec(db.entities.Teams.put({ id: "t1", founded: at(FOUNDED) }))
                yield* exec(db.entities.Players.put({ id: "p1", teamId: "t1" }))
                const made = yield* exec(db.aggregates.Lineups.create({ id: "l1", playerId: "p1" }))
                same(made.player.team.founded, at(FOUNDED))
                const edge = (yield* rows).find((r) => r.__edd_e__?.S === "LineupPlayer")!
                expect(edge.team).toEqual({ M: { id: { S: "t1" }, founded: { S: FOUNDED } } })
                const read = yield* exec(db.aggregates.Lineups.get({ id: "l1" }))
                same(read.player.team.founded, at(FOUNDED))
              }),
            { Lineups },
          )
        }),
      ))

    it("a model that refs itself is held to the depth its entities give it", () =>
      Effect.runPromise(
        Effect.gen(function* () {
          // `Folder.parent` is a `Folder`: `Roots` holds no ref, `Folders` holds its parent as a
          // `Roots` read returns it, and `Docs` holds a folder as a `Folders` read returns it, so
          // a doc's copy ends at `folder.parent`, whatever the model declares beneath it.
          interface Folder {
            readonly id: string
            readonly made: DateTime.Utc
            readonly parent?: Folder
          }
          const Folder: Schema.Codec<Folder> = Schema.Struct({
            id: Schema.String,
            made: Schema.DateTimeUtc,
            parent: Schema.optionalKey(
              DynamoModel.ref(Schema.suspend((): Schema.Codec<Folder> => Folder)),
            ),
          })
          const folder = (entityType: string, refs: object) =>
            Entity.make({
              model: DynamoModel.configure(Folder as never, {
                id: { identifier: true },
                made: { storedAs: DynamoModel.DateEpochSeconds },
              }),
              entityType,
              primaryKey: byId,
              refs,
            } as never) as any
          const Roots = folder("Root", {})
          const Folders = folder("Folder", { parent: { entity: Roots } })
          class Doc extends Schema.Class<Doc>("NestedRefDoc")({
            id: Schema.String,
            folder: DynamoModel.ref(Folder),
          }) {}
          const Docs = Entity.make({
            model: DynamoModel.configure(Doc, { id: { identifier: true } }),
            entityType: "Doc",
            primaryKey: byId,
            refs: { folder: { entity: Folders } },
          } as never) as any
          yield* onTable(harness, { Roots, Folders, Docs }, ({ db, exec, step, rows }) =>
            Effect.gen(function* () {
              yield* exec(db.entities.Roots.put({ id: "f0", made: at(FOUNDED) }))
              yield* exec(db.entities.Folders.put({ id: "f1", made: at(FOUNDED), parentId: "f0" }))
              const put = yield* step(db.entities.Docs.put({ id: "d1", folderId: "f1" }))
              if (Exit.isFailure(put.exit)) throw put.exit
              const seconds = stored("seconds", FOUNDED)
              const doc = () =>
                Effect.map(rows, (all) => all.find((r) => r.__edd_e__?.S === "Doc")!)
              expect((yield* doc()).folder).toEqual({
                M: {
                  id: { S: "f1" },
                  made: seconds,
                  parent: { M: { id: { S: "f0" }, made: seconds } },
                },
              })
              const set = yield* step(
                db.entities.Docs.update({ id: "d1" }).pathSet({
                  segments: ["folder", "parent", "made"],
                  value: at(MOVED),
                }),
              )
              expect(valuesOf(set)).toEqual([stored("seconds", MOVED)])
              const read = yield* step(db.entities.Docs.get({ id: "d1" }))
              if (Exit.isFailure(read.exit)) throw read.exit
              same(read.exit.value.folder.made, at(FOUNDED))
              same(read.exit.value.folder.parent.made, at(MOVED))
            }),
          )
        }),
      ))
  })
