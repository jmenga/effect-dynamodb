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

/**
 * `e`, stored past 2^53, under `Schema.Number`: a read gives a bigint no number holds exactly, so no
 * key is composed for it, and it's reported and left with its sentinel.
 */
const eUnreadable = expect.objectContaining({
  member: "Counters",
  reason: "uncomposable",
  key: { pk: "$kin#v1#counters#id_e", sk: `$kin#v1#counters#n_${B("1152921504606846977")}` },
})
/** A run's conflicts in key order: the scan's order is the table's own. */
const conflictsByKey = (conflicts: ReadonlyArray<{ readonly key: { readonly pk: string } }>) =>
  [...conflicts].sort((a, b) => a.key.pk.localeCompare(b.key.pk))

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
          // `a` and the Unknown key's row; the tombstone; the `5n` event; the aggregate's root and
          // both edge rows, which move with the partition.
          item: 2,
          tombstone: 1,
          event: 1,
          aggregate: 3,
        })
        // `a`'s sentinel and the tombstone's.
        expect(report.sentinelsMoved).toBe(2)
        expect(conflictsByKey(report.conflicts)).toEqual([
          eUnreadable,
          ...bothThrees(B("3"), N("3")),
        ])
        expect(yield* keys).toEqual(
          [
            `$kin#v1#counters#id_a $kin#v1#counters#n_${N("5")} $kin#v1#counters#m_${N("7")}`,
            `$kin#v1#counters#id_b $kin#v1#counters#n_${N("6")} $kin#v1#counters#m_${N("8")}`,
            `$kin#v1#counters#id_c $kin#v1#counters#deleted#n_${N("9")}#<deleted at> `,
            // No number holds it, so it stays as stored, its sentinel with it.
            `$kin#v1#counters#id_e $kin#v1#counters#n_${B("1152921504606846977")} $kin#v1#counters#m_${N("13")}`,
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
        expect(conflictsByKey(again.conflicts)).toEqual([
          eUnreadable,
          ...bothThrees(B("3"), N("3")),
        ])
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

/**
 * What published 1.39.0 stored for a unique constraint over four fields declared the union, each
 * item holding another mix of the kinds (`fixtures/kind-sentinel-mix-1.39.0.json`): two of four as
 * bigints, three of four, one of four, and a tombstone keeping its reservation with two of four.
 * The sentinel's key gives each value its own kind's text, so it is under one mix of the two.
 */
export const mixRows = (
  JSON.parse(
    readFileSync(new URL("../fixtures/kind-sentinel-mix-1.39.0.json", import.meta.url), "utf8"),
  ) as { readonly rows: ReadonlyArray<Row> }
).rows

/** The fixture's definitions, the four fields now declared `Schema.Number`. */
export const mixDefinitions = (escapeKeys: boolean) => {
  const Mixed = Entity.make({
    model: Schema.Struct({
      id: Schema.String,
      a: Schema.Number,
      b: Schema.Number,
      c: Schema.Number,
      d: Schema.Number,
      note: Schema.String,
    }),
    entityType: "Mixed",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
    unique: { four: ["a", "b", "c", "d"] },
    softDelete: { preserveUnique: true },
  } as never) as any
  const Main = Table.make({
    schema: DynamoSchema.make({ name: "mix", version: 1, escapeKeys }),
    entities: { Mixed },
  } as never) as any
  return { Mixed, Main }
}

/** A row's keys, and for a sentinel the key it names, sorted, a tombstone's time of delete left out. */
export const mixKeysOf = (rows: ReadonlyArray<Row>): ReadonlyArray<string> =>
  rows
    .map((row) => [row.pk?.S, row.sk?.S, row._entity_pk?.S ?? ""].join(" "))
    .map((key) => key.replace(/#\d{4}-\d\d-\d\dT\S*/, "#<deleted at>"))
    .sort()

/** The constraint's sentinel key, each value under its number text, or `B` under the bigint's. */
export const mixSentinel = (...values: ReadonlyArray<number | `B${number}`>) =>
  `$mix#v1#mixed.four#${values
    .map((value) => (typeof value === "number" ? N(String(value)) : B(value.slice(1))))
    .join("#")}`

/** The items' values, as 1.39.0 stored them (`B`, a bigint) and as they read back now. */
const mixItems = [
  { id: "a#b", stored: ["B1", "B2", 3, 4], now: [1, 2, 3, 4], live: true },
  { id: "m3", stored: [5, "B6", "B7", "B8"], now: [5, 6, 7, 8], live: true },
  { id: "one", stored: ["B9", 10, 11, 12], now: [9, 10, 11, 12], live: true },
  { id: "g#1", stored: ["B13", 14, "B15", 16], now: [13, 14, 15, 16], live: false },
] as const

export const mixScenarios: ReadonlyArray<{
  readonly name: string
  readonly escapeKeys: boolean
  readonly check: (
    db: any,
    keys: Effect.Effect<ReadonlyArray<string>>,
  ) => Effect.Effect<void, unknown, any>
}> = [false, true].map((escapeKeys) => ({
  name: `escapeKeys ${escapeKeys}: each sentinel moves from whichever mix of kinds it is under`,
  escapeKeys,
  check: (db, keys) =>
    Effect.gen(function* () {
      const idKey = (id: string) => `$mix#v1#mixed#id_${escapeKeys ? id.replace("#", "%23") : id}`
      const before = yield* keys
      expect(before).toEqual(
        [
          ...mixItems.map(
            (item) =>
              `$mix#v1#mixed#id_${item.id} $mix#v1#mixed${item.live ? "" : "#deleted#<deleted at>"} `,
          ),
          ...mixItems.map(
            (item) =>
              `${mixSentinel(...item.stored)} $mix#v1#mixed.four $mix#v1#mixed#id_${item.id}`,
          ),
        ].sort(),
      )
      const dry = yield* db.tables.Main.rekey({ dryRun: true })
      expect(yield* keys).toEqual(before)
      const report = yield* db.tables.Main.rekey()
      // The keys `#` is in move when they're escaped: the item and the tombstone.
      expect(report.moved).toEqual({ ...ZERO, ...(escapeKeys && { item: 1, tombstone: 1 }) })
      expect(report.sentinelsMoved).toBe(4)
      expect(report.conflicts).toEqual([])
      expect(report.skipped.unrecognizedKey).toBe(0)
      expect(dry.moved).toEqual(report.moved)
      expect(dry.sentinelsMoved).toBe(report.sentinelsMoved)
      expect(dry.conflicts).toEqual(report.conflicts)
      expect(yield* keys).toEqual(
        [
          ...mixItems.map(
            (item) => `${idKey(item.id)} $mix#v1#mixed${item.live ? "" : "#deleted#<deleted at>"} `,
          ),
          ...mixItems.map(
            (item) => `${mixSentinel(...item.now)} $mix#v1#mixed.four ${idKey(item.id)}`,
          ),
        ].sort(),
      )

      // Each reservation holds under the number's text, the tombstone's too.
      for (const item of mixItems) {
        const [a, b, c, d] = item.now
        const taken = yield* Effect.exit(
          db.entities.Mixed.put({ id: "z", a, b, c, d, note: "x" }).asEffect(),
        )
        expect(Exit.isFailure(taken) && JSON.stringify(taken)).toContain(
          "UniqueConstraintViolation",
        )
      }
      expect(yield* db.entities.Mixed.get({ id: "a#b" })).toMatchObject({ a: 1, b: 2, c: 3, d: 4 })

      // Nothing more to move.
      const again = yield* db.tables.Main.rekey()
      expect(again.moved).toEqual(ZERO)
      expect(again.sentinelsMoved).toBe(0)
      expect(again.conflicts).toEqual([])
      expect(again.skipped.unrecognizedKey).toBe(0)

      // The tombstone's reservation is its item's, under the key it has now: restore takes it back.
      expect(yield* db.entities.Mixed.restore({ id: "g#1" })).toMatchObject({ a: 13, c: 15 })
    }),
}))
