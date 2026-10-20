/**
 * Connected integration tests for sealing a stream and nested stream appends
 * (#166) against a real DynamoDB Local.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 *
 * Asserts on the stored items and on the transactions sent: a sealed stream
 * refuses every later append with `StreamSealed` (and a stale writer further
 * behind with `VersionConflict`); a changeover — open the next generation,
 * seal the previous one through `appendOp`, and read-modify-write the chain
 * index under its revision — commits atomically, and each failing member
 * fails the whole transaction with its own error; `readLatest` returns the
 * seal; `commandHandler` stops without retrying; the documented boundaries
 * (an advanced record, a `writeSnapshot` at the seal, one bypass reopening
 * the stream) are pinned as they behave.
 */

import { it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import type { ValidationError } from "@effect-dynamodb/schema/Errors.js"
import { Config, Effect, Layer, Option, Schema } from "effect"
import { afterAll, beforeAll, describe, expect } from "vitest"
import {
  DynamoClient,
  type DynamoClientError,
  type DynamoClientService,
} from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
import * as Table from "../src/Table.js"

const ENDPOINT = Effect.runSync(
  Config.String("DYNAMODB_ENDPOINT").pipe(Config.withDefault("http://localhost:8000")),
)

let dynamoAvailable = false
try {
  const res = await fetch(ENDPOINT, { method: "POST", signal: AbortSignal.timeout(1000) }).catch(
    () => null,
  )
  dynamoAvailable = res !== null
} catch {
  dynamoAvailable = false
}

const describeConnected = dynamoAvailable ? describe : describe.skip

const AppSchema = DynamoSchema.make({ name: "seal-it", version: 1 })
const tableName = `stream-seal-${Date.now()}`
const otherTableName = `stream-seal-other-${Date.now()}`

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

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

/** The caller's state record; `sealedVersion` 0 means open. */
class Account extends Schema.Class<Account>("Account")({
  accountId: Schema.String,
  balance: Schema.Number,
  streamVersion: Schema.Number,
  sealedVersion: Schema.Number,
}) {}

const Accounts = Entity.make({
  model: Account,
  entityType: "Account",
  primaryKey: {
    pk: { field: "pk", composite: ["accountId"] },
    sk: { field: "sk", composite: [] },
  },
})

const SealTable = Table.make({ schema: AppSchema, entities: { Chains, Accounts } })
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

const LedgerStateSchema = Schema.Struct({ balance: Schema.Number })
interface LedgerState {
  readonly balance: number
}

/** Generational: one stream per `{ accountId, generation }`. No snapshot. */
const Ledger = EventStore.makeStream({
  table: SealTable,
  streamName: "Ledger",
  events,
  streamId: { composite: ["accountId", "generation"] },
})
/** The writers' definition: an inline snapshot in every append. */
const Snapped = EventStore.makeStream({
  table: SealTable,
  streamName: "Snapped",
  events,
  streamId: { composite: ["accountId"] },
  snapshot: { schema: LedgerStateSchema, mode: "inline" },
})
/** A closer's definition of the same stream, without the snapshot config. */
const SnappedCloser = EventStore.makeStream({
  table: SealTable,
  streamName: "Snapped",
  events,
  streamId: { composite: ["accountId"] },
})
/** Inline snapshots every three events. */
const Every = EventStore.makeStream({
  table: SealTable,
  streamName: "Every",
  events,
  streamId: { composite: ["accountId"] },
  snapshot: { schema: LedgerStateSchema, mode: "inline", every: 3 },
})
const json = DynamoModel.Packed({ format: "json" })
/** Packed data and snapshot state (#147). */
const PackedLedger = EventStore.makeStream({
  table: SealTable,
  streamName: "Packed",
  events,
  streamId: { composite: ["accountId"] },
  storedAs: { data: json },
  snapshot: { schema: LedgerStateSchema, mode: "inline", storedAs: json },
})
/** A generational stream on another table. */
const Remote = EventStore.makeStream({
  table: OtherTable,
  streamName: "Remote",
  events,
  streamId: { composite: ["accountId", "generation"] },
})

type LedgerCommand = { readonly _tag: "Deposit"; readonly amount: number }

const decider: EventStore.Decider<LedgerState, LedgerCommand, LedgerEvent> = {
  initialState: { balance: 0 },
  decide: (command) => Effect.succeed([new Deposited({ amount: command.amount })]),
  evolve: (state, event) =>
    event._tag === "Deposited" ? { balance: state.balance + event.amount } : state,
}
/** The decider, counting `decide` calls. */
const counted = () => {
  const calls = { decide: 0 }
  const d: EventStore.Decider<LedgerState, LedgerCommand, LedgerEvent> = {
    ...decider,
    decide: (command, state) => {
      calls.decide++
      return decider.decide(command, state)
    },
  }
  return { calls, decider: d }
}
const deposit = { _tag: "Deposit", amount: 1 } as const

// ---------------------------------------------------------------------------
// Client and helpers
// ---------------------------------------------------------------------------

/** Every `TransactWriteItems` sent, as the item kinds it carries. */
const transactions: Array<ReadonlyArray<string>> = []
const kindOf = (item: Record<string, any>): string =>
  item.ConditionCheck !== undefined
    ? "check"
    : String(item.Put?.Item?.__edd_e__?.S ?? Object.keys(item)[0])

const LoggingClient = Layer.effect(
  DynamoClient,
  Effect.map(
    DynamoClient,
    (client): DynamoClientService => ({
      ...client,
      transactWriteItems: (input) => {
        transactions.push(
          ((input.TransactItems ?? []) as ReadonlyArray<Record<string, any>>).map(kindOf),
        )
        return client.transactWriteItems(input)
      },
    }),
  ),
).pipe(
  Layer.provide(
    DynamoClient.layer({
      region: "us-east-1",
      endpoint: ENDPOINT,
      credentials: { accessKeyId: "local", secretAccessKey: "local" },
    }),
  ),
)

const TestLayer = Layer.mergeAll(LoggingClient, SealTable.layer({ name: tableName }))
const provide = Effect.provide(TestLayer)
const OtherTableLayer = OtherTable.layer({ name: otherTableName })

let accounts = 0
/** A fresh account id per test, so tests never share a stream. */
const fresh = () => `acct-${++accounts}`
const gen = (accountId: string, generation: string) => ({ accountId, generation })
const d = (amount = 1) => new Deposited({ amount })
const closed = (continuedIn = "2") => new Closed({ continuedIn })

/** `[version, sealed]` of each stored event, strongly consistent. */
const ledgerOf = (streamId: { accountId: string; generation: string }) =>
  Effect.map(Ledger.read(streamId, { consistentRead: true }), (read) =>
    read.map((event) => [event.version, event.sealed === true] as const),
  )
const snappedOf = (accountId: string) =>
  Effect.map(SnappedCloser.read({ accountId }, { consistentRead: true }), (read) =>
    read.map((event) => [event.version, event.sealed === true] as const),
  )

const chainOf = (accountId: string) => Entity.consistentRead(Chains.get({ accountId }))
/** The chain index's read-modify-write: the whole item, conditioned on the revision read. */
const chainPut = (accountId: string, read: Chain, current: string) =>
  Chains.put({ accountId, current, revision: read.revision + 1 }).pipe(
    Chains.condition({ revision: read.revision }),
  )

/** The `loadState` of a record-backed stream, mapping the record's seal. */
const loadRecord = (recordId: string) =>
  Effect.gen(function* () {
    const account = yield* Entity.consistentRead(Accounts.get({ accountId: recordId }))
    return Option.some({
      state: { balance: account.balance },
      version: account.streamVersion,
      ...(account.sealedVersion > 0 ? { sealedVersion: account.sealedVersion } : {}),
    })
  }).pipe(Effect.catchTag("ItemNotFound", () => Effect.succeed(Option.none())))
/** The same, ignoring the record's seal. */
const loadRecordUnmapped = (recordId: string) =>
  Effect.gen(function* () {
    const account = yield* Entity.consistentRead(Accounts.get({ accountId: recordId }))
    return Option.some({ state: { balance: account.balance }, version: account.streamVersion })
  })
const recordPut = (accountId: string, streamVersion: number, loaded: number, sealedVersion = 0) =>
  Accounts.put({ accountId, balance: streamVersion, streamVersion, sealedVersion }).pipe(
    Accounts.condition({ streamVersion: loaded }),
  )

describeConnected("EventStore sealing and nested appends (#166)", () => {
  beforeAll(async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* DynamoClient
        yield* client.createTable({
          TableName: tableName,
          BillingMode: "PAY_PER_REQUEST",
          ...Table.definition(SealTable),
        })
        yield* client.createTable({
          TableName: otherTableName,
          BillingMode: "PAY_PER_REQUEST",
          // Same key schema; the other table holds only a stream.
          ...Table.definition(SealTable),
        })
      }).pipe(provide),
    )
  }, 15000)

  afterAll(async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* DynamoClient
        for (const name of [tableName, otherTableName]) {
          yield* client
            .deleteTable({ TableName: name })
            .pipe(Effect.catchTag("ResourceNotFoundError", () => Effect.void))
        }
      }).pipe(provide),
    )
  })

  // -------------------------------------------------------------------------
  // The seal on one stream
  // -------------------------------------------------------------------------

  describe("a sealed stream", () => {
    it.effect("1. an append at the seal is StreamSealed, and the stream is unchanged", () =>
      Effect.gen(function* () {
        const A = gen(fresh(), "1")
        yield* Ledger.append(A, [d(), d()], 0)
        const sealed = yield* Ledger.append(A, [closed()], 2, { seal: true })
        expect(sealed.version).toBe(3)

        const error = yield* Ledger.append(A, [d()], 3).pipe(Effect.flip)
        expect(error._tag).toBe("StreamSealed")
        expect(error).toMatchObject({
          streamName: "Ledger",
          streamId: `${A.accountId}#1`,
          sealedVersion: 3,
        })
        expect(yield* ledgerOf(A)).toEqual([
          [1, false],
          [2, false],
          [3, true],
        ])
      }).pipe(provide),
    )

    it.effect("2. a stale writer at S - 1 is StreamSealed; at S - 2 VersionConflict", () =>
      Effect.gen(function* () {
        const A = gen(fresh(), "1")
        yield* Ledger.append(A, [d(), d(), d()], 0)
        yield* Ledger.append(A, [closed()], 3, { seal: true })

        const justBehind = yield* Ledger.append(A, [d()], 3).pipe(Effect.flip)
        expect(justBehind).toMatchObject({ _tag: "StreamSealed", sealedVersion: 4 })
        const furtherBehind = yield* Ledger.append(A, [d()], 2).pipe(Effect.flip)
        expect(furtherBehind).toMatchObject({ _tag: "VersionConflict", expectedVersion: 2 })
        expect((yield* ledgerOf(A)).length).toBe(4)
      }).pipe(provide),
    )

    it.effect(
      "3. expectedVersion 0 on a sealed stream: VersionConflict, StreamSealed at S = 1",
      () =>
        Effect.gen(function* () {
          const A = gen(fresh(), "1")
          yield* Ledger.append(A, [d(), closed()], 0, { seal: true })
          const error = yield* Ledger.append(A, [d()], 0).pipe(Effect.flip)
          expect(error._tag).toBe("VersionConflict")

          const one = gen(fresh(), "1")
          yield* Ledger.append(one, [closed()], 0, { seal: true })
          const sealed = yield* Ledger.append(one, [d()], 0).pipe(Effect.flip)
          expect(sealed).toMatchObject({ _tag: "StreamSealed", sealedVersion: 1 })
        }).pipe(provide),
    )

    it.effect("13. a redelivered idempotent sealing command is DuplicateCommand", () =>
      Effect.gen(function* () {
        const A = gen(fresh(), "1")
        yield* Ledger.append(A, [d()], 0)
        yield* Ledger.append(A, [closed()], 1, {
          seal: true,
          idempotency: { commandId: "close-1" },
        })
        const error = yield* Ledger.append(A, [closed()], 1, {
          seal: true,
          idempotency: { commandId: "close-1" },
        }).pipe(Effect.flip)
        expect(error).toMatchObject({ _tag: "DuplicateCommand", commandId: "close-1" })
      }).pipe(provide),
    )

    it.effect("14. a zero-event side write on a sealed stream succeeds", () =>
      Effect.gen(function* () {
        const accountId = fresh()
        const A = gen(accountId, "1")
        yield* Ledger.append(A, [closed()], 0, { seal: true })
        yield* Chains.put({ accountId, current: "1", revision: 1 })

        const result = yield* Ledger.append(A, [], 1, {
          additionalItems: [chainPut(accountId, yield* chainOf(accountId), "1")],
        })
        expect(result.version).toBe(1)
        expect((yield* chainOf(accountId)).revision).toBe(2)
        expect(yield* ledgerOf(A)).toEqual([[1, true]])
      }).pipe(provide),
    )
  })

  // -------------------------------------------------------------------------
  // The changeover
  // -------------------------------------------------------------------------

  describe("the changeover", () => {
    /** A at 3, the chain index at revision 5 pointing at generation 1. */
    const seed = Effect.gen(function* () {
      const accountId = fresh()
      yield* Ledger.append(gen(accountId, "1"), [d(10), d(20), d(30)], 0)
      yield* Chains.put({ accountId, current: "1", revision: 5 })
      return { accountId, A: gen(accountId, "1"), B: gen(accountId, "2") }
    })
    /** Open B from A's state read at `aVersion`, seal A there, move the chain index. */
    const changeover = (
      accountId: string,
      aVersion: number,
      chain: Chain,
      extra: ReadonlyArray<EventStore.AppendWriteOp> = [],
    ) =>
      Ledger.append(gen(accountId, "2"), [new Opened({ continuesFrom: aVersion })], 0, {
        additionalItems: [
          Ledger.appendOp(gen(accountId, "1"), [closed()], aVersion, { seal: true }),
          chainPut(accountId, chain, "2"),
          ...extra,
        ],
      })
    const unchanged = (accountId: string, aVersions: number) =>
      Effect.gen(function* () {
        expect((yield* ledgerOf(gen(accountId, "1"))).every(([, sealed]) => !sealed)).toBe(true)
        expect((yield* ledgerOf(gen(accountId, "1"))).length).toBe(aVersions)
        expect(yield* ledgerOf(gen(accountId, "2"))).toEqual([])
        expect(yield* chainOf(accountId)).toMatchObject({ current: "1", revision: 5 })
      })

    it.effect("4. one transaction opens B, seals A and moves the chain index", () =>
      Effect.gen(function* () {
        const { accountId, A, B } = yield* seed
        const latest = yield* Ledger.readLatest(A, { consistentRead: true })
        const chain = yield* chainOf(accountId)
        const mark = transactions.length

        const result = yield* changeover(accountId, latest.version, chain)

        expect(result.version).toBe(1)
        expect(transactions.slice(mark)).toEqual([
          ["ledger.event", "check", "ledger.event", "Chain"],
        ])
        const opened = yield* Ledger.read(B, { consistentRead: true })
        expect(opened.map((e) => e.data)).toEqual([new Opened({ continuesFrom: 3 })])
        expect(yield* ledgerOf(A)).toEqual([
          [1, false],
          [2, false],
          [3, false],
          [4, true],
        ])
        expect(yield* chainOf(accountId)).toMatchObject({ current: "2", revision: 6 })
        const sealedA = yield* Ledger.readLatest(A, { consistentRead: true })
        expect(sealedA.seal?.data).toEqual(closed())
      }).pipe(provide),
    )

    it.effect("5a. B already opened: VersionConflict(B), nothing written", () =>
      Effect.gen(function* () {
        const { accountId, B } = yield* seed
        yield* Ledger.append(B, [d()], 0)
        const error = yield* changeover(accountId, 3, yield* chainOf(accountId)).pipe(Effect.flip)
        expect(error).toMatchObject({
          _tag: "VersionConflict",
          streamId: `${accountId}#2`,
          expectedVersion: 0,
        })
        expect((yield* ledgerOf(gen(accountId, "1"))).every(([, sealed]) => !sealed)).toBe(true)
        expect(yield* chainOf(accountId)).toMatchObject({ current: "1", revision: 5 })
        expect(yield* ledgerOf(B)).toEqual([[1, false]])
      }).pipe(provide),
    )

    it.effect(
      "5b. a stale append on A after the carry-over read: VersionConflict(A), then converges",
      () =>
        Effect.gen(function* () {
          const { accountId, A, B } = yield* seed
          const latest = yield* Ledger.readLatest(A, { consistentRead: true })
          // A stale writer lands event 4 between the read and the commit.
          yield* Ledger.append(A, [d(40)], 3)

          const error = yield* changeover(
            accountId,
            latest.version,
            yield* chainOf(accountId),
          ).pipe(Effect.flip)
          expect(error).toMatchObject({
            _tag: "VersionConflict",
            streamId: `${accountId}#1`,
            expectedVersion: 3,
          })
          yield* unchanged(accountId, 4)

          // The closer re-reads A and builds both again: the opening carries event 4.
          const reread = yield* Ledger.readLatest(A, { consistentRead: true })
          yield* changeover(accountId, reread.version, yield* chainOf(accountId))
          const opened = yield* Ledger.read(B, { consistentRead: true })
          expect(opened.map((e) => e.data)).toEqual([new Opened({ continuesFrom: 4 })])
          expect((yield* ledgerOf(A)).at(-1)).toEqual([5, true])
        }).pipe(provide),
    )

    it.effect("5c. A already sealed by another closer: StreamSealed(A), nothing written", () =>
      Effect.gen(function* () {
        const { accountId, A } = yield* seed
        const latest = yield* Ledger.readLatest(A, { consistentRead: true })
        const chain = yield* chainOf(accountId)
        yield* Ledger.append(A, [closed("9")], 3, { seal: true })

        const error = yield* changeover(accountId, latest.version, chain).pipe(Effect.flip)
        expect(error).toMatchObject({
          _tag: "StreamSealed",
          streamId: `${accountId}#1`,
          sealedVersion: 4,
        })
        expect(yield* ledgerOf(gen(accountId, "2"))).toEqual([])
        expect(yield* chainOf(accountId)).toMatchObject({ current: "1", revision: 5 })
        // The closer that reads after the seal finds it on the check instead.
        const after = yield* changeover(accountId, 4, chain).pipe(Effect.flip)
        expect(after).toMatchObject({ _tag: "StreamSealed", sealedVersion: 4 })
      }).pipe(provide),
    )

    it.effect(
      "5d. the chain index revision moved: AdditionalItemConditionFailed, nothing written",
      () =>
        Effect.gen(function* () {
          const { accountId } = yield* seed
          const stale = new Chain({ accountId, current: "1", revision: 4 })
          const error = yield* changeover(accountId, 3, stale).pipe(Effect.flip)
          expect(error).toMatchObject({ _tag: "AdditionalItemConditionFailed", indices: [1] })
          yield* unchanged(accountId, 3)
        }).pipe(provide),
    )

    it.effect("6. across two tables, with a bound op on the other table", () =>
      Effect.gen(function* () {
        const accountId = fresh()
        const A = gen(accountId, "1")
        const B = gen(accountId, "2")
        const remote = yield* EventStore.bind(Remote).pipe(Effect.provide(OtherTableLayer))
        yield* remote.append(A, [d(), d()], 0)
        const latest = yield* remote.readLatest(A, { consistentRead: true })

        yield* Ledger.append(B, [new Opened({ continuesFrom: latest.version })], 0, {
          additionalItems: [remote.appendOp(A, [closed()], latest.version, { seal: true })],
        })

        const read = yield* remote.read(A, { consistentRead: true })
        expect(read.map((e) => [e.version, e.sealed === true])).toEqual([
          [1, false],
          [2, false],
          [3, true],
        ])
        expect(yield* ledgerOf(B)).toEqual([[1, false]])
        const sealed = yield* remote.append(A, [d()], 3).pipe(Effect.flip)
        expect(sealed).toMatchObject({ _tag: "StreamSealed", streamName: "Remote" })
      }).pipe(provide),
    )

    it.effect("6c. an atomic multi-stream append without a seal (B3)", () =>
      Effect.gen(function* () {
        const accountId = fresh()
        const A = gen(accountId, "1")
        const B = gen(accountId, "2")
        yield* Ledger.append(A, [d(), d(), d()], 0)
        const mark = transactions.length

        yield* Ledger.append(B, [d(5)], 0, { additionalItems: [Ledger.appendOp(A, [d(6)], 3)] })
        expect(transactions.slice(mark)).toEqual([["ledger.event", "check", "ledger.event"]])
        expect(yield* ledgerOf(A)).toEqual([
          [1, false],
          [2, false],
          [3, false],
          [4, false],
        ])
        expect(yield* ledgerOf(B)).toEqual([[1, false]])

        // A stale: neither stream changes.
        const error = yield* Ledger.append(B, [d(7)], 1, {
          additionalItems: [Ledger.appendOp(A, [d(8)], 3)],
        }).pipe(Effect.flip)
        expect(error).toMatchObject({
          _tag: "VersionConflict",
          streamId: `${accountId}#1`,
          expectedVersion: 3,
        })
        expect((yield* ledgerOf(A)).length).toBe(4)
        expect((yield* ledgerOf(B)).length).toBe(1)
      }).pipe(provide),
    )

    it.effect("6a. through a handler on B: a stale append on A is retried and converges", () =>
      Effect.gen(function* () {
        const accountId = fresh()
        const A = gen(accountId, "1")
        const B = gen(accountId, "2")
        yield* Ledger.append(A, [d(), d(), d()], 0)
        const boundA = yield* EventStore.bind(Ledger)

        // `decide` reads A through a bound stream (R = never): A's version
        // travels in the opening event.
        let decided = 0
        const opener: EventStore.Decider<
          LedgerState,
          { readonly _tag: "Continue" },
          LedgerEvent,
          DynamoClientError | ValidationError
        > = {
          initialState: { balance: 0 },
          decide: () =>
            Effect.gen(function* () {
              decided++
              const latest = yield* boundA.readLatest(A, { consistentRead: true })
              return [new Opened({ continuesFrom: latest.version })]
            }),
          evolve: (state) => state,
        }
        let stale = false
        const result = yield* EventStore.commandHandler(opener, Ledger, { retry: 2 })(
          B,
          { _tag: "Continue" },
          {
            additionalItems: (decision) =>
              Effect.gen(function* () {
                const from = (decision.events[0] as Opened).continuesFrom
                // A stale writer lands on A after the first decision read it.
                if (!stale) {
                  stale = true
                  yield* boundA.append(A, [d(99)], from)
                }
                return [Ledger.appendOp(A, [closed()], from, { seal: true })]
              }),
          },
        )

        expect(result.version).toBe(1)
        expect(decided).toBe(2)
        const opened = yield* Ledger.read(B, { consistentRead: true })
        expect(opened.map((e) => e.data)).toEqual([new Opened({ continuesFrom: 4 })])
        expect(yield* ledgerOf(A)).toEqual([
          [1, false],
          [2, false],
          [3, false],
          [4, false],
          [5, true],
        ])
      }).pipe(provide),
    )

    it.effect("6b. a loadState handler on A after a changeover that wrote A's record", () =>
      Effect.gen(function* () {
        const { accountId, A } = yield* seed
        const recordId = `${accountId}#1`
        yield* Accounts.put({
          accountId: recordId,
          balance: 60,
          streamVersion: 3,
          sealedVersion: 0,
        })
        const mark = transactions.length

        yield* changeover(accountId, 3, yield* chainOf(accountId), [recordPut(recordId, 3, 3, 4)])
        const { calls, decider: d2 } = counted()
        const error = yield* EventStore.commandHandler(d2, Ledger, {
          loadState: () => loadRecord(recordId),
          retry: 3,
        })(A, deposit).pipe(Effect.flip)

        expect(error).toMatchObject({ _tag: "StreamSealed", sealedVersion: 4 })
        expect(calls.decide).toBe(0)
        expect(transactions.length - mark).toBe(1)
      }).pipe(provide),
    )
  })

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  describe("7. readLatest returns the seal", () => {
    it.effect("no snapshot config", () =>
      Effect.gen(function* () {
        const A = gen(fresh(), "1")
        yield* Ledger.append(A, [d(), closed()], 0, { seal: true })
        const latest = yield* Ledger.readLatest(A, { consistentRead: true })
        expect(latest.seal).toMatchObject({ version: 2, sealed: true, data: closed() })
        expect(latest.events.at(-1)).toEqual(latest.seal)
      }).pipe(provide),
    )

    it.effect("verified, with a snapshot before the seal", () =>
      Effect.gen(function* () {
        const accountId = fresh()
        yield* Every.append({ accountId }, [d(), d(), d()], 0, { snapshot: { balance: 3 } })
        yield* Every.append({ accountId }, [d(), closed()], 3, { seal: true })
        const latest = yield* Every.readLatest({ accountId }, { consistentRead: true })
        expect(Option.getOrThrow(latest.snapshot).asOfVersion).toBe(3)
        expect(latest.seal).toMatchObject({ version: 5, data: closed() })
        expect(latest.events.map((e) => e.version)).toEqual([4, 5])
      }).pipe(provide),
    )

    it.effect("verified with the snapshot at the seal, and verifySnapshot: false", () =>
      Effect.gen(function* () {
        const accountId = fresh()
        yield* Snapped.append({ accountId }, [d()], 0, { snapshot: { balance: 1 } })
        yield* Snapped.append({ accountId }, [closed()], 1, {
          seal: true,
          snapshot: { balance: 1 },
        })
        const latest = yield* Snapped.readLatest({ accountId }, { consistentRead: true })
        expect(Option.getOrThrow(latest.snapshot).asOfVersion).toBe(2)
        expect(latest.seal).toMatchObject({ version: 2, data: closed() })
        expect(latest.events).toEqual([])

        const unverified = yield* Snapped.readLatest(
          { accountId },
          { consistentRead: true, verifySnapshot: false },
        )
        expect(unverified.seal).toEqual(latest.seal)
        expect(unverified.version).toBe(2)
      }).pipe(provide),
    )

    it.effect("12. packed storage: seal, read, readLatest", () =>
      Effect.gen(function* () {
        const accountId = fresh()
        yield* PackedLedger.append({ accountId }, [d(5), d(6)], 0, { snapshot: { balance: 11 } })
        yield* PackedLedger.append({ accountId }, [closed()], 2, {
          seal: true,
          snapshot: { balance: 11 },
        })
        const read = yield* PackedLedger.read({ accountId }, { consistentRead: true })
        expect(read.map((e) => e.sealed === true)).toEqual([false, false, true])
        expect(read[2]!.data).toEqual(closed())
        const latest = yield* PackedLedger.readLatest({ accountId }, { consistentRead: true })
        expect(latest.seal).toEqual(read[2])
        expect(Option.getOrThrow(latest.snapshot).state).toEqual({ balance: 11 })
        const unverified = yield* PackedLedger.readLatest(
          { accountId },
          { consistentRead: true, verifySnapshot: false },
        )
        expect(unverified.seal).toEqual(read[2])
        const error = yield* PackedLedger.append({ accountId }, [d()], 3, {
          snapshot: { balance: 12 },
        }).pipe(Effect.flip)
        expect(error._tag).toBe("StreamSealed")
      }).pipe(provide),
    )
  })

  // -------------------------------------------------------------------------
  // commandHandler
  // -------------------------------------------------------------------------

  describe("8. commandHandler stops on a seal without retrying", () => {
    const expectStopped = (
      error: unknown,
      sealedVersion: number,
      calls: { decide: number },
      decides: number,
      sentSince: number,
      sends: number,
    ) => {
      expect(error).toMatchObject({ _tag: "StreamSealed", sealedVersion })
      expect(calls.decide).toBe(decides)
      expect(transactions.length - sentSince).toBe(sends)
    }

    it.effect("no snapshot config: before decide", () =>
      Effect.gen(function* () {
        const A = gen(fresh(), "1")
        yield* Ledger.append(A, [d(), closed()], 0, { seal: true })
        const { calls, decider: dd } = counted()
        const mark = transactions.length
        const error = yield* EventStore.commandHandler(dd, Ledger, { retry: 3 })(A, deposit).pipe(
          Effect.flip,
        )
        expectStopped(error, 2, calls, 0, mark, 0)
      }).pipe(provide),
    )

    it.effect("verified and unverified snapshot loads: before decide", () =>
      Effect.gen(function* () {
        const accountId = fresh()
        yield* Snapped.append({ accountId }, [d(), closed()], 0, {
          seal: true,
          snapshot: { balance: 1 },
        })
        for (const verifySnapshot of [true, false]) {
          const { calls, decider: dd } = counted()
          const mark = transactions.length
          const error = yield* EventStore.commandHandler(dd, Snapped, { retry: 3, verifySnapshot })(
            { accountId },
            deposit,
          ).pipe(Effect.flip)
          expectStopped(error, 2, calls, 0, mark, 0)
        }
      }).pipe(provide),
    )

    it.effect("loadState with sealedVersion: before decide; without: one append, no retry", () =>
      Effect.gen(function* () {
        const A = gen(fresh(), "1")
        const recordId = `${A.accountId}#1`
        yield* Ledger.append(A, [d(), d(), closed()], 0, { seal: true })
        // The record at S - 1 and at S, both flagged with the seal.
        for (const streamVersion of [2, 3]) {
          yield* Accounts.put({ accountId: recordId, balance: 2, streamVersion, sealedVersion: 3 })
          const mapped = counted()
          let mark = transactions.length
          const before = yield* EventStore.commandHandler(mapped.decider, Ledger, {
            loadState: () => loadRecord(recordId),
            retry: 3,
          })(A, deposit).pipe(Effect.flip)
          expectStopped(before, 3, mapped.calls, 0, mark, 0)

          const unmapped = counted()
          mark = transactions.length
          const atAppend = yield* EventStore.commandHandler(unmapped.decider, Ledger, {
            loadState: () => loadRecordUnmapped(recordId),
            retry: 3,
          })(A, deposit).pipe(Effect.flip)
          expectStopped(atAppend, 3, unmapped.calls, 1, mark, 1)
        }
        expect((yield* ledgerOf(A)).length).toBe(3)
      }).pipe(provide),
    )

    it.effect("verifySnapshot: false, sealed by a closer without the snapshot config", () =>
      Effect.gen(function* () {
        const accountId = fresh()
        yield* Snapped.append({ accountId }, [d(), d()], 0, { snapshot: { balance: 2 } })
        // The closer's definition writes no snapshot: it stays at 2, unmarked.
        yield* SnappedCloser.append({ accountId }, [closed()], 2, { seal: true })

        const { calls, decider: dd } = counted()
        const mark = transactions.length
        const error = yield* EventStore.commandHandler(dd, Snapped, {
          retry: 3,
          verifySnapshot: false,
        })({ accountId }, deposit).pipe(Effect.flip)
        // Decided on the snapshot at 2; the first put at 3 hit the seal.
        expectStopped(error, 3, calls, 1, mark, 1)
        expect(yield* snappedOf(accountId)).toEqual([
          [1, false],
          [2, false],
          [3, true],
        ])
      }).pipe(provide),
    )
  })

  // -------------------------------------------------------------------------
  // Head proofs and the documented boundaries
  // -------------------------------------------------------------------------

  describe("9. head proofs", () => {
    it.effect("a snapshot proof at S after a sealing append with a snapshot", () =>
      Effect.gen(function* () {
        const accountId = fresh()
        yield* Snapped.append({ accountId }, [d()], 0, { snapshot: { balance: 1 } })
        yield* Snapped.append({ accountId }, [closed()], 1, {
          seal: true,
          snapshot: { balance: 1 },
        })
        const error = yield* Snapped.append({ accountId }, [d()], 2, {
          snapshot: { balance: 2 },
          headProof: "snapshot",
        }).pipe(Effect.flip)
        expect(error).toMatchObject({ _tag: "StreamSealed", sealedVersion: 2 })
        expect((yield* snappedOf(accountId)).length).toBe(2)
      }).pipe(provide),
    )

    it.effect("the record kept at S - 1: a record-proof writer gets StreamSealed", () =>
      Effect.gen(function* () {
        const A = gen(fresh(), "1")
        const recordId = `${A.accountId}#1`
        yield* Ledger.append(A, [d(), d()], 0, {
          additionalItems: [
            Accounts.put({ accountId: recordId, balance: 2, streamVersion: 2, sealedVersion: 0 }),
          ],
        })
        // One-event seal; the record flagged but kept at E = 2, proving the head.
        yield* Ledger.append(A, [closed()], 2, {
          seal: true,
          additionalItems: [recordPut(recordId, 2, 2, 3)],
          headProof: { additionalItem: 0 },
        })

        const error = yield* Ledger.append(A, [d()], 2, {
          additionalItems: [recordPut(recordId, 3, 2)],
          headProof: { additionalItem: 0 },
        }).pipe(Effect.flip)
        expect(error).toMatchObject({ _tag: "StreamSealed", sealedVersion: 3 })
        expect(yield* ledgerOf(A)).toEqual([
          [1, false],
          [2, false],
          [3, true],
        ])
        expect(yield* Entity.consistentRead(Accounts.get({ accountId: recordId }))).toMatchObject({
          streamVersion: 2,
          sealedVersion: 3,
        })

        // A handler mapping the record's seal stops before decide.
        const { calls, decider: dd } = counted()
        const mark = transactions.length
        const handled = yield* EventStore.commandHandler(dd, Ledger, {
          loadState: () => loadRecord(recordId),
          headProof: { additionalItem: 0 },
          retry: 3,
        })(A, deposit, {
          additionalItems: ({ version }) => [recordPut(recordId, version + 1, version)],
        }).pipe(Effect.flip)
        expect(handled).toMatchObject({ _tag: "StreamSealed", sealedVersion: 3 })
        expect(calls.decide).toBe(0)
        expect(transactions.length).toBe(mark)
      }).pipe(provide),
    )

    it.effect(
      "11. the record advanced to S: a record-proof append lands past the seal and reopens the stream",
      () =>
        Effect.gen(function* () {
          const A = gen(fresh(), "1")
          const recordId = `${A.accountId}#1`
          yield* Ledger.append(A, [d(), d()], 0)
          yield* Ledger.append(A, [closed()], 2, {
            seal: true,
            additionalItems: [
              Accounts.put({ accountId: recordId, balance: 2, streamVersion: 3, sealedVersion: 3 }),
            ],
          })

          // The documented boundary (§5.4): the flag is not tested, so S + 1 lands.
          const bypass = yield* Ledger.append(A, [d()], 3, {
            additionalItems: [recordPut(recordId, 4, 3)],
            headProof: { additionalItem: 0 },
          })
          expect(bypass.version).toBe(4)
          // ...and the stream is reopened for every writer (§5.9).
          const after = yield* Ledger.append(A, [d()], 4)
          expect(after.version).toBe(5)

          const latest = yield* Ledger.readLatest(A, { consistentRead: true })
          expect(latest.seal?.version).toBe(3)
          expect(latest.version).toBe(5)

          const { calls, decider: dd } = counted()
          const error = yield* EventStore.commandHandler(dd, Ledger, { retry: 3 })(A, deposit).pipe(
            Effect.flip,
          )
          expect(error).toMatchObject({ _tag: "StreamSealed", sealedVersion: 3 })
          expect(calls.decide).toBe(0)
        }).pipe(provide),
    )

    it.effect("11. verified inline readLatest finds a seal behind a bypass within its read", () =>
      Effect.gen(function* () {
        const accountId = fresh()
        yield* Every.append({ accountId }, [d(), d()], 0, {
          snapshot: { balance: 2 },
          additionalItems: [
            Accounts.put({ accountId, balance: 2, streamVersion: 3, sealedVersion: 0 }),
          ],
        })
        yield* Every.append({ accountId }, [closed()], 2, { seal: true })
        yield* Every.append({ accountId }, [d()], 3, {
          additionalItems: [recordPut(accountId, 4, 3)],
          headProof: { additionalItem: 0 },
        })
        yield* Every.append({ accountId }, [d()], 4)

        const latest = yield* Every.readLatest({ accountId }, { consistentRead: true })
        expect(Option.getOrThrow(latest.snapshot).asOfVersion).toBe(2)
        expect(latest.seal?.version).toBe(3)
        expect(latest.version).toBe(5)
        expect(latest.events.map((e) => e.version)).toEqual([3, 4, 5])
      }).pipe(provide),
    )
  })

  describe("10. writeSnapshot on a sealed head (the documented residual)", () => {
    it.effect("a closer without the snapshot config, then writeSnapshot at S", () =>
      Effect.gen(function* () {
        const accountId = fresh()
        yield* Snapped.append({ accountId }, [d()], 0, { snapshot: { balance: 1 } })
        yield* Snapped.append({ accountId }, [d()], 1, { snapshot: { balance: 2 } })
        yield* SnappedCloser.append({ accountId }, [closed()], 2, { seal: true })

        // The snapshot stayed at 2, unmarked: a proof there passes, and the
        // first put at 3 hits the seal.
        const behind = yield* Snapped.append({ accountId }, [d()], 2, {
          snapshot: { balance: 3 },
          headProof: "snapshot",
        }).pipe(Effect.flip)
        expect(behind).toMatchObject({ _tag: "StreamSealed", sealedVersion: 3 })
        // An unverified read sees only that snapshot.
        const unverified = yield* Snapped.readLatest({ accountId }, { verifySnapshot: false })
        expect(unverified.seal).toBeUndefined()

        // writeSnapshot at S puts an unmarked snapshot at the seal version...
        yield* Snapped.writeSnapshot({ accountId }, { balance: 2 }, 3)
        // ...and a snapshot-proof append at S lands past the seal.
        const landed = yield* Snapped.append({ accountId }, [d()], 3, {
          snapshot: { balance: 3 },
          headProof: "snapshot",
        })
        expect(landed.version).toBe(4)
        expect(yield* snappedOf(accountId)).toEqual([
          [1, false],
          [2, false],
          [3, true],
          [4, false],
        ])
        // A full read reports it: the seal is behind the head.
        const full = yield* SnappedCloser.readLatest({ accountId }, { consistentRead: true })
        expect(full.seal?.version).toBe(3)
        expect(full.version).toBe(4)
        // The writers' verified read holds the new snapshot and one event:
        // the sealing event is outside it (§5.9, where the read side is blind).
        const writers = yield* Snapped.readLatest({ accountId }, { consistentRead: true })
        expect(writers.version).toBe(4)
        expect(writers.seal).toBeUndefined()
      }).pipe(provide),
    )

    it.effect("sealing through the writers' definition: writeSnapshot at S is a no-op", () =>
      Effect.gen(function* () {
        const accountId = fresh()
        yield* Snapped.append({ accountId }, [d()], 0, { snapshot: { balance: 1 } })
        yield* Snapped.append({ accountId }, [closed()], 1, {
          seal: true,
          snapshot: { balance: 1 },
        })
        yield* Snapped.writeSnapshot({ accountId }, { balance: 99 }, 2)

        const snapshot = Option.getOrThrow(yield* Snapped.readSnapshot({ accountId }))
        expect(snapshot.state).toEqual({ balance: 1 })
        const unverified = yield* Snapped.readLatest(
          { accountId },
          { consistentRead: true, verifySnapshot: false },
        )
        expect(unverified.seal?.version).toBe(2)
        const error = yield* Snapped.append({ accountId }, [d()], 2, {
          snapshot: { balance: 2 },
          headProof: "snapshot",
        }).pipe(Effect.flip)
        expect(error).toMatchObject({ _tag: "StreamSealed", sealedVersion: 2 })
      }).pipe(provide),
    )
  })
})
