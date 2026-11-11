/**
 * `rekey` over one seeded table gives one outcome whatever order its scan hands the rows over
 * (#240): every segment count, every order within a page, one row at a time or several at once. The
 * table holds each shape whose outcome once depended on that order — rows whose keys chain (each
 * one's current key where the next is stored), two items holding each other's current sentinel
 * keys under different constraints, aggregates sharing a partition whose rows chain across owners,
 * aggregates whose partitions chain, and a unique sentinel no row holds where a moving sentinel goes —
 * and every run must report the same, leave the same rows, agree with its dry run, and leave a
 * second run nothing to do. With `releaseOrphanedReservations` the sentinel no row holds is released
 * and the moving one takes its key; without, the move is refused, whichever of the two the scan
 * meets first, and the sentinel is reported with `reservations`, or counted `unrecognizedKey` as
 * 1.40.0 counted it.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { describe, expect, it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Effect, Layer, Schema } from "effect"
import * as Aggregate from "../src/Aggregate.js"
import { DynamoClient, type DynamoClientService } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"
import { gatedLayer } from "./helpers/GatedClient.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"
import { rekeyOutcome } from "./helpers/RekeyOutcome.js"
import { storedRows } from "./helpers/StoredRows.js"

type Row = Record<string, AttributeValue>

const Plain = Schema.Struct({ id: Schema.String, note: Schema.String })
const Member = Schema.Struct({ id: Schema.String, email: Schema.String, nick: Schema.String })
const Line = Schema.Struct({ lid: Schema.String, owner: Schema.String, note: Schema.String })
const Route = Schema.Struct({ id: Schema.String, area: Schema.String })

const world = (escapeKeys: boolean) => {
  const schema = DynamoSchema.make({ name: "order", version: 1, escapeKeys })
  const Rows = Entity.make({
    model: Plain,
    entityType: "Row",
    primaryKey: { pk: { field: "pk", composite: [] }, sk: { field: "sk", composite: ["id"] } },
  })
  const Members = Entity.make({
    model: Member,
    entityType: "Member",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
    unique: { email: ["email"], nick: ["nick"] },
  })
  const MainTable = Table.make({ schema, entities: { Rows, Members } })
  const owner = (name: string) =>
    Aggregate.make(Schema.Struct({ id: Schema.String, lines: Schema.Array(Line) }), {
      schema,
      table: MainTable,
      pk: { field: "pk", composite: ["id"] },
      collection: { name: "shared" },
      root: { entityType: `Root${name}` },
      edges: {
        lines: Aggregate.many({
          entityType: "Line",
          sk: { composite: ["lid"] },
          assemble: (lines) =>
            (lines as ReadonlyArray<typeof Line.Type>).filter((line) => line.owner === name),
          decompose: (lines) => lines as ReadonlyArray<unknown>,
        }),
      },
    })
  const Routes = Aggregate.make(Route, {
    schema,
    table: MainTable,
    pk: { field: "pk", composite: ["id"] },
    collection: { name: "routes" },
    root: { entityType: "Route" },
    edges: {},
  })
  const aggregates = { A: owner("a"), B: owner("b"), C: owner("c"), Routes }
  return {
    MainTable,
    client: DynamoClient.make({ entities: { Rows, Members }, aggregates, tables: { MainTable } }),
  }
}

/** The table as written with escaping off: under on, each shape's keys chain. */
const seeded = Effect.gen(function* () {
  const table = makeRecordingTable()
  const off = world(false)
  yield* Effect.gen(function* () {
    const db = yield* off.client
    // `a b`'s current key is where `a%20b` is stored, whose current key is `a%2520b`'s.
    for (const id of ["a b", "a%20b", "a%2520b"]) {
      yield* db.entities.Rows.put({ id, note: id }).asEffect()
    }
    // m1's email goes where m2's is stored, and m2's nick where m1's is.
    yield* db.entities.Members.put({ id: "m1", email: "foo bar", nick: "x%20y" }).asEffect()
    yield* db.entities.Members.put({ id: "m2", email: "foo%20bar", nick: "x y" }).asEffect()
    // m3's email goes where m4's is stored, and m4 is gone: its sentinels are held by no row.
    yield* db.entities.Members.put({ id: "m3", email: "baz qux", nick: "m3" }).asEffect()
    yield* db.entities.Members.put({ id: "m4", email: "baz%20qux", nick: "m4" }).asEffect()
    // One partition: a's line goes where b's is stored, b's where c's is.
    const lids = { a: "x y", b: "x%20y", c: "x%2520y" } as const
    for (const name of ["a", "b", "c"] as const) {
      yield* db.aggregates[name.toUpperCase() as "A"].create({
        id: "p",
        lines: [{ lid: lids[name], owner: name, note: name }],
      })
    }
    // `q r`'s partition goes where `q%20r`'s is stored.
    yield* db.aggregates.Routes.create({ id: "q r", area: "one" })
    yield* db.aggregates.Routes.create({ id: "q%20r", area: "two" })
  }).pipe(Effect.provide(Layer.merge(table.layer, off.MainTable.layer({ name: "t" }))))
  for (const [key, row] of table.items) {
    if (row.__edd_e__?.S === "Member" && row.id?.S === "m4") table.items.delete(key)
  }
  return [...table.items.values()]
})

