/**
 * What `rekey` does for a projection's rows (#183). A read-model row holds its values, but a removed
 * row's tombstone and a row's outbox items hold only the key they were written for, so `rekey` reads
 * their values back from it, by the text their `__edd_kt__` mark says it is. It moves each to what
 * the setting composes, either way, and a dry run and a second run agree. An operation never looks
 * for them anywhere else, so until `rekey` has run they aren't delivered or recognised.
 */

import { describe, expect, it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import * as KeyComposer from "@effect-dynamodb/schema/KeyComposer.js"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
import { fromAttributeMap, toAttributeMap } from "../src/Marshaller.js"
import * as Table from "../src/Table.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

class Opened extends Schema.TaggedClass<Opened>()("Opened", {}) {}
class Added extends Schema.TaggedClass<Added>()("Added", { amount: Schema.Number }) {}
class Closed extends Schema.TaggedClass<Closed>()("Closed", {}) {}
type AccountEvent = Opened | Added | Closed

const Tally = Schema.Struct({
  shop: Schema.String,
  name: Schema.String,
  total: Schema.Number,
  version: Schema.Number,
  rev: Schema.Number,
})
type Tally = typeof Tally.Type

const Sum = Schema.Struct({
  shop: Schema.String,
  name: Schema.String,
  total: Schema.Number,
  checkpoints: Schema.Record(Schema.String, Schema.Number),
  rev: Schema.Number,
})
type Sum = typeof Sum.Type

const Notice = Schema.Struct({ account: Schema.String, total: Schema.Number })

/**
 * The read-model row each account feeds: text every setting composes the same, text that changes
 * in the sort key, text that is what `a b` escapes to, and text that changes in both key halves.
 */
const ROWS: Record<string, { readonly shop: string; readonly name: string }> = {
  same: { shop: "s1", name: "ab" },
  moved: { shop: "s1", name: "a b" },
  escaped: { shop: "s1", name: "a%20b" },
  both: { shop: "x y", name: "c d" },
}

const world = (schema: DynamoSchema.DynamoSchema) => {
  const EventsTable = Table.make({ schema, entities: {} })
  const Accounts = EventStore.makeStream({
    table: EventsTable,
    streamName: "Account",
    events: [Opened, Added, Closed],
    streamId: { composite: ["account"] },
  })
  const primaryKey = {
    pk: { field: "pk", composite: ["shop"] },
    sk: { field: "sk", composite: ["name"] },
  } as const
  // Removal and an outbox: the projection writes the row's item itself.
  const Tallies = Entity.make({
    model: Tally,
    entityType: "Tally",
    primaryKey,
    timestamps: true,
  })
  // Neither: the projection writes through the entity's `put` / `create`.
  const Totals = Entity.make({
    model: Tally,
    entityType: "Total",
    primaryKey,
    timestamps: true,
  })
  const Sums = Entity.make({ model: Sum, entityType: "Sum", primaryKey })
  // An outbox on another table.
  const Ledgers = Entity.make({ model: Tally, entityType: "Ledger", primaryKey })
  // Removal alone: a live row is written through the entity, a tombstone by the projection.
  const Rems = Entity.make({ model: Tally, entityType: "Rem", primaryKey, timestamps: true })
  const ReadTable = Table.make({ schema, entities: { Tallies, Totals, Sums, Ledgers, Rems } })
  const OutboxTable = Table.make({ schema, entities: {} })

  const key = (id: { readonly account: string }) => ROWS[id.account]!
  const initial = (id: { readonly account: string }): Tally => ({
    ...key(id),
    total: 0,
    version: 0,
    rev: 0,
  })
  const add = (state: Tally, event: EventStore.StreamEvent<AccountEvent>) =>
    event.data._tag === "Added" ? { ...state, total: state.total + event.data.amount } : state
  const Notifying = EventStore.projection({
    stream: Accounts,
    readModel: Tallies,
    key,
    initial,
    evolve: (state, event) =>
      Effect.succeed(event.data._tag === "Closed" ? EventStore.removeRow : add(state, event)),
    checkpoint: "version",
    revision: "rev",
    removal: {},
    outbox: {
      schema: Notice,
      effects: (event, next) =>
        event.data._tag === "Added" ? [{ account: event.streamId, total: next?.total ?? -1 }] : [],
      index: { name: "outbox", pk: "obpk", sk: "obsk" },
    },
  })
  const Remote = EventStore.projection({
    stream: Accounts,
    readModel: Ledgers,
    key,
    initial,
    evolve: (state, event) => Effect.succeed(add(state, event)),
    checkpoint: "version",
    revision: "rev",
    outbox: {
      schema: Notice,
      effects: (event, next) =>
        event.data._tag === "Added" ? [{ account: event.streamId, total: next?.total ?? -1 }] : [],
      table: OutboxTable,
    },
  })
  const Plain = EventStore.projection({
    stream: Accounts,
    readModel: Totals,
    key,
    initial,
    evolve: (state, event) => Effect.succeed(add(state, event)),
    checkpoint: "version",
    revision: "rev",
  })
  const Removing = EventStore.projection({
    stream: Accounts,
    readModel: Rems,
    key,
    initial,
    evolve: (state, event) =>
      Effect.succeed(event.data._tag === "Closed" ? EventStore.removeRow : add(state, event)),
    checkpoint: "version",
    revision: "rev",
    removal: {},
  })
  const Multi = EventStore.multiProjection({
    readModel: Sums,
    initial: (k: { readonly shop: string; readonly name: string }): Sum => ({
      ...k,
      total: 0,
      checkpoints: {},
      rev: 0,
    }),
    sources: (source: EventStore.SourceBuilder<{ shop: string; name: string }, Sum>) => ({
      account: source(Accounts, {
        key: (id) => ROWS[id.account]!,
        evolve: (state, event) =>
          Effect.succeed(
            event.data._tag === "Added"
              ? { ...state, total: state.total + event.data.amount }
              : state,
          ),
      }),
    }),
    checkpoints: { field: "checkpoints" },
    revision: "rev",
  })
  return {
    schema,
    EventsTable,
    ReadTable,
    OutboxTable,
    Accounts,
    Tallies,
    Totals,
    Sums,
    Ledgers,
    Rems,
    Notifying,
    Remote,
    Plain,
    Removing,
    Multi,
  }
}

const On = world(DynamoSchema.make({ name: "proj", version: 1, escapeKeys: true }))
const Off = world(DynamoSchema.make({ name: "proj", version: 1, escapeKeys: false }))
type World = typeof On

type RecordingTable = ReturnType<typeof makeRecordingTable>

const worldLayer = (w: World) =>
  Layer.mergeAll(
    w.EventsTable.layer({ name: "t" }),
    w.ReadTable.layer({ name: "t" }),
    w.OutboxTable.layer({ name: "o" }),
  )

/** Run `body` over a fresh recording table, with both worlds' members. */
const inTable = <A, E>(
  body: (table: RecordingTable) => Effect.Effect<A, E, any>,
  client?: (table: RecordingTable) => Layer.Layer<DynamoClient>,
) =>
  Effect.gen(function* () {
    const table = makeRecordingTable({ indexes: { outbox: { pk: "obpk", sk: "obsk" } } })
    return yield* body(table).pipe(
      Effect.provide(
        Layer.mergeAll(client?.(table) ?? table.layer, worldLayer(On), worldLayer(Off)),
      ),
    ) as Effect.Effect<A, E>
  })

type Keys = Record<string, string>
const at = (key: Keys) => `${key.pk}|${key.sk}`

/** A read-model row's key under `w`'s setting. */
const keyOf = (w: World, entityType: "Tally" | "Ledger", account: string) => {
  const entity = entityType === "Tally" ? w.Tallies : w.Ledgers
  return KeyComposer.composeIndexKeys(
    w.schema,
    entityType,
    1,
    entity.indexes.primary,
    ROWS[account]!,
  ) as Keys
}

const rowsOf = (table: RecordingTable, type: string) =>
  [...table.items.entries()]
    .filter(([, item]) => item.__edd_e__?.S === type)
    .map(([stored, item]) => [stored, fromAttributeMap(item)] as const)

const seed = (w: World, account: string, events: ReadonlyArray<AccountEvent>, expected: number) =>
  Effect.gen(function* () {
    yield* w.Accounts.append({ account }, events, expected)
    return yield* w.Accounts.read({ account })
  })

const ZERO = { item: 0, snapshot: 0, tombstone: 0, outbox: 0, event: 0, aggregate: 0, stream: 0 }

const rekey = (w: World, options?: Record<string, unknown> & { readonly outbox?: boolean }) =>
  Effect.gen(function* () {
    const db = (yield* DynamoClient.make({
      entities: {
        Tallies: w.Tallies,
        Totals: w.Totals,
        Sums: w.Sums,
        Ledgers: w.Ledgers,
        Rems: w.Rems,
      },
      tables: { ReadTable: w.ReadTable, OutboxTable: w.OutboxTable },
    })) as any
    const { outbox, ...rest } = options ?? {}
    return yield* (outbox ? db.tables.OutboxTable : db.tables.ReadTable).rekey({
      streams: [w.Accounts],
      ...rest,
    }) as Effect.Effect<Table.RekeyReport, unknown, any>
  })

/** `moved`'s row and two effects; `escaped`'s tombstone and effect, written under `w`. */
const layout = (w: World) =>
  Effect.gen(function* () {
    const moved = yield* seed(
      w,
      "moved",
      [new Opened(), new Added({ amount: 2 }), new Added({ amount: 3 })],
      0,
    )
    yield* w.Notifying.applyBatch(moved)
    const escaped = yield* seed(
      w,
      "escaped",
      [new Opened(), new Added({ amount: 4 }), new Closed()],
      0,
    )
    yield* w.Notifying.applyBatch(escaped)
    return { escaped }
  })

/** The `__edd_kt__` a row holding no values has under `w`, when its text differs from off's. */
const markUnder = (w: World) => (w === On ? 2 : undefined)

const DIRECTIONS: ReadonlyArray<readonly [string, World, World]> = [
  ["to on", Off, On],
  ["to off", On, Off],
]

/** 1.37.0's text and mark, on rows written under the flag: its partition keys aren't escaped. */
const as137 = (table: RecordingTable) => {
  const rows = [...table.items.entries()]
  for (const [stored, item] of rows) {
    if (item.pk?.S === undefined || !/#(tally|ledger)/.test(item.pk.S)) continue
    table.items.delete(stored)
    const pk = KeyComposer.unescapeKeyText(item.pk.S)
    const sk = item.sk!.S!
    const type = item.__edd_e__?.S ?? ""
    const valueless = type.endsWith("#tombstone") || type.endsWith("#outbox")
    table.items.set(`${pk}|${sk}`, {
      ...item,
      pk: { S: pk },
      ...(valueless ? { __edd_kt__: { N: "1" } } : {}),
      ...(item.__edd_row_pk__ === undefined ? {} : { __edd_row_pk__: { S: pk } }),
      ...(item.obsk === undefined ? {} : { obsk: { S: `${pk}#${sk}` } }),
    })
  }
}

describe.each(DIRECTIONS)("rekey, a projection's rows, %s", (_direction, from, to) => {
  it.effect("a dry run counts the tombstone and the outbox items, and writes nothing", () =>
    inTable((table) =>
      Effect.gen(function* () {
        yield* layout(from)
        const before = new Map(table.items)
        const report = yield* rekey(to, { dryRun: true })
        expect(report.moved).toEqual({ ...ZERO, item: 1, tombstone: 1, outbox: 3 })
        expect(report.byMember.Tally?.moved).toEqual({ ...ZERO, item: 1, tombstone: 1, outbox: 3 })
        expect(report.conflicts).toEqual([])
        expect(report.skipped.unregistered).toBe(0)
        expect(report.skipped.unrecognizedKey).toBe(0)
        expect(table.items).toEqual(before)
      }),
    ),
  )

  it.effect("moves each to its row's key, marked for the setting; a rerun moves nothing", () =>
    inTable((table) =>
      Effect.gen(function* () {
        const { escaped } = yield* layout(from)
        const report = yield* rekey(to)
        expect(report.moved).toEqual({ ...ZERO, item: 1, tombstone: 1, outbox: 3 })
        expect(report.conflicts).toEqual([])
        expect(report.skipped.unrecognizedKey).toBe(0)
        const moved = keyOf(to, "Tally", "moved")
        const gone = keyOf(to, "Tally", "escaped")
        expect(rowsOf(table, "Tally").map(([stored]) => stored)).toEqual([at(moved)])
        expect(
          rowsOf(table, "Tally#tombstone").map(([stored, row]) => [stored, row.__edd_kt__]),
        ).toEqual([[at(gone), markUnder(to)]])
        // Each outbox item names its row's key, and so does the sparse index.
        expect(
          rowsOf(table, "Tally#outbox")
            .map(([stored, row]) => [
              stored,
              row.__edd_row_pk__,
              row.__edd_row_sk__,
              row.obsk,
              row.__edd_kt__,
            ])
            .sort(),
        ).toEqual(
          [
            [moved, "000000000001#0000"],
            [moved, "000000000001#0001"],
            [gone, "000000000001#0000"],
          ]
            .map(([key, n]) => {
              const { pk, sk } = key as Keys
              return [`${pk}|${sk}#outbox#${n}`, pk, sk, `${pk}#${sk}#outbox#${n}`, markUnder(to)]
            })
            .sort(),
        )
        const after = new Map(table.items)
        const again = yield* rekey(to)
        expect(again.moved).toEqual(ZERO)
        expect(again.conflicts).toEqual([])
        expect(table.items).toEqual(after)
        // In one order per row; the tombstone still recognises a redelivery.
        const delivered: Array<number> = []
        const swept = yield* to.Notifying.drainPending((effect) =>
          Effect.sync(() => void delivered.push(effect.total)),
        )
        expect(swept.delivered).toBe(3)
        expect(delivered.sort()).toEqual([2, 4, 5])
        const late = yield* to.Notifying.apply(escaped[1]!)
        expect(late.alreadyApplied.map((e) => e.version)).toEqual([2])
      }),
    ),
  )

  it.effect("an outbox item a drainer holds is left, a conflict until it is delivered", () =>
    inTable((table) =>
      Effect.gen(function* () {
        yield* layout(from)
        const old = keyOf(from, "Tally", "moved")
        // Its second: nothing moves to where it is.
        const claimed = `${old.pk}|${old.sk}#outbox#000000000001#0001`
        table.items.set(claimed, {
          ...table.items.get(claimed)!,
          ...toAttributeMap({
            __edd_claim__: "drainer-1",
            __edd_claimed_until__: Date.now() + 60_000,
          }),
        })
        const report = yield* rekey(to)
        expect(report.moved).toEqual({ ...ZERO, item: 1, tombstone: 1, outbox: 2 })
        expect(report.conflicts.map((c) => [c.kind, c.reason, c.message])).toEqual([
          ["outbox", "contended", "A drainer holds it."],
        ])
        expect(rowsOf(table, "Tally#outbox").map(([stored]) => stored)).toContain(claimed)
      }),
    ),
  )

  it.effect("a claim taken between rekey's read and its move cancels the move", () => {
    let injected: string | undefined
    // A drainer claims the item as the move is sent: after rekey read it unclaimed.
    const racing = (table: RecordingTable) =>
      Layer.effect(
        DynamoClient,
        Effect.gen(function* () {
          const base = yield* DynamoClient
          return {
            ...base,
            transactWriteItems: (input: any) =>
              Effect.gen(function* () {
                const del = (input.TransactItems as Array<any>).find((i) => i.Delete)?.Delete
                if (injected === undefined && del?.Key?.sk?.S?.includes("#outbox#")) {
                  injected = `${del.Key.pk.S}|${del.Key.sk.S}`
                  table.items.set(injected, {
                    ...table.items.get(injected)!,
                    ...toAttributeMap({
                      __edd_claim__: "drainer-1",
                      __edd_claimed_until__: Date.now() + 60_000,
                    }),
                  })
                }
                return yield* base.transactWriteItems(input)
              }),
          }
        }),
      ).pipe(Layer.provide(table.layer))
    return inTable(
      (table) =>
        Effect.gen(function* () {
          yield* layout(from)
          const report = yield* rekey(to)
          expect(injected).toBeDefined()
          expect(table.items.get(injected!)?.__edd_claim__).toEqual({ S: "drainer-1" })
          // Off, `a%20b`'s item is bound for where the held one is, so it stays too. Each once.
          expect(report.conflicts.map((c) => [c.kind, c.reason])).toEqual(
            to === Off
              ? [
                  ["outbox", "contended"],
                  ["outbox", "taken"],
                ]
              : [["outbox", "contended"]],
          )
          expect(
            rowsOf(table, "Tally#outbox").filter(([, row]) => row.__edd_claim__ !== undefined),
          ).toHaveLength(1)
        }),
      racing,
    )
  })

  it.effect("a tombstone at the key another value's row is at moves that row first", () =>
    inTable((table) =>
      Effect.gen(function* () {
        // `a b` removed and `a%20b` live: under one setting's text, each at the other's next key.
        yield* from.Notifying.applyBatch(
          yield* seed(from, "moved", [new Opened(), new Added({ amount: 2 }), new Closed()], 0),
        )
        yield* from.Notifying.applyBatch(
          yield* seed(from, "escaped", [new Opened(), new Added({ amount: 4 })], 0),
        )
        const report = yield* rekey(to, { concurrency: 1 })
        expect(report.moved).toEqual({ ...ZERO, item: 1, tombstone: 1, outbox: 2 })
        expect(report.skipped.unrecognizedKey).toBe(0)
        expect(report.conflicts).toEqual([])
        expect(rowsOf(table, "Tally").map(([stored]) => stored)).toEqual([
          at(keyOf(to, "Tally", "escaped")),
        ])
        expect(rowsOf(table, "Tally#tombstone").map(([stored]) => stored)).toEqual([
          at(keyOf(to, "Tally", "moved")),
        ])
      }),
    ),
  )

  it.effect("a row whose key holds no values of the read model is counted, on every run", () =>
    inTable((table) =>
      Effect.gen(function* () {
        const key = { pk: { S: "somewhere" }, sk: { S: "else" } }
        table.items.set("somewhere|else", { ...key, __edd_e__: { S: "Tally#tombstone" } })
        table.items.set("somewhere|else#o", {
          pk: key.pk,
          sk: { S: "else#o" },
          __edd_row_pk__: key.pk,
          __edd_row_sk__: { S: "other" },
          __edd_e__: { S: "Tally#outbox" },
        })
        const before = new Map(table.items)
        const dry = yield* rekey(to, { dryRun: true })
        const real = yield* rekey(to)
        expect(real.skipped.unrecognizedKey).toBe(2)
        expect(dry.skipped.unrecognizedKey).toBe(2)
        expect(real.moved).toEqual(ZERO)
        expect(table.items).toEqual(before)
        expect((yield* rekey(to)).skipped.unrecognizedKey).toBe(2)
      }),
    ),
  )

  it.effect("a tombstone whose key a live row holds is taken, in the dry run too", () =>
    inTable((table) =>
      Effect.gen(function* () {
        const events = yield* seed(from, "both", [new Opened(), new Closed()], 0)
        yield* from.Notifying.applyBatch(events)
        expect(rowsOf(table, "Tally#tombstone")).toHaveLength(1)
        const key = keyOf(to, "Tally", "both")
        table.items.set(
          at(key),
          toAttributeMap({
            ...key,
            ...ROWS.both,
            total: 0,
            version: 0,
            rev: 0,
            __edd_e__: "Tally",
          }),
        )
        const dry = yield* rekey(to, { dryRun: true })
        const real = yield* rekey(to)
        expect(real.moved.tombstone).toBe(0)
        expect(dry.moved).toEqual(real.moved)
        expect(real.conflicts.map((conflict) => conflict.reason)).toEqual(["taken"])
        expect(dry.conflicts).toEqual(real.conflicts)
      }),
    ),
  )

  it.effect("rows already at what the setting composes are left alone", () =>
    inTable((table) =>
      Effect.gen(function* () {
        const events = yield* seed(
          to,
          "moved",
          [new Opened(), new Added({ amount: 2 }), new Closed()],
          0,
        )
        yield* to.Notifying.applyBatch(events)
        const before = new Map(table.items)
        const report = yield* rekey(to)
        expect(report.moved).toEqual(ZERO)
        expect(report.byMember.Tally?.unchanged).toBe(2)
        expect(table.items).toEqual(before)
      }),
    ),
  )

  it.effect("an outbox on another table moves with that table's rekey", () =>
    inTable((table) =>
      Effect.gen(function* () {
        const events = yield* seed(from, "moved", [new Opened(), new Added({ amount: 2 })], 0)
        yield* from.Remote.applyBatch(events)
        const old = keyOf(from, "Ledger", "moved")
        const now = keyOf(to, "Ledger", "moved")
        expect(rowsOf(table, "Ledger#outbox").map(([stored]) => stored)).toEqual([
          `${old.pk}|${old.sk}#outbox#000000000001#0000`,
        ])
        table.take()
        const report = yield* rekey(to, { outbox: true })
        expect(report.byMember.Ledger?.moved).toEqual({ ...ZERO, outbox: 1 })
        const sent = table.take().filter((r) => r.command === "TransactWriteItems")
        expect(sent.map((r) => (r.input.TransactItems as Array<any>)[0].Put.TableName)).toEqual([
          "o",
        ])
        expect(rowsOf(table, "Ledger#outbox").map(([stored]) => stored)).toEqual([
          `${now.pk}|${now.sk}#outbox#000000000001#0000`,
        ])
        // The read model's own table: its row moves; the outbox item isn't its to move.
        const own = yield* rekey(to)
        expect(own.byMember.Ledger?.moved).toEqual({ ...ZERO, item: 1 })
        const delivered: Array<number> = []
        yield* to.Remote.drain(ROWS.moved!, (effect) =>
          Effect.sync(() => void delivered.push(effect.total)),
        )
        expect(delivered).toEqual([2])
      }),
    ),
  )

  it.effect("an outbox on another table moves with the rekey of another handle on it", () =>
    inTable((table) =>
      Effect.gen(function* () {
        const events = yield* seed(from, "moved", [new Opened(), new Added({ amount: 2 })], 0)
        yield* from.Remote.applyBatch(events)
        // A handle no projection names, on the outbox's table.
        const Alias = Table.make({ schema: to.schema, entities: {} })
        const report = yield* Effect.gen(function* () {
          const db = (yield* DynamoClient.make({
            entities: { Ledgers: to.Ledgers },
            tables: { ReadTable: to.ReadTable, Alias },
          })) as any
          return yield* db.tables.Alias.rekey({ streams: [to.Accounts] }) as Effect.Effect<
            Table.RekeyReport,
            unknown
          >
        }).pipe(Effect.provide(Alias.layer({ name: "o" })))
        expect(report.byMember.Ledger?.moved).toEqual({ ...ZERO, outbox: 1 })
        const now = keyOf(to, "Ledger", "moved")
        expect(rowsOf(table, "Ledger#outbox").map(([stored]) => stored)).toEqual([
          `${now.pk}|${now.sk}#outbox#000000000001#0000`,
        ])
      }),
    ),
  )

  it.effect("an outbox on another table moves when only the read model's table is bound", () => {
    // The read model reaches the client only as a member of a table the client binds.
    const viaTable = (w: World) =>
      Effect.gen(function* () {
        const db = (yield* DynamoClient.make({
          entities: {},
          tables: { ReadTable: w.ReadTable, OutboxTable: w.OutboxTable },
        })) as any
        return yield* db.tables.OutboxTable.rekey({ streams: [w.Accounts] }) as Effect.Effect<
          Table.RekeyReport,
          unknown
        >
      })
    const run = (bind: (w: World) => Effect.Effect<Table.RekeyReport, unknown, any>) =>
      inTable((table) =>
        Effect.gen(function* () {
          const events = yield* seed(from, "moved", [new Opened(), new Added({ amount: 2 })], 0)
          yield* from.Remote.applyBatch(events)
          table.take()
          const report = yield* bind(to)
          return { report, sent: table.take(), rows: rowsOf(table, "Ledger#outbox") }
        }),
      )
    return Effect.gen(function* () {
      const tableOnly = yield* run(viaTable)
      expect(tableOnly.report.byMember.Ledger?.moved).toEqual({ ...ZERO, outbox: 1 })
      const now = keyOf(to, "Ledger", "moved")
      expect(tableOnly.rows.map(([stored]) => stored)).toEqual([
        `${now.pk}|${now.sk}#outbox#000000000001#0000`,
      ])
      // Exactly what a client binding the read model itself reports and sends.
      const bound = yield* run((w) => rekey(w, { outbox: true }))
      expect(tableOnly.report).toEqual(bound.report)
      expect(tableOnly.sent).toEqual(bound.sent)
      expect(tableOnly.rows).toEqual(bound.rows)
    })
  })
})

/**
 * Read models only one bound table names, whose projections' outboxes are on two other tables and
 * on their own, all four tables bound and each rekeyed. Each table is its own store here, so a table's
 * scan finds only its own rows. Three read models, one projection each; or one read model with the
 * three projections (`one`), each writing rows of its own.
 */
const spread = (schema: DynamoSchema.DynamoSchema, one = false) => {
  const EventsTable = Table.make({ schema, entities: {} })
  const Accounts = EventStore.makeStream({
    table: EventsTable,
    streamName: "Account",
    events: [Opened, Added, Closed],
    streamId: { composite: ["account"] },
  })
  const primaryKey = {
    pk: { field: "pk", composite: ["shop"] },
    sk: { field: "sk", composite: ["name"] },
  } as const
  const Shared = Entity.make({ model: Tally, entityType: "Shared", primaryKey })
  const First = one ? Shared : Entity.make({ model: Tally, entityType: "First", primaryKey })
  const Second = one ? Shared : Entity.make({ model: Tally, entityType: "Second", primaryKey })
  const Own = one ? Shared : Entity.make({ model: Tally, entityType: "Own", primaryKey })
  const Source = Table.make({ schema, entities: one ? { Shared } : { First, Second, Own } })
  const O1 = Table.make({ schema, entities: {} })
  const O2 = Table.make({ schema, entities: {} })
  /** The row a projection writes for an account: one of its own when they share a read model. */
  const rowOf = (account: string, tag: string) =>
    one ? { ...ROWS[account]!, name: `${ROWS[account]!.name} ${tag}` } : ROWS[account]!
  const project = (readModel: unknown, tag: string, table?: typeof O1) =>
    EventStore.projection({
      stream: Accounts,
      readModel,
      key: (id: { readonly account: string }) => rowOf(id.account, tag),
      initial: (id: { readonly account: string }): Tally => ({
        ...rowOf(id.account, tag),
        total: 0,
        version: 0,
        rev: 0,
      }),
      evolve: (state: Tally, event: EventStore.StreamEvent<AccountEvent>) =>
        Effect.succeed(
          event.data._tag === "Added"
            ? { ...state, total: state.total + event.data.amount }
            : state,
        ),
      checkpoint: "version",
      revision: "rev",
      outbox: {
        schema: Notice,
        effects: (event: EventStore.StreamEvent<AccountEvent>, next: Tally | undefined) =>
          event.data._tag === "Added"
            ? [{ account: event.streamId, total: next?.total ?? -1 }]
            : [],
        ...(table === undefined
          ? { index: { name: "outbox", pk: "obpk", sk: "obsk" } }
          : { table }),
      },
    } as never) as EventStore.EventProjection<any, any, any, any, any, any, any, any, any, any>
  const projections = {
    First: project(First, "first", O1),
    Second: project(Second, "second", O2),
    Own: project(Own, "own"),
  }
  const layer = Layer.mergeAll(
    EventsTable.layer({ name: "events" }),
    Source.layer({ name: "source" }),
    O1.layer({ name: "o1" }),
    O2.layer({ name: "o2" }),
  )
  return { Accounts, Source, O1, O2, projections, layer, rowOf }
}

/** One `DynamoClient` over a store per table name; a transaction's writes go to their own tables. */
const routed = (tables: Readonly<Record<string, RecordingTable>>): Layer.Layer<DynamoClient> => {
  const of = (name: string): any => {
    const table = tables[name]
    if (table === undefined) throw new Error(`no table "${name}"`)
    return table.client
  }
  const byTable = <A>(entries: Iterable<readonly [string, A]>) => {
    const groups = new Map<string, Array<A>>()
    for (const [name, entry] of entries) groups.set(name, [...(groups.get(name) ?? []), entry])
    return groups
  }
  const service = new Proxy(of(Object.keys(tables)[0]!), {
    get: (target, command) => {
      const own = target[command]
      if (typeof own !== "function") return own
      return (input: any) => {
        if (command === "transactWriteItems") {
          const groups = byTable(
            (input.TransactItems as Array<any>).map((op) => {
              const write = op.Put ?? op.Update ?? op.Delete ?? op.ConditionCheck
              return [write.TableName as string, op] as const
            }),
          )
          return Effect.forEach(
            groups,
            ([name, ops]) => of(name).transactWriteItems({ ...input, TransactItems: ops }),
            { discard: true },
          ).pipe(Effect.as({}))
        }
        if (command === "batchWriteItem") {
          return Effect.forEach(
            Object.entries(input.RequestItems ?? {}),
            ([name, requests]) => of(name).batchWriteItem({ RequestItems: { [name]: requests } }),
            { discard: true },
          ).pipe(Effect.as({ UnprocessedItems: {} }))
        }
        return of(input.TableName)[command](input)
      }
    },
  })
  return Layer.succeed(DynamoClient, service)
}

describe.each(DIRECTIONS)("rekey, outboxes on several tables, %s", (direction) => {
  const [from, to] = direction === "to on" ? [false, true] : [true, false]
  const cases = [
    ["of read models only one bound table names", false],
    ["of one read model only one bound table names, a projection's outbox on each", true],
  ] as const
  it.effect.each(cases)(
    "%s, every table's rekey moves its own outbox items; a rerun moves none",
    ([, one]) => {
      const tables = {
        events: makeRecordingTable(),
        source: makeRecordingTable({ indexes: { outbox: { pk: "obpk", sk: "obsk" } } }),
        o1: makeRecordingTable(),
        o2: makeRecordingTable(),
      }
      const written = spread(
        DynamoSchema.make({ name: "spread", version: 1, escapeKeys: from }),
        one,
      )
      const now = spread(DynamoSchema.make({ name: "spread", version: 1, escapeKeys: to }), one)
      const outboxes = (name: keyof typeof tables) =>
        [...tables[name].items.entries()]
          .filter(([, item]) => item.__edd_e__?.S?.endsWith("#outbox") === true)
          .map(([stored, item]) => `${item.__edd_e__!.S} ${stored}`)
      return Effect.gen(function* () {
        yield* written.Accounts.append(
          { account: "moved" },
          [new Opened(), new Added({ amount: 2 })],
          0,
        )
        const events = yield* written.Accounts.read({ account: "moved" })
        for (const projection of Object.values(written.projections)) {
          yield* projection.applyBatch(events)
        }
        const before = { source: outboxes("source"), o1: outboxes("o1"), o2: outboxes("o2") }
        expect(before.source).toHaveLength(1)
        expect(before.o1).toHaveLength(1)
        expect(before.o2).toHaveLength(1)
        // The read models reach the client only as members of `Source`.
        const db = (yield* DynamoClient.make({
          entities: {},
          tables: { Source: now.Source, O1: now.O1, O2: now.O2 },
        })) as any
        const rekeyAll = Effect.gen(function* () {
          const reports: Record<string, Table.RekeyReport> = {}
          for (const name of ["Source", "O1", "O2"]) {
            reports[name] = yield* db.tables[name].rekey({
              streams: [now.Accounts],
            }) as Effect.Effect<Table.RekeyReport, unknown>
          }
          return reports
        })
        const reports = yield* rekeyAll
        expect(Object.values(reports).reduce((n, report) => n + report.moved.outbox, 0)).toBe(3)
        const [own, first, second] = one
          ? ["Shared", "Shared", "Shared"]
          : ["Own", "First", "Second"]
        expect(reports.Source!.byMember[own]?.moved.outbox).toBe(1)
        expect(reports.O1!.byMember[first]?.moved).toEqual({ ...ZERO, outbox: 1 })
        expect(reports.O2!.byMember[second]?.moved).toEqual({ ...ZERO, outbox: 1 })
        for (const report of Object.values(reports)) {
          expect(report.skipped.unregistered).toBe(0)
          expect(report.skipped.unrecognizedKey).toBe(0)
          expect(report.conflicts).toEqual([])
        }
        // Each item left its old key.
        const after = { source: outboxes("source"), o1: outboxes("o1"), o2: outboxes("o2") }
        expect(after.source).not.toEqual(before.source)
        expect(after.o1).not.toEqual(before.o1)
        expect(after.o2).not.toEqual(before.o2)
        // A rerun moves nothing.
        const again = yield* rekeyAll
        expect(Object.values(again).reduce((n, report) => n + report.moved.outbox, 0)).toBe(0)
        expect({ source: outboxes("source"), o1: outboxes("o1"), o2: outboxes("o2") }).toEqual(
          after,
        )
        // Its own drainer delivers each from its new key.
        for (const [tag, projection] of Object.entries(now.projections)) {
          const delivered: Array<number> = []
          yield* projection.drain(
            now.rowOf("moved", tag.toLowerCase()),
            (effect: { readonly total: number }) =>
              Effect.sync(() => void delivered.push(effect.total)),
          )
          expect(delivered).toEqual([2])
        }
      }).pipe(Effect.provide(Layer.mergeAll(routed(tables), written.layer, now.layer)))
    },
  )
})

describe.each([
  ["to on", On],
  ["to off", Off],
] as const)("rekey, a projection's rows 1.37.0 wrote, %s", (_direction, to) => {
  it.effect("each moves from 1.37.0's text, with its mark changed", () =>
    inTable((table) =>
      Effect.gen(function* () {
        // `both` removed, its text differing in each half; `moved` live, in the half 1.37.0 escaped.
        yield* On.Notifying.applyBatch(
          yield* seed(On, "both", [new Opened(), new Added({ amount: 2 }), new Closed()], 0),
        )
        yield* On.Notifying.applyBatch(
          yield* seed(On, "moved", [new Opened(), new Added({ amount: 3 })], 0),
        )
        as137(table)
        const dry = yield* rekey(to, { dryRun: true })
        const report = yield* rekey(to)
        expect(report.moved).toEqual(dry.moved)
        // With the flag on, `moved`'s sort key is where 1.37.0 put it.
        expect(report.moved).toEqual({
          ...ZERO,
          item: to === On ? 0 : 1,
          tombstone: 1,
          outbox: to === On ? 1 : 2,
        })
        expect(report.conflicts).toEqual([])
        expect(report.skipped.unrecognizedKey).toBe(0)
        const removed = keyOf(to, "Tally", "both")
        const live = keyOf(to, "Tally", "moved")
        expect(rowsOf(table, "Tally").map(([stored]) => stored)).toEqual([at(live)])
        expect(
          rowsOf(table, "Tally#tombstone").map(([stored, row]) => [stored, row.__edd_kt__]),
        ).toEqual([[at(removed), markUnder(to)]])
        expect(
          rowsOf(table, "Tally#outbox")
            .map(([stored]) => stored)
            .sort(),
        ).toEqual(
          [
            `${live.pk}|${live.sk}#outbox#000000000001#0000`,
            `${removed.pk}|${removed.sk}#outbox#000000000001#0000`,
          ].sort(),
        )
        expect((yield* rekey(to)).moved).toEqual(ZERO)
      }),
    ),
  )
})

/**
 * A `Ledger` read model in schema `name`, a member of its own table. In primary collection
 * `collection` when given.
 */
const ledgerTable = (name: string, escapeKeys: boolean, collection?: string) => {
  const Ledgers = Entity.make({
    model: Tally,
    entityType: "Ledger",
    primaryKey: {
      ...(collection === undefined ? {} : { collection, type: "clustered" as const }),
      pk: { field: "pk", composite: ["shop"] },
      sk: { field: "sk", composite: ["name"] },
    },
  })
  const ReadTable = Table.make({
    schema: DynamoSchema.make({ name, version: 1, escapeKeys }),
    entities: { Ledgers },
  })
  return { Ledgers, ReadTable }
}

/** A projection of `accounts` into `readModel`, whose outbox is on `outboxTable` when given. */
const ledgerProjection = (
  accounts: World["Accounts"],
  readModel: unknown,
  outboxTable?: Table.Table<any, any>,
) =>
  EventStore.projection({
    stream: accounts,
    readModel: readModel as ReturnType<typeof ledgerTable>["Ledgers"],
    key: (id) => ROWS[id.account]!,
    initial: (id): Tally => ({ ...ROWS[id.account]!, total: 0, version: 0, rev: 0 }),
    evolve: (state, event) =>
      Effect.succeed(
        event.data._tag === "Added" ? { ...state, total: state.total + event.data.amount } : state,
      ),
    checkpoint: "version",
    revision: "rev",
    ...(outboxTable === undefined
      ? {}
      : {
          outbox: {
            schema: Notice,
            effects: (event: EventStore.StreamEvent<AccountEvent>, next: Tally | undefined) =>
              event.data._tag === "Added"
                ? [{ account: event.streamId, total: next?.total ?? -1 }]
                : [],
            table: outboxTable,
          },
        }),
  })

/**
 * A `Ledger` read model in schema `name`, a member of its own table, and its projection of
 * `accounts`, whose outbox is on `outboxTable` when given. In primary collection `collection` when
 * given.
 */
const ledger = (
  accounts: World["Accounts"],
  name: string,
  escapeKeys: boolean,
  outboxTable?: Table.Table<any, any>,
  collection?: string,
) => {
  const { Ledgers, ReadTable } = ledgerTable(name, escapeKeys, collection)
  return { Ledgers, ReadTable, Remote: ledgerProjection(accounts, Ledgers, outboxTable) }
}

/**
 * Two `Ledger` read models whose projections' outboxes are on one table: their outbox items have
 * one entity type, and differ in the key space their keys name. In schemas `a` and `b`, or in one
 * schema and primary collections `ca` and `cb`.
 */
const spaces = (w: World, escapeKeys: boolean, by: "schema" | "collection") => {
  const OutboxTable = Table.make({
    schema: DynamoSchema.make({ name: "proj", version: 1, escapeKeys }),
    entities: {},
  })
  return {
    w,
    OutboxTable,
    A: ledger(w.Accounts, "a", escapeKeys, OutboxTable, by === "schema" ? undefined : "ca"),
    B: ledger(
      w.Accounts,
      by === "schema" ? "b" : "a",
      escapeKeys,
      OutboxTable,
      by === "schema" ? undefined : "cb",
    ),
  }
}
const SpacesOn = spaces(On, true, "schema")
const SpacesOff = spaces(Off, false, "schema")
const CollectionsOn = spaces(On, true, "collection")
const CollectionsOff = spaces(Off, false, "collection")
type Spaces = typeof SpacesOn

const inSpaces = <A, E>(body: (table: RecordingTable) => Effect.Effect<A, E, any>) =>
  Effect.gen(function* () {
    const table = makeRecordingTable()
    const layers = (s: Spaces) =>
      Layer.mergeAll(
        s.w.EventsTable.layer({ name: "t" }),
        s.A.ReadTable.layer({ name: "t" }),
        s.B.ReadTable.layer({ name: "t" }),
        s.OutboxTable.layer({ name: "o" }),
      )
    return yield* body(table).pipe(
      Effect.provide(
        Layer.mergeAll(
          table.layer,
          layers(SpacesOn),
          layers(SpacesOff),
          layers(CollectionsOn),
          layers(CollectionsOff),
        ),
      ),
    ) as Effect.Effect<A, E>
  })

/** The outbox table's `rekey`, from a client binding the read models in `order`. */
const rekeyOutboxes = (s: Spaces, order: "ab" | "ba", options?: Record<string, unknown>) =>
  Effect.gen(function* () {
    const db = (yield* DynamoClient.make({
      entities:
        order === "ab" ? { A: s.A.Ledgers, B: s.B.Ledgers } : { B: s.B.Ledgers, A: s.A.Ledgers },
      tables: { ReadA: s.A.ReadTable, ReadB: s.B.ReadTable, OutboxTable: s.OutboxTable },
    })) as any
    return yield* db.tables.OutboxTable.rekey({
      streams: [s.w.Accounts],
      ...options,
    }) as Effect.Effect<Table.RekeyReport, unknown, any>
  })

const SPACES: ReadonlyArray<readonly [string, Spaces, Spaces]> = [
  ["schemas, to on", SpacesOff, SpacesOn],
  ["schemas, to off", SpacesOn, SpacesOff],
  ["primary collections, to on", CollectionsOff, CollectionsOn],
  ["primary collections, to off", CollectionsOn, CollectionsOff],
]

describe.each(SPACES)("rekey, outboxes of two key spaces on one table, %s", (_d, from, to) => {
  const outboxKey = (s: Spaces, side: "A" | "B") => {
    const { pk, sk } = KeyComposer.composeIndexKeys(
      s[side].Ledgers._schema,
      "Ledger",
      1,
      s[side].Ledgers.indexes.primary,
      ROWS.moved!,
    ) as Keys
    return `${pk}|${sk}#outbox#000000000001#0000`
  }

  it.effect.each(["ab", "ba"] as const)(
    "each item moves by the read model its key names, whichever is listed first (%s)",
    (order) =>
      inSpaces((table) =>
        Effect.gen(function* () {
          const events = yield* seed(from.w, "moved", [new Opened(), new Added({ amount: 2 })], 0)
          yield* from.A.Remote.applyBatch(events)
          yield* from.B.Remote.applyBatch(events)
          expect(rowsOf(table, "Ledger#outbox").map(([stored]) => stored)).toEqual(
            [outboxKey(from, "A"), outboxKey(from, "B")].sort(),
          )
          const dry = yield* rekeyOutboxes(to, order, { dryRun: true })
          const report = yield* rekeyOutboxes(to, order)
          expect(dry.moved).toEqual(report.moved)
          expect(report.moved).toEqual({ ...ZERO, outbox: 2 })
          expect(report.skipped.unrecognizedKey).toBe(0)
          expect(report.conflicts).toEqual([])
          expect(rowsOf(table, "Ledger#outbox").map(([stored]) => stored)).toEqual(
            [outboxKey(to, "A"), outboxKey(to, "B")].sort(),
          )
          const again = yield* rekeyOutboxes(to, order)
          expect(again.moved).toEqual(ZERO)
          expect(again.byMember.Ledger?.unchanged).toBe(2)
          expect(again.skipped.unrecognizedKey).toBe(0)
          // Each reaches its own read model's drainer.
          for (const side of ["A", "B"] as const) {
            const delivered: Array<number> = []
            yield* to[side].Remote.drain(ROWS.moved!, (effect) =>
              Effect.sync(() => void delivered.push(effect.total)),
            )
            expect(delivered).toEqual([2])
          }
        }),
      ),
  )

  it.effect("an outbox item in neither key space is counted unrecognized, once", () =>
    inSpaces((table) =>
      Effect.gen(function* () {
        table.items.set("$c#v1#ledger#s1|$c#v1#ledger#ab#outbox#1", {
          pk: { S: "$c#v1#ledger#s1" },
          sk: { S: "$c#v1#ledger#ab#outbox#1" },
          __edd_row_pk__: { S: "$c#v1#ledger#s1" },
          __edd_row_sk__: { S: "$c#v1#ledger#ab" },
          __edd_e__: { S: "Ledger#outbox" },
        })
        const before = new Map(table.items)
        for (const order of ["ab", "ba"] as const) {
          const report = yield* rekeyOutboxes(to, order)
          expect(report.skipped.unrecognizedKey).toBe(1)
          expect(report.moved).toEqual(ZERO)
        }
        expect(table.items).toEqual(before)
      }),
    ),
  )
})

describe("[EDD-9134] a read model whose outbox is on another table, sharing its key space", () => {
  /** `DynamoClient.make`'s defect, if any; each table named by its key, or as `names` says. */
  const make = (
    entities: Record<string, unknown>,
    tables: Record<string, Table.Table<any, any>>,
    names: Record<string, string> = {},
  ): Effect.Effect<string> =>
    Effect.gen(function* () {
      yield* DynamoClient.make({ entities, tables } as any)
      return "no failure"
    }).pipe(
      Effect.catchDefect((defect) => Effect.succeed(String(defect))),
      Effect.provide(
        Layer.mergeAll(
          makeRecordingTable().layer,
          ...Object.entries(tables).map(([key, t]) => t.layer({ name: names[key] ?? key })),
        ),
      ),
    ) as Effect.Effect<string>

  it.effect("two read models whose outboxes are on one table", () =>
    Effect.gen(function* () {
      const OutboxTable = Table.make({ schema: On.schema, entities: {} })
      const A = ledger(On.Accounts, "a", true, OutboxTable)
      const B = ledger(On.Accounts, "a", true, OutboxTable)
      const message = yield* make(
        { A: A.Ledgers, B: B.Ledgers },
        { ReadA: A.ReadTable, ReadB: B.ReadTable, OutboxTable },
      )
      expect(message).toContain("[EDD-9134]")
      expect(message).toContain(
        `"A" writes its projection's outbox items into another table ("OutboxTable")`,
      )
      expect(message).toContain(
        `"B" writes its own under the same key space (partition keys starting ` +
          `"$a#v1#ledger#shop_", sort keys starting "$a#v1#ledger#name_"`,
      )
      // Reaching the client only through their tables.
      const viaTables = yield* make({}, { ReadA: A.ReadTable, ReadB: B.ReadTable, OutboxTable })
      expect(viaTables).toContain(`"ReadA.Ledgers" writes its projection's outbox items`)
    }),
  )

  it.effect("a read model whose outbox table has a member in its key space binds", () =>
    Effect.gen(function* () {
      const Others = Entity.make({
        model: Tally,
        entityType: "Ledger",
        primaryKey: {
          pk: { field: "pk", composite: ["shop"] },
          sk: { field: "sk", composite: ["name"] },
        },
      })
      const OutboxTable = Table.make({
        schema: DynamoSchema.make({ name: "a", version: 1, escapeKeys: true }),
        entities: { Others },
      })
      const A = ledger(On.Accounts, "a", true, OutboxTable)
      // An outbox item's sort key is a whole row sort key followed by `#outbox#`: a member's
      // row is at an item's key only through a value holding that text. As on 1.39.0.
      expect(yield* make({ A: A.Ledgers }, { ReadA: A.ReadTable, OutboxTable })).toBe("no failure")
    }),
  )

  it.effect("two handles on one physical table are one table", () =>
    Effect.gen(function* () {
      // Each read model's outbox on its own handle; one key space, whatever the escaping.
      const Outbox1 = Table.make({ schema: On.schema, entities: {} })
      const Outbox2 = Table.make({ schema: On.schema, entities: {} })
      const A = ledger(On.Accounts, "a", false, Outbox1)
      const B = ledger(On.Accounts, "a", true, Outbox2)
      const tables = { ReadA: A.ReadTable, ReadB: B.ReadTable, Outbox1, Outbox2 }
      const one = { Outbox1: "outbox", Outbox2: "outbox" }
      const message = yield* make({ A: A.Ledgers, B: B.Ledgers }, tables, one)
      expect(message).toContain(
        `[EDD-9134] DynamoClient.make: "A" writes its projection's outbox items into another ` +
          `table ("outbox"), where "B" writes its own under the same key space`,
      )
      // Reaching the client only through their tables, in either order.
      expect(
        yield* make({}, { ReadB: B.ReadTable, ReadA: A.ReadTable, Outbox2, Outbox1 }, one),
      ).toContain("[EDD-9134]")
      // On two tables, they aren't refused.
      expect(yield* make({ A: A.Ledgers, B: B.Ledgers }, tables)).toBe("no failure")
    }),
  )

  it.effect("read models in different primary collections are in different key spaces", () =>
    Effect.gen(function* () {
      const OutboxTable = Table.make({ schema: On.schema, entities: {} })
      const A = ledger(On.Accounts, "a", true, OutboxTable, "ca")
      const B = ledger(On.Accounts, "a", true, OutboxTable, "cb")
      expect(
        yield* make(
          { A: A.Ledgers, B: B.Ledgers },
          { ReadA: A.ReadTable, ReadB: B.ReadTable, OutboxTable },
        ),
      ).toBe("no failure")
      // One collection: one key space.
      const C = ledger(On.Accounts, "a", true, OutboxTable, "ca")
      expect(
        yield* make(
          { A: A.Ledgers, C: C.Ledgers },
          { ReadA: A.ReadTable, ReadC: C.ReadTable, OutboxTable },
        ),
      ).toContain(
        `"C" writes its own under the same key space (partition keys starting "$a#v1#ca#shop_", ` +
          `sort keys starting "$a#v1#ca#ledger_1#name_"`,
      )
      // Not in a collection: another key space.
      const D = ledger(On.Accounts, "a", true, OutboxTable)
      expect(
        yield* make(
          { A: A.Ledgers, D: D.Ledgers },
          { ReadA: A.ReadTable, ReadD: D.ReadTable, OutboxTable },
        ),
      ).toBe("no failure")
    }),
  )

  it.effect("EventStore.processBatch refuses them among the projections it's handed", () => {
    const OutboxTable = Table.make({ schema: On.schema, entities: {} })
    const A = ledger(On.Accounts, "a", true, OutboxTable)
    const B = ledger(On.Accounts, "a", true, OutboxTable)
    const C = ledger(On.Accounts, "c", true, OutboxTable)
    const process = (projections: Record<string, (typeof A)["Remote"]>) =>
      EventStore.processBatch([], { projections, source: "lambda" }).pipe(
        Effect.as("no failure"),
        Effect.catchDefect((defect) => Effect.succeed(String(defect))),
      )
    return Effect.gen(function* () {
      const message = yield* process({ a: A.Remote, b: B.Remote })
      expect(message).toContain(
        `[EDD-9134] EventStore.processBatch: the read model of "a" writes its projection's ` +
          `outbox items into another table ("o"), where the read model of "b" writes its own ` +
          `under the same key space (partition keys starting "$a#v1#ledger#shop_"`,
      )
      // The same channel and the same error as DynamoClient.make's refusal of the same pair.
      const channelOf = <R>(effect: Effect.Effect<unknown, unknown, R>) =>
        Effect.map(Effect.exit(effect), (exit) =>
          Exit.isSuccess(exit)
            ? { channel: "none", error: undefined }
            : {
                channel: Cause.hasDies(exit.cause) ? "defect" : "failure",
                error: Cause.squash(exit.cause),
              },
        )
      const viaMake = yield* channelOf(
        DynamoClient.make({
          entities: { A: A.Ledgers, B: B.Ledgers },
          tables: { ReadA: A.ReadTable, ReadB: B.ReadTable, OutboxTable },
        } as any),
      )
      const viaBatch = yield* channelOf(
        EventStore.processBatch([], {
          projections: { a: A.Remote, b: B.Remote },
          source: "lambda",
        }),
      )
      expect(viaMake.channel).toBe("defect")
      expect(viaBatch.channel).toBe("defect")
      expect(Object.getPrototypeOf(viaMake.error)).toBe(Error.prototype)
      expect(Object.getPrototypeOf(viaBatch.error)).toBe(Error.prototype)
      expect(String(viaMake.error)).toContain("[EDD-9134] DynamoClient.make:")
      // A bound projection too.
      const bound = yield* EventStore.bindProjection(B.Remote)
      expect(yield* process({ a: A.Remote, b: bound })).toContain("[EDD-9134]")
      // Another schema; and one read model's projection handed twice.
      expect(yield* process({ a: A.Remote, c: C.Remote, again: A.Remote })).toBe("no failure")
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          makeRecordingTable().layer,
          On.EventsTable.layer({ name: "t" }),
          A.ReadTable.layer({ name: "t" }),
          B.ReadTable.layer({ name: "t" }),
          C.ReadTable.layer({ name: "t" }),
          OutboxTable.layer({ name: "o" }),
        ),
      ),
    )
  })

  it.effect("EventStore.processBatch compares tables by the names its context gives them", () => {
    const Outbox1 = Table.make({ schema: On.schema, entities: {} })
    const Outbox2 = Table.make({ schema: On.schema, entities: {} })
    const A = ledger(On.Accounts, "a", false, Outbox1)
    const B = ledger(On.Accounts, "a", true, Outbox2)
    const process = (first: string, second: string) =>
      EventStore.processBatch([], {
        projections: { a: A.Remote, b: B.Remote },
        source: "lambda",
      }).pipe(
        Effect.as("no failure"),
        Effect.catchDefect((defect) => Effect.succeed(String(defect))),
        Effect.provide(
          Layer.mergeAll(
            makeRecordingTable().layer,
            On.EventsTable.layer({ name: "t" }),
            A.ReadTable.layer({ name: "ra" }),
            B.ReadTable.layer({ name: "rb" }),
            Outbox1.layer({ name: first }),
            Outbox2.layer({ name: second }),
          ),
        ),
      )
    return Effect.gen(function* () {
      expect(yield* process("o", "o")).toContain(
        `[EDD-9134] EventStore.processBatch: the read model of "a" writes its projection's ` +
          `outbox items into another table ("o"), where the read model of "b" writes its own`,
      )
      expect(yield* process("o1", "o2")).toBe("no failure")
    })
  })

  it.effect("another schema, another entity type, or rows on another table aren't refused", () =>
    Effect.gen(function* () {
      const OutboxTable = Table.make({ schema: On.schema, entities: {} })
      const A = ledger(On.Accounts, "a", true, OutboxTable)
      // Another schema: the key spaces differ.
      const B = ledger(On.Accounts, "b", true, OutboxTable)
      // The same key space, with no outbox, its rows on its own table.
      const Rows = ledger(On.Accounts, "a", true)
      // Another schema version.
      const V2 = (() => {
        const Ledgers = Entity.make({
          model: Tally,
          entityType: "Ledger",
          primaryKey: {
            pk: { field: "pk", composite: ["shop"] },
            sk: { field: "sk", composite: ["name"] },
          },
        })
        return Table.make({
          schema: DynamoSchema.make({ name: "a", version: 2, escapeKeys: true }),
          entities: { Ledgers },
        })
      })()
      expect(
        yield* make(
          { A: A.Ledgers, B: B.Ledgers, Rows: Rows.Ledgers },
          { ReadA: A.ReadTable, ReadB: B.ReadTable, Rows: Rows.ReadTable, V2, OutboxTable },
        ),
      ).toBe("no failure")
    }),
  )
})

describe.each([
  ["A unescaped, B escaped", false],
  ["A escaped, B unescaped", true],
] as const)("[EDD-9134] projections defined after the client was made, %s", (_d, escaped) => {
  it.effect("rekey refuses them before sending anything; B's outbox item stays, delivered", () => {
    const table = makeRecordingTable()
    // One physical outbox table, a handle each.
    const Outbox1 = Table.make({ schema: On.schema, entities: {} })
    const Outbox2 = Table.make({ schema: On.schema, entities: {} })
    const A = ledgerTable("a", escaped)
    const B = ledgerTable("a", !escaped)
    return Effect.gen(function* () {
      const db = (yield* DynamoClient.make({
        entities: { A: A.Ledgers, B: B.Ledgers },
        tables: { ReadA: A.ReadTable, ReadB: B.ReadTable, Outbox1, Outbox2 },
      })) as any
      // Defined only now, so `DynamoClient.make` saw no outbox.
      ledgerProjection(On.Accounts, A.Ledgers, Outbox1)
      const ToB = ledgerProjection(On.Accounts, B.Ledgers, Outbox2)
      const events = yield* seed(On, "moved", [new Opened(), new Added({ amount: 2 })], 0)
      yield* ToB.applyBatch(events)
      expect(rowsOf(table, "Ledger#outbox")).toHaveLength(1)
      const before = new Map(table.items)
      table.take()
      for (const handle of ["Outbox1", "Outbox2"]) {
        for (const options of [{ dryRun: true }, {}]) {
          const exit = yield* Effect.exit(
            db.tables[handle].rekey({ streams: [On.Accounts], ...options }) as Effect.Effect<
              Table.RekeyReport,
              unknown
            >,
          )
          // The run's own failure, on its error channel: never a defect.
          expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(false)
          const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
          expect(error).toMatchObject({
            _tag: "ValidationError",
            entityType: "Table",
            operation: "rekey",
          })
          expect(String((error as { readonly cause?: unknown }).cause)).toContain(
            `[EDD-9134] rekey: "A" writes its projection's outbox items into another table ` +
              `("outbox"), where "B" writes its own under the same key space`,
          )
          expect(table.take()).toEqual([])
        }
      }
      expect(table.items).toEqual(before)
      const delivered: Array<number> = []
      yield* ToB.drain(ROWS.moved!, (effect) =>
        Effect.sync(() => void delivered.push(effect.total)),
      )
      expect(delivered).toEqual([2])
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          table.layer,
          On.EventsTable.layer({ name: "t" }),
          A.ReadTable.layer({ name: "ra" }),
          B.ReadTable.layer({ name: "rb" }),
          Outbox1.layer({ name: "outbox" }),
          Outbox2.layer({ name: "outbox" }),
        ),
      ),
    )
  })
})

