/**
 * Several projections with `removal` on one read model (#154): each records
 * the fields its tombstones keep and its revision, and `create` over a
 * tombstone carries the fields of the projection that wrote it — not those of
 * whichever projection was defined last. A row two projections feed keeps both
 * projections' fields when it becomes a tombstone and when a write replaces
 * one. A sparse checkpoint map's tombstone is refused as its row is. A read
 * model with one projection sends and stores exactly what the published 1.39.0
 * did.
 */

import { describe, expect, it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Effect, Layer } from "effect"
import { beforeEach } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
import { projectionTombstonesOf } from "../src/internal/TransactableOps.js"
import { fromAttributeMap } from "../src/Marshaller.js"
import * as Table from "../src/Table.js"
import * as Transaction from "../src/Transaction.js"
import { InMemoryClient, resetStore, store } from "./helpers/InMemoryTables.js"
import {
  EventsTable,
  evolve,
  type Ledger,
  Ledgers,
  Orders,
  ReadTable,
  scenarios,
} from "./helpers/ProjectionTombstoneLayouts.js"
import { expectAsFixture, scenario } from "./helpers/ProjectionTombstoneRequests.js"

const TestLayer = Layer.mergeAll(
  InMemoryClient,
  EventsTable.layer({ name: "events" }),
  ReadTable.layer({ name: "read" }),
)

beforeEach(() => resetStore())

const {
  firstAndLast,
  multiSource,
  transactional,
  ambiguous,
  sharedRow,
  sharedCreate,
  sharedTwice,
  sparse,
} = scenarios((id) =>
  Effect.sync(() =>
    [...store.entries()]
      .filter(([key]) => key.startsWith("read|") && key.includes(`#id_${id}|`))
      .map(([, item]) => fromAttributeMap(item) as Record<string, unknown>)
      .at(0),
  ),
)

describe("create over a tombstone, with several projections on the read model", () => {
  it.effect("carries the fields of the projection that wrote the tombstone", () =>
    firstAndLast.pipe(Effect.provide(TestLayer)),
  )

  it.effect("a multi-source projection's tombstone keeps its checkpoint map", () =>
    multiSource.pipe(Effect.provide(TestLayer)),
  )

  it.effect("a transactional create carries them too", () =>
    transactional.pipe(Effect.provide(TestLayer)),
  )

  it.effect(
    "raises an attribute two layouts name in different roles only as the last one's revision",
    () => ambiguous.pipe(Effect.provide(TestLayer)),
  )

  it("keeps one entry per layout, the one defined last at the end, however often one is defined", () => {
    for (let i = 0; i < 3; i++) {
      EventStore.projection({
        stream: Orders,
        readModel: Ledgers,
        key: (id: { readonly orderId: string }) => ({ id: id.orderId }),
        initial: (id: { readonly orderId: string }): Ledger => ({ id: id.orderId, total: 0 }),
        evolve,
        checkpoint: "orderVersion",
        revision: "orderRev",
        removal: { ttl: "1 day" },
      })
    }
    expect(projectionTombstonesOf(Ledgers)).toEqual([
      { kept: ["checkpoints"], revision: "revision" },
      { kept: ["invoiceVersion"], revision: "revision" },
      { kept: ["orderVersion"], revision: "orderRev" },
    ])
  })
})

describe("a row two projections feed", () => {
  it.effect(
    "keeps both projections' checkpoints when one removes it, and when the other writes over it",
    () => sharedRow.pipe(Effect.provide(TestLayer)),
  )

  it.effect("create over its tombstone carries both, with both revisions one higher", () =>
    sharedCreate.pipe(Effect.provide(TestLayer)),
  )

  it.effect("a tombstone written over another keeps the first projection's fields", () =>
    sharedTwice.pipe(Effect.provide(TestLayer)),
  )
})

describe("a checkpoint map stored as a sparse map", () => {
  it.effect("refuses the tombstone as it refuses the row, before writing anything", () => {
    const writes: Array<string> = []
    const recording = Layer.effect(
      DynamoClient,
      Effect.gen(function* () {
        const client = yield* DynamoClient
        return new Proxy(client, {
          get: (target, prop) => {
            const value = Reflect.get(target, prop)
            if (typeof value !== "function" || prop === "getItem" || prop === "query") return value
            return (input: { readonly TableName?: string; readonly TransactItems?: unknown }) => {
              const named = JSON.stringify(input)
              if (named.includes('"TableName":"read"')) writes.push(String(prop))
              return value.call(target, input)
            }
          },
        })
      }),
    ).pipe(Layer.provide(InMemoryClient))
    return Effect.gen(function* () {
      const { row, tombstone } = yield* sparse
      expect(row).toMatchObject({
        _tag: "ValidationError",
        entityType: "SparseLedger",
        cause: `Sparse map "checkpoints": key "shipment#<id>" must not contain '#' — the library does not silently escape`,
      })
      expect(row.operation).toMatch(/\.write$/)
      expect(tombstone).toEqual(row)
      expect(writes).toEqual([])
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          recording,
          EventsTable.layer({ name: "events" }),
          ReadTable.layer({ name: "read" }),
        ),
      ),
    )
  })
})

describe("a read model with one projection", () => {
  it.effect("sends and stores what 1.39.0 did, around its tombstones", () => {
    const { run } = scenario(
      { DynamoSchema, Table, Entity, EventStore, Transaction, DynamoClient },
      { events: "events", read: "read" },
    )
    return Effect.gen(function* () {
      const sent = yield* run(InMemoryClient)
      expectAsFixture(
        sent,
        [...store.entries()].filter(([key]) => key.startsWith("read|")).map(([, item]) => item),
      )
    })
  })
})
