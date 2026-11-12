/**
 * The outbox items of one read model (#237). Each carries its mark: the read model's tag, then a
 * hash of its projection and its event (`outboxMark`). An item's `Put` replaces only the item of
 * the same effect, a redelivery or retry; any other item at its key keeps its place and the new
 * one is written beside it, at its key followed by its mark. Two projections of one read model
 * with their own revisions write at one revision in the ordinary course; 1.40.0's second `Put`
 * replaced the first, whose effect was never delivered. Draining stays per read model and in key
 * order, so both are delivered, the first's first.
 *
 * An item without a mark (written before 1.41.0) of the same event is replaced, as on 1.40.0,
 * where nothing else can have written at its key: no other read model's keys can be its own
 * (`outboxKeysApart`) and no other projection of it writes outbox items. Anywhere else it is
 * kept, and the new item written beside it.
 */

import { describe, expect, it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Effect, Exit, Layer, Schema } from "effect"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
import { outboxKeysApart } from "../src/internal/ProjectionEngine.js"
import * as Table from "../src/Table.js"
import { markOf, tagOf } from "./helpers/OutboxMarks.js"
import { makeRoutedTables } from "./helpers/RoutedTables.js"

class Placed extends Schema.TaggedClass<Placed>()("Placed", { amount: Schema.Number }) {}

const EventsTable = Table.make({
  schema: DynamoSchema.make({ name: "solo", version: 1 }),
  entities: {},
})
const Orders = EventStore.makeStream({
  table: EventsTable,
  streamName: "Order",
  events: [Placed],
  streamId: { composite: ["id"] },
})
const index = { name: "outbox", pk: "obpk", sk: "obsk" } as const
/** The row every event folds into: its sort key holds `#`, which escaping spells `%23`. */
const KEY = { shop: "north", name: "a#b" } as const

type Row = { readonly total: number; readonly count?: number }

/**
 * One `Ledger` read model with `projections` projections, each with its own checkpoint and
 * revision and an outbox (on a table of its own, or `local`, under the row's partition): the
 * first adds each event's amount to `total` (an amount of 0 removes the row, with `removal`), the
 * second to `count`, and their effects are `total` and `1000 + count` (-1 and -1001 for a
 * removal). `multi`: multi-source projections.
 */