/** A row keyed by either of two identifiers, after a number when `numbered`. */
const Keyed = Schema.Struct({
  n: Schema.Number,
  idA: Schema.String,
  idB: Schema.String,
  name: Schema.String,
  total: Schema.Number,
  version: Schema.Number,
  rev: Schema.Number,
})
type Keyed = typeof Keyed.Type

/**
 * Two `Ledger` read models in one schema whose projections' outboxes are on one table, their
 * partition keys led by `first` and `second`; the second's followed by `idB` when they're the same.
 * `numbered` puts the number `n` before them, whose key text can't hold `#`.
 */
const keyedSpaces = (
  w: World,
  escapeKeys: boolean,
  first: "idA",
  second: "idA" | "idB",
  numbered = false,
) => {
  const OutboxTable = Table.make({ schema: w.schema, entities: {} })
  const side = (lead: "idA" | "idB", tag: string) => {
    const Ledgers = Entity.make({
      model: Keyed,
      entityType: "Ledger",
      primaryKey: {
        pk: {
          field: "pk",
          composite: [
            ...(numbered ? (["n"] as const) : []),
            ...(lead === "idB" || tag === "a" ? ([lead] as const) : ([lead, "idB"] as const)),
          ],
        },
        sk: { field: "sk", composite: ["name"] },
      },
    })
    const ReadTable = Table.make({
      schema: DynamoSchema.make({ name: "k", version: 1, escapeKeys }),
      entities: { Ledgers },
    })
    const row = (account: string) => ({
      n: 7,
      idA: ROWS[account]!.shop,
      idB: ROWS[account]!.shop,
      name: ROWS[account]!.name,
    })
    const Remote = EventStore.projection({
      stream: w.Accounts,
      readModel: Ledgers,
      key: (id) => row(id.account),
      initial: (id): Keyed => ({ ...row(id.account), total: 0, version: 0, rev: 0 }),
      evolve: (state, event) =>
        Effect.succeed(
          event.data._tag === "Added"
            ? { ...state, total: state.total + event.data.amount }
            : state,
        ),
      checkpoint: "version",
      revision: "rev",
      outbox: {
        schema: Notice,
        effects: (event: EventStore.StreamEvent<AccountEvent>, next: Keyed | undefined) =>
          event.data._tag === "Added"
            ? [{ account: event.streamId, total: next?.total ?? -1 }]
            : [],
        table: OutboxTable,
      },
    })
    return { Ledgers, ReadTable, Remote, row }
  }
  return { w, OutboxTable, A: side(first, "a"), B: side(second, "b") }
}

