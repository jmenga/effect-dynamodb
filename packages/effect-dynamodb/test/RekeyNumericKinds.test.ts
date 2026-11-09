/**
 * `rekey` moves rows stored under the other numeric kind's key text (`EDD-9128`), request capture.
 * A field declared `Schema.Union([Schema.Number, Schema.BigInt])` composed each value's own kind's
 * text: `5` gave 16 digits and `5n` gave 38. A key composite is now refused that union at load, so
 * the field is declared one kind, and its rows under the other kind's text are found and moved to
 * the text the values read back as.
 *
 * The rows are what published 1.39.0 stored: items, an index key, unique sentinels, a tombstone,
 * time-series events, an aggregate's partition and a `many` edge's rows, and a `Schema.Unknown` key
 * holding a bigint safe integer, which reads back as a number. Two items holding `3` and `3n` read
 * back as one item; they're reported and left. A unique constraint over four such fields stored
 * each sentinel under another mix of the kinds (`fixtures/kind-sentinel-mix-1.39.0.json`): each
 * moves, and the reads it costs are pinned. Scenarios: `helpers/RekeyNumericKindScenarios.ts`;
 * connected twin: `connected.rekey-numeric-kinds.test.ts`.
 */

import { readFileSync } from "node:fs"
import { it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Effect, Schema } from "effect"
import { describe, expect } from "vitest"
import * as Aggregate from "../src/Aggregate.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"
import {
  definitions,
  fixtureRows,
  keysOf,
  mixDefinitions,
  mixKeysOf,
  mixRows,
  mixScenarios,
  mixSentinel,
  type Row,
  scenarios,
} from "./helpers/RekeyNumericKindScenarios.js"

const on = <A, E>(
  Kind: Schema.Top,
  body: (db: any, keys: Effect.Effect<ReadonlyArray<string>>) => Effect.Effect<A, E, any>,
) => {
  const { Counters, Readings, Loose, Main, Teams } = definitions(Kind)
  const table = makeRecordingTable({ indexes: { gsi1: { pk: "gsi1pk", sk: "gsi1sk" } } })
  for (const row of fixtureRows) {
    table.items.set(`${row.pk!.S}|${row.sk!.S}`, structuredClone(row) as never)
  }
  const keys = Effect.sync(() => keysOf([...table.items.values()] as unknown as ReadonlyArray<Row>))
  return Effect.gen(function* () {
    const db = yield* DynamoClient.make({
      entities: { Counters, Readings, Loose },
      aggregates: { Teams },
      tables: { Main },
    } as never) as Effect.Effect<any, never, any>
    return yield* body(db, keys)
  }).pipe(Effect.provide(Main.layer({ name: "t" })), Effect.provide(table.layer)) as Effect.Effect<
    A,
    unknown
  >
}

const N = (m: number) => String(m).padStart(16, "0")

