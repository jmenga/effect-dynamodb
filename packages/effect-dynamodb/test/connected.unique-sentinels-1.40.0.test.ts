/**
 * A unique field named like an `Object.prototype` member, left out of a write by published 1.40.0,
 * then written by this release, against DynamoDB Local (#239).
 *
 * 1.40.0 read such a field, left out, as the member every object inherits: `put({ id: "b" })` of
 * an entity whose unique constraint names an optional `toString` reserved a sentinel keyed by the
 * text of `Object.prototype.toString`. The rows below are exactly what it wrote, captured from the
 * published package (and the `Doc` rows are among the rows `fixtures/inherited-names-1.40.0.json`
 * holds for "unique field: toString"). This release reads the field as holding no value, so it
 * composes no sentinel for that row: every write and delete of it works, and the sentinels 1.40.0
 * wrote are left where they are. Nothing reads them, and nothing releases them: delete each by
 * its key.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 */

import { readFileSync } from "node:fs"
import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Config, Effect, Layer, Schema } from "effect"
import { describe, expect } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"
import * as Transaction from "../src/Transaction.js"
import { canon } from "./helpers/InheritedNames.js"

const ENDPOINT = Effect.runSync(
  Config.String("DYNAMODB_ENDPOINT").pipe(Config.withDefault("http://localhost:8000")),
)

let dynamoAvailable = false
try {
  const res = await fetch(ENDPOINT, { method: "POST", signal: AbortSignal.timeout(1000) }).catch(
    () => null,
  )
  dynamoAvailable = res !== null
} catch {
  dynamoAvailable = false
}
const describeConnected = dynamoAvailable ? describe : describe.skip

const model = Schema.Struct({
  id: Schema.String,
  note: Schema.optional(Schema.String),
  toString: Schema.optional(Schema.String),
})
type Input = typeof model.Type
const primaryKey = {
  pk: { field: "pk", composite: ["id"] },
  sk: { field: "sk", composite: [] },
} as const
const Docs = Entity.make({
  model,
  entityType: "Doc",
  primaryKey,
  unique: { byIt: ["toString"], byPair: ["toString", "note"] },
})
const Soft = Entity.make({
  model,
  entityType: "Soft",
  primaryKey,
  softDelete: true,
  unique: { byIt: ["toString"] },
})
const Kept = Entity.make({
  model,
  entityType: "Kept",
  primaryKey,
  softDelete: { preserveUnique: true },
  unique: { byIt: ["toString"] },
})
const Main = Table.make({
  schema: DynamoSchema.make({ name: "names", version: 1 }),
  entities: { Docs, Soft, Kept },
})

const S = (value: string): AttributeValue => ({ S: value })
const FUNCTION = "function tostring() { [native code] }"
const row = (type: string): Record<string, AttributeValue> => ({
  pk: S(`$names#v1#${type}#id_b`),
  sk: S(`$names#v1#${type}`),
  __edd_e__: S(type.charAt(0).toUpperCase() + type.slice(1)),
  id: S("b"),
  note: S("n"),
})
const sentinel = (type: string, constraint: string, value: string) => ({
  pk: S(`$names#v1#${type}.${constraint.toLowerCase()}#${value}`),
  sk: S(`$names#v1#${type}.${constraint.toLowerCase()}`),
  __edd_e__: S(`${type.charAt(0).toUpperCase() + type.slice(1)}._unique.${constraint}`),
  _entity_pk: S(`$names#v1#${type}#id_b`),
  _entity_sk: S(`$names#v1#${type}`),
})

/** What 1.40.0 wrote for `put({ id: "b", note: "n" })` on each entity. */
const ROWS_1_40_0 = [row("doc"), row("soft"), row("kept")]
const SENTINELS_1_40_0 = [
  sentinel("doc", "byIt", FUNCTION),
  sentinel("doc", "byPair", `${FUNCTION}#n`),
  sentinel("soft", "byIt", FUNCTION),
  sentinel("kept", "byIt", FUNCTION),
]

const tableName = `unique-140-${Date.now()}`
const credentials = { accessKeyId: "local", secretAccessKey: "local" }
const TestLayer = Layer.mergeAll(
  DynamoClient.layer({ region: "us-east-1", endpoint: ENDPOINT, credentials }),
  Main.layer({ name: tableName }),
)

