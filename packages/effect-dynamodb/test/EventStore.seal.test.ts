/**
 * Sealing a stream and nested stream appends (#166), against a mocked
 * `DynamoClient`.
 *
 * - Write shape: the `__edd_sealed__` marker on the last event of a sealing
 *   append (and its inline snapshot), the contiguity check's extended
 *   condition, `ALL_OLD` on the check, the first event put and a conditioned
 *   snapshot put only.
 * - Validation of `seal`, before anything is sent.
 * - Attribution: `StreamSealed` from every failure position (contiguity check,
 *   first event put, snapshot proof, a nested op's), `DuplicateCommand` ahead
 *   of it, `VersionConflict` otherwise.
 * - `appendOp`: layout, provenance, atomic multi-stream append without a
 *   seal, nested verdicts naming the inner stream, refusals, limit
 *   diagnosis, a bound op building in its captured context.
 * - Reads: `sealed` on decoded events, `LatestState.seal` in every
 *   `readLatest` mode, stream indexes by projection.
 * - `commandHandler`: the pre-decide seal check in every load mode, no retry
 *   of `StreamSealed`, a nested conflict on another stream retried (under an
 *   If-Match too) and never taken for a lagging snapshot.
 */

import { describe, expect, it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import {
  type AdditionalItemConditionFailed,
  type AppendTooLarge,
  type DuplicateCommand,
  DynamoError,
  StreamSealed,
  type ValidationError,
  VersionConflict,
} from "@effect-dynamodb/schema/Errors.js"
import { Cause, DateTime, Effect, Exit, Layer, Logger, Option, Schema } from "effect"
import { beforeEach, vi } from "vitest"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
import { buildTransactWriteItems } from "../src/internal/TransactWriteOps.js"
import { fromAttributeMap, toAttributeMap } from "../src/Marshaller.js"
import * as Query from "../src/Query.js"
import * as Table from "../src/Table.js"
import * as Transaction from "../src/Transaction.js"
import {
  awsValidationException,
  DDB_ITEM_SIZE,
  DDB_REPEATED_ITEM,
  DDB_TOO_MANY_ITEMS,
  mockDynamoClientLayer,
} from "./helpers/MockDynamoClient.js"

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

const AppSchema = DynamoSchema.make({ name: "seal", version: 1 })

/** The application's chain index: which generation of an account is current. */
class Chain extends Schema.Class<Chain>("Chain")({
  accountId: Schema.String,
  current: Schema.String,
  revision: Schema.Number,
}) {}

const Chains = Entity.make({
  model: Chain,
  entityType: "Chain",
  primaryKey: {
    pk: { field: "pk", composite: ["accountId"] },
    sk: { field: "sk", composite: [] },
  },
})

/** The caller's state record of a `loadState` / record-proof stream. */
class Account extends Schema.Class<Account>("Account")({
  accountId: Schema.String,
  balance: Schema.Number,
  streamVersion: Schema.Number,
}) {}

const Accounts = Entity.make({
  model: Account,
  entityType: "Account",
  primaryKey: {
    pk: { field: "pk", composite: ["accountId"] },
    sk: { field: "sk", composite: [] },
  },
})

/** A unique-constrained entity: its put is guarded (it expands and can race). */
class Handle extends Schema.Class<Handle>("Handle")({
  handleId: Schema.String,
  code: Schema.String,
}) {}

const Handles = Entity.make({
  model: Handle,
  entityType: "Handle",
  primaryKey: {
    pk: { field: "pk", composite: ["handleId"] },
    sk: { field: "sk", composite: [] },
  },
  unique: { code: ["code"] },
})

const SealTable = Table.make({ schema: AppSchema, entities: { Chains, Accounts, Handles } })
/** A second physical table, for a bound op built in its own context. */
const OtherTable = Table.make({ schema: AppSchema, entities: {} })

class Deposited extends Schema.TaggedClass<Deposited>()("Deposited", {
  amount: Schema.Number,
}) {}
class Closed extends Schema.TaggedClass<Closed>()("Closed", {
  continuedIn: Schema.String,
}) {}
class Opened extends Schema.TaggedClass<Opened>()("Opened", {
  continuesFrom: Schema.Number,
}) {}
type LedgerEvent = Deposited | Closed | Opened
const events = [Deposited, Closed, Opened] as const

const LedgerState = Schema.Struct({ balance: Schema.Number })
type LedgerState = typeof LedgerState.Type

/** No snapshot config. */
const Ledger = EventStore.makeStream({
  table: SealTable,
  streamName: "Ledger",
  events,
  streamId: { composite: ["accountId"] },
})
/** `mode: "inline"` without `every`: a snapshot in every append. */
const Inline = EventStore.makeStream({
  table: SealTable,
  streamName: "Inline",
  events,
  streamId: { composite: ["accountId"] },
  snapshot: { schema: LedgerState, mode: "inline" },
})
/** `mode: "inline"` with `every`. */
const Every = EventStore.makeStream({
  table: SealTable,
  streamName: "Every",
  events,
  streamId: { composite: ["accountId"] },
  snapshot: { schema: LedgerState, mode: "inline", every: 3 },
})
/** After-append snapshots. */
const After = EventStore.makeStream({
  table: SealTable,
  streamName: "After",
  events,
  streamId: { composite: ["accountId"] },
  snapshot: { schema: LedgerState, every: 3 },
})
/** A stream keyed by generation, the changeover's shape. */
const Gen = EventStore.makeStream({
  table: SealTable,
  streamName: "Gen",
  events,
  streamId: { composite: ["accountId", "generation"] },
})
/** The same, with an inline snapshot (for `verifySnapshot: false` handlers). */
const GenInline = EventStore.makeStream({
  table: SealTable,
  streamName: "GenInline",
  events,
  streamId: { composite: ["accountId", "generation"] },
  snapshot: { schema: LedgerState, mode: "inline" },
})
/** The changeover's shape, with a metadata schema. */
const MetaGen = EventStore.makeStream({
  table: SealTable,
  streamName: "MetaGen",
  events,
  streamId: { composite: ["accountId", "generation"] },
  metadata: Schema.Struct({ correlationId: Schema.String }),
})
/** Another stream with the same id shape as `Ledger`: equal ids, a different name. */
const Mirror = EventStore.makeStream({
  table: SealTable,
  streamName: "Mirror",
  events,
  streamId: { composite: ["accountId"] },
})
/** A stream on another table. */
const Remote = EventStore.makeStream({
  table: OtherTable,
  streamName: "Remote",
  events,
  streamId: { composite: ["accountId"] },
})

const vkey = (_event: LedgerEvent, version: number) => `V#${String(version).padStart(4, "0")}`
const Indexed = EventStore.makeStream({
  table: SealTable,
  streamName: "Indexed",
  events,
  streamId: { composite: ["accountId"] },
  indexes: {
    full: { index: "lsi1", sk: "lsi1sk", key: vkey },
    slim: { index: "lsi2", sk: "lsi2sk", projection: "withoutMetadata", key: vkey },
    keys: { index: "lsi3", sk: "lsi3sk", projection: "keys", key: vkey },
    keysGsi: {
      type: "gsi",
      index: "gsi1",
      pk: "gsi1pk",
      sk: "gsi1sk",
      projection: "keys",
      key: vkey,
    },
  },
})

type LedgerCommand =
  | { readonly _tag: "Deposit"; readonly amount: number }
  | { readonly _tag: "Open"; readonly from: number }
  | { readonly _tag: "Noop" }

const decider: EventStore.Decider<LedgerState, LedgerCommand, LedgerEvent> = {
  initialState: { balance: 0 },
  decide: (command) =>
    Effect.succeed(
      command._tag === "Deposit"
        ? [new Deposited({ amount: command.amount })]
        : command._tag === "Open"
          ? [new Opened({ continuesFrom: command.from })]
          : [],
    ),
  evolve: (state, event) =>
    event._tag === "Deposited" ? { balance: state.balance + event.amount } : state,
}
const spied = () => {
  const decide = vi.fn(decider.decide)
  return { decide, decider: { ...decider, decide } }
}

const deposit = (amount: number) => new Deposited({ amount })
const close = (continuedIn = "2") => new Closed({ continuedIn })
const open = (continuesFrom: number) => new Opened({ continuesFrom })

const A = { accountId: "a-1", generation: "1" }
const B = { accountId: "a-1", generation: "2" }
const id = { accountId: "a-1" }

// ---------------------------------------------------------------------------
// Mock DynamoClient
// ---------------------------------------------------------------------------

const mockQuery = vi.fn()
const mockTransactWriteItems = vi.fn()
const mockPutItem = vi.fn()
const mockGetItem = vi.fn()
const mockBatchGetItem = vi.fn()

const TestDynamoClient = mockDynamoClientLayer({
  query: (input) =>
    Effect.tryPromise({
      try: async () => (await mockQuery(input)) ?? { Items: [] },
      catch: (e) => new DynamoError({ operation: "Query", cause: e }),
    }),
  transactWriteItems: (input) =>
    Effect.tryPromise({
      try: () => mockTransactWriteItems(input),
      catch: (e) => new DynamoError({ operation: "TransactWriteItems", cause: e }),
    }),
  putItem: (input) =>
    Effect.tryPromise({
      try: () => mockPutItem(input),
      catch: (e) => new DynamoError({ operation: "PutItem", cause: e }),
    }),
  getItem: (input) =>
    Effect.tryPromise({
      try: async () => (await mockGetItem(input)) ?? {},
      catch: (e) => new DynamoError({ operation: "GetItem", cause: e }),
    }),
  batchGetItem: (input) =>
    Effect.tryPromise({
      try: async () => (await mockBatchGetItem(input)) ?? {},
      catch: (e) => new DynamoError({ operation: "BatchGetItem", cause: e }),
    }),
})

const TestLayer = Layer.merge(TestDynamoClient, SealTable.layer({ name: "seal-table" }))

beforeEach(() => {
  vi.resetAllMocks()
})

// ---------------------------------------------------------------------------
// Items and cancellations
// ---------------------------------------------------------------------------

const pkOf = (label: string, streamId = "a-1") => `$seal#v1#${label}#${streamId}`
const eventSk = (label: string, version: number) =>
  DynamoSchema.composeEventVersionKey(AppSchema, `${label}.event`, version)
const snapshotSk = (label: string) => DynamoSchema.composeKey(AppSchema, `${label}.snapshot`, [])

/** An event item as stored: a `Deposited`, or the sealing `Closed` when `sealed`. */
const eventItem = (
  label: string,
  version: number,
  options: { readonly sealed?: boolean; readonly streamId?: string } = {},
) =>
  toAttributeMap({
    pk: pkOf(label, options.streamId),
    sk: eventSk(label, version),
    __edd_e__: `${label}.event`,
    streamId: options.streamId ?? "a-1",
    version,
    eventType: options.sealed === true ? "Closed" : "Deposited",
    data:
      options.sealed === true
        ? { _tag: "Closed", continuedIn: "2" }
        : { _tag: "Deposited", amount: version },
    timestamp: "2026-10-19T12:00:00.000Z",
    ...(options.sealed === true ? { __edd_sealed__: true } : {}),
  })

const snapshotItem = (
  label: string,
  asOfVersion: number,
  options: { readonly sealed?: boolean; readonly balance?: number } = {},
) =>
  toAttributeMap({
    pk: pkOf(label),
    sk: snapshotSk(label),
    __edd_e__: `${label}.snapshot`,
    streamId: "a-1",
    asOfVersion,
    state: { balance: options.balance ?? asOfVersion },
    timestamp: "2026-10-19T12:00:00.000Z",
    ...(options.sealed === true ? { __edd_sealed__: true } : {}),
  })

/** `readLatest`'s reverse page: the snapshot, then the events newest-first. */
const latestPage = (
  snapshot: ReturnType<typeof snapshotItem> | undefined,
  items: ReadonlyArray<ReturnType<typeof eventItem>> = [],
) => ({ Items: [...(snapshot === undefined ? [] : [snapshot]), ...[...items].reverse()] })

type Reason = { readonly Code: string; readonly Item?: unknown }
const failed = (item?: unknown): Reason =>
  item === undefined
    ? { Code: "ConditionalCheckFailed" }
    : { Code: "ConditionalCheckFailed", Item: item }
const ok: Reason = { Code: "None" }
const cancelled = (reasons: ReadonlyArray<Reason>) =>
  Object.assign(new Error("Transaction cancelled"), {
    name: "TransactionCanceledException",
    CancellationReasons: reasons,
  })

const sent = (call = 0): ReadonlyArray<any> =>
  mockTransactWriteItems.mock.calls[call]![0].TransactItems
/** What each item of a transaction is: "check", or the `__edd_e__` of its put. */
const kinds = (items: ReadonlyArray<any>) =>
  items.map((i) =>
    i.ConditionCheck !== undefined ? "check" : String(fromAttributeMap(i.Put.Item).__edd_e__),
  )
const putItem = (item: any) => fromAttributeMap(item.Put.Item)
const sealedFlags = (items: ReadonlyArray<any>) =>
  items.map((i) => (i.Put === undefined ? undefined : putItem(i).__edd_sealed__))

const expectSealed = (error: unknown, streamName: string, streamId: string, version: number) => {
  expect(error).toBeInstanceOf(StreamSealed)
  expect(error).toMatchObject({ streamName, streamId, sealedVersion: version })
}
const expectConflict = (
  error: unknown,
  streamName: string,
  streamId: string,
  expectedVersion: number,
) => {
  expect(error).toBeInstanceOf(VersionConflict)
  expect(error).toMatchObject({ streamName, streamId, expectedVersion })
}

/** The chain-index item, read-modify-written under its `revision`. */
const chainPut = (revision: number) =>
  Chains.put({ accountId: "a-1", current: "2", revision: revision + 1 }).pipe(
    Chains.condition({ revision }),
  )

// ---------------------------------------------------------------------------
// Write shape
// ---------------------------------------------------------------------------

describe("EventStore seal (#166) — write shape", () => {
  it.effect("marks the only event of a one-event seal; the check gains the seal clause", () =>
    Effect.gen(function* () {
      mockTransactWriteItems.mockResolvedValue({})

      const result = yield* Ledger.append(id, [close()], 4, { seal: true })

      expect(result.version).toBe(5)
      expect(kinds(sent())).toEqual(["check", "ledger.event"])
      const check = sent()[0].ConditionCheck
      expect(check.ConditionExpression).toBe(
        "attribute_exists(#pk) AND attribute_not_exists(#sealed)",
      )
      expect(check.ExpressionAttributeNames).toEqual({ "#pk": "pk", "#sealed": "__edd_sealed__" })
      expect(check.ReturnValuesOnConditionCheckFailure).toBe("ALL_OLD")
      expect(fromAttributeMap(check.Key)).toEqual({ pk: pkOf("ledger"), sk: eventSk("ledger", 4) })
      // The marker is a native BOOL, top-level beside `data`.
      expect(sent()[1].Put.Item.__edd_sealed__).toEqual({ BOOL: true })
      expect(putItem(sent()[1]).version).toBe(5)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("marks only the last of three events; ALL_OLD on the first put only", () =>
    Effect.gen(function* () {
      mockTransactWriteItems.mockResolvedValue({})

      yield* Ledger.append(id, [deposit(1), deposit(2), close()], 2, { seal: true })

      const items = sent()
      expect(kinds(items)).toEqual(["check", "ledger.event", "ledger.event", "ledger.event"])
      expect(sealedFlags(items)).toEqual([undefined, undefined, undefined, true])
      expect(
        items.map((i) => (i.Put ?? i.ConditionCheck).ReturnValuesOnConditionCheckFailure),
      ).toEqual(["ALL_OLD", "ALL_OLD", undefined, undefined])
      expect(items[1].Put.ConditionExpression).toBe("attribute_not_exists(pk)")
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("at version 0 there is no check; the first put still carries ALL_OLD", () =>
    Effect.gen(function* () {
      mockTransactWriteItems.mockResolvedValue({})

      yield* Ledger.append(id, [close()], 0, { seal: true })

      expect(kinds(sent())).toEqual(["ledger.event"])
      expect(sent()[0].Put.ReturnValuesOnConditionCheckFailure).toBe("ALL_OLD")
      expect(sealedFlags(sent())).toEqual([true])
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("marks the inline snapshot of a sealing append; unconditioned, it has no ALL_OLD", () =>
    Effect.gen(function* () {
      mockTransactWriteItems.mockResolvedValue({})

      yield* Inline.append(id, [deposit(5), close()], 3, { seal: true, snapshot: { balance: 9 } })

      const items = sent()
      expect(kinds(items)).toEqual(["check", "inline.event", "inline.event", "inline.snapshot"])
      expect(sealedFlags(items)).toEqual([undefined, undefined, true, true])
      const snapshot = items[3].Put
      expect(snapshot.ConditionExpression).toBeUndefined()
      expect(snapshot.ReturnValuesOnConditionCheckFailure).toBeUndefined()
      expect(putItem(items[3])).toMatchObject({ asOfVersion: 5, state: { balance: 9 } })
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("writes no marker on a non-sealing append, seal: false, or the sentinel", () =>
    Effect.gen(function* () {
      mockTransactWriteItems.mockResolvedValue({})

      yield* Inline.append(id, [deposit(1)], 3, { snapshot: { balance: 1 } })
      yield* Inline.append(id, [deposit(1)], 3, { snapshot: { balance: 1 }, seal: false })
      yield* Ledger.append(id, [close()], 3, {
        seal: true,
        idempotency: { commandId: "cmd-1" },
      })

      expect(sealedFlags(sent(0))).toEqual([undefined, undefined, undefined])
      expect(sealedFlags(sent(1))).toEqual([undefined, undefined, undefined])
      expect(kinds(sent(2))).toEqual(["check", "ledger.event", "ledger.command"])
      // [check, event, sentinel]: only the event is marked.
      expect(sealedFlags(sent(2))).toEqual([undefined, true, undefined])
      expect(putItem(sent(2)[2]).commandId).toBe("cmd-1")
      // The check is written with the seal clause on every append, sealing or not.
      expect(sent(0)[0].ConditionCheck.ConditionExpression).toBe(
        "attribute_exists(#pk) AND attribute_not_exists(#sealed)",
      )
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("writeSnapshot is one plain conditional PutItem, unmarked (G4 dropped)", () =>
    Effect.gen(function* () {
      mockPutItem.mockResolvedValue({})

      yield* Inline.writeSnapshot(id, { balance: 5 }, 5)

      expect(mockTransactWriteItems).not.toHaveBeenCalled()
      expect(mockPutItem).toHaveBeenCalledOnce()
      const put = mockPutItem.mock.calls[0]![0]
      expect(put.ConditionExpression).toBe(
        "attribute_not_exists(#pk) OR #asOfVersion < :asOfVersion",
      )
      expect(put.ReturnValuesOnConditionCheckFailure).toBeUndefined()
      expect(fromAttributeMap(put.Item).__edd_sealed__).toBeUndefined()
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("the snapshot proof requires an unmarked snapshot and returns it on failure", () =>
    Effect.gen(function* () {
      mockTransactWriteItems.mockResolvedValue({})

      yield* Inline.append(id, [close()], 3, {
        seal: true,
        snapshot: { balance: 3 },
        headProof: "snapshot",
      })

      expect(kinds(sent())).toEqual(["inline.event", "inline.snapshot"])
      const put = sent()[1].Put
      expect(put.ConditionExpression).toBe(
        "#asOfVersion = :expectedVersion AND attribute_not_exists(#sealed)",
      )
      expect(put.ExpressionAttributeNames).toEqual({
        "#asOfVersion": "asOfVersion",
        "#sealed": "__edd_sealed__",
      })
      expect(put.ReturnValuesOnConditionCheckFailure).toBe("ALL_OLD")
      expect(sealedFlags(sent())).toEqual([true, true])
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("the snapshot proof at version 0 stays attribute_not_exists(pk), with ALL_OLD", () =>
    Effect.gen(function* () {
      mockTransactWriteItems.mockResolvedValue({})

      yield* Inline.append(id, [deposit(1)], 0, { snapshot: { balance: 1 }, headProof: "snapshot" })

      const put = sent()[1].Put
      expect(put.ConditionExpression).toBe("attribute_not_exists(pk)")
      expect(put.ReturnValuesOnConditionCheckFailure).toBe("ALL_OLD")
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("measureAppend counts the marker's bytes", () =>
    Effect.gen(function* () {
      const plain = yield* Inline.measureAppend(id, [deposit(1), close()], 3, {
        snapshot: { balance: 1 },
      })
      const sealed = yield* Inline.measureAppend(id, [deposit(1), close()], 3, {
        snapshot: { balance: 1 },
        seal: true,
      })
      expect(sealed.events[0]).toBe(plain.events[0])
      expect(sealed.events[1]).toBeGreaterThan(plain.events[1]!)
      expect(sealed.snapshot).toBeGreaterThan(plain.snapshot!)
      expect(sealed.transactionBytes).toBeGreaterThan(plain.transactionBytes)
      expect(mockTransactWriteItems).not.toHaveBeenCalled()
    }).pipe(Effect.provide(TestLayer)),
  )

  it("refuses an index attribute named after the marker (EDD-9064)", () => {
    expect(() =>
      EventStore.makeStream({
        table: SealTable,
        streamName: "BadIndex",
        events,
        streamId: { composite: ["accountId"] },
        indexes: { bad: { index: "lsi1", sk: "__edd_sealed__", key: vkey } },
      }),
    ).toThrow(/EDD-9064/)
  })
})

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe("EventStore seal (#166) — validation", () => {
  const refused = (error: unknown, text: string) => {
    expect((error as ValidationError)._tag).toBe("ValidationError")
    expect((error as ValidationError).operation).toBe("EventStore.append.seal")
    expect(String((error as ValidationError).cause)).toContain(text)
    expect(mockTransactWriteItems).not.toHaveBeenCalled()
  }

  it.effect("seal with zero events", () =>
    Effect.gen(function* () {
      const error = yield* Ledger.append(id, [], 3, { seal: true }).pipe(Effect.flip)
      refused(error, "A seal needs at least one event to mark")
      // Also with side writes that would otherwise run.
      const withItems = yield* Ledger.append(id, [], 3, {
        seal: true,
        additionalItems: [chainPut(1)],
      }).pipe(Effect.flip)
      refused(withItems, "A seal needs at least one event to mark")
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("a seal that is not a boolean", () =>
    Effect.gen(function* () {
      const error = yield* Ledger.append(id, [close()], 3, { seal: "yes" as never }).pipe(
        Effect.flip,
      )
      refused(error, 'seal must be a boolean; received "yes"')
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("seal without snapshot on mode inline without every", () =>
    Effect.gen(function* () {
      const error = yield* Inline.append(id, [close()], 3, { seal: true }).pipe(Effect.flip)
      refused(error, "a seal must carry the inline snapshot")
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("the same call is accepted on an every stream and an after-append stream", () =>
    Effect.gen(function* () {
      mockTransactWriteItems.mockResolvedValue({})
      yield* Every.append(id, [close()], 3, { seal: true })
      yield* After.append(id, [close()], 3, { seal: true })
      expect(mockTransactWriteItems).toHaveBeenCalledTimes(2)
      expect(sealedFlags(sent(0))).toEqual([undefined, true])
      expect(sealedFlags(sent(1))).toEqual([undefined, true])
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("seal: false with zero events is still the no-op", () =>
    Effect.gen(function* () {
      const result = yield* Ledger.append(id, [], 3, { seal: false })
      expect(result.version).toBe(3)
      expect(mockTransactWriteItems).not.toHaveBeenCalled()
    }).pipe(Effect.provide(TestLayer)),
  )
})

// ---------------------------------------------------------------------------
// Attribution of the appending stream's own failures
// ---------------------------------------------------------------------------

describe("EventStore seal (#166) — attribution", () => {
  it.effect("a contiguity check returning a sealed event is StreamSealed", () =>
    Effect.gen(function* () {
      mockTransactWriteItems.mockRejectedValueOnce(
        cancelled([failed(eventItem("ledger", 4, { sealed: true })), ok]),
      )
      const error = yield* Ledger.append(id, [deposit(1)], 4).pipe(Effect.flip)
      expectSealed(error, "Ledger", "a-1", 4)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("a contiguity check returning no item is VersionConflict", () =>
    Effect.gen(function* () {
      mockTransactWriteItems.mockRejectedValueOnce(cancelled([failed(), ok]))
      const error = yield* Ledger.append(id, [deposit(1)], 4).pipe(Effect.flip)
      expectConflict(error, "Ledger", "a-1", 4)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("a first event put landing on the sealing event is StreamSealed", () =>
    Effect.gen(function* () {
      mockTransactWriteItems.mockRejectedValueOnce(
        cancelled([ok, failed(eventItem("ledger", 5, { sealed: true }))]),
      )
      const error = yield* Ledger.append(id, [deposit(1)], 4).pipe(Effect.flip)
      expectSealed(error, "Ledger", "a-1", 5)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("a first event put on an unmarked event is VersionConflict", () =>
    Effect.gen(function* () {
      mockTransactWriteItems.mockRejectedValueOnce(cancelled([ok, failed(eventItem("ledger", 5))]))
      const error = yield* Ledger.append(id, [deposit(1)], 4).pipe(Effect.flip)
      expectConflict(error, "Ledger", "a-1", 4)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("a later event put is VersionConflict (only the first is inspected)", () =>
    Effect.gen(function* () {
      // A marked item at a later position is not read: no ALL_OLD is sent there.
      mockTransactWriteItems.mockRejectedValueOnce(
        cancelled([ok, ok, failed(eventItem("ledger", 6, { sealed: true }))]),
      )
      const error = yield* Ledger.append(id, [deposit(1), deposit(2)], 4).pipe(Effect.flip)
      expectConflict(error, "Ledger", "a-1", 4)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("at version 0, event 1 being the seal is StreamSealed", () =>
    Effect.gen(function* () {
      mockTransactWriteItems.mockRejectedValueOnce(
        cancelled([failed(eventItem("ledger", 1, { sealed: true }))]),
      )
      const error = yield* Ledger.append(id, [deposit(1)], 0).pipe(Effect.flip)
      expectSealed(error, "Ledger", "a-1", 1)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("a snapshot proof returning a sealed snapshot is StreamSealed at its asOfVersion", () =>
    Effect.gen(function* () {
      mockTransactWriteItems.mockRejectedValueOnce(
        cancelled([ok, failed(snapshotItem("inline", 5, { sealed: true }))]),
      )
      const error = yield* Inline.append(id, [deposit(1)], 5, {
        snapshot: { balance: 6 },
        headProof: "snapshot",
      }).pipe(Effect.flip)
      expectSealed(error, "Inline", "a-1", 5)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("a snapshot proof behind the seal: the marked snapshot is found among positions", () =>
    Effect.gen(function* () {
      // Proof at 3, seal at 5: the snapshot is marked and the put at 4 collides.
      mockTransactWriteItems.mockRejectedValueOnce(
        cancelled([
          failed(eventItem("inline", 4)),
          failed(snapshotItem("inline", 5, { sealed: true })),
        ]),
      )
      const error = yield* Inline.append(id, [deposit(1)], 3, {
        snapshot: { balance: 4 },
        headProof: "snapshot",
      }).pipe(Effect.flip)
      expectSealed(error, "Inline", "a-1", 5)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("a record proof at S - 1: the first put lands on the seal, the record holds", () =>
    Effect.gen(function* () {
      // [event 5, record]: the record's `streamVersion = 4` condition held.
      mockTransactWriteItems.mockRejectedValueOnce(
        cancelled([failed(eventItem("ledger", 5, { sealed: true })), ok]),
      )
      const error = yield* Ledger.append(id, [deposit(1)], 4, {
        additionalItems: [
          Accounts.put({ accountId: "a-1", balance: 1, streamVersion: 5 }).pipe(
            Accounts.condition({ streamVersion: 4 }),
          ),
        ],
        headProof: { additionalItem: 0 },
      }).pipe(Effect.flip)
      expectSealed(error, "Ledger", "a-1", 5)
      expect(kinds(sent())).toEqual(["ledger.event", "Account"])
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("the sentinel ranks above the seal: DuplicateCommand", () =>
    Effect.gen(function* () {
      // [check, event, sentinel]
      mockTransactWriteItems.mockRejectedValueOnce(
        cancelled([failed(eventItem("ledger", 4, { sealed: true })), ok, failed()]),
      )
      const error = yield* Ledger.append(id, [close()], 3, {
        seal: true,
        idempotency: { commandId: "cmd-1" },
      }).pipe(Effect.flip)
      expect(error._tag).toBe("DuplicateCommand")
      expect((error as DuplicateCommand).commandId).toBe("cmd-1")
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("a sealed stream ranks above a failing additional item", () =>
    Effect.gen(function* () {
      mockTransactWriteItems.mockRejectedValueOnce(
        cancelled([failed(eventItem("ledger", 4, { sealed: true })), ok, failed()]),
      )
      const error = yield* Ledger.append(id, [deposit(1)], 4, {
        additionalItems: [chainPut(6)],
      }).pipe(Effect.flip)
      expectSealed(error, "Ledger", "a-1", 4)
    }).pipe(Effect.provide(TestLayer)),
  )
})

// ---------------------------------------------------------------------------
// appendOp
// ---------------------------------------------------------------------------

describe("EventStore appendOp (#166)", () => {
  /** The changeover: open B at 0, seal A at `aVersion`, put the chain index. */
  const changeover = (aVersion: number, extra: Array<any> = [chainPut(6)]) =>
    Gen.append(B, [open(aVersion)], 0, {
      additionalItems: [Gen.appendOp(A, [close()], aVersion, { seal: true }), ...extra],
    })

  it.effect("lays out B's events, A's check, A's marked event and the chain put", () =>
    Effect.gen(function* () {
      mockTransactWriteItems.mockResolvedValue({})

      const result = yield* changeover(4)

      expect(result.version).toBe(1)
      expect(mockTransactWriteItems).toHaveBeenCalledOnce()
      const items = sent()
      expect(kinds(items)).toEqual(["gen.event", "check", "gen.event", "Chain"])
      expect(putItem(items[0])).toMatchObject({ streamId: "a-1#2", version: 1 })
      expect(sealedFlags(items)).toEqual([undefined, undefined, true, undefined])
      const check = items[1].ConditionCheck
      expect(check.ConditionExpression).toBe(
        "attribute_exists(#pk) AND attribute_not_exists(#sealed)",
      )
      expect(check.ReturnValuesOnConditionCheckFailure).toBe("ALL_OLD")
      expect(fromAttributeMap(check.Key).sk).toBe(eventSk("gen", 4))
      expect(putItem(items[2])).toMatchObject({
        streamId: "a-1#1",
        version: 5,
        eventType: "Closed",
      })
      expect(items[2].Put.ReturnValuesOnConditionCheckFailure).toBe("ALL_OLD")
      expect(items[3].Put.ConditionExpression).toBeDefined()
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("provenance kind stream; the op is recorded and left out of conditioned", () =>
    Effect.gen(function* () {
      const built = yield* buildTransactWriteItems(
        [chainPut(6), Gen.appendOp(A, [deposit(1), close()], 4, { seal: true }), chainPut(7)],
        "test",
        { streams: true },
      )
      expect(built.provenance.map((p) => `${p.opIndex}:${p.kind}`)).toEqual([
        "0:main",
        "1:stream",
        "1:stream",
        "1:stream",
        "2:main",
      ])
      expect(built.provenance[1]!.entityType).toBe("gen.event")
      expect(built.streams.map(({ opIndex, start, count }) => ({ opIndex, start, count }))).toEqual(
        [{ opIndex: 1, start: 1, count: 3 }],
      )
      expect([...built.conditioned].sort()).toEqual([0, 2])
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("without streams: true, the shared builder refuses it", () =>
    Effect.gen(function* () {
      const error = yield* buildTransactWriteItems([Gen.appendOp(A, [deposit(1)], 4)], "test").pipe(
        Effect.flip,
      )
      expect(error._tag).toBe("ValidationError")
      expect(String((error as ValidationError).cause)).toContain(
        "a stream append op rides only in an EventStore append's additionalItems",
      )
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("carries an inline snapshot of the inner stream, marked with the seal", () =>
    Effect.gen(function* () {
      mockTransactWriteItems.mockResolvedValue({})

      yield* Ledger.append(id, [deposit(1)], 0, {
        additionalItems: [
          GenInline.appendOp(A, [deposit(2), close()], 3, {
            seal: true,
            snapshot: { balance: 9 },
          }),
        ],
      })

      expect(kinds(sent())).toEqual([
        "ledger.event",
        "check",
        "geninline.event",
        "geninline.event",
        "geninline.snapshot",
      ])
      expect(sealedFlags(sent())).toEqual([undefined, undefined, undefined, true, true])
      expect(putItem(sent()[4])).toMatchObject({ asOfVersion: 5, state: { balance: 9 } })
    }).pipe(Effect.provide(TestLayer)),
  )

  describe("metadata and timestamps", () => {
    const at = DateTime.makeUnsafe("2020-01-02T03:04:05.000Z")
    const meta = (correlationId: string) => ({ correlationId })

    it.effect("a nested op writes its eventMetadata and eventTimestamps on its events", () =>
      Effect.gen(function* () {
        mockTransactWriteItems.mockResolvedValue({})

        yield* Ledger.append(id, [deposit(1)], 0, {
          additionalItems: [
            MetaGen.appendOp(A, [deposit(2), close()], 3, {
              seal: true,
              eventMetadata: [meta("c-1"), meta("c-2")],
              eventTimestamps: [at, undefined],
            }),
          ],
        })

        const items = sent()
        expect(kinds(items)).toEqual(["ledger.event", "check", "metagen.event", "metagen.event"])
        const [first, last] = [putItem(items[2]), putItem(items[3])]
        expect(first).toMatchObject({ version: 4, metadata: meta("c-1") })
        expect(first.timestamp).toBe("2020-01-02T03:04:05.000Z")
        expect(first.__edd_sealed__).toBeUndefined()
        // The marker and the metadata side by side on the sealing event.
        expect(last).toMatchObject({ version: 5, metadata: meta("c-2"), __edd_sealed__: true })
        expect(last.timestamp).not.toBe("2020-01-02T03:04:05.000Z")
        expect(items[3].Put.Item.__edd_sealed__).toEqual({ BOOL: true })
        // The outer stream has no metadata: none is written on its event.
        expect(putItem(items[0]).metadata).toBeUndefined()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("a nested op writes one shared metadata value on every event", () =>
      Effect.gen(function* () {
        mockTransactWriteItems.mockResolvedValue({})

        yield* Ledger.append(id, [deposit(1)], 0, {
          additionalItems: [
            MetaGen.appendOp(A, [deposit(2), close()], 3, { seal: true, metadata: meta("c-9") }),
          ],
        })

        const items = sent()
        expect(putItem(items[2])).toMatchObject({ metadata: meta("c-9") })
        expect(putItem(items[3])).toMatchObject({ metadata: meta("c-9"), __edd_sealed__: true })
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("an outer sealing append keeps its metadata beside the marker", () =>
      Effect.gen(function* () {
        mockTransactWriteItems.mockResolvedValue({})

        yield* MetaGen.append(A, [deposit(1), close()], 2, {
          seal: true,
          metadata: meta("c-3"),
          eventTimestamps: [undefined, at],
        })

        const items = sent()
        expect(kinds(items)).toEqual(["check", "metagen.event", "metagen.event"])
        expect(putItem(items[1])).toMatchObject({ metadata: meta("c-3") })
        expect(putItem(items[1]).__edd_sealed__).toBeUndefined()
        expect(putItem(items[2])).toMatchObject({
          metadata: meta("c-3"),
          __edd_sealed__: true,
          timestamp: "2020-01-02T03:04:05.000Z",
        })
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("a sealed event read back carries its metadata and sealed", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue({
          Items: [
            toAttributeMap({
              ...fromAttributeMap(eventItem("metagen", 1, { sealed: true, streamId: "a-1#1" })),
              metadata: meta("c-4"),
            }),
          ],
        })
        const [event] = yield* MetaGen.read(A)
        expect(event!.sealed).toBe(true)
        expect(event!.metadata).toEqual(meta("c-4"))
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  describe("an atomic multi-stream append, without a seal (B3)", () => {
    it.effect("both streams' events in one transaction, no marker anywhere", () =>
      Effect.gen(function* () {
        mockTransactWriteItems.mockResolvedValue({})

        yield* Gen.append(B, [deposit(1), deposit(2)], 2, {
          additionalItems: [Gen.appendOp(A, [deposit(3)], 4)],
        })

        expect(mockTransactWriteItems).toHaveBeenCalledOnce()
        const items = sent()
        expect(kinds(items)).toEqual(["check", "gen.event", "gen.event", "check", "gen.event"])
        expect(sealedFlags(items).every((flag) => flag === undefined)).toBe(true)
        expect(items.filter((i) => i.Put).map((i) => putItem(i).streamId)).toEqual([
          "a-1#2",
          "a-1#2",
          "a-1#1",
        ])
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("a nested contiguity failure is VersionConflict naming A", () =>
      Effect.gen(function* () {
        // [B check, B event, A check, A event]
        mockTransactWriteItems.mockRejectedValueOnce(cancelled([ok, ok, failed(), ok]))
        const error = yield* Gen.append(B, [deposit(1)], 2, {
          additionalItems: [Gen.appendOp(A, [deposit(3)], 4)],
        }).pipe(Effect.flip)
        expectConflict(error, "Gen", "a-1#1", 4)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("several op streams: the first failing one in op order is reported", () =>
      Effect.gen(function* () {
        const C = { accountId: "a-1", generation: "3" }
        // [B event, A check, A event, C check, C event]
        mockTransactWriteItems.mockRejectedValueOnce(cancelled([ok, ok, failed(), failed(), ok]))
        const error = yield* Gen.append(B, [deposit(1)], 0, {
          additionalItems: [Gen.appendOp(A, [deposit(3)], 4), Gen.appendOp(C, [deposit(4)], 1)],
        }).pipe(Effect.flip)
        expectConflict(error, "Gen", "a-1#1", 4)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("several op streams: only the second failing is reported, naming it", () =>
      Effect.gen(function* () {
        const C = { accountId: "a-1", generation: "3" }
        // [B event, A check, A event, C check, C event]: C's check at index 3.
        mockTransactWriteItems.mockRejectedValueOnce(cancelled([ok, ok, ok, failed(), ok]))
        const error = yield* Gen.append(B, [deposit(1)], 0, {
          additionalItems: [Gen.appendOp(A, [deposit(3)], 4), Gen.appendOp(C, [deposit(4)], 1)],
        }).pipe(Effect.flip)
        expectConflict(error, "Gen", "a-1#3", 1)
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  describe("nested verdicts", () => {
    it.effect("A's check returning a sealed item is StreamSealed naming A", () =>
      Effect.gen(function* () {
        mockTransactWriteItems.mockRejectedValueOnce(
          cancelled([ok, failed(eventItem("gen", 4, { sealed: true, streamId: "a-1#1" })), ok, ok]),
        )
        const error = yield* changeover(4).pipe(Effect.flip)
        expectSealed(error, "Gen", "a-1#1", 4)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("A's first put landing on a seal is StreamSealed naming A", () =>
      Effect.gen(function* () {
        mockTransactWriteItems.mockRejectedValueOnce(
          cancelled([ok, ok, failed(eventItem("gen", 5, { sealed: true, streamId: "a-1#1" })), ok]),
        )
        const error = yield* changeover(4).pipe(Effect.flip)
        expectSealed(error, "Gen", "a-1#1", 5)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("A's first put on an unmarked event (a stale append) is VersionConflict(A)", () =>
      Effect.gen(function* () {
        mockTransactWriteItems.mockRejectedValueOnce(
          cancelled([ok, ok, failed(eventItem("gen", 5, { streamId: "a-1#1" })), ok]),
        )
        const error = yield* changeover(4).pipe(Effect.flip)
        expectConflict(error, "Gen", "a-1#1", 4)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("a failure only at the nested (unconditioned) snapshot put is no verdict", () =>
      Effect.gen(function* () {
        // Only the nested snapshot position failed: no verdict, so the
        // transaction's cancellation stands.
        mockTransactWriteItems.mockRejectedValueOnce(cancelled([ok, ok, ok, failed()]))
        const error = yield* Ledger.append(id, [deposit(1)], 0, {
          additionalItems: [
            GenInline.appendOp(A, [close()], 3, { seal: true, snapshot: { balance: 1 } }),
          ],
        }).pipe(Effect.flip)
        expect(error._tag).toBe("TransactionCancelled")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("B and A failing together: B's error", () =>
      Effect.gen(function* () {
        mockTransactWriteItems.mockRejectedValueOnce(
          cancelled([failed(eventItem("gen", 1, { streamId: "a-1#2" })), failed(), ok, ok]),
        )
        const error = yield* changeover(4).pipe(Effect.flip)
        expectConflict(error, "Gen", "a-1#2", 0)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("A and the chain index failing together: A's error", () =>
      Effect.gen(function* () {
        mockTransactWriteItems.mockRejectedValueOnce(cancelled([ok, failed(), ok, failed()]))
        const error = yield* changeover(4).pipe(Effect.flip)
        expectConflict(error, "Gen", "a-1#1", 4)
      }).pipe(Effect.provide(TestLayer)),
    )

    describe("the op after an entity op (its items start past item 0)", () => {
      /** [B event, Chain, A check, A event]: A's items start at additional item 1. */
      const chainFirst = () =>
        Gen.append(B, [open(4)], 0, {
          additionalItems: [chainPut(6), Gen.appendOp(A, [close()], 4, { seal: true })],
        })

      it.effect("the layout puts the chain item ahead of A's items", () =>
        Effect.gen(function* () {
          mockTransactWriteItems.mockResolvedValue({})
          yield* chainFirst()
          expect(kinds(sent())).toEqual(["gen.event", "Chain", "check", "gen.event"])
        }).pipe(Effect.provide(TestLayer)),
      )

      it.effect("A's first put returning a marked item is StreamSealed naming A", () =>
        Effect.gen(function* () {
          mockTransactWriteItems.mockRejectedValueOnce(
            cancelled([
              ok,
              ok,
              ok,
              failed(eventItem("gen", 5, { sealed: true, streamId: "a-1#1" })),
            ]),
          )
          const error = yield* chainFirst().pipe(Effect.flip)
          expectSealed(error, "Gen", "a-1#1", 5)
        }).pipe(Effect.provide(TestLayer)),
      )

      it.effect("A's check returning a marked item is StreamSealed naming A", () =>
        Effect.gen(function* () {
          mockTransactWriteItems.mockRejectedValueOnce(
            cancelled([
              ok,
              ok,
              failed(eventItem("gen", 4, { sealed: true, streamId: "a-1#1" })),
              ok,
            ]),
          )
          const error = yield* chainFirst().pipe(Effect.flip)
          expectSealed(error, "Gen", "a-1#1", 4)
        }).pipe(Effect.provide(TestLayer)),
      )

      it.effect("only the chain failing: AdditionalItemConditionFailed { indices: [0] }", () =>
        Effect.gen(function* () {
          mockTransactWriteItems.mockRejectedValueOnce(cancelled([ok, failed(), ok, ok]))
          const error = yield* chainFirst().pipe(Effect.flip)
          expect(error._tag).toBe("AdditionalItemConditionFailed")
          expect((error as AdditionalItemConditionFailed).indices).toEqual([0])
        }).pipe(Effect.provide(TestLayer)),
      )
    })

    describe("beside a guarded put, a sentinel and a head proof (§6.1)", () => {
      /** [B event, Handle, Handle sentinel, A check, A event] */
      const withHandle = (op = Gen.appendOp(A, [deposit(3)], 4)) =>
        Gen.append(B, [deposit(1)], 0, {
          additionalItems: [Handles.put({ handleId: "h-1", code: "C1" }), op],
        })

      it.effect("a taken unique value and a nested conflict together: the nested error", () =>
        Effect.gen(function* () {
          mockTransactWriteItems.mockRejectedValueOnce(cancelled([ok, ok, failed(), failed(), ok]))
          const error = yield* withHandle().pipe(Effect.flip)
          expectConflict(error, "Gen", "a-1#1", 4)
          expect(kinds(sent())).toEqual([
            "gen.event",
            "Handle",
            "Handle._unique.code",
            "check",
            "gen.event",
          ])
        }).pipe(Effect.provide(TestLayer)),
      )

      it.effect("a taken unique value alone is still UniqueConstraintViolation", () =>
        Effect.gen(function* () {
          mockTransactWriteItems.mockRejectedValueOnce(cancelled([ok, ok, failed(), ok, ok]))
          const error = yield* withHandle().pipe(Effect.flip)
          expect(error._tag).toBe("UniqueConstraintViolation")
        }).pipe(Effect.provide(TestLayer)),
      )

      it.effect("a guarded put's lost race is retried, rebuilding the nested op", () =>
        Effect.gen(function* () {
          // The handle's put was created since its read (no item returned): a race.
          mockTransactWriteItems
            .mockRejectedValueOnce(cancelled([ok, failed(), ok, ok, ok]))
            .mockResolvedValueOnce({})
          const op = Gen.appendOp(A, [deposit(3)], 4)
          const build = vi.spyOn(op, "_build")

          const result = yield* withHandle(op)

          expect(result.version).toBe(1)
          expect(mockTransactWriteItems).toHaveBeenCalledTimes(2)
          expect(build).toHaveBeenCalledTimes(2)
          expect(kinds(sent(1))).toEqual(kinds(sent(0)))
          expect(fromAttributeMap(sent(1)[3].ConditionCheck.Key).sk).toBe(eventSk("gen", 4))
        }).pipe(Effect.provide(TestLayer)),
      )

      it.effect("a lost race and a nested conflict together: the nested error, no retry", () =>
        Effect.gen(function* () {
          mockTransactWriteItems.mockRejectedValue(cancelled([ok, failed(), ok, failed(), ok]))
          const error = yield* withHandle().pipe(Effect.flip)
          expectConflict(error, "Gen", "a-1#1", 4)
          expect(mockTransactWriteItems).toHaveBeenCalledOnce()
        }).pipe(Effect.provide(TestLayer)),
      )

      /** [B event, A check, A event, sentinel] */
      const withIdempotency = () =>
        Gen.append(B, [deposit(1)], 0, {
          additionalItems: [Gen.appendOp(A, [deposit(3)], 4)],
          idempotency: { commandId: "cmd-1" },
        })

      it.effect("the outer sentinel sits after the nested items and ranks above them", () =>
        Effect.gen(function* () {
          mockTransactWriteItems.mockRejectedValueOnce(cancelled([ok, failed(), ok, failed()]))
          const error = yield* withIdempotency().pipe(Effect.flip)
          expect(kinds(sent())).toEqual(["gen.event", "check", "gen.event", "gen.command"])
          expect(error._tag).toBe("DuplicateCommand")
          expect(error).toMatchObject({ streamId: "a-1#2", commandId: "cmd-1" })
        }).pipe(Effect.provide(TestLayer)),
      )

      it.effect("with an outer sentinel, a nested failure alone is the nested error", () =>
        Effect.gen(function* () {
          mockTransactWriteItems.mockRejectedValueOnce(cancelled([ok, failed(), ok, ok]))
          const error = yield* withIdempotency().pipe(Effect.flip)
          expectConflict(error, "Gen", "a-1#1", 4)
        }).pipe(Effect.provide(TestLayer)),
      )

      /** [B event at 4, Account (the proof), A check, A event] */
      const withRecordProof = () =>
        Gen.append(B, [deposit(1)], 3, {
          additionalItems: [
            Accounts.put({ accountId: "a-1#2", balance: 1, streamVersion: 4 }).pipe(
              Accounts.condition({ streamVersion: 3 }),
            ),
            Gen.appendOp(A, [deposit(3)], 4),
          ],
          headProof: { additionalItem: 0 },
        })

      it.effect("an outer record proof and a nested failure together: VersionConflict(B)", () =>
        Effect.gen(function* () {
          mockTransactWriteItems.mockRejectedValueOnce(cancelled([ok, failed(), failed(), ok]))
          const error = yield* withRecordProof().pipe(Effect.flip)
          expect(kinds(sent())).toEqual(["gen.event", "Account", "check", "gen.event"])
          expectConflict(error, "Gen", "a-1#2", 3)
        }).pipe(Effect.provide(TestLayer)),
      )

      it.effect("an outer record proof holding, the nested failure: VersionConflict(A)", () =>
        Effect.gen(function* () {
          mockTransactWriteItems.mockRejectedValueOnce(cancelled([ok, ok, failed(), ok]))
          const error = yield* withRecordProof().pipe(Effect.flip)
          expectConflict(error, "Gen", "a-1#1", 4)
        }).pipe(Effect.provide(TestLayer)),
      )
    })

    it.effect("the chain index failing alone: AdditionalItemConditionFailed { indices: [1] }", () =>
      Effect.gen(function* () {
        mockTransactWriteItems.mockRejectedValueOnce(cancelled([ok, ok, ok, failed()]))
        const error = yield* changeover(4).pipe(Effect.flip)
        expect(error._tag).toBe("AdditionalItemConditionFailed")
        expect((error as AdditionalItemConditionFailed).indices).toEqual([1])
        expect((error as AdditionalItemConditionFailed).streamId).toBe("a-1#2")
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  describe("refusals", () => {
    const refusedOp = (error: unknown, text: string) => {
      expect((error as ValidationError)._tag).toBe("ValidationError")
      expect((error as ValidationError).operation).toBe("EventStore.appendOp")
      expect(String((error as ValidationError).cause)).toContain(text)
      expect(mockTransactWriteItems).not.toHaveBeenCalled()
    }

    for (const [key, value] of [
      ["idempotency", { commandId: "cmd-1" }],
      ["headProof", "snapshot"],
      ["additionalItems", [chainPut(1)]],
    ] as const) {
      it.effect(`a nested ${key} is refused at runtime`, () =>
        Effect.gen(function* () {
          const error = yield* Gen.append(B, [open(4)], 0, {
            additionalItems: [Gen.appendOp(A, [close()], 4, { [key]: value } as never)],
          }).pipe(Effect.flip)
          refusedOp(error, `A stream append op may not carry ${key}`)
        }).pipe(Effect.provide(TestLayer)),
      )
    }

    it.effect("zero events are refused", () =>
      Effect.gen(function* () {
        const error = yield* Gen.append(B, [open(4)], 0, {
          additionalItems: [Gen.appendOp(A, [], 4)],
        }).pipe(Effect.flip)
        refusedOp(error, 'An append op of stream "Gen" needs at least one event')
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("the inner seal's own validation applies (seal without snapshot on inline)", () =>
      Effect.gen(function* () {
        const error = yield* Ledger.append(id, [deposit(1)], 0, {
          additionalItems: [GenInline.appendOp(A, [close()], 4, { seal: true })],
        }).pipe(Effect.flip)
        expect((error as ValidationError).operation).toBe("EventStore.append.seal")
        expect(mockTransactWriteItems).not.toHaveBeenCalled()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("an op cannot be a headProof target", () =>
      Effect.gen(function* () {
        const error = yield* Gen.append(B, [deposit(1)], 3, {
          additionalItems: [Gen.appendOp(A, [close()], 4, { seal: true })],
          headProof: { additionalItem: 0 },
        }).pipe(Effect.flip)
        expect((error as ValidationError).operation).toBe("EventStore.append.headProof")
        expect(String((error as ValidationError).cause)).toContain(
          'which is an append of stream "Gen" (appendOp)',
        )
        expect(mockTransactWriteItems).not.toHaveBeenCalled()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("Transaction.transactWrite refuses it", () =>
      Effect.gen(function* () {
        const error = yield* Transaction.transactWrite([
          chainPut(1),
          Gen.appendOp(A, [close()], 4, { seal: true }) as never,
        ]).pipe(Effect.flip)
        expect(error._tag).toBe("ValidationError")
        expect(String((error as ValidationError).cause)).toContain(
          'operation 1 is a stream append op (appendOp of stream "Gen")',
        )
        expect(mockTransactWriteItems).not.toHaveBeenCalled()
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  describe("limits and diagnosis", () => {
    it.effect("B == A: DynamoDB's repeated-item rejection is a named ValidationError", () =>
      Effect.gen(function* () {
        mockTransactWriteItems.mockRejectedValueOnce(awsValidationException(DDB_REPEATED_ITEM))
        const error = yield* Gen.append(A, [deposit(1)], 4, {
          additionalItems: [Gen.appendOp(A, [close()], 4, { seal: true })],
        }).pipe(Effect.flip)
        expect(error._tag).toBe("ValidationError")
        expect(String((error as ValidationError).cause)).toContain("more than once")
        expect(mockTransactWriteItems).toHaveBeenCalledOnce()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("an AppendTooLarge count includes the nested items", () =>
      Effect.gen(function* () {
        mockTransactWriteItems.mockRejectedValueOnce(awsValidationException(DDB_TOO_MANY_ITEMS))
        // B: 1 event. A: a check and 99 events.
        const many = Array.from({ length: 99 }, (_, i) => deposit(i))
        const error = yield* Gen.append(B, [open(4)], 0, {
          additionalItems: [Gen.appendOp(A, many, 4)],
        }).pipe(Effect.flip)
        expect(error._tag).toBe("AppendTooLarge")
        expect((error as AppendTooLarge).count).toBe(101)
        expect((error as AppendTooLarge).streamId).toBe("a-1#2")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("the item-size diagnosis names a nested event", () =>
      Effect.gen(function* () {
        mockTransactWriteItems.mockRejectedValueOnce(awsValidationException(DDB_ITEM_SIZE))
        const big = new Closed({ continuedIn: "x".repeat(410_000) })
        const error = yield* Gen.append(B, [open(4)], 0, {
          additionalItems: [chainPut(1), Gen.appendOp(A, [big], 4, { seal: true })],
        }).pipe(Effect.flip)
        expect(error._tag).toBe("ValidationError")
        const text = String((error as ValidationError).cause)
        expect(text).toContain('operation 1 (stream "Gen", a-1#1): the event at version 5')
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  describe("bound and unbound ops on another table", () => {
    it.effect("a bound op builds in its captured context, and is sent by the outer client", () =>
      Effect.gen(function* () {
        mockTransactWriteItems.mockResolvedValue({})
        // The bound stream captures a client that must never be used.
        const unusedTransact = vi.fn()
        const captured = mockDynamoClientLayer({
          transactWriteItems: () => Effect.sync(() => unusedTransact() as never),
        })
        const bound = yield* EventStore.bind(Remote).pipe(
          Effect.provide(Layer.merge(captured, OtherTable.layer({ name: "other-table" }))),
        )

        yield* Ledger.append(id, [deposit(1)], 0, {
          additionalItems: [bound.appendOp(id, [close()], 2, { seal: true })],
        })

        expect(unusedTransact).not.toHaveBeenCalled()
        expect(mockTransactWriteItems).toHaveBeenCalledOnce()
        const items = sent()
        expect(kinds(items)).toEqual(["ledger.event", "check", "remote.event"])
        expect(items[0].Put.TableName).toBe("seal-table")
        expect(items[1].ConditionCheck.TableName).toBe("other-table")
        expect(items[2].Put.TableName).toBe("other-table")
        expect(sealedFlags(items)).toEqual([undefined, undefined, true])
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("an unbound op needs its table in the outer append's context", () =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          Ledger.append(id, [deposit(1)], 0, {
            additionalItems: [Remote.appendOp(id, [close()], 2, { seal: true })],
          }),
        )
        expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
        expect(mockTransactWriteItems).not.toHaveBeenCalled()

        mockTransactWriteItems.mockResolvedValue({})
        yield* Ledger.append(id, [deposit(1)], 0, {
          additionalItems: [Remote.appendOp(id, [close()], 2, { seal: true })],
        }).pipe(Effect.provide(OtherTable.layer({ name: "other-table" })))
        expect(sent()[1].ConditionCheck.TableName).toBe("other-table")
      }).pipe(Effect.provide(TestLayer)),
    )
  })
})

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

describe("EventStore seal (#166) — reads", () => {
  it.effect("read marks the sealing event, and only it", () =>
    Effect.gen(function* () {
      mockQuery.mockResolvedValue({
        Items: [eventItem("ledger", 1), eventItem("ledger", 2, { sealed: true })],
      })
      const read = yield* Ledger.read(id)
      expect(read[1]!.sealed).toBe(true)
      expect(read[1]!.data).toBeInstanceOf(Closed)
      expect("sealed" in read[0]!).toBe(false)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("readFrom returns the sealing event past S - 1, and nothing past S", () =>
    Effect.gen(function* () {
      mockQuery.mockResolvedValueOnce({ Items: [eventItem("ledger", 2, { sealed: true })] })
      const after1 = yield* Ledger.readFrom(id, 1)
      expect(after1.map((e) => [e.version, e.sealed])).toEqual([[2, true]])
      expect(after1[0]!.data).toBeInstanceOf(Closed)

      mockQuery.mockResolvedValueOnce({ Items: [] })
      expect(yield* Ledger.readFrom(id, 2)).toEqual([])
      // Each read is bounded below by its version: the second starts past the seal.
      const [first, second] = mockQuery.mock.calls.map(([input]) => input)
      expect(fromAttributeMap(first.ExpressionAttributeValues)).not.toEqual(
        fromAttributeMap(second.ExpressionAttributeValues),
      )
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("query.events marks only the sealing event", () =>
    Effect.gen(function* () {
      mockQuery.mockResolvedValue({
        Items: [eventItem("ledger", 1), eventItem("ledger", 2, { sealed: true })],
      })
      const collected = yield* Ledger.query.events(id).pipe(Query.collect)
      expect(collected.map((e) => e.sealed)).toEqual([undefined, true])
      expect("sealed" in collected[0]!).toBe(false)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("decodeStreamImage sets sealed, and omits it otherwise", () =>
    Effect.gen(function* () {
      const sealed = yield* Ledger.decodeStreamImage(
        eventItem("ledger", 2, { sealed: true }) as never,
      )
      expect(Option.getOrThrow(sealed).sealed).toBe(true)
      const plain = yield* Ledger.decodeStreamImage(eventItem("ledger", 1) as never)
      expect("sealed" in Option.getOrThrow(plain)).toBe(false)
    }),
  )

  describe("readLatest", () => {
    it.effect("no snapshot config: the sealing event, also in events", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue({
          Items: [eventItem("ledger", 1), eventItem("ledger", 2, { sealed: true })],
        })
        const latest = yield* Ledger.readLatest(id, { consistentRead: true })
        expect(latest.seal?.version).toBe(2)
        expect(latest.seal?.data).toBeInstanceOf(Closed)
        expect(latest.events.map((e) => e.version)).toEqual([1, 2])
        expect(latest.version).toBe(2)
        expect(mockQuery.mock.calls[0]![0].ConsistentRead).toBe(true)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("an unsealed stream has no seal key at all", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue({ Items: [eventItem("ledger", 1)] })
        const latest = yield* Ledger.readLatest(id)
        expect("seal" in latest).toBe(false)
        mockQuery.mockResolvedValue(latestPage(snapshotItem("every", 1), []))
        const snapped = yield* Every.readLatest(id)
        expect("seal" in snapped).toBe(false)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("verified, snapshot before the seal: the sealing event, also in events", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue(
          latestPage(snapshotItem("every", 3), [
            eventItem("every", 3),
            eventItem("every", 4),
            eventItem("every", 5, { sealed: true }),
          ]),
        )
        const latest = yield* Every.readLatest(id, { consistentRead: true })
        expect(latest.seal?.version).toBe(5)
        expect(latest.events.map((e) => e.version)).toEqual([4, 5])
        expect(latest.events[1]).toBe(latest.seal)
        expect(mockQuery).toHaveBeenCalledOnce()
        expect(mockQuery.mock.calls[0]![0].ConsistentRead).toBe(true)
        expect(mockGetItem).not.toHaveBeenCalled()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("verified, snapshot at the seal: seal decoded, not in events", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue(
          latestPage(snapshotItem("inline", 5, { sealed: true }), [
            eventItem("inline", 4),
            eventItem("inline", 5, { sealed: true }),
          ]),
        )
        const latest = yield* Inline.readLatest(id, { consistentRead: true })
        expect(latest.seal?.version).toBe(5)
        expect(latest.seal?.sealed).toBe(true)
        expect(latest.seal?.data).toBeInstanceOf(Closed)
        expect(latest.events).toEqual([])
        expect(latest.version).toBe(5)
        expect(mockQuery).toHaveBeenCalledOnce()
        expect(mockGetItem).not.toHaveBeenCalled()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("unverified, marked snapshot: exactly one more GetItem, of the sealing event", () =>
      Effect.gen(function* () {
        mockGetItem.mockImplementation(async (input: any) => {
          const sk = fromAttributeMap(input.Key).sk
          if (sk === snapshotSk("inline"))
            return { Item: snapshotItem("inline", 5, { sealed: true }) }
          if (sk === eventSk("inline", 5)) return { Item: eventItem("inline", 5, { sealed: true }) }
          return {}
        })
        const latest = yield* Inline.readLatest(id, { verifySnapshot: false, consistentRead: true })
        expect(latest.seal?.version).toBe(5)
        expect(latest.seal?.data).toBeInstanceOf(Closed)
        expect(latest.events).toEqual([])
        expect(latest.version).toBe(5)
        expect(mockQuery).not.toHaveBeenCalled()
        expect(mockGetItem).toHaveBeenCalledTimes(2)
        for (const [call] of mockGetItem.mock.calls) expect(call.ConsistentRead).toBe(true)
        expect(fromAttributeMap(mockGetItem.mock.calls[1]![0].Key)).toEqual({
          pk: pkOf("inline"),
          sk: eventSk("inline", 5),
        })
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("unverified, unmarked snapshot: no seal and no extra request", () =>
      Effect.gen(function* () {
        mockGetItem.mockResolvedValue({ Item: snapshotItem("inline", 4) })
        const latest = yield* Inline.readLatest(id, { verifySnapshot: false })
        expect("seal" in latest).toBe(false)
        expect(mockGetItem).toHaveBeenCalledOnce()
        expect(mockQuery).not.toHaveBeenCalled()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("unverified, no snapshot item: the verified read reports the seal", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue(
          latestPage(undefined, [eventItem("inline", 1, { sealed: true })]),
        )
        const latest = yield* Inline.readLatest(id, { verifySnapshot: false, consistentRead: true })
        expect(latest.seal?.version).toBe(1)
        expect(mockQuery).toHaveBeenCalledOnce()
        expect(mockQuery.mock.calls[0]![0].ConsistentRead).toBe(true)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("unverified, marked snapshot whose event is missing: falls back to verified", () =>
      Effect.gen(function* () {
        mockGetItem.mockImplementation(async (input: any) =>
          fromAttributeMap(input.Key).sk === snapshotSk("inline")
            ? { Item: snapshotItem("inline", 5, { sealed: true }) }
            : {},
        )
        mockQuery.mockResolvedValue(
          latestPage(snapshotItem("inline", 5, { sealed: true }), [
            eventItem("inline", 5, { sealed: true }),
          ]),
        )
        const latest = yield* Inline.readLatest(id, { verifySnapshot: false })
        expect(latest.seal?.version).toBe(5)
        expect(mockGetItem).toHaveBeenCalledTimes(2)
        expect(mockQuery).toHaveBeenCalledOnce()
      }).pipe(Effect.provide(TestLayer)),
    )

    describe("a sealing event that is not the newest (written past the seal)", () => {
      it.effect("no snapshot config: seal.version = S, version = S + 1", () =>
        Effect.gen(function* () {
          mockQuery.mockResolvedValue({
            Items: [
              eventItem("ledger", 1),
              eventItem("ledger", 2, { sealed: true }),
              eventItem("ledger", 3),
            ],
          })
          const latest = yield* Ledger.readLatest(id)
          expect(latest.seal?.version).toBe(2)
          expect(latest.version).toBe(3)
        }).pipe(Effect.provide(TestLayer)),
      )

      it.effect("verified, snapshot before the seal", () =>
        Effect.gen(function* () {
          mockQuery.mockResolvedValue(
            latestPage(snapshotItem("every", 2), [
              eventItem("every", 3, { sealed: true }),
              eventItem("every", 4),
            ]),
          )
          const latest = yield* Every.readLatest(id)
          expect(latest.seal?.version).toBe(3)
          expect(latest.version).toBe(4)
          expect(latest.events.map((e) => e.version)).toEqual([3, 4])
        }).pipe(Effect.provide(TestLayer)),
      )

      it.effect("verified, the marked snapshot at the seal, an unmarked event after it", () =>
        Effect.gen(function* () {
          mockQuery.mockResolvedValue(
            latestPage(snapshotItem("inline", 3, { sealed: true }), [
              eventItem("inline", 3, { sealed: true }),
              eventItem("inline", 4),
            ]),
          )
          const latest = yield* Inline.readLatest(id)
          expect(latest.seal?.version).toBe(3)
          expect(latest.version).toBe(4)
          expect(latest.events.map((e) => e.version)).toEqual([4])
        }).pipe(Effect.provide(TestLayer)),
      )

      it.effect("several marked events: seal is the oldest", () =>
        Effect.gen(function* () {
          mockQuery.mockResolvedValue({
            Items: [
              eventItem("ledger", 1, { sealed: true }),
              eventItem("ledger", 2),
              eventItem("ledger", 3, { sealed: true }),
            ],
          })
          const latest = yield* Ledger.readLatest(id)
          expect(latest.seal?.version).toBe(1)
          mockQuery.mockResolvedValue(
            latestPage(snapshotItem("every", 4, { sealed: true }), [
              eventItem("every", 2, { sealed: true }),
              eventItem("every", 3),
              eventItem("every", 4, { sealed: true }),
            ]),
          )
          const snapped = yield* Every.readLatest(id)
          expect(snapped.seal?.version).toBe(2)
          expect(snapped.events).toEqual([])
        }).pipe(Effect.provide(TestLayer)),
      )
    })
  })

  describe("stream indexes", () => {
    const fullItem = (version: number, sealed: boolean) => ({
      ...fromAttributeMap(eventItem("indexed", version, { sealed })),
      lsi1sk: vkey(deposit(0), version),
      gsi1pk: pkOf("indexed"),
      gsi1sk: vkey(deposit(0), version),
    })

    it.effect('"all" and "keys" report sealed; "withoutMetadata" does not', () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue({ Items: [toAttributeMap(fullItem(2, true))] })
        const all = yield* Indexed.readIndex("full", id)
        expect(all[0]!.sealed).toBe(true)

        // A keys LSI reads the table's item (Select ALL_ATTRIBUTES).
        const keys = yield* Indexed.readIndex("keys", id)
        expect(keys[0]!.sealed).toBe(true)
        expect(mockQuery.mock.calls[1]![0].Select).toBe("ALL_ATTRIBUTES")

        // A keys GSI hydrates the rows from the table.
        mockQuery.mockResolvedValue({
          Items: [
            toAttributeMap({
              pk: pkOf("indexed"),
              sk: eventSk("indexed", 2),
              gsi1pk: pkOf("indexed"),
              gsi1sk: vkey(deposit(0), 2),
              __edd_e__: "indexed.event",
            }),
          ],
        })
        mockBatchGetItem.mockResolvedValue({
          Responses: { "seal-table": [toAttributeMap(fullItem(2, true))] },
        })
        const keysGsi = yield* Indexed.readIndex("keysGsi", id)
        expect(keysGsi[0]!.sealed).toBe(true)

        // A withoutMetadata row holds what its INCLUDE list projects: no marker.
        const { __edd_sealed__: _marker, ...slimRow } = fullItem(2, true) as Record<string, unknown>
        mockQuery.mockResolvedValue({ Items: [toAttributeMap(slimRow)] })
        const slim = yield* Indexed.readIndex("slim", id)
        expect("sealed" in slim[0]!).toBe(false)
      }).pipe(Effect.provide(TestLayer)),
    )

    it("the withoutMetadata INCLUDE list is unchanged: no marker", () => {
      const definitions = JSON.stringify(EventStore.indexDefinitions(Indexed))
      expect(definitions).toContain('"NonKeyAttributes"')
      expect(definitions).not.toContain("__edd_sealed__")
    })
  })
})

// ---------------------------------------------------------------------------
// commandHandler
// ---------------------------------------------------------------------------

describe("EventStore seal (#166) — commandHandler", () => {
  const deposit1: LedgerCommand = { _tag: "Deposit", amount: 1 }

  describe("the pre-decide check, by load mode", () => {
    it.effect("no snapshot config: a sealing event read", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue({
          Items: [eventItem("ledger", 1), eventItem("ledger", 2, { sealed: true })],
        })
        const { decide, decider: d } = spied()
        const error = yield* EventStore.commandHandler(d, Ledger, { retry: 3 })(id, deposit1).pipe(
          Effect.flip,
        )
        expectSealed(error, "Ledger", "a-1", 2)
        expect(decide).not.toHaveBeenCalled()
        expect(mockTransactWriteItems).not.toHaveBeenCalled()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("verified snapshot load: LatestState.seal", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue(
          latestPage(snapshotItem("every", 3), [eventItem("every", 4, { sealed: true })]),
        )
        const { decide, decider: d } = spied()
        const error = yield* EventStore.commandHandler(d, Every)(id, deposit1).pipe(Effect.flip)
        expectSealed(error, "Every", "a-1", 4)
        expect(decide).not.toHaveBeenCalled()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("verifySnapshot: false, marked snapshot: no query, no decide", () =>
      Effect.gen(function* () {
        mockGetItem.mockImplementation(async (input: any) => {
          const sk = fromAttributeMap(input.Key).sk
          if (sk === snapshotSk("inline"))
            return { Item: snapshotItem("inline", 5, { sealed: true }) }
          if (sk === eventSk("inline", 5)) return { Item: eventItem("inline", 5, { sealed: true }) }
          return {}
        })
        const { decide, decider: d } = spied()
        const error = yield* EventStore.commandHandler(d, Inline, { verifySnapshot: false })(
          id,
          deposit1,
        ).pipe(Effect.flip)
        expectSealed(error, "Inline", "a-1", 5)
        expect(decide).not.toHaveBeenCalled()
        expect(mockQuery).not.toHaveBeenCalled()
        expect(mockTransactWriteItems).not.toHaveBeenCalled()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("loadState returning sealedVersion: no stream read at all", () =>
      Effect.gen(function* () {
        const { decide, decider: d } = spied()
        const error = yield* EventStore.commandHandler(d, Ledger, {
          loadState: () =>
            Effect.succeed(Option.some({ state: { balance: 4 }, version: 4, sealedVersion: 5 })),
          headProof: { additionalItem: 0 },
        })(id, deposit1).pipe(Effect.flip)
        expectSealed(error, "Ledger", "a-1", 5)
        expect(decide).not.toHaveBeenCalled()
        expect(mockQuery).not.toHaveBeenCalled()
        expect(mockGetItem).not.toHaveBeenCalled()
        expect(mockTransactWriteItems).not.toHaveBeenCalled()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("loadState at S, sealedVersion not mapped: the append's check, no retry", () =>
      Effect.gen(function* () {
        mockTransactWriteItems.mockRejectedValue(
          cancelled([failed(eventItem("ledger", 5, { sealed: true })), ok]),
        )
        const loadState = vi.fn(() =>
          Effect.succeed(Option.some({ state: { balance: 5 }, version: 5 })),
        )
        const error = yield* EventStore.commandHandler(decider, Ledger, { loadState, retry: 3 })(
          id,
          deposit1,
        ).pipe(Effect.flip)
        expectSealed(error, "Ledger", "a-1", 5)
        expect(mockTransactWriteItems).toHaveBeenCalledOnce()
        expect(loadState).toHaveBeenCalledOnce()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("loadState + record proof at S - 1: the first put, no retry", () =>
      Effect.gen(function* () {
        mockTransactWriteItems.mockRejectedValue(
          cancelled([failed(eventItem("ledger", 5, { sealed: true })), ok]),
        )
        const error = yield* EventStore.commandHandler(decider, Ledger, {
          loadState: () => Effect.succeed(Option.some({ state: { balance: 4 }, version: 4 })),
          headProof: { additionalItem: 0 },
          retry: 3,
        })(id, deposit1, {
          additionalItems: ({ version, state }) => [
            Accounts.put({
              accountId: "a-1",
              balance: state.balance,
              streamVersion: version + 1,
            }).pipe(Accounts.condition({ streamVersion: version })),
          ],
        }).pipe(Effect.flip)
        expectSealed(error, "Ledger", "a-1", 5)
        expect(kinds(sent())).toEqual(["ledger.event", "Account"])
        expect(mockTransactWriteItems).toHaveBeenCalledOnce()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("unverified, unmarked snapshot at S - 1: the append reports it, no retry", () =>
      Effect.gen(function* () {
        // A closer on another definition sealed at 5; the snapshot stayed at 4.
        mockGetItem.mockResolvedValue({ Item: snapshotItem("inline", 4) })
        mockTransactWriteItems.mockRejectedValue(
          cancelled([ok, failed(eventItem("inline", 5, { sealed: true })), ok]),
        )
        const { decide, decider: d } = spied()
        const error = yield* EventStore.commandHandler(d, Inline, {
          verifySnapshot: false,
          retry: 3,
        })(id, deposit1).pipe(Effect.flip)
        expectSealed(error, "Inline", "a-1", 5)
        expect(decide).toHaveBeenCalledOnce()
        expect(mockTransactWriteItems).toHaveBeenCalledOnce()
        expect(mockQuery).not.toHaveBeenCalled()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("unverified, unmarked snapshot further behind: the verified reload reports it", () =>
      Effect.gen(function* () {
        mockGetItem.mockResolvedValue({ Item: snapshotItem("inline", 3) })
        mockTransactWriteItems.mockRejectedValue(
          cancelled([ok, failed(eventItem("inline", 4)), ok]),
        )
        mockQuery.mockResolvedValue(
          latestPage(snapshotItem("inline", 3), [
            eventItem("inline", 4),
            eventItem("inline", 5, { sealed: true }),
          ]),
        )
        const { decide, decider: d } = spied()
        const error = yield* EventStore.commandHandler(d, Inline, { verifySnapshot: false })(
          id,
          deposit1,
        ).pipe(Effect.flip)
        expectSealed(error, "Inline", "a-1", 5)
        // Decided once on the stale snapshot, never again on the sealed reload.
        expect(decide).toHaveBeenCalledOnce()
        expect(mockTransactWriteItems).toHaveBeenCalledOnce()
        expect(mockQuery).toHaveBeenCalledOnce()
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  it.effect("DuplicateCommand ranks ahead of StreamSealed for a committed redelivery", () =>
    Effect.gen(function* () {
      mockQuery.mockResolvedValue({ Items: [eventItem("ledger", 1, { sealed: true })] })
      mockGetItem.mockResolvedValue({ Item: toAttributeMap({ pk: "x" }) })
      const error = yield* EventStore.commandHandler(decider, Ledger, { idempotency: {} })(
        id,
        deposit1,
        { commandId: "cmd-1" },
      ).pipe(Effect.flip)
      expect(error._tag).toBe("DuplicateCommand")
      const probe = mockGetItem.mock.calls[0]![0]
      expect(probe.ConsistentRead).toBe(true)
      expect(fromAttributeMap(probe.Key).sk).toBe("$seal#v1#ledger.command#cmd-1")

      // The sentinel absent: the seal.
      mockGetItem.mockResolvedValue({})
      const sealed = yield* EventStore.commandHandler(decider, Ledger, { idempotency: {} })(
        id,
        deposit1,
        { commandId: "cmd-2" },
      ).pipe(Effect.flip)
      expectSealed(sealed, "Ledger", "a-1", 1)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("StreamSealed ranks ahead of an If-Match mismatch", () =>
    Effect.gen(function* () {
      mockQuery.mockResolvedValue({
        Items: [eventItem("ledger", 1), eventItem("ledger", 2, { sealed: true })],
      })
      const error = yield* EventStore.commandHandler(decider, Ledger)(id, deposit1, {
        expectedVersion: 1,
      }).pipe(Effect.flip)
      expectSealed(error, "Ledger", "a-1", 2)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("a no-op decision on a sealed stream is StreamSealed", () =>
    Effect.gen(function* () {
      mockQuery.mockResolvedValue({ Items: [eventItem("ledger", 1, { sealed: true })] })
      const error = yield* EventStore.commandHandler(decider, Ledger)(id, { _tag: "Noop" }).pipe(
        Effect.flip,
      )
      expectSealed(error, "Ledger", "a-1", 1)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("an append-time StreamSealed is not retried", () =>
    Effect.gen(function* () {
      mockQuery.mockResolvedValue({ Items: [eventItem("ledger", 1)] })
      mockTransactWriteItems.mockRejectedValue(
        cancelled([failed(eventItem("ledger", 1, { sealed: true })), ok]),
      )
      const { decide, decider: d } = spied()
      const error = yield* EventStore.commandHandler(d, Ledger, { retry: 5 })(id, deposit1).pipe(
        Effect.flip,
      )
      expectSealed(error, "Ledger", "a-1", 1)
      expect(mockTransactWriteItems).toHaveBeenCalledOnce()
      expect(decide).toHaveBeenCalledOnce()
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("a seal followed by later events: StreamSealed at the seal, with a warning", () =>
    Effect.gen(function* () {
      mockQuery.mockResolvedValue({
        Items: [
          eventItem("ledger", 1),
          eventItem("ledger", 2, { sealed: true }),
          eventItem("ledger", 3),
          eventItem("ledger", 4),
        ],
      })
      const warnings: Array<string> = []
      const logger = Logger.make((options) => {
        if (options.logLevel === "Warn") warnings.push(String(options.message))
      })
      const { decide, decider: d } = spied()
      const error = yield* EventStore.commandHandler(d, Ledger)(id, deposit1).pipe(
        Effect.flip,
        Effect.provide(Logger.layer([logger])),
      )
      expectSealed(error, "Ledger", "a-1", 2)
      expect(decide).not.toHaveBeenCalled()
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain("sealed at version 2")
      expect(warnings[0]).toContain("versions 3…4")
    }).pipe(Effect.provide(TestLayer)),
  )

  for (const [label, sealedVersion] of [
    ["fractional", 5.5],
    ["below version", 3],
    ["NaN", Number.NaN],
  ] as const) {
    it.effect(`loadState returning a malformed sealedVersion (${label}) is a ValidationError`, () =>
      Effect.gen(function* () {
        const error = yield* EventStore.commandHandler(decider, Ledger, {
          loadState: () =>
            Effect.succeed(Option.some({ state: { balance: 4 }, version: 4, sealedVersion })),
        })(id, deposit1).pipe(Effect.flip)
        expect(error._tag).toBe("ValidationError")
        expect((error as ValidationError).operation).toBe("EventStore.commandHandler.loadState")
        expect(String((error as ValidationError).cause)).toContain("sealedVersion")
        expect(mockTransactWriteItems).not.toHaveBeenCalled()
      }).pipe(Effect.provide(TestLayer)),
    )
  }

  describe("a nested appendOp of another stream", () => {
    const openCommand = (from: number): LedgerCommand => ({ _tag: "Open", from })
    /** A's sealing op, its version taken from the decided opening event. */
    const sealA = (decision: EventStore.Decision<LedgerState, LedgerEvent>) => [
      Gen.appendOp(A, [close()], (decision.events[0] as Opened).continuesFrom, { seal: true }),
    ]
    /** [B event, A check, A event] with A's check failed: a stale append on A. */
    const staleA = () => cancelled([ok, failed(), ok])

    it.effect("a VersionConflict on A is retried, re-deriving additionalItems", () =>
      Effect.gen(function* () {
        // `decide` reads A each attempt: its version moved from 4 to 5.
        let aVersion = 4
        const decide = vi.fn((command: LedgerCommand) => {
          const from = command._tag === "Open" ? aVersion++ : 0
          return Effect.succeed([open(from)])
        })
        mockTransactWriteItems.mockRejectedValueOnce(staleA()).mockResolvedValueOnce({})
        const derive = vi.fn(sealA)

        const result = yield* EventStore.commandHandler({ ...decider, decide }, Gen, { retry: 2 })(
          B,
          openCommand(0),
          { additionalItems: derive },
        )

        expect(result.version).toBe(1)
        expect(mockTransactWriteItems).toHaveBeenCalledTimes(2)
        expect(derive).toHaveBeenCalledTimes(2)
        expect(fromAttributeMap(sent(0)[1].ConditionCheck.Key).sk).toBe(eventSk("gen", 4))
        expect(fromAttributeMap(sent(1)[1].ConditionCheck.Key).sk).toBe(eventSk("gen", 5))
        expect(putItem(sent(1)[0]).data).toEqual({ _tag: "Opened", continuesFrom: 5 })
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("with an If-Match on B and a schedule: retried, the If-Match rechecked", () =>
      Effect.gen(function* () {
        // B is at 1 on both loads.
        mockQuery.mockResolvedValue({ Items: [eventItem("gen", 1, { streamId: "a-1#2" })] })
        mockTransactWriteItems
          .mockRejectedValueOnce(cancelled([ok, ok, failed(), ok]))
          .mockResolvedValueOnce({})

        const result = yield* EventStore.commandHandler(decider, Gen, { retry: 2 })(
          B,
          openCommand(4),
          { expectedVersion: 1, additionalItems: sealA },
        )

        expect(result.version).toBe(2)
        expect(mockTransactWriteItems).toHaveBeenCalledTimes(2)
        expect(mockQuery).toHaveBeenCalledTimes(2)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("with an If-Match on B that the reload finds stale: VersionConflict(B)", () =>
      Effect.gen(function* () {
        mockQuery
          .mockResolvedValueOnce({ Items: [eventItem("gen", 1, { streamId: "a-1#2" })] })
          .mockResolvedValueOnce({
            Items: [
              eventItem("gen", 1, { streamId: "a-1#2" }),
              eventItem("gen", 2, { streamId: "a-1#2" }),
            ],
          })
        mockTransactWriteItems.mockRejectedValueOnce(cancelled([ok, ok, failed(), ok]))
        const { decide, decider: d } = spied()

        const error = yield* EventStore.commandHandler(d, Gen, { retry: 2 })(B, openCommand(4), {
          expectedVersion: 1,
          additionalItems: sealA,
        }).pipe(Effect.flip)

        expect(error).toBeInstanceOf(VersionConflict)
        expect(error).toMatchObject({ streamId: "a-1#2", expectedVersion: 1, actualVersion: 2 })
        expect(decide).toHaveBeenCalledOnce()
        expect(mockTransactWriteItems).toHaveBeenCalledOnce()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("without a schedule: returned as-is, naming A", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue({ Items: [eventItem("gen", 1, { streamId: "a-1#2" })] })
        mockTransactWriteItems.mockRejectedValueOnce(cancelled([ok, ok, failed(), ok]))
        const error = yield* EventStore.commandHandler(decider, Gen)(B, openCommand(4), {
          expectedVersion: 1,
          additionalItems: sealA,
        }).pipe(Effect.flip)
        expectConflict(error, "Gen", "a-1#1", 4)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("an own-stream VersionConflict under an If-Match is still not retried", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue({ Items: [eventItem("gen", 1, { streamId: "a-1#2" })] })
        mockTransactWriteItems.mockRejectedValue(cancelled([failed(), ok, ok, ok]))
        const error = yield* EventStore.commandHandler(decider, Gen, { retry: 5 })(
          B,
          openCommand(4),
          { expectedVersion: 1, additionalItems: sealA },
        ).pipe(Effect.flip)
        expectConflict(error, "Gen", "a-1#2", 1)
        expect(mockTransactWriteItems).toHaveBeenCalledOnce()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("with verifySnapshot: false: no verified reload of B, one decide per attempt", () =>
      Effect.gen(function* () {
        mockGetItem.mockResolvedValue({
          Item: toAttributeMap({
            ...fromAttributeMap(snapshotItem("geninline", 2)),
            pk: "$seal#v1#geninline#a-1#2",
            streamId: "a-1#2",
          }),
        })
        // [B check, B event, A check, A event, B snapshot]
        mockTransactWriteItems
          .mockRejectedValueOnce(cancelled([ok, ok, failed(), ok, ok]))
          .mockRejectedValueOnce(cancelled([ok, ok, failed(), ok, ok]))
          .mockResolvedValueOnce({})
        const { decide, decider: d } = spied()
        const handle = EventStore.commandHandler(d, GenInline, { verifySnapshot: false })

        const error = yield* handle(B, openCommand(4), { additionalItems: sealA }).pipe(Effect.flip)
        expectConflict(error, "Gen", "a-1#1", 4)
        expect(decide).toHaveBeenCalledOnce()
        expect(mockQuery).not.toHaveBeenCalled()

        decide.mockClear()
        const retried = yield* EventStore.commandHandler(d, GenInline, {
          verifySnapshot: false,
          retry: 2,
        })(B, openCommand(4), { additionalItems: sealA })
        expect(retried.version).toBe(3)
        expect(decide).toHaveBeenCalledTimes(2)
        expect(mockQuery).not.toHaveBeenCalled()
      }).pipe(Effect.provide(TestLayer)),
    )

    describe("another stream with the same formatted id", () => {
      const deposit2: LedgerCommand = { _tag: "Deposit", amount: 2 }
      /** Mirror (a-1) at 2: the same id as the handler's stream, another name. */
      const mirrorOp = () => [Mirror.appendOp(id, [deposit(9)], 2)]

      it.effect("its conflict is foreign: retried under an If-Match", () =>
        Effect.gen(function* () {
          mockQuery.mockResolvedValue({ Items: [eventItem("ledger", 1)] })
          // [Ledger check, Ledger event, Mirror check, Mirror event]
          mockTransactWriteItems
            .mockRejectedValueOnce(cancelled([ok, ok, failed(), ok]))
            .mockResolvedValueOnce({})

          const result = yield* EventStore.commandHandler(decider, Ledger, { retry: 2 })(
            id,
            deposit2,
            { expectedVersion: 1, additionalItems: mirrorOp },
          )

          expect(result.version).toBe(2)
          expect(mockTransactWriteItems).toHaveBeenCalledTimes(2)
          expect(kinds(sent(0))).toEqual(["check", "ledger.event", "check", "mirror.event"])
        }).pipe(Effect.provide(TestLayer)),
      )

      it.effect("without a schedule it is returned, naming the other stream", () =>
        Effect.gen(function* () {
          mockQuery.mockResolvedValue({ Items: [eventItem("ledger", 1)] })
          mockTransactWriteItems.mockRejectedValueOnce(cancelled([ok, ok, failed(), ok]))
          const error = yield* EventStore.commandHandler(decider, Ledger)(id, deposit2, {
            expectedVersion: 1,
            additionalItems: mirrorOp,
          }).pipe(Effect.flip)
          expectConflict(error, "Mirror", "a-1", 2)
        }).pipe(Effect.provide(TestLayer)),
      )

      it.effect("with verifySnapshot: false it is never taken for a lagging snapshot", () =>
        Effect.gen(function* () {
          mockGetItem.mockResolvedValue({ Item: snapshotItem("inline", 2) })
          // [Inline check, Inline event, Ledger check, Ledger event, Inline snapshot]
          mockTransactWriteItems.mockRejectedValueOnce(cancelled([ok, ok, failed(), ok, ok]))
          const { decide, decider: d } = spied()

          const error = yield* EventStore.commandHandler(d, Inline, { verifySnapshot: false })(
            id,
            deposit2,
            { additionalItems: () => [Ledger.appendOp(id, [deposit(9)], 2)] },
          ).pipe(Effect.flip)

          expectConflict(error, "Ledger", "a-1", 2)
          expect(kinds(sent())).toEqual([
            "check",
            "inline.event",
            "check",
            "ledger.event",
            "inline.snapshot",
          ])
          // No verified reload, no second decision.
          expect(mockQuery).not.toHaveBeenCalled()
          expect(decide).toHaveBeenCalledOnce()
        }).pipe(Effect.provide(TestLayer)),
      )
    })

    it.effect("a nested StreamSealed on A is terminal", () =>
      Effect.gen(function* () {
        mockTransactWriteItems.mockRejectedValue(
          cancelled([ok, failed(eventItem("gen", 4, { sealed: true, streamId: "a-1#1" })), ok]),
        )
        const error = yield* EventStore.commandHandler(decider, Gen, { retry: 5 })(
          B,
          openCommand(4),
          { additionalItems: sealA },
        ).pipe(Effect.flip)
        expectSealed(error, "Gen", "a-1#1", 4)
        expect(mockTransactWriteItems).toHaveBeenCalledOnce()
      }).pipe(Effect.provide(TestLayer)),
    )
  })
})

describe("EventStore seal (#166) — exports", () => {
  it("StreamSealed is exported from the package entry point", async () => {
    const entry = await import("../src/index.js")
    expect(entry.StreamSealed).toBe(StreamSealed)
  })
})
