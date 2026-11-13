/**
 * A ref to an entity with a `DynamoModel.Hidden` field, at every position a ref takes (#241): an
 * entity's `refs`, an aggregate's root `one` edge, a `many` element wrapping the ref, a `many`
 * element that is the entity, a sub-aggregate's `one` edge (the root declaring the sub-aggregate's
 * value as a struct of its own) and a sub-aggregate's `many` element.
 *
 * A ref holds what a read of its entity returns (`refHeldTarget`). Where the hidden field read
 * absent fails (a required one), that is the target's other fields, a plain object: 1.40.0 refused
 * every such write, or, at a sub-aggregate's `one` edge, stored a row no read could decode. Every
 * other target is held as declared: where 1.40.0's read returned the target's class, so does this
 * one, an equal value; where 1.40.0 refused the write, this one refuses it the same way.
 *
 * `fixtures/ref-hidden-positions-1.40.0.json` holds what published 1.40.0 returned and stored.
 */

import { readFileSync } from "node:fs"
import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { describe, expect, it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import * as Aggregate from "../src/Aggregate.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

type Row = Record<string, AttributeValue>
type Outcome = { readonly ok?: unknown; readonly failed?: string; readonly [key: string]: unknown }
type Case = {
  readonly create: Outcome
  readonly get: Outcome
  readonly instances?: ReadonlyArray<boolean>
  readonly rows: ReadonlyArray<Row>
}
const published = JSON.parse(
  readFileSync(new URL("./fixtures/ref-hidden-positions-1.40.0.json", import.meta.url), "utf8"),
) as { readonly generatedFrom: ReadonlyArray<string>; readonly cases: Record<string, Case> }

const KINDS = ["required", "optional", "unknown", "any", "undefinedOr", "default"] as const
const POSITIONS = [
  "entity",
  "one",
  "manyWrapper",
  "manyEntity",
  "subOne",
  "subManyWrapper",
] as const
type Kind = (typeof KINDS)[number]
type Position = (typeof POSITIONS)[number]

const secretOf = (kind: Kind): Schema.Top =>
  kind === "unknown"
    ? Schema.Unknown
    : kind === "any"
      ? Schema.Any
      : kind === "undefinedOr"
        ? Schema.UndefinedOr(Schema.String)
        : kind === "optional"
          ? Schema.optionalKey(Schema.String)
          : kind === "default"
            ? Schema.String.pipe(Schema.optional, Schema.withDecodingDefault(Effect.succeed("d")))
            : Schema.String

const define = (kind: Kind, position: Position) => {
  class Team extends Schema.Class<Team>("Team")({
    id: Schema.String.pipe(DynamoModel.identifier),
    name: Schema.String,
    secret: (secretOf(kind) as any).pipe(DynamoModel.Hidden),
  }) {}
  const key = { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } }
  const Teams = Entity.make({ model: Team, entityType: "Team", primaryKey: key } as never) as any
  const Line = Schema.Struct({ id: Schema.String, team: Team.pipe(DynamoModel.ref) })
  const Players = Entity.make({
    model: Line,
    entityType: "Player",
    primaryKey: key,
    refs: { team: { entity: Teams } },
  } as never) as any
  const schema = DynamoSchema.make({ name: "hp", version: 1 })
  const Main = Table.make({ schema, entities: { Teams, Players } })
  const base = {
    schema,
    table: Main,
    pk: { field: "pk", composite: ["id"] },
    collection: { name: "agg" },
    root: { entityType: "Root" },
  }
  const A = Aggregate as any
  const SubOne = A.make(Schema.Struct({ name: Schema.String, team: Team.pipe(DynamoModel.ref) }), {
    root: { entityType: "Squad" },
    edges: { team: A.one({ entity: Teams, entityType: "SquadTeam" }) },
  })
  const SubMany = A.make(Schema.Struct({ name: Schema.String, lines: Schema.Array(Line) }), {
    root: { entityType: "Squad" },
    edges: { lines: A.many({ entity: Teams, entityType: "SquadLine", sk: { composite: ["id"] } }) },
  })
  const agg =
    position === "one"
      ? A.make(Schema.Struct({ id: Schema.String, team: Team.pipe(DynamoModel.ref) }), {
          ...base,
          edges: { team: A.one({ entity: Teams, entityType: "TeamEdge" }) },
        })
      : position === "manyWrapper"
        ? A.make(Schema.Struct({ id: Schema.String, lines: Schema.Array(Line) }), {
            ...base,
            edges: {
              lines: A.many({ entity: Teams, entityType: "Line", sk: { composite: ["id"] } }),
            },
          })
        : position === "manyEntity"
          ? A.make(Schema.Struct({ id: Schema.String, teams: Schema.Array(Team) }), {
              ...base,
              edges: {
                teams: A.many({ entity: Teams, entityType: "TeamRow", sk: { composite: ["id"] } }),
              },
            })
          : position === "subOne"
            ? A.make(
                Schema.Struct({
                  id: Schema.String,
                  squad: Schema.Struct({ name: Schema.String, team: Team.pipe(DynamoModel.ref) }),
                }),
                { ...base, edges: { squad: SubOne.with({ discriminator: { squadNo: 1 } }) } },
              )
            : position === "subManyWrapper"
              ? A.make(
                  Schema.Struct({
                    id: Schema.String,
                    squad: Schema.Struct({ name: Schema.String, lines: Schema.Array(Line) }),
                  }),
                  { ...base, edges: { squad: SubMany.with({ discriminator: { squadNo: 1 } }) } },
                )
              : undefined
  return { Team, Teams, Players, Main, agg }
}

