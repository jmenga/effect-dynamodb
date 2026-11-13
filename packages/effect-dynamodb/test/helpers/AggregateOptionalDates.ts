/**
 * A date an aggregate declares `Schema.optional` around an encoding that isn't ISO text is stored in
 * that encoding (#241), as an entity's write of the same model stores it: `due:
 * Schema.optional(DynamoModel.DateEpochMs)` as a number. Published 1.39.0 and 1.40.0 stored such a
 * value as ISO text, and 1.40.0's stamps in such a field followed it.
 *
 * What changes, and what doesn't:
 * - A new write stores the declared encoding, stamps included (a row that doesn't declare a stamp
 *   holds the root's form). Key text is what 1.40.0 composed, byte for byte, whatever the stored
 *   form: a key over such a date, passed or stamped, reads it as ISO text.
 * - Rows stored as ISO text read as before, and a no-op `update` over them sends only its read.
 * - A group's rows are written in the declared form when the group is written for another reason:
 *   every row of that group, its kept `created` too (the same instant), and no other group's.
 *
 * `fixtures/aggregate-optional-dates-1.40.0.json` holds what published 1.39.0 and 1.40.0 did, at a
 * fixed clock. One suite, run on a recording table (`AggregateOptionalDates.test.ts`) and against
 * DynamoDB Local (`connected.aggregate-optional-dates.test.ts`).
 */

import { readFileSync } from "node:fs"
import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Cause, DateTime, Duration, Effect, Exit, Schema } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect } from "vitest"
import * as Aggregate from "../../src/Aggregate.js"
import { DynamoClient } from "../../src/DynamoClient.js"
import * as Table from "../../src/Table.js"

type Row = Record<string, AttributeValue>
type Request = { readonly command: string; readonly input: any }
type Step = {
  readonly step: string
  readonly outcome: unknown
  readonly requests: ReadonlyArray<Request>
  readonly rows: ReadonlyArray<Row>
}
type Over = "passed" | "stamp"

const published = JSON.parse(
  readFileSync(
    new URL("../fixtures/aggregate-optional-dates-1.40.0.json", import.meta.url),
    "utf8",
  ),
) as {
  readonly generatedFrom: ReadonlyArray<string>
  readonly clock: number
  readonly "1.39.0": Record<Over, ReadonlyArray<Step>>
  readonly "1.40.0": Record<Over, ReadonlyArray<Step>>
}

export const INDEXES = {
  lsi1: { pk: "pk", sk: "csk" },
  gsi1: { pk: "gpk", sk: "gsk" },
} as const

const schema = DynamoSchema.make({ name: "dates", version: 1 })
export const Main = Table.make({ schema, entities: {} })

const Note = Schema.Struct({
  text: Schema.String,
  due: Schema.optional(DynamoModel.DateEpochSeconds),
})
const Line = Schema.Struct({ lineId: Schema.String, due: Schema.optional(DynamoModel.DateEpochMs) })
const Memo = Schema.Struct({ body: Schema.String })
const Sub = Schema.Struct({
  subName: Schema.String,
  due: Schema.optional(Schema.DateTimeUtc.pipe(DynamoModel.storedAs(DynamoModel.DateEpochMs))),
  memo: Memo,
})
const Doc = Schema.Struct({
  id: Schema.String,
  tenant: Schema.String,
  title: Schema.String,
  due: Schema.optional(DynamoModel.DateEpochMs),
  createdAt: Schema.optional(DynamoModel.DateEpochMs),
  updatedAt: Schema.optional(DynamoModel.DateEpochMs),
  note: Schema.optional(Note),
  lines: Schema.Array(Line),
  sub: Sub,
})

