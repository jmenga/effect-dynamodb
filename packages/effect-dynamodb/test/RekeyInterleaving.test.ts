/**
 * `rekey` gives one outcome whatever order its scan segments, pages and handlers meet the rows in:
 * the same report, the same rows stored, and a dry run that says the same. Each test forces one
 * interleaving with a gated client ({@link gatedClient}): a row's two visits (the scan's, and a move's
 * that needs it out of the way) racing for one write, a segment scanned only after the run moved a row
 * it holds, aggregates sharing a partition met in every order. DynamoDB Local meets these only under
 * load (`connected.rekey-chains.test.ts`, `connected.sharding.test.ts`); here each runs every time.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { describe, expect, it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import * as KeyComposer from "@effect-dynamodb/schema/KeyComposer.js"
import { Deferred, Effect, Layer, Schema } from "effect"
import * as Aggregate from "../src/Aggregate.js"
import { DynamoClient, type DynamoClientService } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"
import { deletesAt, gatedLayer } from "./helpers/GatedClient.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"
import { rekeyOutcome } from "./helpers/RekeyOutcome.js"
import { storedRows } from "./helpers/StoredRows.js"

type Row = Record<string, AttributeValue>

/** What a run decided, conflicts in an order of their own. */
const decided = (report: Table.RekeyReport) => {
  const { conflicts, ...rest } = rekeyOutcome(report)
  return {
    ...rest,
    conflicts: [...conflicts].sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)),
  }
}

/** The stored rows, every attribute's typed value included ({@link storedRows}). */
const storedOf = (table: ReturnType<typeof makeRecordingTable>) => storedRows(table.items.values())

/** The segment of `TotalSegments: total` the recording table scans a key in. */
const segmentOf = (key: string, total: number) => {
  let hash = 0
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0
  return hash % total
}

// ---------------------------------------------------------------------------
// Unique sentinels: `foo%20bar`'s current key is where `foo bar`'s is stored under the other text
// ---------------------------------------------------------------------------

class Account extends Schema.Class<Account>("Account")({
  id: Schema.String,
  email: Schema.String,
}) {}

const accounts = (escapeKeys: boolean) => {
  const schema = DynamoSchema.make({ name: "inter", version: 1, escapeKeys })
  const Accounts = Entity.make({
    model: Account,
    entityType: "Account",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
    unique: { email: ["email"] },
  })
  const MainTable = Table.make({ schema, entities: { Accounts } })
  const client = DynamoClient.make({ entities: { Accounts }, tables: { MainTable } })
  return { schema, MainTable, client }
}

type AccountWorld = ReturnType<typeof accounts>

const sentinelPk = (w: AccountWorld, email: string) =>
  DynamoSchema.composeUniqueKey(w.schema, "Account", "email", [
    KeyComposer.keyText(w.schema, email, "lowercase"),
  ]).pk

/** Seed `values` (id → email) under the other text; run a dry run then a real run under `around`. */
const sentinelRuns = (
  escapeKeys: boolean,
  values: Readonly<Record<string, string>>,
  around: (now: AccountWorld, run: "dry" | "real") => Parameters<typeof gatedLayer>[1],
  options: Table.RekeyOptions = {},
) =>
  Effect.gen(function* () {
    const now = accounts(escapeKeys)
    const was = accounts(!escapeKeys)
    const table = makeRecordingTable()
    yield* Effect.gen(function* () {
      const db = yield* was.client
      for (const [id, email] of Object.entries(values)) {
        yield* db.entities.Accounts.put({ id, email }).asEffect()
      }
    }).pipe(Effect.provide(Layer.merge(table.layer, was.MainTable.layer({ name: "t" }))))
    const before = storedOf(table)
    const tableLayer = now.MainTable.layer({ name: "t" })
    const dry: Table.RekeyReport = yield* Effect.gen(function* () {
      const db = yield* now.client
      return yield* db.tables.MainTable.rekey({ ...options, dryRun: true })
    }).pipe(Effect.provide(Layer.merge(gatedLayer(table.client, around(now, "dry")), tableLayer)))
    expect(storedOf(table)).toEqual(before)
    const real: Table.RekeyReport = yield* Effect.gen(function* () {
      const db = yield* now.client
      return yield* db.tables.MainTable.rekey(options)
    }).pipe(Effect.provide(Layer.merge(gatedLayer(table.client, around(now, "real")), tableLayer)))
    const again: Table.RekeyReport = yield* Effect.gen(function* () {
      const db = yield* now.client
      return yield* db.tables.MainTable.rekey()
    }).pipe(Effect.provide(Layer.merge(table.layer, tableLayer)))
    return { now, table, dry, real, again }
  })

