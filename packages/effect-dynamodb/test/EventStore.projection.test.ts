/**
 * EventStore change-feed projections (#151): `projection` (applyBatch / apply
 * / catchUp / rebuild / processBatch), `bindProjection`, `decoder`,
 * `eventFilterPattern`, `batchResponse` and `parseStreamId` — against an
 * in-memory client that evaluates the conditions the projection writes with.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { describe, expect, it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import {
  ConcurrentModification,
  DynamoError,
  StreamRecordIdentifierMissing,
  ValidationError,
} from "@effect-dynamodb/schema/Errors.js"
import { Data, Effect, Fiber, Layer, Option, Schema } from "effect"
import { TestClock } from "effect/testing"
import { beforeEach } from "vitest"
import type { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
import { toAttributeMap } from "../src/Marshaller.js"
import * as Table from "../src/Table.js"
import { mockDynamoClientLayer } from "./helpers/MockDynamoClient.js"

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

const AppSchema = DynamoSchema.make({ name: "proj", version: 1 })

class OrderPlaced extends Schema.TaggedClass<OrderPlaced>()("OrderPlaced", {
  amount: Schema.Number,
}) {}
class ItemAdded extends Schema.TaggedClass<ItemAdded>()("ItemAdded", {
  amount: Schema.Number,
}) {}
class OrderShipped extends Schema.TaggedClass<OrderShipped>()("OrderShipped", {}) {}
class Rejected extends Schema.TaggedClass<Rejected>()("Rejected", {}) {}

const EventsTable = Table.make({ schema: AppSchema, entities: {} })

const Orders = EventStore.makeStream({
  table: EventsTable,
  streamName: "Order",
  events: [OrderPlaced, ItemAdded, OrderShipped, Rejected],
  streamId: { composite: ["orderId"] },
})

const TenantOrders = EventStore.makeStream({
  table: EventsTable,
  streamName: "TenantOrder",
  events: [OrderPlaced, ItemAdded],
  streamId: { composite: ["tenant", "orderId"] },
})

const Payments = EventStore.makeStream({
  table: EventsTable,
  streamName: "Payment",
  events: [ItemAdded],
  streamId: { composite: ["paymentId"] },
})

const OrderSummary = Schema.Struct({
  orderId: Schema.String,
  status: Schema.String,
  total: Schema.Number,
  lines: Schema.Number,
  version: Schema.Number,
})

const OrderSummaries = Entity.make({
  model: OrderSummary,
  entityType: "OrderSummary",
  primaryKey: {
    pk: { field: "pk", composite: ["orderId"] },
    sk: { field: "sk", composite: [] },
  },
})

const TenantSummary = Schema.Struct({
  tenant: Schema.String,
  orderId: Schema.String,
  total: Schema.Number,
  seq: Schema.Number,
})

const TenantSummaries = Entity.make({
  model: TenantSummary,
  entityType: "TenantSummary",
  primaryKey: {
    pk: { field: "pk", composite: ["tenant"] },
    sk: { field: "sk", composite: ["orderId"] },
  },
})

const ZoneTotal = Schema.Struct({
  deviceId: Schema.String,
  zone: Schema.String,
  total: Schema.Number,
  readings: Schema.Number,
  seq: Schema.Number,
})

const ZoneTotals = Entity.make({
  model: ZoneTotal,
  entityType: "ZoneTotal",
  primaryKey: {
    pk: { field: "pk", composite: ["deviceId"] },
    sk: { field: "sk", composite: ["zone"] },
  },
})

const TaggedSummary = Schema.Struct({
  orderId: Schema.String,
  status: Schema.String,
  total: Schema.Number,
  version: Schema.Number,
  searchKey: DynamoModel.Hidden(Schema.String),
})

const TaggedSummaries = Entity.make({
  model: TaggedSummary,
  entityType: "TaggedSummary",
  primaryKey: {
    pk: { field: "pk", composite: ["orderId"] },
    sk: { field: "sk", composite: [] },
  },
})

const PaymentTotal = Schema.Struct({
  paymentId: Schema.String,
  total: Schema.Number,
  n: Schema.Number,
})
const PaymentTotals = Entity.make({
  model: PaymentTotal,
  entityType: "PaymentTotal",
  primaryKey: {
    pk: { field: "pk", composite: ["paymentId"] },
    sk: { field: "sk", composite: [] },
  },
})

const ReadTable = Table.make({
  schema: AppSchema,
  entities: { OrderSummaries, TenantSummaries, ZoneTotals, TaggedSummaries, PaymentTotals },
})

class RejectedEvent extends Data.TaggedError("RejectedEvent")<{ readonly version: number }> {}

/** Every `evolve` call, for asserting the fold order. */
const evolved: Array<number> = []

const evolveSummary = (
  state: typeof OrderSummary.Type,
  event: EventStore.StreamEvent<OrderPlaced | ItemAdded | OrderShipped | Rejected>,
) =>
  Effect.gen(function* () {
    evolved.push(event.version)
    const data = event.data
    switch (data._tag) {
      case "OrderPlaced":
        return { ...state, status: "placed", total: data.amount }
      case "ItemAdded":
        return { ...state, total: state.total + data.amount, lines: state.lines + 1 }
      case "OrderShipped":
        return { ...state, status: "shipped" }
      case "Rejected":
        return yield* new RejectedEvent({ version: event.version })
    }
  })

const SummaryProjection = EventStore.projection({
  stream: Orders,
  readModel: OrderSummaries,
  key: (id) => ({ orderId: id.orderId }),
  initial: (id) => ({ orderId: id.orderId, status: "new", total: 0, lines: 0, version: 0 }),
  evolve: evolveSummary,
  checkpoint: "version",
})

// ---------------------------------------------------------------------------
// In-memory client
// ---------------------------------------------------------------------------

type Item = Record<string, AttributeValue>

const store = new Map<string, Item>()
const calls = { query: 0, getItem: 0, putItem: 0 }
/** Runs after each `getItem` once — a concurrent writer acting between read and write. */
let afterGet: Array<(table: string) => void> = []
/** Fail every conditional put, as if another writer always won. */
let rejectPuts = false
/** Fail this many more conditional writes, then let them through. */
let rejectNextPuts = 0
/** Every query's key condition values, for asserting the range read. */
const queried: Array<Record<string, AttributeValue>> = []

const keyOf = (table: string, item: Item) => `${table}|${item.pk?.S}|${item.sk?.S}`

const conditionalCheckFailed = (operation: string) =>
  new DynamoError({
    operation,
    cause: Object.assign(new Error("The conditional request failed"), {
      name: "ConditionalCheckFailedException",
    }),
  })

/**
 * Evaluates the condition shapes the projection writes with:
 * `attribute_not_exists(#a)`, `attribute_exists(#a)` and `#a = :v`, joined by
 * `AND`, optionally parenthesised.
 */
