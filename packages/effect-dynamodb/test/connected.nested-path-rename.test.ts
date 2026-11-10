/**
 * A path below a field, on a model that renames top-level fields, against DynamoDB Local: every
 * case of `helpers/NestedPathRequests.ts`'s `affected` is applied, and the stored row holds the
 * value where `put` stored the property (`meta.count`), with no stray attribute beside it
 * (`meta.renamed`), and reads back. `test/NestedPathRename.test.ts` checks the names each request
 * sends, and compares the unaffected paths' requests with the published 1.39.0's.
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
  affected,
  definitions,
  seed,
  type Variant,
  variants,
} from "./helpers/NestedPathRequests.js"

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

/** The stored names a renamed top-level field goes under: none of them is a property below one. */
const RENAMED = ["renamed", "items", "labels", "label"]

let tables = 0
/** Runs `body` with a client bound to `variant`'s entities on a table of its own, seeded. */
const onTable = <A>(
  variant: Variant,
  body: (context: {
    readonly db: any
    readonly row: Effect.Effect<Row | undefined>
  }) => Effect.Effect<A, unknown, any>,
) => {
  const { Docs, Owners, Main } = definitions(Lib as never, variant)
  const tableName = `nested-paths-${Date.now()}-${tables++}`
  const row = Effect.promise(() =>
    raw.send(
      new GetItemCommand({
        TableName: tableName,
        Key: { pk: { S: "$nested#v1#doc#id_a" }, sk: { S: "$nested#v1#doc" } },
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
        const db: any = yield* Lib.DynamoClient.make({
          entities: { Docs, Owners },
          tables: { Main },
        } as never)
        yield* db.entities.Owners.put({ id: "o", name: "Olive", count: 3 }).asEffect()
        yield* db.entities.Docs.put(seed("a")).asEffect()
        yield* db.entities.Docs.put(seed("b")).asEffect()
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

const at = (row: Row | undefined, path: ReadonlyArray<string>): unknown => {
  let current: any = row
  for (const [i, segment] of path.entries()) {
    current = i === 0 ? current?.[segment] : current?.M?.[segment]
  }
  return current
}

describeConnected(
  "a path below a field on a model that renames top-level fields, on DynamoDB Local",
  () => {
    for (const variant of variants) {
      for (const each of affected) {
        for (const transaction of each.reads || each.aloneOnly ? [false] : [false, true]) {
          it.effect(`${each.name}, ${variant}, ${transaction ? "in a transaction" : "alone"}`, () =>
            onTable(variant, ({ db, row }) =>
              Effect.gen(function* () {
                const exit = yield* Effect.exit(
                  Effect.suspend(() => {
                    const op = each.run(db, Lib as never)
                    if (each.reads) return op.collect()
                    return transaction
                      ? Lib.Transaction.transactWrite([
                          db.entities.Docs.update({ id: "b" }).set({ count: 2 }),
                          op,
                        ])
                      : op.asEffect()
                  }),
                )
                expect(Exit.isFailure(exit) ? String(Cause.squash(exit.cause)) : "ok").toBe("ok")
                if (each.reads) {
                  expect((exit as Exit.Success<ReadonlyArray<unknown>>).value.length).toBe(2)
                  return
                }
                const stored = yield* row
                if (!("stored" in each) && !each.namesOnly) {
                  expect(stored).toBeUndefined()
                  return
                }
                if (!each.namesOnly) {
                  const held: any = at(stored, each.at)
                  expect(held?.SS !== undefined ? { SS: [...held.SS].sort() } : held).toEqual(
                    each.stored,
                  )
                }
                // No stray attribute: a map holds what `put` stored there, and nothing else.
                expect(
                  Object.keys(stored!.meta!.M!).filter((key) => RENAMED.includes(key)),
                ).toEqual([])
                expect(Object.keys(stored!.owner!.M!).sort()).toEqual(["count", "id", "name"])
                const read = yield* Effect.exit(db.entities.Docs.get({ id: "a" }))
                expect(Exit.isSuccess(read)).toBe(true)
              }),
            ),
          )
        }
      }
    }
  },
)