/** No gate: every request goes as it comes. */
const open = () => (_command: string, _input: unknown, send: Effect.Effect<any, any>) => send

/** Hold a request while the other fibers run as far as they can, then send it. */
const afterOthers = <A, E>(send: Effect.Effect<A, E>) =>
  Effect.andThen(
    Effect.forEach(Array.from({ length: 64 }), () => Effect.yieldNow, { discard: true }),
    send,
  )

/** Scans whose rows come in key order, or in reverse. */
const scanSorted =
  (descending: boolean) =>
  (command: string, send: Effect.Effect<any, any>): Effect.Effect<any, any> | undefined =>
    command !== "scan"
      ? undefined
      : Effect.map(send, (page: any) => {
          const key = (row: Row) => `${row.pk?.S}|${row.sk?.S}`
          const items = [...(page.Items ?? [])].sort((p: Row, q: Row) =>
            key(p) < key(q) ? -1 : key(p) > key(q) ? 1 : 0,
          )
          return { ...page, Items: descending ? items.reverse() : items }
        })

describe("a row's two visits judge it once", () => {
  for (const descending of [false, true]) {
    for (const concurrency of [1, 4]) {
      it.effect(
        `a sentinel the scan and a move both reach (${descending ? "reverse" : "key"} order, ${concurrency} at once)`,
        () =>
          Effect.gen(function* () {
            // Off: `foo%20bar`'s sentinel goes where `foo bar`'s is, so `foo%20bar`'s sentinel is
            // reached by the scan and by `foo bar`'s move. Each write is held while every other
            // visit runs as far as it can: a visit of a row being judged waits for its verdict and
            // writes nothing, so no key is written twice.
            const puts = new Map<string, number>()
            const { dry, real, again } = yield* sentinelRuns(
              false,
              { a: "foo%20bar", b: "foo bar" },
              (_now, run) => (command, input, send) => {
                const sorted = scanSorted(descending)(command, send)
                if (sorted !== undefined) return sorted
                if (command !== "transactWriteItems" || run !== "real") return send
                for (const op of input.TransactItems ?? []) {
                  const at = op.Put?.Item
                  if (at === undefined) continue
                  const key = `${at.pk?.S}|${at.sk?.S}`
                  puts.set(key, (puts.get(key) ?? 0) + 1)
                }
                return afterOthers(send)
              },
              { concurrency },
            )
            expect([...puts.values()].every((n) => n === 1)).toBe(true)
            expect(real.conflicts).toEqual([])
            expect(real.sentinelsMoved).toBe(2)
            expect(real.unchanged).toBe(0)
            expect(decided(dry)).toEqual(decided(real))
            expect(again).toMatchObject({ sentinelsMoved: 0, conflicts: [], unchanged: 2 })
          }),
      )
    }
  }

  for (const descending of [false, true]) {
    it.effect(
      `an item the scan and a move both reach (${descending ? "reverse" : "key"} order)`,
      () =>
        Effect.gen(function* () {
          // Off: `a%20b`'s row goes where `a b`'s is stored, so `a b`'s row is reached by the scan
          // and by `a%20b`'s move. Each write is held while the other visits run: one moves it, and
          // the other takes that verdict.
          const Model = Schema.Struct({ id: Schema.String, status: Schema.String })
          const make = (escapeKeys: boolean) => {
            const schema = DynamoSchema.make({ name: "items", version: 1, escapeKeys })
            const Rows = Entity.make({
              model: Model,
              entityType: "Row",
              primaryKey: {
                pk: { field: "pk", composite: [] },
                sk: { field: "sk", composite: ["id"] },
              },
            })
            const MainTable = Table.make({ schema, entities: { Rows } })
            return {
              schema,
              Rows,
              MainTable,
              client: DynamoClient.make({ entities: { Rows }, tables: { MainTable } }),
            }
          }
          const now = make(false)
          const was = make(true)
          const table = makeRecordingTable()
          yield* Effect.gen(function* () {
            const db = yield* was.client
            yield* db.entities.Rows.put({ id: "a%20b", status: "x" }).asEffect()
            yield* db.entities.Rows.put({ id: "a b", status: "x" }).asEffect()
          }).pipe(Effect.provide(Layer.merge(table.layer, was.MainTable.layer({ name: "t" }))))
          const puts = new Map<string, number>()
          const around: Parameters<typeof gatedLayer>[1] = (command, input, send) => {
            const sorted = scanSorted(descending)(command, send)
            if (sorted !== undefined) return sorted
            if (command !== "transactWriteItems") return send
            for (const op of input.TransactItems ?? []) {
              const at = op.Put?.Item
              if (at !== undefined)
                puts.set(`${at.pk?.S}|${at.sk?.S}`, (puts.get(`${at.pk?.S}|${at.sk?.S}`) ?? 0) + 1)
            }
            return afterOthers(send)
          }
          const layer = Layer.merge(
            gatedLayer(table.client, around),
            now.MainTable.layer({ name: "t" }),
          )
          const { dry, real, again } = yield* Effect.gen(function* () {
            const db = yield* now.client
            const dry: Table.RekeyReport = yield* db.tables.MainTable.rekey({ dryRun: true })
            const real: Table.RekeyReport = yield* db.tables.MainTable.rekey()
            const again: Table.RekeyReport = yield* db.tables.MainTable.rekey()
            return { dry, real, again }
          }).pipe(Effect.provide(layer))
          expect([...puts.values()].every((n) => n === 1)).toBe(true)
          expect(real.conflicts).toEqual([])
          expect(real.moved.item).toBe(2)
          expect(real.unchanged).toBe(0)
          expect(real.scanned).toBe(2)
          expect(decided(dry)).toEqual(decided(real))
          expect(again).toMatchObject({ conflicts: [], unchanged: 2, scanned: 2 })
        }),
    )
  }
})