const one = (
  options: {
    readonly escapeKeys?: boolean
    readonly projections?: 1 | 2
    readonly multi?: boolean
    readonly removal?: boolean
    readonly local?: boolean
    readonly routed?: ReturnType<typeof makeRoutedTables>
  } = {},
) => {
  const schema = DynamoSchema.make({
    name: "solo",
    version: 1,
    escapeKeys: options.escapeKeys ?? false,
  })
  const Outbox = Table.make({ schema, entities: {} })
  const Ledgers = Entity.make({
    model: Schema.Struct({
      shop: Schema.String,
      name: Schema.String,
      total: Schema.Number,
      count: Schema.optional(Schema.Number),
      cp: Schema.optional(Schema.Number),
      rev: Schema.optional(Schema.Number),
      cp2: Schema.optional(Schema.Number),
      rev2: Schema.optional(Schema.Number),
      cpm: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
      cpm2: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
    }),
    entityType: "Ledger",
    primaryKey: {
      pk: { field: "pk", composite: ["shop"] },
      sk: { field: "sk", composite: ["name"] },
    },
  })
  const ReadTable = Table.make({ schema, entities: { Ledgers } })
  const projections = Array.from({ length: options.projections ?? 1 }, (_, i) => {
    const evolve = (state: any, event: any) =>
      Effect.succeed(
        i === 0
          ? options.removal === true && event.data.amount === 0
            ? EventStore.removeRow
            : { ...state, total: state.total + event.data.amount }
          : { ...state, count: (state.count ?? 0) + event.data.amount },
      )
    const outbox = {
      schema: Schema.Struct({ total: Schema.Number }),
      effects: (_event: unknown, next: Row | undefined) => [
        { total: i === 0 ? (next?.total ?? -1) : 1000 + (next?.count ?? -1) },
      ],
      index,
      ...(options.local === true ? {} : { table: Outbox }),
    }
    const initial = () => ({ ...KEY, total: 0 })
    return options.multi === true
      ? (EventStore.multiProjection({
          readModel: Ledgers,
          initial,
          sources: (source: any) => ({ orders: source(Orders, { key: () => KEY, evolve }) }),
          checkpoints: { field: i === 0 ? "cpm" : "cpm2" },
          revision: { field: i === 0 ? "rev" : "rev2" },
          ...(options.removal === true && i === 0 && { removal: {} }),
          outbox,
        } as any) as any)
      : (EventStore.projection({
          stream: Orders,
          readModel: Ledgers,
          key: () => KEY,
          initial,
          evolve,
          checkpoint: i === 0 ? "cp" : "cp2",
          revision: i === 0 ? "rev" : "rev2",
          ...(options.removal === true && i === 0 && { removal: {} }),
          outbox,
        } as any) as any)
  })
  const routed =
    options.routed ??
    makeRoutedTables({ indexes: { outbox: { pk: index.pk, sk: index.sk } } }, "events")
  const itemsTable = options.local === true ? "read" : "outbox"
  const layer = Layer.mergeAll(
    Layer.succeed(DynamoClient, routed.client as any),
    EventsTable.layer({ name: "events" }),
    Outbox.layer({ name: "outbox" }),
    ReadTable.layer({ name: "read" }),
  )
  const client = DynamoClient.make({ entities: { Ledgers }, tables: { Outbox, ReadTable } })
  /** `id`'s events, appended. */
  const events = (id: string, amounts: ReadonlyArray<number> = [2, 3]) =>
    Effect.gen(function* () {
      yield* client
      yield* Orders.append(
        { id },
        amounts.map((amount) => new Placed({ amount })),
        0,
      )
      return yield* Orders.read({ id })
    })
  /** Projection `i` applies `events`, one at a time. */
  const apply = (i: number, events: ReadonlyArray<unknown>) =>
    Effect.forEach(
      events,
      (event) =>
        (options.multi === true
          ? projections[i]!.applyBatch([{ stream: "orders", event }])
          : projections[i]!.apply(event)) as Effect.Effect<unknown>,
      { discard: true },
    )
  const outboxItems = () =>
    [...routed.table(itemsTable).items.values()].filter(
      (item) => item.__edd_e__?.S === "Ledger#outbox",
    )
  /** The row lost: deleted outside the projections. */
  const loseRow = () => {
    const rows = routed.table("read").items
    for (const [key, item] of [...rows]) if (item.__edd_e__?.S === "Ledger") rows.delete(key)
  }
  /** Each item as 1.40.0 wrote it: no mark. */
  const unmark = () => {
    for (const item of outboxItems()) delete item.__edd_rm__
  }
  /**
   * The items, each as the text after `#outbox#` (a mark in it as `<mark>`) and the projection
   * whose mark it carries (`undefined`: none); each beside another is at its key followed by it.
   */
  const layout = () =>
    outboxItems()
      .map((item) => {
        const mark = item.__edd_rm__?.S
        const owner =
          mark === undefined
            ? undefined
            : projections.findIndex((_, i) => markOf(Ledgers, item, i) === mark)
        if (mark !== undefined) expect(owner).toBeGreaterThanOrEqual(0)
        const at = item.sk!.S!.split("#outbox#")[1]!
        return [mark === undefined ? at : at.replace(`#${mark}`, "#<mark>"), owner] as const
      })
      .sort(([x], [y]) => (x < y ? -1 : 1))
  /** The outbox `Put`s of the transactions sent since the last call, by transaction. */
  const sentPuts = () =>
    routed
      .take()
      .filter((request) => request.command === "TransactWriteItems")
      .map((request) =>
        (request.input.TransactItems as ReadonlyArray<{ readonly Put?: any }>).flatMap((entry) =>
          entry.Put?.Item?.__edd_e__?.S === "Ledger#outbox" ? [entry.Put] : [],
        ),
      )
  /** What the first projection's drainer delivers: `drainPending`, `drain`, or after a write. */
  const drained = (how: "drainPending" | "drain" = "drainPending") =>
    Effect.gen(function* () {
      const seen: Array<number> = []
      const deliver = (effect: { readonly total: number }) =>
        Effect.sync(() => void seen.push(effect.total))
      const result =
        how === "drainPending"
          ? yield* projections[0]!.drainPending(deliver)
          : yield* projections[0]!.drain(KEY, deliver)
      return { delivered: result.delivered as number, seen }
    })
  return {
    Ledgers,
    Outbox,
    ReadTable,
    projections,
    routed,
    layer,
    client,
    events,
    apply,
    outboxItems,
    loseRow,
    unmark,
    layout,
    sentPuts,
    drained,
  }
}
type One = ReturnType<typeof one>

