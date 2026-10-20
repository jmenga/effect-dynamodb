/**
 * Type-level tests for sealing and nested stream appends (#166).
 *
 * - `seal` is a `boolean | undefined` option of `append` and `measureAppend`.
 * - `appendOp` (unbound and bound) returns a `StreamAppendOp`; its options
 *   exclude `additionalItems`, `idempotency` and `headProof`.
 * - `append`'s and `commandHandler`'s `additionalItems` accept an
 *   `AppendWriteOp` — an `appendOp` mixed with Entity ops — and a
 *   `ReadonlyArray<TransactWriteOp>`-typed value is still accepted by both
 *   (the widening breaks no caller that passes values in).
 * - `Transaction.transactWrite` refuses a `StreamAppendOp`.
 * - `StreamSealed` is in `AppendError` and in every handler's error channel.
 * - `StreamEvent.sealed`, `LatestState.seal`, `LoadedState.sealedVersion`.
 *
 * Uses vitest's `expectTypeOf`; the assertions are compile-time only and are
 * checked by `tsc -p tsconfig.test.json` (`pnpm check`).
 */

import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import type { StreamSealed, VersionConflict } from "@effect-dynamodb/schema/Errors.js"
import { Effect, Option, Schema } from "effect"
import { describe, expect, expectTypeOf, it } from "vitest"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
import * as Expression from "../src/Expression.js"
import * as Table from "../src/Table.js"
import * as Transaction from "../src/Transaction.js"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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

const AppTable = Table.make({
  schema: DynamoSchema.make({ name: "sealtypes", version: 1 }),
  entities: { Chains },
})

class Deposited extends Schema.TaggedClass<Deposited>()("Deposited", {
  amount: Schema.Number,
}) {}
class Closed extends Schema.TaggedClass<Closed>()("Closed", {
  continuedIn: Schema.String,
}) {}
type LedgerEvent = Deposited | Closed

const LedgerState = Schema.Struct({ balance: Schema.Number })
interface LedgerState {
  readonly balance: number
}

const Ledgers = EventStore.makeStream({
  table: AppTable,
  streamName: "Ledger",
  events: [Deposited, Closed],
  streamId: { composite: ["accountId", "generation"] },
  snapshot: { schema: LedgerState, mode: "inline" },
})

const decider: EventStore.Decider<LedgerState, { readonly amount: number }, LedgerEvent> = {
  initialState: { balance: 0 },
  decide: (command) => Effect.succeed([new Deposited({ amount: command.amount })]),
  evolve: (state, event) =>
    event._tag === "Deposited" ? { balance: state.balance + event.amount } : state,
}

const genA = { accountId: "a-1", generation: "1" }
const genB = { accountId: "a-1", generation: "2" }
const chainPut = Chains.put({ accountId: "a-1", current: "2", revision: 2 }).pipe(
  Chains.condition({ revision: 1 }),
)

// The assertions live in functions that are type-checked but never executed —
// they would need DynamoDB to run.
const typeOnly = (_: () => void) => undefined