describe("rekey moves rows under the other numeric kind's text (EDD-9128)", () => {
  for (const scenario of scenarios) {
    it.effect(scenario.name, () => on(scenario.Kind, (db, keys) => scenario.check(db, keys)))
  }

  it.effect("rows under their current keys cost no read of the other kind's keys", () => {
    const { Counters, Main } = definitions(Schema.Number)
    const table = makeRecordingTable({ indexes: { gsi1: { pk: "gsi1pk", sk: "gsi1sk" } } })
    return Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { Counters },
        tables: { Main },
      } as never) as Effect.Effect<any, never, any>
      for (const n of [1, 2, 3]) {
        yield* db.entities.Counters.put({ id: `i${n}`, n, m: n, note: "x" }).asEffect()
      }
      table.take()
      const report = yield* db.tables.Main.rekey()
      // The items; a sentinel is its item's.
      expect(report.unchanged).toBe(3)
      const sentinelReads = table
        .take()
        .filter((request) => request.command === "GetItem")
        .map((request) => request.input.Key.pk.S as string)
        .filter((pk) => pk.startsWith("$kin#v1#counters.bym#"))
      // Each item's sentinel, under its current key, and no key under the other kind's text.
      expect(sentinelReads.sort()).toEqual([1, 2, 3].map((m) => `$kin#v1#counters.bym#${N(m)}`))
    }).pipe(
      Effect.provide(Main.layer({ name: "t" })),
      Effect.provide(table.layer),
    ) as Effect.Effect<void, unknown>
  })

  it.effect("a dry run counts the same moves and writes nothing", () =>
    on(Schema.Number, (db, keys) =>
      Effect.gen(function* () {
        const before = yield* keys
        const dry = yield* db.tables.Main.rekey({ dryRun: true })
        expect(yield* keys).toEqual(before)
        const real = yield* db.tables.Main.rekey()
        expect(dry.moved).toEqual(real.moved)
        expect(dry.sentinelsMoved).toBe(real.sentinelsMoved)
      }),
    ),
  )

  it.effect(
    "a clean run of a key with many numeric composites composes no other kind's text",
    () => {
      // 18 `Schema.Number` composites in one index sort key: trying each combination of kinds would
      // compose 262,144 keys for this one item.
      const fields = Array.from({ length: 18 }, (_, i) => `n${i}`)
      const Wide = Entity.make({
        model: Schema.Struct({
          id: Schema.String,
          ...Object.fromEntries(fields.map((field) => [field, Schema.Number])),
        }),
        entityType: "Wide",
        primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
        indexes: {
          byN: {
            name: "gsi1",
            pk: { field: "gsi1pk", composite: ["id"] },
            sk: { field: "gsi1sk", composite: fields },
          },
        },
      } as never) as any
      const Wide_ = Table.make({
        schema: DynamoSchema.make({ name: "wide", version: 1 }),
        entities: { Wide },
      } as never) as any
      const table = makeRecordingTable({ indexes: { gsi1: { pk: "gsi1pk", sk: "gsi1sk" } } })
      return Effect.gen(function* () {
        const db = yield* DynamoClient.make({
          entities: { Wide },
          tables: { Wide_ },
        } as never) as Effect.Effect<any, never, any>
        const values = Object.fromEntries(fields.map((field) => [field, 5]))
        yield* db.entities.Wide.put({ id: "x", ...values }).asEffect()
        table.take()
        const started = performance.now()
        const report = yield* db.tables.Wide_.rekey()
        const elapsed = performance.now() - started
        expect(report.unchanged).toBe(1)
        expect(report.conflicts).toEqual([])
        expect(table.take().map((request) => request.command)).toEqual(["Scan"])
        // About a millisecond; each combination composed was about half a second here.
        expect(elapsed).toBeLessThan(250)

        // The index key with a third of its composites under the bigint's text: found composite by
        // composite, never by trying each combination, and rewritten.
        const B = (digits: string) => digits.padStart(38, "0")
        const row = [...table.items.values()][0] as any
        const stored = `$wide#v1#wide#${fields
          .map((field, i) => `${field}_${i % 3 === 0 ? B("5") : N(5)}`)
          .join("#")}`
        row.gsi1sk = { S: stored }
        const moving = performance.now()
        const moved = yield* db.tables.Wide_.rekey()
        expect(performance.now() - moving).toBeLessThan(250)
        expect(moved.indexKeysRewritten).toBe(1)
        expect(([...table.items.values()][0] as any).gsi1sk.S).toBe(
          `$wide#v1#wide#${fields.map((field) => `${field}_${N(5)}`).join("#")}`,
        )
      }).pipe(
        Effect.provide(Wide_.layer({ name: "t" })),
        Effect.provide(table.layer),
      ) as Effect.Effect<void, unknown>
    },
  )
})