const AT = "000000000001#0000"
const AT2 = "000000000002#0000"
const PLAIN = "attribute_not_exists(#pk) OR #rm = :rm"
const SAME_EVENT =
  "attribute_not_exists(#pk) OR #rm = :rm OR " +
  "(attribute_not_exists(#rm) AND #es = :es AND #ei = :ei AND #ev = :ev)"
const run = <A>(w: One, effect: Effect.Effect<A, unknown, any>) =>
  effect.pipe(Effect.provide(w.layer)) as Effect.Effect<A, unknown>

describe("two projections of one read model at one revision", () => {
  for (const escapeKeys of [false, true]) {
    for (const local of [false, true]) {
      const where = `escapeKeys ${escapeKeys ? "on" : "off"}, outbox ${local ? "local" : "remote"}`
      it.effect(`the second's item beside the first's, both delivered in order (${where})`, () => {
        const w = one({ escapeKeys, local, projections: 2 })
        return run(
          w,
          Effect.gen(function* () {
            const events = yield* w.events(`two-${escapeKeys}-${local}`)
            yield* w.apply(0, events)
            w.routed.take()
            yield* w.apply(1, events)
            // Per event: the plain Put cancelled at the first's item, then the item beside it.
            const sent = w.sentPuts()
            expect(sent).toHaveLength(4)
            for (const [n, puts] of sent.entries()) {
              expect(puts).toHaveLength(1)
              const put = puts[0]
              const mark = markOf(w.Ledgers, put.Item, 1)
              expect(mark.startsWith(`${tagOf(w.Ledgers)}.`)).toBe(true)
              expect(put.Item.__edd_rm__).toEqual({ S: mark })
              expect(put.ConditionExpression).toBe(PLAIN)
              expect(put.ExpressionAttributeValues).toEqual({ ":rm": { S: mark } })
              const at = n < 2 ? AT : AT2
              if (n % 2 === 0) {
                expect(put.Item.sk.S.endsWith(`#outbox#${at}`)).toBe(true)
                expect(put.ReturnValuesOnConditionCheckFailure).toBeUndefined()
              } else {
                expect(put.Item.sk.S.endsWith(`#outbox#${at}#${mark}`)).toBe(true)
                expect(put.ReturnValuesOnConditionCheckFailure).toBe("ALL_OLD")
              }
            }
            expect(w.layout()).toEqual([
              [AT, 0],
              [`${AT}#<mark>`, 1],
              [AT2, 0],
              [`${AT2}#<mark>`, 1],
            ])
            expect(yield* w.drained()).toEqual({ delivered: 4, seen: [2, 1002, 5, 1005] })
            expect(w.outboxItems()).toEqual([])
          }),
        )
      })
    }
  }

  it.effect("drain by row delivers both, in order", () => {
    const w = one({ projections: 2 })
    return run(
      w,
      Effect.gen(function* () {
        const events = yield* w.events("by-row")
        yield* w.apply(0, events)
        yield* w.apply(1, events)
        expect(yield* w.drained("drain")).toEqual({ delivered: 4, seen: [2, 1002, 5, 1005] })
      }),
    )
  })

  it.effect("a write's own deliver delivers what is pending at its row, in key order", () => {
    const w = one({ projections: 2 })
    return run(
      w,
      Effect.gen(function* () {
        const events = yield* w.events("deliver")
        yield* w.apply(0, events)
        const seen: Array<number> = []
        const applied = yield* w.projections[1]!.applyBatch(events, {
          deliver: (effect: { readonly total: number }) =>
            Effect.sync(() => void seen.push(effect.total)),
        })
        expect(applied.undelivered ?? []).toEqual([])
        // The batch is one write at the second's revision 1, its effects at positions 0 (beside
        // the first's) and 1: the row's items in key order.
        expect(seen).toEqual([2, 1002, 1005, 5])
        expect(w.outboxItems()).toEqual([])
      }),
    )
  })

  it.effect("multi-source projections: the second's beside the first's", () => {
    const w = one({ projections: 2, multi: true })
    return run(
      w,
      Effect.gen(function* () {
        const events = yield* w.events("multi")
        yield* w.apply(0, events)
        yield* w.apply(1, events)
        expect(w.layout()).toEqual([
          [AT, 0],
          [`${AT}#<mark>`, 1],
          [AT2, 0],
          [`${AT2}#<mark>`, 1],
        ])
        expect(yield* w.drained()).toEqual({ delivered: 4, seen: [2, 1002, 5, 1005] })
      }),
    )
  })

  it.effect("the first removing the row: each item where it belongs, every one delivered", () => {
    // The first folds 2 then 0, which removes its row (a tombstone at revision 2, with its item);
    // the second folds the same events at its own revisions.
    const w = one({ projections: 2, removal: true })
    return run(
      w,
      Effect.gen(function* () {
        const events = yield* w.events("removal", [2, 0])
        yield* w.apply(0, events)
        yield* w.apply(1, events)
        const layout = w.layout()
        // Nothing replaced: the first's two items and each of the second's.
        expect(layout.filter(([, owner]) => owner === 0).map(([at]) => at)).toEqual([AT, AT2])
        expect(layout.filter(([, owner]) => owner === 1)).toHaveLength(2)
        const { seen } = yield* w.drained()
        expect(seen.filter((total) => total < 1000 && total > -1000)).toEqual([2, -1])
        expect(seen.filter((total) => total >= 1000 || total <= -1000)).toHaveLength(2)
        expect(w.outboxItems()).toEqual([])
      }),
    )
  })

  it.effect("a redelivery of one's effect replaces its own item, in one transaction", () => {
    // The row lost and the stream applied again: the same effect at the same key.
    const w = one({ projections: 2 })
    return run(
      w,
      Effect.gen(function* () {
        const events = yield* w.events("again")
        yield* w.apply(0, events.slice(0, 1))
        w.loseRow()
        w.routed.take()
        yield* w.apply(0, events.slice(0, 1))
        expect(w.sentPuts()).toHaveLength(1)
        expect(w.layout()).toEqual([[AT, 0]])
        expect(yield* w.drained()).toEqual({ delivered: 1, seen: [2] })
      }),
    )
  })

  it.effect("an item without a mark is never replaced: it may be the other's", () => {
    // 1.40.0's: the second projection's item, pending at revision 1. The first's item for the same
    // event goes beside it, and neither effect is lost.
    const w = one({ projections: 2 })
    return run(
      w,
      Effect.gen(function* () {
        expect(outboxKeysApart(w.Ledgers)).toBe(true)
        const events = yield* w.events("unmarked-other")
        yield* w.apply(1, events.slice(0, 1))
        w.unmark()
        w.routed.take()
        yield* w.apply(0, events.slice(0, 1))
        const sent = w.sentPuts()
        expect(sent.map((puts) => puts[0].ConditionExpression)).toEqual([PLAIN, PLAIN])
        expect(w.layout()).toEqual([
          [AT, undefined],
          [`${AT}#<mark>`, 0],
        ])
        expect(yield* w.drained()).toEqual({ delivered: 2, seen: [1002, 2] })
      }),
    )
  })

  it.effect("its own item without a mark, rewritten after its row is lost: delivered twice", () => {
    // Where it can be the other projection's, it is kept (above): the same effect again is the
    // documented duplicate.
    const w = one({ projections: 2 })
    return run(
      w,
      Effect.gen(function* () {
        const events = yield* w.events("unmarked-own")
        yield* w.apply(0, events.slice(0, 1))
        w.unmark()
        w.loseRow()
        yield* w.apply(0, events.slice(0, 1))
        expect(w.layout()).toEqual([
          [AT, undefined],
          [`${AT}#<mark>`, 0],
        ])
        expect(yield* w.drained()).toEqual({ delivered: 2, seen: [2, 2] })
      }),
    )
  })

  it.effect(
    "a write killed between its attempts leaves nothing, and is written whole again",
    () => {
      const w = one({ projections: 2 })
      return run(
        w,
        Effect.gen(function* () {
          const events = yield* w.events("killed")
          yield* w.apply(0, events.slice(0, 1))
          const before = new Map([...w.routed.snapshot()].filter(([name]) => name !== "events"))
          // The process dies after the first transaction is cancelled, before the second is sent.
          let sends = 0
          const dying = new Proxy(w.routed.client as Record<string, any>, {
            get: (target, operation) =>
              operation === "transactWriteItems"
                ? (input: unknown) =>
                    ++sends === 2 ? Effect.die("killed") : target.transactWriteItems(input)
                : target[operation as string],
          })
          const killed = yield* Effect.exit(
            w.apply(1, events.slice(0, 1)).pipe(Effect.provideService(DynamoClient, dying as any)),
          )
          expect(Exit.isFailure(killed)).toBe(true)
          expect(sends).toBe(2)
          // The first transaction was cancelled whole: not the row, not an item.
          expect(new Map([...w.routed.snapshot()].filter(([name]) => name !== "events"))).toEqual(
            before,
          )
          // Run again, it is written: the second's item beside the first's.
          yield* w.apply(1, events.slice(0, 1))
          expect(w.layout()).toEqual([
            [AT, 0],
            [`${AT}#<mark>`, 1],
          ])
          expect(yield* w.drained()).toEqual({ delivered: 2, seen: [2, 1002] })
        }),
      )
    },
  )

  for (const escapeKeys of [false, true]) {
    it.effect(
      `the key beside held too: EDD-9145, nothing written (escapeKeys ${escapeKeys})`,
      () => {
        const w = one({ projections: 2, escapeKeys })
        return run(
          w,
          Effect.gen(function* () {
            const events = yield* w.events(`held-${escapeKeys}`)
            yield* w.apply(0, events.slice(0, 1))
            const [plain] = w.outboxItems()
            const mark = markOf(w.Ledgers, plain!, 1)
            const beside = `${plain!.sk!.S}#${mark}`
            w.routed.table("outbox").items.set(`${plain!.pk!.S}|${beside}`, {
              ...plain!,
              sk: { S: beside },
              obsk: { S: `${plain!.pk!.S}#${beside}` },
              __edd_rm__: { S: "zzz.0" },
            })
            const before = w.routed.snapshot()
            for (const attempt of [1, 2]) {
              const failed = (yield* Effect.flip(w.apply(1, events.slice(0, 1)))) as {
                readonly _tag: string
                readonly cause: Error
              }
              expect(failed._tag).toBe("ValidationError")
              const message = failed.cause.message
              expect(message).toContain("[EDD-9145]")
              expect(message).toContain(JSON.stringify(tagOf(w.Ledgers)))
              expect(message).toContain(`(${JSON.stringify(mark)})`)
              expect(message).toContain(JSON.stringify(beside))
              expect(message).toContain('an item of "Ledger#outbox" marked "zzz.0"')
              expect(message).toContain("Nothing was written")
              expect(failed.cause.cause).toHaveProperty("_tag", "DynamoError")
              // Refused again on a retry, and nothing written either time.
              expect(w.routed.snapshot()).toEqual(before)
              expect(attempt).toBeGreaterThan(0)
            }
          }),
        )
      },
    )
  }
})