const define = (over: Over) => {
  const [collectionSk, listSk] = over === "stamp" ? ["createdAt", "updatedAt"] : ["due", "due"]
  return Aggregate.make(
    Doc as never,
    {
      table: Main,
      schema,
      pk: { field: "pk", composite: ["id"] },
      collection: { name: "doc", index: "lsi1", sk: { field: "csk", composite: [collectionSk] } },
      list: {
        name: "docs",
        index: "gsi1",
        pk: { field: "gpk", composite: ["tenant"] },
        sk: { field: "gsk", composite: [listSk] },
      },
      timestamps: true,
      root: { entityType: "Doc" },
      edges: {
        note: Aggregate.one({ entityType: "DocNote" }),
        lines: Aggregate.many({ entityType: "DocLine", sk: { composite: ["lineId"] } }),
        sub: (
          Aggregate.make(
            Sub as never,
            {
              root: { entityType: "DocSub" },
              edges: { memo: Aggregate.one({ entityType: "DocSubMemo" }) },
            } as never,
          ) as any
        ).with({ discriminator: { slot: "a" } }),
      },
    } as never,
  ) as any
}

/** How each row's dates are declared: epoch milliseconds or seconds. A stamp it doesn't declare is the root's. */
const declared: Record<string, Record<string, "ms" | "s">> = {
  Doc: { due: "ms", createdAt: "ms", updatedAt: "ms" },
  DocNote: { due: "s", createdAt: "ms", updatedAt: "ms" },
  DocLine: { due: "ms", createdAt: "ms", updatedAt: "ms" },
  DocSub: { due: "ms", createdAt: "ms", updatedAt: "ms" },
  DocSubMemo: { createdAt: "ms", updatedAt: "ms" },
}

/** A row 1.40.0 stored, with each date it held as ISO text in its declared encoding: the same instant. */
const inDeclared = (row: Row): Row => {
  const forms = declared[row.__edd_e__?.S ?? ""] ?? {}
  return Object.fromEntries(
    Object.entries(row).map(([name, held]) => {
      const form = forms[name]
      if (form === undefined || held.S === undefined) return [name, held]
      const at = Date.parse(held.S)
      return [name, { N: String(form === "ms" ? at : Math.floor(at / 1000)) }]
    }),
  )
}

/** The requests 1.40.0 sent, with each row put in its declared encoding. */
const requestsInDeclared = (requests: ReadonlyArray<Request>): ReadonlyArray<Request> =>
  requests.map((request) =>
    request.command !== "TransactWriteItems"
      ? request
      : {
          ...request,
          input: {
            ...request.input,
            TransactItems: request.input.TransactItems.map((item: any) =>
              item.Put === undefined
                ? item
                : { ...item, Put: { ...item.Put, Item: inDeclared(item.Put.Item) } },
            ),
          },
        },
  )

const isSubGroup = (row: Row) => (row.__edd_e__?.S ?? "").startsWith("DocSub")

const keyOf = (row: Row) => `${row.pk?.S}|${row.sk?.S}`
const sorted = (rows: ReadonlyArray<Row>): ReadonlyArray<Row> =>
  [...rows]
    .sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : 1))
    .map((row) =>
      Object.fromEntries(
        Object.keys(row)
          .sort()
          .map((name) => [name, row[name]!]),
      ),
    )

const plain = (value: unknown): unknown =>
  JSON.parse(
    JSON.stringify(value, function (this: Record<string, unknown>, key, encoded) {
      const held = this[key]
      if (held !== null && typeof held === "object" && DateTime.isDateTime(held)) {
        return { date: DateTime.toEpochMillis(held) }
      }
      return encoded
    }),
  )

const outcomeOf = (exit: Exit.Exit<unknown, unknown>): unknown =>
  Exit.isSuccess(exit)
    ? { ok: plain(exit.value) ?? null }
    : { failed: String((Cause.squash(exit.cause) as any)?._tag) }

export interface Harness {
  /** Runs `body` on a fresh table, with a `DynamoClient` and `Main` bound to it. */
  readonly onTable: <A, E>(
    body: (tableName: string) => Effect.Effect<A, E, any>,
  ) => Effect.Effect<A, unknown>
  /** The table's rows. */
  readonly rows: (tableName: string) => Effect.Effect<ReadonlyArray<Row>>
  /** The requests sent since last asked, the table's name as `<table>`. */
  readonly requests: (tableName: string) => Effect.Effect<ReadonlyArray<Request>>
  /** Puts `rows` in the table as they are. */
  readonly seed: (tableName: string, rows: ReadonlyArray<Row>) => Effect.Effect<void>
}

