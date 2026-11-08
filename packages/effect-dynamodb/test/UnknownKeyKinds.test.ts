/**
 * `EDD-9128` by value: a key composed from a `Schema.Unknown` or `Schema.Any` field refuses, at write,
 * a value that reads back as the other numeric kind (a `bigint` safe integer reads back as a number,
 * an integer `number` past 2^53 as a `bigint`), with nothing written. A declared two-kind field is
 * refused at load (`BothKindsKeys.test.ts`); Unknown and Any declare no kind, and a key over one
 * holding strings or numbers keeps working, rows 1.39.0 stored included
 * (`fixtures/unknown-keys-1.39.0.json`, from published 1.39.0's own `put` and `delete`).
 */

import { readFileSync } from "node:fs"
import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Effect, Exit, Schema } from "effect"
import { describe, expect } from "vitest"
import * as Aggregate from "../src/Aggregate.js"
import * as Batch from "../src/Batch.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"
import * as Transaction from "../src/Transaction.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

type Row = Record<string, AttributeValue>

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/unknown-keys-1.39.0.json", import.meta.url), "utf8"),
) as { readonly read: Record<string, unknown>; readonly rows: ReadonlyArray<Row> }

/** The fixture's definitions: they must stay what its generator declared. */
const schema = DynamoSchema.make({ name: "unk", version: 1, escapeKeys: false })
const Model = Schema.Struct({
  id: Schema.String,
  n: Schema.Unknown,
  u: Schema.Unknown,
  note: Schema.String,
})
const Unknowns = Entity.make({
  model: Model,
  entityType: "Unknowns",
  primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: ["n"] } },
  indexes: {
    byU: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["id"] },
      sk: { field: "gsi1sk", composite: ["u"] },
    },
  },
  unique: { byU: ["u"] },
  softDelete: true,
} as never) as any
/** `Schema.Unknown` in a primary key only, which `Batch.write` puts. */
const Plain = Entity.make({
  model: Schema.Struct({ id: Schema.String, n: Schema.Unknown, note: Schema.String }),
  entityType: "Plain",
  primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: ["n"] } },
} as never) as any
/** `Schema.Any`, in a time-series `orderBy`. */
const Readings = Entity.make({
  model: Schema.Struct({ id: Schema.String, at: Schema.Any, v: Schema.String }),
  entityType: "Readings",
  primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
  timeSeries: {
    orderBy: "at",
    appendInput: Schema.Struct({ id: Schema.String, at: Schema.Any, v: Schema.String }),
  },
} as never) as any
const Main = Table.make({ schema, entities: { Unknowns, Readings, Plain } } as never) as any
/** An aggregate keyed on `Schema.Unknown`: its partition key, and a `many` edge's sort key. */
const Teams = (Aggregate.make as any)(
  Schema.Struct({
    id: Schema.String,
    k: Schema.Unknown,
    lines: Schema.Array(Schema.Struct({ n: Schema.Unknown, note: Schema.String })),
  }),
  {
    table: Main,
    schema,
    pk: { field: "pk", composite: ["id", "k"] },
    collection: { name: "team" },
    root: { entityType: "Team" },
    edges: { lines: Aggregate.many({ entityType: "TeamLine", sk: { composite: ["n"] } }) },
  },
)

const on = <A, E>(
  seed: ReadonlyArray<Row>,
  body: (db: any, rows: () => ReadonlyArray<Row>) => Effect.Effect<A, E, any>,
) => {
  const table = makeRecordingTable({ indexes: { gsi1: { pk: "gsi1pk", sk: "gsi1sk" } } })
  for (const row of seed)
    table.items.set(`${row.pk!.S}|${row.sk!.S}`, structuredClone(row) as never)
  const rows = () => [...table.items.values()] as unknown as ReadonlyArray<Row>
  return Effect.gen(function* () {
    const db = yield* DynamoClient.make({
      entities: { Unknowns, Readings, Plain },
      aggregates: { Teams },
      tables: { Main },
    } as never) as Effect.Effect<any, never, any>
    return yield* body(db, rows)
  }).pipe(Effect.provide(Main.layer({ name: "t" })), Effect.provide(table.layer)) as Effect.Effect<
    A,
    unknown
  >
}

