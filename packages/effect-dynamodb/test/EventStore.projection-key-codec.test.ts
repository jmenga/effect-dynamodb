/**
 * A projection whose read model's key composite is a codec `encode` takes on
 * its own output, from the rows published 1.39.0 wrote (`KeyCodecProjection`).
 * The engine reads the row, and writes its tombstone, at the key the read
 * model's `put` wrote; outbox items keep the key text 1.39.0 gave them.
 */

import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit, Layer } from "effect"
import { beforeEach } from "vitest"
import { fromAttributeMap } from "../src/Marshaller.js"
import { InMemoryClient, keyOf, resetStore, store } from "./helpers/InMemoryTables.js"
import * as P from "./helpers/KeyCodecProjection.js"

const TestLayer = Layer.mergeAll(
  InMemoryClient,
  P.EventsTable.layer({ name: "events" }),
  P.ReadTable.layer({ name: "read" }),
)

beforeEach(() => {
  resetStore()
  for (const row of P.fixture.seed.events) store.set(keyOf("events", row), row)
  for (const row of P.fixture.seed.read) store.set(keyOf("read", row), row)
})

const at = (key: { readonly pk: string; readonly sk: string }) => {
  const item = store.get(`read|${key.pk}|${key.sk}`)
  return item === undefined ? undefined : (fromAttributeMap(item) as Record<string, unknown>)
}
const outboxItems = () =>
  [...store.entries()]
    .filter(([k, item]) => k.startsWith("read|") && item.__edd_e__?.S === "Effected#outbox")
    .map(([, item]) => fromAttributeMap(item) as Record<string, unknown>)

describe("a projection keyed by a codec encode takes on its own output, over 1.39.0's rows", () => {
  it("1.39.0 failed every event after the first, and tombstoned a key the row was not at", () => {
    expect(P.fixture.writtenBy).toBe("1.39.0")
    const [first, second, third] = P.fixture.steps
    expect(first!.rows.map((r) => r.pk)).toEqual([P.rowKey.Effected.pk, P.rowKey.Removable.pk])
    expect(first!.outbox.map((o) => [o.pk, o.rowPk])).toEqual([[P.outboxPk, P.outboxPk]])
    expect(second!.A).toEqual({ failed: "ConcurrentModification" })
    expect(second!.B).toEqual({ failed: "ConcurrentModification" })
    expect(third!.rows.map((r) => [r.pk, r.e])).toEqual([
      [P.rowKey.Effected.pk, "Effected"],
      [P.singleKey.pk, "Removable#tombstone"],
      [P.rowKey.Removable.pk, "Removable"],
    ])
    expect(P.fixture.gets.A).toEqual({ ok: { orderId: "o1", total: 5, version: 1 } })
  })

  it.effect("the next event updates the row 1.39.0 wrote", () =>
    Effect.gen(function* () {
      yield* P.Orders.append({ orderId: "o1" }, [new P.Added({ amount: 3 })], 1)
      const a = yield* P.A.catchUp({ orderId: "o1" })
      const b = yield* P.B.catchUp({ orderId: "o1" })
      expect(a.applied.map((e) => e.version)).toEqual([2])
      expect(b.applied.map((e) => e.version)).toEqual([2])
      expect(at(P.rowKey.Removable)).toMatchObject({ orderId: "x:o1", total: 8, version: 2 })
      expect(at(P.rowKey.Effected)).toMatchObject({ orderId: "x:o1", total: 8, version: 2, rev: 2 })
      expect(at(P.singleKey)).toBeUndefined()
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("a removal tombstones the row put wrote, and the entity reads no row", () =>
    Effect.gen(function* () {
      yield* P.Orders.append({ orderId: "o1" }, [new P.Added({ amount: 3 }), new P.Cancelled()], 1)
      const a = yield* P.A.catchUp({ orderId: "o1" })
      expect(a.removed).toBe(true)
      expect(at(P.rowKey.Removable)).toMatchObject({ __edd_e__: "Removable#tombstone", version: 3 })
      expect(at(P.singleKey)).toBeUndefined()
      const got = yield* Effect.exit(P.Removable.get({ orderId: "o1" }).asEffect())
      expect(Exit.isFailure(got) && JSON.stringify(got.cause)).toContain("ItemNotFound")
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("outbox items keep the key text 1.39.0 gave them, and drain delivers them", () =>
    Effect.gen(function* () {
      yield* P.Orders.append({ orderId: "o1" }, [new P.Added({ amount: 3 })], 1)
      yield* P.B.catchUp({ orderId: "o1" })
      expect(
        outboxItems().map((o) => [o.pk, o.sk, o.__edd_row_pk__, o.__edd_row_sk__, o.__edd_kt__]),
      ).toEqual([
        [
          P.outboxPk,
          "$kp#v1#effected#outbox#000000000002#0000",
          P.outboxPk,
          P.rowKey.Effected.sk,
          undefined,
        ],
      ])
      const notes: Array<string> = []
      const drained = yield* P.B.drain({ orderId: "o1" }, (effect) =>
        Effect.sync(() => {
          notes.push(effect.note)
        }),
      )
      expect(drained.delivered).toBe(1)
      expect(notes).toEqual(["Added v2"])
      expect(outboxItems()).toEqual([])
    }).pipe(Effect.provide(TestLayer)),
  )
})