describe("a real run doesn't meet its own writes", () => {
  it.effect("a segment scanned after the run took one of its rows still counts it", () =>
    Effect.gen(function* () {
      // Three segments. Held: the scan of a segment with no item in it, until the run has moved
      // the sentinel stored there.
      const was = accounts(true)
      const stem = ["foo", "alpha", "beta", "gamma", "delta", "kappa", "omega"].find((s) => {
        const keys = (email: string) =>
          `${sentinelPk(was, email)}|${DynamoSchema.composeUniqueKey(was.schema, "Account", "email", [KeyComposer.keyText(was.schema, email, "lowercase")]).sk}`
        const items = ["a", "b"].map((id) =>
          segmentOf(`$inter#v1#account#id_${id}|$inter#v1#account`, 3),
        )
        return !items.includes(segmentOf(keys(`${s}%20bar`), 3))
      })!
      expect(stem).toBeDefined()
      const old = sentinelPk(was, `${stem}%20bar`)
      const taken = yield* Deferred.make<void>()
      const { dry, real } = yield* sentinelRuns(
        false,
        { a: `${stem}%20bar`, b: `${stem} bar` },
        (_now, run) => (command, input, send) => {
          // The dry run sends no write to wait for: only the run is held.
          if (run === "dry") return send
          if (
            command === "scan" &&
            (input.Segment ?? 0) ===
              segmentOf(
                `${old}|${DynamoSchema.composeUniqueKey(was.schema, "Account", "email", [KeyComposer.keyText(was.schema, `${stem}%20bar`, "lowercase")]).sk}`,
                3,
              )
          ) {
            return Effect.andThen(Deferred.await(taken), send)
          }
          if (command === "transactWriteItems" && deletesAt(input, old)) {
            return Effect.tap(send, () => Deferred.succeed(taken, undefined))
          }
          return send
        },
        { segments: 3 },
      )
      expect(real.scanned).toBe(4)
      expect(dry.scanned).toBe(4)
      expect(decided(dry)).toEqual(decided(real))
    }),
  )
})

