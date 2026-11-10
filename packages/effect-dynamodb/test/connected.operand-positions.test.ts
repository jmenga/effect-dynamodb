/**
 * The matrix of operand positions (`helpers/OperandPositions.ts`), against DynamoDB Local: every
 * wrapper, crossed with every path operation that carries an operand and three operands.
 *
 * - Where the published 1.39.0 wrote and the row read back
 *   (`fixtures/operand-positions-1.39.0.json`), the update is written and the row reads back.
 * - At a position resolved exactly and outside a union, the row reads back whatever the operand,
 *   and an invalid operand is refused.
 *
 * `test/OperandPositions.test.ts` compares the requests with 1.39.0's.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 */

import { readFileSync } from "node:fs"
import { it } from "@effect/vitest"
import { Cause, Config, Effect, Exit, Layer } from "effect"
import { describe, expect } from "vitest"
import * as Lib from "../src/index.js"
import {
  apply,
  definitions,
  type Kind,
  kinds,
  matrix,
  type Outcome,
} from "./helpers/OperandPositions.js"

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

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/operand-positions-1.39.0.json", import.meta.url), "utf8"),
) as { readonly cases: Record<string, Outcome> }

let tables = 0
/** Runs `body` with a client bound to `kind`'s entity on a table of its own. */
const onTable = <A>(kind: Kind, body: (db: any) => Effect.Effect<A, unknown, any>) => {
  const { E, Main } = definitions(Lib as never, kind)
  const tableName = `operand-positions-${Date.now()}-${tables++}`
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
        return yield* body(db)
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

describeConnected("the matrix of operand positions, on DynamoDB Local", () => {
  for (const kind of kinds) {
    it.effect(kind.name, () =>
      onTable(kind, (db) =>
        Effect.gen(function* () {
          for (const [n, each] of matrix.filter((one) => one.kind === kind).entries()) {
            const id = `a${n}`
            yield* db.entities.E.put({ id, target: kind.seed }).asEffect()
            const exit = yield* Effect.exit(
              Effect.suspend(() => apply(each, db.entities.E.update({ id })).asEffect()),
            )
            const read = yield* Effect.exit(db.entities.E.get({ id }))
            const was = fixture.cases[each.key]!
            const failure = Exit.isFailure(exit) ? String(Cause.squash(exit.cause)) : undefined
            // What 1.39.0 wrote and read back is written and reads back.
            if (was.ok && was.reads) {
              expect(failure === undefined ? "written" : `${each.key}: ${failure}`).toBe("written")
              expect(Exit.isSuccess(read) ? "read" : `${each.key}: not read back`).toBe("read")
            }
            if (kind.unknown) continue
            if (each.operand === "invalid") {
              expect(failure === undefined ? `${each.key}: written` : "refused").toBe("refused")
            }
            // Resolved exactly: no operand leaves a row that doesn't decode.
            if (!kind.union) {
              expect(Exit.isSuccess(read) ? "read" : `${each.key}: not read back`).toBe("read")
              if (each.operand !== "invalid") {
                expect(failure === undefined ? "written" : `${each.key}: ${failure}`).toBe(
                  "written",
                )
              }
            }
          }
        }),
      ),
    )
  }
})
