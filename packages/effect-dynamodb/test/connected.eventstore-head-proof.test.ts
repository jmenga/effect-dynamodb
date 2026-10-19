/**
 * Connected integration tests for the append head proof and `commandHandler`
 * `loadState` (#164) against a real DynamoDB Local.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 *
 * Asserts on the transactions sent and on the stored items: a head proof
 * leaves out the version-contiguity `ConditionCheck`; a stale or ahead proof
 * is a `VersionConflict` with nothing written, so no gap opens; a handler that
 * loads its state from the caller's record retries a lost race through
 * `loadState`; a snapshot proof falls back to the check when the snapshot lags.
 */

import { it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Config, Data, Effect, Layer, Option, Schema } from "effect"
import { afterAll, beforeAll, describe, expect } from "vitest"
import { DynamoClient, type DynamoClientService } from "../src/DynamoClient.js"
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

const AppSchema = DynamoSchema.make({ name: "proof-it", version: 1 })
const tableName = `head-proof-${Date.now()}`

class Deposited extends Schema.TaggedClass<Deposited>()("Deposited", {
  amount: Schema.Number,
}) {}
class Withdrew extends Schema.TaggedClass<Withdrew>()("Withdrew", {
  amount: Schema.Number,
}) {}
type LedgerEvent = Deposited | Withdrew

/** The caller's state record: the account's state plus the stream version it is as of. */
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

/** The same record on a versioned entity — its put is a guarded put. */
const VersionedAccounts = Entity.make({
  model: Account,
  entityType: "VersionedAccount",
  primaryKey: {
    pk: { field: "pk", composite: ["accountId"] },
    sk: { field: "sk", composite: [] },
  },
  versioned: true,
})

const ProofTable = Table.make({ schema: AppSchema, entities: { Accounts, VersionedAccounts } })

const Ledger = EventStore.makeStream({
  table: ProofTable,
  streamName: "Ledger",
  events: [Deposited, Withdrew],
  streamId: { composite: ["accountId"] },
})

const LedgerState = Schema.Struct({ balance: Schema.Number })

const Snapped = EventStore.makeStream({
  table: ProofTable,
  streamName: "Snapped",
  events: [Deposited, Withdrew],
  streamId: { composite: ["accountId"] },
  snapshot: { schema: LedgerState, mode: "inline" },
})

interface LedgerState {
  readonly balance: number
}
type LedgerCommand =
  | { readonly _tag: "Deposit"; readonly amount: number }
  | { readonly _tag: "Withdraw"; readonly amount: number }
class InsufficientFunds extends Data.TaggedError("InsufficientFunds") {}

const decider: EventStore.Decider<LedgerState, LedgerCommand, LedgerEvent, InsufficientFunds> = {
  initialState: { balance: 0 },
  decide: (command, state) =>
    Effect.gen(function* () {
      if (command._tag === "Deposit") return [new Deposited({ amount: command.amount })]
      if (state.balance < command.amount) return yield* new InsufficientFunds()
      return [new Withdrew({ amount: command.amount })]
    }),
  evolve: (state, event) =>
    event instanceof Deposited
      ? { balance: state.balance + event.amount }
      : { balance: state.balance - event.amount },
}

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

const TestLayer = Layer.mergeAll(LoggingClient, ProofTable.layer({ name: tableName }))
const provide = Effect.provide(TestLayer)

/** The record put for an append after `loaded`, conditioned on it. */
const recordPut = (accountId: string, balance: number, version: number, loaded: number) =>
  Accounts.put({ accountId, balance, streamVersion: version }).pipe(
    loaded === 0
      ? Accounts.condition((t, { notExists }) => notExists(t.streamVersion))
      : Accounts.condition({ streamVersion: loaded }),
  )

/** The caller's load: strongly consistent, as the contract asks. */
const loadAccount = (accountId: string) =>
  Effect.gen(function* () {
    const account = yield* Entity.consistentRead(Accounts.get({ accountId }))
    return Option.some({ state: { balance: account.balance }, version: account.streamVersion })
  }).pipe(Effect.catchTag("ItemNotFound", () => Effect.succeed(Option.none())))

const versions = <S extends typeof Ledger | typeof Snapped>(stream: S, accountId: string) =>
  Effect.map((stream as typeof Ledger).read({ accountId }, { consistentRead: true }), (events) =>
    events.map((event) => event.version),
  )