// ---------------------------------------------------------------------------
// Aggregates sharing a partition, their edges' sort keys chaining across owners
// ---------------------------------------------------------------------------

const Line = Schema.Struct({ lid: Schema.String, owner: Schema.String, note: Schema.String })
const OWNERS = ["a", "b", "c"] as const
const LIDS = { a: "x y", b: "x%20y", c: "x%2520y" } as const

const owners = (escapeKeys: boolean) => {
  const schema = DynamoSchema.make({ name: "shared", version: 1, escapeKeys })
  const MainTable = Table.make({ schema, entities: {} })
  const make = (owner: string) =>
    Aggregate.make(Schema.Struct({ id: Schema.String, lines: Schema.Array(Line) }), {
      schema,
      table: MainTable,
      pk: { field: "pk", composite: ["id"] },
      collection: { name: "shared" },
      root: { entityType: `Root${owner}` },
      edges: {
        lines: Aggregate.many({
          entityType: "Line",
          sk: { composite: ["lid"] },
          assemble: (lines) =>
            (lines as ReadonlyArray<typeof Line.Type>).filter((line) => line.owner === owner),
          decompose: (lines) => lines as ReadonlyArray<unknown>,
        }),
      },
    })
  const aggregates = { A: make("a"), B: make("b"), C: make("c") }
  return {
    MainTable,
    aggregates,
    client: DynamoClient.make({ entities: {}, aggregates, tables: { MainTable } }),
  }
}

/** Every order of `xs`. */
const permutations = <A>(xs: ReadonlyArray<A>): Array<Array<A>> =>
  xs.length <= 1
    ? [[...xs]]
    : xs.flatMap((x, i) =>
        permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [x, ...rest]),
      )

const ownerOf = (row: Row) => row.owner?.S ?? (row.__edd_e__?.S ?? "").slice(4)

/** A client whose scans return their rows in `order` of owner. */
const scanInOrder =
  (order: ReadonlyArray<string>): Parameters<typeof gatedLayer>[1] =>
  (command, _input, send) =>
    command !== "scan"
      ? send
      : Effect.map(send, (page: any) => ({
          ...page,
          Items: [...(page.Items ?? [])].sort(
            (p: Row, q: Row) => order.indexOf(ownerOf(p)) - order.indexOf(ownerOf(q)),
          ),
        }))

describe("aggregates sharing a partition, their rows chaining across owners", () => {
  const outcomes = new Map<string, unknown>()
  for (const concurrency of [1, 4]) {
    for (const order of permutations(OWNERS)) {
      it.effect(`met in the order ${order.join("")}, ${concurrency} at once`, () =>
        Effect.gen(function* () {
          const table = makeRecordingTable()
          const off = owners(false)
          yield* Effect.gen(function* () {
            const db = yield* off.client
            for (const owner of OWNERS) {
              yield* db.aggregates[owner.toUpperCase() as "A"].create({
                id: "p",
                lines: [{ lid: LIDS[owner], owner, note: owner }],
              })
            }
          }).pipe(Effect.provide(Layer.merge(table.layer, off.MainTable.layer({ name: "t" }))))
          const on = owners(true)
          const layer = Layer.merge(
            gatedLayer(table.client as DynamoClientService, scanInOrder(order)),
            on.MainTable.layer({ name: "t" }),
          )
          const runs = yield* Effect.gen(function* () {
            const db = yield* on.client
            const dry = yield* db.tables.MainTable.rekey({
              repairIndexKeys: true,
              dryRun: true,
              concurrency,
            })
            const real = yield* db.tables.MainTable.rekey({ repairIndexKeys: true, concurrency })
            const again = yield* db.tables.MainTable.rekey({ repairIndexKeys: true, concurrency })
            const lines = yield* Effect.forEach(OWNERS, (owner) =>
              db.aggregates[owner.toUpperCase() as "A"].get({ id: "p" }),
            )
            return { dry, real, again, lines }
          }).pipe(Effect.provide(layer))
          // One run moves every line, the dry run says so, and a run after it has nothing to do.
          expect(runs.real.conflicts).toEqual([])
          expect(runs.real.moved.aggregate).toBe(3)
          expect(decided(runs.dry)).toEqual(decided(runs.real))
          expect(runs.again).toMatchObject({ conflicts: [], moved: { aggregate: 0 } })
          expect(runs.lines.map((agg) => agg.lines.map((line) => line.lid))).toEqual([
            [LIDS.a],
            [LIDS.b],
            [LIDS.c],
          ])
          // The same rows whatever the order.
          const stored = storedOf(table)
          const first = outcomes.get("stored")
          if (first === undefined) outcomes.set("stored", stored)
          else expect(stored).toEqual(first)
        }),
      )
    }
  }
})