/** A seeded shuffle: the same `seed` gives the same order. */
const shuffled = <A>(items: ReadonlyArray<A>, seed: number): Array<A> => {
  let state = seed >>> 0
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1))
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

/** Scans whose pages come back in an order of `seed`'s (0: as read). */
const scanOrder =
  (seed: number): Parameters<typeof gatedLayer>[1] =>
  (command, _input, send) => {
    if (command !== "scan" || seed === 0) return send
    let page = 0
    return Effect.map(send, (output: any) => ({
      ...output,
      Items: shuffled(output.Items ?? [], seed * 7919 + page++),
    }))
  }

/** What a run decided, conflicts in an order of their own. */
const decided = (report: Table.RekeyReport) => {
  const { conflicts, ...rest } = rekeyOutcome(report)
  return {
    ...rest,
    conflicts: [...conflicts].sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)),
  }
}

/** The stored rows, every attribute's typed value included ({@link storedRows}). */
const storedOf = (rows: Iterable<Row>) => storedRows(rows)

describe.each([
  ["releasing", "release"],
  ["reporting", "report"],
  ["leaving", "leave"],
] as const)("rekey's outcome doesn't depend on the order it meets the rows in, %s orphans", (_, mode) => {
  const release = mode === "release"
  const first = new Map<string, unknown>()
  for (const segments of [1, 2, 3, 5]) {
    for (const seed of [0, 1, 2, 3]) {
      for (const concurrency of [1, 4]) {
        it.effect(`${segments} segment(s), order ${seed}, ${concurrency} at once`, () =>
          Effect.gen(function* () {
            const rows = yield* seeded
            const table = makeRecordingTable()
            for (const row of rows) table.items.set(`${row.pk?.S}|${row.sk?.S}`, row)
            const on = world(true)
            const layer = Layer.merge(
              gatedLayer(table.client as DynamoClientService, scanOrder(seed)),
              on.MainTable.layer({ name: "t" }),
            )
            const options = {
              segments,
              concurrency,
              pageSize: 3,
              ...(mode === "release" && { releaseOrphanedReservations: true, writesStopped: true }),
              ...(mode === "report" && { reservations: true }),
            }
            const runs = yield* Effect.gen(function* () {
              const db = yield* on.client
              const dry = yield* db.tables.MainTable.rekey({ ...options, dryRun: true })
              const untouched = storedOf(table.items.values())
              const real = yield* db.tables.MainTable.rekey(options)
              const after = storedOf(table.items.values())
              const again = yield* db.tables.MainTable.rekey(options)
              return { dry, untouched, real, after, again }
            }).pipe(Effect.provide(layer))

            // A dry run writes nothing and says what the run does.
            expect(runs.untouched).toEqual(storedOf(rows))
            expect(decided(runs.dry)).toEqual(decided(runs.real))
            // Every chain moves in one run, every row counted once. m4's sentinels are released,
            // and m3's email takes its key; or they're reported, or counted `unrecognizedKey`, and
            // m3's stays where it is.
            expect(runs.real.reservations).toMatchObject(
              mode === "release"
                ? { orphaned: 2, released: 2, skipped: 0, undecided: 0 }
                : mode === "report"
                  ? { orphaned: 2, released: 0, skipped: 0, undecided: 0 }
                  : { orphaned: 0, released: 0, skipped: 0, undecided: 0 },
            )
            expect(runs.real.skipped.unrecognizedKey).toBe(mode === "leave" ? 2 : 0)
            expect(runs.real.conflicts.map((conflict) => conflict.reason)).toEqual(
              release ? [] : ["taken"],
            )
            expect(runs.real.scanned).toBe(rows.length)
            // A second run finds nothing to move.
            expect(runs.again.moved).toEqual({
              item: 0,
              snapshot: 0,
              tombstone: 0,
              outbox: 0,
              event: 0,
              aggregate: 0,
              stream: 0,
            })
            expect(runs.again.sentinelsMoved).toBe(0)
            expect(runs.again.conflicts).toEqual(runs.real.conflicts)
            expect(runs.again.reservations.released).toBe(0)
            expect(storedOf(table.items.values())).toEqual(runs.after)
            // The same report and the same rows whatever the order.
            const outcome = { report: decided(runs.real), rows: runs.after }
            const seen = first.get("outcome")
            if (seen === undefined) first.set("outcome", outcome)
            else expect(outcome).toEqual(seen)
          }),
        )
      }
    }
  }
})