describe("[EDD-9134] read models whose key spaces part at their first composite", () => {
  const layers = (...all: ReadonlyArray<ReturnType<typeof keyedSpaces>>) =>
    all
      .flatMap((s) => [
        s.w.EventsTable.layer({ name: "t" }),
        s.A.ReadTable.layer({ name: "ra" }),
        s.B.ReadTable.layer({ name: "rb" }),
        s.OutboxTable.layer({ name: "o" }),
      ])
      .reduce((merged, layer) => Layer.merge(merged, layer)) as Layer.Layer<any, never, never>
  const clientOf = (s: ReturnType<typeof keyedSpaces>) =>
    DynamoClient.make({
      entities: { A: s.A.Ledgers, B: s.B.Ledgers },
      tables: { ReadA: s.A.ReadTable, ReadB: s.B.ReadTable, OutboxTable: s.OutboxTable },
    } as any)

  it.effect.each([
    ["the same composite", false, "$k#v1#ledger#ida_"],
    ["a number then the same composite", true, "$k#v1#ledger#n_"],
  ] as const)(
    "led by %s, they bind and run; rekey of their outbox table refuses them",
    ([, numbered, starting]) => {
      const table = makeRecordingTable()
      const s = keyedSpaces(On, true, "idA", "idA", numbered)
      return Effect.gen(function* () {
        // A key of one is a key of the other only through a value holding `#`: as on 1.39.0.
        const db = (yield* clientOf(s)) as any
        const events = yield* seed(s.w, "moved", [new Opened(), new Added({ amount: 2 })], 0)
        yield* s.A.Remote.applyBatch(events)
        yield* s.B.Remote.applyBatch(events)
        expect(rowsOf(table, "Ledger#outbox")).toHaveLength(2)
        const before = new Map(table.items)
        table.take()
        // `rekey` reads an item's key back by its key space, and A's reads B's keys too.
        for (const options of [{ dryRun: true }, {}]) {
          const exit = yield* Effect.exit(
            db.tables.OutboxTable.rekey({ streams: [s.w.Accounts], ...options }) as Effect.Effect<
              Table.RekeyReport,
              unknown
            >,
          )
          expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(false)
          const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
          expect(error).toMatchObject({
            _tag: "ValidationError",
            entityType: "Table",
            operation: "rekey",
          })
          expect(String((error as { readonly cause?: unknown }).cause)).toContain(
            `[EDD-9134] rekey: "A" writes its projection's outbox items into another table ` +
              `("o"), where "B" writes its own under the same key space (partition keys ` +
              `starting "${starting}", sort keys starting "$k#v1#ledger#name_"`,
          )
          expect(table.take()).toEqual([])
        }
        expect(table.items).toEqual(before)
        // The read models' own tables hold no outbox: their `rekey` runs.
        const own = (yield* db.tables.ReadA.rekey({ streams: [s.w.Accounts] })) as Table.RekeyReport
        expect(own.conflicts).toEqual([])
        for (const side of ["A", "B"] as const) {
          const delivered: Array<number> = []
          yield* s[side].Remote.drain(s[side].row("moved"), (effect) =>
            Effect.sync(() => void delivered.push(effect.total)),
          )
          expect(delivered).toEqual([2])
        }
      }).pipe(Effect.provide(Layer.mergeAll(table.layer, layers(s))))
    },
  )

  it.effect.each([
    ["to on", false, true, false],
    ["to off", true, false, false],
    // A number can't hold `#`: the keys part at the label after it.
    ["after a number, to on", false, true, true],
    ["after a number, to off", true, false, true],
  ] as const)(
    "led by idA and idB, they bind, and rekey moves each by its own (%s)",
    ([, from, to, numbered]) => {
      const table = makeRecordingTable()
      const written = keyedSpaces(from ? On : Off, from, "idA", "idB", numbered)
      const now = keyedSpaces(to ? On : Off, to, "idA", "idB", numbered)
      const outboxes = () =>
        rowsOf(table, "Ledger#outbox")
          .map(([stored]) => stored)
          .sort()
      return Effect.gen(function* () {
        const events = yield* seed(written.w, "moved", [new Opened(), new Added({ amount: 2 })], 0)
        yield* written.A.Remote.applyBatch(events)
        yield* written.B.Remote.applyBatch(events)
        const before = outboxes()
        expect(before).toHaveLength(2)
        const db = (yield* clientOf(now)) as any
        const report = (yield* db.tables.OutboxTable.rekey({
          streams: [now.w.Accounts],
        })) as Table.RekeyReport
        expect(report.moved).toEqual({ ...ZERO, outbox: 2 })
        expect(report.skipped.unrecognizedKey).toBe(0)
        expect(report.conflicts).toEqual([])
        const after = outboxes()
        expect(after.filter((key) => before.includes(key))).toEqual([])
        const again = (yield* db.tables.OutboxTable.rekey({
          streams: [now.w.Accounts],
        })) as Table.RekeyReport
        expect(again.moved).toEqual(ZERO)
        expect(outboxes()).toEqual(after)
        for (const side of ["A", "B"] as const) {
          const delivered: Array<number> = []
          yield* now[side].Remote.drain(now[side].row("moved"), (effect) =>
            Effect.sync(() => void delivered.push(effect.total)),
          )
          expect(delivered).toEqual([2])
        }
      }).pipe(Effect.provide(Layer.mergeAll(table.layer, layers(written, now))))
    },
  )
})

