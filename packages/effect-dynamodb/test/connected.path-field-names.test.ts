/**
 * A model field named like a path builder accessor (`size`), at the root and below a struct,
 * against DynamoDB Local: a condition on `t.size` holds or fails as the stored value says, a filter
 * on it finds the row, and a select of it returns it. Through 1.41.0 `eq(t.size, 5)` sent
 * `:e0 = :e1` with nothing behind `:e0`, which DynamoDB rejects, and a select of `t.size` died
 * before sending. `test/PathBuilderMembers.test.ts` checks the names each request sends.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 */

import { it } from "@effect/vitest"
import { Config, Effect, Layer, Schema } from "effect"
import { describe, expect } from "vitest"
import * as Lib from "../src/index.js"

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

const credentials = { accessKeyId: "local", secretAccessKey: "local" }
const ClientLayer = Lib.DynamoClient.layer({ region: "us-east-1", endpoint: ENDPOINT, credentials })

const Listings = Lib.Entity.make({
  model: Schema.Struct({
    id: Schema.String,
    size: Schema.Number,
    box: Schema.Struct({ size: Schema.Number, label: Schema.String }),
  }),
  entityType: "Listing",
  primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
})
const Main = Lib.Table.make({
  schema: Lib.DynamoSchema.make({ name: "sizes", version: 1 }),
  entities: { Listings },
})
const tableName = `path-field-names-${Date.now()}`

describeConnected("a field named size, on DynamoDB Local", () => {
  it.effect("is reached by a condition, a filter and a select", () =>
    Effect.acquireUseRelease(
      Effect.gen(function* () {
        const db = yield* Lib.DynamoClient.make({ entities: { Listings }, tables: { Main } })
        yield* db.tables.Main.create()
        return db
      }),
      (db) =>
        Effect.gen(function* () {
          yield* db.entities.Listings.put({ id: "a", size: 5, box: { size: 5, label: "l" } })
          yield* db.entities.Listings.update({ id: "a" })
            .set({ box: { size: 6, label: "l" } })
            .condition((t, { and, eq }) => and(eq(t.size, 5), eq(t.box.size, 5)))
          const refused = yield* db.entities.Listings.update({ id: "a" })
            .set({ size: 7 })
            .condition((t, { eq }) => eq(t.size, 6))
            .asEffect()
            .pipe(Effect.flip)
          expect(refused._tag).toBe("ConditionalCheckFailed")
          const found = yield* db.entities.Listings.scan()
            .filter((t, { and, eq }) => and(eq(t.size, 5), eq(t.box.size, 6)))
            .collect()
          expect(found.map((listing) => listing.id)).toEqual(["a"])
          const selected = yield* db.entities.Listings.scan()
            .select((t) => [t.size, t.box.size])
            .collect()
          expect(selected).toEqual([{ size: 5, box: { size: 6 } }])
        }),
      (db) => db.tables.Main.delete().pipe(Effect.ignore),
    ).pipe(Effect.provide(Layer.merge(ClientLayer, Main.layer({ name: tableName })))),
  )
})
