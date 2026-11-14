/**
 * A unique constraint over refs names each ref's id (`teamId` for `refs: { team }`), as an index
 * composite does, and composes its sentinel from the id the stored ref holds (#266). Naming the
 * ref itself (`team`) composed `[object object]` for every item, so the first item written took the
 * value for all of them; `Entity.make` refuses it (`EDD-9172`). Connected twin:
 * `connected.unique-over-refs.test.ts`.
 */
import { describe, expect, it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Effect, Layer, Schema } from "effect"
import { beforeEach } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"
import * as Transaction from "../src/Transaction.js"
import { InMemoryClient, resetStore, store } from "./helpers/InMemoryTables.js"

class Team extends Schema.Class<Team>("UniqueRefTeam")({
  id: Schema.String,
  name: Schema.String,
}) {}
class Player extends Schema.Class<Player>("UniqueRefPlayer")({
  id: Schema.String,
  name: Schema.String,
}) {}
class Selection extends Schema.Class<Selection>("UniqueRefSelection")({
  id: Schema.String,
  season: Schema.String,
  team: Team,
  player: Player,
}) {}

const primaryKey = {
  pk: { field: "pk", composite: ["id"] },
  sk: { field: "sk", composite: [] },
} as const

const Teams = Entity.make({
  model: DynamoModel.configure(Team, { id: { identifier: true } }),
  entityType: "Team",
  primaryKey,
})
const Players = Entity.make({
  model: DynamoModel.configure(Player, { id: { identifier: true } }),
  entityType: "Player",
  primaryKey,
})
const model = DynamoModel.configure(Selection, {
  id: { identifier: true },
  team: { ref: true },
  player: { ref: true },
})
const refs = { team: { entity: Teams }, player: { entity: Players } }
const identity = { identity: ["season", "teamId", "playerId"] } as const

const Selections = Entity.make({
  model,
  entityType: "Selection",
  primaryKey,
  refs,
  unique: identity,
})
/** A soft delete releases the sentinel, and `restore` takes it again. */
const Released = Entity.make({
  model,
  entityType: "Released",
  primaryKey,
  refs,
  unique: identity,
  softDelete: true,
})
/** A soft delete keeps the sentinel, and `restore` takes back its own. */
const Preserved = Entity.make({
  model,
  entityType: "Preserved",
  primaryKey,
  refs,
  unique: identity,
  softDelete: { preserveUnique: true },
})

const entities = { Teams, Players, Selections, Released, Preserved }
const MainTable = Table.make({ schema: DynamoSchema.make({ name: "repro", version: 1 }), entities })
const layer = Layer.mergeAll(InMemoryClient, MainTable.layer({ name: "unique-refs" }))
const database = DynamoClient.make({ entities, tables: { MainTable } })

const seed = Effect.gen(function* () {
  const db = yield* database
  for (const id of ["t1", "t2"]) yield* db.entities.Teams.create({ id, name: `Team ${id}` })
  for (const id of ["p1", "p2"]) yield* db.entities.Players.create({ id, name: `Player ${id}` })
  return db
})

/** Each sentinel of `entityType`'s constraint: its partition key, and the item it names. */
const sentinels = (entityType: string) =>
  [...store.values()]
    .filter((row) => row.__edd_e__?.S === `${entityType}._unique.identity`)
    .map((row) => [row.pk?.S, row._entity_pk?.S] as const)
    .sort()

const owner = (entityType: string, id: string) => `$repro#v1#${entityType.toLowerCase()}#id_${id}`
const reserved = (entityType: string, team: string, player: string) =>
  `$repro#v1#${entityType.toLowerCase()}.identity#2025#${team}#${player}`

const tagOf = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.map(Effect.flip(effect), (error) => (error as { readonly _tag: string })._tag)

beforeEach(() => {
  resetStore()
})

