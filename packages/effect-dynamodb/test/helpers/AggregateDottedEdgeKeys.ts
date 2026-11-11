/**
 * An `entity:` many edge keyed by a dotted composite (`nested.n`, `code.c`) through a field the
 * entity's model encodes as a whole (#241, DESIGN.md §11 "An `entity:` edge's sort key"). 1.40.0
 * read such a path off the field's stored form (`{ n: 5 }` stored as `{ n: "5" }`, so `bynested#5`),
 * where a plain edge reads the value (`bynested#0000000000000005`). Whether a composite's text
 * changes is decided for a dotted path as for a top-level one (`entityEdgeKeyRecomposed`): by the
 * field the path starts at. So it moves exactly as a top-level composite does:
 *
 * - under `escapeKeys: false` every step sends and stores what 1.40.0 did;
 * - under `escapeKeys: true` a new row is keyed as a plain edge keys it; rows 1.40.0 stored read as
 *   before, with the same request; a changed `update` of the group moves them, each keeping its
 *   `created`; `rekey` moves them before an update, and finds nothing after one;
 * - two elements whose paths compose one key now (`A` and `a` through a hex codec) read as before; a
 *   changed write of the group is refused as a plain edge refuses it; `rekey` reports the aggregate
 *   `failed`; an update removing one repairs it.
 *
 * `fixtures/aggregate-dotted-edge-keys-1.40.0.json` holds what published 1.40.0 sent and stored.
 * Run by the entity-edge-keys runners (`AggregateEntityEdgeKeys.test.ts`,
 * `connected.aggregate-entity-edge-keys.test.ts`).
 */

import { readFileSync } from "node:fs"
import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Cause, Duration, Effect, Exit, Schema, SchemaGetter } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect } from "vitest"
import * as Aggregate from "../../src/Aggregate.js"
import { DynamoClient } from "../../src/DynamoClient.js"
import * as Entity from "../../src/Entity.js"
import * as Table from "../../src/Table.js"
import type { Harness } from "./AggregateEntityEdgeKeys.js"

type Row = Record<string, AttributeValue>
type Request = { readonly command: string; readonly input: any }
type Step = {
  readonly step: string
  readonly outcome: any
  readonly requests: ReadonlyArray<Request>
  readonly rows: ReadonlyArray<Row>
}
const published = JSON.parse(
  readFileSync(
    new URL("../fixtures/aggregate-dotted-edge-keys-1.40.0.json", import.meta.url),
    "utf8",
  ),
) as {
  readonly generatedFrom: ReadonlyArray<string>
  readonly on: ReadonlyArray<Step>
  readonly off: ReadonlyArray<Step>
}

/** `{ n: 5 }` stored as `{ n: "5" }`: the model encodes the field as a whole. */
const NestedWhole = Schema.Struct({ n: Schema.String }).pipe(
  Schema.decodeTo(Schema.Struct({ n: Schema.Number }), {
    decode: SchemaGetter.transform(({ n }: { readonly n: string }) => ({ n: Number(n) })),
    encode: SchemaGetter.transform(({ n }: { readonly n: number }) => ({ n: String(n) })),
  }),
)
/** `{ c: "A" }` stored as `{ c: "41" }`, its UTF-8 bytes as hex. */
const CodeWhole = Schema.Struct({ c: Schema.String }).pipe(
  Schema.decodeTo(Schema.Struct({ c: Schema.String }), {
    decode: SchemaGetter.transform(({ c }: { readonly c: string }) => ({
      c: Buffer.from(c, "hex").toString("utf8"),
    })),
    encode: SchemaGetter.transform(({ c }: { readonly c: string }) => ({
      c: Buffer.from(c, "utf8").toString("hex"),
    })),
  }),
)
const Dot = Schema.Struct({
  dotId: Schema.String,
  nested: NestedWhole,
  code: CodeWhole,
  label: Schema.String,
})
const Dotted = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  byNested: Schema.Array(Dot),
  byCode: Schema.Array(Dot),
})

/** The definitions the fixture was captured with, under `escapeKeys` as given. */
const define = (escapeKeys: boolean) => {
  const schema = DynamoSchema.make({ name: "dots", version: 1, escapeKeys })
  const Dots = Entity.make({
    model: DynamoModel.configure(Dot, { dotId: { identifier: true } }),
    entityType: "Dot",
    primaryKey: {
      pk: { field: "pk", composite: ["dotId"] },
      sk: { field: "sk", composite: [] },
    },
  } as never) as any
  const Main = Table.make({ schema, entities: { Dots } })
  const Agg = (Aggregate.make as any)(Dotted, {
    table: Main,
    schema,
    pk: { field: "pk", composite: ["id"] },
    collection: { name: "dotted" },
    timestamps: true,
    root: { entityType: "Dotted" },
    edges: {
      byNested: (Aggregate.many as any)({
        entity: Dots,
        entityType: "ByNested",
        sk: { composite: ["nested.n"] },
      }),
      byCode: (Aggregate.many as any)({
        entity: Dots,
        entityType: "ByCode",
        sk: { composite: ["code.c"] },
      }),
    },
  })
  return { Dots, Main, Agg }
}
const ON = define(true)
const OFF = define(false)

