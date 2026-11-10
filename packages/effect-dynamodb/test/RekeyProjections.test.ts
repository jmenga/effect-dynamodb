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
import { Effect, Layer, Schema } from "effect"
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