/**
 * A read model with two projections, each with its outbox on its own table. The read model keeps
 * every projection's outbox, so each table's `rekey` moves its own items, the first projection's
 * included: a second projection defined after it doesn't hide them.
 */
const twoOutboxes = (schema: DynamoSchema.DynamoSchema) => {
  const EventsTable = Table.make({ schema, entities: {} })
  const Accounts = EventStore.makeStream({
    table: EventsTable,
    streamName: "Account",
    events: [Opened, Added, Closed],
    streamId: { composite: ["account"] },
  })
  const Ledgers = Entity.make({
    model: Tally,
    entityType: "Ledger",
    primaryKey: {
      pk: { field: "pk", composite: ["shop"] },
      sk: { field: "sk", composite: ["name"] },
    },
  })
  const ReadTable = Table.make({ schema, entities: { Ledgers } })
  const FirstTable = Table.make({ schema, entities: {} })
  const SecondTable = Table.make({ schema, entities: {} })
  const projection = (table: typeof FirstTable) =>
    EventStore.projection({
      stream: Accounts,
      readModel: Ledgers,
      key: (id: { readonly account: string }) => ROWS[id.account]!,
      initial: (id: { readonly account: string }): Tally => ({
        ...ROWS[id.account]!,
        total: 0,
        version: 0,
        rev: 0,
      }),
      evolve: (state, event) =>
        Effect.succeed(
          event.data._tag === "Added"
            ? { ...state, total: state.total + event.data.amount }
            : state,
        ),
      checkpoint: "version",
      revision: "rev",
      outbox: {
        schema: Notice,
        effects: (event, next) =>
          event.data._tag === "Added"
            ? [{ account: event.streamId, total: next?.total ?? -1 }]
            : [],
        table,
      },
    })
  const First = projection(FirstTable)
  const Second = projection(SecondTable)
  return {
    schema,
    EventsTable,
    ReadTable,
    FirstTable,
    SecondTable,
    Accounts,
    Ledgers,
    First,
    Second,
  }
}

