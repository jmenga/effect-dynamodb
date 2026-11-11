/**
 * A write landing on a row between `rekey`'s read and its move. The move's Delete is guarded on the
 * row as read, so a write the guard sees cancels the move, and `rekey` reads the row again and moves
 * it with the write.
 *
 * The rows are published 1.39.0's own (`fixtures/rekey-races-1.39.0.json`). Each case holds:
 * - the rows as 1.39.0 wrote them with `escapeKeys` off;
 * - the row a concurrent write left at the old key, read back from DynamoDB Local just before
 *   `rekey`'s first transaction under 1.39.0;
 * - whether 1.39.0's `rekey` kept that write.
 *
 * Each case runs with writes to the table going on (the default) and with them stopped
 * (`writesStopped: true`). A row too wide to guard whole, of a member with no `updatedAt`, can't be
 * proven unchanged: by default it's left, reported `unguarded`, with nothing written; with writes
 * stopped it moves under the strongest guard that fits, as 1.39.0 did.
 *
 * What a guard still can't see, writes going on:
 * - a write that only adds an attribute none of the member's declarations name;
 * - on a row too wide to guard whole, a write to an attribute the guard leaves out that doesn't
 *   change `updatedAt`.
 * With writes stopped there's no such write.
 */
import { readFileSync } from "node:fs"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Effect, Schema } from "effect"
import { expect } from "vitest"
import * as Aggregate from "../../src/Aggregate.js"
import { DynamoClient } from "../../src/DynamoClient.js"
import * as Entity from "../../src/Entity.js"
import * as Table from "../../src/Table.js"
import type { Harness } from "./RekeyRepair.js"

type Row = Record<string, any>

const fixture: {
  readonly cases: Readonly<
    Record<
      string,
      { readonly seed: ReadonlyArray<Row>; readonly raced: Row; readonly outcome: "kept" | "lost" }
    >
  >
} = JSON.parse(
  readFileSync(new URL("../fixtures/rekey-races-1.39.0.json", import.meta.url), "utf8"),
)

// The fixture's definitions, as its generator declared them, rekeyed with `escapeKeys` on.
const schema = DynamoSchema.make({ name: "f4", version: 1, escapeKeys: true })
const fillers = (wide: boolean) =>
  wide
    ? Object.fromEntries(
        Array.from({ length: 160 }, (_, i) => [`f${String(i).padStart(3, "0")}`, Schema.String]),
      )
    : {}

const entityWorld = (wide: boolean, timestamps: boolean) => {
  const Item = Entity.make({
    model: Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      note: Schema.optionalKey(Schema.String),
      ...fillers(wide),
    }),
    entityType: "Item",
    primaryKey: {
      pk: { field: "pk", composite: ["id"] },
      sk: { field: "sk", composite: ["name"] },
    },
    ...(timestamps && { timestamps: true }),
  } as never) as any
  const MainTable = Table.make({ schema, entities: { Item } } as never) as any
  return { MainTable, client: DynamoClient.make({ entities: { Item }, tables: { MainTable } }) }
}

const aggregateWorld = (wide: boolean, timestamps: boolean) => {
  const MainTable = Table.make({ schema, entities: {} } as never) as any
  const Line = Schema.Struct({
    name: Schema.String,
    v: Schema.String,
    note: Schema.optionalKey(Schema.String),
    ...fillers(wide),
  })
  const Order = (Aggregate.make as any)(
    Schema.Struct({ id: Schema.String, lines: Schema.Array(Line) }),
    {
      schema,
      table: MainTable,
      pk: { field: "pk", composite: ["id"] },
      collection: { name: "orders" },
      root: { entityType: "Order" },
      ...(timestamps && { timestamps: true }),
      edges: { lines: Aggregate.many({ entityType: "Line", sk: { composite: ["name"] } }) },
    },
  )
  return {
    MainTable,
    client: DynamoClient.make({
      entities: {},
      aggregates: { Order },
      tables: { MainTable },
    } as never),
  }
}

/** Why a case loses its write, for the cases that still do. */
export type Unseen = "foreign attribute" | "too wide, no updatedAt" | "too wide, updatedAt kept"

