/**
 * A 1.40.0 writer on a group this release keyed under `escapeKeys: true` (#241, DESIGN.md §11
 * "Writers of two releases"). 1.40.0 composes an `entity:` edge's sort key from the stored text
 * (`bulktally#2`), this release from the value (`bulktally#0000000000000002`). Reading a group this
 * release wrote, 1.40.0 writes the group under its own text beside those rows, deleting none: each
 * element is then stored twice, and an element it removed stays under this release's text.
 *
 * - Two rows of one element that a read gives the same value of (copies, differing in key text and
 *   the library's timestamps) read as the element once; a changed `update` of the group deletes the
 *   copy under 1.40.0's text, each element keeping its row's `created`; `rekey` deletes the copies.
 * - Two that differ read as two elements. A write of the group that holds both is refused, naming
 *   both rows; `rekey` reports them (`bothKeys`) and moves nothing. An `update` stating the
 *   elements the group should hold, one for each key, leaves exactly those rows.
 * - An element 1.40.0 removed reads again; an `update` stating the elements removes it.
 *
 * `fixtures/aggregate-mixed-writers-1.40.0.json` holds the rows this release wrote and what
 * published 1.40.0 did to them. Run by the entity-edge-keys runners.
 */

import { readFileSync } from "node:fs"
import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Cause, Effect, Exit, Schema } from "effect"
import { describe, expect } from "vitest"
import * as Aggregate from "../../src/Aggregate.js"
import { DynamoClient } from "../../src/DynamoClient.js"
import * as Entity from "../../src/Entity.js"
import * as Table from "../../src/Table.js"
import type { Harness } from "./AggregateEntityEdgeKeys.js"

type Row = Record<string, AttributeValue>
type Scenario = {
  readonly before: ReadonlyArray<Row>
  readonly get: any
  readonly update: any
  readonly after: ReadonlyArray<Row>
  readonly getAfter: any
}
const published = JSON.parse(
  readFileSync(new URL("../fixtures/aggregate-mixed-writers-1.40.0.json", import.meta.url), "utf8"),
) as {
  readonly generatedFrom: ReadonlyArray<string>
  readonly scenarios: Record<"title" | "label" | "remove" | "add", Scenario>
}

const Tally = Schema.Struct({
  tallyId: Schema.String,
  n: Schema.NumberFromString,
  label: Schema.String,
})
const Bulk = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  tallies: Schema.Array(Tally),
})
const schema = DynamoSchema.make({ name: "mixed", version: 1, escapeKeys: true })
const Tallies = Entity.make({
  model: DynamoModel.configure(Tally, { tallyId: { identifier: true } }),
  entityType: "Tally",
  primaryKey: {
    pk: { field: "pk", composite: ["tallyId"] },
    sk: { field: "sk", composite: [] },
  },
} as never) as any
const Main = Table.make({ schema, entities: { Tallies } })
const Bulks = (Aggregate.make as any)(Bulk, {
  table: Main,
  schema,
  pk: { field: "pk", composite: ["id"] },
  collection: { name: "bulk" },
  timestamps: true,
  root: { entityType: "Bulk" },
  edges: {
    tallies: (Aggregate.many as any)({
      entity: Tallies,
      entityType: "BulkTally",
      sk: { composite: ["n"] },
    }),
  },
})

const tally = (i: number, label = `l${i}`) => ({ tallyId: `t${i}`, n: i, label })
const NEW = (i: number) => `$mixed#v1#bulktally#${String(i).padStart(16, "0")}`
const OLD = (i: number) => `$mixed#v1#bulktally#${i}`
const ROOT = "$mixed#v1#bulk"
const skOf = (row: Row) => row.sk!.S!
const sks = (rows: ReadonlyArray<Row>) => rows.map(skOf).sort()
const at = (rows: ReadonlyArray<Row>, sk: string) => rows.find((row) => skOf(row) === sk)
const outcome = (exit: Exit.Exit<unknown, unknown>): any => {
  if (Exit.isSuccess(exit)) return { ok: JSON.parse(JSON.stringify(exit.value)) }
  const failure = Cause.squash(exit.cause) as any
  return { fail: String(failure?._tag), reason: failure?.reason, error: failure }
}
const tallies = (result: any) =>
  (result.ok.tallies as ReadonlyArray<any>).map((t) => `${t.tallyId}:${t.label}`)

/** Runs `body` on a fresh table holding `seeded`, with a client and the requests sent since. */
const session = <A>(
  harness: Harness,
  seeded: ReadonlyArray<Row>,
  body: (
    db: any,
    rows: () => Effect.Effect<ReadonlyArray<Row>>,
    sent: () => Effect.Effect<ReadonlyArray<{ readonly command: string; readonly input: any }>>,
  ) => Effect.Effect<A, unknown, any>,
) =>
  harness.onTable((tableName) =>
    Effect.gen(function* () {
      yield* harness.seed(tableName, seeded)
      const db = yield* DynamoClient.make({
        entities: { Tallies },
        aggregates: { Bulks },
        tables: { Main },
      })
      yield* harness.requests(tableName)
      return yield* body(
        db,
        () => harness.rows(tableName),
        () => harness.requests(tableName),
      )
    }).pipe(Effect.provide(Main.layer({ name: tableName }))),
  )