describe("EventStore seal types (#166)", () => {
  it("seal is boolean | undefined on append and measureAppend options", () => {
    expectTypeOf<EventStore.AppendOptions<undefined, LedgerState>["seal"]>().toEqualTypeOf<
      boolean | undefined
    >()
    expectTypeOf<EventStore.MeasureAppendOptions<undefined, LedgerState>["seal"]>().toEqualTypeOf<
      boolean | undefined
    >()
    typeOnly(() => {
      Ledgers.append(genA, [new Closed({ continuedIn: "2" })], 3, {
        seal: true,
        snapshot: { balance: 1 },
      })
      Ledgers.measureAppend(genA, [new Closed({ continuedIn: "2" })], 3, { seal: true })
      // @ts-expect-error — seal is a boolean
      Ledgers.append(genA, [new Closed({ continuedIn: "2" })], 3, { seal: "yes" })
    })
    expect(true).toBe(true)
  })

  it("appendOp returns a StreamAppendOp; its options exclude the outer-only ones", () => {
    type Nested = EventStore.NestedAppendOptions<undefined, LedgerState>
    expectTypeOf<"additionalItems" extends keyof Nested ? true : false>().toEqualTypeOf<false>()
    expectTypeOf<"idempotency" extends keyof Nested ? true : false>().toEqualTypeOf<false>()
    expectTypeOf<"headProof" extends keyof Nested ? true : false>().toEqualTypeOf<false>()
    expectTypeOf<Nested["seal"]>().toEqualTypeOf<boolean | undefined>()
    expectTypeOf<Nested["snapshot"]>().toEqualTypeOf<LedgerState | undefined>()

    typeOnly(() => {
      const op = Ledgers.appendOp(genA, [new Closed({ continuedIn: "2" })], 3, {
        seal: true,
        snapshot: { balance: 1 },
      })
      expectTypeOf(op).toEqualTypeOf<EventStore.StreamAppendOp>()
      expectTypeOf(op.streamName).toEqualTypeOf<string>()
      // @ts-expect-error — a nested append carries no idempotency
      Ledgers.appendOp(genA, [new Deposited({ amount: 1 })], 3, { idempotency: { commandId: "c" } })
      // @ts-expect-error — nor a head proof
      Ledgers.appendOp(genA, [new Deposited({ amount: 1 })], 3, { headProof: "snapshot" })
      // @ts-expect-error — nor additional items
      Ledgers.appendOp(genA, [new Deposited({ amount: 1 })], 3, { additionalItems: [chainPut] })
      // @ts-expect-error — the events are the stream's
      Ledgers.appendOp(genA, [new Chain({ accountId: "a", current: "b", revision: 1 })], 3)

      Effect.gen(function* () {
        const bound = yield* EventStore.bind(Ledgers)
        const boundOp = bound.appendOp(genA, [new Closed({ continuedIn: "2" })], 3, {
          seal: true,
          snapshot: { balance: 1 },
        })
        expectTypeOf(boundOp).toEqualTypeOf<EventStore.StreamAppendOp>()
        // @ts-expect-error — the bound op refuses the same options
        bound.appendOp(genA, [new Deposited({ amount: 1 })], 3, { headProof: "snapshot" })
      })
    })
    expect(true).toBe(true)
  })

  it("append and commandHandler accept an appendOp mixed with Entity ops", () => {
    typeOnly(() => {
      const sealA = Ledgers.appendOp(genA, [new Closed({ continuedIn: "2" })], 3, {
        seal: true,
        snapshot: { balance: 1 },
      })
      const appended = Ledgers.append(genB, [new Deposited({ amount: 1 })], 0, {
        snapshot: { balance: 1 },
        additionalItems: [
          sealA,
          chainPut,
          Transaction.check(
            Chains.get({ accountId: "a-1" }),
            Expression.condition({ eq: { revision: 1 } }),
          ),
        ],
      })
      expectTypeOf<Effect.Error<typeof appended>>().toEqualTypeOf<EventStore.AppendError>()

      const handle = EventStore.commandHandler(decider, Ledgers)
      handle(genB, { amount: 1 }, { additionalItems: [sealA, chainPut] })
      handle(
        genB,
        { amount: 1 },
        {
          additionalItems: (decision) => [
            Ledgers.appendOp(genA, [new Closed({ continuedIn: "2" })], decision.version, {
              seal: true,
              snapshot: decision.state,
            }),
            chainPut,
          ],
        },
      )
      handle(
        genB,
        { amount: 1 },
        {
          additionalItems: () => Effect.succeed([sealA, chainPut]),
        },
      )
    })
    expect(true).toBe(true)
  })

  it("a ReadonlyArray<TransactWriteOp> is still accepted by append and commandHandler", () => {
    typeOnly(() => {
      const items: ReadonlyArray<Transaction.TransactWriteOp> = [chainPut]
      Ledgers.append(genB, [new Deposited({ amount: 1 })], 0, {
        snapshot: { balance: 1 },
        additionalItems: items,
      })
      const handle = EventStore.commandHandler(decider, Ledgers)
      handle(genB, { amount: 1 }, { additionalItems: items })
      handle(genB, { amount: 1 }, { additionalItems: () => items })
      // ...and remains a valid transactWrite input.
      Transaction.transactWrite(items)
    })
    expect(true).toBe(true)
  })

  it("Transaction.transactWrite refuses a StreamAppendOp", () => {
    typeOnly(() => {
      const op = Ledgers.appendOp(genA, [new Deposited({ amount: 1 })], 3)
      // @ts-expect-error — a stream append op rides only in an append
      Transaction.transactWrite([op])
      // @ts-expect-error — nor mixed with Entity ops
      Transaction.transactWrite([chainPut, op])
      const widened: ReadonlyArray<EventStore.AppendWriteOp> = [chainPut]
      // @ts-expect-error — the widened element type is not a TransactWriteOp
      Transaction.transactWrite(widened)
    })
    expect(true).toBe(true)
  })

  it("StreamSealed is in AppendError and the handler's error channel", () => {
    expectTypeOf<StreamSealed>().toExtend<EventStore.AppendError>()
    typeOnly(() => {
      const handled = EventStore.commandHandler(decider, Ledgers)(genB, { amount: 1 })
      expectTypeOf<StreamSealed>().toExtend<Effect.Error<typeof handled>>()
      expectTypeOf<VersionConflict>().toExtend<Effect.Error<typeof handled>>()
      Effect.gen(function* () {
        const bound = yield* EventStore.bind(Ledgers)
        const boundHandled = EventStore.commandHandler(decider, bound)(genB, { amount: 1 })
        expectTypeOf<StreamSealed>().toExtend<Effect.Error<typeof boundHandled>>()
      })
    })
    expect(true).toBe(true)
  })

  it("the read surface: StreamEvent.sealed, LatestState.seal, LoadedState.sealedVersion", () => {
    expectTypeOf<EventStore.StreamEvent<LedgerEvent>["sealed"]>().toEqualTypeOf<true | undefined>()
    expectTypeOf<EventStore.LatestState<LedgerState, LedgerEvent>["seal"]>().toEqualTypeOf<
      EventStore.StreamEvent<LedgerEvent> | undefined
    >()
    expectTypeOf<EventStore.LoadedState<LedgerState>["sealedVersion"]>().toEqualTypeOf<
      number | undefined
    >()
    typeOnly(() => {
      Effect.gen(function* () {
        const latest = yield* Ledgers.readLatest(genA)
        if (latest.seal !== undefined) {
          expectTypeOf(latest.seal.data).toEqualTypeOf<LedgerEvent>()
        }
      })
      EventStore.commandHandler(decider, Ledgers, {
        loadState: () =>
          Effect.succeed(Option.some({ state: { balance: 1 }, version: 4, sealedVersion: 5 })),
      })
    })
    expect(true).toBe(true)
  })
})
