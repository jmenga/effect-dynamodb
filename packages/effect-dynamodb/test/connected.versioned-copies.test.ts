/**
 * A versioned entity without a vector index sends what the published 1.40.0 sent (#240), byte for
 * byte and in order, for every write that reads the item first: a soft delete, a retain update and
 * delete, an index composite's update and a unique value's update, the updates too wide for one
 * expression included (`fixtures/versioned-copy-requests-1.40.0.json`, see
 * `helpers/VersionedCopies.ts`). With a vector index, those that copy the vector from the read also
 * hold it as read (`VectorWriteRaces.test.ts`). On DynamoDB Local, since an item read back holds
 * its attributes in the order DynamoDB returns them, which a recording table doesn't reproduce.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 */

import { readFileSync } from "node:fs"
import { it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Config, Effect, Layer, Schema } from "effect"
import { describe, expect } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"
import { requestText } from "./helpers/QuietTable.js"
import { copiesWorld, copyWrites, normalized } from "./helpers/VersionedCopies.js"

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

const ClientLayer = DynamoClient.layer({
  region: "us-east-1",
  endpoint: ENDPOINT,
  credentials: { accessKeyId: "local", secretAccessKey: "local" },
})

const MODULES = { Effect, Schema, DynamoSchema, Entity, Table, DynamoClient }

const fixture: { readonly requests: ReadonlyArray<string> } = JSON.parse(
  readFileSync(new URL("./fixtures/versioned-copy-requests-1.40.0.json", import.meta.url), "utf8"),
)

describeConnected("a versioned entity without a vector index, on DynamoDB", () => {
  it.effect("sends 1.40.0's requests for each write that reads the item first", () =>
    Effect.gen(function* () {
      const world = copiesWorld(MODULES)
      const tableName = `versioned-copies-${Date.now()}`
      const sent: Array<string> = []
      let recording = false
      const recorder = Layer.effect(
        DynamoClient,
        Effect.gen(function* () {
          const inner: any = yield* DynamoClient
          return new Proxy(inner, {
            get: (target, property) => {
              const method = Reflect.get(target, property)
              if (typeof method !== "function" || typeof property !== "string") return method
              return (input: unknown) => {
                if (recording) sent.push(requestText(property, input, tableName))
                return method.call(target, input)
              }
            },
          })
        }) as never,
      ).pipe(Layer.provide(ClientLayer)) as Layer.Layer<DynamoClient>
      yield* Effect.gen(function* () {
        const db: any = yield* world.client
        yield* db.tables.MainTable.create()
        recording = true
        yield* Effect.ensuring(
          copyWrites(MODULES, world) as Effect.Effect<void, unknown>,
          Effect.sync(() => {
            recording = false
          }),
        )
        yield* db.tables.MainTable.delete()
      }).pipe(
        Effect.provide(Layer.merge(recorder, world.MainTable.layer({ name: tableName }))),
      ) as Effect.Effect<void, unknown>
      expect(normalized(sent)).toEqual(fixture.requests)
    }),
  )
})
