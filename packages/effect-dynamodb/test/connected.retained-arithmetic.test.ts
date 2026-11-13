/**
 * The arithmetic of an update that reads the row first (`helpers/ReadFirstUpdates.ts`: a retained
 * entity's, one changing a unique field, one computing an index composite) against DynamoDB Local,
 * beside the same update of an entity without the configuration (#236): for each case of
 * `helpers/RetainedArithmetic.ts`, alone and in a transaction, both paths store the same
 * attribute, the one the case names, or are both refused by DynamoDB with nothing written. A
 * bigint field's value is computed exactly on both sides of 2^53, where the update that reads
 * first died mixing a bigint with a number; a number's fraction as DynamoDB computes it (`0.3`,
 * not `0.30000000000000004`); a set's members by value. A set operand is sent, and applied, as
 * the set at its position stores its members (`memberKindCases`: a `NumberFromString` set's are
 * strings), and a `NumberValue` operand is the number its text holds.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 */

import { type AttributeValue, DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb"
import { it } from "@effect/vitest"
import { Cause, Config, Effect, Exit, Layer } from "effect"
import { describe, expect } from "vitest"
import * as Lib from "../src/index.js"
import { READ_FIRST, type ReadFirstUpdate } from "./helpers/ReadFirstUpdates.js"
import {
  arithmeticCases,
  arithmeticModel,
  memberKindCases,
  sorted,
} from "./helpers/RetainedArithmetic.js"

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

let tables = 0
/**
 * How an update of `a` ended, and the attribute it's about as stored afterwards, on an entity with
 * `config` (`configured`) or without it, with `config`'s update besides the case's.
 */
const outcome = (
  config: ReadFirstUpdate,
  configured: boolean,
  transaction: boolean,
  seed: Record<string, unknown>,
  apply: (u: any) => any,
  attribute: string,
) => {
  const E = Lib.Entity.make({
    model: arithmeticModel,
    entityType: "E",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
    ...(configured ? config.entity : {}),
  } as never) as any
  const Main = Lib.Table.make({
    schema: Lib.DynamoSchema.make({ name: "arith", version: 1 }),
    entities: { E },
  } as never) as any
  const tableName = `retained-arithmetic-${Date.now()}-${tables++}`
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
        yield* db.entities.E.put({ id: "a", ...seed }).asEffect()
        yield* db.entities.E.put({ id: "b" }).asEffect()
        const op = apply(config.prefix(db.entities.E.update({ id: "a" })))
        const exit = yield* Effect.exit(
          transaction
            ? Lib.Transaction.transactWrite([db.entities.E.update({ id: "b" }).set({ n: 1 }), op])
            : op.asEffect(),
        )
        const row = yield* Effect.promise(() =>
          raw.send(
            new GetItemCommand({
              TableName: tableName,
              Key: { pk: { S: "$arith#v1#e#id_a" }, sk: { S: "$arith#v1#e" } },
              ConsistentRead: true,
            }),
          ),
        )
        const read = yield* Effect.exit(db.entities.E.get({ id: "a" }))
        const failure = Exit.isFailure(exit) ? (Cause.squash(exit.cause) as any) : undefined
        return {
          ok: Exit.isSuccess(exit),
          error: failure === undefined ? undefined : (failure._tag ?? `defect ${String(failure)}`),
          stored: sorted(row.Item?.[attribute] as AttributeValue | undefined),
          reads: Exit.isSuccess(read),
        }
      }),
    () =>
      Effect.gen(function* () {
        const client = yield* Lib.DynamoClient
        yield* client.deleteTable({ TableName: tableName })
      }).pipe(Effect.ignore),
  ).pipe(
    Effect.provide(Layer.merge(ClientLayer, Main.layer({ name: tableName }) as Layer.Layer<never>)),
  ) as Effect.Effect<
    { ok: boolean; error: string | undefined; stored: unknown; reads: boolean },
    unknown
  >
}

describeConnected.each(READ_FIRST)(
  "$name: the arithmetic stores what DynamoDB's does",
  (config) => {
    const cases = [...arithmeticCases, ...memberKindCases].filter(
      (each) => each.pathOp !== true || config.takesPathOps,
    )
    for (const transaction of [false, true]) {
      for (const each of cases) {
        it.effect(`${each.name}, ${transaction ? "in a transaction" : "alone"}`, () =>
          Effect.gen(function* () {
            const plain = yield* outcome(
              config,
              false,
              transaction,
              each.seed,
              each.apply,
              each.attribute,
            )
            const retained = yield* outcome(
              config,
              true,
              transaction,
              each.seed,
              each.apply,
              each.attribute,
            )
            // DynamoDB stores what the case says, or refuses the update.
            if (each.stored === undefined) {
              expect(plain.ok).toBe(false)
              expect(plain.error).toBe("DynamoValidationError")
            } else {
              expect(plain.ok).toBe(true)
              expect(plain.stored).toEqual(sorted(each.stored))
            }
            // The retained update ends the same way.
            expect(retained).toEqual(plain)
          }),
        )
      }
    }
  },
)