describe("one projection: an item without a mark at its key", () => {
  for (const escapeKeys of [false, true]) {
    it.effect(
      `of the same event: replaced, as on 1.40.0, delivered once (escapeKeys ${escapeKeys})`,
      () => {
        const w = one({ escapeKeys })
        return run(
          w,
          Effect.gen(function* () {
            expect(outboxKeysApart(w.Ledgers)).toBe(true)
            const events = yield* w.events(`same-${escapeKeys}`)
            yield* w.apply(0, events.slice(0, 1))
            w.unmark()
            w.loseRow()
            w.routed.take()
            yield* w.apply(0, events.slice(0, 1))
            // The plain Put cancelled at the unmarked item, then the same event's replaces it.
            const sent = w.sentPuts()
            expect(sent.map((puts) => puts[0].ConditionExpression)).toEqual([PLAIN, SAME_EVENT])
            const put = sent[1]![0]
            expect(put.ExpressionAttributeNames).toEqual({
              "#pk": "pk",
              "#rm": "__edd_rm__",
              "#es": "source",
              "#ei": "streamId",
              "#ev": "version",
            })
            expect(put.ExpressionAttributeValues).toEqual({
              ":rm": put.Item.__edd_rm__,
              ":es": { S: "projection" },
              ":ei": { S: `same-${escapeKeys}` },
              ":ev": { N: "1" },
            })
            expect(put.ReturnValuesOnConditionCheckFailure).toBeUndefined()
            expect(w.layout()).toEqual([[AT, 0]])
            expect(yield* w.drained()).toEqual({ delivered: 1, seen: [2] })
          }),
        )
      },
    )
  }

  it.effect("of another event: kept, and the new one beside it", () => {
    // Two streams fold into the row; it is lost with the first's item pending, and the second's
    // event then writes at revision 1 again.
    const w = one()
    return run(
      w,
      Effect.gen(function* () {
        const first = yield* w.events("first", [2])
        const second = yield* w.events("second", [7])
        yield* w.apply(0, first)
        w.unmark()
        w.loseRow()
        w.routed.take()
        yield* w.apply(0, second)
        const sent = w.sentPuts()
        expect(sent.map((puts) => puts[0].ConditionExpression)).toEqual([PLAIN, SAME_EVENT, PLAIN])
        expect(sent[2]![0].ReturnValuesOnConditionCheckFailure).toBe("ALL_OLD")
        expect(w.layout()).toEqual([
          [AT, undefined],
          [`${AT}#<mark>`, 0],
        ])
        expect(yield* w.drained()).toEqual({ delivered: 2, seen: [2, 7] })
      }),
    )
  })

  it.effect("its own marked item of another event: kept, and the new one beside it", () => {
    const w = one()
    return run(
      w,
      Effect.gen(function* () {
        const first = yield* w.events("first-marked", [2])
        const second = yield* w.events("second-marked", [7])
        yield* w.apply(0, first)
        w.loseRow()
        w.routed.take()
        yield* w.apply(0, second)
        expect(w.sentPuts().map((puts) => puts[0].ConditionExpression)).toEqual([
          PLAIN,
          SAME_EVENT,
          PLAIN,
        ])
        expect(w.layout()).toEqual([
          [AT, 0],
          [`${AT}#<mark>`, 0],
        ])
        expect(yield* w.drained()).toEqual({ delivered: 2, seen: [2, 7] })
      }),
    )
  })

  it.effect("no item at its key: the one transaction this release sent before", () => {
    const w = one()
    return run(
      w,
      Effect.gen(function* () {
        const events = yield* w.events("plain")
        w.routed.take()
        yield* w.apply(0, events)
        const sent = w.sentPuts()
        expect(sent).toHaveLength(2)
        for (const [puts] of sent) {
          expect(puts.ConditionExpression).toBe(PLAIN)
          expect(puts.ExpressionAttributeNames).toEqual({ "#pk": "pk", "#rm": "__edd_rm__" })
          expect(puts.ExpressionAttributeValues).toEqual({
            ":rm": { S: markOf(w.Ledgers, puts.Item) },
          })
          expect(puts.ReturnValuesOnConditionCheckFailure).toBeUndefined()
        }
      }),
    )
  })
})

