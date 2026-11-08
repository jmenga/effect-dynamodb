/**
 * `rekey` over rows stored under the other numeric kind's key text (`EDD-9128`): the definitions,
 * the rows published 1.39.0 stored (`fixtures/kind-rows-1.39.0.json`), and what a run leaves, for
 * the request-capture test (`RekeyNumericKinds.test.ts`) and its connected twin
 * (`connected.rekey-numeric-kinds.test.ts`).
 */

import { readFileSync } from "node:fs"
import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Effect, Exit, Schema } from "effect"
import { expect } from "vitest"
import * as Aggregate from "../../src/Aggregate.js"
import * as Entity from "../../src/Entity.js"
import * as Table from "../../src/Table.js"

export type Row = Record<string, AttributeValue>

/** What published 1.39.0 stored, from its own `put`, `delete`, `append` and `create`. */
export const fixtureRows = (
  JSON.parse(
    readFileSync(new URL("../fixtures/kind-rows-1.39.0.json", import.meta.url), "utf8"),
  ) as { readonly rows: ReadonlyArray<Row> }
).rows

/** The fixture's definitions, with the union declared `Kind`. */
const schema = DynamoSchema.make({ name: "kin", version: 1, escapeKeys: false })
export const definitions = (Kind: Schema.Top) => {
  const Counters = Entity.make({
    model: Schema.Struct({ id: Schema.String, n: Kind, m: Kind, note: Schema.String }),
    entityType: "Counters",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: ["n"] } },
    indexes: {
      byM: {
        name: "gsi1",
        pk: { field: "gsi1pk", composite: ["id"] },
        sk: { field: "gsi1sk", composite: ["m"] },
      },
    },
    unique: { byM: ["m"] },
    softDelete: true,
  } as never) as any
  const Readings = Entity.make({
    model: Schema.Struct({ id: Schema.String, at: Kind, v: Schema.String }),
    entityType: "Readings",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
    timeSeries: {
      orderBy: "at",
      appendInput: Schema.Struct({ id: Schema.String, at: Kind, v: Schema.String }),
    },
  } as never) as any
  const Loose = Entity.make({
    model: Schema.Struct({ id: Schema.String, n: Schema.Unknown, note: Schema.String }),
    entityType: "Loose",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: ["n"] } },
  } as never) as any
  const Main = Table.make({ schema, entities: { Counters, Readings, Loose } } as never) as any
  const Teams = (Aggregate.make as any)(
    Schema.Struct({
      id: Schema.String,
      k: Kind,
      lines: Schema.Array(Schema.Struct({ n: Kind, note: Schema.String })),
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
  return { Counters, Readings, Loose, Main, Teams }
}

/** Each row's keys, sorted, a tombstone's time of delete left out. */
export const keysOf = (rows: ReadonlyArray<Row>): ReadonlyArray<string> =>
  rows
    .map((row) => [row.pk?.S, row.sk?.S, row.gsi1sk?.S ?? ""].join(" "))
    .map((key) => key.replace(/#\d{4}-\d\d-\d\dT\S*/, "#<deleted at>"))
    .sort()

const B = (digits: string) => digits.padStart(38, "0")
const N = (digits: string) => digits.padStart(16, "0")
const ZERO = { item: 0, snapshot: 0, tombstone: 0, outbox: 0, event: 0, aggregate: 0, stream: 0 }
/** `3` and `3n`, which read back as one item: left under both keys, and reported. */
const bothThrees = (stored: string, current: string) => [
  expect.objectContaining({
    member: "Counters",
    reason: "bothKeys",
    key: { pk: "$kin#v1#counters#id_f", sk: `$kin#v1#counters#n_${stored}` },
    target: { pk: "$kin#v1#counters#id_f", sk: `$kin#v1#counters#n_${current}` },
  }),
]

export interface Scenario {
  readonly name: string
  readonly Kind: Schema.Top
  /** Run `rekey` on `db` over the fixture's rows, then check the table (`keys`) and the reads. */
  readonly check: (
    db: any,
    keys: Effect.Effect<ReadonlyArray<string>>,
    // The bound client's requirements are its own: `db` is untyped here.
  ) => Effect.Effect<void, unknown, any>
}

export const scenarios: ReadonlyArray<Scenario> = [
  {
    name: "declared Schema.Number: bigint text moves to number text",
    Kind: Schema.Number,
    check: (db, keys) =>
      Effect.gen(function* () {
        const report = yield* db.tables.Main.rekey()
        expect(report.skipped.unrecognizedKey).toBe(0)
        expect(report.moved).toEqual({
          ...ZERO,
          // `a`, `e` and the Unknown key's row; the tombstone; the `5n` event; the aggregate's root
          // and both edge rows, which move with the partition.
          item: 3,
          tombstone: 1,
          event: 1,
          aggregate: 3,
        })
        // `a`'s sentinel and the tombstone's.
        expect(report.sentinelsMoved).toBe(2)
        expect(report.conflicts).toEqual(bothThrees(B("3"), N("3")))
        expect(yield* keys).toEqual(
          [
            `$kin#v1#counters#id_a $kin#v1#counters#n_${N("5")} $kin#v1#counters#m_${N("7")}`,
            `$kin#v1#counters#id_b $kin#v1#counters#n_${N("6")} $kin#v1#counters#m_${N("8")}`,
            `$kin#v1#counters#id_c $kin#v1#counters#deleted#n_${N("9")}#<deleted at> `,
            // Read back as the number it rounds to, and keyed by it.
            `$kin#v1#counters#id_e $kin#v1#counters#n_1152921504606847000 $kin#v1#counters#m_${N("13")}`,
            `$kin#v1#counters#id_f $kin#v1#counters#n_${B("3")} $kin#v1#counters#m_${B("12")}`,
            `$kin#v1#counters#id_f $kin#v1#counters#n_${N("3")} $kin#v1#counters#m_${N("11")}`,
            ...["7", "8", "10", "11", "13"].map(
              (m) => `$kin#v1#counters.bym#${N(m)} $kin#v1#counters.bym `,
            ),
            `$kin#v1#counters.bym#${B("12")} $kin#v1#counters.bym `,
            `$kin#v1#loose#id_u $kin#v1#loose#n_${N("5")} `,
            "$kin#v1#readings#id_r $kin#v1#readings ",
            `$kin#v1#readings#id_r $kin#v1#readings#e#${N("5")} `,
            `$kin#v1#readings#id_r $kin#v1#readings#e#${N("6")} `,
            `$kin#v1#team#t#${N("5")} $kin#v1#team `,
            `$kin#v1#team#t#${N("5")} $kin#v1#teamline#${N("6")} `,
            `$kin#v1#team#t#${N("5")} $kin#v1#teamline#${N("7")} `,
          ].sort(),
        )

        // Read under the keys the values compose now.
        expect((yield* db.entities.Counters.get({ id: "a", n: 5 })).m).toBe(7)
        expect(yield* db.entities.Counters.byM({ id: "a", m: 7 }).collect()).toHaveLength(1)
        expect((yield* db.entities.Loose.get({ id: "u", n: 5 })).note).toBe("bigint in unknown")
        expect(yield* db.aggregates.Teams.get({ id: "t", k: 5 })).toEqual({
          id: "t",
          k: 5,
          lines: [
            { n: 6, note: "number" },
            { n: 7, note: "bigint" },
          ],
        })
        const events = yield* db.entities.Readings.history({ id: "r" })
          .where((t: any, { eq }: any) => eq(t.at, 5))
          .collect()
        expect(events.map((event: any) => event.v)).toEqual(["bigint"])
        // `a`'s reservation of 7 holds under the number's text.
        const taken = yield* Effect.exit(
          db.entities.Counters.put({ id: "z", n: 1, m: 7, note: "x" }).asEffect(),
        )
        expect(Exit.isFailure(taken) && JSON.stringify(taken)).toContain(
          "UniqueConstraintViolation",
        )

        // Nothing more to move.
        const again = yield* db.tables.Main.rekey()
        expect(again.moved).toEqual(ZERO)
        expect(again.sentinelsMoved).toBe(0)
        expect(again.skipped.unrecognizedKey).toBe(0)
        expect(again.conflicts).toEqual(bothThrees(B("3"), N("3")))
      }),
  },
  {
    name: "declared Schema.BigInt: number text moves to bigint text",
    Kind: Schema.BigInt,
    check: (db, keys) =>
      Effect.gen(function* () {
        const report = yield* db.tables.Main.rekey()
        expect(report.skipped.unrecognizedKey).toBe(0)
        expect(report.moved).toEqual({
          ...ZERO,
          // `b` and the Unknown key's row (a bigint safe integer reads back as a number whatever
          // the other fields are); the `6` event; the `6` edge row.
          item: 2,
          event: 1,
          aggregate: 1,
        })
        // `e`'s index key, under its table key.
        expect(report.indexKeysRewritten).toBe(1)
        // `b`'s sentinel and `e`'s.
        expect(report.sentinelsMoved).toBe(2)
        expect(report.conflicts).toEqual(bothThrees(N("3"), B("3")))
        expect(yield* keys).toEqual(
          [
            `$kin#v1#counters#id_a $kin#v1#counters#n_${B("5")} $kin#v1#counters#m_${B("7")}`,
            `$kin#v1#counters#id_b $kin#v1#counters#n_${B("6")} $kin#v1#counters#m_${B("8")}`,
            `$kin#v1#counters#id_c $kin#v1#counters#deleted#n_${B("9")}#<deleted at> `,
            `$kin#v1#counters#id_e $kin#v1#counters#n_${B("1152921504606846977")} $kin#v1#counters#m_${B("13")}`,
            `$kin#v1#counters#id_f $kin#v1#counters#n_${B("3")} $kin#v1#counters#m_${B("12")}`,
            `$kin#v1#counters#id_f $kin#v1#counters#n_${N("3")} $kin#v1#counters#m_${N("11")}`,
            ...["7", "8", "10", "12", "13"].map(
              (m) => `$kin#v1#counters.bym#${B(m)} $kin#v1#counters.bym `,
            ),
            `$kin#v1#counters.bym#${N("11")} $kin#v1#counters.bym `,
            `$kin#v1#loose#id_u $kin#v1#loose#n_${N("5")} `,
            "$kin#v1#readings#id_r $kin#v1#readings ",
            `$kin#v1#readings#id_r $kin#v1#readings#e#${B("5")} `,
            `$kin#v1#readings#id_r $kin#v1#readings#e#${B("6")} `,
            `$kin#v1#team#t#${B("5")} $kin#v1#team `,
            `$kin#v1#team#t#${B("5")} $kin#v1#teamline#${B("6")} `,
            `$kin#v1#team#t#${B("5")} $kin#v1#teamline#${B("7")} `,
          ].sort(),
        )

        expect((yield* db.entities.Counters.get({ id: "b", n: 6n })).m).toBe(8n)
        expect(yield* db.entities.Counters.byM({ id: "e", m: 13n }).collect()).toHaveLength(1)
        expect(yield* db.aggregates.Teams.get({ id: "t", k: 5n })).toEqual({
          id: "t",
          k: 5n,
          lines: [
            { n: 6n, note: "number" },
            { n: 7n, note: "bigint" },
          ],
        })
        const events = yield* db.entities.Readings.history({ id: "r" })
          .where((t: any, { eq }: any) => eq(t.at, 6n))
          .collect()
        expect(events.map((event: any) => event.v)).toEqual(["number"])
        const taken = yield* Effect.exit(
          db.entities.Counters.put({ id: "z", n: 1n, m: 8n, note: "x" }).asEffect(),
        )
        expect(Exit.isFailure(taken) && JSON.stringify(taken)).toContain(
          "UniqueConstraintViolation",
        )

        const again = yield* db.tables.Main.rekey()
        expect(again.moved).toEqual(ZERO)
        expect(again.sentinelsMoved).toBe(0)
        expect(again.indexKeysRewritten).toBe(0)
        expect(again.skipped.unrecognizedKey).toBe(0)
        expect(again.conflicts).toEqual(bothThrees(N("3"), B("3")))
      }),
  },
]
