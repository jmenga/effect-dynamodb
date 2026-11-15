/**
 * A ref the model declares nullable, at the type level: its `${ref}Id` takes `null` in `put` /
 * `create` input (required where the ref's key is, optional where it's `Schema.optionalKey`) and in
 * `.set()`, which detaches it; `.keepRefs()` takes no `null`. A `Schema.UndefinedOr` ref's id is a
 * required key that takes `undefined`. Refs declared without `null` keep their types. The run-time
 * behaviour is pinned in `helpers/EntityRefNullable.ts`. Nothing here runs: an effect built inside
 * `compiles` is never executed.
 */
import { Effect, Schema } from "effect"
import { describe, expect, expectTypeOf, it } from "vitest"
import { DynamoClient, DynamoModel, DynamoSchema, Entity, Table } from "../src/index.js"

const AppSchema = DynamoSchema.make({ name: "nullrefs", version: 1 })
const byId = {
  pk: { field: "pk", composite: ["id"] },
  sk: { field: "sk", composite: [] },
} as const

class Team extends Schema.Class<Team>("NullRefsTeam")({
  id: Schema.String.pipe(DynamoModel.identifier),
  name: Schema.String,
}) {}
const Teams = Entity.make({ model: Team, entityType: "Team", primaryKey: byId })

class Coach extends Schema.Class<Coach>("NullRefsCoach")({
  id: Schema.String.pipe(DynamoModel.identifier),
  name: Schema.String,
}) {}
const Coaches = Entity.make({ model: Coach, entityType: "Coach", primaryKey: byId })

class Venue extends Schema.Class<Venue>("NullRefsVenue")({
  id: Schema.String.pipe(DynamoModel.identifier),
  name: Schema.String,
}) {}
const Venues = Entity.make({ model: Venue, entityType: "Venue", primaryKey: byId })

class Agent extends Schema.Class<Agent>("NullRefsAgent")({
  id: Schema.String.pipe(DynamoModel.identifier),
  name: Schema.String,
}) {}
const Agents = Entity.make({ model: Agent, entityType: "Agent", primaryKey: byId })

class Player extends Schema.Class<Player>("NullRefsPlayer")({
  id: Schema.String,
  team: Team.pipe(DynamoModel.ref),
  coach: Schema.NullOr(Coach).pipe(DynamoModel.ref),
  venue: Schema.optionalKey(Schema.NullOr(Venue).pipe(DynamoModel.ref)),
  agent: Schema.UndefinedOr(Agent).pipe(DynamoModel.ref),
}) {}
const Players = Entity.make({
  model: Player,
  entityType: "Player",
  primaryKey: byId,
  refs: {
    team: { entity: Teams },
    coach: { entity: Coaches },
    venue: { entity: Venues },
    agent: { entity: Agents },
  },
})

const MainTable = Table.make({
  schema: AppSchema,
  entities: { Teams, Coaches, Venues, Agents, Players },
})

/** The type checker reads the body. Nothing runs it. */
const compiles = (_body: () => unknown) => undefined

describe("a nullable ref", () => {
  it("its id takes null in Entity.Input and Entity.Create; a ref without null's doesn't", () => {
    type Input = Entity.Input<typeof Players>
    expectTypeOf<Input["teamId"]>().toEqualTypeOf<string>()
    expectTypeOf<Input["coachId"]>().toEqualTypeOf<string | null>()
    expectTypeOf<Required<Input>["venueId"]>().toEqualTypeOf<string | null>()
    expectTypeOf<Input["agentId"]>().toEqualTypeOf<string | undefined>()
    const detached: Input = { id: "p", teamId: "t", coachId: null, agentId: undefined }
    const attached: Input = { id: "p", teamId: "t", coachId: "c", venueId: "v", agentId: "a" }
    const venueNull: Input = { id: "p", teamId: "t", coachId: null, venueId: null, agentId: "a" }
    // @ts-expect-error a nullable ref's id is a required key: null, not left out
    const coachLeftOut: Input = { id: "p", teamId: "t", agentId: "a" }
    // @ts-expect-error a ref declared without null takes no null
    const teamNull: Input = { id: "p", teamId: null, coachId: null, agentId: "a" }
    type Create = Entity.Create<typeof Players>
    const created: Create = { id: "p", teamId: "t", coachId: null, agentId: undefined }
    expect([detached, attached, venueNull, coachLeftOut, teamNull, created]).toHaveLength(6)
  })

  it("a bound put takes null; .set() detaches with null; .keepRefs() takes none", () => {
    const db = () =>
      Effect.gen(function* () {
        const client = yield* DynamoClient.make({
          entities: { Teams, Coaches, Venues, Agents, Players },
          tables: { MainTable },
        })
        return client.entities
      })
    type Db = Effect.Success<ReturnType<typeof db>>
    const bound = undefined as unknown as Db
    compiles(() => {
      bound.Players.put({ id: "p", teamId: "t", coachId: null, agentId: undefined })
      bound.Players.create({ id: "p", teamId: "t", coachId: null, venueId: null, agentId: "a" })
      const u = bound.Players.update({ id: "p" })
      u.set({ coachId: null })
      u.set({ venueId: null, coachId: "c" })
      // @ts-expect-error a ref declared without null can't be detached with null
      u.set({ teamId: null })
      u.keepRefs({ coachId: "c" })
      // @ts-expect-error .keepRefs() keeps a ref the row holds; null holds none
      u.keepRefs({ coachId: null })
    })
    expect(true).toBe(true)
  })
})
