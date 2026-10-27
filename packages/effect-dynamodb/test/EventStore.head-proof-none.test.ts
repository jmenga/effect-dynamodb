/**
 * `headProof: "none"` and the single-item append fast path (#173), against a
 * mocked `DynamoClient` that classifies AWS errors as the real one does.
 *
 * - `"none"`: no contiguity check at any version; the event puts still
 *   reject a stale `expectedVersion`; a writer that loaded before a seal still
 *   gets `StreamSealed`, and one that loaded after it is not stopped (the
 *   caller's duty); it combines with the other options.
 * - Refusals: `commandHandler` (`ValidationError`, nothing read or written)
 *   and a nested `appendOp`.
 * - The fast path: a `PutItem` exactly when the request is the append's one
 *   event, and a transaction otherwise.
 * - Its error mapping, case by case, against the transaction's verdict for the
 *   same failure.
 * - `measureAppend` with `"none"`.
 */

import { describe, expect, it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import {
  DynamoError,
  DynamoValidationError,
  isAwsThrottling,
  isAwsValidationError,
  StreamSealed,
  ThrottlingError,
  TransactionCancelled,
  type ValidationError,
  VersionConflict,
} from "@effect-dynamodb/schema/Errors.js"
import { Effect, Layer, Schema } from "effect"
import { beforeEach, vi } from "vitest"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
import { transactItemBytes } from "../src/internal/ItemSize.js"
import { fromAttributeMap, toAttributeMap } from "../src/Marshaller.js"
import * as Table from "../src/Table.js"
import {
  awsTransactionCanceled,
  awsValidationException,
  DDB_ITEM_SIZE,
  mockDynamoClientLayer,
} from "./helpers/MockDynamoClient.js"

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

const AppSchema = DynamoSchema.make({ name: "ledger", version: 1 })

/** A caller's record, for a `{ additionalItem }` proof and additional items. */
class Balance extends Schema.Class<Balance>("Balance")({
  accountId: Schema.String,
  version: Schema.Number,
}) {}

const Balances = Entity.make({
  model: Balance,
  entityType: "Balance",
  primaryKey: {
    pk: { field: "pk", composite: ["accountId"] },
    sk: { field: "sk", composite: [] },
  },
})

const LedgerTable = Table.make({ schema: AppSchema, entities: { Balances } })

class Deposited extends Schema.TaggedClass<Deposited>()("Deposited", {
  amount: Schema.Number,
}) {}
class Closed extends Schema.TaggedClass<Closed>()("Closed", {
  reason: Schema.String,
}) {}
type LedgerEvent = Deposited | Closed
const events = [Deposited, Closed] as const

const LedgerState = Schema.Struct({ balance: Schema.Number })
type LedgerState = typeof LedgerState.Type

/** No snapshot config. */
const Ledger = EventStore.makeStream({
  table: LedgerTable,
  streamName: "Ledger",
  events,
  streamId: { composite: ["accountId"] },
})
/** `mode: "inline"` without `every`. */
const Inline = EventStore.makeStream({
  table: LedgerTable,
  streamName: "Inline",
  events,
  streamId: { composite: ["accountId"] },
  snapshot: { schema: LedgerState, mode: "inline" },
})
/** With a metadata schema. */
const Noted = EventStore.makeStream({
  table: LedgerTable,
  streamName: "Noted",
  events,
  streamId: { composite: ["accountId"] },
  metadata: Schema.Struct({ note: Schema.String }),
})
/** Another stream, for a nested `appendOp`. */
const Other = EventStore.makeStream({
  table: LedgerTable,
  streamName: "Other",
  events,
  streamId: { composite: ["accountId"] },
})

const decider: EventStore.Decider<LedgerState, { readonly amount: number }, LedgerEvent> = {
  initialState: { balance: 0 },
  decide: (command) => Effect.succeed([new Deposited({ amount: command.amount })]),
  evolve: (state, event) =>
    event._tag === "Deposited" ? { balance: state.balance + event.amount } : state,
}

const id = { accountId: "a-1" }
const deposit = (amount: number) => new Deposited({ amount })
const close = () => new Closed({ reason: "closed" })

// ---------------------------------------------------------------------------
// Mock DynamoClient — errors classified as `DynamoClient` classifies them
// ---------------------------------------------------------------------------

const mockQuery = vi.fn()
const mockTransactWriteItems = vi.fn()
const mockPutItem = vi.fn()

const classify = (operation: string) => (cause: unknown) =>
  isAwsThrottling(cause)
    ? new ThrottlingError({ operation, cause })
    : isAwsValidationError(cause)
      ? new DynamoValidationError({ operation, cause })
      : new DynamoError({ operation, cause })

const TestDynamoClient = mockDynamoClientLayer({
  query: (input) =>
    Effect.tryPromise({
      try: async () => (await mockQuery(input)) ?? { Items: [] },
      catch: classify("Query"),
    }),
  transactWriteItems: (input) =>
    Effect.tryPromise({
      try: async () => (await mockTransactWriteItems(input)) ?? {},
      catch: classify("TransactWriteItems"),
    }),
  putItem: (input) =>
    Effect.tryPromise({
      try: async () => (await mockPutItem(input)) ?? {},
      catch: classify("PutItem"),
    }),
})

const TestLayer = Layer.merge(TestDynamoClient, LedgerTable.layer({ name: "ledger-table" }))

beforeEach(() => {
  vi.resetAllMocks()
})

// ---------------------------------------------------------------------------
// Items and failures
// ---------------------------------------------------------------------------

const eventSk = (label: string, version: number) =>
  DynamoSchema.composeEventVersionKey(AppSchema, `${label}.event`, version)

/** An event item as stored; the sealing one carries the marker. */
const eventItem = (version: number, options: { readonly sealed?: boolean } = {}) =>
  toAttributeMap({
    pk: "$ledger#v1#ledger#a-1",
    sk: eventSk("ledger", version),
    __edd_e__: "ledger.event",
    streamId: "a-1",
    version,
    eventType: options.sealed === true ? "Closed" : "Deposited",
    data:
      options.sealed === true
        ? { _tag: "Closed", reason: "closed" }
        : { _tag: "Deposited", amount: 1 },
    timestamp: "2026-10-22T12:00:00.000Z",
    ...(options.sealed === true ? { __edd_sealed__: true } : {}),
  })

/** A `PutItem`'s failed condition, with the stored item when `ALL_OLD` returned one. */
const putConditionFailed = (item?: unknown) =>
  Object.assign(new Error("The conditional request failed"), {
    name: "ConditionalCheckFailedException",
    ...(item === undefined ? {} : { Item: item }),
  })
const awsError = (name: string, message = name) => Object.assign(new Error(message), { name })

/** What each item of a transaction is: "check", or the `__edd_e__` of its put. */
const kinds = (call = 0): ReadonlyArray<string> =>
  (mockTransactWriteItems.mock.calls[call]![0].TransactItems as ReadonlyArray<any>).map((item) =>
    item.ConditionCheck !== undefined ? "check" : String(fromAttributeMap(item.Put.Item).__edd_e__),
  )

/** The tag and fields of an error, without its `cause` or stack. */
const fieldsOf = (error: unknown) => {
  const {
    cause: _cause,
    stack: _stack,
    message: _message,
    ...fields
  } = error as Record<string, unknown>
  return fields
}

// ---------------------------------------------------------------------------
// headProof: "none"
// ---------------------------------------------------------------------------

describe('append({ headProof: "none" }) (#173)', () => {
  it.effect("writes no contiguity check at a version above 0", () =>
    Effect.gen(function* () {
      const result = yield* Ledger.append(id, [deposit(1), deposit(2)], 3, { headProof: "none" })

      expect(result.version).toBe(5)
      expect(kinds()).toEqual(["ledger.event", "ledger.event"])
      const [first, second] = mockTransactWriteItems.mock.calls[0]![0].TransactItems
      expect(fromAttributeMap(first.Put.Item).version).toBe(4)
      expect(fromAttributeMap(second.Put.Item).version).toBe(5)
      expect(first.Put.ConditionExpression).toBe("attribute_not_exists(pk)")
      expect(first.Put.ReturnValuesOnConditionCheckFailure).toBe("ALL_OLD")
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("without headProof the same append keeps the check", () =>
    Effect.gen(function* () {
      yield* Ledger.append(id, [deposit(1), deposit(2)], 3)
      expect(kinds()).toEqual(["check", "ledger.event", "ledger.event"])
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("a stale expectedVersion is still a VersionConflict, on either path", () =>
    Effect.gen(function* () {
      // One event: the PutItem's own condition fails on the taken slot.
      mockPutItem.mockRejectedValueOnce(putConditionFailed(eventItem(4)))
      const lone = yield* Ledger.append(id, [deposit(1)], 3, { headProof: "none" }).pipe(
        Effect.flip,
      )
      expect(lone).toBeInstanceOf(VersionConflict)
      expect(lone).toMatchObject({ streamName: "Ledger", streamId: "a-1", expectedVersion: 3 })

      // Two events: the transaction's first put fails.
      mockTransactWriteItems.mockRejectedValueOnce(
        awsTransactionCanceled([{ Code: "ConditionalCheckFailed" }, { Code: "None" }]),
      )
      const pair = yield* Ledger.append(id, [deposit(1), deposit(2)], 3, {
        headProof: "none",
      }).pipe(Effect.flip)
      expect(fieldsOf(pair)).toEqual(fieldsOf(lone))
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("a writer that loaded before the seal lands on the sealing event: StreamSealed", () =>
    Effect.gen(function* () {
      // Sealed at 5; the writer read 4 and appends at 4: its put at 5 collides.
      mockPutItem.mockRejectedValueOnce(putConditionFailed(eventItem(5, { sealed: true })))
      const error = yield* Ledger.append(id, [deposit(1)], 4, { headProof: "none" }).pipe(
        Effect.flip,
      )
      expect(error).toBeInstanceOf(StreamSealed)
      expect(error).toMatchObject({ streamName: "Ledger", streamId: "a-1", sealedVersion: 5 })

      // The same through a transaction (two events).
      mockTransactWriteItems.mockRejectedValueOnce(
        awsTransactionCanceled([
          { Code: "ConditionalCheckFailed", Item: eventItem(5, { sealed: true }) } as never,
          { Code: "None" },
        ]),
      )
      const pair = yield* Ledger.append(id, [deposit(1), deposit(2)], 4, {
        headProof: "none",
      }).pipe(Effect.flip)
      expect(fieldsOf(pair)).toEqual(fieldsOf(error))
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect(
    "a writer that loaded after the seal is not stopped: refusing it is the caller's duty",
    () =>
      Effect.gen(function* () {
        // Sealed at 5, the writer read 5. With the check, the event at 5 is
        // checked and refuses; with "none" nothing reads it, and DynamoDB
        // accepts the put at 6.
        const result = yield* Ledger.append(id, [deposit(1)], 5, { headProof: "none" })

        expect(result.version).toBe(6)
        expect(mockTransactWriteItems).not.toHaveBeenCalled()
        expect(mockPutItem).toHaveBeenCalledOnce()
        expect(fromAttributeMap(mockPutItem.mock.calls[0]![0].Item).version).toBe(6)
      }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("combines with the other options; an inline snapshot stays unconditional", () =>
    Effect.gen(function* () {
      yield* Inline.append(id, [deposit(1)], 3, {
        headProof: "none",
        snapshot: { balance: 4 },
        idempotency: { commandId: "cmd-1" },
        additionalItems: [Balances.put({ accountId: "a-1", version: 4 })],
        seal: true,
      })

      expect(kinds()).toEqual(["inline.event", "Balance", "inline.command", "inline.snapshot"])
      const items = mockTransactWriteItems.mock.calls[0]![0].TransactItems
      expect(items[3].Put.ConditionExpression).toBeUndefined()
      expect(fromAttributeMap(items[0].Put.Item).__edd_sealed__).toBe(true)
      expect(fromAttributeMap(items[3].Put.Item).__edd_sealed__).toBe(true)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("a malformed headProof names the accepted shapes, 'none' among them", () =>
    Effect.gen(function* () {
      const error = yield* Ledger.append(id, [deposit(1)], 3, {
        headProof: "None" as never,
      }).pipe(Effect.flip)
      expect(error._tag).toBe("ValidationError")
      expect((error as ValidationError).operation).toBe("EventStore.append.headProof")
      expect(String((error as ValidationError).cause)).toContain(
        'headProof must be "snapshot", "none" or { additionalItem: n }',
      )
      expect(mockPutItem).not.toHaveBeenCalled()
      expect(mockTransactWriteItems).not.toHaveBeenCalled()
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("a nested appendOp refuses it, before anything is sent", () =>
    Effect.gen(function* () {
      const error = yield* Ledger.append(id, [deposit(1)], 0, {
        additionalItems: [Other.appendOp(id, [deposit(1)], 3, { headProof: "none" } as never)],
      }).pipe(Effect.flip)
      expect(error._tag).toBe("ValidationError")
      expect((error as ValidationError).operation).toBe("EventStore.appendOp")
      expect(String((error as ValidationError).cause)).toContain("may not carry headProof")
      expect(mockPutItem).not.toHaveBeenCalled()
      expect(mockTransactWriteItems).not.toHaveBeenCalled()
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("a bound stream accepts it", () =>
    Effect.gen(function* () {
      const bound = yield* EventStore.bind(Ledger)
      const result = yield* bound.append(id, [deposit(1)], 7, { headProof: "none" })
      expect(result.version).toBe(8)
      expect(mockPutItem).toHaveBeenCalledOnce()
      expect(mockTransactWriteItems).not.toHaveBeenCalled()
    }).pipe(Effect.provide(TestLayer)),
  )
})

describe('commandHandler refuses headProof: "none" (#173)', () => {
  it.effect("every call fails with ValidationError before anything is read or written", () =>
    Effect.gen(function* () {
      // Construction does not throw: the refusal is a typed error per call.
      const handle = EventStore.commandHandler(decider, Ledger, {
        headProof: "none" as never,
        retry: 3,
      })
      const error = yield* handle(id, { amount: 1 }).pipe(Effect.flip)

      expect(error._tag).toBe("ValidationError")
      expect((error as ValidationError).operation).toBe("EventStore.commandHandler.headProof")
      expect(String((error as ValidationError).cause)).toContain(
        'commandHandler does not accept headProof: "none"',
      )
      expect(mockQuery).not.toHaveBeenCalled()
      expect(mockPutItem).not.toHaveBeenCalled()
      expect(mockTransactWriteItems).not.toHaveBeenCalled()

      // Data-last, on a bound stream, likewise.
      const bound = yield* EventStore.bind(Ledger)
      const piped = bound.pipe(EventStore.commandHandler(decider, { headProof: "none" as never }))
      const pipedError = yield* piped(id, { amount: 1 }).pipe(Effect.flip)
      expect((pipedError as ValidationError).operation).toBe("EventStore.commandHandler.headProof")
      expect(mockQuery).not.toHaveBeenCalled()
    }).pipe(Effect.provide(TestLayer)),
  )
})

// ---------------------------------------------------------------------------
// The single-item fast path
// ---------------------------------------------------------------------------

describe("the single-item fast path (#173)", () => {
  type Case = readonly [
    name: string,
    run: () => Effect.Effect<unknown, unknown, any>,
    path: "PutItem" | "TransactWriteItems",
  ]
  const record = (version: number) =>
    Balances.put({ accountId: "a-1", version }).pipe(Balances.condition({ version: version - 1 }))
  const cases: ReadonlyArray<Case> = [
    ["one event at version 0", () => Ledger.append(id, [deposit(1)], 0), "PutItem"],
    [
      'one event, headProof: "none"',
      () => Ledger.append(id, [deposit(1)], 3, { headProof: "none" }),
      "PutItem",
    ],
    [
      "one sealing event at version 0",
      () => Ledger.append(id, [close()], 0, { seal: true }),
      "PutItem",
    ],
    [
      "one event at a version above 0",
      () => Ledger.append(id, [deposit(1)], 3),
      "TransactWriteItems",
    ],
    [
      "two events at version 0",
      () => Ledger.append(id, [deposit(1), deposit(2)], 0),
      "TransactWriteItems",
    ],
    [
      "one event with an idempotency sentinel",
      () => Ledger.append(id, [deposit(1)], 0, { idempotency: { commandId: "c-1" } }),
      "TransactWriteItems",
    ],
    [
      "one event with an inline snapshot",
      () => Inline.append(id, [deposit(1)], 0, { snapshot: { balance: 1 } }),
      "TransactWriteItems",
    ],
    [
      "one event with an additional item",
      () => Ledger.append(id, [deposit(1)], 0, { additionalItems: [record(1)] }),
      "TransactWriteItems",
    ],
    [
      "one event with a record head proof",
      () =>
        Ledger.append(id, [deposit(1)], 3, {
          additionalItems: [record(4)],
          headProof: { additionalItem: 0 },
        }),
      "TransactWriteItems",
    ],
    [
      "no event and one additional item",
      () => Ledger.append(id, [], 3, { additionalItems: [record(4)] }),
      "TransactWriteItems",
    ],
  ]

  for (const [name, run, path] of cases) {
    it.effect(`${name}: ${path}`, () =>
      Effect.gen(function* () {
        yield* run()
        if (path === "PutItem") {
          expect(mockPutItem).toHaveBeenCalledOnce()
          expect(mockTransactWriteItems).not.toHaveBeenCalled()
        } else {
          expect(mockTransactWriteItems).toHaveBeenCalledOnce()
          expect(mockPutItem).not.toHaveBeenCalled()
        }
      }).pipe(Effect.provide(TestLayer)),
    )
  }

  it.effect(
    "sends the transaction's item, condition and ALL_OLD plus a write token, and returns the same result",
    () =>
      Effect.gen(function* () {
        const viaPut = yield* Noted.append(id, [deposit(1)], 0, {
          metadata: { note: "import" },
        })
        // The same event through a transaction: the record's put makes it two items.
        const viaTx = yield* Noted.append(id, [deposit(1)], 0, {
          metadata: { note: "import" },
          additionalItems: [Balances.put({ accountId: "a-9", version: 1 })],
        })

        const put = mockPutItem.mock.calls[0]![0]
        const txPut = mockTransactWriteItems.mock.calls[0]![0].TransactItems[0].Put
        const { __edd_wt__: token, ...item } = put.Item
        expect(token.S).toMatch(/^[0-9a-f]{32}$/)
        expect({ ...put, Item: item }).toEqual(txPut)
        expect(txPut.Item.__edd_wt__).toBeUndefined()
        expect(Object.keys(put).sort()).toEqual([
          "ConditionExpression",
          "Item",
          "ReturnValuesOnConditionCheckFailure",
          "TableName",
        ])
        expect(viaPut).toEqual(viaTx)
        expect(viaPut).toEqual({ version: 1, events: [deposit(1)] })
      }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("every append call sends its own write token", () =>
    Effect.gen(function* () {
      yield* Ledger.append(id, [deposit(1)], 0)
      yield* Ledger.append(id, [deposit(1)], 0)
      const [first, second] = mockPutItem.mock.calls.map((call) => call[0].Item.__edd_wt__.S)
      expect(first).not.toBe(second)
    }).pipe(Effect.provide(TestLayer)),
  )

  describe("an SDK retry of a put that committed but lost its response (#173)", () => {
    /**
     * The first send commits, and its response is lost: the retry fails its
     * own `attribute_not_exists(pk)`, and `ALL_OLD` returns the item the
     * first send wrote — as a real `PutItem` retried by the SDK does.
     */
    const commitThenConflict = () =>
      mockPutItem.mockImplementationOnce(async (input: { Item: unknown }) => {
        throw putConditionFailed(input.Item)
      })

    it.effect("is the writer's own event: success, as a transaction's idempotent retry", () =>
      Effect.gen(function* () {
        commitThenConflict()
        const result = yield* Ledger.append(id, [deposit(1)], 0)
        expect(result).toEqual({ version: 1, events: [deposit(1)] })

        // A one-event "none" append, sealing: its own sealed event is not a seal against it.
        commitThenConflict()
        const sealed = yield* Ledger.append(id, [close()], 3, { headProof: "none", seal: true })
        expect(sealed).toEqual({ version: 4, events: [close()] })
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("a commandHandler appends once: no second decide, no duplicate event", () =>
      Effect.gen(function* () {
        commitThenConflict()
        const decide = vi.fn(decider.decide)
        const result = yield* EventStore.commandHandler({ ...decider, decide }, Ledger, {
          retry: 3,
        })(id, { amount: 5 })
        expect(result.version).toBe(1)
        expect(decide).toHaveBeenCalledOnce()
        expect(mockPutItem).toHaveBeenCalledOnce()
        expect(mockTransactWriteItems).not.toHaveBeenCalled()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("another writer's identical event at the version is still a conflict", () =>
      Effect.gen(function* () {
        // Byte for byte what this writer sends, but for its own write token.
        mockPutItem.mockImplementationOnce(async (input: { Item: Record<string, unknown> }) => {
          throw putConditionFailed({ ...input.Item, __edd_wt__: { S: "f".repeat(32) } })
        })
        const error = yield* Ledger.append(id, [deposit(1)], 0).pipe(Effect.flip)
        expect(error).toBeInstanceOf(VersionConflict)

        // An event without a token (written by a transaction) likewise.
        mockPutItem.mockImplementationOnce(async (input: { Item: Record<string, unknown> }) => {
          const { __edd_wt__: _token, ...item } = input.Item
          throw putConditionFailed(item)
        })
        const untokened = yield* Ledger.append(id, [deposit(1)], 0).pipe(Effect.flip)
        expect(untokened).toBeInstanceOf(VersionConflict)
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  it.effect("a commandHandler's first event takes it", () =>
    Effect.gen(function* () {
      const result = yield* EventStore.commandHandler(decider, Ledger)(id, { amount: 5 })
      expect(result.version).toBe(1)
      expect(mockPutItem).toHaveBeenCalledOnce()
      expect(mockTransactWriteItems).not.toHaveBeenCalled()
    }).pipe(Effect.provide(TestLayer)),
  )

  describe("maps every failure to the transaction's verdict for the same case", () => {
    /**
     * The fast path's error for `putRejection`, and the transactional path's
     * for the same failure of its first event put (`txRejection`) — two events
     * at version 0, so the first put is at the same position as the lone one.
     */
    const both = (putRejection: unknown, txRejection: unknown) =>
      Effect.gen(function* () {
        mockPutItem.mockRejectedValueOnce(putRejection)
        const fast = yield* Ledger.append(id, [deposit(1)], 0).pipe(Effect.flip)
        mockTransactWriteItems.mockRejectedValueOnce(txRejection)
        const tx = yield* Ledger.append(id, [deposit(1), deposit(2)], 0).pipe(Effect.flip)
        return { fast, tx }
      })

    it.effect("a failed condition returning a sealed item: StreamSealed", () =>
      Effect.gen(function* () {
        const sealed = eventItem(1, { sealed: true })
        const { fast, tx } = yield* both(
          putConditionFailed(sealed),
          awsTransactionCanceled([
            { Code: "ConditionalCheckFailed", Item: sealed } as never,
            { Code: "None" },
          ]),
        )
        expect(fast).toBeInstanceOf(StreamSealed)
        expect(fast).toMatchObject({ streamName: "Ledger", streamId: "a-1", sealedVersion: 1 })
        expect(fieldsOf(fast)).toEqual(fieldsOf(tx))
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("a failed condition returning an unsealed item: VersionConflict", () =>
      Effect.gen(function* () {
        const { fast, tx } = yield* both(
          putConditionFailed(eventItem(1)),
          awsTransactionCanceled([
            { Code: "ConditionalCheckFailed", Item: eventItem(1) } as never,
            { Code: "None" },
          ]),
        )
        expect(fast).toBeInstanceOf(VersionConflict)
        expect(fast).toMatchObject({ streamName: "Ledger", streamId: "a-1", expectedVersion: 0 })
        expect(fieldsOf(fast)).toEqual(fieldsOf(tx))
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("a failed condition with no item returned: VersionConflict", () =>
      Effect.gen(function* () {
        const { fast, tx } = yield* both(
          putConditionFailed(),
          awsTransactionCanceled([{ Code: "ConditionalCheckFailed" }, { Code: "None" }]),
        )
        expect(fast).toBeInstanceOf(VersionConflict)
        expect(fieldsOf(fast)).toEqual(fieldsOf(tx))
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("an item over 400 KB: the ValidationError naming the event", () =>
      Effect.gen(function* () {
        const huge = new Deposited({ amount: 1 })
        const big = { note: "x".repeat(410_000) }
        mockPutItem.mockRejectedValueOnce(awsValidationException(DDB_ITEM_SIZE))
        const fast = yield* Noted.append(id, [huge], 0, { metadata: big }).pipe(Effect.flip)
        mockTransactWriteItems.mockRejectedValueOnce(awsValidationException(DDB_ITEM_SIZE))
        const tx = yield* Noted.append(id, [huge, deposit(2)], 0, {
          eventMetadata: [big, undefined],
        }).pipe(Effect.flip)

        expect(fast._tag).toBe("ValidationError")
        expect(tx._tag).toBe("ValidationError")
        const text = String((fast as ValidationError).cause)
        expect((fast as ValidationError).operation).toBe("EventStore.append")
        expect(text).toContain("the item of the event at version 1, at pk=$ledger#v1#noted#a-1")
        expect(String((tx as ValidationError).cause)).toContain(
          "the item of the event at version 1, at pk=$ledger#v1#noted#a-1",
        )
      }).pipe(Effect.provide(TestLayer)),
    )

    // Each `PutItem` error, and the cancellation reason a transaction gives
    // its item for the same failure.
    const itemReasons = [
      ["ProvisionedThroughputExceededException", "ProvisionedThroughputExceeded", "Rate exceeded"],
      ["ThrottlingException", "ThrottlingError", "Rate exceeded"],
      [
        "ItemCollectionSizeLimitExceededException",
        "ItemCollectionSizeLimitExceeded",
        "Collection size exceeded",
      ],
      [
        "TransactionConflictException",
        "TransactionConflict",
        "Transaction is ongoing for the item",
      ],
    ] as const
    for (const [name, code, message] of itemReasons) {
      it.effect(`${name}: TransactionCancelled with a ${code} reason`, () =>
        Effect.gen(function* () {
          const { fast, tx } = yield* both(
            awsError(name, message),
            awsTransactionCanceled([{ Code: code, Message: message }]),
          )
          expect(fast).toBeInstanceOf(TransactionCancelled)
          expect(tx).toBeInstanceOf(TransactionCancelled)
          expect(fast).toMatchObject({ operation: "PutItem", reasons: [{ code, message }] })
          expect((tx as TransactionCancelled).reasons[0]).toEqual(
            (fast as TransactionCancelled).reasons[0],
          )
        }).pipe(Effect.provide(TestLayer)),
      )
    }

    it.effect("anything else passes through unchanged", () =>
      Effect.gen(function* () {
        const failure = awsError("InternalServerError")
        const { fast, tx } = yield* both(failure, failure)
        expect(fast).toBeInstanceOf(DynamoError)
        expect((fast as DynamoError).cause).toBe(failure)
        expect((tx as DynamoError).cause).toBe(failure)

        // A request-level validation error of a transaction too.
        const unrecognised = awsValidationException("Some other validation problem")
        const other = yield* both(unrecognised, unrecognised)
        expect(other.fast).toBeInstanceOf(DynamoValidationError)
        expect((other.fast as DynamoValidationError).cause).toBe(unrecognised)
        expect((other.tx as DynamoValidationError).cause).toBe(unrecognised)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("a key of the wrong type: TransactionCancelled with a ValidationError reason", () =>
      Effect.gen(function* () {
        // A transaction cancels its item for it; a PutItem fails the request
        // (both observed on DynamoDB Local).
        const message = "One or more parameter values were invalid: Type mismatch for key"
        const { fast, tx } = yield* both(
          awsValidationException(message),
          awsTransactionCanceled([{ Code: "ValidationError", Message: message }, { Code: "None" }]),
        )
        expect(fast).toBeInstanceOf(TransactionCancelled)
        expect(tx).toBeInstanceOf(TransactionCancelled)
        expect(fast).toMatchObject({
          operation: "PutItem",
          reasons: [{ code: "ValidationError", message }],
        })
        expect((tx as TransactionCancelled).reasons[0]).toEqual(
          (fast as TransactionCancelled).reasons[0],
        )
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("a commandHandler retries a fast-path conflict as it retries any", () =>
      Effect.gen(function* () {
        mockPutItem.mockRejectedValueOnce(putConditionFailed(eventItem(1)))
        // The retry's reload sees event 1; the second append (at 1) is a transaction.
        mockQuery.mockResolvedValueOnce({ Items: [] }).mockResolvedValue({ Items: [eventItem(1)] })

        const result = yield* EventStore.commandHandler(decider, Ledger, { retry: 1 })(id, {
          amount: 5,
        })

        expect(result.version).toBe(2)
        expect(mockPutItem).toHaveBeenCalledOnce()
        expect(kinds()).toEqual(["check", "ledger.event"])
      }).pipe(Effect.provide(TestLayer)),
    )
  })
})

// ---------------------------------------------------------------------------
// measureAppend
// ---------------------------------------------------------------------------

describe('measureAppend({ headProof: "none" }) (#173)', () => {
  it.effect("leaves the check out, and measures what append sends", () =>
    Effect.gen(function* () {
      const twoEvents = [deposit(1), deposit(2)]
      const checked = yield* Ledger.measureAppend(id, twoEvents, 3)
      const none = yield* Ledger.measureAppend(id, twoEvents, 3, { headProof: "none" })

      expect(none.events).toEqual(checked.events)
      yield* Ledger.append(id, twoEvents, 3)
      const [check] = mockTransactWriteItems.mock.calls[0]![0].TransactItems
      expect(checked.transactionBytes - none.transactionBytes).toBe(transactItemBytes(check))

      yield* Ledger.append(id, twoEvents, 3, { headProof: "none" })
      const sent = mockTransactWriteItems.mock.calls[1]![0].TransactItems as ReadonlyArray<any>
      expect(none.transactionBytes).toBe(
        sent.reduce((sum: number, item: any) => sum + transactItemBytes(item), 0),
      )

      // One event: the item sent as a PutItem.
      const lone = yield* Ledger.measureAppend(id, [deposit(1)], 3, { headProof: "none" })
      yield* Ledger.append(id, [deposit(1)], 3, { headProof: "none" })
      expect(lone.transactionBytes).toBe(transactItemBytes({ Put: mockPutItem.mock.calls[0]![0] }))
      expect(lone.sentinel).toBeUndefined()
    }).pipe(Effect.provide(TestLayer)),
  )
})