/** The `rekey` setting a scenario runs under. */
export interface Setting {
  readonly writesStopped: boolean
}

export const SETTINGS: ReadonlyArray<readonly [label: string, setting: Setting]> = [
  ["writes going on", { writesStopped: false }],
  ["writes stopped", { writesStopped: true }],
]

const lost: Readonly<Record<string, Unseen>> = {
  "entity narrow plain: raw write adds an attribute the model doesn't have": "foreign attribute",
  "entity narrow timestamps: raw write adds an attribute the model doesn't have":
    "foreign attribute",
  "entity wide plain: raw write adds an attribute the model doesn't have": "foreign attribute",
  "entity wide timestamps: raw write adds an attribute the model doesn't have": "foreign attribute",
  "aggregate narrow plain: raw write adds an attribute the model doesn't have": "foreign attribute",
  "aggregate narrow timestamps: raw write adds an attribute the model doesn't have":
    "foreign attribute",
  "aggregate wide plain: raw write adds an attribute the model doesn't have": "foreign attribute",
  "aggregate wide timestamps: raw write adds an attribute the model doesn't have":
    "foreign attribute",
  "entity wide plain: library update changes f159": "too wide, no updatedAt",
  "entity wide plain: raw write changes f159": "too wide, no updatedAt",
  "aggregate wide plain: library update adds the absent model field note": "too wide, no updatedAt",
  "aggregate wide plain: raw write adds the absent model field note": "too wide, no updatedAt",
  "aggregate wide plain: library update changes f159": "too wide, no updatedAt",
  "aggregate wide plain: raw write changes f159": "too wide, no updatedAt",
  "entity wide timestamps: raw write changes f159": "too wide, updatedAt kept",
  "aggregate wide timestamps: raw write changes f159": "too wide, updatedAt kept",
  // 1.39.0's guard fills the expression: the absent field's term is appended only where it fits.
  "aggregate wide timestamps: raw write adds the absent model field note":
    "too wide, updatedAt kept",
}

/** The attribute each concurrent write sets, and its value. */
const writeOf = (name: string): readonly [string, string] =>
  name.includes("f159")
    ? ["f159", "changed"]
    : name.includes("model doesn't have")
      ? ["zz_foreign", "added"]
      : ["note", "added"]

export interface RaceScenario {
  readonly name: string
  readonly run: (harness: Harness) => Effect.Effect<void, unknown>
}

export const CASES = Object.keys(fixture.cases).map((name) => name.replace(/^escape /, ""))
export const LOST = lost

/**
 * A wide row of a member with no `updatedAt`, writes going on: left where it is, reported, before
 * anything is written, in a dry run too. An aggregate's other rows stay with it.
 */
const leftUnguarded = (
  w: { readonly client: Effect.Effect<any, any, any> },
  table: Parameters<Parameters<Harness["on"]>[1]>[0],
  seed: ReadonlyArray<Row>,
) =>
  Effect.gen(function* () {
    for (const row of seed) yield* table.seed(row)
    const db: any = yield* w.client
    const before = yield* table.rows()
    const wide = seed.filter((row) => Object.keys(row).length > 100)
    expect(wide).toHaveLength(1)
    for (const dryRun of [true, false]) {
      table.clear()
      const report = yield* db.tables.MainTable.rekey({ dryRun })
      expect(report.conflicts).toEqual([
        expect.objectContaining({
          reason: "unguarded",
          key: { pk: wide[0]!.pk.S, sk: wide[0]!.sk.S },
          message: expect.stringContaining("writesStopped: true"),
        }),
      ])
      expect(report.moved).toEqual(expect.objectContaining({ item: 0, aggregate: 0 }))
      const writes = table
        .requests()
        .filter((request) =>
          ["putItem", "deleteItem", "updateItem", "transactWriteItems"].includes(request.command),
        )
      expect(writes).toEqual([])
      expect(yield* table.rows()).toEqual(before)
    }
  })