describe("a unique constraint over refs", () => {
  it.effect("takes the refs' ids, and reserves the values each item references", () =>
    Effect.gen(function* () {
      const db = yield* seed
      const selections = db.entities.Selections
      yield* selections.create({ id: "s1", season: "2025", teamId: "t1", playerId: "p1" })
      const duplicate = yield* selections
        .create({ id: "s2", season: "2025", teamId: "t1", playerId: "p1" })
        .asEffect()
        .pipe(Effect.flip)
      expect(duplicate).toMatchObject({
        _tag: "UniqueConstraintViolation",
        constraint: "identity",
        fields: { season: "2025", teamId: "t1", playerId: "p1" },
      })
      // Another team and player: on 1.41.0, `[object object]` for both, and refused.
      yield* selections.create({ id: "s3", season: "2025", teamId: "t2", playerId: "p2" })
      yield* selections.upsert({ id: "s4", season: "2025", teamId: "t2", playerId: "p1" })
      expect(
        yield* tagOf(
          selections.insert({ id: "s5", season: "2025", teamId: "t2", playerId: "p1" }).asEffect(),
        ),
      ).toBe("UniqueConstraintViolation")
      expect(sentinels("Selection")).toEqual([
        [reserved("Selection", "t1", "p1"), owner("Selection", "s1")],
        [reserved("Selection", "t2", "p1"), owner("Selection", "s4")],
        [reserved("Selection", "t2", "p2"), owner("Selection", "s3")],
      ])
    }).pipe(Effect.provide(layer)),
  )

  it.effect("moves the reservation when an update reassigns a ref, and frees it on delete", () =>
    Effect.gen(function* () {
      const db = yield* seed
      const selections = db.entities.Selections
      yield* selections.create({ id: "s1", season: "2025", teamId: "t1", playerId: "p1" })
      yield* selections.create({ id: "s2", season: "2025", teamId: "t2", playerId: "p2" })
      yield* selections.update({ id: "s1" }).set({ teamId: "t2" })
      expect(yield* selections.get({ id: "s1" })).toMatchObject({ team: { id: "t2" } })
      expect(sentinels("Selection")).toEqual([
        [reserved("Selection", "t2", "p1"), owner("Selection", "s1")],
        [reserved("Selection", "t2", "p2"), owner("Selection", "s2")],
      ])
      // The value s1 left is free; the one s2 holds is not.
      yield* selections.create({ id: "s3", season: "2025", teamId: "t1", playerId: "p1" })
      expect(yield* tagOf(selections.update({ id: "s2" }).set({ playerId: "p1" }).asEffect())).toBe(
        "UniqueConstraintViolation",
      )

      yield* selections.delete({ id: "s1" })
      expect(sentinels("Selection")).toEqual([
        [reserved("Selection", "t1", "p1"), owner("Selection", "s3")],
        [reserved("Selection", "t2", "p2"), owner("Selection", "s2")],
      ])
      yield* selections.create({ id: "s4", season: "2025", teamId: "t2", playerId: "p1" })
    }).pipe(Effect.provide(layer)),
  )

  it.effect("rotates in a transaction: a planned update and a planned delete", () =>
    Effect.gen(function* () {
      const db = yield* seed
      const selections = db.entities.Selections
      yield* selections.create({ id: "s1", season: "2025", teamId: "t1", playerId: "p1" })
      yield* selections.create({ id: "s2", season: "2025", teamId: "t2", playerId: "p2" })
      yield* Transaction.transactWrite([
        selections.update({ id: "s1" }).set({ playerId: "p2" }),
        selections.delete({ id: "s2" }),
      ])
      expect(sentinels("Selection")).toEqual([
        [reserved("Selection", "t1", "p2"), owner("Selection", "s1")],
      ])
      yield* selections.create({ id: "s3", season: "2025", teamId: "t2", playerId: "p2" })
      expect(
        yield* tagOf(
          Transaction.transactWrite([selections.update({ id: "s1" }).set({ teamId: "t2" })]),
        ),
      ).toBe("UniqueConstraintViolation")
    }).pipe(Effect.provide(layer)),
  )

  it.effect("restore takes the value again, preserveUnique off", () =>
    Effect.gen(function* () {
      const db = yield* seed
      const released = db.entities.Released
      yield* released.create({ id: "s1", season: "2025", teamId: "t1", playerId: "p1" })
      yield* released.delete({ id: "s1" })
      expect(sentinels("Released")).toEqual([])
      yield* released.restore({ id: "s1" })
      expect(sentinels("Released")).toEqual([
        [reserved("Released", "t1", "p1"), owner("Released", "s1")],
      ])
      expect(
        yield* tagOf(
          released.create({ id: "s2", season: "2025", teamId: "t1", playerId: "p1" }).asEffect(),
        ),
      ).toBe("UniqueConstraintViolation")
    }).pipe(Effect.provide(layer)),
  )

  it.effect("restore takes back its own reservation, preserveUnique on", () =>
    Effect.gen(function* () {
      const db = yield* seed
      const preserved = db.entities.Preserved
      yield* preserved.create({ id: "s1", season: "2025", teamId: "t1", playerId: "p1" })
      yield* preserved.delete({ id: "s1" })
      const kept = [[reserved("Preserved", "t1", "p1"), owner("Preserved", "s1")]]
      expect(sentinels("Preserved")).toEqual(kept)
      expect(
        yield* tagOf(
          preserved.create({ id: "s2", season: "2025", teamId: "t1", playerId: "p1" }).asEffect(),
        ),
      ).toBe("UniqueConstraintViolation")
      yield* preserved.restore({ id: "s1" })
      expect(sentinels("Preserved")).toEqual(kept)
    }).pipe(Effect.provide(layer)),
  )

  it("refuses the ref itself, naming its id (EDD-9172)", () => {
    expect(() =>
      Entity.make({
        model,
        entityType: "Selection",
        primaryKey,
        refs,
        // @ts-expect-error a ref is the referenced item's data: its id is the value
        unique: { identity: ["season", "team", "player"] },
      }),
    ).toThrow(/\[EDD-9172\] .*unique constraint "identity" names ref "team".*"teamId"/)
  })
})
