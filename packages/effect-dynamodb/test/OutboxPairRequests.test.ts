/**
 * Two read models of one entity type in one schema whose projections' outboxes share a table
 * (`helpers/OutboxPairRequests.ts`): keys that meet only through a value holding `#`, and keys
 * that part where a number's key text can't spell the other's label. 1.39.0 bound them and applied
 * their events, each to its own keys: a client still binds them, and every request and stored item
 * is what the published 1.39.0 and 1.40.0 sent and stored, but each outbox item carries its mark
 * (`__edd_rm__`, from 1.41.0: its read model's tag, then its effect's) and its Put is conditioned on
 * its key holding nothing or the same effect's item (`attribute_not_exists(#pk) OR #rm = :rm`, from
 * 1.41.0): the only differences.
 */

import { readFileSync } from "node:fs"
import { describe, expect, it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Effect } from "effect"
import { beforeEach } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
import { readModelTag } from "../src/internal/ProjectionEngine.js"
import * as Table from "../src/Table.js"
import { InMemoryClient, resetStore, store } from "./helpers/InMemoryTables.js"
import { markOf } from "./helpers/OutboxMarks.js"
import { type Sent, scenario } from "./helpers/OutboxPairRequests.js"

type Captured = {
  readonly requests: ReadonlyArray<Sent>
  readonly items: Record<string, ReadonlyArray<Record<string, unknown>>>
}

const read = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"))

/**
 * What each published release sent and stored, captured once from it against DynamoDB Local: 1.39.0,
 * and 1.40.0 (identical to 1.39.0's, by the same scenario helper compiled against the published
 * package).
 */
const VERSIONS = ["1.39.0", "1.40.0"] as const
const fixture = Object.fromEntries(
  VERSIONS.map((version) => [version, read(`outbox-pair-${version}.json`) as Captured]),
)
const typed = Object.fromEntries(
  VERSIONS.map((version) => [
    version,
    read(`outbox-typed-pair-${version}.json`) as Record<"off" | "on", Captured>,
  ]),
)

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

type Item = Record<string, { readonly S?: string }>

/** `item` with its mark after the row it names, where 1.41.0 writes it. */
const tagged = (item: Item, tag: string): Item =>
  Object.fromEntries(
    Object.entries(item).flatMap(([name, value]) =>
      name === "__edd_row_sk__"
        ? [
            [name, value],
            ["__edd_rm__", { S: tag }],
          ]
        : [[name, value]],
    ),
  )

/**
 * What a release sent and stored (`captured`), but each outbox item carrying the mark of the read
 * model whose projection wrote it and of its effect (`__edd_rm__`, #237): the row written beside it
 * in one transaction, and the stored row it names. Its Put is conditioned on that mark
 * (`outboxGuard`): nothing at its key, or the same effect's item. Nothing else differs.
 */
const markedCapture = (captured: Captured, readModels: Record<string, unknown>): Captured => {
  const tags = Object.fromEntries(
    Object.entries(readModels).map(([table, entity]) => [table, readModelTag(entity)!]),
  )
  expect(new Set(Object.values(tags)).size).toBe(2)
  const isOutbox = (item: Item) => item.__edd_e__?.S === "Ledger#outbox"
  const requests = captured.requests.map((request) => {
    const input = request.input as {
      readonly TransactItems?: ReadonlyArray<{ readonly Put?: { TableName: string; Item: Item } }>
    }
    if (input.TransactItems === undefined) return request
    const row = input.TransactItems.find((t) => Object.hasOwn(tags, t.Put?.TableName ?? ""))
    if (row === undefined) return request
    return {
      ...request,
      input: {
        ...input,
        TransactItems: input.TransactItems.map((t) =>
          t.Put !== undefined && isOutbox(t.Put.Item)
            ? {
                ...t,
                Put: {
                  ...t.Put,
                  Item: tagged(
                    t.Put.Item,
                    markOf(readModels[row.Put!.TableName] as object, t.Put.Item),
                  ),
                  ConditionExpression: "attribute_not_exists(#pk) OR #rm = :rm",
                  ExpressionAttributeNames: { "#pk": "pk", "#rm": "__edd_rm__" },
                  ExpressionAttributeValues: {
                    ":rm": { S: markOf(readModels[row.Put!.TableName] as object, t.Put.Item) },
                  },
                },
              }
            : t,
        ),
      },
    }
  })
  const owner = (item: Item) =>
    Object.keys(tags).find((table) =>
      (captured.items[table] as ReadonlyArray<Item>).some(
        (stored) =>
          stored.pk?.S === item.__edd_row_pk__?.S && stored.sk?.S === item.__edd_row_sk__?.S,
      ),
    )!
  return {
    requests,
    items: {
      ...captured.items,
      outbox: (captured.items.outbox as ReadonlyArray<Item>).map((item) =>
        isOutbox(item) ? tagged(item, markOf(readModels[owner(item)] as object, item)) : item,
      ),
    },
  }
}

/**
 * `sent` and the tables' items are what a release sent and stored (`captured`), each outbox item
 * carrying its read model's tag.
 */
const expectCaptured = (
  sent: ReadonlyArray<Sent>,
  captured: Captured,
  readModels: Record<string, unknown>,
) => {
  const expected = markedCapture(captured, readModels)
  expect(sent.map((request) => JSON.stringify(request))).toEqual(
    expected.requests.map((request) => JSON.stringify(request)),
  )
  for (const table of ["readA", "readB", "outbox"] as const) {
    expect(JSON.parse(JSON.stringify(itemsOf(table)))).toEqual(expected.items[table])
  }
}

describe("read models whose outbox keys meet only through a value holding `#`", () => {
  it.effect.each(VERSIONS)("bind, and send and store what %s did", (version) =>
    Effect.gen(function* () {
      const { run, readModels } = scenario(lib, tables)
      expectCaptured(yield* run(InMemoryClient), fixture[version]!, readModels)
    }),
  )
})

describe("read models whose outbox keys part where a number's text can't spell a label", () => {
  // `n_0000000000000007` and `n_x_q`: a number's key text holds no `x`, so no key of one is a key
  // of the other, for any values.
  it.effect.each(
    VERSIONS.flatMap((version) =>
      (["off", "on"] as const).map((setting) => [version, setting] as const),
    ),
  )("bind, and send and store what %s did, escapeKeys %s", ([version, setting]) =>
    Effect.gen(function* () {
      const { run, readModels } = scenario(lib, tables, "typed", setting === "on")
      expectCaptured(yield* run(InMemoryClient), typed[version]![setting], readModels)
    }),
  )
})