const holds = (
  expression: string | undefined,
  current: Item | undefined,
  names: Record<string, string>,
  values: Record<string, AttributeValue>,
): boolean => {
  if (expression === undefined) return true
  return expression
    .replace(/[()]/g, (p, i, s) =>
      // keep function-call parentheses, drop grouping ones
      /attribute_(not_)?exists$/.test(s.slice(0, i)) || (p === ")" && /#\w+$/.test(s.slice(0, i)))
        ? p
        : " ",
    )
    .split(/\s+AND\s+/)
    .map((part) => part.trim())
    .every((part) => {
      const notExists = /^attribute_not_exists\((#\w+)\)$/.exec(part)
      if (notExists) return current?.[names[notExists[1]!]!] === undefined
      const exists = /^attribute_exists\((#\w+)\)$/.exec(part)
      if (exists) return current?.[names[exists[1]!]!] !== undefined
      const eq = /^(#\w+) = (:\w+)$/.exec(part)
      if (eq) {
        const actual = current?.[names[eq[1]!]!]
        return actual !== undefined && JSON.stringify(actual) === JSON.stringify(values[eq[2]!])
      }
      throw new Error(`mock: unsupported condition part "${part}" in "${expression}"`)
    })
}

const runQuery = (input: {
  readonly TableName?: string | undefined
  readonly KeyConditionExpression?: string | undefined
  readonly FilterExpression?: string | undefined
  readonly ExpressionAttributeNames?: Record<string, string> | undefined
  readonly ExpressionAttributeValues?: Record<string, AttributeValue> | undefined
  readonly ScanIndexForward?: boolean | undefined
}) => {
  const values = input.ExpressionAttributeValues ?? {}
  const kc = /^(#\w+) = (:\w+)(?: AND (.*))?$/.exec(input.KeyConditionExpression ?? "")!
  const pkValue = values[kc[2]!]!.S
  let rows = [...store.entries()]
    .filter(([key, item]) => key.startsWith(`${input.TableName}|`) && item.pk?.S === pkValue)
    .map(([, item]) => item)
    .sort((a, b) => (a.sk!.S! < b.sk!.S! ? -1 : a.sk!.S! > b.sk!.S! ? 1 : 0))
  const between = kc[3] === undefined ? null : /^(#\w+) BETWEEN (:\w+) AND (:\w+)$/.exec(kc[3])
  const begins = kc[3] === undefined ? null : /^begins_with\((#\w+), (:\w+)\)$/.exec(kc[3])
  if (between) {
    const low = values[between[2]!]!.S!
    const high = values[between[3]!]!.S!
    rows = rows.filter((item) => item.sk!.S! >= low && item.sk!.S! <= high)
  } else if (begins) {
    rows = rows.filter((item) => item.sk!.S!.startsWith(values[begins[2]!]!.S!))
  } else if (kc[3] !== undefined) throw new Error(`mock: unsupported key condition ${kc[3]}`)
  const marker = /(#\w+) = (:\w+)/.exec(input.FilterExpression ?? "")
  if (marker) {
    const attribute = input.ExpressionAttributeNames![marker[1]!]!
    rows = rows.filter((item) => item[attribute]?.S === values[marker[2]!]!.S)
  }
  if (input.ScanIndexForward === false) rows.reverse()
  return { Items: rows }
}

const InMemoryClient = mockDynamoClientLayer({
  query: (input) =>
    Effect.sync(() => {
      calls.query++
      queried.push(input.ExpressionAttributeValues ?? {})
      return runQuery(input) as never
    }),
  transactWriteItems: (input) =>
    Effect.sync(() => {
      for (const op of input.TransactItems ?? []) {
        if (op.Put?.Item !== undefined)
          store.set(keyOf(op.Put.TableName!, op.Put.Item), op.Put.Item)
      }
      return {} as never
    }),
  getItem: (input) =>
    Effect.sync(() => {
      calls.getItem++
      const item = store.get(keyOf(input.TableName!, input.Key!))
      const hooks = afterGet
      afterGet = []
      for (const hook of hooks) hook(input.TableName!)
      return (item === undefined ? {} : { Item: item }) as never
    }),
  putItem: (input) =>
    Effect.suspend(() => {
      const key = keyOf(input.TableName!, input.Item!)
      const current = store.get(key)
      // An append of one event is a `PutItem` of the event (#173): the stream's
      // write, not the projection's, so it is neither counted nor rejected.
      if (input.Item?.__edd_e__?.S?.endsWith(".event") === true) {
        if (current !== undefined) return Effect.fail(conditionalCheckFailed("PutItem"))
        store.set(key, input.Item)
        return Effect.succeed({} as never)
      }
      calls.putItem++
      if (
        (rejectPuts && input.ConditionExpression !== undefined) ||
        (rejectNextPuts > 0 && input.ConditionExpression !== undefined && rejectNextPuts-- > 0) ||
        !holds(
          input.ConditionExpression,
          current,
          input.ExpressionAttributeNames ?? {},
          input.ExpressionAttributeValues ?? {},
        )
      ) {
        return Effect.fail(conditionalCheckFailed("PutItem"))
      }
      store.set(key, input.Item!)
      return Effect.succeed({} as never)
    }),
})

const TestLayer = Layer.mergeAll(
  InMemoryClient,
  EventsTable.layer({ name: "events" }),
  ReadTable.layer({ name: "read" }),
)

beforeEach(() => {
  store.clear()
  calls.query = 0
  calls.getItem = 0
  calls.putItem = 0
  afterGet = []
  rejectPuts = false
  rejectNextPuts = 0
  queried.length = 0
  evolved.length = 0
})

const resetCalls = () => {
  queried.length = 0
  calls.query = 0
  calls.getItem = 0
  calls.putItem = 0
  evolved.length = 0
}

/** Append `events` to order `orderId` and return them as the change feed would decode them. */
const seed = (
  orderId: string,
  events: ReadonlyArray<OrderPlaced | ItemAdded | OrderShipped | Rejected>,
) =>
  Effect.gen(function* () {
    yield* Orders.append({ orderId }, events, 0)
    const read = yield* Orders.read({ orderId })
    resetCalls()
    return read
  })

/** The stored key of an order summary row. */
const summaryKey = (orderId: string) => {
  const key = [...store.keys()].find(
    (k) => k.startsWith("read|") && store.get(k)!.orderId?.S === orderId,
  )
  if (key === undefined) throw new Error(`no summary row for ${orderId}`)
  return key
}

const rowOf = (orderId: string) =>
  OrderSummaries.get({ orderId })
    .asEffect()
    .pipe(Effect.map((row) => row as typeof OrderSummary.Type))

const versions = (events: ReadonlyArray<{ readonly version: number }>) =>
  events.map((e) => e.version)

// ---------------------------------------------------------------------------
// applyBatch
// ---------------------------------------------------------------------------

describe("EventStore.projection — applyBatch", () => {
  it.effect("applies an in-order batch with one write and no event-store read", () =>
    Effect.gen(function* () {
      const events = yield* seed("o1", [
        new OrderPlaced({ amount: 10 }),
        new ItemAdded({ amount: 5 }),
        new OrderShipped({}),
      ])
      const result = yield* SummaryProjection.applyBatch(events)
      expect(result.failedPositions).toEqual([])
      const outcome = result.outcomes[0]!
      expect(outcome._tag).toBe("Applied")
      if (outcome._tag !== "Applied") return
      expect(versions(outcome.applied)).toEqual([1, 2, 3])
      expect(outcome.alreadyApplied).toEqual([])
      expect(outcome.version).toBe(3)
      expect(Option.getOrThrow(outcome.state)).toEqual({
        orderId: "o1",
        status: "shipped",
        total: 15,
        lines: 1,
        version: 3,
      })
      expect(calls).toEqual({ query: 0, getItem: 1, putItem: 1 })
      expect(yield* rowOf("o1")).toEqual(Option.getOrThrow(outcome.state))
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect(
    "orders and deduplicates a reversed batch with a redelivery, without reading the store",
    () =>
      Effect.gen(function* () {
        const [e1, e2, e3] = yield* seed("o1", [
          new OrderPlaced({ amount: 10 }),
          new ItemAdded({ amount: 5 }),
          new ItemAdded({ amount: 1 }),
        ])
        const result = yield* SummaryProjection.applyBatch([e3!, e2!, e3!, e1!])
        const outcome = result.outcomes[0]!
        if (outcome._tag !== "Applied") throw new Error("not applied")
        expect(versions(outcome.applied)).toEqual([1, 2, 3])
        expect(outcome.positions).toEqual([0, 1, 2, 3])
        expect(evolved).toEqual([1, 2, 3])
        expect(Option.getOrThrow(outcome.state).total).toBe(16)
        expect(calls.query).toBe(0)
      }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("fills a gap below the batch with one strongly consistent read", () =>
    Effect.gen(function* () {
      const [, , e3] = yield* seed("o1", [
        new OrderPlaced({ amount: 10 }),
        new ItemAdded({ amount: 5 }),
        new ItemAdded({ amount: 1 }),
      ])
      // Only version 3 is delivered — 1 and 2 are queued behind it.
      const outcome = yield* SummaryProjection.apply(e3!)
      expect(versions(outcome.applied)).toEqual([1, 2, 3])
      expect(Option.getOrThrow(outcome.state).total).toBe(16)
      expect(calls).toEqual({ query: 1, getItem: 1, putItem: 1 })
      // The read stops at the delivered version.
      const bounds = Object.values(queried[0]!).map((v) => v.S ?? "")
      expect(bounds.some((b) => /\.event_1#0*3$/.test(b))).toBe(true)
      // The late deliveries of 1 and 2 are no-ops.
      resetCalls()
      const late = yield* SummaryProjection.applyBatch(
        (yield* Orders.read({ orderId: "o1" })).slice(0, 2),
      )
      const lateOutcome = late.outcomes[0]!
      if (lateOutcome._tag !== "Applied") throw new Error("not applied")
      expect(lateOutcome.applied).toEqual([])
      expect(versions(lateOutcome.alreadyApplied)).toEqual([1, 2])
      expect(lateOutcome.version).toBe(3)
      expect(calls.putItem).toBe(0)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect(
    "fills an interior hole with one read, and folds only up to the batch's highest version",
    () =>
      Effect.gen(function* () {
        const [e1, , e3] = yield* seed("o1", [
          new OrderPlaced({ amount: 10 }),
          new ItemAdded({ amount: 5 }),
          new ItemAdded({ amount: 1 }),
          new OrderShipped({}),
        ])
        const result = yield* SummaryProjection.applyBatch([e3!, e1!])
        const outcome = result.outcomes[0]!
        if (outcome._tag !== "Applied") throw new Error("not applied")
        expect(versions(outcome.applied)).toEqual([1, 2, 3])
        expect(outcome.version).toBe(3)
        expect(Option.getOrThrow(outcome.state).status).toBe("placed")
        expect(calls.query).toBe(1)
      }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("continues from the row's checkpoint across batches", () =>
    Effect.gen(function* () {
      const events = yield* seed("o1", [
        new OrderPlaced({ amount: 10 }),
        new ItemAdded({ amount: 5 }),
        new ItemAdded({ amount: 1 }),
      ])
      yield* SummaryProjection.applyBatch(events.slice(0, 1))
      resetCalls()
      const result = yield* SummaryProjection.applyBatch(events.slice(1))
      const outcome = result.outcomes[0]!
      if (outcome._tag !== "Applied") throw new Error("not applied")
      expect(versions(outcome.applied)).toEqual([2, 3])
      expect(evolved).toEqual([2, 3])
      expect(Option.getOrThrow(outcome.state).total).toBe(16)
      expect(calls).toEqual({ query: 0, getItem: 1, putItem: 1 })
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect(
    "re-reads after a lost race and reports what the winner applied as alreadyApplied",
    () =>
      Effect.gen(function* () {
        const events = yield* seed("o1", [
          new OrderPlaced({ amount: 10 }),
          new ItemAdded({ amount: 5 }),
        ])
        yield* SummaryProjection.applyBatch(events.slice(0, 1))
        resetCalls()
        // Another invocation applies version 2 between this one's read and write.
        afterGet.push(() => {
          const key = summaryKey("o1")
          const row = store.get(key)!
          store.set(key, {
            ...row,
            ...toAttributeMap({ total: 15, lines: 1, version: 2 }),
          })
        })
        // The retry sleeps (jittered) first: run it on the test clock.
        const fiber = yield* Effect.forkChild(SummaryProjection.applyBatch(events.slice(1)))
        yield* TestClock.adjust("1 second")
        const result = yield* Fiber.join(fiber)
        const outcome = result.outcomes[0]!
        if (outcome._tag !== "Applied") throw new Error("not applied")
        expect(outcome.applied).toEqual([])
        expect(versions(outcome.alreadyApplied)).toEqual([2])
        expect(outcome.version).toBe(2)
        expect(calls).toEqual({ query: 0, getItem: 2, putItem: 1 })
      }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("fails the instance with ConcurrentModification when every retry loses", () =>
    Effect.gen(function* () {
      const projection = EventStore.projection({
        stream: Orders,
        readModel: OrderSummaries,
        key: (id) => ({ orderId: id.orderId }),
        initial: (id) => ({ orderId: id.orderId, status: "new", total: 0, lines: 0, version: 0 }),
        evolve: evolveSummary,
        checkpoint: "version",
        retry: 2,
      })
      const events = yield* seed("o1", [new OrderPlaced({ amount: 10 })])
      rejectPuts = true
      const result = yield* projection.applyBatch(events)
      const outcome = result.outcomes[0]!
      if (outcome._tag !== "Failed") throw new Error("not failed")
      expect(outcome.error).toBeInstanceOf(ConcurrentModification)
      expect((outcome.error as ConcurrentModification).attributes).toEqual(["version"])
      // The first attempt and two retries, each re-reading the row.
      expect(calls).toEqual({ query: 0, getItem: 3, putItem: 3 })
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("isolates an evolve failure to its instance and reports its earliest position", () =>
    Effect.gen(function* () {
      const good = yield* seed("o1", [new OrderPlaced({ amount: 10 })])
      yield* Orders.append({ orderId: "o2" }, [new OrderPlaced({ amount: 1 }), new Rejected({})], 0)
      const bad = yield* Orders.read({ orderId: "o2" })
      const result = yield* SummaryProjection.applyBatch([bad[1]!, good[0]!, bad[0]!])
      expect(result.outcomes.map((o) => [o.streamId, o._tag])).toEqual([
        ["o2", "Failed"],
        ["o1", "Applied"],
      ])
      const failed = result.outcomes[0]!
      if (failed._tag !== "Failed") throw new Error("not failed")
      expect(failed.error).toEqual(new RejectedEvent({ version: 2 }))
      expect(failed.positions).toEqual([0, 2])
      expect(result.failedPositions).toEqual([0])
      // Nothing of the failed instance was written.
      const missing = yield* Effect.flip(OrderSummaries.get({ orderId: "o2" }).asEffect())
      expect(missing._tag).toBe("ItemNotFound")
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("apply surfaces the instance's failure in the error channel", () =>
    Effect.gen(function* () {
      yield* Orders.append({ orderId: "o2" }, [new Rejected({})], 0)
      const [event] = yield* Orders.read({ orderId: "o2" })
      const error = yield* Effect.flip(SummaryProjection.apply(event!))
      expect(error).toEqual(new RejectedEvent({ version: 1 }))
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("stores the checkpoint through an offset", () =>
    Effect.gen(function* () {
      const projection = EventStore.projection({
        stream: Orders,
        readModel: OrderSummaries,
        key: (id) => ({ orderId: id.orderId }),
        initial: (id) => ({ orderId: id.orderId, status: "new", total: 0, lines: 0, version: 0 }),
        evolve: evolveSummary,
        checkpoint: { field: "version", offset: -1 },
      })
      const events = yield* seed("o1", [
        new OrderPlaced({ amount: 10 }),
        new ItemAdded({ amount: 5 }),
        new ItemAdded({ amount: 1 }),
      ])
      const first = yield* projection.apply(events[0]!)
      expect(first.version).toBe(1)
      expect(Option.getOrThrow(first.state).version).toBe(0)
      const second = yield* projection.applyBatch(events)
      const outcome = second.outcomes[0]!
      if (outcome._tag !== "Applied") throw new Error("not applied")
      expect(versions(outcome.alreadyApplied)).toEqual([1])
      expect(versions(outcome.applied)).toEqual([2, 3])
      expect(outcome.version).toBe(3)
      expect((yield* rowOf("o1")).version).toBe(2)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("recovers a multi-field stream id and fails an ambiguous one", () =>
    Effect.gen(function* () {
      const projection = EventStore.projection({
        stream: TenantOrders,
        readModel: TenantSummaries,
        key: (id) => ({ tenant: id.tenant, orderId: id.orderId }),
        initial: (id) => ({ tenant: id.tenant, orderId: id.orderId, total: 0, seq: 0 }),
        evolve: (state, event) =>
          Effect.succeed({ ...state, total: state.total + event.data.amount }),
        checkpoint: "seq",
      })
      yield* TenantOrders.append(
        { tenant: "acme", orderId: "o1" },
        [new ItemAdded({ amount: 3 })],
        0,
      )
      yield* TenantOrders.append(
        { tenant: "a#b", orderId: "o1" },
        [new ItemAdded({ amount: 4 })],
        0,
      )
      const [ok] = yield* TenantOrders.read({ tenant: "acme", orderId: "o1" })
      const [ambiguous] = yield* TenantOrders.read({ tenant: "a#b", orderId: "o1" })
      expect(ok!.streamId).toBe("acme#o1")
      const applied = yield* projection.apply(ok!)
      expect(applied.state).toEqual(
        Option.some({ tenant: "acme", orderId: "o1", total: 3, seq: 1 }),
      )
      const error = yield* Effect.flip(projection.apply(ambiguous!))
      expect(error).toBeInstanceOf(ValidationError)
      expect(String((error as ValidationError).cause)).toContain("ambiguous")
      // catchUp takes the structured id, so it is never ambiguous.
      const caught = yield* projection.catchUp({ tenant: "a#b", orderId: "o1" })
      expect(caught.state).toEqual(Option.some({ tenant: "a#b", orderId: "o1", total: 4, seq: 1 }))
    }).pipe(Effect.provide(TestLayer)),
  )
})

// ---------------------------------------------------------------------------
// catchUp / rebuild
// ---------------------------------------------------------------------------

describe("EventStore.projection — catchUp and rebuild", () => {
  it.effect("catchUp applies from the checkpoint to the head", () =>
    Effect.gen(function* () {
      const events = yield* seed("o1", [
        new OrderPlaced({ amount: 10 }),
        new ItemAdded({ amount: 5 }),
        new OrderShipped({}),
      ])
      yield* SummaryProjection.apply(events[0]!)
      resetCalls()
      const caught = yield* SummaryProjection.catchUp({ orderId: "o1" })
      expect(versions(caught.applied)).toEqual([2, 3])
      expect(caught.version).toBe(3)
      expect(Option.getOrThrow(caught.state).status).toBe("shipped")
      // The head (to find its row), then the row's range.
      expect(calls).toEqual({ query: 2, getItem: 1, putItem: 1 })
      resetCalls()
      const again = yield* SummaryProjection.catchUp({ orderId: "o1" })
      expect(again.applied).toEqual([])
      expect(calls.putItem).toBe(0)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("catchUp of a stream with no events and no row returns none", () =>
    Effect.gen(function* () {
      const caught = yield* SummaryProjection.catchUp({ orderId: "nothing" })
      expect(caught).toEqual({
        key: Option.none(),
        applied: [],
        rejected: [],
        skipped: [],
        state: Option.none(),
        version: 0,
        removed: false,
      })
      expect(calls.putItem).toBe(0)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("rebuild folds from version 1, ignoring the row's state", () =>
    Effect.gen(function* () {
      const events = yield* seed("o1", [
        new OrderPlaced({ amount: 10 }),
        new ItemAdded({ amount: 5 }),
      ])
      yield* SummaryProjection.applyBatch(events)
      // Corrupt the row: a rebuild must not start from it.
      const key = summaryKey("o1")
      store.set(key, { ...store.get(key)!, ...toAttributeMap({ total: 999 }) })
      resetCalls()
      const { rows } = yield* SummaryProjection.rebuild({ orderId: "o1" })
      expect(rows).toHaveLength(1)
      expect(rows[0]!.key).toEqual({ orderId: "o1" })
      expect(rows[0]!.version).toBe(2)
      expect(Option.getOrThrow(rows[0]!.state).total).toBe(15)
      expect(evolved).toEqual([1, 2])
      expect((yield* rowOf("o1")).total).toBe(15)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("rebuild of a stream with no events writes nothing", () =>
    Effect.gen(function* () {
      const rebuilt = yield* SummaryProjection.rebuild({ orderId: "nothing" })
      expect(rebuilt).toEqual({ rows: [] })
      expect(calls.putItem).toBe(0)
    }).pipe(Effect.provide(TestLayer)),
  )
})

// ---------------------------------------------------------------------------
// processBatch / batchResponse
// ---------------------------------------------------------------------------

/** A Lambda-shaped record carrying `event`'s item, as stored, in DynamoDB JSON. */
const recordOf = (sequence: number, item: Item, eventName = "INSERT"): EventStore.StreamRecord => ({
  eventID: `id-${sequence}`,
  eventName,
  dynamodb: { SequenceNumber: String(sequence).padStart(6, "0"), NewImage: item as never },
})

const itemsOf = (streamPk: string) =>
  [...store.entries()]
    .filter(([key]) => key.startsWith(`events|${streamPk}|`))
    .map(([, item]) => item)
    .filter((item) => item.__edd_e__?.S === "order.event")
    .sort((a, b) => (a.sk!.S! < b.sk!.S! ? -1 : 1))

describe("EventStore.projection — processBatch", () => {
  it.effect("decodes, applies and reports the earliest record of each failed instance", () =>
    Effect.gen(function* () {
      yield* seed("o1", [new OrderPlaced({ amount: 10 }), new ItemAdded({ amount: 5 })])
      yield* Orders.append({ orderId: "o2" }, [new OrderPlaced({ amount: 1 }), new Rejected({})], 0)
      const [o1v1, o1v2] = itemsOf("$proj#v1#order#o1")
      const [o2v1, o2v2] = itemsOf("$proj#v1#order#o2")
      const records = [
        recordOf(1, o1v2!),
        recordOf(2, { pk: { S: "x" }, sk: { S: "y" }, __edd_e__: { S: "order.snapshot" } }),
        recordOf(3, o2v2!),
        recordOf(4, o1v1!, "MODIFY"),
        recordOf(5, o2v1!),
      ]
      const result = yield* SummaryProjection.processBatch(records, { source: "lambda" })
      expect(result.outcomes.map((o) => [o.streamId, o._tag])).toEqual([
        ["o1", "Applied"],
        ["o2", "Failed"],
      ])
      // o1's version 1 came only as a MODIFY (skipped), so it was read from the store.
      const applied = result.outcomes[0]!
      if (applied._tag !== "Applied") throw new Error("not applied")
      expect(versions(applied.applied)).toEqual([1, 2])
      // Positions index the records: the MODIFY and the snapshot are skipped.
      expect(result.outcomes.map((o) => o.positions)).toEqual([[0], [2, 4]])
      expect(result.failedRecords).toEqual([records[2]])
      expect(result.response).toEqual({ batchItemFailures: [{ itemIdentifier: "000003" }] })
      const pipe = yield* SummaryProjection.processBatch(records, { source: "pipe" })
      expect(pipe.response).toEqual({ batchItemFailures: [{ itemIdentifier: "id-3" }] })
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("reports a record that fails to decode", () =>
    Effect.gen(function* () {
      const poison = recordOf(7, {
        pk: { S: "$proj#v1#order#o9" },
        sk: { S: "$proj#v1#order.event#000000001" },
        __edd_e__: { S: "order.event" },
        version: { S: "not a number" },
      })
      const result = yield* SummaryProjection.processBatch([poison], { source: "lambda" })
      expect(result.decodeFailures).toHaveLength(1)
      expect(result.decodeFailures[0]!.error).toBeInstanceOf(ValidationError)
      expect(result.response).toEqual({ batchItemFailures: [{ itemIdentifier: "000007" }] })
      // Skipped: still in decodeFailures, not reported.
      const skipped = yield* SummaryProjection.processBatch([poison], {
        source: "lambda",
        onDecodeFailure: "skip",
      })
      expect(skipped.decodeFailures).toHaveLength(1)
      expect(skipped.response).toEqual({ batchItemFailures: [] })
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("reads a record shape of its own through image and identifier accessors", () =>
    Effect.gen(function* () {
      yield* seed("o1", [new OrderPlaced({ amount: 10 }), new Rejected({})])
      const [v1, v2] = itemsOf("$proj#v1#order#o1")
      const records = [
        { eventData: v2!, eventID: "e-2" },
        { eventData: undefined, eventID: "e-x" },
        { eventData: v1!, eventID: "e-1" },
      ]
      const result = yield* SummaryProjection.processBatch(records, {
        image: (record) => record.eventData as never,
        identifier: (record) => record.eventID,
      })
      expect(result.outcomes.map((o) => [o._tag, o.positions])).toEqual([["Failed", [0, 2]]])
      expect(result.response).toEqual({ batchItemFailures: [{ itemIdentifier: "e-2" }] })
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("fails with StreamRecordIdentifierMissing for a failed record without one", () =>
    Effect.gen(function* () {
      yield* seed("o1", [new Rejected({})])
      const [v1] = itemsOf("$proj#v1#order#o1")
      const error = yield* Effect.flip(
        SummaryProjection.processBatch([{ dynamodb: { NewImage: v1! as never } }], {
          source: "lambda",
        }),
      )
      expect(error).toEqual(
        new StreamRecordIdentifierMissing({ index: 0, member: "dynamodb.SequenceNumber" }),
      )
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("batchResponse identifies records per source and fails on a missing identifier", () =>
    Effect.gen(function* () {
      const record = recordOf(42, {})
      expect(yield* EventStore.batchResponse([record], { source: "lambda" })).toEqual({
        batchItemFailures: [{ itemIdentifier: "000042" }],
      })
      expect(yield* EventStore.batchResponse([record], { source: "pipe" })).toEqual({
        batchItemFailures: [{ itemIdentifier: "id-42" }],
      })
      expect(yield* EventStore.batchResponse([{ id: "x" }], { identifier: (r) => r.id })).toEqual({
        batchItemFailures: [{ itemIdentifier: "x" }],
      })
      expect(yield* EventStore.batchResponse([], { source: "lambda" })).toEqual({
        batchItemFailures: [],
      })
      expect(
        yield* Effect.flip(
          EventStore.batchResponse([record, { dynamodb: {} }], { source: "lambda" }),
        ),
      ).toEqual(new StreamRecordIdentifierMissing({ index: 1, member: "dynamodb.SequenceNumber" }))
      expect(yield* Effect.flip(EventStore.batchResponse([{}], { source: "pipe" }))).toEqual(
        new StreamRecordIdentifierMissing({ index: 0, member: "eventID" }),
      )
    }),
  )
})

// ---------------------------------------------------------------------------
// decoder / eventFilterPattern / parseStreamId
// ---------------------------------------------------------------------------

describe("EventStore.decoder and eventFilterPattern", () => {
  it.effect("dispatches across streams and returns none for other items", () =>
    Effect.gen(function* () {
      yield* seed("o1", [new OrderPlaced({ amount: 10 })])
      yield* Payments.append({ paymentId: "p1" }, [new ItemAdded({ amount: 2 })], 0)
      const decode = EventStore.decoder({ Order: Orders, Payment: Payments })
      const [order] = itemsOf("$proj#v1#order#o1")
      const payment = [...store.values()].find((i) => i.__edd_e__?.S === "payment.event")!
      const decodedOrder = Option.getOrThrow(yield* decode(order as never))
      expect(decodedOrder.stream).toBe("Order")
      expect(decodedOrder.event.data).toEqual(new OrderPlaced({ amount: 10 }))
      const decodedPayment = Option.getOrThrow(yield* decode(payment as never))
      expect(decodedPayment.stream).toBe("Payment")
      if (decodedPayment.stream === "Payment") {
        expect(decodedPayment.event.data).toEqual(new ItemAdded({ amount: 2 }))
      }
      expect(yield* decode({ __edd_e__: { S: "order.snapshot" } } as never)).toEqual(Option.none())
      expect(yield* decode({ __edd_e__: { S: "ordersummary" } } as never)).toEqual(Option.none())
    }).pipe(Effect.provide(TestLayer)),
  )

  it("refuses two streams with the same event marker", () => {
    const Twin = EventStore.makeStream({
      table: EventsTable,
      streamName: "ORDER",
      events: [OrderPlaced],
      streamId: { composite: ["orderId"] },
    })
    expect(() => EventStore.decoder({ Order: Orders, Twin })).toThrow(/\[EDD-9082\].*order\.event/)
  })

  it("builds the filter pattern for event inserts", () => {
    expect(EventStore.eventFilterPattern([Orders, Payments])).toEqual({
      eventName: ["INSERT"],
      dynamodb: { NewImage: { __edd_e__: { S: ["order.event", "payment.event"] } } },
    })
    expect(EventStore.eventFilterPattern({ Orders })).toEqual({
      eventName: ["INSERT"],
      dynamodb: { NewImage: { __edd_e__: { S: ["order.event"] } } },
    })
  })

  it.effect("parseStreamId recovers fields and refuses an ambiguous id", () =>
    Effect.gen(function* () {
      expect(Orders.streamIdFields).toEqual(["orderId"])
      expect(Orders.eventMarker).toBe("order.event")
      expect(yield* Orders.parseStreamId("a#b")).toEqual({ orderId: "a#b" })
      expect(yield* TenantOrders.parseStreamId("acme#o1")).toEqual({
        tenant: "acme",
        orderId: "o1",
      })
      const error = yield* Effect.flip(TenantOrders.parseStreamId("a#b#o1"))
      expect(error).toBeInstanceOf(ValidationError)
    }),
  )
})

// ---------------------------------------------------------------------------
// Definition checks and binding
// ---------------------------------------------------------------------------

describe("EventStore.projection — definition and binding", () => {
  const base = {
    stream: Orders,
    key: (id: { readonly orderId: string }) => ({ orderId: id.orderId }),
    initial: (id: { readonly orderId: string }) => ({
      orderId: id.orderId,
      status: "new",
      total: 0,
      lines: 0,
      version: 0,
    }),
    evolve: (state: typeof OrderSummary.Type) => Effect.succeed(state),
  }

  it("refuses versioned, softDelete and timeSeries read models, a missing field and a fractional offset", () => {
    const entity = (extra: object) =>
      Entity.make({
        model: OrderSummary,
        entityType: "OrderSummary",
        primaryKey: {
          pk: { field: "pk", composite: ["orderId"] },
          sk: { field: "sk", composite: [] },
        },
        ...extra,
      })
    expect(() =>
      EventStore.projection({
        ...base,
        readModel: entity({ versioned: true }),
        checkpoint: "version",
      } as never),
    ).toThrow(/\[EDD-9081\].*versioned/)
    expect(() =>
      EventStore.projection({
        ...base,
        readModel: entity({ softDelete: true }),
        checkpoint: "version",
      } as never),
    ).toThrow(/\[EDD-9081\].*softDelete/)
    expect(() =>
      EventStore.projection({
        ...base,
        readModel: { ...OrderSummaries, timeSeries: { orderBy: "at" } },
        checkpoint: "version",
      } as never),
    ).toThrow(/\[EDD-9081\].*timeSeries/)
    expect(() =>
      EventStore.projection({ ...base, readModel: OrderSummaries, checkpoint: "missing" as never }),
    ).toThrow(/\[EDD-9081\].*"missing"/)
    expect(() =>
      EventStore.projection({
        ...base,
        readModel: OrderSummaries,
        checkpoint: { field: "version", offset: 0.5 },
      }),
    ).toThrow(/\[EDD-9081\].*offset/)
  })

  it("types the checkpoint as a numeric field and the requirements of each form", () => {
    // Type-checked only, never run.
    const _typesOnly = () => {
      EventStore.projection({
        ...base,
        readModel: OrderSummaries,
        // @ts-expect-error — `status` is a string field
        checkpoint: "status",
      })
      EventStore.projection({
        ...base,
        readModel: OrderSummaries,
        // @ts-expect-error — not a field of the read model
        checkpoint: { field: "missing", offset: 1 },
      })
    }
    void _typesOnly
    // The unbound operations need the client and the tables.
    type Needs = Effect.Services<ReturnType<typeof SummaryProjection.apply>>
    const needs: [Needs] extends [DynamoClient | Table.TableConfig] ? true : false = true
    expect(needs).toBe(true)
  })

  it.effect("bindProjection resolves the services (R = never)", () =>
    Effect.gen(function* () {
      const events = yield* seed("o1", [new OrderPlaced({ amount: 10 })])
      const bound = yield* EventStore.bindProjection(SummaryProjection)
      const applied: Effect.Effect<unknown, unknown, never> = bound.apply(events[0]!)
      const outcome = yield* bound.apply(events[0]!)
      void applied
      expect(versions(outcome.applied)).toEqual([1])
    }).pipe(Effect.provide(TestLayer)),
  )
})

// ---------------------------------------------------------------------------
// Rows keyed by event fields (one stream feeding several rows)
// ---------------------------------------------------------------------------

class Placed extends Schema.TaggedClass<Placed>()("Placed", { zone: Schema.String }) {}
class Reading extends Schema.TaggedClass<Reading>()("Reading", {
  zone: Schema.String,
  value: Schema.Number,
}) {}

const Devices = EventStore.makeStream({
  table: EventsTable,
  streamName: "Device",
  events: [Placed, Reading],
  streamId: { composite: ["deviceId"] },
})

class NotPlaced extends Data.TaggedError("NotPlaced")<{ readonly version: number }> {}
class Negative extends Data.TaggedError("Negative")<{ readonly version: number }> {}

/** A zone row starts with `Placed`; a reading of a zone never placed is rejected. */
const ZoneProjection = EventStore.projection({
  stream: Devices,
  readModel: ZoneTotals,
  key: (id, event) => ({ deviceId: id.deviceId, zone: event.data.zone }),
  initial: (id, event) => ({
    deviceId: id.deviceId,
    zone: event.data.zone,
    total: 0,
    readings: -1, // not placed yet
    seq: 0,
  }),
  evolve: (state, event) =>
    Effect.gen(function* () {
      const data = event.data
      if (data._tag === "Placed") return { ...state, readings: 0 }
      if (state.readings < 0) return yield* new NotPlaced({ version: event.version })
      if (data.value < 0) return yield* new Negative({ version: event.version })
      return { ...state, total: state.total + data.value, readings: state.readings + 1 }
    }),
  checkpoint: "seq",
  terminal: (error) => error._tag === "NotPlaced" || error._tag === "Negative",
})

const seedDevice = (deviceId: string, events: ReadonlyArray<Placed | Reading>) =>
  Effect.gen(function* () {
    yield* Devices.append({ deviceId }, events, 0)
    const read = yield* Devices.read({ deviceId })
    resetCalls()
    return read
  })

const zoneRow = (deviceId: string, zone: string) => ZoneTotals.get({ deviceId, zone }).asEffect()

describe("EventStore.projection — rows keyed by event fields", () => {
  it.effect("folds each row from its own events, keeping each row's checkpoint", () =>
    Effect.gen(function* () {
      const events = yield* seedDevice("d1", [
        new Placed({ zone: "a" }),
        new Reading({ zone: "a", value: 5 }),
        new Placed({ zone: "b" }),
        new Reading({ zone: "b", value: 7 }),
        new Reading({ zone: "a", value: 1 }),
      ])
      const result = yield* ZoneProjection.applyBatch(events)
      expect(
        result.outcomes.map((o) =>
          o._tag === "Applied" ? [o.key, versions(o.applied), o.version] : o._tag,
        ),
      ).toEqual([
        [{ deviceId: "d1", zone: "a" }, [1, 2, 5], 5],
        [{ deviceId: "d1", zone: "b" }, [3, 4], 4],
      ])
      // Each row's gaps (a: 3–4, b: 1–2) are the other row's events in the batch: no read.
      expect(calls.query).toBe(0)
      expect(yield* zoneRow("d1", "a")).toMatchObject({ total: 6, readings: 2, seq: 5 })
      expect(yield* zoneRow("d1", "b")).toMatchObject({ total: 7, readings: 1, seq: 4 })
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("fills a row's gap with only its own events, skipping the other rows'", () =>
    Effect.gen(function* () {
      const events = yield* seedDevice("d1", [
        new Placed({ zone: "a" }),
        new Placed({ zone: "b" }),
        new Reading({ zone: "a", value: 5 }),
        new Reading({ zone: "b", value: 7 }),
      ])
      // Only version 4 arrives: zone b reads 1–4 and folds 2 and 4.
      const b = yield* ZoneProjection.apply(events[3]!)
      expect(versions(b.applied)).toEqual([2, 4])
      expect(b.version).toBe(4)
      // Zone a, delivered later, starts from its own (absent) row.
      const a = yield* ZoneProjection.apply(events[2]!)
      expect(versions(a.applied)).toEqual([1, 3])
      expect(Option.getOrThrow(a.state)).toMatchObject({ total: 5, seq: 3 })
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("rejects a reading of a zone never placed without creating the row", () =>
    Effect.gen(function* () {
      const events = yield* seedDevice("d1", [
        new Reading({ zone: "a", value: 5 }),
        new Placed({ zone: "a" }),
        new Reading({ zone: "a", value: 2 }),
      ])
      const first = yield* ZoneProjection.apply(events[0]!)
      expect(first.applied).toEqual([])
      expect(first.rejected.map((r) => [r.event.version, r.error])).toEqual([
        [1, new NotPlaced({ version: 1 })],
      ])
      expect(first.state).toEqual(Option.none())
      expect(calls.putItem).toBe(0)
      // The placing event starts the row; the earlier reading is rejected again.
      const placed = yield* ZoneProjection.applyBatch(events.slice(1))
      const outcome = placed.outcomes[0]!
      if (outcome._tag !== "Applied") throw new Error("not applied")
      expect(versions(outcome.applied)).toEqual([2, 3])
      expect(outcome.rejected.map((r) => r.event.version)).toEqual([1])
      expect(Option.getOrThrow(outcome.state)).toMatchObject({ total: 2, readings: 1, seq: 3 })
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("advances an existing row's checkpoint past a rejected event", () =>
    Effect.gen(function* () {
      const events = yield* seedDevice("d1", [
        new Placed({ zone: "a" }),
        new Reading({ zone: "a", value: -1 }),
      ])
      yield* ZoneProjection.apply(events[0]!)
      resetCalls()
      const rejected = yield* ZoneProjection.apply(events[1]!)
      expect(rejected.applied).toEqual([])
      expect(rejected.rejected.map((r) => r.error)).toEqual([new Negative({ version: 2 })])
      expect(rejected.version).toBe(2)
      expect(calls.putItem).toBe(1)
      // Redelivered, it is already applied: not rejected again.
      const again = yield* ZoneProjection.apply(events[1]!)
      expect(again.rejected).toEqual([])
      expect(versions(again.alreadyApplied)).toEqual([2])
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("a non-terminal failure fails the row and writes nothing", () =>
    Effect.gen(function* () {
      const strict = EventStore.projection({
        stream: Devices,
        readModel: ZoneTotals,
        key: (id, event) => ({ deviceId: id.deviceId, zone: event.data.zone }),
        initial: (id, event) => ({
          deviceId: id.deviceId,
          zone: event.data.zone,
          total: 0,
          readings: -1,
          seq: 0,
        }),
        evolve: (state, event) =>
          event.data._tag === "Reading" && state.readings < 0
            ? Effect.fail(new NotPlaced({ version: event.version }))
            : Effect.succeed({ ...state, readings: 0 }),
        checkpoint: "seq",
      })
      const [reading] = yield* seedDevice("d1", [new Reading({ zone: "a", value: 5 })])
      const error = yield* Effect.flip(strict.apply(reading!))
      expect(error).toEqual(new NotPlaced({ version: 1 }))
      expect(calls.putItem).toBe(0)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("catchUp brings the latest event's row to the head; rebuild re-derives every row", () =>
    Effect.gen(function* () {
      const events = yield* seedDevice("d1", [
        new Placed({ zone: "a" }),
        new Placed({ zone: "b" }),
        new Reading({ zone: "a", value: 5 }),
        new Reading({ zone: "b", value: 7 }),
      ])
      yield* ZoneProjection.apply(events[0]!)
      const caught = yield* ZoneProjection.catchUp({ deviceId: "d1" })
      expect(caught.key).toEqual(Option.some({ deviceId: "d1", zone: "b" }))
      expect(versions(caught.applied)).toEqual([2, 4])
      const { rows } = yield* ZoneProjection.rebuild({ deviceId: "d1" })
      expect(rows.map((r) => [r.key, r.version, Option.getOrThrow(r.state).total])).toEqual([
        [{ deviceId: "d1", zone: "a" }, 3, 5],
        [{ deviceId: "d1", zone: "b" }, 4, 7],
      ])
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("a throwing key fails its stream instance only", () =>
    Effect.gen(function* () {
      const throwing = EventStore.projection({
        stream: Devices,
        readModel: ZoneTotals,
        key: (id, event) => {
          if (id.deviceId === "bad") throw new Error("no zone")
          return { deviceId: id.deviceId, zone: event.data.zone }
        },
        initial: (id, event) => ({
          deviceId: id.deviceId,
          zone: event.data.zone,
          total: 0,
          readings: 0,
          seq: 0,
        }),
        evolve: (state) => Effect.succeed(state),
        checkpoint: "seq",
      })
      const [bad] = yield* seedDevice("bad", [new Placed({ zone: "a" })])
      const [good] = yield* seedDevice("good", [new Placed({ zone: "a" })])
      const result = yield* throwing.applyBatch([bad!, good!])
      expect(result.outcomes.map((o) => [o.streamId, o._tag])).toEqual([
        ["bad", "Failed"],
        ["good", "Applied"],
      ])
      const failed = result.outcomes[0]!
      if (failed._tag !== "Failed") throw new Error("not failed")
      expect(failed.key).toBeUndefined()
      expect(failed.error).toBeInstanceOf(ValidationError)
    }).pipe(Effect.provide(TestLayer)),
  )
})

// ---------------------------------------------------------------------------
// Hidden fields, toItem, races
// ---------------------------------------------------------------------------

describe("EventStore.projection — Hidden fields, toItem and races", () => {
  it.effect("an unchanged state keeps its Hidden fields through the whole-row put", () =>
    Effect.gen(function* () {
      const projection = EventStore.projection({
        stream: Orders,
        readModel: TaggedSummaries,
        key: (id) => ({ orderId: id.orderId }),
        initial: (id) => ({
          orderId: id.orderId,
          status: "new",
          total: 0,
          version: 0,
          searchKey: `order#${id.orderId}`,
        }),
        evolve: (state) => Effect.succeed(state),
        checkpoint: "version",
      })
      const events = yield* seed("o1", [new OrderPlaced({ amount: 10 }), new OrderShipped({})])
      yield* projection.apply(events[0]!)
      const second = yield* projection.apply(events[1]!)
      expect(second.version).toBe(2)
      expect(store.get(summaryKey("o1"))!.searchKey).toEqual({ S: "order#o1" })
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("keeps Hidden fields across writes and recomputes them with toItem", () =>
    Effect.gen(function* () {
      const projection = EventStore.projection({
        stream: Orders,
        readModel: TaggedSummaries,
        key: (id) => ({ orderId: id.orderId }),
        initial: (id) => ({
          orderId: id.orderId,
          status: "new",
          total: 0,
          version: 0,
          searchKey: "",
        }),
        // Ignores every event but OrderPlaced — the state comes back unchanged.
        evolve: (state, event) =>
          Effect.succeed(
            event.data._tag === "OrderPlaced"
              ? { ...state, status: "placed", total: event.data.amount }
              : state,
          ),
        checkpoint: "version",
        toItem: (state) => ({ ...state, searchKey: `${state.status}#${state.version}` }),
      })
      const events = yield* seed("o1", [new OrderPlaced({ amount: 10 }), new OrderShipped({})])
      yield* projection.apply(events[0]!)
      const second = yield* projection.apply(events[1]!)
      expect(second.version).toBe(2)
      const stored = store.get(summaryKey("o1"))!
      expect(stored.searchKey).toEqual({ S: "placed#2" })
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("retries lost races under the default policy", () =>
    Effect.gen(function* () {
      const events = yield* seed("o1", [
        new OrderPlaced({ amount: 10 }),
        new ItemAdded({ amount: 1 }),
      ])
      yield* SummaryProjection.apply(events[0]!)
      resetCalls()
      rejectNextPuts = 4
      // The default policy sleeps (jittered) between attempts: run it on the test clock.
      const fiber = yield* Effect.forkChild(SummaryProjection.apply(events[1]!))
      yield* TestClock.adjust("10 seconds")
      const outcome = yield* Fiber.join(fiber)
      expect(versions(outcome.applied)).toEqual([2])
      expect(calls.putItem).toBe(5)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("does not retry a ConcurrentModification that evolve raises", () =>
    Effect.gen(function* () {
      const projection = EventStore.projection({
        stream: Orders,
        readModel: OrderSummaries,
        key: (id) => ({ orderId: id.orderId }),
        initial: (id) => ({ orderId: id.orderId, status: "new", total: 0, lines: 0, version: 0 }),
        evolve: () =>
          Effect.fail(
            new ConcurrentModification({
              entityType: "Other",
              key: {},
              attributes: [],
              current: Option.none(),
            }),
          ),
        checkpoint: "version",
      })
      const [event] = yield* seed("o1", [new OrderPlaced({ amount: 1 })])
      const error = yield* Effect.flip(projection.apply(event!))
      expect(error).toBeInstanceOf(ConcurrentModification)
      expect((error as ConcurrentModification).entityType).toBe("Other")
      expect(calls.getItem).toBe(1)
    }).pipe(Effect.provide(TestLayer)),
  )
})

// ---------------------------------------------------------------------------
// One feed, several projections
// ---------------------------------------------------------------------------

const PaymentProjection = EventStore.projection({
  stream: Payments,
  readModel: PaymentTotals,
  key: (id) => ({ paymentId: id.paymentId }),
  initial: (id) => ({ paymentId: id.paymentId, total: 0, n: 0 }),
  evolve: (state, event) => Effect.succeed({ ...state, total: state.total + event.data.amount }),
  checkpoint: "n",
})

describe("EventStore.processBatch — several projections", () => {
  it.effect("routes each stream's records to its projections and answers once", () =>
    Effect.gen(function* () {
      yield* seed("o1", [new OrderPlaced({ amount: 10 }), new Rejected({})])
      yield* Payments.append({ paymentId: "p1" }, [new ItemAdded({ amount: 2 })], 0)
      yield* TenantOrders.append({ tenant: "t", orderId: "x" }, [new ItemAdded({ amount: 1 })], 0)
      const [o1, o2] = itemsOf("$proj#v1#order#o1")
      const payment = [...store.values()].find((i) => i.__edd_e__?.S === "payment.event")!
      const unprojected = [...store.values()].find((i) => i.__edd_e__?.S === "tenantorder.event")!
      const records = [
        recordOf(1, unprojected),
        recordOf(2, payment),
        recordOf(3, o2!),
        recordOf(4, o1!),
      ]
      const result = yield* EventStore.processBatch(records, {
        projections: { orders: SummaryProjection, payments: PaymentProjection },
        source: "lambda",
      })
      expect(result.outcomes.payments.map((o) => [o._tag, o.positions])).toEqual([["Applied", [1]]])
      expect(result.outcomes.orders.map((o) => [o._tag, o.positions])).toEqual([["Failed", [2, 3]]])
      expect(result.response).toEqual({ batchItemFailures: [{ itemIdentifier: "000003" }] })
    }).pipe(Effect.provide(TestLayer)),
  )
})

// ---------------------------------------------------------------------------
// Events that address no row
// ---------------------------------------------------------------------------

/** Readings of the "void" zone address no row. */
const SometimesZoned = EventStore.projection({
  stream: Devices,
  readModel: ZoneTotals,
  key: (id, event) =>
    event.data.zone === "void"
      ? Option.none()
      : Option.some({ deviceId: id.deviceId, zone: event.data.zone }),
  initial: (id, event) => ({
    deviceId: id.deviceId,
    zone: event.data.zone,
    total: 0,
    readings: 0,
    seq: 0,
  }),
  evolve: (state, event) =>
    Effect.succeed(
      event.data._tag === "Reading" ? { ...state, total: state.total + event.data.value } : state,
    ),
  checkpoint: "seq",
})

describe("EventStore.projection — events that address no row", () => {
  it.effect("acknowledges them without touching a row", () =>
    Effect.gen(function* () {
      const events = yield* seedDevice("d1", [
        new Placed({ zone: "a" }),
        new Reading({ zone: "void", value: 9 }),
        new Reading({ zone: "a", value: 2 }),
      ])
      const ignored = yield* SometimesZoned.apply(events[1]!)
      expect(ignored).toEqual(Option.none())
      expect(calls).toEqual({ query: 0, getItem: 0, putItem: 0 })
      const batch = yield* SometimesZoned.applyBatch([events[2]!, events[1]!, events[0]!])
      expect(batch.ignored).toEqual([1])
      expect(batch.outcomes).toHaveLength(1)
      const outcome = batch.outcomes[0]!
      if (outcome._tag !== "Applied") throw new Error("not applied")
      expect(versions(outcome.applied)).toEqual([1, 3])
      expect(Option.getOrThrow(outcome.state)).toMatchObject({ total: 2, seq: 3 })
      // Delivered in the batch, the ignored event counts toward contiguity.
      expect(calls.query).toBe(0)
      const applied = yield* SometimesZoned.apply(events[2]!)
      expect(Option.getOrThrow(applied).alreadyApplied.map((e) => e.version)).toEqual([3])
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("a gap read skips them", () =>
    Effect.gen(function* () {
      const events = yield* seedDevice("d1", [
        new Placed({ zone: "a" }),
        new Reading({ zone: "void", value: 9 }),
        new Reading({ zone: "a", value: 2 }),
      ])
      const applied = Option.getOrThrow(yield* SometimesZoned.apply(events[2]!))
      expect(versions(applied.applied)).toEqual([1, 3])
      expect(calls.query).toBe(1)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("runs through EventStore.processBatch, typed", () =>
    Effect.gen(function* () {
      yield* seedDevice("d1", [new Placed({ zone: "a" }), new Reading({ zone: "void", value: 9 })])
      const records = [...store.entries()]
        .filter(([k]) => k.startsWith("events|") && store.get(k)!.__edd_e__?.S === "device.event")
        .map(([, item], i) => recordOf(i + 1, item))
      const result = yield* EventStore.processBatch(records, {
        projections: { zones: SometimesZoned, orders: SummaryProjection },
        source: "lambda",
      })
      // Outcomes keep their types; requirements are the unbound projections'.
      const zones: ReadonlyArray<
        EventStore.ProjectionOutcome<
          typeof ZoneTotal.Type,
          Placed | Reading,
          Record<string, unknown> | undefined,
          unknown,
          unknown,
          never
        >
      > = result.outcomes.zones
      expect(zones.map((o) => [o._tag, o.positions])).toEqual([["Applied", [0]]])
      type Needs = EventStore.ProjectionRequirementsOf<typeof SometimesZoned>
      const needs: [Needs] extends [never] ? false : true = true
      expect(needs).toBe(true)
      const bound = yield* EventStore.bindProjection(SometimesZoned)
      const viaBound = yield* EventStore.processBatch(records, {
        projections: { zones: bound },
        source: "lambda",
      })
      const run: Effect.Effect<unknown, unknown, never> = EventStore.processBatch(records, {
        projections: { zones: bound },
        source: "lambda",
      })
      void run
      expect(viaBound.response).toEqual({ batchItemFailures: [] })
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("catchUp walks back past them; rebuild leaves them out", () =>
    Effect.gen(function* () {
      yield* seedDevice("d1", [
        new Placed({ zone: "a" }),
        new Reading({ zone: "a", value: 2 }),
        new Reading({ zone: "void", value: 9 }),
      ])
      const caught = yield* SometimesZoned.catchUp({ deviceId: "d1" })
      expect(caught.key).toEqual(Option.some({ deviceId: "d1", zone: "a" }))
      expect(versions(caught.applied)).toEqual([1, 2])
      const { rows } = yield* SometimesZoned.rebuild({ deviceId: "d1" })
      expect(rows.map((r) => [r.key, r.version])).toEqual([[{ deviceId: "d1", zone: "a" }, 2]])
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("a duplicate marker in a multi-projection batch is a defect inside the effect", () =>
    Effect.gen(function* () {
      const Twin = EventStore.makeStream({
        table: EventsTable,
        streamName: "ORDER",
        events: [OrderPlaced],
        streamId: { composite: ["orderId"] },
      })
      // Building the effect does not throw…
      const run = EventStore.processBatch([], {
        projections: { orders: SummaryProjection },
        streams: { Twin },
        source: "lambda",
      })
      // …running it dies.
      const exit = yield* Effect.exit(run)
      expect(String(exit)).toContain("EDD-9082")
    }).pipe(Effect.provide(TestLayer)),
  )
})