const TwoOn = twoOutboxes(DynamoSchema.make({ name: "two", version: 1, escapeKeys: true }))
const TwoOff = twoOutboxes(DynamoSchema.make({ name: "two", version: 1, escapeKeys: false }))
type Two = typeof TwoOn

const twoLayer = (w: Two) =>
  Layer.mergeAll(
    w.EventsTable.layer({ name: "t" }),
    w.ReadTable.layer({ name: "t" }),
    w.FirstTable.layer({ name: "o1" }),
    w.SecondTable.layer({ name: "o2" }),
  )

describe.each([
  ["to on", TwoOff, TwoOn],
  ["to off", TwoOn, TwoOff],
] as const)("rekey, two projections' outboxes on two other tables, %s", (_direction, from, to) => {
  const run = <A, E>(body: (table: RecordingTable) => Effect.Effect<A, E, any>) =>
    Effect.gen(function* () {
      const table = makeRecordingTable()
      return yield* body(table).pipe(
        Effect.provide(Layer.mergeAll(table.layer, twoLayer(TwoOn), twoLayer(TwoOff))),
      ) as Effect.Effect<A, E>
    })
  const rekeyOf = (w: Two, which: "FirstTable" | "SecondTable") =>
    Effect.gen(function* () {
      const db = (yield* DynamoClient.make({
        entities: { Ledgers: w.Ledgers },
        tables: { ReadTable: w.ReadTable, FirstTable: w.FirstTable, SecondTable: w.SecondTable },
      })) as any
      return yield* db.tables[which].rekey() as Effect.Effect<Table.RekeyReport, unknown, any>
    })
  const ledgerKey = (w: Two) =>
    KeyComposer.composeIndexKeys(
      w.schema,
      "Ledger",
      1,
      w.Ledgers.indexes.primary,
      ROWS.moved!,
    ) as Keys

  it.effect.each([
    ["the first projection's", "First", "FirstTable", "o1"],
    ["the second projection's", "Second", "SecondTable", "o2"],
  ] as const)("%s items move with their table's rekey", ([_name, projection, which, name]) =>
    run((table) =>
      Effect.gen(function* () {
        yield* from.Accounts.append(
          { account: "moved" },
          [new Opened(), new Added({ amount: 2 })],
          0,
        )
        yield* from[projection].applyBatch(yield* from.Accounts.read({ account: "moved" }))
        const old = ledgerKey(from)
        const now = ledgerKey(to)
        expect(rowsOf(table, "Ledger#outbox").map(([stored]) => stored)).toEqual([
          `${old.pk}|${old.sk}#outbox#000000000001#0000`,
        ])
        table.take()
        const report = yield* rekeyOf(to, which)
        expect(report.byMember.Ledger?.moved).toEqual({ ...ZERO, outbox: 1 })
        const sent = table.take().filter((r) => r.command === "TransactWriteItems")
        expect(sent.map((r) => (r.input.TransactItems as Array<any>)[0].Put.TableName)).toEqual([
          name,
        ])
        expect(rowsOf(table, "Ledger#outbox").map(([stored]) => stored)).toEqual([
          `${now.pk}|${now.sk}#outbox#000000000001#0000`,
        ])
      }),
    ),
  )
})

