/**
 * Projection rows beyond 1.28.0: `revision` (#153), tombstones (`removal`,
 * #154) and the outbox (#155), on single-source projections, and the rows of
 * an offloading read model (#179) — against the in-memory tables in
 * `helpers/InMemoryTables.ts`.
 */

import { describe, expect, it } from "@effect/vitest"
import { Compression } from "@effect-dynamodb/schema/Compression.js"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { ConcurrentModification, ValidationError } from "@effect-dynamodb/schema/Errors.js"
import * as BlobPointer from "@effect-dynamodb/schema/internal/BlobPointer.js"
import { Effect, Fiber, Layer, Option, Schema } from "effect"
import { TestClock } from "effect/testing"
import { beforeEach } from "vitest"
import { BlobStore } from "../src/BlobStore.js"
import * as ZlibCompression from "../src/compression/zlib.js"
import { DynamoClient, type DynamoClientService } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
import { fromAttributeMap } from "../src/Marshaller.js"
import * as Table from "../src/Table.js"
import * as Transaction from "../src/Transaction.js"
import {
  calls,
  hooks,
  InMemoryClient,
  type Item,
  rejection,
  resetCalls,
  resetStore,
  store,
  tableIndexes,
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

const StampedSummaries = Entity.make({
  model: Schema.Struct({ ...Summary.fields, createdAt: Schema.optional(Schema.DateTimeUtc) }),
  entityType: "StampedSummary",
  primaryKey: {
    pk: { field: "pk", composite: ["orderId"] },
    sk: { field: "sk", composite: [] },
  },
  timestamps: true,
  indexes: {
    byCreated: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: [] },
      sk: { field: "gsi1sk", composite: ["createdAt"] },
    },
  },
})

