/**
 * `.keepRefs()` at the type level (#263): it takes the ids of the entity's refs, each typed as
 * `.set()` takes it, and is uncallable on an entity without refs. It widens the error channel with
 * `ConditionalCheckFailed`, which a row holding another ref fails it with. The run-time behaviour
 * is pinned in `helpers/EntityRefKeep.ts`. Nothing here runs: an effect built inside `compiles` is
 * never executed.
 */
import { Effect, Schema } from "effect"
import { describe, expect, expectTypeOf, it } from "vitest"
import {
  type ConditionalCheckFailed,
  DynamoClient,
  DynamoModel,
  DynamoSchema,
  Entity,
  Table,
} from "../src/index.js"

const AppSchema = DynamoSchema.make({ name: "keeprefs", version: 1 })
const byId = {
  pk: { field: "pk", composite: ["id"] },
  sk: { field: "sk", composite: [] },
} as const

class Team extends Schema.Class<Team>("KeepRefsTeam")({
  id: Schema.String.pipe(DynamoModel.identifier),
  name: Schema.String,
}) {}
const Teams = Entity.make({ model: Team, entityType: "Team", primaryKey: byId })

class Player extends Schema.Class<Player>("KeepRefsPlayer")({
  id: Schema.String.pipe(DynamoModel.identifier),
  name: Schema.String,
}) {}
const Players = Entity.make({ model: Player, entityType: "Player", primaryKey: byId })

class Selection extends Schema.Class<Selection>("KeepRefsSelection")({
  id: Schema.String,
  season: Schema.String,
  team: Team.pipe(DynamoModel.ref),
  player: Player.pipe(DynamoModel.ref),
}) {}
const Selections = Entity.make({
  model: Selection,
  entityType: "Selection",
  primaryKey: byId,
  indexes: {
    bySeason: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["season"] },
      sk: { field: "gsi1sk", composite: ["teamId", "playerId"] },
    },
  },
  refs: { team: { entity: Teams }, player: { entity: Players } },
})

const MainTable = Table.make({ schema: AppSchema, entities: { Teams, Players, Selections } })

/** The type checker reads the body. Nothing runs it. */
const compiles = (_body: () => unknown) => undefined

describe(".keepRefs()", () => {
  it("takes the entity's ref ids, and nothing on an entity without refs", () => {
    const db = () =>
      Effect.gen(function* () {
        const client = yield* DynamoClient.make({
          entities: { Teams, Players, Selections },
          tables: { MainTable },
        })
        return client.entities
      })
    type Db = Effect.Success<ReturnType<typeof db>>
    const bound = undefined as unknown as Db
    compiles(() => {
      const kept = bound.Selections.update({ id: "s" })
        .set({ season: "2025", teamId: "t2" })
        .keepRefs({ playerId: "p1" })
      bound.Selections.patch({ id: "s" }).keepRefs({ teamId: "t1", playerId: "p1" })
      expectTypeOf(kept.asEffect()).toExtend<Effect.Effect<Selection, unknown>>()
      // A row holding another ref fails it.
      expectTypeOf<ConditionalCheckFailed>().toExtend<
        Effect.Error<ReturnType<typeof kept.asEffect>>
      >()
      // @ts-expect-error a typo: no ref is named `playrId`
      bound.Selections.update({ id: "s" }).keepRefs({ playrId: "p1" })
      // @ts-expect-error a model field is no ref id
      bound.Selections.update({ id: "s" }).keepRefs({ season: "2025" })
      // @ts-expect-error an id of the ref's identifier type
      bound.Selections.update({ id: "s" }).keepRefs({ playerId: 1 })
      // @ts-expect-error an entity without refs has none to keep
      bound.Teams.update({ id: "t1" }).keepRefs({ teamId: "t1" })
    })
    expect(true).toBe(true)
  })

  it("is pipeable on an unbound update", () => {
    compiles(() =>
      Selections.update({ id: "s" }).pipe(
        Entity.set({ season: "2025", teamId: "t2" }),
        Entity.keepRefs({ playerId: "p1" }),
      ),
    )
    expect(true).toBe(true)
  })
})