describeConnected("EventStore head proof and loadState (#164)", () => {
  beforeAll(async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* DynamoClient
        yield* client.createTable({
          TableName: tableName,
          BillingMode: "PAY_PER_REQUEST",
          ...Table.definition(ProofTable),
        })
      }).pipe(provide),
    )
  }, 15000)

  afterAll(async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* DynamoClient
        yield* client.deleteTable({ TableName: tableName })
      }).pipe(
        provide,
        Effect.catchTag("ResourceNotFoundError", () => Effect.void),
      ),
    )
  })

  describe("append({ headProof: { additionalItem } })", () => {
    it.effect("the record proves the head: no contiguity check is sent", () =>
      Effect.gen(function* () {
        const accountId = "record-1"
        const key = { accountId }
        const mark = transactions.length
        for (let v = 0; v < 3; v++) {
          yield* Ledger.append(key, [new Deposited({ amount: 10 })], v, {
            additionalItems: [recordPut(accountId, (v + 1) * 10, v + 1, v)],
            headProof: { additionalItem: 0 },
          })
        }

        expect(transactions.slice(mark)).toEqual([
          ["ledger.event", "Account"],
          ["ledger.event", "Account"],
          ["ledger.event", "Account"],
        ])
        expect(yield* versions(Ledger, accountId)).toEqual([1, 2, 3])
        const account = yield* Entity.consistentRead(Accounts.get({ accountId }))
        expect(account).toMatchObject({ balance: 30, streamVersion: 3 })
      }).pipe(provide),
    )

    it.effect("a stale or ahead record is a VersionConflict, and nothing is written", () =>
      Effect.gen(function* () {
        const accountId = "record-stale"
        const key = { accountId }
        for (let v = 0; v < 2; v++) {
          yield* Ledger.append(key, [new Deposited({ amount: 10 })], v, {
            additionalItems: [recordPut(accountId, (v + 1) * 10, v + 1, v)],
            headProof: { additionalItem: 0 },
          })
        }

        // Stale: the head is 2, the caller loaded 1. The event put fails too.
        const stale = yield* Ledger.append(key, [new Deposited({ amount: 1 })], 1, {
          additionalItems: [recordPut(accountId, 11, 2, 1)],
          headProof: { additionalItem: 0 },
        }).pipe(Effect.flip)
        expect(stale._tag).toBe("VersionConflict")

        // Ahead: the event slot at 6 is free, so only the record (at 2, not 5)
        // stands between this append and a gap at 3–5.
        const ahead = yield* Ledger.append(key, [new Deposited({ amount: 1 })], 5, {
          additionalItems: [recordPut(accountId, 21, 6, 5)],
          headProof: { additionalItem: 0 },
        }).pipe(Effect.flip)
        expect(ahead._tag).toBe("VersionConflict")
        expect((ahead as { expectedVersion?: number }).expectedVersion).toBe(5)

        expect(yield* versions(Ledger, accountId)).toEqual([1, 2])
        const account = yield* Entity.consistentRead(Accounts.get({ accountId }))
        expect(account).toMatchObject({ balance: 20, streamVersion: 2 })
      }).pipe(provide),
    )

    it.effect("an unconditioned record is refused before anything is written", () =>
      Effect.gen(function* () {
        const accountId = "record-unconditioned"
        const mark = transactions.length
        const error = yield* Ledger.append({ accountId }, [new Deposited({ amount: 1 })], 0, {
          additionalItems: [Accounts.put({ accountId, balance: 1, streamVersion: 1 })],
          headProof: { additionalItem: 0 },
        }).pipe(Effect.flip)

        expect(error._tag).toBe("ValidationError")
        expect(transactions.length).toBe(mark)
        expect(yield* versions(Ledger, accountId)).toEqual([])
      }).pipe(provide),
    )

    it.effect("a versioned record (a guarded put) proves the head the same way", () =>
      Effect.gen(function* () {
        const accountId = "record-versioned"
        const key = { accountId }
        const put = (balance: number, version: number, loaded: number) =>
          VersionedAccounts.put({ accountId, balance, streamVersion: version }).pipe(
            loaded === 0
              ? VersionedAccounts.condition((t, { notExists }) => notExists(t.streamVersion))
              : VersionedAccounts.condition({ streamVersion: loaded }),
          )
        const mark = transactions.length
        yield* Ledger.append(key, [new Deposited({ amount: 5 })], 0, {
          additionalItems: [put(5, 1, 0)],
          headProof: { additionalItem: 0 },
        })
        yield* Ledger.append(key, [new Deposited({ amount: 5 })], 1, {
          additionalItems: [put(10, 2, 1)],
          headProof: { additionalItem: 0 },
        })
        expect(transactions.slice(mark)).toEqual([
          ["ledger.event", "VersionedAccount"],
          ["ledger.event", "VersionedAccount"],
        ])

        const ahead = yield* Ledger.append(key, [new Deposited({ amount: 5 })], 4, {
          additionalItems: [put(15, 5, 4)],
          headProof: { additionalItem: 0 },
        }).pipe(Effect.flip)
        expect(ahead._tag).toBe("VersionConflict")
        expect(yield* versions(Ledger, accountId)).toEqual([1, 2])
      }).pipe(provide),
    )
  })

  describe("commandHandler({ loadState, headProof })", () => {
    const handlerFor = (accountId: string, retry?: number) =>
      EventStore.commandHandler(decider, Ledger, {
        loadState: () => loadAccount(accountId),
        headProof: { additionalItem: 0 },
        ...(retry === undefined ? {} : { retry }),
      })
    const withRecord =
      (accountId: string) => (decision: EventStore.Decision<LedgerState, LedgerEvent>) => [
        recordPut(
          accountId,
          decision.state.balance,
          decision.version + decision.events.length,
          decision.version,
        ),
      ]

    it.effect("loads from the record, decides, and writes the record with the events", () =>
      Effect.gen(function* () {
        const accountId = "handler-1"
        const key = { accountId }
        const handle = handlerFor(accountId)
        const mark = transactions.length

        yield* handle(
          key,
          { _tag: "Deposit", amount: 50 },
          { additionalItems: withRecord(accountId) },
        )
        yield* handle(
          key,
          { _tag: "Withdraw", amount: 20 },
          { additionalItems: withRecord(accountId) },
        )
        const result = yield* handle(
          key,
          { _tag: "Deposit", amount: 5 },
          { additionalItems: withRecord(accountId) },
        )

        expect(result).toMatchObject({ version: 3, state: { balance: 35 } })
        expect(transactions.slice(mark)).toEqual([
          ["ledger.event", "Account"],
          ["ledger.event", "Account"],
          ["ledger.event", "Account"],
        ])
        expect(yield* versions(Ledger, accountId)).toEqual([1, 2, 3])
        const account = yield* Entity.consistentRead(Accounts.get({ accountId }))
        expect(account).toMatchObject({ balance: 35, streamVersion: 3 })

        // A domain error is answered from the record.
        const error = yield* handle(key, { _tag: "Withdraw", amount: 100 }).pipe(Effect.flip)
        expect(error._tag).toBe("InsufficientFunds")
      }).pipe(provide),
    )

    it.effect("a lost race re-runs loadState under the retry policy", () =>
      Effect.gen(function* () {
        const accountId = "handler-race"
        const key = { accountId }
        yield* handlerFor(accountId)(
          key,
          { _tag: "Deposit", amount: 10 },
          { additionalItems: withRecord(accountId) },
        )

        // A rival commits between this handler's load and its append: the
        // first decision is made on state the record has since moved past.
        const services = yield* Effect.context<DynamoClient | Table.TableConfig>()
        let loads = 0
        let raced = false
        const racingDecider: typeof decider = {
          ...decider,
          decide: (command, state) =>
            Effect.gen(function* () {
              if (!raced) {
                raced = true
                yield* handlerFor(accountId)(
                  key,
                  { _tag: "Deposit", amount: 100 },
                  { additionalItems: withRecord(accountId) },
                ).pipe(Effect.provide(services), Effect.orDie)
              }
              return yield* decider.decide(command, state)
            }),
        }
        const racing = EventStore.commandHandler(racingDecider, Ledger, {
          loadState: () => {
            loads++
            return loadAccount(accountId)
          },
          headProof: { additionalItem: 0 },
          retry: 2,
        })

        const result = yield* racing(
          key,
          { _tag: "Deposit", amount: 50 },
          { additionalItems: withRecord(accountId) },
        )

        expect(raced).toBe(true)
        expect(loads).toBe(2)
        expect(result).toMatchObject({ version: 3, state: { balance: 160 } })
        expect(yield* versions(Ledger, accountId)).toEqual([1, 2, 3])
        const account = yield* Entity.consistentRead(Accounts.get({ accountId }))
        expect(account).toMatchObject({ balance: 160, streamVersion: 3 })
      }).pipe(provide),
    )

    it.effect("a writer that skips the record leaves conflicts, never a gap", () =>
      Effect.gen(function* () {
        const accountId = "handler-contract"
        const key = { accountId }
        const handle = handlerFor(accountId, 2)
        yield* handle(
          key,
          { _tag: "Deposit", amount: 10 },
          { additionalItems: withRecord(accountId) },
        )
        // A raw append without the record: the record stays at 1, the head is 2.
        yield* Ledger.append(key, [new Deposited({ amount: 1 })], 1)

        const error = yield* handle(
          key,
          { _tag: "Deposit", amount: 10 },
          { additionalItems: withRecord(accountId) },
        ).pipe(Effect.flip)

        expect(error._tag).toBe("VersionConflict")
        expect(yield* versions(Ledger, accountId)).toEqual([1, 2])
      }).pipe(provide),
    )

    it.effect("without headProof, the check guards a loadState handler", () =>
      Effect.gen(function* () {
        const accountId = "handler-checked"
        const key = { accountId }
        const handle = EventStore.commandHandler(decider, Ledger, {
          loadState: () => loadAccount(accountId),
        })
        const mark = transactions.length
        yield* handle(
          key,
          { _tag: "Deposit", amount: 10 },
          { additionalItems: withRecord(accountId) },
        )
        yield* handle(
          key,
          { _tag: "Deposit", amount: 10 },
          { additionalItems: withRecord(accountId) },
        )

        expect(transactions.slice(mark)).toEqual([
          ["ledger.event", "Account"],
          ["check", "ledger.event", "Account"],
        ])
      }).pipe(provide),
    )
  })

  describe('headProof: "snapshot"', () => {
    it.effect(
      "the handler proves the head by the snapshot, and falls back to the check when it lags",
      () =>
        Effect.gen(function* () {
          const accountId = "snapshot-1"
          const key = { accountId }
          const handle = EventStore.commandHandler(decider, Snapped, { headProof: "snapshot" })
          const mark = transactions.length

          yield* handle(key, { _tag: "Deposit", amount: 10 })
          yield* handle(key, { _tag: "Deposit", amount: 10 })
          expect(transactions.slice(mark)).toEqual([
            ["snapped.event", "snapped.snapshot"],
            ["snapped.event", "snapped.snapshot"],
          ])

          // A raw append without a snapshot: the snapshot lags at 2, the head is 3.
          yield* Snapped.append(key, [new Deposited({ amount: 1 })], 2)
          const lagging = transactions.length
          const result = yield* handle(key, { _tag: "Deposit", amount: 10 })
          expect(result).toMatchObject({ version: 4, state: { balance: 31 } })
          expect(transactions.slice(lagging)).toEqual([
            ["check", "snapped.event", "snapped.snapshot"],
          ])

          // The append repaired the snapshot, so the next one proves by it again.
          const repaired = transactions.length
          yield* handle(key, { _tag: "Withdraw", amount: 1 })
          expect(transactions.slice(repaired)).toEqual([["snapped.event", "snapped.snapshot"]])
          expect(yield* versions(Snapped, accountId)).toEqual([1, 2, 3, 4, 5])
        }).pipe(provide),
    )

    it.effect("an unverified load proves by the snapshot and re-decides on a lagging one", () =>
      Effect.gen(function* () {
        const accountId = "snapshot-unverified"
        const key = { accountId }
        const handle = EventStore.commandHandler(decider, Snapped, {
          headProof: "snapshot",
          verifySnapshot: false,
        })
        yield* handle(key, { _tag: "Deposit", amount: 10 })
        yield* Snapped.append(key, [new Deposited({ amount: 1 })], 1)

        const mark = transactions.length
        const result = yield* handle(key, { _tag: "Deposit", amount: 10 })
        expect(result).toMatchObject({ version: 3, state: { balance: 21 } })
        // The proof fails on the lagging snapshot; the verified re-decision checks.
        expect(transactions.slice(mark)).toEqual([
          ["snapped.event", "snapped.snapshot"],
          ["check", "snapped.event", "snapped.snapshot"],
        ])
        expect(yield* versions(Snapped, accountId)).toEqual([1, 2, 3])
      }).pipe(provide),
    )

    it.effect("a raw append whose snapshot is not at expectedVersion is a VersionConflict", () =>
      Effect.gen(function* () {
        const accountId = "snapshot-raw"
        const key = { accountId }
        yield* Snapped.append(key, [new Deposited({ amount: 10 })], 0, {
          snapshot: { balance: 10 },
          headProof: "snapshot",
        })

        // Ahead: the slot at 4 is free; the snapshot at 1 refuses it.
        const ahead = yield* Snapped.append(key, [new Deposited({ amount: 1 })], 3, {
          snapshot: { balance: 11 },
          headProof: "snapshot",
        }).pipe(Effect.flip)
        expect(ahead._tag).toBe("VersionConflict")

        // A new stream's proof: the snapshot must not exist yet.
        const fresh = yield* Snapped.append(key, [new Deposited({ amount: 1 })], 0, {
          snapshot: { balance: 1 },
          headProof: "snapshot",
        }).pipe(Effect.flip)
        expect(fresh._tag).toBe("VersionConflict")

        expect(yield* versions(Snapped, accountId)).toEqual([1])
        const snapshot = Option.getOrThrow(yield* Snapped.readSnapshot(key))
        expect(snapshot).toMatchObject({ asOfVersion: 1, state: { balance: 10 } })
      }).pipe(provide),
    )
  })
})