const ReadTable = Table.make({
  schema: AppSchema,
  entities: { Summaries, UniqueSummaries, StampedSummaries },
})
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
const FromZero = EventStore.projection({ ...base, revision: { field: "rev", initial: 0 } })
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
const NotifyingStamped = EventStore.projection({
  stream: Orders,
  readModel: StampedSummaries,
  key: base.key,
  initial: base.initial,
  // A row built afresh: the value it keeps is the library's to carry.
  evolve: (state: Summary, event: EventStore.StreamEvent<OrderEvent>) =>
    Effect.succeed({
      orderId: state.orderId,
      version: state.version,
      rev: state.rev,
      total: state.total + (event.data._tag === "Cancelled" ? 0 : event.data.amount),
    }),
  checkpoint: "version" as const,
  revision: "rev",
  outbox: {
    schema: Notice,
    effects: (event) => [{ orderId: event.streamId, kind: event.eventType, total: 0 }],
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

tableIndexes.set("outbox", { outbox: { pk: "obpk", sk: "obsk" } })
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

  it.effect("a revision's `initial` is the first write's value", () =>
    Effect.gen(function* () {
      const events = yield* seed("o1", [new Placed({ amount: 1 }), new Added({ amount: 2 })])
      yield* FromZero.apply(events[0]!)
      expect(rowOf("o1")).toMatchObject({ rev: 0 })
      yield* FromZero.apply(events[1]!)
      expect(rowOf("o1")).toMatchObject({ rev: 1 })
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

  it.effect("a tombstone holding a value DynamoDB can't store fails, writing nothing", () =>
    Effect.gen(function* () {
      const Unstorable = EventStore.projection({
        ...base,
        revision: { field: "rev", initial: Number.NaN },
        removal: {},
      })
      const events = yield* seed("o1", [new Placed({ amount: 1 }), new Cancelled({})])
      const { outcomes } = yield* Unstorable.applyBatch(events)
      const outcome = outcomes[0]!
      if (outcome._tag !== "Failed") throw new Error("not refused")
      expect(outcome.error).toBeInstanceOf(ValidationError)
      expect(String((outcome.error as ValidationError).cause)).toMatch(/"rev": .*NaN/)
      expect(rowOf("o1")).toBeUndefined()
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("the entity's create refuses a value before reading for a tombstone", () =>
    Effect.gen(function* () {
      void Removable
      resetCalls()
      const error = yield* Effect.flip(
        Summaries.create({ orderId: "o9", total: 2 ** 60, version: 0, rev: 0 }).asEffect(),
      )
      expect(error).toBeInstanceOf(ValidationError)
      expect(String((error as ValidationError).cause)).toMatch(/"total": .*MAX_SAFE_INTEGER/)
      expect(calls.getItem).toBe(0)
      expect(rowOf("o9")).toBeUndefined()
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("the entity's create takes a tombstone's place, as get reports none", () =>
    Effect.gen(function* () {
      const events = yield* seed("o1", [new Placed({ amount: 1 }), new Cancelled({})])
      yield* Removable.applyBatch(events)
      const created = yield* Summaries.create({
        orderId: "o1",
        total: 9,
        version: 0,
        rev: 0,
      }).asEffect()
      expect(created.total).toBe(9)
      // The tombstone's checkpoint and revision carried over.
      expect(rowOf("o1")).toMatchObject({ __edd_e__: "Summary", total: 9, version: 2, rev: 2 })
      // A late redelivery of the removal is already applied: the row stays.
      const late = yield* Removable.apply(events[1]!)
      expect(late.applied).toEqual([])
      expect(late.removed).toBe(false)
      expect(rowOf("o1")!.__edd_e__).toBe("Summary")
      // A second create still finds the row.
      const again = yield* Effect.flip(
        Summaries.create({ orderId: "o1", total: 1, version: 0, rev: 0 }).asEffect(),
      )
      expect(again._tag).toBe("ConditionalCheckFailed")
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("a transactional create over a tombstone carries its checkpoint over too", () =>
    Effect.gen(function* () {
      const events = yield* seed("o2", [new Placed({ amount: 1 }), new Cancelled({})])
      yield* Removable.applyBatch(events)
      yield* Transaction.transactWrite([
        Summaries.create({ orderId: "o2", total: 4, version: 0, rev: 0 }),
      ])
      expect(rowOf("o2")).toMatchObject({ __edd_e__: "Summary", total: 4, version: 2, rev: 2 })
      const late = yield* Removable.apply(events[1]!)
      expect(late.applied).toEqual([])
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

  it.effect("an effect holding a value with no stored form drains with that value", () =>
    Effect.gen(function* () {
      const Bare = EventStore.projection({
        ...base,
        revision: "rev",
        outbox: {
          schema: Schema.Struct({
            orderId: Schema.String,
            note: Schema.UndefinedOr(Schema.String),
            tags: Schema.ReadonlySet(Schema.String),
          }),
          effects: (event) => [
            { orderId: event.streamId, note: undefined, tags: new Set<string>() },
          ],
        },
      })
      yield* Bare.applyBatch(yield* seed("o1", [new Placed({ amount: 1 })]))
      const pending = items("read", "Summary#outbox")
      expect(pending).toHaveLength(1)
      expect(pending[0]!.effect).toEqual({ orderId: "o1" })
      const delivered: Array<any> = []
      yield* Bare.drain({ orderId: "o1" }, (effect) =>
        Effect.sync(() => {
          delivered.push(effect)
        }),
      )
      expect(delivered).toHaveLength(1)
      expect(delivered[0].tags).toEqual(new Set())
      expect("note" in delivered[0]).toBe(true)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("an effect holding a value DynamoDB can't store fails the row, writing nothing", () =>
    Effect.gen(function* () {
      const Refusing = (effect: unknown) =>
        EventStore.projection({
          ...base,
          revision: "rev",
          outbox: {
            schema: Schema.Struct({
              lists: Schema.optional(Schema.Array(Schema.ReadonlySet(Schema.String))),
              gap: Schema.optional(
                Schema.Tuple([Schema.String, Schema.UndefinedOr(Schema.String), Schema.String]),
              ),
            }),
            effects: () => [effect as never],
          },
        })
      const events = yield* seed("o1", [new Placed({ amount: 1 })])
      const before = items("read").length
      const emptySet = yield* Effect.flip(
        Refusing({ lists: [new Set<string>()] }).apply(events[0]!),
      )
      expect(emptySet).toBeInstanceOf(ValidationError)
      expect(String((emptySet as ValidationError).cause)).toMatch(
        /"effect\.lists\[0\]": .*no empty set/,
      )
      const gap = yield* Effect.flip(Refusing({ gap: ["a", undefined, "b"] }).apply(events[0]!))
      expect(gap).toBeInstanceOf(ValidationError)
      expect(String((gap as ValidationError).cause)).toMatch(/holds undefined/)
      expect(items("read")).toHaveLength(before)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect(
    "a row keeps its `createdAt` through an outbox write, in the attribute and the key",
    () =>
      Effect.gen(function* () {
        const events = yield* seed("o1", [new Placed({ amount: 1 }), new Added({ amount: 2 })])
        const stored = () => items("read", "StampedSummary")[0]!
        yield* NotifyingStamped.apply(events[0]!)
        const first = stored()
        expect(first.gsi1sk).toContain(String(first.createdAt).toLowerCase())
        yield* TestClock.adjust("1 minute")
        yield* NotifyingStamped.apply(events[1]!)
        const second = stored()
        expect(second.total).toBe(3)
        expect(second.createdAt).toBe(first.createdAt)
        expect(second.gsi1sk).toBe(first.gsi1sk)
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

  it.effect("a delivered effect is removed even if its claim was taken over meanwhile", () =>
    Effect.gen(function* () {
      const events = yield* seed("o1", [new Placed({ amount: 1 }), new Added({ amount: 2 })])
      yield* Notifying.applyBatch(events)
      const drained = yield* Notifying.drain({ orderId: "o1" }, () =>
        Effect.sync(() => {
          // The claim expired while delivering, and another drainer took it.
          const [key, head] = [...store.entries()].find(
            ([, item]) => item.__edd_e__?.S === "Summary#outbox",
          )!
          store.set(key, { ...head, __edd_claim__: { S: "other" } } as Item)
        }),
      )
      expect(drained.delivered).toBe(1)
      expect(items("read", "Summary#outbox")).toEqual([])
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

  it.effect("`deliver` passes through processBatch, per projection", () =>
    Effect.gen(function* () {
      yield* seed("o1", [new Placed({ amount: 1 }), new Added({ amount: 2 })])
      const records = [...store.entries()]
        .filter(([k, item]) => k.startsWith("events|") && item.__edd_e__?.S === "order.event")
        .map(([, item], i) => ({
          eventID: `e${i}`,
          eventName: "INSERT",
          dynamodb: { SequenceNumber: String(i).padStart(4, "0"), NewImage: item as never },
        }))
      const seen: Array<number> = []
      const single = yield* Notifying.processBatch(records, {
        source: "lambda",
        deliver: (effect) =>
          Effect.sync(() => {
            seen.push((effect as Notice).total)
          }),
      })
      expect(single.response).toEqual({ batchItemFailures: [] })
      expect(seen).toEqual([3])
      expect(items("read", "Summary#outbox")).toEqual([])
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

describe("projection rows of an offloading read model (#179)", () => {
  const Receipt = Schema.Struct({
    orderId: Schema.String,
    total: Schema.Number,
    version: Schema.Number,
    scan: Schema.optional(Schema.Uint8Array),
  })
  const Receipts = Entity.make({
    model: DynamoModel.configure(Receipt, { scan: { storedAs: DynamoModel.External() } }),
    entityType: "Receipt",
    primaryKey: {
      pk: { field: "pk", composite: ["orderId"] },
      sk: { field: "sk", composite: [] },
    },
  })
  const Announcement = Schema.Struct({
    orderId: Schema.String,
    total: Schema.Number,
    version: Schema.Number,
    rev: Schema.Number,
    scan: Schema.optional(Schema.Uint8Array),
  })
  const Announcements = Entity.make({
    model: DynamoModel.configure(Announcement, { scan: { storedAs: DynamoModel.External() } }),
    entityType: "Announcement",
    primaryKey: {
      pk: { field: "pk", composite: ["orderId"] },
      sk: { field: "sk", composite: [] },
    },
  })
  const rowKey = {
    pk: { field: "pk", composite: ["orderId"] },
    sk: { field: "sk", composite: [] },
  } as const
  // A Hidden field beside an offloaded one: the row is read whole, Hidden
  // fields included, and written whole (design §8.4).
  const Keyed = Schema.Struct({
    orderId: Schema.String,
    total: Schema.Number,
    version: Schema.Number,
    searchKey: DynamoModel.Hidden(Schema.String),
    scan: Schema.optional(Schema.Uint8Array),
  })
  const KeyedReceipts = Entity.make({
    model: DynamoModel.configure(Keyed, { scan: { storedAs: DynamoModel.External() } }),
    entityType: "KeyedReceipt",
    primaryKey: rowKey,
  })
  const Noted = Schema.Struct({
    orderId: Schema.String,
    total: Schema.Number,
    version: Schema.Number,
    note: Schema.optionalKey(DynamoModel.Hidden(Schema.String)),
    scan: Schema.optional(Schema.Uint8Array),
  })
  const NotedReceipts = Entity.make({
    model: DynamoModel.configure(Noted, { scan: { storedAs: DynamoModel.External() } }),
    entityType: "NotedReceipt",
    primaryKey: rowKey,
  })
  // An overflow field, offloaded at 8 stored bytes: plain JSON, and gzip-compressed.
  const Ledger = Schema.Struct({
    orderId: Schema.String,
    total: Schema.Number,
    version: Schema.Number,
    body: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  })
  const Ledgers = Entity.make({
    model: DynamoModel.configure(Ledger, {
      body: { storedAs: DynamoModel.Packed({ format: "json", external: { threshold: 8 } }) },
    }),
    entityType: "Ledger",
    primaryKey: rowKey,
  })
  const GzLedgers = Entity.make({
    model: DynamoModel.configure(Ledger, {
      body: {
        storedAs: DynamoModel.Packed({
          format: "json",
          compression: { codec: "gzip", threshold: 0 },
          external: { threshold: 8 },
        }),
      },
    }),
    entityType: "GzLedger",
    primaryKey: rowKey,
  })
  // Offloading requires escaped keys (#179).
  const ReceiptTable = Table.make({
    schema: DynamoSchema.make({ name: "rows", version: 1, escapeKeys: true }),
    entities: { Receipts, Announcements, KeyedReceipts, NotedReceipts, Ledgers, GzLedgers },
  })
  const SCAN = new Uint8Array(16).fill(3)
  const Receipted = EventStore.projection({
    stream: Orders,
    readModel: Receipts,
    key: (id: { readonly orderId: string }) => ({ orderId: id.orderId }),
    initial: (id: { readonly orderId: string }) => ({
      orderId: id.orderId,
      total: 0,
      version: 0,
      scan: SCAN,
    }),
    evolve: (state: typeof Receipt.Type, event: EventStore.StreamEvent<OrderEvent>) =>
      Effect.succeed({
        ...state,
        total: state.total + (event.data._tag === "Cancelled" ? 0 : event.data.amount),
      }),
    checkpoint: "version" as const,
  })

  it.effect("each written row is its outcome's state, offloaded fields read eagerly", () =>
    Effect.gen(function* () {
      const events = yield* seed("o1", [new Placed({ amount: 1 }), new Added({ amount: 2 })])
      // The first event creates the row; the second replaces it under its guard.
      for (const event of events) {
        const result = yield* Receipted.applyBatch([event])
        const outcome = result.outcomes[0]!
        if (outcome._tag !== "Applied") throw new Error("not applied")
        const state = Option.getOrThrow(outcome.state)
        expect(state.scan).toEqual(SCAN)
      }
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          TestLayer,
          ReceiptTable.layer({ name: "read" }),
          BlobStore.layer(BlobStore.memory()),
        ),
      ),
    ),
  )

  // ---- pointer reuse (design §6.11) ----

  const ROWS: ReadonlySet<string> = new Set([
    "Receipt",
    "Announcement",
    "KeyedReceipt",
    "NotedReceipt",
    "Ledger",
    "GzLedger",
  ])
  /** The row writes sent: each `PutItem`, and each `TransactWriteItems`' row Put. */
  const rowWrites: Array<{
    readonly command: string
    readonly condition: string | undefined
    readonly names: Record<string, string>
  }> = []
  const SpyClient = Layer.effect(
    DynamoClient,
    Effect.map(
      Effect.service(DynamoClient),
      (inner): DynamoClientService => ({
        ...inner,
        putItem: (input) =>
          Effect.suspend(() => {
            if (ROWS.has(input.Item?.__edd_e__?.S ?? "")) {
              rowWrites.push({
                command: "PutItem",
                condition: input.ConditionExpression,
                names: input.ExpressionAttributeNames ?? {},
              })
            }
            return inner.putItem(input)
          }),
        transactWriteItems: (input) =>
          Effect.suspend(() => {
            for (const entry of input.TransactItems ?? []) {
              const put = entry.Put
              if (put === undefined || !ROWS.has(put.Item?.__edd_e__?.S ?? "")) continue
              rowWrites.push({
                command: "TransactWriteItems",
                condition: put.ConditionExpression,
                names: put.ExpressionAttributeNames ?? {},
              })
            }
            return inner.transactWriteItems(input)
          }),
      }),
    ),
  ).pipe(Layer.provide(InMemoryClient))
  let blobs = BlobStore.memory()
  const withBlobs = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.suspend(() => {
      blobs = BlobStore.memory()
      rowWrites.length = 0
      return effect.pipe(
        Effect.provide(
          Layer.mergeAll(
            SpyClient,
            EventsTable.layer({ name: "events" }),
            ReceiptTable.layer({ name: "read" }),
            BlobStore.layer(blobs),
            Compression.layer([ZlibCompression.gzip()]),
          ),
        ),
      )
    })
  /** Whether a row write is conditioned on the row still holding `attribute`'s pointer. */
  const pinnedOn = (attribute: string) => (write: (typeof rowWrites)[number]) =>
    write.names["#eddPin0"] === attribute && (write.condition ?? "").includes("#eddPin0 = :eddPin0")
  const pinned = pinnedOn("scan")
  /** A row's stored attribute value, by entity type and order id. */
  const storedOf = (entityType: string, orderId: string, attribute: string) =>
    [...store.entries()].find(
      ([key, item]) =>
        key.startsWith("read|") && item.__edd_e__?.S === entityType && item.orderId?.S === orderId,
    )?.[1][attribute]
  const storedScan = (orderId: string) => storedOf("Receipt", orderId, "scan")
  const rescanned = (scanOf: (event: EventStore.StreamEvent<OrderEvent>) => Uint8Array) =>
    EventStore.projection({
      stream: Orders,
      readModel: Receipts,
      key: (id: { readonly orderId: string }) => ({ orderId: id.orderId }),
      initial: (id: { readonly orderId: string }) => ({
        orderId: id.orderId,
        total: 0,
        version: 0,
        scan: SCAN,
      }),
      evolve: (state: typeof Receipt.Type, event: EventStore.StreamEvent<OrderEvent>) =>
        Effect.succeed({ ...state, scan: scanOf(event) }),
      checkpoint: "version" as const,
    })

  it.effect("an unchanged offloaded field keeps its pointer, pinned: nothing uploads", () =>
    withBlobs(
      Effect.gen(function* () {
        const events = yield* seed("o1", [new Placed({ amount: 1 }), new Added({ amount: 2 })])
        yield* Receipted.applyBatch(events.slice(0, 1))
        const first = storedScan("o1")
        expect(blobs.inspect().calls.put).toBe(1)
        expect(pinned(rowWrites[0]!)).toBe(false)
        const result = yield* Receipted.applyBatch(events.slice(1))
        expect(result.outcomes[0]!._tag).toBe("Applied")
        // The same pointer, conditioned on the row still holding it.
        expect(blobs.inspect().calls.put).toBe(1)
        expect(storedScan("o1")).toEqual(first)
        expect(pinned(rowWrites[1]!)).toBe(true)
      }),
    ),
  )

  it.effect("a changed offloaded field uploads anew, unpinned", () =>
    withBlobs(
      Effect.gen(function* () {
        const Rescanned = rescanned((event) =>
          new Uint8Array(16).fill(event.data._tag === "Cancelled" ? 0 : event.data.amount),
        )
        const events = yield* seed("o1", [new Placed({ amount: 1 }), new Added({ amount: 2 })])
        yield* Rescanned.applyBatch(events.slice(0, 1))
        yield* Rescanned.applyBatch(events.slice(1))
        expect(blobs.inspect().calls.put).toBe(2)
        expect(rowWrites.map((write) => pinned(write))).toEqual([false, false])
        // No inline freeing: the replaced version is the reaper's.
        expect(blobs.inspect().versions).toHaveLength(2)
        const state = yield* Receipts.get({ orderId: "o1" }).pipe(Entity.offloaded("eager"))
        expect(state.scan).toEqual(new Uint8Array(16).fill(2))
      }),
    ),
  )

  it.effect("the field changed since the read: the pinned write loses and is retried", () =>
    withBlobs(
      Effect.gen(function* () {
        const events = yield* seed("o1", [new Placed({ amount: 1 }), new Added({ amount: 2 })])
        yield* Receipted.applyBatch(events.slice(0, 1))
        // Another writer's pointer, swapped into the row between the read and the write.
        const OTHER = new Uint8Array(16).fill(9)
        yield* Receipts.put({ orderId: "o2", total: 0, version: 0, scan: OTHER })
        const other = storedScan("o2")!
        const [rowKey, row] = [...store.entries()].find(
          ([key, item]) => key.startsWith("read|") && item.orderId?.S === "o1",
        )!
        hooks.afterGet.push(() => {
          store.set(rowKey, { ...row, scan: other })
        })
        // The retry sleeps (jittered) first: run it on the test clock.
        const fiber = yield* Effect.forkChild(Receipted.applyBatch(events.slice(1)))
        yield* TestClock.adjust("1 second")
        const result = yield* Fiber.join(fiber)
        expect(result.outcomes[0]!._tag).toBe("Applied")
        // Pinned to the pointer it read, lost; re-read and pinned to the new one.
        expect(rowWrites.slice(-2).map((write) => pinned(write))).toEqual([true, true])
        expect(storedScan("o1")).toEqual(other)
        expect(blobs.inspect().calls.put).toBe(2)
      }),
    ),
  )

  it.effect("the outbox path pins a kept pointer in its transaction", () =>
    withBlobs(
      Effect.gen(function* () {
        const Announced = EventStore.projection({
          stream: Orders,
          readModel: Announcements,
          key: (id: { readonly orderId: string }) => ({ orderId: id.orderId }),
          initial: (id: { readonly orderId: string }) => ({
            orderId: id.orderId,
            total: 0,
            version: 0,
            rev: 0,
            scan: SCAN,
          }),
          evolve: (state: typeof Announcement.Type, event: EventStore.StreamEvent<OrderEvent>) =>
            Effect.succeed({
              ...state,
              total: state.total + (event.data._tag === "Cancelled" ? 0 : event.data.amount),
            }),
          checkpoint: "version" as const,
          revision: "rev",
          outbox: {
            schema: Notice,
            effects: (event, next) => [
              { orderId: event.streamId, kind: event.eventType, total: next?.total ?? -1 },
            ],
          },
        })
        const events = yield* seed("o1", [new Placed({ amount: 1 }), new Added({ amount: 2 })])
        yield* Announced.applyBatch(events.slice(0, 1))
        yield* Announced.applyBatch(events.slice(1))
        expect(rowWrites.map((write) => write.command)).toEqual([
          "TransactWriteItems",
          "TransactWriteItems",
        ])
        expect(rowWrites.map((write) => pinned(write))).toEqual([false, true])
        expect(blobs.inspect().calls.put).toBe(1)
        expect(blobs.inspect().calls.delete).toBe(0)
      }),
    ),
  )

  // ---- Hidden fields: read whole, written whole ----

  const amountOf = (event: EventStore.StreamEvent<OrderEvent>) =>
    event.data._tag === "Cancelled" ? 0 : event.data.amount

  it.effect("a required Hidden field is read with the row, so every fold applies", () =>
    withBlobs(
      Effect.gen(function* () {
        const Keying = EventStore.projection({
          stream: Orders,
          readModel: KeyedReceipts,
          key: (id: { readonly orderId: string }) => ({ orderId: id.orderId }),
          initial: (id: { readonly orderId: string }) => ({
            orderId: id.orderId,
            total: 0,
            version: 0,
            searchKey: `order#${id.orderId}`,
            scan: SCAN,
          }),
          evolve: (state: typeof Keyed.Type, event: EventStore.StreamEvent<OrderEvent>) =>
            Effect.succeed({ ...state, total: state.total + amountOf(event) }),
          checkpoint: "version" as const,
        })
        const events = yield* seed("o1", [new Placed({ amount: 1 }), new Added({ amount: 2 })])
        for (const event of events) {
          const result = yield* Keying.applyBatch([event])
          expect(result.outcomes[0]!._tag).toBe("Applied")
        }
        expect(items("read", "KeyedReceipt")[0]).toMatchObject({
          total: 3,
          version: 2,
          searchKey: "order#o1",
        })
        // The kept scan pointer still pins the rewrite.
        expect(rowWrites.map((write) => pinned(write))).toEqual([false, true])
      }),
    ),
  )

  it.effect("an optional Hidden field survives every rewrite", () =>
    withBlobs(
      Effect.gen(function* () {
        const Noting = EventStore.projection({
          stream: Orders,
          readModel: NotedReceipts,
          key: (id: { readonly orderId: string }) => ({ orderId: id.orderId }),
          initial: (id: { readonly orderId: string }) => ({
            orderId: id.orderId,
            total: 0,
            version: 0,
            note: "kept",
            scan: SCAN,
          }),
          evolve: (state: typeof Noted.Type, event: EventStore.StreamEvent<OrderEvent>) =>
            Effect.succeed({ ...state, total: state.total + amountOf(event) }),
          checkpoint: "version" as const,
        })
        const events = yield* seed("o1", [
          new Placed({ amount: 1 }),
          new Added({ amount: 2 }),
          new Added({ amount: 3 }),
        ])
        for (const event of events) yield* Noting.applyBatch([event])
        expect(items("read", "NotedReceipt")[0]).toMatchObject({ total: 6, note: "kept" })
      }),
    ),
  )

  // ---- pointer reuse of an overflow field: the encoded content compared ----

  const PAD = "x".repeat(32)
  const ledgered = (
    bodyOf: (
      state: typeof Ledger.Type,
      event: EventStore.StreamEvent<OrderEvent>,
    ) => Record<string, unknown>,
  ) =>
    EventStore.projection({
      stream: Orders,
      readModel: Ledgers,
      key: (id: { readonly orderId: string }) => ({ orderId: id.orderId }),
      initial: (id: { readonly orderId: string }) => ({
        orderId: id.orderId,
        total: 0,
        version: 0,
      }),
      evolve: (state: typeof Ledger.Type, event: EventStore.StreamEvent<OrderEvent>) =>
        Effect.succeed({
          ...state,
          total: state.total + amountOf(event),
          body: bodyOf(state, event),
        }),
      checkpoint: "version" as const,
    })
  const pinnedBody = pinnedOn("body")
  const bodyRef = (entityType: string, orderId: string) => {
    const pointer = BlobPointer.decode(storedOf(entityType, orderId, "body")!.B!)
    if (typeof pointer === "string") throw new Error(pointer)
    return pointer
  }
  const readBody = (orderId: string) =>
    Effect.gen(function* () {
      const row = yield* Ledgers.get({ orderId }).pipe(Entity.offloaded("eager"))
      return row.body as Record<string, unknown>
    })
  /** `value` with every object's keys in reverse order: the same JSON value. */
  const reversed = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map((element) => reversed(element))
    if (value === null || typeof value !== "object") return value
    return Object.fromEntries(
      Object.keys(value)
        .reverse()
        .map((key) => [key, reversed((value as Record<string, unknown>)[key])]),
    )
  }
  const SAMPLE = { a: 1, b: { c: [1, { d: 2, e: 3 }], f: "g" }, pad: PAD }

  it.effect("an unchanged overflow value keeps its pointer, pinned: nothing uploads", () =>
    withBlobs(
      Effect.gen(function* () {
        const Kept = ledgered((state) => state.body ?? SAMPLE)
        const events = yield* seed("o1", [new Placed({ amount: 1 }), new Added({ amount: 2 })])
        yield* Kept.applyBatch(events.slice(0, 1))
        const first = storedOf("Ledger", "o1", "body")
        expect(blobs.inspect().calls.put).toBe(1)
        const result = yield* Kept.applyBatch(events.slice(1))
        const outcome = result.outcomes[0]!
        if (outcome._tag !== "Applied") throw new Error("not applied")
        // The state decodes the kept value from the read cache: no fetch.
        expect(Option.getOrThrow(outcome.state).body).toEqual(SAMPLE)
        expect(blobs.inspect().calls.put).toBe(1)
        expect(storedOf("Ledger", "o1", "body")).toEqual(first)
        expect(rowWrites.map((write) => pinnedBody(write))).toEqual([false, true])
        expect(yield* readBody("o1")).toEqual(SAMPLE)
      }),
    ),
  )

  it.effect("the same overflow value in another key order keeps its pointer", () =>
    withBlobs(
      Effect.gen(function* () {
        // Each fold restates the value with every object's keys reversed.
        expect(JSON.stringify(reversed(SAMPLE))).not.toBe(JSON.stringify(SAMPLE))
        const Restated = ledgered((state) => reversed(state.body ?? SAMPLE) as never)
        const events = yield* seed("o1", [
          new Placed({ amount: 1 }),
          new Added({ amount: 2 }),
          new Added({ amount: 3 }),
        ])
        for (const event of events) yield* Restated.applyBatch([event])
        expect(blobs.inspect().calls.put).toBe(1)
        expect(rowWrites.map((write) => pinnedBody(write))).toEqual([false, true, true])
        expect(yield* readBody("o1")).toEqual(SAMPLE)
      }),
    ),
  )

  it.effect("a changed overflow value uploads anew, unpinned", () =>
    withBlobs(
      Effect.gen(function* () {
        const Changing = ledgered((_, event) => ({ pad: PAD, n: amountOf(event) }))
        const events = yield* seed("o1", [new Placed({ amount: 1 }), new Added({ amount: 2 })])
        yield* Changing.applyBatch(events.slice(0, 1))
        const first = bodyRef("Ledger", "o1").ref
        yield* Changing.applyBatch(events.slice(1))
        expect(blobs.inspect().calls.put).toBe(2)
        expect(bodyRef("Ledger", "o1").ref).not.toEqual(first)
        expect(rowWrites.map((write) => pinnedBody(write))).toEqual([false, false])
        expect(yield* readBody("o1")).toEqual({ pad: PAD, n: 2 })
      }),
    ),
  )

  it.effect("values that differ only under a `__proto__` key are not the same content", () =>
    withBlobs(
      Effect.gen(function* () {
        // A computed key: an own `__proto__` property, not the prototype.
        const Nested = ledgered((_, event) => ({ pad: PAD, ["__proto__"]: { n: amountOf(event) } }))
        const events = yield* seed("o1", [new Placed({ amount: 1 }), new Added({ amount: 2 })])
        yield* Nested.applyBatch(events.slice(0, 1))
        const result = yield* Nested.applyBatch(events.slice(1))
        expect(result.outcomes[0]!._tag).toBe("Applied")
        expect(blobs.inspect().calls.put).toBe(2)
        expect(rowWrites.map((write) => pinnedBody(write))).toEqual([false, false])
        const body = yield* readBody("o1")
        expect(Object.getOwnPropertyDescriptor(body, "__proto__")?.value).toEqual({ n: 2 })
      }),
    ),
  )

  it.effect("a compressed overflow value: unchanged keeps its pointer, changed uploads", () =>
    withBlobs(
      Effect.gen(function* () {
        const Compressed = EventStore.projection({
          stream: Orders,
          readModel: GzLedgers,
          key: (id: { readonly orderId: string }) => ({ orderId: id.orderId }),
          initial: (id: { readonly orderId: string }) => ({
            orderId: id.orderId,
            total: 0,
            version: 0,
          }),
          evolve: (state: typeof Ledger.Type, event: EventStore.StreamEvent<OrderEvent>) =>
            Effect.succeed({
              ...state,
              total: state.total + amountOf(event),
              // The same value through the second event, a new one at the third.
              body: { ...SAMPLE, stage: amountOf(event) < 3 ? "early" : "late" },
            }),
          checkpoint: "version" as const,
        })
        const events = yield* seed("o1", [
          new Placed({ amount: 1 }),
          new Added({ amount: 2 }),
          new Added({ amount: 3 }),
        ])
        yield* Compressed.applyBatch(events.slice(0, 1))
        expect(bodyRef("GzLedger", "o1").codec).toBe("gzip")
        const first = bodyRef("GzLedger", "o1").ref
        yield* Compressed.applyBatch(events.slice(1, 2))
        expect(blobs.inspect().calls.put).toBe(1)
        expect(bodyRef("GzLedger", "o1").ref).toEqual(first)
        yield* Compressed.applyBatch(events.slice(2))
        expect(blobs.inspect().calls.put).toBe(2)
        expect(bodyRef("GzLedger", "o1").ref).not.toEqual(first)
        expect(rowWrites.map((write) => pinnedBody(write))).toEqual([false, true, false])
        const row = yield* GzLedgers.get({ orderId: "o1" }).pipe(Entity.offloaded("eager"))
        expect(row.body).toEqual({ ...SAMPLE, stage: "late" })
      }),
    ),
  )
})
