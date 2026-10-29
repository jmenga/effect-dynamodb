/**
 * Projection read models still under their 1.36 keys (#171) — request capture.
 *
 * A projection reads its row strongly consistent and writes it whole; a row
 * 1.36 wrote under a key whose text changed (a number, a sort key value
 * holding a space) looked absent to it, so it folded from `initial` again and
 * wrote a second row. While the fallback is on, these tests run projections
 * against a recording in-memory table and check that:
 *
 * - **Zero overhead.** Rows under keys whose text did not change: the same
 *   requests with the fallback on as off. With `legacyKeys: false`, no
 *   request names a 1.36 key.
 * - **The row is found and moved.** A row, tombstone or outbox item under its
 *   1.36 key is read there, and the projection's write moves it: the row's
 *   own write (the entity's `put`, which moves it first), or the tombstone's
 *   and the outbox transaction's Put at the current key beside a Delete of
 *   the 1.36 row while it is as read. The accumulated state, checkpoints and
 *   revision carry over; a redelivery is still recognised.
 * - **Outboxes drain in one order.** `drain(key)` and `drainPending` deliver
 *   a row's effects under its 1.36 key and its current key by revision.
 * - **`rekey` moves them.** A tombstone or outbox item 1.36 wrote moves to
 *   its row's current key, marked — an outbox on a table of its own with that
 *   table's `rekey`; a dry run counts them; ones 1.37 wrote are left alone.
 *
 * `connected.legacy-key-projections.test.ts` runs the same against DynamoDB
 * Local.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { describe, expect, it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import * as KeyText136 from "@effect-dynamodb/schema/internal/KeyText136.js"
import * as KeyComposer from "@effect-dynamodb/schema/KeyComposer.js"
import { Effect, Layer, Option, Schema } from "effect"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
import { fromAttributeMap, toAttributeMap } from "../src/Marshaller.js"
import * as Table from "../src/Table.js"
import { makeRecordingTable, type Request } from "./helpers/RecordingTable.js"

// ---------------------------------------------------------------------------
// Fixtures — one set per schema: the fallback on, and off
// ---------------------------------------------------------------------------

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
type Notice = typeof Notice.Type

/**
 * The read-model row each account feeds: text that 1.36 composed the same,
 * text that changed (a space, escaped now), and text whose 1.36 key is the
 * current key of `moved`'s (`a%20b` is how `a b` is escaped). Numbers are
 * covered by `connected.legacy-keys.test.ts`.
 */