// Edges 3 and 3n, two elements on 1.39.0, read back as one value once a kind is declared: they
// compose one sort key, which a write refuses. Whether two rows are one element's can't be told
// from what's stored, so the aggregate is `failed` with that refusal, as 1.39.0 fails elements
// composing one sort key.
describe("rekey fails an aggregate whose many edge's rows read back as one element (EDD-9128)", () => {
  type EdgeRow = Record<string, { readonly S?: string; readonly N?: string }>
  /** What published 1.39.0 stored for edges 3 and 3n, and for -3n alone: `gen-colliding-edges.mjs`. */
  const edgeRows = JSON.parse(
    readFileSync(new URL("./fixtures/colliding-edges-1.39.0.json", import.meta.url), "utf8"),
  ) as {
    readonly escapeKeysOff: ReadonlyArray<EdgeRow>
    readonly escapeKeysOn: ReadonlyArray<EdgeRow>
  }
  const edges = (Kind: Schema.Top, escapeKeys: boolean) => {
    const schema = DynamoSchema.make({ name: "edges", version: 1, escapeKeys })
    const Main = Table.make({ schema, entities: {} } as never) as any
    const Roots = (Aggregate.make as any)(
      Schema.Struct({
        id: Schema.String,
        lines: Schema.Array(Schema.Struct({ n: Kind, note: Schema.String })),
      }),
      {
        table: Main,
        schema,
        pk: { field: "pk", composite: ["id"] },
        collection: { name: "roots" },
        root: { entityType: "Root" },
        edges: { lines: Aggregate.many({ entityType: "Line", sk: { composite: ["n"] } }) },
      },
    )
    const table = makeRecordingTable()
    for (const row of escapeKeys ? edgeRows.escapeKeysOn : edgeRows.escapeKeysOff) {
      table.items.set(`${row.pk!.S}|${row.sk!.S}`, structuredClone(row) as never)
    }
    const run = <A>(body: (db: any) => Effect.Effect<A, unknown, any>) =>
      Effect.gen(function* () {
        const db = yield* DynamoClient.make({
          entities: {},
          aggregates: { Roots },
          tables: { Main },
        } as never) as Effect.Effect<any, never, any>
        return yield* body(db)
      }).pipe(
        Effect.provide(Main.layer({ name: "t" })),
        Effect.provide(table.layer),
      ) as Effect.Effect<A, unknown>
    return { table, run }
  }
  const B = (digits: string) => digits.padStart(38, "0")

  for (const escapeKeys of [false, true]) {
    for (const [declared, Kind, current] of [
      ["Schema.Number", Schema.Number, N(3)],
      ["Schema.BigInt", Schema.BigInt, B("3")],
    ] as const) {
      it.effect(
        `declared ${declared}, escapeKeys ${escapeKeys}: both rows are left, and the aggregate failed`,
        () => {
          const { table, run } = edges(Kind, escapeKeys)
          const both = (rows: ReadonlyArray<unknown>) =>
            (rows as ReadonlyArray<EdgeRow>).filter((row) => row.pk?.S === "$edges#v1#roots#both")
          const before = structuredClone(both([...table.items.values()]))
          return run((db) =>
            Effect.gen(function* () {
              const report = yield* db.tables.Main.rekey()
              expect(both([...table.items.values()])).toEqual(before)
              expect(report.conflicts).toEqual([
                expect.objectContaining({
                  member: "Root",
                  kind: "aggregate",
                  reason: "failed",
                  message:
                    `AggregateDecompositionError: "lines" and "lines" both compose the sort key ` +
                    `"$edges#v1#line#${current}", so one would overwrite the other. Give the ` +
                    `"lines" edge a declared sort key naming attributes that differ between its ` +
                    `elements: lines: Aggregate.many({ …, sk: { composite: [...] } }).`,
                }),
              ])
            }),
          )
        },
      )
    }

    it.effect(`escapeKeys ${escapeKeys}: an edge under the other kind's text alone moves`, () => {
      const { run } = edges(Schema.Number, escapeKeys)
      return run((db) =>
        Effect.gen(function* () {
          const report = yield* db.tables.Main.rekey()
          // The lone -3n edge, and under escapeKeys its partition's root too.
          expect(report.moved.aggregate).toBeGreaterThanOrEqual(1)
          expect(yield* db.aggregates.Roots.get({ id: "a #_%" })).toEqual({
            id: "a #_%",
            lines: [{ n: -3, note: "bigint" }],
          })
          const again = yield* db.tables.Main.rekey()
          expect(again.moved.aggregate).toBe(0)
        }),
      )
    })
  }
})