const dot = (i: number, n: number, c: string) => ({
  dotId: `d${i}`,
  nested: { n },
  code: { c },
  label: `l${i}`,
})
const values = {
  d1: {
    id: "d1",
    title: "t",
    byNested: [dot(1, 5, "b"), dot(2, 12, "c")],
    byCode: [dot(1, 5, "b"), dot(2, 12, "c")],
  },
  d2: {
    id: "d2",
    title: "t",
    byNested: [dot(1, 5, "x")],
    byCode: [dot(1, 5, "A"), dot(2, 6, "a"), dot(3, 7, "b")],
  },
}
const PK = { d1: "$dots#v1#dotted#d1", d2: "$dots#v1#dotted#d2" }

const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
/** As the fixture holds it: every timestamp `<stamp>`. */
const stamped = <A>(value: A): A =>
  JSON.parse(
    JSON.stringify(value, (_key, held) =>
      typeof held === "string" && STAMP.test(held) ? "<stamp>" : held,
    ),
  )
const keyOf = (row: Row) => `${row.pk?.S}|${row.sk?.S}`
const sorted = (rows: ReadonlyArray<Row>) =>
  [...rows].sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : 1))
const sks = (rows: ReadonlyArray<Row>, pk: string) =>
  rows
    .filter((row) => row.pk?.S === pk && row.sk?.S !== "$dots#v1#dotted")
    .map((row) => row.sk!.S!)
    .sort()
const outcomeOf = (exit: Exit.Exit<unknown, unknown>): any => {
  if (Exit.isSuccess(exit)) return { ok: JSON.parse(JSON.stringify(exit.value ?? null)) }
  const failure = Cause.squash(exit.cause) as any
  return { fail: String(failure?._tag ?? "Error"), error: failure }
}
const rekeyed = (outcome: any) => ({
  moved: outcome.ok.byMember?.Dotted?.moved?.aggregate ?? 0,
  conflicts: (outcome.ok.conflicts as ReadonlyArray<any>).filter(
    (conflict) => conflict.member === "Dotted",
  ),
})

type Session = {
  readonly db: any
  readonly step: (name: string, make: () => any) => Effect.Effect<Step>
}
const session = <A>(
  harness: Harness,
  defs: ReturnType<typeof define>,
  seeded: ReadonlyArray<Row>,
  body: (session: Session) => Effect.Effect<A, unknown, any>,
) =>
  harness.onTable((tableName) =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.UTC(2024, 0, 1))
      if (seeded.length > 0) yield* harness.seed(tableName, seeded)
      const db = yield* DynamoClient.make({
        entities: { Dots: defs.Dots },
        aggregates: { Dotted: defs.Agg },
        tables: { Main: defs.Main },
      })
      yield* harness.requests(tableName)
      const step = (name: string, make: () => any) =>
        Effect.gen(function* () {
          yield* TestClock.adjust(Duration.seconds(5))
          const outcome = outcomeOf(yield* Effect.exit(make() as Effect.Effect<unknown, unknown>))
          return {
            step: name,
            outcome,
            requests: yield* harness.requests(tableName),
            rows: sorted(yield* harness.rows(tableName)),
          }
        })
      return yield* body({ db, step })
    }).pipe(Effect.provide(defs.Main.layer({ name: tableName }))),
  )

const at = (steps: ReadonlyArray<Step>, name: string) => steps.find((step) => step.step === name)!
const seededOn = at(published.on, "create d2").rows
const retitled = ({ state }: any) => ({ ...state, title: "t2" })

