/**
 * Two read models of one entity type in one schema whose projections' outboxes share a table, their
 * keys meeting only through a value that holds `#` (`helpers/OutboxPairRequests.ts`). 1.39.0 bound
 * them and applied their events, each to its own keys: a client still binds them, and every request
 * and stored item is what the published 1.39.0 sent and stored.
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

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/outbox-pair-1.39.0.json", import.meta.url), "utf8"),
) as {
  readonly requests: ReadonlyArray<Sent>
  readonly items: Record<string, ReadonlyArray<Record<string, unknown>>>
}

/** A table's items, in key order, their attributes by name (a table keeps no order). */
const itemsOf = (table: string) =>
  [...store.entries()]
    .filter(([key]) => key.startsWith(`${table}|`))
    .map(([, item]) =>
      Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : 1))),
    )
    .sort((a, b) => (`${a.pk?.S}\u0000${a.sk?.S}` < `${b.pk?.S}\u0000${b.sk?.S}` ? -1 : 1))

beforeEach(resetStore)

describe("read models whose outbox keys meet only through a value holding `#`", () => {
  it.effect("bind, and send and store what 1.39.0 did", () => {
    const tables = { events: "events", readA: "readA", readB: "readB", outbox: "outbox" }
    const { run } = scenario({ DynamoSchema, Table, Entity, EventStore, DynamoClient }, tables)
    return Effect.gen(function* () {
      const sent = yield* run(InMemoryClient)
      expect(sent.map((request) => JSON.stringify(request))).toEqual(
        fixture.requests.map((request) => JSON.stringify(request)),
      )
      for (const table of ["readA", "readB", "outbox"] as const) {
        expect(JSON.parse(JSON.stringify(itemsOf(table)))).toEqual(fixture.items[table])
      }
    })
  })
})
