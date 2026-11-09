/**
 * The puts `Batch.write` and `Transaction.transactWrite` build send the bytes 1.39.0 sent: every
 * attribute in the same order, the keys before the stamps (`createdAt`, `updatedAt`, `version`).
 * Captured once from the published 1.39.0 at a fixed clock (`fixtures/put-requests-1.39.0.json`;
 * never regenerate it). Only the incarnation token, a fresh UUID on every put, is set aside.
 * `Entity.put` is captured too: its order (the stamps before the keys) is its own, and unchanged.
 */

import { readFileSync } from "node:fs"
import { describe, expect, it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Effect, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import * as Batch from "../src/Batch.js"
import { DynamoClient, type DynamoClientService } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"
import * as Transaction from "../src/Transaction.js"
import { mockDynamoClientLayer } from "./helpers/MockDynamoClient.js"

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/put-requests-1.39.0.json", import.meta.url), "utf8"),
) as {
  readonly generatedFrom: string
  readonly scenarios: ReadonlyArray<{
    readonly name: string
    readonly requests: ReadonlyArray<{ readonly command: string; readonly json: string }>
  }>
}

const schema = DynamoSchema.make({ name: "order", version: 1 })

class Doc extends Schema.Class<Doc>("Doc")({
  docId: Schema.String,
  owner: Schema.String,
  title: Schema.String,
}) {}

const primaryKey = {
  pk: { field: "pk", composite: ["docId"] },
  sk: { field: "sk", composite: [] },
} as const
const indexes = {
  byOwner: {
    name: "gsi1",
    pk: { field: "gsi1pk", composite: ["owner"] },
    sk: { field: "gsi1sk", composite: ["docId"] },
  },
} as const

const VersionedDocs = Entity.make({
  model: Doc,
  entityType: "VersionedDoc",
  primaryKey,
  indexes,
  versioned: true,
  timestamps: true,
})
const StampedDocs = Entity.make({
  model: Doc,
  entityType: "StampedDoc",
  primaryKey,
  indexes,
  timestamps: true,
})
const PlainDocs = Entity.make({ model: Doc, entityType: "PlainDoc", primaryKey, indexes })

const MainTable = Table.make({ schema, entities: { VersionedDocs, StampedDocs, PlainDocs } })

/** The incarnation token, a fresh UUID on every put, set aside. */
const sameToken = (json: string) =>
  json.replace(/"__edd_i__":\{"S":"[0-9a-f-]{36}"\}/g, '"__edd_i__":{"S":"<token>"}')

const doc = (entity: typeof VersionedDocs | typeof StampedDocs | typeof PlainDocs, docId: string) =>
  entity.put({ docId, owner: "ann", title: `doc ${docId}` })

describe(`put requests as ${fixture.generatedFrom} sent them`, () => {
  it.effect("Batch.write, Transaction.transactWrite and Entity.put send the same bytes", () =>
    Effect.gen(function* () {
      const requests: Array<{ command: string; json: string }> = []
      const record =
        (command: string, output: unknown) =>
        (input: unknown): Effect.Effect<any> =>
          Effect.sync(() => {
            requests.push({ command, json: JSON.stringify(input) })
            return output
          })
      const client = mockDynamoClientLayer({
        getItem: record("GetItem", {}),
        putItem: record("PutItem", {}),
        batchWriteItem: record("BatchWriteItem", { UnprocessedItems: {} }),
        transactWriteItems: record("TransactWriteItems", {}),
      } as Partial<DynamoClientService>)
      const scenarios: Array<{ name: string; requests: Array<{ command: string; json: string }> }> =
        []
      const take = (name: string) => {
        scenarios.push({ name, requests: requests.splice(0) })
      }
      yield* Effect.gen(function* () {
        yield* TestClock.setTime(Date.UTC(2026, 0, 2, 3, 4, 5, 678))
        yield* Batch.write([doc(VersionedDocs, "v1"), doc(VersionedDocs, "v2")])
        take("Batch.write versioned puts")
        yield* Batch.write([doc(StampedDocs, "s1"), doc(PlainDocs, "p1")])
        take("Batch.write plain puts")
        yield* Transaction.transactWrite([
          doc(VersionedDocs, "v3"),
          doc(StampedDocs, "s2"),
          doc(PlainDocs, "p2"),
        ])
        take("Transaction.transactWrite puts")
        const db = yield* DynamoClient.make({
          entities: { VersionedDocs, StampedDocs, PlainDocs },
          tables: { MainTable },
        })
        yield* db.entities.VersionedDocs.put({ docId: "v4", owner: "ann", title: "doc v4" })
        yield* db.entities.StampedDocs.put({ docId: "s3", owner: "ann", title: "doc s3" })
        yield* db.entities.PlainDocs.put({ docId: "p3", owner: "ann", title: "doc p3" })
        take("Entity.put")
      }).pipe(Effect.provide(Layer.mergeAll(client, MainTable.layer({ name: "t" }))))

      const normalised = (list: typeof fixture.scenarios) =>
        list.map(({ name, requests }) => ({
          name,
          requests: requests.map(({ command, json }) => ({ command, json: sameToken(json) })),
        }))
      expect(normalised(scenarios)).toEqual(normalised(fixture.scenarios))
    }),
  )
})
