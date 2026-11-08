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
 * What a guard still can't see:
 * - a write that only adds an attribute none of the member's declarations name;
 * - on a row too wide to guard whole, a write to an attribute the guard leaves out that doesn't
 *   change `updatedAt`, and with no `updatedAt`, any such write: `unprovableRow` decides those rows,
 *   and guards them as 1.39.0 did.
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

export const scenarios: ReadonlyArray<RaceScenario> = Object.entries(fixture.cases).map(
  ([fullName, stored]) => {
    const name = fullName.replace(/^escape /, "")
    const [kind, width, stamps] = name.split(":")[0]!.split(" ")
    const why = lost[name]
    return {
      name: `${name}: ${why === undefined ? "kept" : `lost (${why})`}`,
      run: (harness) => {
        const w =
          kind === "entity"
            ? entityWorld(width === "wide", stamps === "timestamps")
            : aggregateWorld(width === "wide", stamps === "timestamps")
        return harness.on(w, (table) =>
          Effect.gen(function* () {
            for (const row of stored.seed) yield* table.seed(row)
            const db: any = yield* w.client
            let landed = 0
            table.beforeTransact(() => (landed++ === 0 ? table.seed(stored.raced) : Effect.void))
            const report = yield* db.tables.MainTable.rekey()
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
  },
)