const inputOf = (position: Position) =>
  position === "one"
    ? { id: "a", teamId: "t" }
    : position === "manyWrapper"
      ? { id: "a", lines: [{ id: "l", teamId: "t" }] }
      : position === "manyEntity"
        ? { id: "a", teams: ["t"] }
        : position === "subOne"
          ? { id: "a", squad: { name: "s", teamId: "t" } }
          : position === "subManyWrapper"
            ? { id: "a", squad: { name: "s", lines: [{ id: "l", teamId: "t" }] } }
            : { id: "p", teamId: "t" }

const refsOf = (position: Position, value: any): ReadonlyArray<unknown> =>
  position === "entity" || position === "one"
    ? [value.team]
    : position === "manyWrapper"
      ? value.lines.map((line: any) => line.team)
      : position === "manyEntity"
        ? value.teams
        : position === "subOne"
          ? [value.squad.team]
          : value.squad.lines.map((line: any) => line.team)

/** An outcome as the capture recorded it. */
const outcome = (exit: Exit.Exit<unknown, unknown>): Outcome => {
  if (Exit.isSuccess(exit)) return { ok: JSON.parse(JSON.stringify(exit.value)) }
  const failure = Cause.squash(exit.cause) as any
  return JSON.parse(
    JSON.stringify({
      failed: failure?._tag,
      operation: failure?.operation,
      cause: String(failure?.cause?.message ?? failure?.cause ?? failure?.message).slice(0, 400),
      reason: failure?.reason === undefined ? undefined : String(failure.reason).slice(0, 400),
    }),
  )
}
const byKey = (rows: ReadonlyArray<Row>) =>
  [...rows].sort((a, b) => {
    const ka = `${a.pk?.S} ${a.sk?.S}`
    const kb = `${b.pk?.S} ${b.sk?.S}`
    return ka < kb ? -1 : ka > kb ? 1 : 0
  })

type Ran = {
  readonly defs: ReturnType<typeof define>
  readonly created: Exit.Exit<unknown, unknown> | undefined
  readonly got: Exit.Exit<unknown, unknown>
  readonly rows: ReadonlyArray<Row>
}

const run = (
  kind: Kind,
  position: Position,
  seeded: ReadonlyArray<Row> = [],
): Effect.Effect<Ran, unknown> => {
  const defs = define(kind, position)
  const table = makeRecordingTable()
  for (const row of seeded) table.items.set(`${row.pk?.S}|${row.sk?.S}`, row as never)
  return Effect.gen(function* () {
    const db: any = yield* DynamoClient.make({
      entities: { Teams: defs.Teams, Players: defs.Players },
      ...(defs.agg === undefined ? {} : { aggregates: { Agg: defs.agg } }),
      tables: { Main: defs.Main },
    } as never)
    yield* db.entities.Teams.put({ id: "t", name: "team", secret: "s" }).asEffect()
    const created =
      seeded.length > 0
        ? undefined
        : yield* Effect.exit(
            defs.agg === undefined
              ? db.entities.Players.put(inputOf(position)).asEffect()
              : db.aggregates.Agg.create(inputOf(position)),
          )
    const got = yield* Effect.exit(
      defs.agg === undefined
        ? db.entities.Players.get({ id: "p" })
        : db.aggregates.Agg.get({ id: "a" }),
    )
    const rows = byKey(
      ([...table.items.values()] as ReadonlyArray<Row>).filter(
        (row) => row.__edd_e__?.S !== "Team",
      ),
    )
    return { defs, created, got, rows }
  }).pipe(
    Effect.provide(Layer.merge(table.layer, defs.Main.layer({ name: "table" }))),
  ) as unknown as Effect.Effect<Ran, unknown>
}

