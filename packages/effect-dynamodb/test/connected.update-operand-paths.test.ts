/**
 * An update with an operand, against DynamoDB Local: every case of
 * `helpers/UpdateOperandRequests.ts` is applied, and ends as the published 1.39.0 ended it
 * (`fixtures/update-operand-requests-1.39.0.json`, whose requests
 * `test/UpdateOperandRequests.test.ts` compares). An operand 1.39.0 wrote is written and the row
 * reads back; an operand it refused is refused with the same error and the stored row is the row
 * that was there. Where 1.39.0 wrote a row that didn't read, at a position the read schema resolves
 * exactly (#236, `RESOLVED`), the operand is refused and the row is as it was, or stored in the
 * form its reader reads back, and the row reads.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 */

import { readFileSync } from "node:fs"
import { type AttributeValue, DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb"
import { it } from "@effect/vitest"
import { Config, Effect, Exit, Layer } from "effect"
import { describe, expect } from "vitest"
import * as Lib from "../src/index.js"
import { failureOf, type Outcome, refusedOperand } from "./helpers/Against139.js"
import {
  definitions,
  matrix,
  nameOf,
  RESOLVED,
  seed,
  type Variant,
  variants,
  type World,
} from "./helpers/UpdateOperandRequests.js"

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/update-operand-requests-1.39.0.json", import.meta.url), "utf8"),
) as { readonly cases: Record<string, Outcome> }

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
  row: (id: string) => Effect.Effect<Row | undefined>,
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
    const before = yield* row(a)
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
    return { exit, read, before, after: yield* row(a) }
  })

describeConnected("an update with an operand, on DynamoDB Local", () => {
  for (const variant of variants) {
    for (const transaction of [false, true]) {
      const where = `${variant}, ${transaction ? "in a transaction" : "alone"}`
      for (const world of ["main", "stored", "named"] as const) {
        const cases = matrix.filter(
          (each) =>
            each.variant === variant && each.transaction === transaction && each.world === world,
        )
        if (cases.length === 0) continue
        it.effect(`every case ends as 1.39.0 ended it (${where}, the ${world} model)`, () =>
          onTable(variant, world, ({ db, row }) =>
            Effect.gen(function* () {
              let refused = 0
              for (const [n, each] of cases.entries()) {
                // It names another property than 1.39.0 did, so the row reads differently.
                if (each.key.includes("a property named as a renamed field")) continue
                const was = fixture.cases[each.key]!
                const got = yield* send(db, row, n, transaction, each.apply, each.seeded, world)
                const since = RESOLVED.get(nameOf(each.key))?.[0]
                const failure = failureOf(got.exit)
                // A value written into a sparse map's entry is checked against the map's value
                // schema (#238), but for a `pathIfNotExists` operand, refused where stored below.
                const entryChecked =
                  /(^|: )entry: /.test(each.key) &&
                  since !== "refused where stored" &&
                  since !== "kept where present"
                if (entryChecked) {
                  // Where 1.39.0 wrote one that left a row no read takes, it's refused with
                  // nothing written, and the row reads as it was.
                  if (
                    failure !== undefined &&
                    refusedOperand({ ok: false, reads: true, requests: [], failure })
                  ) {
                    expect(`${each.key}: ${was.ok && was.reads}`).toBe(`${each.key}: false`)
                    expect(got.after).toEqual(got.before)
                    expect(`${each.key}: ${Exit.isSuccess(got.read)}`).toBe(`${each.key}: true`)
                    continue
                  }
                  // Written encoded, where 1.39.0's row didn't read: it reads now.
                  if (!was.reads && Exit.isSuccess(got.exit) && Exit.isSuccess(got.read)) continue
                } else if (since !== undefined) {
                  // A `pathIfNotExists` operand is refused where the row lacks its path, which
                  // the case's row does: with the error 1.39.0 refused it with.
                  const refusing =
                    since === "refuses what wouldn't read" || since === "refused where stored"
                  expect(`${each.key}: ${Exit.isSuccess(got.exit)}`).toBe(
                    `${each.key}: ${!refusing}`,
                  )
                  expect(`${each.key}: ${Exit.isSuccess(got.read)}`).toBe(`${each.key}: true`)
                  if (refusing) {
                    expect(failure).toMatchObject({ error: "ValidationError" })
                    if (since === "refused where stored" && refusedOperand(was)) {
                      expect(failure).toEqual(was.failure)
                    }
                    expect(got.after).toEqual(got.before)
                  }
                  continue
                }
                expect(`${each.key}: ${Exit.isSuccess(got.exit)}`).toBe(`${each.key}: ${was.ok}`)
                expect(`${each.key}: ${Exit.isSuccess(got.read)}`).toBe(`${each.key}: ${was.reads}`)
                if (refusedOperand(was)) {
                  refused++
                  expect(failureOf(got.exit)).toEqual(was.failure)
                  // Nothing was written: the row is the row that was there.
                  expect(got.after).toEqual(got.before)
                }
              }
              if (world === "main") expect(refused).toBeGreaterThan(0)
            }),
          ),
        )
      }
    }
  }
})
