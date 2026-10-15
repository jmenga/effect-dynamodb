/**
 * Projection rows beyond 1.28.0: `revision` (#153), tombstones (`removal`,
 * #154) and the outbox (#155), on single-source projections — against the
 * in-memory tables in `helpers/InMemoryTables.ts`.
 */

import { describe, expect, it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { ConcurrentModification, ValidationError } from "@effect-dynamodb/schema/Errors.js"
import { Effect, Fiber, Layer, Option, Schema } from "effect"
import { TestClock } from "effect/testing"
import { beforeEach } from "vitest"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
import { fromAttributeMap } from "../src/Marshaller.js"
import * as Table from "../src/Table.js"
import {
  calls,
  InMemoryClient,
  type Item,
  rejection,
  resetCalls,
  resetStore,
  store,
} from "./helpers/InMemoryTables.js"

const AppSchema = DynamoSchema.make({ name: "rows", version: 1 })

class Placed extends Schema.TaggedClass<Placed>()("Placed", { amount: Schema.Number }) {}
class Added extends Schema.TaggedClass<Added>()("Added", { amount: Schema.Number }) {}
class Cancelled extends Schema.TaggedClass<Cancelled>()("Cancelled", {}) {}
type OrderEvent = Placed | Added | Cancelled

const EventsTable = Table.make({ schema: AppSchema, entities: {} })
const Orders = EventStore.makeStream({
  table: EventsTable,
  streamName: "Order",
  events: [Placed, Added, Cancelled],
  streamId: { composite: ["orderId"] },
})

const Summary = Schema.Struct({
  orderId: Schema.String,
  total: Schema.Number,
  version: Schema.Number,
  rev: Schema.Number,
})
type Summary = typeof Summary.Type

const Summaries = Entity.make({
  model: Summary,
  entityType: "Summary",
  primaryKey: {
    pk: { field: "pk", composite: ["orderId"] },
    sk: { field: "sk", composite: [] },
  },
  timestamps: true,
})

const UniqueSummaries = Entity.make({
  model: Summary,
  entityType: "UniqueSummary",
  primaryKey: {
    pk: { field: "pk", composite: ["orderId"] },
    sk: { field: "sk", composite: [] },
  },
  unique: { byTotal: ["total"] },
})

const ReadTable = Table.make({ schema: AppSchema, entities: { Summaries, UniqueSummaries } })
const OutboxTable = Table.make({ schema: AppSchema, entities: {} })

const Notice = Schema.Struct({ orderId: Schema.String, kind: Schema.String, total: Schema.Number })
type Notice = typeof Notice.Type

const evolve = (state: Summary, event: EventStore.StreamEvent<OrderEvent>) =>
  Effect.succeed(
    event.data._tag === "Cancelled"
      ? EventStore.removeRow
      : { ...state, total: state.total + event.data.amount },
  )

const base = {
  stream: Orders,
  readModel: Summaries,
  key: (id: { readonly orderId: string }) => ({ orderId: id.orderId }),
  initial: (id: { readonly orderId: string }): Summary => ({
    orderId: id.orderId,
    total: 0,
    version: 0,
    rev: 0,
  }),
  evolve,
  checkpoint: "version" as const,
}

const Revisioned = EventStore.projection({ ...base, revision: "rev" })
const Removable = EventStore.projection({ ...base, revision: "rev", removal: {} })
const Notifying = EventStore.projection({
  ...base,
  revision: "rev",
  removal: { ttl: "7 days" },
  outbox: {
    schema: Notice,
    effects: (event, next) =>
      event.data._tag === "Added" || event.data._tag === "Cancelled"
        ? [{ orderId: event.streamId, kind: event.data._tag, total: next?.total ?? -1 }]
        : [],
  },
})
const NotifyingElsewhere = EventStore.projection({
  ...base,
  revision: "rev",
  outbox: {
    schema: Notice,
    effects: (event) => [{ orderId: event.streamId, kind: event.eventType, total: 0 }],
    table: OutboxTable,
    index: { name: "outbox", pk: "obpk", sk: "obsk" },
  },
})

const TestLayer = Layer.mergeAll(
  InMemoryClient,
  EventsTable.layer({ name: "events" }),
  ReadTable.layer({ name: "read" }),
  OutboxTable.layer({ name: "outbox" }),
)

beforeEach(() => resetStore())

const seed = (orderId: string, events: ReadonlyArray<OrderEvent>) =>
  Effect.gen(function* () {
    yield* Orders.append({ orderId }, events, 0)
    const read = yield* Orders.read({ orderId })
    resetCalls()
    return read
  })

const items = (table: string, marker?: string) =>
  [...store.entries()]
    .filter(([k]) => k.startsWith(`${table}|`))
    .map(([, item]) => fromAttributeMap(item) as Record<string, unknown>)
    .filter((item) => marker === undefined || item.__edd_e__ === marker)

const rowOf = (orderId: string) =>
  items("read").find((item) => item.__edd_e__ !== undefined && String(item.pk).endsWith(orderId))

describe("projection revision", () => {
  it.effect("increments the revision on every write and conditions on it", () =>
    Effect.gen(function* () {
      const events = yield* seed("o1", [new Placed({ amount: 1 }), new Added({ amount: 2 })])
      yield* Revisioned.apply(events[0]!)
      expect(rowOf("o1")).toMatchObject({ rev: 1, version: 1 })
      yield* Revisioned.apply(events[1]!)
      expect(rowOf("o1")).toMatchObject({ rev: 2, version: 2, total: 3 })
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("a rebuild at the head still moves the revision, so a stale writer loses", () =>
    Effect.gen(function* () {
      const events = yield* seed("o1", [new Placed({ amount: 1 })])
      yield* Revisioned.applyBatch(events)
      const { rows } = yield* Revisioned.rebuild({ orderId: "o1" })
      expect(rows[0]!.version).toBe(1)
      expect(rowOf("o1")).toMatchObject({ rev: 2, version: 1 })
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("exhausted lost races fail with ConcurrentModification naming the revision", () =>
    Effect.gen(function* () {
      const [event] = yield* seed("o1", [new Placed({ amount: 1 })])
      rejection.all = true
      const fiber = yield* Effect.forkChild(Effect.flip(Revisioned.apply(event!)))
      yield* TestClock.adjust("1 minute")
      const error = yield* Fiber.join(fiber)
      expect(error).toBeInstanceOf(ConcurrentModification)
      expect((error as ConcurrentModification).attributes).toEqual(["rev"])
    }).pipe(Effect.provide(TestLayer)),
  )
})

describe("projection removal (tombstones)", () => {
  it.effect("writes a tombstone that keeps the checkpoint and reads as no row", () =>
    Effect.gen(function* () {
      const events = yield* seed("o1", [new Placed({ amount: 1 }), new Cancelled({})])
      const result = yield* Removable.applyBatch(events)
      const outcome = result.outcomes[0]!
      if (outcome._tag !== "Applied") throw new Error("not applied")
      expect(outcome.removed).toBe(true)
      expect(outcome.state).toEqual(Option.none())
      expect(outcome.version).toBe(2)
      const tomb = rowOf("o1")!
      expect(tomb.__edd_e__).toBe("Summary#tombstone")
      expect(tomb).toMatchObject({ version: 2, rev: 1 })
      expect(tomb.total).toBeUndefined()
      // The entity reads it as absent.
      const missing = yield* Effect.flip(Summaries.get({ orderId: "o1" }).asEffect())
      expect(missing._tag).toBe("ItemNotFound")
      // A redelivery is already applied — the row is not recreated.
      const again = yield* Removable.apply(events[0]!)
      expect(again.applied).toEqual([])
      expect(again.removed).toBe(true)
      expect(rowOf("o1")!.__edd_e__).toBe("Summary#tombstone")
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("a later event starts the row again from initial, at the tombstone's checkpoint", () =>
    Effect.gen(function* () {
      yield* Orders.append({ orderId: "o1" }, [new Placed({ amount: 5 }), new Cancelled({})], 0)
      yield* Orders.append({ orderId: "o1" }, [new Added({ amount: 3 })], 2)
      const events = yield* Orders.read({ orderId: "o1" })
      yield* Removable.applyBatch(events.slice(0, 2))
      const revived = yield* Removable.apply(events[2]!)
      expect(revived.removed).toBe(false)
      expect(Option.getOrThrow(revived.state)).toMatchObject({ total: 3, version: 3, rev: 2 })
      // In one fold too: removal then a later event.
      const { rows } = yield* Removable.rebuild({ orderId: "o1" })
      expect(rows[0]).toMatchObject({ version: 3, removed: false })
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("a rebuild whose fold ends removed writes a tombstone", () =>
    Effect.gen(function* () {
      const events = yield* seed("o1", [new Placed({ amount: 5 })])
      yield* Removable.applyBatch(events)
      yield* Orders.append({ orderId: "o1" }, [new Cancelled({})], 1)
      const { rows } = yield* Removable.rebuild({ orderId: "o1" })
      expect(rows[0]).toMatchObject({ version: 2, removed: true })
      expect(rowOf("o1")!.__edd_e__).toBe("Summary#tombstone")
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("removeRow without `removal` fails the row", () =>
    Effect.gen(function* () {
      const events = yield* seed("o1", [new Cancelled({})])
      const error = yield* Effect.flip(Revisioned.apply(events[0]!))
      expect(error).toBeInstanceOf(ValidationError)
    }).pipe(Effect.provide(TestLayer)),
  )

  it("refuses removal and outbox on a read model with unique constraints, and outbox without revision", () => {
    expect(() =>
      EventStore.projection({ ...base, readModel: UniqueSummaries, removal: {} } as never),
    ).toThrow(/\[EDD-9081\].*removal/)
    expect(() =>
      EventStore.projection({
        ...base,
        outbox: { schema: Notice, effects: () => [] },
      } as never),
    ).toThrow(/\[EDD-9081\].*revision/)
  })
})

describe("projection outbox", () => {
  it.effect("commits effects with the row in one transaction, then drains them in order", () =>
    Effect.gen(function* () {
      const events = yield* seed("o1", [
        new Placed({ amount: 1 }),
        new Added({ amount: 2 }),
        new Added({ amount: 4 }),
      ])
      const result = yield* Notifying.applyBatch(events)
      const outcome = result.outcomes[0]!
      if (outcome._tag !== "Applied") throw new Error("not applied")
      expect(outcome.enqueued).toBe(2)
      expect(calls.transactWriteItems).toBe(1)
      const pending = items("read", "Summary#outbox")
      expect(pending.map((p) => [p.version, (p.effect as Notice).total])).toEqual([
        [2, 3],
        [3, 7],
      ])
      const delivered: Array<Notice> = []
      const drained = yield* Notifying.drain({ orderId: "o1" }, (effect) =>
        Effect.sync(() => {
          delivered.push(effect)
        }),
      )
      expect(drained.delivered).toBe(2)
      expect(delivered.map((d) => d.total)).toEqual([3, 7])
      expect(items("read", "Summary#outbox")).toEqual([])
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("a write without effects stays a single put", () =>
    Effect.gen(function* () {
      const events = yield* seed("o1", [new Placed({ amount: 1 })])
      yield* Notifying.applyBatch(events)
      expect(calls.transactWriteItems).toBe(0)
      expect(calls.putItem).toBe(1)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("a removal's effects commit with the tombstone", () =>
    Effect.gen(function* () {
      const events = yield* seed("o1", [new Placed({ amount: 1 }), new Cancelled({})])
      yield* Notifying.applyBatch(events)
      expect(rowOf("o1")!.__edd_e__).toBe("Summary#tombstone")
      const ttl = rowOf("o1")!._ttl
      expect(typeof ttl).toBe("number")
      expect(items("read", "Summary#outbox").map((p) => (p.effect as Notice).kind)).toEqual([
        "Cancelled",
      ])
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect(
    "stops at a failed delivery, leaving it pending at the head, and resumes in order",
    () =>
      Effect.gen(function* () {
        const events = yield* seed("o1", [
          new Placed({ amount: 1 }),
          new Added({ amount: 2 }),
          new Added({ amount: 4 }),
        ])
        yield* Notifying.applyBatch(events)
        let failOn = 3
        const delivered: Array<number> = []
        const deliver = (effect: Notice) =>
          effect.total === failOn
            ? Effect.fail("broker down" as const)
            : Effect.sync(() => {
                delivered.push(effect.total)
              })
        const first = yield* Notifying.drain({ orderId: "o1" }, deliver)
        expect(first.delivered).toBe(0)
        expect(Option.getOrThrow(first.undelivered).error).toBe("broker down")
        expect(items("read", "Summary#outbox")).toHaveLength(2)
        failOn = -1
        const second = yield* Notifying.drain({ orderId: "o1" }, deliver)
        expect(second.delivered).toBe(2)
        expect(delivered).toEqual([3, 7])
      }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("a head claimed by another drainer stops the drain", () =>
    Effect.gen(function* () {
      const events = yield* seed("o1", [new Placed({ amount: 1 }), new Added({ amount: 2 })])
      yield* Notifying.applyBatch(events)
      // Another drainer's live claim on the head.
      const [key, head] = [...store.entries()].find(
        ([, item]) => item.__edd_e__?.S === "Summary#outbox",
      )!
      store.set(key, {
        ...head,
        __edd_claim__: { S: "other" },
        __edd_claimed_until__: { N: String(Date.now() + 60_000) },
      } as Item)
      const drained = yield* Notifying.drain({ orderId: "o1" }, () => Effect.void)
      expect(drained).toEqual({ delivered: 0, undelivered: Option.none() })
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect(
    "`deliver` drains the rows a batch wrote, and reports failures without failing the row",
    () =>
      Effect.gen(function* () {
        const events = yield* seed("o1", [new Placed({ amount: 1 }), new Added({ amount: 2 })])
        const seen: Array<string> = []
        const result = yield* Notifying.applyBatch(events, {
          deliver: (effect, meta) =>
            Effect.sync(() => {
              seen.push(`${meta.streamId}@${meta.version}:${(effect as Notice).total}`)
            }),
        })
        expect(result.outcomes[0]!._tag).toBe("Applied")
        expect(seen).toEqual(["o1@2:3"])
        const failing = yield* Notifying.applyBatch(
          yield* Effect.gen(function* () {
            yield* Orders.append({ orderId: "o1" }, [new Added({ amount: 1 })], 2)
            return yield* Orders.readFrom({ orderId: "o1" }, 2)
          }),
          { deliver: () => Effect.fail("nope") },
        )
        const outcome = failing.outcomes[0]!
        if (outcome._tag !== "Applied") throw new Error("not applied")
        expect(Option.getOrThrow(outcome.undelivered).error).toBe("nope")
      }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("a separate outbox table, swept by drainPending through its index", () =>
    Effect.gen(function* () {
      yield* seed("o1", [new Placed({ amount: 1 })])
      yield* seed("o2", [new Placed({ amount: 2 })])
      const all = [
        ...(yield* Orders.read({ orderId: "o1" })),
        ...(yield* Orders.read({ orderId: "o2" })),
      ]
      yield* NotifyingElsewhere.applyBatch(all)
      expect(items("read", "Summary#outbox")).toEqual([])
      expect(items("outbox", "Summary#outbox")).toHaveLength(2)
      const seen: Array<string> = []
      const swept = yield* NotifyingElsewhere.drainPending((effect) =>
        Effect.sync(() => {
          seen.push((effect as Notice).orderId)
        }),
      )
      expect(swept.delivered).toBe(2)
      expect(seen.sort()).toEqual(["o1", "o2"])
      expect(items("outbox")).toEqual([])
    }).pipe(Effect.provide(TestLayer)),
  )
})