/** The steps the fixture was captured with, from `from` on. */
const steps = (db: any) =>
  [
    [
      "create",
      () =>
        db.aggregates.Docs.create({
          id: "a",
          tenant: "t",
          title: "t",
          due: DateTime.makeUnsafe(1600000000000),
          note: { text: "n", due: DateTime.makeUnsafe(1600000000000) },
          lines: [{ lineId: "l1", due: DateTime.makeUnsafe(1600000000000) }, { lineId: "l2" }],
          sub: { subName: "s", due: DateTime.makeUnsafe(1600000000000), memo: { body: "m" } },
        }),
    ],
    ["get", () => db.aggregates.Docs.get({ id: "a" })],
    [
      "update, changing nothing",
      () => db.aggregates.Docs.update({ id: "a" }, ({ state }: any) => state),
    ],
    [
      "update, 5 s later, changing the title",
      () =>
        Effect.andThen(
          TestClock.adjust(Duration.seconds(5)),
          db.aggregates.Docs.update({ id: "a" }, ({ state }: any) => ({ ...state, title: "t2" })),
        ),
    ],
    [
      "update, 5 s later, changing the sub-aggregate",
      () =>
        Effect.andThen(
          TestClock.adjust(Duration.seconds(5)),
          db.aggregates.Docs.update({ id: "a" }, ({ state }: any) => ({
            ...state,
            sub: { ...state.sub, subName: "s2" },
          })),
        ),
    ],
    ["get", () => db.aggregates.Docs.get({ id: "a" })],
  ] as const

/** Runs the steps from `from` on (seeding the rows `seeded` first), as the fixture holds them. */
const run = (harness: Harness, over: Over, from: number, seeded?: ReadonlyArray<Row>) =>
  harness.onTable((tableName) =>
    Effect.gen(function* () {
      yield* TestClock.setTime(published.clock)
      if (seeded !== undefined) yield* harness.seed(tableName, seeded)
      const Docs = define(over)
      const db = yield* DynamoClient.make({ entities: {}, aggregates: { Docs }, tables: { Main } })
      yield* harness.requests(tableName)
      const out: Array<Step> = []
      for (const [step, make] of steps(db).slice(from)) {
        const outcome = outcomeOf(yield* Effect.exit(make() as Effect.Effect<unknown, unknown>))
        out.push({
          step,
          outcome,
          requests: yield* harness.requests(tableName),
          rows: sorted(yield* harness.rows(tableName)),
        })
      }
      return out
    }),
  )

/** The fixture's outcome, with a failure as its tag only. */
const judged = (outcome: any): unknown =>
  "ok" in outcome ? outcome : { failed: outcome.fail as string }