describe("rekey moves a read model's items beside each other's by their own", () => {
  for (const local of [false, true]) {
    it.effect(
      `two projections' items, plain and beside (outbox ${local ? "local" : "remote"})`,
      () => {
        // Written with escaping off; `rekey` under escaping on moves the row and each item to the
        // row's escaped sort key, keeping what follows it (the revision, and the mark beside).
        const routed = makeRoutedTables(
          { indexes: { outbox: { pk: index.pk, sk: index.sk } } },
          "events",
        )
        const written = one({ projections: 2, local, routed })
        const now = one({ projections: 2, local, routed, escapeKeys: true })
        return Effect.gen(function* () {
          const events = yield* written.events(`rekey-${local}`)
          yield* written.apply(0, events)
          yield* written.apply(1, events)
          const before = written.layout()
          expect(before).toEqual([
            [AT, 0],
            [`${AT}#<mark>`, 1],
            [AT2, 0],
            [`${AT2}#<mark>`, 1],
          ])
          const db = (yield* DynamoClient.make({
            entities: { Ledgers: now.Ledgers },
            tables: { Outbox: now.Outbox, ReadTable: now.ReadTable },
          })) as any
          const report = yield* db.tables.ReadTable.rekey({ streams: [Orders] })
          const moved = local
            ? report
            : { ...report, outbox: (yield* db.tables.Outbox.rekey({ streams: [Orders] })) as any }
          expect(local ? moved.moved.outbox : moved.outbox.moved.outbox).toBe(4)
          const items = now.outboxItems()
          expect(items).toHaveLength(4)
          for (const item of items) expect(item.sk!.S).toContain("name_a%23b#outbox#")
          expect(now.layout()).toEqual(before)
          // A second run moves nothing, and the read model's drainer delivers each, in order.
          const again = yield* (local ? db.tables.ReadTable : db.tables.Outbox).rekey({
            streams: [Orders],
          })
          expect(again.moved.outbox).toBe(0)
          expect(yield* now.drained()).toEqual({ delivered: 4, seen: [2, 1002, 5, 1005] })
        }).pipe(Effect.provide(Layer.merge(written.layer, now.layer))) as Effect.Effect<
          void,
          unknown
        >
      },
    )
  }
})
