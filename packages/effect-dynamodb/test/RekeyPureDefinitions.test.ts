/**
 * `rekey` judges the rows of an entity made with `@effect-dynamodb/schema`'s pure `Entity.make` as
 * it judges one made with `effect-dynamodb`'s (#265). `DynamoClient.make` promotes a pure
 * definition to bind it; up to the fix `rekey` looked at the definitions as given, found no handler
 * on them and counted their rows `skipped.unregistered`, though the client read and wrote them.
 *
 * The same rows are written and judged with members made by either package, through a client that
 * binds the table (`tables`) and one that binds only entities; a member of the table the client
 * doesn't bind itself is judged too. A row of a type no member has stays `unregistered`.
 */
import { describe, expect, it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import * as PureEntity from "@effect-dynamodb/schema/Entity.js"
import { Effect, Layer, Schema } from "effect"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import type { RekeyReport } from "../src/Table.js"
import * as Table from "../src/Table.js"
import { indexesOf } from "./helpers/DynamoExpressions.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

class Team extends Schema.Class<Team>("Team")({ id: Schema.String, name: Schema.String }) {}
class Player extends Schema.Class<Player>("Player")({ id: Schema.String, teamId: Schema.String }) {}

const teams = {
  model: DynamoModel.configure(Team, { id: { identifier: true } }),
  entityType: "Team",
  primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
  indexes: {
    byName: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: [] },
      sk: { field: "gsi1sk", composite: ["name"] },
    },
  },
} as const

const players = {
  model: Player,
  entityType: "Player",
  primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
} as const

/** The issue's options. */
const OPTIONS = { dryRun: true, repairIndexKeys: true } as const

/**
 * The members made with one package: `write` puts a row of each through a client binding both;
 * `viaTable` runs `rekey` through a client binding the table and, of its members, only `Teams`;
 * `viaEntities` through one binding both and no table (its operations are under the physical name).
 */
const world = (made: "pure" | "runtime") => {
  const schema = DynamoSchema.make({ name: "repro", version: 1 })
  if (made === "pure") {
    const Teams = PureEntity.make(teams)
    const Players = PureEntity.make(players)
    const MainTable = Table.make({ schema, entities: { Teams, Players } })
    return {
      MainTable,
      write: Effect.gen(function* () {
        const db = yield* DynamoClient.make({ entities: { Teams, Players }, tables: { MainTable } })
        yield* db.entities.Teams.create({ id: "t1", name: "Team One" }).asEffect()
        yield* db.entities.Players.create({ id: "p1", teamId: "t1" }).asEffect()
      }),
      viaTable: Effect.flatMap(
        DynamoClient.make({ entities: { Teams }, tables: { MainTable } }),
        (db) => db.tables.MainTable.rekey(OPTIONS),
      ),
      viaEntities: Effect.flatMap(DynamoClient.make({ entities: { Teams, Players } }), (db) =>
        db.tables.t!.rekey(OPTIONS),
      ),
    }
  }
  const Teams = Entity.make(teams)
  const Players = Entity.make(players)
  const MainTable = Table.make({ schema, entities: { Teams, Players } })
  return {
    MainTable,
    write: Effect.gen(function* () {
      const db = yield* DynamoClient.make({ entities: { Teams, Players }, tables: { MainTable } })
      yield* db.entities.Teams.create({ id: "t1", name: "Team One" }).asEffect()
      yield* db.entities.Players.create({ id: "p1", teamId: "t1" }).asEffect()
    }),
    viaTable: Effect.flatMap(
      DynamoClient.make({ entities: { Teams }, tables: { MainTable } }),
      (db) => db.tables.MainTable.rekey(OPTIONS),
    ),
    viaEntities: Effect.flatMap(DynamoClient.make({ entities: { Teams, Players } }), (db) =>
      db.tables.t!.rekey(OPTIONS),
    ),
  }
}

const run = (made: "pure" | "runtime", client: "viaTable" | "viaEntities") =>
  Effect.gen(function* () {
    const w = world(made)
    const table = makeRecordingTable({ indexes: indexesOf(Table.definition(w.MainTable)) })
    const on = Effect.provide(Layer.merge(table.layer, w.MainTable.layer({ name: "t" })))
    yield* w.write.pipe(on)
    // A row of an entity no member of this client has: another service's.
    table.seed("t", {
      pk: { S: "$repro#v1#coach#id_c1" },
      sk: { S: "$repro#v1#coach" },
      __edd_e__: { S: "Coach" },
    })
    return yield* w[client].pipe(on)
  })

const verdict = (report: RekeyReport) => ({
  scanned: report.scanned,
  unchanged: report.unchanged,
  moved: report.moved,
  indexKeys: report.indexKeys,
  skipped: report.skipped,
  members: Object.keys(report.byMember).sort(),
})

describe("rekey judges a pure definition's rows as an operational entity's (#265)", () => {
  for (const client of ["viaTable", "viaEntities"] as const) {
    it.effect(`the issue's rows, through a client bound ${client}`, () =>
      Effect.gen(function* () {
        const pure = verdict(yield* run("pure", client))
        const runtime = verdict(yield* run("runtime", client))
        expect(pure).toEqual(runtime)
        expect(pure.scanned).toBe(3)
        expect(pure.unchanged).toBe(2)
        expect(pure.skipped.unregistered).toBe(1)
        expect(pure.members).toEqual(["Player", "Team"])
      }),
    )
  }
})
