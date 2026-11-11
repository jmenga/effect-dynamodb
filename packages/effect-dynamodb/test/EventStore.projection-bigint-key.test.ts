/**
 * A projection whose row key holds a bigint (a `Schema.BigInt` composite): `applyBatch` and
 * `rebuild` group events by the row's key (`keyId`), which took the key as JSON and so died on a
 * bigint (`TypeError: Do not know how to serialize a BigInt`, on 1.40.0 too). A bigint is told
 * apart from a number and a string of its digits; any other key's identity is unchanged.
 */

import { describe, expect, it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Effect, Layer, Schema } from "effect"
import { beforeEach } from "vitest"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
import { keyId } from "../src/internal/ProjectionEngine.js"
import * as Table from "../src/Table.js"
import { InMemoryClient, resetStore } from "./helpers/InMemoryTables.js"

class Added extends Schema.TaggedClass<Added>()("Added", { amount: Schema.Number }) {}

const AppSchema = DynamoSchema.make({ name: "big", version: 1 })
const EventsTable = Table.make({ schema: AppSchema, entities: {} })
const Accounts = EventStore.makeStream({
  table: EventsTable,
  streamName: "Account",
  events: [Added],
  streamId: { composite: ["account"] },
})
const Tally = Schema.Struct({
  n: Schema.BigInt,
  total: Schema.Number,
  version: Schema.optional(Schema.Number),
  map: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
  rev: Schema.optional(Schema.Number),
})
type Tally = typeof Tally.Type
const Tallies = Entity.make({
  model: Tally,
  entityType: "Tally",
  primaryKey: { pk: { field: "pk", composite: ["n"] }, sk: { field: "sk", composite: [] } },
})
const Sums = Entity.make({
  model: Tally,
  entityType: "Sum",
  primaryKey: { pk: { field: "pk", composite: ["n"] }, sk: { field: "sk", composite: [] } },
})
const ReadTable = Table.make({ schema: AppSchema, entities: { Tallies, Sums } })

/** Account `a<n>` folds into the row keyed `n`. */
const rowOf = (account: string) => ({ n: BigInt(account.slice(1)) })
const evolve = (state: Tally, event: { readonly data: Added }) =>
  Effect.succeed({ ...state, total: state.total + event.data.amount })

const Single = EventStore.projection({
  stream: Accounts,
  readModel: Tallies,
  key: (id: { readonly account: string }) => rowOf(id.account),
  initial: (id: { readonly account: string }): Tally => ({ ...rowOf(id.account), total: 0 }),
  evolve,
  checkpoint: "version",
})
const Multi = EventStore.multiProjection({
  readModel: Sums,
  initial: (key: { readonly n: bigint }): Tally => ({ n: key.n, total: 0 }),
  sources: (source) => ({
    account: source(Accounts, {
      key: (id: { readonly account: string }) => rowOf(id.account),
      evolve,
    }),
  }),
  checkpoints: { field: "map" },
  revision: "rev",
})

const layer = Layer.mergeAll(
  InMemoryClient,
  EventsTable.layer({ name: "events" }),
  ReadTable.layer({ name: "read" }),
)

beforeEach(() => resetStore())

describe("a projection keyed by a bigint", () => {
  it("keyId tells a bigint from a number and a string of its digits, other keys as before", () => {
    expect(keyId({ n: 7n })).not.toBe(keyId({ n: 7 }))
    expect(keyId({ n: 7n })).not.toBe(keyId({ n: "7" }))
    expect(keyId({ n: 7n })).toBe(keyId({ n: 7n }))
    expect(keyId({ n: -(10n ** 20n) })).not.toBe(keyId({ n: 10n ** 20n }))
    expect(keyId({ b: "x", a: 7 })).toBe(
      JSON.stringify([
        ["a", 7],
        ["b", "x"],
      ]),
    )
  })

  it.effect("applyBatch and rebuild fold each row's events", () =>
    Effect.gen(function* () {
      yield* Accounts.append(
        { account: "a7" },
        [new Added({ amount: 2 }), new Added({ amount: 3 })],
        0,
      )
      yield* Accounts.append({ account: "a-7" }, [new Added({ amount: 5 })], 0)
      const events = [
        ...(yield* Accounts.read({ account: "a7" })),
        ...(yield* Accounts.read({ account: "a-7" })),
      ]
      const result = yield* Single.applyBatch(events)
      expect(result.failedPositions).toEqual([])
      expect(result.outcomes).toHaveLength(2)
      expect((yield* Tallies.get({ n: 7n }).asEffect()).total).toBe(5)
      expect((yield* Tallies.get({ n: -7n }).asEffect()).total).toBe(5)
      yield* Single.rebuild({ account: "a7" })
      expect((yield* Tallies.get({ n: 7n }).asEffect()).total).toBe(5)
    }).pipe(Effect.provide(layer)),
  )

  it.effect("a multi-source projection's applyBatch folds each row's events", () =>
    Effect.gen(function* () {
      yield* Accounts.append(
        { account: "a7" },
        [new Added({ amount: 2 }), new Added({ amount: 3 })],
        0,
      )
      const events = yield* Accounts.read({ account: "a7" })
      const result = yield* Multi.applyBatch(events.map((event) => ({ stream: "account", event })))
      expect(result.failedPositions).toEqual([])
      expect((yield* Sums.get({ n: 7n }).asEffect()).total).toBe(5)
    }).pipe(Effect.provide(layer)),
  )
})
