/**
 * Two read models of one entity type in one schema whose projections' outboxes share a table
 * (`helpers/OutboxPairRequests.ts`): keys that meet only through a value holding `#`, and keys
 * that part where a number's key text can't spell the other's label. 1.39.0 bound them and applied
 * their events, each to its own keys: a client still binds them, and every request and stored item
 * is what the published 1.39.0 sent and stored.
 */

import { readFileSync } from "node:fs"
import { describe, expect, it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Effect } from "effect"
import { beforeEach } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
import * as Table from "../src/Table.js"
import { InMemoryClient, resetStore, store } from "./helpers/InMemoryTables.js"
import { type Sent, scenario } from "./helpers/OutboxPairRequests.js"

type Captured = {
  readonly requests: ReadonlyArray<Sent>
  readonly items: Record<string, ReadonlyArray<Record<string, unknown>>>
}

const read = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"))

const fixture = read("outbox-pair-1.39.0.json") as Captured
const typed = read("outbox-typed-pair-1.39.0.json") as Record<"off" | "on", Captured>

/** A table's items, in key order, their attributes by name (a table keeps no order). */
const itemsOf = (table: string) =>
  [...store.entries()]
    .filter(([key]) => key.startsWith(`${table}|`))
    .map(([, item]) =>
      Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : 1))),
    )
    .sort((a, b) => (`${a.pk?.S}\u0000${a.sk?.S}` < `${b.pk?.S}\u0000${b.sk?.S}` ? -1 : 1))

beforeEach(resetStore)

const tables = { events: "events", readA: "readA", readB: "readB", outbox: "outbox" }
const lib = { DynamoSchema, Table, Entity, EventStore, DynamoClient }

/** `sent` and the tables' items are what 1.39.0 sent and stored (`captured`). */
const expectCaptured = (sent: ReadonlyArray<Sent>, captured: Captured) => {
  expect(sent.map((request) => JSON.stringify(request))).toEqual(
    captured.requests.map((request) => JSON.stringify(request)),
  )
  for (const table of ["readA", "readB", "outbox"] as const) {
    expect(JSON.parse(JSON.stringify(itemsOf(table)))).toEqual(captured.items[table])
  }
}

describe("read models whose outbox keys meet only through a value holding `#`", () => {
  it.effect("bind, and send and store what 1.39.0 did", () =>
    Effect.gen(function* () {
      const { run } = scenario(lib, tables)
      expectCaptured(yield* run(InMemoryClient), fixture)
    }),
  )
})

describe("read models whose outbox keys part where a number's text can't spell a label", () => {
  // `n_0000000000000007` and `n_x_q`: a number's key text holds no `x`, so no key of one is a key
  // of the other, for any values.
  it.effect.each(["off", "on"] as const)(
    "bind, and send and store what 1.39.0 did, escapeKeys %s",
    (setting) =>
      Effect.gen(function* () {
        const { run } = scenario(lib, tables, "typed", setting === "on")
        expectCaptured(yield* run(InMemoryClient), typed[setting])
      }),
  )
})