/**
 * A recording table per physical table, each request answered by the table it names (a
 * transaction's items by theirs, in turn), so a table's `rekey` scans its own rows only.
 */
const routedTables = () => {
  const byName = new Map<string, RecordingTable>()
  const named = (name: string): RecordingTable => {
    const known = byName.get(name)
    if (known !== undefined) return known
    const made = makeRecordingTable()
    byName.set(name, made)
    return made
  }
  const first = named("t")
  const client = new Proxy(first.client, {
    get: (target, operation) => {
      const value = (target as any)[operation]
      if (typeof value !== "function") return value
      return (input: any) => {
        if (operation === "transactWriteItems" || operation === "transactGetItems") {
          const groups = new Map<string, Array<unknown>>()
          for (const item of input.TransactItems) {
            const name = (Object.values(item)[0] as { readonly TableName: string }).TableName
            groups.set(name, [...(groups.get(name) ?? []), item])
          }
          return Effect.forEach([...groups], ([name, items]) =>
            (named(name).client as any)[operation]({ ...input, TransactItems: items }),
          ).pipe(Effect.map((answers) => answers[0] ?? {}))
        }
        const name = input.TableName ?? Object.keys(input.RequestItems ?? {})[0] ?? "t"
        return (named(String(name)).client as any)[operation](input)
      }
    },
  })
  return {
    layer: Layer.succeed(DynamoClient, client),
    /** The requests sent to any table since the last call, and forget them. */
    take: () => [...byName.values()].flatMap((table) => table.take()),
    /** Every table's items, by table. */
    snapshot: () =>
      new Map([...byName].map(([name, table]) => [name, new Map(table.items)] as const)),
    /** The rows of `type` on table `name`. */
    rows: (name: string, type: string) => rowsOf(named(name), type),
  }
}
type RoutedTables = ReturnType<typeof routedTables>

