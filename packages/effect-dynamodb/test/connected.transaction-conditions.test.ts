/**
 * A transaction's conditions, against DynamoDB Local (#236): a planned op's condition with an
 * empty part where none may be (`or()` with no parts, a `NaN` operand) is refused with a
 * `ValidationError` and nothing is written, where the transaction used to die with a defect. And
 * `Transaction.check` with a compiled condition (`Expression.condition`) names the attribute a
 * renamed field is stored in, so it holds on a row holding the value.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 */

import { type AttributeValue, DynamoDBClient, ScanCommand } from "@aws-sdk/client-dynamodb"
import { it } from "@effect/vitest"
import { Cause, Config, Effect, Exit, Layer, Schema } from "effect"
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
const raw = new DynamoDBClient({ region: "us-east-1", endpoint: ENDPOINT, credentials })
const ClientLayer = Lib.DynamoClient.layer({ region: "us-east-1", endpoint: ENDPOINT, credentials })

type Row = Record<string, AttributeValue>

let tables = 0
/** Runs `body` with a client bound to `E` on a table of its own, and a scan of that table. */
const onTable = <A>(
  E: any,
  body: (db: any, scan: Effect.Effect<ReadonlyArray<Row>>) => Effect.Effect<A, unknown, any>,
): Effect.Effect<A, unknown> => {
  const Main = Lib.Table.make({
    schema: Lib.DynamoSchema.make({ name: "conditions", version: 1 }),
    entities: { E },
  } as never) as any
  const tableName = `transaction-conditions-${Date.now()}-${tables++}`
  return Effect.acquireUseRelease(
    Effect.gen(function* () {
      const client = yield* Lib.DynamoClient
      yield* client.createTable({
        TableName: tableName,
        BillingMode: "PAY_PER_REQUEST",
        KeySchema: [
          { AttributeName: "pk", KeyType: "HASH" },
          { AttributeName: "sk", KeyType: "RANGE" },
        ],
        AttributeDefinitions: [
          { AttributeName: "pk", AttributeType: "S" },
          { AttributeName: "sk", AttributeType: "S" },
        ],
      })
    }),
    () =>
      Effect.gen(function* () {
        const db: any = yield* Lib.DynamoClient.make({ entities: { E }, tables: { Main } } as never)
        const scan = Effect.promise(() =>
          raw.send(new ScanCommand({ TableName: tableName, ConsistentRead: true })),
        ).pipe(
          Effect.map((out) =>
            [...((out.Items ?? []) as ReadonlyArray<Row>)].sort((a, b) =>
              JSON.stringify(a).localeCompare(JSON.stringify(b)),
            ),
          ),
        )
        return yield* body(db, scan)
      }),
    () =>
      Effect.gen(function* () {
        const client = yield* Lib.DynamoClient
        yield* client.deleteTable({ TableName: tableName })
      }).pipe(Effect.ignore),
  ).pipe(
    Effect.provide(Layer.merge(ClientLayer, Main.layer({ name: tableName }) as Layer.Layer<never>)),
  ) as Effect.Effect<A, unknown>
}

const entity = (retained: boolean) =>
  Lib.Entity.make({
    model: Schema.Struct({ id: Schema.String, n: Schema.optional(Schema.Number) }),
    entityType: "E",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
    ...(retained ? { versioned: { retain: true } } : {}),
  } as never) as any

const or = (_: unknown, ops: any) => ops.or()

describeConnected("a transaction's conditions, on DynamoDB Local", () => {
  for (const [name, retained, op] of [
    [
      "an update with an empty or()",
      false,
      (db: any) => db.entities.E.update({ id: "a" }).set({ n: 1 }).condition(or),
    ],
    [
      "an update comparing with NaN",
      false,
      (db: any) => db.entities.E.update({ id: "a" }).set({ n: 1 }).condition({ n: Number.NaN }),
    ],
    [
      "a retained entity's delete with an empty or()",
      true,
      (db: any) => db.entities.E.delete({ id: "a" }).condition(or),
    ],
    [
      "a retained entity's delete comparing with NaN",
      true,
      (db: any) => db.entities.E.delete({ id: "a" }).condition({ n: Number.NaN }),
    ],
  ] as const) {
    it.effect(`refuses a planned op's condition: ${name}, and writes nothing`, () =>
      onTable(entity(retained), (db, scan) =>
        Effect.gen(function* () {
          yield* db.entities.E.put({ id: "a", n: 1 }).asEffect()
          yield* db.entities.E.put({ id: "b", n: 1 }).asEffect()
          const before = yield* scan
          const exit = yield* Effect.exit(
            Lib.Transaction.transactWrite([
              db.entities.E.update({ id: "b" }).set({ n: 2 }),
              op(db),
            ]),
          )
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) {
            expect(exit.cause.reasons[0]!._tag).toBe("Fail")
            const error = Cause.squash(exit.cause) as any
            expect(error._tag).toBe("ValidationError")
            expect(error.operation).toBe("transactWrite.condition")
          }
          // Nothing was written: `b` was not updated, `a` not deleted.
          expect(yield* scan).toEqual(before)
        }),
      ),
    )
  }

  it.effect("Transaction.check of a compiled condition names a renamed field's attribute", () =>
    onTable(
      Lib.Entity.make({
        model: Lib.DynamoModel.configure(
          Schema.Struct({ id: Schema.String, count: Schema.Number }),
          { count: { field: "renamed" } },
        ),
        entityType: "R",
        primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
      } as never) as any,
      (db, scan) =>
        Effect.gen(function* () {
          yield* db.entities.E.put({ id: "a", count: 1 }).asEffect()
          const check = (condition: Lib.Expression.ExpressionResult, id: string) =>
            Effect.exit(
              Lib.Transaction.transactWrite([
                Lib.Transaction.check(db.entities.E.get({ id: "a" }), condition),
                db.entities.E.put({ id, count: 2 }),
              ]),
            )
          // The row holds `renamed: 1`: the check holds, and `b` is written.
          expect(
            Exit.isSuccess(yield* check(Lib.Expression.condition({ eq: { count: 1 } }), "b")),
          ).toBe(true)
          // And it fails where the value differs, writing nothing.
          const exit = yield* check(Lib.Expression.condition({ eq: { count: 2 } }), "c")
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) {
            expect((Cause.squash(exit.cause) as any)._tag).toBe("TransactionCancelled")
          }
          expect((yield* scan).map((row) => row.id?.S).sort()).toEqual(["a", "b"])
        }),
    ),
  )
})