describe("rekey moves a unique sentinel from whichever mix of kinds it is under (EDD-9128)", () => {
  const mix = <A, E>(
    escapeKeys: boolean,
    body: (db: any, table: any) => Effect.Effect<A, E, any>,
  ) => {
    const { Mixed, Main } = mixDefinitions(escapeKeys)
    const table = makeRecordingTable()
    for (const row of mixRows)
      table.items.set(`${row.pk!.S}|${row.sk!.S}`, structuredClone(row) as never)
    return Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { Mixed },
        tables: { Main },
      } as never) as Effect.Effect<any, never, any>
      return yield* body(db, table)
    }).pipe(
      Effect.provide(Main.layer({ name: "t" })),
      Effect.provide(table.layer),
    ) as Effect.Effect<A, unknown>
  }
  const sentinelReads = (requests: ReadonlyArray<any>) =>
    requests
      .filter((request) => request.command === "GetItem")
      .map((request) => request.input.Key.pk.S as string)
      .filter((pk) => pk.startsWith("$mix#v1#mixed.four#"))

  for (const scenario of mixScenarios) {
    it.effect(scenario.name, () =>
      mix(scenario.escapeKeys, (db, table) =>
        scenario.check(
          db,
          Effect.sync(() => mixKeysOf([...table.items.values()] as unknown as ReadonlyArray<Row>)),
        ),
      ),
    )
  }

  it.effect("a row under its current key: its sentinel is read where the scan found it", () =>
    mix(false, (db, table) =>
      Effect.gen(function* () {
        table.take()
        yield* db.tables.Main.rekey()
        // Each sentinel under its current key, and where 1.39.0 stored it: no other mix is read.
        expect(new Set(sentinelReads(table.take()))).toEqual(
          new Set([
            ...[
              [1, 2, 3, 4],
              [5, 6, 7, 8],
              [9, 10, 11, 12],
              [13, 14, 15, 16],
            ].map((values) => mixSentinel(...values)),
            mixSentinel("B1", "B2", 3, 4),
            mixSentinel(5, "B6", "B7", "B8"),
            mixSentinel("B9", 10, 11, 12),
            mixSentinel("B13", 14, "B15", 16),
          ]),
        )
      }),
    ),
  )

  it.effect("a moving row reads the other mixes, fewest first, until one holds its sentinel", () =>
    mix(true, (db, table) =>
      Effect.gen(function* () {
        table.take()
        yield* db.tables.Main.rekey()
        // The tombstone's: 14 is its second value, under either text.
        const tombstone = sentinelReads(table.take()).filter((pk) => /#0+14#/.test(pk))
        expect(tombstone.slice(0, 8)).toEqual([
          mixSentinel(13, 14, 15, 16),
          // Each value alone as the other kind, and all of them.
          mixSentinel("B13", 14, 15, 16),
          mixSentinel(13, "B14", 15, 16),
          mixSentinel(13, 14, "B15", 16),
          mixSentinel(13, 14, 15, "B16"),
          mixSentinel("B13", "B14", "B15", "B16"),
          // Then two of them: the first holds no sentinel, the second the tombstone's.
          mixSentinel("B13", "B14", 15, 16),
          mixSentinel("B13", 14, "B15", 16),
        ])
      }),
    ),
  )
})