const keysOf = (rows: ReadonlyArray<Row>) =>
  rows
    .map((row) => [row.__edd_e__?.S, row.pk?.S, row.sk?.S, row.gsi1sk?.S ?? ""].join("|"))
    // A tombstone's sort key ends at the time of its delete.
    .map((key) => key.replace(/#\d{4}-\d\d-\d\dT[^|]*/, "#<deleted at>"))
    .sort()

/** Fails with EDD-9128 naming `field`, and wrote nothing. */
const refused = (exit: Exit.Exit<unknown, unknown>, field: string, into: RegExp) => {
  expect(Exit.isFailure(exit)).toBe(true)
  const text = JSON.stringify(exit)
  expect(text).toContain("ValidationError")
  expect(text).toContain("EDD-9128")
  expect(text).toContain(`Field \\"${field}\\"`)
  expect(text).toMatch(into)
}

describe("a key over Schema.Unknown or Schema.Any, judged by value (EDD-9128)", () => {
  it.effect("a string and a number are stored and read as before", () =>
    on([], (db, rows) =>
      Effect.gen(function* () {
        yield* db.entities.Unknowns.put({ id: "s", n: "Ab C", u: "x", note: "string" }).asEffect()
        yield* db.entities.Unknowns.put({ id: "n", n: 5, u: 6, note: "number" }).asEffect()
        expect(yield* db.entities.Unknowns.get({ id: "s", n: "Ab C" })).toEqual(fixture.read.string)
        expect(yield* db.entities.Unknowns.get({ id: "n", n: 5 })).toEqual(fixture.read.number)
        yield* db.entities.Unknowns.delete({ id: "s", n: "Ab C" }).asEffect()
        // What 1.39.0 stored, key for key.
        expect(keysOf(rows())).toEqual(keysOf(fixture.rows))
      }),
    ),
  )

  it.effect("rows 1.39.0 stored are read, updated, restored and deleted under their keys", () =>
    on(fixture.rows, (db, rows) =>
      Effect.gen(function* () {
        expect(yield* db.entities.Unknowns.get({ id: "n", n: 5 })).toEqual(fixture.read.number)
        yield* db.entities.Unknowns.update({ id: "n", n: 5 }).set({ note: "u" }).asEffect()
        expect(keysOf(rows())).toEqual(keysOf(fixture.rows))
        yield* db.entities.Unknowns.restore({ id: "s", n: "Ab C" })
        expect(yield* db.entities.Unknowns.get({ id: "s", n: "Ab C" })).toEqual(fixture.read.string)
        expect(rows().some((row) => row.gsi1sk?.S === "$unk#v1#unknowns#u_x")).toBe(true)
        expect(rows().some((row) => row.pk?.S === "$unk#v1#unknowns.byu#x")).toBe(true)
        yield* db.entities.Unknowns.update({ id: "n", n: 5 }).set({ u: 7 }).asEffect()
        expect(rows().some((row) => row.pk?.S === "$unk#v1#unknowns.byu#0000000000000006")).toBe(
          false,
        )
        expect(rows().some((row) => row.pk?.S === "$unk#v1#unknowns.byu#0000000000000007")).toBe(
          true,
        )
        yield* db.entities.Unknowns.delete({ id: "n", n: 5 }).asEffect()
        expect(rows().some((row) => row.pk?.S?.startsWith("$unk#v1#unknowns.byu#0"))).toBe(false)
      }),
    ),
  )

  it.effect("a bigint past 2^53 reads back as a bigint, so it's stored", () =>
    on([], (db) =>
      Effect.gen(function* () {
        const big = 2n ** 60n + 1n
        yield* db.entities.Unknowns.put({ id: "b", n: big, u: "y", note: "big" }).asEffect()
        const got = yield* db.entities.Unknowns.get({ id: "b", n: big })
        expect(got.n).toBe(big)
      }),
    ),
  )

  it.effect("a value that reads back as the other kind is refused, with nothing written", () =>
    on([], (db, rows) =>
      Effect.gen(function* () {
        const put = (item: Record<string, unknown>) =>
          Effect.exit(
            db.entities.Unknowns.put({ id: "a", note: "x", n: "k", u: "v", ...item }).asEffect(),
          )
        refused(
          yield* put({ n: 5n }),
          "n",
          /the primary key, and the bigint 5n would read back as a number/,
        )
        refused(yield* put({ u: -3n }), "u", /index \\"byU\\"/)
        refused(
          yield* put({ n: 2 ** 60 }),
          "n",
          /the number 1152921504606847000 would read back as a bigint/,
        )
        refused(
          yield* Effect.exit(
            Transaction.transactWrite([
              db.entities.Unknowns.put({ id: "a", note: "x", n: 5n, u: "v" }),
            ]),
          ),
          "n",
          /the primary key/,
        )
        refused(
          yield* Effect.exit(Batch.write([db.entities.Plain.put({ id: "a", note: "x", n: 5n })])),
          "n",
          /the primary key/,
        )
        expect(rows()).toEqual([])
        yield* db.entities.Unknowns.put({ id: "a", note: "x", n: "k", u: "v" }).asEffect()
        const before = keysOf(rows())
        refused(
          yield* Effect.exit(
            db.entities.Unknowns.update({ id: "a", n: "k" }).set({ u: 5n }).asEffect(),
          ),
          "u",
          /index \\"byU\\"/,
        )
        expect(keysOf(rows())).toEqual(before)
      }),
    ),
  )

  it.effect("an aggregate's partition key and a many edge's sort key", () =>
    on([], (db, rows) =>
      Effect.gen(function* () {
        refused(
          yield* Effect.exit(
            db.aggregates.Teams.create({ id: "t", k: 5n, lines: [{ n: "a", note: "x" }] }),
          ),
          "k",
          /"k\\" of \\"Team\\" is composed into its partition key, and the bigint 5n/,
        )
        refused(
          yield* Effect.exit(
            db.aggregates.Teams.create({ id: "t", k: "a", lines: [{ n: 5n, note: "x" }] }),
          ),
          "n",
          /"n\\" of \\"lines\\" is composed into edge \\"lines\\"'s sort key/,
        )
        expect(rows()).toEqual([])
        const team = {
          id: "t",
          k: 5,
          // In sort-key order: a number's key text sorts before a string's.
          lines: [
            { n: 6, note: "y" },
            { n: "a", note: "x" },
          ],
        }
        yield* db.aggregates.Teams.create(team)
        expect(yield* db.aggregates.Teams.get({ id: "t", k: 5 })).toEqual(team)
        const before = keysOf(rows())
        refused(
          yield* Effect.exit(
            db.aggregates.Teams.update({ id: "t", k: 5 }, ({ state }: any) => ({
              ...state,
              lines: [...state.lines, { n: 7n, note: "z" }],
            })),
          ),
          "n",
          /edge \\"lines\\"'s sort key/,
        )
        expect(keysOf(rows())).toEqual(before)
      }),
    ),
  )

  it.effect("Schema.Any in a time-series orderBy", () =>
    on([], (db, rows) =>
      Effect.gen(function* () {
        refused(
          yield* Effect.exit(db.entities.Readings.append({ id: "r", at: 5n, v: "a" }).asEffect()),
          "at",
          /an event's sort key/,
        )
        expect(rows()).toEqual([])
        yield* db.entities.Readings.append({ id: "r", at: 5, v: "a" }).asEffect()
        expect(rows()).toHaveLength(2)
      }),
    ),
  )
})