export const suite = (
  harness: Harness,
  describeIt: (name: string, body: () => void) => void = describe,
) =>
  describeIt("a date declared Schema.optional around an encoding that isn't ISO text", () => {
    it("the fixture is published 1.39.0's and 1.40.0's, which stored each such date as ISO text", () => {
      expect(published.generatedFrom).toEqual(["effect-dynamodb@1.39.0", "effect-dynamodb@1.40.0"])
      for (const version of ["1.39.0", "1.40.0"] as const) {
        for (const over of ["passed", "stamp"] as const) {
          for (const { rows } of published[version][over]) {
            for (const row of rows) {
              for (const name of Object.keys(declared[row.__edd_e__!.S!]!)) {
                if (row[name] !== undefined) expect(row[name]).toHaveProperty("S")
              }
            }
          }
        }
      }
      // 1.39.0 stamped no row, and refused a key over a stamp before sending anything.
      expect(published["1.39.0"].stamp[0]!.requests).toEqual([])
      expect(judged(published["1.39.0"].stamp[0]!.outcome)).toEqual({ failed: "Error" })
    })

    for (const over of ["passed", "stamp"] as const) {
      const then = published["1.40.0"][over]
      it.effect(
        `keys over ${over === "stamp" ? "the stamps" : "a date passed"}: create stores each date in its declared encoding, its keys as 1.40.0 composed them`,
        () =>
          Effect.gen(function* () {
            const actual = yield* run(harness, over, 0)
            const [create, get, noop] = [actual[0]!, actual[1]!, actual[2]!]
            expect(create.outcome).toEqual(then[0]!.outcome)
            expect(create.requests).toEqual(requestsInDeclared(then[0]!.requests))
            expect(create.rows).toEqual(sorted(then[0]!.rows.map(inDeclared)))
            // Every key attribute is 1.40.0's, byte for byte.
            for (const [i, row] of create.rows.entries()) {
              for (const name of ["pk", "sk", "csk", "gpk", "gsk"]) {
                expect(row[name], `${row.__edd_e__?.S}.${name}`).toEqual(then[0]!.rows[i]![name])
              }
            }
            expect(get.outcome).toEqual(then[1]!.outcome)
            expect(get.requests).toEqual(then[1]!.requests)
            // A no-op update reads and writes nothing.
            expect(noop.requests).toEqual(then[2]!.requests)
            expect(noop.requests.map((request) => request.command)).toEqual(["Query"])
            expect(noop.rows).toEqual(create.rows)
            // Each later step: what 1.40.0 sent and stored, in the declared encoding.
            for (const i of [3, 4, 5]) {
              expect(actual[i]!.outcome, then[i]!.step).toEqual(then[i]!.outcome)
              expect(actual[i]!.requests, then[i]!.step).toEqual(
                requestsInDeclared(then[i]!.requests),
              )
              expect(actual[i]!.rows, then[i]!.step).toEqual(sorted(then[i]!.rows.map(inDeclared)))
            }
          }),
      )
    }

    for (const version of ["1.39.0", "1.40.0"] as const) {
      for (const over of ["passed", "stamp"] as const) {
        const then = published[version][over]
        if (!("ok" in (then[0]!.outcome as object))) continue
        it.effect(
          `keys over ${over === "stamp" ? "the stamps" : "a date passed"}, over the rows ${version} stored: read as before, and a no-op update writes nothing`,
          () =>
            Effect.gen(function* () {
              const seeded = then[0]!.rows
              const [get, noop] = yield* run(harness, over, 1, seeded)
              expect(get!.outcome).toEqual(then[1]!.outcome)
              expect(get!.requests).toEqual(then[1]!.requests)
              expect(noop!.outcome).toEqual(then[2]!.outcome)
              expect(noop!.requests).toEqual(then[2]!.requests)
              expect(noop!.requests.map((request) => request.command)).toEqual(["Query"])
              expect(noop!.rows).toEqual(sorted(seeded))
            }),
        )
      }
    }

    for (const over of ["passed", "stamp"] as const) {
      const then = published["1.40.0"][over]
      it.effect(
        `keys over ${over === "stamp" ? "the stamps" : "a date passed"}, over the rows 1.40.0 stored: a group written for another reason is written in the declared encoding, every row of it and no other group's`,
        () =>
          Effect.gen(function* () {
            const actual = yield* run(harness, over, 1, then[0]!.rows)
            const [title, sub, get] = [actual[2]!, actual[3]!, actual[4]!]
            // The title's group: the root, its `one` edge and its `many` rows, `created` kept as
            // the same instant. The sub-aggregate's rows stay as 1.40.0 stored them.
            expect(title.outcome).toEqual(then[3]!.outcome)
            expect(title.requests).toEqual(requestsInDeclared(then[3]!.requests))
            expect(title.rows).toEqual(
              sorted(then[3]!.rows.map((row) => (isSubGroup(row) ? row : inDeclared(row)))),
            )
            expect(title.rows.filter(isSubGroup)).toEqual(sorted(then[0]!.rows.filter(isSubGroup)))
            // Then the sub-aggregate's group.
            expect(sub.outcome).toEqual(then[4]!.outcome)
            expect(sub.requests).toEqual(requestsInDeclared(then[4]!.requests))
            expect(sub.rows).toEqual(sorted(then[4]!.rows.map(inDeclared)))
            expect(get.outcome).toEqual(then[5]!.outcome)
            // No key attribute moved.
            for (const [i, row] of sub.rows.entries()) {
              for (const name of ["pk", "sk", "csk", "gpk", "gsk"]) {
                expect(row[name], `${row.__edd_e__?.S}.${name}`).toEqual(then[4]!.rows[i]![name])
              }
            }
          }),
      )
    }
  })
