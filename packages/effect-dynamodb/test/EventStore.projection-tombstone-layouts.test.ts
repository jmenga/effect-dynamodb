/**
 * Several projections with `removal` on one read model (#154): each records
 * the fields its tombstones keep and its revision, and `create` over a
 * tombstone carries the fields of the projection that wrote it — not those of
 * whichever projection was defined last. A read model with one projection
 * sends and stores exactly what the published 1.39.0 did.
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

const { firstAndLast, multiSource, transactional, ambiguous } = scenarios((id) =>
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

  it.effect("a tombstone two layouts name alike is read by the one defined last", () =>
    ambiguous.pipe(Effect.provide(TestLayer)),
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