export const dottedSuite = (
  harness: Harness,
  describeIt: (name: string, body: () => void) => void = describe,
) =>
  describeIt("an entity: edge keyed by a dotted composite (#241)", () => {
    it("the fixture is published 1.40.0's: the dotted path read off the stored form", () => {
      expect(published.generatedFrom).toEqual(["effect-dynamodb@1.40.0"])
      for (const steps of [published.on, published.off]) {
        expect(sks(at(steps, "create d2").rows, PK.d1)).toEqual([
          "$dots#v1#bycode#62",
          "$dots#v1#bycode#63",
          "$dots#v1#bynested#12",
          "$dots#v1#bynested#5",
        ])
        expect(sks(at(steps, "create d2").rows, PK.d2)).toEqual([
          "$dots#v1#bycode#41",
          "$dots#v1#bycode#61",
          "$dots#v1#bycode#62",
          "$dots#v1#bynested#5",
        ])
      }
    })

    it.effect("under escapeKeys: false, every step sends and stores what 1.40.0 did", () =>
      Effect.gen(function* () {
        const steps = yield* session(harness, OFF, [], ({ db, step }) =>
          Effect.gen(function* () {
            return [
              yield* step("create d1", () => db.aggregates.Dotted.create(values.d1)),
              yield* step("create d2", () => db.aggregates.Dotted.create(values.d2)),
              yield* step("get d1", () => db.aggregates.Dotted.get({ id: "d1" })),
              yield* step("get d2", () => db.aggregates.Dotted.get({ id: "d2" })),
              yield* step("update d1 title", () =>
                db.aggregates.Dotted.update({ id: "d1" }, retitled),
              ),
            ]
          }),
        )
        for (const [i, now] of steps.entries()) {
          const then = published.off[i]!
          expect(now.step).toBe(then.step)
          expect({ step: now.step, outcome: now.outcome }).toEqual({
            step: then.step,
            outcome: then.outcome,
          })
          expect({ step: now.step, requests: stamped(now.requests) }).toEqual({
            step: then.step,
            requests: then.requests,
          })
          expect({ step: now.step, rows: stamped(now.rows) }).toEqual({
            step: then.step,
            rows: sorted(then.rows),
          })
        }
      }),
    )

    it.effect(
      "under escapeKeys: true, a new aggregate keys each element as a plain edge does",
      () =>
        Effect.gen(function* () {
          const created = yield* session(harness, ON, [], ({ step, db }) =>
            step("create d1", () => db.aggregates.Dotted.create(values.d1)),
          )
          expect(created.outcome).toHaveProperty("ok")
          expect(sks(created.rows, PK.d1)).toEqual([
            "$dots#v1#bycode#b",
            "$dots#v1#bycode#c",
            "$dots#v1#bynested#0000000000000005",
            "$dots#v1#bynested#0000000000000012",
          ])
        }),
    )

    it.effect(
      "under escapeKeys: true over 1.40.0's rows: read as before; a rekey dry run counts them; an update moves its group, keeping each row's created; rekey after finds nothing",
      () =>
        Effect.gen(function* () {
          const d1 = seededOn.filter((row) => row.pk?.S === PK.d1)
          const createdOf = new Map(d1.map((row) => [row.sk!.S!, row.createdAt]))
          const [get, dry, moved, rekeyFirst, again] = yield* session(
            harness,
            ON,
            d1,
            ({ db, step }) =>
              Effect.gen(function* () {
                return [
                  yield* step("get d1", () => db.aggregates.Dotted.get({ id: "d1" })),
                  yield* step("rekey dry run", () => db.tables.Main.rekey({ dryRun: true })),
                  yield* step("update d1 title", () =>
                    db.aggregates.Dotted.update({ id: "d1" }, retitled),
                  ),
                  yield* step("rekey", () => db.tables.Main.rekey()),
                  yield* step("update d1 title again", () =>
                    db.aggregates.Dotted.update({ id: "d1" }, ({ state }: any) => ({
                      ...state,
                      title: "t3",
                    })),
                  ),
                ] as const
              }),
          )
          const then = at(published.on, "get d1")
          expect(get.outcome).toEqual(then.outcome)
          expect(stamped(get.requests)).toEqual(then.requests)
          // A dry run counts the aggregate's rows to move, its four edge rows, moving nothing.
          expect(rekeyed(dry.outcome)).toEqual({ moved: 4, conflicts: [] })
          expect(sks(dry.rows, PK.d1)).toEqual(sks(d1, PK.d1))
          // The update: the group under this release's keys, the rows read under 1.40.0's deleted
          // in its transaction, each keeping its `created`.
          expect(moved.outcome).toHaveProperty("ok")
          expect(sks(moved.rows, PK.d1)).toEqual([
            "$dots#v1#bycode#b",
            "$dots#v1#bycode#c",
            "$dots#v1#bynested#0000000000000005",
            "$dots#v1#bynested#0000000000000012",
          ])
          const writes = moved.requests.filter((r) => r.command === "TransactWriteItems")
          expect(writes).toHaveLength(1)
          const deleted = (writes[0]!.input.TransactItems as ReadonlyArray<any>)
            .filter((item) => item.Delete !== undefined)
            .map((item) => item.Delete.Key.sk.S as string)
            .sort()
          expect(deleted).toEqual(sks(d1, PK.d1))
          const byLine = (rows: ReadonlyArray<Row>, type: string, dotId: string) =>
            rows.find((row) => row.__edd_e__?.S === type && row.dotId?.S === dotId)!
          for (const type of ["ByNested", "ByCode"]) {
            for (const dotId of ["d1", "d2"]) {
              expect({ type, dotId, created: byLine(moved.rows, type, dotId).createdAt }).toEqual({
                type,
                dotId,
                created: createdOf.get(byLine(d1, type, dotId).sk!.S!),
              })
            }
          }
          // `rekey` after the move: nothing of this aggregate's left to move.
          expect(rekeyed(rekeyFirst.outcome)).toEqual({ moved: 0, conflicts: [] })
          expect(again.outcome).toHaveProperty("ok")
          expect(again.requests.flatMap((r) => r.input.TransactItems ?? [])).not.toContainEqual(
            expect.objectContaining({ Delete: expect.anything() }),
          )
        }),
    )

    it.effect(
      "under escapeKeys: true, rekey before any update moves 1.40.0's rows, keeping each row's created, and the update after it moves nothing",
      () =>
        Effect.gen(function* () {
          const d1 = seededOn.filter((row) => row.pk?.S === PK.d1)
          const [rekey, update] = yield* session(harness, ON, d1, ({ db, step }) =>
            Effect.gen(function* () {
              return [
                yield* step("rekey", () => db.tables.Main.rekey()),
                yield* step("update d1 title", () =>
                  db.aggregates.Dotted.update({ id: "d1" }, retitled),
                ),
              ] as const
            }),
          )
          expect(rekeyed(rekey.outcome)).toEqual({ moved: 4, conflicts: [] })
          expect(sks(rekey.rows, PK.d1)).toEqual([
            "$dots#v1#bycode#b",
            "$dots#v1#bycode#c",
            "$dots#v1#bynested#0000000000000005",
            "$dots#v1#bynested#0000000000000012",
          ])
          for (const row of rekey.rows.filter((r) => r.dotId !== undefined)) {
            const from = d1.find(
              (r) => r.__edd_e__?.S === row.__edd_e__?.S && r.dotId?.S === row.dotId?.S,
            )!
            expect(row.createdAt).toEqual(from.createdAt)
          }
          expect(update.outcome).toHaveProperty("ok")
          expect(update.requests.flatMap((r) => r.input.TransactItems ?? [])).not.toContainEqual(
            expect.objectContaining({ Delete: expect.anything() }),
          )
        }),
    )

    it.effect(
      "under escapeKeys: true, two elements whose paths compose one key now: read as before, refused as a plain edge refuses, rekey moves nothing of theirs, and an update removing one repairs it",
      () =>
        Effect.gen(function* () {
          const d2 = seededOn.filter((row) => row.pk?.S === PK.d2)
          const [get, title, rekey, repair, after] = yield* session(
            harness,
            ON,
            d2,
            ({ db, step }) =>
              Effect.gen(function* () {
                return [
                  yield* step("get d2", () => db.aggregates.Dotted.get({ id: "d2" })),
                  yield* step("update d2 title", () =>
                    db.aggregates.Dotted.update({ id: "d2" }, retitled),
                  ),
                  yield* step("rekey", () => db.tables.Main.rekey()),
                  yield* step("update removing d2 of byCode", () =>
                    db.aggregates.Dotted.update({ id: "d2" }, ({ state }: any) => ({
                      ...state,
                      byCode: state.byCode.filter((d: any) => d.dotId !== "d2"),
                    })),
                  ),
                  yield* step("rekey after", () => db.tables.Main.rekey({ dryRun: true })),
                ] as const
              }),
          )
          const then = at(published.on, "get d2")
          expect(get.outcome).toEqual(then.outcome)
          expect(stamped(get.requests)).toEqual(then.requests)
          const reason =
            `"byCode" and "byCode" both compose the sort key "$dots#v1#bycode#a", so one would ` +
            `overwrite the other. Give the "byCode" edge a declared sort key naming attributes ` +
            `that differ between its elements: byCode: Aggregate.many({ …, sk: { composite: [...] } }).`
          expect(title.outcome.fail).toBe("AggregateDecompositionError")
          expect(title.outcome.error.reason).toBe(reason)
          expect(title.requests.map((r) => r.command)).toEqual(["Query"])
          expect(sks(title.rows, PK.d2)).toEqual(sks(d2, PK.d2))
          const report = rekeyed(rekey.outcome)
          expect(report.moved).toBe(0)
          expect(report.conflicts.map((c: any) => [c.reason, c.message])).toEqual([
            ["failed", `AggregateDecompositionError: ${reason}`],
          ])
          expect(sks(rekey.rows, PK.d2)).toEqual(sks(d2, PK.d2))
          expect(repair.outcome).toHaveProperty("ok")
          expect(sks(repair.rows, PK.d2)).toEqual([
            "$dots#v1#bycode#a",
            "$dots#v1#bycode#b",
            "$dots#v1#bynested#0000000000000005",
          ])
          expect(rekeyed(after.outcome)).toEqual({ moved: 0, conflicts: [] })
        }),
    )
  })