/** A row of every composite the pairs below are keyed by. */
const Pair = Schema.Struct({
  n: Schema.Number,
  n_x: Schema.String,
  kind: Schema.Literals(["a", "b"]),
  shop: Schema.String,
  branch: Schema.String,
  idA: Schema.String,
  idB: Schema.String,
  name: Schema.String,
  total: Schema.Number,
  version: Schema.Number,
  rev: Schema.Number,
})
type Pair = typeof Pair.Type
type PairKey = keyof typeof Pair.fields

/** The row each pair's read models write, its name changed by escaping. */
const PAIR_ROW = {
  n: 7,
  n_x: "q",
  kind: "a",
  shop: "north",
  branch: "b1",
  idA: "x",
  idB: "y",
  name: "a b",
} as const

/**
 * One side of a pair: a `Ledger` read model keyed by `pk` (and `name`), on a table of its own or a
 * member of the outbox table (`member`), whose projection has its outbox on the outbox table
 * (`"remote"`), on its own table (`"local"`), or has none (`"none"`).
 */
interface PairSide {
  readonly pk: ReadonlyArray<PairKey>
  readonly member?: boolean
  readonly outbox?: "remote" | "local" | "none"
}

/** `sides` in schema `pair` under `w`'s setting, with one outbox table, `O`, named `o`. */
const pairs = (w: World, sides: ReadonlyArray<PairSide>) => {
  const schema = DynamoSchema.make({ name: "pair", version: 1, escapeKeys: w === On })
  const built = sides.map((side) => ({
    side,
    Ledgers: Entity.make({
      model: Pair,
      entityType: "Ledger",
      primaryKey: {
        pk: { field: "pk", composite: [...side.pk] },
        sk: { field: "sk", composite: ["name"] },
      },
    }),
  }))
  const O = Table.make({
    schema,
    entities: Object.fromEntries(
      built.flatMap(({ side, Ledgers }, i) => (side.member ? [[`M${i}`, Ledgers]] : [])),
    ),
  })
  const read = built.map(({ side, Ledgers }, i) =>
    side.member ? undefined : Table.make({ schema, entities: { [`L${i}`]: Ledgers } }),
  )
  const projections = built.map(({ side, Ledgers }) =>
    (side.outbox ?? "remote") === "none"
      ? undefined
      : EventStore.projection({
          stream: w.Accounts,
          readModel: Ledgers as unknown as Entity.Entity<any, any, any, any, any>,
          key: () => PAIR_ROW,
          initial: (): Pair => ({ ...PAIR_ROW, total: 0, version: 0, rev: 0 }),
          evolve: (state: Pair, event: EventStore.StreamEvent<AccountEvent>) =>
            Effect.succeed(
              event.data._tag === "Added"
                ? { ...state, total: state.total + event.data.amount }
                : state,
            ),
          checkpoint: "version",
          revision: "rev",
          outbox: {
            schema: Notice,
            effects: (event: EventStore.StreamEvent<AccountEvent>, next: Pair | undefined) =>
              event.data._tag === "Added"
                ? [{ account: event.streamId, total: next?.total ?? -1 }]
                : [],
            ...(side.outbox === "local" ? {} : { table: O }),
          },
        } as any),
  )
  const layer = Layer.mergeAll(
    w.EventsTable.layer({ name: "t" }),
    O.layer({ name: "o" }),
    ...read.flatMap((table, i) => (table === undefined ? [] : [table.layer({ name: `r${i}` })])),
  )
  /** A client binding the read models in `order` (by index) and every table. */
  const client = (order: ReadonlyArray<number> = sides.map((_, i) => i), viaTables = false) =>
    DynamoClient.make({
      entities: viaTables
        ? {}
        : Object.fromEntries(order.map((i) => [String.fromCharCode(65 + i), built[i]!.Ledgers])),
      tables: Object.fromEntries([
        ["O", O],
        ...order.flatMap((i) => (read[i] === undefined ? [] : [[`R${i}`, read[i]!]])),
      ]),
    } as any) as Effect.Effect<any, never, any>
  return { w, O, built, projections, layer, client }
}
type Pairs = ReturnType<typeof pairs>

