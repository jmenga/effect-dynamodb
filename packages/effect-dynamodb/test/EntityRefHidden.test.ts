/**
 * A ref to an entity with a `DynamoModel.Hidden` field (#241). A read of that entity leaves the field
 * out, and a ref holds what a read returns: put-time hydration and a cascade both store the item the
 * read gave, through `refDataOf`, and the referencing entity reads its ref through `refHeldSchema`.
 *
 * Up to 1.40.0, with the hidden field required, the ref was read as the whole target: the `put`
 * wrote its row, without the field, then failed (`Missing key at ["team"]["secret"]`), and every
 * read of the row failed the same way, under every lifecycle (plain, retained, unique, soft
 * delete). Now the ref is the target's other fields, a plain object as the target's own read
 * returns it; the row is stored byte for byte as 1.40.0 stored it, and rows 1.40.0 stored read.
 * With the hidden field optional nothing changes: the ref reads back as the target's class.
 *
 * `fixtures/entity-ref-hidden-1.40.0.json` holds what published 1.40.0 returned and stored.
 */

import { readFileSync } from "node:fs"
import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { describe, expect, it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

type Row = Record<string, AttributeValue>
type Case = {
  readonly put: any
  readonly get: any
  readonly put2: any
  readonly rows: ReadonlyArray<Row>
}
const published = JSON.parse(
  readFileSync(new URL("./fixtures/entity-ref-hidden-1.40.0.json", import.meta.url), "utf8"),
) as { readonly generatedFrom: ReadonlyArray<string>; readonly cases: Record<string, Case> }

const KINDS = ["plain", "retain", "unique", "soft"] as const
type Kind = (typeof KINDS)[number]

const define = (kind: Kind, hiddenRequired: boolean) => {
  class Team extends Schema.Class<Team>("Team")({
    id: Schema.Number.pipe(DynamoModel.identifier),
    name: Schema.String,
    secret: hiddenRequired
      ? Schema.String.pipe(DynamoModel.Hidden)
      : Schema.optionalKey(Schema.String.pipe(DynamoModel.Hidden)),
  }) {}
  const Teams = Entity.make({
    model: Team,
    entityType: "Team",
    primaryKey: {
      pk: { field: "pk", composite: ["id"] },
      sk: { field: "sk", composite: [] },
    },
  } as never) as any
  const Player = Schema.Struct({
    id: Schema.String,
    email: Schema.String,
    team: Team.pipe(DynamoModel.ref),
  })
  const Players = Entity.make({
    model: Player,
    entityType: "Player",
    primaryKey: {
      pk: { field: "pk", composite: ["id"] },
      sk: { field: "sk", composite: [] },
    },
    refs: {
      team: {
        entity: Teams,
        cascade: { index: "gsi1", pk: { field: "gsi1pk" }, sk: { field: "gsi1sk" } },
      },
    },
    ...(kind === "retain" ? { versioned: { retain: true } } : {}),
    ...(kind === "unique" ? { unique: { email: ["email"] } } : {}),
    ...(kind === "soft" ? { softDelete: true } : {}),
  } as never) as any
  const Main = Table.make({
    schema: DynamoSchema.make({ name: "hid", version: 1 }),
    entities: { Teams, Players },
  })
  return { Team, Teams, Players, Main }
}

const outcome = (exit: Exit.Exit<unknown, unknown>): any => {
  if (Exit.isSuccess(exit)) return { ok: JSON.parse(JSON.stringify(exit.value)) }
  const failure = Cause.squash(exit.cause) as any
  return {
    failed: String(failure?._tag),
    operation: failure?.operation,
    cause: String(failure?.cause?.message ?? failure?.cause ?? failure?.message),
  }
}

const session = <A>(
  kind: Kind,
  hiddenRequired: boolean,
  seeded: ReadonlyArray<Row>,
  body: (
    db: any,
    defs: ReturnType<typeof define>,
    rows: () => ReadonlyArray<Row>,
  ) => Effect.Effect<A, unknown, any>,
) => {
  const defs = define(kind, hiddenRequired)
  const table = makeRecordingTable({ indexes: { gsi1: { pk: "gsi1pk", sk: "gsi1sk" } } })
  for (const row of seeded) table.items.set(`${row.pk?.S}|${row.sk?.S}`, row as never)
  const rows = () =>
    ([...table.items.values()] as ReadonlyArray<Row>).filter((row) => row.__edd_e__?.S === "Player")
  return Effect.gen(function* () {
    const db = yield* DynamoClient.make({
      entities: { Teams: defs.Teams, Players: defs.Players },
      tables: { Main: defs.Main },
    })
    return yield* body(db, defs, rows)
  }).pipe(Effect.provide(Layer.merge(table.layer, defs.Main.layer({ name: "table" }))))
}
/** A row as stored, its random incarnation token aside. */
const stored = (rows: ReadonlyArray<Row>) =>
  rows
    .map(({ __edd_i__, ...row }) => row)
    .sort((a, b) => (`${a.pk?.S}|${a.sk?.S}` < `${b.pk?.S}|${b.sk?.S}` ? -1 : 1))

describe("a ref to an entity with a DynamoModel.Hidden field (#241)", () => {
  it("the fixture is published 1.40.0's: with the field required, put stored its row and then failed, and every read failed", () => {
    expect(published.generatedFrom).toEqual(["effect-dynamodb@1.40.0"])
    for (const kind of KINDS) {
      const then = published.cases[`${kind} hidden required`]!
      const missing = {
        failed: "ValidationError",
        operation: "decode",
        cause: 'Missing key\n  at ["team"]["secret"]',
      }
      expect(then.put).toEqual(missing)
      expect(then.get).toEqual(missing)
      expect(then.put2).toEqual(missing)
      expect(
        then.rows.find((row) => row.sk?.S === "$hid#v1#player" && row.id?.S === "p1")?.team,
      ).toEqual({ M: { name: { S: "Before" }, id: { N: "5" } } })
    }
  })

  for (const kind of KINDS) {
    for (const hiddenRequired of [true, false]) {
      const name = `${kind} hidden ${hiddenRequired ? "required" : "optional"}`
      const then = published.cases[name]!

      it.effect(
        `${name}: put, get, cascade and a second put succeed, and the row is stored as 1.40.0 stored it`,
        () =>
          session(kind, hiddenRequired, [], (db, defs, rows) =>
            Effect.gen(function* () {
              yield* db.entities.Teams.put({ id: 5, name: "Before", secret: "s" }).asEffect()
              const put = yield* Effect.exit(
                db.entities.Players.put({ id: "p1", email: "a", teamId: 5 }).asEffect(),
              )
              const afterPut = stored(rows())
              const get = yield* Effect.exit(db.entities.Players.get({ id: "p1" }))
              yield* db.entities.Teams.update({ id: 5 })
                .set({ name: "After" })
                .cascade({ targets: [defs.Players] })
                .asEffect()
              const getAfter = yield* Effect.exit(db.entities.Players.get({ id: "p1" }))
              const put2 = yield* Effect.exit(
                db.entities.Players.put({ id: "p2", email: "b", teamId: 5 }).asEffect(),
              )
              const before = { id: 5, name: "Before" }
              const extra = kind === "retain" ? { version: 1 } : {}
              expect(outcome(put)).toEqual({ ok: { id: "p1", email: "a", team: before, ...extra } })
              expect(outcome(get)).toEqual(outcome(put))
              // The ref is what a read of the target returns: a plain object without the required
              // hidden field; the target's class where the field is optional, as on 1.40.0.
              const team = Exit.isSuccess(get) ? (get.value as any).team : undefined
              expect(team instanceof defs.Team).toBe(!hiddenRequired)
              expect(team).not.toHaveProperty("secret")
              expect(outcome(getAfter)).toEqual({
                ok: { id: "p1", email: "a", team: { id: 5, name: "After" }, ...extra },
              })
              expect(outcome(put2)).toEqual({
                ok: { id: "p2", email: "b", team: { id: 5, name: "After" }, ...extra },
              })
              // Stored as 1.40.0 stored it, where its `put` failed after writing.
              expect(afterPut).toEqual(stored(then.rows.filter((row) => row.id?.S === "p1")))
              if (!hiddenRequired) {
                expect({ put: outcome(put), get: outcome(get) }).toEqual({
                  put: then.put,
                  get: then.get,
                })
              }
            }),
          ),
      )
    }

    it.effect(`${kind}: the rows 1.40.0 stored with the field required read`, () => {
      const then = published.cases[`${kind} hidden required`]!
      const extra = kind === "retain" ? { version: 1 } : {}
      return session(kind, true, then.rows, (db) =>
        Effect.gen(function* () {
          const get = yield* Effect.exit(db.entities.Players.get({ id: "p1" }))
          const p2 = yield* Effect.exit(db.entities.Players.get({ id: "p2" }))
          expect([outcome(get), outcome(p2)]).toEqual([
            { ok: { id: "p1", email: "a", team: { id: 5, name: "Before" }, ...extra } },
            { ok: { id: "p2", email: "b", team: { id: 5, name: "After" }, ...extra } },
          ])
        }),
      )
    })
  }

  it.effect("retained: versions and getVersion read a snapshot holding the ref", () =>
    session("retain", true, [], (db) =>
      Effect.gen(function* () {
        yield* db.entities.Teams.put({ id: 5, name: "Before", secret: "s" }).asEffect()
        yield* db.entities.Players.put({ id: "p1", email: "a", teamId: 5 }).asEffect()
        yield* db.entities.Players.update({ id: "p1" }).set({ email: "c" }).asEffect()
        const versions = yield* db.entities.Players.versions({ id: "p1" }).collect()
        const first = yield* db.entities.Players.getVersion({ id: "p1" }, 1)
        // The snapshot of version 1, which the update kept.
        expect(JSON.parse(JSON.stringify(versions))).toEqual([
          { id: "p1", email: "a", team: { id: 5, name: "Before" }, version: 1 },
        ])
        expect(JSON.parse(JSON.stringify(first)).team).toEqual({ id: 5, name: "Before" })
      }),
    ),
  )

  it.effect("soft delete: deleted.get and restore read the ref", () =>
    session("soft", true, [], (db) =>
      Effect.gen(function* () {
        yield* db.entities.Teams.put({ id: 5, name: "Before", secret: "s" }).asEffect()
        yield* db.entities.Players.put({ id: "p1", email: "a", teamId: 5 }).asEffect()
        yield* db.entities.Players.delete({ id: "p1" }).asEffect()
        const deleted = yield* db.entities.Players.deleted.get({ id: "p1" })
        expect(JSON.parse(JSON.stringify(deleted)).team).toEqual({ id: 5, name: "Before" })
        const restored = yield* db.entities.Players.restore({ id: "p1" })
        expect(JSON.parse(JSON.stringify(restored))).toEqual({
          id: "p1",
          email: "a",
          team: { id: 5, name: "Before" },
        })
      }),
    ),
  )
})