describe("a ref to an entity with a DynamoModel.Hidden field, at every position (#241)", () => {
  it("the fixture is published 1.40.0's", () => {
    expect(published.generatedFrom).toEqual(["effect-dynamodb@1.40.0"])
    expect(Object.keys(published.cases)).toHaveLength(KINDS.length * POSITIONS.length)
  })

  for (const kind of KINDS) {
    for (const position of POSITIONS) {
      const name = `${position} ${kind}`
      const then = published.cases[name]!
      if (kind === "required") {
        it.effect(
          `${name}: 1.40.0 refused the write or stored a row it couldn't read; the ref now reads as the target's other fields`,
          () =>
            Effect.gen(function* () {
              // What 1.40.0 did: refused the write, or (a sub-aggregate's `one` edge) stored a row
              // whose read failed.
              expect(then.get.failed).toBeDefined()
              const { defs, created, got, rows } = yield* run(kind, position)
              expect(outcome(created!).ok).toBeDefined()
              expect(outcome(got)).toEqual({ ok: outcome(created!).ok })
              const refs = refsOf(position, (got as Exit.Success<any, any>).value)
              expect(refs.length).toBeGreaterThan(0)
              for (const ref of refs) {
                expect(ref instanceof defs.Team).toBe(false)
                expect(JSON.parse(JSON.stringify(ref))).toEqual({ id: "t", name: "team" })
                expect(ref).not.toHaveProperty("secret")
              }
              // Where 1.40.0 stored rows, stored byte for byte as it stored them.
              if (then.rows.length > 0) expect(rows).toEqual(byKey(then.rows))
            }),
        )
        if (then.rows.length > 0) {
          it.effect(`${name}: the rows 1.40.0 stored read`, () =>
            Effect.gen(function* () {
              const { defs, got } = yield* run(kind, position, then.rows)
              expect(outcome(got).ok).toBeDefined()
              for (const ref of refsOf(position, (got as Exit.Success<any, any>).value)) {
                expect(ref instanceof defs.Team).toBe(false)
                expect(JSON.parse(JSON.stringify(ref))).toEqual({ id: "t", name: "team" })
              }
            }),
          )
        }
      } else {
        it.effect(`${name}: as 1.40.0, the same outcome, class and rows`, () =>
          Effect.gen(function* () {
            const { defs, created, got, rows } = yield* run(kind, position)
            expect({ create: outcome(created!), get: outcome(got) }).toEqual({
              create: then.create,
              get: then.get,
            })
            expect(rows).toEqual(byKey(then.rows))
            if (then.instances !== undefined) {
              const refs = refsOf(position, (got as Exit.Success<any, any>).value)
              expect(refs.map((ref) => ref instanceof defs.Team)).toEqual(then.instances)
            }
          }),
        )
      }
    }
  }
})

/**
 * Named, not changed (#241): a ref two levels deep whose innermost target holds a required hidden
 * field. `Team` (hidden `secret`, required) is held by `Club` as what a read of it returns, but
 * `League`'s ref to `Club` decodes the club it reads through `Club`'s class, whose constructor checks
 * `team` as a `Team`, so every `League` write fails, as on 1.40.0. One level deep it works (above).
 */
describe("a two-level ref chain whose innermost target holds a required hidden field", () => {
  it.effect(
    "the outer entity's write fails, as on 1.40.0, and stores nothing",
    () =>
      Effect.gen(function* () {
        const key = {
          pk: { field: "pk", composite: ["id"] },
          sk: { field: "sk", composite: [] },
        } as const
        class Team extends Schema.Class<Team>("ChainTeam")({
          id: Schema.String.pipe(DynamoModel.identifier),
          name: Schema.String,
          secret: Schema.String.pipe(DynamoModel.Hidden),
        }) {}
        const Teams = Entity.make({
          model: Team,
          entityType: "Team",
          primaryKey: key,
        } as never) as any
        class Club extends Schema.Class<Club>("ChainClub")({
          id: Schema.String.pipe(DynamoModel.identifier),
          team: Team.pipe(DynamoModel.ref),
        }) {}
        const Clubs = Entity.make({
          model: Club,
          entityType: "Club",
          primaryKey: key,
          refs: { team: { entity: Teams } },
        } as never) as any
        class League extends Schema.Class<League>("ChainLeague")({
          id: Schema.String.pipe(DynamoModel.identifier),
          club: Club.pipe(DynamoModel.ref),
        }) {}
        const Leagues = Entity.make({
          model: League,
          entityType: "League",
          primaryKey: key,
          refs: { club: { entity: Clubs } },
        } as never) as any
        const schema = DynamoSchema.make({ name: "chain", version: 1 })
        const Main = Table.make({ schema, entities: { Teams, Clubs, Leagues } })
        const table = makeRecordingTable()
        const db: any = yield* DynamoClient.make({
          entities: { Teams, Clubs, Leagues },
          tables: { Main },
        }).pipe(
          Effect.provide(Layer.merge(table.layer, Main.layer({ name: "chain" }))),
        ) as Effect.Effect<any, unknown, never>
        yield* db.entities.Teams.put({ id: "t", name: "team", secret: "s" })
        yield* db.entities.Clubs.put({ id: "c", teamId: "t" })
        const league = yield* Effect.exit(
          db.entities.Leagues.put({ id: "l", clubId: "c" }).asEffect(),
        )
        expect(Exit.isFailure(league)).toBe(true)
        const types = [...table.items.values()].map((row: any) => row.__edd_e__?.S).sort()
        expect(types).toEqual(["Club", "Team"])
      }) as Effect.Effect<void, unknown, never>,
  )
})