const ROWS: Record<string, { readonly shop: string; readonly name: string }> = {
  same: { shop: "s1", name: "ab" },
  moved: { shop: "s1", name: "a b" },
  escaped: { shop: "s1", name: "a%20b" },
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

const On = world(DynamoSchema.make({ name: "proj136", version: 1 }))
const Off = world(DynamoSchema.make({ name: "proj136", version: 1, legacyKeys: false }))
type World = typeof On

type RecordingTable = ReturnType<typeof makeRecordingTable>

/** Run `body` in `w` over a fresh recording table. */
const inTable = <A, E>(w: World, body: (table: RecordingTable) => Effect.Effect<A, E, any>) =>
  Effect.gen(function* () {
    const table = makeRecordingTable({ indexes: { outbox: { pk: "obpk", sk: "obsk" } } })
    const result = yield* body(table).pipe(
      Effect.provide(
        Layer.mergeAll(
          table.layer,
          w.EventsTable.layer({ name: "t" }),
          w.ReadTable.layer({ name: "t" }),
          w.OutboxTable.layer({ name: "o" }),
        ),
      ),
    ) as Effect.Effect<A, E>
    return { table, result }
  })

type Keys = Record<string, string>
const at = (key: Keys) => `${key.pk}|${key.sk}`

/** A row's current key and the key 1.36 composed for it. */
const keysOf = (
  w: World,
  entityType: "Tally" | "Total" | "Sum" | "Ledger" | "Rem",
  account: string,
) => {
  const record = ROWS[account]!
  const entity = {
    Tally: w.Tallies,
    Total: w.Totals,
    Sum: w.Sums,
    Ledger: w.Ledgers,
    Rem: w.Rems,
  }[entityType]
  const primary = entity.indexes.primary
  return {
    current: KeyComposer.composeIndexKeys(w.schema, entityType, 1, primary, record) as Keys,
    old: KeyText136.composeIndexKeys(w.schema, entityType, 1, primary, record),
  }
}

/**
 * Rewrite a read-model row, and its outbox items, as 1.36 wrote them: under
 * the row's 1.36 key, the items naming it (`__edd_row_pk__` / `__edd_row_sk__`
 * and the sparse index's sort key), without the mark 1.37 gives a tombstone
 * or an outbox item.
 */
const demote = (table: RecordingTable, keys: { readonly current: Keys; readonly old: Keys }) => {
  const { current, old } = keys
  expect(old).not.toEqual(current)
  for (const [stored, { __edd_kt__: _, ...item }] of [...table.items.entries()]) {
    const pk = item.pk?.S
    const sk = item.sk?.S
    if (pk !== current.pk || sk === undefined) continue
    if (sk === current.sk) {
      table.items.delete(stored)
      table.items.set(at(old), { ...item, ...toAttributeMap(old) })
    } else if (sk.startsWith(`${current.sk}#outbox#`)) {
      const moved = `${old.sk}${sk.slice(current.sk!.length)}`
      table.items.delete(stored)
      table.items.set(`${old.pk}|${moved}`, {
        ...item,
        ...toAttributeMap({
          pk: old.pk,
          sk: moved,
          __edd_row_pk__: old.pk,
          __edd_row_sk__: old.sk,
          ...(item.obsk !== undefined && { obsk: `${old.pk}#${moved}` }),
        }),
      })
    }
  }
}

/** Each request's command and the item keys it names, in order. */
const shape = (requests: ReadonlyArray<Request>) =>
  requests.map(({ command, input }) => {
    const keyText = (key: Record<string, AttributeValue> | undefined) =>
      key === undefined ? "?" : `${key.pk?.S}|${key.sk?.S}`
    switch (command) {
      case "TransactWriteItems":
        return `${command} ${(input.TransactItems as Array<any>)
          .map((item) => {
            const [kind, body] = Object.entries(item)[0] as [string, any]
            return `${kind} ${keyText(body.Item ?? body.Key)}`
          })
          .join(", ")}`
      case "Query":
        return `${command} ${input.IndexName ?? ""}${input.ExpressionAttributeValues?.[":pk"]?.S ?? input.ExpressionAttributeValues?.[":p"]?.S}|${input.ExpressionAttributeValues?.[":sk"]?.S ?? ""}`
      default:
        return `${command} ${keyText(input.Key ?? input.Item)}`
    }
  })

/** The stored rows of an entity type (by `__edd_e__`), by key. */
const rowsOf = (table: RecordingTable, type: string) =>
  [...table.items.entries()]
    .filter(([, item]) => item.__edd_e__?.S === type)
    .map(([stored, item]) => [stored, fromAttributeMap(item)] as const)

/** The requests, with each claim's random token made equal. */
const normalized = (requests: ReadonlyArray<Request>) =>
  JSON.parse(JSON.stringify(requests).replace(/"S":"\d+-\d+"/g, '"S":"<claim>"'))

/** Append `events` to `account`'s stream; the stream's events. */
const seed = (w: World, account: string, events: ReadonlyArray<AccountEvent>, expected: number) =>
  Effect.gen(function* () {
    yield* w.Accounts.append({ account }, events, expected)
    return yield* w.Accounts.read({ account })
  })

/** Every projection, its removal, its outbox and their drains, over one account's row. */
const script = (w: World, account: string) =>
  Effect.gen(function* () {
    const outcomes: Array<unknown> = []
    const delivered: Array<number> = []
    const deliver = (effect: Notice) => Effect.sync(() => void delivered.push(effect.total))
    const opened = yield* seed(w, account, [new Opened(), new Added({ amount: 2 })], 0)
    for (const projection of [w.Notifying, w.Plain]) {
      const result = yield* projection.applyBatch(opened)
      outcomes.push(result.outcomes.map((o) => o._tag))
    }
    yield* w.Multi.applyBatch(opened.map((event) => ({ stream: "account" as const, event })))
    outcomes.push(yield* w.Notifying.drain(ROWS[account]!, deliver))
    const more = yield* seed(w, account, [new Added({ amount: 3 })], 2)
    for (const projection of [w.Notifying, w.Plain]) yield* projection.apply(more[2]!)
    yield* w.Multi.catchUp(ROWS[account]!)
    outcomes.push(yield* w.Notifying.drainPending(deliver))
    const closed = yield* seed(w, account, [new Closed()], 3)
    yield* w.Notifying.apply(closed[3]!)
    // A redelivery after the removal is recognised: the tombstone kept the checkpoint.
    const late = yield* w.Notifying.apply(more[2]!)
    outcomes.push(late.alreadyApplied.length)
    outcomes.push(delivered)
    return outcomes
  })

// ---------------------------------------------------------------------------
// Zero overhead and the off switch
// ---------------------------------------------------------------------------

describe("legacy keys, projections — zero overhead and the off switch", () => {
  it.effect("rows whose key text did not change: the same requests as with the fallback off", () =>
    Effect.gen(function* () {
      const on = yield* inTable(On, () => script(On, "same"))
      const off = yield* inTable(Off, () => script(Off, "same"))
      expect(on.result).toEqual(off.result)
      // The projections ran: not a vacuous comparison.
      expect(on.result.at(-1)).toEqual([2, 5])
      expect(on.result.at(-2)).toBe(1)
      expect(on.table.requests.length).toBeGreaterThan(30)
      expect(normalized(on.table.requests)).toEqual(normalized(off.table.requests))
    }),
  )

  it.effect("a tombstone or outbox item under unchanged key text is written as 1.36 wrote it", () =>
    Effect.gen(function* () {
      const on = yield* inTable(On, () => script(On, "same"))
      const written = (on.table.requests as ReadonlyArray<Request>).flatMap(({ command, input }) =>
        command === "TransactWriteItems"
          ? (input.TransactItems as Array<any>).flatMap((item) =>
              item.Put === undefined ? [] : [item.Put.Item as Record<string, AttributeValue>],
            )
          : command === "PutItem"
            ? [input.Item as Record<string, AttributeValue>]
            : [],
      )
      const attributes = (type: string) =>
        written.filter((item) => item.__edd_e__?.S === type).map((item) => Object.keys(item).sort())
      // The attributes the published 1.36.0 wrote: no `__edd_kt__`.
      expect(attributes("Tally#tombstone")).toEqual([
        ["__edd_e__", "__edd_removed__", "pk", "rev", "sk", "version"],
      ])
      const outbox = attributes("Tally#outbox")
      expect(outbox).toHaveLength(2)
      for (const attrs of outbox) {
        expect(attrs).toEqual([
          "__edd_e__",
          "__edd_row_pk__",
          "__edd_row_sk__",
          "effect",
          "eventType",
          "obpk",
          "obsk",
          "pk",
          "sk",
          "source",
          "streamId",
          "version",
        ])
      }
    }),
  )

  it.effect("legacyKeys: false: no request names a 1.36 key", () =>
    Effect.gen(function* () {
      const off = yield* inTable(Off, () => script(Off, "moved"))
      const oldTexts = (["Tally", "Total", "Sum"] as const).flatMap((type) => {
        const { current, old } = keysOf(Off, type, "moved")
        return [old.pk!, old.sk!].filter((text) => !Object.values(current).includes(text))
      })
      expect(oldTexts).toHaveLength(3)
      const sent = JSON.stringify(off.table.requests)
      for (const text of oldTexts) expect(sent).not.toContain(text)
      // With nothing under a 1.36 key, the fallback changes no outcome.
      const on = yield* inTable(On, () => script(On, "moved"))
      expect(on.result).toEqual(off.result)
      expect(JSON.stringify(on.table.requests)).toContain(oldTexts[0])
    }),
  )
})

// ---------------------------------------------------------------------------
// Rows under their 1.36 keys
// ---------------------------------------------------------------------------

describe("legacy keys, projections — a row under its 1.36 key", () => {
  /** The `moved` account's stream, its rows written and then demoted to their 1.36 keys. */
  const seeded = (table: RecordingTable) =>
    Effect.gen(function* () {
      const opened = yield* seed(On, "moved", [new Opened(), new Added({ amount: 2 })], 0)
      yield* On.Notifying.applyBatch(opened)
      yield* On.Plain.applyBatch(opened)
      yield* On.Multi.applyBatch(opened.map((event) => ({ stream: "account" as const, event })))
      const keys = {
        Tally: keysOf(On, "Tally", "moved"),
        Total: keysOf(On, "Total", "moved"),
        Sum: keysOf(On, "Sum", "moved"),
      }
      for (const pair of Object.values(keys)) demote(table, pair)
      const more = yield* seed(On, "moved", [new Added({ amount: 3 })], 2)
      table.take()
      return { keys, more }
    })

  it.effect("the outbox transaction moves the row: Put current, Delete 1.36, the effects", () =>
    Effect.gen(function* () {
      yield* inTable(On, (table) =>
        Effect.gen(function* () {
          const { keys, more } = yield* seeded(table)
          const { current, old } = keys.Tally
          const result = yield* On.Notifying.apply(more[2]!)
          // Folded onto the row 1.36 left, not from `initial`.
          // `applyBatch` wrote revision 1; this write is the second.
          expect(Option.getOrThrow(result.state)).toMatchObject({ total: 5, version: 3, rev: 2 })
          const writes = table.take().filter((r) => r.command !== "Query")
          expect(shape(writes)).toEqual([
            `GetItem ${at(current)}`,
            `GetItem ${at(old)}`,
            `TransactWriteItems Put ${at(current)}, Delete ${at(old)}, ` +
              `Put ${current.pk}|${current.sk}#outbox#000000000002#0000`,
          ])
          const tx = writes[2]!.input.TransactItems as Array<any>
          // Nothing may be at the current key; the 1.36 row is deleted while it is as read.
          expect(tx[0].Put.ConditionExpression).toBe("attribute_not_exists(#g)")
          expect(tx[1].Delete.ConditionExpression).toContain("attribute_exists(#gpk)")
          expect(tx[1].Delete.ExpressionAttributeNames["#g0"]).toBe("rev")
          expect(writes.every((r) => r.input.ConsistentRead !== false)).toBe(true)
          expect(rowsOf(table, "Tally").map(([stored]) => stored)).toEqual([at(current)])
        }),
      )
    }),
  )

  it.effect("the entity's put moves the row first, then writes it conditioned", () =>
    Effect.gen(function* () {
      yield* inTable(On, (table) =>
        Effect.gen(function* () {
          const { keys, more } = yield* seeded(table)
          const { current, old } = keys.Total
          const result = yield* On.Plain.apply(more[2]!)
          expect(Option.getOrThrow(result.state)).toMatchObject({ total: 5, version: 3, rev: 2 })
          expect(shape(table.take())).toEqual([
            `GetItem ${at(current)}`,
            `GetItem ${at(old)}`,
            // The put judged at the current key misses, so the item moves, and is written.
            `PutItem ${at(current)}`,
            `GetItem ${at(old)}`,
            `TransactWriteItems Put ${at(current)}, Delete ${at(old)}`,
            `PutItem ${at(current)}`,
          ])
          expect(rowsOf(table, "Total").map(([stored, row]) => [stored, row.total])).toEqual([
            [at(current), 5],
          ])
        }),
      )
    }),
  )

  it.effect("a multi-source projection reads and moves its row too", () =>
    Effect.gen(function* () {
      yield* inTable(On, (table) =>
        Effect.gen(function* () {
          const { keys } = yield* seeded(table)
          const applied = yield* On.Multi.catchUp(ROWS.moved!)
          expect(Option.getOrThrow(applied.state)).toMatchObject({
            total: 5,
            checkpoints: { "account#moved": 3 },
            rev: 2,
          })
          expect(rowsOf(table, "Sum").map(([stored]) => stored)).toEqual([at(keys.Sum.current)])
        }),
      )
    }),
  )

  it.effect(
    "a tombstone under its 1.36 key: a redelivery is recognised, a new event moves it",
    () =>
      Effect.gen(function* () {
        yield* inTable(On, (table) =>
          Effect.gen(function* () {
            const opened = yield* seed(On, "moved", [new Opened(), new Added({ amount: 2 })], 0)
            const closed = yield* seed(On, "moved", [new Closed()], 2)
            yield* On.Notifying.applyBatch(closed)
            yield* On.Notifying.drain(ROWS.moved!, () => Effect.void)
            const { current, old } = keysOf(On, "Tally", "moved")
            demote(table, { current, old })
            expect(rowsOf(table, "Tally#tombstone").map(([stored]) => stored)).toEqual([at(old)])
            table.take()
            const late = yield* On.Notifying.apply(opened[1]!)
            expect(late.alreadyApplied.map((e) => e.version)).toEqual([2])
            expect(table.take().map((r) => r.command)).toEqual(["GetItem", "GetItem"])
            const reopened = yield* seed(On, "moved", [new Added({ amount: 7 })], 3)
            const result = yield* On.Notifying.apply(reopened[3]!)
            // Started again from `initial`, the revision one past the tombstone's.
            expect(Option.getOrThrow(result.state)).toMatchObject({ total: 7, version: 4, rev: 2 })
            expect(rowsOf(table, "Tally#tombstone")).toEqual([])
            expect(rowsOf(table, "Tally").map(([stored]) => stored)).toEqual([at(current)])
          }),
        )
      }),
  )

  it.effect("a removal over a row under its 1.36 key moves it as a tombstone", () =>
    Effect.gen(function* () {
      yield* inTable(On, (table) =>
        Effect.gen(function* () {
          const { keys } = yield* seeded(table)
          const { current, old } = keys.Tally
          table.take()
          const closed = yield* seed(On, "moved", [new Closed()], 3)
          // The append's transaction aside: version 3's effect, then the removal, in one write.
          yield* On.Notifying.applyBatch(closed)
          expect(shape(table.take().filter((r) => r.command === "TransactWriteItems"))).toEqual([
            expect.stringContaining("ConditionCheck"),
            `TransactWriteItems Put ${at(current)}, Delete ${at(old)}, ` +
              `Put ${current.pk}|${current.sk}#outbox#000000000002#0000`,
          ])
          expect(
            rowsOf(table, "Tally#tombstone").map(([stored, row]) => [stored, row.rev]),
          ).toEqual([[at(current), 2]])
          expect(rowsOf(table, "Tally")).toEqual([])
        }),
      )
    }),
  )

  // On the live clock: the lost race's retry waits a few milliseconds.
  it.live("a row changed since it was read is not deleted: the write is read again", () =>
    Effect.gen(function* () {
      yield* inTable(On, (table) =>
        Effect.gen(function* () {
          const { keys, more } = yield* seeded(table)
          const { old } = keys.Tally
          // Another writer bumps the 1.36 row's revision between the read and the write, once.
          let raced = false
          const original = table.items.get(at(old))!
          table.hooks.onRequest = (request) => {
            if (raced || request.command !== "TransactWriteItems") return
            raced = true
            table.items.set(at(old), { ...original, ...toAttributeMap({ total: 100, rev: 2 }) })
          }
          const result = yield* On.Notifying.apply(more[2]!)
          expect(raced).toBe(true)
          expect(Option.getOrThrow(result.state)).toMatchObject({ total: 103, rev: 3 })
          expect(rowsOf(table, "Tally").map(([, row]) => row.total)).toEqual([103])
        }),
      )
    }),
  )
})

// ---------------------------------------------------------------------------
// Outbox items under their 1.36 keys
// ---------------------------------------------------------------------------

describe("legacy keys, projections — outbox items under a 1.36 key", () => {
  /** Effects 1.36 left under the row's 1.36 key, then one 1.37 wrote under its current key. */
  const split = (table: RecordingTable) =>
    Effect.gen(function* () {
      const events = yield* seed(
        On,
        "moved",
        [new Opened(), new Added({ amount: 2 }), new Added({ amount: 3 })],
        0,
      )
      yield* On.Notifying.applyBatch(events)
      const keys = keysOf(On, "Tally", "moved")
      demote(table, keys)
      const more = yield* seed(On, "moved", [new Added({ amount: 4 })], 3)
      yield* On.Notifying.apply(more[3]!)
      // The batch's one write (revision 1) enqueued two effects; the next write, one.
      const pending = rowsOf(table, "Tally#outbox").map(([stored]) => stored)
      expect(pending.sort()).toEqual(
        [
          `${keys.old.pk}|${keys.old.sk}#outbox#000000000001#0000`,
          `${keys.old.pk}|${keys.old.sk}#outbox#000000000001#0001`,
          `${keys.current.pk}|${keys.current.sk}#outbox#000000000002#0000`,
        ].sort(),
      )
      table.take()
      return keys
    })

  it.effect("drain(key) delivers them with the current key's, by revision", () =>
    Effect.gen(function* () {
      yield* inTable(On, (table) =>
        Effect.gen(function* () {
          const { current, old } = yield* split(table)
          const delivered: Array<number> = []
          const drained = yield* On.Notifying.drain(ROWS.moved!, (effect) =>
            Effect.sync(() => void delivered.push(effect.total)),
          )
          expect(drained.delivered).toBe(3)
          expect(delivered).toEqual([2, 5, 9])
          expect(rowsOf(table, "Tally#outbox")).toEqual([])
          // Each head is the first of both keys' heads.
          const queries = shape(table.take().filter((r) => r.command === "Query"))
          expect(queries.slice(0, 2)).toEqual([
            `Query ${old.pk}|${old.sk}#outbox#`,
            `Query ${current.pk}|${current.sk}#outbox#`,
          ])
        }),
      )
    }),
  )

  it.effect("drainPending delivers a row's items under both keys in one order", () =>
    Effect.gen(function* () {
      yield* inTable(On, (table) =>
        Effect.gen(function* () {
          yield* split(table)
          const delivered: Array<number> = []
          const swept = yield* On.Notifying.drainPending((effect) =>
            Effect.sync(() => void delivered.push(effect.total)),
          )
          expect(swept.delivered).toBe(3)
          expect(delivered).toEqual([2, 5, 9])
          expect(rowsOf(table, "Tally#outbox")).toEqual([])
        }),
      )
    }),
  )

  it.effect("a failed delivery stops the row's drain at the oldest item, under either key", () =>
    Effect.gen(function* () {
      yield* inTable(On, (table) =>
        Effect.gen(function* () {
          yield* split(table)
          const delivered: Array<number> = []
          const swept = yield* On.Notifying.drainPending((effect) =>
            effect.total === 5
              ? Effect.fail("down" as const)
              : Effect.sync(() => void delivered.push(effect.total)),
          )
          // The current key's later item waits behind the 1.36 key's failed one.
          expect(delivered).toEqual([2])
          expect(swept.undelivered.map((u) => u.meta.version)).toEqual([3])
          expect(rowsOf(table, "Tally#outbox")).toHaveLength(2)
        }),
      )
    }),
  )
})

// ---------------------------------------------------------------------------
// A tombstone at a key two values share
// ---------------------------------------------------------------------------

describe("legacy keys, projections — a tombstone at a key two values share", () => {
  it.effect("the key both spell: `a b`'s current key is `a%20b`'s 1.36 key", () =>
    Effect.sync(() => {
      expect(keysOf(On, "Tally", "escaped").old).toEqual(keysOf(On, "Tally", "moved").current)
    }),
  )

  it.effect("a tombstone 1.37 wrote is not the row of the value whose 1.36 key it is at", () =>
    Effect.gen(function* () {
      yield* inTable(On, (table) =>
        Effect.gen(function* () {
          const removed = yield* seed(
            On,
            "moved",
            [new Opened(), new Added({ amount: 2 }), new Closed()],
            0,
          )
          yield* On.Notifying.applyBatch(removed)
          const shared = keysOf(On, "Tally", "moved").current
          expect(
            rowsOf(table, "Tally#tombstone").map(([stored, row]) => [stored, row.__edd_kt__]),
          ).toEqual([[at(shared), 1]])
          const events = yield* seed(On, "escaped", [new Opened(), new Added({ amount: 4 })], 0)
          const result = yield* On.Notifying.apply(events[1]!)
          // Folded from `initial`: the tombstone is `a b`'s, and stays.
          expect(Option.getOrThrow(result.state)).toMatchObject({ total: 4, version: 2, rev: 1 })
          expect(rowsOf(table, "Tally#tombstone").map(([stored]) => stored)).toEqual([at(shared)])
          expect(rowsOf(table, "Tally").map(([stored]) => stored)).toEqual([
            at(keysOf(On, "Tally", "escaped").current),
          ])
        }),
      )
    }),
  )

  // On the live clock: the write that finds the tombstone in its way retries.
  it.live("a tombstone 1.36 wrote at another value's current key moves out of its way", () =>
    Effect.gen(function* () {
      yield* inTable(On, (table) =>
        Effect.gen(function* () {
          const removed = yield* seed(
            On,
            "escaped",
            [new Opened(), new Added({ amount: 4 }), new Closed()],
            0,
          )
          yield* On.Notifying.applyBatch(removed)
          const escaped = keysOf(On, "Tally", "escaped")
          demote(table, escaped)
          const events = yield* seed(On, "moved", [new Opened(), new Added({ amount: 2 })], 0)
          const result = yield* On.Notifying.apply(events[1]!)
          // Not `a b`'s: folded from `initial`, written once the tombstone moved to its key.
          expect(Option.getOrThrow(result.state)).toMatchObject({ total: 2, version: 2, rev: 1 })
          expect(rowsOf(table, "Tally").map(([stored]) => stored)).toEqual([
            at(keysOf(On, "Tally", "moved").current),
          ])
          expect(
            rowsOf(table, "Tally#tombstone").map(([stored, row]) => [
              stored,
              row.rev,
              row.__edd_kt__,
            ]),
          ).toEqual([[at(escaped.current), 1, 1]])
          // The tombstone still holds `a%20b`'s checkpoint: a redelivery is recognised.
          const late = yield* On.Notifying.apply(removed[1]!)
          expect(late.alreadyApplied.map((e) => e.version)).toEqual([2])
        }),
      )
    }),
  )
})

describe("legacy keys, projections — outbox items and tombstones at a key two values share", () => {
  /** `a%20b`'s row and its pending effect, as 1.36 left them: under `a b`'s current key. */
  const escapedPending = (
    table: RecordingTable,
    projection: typeof On.Notifying | typeof On.Remote,
    entityType: "Tally" | "Ledger",
  ) =>
    Effect.gen(function* () {
      const opened = yield* seed(On, "escaped", [new Opened(), new Added({ amount: 2 })], 0)
      yield* projection.applyBatch(opened)
      demote(table, keysOf(On, entityType, "escaped"))
      table.take()
    })
  /** `item`s of `type` in `table`: each at its key, marked or not. */
  const placedOf = (table: RecordingTable, type: string) =>
    rowsOf(table, type)
      .map(([stored, row]) => `${stored}${row.__edd_kt__ === 1 ? " KT" : ""}`)
      .sort()
  const deliveries = () => {
    const delivered: Array<number> = []
    return {
      delivered,
      deliver: (effect: Notice) => Effect.sync(() => void delivered.push(effect.total)),
    }
  }

  // On the live clock: the write that finds another value's item in its way retries.
  it.live(
    "an outbox write never replaces another value's pending 1.36 effect at its key: it moves it first",
    () =>
      Effect.gen(function* () {
        yield* inTable(On, (table) =>
          Effect.gen(function* () {
            yield* escapedPending(table, On.Notifying, "Tally")
            const escaped = keysOf(On, "Tally", "escaped")
            const moved = keysOf(On, "Tally", "moved")
            expect(moved.current).toEqual(escaped.old)
            const events = yield* seed(On, "moved", [new Opened(), new Added({ amount: 10 })], 0)
            yield* On.Notifying.applyBatch(events)
            // Each outbox Put at a key that reads back as another value's 1.36 key requires it empty.
            const puts = table
              .take()
              .filter((r) => r.command === "TransactWriteItems")
              .flatMap((r) => r.input.TransactItems as Array<any>)
              .filter((item) => item.Put?.Item?.__edd_row_sk__?.S === moved.current.sk)
            expect(puts.length).toBeGreaterThan(0)
            for (const { Put } of puts) {
              expect(Put.ConditionExpression).toBe("attribute_not_exists(#opk)")
              expect(Put.ReturnValuesOnConditionCheckFailure).toBe("ALL_OLD")
            }
            // `a%20b`'s effect moved to its own current key, marked; `a b`'s is at its own.
            expect(placedOf(table, "Tally#outbox")).toEqual(
              [
                `${at(escaped.current)}#outbox#000000000001#0000 KT`,
                `${at(moved.current)}#outbox#000000000001#0000 KT`,
              ].sort(),
            )
            const first = deliveries()
            yield* On.Notifying.drain(ROWS.escaped!, first.deliver)
            expect(first.delivered).toEqual([2])
            const second = deliveries()
            yield* On.Notifying.drain(ROWS.moved!, second.deliver)
            expect(second.delivered).toEqual([10])
          }),
        )
      }),
  )

  it.live("so does an outbox on a table of its own", () =>
    Effect.gen(function* () {
      yield* inTable(On, (table) =>
        Effect.gen(function* () {
          yield* escapedPending(table, On.Remote, "Ledger")
          const events = yield* seed(On, "moved", [new Opened(), new Added({ amount: 10 })], 0)
          yield* On.Remote.applyBatch(events)
          expect(placedOf(table, "Ledger#outbox")).toEqual(
            [
              `${at(keysOf(On, "Ledger", "escaped").current)}#outbox#000000000001#0000 KT`,
              `${at(keysOf(On, "Ledger", "moved").current)}#outbox#000000000001#0000 KT`,
            ].sort(),
          )
          const first = deliveries()
          yield* On.Remote.drain(ROWS.escaped!, first.deliver)
          expect(first.delivered).toEqual([2])
          const second = deliveries()
          yield* On.Remote.drain(ROWS.moved!, second.deliver)
          expect(second.delivered).toEqual([10])
        }),
      )
    }),
  )

  it.live(
    "drain(key) of a value whose 1.36 key is another value's current key delivers both keys in order",
    () =>
      Effect.gen(function* () {
        for (const [projection, entityType] of [
          [On.Notifying, "Tally"],
          [On.Remote, "Ledger"],
        ] as const) {
          yield* inTable(On, (table) =>
            Effect.gen(function* () {
              yield* escapedPending(table, projection, entityType)
              const more = yield* seed(On, "escaped", [new Added({ amount: 3 })], 2)
              yield* projection.apply(more[2]!)
              // `a b`'s own item at the same key: not `a%20b`'s to deliver.
              const events = yield* seed(On, "moved", [new Opened(), new Added({ amount: 10 })], 0)
              yield* projection.applyBatch(events)
              const { delivered, deliver } = deliveries()
              yield* projection.drain(ROWS.escaped!, deliver)
              expect(delivered).toEqual([2, 5])
            }),
          )
        }
      }),
  )

  it.effect(
    "an effect-less write over a 1.36 tombstone moves it in the projection's own transaction",
    () =>
      Effect.gen(function* () {
        yield* inTable(On, (table) =>
          Effect.gen(function* () {
            const removed = yield* seed(
              On,
              "moved",
              [new Opened(), new Added({ amount: 2 }), new Closed()],
              0,
            )
            yield* On.Notifying.applyBatch(removed)
            const keys = keysOf(On, "Tally", "moved")
            demote(table, keys)
            // `Opened` enqueues no effect.
            const reopened = yield* seed(On, "moved", [new Opened()], 3)
            table.take()
            const result = yield* On.Notifying.apply(reopened[3]!)
            expect(result.applied.map((e) => e.version)).toEqual([4])
            expect(Option.getOrThrow(result.state)).toMatchObject({ total: 0, version: 4, rev: 2 })
            const writes = shape(table.take()).filter((r) => !r.startsWith("GetItem"))
            expect(writes).toEqual([
              `TransactWriteItems Put ${at(keys.current)}, Delete ${at(keys.old)}`,
            ])
            // No tombstone is left anywhere; the 1.36 effect is still delivered, once.
            expect(rowsOf(table, "Tally#tombstone")).toEqual([])
            expect(rowsOf(table, "Tally").map(([stored]) => stored)).toEqual([at(keys.current)])
            const { delivered, deliver } = deliveries()
            yield* On.Notifying.drain(ROWS.moved!, deliver)
            expect(delivered).toEqual([2])
          }),
        )
      }),
  )

  it.effect(
    "a removal-only projection over a 1.36 tombstone: the next event starts the row again, and no tombstone lands on another value's key",
    () =>
      Effect.gen(function* () {
        yield* inTable(On, (table) =>
          Effect.gen(function* () {
            const removed = yield* seed(
              On,
              "moved",
              [new Opened(), new Added({ amount: 3 }), new Closed()],
              0,
            )
            yield* On.Removing.applyBatch(removed)
            const keys = keysOf(On, "Rem", "moved")
            demote(table, keys)
            const more = yield* seed(On, "moved", [new Added({ amount: 4 })], 3)
            const result = yield* On.Removing.apply(more[3]!)
            expect(Option.getOrThrow(result.state)).toMatchObject({ total: 4, version: 4, rev: 2 })
            expect(rowsOf(table, "Rem#tombstone")).toEqual([])
            expect(rowsOf(table, "Rem").map(([stored]) => stored)).toEqual([at(keys.current)])
            // `a%20b`'s row, whose current key no tombstone took: its events apply.
            const escaped = yield* seed(On, "escaped", [new Opened(), new Added({ amount: 5 })], 0)
            const fresh = yield* On.Removing.applyBatch(escaped)
            expect(fresh.outcomes.map((o) => o._tag)).toEqual(["Applied"])
            expect(
              rowsOf(table, "Rem")
                .map(([stored, row]) => `${stored} ${row.total}`)
                .sort(),
            ).toEqual(
              [`${at(keys.current)} 4`, `${at(keysOf(On, "Rem", "escaped").current)} 5`].sort(),
            )
          }),
        )
      }),
  )

  it.effect("a removed row whose key text changed is written again over its own tombstone", () =>
    Effect.gen(function* () {
      yield* inTable(On, (table) =>
        Effect.gen(function* () {
          const events = yield* seed(
            On,
            "moved",
            [new Opened(), new Added({ amount: 1 }), new Closed(), new Added({ amount: 4 })],
            0,
          )
          yield* On.Removing.applyBatch(events.slice(0, 3))
          expect(rowsOf(table, "Rem#tombstone").map(([, row]) => row.__edd_kt__)).toEqual([1])
          const result = yield* On.Removing.apply(events[3]!)
          expect(Option.getOrThrow(result.state)).toMatchObject({ total: 4, version: 4, rev: 2 })
          expect(rowsOf(table, "Rem#tombstone")).toEqual([])
        }),
      )
    }),
  )
})

// ---------------------------------------------------------------------------
// rekey
// ---------------------------------------------------------------------------

const ZERO = { item: 0, snapshot: 0, tombstone: 0, outbox: 0, event: 0, aggregate: 0, stream: 0 }

/** `rekey` of the read model's table — or, with `outbox`, of the other table's. */
const rekey = (w: World, options?: Table.RekeyOptions & { readonly outbox?: boolean }) =>
  Effect.gen(function* () {
    const db = yield* DynamoClient.make({
      entities: { Tallies: w.Tallies, Totals: w.Totals, Sums: w.Sums, Ledgers: w.Ledgers },
      tables: { ReadTable: w.ReadTable, OutboxTable: w.OutboxTable },
    })
    const { outbox, ...rest } = options ?? {}
    return yield* (outbox ? db.tables.OutboxTable : db.tables.ReadTable).rekey({
      streams: [w.Accounts],
      ...rest,
    })
  })

describe("legacy keys, projections — rekey", () => {
  /**
   * `moved`'s row and two effects under its 1.36 key (`a b`); then `escaped`'s
   * tombstone and effect under theirs (`a%20b`) — `moved`'s current key.
   */
  const layout = (table: RecordingTable) =>
    Effect.gen(function* () {
      const moved = yield* seed(
        On,
        "moved",
        [new Opened(), new Added({ amount: 2 }), new Added({ amount: 3 })],
        0,
      )
      yield* On.Notifying.applyBatch(moved)
      demote(table, keysOf(On, "Tally", "moved"))
      const escaped = yield* seed(
        On,
        "escaped",
        [new Opened(), new Added({ amount: 4 }), new Closed()],
        0,
      )
      yield* On.Notifying.applyBatch(escaped)
      demote(table, keysOf(On, "Tally", "escaped"))
      expect(
        rowsOf(table, "Tally#outbox")
          .map(([stored]) => stored)
          .sort(),
      ).toEqual(
        [
          `${keysOf(On, "Tally", "moved").old.pk}|${keysOf(On, "Tally", "moved").old.sk}#outbox#000000000001#0000`,
          `${keysOf(On, "Tally", "moved").old.pk}|${keysOf(On, "Tally", "moved").old.sk}#outbox#000000000001#0001`,
          // At the key `moved`'s first effect moves to.
          `${keysOf(On, "Tally", "escaped").old.pk}|${keysOf(On, "Tally", "escaped").old.sk}#outbox#000000000001#0000`,
        ].sort(),
      )
      table.take()
      return { escaped }
    })

  it.effect("a dry run counts the tombstone and the outbox items, and writes nothing", () =>
    Effect.gen(function* () {
      yield* inTable(On, (table) =>
        Effect.gen(function* () {
          yield* layout(table)
          const before = new Map(table.items)
          const report = yield* rekey(On, { dryRun: true })
          expect(report.moved).toEqual({ ...ZERO, item: 1, tombstone: 1, outbox: 3 })
          expect(report.byMember.Tally?.moved).toEqual({
            ...ZERO,
            item: 1,
            tombstone: 1,
            outbox: 3,
          })
          expect(report.conflicts).toEqual([])
          expect(report.skipped.unregistered).toBe(0)
          expect(table.items).toEqual(before)
        }),
      )
    }),
  )

  it.effect("moves each to its row's current key, marked; a rerun moves nothing", () =>
    Effect.gen(function* () {
      yield* inTable(On, (table) =>
        Effect.gen(function* () {
          const { escaped } = yield* layout(table)
          const report = yield* rekey(On)
          expect(report.moved).toEqual({ ...ZERO, item: 1, tombstone: 1, outbox: 3 })
          expect(report.conflicts).toEqual([])
          const moved = keysOf(On, "Tally", "moved").current
          const gone = keysOf(On, "Tally", "escaped").current
          expect(rowsOf(table, "Tally").map(([stored]) => stored)).toEqual([at(moved)])
          expect(
            rowsOf(table, "Tally#tombstone").map(([stored, row]) => [stored, row.__edd_kt__]),
          ).toEqual([[at(gone), 1]])
          // Each outbox item names its row's current key, and so does the sparse index.
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
                return [`${pk}|${sk}#outbox#${n}`, pk, sk, `${pk}#${sk}#outbox#${n}`, 1]
              })
              .sort(),
          )
          const again = yield* rekey(On)
          expect(again.moved).toEqual(ZERO)
          expect(again.conflicts).toEqual([])
          // In one order per row; `a%20b`'s tombstone still recognises a redelivery.
          const delivered: Array<number> = []
          const swept = yield* On.Notifying.drainPending((effect) =>
            Effect.sync(() => void delivered.push(effect.total)),
          )
          expect(swept.delivered).toBe(3)
          expect(delivered).toEqual([2, 5, 4])
          const late = yield* On.Notifying.apply(escaped[1]!)
          expect(late.alreadyApplied.map((e) => e.version)).toEqual([2])
        }),
      )
    }),
  )

  it.effect("an outbox item a drainer holds is left, a conflict until it is delivered", () =>
    Effect.gen(function* () {
      yield* inTable(On, (table) =>
        Effect.gen(function* () {
          yield* layout(table)
          const old = keysOf(On, "Tally", "moved").old
          const claimed = `${old.pk}|${old.sk}#outbox#000000000001#0000`
          const until = Date.now() + 60_000
          table.items.set(claimed, {
            ...table.items.get(claimed)!,
            ...toAttributeMap({ __edd_claim__: "drainer-1", __edd_claimed_until__: until }),
          })
          const report = yield* rekey(On)
          expect(report.moved).toEqual({ ...ZERO, item: 1, tombstone: 1, outbox: 2 })
          expect(report.conflicts.map((c) => [c.kind, c.reason, c.message])).toEqual([
            ["outbox", "contended", "A drainer holds it."],
          ])
          expect(rowsOf(table, "Tally#outbox").map(([stored]) => stored)).toContain(claimed)
        }),
      )
    }),
  )

  it.effect("a claim taken between rekey's read and its move cancels the move", () =>
    Effect.gen(function* () {
      const table = makeRecordingTable({ indexes: { outbox: { pk: "obpk", sk: "obsk" } } })
      let injected: string | undefined
      // A drainer claims the item as the move is sent: after rekey read it unclaimed.
      const Racing = Layer.effect(
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
      yield* Effect.gen(function* () {
        yield* layout(table)
        const report = yield* rekey(On)
        expect(injected).toBeDefined()
        // Not moved: the claim holds where the drainer took it.
        expect(table.items.get(injected!)?.__edd_claim__).toEqual({ S: "drainer-1" })
        expect(report.conflicts.map((c) => [c.kind, c.reason])).toEqual([["outbox", "contended"]])
        expect(
          rowsOf(table, "Tally#outbox").filter(([, row]) => row.__edd_claim__ !== undefined),
        ).toHaveLength(1)
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Racing,
            On.EventsTable.layer({ name: "t" }),
            On.ReadTable.layer({ name: "t" }),
            On.OutboxTable.layer({ name: "o" }),
          ),
        ),
      )
    }),
  )

  it.effect(
    "a tombstone whose current key holds another value's 1.36 row moves that row first, one at a time",
    () =>
      Effect.gen(function* () {
        yield* inTable(On, (table) =>
          Effect.gen(function* () {
            // `a b` removed and `a%20b` live, both as 1.36 left them: `a%20b`'s row at `a b`'s key.
            yield* On.Notifying.applyBatch(
              yield* seed(On, "moved", [new Opened(), new Added({ amount: 2 }), new Closed()], 0),
            )
            demote(table, keysOf(On, "Tally", "moved"))
            yield* On.Notifying.applyBatch(
              yield* seed(On, "escaped", [new Opened(), new Added({ amount: 4 })], 0),
            )
            demote(table, keysOf(On, "Tally", "escaped"))
            const report = yield* rekey(On, { concurrency: 1 })
            expect(report.moved).toEqual({ ...ZERO, item: 1, tombstone: 1, outbox: 2 })
            expect(report.skipped.unrecognizedKey).toBe(0)
            expect(report.conflicts).toEqual([])
            expect(rowsOf(table, "Tally").map(([stored]) => stored)).toEqual([
              at(keysOf(On, "Tally", "escaped").current),
            ])
            expect(rowsOf(table, "Tally#tombstone").map(([stored]) => stored)).toEqual([
              at(keysOf(On, "Tally", "moved").current),
            ])
          }),
        )
      }),
  )

  it.effect("rows 1.37 wrote are left alone, though their key is another value's 1.36 key", () =>
    Effect.gen(function* () {
      yield* inTable(On, (table) =>
        Effect.gen(function* () {
          const events = yield* seed(
            On,
            "moved",
            [new Opened(), new Added({ amount: 2 }), new Closed()],
            0,
          )
          yield* On.Notifying.applyBatch(events)
          const before = new Map(table.items)
          const report = yield* rekey(On)
          expect(report.moved).toEqual(ZERO)
          expect(report.byMember.Tally?.unchanged).toBe(2)
          expect(table.items).toEqual(before)
        }),
      )
    }),
  )

  it.effect("an outbox on another table moves with that table's rekey", () =>
    Effect.gen(function* () {
      yield* inTable(On, (table) =>
        Effect.gen(function* () {
          const events = yield* seed(On, "moved", [new Opened(), new Added({ amount: 2 })], 0)
          yield* On.Remote.applyBatch(events)
          const keys = keysOf(On, "Ledger", "moved")
          demote(table, keys)
          const item = `${keys.current.pk}|${keys.current.sk}#outbox#000000000001#0000`
          expect(rowsOf(table, "Ledger#outbox").map(([stored]) => stored)).toEqual([
            `${keys.old.pk}|${keys.old.sk}#outbox#000000000001#0000`,
          ])
          table.take()
          const report = yield* rekey(On, { outbox: true })
          expect(report.byMember.Ledger?.moved).toEqual({ ...ZERO, outbox: 1 })
          const sent = table.take().filter((r) => r.command === "TransactWriteItems")
          expect(sent.map((r) => (r.input.TransactItems as Array<any>)[0].Put.TableName)).toEqual([
            "o",
          ])
          expect(rowsOf(table, "Ledger#outbox").map(([stored]) => stored)).toEqual([item])
          // The read model's own table: its row moves; the outbox item isn't its to move.
          const own = yield* rekey(On)
          expect(own.byMember.Ledger?.moved).toEqual({ ...ZERO, item: 1 })
          const delivered: Array<number> = []
          yield* On.Remote.drain(ROWS.moved!, (effect) =>
            Effect.sync(() => void delivered.push(effect.total)),
          )
          expect(delivered).toEqual([2])
        }),
      )
    }),
  )
})