const rekeyed = (outcome: any) => ({
  moved: outcome.ok.byMember?.Bulk?.moved?.aggregate ?? 0,
  conflicts: (outcome.ok.conflicts as ReadonlyArray<any>)
    .filter((conflict) => conflict.member === "Bulk")
    .map(({ reason, key, target }) => ({ reason, key: key?.sk, target: target?.sk })),
})

export const mixedWritersSuite = (
  harness: Harness,
  describeIt: (name: string, body: () => void) => void = describe,
) =>
  describeIt("a 1.40.0 writer on a group this release keyed, under escapeKeys: true (#241)", () => {
    const { title, label, remove, add } = published.scenarios

    it("the fixture is published 1.40.0's: it writes the group under its text beside this release's rows", () => {
      expect(published.generatedFrom).toEqual(["effect-dynamodb@1.40.0"])
      expect(sks(title.before)).toEqual([ROOT, NEW(1), NEW(2), NEW(3)])
      expect(sks(title.after)).toEqual([ROOT, NEW(1), NEW(2), NEW(3), OLD(1), OLD(2), OLD(3)])
      // Each element twice, on 1.40.0's read too.
      expect(tallies(title.getAfter)).toEqual([
        "t1:l1",
        "t2:l2",
        "t3:l3",
        "t1:l1",
        "t2:l2",
        "t3:l3",
      ])
      // Its rows are stamped by its write: `created` too, which it finds under no key of its text.
      for (const i of [1, 2, 3]) {
        expect(at(title.after, OLD(i))!.createdAt).not.toEqual(at(title.after, NEW(i))!.createdAt)
      }
      expect(at(label.after, OLD(2))!.label).toEqual({ S: "B" })
      expect(at(label.after, NEW(2))!.label).toEqual({ S: "l2" })
      // An element it removed stays under this release's text, and its read returns it.
      expect(sks(remove.after)).toEqual([ROOT, NEW(1), NEW(2), NEW(3), OLD(1), OLD(2)])
      expect(tallies(remove.getAfter)).toContain("t3:l3")
      expect(sks(add.after)).toContain(OLD(4))
    })

    it.effect(
      "copies of one element read once; a changed update deletes the copies under 1.40.0's text, each row keeping its created",
      () =>
        session(harness, title.after, (db, rows, sent) =>
          Effect.gen(function* () {
            const get = outcome(yield* Effect.exit(db.aggregates.Bulks.get({ id: "title" })))
            expect(tallies(get)).toEqual(["t1:l1", "t2:l2", "t3:l3"])
            expect(get.ok.title).toBe("t2")
            // A no-op writes nothing: the copies stay, and read once.
            yield* sent()
            yield* db.aggregates.Bulks.update({ id: "title" }, ({ state }: any) => state)
            expect((yield* sent()).map((r) => r.command)).toEqual(["Query"])
            const updated = outcome(
              yield* Effect.exit(
                db.aggregates.Bulks.update({ id: "title" }, ({ state }: any) => ({
                  ...state,
                  title: "t3",
                })),
              ),
            )
            expect(tallies(updated)).toEqual(["t1:l1", "t2:l2", "t3:l3"])
            const writes = (yield* sent()).filter((r) => r.command === "TransactWriteItems")
            expect(writes).toHaveLength(1)
            const deleted = (writes[0]!.input.TransactItems as ReadonlyArray<any>)
              .filter((item) => item.Delete !== undefined)
              .map((item) => item.Delete.Key.sk.S)
              .sort()
            expect(deleted).toEqual([OLD(1), OLD(2), OLD(3)])
            const now = yield* rows()
            expect(sks(now)).toEqual([ROOT, NEW(1), NEW(2), NEW(3)])
            for (const i of [1, 2, 3]) {
              expect({ i, created: at(now, NEW(i))!.createdAt }).toEqual({
                i,
                created: at(title.before, NEW(i))!.createdAt,
              })
            }
          }),
        ),
    )

    it.effect(
      "rekey deletes each copy under 1.40.0's text, leaving the rows under this release's as they are",
      () =>
        session(harness, title.after, (db, rows) =>
          Effect.gen(function* () {
            const dry = outcome(yield* Effect.exit(db.tables.Main.rekey({ dryRun: true })))
            expect(rekeyed(dry)).toEqual({ moved: 3, conflicts: [] })
            expect(sks(yield* rows())).toEqual(sks(title.after))
            const rekey = outcome(yield* Effect.exit(db.tables.Main.rekey()))
            expect(rekeyed(rekey)).toEqual({ moved: 3, conflicts: [] })
            const now = yield* rows()
            expect(sks(now)).toEqual([ROOT, NEW(1), NEW(2), NEW(3)])
            for (const sk of sks(now)) expect(at(now, sk)).toEqual(at(title.after, sk))
            const again = outcome(yield* Effect.exit(db.tables.Main.rekey({ dryRun: true })))
            expect(rekeyed(again)).toEqual({ moved: 0, conflicts: [] })
          }),
        ),
    )

    it.effect(
      "two rows of one element that differ: read as two, a write holding both is refused naming both rows, rekey reports them, and an update stating the elements leaves exactly those rows",
      () =>
        session(harness, label.after, (db, rows, sent) =>
          Effect.gen(function* () {
            const get = outcome(yield* Effect.exit(db.aggregates.Bulks.get({ id: "label" })))
            expect(tallies(get)).toEqual(["t1:l1", "t2:l2", "t3:l3", "t2:B"])
            yield* sent()
            const title = outcome(
              yield* Effect.exit(
                db.aggregates.Bulks.update({ id: "label" }, ({ state }: any) => ({
                  ...state,
                  title: "t2",
                })),
              ),
            )
            expect(title.fail).toBe("AggregateDecompositionError")
            expect(title.reason).toBe(
              `"tallies" holds two values of the element keyed "${NEW(2)}": the row stored there ` +
                `and the row under "${OLD(2)}", the key text 1.40.0 composed, hold different ` +
                "values, as a 1.40.0 writer leaves a group this release keyed, so one would " +
                'overwrite the other. Update the aggregate stating the elements "tallies" should ' +
                "hold, one for each key: that write stores them under this release's key text and " +
                "deletes the rows under 1.40.0's.",
            )
            expect((yield* sent()).map((r) => r.command)).toEqual(["Query"])
            expect(sks(yield* rows())).toEqual(sks(label.after))
            const rekey = outcome(yield* Effect.exit(db.tables.Main.rekey()))
            expect(rekeyed(rekey)).toEqual({
              moved: 0,
              conflicts: [{ reason: "bothKeys", key: OLD(2), target: NEW(2) }],
            })
            expect(sks(yield* rows())).toEqual(sks(label.after))
            // The way out: the elements the group should hold, one for each key.
            const stated = outcome(
              yield* Effect.exit(
                db.aggregates.Bulks.update({ id: "label" }, ({ state }: any) => ({
                  ...state,
                  tallies: [tally(1), tally(2, "B"), tally(3)],
                })),
              ),
            )
            expect(tallies(stated)).toEqual(["t1:l1", "t2:B", "t3:l3"])
            const now = yield* rows()
            expect(sks(now)).toEqual([ROOT, NEW(1), NEW(2), NEW(3)])
            expect(at(now, NEW(2))!.label).toEqual({ S: "B" })
            expect(at(now, NEW(1))!.createdAt).toEqual(at(label.before, NEW(1))!.createdAt)
            const get2 = outcome(yield* Effect.exit(db.aggregates.Bulks.get({ id: "label" })))
            expect(get2).toEqual(stated)
            const again = outcome(yield* Effect.exit(db.tables.Main.rekey({ dryRun: true })))
            expect(rekeyed(again)).toEqual({ moved: 0, conflicts: [] })
          }),
        ),
    )

    it.effect(
      "an element 1.40.0 removed reads again, and an update stating the elements removes it",
      () =>
        session(harness, remove.after, (db, rows) =>
          Effect.gen(function* () {
            const get = outcome(yield* Effect.exit(db.aggregates.Bulks.get({ id: "remove" })))
            expect(tallies(get)).toEqual(["t1:l1", "t2:l2", "t3:l3"])
            const stated = outcome(
              yield* Effect.exit(
                db.aggregates.Bulks.update({ id: "remove" }, ({ state }: any) => ({
                  ...state,
                  tallies: [tally(1), tally(2)],
                })),
              ),
            )
            expect(tallies(stated)).toEqual(["t1:l1", "t2:l2"])
            expect(sks(yield* rows())).toEqual([ROOT, NEW(1), NEW(2)])
          }),
        ),
    )

    it.effect("an element 1.40.0 added is moved by the next changed update, with the copies", () =>
      session(harness, add.after, (db, rows) =>
        Effect.gen(function* () {
          const get = outcome(yield* Effect.exit(db.aggregates.Bulks.get({ id: "add" })))
          expect(tallies(get)).toEqual(["t1:l1", "t2:l2", "t3:l3", "t4:l4"])
          const updated = outcome(
            yield* Effect.exit(
              db.aggregates.Bulks.update({ id: "add" }, ({ state }: any) => ({
                ...state,
                title: "t2",
              })),
            ),
          )
          expect(tallies(updated)).toEqual(["t1:l1", "t2:l2", "t3:l3", "t4:l4"])
          const now = yield* rows()
          expect(sks(now)).toEqual([ROOT, NEW(1), NEW(2), NEW(3), NEW(4)])
          expect(at(now, NEW(4))!.createdAt).toEqual(at(add.after, OLD(4))!.createdAt)
        }),
      ),
    )
  })
