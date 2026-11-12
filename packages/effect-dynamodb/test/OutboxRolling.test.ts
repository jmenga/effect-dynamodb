/**
 * Outbox items against the published 1.40.0 (#237), from fixtures captured once from the published
 * package against DynamoDB Local (`helpers/OutboxScenarios.ts`, compiled beside it). Never
 * regenerate their 1.40.0 parts from this repo.
 *
 * - Where `__edd_rm__` is a key attribute where a read model's outbox items are written, its items
 *   carry no mark (`outboxMarkInUse`): this release sends, stores and delivers exactly what 1.40.0
 *   did (`fixtures/outbox-mark-names-1.40.0.json`), with one projection and two, `escapeKeys` off
 *   and on.
 * - Rolling deployment: 1.40.0's `drainPending` and `drain` were given the items this release
 *   writes (marks, items written beside another's at its key followed by their mark) and
 *   delivered every one, in order, leaving none, with the requests this release's drainer sends
 *   (`fixtures/outbox-rolling-1.40.0.json`).
 */

import { readFileSync } from "node:fs"
import { describe, expect, it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Effect, Layer } from "effect"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
import { outboxMarkInUse } from "../src/internal/TransactableOps.js"
import * as Table from "../src/Table.js"
import {
  layoutOf,
  names,
  POSITIONS,
  type Position,
  type Ran,
  type Rolling,
  rolling,
  type Sent,
} from "./helpers/OutboxScenarios.js"
import { makeRoutedTables } from "./helpers/RoutedTables.js"

const lib = { DynamoSchema, Table, Entity, EventStore, DynamoClient }
const tables = { events: "events", read: "read", outbox: "outbox" } as const

type Stored = Record<string, Record<string, unknown>>
const read = <A>(name: string): A =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as A
const namesFixture = read<
  { readonly version: string } & Record<
    string,
    Ran & { readonly items: Readonly<Record<string, ReadonlyArray<Stored>>> }
  >
>("outbox-mark-names-1.40.0.json")
const rollingFixture = read<{
  readonly version: string
  readonly scenarios: Record<
    Rolling,
    {
      readonly items: ReadonlyArray<Stored>
      readonly drainPending: Ran & { readonly left: ReadonlyArray<Stored> }
      readonly drain: Ran & { readonly left: ReadonlyArray<Stored> }
    }
  >
}>("outbox-rolling-1.40.0.json")

/** Tables in memory, each with its keys and indexes in `position`. */
const routedFor = (position: Position) =>
  makeRoutedTables((name) => {
    const layout = layoutOf(position)[name as keyof typeof tables] ?? layoutOf(position).events
    return { keys: { pk: layout.pk, sk: layout.sk }, indexes: layout.indexes }
  }, "events")
type Routed = ReturnType<typeof routedFor>

/** As the fixtures hold them: JSON, each item's attributes and the items sorted. */
const sorted = (items: Iterable<Stored>) =>
  [...items]
    .map((item) => Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : 1))))
    .sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1))
const asJson = <A>(value: A): A => JSON.parse(JSON.stringify(value)) as A
/** A run's requests, its result and what it delivered, as JSON. */
const ranOf = (ran: Ran) => asJson({ sent: ran.sent, delivered: ran.delivered, result: ran.result })

describe("a read model whose mark's name is a key attribute: 1.40.0's requests", () => {
  expect(namesFixture.version).toBe("1.40.0")
  for (const position of POSITIONS) {
    for (const projections of [1, 2] as const) {
      for (const escapeKeys of [false, true]) {
        const at = `${position}/${projections}/${escapeKeys ? "on" : "off"}`
        it.effect(at, () => {
          const routed = routedFor(position)
          const scenario = names(lib, tables, position, { projections, escapeKeys })
          return Effect.gen(function* () {
            const ran = yield* scenario.run(Layer.succeed(DynamoClient, routed.client as any))
            // Decided from the definitions: no mark.
            expect(outboxMarkInUse(scenario.Ledgers)).toBe(false)
            const fixture = namesFixture[at]!
            expect(ranOf(ran)).toEqual(
              asJson({ sent: fixture.sent, delivered: fixture.delivered, result: fixture.result }),
            )
            // What's stored: the row, and no outbox item left.
            for (const name of Object.keys(tables) as ReadonlyArray<keyof typeof tables>) {
              const ledger = [...routed.table(name).items.values()].filter((item) =>
                String(item.__edd_e__?.S).startsWith("Ledger"),
              )
              expect(sorted(ledger as Iterable<Stored>)).toEqual(fixture.items[name])
            }
          })
        })
      }
    }
  }

  it("with the name free, the items carry their mark", () => {
    expect(outboxMarkInUse(names(lib, tables, "none").Ledgers)).toBe(true)
  })
})

describe("1.40.0's drainers on the outbox items this release writes", () => {
  expect(rollingFixture.version).toBe("1.40.0")
  const write = (scenario: Rolling, routed: Routed) =>
    rolling(lib, tables, scenario).write(Layer.succeed(DynamoClient, routed.client as any))
  const outboxItems = (routed: Routed) =>
    sorted([...routed.table("outbox").items.values()] as Iterable<Stored>)

  for (const scenario of ["single", "twoProjections", "rowLost"] as const) {
    const fixture = rollingFixture.scenarios[scenario]
    it.effect(`${scenario}: the items this release writes are the ones 1.40.0 was given`, () => {
      const routed = routedFor("none")
      return Effect.gen(function* () {
        yield* write(scenario, routed)
        expect(outboxItems(routed)).toEqual(fixture.items)
      })
    })

    for (const how of ["drainPending", "drain"] as const) {
      it.effect(`${scenario}: 1.40.0's ${how} delivers each, in order, as this release's`, () => {
        const routed = routedFor("none")
        return Effect.gen(function* () {
          const given = fixture[how]
          // Every item delivered, none left, nothing undelivered.
          expect(given.left).toEqual([])
          expect(given.delivered).toHaveLength(fixture.items.length)
          expect((given.result as { readonly delivered: number }).delivered).toBe(
            fixture.items.length,
          )
          // In the items' key order.
          const order = [...fixture.items]
            .sort((a, b) => (String(a.osk!.S) < String(b.osk!.S) ? -1 : 1))
            .map((item) => [item.streamId!.S, Number(item.version!.N)])
          expect(
            given.delivered.map((d: any) => [d.meta.streamId, d.meta.version] as const),
          ).toEqual(order)
          // This release's drainer, on what it wrote: the same requests and the same effects.
          yield* write(scenario, routed)
          routed.take()
          const own = yield* rolling(lib, tables, scenario)[how](
            Layer.succeed(DynamoClient, routed.client as any),
          )
          expect(asJson(own.sent as ReadonlyArray<Sent>)).toEqual(asJson(given.sent))
          expect(asJson(own.delivered)).toEqual(asJson(given.delivered))
          expect(outboxItems(routed)).toEqual([])
        })
      })
    }
  }
})