// ---------------------------------------------------------------------------
// Two items each holding the other's current sentinel key, under different constraints
// ---------------------------------------------------------------------------

class Member extends Schema.Class<Member>("Member")({
  id: Schema.String,
  email: Schema.String,
  nick: Schema.String,
}) {}

const members = (escapeKeys: boolean) => {
  const schema = DynamoSchema.make({ name: "cycle", version: 1, escapeKeys })
  const Members = Entity.make({
    model: Member,
    entityType: "Member",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
    unique: { email: ["email"], nick: ["nick"] },
  })
  const MainTable = Table.make({ schema, entities: { Members } })
  return { MainTable, client: DynamoClient.make({ entities: { Members }, tables: { MainTable } }) }
}

describe("two items holding each other's sentinel keys", () => {
  const outcomes = new Map<string, unknown>()
  for (const [first, second] of [
    ["a", "b"],
    ["b", "a"],
  ] as const) {
    it.effect(`${first}'s row met first: every sentinel moves, and the report says so`, () =>
      Effect.gen(function* () {
        // Off: `foo%20bar`'s email goes where `foo bar`'s is, and `x%20y`'s nick where `x y`'s is.
        // `first` holds the email that has to move first, `second` the nick.
        const table = makeRecordingTable()
        const was = members(true)
        yield* Effect.gen(function* () {
          const db = yield* was.client
          yield* db.entities.Members.put({ id: first, email: "foo%20bar", nick: "x y" }).asEffect()
          yield* db.entities.Members.put({ id: second, email: "foo bar", nick: "x%20y" }).asEffect()
        }).pipe(Effect.provide(Layer.merge(table.layer, was.MainTable.layer({ name: "t" }))))
        const now = members(false)
        const runs = yield* Effect.gen(function* () {
          const db = yield* now.client
          const dry = yield* db.tables.MainTable.rekey({ dryRun: true })
          const real = yield* db.tables.MainTable.rekey()
          const again = yield* db.tables.MainTable.rekey()
          return { dry, real, again }
        }).pipe(Effect.provide(Layer.merge(table.layer, now.MainTable.layer({ name: "t" }))))
        expect(runs.real.conflicts).toEqual([])
        expect(runs.real.sentinelsMoved).toBe(4)
        expect(decided(runs.dry)).toEqual(decided(runs.real))
        expect(runs.again).toMatchObject({ conflicts: [], sentinelsMoved: 0, unchanged: 2 })
        const report = decided(runs.real)
        const seen = outcomes.get("report")
        if (seen === undefined) outcomes.set("report", report)
        else expect(report).toEqual(seen)
      }),
    )
  }
})

// A gate with no hold changes nothing: the runs above differ from a plain run only by the order forced.
it.effect("an open gate is a plain client", () =>
  Effect.gen(function* () {
    const { dry, real } = yield* sentinelRuns(false, { a: "foo%20bar", b: "foo bar" }, open)
    expect(decided(dry)).toEqual(decided(real))
  }),
)
