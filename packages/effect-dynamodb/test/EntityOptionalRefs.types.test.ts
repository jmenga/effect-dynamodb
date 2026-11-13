/**
 * A ref the model declares optional, at the type level (#241): its `${ref}Id` is optional in
 * `put` / `create` / `upsert` input (`Schema.optionalKey` takes no `undefined`,
 * `Schema.optional` does), and `.remove()` takes the ref by its field. A required ref's id stays
 * required, and neither a required ref nor any `${ref}Id` can be removed. The run-time behaviour is
 * pinned in `helpers/EntityRefWrites.ts`. Nothing here runs: an effect built inside `compiles` is
 * never executed.
 */
import { Effect, Schema } from "effect"
import { describe, expect, expectTypeOf, it } from "vitest"
import { DynamoClient, DynamoModel, DynamoSchema, Entity, Table } from "../src/index.js"

const AppSchema = DynamoSchema.make({ name: "optrefs", version: 1 })
const byId = {
  pk: { field: "pk", composite: ["id"] },
  sk: { field: "sk", composite: [] },
} as const

class Team extends Schema.Class<Team>("OptRefsTeam")({
  id: Schema.String.pipe(DynamoModel.identifier),
  name: Schema.String,
}) {}
const Teams = Entity.make({ model: Team, entityType: "Team", primaryKey: byId })

class Coach extends Schema.Class<Coach>("OptRefsCoach")({
  id: Schema.String.pipe(DynamoModel.identifier),
  name: Schema.String,
}) {}
const Coaches = Entity.make({ model: Coach, entityType: "Coach", primaryKey: byId })

class Venue extends Schema.Class<Venue>("OptRefsVenue")({
  id: Schema.String.pipe(DynamoModel.identifier),
  name: Schema.String,
}) {}
const Venues = Entity.make({ model: Venue, entityType: "Venue", primaryKey: byId })

class Player extends Schema.Class<Player>("OptRefsPlayer")({
  id: Schema.String,
  nick: Schema.String,
  team: Team.pipe(DynamoModel.ref),
  coach: Schema.optionalKey(Coach.pipe(DynamoModel.ref)),
  venue: Schema.optional(Venue).pipe(DynamoModel.ref),
}) {}
const Players = Entity.make({
  model: Player,
  entityType: "Player",
  primaryKey: byId,
  refs: { team: { entity: Teams }, coach: { entity: Coaches }, venue: { entity: Venues } },
})

const MainTable = Table.make({ schema: AppSchema, entities: { Teams, Coaches, Venues, Players } })

/** The type checker reads the body. Nothing runs it. */
const compiles = (_body: () => unknown) => undefined

describe("an optional ref", () => {
  it("its id is optional in Entity.Input and Entity.Create; a required ref's isn't", () => {
    type Input = Entity.Input<typeof Players>
    expectTypeOf<Input["teamId"]>().toEqualTypeOf<string>()
    expectTypeOf<Required<Input>["coachId"]>().toEqualTypeOf<string>()
    expectTypeOf<Required<Input>["venueId"]>().toEqualTypeOf<string | undefined>()
    const leftOut: Input = { id: "p", nick: "n", teamId: "t" }
    const given: Input = { id: "p", nick: "n", teamId: "t", coachId: "c", venueId: "v" }
    const venueUndefined: Input = { id: "p", nick: "n", teamId: "t", venueId: undefined }
    // @ts-expect-error a `Schema.optionalKey` ref's id takes no `undefined`
    const coachUndefined: Input = { id: "p", nick: "n", teamId: "t", coachId: undefined }
    // @ts-expect-error a required ref's id
    const teamLeftOut: Input = { id: "p", nick: "n" }
    type Create = Entity.Create<typeof Players>
    const created: Create = { id: "p", nick: "n", teamId: "t" }
    // @ts-expect-error a required ref's id
    const createdWithoutTeam: Create = { id: "p", nick: "n" }
    expect([leftOut, given, venueUndefined, coachUndefined, teamLeftOut]).toHaveLength(5)
    expect([created, createdWithoutTeam]).toHaveLength(2)
  })

  it("a bound put, create and upsert leave it out; .remove() takes it by its field", () => {
    const db = () =>
      Effect.gen(function* () {
        const client = yield* DynamoClient.make({
          entities: { Teams, Coaches, Venues, Players },
          tables: { MainTable },
        })
        return client.entities
      })
    type Db = Effect.Success<ReturnType<typeof db>>
    const bound = undefined as unknown as Db
    compiles(() => {
      bound.Players.put({ id: "p", nick: "n", teamId: "t" })
      bound.Players.create({ id: "p", nick: "n", teamId: "t" })
      bound.Players.upsert({ id: "p", nick: "n", teamId: "t", venueId: undefined })
      // @ts-expect-error a required ref's id
      bound.Players.put({ id: "p", nick: "n" })
      const u = bound.Players.update({ id: "p" })
      u.remove(["coach"])
      u.remove(["venue", "coach"])
      u.set({ coachId: "c" })
      // @ts-expect-error a required ref: a row without it couldn't be read
      u.remove(["team"])
      // @ts-expect-error a ref's id: the row stores the ref, not the id
      u.remove(["coachId"])
    })
    expect(true).toBe(true)
  })
})