const scanned = Effect.gen(function* () {
  const client = yield* DynamoClient
  const { Items } = yield* client.scan({ TableName: tableName, ConsistentRead: true })
  return (Items ?? []) as ReadonlyArray<Record<string, AttributeValue>>
})
const sentinelsIn = (items: ReadonlyArray<Record<string, AttributeValue>>) =>
  items.filter((item) => item.__edd_e__?.S?.includes("._unique.") === true)
const sorted = (items: ReadonlyArray<unknown>) => items.map((item) => canon(item, "x")).sort()

describeConnected("a unique field left out by a 1.40.0 write (#239)", () => {
  it("seeds what the 1.40.0 fixture recorded", () => {
    const fixture = JSON.parse(
      readFileSync(new URL("./fixtures/inherited-names-1.40.0.json", import.meta.url), "utf8"),
    ) as { readonly cases: Record<string, { readonly rows: ReadonlyArray<string> }> }
    const recorded = fixture.cases["unique field: toString"]!.rows
    for (const item of [row("doc"), ...SENTINELS_1_40_0.slice(0, 2)]) {
      expect(recorded).toContain(canon(item, "toString"))
    }
  })

  it.effect("writes and deletes such a row, leaving the sentinels 1.40.0 wrote", () =>
    Effect.gen(function* () {
      const client = yield* DynamoClient
      yield* client.createTable({
        TableName: tableName,
        BillingMode: "PAY_PER_REQUEST",
        ...Table.definition(Main),
      })
      for (const Item of [...ROWS_1_40_0, ...SENTINELS_1_40_0]) {
        yield* client.putItem({ TableName: tableName, Item })
      }
      const db = yield* DynamoClient.make({ entities: { Docs, Soft, Kept }, tables: { Main } })

      // `rekey` finds nothing to move: the rows hold this release's key text.
      const report = yield* db.tables.Main.rekey()
      expect(Object.values(report.moved).every((count) => count === 0)).toBe(true)
      expect(report.sentinelsMoved).toBe(0)

      // Each write of the row reserves nothing: the field holds no value.
      expect(yield* db.entities.Docs.get({ id: "b" })).toEqual({ id: "b", note: "n" })
      // A field named `toString` makes TypeScript compare a literal's inherited method with the
      // field's type, so each payload is given as the model's input.
      yield* db.entities.Docs.update({ id: "b" }).set({ note: "m" } as Input)
      yield* db.entities.Docs.put({ id: "c", note: "n" } as Input)
      yield* db.entities.Docs.create({ id: "d" } as Input)
      yield* Transaction.transactWrite([db.entities.Docs.delete({ id: "d" })])

      // Every delete works: the hard one, the soft ones, and their restores.
      yield* db.entities.Docs.delete({ id: "b" })
      yield* db.entities.Docs.delete({ id: "c" })
      yield* db.entities.Soft.delete({ id: "b" })
      expect(yield* db.entities.Soft.restore({ id: "b" })).toEqual({ id: "b", note: "n" })
      yield* db.entities.Kept.delete({ id: "b" })
      expect(yield* db.entities.Kept.restore({ id: "b" })).toEqual({ id: "b", note: "n" })
      yield* db.entities.Soft.delete({ id: "b" })
      yield* db.entities.Soft.purge({ id: "b" })

      // The sentinels 1.40.0 wrote are left as they were, and no other is written.
      const items = yield* scanned
      expect(sorted(sentinelsIn(items))).toEqual(sorted(SENTINELS_1_40_0))
      expect(sorted(items.filter((item) => !sentinelsIn([item]).length))).toEqual(
        sorted([row("kept")]),
      )

      // Nothing reads or releases them: each goes by its key.
      for (const { pk, sk } of SENTINELS_1_40_0) {
        yield* client.deleteItem({ TableName: tableName, Key: { pk, sk } })
      }
      expect(sentinelsIn(yield* scanned)).toEqual([])
      yield* client.deleteTable({ TableName: tableName })
    }).pipe(Effect.provide(TestLayer)),
  )
})