export const scenarios = (setting: Setting): ReadonlyArray<RaceScenario> =>
  Object.entries(fixture.cases).map(([fullName, stored]) => {
    const name = fullName.replace(/^escape /, "")
    const [kind, width, stamps] = name.split(":")[0]!.split(" ")
    const unguarded = !setting.writesStopped && width === "wide" && stamps === "plain"
    const why = lost[name]
    return {
      name: `${name}: ${unguarded ? "unguarded" : why === undefined ? "kept" : `lost (${why})`}`,
      run: (harness) => {
        const w =
          kind === "entity"
            ? entityWorld(width === "wide", stamps === "timestamps")
            : aggregateWorld(width === "wide", stamps === "timestamps")
        return harness.on(w, (table) =>
          Effect.gen(function* () {
            if (unguarded) return yield* leftUnguarded(w, table, stored.seed)
            for (const row of stored.seed) yield* table.seed(row)
            const db: any = yield* w.client
            let landed = 0
            table.beforeTransact(() => (landed++ === 0 ? table.seed(stored.raced) : Effect.void))
            const report = yield* db.tables.MainTable.rekey(setting)
            expect(landed).toBeGreaterThan(0)
            expect(report.conflicts).toEqual([])
            const rows = yield* table.rows()
            const [attribute, value] = writeOf(name)
            const kept = rows.some(
              (row: Row) => row[attribute]?.S === value && row.__edd_e__?.S !== "Order",
            )
            const transactions = table
              .requests()
              .filter((request) => request.command === "transactWriteItems")
            if (why === undefined) {
              // The guard saw the write, cancelled the move, and the row moved again with it.
              expect(kept).toBe(true)
              expect(transactions.length).toBeGreaterThan(1)
            } else {
              expect(kept).toBe(false)
              expect(stored.outcome).toBe("lost")
              expect(transactions).toHaveLength(1)
            }
            // Either way, the row is at its new key alone.
            const moved = rows.filter((row: Row) => ["Item", "Line"].includes(row.__edd_e__?.S))
            expect(moved).toHaveLength(1)
            expect(moved[0]!.sk.S).toContain("a%20b")
          }),
        )
      },
    }
  })

/**
 * A timestamped member's row written before it stamped one: too wide to guard whole, with no
 * `updatedAt`. A library write of its member stamps one, so the guard holds it absent, proves the
 * row, and the row moves with writes going on; a write that lands in between stamps one, cancels
 * the move, and moves with the row.
 */
export const unstampedScenarios: ReadonlyArray<RaceScenario> = (["entity", "aggregate"] as const)
  .flatMap((kind) => SETTINGS.map(([label, setting]) => ({ kind, label, setting })))
  .map(({ kind, label, setting }) => ({
    name: `${kind} wide timestamps, a row written before it stamped updatedAt, ${label}: kept`,
    run: (harness: Harness) => {
      const stored = fixture.cases[`escape ${kind} wide plain: library update changes f159`]!
      const w = kind === "entity" ? entityWorld(true, true) : aggregateWorld(true, true)
      const wide = stored.seed.find((row) => Object.keys(row).length > 100)!
      expect(wide.updatedAt).toBeUndefined()
      const raced = {
        ...wide,
        f159: { S: "changed" },
        updatedAt: { S: "2026-11-09T00:00:00.000Z" },
      }
      return harness.on(w, (table) =>
        Effect.gen(function* () {
          for (const row of stored.seed) yield* table.seed(row)
          const db: any = yield* w.client
          let landed = 0
          table.beforeTransact(() => (landed++ === 0 ? table.seed(raced) : Effect.void))
          const report = yield* db.tables.MainTable.rekey(setting)
          expect(landed).toBeGreaterThan(0)
          expect(report.conflicts).toEqual([])
          const transactions = table
            .requests()
            .filter((request) => request.command === "transactWriteItems")
          expect(transactions.length).toBeGreaterThan(1)
          const rows = yield* table.rows()
          const moved = rows.filter((row: Row) => ["Item", "Line"].includes(row.__edd_e__?.S))
          expect(moved).toHaveLength(1)
          expect(moved[0]!.sk.S).toContain("a%20b")
          expect(moved[0]!.f159?.S).toBe("changed")
        }),
      )
    },
  }))
