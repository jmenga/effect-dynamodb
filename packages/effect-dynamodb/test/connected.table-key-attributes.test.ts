/**
 * What a definition may store beside a table key it names otherwise (#183), read back on DynamoDB
 * Local, which keys on the attributes the table declares. `TableKeyAttributes.test.ts` has the
 * refusals.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 */

import { expect, it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Config, Effect, Layer, Schema } from "effect"
import { describe } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"

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

const schema = DynamoSchema.make({ name: "keys", version: 1 })
const upperKey = {
  pk: { field: "PK", composite: ["id"] },
  sk: { field: "SK", composite: [] },
}

const POSITIONS: ReadonlyArray<{
  readonly name: string
  readonly model: unknown
  readonly field: string
}> = [
  {
    name: "a model attribute named pk, with the table's key named PK",
    model: Schema.Struct({ id: Schema.String, pk: Schema.optional(Schema.String) }),
    field: "pk",
  },
  {
    name: "a model attribute named sk, with the table's key named SK",
    model: Schema.Struct({ id: Schema.String, sk: Schema.optional(Schema.String) }),
    field: "sk",
  },
  {
    name: "a model attribute renamed to sk, with the table's key named SK",
    model: DynamoModel.configure(
      Schema.Struct({ id: Schema.String, payload: Schema.optional(Schema.String) }),
      { payload: { field: "sk" } },
    ),
    field: "payload",
  },
]

let tables = 0

describeConnected("a model attribute beside a table key named otherwise, on DynamoDB Local", () => {
  for (const position of POSITIONS) {
    it.live(position.name, () => {
      const Docs = Entity.make({
        model: position.model,
        entityType: "Doc",
        primaryKey: upperKey,
      } as never) as any
      const MainTable = Table.make({ schema, entities: { Docs } } as never) as any
      const tableName = `table-keys-${Date.now()}-${tables++}`
      return Effect.acquireUseRelease(
        Effect.gen(function* () {
          const client = yield* DynamoClient
          yield* client.createTable({
            TableName: tableName,
            BillingMode: "PAY_PER_REQUEST",
            ...Table.definition(MainTable),
          })
        }),
        () =>
          Effect.gen(function* () {
            const db: any = yield* DynamoClient.make({
              entities: { Docs },
              tables: { MainTable },
            } as never)
            yield* db.entities.Docs.put({ id: "a b", [position.field]: "kept" }).asEffect()
            const got = yield* db.entities.Docs.get({ id: "a b" })
            expect(got[position.field]).toBe("kept")
            yield* db.entities.Docs.update({ id: "a b" })
              .set({ [position.field]: "changed" })
              .asEffect()
            expect((yield* db.entities.Docs.get({ id: "a b" }))[position.field]).toBe("changed")
          }),
        () =>
          Effect.gen(function* () {
            const client = yield* DynamoClient
            yield* client.deleteTable({ TableName: tableName })
          }).pipe(Effect.ignore),
      ).pipe(
        Effect.scoped,
        Effect.provide(Layer.mergeAll(ClientLayer, MainTable.layer({ name: tableName }))),
      ) as never
    })
  }
})
