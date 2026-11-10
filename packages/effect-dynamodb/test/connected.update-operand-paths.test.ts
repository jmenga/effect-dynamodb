/**
 * What an update's path operand is written as, against DynamoDB Local: every case of
 * `helpers/UpdateOperandRequests.ts` (the operands 1.39.0 accepted, whose requests
 * `test/UpdateOperandRequests.test.ts` compares with 1.39.0's) is applied and read back, and the
 * rules for a path into a union, a property named as a renamed field and a copy are checked on the
 * stored row.
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
import {
  definitions,
  matrix,
  seed,
  type Variant,
  variants,
  type World,
} from "./helpers/UpdateOperandRequests.js"

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
/** Runs `body` with a client bound to `variant`'s entity on a table of its own. */
const onTable = <A>(
  variant: Variant,
  world: World,
  body: (context: {
    readonly db: any
    readonly row: (id: string) => Effect.Effect<Row | undefined>
  }) => Effect.Effect<A, unknown, any>,
) => {
  const { E, Main } = definitions(Lib as never, variant, world)
  const tableName = `operand-paths-${Date.now()}-${tables++}`
  const row = (id: string) =>
    Effect.promise(() =>
      raw.send(
        new GetItemCommand({
          TableName: tableName,
          Key: { pk: { S: `$operands#v1#e#id_${id}` }, sk: { S: "$operands#v1#e" } },
          ConsistentRead: true,
        }),
      ),
    ).pipe(Effect.map((out) => out.Item))
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
        return yield* body({ db, row })
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

/** Seeds a pair of items of their own, and applies `apply` to an update of the first. */
const send = (
  db: any,
  n: number,
  transaction: boolean,
  apply: (update: any) => any,
  seeded: Record<string, unknown> = {},
  world: World = "main",
) =>
  Effect.gen(function* () {
    const [a, b] = [`a${n}`, `b${n}`]
    yield* db.entities.E.put({ ...seed(a, world), ...seeded }).asEffect()
    yield* db.entities.E.put(seed(b, world)).asEffect()
    const update = (id: string) => db.entities.E.update({ id })
    const exit = yield* Effect.exit(
      Effect.suspend(() => {
        const op = apply(update(a))
        return transaction
          ? Lib.Transaction.transactWrite([update(b).set({ count: 2 }), op])
          : op.asEffect()
      }),
    )
    const read = yield* Effect.exit(db.entities.E.get({ id: a }))
    return { id: a, exit, read }
  })

const set = (segments: ReadonlyArray<string | number>, value: unknown) => (update: any) =>
  update.pathSet({ segments, value, isPath: false })

describeConnected("an update's path operand, on DynamoDB Local", () => {
  for (const variant of variants) {
    for (const transaction of [false, true]) {
      const where = `${variant}, ${transaction ? "in a transaction" : "alone"}`
      for (const world of ["main", "stored", "named"] as const) {
        const cases = matrix.filter(
          (each) =>
            each.variant === variant && each.transaction === transaction && each.world === world,
        )
        if (cases.length === 0) continue
        it.effect(
          `every operand 1.39.0 accepted is written and read back (${where}, the ${world} model)`,
          () =>
            onTable(variant, world, ({ db }) =>
              Effect.gen(function* () {
                for (const [n, each] of cases.entries()) {
                  const { exit, read } = yield* send(db, n, transaction, each.apply, {}, world)
                  expect(
                    Exit.isFailure(exit)
                      ? `${each.key}: ${String(Cause.squash(exit.cause))}`
                      : "ok",
                  ).toBe("ok")
                  expect(Exit.isSuccess(read) ? "read" : `${each.key}: not read back`).toBe("read")
                }
              }),
            ),
        )
      }

      it.effect(`an operand the reader reads as given, and a union of lists (${where})`, () =>
        onTable(variant, "stored", ({ db, row }) =>
          Effect.gen(function* () {
            // A number where the entry's schema stores text: sent as given, and read back.
            const number = yield* send(db, 1, transaction, set(["counts#a"], 2), {}, "stored")
            expect(Exit.isSuccess(number.exit)).toBe(true)
            expect((yield* row(number.id))?.["counts#a"]).toEqual({ N: "2" })
            expect(Exit.isSuccess(number.read) ? (number.read.value as any).counts : "").toEqual({
              a: 2,
            })

            // Members that encode `2` to one stored value agree, though each makes a `Set` of its own.
            const agreed = yield* send(
              db,
              2,
              transaction,
              set(["sets#a", "value"], 2),
              {},
              "stored",
            )
            expect(Exit.isSuccess(agreed.exit)).toBe(true)
            expect((yield* row(agreed.id))?.["sets#a"]?.M?.value).toEqual({ NS: ["2"] })
            expect(Exit.isSuccess(agreed.read)).toBe(true)

            // Elements neither list of the union takes: refused, the row untouched.
            const before = yield* Effect.gen(function* () {
              yield* db.entities.E.put(seed("a3", "stored")).asEffect()
              return yield* row("a3")
            })
            const mixed = yield* send(
              db,
              3,
              transaction,
              (update) => update.append({ either: [true] }),
              {},
              "stored",
            )
            expect(Exit.isFailure(mixed.exit)).toBe(true)
            expect((yield* row(mixed.id))?.either).toEqual(before?.either)
            expect(Exit.isSuccess(mixed.read)).toBe(true)
          }),
        ),
      )

      it.effect(`a path into a union, a renamed property's name and a copy (${where})`, () =>
        onTable(variant, "main", ({ db, row }) =>
          Effect.gen(function* () {
            // Members that store `2` differently: the entry holds the second, and gets `2` as given.
            const raw2 = yield* send(db, 1, transaction, set(["codes#a", "value"], 2))
            expect(Exit.isSuccess(raw2.exit)).toBe(true)
            expect((yield* row(raw2.id))?.["codes#a"]?.M?.value).toEqual({ N: "2" })
            expect(Exit.isSuccess(raw2.read)).toBe(true)

            // On a path the model names, a value the first member refuses is refused, as on
            // 1.39.0: the row holds the first member, and stays as it was.
            const text = yield* send(db, 2, transaction, set(["shape", "value"], "new"))
            expect(Exit.isFailure(text.exit)).toBe(true)
            expect((yield* row(text.id))?.shape?.M?.value).toEqual({ N: "1" })
            expect(Exit.isSuccess(text.read)).toBe(true)

            // Members that disagree, and neither reads `2` as given: refused, the row untouched.
            const before = yield* Effect.gen(function* () {
              yield* db.entities.E.put(seed("a3")).asEffect()
              return yield* row("a3")
            })
            const rival = yield* send(db, 3, transaction, set(["rivals#a", "value"], 2))
            expect(Exit.isFailure(rival.exit)).toBe(true)
            if (Exit.isFailure(rival.exit)) {
              expect((Cause.squash(rival.exit.cause) as any)._tag).toBe("ValidationError")
            }
            expect((yield* row(rival.id))?.["rivals#a"]).toEqual(before?.["rivals#a"])
            expect(Exit.isSuccess(rival.read)).toBe(true)

            // `count` is stored as `renamed`, a top-level attribute's name: below a field, a
            // path's `count` names the property `count`.
            const renamed = yield* send(db, 4, transaction, set(["tally", "count"], 2))
            expect(Exit.isSuccess(renamed.exit)).toBe(true)
            expect((yield* row(renamed.id))?.tally).toEqual({
              M: { count: { S: "2" }, renamed: { N: "1" } },
            })
            expect(Exit.isSuccess(renamed.read)).toBe(true)

            // A copy holds no operand: the entry gets the field's stored value.
            const copied = yield* send(db, 5, transaction, (update) =>
              update.pathSet({
                segments: ["buckets#a"],
                value: undefined,
                isPath: true,
                valueSegments: ["beside"],
              }),
            )
            expect(Exit.isSuccess(copied.exit)).toBe(true)
            const stored = yield* row(copied.id)
            expect(stored?.["buckets#a"]).toEqual(stored?.beside)
            expect(stored?.["buckets#a"]?.M?.n).toEqual({ N: "2" })
            expect(Exit.isSuccess(copied.read)).toBe(true)
          }),
        ),
      )
    }
  }
})