/** `side`'s projection applies `moved`'s events; `drained` is what its drainer delivers. */
const applyPair = (s: Pairs, side: number, events: ReadonlyArray<unknown>) =>
  (s.projections[side] as any).applyBatch(events) as Effect.Effect<unknown>
const drained = (s: Pairs, side: number) =>
  Effect.gen(function* () {
    const delivered: Array<number> = []
    yield* (s.projections[side] as any).drain(PAIR_ROW, (effect: { readonly total: number }) =>
      Effect.sync(() => void delivered.push(effect.total)),
    ) as Effect.Effect<unknown>
    return delivered
  })

/** `O.rekey`'s failure, as a `ValidationError`'s cause, after checking it sent nothing. */
const refusedRekey = (
  tables: RoutedTables,
  s: Pairs,
  order?: ReadonlyArray<number>,
): Effect.Effect<ReadonlyArray<string>, unknown, any> =>
  Effect.gen(function* () {
    const db = yield* s.client(order)
    const causes: Array<string> = []
    const before = tables.snapshot()
    tables.take()
    for (const options of [{ dryRun: true }, {}]) {
      const exit = yield* Effect.exit(
        db.tables.O.rekey({ streams: [s.w.Accounts], ...options }) as Effect.Effect<
          Table.RekeyReport,
          unknown
        >,
      )
      // The run's own failure, on its error channel: never a defect.
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(false)
      const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
      expect(error).toMatchObject({
        _tag: "ValidationError",
        entityType: "Table",
        operation: "rekey",
      })
      causes.push(String((error as { readonly cause?: unknown }).cause))
      expect(tables.take()).toEqual([])
    }
    expect(tables.snapshot()).toEqual(before)
    return causes
  })

describe("[EDD-9134] a number composite beside a label its key text can't spell", () => {
  // A is keyed by the number `n` (`n_0000000000000007`), B by the string `n_x` (`n_x_q`): a
  // number's key text holds no `x`, so no key of one is a key of the other. 1.39.0 bound them.
  const sides: ReadonlyArray<PairSide> = [{ pk: ["n"] }, { pk: ["n_x"] }]

  it.effect.each(DIRECTIONS)(
    "they bind, apply, process and drain, each its own, and rekey moves each by its own (%s)",
    ([, from, to]) => {
      const tables = routedTables()
      const written = pairs(from, sides)
      const now = pairs(to, sides)
      return Effect.gen(function* () {
        for (const s of [written, now]) {
          yield* s.client()
          yield* s.client(undefined, true)
          yield* EventStore.processBatch([], {
            projections: { a: s.projections[0] as any, b: s.projections[1] as any },
            source: "lambda",
          })
        }
        const events = yield* seed(from, "moved", [new Opened(), new Added({ amount: 2 })], 0)
        yield* applyPair(written, 0, events)
        yield* applyPair(written, 1, events)
        expect(tables.rows("o", "Ledger#outbox")).toHaveLength(2)
        const db = yield* now.client()
        const report = (yield* db.tables.O.rekey({
          streams: [to.Accounts],
        })) as Table.RekeyReport
        expect(report.moved).toEqual({ ...ZERO, outbox: 2 })
        expect(report.skipped.unrecognizedKey).toBe(0)
        expect(report.conflicts).toEqual([])
        expect(yield* drained(now, 0)).toEqual([2])
        expect(yield* drained(now, 1)).toEqual([2])
      }).pipe(
        Effect.provide(Layer.mergeAll(tables.layer, written.layer, now.layer)),
      ) as Effect.Effect<void, unknown>
    },
  )
})

describe.each(DIRECTIONS)("[EDD-9134] a member of the outbox's table, %s", (_d, from, to) => {
  // M is a member of the outbox table, keyed by `shop`; R's projection writes its outbox there,
  // keyed by `shop` and `branch`. M claims the outbox items of its entity type on its table, and
  // reads R's key `shop_north#branch_b1` as `shop` = `north#branch_b1`.
  it.effect.each([
    ["no projection", "none"],
    ["a projection with its outbox on its own table", "local"],
  ] as const)(
    "M with %s: rekey of the outbox table refuses it before sending anything",
    ([, outbox]) => {
      const tables = routedTables()
      const sides: ReadonlyArray<PairSide> = [
        { pk: ["shop"], member: true, outbox },
        { pk: ["shop", "branch"] },
      ]
      const written = pairs(from, sides)
      const now = pairs(to, sides)
      return Effect.gen(function* () {
        const events = yield* seed(from, "moved", [new Opened(), new Added({ amount: 2 })], 0)
        if (outbox === "local") yield* applyPair(written, 0, events)
        yield* applyPair(written, 1, events)
        // Bound as on 1.39.0: only `rekey` reads an item's key back.
        yield* written.client()
        for (const order of [
          [0, 1],
          [1, 0],
        ]) {
          const causes = yield* refusedRekey(tables, now, order)
          for (const cause of causes) {
            expect(cause).toContain(
              `[EDD-9134] rekey: "B" writes its projection's outbox items into another table ` +
                `("o"), whose member "A" claims the outbox items of its entity type there under ` +
                `the same key space (partition keys starting "$pair#v1#ledger#shop_"`,
            )
          }
        }
        // R's item is where it was, delivered by R's drainer under the setting it was written.
        expect(yield* drained(written, 1)).toEqual([2])
      }).pipe(
        Effect.provide(Layer.mergeAll(tables.layer, written.layer, now.layer)),
      ) as Effect.Effect<void, unknown>
    },
  )

  it.effect("a member composing its keys as the read model does moves its items there", () => {
    const tables = routedTables()
    const sides: ReadonlyArray<PairSide> = [
      { pk: ["shop", "branch"], member: true, outbox: "none" },
      { pk: ["shop", "branch"] },
    ]
    const written = pairs(from, sides)
    const now = pairs(to, sides)
    return Effect.gen(function* () {
      const events = yield* seed(from, "moved", [new Opened(), new Added({ amount: 2 })], 0)
      yield* applyPair(written, 1, events)
      const db = yield* now.client()
      const report = (yield* db.tables.O.rekey({ streams: [to.Accounts] })) as Table.RekeyReport
      expect(report.moved).toEqual({ ...ZERO, outbox: 1 })
      expect(report.skipped.unrecognizedKey).toBe(0)
      expect(yield* drained(now, 1)).toEqual([2])
    }).pipe(
      Effect.provide(Layer.mergeAll(tables.layer, written.layer, now.layer)),
    ) as Effect.Effect<void, unknown>
  })
})

describe.each(
  DIRECTIONS,
)("[EDD-9134] read models led by a literal composite, %s", (_d, from, to) => {
  // `kind` is `a` or `b`, and each read model writes `kind_a`. rekey's reader reads a literal as
  // any text, as it reads a string, so A's reads B's `kind_a#idb_y#ida_x` as `kind` =
  // `a#idb_y`, `idA` = `x`; and B's reads A's `kind_a#ida_x` when `x` holds `#idb_`.
  it.effect.each([
    ["one going on with the other's composites", ["kind", "idA"], ["kind", "idB", "idA"]],
    ["each going on with its own composite", ["kind", "idA"], ["kind", "idB"]],
  ] as const)("%s: they bind and run; rekey of their outbox table refuses them", ([, a, b]) => {
    const tables = routedTables()
    const sides: ReadonlyArray<PairSide> = [{ pk: a }, { pk: b }]
    const written = pairs(from, sides)
    const now = pairs(to, sides)
    return Effect.gen(function* () {
      // Their keys are apart for the values a literal can take: bound as on 1.39.0.
      yield* written.client()
      const events = yield* seed(from, "moved", [new Opened(), new Added({ amount: 2 })], 0)
      yield* applyPair(written, 0, events)
      yield* applyPair(written, 1, events)
      expect(tables.rows("o", "Ledger#outbox")).toHaveLength(2)
      for (const order of [
        [0, 1],
        [1, 0],
      ]) {
        const causes = yield* refusedRekey(tables, now, order)
        for (const cause of causes) {
          expect(cause).toContain("[EDD-9134] rekey: ")
          expect(cause).toContain(`(partition keys starting "$pair#v1#ledger#kind_"`)
        }
      }
      expect(yield* drained(written, 0)).toEqual([2])
      expect(yield* drained(written, 1)).toEqual([2])
    }).pipe(
      Effect.provide(Layer.mergeAll(tables.layer, written.layer, now.layer)),
    ) as Effect.Effect<void, unknown>
  })
})
