/**
 * A read model on whose rows `__edd_rt__` is already taken (#237), against the published 1.40.0,
 * from `fixtures/row-token-names-1.40.0.json`, captured once from the published package against
 * DynamoDB Local (`helpers/RowTokenScenarios.ts`, compiled beside it). Never regenerate it from
 * this repo.
 *
 * Where a model field, a field renamed to it, a table or index key attribute (the read model's,
 * another member's, an event stream's local index), the `created` / `updated` timestamp or the
 * table's TTL attribute is named `__edd_rt__`, or the read model's outbox index is keyed by it (a
 * versioned read model is refused, `EDD-9081`, so the version can't be), the read model's rows carry no row token (`rowTokenInUse`, decided from the
 * definitions): with one projection and two, standalone and with an outbox, `escapeKeys` off and
 * on, this release sends, stores, reads back and delivers exactly what 1.40.0 did (but for one read
 * it no longer makes, whatever the token: `expectedOf`). With an outbox
 * whose items carry their mark (`__edd_rm__`, its name free), the requests differ from 1.40.0's
 * by the mark alone (`withoutMark`); with one whose items can't, not at all.
 */

import { readFileSync } from "node:fs"
import { describe, expect, it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Effect, Layer } from "effect"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
import { rowTokenInUse } from "../src/internal/TransactableOps.js"
import * as Table from "../src/Table.js"
import { makeRoutedTables } from "./helpers/RoutedTables.js"
import {
  layoutOf,
  type Mode,
  modesOf,
  type Ran,
  scenario,
  TOKEN_POSITIONS,
  type TokenPosition,
  ttlNameOf,
  withoutMark,
} from "./helpers/RowTokenScenarios.js"

const lib = { DynamoSchema, DynamoModel, Table, Entity, EventStore, DynamoClient }
const tables = { events: "events", read: "read", outbox: "outbox" } as const

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/row-token-names-1.40.0.json", import.meta.url), "utf8"),
) as { readonly version: string } & Record<string, Ran>

/** Tables in memory, each with its keys and indexes in `position`. */
const routedFor = (position: TokenPosition, mode: Mode) =>
  makeRoutedTables((name) => {
    const layout =
      layoutOf(position, mode)[name as keyof typeof tables] ?? layoutOf(position, mode).events
    return { keys: { pk: layout.pk, sk: layout.sk }, indexes: layout.indexes }
  }, "events")

describe("a read model whose row token's name is taken: 1.40.0's requests, rows and effects", () => {
  expect(fixture.version).toBe("1.40.0")
  for (const position of TOKEN_POSITIONS) {
    for (const mode of modesOf(position)) {
      for (const projections of [1, 2] as const) {
        for (const escapeKeys of [false, true]) {
          const at = `${position}/${mode}/${projections}/${escapeKeys ? "on" : "off"}`
          it.live(at, () => {
            const routed = routedFor(position, mode)
            const s = scenario(lib, tables, position, { mode, projections, escapeKeys })
            return Effect.gen(function* () {
              const ran = yield* s.run(Layer.succeed(DynamoClient, routed.client as any))
              // Decided from the definitions: no token.
              expect(rowTokenInUse(s.Tallies, ttlNameOf(position))).toBe(false)
              expect(compared(ran, mode)).toEqual(expectedOf(at, position, mode))
            })
          })
        }
      }
    }
  }

  it("with the name free, the rows may carry the token", () => {
    const s = scenario(lib, tables, "none", { projections: 2 })
    expect(rowTokenInUse(s.Tallies, ttlNameOf("none"))).toBe(true)
  })
})

/**
 * What 1.40.0 did, but for the one change this release makes there whatever the token: at `ttl`
 * (the only read model here whose rows may be tombstones, `removal`), a row read absent is written
 * by a `create` whose own condition proves the key still holds nothing, so it doesn't read the key
 * for a tombstone first (#237). 1.40.0 read it (the request after the row's first read, the same
 * `GetItem`), and, on finding a tombstone written since, replaced it. Standalone only: with an
 * outbox the row is written in a transaction, as on 1.40.0.
 */
const expectedOf = (at: string, position: TokenPosition, mode: Mode): Ran => {
  const given = fixture[at]!
  if (position !== "ttl" || mode !== "standalone") return given
  const [first, read, create, ...rest] = given.sent
  expect(read).toEqual(first)
  expect(read!.operation).toBe("getItem")
  expect(create!.operation).toBe("putItem")
  expect((create!.input as { ConditionExpression?: string }).ConditionExpression).toBe(
    "(attribute_not_exists(#e0)) AND (attribute_not_exists(#e1))",
  )
  return { ...given, sent: [first!, create!, ...rest] }
}

/** A run as the fixture holds it: with the mark taken out where this release writes one. */
const compared = (ran: Ran, mode: Mode): Ran => {
  if (mode !== "outbox") return ran
  // This release marks each outbox item: the only difference from 1.40.0's requests.
  const marked = JSON.stringify(ran.sent).includes("__edd_rm__")
  expect(marked).toBe(true)
  return withoutMark(ran)
}
